//! The output ring: the last `capacity` bytes the held terminal wrote, each at
//! a fixed offset, so an app that detached can attach again from the offset it
//! saw last and be replayed what it missed (protocol sections 8 and 11:
//! `session.attach` answers `ring_start` and `ring_end`; the terminal reattach
//! runs `attach --from <offset>`). The protocol's ring is 2 MiB.

use std::collections::VecDeque;

/// The protocol's output ring size.
pub const DEFAULT_RING_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RingError {
    /// The offset asked for is past the end: bytes that were never written.
    PastEnd { ring_end: u64 },
}

/// What a replay from an offset holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replay {
    /// The offset the bytes start at: the asked offset, or `ring_start` when
    /// the ring no longer holds that far back.
    pub from: u64,
    pub ring_start: u64,
    pub ring_end: u64,
    /// The offset asked for was older than the ring: the app missed bytes and
    /// must say so ("a too-short ring is reported").
    pub truncated: bool,
    pub bytes: Vec<u8>,
}

pub struct Ring {
    capacity: usize,
    buf: VecDeque<u8>,
    /// The offset of the first byte held; the bytes before it have been dropped.
    start: u64,
}

impl Ring {
    pub fn new(capacity: usize) -> Ring {
        Ring { capacity: capacity.max(1), buf: VecDeque::new(), start: 0 }
    }

    pub fn ring_start(&self) -> u64 {
        self.start
    }

    pub fn ring_end(&self) -> u64 {
        self.start + self.buf.len() as u64
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Append output; the oldest bytes fall off the front past `capacity`.
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend(bytes.iter().copied());
        if self.buf.len() > self.capacity {
            let excess = self.buf.len() - self.capacity;
            self.buf.drain(..excess);
            self.start += excess as u64;
        }
    }

    /// Everything from `from` to the end. An offset before `ring_start` is
    /// answered from `ring_start` with `truncated` set; one past the end is an
    /// error. `from == ring_end` is an empty replay.
    pub fn replay_from(&self, from: u64) -> Result<Replay, RingError> {
        let ring_start = self.ring_start();
        let ring_end = self.ring_end();
        if from > ring_end {
            return Err(RingError::PastEnd { ring_end });
        }
        let (from, truncated) = if from < ring_start { (ring_start, true) } else { (from, false) };
        let skip = (from - ring_start) as usize;
        let bytes: Vec<u8> = self.buf.iter().skip(skip).copied().collect();
        Ok(Replay { from, ring_start, ring_end, truncated, bytes })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_count_every_byte_ever_written() {
        let mut r = Ring::new(8);
        assert_eq!((r.ring_start(), r.ring_end()), (0, 0));
        r.push(b"abc");
        r.push(b"de");
        assert_eq!((r.ring_start(), r.ring_end()), (0, 5));
        let rp = r.replay_from(2).unwrap();
        assert_eq!(rp.bytes, b"cde");
        assert!(!rp.truncated);
        assert_eq!(rp.from, 2);
    }

    #[test]
    fn the_oldest_bytes_fall_off_and_the_start_moves_with_them() {
        let mut r = Ring::new(4);
        r.push(b"abcdef");
        assert_eq!((r.ring_start(), r.ring_end(), r.len()), (2, 6, 4));
        let rp = r.replay_from(0).unwrap();
        assert!(rp.truncated, "an offset older than the ring is reported");
        assert_eq!((rp.from, rp.bytes), (2, b"cdef".to_vec()));
        assert_eq!(r.replay_from(3).unwrap().bytes, b"def");
        assert!(!r.replay_from(3).unwrap().truncated);
    }

    #[test]
    fn the_end_is_an_empty_replay_and_past_it_is_an_error() {
        let mut r = Ring::new(4);
        r.push(b"abc");
        let rp = r.replay_from(3).unwrap();
        assert!(rp.bytes.is_empty() && !rp.truncated);
        assert_eq!(r.replay_from(4), Err(RingError::PastEnd { ring_end: 3 }));
    }

    #[test]
    fn one_big_write_keeps_only_the_tail() {
        let mut r = Ring::new(3);
        r.push(b"0123456789");
        assert_eq!((r.ring_start(), r.ring_end()), (7, 10));
        assert_eq!(r.replay_from(7).unwrap().bytes, b"789");
    }
}
