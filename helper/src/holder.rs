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
//! lets the last output drain (at most `DRAIN`), and only then reports the
//! exit code and closes the live channel. So a client that sees the channel
//! close with `exit_code()` set has had every byte of output first.

use crate::pty::{Pty, PtySize, SpawnOptions};
use crate::ring::{Replay, Ring, RingError};
use std::io::{self, Read};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

/// How many output chunks an attachment may leave unread. A chunk is at most 16
/// KiB, so this caps what a client that stops reading can make the holder keep.
/// A client that falls this far behind is disconnected and recovers by
/// attaching again from the offset it last saw (the ring replays the rest).
pub const LIVE_QUEUE_CHUNKS: usize = 256;

/// How long the rest of the tree has after a hangup before it is killed.
pub const END_GRACE: Duration = Duration::from_secs(2);

/// How long the last output may take to drain once the first process exited.
pub const DRAIN: Duration = Duration::from_secs(2);

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
        Holder::start_with(&SpawnOptions { argv, cwd: None, env: None, size }, ring_bytes)
    }

    /// Start what `opts` names on a new terminal and hold it.
    pub fn start_with(opts: &SpawnOptions, ring_bytes: usize) -> io::Result<Holder> {
        let (pty, mut reader) = Pty::spawn_with(opts)?;
        let pid = pty.pid();
        let shared = Arc::new(Shared {
            state: Mutex::new(State { ring: Ring::new(ring_bytes), terminal: None, exit_code: None, output_ended: false }),
        });
        let pty = Arc::new(Mutex::new(pty));

        // Output: everything the child writes goes into the ring first, then to
        // the attached client, in one critical section so a replay and the live
        // stream never overlap or leave a gap.
        let out_shared = Arc::clone(&shared);
        thread::spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
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
            // The live channel stays open: it closes once the exit is known,
            // so a client never sees it close before the code is set.
            lock(&out_shared.state).output_ended = true;
        });

        // Exit: the child is watched by polling. On Windows the output pipe does
        // not end when the child does, so the reader cannot be the signal.
        let watch_shared = Arc::clone(&shared);
        let watch_pty = Arc::clone(&pty);
        thread::spawn(move || {
            let code = loop {
                let status = lock(&watch_pty).try_wait();
                match status {
                    Ok(Some(code)) => break code,
                    Ok(None) => {}
                    Err(_) => break -1,
                }
                thread::sleep(Duration::from_millis(25));
            };
            // The first process is gone: end what it left behind on the
            // terminal, then close the terminal so the output can end.
            {
                let mut p = lock(&watch_pty);
                p.end_tree(END_GRACE);
                p.close_output();
            }
            let deadline = Instant::now() + DRAIN;
            while !lock(&watch_shared.state).output_ended && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            let mut st = lock(&watch_shared.state);
            st.exit_code = Some(code);
            // Dropping the sender closes the live channel after the last chunk.
            st.terminal = None;
        });

        Ok(Holder { shared, pty, pid })
    }

    /// The child's process id.
    pub fn child_pid(&self) -> u32 {
        self.pid
    }

    pub fn write_input(&self, bytes: &[u8]) -> io::Result<()> {
        lock(&self.pty).write_input(bytes)
    }

    pub fn resize(&self, size: PtySize) -> io::Result<()> {
        lock(&self.pty).resize(size)
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
    }
}
