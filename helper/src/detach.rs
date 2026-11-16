//! Start a copy of a program that outlives the process that started it: the
//! holder is that program (protocol section 5: "only the holder outlives a
//! connection"). On Windows the copy leaves the starter's job when the job
//! allows it; probe P7 (helper/probes/p7-windows-survival.ps1) showed a
//! holder started this way outlives the app and the installer. A job that
//! does not allow it keeps the copy, and the copy then ends with the job:
//! `Detached::in_starters_job` says which happened.
//!
//! The copy runs in the folder it is given, never the starter's, so it holds
//! no folder of the caller's open. Its standard error is a pipe the starter
//! reads, for a copy that fails before it is ready; once it is ready, the
//! copy writes nothing there.
//!
//! The copy keeps nothing else the starter had open. The app starts
//! `hold --detach` with every handle it lets a child inherit, and the holder
//! outlives the app, so a handle passed on would stay open for as long as
//! the holder runs. On Windows the copy is started with a list of the handles
//! it may inherit, which names only its standard error pipe; both starts, out
//! of the starter's job and inside it, use that list. On macOS and Linux the
//! holder closes every descriptor from 3 up as it starts
//! (`close_inherited_descriptors`): with `close_range` on Linux, else from
//! the system's listing, else every number up to its limits. That is done in
//! the holder and not between fork and exec, so the pipe std uses to report
//! a failed exec keeps working.
//!
//! The child is returned, never waited for by the caller once it is up, so
//! `hold --detach` can tell a holder that failed at once from one that runs.
#![allow(unsafe_code)]

use std::fs::File;
#[cfg(unix)]
use std::{io, path::Path, process::ExitStatus};

/// A started copy.
pub struct Detached {
    pub child: DetachedChild,
    /// True when the copy is still in the starter's job (Windows, a job that
    /// does not allow leaving it), so it ends when that job does.
    pub in_starters_job: bool,
}

/// The started copy, as `hold --detach` uses it: its process id, the read end
/// of its standard error, whether it has exited, and a way to end it.
pub struct DetachedChild {
    /// The read end of the copy's standard error, until it is taken.
    pub stderr: Option<File>,
    #[cfg(unix)]
    child: std::process::Child,
    /// The process handle, held as an integer (see `pty/windows.rs`).
    #[cfg(windows)]
    process: usize,
    #[cfg(windows)]
    pid: u32,
}

/// Start `program` with `args` in `dir` as a copy that outlives this process
/// (see the module comment).
#[cfg(unix)]
pub fn spawn_detached(program: &Path, args: &[String], dir: &Path) -> io::Result<Detached> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    // A new session: no terminal hangup and no process-group signal from the parent reaches it.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;
    let stderr = child.stderr.take().map(|s| File::from(std::os::fd::OwnedFd::from(s)));
    Ok(Detached { child: DetachedChild { stderr, child }, in_starters_job: false })
}

#[cfg(unix)]
impl DetachedChild {
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    pub fn kill(&mut self) -> io::Result<()> {
        self.child.kill()
    }
}

/// The ways the holder can find the descriptors it closes as it starts. It
/// tries them in the order of `ALL` (`close_inherited_descriptors`). A test
/// names one (`aicc-helper __close-check <way>`), so each way is run on every
/// OS that has it.
#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseWay {
    /// Linux `close_range` (kernel 5.9 and later): every descriptor from 3 up
    /// in one call, with nothing to list and no upper bound.
    Range,
    /// Every descriptor in the system's listing: `/proc/self/fd` on Linux,
    /// `/dev/fd` elsewhere.
    Listing,
    /// Every number from 3 up to the higher of the soft and hard limits on
    /// open descriptors, at most `MAX_EVERY_NUMBER`.
    EveryNumber,
}

/// Where the every-number way stops when the limits are higher, or have no
/// bound. Only a descriptor above this number, on a system with neither
/// `close_range` nor a listing, can stay open.
#[cfg(unix)]
pub const MAX_EVERY_NUMBER: i32 = 1 << 20;

#[cfg(unix)]
impl CloseWay {
    /// Every way, in the order the holder tries them.
    pub const ALL: [CloseWay; 3] = [CloseWay::Range, CloseWay::Listing, CloseWay::EveryNumber];

    /// The way a name on the command line means.
    pub fn named(name: &str) -> Option<CloseWay> {
        match name {
            "range" => Some(CloseWay::Range),
            "listing" => Some(CloseWay::Listing),
            "every-number" => Some(CloseWay::EveryNumber),
            _ => None,
        }
    }
}

/// Close every descriptor from 3 up. The holder calls this as it starts,
/// before it opens anything of its own: whatever its starter was given and
/// did not mark close-on-exec reaches it, and it runs for as long as its
/// session. Marking them close-on-exec would not do, because the holder
/// itself would still hold them.
#[cfg(unix)]
pub fn close_inherited_descriptors() {
    for way in CloseWay::ALL {
        if close_descriptors(way) {
            return;
        }
    }
}

/// Close every descriptor from 3 up one way. False when this system does
/// not have that way; nothing was closed then.
#[cfg(unix)]
pub fn close_descriptors(way: CloseWay) -> bool {
    match way {
        CloseWay::Range => close_range_from_3(),
        CloseWay::Listing => match open_descriptors() {
            Some(fds) => {
                for fd in fds.into_iter().filter(|fd| *fd > 2) {
                    // The listing's own descriptor is in the list and already
                    // closed; closing it again only fails.
                    unsafe {
                        libc::close(fd);
                    }
                }
                true
            }
            None => false,
        },
        CloseWay::EveryNumber => {
            for fd in 3..descriptor_limit() {
                unsafe {
                    libc::close(fd);
                }
            }
            true
        }
    }
}

/// The descriptors open in this process, from the system's own listing;
/// `None` when it cannot be read.
#[cfg(unix)]
fn open_descriptors() -> Option<Vec<i32>> {
    #[cfg(target_os = "linux")]
    const LISTING: &str = "/proc/self/fd";
    #[cfg(not(target_os = "linux"))]
    const LISTING: &str = "/dev/fd";
    let mut fds = Vec::new();
    for entry in std::fs::read_dir(LISTING).ok()? {
        let name = entry.ok()?.file_name();
        fds.push(name.to_str()?.parse::<i32>().ok()?);
    }
    Some(fds)
}

/// Close every descriptor from 3 up with Linux `close_range`; false when the
/// kernel does not have it (before 5.9).
#[cfg(target_os = "linux")]
fn close_range_from_3() -> bool {
    let first: libc::c_uint = 3;
    let last = libc::c_uint::MAX;
    let flags: libc::c_uint = 0;
    unsafe { libc::syscall(libc::SYS_close_range, first, last, flags) == 0 }
}

/// macOS has no `close_range`.
#[cfg(all(unix, not(target_os = "linux")))]
fn close_range_from_3() -> bool {
    false
}

/// Where closing every number stops: the higher of the soft and hard limits
/// on open descriptors, at most `MAX_EVERY_NUMBER`. Not the soft limit alone,
/// because a starter may lower it after it opened a descriptor above it.
#[cfg(unix)]
fn descriptor_limit() -> i32 {
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return MAX_EVERY_NUMBER;
    }
    limit.rlim_cur.max(limit.rlim_max).min(MAX_EVERY_NUMBER as libc::rlim_t) as i32
}

#[cfg(windows)]
mod win {
    use super::{Detached, DetachedChild};
    use crate::cmdline::build_command_line;
    use crate::winproc::{self, close, os_error, wide, AttrList, EXTENDED_STARTUPINFO_PRESENT, STARTF_USESTDHANDLES};
    use std::ffi::OsStr;
    use std::fs::File;
    use std::io;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::os::windows::process::ExitStatusExt;
    use std::path::Path;
    use std::process::ExitStatus;
    use windows_sys::Win32::Foundation::{SetHandleInformation, BOOL, HANDLE, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{CreateProcessW, TerminateProcess, PROCESS_INFORMATION, STARTUPINFOEXW};

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

    /// Start `program` with `args` in `dir` as a copy that outlives this
    /// process (see the module comment).
    ///
    /// Call it only while no other thread of this process starts a child.
    /// The write end of the copy's standard error pipe is inheritable while
    /// the copy starts, and std's `Command` takes a lock of its own for that
    /// moment that this code cannot take. A child another thread started then
    /// would inherit that end and keep the pipe open, and the starter would
    /// lose the copy's words if it failed before it was ready. The only
    /// caller, `hold --detach`, starts nothing else.
    pub fn spawn_detached(program: &Path, args: &[String], dir: &Path) -> io::Result<Detached> {
        let mut words = vec![program.to_string_lossy().into_owned()];
        words.extend(args.iter().cloned());
        let cmdline = build_command_line(&words);
        let app = wide(program);
        let cwd = wide(dir);
        unsafe {
            let mut err_read: HANDLE = std::mem::zeroed();
            let mut err_write: HANDLE = std::mem::zeroed();
            if CreatePipe(&mut err_read, &mut err_write, std::ptr::null(), 0) == 0 {
                return Err(os_error("CreatePipe (standard error)"));
            }
            let (err_read, err_write) = (err_read as usize, err_write as usize);
            // A handle in the list must be inheritable; only this end is, and
            // only until it is closed below.
            if SetHandleInformation(err_write as HANDLE, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == 0 {
                let e = os_error("SetHandleInformation");
                close(err_read);
                close(err_write);
                return Err(e);
            }
            let started = start(&app, &cmdline, &cwd, err_write);
            // The copy has its own end now, or nothing started: ours is closed
            // either way, so the pipe ends when the copy's end does.
            close(err_write);
            match started {
                Ok((process, pid, in_starters_job)) => {
                    let stderr = File::from_raw_handle(err_read as RawHandle);
                    Ok(Detached { child: DetachedChild { stderr: Some(stderr), process, pid }, in_starters_job })
                }
                Err(e) => {
                    close(err_read);
                    Err(e)
                }
            }
        }
    }

    /// Start the copy, letting it inherit `err_write` (as its standard error)
    /// and nothing else: the process handle, its id, and whether it is still
    /// in the starter's job.
    unsafe fn start(app: &[u16], cmdline: &str, cwd: &[u16], err_write: usize) -> io::Result<(usize, u32, bool)> {
        let mut attrs = AttrList::handle_list(&[err_write])?;
        let mut startup: STARTUPINFOEXW = std::mem::zeroed();
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        // Standard input and output are left null: the copy has none, and
        // writing to a null standard handle is quietly dropped.
        startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdError = err_write as HANDLE;
        startup.lpAttributeList = attrs.as_ptr() as _;
        // Leave the starter's job if it allows that, so ending the job does
        // not end the holder; a job that forbids it refuses the flag, and the
        // holder then starts without it, inside the job. Both starts use the
        // same handle list.
        let flags = EXTENDED_STARTUPINFO_PRESENT | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
        let created = match create(app, cmdline, cwd, &startup, flags | CREATE_BREAKAWAY_FROM_JOB) {
            Ok(info) => Ok((info, false)),
            // After the second start, whether the copy is in a job is asked,
            // not taken from which start worked: the first can fail for a
            // reason that is not the job. If the answer cannot be had, the
            // refusal is the best guess.
            Err(_) => create(app, cmdline, cwd, &startup, flags).map(|info| (info, in_a_job(info.hProcess as usize).unwrap_or(true))),
        };
        drop(attrs);
        let (info, in_starters_job) = created?;
        close(info.hThread as usize);
        Ok((info.hProcess as usize, info.dwProcessId, in_starters_job))
    }

    /// One `CreateProcessW` with handle inheritance limited to the list.
    unsafe fn create(app: &[u16], cmdline: &str, cwd: &[u16], startup: &STARTUPINFOEXW, flags: u32) -> io::Result<PROCESS_INFORMATION> {
        // CreateProcessW may write to the command line, so each try gets a fresh copy.
        let mut line = wide(OsStr::new(cmdline));
        let mut info: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessW(
            app.as_ptr(),
            line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            flags,
            std::ptr::null(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut info,
        );
        if ok == 0 {
            return Err(os_error("CreateProcessW"));
        }
        Ok(info)
    }

    /// Whether `process` runs inside any job.
    fn in_a_job(process: usize) -> io::Result<bool> {
        let mut inside: BOOL = 0;
        if unsafe { IsProcessInJob(process as HANDLE, std::ptr::null_mut(), &mut inside) } == 0 {
            return Err(os_error("IsProcessInJob"));
        }
        Ok(inside != 0)
    }

    impl DetachedChild {
        pub fn id(&self) -> u32 {
            self.pid
        }

        /// As std's `Child::try_wait`: `None` while the copy runs, and an
        /// error when the wait itself fails.
        pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            Ok(winproc::exit_code(self.process)?.map(ExitStatus::from_raw))
        }

        /// As std's `Child::kill`: a copy that has already exited is not an
        /// error.
        pub fn kill(&mut self) -> io::Result<()> {
            if unsafe { TerminateProcess(self.process as HANDLE, 1) } == 0 {
                let e = os_error("TerminateProcess");
                if let Ok(Some(_)) = winproc::exit_code(self.process) {
                    return Ok(());
                }
                return Err(e);
            }
            Ok(())
        }
    }

    impl Drop for DetachedChild {
        fn drop(&mut self) {
            unsafe {
                close(self.process);
            }
        }
    }
}

#[cfg(windows)]
pub use self::win::spawn_detached;

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    #[test]
    fn a_wait_that_fails_is_an_error_not_still_running() {
        // A null process handle: the wait fails at once.
        let mut child = DetachedChild { stderr: None, process: 0, pid: 0 };
        let waited = child.try_wait();
        assert!(waited.is_err(), "a wait that failed read as {waited:?}");
    }

    #[test]
    fn ending_a_copy_that_has_already_exited_is_not_an_error() {
        let cmd = PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot is set")).join("System32").join("cmd.exe");
        let args = ["/c", "exit", "7"].map(String::from);
        let mut child = spawn_detached(&cmd, &args, &std::env::temp_dir()).expect("start cmd.exe").child;
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = child.try_wait().expect("wait for cmd.exe") {
                break status;
            }
            assert!(Instant::now() < deadline, "cmd.exe did not exit");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(status.code(), Some(7));
        // As with std's `Child`, which this stands in for.
        let ended = child.kill();
        assert!(ended.is_ok(), "ending a copy that had already exited failed: {ended:?}");
    }
}
