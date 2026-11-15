//! The helper as a program: `hold`, `attach`, `end`, `selftest` and `hello`,
//! each run as a separate process, the way the probes run them. Attaching
//! from another process, after the first attach has ended, is the part that
//! stands in for "the app reconnects to a holder it did not start".

use aicc_helper::json::{self, Value};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
const FAKE: &str = env!("CARGO_BIN_EXE_aicc-fake-cli");
const NONCE: &str = "0123456789abcdef0123456789abcdef";

fn session_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("aicc-helper-test-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("a folder for the session");
    dir
}

struct Ran {
    ok: bool,
    stdout: String,
    stderr: String,
}

fn helper(args: &[&str]) -> Ran {
    let out = Command::new(HELPER).args(args).output().expect("run the helper");
    Ran { ok: out.status.success(), stdout: String::from_utf8_lossy(&out.stdout).into_owned(), stderr: String::from_utf8_lossy(&out.stderr).into_owned() }
}

/// Run `hold --detach` with its output going to files, not pipes. The holder
/// outlives this call, so a pipe would stay open until it ends and a reader
/// waiting for end of file would wait with it. Files do not have that problem,
/// and the helper also clears inheritance on its own standard handles.
fn helper_detaching(args: &[&str], tag: &str) -> Ran {
    let base = std::env::temp_dir().join(format!("aicc-helper-detach-{tag}-{}", std::process::id()));
    let out_path = base.with_extension("out");
    let err_path = base.with_extension("err");
    let status = Command::new(HELPER)
        .args(args)
        .stdin(Stdio::null())
        .stdout(fs::File::create(&out_path).expect("a file for stdout"))
        .stderr(fs::File::create(&err_path).expect("a file for stderr"))
        .status()
        .expect("run the helper");
    let ran = Ran {
        ok: status.success(),
        stdout: fs::read_to_string(&out_path).unwrap_or_default(),
        stderr: fs::read_to_string(&err_path).unwrap_or_default(),
    };
    let _ = fs::remove_file(&out_path);
    let _ = fs::remove_file(&err_path);
    ran
}

fn as_json(ran: &Ran) -> Value {
    json::parse(ran.stdout.trim().as_bytes()).unwrap_or_else(|e| panic!("stdout is not JSON ({e:?}): {:?} / stderr {:?}", ran.stdout, ran.stderr))
}

fn wait_for_file(path: &std::path::Path, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn field<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or_else(|| panic!("missing {key} in {}", v.to_json()))
}

#[test]
fn a_holder_started_by_one_process_is_attached_to_by_others_and_replays() {
    let dir = session_dir("hold");
    let dir_arg = dir.to_string_lossy().into_owned();
    let mut holder = Command::new(HELPER)
        .args(["hold", "--dir", &dir_arg, "--session", "probe-0001", "--", FAKE])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start the holder");
    assert!(wait_for_file(&dir.join("holder.json"), 30), "holder.json never appeared");
    let info = json::parse(&fs::read(dir.join("holder.json")).expect("read holder.json")).expect("holder.json is JSON");
    assert!(field(&info, "holder_pid").as_u64().unwrap_or(0) > 0);
    assert!(field(&info, "child_pid").as_u64().unwrap_or(0) > 0);
    assert_eq!(field(&info, "session").as_str(), Some("probe-0001"));

    // First attach: the banner is there from offset 0.
    let first = helper(&["attach", "--dir", &dir_arg, "--from", "0", "--wait-ms", "3000"]);
    assert!(first.ok, "{}", first.stderr);
    let first = as_json(&first);
    assert!(field(&first, "replay").as_str().unwrap_or("").contains("FAKE-CLI READY") || field(&first, "live").as_str().unwrap_or("").contains("FAKE-CLI READY"));
    let seen = field(&first, "ring_end").as_u64().expect("ring_end");

    // A later process types into the terminal and sees the answer.
    let second = helper(&["attach", "--dir", &dir_arg, "--from", &seen.to_string(), "--send", "after", "--wait-ms", "8000"]);
    assert!(second.ok, "{}", second.stderr);
    let second = as_json(&second);
    assert!(field(&second, "live").as_str().unwrap_or("").contains("echo: after"), "no answer: {}", second.to_json());

    // A third process attaches from 0 and is replayed everything, both parts.
    let third = helper(&["attach", "--dir", &dir_arg, "--from", "0"]);
    assert!(third.ok, "{}", third.stderr);
    let third = as_json(&third);
    let replay = field(&third, "replay").as_str().unwrap_or("").to_string();
    assert!(replay.contains("FAKE-CLI READY") && replay.contains("echo: after"), "replay: {replay:?}");

    // An offset past the end is refused.
    let past = helper(&["attach", "--dir", &dir_arg, "--from", "999999999"]);
    assert!(!past.ok);

    // End: the holder stops the child, says so, and exits.
    let ended = helper(&["end", "--dir", &dir_arg]);
    assert!(ended.ok, "{}", ended.stderr);
    let exit = json::parse(&fs::read(dir.join("exit.json")).expect("read exit.json")).expect("exit.json is JSON");
    assert_eq!(field(&exit, "reason").as_str(), Some("stopped"));
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match holder.try_wait().expect("wait for the holder") {
            Some(status) => {
                assert!(status.success());
                break;
            }
            None if Instant::now() > deadline => {
                let _ = holder.kill();
                panic!("the holder did not exit after end");
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn hold_detach_starts_a_holder_that_keeps_running_after_the_command_returns() {
    let dir = session_dir("detach");
    let dir_arg = dir.to_string_lossy().into_owned();
    let started = helper_detaching(&["hold", "--detach", "--dir", &dir_arg, "--session", "probe-0002", "--", FAKE], "keeps");
    assert!(started.ok, "{}", started.stderr);
    let info = as_json(&started);
    let holder_pid = field(&info, "holder_pid").as_u64().expect("holder_pid");
    assert!(holder_pid > 0);
    // The command that started it has returned; the holder still answers.
    let seen = helper(&["attach", "--dir", &dir_arg, "--from", "0", "--wait-ms", "3000"]);
    assert!(seen.ok, "{}", seen.stderr);
    let seen = as_json(&seen);
    assert!(field(&seen, "replay").as_str().unwrap_or("").contains("FAKE-CLI READY") || field(&seen, "live").as_str().unwrap_or("").contains("FAKE-CLI READY"));
    assert_eq!(field(&seen, "exited").as_bool(), Some(false));
    let ended = helper(&["end", "--dir", &dir_arg]);
    assert!(ended.ok, "{}", ended.stderr);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_holder_exits_when_the_child_does_and_says_so() {
    let dir = session_dir("exit");
    let dir_arg = dir.to_string_lossy().into_owned();
    let started = helper_detaching(&["hold", "--detach", "--dir", &dir_arg, "--session", "probe-0003", "--", FAKE], "exit");
    assert!(started.ok, "{}", started.stderr);
    let sent = helper(&["attach", "--dir", &dir_arg, "--send", "quit", "--wait-ms", "5000"]);
    assert!(sent.ok, "{}", sent.stderr);
    assert!(wait_for_file(&dir.join("exit.json"), 20), "exit.json never appeared");
    let exit = json::parse(&fs::read(dir.join("exit.json")).expect("read exit.json")).expect("exit.json is JSON");
    assert_eq!(field(&exit, "reason").as_str(), Some("exited"));
    assert_eq!(field(&exit, "code").as_u64(), Some(0));
    let after = helper(&["attach", "--dir", &dir_arg, "--from", "0"]);
    assert!(after.ok, "{}", after.stderr);
    let after = as_json(&after);
    assert!(field(&after, "replay").as_str().unwrap_or("").contains("FAKE-CLI BYE"));
    assert_eq!(field(&after, "exited").as_bool(), Some(true));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selftest_passes_and_prints_one_result_line() {
    let ran = helper(&["selftest", "--nonce", NONCE]);
    assert!(ran.ok, "selftest failed: {} / {}", ran.stdout, ran.stderr);
    let line = ran.stdout.trim();
    let prefix = format!("AICC-RESULT {NONCE} ");
    assert!(line.starts_with(&prefix), "{line:?}");
    let body = json::parse(line[prefix.len()..].as_bytes()).expect("the result is JSON");
    assert_eq!(field(&body, "ok").as_bool(), Some(true));
    let checks = field(&body, "checks").as_array().expect("checks");
    let names: Vec<&str> = checks.iter().map(|c| field(c, "name").as_str().expect("name")).collect();
    assert_eq!(names, vec!["frame-codec", "hello", "ring", "terminal-hold-attach"]);
}

#[test]
fn hello_prints_a_line_the_parser_accepts() {
    let ran = helper(&["hello", "--nonce", NONCE, "--session", "sess-0001", "--state", "new"]);
    assert!(ran.ok, "{}", ran.stderr);
    let parsed = aicc_helper::hello::parse_hello_line(ran.stdout.trim(), NONCE, "sess-0001").expect("the hello reads");
    assert_eq!(parsed.proto, vec![1]);
    assert_eq!(parsed.state, "new");
    let bad = helper(&["hello", "--nonce", "short", "--session", "sess-0001"]);
    assert!(!bad.ok);
}
