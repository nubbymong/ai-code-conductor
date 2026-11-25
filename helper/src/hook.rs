//! `aicc-helper hook --store <folder> --session <sid>`: one hook event of a
//! session, passed to the session's holder (protocol section 15, capability
//! `hooks`). From 2.1.3-beta.18 either option may be left out and is then
//! read from the environment: the store from `AICC_HELPER_STORE`, the
//! session from `AICC_HELPER_SESSION` (`parse_args_or_env`).
//!
//! A CLI runs it as a command hook and writes the event as JSON on its
//! standard input. The hook mode reads that to the end, keeping at most 4 MiB,
//! takes `hook_event_name` (one plain word, `request::plain_word`: which
//! kinds a session takes is its holder's to decide, from what the session's
//! launch declared, or the nine the app injects into a Claude Code session
//! when it declared none; a payload that names a member twice is not an
//! event, and an escaped lone surrogate reads as U+FFFD), cuts the payload to
//! fit (`cut`), reads the session's record with the store's own
//! strict reader, connects to the holder with the client list mode uses (the
//! endpoint's checks, then the hello's nonce and session), acks `core`,
//! `local` and `hooks`, sends one `hook.event` and waits for its reply (a
//! kind the holder does not take is answered `bad-field`). All of it within
//! 2 s.
//!
//! It always exits 0 and never writes to standard output or standard error:
//! Claude Code adds what a SessionStart or UserPromptSubmit hook prints to the
//! conversation, and an exit other than 0 changes what the CLI does. Whatever
//! fails loses that one event, silently. A holder from before hook events
//! (no `hooks` in its hello) is sent nothing, not even the ack. The hook mode
//! writes no file and starts no process.

use crate::client::Client;
use crate::frame::Body;
use crate::hello::{self, valid_sid};
use crate::json::{self, Value};
use crate::request::{plain_word, repeats_a_name};
use crate::serve::HOOKS_CAP;
use crate::store;
use std::io::Read;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Everything, from the start to the holder's reply, within this.
pub const DEADLINE: Duration = Duration::from_secs(2);
/// The most of standard input kept: an event that is larger is lost.
pub const MAX_STDIN: usize = 4 * 1024 * 1024;
/// A payload over this, as compact JSON, is cut.
pub const CUT_OVER: usize = 48 * 1024;
/// When a payload is cut, a string is at most this long as JSON, its quotes
/// and escapes counted.
pub const MAX_STRING: usize = 4 * 1024;
/// What is left of a payload that nothing less will fit.
pub const KEPT_FIELDS: [&str; 5] = ["hook_event_name", "session_id", "transcript_path", "cwd", "tool_name"];
/// The payload sits one level inside the message that carries it.
pub(crate) const MAX_PAYLOAD_DEPTH: usize = json::MAX_DEPTH - 1;
/// The variable the store is read from when `--store` is left out (the hook
/// and status modes, from 2.1.3-beta.18).
pub const STORE_ENV: &str = "AICC_HELPER_STORE";
/// The variable the session id is read from when `--session` is left out.
pub const SESSION_ENV: &str = "AICC_HELPER_SESSION";
/// The id of the one `hook.event` (app ids are even).
const EVENT_ID: u64 = 2;
/// What the hook mode acks: the frozen core, `local` and `hooks`, and never
/// more, whatever else a holder offers (`serve::HOLDER_CAPS`), so every
/// holder from 2.1.3-beta.8 on takes it.
pub const ACK_CAPS: [&str; 3] = ["core", "local", HOOKS_CAP];

/// Run the hook mode on `args` (what follows `hook`). It returns by the
/// deadline whatever the work is still waiting on (standard input that never
/// ends, a holder that never answers); the process then exits with it.
pub fn run(args: &[String]) {
    let deadline = Instant::now() + DEADLINE;
    let args = args.to_vec();
    let (done_tx, done) = mpsc::channel::<()>();
    let worker = thread::Builder::new().spawn(move || {
        let _ = deliver(&args, deadline);
        let _ = done_tx.send(());
    });
    if worker.is_ok() {
        // Done, failed, panicked (the sender is dropped) or out of time.
        let _ = done.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    }
}

/// The work; None wherever it stops, and the event is lost.
fn deliver(args: &[String], deadline: Instant) -> Option<()> {
    let (store_dir, sid) = parse_args_or_env(args, from_env)?;
    let input = read_stdin()?;
    let (kind, payload) = event_from(&input)?;
    let rec = store::read(&store_dir, &sid)?.ok()?;
    let mut client = Client::to_record(&rec, left(deadline)?).ok()?;
    if !client.hello.caps.iter().any(|c| c.as_str() == HOOKS_CAP) {
        return None;
    }
    client.send(hello::ack_message(1, &ACK_CAPS)).ok()?;
    client.send(hook_event(&kind, payload)).ok()?;
    loop {
        match client.recv(left(deadline)?) {
            Ok(Some(f)) => {
                // `hook.taken`, or an `error` about this event: done either way.
                if let Body::Json(v) = &f.body {
                    if f.channel == 0 && v.get("re").and_then(Value::as_u64) == Some(EVENT_ID) {
                        return Some(());
                    }
                }
            }
            Ok(None) | Err(_) => return None,
        }
    }
}

/// The time left until `deadline`; None once it has passed.
pub(crate) fn left(deadline: Instant) -> Option<Duration> {
    deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero())
}

/// `--store <folder> --session <sid>`, each once, nothing else; the store
/// not empty and the session id of its pattern. The relay (`relay.rs`) takes
/// the same command line.
pub(crate) fn parse_args(args: &[String]) -> Option<(PathBuf, String)> {
    let (store_dir, sid) = given(args)?;
    finish(store_dir, sid)
}

/// The hook and status modes' command line: as `parse_args`, except that
/// either option may be left out, and is then read from `env` (the
/// process's environment: `STORE_ENV`, `SESSION_ENV`). An option given wins
/// over its variable; a variable that is empty, or not Unicode, is as good
/// as none.
pub(crate) fn parse_args_or_env(args: &[String], env: impl Fn(&str) -> Option<String>) -> Option<(PathBuf, String)> {
    let (store_dir, sid) = given(args)?;
    let store_env = if store_dir.is_none() { env(STORE_ENV) } else { None };
    let sid_env = if sid.is_none() { env(SESSION_ENV) } else { None };
    finish(store_dir.or(store_env.as_deref()), sid.or(sid_env.as_deref()))
}

/// The process's environment variable `name`, when it is set and Unicode.
pub(crate) fn from_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// The options given: `--store` and `--session`, each at most once, and
/// nothing else. None for any other command line.
fn given(args: &[String]) -> Option<(Option<&str>, Option<&str>)> {
    let mut store_dir: Option<&str> = None;
    let mut sid: Option<&str> = None;
    let mut i = 0;
    while i < args.len() {
        let value = args.get(i + 1)?.as_str();
        let slot = match args[i].as_str() {
            "--store" => &mut store_dir,
            "--session" => &mut sid,
            _ => return None,
        };
        if slot.replace(value).is_some() {
            return None;
        }
        i += 2;
    }
    Some((store_dir, sid))
}

/// Both present, the store not empty and the session id of its pattern.
fn finish(store_dir: Option<&str>, sid: Option<&str>) -> Option<(PathBuf, String)> {
    let store_dir = store_dir.filter(|s| !s.is_empty())?;
    let sid = sid.filter(|s| valid_sid(s))?;
    Some((PathBuf::from(store_dir), sid.to_string()))
}

/// Standard input to its end, at most `MAX_STDIN` bytes of it kept.
pub(crate) fn read_stdin() -> Option<Vec<u8>> {
    read_capped(std::io::stdin().lock(), MAX_STDIN)
}

/// `r` to its end. None when it could not be read, or held more than `max`
/// bytes: the rest is still read, so the writer is not cut off, and nothing
/// of it is kept.
pub(crate) fn read_capped<R: Read>(mut r: R, max: usize) -> Option<Vec<u8>> {
    let mut kept: Vec<u8> = Vec::new();
    let mut over = false;
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        match r.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if over {
                    continue;
                }
                if kept.len() + n > max {
                    over = true;
                    kept = Vec::new();
                } else {
                    kept.extend_from_slice(&chunk[..n]);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return None,
        }
    }
    if over {
        None
    } else {
        Some(kept)
    }
}

/// The code unit of a `\u` escape of four hex digits at `at`, if one is there.
fn escaped_unit(input: &[u8], at: usize) -> Option<u32> {
    let esc = input.get(at..at + 6)?;
    if esc[0] != b'\\' || esc[1] != b'u' {
        return None;
    }
    let mut unit = 0;
    for &digit in &esc[2..] {
        unit = unit * 16 + char::from(digit).to_digit(16)?;
    }
    Some(unit)
}

/// `input` with every escaped lone surrogate (a `\u` escape of a code unit
/// from D800 to DFFF that is not half of a pair) written as U+FFFD, the
/// replacement character, in UTF-8. Node writes one when a string was cut
/// inside a pair, as a tool's output cut in the middle of an emoji: the
/// app's JSON.parse reads it, json.rs does not, and the event would be lost.
/// Only escapes inside strings change; json.rs judges everything else.
pub(crate) fn mend_surrogates(input: &[u8]) -> Vec<u8> {
    const HIGH: std::ops::RangeInclusive<u32> = 0xD800..=0xDBFF;
    const LOW: std::ops::RangeInclusive<u32> = 0xDC00..=0xDFFF;
    let replacement = "\u{fffd}".as_bytes();
    let mut out = Vec::with_capacity(input.len());
    let mut in_string = false;
    let mut i = 0;
    while i < input.len() {
        let b = input[i];
        if !in_string || b != b'\\' {
            // UTF-8 puts no quote or backslash inside a character, so a
            // byte is enough to see where a string starts and ends.
            if b == b'"' {
                in_string = !in_string;
            }
            out.push(b);
            i += 1;
            continue;
        }
        match escaped_unit(input, i) {
            Some(unit) if HIGH.contains(&unit) => {
                if escaped_unit(input, i + 6).map_or(false, |next| LOW.contains(&next)) {
                    out.extend_from_slice(&input[i..i + 12]);
                    i += 12;
                } else {
                    out.extend_from_slice(replacement);
                    i += 6;
                }
            }
            Some(unit) if LOW.contains(&unit) => {
                out.extend_from_slice(replacement);
                i += 6;
            }
            Some(_) => {
                out.extend_from_slice(&input[i..i + 6]);
                i += 6;
            }
            None => {
                // Another escape: the backslash and what it escapes, so an
                // escaped quote does not end the string.
                let end = (i + 2).min(input.len());
                out.extend_from_slice(&input[i..end]);
                i = end;
            }
        }
    }
    out
}

/// The event's kind and its payload, cut to fit. None when the input is not
/// a JSON object (of at most 32 levels) whose `hook_event_name` is a plain
/// word (`request::plain_word`), or when it names one of its members twice:
/// json.rs finds the first and the app's JSON.parse the last, so the two
/// would read it apart. Whether the session takes that kind is the holder's
/// to decide: it knows what the session's launch declared. An escaped lone
/// surrogate reads as U+FFFD (`mend_surrogates`).
pub fn event_from(input: &[u8]) -> Option<(String, Value)> {
    let payload = json::parse(&mend_surrogates(input)).ok()?;
    if repeats_a_name(&payload) {
        return None;
    }
    let kind = match payload.get("hook_event_name").and_then(Value::as_str) {
        Some(k) if plain_word(k) => k.to_string(),
        _ => return None,
    };
    Some((kind, cut(payload)))
}

/// The `hook.event` message for one event.
pub fn hook_event(kind: &str, payload: Value) -> Value {
    Value::obj(vec![("t", Value::str("hook.event")), ("id", Value::uint(EVENT_ID)), ("kind", Value::str(kind)), ("payload", payload)])
}

/// True when the payload goes as it is: at most `CUT_OVER` bytes as compact
/// JSON, and at most 31 levels deep, so the message carrying it is at most
/// 32.
fn fits(v: &Value) -> bool {
    v.fits_depth(MAX_PAYLOAD_DEPTH) && v.to_json().len() <= CUT_OVER
}

/// The payload rule. A payload that fits (`fits`) is kept as it is.
/// Otherwise `tool_input` and `tool_response` become `{"cut": <bytes>}`, the
/// size of what they held as JSON, every other string longer than
/// `MAX_STRING` as JSON is cut to its longest beginning that is not, and the
/// payload gains `"cut": true` (in place of a `cut` member of its own), so a
/// string cut here does not pass for whole. If that still does not fit,
/// only `KEPT_FIELDS` stay, those that are strings, with `"cut": true`: five
/// strings of at most 4 KiB as JSON, about 21 KiB in all.
pub fn cut(payload: Value) -> Value {
    if fits(&payload) {
        return payload;
    }
    let members = match payload {
        Value::Obj(members) => members,
        _ => return Value::obj(vec![("cut", Value::Bool(true))]),
    };
    let mut members: Vec<(String, Value)> = members
        .into_iter()
        .filter(|(name, _)| name != "cut")
        .map(|(name, mut value)| {
            if name == "tool_input" || name == "tool_response" {
                let bytes = value.to_json().len() as u64;
                (name, Value::obj(vec![("cut", Value::uint(bytes))]))
            } else {
                cut_strings(&mut value);
                (name, value)
            }
        })
        .collect();
    members.push(("cut".to_string(), Value::Bool(true)));
    let smaller = Value::Obj(members);
    if fits(&smaller) {
        return smaller;
    }
    let mut kept: Vec<(String, Value)> = Vec::new();
    for name in KEPT_FIELDS {
        if let Some(Value::Str(s)) = smaller.get(name) {
            kept.push((name.to_string(), Value::Str(s.clone())));
        }
    }
    kept.push(("cut".to_string(), Value::Bool(true)));
    Value::Obj(kept)
}

/// Cut every string in `v` longer than `MAX_STRING` as JSON (values only:
/// a member's name is left as it is).
fn cut_strings(v: &mut Value) {
    match v {
        Value::Str(s) => cut_string(s),
        Value::Arr(items) => items.iter_mut().for_each(cut_strings),
        Value::Obj(members) => members.iter_mut().for_each(|(_, value)| cut_strings(value)),
        _ => {}
    }
}

/// How long `c` is in a JSON string, as `json.rs` writes it.
fn json_len(c: char) -> usize {
    match c {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{08}' | '\u{0c}' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}

/// Cut `s` to its longest beginning whose JSON, quotes included, is at most
/// `MAX_STRING` bytes.
fn cut_string(s: &mut String) {
    let mut len = 2;
    let mut end = None;
    for (at, c) in s.char_indices() {
        len += json_len(c);
        if len > MAX_STRING {
            end = Some(at);
            break;
        }
    }
    if let Some(at) = end {
        s.truncate(at);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{self, Direction, Frame};
    use crate::request::{self, Allowed, Request, HOOK_KINDS, MAX_HOOK_PAYLOAD};
    use crate::serve::MAX_JSON_AFTER_LAUNCH;

    fn strings(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_command_line_is_a_store_and_a_session_each_once() {
        let want = Some((PathBuf::from("/s"), "sess-0001".to_string()));
        assert_eq!(parse_args(&strings(&["--store", "/s", "--session", "sess-0001"])), want);
        assert_eq!(parse_args(&strings(&["--session", "sess-0001", "--store", "/s"])), want);
        for bad in [
            &[][..],
            &["--store", "/s"][..],
            &["--session", "sess-0001"][..],
            &["--store", "/s", "--session", "bad"][..],
            &["--store", "/s", "--session", "sess 0001"][..],
            &["--store", "", "--session", "sess-0001"][..],
            &["--store", "/s", "--session", "sess-0001", "--x", "1"][..],
            &["--store", "/s", "--store", "/t", "--session", "sess-0001"][..],
            &["--store", "/s", "--session"][..],
            &["hook", "--store", "/s", "--session", "sess-0001"][..],
        ] {
            assert_eq!(parse_args(&strings(bad)), None, "{bad:?}");
        }
    }

    #[test]
    fn the_hook_and_status_modes_read_a_store_and_a_session_left_out_from_the_environment() {
        let both = |name: &str| match name {
            STORE_ENV => Some("/env-store".to_string()),
            SESSION_ENV => Some("sess-env-01".to_string()),
            _ => None,
        };
        let none = |_: &str| -> Option<String> { None };
        fn read(args: &[&str], env: &dyn Fn(&str) -> Option<String>) -> Option<(PathBuf, String)> {
            parse_args_or_env(&strings(args), env)
        }
        let at = |store: &str, sid: &str| Some((PathBuf::from(store), sid.to_string()));
        // Each left out: from its variable. Each given: the option wins.
        assert_eq!(read(&[], &both), at("/env-store", "sess-env-01"));
        assert_eq!(read(&["--store", "/s"], &both), at("/s", "sess-env-01"));
        assert_eq!(read(&["--session", "sess-0001"], &both), at("/env-store", "sess-0001"));
        assert_eq!(read(&["--store", "/s", "--session", "sess-0001"], &both), at("/s", "sess-0001"));
        // With no variables, the command line as before.
        assert_eq!(read(&["--store", "/s", "--session", "sess-0001"], &none), at("/s", "sess-0001"));
        for args in [&[][..], &["--store", "/s"][..], &["--session", "sess-0001"][..]] {
            assert_eq!(read(args, &none), None, "{args:?}");
        }
        // A variable is held to the option's rules: an empty store, a session
        // id that breaks its pattern.
        let bad = |name: &str| match name {
            STORE_ENV => Some(String::new()),
            SESSION_ENV => Some("bad id".to_string()),
            _ => None,
        };
        assert_eq!(read(&["--session", "sess-0001"], &bad), None);
        assert_eq!(read(&["--store", "/s"], &bad), None);
        // A command line it does not take is not saved by the variables.
        for args in [&["--x", "1"][..], &["--store"][..], &["--store", "/s", "--store", "/t"][..], &["hook"][..]] {
            assert_eq!(read(args, &both), None, "{args:?}");
        }
        // The relay's command line reads no variable.
        assert_eq!(parse_args(&[]), None);
        assert_eq!((STORE_ENV, SESSION_ENV), ("AICC_HELPER_STORE", "AICC_HELPER_SESSION"));
    }

    #[test]
    fn standard_input_is_read_to_its_end_and_kept_only_up_to_the_cap() {
        // How much was kept, once the reader was read to its end.
        let read = |len: usize, max: usize| {
            let bytes: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let mut input = std::io::Cursor::new(bytes.clone());
            let kept = read_capped(&mut input, max);
            assert_eq!(input.position(), len as u64, "{len} bytes, cap {max}: not read to its end");
            if let Some(k) = &kept {
                assert_eq!(k, &bytes, "{len} bytes, cap {max}: kept other bytes");
            }
            kept.map(|k| k.len())
        };
        assert_eq!(read(0, 10), Some(0));
        assert_eq!(read(10, 10), Some(10));
        assert_eq!(read(11, 10), None);
        // Several reads of 64 KiB: kept whole up to the cap, and past it read
        // on to the end and kept not at all.
        assert_eq!(read(200_000, 200_000), Some(200_000));
        assert_eq!(read(200_001, 200_000), None);
        assert_eq!(read(200_000, 70_000), None);
        assert_eq!(read(MAX_STDIN, MAX_STDIN), Some(MAX_STDIN));
        assert_eq!(read(MAX_STDIN + 1, MAX_STDIN), None);
        // A read that fails loses the event; one interrupted goes on.
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::Other, "broken"))
            }
        }
        assert_eq!(read_capped(Broken, 10), None);
        struct Interrupted(bool);
        impl Read for Interrupted {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.0 {
                    return Ok(0);
                }
                self.0 = true;
                buf[0] = b'x';
                Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "again"))
            }
        }
        assert_eq!(read_capped(Interrupted(false), 10), Some(Vec::new()));
    }

    #[test]
    fn only_a_json_object_naming_a_plain_word_kind_is_an_event() {
        // The nine, and any other plain word: which kinds a session takes is
        // its holder's to decide (from 2.1.3-beta.18), so another CLI's
        // PermissionRequest is sent on to a holder whose launch declared it.
        let longest = "K".repeat(64);
        let mut kinds: Vec<&str> = HOOK_KINDS.to_vec();
        kinds.extend(["PermissionRequest", "stop", longest.as_str()]);
        for kind in kinds {
            let input = format!("{{\"session_id\":\"abc\",\"hook_event_name\":\"{kind}\"}}");
            let (k, payload) = event_from(input.as_bytes()).expect(kind);
            assert_eq!(k, kind);
            assert_eq!(payload.to_json(), input, "a small payload is kept as it is");
        }
        let deep = format!("{{\"hook_event_name\":\"Stop\",\"x\":{}{}}}", "[".repeat(32), "]".repeat(32));
        let too_long = format!("{{\"hook_event_name\":\"{}\"}}", "K".repeat(65));
        for bad in [
            "",
            "not json",
            "[\"Stop\"]",
            "\"Stop\"",
            "{}",
            "{\"hook_event_name\":\"\"}",
            "{\"hook_event_name\":\"Pre-Tool\"}",
            "{\"hook_event_name\":\"session.idle\"}",
            "{\"hook_event_name\":\"Stop \"}",
            too_long.as_str(),
            "{\"hook_event_name\":1}",
            "{\"hook_event_name\":\"Stop\"} trailing",
            deep.as_str(),
        ] {
            assert!(event_from(bad.as_bytes()).is_none(), "{bad:?}");
        }
        // Pretty-printed JSON is an event too; the payload is measured, and
        // sent, compact.
        let (_, payload) = event_from(b"{\n  \"hook_event_name\": \"Stop\",\n  \"n\": 1\n}\n").expect("pretty JSON");
        assert_eq!(payload.to_json(), "{\"hook_event_name\":\"Stop\",\"n\":1}");
    }

    #[test]
    fn an_escaped_lone_surrogate_reads_as_the_replacement_character() {
        // Node writes a lone surrogate when a string was cut inside a pair,
        // a tool's output cut in the middle of an emoji: still an event.
        let input = br#"{"hook_event_name":"PostToolUse","tool_response":"cut mid-emoji \ud83d"}"#;
        let (kind, payload) = event_from(input).expect("an event");
        assert_eq!(kind, "PostToolUse");
        assert_eq!(payload.get("tool_response").and_then(Value::as_str), Some("cut mid-emoji \u{fffd}"));
        // In this table `%` stands for a backslash.
        let bs = |s: &str| s.replace('%', "\\");
        for (escaped, read) in [
            ("%ud83d", "\u{fffd}"),
            ("%ude00", "\u{fffd}"),
            ("%uD83D", "\u{fffd}"),
            ("%ud83d%u0041", "\u{fffd}A"),
            ("%ud83d%ud83d%ude00", "\u{fffd}\u{1f600}"),
            ("%ude00%ud83d", "\u{fffd}\u{fffd}"),
            ("%ud83d%ude00", "\u{1f600}"),
            ("%%ud83d", "%ud83d"),
            ("%%%ud83d", "%\u{fffd}"),
            ("a%\"%ud83d", "a\"\u{fffd}"),
        ] {
            let input = format!(r#"{{"hook_event_name":"Stop","s":"{}"}}"#, bs(escaped));
            let (_, payload) = event_from(input.as_bytes()).unwrap_or_else(|| panic!("{escaped}"));
            assert_eq!(payload.get("s").and_then(Value::as_str), Some(bs(read).as_str()), "{escaped}");
        }
        // In a member's name too.
        let (_, payload) = event_from(br#"{"hook_event_name":"Stop","\udc00":1}"#).expect("an event");
        assert_eq!(payload.keys(), Some(vec!["hook_event_name", "\u{fffd}"]));
        // What is not JSON stays not JSON.
        for bad in [r#"{"hook_event_name":"Stop","s":"\ud83"}"#, r#"{"hook_event_name":"Stop",\ud83d:1}"#] {
            assert!(event_from(bad.as_bytes()).is_none(), "{bad}");
        }
    }

    #[test]
    fn a_payload_that_names_a_member_twice_is_not_an_event() {
        // json.rs keeps both and finds the first; the app's JSON.parse keeps
        // the last: the kind, the session or the transcript would be read
        // one way here and another way there.
        for input in [
            r#"{"hook_event_name":"Stop","hook_event_name":"PreToolUse"}"#,
            r#"{"hook_event_name":"Stop","session_id":"a","session_id":"b"}"#,
            r#"{"transcript_path":"/a","hook_event_name":"Stop","transcript_path":"/b"}"#,
            r#"{"hook_event_name":"Stop","cut":1,"cut":2}"#,
        ] {
            assert!(event_from(input.as_bytes()).is_none(), "{input}");
        }
        // The names compared are the names read: an escaped `c` is a `c`.
        let escaped = r#"{"hook_event_name":"Stop","%u0063ut":1,"cut":2}"#.replace('%', "\\");
        assert!(event_from(escaped.as_bytes()).is_none(), "{escaped}");
        // A name repeated further in is the tool's own: kept as it came.
        let nested = r#"{"hook_event_name":"Stop","tool_input":{"a":1,"a":2}}"#;
        let (_, payload) = event_from(nested.as_bytes()).expect("an event");
        assert_eq!(payload.to_json(), nested);
    }

    fn json_string_len(s: &str) -> usize {
        Value::str(s).to_json().len()
    }

    #[test]
    fn a_string_is_cut_at_a_character_boundary_to_4_kib_as_json() {
        let cases: [(&str, usize, usize); 5] = [
            // (one character, how many fit, how many are given)
            ("a", 4094, 5000),
            ("\"", 2047, 3000),
            ("\u{1}", 682, 1000),
            ("\u{e9}", 2047, 3000),
            ("\u{1f600}", 1023, 2000),
        ];
        for (unit, fit, given) in cases {
            let mut s = unit.repeat(given);
            cut_string(&mut s);
            assert_eq!(s, unit.repeat(fit), "{unit:?}");
            assert!(json_string_len(&s) <= MAX_STRING);
            assert!(json_string_len(&unit.repeat(fit + 1)) > MAX_STRING, "{unit:?}: one more would fit");
            // What fits already is left alone.
            let mut whole = unit.repeat(fit);
            cut_string(&mut whole);
            assert_eq!(whole, unit.repeat(fit));
        }
    }

    fn obj(members: Vec<(&str, Value)>) -> Value {
        Value::obj(members)
    }

    #[test]
    fn a_large_tool_input_and_tool_response_become_their_size() {
        let input = obj(vec![("command", Value::str("cat big.txt"))]);
        let response = Value::str(&"x".repeat(100 * 1024));
        let payload = obj(vec![
            ("session_id", Value::str("abc")),
            ("hook_event_name", Value::str("PostToolUse")),
            ("tool_name", Value::str("Bash")),
            ("tool_input", input.clone()),
            ("tool_response", response.clone()),
        ]);
        let got = cut(payload);
        let want = obj(vec![
            ("session_id", Value::str("abc")),
            ("hook_event_name", Value::str("PostToolUse")),
            ("tool_name", Value::str("Bash")),
            ("tool_input", obj(vec![("cut", Value::uint(input.to_json().len() as u64))])),
            ("tool_response", obj(vec![("cut", Value::uint(100 * 1024 + 2))])),
            ("cut", Value::Bool(true)),
        ]);
        assert_eq!(got, want);
    }

    #[test]
    fn long_strings_elsewhere_are_cut_and_what_still_does_not_fit_keeps_five_fields() {
        // A long prompt: cut to 4 KiB as JSON, the rest kept, and the
        // payload says it was cut.
        let payload = obj(vec![("hook_event_name", Value::str("UserPromptSubmit")), ("cwd", Value::str("/w")), ("prompt", Value::str(&"p".repeat(60 * 1024)))]);
        let cut1 = cut(payload);
        assert_eq!(cut1.get("cwd"), Some(&Value::str("/w")));
        assert_eq!(cut1.get("prompt"), Some(&Value::str(&"p".repeat(MAX_STRING - 2))));
        assert_eq!(cut1.get("cut"), Some(&Value::Bool(true)));
        // A `cut` member of the payload's own is replaced, not repeated.
        let payload = obj(vec![("hook_event_name", Value::str("UserPromptSubmit")), ("cut", Value::str("mine")), ("prompt", Value::str(&"p".repeat(60 * 1024)))]);
        let cut1 = cut(payload);
        assert_eq!(cut1.keys(), Some(vec!["hook_event_name", "prompt", "cut"]));
        assert_eq!(cut1.get("cut"), Some(&Value::Bool(true)));

        // Many fields, none long: only the five stay, those that are strings.
        let mut members = vec![
            ("hook_event_name", Value::str("Notification")),
            ("session_id", Value::str("abc")),
            ("transcript_path", Value::str("/t.jsonl")),
            ("cwd", Value::Arr(vec![Value::str("not a string")])),
        ];
        let names: Vec<String> = (0..2000).map(|n| format!("field{n}")).collect();
        for name in &names {
            members.push((name.as_str(), Value::str("a value of some length")));
        }
        let cut2 = cut(obj(members));
        assert_eq!(cut2.to_json(), "{\"hook_event_name\":\"Notification\",\"session_id\":\"abc\",\"transcript_path\":\"/t.jsonl\",\"cut\":true}");
    }

    /// A value nested `levels` deep.
    fn nest(levels: usize) -> Value {
        (0..levels).fold(Value::Null, |inner, _| Value::Arr(vec![inner]))
    }

    /// Payloads made to break the bound: long and escaped strings in every
    /// kept field, many fields, long names, deep values.
    fn hostile() -> Vec<Value> {
        let control = "\u{1}".repeat(100_000);
        let emoji = "\u{1f600}".repeat(30_000);
        let long_name = "k".repeat(100_000);
        let mut out = vec![
            obj(vec![("hook_event_name", Value::str("PostToolUse")), ("tool_response", Value::str(&"x".repeat(102_400)))]),
            obj(vec![
                ("hook_event_name", Value::str("Stop")),
                ("session_id", Value::str(&control)),
                ("transcript_path", Value::str(&control)),
                ("cwd", Value::str(&emoji)),
                ("tool_name", Value::str(&control)),
            ]),
            obj(vec![("hook_event_name", Value::str("Stop")), (long_name.as_str(), Value::Null)]),
            obj(vec![("hook_event_name", Value::str("Stop")), ("tool_input", nest(31)), ("other", nest(31))]),
            obj(vec![("hook_event_name", Value::str("Stop")), ("x", nest(31))]),
            obj(vec![("hook_event_name", Value::str("Stop")), ("x", Value::Arr((0..20_000).map(|_| Value::str("ab")).collect()))]),
        ];
        let names: Vec<String> = (0..200).map(|n| format!("prompt{n}")).collect();
        let mut many = vec![("hook_event_name", Value::str("SessionStart"))];
        let long = "\"".repeat(3000);
        for name in &names {
            many.push((name.as_str(), Value::str(&long)));
        }
        out.push(obj(many));
        // Its own `cut` member, and a long prompt: the second step's result.
        out.push(obj(vec![("hook_event_name", Value::str("UserPromptSubmit")), ("cut", Value::Num("1".to_string())), ("prompt", Value::str(&control))]));
        out
    }

    #[test]
    fn whatever_comes_the_message_fits_the_holder_once_launched() {
        for (n, payload) in hostile().into_iter().enumerate() {
            let kind = payload.get("hook_event_name").and_then(Value::as_str).expect("a kind").to_string();
            let got = cut(payload);
            assert!(got.fits_depth(MAX_PAYLOAD_DEPTH), "payload {n} nests too deep");
            assert!(got.to_json().len() <= CUT_OVER, "payload {n} is {} bytes", got.to_json().len());
            let message = hook_event(&kind, got);
            let bytes = frame::encode(&Frame::json(0, message.clone()), Direction::AppToHelper).expect("the message encodes");
            assert!(bytes.len() - 9 <= MAX_JSON_AFTER_LAUNCH, "message {n} is {} bytes", bytes.len() - 9);
            let parsed = request::parse_allowed(&message, Allowed { local: true, hooks: true, mcp: false, screen: false, status: false });
            match parsed {
                Ok(Request::HookEvent { payload, bytes, .. }) => {
                    assert_eq!(bytes, payload.to_json().len(), "payload {n}");
                    assert!(bytes <= MAX_HOOK_PAYLOAD, "payload {n}");
                }
                other => panic!("payload {n}: {other:?}"),
            }
        }
    }

    #[test]
    fn the_limits_are_the_documented_ones() {
        assert_eq!(DEADLINE, Duration::from_secs(2));
        assert_eq!((MAX_STDIN, CUT_OVER, MAX_STRING), (4 * 1024 * 1024, 48 * 1024, 4 * 1024));
        assert_eq!(MAX_PAYLOAD_DEPTH, 31);
        // Five strings of at most 4 KiB, their names and "cut": well under 48 KiB.
        assert!(5 * (MAX_STRING + 20) + 11 < CUT_OVER);
    }
}
