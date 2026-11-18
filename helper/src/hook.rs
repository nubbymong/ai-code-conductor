//! `aicc-helper hook --store <folder> --session <sid>`: one hook event of a
//! Claude Code session, passed to the session's holder (protocol section 15,
//! capability `hooks`).
//!
//! Claude Code runs it as a command hook and writes the event as JSON on its
//! standard input. The hook mode reads that to the end, keeping at most 4 MiB,
//! takes `hook_event_name` (one of the nine kinds the app injects), cuts the
//! payload to fit (`cut`), reads the session's record with the store's own
//! strict reader, connects to the holder with the client list mode uses (the
//! endpoint's checks, then the hello's nonce and session), acks `core`,
//! `local` and `hooks`, sends one `hook.event` and waits for its reply. All of
//! it within 2 s.
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
use crate::request::HOOK_KINDS;
use crate::serve::{HOLDER_CAPS, HOOKS_CAP};
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
const MAX_PAYLOAD_DEPTH: usize = json::MAX_DEPTH - 1;
/// The id of the one `hook.event` (app ids are even).
const EVENT_ID: u64 = 2;

/// Run the hook mode on `args` (what follows `hook`). It returns by the
/// deadline whatever the work is still waiting on (standard input that never
/// ends, a holder that never answers); the process then exits with it.
pub fn run(args: &[String]) {
    let deadline = Instant::now() + DEADLINE;
    let _ = deliver(args, deadline);
}

/// The work; None wherever it stops, and the event is lost.
fn deliver(args: &[String], deadline: Instant) -> Option<()> {
    let (store_dir, sid) = parse_args(args)?;
    let input = read_stdin()?;
    let (kind, payload) = event_from(&input)?;
    let rec = store::read(&store_dir, &sid)?.ok()?;
    let mut client = Client::to_record(&rec, left(deadline)?).ok()?;
    client.send(hello::ack_message(1, &HOLDER_CAPS)).ok()?;
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
fn left(deadline: Instant) -> Option<Duration> {
    deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero())
}

/// `--store <folder> --session <sid>`, each once, nothing else; the store
/// not empty and the session id of its pattern.
fn parse_args(args: &[String]) -> Option<(PathBuf, String)> {
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
    let store_dir = store_dir.filter(|s| !s.is_empty())?;
    let sid = sid.filter(|s| valid_sid(s))?;
    Some((PathBuf::from(store_dir), sid.to_string()))
}

/// Standard input to its end. None when it could not be read, or held more
/// than `MAX_STDIN` bytes: the rest is still read, so the writer is not cut
/// off, and nothing of it is kept.
fn read_stdin() -> Option<Vec<u8>> {
    let mut stdin = std::io::stdin().lock();
    let mut kept: Vec<u8> = Vec::new();
    let mut over = false;
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        match stdin.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if over {
                    continue;
                }
                if kept.len() + n > MAX_STDIN {
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

/// The event's kind and its payload, cut to fit. None when the input is not
/// a JSON object (of at most 32 levels) whose `hook_event_name` is one of the
/// nine kinds.
pub fn event_from(input: &[u8]) -> Option<(String, Value)> {
    let payload = json::parse(input).ok()?;
    let kind = match payload.get("hook_event_name").and_then(Value::as_str) {
        Some(k) if HOOK_KINDS.contains(&k) => k.to_string(),
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
/// size of what they held as JSON, and every other string longer than
/// `MAX_STRING` as JSON is cut to its longest beginning that is not. If that
/// still does not fit, only `KEPT_FIELDS` stay, those that are strings, with
/// `"cut": true`: five strings of at most 4 KiB as JSON, about 21 KiB in all.
pub fn cut(payload: Value) -> Value {
    if fits(&payload) {
        return payload;
    }
    let members = match payload {
        Value::Obj(members) => members,
        _ => return Value::obj(vec![("cut", Value::Bool(true))]),
    };
    let members: Vec<(String, Value)> = members
        .into_iter()
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
    use crate::request::{self, Allowed, Request, MAX_HOOK_PAYLOAD};
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
    fn only_a_json_object_naming_one_of_the_nine_kinds_is_an_event() {
        for kind in HOOK_KINDS {
            let input = format!("{{\"session_id\":\"abc\",\"hook_event_name\":\"{kind}\"}}");
            let (k, payload) = event_from(input.as_bytes()).expect(kind);
            assert_eq!(k, kind);
            assert_eq!(payload.to_json(), input, "a small payload is kept as it is");
        }
        let deep = format!("{{\"hook_event_name\":\"Stop\",\"x\":{}{}}}", "[".repeat(32), "]".repeat(32));
        for bad in [
            "",
            "not json",
            "[\"Stop\"]",
            "\"Stop\"",
            "{}",
            "{\"hook_event_name\":\"PermissionRequest\"}",
            "{\"hook_event_name\":\"stop\"}",
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
        ]);
        assert_eq!(got, want);
    }

    #[test]
    fn long_strings_elsewhere_are_cut_and_what_still_does_not_fit_keeps_five_fields() {
        // A long prompt: cut to 4 KiB as JSON, the rest kept.
        let payload = obj(vec![("hook_event_name", Value::str("UserPromptSubmit")), ("cwd", Value::str("/w")), ("prompt", Value::str(&"p".repeat(60 * 1024)))]);
        let cut1 = cut(payload);
        assert_eq!(cut1.get("cwd"), Some(&Value::str("/w")));
        assert_eq!(cut1.get("prompt"), Some(&Value::str(&"p".repeat(MAX_STRING - 2))));
        assert!(cut1.get("cut").is_none());

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
        let mut many = vec![("hook_event_name", Value::str("SessionStart"))];
        let long = "\"".repeat(3000);
        for _ in 0..200 {
            many.push(("prompt", Value::str(&long)));
        }
        out.push(obj(many));
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
            let parsed = request::parse_allowed(&message, Allowed { local: true, hooks: true });
            match parsed {
                Ok(Request::HookEvent { payload, .. }) => assert!(payload.to_json().len() <= MAX_HOOK_PAYLOAD),
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
