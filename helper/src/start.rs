//! `aicc-helper start`: start one program that keeps none of the starter's
//! handles, say which process it is, and exit without waiting for it. Windows
//! only; on macOS and Linux the mode refuses (protocol section 15, "Starting
//! a program").
//!
//! ```text
//! aicc-helper start [--hide] --cwd <folder> -- <program> [args...]
//! ```
//!
//! The app starts the vision browser this way. A child the app starts itself
//! is given every handle the app lets a child inherit, and the browser
//! outlives the app, so each of those handles would stay open for as long as
//! the browser runs. This mode is given them too, but it exits at once, and
//! the program it starts inherits none: it is started with inheritance off
//! and its standard handles set to nothing.
//!
//! The program is named by an absolute path and started by that exact path
//! (`CreateProcessW` is given it, so nothing is searched for). It is never a
//! batch file, which Windows would run through cmd.exe, nor a name Windows
//! would open as another: one with a part of dots alone, a trailing
//! separator, or a trailing dot or space (`pty::is_batch_file`,
//! `pty::is_renamed_by_windows`). The command line is built as the holder
//! builds one (`cmdline.rs`). The program runs as a detached process in a
//! process group of its own, hidden with `--hide`, in the folder `--cwd`
//! names.
//!
//! On success it prints one line, `{"pid":<n>,"created":"<t>"}`, and exits 0.
//! `created` is the process's creation time in the form the app reads for
//! every process it identifies: what `Win32_Process.CreationDate.ToFileTimeUtc()`
//! gives, steps of 100 ns since 1601 (UTC) to the microsecond. So the app can
//! end it later only while that pid still has that start time. A program it
//! refuses, or one that cannot be started, exits 1 with a message on stderr,
//! and nothing is left running. A command line it cannot read exits 2.
#![allow(unsafe_code)]

use crate::pty::{is_batch_file, is_renamed_by_windows};
use crate::request::{MAX_ARGV_ITEMS, MAX_ARG_CHARS, MAX_CWD_CHARS};
use std::process::ExitCode;

const USAGE: &str = "usage: aicc-helper start [--hide] --cwd <folder> -- <program> [args...]";

/// What to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartRequest {
    /// Start the program's window hidden.
    pub hide: bool,
    /// The folder it runs in: an absolute path.
    pub cwd: String,
    /// The program, by an absolute path.
    pub program: String,
    /// Its arguments, after the program's own name.
    pub args: Vec<String>,
}

/// Why a command line was not taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The command line cannot be read: exit 2, with the usage.
    Usage(String),
    /// It can, but names something this mode does not start: exit 1.
    Refused(String),
}

/// A started program.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Started {
    pub pid: u32,
    /// Its creation time in the app's form (see the module comment).
    pub created: u64,
}

impl Started {
    /// The one line `start` prints.
    pub fn to_json(&self) -> String {
        format!("{{\"pid\":{},\"created\":\"{}\"}}", self.pid, self.created)
    }
}

/// A creation time as the app reads one: `Win32_Process.CreationDate` holds
/// microseconds, so the last step of 100 ns is dropped.
pub fn app_created(filetime: u64) -> u64 {
    filetime / 10 * 10
}

/// A path that starts with a drive letter, a colon and a separator, such as
/// `C:\`. Nothing else is taken: a relative name is searched for, and a name
/// with only a drive (`C:x`) is read from that drive's current folder.
fn drive_absolute(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// True when Windows would open `program` by another name than it says
/// (`pty::is_renamed_by_windows`), or drops a trailing dot or space from it.
fn renamed(program: &str) -> bool {
    is_renamed_by_windows(program) || program.ends_with('.') || program.ends_with(' ')
}

fn usage<T>(what: &str) -> Result<T, Refusal> {
    Err(Refusal::Usage(what.to_string()))
}

fn refuse<T>(what: &str) -> Result<T, Refusal> {
    Err(Refusal::Refused(what.to_string()))
}

/// Read a `start` command line (what follows `start`) and check what it names.
pub fn parse(args: &[String]) -> Result<StartRequest, Refusal> {
    let mut hide = false;
    let mut cwd: Option<String> = None;
    let mut i = 0;
    loop {
        match args.get(i).map(String::as_str) {
            None => return usage("start needs -- and a program"),
            Some("--") => {
                i += 1;
                break;
            }
            Some("--hide") => {
                if hide {
                    return usage("--hide is given twice");
                }
                hide = true;
                i += 1;
            }
            Some("--cwd") => {
                if cwd.is_some() {
                    return usage("--cwd is given twice");
                }
                match args.get(i + 1) {
                    Some(v) => cwd = Some(v.clone()),
                    None => return usage("--cwd needs a value"),
                }
                i += 2;
            }
            Some(other) => return usage(format!("unknown option {other}").as_str()),
        }
    }
    let cwd = match cwd {
        Some(c) => c,
        None => return usage("start needs --cwd"),
    };
    let program = match args.get(i) {
        Some(p) => p.clone(),
        None => return usage("start needs a program after --"),
    };
    let rest: Vec<String> = args[i + 1..].to_vec();

    if cwd.is_empty() || cwd.contains('\0') || cwd.chars().count() > MAX_CWD_CHARS || !drive_absolute(&cwd) {
        return refuse("--cwd must be an absolute path of at most 4096 characters, with no NUL character");
    }
    if program.contains('\0') || program.chars().count() > MAX_ARG_CHARS {
        return refuse("the program's name is over 8192 characters or holds a NUL character");
    }
    if !drive_absolute(&program) {
        return refuse("the program must be named by an absolute path, such as C:\\folder\\program.exe; nothing is searched for");
    }
    if renamed(&program) {
        return refuse("the program's name has a part of dots alone, a trailing separator, or a trailing dot or space, which Windows opens by another name");
    }
    if is_batch_file(&program) {
        return refuse("the program is a batch file, which Windows runs through cmd.exe");
    }
    if rest.len() > MAX_ARGV_ITEMS {
        return refuse("the program is given more than 256 arguments");
    }
    for a in &rest {
        if a.chars().count() > MAX_ARG_CHARS {
            return refuse("an argument is over 8192 characters");
        }
        if a.contains('\0') {
            return refuse("an argument holds a NUL character");
        }
    }
    Ok(StartRequest { hide, cwd, program, args: rest })
}

/// `aicc-helper start ...`: the command, with its output and exit status.
pub fn command(args: &[String]) -> ExitCode {
    if cfg!(not(windows)) {
        eprintln!("aicc-helper: start is for Windows only");
        return ExitCode::from(1);
    }
    let req = match parse(args) {
        Ok(r) => r,
        Err(Refusal::Usage(why)) => {
            eprintln!("aicc-helper: {why}");
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
        Err(Refusal::Refused(why)) => {
            eprintln!("aicc-helper: start refused: {why}");
            return ExitCode::from(1);
        }
    };
    match start(&req) {
        Ok(started) => {
            println!("{}", started.to_json());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("aicc-helper: could not start {}: {e}", req.program);
            ExitCode::from(1)
        }
    }
}

/// Start what `req` names (see the module comment). Windows only.
#[cfg(not(windows))]
pub fn start(_req: &StartRequest) -> std::io::Result<Started> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "start is for Windows only"))
}

#[cfg(windows)]
pub use self::win::start;

#[cfg(windows)]
mod win {
    use super::{app_created, StartRequest, Started};
    use crate::cmdline::build_command_line;
    use crate::winproc::{close, create_process, creation_time, wide, STARTF_USESTDHANDLES};
    use std::io;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::Threading::{TerminateProcess, STARTUPINFOEXW, STARTUPINFOW};

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    /// `STARTF_USESHOWWINDOW`: `wShowWindow` says how the first window shows.
    const STARTF_USESHOWWINDOW: u32 = 0x0000_0001;
    /// `SW_HIDE`.
    const SW_HIDE: u16 = 0;

    /// Start what `req` names with no handle passed on, and read its start
    /// time from the process handle the start returned, so it is that
    /// process's and no other's. A start time that cannot be read ends the
    /// program again: an error always means nothing was left running.
    pub fn start(req: &StartRequest) -> io::Result<Started> {
        let mut words = vec![req.program.clone()];
        words.extend(req.args.iter().cloned());
        let cmdline = build_command_line(&words);
        let app = wide(&req.program);
        let cwd = wide(&req.cwd);
        unsafe {
            let mut startup: STARTUPINFOEXW = std::mem::zeroed();
            // No attribute list: the plain start-up block.
            startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            // Standard input, output and error are nothing. Nothing else is
            // passed on either: inheritance is off (the last `false`). A
            // handle list is for a start that must pass a handle on, as the
            // holder's own start passes its standard error.
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            if req.hide {
                startup.StartupInfo.dwFlags |= STARTF_USESHOWWINDOW;
                startup.StartupInfo.wShowWindow = SW_HIDE;
            }
            let info = create_process(&app, &cmdline, &cwd, &startup, DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, false)?;
            close(info.hThread as usize);
            let process = info.hProcess as usize;
            let made = creation_time(process);
            if made.is_err() {
                TerminateProcess(process as HANDLE, 1);
            }
            close(process);
            Ok(Started { pid: info.dwProcessId, created: app_created(made?) })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &[&str]) -> Vec<String> {
        s.iter().map(|w| w.to_string()).collect()
    }

    const CHROME: &str = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

    fn refused(args: &[&str]) -> bool {
        matches!(parse(&words(args)), Err(Refusal::Refused(_)))
    }

    fn unreadable(args: &[&str]) -> bool {
        matches!(parse(&words(args)), Err(Refusal::Usage(_)))
    }

    #[test]
    fn a_start_is_read_with_its_folder_its_program_and_its_arguments() {
        let got = parse(&words(&["--hide", "--cwd", "C:\\x", "--", CHROME, "--remote-debugging-port=9222", "two words"])).expect("read");
        assert_eq!(got, StartRequest { hide: true, cwd: "C:\\x".into(), program: CHROME.into(), args: words(&["--remote-debugging-port=9222", "two words"]) });
        let plain = parse(&words(&["--cwd", "C:/x", "--", CHROME])).expect("read");
        assert!(!plain.hide && plain.args.is_empty());
        // What follows `--` is the program's own, even when it looks like an option.
        let after = parse(&words(&["--cwd", "C:\\x", "--", CHROME, "--cwd", "--hide", "--"])).expect("read");
        assert_eq!(after.args, words(&["--cwd", "--hide", "--"]));
    }

    #[test]
    fn a_command_line_that_cannot_be_read_says_how_to_use_it() {
        assert!(unreadable(&[]));
        assert!(unreadable(&["--cwd", "C:\\x"]), "no --");
        assert!(unreadable(&["--", CHROME]), "no --cwd");
        assert!(unreadable(&["--cwd", "C:\\x", "--"]), "no program");
        assert!(unreadable(&["--cwd"]), "--cwd with no value");
        assert!(unreadable(&["--cwd", "C:\\x", "--cwd", "C:\\y", "--", CHROME]), "--cwd twice");
        assert!(unreadable(&["--hide", "--hide", "--cwd", "C:\\x", "--", CHROME]), "--hide twice");
        assert!(unreadable(&["--wait", "--cwd", "C:\\x", "--", CHROME]), "an unknown option");
    }

    #[test]
    fn only_a_program_named_by_an_absolute_path_that_windows_opens_as_named_is_started() {
        let with = |program: &str| refused(&["--cwd", "C:\\x", "--", program]);
        // Nothing is searched for: a bare or relative name, or one with only a drive.
        for name in ["chrome.exe", "chrome", ".\\chrome.exe", "Google\\chrome.exe", "C:chrome.exe", "\\Windows\\System32\\cmd.exe", "\\\\server\\share\\a.exe", ""] {
            assert!(with(name), "{name:?} was taken");
        }
        // A batch file, in any case, and with what Windows drops from a name.
        for name in ["C:\\x\\tool.cmd", "C:\\x\\tool.BAT", "C:\\x\\tool.cmd.", "C:\\x\\tool.bat . ."] {
            assert!(with(name), "{name:?} was taken");
        }
        // A name Windows opens as another.
        for name in ["C:\\x\\chrome.exe.", "C:\\x\\chrome.exe ", "C:\\x\\sub\\..\\chrome.exe", "C:\\x\\.\\chrome.exe", "C:\\x\\a.cmd\\.", "C:\\x\\chrome.exe\\"] {
            assert!(with(name), "{name:?} was taken");
        }
        for name in [CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:\\x\\.tools\\a.exe", "c:\\x\\a.exe"] {
            assert!(!with(name), "{name:?} was refused");
        }
    }

    #[test]
    fn the_folder_and_the_arguments_are_bounded() {
        assert!(refused(&["--cwd", "x", "--", CHROME]), "a relative folder");
        assert!(refused(&["--cwd", "", "--", CHROME]), "an empty folder");
        assert!(refused(&["--cwd", "C:\\a\0b", "--", CHROME]), "a NUL in the folder");
        let long_cwd = format!("C:\\{}", "a".repeat(MAX_CWD_CHARS));
        assert!(refused(&["--cwd", long_cwd.as_str(), "--", CHROME]), "a folder over 4096 characters");
        assert!(refused(&["--cwd", "C:\\x", "--", CHROME, "a\0b"]), "a NUL in an argument");
        let long = "a".repeat(MAX_ARG_CHARS + 1);
        assert!(refused(&["--cwd", "C:\\x", "--", CHROME, long.as_str()]), "an argument over 8192 characters");
        let just = "a".repeat(MAX_ARG_CHARS);
        assert!(!refused(&["--cwd", "C:\\x", "--", CHROME, just.as_str()]), "an argument of 8192 characters");
        let mut many = words(&["--cwd", "C:\\x", "--", CHROME]);
        many.extend(std::iter::repeat("a".to_string()).take(MAX_ARGV_ITEMS));
        assert!(parse(&many).is_ok(), "256 arguments");
        many.push("a".to_string());
        assert!(matches!(parse(&many), Err(Refusal::Refused(_))), "257 arguments");
    }

    #[test]
    fn the_line_it_prints_carries_the_pid_and_the_start_time_as_the_app_reads_them() {
        let s = Started { pid: 4242, created: app_created(134_078_123_456_789_017) };
        assert_eq!(s.created, 134_078_123_456_789_010);
        assert_eq!(s.to_json(), "{\"pid\":4242,\"created\":\"134078123456789010\"}");
        assert_eq!(app_created(134_078_123_456_789_010), 134_078_123_456_789_010);
    }
}
