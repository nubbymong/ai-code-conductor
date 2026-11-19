//! `aicc-helper mcp --store <folder> --session <sid>`: a session's tool
//! server as its CLI starts one, relayed through the session's holder to the
//! app (protocol section 15, capability `mcp`, from 2.1.3-beta.10). Nothing in
//! the app starts it or names it yet.
//!
//! The CLI starts it as its own child, with pipes for its standard input and
//! output, and speaks MCP to it: one JSON-RPC message a line, each way. The
//! relay reads the session's record with the store's strict reader and
//! connects with the client list mode and the hook mode use (the endpoint's
//! checks, then the hello's nonce and session). A holder whose hello does not
//! offer `mcp` (one from before 2.1.3-beta.10) is sent nothing, not even the
//! ack. Otherwise the relay acks `core`, `local` and `mcp` and opens its one
//! stream (`mcp.open`, number 1). From then on each line it reads goes to the
//! holder as one `mcp`, and each `mcp` the holder sends on that stream goes to
//! standard output as one line, its message alone, as compact JSON. It reads
//! no message: whatever method comes is passed on in the order it came, and
//! nothing waits for an `initialize`. It pings the holder every 15 s, as the
//! app does, so the connection is not dropped as idle.
//!
//! A line that is not one JSON object or array (an empty line, text that is
//! not JSON, a value more than 31 levels deep, an escaped lone surrogate), or
//! whose message is over the 1,048,320 bytes the app takes, is dropped and the
//! next line read: nothing reaches the holder, and the CLI's own timeout
//! answers it. A line over 1 MiB is read to its end and dropped the same way.
//!
//! It exits 0 when its standard input ends, after `mcp.close`. It exits 1 as
//! soon as its stream cannot be had or cannot go on: a command line it does not
//! take, no record or no holder, a holder without `mcp`, no connection that
//! takes tool streams (`not-connected`), too many streams (`busy`), its stream
//! ended from the other side (`mcp.close` from the holder, once the app let
//! go), any other `error` but `too-large`, or the connection lost. Standard
//! output carries only the messages: it prints nothing else, nothing on
//! standard error, and writes no file. Its store and session come from its
//! command line alone, never from its environment, which a CLI may pass
//! almost none of.

use crate::client::Client;
use crate::frame::{self, Body, Direction, Frame};
use crate::hello;
use crate::hook::parse_args;
use crate::json::{self, Value};
use crate::request::{CODE_TOO_LARGE, MAX_MCP_TO_APP};
use crate::serve::{mcp_close, mcp_message, mcp_open, MCP_CAP};
use crate::store;
use crate::transport::{self, Stream};
use std::io::{self, BufRead, Write};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::thread;
use std::time::Duration;

/// What the relay acks: the frozen core, `local` and `mcp`.
pub const ACK_CAPS: [&str; 3] = ["core", "local", MCP_CAP];
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

/// Run the relay on `args` (what follows `mcp`): its exit status. It returns
/// at the end of standard input; every other end exits the process from the
/// thread that reads the holder, with `EXIT_FAILED`.
pub fn run(args: &[String]) -> u8 {
    relay(args).unwrap_or(EXIT_FAILED)
}

/// What the reader of standard input hands on.
enum FromCli {
    Message(Value),
    /// The end: `EXIT_ENDED` at the end of the input, `EXIT_FAILED` when it
    /// could not be read.
    End(u8),
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

fn relay(args: &[String]) -> Option<u8> {
    let (store_dir, sid) = parse_args(args)?;
    let rec = store::read(&store_dir, &sid)?.ok()?;
    let client = Client::to_record(&rec, CONNECT).ok()?;
    if !client.hello.caps.iter().any(|c| c.as_str() == MCP_CAP) {
        // A holder from before tool streams.
        return None;
    }
    let mut to_holder = client.into_stream();
    let mut from_holder = to_holder.try_clone().ok()?;
    from_holder.set_read_timeout(None).ok()?;
    // The reader first, so the answer to the open is never missed.
    thread::Builder::new().spawn(move || read_holder(from_holder)).ok()?;
    send(&mut to_holder, hello::ack_message(1, &ACK_CAPS)).ok()?;
    send(&mut to_holder, mcp_open(STREAM)).ok()?;
    let (tx, rx) = mpsc::sync_channel(WAITING);
    thread::Builder::new().spawn(move || read_cli(tx)).ok()?;
    let mut ping_id: u64 = 2;
    loop {
        match rx.recv_timeout(PING_EVERY) {
            Ok(FromCli::Message(message)) => send(&mut to_holder, mcp_message(STREAM, message)).ok()?,
            Ok(FromCli::End(code)) => {
                let _ = send(&mut to_holder, mcp_close(STREAM));
                return Some(code);
            }
            Err(RecvTimeoutError::Timeout) => {
                send(&mut to_holder, Value::obj(vec![("t", Value::str("ping")), ("id", Value::uint(ping_id))])).ok()?;
                ping_id += 2;
            }
            // The reader of standard input is gone without a word.
            Err(RecvTimeoutError::Disconnected) => {
                let _ = send(&mut to_holder, mcp_close(STREAM));
                return None;
            }
        }
    }
}

/// One message to the holder, whole within the time a write has. It goes on
/// to the app (section 6's helper to app), so its frame holds 1 MiB at most.
fn send(stream: &mut Stream, v: Value) -> io::Result<()> {
    let bytes = frame::encode(&Frame::json(0, v), Direction::HelperToApp).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    stream.write_all_within(&bytes, transport::WRITE_TIMEOUT)
}

/// Read what the holder sends until the stream cannot go on (`pass_to_cli`),
/// then end the process with `EXIT_FAILED`, a panic included.
fn read_holder(stream: Stream) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || pass_to_cli(stream)));
    std::process::exit(i32::from(EXIT_FAILED));
}

/// Each `mcp` on this relay's stream goes to standard output as one line.
/// Returns when the stream cannot go on: `mcp.close` for it, an `error` other
/// than `too-large` (which refused one message, and the stream goes on), a
/// frame that does not read, standard output closed, or the connection lost.
/// A frame toward the relay may hold what section 6's app to helper allows: a
/// tool result can carry a screenshot.
fn pass_to_cli(mut stream: Stream) {
    let stdout = io::stdout();
    loop {
        let v = match frame::read_frame(&mut stream, Direction::AppToHelper) {
            Ok(Some(Frame { channel: 0, body: Body::Json(v) })) => v,
            Ok(Some(_)) => continue,
            Ok(None) | Err(_) => return,
        };
        let on_stream = v.get("stream").and_then(Value::as_u64) == Some(STREAM);
        match v.get("t").and_then(Value::as_str) {
            Some("mcp") if on_stream => {
                let message = match v.get("message") {
                    Some(m) => m,
                    None => return,
                };
                let mut line = message.to_json();
                line.push('\n');
                let mut out = stdout.lock();
                if out.write_all(line.as_bytes()).and_then(|_| out.flush()).is_err() {
                    return;
                }
            }
            Some("mcp.close") if on_stream => return,
            Some("error") if v.get("code").and_then(Value::as_str) != Some(CODE_TOO_LARGE) => return,
            // A `pong`, or a refusal of one message that was too large.
            _ => {}
        }
    }
}

/// Standard input, a line at a time: each line that is a message goes to
/// `tx`, and its end, or a read that fails, ends it.
fn read_cli(tx: SyncSender<FromCli>) {
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
        assert_eq!(ACK_CAPS, ["core", "local", "mcp"]);
        assert_eq!((CONNECT, PING_EVERY, STREAM), (Duration::from_secs(2), Duration::from_secs(15), 1));
        assert_eq!((EXIT_ENDED, EXIT_FAILED), (0, 1));
        assert_eq!(MAX_LINE, 1024 * 1024);
        // A ping keeps the connection inside the holder's idle limit.
        assert!(PING_EVERY * 3 < crate::serve::IDLE_TIMEOUT);
    }
}
