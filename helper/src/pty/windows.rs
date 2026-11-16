//! The Windows terminal: ConPTY (a pseudoconsole), with the child created
//! attached to it. Two anonymous pipes carry the bytes: the child's input
//! comes from `in_*`, its output goes to `out_*`.
//!
//! The child starts suspended, is put in a job object the holder owns, and
//! only then runs, so nothing it starts can leave the job: `end_tree` ends the
//! job and with it the whole tree. The job ends its processes when its last
//! handle closes, so a holder that dies takes its session with it. The holder
//! itself is never put in a job (probe P7).
//!
//! Handle types differ between `windows-sys` versions (an integer or a
//! pointer), so handles are held as `usize` and converted with `as` at each
//! call, which both forms accept.
//!
//! The pseudoconsole is Windows' own, or, when a launch asks for it
//! (protocol change 2), the bundled one: the `conpty.dll` in a `conpty`
//! folder beside the helper's own program file, which starts the
//! `OpenConsole.exe` beside it. It is the one node-pty ships, and its calls
//! are the ones node-pty makes (`ConptyCreatePseudoConsole`,
//! `ConptyResizePseudoConsole`, `ConptyClosePseudoConsole`). The library is
//! loaded by its full path, with only its own folder and System32 searched
//! for what it needs, and no path from a frame is ever used. When it is not
//! there or does not load, the start fails before anything is made.
//!
//! A launch may also give the exact command line (`line`): the program is
//! still `argv[0]`, named to `CreateProcessW` on its own, so no word of the
//! line can make it start another program.
#![allow(unsafe_code)]

use super::{check_argv, check_cwd, check_env, check_windows_fields, Conpty, PtySize, SpawnOptions};
use crate::cmdline::build_command_line;
use crate::winproc::{self, close, os_error, wide, AttrList, EXTENDED_STARTUPINFO_PRESENT, STARTF_USESTDHANDLES};
use std::ffi::c_void;
use std::fs::File;
use std::io::{self, Read};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::time::Duration;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HMODULE};
use windows_sys::Win32::System::Console::{ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON};
use windows_sys::Win32::System::Diagnostics::Debug::{SetThreadErrorMode, SEM_FAILCRITICALERRORS};
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, ResumeThread, TerminateProcess, WaitForSingleObject, PROCESS_INFORMATION, STARTUPINFOEXW,
};

/// `CREATE_SUSPENDED`: the child runs only once it is in the job.
const CREATE_SUSPENDED: u32 = 0x0000_0004;
/// `CREATE_UNICODE_ENVIRONMENT`: the environment block is UTF-16.
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
/// `INVALID_HANDLE_VALUE` (-1) as an integer, converted with `as` at the use.
const INVALID_HANDLE: usize = usize::MAX;
/// How long `end_tree` waits for the first process to be gone.
const END_WAIT_MS: u32 = 5000;

/// The bundled ConPTY's folder name, beside the helper's own program file.
pub const BUNDLED_FOLDER: &str = "conpty";

/// The bundled conpty.dll's calls, as node-pty declares them (conpty.cc).
type CreateFn = unsafe extern "system" fn(COORD, HANDLE, HANDLE, u32, *mut HPCON) -> i32;
type ResizeFn = unsafe extern "system" fn(HPCON, COORD) -> i32;
type CloseFn = unsafe extern "system" fn(HPCON);

/// The calls of a loaded bundled conpty.dll. The library is never unloaded:
/// a pseudoconsole it made is closed through it, as late as the holder's end.
#[derive(Clone, Copy)]
struct Bundled {
    create: CreateFn,
    resize: ResizeFn,
    close: CloseFn,
}

/// Whose pseudoconsole calls a terminal makes.
#[derive(Clone, Copy)]
enum Console {
    System,
    Bundled(Bundled),
}

impl Console {
    unsafe fn create(self, size: COORD, input: HANDLE, output: HANDLE, hpc: &mut HPCON) -> i32 {
        match self {
            Console::System => CreatePseudoConsole(size, input, output, 0, hpc),
            Console::Bundled(b) => (b.create)(size, input, output, 0, hpc),
        }
    }

    unsafe fn resize(self, hpc: HPCON, size: COORD) -> i32 {
        match self {
            Console::System => ResizePseudoConsole(hpc, size),
            Console::Bundled(b) => (b.resize)(hpc, size),
        }
    }

    unsafe fn close(self, hpc: HPCON) {
        match self {
            Console::System => ClosePseudoConsole(hpc),
            Console::Bundled(b) => (b.close)(hpc),
        }
    }
}

/// Why the bundled ConPTY cannot be used, as the launch's `io` answer says it.
fn unusable(kind: io::ErrorKind, why: String) -> io::Error {
    io::Error::new(kind, format!("the bundled ConPTY cannot be used: {why}"))
}

/// A file of the bundled ConPTY must be there, and a plain file, not a link.
fn plain_file(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_file() => Ok(()),
        Ok(_) => Err(unusable(io::ErrorKind::InvalidInput, format!("{} is not a plain file", path.display()))),
        Err(e) => Err(unusable(e.kind(), format!("{} is missing or cannot be read ({e})", path.display()))),
    }
}

/// One call of a loaded library, by its NUL-ended name.
unsafe fn export(module: HMODULE, name: &'static [u8]) -> io::Result<unsafe extern "system" fn() -> isize> {
    GetProcAddress(module, name.as_ptr()).ok_or_else(|| {
        let shown = String::from_utf8_lossy(&name[..name.len() - 1]).into_owned();
        unusable(io::ErrorKind::NotFound, format!("its conpty.dll has no {shown}"))
    })
}

/// Load the bundled conpty.dll: from the `conpty` folder beside this
/// program file, by its full path, searching only that folder and System32
/// for what it needs.
fn load_bundled() -> io::Result<Bundled> {
    let exe = std::env::current_exe()?;
    let folder: PathBuf = match exe.parent() {
        Some(dir) => dir.join(BUNDLED_FOLDER),
        None => return Err(unusable(io::ErrorKind::NotFound, "the helper's own folder is not known".to_string())),
    };
    let dll = folder.join("conpty.dll");
    // conpty.dll starts the OpenConsole.exe beside it. Without that file the
    // session would not run on the bundled console host at all.
    plain_file(&dll)?;
    plain_file(&folder.join("OpenConsole.exe"))?;
    let name = wide(&dll);
    unsafe {
        // A library that does not load is answered, never shown in a dialog
        // that would hold the holder up until someone closes it.
        let mut before: u32 = 0;
        let quiet = SetThreadErrorMode(SEM_FAILCRITICALERRORS, &mut before as *mut u32 as _) != 0;
        let module = LoadLibraryExW(name.as_ptr(), std::ptr::null_mut(), LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
        let failed = if module as usize == 0 { Some(os_error("LoadLibraryExW")) } else { None };
        if quiet {
            SetThreadErrorMode(before as _, std::ptr::null_mut::<u32>() as _);
        }
        if let Some(e) = failed {
            return Err(unusable(e.kind(), format!("{} does not load ({e})", dll.display())));
        }
        let create = export(module, b"ConptyCreatePseudoConsole\0")?;
        let resize = export(module, b"ConptyResizePseudoConsole\0")?;
        let close = export(module, b"ConptyClosePseudoConsole\0")?;
        Ok(Bundled {
            create: std::mem::transmute::<unsafe extern "system" fn() -> isize, CreateFn>(create),
            resize: std::mem::transmute::<unsafe extern "system" fn() -> isize, ResizeFn>(resize),
            close: std::mem::transmute::<unsafe extern "system" fn() -> isize, CloseFn>(close),
        })
    }
}

pub struct Pty {
    /// Whose pseudoconsole this is: Windows' own or the bundled one.
    console: Console,
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

/// Undo a start that failed after the pseudoconsole was made.
unsafe fn undo(console: Console, hpc: HPCON, in_write: usize, out_read: usize, job: usize) {
    console.close(hpc);
    close(in_write);
    close(out_read);
    close(job);
}

impl Pty {
    /// Start `argv` with the holder's own folder and environment.
    pub fn spawn(argv: &[String], size: PtySize) -> io::Result<(Pty, Box<dyn Read + Send>)> {
        Pty::spawn_with(&SpawnOptions { argv, cwd: None, env: None, size, line: None, conpty: Conpty::System })
    }

    pub fn spawn_with(opts: &SpawnOptions) -> io::Result<(Pty, Box<dyn Read + Send>)> {
        check_argv(opts.argv)?;
        if let Some(env) = opts.env {
            check_env(env)?;
        }
        if let Some(cwd) = opts.cwd {
            check_cwd(cwd)?;
        }
        check_windows_fields(opts)?;
        // Loaded first: a bundled ConPTY that cannot be used fails the start
        // before anything is made or started.
        let console = match opts.conpty {
            Conpty::System => Console::System,
            Conpty::Bundled => Console::Bundled(load_bundled()?),
        };
        // With an exact line, the program is argv[0], named on its own.
        let program: Option<Vec<u16>> = opts.line.map(|_| wide(&opts.argv[0]));
        let mut cmdline: Vec<u16> = match opts.line {
            Some(line) => wide(line),
            None => wide(&build_command_line(opts.argv)),
        };
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
            let hr = console.create(coord(opts.size), in_read, out_write, &mut hpc);
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
                    undo(console, hpc, in_write as usize, out_read as usize, job);
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
            let program_ptr: *const u16 = match &program {
                Some(p) => p.as_ptr(),
                None => std::ptr::null(),
            };
            let ok = CreateProcessW(
                program_ptr,
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
                undo(console, hpc, in_write as usize, out_read as usize, job);
                return Err(e);
            }
            // Into the job while it is still suspended, so not even its first
            // child can start outside it.
            if AssignProcessToJobObject(job as HANDLE, info.hProcess) == 0 {
                let e = os_error("AssignProcessToJobObject");
                TerminateProcess(info.hProcess, 1);
                close(info.hThread as usize);
                close(info.hProcess as usize);
                undo(console, hpc, in_write as usize, out_read as usize, job);
                return Err(e);
            }
            if ResumeThread(info.hThread) == u32::MAX {
                let e = os_error("ResumeThread");
                TerminateJobObject(job as HANDLE, 1);
                close(info.hThread as usize);
                close(info.hProcess as usize);
                undo(console, hpc, in_write as usize, out_read as usize, job);
                return Err(e);
            }
            close(info.hThread as usize);

            let reader = File::from_raw_handle(out_read as RawHandle);
            let input = File::from_raw_handle(in_write as RawHandle);
            let pty = Pty { console, pseudo_console: hpc as usize, process: info.hProcess as usize, job, pid: info.dwProcessId, input, exit: None };
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
        let hr = unsafe { self.console.resize(self.pseudo_console as HPCON, coord(size)) };
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
                self.console.close(self.pseudo_console as HPCON);
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
