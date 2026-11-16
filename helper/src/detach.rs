//! Start a copy of a program that outlives the process that started it: the
//! holder is that program (protocol section 5: "only the holder outlives a
//! connection"). On Windows the copy leaves the starter's job when the job
//! allows it; probe P7 (helper/probes/p7-windows-survival.ps1) showed a
//! holder started this way outlives the app and the installer.
//!
//! The child is returned, never waited for by the caller once it is up, so
//! `hold --detach` can tell a holder that failed at once from one that runs.
#![allow(unsafe_code)]

use std::io;
use std::path::Path;
use std::process::{Child, Command, Stdio};

#[cfg(unix)]
pub fn spawn_detached(program: &Path, args: &[String]) -> io::Result<Child> {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // A new session: no terminal hangup and no process-group signal from the parent reaches it.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn()
}

/// std starts a child with handle inheritance on, so a holder started with
/// `Stdio::null()` would still inherit the starter's own standard pipes if the
/// starter was run with them piped. The caller would then wait for end of
/// file on those pipes until the holder ends. Clearing the inherit flag on the
/// starter's three standard handles stops that; printing to them still works.
#[cfg(windows)]
fn stop_inheriting_std_handles() {
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
    for id in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        let handle = unsafe { GetStdHandle(id) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            continue;
        }
        unsafe {
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
        }
    }
}

#[cfg(windows)]
pub fn spawn_detached(program: &Path, args: &[String]) -> io::Result<Child> {
    use std::os::windows::process::CommandExt;
    stop_inheriting_std_handles();
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let attempt = |flags: u32| -> io::Result<Child> {
        let mut cmd = Command::new(program);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.creation_flags(flags);
        cmd.spawn()
    };
    // Leave the parent's job if it allows that, so ending the job does not end
    // the holder; a job that forbids it refuses the flag, and the holder then
    // starts without it.
    match attempt(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB) {
        Ok(child) => Ok(child),
        Err(_) => attempt(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP),
    }
}
