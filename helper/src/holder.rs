//! The holder: owns one terminal with one child, keeps an output ring, and lets
//! a terminal client attach, detach and attach again (protocol sections 5 and
//! 15).
//!
//! This is the terminal half. `serve.rs` puts it behind the local pipe or
//! socket; the tests also drive it in one process.
//!
//! Slots: the holder has a terminal slot. The newest `attach` takes it; the one
//! it replaced has its live channel closed, which is how an older connection
//! learns it was replaced.
//!
//! When the first process exits, the holder ends what is left of its tree,
//! lets the last output drain, and only then reports the exit code and closes
//! the live channel. So a client that sees the channel close with
//! `exit_code()` set has had every byte the terminal gave up within `DRAIN`
//! (2 s) of the exit; output still coming after that is not waited for.
//!
//! The hook queue (`HookQueue`, capability `hooks`) is the holder's too: the
//! hook events of the session, numbered, waiting while no connection that
//! takes them is attached. It belongs to the holder process, not to a
//! launch: an event may come before anything is launched.
//!
//! The screen (`screen.rs`, from 2.1.3-beta.12) is the holder's too: every
//! chunk of output goes to the ring and the attached client first, then to
//! the screen, on the output thread, for the session's whole life; a resize
//! resizes the terminal, then the screen. The screen has a lock of its own,
//! taken after the state's is let go, so a read of it never holds up an
//! attach or the ring. A panic in the screen's parser is caught: the screen
//! is then not kept any more (a read of it says so), and the output, the
//! ring and the attached client go on as before.

use crate::json::Value;
use crate::pty::{Conpty, Pty, PtySize, SpawnOptions};
use crate::ring::{Replay, Ring, RingError};
use crate::screen::{self, Screen};
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::panic::{self, AssertUnwindSafe};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

/// How many output chunks an attachment may leave unread. A chunk is at most 16
/// KiB, so this caps what a client that stops reading can make the holder keep.
/// A client that falls this far behind is disconnected and recovers by
/// attaching again from the offset it last saw (the ring replays the rest).
pub const LIVE_QUEUE_CHUNKS: usize = 256;

/// Input frames waiting for the program to read them. A frame is at most 64
/// KiB. A program that stops reading fills this, and later input is refused
/// at once instead of waited on, so nothing that ends the session can be held
/// up behind a write the program will never take.
pub const INPUT_QUEUE_FRAMES: usize = 64;

/// How long the rest of the tree has after a hangup before it is killed.
pub const END_GRACE: Duration = Duration::from_secs(2);

/// How long the last output may take to drain once the first process exited.
pub const DRAIN: Duration = Duration::from_secs(2);

/// The most hook events that wait for a connection that takes them.
pub const HOOK_QUEUE_EVENTS: usize = 256;

/// The most payload, as JSON, that waits for a connection that takes hook
/// events: 2 MiB.
pub const HOOK_QUEUE_BYTES: usize = 2 * 1024 * 1024;

/// One hook event, numbered with its session's `seq`.
#[derive(Debug, Clone, PartialEq)]
pub struct HookEvent {
    pub seq: u64,
    pub kind: String,
    pub payload: Value,
    /// The payload's size as JSON, counted against `HOOK_QUEUE_BYTES`.
    pub bytes: usize,
}

/// A session's hook events: each takes the next `seq` (from 1), then waits
/// here until it is sent. While no connection takes them the queue keeps at
/// most `HOOK_QUEUE_EVENTS` events and `HOOK_QUEUE_BYTES` of payload, the
/// oldest dropped first; the event sent next carries how many were dropped
/// (`lost`). One event is at most 64 KiB, so the newest is always kept.
#[derive(Debug, Default)]
pub struct HookQueue {
    last_seq: u64,
    waiting: VecDeque<HookEvent>,
    bytes: usize,
    lost: u64,
}

impl HookQueue {
    pub fn new() -> HookQueue {
        HookQueue::default()
    }

    /// Number an event and keep it; its `seq`. An event over a bound drops
    /// the oldest waiting until both bounds hold again.
    pub fn push(&mut self, kind: String, payload: Value, bytes: usize) -> u64 {
        self.last_seq += 1;
        let seq = self.last_seq;
        self.bytes += bytes;
        self.waiting.push_back(HookEvent { seq, kind, payload, bytes });
        while self.waiting.len() > 1 && (self.waiting.len() > HOOK_QUEUE_EVENTS || self.bytes > HOOK_QUEUE_BYTES) {
            if let Some(old) = self.waiting.pop_front() {
                self.bytes -= old.bytes;
                self.lost += 1;
            }
        }
        seq
    }

    /// The oldest waiting event, and how many were dropped before it: what
    /// its `event` message carries as `lost` (0: nothing to say).
    pub fn front(&self) -> Option<(&HookEvent, u64)> {
        self.waiting.front().map(|ev| (ev, self.lost))
    }

    /// The oldest waiting event was sent: it goes, and the count it carried
    /// starts again from 0.
    pub fn sent(&mut self) {
        if let Some(ev) = self.waiting.pop_front() {
            self.bytes -= ev.bytes;
            self.lost = 0;
        }
    }
}

/// Hand `chunk` to an attachment without ever waiting. False means the
/// attachment is gone or too far behind and should be let go.
fn offer(tx: &SyncSender<Vec<u8>>, chunk: Vec<u8>) -> bool {
    match tx.try_send(chunk) {
        Ok(()) => true,
        Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => false,
    }
}

struct State {
    ring: Ring,
    terminal: Option<SyncSender<Vec<u8>>>,
    /// Set once the first process has exited AND the output has drained.
    exit_code: Option<i32>,
    output_ended: bool,
}

struct Shared {
    state: Mutex<State>,
    /// The session's screen; None once its parser panicked (it is not kept
    /// any more). Locked after `state` is let go, never with it.
    screen: Mutex<Option<Screen>>,
}

/// Feed one chunk of output to the screen. A panic in the parser is caught,
/// and the screen is let go: it would no longer show the session.
fn feed_screen(shared: &Shared, bytes: &[u8]) {
    let mut slot = lock(&shared.screen);
    if let Some(s) = slot.as_mut() {
        if panic::catch_unwind(AssertUnwindSafe(|| s.feed(bytes))).is_err() {
            *slot = None;
        }
    }
}

/// A test's gate (`SCREEN_GATE`): once the ring holds its text, wait for the
/// test before the chunk goes to the screen, once.
#[cfg(test)]
fn hold_the_screen(shared: &Shared, gate: &mut Option<(String, Receiver<()>)>) {
    let held = match gate {
        Some((text, _)) => {
            let st = lock(&shared.state);
            st.ring.replay_from(st.ring.ring_start()).map_or(false, |r| String::from_utf8_lossy(&r.bytes).contains(text.as_str()))
        }
        None => false,
    };
    if held {
        if let Some((_, release)) = gate.take() {
            let _ = release.recv();
        }
    }
}

#[cfg(test)]
thread_local! {
    /// Set by a test, on its own thread, around a start: the holder started
    /// then gets an exit watch whose wait fails at once.
    static FAILING_WATCH: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Set by a test, on its own thread, around a start: once the ring of
    /// the holder started holds the text, its output thread waits for a
    /// message on (or the end of) the channel before it feeds that chunk to
    /// the screen, so a test can hold the screen back.
    static SCREEN_GATE: std::cell::RefCell<Option<(String, Receiver<()>)>> = const { std::cell::RefCell::new(None) };
    /// Set by a test on the thread that resizes: once that resize has
    /// resized the terminal, it says so on the first channel and waits for a
    /// message on (or the end of) the second before it resizes the screen.
    static RESIZE_GATE: std::cell::RefCell<Option<(mpsc::Sender<()>, Receiver<()>)>> = const { std::cell::RefCell::new(None) };
}

/// A test's gate (`RESIZE_GATE`): between a resize's two halves, say so and
/// wait for the test, once.
#[cfg(test)]
fn hold_the_resize() {
    if let Some((reached, release)) = RESIZE_GATE.with(|g| g.borrow_mut().take()) {
        let _ = reached.send(());
        let _ = release.recv();
    }
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panicked thread must not take the holder down with it.
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub struct Holder {
    shared: Arc<Shared>,
    pty: Arc<Mutex<Pty>>,
    /// To the input thread, which alone writes to the terminal, with its own
    /// handle: a write the program does not read never holds `pty`.
    input: Mutex<SyncSender<Vec<u8>>>,
    pid: u32,
}

/// What `attach` hands the client: what it missed, then what comes next.
pub struct Attachment {
    pub replay: Replay,
    /// New output as it arrives. It closes when the session is over (then
    /// `Holder::exit_code` is set), when a newer attachment replaced this one,
    /// or when this one fell `LIVE_QUEUE_CHUNKS` behind.
    pub live: Receiver<Vec<u8>>,
    /// Set when the session was already over at the attach: then `live` is
    /// closed from the start and `replay` holds the last of the output.
    pub exit_code: Option<i32>,
}

impl Holder {
    /// Start `argv` on a new terminal with the holder's own folder and
    /// environment, and hold it. `ring_bytes` is the size of the output ring.
    pub fn start(argv: &[String], size: PtySize, ring_bytes: usize) -> io::Result<Holder> {
        Holder::start_with(&SpawnOptions { argv, cwd: None, env: None, size, line: None, conpty: Conpty::System }, ring_bytes)
    }

    /// Start what `opts` names on a new terminal and hold it.
    pub fn start_with(opts: &SpawnOptions, ring_bytes: usize) -> io::Result<Holder> {
        let (pty, mut reader) = Pty::spawn_with(opts)?;
        let pid = pty.pid();
        let mut writer = pty.input_writer()?;
        let shared = Arc::new(Shared {
            state: Mutex::new(State { ring: Ring::new(ring_bytes), terminal: None, exit_code: None, output_ended: false }),
            screen: Mutex::new(Some(Screen::new(opts.size))),
        });
        let pty = Arc::new(Mutex::new(pty));
        // The watch on the child's exit, made before any thread: one that
        // cannot be made fails the start.
        let watch = lock(&pty).exit_watch()?;
        #[cfg(test)]
        let watch = if FAILING_WATCH.with(std::cell::Cell::get) { watch.failing() } else { watch };

        // The threads start in this order, the one that watches the child
        // last, and none of the earlier ones holds the terminal: so if a
        // thread cannot be made, the start fails (rather than a panic) and the
        // terminal and its child go with it (`Pty`'s drop).

        // Input: in order, one frame at a time. A failed write (the terminal
        // is gone) ends the thread, and later input is refused as closed.
        let (input, queued) = mpsc::sync_channel::<Vec<u8>>(INPUT_QUEUE_FRAMES);
        thread::Builder::new().spawn(move || {
            while let Ok(bytes) = queued.recv() {
                if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                    return;
                }
            }
        })?;

        // Output: everything the child writes goes into the ring first, then to
        // the attached client, in one critical section so a replay and the live
        // stream never overlap or leave a gap; then, with that lock let go, to
        // the screen.
        let out_shared = Arc::clone(&shared);
        #[cfg(test)]
        let mut gate = SCREEN_GATE.with(|g| g.borrow_mut().take());
        thread::Builder::new().spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                {
                    let mut st = lock(&out_shared.state);
                    st.ring.push(&buf[..n]);
                    let gone = match &st.terminal {
                        Some(tx) => !offer(tx, buf[..n].to_vec()),
                        None => false,
                    };
                    if gone {
                        st.terminal = None;
                    }
                }
                #[cfg(test)]
                hold_the_screen(&out_shared, &mut gate);
                feed_screen(&out_shared, &buf[..n]);
            }
            // The live channel stays open: it closes once the exit is known,
            // so a client never sees it close before the code is set.
            lock(&out_shared.state).output_ended = true;
        })?;

        // Exit: one wait that blocks until the child has exited
        // (`ExitWatch`), without the terminal's lock, so nothing wakes this
        // thread while the child runs and nothing else waits behind it. On
        // Windows the output pipe does not end when the child does, so the
        // reader cannot be the signal. On macOS and Linux the wait leaves the
        // child unreaped: it is reaped below, under the lock every decision
        // to signal its session is made under, so an end on another thread
        // never signals an id the reap has just freed. A wait that fails is
        // reported as an exit (code -1), never waited on.
        let watch_shared = Arc::clone(&shared);
        let watch_pty = Arc::clone(&pty);
        thread::Builder::new().spawn(move || {
            let waited = watch.wait();
            // The first process is gone. In one critical section: reap it and
            // read its code, end what it left behind on the terminal, then
            // close the terminal so the output can end.
            let code = {
                let mut p = lock(&watch_pty);
                let code = match waited {
                    Ok(()) => match p.try_wait() {
                        Ok(Some(code)) => code,
                        Ok(None) | Err(_) => -1,
                    },
                    Err(_) => -1,
                };
                p.end_tree(END_GRACE);
                p.close_output();
                code
            };
            let deadline = Instant::now() + DRAIN;
            while !lock(&watch_shared.state).output_ended && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            let mut st = lock(&watch_shared.state);
            st.exit_code = Some(code);
            // Dropping the sender closes the live channel after the last chunk.
            st.terminal = None;
        })?;

        Ok(Holder { shared, pty, input: Mutex::new(input), pid })
    }

    /// The child's process id.
    pub fn child_pid(&self) -> u32 {
        self.pid
    }

    /// Queue `bytes` for the program, never waiting. `WouldBlock` means the
    /// program has stopped reading and `INPUT_QUEUE_FRAMES` are already
    /// waiting: these bytes were not taken. `BrokenPipe`: the terminal is gone.
    pub fn write_input(&self, bytes: &[u8]) -> io::Result<()> {
        match lock(&self.input).try_send(bytes.to_vec()) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(io::Error::new(io::ErrorKind::WouldBlock, "the program is not reading its input")),
            Err(TrySendError::Disconnected(_)) => Err(io::Error::new(io::ErrorKind::BrokenPipe, "the terminal is closed")),
        }
    }

    /// Resize the terminal, then the screen with it. A resize the terminal
    /// refused leaves the screen as it was, as the program's size is.
    pub fn resize(&self, size: PtySize) -> io::Result<()> {
        lock(&self.pty).resize(size)?;
        #[cfg(test)]
        hold_the_resize();
        let mut slot = lock(&self.shared.screen);
        if let Some(s) = slot.as_mut() {
            if panic::catch_unwind(AssertUnwindSafe(|| s.resize(size))).is_err() {
                *slot = None;
            }
        }
        Ok(())
    }

    /// The screen now (`screen.read`); None when it is not kept any more.
    pub fn screen_read(&self) -> Option<screen::Read> {
        lock(&self.shared.screen).as_ref().map(Screen::read)
    }

    /// The screen's last `count` lines, scrollback included (`screen.tail`);
    /// None when it is not kept any more.
    pub fn screen_tail(&self, count: usize) -> Option<Vec<screen::TailLine>> {
        lock(&self.shared.screen).as_mut().map(|s| s.tail(count))
    }

    /// `(ring_start, ring_end)`: the offsets the ring holds.
    pub fn ring_range(&self) -> (u64, u64) {
        let st = lock(&self.shared.state);
        (st.ring.ring_start(), st.ring.ring_end())
    }

    /// Take the terminal slot: replay from `from`, then live output. The
    /// previous attachment, if any, is closed (replaced).
    pub fn attach(&self, from: u64) -> Result<Attachment, RingError> {
        let mut st = lock(&self.shared.state);
        let replay = st.ring.replay_from(from)?;
        let (tx, rx) = mpsc::sync_channel(LIVE_QUEUE_CHUNKS);
        let exit_code = st.exit_code;
        if exit_code.is_some() {
            // The session is over and its output drained: nothing more will come.
            drop(tx);
            st.terminal = None;
        } else {
            st.terminal = Some(tx);
        }
        Ok(Attachment { replay, live: rx, exit_code })
    }

    /// Leave the terminal slot without touching the session: the child keeps
    /// running and the ring keeps filling.
    pub fn detach(&self) {
        lock(&self.shared.state).terminal = None;
    }

    /// The child's exit code, once it has exited and its output has drained.
    pub fn exit_code(&self) -> Option<i32> {
        lock(&self.shared.state).exit_code
    }

    /// Wait for the child to exit; None if it has not within `timeout`.
    pub fn wait_exit(&self, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(code) = self.exit_code() {
                return Some(code);
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// End the session: the whole tree, a hangup first and a kill after
    /// `END_GRACE`. Returns the exit code once known (at most a few seconds).
    pub fn end(&self) -> Option<i32> {
        {
            let mut p = lock(&self.pty);
            p.end_tree(END_GRACE);
            p.close_output();
        }
        self.wait_exit(END_GRACE + DRAIN + Duration::from_secs(2))
    }

    /// Stop the child and its tree at once.
    pub fn kill(&self) {
        lock(&self.pty).kill();
    }

    /// A copy of everything the ring holds, from its start.
    pub fn snapshot(&self) -> Vec<u8> {
        let st = lock(&self.shared.state);
        match st.ring.replay_from(st.ring.ring_start()) {
            Ok(r) => r.bytes,
            Err(_) => Vec::new(),
        }
    }

    /// Wait until the ring holds `needle` (as text); true if it did in time.
    pub fn wait_for_text(&self, needle: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if String::from_utf8_lossy(&self.snapshot()).contains(needle) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Holder {
    fn drop(&mut self) {
        // A holder that is dropped ends its child; the process that wants the
        // child to outlive a connection keeps the holder (`serve.rs`).
        lock(&self.pty).kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_queue_is_refused_without_waiting_and_a_closed_one_too() {
        let (tx, rx) = mpsc::sync_channel(2);
        assert!(offer(&tx, vec![1]));
        assert!(offer(&tx, vec![2]));
        // The third does not block: it reports that the attachment is behind.
        assert!(!offer(&tx, vec![3]));
        // Once the reader catches up, offers are taken again.
        assert_eq!(rx.recv().unwrap(), vec![1]);
        assert!(offer(&tx, vec![4]));
        drop(rx);
        assert!(!offer(&tx, vec![5]));
    }

    #[test]
    fn the_queue_and_the_waits_are_bounded() {
        assert!(LIVE_QUEUE_CHUNKS > 0 && LIVE_QUEUE_CHUNKS <= 1024);
        assert!(END_GRACE <= Duration::from_secs(5) && DRAIN <= Duration::from_secs(5));
        assert_eq!((HOOK_QUEUE_EVENTS, HOOK_QUEUE_BYTES), (256, 2 * 1024 * 1024));
    }

    fn numbered(n: u64) -> Value {
        Value::obj(vec![("hook_event_name", Value::str("Stop")), ("n", Value::uint(n))])
    }

    /// Every seq the queue holds, oldest first.
    fn seqs(q: &HookQueue) -> Vec<u64> {
        q.waiting.iter().map(|e| e.seq).collect()
    }

    #[test]
    fn hook_events_are_numbered_from_1_and_sent_oldest_first() {
        let mut q = HookQueue::new();
        assert!(q.front().is_none() && q.waiting.is_empty());
        for n in 1..=3 {
            assert_eq!(q.push("Stop".to_string(), numbered(n), 10), n);
        }
        assert_eq!((q.waiting.len(), q.bytes, q.lost), (3, 30, 0));
        let (first, lost) = q.front().expect("an event");
        assert_eq!((first.seq, first.kind.as_str(), &first.payload, lost), (1, "Stop", &numbered(1), 0));
        q.sent();
        assert_eq!(seqs(&q), vec![2, 3]);
        assert_eq!(q.bytes, 20);
        q.sent();
        q.sent();
        q.sent();
        assert!(q.waiting.is_empty() && q.bytes == 0);
        // The numbering goes on: a seq is never given twice.
        assert_eq!(q.push("Stop".to_string(), numbered(4), 10), 4);
    }

    #[test]
    fn past_256_events_the_oldest_go_and_the_next_one_sent_carries_how_many() {
        let mut q = HookQueue::new();
        for n in 1..=300 {
            q.push("Notification".to_string(), numbered(n), 40);
        }
        assert_eq!(q.waiting.len(), HOOK_QUEUE_EVENTS);
        assert_eq!(q.bytes, 256 * 40);
        assert_eq!(seqs(&q), (45..=300).collect::<Vec<u64>>());
        let (first, lost) = q.front().expect("an event");
        assert_eq!((first.seq, lost), (45, 44));
        q.sent();
        // Only the first sent after the drop carries it.
        assert_eq!(q.front().map(|(e, lost)| (e.seq, lost)), Some((46, 0)));
    }

    #[test]
    fn past_2_mib_of_payload_the_oldest_go_whatever_their_number() {
        let mut q = HookQueue::new();
        let big = 60 * 1024;
        for n in 1..=40 {
            q.push("PostToolUse".to_string(), numbered(n), big);
            assert!(q.bytes <= HOOK_QUEUE_BYTES, "{} bytes wait after event {n}", q.bytes);
        }
        // 34 events of 60 KiB fit in 2 MiB; a 35th does not.
        let kept = HOOK_QUEUE_BYTES / big;
        assert_eq!(kept, 34);
        assert_eq!(q.waiting.len(), kept);
        assert_eq!(q.lost, 40 - kept as u64);
        assert_eq!(seqs(&q).first(), Some(&(40 - kept as u64 + 1)));
        // One more drops the oldest only until the bytes fit again: two here.
        q.push("Stop".to_string(), numbered(41), HOOK_QUEUE_BYTES - (kept - 1) * big + 1);
        assert!(q.bytes <= HOOK_QUEUE_BYTES);
        assert_eq!(q.waiting.len(), kept - 1);
        assert_eq!(q.lost, 40 - kept as u64 + 2);
        assert_eq!(seqs(&q).last(), Some(&41));
    }

    #[test]
    fn the_newest_event_is_always_kept() {
        let mut q = HookQueue::new();
        q.push("Stop".to_string(), numbered(1), 10);
        // Larger than the whole queue: no event can be, but the newest stays.
        q.push("Stop".to_string(), numbered(2), HOOK_QUEUE_BYTES + 1);
        assert_eq!(seqs(&q), vec![2]);
        assert_eq!(q.lost, 1);
    }

    /// A program that runs for about 2 s, reads nothing and exits 0.
    fn two_seconds() -> Vec<String> {
        if cfg!(windows) {
            // Three echo requests to this machine, one second apart.
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
            vec![format!("{root}\\System32\\PING.EXE"), "-n".to_string(), "3".to_string(), "127.0.0.1".to_string()]
        } else {
            vec!["/bin/sh".to_string(), "-c".to_string(), "sleep 2".to_string()]
        }
    }

    /// A program that runs for a minute unless it is ended.
    fn a_minute() -> Vec<String> {
        if cfg!(windows) {
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
            vec![format!("{root}\\System32\\PING.EXE"), "-n".to_string(), "60".to_string(), "127.0.0.1".to_string()]
        } else {
            vec!["/bin/sh".to_string(), "-c".to_string(), "sleep 60".to_string()]
        }
    }

    /// A held terminal waits for its child's exit: it does not ask for the
    /// child's status on a clock. It asks twice: one wait that blocks until
    /// the exit, then one read of the code. The terminal counts each ask the
    /// exit watch makes right beside the system call that makes it: the
    /// `waitid` in each turn of `ExitWatch::wait`'s loop (macOS, Linux) and
    /// each call of `ExitWatch::wait_once` (Windows). It also counts each
    /// check in `Pty::try_wait`: beside its `waitpid` on macOS and Linux, and
    /// on Windows once in `try_wait`, one call above the single zero-time
    /// wait in `winproc::exit_code` (which `detach.rs` shares).
    /// An exit watch that waits at most 25 ms and asks again, through that
    /// loop or that call, counts every ask. The 25 ms loop asked about 80
    /// times while this child ran.
    #[test]
    fn the_holder_waits_for_its_childs_exit_instead_of_asking_on_a_clock() {
        let h = Holder::start(&two_seconds(), PtySize::default(), 64 * 1024).expect("a program starts on a terminal");
        let began = Instant::now();
        let code = h.wait_exit(Duration::from_secs(30));
        let ran = began.elapsed();
        let checks = lock(&h.pty).status_checks();
        assert!((1..=2).contains(&checks), "the child's status was asked for {checks} times while it ran for {ran:?}");
        assert_eq!(code, Some(0), "the program did not exit 0: {:?}", String::from_utf8_lossy(&h.snapshot()));
        assert!(ran >= Duration::from_millis(1500), "the program ran only {ran:?}, too short to show anything");
    }

    /// A wait for the child's exit that fails is reported as an exit with
    /// code -1 at once: the live channel closes as after any exit, and the
    /// child, which would run for a minute, is ended rather than waited on.
    #[test]
    fn a_wait_for_the_child_that_fails_is_reported_as_an_exit_with_code_minus_1() {
        FAILING_WATCH.with(|f| f.set(true));
        let started = Holder::start(&a_minute(), PtySize::default(), 64 * 1024);
        FAILING_WATCH.with(|f| f.set(false));
        let h = started.expect("a program starts on a terminal");
        let began = Instant::now();
        let attached = h.attach(0).expect("attach");
        let deadline = began + Duration::from_secs(15);
        loop {
            match attached.live.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => panic!("the live channel was still open {:?} after a failed wait", began.elapsed()),
            }
        }
        assert_eq!(h.exit_code(), Some(-1), "a failed wait was not reported as an exit with code -1");
    }

    /// The holder waits for its child without the terminal's lock, so what
    /// needs the terminal while the child runs (a resize here) is answered at
    /// once, not when the child exits.
    #[test]
    fn the_terminal_is_not_locked_while_the_holder_waits_for_its_child() {
        let h = Holder::start(&two_seconds(), PtySize::default(), 64 * 1024).expect("a program starts on a terminal");
        // The exit thread is waiting by now.
        thread::sleep(Duration::from_millis(300));
        let began = Instant::now();
        h.resize(PtySize { cols: 100, rows: 30 }).expect("resize");
        let took = began.elapsed();
        assert!(took < Duration::from_millis(500), "a resize while the child ran waited {took:?}");
        assert_eq!(h.exit_code(), None, "the program ended before the resize could show anything");
        assert_eq!(h.wait_exit(Duration::from_secs(30)), Some(0));
    }

    /// A program that prints a line at once and then runs for about 2 s, and
    /// the text of that line.
    fn says_a_line() -> (Vec<String>, &'static str) {
        if cfg!(windows) {
            // PING's first line names the address at once.
            (two_seconds(), "127.0.0.1")
        } else {
            (vec!["/bin/sh".to_string(), "-c".to_string(), "echo the-screen-gate-line; sleep 2".to_string()], "the-screen-gate-line")
        }
    }

    fn screen_shows(h: &Holder, text: &str) -> bool {
        h.screen_read().map_or(false, |r| r.lines.iter().any(|l| l.text.contains(text)))
    }

    /// Each chunk of output reaches the ring (so an attach's replay) before
    /// the screen: the screen is held back from the chunk that brings the
    /// line into the ring, and then the ring holds the line and the screen
    /// does not show it; let through, the screen does. With the screen fed
    /// first, the screen shows the line before the ring holds it, and is not
    /// held back.
    #[test]
    fn the_output_reaches_the_ring_before_the_screen() {
        let (argv, line) = says_a_line();
        let (release, gate) = mpsc::channel::<()>();
        SCREEN_GATE.with(|g| *g.borrow_mut() = Some((line.to_string(), gate)));
        let started = Holder::start(&argv, PtySize { cols: 100, rows: 10 }, 64 * 1024);
        SCREEN_GATE.with(|g| *g.borrow_mut() = None);
        let h = started.expect("a program starts on a terminal");
        assert!(h.wait_for_text(line, Duration::from_secs(15)), "the ring never held the line while the screen was held back: {:?}", String::from_utf8_lossy(&h.snapshot()));
        assert!(!screen_shows(&h, line), "the screen showed the line before it was let through");
        // The gate closed: every chunk goes through.
        drop(release);
        let deadline = Instant::now() + Duration::from_secs(15);
        while !screen_shows(&h, line) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(screen_shows(&h, line), "the screen never showed the line: {:?}", h.screen_read().map(|r| r.lines));
        let _ = h.end();
    }

    /// A resize resizes the screen with the terminal; the screen starts at
    /// the launch's size.
    #[test]
    fn a_resize_resizes_the_screen_too() {
        let h = Holder::start(&two_seconds(), PtySize { cols: 90, rows: 20 }, 64 * 1024).expect("a program starts on a terminal");
        let size = |h: &Holder| h.screen_read().map(|r| (r.cols, r.rows, r.lines.len()));
        assert_eq!(size(&h), Some((90, 20, 20)));
        h.resize(PtySize { cols: 100, rows: 30 }).expect("resize");
        assert_eq!(size(&h), Some((100, 30, 30)));
        assert_eq!(h.screen_tail(500).map(|t| t.len()), Some(30), "a tail of a screen with no scrollback is its rows");
        let _ = h.end();
    }

    /// Two resizes that overlap leave the screen at the terminal's size. A
    /// resize keeps the terminal's lock until it has resized the screen too,
    /// so a second resize, made while the first is held between its two
    /// halves, waits for the first and then resizes both. With the lock let
    /// go between the halves, the second resizes the terminal and the screen
    /// while the first is held, and the first then leaves the screen at the
    /// older size.
    #[test]
    fn two_resizes_that_overlap_leave_the_screen_at_the_terminals_size() {
        let h = Holder::start(&a_minute(), PtySize { cols: 90, rows: 20 }, 64 * 1024).expect("a program starts on a terminal");
        let held = &h;
        thread::scope(|s| {
            // Made in the scope, so a failed wait below lets the first go.
            let (reached_tx, reached) = mpsc::channel::<()>();
            let (release, gate) = mpsc::channel::<()>();
            let (done_tx, done) = mpsc::channel::<()>();
            let first = s.spawn(move || {
                RESIZE_GATE.with(|g| *g.borrow_mut() = Some((reached_tx, gate)));
                held.resize(PtySize { cols: 100, rows: 30 })
            });
            reached.recv_timeout(Duration::from_secs(15)).expect("the first resize never resized the terminal");
            let second = s.spawn(move || {
                let resized = held.resize(PtySize { cols: 110, rows: 35 });
                let _ = done_tx.send(());
                resized
            });
            let went_through = done.recv_timeout(Duration::from_secs(1)).is_ok();
            drop(release);
            first.join().expect("the first resize panicked").expect("the first resize");
            second.join().expect("the second resize panicked").expect("the second resize");
            assert!(!went_through, "a second resize went through while the first had resized only the terminal");
        });
        let size = h.screen_read().map(|r| (r.cols, r.rows, r.lines.len()));
        assert_eq!(size, Some((110, 35, 35)), "the screen was left at another size than the terminal's last resize");
        let _ = h.end();
    }
}
