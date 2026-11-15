//! The frame codec (docs/remote/helper-protocol.md section 6).
//!
//! After the hello, every message is one frame:
//!
//! ```text
//! 4 bytes  length of the rest, unsigned, big-endian  (kind + channel + payload)
//! 1 byte   kind: 0 = JSON control, 1 = raw bytes
//! 4 bytes  channel id, big-endian (0 = control)
//! n bytes  payload
//! ```
//!
//! Hard limits: JSON 1 MiB helper to app and 16 MiB app to helper; raw 64 KiB
//! both ways; JSON depth 32. The reader refuses an oversize length before it
//! allocates anything for it.

use crate::json::{self, Value};
use std::io::{self, Read};

pub const KIND_JSON: u8 = 0;
pub const KIND_RAW: u8 = 1;
/// kind (1) + channel (4): the smallest "rest" a frame can have.
pub const MIN_REST: u32 = 5;
pub const MAX_JSON_HELPER_TO_APP: usize = 1024 * 1024;
pub const MAX_JSON_APP_TO_HELPER: usize = 16 * 1024 * 1024;
pub const MAX_RAW: usize = 64 * 1024;

pub const CODE_BAD_FRAME: &str = "bad-frame";
pub const CODE_IO: &str = "io";

/// Which way a frame travels. The sender and the reader of one connection
/// agree on it, because the JSON limit differs per direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    HelperToApp,
    AppToHelper,
}

impl Direction {
    pub fn max_json(self) -> usize {
        match self {
            Direction::HelperToApp => MAX_JSON_HELPER_TO_APP,
            Direction::AppToHelper => MAX_JSON_APP_TO_HELPER,
        }
    }

    /// The names the shared fixtures use.
    pub fn from_name(name: &str) -> Option<Direction> {
        match name {
            "helper_to_app" => Some(Direction::HelperToApp),
            "app_to_helper" => Some(Direction::AppToHelper),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Body {
    Json(Value),
    Raw(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub channel: u32,
    pub body: Body,
}

impl Frame {
    pub fn json(channel: u32, value: Value) -> Frame {
        Frame { channel, body: Body::Json(value) }
    }

    pub fn raw(channel: u32, bytes: Vec<u8>) -> Frame {
        Frame { channel, body: Body::Raw(bytes) }
    }
}

#[derive(Debug)]
pub enum FrameError {
    /// The protocol's `bad-frame`: a length over the limit or under 5, an
    /// unknown kind, JSON that does not read or is too deep, a raw frame over
    /// 64 KiB. The connection closes.
    BadFrame(&'static str),
    /// The stream ended inside a frame, or could not be read.
    Io(io::Error),
}

impl FrameError {
    /// The protocol error code this maps to (`bad-frame`, or `io`).
    pub fn code(&self) -> &'static str {
        match self {
            FrameError::BadFrame(_) => CODE_BAD_FRAME,
            FrameError::Io(_) => CODE_IO,
        }
    }
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::BadFrame(why) => write!(f, "bad-frame: {why}"),
            FrameError::Io(e) => write!(f, "io: {e}"),
        }
    }
}

impl std::error::Error for FrameError {}

impl From<io::Error> for FrameError {
    fn from(e: io::Error) -> FrameError {
        FrameError::Io(e)
    }
}

/// Encode one frame as it travels in `flow`. The limits apply to the sender
/// too, so a message the other side would refuse is never sent.
pub fn encode(frame: &Frame, flow: Direction) -> Result<Vec<u8>, FrameError> {
    let (kind, payload) = match &frame.body {
        Body::Json(value) => {
            // The same depth limit the reader applies, checked before writing.
            if !value.fits_depth(json::MAX_DEPTH) {
                return Err(FrameError::BadFrame("JSON deeper than 32"));
            }
            let text = value.to_json().into_bytes();
            if text.len() > flow.max_json() {
                return Err(FrameError::BadFrame("JSON payload over the limit"));
            }
            (KIND_JSON, text)
        }
        Body::Raw(bytes) => {
            if bytes.len() > MAX_RAW {
                return Err(FrameError::BadFrame("raw payload over 64 KiB"));
            }
            (KIND_RAW, bytes.clone())
        }
    };
    let rest = MIN_REST as usize + payload.len();
    let mut out = Vec::with_capacity(4 + rest);
    out.extend_from_slice(&(rest as u32).to_be_bytes());
    out.push(kind);
    out.extend_from_slice(&frame.channel.to_be_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

fn read_exact_or_eof<R: Read>(r: &mut R, buf: &mut [u8]) -> Result<bool, FrameError> {
    // Ok(false): the stream ended before the first byte (a clean end).
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => {
                if filled == 0 {
                    return Ok(false);
                }
                return Err(FrameError::Io(io::Error::new(io::ErrorKind::UnexpectedEof, "stream ended inside a frame")));
            }
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FrameError::Io(e)),
        }
    }
    Ok(true)
}

/// Read one frame. `Ok(None)` is a clean end of the stream before a frame began.
pub fn read_frame<R: Read>(r: &mut R, flow: Direction) -> Result<Option<Frame>, FrameError> {
    let mut len_bytes = [0u8; 4];
    if !read_exact_or_eof(r, &mut len_bytes)? {
        return Ok(None);
    }
    let rest = u32::from_be_bytes(len_bytes);
    // Both bounds are checked before any buffer is made for the payload.
    if rest < MIN_REST {
        return Err(FrameError::BadFrame("length under 5"));
    }
    let max_rest = MIN_REST as u64 + flow.max_json() as u64;
    if rest as u64 > max_rest {
        return Err(FrameError::BadFrame("length over the limit"));
    }
    let mut head = [0u8; 5];
    r.read_exact(&mut head)?;
    let kind = head[0];
    let channel = u32::from_be_bytes([head[1], head[2], head[3], head[4]]);
    let payload_len = (rest - MIN_REST) as usize;
    let body = match kind {
        KIND_JSON => {
            let mut payload = vec![0u8; payload_len];
            r.read_exact(&mut payload)?;
            match json::parse(&payload) {
                Ok(value) => Body::Json(value),
                Err(json::JsonError::TooDeep) => return Err(FrameError::BadFrame("JSON deeper than 32")),
                Err(_) => return Err(FrameError::BadFrame("payload is not JSON")),
            }
        }
        KIND_RAW => {
            if payload_len > MAX_RAW {
                return Err(FrameError::BadFrame("raw payload over 64 KiB"));
            }
            let mut payload = vec![0u8; payload_len];
            r.read_exact(&mut payload)?;
            Body::Raw(payload)
        }
        _ => return Err(FrameError::BadFrame("unknown kind")),
    };
    Ok(Some(Frame { channel, body }))
}

/// Decode exactly one frame from `bytes`; bytes after it are an error.
pub fn decode(bytes: &[u8], flow: Direction) -> Result<Frame, FrameError> {
    let mut cursor = io::Cursor::new(bytes);
    let frame = match read_frame(&mut cursor, flow)? {
        Some(f) => f,
        None => return Err(FrameError::Io(io::Error::new(io::ErrorKind::UnexpectedEof, "no frame"))),
    };
    if (cursor.position() as usize) != bytes.len() {
        return Err(FrameError::BadFrame("bytes after the frame"));
    }
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ping() -> Frame {
        Frame::json(0, Value::obj(vec![("t", Value::str("ping")), ("id", Value::uint(2))]))
    }

    #[test]
    fn a_frame_round_trips_and_has_the_documented_layout() {
        let bytes = encode(&ping(), Direction::AppToHelper).unwrap();
        let payload = br#"{"t":"ping","id":2}"#;
        assert_eq!(&bytes[0..4], &((5 + payload.len()) as u32).to_be_bytes());
        assert_eq!(bytes[4], KIND_JSON);
        assert_eq!(&bytes[5..9], &[0, 0, 0, 0]);
        assert_eq!(&bytes[9..], payload);
        assert_eq!(decode(&bytes, Direction::AppToHelper).unwrap(), ping());
    }

    #[test]
    fn a_message_the_reader_would_refuse_for_depth_is_not_encoded() {
        let nest = |n: usize| Frame::json(0, (0..n).fold(Value::Null, |inner, _| Value::Arr(vec![inner])));
        for flow in [Direction::AppToHelper, Direction::HelperToApp] {
            let ok = encode(&nest(32), flow).expect("depth 32 encodes");
            assert_eq!(decode(&ok, flow).unwrap(), nest(32));
            assert!(matches!(encode(&nest(33), flow), Err(FrameError::BadFrame(_))), "depth 33 must not encode");
        }
    }

    #[test]
    fn raw_frames_carry_a_channel_and_may_be_empty() {
        let f = Frame::raw(0x0102_0304, vec![]);
        let bytes = encode(&f, Direction::HelperToApp).unwrap();
        assert_eq!(bytes, vec![0, 0, 0, 5, 1, 1, 2, 3, 4]);
        assert_eq!(decode(&bytes, Direction::HelperToApp).unwrap(), f);
    }

    #[test]
    fn a_clean_end_before_a_frame_is_none_and_a_cut_frame_is_an_io_error() {
        let mut empty = io::Cursor::new(Vec::<u8>::new());
        assert!(read_frame(&mut empty, Direction::AppToHelper).unwrap().is_none());
        let bytes = encode(&ping(), Direction::AppToHelper).unwrap();
        let mut cut = io::Cursor::new(bytes[..bytes.len() - 2].to_vec());
        assert_eq!(read_frame(&mut cut, Direction::AppToHelper).unwrap_err().code(), CODE_IO);
    }

    #[test]
    fn the_length_is_checked_before_anything_is_read_or_allocated() {
        // Only the four length bytes exist: an oversize length must be refused
        // as bad-frame, not discovered later as a short read.
        let over_json = ((MIN_REST as usize + MAX_JSON_HELPER_TO_APP + 1) as u32).to_be_bytes();
        assert_eq!(decode(&over_json, Direction::HelperToApp).unwrap_err().code(), CODE_BAD_FRAME);
        assert_eq!(decode(&0xffff_ffffu32.to_be_bytes(), Direction::AppToHelper).unwrap_err().code(), CODE_BAD_FRAME);
        for rest in 0u32..5 {
            assert_eq!(decode(&rest.to_be_bytes(), Direction::AppToHelper).unwrap_err().code(), CODE_BAD_FRAME, "{rest}");
        }
    }

    #[test]
    fn the_json_limit_differs_by_direction_and_the_raw_limit_does_not() {
        // 1 MiB + 1 is over for the helper and fine (so, merely cut short) for the app.
        let rest = (MIN_REST as usize + MAX_JSON_HELPER_TO_APP + 1) as u32;
        let mut hdr = rest.to_be_bytes().to_vec();
        hdr.extend_from_slice(&[KIND_JSON, 0, 0, 0, 0]);
        assert_eq!(decode(&hdr, Direction::HelperToApp).unwrap_err().code(), CODE_BAD_FRAME);
        assert_eq!(decode(&hdr, Direction::AppToHelper).unwrap_err().code(), CODE_IO);
        // Raw over 64 KiB is refused both ways, on the header alone.
        let rest = (MIN_REST as usize + MAX_RAW + 1) as u32;
        let mut hdr = rest.to_be_bytes().to_vec();
        hdr.extend_from_slice(&[KIND_RAW, 0, 0, 0, 0]);
        assert_eq!(decode(&hdr, Direction::HelperToApp).unwrap_err().code(), CODE_BAD_FRAME);
        assert_eq!(decode(&hdr, Direction::AppToHelper).unwrap_err().code(), CODE_BAD_FRAME);
    }

    #[test]
    fn the_sender_is_held_to_the_same_limits() {
        assert!(encode(&Frame::raw(0, vec![0; MAX_RAW]), Direction::HelperToApp).is_ok());
        assert!(encode(&Frame::raw(0, vec![0; MAX_RAW + 1]), Direction::HelperToApp).is_err());
        let big = Value::str(&"x".repeat(MAX_JSON_HELPER_TO_APP));
        assert!(encode(&Frame::json(0, big.clone()), Direction::HelperToApp).is_err());
        assert!(encode(&Frame::json(0, big), Direction::AppToHelper).is_ok());
    }

    #[test]
    fn unknown_kinds_and_bad_json_are_bad_frames() {
        let unknown = [0, 0, 0, 5, 2, 0, 0, 0, 0];
        assert_eq!(decode(&unknown, Direction::AppToHelper).unwrap_err().code(), CODE_BAD_FRAME);
        let mut bad = vec![0, 0, 0, 10, KIND_JSON, 0, 0, 0, 0];
        bad.extend_from_slice(b"{\"t\":");
        assert_eq!(decode(&bad, Direction::AppToHelper).unwrap_err().code(), CODE_BAD_FRAME);
    }

    #[test]
    fn bytes_after_a_frame_are_refused_by_decode_but_read_in_order_by_the_stream_reader() {
        let one = encode(&ping(), Direction::AppToHelper).unwrap();
        let two = [one.clone(), one.clone()].concat();
        assert_eq!(decode(&two, Direction::AppToHelper).unwrap_err().code(), CODE_BAD_FRAME);
        let mut stream = io::Cursor::new(two);
        assert!(read_frame(&mut stream, Direction::AppToHelper).unwrap().is_some());
        assert!(read_frame(&mut stream, Direction::AppToHelper).unwrap().is_some());
        assert!(read_frame(&mut stream, Direction::AppToHelper).unwrap().is_none());
    }
}
