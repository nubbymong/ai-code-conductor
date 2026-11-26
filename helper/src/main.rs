//! `aicc-helper`: the session helper's command line. The app runs it
//! (`src/main/session-helper/`, and on Windows its `start`, `end`,
//! `console-hosts` and `end-console-host` modes), a held session's CLI runs
//! `hook`, `status` and `mcp`, and the tests run every command. On Windows
//! the app also runs `capture` for Snap (`src/main/snap/`).
//!
//! ```text
//! aicc-helper version
//! aicc-helper hello --nonce <32 hex> --session <sid> [--state <state>] [--sha256 <64 hex>]
//! aicc-helper selftest [--nonce <32 hex>]
//! aicc-helper hold --store <folder> --session <sid> [--label <text>] [--away <seconds> | --until-ended] [--ring-bytes N] [--detach]
//! aicc-helper list --store <folder>
//! aicc-helper field --file <path under home> --key <dotted key>     (macOS and Linux)
//! aicc-helper hook [--store <folder>] [--session <sid>]      (each left out: AICC_HELPER_STORE, AICC_HELPER_SESSION)
//! aicc-helper status [--store <folder>] [--session <sid>]    (the same)
//! aicc-helper mcp --store <folder> --session <sid>
//! aicc-helper bridge --store <folder> --session <sid>                (macOS and Linux only)
//! aicc-helper start [--hide] --cwd <folder> -- <program> [args...]   (Windows only)
//! aicc-helper end --pid <n> --created <t>                            (Windows only)
//! aicc-helper console-hosts [--pid <n> --created <t>]                (Windows only)
//! aicc-helper end-console-host --made-from <t> --made-to <t>         (Windows only)
//! aicc-helper capture --out <folder>                                 (Windows only)
//! ```
//!
//! `hold` runs one holder (protocol section 15). With `--detach` it starts the
//! holder as a process of its own, in the store folder, waits until it has
//! written its record, prints that record as one JSON line and exits. `hold`
//! exits 3 when a holder for the session is already running, with or without
//! `--detach`. With `--until-ended` (from 2.1.3-beta.19; not with `--away`)
//! the holder has no away clock: it ends with its program, at `term.end`, or
//! with the machine, and its record says so (`"away":null`,
//! `"lifetime":"until-ended"`, `store.rs`). `list` prints every session in
//! the store as one JSON line, removing the records of holders that are
//! gone. `field` prints one string from a JSON file in the user's home
//! folder, or nothing, and exits 0 (`field.rs`). `hook` passes one hook
//! event, read from standard input, to the session's holder; it always exits
//! 0 and prints nothing (`hook.rs`). `status` passes one status line update,
//! read from standard input, to the session's holder, the same way: it
//! always exits 0, within 2 s, and prints nothing (`status.rs`). Either
//! takes the store and the session from `AICC_HELPER_STORE` and
//! `AICC_HELPER_SESSION` when its options leave them out. `mcp` relays a session's tool server
//! through its holder: standard output carries only the messages, and it
//! exits 0 only when its standard input ended (`relay.rs`). `bridge` carries
//! one connection to a session's holder over its standard input and output,
//! byte for byte, as the app reaches a holder on another machine through
//! `ssh -T`: it exits 0 when the holder closes the connection, 3 with no
//! holder for the session, 2 on a usage error, and 1 otherwise and on Windows
//! (`bridge.rs`).
#![deny(unsafe_code)]

use aicc_helper::hello::{self, Hello, CAPS};
use aicc_helper::ring::DEFAULT_RING_BYTES;
use aicc_helper::serve::{self, Options};
use aicc_helper::store::{self, Lifetime, DEFAULT_AWAY_SECS, MAX_AWAY_SECS};
use aicc_helper::{client, detach, field, hook, relay, selftest, status, VERSION};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc;
use std::time::{Duration, Instant};

const USAGE: &str = "usage: aicc-helper <version | hello | selftest | hold | list | field | hook | status | mcp | bridge | start | end | console-hosts | end-console-host | capture> [options]";
/// The ring is 1 KiB to 64 MiB; the protocol's default is 2 MiB.
const MIN_RING_BYTES: usize = 1024;
const MAX_RING_BYTES: usize = 64 * 1024 * 1024;
/// How long `hold --detach` waits for the holder's record.
const DETACH_WAIT: Duration = Duration::from_secs(15);
/// `hold`'s exit status when a holder for the session is already running.
const EXIT_ALREADY_RUNNING: u8 = 3;
/// The most of a failed holder's message `hold --detach` passes on.
const MAX_HOLDER_MESSAGE: u64 = 4096;
/// `__close-check`'s exit status when this system does not have the way named.
#[cfg(unix)]
const EXIT_NO_SUCH_WAY: u8 = 4;

/// Options as given: each known option once, nothing unknown.
struct Args {
    values: Vec<(String, String)>,
    flags: Vec<String>,
}

impl Args {
    fn parse(args: &[String], with_value: &[&str], flags: &[&str]) -> Result<Args, String> {
        let mut out = Args { values: Vec::new(), flags: Vec::new() };
        let mut i = 0;
        while i < args.len() {
            let a = args[i].as_str();
            if with_value.contains(&a) {
                let v = args.get(i + 1).ok_or(format!("{a} needs a value"))?;
                if out.get(a).is_some() {
                    return Err(format!("{a} is given twice"));
                }
                out.values.push((a.to_string(), v.clone()));
                i += 2;
            } else if flags.contains(&a) {
                if out.flag(a) {
                    return Err(format!("{a} is given twice"));
                }
                out.flags.push(a.to_string());
                i += 1;
            } else {
                return Err(format!("unknown option {a}"));
            }
        }
        Ok(out)
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.values.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|f| f == name)
    }

    fn number<T: std::str::FromStr>(&self, name: &str, default: T) -> Result<T, String> {
        match self.get(name) {
            None => Ok(default),
            Some(text) => text.parse::<T>().map_err(|_| format!("{name} needs a whole number")),
        }
    }
}

// `fail` and `usage` write with writeln!, not eprintln!: eprintln! panics
// when standard error is closed (a bridge whose ssh link dropped, for one),
// and the exit status would be 101, not the command's own.
fn fail(msg: &str) -> ExitCode {
    let _ = writeln!(std::io::stderr(), "aicc-helper: {msg}");
    ExitCode::from(1)
}

fn usage(msg: &str) -> ExitCode {
    let _ = writeln!(std::io::stderr(), "aicc-helper: {msg}\n{USAGE}");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    // The hook mode first, from the raw arguments: `args()` panics on one
    // that is not Unicode, and the hook mode must never print or fail.
    let raw: Vec<OsString> = std::env::args_os().skip(1).collect();
    if raw.first().map_or(false, |c| c.as_os_str() == "hook") {
        return cmd_hook(&raw[1..]);
    }
    // The status mode the same way: it never prints or fails either.
    if raw.first().map_or(false, |c| c.as_os_str() == "status") {
        return cmd_status(&raw[1..]);
    }
    // The relay too: its standard output is the CLI's, for messages only.
    if raw.first().map_or(false, |c| c.as_os_str() == "mcp") {
        return cmd_mcp(&raw[1..]);
    }
    // The bridge too: an argument that is not Unicode is a usage error (2),
    // never a panic.
    if raw.first().map_or(false, |c| c.as_os_str() == "bridge") {
        return cmd_bridge(&raw[1..]);
    }
    // The field mode too (one string from a JSON file in the user's home
    // folder, field.rs): an argument that is not Unicode is a usage error
    // (2), never a panic.
    if raw.first().map_or(false, |c| c.as_os_str() == "field") {
        return cmd_field(&raw[1..]);
    }
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
        "list" => cmd_list(rest),
        // Start one program that keeps none of this process's handles (Windows).
        "start" => aicc_helper::start::command(rest),
        // End what `start` started, only while its pid has its creation time (Windows).
        "end" => aicc_helper::start::end_command(rest),
        // At the app's start, end the console hosts the run before left when
        // it was ended from outside (Windows, consoles.rs).
        "console-hosts" => aicc_helper::consoles::command(rest),
        // While the app runs, end the console host of each of its terminals
        // whose program has ended, among those started in the time it is given
        // (Windows, consoles.rs).
        "end-console-host" => aicc_helper::consoles::end_command(rest),
        // One picture of each display, for Snap (Windows; capture.rs). The
        // app runs it for the new Snap, the Windows default (src/main/snap/).
        "capture" => aicc_helper::capture::command(rest),
        // A run with one terminal, as the app has for a tab, for the tests of
        // console-hosts (Windows); not a public command.
        "__console-parent" => aicc_helper::consoles::console_parent(),
        // The child the self-test holds on a terminal; not a public command.
        "__echo" => match selftest::echo_child() {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => fail(&e.to_string()),
        },
        // `hold`'s first step on macOS and Linux, one named way, for the
        // tests (`detach.rs`); not a public command.
        #[cfg(unix)]
        "__close-check" => cmd_close_check(rest),
        _ => usage(&format!("unknown command {command}")),
    }
}

fn cmd_hello(args: &[String]) -> ExitCode {
    let a = match Args::parse(args, &["--nonce", "--session", "--state", "--sha256"], &[]) {
        Ok(a) => a,
        Err(e) => return usage(&e),
    };
    let nonce = match a.get("--nonce") {
        Some(n) => n,
        None => return usage("hello needs --nonce"),
    };
    let sid = match a.get("--session") {
        Some(s) => s,
        None => return usage("hello needs --session"),
    };
    let h = Hello {
        nonce,
        helper_version: VERSION,
        sha256: a.get("--sha256"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        caps: &CAPS,
        sid,
        state: a.get("--state").unwrap_or("new"),
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
    let a = match Args::parse(args, &["--nonce"], &[]) {
        Ok(a) => a,
        Err(e) => return usage(&e),
    };
    let nonce = a.get("--nonce").map(str::to_string).unwrap_or_else(|| "0".repeat(32));
    // Before the self-test starts anything: see `end_children_with_this_process`.
    #[cfg(windows)]
    end_children_with_selftest();
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

/// The self-test's terminal host (`conhost.exe`) is its child, and outlived
/// it when it ended, or was ended, before it closed its terminal
/// (aicc_planning#317). In a job that ends with the self-test, everything it
/// starts ends with it. The self-test still runs when the job cannot be made;
/// the note goes to standard error, which the app keeps in its log and never
/// reads as the result.
#[cfg(windows)]
fn end_children_with_selftest() {
    if let Err(e) = aicc_helper::pty::end_children_with_this_process() {
        eprintln!("aicc-helper: note: what the self-test starts may outlive it: {e}");
    }
}

fn cmd_hold(args: &[String]) -> ExitCode {
    let a = match Args::parse(args, &["--store", "--session", "--label", "--away", "--ring-bytes"], &["--detach", "--until-ended"]) {
        Ok(a) => a,
        Err(e) => return usage(&e),
    };
    let store_dir = match a.get("--store") {
        Some(s) if !s.is_empty() => PathBuf::from(s),
        _ => return usage("hold needs --store"),
    };
    let sid = match a.get("--session") {
        Some(s) if hello::valid_sid(s) => s.to_string(),
        Some(_) => return usage("--session breaks the session id pattern"),
        None => return usage("hold needs --session"),
    };
    let label = a.get("--label").unwrap_or("").to_string();
    if !store::valid_label(&label) {
        return usage("--label is over 128 characters or holds a control character");
    }
    let lifetime = if a.flag("--until-ended") {
        if a.get("--away").is_some() {
            return usage("--until-ended and --away cannot be given together");
        }
        Lifetime::UntilEnded
    } else {
        match a.number::<u64>("--away", DEFAULT_AWAY_SECS) {
            Ok(v) if (1..=MAX_AWAY_SECS).contains(&v) => Lifetime::Away(v),
            Ok(_) => return usage("--away must be 1 to 86400 seconds"),
            Err(e) => return usage(&e),
        }
    };
    let ring_bytes = match a.number::<usize>("--ring-bytes", DEFAULT_RING_BYTES) {
        Ok(v) if (MIN_RING_BYTES..=MAX_RING_BYTES).contains(&v) => v,
        Ok(_) => return usage("--ring-bytes must be 1 KiB to 64 MiB"),
        Err(e) => return usage(&e),
    };

    if a.flag("--detach") {
        return detached(&store_dir, &sid, &label, lifetime, ring_bytes);
    }
    // The holder runs for as long as its session, so it keeps nothing open
    // that was handed down to it. On Windows its starter hands it nothing
    // but its standard error (`detach.rs`).
    #[cfg(unix)]
    detach::close_inherited_descriptors();
    let opts = Options { store: store_dir, sid, label, lifetime, ring_bytes };
    match serve::run(opts) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) if serve::already_running(&e) => {
            eprintln!("aicc-helper: hold failed: {e}");
            ExitCode::from(EXIT_ALREADY_RUNNING)
        }
        Err(e) => fail(&format!("hold failed: {e}")),
    }
}

/// Start the same holder as a process of its own and report it once its
/// record is written.
fn detached(store_dir: &Path, sid: &str, label: &str, lifetime: Lifetime, ring_bytes: usize) -> ExitCode {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return fail(&format!("cannot find this program: {e}")),
    };
    // The holder runs in the store folder, so it keeps no folder of the
    // caller's open; it is named by its full path, which reads the same from
    // there.
    let store_dir = match std::path::absolute(store_dir) {
        Ok(p) => p,
        Err(e) => return fail(&format!("cannot find the store {}: {e}", store_dir.display())),
    };
    if let Err(e) = store::prepare(&store_dir) {
        return fail(&format!("the store {} cannot be used: {e}", store_dir.display()));
    }
    let mut again: Vec<String> = vec![
        "hold".to_string(),
        "--store".to_string(),
        store_dir.to_string_lossy().into_owned(),
        "--session".to_string(),
        sid.to_string(),
        "--label".to_string(),
        label.to_string(),
    ];
    match lifetime {
        Lifetime::Away(secs) => {
            again.push("--away".to_string());
            again.push(secs.to_string());
        }
        Lifetime::UntilEnded => again.push("--until-ended".to_string()),
    }
    again.push("--ring-bytes".to_string());
    again.push(ring_bytes.to_string());
    // No other thread of this process starts a child while this runs, as
    // `spawn_detached` needs on Windows: the reader below starts after it.
    let started = match detach::spawn_detached(&exe, &again, &store_dir) {
        Ok(d) => d,
        Err(e) => return fail(&format!("could not start the holder: {e}")),
    };
    if started.in_starters_job {
        eprintln!("aicc-helper: note: this process's job does not let a process leave it, so the holder runs inside the job and ends when the job does");
    }
    let mut child = started.child;
    // What the holder says before it is ready: why it failed, if it does.
    let (said_tx, said) = mpsc::channel();
    if let Some(stderr) = child.stderr.take() {
        let read = std::thread::Builder::new().spawn(move || {
            let mut text = Vec::new();
            let _ = stderr.take(MAX_HOLDER_MESSAGE).read_to_end(&mut text);
            let _ = said_tx.send(text);
        });
        // Without a reader the failure is still reported, only without the
        // holder's own words.
        drop(read);
    }
    let pid = child.id();
    let deadline = Instant::now() + DETACH_WAIT;
    while Instant::now() < deadline {
        if let Some(Ok(rec)) = store::read(&store_dir, sid) {
            if rec.pid == pid {
                println!("{}", rec.to_json());
                return ExitCode::SUCCESS;
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            let text = said.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
            let text = String::from_utf8_lossy(&text);
            let why = text.trim();
            let why = if why.is_empty() { String::new() } else { format!(": {why}") };
            eprintln!("aicc-helper: the holder (process {pid}) exited before it was ready ({status}){why}");
            return if status.code() == Some(i32::from(EXIT_ALREADY_RUNNING)) { ExitCode::from(EXIT_ALREADY_RUNNING) } else { ExitCode::from(1) };
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    fail(&format!("the holder (process {pid}) did not write its record in 15 seconds"))
}

/// Close every descriptor from 3 up the way named (`best` is the holder's
/// own order), say `closed` on stdout, then wait for standard input to end,
/// so a test can see what this process still holds while it runs. Exits
/// `EXIT_NO_SUCH_WAY` when this system does not have that way.
#[cfg(unix)]
fn cmd_close_check(args: &[String]) -> ExitCode {
    let name = match args {
        [name] => name.as_str(),
        _ => return usage("__close-check needs one way"),
    };
    if name == "best" {
        detach::close_inherited_descriptors();
    } else {
        let way = match detach::CloseWay::named(name) {
            Some(way) => way,
            None => return usage(&format!("unknown way {name}")),
        };
        if !detach::close_descriptors(way) {
            eprintln!("aicc-helper: this system cannot close descriptors the {name} way");
            return ExitCode::from(EXIT_NO_SUCH_WAY);
        }
    }
    println!("closed");
    let _ = std::io::Write::flush(&mut std::io::stdout());
    let _ = std::io::stdin().read_to_end(&mut Vec::new());
    ExitCode::SUCCESS
}

/// Claude Code's command hook: whatever happens, exit 0 and print nothing,
/// a panic included (Claude Code reads a hook's output and exit code). An
/// argument that is not Unicode loses the event, as any other bad argument.
fn cmd_hook(raw: &[OsString]) -> ExitCode {
    std::panic::set_hook(Box::new(|_| {}));
    let args: Option<Vec<String>> = raw.iter().map(|a| a.to_str().map(str::to_string)).collect();
    if let Some(args) = args {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| hook::run(&args)));
    }
    ExitCode::SUCCESS
}

/// A CLI's status line command: whatever happens, exit 0 and print nothing,
/// a panic included (what a status line command prints is the CLI's status
/// line). An argument that is not Unicode loses the update.
fn cmd_status(raw: &[OsString]) -> ExitCode {
    std::panic::set_hook(Box::new(|_| {}));
    let args: Option<Vec<String>> = raw.iter().map(|a| a.to_str().map(str::to_string)).collect();
    if let Some(args) = args {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| status::run(&args)));
    }
    ExitCode::SUCCESS
}

/// A session's tool relay, as a CLI starts its tool server: it prints only
/// the messages it carries, never a word of its own (a panic included), and
/// exits 0 only when its standard input ended. An argument that is not
/// Unicode is a command line it does not take: exit 1.
fn cmd_mcp(raw: &[OsString]) -> ExitCode {
    std::panic::set_hook(Box::new(|_| {}));
    let args: Option<Vec<String>> = raw.iter().map(|a| a.to_str().map(str::to_string)).collect();
    let code = match args {
        Some(args) => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| relay::run(&args))).unwrap_or(relay::EXIT_FAILED),
        None => relay::EXIT_FAILED,
    };
    ExitCode::from(code)
}

/// The bridge (macOS and Linux): exit 2 on a command line it does not take,
/// an argument that is not Unicode included; on Windows it does not run, and
/// exits 1 whatever it is given.
#[cfg(unix)]
fn cmd_bridge(raw: &[OsString]) -> ExitCode {
    let args: Vec<String> = match raw.iter().map(|a| a.to_str().map(str::to_string)).collect::<Option<Vec<String>>>() {
        Some(args) => args,
        None => return usage("bridge takes Unicode arguments only"),
    };
    let a = match Args::parse(&args, &["--store", "--session"], &[]) {
        Ok(a) => a,
        Err(e) => return usage(&e),
    };
    let store_dir = match a.get("--store") {
        Some(s) if !s.is_empty() => PathBuf::from(s),
        _ => return usage("bridge needs --store"),
    };
    let sid = match a.get("--session") {
        Some(s) if hello::valid_sid(s) => s,
        Some(_) => return usage("--session breaks the session id pattern"),
        None => return usage("bridge needs --session"),
    };
    ExitCode::from(aicc_helper::bridge::run(&store_dir, sid))
}

#[cfg(windows)]
fn cmd_bridge(_raw: &[OsString]) -> ExitCode {
    fail("bridge runs on macOS and Linux only")
}

/// The field mode (`field.rs`): the value and one line end on standard
/// output, or nothing, and exit 0; exit 2 on a command line it does not
/// take, an argument that is not Unicode included. It writes with writeln!,
/// so a closed standard output is no panic.
fn cmd_field(raw: &[OsString]) -> ExitCode {
    let args: Vec<String> = match raw.iter().map(|a| a.to_str().map(str::to_string)).collect::<Option<Vec<String>>>() {
        Some(args) => args,
        None => return usage("field takes Unicode arguments only"),
    };
    let a = match Args::parse(&args, &["--file", "--key"], &[]) {
        Ok(a) => a,
        Err(e) => return usage(&e),
    };
    let (file, key) = match (a.get("--file"), a.get("--key")) {
        (Some(file), Some(key)) => (file, key),
        _ => return usage("field needs --file and --key"),
    };
    if let Some(value) = field::run(file, key) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{value}");
        let _ = out.flush();
    }
    ExitCode::SUCCESS
}

fn cmd_list(args: &[String]) -> ExitCode {
    let a = match Args::parse(args, &["--store"], &[]) {
        Ok(a) => a,
        Err(e) => return usage(&e),
    };
    let store_dir = match a.get("--store") {
        Some(s) if !s.is_empty() => PathBuf::from(s),
        _ => return usage("list needs --store"),
    };
    match store::list(&store_dir, client::probe) {
        Ok(listing) => {
            println!("{}", listing.to_json());
            ExitCode::SUCCESS
        }
        Err(e) => fail(&format!("list failed: {e}")),
    }
}
