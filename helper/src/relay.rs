//! `aicc-helper mcp --store <folder> --session <sid>`: a session's tool
//! server as its CLI starts one, relayed through the session's holder to the
//! app (protocol section 15, capability `mcp`, from 2.1.3-beta.10). The app
//! names it as the `conductor` tool server of a held Claude Code session on
//! this computer (hooks/per-session-settings.ts relayConductorEntry) and of a
//! tab through the session helper on another machine (its session's mcp.json,
//! providers/claude/remote-launch.ts claudeRemoteMcp).
//!
//! The CLI starts it as its own child, with pipes for its standard input and
//! output, and speaks MCP to it: one JSON-RPC message a line, each way. The
//! relay reads the session's record with the store's strict reader and
//! connects with the client list mode and the hook mode use (the endpoint's
//! checks, then the hello's nonce and session). A holder whose hello does not
//! offer `mcp` (one from before 2.1.3-beta.10) is sent nothing, not even the
//! ack. Otherwise the relay acks `core`, `local` and `mcp`, and `away` too
//! when the holder offers it (below), opens its one stream (`mcp.open`,
//! number 1) and pings: the holder answers in order, so the `pong` says the
//! open was taken, and only then is standard input read (10 s at most). From
//! then on each line it reads goes to the holder as one `mcp`, and each `mcp`
//! the holder sends on that stream goes to standard output as one line, its
//! message alone, as compact JSON. Whatever method comes is passed on in the
//! order it came, and nothing waits for an `initialize`. It pings the holder
//! when it has sent nothing for 15 s, as the app does, so the connection is
//! not dropped as idle. Standard output is written by a thread of its own, so
//! the end of the stream is seen even while the CLI is not reading: a CLI
//! that falls 64 MiB behind is not taking what it is sent, and once the
//! holder ends the stream or the connection is lost, the lines still waiting
//! have 5 s to go (at the end of its input it exits at once and drops them).
//!
//! A line that is not one JSON object or array (an empty line, text that is
//! not JSON, a value more than 31 levels deep, an escaped lone surrogate), or
//! whose message is over the 1,048,320 bytes the app takes, is dropped and the
//! next line read: nothing reaches the holder, and the CLI's own timeout
//! answers it. A line over 1 MiB is read to its end and dropped the same way.
//!
//! Kept streams (capability `away`, from 2.1.3-beta.12). A holder that offers
//! `away` keeps the relay's stream while no connection takes tool streams
//! (the app is away), and says so: `mcp.away` when it starts keeping it,
//! `mcp.back` when a connection takes it again. A holder that does not offer
//! `away` is acked as before and sent nothing new, and the relay is as it was.
//! With `away` acked, of each message it passes the relay reads two things
//! and no more: whether it is a call (an object with an `id`, a string or a
//! number, and a `method`, a string), and that call's `id` and `method`; and
//! of each message from the app, whether it is an answer (an object with an
//! `id` and no `method`) and to which id. A message still goes on exactly as
//! it came. A call passed to the app and not yet answered is remembered (64
//! at most: past that the oldest is forgotten, and the CLI's own timeout
//! answers it), and the app's answer clears it, as does a cancel
//! (`notifications/cancelled`) the CLI sends for it. On `mcp.away` each call
//! remembered is answered at once with the fixed answer: it reached an app
//! that is gone, and it is never sent a second time, as a tool call may not
//! be safe to repeat (an answer the app sends to one after all is dropped:
//! the CLI has had its answer). From then on a call read from the CLI is
//! held, not sent: 32 calls and 4 MiB at most wait, and one more is answered
//! at once. A held call has 30 s (`HOLD`), then gets the fixed answer and is
//! dropped. Anything else read meanwhile is dropped, but a cancel of a held
//! call drops that call too, with no answer. A batch (an array) is answered
//! at once, call by call, and never held. On `mcp.back` the held calls go to
//! the holder in the order they came, and the relay is as before. An `mcp`
//! the holder refuses `not-connected` once the stream is had (one sent while
//! the holder was keeping the stream) is no end: its call is among those
//! `mcp.away` answers. The fixed answer has ADR-030 D1's words: to a
//! `tools/call`, a result the model reads, one text item with the error mark
//! set; to any other call, a JSON-RPC error. Only a call whose id is a string,
//! or a whole number in plain digits that a JavaScript number holds exactly,
//! is remembered, as only such an id comes back from the app as it went.
//!
//! It exits 0 when its standard input ends, after `mcp.close`. It exits 1 as
//! soon as its stream cannot be had or cannot go on: a command line it does not
//! take, no record or no holder, a holder without `mcp`, no connection that
//! takes tool streams (`not-connected`, for a relay that did not ack `away`,
//! or when the session's program is not running), too many streams (`busy`),
//! no `pong` to the open in time, its stream ended from the other side
//! (`mcp.close` from the holder, once the app let go of a stream that is not
//! kept, or once the program exited), any other `error` but `too-large`, a
//! CLI 64 MiB behind, or the connection lost (the holder's session ended).
//! Standard output carries only the messages: it prints nothing else, nothing
//! on standard error, and writes no file. Its store and session come from its
//! command line alone, never from its environment, which a CLI may pass
//! almost none of.

use crate::client::Client;
use crate::frame::{self, Body, Direction, Frame};
use crate::hello;
use crate::holder::lock;
use crate::hook::parse_args;
use crate::json::{self, Value};
use crate::request::{CODE_NOT_CONNECTED, CODE_TOO_LARGE, MAX_MCP_TO_APP};
use crate::serve::{mcp_close, mcp_message, mcp_open, AWAY_CAP, MCP_CAP};
use crate::store;
use crate::transport::{self, Stream};
use std::collections::VecDeque;
use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// What the relay acks: the frozen core, `local`, `mcp`, and `away` when the
/// holder offers it (from 2.1.3-beta.12). A holder that does not offer `away`
/// is acked the first three, as before.
pub const ACK_CAPS: [&str; 4] = ["core", "local", MCP_CAP, AWAY_CAP];
/// How long it waits to connect, and then for the whole hello line.
pub const CONNECT: Duration = Duration::from_secs(2);
/// A ping this often keeps the holder from dropping the connection as idle
/// (it drops one with no frame in 60 s).
pub const PING_EVERY: Duration = Duration::from_secs(15);
/// The relay's own number for its one stream.
pub const STREAM: u64 = 1;
/// The longest line read as a message: a longer one cannot be one the app
/// takes.
pub const MAX_LINE: usize = frame::MAX_JSON_HELPER_TO_APP;
/// Its standard input ended, and its stream was closed.
pub const EXIT_ENDED: u8 = 0;
/// Its stream could not be had, or could not go on.
pub const EXIT_FAILED: u8 = 1;
/// Messages read and not yet sent, at most: a CLI that writes faster than
/// the holder takes them waits for room.
const WAITING: usize = 16;
/// The id of the ping sent right after `mcp.open`. The holder answers a
/// connection's messages in order, so its `pong` says the open was taken: a
/// refusal of the open comes before it.
const OPEN_PING: u64 = 2;
/// How long the relay waits for that `pong` before it gives up.
pub const OPEN_WAIT: Duration = Duration::from_secs(10);
/// Lines for the CLI not yet written, at most, in bytes: a CLI that falls
/// this far behind is not taking what it is sent, and the relay exits.
pub const OUT_QUEUE_BYTES: usize = 64 * 1024 * 1024;
/// How long the lines still queued for the CLI may take, once the holder has
/// ended the stream or the connection is lost, before the relay exits all
/// the same (at the end of standard input it exits at once).
pub const DRAIN: Duration = transport::WRITE_TIMEOUT;
/// How long a call read while the app is away waits for it, in the build the
/// installer ships (ADR-030 D1: about 30 seconds).
pub const HOLD: Duration = Duration::from_secs(30);
/// The same in a build with debug assertions, the one `cargo test` runs, so
/// a test can wait one out.
pub const TEST_HOLD: Duration = Duration::from_secs(4);
/// How long a held call waits in this build.
pub const HELD_FOR: Duration = if cfg!(debug_assertions) { TEST_HOLD } else { HOLD };
/// Calls held at once, at most: one more is answered at once.
pub const MAX_HELD: usize = 32;
/// The held calls' bytes as compact JSON, at most: a call that would take
/// them past it is answered at once.
pub const MAX_HELD_BYTES: usize = 4 * 1024 * 1024;
/// Calls with the app the relay remembers, at most, and as many it answered
/// in the app's place: past that the oldest is forgotten.
pub const MAX_REMEMBERED: usize = 64;
/// ADR-030 D1's words: the text of every answer the relay gives in the app's
/// place.
pub const UPDATING: &str = "AI Code Conductor is updating, try again shortly";
/// The JSON-RPC error code of that answer to a call that is not a
/// `tools/call`: internal error.
pub const UPDATING_CODE: i64 = -32603;

/// Run the relay on `args` (what follows `mcp`): its exit status. It returns
/// `EXIT_ENDED` at the end of standard input, and `EXIT_FAILED` when its
/// stream cannot be had (a command line it does not take, no record or no
/// holder, no `mcp` offered, no `pong` within `OPEN_WAIT`), a write to the
/// holder fails, standard input cannot be read or the CLI is too far behind;
/// an end the holder brings exits the process from the thread that reads it,
/// with `EXIT_FAILED`.
pub fn run(args: &[String]) -> u8 {
    relay(args).unwrap_or(EXIT_FAILED)
}

/// What the loop that sends to the holder is handed.
enum FromCli {
    /// A message the CLI wrote.
    Message(Value),
    /// The end: `EXIT_ENDED` at the end of the input, `EXIT_FAILED` when it
    /// could not be read.
    End(u8),
    /// From the reader of the holder: `mcp.back` came, and the held calls
    /// are to go.
    Wake,
}

/// One line of standard input, as `next_line` reads it.
#[derive(Debug, PartialEq, Eq)]
enum Line {
    /// The line, without its line end.
    Text(Vec<u8>),
    /// A line over the limit: read to its end, kept not at all.
    TooLong,
    /// The end of the input.
    End,
}

/// A call: its id as the CLI wrote it, and its method.
#[derive(Debug, Clone, PartialEq)]
struct Call {
    id: Value,
    method: String,
}

/// A call held while the app is away: the call, its message, the message's
/// bytes as compact JSON, and when its time is up.
struct HeldCall {
    call: Call,
    message: Value,
    bytes: usize,
    until: Instant,
}

/// What to do with a message read from the CLI, with `away` acked.
#[derive(Debug, PartialEq)]
enum Act {
    /// Send it to the holder.
    Send(Value),
    /// Write this for the CLI, in the app's place.
    Answer(Value),
    /// Nothing more now: it waits, or it is dropped.
    Keep,
}

/// What the relay knows of the calls on its stream, with `away` acked. The
/// reader of the holder and the loop that sends to it share it, under one
/// lock.
#[derive(Default)]
struct Calls {
    /// `mcp.away` came, and the held calls have not gone yet.
    away: bool,
    /// `mcp.back` came while away: the held calls are to go.
    back: bool,
    /// Calls passed to the app and not yet answered, oldest first, each with
    /// the key its id is known by.
    with_app: VecDeque<(String, Call)>,
    /// Keys of the calls the relay answered in the app's place because they
    /// were with it when it went, oldest first.
    answered: VecDeque<String>,
    /// Calls held while away, in the order they came.
    held: VecDeque<HeldCall>,
    /// Their bytes as compact JSON.
    held_bytes: usize,
}

impl Calls {
    /// A message read from the CLI at `now`. As before `away`, it is sent,
    /// a call is remembered, and a cancel forgets the call with the app it
    /// names (the app sends no answer to it); while away, a call waits
    /// (`Keep`) or is answered at once, a batch is answered at once, call by
    /// call, and anything else is dropped, a cancel dropping the held call it
    /// names.
    fn from_cli(&mut self, message: Value, now: Instant) -> Act {
        if !self.away {
            if let Some((key, call)) = tracked_call(&message) {
                self.answered.retain(|k| *k != key);
                push_bounded(&mut self.with_app, (key, call));
            }
            if let Some(id) = cancelled(&message) {
                self.with_app.retain(|(_, c)| c.id.to_json() != id);
            }
            return Act::Send(message);
        }
        if let Value::Arr(items) = &message {
            let answers: Vec<Value> = items.iter().filter_map(call_of).map(|c| updating_answer(&c.id, &c.method)).collect();
            return if answers.is_empty() { Act::Keep } else { Act::Answer(Value::Arr(answers)) };
        }
        if let Some(call) = call_of(&message) {
            let bytes = message.to_json().len();
            if self.held.len() >= MAX_HELD || self.held_bytes + bytes > MAX_HELD_BYTES {
                return Act::Answer(updating_answer(&call.id, &call.method));
            }
            self.held_bytes += bytes;
            self.held.push_back(HeldCall { call, message, bytes, until: now + HELD_FOR });
            return Act::Keep;
        }
        if let Some(id) = cancelled(&message) {
            if let Some(at) = self.held.iter().position(|h| h.call.id.to_json() == id) {
                if let Some(h) = self.held.remove(at) {
                    self.held_bytes -= h.bytes;
                }
            }
        }
        Act::Keep
    }

    /// `mcp.away`: each call with the app is answered now, in the order it
    /// was sent, and calls are held from now on. A `mcp.back` not acted on
    /// yet is undone: the held calls wait on.
    fn away(&mut self) -> Vec<Value> {
        self.away = true;
        self.back = false;
        let mut answers = Vec::new();
        while let Some((key, call)) = self.with_app.pop_front() {
            answers.push(updating_answer(&call.id, &call.method));
            push_bounded(&mut self.answered, key);
        }
        answers
    }

    /// `mcp.back`: the held calls are to go, from the loop that sends to the
    /// holder.
    fn back(&mut self) {
        if self.away {
            self.back = true;
        }
    }

    /// The held calls whose time is up by `now`: each is dropped, and its
    /// answer returned.
    fn expire(&mut self, now: Instant) -> Vec<Value> {
        let mut answers = Vec::new();
        while self.held.front().map_or(false, |h| h.until <= now) {
            if let Some(h) = self.held.pop_front() {
                self.held_bytes -= h.bytes;
                answers.push(updating_answer(&h.call.id, &h.call.method));
            }
        }
        answers
    }

    /// Once `mcp.back` has come: the held calls' messages, in the order they
    /// came, each call now remembered as with the app, and the relay is as
    /// before. Nothing otherwise.
    fn release(&mut self) -> Vec<Value> {
        if !self.back {
            return Vec::new();
        }
        self.back = false;
        self.away = false;
        self.held_bytes = 0;
        let held = std::mem::take(&mut self.held);
        let mut messages = Vec::with_capacity(held.len());
        for h in held {
            if let Some(key) = id_key(&h.call.id) {
                self.answered.retain(|k| *k != key);
                push_bounded(&mut self.with_app, (key, h.call));
            }
            messages.push(h.message);
        }
        messages
    }

    /// A message from the app: true when it goes on to the CLI. An answer to
    /// a call with the app clears that call; one to a call the relay has
    /// answered in the app's place is dropped, once.
    fn from_app(&mut self, message: &Value) -> bool {
        let key = match answer_key(message) {
            Some(k) => k,
            None => return true,
        };
        if let Some(at) = self.with_app.iter().position(|(k, _)| *k == key) {
            self.with_app.remove(at);
            return true;
        }
        match self.answered.iter().position(|k| *k == key) {
            Some(at) => {
                self.answered.remove(at);
                false
            }
            None => true,
        }
    }

    /// When the first held call's time is up.
    fn next_due(&self) -> Option<Instant> {
        self.held.front().map(|h| h.until)
    }
}

/// Add `item` last, forgetting the oldest past `MAX_REMEMBERED`.
fn push_bounded<T>(list: &mut VecDeque<T>, item: T) {
    list.push_back(item);
    while list.len() > MAX_REMEMBERED {
        list.pop_front();
    }
}

/// The call `message` is: an object with an `id`, a string or a number, and
/// a `method`, a string. Of a message the relay reads this and no more.
fn call_of(message: &Value) -> Option<Call> {
    let id = message.get("id")?;
    if !matches!(id, Value::Str(_) | Value::Num(_)) {
        return None;
    }
    let method = message.get("method")?.as_str()?;
    Some(Call { id: id.clone(), method: method.to_string() })
}

/// The call `message` is, when its id is one the relay can know again in the
/// app's answer, with that id's key.
fn tracked_call(message: &Value) -> Option<(String, Call)> {
    let call = call_of(message)?;
    Some((id_key(&call.id)?, call))
}

/// The key an id is known by: a string, as compact JSON, or a whole number
/// in plain digits that a JavaScript number holds exactly (15 digits at
/// most), as the app writes either back. None for any other id.
fn id_key(id: &Value) -> Option<String> {
    match id {
        Value::Str(_) => Some(id.to_json()),
        Value::Num(n) => {
            let digits = n.strip_prefix('-').unwrap_or(n.as_str());
            let plain = (1..=15).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit()) && (digits == "0" || !digits.starts_with('0')) && n.as_str() != "-0";
            plain.then(|| n.clone())
        }
        _ => None,
    }
}

/// The key of the call an answer from the app is to: an object with an `id`
/// and no `method`.
fn answer_key(message: &Value) -> Option<String> {
    if message.get("method").is_some() {
        return None;
    }
    id_key(message.get("id")?)
}

/// The id a cancel names, as compact JSON: a `notifications/cancelled` with
/// no `id`, its `params.requestId`.
fn cancelled(message: &Value) -> Option<String> {
    if message.get("id").is_some() || message.get("method").and_then(Value::as_str) != Some("notifications/cancelled") {
        return None;
    }
    message.get("params")?.get("requestId").map(Value::to_json)
}

/// The answer the relay gives a call in the app's place, with D1's words: to
/// a `tools/call`, a result the model reads, one text item with the error
/// mark set; to any other call, a JSON-RPC error. `id` is the call's, as it
/// came.
pub fn updating_answer(id: &Value, method: &str) -> Value {
    let body = if method == "tools/call" {
        let text = Value::obj(vec![("type", Value::str("text")), ("text", Value::str(UPDATING))]);
        ("result", Value::obj(vec![("content", Value::Arr(vec![text])), ("isError", Value::Bool(true))]))
    } else {
        ("error", Value::obj(vec![("code", Value::Num(UPDATING_CODE.to_string())), ("message", Value::str(UPDATING))]))
    };
    Value::obj(vec![("jsonrpc", Value::str("2.0")), ("id", id.clone()), body])
}

/// The lines waiting for the CLI's standard output, which a thread of its
/// own writes, and how many bytes they hold.
#[derive(Clone)]
struct Out {
    lines: Sender<String>,
    queued: Arc<AtomicUsize>,
}

impl Out {
    /// `message` as one line for the CLI. False once the CLI is more than
    /// `OUT_QUEUE_BYTES` behind, or its standard output is closed.
    fn line(&self, message: &Value) -> bool {
        let mut line = message.to_json();
        line.push('\n');
        let n = line.len();
        self.queued.fetch_add(n, Ordering::SeqCst) + n <= OUT_QUEUE_BYTES && self.lines.send(line).is_ok()
    }

    /// The writer stops once the lines queued before this one are written.
    fn end(&self) {
        let _ = self.lines.send(String::new());
    }
}

/// What the thread that reads the holder needs.
struct Reader {
    /// The calls on the stream, when `away` was acked; None for a holder that
    /// does not offer it, and the relay is as it was before `away`.
    calls: Option<Arc<Mutex<Calls>>>,
    /// The `pong` to the open goes here.
    opened: Sender<()>,
    /// Wakes the loop that sends to the holder, for `mcp.back`.
    wake: SyncSender<FromCli>,
    out: Out,
}

fn relay(args: &[String]) -> Option<u8> {
    let (store_dir, sid) = parse_args(args)?;
    let rec = store::read(&store_dir, &sid)?.ok()?;
    let client = Client::to_record(&rec, CONNECT).ok()?;
    let offers = |cap: &str| client.hello.caps.iter().any(|c| c.as_str() == cap);
    if !offers(MCP_CAP) {
        // A holder from before tool streams.
        return None;
    }
    // A holder from before `away` is acked as before, and sent nothing new.
    let away = offers(AWAY_CAP);
    let ack: &[&str] = if away { &ACK_CAPS[..] } else { &ACK_CAPS[..3] };
    let mut to_holder = client.into_stream();
    let mut from_holder = to_holder.try_clone().ok()?;
    from_holder.set_read_timeout(None).ok()?;
    let calls = if away { Some(Arc::new(Mutex::new(Calls::default()))) } else { None };
    let (tx, rx) = mpsc::sync_channel(WAITING);
    let (lines_tx, lines) = mpsc::channel::<String>();
    let out = Out { lines: lines_tx, queued: Arc::new(AtomicUsize::new(0)) };
    // The reader first, so the answer to the open is never missed.
    let (opened_tx, opened) = mpsc::channel::<()>();
    let reader = Reader { calls: calls.clone(), opened: opened_tx, wake: tx.clone(), out: out.clone() };
    thread::Builder::new().spawn(move || read_holder(from_holder, reader, lines)).ok()?;
    send(&mut to_holder, hello::ack_message(1, ack)).ok()?;
    send(&mut to_holder, mcp_open(STREAM)).ok()?;
    send(&mut to_holder, ping(OPEN_PING)).ok()?;
    // Nothing is read from the CLI until the holder has taken the open, so
    // an input that ends at once never passes for a stream that was had: a
    // refusal ends the process from the reader, before the `pong`.
    opened.recv_timeout(OPEN_WAIT).ok()?;
    thread::Builder::new().spawn(move || read_cli(tx)).ok()?;
    let mut ping_id: u64 = OPEN_PING + 2;
    // When a frame last went to the holder.
    let mut sent = Instant::now();
    loop {
        let ping_at = sent + PING_EVERY;
        let due = calls.as_ref().and_then(|c| lock(c).next_due());
        let until = due.map_or(ping_at, |d| d.min(ping_at));
        match rx.recv_timeout(until.saturating_duration_since(Instant::now())) {
            Ok(FromCli::Message(message)) => {
                let act = match &calls {
                    Some(c) => lock(c).from_cli(message, Instant::now()),
                    None => Act::Send(message),
                };
                match act {
                    Act::Send(message) => {
                        send(&mut to_holder, mcp_message(STREAM, message)).ok()?;
                        sent = Instant::now();
                    }
                    Act::Answer(answer) => {
                        if !out.line(&answer) {
                            return None;
                        }
                    }
                    Act::Keep => {}
                }
            }
            Ok(FromCli::Wake) | Err(RecvTimeoutError::Timeout) => {}
            Ok(FromCli::End(code)) => {
                let _ = send(&mut to_holder, mcp_close(STREAM));
                return Some(code);
            }
            // Every sender is gone without a word.
            Err(RecvTimeoutError::Disconnected) => {
                let _ = send(&mut to_holder, mcp_close(STREAM));
                return None;
            }
        }
        if let Some(c) = &calls {
            // A held call whose time is up is answered before the rest go.
            let (expired, released) = {
                let mut calls = lock(c);
                let expired = calls.expire(Instant::now());
                (expired, calls.release())
            };
            for answer in &expired {
                if !out.line(answer) {
                    return None;
                }
            }
            for message in released {
                send(&mut to_holder, mcp_message(STREAM, message)).ok()?;
                sent = Instant::now();
            }
        }
        if sent.elapsed() >= PING_EVERY {
            send(&mut to_holder, ping(ping_id)).ok()?;
            ping_id += 2;
            sent = Instant::now();
        }
    }
}

/// One message to the holder, whole within the time a write has. It goes on
/// to the app (section 6's helper to app), so its frame holds 1 MiB at most.
fn send(stream: &mut Stream, v: Value) -> io::Result<()> {
    let bytes = frame::encode(&Frame::json(0, v), Direction::HelperToApp).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    stream.write_all_within(&bytes, transport::WRITE_TIMEOUT)
}

/// A `ping` with this id.
fn ping(id: u64) -> Value {
    Value::obj(vec![("t", Value::str("ping")), ("id", Value::uint(id))])
}

/// Read what the holder sends until the stream cannot go on (`pass_to_cli`),
/// then end the process with `EXIT_FAILED`, a panic included. Standard output
/// is written by a thread of its own (`write_cli`), so the end of the stream
/// is seen even while the CLI is not reading; the lines queued until then
/// have `DRAIN` to go, in order.
fn read_holder(stream: Stream, reader: Reader, lines: Receiver<String>) {
    let (drained_tx, drained) = mpsc::channel::<()>();
    let counted = Arc::clone(&reader.out.queued);
    let writer = thread::Builder::new().spawn(move || {
        write_cli(lines, &counted);
        let _ = drained_tx.send(());
    });
    if writer.is_ok() {
        let out = reader.out.clone();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || pass_to_cli(stream, reader)));
        // The loop that sends to the holder may still queue an answer: the
        // writer stops at this mark, not at the end of every sender.
        out.end();
        let _ = drained.recv_timeout(DRAIN);
    }
    std::process::exit(i32::from(EXIT_FAILED));
}

/// Each `mcp` on this relay's stream goes to the CLI, in order, as one line
/// (with `away` acked, unless it answers a call the relay answered in the
/// app's place); the `pong` for `OPEN_PING` goes to `opened`. With `away`
/// acked, `mcp.away` answers the calls with the app and `mcp.back` wakes the
/// loop that sends the held ones. Returns when the stream cannot go on:
/// `mcp.close` for it, an `error` other than `too-large` (which refused one
/// message, and the stream goes on) or, once the stream is had with `away`
/// acked, `not-connected` (which refused one message sent while the holder
/// kept the stream), a frame that does not read, the connection lost,
/// standard output closed, or more than `OUT_QUEUE_BYTES` waiting for the
/// CLI. A frame toward the relay may hold what section 6's app to helper
/// allows: a tool result can carry a screenshot.
fn pass_to_cli(mut stream: Stream, r: Reader) {
    let mut taken = false;
    loop {
        let v = match frame::read_frame(&mut stream, Direction::AppToHelper) {
            Ok(Some(Frame { channel: 0, body: Body::Json(v) })) => v,
            Ok(Some(_)) => continue,
            Ok(None) | Err(_) => return,
        };
        let on_stream = v.get("stream").and_then(Value::as_u64) == Some(STREAM);
        let code = v.get("code").and_then(Value::as_str);
        match v.get("t").and_then(Value::as_str) {
            Some("mcp") if on_stream => {
                let message = match v.get("message") {
                    Some(m) => m,
                    None => return,
                };
                let passed = r.calls.as_ref().map_or(true, |c| lock(c).from_app(message));
                if passed && !r.out.line(message) {
                    return;
                }
            }
            Some("mcp.close") if on_stream => return,
            Some("mcp.away") if on_stream => {
                if let Some(c) = &r.calls {
                    let answers = lock(c).away();
                    for answer in &answers {
                        if !r.out.line(answer) {
                            return;
                        }
                    }
                }
            }
            Some("mcp.back") if on_stream => {
                if let Some(c) = &r.calls {
                    lock(c).back();
                    // A full queue means that loop has messages to take, and
                    // it looks at the calls after each one.
                    let _ = r.wake.try_send(FromCli::Wake);
                }
            }
            Some("pong") if v.get("re").and_then(Value::as_u64) == Some(OPEN_PING) => {
                taken = true;
                let _ = r.opened.send(());
            }
            Some("error") if taken && r.calls.is_some() && code == Some(CODE_NOT_CONNECTED) => {}
            Some("error") if code != Some(CODE_TOO_LARGE) => return,
            // A keep-alive `pong`, or a refusal of one message that was too
            // large.
            _ => {}
        }
    }
}

/// Write each line to standard output as it comes, until the mark
/// `Out::end` sends, the end of every sender, or the output closed; `queued`
/// counts what still waits.
fn write_cli(lines: Receiver<String>, queued: &AtomicUsize) {
    let stdout = io::stdout();
    for line in lines {
        if line.is_empty() {
            return;
        }
        let mut out = stdout.lock();
        if out.write_all(line.as_bytes()).and_then(|_| out.flush()).is_err() {
            return;
        }
        queued.fetch_sub(line.len(), Ordering::SeqCst);
    }
}

/// Standard input, a line at a time (`cli_lines`). A panic there is an end
/// too: the reader of the holder keeps a sender of its own, so the loop
/// would not see this one go.
fn read_cli(tx: SyncSender<FromCli>) {
    let end = tx.clone();
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || cli_lines(tx))).is_err() {
        let _ = end.send(FromCli::End(EXIT_FAILED));
    }
}

/// Each line of standard input that is a message goes to `tx`, and its end,
/// or a read that fails, ends it.
fn cli_lines(tx: SyncSender<FromCli>) {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    loop {
        let item = match next_line(&mut input, MAX_LINE) {
            Ok(Line::Text(line)) => match message_of(&line) {
                Some(message) => FromCli::Message(message),
                None => continue,
            },
            Ok(Line::TooLong) => continue,
            Ok(Line::End) => FromCli::End(EXIT_ENDED),
            Err(_) => FromCli::End(EXIT_FAILED),
        };
        let last = matches!(item, FromCli::End(_));
        if tx.send(item).is_err() || last {
            return;
        }
    }
}

/// The next line of `r`, without its line end, or `Line::TooLong` for one
/// over `max` bytes (read to its end so the next line is whole). A last line
/// with no line end is a line.
fn next_line<R: BufRead>(r: &mut R, max: usize) -> io::Result<Line> {
    let mut line: Vec<u8> = Vec::new();
    let mut over = false;
    let mut read_any = false;
    loop {
        let (used, ended) = {
            let buf = match r.fill_buf() {
                Ok(b) => b,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            if buf.is_empty() {
                return Ok(match (read_any, over) {
                    (false, _) => Line::End,
                    (true, true) => Line::TooLong,
                    (true, false) => Line::Text(line),
                });
            }
            read_any = true;
            let (part, ended) = match buf.iter().position(|&b| b == b'\n') {
                Some(at) => (&buf[..at], true),
                None => (buf, false),
            };
            if !over {
                if line.len() + part.len() > max {
                    over = true;
                    line = Vec::new();
                } else {
                    line.extend_from_slice(part);
                }
            }
            (part.len() + usize::from(ended), ended)
        };
        r.consume(used);
        if ended {
            return Ok(if over { Line::TooLong } else { Line::Text(line) });
        }
    }
}

/// The message one line holds: a JSON object or array, at most 31 levels deep
/// (the `mcp` around it makes 32), of at most `MAX_MCP_TO_APP` bytes as
/// compact JSON. None for anything else. A line end of `\r\n` is taken too.
fn message_of(line: &[u8]) -> Option<Value> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let v = json::parse(line).ok()?;
    if !matches!(v, Value::Obj(_) | Value::Arr(_)) || !v.fits_depth(json::MAX_DEPTH - 1) || v.to_json().len() > MAX_MCP_TO_APP {
        return None;
    }
    Some(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every line of `input`, read through a buffer of `chunk` bytes, so a
    /// line that spans reads is read too.
    fn lines(input: &[u8], max: usize, chunk: usize) -> Vec<Line> {
        let mut r = io::BufReader::with_capacity(chunk, io::Cursor::new(input.to_vec()));
        let mut out = Vec::new();
        loop {
            match next_line(&mut r, max).expect("a read") {
                Line::End => return out,
                line => out.push(line),
            }
        }
    }

    fn text(s: &str) -> Line {
        Line::Text(s.as_bytes().to_vec())
    }

    #[test]
    fn standard_input_is_read_a_line_at_a_time_and_a_long_line_is_dropped_whole() {
        for chunk in [1, 3, 64 * 1024] {
            assert_eq!(lines(b"", 10, chunk), Vec::<Line>::new(), "chunk {chunk}");
            assert_eq!(lines(b"a\nbb\r\n\nccc", 10, chunk), vec![text("a"), text("bb\r"), text(""), text("ccc")], "chunk {chunk}");
            // At the limit it is kept; one byte over, it is dropped, and the
            // line after it is whole.
            assert_eq!(lines(b"0123456789\n0123456789A\nshort\n", 10, chunk), vec![text("0123456789"), Line::TooLong, text("short")], "chunk {chunk}");
            assert_eq!(lines(b"0123456789AB", 10, chunk), vec![Line::TooLong], "chunk {chunk}");
        }
    }

    #[test]
    fn a_line_is_a_message_only_when_it_is_one_json_object_or_array_that_fits() {
        let request = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"x\",\"arguments\":{\"text\":\"caf\u{e9} \u{1f600} \\\"q\\\" \\\\ \\t \\u0001\"}}}";
        assert_eq!(message_of(request.as_bytes()).map(|m| m.to_json()), Some(request.to_string()), "a compact message is passed on as it came");
        assert!(message_of(format!("{request}\r").as_bytes()).is_some());
        assert!(message_of(b"[{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}]").is_some());
        // Read as JSON and sent compact.
        assert_eq!(message_of(b" { \"a\" : 1 } ").map(|m| m.to_json()), Some("{\"a\":1}".to_string()));
        let deep = |levels: usize| format!("{}{}", "[".repeat(levels), "]".repeat(levels));
        assert!(message_of(deep(31).as_bytes()).is_some());
        let too_deep = deep(32);
        for bad in ["", "   ", "not json", "1", "\"text\"", "null", "true", "{\"a\":1} {\"b\":2}", "{\"a\":\"\\ud83d\"}", too_deep.as_str()] {
            assert!(message_of(bad.as_bytes()).is_none(), "{bad:?}");
        }
        // The most the app takes, and one byte more.
        let of_size = |bytes: usize| format!("[\"{}\"]", "x".repeat(bytes - 4));
        assert!(message_of(of_size(MAX_MCP_TO_APP).as_bytes()).is_some());
        assert!(message_of(of_size(MAX_MCP_TO_APP + 1).as_bytes()).is_none());
    }

    #[test]
    fn the_relay_acks_mcp_and_keeps_the_documented_limits() {
        assert_eq!(ACK_CAPS, ["core", "local", "mcp", "away"]);
        assert_eq!((CONNECT, PING_EVERY, STREAM), (Duration::from_secs(2), Duration::from_secs(15), 1));
        assert_eq!((EXIT_ENDED, EXIT_FAILED), (0, 1));
        assert_eq!(MAX_LINE, 1024 * 1024);
        assert_eq!((OPEN_WAIT, OUT_QUEUE_BYTES, DRAIN), (Duration::from_secs(10), 64 * 1024 * 1024, Duration::from_secs(5)));
        // A ping keeps the connection inside the holder's idle limit, and the
        // queue for the CLI holds more than the largest message.
        assert!(PING_EVERY * 3 < crate::serve::IDLE_TIMEOUT);
        assert!(OUT_QUEUE_BYTES > crate::request::MAX_MCP_TO_HELPER * 3);
    }

    fn v(text: &str) -> Value {
        json::parse(text.as_bytes()).unwrap_or_else(|e| panic!("not JSON ({e:?}): {text}"))
    }

    fn call(id: u64) -> Value {
        v(&format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"tools/call\",\"params\":{{\"name\":\"x\"}}}}"))
    }

    fn ids(messages: &[Value]) -> Vec<String> {
        messages.iter().map(|m| m.get("id").map(Value::to_json).unwrap_or_default()).collect()
    }

    fn strs(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_hold_and_its_bounds_are_the_documented_ones() {
        assert_eq!(HOLD, Duration::from_secs(30));
        assert_eq!(TEST_HOLD, Duration::from_secs(4));
        assert_eq!((MAX_HELD, MAX_HELD_BYTES, MAX_REMEMBERED), (32, 4 * 1024 * 1024, 64));
        assert_eq!((UPDATING, UPDATING_CODE), ("AI Code Conductor is updating, try again shortly", -32603));
        // Four of the largest messages wait together; a fifth does not.
        assert!(4 * MAX_MCP_TO_APP <= MAX_HELD_BYTES && 5 * MAX_MCP_TO_APP > MAX_HELD_BYTES);
    }

    #[test]
    fn the_fixed_answer_has_d1s_words_in_the_form_each_call_reads() {
        assert_eq!(
            updating_answer(&v("7"), "tools/call").to_json(),
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"AI Code Conductor is updating, try again shortly\"}],\"isError\":true}}"
        );
        assert_eq!(updating_answer(&v("\"a-1\""), "tools/list").to_json(), "{\"jsonrpc\":\"2.0\",\"id\":\"a-1\",\"error\":{\"code\":-32603,\"message\":\"AI Code Conductor is updating, try again shortly\"}}");
    }

    #[test]
    fn a_call_is_an_object_with_an_id_and_a_method_and_only_some_ids_are_known_again() {
        assert_eq!(call_of(&v(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call"}"#)), Some(Call { id: v("1"), method: "tools/call".to_string() }));
        assert_eq!(call_of(&v(r#"{"id":"a","method":"ping"}"#)), Some(Call { id: v("\"a\""), method: "ping".to_string() }));
        for not_a_call in [r#"{"method":"notifications/initialized"}"#, r#"{"id":null,"method":"x"}"#, r#"{"id":{},"method":"x"}"#, r#"{"id":1,"method":2}"#, r#"{"id":1,"result":{}}"#, r#"[{"id":1,"method":"x"}]"#] {
            assert_eq!(call_of(&v(not_a_call)), None, "{not_a_call}");
        }
        for (id, key) in [("1", Some("1")), ("0", Some("0")), ("-5", Some("-5")), ("123456789012345", Some("123456789012345")), ("\"x\"", Some("\"x\"")), ("\"caf\\u00e9\"", Some("\"caf\u{e9}\""))] {
            assert_eq!(id_key(&v(id)).as_deref(), key, "{id}");
        }
        // Written otherwise than the app writes it back, or past what a
        // JavaScript number holds exactly: not known again.
        for id in ["1.0", "1e2", "-0", "1234567890123456", "true", "null"] {
            assert_eq!(id_key(&v(id)), None, "{id}");
        }
        assert_eq!(answer_key(&v(r#"{"jsonrpc":"2.0","id":3,"result":{}}"#)).as_deref(), Some("3"));
        assert_eq!(answer_key(&v(r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#)), None);
        assert_eq!(cancelled(&v(r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"r"}}"#)).as_deref(), Some("\"r\""));
        assert_eq!(cancelled(&v(r#"{"jsonrpc":"2.0","id":4,"method":"notifications/cancelled","params":{"requestId":3}}"#)), None);
        assert_eq!(cancelled(&v(r#"{"jsonrpc":"2.0","method":"notifications/progress","params":{"requestId":3}}"#)), None);
    }

    #[test]
    fn a_call_with_the_app_is_answered_once_when_it_goes_and_its_late_answer_is_dropped() {
        let now = Instant::now();
        let mut c = Calls::default();
        assert_eq!(c.from_cli(call(1), now), Act::Send(call(1)));
        let list = v(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
        assert_eq!(c.from_cli(list.clone(), now), Act::Send(list));
        let note = v(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert_eq!(c.from_cli(note.clone(), now), Act::Send(note));
        // The app answers 1; 2 is still with it when it goes.
        assert!(c.from_app(&v(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#)));
        assert_eq!(c.away(), vec![updating_answer(&v("2"), "tools/list")]);
        assert!(c.away().is_empty(), "a call was answered twice");
        // Its late answer is dropped once; others pass, as does anything that
        // is not an answer.
        assert!(!c.from_app(&v(r#"{"jsonrpc":"2.0","id":2,"result":{}}"#)));
        assert!(c.from_app(&v(r#"{"jsonrpc":"2.0","id":2,"result":{}}"#)));
        assert!(c.from_app(&v(r#"{"jsonrpc":"2.0","id":9,"result":{}}"#)));
        assert!(c.from_app(&v(r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#)));
        // A call sent again with a key the relay answered is the CLI's own
        // new call: its answer passes.
        let mut d = Calls::default();
        d.from_cli(call(5), now);
        d.away();
        d.back();
        d.release();
        assert_eq!(d.from_cli(call(5), now), Act::Send(call(5)));
        assert!(d.from_app(&v(r#"{"jsonrpc":"2.0","id":5,"result":{}}"#)));
    }

    #[test]
    fn a_cancel_of_a_call_with_the_app_forgets_it_and_goes_on_as_it_came() {
        let now = Instant::now();
        let mut c = Calls::default();
        c.from_cli(call(1), now);
        c.from_cli(v(r#"{"jsonrpc":"2.0","id":"s","method":"tools/list"}"#), now);
        // The CLI gave up on 1 (Esc, or its own timeout), and the app sends
        // no answer to it: the cancel goes on as it came, and 1 is forgotten.
        let cancel = v(r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1,"reason":"x"}}"#);
        assert_eq!(c.from_cli(cancel.clone(), now), Act::Send(cancel));
        // When the app goes, only the call the CLI still waits for is answered.
        assert_eq!(c.away(), vec![updating_answer(&v("\"s\""), "tools/list")]);
        // A cancel of the one call there is leaves nothing to answer.
        let mut d = Calls::default();
        d.from_cli(call(1), now);
        d.from_cli(v(r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}"#), now);
        assert!(d.away().is_empty(), "a call the CLI cancelled was answered");
    }

    #[test]
    fn at_most_64_calls_are_remembered_and_the_oldest_is_forgotten() {
        let now = Instant::now();
        let mut c = Calls::default();
        for id in 0..=MAX_REMEMBERED as u64 {
            c.from_cli(call(id), now);
        }
        let answers = c.away();
        assert_eq!(answers.len(), MAX_REMEMBERED);
        assert_eq!(ids(&answers[..1]), strs(&["1"]), "the oldest was not the one forgotten");
        assert_eq!(c.answered.len(), MAX_REMEMBERED);
    }

    #[test]
    fn while_away_calls_wait_in_order_up_to_32_and_go_on_back() {
        let now = Instant::now();
        let mut c = Calls::default();
        assert!(c.away().is_empty());
        assert_eq!(c.from_cli(call(1), now), Act::Keep);
        // A notification, and the CLI's answer to the app, are dropped.
        assert_eq!(c.from_cli(v(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#), now), Act::Keep);
        assert_eq!(c.from_cli(v(r#"{"jsonrpc":"2.0","id":5,"result":{}}"#), now), Act::Keep);
        for id in 2..=MAX_HELD as u64 {
            assert_eq!(c.from_cli(call(id), now), Act::Keep);
        }
        assert_eq!(c.from_cli(call(33), now), Act::Answer(updating_answer(&v("33"), "tools/call")));
        assert_eq!(c.next_due(), Some(now + HELD_FOR));
        // Nothing goes before `mcp.back`.
        assert!(c.release().is_empty());
        c.back();
        let released = c.release();
        assert_eq!(ids(&released), (1..=32).map(|i: u64| i.to_string()).collect::<Vec<_>>());
        assert!(c.next_due().is_none() && c.held_bytes == 0);
        // As before now: a call is sent, and each sent is with the app.
        assert_eq!(c.from_cli(call(40), now), Act::Send(call(40)));
        assert_eq!(c.away().len(), 33);
    }

    #[test]
    fn held_calls_are_bounded_by_their_bytes_and_each_ends_at_its_time() {
        let now = Instant::now();
        let mut c = Calls::default();
        c.away();
        let big = |id: u64| {
            let head = format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"tools/call\",\"params\":{{\"pad\":\"");
            v(&format!("{head}{}\"}}}}", "x".repeat(MAX_MCP_TO_APP - head.len() - 3)))
        };
        assert_eq!(big(0).to_json().len(), MAX_MCP_TO_APP);
        for id in 0..4 {
            assert_eq!(c.from_cli(big(id), now), Act::Keep);
        }
        assert_eq!(c.from_cli(big(4), now), Act::Answer(updating_answer(&v("4"), "tools/call")));
        assert_eq!(c.from_cli(call(5), now + Duration::from_millis(10)), Act::Keep);
        assert!(c.expire(now + HELD_FOR - Duration::from_millis(1)).is_empty());
        assert_eq!(ids(&c.expire(now + HELD_FOR)), strs(&["0", "1", "2", "3"]));
        assert_eq!(ids(&c.expire(now + HELD_FOR + Duration::from_millis(10))), strs(&["5"]));
        assert!(c.next_due().is_none() && c.held_bytes == 0);
    }

    #[test]
    fn a_cancel_drops_a_held_call_and_a_batch_is_answered_at_once() {
        let now = Instant::now();
        let mut c = Calls::default();
        c.away();
        c.from_cli(call(1), now);
        c.from_cli(v(r#"{"jsonrpc":"2.0","id":"two","method":"resources/list"}"#), now);
        let cancel = |id: &str| v(&format!("{{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{{\"requestId\":{id}}}}}"));
        assert_eq!(c.from_cli(cancel("1"), now), Act::Keep);
        assert_eq!(c.from_cli(cancel("9"), now), Act::Keep);
        assert_eq!(c.expire(now + HELD_FOR), vec![updating_answer(&v("\"two\""), "resources/list")]);
        let batch = v(r#"[{"jsonrpc":"2.0","id":3,"method":"tools/call"},{"jsonrpc":"2.0","method":"notifications/progress"},{"jsonrpc":"2.0","id":"b","method":"ping"}]"#);
        assert_eq!(c.from_cli(batch, now), Act::Answer(Value::Arr(vec![updating_answer(&v("3"), "tools/call"), updating_answer(&v("\"b\""), "ping")])));
        assert_eq!(c.from_cli(v(r#"[{"jsonrpc":"2.0","method":"notifications/progress"}]"#), now), Act::Keep);
        assert!(c.next_due().is_none());
        // As before `away`, a batch goes on as it came, and is not remembered.
        let mut d = Calls::default();
        let batch = v(r#"[{"jsonrpc":"2.0","id":3,"method":"tools/call"}]"#);
        assert_eq!(d.from_cli(batch.clone(), now), Act::Send(batch));
        assert!(d.away().is_empty());
    }

    #[test]
    fn a_back_that_an_away_overtakes_is_undone() {
        let now = Instant::now();
        let mut c = Calls::default();
        c.away();
        c.from_cli(call(1), now);
        c.back();
        // Away again before the loop sent the held calls: they wait on.
        assert!(c.away().is_empty());
        assert!(c.release().is_empty());
        assert_eq!(c.held.len(), 1);
        // A `mcp.back` while not away changes nothing.
        let mut d = Calls::default();
        d.back();
        assert!(d.release().is_empty());
        assert_eq!(d.from_cli(call(2), now), Act::Send(call(2)));
    }
}
