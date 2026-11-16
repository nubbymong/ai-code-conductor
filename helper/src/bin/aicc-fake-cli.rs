//! A stand-in for a provider CLI, for the helper's tests and probes only.
//!
//! It prints a banner, then answers each line it is given:
//!
//! ```text
//! FAKE-CLI READY
//! <line>              ->  echo: <line>
//! pwd                 ->  cwd: <its working folder>
//! env NAME            ->  env NAME=<value>, or env NAME unset
//! spawn-grandchild    ->  starts a copy of itself that sleeps, then
//!                         grandchild: <its process id>
//! quit                ->  FAKE-CLI BYE, exit 0
//! exit <n>            ->  exit with code n
//! ```
//!
//! Run as `aicc-fake-cli --sleep <seconds>` it prints nothing and sleeps: the
//! grandchild, so a test can show that ending a session ends it too.
//!
//! It is plain `std`, so the same binary builds on every OS. It never talks to
//! a network or a real provider.
#![deny(unsafe_code)]

use std::io::{self, BufRead, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--sleep") {
        let secs = args.get(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(600);
        std::thread::sleep(Duration::from_secs(secs));
        return;
    }
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
        if text == "pwd" {
            match std::env::current_dir() {
                Ok(dir) => {
                    let _ = writeln!(out, "cwd: {}", dir.display());
                }
                Err(e) => {
                    let _ = writeln!(out, "cwd error: {e}");
                }
            }
        } else if let Some(name) = text.strip_prefix("env ") {
            match std::env::var(name.trim()) {
                Ok(value) => {
                    let _ = writeln!(out, "env {}={value}", name.trim());
                }
                Err(_) => {
                    let _ = writeln!(out, "env {} unset", name.trim());
                }
            }
        } else if text == "spawn-grandchild" {
            let started = std::env::current_exe().and_then(|exe| {
                Command::new(exe).args(["--sleep", "600"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
            });
            match started {
                // Not waited for: it is meant to outlive this line.
                Ok(child) => {
                    let _ = writeln!(out, "grandchild: {}", child.id());
                }
                Err(e) => {
                    let _ = writeln!(out, "grandchild error: {e}");
                }
            }
        } else {
            let _ = writeln!(out, "echo: {text}");
        }
        let _ = out.flush();
    }
}
