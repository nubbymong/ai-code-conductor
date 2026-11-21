//! The session helper's library: the pieces `main.rs` and the tests share.
//!
//! Nothing here opens a network socket: the helper's transport is local only
//! (a named pipe on Windows, a Unix socket in a private folder elsewhere,
//! `transport/`), and CI fails if the standard library's networking module is
//! used anywhere in `src/` (threat model 3.10).
#![deny(unsafe_code)]

pub mod client;
pub mod cmdline;
pub mod consoles;
pub mod detach;
pub mod frame;
pub mod hello;
pub mod holder;
pub mod hook;
pub mod json;
pub mod pids;
pub mod pty;
pub mod random;
pub mod relay;
pub mod request;
pub mod ring;
pub mod screen;
pub mod selftest;
pub mod serve;
pub mod start;
pub mod store;
pub mod transport;
#[cfg(windows)]
mod winproc;

/// The helper's version, from Cargo.toml.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
