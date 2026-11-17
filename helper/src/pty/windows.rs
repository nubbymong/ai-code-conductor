//! The Windows terminal: ConPTY (a pseudoconsole), with the child created
//! attached to it. Two anonymous pipes carry the bytes: the child's input
//! comes from `in_*`, its output goes to `out_*`.
//!
//! The child starts suspended, is put in a job object the holder owns, and
//! only then runs, so nothing it starts can leave the job: `end_tree` ends the
//! job and with it the whole tree. The job ends its processes when its last
//! handle closes, so a holder that dies takes its session with it. The `hold`
//! process itself is never put in a job (probe P7); only the self-test's
//! process is, see `end_children_with_this_process`.
//!
//! Handle types differ between `windows-sys` versions (an integer or a
//! pointer), so handles are held as `usize` and converted with `as` at each
//! call, which both forms accept.
#![allow(unsafe_code)]

use super::{check_argv, check_cwd, check_env, PtySize, SpawnOptions};
use crate::cmdline::build_command_line;
use crate::winproc::{self, close, os_error, wide, AttrList, EXTENDED_STARTUPINFO_PRESENT, STARTF_USESTDHANDLES};
use std::ffi::c_void;
use std::fs::File;
use std::io::{self, Read};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::time::Duration;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Console::{ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetCurrentProcess, ResumeThread, TerminateProcess, WaitForSingleObject, PROCESS_INFORMATION, STARTUPINFOEXW,
};

/// `CREATE_SUSPENDED`: the child runs only once it is in the job.
const CREATE_SUSPENDED: u32 = 0x0000_0004;
/// `CREATE_UNICODE_ENVIRONMENT`: the environment block is UTF-16.
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
/// `INVALID_HANDLE_VALUE` (-1) as an integer, converted with `as` at the use.
const INVALID_HANDLE: usize = usize::MAX;
/// How long `end_tree` waits for the first process to be gone.
const END_WAIT_MS: u32 = 5000;

pub struct Pty {
    /// The pseudoconsole; 0 once it is closed.
    pseudo_console: usize,
    process: usize,
    job: usize,
    pid: u32,
    input: File,
    exit: Option<i32>,
}

fn coord(size: PtySize) -> COORD {
    COORD { X: size.cols as i16, Y: size.rows as i16 }
}

/// The block `CreateProcessW` takes with `CREATE_UNICODE_ENVIRONMENT`:
/// `NAME=value` strings, each ended by a NUL, sorted by name without regard
/// to case as Windows expects, then one more NUL.
pub(crate) fn env_block(env: &[(String, String)]) -> Vec<u16> {
    let mut pairs: Vec<&(String, String)> = env.iter().collect();
    pairs.sort_by_cached_key(|pair| pair.0.to_uppercase());
    let mut block: Vec<u16> = Vec::new();
    for pair in pairs {
        block.extend(std::ffi::OsStr::new(&pair.0).encode_wide());
        block.push(u16::from(b'='));
        block.extend(std::ffi::OsStr::new(&pair.1).encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        // An empty block is two NULs.
        block.push(0);
    }
    block.push(0);
    block
}

/// A job object that ends its processes when its last handle closes.
unsafe fn new_job() -> io::Result<usize> {
    let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
    if job.is_null() {
        return Err(os_error("CreateJobObjectW"));
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let ok = SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const c_void,
        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    );
    if ok == 0 {
        let e = os_error("SetInformationJobObject");
        CloseHandle(job);
        return Err(e);
    }
    Ok(job as usize)
}

/// Put this process in a new job that ends every process in it when its last
/// handle closes, and keep that handle until this process exits.
///
/// A pseudoconsole's host (`conhost.exe`) is a child of the process that
/// makes the pseudoconsole, and only `ClosePseudoConsole` ends it on purpose.
/// A process that exits, or is ended, without that call can leave the host
/// running (aicc_planning#317). From this call on, every child this process
/// starts is in the job (the job allows no child to leave it), the host
/// included, so none outlives this process however it ends. A terminal's
/// child is moved on into the terminal's own job, which is then nested in
/// this one. The handle is not inheritable, so no child keeps the job open.
///
/// Only the self-test calls it. A holder never does: a holder must outlive
/// the app, and is in no job of its own (probe P7).
pub fn end_children_with_this_process() -> io::Result<()> {
    unsafe {
        let job = new_job()?;
        if AssignProcessToJobObject(job as HANDLE, GetCurrentProcess()) == 0 {
            let e = os_error("AssignProcessToJobObject (this process)");
            close(job);
            return Err(e);
        }
        // Never closed: closing the last handle would end this process too.
        // It closes when this process exits, and the job then ends the rest.
    }
    Ok(())
}

/// Undo a start that failed after the pseudoconsole was made.
unsafe fn undo(hpc: HPCON, in_write: usize, out_read: usize, job: usize) {
    ClosePseudoConsole(hpc);
    close(in_write);
    close(out_read);
    close(job);
}

impl Pty {
    /// Start `argv` with the holder's own folder and environment.
    pub fn spawn(argv: &[String], size: PtySize) -> io::Result<(Pty, Box<dyn Read + Send>)> {
        Pty::spawn_with(&SpawnOptions { argv, cwd: None, env: None, size })
    }

    pub fn spawn_with(opts: &SpawnOptions) -> io::Result<(Pty, Box<dyn Read + Send>)> {
        check_argv(opts.argv)?;
        if let Some(env) = opts.env {
            check_env(env)?;
        }
        if let Some(cwd) = opts.cwd {
            check_cwd(cwd)?;
        }
        let mut cmdline: Vec<u16> = wide(&build_command_line(opts.argv));
        let cwd: Option<Vec<u16>> = opts.cwd.map(wide);
        let block: Option<Vec<u16>> = opts.env.map(env_block);
        unsafe {
            let job = new_job()?;
            let mut in_read: HANDLE = std::mem::zeroed();
            let mut in_write: HANDLE = std::mem::zeroed();
            let mut out_read: HANDLE = std::mem::zeroed();
            let mut out_write: HANDLE = std::mem::zeroed();
            if CreatePipe(&mut in_read, &mut in_write, std::ptr::null(), 0) == 0 {
                let e = os_error("CreatePipe (input)");
                close(job);
                return Err(e);
            }
            if CreatePipe(&mut out_read, &mut out_write, std::ptr::null(), 0) == 0 {
                let e = os_error("CreatePipe (output)");
                close(in_read as usize);
                close(in_write as usize);
                close(job);
                return Err(e);
            }

            let mut hpc: HPCON = std::mem::zeroed();
            let hr = CreatePseudoConsole(coord(opts.size), in_read, out_write, 0, &mut hpc);
            // The pseudoconsole holds its own ends now; ours are closed so the
            // pipes end when it does.
            close(in_read as usize);
            close(out_write as usize);
            if hr != 0 {
                close(in_write as usize);
                close(out_read as usize);
                close(job);
                return Err(io::Error::new(io::ErrorKind::Other, format!("CreatePseudoConsole failed: 0x{:08x}", hr as u32)));
            }

            // The attribute list that attaches the child to the pseudoconsole.
            let mut attrs = match AttrList::pseudoconsole(hpc) {
                Ok(attrs) => attrs,
                Err(e) => {
                    undo(hpc, in_write as usize, out_read as usize, job);
                    return Err(e);
                }
            };

            let mut startup: STARTUPINFOEXW = std::mem::zeroed();
            startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            // Name the standard handles explicitly, as invalid, so the child
            // takes them from the pseudoconsole. Without this, a parent whose
            // own standard handles are redirected (CI, the app) hands them down
            // and the child writes to the parent's stdout, never to the pty.
            startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = INVALID_HANDLE as HANDLE;
            startup.StartupInfo.hStdOutput = INVALID_HANDLE as HANDLE;
            startup.StartupInfo.hStdError = INVALID_HANDLE as HANDLE;
            startup.lpAttributeList = attrs.as_ptr() as _;
            let mut info: PROCESS_INFORMATION = std::mem::zeroed();
            let mut flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED;
            if block.is_some() {
                flags |= CREATE_UNICODE_ENVIRONMENT;
            }
            let env_ptr: *const c_void = match &block {
                Some(b) => b.as_ptr() as *const c_void,
                None => std::ptr::null(),
            };
            let cwd_ptr: *const u16 = match &cwd {
                Some(c) => c.as_ptr(),
                None => std::ptr::null(),
            };
            let ok = CreateProcessW(
                std::ptr::null(),
                cmdline.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                flags,
                env_ptr,
                cwd_ptr,
                &startup.StartupInfo,
                &mut info,
            );
            let created = if ok == 0 { Some(os_error("CreateProcessW")) } else { None };
            drop(attrs);
            if let Some(e) = created {
                undo(hpc, in_write as usize, out_read as usize, job);
                return Err(e);
            }
            // Into the job while it is still suspended, so not even its first
            // child can start outside it.
            if AssignProcessToJobObject(job as HANDLE, info.hProcess) == 0 {
                let e = os_error("AssignProcessToJobObject");
                TerminateProcess(info.hProcess, 1);
                close(info.hThread as usize);
                close(info.hProcess as usize);
                undo(hpc, in_write as usize, out_read as usize, job);
                return Err(e);
            }
            if ResumeThread(info.hThread) == u32::MAX {
                let e = os_error("ResumeThread");
                TerminateJobObject(job as HANDLE, 1);
                close(info.hThread as usize);
                close(info.hProcess as usize);
                undo(hpc, in_write as usize, out_read as usize, job);
                return Err(e);
            }
            close(info.hThread as usize);

            let reader = File::from_raw_handle(out_read as RawHandle);
            let input = File::from_raw_handle(in_write as RawHandle);
            let pty = Pty { pseudo_console: hpc as usize, process: info.hProcess as usize, job, pid: info.dwProcessId, input, exit: None };
            Ok((pty, Box::new(reader)))
        }
    }

    /// A second handle on the input pipe, for a thread that writes alone.
    pub fn input_writer(&self) -> io::Result<File> {
        self.input.try_clone()
    }

    pub fn resize(&self, size: PtySize) -> io::Result<()> {
        if self.pseudo_console == 0 {
            // The session is over; there is no terminal left to size.
            return Ok(());
        }
        let hr = unsafe { ResizePseudoConsole(self.pseudo_console as HPCON, coord(size)) };
        if hr != 0 {
            return Err(io::Error::new(io::ErrorKind::Other, format!("ResizePseudoConsole failed: 0x{:08x}", hr as u32)));
        }
        Ok(())
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// The exit code once the child has exited.
    pub fn try_wait(&mut self) -> io::Result<Option<i32>> {
        if let Some(code) = self.exit {
            return Ok(Some(code));
        }
        // A wait that fails is an error, never "still running".
        if let Some(code) = winproc::exit_code(self.process)? {
            self.exit = Some(code as i32);
        }
        Ok(self.exit)
    }

    /// End the whole tree: every process in the session's job, the first one
    /// and everything it started. A console tree has no hangup to send first,
    /// so `grace` is not used here.
    pub fn end_tree(&mut self, _grace: Duration) {
        unsafe {
            TerminateJobObject(self.job as HANDLE, 1);
            WaitForSingleObject(self.process as HANDLE, END_WAIT_MS);
        }
    }

    /// End the tree at once.
    pub fn kill(&mut self) {
        self.end_tree(Duration::ZERO);
    }

    /// Close the pseudoconsole: the output pipe ends, and with it the reader.
    pub fn close_output(&mut self) {
        if self.pseudo_console != 0 {
            unsafe {
                ClosePseudoConsole(self.pseudo_console as HPCON);
            }
            self.pseudo_console = 0;
        }
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        unsafe {
            TerminateJobObject(self.job as HANDLE, 1);
        }
        // Closing the pseudoconsole ends the output pipe, which ends the reader.
        self.close_output();
        unsafe {
            close(self.process);
            close(self.job);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(block: &[u16]) -> String {
        String::from_utf16_lossy(block)
    }

    #[test]
    fn the_environment_block_is_sorted_without_case_and_ends_with_two_nuls() {
        let env = vec![("b".to_string(), "2".to_string()), ("A".to_string(), "1=one".to_string()), ("Path".to_string(), "C:\\x".to_string())];
        let block = env_block(&env);
        assert_eq!(text(&block), "A=1=one\0b=2\0Path=C:\\x\0\0");
        assert_eq!(env_block(&[]), vec![0, 0], "an empty block is two NULs");
    }
}
