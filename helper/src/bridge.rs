//! `aicc-helper bridge --store <folder> --session <sid>` (macOS and Linux,
//! from 2.1.3-beta.17): one connection to a session's holder, carried over
//! the bridge's own standard input and output. The app reaches a holder on
//! another machine this way, through one `ssh -T` exec per session (ADR-030
//! S24; remote step 1), and speaks protocol section 15 to it end to end, as
//! it does to a holder on This computer.
//!
//! It reads the session's record with the store's strict reader and connects
//! to the record's endpoint with the transport's checks (a real folder of
//! this user's, a socket of this user's, and a peer of the same user id).
//! Then it copies bytes, each exactly as it came: standard input to the
//! connection, and the connection to standard output. It never reads or
//! writes a frame or the hello line itself: the app on the far side of the
//! exec reads the hello, checks its nonce and session, and speaks the frames.
//!
//! How it ends:
//! - The holder closes the connection (the session ended, a newer connection
//!   took its place, or it dropped the connection): what the holder sent
//!   before that goes to standard output, and the bridge exits 0.
//! - Standard input ends (the app let go, or the ssh link dropped): the
//!   bridge ends its half of the connection, as a local connection that goes
//!   does. The holder keeps the session, as for any connection that goes, and
//!   closes its own half; the bridge then exits 0 as above. If the holder has
//!   not closed it within `HALF_CLOSE_WAIT`, the bridge exits 1.
//! - Standard output closed, a read or a write that fails, or the holder not
//!   taking a write within `transport::WRITE_TIMEOUT` (the limit the holder
//!   gives the app): the connection is ended both ways and the bridge exits 1.
//!
//! What the holder sends is read as soon as it comes and queued for standard
//! output by a thread of its own, so a slow ssh link never makes the holder
//! wait: it drops a connection that does not take a write within 5 s, and a
//! replay of its 2 MiB ring can take longer than that over a slow link. The
//! queue holds `MAX_QUEUED` bytes at most; past that the bridge exits 1.
//!
//! Exit statuses: `EXIT_HOLDER_CLOSED` (0), `EXIT_FAILED` (1),
//! `EXIT_USAGE` (2, a command line it does not take; `main.rs` reads it) and
//! `EXIT_NO_HOLDER` (3: no record for the session, the holder's process is
//! gone, or nothing listens on its endpoint). On Windows the mode does not
//! run and exits 1 (`main.rs`). It prints nothing of its own on standard
//! output; a failure is one line on standard error.

use crate::store;
use crate::transport::{self, Stream};
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

/// The holder closed the connection.
pub const EXIT_HOLDER_CLOSED: u8 = 0;
/// Anything else: a record that does not read, a connection that cannot be
/// made or goes wrong, standard input or output failing.
pub const EXIT_FAILED: u8 = 1;
/// A command line it does not take.
pub const EXIT_USAGE: u8 = 2;
/// No holder for the session.
pub const EXIT_NO_HOLDER: u8 = 3;
/// How long it waits to connect.
pub const CONNECT: Duration = Duration::from_secs(2);
/// How long the holder has to close its half once standard input ended.
pub const HALF_CLOSE_WAIT: Duration = Duration::from_secs(5);
/// What the holder sent and standard output has not taken yet, at most.
pub const MAX_QUEUED: usize = 64 * 1024 * 1024;
/// The most read at once from either side.
const CHUNK: usize = 64 * 1024;

/// What the three threads tell the one that waits for the end.
enum Event {
    /// Standard input ended, and the bridge's half of the connection is closed.
    InputEnded,
    /// The holder closed its half; what it sent before is queued.
    HolderEnded,
    /// Standard output has taken everything the holder sent.
    Drained,
    /// Something failed: the connection is to be ended both ways.
    Failed(String),
}

/// One item for the thread that writes standard output.
enum Out {
    Bytes(Vec<u8>),
    /// The holder closed its half: nothing more comes.
    End,
}

/// Run the bridge for `sid` in `store_dir`: its exit status. The command line
/// is `main.rs`'s to read.
pub fn run(store_dir: &Path, sid: &str) -> u8 {
    let rec = match store::read(store_dir, sid) {
        None => return said(EXIT_NO_HOLDER, &format!("no holder for session {sid}: it has no record")),
        Some(Err(e)) => return said(EXIT_FAILED, &format!("the record of session {sid} does not read: {e}")),
        Some(Ok(r)) => r,
    };
    if !crate::pids::alive(rec.pid) {
        return said(EXIT_NO_HOLDER, &format!("no holder for session {sid}: its process {} is gone", rec.pid));
    }
    let stream = match transport::connect(&rec.endpoint, CONNECT) {
        Ok(s) => s,
        Err(e) if transport::means_gone(&e) => return said(EXIT_NO_HOLDER, &format!("no holder for session {sid}: nothing listens on its endpoint ({e})")),
        Err(e) => return said(EXIT_FAILED, &format!("cannot connect to the holder of session {sid}: {e}")),
    };
    carry(stream)
}

fn said(code: u8, msg: &str) -> u8 {
    eprintln!("aicc-helper: bridge: {msg}");
    code
}

/// Copy both ways until the end, then return the exit status.
fn carry(stream: Stream) -> u8 {
    let (to_holder, mut from_holder, closer) = match (stream.try_clone(), stream.try_clone()) {
        (Ok(to), Ok(closer)) => (to, stream, closer),
        _ => return said(EXIT_FAILED, "cannot share the connection between threads"),
    };
    if let Err(e) = from_holder.set_read_timeout(None) {
        return said(EXIT_FAILED, &format!("cannot set the connection to wait: {e}"));
    }
    let (events_tx, events) = mpsc::channel::<Event>();
    let (out_tx, out_rx) = mpsc::channel::<Out>();
    let queued = Arc::new(AtomicUsize::new(0));
    let started = [
        spawn_guarded(events_tx.clone(), {
            let queued = Arc::clone(&queued);
            move |ev| write_output(out_rx, &queued, &ev)
        }),
        spawn_guarded(events_tx.clone(), {
            let queued = Arc::clone(&queued);
            move |ev| read_holder(&mut from_holder, &out_tx, &queued, &ev)
        }),
        spawn_guarded(events_tx.clone(), move |ev| read_input(to_holder, &ev)),
    ];
    // Only the threads hold a sender now: if every one of them is gone, the
    // wait below ends.
    drop(events_tx);
    if started.iter().any(|ok| !ok) {
        closer.shutdown();
        return said(EXIT_FAILED, "cannot start a thread");
    }
    let code = wait_for_end(&events);
    if code != EXIT_HOLDER_CLOSED {
        closer.shutdown();
    }
    code
}

/// Wait for the end the threads report. The holder's close counts once
/// standard output has taken what came before it; once standard input has
/// ended, the holder has `HALF_CLOSE_WAIT` to close.
fn wait_for_end(events: &Receiver<Event>) -> u8 {
    let mut input_ended: Option<Instant> = None;
    let mut holder_ended = false;
    loop {
        let next = match (input_ended, holder_ended) {
            (Some(at), false) => match events.recv_timeout((at + HALF_CLOSE_WAIT).saturating_duration_since(Instant::now())) {
                Ok(ev) => ev,
                Err(mpsc::RecvTimeoutError::Timeout) => Event::Failed(format!("the holder did not close the connection within {} s of the end of standard input", HALF_CLOSE_WAIT.as_secs())),
                Err(mpsc::RecvTimeoutError::Disconnected) => Event::Failed("every thread ended without a word".to_string()),
            },
            _ => events.recv().unwrap_or_else(|_| Event::Failed("every thread ended without a word".to_string())),
        };
        match next {
            Event::InputEnded => input_ended = Some(Instant::now()),
            Event::HolderEnded => holder_ended = true,
            Event::Drained => return EXIT_HOLDER_CLOSED,
            Event::Failed(why) => return said(EXIT_FAILED, &why),
        }
    }
}

/// Start `body` on a thread of its own, with a sender for its events; a panic
/// there is reported as a failure. False when the thread cannot be started.
fn spawn_guarded<F>(events: Sender<Event>, body: F) -> bool
where
    F: FnOnce(Sender<Event>) + Send + 'static,
{
    thread::Builder::new()
        .spawn(move || {
            let mine = events.clone();
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || body(mine))).is_err() {
                let _ = events.send(Event::Failed("a thread of the bridge failed".to_string()));
            }
        })
        .is_ok()
}

/// Standard input to the holder, a chunk at a time, each whole within the
/// write limit. At its end, the bridge's half of the connection is closed.
fn read_input(mut to_holder: Stream, events: &Sender<Event>) {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut buf = vec![0u8; CHUNK];
    loop {
        match input.read(&mut buf) {
            Ok(0) => {
                to_holder.shutdown_write();
                let _ = events.send(Event::InputEnded);
                return;
            }
            Ok(n) => {
                if let Err(e) = to_holder.write_all_within(&buf[..n], transport::WRITE_TIMEOUT) {
                    let _ = events.send(Event::Failed(format!("the holder did not take what standard input brought: {e}")));
                    return;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => {
                let _ = events.send(Event::Failed(format!("standard input cannot be read: {e}")));
                return;
            }
        }
    }
}

/// What the holder sends, queued for standard output as soon as it comes.
fn read_holder(from_holder: &mut Stream, out: &Sender<Out>, queued: &AtomicUsize, events: &Sender<Event>) {
    let mut buf = vec![0u8; CHUNK];
    loop {
        match from_holder.read(&mut buf) {
            Ok(0) => {
                let _ = events.send(Event::HolderEnded);
                let _ = out.send(Out::End);
                return;
            }
            Ok(n) => {
                if queued.fetch_add(n, Ordering::SeqCst) + n > MAX_QUEUED {
                    let _ = events.send(Event::Failed(format!("standard output is more than {} MiB behind the holder", MAX_QUEUED / (1024 * 1024))));
                    return;
                }
                if out.send(Out::Bytes(buf[..n].to_vec())).is_err() {
                    // The writer is gone, and has said why.
                    return;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => {
                let _ = events.send(Event::Failed(format!("the connection to the holder cannot be read: {e}")));
                return;
            }
        }
    }
}

/// Write what the holder sent to standard output, in order, until the
/// holder's end; then say it is drained.
fn write_output(items: Receiver<Out>, queued: &AtomicUsize, events: &Sender<Event>) {
    let stdout = io::stdout();
    for item in items {
        let bytes = match item {
            Out::Bytes(b) => b,
            Out::End => {
                let _ = events.send(Event::Drained);
                return;
            }
        };
        let mut out = stdout.lock();
        if let Err(e) = out.write_all(&bytes).and_then(|_| out.flush()) {
            let _ = events.send(Event::Failed(format!("standard output cannot be written: {e}")));
            return;
        }
        queued.fetch_sub(bytes.len(), Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_exit_statuses_and_limits_are_the_documented_ones() {
        assert_eq!((EXIT_HOLDER_CLOSED, EXIT_FAILED, EXIT_USAGE, EXIT_NO_HOLDER), (0, 1, 2, 3));
        assert_eq!((CONNECT, HALF_CLOSE_WAIT), (Duration::from_secs(2), Duration::from_secs(5)));
        assert_eq!(MAX_QUEUED, 64 * 1024 * 1024);
        // A whole replay of the holder's default ring fits many times over.
        assert!(MAX_QUEUED >= 16 * crate::ring::DEFAULT_RING_BYTES);
        // The holder closes its half at once when it reads the end (its
        // `close_after_writes`), well inside the wait.
        assert!(transport::LINGER < HALF_CLOSE_WAIT);
    }
}
