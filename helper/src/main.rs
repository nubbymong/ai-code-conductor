//! `aicc-helper`: the skeleton's command line. Nothing starts this in the app
//! yet; the commands exist for the self-test, the tests and the probes.
//!
//! ```text
//! aicc-helper version
//! aicc-helper hello --nonce <32 hex> --session <sid> [--state <state>] [--sha256 <64 hex>]
//! aicc-helper selftest [--nonce <32 hex>]
//! aicc-helper hold --dir <folder> --session <sid> [--cols N] [--rows N] [--ring-bytes N] [--detach] -- <program> [args...]
//! aicc-helper attach --dir <folder> [--from <offset>] [--send <text>] [--wait-ms N]
//! aicc-helper end --dir <folder>
//! ```
#![deny(unsafe_code)]

use aicc_helper::dirhold::{self, HoldOptions, HOLDER_FILE};
use aicc_helper::hello::{self, Hello, CAPS};
use aicc_helper::json::Value;
use aicc_helper::pty::PtySize;
use aicc_helper::ring::DEFAULT_RING_BYTES;
use aicc_helper::{detach, selftest, VERSION};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

const USAGE: &str = "usage: aicc-helper <version | hello | selftest | hold | attach | end> [options]";

fn opt(args: &[String], name: &str) -> Option<String> {
    let at = args.iter().position(|a| a == name)?;
    args.get(at + 1).cloned()
}

fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn number<T: std::str::FromStr>(args: &[String], name: &str, default: T) -> Result<T, String> {
    match opt(args, name) {
        None => Ok(default),
        Some(text) => text.parse::<T>().map_err(|_| format!("{name} needs a number")),
    }
}

fn fail(msg: &str) -> ExitCode {
    eprintln!("aicc-helper: {msg}");
    ExitCode::from(1)
}

fn usage(msg: &str) -> ExitCode {
    eprintln!("aicc-helper: {msg}");
    eprintln!("{USAGE}");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match args.first() {
        Some(c) => c.as_str(),
        None => return usage("no command"),
    };
    let rest = &args[1..];
    match command {
        "version" => {
            println!("aicc-helper {VERSION}");
            ExitCode::SUCCESS
        }
        "hello" => cmd_hello(rest),
        "selftest" => cmd_selftest(rest),
        "hold" => cmd_hold(rest),
        "attach" => cmd_attach(rest),
        "end" => cmd_end(rest),
        // The child the self-test holds on a terminal; not a public command.
        "__echo" => match selftest::echo_child() {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => fail(&e.to_string()),
        },
        _ => usage(&format!("unknown command {command}")),
    }
}

fn cmd_hello(args: &[String]) -> ExitCode {
    let nonce = match opt(args, "--nonce") {
        Some(n) => n,
        None => return usage("hello needs --nonce"),
    };
    let sid = match opt(args, "--session") {
        Some(s) => s,
        None => return usage("hello needs --session"),
    };
    let state = opt(args, "--state").unwrap_or_else(|| "new".to_string());
    let sha = opt(args, "--sha256");
    let h = Hello {
        nonce: &nonce,
        helper_version: VERSION,
        sha256: sha.as_deref(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        caps: &CAPS,
        sid: &sid,
        state: &state,
    };
    match hello::hello_line(&h) {
        Ok(line) => {
            println!("{line}");
            ExitCode::SUCCESS
        }
        Err(e) => fail(&format!("{}: {}", e.code, e.why)),
    }
}

fn cmd_selftest(args: &[String]) -> ExitCode {
    let nonce = opt(args, "--nonce").unwrap_or_else(|| "0".repeat(32));
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return fail(&format!("cannot find this program: {e}")),
    };
    let checks = selftest::run(&exe);
    let body = selftest::report(&checks);
    match hello::result_line(&nonce, &body) {
        Ok(line) => println!("{line}"),
        Err(e) => return fail(&format!("{}: {}", e.code, e.why)),
    }
    if checks.iter().all(|c| c.ok) {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn cmd_hold(args: &[String]) -> ExitCode {
    let split = args.iter().position(|a| a == "--");
    let (own, program) = match split {
        Some(i) => (&args[..i], args[i + 1..].to_vec()),
        None => return usage("hold needs -- <program> [args...]"),
    };
    if program.is_empty() {
        return usage("hold needs a program after --");
    }
    let dir = match opt(own, "--dir") {
        Some(d) => PathBuf::from(d),
        None => return usage("hold needs --dir"),
    };
    let sid = match opt(own, "--session") {
        Some(s) => s,
        None => return usage("hold needs --session"),
    };
    let cols = match number::<u16>(own, "--cols", 80) {
        Ok(v) => v,
        Err(e) => return usage(&e),
    };
    let rows = match number::<u16>(own, "--rows", 24) {
        Ok(v) => v,
        Err(e) => return usage(&e),
    };
    let ring_bytes = match number::<usize>(own, "--ring-bytes", DEFAULT_RING_BYTES) {
        Ok(v) => v,
        Err(e) => return usage(&e),
    };

    if flag(own, "--detach") {
        // Start this same command again, detached, and report once it is up.
        let exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(e) => return fail(&format!("cannot find this program: {e}")),
        };
        let mut again: Vec<String> = vec!["hold".to_string()];
        again.extend(own.iter().filter(|a| a.as_str() != "--detach").cloned());
        again.push("--".to_string());
        again.extend(program);
        let _ = std::fs::remove_file(dir.join(HOLDER_FILE));
        let started = match detach::spawn_detached(&exe, &again) {
            Ok(pid) => pid,
            Err(e) => return fail(&format!("could not start the holder: {e}")),
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(dir.join(HOLDER_FILE)) {
                println!("{text}");
                return ExitCode::SUCCESS;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        return fail(&format!("the holder (process {started}) did not write {HOLDER_FILE} in 15 seconds"));
    }

    let opts = HoldOptions { dir, sid, argv: program, size: PtySize { cols, rows }, ring_bytes };
    match dirhold::run_hold(opts) {
        Ok(code) => ExitCode::from(code as u8),
        Err(e) => fail(&format!("hold failed: {e}")),
    }
}

fn cmd_attach(args: &[String]) -> ExitCode {
    let dir = match opt(args, "--dir") {
        Some(d) => PathBuf::from(d),
        None => return usage("attach needs --dir"),
    };
    let from = match number::<u64>(args, "--from", 0) {
        Ok(v) => v,
        Err(e) => return usage(&e),
    };
    let wait_ms = match number::<u64>(args, "--wait-ms", 0) {
        Ok(v) => v,
        Err(e) => return usage(&e),
    };
    let send = opt(args, "--send");
    match dirhold::run_attach(&dir, from, send.as_deref(), wait_ms) {
        Ok(report) => {
            let body: Value = report.to_value();
            println!("{}", body.to_json());
            ExitCode::SUCCESS
        }
        Err(e) => fail(&format!("attach failed: {e}")),
    }
}

fn cmd_end(args: &[String]) -> ExitCode {
    let dir = match opt(args, "--dir") {
        Some(d) => PathBuf::from(d),
        None => return usage("end needs --dir"),
    };
    match dirhold::run_end(&dir) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => fail("the holder did not finish in time"),
        Err(e) => fail(&format!("end failed: {e}")),
    }
}
