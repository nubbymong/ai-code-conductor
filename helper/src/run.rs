//! `aicc-helper run --timeout <seconds>` (macOS and Linux, from
//! 2.1.3-beta.21): the one-shot run mode (ADR-030 protocol change 6). The app
//! starts one program on a machine through it, in one `ssh -T` exec, and reads
//! what the program prints: a review on the machine a remote session runs on
//! (nubbymong/aicc_planning#446) is its first use.
//!
//! What it reads, on standard input: one line of JSON, the spec, at most
//! `MAX_SPEC_BYTES`, then everything up to the end of standard input, at most
//! `MAX_INPUT_BYTES`, which is the program's own standard input (a review's
//! prompt). The spec has exactly three fields:
//!
//! ```text
//! {"argv":["/abs/program","arg",...],"cwd":"/abs/folder","env":{"NAME":"value",...}}
//! ```
//!
//! The spec comes on standard input, never on the command line: the program's
//! path and the folder are values the machine reported (protocol section 4).
//!
//! How it runs the program:
//! - Only `argv`, with no shell: `argv[0]` is an absolute path to a file, run
//!   as it is (no `PATH` lookup), with the rest as its arguments, each exactly
//!   as given. A spec that is not this shape starts nothing.
//! - In `cwd`, an absolute path to a folder.
//! - With `env` alone: nothing of this process's own environment reaches it.
//! - In a process group of its own. When the run ends for any reason, the
//!   whole group is ended: a hangup of the exec (standard output closed), the
//!   timeout, or output past `MAX_OUTPUT_BYTES` first get a terminate signal
//!   and `GRACE` to go, then a kill; a program that exits by itself has what it
//!   left in its group killed. Each signal goes before the program is reaped,
//!   so its id still names its group then.
//! - Its standard output is copied to this mode's, byte for byte, up to
//!   `MAX_OUTPUT_BYTES`; its standard error to this mode's, up to
//!   `MAX_ERROR_BYTES` (the rest is read and dropped).
//! - `--timeout` is the run's own limit, 1 to `MAX_TIMEOUT_SECS` seconds (a
//!   review's own timeout: 300 s by default, at most 900 s). The app's exec
//!   gives it 30 s more (docs/remote/helper-protocol.md section 10).
//!
//! Exit statuses: `EXIT_OK` (0) the program exited 0; `EXIT_PROGRAM_FAILED`
//! (1) it exited with another code or was ended by a signal; `EXIT_USAGE` (2)
//! a command line or a spec it does not take (nothing started); `EXIT_NOT_STARTED`
//! (3) the program or the folder is not there, or it could not be started;
//! `EXIT_TIMED_OUT` (4); `EXIT_OUTPUT_CAP` (5); `EXIT_CLOSED` (6) the exec
//! closed (standard output went away) before the program ended. Every one but
//! 0 also writes one line on standard error, after anything the program wrote
//! there. On Windows the mode does not run (`main.rs`).
//!
//! Unsafe code: `poll` on standard output, `waitid` with `WNOWAIT` (the exit,
//! with the program left unreaped) and `killpg`, which `std` has no safe form of.
#![allow(unsafe_code)]

use crate::json::{self, Value};
use std::io::{self, BufRead, Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

/// The program exited 0.
pub const EXIT_OK: u8 = 0;
/// The program exited with another code, or a signal ended it.
pub const EXIT_PROGRAM_FAILED: u8 = 1;
/// A command line or a spec this mode does not take: nothing was started.
pub const EXIT_USAGE: u8 = 2;
/// The program or its folder is not there, or it could not be started.
pub const EXIT_NOT_STARTED: u8 = 3;
/// The program ran past the timeout, and its group was ended.
pub const EXIT_TIMED_OUT: u8 = 4;
/// The program printed more than `MAX_OUTPUT_BYTES`, and its group was ended.
pub const EXIT_OUTPUT_CAP: u8 = 5;
/// The exec closed before the program ended, and its group was ended.
pub const EXIT_CLOSED: u8 = 6;

/// The longest run: a review's own longest timeout.
pub const MAX_TIMEOUT_SECS: u64 = 900;
/// The spec line, at most, its line end included.
pub const MAX_SPEC_BYTES: usize = 64 * 1024;
/// The program's standard input, at most (a review's prompt: its change is at most 512 KB).
pub const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
/// The program's standard output passed on, at most.
pub const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
/// The program's standard error passed on, at most.
pub const MAX_ERROR_BYTES: usize = 32 * 1024;
/// The most elements `argv` may have, and the longest one.
pub const MAX_ARGS: usize = 128;
pub const MAX_ARG_BYTES: usize = 4096;
/// The most variables `env` may name, the longest name and the longest value.
pub const MAX_ENV: usize = 64;
pub const MAX_ENV_NAME_BYTES: usize = 64;
pub const MAX_ENV_VALUE_BYTES: usize = 32 * 1024;
/// How long the program's group has after a terminate signal, before the kill.
pub const GRACE: Duration = Duration::from_secs(2);
/// How long the program's output may stay open after it exited (something it
/// left holds it), before what it left is killed.
pub const DRAIN_WAIT: Duration = Duration::from_secs(2);
/// How often the run looks at whether the exec has closed.
const WATCH_EVERY: Duration = Duration::from_millis(200);
/// The most read at once from the program.
const CHUNK: usize = 64 * 1024;

/// What the program is started with.
#[derive(Debug, Clone, PartialEq)]
pub struct Spec {
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
}

/// `--timeout`'s value: whole seconds, 1 to `MAX_TIMEOUT_SECS`, digits only.
pub fn parse_timeout(text: &str) -> Option<u64> {
    if text.is_empty() || text.len() > 4 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    match text.parse::<u64>() {
        Ok(n) if (1..=MAX_TIMEOUT_SECS).contains(&n) => Some(n),
        _ => None,
    }
}

/// A variable's name: a letter or `_`, then letters, digits and `_`.
fn valid_env_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= MAX_ENV_NAME_BYTES
        && (b[0].is_ascii_alphabetic() || b[0] == b'_')
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// The spec line (without its line end), read strictly: exactly the three
/// fields, each once and of its own shape.
pub fn parse_spec(line: &[u8]) -> Result<Spec, String> {
    let v = json::parse(line).map_err(|_| "the spec is not one JSON value".to_string())?;
    let keys = match v.keys() {
        Some(k) => k,
        None => return Err("the spec is not a JSON object".to_string()),
    };
    for k in &keys {
        if !matches!(*k, "argv" | "cwd" | "env") {
            return Err(format!("the spec has a field it does not take: {k}"));
        }
    }
    for name in ["argv", "cwd", "env"] {
        if keys.iter().filter(|k| **k == name).count() != 1 {
            return Err(format!("the spec needs {name} exactly once"));
        }
    }
    let items = match v.get("argv").and_then(Value::as_array) {
        Some(items) => items,
        None => return Err("argv is not a list".to_string()),
    };
    if items.is_empty() || items.len() > MAX_ARGS {
        return Err(format!("argv must have 1 to {MAX_ARGS} elements"));
    }
    let mut argv = Vec::with_capacity(items.len());
    for item in items {
        let s = match item.as_str() {
            Some(s) => s,
            None => return Err("an element of argv is not a string".to_string()),
        };
        if s.len() > MAX_ARG_BYTES || s.contains('\0') {
            return Err(format!("an element of argv is over {MAX_ARG_BYTES} bytes or holds a NUL"));
        }
        argv.push(s.to_string());
    }
    if !argv[0].starts_with('/') {
        return Err("argv[0] is not an absolute path".to_string());
    }
    let cwd = match v.get("cwd").and_then(Value::as_str) {
        Some(s) => s.to_string(),
        None => return Err("cwd is not a string".to_string()),
    };
    if !cwd.starts_with('/') || cwd.len() > MAX_ARG_BYTES || cwd.contains('\0') {
        return Err("cwd is not an absolute path".to_string());
    }
    let members = match v.get("env") {
        Some(Value::Obj(members)) => members,
        _ => return Err("env is not an object".to_string()),
    };
    if members.len() > MAX_ENV {
        return Err(format!("env names more than {MAX_ENV} variables"));
    }
    let mut env: Vec<(String, String)> = Vec::with_capacity(members.len());
    for (name, value) in members {
        if !valid_env_name(name) {
            return Err("env names a variable whose name it does not take".to_string());
        }
        if env.iter().any(|(k, _)| k == name) {
            return Err("env names a variable twice".to_string());
        }
        let s = match value.as_str() {
            Some(s) => s,
            None => return Err("a value in env is not a string".to_string()),
        };
        if s.len() > MAX_ENV_VALUE_BYTES || s.contains('\0') {
            return Err(format!("a value in env is over {MAX_ENV_VALUE_BYTES} bytes or holds a NUL"));
        }
        env.push((name.clone(), s.to_string()));
    }
    Ok(Spec { argv, cwd, env })
}

/// The spec line and the program's input, from standard input, each within its bound.
fn read_request() -> Result<(Spec, Vec<u8>), String> {
    let stdin = io::stdin();
    let mut lock = stdin.lock();
    let mut line = Vec::new();
    if let Err(e) = (&mut lock).take(MAX_SPEC_BYTES as u64).read_until(b'\n', &mut line) {
        return Err(format!("standard input cannot be read: {e}"));
    }
    if line.last() != Some(&b'\n') {
        return Err(format!("standard input does not start with a spec line of at most {MAX_SPEC_BYTES} bytes"));
    }
    line.pop();
    let spec = parse_spec(&line)?;
    let mut input = Vec::new();
    if let Err(e) = (&mut lock).take(MAX_INPUT_BYTES as u64 + 1).read_to_end(&mut input) {
        return Err(format!("standard input cannot be read: {e}"));
    }
    if input.len() > MAX_INPUT_BYTES {
        return Err(format!("the program's input is over {} MiB", MAX_INPUT_BYTES / (1024 * 1024)));
    }
    Ok((spec, input))
}

/// One line on standard error, then the exit status. Not eprintln!: it panics
/// when standard error is closed, as it is once the ssh link has dropped.
fn said(code: u8, msg: &str) -> u8 {
    let _ = writeln!(io::stderr(), "aicc-helper: run: {msg}");
    code
}

/// What the threads tell the one that waits.
enum Event {
    /// The program exited (it is not reaped yet).
    Exited,
    /// Its standard output ended, and everything it printed was passed on.
    OutputDone,
    /// It printed more than `MAX_OUTPUT_BYTES`.
    OutputCap,
    /// This mode's standard output cannot be written: the exec closed.
    Closed,
}

/// True when this mode's standard output has gone away (the exec closed):
/// `poll` reports an error or a hangup on it.
fn stdout_closed() -> bool {
    let mut fd = libc::pollfd { fd: 1, events: 0, revents: 0 };
    let rc = unsafe { libc::poll(&mut fd, 1, 0) };
    rc > 0 && (fd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL)) != 0
}

/// Send `sig` to process group `pgid`; never to group 0 (this one's) or 1.
fn signal_group(pgid: libc::pid_t, sig: libc::c_int) {
    if pgid > 1 {
        unsafe {
            libc::killpg(pgid, sig);
        }
    }
}

/// Block until the program has exited, leaving it unreaped (as
/// `pty::unix::ExitWatch::wait`), so its id still names its group.
fn wait_exited(pid: libc::pid_t) {
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) };
        if rc == 0 {
            return;
        }
        match io::Error::last_os_error().raw_os_error() {
            Some(libc::EINTR) => continue,
            _ => return,
        }
    }
}

/// Wait for `Exited` until `deadline`, dropping every other event.
fn exited_by(events: &Receiver<Event>, deadline: Instant) -> bool {
    loop {
        match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Event::Exited) => return true,
            Ok(_) => {}
            Err(_) => return false,
        }
    }
}

/// Copy the program's standard output to this mode's, up to the cap.
fn copy_output(mut from: impl Read, events: &Sender<Event>) {
    let stdout = io::stdout();
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0usize;
    loop {
        let n = match from.read(&mut buf) {
            Ok(0) => {
                let _ = events.send(Event::OutputDone);
                return;
            }
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => {
                let _ = events.send(Event::OutputDone);
                return;
            }
        };
        let room = MAX_OUTPUT_BYTES - total;
        let take = n.min(room);
        if take > 0 {
            let mut out = stdout.lock();
            if out.write_all(&buf[..take]).and_then(|_| out.flush()).is_err() {
                let _ = events.send(Event::Closed);
                return;
            }
            total += take;
        }
        if n > room {
            let _ = events.send(Event::OutputCap);
            return;
        }
    }
}

/// Copy the program's standard error to this mode's, up to its cap; the rest
/// is read and dropped, so the program is never held by a full pipe.
fn copy_errors(mut from: impl Read) {
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0usize;
    loop {
        let n = match from.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        };
        let take = n.min(MAX_ERROR_BYTES - total);
        if take > 0 {
            let _ = io::stderr().write_all(&buf[..take]);
            total += take;
        }
    }
}

/// Run the mode: read the request, start the program, pass its output on,
/// end its group, and return the exit status. The command line is `main.rs`'s.
pub fn run(timeout: Duration) -> u8 {
    let (spec, input) = match read_request() {
        Ok(r) => r,
        Err(why) => return said(EXIT_USAGE, &why),
    };
    match std::fs::metadata(&spec.argv[0]) {
        Ok(m) if m.is_file() => {}
        _ => return said(EXIT_NOT_STARTED, &format!("the program {} is not a file there", spec.argv[0])),
    }
    match std::fs::metadata(&spec.cwd) {
        Ok(m) if m.is_dir() => {}
        _ => return said(EXIT_NOT_STARTED, &format!("the folder {} is not there", spec.cwd)),
    }
    // The program alone is waited for, and only through `waitid` below and
    // `wait` at the end, so SIGCHLD must not be ignored when it starts.
    unsafe {
        libc::signal(libc::SIGCHLD, libc::SIG_DFL);
    }
    let mut cmd = Command::new(&spec.argv[0]);
    cmd.args(&spec.argv[1..])
        .env_clear()
        .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .current_dir(&spec.cwd)
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return said(EXIT_NOT_STARTED, &format!("the program could not be started: {e}")),
    };
    let pid = child.id() as libc::pid_t;
    let (events_tx, events) = mpsc::channel::<Event>();
    if let Some(mut stdin) = child.stdin.take() {
        let _ = thread::Builder::new().spawn(move || {
            // A program that does not read its input gets a closed pipe: not this mode's failure.
            let _ = stdin.write_all(&input);
        });
    }
    if let Some(out) = child.stdout.take() {
        let tx = events_tx.clone();
        let _ = thread::Builder::new().spawn(move || copy_output(out, &tx));
    }
    if let Some(err) = child.stderr.take() {
        let _ = thread::Builder::new().spawn(move || copy_errors(err));
    }
    {
        let tx = events_tx.clone();
        let _ = thread::Builder::new().spawn(move || {
            wait_exited(pid);
            let _ = tx.send(Event::Exited);
        });
    }
    drop(events_tx);

    let deadline = Instant::now() + timeout;
    let mut exited = false;
    let mut output_done = false;
    let mut drained_by: Option<Instant> = None;
    let mut ended: Option<(u8, String)> = None;
    while !(exited && output_done) {
        let now = Instant::now();
        if now >= deadline {
            ended = Some((EXIT_TIMED_OUT, format!("the program ran past its {} s and was ended", timeout.as_secs())));
            break;
        }
        if stdout_closed() {
            ended = Some((EXIT_CLOSED, "the exec closed before the program ended, so it was ended".to_string()));
            break;
        }
        if let Some(by) = drained_by {
            // The program has exited and what it left still holds its output.
            if now >= by {
                break;
            }
        }
        let mut wait = WATCH_EVERY.min(deadline.saturating_duration_since(now));
        if let Some(by) = drained_by {
            wait = wait.min(by.saturating_duration_since(now));
        }
        match events.recv_timeout(wait) {
            Ok(Event::Exited) => {
                exited = true;
                drained_by = Some(Instant::now() + DRAIN_WAIT);
            }
            Ok(Event::OutputDone) => output_done = true,
            Ok(Event::OutputCap) => {
                ended = Some((EXIT_OUTPUT_CAP, format!("the program printed more than {} MiB, so it was ended", MAX_OUTPUT_BYTES / (1024 * 1024))));
                break;
            }
            Ok(Event::Closed) => {
                ended = Some((EXIT_CLOSED, "the exec closed before the program ended, so it was ended".to_string()));
                break;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    // The program's group is ended before the program is reaped, so its id
    // names nothing else while it is signalled.
    if !exited {
        signal_group(pid, libc::SIGTERM);
        exited = exited_by(&events, Instant::now() + GRACE);
        if !exited {
            signal_group(pid, libc::SIGKILL);
            exited = exited_by(&events, Instant::now() + Duration::from_secs(5));
        }
    }
    // What it left in its group goes with it.
    signal_group(pid, libc::SIGKILL);
    if !exited {
        // Not reaped: one kill could not end it in time. It is the machine's
        // to reap once this mode has exited.
        return said(ended.map_or(EXIT_PROGRAM_FAILED, |(c, _)| c), "the program did not end after a kill");
    }
    let status = child.wait();
    if let Some((code, why)) = ended {
        return said(code, &why);
    }
    match status {
        Ok(s) if s.code() == Some(0) => EXIT_OK,
        Ok(s) => match (s.code(), s.signal()) {
            (Some(code), _) => said(EXIT_PROGRAM_FAILED, &format!("the program exited with code {code}")),
            (None, Some(sig)) => said(EXIT_PROGRAM_FAILED, &format!("the program was ended by signal {sig}")),
            (None, None) => said(EXIT_PROGRAM_FAILED, "the program ended with no exit code"),
        },
        Err(e) => said(EXIT_PROGRAM_FAILED, &format!("the program's end could not be read: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_exit_statuses_and_limits_are_the_documented_ones() {
        assert_eq!((EXIT_OK, EXIT_PROGRAM_FAILED, EXIT_USAGE, EXIT_NOT_STARTED, EXIT_TIMED_OUT, EXIT_OUTPUT_CAP, EXIT_CLOSED), (0, 1, 2, 3, 4, 5, 6));
        assert_eq!(MAX_TIMEOUT_SECS, 900);
        assert_eq!((MAX_SPEC_BYTES, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, MAX_ERROR_BYTES), (64 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024, 32 * 1024));
        assert_eq!((GRACE, DRAIN_WAIT), (Duration::from_secs(2), Duration::from_secs(2)));
    }

    #[test]
    fn the_timeout_is_whole_seconds_from_1_to_900() {
        assert_eq!(parse_timeout("1"), Some(1));
        assert_eq!(parse_timeout("330"), Some(330));
        assert_eq!(parse_timeout("900"), Some(900));
        for bad in ["", "0", "901", "1000", "-1", "+5", "5s", " 5", "1.5", "00001"] {
            assert_eq!(parse_timeout(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_spec_of_the_three_fields_reads() {
        let s = parse_spec(br#"{"argv":["/bin/echo","a b","$(x)"],"cwd":"/tmp","env":{"HOME":"/h","A_1":""}}"#).unwrap();
        assert_eq!(s.argv, vec!["/bin/echo", "a b", "$(x)"]);
        assert_eq!(s.cwd, "/tmp");
        assert_eq!(s.env, vec![("HOME".to_string(), "/h".to_string()), ("A_1".to_string(), String::new())]);
    }

    #[test]
    fn any_other_spec_is_refused() {
        for bad in [
            &b"not json"[..],
            br#"[]"#,
            br#"{"argv":["/bin/echo"],"cwd":"/"}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","env":{},"shell":true}"#,
            br#"{"argv":["/bin/echo"],"argv":["/bin/sh"],"cwd":"/","env":{}}"#,
            br#"{"argv":[],"cwd":"/","env":{}}"#,
            br#"{"argv":["echo"],"cwd":"/","env":{}}"#,
            br#"{"argv":["/bin/echo",1],"cwd":"/","env":{}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"tmp","env":{}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","env":{"A=B":"x"}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","env":{"1A":"x"}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","env":{"A":"x","A":"y"}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","env":{"A":1}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","env":[]}"#,
            br#"{"argv":["/bin/ec\u0000ho"],"cwd":"/","env":{}}"#,
        ] {
            assert!(parse_spec(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
        let many: Vec<String> = (0..=MAX_ARGS).map(|i| format!("\"a{i}\"")).collect();
        let line = format!("{{\"argv\":[\"/bin/echo\",{}],\"cwd\":\"/\",\"env\":{{}}}}", many.join(","));
        assert!(parse_spec(line.as_bytes()).is_err());
    }
}
