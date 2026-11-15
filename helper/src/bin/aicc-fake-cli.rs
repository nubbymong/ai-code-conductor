//! A stand-in for a provider CLI, for the helper's tests and probes only.
//!
//! It prints a banner, then answers each line it is given:
//!
//! ```text
//! FAKE-CLI READY
//! <line>        ->  echo: <line>
//! quit          ->  FAKE-CLI BYE, exit 0
//! exit <n>      ->  exit with code n
//! ```
//!
//! It is plain `std`, so the same binary builds on every OS. It never talks to
//! a network or a real provider.
#![deny(unsafe_code)]

use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let _ = writeln!(out, "FAKE-CLI READY");
    let _ = out.flush();
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.lock().read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let text = line.trim_end_matches(|c| c == '\r' || c == '\n');
        if text == "quit" {
            let _ = writeln!(out, "FAKE-CLI BYE");
            let _ = out.flush();
            return;
        }
        if let Some(code) = text.strip_prefix("exit ") {
            let _ = out.flush();
            std::process::exit(code.trim().parse::<i32>().unwrap_or(1));
        }
        let _ = writeln!(out, "echo: {text}");
        let _ = out.flush();
    }
}
