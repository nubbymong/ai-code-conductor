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
//! the pid cannot pass to another process in between. The processes under it
//! come from one read of the process list, and the system time is read just
//! before that read. A process counts as under its parent only when it was
//! made no earlier than the parent and no later than that time: one made
//! earlier names a parent id that has since passed to another process, and
//! one made later may have taken a listed pid after the list was read
//! (`made_under`). A pid is freed and passed on only after the list is read,
//! so a process that takes one is always made after that time; one made while
//! the list is read is left out too, and keeps running. A list that cannot be
//! read ends nothing: a list read in part would leave processes under it
//! running once it is gone (`list_step`). Once it is gone, ended or exited by
//! itself after the check, the processes found under it are ended. An end
//! that fails waits for the process to exit before it counts: Windows refuses
//! to end a process whose own exit is under way, but marks it exited only
//! once that exit is done. One that exits within the wait exited by itself;
//! one that runs past it still runs. The wait is one bound for the whole end,
//! a second in all however many ends fail (`FAILED_END_WAIT`), and an end
//! that succeeds waits for nothing. It prints `ended` when none of the
//! processes it checked still runs, or `left` when no process has that pid,
//! the one that has it was made at another time, or it had already exited
//! when it was checked; both exit 0. It exits 1 with a message on stderr when
//! it cannot tell (it ends nothing), when the process still runs and cannot
//! be ended (it ends nothing), or when a process under it cannot be ended and
//! may still run (it ends the rest; `still_running`). A command line it
//! cannot read exits 2. It reads the process list and each process's times
//! itself (no PowerShell, no WMI), so it answers in milliseconds, a second
//! more at most when an end fails, which the app needs on the exits that
//! cannot wait.
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

/// Whether a process listed under a parent counts as under it, for `end`:
/// made no earlier than the parent (`parent_made`) and no later than
/// `listed_at`, the system time read just before the process list was read.
/// One made earlier names a parent id that has since passed to another
/// process; one made later may have taken a listed pid after the list was
/// read. All three are in steps of 100 ns since 1601 (UTC).
pub fn made_under(child_made: u64, parent_made: u64, listed_at: u64) -> bool {
    parent_made <= child_made && child_made <= listed_at
}

/// `ERROR_NO_MORE_FILES`: the process list has no more entries.
pub const NO_MORE_FILES: u32 = 18;

/// What one read of an entry of the process list gave, for `end`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListStep {
    /// An entry.
    Entry,
    /// The end of the list.
    End,
    /// An error: the list cannot be read.
    Failed,
}

/// What one `Process32FirstW` or `Process32NextW` gave: an entry when it
/// returned one (`got`), else the end of the list only when the error it left
/// (`error`) is `ERROR_NO_MORE_FILES`. Any other error means the list cannot
/// be read, never that it is shorter, and `end` then ends nothing.
pub fn list_step(got: bool, error: u32) -> ListStep {
    if got {
        ListStep::Entry
    } else if error == NO_MORE_FILES {
        ListStep::End
    } else {
        ListStep::Failed
    }
}

/// What became of a process `end` checked, once it tried to end it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fate {
    /// It was ended.
    Ended,
    /// It could not be ended, and it had exited by itself, or did within the
    /// end's wait.
    Exited,
    /// It could not be ended, and it still ran when the end's wait was over,
    /// or its exit code could not be read.
    Runs,
}

impl Fate {
    /// `terminated`: the end succeeded. `exited`: it failed, and the process
    /// had exited, or did within the end's wait (`FAILED_END_WAIT`).
    pub fn of(terminated: bool, exited: bool) -> Fate {
        if terminated {
            Fate::Ended
        } else if exited {
            Fate::Exited
        } else {
            Fate::Runs
        }
    }

    /// Ended, or exited by itself: it no longer runs.
    pub fn gone(self) -> bool {
        self != Fate::Runs
    }
}

/// The processes `end` checked that may still run, by pid, once it has tried
/// to end the one it was named (`root`) and, only when that one is gone, each
/// one under it (`under`). Empty: it prints `ended`. Otherwise it exits 1. A
/// root that may still run is named alone: nothing under it was ended then,
/// so nothing was.
pub fn still_running(root: (u32, Fate), under: &[(u32, Fate)]) -> Vec<u32> {
    if !root.1.gone() {
        return vec![root.0];
    }
    under.iter().filter(|(_, fate)| !fate.gone()).map(|(pid, _)| *pid).collect()
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
            eprintln!("aicc-helper: could not end process {}: {e}", req.pid);
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
    use super::{app_created, list_step, made_under, still_running, EndRequest, Fate, ListStep, StartRequest, Started, NO_MORE_FILES};
    use crate::cmdline::build_command_line;
    use crate::winproc::{close, create_process, creation_time, exit_code, exit_code_within, os_error, wide, STARTF_USESTDHANDLES};
    use std::io;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows_sys::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;
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

    // The one value `list_step` takes as the end of the process list.
    const _: () = assert!(NO_MORE_FILES == ERROR_NO_MORE_FILES);

    /// What `end` opens a process with: read its times, wait on it, end it.
    const END_RIGHTS: u32 = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE;
    /// What it opens a process under it with: the same. Waiting on it is how
    /// an end that fails tells a process that exited by itself
    /// (`exit_code_within`).
    const UNDER_RIGHTS: u32 = END_RIGHTS;

    /// How long one end waits, in all, for the processes it could not end to
    /// exit. Windows refuses to end a process whose own exit is under way,
    /// but marks it exited only when that exit is done, tens of milliseconds
    /// later for a browser. So a process whose end fails counts as one that
    /// still runs only when it has not exited by then. It is one deadline for
    /// the whole end, so however many ends fail the end waits at most this
    /// long: the app gives the whole end 5 s (`HELPER_END_TIMEOUT_MS`). An
    /// end that succeeds waits for nothing.
    const FAILED_END_WAIT: Duration = Duration::from_secs(1);

    /// What is left until `until`, in milliseconds rounded up, as a wait
    /// takes it: 0 once it has passed.
    fn ms_until(until: Instant) -> u32 {
        let left = until.saturating_duration_since(Instant::now()).as_micros().div_ceil(1000);
        // u32::MAX would be a wait with no end.
        u32::try_from(left).unwrap_or(u32::MAX - 1).min(u32::MAX - 1)
    }

    /// The process list: every process as (pid, parent pid), and the system
    /// time read just before the list was.
    type Listing = (Vec<(u32, u32)>, u64);

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
        end_open_from(root, req, process_list)
    }

    /// `end_open`, with the process list read by `read_list` (a test gives
    /// one that cannot be read). A list that cannot be read is an error
    /// before anything is ended.
    unsafe fn end_open_from(root: usize, req: &EndRequest, read_list: impl FnOnce() -> io::Result<Listing>) -> io::Result<bool> {
        let made = creation_time(root)?;
        if app_created(made) != req.created || exit_code(root)?.is_some() {
            return Ok(false);
        }
        let under = processes_under(req.pid, made, read_list)?;
        end_checked(root, req.pid, under)?;
        Ok(true)
    }

    /// End the process `end` checked (`root`, whose pid is `pid`) and, once
    /// it is gone, each process found under it (`under`, each a pid and an
    /// open handle, closed here): `Ok` when none of them still runs
    /// (`still_running`). A root that exited by itself after the check is
    /// gone too, so the processes under it are still ended. A root that still
    /// runs and cannot be ended ends nothing. Every end that fails waits
    /// against one deadline, set here (`FAILED_END_WAIT`).
    unsafe fn end_checked(root: usize, pid: u32, under: Vec<(u32, usize)>) -> io::Result<()> {
        let until = Instant::now() + FAILED_END_WAIT;
        let _ = until;
        // MUTANT M32: the program's own failed end waits for nothing (the zero-timeout wait before round 5).
        let (root_fate, why) = end_one(root, Instant::now());
        let mut fates: Vec<(u32, Fate)> = Vec::new();
        for (child, h) in under {
            if root_fate.gone() {
                // MUTANT M33: each process under it gets a bound of its own.
                fates.push((child, end_one(h, Instant::now() + FAILED_END_WAIT).0));
            }
            close(h);
        }
        let running = still_running((pid, root_fate), &fates);
        if running.is_empty() {
            return Ok(());
        }
        if let (false, Some(why)) = (root_fate.gone(), why) {
            return Err(io::Error::new(why.kind(), format!("it could not be ended and may still run, so nothing was ended: {why}")));
        }
        let pids: Vec<String> = running.iter().map(u32::to_string).collect();
        Err(io::Error::other(format!("it is gone, but these processes under it could not be ended and may still run: {}", pids.join(", "))))
    }

    /// Try to end `process`: what became of it, and why the end failed when
    /// it did. An end that fails waits for it to exit until `until`, the
    /// end's one deadline (`FAILED_END_WAIT`): it exited by itself when it
    /// has by then, and still runs when it has not or the wait fails. An end
    /// that succeeds waits for nothing.
    unsafe fn end_one(process: usize, until: Instant) -> (Fate, Option<io::Error>) {
        if TerminateProcess(process as HANDLE, 1) != 0 {
            return (Fate::Ended, None);
        }
        let why = os_error("TerminateProcess");
        (Fate::of(false, matches!(exit_code_within(process, ms_until(until)), Ok(Some(_)))), Some(why))
    }

    /// The processes under `pid` (made at `made`), each a pid and a handle
    /// open to end it, from one read of the process list (`read_list`). A
    /// list that cannot be read is an error, and nothing is opened. A process
    /// counts as under its parent only when it was made between the parent
    /// and the system time read just before the list (`made_under`): each is
    /// opened by its pid after the list is read, and the pid may have passed
    /// by then to another process, which was made after that time. One that
    /// cannot be opened or read is left out, with what is under it: it has
    /// exited, or its pid has passed to a process this user may not open.
    unsafe fn processes_under(pid: u32, made: u64, read_list: impl FnOnce() -> io::Result<Listing>) -> io::Result<Vec<(u32, usize)>> {
        let (list, listed_at) = read_list()?;
        let mut found: Vec<(u32, usize)> = Vec::new();
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
                    Ok(child_made) if made_under(child_made, parent_made, listed_at) => {
                        seen.push(child);
                        found.push((child, h));
                        parents.push((child, child_made));
                    }
                    _ => close(h),
                }
            }
        }
        Ok(found)
    }

    /// Every process now, as (pid, parent pid), with the system time read
    /// just before the list is. A pid in the list can be freed and passed to
    /// a new process only after the list is read, so that process is made
    /// after this time; one made while the list is read is after it too, and
    /// is left out (it keeps running). An error when the list cannot be read:
    /// the snapshot fails, or reading an entry fails with any error but
    /// `ERROR_NO_MORE_FILES`, the end of the list (`list_step`).
    fn process_list() -> io::Result<Listing> {
        unsafe {
            let mut now = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            GetSystemTimePreciseAsFileTime(&mut now);
            let listed_at = (u64::from(now.dwHighDateTime) << 32) | u64::from(now.dwLowDateTime);
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return Err(os_error("CreateToolhelp32Snapshot"));
            }
            let mut list = Vec::new();
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut call = "Process32FirstW";
            let mut got = Process32FirstW(snap, &mut entry) != 0;
            let read = loop {
                let error = if got { 0 } else { GetLastError() };
                match list_step(got, error) {
                    ListStep::Entry => list.push((entry.th32ProcessID, entry.th32ParentProcessID)),
                    ListStep::End => break Ok(list),
                    ListStep::Failed => {
                        let e = io::Error::from_raw_os_error(error as i32);
                        break Err(io::Error::new(e.kind(), format!("{call}: {e}")));
                    }
                }
                call = "Process32NextW";
                got = Process32NextW(snap, &mut entry) != 0;
            };
            close(snap as usize);
            read.map(|list| (list, listed_at))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::process::CommandExt;
        use std::process::{Child, Command, Stdio};
        use std::time::{Duration, Instant};

        /// `CREATE_NO_WINDOW`.
        const NO_WINDOW: u32 = 0x0800_0000;

        /// `cmd.exe` from System32, by its full path, with no standard handles.
        fn cmd() -> Command {
            let root = std::env::var("SystemRoot").expect("SystemRoot is set");
            let mut c = Command::new(std::path::Path::new(&root).join("System32").join("cmd.exe"));
            c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            c
        }

        /// A process that runs until it is ended and does nothing: `cmd.exe`
        /// created suspended. Ended and waited for when dropped.
        struct Held(Child);

        impl Held {
            fn new() -> Held {
                Held(cmd().creation_flags(CREATE_SUSPENDED | NO_WINDOW).spawn().expect("start a suspended cmd.exe"))
            }

            fn pid(&self) -> u32 {
                self.0.id()
            }

            /// It, opened again with `rights`, as `end` opens a process.
            fn opened(&self, rights: u32) -> usize {
                let h = unsafe { OpenProcess(rights, 0, self.pid()) } as usize;
                assert_ne!(h, 0, "open process {}: {}", self.pid(), io::Error::last_os_error());
                h
            }

            /// Whether it has exited within 2 s.
            fn gone_soon(&mut self) -> bool {
                let until = Instant::now() + Duration::from_secs(2);
                while matches!(self.0.try_wait(), Ok(None)) {
                    if Instant::now() >= until {
                        return false;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                true
            }

            /// Whether it still runs 300 ms on: nothing else ends it.
            fn still_runs(&mut self) -> bool {
                std::thread::sleep(Duration::from_millis(300));
                matches!(self.0.try_wait(), Ok(None))
            }
        }

        impl Drop for Held {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        #[test]
        fn a_root_that_exited_by_itself_after_the_check_still_has_what_was_found_under_it_ended() {
            let mut root = cmd().args(["/d", "/c", "exit", "7"]).creation_flags(NO_WINDOW).spawn().expect("start cmd.exe");
            assert_eq!(root.wait().expect("wait for cmd.exe").code(), Some(7));
            // The handle stays open until `root` is dropped, so its pid stays its own.
            let root_handle = root.as_raw_handle() as usize;
            assert_eq!(unsafe { end_one(root_handle, Instant::now() + FAILED_END_WAIT).0 }, Fate::Exited, "an end of a process that has exited did not fail: this test cannot reach the rule");
            let mut under = Held::new();
            let opened = under.opened(UNDER_RIGHTS);
            let got = unsafe { end_checked(root_handle, root.id(), vec![(under.pid(), opened)]) };
            assert!(got.is_ok(), "{got:?}");
            assert!(under.gone_soon(), "the process found under it (process {}) still ran 2 s after the end", under.pid());
        }

        #[test]
        fn a_root_that_still_runs_and_cannot_be_ended_ends_nothing() {
            let mut root = Held::new();
            // Opened without the right to end it, so the end fails while it runs.
            let weak = root.opened(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE);
            let mut under = Held::new();
            let opened = under.opened(UNDER_RIGHTS);
            let got = unsafe { end_checked(weak, root.pid(), vec![(under.pid(), opened)]) };
            unsafe { close(weak) };
            assert!(got.is_err(), "{got:?}");
            assert!(root.still_runs(), "the process itself was ended");
            assert!(under.still_runs(), "the process under it was ended while the process itself still ran");
        }

        #[test]
        fn a_process_under_it_that_cannot_be_ended_is_named_and_the_rest_are_ended() {
            let mut root = Held::new();
            let root_handle = root.opened(END_RIGHTS);
            let mut stuck = Held::new();
            // Opened without the right to end it, so its end fails while it runs.
            let stuck_handle = stuck.opened(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE);
            let mut under = Held::new();
            let under_handle = under.opened(UNDER_RIGHTS);
            let got = unsafe { end_checked(root_handle, root.pid(), vec![(stuck.pid(), stuck_handle), (under.pid(), under_handle)]) };
            unsafe { close(root_handle) };
            let why = got.expect_err("it answered `ended` while a process under it still ran").to_string();
            assert!(why.contains(&stuck.pid().to_string()), "{why}");
            assert!(root.gone_soon(), "the process itself still ran 2 s after the end");
            assert!(under.gone_soon(), "the process under it that could be ended still ran 2 s after the end");
            assert!(stuck.still_runs(), "the process under it that could not be ended did not run");
        }

        #[test]
        fn a_process_under_it_that_exited_by_itself_counts_as_gone() {
            let mut root = Held::new();
            let root_handle = root.opened(END_RIGHTS);
            let mut exited = cmd().args(["/d", "/c", "exit", "7"]).creation_flags(NO_WINDOW).spawn().expect("start cmd.exe");
            assert_eq!(exited.wait().expect("wait for cmd.exe").code(), Some(7));
            // `exited` holds its handle, so the process can still be opened by its pid.
            let h = unsafe { OpenProcess(UNDER_RIGHTS, 0, exited.id()) } as usize;
            assert_ne!(h, 0, "open process {}: {}", exited.id(), io::Error::last_os_error());
            assert_eq!(unsafe { end_one(h, Instant::now() + FAILED_END_WAIT).0 }, Fate::Exited, "a process under it that exited by itself was read as one that may still run");
            let got = unsafe { end_checked(root_handle, root.pid(), vec![(exited.id(), h)]) };
            unsafe { close(root_handle) };
            assert!(got.is_ok(), "{got:?}");
            assert!(root.gone_soon(), "the process itself still ran 2 s after the end");
        }

        /// What a wait may come back early by: one tick of the system clock,
        /// with room to spare.
        const SLACK: Duration = Duration::from_millis(100);

        /// `cmd.exe` told to exit at once, started and not waited for: it
        /// exits by itself a few milliseconds on.
        fn exits_soon() -> Child {
            cmd().args(["/d", "/c", "exit", "7"]).creation_flags(NO_WINDOW).spawn().expect("start cmd.exe")
        }

        /// Process `pid`, opened without the right to end it, so its end
        /// fails as Windows fails one while the process's own exit is under
        /// way.
        fn opened_without_end(pid: u32) -> usize {
            let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid) } as usize;
            assert_ne!(h, 0, "open process {pid}: {}", io::Error::last_os_error());
            h
        }

        #[test]
        fn a_process_whose_end_fails_while_it_exits_by_itself_counts_as_exited() {
            let mut quick = exits_soon();
            let h = opened_without_end(quick.id());
            let before = exit_code(h);
            let fate = unsafe { end_one(h, Instant::now() + FAILED_END_WAIT).0 };
            unsafe { close(h) };
            let _ = quick.wait();
            assert!(matches!(before, Ok(None)), "it had exited before its end: this test cannot reach the rule ({before:?})");
            assert_eq!(fate, Fate::Exited, "a process that exited by itself within the end's wait was read as one that may still run");
        }

        #[test]
        fn a_root_whose_end_fails_while_it_exits_by_itself_still_has_what_was_found_under_it_ended() {
            let mut quick = exits_soon();
            let h = opened_without_end(quick.id());
            let mut under = Held::new();
            let opened = under.opened(UNDER_RIGHTS);
            let got = unsafe { end_checked(h, quick.id(), vec![(under.pid(), opened)]) };
            unsafe { close(h) };
            let _ = quick.wait();
            assert!(got.is_ok(), "{got:?}");
            assert!(under.gone_soon(), "the process found under it (process {}) still ran 2 s after the end", under.pid());
        }

        #[test]
        fn a_process_whose_end_fails_and_that_does_not_exit_still_runs_once_the_wait_is_over() {
            let mut stuck = Held::new();
            let h = opened_without_end(stuck.pid());
            let began = Instant::now();
            let fate = unsafe { end_one(h, began + FAILED_END_WAIT).0 };
            let took = began.elapsed();
            unsafe { close(h) };
            assert_eq!(fate, Fate::Runs, "a process that did not exit was read as gone");
            assert!(took >= FAILED_END_WAIT - SLACK, "it was read as one that still runs after {took:?}, before the wait was over");
            assert!(stuck.still_runs(), "the process was ended");
        }

        #[test]
        fn ends_that_fail_wait_one_bound_together_not_one_each() {
            let mut root = Held::new();
            let root_handle = root.opened(END_RIGHTS);
            let first = Held::new();
            let first_handle = opened_without_end(first.pid());
            let second = Held::new();
            let second_handle = opened_without_end(second.pid());
            let began = Instant::now();
            let got = unsafe { end_checked(root_handle, root.pid(), vec![(first.pid(), first_handle), (second.pid(), second_handle)]) };
            let took = began.elapsed();
            unsafe { close(root_handle) };
            let why = got.expect_err("it answered `ended` while two processes under it still ran").to_string();
            assert!(why.contains(&first.pid().to_string()) && why.contains(&second.pid().to_string()), "{why}");
            assert!(took >= FAILED_END_WAIT - SLACK, "the ends that failed did not wait: {took:?}");
            assert!(took < FAILED_END_WAIT + Duration::from_millis(500), "two ends that failed waited {took:?}, more than the one bound of {FAILED_END_WAIT:?} for the whole end");
            assert!(root.gone_soon(), "the process itself still ran 2 s after the end");
        }

        #[test]
        fn a_process_list_that_cannot_be_read_ends_nothing() {
            let mut root = Held::new();
            let h = root.opened(END_RIGHTS);
            let made = creation_time(h).expect("its creation time");
            let req = EndRequest { pid: root.pid(), created: app_created(made) };
            let got = unsafe { end_open_from(h, &req, || Err(io::Error::other("a list made to fail by a test"))) };
            assert!(got.is_err(), "{got:?}");
            assert!(root.still_runs(), "the process was ended although the processes under it could not be listed");
            // The control: with the list read, the same process is ended.
            let got = unsafe { end_open_from(h, &req, process_list) };
            unsafe { close(h) };
            assert_eq!(got.ok(), Some(true));
            assert!(root.gone_soon(), "the process still ran 2 s after the end");
        }

        #[test]
        fn the_process_list_has_a_process_this_test_started_under_it() {
            let held = Held::new();
            let (list, listed_at) = process_list().expect("the process list");
            assert!(listed_at > 0);
            assert!(list.iter().any(|&(pid, parent)| pid == held.pid() && parent == std::process::id()), "process {} is not listed under this test", held.pid());
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
    fn a_process_is_under_its_parent_only_when_made_between_the_parent_and_the_read_of_the_list() {
        let (parent, listed) = (134_078_000_000_000_000, 134_078_000_010_000_000);
        assert!(made_under(parent, parent, listed), "made as its parent was");
        assert!(made_under(parent + 5_000_000, parent, listed), "made in between");
        assert!(made_under(listed, parent, listed), "made as the list was read");
        assert!(!made_under(parent - 1, parent, listed), "made before its parent: the parent id has passed to another process");
        assert!(!made_under(listed + 1, parent, listed), "made after the list was read: it took a listed pid");
        assert!(!made_under(u64::MAX, parent, listed), "made long after the list was read");
    }

    #[test]
    fn only_no_more_files_ends_the_process_list_and_any_other_error_means_it_cannot_be_read() {
        assert_eq!(list_step(true, 0), ListStep::Entry);
        assert_eq!(list_step(true, NO_MORE_FILES), ListStep::Entry, "an entry is an entry, whatever error was left before");
        assert_eq!(list_step(false, NO_MORE_FILES), ListStep::End);
        // ERROR_SUCCESS, ERROR_ACCESS_DENIED, ERROR_INVALID_HANDLE, ERROR_NOT_ENOUGH_MEMORY,
        // ERROR_BAD_LENGTH, ERROR_INVALID_PARAMETER, ERROR_PARTIAL_COPY.
        for error in [0, 5, 6, 8, 24, 87, 299] {
            assert_eq!(list_step(false, error), ListStep::Failed, "error {error} was read as the end of the list");
        }
    }

    #[test]
    fn a_failed_end_is_a_process_gone_only_when_its_exit_code_says_it_exited() {
        assert_eq!(Fate::of(true, false), Fate::Ended);
        assert_eq!(Fate::of(true, true), Fate::Ended);
        assert_eq!(Fate::of(false, true), Fate::Exited);
        assert_eq!(Fate::of(false, false), Fate::Runs);
        assert!(Fate::Ended.gone() && Fate::Exited.gone() && !Fate::Runs.gone());
    }

    #[test]
    fn it_answers_ended_only_when_none_of_the_processes_it_checked_still_runs() {
        let none: Vec<u32> = Vec::new();
        assert_eq!(still_running((10, Fate::Ended), &[]), none, "the process alone, ended");
        assert_eq!(still_running((10, Fate::Ended), &[(11, Fate::Ended), (12, Fate::Exited)]), none, "every process under it gone");
        assert_eq!(still_running((10, Fate::Exited), &[]), none, "it exited by itself after the check");
        assert_eq!(still_running((10, Fate::Exited), &[(11, Fate::Ended)]), none, "it exited by itself, and the process under it was ended");
        assert_eq!(still_running((10, Fate::Exited), &[(11, Fate::Runs), (12, Fate::Ended), (13, Fate::Runs)]), vec![11, 13], "processes under it still run");
        assert_eq!(still_running((10, Fate::Ended), &[(11, Fate::Runs)]), vec![11], "a process under it still runs");
        assert_eq!(still_running((10, Fate::Runs), &[]), vec![10], "it still runs");
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
