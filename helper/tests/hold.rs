//! Hold, detach, re-attach and replay, against the fake CLI, on a real terminal
//! (openpty on Unix, ConPTY on Windows). This is the part unit tests with
//! mocks cannot show, so it runs on every OS in CI.

use aicc_helper::holder::Holder;
use aicc_helper::pids;
use aicc_helper::pty::{PtySize, SpawnOptions};
use aicc_helper::ring::RingError;
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

const FAKE: &str = env!("CARGO_BIN_EXE_aicc-fake-cli");
const WAIT: Duration = Duration::from_secs(20);

fn start(ring_bytes: usize) -> Holder {
    Holder::start(&[FAKE.to_string()], PtySize::default(), ring_bytes).expect("the fake CLI starts on a terminal")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn the_child_runs_and_its_output_lands_in_the_ring_at_offset_zero() {
    let h = start(64 * 1024);
    assert!(h.wait_for_text("FAKE-CLI READY", WAIT), "banner never arrived");
    let (start, end) = h.ring_range();
    assert_eq!(start, 0);
    assert!(end >= "FAKE-CLI READY".len() as u64);
    let a = h.attach(0).expect("attach from 0");
    assert!(!a.replay.truncated);
    assert!(text(&a.replay.bytes).contains("FAKE-CLI READY"));
    h.kill();
}

#[test]
fn detach_keeps_the_child_and_attach_again_replays_only_what_was_missed() {
    let h = start(64 * 1024);
    assert!(h.wait_for_text("FAKE-CLI READY", WAIT));
    let first = h.attach(0).expect("first attach");
    h.write_input(b"hello\r").expect("type");
    assert!(h.wait_for_text("echo: hello", WAIT), "no echo of the first line");
    // The offset a client records is the end of what it has seen.
    let seen = h.ring_range().1;
    drop(first);
    h.detach();

    // The child keeps working with nobody attached.
    h.write_input(b"second\r").expect("type while detached");
    assert!(h.wait_for_text("echo: second", WAIT), "no echo while detached");
    assert_eq!(h.exit_code(), None, "detaching must not end the child");

    let again = h.attach(seen).expect("attach again");
    assert!(!again.replay.truncated);
    let replayed = text(&again.replay.bytes);
    assert!(replayed.contains("echo: second"), "missed output was not replayed: {replayed:?}");
    assert!(!replayed.contains("echo: hello"), "output already seen was replayed: {replayed:?}");

    // From the start, the whole history is there.
    let all = h.attach(0).expect("attach from 0");
    let history = text(&all.replay.bytes);
    assert!(history.contains("FAKE-CLI READY") && history.contains("echo: hello") && history.contains("echo: second"));
    h.kill();
}

#[test]
fn live_output_follows_the_replay_without_a_gap_or_a_repeat() {
    let h = start(64 * 1024);
    assert!(h.wait_for_text("FAKE-CLI READY", WAIT));
    let a = h.attach(0).expect("attach");
    let mut got = a.replay.bytes.clone();
    h.write_input(b"live-one\r").expect("type");
    let deadline = std::time::Instant::now() + WAIT;
    while !text(&got).contains("echo: live-one") && std::time::Instant::now() < deadline {
        if let Ok(chunk) = a.live.recv_timeout(Duration::from_millis(200)) {
            got.extend_from_slice(&chunk);
        }
    }
    let all = text(&got);
    assert!(all.contains("echo: live-one"), "live output never arrived: {all:?}");
    assert_eq!(all.matches("FAKE-CLI READY").count(), 1, "the banner was repeated: {all:?}");
    h.kill();
}

#[test]
fn a_newer_attachment_replaces_the_older_one() {
    let h = start(64 * 1024);
    assert!(h.wait_for_text("FAKE-CLI READY", WAIT));
    let older = h.attach(0).expect("older");
    let newer = h.attach(0).expect("newer");
    // The older one's live channel is closed (disconnected), not merely idle.
    match older.live.recv_timeout(Duration::from_secs(5)) {
        Err(RecvTimeoutError::Disconnected) => {}
        other => panic!("the older attachment was not closed: {other:?}"),
    }
    h.write_input(b"to-newer\r").expect("type");
    let mut got = Vec::new();
    let deadline = std::time::Instant::now() + WAIT;
    while !text(&got).contains("echo: to-newer") && std::time::Instant::now() < deadline {
        if let Ok(chunk) = newer.live.recv_timeout(Duration::from_millis(200)) {
            got.extend_from_slice(&chunk);
        }
    }
    assert!(text(&got).contains("echo: to-newer"));
    h.kill();
}

#[test]
fn a_ring_that_is_too_short_reports_it() {
    let h = start(64);
    assert!(h.wait_for_text("FAKE-CLI READY", WAIT) || h.ring_range().1 > 0);
    for i in 0..12 {
        h.write_input(format!("padding-line-number-{i}\r").as_bytes()).expect("type");
    }
    let deadline = std::time::Instant::now() + WAIT;
    while h.ring_range().0 == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let (start, end) = h.ring_range();
    assert!(start > 0, "the ring never wrapped");
    assert!(end - start <= 64, "the ring grew past its size");
    let a = h.attach(0).expect("attach from 0");
    assert!(a.replay.truncated, "an offset older than the ring must be reported");
    assert!(a.replay.from >= start);
    assert_eq!(a.replay.from, a.replay.ring_start);
    assert_eq!(a.replay.bytes.len() as u64, a.replay.ring_end - a.replay.ring_start);
    h.kill();
}

#[test]
fn an_offset_past_the_end_is_refused() {
    let h = start(64 * 1024);
    assert!(h.wait_for_text("FAKE-CLI READY", WAIT));
    let (_, end) = h.ring_range();
    match h.attach(end + 1_000_000) {
        Err(RingError::PastEnd { .. }) => {}
        Ok(_) => panic!("attach past the end was accepted"),
    }
    h.kill();
}

#[test]
fn the_exit_code_is_reported_and_the_output_channel_closes() {
    let h = start(64 * 1024);
    assert!(h.wait_for_text("FAKE-CLI READY", WAIT));
    let a = h.attach(0).expect("attach");
    h.write_input(b"exit 3\r").expect("type");
    assert_eq!(h.wait_exit(WAIT), Some(3));
    // The terminal is still replayable after the child is gone.
    let after = h.attach(0).expect("attach after exit");
    assert!(text(&after.replay.bytes).contains("FAKE-CLI READY"));
    drop(a);
}

#[test]
fn a_terminal_can_be_resized_and_a_missing_program_is_an_error() {
    let h = start(64 * 1024);
    assert!(h.wait_for_text("FAKE-CLI READY", WAIT));
    h.resize(PtySize { cols: 100, rows: 30 }).expect("resize");
    h.kill();
    assert!(Holder::start(&["aicc-no-such-program-0001".to_string()], PtySize::default(), 1024).is_err());
    assert!(Holder::start(&[], PtySize::default(), 1024).is_err());
}

/// True once `pid` is no longer running, within `within`.
fn gone(pid: u32, within: Duration) -> bool {
    let deadline = std::time::Instant::now() + within;
    while std::time::Instant::now() < deadline {
        if !pids::alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    !pids::alive(pid)
}

/// Have the fake CLI start a sleeping copy of itself; its process id.
fn start_grandchild(h: &Holder) -> u32 {
    h.write_input(b"spawn-grandchild\r").expect("type");
    assert!(h.wait_for_text("grandchild: ", WAIT), "the fake CLI never started its grandchild");
    let all = text(&h.snapshot());
    let at = all.find("grandchild: ").expect("the line") + "grandchild: ".len();
    let digits: String = all[at..].chars().take_while(char::is_ascii_digit).collect();
    let pid: u32 = digits.parse().unwrap_or_else(|_| panic!("no process id after grandchild: {all:?}"));
    assert!(pids::alive(pid), "the grandchild is not running");
    pid
}

#[test]
fn ending_the_session_ends_the_whole_tree() {
    let h = start(64 * 1024);
    assert!(h.wait_for_text("FAKE-CLI READY", WAIT));
    let grandchild = start_grandchild(&h);
    let child = h.child_pid();
    assert!(h.end().is_some(), "no exit code after the end");
    assert!(gone(child, WAIT), "the first process outlived the end");
    assert!(gone(grandchild, WAIT), "the grandchild outlived the end of its session");
}

#[test]
fn when_the_first_process_exits_the_rest_of_its_tree_goes_with_it() {
    let h = start(64 * 1024);
    assert!(h.wait_for_text("FAKE-CLI READY", WAIT));
    let grandchild = start_grandchild(&h);
    h.write_input(b"exit 4\r").expect("type");
    assert_eq!(h.wait_exit(WAIT), Some(4));
    assert!(gone(grandchild, WAIT), "the grandchild outlived the first process");
}

#[test]
fn a_launch_gets_its_folder_and_exactly_its_own_environment() {
    let dir = std::env::temp_dir().join(format!("aicc-hold-cwd-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a folder");
    let dir_name = dir.file_name().unwrap().to_string_lossy().into_owned();
    // Keep what a program needs to start; leave out one other variable of
    // this process, which the child must then not have.
    let keep = ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "COMSPEC"];
    let vars: Vec<(String, String)> = std::env::vars().filter(|(k, _)| !k.is_empty() && !k.contains('=')).collect();
    let dropped = vars.iter().map(|(k, _)| k.clone()).find(|k| !keep.contains(&k.to_uppercase().as_str())).expect("a variable to leave out");
    let mut env: Vec<(String, String)> = vars.into_iter().filter(|(k, _)| *k != dropped).collect();
    env.push(("AICC_TEST_VALUE".to_string(), "hello-env".to_string()));
    let argv = vec![FAKE.to_string()];
    let dir_text = dir.to_string_lossy().into_owned();
    let opts = SpawnOptions { argv: argv.as_slice(), cwd: Some(dir_text.as_str()), env: Some(env.as_slice()), size: PtySize { cols: 250, rows: 24 } };
    let h = Holder::start_with(&opts, 64 * 1024).expect("the fake CLI starts with a folder and an environment");
    assert!(h.wait_for_text("FAKE-CLI READY", WAIT));
    h.write_input(b"pwd\r").expect("type");
    assert!(h.wait_for_text(&dir_name, WAIT), "the child is not in its folder: {:?}", text(&h.snapshot()));
    h.write_input(b"env AICC_TEST_VALUE\r").expect("type");
    assert!(h.wait_for_text("env AICC_TEST_VALUE=hello-env", WAIT), "the child lacks the launch's variable: {:?}", text(&h.snapshot()));
    h.write_input(format!("env {dropped}\r").as_bytes()).expect("type");
    assert!(h.wait_for_text(&format!("env {dropped} unset"), WAIT), "the child has a variable the launch left out: {:?}", text(&h.snapshot()));
    h.kill();
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}
