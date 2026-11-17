//! What an app may send a holder after `hello.ack` (protocol section 15),
//! checked strictly: an unknown type closes the connection (`unknown-type`),
//! an unknown, missing or repeated field is `bad-field`, a size rule broken is
//! `too-large`. Nothing here runs anything; `serve.rs` acts on what passes.
//!
//! A `term.launch` may also carry `line` and `conpty` (the launch fields for
//! Windows), on Windows only: on macOS and Linux either is `bad-field`.

use crate::json::Value;
use crate::pty::{is_batch_file, Conpty, PtySize};

pub const MAX_ARGV_ITEMS: usize = 256;
pub const MAX_ARG_CHARS: usize = 8192;
pub const MAX_CWD_CHARS: usize = 4096;
pub const MAX_ENV_ENTRIES: usize = 1024;
pub const MAX_ENV_NAME_CHARS: usize = 255;
pub const MAX_ENV_VALUE_CHARS: usize = 32767;
/// The longest exact command line (`line`), in UTF-16 units, as Windows
/// counts it: `CreateProcessW` takes at most 32767 with the NUL that ends
/// the line, so 32766 without it. A character outside the Basic Multilingual
/// Plane is two units.
pub const MAX_LINE_UNITS: usize = 32766;
pub const MAX_TERM_CELLS: u64 = 1000;
/// The largest integer a JavaScript number holds exactly: request ids and offsets.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub const CODE_UNKNOWN_TYPE: &str = "unknown-type";
pub const CODE_BAD_FIELD: &str = "bad-field";
pub const CODE_TOO_LARGE: &str = "too-large";
pub const CODE_BUSY: &str = "busy";
pub const CODE_NOT_FOUND: &str = "not-found";
pub const CODE_NOT_CONNECTED: &str = "not-connected";
pub const CODE_REPLACED: &str = "replaced";
pub const CODE_TIMEOUT: &str = "timeout";

/// Why a message was refused, as the `error` the holder answers with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub re: Option<u64>,
    pub text: String,
}

fn refuse<T>(code: &'static str, re: Option<u64>, text: &str) -> Result<T, Refusal> {
    Err(Refusal { code, re, text: text.to_string() })
}

/// A launch, checked: `env` is the child's whole environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub id: u64,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub size: PtySize,
    /// Windows only: the exact command line `argv[0]` is given.
    pub line: Option<String>,
    /// Windows only: which ConPTY the terminal runs on.
    pub conpty: Conpty,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Ping { id: u64 },
    /// An `error` from the app: nothing to answer.
    Error,
    Launch(Launch),
    Attach { id: u64, from: u64 },
    Resize { id: u64, size: PtySize },
    Detach { id: u64 },
    End { id: u64 },
}

/// The fields of one type: those it must have, and those it may also have.
type Fields = (&'static [&'static str], &'static [&'static str]);

/// The types an app may send once `local` is acked, and their fields.
const LOCAL_TYPES: [(&str, Fields); 5] = [
    ("term.launch", (&["t", "id", "argv", "cwd", "env", "cols", "rows"], &["line", "conpty"])),
    ("term.attach", (&["t", "id", "from"], &[])),
    ("term.resize", (&["t", "id", "cols", "rows"], &[])),
    ("term.detach", (&["t", "id"], &[])),
    ("term.end", (&["t", "id"], &[])),
];

/// The types of the frozen core an app may send after the ack.
const CORE_TYPES: [(&str, Fields); 1] = [("ping", (&["t", "id"], &[]))];

/// A request id: an even integer (app ids are even, section 9) a JavaScript
/// number holds exactly.
fn request_id(v: &Value) -> Option<u64> {
    let id = v.get("id")?.as_u64()?;
    if id % 2 == 0 && id <= MAX_SAFE_INTEGER {
        Some(id)
    } else {
        None
    }
}

/// True when the object holds every key of `required`, nothing but those
/// and `optional`, and each key once.
fn keys_fit(v: &Value, required: &[&str], optional: &[&str]) -> bool {
    let keys = match v.keys() {
        Some(k) => k,
        None => return false,
    };
    let mut seen: Vec<&str> = Vec::new();
    for k in keys {
        if !(required.contains(&k) || optional.contains(&k)) || seen.contains(&k) {
            return false;
        }
        seen.push(k);
    }
    required.iter().all(|k| seen.contains(k))
}

/// True when the object's keys are exactly `allowed`, each once.
fn exact_keys(v: &Value, allowed: &[&str]) -> bool {
    keys_fit(v, allowed, &[])
}

fn is_absolute(path: &str) -> bool {
    std::path::Path::new(path).is_absolute()
}

fn cells(v: Option<&Value>) -> Option<u16> {
    let n = v?.as_u64()?;
    if (1..=MAX_TERM_CELLS).contains(&n) {
        Some(n as u16)
    } else {
        None
    }
}

fn size(v: &Value, re: Option<u64>) -> Result<PtySize, Refusal> {
    let cols = match cells(v.get("cols")) {
        Some(c) => c,
        None => return refuse(CODE_BAD_FIELD, re, "cols must be a whole number from 1 to 1000"),
    };
    let rows = match cells(v.get("rows")) {
        Some(r) => r,
        None => return refuse(CODE_BAD_FIELD, re, "rows must be a whole number from 1 to 1000"),
    };
    Ok(PtySize { cols, rows })
}

/// Check a `term.launch` (its keys already checked).
pub fn parse_launch(v: &Value, id: u64) -> Result<Launch, Refusal> {
    let re = Some(id);
    let items = match v.get("argv").and_then(Value::as_array) {
        Some(items) => items,
        None => return refuse(CODE_BAD_FIELD, re, "argv must be an array of strings"),
    };
    if items.is_empty() {
        return refuse(CODE_BAD_FIELD, re, "argv is empty");
    }
    if items.len() > MAX_ARGV_ITEMS {
        return refuse(CODE_TOO_LARGE, re, "argv has more than 256 items");
    }
    let mut argv = Vec::with_capacity(items.len());
    for item in items {
        let s = match item.as_str() {
            Some(s) => s,
            None => return refuse(CODE_BAD_FIELD, re, "argv must be an array of strings"),
        };
        if s.chars().count() > MAX_ARG_CHARS {
            return refuse(CODE_TOO_LARGE, re, "an argument is over 8192 characters");
        }
        if s.contains('\0') {
            return refuse(CODE_BAD_FIELD, re, "an argument holds a NUL character");
        }
        argv.push(s.to_string());
    }
    if !is_absolute(&argv[0]) {
        return refuse(CODE_BAD_FIELD, re, "argv[0] must be an absolute path");
    }

    let cwd = match v.get("cwd").and_then(Value::as_str) {
        Some(s) => s,
        None => return refuse(CODE_BAD_FIELD, re, "cwd must be a string"),
    };
    if cwd.chars().count() > MAX_CWD_CHARS {
        return refuse(CODE_TOO_LARGE, re, "cwd is over 4096 characters");
    }
    if cwd.contains('\0') || !is_absolute(cwd) {
        return refuse(CODE_BAD_FIELD, re, "cwd must be an absolute path with no NUL character");
    }

    let members = match v.get("env") {
        Some(Value::Obj(members)) => members,
        _ => return refuse(CODE_BAD_FIELD, re, "env must be an object of strings"),
    };
    if members.len() > MAX_ENV_ENTRIES {
        return refuse(CODE_TOO_LARGE, re, "env has more than 1024 entries");
    }
    let mut env: Vec<(String, String)> = Vec::with_capacity(members.len());
    let mut folded: Vec<String> = Vec::with_capacity(members.len());
    for (name, value) in members {
        if name.is_empty() {
            return refuse(CODE_BAD_FIELD, re, "an environment name is empty");
        }
        if name.chars().count() > MAX_ENV_NAME_CHARS {
            return refuse(CODE_TOO_LARGE, re, "an environment name is over 255 characters");
        }
        if name.contains('=') || name.contains('\0') {
            return refuse(CODE_BAD_FIELD, re, "an environment name holds = or NUL");
        }
        let value = match value.as_str() {
            Some(s) => s,
            None => return refuse(CODE_BAD_FIELD, re, "an environment value is not a string"),
        };
        if value.chars().count() > MAX_ENV_VALUE_CHARS {
            return refuse(CODE_TOO_LARGE, re, "an environment value is over 32767 characters");
        }
        if value.contains('\0') {
            return refuse(CODE_BAD_FIELD, re, "an environment value holds a NUL character");
        }
        // Names differing only in case are one variable on Windows, so they
        // are refused on every OS: a launch means the same thing everywhere.
        let key = name.to_uppercase();
        if folded.contains(&key) {
            return refuse(CODE_BAD_FIELD, re, "an environment name is given twice (case ignored)");
        }
        folded.push(key);
        env.push((name.clone(), value.to_string()));
    }

    let size = size(v, re)?;
    let line = match v.get("line") {
        Some(value) => Some(parse_line(value, &argv, re)?),
        None => None,
    };
    let conpty = match v.get("conpty") {
        Some(value) => parse_conpty(value, re)?,
        None => Conpty::System,
    };
    Ok(Launch { id, argv, cwd: cwd.to_string(), env, size, line, conpty })
}

/// `line`: the exact command line the program reads (`CreateProcessW`'s
/// `lpCommandLine`), for a program that reads its line in a way no argument
/// list can say (cmd.exe running a .cmd file). `CreateProcessW` starts the
/// program at `argv[0]` by that exact path, so `argv` then holds it alone.
/// A command interpreter runs what its line says, so the line gives nothing
/// `argv` could not; a batch file is refused, since Windows would start
/// cmd.exe for it and cmd.exe would read the line as commands.
fn parse_line(v: &Value, argv: &[String], re: Option<u64>) -> Result<String, Refusal> {
    let line = match v.as_str() {
        Some(s) => s,
        None => return refuse(CODE_BAD_FIELD, re, "line must be a string"),
    };
    if cfg!(not(windows)) {
        return refuse(CODE_BAD_FIELD, re, "line is for Windows only");
    }
    if line.encode_utf16().count() > MAX_LINE_UNITS {
        return refuse(CODE_TOO_LARGE, re, "line is over 32766 UTF-16 units");
    }
    if line.contains('\0') {
        return refuse(CODE_BAD_FIELD, re, "line holds a NUL character");
    }
    if line.is_empty() {
        return refuse(CODE_BAD_FIELD, re, "line is empty");
    }
    if argv.len() != 1 {
        return refuse(CODE_BAD_FIELD, re, "with line, argv holds the program alone");
    }
    if is_batch_file(&argv[0]) {
        return refuse(CODE_BAD_FIELD, re, "line is never given to a batch file, which Windows runs through cmd.exe");
    }
    Ok(line.to_string())
}

/// `conpty`: "bundled", or absent for the system ConPTY.
fn parse_conpty(v: &Value, re: Option<u64>) -> Result<Conpty, Refusal> {
    if v.as_str() != Some("bundled") {
        return refuse(CODE_BAD_FIELD, re, "conpty must be bundled, or left out");
    }
    if cfg!(not(windows)) {
        return refuse(CODE_BAD_FIELD, re, "the bundled ConPTY is for Windows only");
    }
    Ok(Conpty::Bundled)
}

/// Check one control message. `local` is true when the app acked `local`.
pub fn parse(v: &Value, local: bool) -> Result<Request, Refusal> {
    if v.keys().is_none() {
        return refuse(CODE_BAD_FIELD, None, "a control message must be a JSON object");
    }
    let t = match v.get("t").and_then(Value::as_str) {
        Some(t) => t,
        None => return refuse(CODE_BAD_FIELD, None, "t is missing or not a string"),
    };
    if t == "error" {
        return parse_error(v);
    }
    let mut fields: Option<Fields> = CORE_TYPES.iter().find(|(name, _)| *name == t).map(|(_, f)| *f);
    if fields.is_none() && local {
        fields = LOCAL_TYPES.iter().find(|(name, _)| *name == t).map(|(_, f)| *f);
    }
    let (required, optional) = match fields {
        Some(f) => f,
        None => return refuse(CODE_UNKNOWN_TYPE, None, "a type this connection does not allow"),
    };
    let id = match request_id(v) {
        Some(id) => id,
        None => return refuse(CODE_BAD_FIELD, None, "id must be an even whole number up to 2^53 - 1"),
    };
    let re = Some(id);
    if !keys_fit(v, required, optional) {
        return refuse(CODE_BAD_FIELD, re, "a field is unknown, missing or given twice");
    }
    match t {
        "ping" => Ok(Request::Ping { id }),
        "term.launch" => parse_launch(v, id).map(Request::Launch),
        "term.attach" => match v.get("from").and_then(Value::as_u64) {
            Some(from) if from <= MAX_SAFE_INTEGER => Ok(Request::Attach { id, from }),
            _ => refuse(CODE_BAD_FIELD, re, "from must be a whole number up to 2^53 - 1"),
        },
        "term.resize" => Ok(Request::Resize { id, size: size(v, re)? }),
        "term.detach" => Ok(Request::Detach { id }),
        "term.end" => Ok(Request::End { id }),
        _ => refuse(CODE_UNKNOWN_TYPE, None, "a type this connection does not allow"),
    }
}

/// An `error` from the app: `{t, re?, code, text}`, read only to be dropped.
fn parse_error(v: &Value) -> Result<Request, Refusal> {
    let with_re = v.get("re").is_some();
    let fields: &[&str] = if with_re { &["t", "re", "code", "text"] } else { &["t", "code", "text"] };
    let ok = exact_keys(v, fields)
        && v.get("code").and_then(Value::as_str).map_or(false, |c| !c.is_empty() && c.len() <= 32)
        && v.get("text").and_then(Value::as_str).map_or(false, |t| t.chars().count() <= crate::hello::MAX_ERROR_TEXT_CHARS)
        && (!with_re || v.get("re").and_then(Value::as_u64).is_some());
    if ok {
        Ok(Request::Error)
    } else {
        refuse(CODE_BAD_FIELD, None, "an error message breaks its schema")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    fn parsed(text: &str) -> Result<Request, Refusal> {
        parse(&json::parse(text.as_bytes()).unwrap(), true)
    }

    fn code(text: &str) -> &'static str {
        parsed(text).unwrap_err().code
    }

    #[cfg(unix)]
    const PROGRAM: &str = "/usr/bin/env";
    #[cfg(windows)]
    const PROGRAM: &str = "C:\\\\Windows\\\\System32\\\\cmd.exe";
    #[cfg(unix)]
    const FOLDER: &str = "/tmp";
    #[cfg(windows)]
    const FOLDER: &str = "C:\\\\Windows";

    fn launch(argv: &str, env: &str) -> String {
        format!("{{\"t\":\"term.launch\",\"id\":2,\"argv\":{argv},\"cwd\":\"{FOLDER}\",\"env\":{env},\"cols\":80,\"rows\":24}}")
    }

    #[test]
    fn a_good_launch_reads_with_its_whole_environment() {
        let text = launch(&format!("[\"{PROGRAM}\",\"-x\"]"), "{\"A\":\"1\",\"PATH\":\"/bin\"}");
        match parsed(&text).unwrap() {
            Request::Launch(l) => {
                assert_eq!(l.id, 2);
                assert_eq!(l.argv.len(), 2);
                assert_eq!(l.env, vec![("A".to_string(), "1".to_string()), ("PATH".to_string(), "/bin".to_string())]);
                assert_eq!(l.size, PtySize { cols: 80, rows: 24 });
                // Without the Windows fields: its argument list, on the system ConPTY.
                assert_eq!((l.line, l.conpty), (None, Conpty::System));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn launches_that_break_a_rule_are_refused_with_the_right_code() {
        let p = format!("[\"{PROGRAM}\"]");
        assert_eq!(code(&launch("[\"relative\"]", "{}")), CODE_BAD_FIELD);
        assert_eq!(code(&launch("[]", "{}")), CODE_BAD_FIELD);
        assert_eq!(code(&launch("[1]", "{}")), CODE_BAD_FIELD);
        let many = format!("[\"{PROGRAM}\"{}]", ",\"a\"".repeat(256));
        assert_eq!(code(&launch(&many, "{}")), CODE_TOO_LARGE);
        let long = format!("[\"{PROGRAM}\",\"{}\"]", "a".repeat(8193));
        assert_eq!(code(&launch(&long, "{}")), CODE_TOO_LARGE);
        assert_eq!(code(&launch(&format!("[\"{PROGRAM}\",\"a\\u0000b\"]"), "{}")), CODE_BAD_FIELD);
        assert_eq!(code(&launch(&p, "{\"A=B\":\"x\"}")), CODE_BAD_FIELD);
        assert_eq!(code(&launch(&p, "{\"\":\"x\"}")), CODE_BAD_FIELD);
        assert_eq!(code(&launch(&p, "{\"A\":1}")), CODE_BAD_FIELD);
        assert_eq!(code(&launch(&p, "{\"Path\":\"a\",\"PATH\":\"b\"}")), CODE_BAD_FIELD);
        assert_eq!(code(&launch(&p, "{\"A\":\"a\",\"A\":\"b\"}")), CODE_BAD_FIELD, "a repeated JSON key");
        assert_eq!(code(&launch(&p, "[]")), CODE_BAD_FIELD);
        let text = launch(&p, "{}").replace("\"cols\":80", "\"cols\":0");
        assert_eq!(code(&text), CODE_BAD_FIELD);
        let text = launch(&p, "{}").replace("\"rows\":24", "\"rows\":1001");
        assert_eq!(code(&text), CODE_BAD_FIELD);
        let text = launch(&p, "{}").replace(&format!("\"cwd\":\"{FOLDER}\""), "\"cwd\":\"relative\"");
        assert_eq!(code(&text), CODE_BAD_FIELD);
        let text = launch(&p, "{}").replace("\"rows\":24", "\"rows\":24,\"extra\":1");
        assert_eq!(code(&text), CODE_BAD_FIELD);
    }

    /// A launch with `more` (one or more `"key":value` members) after `rows`.
    fn launch_with(argv: &str, more: &str) -> String {
        launch(argv, "{}").replace("\"rows\":24", &format!("\"rows\":24,{more}"))
    }

    #[test]
    fn an_exact_command_line_and_the_bundled_conpty_are_for_windows_only() {
        let p = format!("[\"{PROGRAM}\"]");
        let line = launch_with(&p, &format!("\"line\":\"{PROGRAM} /d /s /c echo hi\""));
        let bundled = launch_with(&p, "\"conpty\":\"bundled\"");
        let both = launch_with(&p, &format!("\"conpty\":\"bundled\",\"line\":\"{PROGRAM} /c ver\""));
        if cfg!(windows) {
            for text in [&line, &bundled, &both] {
                assert!(parsed(text).is_ok(), "refused on Windows: {text} ({:?})", parsed(text));
            }
            let fields = |text: &str| match parsed(text).unwrap() {
                Request::Launch(l) => (l.line, l.conpty, l.argv.len()),
                other => panic!("{other:?}"),
            };
            // PROGRAM is JSON text here; read, it has single backslashes.
            let program = PROGRAM.replace("\\\\", "\\");
            assert_eq!(fields(&line), (Some(format!("{program} /d /s /c echo hi")), Conpty::System, 1));
            assert_eq!(fields(&bundled), (None, Conpty::Bundled, 1));
            assert_eq!(fields(&both), (Some(format!("{program} /c ver")), Conpty::Bundled, 1));
        } else {
            for text in [&line, &bundled, &both] {
                assert_eq!(code(text), CODE_BAD_FIELD, "{text}");
            }
        }
        // Not the bundled one, or not a string: refused on every OS.
        for other in ["\"system\"", "\"BUNDLED\"", "\"\"", "true", "null", "1"] {
            assert_eq!(code(&launch_with(&p, &format!("\"conpty\":{other}"))), CODE_BAD_FIELD, "conpty {other}");
        }
        for other in ["1", "null", "true", "[\"a\"]", "{}"] {
            assert_eq!(code(&launch_with(&p, &format!("\"line\":{other}"))), CODE_BAD_FIELD, "line {other}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn an_exact_command_line_is_held_to_its_limits() {
        let p = format!("[\"{PROGRAM}\"]");
        let with_line = |line: &str| launch_with(&p, &format!("\"line\":\"{line}\""));
        // The longest CreateProcessW takes, and one past it: 32767 UTF-16
        // units with the NUL that ends the line, so 32766 without. Counted in
        // UTF-16 units, as Windows counts them, not in characters: a
        // character outside the Basic Multilingual Plane is two.
        assert!(parsed(&with_line(&"a".repeat(32766))).is_ok(), "32766 units refused");
        assert!(parsed(&with_line(&"\u{e9}".repeat(32766))).is_ok(), "32766 two-byte characters, one unit each, refused");
        assert!(parsed(&with_line(&"\u{1f600}".repeat(16383))).is_ok(), "16383 characters of two units each refused");
        assert_eq!(code(&with_line(&"a".repeat(32767))), CODE_TOO_LARGE, "32767 units, which CreateProcessW refuses");
        assert_eq!(code(&with_line(&format!("{}a", "\u{1f600}".repeat(16383)))), CODE_TOO_LARGE, "32767 units in 16384 characters");
        assert_eq!(code(&with_line(&"\u{1f600}".repeat(16384))), CODE_TOO_LARGE, "32768 units in 16384 characters");
        assert_eq!(code(&with_line("a\\u0000b")), CODE_BAD_FIELD);
        assert_eq!(code(&with_line("")), CODE_BAD_FIELD);
        // With a line, argv holds the program alone: nothing says which wins.
        let two = format!("[\"{PROGRAM}\",\"/c\"]");
        assert_eq!(code(&launch_with(&two, "\"line\":\"cmd /c ver\"")), CODE_BAD_FIELD);
        // Never a batch file: Windows starts one through cmd.exe, which would
        // read the line as commands. Any case, trailing dots and spaces dropped.
        for batch in ["C:\\\\x\\\\tool.cmd", "C:\\\\x\\\\tool.BAT", "C:\\\\x\\\\tool.cmd. ", "C:\\\\x\\\\tool.Cmd.."] {
            assert_eq!(code(&launch_with(&format!("[\"{batch}\"]"), "\"line\":\"tool resume\"")), CODE_BAD_FIELD, "{batch}");
            // With an argument list, as before.
            assert!(parsed(&launch(&format!("[\"{batch}\",\"resume\"]"), "{}")).is_ok(), "{batch} with an argument list");
        }
        // The name checked is the name Windows opens. Windows resolves a part
        // of dots alone (`.`, `..`, and with trailing spaces) and reads `/` as
        // `\` before it opens the file, so tool.cmd\. and tool.cmd\sub\.. are
        // tool.cmd: with a line, such a name is refused, and so is one that
        // ends in a separator. A `\\.\` device path has a `.` part too.
        for renamed in [
            "C:\\\\x\\\\tool.cmd\\\\.",
            "C:\\\\x\\\\tool.cmd\\\\sub\\\\..",
            "C:/x/tool.cmd/sub/..",
            "C:\\\\x\\\\tool.cmd\\\\. ",
            "C:\\\\x\\\\tool.cmd\\\\.. \\\\.",
            "C:\\\\x\\\\tool.cmd\\\\",
            "C:\\\\x\\\\tool.cmd/",
            "C:\\\\x\\\\sub\\\\..\\\\tool.exe",
            "\\\\\\\\.\\\\C:\\\\x\\\\tool.exe",
        ] {
            assert_eq!(code(&launch_with(&format!("[\"{renamed}\"]"), "\"line\":\"tool resume\"")), CODE_BAD_FIELD, "{renamed}");
            assert!(parsed(&launch(&format!("[\"{renamed}\",\"resume\"]"), "{}")).is_ok(), "{renamed} with an argument list");
        }
        // A part that only starts or ends with a dot is a plain name.
        for plain in ["C:\\\\x\\\\.tools\\\\tool.exe", "C:\\\\x\\\\...tool.exe", "\\\\\\\\?\\\\C:\\\\x\\\\tool.exe", "\\\\\\\\server\\\\share\\\\tool.exe"] {
            assert!(parsed(&launch_with(&format!("[\"{plain}\"]"), "\"line\":\"tool resume\"")).is_ok(), "{plain} refused");
        }
        // Each field once.
        assert_eq!(code(&launch_with(&p, "\"conpty\":\"bundled\",\"conpty\":\"bundled\"")), CODE_BAD_FIELD);
        assert_eq!(code(&launch_with(&p, "\"line\":\"a\",\"line\":\"a\"")), CODE_BAD_FIELD);
    }

    #[test]
    fn types_ids_and_fields_are_strict() {
        assert_eq!(parsed("{\"t\":\"ping\",\"id\":4}").unwrap(), Request::Ping { id: 4 });
        assert_eq!(code("{\"t\":\"ping\",\"id\":3}"), CODE_BAD_FIELD, "an odd id is the helper's");
        assert_eq!(code("{\"t\":\"ping\",\"id\":9007199254740994}"), CODE_BAD_FIELD);
        assert_eq!(code("{\"t\":\"ping\",\"id\":2,\"x\":1}"), CODE_BAD_FIELD);
        assert_eq!(code("{\"t\":\"ping\",\"id\":2,\"id\":2}"), CODE_BAD_FIELD);
        assert_eq!(code("{\"t\":\"session.start\",\"id\":2}"), CODE_UNKNOWN_TYPE);
        assert_eq!(code("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[]}"), CODE_UNKNOWN_TYPE, "a second ack");
        assert_eq!(code("[1]"), CODE_BAD_FIELD);
        assert_eq!(parsed("{\"t\":\"term.attach\",\"id\":6,\"from\":10}").unwrap(), Request::Attach { id: 6, from: 10 });
        assert_eq!(code("{\"t\":\"term.attach\",\"id\":6,\"from\":-1}"), CODE_BAD_FIELD);
        assert_eq!(parsed("{\"t\":\"term.resize\",\"id\":8,\"cols\":100,\"rows\":30}").unwrap(), Request::Resize { id: 8, size: PtySize { cols: 100, rows: 30 } });
        assert_eq!(parsed("{\"t\":\"term.end\",\"id\":10}").unwrap(), Request::End { id: 10 });
        assert_eq!(parsed("{\"t\":\"error\",\"code\":\"io\",\"text\":\"x\"}").unwrap(), Request::Error);
        assert_eq!(code("{\"t\":\"error\",\"code\":\"io\"}"), CODE_BAD_FIELD);
        // Without `local` acked, the terminal messages are not allowed at all.
        let v = json::parse(b"{\"t\":\"term.end\",\"id\":10}").unwrap();
        assert_eq!(parse(&v, false).unwrap_err().code, CODE_UNKNOWN_TYPE);
    }
}
