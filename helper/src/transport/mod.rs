//! The holder's local transport (protocol section 15): one endpoint per
//! holder, that only the user who started it can reach. No network socket,
//! loopback included, is ever opened (threat model 3.10).
//!
//! - **Windows**: a named pipe `\\.\pipe\aicc-helper-<sid>-<32 hex>`. Its
//!   security descriptor allows the current user alone (`D:P(A;;GA;;;<SID>)`),
//!   it refuses remote clients, and the first instance is made with
//!   `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a name someone else already made is
//!   never joined.
//! - **macOS and Linux**: a Unix socket `/tmp/aicc-<uid>/<sid>-<16 hex>.sock`.
//!   The folder is 0700 and must be a real folder owned by the user, the socket
//!   0600, and every connection's peer user id must be the user's.
//!
//! Both give the same `Listener` and `Stream` shape: `accept` returns a
//! connection that already passed the checks, a `Stream` reads and writes
//! bytes, can be cloned for a second thread, takes a read timeout, writes
//! with a time limit of `WRITE_TIMEOUT`, and `shutdown` from any clone wakes a
//! blocked reader.

use std::time::Duration;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::{connect, peer_allowed, prepare_run_dir, remove_stale_endpoint, run_dir, Listener, Stream};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{connect, remove_stale_endpoint, Listener, Stream};

/// A write that has not completed in this time fails, and the connection is
/// dropped: a client that stops reading cannot stall the holder.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a connection the holder closes stays open after its last write,
/// so the peer can read that last message before the connection is cut.
pub const LINGER: Duration = Duration::from_secs(2);

/// Hex characters of randomness in an endpoint name.
#[cfg(windows)]
pub const ENDPOINT_RANDOM_HEX: usize = 32;
#[cfg(unix)]
pub const ENDPOINT_RANDOM_HEX: usize = 16;

/// The endpoint a holder for `sid` listens on, with `random` as its random part.
pub fn endpoint_name(sid: &str, random: &str) -> String {
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\aicc-helper-{sid}-{random}")
    }
    #[cfg(unix)]
    {
        format!("{}/{sid}-{random}.sock", run_dir().display())
    }
}

fn lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// True when `endpoint` has the exact shape a holder for `sid` uses on this
/// OS. On Unix the folder may name any user id; `connect` and list mode check
/// that it is this user's.
pub fn valid_endpoint(endpoint: &str, sid: &str) -> bool {
    if !crate::hello::valid_sid(sid) {
        return false;
    }
    #[cfg(windows)]
    {
        let prefix = format!(r"\\.\pipe\aicc-helper-{sid}-");
        match endpoint.strip_prefix(&prefix) {
            Some(random) => lower_hex(random, ENDPOINT_RANDOM_HEX),
            None => false,
        }
    }
    #[cfg(unix)]
    {
        let rest = match endpoint.strip_prefix("/tmp/aicc-") {
            Some(r) => r,
            None => return false,
        };
        let (uid, file) = match rest.split_once('/') {
            Some(parts) => parts,
            None => return false,
        };
        if uid.is_empty() || uid.len() > 10 || !uid.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        let random = match file.strip_prefix(sid).and_then(|r| r.strip_prefix('-')).and_then(|r| r.strip_suffix(".sock")) {
            Some(r) => r,
            None => return false,
        };
        lower_hex(random, ENDPOINT_RANDOM_HEX)
    }
}

/// The error kinds that mean nothing listens on an endpoint: the holder is
/// gone (or never was). Anything else, a timeout included, proves nothing.
pub fn means_gone(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused)
}

/// True for the errors a read gives when its timeout passed.
pub fn is_timeout(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_names_have_the_documented_shape() {
        let random = "0123456789abcdef0123456789abcdef";
        let r = &random[..ENDPOINT_RANDOM_HEX];
        let name = endpoint_name("sess-0001", r);
        assert!(valid_endpoint(&name, "sess-0001"), "{name}");
        assert!(!valid_endpoint(&name, "sess-0002"), "another session's endpoint");
        assert!(!valid_endpoint(&name.to_uppercase(), "sess-0001"));
        assert!(!valid_endpoint(&endpoint_name("sess-0001", &r[1..]), "sess-0001"), "a short random part");
        assert!(!valid_endpoint(&name, "bad"), "a session id that breaks its pattern");
        #[cfg(windows)]
        {
            assert_eq!(name, format!(r"\\.\pipe\aicc-helper-sess-0001-{r}"));
            assert!(!valid_endpoint(&format!(r"\\server\pipe\aicc-helper-sess-0001-{r}"), "sess-0001"), "a remote pipe");
        }
        #[cfg(unix)]
        {
            assert!(name.starts_with("/tmp/aicc-") && name.ends_with(&format!("/sess-0001-{r}.sock")));
            // At most 75 bytes (a 10-digit user id and a 32-character session
            // id), under the 104 a socket path may have on macOS.
            assert!(endpoint_name(&"a".repeat(32), r).len() <= 75);
            assert!(!valid_endpoint(&format!("/tmp/aicc-x/sess-0001-{r}.sock"), "sess-0001"));
            assert!(!valid_endpoint(&format!("/var/tmp/aicc-501/sess-0001-{r}.sock"), "sess-0001"));
        }
    }
}
