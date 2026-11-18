//! `aicc-helper console-hosts`: at the app's start, end the console hosts the
//! run before it left running when it was ended from outside. Windows only; on
//! macOS and Linux the mode refuses (protocol section 15, "Console hosts a run
//! left").
//!
//! ```text
//! aicc-helper console-hosts [--pid <n> --created <t>]
//! ```
//!
//! Each terminal tab of the app is a pseudoconsole, and Windows starts its
//! console host (`conhost.exe`, or node-pty's bundled `OpenConsole.exe` for a
//! tab that asks for it) as a child of the process that made it: the app's
//! main process. Only closing the pseudoconsole ends that host on purpose. When
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
//! is still running), when the process that has the pid now cannot be read,
//! or when the record is from before Windows last started.
//!
//! It also says which process started it, for the app to record: its parent
//! in the same list, by pid and creation time, which must be earlier than this
//! mode's own (an earlier one rules out a parent pid that has since passed on).
//! It prints one line, `{"pid":<n>,"created":"<t>","ended":<k>}`, `<t>` in the
//! form `start` prints (`start.rs`), and exits 0; a note for the app's log
//! goes to stderr. It exits 1 with a message on stderr when it cannot read its
//! own times, the process list or its parent, and 2 on a command line it cannot
//! read. No PowerShell and no WMI: it answers in milliseconds, a second more at
//! most when an end fails.
#![allow(unsafe_code)]

use crate::start::{app_created, Refusal};
use std::process::ExitCode;

const USAGE: &str = "usage: aicc-helper console-hosts [--pid <n> --created <t>]";

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
/// creation time `old_created` (the app's form, in microseconds), so after it
/// started, and before `before`: the earlier of this mode's own creation time
/// and the creation time of a process that has the recorded pid now.
pub fn left_by_old_run(made: u64, old_created: u64, before: u64) -> bool {
    app_created(made) > old_created && made < before
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
    match run(&req) {
        Ok((answer, notes)) => {
            for note in notes {
                eprintln!("aicc-helper: note: {note}");
            }
            println!("{}", answer.to_json());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("aicc-helper: console-hosts: {e}");
            ExitCode::from(1)
        }
    }
}

/// Do what `req` asks (see the module comment): the answer and the notes for
/// the app's log. Windows only.
#[cfg(not(windows))]
pub fn run(_req: &ConsoleHostsRequest) -> std::io::Result<(Answer, Vec<String>)> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "console-hosts is for Windows only"))
}

/// `aicc-helper __console-parent`, for the tests: a run with one terminal, as
/// the app has for a tab. Windows only.
#[cfg(not(windows))]
pub fn console_parent() -> ExitCode {
    eprintln!("aicc-helper: __console-parent is for Windows only");
    ExitCode::from(1)
}

#[cfg(windows)]
pub use self::win::{console_parent, run};

#[cfg(windows)]
mod win {
    use super::{before_boot, host_image_ok, is_host_name, left_by_old_run, Answer, ConsoleHostsRequest};
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
        GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    /// What a process is opened with to read its times and user, and wait on it.
    const READ_RIGHTS: u32 = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
    /// What a console host is opened with: the same, and the right to end it.
    const HOST_RIGHTS: u32 = READ_RIGHTS | PROCESS_TERMINATE;
    /// How long the mode waits, in all, for hosts whose end failed to finish
    /// exiting, as `end` does (`start.rs`).
    const FAILED_END_WAIT: Duration = Duration::from_secs(1);

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
        let answer = |ended: u32| Answer { pid: parent, created: app_created(parent_made), ended };

        let Some((old_pid, old_created)) = req.old else {
            return Ok((answer(0), notes));
        };
        if before_boot(old_created, boot_time()) {
            notes.push("the run before started before Windows last started, so nothing of it runs now".to_string());
            return Ok((answer(0), notes));
        }
        // Who has the recorded pid now. The run before itself, still running:
        // nothing is ended. The run before, gone but still held open by some
        // process: the pid has not passed on. Another process: only what was
        // made before it can name the run before as its parent.
        let mut before = self_made;
        match open(old_pid, READ_RIGHTS) {
            Ok(p) => {
                let made = creation_time(p.0)?;
                if app_created(made) == old_created {
                    if exit_code(p.0)?.is_none() {
                        notes.push(format!("the run before (process {old_pid}) is still running, so nothing was ended"));
                        return Ok((answer(0), notes));
                    }
                } else {
                    before = before.min(made);
                }
            }
            // ERROR_INVALID_PARAMETER: no process has the pid now.
            Err(e) if e == ERROR_INVALID_PARAMETER => {}
            Err(e) => {
                notes.push(format!("the process that has the pid of the run before ({old_pid}) cannot be read ({}), so nothing was ended", io::Error::from_raw_os_error(e as i32)));
                return Ok((answer(0), notes));
            }
        }

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
        let new_owner: u64 = 30_000_000;
        let this_mode: u64 = 90_000_000;
        let before = this_mode.min(new_owner);
        assert!(left_by_old_run(20_000_000, run, before));
        assert!(!left_by_old_run(40_000_000, run, before));
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
