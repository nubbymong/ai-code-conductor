//! The session helper's library: the pieces `main.rs` and the tests share.
//!
//! Nothing here opens a network socket: the helper's transport is local only
//! (a socket in the session folder or a named pipe, a later slice), and CI
//! fails if the standard library's networking module is used anywhere in
//! `src/` (threat model 3.10).
#![deny(unsafe_code)]

pub mod cmdline;
pub mod detach;
pub mod dirhold;
pub mod frame;
pub mod hello;
pub mod holder;
pub mod json;
pub mod pty;
pub mod ring;
pub mod selftest;

/// The helper's version, from Cargo.toml.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
