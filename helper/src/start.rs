//! `aicc-helper start` and `aicc-helper end`: start one program that keeps
//! none of the starter's handles, say which process it is, and exit without
//! waiting for it; later, end that program's process tree, only while its pid
//! still has the creation time `start` printed. Windows only; on macOS and
//! Linux both modes refuse (protocol section 15, "Starting a program").
//!
//! ```text
//! aicc-helper start [--hide] --cwd <folder> -- <program> [args...]
//! aicc-helper end --pid <n> --created <t>
//! ```
//!
//! The app starts the vision browser this way. A child the app starts itself
//! is given every handle the app lets a child inherit, and the browser
//! outlives the app, so each of those handles would stay open for as long as
//! the browser runs. This mode is given them too, but it exits at once, and
//! the program it starts inherits none: it is started with inheritance off
//! and its standard handles set to nothing.
//!
//! The program is named by a drive-absolute path and started by that exact
//! path (`CreateProcessW` is given it, so nothing is searched for). It is
//! never a batch file, which Windows would run through cmd.exe, nor a name
//! Windows would open as another: one with a part of dots alone, a trailing
//! separator, or a trailing dot or space (`pty::is_batch_file`,
//! `pty::is_renamed_by_windows`). The command line is built as the holder
//! builds one (`cmdline.rs`). The program runs as a detached process in a
//! process group of its own, hidden with `--hide`, in the folder `--cwd`
//! names (also drive-absolute).
//!
//! It is created suspended, its creation time is read, and only then does it
//! run. On success `start` prints one line, `{"pid":<n>,"created":"<t>"}`,
//! and exits 0. `created` is the process's creation time in the form the app
//! reads for every process it identifies: what
//! `Win32_Process.CreationDate.ToFileTimeUtc()` gives, steps of 100 ns since
//! 1601 (UTC) to the microsecond. So the app can end it later only while that
//! pid still has that start time. A program it refuses, or one that cannot be
//! started, exits 1 with a message on stderr, and nothing has run: a creation
//! time that cannot be read ends a program that has not run yet. A command
//! line it cannot read exits 2.
//!
//! `end` ends the process `--pid` names and every process under it, only
//! while that pid still has the creation time `--created` gives, in the form
//! `start` prints. It holds the process open from that check to the end, so
//! the pid cannot pass to another process in between. A process counts as
//! under its parent only when it was made no earlier than the parent: one
//! made earlier names a parent id that has since passed to another process.
//! It prints `ended`, or `left` when no process has that pid, the one that
//! has it was made at another time, or it has already exited; both exit 0.
//! When it cannot tell, it exits 1 with a message on stderr, and the process
//! is not ended. A command line it cannot read exits 2. It reads the process
//! list and each process's times itself (no PowerShell, no WMI), so it
//! answers in milliseconds, which the app needs on the exits that cannot wait.
#![allow(unsafe_code)]

use crate::pty::{is_batch_file, is_renamed_by_windows};
use crate::request::{MAX_ARGV_ITEMS, MAX_ARG_CHARS, MAX_CWD_CHARS};
use std::process::ExitCode;

const USAGE: &str = "usage: aicc-helper start [--hide] --cwd <folder> -- <program> [args...]";
const END_USAGE: &str = "usage: aicc-helper end --pid <n> --created <t>";

/// What to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartRequest {
    /// Start the program's window hidden.
    pub hide: bool,
    /// The folder it runs in: a drive-absolute path.
    pub cwd: String,
    /// The program, by a drive-absolute path.
    pub program: String,
    /// Its arguments, after the program's own name.
    pub args: Vec<String>,
}

/// What to end: a pid and its creation time in the app's form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EndRequest {
    pub pid: u32,
    pub created: u64,
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
/// `C:\` or `C:/`. Nothing else is taken: a relative name is searched for, a
/// name with only a drive (`C:x`) is read from that drive's current folder,
/// and a UNC or rooted path (`\\server\share`, `\x`) is not drive-absolute.
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
        return refuse("--cwd must be a drive-absolute path (C:\\... or C:/...) of at most 4096 characters, with no NUL character");
    }
    if program.contains('\0') || program.chars().count() > MAX_ARG_CHARS {
        return refuse("the program's name is over 8192 characters or holds a NUL character");
    }
    if !drive_absolute(&program) {
        return refuse("the program must be named by a drive-absolute path, such as C:\\folder\\program.exe; nothing is searched for");
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

/// `v` as a number when it is 1 to `max_digits` ASCII digits that fit a u64.
fn digits(v: &str, max_digits: usize) -> Option<u64> {
    if v.is_empty() || v.len() > max_digits || !v.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    v.parse::<u64>().ok()
}

/// Read an `end` command line (what follows `end`): `--pid` and `--created`,
/// each once, as plain digits, and nothing else.
pub fn parse_end(args: &[String]) -> Result<EndRequest, Refusal> {
    let mut pid: Option<u32> = None;
    let mut created: Option<u64> = None;
    let mut i = 0;
    while let Some(option) = args.get(i) {
        let value = match args.get(i + 1) {
            Some(v) => v.as_str(),
            None => return usage(format!("{option} needs a value").as_str()),
        };
        match option.as_str() {
            "--pid" => {
                if pid.is_some() {
                    return usage("--pid is given twice");
                }
                match digits(value, 10).and_then(|n| u32::try_from(n).ok()).filter(|n| *n > 0) {
                    Some(n) => pid = Some(n),
                    None => return usage("--pid must be a process id: digits, above 0"),
                }
            }
            "--created" => {
                if created.is_some() {
                    return usage("--created is given twice");
                }
                match digits(value, 20) {
                    Some(n) => created = Some(n),
                    None => return usage("--created must be a creation time: 1 to 20 digits"),
                }
            }
            other => return usage(format!("unknown option {other}").as_str()),
        }
        i += 2;
    }
    match (pid, created) {
        (Some(pid), Some(created)) => Ok(EndRequest { pid, created }),
        _ => usage("end needs --pid and --created"),
    }
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

/// `aicc-helper end ...`: the command, with its output and exit status.
pub fn end_command(args: &[String]) -> ExitCode {
    if cfg!(not(windows)) {
        eprintln!("aicc-helper: end is for Windows only");
        return ExitCode::from(1);
    }
    let req = match parse_end(args) {
        Ok(r) => r,
        Err(Refusal::Usage(why)) | Err(Refusal::Refused(why)) => {
            eprintln!("aicc-helper: {why}");
            eprintln!("{END_USAGE}");
            return ExitCode::from(2);
        }
    };
    match end(&req) {
        Ok(true) => {
            println!("ended");
            ExitCode::SUCCESS
        }
        Ok(false) => {
            println!("left");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("aicc-helper: could not tell whether to end process {}: {e}", req.pid);
            ExitCode::from(1)
        }
    }
}

/// Start what `req` names (see the module comment). Windows only.
#[cfg(not(windows))]
pub fn start(_req: &StartRequest) -> std::io::Result<Started> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "start is for Windows only"))
}

/// End what `req` names (see the module comment): `Ok(true)` when it was
/// ended, `Ok(false)` when it was left. Windows only.
#[cfg(not(windows))]
pub fn end(_req: &EndRequest) -> std::io::Result<bool> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "end is for Windows only"))
}

#[cfg(windows)]
pub use self::win::{end, start};

#[cfg(windows)]
mod win {
    use super::{app_created, EndRequest, StartRequest, Started};
    use crate::cmdline::build_command_line;
    use crate::winproc::{close, create_process, creation_time, exit_code, os_error, wide, STARTF_USESTDHANDLES};
    use std::io;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_INVALID_PARAMETER, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, ResumeThread, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, STARTUPINFOEXW, STARTUPINFOW,
    };

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    /// `CREATE_SUSPENDED`: the program's first thread waits until it is resumed.
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    /// `STARTF_USESHOWWINDOW`: `wShowWindow` says how the first window shows.
    const STARTF_USESHOWWINDOW: u32 = 0x0000_0001;
    /// `SW_HIDE`.
    const SW_HIDE: u16 = 0;

    /// Start what `req` names with no handle passed on. It is created
    /// suspended and its start time is read from the process handle the
    /// start returned, so it is that process's and no other's; only then is
    /// it resumed. A start time that cannot be read, or a resume that fails,
    /// ends a program that has not run: an error always means nothing ran.
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
            let flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED;
            let info = create_process(&app, &cmdline, &cwd, &startup, flags, false)?;
            let process = info.hProcess as usize;
            let thread = info.hThread as usize;
            let started = match creation_time(process) {
                // ResumeThread answers the thread's earlier suspend count, or u32::MAX on failure.
                Ok(made) if ResumeThread(thread as HANDLE) != u32::MAX => Ok(Started { pid: info.dwProcessId, created: app_created(made) }),
                Ok(_) => Err(os_error("ResumeThread")),
                Err(e) => Err(e),
            };
            if started.is_err() {
                TerminateProcess(process as HANDLE, 1);
            }
            close(thread);
            close(process);
            started
        }
    }

    /// What `end` opens a process with: read its times, wait on it, end it.
    const END_RIGHTS: u32 = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE;
    /// What it opens a process under it with: read its times, end it.
    const UNDER_RIGHTS: u32 = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE;

    /// End the process tree `req` names, only while its pid still has its
    /// creation time (see the module comment).
    pub fn end(req: &EndRequest) -> io::Result<bool> {
        unsafe {
            let root = OpenProcess(END_RIGHTS, 0, req.pid) as usize;
            if root == 0 {
                // ERROR_INVALID_PARAMETER: no process has this pid.
                if GetLastError() == ERROR_INVALID_PARAMETER {
                    return Ok(false);
                }
                return Err(os_error("OpenProcess"));
            }
            let ended = end_open(root, req);
            close(root);
            ended
        }
    }

    /// `end` with the process open: while this handle is open its pid cannot
    /// pass to another process, so the check and the end are of one process.
    unsafe fn end_open(root: usize, req: &EndRequest) -> io::Result<bool> {
        let made = creation_time(root)?;
        // MUTANT M8: the creation time is not compared.
        if exit_code(root)?.is_some() {
            return Ok(false);
        }
        let under = processes_under(req.pid, made);
        if TerminateProcess(root as HANDLE, 1) == 0 {
            let e = os_error("TerminateProcess");
            for p in under {
                close(p);
            }
            // It exited on its own in between: there was nothing to end.
            return match exit_code(root) {
                Ok(Some(_)) => Ok(false),
                _ => Err(e),
            };
        }
        for p in under {
            TerminateProcess(p as HANDLE, 1);
            close(p);
        }
        Ok(true)
    }

    /// The processes under `pid` (made at `made`), each open to be ended,
    /// from one read of the process list. A process counts as under its
    /// parent only when it was made no earlier than the parent: one made
    /// earlier names a parent id that has since passed to another process.
    /// One that cannot be opened or read is left out, with what is under it.
    unsafe fn processes_under(pid: u32, made: u64) -> Vec<usize> {
        // MUTANT M9: nothing is found under it.
        let list: Vec<(u32, u32)> = Vec::new();
        let mut found: Vec<usize> = Vec::new();
        let mut seen: Vec<u32> = vec![pid];
        let mut parents: Vec<(u32, u64)> = vec![(pid, made)];
        while let Some((parent, parent_made)) = parents.pop() {
            for &(child, its_parent) in &list {
                if its_parent != parent || child == 0 || seen.contains(&child) {
                    continue;
                }
                let h = OpenProcess(UNDER_RIGHTS, 0, child) as usize;
                if h == 0 {
                    continue;
                }
                match creation_time(h) {
                    Ok(child_made) if child_made >= parent_made => {
                        seen.push(child);
                        found.push(h);
                        parents.push((child, child_made));
                    }
                    _ => close(h),
                }
            }
        }
        found
    }

    /// Every process now, as (pid, parent pid). Empty when the list cannot
    /// be read.
    unsafe fn process_list() -> Vec<(u32, u32)> {
        let mut list = Vec::new();
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return list;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snap, &mut entry) != 0;
        while more {
            list.push((entry.th32ProcessID, entry.th32ParentProcessID));
            more = Process32NextW(snap, &mut entry) != 0;
        }
        close(snap as usize);
        list
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

    fn read_end(args: &[&str]) -> Result<EndRequest, Refusal> {
        parse_end(&words(args))
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
        assert!(refused(&["--cwd", "\\\\server\\share", "--", CHROME]), "a UNC folder");
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

    #[test]
    fn an_end_is_read_with_its_pid_and_its_creation_time_and_nothing_else() {
        assert_eq!(read_end(&["--pid", "4242", "--created", "134078123456789010"]), Ok(EndRequest { pid: 4242, created: 134_078_123_456_789_010 }));
        assert_eq!(read_end(&["--created", "1", "--pid", "4294967295"]), Ok(EndRequest { pid: u32::MAX, created: 1 }));
        let bad: Vec<Vec<&str>> = vec![
            vec![],
            vec!["--pid", "1"],
            vec!["--created", "1"],
            vec!["--pid"],
            vec!["--pid", "1", "--created"],
            vec!["--pid", "0", "--created", "1"],
            vec!["--pid", "4294967296", "--created", "1"],
            vec!["--pid", "-1", "--created", "1"],
            vec!["--pid", "+1", "--created", "1"],
            vec!["--pid", " 1", "--created", "1"],
            vec!["--pid", "1", "--created", ""],
            vec!["--pid", "1", "--created", "12a"],
            vec!["--pid", "1", "--created", "123456789012345678901"],
            vec!["--pid", "1", "--created", "99999999999999999999"],
            vec!["--pid", "1", "--pid", "2", "--created", "1"],
            vec!["--pid", "1", "--created", "1", "--created", "1"],
            vec!["--pid", "1", "--created", "1", "--hide", "1"],
            vec!["--pid", "1", "--created", "1", "extra"],
        ];
        for args in &bad {
            assert!(matches!(read_end(args.as_slice()), Err(Refusal::Usage(_))), "{args:?} was read");
        }
    }
}
