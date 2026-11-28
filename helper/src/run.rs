//! `aicc-helper run --nonce <n> --timeout <seconds>` (macOS and Linux, from
//! 2.1.3-beta.21): the one-shot run mode (ADR-030 protocol change 6,
//! docs/remote/helper-protocol.md section 4). The app starts one program on
//! a machine through it, in one `ssh -T` exec, and reads what the program
//! prints: a review on the machine a remote session runs on
//! (nubbymong/aicc_planning#446) is its first use.
//!
//! What it reads, on standard input: one line holding a JSON object with
//! exactly `argv`, `cwd` and `env`, at most `MAX_REQUEST_BYTES` with its line
//! end, then the rest of standard input, at most `MAX_INPUT_BYTES`, which is
//! the program's own standard input (a review's prompt). It reads the whole
//! input before it starts anything; a request that is not one line, is over
//! its bound or is not exactly that object, and an input over its bound, are
//! refused, never cut. The request comes on standard input, never on the
//! command line: the program's path and the folder are values the machine
//! reported (protocol section 4).
//!
//! `argv`, `cwd` and `env` follow `term.launch`'s rules (protocol section 15,
//! Launch; `request.rs`'s bounds): `argv[0]` is an absolute path, started by
//! that exact path with no search of `PATH` and no shell between; `cwd` is
//! an absolute folder; `env` is the program's whole environment, with nothing
//! of this process's own added.
//!
//! The program leads a new session (and so a new process group), and its
//! standard input is closed once the input is written. Its standard output is
//! copied to this mode's, byte for byte, at most `MAX_OUTPUT_BYTES`: the first
//! byte past that ends the run (`cut`). Its standard error is copied at most
//! `MAX_ERROR_BYTES`; the rest is read and dropped, which ends nothing.
//!
//! The program's whole session is ended (a hangup, then a kill after
//! `GRACE`, as a holder ends a tree: `pty::signal_session`) when the program
//! exits, when `--timeout` seconds have passed since it started (`timeout`),
//! when its output passes its cap (`cut`), and when this mode's own standard
//! output closes before the program has exited (the app ended the exec). The
//! end of standard input is not an end: it comes once the input is read.
//!
//! Then, unless its standard output has closed, it writes a line end if the
//! copied output did not end with one, and last of all one line:
//!
//! ```text
//! AICC-RESULT <nonce> {"code":<n>|null,"signal":<n>|null,"timeout":<bool>,"cut":<bool>}
//! ```
//!
//! and exits `EXIT_DONE` (0), whatever the program's own exit was. It exits
//! `EXIT_NOT_RUN` (1), with one line on standard error and nothing started,
//! when the request is refused or the program cannot start, and also when its
//! standard output closed first (nothing can be written then); `EXIT_USAGE`
//! (2) on a command line it does not take (`main.rs`). It writes no file,
//! opens no connection and starts nothing but `argv`. On Windows it does not
//! run (`main.rs`).
//!
//! The program is reaped in one place (`reaped`, `Child::try_wait`), and
//! its session is signalled only while its id cannot name anyone else: before
//! it is reaped, or while anything is still in its session (the rule of
//! `pty/unix.rs`). An exit watch thread learns of the exit with `waitid` and
//! `WNOWAIT`, which leaves the program unreaped.
//!
//! Unsafe code: `setsid` in the child before exec, `poll` on standard output,
//! `waitid` with `WNOWAIT` and `signal`, which `std` has no safe form of.
#![allow(unsafe_code)]

use crate::hello::{valid_nonce, RESULT_PREFIX};
use crate::json::{self, Value};
use crate::pty::{session_left, signal_session};
use crate::request::{MAX_ARGV_ITEMS, MAX_ARG_CHARS, MAX_CWD_CHARS, MAX_ENV_ENTRIES, MAX_ENV_NAME_CHARS, MAX_ENV_VALUE_CHARS};
use std::io::{self, BufRead, Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// The result line was written (the program ran, however it ended).
pub const EXIT_DONE: u8 = 0;
/// The request was refused, the program could not start, or this mode's
/// standard output closed before the result line: one line on standard error.
pub const EXIT_NOT_RUN: u8 = 1;
/// A command line this mode does not take (`main.rs`).
pub const EXIT_USAGE: u8 = 2;

/// `--timeout`'s bounds: a review's own timeout, 30 to 900 seconds.
pub const MIN_TIMEOUT_SECS: u64 = 30;
pub const MAX_TIMEOUT_SECS: u64 = 900;
/// The request line, at most, its line end included.
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// The program's standard input (a review's prompt), at most.
pub const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
/// The program's standard output copied, at most; one byte more is a cut.
pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// The program's standard error copied, at most; the rest is dropped.
pub const MAX_ERROR_BYTES: usize = 64 * 1024;
/// How long the program's session has after the hangup, before the kill.
pub const GRACE: Duration = Duration::from_secs(2);
/// How long the copy of the program's output may still run once its session
/// has been ended (a process that left the session on purpose may hold it).
pub const DRAIN_WAIT: Duration = Duration::from_secs(2);
/// How long a killed program has to be reaped.
const KILL_WAIT: Duration = Duration::from_secs(5);
/// How often the run looks at whether the exec has closed.
const WATCH_EVERY: Duration = Duration::from_millis(200);
/// The most read at once from the program.
const CHUNK: usize = 64 * 1024;

/// What the program is started with.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
}

/// How the program's run ended, as the result line says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Outcome {
    /// Its exit code; None when a signal ended it or it was not reaped.
    pub code: Option<i32>,
    /// The signal that ended it; None when it exited by itself.
    pub signal: Option<i32>,
    /// `--timeout` seconds passed and its session was ended.
    pub timeout: bool,
    /// Its output passed `MAX_OUTPUT_BYTES` and its session was ended.
    pub cut: bool,
}

/// `--timeout`'s value: whole seconds from `MIN_TIMEOUT_SECS` to
/// `MAX_TIMEOUT_SECS`, digits only, no leading zero.
pub fn parse_timeout(text: &str) -> Option<u64> {
    let b = text.as_bytes();
    if b.is_empty() || b.len() > 3 || b[0] == b'0' || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    match text.parse::<u64>() {
        Ok(n) if (MIN_TIMEOUT_SECS..=MAX_TIMEOUT_SECS).contains(&n) => Some(n),
        _ => None,
    }
}

/// `--nonce`'s value: 32 lower-case hex characters (protocol section 1).
pub fn parse_nonce(text: &str) -> Option<&str> {
    if valid_nonce(text) {
        Some(text)
    } else {
        None
    }
}

/// The request line (without its line end), read strictly: exactly the three
/// fields, each once, each by `term.launch`'s rules.
pub fn parse_request(line: &[u8]) -> Result<Request, String> {
    let v = json::parse(line).map_err(|_| "the request is not one JSON value".to_string())?;
    let keys = match v.keys() {
        Some(k) => k,
        None => return Err("the request is not a JSON object".to_string()),
    };
    if keys.len() != 3 || ["argv", "cwd", "env"].iter().any(|name| keys.iter().filter(|k| *k == name).count() != 1) {
        return Err("the request must hold exactly argv, cwd and env, each once".to_string());
    }
    let items = match v.get("argv").and_then(Value::as_array) {
        Some(items) => items,
        None => return Err("argv must be an array of strings".to_string()),
    };
    if items.is_empty() || items.len() > MAX_ARGV_ITEMS {
        return Err(format!("argv must hold 1 to {MAX_ARGV_ITEMS} strings"));
    }
    let mut argv = Vec::with_capacity(items.len());
    for item in items {
        let s = match item.as_str() {
            Some(s) => s,
            None => return Err("argv must be an array of strings".to_string()),
        };
        if s.chars().count() > MAX_ARG_CHARS || s.contains('\0') {
            return Err(format!("an argument is over {MAX_ARG_CHARS} characters or holds a NUL character"));
        }
        argv.push(s.to_string());
    }
    if !argv[0].starts_with('/') {
        return Err("argv[0] must be an absolute path".to_string());
    }
    let cwd = match v.get("cwd").and_then(Value::as_str) {
        Some(s) => s,
        None => return Err("cwd must be a string".to_string()),
    };
    if cwd.chars().count() > MAX_CWD_CHARS || cwd.contains('\0') || !cwd.starts_with('/') {
        return Err(format!("cwd must be an absolute path of at most {MAX_CWD_CHARS} characters with no NUL character"));
    }
    let members = match v.get("env") {
        Some(Value::Obj(members)) => members,
        _ => return Err("env must be an object of strings".to_string()),
    };
    if members.len() > MAX_ENV_ENTRIES {
        return Err(format!("env has more than {MAX_ENV_ENTRIES} entries"));
    }
    let mut env: Vec<(String, String)> = Vec::with_capacity(members.len());
    let mut folded: Vec<String> = Vec::with_capacity(members.len());
    for (name, value) in members {
        if name.is_empty() || name.chars().count() > MAX_ENV_NAME_CHARS || name.contains('=') || name.contains('\0') {
            return Err(format!("an environment name must be 1 to {MAX_ENV_NAME_CHARS} characters with no = or NUL character"));
        }
        let value = match value.as_str() {
            Some(s) => s,
            None => return Err("an environment value is not a string".to_string()),
        };
        if value.chars().count() > MAX_ENV_VALUE_CHARS || value.contains('\0') {
            return Err(format!("an environment value is over {MAX_ENV_VALUE_CHARS} characters or holds a NUL character"));
        }
        // As term.launch: names that differ only in case are refused.
        let key = name.to_uppercase();
        if folded.contains(&key) {
            return Err("an environment name is given twice (case ignored)".to_string());
        }
        folded.push(key);
        env.push((name.clone(), value.to_string()));
    }
    Ok(Request { argv, cwd: cwd.to_string(), env })
}

/// The request line and the program's input, from `from`, each within its
/// bound. Nothing past `MAX_INPUT_BYTES` and one byte is read.
pub fn read_request(from: &mut impl BufRead) -> Result<(Request, Vec<u8>), String> {
    let mut line = Vec::new();
    if let Err(e) = from.by_ref().take(MAX_REQUEST_BYTES as u64).read_until(b'\n', &mut line) {
        return Err(format!("standard input cannot be read: {e}"));
    }
    if line.last() != Some(&b'\n') {
        return Err(format!("standard input does not start with a request line of at most {} KiB", MAX_REQUEST_BYTES / 1024));
    }
    line.pop();
    let request = parse_request(&line)?;
    let mut input = Vec::new();
    if let Err(e) = from.by_ref().take(MAX_INPUT_BYTES as u64 + 1).read_to_end(&mut input) {
        return Err(format!("standard input cannot be read: {e}"));
    }
    if input.len() > MAX_INPUT_BYTES {
        return Err(format!("the program's input is over {} MiB, so nothing was started", MAX_INPUT_BYTES / (1024 * 1024)));
    }
    Ok((request, input))
}

/// The result line, without its line end.
pub fn result_line(nonce: &str, o: &Outcome) -> String {
    let num = |n: Option<i32>| n.map_or(Value::Null, |n| Value::Num(n.to_string()));
    let body = Value::obj(vec![("code", num(o.code)), ("signal", num(o.signal)), ("timeout", Value::Bool(o.timeout)), ("cut", Value::Bool(o.cut))]);
    format!("{RESULT_PREFIX} {nonce} {}", body.to_json())
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
    /// Its standard output ended, and everything it printed was copied.
    OutputDone,
    /// It printed more than `MAX_OUTPUT_BYTES`.
    Cut,
    /// This mode's standard output cannot be written: the exec closed.
    Closed,
}

/// The copy of the program's output, shared with the thread that copies it:
/// once `sealed`, nothing more is copied, so the result line is the last line.
#[derive(Default)]
struct Copied {
    sealed: bool,
    total: usize,
    /// The last byte copied was not a line end.
    open_line: bool,
    cut: bool,
}

/// True when this mode's standard output has gone away (the exec closed):
/// `poll` reports an error or a hangup on it.
fn stdout_closed() -> bool {
    let mut fd = libc::pollfd { fd: 1, events: 0, revents: 0 };
    let rc = unsafe { libc::poll(&mut fd, 1, 0) };
    rc > 0 && (fd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL)) != 0
}

/// Block until the program has exited, leaving it unreaped (as
/// `pty::unix::ExitWatch::wait`), so its id still names its session.
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

/// Copy the program's standard output to this mode's, up to the cap.
fn copy_output(mut from: impl Read, copied: &Mutex<Copied>, events: &Sender<Event>) {
    let mut buf = vec![0u8; CHUNK];
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
        let mut c = match copied.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        if c.sealed {
            return;
        }
        let room = MAX_OUTPUT_BYTES - c.total;
        let take = n.min(room);
        if take > 0 {
            let stdout = io::stdout();
            let mut out = stdout.lock();
            if out.write_all(&buf[..take]).and_then(|_| out.flush()).is_err() {
                drop(c);
                let _ = events.send(Event::Closed);
                return;
            }
            c.total += take;
            c.open_line = buf[take - 1] != b'\n';
        }
        if n > room {
            c.cut = true;
            drop(c);
            let _ = events.send(Event::Cut);
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

/// True once the program has been reaped (`status` keeps how it ended).
fn reaped(child: &mut Child, status: &mut Option<ExitStatus>) -> bool {
    if status.is_some() {
        return true;
    }
    if let Ok(Some(s)) = child.try_wait() {
        *status = Some(s);
        return true;
    }
    false
}

/// True when the program has been reaped and nothing is left in its session.
fn over(child: &mut Child, status: &mut Option<ExitStatus>, sid: libc::pid_t) -> bool {
    reaped(child, status) && !session_left(sid)
}

/// End the program's whole session, as a holder ends a tree
/// (`pty::unix::Pty::end_tree`): nothing when it has exited and left nothing,
/// else a hangup, `GRACE` to go, then a kill, and the program reaped.
fn end_session(child: &mut Child, status: &mut Option<ExitStatus>) {
    let sid = child.id() as libc::pid_t;
    if sid <= 1 {
        // Never group 0 (this one's) or 1; such an id is not a child's.
        return;
    }
    if over(child, status, sid) {
        return;
    }
    signal_session(sid, libc::SIGHUP);
    signal_session(sid, libc::SIGCONT);
    let deadline = Instant::now() + GRACE;
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
        if over(child, status, sid) {
            return;
        }
    }
    signal_session(sid, libc::SIGKILL);
    let deadline = Instant::now() + KILL_WAIT;
    while !reaped(child, status) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
}

/// Wait for `OutputDone` until `deadline`; true when it came. A `Closed`
/// that comes first is remembered in `closed`.
fn output_done_by(events: &Receiver<Event>, deadline: Instant, closed: &mut bool) -> bool {
    loop {
        match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Event::OutputDone) => return true,
            Ok(Event::Closed) => *closed = true,
            Ok(_) => {}
            Err(_) => return false,
        }
    }
}

/// Run the mode: read the request, start the program, copy its output, end
/// its session, write the result line, and return the exit status. The
/// command line is `main.rs`'s.
pub fn run(nonce: &str, timeout: Duration) -> u8 {
    let (request, input) = match read_request(&mut io::stdin().lock()) {
        Ok(r) => r,
        Err(why) => return said(EXIT_NOT_RUN, &why),
    };
    match std::fs::metadata(&request.argv[0]) {
        Ok(m) if m.is_file() => {}
        _ => return said(EXIT_NOT_RUN, &format!("the program {} is not a file there, so nothing was started", request.argv[0])),
    }
    match std::fs::metadata(&request.cwd) {
        Ok(m) if m.is_dir() => {}
        _ => return said(EXIT_NOT_RUN, &format!("the folder {} is not there, so nothing was started", request.cwd)),
    }
    // The program alone is waited for, through `waitid` and `try_wait`, so
    // SIGCHLD must not be ignored (a starter may leave it so).
    unsafe {
        libc::signal(libc::SIGCHLD, libc::SIG_DFL);
    }
    let mut cmd = Command::new(&request.argv[0]);
    cmd.args(&request.argv[1..])
        .env_clear()
        .envs(request.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .current_dir(&request.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // A new session, and with it a new process group whose id is the
    // program's: the whole of what it starts can be ended at once.
    unsafe {
        cmd.pre_exec(|| if libc::setsid() == -1 { Err(io::Error::last_os_error()) } else { Ok(()) });
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return said(EXIT_NOT_RUN, &format!("the program could not be started: {e}")),
    };
    let started = Instant::now();
    let pid = child.id() as libc::pid_t;
    let copied = Arc::new(Mutex::new(Copied::default()));
    let (events_tx, events) = mpsc::channel::<Event>();
    if let Some(mut stdin) = child.stdin.take() {
        let _ = thread::Builder::new().spawn(move || {
            // Then its standard input closes (dropped). A program that does
            // not read it gets a closed pipe: not this mode's failure.
            let _ = stdin.write_all(&input);
        });
    }
    if let Some(out) = child.stdout.take() {
        let tx = events_tx.clone();
        let c = Arc::clone(&copied);
        let _ = thread::Builder::new().spawn(move || copy_output(out, &c, &tx));
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

    let deadline = started + timeout;
    let mut timed_out = false;
    let mut closed = false;
    let mut cut = false;
    let mut output_done = false;
    loop {
        let now = Instant::now();
        if now >= deadline {
            timed_out = true;
            break;
        }
        if stdout_closed() {
            closed = true;
            break;
        }
        match events.recv_timeout(WATCH_EVERY.min(deadline.saturating_duration_since(now))) {
            Ok(Event::Exited) => break,
            Ok(Event::OutputDone) => output_done = true,
            Ok(Event::Cut) => {
                cut = true;
                break;
            }
            Ok(Event::Closed) => {
                closed = true;
                break;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    let mut status: Option<ExitStatus> = None;
    end_session(&mut child, &mut status);
    // What the program printed before its end is still in the pipe: copy it,
    // unless the copy has stopped already.
    if !output_done && !cut && !closed {
        output_done_by(&events, Instant::now() + DRAIN_WAIT, &mut closed);
    }
    if closed {
        return said(EXIT_NOT_RUN, "the exec closed before the program ended, so its session was ended");
    }
    // Sealed first, so nothing the copy still holds comes after the result line.
    let mut c = match copied.lock() {
        Ok(c) => c,
        Err(p) => p.into_inner(),
    };
    c.sealed = true;
    let outcome = Outcome {
        code: status.and_then(|s| s.code()),
        signal: status.and_then(|s| s.signal()),
        timeout: timed_out,
        cut: cut || c.cut,
    };
    let lead = if c.open_line { "\n" } else { "" };
    let stdout = io::stdout();
    let mut out = stdout.lock();
    if writeln!(out, "{lead}{}", result_line(nonce, &outcome)).and_then(|_| out.flush()).is_err() {
        return said(EXIT_NOT_RUN, "the result line could not be written: the exec closed");
    }
    EXIT_DONE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_exit_statuses_and_limits_are_the_protocols() {
        assert_eq!((EXIT_DONE, EXIT_NOT_RUN, EXIT_USAGE), (0, 1, 2));
        assert_eq!((MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS), (30, 900));
        assert_eq!((MAX_REQUEST_BYTES, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, MAX_ERROR_BYTES), (64 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024, 64 * 1024));
        assert_eq!((GRACE, DRAIN_WAIT), (Duration::from_secs(2), Duration::from_secs(2)));
    }

    #[test]
    fn the_timeout_is_whole_seconds_from_30_to_900() {
        assert_eq!(parse_timeout("30"), Some(30));
        assert_eq!(parse_timeout("330"), Some(330));
        assert_eq!(parse_timeout("900"), Some(900));
        for bad in ["", "0", "1", "29", "901", "1000", "-1", "+50", "50s", " 50", "50.0", "030", "0900"] {
            assert_eq!(parse_timeout(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_nonce_is_32_lower_case_hex_characters() {
        assert_eq!(parse_nonce("0123456789abcdef0123456789abcdef"), Some("0123456789abcdef0123456789abcdef"));
        for bad in ["", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdef0", "0123456789abcdef 123456789abcdef"] {
            assert_eq!(parse_nonce(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_request_of_the_three_fields_reads() {
        let r = parse_request(br#"{"argv":["/bin/echo","a b","$(x)"],"cwd":"/tmp","env":{"HOME":"/h","A_1":""}}"#).unwrap();
        assert_eq!(r.argv, vec!["/bin/echo", "a b", "$(x)"]);
        assert_eq!(r.cwd, "/tmp");
        assert_eq!(r.env, vec![("HOME".to_string(), "/h".to_string()), ("A_1".to_string(), String::new())]);
        // The bounds term.launch has, at the bound.
        let at = format!(r#"{{"argv":["/{}"],"cwd":"/{}","env":{{"{}":"{}"}}}}"#, "a".repeat(MAX_ARG_CHARS - 1), "c".repeat(MAX_CWD_CHARS - 1), "N".repeat(MAX_ENV_NAME_CHARS), "v".repeat(MAX_ENV_VALUE_CHARS));
        assert!(parse_request(at.as_bytes()).is_ok());
    }

    #[test]
    fn any_other_request_is_refused() {
        for bad in [
            &b"not json"[..],
            br#"[]"#,
            br#"{"argv":["/bin/echo"],"cwd":"/"}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","env":{},"shell":true}"#,
            br#"{"argv":["/bin/echo"],"argv":["/bin/sh"],"cwd":"/","env":{}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","cwd":"/tmp","env":{}}"#,
            br#"{"argv":[],"cwd":"/","env":{}}"#,
            br#"{"argv":["echo"],"cwd":"/","env":{}}"#,
            br#"{"argv":["./echo"],"cwd":"/","env":{}}"#,
            br#"{"argv":["/bin/echo",1],"cwd":"/","env":{}}"#,
            br#"{"argv":"/bin/echo","cwd":"/","env":{}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"tmp","env":{}}"#,
            br#"{"argv":["/bin/echo"],"cwd":1,"env":{}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","env":{"A=B":"x"}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","env":{"":"x"}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","env":{"A":"x","A":"y"}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","env":{"Path":"x","PATH":"y"}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","env":{"A":1}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","env":[]}"#,
            br#"{"argv":["/bin/ec\u0000ho"],"cwd":"/","env":{}}"#,
            br#"{"argv":["/bin/echo"],"cwd":"/","env":{"A":"x\u0000"}}"#,
        ] {
            assert!(parse_request(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
        let over = |argv: String, cwd: String, env: String| format!(r#"{{"argv":[{argv}],"cwd":"{cwd}","env":{{{env}}}}}"#);
        let many: Vec<String> = (0..=MAX_ARGV_ITEMS).map(|i| format!("\"/a{i}\"")).collect();
        for line in [
            over(many.join(","), "/".into(), String::new()),
            over(format!("\"/{}\"", "a".repeat(MAX_ARG_CHARS)), "/".into(), String::new()),
            over("\"/x\"".into(), format!("/{}", "c".repeat(MAX_CWD_CHARS)), String::new()),
            over("\"/x\"".into(), "/".into(), format!("\"{}\":\"v\"", "N".repeat(MAX_ENV_NAME_CHARS + 1))),
            over("\"/x\"".into(), "/".into(), format!("\"N\":\"{}\"", "v".repeat(MAX_ENV_VALUE_CHARS + 1))),
            over("\"/x\"".into(), "/".into(), (0..=MAX_ENV_ENTRIES).map(|i| format!("\"N{i}\":\"\"")).collect::<Vec<_>>().join(",")),
        ] {
            assert!(parse_request(line.as_bytes()).is_err(), "{} bytes", line.len());
        }
    }

    #[test]
    fn the_request_line_and_the_input_are_read_within_their_bounds() {
        let line = br#"{"argv":["/bin/cat"],"cwd":"/","env":{}}"#;
        let mut ok = line.to_vec();
        ok.push(b'\n');
        ok.extend_from_slice(b"the prompt\n{\"not\":\"a request\"}");
        let (r, input) = read_request(&mut &ok[..]).unwrap();
        assert_eq!(r.argv, vec!["/bin/cat"]);
        assert_eq!(input, b"the prompt\n{\"not\":\"a request\"}");
        // No line end: never one line.
        assert!(read_request(&mut &line[..]).is_err());
        // A line past its bound, line end included.
        let mut long = format!(r#"{{"argv":["/{}"],"cwd":"/","env":{{}}}}"#, "a".repeat(MAX_REQUEST_BYTES)).into_bytes();
        long.push(b'\n');
        assert!(read_request(&mut &long[..]).is_err());
        // The input at its bound, and one byte past it.
        let mut at = ok[..line.len() + 1].to_vec();
        at.extend(std::iter::repeat(b'x').take(MAX_INPUT_BYTES));
        assert_eq!(read_request(&mut &at[..]).unwrap().1.len(), MAX_INPUT_BYTES);
        at.push(b'x');
        assert!(read_request(&mut &at[..]).unwrap_err().contains("over 2 MiB"));
    }

    #[test]
    fn the_result_line_is_the_documented_shape() {
        let n = "0123456789abcdef0123456789abcdef";
        assert_eq!(result_line(n, &Outcome { code: Some(0), signal: None, timeout: false, cut: false }), format!("AICC-RESULT {n} {{\"code\":0,\"signal\":null,\"timeout\":false,\"cut\":false}}"));
        assert_eq!(result_line(n, &Outcome { code: None, signal: Some(9), timeout: true, cut: false }), format!("AICC-RESULT {n} {{\"code\":null,\"signal\":9,\"timeout\":true,\"cut\":false}}"));
        assert_eq!(result_line(n, &Outcome { code: Some(141), signal: None, timeout: false, cut: true }), format!("AICC-RESULT {n} {{\"code\":141,\"signal\":null,\"timeout\":false,\"cut\":true}}"));
    }
}
