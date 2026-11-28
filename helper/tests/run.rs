//! The run mode (`aicc-helper run --nonce <n> --timeout <seconds>`, from
//! 2.1.3-beta.21, ADR-030 protocol change 6, docs/remote/helper-protocol.md
//! section 4) as a program, the way the app runs it on a remote machine for
//! a review there (nubbymong/aicc_planning#446): the request line and the
//! program's input on standard input; the program started from its argv
//! alone, with no shell, in its folder, with its environment alone; its
//! output copied up to the cap, its errors up to theirs; its whole session
//! ended when it exits, at the timeout, at the cap and when the exec closes;
//! the result line last; nothing started for a request it refuses. macOS and
//! Linux only: on Windows the mode does not run.
#![cfg(unix)]

use aicc_helper::json::{self, Value};
use aicc_helper::pids;
use aicc_helper::run::{MAX_ERROR_BYTES, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, MAX_REQUEST_BYTES};
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
const NONCE: &str = "0123456789abcdef0123456789abcdef";
const PATH_ONLY: &[(&str, &str)] = &[("PATH", "/usr/bin:/bin")];

/// A request line for `argv` in `cwd` with `env`, and its line end.
fn request(argv: &[&str], cwd: &str, env: &[(&str, &str)]) -> Vec<u8> {
    let env = Value::Obj(env.iter().map(|(k, v)| (k.to_string(), Value::str(v))).collect());
    let mut line = Value::obj(vec![("argv", Value::strs(argv)), ("cwd", Value::str(cwd)), ("env", env)]).to_json().into_bytes();
    line.push(b'\n');
    line
}

struct Ran {
    code: Option<i32>,
    out: Vec<u8>,
    err: String,
    took: Duration,
}

impl Ran {
    /// What the program printed (everything before the result line) and the
    /// result line's object; panics when the last line is not the result line.
    fn result(&self) -> (Vec<u8>, Value) {
        assert!(self.out.ends_with(b"\n"), "the output does not end with a line end: {:?}", String::from_utf8_lossy(&self.out));
        let body = &self.out[..self.out.len() - 1];
        let at = body.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        let last = String::from_utf8_lossy(&body[at..]).into_owned();
        let prefix = format!("AICC-RESULT {NONCE} ");
        let json_text = last.strip_prefix(&prefix).unwrap_or_else(|| panic!("the last line is not the result line: {last:?}"));
        let v = json::parse(json_text.as_bytes()).expect("the result line's object");
        assert_eq!(v.keys().unwrap(), vec!["code", "signal", "timeout", "cut"], "{json_text}");
        (self.out[..at].to_vec(), v)
    }
}

fn code_of(v: &Value) -> Option<i64> {
    v.get("code").and_then(Value::as_i64)
}
fn signal_of(v: &Value) -> Option<i64> {
    v.get("signal").and_then(Value::as_i64)
}
fn flag(v: &Value, name: &str) -> bool {
    v.get(name).and_then(Value::as_bool).unwrap_or_else(|| panic!("{name} is not a bool"))
}

/// The run mode started on `args`, with `input` written to its standard
/// input and then closed.
fn start(args: &[&str], input: Vec<u8>) -> (Child, JoinHandle<()>) {
    let mut child = Command::new(HELPER)
        .arg("run")
        .args(args)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start the run mode");
    let mut stdin = child.stdin.take().expect("its standard input");
    let writer = thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    (child, writer)
}

/// What a started run printed and how it exited, giving up after `limit`.
fn finish(mut child: Child, writer: JoinHandle<()>, limit: Duration) -> Ran {
    let started = Instant::now();
    let mut out = child.stdout.take().expect("its standard output");
    let mut err = child.stderr.take().expect("its standard error");
    let reading = thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let erring = thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let code = loop {
        if let Some(status) = child.try_wait().expect("look at the run mode") {
            break status.code();
        }
        if started.elapsed() >= limit {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the run mode still ran after {limit:?}");
        }
        thread::sleep(Duration::from_millis(20));
    };
    let took = started.elapsed();
    let _ = writer.join();
    let out = reading.join().expect("its output");
    let err = String::from_utf8_lossy(&erring.join().expect("its errors")).into_owned();
    Ran { code, out, err, took }
}

fn run_with(args: &[&str], input: Vec<u8>, limit: Duration) -> Ran {
    let (child, writer) = start(args, input);
    finish(child, writer, limit)
}

fn run(timeout: &str, input: Vec<u8>) -> Ran {
    run_with(&["--nonce", NONCE, "--timeout", timeout], input, Duration::from_secs(30))
}

/// The run of `argv` in `/` with only a PATH and no input.
fn run_argv(argv: &[&str]) -> Ran {
    run("60", request(argv, "/", PATH_ONLY))
}

/// The process id the program printed on its first line.
fn first_pid(out: &[u8]) -> u32 {
    let text = String::from_utf8_lossy(out);
    text.lines().next().and_then(|l| l.trim().parse::<u32>().ok()).unwrap_or_else(|| panic!("no process id on the first line of {text:?}"))
}

/// True once `pid` is gone, within `within`.
fn gone_within(pid: u32, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if !pids::alive(pid) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    !pids::alive(pid)
}

/// A fresh folder of the test's own under the system's temporary folder.
fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("aicc-run-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a folder");
    std::fs::canonicalize(&dir).expect("its real path")
}

#[test]
fn the_program_gets_its_argv_word_for_word_with_no_shell_between() {
    let r = run_argv(&["/bin/echo", "a; echo b", "$(id)", "*", "`id`", "'q'"]);
    assert_eq!(r.code, Some(0), "{}", r.err);
    let (out, v) = r.result();
    assert_eq!(String::from_utf8_lossy(&out), "a; echo b $(id) * `id` 'q'\n");
    assert_eq!((code_of(&v), signal_of(&v), flag(&v, "timeout"), flag(&v, "cut")), (Some(0), None, false, false));
}

#[test]
fn only_the_requests_environment_reaches_it() {
    let r = run("60", request(&["/usr/bin/env"], "/", &[("AICC_RUN_ONLY", "1")]));
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert_eq!(String::from_utf8_lossy(&r.result().0), "AICC_RUN_ONLY=1\n");
}

#[test]
fn what_follows_the_request_line_is_its_standard_input_byte_for_byte_then_closed() {
    let mut input = request(&["/bin/cat"], "/", &[]);
    let prompt = b"line one\nline two {\"argv\":[\"/bin/sh\"]}\n\x00\x01 last".to_vec();
    input.extend_from_slice(&prompt);
    let r = run("60", input);
    assert_eq!(r.code, Some(0), "{}", r.err);
    // cat ended: its standard input closed after the prompt. What it copied
    // does not end with a line end, so the run mode adds one before the result.
    let mut expected = prompt.clone();
    expected.push(b'\n');
    assert_eq!(r.result().0, expected);
}

#[test]
fn it_runs_in_the_requests_folder() {
    let dir = scratch("cwd");
    let r = run("60", request(&["/bin/pwd", "-P"], dir.to_str().unwrap(), &[]));
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert_eq!(String::from_utf8_lossy(&r.result().0), format!("{}\n", dir.display()));
}

#[test]
fn a_failing_program_is_named_by_its_code_and_its_errors_pass_on() {
    let r = run_argv(&["/bin/sh", "-c", "echo out; echo err >&2; exit 7"]);
    assert_eq!(r.code, Some(0), "the run mode itself exits 0 once the program ran: {}", r.err);
    let (out, v) = r.result();
    assert_eq!(String::from_utf8_lossy(&out), "out\n");
    assert_eq!((code_of(&v), signal_of(&v)), (Some(7), None));
    assert_eq!(r.err, "err\n");
}

#[test]
fn a_program_a_signal_ended_is_named_by_its_signal() {
    let r = run_argv(&["/bin/sh", "-c", "kill -TERM $$"]);
    assert_eq!(r.code, Some(0), "{}", r.err);
    let (_, v) = r.result();
    assert_eq!((code_of(&v), signal_of(&v)), (None, Some(15)));
}

#[test]
fn a_command_line_it_does_not_take_is_a_usage_error_and_starts_nothing() {
    let dir = scratch("usage");
    let mark = dir.join("started");
    let line = format!("echo started > {}", mark.display());
    let ok = request(&["/bin/sh", "-c", &line], "/", PATH_ONLY);
    let cases: [&[&str]; 12] = [
        &[],
        &["--timeout", "60"],
        &["--nonce", NONCE],
        &["--nonce", NONCE, "--timeout"],
        &["--nonce", NONCE, "--timeout", "29"],
        &["--nonce", NONCE, "--timeout", "901"],
        &["--nonce", NONCE, "--timeout", "60s"],
        &["--nonce", NONCE, "--timeout", "060"],
        &["--nonce", "0123456789ABCDEF0123456789ABCDEF", "--timeout", "60"],
        &["--nonce", NONCE, "--timeout", "60", "--shell"],
        &["--nonce", NONCE, "--timeout", "60", "--timeout", "61"],
        &["--nonce", NONCE, "--nonce", NONCE, "--timeout", "60"],
    ];
    for args in cases {
        let r = run_with(args, ok.clone(), Duration::from_secs(30));
        assert_eq!(r.code, Some(2), "{args:?}: {}", r.err);
        assert!(r.out.is_empty(), "{args:?}");
    }
    assert!(!mark.exists(), "a usage error started the program");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_request_it_refuses_starts_nothing() {
    let dir = scratch("refused");
    let mark = dir.join("started");
    let line = format!("echo started > {}", mark.display());
    let good = request(&["/bin/sh", "-c", &line], "/", PATH_ONLY);
    let mut long = request(&["/bin/sh", "-c", &line, &"x".repeat(MAX_REQUEST_BYTES)], "/", PATH_ONLY);
    long.truncate(MAX_REQUEST_BYTES + 10);
    let mut over_input = good.clone();
    over_input.extend(std::iter::repeat(b'x').take(MAX_INPUT_BYTES + 1));
    for (what, input) in [
        ("not JSON", b"not json\n".to_vec()),
        ("a field it does not take", format!("{{\"argv\":[\"/bin/sh\",\"-c\",{:?}],\"cwd\":\"/\",\"env\":{{}},\"shell\":\"/bin/sh\"}}\n", line).into_bytes()),
        ("a name with =", format!("{{\"argv\":[\"/bin/sh\",\"-c\",{:?}],\"cwd\":\"/\",\"env\":{{\"A=B\":\"x\"}}}}\n", line).into_bytes()),
        ("a relative program", request(&["sh", "-c", &line], "/", PATH_ONLY)),
        ("a relative folder", request(&["/bin/sh", "-c", &line], "tmp", PATH_ONLY)),
        ("no line end", good[..good.len() - 1].to_vec()),
        ("a request line past 64 KiB", long),
        ("an input past 2 MiB", over_input),
        ("no request at all", Vec::new()),
    ] {
        let r = run("60", input);
        assert_eq!(r.code, Some(1), "{what}: {}", r.err);
        assert!(r.out.is_empty(), "{what}: {:?}", String::from_utf8_lossy(&r.out));
        assert!(r.err.starts_with("aicc-helper: run: "), "{what}: {}", r.err);
    }
    assert!(!mark.exists(), "a refused request started the program");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_program_or_folder_that_is_not_there_starts_nothing() {
    let r = run_argv(&["/nonexistent-aicc-run-test/program"]);
    assert_eq!(r.code, Some(1), "{}", r.err);
    assert!(r.out.is_empty());
    let r = run("60", request(&["/bin/echo", "x"], "/nonexistent-aicc-run-test", &[]));
    assert_eq!(r.code, Some(1), "{}", r.err);
    assert!(r.out.is_empty());
    // A folder is not a program.
    let r = run_argv(&["/bin"]);
    assert_eq!(r.code, Some(1), "{}", r.err);
}

#[test]
fn the_timeout_ends_the_programs_whole_session() {
    // A child that waits on a grandchild of its own: both are in its session.
    // The shortest timeout the mode takes is 30 s.
    let r = run_with(&["--nonce", NONCE, "--timeout", "30"], request(&["/bin/sh", "-c", "sleep 300 & echo $!; wait"], "/", PATH_ONLY), Duration::from_secs(60));
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert!(r.took >= Duration::from_secs(30) && r.took < Duration::from_secs(45), "it took {:?}", r.took);
    let (out, v) = r.result();
    assert!(flag(&v, "timeout"));
    assert!(!flag(&v, "cut"));
    assert_eq!(code_of(&v), None, "ended by a signal, not by itself");
    assert!(matches!(signal_of(&v), Some(1) | Some(9)), "{v:?}");
    let pid = first_pid(&out);
    assert!(gone_within(pid, Duration::from_secs(5)), "the grandchild {pid} still runs");
}

#[test]
fn what_the_program_leaves_in_its_session_is_ended_when_it_exits() {
    let r = run_argv(&["/bin/sh", "-c", "sleep 300 >/dev/null 2>&1 & echo $!"]);
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert!(r.took < Duration::from_secs(10), "it took {:?}", r.took);
    let (out, v) = r.result();
    assert_eq!(code_of(&v), Some(0));
    let pid = first_pid(&out);
    assert!(gone_within(pid, Duration::from_secs(5)), "what it left, {pid}, still runs");
}

#[test]
fn output_past_the_cap_ends_the_program_and_no_byte_past_it_is_copied() {
    let r = run_argv(&["/usr/bin/yes", "aicc-run-cap"]);
    assert_eq!(r.code, Some(0), "{}", r.err);
    let (out, v) = r.result();
    assert!(flag(&v, "cut"), "{v:?}");
    assert!(!flag(&v, "timeout"));
    // Exactly the cap, then the line end the mode adds (the cap cuts a line).
    assert_eq!(out.len(), MAX_OUTPUT_BYTES + 1, "{} bytes before the result line", out.len());
    let line = b"aicc-run-cap\n";
    assert!(out[..MAX_OUTPUT_BYTES].chunks(line.len()).all(|c| line.starts_with(c)));
    assert_eq!(out[MAX_OUTPUT_BYTES], b'\n');
}

#[test]
fn output_at_the_cap_is_copied_whole_and_not_cut() {
    let script = format!("head -c {MAX_OUTPUT_BYTES} /dev/zero | tr '\\0' a");
    let r = run_argv(&["/bin/sh", "-c", &script]);
    assert_eq!(r.code, Some(0), "{}", r.err);
    let (out, v) = r.result();
    assert!(!flag(&v, "cut"), "{v:?}");
    assert_eq!(code_of(&v), Some(0));
    assert_eq!(out.len(), MAX_OUTPUT_BYTES + 1);
    assert!(out[..MAX_OUTPUT_BYTES].iter().all(|b| *b == b'a'));
}

#[test]
fn errors_past_their_cap_are_dropped_and_end_nothing() {
    let r = run_argv(&["/bin/sh", "-c", "head -c 200000 /dev/zero | tr '\\0' e >&2; echo done"]);
    assert_eq!(r.code, Some(0), "{}", r.err.len());
    let (out, v) = r.result();
    assert_eq!(String::from_utf8_lossy(&out), "done\n");
    assert_eq!((code_of(&v), flag(&v, "cut")), (Some(0), false));
    assert_eq!(r.err.len(), MAX_ERROR_BYTES);
    assert!(r.err.bytes().all(|b| b == b'e'));
}

#[test]
fn output_with_no_line_end_gets_one_before_the_result_line() {
    let r = run_argv(&["/usr/bin/printf", "abc"]);
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert_eq!(r.result().0, b"abc\n");
    // And none is added after output that ended with one, or no output.
    assert_eq!(run_argv(&["/usr/bin/printf", "abc\\n"]).result().0, b"abc\n");
    assert_eq!(run_argv(&["/usr/bin/true"]).result().0, b"");
}

/// The exec closes (the app's ssh ended): standard output goes away, and the
/// program's session is ended at once, not at its timeout.
#[cfg(target_os = "linux")]
#[test]
fn the_exec_closing_ends_the_programs_session() {
    let (mut child, writer) = start(&["--nonce", NONCE, "--timeout", "300"], request(&["/bin/sh", "-c", "echo $$; exec sleep 300"], "/", PATH_ONLY));
    let mut out = child.stdout.take().expect("its standard output");
    let mut first = Vec::new();
    let mut byte = [0u8; 1];
    while out.read(&mut byte).map(|n| n == 1).unwrap_or(false) {
        if byte[0] == b'\n' {
            break;
        }
        first.push(byte[0]);
    }
    let pid = first_pid(&first);
    drop(out);
    let started = Instant::now();
    let code = loop {
        if let Some(status) = child.try_wait().expect("look at the run mode") {
            break status.code();
        }
        if started.elapsed() > Duration::from_secs(15) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the run mode still ran 15 s after its standard output closed");
        }
        thread::sleep(Duration::from_millis(20));
    };
    let _ = writer.join();
    assert_eq!(code, Some(1));
    assert!(gone_within(pid, Duration::from_secs(5)), "the program {pid} still runs");
}
