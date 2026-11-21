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
//! Tool streams (capability `mcp`, from 2.1.3-beta.10): a relay
//! (`aicc-helper mcp`, `relay.rs`) opens a stream with `mcp.open` and carries
//! one JSON-RPC message at a time on it (`mcp`), until `mcp.close` or its
//! connection goes. The holder numbers the stream itself (from 1, never
//! twice) and passes the three messages, and nothing else, between the relay
//! and the attached connection that acked `mcp`, which answers with `mcp` on
//! the holder's number. With no such connection attached, `mcp.open` gets
//! `not-connected`. A connection that opened a stream is a relay for the rest
//! of its life: it may not launch, attach, type, resize, detach or end. A
//! connection attached to the terminal opens no stream, and an attach that
//! only replays a program that has exited takes none. At most
//! `MAX_TOOL_STREAMS` are open at once. When the attached connection lets go
//! (detach, a newer attach, `term.exit`, falling behind, a drop) every stream
//! it carried ends and each relay is told (`mcp.close`); when a relay goes,
//! the app is told. A tool message is only passed on: nothing is run, opened
//! or written for it.
//!
//! Kept streams (capability `away`, from 2.1.3-beta.12): a stream whose relay
//! acked `away` does not end when the app lets go while the program runs. It
//! is kept with no app side, and its relay is told `mcp.away`; an `mcp.open`
//! from such a relay while no connection takes tool streams is taken,
//! numbered and kept the same way, and answered `mcp.away`. A kept stream
//! counts toward `MAX_TOOL_STREAMS`, and an `mcp` from its relay is
//! `not-connected` (the stream goes on). The next attach that takes tool
//! streams is given every kept stream (`mcp.open`, on the holder's number, as
//! a new one is), and each relay is then told `mcp.back`. An app connection
//! that lets go gives up the terminal before its streams, so a newer attach
//! in between takes tool streams first and that connection's streams are
//! kept after it; the clock gives any such stream to it on its next tick, the
//! same way. A session keeps no stream once its program has exited: each
//! kept one ends (`mcp.close`) on the clock's next tick. A stream changes its
//! app side only under its relay's gate and the gate of the app connection it
//! leaves or joins, so either gate held keeps it where it is.
//!
//! Screen reads (capability `screen`, from 2.1.3-beta.12): a connection that
//! acked `screen` may ask for the session's screen (`screen.read`, answered
//! `screen.rows`) and its last lines (`screen.tail`, answered
//! `screen.lines`), from the holder's own screen (`screen.rs`), whether or not
//! it is the attached connection. Both are read-only: neither attaches,
//! types, resizes or ends, and neither moves an offset or changes which
//! connection is attached. A relay asks for neither (`unknown-type`, as for
//! the terminal messages). Each answer is one message within what a frame to
//! the app holds: rows that do not fit are left out from the top, and the
//! answer says so (`cut`). The holder decides nothing from a screen.
//!
//! Locks: a connection's stream gate (`Conn::live`) first (the attached
//! connection's before a relay's, which guards that relay's tool messages),
//! then the hook events (`Serve::hooks`), then the tool streams
//! (`Serve::tools`), then the record, then the serve state, then the holder's
//! own, its screen's last (never the other way), and nothing is written to a
//! connection while the record, the serve state or the screen is held. Hook events are written to a
//! connection under its gate and the hook lock, so they go out in `seq` order
//! and never inside an attach's reply and replay or after its last word; the
//! hook lock is held for at most `WRITE_TIMEOUT` of writing at a time. A tool
//! message is written under the gate of the connection it goes to, and only
//! while its stream is with that connection, which a stream joins and leaves
//! under; so no tool message follows the last word either.

use crate::frame::{self, Body, Direction, Frame, FrameError};
use crate::hello::{self, Hello, PROTO_VERSIONS};
use crate::holder::{lock, HookEvent, HookQueue, Holder};
use crate::json::Value;
use crate::pty::SpawnOptions;
use crate::request::{self, Allowed, Launch, Refusal, Request, MAX_MCP_TO_APP};
use crate::ring::RingError;
use crate::screen;
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
/// The capability that allows tool streams (from 2.1.3-beta.10).
pub const MCP_CAP: &str = "mcp";
/// The capability that keeps a relay's tool stream while the app is away
/// (from 2.1.3-beta.12). Only a relay acks it, with `mcp`.
pub const AWAY_CAP: &str = "away";
/// The capability that allows screen reads (from 2.1.3-beta.12).
pub const SCREEN_CAP: &str = "screen";
/// What a holder offers in its hello: the frozen core, `local` for the
/// terminal messages, `hooks` for hook events (from 2.1.3-beta.8), `mcp` for
/// tool streams (from 2.1.3-beta.10), `away` for kept tool streams and
/// `screen` for screen reads (both from 2.1.3-beta.12). The app acks `core`
/// and `local` (`hello::LOCAL_CAPS`), and `hooks` on a connection that takes
/// hook events; the hook mode acks `hook::ACK_CAPS` and the relay
/// `relay::ACK_CAPS`. Nothing acks `screen` yet.
pub const HOLDER_CAPS: [&str; 5] = ["core", "local", HOOKS_CAP, MCP_CAP, AWAY_CAP];
/// The most JSON a screen answer may be: what one frame to the app holds.
pub const SCREEN_ANSWER_MAX: usize = frame::MAX_JSON_HELPER_TO_APP;
/// Tool streams one session may have open at once; one more `mcp.open` gets
/// `busy`.
pub const MAX_TOOL_STREAMS: usize = 8;
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
    /// stops it before saying so. On a relay, which never attaches, it is
    /// the gate of its tool messages: one goes to it, and its stream ends,
    /// only under this lock.
    live: Mutex<u64>,
    /// Set, under `live`, once this connection has been sent `term.exit`.
    told_exit: AtomicBool,
    /// Set once this connection has opened a tool stream: it is a relay for
    /// the rest of its life, and never uses the terminal.
    relay: AtomicBool,
    /// Set once its `hello.ack` named `mcp` and `away`: a stream it opens is
    /// kept while the app is away.
    away: AtomicBool,
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

    /// A tool message to a relay. It goes on to a CLI, the way section 6
    /// calls app to helper, so its frame may be as large as that way allows
    /// (a tool result can carry a screenshot).
    fn send_to_relay(&self, v: Value) -> io::Result<()> {
        let bytes = frame::encode(&Frame::json(0, v), Direction::AppToHelper).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        self.send_bytes(&bytes)
    }

    fn is_relay(&self) -> bool {
        self.relay.load(Ordering::SeqCst)
    }

    /// True when a stream this connection opens is kept while the app is away.
    fn keeps(&self) -> bool {
        self.away.load(Ordering::SeqCst)
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

/// One tool stream: the relay's connection and the relay's own number for
/// it, the attached connection it is with (None: kept while the app is away),
/// and the holder's number for it, the one that connection sees.
struct ToolStream {
    num: u64,
    relay: Arc<Conn>,
    relay_num: u64,
    app: Option<Arc<Conn>>,
}

impl ToolStream {
    /// The id of the app connection it is with; None while it is kept.
    fn app_id(&self) -> Option<u64> {
        self.app.as_ref().map(|a| a.id)
    }
}

/// The session's tool streams, and the attached connection that takes new
/// ones (None: `mcp.open` gets `not-connected`, or is kept for a relay that
/// acked `away`). Every open stream is with that connection or kept: when it
/// lets go, each of its streams ends or is kept.
struct Tools {
    to: Option<Arc<Conn>>,
    open: Vec<ToolStream>,
    /// The number the last stream took: each takes the next, from 1, and no
    /// number is used twice in a holder's life.
    last: u64,
}

/// A tool message for a stream that is not open (or not this connection's).
const NO_STREAM: (&str, &str) = (request::CODE_NOT_FOUND, "no tool stream of this connection has that number");
/// An `mcp` from a relay whose stream is kept: not passed on, and the stream
/// goes on.
const KEPT: (&str, &str) = (request::CODE_NOT_CONNECTED, "this tool stream is kept while the app is away; the message was not passed on");

struct Serve {
    opts: Options,
    nonce: String,
    listener: Listener,
    state: Mutex<State>,
    hooks: Mutex<Hooks>,
    tools: Mutex<Tools>,
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

/// `mcp.open`: tool stream `stream` begins (from a relay, its own number;
/// from the holder to the app, the holder's).
pub fn mcp_open(stream: u64) -> Value {
    Value::obj(vec![("t", Value::str("mcp.open")), ("stream", Value::uint(stream))])
}

/// `mcp`: one JSON-RPC message on tool stream `stream`.
pub fn mcp_message(stream: u64, message: Value) -> Value {
    Value::obj(vec![("t", Value::str("mcp")), ("stream", Value::uint(stream)), ("message", message)])
}

/// `mcp.close`: tool stream `stream` ends.
pub fn mcp_close(stream: u64) -> Value {
    Value::obj(vec![("t", Value::str("mcp.close")), ("stream", Value::uint(stream))])
}

/// `mcp.away`: to a relay that acked `away`, on its number. No connection
/// takes its stream now; the stream is kept.
pub fn mcp_away(stream: u64) -> Value {
    Value::obj(vec![("t", Value::str("mcp.away")), ("stream", Value::uint(stream))])
}

/// `mcp.back`: to a relay that acked `away`, on its number. A connection
/// takes its stream again.
pub fn mcp_back(stream: u64) -> Value {
    Value::obj(vec![("t", Value::str("mcp.back")), ("stream", Value::uint(stream))])
}

/// One row of `screen.rows`, as the app's readers take a row.
fn row_value(l: &screen::Line) -> Value {
    Value::obj(vec![("text", Value::str(&l.text)), ("typed", Value::str(&l.typed)), ("inverse", Value::str(&l.inverse)), ("width", Value::uint(u64::from(l.width))), ("end", Value::uint(u64::from(l.end)))])
}

/// The modes of `screen.rows`: fixed words and yes or no values.
fn modes_value(m: &screen::Modes) -> Value {
    Value::obj(vec![
        ("screen", Value::str(m.screen_word())),
        ("bracketed_paste", Value::Bool(m.bracketed_paste)),
        ("application_cursor", Value::Bool(m.application_cursor)),
        ("application_keypad", Value::Bool(m.application_keypad)),
        ("mouse", Value::str(m.mouse)),
        ("mouse_encoding", Value::str(m.mouse_encoding)),
        ("cursor_hidden", Value::Bool(m.cursor_hidden)),
    ])
}

/// The last of `items` whose JSON, a comma each, fits in `room` bytes, in
/// order, and whether any were left out (from the start).
fn the_last_that_fit(items: Vec<Value>, room: usize) -> (Vec<Value>, bool) {
    let mut used = 0usize;
    let mut first = items.len();
    for (i, item) in items.iter().enumerate().rev() {
        let size = item.to_json().len() + 1;
        if used + size > room {
            break;
        }
        used += size;
        first = i;
    }
    let cut = first > 0;
    (items.into_iter().skip(first).collect(), cut)
}

/// `screen.rows`: the reply to `screen.read` `re`. `lines` holds the rows
/// from the top, all of them unless `cut`: then the bottom rows that fit in
/// one message to the app, which the readers look at first.
pub fn screen_rows_message(re: u64, r: &screen::Read) -> Value {
    let message = |lines: Vec<Value>, cut: bool| {
        reply(
            "screen.rows",
            re,
            vec![
                ("cols", Value::uint(u64::from(r.cols))),
                ("rows", Value::uint(u64::from(r.rows))),
                ("cursor", Value::obj(vec![("row", Value::uint(u64::from(r.cursor_row))), ("col", Value::uint(u64::from(r.cursor_col)))])),
                ("modes", modes_value(&r.modes)),
                ("cut", Value::Bool(cut)),
                ("lines", Value::Arr(lines)),
            ],
        )
    };
    let room = SCREEN_ANSWER_MAX.saturating_sub(message(Vec::new(), false).to_json().len());
    let (lines, cut) = the_last_that_fit(r.lines.iter().map(row_value).collect(), room);
    message(lines, cut)
}

/// `screen.lines`: the reply to `screen.tail` `re`, the lines oldest first,
/// all of them unless `cut`: then the newest that fit in one message.
pub fn screen_lines_message(re: u64, lines: &[screen::TailLine]) -> Value {
    let message = |lines: Vec<Value>, cut: bool| reply("screen.lines", re, vec![("cut", Value::Bool(cut)), ("lines", Value::Arr(lines))]);
    let room = SCREEN_ANSWER_MAX.saturating_sub(message(Vec::new(), false).to_json().len());
    let items = lines.iter().map(|l| Value::obj(vec![("text", Value::str(&l.text)), ("typed", Value::str(&l.typed))])).collect();
    let (lines, cut) = the_last_that_fit(items, room);
    message(lines, cut)
}

/// Send `conn` every hook event waiting, oldest first; each leaves the queue
/// once it is sent. The whole queue goes within `WRITE_TIMEOUT`, however
/// many events it holds, so the hook lock is never held longer: a connection
/// that does not take them in time is closed. False when a send failed or
/// the time ran out: that event and those after it wait on (the app drops a
/// `seq` it has already seen). An event always encodes: its payload came in
/// a frame of at most 32 levels and is at most `MAX_HOOK_PAYLOAD`, so the
/// event is at most 64 KiB of JSON.
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
/// them. Returns what the ack allowed (`local`, `hooks`, `mcp`, `screen`), and whether
/// a stream the connection opens is kept while the app is away (`away`,
/// which counts only beside `mcp`).
fn check_ack(v: &Value) -> Result<(Allowed, bool), Refusal> {
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
    let allowed = Allowed { local: seen.contains(&"local"), hooks: seen.contains(&HOOKS_CAP), mcp: seen.contains(&MCP_CAP), screen: seen.contains(&SCREEN_CAP) };
    Ok((allowed, allowed.mcp && seen.contains(&AWAY_CAP)))
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

    /// Number one hook event (its payload `bytes` long as JSON) and send it,
    /// with any still waiting, to the attached connection that takes them;
    /// with none, it waits in the queue. Its `seq`; None while the session
    /// is ending.
    fn post_hook(&self, kind: String, payload: Value, bytes: usize) -> Option<u64> {
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
    /// `busy` when it fell behind or no thread could carry its output), so
    /// no event follows that message; and when the connection goes.
    fn stop_hooks(&self, conn: &Conn) {
        let mut hooks = lock(&self.hooks);
        if hooks.to.as_ref().map(|(c, _)| c.id) == Some(conn.id) {
            hooks.to = None;
        }
    }

    /// `conn`, attached by attach `gen`, takes tool streams from now on, and
    /// is given every kept one: `mcp.open` on the holder's number, as a new
    /// stream is, then `mcp.back` to that stream's relay, on the relay's
    /// number. The caller holds `conn.live` and has sent the `term.attached`
    /// reply and its replay.
    fn take_tools(&self, conn: &Arc<Conn>, gen: u64) {
        {
            let mut tools = lock(&self.tools);
            if !self.is_current(conn, gen) {
                return;
            }
            tools.to = Some(Arc::clone(conn));
        }
        self.give_kept(conn);
    }

    /// Every kept stream goes to `conn`, the connection that takes tool
    /// streams: `mcp.open` on the holder's number, as a new stream is, then
    /// `mcp.back` to that stream's relay, on the relay's number. The caller
    /// holds `conn.live`, under which `conn` started taking tool streams; a
    /// stream is given only while it still does (`stop_tools` clears that
    /// under the same gate).
    fn give_kept(&self, conn: &Arc<Conn>) {
        let kept: Vec<(Arc<Conn>, u64)> = lock(&self.tools).open.iter().filter(|s| s.app.is_none()).map(|s| (Arc::clone(&s.relay), s.num)).collect();
        for (relay, num) in kept {
            let _relay_gate = lock(&relay.live);
            let given = {
                let mut tools = lock(&self.tools);
                // Still kept, and this connection still takes tool streams
                // (an end clears both).
                let still = tools.to.as_ref().map(|c| c.id) == Some(conn.id);
                match tools.open.iter_mut().find(|s| s.num == num && s.app.is_none()) {
                    Some(s) if still => {
                        s.app = Some(Arc::clone(conn));
                        Some(s.relay_num)
                    }
                    _ => None,
                }
            };
            // The relay is told only once the app has been: a write that
            // fails ends that connection, which keeps the stream again as it
            // goes.
            if let Some(relay_num) = given {
                if conn.send_json(mcp_open(num)).is_ok() {
                    let _ = relay.send_json(mcp_back(relay_num));
                }
            }
        }
    }

    /// `app` takes no more tool streams, and every stream it carried leaves
    /// it. One whose relay acked `away` is kept while the program runs, and
    /// its relay is told `mcp.away`; any other ends, and its relay is told
    /// `mcp.close` (each on the relay's number). Called under `app.live`,
    /// beside `stop_hooks`: before the last message `app` gets as the
    /// attached connection, and when it goes. `app` is not told.
    fn stop_tools(&self, app: &Conn) {
        let carried: Vec<(Arc<Conn>, u64)> = {
            let mut tools = lock(&self.tools);
            if tools.to.as_ref().map(|c| c.id) == Some(app.id) {
                tools.to = None;
            }
            tools.open.iter().filter(|s| s.app_id() == Some(app.id)).map(|s| (Arc::clone(&s.relay), s.num)).collect()
        };
        let runs = self.program_runs();
        for (relay, num) in carried {
            let _gate = lock(&relay.live);
            if runs && relay.keeps() {
                if let Some(relay_num) = self.keep_stream(num, app.id) {
                    let _ = relay.send_json(mcp_away(relay_num));
                }
            } else if let Some(ended) = self.end_stream(num) {
                let _ = relay.send_json(mcp_close(ended.relay_num));
            }
        }
    }

    /// Stream `num`, while it is still with the app connection `app_id`, is
    /// kept with no app side: its relay's number for it. None when it left
    /// that connection or ended meanwhile.
    fn keep_stream(&self, num: u64, app_id: u64) -> Option<u64> {
        let mut tools = lock(&self.tools);
        let s = tools.open.iter_mut().find(|s| s.num == num && s.app_id() == Some(app_id))?;
        s.app = None;
        Some(s.relay_num)
    }

    /// Every kept stream ends, and its relay is told `mcp.close` on its
    /// number: a session keeps no tool stream past its program. The clock
    /// calls this on each tick once the program has exited.
    fn end_kept(&self) {
        let kept: Vec<(Arc<Conn>, u64)> = lock(&self.tools).open.iter().filter(|s| s.app.is_none()).map(|s| (Arc::clone(&s.relay), s.num)).collect();
        for (relay, num) in kept {
            let _gate = lock(&relay.live);
            let ended = {
                let mut tools = lock(&self.tools);
                let at = tools.open.iter().position(|s| s.num == num && s.app.is_none());
                at.map(|at| tools.open.remove(at))
            };
            if let Some(ended) = ended {
                let _ = relay.send_json(mcp_close(ended.relay_num));
            }
        }
    }

    /// A stream kept while a connection takes tool streams goes to that
    /// connection (`give_kept`). Only a race leaves one so: an app connection
    /// that lets go (a detach, or a dropped connection) gives up the terminal
    /// first and its streams after, so a newer attach in between takes tool
    /// streams, and is given the kept ones, before that connection's streams
    /// are kept. The clock calls this on each tick while the program runs.
    fn give_stranded(&self) {
        let to = {
            let tools = lock(&self.tools);
            match &tools.to {
                Some(c) if tools.open.iter().any(|s| s.app.is_none()) => Arc::clone(c),
                _ => return,
            }
        };
        let _gate = lock(&to.live);
        let still = lock(&self.tools).to.as_ref().map(|c| c.id) == Some(to.id);
        if still {
            self.give_kept(&to);
        }
    }

    /// True while the session's program has been launched and has not exited.
    fn program_runs(&self) -> bool {
        self.holder().map_or(false, |h| h.exit_code().is_none())
    }

    /// Take stream `num` out of the table; None when it has ended already.
    fn end_stream(&self, num: u64) -> Option<ToolStream> {
        let mut tools = lock(&self.tools);
        let at = tools.open.iter().position(|s| s.num == num)?;
        Some(tools.open.remove(at))
    }

    /// The app connection stream `num` is with now: None when it has ended,
    /// Some(None) while it is kept.
    fn app_of(&self, num: u64) -> Option<Option<u64>> {
        lock(&self.tools).open.iter().find(|s| s.num == num).map(ToolStream::app_id)
    }

    /// `relay`'s stream (the one it numbered `relay_num`, or whichever it has
    /// for None): the app connection it is with (None while it is kept), and
    /// the holder's number.
    fn stream_of_relay(&self, relay: &Conn, relay_num: Option<u64>) -> Option<(Option<Arc<Conn>>, u64)> {
        let tools = lock(&self.tools);
        let s = tools.open.iter().find(|s| s.relay.id == relay.id && relay_num.map_or(true, |n| n == s.relay_num))?;
        Some((s.app.clone(), s.num))
    }

    /// The stream `app` knows as `num`: its relay, and the relay's number.
    fn stream_of_app(&self, app: &Conn, num: u64) -> Option<(Arc<Conn>, u64)> {
        let tools = lock(&self.tools);
        let s = tools.open.iter().find(|s| s.app_id() == Some(app.id) && s.num == num)?;
        Some((Arc::clone(&s.relay), s.relay_num))
    }

    /// `mcp.open` from `relay`, for the stream it numbers `relay_num` (it has
    /// none open: `admit`): the holder numbers it too and tells the attached
    /// connection that takes tool streams. With none, a relay that acked
    /// `away` has its stream kept while the program runs, and is told
    /// `mcp.away`; any other is refused `not-connected`. `busy` when
    /// `MAX_TOOL_STREAMS` are open, kept ones among them. Neither refusal
    /// takes a number.
    fn open_stream(&self, relay: &Arc<Conn>, relay_num: u64) -> Result<(), (&'static str, &'static str)> {
        let not_connected = (request::CODE_NOT_CONNECTED, "no connection attached to the terminal takes tool streams");
        let busy = (request::CODE_BUSY, "this session has 8 tool streams open, the most it may");
        // A stream is taken toward an app under that app's gate, and kept
        // under its relay's. A connection that starts or stops taking tool
        // streams between the look and the gates sends this round again; a
        // few rounds that all lose such a race are `not-connected`.
        for _ in 0..4 {
            let to = lock(&self.tools).to.clone();
            match to {
                Some(app) => {
                    let _app_gate = lock(&app.live);
                    let num = {
                        let mut tools = lock(&self.tools);
                        if tools.to.as_ref().map(|c| c.id) != Some(app.id) {
                            // It let go meanwhile.
                            continue;
                        }
                        if tools.open.len() >= MAX_TOOL_STREAMS {
                            return Err(busy);
                        }
                        tools.last += 1;
                        let num = tools.last;
                        tools.open.push(ToolStream { num, relay: Arc::clone(relay), relay_num, app: Some(Arc::clone(&app)) });
                        num
                    };
                    relay.relay.store(true, Ordering::SeqCst);
                    // A write that fails ends that connection, and the stream
                    // with it, or keeps it.
                    let _ = app.send_json(mcp_open(num));
                    return Ok(());
                }
                None if relay.keeps() => {
                    let _relay_gate = lock(&relay.live);
                    {
                        let mut tools = lock(&self.tools);
                        if tools.to.is_some() {
                            // A connection takes tool streams now.
                            continue;
                        }
                        if self.ending.load(Ordering::SeqCst) || !self.program_runs() {
                            return Err(not_connected);
                        }
                        if tools.open.len() >= MAX_TOOL_STREAMS {
                            return Err(busy);
                        }
                        tools.last += 1;
                        let num = tools.last;
                        tools.open.push(ToolStream { num, relay: Arc::clone(relay), relay_num, app: None });
                    }
                    relay.relay.store(true, Ordering::SeqCst);
                    let _ = relay.send_json(mcp_away(relay_num));
                    return Ok(());
                }
                None => return Err(not_connected),
            }
        }
        Err(not_connected)
    }

    /// `mcp` from `relay` on its stream `relay_num`: to the app, on the
    /// holder's number. While the stream is kept it is `not-connected`, and
    /// so is one read before the stream left the app it was with: its relay
    /// was told `mcp.away` after sending it, and answers that call itself.
    fn relay_says(&self, relay: &Conn, relay_num: u64, message: Value) -> Result<(), (&'static str, &'static str)> {
        let (app, num) = self.stream_of_relay(relay, Some(relay_num)).ok_or(NO_STREAM)?;
        let app = app.ok_or(KEPT)?;
        let _app_gate = lock(&app.live);
        match self.app_of(num) {
            None => Err(NO_STREAM),
            Some(now) if now == Some(app.id) => {
                let _ = app.send_json(mcp_message(num, message));
                Ok(())
            }
            Some(_) => Err(KEPT),
        }
    }

    /// `mcp` from the app on stream `num`: to that stream's relay, on the
    /// relay's number, while the stream is still with this app.
    fn app_says(&self, app: &Conn, num: u64, message: Value) -> Result<(), (&'static str, &'static str)> {
        let (relay, relay_num) = self.stream_of_app(app, num).ok_or(NO_STREAM)?;
        let _relay_gate = lock(&relay.live);
        // A stream that left this app meanwhile: its relay has been told
        // `mcp.away` and has answered the calls it had in the app's place.
        if self.app_of(num) != Some(Some(app.id)) {
            return Err(NO_STREAM);
        }
        let _ = relay.send_to_relay(mcp_message(relay_num, message));
        Ok(())
    }

    /// `relay`'s stream ends: `mcp.close` from it (the stream it numbers
    /// `relay_num`), or its connection went (None). The app it is with is
    /// told, unless the stream had ended already or is kept. False when
    /// there was no such stream.
    fn relay_ends(&self, relay: &Conn, relay_num: Option<u64>) -> bool {
        loop {
            let (app, num) = match self.stream_of_relay(relay, relay_num) {
                Some(found) => found,
                None => return false,
            };
            let _app_gate = app.as_ref().map(|a| lock(&a.live));
            let _relay_gate = lock(&relay.live);
            // Under its relay's gate a stream keeps its app side. One that
            // changed it before the gates were had is looked at again.
            let ended = {
                let mut tools = lock(&self.tools);
                let at = match tools.open.iter().position(|s| s.num == num) {
                    Some(at) => at,
                    None => return false,
                };
                if tools.open[at].app_id() == app.as_ref().map(|a| a.id) {
                    Some(tools.open.remove(at))
                } else {
                    None
                }
            };
            if ended.is_some() {
                if let Some(app) = &app {
                    let _ = app.send_json(mcp_close(num));
                }
                return true;
            }
        }
    }

    /// The rules a message must also keep that depend on the connection: one
    /// that opened a tool stream is a relay for the rest of its life and does
    /// not use the terminal or read its screen (`unknown-type`, and a close);
    /// one attached to the
    /// terminal opens no tool stream, and a relay one at a time (`bad-field`);
    /// and a relay's message goes on to the app, whose frames hold 1 MiB
    /// (`too-large`). Only this connection's own thread opens its stream, so
    /// what is checked here still holds when the message is carried out.
    fn admit(&self, conn: &Conn, req: Request) -> Result<Request, Refusal> {
        let relay = conn.is_relay();
        let refused: Option<(&'static str, &'static str)> = match &req {
            Request::Launch(_) | Request::Attach { .. } | Request::Resize { .. } | Request::Detach { .. } | Request::End { .. } if relay => {
                Some((request::CODE_UNKNOWN_TYPE, "a connection that opened a tool stream does not use the terminal"))
            }
            Request::ScreenRead { .. } | Request::ScreenTail { .. } if relay => Some((request::CODE_UNKNOWN_TYPE, "a connection that opened a tool stream does not read the screen")),
            Request::McpOpen { .. } if self.is_attached(conn) => Some((request::CODE_BAD_FIELD, "a connection attached to the terminal opens no tool stream")),
            Request::McpOpen { .. } if self.stream_of_relay(conn, None).is_some() => Some((request::CODE_BAD_FIELD, "this connection has a tool stream open already")),
            Request::Mcp { bytes, .. } if relay && *bytes > MAX_MCP_TO_APP => Some((request::CODE_TOO_LARGE, "message is over 1048320 bytes as JSON, the most the app takes")),
            _ => None,
        };
        match refused {
            Some((code, text)) => Err(Refusal { code, re: None, text: text.to_string() }),
            None => Ok(req),
        }
    }

    /// The most JSON the next frame may hold: a launch may be large; once
    /// the session is launched or launching, only small messages come, except
    /// on a connection that acked `mcp` (`takes_tools`), which may carry a
    /// tool result and so takes what section 6 allows.
    fn max_json(&self, takes_tools: bool) -> usize {
        if takes_tools {
            return frame::MAX_JSON_APP_TO_HELPER;
        }
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
        {
            // No tool message either: each relay reads the end of its
            // connection when the process exits.
            let mut tools = lock(&self.tools);
            tools.to = None;
            tools.open.clear();
        }
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
            // A session keeps no tool stream past its program: on every tick,
            // so one kept while the program was ending ends too. While it
            // runs, a stream a race left kept beside a connection that takes
            // tool streams goes to that connection.
            match self.holder().map(|h| h.exit_code().is_some()) {
                Some(true) => self.end_kept(),
                Some(false) => self.give_stranded(),
                None => {}
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
        let conn = Arc::new(Conn {
            id,
            writer: Mutex::new(writer),
            closer,
            live: Mutex::new(0),
            told_exit: AtomicBool::new(false),
            relay: AtomicBool::new(false),
            away: AtomicBool::new(false),
        });
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
                Ok((allowed, away)) => {
                    conn.away.store(away, Ordering::SeqCst);
                    allowed
                }
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
            let f = match self.next_frame(conn, reader, IDLE_TIMEOUT, "no frame from the app in 60 seconds", self.max_json(allowed.mcp)) {
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
                    match request::parse_allowed(&v, allowed).and_then(|req| self.admit(conn, req)) {
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
            Request::Attach { id, from } => self.attach(conn, id, from, allowed),
            Request::McpOpen { stream } => {
                if let Err((code, text)) = self.open_stream(conn, stream) {
                    let _ = conn.send_error(None, code, text);
                }
                Flow::Continue
            }
            Request::Mcp { stream, message, .. } => {
                let passed = if conn.is_relay() { self.relay_says(conn, stream, message) } else { self.app_says(conn, stream, message) };
                if let Err((code, text)) = passed {
                    let _ = conn.send_error(None, code, text);
                }
                Flow::Continue
            }
            Request::McpClose { stream } => {
                // Only a relay ends a stream: the app's side ends with its attach.
                if !self.relay_ends(conn, Some(stream)) {
                    let _ = conn.send_error(None, NO_STREAM.0, NO_STREAM.1);
                }
                Flow::Continue
            }
            Request::HookEvent { id, kind, payload, bytes } => {
                match self.post_hook(kind, payload, bytes) {
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
                // No live output, no hook event and no tool message after
                // the reply.
                let mut live = lock(&conn.live);
                *live = 0;
                self.stop_hooks(conn);
                self.stop_tools(conn);
                let _ = conn.send_json(reply("term.detached", id, vec![]));
                drop(live);
                Flow::Close
            }
            Request::End { id } => self.finish(conn, id),
            Request::ScreenRead { id } => {
                self.answer_screen(conn, id, None);
                Flow::Continue
            }
            Request::ScreenTail { id, count } => {
                self.answer_screen(conn, id, Some(count));
                Flow::Continue
            }
        }
    }

    /// `screen.read` (`tail` None) or `screen.tail` `id` from `conn`, attached
    /// or not, answered from the holder's screen. Nothing changes: no offset,
    /// no attach, no size. Before a launch, and while the session is ending,
    /// `not-found`; a screen the holder no longer keeps (its parser failed),
    /// `io`.
    fn answer_screen(&self, conn: &Conn, id: u64, tail: Option<usize>) {
        let holder = {
            let st = lock(&self.state);
            if st.ending {
                Err("the session is ending")
            } else {
                st.holder.clone().ok_or("nothing has been launched yet")
            }
        };
        let holder = match holder {
            Ok(h) => h,
            Err(text) => {
                let _ = conn.send_error(Some(id), request::CODE_NOT_FOUND, text);
                return;
            }
        };
        let answer = match tail {
            None => holder.screen_read().map(|r| screen_rows_message(id, &r)),
            Some(count) => holder.screen_tail(count).map(|lines| screen_lines_message(id, &lines)),
        };
        match answer {
            Some(v) => {
                let _ = conn.send_json(v);
            }
            None => {
                let _ = conn.send_error(Some(id), frame::CODE_IO, "this session's screen is not kept: reading its output failed");
            }
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

    /// `allowed`: what the connection acked. With `hooks`, the hook events go
    /// to it once it is attached; with `mcp`, it takes tool streams.
    fn attach(self: &Arc<Self>, conn: &Arc<Conn>, id: u64, from: u64, allowed: Allowed) -> Flow {
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
            self.stop_tools(&old);
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
            if allowed.hooks && !self.take_hooks(conn, gen) {
                return Flow::Close;
            }
            // Tool streams go to an attach that carries live output only: one
            // that replays a program that has exited takes none, and ends any
            // this connection took before, as no forwarder is left to end them.
            if allowed.mcp && forwarding.is_some() {
                self.take_tools(conn, gen);
            } else {
                self.stop_tools(conn);
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
            // next attach. The tool streams end with it.
            serve.stop_hooks(&conn);
            serve.stop_tools(&conn);
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
            // the closure): the app is told and attaches again. No hook
            // event follows that last word.
            let mut live = lock(&conn.live);
            *live = 0;
            self.stop_hooks(conn);
            self.stop_tools(conn);
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
        {
            // The streams it carried as the attached connection end with it,
            // and its own stream as a relay (whether or not it said
            // `mcp.close`: a CLI's end does not always end its tool server's
            // input).
            let _gate = lock(&conn.live);
            self.stop_tools(conn);
        }
        self.relay_ends(conn, None);
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
        tools: Mutex::new(Tools { to: None, open: Vec::new(), last: 0 }),
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

    fn acked_away(text: &str) -> Result<(Allowed, bool), &'static str> {
        check_ack(&json::parse(text.as_bytes()).unwrap()).map_err(|r| r.code)
    }

    fn acked(text: &str) -> Result<Allowed, &'static str> {
        acked_away(text).map(|(a, _)| a)
    }

    fn ack(text: &str) -> Result<bool, &'static str> {
        acked(text).map(|a| a.local)
    }

    #[test]
    fn hooks_is_offered_and_an_ack_of_it_allows_hook_events() {
        assert_eq!(HOLDER_CAPS, ["core", "local", "hooks", "mcp", "away", "screen"]);
        let both = Allowed { local: true, hooks: true, mcp: false, screen: false };
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"hooks\"]}"), Ok(both));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"hooks\"]}"), Ok(Allowed { local: false, hooks: true, mcp: false, screen: false }));
        // The app's own ack: no hook event will ever be sent to it.
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\"]}"), Ok(Allowed { local: true, hooks: false, mcp: false, screen: false }));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"hooks\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"hooks\",\"hooks\"]}"), Err(request::CODE_BAD_FIELD));
    }

    #[test]
    fn mcp_is_offered_and_an_ack_of_it_allows_tool_streams() {
        // The relay's ack, and everything a holder offers.
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"mcp\"]}"), Ok(Allowed { local: true, hooks: false, mcp: true, screen: false }));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"mcp\",\"hooks\",\"local\",\"core\"]}"), Ok(Allowed { local: true, hooks: true, mcp: true, screen: false }));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"mcp\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"mcp\",\"mcp\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(MAX_TOOL_STREAMS, 8);
    }

    #[test]
    fn away_is_offered_and_counts_only_beside_mcp() {
        let relay = Allowed { local: true, hooks: false, mcp: true, screen: false };
        // A relay of now; one from before `away`, served as before.
        assert_eq!(acked_away("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"mcp\",\"away\"]}"), Ok((relay, true)));
        assert_eq!(acked_away("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"mcp\"]}"), Ok((relay, false)));
        // Without `mcp` it keeps nothing, as no stream can be opened.
        assert_eq!(acked_away("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"away\"]}"), Ok((Allowed { local: true, hooks: false, mcp: false, screen: false }, false)));
        // Everything a holder offered before screen reads.
        assert_eq!(acked_away("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"away\",\"mcp\",\"hooks\",\"local\",\"core\"]}"), Ok((Allowed { local: true, hooks: true, mcp: true, screen: false }, true)));
        assert_eq!(acked_away("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"mcp\",\"away\",\"away\"]}"), Err(request::CODE_BAD_FIELD));
    }

    #[test]
    fn screen_is_offered_last_and_an_ack_of_it_allows_screen_reads_only() {
        assert_eq!(HOLDER_CAPS.last(), Some(&SCREEN_CAP));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"screen\"]}"), Ok(Allowed { local: false, hooks: false, mcp: false, screen: true }));
        // Everything a holder offers.
        assert_eq!(
            acked_away("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"hooks\",\"mcp\",\"away\",\"screen\"]}"),
            Ok((Allowed { local: true, hooks: true, mcp: true, screen: true }, true))
        );
        // The app's own ack of now, and the relay's, allow no screen read.
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"hooks\"]}").map(|a| a.screen), Ok(false));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"mcp\",\"away\"]}").map(|a| a.screen), Ok(false));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"screen\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"screen\",\"screen\"]}"), Err(request::CODE_BAD_FIELD));
        assert!(!crate::relay::ACK_CAPS.contains(&SCREEN_CAP) && !crate::hook::ACK_CAPS.contains(&SCREEN_CAP));
    }

    /// A screen of `cols` by `rows` full of `ch` (a wide one fills each row
    /// with half as many), every cell of it dim and inverse.
    fn a_full_screen(cols: u16, rows: u16, ch: char) -> screen::Read {
        let mut s = screen::Screen::new(crate::pty::PtySize { cols, rows });
        let per_row = if unicode_wide(ch) { usize::from(cols) / 2 } else { usize::from(cols) };
        let mut out = String::from("\x1b[2;7m");
        for r in 0..rows {
            out.push_str(&format!("\x1b[{};1H", r + 1));
            out.extend(std::iter::repeat(ch).take(per_row));
        }
        s.feed(out.as_bytes());
        s.read()
    }

    fn unicode_wide(ch: char) -> bool {
        let mut s = screen::Screen::new(crate::pty::PtySize { cols: 4, rows: 1 });
        s.feed(ch.to_string().as_bytes());
        s.read().lines[0].end == 2
    }

    #[test]
    fn a_screen_answer_is_one_message_to_the_app_and_says_when_rows_were_left_out() {
        // A common size: whole.
        let r = a_full_screen(120, 40, 'x');
        let v = screen_rows_message(2, &r);
        assert_eq!(v.get("cut"), Some(&Value::Bool(false)));
        assert_eq!(v.get("lines").and_then(Value::as_array).map(Vec::len), Some(40));
        // The largest screen, every cell a two-byte character: too much for
        // one message, so the bottom rows that fit, and `cut`.
        let r = a_full_screen(1000, 1000, '\u{e9}');
        let v = screen_rows_message(request::MAX_SAFE_INTEGER - 1, &r);
        let text = v.to_json();
        assert!(text.len() <= SCREEN_ANSWER_MAX, "{} bytes", text.len());
        assert!(frame::encode(&Frame::json(0, v.clone()), Direction::HelperToApp).is_ok());
        assert_eq!(v.get("cut"), Some(&Value::Bool(true)));
        let lines = v.get("lines").and_then(Value::as_array).expect("lines");
        assert!(!lines.is_empty() && lines.len() < 1000, "{} rows", lines.len());
        // The rows kept are the last ones, in order.
        assert_eq!(lines.last(), Some(&row_value(&r.lines[999])));
        assert_eq!(lines.first(), Some(&row_value(&r.lines[1000 - lines.len()])));
        // A tail of 200 lines too long for one message, the same way: a
        // cell can hold a character and its combining marks.
        let tail: Vec<screen::TailLine> = (0..200).map(|_| screen::TailLine { text: "\u{e9}".repeat(3000), typed: "\u{e9}".repeat(3000) }).collect();
        let v = screen_lines_message(2, &tail);
        assert!(v.to_json().len() <= SCREEN_ANSWER_MAX);
        assert_eq!(v.get("cut"), Some(&Value::Bool(true)));
        let v = screen_lines_message(2, &tail[..10]);
        assert_eq!((v.get("cut"), v.get("lines").and_then(Value::as_array).map(Vec::len)), (Some(&Value::Bool(false)), Some(10)));
    }

    #[test]
    fn tool_messages_are_the_documented_bytes_and_the_largest_fits_its_frame() {
        assert_eq!(mcp_open(1).to_json(), "{\"t\":\"mcp.open\",\"stream\":1}");
        assert_eq!(mcp_close(9).to_json(), "{\"t\":\"mcp.close\",\"stream\":9}");
        assert_eq!(mcp_away(1).to_json(), "{\"t\":\"mcp.away\",\"stream\":1}");
        assert_eq!(mcp_back(request::MAX_SAFE_INTEGER).to_json(), "{\"t\":\"mcp.back\",\"stream\":9007199254740991}");
        let message = json::parse(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}").unwrap();
        assert_eq!(mcp_message(3, message).to_json(), "{\"t\":\"mcp\",\"stream\":3,\"message\":{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}}");
        // The most each way may carry, on the longest stream number: it fits
        // the frame its way holds, and the wrapper is within the 256 bytes.
        let of_size = |bytes: usize| json::parse(format!("[\"{}\"]", "x".repeat(bytes - 4)).as_bytes()).unwrap();
        for (most, flow, limit) in [(MAX_MCP_TO_APP, Direction::HelperToApp, frame::MAX_JSON_HELPER_TO_APP), (request::MAX_MCP_TO_HELPER, Direction::AppToHelper, frame::MAX_JSON_APP_TO_HELPER)] {
            let wrapped = mcp_message(request::MAX_SAFE_INTEGER, of_size(most));
            let text = wrapped.to_json();
            assert!(text.len() <= limit && text.len() - most <= 48, "{} bytes around {most}", text.len() - most);
            assert!(frame::encode(&Frame::json(0, wrapped), flow).is_ok(), "{most} does not fit {flow:?}");
        }
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
    fn the_largest_event_fits_a_frame_once_launched_and_one_byte_more_is_too_large() {
        let kind = *request::HOOK_KINDS.iter().max_by_key(|k| k.len()).expect("a kind");
        let head = format!("{{\"hook_event_name\":\"{kind}\",\"prompt\":\"");
        let payload_of = |bytes: usize| format!("{head}{}\"}}", "x".repeat(bytes - head.len() - 2));
        // The most a hook.event may carry, sent on with the longest seq and
        // lost there are.
        let most = payload_of(request::MAX_HOOK_PAYLOAD);
        assert_eq!(most.len(), request::MAX_HOOK_PAYLOAD);
        let ev = HookEvent { seq: u64::MAX, kind: kind.to_string(), payload: json::parse(most.as_bytes()).unwrap(), bytes: most.len() };
        let event = event_message(&ev, u64::MAX).to_json();
        assert!(event.len() <= MAX_JSON_AFTER_LAUNCH, "the largest event is {} bytes", event.len());
        // One byte more of payload is `too-large`, not a frame over the
        // limit: the hook.event carrying it, with the longest id, still fits.
        let over = payload_of(request::MAX_HOOK_PAYLOAD + 1);
        let id = request::MAX_SAFE_INTEGER - 1;
        let message = format!("{{\"t\":\"hook.event\",\"id\":{id},\"kind\":\"{kind}\",\"payload\":{over}}}");
        assert!(message.len() <= MAX_JSON_AFTER_LAUNCH, "a hook.event one byte over is {} bytes", message.len());
        let refused = request::parse_allowed(&json::parse(message.as_bytes()).unwrap(), Allowed { local: true, hooks: true, mcp: false, screen: false }).unwrap_err();
        assert_eq!(refused.code, request::CODE_TOO_LARGE);
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
