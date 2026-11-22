//! `aicc-helper console-hosts`: at the app's start, end the console hosts the
//! run before it left running when it was ended from outside. Windows only; on
//! macOS and Linux the mode refuses (protocol section 15, "Console hosts a run
//! left"). `aicc-helper end-console-host`, below, ends the host of one
//! terminal of the running app whose program has ended (Windows only too).
//!
//! ```text
//! aicc-helper console-hosts [--pid <n> --created <t>]
//! ```
//!
//! Each terminal tab of the app is a pseudoconsole, and Windows starts its
//! console host (`conhost.exe`, or node-pty's bundled `OpenConsole.exe` for a
//! tab that asks for it) as a child of the process that made it: the app's
//! main process. Only closing the pseudoconsole ends that host on purpose
//! (and, once a terminal's program has ended, `end-console-host` below). When
//! the app is ended from outside (Task Manager, a crash), nothing closes it,
//! and on some Windows builds the host keeps running, idle, until sign-out
//! (measured on the test VM, aicc_planning #330).
//!
//! So the app records its own pid and creation time at start-up, and at the
//! next start runs this mode with that record. The mode reads its own creation
//! time, then the process list once, and ends each process that is:
//!   - named `conhost.exe` or `OpenConsole.exe`, and its program file is
//!     Windows' own `System32\conhost.exe`, or a file named `OpenConsole.exe`;
//!   - listed with the recorded pid as its parent;
//!   - made in a later microsecond than the recorded creation time, so after
//!     that run started, and before both this mode's own creation time and the
//!     creation time of any process that has the recorded pid now: a pid passes
//!     on only once its process has gone, so a process made after its new
//!     owner was made names that owner as its parent, not the run before;
//!   - of the user this mode runs as.
//! Each is held open from its check to its end, so its pid cannot pass to
//! another process in between. Nothing is ended when the recorded pid still
//! has the recorded creation time and that process still runs (the run before
//! is still running), when the process that has the pid now cannot be opened
//! or read (its creation time, or whether it still runs), or when the record
//! is from before Windows last started (`bound_from_pid_owner`, `before_boot`).
//! Each of those answers 0 ended, with a note, and exits 0, so the app still
//! records this run.
//!
//! It also says which process started it, for the app to record: its parent
//! in the same list, by pid and creation time, which must be earlier than this
//! mode's own (an earlier one rules out a parent pid that has since passed on).
//! It prints one line, `{"pid":<n>,"created":"<t>","ended":<k>}`, `<t>` in the
//! form `start` prints (`start.rs`), and exits 0; a note for the app's log
//! goes to stderr. It exits 1 with a message on stderr, ending nothing, when
//! it cannot read its own creation time or its own user, the process list,
//! the process that started it, or the system folder (where Windows' own
//! `conhost.exe` is); the app then does not record this run. It exits 2 on a
//! command line it cannot read. No PowerShell and no WMI: it answers in
//! milliseconds, a second more at most when an end fails.
//!
//! ```text
//! aicc-helper end-console-host --made-from <t> --made-to <t>
//! ```
//!
//! While the app runs: end the console host of one of its terminals whose
//! program has ended (aicc_planning #363). On Windows' own ConPTY that host
//! ends only when the pseudoconsole is closed, and node-pty (1.2.0-beta.15,
//! its `conpty.cc`) forgets the pseudoconsole, unclosed, as soon as its
//! program exits, so the kill that follows closes nothing and the host runs
//! until the app quits. node-pty's bundled ConPTY ends its host with the
//! program. So the app times each terminal it starts on Windows' own ConPTY,
//! just before and just after node-pty makes the pseudoconsole (and with it
//! the host), and runs this mode with that time once node-pty has reported
//! the program's exit. The app's clock (Date.now() in Electron's main
//! process) can run up to one Windows clock tick (15.6 ms by default) behind
//! the clock Windows stamps creation times with, so the app widens the time
//! by 50 ms on each side, and the time can then hold the host of a terminal
//! started just before or after. The time does not keep a running terminal's
//! host: the last two rules below do. `<t>` is in steps of 100 ns since 1601
//! (UTC); `--made-to` is not included, and it is after `--made-from` by at
//! most `MAX_START_SPAN`. The mode reads its own creation time, then the
//! process list once, and ends the one process that is:
//!   - named `conhost.exe`, and its program file is Windows' own
//!     `System32\conhost.exe`;
//!   - listed with the process that started this mode as its parent;
//!   - made in that time, after that process was made and before this mode
//!     was (`made_by_start`);
//!   - still running, and of the user this mode runs as;
//!   - made at least `NEW_HOST_WAIT` (6 s) before this mode (`old_enough`):
//!     node-pty gives a terminal's program 5 s to start in its pseudoconsole,
//!     and until it has, a running terminal's host has no program;
//!   - the console host of no process that still runs (`host_pid_of`): a
//!     host that still has a program is never ended.
//! It is held open from its check to its end, so its pid cannot pass to
//! another process in between. When no process is all of that, or more than
//! one is (two terminals started in that time whose programs have both
//! ended), nothing is ended. Nothing is ended either when a process that
//! still runs, and could be opened, cannot be read for its console host: a
//! process that cannot be opened is not read (a terminal's program is this
//! user's, and can be). It prints the same line as `console-hosts`, naming
//! the process that started it, with `ended` 0 or 1, and exits 0; a note goes
//! to stderr. It exits 1, ending nothing, when it cannot read its own creation
//! time or its own user, the process list, the process that started it, or
//! the system folder, and 2 on a command line it cannot read.
#![allow(unsafe_code)]

use crate::start::{app_created, Refusal};
use std::process::ExitCode;

const USAGE: &str = "usage: aicc-helper console-hosts [--pid <n> --created <t>]";
const END_USAGE: &str = "usage: aicc-helper end-console-host --made-from <t> --made-to <t>";

/// The longest one terminal's start may take for `end-console-host`: ten
/// seconds, in steps of 100 ns. node-pty makes a pseudoconsole in
/// milliseconds; a longer time is not one start's.
pub const MAX_START_SPAN: u64 = 10 * 10_000_000;

/// When the app started one terminal: from `from`, included, to `to`, not
/// included, in steps of 100 ns since 1601 (UTC).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartTime {
    pub from: u64,
    pub to: u64,
}

/// The run before, as the app recorded it: its main process's pid and
/// creation time, in the form `start` prints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConsoleHostsRequest {
    pub old: Option<(u32, u64)>,
}

/// What the mode found: the process that started it (its pid and creation
/// time, for the app to record) and how many console hosts it ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Answer {
    pub pid: u32,
    pub created: u64,
    pub ended: u32,
}

impl Answer {
    /// The one line the mode prints.
    pub fn to_json(&self) -> String {
        format!("{{\"pid\":{},\"created\":\"{}\",\"ended\":{}}}", self.pid, self.created, self.ended)
    }
}

/// The console hosts' image names: Windows' own, and node-pty's bundled ConPTY.
pub const HOST_NAMES: [&str; 2] = ["conhost.exe", "OpenConsole.exe"];

/// Whether a process list entry's image name is a console host's.
pub fn is_host_name(name: &str) -> bool {
    HOST_NAMES.iter().any(|h| name.eq_ignore_ascii_case(h))
}

/// Whether the program file of a process listed as `name` is that console
/// host's: `system_conhost` (Windows' own `System32\conhost.exe`) for
/// `conhost.exe`, any file named `OpenConsole.exe` for `OpenConsole.exe`.
pub fn host_image_ok(name: &str, image: &str, system_conhost: &str) -> bool {
    if name.eq_ignore_ascii_case(HOST_NAMES[0]) {
        return image.eq_ignore_ascii_case(system_conhost);
    }
    if name.eq_ignore_ascii_case(HOST_NAMES[1]) {
        let file = image.rsplit(|c| c == '\\' || c == '/').next().unwrap_or("");
        return file.eq_ignore_ascii_case(HOST_NAMES[1]);
    }
    false
}

/// Whether a console host made at `made` (steps of 100 ns since 1601, UTC)
/// is one the run before left: made in a later microsecond than that run's
/// creation time `old_created` (the app's form: steps of 100 ns since 1601,
/// to the microsecond, `start.rs` `app_created`), so after it started, and
/// before `before`: the earlier of this mode's own creation time and the
/// creation time of a process that has the recorded pid now
/// (`bound_from_pid_owner`).
pub fn left_by_old_run(made: u64, old_created: u64, before: u64) -> bool {
    app_created(made) > old_created && made < before
}

/// Who has the recorded pid now, as this mode found when it opened that pid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PidOwner {
    /// No process has it.
    Nobody,
    /// The run before itself, which has the recorded creation time:
    /// `running` when it has not exited (otherwise something still holds a
    /// handle to it, so the pid has not passed on).
    RunBefore { running: bool },
    /// Another process, made at `made` (steps of 100 ns since 1601).
    Other { made: u64 },
    /// A process has it, but it could not be opened, or its creation time or
    /// whether it still runs could not be read: why.
    Unreadable(String),
}

/// What follows from who has the recorded pid now: the bound on when a
/// console host must have been made to count (`left_by_old_run`'s `before`),
/// or, when nothing may be ended, the note that says why. `self_made` is this
/// mode's own creation time. A pid passes on only once its process has gone,
/// so a process made after the pid's new owner names that owner as its
/// parent, not the run before: the bound is the earlier of the two times.
pub fn bound_from_pid_owner(owner: &PidOwner, old_pid: u32, self_made: u64) -> Result<u64, String> {
    match owner {
        PidOwner::Nobody | PidOwner::RunBefore { running: false } => Ok(self_made),
        PidOwner::RunBefore { running: true } => Err(format!("the run before (process {old_pid}) is still running, so nothing was ended")),
        PidOwner::Other { made } => Ok(self_made.min(*made)),
        PidOwner::Unreadable(why) => Err(format!("the process that has the pid of the run before ({old_pid}) cannot be read ({why}), so nothing was ended")),
    }
}

/// How far a recorded creation time may lie before the time Windows started
/// (as read from the time since then) and still be taken for this boot: a
/// minute, in steps of 100 ns, for a clock moved a little since.
pub const BOOT_SLACK: u64 = 60 * 10_000_000;

/// Whether the run before started before Windows did (at `boot`, steps of
/// 100 ns since 1601): then nothing of it runs now.
pub fn before_boot(old_created: u64, boot: u64) -> bool {
    old_created.saturating_add(BOOT_SLACK) < boot
}

fn usage<T>(what: &str) -> Result<T, Refusal> {
    Err(Refusal::Usage(what.to_string()))
}

/// `v` as a number when it is 1 to `max_digits` ASCII digits that fit a u64.
fn digits(v: &str, max_digits: usize) -> Option<u64> {
    if v.is_empty() || v.len() > max_digits || !v.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    v.parse::<u64>().ok()
}

/// Read a `console-hosts` command line (what follows `console-hosts`):
/// nothing, or `--pid` and `--created` together, each once, as plain digits.
pub fn parse(args: &[String]) -> Result<ConsoleHostsRequest, Refusal> {
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
        (Some(pid), Some(created)) => Ok(ConsoleHostsRequest { old: Some((pid, created)) }),
        (None, None) => Ok(ConsoleHostsRequest { old: None }),
        _ => usage("--pid and --created go together"),
    }
}

/// Read an `end-console-host` command line (what follows `end-console-host`):
/// `--made-from` and `--made-to`, each once, as plain digits, `--made-to`
/// after `--made-from` by at most `MAX_START_SPAN`.
pub fn parse_end(args: &[String]) -> Result<StartTime, Refusal> {
    let mut from: Option<u64> = None;
    let mut to: Option<u64> = None;
    let mut i = 0;
    while let Some(option) = args.get(i) {
        let value = match args.get(i + 1) {
            Some(v) => v.as_str(),
            None => return usage(format!("{option} needs a value").as_str()),
        };
        let slot = match option.as_str() {
            "--made-from" => &mut from,
            "--made-to" => &mut to,
            other => return usage(format!("unknown option {other}").as_str()),
        };
        if slot.is_some() {
            return usage(format!("{option} is given twice").as_str());
        }
        match digits(value, 20) {
            Some(n) => *slot = Some(n),
            None => return usage(format!("{option} must be a time: 1 to 20 digits").as_str()),
        }
        i += 2;
    }
    let (Some(from), Some(to)) = (from, to) else {
        return usage("end-console-host needs --made-from and --made-to");
    };
    if to <= from || to - from > MAX_START_SPAN {
        return usage("--made-to must be after --made-from, by ten seconds at most");
    }
    Ok(StartTime { from, to })
}

/// Whether a console host made at `made` is one the start `when` made: in
/// that time, after the process that started this mode was made
/// (`parent_made`; a host made earlier names a parent pid that has since
/// passed on) and before this mode was (`self_made`). All in steps of 100 ns
/// since 1601 (UTC).
pub fn made_by_start(made: u64, when: &StartTime, parent_made: u64, self_made: u64) -> bool {
    made >= when.from && made < when.to && made > parent_made && made < self_made
}

/// How old a console host must be before `end-console-host` ends it: six
/// seconds, in steps of 100 ns. node-pty gives a terminal's program 5 s to
/// start in its pseudoconsole (`CONNECTION_TIMEOUT`, its
/// `windowsPtyAgent.js`), and until it has, a running terminal's host has no
/// program; a second more is slack. The app asks no sooner than this after a
/// terminal's start (`src/main/console-host-end.ts`, `NEW_HOST_WAIT_MS`).
pub const NEW_HOST_WAIT: u64 = 6 * 10_000_000;

/// Whether a console host made at `made` is old enough for `end-console-host`
/// to end: made at least `NEW_HOST_WAIT` before this mode was (`self_made`).
/// Both in steps of 100 ns since 1601 (UTC).
pub fn old_enough(made: u64, self_made: u64) -> bool {
    made.saturating_add(NEW_HOST_WAIT) <= self_made
}

/// The pid of a process's console host in what Windows answers for its
/// `ProcessConsoleHostProcess` (NtQueryInformationProcess, class 49): the
/// value with its two low bits, which are flags, cleared. 0: it has none (a
/// value too big for a pid names no process either).
pub fn host_pid_of(value: usize) -> u32 {
    u32::try_from(value & !3).unwrap_or(0)
}

/// A mode's answer, or why it has none, as its output and exit status.
fn answer_out(mode: &str, result: std::io::Result<(Answer, Vec<String>)>) -> ExitCode {
    match result {
        Ok((answer, notes)) => {
            for note in notes {
                eprintln!("aicc-helper: note: {note}");
            }
            println!("{}", answer.to_json());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("aicc-helper: {mode}: {e}");
            ExitCode::from(1)
        }
    }
}

/// `aicc-helper console-hosts ...`: the command, with its output and exit status.
pub fn command(args: &[String]) -> ExitCode {
    if cfg!(not(windows)) {
        eprintln!("aicc-helper: console-hosts is for Windows only");
        return ExitCode::from(1);
    }
    let req = match parse(args) {
        Ok(r) => r,
        Err(Refusal::Usage(why)) | Err(Refusal::Refused(why)) => {
            eprintln!("aicc-helper: {why}");
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    answer_out("console-hosts", run(&req))
}

/// `aicc-helper end-console-host ...`: the command, with its output and exit status.
pub fn end_command(args: &[String]) -> ExitCode {
    if cfg!(not(windows)) {
        eprintln!("aicc-helper: end-console-host is for Windows only");
        return ExitCode::from(1);
    }
    let when = match parse_end(args) {
        Ok(w) => w,
        Err(Refusal::Usage(why)) | Err(Refusal::Refused(why)) => {
            eprintln!("aicc-helper: {why}");
            eprintln!("{END_USAGE}");
            return ExitCode::from(2);
        }
    };
    answer_out("end-console-host", end_one(&when))
}

/// Do what `req` asks (see the module comment): the answer and the notes for
/// the app's log. Windows only.
#[cfg(not(windows))]
pub fn run(_req: &ConsoleHostsRequest) -> std::io::Result<(Answer, Vec<String>)> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "console-hosts is for Windows only"))
}

/// End the console host the start `when` made (see the module comment): the
/// answer and the notes for the app's log. Windows only.
#[cfg(not(windows))]
pub fn end_one(_when: &StartTime) -> std::io::Result<(Answer, Vec<String>)> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "end-console-host is for Windows only"))
}

/// `aicc-helper __console-parent`, for the tests: a run with one terminal, as
/// the app has for a tab. Windows only.
#[cfg(not(windows))]
pub fn console_parent() -> ExitCode {
    eprintln!("aicc-helper: __console-parent is for Windows only");
    ExitCode::from(1)
}

#[cfg(windows)]
pub use self::win::{console_parent, end_one, run};

#[cfg(windows)]
mod win {
    use super::{
        before_boot, bound_from_pid_owner, host_image_ok, host_pid_of, is_host_name, left_by_old_run, made_by_start, old_enough, Answer, ConsoleHostsRequest, PidOwner, StartTime,
        HOST_NAMES,
    };
    use crate::start::{app_created, list_step, ListStep};
    use crate::winproc::{close, creation_time, exit_code, exit_code_within, os_error};
    use std::ffi::c_void;
    use std::io;
    use std::process::ExitCode;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::{EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows_sys::Win32::System::SystemInformation::{GetSystemDirectoryW, GetSystemTimePreciseAsFileTime, GetTickCount64};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_INFORMATION,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    /// What a process is opened with to read its times and user, and wait on it.
    const READ_RIGHTS: u32 = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
    /// What a console host is opened with: the same, and the right to end it.
    const HOST_RIGHTS: u32 = READ_RIGHTS | PROCESS_TERMINATE;
    /// How long the mode waits, in all, for hosts whose end failed to finish
    /// exiting, as `end` does (`start.rs`).
    const FAILED_END_WAIT: Duration = Duration::from_secs(1);
    /// `ProcessConsoleHostProcess`: the information class NtQueryInformationProcess
    /// answers a process's console host for (`host_pid_of`).
    const PROCESS_CONSOLE_HOST_PROCESS: u32 = 49;

    #[link(name = "ntdll", kind = "raw-dylib")]
    unsafe extern "system" {
        fn NtQueryInformationProcess(process: HANDLE, class: u32, info: *mut c_void, length: u32, returned: *mut u32) -> i32;
    }

    /// An open handle, closed when dropped.
    struct Owned(usize);

    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { close(self.0) };
        }
    }

    /// `pid` opened with `rights`, or the error Windows gave.
    fn open(pid: u32, rights: u32) -> Result<Owned, u32> {
        let h = unsafe { OpenProcess(rights, 0, pid) } as usize;
        if h == 0 {
            Err(unsafe { GetLastError() })
        } else {
            Ok(Owned(h))
        }
    }

    /// The system time now, in steps of 100 ns since 1601 (UTC).
    fn now() -> u64 {
        let mut t = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        unsafe { GetSystemTimePreciseAsFileTime(&mut t) };
        (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)
    }

    /// When Windows last started, from the time since then (milliseconds).
    fn boot_time() -> u64 {
        let since = unsafe { GetTickCount64() };
        now().saturating_sub(since.saturating_mul(10_000))
    }

    /// The TOKEN_USER of the process behind `process`: its user's SID, in
    /// u64 storage so the SID in it is aligned.
    fn user_of(process: usize) -> io::Result<Vec<u64>> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(process as HANDLE, TOKEN_QUERY, &mut token) == 0 {
                return Err(os_error("OpenProcessToken"));
            }
            let token = Owned(token as usize);
            let mut len: u32 = 0;
            // The first call only says how big the answer is.
            GetTokenInformation(token.0 as HANDLE, TokenUser, std::ptr::null_mut(), 0, &mut len);
            if len == 0 {
                return Err(os_error("GetTokenInformation (size)"));
            }
            let mut buf: Vec<u64> = vec![0; (len as usize + 7) / 8];
            if GetTokenInformation(token.0 as HANDLE, TokenUser, buf.as_mut_ptr() as *mut c_void, len, &mut len) == 0 {
                return Err(os_error("GetTokenInformation"));
            }
            Ok(buf)
        }
    }

    /// Whether two TOKEN_USER buffers (`user_of`) name the same user.
    fn same_user(a: &[u64], b: &[u64]) -> bool {
        unsafe {
            let sa = (*(a.as_ptr() as *const TOKEN_USER)).User.Sid;
            let sb = (*(b.as_ptr() as *const TOKEN_USER)).User.Sid;
            EqualSid(sa, sb) != 0
        }
    }

    /// The full path of the program file of the process behind `process`.
    fn image_of(process: usize) -> io::Result<String> {
        let mut buf = vec![0u16; 32_768];
        let mut len = buf.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process as HANDLE, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) } == 0 {
            return Err(os_error("QueryFullProcessImageNameW"));
        }
        Ok(String::from_utf16_lossy(&buf[..len as usize]))
    }

    /// Windows' own console host: `conhost.exe` in the system folder.
    fn system_conhost() -> io::Result<String> {
        let mut buf = vec![0u16; 1024];
        let n = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
        if n == 0 || n >= buf.len() {
            return Err(os_error("GetSystemDirectoryW"));
        }
        Ok(format!("{}\\conhost.exe", String::from_utf16_lossy(&buf[..n])))
    }

    /// Every process now, as (pid, parent pid, image name), from one read of
    /// the process list. An error when the list cannot be read in full: the
    /// snapshot fails, or reading an entry fails with any error but the end of
    /// the list (`list_step`).
    fn process_list() -> io::Result<Vec<(u32, u32, String)>> {
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return Err(os_error("CreateToolhelp32Snapshot"));
            }
            let snap = Owned(snap as usize);
            let mut list = Vec::new();
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut got = Process32FirstW(snap.0 as HANDLE, &mut entry) != 0;
            loop {
                let error = if got { 0 } else { GetLastError() };
                match list_step(got, error) {
                    ListStep::Entry => {
                        let n = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
                        list.push((entry.th32ProcessID, entry.th32ParentProcessID, String::from_utf16_lossy(&entry.szExeFile[..n])));
                    }
                    ListStep::End => return Ok(list),
                    ListStep::Failed => {
                        let e = io::Error::from_raw_os_error(error as i32);
                        return Err(io::Error::new(e.kind(), format!("the process list: {e}")));
                    }
                }
                got = Process32NextW(snap.0 as HANDLE, &mut entry) != 0;
            }
        }
    }

    /// What is left until `until`, in milliseconds rounded up, as a wait takes it.
    fn ms_until(until: Instant) -> u32 {
        let left = until.saturating_duration_since(Instant::now()).as_micros().div_ceil(1000);
        u32::try_from(left).unwrap_or(u32::MAX - 1).min(u32::MAX - 1)
    }

    /// The process that started this mode: its parent in `list`, by pid and
    /// creation time, made before this mode was (`self_made`).
    fn started_by(list: &[(u32, u32, String)], me_pid: u32, self_made: u64) -> io::Result<(u32, u64)> {
        let parent = match list.iter().find(|(pid, _, _)| *pid == me_pid) {
            Some((_, parent, _)) => *parent,
            None => return Err(io::Error::other("this process is not in the process list")),
        };
        let parent_made = match open(parent, READ_RIGHTS) {
            Ok(p) => creation_time(p.0)?,
            Err(e) => return Err(io::Error::other(format!("the process that started this one ({parent}) cannot be read: {}", io::Error::from_raw_os_error(e as i32)))),
        };
        if parent_made > self_made {
            return Err(io::Error::other(format!("process {parent} was made after this one, so it did not start it")));
        }
        Ok((parent, parent_made))
    }

    /// The pid of the console host of the process behind `process`
    /// (`host_pid_of`; 0 when it has none), or the status Windows gave when
    /// it cannot be read.
    fn console_host_of(process: usize) -> Result<u32, i32> {
        let mut value: usize = 0;
        let size = std::mem::size_of::<usize>() as u32;
        let status = unsafe { NtQueryInformationProcess(process as HANDLE, PROCESS_CONSOLE_HOST_PROCESS, (&mut value as *mut usize).cast(), size, std::ptr::null_mut()) };
        if status < 0 {
            return Err(status);
        }
        Ok(host_pid_of(value))
    }

    /// The console hosts that still have a program: the console host of each
    /// process in `list` that still runs. A process that cannot be opened is
    /// not read (a terminal's program is this user's, and can be). One that
    /// has exited, still listed while a handle to it is open, has left its
    /// host. Err, saying why, when a process that still runs, and could be
    /// opened, cannot be read: then no host can be said to have no program.
    fn hosts_with_a_program(list: &[(u32, u32, String)]) -> Result<Vec<u32>, String> {
        let mut hosts: Vec<u32> = Vec::new();
        for (pid, _, _) in list {
            if *pid == 0 {
                continue;
            }
            let Ok(p) = open(*pid, READ_RIGHTS) else { continue };
            match exit_code(p.0) {
                Ok(None) => {}
                Ok(Some(_)) => continue,
                Err(e) => return Err(format!("whether process {pid} still runs could not be read ({e})")),
            }
            let host = match console_host_of(p.0) {
                Ok(host) => host,
                // Read again with the full right to read a process, for a
                // Windows that asks for it; one that cannot be opened with it
                // is not read.
                Err(_) => match open(*pid, PROCESS_QUERY_INFORMATION) {
                    Ok(full) => console_host_of(full.0).map_err(|status| format!("the console host of process {pid} could not be read (status {status:#x})"))?,
                    Err(_) => continue,
                },
            };
            // No console host, or one that names itself.
            if host != 0 && host != *pid {
                hosts.push(host);
            }
        }
        Ok(hosts)
    }

    /// See `end-console-host` in the module comment.
    pub fn end_one(when: &StartTime) -> io::Result<(Answer, Vec<String>)> {
        let mut notes: Vec<String> = Vec::new();
        // GetCurrentProcess is a pseudo handle, never closed.
        let me = unsafe { GetCurrentProcess() } as usize;
        let self_made = creation_time(me)?;
        let own_user = user_of(me)?;
        let list = process_list()?;
        let me_pid = std::process::id();
        let (parent, parent_made) = started_by(&list, me_pid, self_made)?;
        let answer = |ended: u32| Answer { pid: parent, created: app_created(parent_made), ended };
        let conhost = system_conhost()?;

        // Each one held open from its check to its end, so its pid cannot pass on.
        let mut found: Vec<(u32, Owned)> = Vec::new();
        for (pid, its_parent, name) in &list {
            if *its_parent != parent || *pid == me_pid || *pid == 0 || !name.eq_ignore_ascii_case(HOST_NAMES[0]) {
                continue;
            }
            let Ok(host) = open(*pid, HOST_RIGHTS) else { continue };
            let Ok(made) = creation_time(host.0) else { continue };
            if !made_by_start(made, when, parent_made, self_made) {
                continue;
            }
            // One that has exited, still listed while a handle to it is open, is not running.
            if !matches!(exit_code(host.0), Ok(None)) {
                continue;
            }
            match user_of(host.0) {
                Ok(user) if same_user(&user, &own_user) => {}
                _ => continue,
            }
            match image_of(host.0) {
                Ok(image) if host_image_ok(name, &image, &conhost) => {}
                _ => continue,
            }
            // Too new to tell: a running terminal's program may not have
            // started in it yet.
            if !old_enough(made, self_made) {
                notes.push(format!("the console host made in that time (process {pid}) was made less than 6 s ago, so it was not ended"));
                continue;
            }
            found.push((*pid, host));
        }
        if found.is_empty() {
            return Ok((answer(0), notes));
        }
        // The time can hold the host of a terminal that still runs (the app's
        // clock is not quite Windows' one): a host that still has a program is
        // never ended.
        let in_use = match hosts_with_a_program(&list) {
            Ok(hosts) => hosts,
            Err(why) => {
                notes.push(format!("{why}, so no console host was ended"));
                return Ok((answer(0), notes));
            }
        };
        found.retain(|(pid, _)| {
            let has_program = in_use.contains(pid);
            if has_program {
                notes.push(format!("the console host made in that time (process {pid}) still has a program, so it was not ended"));
            }
            !has_program
        });
        if found.len() > 1 {
            notes.push(format!("{} console hosts were made in that time, so none was ended", found.len()));
            return Ok((answer(0), notes));
        }
        let Some((pid, host)) = found.pop() else {
            return Ok((answer(0), notes));
        };
        if unsafe { TerminateProcess(host.0 as HANDLE, 1) } != 0 {
            return Ok((answer(1), notes));
        }
        // Windows refuses to end a process whose own exit is under way; one
        // that has not exited within the wait still runs.
        if !matches!(exit_code_within(host.0, ms_until(Instant::now() + FAILED_END_WAIT)), Ok(Some(_))) {
            notes.push(format!("the console host made in that time (process {pid}) could not be ended"));
        }
        Ok((answer(0), notes))
    }

    /// See the module comment.
    pub fn run(req: &ConsoleHostsRequest) -> io::Result<(Answer, Vec<String>)> {
        let mut notes: Vec<String> = Vec::new();
        // GetCurrentProcess is a pseudo handle, never closed.
        let me = unsafe { GetCurrentProcess() } as usize;
        let self_made = creation_time(me)?;
        let own_user = user_of(me)?;
        let list = process_list()?;
        let me_pid = std::process::id();

        // The process that started this mode: its parent in the list, made
        // before this mode was.
        let (parent, parent_made) = started_by(&list, me_pid, self_made)?;
        let answer = |ended: u32| Answer { pid: parent, created: app_created(parent_made), ended };

        let Some((old_pid, old_created)) = req.old else {
            return Ok((answer(0), notes));
        };
        if before_boot(old_created, boot_time()) {
            notes.push("the run before started before Windows last started, so nothing of it runs now".to_string());
            return Ok((answer(0), notes));
        }
        // Who has the recorded pid now, and what that allows (bound_from_pid_owner).
        let owner = match open(old_pid, READ_RIGHTS) {
            Ok(p) => match creation_time(p.0) {
                Err(e) => PidOwner::Unreadable(e.to_string()),
                Ok(made) if app_created(made) != old_created => PidOwner::Other { made },
                Ok(_) => match exit_code(p.0) {
                    Ok(code) => PidOwner::RunBefore { running: code.is_none() },
                    Err(e) => PidOwner::Unreadable(e.to_string()),
                },
            },
            // ERROR_INVALID_PARAMETER: no process has the pid now.
            Err(e) if e == ERROR_INVALID_PARAMETER => PidOwner::Nobody,
            Err(e) => PidOwner::Unreadable(io::Error::from_raw_os_error(e as i32).to_string()),
        };
        let before = match bound_from_pid_owner(&owner, old_pid, self_made) {
            Ok(before) => before,
            Err(note) => {
                notes.push(note);
                return Ok((answer(0), notes));
            }
        };

        let conhost = system_conhost()?;
        let until = Instant::now() + FAILED_END_WAIT;
        let mut ended: u32 = 0;
        let mut still: Vec<String> = Vec::new();
        for (pid, its_parent, name) in &list {
            if *its_parent != old_pid || *pid == me_pid || *pid == 0 || !is_host_name(name) {
                continue;
            }
            // Held open from here to its end, so its pid cannot pass on.
            let Ok(host) = open(*pid, HOST_RIGHTS) else { continue };
            let Ok(made) = creation_time(host.0) else { continue };
            if !left_by_old_run(made, old_created, before) {
                continue;
            }
            match user_of(host.0) {
                Ok(user) if same_user(&user, &own_user) => {}
                _ => continue,
            }
            match image_of(host.0) {
                Ok(image) if host_image_ok(name, &image, &conhost) => {}
                _ => continue,
            }
            if unsafe { TerminateProcess(host.0 as HANDLE, 1) } != 0 {
                ended += 1;
            } else if !matches!(exit_code_within(host.0, ms_until(until)), Ok(Some(_))) {
                // Windows refuses to end a process whose own exit is under
                // way; one that has not exited within the wait still runs.
                still.push(pid.to_string());
            }
        }
        if !still.is_empty() {
            notes.push(format!("these console hosts the run before left could not be ended: {}", still.join(", ")));
        }
        Ok((answer(ended), notes))
    }

    /// One terminal on Windows' own ConPTY, with the helper's `__echo` child
    /// on it, as the app has for a tab; then `ready` on stdout, and a wait of
    /// up to two minutes to be ended. Not in a job, so ending it from outside
    /// leaves its console host as ending the app does.
    pub fn console_parent() -> ExitCode {
        let exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("aicc-helper: cannot find this program: {e}");
                return ExitCode::from(1);
            }
        };
        let argv = vec![exe.to_string_lossy().into_owned(), "__echo".to_string()];
        match crate::pty::Pty::spawn(&argv, crate::pty::PtySize::default()) {
            Ok((_pty, _output)) => {
                println!("ready");
                let _ = std::io::Write::flush(&mut std::io::stdout());
                std::thread::sleep(Duration::from_secs(120));
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("aicc-helper: could not open a terminal: {e}");
                ExitCode::from(1)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn it_takes_nothing_or_a_pid_and_a_creation_time_together() {
        assert_eq!(parse(&args(&[])), Ok(ConsoleHostsRequest { old: None }));
        assert_eq!(parse(&args(&["--pid", "4242", "--created", "133000000000000000"])), Ok(ConsoleHostsRequest { old: Some((4242, 133_000_000_000_000_000)) }));
        assert_eq!(parse(&args(&["--created", "7", "--pid", "8"])), Ok(ConsoleHostsRequest { old: Some((8, 7)) }));
        for bad in [
            &["--pid", "4242"][..],
            &["--created", "7"],
            &["--pid"],
            &["--pid", "0", "--created", "7"],
            &["--pid", "-1", "--created", "7"],
            &["--pid", "99999999999", "--created", "7"],
            &["--pid", "1", "--created", "x"],
            &["--pid", "1", "--created", "123456789012345678901"],
            &["--pid", "1", "--pid", "2", "--created", "7"],
            &["--app", "1"],
        ] {
            assert!(matches!(parse(&args(bad)), Err(Refusal::Usage(_))), "{bad:?} was taken");
        }
    }

    #[test]
    fn the_answer_is_one_line_the_app_reads() {
        assert_eq!(Answer { pid: 12, created: 133_000_000_000_000_010, ended: 2 }.to_json(), r#"{"pid":12,"created":"133000000000000010","ended":2}"#);
    }

    #[test]
    fn only_the_two_console_host_names_count() {
        for name in ["conhost.exe", "CONHOST.EXE", "OpenConsole.exe", "openconsole.EXE"] {
            assert!(is_host_name(name), "{name}");
        }
        for name in ["conhost", "conhost.exe.exe", "aicc-helper.exe", "cmd.exe", "OpenConsole", ""] {
            assert!(!is_host_name(name), "{name}");
        }
    }

    #[test]
    fn conhost_must_be_windows_own_and_open_console_must_be_named_so() {
        let sys = r"C:\Windows\system32\conhost.exe";
        assert!(host_image_ok("conhost.exe", r"C:\Windows\System32\conhost.exe", sys));
        assert!(!host_image_ok("conhost.exe", r"C:\Users\me\Downloads\conhost.exe", sys));
        assert!(host_image_ok("OpenConsole.exe", r"C:\Program Files\AI Code Conductor\resources\conpty\OpenConsole.exe", sys));
        assert!(!host_image_ok("OpenConsole.exe", r"C:\x\other.exe", sys));
        assert!(!host_image_ok("cmd.exe", r"C:\Windows\System32\cmd.exe", sys));
    }

    #[test]
    fn a_host_counts_only_when_made_after_the_run_started_and_before_the_bound() {
        // The run started at 1 s; the bound (this mode's start, or the start
        // of a process that has the pid now) is at 5 s.
        let started = app_created(10_000_005);
        let before: u64 = 50_000_000;
        assert!(left_by_old_run(20_000_000, started, before));
        // The same microsecond as the run, or earlier: not after it started.
        assert!(!left_by_old_run(10_000_009, started, before));
        assert!(!left_by_old_run(9_000_000, started, before));
        // At the bound or after it: made by whatever has the pid now, or
        // after this mode started.
        assert!(!left_by_old_run(50_000_000, started, before));
        assert!(!left_by_old_run(60_000_000, started, before));
    }

    #[test]
    fn a_pid_that_passed_on_bounds_what_counts() {
        // The run before started at t=1 s, its pid passed to a process made
        // at t=3 s, and this mode started at t=9 s: a host made at t=4 s
        // names the new owner as its parent, not the run before.
        let run = app_created(10_000_000);
        let this_mode: u64 = 90_000_000;
        let before = bound_from_pid_owner(&PidOwner::Other { made: 30_000_000 }, 42, this_mode).expect("a bound");
        assert_eq!(before, 30_000_000);
        assert!(left_by_old_run(20_000_000, run, before));
        assert!(!left_by_old_run(40_000_000, run, before));
        // A new owner made after this mode bounds nothing more than this mode does.
        assert_eq!(bound_from_pid_owner(&PidOwner::Other { made: 95_000_000 }, 42, this_mode), Ok(this_mode));
    }

    #[test]
    fn whoever_has_the_pid_now_decides_whether_anything_is_ended() {
        let this_mode: u64 = 90_000_000;
        // Nobody, or the run before gone but still held open: up to this mode's start.
        assert_eq!(bound_from_pid_owner(&PidOwner::Nobody, 42, this_mode), Ok(this_mode));
        assert_eq!(bound_from_pid_owner(&PidOwner::RunBefore { running: false }, 42, this_mode), Ok(this_mode));
        // The run before, still running: nothing, with a note.
        let still = bound_from_pid_owner(&PidOwner::RunBefore { running: true }, 42, this_mode).expect_err("nothing is ended");
        assert!(still.contains("process 42") && still.contains("still running"), "{still}");
        // A process that has the pid but cannot be opened or read: nothing,
        // with a note saying why, never an error that would leave this run
        // unrecorded.
        let unread = bound_from_pid_owner(&PidOwner::Unreadable("Access is denied.".into()), 42, this_mode).expect_err("nothing is ended");
        assert!(unread.contains("(42) cannot be read (Access is denied.)"), "{unread}");
    }

    #[test]
    fn end_console_host_takes_a_start_time_of_ten_seconds_at_most() {
        let t: u64 = 133_000_000_000_000_000;
        assert_eq!(parse_end(&args(&["--made-from", &t.to_string(), "--made-to", &(t + 30_000).to_string()])), Ok(StartTime { from: t, to: t + 30_000 }));
        assert_eq!(parse_end(&args(&["--made-to", "9", "--made-from", "8"])), Ok(StartTime { from: 8, to: 9 }));
        assert_eq!(parse_end(&args(&["--made-from", "1", "--made-to", &(1 + MAX_START_SPAN).to_string()])), Ok(StartTime { from: 1, to: 1 + MAX_START_SPAN }));
        let over = (2 + MAX_START_SPAN).to_string();
        for bad in [
            &["--made-from", "8"][..],
            &[],
            &["--made-to", "9"],
            &["--made-from"],
            &["--made-from", "9", "--made-to", "9"],
            &["--made-from", "9", "--made-to", "8"],
            &["--made-from", "1", "--made-to", over.as_str()],
            &["--made-from", "x", "--made-to", "9"],
            &["--made-from", "-1", "--made-to", "9"],
            &["--made-from", "1", "--made-to", "123456789012345678901"],
            &["--made-from", "1", "--made-from", "2", "--made-to", "9"],
            &["--made-from", "1", "--made-to", "9", "--pid", "4"],
        ] {
            assert!(matches!(parse_end(&args(bad)), Err(Refusal::Usage(_))), "{bad:?} was taken");
        }
    }

    #[test]
    fn a_host_is_the_starts_only_when_made_in_its_time_after_the_app_and_before_this_mode() {
        let when = StartTime { from: 100, to: 200 };
        let (app, mode) = (50, 1_000);
        assert!(made_by_start(100, &when, app, mode));
        assert!(made_by_start(199, &when, app, mode));
        // Before the start, or at its end (not included): another start's.
        assert!(!made_by_start(99, &when, app, mode));
        assert!(!made_by_start(200, &when, app, mode));
        // Made before the process listed as its parent: that pid has passed on.
        assert!(!made_by_start(150, &when, 150, mode));
        assert!(!made_by_start(150, &when, 160, mode));
        // Made after this mode: not one the start made.
        assert!(!made_by_start(150, &when, app, 150));
        assert!(!made_by_start(150, &when, app, 140));
    }

    #[test]
    fn a_host_is_ended_only_once_it_is_six_seconds_old() {
        // node-pty gives a program 5 s to start in its pseudoconsole, and a
        // second more is slack.
        assert_eq!(NEW_HOST_WAIT, 60_000_000);
        let mode: u64 = 100 * 10_000_000;
        assert!(old_enough(mode - NEW_HOST_WAIT, mode));
        assert!(old_enough(mode - NEW_HOST_WAIT - 1, mode));
        assert!(old_enough(0, mode));
        assert!(!old_enough(mode - NEW_HOST_WAIT + 1, mode));
        assert!(!old_enough(mode, mode));
        assert!(!old_enough(mode + 1, mode));
        // A time near the end of the range does not wrap into "old".
        assert!(!old_enough(u64::MAX - 5, mode));
    }

    #[test]
    fn a_console_host_pid_is_read_without_its_two_flag_bits() {
        // Windows pids are multiples of 4; the two bits below are flags.
        assert_eq!(host_pid_of(0), 0);
        assert_eq!(host_pid_of(1), 0);
        assert_eq!(host_pid_of(3), 0);
        assert_eq!(host_pid_of(4244), 4244);
        assert_eq!(host_pid_of(4244 | 1), 4244);
        assert_eq!(host_pid_of(4244 | 2), 4244);
        assert_eq!(host_pid_of(4244 | 3), 4244);
        assert_eq!(host_pid_of(u32::MAX as usize), u32::MAX - 3);
    }

    #[test]
    fn a_record_from_before_windows_started_counts_for_nothing() {
        let boot: u64 = 200 * 10_000_000;
        assert!(before_boot(100 * 10_000_000, boot));
        assert!(!before_boot(boot, boot));
        assert!(!before_boot(boot - BOOT_SLACK, boot));
        assert!(before_boot(boot - BOOT_SLACK - 1, boot));
        assert!(!before_boot(300 * 10_000_000, boot));
    }
}
