//! A client of a holder's local endpoint: what list mode, the self-test and
//! the tests use to talk to a holder the way the app does (protocol section
//! 15). It reads the hello line, checks it against the record's nonce and
//! session, then speaks frames.

use crate::frame::{self, Direction, Frame, FrameError};
use crate::hello::{self, ParsedHello, LOCAL_CAPS, MAX_HELLO_LINE};
use crate::json::Value;
use crate::store::{Probe, Record};
use crate::transport::{self, Stream};
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

/// How long list mode waits to connect, and then for the hello.
pub const PROBE_CONNECT: Duration = Duration::from_secs(2);
pub const PROBE_HELLO: Duration = Duration::from_secs(3);

/// Read one line ending in `\n`, a byte at a time so nothing after it is
/// taken from the stream. `max` bytes at most, the line end not counted. The
/// whole line must come within `timeout`: each read waits only for what is
/// left, so a peer sending a byte now and then cannot stretch it.
pub fn read_line(stream: &mut Stream, max: usize, timeout: Duration) -> io::Result<String> {
    let deadline = Instant::now() + timeout;
    let mut line: Vec<u8> = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "no whole line in time"));
        }
        stream.set_read_timeout(Some(left.max(Duration::from_millis(1))))?;
        match stream.read(&mut byte) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the stream ended before a line end")),
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
        if byte[0] == b'\n' {
            break;
        }
        if line.len() >= max {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "the line is too long"));
        }
        line.push(byte[0]);
    }
    String::from_utf8(line).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "the line is not UTF-8"))
}

fn frame_error(e: FrameError) -> io::Error {
    match e {
        FrameError::Io(e) => e,
        FrameError::BadFrame(why) => io::Error::new(io::ErrorKind::InvalidData, format!("bad-frame: {why}")),
    }
}

pub struct Client {
    stream: Stream,
    pub hello: ParsedHello,
    /// Bytes read but not yet a whole frame, so a timeout never splits one.
    buf: Vec<u8>,
    eof: bool,
}

/// The length of the whole frame at the start of `buf`, once it is all there.
fn whole_frame(buf: &[u8]) -> io::Result<Option<usize>> {
    if buf.len() < 4 {
        return Ok(None);
    }
    let rest = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if rest < frame::MIN_REST as usize || rest > frame::MIN_REST as usize + frame::MAX_JSON_HELPER_TO_APP {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "bad-frame: a length out of bounds"));
    }
    Ok(if buf.len() >= 4 + rest { Some(4 + rest) } else { None })
}

impl Client {
    /// Connect and read the hello. It must carry `nonce` and `sid`.
    pub fn connect(endpoint: &str, nonce: &str, sid: &str, timeout: Duration) -> io::Result<Client> {
        let mut stream = transport::connect(endpoint, timeout)?;
        let line = read_line(&mut stream, MAX_HELLO_LINE, timeout)?;
        let hello = hello::parse_hello_line(&line, nonce, sid).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("{}: {}", e.code, e.why)))?;
        Ok(Client { stream, hello, buf: Vec::new(), eof: false })
    }

    /// Connect to the holder a record names.
    pub fn to_record(rec: &Record, timeout: Duration) -> io::Result<Client> {
        Client::connect(&rec.endpoint, &rec.nonce, &rec.session, timeout)
    }

    /// The connection itself, for a caller that reads it on one thread and
    /// writes it on another (the relay, `relay.rs`). Taken before anything is
    /// received, so no byte read is left behind.
    pub fn into_stream(self) -> Stream {
        self.stream
    }

    /// Answer the hello as the app does: version 1, `core` and `local`.
    pub fn ack(&mut self) -> io::Result<()> {
        self.send(hello::ack_message(1, &LOCAL_CAPS))
    }

    pub fn send(&mut self, v: Value) -> io::Result<()> {
        let bytes = frame::encode(&Frame::json(0, v), Direction::AppToHelper).map_err(frame_error)?;
        self.send_bytes(&bytes)
    }

    pub fn send_raw(&mut self, channel: u32, bytes: &[u8]) -> io::Result<()> {
        let out = frame::encode(&Frame::raw(channel, bytes.to_vec()), Direction::AppToHelper).map_err(frame_error)?;
        self.send_bytes(&out)
    }

    /// Bytes exactly as given: a test sends broken frames this way.
    pub fn send_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.stream.write_all(bytes)?;
        self.stream.flush()
    }

    /// The next frame, `Ok(None)` at a clean end. With no whole frame within
    /// `timeout` it fails with a timeout error, and keeps what it has read.
    pub fn recv(&mut self, timeout: Duration) -> io::Result<Option<Frame>> {
        let deadline = Instant::now() + timeout;
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            if let Some(n) = whole_frame(&self.buf)? {
                let bytes: Vec<u8> = self.buf.drain(..n).collect();
                return frame::decode(&bytes, Direction::HelperToApp).map(Some).map_err(frame_error);
            }
            if self.eof {
                if self.buf.is_empty() {
                    return Ok(None);
                }
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the stream ended inside a frame"));
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "no whole frame in time"));
            }
            self.stream.set_read_timeout(Some(left.max(Duration::from_millis(1))))?;
            match self.stream.read(&mut chunk) {
                Ok(0) => self.eof = true,
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
    }
}

/// Ask a record's endpoint whether its holder is there (list mode).
pub fn probe(rec: &Record) -> Probe {
    let mut stream = match transport::connect(&rec.endpoint, PROBE_CONNECT) {
        Ok(s) => s,
        Err(e) if transport::means_gone(&e) => return Probe::Gone,
        Err(_) => return Probe::Unknown,
    };
    let line = match read_line(&mut stream, MAX_HELLO_LINE, PROBE_HELLO) {
        Ok(l) => l,
        Err(_) => return Probe::Unknown,
    };
    match hello::parse_hello_line(&line, &rec.nonce, &rec.session) {
        // Our nonce and session: our holder. A process id the OS reports that
        // is not the record's proves nothing more (it may name the process
        // that made the socket), so it does not make the record stale.
        Ok(_) => Probe::Live,
        // Something answered that does not know the record's nonce.
        Err(_) => Probe::Gone,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::Listener;
    use std::sync::{mpsc, Arc};

    #[test]
    fn a_hello_sent_a_byte_at_a_time_is_given_up_at_its_deadline() {
        let listener = Arc::new(Listener::bind("client-drip-01").expect("listen"));
        let server = Arc::clone(&listener);
        std::thread::spawn(move || {
            if let Ok(mut s) = server.accept() {
                // A byte every 200 ms and never a line end, until the client goes.
                while s.write_all(b"x").and_then(|_| s.flush()).is_ok() {
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
        });
        let rec = Record {
            session: "client-drip-01".to_string(),
            label: String::new(),
            pid: std::process::id(),
            endpoint: listener.endpoint().to_string(),
            nonce: "0123456789abcdef0123456789abcdef".to_string(),
            helper: "0.1.0".to_string(),
            started: 0,
            lifetime: crate::store::Lifetime::Away(120),
            attached: false,
            child: "waiting".to_string(),
            code: None,
        };
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(probe(&rec));
        });
        let answer = rx.recv_timeout(PROBE_CONNECT + PROBE_HELLO + Duration::from_secs(4)).expect("the probe kept reading past its deadline");
        assert_eq!(answer, Probe::Unknown);
    }
}
