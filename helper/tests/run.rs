//! The run mode (`aicc-helper run --timeout <seconds>`, from 2.1.3-beta.21,
//! ADR-030 protocol change 6) as a program, the way the app runs it on a
//! remote machine for a review there (nubbymong/aicc_planning#446): the spec
//! line and the program's input on standard input; the program started from
//! its argv alone, with no shell, in its folder, with its environment alone;
//! its output passed on up to the cap; its whole process group ended at the
//! timeout, at the cap, when the exec closes, and (what it left) when it
//! exits by itself. macOS and Linux only: on Windows the mode does not run.
#![cfg(unix)]

use aicc_helper::json::Value;
use aicc_helper::pids;
use aicc_helper::run::{MAX_INPUT_BYTES, MAX_OUTPUT_BYTES};
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");

/// A spec line for `argv` in `cwd` with `env`, and its line end.
fn spec(argv: &[&str], cwd: &str, env: &[(&str, &str)]) -> Vec<u8> {
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

/// The run mode started on `args`, with `request` written to its standard
/// input and then closed.
fn start(args: &[&str], request: Vec<u8>) -> (Child, JoinHandle<()>) {
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
        let _ = stdin.write_all(&request);
    });
    (child, writer)
}

/// What a started run printed and how it exited, giving up after 30 s.
fn finish(mut child: Child, writer: JoinHandle<()>) -> Ran {
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
    let deadline = started + Duration::from_secs(30);
    let code = loop {
        if let Some(status) = child.try_wait().expect("look at the run mode") {
            break status.code();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the run mode still ran after 30 s");
        }
        thread::sleep(Duration::from_millis(20));
    };
    let took = started.elapsed();
    let _ = writer.join();
    let out = reading.join().expect("its output");
    let err = String::from_utf8_lossy(&erring.join().expect("its errors")).into_owned();
    Ran { code, out, err, took }
}

fn run(args: &[&str], request: Vec<u8>) -> Ran {
    let (child, writer) = start(args, request);
    finish(child, writer)
}

/// The run on `argv` in `/` with only a PATH (for the commands a test's
/// /bin/sh line runs) and no input, within 30 s.
fn run_argv(argv: &[&str], timeout: &str) -> Ran {
    run(&["--timeout", timeout], spec(argv, "/", &[("PATH", "/usr/bin:/bin")]))
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

#[test]
fn the_program_gets_its_argv_word_for_word_with_no_shell_between() {
    let r = run_argv(&["/bin/echo", "a; echo b", "$(id)", "*", "`id`"], "10");
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert_eq!(String::from_utf8_lossy(&r.out), "a; echo b $(id) * `id`\n");
}

#[test]
fn only_the_specs_environment_reaches_it() {
    let r = run(&["--timeout", "10"], spec(&["/usr/bin/env"], "/", &[("AICC_RUN_ONLY", "1")]));
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert_eq!(String::from_utf8_lossy(&r.out), "AICC_RUN_ONLY=1\n");
}

#[test]
fn what_follows_the_spec_line_is_its_standard_input_byte_for_byte() {
    let mut request = spec(&["/bin/cat"], "/", &[]);
    let input = b"line one\nline two {\"not\": \"a spec\"}\n\x00\x01 last".to_vec();
    request.extend_from_slice(&input);
    let r = run(&["--timeout", "10"], request);
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert_eq!(r.out, input);
}

#[test]
fn it_runs_in_the_specs_folder() {
    let dir = std::env::temp_dir().join(format!("aicc-run-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a folder");
    let real = std::fs::canonicalize(&dir).expect("its real path");
    let r = run(&["--timeout", "10"], spec(&["/bin/pwd", "-P"], real.to_str().unwrap(), &[]));
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert_eq!(String::from_utf8_lossy(&r.out), format!("{}\n", real.display()));
}

#[test]
fn a_relative_program_or_folder_is_refused_and_nothing_runs() {
    for (argv, cwd) in [(vec!["echo", "x"], "/"), (vec!["/bin/echo", "x"], "relative"), (vec!["./echo"], "/")] {
        let r = run(&["--timeout", "10"], spec(&argv, cwd, &[]));
        assert_eq!(r.code, Some(2), "{argv:?} in {cwd}: {}", r.err);
        assert!(r.out.is_empty());
    }
}

#[test]
fn a_program_or_folder_that_is_not_there_starts_nothing() {
    let r = run_argv(&["/nonexistent-aicc-run-test/program"], "10");
    assert_eq!(r.code, Some(3), "{}", r.err);
    let r = run(&["--timeout", "10"], spec(&["/bin/echo", "x"], "/nonexistent-aicc-run-test", &[]));
    assert_eq!(r.code, Some(3), "{}", r.err);
    assert!(r.out.is_empty());
}

#[test]
fn a_command_line_or_a_spec_it_does_not_take_is_a_usage_error() {
    let ok = spec(&["/bin/echo", "x"], "/", &[]);
    let long_arg = "x".repeat(70 * 1024);
    let cases: [&[&str]; 7] = [&[], &["--timeout"], &["--timeout", "0"], &["--timeout", "901"], &["--timeout", "5s"], &["--timeout", "5", "--shell"], &["--timeout", "5", "--timeout", "6"]];
    for args in cases {
        let r = run(args, ok.clone());
        assert_eq!(r.code, Some(2), "{args:?}: {}", r.err);
        assert!(r.out.is_empty());
    }
    for request in [
        b"not json\n".to_vec(),
        b"{\"argv\":[\"/bin/echo\"],\"cwd\":\"/\",\"env\":{},\"shell\":\"/bin/sh\"}\n".to_vec(),
        b"{\"argv\":[\"/bin/echo\"],\"cwd\":\"/\",\"env\":{\"A=B\":\"x\"}}\n".to_vec(),
        // No line end: the spec line is never whole.
        b"{\"argv\":[\"/bin/echo\"],\"cwd\":\"/\",\"env\":{}}".to_vec(),
        // A spec line past its bound.
        {
            let mut long = spec(&["/bin/echo", long_arg.as_str()], "/", &[]);
            long.truncate(70 * 1024);
            long
        },
    ] {
        let r = run(&["--timeout", "5"], request);
        assert_eq!(r.code, Some(2), "{}", r.err);
        assert!(r.out.is_empty());
    }
}

#[test]
fn input_past_its_bound_is_refused_and_nothing_runs() {
    let mut request = spec(&["/bin/cat"], "/", &[]);
    request.extend(std::iter::repeat(b'x').take(MAX_INPUT_BYTES + 1));
    let r = run(&["--timeout", "10"], request);
    assert_eq!(r.code, Some(2), "{}", r.err);
    assert!(r.out.is_empty());
}

#[test]
fn a_failing_program_is_named_by_its_exit_code() {
    let r = run_argv(&["/bin/sh", "-c", "echo out; echo err >&2; exit 7"], "10");
    assert_eq!(r.code, Some(1), "{}", r.err);
    assert_eq!(String::from_utf8_lossy(&r.out), "out\n");
    assert!(r.err.starts_with("err\n"), "{}", r.err);
    assert!(r.err.contains("the program exited with code 7"), "{}", r.err);
}

#[test]
fn the_timeout_ends_the_programs_whole_group() {
    // A child that waits on a grandchild of its own: both are in the group.
    let r = run_argv(&["/bin/sh", "-c", "sleep 60 & echo $!; wait"], "1");
    assert_eq!(r.code, Some(4), "{}", r.err);
    assert!(r.took < Duration::from_secs(10), "it took {:?}", r.took);
    assert!(r.err.contains("ran past its 1 s"), "{}", r.err);
    let pid = first_pid(&r.out);
    assert!(gone_within(pid, Duration::from_secs(5)), "the grandchild {pid} still runs");
}

#[test]
fn what_the_program_leaves_in_its_group_is_ended_when_it_exits() {
    let r = run_argv(&["/bin/sh", "-c", "sleep 60 >/dev/null 2>&1 & echo $!"], "30");
    assert_eq!(r.code, Some(0), "{}", r.err);
    assert!(r.took < Duration::from_secs(10), "it took {:?}", r.took);
    let pid = first_pid(&r.out);
    assert!(gone_within(pid, Duration::from_secs(5)), "what it left, {pid}, still runs");
}

#[test]
fn output_past_the_cap_ends_the_program_and_no_byte_past_it_is_passed_on() {
    let r = run_argv(&["/usr/bin/yes", "aicc-run-cap"], "60");
    assert_eq!(r.code, Some(5), "{}", r.err);
    assert!(!r.out.is_empty());
    assert!(r.out.len() <= MAX_OUTPUT_BYTES, "{} bytes passed on", r.out.len());
}

/// The exec closes (the app's ssh ended): standard output goes away, and the
/// program's group is ended at once, not at its timeout.
#[cfg(target_os = "linux")]
#[test]
fn the_exec_closing_ends_the_programs_group() {
    let (mut child, writer) = start(&["--timeout", "60"], spec(&["/bin/sh", "-c", "echo $$; exec sleep 60"], "/", &[("PATH", "/usr/bin:/bin")]));
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
    assert_eq!(code, Some(6));
    assert!(gone_within(pid, Duration::from_secs(5)), "the program {pid} still runs");
}
