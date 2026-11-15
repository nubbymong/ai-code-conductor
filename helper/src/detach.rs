//! Start a copy of a program that outlives the process that started it: the
//! holder is that program (protocol section 5: "only the holder outlives a
//! connection"). Whether it also outlives the app being closed and the
//! installer running over the app, on Windows, is probe P7
//! (helper/probes/p7-windows-survival.ps1).
#![allow(unsafe_code)]

use std::io;
use std::path::Path;
use std::process::{Command, Stdio};

#[cfg(unix)]
pub fn spawn_detached(program: &Path, args: &[String]) -> io::Result<u32> {
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
    let child = cmd.spawn()?;
    // The child is not waited for: it is meant to outlive us.
    Ok(child.id())
}

#[cfg(windows)]
pub fn spawn_detached(program: &Path, args: &[String]) -> io::Result<u32> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let attempt = |flags: u32| -> io::Result<u32> {
        let mut cmd = Command::new(program);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd.creation_flags(flags);
        Ok(cmd.spawn()?.id())
    };
    // Leave the parent's job if it allows that, so ending the job does not end
    // the holder; a job that forbids it refuses the flag, and the holder then
    // starts without it (probe P7 reports what happened).
    match attempt(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB) {
        Ok(pid) => Ok(pid),
        Err(_) => attempt(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP),
    }
}
