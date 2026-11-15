//! The probe transport: hold, attach and end through files in a session
//! folder, with nothing but `std`.
//!
//! The real helper will carry attachments over a local socket or named pipe
//! (a later slice, gated on probe P7). Until then the probes (helper/probes/)
//! and the tests need a way to attach to a holder from ANOTHER process, after
//! the process that started it is gone. A folder does that on every OS:
//!
//! ```text
//! <dir>/holder.json   written once the child runs: pids, session id, os
//! <dir>/out.bin       every byte the child wrote, from offset 0 (mirrored while it fits the ring size)
//! <dir>/in.bin        bytes to type into the terminal, appended by `attach --send`
//! <dir>/stop          created by `end`: the holder stops the child and exits
//! <dir>/exit.json     written when the holder is done
//! ```
//!
//! Offsets are offsets into `out.bin`, so `attach --from N` replays from N.
//! It is a probe stand-in, not the protocol: it has no frames, no hello and
//! stops mirroring once `out.bin` reaches the ring size.

use crate::hello::valid_sid;
use crate::holder::{Attachment, Holder};
use crate::json::Value;
use crate::pty::PtySize;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const HOLDER_FILE: &str = "holder.json";
pub const OUT_FILE: &str = "out.bin";
pub const IN_FILE: &str = "in.bin";
pub const STOP_FILE: &str = "stop";
pub const EXIT_FILE: &str = "exit.json";

pub struct HoldOptions {
    pub dir: PathBuf,
    pub sid: String,
    pub argv: Vec<String>,
    pub size: PtySize,
    pub ring_bytes: usize,
}

fn bad_input(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg.to_string())
}

/// Write a file all at once: a reader sees the old file or the whole new one.
fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Mirror an attachment into `out_path`: first what the ring already held when
/// it attached (the child starts before the mirror attaches, so a banner
/// printed in that window sits in the replay, not in the live stream), then
/// every live chunk, until `cap` bytes are written.
pub fn start_mirror(attachment: Attachment, out_path: &Path, cap: u64) -> io::Result<thread::JoinHandle<()>> {
    let mut file = OpenOptions::new().append(true).create(true).open(out_path)?;
    let mut total = 0u64;
    if !attachment.replay.bytes.is_empty() {
        file.write_all(&attachment.replay.bytes)?;
        file.flush()?;
        total = attachment.replay.bytes.len() as u64;
    }
    let live = attachment.live;
    Ok(thread::spawn(move || {
        while let Ok(chunk) = live.recv() {
            if total + chunk.len() as u64 > cap {
                break;
            }
            if file.write_all(&chunk).is_err() || file.flush().is_err() {
                break;
            }
            total += chunk.len() as u64;
        }
    }))
}

/// Hold `argv` on a terminal, in this process, until it exits or `end` is run.
/// Returns the exit code of the holder itself (0 when it did its job).
pub fn run_hold(opts: HoldOptions) -> io::Result<i32> {
    if !valid_sid(&opts.sid) {
        return Err(bad_input("the session id breaks its pattern"));
    }
    fs::create_dir_all(&opts.dir)?;
    File::create(opts.dir.join(OUT_FILE))?;
    File::create(opts.dir.join(IN_FILE))?;
    let _ = fs::remove_file(opts.dir.join(STOP_FILE));
    let _ = fs::remove_file(opts.dir.join(EXIT_FILE));
    let _ = fs::remove_file(opts.dir.join(HOLDER_FILE));

    let holder = Holder::start(&opts.argv, opts.size, opts.ring_bytes)?;

    let info = Value::obj(vec![
        ("session", Value::str(&opts.sid)),
        ("holder_pid", Value::uint(std::process::id() as u64)),
        ("child_pid", Value::uint(holder.child_pid() as u64)),
        ("os", Value::str(std::env::consts::OS)),
        ("arch", Value::str(std::env::consts::ARCH)),
        ("started_unix", Value::uint(now_secs())),
    ]);
    write_atomic(&opts.dir.join(HOLDER_FILE), &info.to_json())?;

    // The mirror is the terminal slot's one client: it appends every byte to out.bin.
    let attachment = holder.attach(0).map_err(|_| bad_input("the ring is not empty at start"))?;
    let mirror = start_mirror(attachment, &opts.dir.join(OUT_FILE), opts.ring_bytes as u64)?;

    let in_path = opts.dir.join(IN_FILE);
    let stop_path = opts.dir.join(STOP_FILE);
    let mut in_offset = 0u64;
    let reason;
    loop {
        if let Ok(mut f) = File::open(&in_path) {
            if f.seek(SeekFrom::Start(in_offset)).is_ok() {
                let mut fresh = Vec::new();
                if f.read_to_end(&mut fresh).is_ok() && !fresh.is_empty() {
                    in_offset += fresh.len() as u64;
                    let _ = holder.write_input(&fresh);
                }
            }
        }
        if stop_path.exists() {
            holder.kill();
            reason = "stopped";
            break;
        }
        if holder.exit_code().is_some() {
            reason = "exited";
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let code = holder.wait_exit(Duration::from_secs(3)).unwrap_or(-1);
    // Let the mirror write the last output before the holder goes.
    thread::sleep(Duration::from_millis(300));
    let done = Value::obj(vec![("code", Value::Num(code.to_string())), ("reason", Value::str(reason))]);
    write_atomic(&opts.dir.join(EXIT_FILE), &done.to_json())?;
    drop(holder);
    // Not joined: the mirror ends with the output, and on Windows that end comes
    // only when the pseudoconsole closes, which the process exit also does.
    drop(mirror);
    Ok(0)
}

/// What an attach saw.
pub struct AttachReport {
    pub ring_start: u64,
    pub ring_end: u64,
    pub replay: Vec<u8>,
    pub live: Vec<u8>,
    pub exited: bool,
}

impl AttachReport {
    pub fn to_value(&self) -> Value {
        Value::obj(vec![
            ("ring_start", Value::uint(self.ring_start)),
            ("ring_end", Value::uint(self.ring_end)),
            ("truncated", Value::Bool(false)),
            ("replayed_bytes", Value::uint(self.replay.len() as u64)),
            ("replay", Value::Str(String::from_utf8_lossy(&self.replay).into_owned())),
            ("live", Value::Str(String::from_utf8_lossy(&self.live).into_owned())),
            ("exited", Value::Bool(self.exited)),
        ])
    }
}

fn read_out(dir: &Path) -> io::Result<Vec<u8>> {
    fs::read(dir.join(OUT_FILE))
}

/// Replay `out.bin` from `from`, optionally type `send` (plus Enter) into the
/// terminal, and collect what arrives for up to `wait_ms`.
pub fn run_attach(dir: &Path, from: u64, send: Option<&str>, wait_ms: u64) -> io::Result<AttachReport> {
    let first = read_out(dir)?;
    let first_len = first.len() as u64;
    if from > first_len {
        return Err(bad_input("the offset is past the end of the output"));
    }
    let replay = first[from as usize..].to_vec();

    if let Some(text) = send {
        let mut f = OpenOptions::new().append(true).create(true).open(dir.join(IN_FILE))?;
        f.write_all(text.as_bytes())?;
        f.write_all(b"\r")?;
        f.flush()?;
    }

    let mut seen = first_len;
    let mut last_growth = Instant::now();
    let deadline = Instant::now() + Duration::from_millis(wait_ms);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
        let len = fs::metadata(dir.join(OUT_FILE)).map(|m| m.len()).unwrap_or(seen);
        if len > seen {
            seen = len;
            last_growth = Instant::now();
        } else if seen > first_len && last_growth.elapsed() > Duration::from_millis(300) {
            break;
        }
    }
    let all = read_out(dir)?;
    let end = all.len() as u64;
    let live = if end > first_len { all[first_len as usize..].to_vec() } else { Vec::new() };
    Ok(AttachReport { ring_start: 0, ring_end: end, replay, live, exited: dir.join(EXIT_FILE).exists() })
}

/// Ask the holder to stop its child and exit; true once it has said it is done.
pub fn run_end(dir: &Path) -> io::Result<bool> {
    if dir.join(EXIT_FILE).exists() {
        return Ok(true);
    }
    File::create(dir.join(STOP_FILE))?;
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if dir.join(EXIT_FILE).exists() {
            return Ok(true);
        }
        thread::sleep(Duration::from_millis(50));
    }
    Ok(false)
}
