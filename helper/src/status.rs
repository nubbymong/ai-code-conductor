//! `aicc-helper status --store <folder> --session <sid>`: one status line
//! update of a session, passed to the session's holder (protocol section 15,
//! capability `status`, from 2.1.3-beta.18). Either option may be left out
//! and is then read from the environment, as the hook mode reads it:
//! `AICC_HELPER_STORE`, `AICC_HELPER_SESSION` (`hook::parse_args_or_env`).
//!
//! A CLI runs it as its status line command and writes the status as JSON on
//! its standard input (Claude Code's `statusLine`). The status mode reads that
//! to the end, keeping at most 4 MiB as the hook mode does; takes it only when
//! it is one JSON object, at most 31 levels deep (the message carrying it is
//! then at most 32), that names none of its own members twice, and of at most
//! 65,280 bytes as compact JSON (`request::MAX_STATUS_PAYLOAD`); an escaped
//! lone surrogate reads as U+FFFD, as in the hook mode. A payload that breaks
//! any of that is not sent (nothing is cut: a status line is small). It then
//! reads the session's record with the store's strict reader, connects to the
//! holder with the helper's own client (the endpoint's checks, then the
//! hello's nonce and session), acks `core` and `status`, sends one
//! `status.set` and waits for its reply. All of it within 2 s.
//!
//! It always exits 0 and never writes to standard output or standard error:
//! what a status line command prints is the CLI's status line, and the app
//! shows the status itself. Whatever fails loses that one update, silently;
//! the next one carries the whole status again. A holder whose hello does not
//! offer `status` (one from before 2.1.3-beta.18) is sent nothing, not even
//! the ack. The status mode writes no file and starts no process.

use crate::client::Client;
use crate::frame::Body;
use crate::hello;
use crate::hook::{self, from_env, left, mend_surrogates, parse_args_or_env, read_stdin, MAX_PAYLOAD_DEPTH};
use crate::json::{self, Value};
use crate::request::{repeats_a_name, MAX_STATUS_PAYLOAD};
use crate::serve::STATUS_CAP;
use crate::store;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Everything, from the start to the holder's reply, within this: the hook
/// mode's 2 s.
pub const DEADLINE: Duration = hook::DEADLINE;
/// The id of the one `status.set` (app ids are even).
const SET_ID: u64 = 2;
/// What the status mode acks: the frozen core and `status`, and never more,
/// whatever else a holder offers (`serve::HOLDER_CAPS`). Without `local` it
/// posts and is sent no status itself.
pub const ACK_CAPS: [&str; 2] = ["core", STATUS_CAP];

/// Run the status mode on `args` (what follows `status`). It returns by the
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

/// The work; None wherever it stops, and the update is lost.
fn deliver(args: &[String], deadline: Instant) -> Option<()> {
    let (store_dir, sid) = parse_args_or_env(args, from_env)?;
    let input = read_stdin()?;
    let payload = payload_from(&input)?;
    let rec = store::read(&store_dir, &sid)?.ok()?;
    let mut client = Client::to_record(&rec, left(deadline)?).ok()?;
    if !client.hello.caps.iter().any(|c| c.as_str() == STATUS_CAP) {
        return None;
    }
    client.send(hello::ack_message(1, &ACK_CAPS)).ok()?;
    client.send(status_set(payload)).ok()?;
    loop {
        match client.recv(left(deadline)?) {
            Ok(Some(f)) => {
                // `status.taken`, or an `error` about this update: done
                // either way. The holder sends this connection no status:
                // its ack names no `local`.
                if let Body::Json(v) = &f.body {
                    if f.channel == 0 && v.get("re").and_then(Value::as_u64) == Some(SET_ID) {
                        return Some(());
                    }
                }
            }
            Ok(None) | Err(_) => return None,
        }
    }
}

/// The status to send. None when the input is not one JSON object of at
/// most 31 levels, names one of its own members twice (json.rs finds the
/// first, the app's JSON.parse the last), or is over `MAX_STATUS_PAYLOAD`
/// bytes as compact JSON. An escaped lone surrogate reads as U+FFFD.
pub fn payload_from(input: &[u8]) -> Option<Value> {
    let payload = json::parse(&mend_surrogates(input)).ok()?;
    if !matches!(payload, Value::Obj(_)) || repeats_a_name(&payload) || !payload.fits_depth(MAX_PAYLOAD_DEPTH) {
        return None;
    }
    if payload.to_json().len() > MAX_STATUS_PAYLOAD {
        return None;
    }
    Some(payload)
}

/// The `status.set` message for one status.
pub fn status_set(payload: Value) -> Value {
    Value::obj(vec![("t", Value::str("status.set")), ("id", Value::uint(SET_ID)), ("payload", payload)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{self, Direction, Frame};
    use crate::request::{self, Allowed, Request};
    use crate::serve::MAX_JSON_AFTER_LAUNCH;

    #[test]
    fn only_one_json_object_within_the_bounds_is_a_status() {
        let line = "{\"model\":{\"id\":\"claude-x\",\"display_name\":\"X\"},\"cwd\":\"/home/u/p\",\"cost\":{\"total_cost_usd\":0.25}}";
        assert_eq!(payload_from(line.as_bytes()).map(|p| p.to_json()), Some(line.to_string()));
        // Pretty-printed is one too; it is measured, and sent, compact.
        assert_eq!(payload_from(b"{\n  \"a\": 1\n}\n").map(|p| p.to_json()), Some("{\"a\":1}".to_string()));
        assert_eq!(payload_from(b"{}").map(|p| p.to_json()), Some("{}".to_string()));
        let deep = format!("{{\"x\":{}{}}}", "[".repeat(31), "]".repeat(31));
        for bad in ["", "not json", "[1]", "\"x\"", "1", "null", "{\"a\":1} trailing", "{\"a\":1}{\"b\":2}", "{\"cwd\":\"/a\",\"cwd\":\"/b\"}", deep.as_str()] {
            assert!(payload_from(bad.as_bytes()).is_none(), "{bad:?}");
        }
        // 30 levels inside it (31 with it) is the most.
        let deepest = format!("{{\"x\":{}{}}}", "[".repeat(30), "]".repeat(30));
        assert!(payload_from(deepest.as_bytes()).is_some());
        // A name repeated further in is the CLI's own: kept as it came.
        assert!(payload_from(b"{\"model\":{\"a\":1,\"a\":2}}").is_some());
        // An escaped lone surrogate reads as the replacement character.
        let p = payload_from(br#"{"cwd":"cut mid-emoji \ud83d"}"#).expect("a status");
        assert_eq!(p.get("cwd").and_then(Value::as_str), Some("cut mid-emoji \u{fffd}"));
    }

    /// A status payload exactly `bytes` long as compact JSON.
    fn of_size(bytes: usize) -> String {
        let head = "{\"model\":{\"id\":\"m\"},\"pad\":\"";
        let payload = format!("{head}{}\"}}", "x".repeat(bytes - head.len() - 2));
        assert_eq!(payload.len(), bytes);
        payload
    }

    #[test]
    fn a_status_over_64_kib_less_256_as_json_is_not_sent_and_the_largest_fits_the_holder_once_launched() {
        let most = payload_from(of_size(MAX_STATUS_PAYLOAD).as_bytes()).expect("the largest status");
        assert!(payload_from(of_size(MAX_STATUS_PAYLOAD + 1).as_bytes()).is_none());
        // Pretty-printed to more than the bound, compact within it: sent.
        let spaced = of_size(MAX_STATUS_PAYLOAD).replacen(":", ": ", 3);
        assert!(spaced.len() > MAX_STATUS_PAYLOAD && payload_from(spaced.as_bytes()).is_some());
        // The largest status.set fits the 64 KiB a frame holds once the
        // session is launched, and the holder takes it.
        let message = status_set(most);
        let bytes = frame::encode(&Frame::json(0, message.clone()), Direction::AppToHelper).expect("the message encodes");
        assert!(bytes.len() - 9 <= MAX_JSON_AFTER_LAUNCH, "the largest status.set is {} bytes", bytes.len() - 9);
        let allowed = Allowed { local: false, hooks: false, mcp: false, screen: false, status: true };
        assert!(matches!(request::parse_allowed(&message, allowed), Ok(Request::StatusSet { bytes: MAX_STATUS_PAYLOAD, .. })));
    }

    #[test]
    fn the_message_and_the_ack_are_the_documented_ones() {
        assert_eq!(status_set(Value::obj(vec![("a", Value::uint(1))])).to_json(), "{\"t\":\"status.set\",\"id\":2,\"payload\":{\"a\":1}}");
        assert_eq!(ACK_CAPS, ["core", "status"]);
        assert_eq!(DEADLINE, Duration::from_secs(2));
    }
}
