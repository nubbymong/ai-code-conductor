//! The self-test (protocol section 13: a self-test of the codec, the ring and a
//! terminal round trip, run after install and before the first session).
//!
//! It prints one `AICC-RESULT <nonce> <json>` line; the exit status is 0 only
//! when every check passed.

use crate::frame::{self, Direction, Frame};
use crate::hello::{self, Hello, CAPS};
use crate::holder::Holder;
use crate::json::Value;
use crate::pty::PtySize;
use crate::ring::Ring;
use std::io::{Read, Write};
use std::path::Path;
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

/// A terminal round trip: run this program's own `__echo` child on a terminal,
/// type into it, see the echo, detach, attach again and be replayed.
fn terminal_round_trip(exe: &Path) -> Result<(), String> {
    let argv = vec![exe.to_string_lossy().into_owned(), "__echo".to_string()];
    let holder = Holder::start(&argv, PtySize::default(), 64 * 1024).map_err(|e| format!("could not start a terminal: {e}"))?;
    let result = (|| -> Result<(), String> {
        holder.write_input(b"selftest-ping\r").map_err(|e| format!("could not write to the terminal: {e}"))?;
        if !holder.wait_for_text("selftest-ping", Duration::from_secs(15)) {
            return Err("the typed text never came back from the terminal".to_string());
        }
        holder.detach();
        let attachment = holder.attach(0).map_err(|_| "attach from offset 0 failed".to_string())?;
        if !String::from_utf8_lossy(&attachment.replay.bytes).contains("selftest-ping") {
            return Err("attaching again did not replay the earlier output".to_string());
        }
        Ok(())
    })();
    holder.kill();
    result
}

pub fn run(exe: &Path) -> Vec<Check> {
    vec![
        check("frame-codec", frame_round_trip()),
        check("hello", hello_round_trip()),
        check("ring", ring_offsets()),
        check("terminal-hold-attach", terminal_round_trip(exe)),
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

/// The child the terminal round trip runs: copies its input to its output.
pub fn echo_child() -> std::io::Result<()> {
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    let mut buf = [0u8; 1024];
    loop {
        let n = stdin.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        stdout.write_all(&buf[..n])?;
        stdout.flush()?;
    }
}
