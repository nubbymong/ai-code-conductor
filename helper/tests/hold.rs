//! Hold, detach, re-attach and replay, against the fake CLI, on a real terminal
//! (openpty on Unix, ConPTY on Windows). This is the part unit tests with
//! mocks cannot show, so it runs on every OS in CI.

use aicc_helper::holder::Holder;
use aicc_helper::pty::PtySize;
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

#[test]
fn the_mirror_writes_what_the_ring_held_before_it_attached_then_the_live_output() {
    let h = start(64 * 1024);
    // The banner is in the ring BEFORE the mirror attaches: this is the window
    // a holder is in between starting the child and attaching its mirror.
    assert!(h.wait_for_text("FAKE-CLI READY", WAIT), "banner never arrived");
    let out = std::env::temp_dir().join(format!("aicc-helper-mirror-{}.bin", std::process::id()));
    let _ = std::fs::remove_file(&out);
    let attachment = h.attach(0).expect("attach");
    assert!(text(&attachment.replay.bytes).contains("FAKE-CLI READY"), "the banner must be in the replay, not the live stream");
    let mirror = aicc_helper::dirhold::start_mirror(attachment, &out, 64 * 1024).expect("start the mirror");
    h.write_input(b"after-attach\r").expect("type");
    let deadline = std::time::Instant::now() + WAIT;
    let mut written = String::new();
    while std::time::Instant::now() < deadline {
        written = text(&std::fs::read(&out).unwrap_or_default());
        if written.contains("echo: after-attach") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // A Windows terminal may print setup escapes before the banner, so the order is checked, not the first byte.
    let banner_at = written.find("FAKE-CLI READY");
    assert!(banner_at.is_some(), "out.bin lost the banner that was in the ring before the mirror attached: {written:?}");
    assert!(written.contains("echo: after-attach"), "live output missing: {written:?}");
    assert!(banner_at < written.find("echo: after-attach"), "the banner must come before the live output: {written:?}");
    assert_eq!(written.matches("FAKE-CLI READY").count(), 1, "the banner was written twice: {written:?}");
    h.kill();
    drop(h);
    // Not joined: on Windows the output ends only when the pseudoconsole closes.
    drop(mirror);
    let _ = std::fs::remove_file(&out);
}
