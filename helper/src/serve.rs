//! The holder process (`aicc-helper hold`, protocol section 15): one
//! session's terminal behind its own local endpoint, with no daemon and no
//! network port (ADR-030).
//!
//! It binds its endpoint, writes its record, and waits. An app connects, gets
//! the hello line, acks it, then launches the session with a folder and a
//! whole environment, attaches (replay from an offset, then live output),
//! types, resizes, detaches, and ends it. The holder exits when the session is
//! ended, or when the away clock runs out: `away` seconds with no connection
//! attached to the terminal, counted from the holder's start and from every
//! detach or dropped connection. Ending ends the whole process tree.
//!
//! One thread ends the session: the first to set `State::ending`, which is
//! set under the state lock only. The away clock decides under that lock as
//! well, so an attach or a launch at the same moment either comes first (and
//! stops the clock) or finds the session ending and is refused. A `term.end`
//! that comes while another thread ends the session is answered by that
//! thread, with the rest.
//!
//! Hook events (capability `hooks`): any connection that acked `hooks` may
//! post one (`hook.event`). Each takes the session's next `seq` and goes at
//! once, as `event`, to the attached connection if that connection acked
//! `hooks` too; otherwise it waits in the hook queue (`HookQueue`), which the
//! next such attach gets right after its `term.attached` reply and replay. A
//! hook event is only numbered and passed on: nothing is run, opened or
//! written for it.
//!
//! Locks: a connection's stream gate (`Conn::live`) first, then the hook
//! events (`Serve::hooks`), then the record, then the serve state, then the
//! holder's own (never the other way), and nothing is written to a connection
//! while the record or the serve state is held. Hook events are written to a
//! connection under its gate and the hook lock, so they go out in `seq` order
//! and never inside an attach's reply and replay or after its last word; the
//! hook lock is held for at most `WRITE_TIMEOUT` of writing at a time.

use crate::frame::{self, Body, Direction, Frame, FrameError};
use crate::hello::{self, Hello, PROTO_VERSIONS};
use crate::holder::{lock, HookEvent, HookQueue, Holder};
use crate::json::Value;
use crate::pty::SpawnOptions;
use crate::request::{self, Allowed, Launch, Refusal, Request};
use crate::ring::RingError;
use crate::store::{self, Record};
use crate::transport::{self, Listener, Stream};
use std::collections::VecDeque;
use std::io::{self, Read};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// The capability that allows hook events.
pub const HOOKS_CAP: &str = "hooks";
/// What a holder offers in its hello: the frozen core, `local` for the
/// terminal messages and `hooks` for hook events (from 2.1.3-beta.8). The
/// app acks `core` and `local` (`hello::LOCAL_CAPS`); the hook mode acks all
/// three.
pub const HOLDER_CAPS: [&str; 3] = ["core", "local", HOOKS_CAP];
/// Connections served at once; the next one gets `busy` and is closed.
pub const MAX_CONNECTIONS: usize = 16;
/// The app must ack the hello in this time.
pub const ACK_TIMEOUT: Duration = Duration::from_secs(10);
/// A connection with no frame from the app in this time is dropped (the app
/// pings every 15 s, section 10).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// The terminal's raw bytes travel on this channel, both ways.
pub const TERMINAL_CHANNEL: u32 = 1;
/// `bad-field` and `too-large` replies a connection may draw in a minute
/// before it is closed (section 12).
pub const REFUSALS_PER_MINUTE: usize = 20;
/// The most JSON a frame may hold before the hello is acked: the ack is small.
pub const MAX_JSON_BEFORE_ACK: usize = 4096;
/// The most JSON a frame may hold once the session is launched or launching:
/// only a launch is large, and there is one per holder.
pub const MAX_JSON_AFTER_LAUNCH: usize = 65_536;
/// How often the away clock and the record are looked at.
const TICK: Duration = Duration::from_millis(250);
/// How often the Unix socket and its folder are marked as used.
const TOUCH_EVERY: Duration = Duration::from_secs(3600);
/// How long an end waits for a launch in progress to put its holder in place.
const LAUNCH_WAIT: Duration = Duration::from_secs(30);

pub struct Options {
    pub store: PathBuf,
    pub sid: String,
    pub label: String,
    pub away: Duration,
    pub ring_bytes: usize,
}

/// The error `run` gives when a holder for the session is already running.
#[derive(Debug)]
struct AlreadyRunning;

impl std::fmt::Display for AlreadyRunning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a holder for this session is already running")
    }
}

impl std::error::Error for AlreadyRunning {}

/// True when `run` failed because a holder for the session is already running.
pub fn already_running(e: &io::Error) -> bool {
    e.get_ref().map_or(false, |inner| inner.is::<AlreadyRunning>())
}

/// One connection: a writer, and a second handle to shut it down from any
/// thread without waiting for a write in progress.
struct Conn {
    id: u64,
    writer: Mutex<Stream>,
    closer: Stream,
    /// The attach whose output this connection carries now (0: none). An
    /// attach sets it, and sends its reply and replay, under this lock; a
    /// forwarder sends each live chunk under it, and only while it still
    /// names the forwarder's own attach. So output queued for an older attach
    /// never follows a newer attach's reply, and a detach or a replacement
    /// stops it before saying so.
    live: Mutex<u64>,
    /// Set, under `live`, once this connection has been sent `term.exit`.
    told_exit: AtomicBool,
}

impl Conn {
    fn send_bytes(&self, bytes: &[u8]) -> io::Result<()> {
        // The limit is for the whole message, however slowly the app reads.
        self.send_bytes_within(bytes, transport::WRITE_TIMEOUT)
    }

    fn send_bytes_within(&self, bytes: &[u8], limit: Duration) -> io::Result<()> {
        let mut w = lock(&self.writer);
        let result = w.write_all_within(bytes, limit);
        if result.is_err() {
            // A write that failed or timed out ends the connection.
            self.closer.shutdown();
        }
        result
    }

    /// A control message whose write must be done by `deadline`; one that
    /// is not ends the connection.
    fn send_json_by(&self, v: Value, deadline: Instant) -> io::Result<()> {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            self.closer.shutdown();
            return Err(io::Error::new(io::ErrorKind::TimedOut, "the app did not take the hook events in time"));
        }
        let bytes = frame::encode(&Frame::json(0, v), Direction::HelperToApp).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        self.send_bytes_within(&bytes, left)
    }

    fn send_frame(&self, frame: &Frame) -> io::Result<()> {
        let bytes = frame::encode(frame, Direction::HelperToApp).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        self.send_bytes(&bytes)
    }

    fn send_json(&self, v: Value) -> io::Result<()> {
        self.send_frame(&Frame::json(0, v))
    }

    fn send_error(&self, re: Option<u64>, code: &str, text: &str) -> io::Result<()> {
        self.send_json(hello::error_message(re, code, text))
    }

    fn refuse(&self, r: &Refusal) -> io::Result<()> {
        self.send_error(r.re, r.code, &r.text)
    }

    /// Terminal bytes on channel 1, at most 64 KiB a frame.
    fn send_terminal(&self, bytes: &[u8]) -> io::Result<()> {
        for chunk in bytes.chunks(frame::MAX_RAW) {
            self.send_frame(&Frame::raw(TERMINAL_CHANNEL, chunk.to_vec()))?;
        }
        Ok(())
    }

    /// `term.exit`, once per connection; the caller holds `live`.
    fn send_exit(&self, code: i32) {
        if !self.told_exit.swap(true, Ordering::SeqCst) {
            let _ = self.send_json(Value::obj(vec![("t", Value::str("term.exit")), ("code", code_value(code))]));
        }
    }
}

struct State {
    holder: Option<Arc<Holder>>,
    launching: bool,
    conns: usize,
    attached: Option<Arc<Conn>>,
    /// Counts attaches, so a forwarder can tell its own attach from a later
    /// one, even by the same connection.
    attach_gen: u64,
    /// Since when nobody has been attached; None while someone is.
    away_since: Option<Instant>,
    /// Set once, by the thread that ends the session.
    ending: bool,
    /// `term.end` requests that came while another thread was ending the
    /// session: that thread answers each.
    enders: Vec<(Arc<Conn>, u64)>,
    /// The program's exit code (if it has one), once the session has ended.
    ended: Option<Option<i32>>,
}

/// A stream read that must finish by `until`: each read waits only for what
/// is left, so a frame sent a byte at a time cannot stretch a limit.
struct Deadline<'a> {
    stream: &'a mut Stream,
    until: Instant,
}

impl Read for Deadline<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = self.until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "the frame did not arrive in time"));
        }
        self.stream.set_read_timeout(Some(left.max(Duration::from_millis(1))))?;
        self.stream.read(buf)
    }
}

/// Whether typed input may go to the program. The program must never see a
/// gap: once one frame is refused, every later frame is refused too, unread
/// by the program, until the app's next `ping` (after which the app sends
/// again what was refused).
#[derive(Default)]
struct InputGate {
    refusing: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Typed {
    Taken,
    Refused,
}

impl InputGate {
    /// Offer one frame of typed input through `write`, which reports
    /// `WouldBlock` when the program's queue is full.
    fn offer(&mut self, write: impl FnOnce() -> io::Result<()>) -> Typed {
        if self.refusing {
            return Typed::Refused;
        }
        match write() {
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                self.refusing = true;
                Typed::Refused
            }
            // Taken, or the terminal is gone and nothing more can be taken.
            _ => Typed::Taken,
        }
    }

    /// The app's `ping`: what it sends from here is offered again.
    fn ping(&mut self) {
        self.refusing = false;
    }
}

/// A launch marks the record running only while it is waiting: an exit the
/// clock recorded first is never written over.
fn mark_running(rec: &mut Record) {
    if rec.child == "waiting" {
        rec.child = "running".to_string();
    }
}

/// The session's hook events, and where new ones go.
struct Hooks {
    queue: HookQueue,
    /// The attached connection that takes hook events, and its attach, once
    /// every waiting event has been sent to it. None: events wait.
    to: Option<(Arc<Conn>, u64)>,
}

struct Serve {
    opts: Options,
    nonce: String,
    listener: Listener,
    state: Mutex<State>,
    hooks: Mutex<Hooks>,
    record: Mutex<Record>,
    /// `State::ending`, for threads that only look.
    ending: AtomicBool,
    next_id: AtomicU64,
    /// Forwarders of live output still running.
    forwarders: AtomicUsize,
}

/// A forwarder is counted from the moment its attach is taken, under the
/// state lock, until its thread ends (or fails to start). An end is claimed
/// under the same lock, so it always comes after the count and waits for
/// the output the forwarder still has to send, a slow replay included.
struct Forwarding(Arc<Serve>);

impl Drop for Forwarding {
    fn drop(&mut self) {
        self.0.forwarders.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(PartialEq, Eq)]
enum Flow {
    Continue,
    Close,
}

fn reply(t: &str, re: u64, more: Vec<(&str, Value)>) -> Value {
    let mut members = vec![("t", Value::str(t)), ("re", Value::uint(re))];
    members.extend(more);
    Value::obj(members)
}

fn code_value(code: i32) -> Value {
    Value::Num(code.to_string())
}

/// `event`: one hook event, to the attached connection that takes them.
/// `lost`, when not 0, is how many were dropped from the queue before it.
pub fn event_message(ev: &HookEvent, lost: u64) -> Value {
    let mut members = vec![("t", Value::str("event")), ("seq", Value::uint(ev.seq)), ("kind", Value::str(&ev.kind)), ("payload", ev.payload.clone())];
    if lost > 0 {
        members.push(("lost", Value::uint(lost)));
    }
    Value::obj(members)
}

/// `hook.taken`: the reply to `hook.event` `re`, with the `seq` it took.
pub fn hook_taken(re: u64, seq: u64) -> Value {
    reply("hook.taken", re, vec![("seq", Value::uint(seq))])
}

/// Send `conn` every hook event waiting, oldest first; each leaves the queue
/// once it is sent. The whole queue goes within `WRITE_TIMEOUT`, however
/// many events it holds, so the hook lock is never held longer: a connection
/// that does not take them in time is closed. False when a send failed or
/// the time ran out: that event and those after it wait on (the app drops a
/// `seq` it has already seen). An event always encodes: its payload came in
/// a frame of at most 32 levels and is at most 64 KiB.
fn send_waiting(queue: &mut HookQueue, conn: &Conn) -> bool {
    let deadline = Instant::now() + transport::WRITE_TIMEOUT;
    while let Some(message) = queue.front().map(|(ev, lost)| event_message(ev, lost)) {
        if conn.send_json_by(message, deadline).is_err() {
            return false;
        }
        queue.sent();
    }
    true
}

/// `term.ended` for request `re`, the last thing on `conn`.
fn say_ended(conn: &Conn, re: u64, code: Option<i32>) {
    let more = match code {
        Some(c) => vec![("code", code_value(c))],
        None => vec![],
    };
    // No live output after the reply.
    let mut live = lock(&conn.live);
    *live = 0;
    let _ = conn.send_json(reply("term.ended", re, more));
    conn.closer.close_after_writes();
    drop(live);
}

/// Check the first frame: a `hello.ack` with exactly `t`, `proto` and `caps`,
/// a version this holder speaks, and capabilities it offered, `core` among
/// them. Returns what the ack allowed: `local`, `hooks`.
fn check_ack(v: &Value) -> Result<Allowed, Refusal> {
    let bad = |code: &'static str, text: &str| Err(Refusal { code, re: None, text: text.to_string() });
    match v.get("t").and_then(Value::as_str) {
        Some("hello.ack") => {}
        Some(_) => return bad(request::CODE_UNKNOWN_TYPE, "the first message must be hello.ack"),
        None => return bad(request::CODE_BAD_FIELD, "the first message must be hello.ack"),
    }
    let keys = v.keys().unwrap_or_default();
    if keys.len() != 3 || !["t", "proto", "caps"].iter().all(|k| keys.iter().filter(|x| *x == k).count() == 1) {
        return bad(request::CODE_BAD_FIELD, "hello.ack has exactly t, proto and caps");
    }
    let (proto, caps) = match hello::parse_ack(v) {
        Some(p) => p,
        None => return bad(request::CODE_BAD_FIELD, "hello.ack breaks its schema"),
    };
    if !PROTO_VERSIONS.contains(&proto) {
        return bad(hello::CODE_PROTO_MISMATCH, "this holder speaks protocol version 1");
    }
    let mut seen: Vec<&str> = Vec::new();
    for c in &caps {
        if !HOLDER_CAPS.contains(&c.as_str()) || seen.contains(&c.as_str()) {
            return bad(request::CODE_BAD_FIELD, "caps holds one this holder did not offer, or one twice");
        }
        seen.push(c.as_str());
    }
    if !seen.contains(&"core") {
        return bad(request::CODE_BAD_FIELD, "caps must hold core");
    }
    Ok(Allowed { local: seen.contains(&"local"), hooks: seen.contains(&HOOKS_CAP) })
}

impl Serve {
    fn holder(&self) -> Option<Arc<Holder>> {
        lock(&self.state).holder.clone()
    }

    fn is_attached(&self, conn: &Conn) -> bool {
        lock(&self.state).attached.as_ref().map(|a| a.id) == Some(conn.id)
    }

    /// True while `conn` is attached by the attach numbered `gen`.
    fn is_current(&self, conn: &Conn, gen: u64) -> bool {
        let st = lock(&self.state);
        st.attach_gen == gen && st.attached.as_ref().map(|a| a.id) == Some(conn.id)
    }

    /// Number one hook event and send it, with any still waiting, to the
    /// attached connection that takes them; with none, it waits in the
    /// queue. Its `seq`; None while the session is ending.
    fn post_hook(&self, kind: String, payload: Value) -> Option<u64> {
        let bytes = payload.to_json().len();
        let (seq, to) = {
            let mut hooks = lock(&self.hooks);
            if self.ending.load(Ordering::SeqCst) {
                return None;
            }
            let seq = hooks.queue.push(kind, payload, bytes);
            (seq, hooks.to.clone())
        };
        if let Some((conn, gen)) = to {
            // That connection's gate first, as an attach takes it, so no
            // event comes between an attach's reply and its replay, or after
            // `term.exit` or `term.detached`. Then the hook lock again: the
            // queue goes out in `seq` order, whichever poster sends it, and
            // only while that attach still holds the terminal. Otherwise the
            // event waits for the next attach, which takes the queue itself.
            let _live = lock(&conn.live);
            let mut hooks = lock(&self.hooks);
            let still = hooks.to.as_ref().map_or(false, |(c, g)| c.id == conn.id && *g == gen);
            if still && (!self.is_current(&conn, gen) || !send_waiting(&mut hooks.queue, &conn)) {
                hooks.to = None;
            }
        }
        Some(seq)
    }

    /// `conn`, attached by attach `gen`, takes hook events: every one
    /// waiting goes to it now, and each new one at once. The caller holds
    /// `conn.live` and has sent the `term.attached` reply and its replay.
    /// False when a send failed (the events not sent wait on).
    fn take_hooks(&self, conn: &Arc<Conn>, gen: u64) -> bool {
        let mut hooks = lock(&self.hooks);
        if !self.is_current(conn, gen) {
            // A newer attach holds the terminal and takes them.
            return true;
        }
        if !send_waiting(&mut hooks.queue, conn) {
            hooks.to = None;
            return false;
        }
        hooks.to = Some((Arc::clone(conn), gen));
        true
    }

    /// `conn` takes no more hook events; they wait for the next attach.
    /// Called under `conn.live` before the last message it gets as the
    /// attached connection (`term.detached`, `replaced`, `term.exit`, or
    /// `busy` when it fell behind), so no event follows that message; and
    /// when the connection goes.
    fn stop_hooks(&self, conn: &Conn) {
        let mut hooks = lock(&self.hooks);
        if hooks.to.as_ref().map(|(c, _)| c.id) == Some(conn.id) {
            hooks.to = None;
        }
    }

    /// The most JSON the next frame may hold: a launch may be large; once
    /// the session is launched or launching, only small messages come.
    fn max_json(&self) -> usize {
        let st = lock(&self.state);
        if st.holder.is_some() || st.launching {
            MAX_JSON_AFTER_LAUNCH
        } else {
            frame::MAX_JSON_APP_TO_HELPER
        }
    }

    /// Change the record and write it again, with `attached` as the state
    /// has it at this moment, so writes made in any order end on the truth.
    /// A write that fails (a reader holding the file on Windows) is tried a
    /// few more times, then given up, and the change waits for the next
    /// write: the record is for list mode, the session does not depend on
    /// it. Nothing is written once the session is ending, since its record is
    /// about to go. True when the record was written.
    fn update_record(&self, change: impl FnOnce(&mut Record)) -> bool {
        let mut rec = lock(&self.record);
        if self.ending.load(Ordering::SeqCst) {
            return false;
        }
        change(&mut *rec);
        rec.attached = lock(&self.state).attached.is_some();
        for _ in 0..5 {
            if store::write(&self.opts.store, &rec).is_ok() {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    /// Take the end of the session for this thread; false when another
    /// thread has it. Called with the state lock held.
    fn claim_end(&self, st: &mut State) -> bool {
        if st.ending {
            return false;
        }
        st.ending = true;
        self.ending.store(true, Ordering::SeqCst);
        true
    }

    /// `term.end` from `conn`: end the session, or have the thread ending it
    /// already answer this request too. Never returns: the process exits.
    fn finish(&self, conn: &Arc<Conn>, re: u64) -> ! {
        enum Turn {
            Carry,
            Answer(Option<i32>),
            Wait,
        }
        let turn = {
            let mut st = lock(&self.state);
            if self.claim_end(&mut st) {
                Turn::Carry
            } else if let Some(code) = st.ended {
                // Too late for the list that thread answers.
                Turn::Answer(code)
            } else {
                st.enders.push((Arc::clone(conn), re));
                Turn::Wait
            }
        };
        match turn {
            Turn::Carry => self.carry_out_end(Some((conn, re))),
            Turn::Answer(code) => say_ended(conn, re, code),
            Turn::Wait => {}
        }
        // The process exits from the thread that ends the session.
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }

    /// End the session and the process; only the thread that claimed the
    /// end calls this. `requester` gets `term.ended`, as does every
    /// `term.end` that came meanwhile; the attached connection, if another
    /// ended the session, gets `term.exit`.
    fn carry_out_end(&self, requester: Option<(&Arc<Conn>, u64)>) -> ! {
        // A launch in progress puts its holder in place before it clears
        // `launching`, so that holder is ended too.
        let deadline = Instant::now() + LAUNCH_WAIT;
        while lock(&self.state).launching && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let code = self.holder().and_then(|h| h.end());
        // The output the program gave up before its end goes out first. A
        // connection too slow for that loses the rest of it.
        let deadline = Instant::now() + transport::WRITE_TIMEOUT + Duration::from_secs(1);
        while self.forwarders.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let (enders, attached) = {
            let mut st = lock(&self.state);
            st.ended = Some(code);
            (std::mem::take(&mut st.enders), st.attached.clone())
        };
        // No hook event goes out after what the connections are told below:
        // one being sent finishes first, and later ones are refused
        // (`ending`) or wait in a queue that ends with the process.
        lock(&self.hooks).to = None;
        let mut told: Vec<Arc<Conn>> = Vec::new();
        for (conn, re) in requester.map(|(c, re)| (Arc::clone(c), re)).into_iter().chain(enders) {
            say_ended(&conn, re, code);
            told.push(conn);
        }
        if let Some(a) = attached {
            if !told.iter().any(|t| t.id == a.id) {
                let mut live = lock(&a.live);
                *live = 0;
                if let Some(c) = code {
                    a.send_exit(c);
                }
                a.closer.close_after_writes();
                drop(live);
                told.push(a);
            }
        }
        {
            // A change being written finishes first, and none follows (`ending`).
            let _record = lock(&self.record);
            store::remove(&self.opts.store, &self.opts.sid, std::process::id());
        }
        self.listener.remove();
        // Exiting closes every connection; each reads its last message first.
        let deadline = Instant::now() + transport::LINGER;
        for conn in &told {
            conn.closer.wait_peer_close(deadline.saturating_duration_since(Instant::now()));
        }
        std::process::exit(0);
    }

    fn clock(self: Arc<Self>) {
        let mut last_touch = Instant::now();
        let mut recorded_exit = false;
        loop {
            thread::sleep(TICK);
            if self.ending.load(Ordering::SeqCst) {
                return;
            }
            if !recorded_exit {
                if let Some(code) = self.holder().and_then(|h| h.exit_code()) {
                    // Not written (yet): tried again on the next tick.
                    recorded_exit = self.update_record(|r| {
                        r.child = "exited".to_string();
                        r.code = Some(i64::from(code));
                    });
                }
            }
            let expired = {
                let mut st = lock(&self.state);
                let away = st.away_since.map_or(false, |t| t.elapsed() >= self.opts.away);
                away && st.attached.is_none() && !st.launching && self.claim_end(&mut st)
            };
            if expired {
                self.carry_out_end(None);
            }
            if last_touch.elapsed() >= TOUCH_EVERY {
                self.listener.touch();
                last_touch = Instant::now();
            }
        }
    }

    fn serve_conn(self: Arc<Self>, stream: Stream) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (writer, closer) = match (stream.try_clone(), stream.try_clone()) {
            (Ok(w), Ok(c)) => (w, c),
            _ => return,
        };
        let mut reader = stream;
        let conn = Arc::new(Conn { id, writer: Mutex::new(writer), closer, live: Mutex::new(0), told_exit: AtomicBool::new(false) });
        let admitted = {
            let mut st = lock(&self.state);
            if st.conns >= MAX_CONNECTIONS {
                false
            } else {
                st.conns += 1;
                true
            }
        };
        if !admitted {
            if let Ok(line) = self.hello_line() {
                let _ = conn.send_bytes(format!("{line}\n").as_bytes());
            }
            let _ = conn.send_error(None, request::CODE_BUSY, "this holder serves 16 connections at most");
            conn.closer.close_after_writes();
            return;
        }
        self.converse(&conn, &mut reader);
        self.disconnected(&conn);
        conn.closer.close_after_writes();
    }

    fn hello_line(&self) -> Result<String, hello::HelloError> {
        let state = if self.holder().is_some() { "live" } else { "new" };
        hello::hello_line(&Hello {
            nonce: &self.nonce,
            helper_version: crate::VERSION,
            sha256: None,
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            caps: &HOLDER_CAPS,
            sid: &self.opts.sid,
            state,
        })
    }

    /// Read a whole frame within `limit`, its JSON at most `max_json` bytes;
    /// on anything but a frame, say why (when there is a why) and return
    /// None, which closes the connection.
    fn next_frame(&self, conn: &Conn, reader: &mut Stream, limit: Duration, waited: &str, max_json: usize) -> Option<Frame> {
        let mut timed = Deadline { stream: reader, until: Instant::now() + limit };
        match frame::read_frame_within(&mut timed, Direction::AppToHelper, max_json) {
            Ok(Some(f)) => Some(f),
            Ok(None) => None,
            Err(FrameError::BadFrame(why)) => {
                let _ = conn.send_error(None, frame::CODE_BAD_FRAME, why);
                None
            }
            Err(FrameError::Io(e)) if transport::is_timeout(&e) => {
                let _ = conn.send_error(None, request::CODE_TIMEOUT, waited);
                None
            }
            Err(FrameError::Io(_)) => None,
        }
    }

    fn converse(self: &Arc<Self>, conn: &Arc<Conn>, reader: &mut Stream) {
        let line = match self.hello_line() {
            Ok(l) => l,
            Err(_) => return,
        };
        if conn.send_bytes(format!("{line}\n").as_bytes()).is_err() {
            return;
        }
        let first = match self.next_frame(conn, reader, ACK_TIMEOUT, "no hello.ack in 10 seconds", MAX_JSON_BEFORE_ACK) {
            Some(f) => f,
            None => return,
        };
        let allowed = match &first.body {
            Body::Json(v) if first.channel == 0 => match check_ack(v) {
                Ok(allowed) => allowed,
                Err(r) => {
                    let _ = conn.refuse(&r);
                    return;
                }
            },
            _ => {
                let _ = conn.send_error(None, frame::CODE_BAD_FRAME, "the first frame must be hello.ack on channel 0");
                return;
            }
        };
        let mut refusals: VecDeque<Instant> = VecDeque::new();
        let mut input = InputGate::default();
        loop {
            let f = match self.next_frame(conn, reader, IDLE_TIMEOUT, "no frame from the app in 60 seconds", self.max_json()) {
                Some(f) => f,
                None => return,
            };
            match f.body {
                Body::Raw(bytes) => {
                    if f.channel != TERMINAL_CHANNEL || !self.is_attached(conn) {
                        let _ = conn.send_error(None, frame::CODE_BAD_FRAME, "raw bytes on a connection with no terminal attached");
                        return;
                    }
                    if let Some(h) = self.holder() {
                        // Input is queued, never waited on. A program that has
                        // stopped reading gets no more, and the app is told,
                        // for this frame and each one after it until a ping.
                        if input.offer(|| h.write_input(&bytes)) == Typed::Refused {
                            let _ = conn.send_error(None, request::CODE_BUSY, "the program is not reading its input; this frame and the ones after it until your next ping were not taken");
                        }
                    }
                }
                Body::Json(v) => {
                    if f.channel != 0 {
                        let _ = conn.send_error(None, frame::CODE_BAD_FRAME, "a control message off channel 0");
                        return;
                    }
                    match request::parse_allowed(&v, allowed) {
                        Ok(req) => {
                            if matches!(req, Request::Ping { .. }) {
                                input.ping();
                            }
                            if self.handle(conn, req, allowed) == Flow::Close {
                                return;
                            }
                        }
                        Err(r) => {
                            let _ = conn.refuse(&r);
                            if r.code == request::CODE_UNKNOWN_TYPE {
                                return;
                            }
                            let now = Instant::now();
                            refusals.push_back(now);
                            while refusals.front().map_or(false, |t| now.duration_since(*t) > Duration::from_secs(60)) {
                                refusals.pop_front();
                            }
                            if refusals.len() > REFUSALS_PER_MINUTE {
                                return;
                            }
                        }
                    }
                }
            }
        }
    }

    fn handle(self: &Arc<Self>, conn: &Arc<Conn>, req: Request, allowed: Allowed) -> Flow {
        match req {
            Request::Error => Flow::Continue,
            Request::Ping { id } => {
                let _ = conn.send_json(reply("pong", id, vec![]));
                Flow::Continue
            }
            Request::Launch(l) => {
                self.launch(conn, l);
                Flow::Continue
            }
            Request::Attach { id, from } => self.attach(conn, id, from, allowed.hooks),
            Request::HookEvent { id, kind, payload } => {
                match self.post_hook(kind, payload) {
                    Some(seq) => {
                        let _ = conn.send_json(hook_taken(id, seq));
                    }
                    None => {
                        let _ = conn.send_error(Some(id), request::CODE_NOT_FOUND, "the session is ending");
                    }
                }
                Flow::Continue
            }
            Request::Resize { id, size } => {
                let holder = {
                    let st = lock(&self.state);
                    if st.attached.as_ref().map(|a| a.id) == Some(conn.id) {
                        st.holder.clone()
                    } else {
                        None
                    }
                };
                match holder {
                    Some(h) => match h.resize(size) {
                        Ok(()) => {
                            let _ = conn.send_json(reply("term.resized", id, vec![]));
                        }
                        Err(e) => {
                            let _ = conn.send_error(Some(id), frame::CODE_IO, &format!("resize failed: {e}"));
                        }
                    },
                    None => {
                        let _ = conn.send_error(Some(id), request::CODE_NOT_CONNECTED, "this connection is not attached");
                    }
                }
                Flow::Continue
            }
            Request::Detach { id } => {
                let was = {
                    let mut st = lock(&self.state);
                    if st.attached.as_ref().map(|a| a.id) == Some(conn.id) {
                        if let Some(h) = &st.holder {
                            h.detach();
                        }
                        st.attached = None;
                        st.away_since = Some(Instant::now());
                        true
                    } else {
                        false
                    }
                };
                if !was {
                    let _ = conn.send_error(Some(id), request::CODE_NOT_CONNECTED, "this connection is not attached");
                    return Flow::Continue;
                }
                self.update_record(|_| {});
                // No live output, and no hook event, after the reply.
                let mut live = lock(&conn.live);
                *live = 0;
                self.stop_hooks(conn);
                let _ = conn.send_json(reply("term.detached", id, vec![]));
                drop(live);
                Flow::Close
            }
            Request::End { id } => self.finish(conn, id),
        }
    }

    fn launch(&self, conn: &Conn, l: Launch) {
        {
            let mut st = lock(&self.state);
            if st.ending {
                drop(st);
                let _ = conn.send_error(Some(l.id), request::CODE_NOT_FOUND, "the session is ending");
                return;
            }
            if st.holder.is_some() || st.launching {
                drop(st);
                let _ = conn.send_error(Some(l.id), request::CODE_BUSY, "this holder has launched its session already");
                return;
            }
            st.launching = true;
        }
        // A launch on the bundled ConPTY that cannot load it fails here,
        // before anything is started, and is answered `io` below.
        let opts = SpawnOptions {
            argv: l.argv.as_slice(),
            cwd: Some(l.cwd.as_str()),
            env: Some(l.env.as_slice()),
            size: l.size,
            line: l.line.as_deref(),
            conpty: l.conpty,
        };
        match Holder::start_with(&opts, self.opts.ring_bytes) {
            Ok(h) => {
                let pid = h.child_pid();
                {
                    // Put in place even if an end has begun: that end waits
                    // for this and ends it.
                    let mut st = lock(&self.state);
                    st.holder = Some(Arc::new(h));
                    st.launching = false;
                }
                self.update_record(mark_running);
                let _ = conn.send_json(reply("term.launched", l.id, vec![("pid", Value::uint(u64::from(pid)))]));
            }
            Err(e) => {
                // Nothing was launched: a later launch may try again.
                lock(&self.state).launching = false;
                let _ = conn.send_error(Some(l.id), frame::CODE_IO, &format!("could not start the program: {e}"));
            }
        }
    }

    /// `takes_hooks`: the connection acked `hooks`, so the hook events go to
    /// it once it is attached.
    fn attach(self: &Arc<Self>, conn: &Arc<Conn>, id: u64, from: u64, takes_hooks: bool) -> Flow {
        let taken = {
            let mut st = lock(&self.state);
            if st.ending {
                Err((request::CODE_NOT_FOUND, "the session is ending".to_string()))
            } else {
                match st.holder.clone() {
                    None => Err((request::CODE_NOT_FOUND, "nothing has been launched yet".to_string())),
                    Some(h) => match h.attach(from) {
                        Err(RingError::PastEnd { ring_end }) => Err((request::CODE_BAD_FIELD, format!("from {from} is past the end of the output ({ring_end})"))),
                        Ok(a) => {
                            let old = st.attached.replace(Arc::clone(conn)).filter(|o| o.id != conn.id);
                            st.attach_gen += 1;
                            st.away_since = None;
                            // Counted before the lock goes, so an end claimed
                            // after this waits for this forwarder's output.
                            let forwarding = a.exit_code.is_none().then(|| {
                                self.forwarders.fetch_add(1, Ordering::SeqCst);
                                Forwarding(Arc::clone(self))
                            });
                            Ok((h, a, old, st.attach_gen, forwarding))
                        }
                    },
                }
            }
        };
        // Every return below that starts no forwarder drops `forwarding`,
        // and the count with it.
        let (holder, attachment, old, gen, forwarding) = match taken {
            Ok(t) => t,
            Err((code, text)) => {
                let _ = conn.send_error(Some(id), code, &text);
                return Flow::Continue;
            }
        };
        if let Some(old) = old {
            let mut live = lock(&old.live);
            *live = 0;
            self.stop_hooks(&old);
            let _ = old.send_error(None, request::CODE_REPLACED, "a newer connection attached to this terminal");
            old.closer.close_after_writes();
            drop(live);
        }
        self.update_record(|_| {});
        let r = &attachment.replay;
        let mut more = vec![
            ("from", Value::uint(r.from)),
            ("ring_start", Value::uint(r.ring_start)),
            ("ring_end", Value::uint(r.ring_end)),
            ("truncated", Value::Bool(r.truncated)),
            ("running", Value::Bool(attachment.exit_code.is_none())),
        ];
        if let Some(code) = attachment.exit_code {
            more.push(("code", code_value(code)));
        }
        {
            // From here this connection carries this attach only: output an
            // earlier attach of its own still had queued is dropped (the
            // replay covers it from `from`), never sent after this reply.
            let mut live = lock(&conn.live);
            if !self.is_current(conn, gen) {
                // Another connection attached meanwhile and tells this one so.
                return Flow::Continue;
            }
            *live = gen;
            if conn.send_json(reply("term.attached", id, more)).is_err() || conn.send_terminal(&attachment.replay.bytes).is_err() {
                return Flow::Close;
            }
            // The hook events waiting go right after the reply and its
            // replay, before any live output.
            if takes_hooks && !self.take_hooks(conn, gen) {
                return Flow::Close;
            }
        }
        let forwarding = match forwarding {
            Some(f) => f,
            // Over before this attach: the reply said so, and nothing follows.
            None => return Flow::Continue,
        };
        let carried = Arc::clone(conn);
        let queue = attachment.live;
        let started = thread::Builder::new().spawn(move || {
            let serve = &forwarding.0;
            let conn = carried;
            while let Ok(chunk) = queue.recv() {
                let live = lock(&conn.live);
                if *live != gen {
                    // A newer attach, a detach or a replacement: not ours now.
                    return;
                }
                if conn.send_terminal(&chunk).is_err() {
                    return;
                }
                drop(live);
            }
            // The channel closed: detached, replaced, the session over, or
            // this connection fell too far behind. An end in progress says
            // so itself, after this output.
            let live = lock(&conn.live);
            if *live != gen || serve.ending.load(Ordering::SeqCst) || !serve.is_current(&conn, gen) {
                return;
            }
            // No hook event after either last word: later ones wait for the
            // next attach.
            match holder.exit_code() {
                Some(code) => conn.send_exit(code),
                None => {
                    let _ = conn.send_error(None, request::CODE_BUSY, "this connection fell too far behind; attach again from the last offset it saw");
                    conn.closer.close_after_writes();
                }
            }
            drop(live);
        });
        if started.is_err() {
            // No thread to carry the live output (the count went down with
            // the closure): the app is told and attaches again.
            let mut live = lock(&conn.live);
            *live = 0;
            let _ = conn.send_error(None, request::CODE_BUSY, "the holder could not carry live output; attach again from the last offset seen");
            drop(live);
            return Flow::Close;
        }
        Flow::Continue
    }

    fn disconnected(&self, conn: &Conn) {
        let was_attached = {
            let mut st = lock(&self.state);
            st.conns = st.conns.saturating_sub(1);
            if st.attached.as_ref().map(|a| a.id) == Some(conn.id) {
                if let Some(h) = &st.holder {
                    h.detach();
                }
                st.attached = None;
                st.away_since = Some(Instant::now());
                true
            } else {
                false
            }
        };
        self.stop_hooks(conn);
        if was_attached {
            self.update_record(|_| {});
        }
    }
}

/// Run a holder until its session ends. It returns only when it could not
/// start; otherwise the process exits from the end of its session.
pub fn run(opts: Options) -> io::Result<()> {
    let invalid = |what: &str| io::Error::new(io::ErrorKind::InvalidInput, what.to_string());
    if !hello::valid_sid(&opts.sid) {
        return Err(invalid("the session id breaks its pattern"));
    }
    if !store::valid_label(&opts.label) {
        return Err(invalid("the label is over 128 characters or holds a control character"));
    }
    let away = opts.away.as_secs();
    if !(1..=store::MAX_AWAY_SECS).contains(&away) {
        return Err(invalid("away must be 1 to 86400 seconds"));
    }
    store::prepare(&opts.store)?;
    // From the check to the written record under the store's lock: a second
    // holder for this session started at the same moment then finds this
    // one's record and its live endpoint, and list mode never removes a
    // record this one has just put in place of a stale one.
    let store_lock = store::lock(&opts.store)?;
    // A record whose process id was given to another process since is not a
    // holder: list mode would remove it, and this holder replaces it.
    if let Some(Ok(existing)) = store::read(&opts.store, &opts.sid) {
        if !store::holder_gone(&existing, crate::client::probe) {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, AlreadyRunning));
        }
    }
    let listener = Listener::bind(&opts.sid)?;
    let nonce = crate::random::hex(16)?;
    let record = Record {
        session: opts.sid.clone(),
        label: opts.label.clone(),
        pid: std::process::id(),
        endpoint: listener.endpoint().to_string(),
        nonce: nonce.clone(),
        helper: crate::VERSION.to_string(),
        started: store::now_ms(),
        away,
        attached: false,
        child: "waiting".to_string(),
        code: None,
    };
    store::write(&opts.store, &record)?;
    drop(store_lock);
    let serve = Arc::new(Serve {
        opts,
        nonce,
        listener,
        state: Mutex::new(State {
            holder: None,
            launching: false,
            conns: 0,
            attached: None,
            attach_gen: 0,
            away_since: Some(Instant::now()),
            ending: false,
            enders: Vec::new(),
            ended: None,
        }),
        hooks: Mutex::new(Hooks { queue: HookQueue::new(), to: None }),
        record: Mutex::new(record),
        ending: AtomicBool::new(false),
        next_id: AtomicU64::new(1),
        forwarders: AtomicUsize::new(0),
    });
    let clock = Arc::clone(&serve);
    if let Err(e) = thread::Builder::new().spawn(move || clock.clock()) {
        // No away clock, no holder: its record goes, and its endpoint with
        // the listener.
        store::remove(&serve.opts.store, &serve.opts.sid, std::process::id());
        return Err(e);
    }
    loop {
        match serve.listener.accept() {
            Ok(stream) => {
                if serve.ending.load(Ordering::SeqCst) {
                    continue;
                }
                let s = Arc::clone(&serve);
                // A connection no thread can be made for is closed (the
                // closure, and the stream in it, are dropped).
                if thread::Builder::new().spawn(move || s.serve_conn(stream)).is_err() {
                    thread::sleep(Duration::from_millis(50));
                }
            }
            // A passing failure: wait a moment and listen again.
            Err(_) => thread::sleep(Duration::from_millis(50)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    fn acked(text: &str) -> Result<Allowed, &'static str> {
        check_ack(&json::parse(text.as_bytes()).unwrap()).map_err(|r| r.code)
    }

    fn ack(text: &str) -> Result<bool, &'static str> {
        acked(text).map(|a| a.local)
    }

    #[test]
    fn hooks_is_offered_and_an_ack_of_it_allows_hook_events() {
        assert_eq!(HOLDER_CAPS, ["core", "local", "hooks"]);
        let both = Allowed { local: true, hooks: true };
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"hooks\"]}"), Ok(both));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"hooks\"]}"), Ok(Allowed { local: false, hooks: true }));
        // The app's own ack: no hook event will ever be sent to it.
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\"]}"), Ok(Allowed { local: true, hooks: false }));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"hooks\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"hooks\",\"hooks\"]}"), Err(request::CODE_BAD_FIELD));
    }

    fn event(seq: u64) -> HookEvent {
        HookEvent { seq, kind: "Stop".to_string(), payload: Value::obj(vec![("hook_event_name", Value::str("Stop"))]), bytes: 26 }
    }

    #[test]
    fn an_event_says_how_many_were_lost_only_when_some_were() {
        assert_eq!(event_message(&event(7), 0).to_json(), "{\"t\":\"event\",\"seq\":7,\"kind\":\"Stop\",\"payload\":{\"hook_event_name\":\"Stop\"}}");
        assert_eq!(event_message(&event(45), 44).to_json(), "{\"t\":\"event\",\"seq\":45,\"kind\":\"Stop\",\"payload\":{\"hook_event_name\":\"Stop\"},\"lost\":44}");
        assert_eq!(hook_taken(2, 7).to_json(), "{\"t\":\"hook.taken\",\"re\":2,\"seq\":7}");
    }

    #[test]
    fn the_first_frame_must_be_an_ack_of_what_was_offered() {
        assert_eq!(ack("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\"]}"), Ok(true));
        assert_eq!(ack("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\"]}"), Ok(false));
        assert_eq!(ack("{\"t\":\"hello.ack\",\"proto\":2,\"caps\":[\"core\"]}"), Err(hello::CODE_PROTO_MISMATCH));
        assert_eq!(ack("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"local\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(ack("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"files\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(ack("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"core\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(ack("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\"],\"x\":1}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(ack("{\"t\":\"ping\",\"id\":2}"), Err(request::CODE_UNKNOWN_TYPE));
        assert_eq!(ack("{\"proto\":1}"), Err(request::CODE_BAD_FIELD));
    }

    #[test]
    fn the_limits_are_the_documented_ones() {
        assert_eq!(MAX_CONNECTIONS, 16);
        assert_eq!(ACK_TIMEOUT, Duration::from_secs(10));
        assert_eq!(IDLE_TIMEOUT, Duration::from_secs(60));
        assert_eq!(REFUSALS_PER_MINUTE, 20);
        assert_eq!(MAX_JSON_BEFORE_ACK, 4 * 1024);
        assert_eq!(MAX_JSON_AFTER_LAUNCH, 64 * 1024);
    }

    fn full() -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::WouldBlock, "full"))
    }

    #[test]
    fn after_one_refused_frame_every_frame_is_refused_until_a_ping() {
        let mut gate = InputGate::default();
        assert_eq!(gate.offer(|| Ok(())), Typed::Taken);
        assert_eq!(gate.offer(full), Typed::Refused);
        // The queue has room again, and still nothing reaches the program:
        // it would see a gap where the refused frame was.
        let mut reached = false;
        assert_eq!(
            gate.offer(|| {
                reached = true;
                Ok(())
            }),
            Typed::Refused
        );
        assert!(!reached, "a frame after a refused one reached the program");
        gate.ping();
        assert_eq!(gate.offer(|| Ok(())), Typed::Taken);
        // A closed terminal is not a refusal: there is no gap to keep.
        assert_eq!(gate.offer(|| Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))), Typed::Taken);
        assert_eq!(gate.offer(|| Ok(())), Typed::Taken);
    }

    fn record(child: &str, code: Option<i64>) -> Record {
        Record {
            session: "serve-rec-01".to_string(),
            label: String::new(),
            pid: 1,
            endpoint: String::new(),
            nonce: String::new(),
            helper: "0.1.0".to_string(),
            started: 0,
            away: 120,
            attached: false,
            child: child.to_string(),
            code,
        }
    }

    #[test]
    fn a_launch_never_writes_over_a_recorded_exit() {
        let mut waiting = record("waiting", None);
        mark_running(&mut waiting);
        assert_eq!(waiting.child, "running");
        // The program exited, and the clock recorded it, before the launch
        // got to its own write.
        let mut exited = record("exited", Some(3));
        mark_running(&mut exited);
        assert_eq!((exited.child.as_str(), exited.code), ("exited", Some(3)));
    }

    #[test]
    fn only_the_already_running_refusal_reads_as_one() {
        assert!(already_running(&io::Error::new(io::ErrorKind::AlreadyExists, AlreadyRunning)));
        assert!(!already_running(&io::Error::new(io::ErrorKind::AlreadyExists, "a file that is there")));
        assert!(!already_running(&io::Error::from(io::ErrorKind::AlreadyExists)));
    }
}
