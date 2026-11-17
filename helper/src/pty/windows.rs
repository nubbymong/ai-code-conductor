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
//! The pseudoconsole is Windows' own, or, when a launch asks for it (the
//! launch field `conpty`), the bundled one: the `conpty.dll` in a `conpty`
//! folder beside the helper's own program file, which starts the
//! `OpenConsole.exe` beside it. It is the one node-pty ships. Three of
//! node-pty's calls are made on it (`ConptyCreatePseudoConsole`,
//! `ConptyResizePseudoConsole`, `ConptyClosePseudoConsole`);
//! `ConptyReleasePseudoConsole`, which node-pty calls after the start, is
//! not, so a session ends as it does on Windows' own ConPTY: when the
//! program exits, the holder closes the pseudoconsole. The folder and both
//! files must be plain (no link or other reparse point) and are held open
//! from that check until the pseudoconsole is made: neither file can be
//! written, renamed or removed, and the folder cannot be renamed or
//! removed, in between; files can still be added to the folder. The library
//! is loaded by its full path,
//! with only its own folder and System32 searched for what it needs, and no
//! path from a frame is ever used. When it is not there, does not load or
//! lacks one of the calls, the start fails before anything is made; a
//! library that lacks a call is unloaded again.
//!
//! A launch may also give the exact command line (`line`). `CreateProcessW`
//! starts the program at `argv[0]` (`lpApplicationName`), by that exact path
//! with no search, and `line` is only the text that program reads. A command
//! interpreter runs what its line says, so `line` gives nothing `argv` could
//! not already say. A batch file is refused with it (`check_windows_fields`):
//! Windows would start cmd.exe for it, reading the line as commands. That
//! check reads the name as given; as the last line, `check_full_name` reads
//! it again as Windows makes it full before it opens the file, as Rust's own
//! `Command` does.
#![allow(unsafe_code)]

use super::{check_argv, check_cwd, check_env, check_windows_fields, is_batch_file, is_renamed_by_windows, Conpty, PtySize, SpawnOptions};
use crate::cmdline::build_command_line;
use crate::winproc::{self, close, os_error, wide, AttrList, EXTENDED_STARTUPINFO_PRESENT, STARTF_USESTDHANDLES};
use std::ffi::c_void;
use std::fs::File;
use std::io::{self, Read};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::time::Duration;
use windows_sys::Win32::Foundation::{CloseHandle, FreeLibrary, GENERIC_READ, HANDLE, HMODULE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetFileInformationByHandle, GetFullPathNameW, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
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
/// The bundled ConPTY's library, in that folder.
const BUNDLED_DLL: &str = "conpty.dll";
/// The console host the library starts, beside it.
const BUNDLED_HOST: &str = "OpenConsole.exe";

/// The bundled conpty.dll's calls, as node-pty declares them (conpty.cc).
type CreateFn = unsafe extern "system" fn(COORD, HANDLE, HANDLE, u32, *mut HPCON) -> i32;
type ResizeFn = unsafe extern "system" fn(HPCON, COORD) -> i32;
type CloseFn = unsafe extern "system" fn(HPCON);

/// The calls of a loaded bundled conpty.dll. A library with all three is
/// never unloaded: a pseudoconsole it made is closed through it, as late as
/// the holder's end.
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

    /// A failed pseudoconsole call (`Create`, `Resize`), named as it was
    /// made: Windows' own, or the bundled library's.
    fn failed(self, call: &str, hr: i32) -> io::Error {
        let named = match self {
            Console::System => format!("{call}PseudoConsole"),
            Console::Bundled(_) => format!("the bundled ConPTY's Conpty{call}PseudoConsole"),
        };
        io::Error::new(io::ErrorKind::Other, format!("{named} failed: 0x{:08x}", hr as u32))
    }
}

/// Why the bundled ConPTY cannot be used, as the launch's `io` answer says it.
fn unusable(kind: io::ErrorKind, why: String) -> io::Error {
    io::Error::new(kind, format!("the bundled ConPTY cannot be used: {why}"))
}

/// A folder or file of the bundled ConPTY, held open from its check until the
/// pseudoconsole is made. Others may read it, as the loader and the start of
/// OpenConsole.exe do. Meanwhile a held file cannot be written, renamed or
/// removed, and a held folder cannot be renamed or removed, though files can
/// still be added to it.
struct Held(usize);

impl Drop for Held {
    fn drop(&mut self) {
        unsafe { close(self.0) }
    }
}

/// Open `path` and check it is a plain file, or with `folder` a plain
/// folder: never a link, a junction or any other reparse point, which is
/// opened itself and never followed.
fn hold_plain(path: &Path, folder: bool) -> io::Result<Held> {
    let name = wide(path);
    // A folder's entries may still change; the folder itself cannot be
    // renamed or removed while it is held. A file cannot be written either.
    let share = if folder { FILE_SHARE_READ | FILE_SHARE_WRITE } else { FILE_SHARE_READ };
    let h = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ,
            share,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if h as usize == INVALID_HANDLE {
        let e = io::Error::last_os_error();
        return Err(unusable(e.kind(), format!("{} is missing or cannot be read ({e})", path.display())));
    }
    let held = Held(h as usize);
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(h, &mut info) } == 0 {
        let e = io::Error::last_os_error();
        return Err(unusable(e.kind(), format!("{} cannot be read ({e})", path.display())));
    }
    let is_folder = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || is_folder != folder {
        let what = if folder { "folder" } else { "file" };
        return Err(unusable(io::ErrorKind::InvalidInput, format!("{} is not a plain {what}", path.display())));
    }
    Ok(held)
}

/// `program` as Windows makes it full before it opens the file
/// (`GetFullPathNameW`): `.` and `..` parts resolved, `/` read as `\`,
/// trailing dots and spaces dropped from the last part.
fn full_name(program: &str) -> io::Result<String> {
    let name = wide(program);
    let mut buffer: Vec<u16> = vec![0; 512];
    // A buffer too small is told the size it needs, with the NUL. A name
    // that still does not fit the second time is not trusted.
    for _ in 0..2 {
        let n = unsafe { GetFullPathNameW(name.as_ptr(), buffer.len() as u32, buffer.as_mut_ptr(), std::ptr::null_mut()) } as usize;
        if n == 0 {
            return Err(os_error("GetFullPathNameW"));
        }
        if n < buffer.len() {
            buffer.truncate(n);
            return Ok(String::from_utf16_lossy(&buffer));
        }
        buffer = vec![0; n];
    }
    Err(io::Error::new(io::ErrorKind::InvalidInput, "GetFullPathNameW: the program's full name kept changing"))
}

/// With an exact command line, the holder's last line: the name rules once
/// more, on the full name Windows opens (`full_name`), as Rust's own
/// `Command` does before it starts a program.
fn check_full_name(program: &str) -> io::Result<()> {
    let full = full_name(program)?;
    if is_renamed_by_windows(&full) || is_batch_file(&full) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("a command line is never given to a batch file, which Windows runs through cmd.exe, or to a name Windows changes (Windows opens {full})"),
        ));
    }
    Ok(())
}

/// One call of a loaded library, by its NUL-ended name.
unsafe fn export(module: HMODULE, name: &'static [u8]) -> io::Result<unsafe extern "system" fn() -> isize> {
    GetProcAddress(module, name.as_ptr()).ok_or_else(|| {
        let shown = String::from_utf8_lossy(&name[..name.len() - 1]).into_owned();
        unusable(io::ErrorKind::NotFound, format!("its conpty.dll has no {shown}"))
    })
}

/// The three calls node-pty makes, from a loaded conpty.dll.
unsafe fn calls(module: HMODULE) -> io::Result<Bundled> {
    let create = export(module, b"ConptyCreatePseudoConsole\0")?;
    let resize = export(module, b"ConptyResizePseudoConsole\0")?;
    let close = export(module, b"ConptyClosePseudoConsole\0")?;
    Ok(Bundled {
        create: std::mem::transmute::<unsafe extern "system" fn() -> isize, CreateFn>(create),
        resize: std::mem::transmute::<unsafe extern "system" fn() -> isize, ResizeFn>(resize),
        close: std::mem::transmute::<unsafe extern "system" fn() -> isize, CloseFn>(close),
    })
}

/// Load the bundled conpty.dll: from the `conpty` folder beside this
/// program file, by its full path, searching only that folder and System32
/// for what it needs. Answers its calls and the folder and both files, held
/// open: the caller keeps them until the pseudoconsole is made.
fn load_bundled() -> io::Result<(Bundled, [Held; 3])> {
    let exe = std::env::current_exe()?;
    let folder: PathBuf = match exe.parent() {
        Some(dir) => dir.join(BUNDLED_FOLDER),
        None => return Err(unusable(io::ErrorKind::NotFound, "the helper's own folder is not known".to_string())),
    };
    let held_folder = hold_plain(&folder, true)?;
    let dll = folder.join(BUNDLED_DLL);
    let held_dll = hold_plain(&dll, false)?;
    // conpty.dll starts the OpenConsole.exe beside it. Without that file the
    // session would not run on the bundled console host at all.
    let held_host = hold_plain(&folder.join(BUNDLED_HOST), false)?;
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
        match calls(module) {
            Ok(b) => Ok((b, [held_folder, held_dll, held_host])),
            Err(e) => {
                // Not a ConPTY: unloaded again, so its file is not kept in
                // use and a later launch loads it afresh.
                FreeLibrary(module);
                Err(e)
            }
        }
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
        if opts.line.is_some() {
            check_full_name(&opts.argv[0])?;
        }
        // Loaded first: a bundled ConPTY that cannot be used fails the start
        // before anything is made or started. Its folder and files stay held
        // until this start is over, past the pseudoconsole's making.
        let (console, _held) = match opts.conpty {
            Conpty::System => (Console::System, None),
            Conpty::Bundled => {
                let (calls, held) = load_bundled()?;
                (Console::Bundled(calls), Some(held))
            }
        };
        // With an exact line, CreateProcessW is given argv[0] as the program
        // (lpApplicationName) and the line as the text it reads.
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
                return Err(console.failed("Create", hr));
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
            return Err(self.console.failed("Resize", hr));
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

    #[test]
    fn a_line_is_checked_once_more_on_the_full_name_windows_opens() {
        // Windows resolves `..`, drops a last `.` part and reads `/` as `\`.
        assert_eq!(full_name("C:\\x\\tool.cmd\\sub\\..").unwrap(), "C:\\x\\tool.cmd");
        assert_eq!(full_name("C:/x/tool.cmd/.").unwrap(), "C:\\x\\tool.cmd");
        for name in ["C:\\x\\tool.cmd\\.", "C:\\x\\tool.cmd\\sub\\..", "C:/x/./tool.CMD", "C:\\x\\tool.bat. ", "C:\\x\\tool.cmd\\. ", "C:\\x\\tool.cmd\\"] {
            assert!(check_full_name(name).is_err(), "{name} was not refused");
        }
        // Read as the full name only. The name as given is checked first
        // (`check_windows_fields`), which refuses C:\x\sub\..\tool.exe.
        for name in ["C:\\Windows\\System32\\cmd.exe", "C:\\x\\sub\\..\\tool.exe", "C:\\x.cmd\\tool.exe"] {
            assert!(check_full_name(name).is_ok(), "{name} was refused: {:?}", check_full_name(name));
        }
        // A name of 512 UTF-16 units or more does not fit the first buffer: it
        // is read again into one of the size Windows asks for (argv[0] may be
        // up to 8192 characters).
        let long = format!("C:\\{}tool.cmd\\.", "a\\".repeat(300));
        assert!(long.encode_utf16().count() > 511);
        assert_eq!(full_name(&long).unwrap(), format!("C:\\{}tool.cmd", "a\\".repeat(300)));
        assert!(check_full_name(&long).is_err(), "a long name was not refused");
    }

    unsafe extern "system" fn no_create(_: COORD, _: HANDLE, _: HANDLE, _: u32, _: *mut HPCON) -> i32 {
        1
    }
    unsafe extern "system" fn no_resize(_: HPCON, _: COORD) -> i32 {
        1
    }
    unsafe extern "system" fn no_close(_: HPCON) {}

    #[test]
    fn a_failed_pseudoconsole_call_is_named_as_it_was_made() {
        let bundled = Console::Bundled(Bundled { create: no_create, resize: no_resize, close: no_close });
        assert_eq!(Console::System.failed("Create", 5).to_string(), "CreatePseudoConsole failed: 0x00000005");
        assert_eq!(Console::System.failed("Resize", 5).to_string(), "ResizePseudoConsole failed: 0x00000005");
        assert_eq!(bundled.failed("Create", -2147024809).to_string(), "the bundled ConPTY's ConptyCreatePseudoConsole failed: 0x80070057");
        assert_eq!(bundled.failed("Resize", -2147024809).to_string(), "the bundled ConPTY's ConptyResizePseudoConsole failed: 0x80070057");
    }
}
