//! The hello line, `hello.ack`, version choice and `error` messages
//! (docs/remote/helper-protocol.md sections 6, 7 and 8).
//!
//! The hello is the one line the app reads before any frame:
//!
//! ```text
//! AICC-HELLO <nonce> <json>
//! ```
//!
//! It is at most 4 KiB. A hello with another `sid`, another nonce or a broken
//! schema fails as `no-hello`; unknown hello fields are ignored.

use crate::json::{self, Value};

pub const HELLO_PREFIX: &str = "AICC-HELLO";
pub const RESULT_PREFIX: &str = "AICC-RESULT";
/// A hello line is at most 4 KiB (without its line end).
pub const MAX_HELLO_LINE: usize = 4096;
/// A result line is at most 1 MiB.
pub const MAX_RESULT_LINE: usize = 1024 * 1024;
/// An `error` message's text is at most 512 characters.
pub const MAX_ERROR_TEXT_CHARS: usize = 512;
/// The protocol version this helper speaks.
pub const PROTO_VERSIONS: [u64; 1] = [1];
/// The capabilities of the one-shot `hello` command: the frozen core only.
pub const CAPS: [&str; 1] = ["core"];
/// The capabilities a holder offers on its local pipe or socket: the frozen
/// core, and `local` for the terminal messages of protocol section 15.
pub const LOCAL_CAPS: [&str; 2] = ["core", "local"];

/// What a session can be when the helper answers (section 7).
pub const STATES: [&str; 7] = ["new", "live", "unmanaged", "stale", "orphaned", "elsewhere", "unknown"];

pub const CODE_NO_HELLO: &str = "no-hello";
pub const CODE_PROTO_MISMATCH: &str = "proto-mismatch";

/// `^[0-9a-f]{32}$`: the nonce of one exec, and a device id.
pub fn valid_nonce(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `^[A-Za-z0-9][A-Za-z0-9_-]{7,31}$`: a session id.
pub fn valid_sid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 8 || b.len() > 32 {
        return false;
    }
    if !b[0].is_ascii_alphanumeric() {
        return false;
    }
    b[1..].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
}

/// Sixty-four lower-case hex characters.
pub fn valid_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloError {
    /// The protocol error code: always `no-hello` for a hello that cannot be used.
    pub code: &'static str,
    pub why: String,
}

fn no_hello<T>(why: &str) -> Result<T, HelloError> {
    Err(HelloError { code: CODE_NO_HELLO, why: why.to_string() })
}

/// What the helper says about itself and the session it was asked about.
pub struct Hello<'a> {
    pub nonce: &'a str,
    pub helper_version: &'a str,
    /// Information only (section 7); the app checks the hash itself.
    pub sha256: Option<&'a str>,
    pub os: &'a str,
    pub arch: &'a str,
    pub caps: &'a [&'a str],
    pub sid: &'a str,
    pub state: &'a str,
}

/// The hello line, without its line end.
pub fn hello_line(h: &Hello) -> Result<String, HelloError> {
    if !valid_nonce(h.nonce) {
        return no_hello("the nonce is not 32 lower-case hex characters");
    }
    if !valid_sid(h.sid) {
        return no_hello("the session id breaks its pattern");
    }
    if !STATES.contains(&h.state) {
        return no_hello("unknown session state");
    }
    let mut helper = vec![("version", Value::str(h.helper_version))];
    if let Some(hash) = h.sha256 {
        if !valid_sha256(hash) {
            return no_hello("sha256 is not 64 lower-case hex characters");
        }
        helper.push(("sha256", Value::str(hash)));
    }
    let body = Value::obj(vec![
        ("proto", Value::Arr(PROTO_VERSIONS.iter().map(|v| Value::uint(*v)).collect())),
        ("helper", Value::obj(helper)),
        ("os", Value::str(h.os)),
        ("arch", Value::str(h.arch)),
        ("caps", Value::strs(h.caps)),
        ("session", Value::obj(vec![("sid", Value::str(h.sid)), ("state", Value::str(h.state))])),
    ]);
    let line = format!("{HELLO_PREFIX} {} {}", h.nonce, body.to_json());
    if line.len() > MAX_HELLO_LINE {
        return no_hello("the hello line is over 4 KiB");
    }
    Ok(line)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedHello {
    pub proto: Vec<u64>,
    pub helper_version: String,
    pub sha256: Option<String>,
    pub os: String,
    pub arch: String,
    pub caps: Vec<String>,
    pub sid: String,
    pub state: String,
}

fn short_text(v: Option<&Value>, max: usize) -> Option<String> {
    let s = v?.as_str()?;
    if s.is_empty() || s.chars().count() > max {
        return None;
    }
    Some(s.to_string())
}

/// Read a hello line as the app does: the nonce must be the exec's, the `sid`
/// the one asked for, the schema exact; fields it does not know are ignored.
pub fn parse_hello_line(line: &str, expected_nonce: &str, expected_sid: &str) -> Result<ParsedHello, HelloError> {
    if line.len() > MAX_HELLO_LINE {
        return no_hello("the hello line is over 4 KiB");
    }
    let rest = match line.strip_prefix(HELLO_PREFIX).and_then(|r| r.strip_prefix(' ')) {
        Some(r) => r,
        None => return no_hello("not a hello line"),
    };
    let (nonce, json_text) = match rest.split_once(' ') {
        Some(parts) => parts,
        None => return no_hello("no JSON after the nonce"),
    };
    if nonce != expected_nonce {
        return no_hello("another nonce");
    }
    let value = match json::parse(json_text.as_bytes()) {
        Ok(v) => v,
        Err(_) => return no_hello("the hello JSON does not read"),
    };

    let proto = match value.get("proto").and_then(Value::as_array) {
        Some(items) if !items.is_empty() && items.len() <= 16 => {
            let mut out = Vec::new();
            for item in items {
                match item.as_u64() {
                    Some(n) => out.push(n),
                    None => return no_hello("proto holds a value that is not a version number"),
                }
            }
            out
        }
        _ => return no_hello("proto is missing or empty"),
    };

    let helper = match value.get("helper") {
        Some(h) => h,
        None => return no_hello("helper is missing"),
    };
    let helper_version = match short_text(helper.get("version"), 64) {
        Some(v) => v,
        None => return no_hello("helper.version is missing or too long"),
    };
    let sha256 = match helper.get("sha256") {
        None => None,
        Some(v) => match v.as_str() {
            Some(s) if valid_sha256(s) => Some(s.to_string()),
            _ => return no_hello("helper.sha256 is not 64 lower-case hex characters"),
        },
    };

    let os = match short_text(value.get("os"), 32) {
        Some(v) => v,
        None => return no_hello("os is missing"),
    };
    let arch = match short_text(value.get("arch"), 32) {
        Some(v) => v,
        None => return no_hello("arch is missing"),
    };
    let caps = match value.get("caps").and_then(Value::as_array) {
        Some(items) if items.len() <= 32 => {
            let mut out = Vec::new();
            for item in items {
                match short_text(Some(item), 32) {
                    Some(c) => out.push(c),
                    None => return no_hello("caps holds a value that is not a short string"),
                }
            }
            out
        }
        _ => return no_hello("caps is missing"),
    };

    let session = match value.get("session") {
        Some(s) => s,
        None => return no_hello("session is missing"),
    };
    let sid = match session.get("sid").and_then(Value::as_str) {
        Some(s) if valid_sid(s) => s.to_string(),
        _ => return no_hello("session.sid is missing or breaks its pattern"),
    };
    if sid != expected_sid {
        return no_hello("another session id");
    }
    let state = match session.get("state").and_then(Value::as_str) {
        Some(s) if STATES.contains(&s) => s.to_string(),
        _ => return no_hello("session.state is missing or unknown"),
    };

    Ok(ParsedHello { proto, helper_version, sha256, os, arch, caps, sid, state })
}

/// The highest protocol version both sides speak, or None (`proto-mismatch`).
pub fn choose_proto(app: &[u64], helper: &[u64]) -> Option<u64> {
    app.iter().filter(|v| helper.contains(v)).copied().max()
}

/// The app's answer to a hello: `{t:"hello.ack", proto, caps}`.
pub fn ack_message(proto: u64, caps: &[&str]) -> Value {
    Value::obj(vec![("t", Value::str("hello.ack")), ("proto", Value::uint(proto)), ("caps", Value::strs(caps))])
}

/// Read a `hello.ack`: the chosen version and the capabilities.
pub fn parse_ack(value: &Value) -> Option<(u64, Vec<String>)> {
    if value.get("t").and_then(Value::as_str) != Some("hello.ack") {
        return None;
    }
    let proto = value.get("proto").and_then(Value::as_u64)?;
    let items = value.get("caps").and_then(Value::as_array)?;
    if items.len() > 32 {
        return None;
    }
    let mut caps = Vec::new();
    for item in items {
        caps.push(short_text(Some(item), 32)?);
    }
    Some((proto, caps))
}

/// An `error` message: `{t:"error", re?, code, text}`, text at most 512 characters.
pub fn error_message(re: Option<u64>, code: &str, text: &str) -> Value {
    let mut members = vec![("t", Value::str("error"))];
    if let Some(id) = re {
        members.push(("re", Value::uint(id)));
    }
    members.push(("code", Value::str(code)));
    let cut: String = text.chars().take(MAX_ERROR_TEXT_CHARS).collect();
    members.push(("text", Value::Str(cut)));
    Value::obj(members)
}

/// A one-shot result line: `AICC-RESULT <nonce> <json>`.
pub fn result_line(nonce: &str, body: &Value) -> Result<String, HelloError> {
    if !valid_nonce(nonce) {
        return no_hello("the nonce is not 32 lower-case hex characters");
    }
    let line = format!("{RESULT_PREFIX} {nonce} {}", body.to_json());
    if line.len() > MAX_RESULT_LINE {
        return no_hello("the result line is over 1 MiB");
    }
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    const SID: &str = "sess-0001";

    fn sample() -> Hello<'static> {
        Hello { nonce: NONCE, helper_version: "0.1.0", sha256: None, os: "linux", arch: "x86_64", caps: &CAPS, sid: SID, state: "new" }
    }

    #[test]
    fn a_hello_line_reads_back_as_written() {
        let line = hello_line(&sample()).unwrap();
        assert!(line.starts_with("AICC-HELLO 0123456789abcdef0123456789abcdef {"));
        let parsed = parse_hello_line(&line, NONCE, SID).unwrap();
        assert_eq!(parsed.proto, vec![1]);
        assert_eq!(parsed.sid, SID);
        assert_eq!(parsed.state, "new");
        assert_eq!(parsed.caps, vec!["core".to_string()]);
        assert_eq!(parsed.sha256, None);
    }

    #[test]
    fn another_sid_another_nonce_or_a_broken_schema_is_no_hello() {
        let line = hello_line(&sample()).unwrap();
        assert_eq!(parse_hello_line(&line, NONCE, "sess-0002").unwrap_err().code, CODE_NO_HELLO);
        assert_eq!(parse_hello_line(&line, "ffffffffffffffffffffffffffffffff", SID).unwrap_err().code, CODE_NO_HELLO);
        let broken = line.replace("\"proto\":[1],", "");
        assert_eq!(parse_hello_line(&broken, NONCE, SID).unwrap_err().code, CODE_NO_HELLO);
    }

    #[test]
    fn unknown_hello_fields_are_ignored() {
        let line = format!("AICC-HELLO {NONCE} {{\"proto\":[1],\"helper\":{{\"version\":\"1.0.0\",\"extra\":1}},\"os\":\"macos\",\"arch\":\"aarch64\",\"caps\":[],\"session\":{{\"sid\":\"{SID}\",\"state\":\"live\"}},\"future\":[1,2]}}");
        let parsed = parse_hello_line(&line, NONCE, SID).unwrap();
        assert_eq!(parsed.state, "live");
    }

    #[test]
    fn the_line_limit_and_the_patterns_hold() {
        let long = "v".repeat(5000);
        let mut h = sample();
        h.helper_version = &long;
        assert!(hello_line(&h).is_err());
        assert!(valid_sid("abcdefg1") && valid_sid(&"a".repeat(32)));
        assert!(!valid_sid("abcdefg") && !valid_sid(&"a".repeat(33)) && !valid_sid("-bcdefgh1") && !valid_sid("abcdefg."));
        assert!(valid_nonce(NONCE) && !valid_nonce("0123456789ABCDEF0123456789abcdef") && !valid_nonce("abc"));
    }

    #[test]
    fn the_highest_common_version_wins() {
        assert_eq!(choose_proto(&[1], &[1]), Some(1));
        assert_eq!(choose_proto(&[1, 2], &[1]), Some(1));
        assert_eq!(choose_proto(&[1, 2, 3], &[2, 3]), Some(3));
        assert_eq!(choose_proto(&[2], &[1]), None);
    }

    #[test]
    fn ack_and_error_messages() {
        let ack = ack_message(1, &["core"]);
        assert_eq!(ack.to_json(), "{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\"]}");
        assert_eq!(parse_ack(&ack), Some((1, vec!["core".to_string()])));
        assert_eq!(parse_ack(&Value::obj(vec![("t", Value::str("ping"))])), None);
        let err = error_message(Some(4), "too-large", &"x".repeat(600));
        assert_eq!(err.get("text").and_then(Value::as_str).map(|t| t.chars().count()), Some(512));
        assert_eq!(err.get("re").and_then(Value::as_u64), Some(4));
    }
}
