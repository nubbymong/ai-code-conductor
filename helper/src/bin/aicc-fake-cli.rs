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
//! spawn-own-group     ->  (Unix) the same, in a process group of its own
//!                         and deaf to hangups, as a shell job can be
//! flood <n>           ->  line 000001 .. line <n>, in one write, then
//!                         flood done
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
        } else if let Some(n) = text.strip_prefix("flood ") {
            let n: u32 = n.trim().parse().unwrap_or(0);
            let mut all = String::with_capacity(n as usize * 13 + 16);
            for i in 1..=n {
                all.push_str(&format!("line {i:06}\n"));
            }
            all.push_str("flood done");
            let _ = writeln!(out, "{all}");
        } else if text == "spawn-own-group" {
            match spawn_own_group() {
                Ok(pid) => {
                    let _ = writeln!(out, "grandchild: {pid}");
                }
                Err(e) => {
                    let _ = writeln!(out, "grandchild error: {e}");
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

/// A sleeping copy of this program in a process group of its own that ignores
/// hangups: `sh` sets the hangup to ignored, and an ignored signal stays
/// ignored across the `exec`. Its process id.
#[cfg(unix)]
fn spawn_own_group() -> io::Result<u32> {
    use std::os::unix::process::CommandExt;
    let exe = std::env::current_exe()?;
    let child = Command::new("/bin/sh")
        .arg("-c")
        .arg("trap '' HUP; exec \"$0\" --sleep 600")
        .arg(exe)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    // Not waited for: it is meant to outlive this line.
    Ok(child.id())
}

#[cfg(not(unix))]
fn spawn_own_group() -> io::Result<u32> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "process groups are a Unix idea; the job object holds every process on Windows"))
}
