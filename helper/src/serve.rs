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
//! Locks: the serve state first, then the holder's own (never the other way),
//! and nothing is written to a connection while the serve state is held.

use crate::frame::{self, Body, Direction, Frame, FrameError};
use crate::hello::{self, Hello, LOCAL_CAPS, PROTO_VERSIONS};
use crate::holder::{lock, Holder};
use crate::json::Value;
use crate::pty::SpawnOptions;
use crate::request::{self, Launch, Refusal, Request};
use crate::ring::RingError;
use crate::store::{self, Record};
use crate::transport::{self, Listener, Stream};
use std::collections::VecDeque;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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
/// How often the away clock and the record are looked at.
const TICK: Duration = Duration::from_millis(250);
/// How often the Unix socket and its folder are marked as used.
const TOUCH_EVERY: Duration = Duration::from_secs(3600);

pub struct Options {
    pub store: PathBuf,
    pub sid: String,
    pub label: String,
    pub away: Duration,
    pub ring_bytes: usize,
}

/// One connection: a writer, and a second handle to shut it down from any
/// thread without waiting for a write in progress.
struct Conn {
    id: u64,
    writer: Mutex<Stream>,
    closer: Stream,
}

impl Conn {
    fn send_bytes(&self, bytes: &[u8]) -> io::Result<()> {
        let mut w = lock(&self.writer);
        let result = w.write_all(bytes).and_then(|_| w.flush());
        if result.is_err() {
            // A write that failed or timed out ends the connection.
            self.closer.shutdown();
        }
        result
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
}

struct Serve {
    opts: Options,
    nonce: String,
    listener: Listener,
    state: Mutex<State>,
    record: Mutex<Record>,
    ending: AtomicBool,
    next_id: AtomicU64,
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

/// Check the first frame: a `hello.ack` with exactly `t`, `proto` and `caps`,
/// a version this holder speaks, and capabilities it offered, `core` among
/// them. Returns whether `local` was acked.
fn check_ack(v: &Value) -> Result<bool, Refusal> {
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
        if !LOCAL_CAPS.contains(&c.as_str()) || seen.contains(&c.as_str()) {
            return bad(request::CODE_BAD_FIELD, "caps holds one this holder did not offer, or one twice");
        }
        seen.push(c.as_str());
    }
    if !seen.contains(&"core") {
        return bad(request::CODE_BAD_FIELD, "caps must hold core");
    }
    Ok(seen.contains(&"local"))
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

    /// Change the record and write it again. A write that fails (a reader
    /// holding the file on Windows) is tried a few more times, then given up:
    /// the record is for list mode, the session does not depend on it.
    fn update_record(&self, change: impl FnOnce(&mut Record)) {
        let mut rec = lock(&self.record);
        change(&mut rec);
        for _ in 0..5 {
            if store::write(&self.opts.store, &rec).is_ok() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// End the session and the process. `requester` gets `term.ended`.
    fn finish(&self, requester: Option<(&Conn, u64)>) -> ! {
        if self.ending.swap(true, Ordering::SeqCst) {
            // Another thread is ending it; it exits the process.
            loop {
                thread::sleep(Duration::from_secs(1));
            }
        }
        let code = self.holder().and_then(|h| h.end());
        if let Some((conn, re)) = requester {
            let more = match code {
                Some(c) => vec![("code", code_value(c))],
                None => vec![],
            };
            let _ = conn.send_json(reply("term.ended", re, more));
            conn.closer.close_after_writes();
        }
        store::remove(&self.opts.store, &self.opts.sid, std::process::id());
        self.listener.remove();
        if let Some((conn, _)) = requester {
            // Exiting closes the connection; the app reads term.ended first.
            conn.closer.wait_peer_close(transport::LINGER);
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
                    self.update_record(|r| {
                        r.child = "exited".to_string();
                        r.code = Some(i64::from(code));
                    });
                    recorded_exit = true;
                }
            }
            let away_for = lock(&self.state).away_since.map(|t| t.elapsed());
            if away_for.map_or(false, |d| d >= self.opts.away) {
                self.finish(None);
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
        let conn = Arc::new(Conn { id, writer: Mutex::new(writer), closer });
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
            caps: &LOCAL_CAPS,
            sid: &self.opts.sid,
            state,
        })
    }

    /// Read a frame; on anything but a frame, say why (when there is a why)
    /// and return None, which closes the connection.
    fn next_frame(&self, conn: &Conn, reader: &mut Stream, waited: &str) -> Option<Frame> {
        match frame::read_frame(reader, Direction::AppToHelper) {
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
        if reader.set_read_timeout(Some(ACK_TIMEOUT)).is_err() {
            return;
        }
        let first = match self.next_frame(conn, reader, "no hello.ack in 10 seconds") {
            Some(f) => f,
            None => return,
        };
        let local = match &first.body {
            Body::Json(v) if first.channel == 0 => match check_ack(v) {
                Ok(local) => local,
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
        if reader.set_read_timeout(Some(IDLE_TIMEOUT)).is_err() {
            return;
        }
        let mut refusals: VecDeque<Instant> = VecDeque::new();
        loop {
            let f = match self.next_frame(conn, reader, "no frame from the app in 60 seconds") {
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
                        let _ = h.write_input(&bytes);
                    }
                }
                Body::Json(v) => {
                    if f.channel != 0 {
                        let _ = conn.send_error(None, frame::CODE_BAD_FRAME, "a control message off channel 0");
                        return;
                    }
                    match request::parse(&v, local) {
                        Ok(req) => {
                            if self.handle(conn, req) == Flow::Close {
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

    fn handle(self: &Arc<Self>, conn: &Arc<Conn>, req: Request) -> Flow {
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
            Request::Attach { id, from } => self.attach(conn, id, from),
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
                self.update_record(|r| r.attached = false);
                let _ = conn.send_json(reply("term.detached", id, vec![]));
                Flow::Close
            }
            Request::End { id } => self.finish(Some((&**conn, id))),
        }
    }

    fn launch(&self, conn: &Conn, l: Launch) {
        {
            let mut st = lock(&self.state);
            if st.holder.is_some() || st.launching {
                drop(st);
                let _ = conn.send_error(Some(l.id), request::CODE_BUSY, "this holder has launched its session already");
                return;
            }
            st.launching = true;
        }
        let opts = SpawnOptions { argv: l.argv.as_slice(), cwd: Some(l.cwd.as_str()), env: Some(l.env.as_slice()), size: l.size };
        match Holder::start_with(&opts, self.opts.ring_bytes) {
            Ok(h) => {
                let pid = h.child_pid();
                {
                    let mut st = lock(&self.state);
                    st.holder = Some(Arc::new(h));
                    st.launching = false;
                }
                self.update_record(|r| r.child = "running".to_string());
                let _ = conn.send_json(reply("term.launched", l.id, vec![("pid", Value::uint(u64::from(pid)))]));
            }
            Err(e) => {
                lock(&self.state).launching = false;
                let _ = conn.send_error(Some(l.id), frame::CODE_IO, &format!("could not start the program: {e}"));
            }
        }
    }

    fn attach(self: &Arc<Self>, conn: &Arc<Conn>, id: u64, from: u64) -> Flow {
        let taken = {
            let mut st = lock(&self.state);
            match st.holder.clone() {
                None => Err((request::CODE_NOT_FOUND, "nothing has been launched yet".to_string())),
                Some(h) => match h.attach(from) {
                    Err(RingError::PastEnd { ring_end }) => Err((request::CODE_BAD_FIELD, format!("from {from} is past the end of the output ({ring_end})"))),
                    Ok(a) => {
                        let old = st.attached.replace(Arc::clone(conn)).filter(|o| o.id != conn.id);
                        st.attach_gen += 1;
                        st.away_since = None;
                        Ok((h, a, old, st.attach_gen))
                    }
                },
            }
        };
        let (holder, attachment, old, gen) = match taken {
            Ok(t) => t,
            Err((code, text)) => {
                let _ = conn.send_error(Some(id), code, &text);
                return Flow::Continue;
            }
        };
        if let Some(old) = old {
            let _ = old.send_error(None, request::CODE_REPLACED, "a newer connection attached to this terminal");
            old.closer.close_after_writes();
        }
        self.update_record(|r| r.attached = true);
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
        if conn.send_json(reply("term.attached", id, more)).is_err() || conn.send_terminal(&attachment.replay.bytes).is_err() {
            return Flow::Close;
        }
        if attachment.exit_code.is_some() {
            // Over before this attach: the reply said so, and nothing follows.
            return Flow::Continue;
        }
        let serve = Arc::clone(self);
        let conn = Arc::clone(conn);
        let live = attachment.live;
        thread::spawn(move || {
            while let Ok(chunk) = live.recv() {
                if conn.send_terminal(&chunk).is_err() {
                    return;
                }
            }
            // The channel closed: detached, replaced, the session over, or
            // this connection fell too far behind.
            if serve.ending.load(Ordering::SeqCst) || !serve.is_current(&conn, gen) {
                return;
            }
            match holder.exit_code() {
                Some(code) => {
                    let _ = conn.send_json(Value::obj(vec![("t", Value::str("term.exit")), ("code", code_value(code))]));
                }
                None => {
                    let _ = conn.send_error(None, request::CODE_BUSY, "this connection fell too far behind; attach again from the last offset it saw");
                    conn.closer.close_after_writes();
                }
            }
        });
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
        if was_attached {
            self.update_record(|r| r.attached = false);
        }
    }
}

/// Run a holder until its session ends. It returns only when it could not
/// start; otherwise the process exits from `finish`.
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
    if let Some(Ok(existing)) = store::read(&opts.store, &opts.sid) {
        if crate::pids::alive(existing.pid) && crate::client::probe(&existing) != store::Probe::Gone {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "a holder for this session is already running"));
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
    let serve = Arc::new(Serve {
        opts,
        nonce,
        listener,
        state: Mutex::new(State { holder: None, launching: false, conns: 0, attached: None, attach_gen: 0, away_since: Some(Instant::now()) }),
        record: Mutex::new(record),
        ending: AtomicBool::new(false),
        next_id: AtomicU64::new(1),
    });
    let clock = Arc::clone(&serve);
    thread::spawn(move || clock.clock());
    loop {
        match serve.listener.accept() {
            Ok(stream) => {
                if serve.ending.load(Ordering::SeqCst) {
                    continue;
                }
                let s = Arc::clone(&serve);
                thread::spawn(move || s.serve_conn(stream));
            }
            // A client that came and went before it was accepted, or a
            // passing failure: wait a moment and listen again.
            Err(_) => thread::sleep(Duration::from_millis(50)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    fn ack(text: &str) -> Result<bool, &'static str> {
        check_ack(&json::parse(text.as_bytes()).unwrap()).map_err(|r| r.code)
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
    }
}
