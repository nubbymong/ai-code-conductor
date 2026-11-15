//! The holder: owns one terminal with one child, keeps an output ring, and lets
//! a terminal client attach, detach and attach again (protocol section 5).
//!
//! This skeleton holds everything in one process and hands an attachment out
//! as a replay plus a live channel. The local transport that would carry
//! attachments between processes (a socket, a named pipe) is a later slice;
//! `dirhold.rs` is the stand-in the probes use.
//!
//! Slots: the holder has a terminal slot. The newest `attach` takes it; the one
//! it replaced has its live channel closed, which is how an older connection
//! learns it was replaced.

use crate::pty::{Pty, PtySize};
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
    exit_code: Option<i32>,
    output_ended: bool,
}

struct Shared {
    state: Mutex<State>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
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
    /// New output as it arrives. It closes when the session's output ends or
    /// when a newer attachment replaced this one.
    pub live: Receiver<Vec<u8>>,
}

impl Holder {
    /// Start `argv` on a new terminal and hold it. `ring_bytes` is the size of
    /// the output ring.
    pub fn start(argv: &[String], size: PtySize, ring_bytes: usize) -> io::Result<Holder> {
        let (pty, mut reader) = Pty::spawn(argv, size)?;
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
            let mut st = lock(&out_shared.state);
            st.output_ended = true;
            // Dropping the sender closes the live channel: the output is over.
            st.terminal = None;
        });

        // Exit: the child is watched by polling. On Windows the output pipe does
        // not end when the child does, so the reader cannot be the signal.
        let watch_shared = Arc::clone(&shared);
        let watch_pty = Arc::clone(&pty);
        thread::spawn(move || loop {
            let status = lock(&watch_pty).try_wait();
            match status {
                Ok(Some(code)) => {
                    lock(&watch_shared.state).exit_code = Some(code);
                    return;
                }
                Ok(None) => {}
                Err(_) => {
                    lock(&watch_shared.state).exit_code = Some(-1);
                    return;
                }
            }
            thread::sleep(Duration::from_millis(25));
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
        if st.output_ended {
            // Nothing more will come: leave the channel closed.
            drop(tx);
        } else {
            st.terminal = Some(tx);
        }
        Ok(Attachment { replay, live: rx })
    }

    /// Leave the terminal slot without touching the session: the child keeps
    /// running and the ring keeps filling.
    pub fn detach(&self) {
        lock(&self.shared.state).terminal = None;
    }

    /// The child's exit code, once it has exited.
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

    /// Stop the child.
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
        // child to outlive it never drops the holder (it runs `hold`).
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
    fn the_queue_is_bounded() {
        assert!(LIVE_QUEUE_CHUNKS > 0 && LIVE_QUEUE_CHUNKS <= 1024);
    }
}
