//! What an app may send a holder after `hello.ack` (protocol section 15),
//! checked strictly: an unknown type closes the connection (`unknown-type`),
//! an unknown, missing or repeated field is `bad-field`, a size rule broken is
//! `too-large`. Nothing here runs anything; `serve.rs` acts on what passes.
//!
//! A `term.launch` may also carry `line` and `conpty` (the launch fields for
//! Windows), on Windows only: on macOS and Linux either is `bad-field`.
//!
//! `hook.event` is allowed only once `hooks` is acked: one hook event of the
//! session, of one of the nine kinds the app injects, its payload a JSON
//! object of at most 65,280 bytes that names none of its members twice and
//! whose `hook_event_name` is that kind. The holder only numbers it and
//! passes it on.
//!
//! `mcp.open`, `mcp` and `mcp.close` are allowed only once `mcp` is acked
//! (from 2.1.3-beta.10): a tool stream's messages, between a relay
//! (`aicc-helper mcp`) and the app. They carry no `id` and get no reply:
//! exactly their fields, `stream` a whole number from 1 to 2^53 - 1, and an
//! `mcp`'s `message` a JSON object or array of at most `MAX_MCP_TO_HELPER`
//! bytes as compact JSON. Who may send which, and the smaller limit toward
//! the app, are `serve.rs`'s rules: they depend on the connection.
//!
//! `screen.read` and `screen.tail` are allowed only once `screen` is acked
//! (from 2.1.3-beta.12): two read-only requests about the session's screen,
//! `screen.tail` with a `count` of 1 to 200 lines. Whether the connection may
//! ask (a relay may not) is `serve.rs`'s rule.

use crate::json::Value;
use crate::pty::{is_batch_file, is_renamed_by_windows, Conpty, PtySize};

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
/// The hook events a holder takes: the nine the app injects into a Claude
/// Code session (src/main/hooks/session-hooks-writer.ts, MVP_EVENTS).
pub const HOOK_KINDS: [&str; 9] = ["PreToolUse", "PostToolUse", "Notification", "SessionStart", "Stop", "UserPromptSubmit", "SubagentStart", "SubagentStop", "StopFailure"];
/// The most a hook event's payload may be, as compact JSON: 64 KiB less 256
/// bytes, the room the `event` around it needs (at most 105 bytes, with the
/// longest kind, `seq` and `lost`). So every `event` a holder sends fits the
/// 64 KiB a frame holds once launched, and a `hook.event` over the limit is
/// `too-large`, not a frame over it, after a launch as before.
pub const MAX_HOOK_PAYLOAD: usize = 65_280;
/// The most a tool message's `message` may be on its way to the app, as
/// compact JSON: 1 MiB less 256 bytes, the room the `mcp` around it needs
/// (at most 48 bytes, with the longest `stream`). So every `mcp` the holder
/// passes on fits the 1 MiB a frame to the app holds.
pub const MAX_MCP_TO_APP: usize = 1_048_320;
/// The most a tool message's `message` may be on its way from the app to a
/// relay, as compact JSON: 16 MiB less 256 bytes (a tool result can carry a
/// screenshot).
pub const MAX_MCP_TO_HELPER: usize = 16_776_960;
/// The most lines a `screen.tail` may ask for: the screen's scrollback.
pub const MAX_TAIL_LINES: u64 = crate::screen::TAIL_MAX as u64;

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

#[derive(Debug, Clone, PartialEq)]
pub enum Request {
    Ping { id: u64 },
    /// An `error` from the app: nothing to answer.
    Error,
    Launch(Launch),
    Attach { id: u64, from: u64 },
    Resize { id: u64, size: PtySize },
    Detach { id: u64 },
    End { id: u64 },
    /// One hook event: its kind, and its payload, a JSON object of `bytes`
    /// as compact JSON (measured once, here).
    HookEvent { id: u64, kind: String, payload: Value, bytes: usize },
    /// A tool stream begins: the sender's number for it.
    McpOpen { stream: u64 },
    /// One JSON-RPC message on a tool stream, a JSON object or array of
    /// `bytes` as compact JSON (measured once, here).
    Mcp { stream: u64, message: Value, bytes: usize },
    /// A tool stream ends.
    McpClose { stream: u64 },
    /// The session's screen now.
    ScreenRead { id: u64 },
    /// The screen's last `count` lines, 1 to `MAX_TAIL_LINES`.
    ScreenTail { id: u64, count: usize },
}

/// What a connection's `hello.ack` allowed beyond the core: `local`, the
/// terminal messages; `hooks`, hook events; `mcp`, tool streams; `screen`,
/// screen reads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Allowed {
    pub local: bool,
    pub hooks: bool,
    pub mcp: bool,
    pub screen: bool,
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

/// The types a connection may send once `hooks` is acked.
const HOOK_TYPES: [(&str, Fields); 1] = [("hook.event", (&["t", "id", "kind", "payload"], &[]))];

/// The types a connection may send once `screen` is acked.
const SCREEN_TYPES: [(&str, Fields); 2] = [("screen.read", (&["t", "id"], &[])), ("screen.tail", (&["t", "id", "count"], &[]))];

/// The tool stream messages a connection may send once `mcp` is acked, and
/// their fields: no `id`, as none gets a reply.
const TOOL_TYPES: [(&str, &[&str]); 3] = [("mcp.open", &["t", "stream"]), ("mcp", &["t", "stream", "message"]), ("mcp.close", &["t", "stream"])];

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
/// cmd.exe for it and cmd.exe would read the line as commands. So that the
/// name checked is the name Windows opens, a name with a part of dots and
/// spaces alone (such as `.` or `..`) or a trailing separator is refused
/// first: Windows resolves those before it opens the file.
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
    if is_renamed_by_windows(&argv[0]) {
        return refuse(CODE_BAD_FIELD, re, "line is never given to a program named with a part of dots alone or a trailing separator, which Windows opens by another name");
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

/// True when an object names one of its own members twice (members further
/// in are not looked at). json.rs keeps both and `get` finds the first;
/// JavaScript's JSON.parse keeps the last; so the helper and the app would
/// read such a value apart.
pub fn repeats_a_name(v: &Value) -> bool {
    match v {
        Value::Obj(members) => {
            let mut seen = std::collections::HashSet::with_capacity(members.len());
            members.iter().any(|(name, _)| !seen.insert(name.as_str()))
        }
        _ => false,
    }
}

/// Check a `hook.event` (its keys already checked): `kind` one of
/// `HOOK_KINDS`, `payload` an object of at most `MAX_HOOK_PAYLOAD` bytes as
/// compact JSON, naming none of its members twice, whose `hook_event_name`
/// is `kind`.
fn parse_hook_event(v: &Value, id: u64) -> Result<Request, Refusal> {
    let re = Some(id);
    let kind = match v.get("kind").and_then(Value::as_str) {
        Some(k) if HOOK_KINDS.contains(&k) => k.to_string(),
        _ => return refuse(CODE_BAD_FIELD, re, "kind must be one of the nine hook events the app injects"),
    };
    let payload = match v.get("payload") {
        Some(p) if matches!(p, Value::Obj(_)) => p,
        _ => return refuse(CODE_BAD_FIELD, re, "payload must be a JSON object"),
    };
    let bytes = payload.to_json().len();
    if bytes > MAX_HOOK_PAYLOAD {
        return refuse(CODE_TOO_LARGE, re, "payload is over 65280 bytes as JSON");
    }
    if repeats_a_name(payload) {
        return refuse(CODE_BAD_FIELD, re, "payload names a member twice");
    }
    if payload.get("hook_event_name").and_then(Value::as_str) != Some(kind.as_str()) {
        return refuse(CODE_BAD_FIELD, re, "payload.hook_event_name must be the event's kind");
    }
    Ok(Request::HookEvent { id, kind, payload: payload.clone(), bytes })
}

/// Check a tool stream message of type `t`: exactly `fields`, `stream` a
/// whole number from 1 to 2^53 - 1, and for `mcp` a `message` that is a JSON
/// object or array of at most `MAX_MCP_TO_HELPER` bytes as compact JSON. Its
/// refusals carry no `re`: the message has no `id`.
fn parse_tool(v: &Value, t: &str, fields: &[&str]) -> Result<Request, Refusal> {
    if !exact_keys(v, fields) {
        return refuse(CODE_BAD_FIELD, None, "a field is unknown, missing or given twice");
    }
    let stream = match v.get("stream").and_then(Value::as_u64) {
        Some(s) if (1..=MAX_SAFE_INTEGER).contains(&s) => s,
        _ => return refuse(CODE_BAD_FIELD, None, "stream must be a whole number from 1 to 2^53 - 1"),
    };
    match t {
        "mcp.open" => Ok(Request::McpOpen { stream }),
        "mcp.close" => Ok(Request::McpClose { stream }),
        _ => {
            let message = match v.get("message") {
                Some(m) if matches!(m, Value::Obj(_) | Value::Arr(_)) => m,
                _ => return refuse(CODE_BAD_FIELD, None, "message must be a JSON object or array"),
            };
            let bytes = message.to_json().len();
            if bytes > MAX_MCP_TO_HELPER {
                return refuse(CODE_TOO_LARGE, None, "message is over 16776960 bytes as JSON");
            }
            Ok(Request::Mcp { stream, message: message.clone(), bytes })
        }
    }
}

/// Check one control message, allowed what the connection's ack allowed.
pub fn parse_allowed(v: &Value, allowed: Allowed) -> Result<Request, Refusal> {
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
    if fields.is_none() && allowed.local {
        fields = LOCAL_TYPES.iter().find(|(name, _)| *name == t).map(|(_, f)| *f);
    }
    if fields.is_none() && allowed.hooks {
        fields = HOOK_TYPES.iter().find(|(name, _)| *name == t).map(|(_, f)| *f);
    }
    if fields.is_none() && allowed.screen {
        fields = SCREEN_TYPES.iter().find(|(name, _)| *name == t).map(|(_, f)| *f);
    }
    if fields.is_none() && allowed.mcp {
        if let Some((_, tool_fields)) = TOOL_TYPES.iter().find(|(name, _)| *name == t) {
            return parse_tool(v, t, tool_fields);
        }
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
        "hook.event" => parse_hook_event(v, id),
        "screen.read" => Ok(Request::ScreenRead { id }),
        "screen.tail" => match v.get("count").and_then(Value::as_u64) {
            Some(count) if (1..=MAX_TAIL_LINES).contains(&count) => Ok(Request::ScreenTail { id, count: count as usize }),
            _ => refuse(CODE_BAD_FIELD, re, "count must be a whole number from 1 to 200"),
        },
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

    /// A message read on a connection that acked `local` or not, and not
    /// `hooks`.
    fn parse(v: &Value, local: bool) -> Result<Request, Refusal> {
        parse_allowed(v, Allowed { local, hooks: false, mcp: false, screen: false })
    }

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
        // ends in a separator; a part that only starts or ends with a dot is
        // a plain name. Both lists are shared vectors (helper/fixtures/
        // local.json), so every reader is held to them. With an argument
        // list, as before, the name is not read.
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
            assert!(parsed(&launch(&format!("[\"{renamed}\",\"resume\"]"), "{}")).is_ok(), "{renamed} with an argument list");
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

    const HOOKS: Allowed = Allowed { local: true, hooks: true, mcp: false, screen: false };

    fn hook(text: &str) -> Result<Request, Refusal> {
        parse_allowed(&json::parse(text.as_bytes()).unwrap(), HOOKS)
    }

    /// A hook.event of `kind` whose payload is exactly `bytes` long as JSON.
    fn hook_of_size(kind: &str, bytes: usize) -> String {
        let head = format!("{{\"hook_event_name\":\"{kind}\",\"tool_response\":\"");
        let pad = bytes - head.len() - 2;
        let payload = format!("{head}{}\"}}", "x".repeat(pad));
        assert_eq!(payload.len(), bytes);
        format!("{{\"t\":\"hook.event\",\"id\":2,\"kind\":\"{kind}\",\"payload\":{payload}}}")
    }

    #[test]
    fn a_hook_event_reads_with_its_kind_and_payload_once_hooks_is_acked() {
        for kind in HOOK_KINDS {
            let text = format!("{{\"t\":\"hook.event\",\"id\":4,\"kind\":\"{kind}\",\"payload\":{{\"hook_event_name\":\"{kind}\",\"n\":1}}}}");
            match hook(&text).unwrap() {
                Request::HookEvent { id, kind: k, payload, bytes } => {
                    assert_eq!((id, k.as_str()), (4, kind));
                    let want = format!("{{\"hook_event_name\":\"{kind}\",\"n\":1}}");
                    assert_eq!(payload.to_json(), want);
                    assert_eq!(bytes, want.len());
                }
                other => panic!("{other:?}"),
            }
        }
        // Not without hooks acked, whatever else was: the connection is closed.
        let v = json::parse(b"{\"t\":\"hook.event\",\"id\":2,\"kind\":\"Stop\",\"payload\":{\"hook_event_name\":\"Stop\"}}").unwrap();
        assert_eq!(parse(&v, true).unwrap_err().code, CODE_UNKNOWN_TYPE);
        assert_eq!(parse_allowed(&v, Allowed { local: true, hooks: false, mcp: false, screen: false }).unwrap_err().code, CODE_UNKNOWN_TYPE);
        // Hooks alone allow it, and the terminal messages still need local.
        assert!(parse_allowed(&v, Allowed { local: false, hooks: true, mcp: false, screen: false }).is_ok());
        let end = json::parse(b"{\"t\":\"term.end\",\"id\":10}").unwrap();
        assert_eq!(parse_allowed(&end, Allowed { local: false, hooks: true, mcp: false, screen: false }).unwrap_err().code, CODE_UNKNOWN_TYPE);
    }

    #[test]
    fn a_hook_event_that_breaks_its_schema_is_refused_with_the_right_code() {
        let code = |text: &str| hook(text).unwrap_err().code;
        for bad_kind in ["\"PermissionRequest\"", "\"stop\"", "\"\"", "1", "null"] {
            assert_eq!(code(&format!("{{\"t\":\"hook.event\",\"id\":2,\"kind\":{bad_kind},\"payload\":{{}}}}")), CODE_BAD_FIELD, "kind {bad_kind}");
        }
        for bad_payload in ["[]", "\"x\"", "null", "1"] {
            assert_eq!(code(&format!("{{\"t\":\"hook.event\",\"id\":2,\"kind\":\"Stop\",\"payload\":{bad_payload}}}")), CODE_BAD_FIELD, "payload {bad_payload}");
        }
        assert_eq!(code("{\"t\":\"hook.event\",\"id\":2,\"kind\":\"Stop\"}"), CODE_BAD_FIELD, "no payload");
        assert_eq!(code("{\"t\":\"hook.event\",\"id\":2,\"payload\":{}}"), CODE_BAD_FIELD, "no kind");
        assert_eq!(code("{\"t\":\"hook.event\",\"kind\":\"Stop\",\"payload\":{}}"), CODE_BAD_FIELD, "no id");
        assert_eq!(code("{\"t\":\"hook.event\",\"id\":3,\"kind\":\"Stop\",\"payload\":{}}"), CODE_BAD_FIELD, "an odd id");
        assert_eq!(code("{\"t\":\"hook.event\",\"id\":2,\"kind\":\"Stop\",\"payload\":{},\"seq\":1}"), CODE_BAD_FIELD, "an extra field");
        assert_eq!(code("{\"t\":\"hook.event\",\"id\":2,\"kind\":\"Stop\",\"kind\":\"Stop\",\"payload\":{}}"), CODE_BAD_FIELD, "a field twice");
        // 64 KiB less 256 of payload as JSON is the most: one byte more is
        // too large. The 256 leave room for the `event` that carries it.
        assert!(hook(&hook_of_size("PostToolUse", MAX_HOOK_PAYLOAD)).is_ok());
        assert_eq!(code(&hook_of_size("PostToolUse", MAX_HOOK_PAYLOAD + 1)), CODE_TOO_LARGE);
        assert_eq!(MAX_HOOK_PAYLOAD, 64 * 1024 - 256);
    }

    #[test]
    fn a_hook_event_whose_payload_repeats_a_name_or_names_another_kind_is_refused() {
        let code = |payload: &str| hook(&format!("{{\"t\":\"hook.event\",\"id\":2,\"kind\":\"Stop\",\"payload\":{payload}}}")).unwrap_err().code;
        for payload in [
            "{}",
            "{\"session_id\":\"abc\"}",
            "{\"hook_event_name\":\"PreToolUse\"}",
            "{\"hook_event_name\":\"stop\"}",
            "{\"hook_event_name\":1}",
            "{\"hook_event_name\":[\"Stop\"]}",
            "{\"hook_event_name\":\"Stop\",\"hook_event_name\":\"PreToolUse\"}",
            "{\"hook_event_name\":\"Stop\",\"hook_event_name\":\"Stop\"}",
            "{\"hook_event_name\":\"Stop\",\"session_id\":\"a\",\"session_id\":\"b\"}",
        ] {
            assert_eq!(code(payload), CODE_BAD_FIELD, "payload {payload}");
        }
        // A name repeated further in is not the holder's to judge.
        assert!(hook("{\"t\":\"hook.event\",\"id\":2,\"kind\":\"Stop\",\"payload\":{\"hook_event_name\":\"Stop\",\"tool_input\":{\"a\":1,\"a\":2}}}").is_ok());
    }

    /// What the relay acks: core, local and mcp.
    const TOOLS: Allowed = Allowed { local: true, hooks: false, mcp: true, screen: false };

    fn tool(text: &str) -> Result<Request, Refusal> {
        parse_allowed(&json::parse(text.as_bytes()).unwrap(), TOOLS)
    }

    #[test]
    fn tool_stream_messages_read_with_their_stream_once_mcp_is_acked() {
        assert_eq!(tool("{\"t\":\"mcp.open\",\"stream\":1}").unwrap(), Request::McpOpen { stream: 1 });
        assert_eq!(tool("{\"t\":\"mcp.close\",\"stream\":9007199254740991}").unwrap(), Request::McpClose { stream: MAX_SAFE_INTEGER });
        let message = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}";
        match tool(&format!("{{\"t\":\"mcp\",\"stream\":3,\"message\":{message}}}")).unwrap() {
            Request::Mcp { stream, message: m, bytes } => {
                assert_eq!((stream, m.to_json(), bytes), (3, message.to_string(), message.len()));
            }
            other => panic!("{other:?}"),
        }
        // A batch is an array.
        assert!(matches!(tool("{\"t\":\"mcp\",\"stream\":3,\"message\":[{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}]}"), Ok(Request::Mcp { .. })));
        // Not without mcp acked, whatever else was: the connection is closed.
        for acked in [Allowed { local: true, hooks: true, mcp: false, screen: false }, Allowed::default()] {
            let v = json::parse(b"{\"t\":\"mcp.open\",\"stream\":1}").unwrap();
            assert_eq!(parse_allowed(&v, acked).unwrap_err().code, CODE_UNKNOWN_TYPE, "{acked:?}");
        }
        // Mcp alone allows them, and the terminal messages still need local.
        let mcp_only = Allowed { local: false, hooks: false, mcp: true, screen: false };
        assert!(parse_allowed(&json::parse(b"{\"t\":\"mcp.open\",\"stream\":1}").unwrap(), mcp_only).is_ok());
        let end = json::parse(b"{\"t\":\"term.end\",\"id\":10}").unwrap();
        assert_eq!(parse_allowed(&end, mcp_only).unwrap_err().code, CODE_UNKNOWN_TYPE);
    }

    #[test]
    fn a_tool_stream_message_that_breaks_its_schema_is_bad_field_with_no_re() {
        for bad in [
            "{\"t\":\"mcp.open\",\"stream\":0}",
            "{\"t\":\"mcp.open\",\"stream\":9007199254740992}",
            "{\"t\":\"mcp.open\",\"stream\":-1}",
            "{\"t\":\"mcp.open\",\"stream\":1.5}",
            "{\"t\":\"mcp.open\",\"stream\":\"1\"}",
            "{\"t\":\"mcp.open\"}",
            "{\"t\":\"mcp.open\",\"stream\":1,\"id\":2}",
            "{\"t\":\"mcp.open\",\"stream\":1,\"stream\":1}",
            "{\"t\":\"mcp.close\",\"stream\":1,\"message\":{}}",
            "{\"t\":\"mcp\",\"stream\":1}",
            "{\"t\":\"mcp\",\"message\":{}}",
            "{\"t\":\"mcp\",\"stream\":1,\"message\":\"text\"}",
            "{\"t\":\"mcp\",\"stream\":1,\"message\":1}",
            "{\"t\":\"mcp\",\"stream\":1,\"message\":null}",
            "{\"t\":\"mcp\",\"stream\":1,\"message\":{},\"message\":{}}",
            "{\"t\":\"mcp\",\"stream\":1,\"message\":{},\"seq\":1}",
        ] {
            let refused = tool(bad).unwrap_err();
            assert_eq!((refused.code, refused.re), (CODE_BAD_FIELD, None), "{bad}");
        }
    }

    #[test]
    fn a_tool_message_over_16_mib_less_256_as_json_is_too_large() {
        // A message of exactly the most, and one byte more.
        let of_size = |bytes: usize| format!("{{\"t\":\"mcp\",\"stream\":1,\"message\":[\"{}\"]}}", "x".repeat(bytes - 4));
        assert!(matches!(tool(&of_size(MAX_MCP_TO_HELPER)), Ok(Request::Mcp { bytes: MAX_MCP_TO_HELPER, .. })));
        let refused = tool(&of_size(MAX_MCP_TO_HELPER + 1)).unwrap_err();
        assert_eq!((refused.code, refused.re), (CODE_TOO_LARGE, None));
        assert_eq!((MAX_MCP_TO_APP, MAX_MCP_TO_HELPER), (1024 * 1024 - 256, 16 * 1024 * 1024 - 256));
    }

    const SCREEN: Allowed = Allowed { local: false, hooks: false, mcp: false, screen: true };

    fn screen(text: &str, allowed: Allowed) -> Result<Request, Refusal> {
        parse_allowed(&json::parse(text.as_bytes()).unwrap(), allowed)
    }

    #[test]
    fn screen_reads_read_once_screen_is_acked() {
        assert_eq!(screen("{\"t\":\"screen.read\",\"id\":2}", SCREEN), Ok(Request::ScreenRead { id: 2 }));
        assert_eq!(screen("{\"t\":\"screen.tail\",\"id\":4,\"count\":200}", SCREEN), Ok(Request::ScreenTail { id: 4, count: 200 }));
        assert_eq!(screen("{\"t\":\"screen.tail\",\"id\":6,\"count\":1}", SCREEN), Ok(Request::ScreenTail { id: 6, count: 1 }));
        // Without `screen` acked a read is a type the connection does not
        // allow, whatever else it acked.
        let everything_else = Allowed { local: true, hooks: true, mcp: true, screen: false };
        for text in ["{\"t\":\"screen.read\",\"id\":2}", "{\"t\":\"screen.tail\",\"id\":2,\"count\":5}"] {
            for allowed in [everything_else, Allowed::default()] {
                assert_eq!(screen(text, allowed).unwrap_err().code, CODE_UNKNOWN_TYPE, "{text} with {allowed:?}");
            }
        }
        // `screen` alone allows no terminal message.
        assert_eq!(screen("{\"t\":\"term.detach\",\"id\":2}", SCREEN).unwrap_err().code, CODE_UNKNOWN_TYPE);
        assert_eq!(MAX_TAIL_LINES, 200);
    }

    #[test]
    fn a_screen_read_that_breaks_its_schema_is_bad_field() {
        for bad in [
            "{\"t\":\"screen.read\",\"id\":3}",
            "{\"t\":\"screen.read\"}",
            "{\"t\":\"screen.read\",\"id\":2,\"count\":5}",
            "{\"t\":\"screen.read\",\"id\":2,\"id\":2}",
            "{\"t\":\"screen.tail\",\"id\":2}",
            "{\"t\":\"screen.tail\",\"id\":2,\"count\":0}",
            "{\"t\":\"screen.tail\",\"id\":2,\"count\":201}",
            "{\"t\":\"screen.tail\",\"id\":2,\"count\":-1}",
            "{\"t\":\"screen.tail\",\"id\":2,\"count\":1.5}",
            "{\"t\":\"screen.tail\",\"id\":2,\"count\":\"5\"}",
            "{\"t\":\"screen.tail\",\"id\":2,\"count\":5,\"from\":0}",
        ] {
            assert_eq!(screen(bad, SCREEN).unwrap_err().code, CODE_BAD_FIELD, "{bad}");
        }
    }
}
