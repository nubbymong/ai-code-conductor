//! One pseudo-terminal with one child on it, the same shape on every OS:
//! `openpty` and a child on the slave on Unix, ConPTY on Windows. The helper
//! uses it to hold the CLI's terminal (protocol section 5).
//!
//! `spawn` returns the terminal and a reader for what the child writes. On Unix
//! the reader ends when the child and everything it started have closed the
//! terminal. On Windows it ends only when the terminal is dropped, so callers
//! watch the child with `try_wait` and do not rely on the reader's end.

use std::io;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::Pty;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::Pty;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
}

impl Default for PtySize {
    fn default() -> PtySize {
        PtySize { cols: 80, rows: 24 }
    }
}

pub(crate) fn check_argv(argv: &[String]) -> io::Result<()> {
    if argv.is_empty() || argv[0].is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "no program to run"));
    }
    Ok(())
}
