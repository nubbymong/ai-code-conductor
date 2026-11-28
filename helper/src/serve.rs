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
//! detach or dropped connection. A holder that runs until it is ended
//! (`hold --until-ended`, from 2.1.3-beta.19, `store::Lifetime`) has no away
//! clock: with nobody attached it ends once its program has exited; until an
//! app has attached for the first time, no sooner than the default 120 s
//! after its start, and one never launched ends at that time too
//! (`due_to_end`). Every clock is monotonic (`Instant`), never the wall
//! clock. Ending ends the whole process tree.
//!
//! The endpoint (macOS and Linux): the holder marks its socket and folder as
//! used every `TOUCH_EVERY`, so a cleaner of old files in /tmp passes them
//! by, and if one is taken all the same (a sweep, a removal by hand) it binds
//! the same endpoint again on the clock's next tick, making the run folder
//! again with its checks (`transport::prepare_run_dir`), and writes its record
//! back if list mode removed it meanwhile (`keep_endpoint`). One it cannot bind
//! (a file that is not its own in the way, a run folder of another user) is
//! tried again on each tick; meanwhile a client's connect says why it cannot
//! reach the holder (`transport::connect`).
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
//! answer says so (`cut`). The holder decides nothing from a screen. A
//! connection that acked `title` beside `screen` (from 2.1.3-beta.14) gets the
//! screen's title in `screen.rows` too; any other gets `screen.rows` as before.
//!
//! Hook kinds (from 2.1.3-beta.18): a `term.launch` may declare the hook kinds
//! its session takes (`hookKinds`); a `hook.event` of any other kind is then
//! `bad-field`. A launch that declares none, and a holder not yet launched,
//! take the nine the app injects into a Claude Code session, as before.
//!
//! The status line (capability `status`, from 2.1.3-beta.18): any connection
//! that acked `status` may post the session's status (`status.set`, answered
//! `status.taken`). The holder keeps the newest only, in one slot, numbered
//! with the session's next status `seq` (from 1, apart from the hook events'
//! own), and sends it as `status` to each connection that acked `status`
//! beside `local` (an app's connection): the newest it holds once, right
//! after that connection's ack, then each newer one, in rounds at most
//! `STATUS_EVERY` apart (10 a second for the session), the newest winning
//! over any posted between two rounds. A connection that acked `status`
//! without `local` (the status mode's) may post and is sent none. A
//! connection is sent a `seq` once, and never an older one after a newer.
//! A status is only numbered and passed on: nothing is run, opened or
//! written for it. No status follows a connection's last word, as no hook
//! event does.
//!
//! The session's pictures (capability `paste`, from 2.1.3-beta.21; ADR-032):
//! the connection attached to the terminal, when it acked `paste`, may send
//! one picture at a time for the session (`file.put`, then the bytes as raw
//! frames on the paste channel), into the session's own picture folder
//! (`paste.rs`), answered `file.stored` with the hash. The upload is that
//! connection's own: it ends, its partial file removed, when the connection
//! closes, detaches or is replaced, and when no chunk comes in time
//! (`paste::CHUNK_WAIT`, answered `timeout`). A read of the next frame waits
//! only until that time for a frame to begin; one that passes before a byte
//! of a frame came ends the upload and the connection goes on, its 60 s with
//! no frame (`IDLE_TIMEOUT`) running on from the last frame, not anew. A
//! frame that began in time is read whole under the ordinary 60 s from its
//! first byte, and an upload overdue by then ends the same way at the next
//! read, the connection still up. The folder goes at the session's end. The
//! holder never reads a picture and decides nothing from one.
//!
//! Locks: a connection's stream gate (`Conn::live`) first (the attached
//! connection's before a relay's, which guards that relay's tool messages),
//! then the hook events (`Serve::hooks`), then the tool streams
//! (`Serve::tools`), then the status slot (`Serve::status`), then the record,
//! then the serve state, then the holder's own, its screen's last (never the
//! other way), and nothing is written to a connection while the status slot,
//! the record, the serve state or the screen is held. Hook events are written to a
//! connection under its gate and the hook lock, so they go out in `seq` order
//! and never inside an attach's reply and replay or after its last word; the
//! hook lock is held for at most `WRITE_TIMEOUT` of writing at a time. A tool
//! message is written under the gate of the connection it goes to, and only
//! while its stream is with that connection, which a stream joins and leaves
//! under; so no tool message follows the last word either. A status is
//! written under the gate of the connection it goes to, after the slot has
//! marked it sent to that connection and been let go.

use crate::frame::{self, Body, Direction, Frame, FrameError};
use crate::hello::{self, Hello, PROTO_VERSIONS};
use crate::holder::{lock, HookEvent, HookQueue, Holder};
use crate::json::Value;
use crate::paste::{self, Upload};
use crate::pty::SpawnOptions;
use crate::request::{self, Allowed, Launch, Refusal, Request, MAX_MCP_TO_APP};
use crate::ring::RingError;
use crate::screen;
use crate::store::{self, Lifetime, Record};
use crate::transport::{self, Listener, Stream};
use std::collections::VecDeque;
use std::io::{self, Read};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
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
/// The capability that adds the screen's title to `screen.rows` (from
/// 2.1.3-beta.14). It counts only beside `screen`.
pub const TITLE_CAP: &str = "title";
/// The capability that allows the status line (from 2.1.3-beta.18):
/// `status.set` from the connection, and `status` to it when it acked
/// `local` too. A holder that offers it also takes `hookKinds` in a launch.
pub const STATUS_CAP: &str = "status";
/// The capability that allows the session's pictures (from 2.1.3-beta.21):
/// `file.put` from the connection attached to the terminal (`paste.rs`).
pub const PASTE_CAP: &str = paste::CAP;
/// What a holder offers in its hello: the frozen core, `local` for the
/// terminal messages, `hooks` for hook events (from 2.1.3-beta.8), `mcp` for
/// tool streams (from 2.1.3-beta.10), `away` for kept tool streams and
/// `screen` for screen reads (both from 2.1.3-beta.12), `title` for the
/// title in a screen read (from 2.1.3-beta.14), and `status` for the status
/// line (from 2.1.3-beta.18). The app acks `core` and
/// `local` (`hello::LOCAL_CAPS`), `hooks` on a connection that takes hook
/// events, `mcp` on one that carries tool streams and `screen` on one that
/// reads the screen (a plain terminal's, from 2.1.3-beta.13; a held Codex
/// session's, from 2.1.3-beta.14), and `title` beside it on the latter. The
/// hook mode acks `hook::ACK_CAPS`, the status mode `status::ACK_CAPS` and
/// the relay `relay::ACK_CAPS`. From 2.1.3-beta.21 it offers `paste` last,
/// for the session's pictures, on every system; the app acks it only on the
/// connection of a helper tab on a remote machine.
pub const HOLDER_CAPS: [&str; 9] = ["core", "local", HOOKS_CAP, MCP_CAP, AWAY_CAP, SCREEN_CAP, TITLE_CAP, STATUS_CAP, PASTE_CAP];
/// The least time between two rounds of `status` (10 a second for the
/// session, protocol section 12); a status posted between two rounds waits
/// for the next, and only the newest goes.
pub const STATUS_EVERY: Duration = Duration::from_millis(100);
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
/// How often the clock thread looks: the away clock (for a holder that runs
/// until it is ended, its program's exit), the record and, on macOS and
/// Linux, the endpoint.
const TICK: Duration = Duration::from_millis(250);
/// How often the Unix socket and its folder are marked as used, in the build
/// the installer ships: a cleaner of /tmp (systemd-tmpfiles takes entries
/// untouched for 10 days on Debian) never finds them old.
pub const TOUCH_EVERY_RELEASE: Duration = Duration::from_secs(3600);
/// The same in a build with debug assertions, the one `cargo test` runs, so
/// a test can wait one out.
pub const TOUCH_EVERY_TEST: Duration = Duration::from_secs(2);
/// How often the Unix socket and its folder are marked as used in this build.
pub const TOUCH_EVERY: Duration = if cfg!(debug_assertions) { TOUCH_EVERY_TEST } else { TOUCH_EVERY_RELEASE };
/// How long an end waits for a launch in progress to put its holder in place.
const LAUNCH_WAIT: Duration = Duration::from_secs(30);

pub struct Options {
    pub store: PathBuf,
    pub sid: String,
    pub label: String,
    /// The away clock, or none (`hold --until-ended`).
    pub lifetime: Lifetime,
    pub ring_bytes: usize,
}

/// Whether a holder nobody is attached to, and that is not launching, ends
/// now (protocol section 15). `away_for` is how long nobody has been
/// attached, read from the monotonic clock (`Instant`): a board with no
/// clock battery can have a wrong wall time until NTP syncs, and no record's
/// wall time is read here. A clock holder ends once that reaches its away
/// time. An until-ended holder has no away clock: with nobody attached it
/// ends once its program has exited (`exited`); until an app has attached
/// for the first time (`attached_once` false), no sooner than the default
/// 120 s after its start (`store::DEFAULT_AWAY_SECS`), so a program that
/// exits between the launch and the app's first attach is still there to
/// replay and to give its exit code. One never launched (`launched` false)
/// has no program to keep and ends at that time too.
pub fn due_to_end(lifetime: Lifetime, away_for: Option<Duration>, launched: bool, exited: bool, attached_once: bool) -> bool {
    let after = |secs: u64| away_for.map_or(false, |t| t >= Duration::from_secs(secs));
    match lifetime {
        Lifetime::Away(secs) => after(secs),
        Lifetime::UntilEnded if launched => exited && (attached_once || after(store::DEFAULT_AWAY_SECS)),
        Lifetime::UntilEnded => after(store::DEFAULT_AWAY_SECS),
    }
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
    /// Set once its `hello.ack` named `screen` and `title`: its `screen.rows`
    /// carry the screen's title.
    title: AtomicBool,
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

    /// True when this connection's `screen.rows` carry the screen's title.
    fn titled(&self) -> bool {
        self.title.load(Ordering::SeqCst)
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
    /// Whether a connection has ever attached to the terminal (`due_to_end`).
    attached_once: bool,
    /// Set once, by the thread that ends the session.
    ending: bool,
    /// `term.end` requests that came while another thread was ending the
    /// session: that thread answers each.
    enders: Vec<(Arc<Conn>, u64)>,
    /// The program's exit code (if it has one), once the session has ended.
    ended: Option<Option<i32>>,
    /// The hook kinds the session takes, as its launch declared them
    /// (`hookKinds`), from the moment a launch is taken; None: the nine.
    hook_kinds: Option<Vec<String>>,
}

/// A stream read that must finish by `until`: each read waits only for what
/// is left, so a frame sent a byte at a time cannot stretch a limit. With
/// `rest`, the limit is only for a frame to begin: once its first byte has
/// come, it has until at least `rest` after that byte to finish.
struct Deadline<'a> {
    stream: &'a mut Stream,
    until: Instant,
    /// Bytes read so far: while none, the stream is still between frames.
    read: usize,
    /// The least time a frame has from its first byte, used once.
    rest: Option<Duration>,
}

impl<'a> Deadline<'a> {
    /// A read of one frame within `limit`. With `quiet` (a picture's chunk
    /// wait) the limit is for the frame to begin: one whose first byte came
    /// in time is read whole under the ordinary 60 s (`IDLE_TIMEOUT`) from
    /// that byte, so the wait running out never cuts a frame in two.
    fn new(stream: &'a mut Stream, limit: Duration, quiet: bool) -> Deadline<'a> {
        // MUTANT M4 (round 3 F10, the fix taken out): no frame gets its rest.
        let _ = quiet;
        Deadline { stream, until: Instant::now() + limit, read: 0, rest: None }
    }
}

impl Read for Deadline<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = self.until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "the frame did not arrive in time"));
        }
        self.stream.set_read_timeout(Some(left.max(Duration::from_millis(1))))?;
        let n = self.stream.read(buf)?;
        if self.read == 0 && n > 0 {
            if let Some(rest) = self.rest.take() {
                self.until = self.until.max(Instant::now() + rest);
            }
        }
        self.read += n;
        Ok(n)
    }
}

/// What a read of the next frame gave.
enum Next {
    Frame(Frame),
    /// Its time passed before a byte of a frame came: the stream is still
    /// whole between two frames (only a read asked to tell this apart).
    Quiet,
    /// The stream ended or broke a rule, and the connection closes; it was
    /// told why when there is a why.
    Close,
}

/// How long a connection's next read waits for a frame when it has no
/// picture on its way: `IDLE_TIMEOUT`, and, for the read just after a
/// picture's chunk wait ran out (`after_stall`), only what is left of it
/// since the last frame, so a stall never starts the 60 s anew (none left:
/// zero, and the connection closes).
fn idle_limit(after_stall: bool, since_last_frame: Duration) -> Duration {
    if after_stall {
        IDLE_TIMEOUT.saturating_sub(since_last_frame)
    } else {
        IDLE_TIMEOUT
    }
}

/// True for a refusal that counts toward a connection's budget (section
/// 12): `bad-field` and `too-large`.
fn counts_toward_budget(r: &Refusal) -> bool {
    r.code == request::CODE_BAD_FIELD || r.code == request::CODE_TOO_LARGE
}

/// One refusal more in a connection's budget: true once it holds more than
/// `REFUSALS_PER_MINUTE` in the last minute, and the connection closes.
fn over_budget(refusals: &mut VecDeque<Instant>) -> bool {
    let now = Instant::now();
    refusals.push_back(now);
    while refusals.front().map_or(false, |t| now.duration_since(*t) > Duration::from_secs(60)) {
        refusals.pop_front();
    }
    refusals.len() > REFUSALS_PER_MINUTE
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

/// The session's status line: the newest status only (one slot), and the
/// connections that take it.
struct Status {
    /// The newest status, its `seq` and payload; None until the first.
    newest: Option<(u64, Value)>,
    /// The `seq` the last status took: each takes the next, from 1.
    last_seq: u64,
    /// When the last round of `status` began; None before the first.
    last_round: Option<Instant>,
    /// Each connection that acked `status` beside `local` (an app's), and the
    /// newest `seq` it was sent (0: none yet). One that acked `status` alone
    /// (the status mode's) only posts and is never here.
    to: Vec<(Arc<Conn>, u64)>,
}

impl Status {
    /// True when a connection that takes the status lacks the newest.
    fn due(&self) -> bool {
        match &self.newest {
            Some((seq, _)) => self.to.iter().any(|(_, sent)| sent < seq),
            None => false,
        }
    }
}

/// Wait on `wake` with `guard` held, as long as `limit` at most (None: until
/// woken). A wait that returns early is the caller's to look at again.
fn wait_on<'a, T>(wake: &Condvar, guard: MutexGuard<'a, T>, limit: Option<Duration>) -> MutexGuard<'a, T> {
    match limit {
        None => wake.wait(guard).unwrap_or_else(|poisoned| poisoned.into_inner()),
        Some(d) => match wake.wait_timeout(guard, d) {
            Ok((g, _)) => g,
            Err(poisoned) => poisoned.into_inner().0,
        },
    }
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
    /// The socket bound again at the same endpoint once the first one's
    /// file was taken (`keep_endpoint`, macOS and Linux): from then the one the
    /// holder marks as used and removes at its end. Taken alone, never with
    /// another lock held.
    #[cfg(unix)]
    rebound: Mutex<Option<Arc<Listener>>>,
    state: Mutex<State>,
    hooks: Mutex<Hooks>,
    tools: Mutex<Tools>,
    status: Mutex<Status>,
    /// Wakes the status pump (`status_pump`): a new status, or the end.
    status_wake: Condvar,
    record: Mutex<Record>,
    /// `State::ending`, for threads that only look.
    ending: AtomicBool,
    next_id: AtomicU64,
    /// Forwarders of live output still running.
    forwarders: AtomicUsize,
    /// The session's picture folder (`paste::folder_of`), named from the
    /// store's full path at the start; None when it cannot be named.
    paste_dir: Option<PathBuf>,
    /// One picture at a time for the session.
    paste_slot: paste::Slot,
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

/// `status`: the session's status line, to a connection that acked `status`.
pub fn status_message(seq: u64, payload: Value) -> Value {
    Value::obj(vec![("t", Value::str("status")), ("seq", Value::uint(seq)), ("payload", payload)])
}

/// `status.taken`: the reply to `status.set` `re`, with the `seq` it took.
pub fn status_taken(re: u64, seq: u64) -> Value {
    reply("status.taken", re, vec![("seq", Value::uint(seq))])
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
/// one message to the app, which the readers look at first. With `title`
/// (the connection acked it) the screen's title comes too, empty when the
/// output set none; it is counted before the rows, so it is never cut.
pub fn screen_rows_message(re: u64, r: &screen::Read, title: bool) -> Value {
    let message = |lines: Vec<Value>, cut: bool| {
        let mut fields = vec![
            ("cols", Value::uint(u64::from(r.cols))),
            ("rows", Value::uint(u64::from(r.rows))),
            ("cursor", Value::obj(vec![("row", Value::uint(u64::from(r.cursor_row))), ("col", Value::uint(u64::from(r.cursor_col)))])),
            ("modes", modes_value(&r.modes)),
        ];
        if title {
            fields.push(("title", Value::str(&r.title)));
        }
        fields.push(("cut", Value::Bool(cut)));
        fields.push(("lines", Value::Arr(lines)));
        reply("screen.rows", re, fields)
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

/// What an ack asked for besides the types it allows: a stream the
/// connection opens kept while the app is away (`away`, which counts only
/// beside `mcp`), the title in its screen reads (`title`, which counts
/// only beside `screen`), and the session's pictures (`paste`, from
/// 2.1.3-beta.21: `file.put` and its bytes, read in `converse`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Asked {
    away: bool,
    title: bool,
    paste: bool,
}

/// Check the first frame: a `hello.ack` with exactly `t`, `proto` and `caps`,
/// a version this holder speaks, and capabilities it offered, `core` among
/// them. Returns what the ack allowed (`local`, `hooks`, `mcp`, `screen`), and
/// what else it asked for (`Asked`).
fn check_ack(v: &Value) -> Result<(Allowed, Asked), Refusal> {
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
    let allowed = Allowed { local: seen.contains(&"local"), hooks: seen.contains(&HOOKS_CAP), mcp: seen.contains(&MCP_CAP), screen: seen.contains(&SCREEN_CAP), status: seen.contains(&STATUS_CAP) };
    Ok((allowed, Asked { away: allowed.mcp && seen.contains(&AWAY_CAP), title: allowed.screen && seen.contains(&TITLE_CAP), paste: seen.contains(&PASTE_CAP) }))
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

    /// Number a status and keep it as the newest, in place of any older
    /// one; the status pump sends it on. Its `seq`; None while the session
    /// is ending.
    fn post_status(&self, payload: Value) -> Option<u64> {
        let seq = {
            let mut status = lock(&self.status);
            if self.ending.load(Ordering::SeqCst) {
                return None;
            }
            status.last_seq += 1;
            let seq = status.last_seq;
            status.newest = Some((seq, payload));
            seq
        };
        self.status_wake.notify_all();
        Some(seq)
    }

    /// `conn` acked `status` and `local`: it takes the status from now on, and is sent
    /// the newest there is, once, at once (not waiting for a round).
    fn take_status(&self, conn: &Arc<Conn>) {
        let _live = lock(&conn.live);
        let newest = {
            let mut status = lock(&self.status);
            if self.ending.load(Ordering::SeqCst) {
                return;
            }
            let newest = status.newest.clone();
            let sent = newest.as_ref().map_or(0, |(seq, _)| *seq);
            status.to.push((Arc::clone(conn), sent));
            newest
        };
        if let Some((seq, payload)) = newest {
            let _ = conn.send_json(status_message(seq, payload));
        }
    }

    /// `conn` takes no more status. Called beside `stop_hooks`, under
    /// `conn.live`, so no status follows its last word.
    fn stop_status(&self, conn: &Conn) {
        lock(&self.status).to.retain(|(c, _)| c.id != conn.id);
    }

    /// Send `conn` the newest status, if it still takes the status and has
    /// not been sent that one (or a newer one).
    fn send_status(&self, conn: &Arc<Conn>) {
        let _live = lock(&conn.live);
        let message = {
            let mut status = lock(&self.status);
            if self.ending.load(Ordering::SeqCst) {
                return;
            }
            let (seq, payload) = match &status.newest {
                Some((seq, payload)) => (*seq, payload.clone()),
                None => return,
            };
            match status.to.iter_mut().find(|entry| entry.0.id == conn.id) {
                Some((_, sent)) if *sent < seq => {
                    *sent = seq;
                    status_message(seq, payload)
                }
                _ => return,
            }
        };
        let _ = conn.send_json(message);
    }

    /// The status pump, a thread of its own for the holder's life: once a
    /// connection that takes the status lacks the newest, and `STATUS_EVERY`
    /// has passed since the last round began, a round sends the newest to
    /// each such connection. A status posted meanwhile replaces the one
    /// waiting, so the newest wins.
    fn status_pump(self: Arc<Self>) {
        loop {
            let mut status = lock(&self.status);
            loop {
                if self.ending.load(Ordering::SeqCst) {
                    return;
                }
                if !status.due() {
                    status = wait_on(&self.status_wake, status, None);
                    continue;
                }
                let now = Instant::now();
                let next = status.last_round.map(|at| at + STATUS_EVERY);
                match next {
                    Some(next) if next > now => status = wait_on(&self.status_wake, status, Some(next - now)),
                    _ => break,
                }
            }
            status.last_round = Some(Instant::now());
            let to: Vec<Arc<Conn>> = status.to.iter().map(|(c, _)| Arc::clone(c)).collect();
            drop(status);
            for conn in &to {
                self.send_status(conn);
            }
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
        // No status either: a round under way sends nothing once the
        // session is ending, and the pump stops.
        lock(&self.status).to.clear();
        self.status_wake.notify_all();
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
        #[cfg(unix)]
        {
            if let Some(l) = lock(&self.rebound).clone() {
                l.remove();
            }
        }
        // The session's pictures go with it, a partial file among them.
        if let Some(dir) = &self.paste_dir {
            paste::remove_folder(dir);
        }
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
                let launched = st.holder.is_some();
                let exited = st.holder.as_ref().map_or(false, |h| h.exit_code().is_some());
                let away_for = st.away_since.map(|t| t.elapsed());
                st.attached.is_none() && !st.launching && due_to_end(self.opts.lifetime, away_for, launched, exited, st.attached_once) && self.claim_end(&mut st)
            };
            if expired {
                self.carry_out_end(None);
            }
            #[cfg(unix)]
            self.keep_endpoint();
            if last_touch.elapsed() >= TOUCH_EVERY {
                self.touch_endpoint();
                last_touch = Instant::now();
            }
        }
    }

    /// Mark the endpoint as used now (`Listener::touch`): the socket bound
    /// again, if there is one, else the first.
    fn touch_endpoint(&self) {
        #[cfg(unix)]
        {
            if let Some(l) = lock(&self.rebound).clone() {
                l.touch();
                return;
            }
        }
        self.listener.touch();
    }

    /// Keep the endpoint this holder's (macOS and Linux): while its socket
    /// file is the one bound, nothing; once it is gone (a cleaner of /tmp, a
    /// removal by hand, its folder with it), bind the same endpoint again,
    /// the run folder made again with its checks, take its connections on a
    /// thread of its own, and write the record back if list mode removed it
    /// meanwhile. The record names the same endpoint, so the app reaches the
    /// holder as before. A bind that fails (a file that is not this holder's
    /// in the way, a run folder of another user) is tried again on the next
    /// tick.
    #[cfg(unix)]
    fn keep_endpoint(self: &Arc<Self>) {
        let current = lock(&self.rebound).clone();
        let bound = match &current {
            Some(l) => l.still_bound(),
            None => self.listener.still_bound(),
        };
        if bound || self.ending.load(Ordering::SeqCst) {
            return;
        }
        let again = match Listener::bind_at(self.listener.endpoint()) {
            Ok(l) => Arc::new(l),
            Err(_) => return,
        };
        let serve = Arc::clone(self);
        let on = Arc::clone(&again);
        if thread::Builder::new().spawn(move || serve.accept_on(&on)).is_err() {
            // No thread to take its connections: the socket goes with
            // `again`, and the next tick tries again.
            return;
        }
        // The socket it replaces keeps its thread, waiting on a file that
        // is gone; nothing can reach it any more.
        *lock(&self.rebound) = Some(again);
        self.restore_record();
    }

    /// Write the record back if it is gone (list mode removes a record whose
    /// socket it cannot find). Under the record's lock, then the store's (the
    /// order an end takes them in); a record another holder wrote meanwhile
    /// is left alone.
    #[cfg(unix)]
    fn restore_record(&self) {
        let mut rec = lock(&self.record);
        if self.ending.load(Ordering::SeqCst) {
            return;
        }
        let _store = match store::lock(&self.opts.store) {
            Ok(l) => l,
            Err(_) => return,
        };
        if store::read(&self.opts.store, &self.opts.sid).is_none() {
            rec.attached = lock(&self.state).attached.is_some();
            let _ = store::write(&self.opts.store, &rec);
        }
    }

    /// Take the connections that come on `listener`, each on a thread of
    /// its own, for as long as the process runs.
    fn accept_on(self: &Arc<Self>, listener: &Listener) -> ! {
        loop {
            match listener.accept() {
                Ok(stream) => {
                    if self.ending.load(Ordering::SeqCst) {
                        continue;
                    }
                    let s = Arc::clone(self);
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
            title: AtomicBool::new(false),
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
        match self.read_next(conn, reader, limit, waited, max_json, false) {
            Next::Frame(f) => Some(f),
            Next::Quiet | Next::Close => None,
        }
    }

    /// `next_frame`, and with `quiet` a limit that passes before a byte of a
    /// frame came is `Next::Quiet`: nothing is said, and the stream is still
    /// whole. With `quiet` a frame whose first byte came in time is read
    /// whole under the ordinary 60 s from that byte (`Deadline::new`), so the
    /// next read, its limit gone, is `Next::Quiet`. A limit that passes
    /// inside a frame closes the connection, as any other limit does (a frame
    /// cannot be read on from its middle).
    fn read_next(&self, conn: &Conn, reader: &mut Stream, limit: Duration, waited: &str, max_json: usize, quiet: bool) -> Next {
        let mut timed = Deadline::new(reader, limit, quiet);
        let got = frame::read_frame_within(&mut timed, Direction::AppToHelper, max_json);
        match got {
            Ok(Some(f)) => Next::Frame(f),
            Ok(None) => Next::Close,
            Err(FrameError::BadFrame(why)) => {
                let _ = conn.send_error(None, frame::CODE_BAD_FRAME, why);
                Next::Close
            }
            Err(FrameError::Io(e)) if transport::is_timeout(&e) => {
                if quiet && timed.read == 0 {
                    return Next::Quiet;
                }
                let _ = conn.send_error(None, request::CODE_TIMEOUT, waited);
                Next::Close
            }
            Err(FrameError::Io(_)) => Next::Close,
        }
    }

    /// `file.put` from `conn`: before a launch, or while the session is
    /// ending, `not-found`; from a connection not attached to the terminal,
    /// `not-connected`; while another picture is being sent in the session,
    /// `busy`; then the folder and the caps (`paste::Upload::begin`). Every
    /// refusal comes before a byte is taken.
    fn begin_put(&self, conn: &Conn, put: paste::Put) -> Result<Upload, Refusal> {
        let re = Some(put.id);
        let refused = |code: &'static str, text: &str| Refusal { code, re, text: text.to_string() };
        {
            let st = lock(&self.state);
            if st.ending {
                return Err(refused(request::CODE_NOT_FOUND, "the session is ending"));
            }
            if st.holder.is_none() {
                return Err(refused(request::CODE_NOT_FOUND, "nothing has been launched yet"));
            }
            if st.attached.as_ref().map(|a| a.id) != Some(conn.id) {
                return Err(refused(request::CODE_NOT_CONNECTED, "only the connection attached to the terminal sends a picture"));
            }
        }
        let dir = self.paste_dir.as_deref().ok_or_else(|| refused(frame::CODE_IO, "the session's picture folder cannot be named"))?;
        let slot = self.paste_slot.take().ok_or_else(|| refused(request::CODE_BUSY, "a picture is being sent in this session already: one at a time"))?;
        Upload::begin(put, dir, slot)
    }

    /// One chunk of the picture `conn` is sending: raw bytes on the paste
    /// channel. With none being sent, `bad-frame` and a close, as for raw
    /// bytes on any other channel; from a connection no longer attached (a
    /// detach or a replacement meanwhile), the upload ends with nothing kept
    /// and the bytes close it, as raw bytes with no terminal attached do.
    /// After the last byte, the answer: `file.stored`, or the refusal (which
    /// counts toward the connection's budget).
    fn picture_chunk(&self, conn: &Conn, upload: &mut Option<Upload>, bytes: &[u8], refusals: &mut VecDeque<Instant>) -> Flow {
        if upload.is_none() {
            let _ = conn.send_error(None, frame::CODE_BAD_FRAME, "raw bytes on the paste channel with no picture being sent");
            return Flow::Close;
        }
        if !self.is_attached(conn) {
            *upload = None;
            let _ = conn.send_error(None, frame::CODE_BAD_FRAME, "raw bytes on a connection with no terminal attached");
            return Flow::Close;
        }
        let taken = match upload.as_mut() {
            Some(u) => u.take(bytes),
            None => return Flow::Continue,
        };
        let answer = match taken {
            Ok(false) => return Flow::Continue,
            Ok(true) => match upload.take() {
                Some(u) => {
                    let id = u.id;
                    u.finish().map(|sha| paste::stored_message(id, &sha))
                }
                None => return Flow::Continue,
            },
            Err(r) => {
                // The upload is over: its partial file goes with it.
                *upload = None;
                Err(r)
            }
        };
        match answer {
            Ok(stored) => {
                let _ = conn.send_json(stored);
                Flow::Continue
            }
            Err(r) => {
                let _ = conn.refuse(&r);
                if counts_toward_budget(&r) && over_budget(refusals) {
                    Flow::Close
                } else {
                    Flow::Continue
                }
            }
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
        let (allowed, pictures) = match &first.body {
            Body::Json(v) if first.channel == 0 => match check_ack(v) {
                Ok((allowed, asked)) => {
                    conn.away.store(asked.away, Ordering::SeqCst);
                    conn.title.store(asked.title, Ordering::SeqCst);
                    (allowed, asked.paste)
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
        // A connection that acked `status` beside `local` (an app's) takes
        // it from its ack on: the newest there is now, then each newer one.
        // One that acked `status` alone (the status mode's) only posts: it
        // is sent none, so its own post never waits behind a status it has
        // not read yet.
        if allowed.status && allowed.local {
            self.take_status(conn);
        }
        let mut refusals: VecDeque<Instant> = VecDeque::new();
        let mut input = InputGate::default();
        // The picture this connection is sending (`paste`), at most one: it
        // ends, its partial file removed, when this function returns.
        let mut upload: Option<Upload> = None;
        // When the last frame came, and whether a chunk wait has just run
        // out: the read after one waits only what is left of the 60 s with
        // no frame (IDLE_TIMEOUT), not 60 s more.
        let mut last_frame = Instant::now();
        let mut after_stall = false;
        loop {
            let next = match &upload {
                // The next chunk is due: a read waits only until then for a
                // frame to begin.
                Some(u) => {
                    let limit = u.due().saturating_duration_since(Instant::now()).min(IDLE_TIMEOUT);
                    self.read_next(conn, reader, limit, "a chunk of the picture did not arrive in time", self.max_json(allowed.mcp), true)
                }
                None => {
                    let limit = idle_limit(after_stall, last_frame.elapsed());
                    after_stall = false;
                    self.read_next(conn, reader, limit, "no frame from the app in 60 seconds", self.max_json(allowed.mcp), false)
                }
            };
            let f = match next {
                Next::Frame(f) => {
                    last_frame = Instant::now();
                    f
                }
                Next::Quiet => {
                    // No chunk in time: the upload ends, nothing is kept, and
                    // the connection goes on. Its partial file goes first, so
                    // the answer never comes before it is gone.
                    if let Some(u) = upload.take() {
                        let id = u.id;
                        drop(u);
                        let _ = conn.send_error(Some(id), request::CODE_TIMEOUT, "no chunk of the picture came in time: the upload ended and nothing was kept");
                    }
                    after_stall = true;
                    continue;
                }
                Next::Close => return,
            };
            match f.body {
                Body::Raw(bytes) if pictures && f.channel == paste::CHANNEL => {
                    if self.picture_chunk(conn, &mut upload, &bytes, &mut refusals) == Flow::Close {
                        return;
                    }
                }
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
                    // A picture (`paste`): its request is read here, since its
                    // upload is this connection's own. Without `paste` acked
                    // it is a type the connection does not allow, below.
                    if pictures && v.get("t").and_then(Value::as_str) == Some("file.put") {
                        match paste::parse_put(&v).and_then(|put| self.begin_put(conn, put)) {
                            Ok(u) => upload = Some(u),
                            Err(r) => {
                                let _ = conn.refuse(&r);
                                if counts_toward_budget(&r) && over_budget(&mut refusals) {
                                    return;
                                }
                            }
                        }
                        continue;
                    }
                    // A hook event is read against the kinds the session's
                    // launch declared (the nine when it declared none).
                    let declared = if v.get("t").and_then(Value::as_str) == Some("hook.event") { lock(&self.state).hook_kinds.clone() } else { None };
                    match request::parse_in_session(&v, allowed, declared.as_deref()).and_then(|req| self.admit(conn, req)) {
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
                            if over_budget(&mut refusals) {
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
            Request::StatusSet { id, payload, .. } => {
                match self.post_status(payload) {
                    Some(seq) => {
                        let _ = conn.send_json(status_taken(id, seq));
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
                // No live output, no hook event, no tool message and no
                // status after the reply.
                let mut live = lock(&conn.live);
                *live = 0;
                self.stop_hooks(conn);
                self.stop_tools(conn);
                self.stop_status(conn);
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
    /// or not, answered from the holder's screen, with the title for a
    /// connection that acked it. Nothing changes: no offset, no attach, no
    /// size. Before a launch, and while the session is ending, `not-found`; a
    /// screen the holder no longer keeps (its parser failed), `io`.
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
            None => holder.screen_read().map(|r| screen_rows_message(id, &r, conn.titled())),
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
            // From here a hook event is read against what this launch
            // declared, before its program can send one.
            st.hook_kinds = l.hook_kinds.clone();
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
                // Nothing was launched: a later launch may try again, and
                // declare its own kinds.
                {
                    let mut st = lock(&self.state);
                    st.launching = false;
                    st.hook_kinds = None;
                }
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
                            st.attached_once = true;
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
            self.stop_status(&old);
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
            // next attach. The tool streams end with it, and the status.
            serve.stop_hooks(&conn);
            serve.stop_tools(&conn);
            serve.stop_status(&conn);
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
            self.stop_status(conn);
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
            // input). It takes no more status either.
            let _gate = lock(&conn.live);
            self.stop_tools(conn);
            self.stop_status(conn);
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
    if let Lifetime::Away(away) = opts.lifetime {
        if !(1..=store::MAX_AWAY_SECS).contains(&away) {
            return Err(invalid("away must be 1 to 86400 seconds"));
        }
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
        lifetime: opts.lifetime,
        attached: false,
        child: "waiting".to_string(),
        code: None,
    };
    store::write(&opts.store, &record)?;
    drop(store_lock);
    // The session's picture folder, from the store's full path: the holder
    // finds it the same whatever its working folder.
    let paste_dir = std::path::absolute(&opts.store).ok().and_then(|s| paste::folder_of(&s, &opts.sid));
    let serve = Arc::new(Serve {
        opts,
        nonce,
        listener,
        #[cfg(unix)]
        rebound: Mutex::new(None),
        state: Mutex::new(State {
            holder: None,
            launching: false,
            conns: 0,
            attached: None,
            attach_gen: 0,
            away_since: Some(Instant::now()),
            attached_once: false,
            ending: false,
            enders: Vec::new(),
            ended: None,
            hook_kinds: None,
        }),
        hooks: Mutex::new(Hooks { queue: HookQueue::new(), to: None }),
        tools: Mutex::new(Tools { to: None, open: Vec::new(), last: 0 }),
        status: Mutex::new(Status { newest: None, last_seq: 0, last_round: None, to: Vec::new() }),
        status_wake: Condvar::new(),
        record: Mutex::new(record),
        ending: AtomicBool::new(false),
        next_id: AtomicU64::new(1),
        forwarders: AtomicUsize::new(0),
        paste_dir,
        paste_slot: paste::Slot::new(),
    });
    let clock = Arc::clone(&serve);
    if let Err(e) = thread::Builder::new().spawn(move || clock.clock()) {
        // No clock thread (the away clock, the exit, the endpoint), no
        // holder: its record goes, and its endpoint with
        // the listener.
        store::remove(&serve.opts.store, &serve.opts.sid, std::process::id());
        return Err(e);
    }
    let pump = Arc::clone(&serve);
    if let Err(e) = thread::Builder::new().spawn(move || pump.status_pump()) {
        // No status pump, no holder, the same way.
        store::remove(&serve.opts.store, &serve.opts.sid, std::process::id());
        return Err(e);
    }
    serve.accept_on(&serve.listener)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    fn acked_asked(text: &str) -> Result<(Allowed, Asked), &'static str> {
        check_ack(&json::parse(text.as_bytes()).unwrap()).map_err(|r| r.code)
    }

    fn acked_away(text: &str) -> Result<(Allowed, bool), &'static str> {
        acked_asked(text).map(|(a, asked)| (a, asked.away))
    }

    fn acked_title(text: &str) -> Result<(Allowed, bool), &'static str> {
        acked_asked(text).map(|(a, asked)| (a, asked.title))
    }

    fn acked(text: &str) -> Result<Allowed, &'static str> {
        acked_away(text).map(|(a, _)| a)
    }

    fn ack(text: &str) -> Result<bool, &'static str> {
        acked(text).map(|a| a.local)
    }

    #[test]
    fn hooks_is_offered_and_an_ack_of_it_allows_hook_events() {
        assert_eq!(HOLDER_CAPS.to_vec(), vec!["core", "local", "hooks", "mcp", "away", "screen", "title", "status", "paste"]);
        let both = Allowed { local: true, hooks: true, mcp: false, screen: false, status: false };
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"hooks\"]}"), Ok(both));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"hooks\"]}"), Ok(Allowed { local: false, hooks: true, mcp: false, screen: false, status: false }));
        // The app's own ack: no hook event will ever be sent to it.
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\"]}"), Ok(Allowed { local: true, hooks: false, mcp: false, screen: false, status: false }));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"hooks\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"hooks\",\"hooks\"]}"), Err(request::CODE_BAD_FIELD));
    }

    #[test]
    fn mcp_is_offered_and_an_ack_of_it_allows_tool_streams() {
        // The relay's ack, and everything a holder offered before kept streams.
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"mcp\"]}"), Ok(Allowed { local: true, hooks: false, mcp: true, screen: false, status: false }));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"mcp\",\"hooks\",\"local\",\"core\"]}"), Ok(Allowed { local: true, hooks: true, mcp: true, screen: false, status: false }));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"mcp\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"mcp\",\"mcp\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(MAX_TOOL_STREAMS, 8);
    }

    #[test]
    fn away_is_offered_and_counts_only_beside_mcp() {
        let relay = Allowed { local: true, hooks: false, mcp: true, screen: false, status: false };
        // A relay of now; one from before `away`, served as before.
        assert_eq!(acked_away("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"mcp\",\"away\"]}"), Ok((relay, true)));
        assert_eq!(acked_away("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"mcp\"]}"), Ok((relay, false)));
        // Without `mcp` it keeps nothing, as no stream can be opened.
        assert_eq!(acked_away("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"away\"]}"), Ok((Allowed { local: true, hooks: false, mcp: false, screen: false, status: false }, false)));
        // Everything a holder offered before screen reads.
        assert_eq!(acked_away("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"away\",\"mcp\",\"hooks\",\"local\",\"core\"]}"), Ok((Allowed { local: true, hooks: true, mcp: true, screen: false, status: false }, true)));
        assert_eq!(acked_away("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"mcp\",\"away\",\"away\"]}"), Err(request::CODE_BAD_FIELD));
    }

    #[test]
    fn screen_is_offered_and_an_ack_of_it_allows_screen_reads_only() {
        assert_eq!(HOLDER_CAPS[5], SCREEN_CAP);
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"screen\"]}"), Ok(Allowed { local: false, hooks: false, mcp: false, screen: true, status: false }));
        // Everything a holder offered before the title.
        assert_eq!(
            acked_away("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"hooks\",\"mcp\",\"away\",\"screen\"]}"),
            Ok((Allowed { local: true, hooks: true, mcp: true, screen: true, status: false }, true))
        );
        // The app's own ack of now, and the relay's, allow no screen read.
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"hooks\"]}").map(|a| a.screen), Ok(false));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"mcp\",\"away\"]}").map(|a| a.screen), Ok(false));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"screen\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"screen\",\"screen\"]}"), Err(request::CODE_BAD_FIELD));
        assert!(!crate::relay::ACK_CAPS.contains(&SCREEN_CAP) && !crate::hook::ACK_CAPS.contains(&SCREEN_CAP));
    }

    #[test]
    fn title_is_offered_and_counts_only_beside_screen() {
        assert_eq!(HOLDER_CAPS[6], TITLE_CAP);
        let reader = Allowed { local: false, hooks: false, mcp: false, screen: true, status: false };
        // A reader that asked for the title, and one that did not: the same
        // types allowed, the title only for the first.
        assert_eq!(acked_title("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"screen\",\"title\"]}"), Ok((reader, true)));
        assert_eq!(acked_title("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"screen\"]}"), Ok((reader, false)));
        // Everything a holder offered before the status line.
        assert_eq!(
            acked_asked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"hooks\",\"mcp\",\"away\",\"screen\",\"title\"]}"),
            Ok((Allowed { local: true, hooks: true, mcp: true, screen: true, status: false }, Asked { away: true, title: true, paste: false }))
        );
        // Without `screen` the title is not asked for: no read can be made.
        assert_eq!(acked_title("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"title\"]}"), Ok((Allowed { local: true, hooks: false, mcp: false, screen: false, status: false }, false)));
        assert_eq!(acked_title("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"screen\",\"title\",\"title\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(acked_title("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"title\"]}"), Err(request::CODE_BAD_FIELD));
        assert!(!crate::relay::ACK_CAPS.contains(&TITLE_CAP) && !crate::hook::ACK_CAPS.contains(&TITLE_CAP));
    }

    #[test]
    fn status_is_offered_last_and_an_ack_of_it_allows_the_status_line() {
        // Last until 2.1.3-beta.21, which adds `paste` after it.
        assert_eq!(HOLDER_CAPS[7], STATUS_CAP);
        let status_only = Allowed { local: false, hooks: false, mcp: false, screen: false, status: true };
        // The status mode's ack, and the app's for a tab that takes it.
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"status\"]}"), Ok(status_only));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"hooks\",\"mcp\",\"status\"]}"), Ok(Allowed { local: true, hooks: true, mcp: true, screen: false, status: true }));
        // Everything a holder offered before the session's pictures.
        assert_eq!(
            acked_asked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"hooks\",\"mcp\",\"away\",\"screen\",\"title\",\"status\"]}"),
            Ok((Allowed { local: true, hooks: true, mcp: true, screen: true, status: true }, Asked { away: true, title: true, paste: false }))
        );
        // Every ack from before it: no status.
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"hooks\"]}").map(|a| a.status), Ok(false));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"status\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(acked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"status\",\"status\"]}"), Err(request::CODE_BAD_FIELD));
        // The hook mode and the relay never ack it; the status mode acks it
        // and the core only.
        assert!(!crate::relay::ACK_CAPS.contains(&STATUS_CAP) && !crate::hook::ACK_CAPS.contains(&STATUS_CAP));
        assert_eq!(crate::status::ACK_CAPS, ["core", STATUS_CAP]);
        assert_eq!(STATUS_EVERY, Duration::from_millis(100));
    }

    #[test]
    fn paste_is_offered_last_and_an_ack_of_it_asks_for_the_sessions_pictures() {
        assert_eq!(HOLDER_CAPS.last(), Some(&PASTE_CAP));
        assert_eq!(PASTE_CAP, "paste");
        let asked = |text: &str| acked_asked(text).map(|(_, a)| a.paste);
        // A helper tab on a remote machine: everything a holder offers.
        assert_eq!(
            acked_asked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"hooks\",\"mcp\",\"away\",\"screen\",\"title\",\"status\",\"paste\"]}"),
            Ok((Allowed { local: true, hooks: true, mcp: true, screen: true, status: true }, Asked { away: true, title: true, paste: true }))
        );
        assert_eq!(asked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"paste\"]}"), Ok(true));
        // Every ack from before it, and a session on this computer's: none.
        assert_eq!(asked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"local\",\"hooks\",\"mcp\",\"status\"]}"), Ok(false));
        assert_eq!(asked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"paste\"]}"), Err(request::CODE_BAD_FIELD));
        assert_eq!(asked("{\"t\":\"hello.ack\",\"proto\":1,\"caps\":[\"core\",\"paste\",\"paste\"]}"), Err(request::CODE_BAD_FIELD));
        // No helper mode acks it: only the app's connection sends a picture.
        for caps in [&crate::relay::ACK_CAPS[..], &crate::hook::ACK_CAPS[..], &crate::status::ACK_CAPS[..]] {
            assert!(!caps.contains(&PASTE_CAP));
        }
    }

    #[test]
    fn status_messages_are_the_documented_bytes_and_the_largest_fits_a_frame_once_launched() {
        let payload = Value::obj(vec![("model", Value::obj(vec![("id", Value::str("m"))]))]);
        assert_eq!(status_message(3, payload).to_json(), "{\"t\":\"status\",\"seq\":3,\"payload\":{\"model\":{\"id\":\"m\"}}}");
        assert_eq!(status_taken(2, 7).to_json(), "{\"t\":\"status.taken\",\"re\":2,\"seq\":7}");
        // The most a status.set may carry, sent on with the longest seq: within
        // the 52 bytes around it, and the 64 KiB a frame holds once launched.
        let head = "{\"pad\":\"";
        let most = format!("{head}{}\"}}", "x".repeat(request::MAX_STATUS_PAYLOAD - head.len() - 2));
        assert_eq!(most.len(), request::MAX_STATUS_PAYLOAD);
        let message = status_message(u64::MAX, crate::json::parse(most.as_bytes()).unwrap()).to_json();
        assert_eq!(message.len() - most.len(), 52, "{}", &message[..60]);
        assert!(message.len() <= MAX_JSON_AFTER_LAUNCH);
    }

    #[test]
    fn a_round_is_not_due_while_nothing_is_posted_or_no_connection_takes_the_status() {
        let mut s = Status { newest: None, last_seq: 0, last_round: None, to: Vec::new() };
        assert!(!s.due(), "nothing posted, nobody taking it");
        s.newest = Some((1, Value::obj(Vec::new())));
        assert!(!s.due(), "posted, nobody taking it: it is kept, not sent");
    }

    #[test]
    fn the_title_comes_in_screen_rows_only_when_asked_and_is_never_cut() {
        let mut s = screen::Screen::new(crate::pty::PtySize { cols: 4, rows: 1 });
        s.feed(b"\x1b]0;a \"t\"\x07ab");
        let r = s.read();
        let without = screen_rows_message(2, &r, false);
        assert!(without.get("title").is_none(), "{}", without.to_json());
        assert_eq!(without.keys().map(|k| k.len()), Some(8), "{}", without.to_json());
        let with = screen_rows_message(2, &r, true);
        assert_eq!(
            with.to_json(),
            "{\"t\":\"screen.rows\",\"re\":2,\"cols\":4,\"rows\":1,\"cursor\":{\"row\":0,\"col\":2},\"modes\":{\"screen\":\"normal\",\"bracketed_paste\":false,\"application_cursor\":false,\"application_keypad\":false,\"mouse\":\"none\",\"mouse_encoding\":\"default\",\"cursor_hidden\":false},\"title\":\"a \\\"t\\\"\",\"cut\":false,\"lines\":[{\"text\":\"ab\",\"typed\":\"ab\",\"inverse\":\"\",\"width\":4,\"end\":2}]}"
        );
        // No title set: an empty one, still there.
        let blank = screen::Screen::new(crate::pty::PtySize { cols: 4, rows: 1 }).read();
        assert_eq!(screen_rows_message(4, &blank, true).get("title"), Some(&Value::str("")));
        // The largest screen with the longest title: the title whole, the
        // rows cut to what is left of one message.
        let mut r = a_full_screen(1000, 1000, '\u{e9}');
        r.title = "\u{e9}".repeat(screen::TITLE_MAX);
        let v = screen_rows_message(6, &r, true);
        assert!(v.to_json().len() <= SCREEN_ANSWER_MAX, "{} bytes", v.to_json().len());
        assert_eq!(v.get("title").and_then(Value::as_str), Some(r.title.as_str()));
        assert_eq!(v.get("cut"), Some(&Value::Bool(true)));
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
        let v = screen_rows_message(2, &r, false);
        assert_eq!(v.get("cut"), Some(&Value::Bool(false)));
        assert_eq!(v.get("lines").and_then(Value::as_array).map(Vec::len), Some(40));
        // The largest screen, every cell a two-byte character: too much for
        // one message, so the bottom rows that fit, and `cut`.
        let r = a_full_screen(1000, 1000, '\u{e9}');
        let v = screen_rows_message(request::MAX_SAFE_INTEGER - 1, &r, false);
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
        // The longest of the nine, and the longest kind a launch may declare.
        let nine = *request::HOOK_KINDS.iter().max_by_key(|k| k.len()).expect("a kind");
        let declared_kind = "K".repeat(request::MAX_HOOK_KIND_CHARS);
        let declared = vec![declared_kind.clone()];
        for (kind, kinds, around) in [(nine, None, 105), (declared_kind.as_str(), Some(declared.as_slice()), 153)] {
            let head = format!("{{\"hook_event_name\":\"{kind}\",\"prompt\":\"");
            let payload_of = |bytes: usize| format!("{head}{}\"}}", "x".repeat(bytes - head.len() - 2));
            // The most a hook.event may carry, sent on with the longest seq
            // and lost there are.
            let most = payload_of(request::MAX_HOOK_PAYLOAD);
            assert_eq!(most.len(), request::MAX_HOOK_PAYLOAD);
            let ev = HookEvent { seq: u64::MAX, kind: kind.to_string(), payload: json::parse(most.as_bytes()).unwrap(), bytes: most.len() };
            let event = event_message(&ev, u64::MAX).to_json();
            assert_eq!(event.len() - most.len(), around, "{kind}: the bytes around the payload");
            assert!(event.len() <= MAX_JSON_AFTER_LAUNCH, "{kind}: the largest event is {} bytes", event.len());
            // One byte more of payload is `too-large`, not a frame over the
            // limit: the hook.event carrying it, with the longest id, still fits.
            let over = payload_of(request::MAX_HOOK_PAYLOAD + 1);
            let id = request::MAX_SAFE_INTEGER - 1;
            let message = format!("{{\"t\":\"hook.event\",\"id\":{id},\"kind\":\"{kind}\",\"payload\":{over}}}");
            assert!(message.len() <= MAX_JSON_AFTER_LAUNCH, "{kind}: a hook.event one byte over is {} bytes", message.len());
            let hooks = Allowed { local: true, hooks: true, mcp: false, screen: false, status: false };
            let refused = request::parse_in_session(&json::parse(message.as_bytes()).unwrap(), hooks, kinds).unwrap_err();
            assert_eq!(refused.code, request::CODE_TOO_LARGE, "{kind}");
        }
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

    #[test]
    fn after_a_stalled_picture_the_idle_wait_runs_on_from_the_last_frame() {
        // 30 s since the last frame when the chunk wait ran out: 30 s are
        // left of the 60, not 60 more.
        assert_eq!(idle_limit(true, Duration::from_secs(30)), Duration::from_secs(30));
        assert_eq!(idle_limit(true, Duration::from_millis(59_500)), Duration::from_millis(500));
        // None left: zero, and the read closes the connection at once.
        assert_eq!(idle_limit(true, Duration::from_secs(60)), Duration::ZERO);
        assert_eq!(idle_limit(true, Duration::from_secs(61)), Duration::ZERO);
        // Every other read waits the whole 60 s, however long ago the last frame came.
        assert_eq!(idle_limit(false, Duration::from_secs(30)), IDLE_TIMEOUT);
        assert_eq!(idle_limit(false, Duration::from_secs(61)), IDLE_TIMEOUT);
    }

    /// A read with `quiet` (a picture's chunk wait) whose frame began within
    /// its limit reads that frame whole, though the rest came after the
    /// limit; any other read keeps its limit for the whole frame, so a frame
    /// sent slowly never stretches it. Over this OS's own transport.
    #[test]
    fn a_frame_begun_within_a_pictures_chunk_wait_is_read_whole_and_any_other_read_keeps_its_limit() {
        let sent = Frame::raw(TERMINAL_CHANNEL, vec![b'x'; 1000]);
        let whole = frame::encode(&sent, Direction::AppToHelper).expect("encode");
        for (quiet, sid) in [(true, "serve-deadline-01"), (false, "serve-deadline-02")] {
            let listener = Arc::new(Listener::bind(sid).expect("listen"));
            let server = Arc::clone(&listener);
            let bytes = whole.clone();
            let (go, start) = std::sync::mpsc::channel::<()>();
            // The header at once, the rest 2 s later: after the 800 ms limit.
            let sender = thread::spawn(move || {
                let mut s = server.accept().expect("accept");
                start.recv().expect("the reader is ready");
                s.write_all_within(&bytes[..9], Duration::from_secs(5)).expect("send the header");
                thread::sleep(Duration::from_secs(2));
                let _ = s.write_all_within(&bytes[9..], Duration::from_secs(5));
                s
            });
            let mut stream = transport::connect(listener.endpoint(), Duration::from_secs(10)).expect("connect");
            let mut timed = Deadline::new(&mut stream, Duration::from_millis(800), quiet);
            go.send(()).expect("start the sender");
            let got = frame::read_frame_within(&mut timed, Direction::AppToHelper, frame::MAX_RAW);
            let read = timed.read;
            let _kept = sender.join().expect("the sender");
            if quiet {
                match got {
                    Ok(Some(f)) => assert_eq!(f, sent),
                    other => panic!("a frame begun within the chunk wait was cut off when the wait ran out ({read} bytes read): {other:?}"),
                }
            } else {
                match got {
                    Err(FrameError::Io(e)) if transport::is_timeout(&e) => assert_eq!(read, 9, "the read stopped elsewhere than after the header"),
                    other => panic!("a read without quiet waited past its limit for the rest of a frame: {other:?}"),
                }
            }
        }
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
            lifetime: Lifetime::Away(120),
            attached: false,
            child: child.to_string(),
            code,
        }
    }

    /// The clock's decision (`due_to_end`): a clock holder ends at its away
    /// time and not before; an until-ended holder never ends by time once
    /// launched, however long nobody is attached (30 days here), and ends
    /// once its program has exited; until an app has attached for the first
    /// time, no sooner than the default clock's time after its start; never
    /// launched, at the default clock's time. Monotonic durations only.
    #[test]
    fn an_until_ended_holder_ends_with_its_program_and_never_by_time() {
        let secs = Duration::from_secs;
        let month = Some(secs(30 * 24 * 3600));
        // A clock holder.
        assert!(!due_to_end(Lifetime::Away(3), None, true, false, true), "attached a moment ago");
        assert!(!due_to_end(Lifetime::Away(3), Some(secs(2)), true, false, true));
        assert!(due_to_end(Lifetime::Away(3), Some(secs(3)), true, false, true));
        assert!(due_to_end(Lifetime::Away(3), Some(secs(3)), false, false, false), "a clock holder never launched");
        assert!(!due_to_end(Lifetime::Away(120), Some(secs(5)), true, true, true), "a clock holder waits for the app after its program exits");
        // An until-ended holder, launched and attached since: never by time,
        // at once after its program.
        assert!(!due_to_end(Lifetime::UntilEnded, month, true, false, true), "an until-ended holder ran out like a clock holder");
        assert!(!due_to_end(Lifetime::UntilEnded, Some(secs(store::MAX_AWAY_SECS + 1)), true, false, true));
        assert!(due_to_end(Lifetime::UntilEnded, Some(Duration::ZERO), true, true, true), "an until-ended holder outlived its program");
        assert!(due_to_end(Lifetime::UntilEnded, month, true, true, true));
        // Launched, its program exited, and no app has attached yet: it waits
        // for the app's first attach, up to the default clock's time.
        assert!(!due_to_end(Lifetime::UntilEnded, Some(secs(1)), true, true, false), "the holder ended before the app's first attach");
        assert!(due_to_end(Lifetime::UntilEnded, Some(secs(store::DEFAULT_AWAY_SECS)), true, true, false));
        // Not launched yet: the default clock.
        assert!(!due_to_end(Lifetime::UntilEnded, Some(secs(store::DEFAULT_AWAY_SECS - 1)), false, false, false));
        assert!(due_to_end(Lifetime::UntilEnded, Some(secs(store::DEFAULT_AWAY_SECS)), false, false, false));
    }

    #[test]
    fn a_test_build_touches_the_endpoint_every_2_s_and_the_shipped_build_every_hour() {
        assert_eq!(TOUCH_EVERY_RELEASE, Duration::from_secs(3600));
        assert_eq!(TOUCH_EVERY_TEST, Duration::from_secs(2));
        assert_eq!(TOUCH_EVERY, TOUCH_EVERY_TEST, "the tests run a build with debug assertions");
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
