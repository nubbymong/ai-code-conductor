//! The self-test (protocol section 13: a self-test of the codec, the ring and a
//! terminal round trip, run after install and before the first session; and,
//! from section 15, a round trip over the local pipe or socket).
//!
//! It prints one `AICC-RESULT <nonce> <json>` line; the exit status is 0 only
//! when every check passed.

use crate::client::Client;
use crate::frame::{self, Body, Direction, Frame};
use crate::hello::{self, Hello, CAPS, LOCAL_CAPS};
use crate::holder::Holder;
use crate::json::Value;
use crate::pty::PtySize;
use crate::ring::Ring;
use crate::transport::Listener;
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::{mpsc, Arc};
use std::time::Duration;

pub struct Check {
    pub name: &'static str,
    pub ok: bool,
    pub detail: String,
}

fn check(name: &'static str, result: Result<(), String>) -> Check {
    match result {
        Ok(()) => Check { name, ok: true, detail: String::new() },
        Err(detail) => Check { name, ok: false, detail },
    }
}

fn frame_round_trip() -> Result<(), String> {
    for flow in [Direction::AppToHelper, Direction::HelperToApp] {
        let f = Frame::json(0, Value::obj(vec![("t", Value::str("ping")), ("id", Value::uint(2))]));
        let bytes = frame::encode(&f, flow).map_err(|e| e.to_string())?;
        let back = frame::decode(&bytes, flow).map_err(|e| e.to_string())?;
        if back != f {
            return Err("a JSON frame did not read back as written".to_string());
        }
        let raw = Frame::raw(7, vec![0, 1, 2, 255]);
        let bytes = frame::encode(&raw, flow).map_err(|e| e.to_string())?;
        if frame::decode(&bytes, flow).map_err(|e| e.to_string())? != raw {
            return Err("a raw frame did not read back as written".to_string());
        }
    }
    // An oversize length is refused on the four length bytes alone.
    let over = ((frame::MIN_REST as usize + frame::MAX_JSON_HELPER_TO_APP + 1) as u32).to_be_bytes();
    match frame::decode(&over, Direction::HelperToApp) {
        Err(e) if e.code() == frame::CODE_BAD_FRAME => Ok(()),
        _ => Err("an oversize length was not refused as bad-frame".to_string()),
    }
}

fn hello_round_trip() -> Result<(), String> {
    let nonce = "0123456789abcdef0123456789abcdef";
    let sid = "selftest-0001";
    let h = Hello {
        nonce,
        helper_version: env!("CARGO_PKG_VERSION"),
        sha256: None,
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        caps: &CAPS,
        sid,
        state: "new",
    };
    let line = hello::hello_line(&h).map_err(|e| e.why)?;
    let parsed = hello::parse_hello_line(&line, nonce, sid).map_err(|e| e.why)?;
    if parsed.proto != hello::PROTO_VERSIONS.to_vec() || parsed.state != "new" {
        return Err("the hello did not read back as written".to_string());
    }
    Ok(())
}

fn ring_offsets() -> Result<(), String> {
    let mut ring = Ring::new(4);
    ring.push(b"abcdef");
    let replay = ring.replay_from(0).map_err(|_| "replay failed".to_string())?;
    if !replay.truncated || replay.bytes != b"cdef" || replay.ring_start != 2 || replay.ring_end != 6 {
        return Err("the ring did not keep the last four bytes at offsets 2 to 6".to_string());
    }
    Ok(())
}

/// What the `__echo` child prints before each line it answers.
const REPLY_MARKER: &str = "aicc-selftest-reply:";

/// The reply the child gives to the text the round trip types.
fn expected_reply() -> String {
    format!("{REPLY_MARKER}selftest-ping")
}

/// True when `text` holds the child's reply (not merely the typed text).
fn reply_seen(text: &str) -> bool {
    text.contains(&expected_reply())
}

/// A terminal round trip: run this program's own `__echo` child on a terminal,
/// type into it, see the child's reply, detach, attach again and be replayed.
fn terminal_round_trip(exe: &Path) -> Result<(), String> {
    let argv = vec![exe.to_string_lossy().into_owned(), "__echo".to_string()];
    let holder = Holder::start(&argv, PtySize::default(), 64 * 1024).map_err(|e| format!("could not start a terminal: {e}"))?;
    let result = (|| -> Result<(), String> {
        holder.write_input(b"selftest-ping\r").map_err(|e| format!("could not write to the terminal: {e}"))?;
        // The child's own reply, not the terminal's echo of the typed text.
        if !holder.wait_for_text(&expected_reply(), Duration::from_secs(15)) {
            return Err("the child's reply never came back from the terminal".to_string());
        }
        holder.detach();
        let attachment = holder.attach(0).map_err(|_| "attach from offset 0 failed".to_string())?;
        if !reply_seen(&String::from_utf8_lossy(&attachment.replay.bytes)) {
            return Err("attaching again did not replay the earlier output".to_string());
        }
        Ok(())
    })();
    end_terminal(&holder);
    result
}

/// How the terminal round trip ends its terminal before the self-test moves
/// on: the child and its tree are stopped, and the terminal is closed (on
/// Windows, `ClosePseudoConsole`, which ends the terminal's host). It returns
/// once that is done, or after a few seconds at most (aicc_planning#317).
/// A kill alone left the closing to the holder's watch thread, which the
/// self-test often exited before; on Windows the host could then outlive it.
pub fn end_terminal(holder: &Holder) {
    let _ = holder.end();
}

/// The listening side of the transport round trip: one connection, a hello,
/// one ping answered with a pong.
fn answer_one(listener: &Listener, nonce: &str, sid: &str) -> Result<(), String> {
    let mut s = listener.accept().map_err(|e| format!("accept failed: {e}"))?;
    let line = hello::hello_line(&Hello {
        nonce,
        helper_version: env!("CARGO_PKG_VERSION"),
        sha256: None,
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        caps: &LOCAL_CAPS,
        sid,
        state: "new",
    })
    .map_err(|e| e.why)?;
    s.write_all(format!("{line}\n").as_bytes()).map_err(|e| format!("could not write the hello: {e}"))?;
    s.set_read_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
    let f = frame::read_frame(&mut s, Direction::AppToHelper).map_err(|e| e.to_string())?.ok_or("the client closed before its ping")?;
    let id = match &f.body {
        Body::Json(v) if v.get("t").and_then(Value::as_str) == Some("ping") => v.get("id").and_then(Value::as_u64).ok_or("the ping has no id")?,
        _ => return Err("the first frame was not a ping".to_string()),
    };
    let pong = Frame::json(0, Value::obj(vec![("t", Value::str("pong")), ("re", Value::uint(id))]));
    let bytes = frame::encode(&pong, Direction::HelperToApp).map_err(|e| e.to_string())?;
    s.write_all(&bytes).map_err(|e| format!("could not write the pong: {e}"))?;
    // Closing before the client has read the pong could cut it off.
    s.wait_peer_close(Duration::from_secs(5));
    Ok(())
}

/// A round trip over the local transport: listen on a private endpoint
/// (checked: user only), connect to it, read the hello, ping and be answered.
fn transport_round_trip() -> Result<(), String> {
    let sid = "selftest-0001";
    let listener = Arc::new(Listener::bind(sid).map_err(|e| format!("could not listen: {e}"))?);
    let result = (|| -> Result<(), String> {
        listener.check_private()?;
        let nonce = crate::random::hex(16).map_err(|e| e.to_string())?;
        let (done_tx, done_rx) = mpsc::channel();
        let server = Arc::clone(&listener);
        let server_nonce = nonce.clone();
        std::thread::spawn(move || {
            let _ = done_tx.send(answer_one(&server, &server_nonce, sid));
        });
        let mut c = Client::connect(listener.endpoint(), &nonce, sid, Duration::from_secs(10)).map_err(|e| format!("could not connect: {e}"))?;
        c.send(Value::obj(vec![("t", Value::str("ping")), ("id", Value::uint(2))])).map_err(|e| e.to_string())?;
        let answer = c.recv(Duration::from_secs(10)).map_err(|e| format!("no answer: {e}"))?;
        let pong = matches!(&answer, Some(Frame { body: Body::Json(v), .. })
            if v.get("t").and_then(Value::as_str) == Some("pong") && v.get("re").and_then(Value::as_u64) == Some(2));
        if !pong {
            return Err("the answer was not the pong".to_string());
        }
        // Closing tells the listening side the pong was read.
        drop(c);
        // The listening side reports too; it is not waited for without limit.
        done_rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "the listening side did not finish".to_string())?
    })();
    listener.remove();
    result
}

pub fn run(exe: &Path) -> Vec<Check> {
    vec![
        check("frame-codec", frame_round_trip()),
        check("hello", hello_round_trip()),
        check("ring", ring_offsets()),
        check("terminal-hold-attach", terminal_round_trip(exe)),
        check("local-transport", transport_round_trip()),
    ]
}

/// The result as the `AICC-RESULT` body.
pub fn report(checks: &[Check]) -> Value {
    let ok = checks.iter().all(|c| c.ok);
    let items: Vec<Value> = checks
        .iter()
        .map(|c| {
            let mut members = vec![("name", Value::str(c.name)), ("ok", Value::Bool(c.ok))];
            if !c.detail.is_empty() {
                members.push(("detail", Value::str(&c.detail)));
            }
            Value::obj(members)
        })
        .collect();
    Value::obj(vec![
        ("ok", Value::Bool(ok)),
        ("helper", Value::str(env!("CARGO_PKG_VERSION"))),
        ("os", Value::str(std::env::consts::OS)),
        ("arch", Value::str(std::env::consts::ARCH)),
        ("checks", Value::Arr(items)),
    ])
}

/// The child the terminal round trip runs: answers each line it is given with
/// `REPLY_MARKER` and the line. The marker is its own text, so it never appears
/// just because the terminal echoes what was typed (a Unix terminal does).
pub fn echo_child() -> std::io::Result<()> {
    serve(std::io::stdin().lock(), std::io::stdout().lock())
}

fn serve<R: BufRead, W: Write>(mut input: R, mut output: W) -> std::io::Result<()> {
    let mut line = String::new();
    loop {
        line.clear();
        if input.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let text = line.trim_end_matches(|c| c == '\r' || c == '\n');
        write!(output, "{REPLY_MARKER}{text}\r\n")?;
        output.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_child_answers_each_line_with_its_own_marker() {
        let mut out = Vec::new();
        serve(std::io::Cursor::new(b"selftest-ping\r\nnext\n".to_vec()), &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text, "aicc-selftest-reply:selftest-ping\r\naicc-selftest-reply:next\r\n");
        assert!(reply_seen(&text));
    }

    #[test]
    fn a_child_that_never_answers_fails_even_when_the_terminal_echoes() {
        // What a Unix terminal shows with a child that reads and writes nothing.
        assert!(!reply_seen("selftest-ping\r\n"));
        assert!(!reply_seen(""));
        // A different reply does not count either.
        assert!(!reply_seen("aicc-selftest-reply:other\r\n"));
    }
}
