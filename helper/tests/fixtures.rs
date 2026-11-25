//! The shared message fixtures (helper/fixtures/*.json). The same files are read
//! by tests/unit/scripts/helper-fixtures.test.ts in the app's test suite, so
//! the app and the helper cannot drift apart: a vector that changes must
//! change for both.

use aicc_helper::frame::{self, Body, Direction};
use aicc_helper::hello;
use aicc_helper::holder::{self, HookEvent};
use aicc_helper::hook;
use aicc_helper::json::{self, Value};
use aicc_helper::pty::{Conpty, PtySize};
use aicc_helper::request::{self, Allowed, Request};
use aicc_helper::ring::DEFAULT_RING_BYTES;
use aicc_helper::screen::{self, Screen};
use aicc_helper::store::{self, Listing, Record};
use aicc_helper::{relay, serve, transport};
use std::fs;

fn load(name: &str) -> Value {
    let path = format!("{}/fixtures/{}", env!("CARGO_MANIFEST_DIR"), name);
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
    json::parse(&bytes).unwrap_or_else(|e| panic!("{path} is not JSON: {e:?}"))
}

fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len() % 2 == 0, "odd hex length");
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex")).collect()
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_else(|| panic!("missing string {key}"))
}

fn items<'a>(v: &'a Value, key: &str) -> &'a Vec<Value> {
    v.get(key).and_then(Value::as_array).unwrap_or_else(|| panic!("missing array {key}"))
}

fn strings<'a>(v: &'a Value, key: &str) -> Vec<&'a str> {
    items(v, key).iter().map(|s| s.as_str().expect("a string")).collect()
}

fn flow(v: &Value) -> Direction {
    Direction::from_name(text(v, "flow")).expect("a known flow")
}

#[test]
fn every_valid_frame_decodes_to_its_fields_and_encodes_to_the_same_bytes() {
    let doc = load("frames.json");
    let valid = items(&doc, "valid");
    assert!(!valid.is_empty());
    for case in valid {
        let name = text(case, "name");
        let bytes = unhex(text(case, "hex"));
        let f = flow(case);
        let decoded = frame::decode(&bytes, f).unwrap_or_else(|e| panic!("{name}: {e}"));
        let channel = case.get("channel").and_then(Value::as_u64).expect("channel");
        assert_eq!(u64::from(decoded.channel), channel, "{name}: channel");
        match text(case, "kind") {
            "json" => {
                let expected = json::parse(text(case, "payload_text").as_bytes()).expect("payload_text is JSON");
                match &decoded.body {
                    Body::Json(v) => assert_eq!(v, &expected, "{name}: payload"),
                    Body::Raw(_) => panic!("{name}: read as raw"),
                }
            }
            "raw" => match &decoded.body {
                Body::Raw(b) => assert_eq!(b, &unhex(text(case, "payload_hex")), "{name}: payload"),
                Body::Json(_) => panic!("{name}: read as JSON"),
            },
            other => panic!("{name}: unknown kind {other}"),
        }
        let again = frame::encode(&decoded, f).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(again, bytes, "{name}: encode");
    }
}

#[test]
fn every_invalid_frame_is_refused_with_the_documented_code() {
    let doc = load("frames.json");
    let invalid = items(&doc, "invalid");
    assert!(!invalid.is_empty());
    for case in invalid {
        let name = text(case, "name");
        let err = frame::decode(&unhex(text(case, "hex")), flow(case)).expect_err(name);
        assert_eq!(err.code(), text(case, "error"), "{name}");
    }
}

#[test]
fn the_limits_file_matches_the_constants() {
    let doc = load("limits.json");
    let fr = doc.get("frame").expect("frame");
    let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).unwrap_or_else(|| panic!("missing number {k}"));
    assert_eq!(n(fr, "min_rest"), u64::from(frame::MIN_REST));
    assert_eq!(n(fr, "json_helper_to_app"), frame::MAX_JSON_HELPER_TO_APP as u64);
    assert_eq!(n(fr, "json_app_to_helper"), frame::MAX_JSON_APP_TO_HELPER as u64);
    assert_eq!(n(fr, "raw"), frame::MAX_RAW as u64);
    assert_eq!(n(fr, "json_depth"), json::MAX_DEPTH as u64);
    assert_eq!(n(&doc, "hello_line"), hello::MAX_HELLO_LINE as u64);
    assert_eq!(n(&doc, "result_line"), hello::MAX_RESULT_LINE as u64);
    assert_eq!(n(&doc, "error_text_chars"), hello::MAX_ERROR_TEXT_CHARS as u64);
    assert_eq!(n(&doc, "ring_bytes"), DEFAULT_RING_BYTES as u64);
    let states: Vec<&str> = items(&doc, "states").iter().map(|s| s.as_str().expect("state")).collect();
    assert_eq!(states, hello::STATES.to_vec());
}

#[test]
fn hello_lines_read_as_the_fixtures_say() {
    let doc = load("hello.json");
    let nonce = text(&doc, "expected_nonce");
    let sid = text(&doc, "expected_sid");
    for case in items(&doc, "valid") {
        let name = text(case, "name");
        let parsed = hello::parse_hello_line(text(case, "line"), nonce, sid).unwrap_or_else(|e| panic!("{name}: {}", e.why));
        let want = case.get("expect").expect("expect");
        let proto: Vec<u64> = items(want, "proto").iter().map(|v| v.as_u64().expect("proto")).collect();
        assert_eq!(parsed.proto, proto, "{name}: proto");
        assert_eq!(parsed.helper_version, text(want, "helper_version"), "{name}: helper version");
        assert_eq!(parsed.sha256.as_deref(), want.get("sha256").and_then(Value::as_str), "{name}: sha256");
        assert_eq!(parsed.os, text(want, "os"), "{name}: os");
        assert_eq!(parsed.arch, text(want, "arch"), "{name}: arch");
        let caps: Vec<&str> = items(want, "caps").iter().map(|v| v.as_str().expect("cap")).collect();
        assert_eq!(parsed.caps, caps, "{name}: caps");
        assert_eq!(parsed.sid, text(want, "sid"), "{name}: sid");
        assert_eq!(parsed.state, text(want, "state"), "{name}: state");
    }
    for case in items(&doc, "invalid") {
        let name = text(case, "name");
        let err = hello::parse_hello_line(text(case, "line"), nonce, sid).expect_err(name);
        assert_eq!(err.code, text(case, "error"), "{name}");
    }
}

#[test]
fn acks_versions_and_patterns_read_as_the_fixtures_say() {
    let doc = load("hello.json");
    let ack = doc.get("ack").expect("ack");
    for case in items(ack, "valid") {
        let name = text(case, "name");
        let value = json::parse(text(case, "json").as_bytes()).expect("ack JSON");
        let (proto, caps) = hello::parse_ack(&value).unwrap_or_else(|| panic!("{name}: refused"));
        let want = case.get("expect").expect("expect");
        assert_eq!(Some(proto), want.get("proto").and_then(Value::as_u64), "{name}");
        let want_caps: Vec<&str> = items(want, "caps").iter().map(|v| v.as_str().expect("cap")).collect();
        assert_eq!(caps, want_caps, "{name}");
    }
    for case in items(ack, "invalid") {
        let name = text(case, "name");
        let value = json::parse(text(case, "json").as_bytes()).expect("ack JSON");
        assert!(hello::parse_ack(&value).is_none(), "{name}");
    }
    let nums = |v: &Value| -> Vec<u64> { items(v, "app").iter().map(|x| x.as_u64().expect("n")).collect() };
    for case in items(&doc, "proto_choice") {
        let app = nums(case);
        let helper: Vec<u64> = items(case, "helper").iter().map(|x| x.as_u64().expect("n")).collect();
        let chosen = case.get("chosen").and_then(Value::as_u64);
        assert_eq!(hello::choose_proto(&app, &helper), chosen, "{app:?} / {helper:?}");
    }
    let sid = doc.get("sid").expect("sid");
    for s in items(sid, "valid") {
        assert!(hello::valid_sid(s.as_str().expect("s")), "{s:?}");
    }
    for s in items(sid, "invalid") {
        assert!(!hello::valid_sid(s.as_str().expect("s")), "{s:?}");
    }
    let nonce = doc.get("nonce").expect("nonce");
    for s in items(nonce, "valid") {
        assert!(hello::valid_nonce(s.as_str().expect("s")), "{s:?}");
    }
    for s in items(nonce, "invalid") {
        assert!(!hello::valid_nonce(s.as_str().expect("s")), "{s:?}");
    }
}

// ── local.json: the local transport (protocol section 15) ───────────────────

/// A vector tagged `os` applies on that OS only.
fn applies(case: &Value) -> bool {
    match case.get("os").and_then(Value::as_str) {
        None => true,
        Some("unix") => cfg!(unix),
        Some("windows") => cfg!(windows),
        Some(other) => panic!("unknown os tag {other}"),
    }
}

/// A parsed request in the shape of a vector's `expect`.
fn described(req: &Request) -> Value {
    let head = |t: &str, id: u64| vec![("type", Value::str(t)), ("id", Value::uint(id))];
    match req {
        Request::Ping { id } => Value::obj(head("ping", *id)),
        Request::Error => Value::obj(vec![("type", Value::str("error"))]),
        Request::Launch(l) => {
            let mut m = head("term.launch", l.id);
            m.push(("argv", Value::Arr(l.argv.iter().map(|a| Value::Str(a.clone())).collect())));
            m.push(("cwd", Value::Str(l.cwd.clone())));
            m.push(("env", Value::Arr(l.env.iter().map(|(k, v)| Value::Arr(vec![Value::Str(k.clone()), Value::Str(v.clone())])).collect())));
            m.push(("cols", Value::uint(u64::from(l.size.cols))));
            m.push(("rows", Value::uint(u64::from(l.size.rows))));
            // The Windows launch fields `line` and `conpty`, only when given.
            if let Some(line) = &l.line {
                m.push(("line", Value::Str(line.clone())));
            }
            if l.conpty == Conpty::Bundled {
                m.push(("conpty", Value::str("bundled")));
            }
            // The hook kinds the launch declared, only when it declared them.
            if let Some(kinds) = &l.hook_kinds {
                m.push(("hookKinds", Value::Arr(kinds.iter().map(|k| Value::Str(k.clone())).collect())));
            }
            Value::obj(m)
        }
        Request::Attach { id, from } => {
            let mut m = head("term.attach", *id);
            m.push(("from", Value::uint(*from)));
            Value::obj(m)
        }
        Request::Resize { id, size } => {
            let mut m = head("term.resize", *id);
            m.push(("cols", Value::uint(u64::from(size.cols))));
            m.push(("rows", Value::uint(u64::from(size.rows))));
            Value::obj(m)
        }
        Request::Detach { id } => Value::obj(head("term.detach", *id)),
        Request::End { id } => Value::obj(head("term.end", *id)),
        Request::HookEvent { id, kind, payload, .. } => {
            let mut m = head("hook.event", *id);
            m.push(("kind", Value::Str(kind.clone())));
            m.push(("payload", payload.clone()));
            Value::obj(m)
        }
        // Tool stream messages carry no id.
        Request::McpOpen { stream } => Value::obj(vec![("type", Value::str("mcp.open")), ("stream", Value::uint(*stream))]),
        Request::Mcp { stream, message, .. } => Value::obj(vec![("type", Value::str("mcp")), ("stream", Value::uint(*stream)), ("message", message.clone())]),
        Request::McpClose { stream } => Value::obj(vec![("type", Value::str("mcp.close")), ("stream", Value::uint(*stream))]),
        Request::ScreenRead { id } => Value::obj(head("screen.read", *id)),
        Request::ScreenTail { id, count } => {
            let mut m = head("screen.tail", *id);
            m.push(("count", Value::uint(*count as u64)));
            Value::obj(m)
        }
        Request::StatusSet { id, payload, .. } => {
            let mut m = head("status.set", *id);
            m.push(("payload", payload.clone()));
            Value::obj(m)
        }
    }
}

/// A message read on a connection that acked `local` or not, and neither
/// `hooks` nor `mcp`: the app's own ack.
fn local_only(v: &Value, local: bool) -> Result<Request, request::Refusal> {
    request::parse_allowed(v, Allowed { local, hooks: false, mcp: false, screen: false, status: false })
}

// ── local.json `hooks`: hook events (capability `hooks`) ────────────────────

/// What a vector's `acked` says the connection acked; by default core,
/// local and hooks.
fn acked(case: &Value) -> Allowed {
    acked_or(case, Allowed { local: true, hooks: true, mcp: false, screen: false, status: false })
}

/// What a vector's `acked` says the connection acked; `default` when it
/// says nothing.
fn acked_or(case: &Value, default: Allowed) -> Allowed {
    match case.get("acked").and_then(Value::as_array) {
        None => default,
        Some(caps) => {
            let has = |cap: &str| caps.iter().any(|c| c.as_str() == Some(cap));
            Allowed { local: has("local"), hooks: has(serve::HOOKS_CAP), mcp: has(serve::MCP_CAP), screen: has(serve::SCREEN_CAP), status: has(serve::STATUS_CAP) }
        }
    }
}

#[test]
fn hook_events_read_as_the_fixtures_say() {
    let doc = load("local.json");
    let hooks = doc.get("hooks").expect("hooks");
    let requests = hooks.get("requests").expect("requests");
    let mut ran = 0;
    for case in items(requests, "valid") {
        let name = text(case, "name");
        let value = json::parse(text(case, "json").as_bytes()).unwrap_or_else(|e| panic!("{name}: not JSON: {e:?}"));
        let req = request::parse_allowed(&value, acked(case)).unwrap_or_else(|r| panic!("{name}: refused with {}: {}", r.code, r.text));
        assert_eq!(described(&req).to_json(), case.get("expect").expect("expect").to_json(), "{name}");
        ran += 1;
    }
    let mut codes: Vec<&str> = Vec::new();
    for case in items(requests, "invalid") {
        let name = text(case, "name");
        let value = json::parse(text(case, "json").as_bytes()).unwrap_or_else(|e| panic!("{name}: not JSON: {e:?}"));
        let refusal = request::parse_allowed(&value, acked(case)).expect_err(name);
        assert_eq!(refusal.code, text(case, "error"), "{name}: {}", refusal.text);
        codes.push(refusal.code);
        ran += 1;
    }
    assert!(ran >= 15, "only {ran} hook vectors");
    // The cases the protocol names: a kind not of the nine, a payload over
    // 64 KiB, a missing field, and a connection that did not ack hooks.
    for code in [request::CODE_BAD_FIELD, request::CODE_TOO_LARGE, request::CODE_UNKNOWN_TYPE] {
        assert!(codes.contains(&code), "no vector refused with {code}");
    }
    // Without hooks acked a hook event is never read, whatever else was acked.
    let event = json::parse(b"{\"t\":\"hook.event\",\"id\":2,\"kind\":\"Stop\",\"payload\":{}}").expect("JSON");
    assert_eq!(local_only(&event, true).expect_err("a hook event without hooks").code, request::CODE_UNKNOWN_TYPE);
}

#[test]
fn hook_messages_are_the_documented_bytes() {
    let doc = load("local.json");
    let hooks = doc.get("hooks").expect("hooks");
    let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).unwrap_or_else(|| panic!("missing number {k}"));
    for case in items(hooks, "messages") {
        let name = text(case, "name");
        let payload = case.get("payload").expect("payload").clone();
        let bytes = payload.to_json().len();
        let ev = HookEvent { seq: n(case, "seq"), kind: text(case, "kind").to_string(), payload, bytes };
        let message = serve::event_message(&ev, n(case, "lost"));
        assert_eq!(message.to_json(), text(case, "json"), "{name}");
        // What the holder sends, the app reads: under the frame limit.
        assert!(frame::encode(&frame::Frame::json(0, message), Direction::HelperToApp).is_ok(), "{name}");
    }
    let taken = hooks.get("taken").expect("taken");
    assert_eq!(serve::hook_taken(n(taken, "re"), n(taken, "seq")).to_json(), text(taken, "json"));
}

#[test]
fn the_hook_limits_match_the_constants() {
    let doc = load("local.json");
    let hooks = doc.get("hooks").expect("hooks");
    // What a connection that takes hook events acks: the hook mode's ack.
    let caps: Vec<&str> = items(hooks, "caps").iter().map(|c| c.as_str().expect("cap")).collect();
    assert_eq!(caps, hook::ACK_CAPS.to_vec());
    // The app's own ack stays core and local.
    let local: Vec<&str> = items(&doc, "caps").iter().map(|c| c.as_str().expect("cap")).collect();
    assert_eq!(local, hello::LOCAL_CAPS.to_vec());
    let kinds: Vec<&str> = items(hooks, "kinds").iter().map(|c| c.as_str().expect("kind")).collect();
    assert_eq!(kinds, request::HOOK_KINDS.to_vec());
    let l = hooks.get("limits").expect("limits");
    let n = |k: &str| l.get(k).and_then(Value::as_u64).unwrap_or_else(|| panic!("missing number {k}"));
    assert_eq!(n("payload_bytes"), request::MAX_HOOK_PAYLOAD as u64);
    assert_eq!(n("queue_events"), holder::HOOK_QUEUE_EVENTS as u64);
    assert_eq!(n("queue_bytes"), holder::HOOK_QUEUE_BYTES as u64);
    assert_eq!(n("stdin_bytes"), hook::MAX_STDIN as u64);
    assert_eq!(n("cut_over_bytes"), hook::CUT_OVER as u64);
    assert_eq!(n("cut_string_bytes"), hook::MAX_STRING as u64);
    assert_eq!(n("deadline_ms"), hook::DEADLINE.as_millis() as u64);
}

#[test]
fn the_largest_hook_event_fits_a_frame_once_launched() {
    let doc = load("local.json");
    let hooks = doc.get("hooks").expect("hooks");
    let largest = hooks.get("largest").expect("largest");
    let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).unwrap_or_else(|| panic!("missing number {k}"));
    let most = n(hooks.get("limits").expect("limits"), "payload_bytes") as usize;
    let kind = text(largest, "kind");
    assert_eq!(Some(kind), request::HOOK_KINDS.iter().copied().max_by_key(|k| k.len()), "not the longest kind");
    let head = format!("{{\"hook_event_name\":\"{kind}\",\"prompt\":\"");
    let payload_of = |bytes: usize| format!("{head}{}\"}}", "x".repeat(bytes - head.len() - 2));
    let payload = payload_of(most);
    let ev = HookEvent { seq: n(largest, "seq"), kind: kind.to_string(), payload: json::parse(payload.as_bytes()).expect("JSON"), bytes: most };
    let event = serve::event_message(&ev, n(largest, "lost")).to_json();
    assert_eq!(event.len() as u64, n(largest, "event_bytes"));
    assert!(event.len() <= serve::MAX_JSON_AFTER_LAUNCH, "the largest event is {} bytes", event.len());
    // As a hook.event: the most is taken, one byte more is too large.
    let both = Allowed { local: true, hooks: true, mcp: false, screen: false, status: false };
    let message = |p: &str| json::parse(format!("{{\"t\":\"hook.event\",\"id\":2,\"kind\":\"{kind}\",\"payload\":{p}}}").as_bytes()).expect("JSON");
    assert!(request::parse_allowed(&message(&payload), both).is_ok(), "the largest payload is refused");
    let refused = request::parse_allowed(&message(&payload_of(most + 1)), both).expect_err("a payload one byte larger");
    assert_eq!(refused.code, request::CODE_TOO_LARGE);
}

// ── local.json `mcp`: tool streams (capability `mcp`) ───────────────────────

#[test]
fn tool_stream_messages_read_as_the_fixtures_say() {
    let doc = load("local.json");
    let mcp = doc.get("mcp").expect("mcp");
    let requests = mcp.get("requests").expect("requests");
    let relay_ack = Allowed { local: true, hooks: false, mcp: true, screen: false, status: false };
    let mut ran = 0;
    for case in items(requests, "valid") {
        let name = text(case, "name");
        let value = json::parse(text(case, "json").as_bytes()).unwrap_or_else(|e| panic!("{name}: not JSON: {e:?}"));
        let req = request::parse_allowed(&value, acked_or(case, relay_ack)).unwrap_or_else(|r| panic!("{name}: refused with {}: {}", r.code, r.text));
        assert_eq!(described(&req).to_json(), case.get("expect").expect("expect").to_json(), "{name}");
        ran += 1;
    }
    let mut codes: Vec<&str> = Vec::new();
    for case in items(requests, "invalid") {
        let name = text(case, "name");
        let value = json::parse(text(case, "json").as_bytes()).unwrap_or_else(|e| panic!("{name}: not JSON: {e:?}"));
        let refusal = request::parse_allowed(&value, acked_or(case, relay_ack)).expect_err(name);
        assert_eq!(refusal.code, text(case, "error"), "{name}: {}", refusal.text);
        // A tool message has no id, so no refusal of one names it.
        assert_eq!(refusal.re, None, "{name}");
        codes.push(refusal.code);
        ran += 1;
    }
    assert!(ran >= 20, "only {ran} tool stream vectors");
    for code in [request::CODE_BAD_FIELD, request::CODE_UNKNOWN_TYPE] {
        assert!(codes.contains(&code), "no vector refused with {code}");
    }
}

#[test]
fn tool_stream_messages_to_the_app_are_the_documented_bytes() {
    let doc = load("local.json");
    let mcp = doc.get("mcp").expect("mcp");
    for case in items(mcp, "messages") {
        let name = text(case, "name");
        let stream = case.get("stream").and_then(Value::as_u64).expect("stream");
        let message = match text(case, "type") {
            "mcp.open" => serve::mcp_open(stream),
            "mcp.close" => serve::mcp_close(stream),
            "mcp" => serve::mcp_message(stream, case.get("message").expect("message").clone()),
            other => panic!("{name}: unknown type {other}"),
        };
        assert_eq!(message.to_json(), text(case, "json"), "{name}");
        assert!(frame::encode(&frame::Frame::json(0, message), Direction::HelperToApp).is_ok(), "{name}");
    }
}

#[test]
fn the_tool_stream_limits_match_the_constants() {
    let doc = load("local.json");
    let mcp = doc.get("mcp").expect("mcp");
    // The `mcp` part is 2.1.3-beta.10's: what a holder offered then, and what
    // a relay still acks a holder that does not offer `away`. A holder and a
    // relay of now are the `away` part's.
    assert_eq!(strings(mcp, "offered"), serve::HOLDER_CAPS[..4].to_vec());
    assert_eq!(strings(mcp, "relay_caps"), relay::ACK_CAPS[..3].to_vec());
    let l = mcp.get("limits").expect("limits");
    let n = |k: &str| l.get(k).and_then(Value::as_u64).unwrap_or_else(|| panic!("missing number {k}"));
    assert_eq!(n("message_to_app_bytes"), request::MAX_MCP_TO_APP as u64);
    assert_eq!(n("message_to_helper_bytes"), request::MAX_MCP_TO_HELPER as u64);
    assert_eq!(n("streams"), serve::MAX_TOOL_STREAMS as u64);
    assert_eq!(n("ping_secs"), relay::PING_EVERY.as_secs());
    assert_eq!(n("connect_secs"), relay::CONNECT.as_secs());
    assert_eq!(n("line_bytes"), relay::MAX_LINE as u64);
    assert_eq!(n("open_wait_secs"), relay::OPEN_WAIT.as_secs());
    assert_eq!(n("out_queue_bytes"), relay::OUT_QUEUE_BYTES as u64);
    assert_eq!(n("drain_secs"), relay::DRAIN.as_secs());
    // Each limit leaves the 256 bytes the `mcp` around a message needs.
    assert_eq!(request::MAX_MCP_TO_APP + 256, frame::MAX_JSON_HELPER_TO_APP);
    assert_eq!(request::MAX_MCP_TO_HELPER + 256, frame::MAX_JSON_APP_TO_HELPER);
}

// ── local.json `away`: kept tool streams (capability `away`) ────────────────

#[test]
fn kept_tool_stream_vectors_read_as_the_fixtures_say() {
    let doc = load("local.json");
    let away = doc.get("away").expect("away");
    // What a holder offered before screen reads; one of now is the `screen`
    // part's.
    assert_eq!(strings(away, "offered"), serve::HOLDER_CAPS[..5].to_vec());
    assert_eq!(strings(away, "relay_caps"), relay::ACK_CAPS.to_vec());
    let messages = items(away, "messages");
    let types: Vec<&str> = messages.iter().map(|m| text(m, "type")).collect();
    assert_eq!(types, vec!["mcp.away", "mcp.back"]);
    for case in messages {
        let name = text(case, "name");
        let stream = case.get("stream").and_then(Value::as_u64).expect("stream");
        // Exactly `t` and `stream`, as `mcp.open` and `mcp.close` are.
        let message = Value::obj(vec![("t", Value::str(text(case, "type"))), ("stream", Value::uint(stream))]);
        assert_eq!(message.to_json(), text(case, "json"), "{name}");
        // The holder sends these bytes.
        let sent = if text(case, "type") == "mcp.away" { serve::mcp_away(stream) } else { serve::mcp_back(stream) };
        assert_eq!(sent.to_json(), text(case, "json"), "{name}");
        // A relay reads them as section 6's app to helper allows.
        assert!(frame::encode(&frame::Frame::json(0, message), Direction::AppToHelper).is_ok(), "{name}");
    }
    let answers = items(away, "answers");
    assert_eq!(answers.len(), 2);
    for case in answers {
        let name = text(case, "name");
        let call = case.get("call").expect("call");
        let id = call.get("id").expect("an id");
        let answer = relay::updating_answer(id, text(call, "method"));
        assert_eq!(answer.to_json(), text(case, "json"), "{name}");
    }
    let l = away.get("limits").expect("limits");
    let n = |k: &str| l.get(k).and_then(Value::as_u64).unwrap_or_else(|| panic!("missing number {k}"));
    assert_eq!(n("hold_secs"), relay::HOLD.as_secs());
    assert_eq!(n("test_hold_secs"), relay::TEST_HOLD.as_secs());
    assert_eq!(n("held_calls"), relay::MAX_HELD as u64);
    assert_eq!(n("held_bytes"), relay::MAX_HELD_BYTES as u64);
    assert_eq!(n("remembered_calls"), relay::MAX_REMEMBERED as u64);
}

// ── local.json `screen`: screen reads (capability `screen`) ─────────────────

#[test]
fn screen_reads_read_as_the_fixtures_say() {
    let doc = load("local.json");
    let part = doc.get("screen").expect("screen");
    // What a holder offered before the status line; one of now is the
    // `status` part's.
    assert_eq!(strings(part, "offered"), serve::HOLDER_CAPS[..7].to_vec());
    let l = part.get("limits").expect("limits");
    let n = |k: &str| l.get(k).and_then(Value::as_u64).unwrap_or_else(|| panic!("missing number {k}"));
    assert_eq!(n("tail_lines"), request::MAX_TAIL_LINES);
    assert_eq!(n("tail_lines"), screen::TAIL_MAX as u64);
    assert_eq!(n("scrollback_lines"), screen::SCROLLBACK_LINES as u64);
    assert_eq!(n("param_ceiling"), u64::from(screen::PARAM_CEILING));
    assert_eq!(n("title_chars"), screen::TITLE_MAX as u64);
    assert_eq!(n("answer_bytes"), serve::SCREEN_ANSWER_MAX as u64);
    assert_eq!(serve::SCREEN_ANSWER_MAX, frame::MAX_JSON_HELPER_TO_APP);
    let requests = part.get("requests").expect("requests");
    let reader = Allowed { local: false, hooks: false, mcp: false, screen: true, status: false };
    let mut ran = 0;
    for case in items(requests, "valid") {
        let name = text(case, "name");
        let value = json::parse(text(case, "json").as_bytes()).unwrap_or_else(|e| panic!("{name}: not JSON: {e:?}"));
        let req = request::parse_allowed(&value, acked_or(case, reader)).unwrap_or_else(|r| panic!("{name}: refused with {}: {}", r.code, r.text));
        assert_eq!(described(&req).to_json(), case.get("expect").expect("expect").to_json(), "{name}");
        ran += 1;
    }
    for case in items(requests, "invalid") {
        let name = text(case, "name");
        let value = json::parse(text(case, "json").as_bytes()).unwrap_or_else(|e| panic!("{name}: not JSON: {e:?}"));
        let refusal = request::parse_allowed(&value, acked_or(case, reader)).expect_err(name);
        assert_eq!(refusal.code, text(case, "error"), "{name}: {}", refusal.text);
        ran += 1;
    }
    assert!(ran >= 10, "only {ran} screen read vectors");
}

#[test]
fn screen_answers_are_the_documented_bytes() {
    let doc = load("local.json");
    let part = doc.get("screen").expect("screen");
    let messages = items(part, "messages");
    let mut types: Vec<&str> = messages.iter().map(|m| text(m, "type")).collect();
    types.dedup();
    assert_eq!(types, vec!["screen.rows", "screen.lines"]);
    let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).unwrap_or_else(|| panic!("missing number {k}"));
    let mut titled = 0;
    for case in messages {
        let name = text(case, "name");
        // A vector whose `acked` names `screen` and `title` is the answer to
        // a connection that asked for the title; any other, to one that did not.
        let title = acked_asks_title(case);
        titled += usize::from(title);
        // The session's output from its first byte, on a screen of the
        // vector's size, in one piece and a byte at a time.
        for dripped in [false, true] {
            let mut s = Screen::new(PtySize { cols: n(case, "cols") as u16, rows: n(case, "rows") as u16 });
            let feed = text(case, "feed").as_bytes();
            if dripped {
                for b in feed {
                    s.feed(std::slice::from_ref(b));
                }
            } else {
                s.feed(feed);
            }
            let re = n(case, "re");
            let message = match text(case, "type") {
                "screen.rows" => serve::screen_rows_message(re, &s.read(), title),
                _ => serve::screen_lines_message(re, &s.tail(n(case, "count") as usize)),
            };
            assert_eq!(message.to_json(), text(case, "json"), "{name} (a byte at a time: {dripped})");
            assert!(frame::encode(&frame::Frame::json(0, message), Direction::HelperToApp).is_ok(), "{name}");
        }
    }
    assert!(titled >= 2, "only {titled} answers to a connection that asked for the title");
    assert!(items(part, "invalid_messages").len() >= 15);
}

/// True when a vector's `acked` names `screen` and `title`.
fn acked_asks_title(case: &Value) -> bool {
    let caps = case.get("acked").and_then(Value::as_array);
    let has = |cap: &str| caps.map_or(false, |cs| cs.iter().any(|c| c.as_str() == Some(cap)));
    has(serve::SCREEN_CAP) && has(serve::TITLE_CAP)
}

// ── local.json `status`: the status line (capability `status`) and the hook
// kinds a launch declares (`hookKinds`), from 2.1.3-beta.18 ──────────────────

/// The hook kinds a vector's session declared at its launch (`declared`):
/// None when it says null or nothing (the nine).
fn declared(case: &Value) -> Option<Vec<String>> {
    match case.get("declared") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_array().expect("declared is an array").iter().map(|k| k.as_str().expect("a kind").to_string()).collect()),
    }
}

#[test]
fn status_and_hook_kind_vectors_read_as_the_fixtures_say() {
    let doc = load("local.json");
    let part = doc.get("status").expect("status");
    assert_eq!(strings(part, "offered"), serve::HOLDER_CAPS.to_vec());
    assert_eq!(strings(part, "status_caps"), aicc_helper::status::ACK_CAPS.to_vec());
    let env = part.get("env").expect("env");
    assert_eq!((text(env, "store"), text(env, "session")), (hook::STORE_ENV, hook::SESSION_ENV));
    let l = part.get("limits").expect("limits");
    let n = |k: &str| l.get(k).and_then(Value::as_u64).unwrap_or_else(|| panic!("missing number {k}"));
    assert_eq!(n("payload_bytes"), request::MAX_STATUS_PAYLOAD as u64);
    assert_eq!(n("stdin_bytes"), hook::MAX_STDIN as u64);
    assert_eq!(n("deadline_ms"), aicc_helper::status::DEADLINE.as_millis() as u64);
    assert_eq!(n("round_ms"), serve::STATUS_EVERY.as_millis() as u64);
    assert_eq!(n("hook_kinds"), request::MAX_HOOK_KINDS as u64);
    assert_eq!(n("hook_kind_chars"), request::MAX_HOOK_KIND_CHARS as u64);
    // By default a vector is read as a connection that acked core and status.
    let status_ack = Allowed { local: false, hooks: false, mcp: false, screen: false, status: true };
    let requests = part.get("requests").expect("requests");
    let mut ran = 0;
    // A launch vector tagged `os` applies on that OS only (its paths).
    for case in items(requests, "valid").iter().filter(|c| applies(c)) {
        let name = text(case, "name");
        let value = json::parse(text(case, "json").as_bytes()).unwrap_or_else(|e| panic!("{name}: not JSON: {e:?}"));
        let kinds = declared(case);
        let req = request::parse_in_session(&value, acked_or(case, status_ack), kinds.as_deref()).unwrap_or_else(|r| panic!("{name}: refused with {}: {}", r.code, r.text));
        assert_eq!(described(&req).to_json(), case.get("expect").expect("expect").to_json(), "{name}");
        ran += 1;
    }
    let mut codes: Vec<&str> = Vec::new();
    for case in items(requests, "invalid").iter().filter(|c| applies(c)) {
        let name = text(case, "name");
        let value = json::parse(text(case, "json").as_bytes()).unwrap_or_else(|e| panic!("{name}: not JSON: {e:?}"));
        let kinds = declared(case);
        let refusal = request::parse_in_session(&value, acked_or(case, status_ack), kinds.as_deref()).expect_err(name);
        assert_eq!(refusal.code, text(case, "error"), "{name}: {}", refusal.text);
        codes.push(refusal.code);
        ran += 1;
    }
    assert!(ran >= 12, "only {ran} status and hook kind vectors");
    for code in [request::CODE_BAD_FIELD, request::CODE_TOO_LARGE, request::CODE_UNKNOWN_TYPE] {
        assert!(codes.contains(&code), "no vector refused with {code}");
    }
}

#[test]
fn status_messages_are_the_documented_bytes() {
    let doc = load("local.json");
    let part = doc.get("status").expect("status");
    let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).unwrap_or_else(|| panic!("missing number {k}"));
    for case in items(part, "messages") {
        let name = text(case, "name");
        let message = serve::status_message(n(case, "seq"), case.get("payload").expect("payload").clone());
        assert_eq!(message.to_json(), text(case, "json"), "{name}");
        assert!(frame::encode(&frame::Frame::json(0, message), Direction::HelperToApp).is_ok(), "{name}");
    }
    let taken = part.get("taken").expect("taken");
    assert_eq!(serve::status_taken(n(taken, "re"), n(taken, "seq")).to_json(), text(taken, "json"));
    // What the status mode sends for a status, as its vector says.
    let set = part.get("set").expect("set");
    let payload = aicc_helper::status::payload_from(text(set, "stdin").as_bytes()).expect("a status");
    assert_eq!(aicc_helper::status::status_set(payload).to_json(), text(set, "json"));
}

#[test]
fn local_requests_read_as_the_fixtures_say() {
    let doc = load("local.json");
    let requests = doc.get("requests").expect("requests");
    let mut ran = 0;
    for case in items(requests, "valid").iter().filter(|c| applies(c)) {
        let name = text(case, "name");
        let value = json::parse(text(case, "json").as_bytes()).unwrap_or_else(|e| panic!("{name}: not JSON: {e:?}"));
        let req = local_only(&value, true).unwrap_or_else(|r| panic!("{name}: refused with {}: {}", r.code, r.text));
        assert_eq!(described(&req).to_json(), case.get("expect").expect("expect").to_json(), "{name}");
        ran += 1;
    }
    for case in items(requests, "invalid").iter().filter(|c| applies(c)) {
        let name = text(case, "name");
        let value = json::parse(text(case, "json").as_bytes()).unwrap_or_else(|e| panic!("{name}: not JSON: {e:?}"));
        let refusal = local_only(&value, true).expect_err(name);
        assert_eq!(refusal.code, text(case, "error"), "{name}: {}", refusal.text);
        ran += 1;
    }
    assert!(ran >= 25, "only {ran} vectors apply here");
    // Without `local` acked, only the core is allowed.
    let attach = json::parse(b"{\"t\":\"term.attach\",\"id\":2,\"from\":0}").expect("JSON");
    assert_eq!(local_only(&attach, false).expect_err("an attach without local").code, request::CODE_UNKNOWN_TYPE);
}

#[test]
fn the_launch_frame_is_the_documented_bytes() {
    let doc = load("local.json");
    let lf = doc.get("launch_frame").expect("launch_frame");
    let bytes = unhex(text(lf, "hex"));
    let decoded = frame::decode(&bytes, flow(lf)).expect("decodes");
    assert_eq!(decoded.channel, 0);
    let value = match &decoded.body {
        Body::Json(v) => v.clone(),
        Body::Raw(_) => panic!("read as raw"),
    };
    assert_eq!(value.to_json(), text(lf, "payload_text"));
    assert_eq!(frame::encode(&decoded, flow(lf)).expect("encodes"), bytes);
    if cfg!(unix) {
        assert!(matches!(local_only(&value, true), Ok(Request::Launch(_))));
    }
}

#[test]
fn records_and_listings_read_strictly_and_re_encode_to_the_same_bytes() {
    let doc = load("local.json");
    let records = doc.get("records").expect("records");
    for case in items(records, "valid").iter().filter(|c| applies(c)) {
        let name = text(case, "name");
        let v = case.get("record").expect("record");
        let rec = Record::from_value(v).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(rec.to_json(), v.to_json(), "{name}");
    }
    for case in items(records, "invalid").iter().filter(|c| applies(c)) {
        let name = text(case, "name");
        assert!(Record::from_value(case.get("record").expect("record")).is_err(), "{name}");
    }
    let listing = doc.get("listing").expect("listing");
    for case in items(listing, "valid").iter().filter(|c| applies(c)) {
        let name = text(case, "name");
        let line = text(case, "line");
        let l = Listing::from_value(&json::parse(line.as_bytes()).expect("JSON")).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(l.to_json(), line, "{name}");
    }
    for case in items(listing, "invalid").iter().filter(|c| applies(c)) {
        let name = text(case, "name");
        assert!(Listing::from_value(&json::parse(text(case, "line").as_bytes()).expect("JSON")).is_err(), "{name}");
    }
    let fields: Vec<&str> = items(&doc, "record_fields").iter().map(|f| f.as_str().expect("field")).collect();
    let first = items(records, "valid").iter().find(|c| applies(c)).expect("a valid record here");
    let rec = Record::from_value(first.get("record").expect("record")).expect("reads");
    assert_eq!(rec.to_value().keys().expect("an object"), fields);
    let states: Vec<&str> = items(&doc, "child_states").iter().map(|s| s.as_str().expect("state")).collect();
    assert_eq!(states, store::CHILD_STATES.to_vec());
}

#[test]
fn endpoints_have_the_documented_shapes() {
    let doc = load("local.json");
    let ep = doc.get("endpoint").expect("endpoint");
    let sid = text(ep, "sid");
    let here = ep.get(if cfg!(windows) { "windows" } else { "unix" }).expect("this OS");
    for e in items(here, "valid") {
        assert!(transport::valid_endpoint(e.as_str().expect("s"), sid), "{e:?}");
    }
    for e in items(here, "invalid") {
        assert!(!transport::valid_endpoint(e.as_str().expect("s"), sid), "{e:?}");
    }
    // What a holder makes has the same shape.
    let random = "0".repeat(transport::ENDPOINT_RANDOM_HEX);
    assert!(transport::valid_endpoint(&transport::endpoint_name(sid, &random), sid));
}

#[test]
fn the_local_limits_match_the_constants() {
    let doc = load("local.json");
    let caps: Vec<&str> = items(&doc, "caps").iter().map(|c| c.as_str().expect("cap")).collect();
    assert_eq!(caps, hello::LOCAL_CAPS.to_vec());
    let l = doc.get("limits").expect("limits");
    let n = |k: &str| l.get(k).and_then(Value::as_u64).unwrap_or_else(|| panic!("missing number {k}"));
    assert_eq!(n("argv_items"), request::MAX_ARGV_ITEMS as u64);
    assert_eq!(n("arg_chars"), request::MAX_ARG_CHARS as u64);
    assert_eq!(n("cwd_chars"), request::MAX_CWD_CHARS as u64);
    assert_eq!(n("env_entries"), request::MAX_ENV_ENTRIES as u64);
    assert_eq!(n("env_name_chars"), request::MAX_ENV_NAME_CHARS as u64);
    assert_eq!(n("env_value_chars"), request::MAX_ENV_VALUE_CHARS as u64);
    assert_eq!(n("line_units"), request::MAX_LINE_UNITS as u64);
    assert_eq!(n("term_cells"), request::MAX_TERM_CELLS);
    assert_eq!(n("max_safe_integer"), request::MAX_SAFE_INTEGER);
    assert_eq!(n("label_chars"), store::MAX_LABEL_CHARS as u64);
    assert_eq!(n("away_default_secs"), store::DEFAULT_AWAY_SECS);
    assert_eq!(n("away_max_secs"), store::MAX_AWAY_SECS);
    assert_eq!(n("connections"), serve::MAX_CONNECTIONS as u64);
    assert_eq!(n("ack_timeout_secs"), serve::ACK_TIMEOUT.as_secs());
    assert_eq!(n("idle_timeout_secs"), serve::IDLE_TIMEOUT.as_secs());
    assert_eq!(n("write_timeout_secs"), transport::WRITE_TIMEOUT.as_secs());
    assert_eq!(n("refusals_per_minute"), serve::REFUSALS_PER_MINUTE as u64);
    assert_eq!(n("terminal_channel"), u64::from(serve::TERMINAL_CHANNEL));
    let hex = l.get("endpoint_random_hex").expect("endpoint_random_hex");
    let key = if cfg!(windows) { "windows" } else { "unix" };
    assert_eq!(hex.get(key).and_then(Value::as_u64), Some(transport::ENDPOINT_RANDOM_HEX as u64));
}
