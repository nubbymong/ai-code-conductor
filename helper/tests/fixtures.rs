//! The shared message fixtures (helper/fixtures/*.json). The same files are read
//! by tests/unit/scripts/helper-fixtures.test.ts in the app's test suite, so
//! the app and the helper cannot drift apart: a vector that changes must
//! change for both.

use aicc_helper::frame::{self, Body, Direction};
use aicc_helper::hello;
use aicc_helper::json::{self, Value};
use aicc_helper::ring::DEFAULT_RING_BYTES;
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
