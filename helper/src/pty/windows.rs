//! The Windows terminal: ConPTY (a pseudoconsole), with the child created
//! attached to it. Two anonymous pipes carry the bytes: the child's input
//! comes from `in_*`, its output goes to `out_*`.
//!
//! Handle types differ between `windows-sys` versions (an integer or a
//! pointer), so handles are held as `usize` and converted with `as` at each
//! call, which both forms accept.
#![allow(unsafe_code)]

use super::{check_argv, PtySize};
use crate::cmdline::build_command_line;
use std::ffi::c_void;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, RawHandle};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Console::{ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject, PROCESS_INFORMATION, STARTUPINFOEXW,
};

/// `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`: attribute 22, input only.
const ATTR_PSEUDOCONSOLE: usize = 0x0002_0016;
/// `EXTENDED_STARTUPINFO_PRESENT`.
const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
/// `STARTF_USESTDHANDLES`.
const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
/// `INVALID_HANDLE_VALUE` (-1) as an integer, converted with `as` at the use.
const INVALID_HANDLE: usize = usize::MAX;

pub struct Pty {
    pseudo_console: usize,
    process: usize,
    pid: u32,
    input: File,
    exit: Option<i32>,
}

fn coord(size: PtySize) -> COORD {
    COORD { X: size.cols as i16, Y: size.rows as i16 }
}

fn os_error(what: &str) -> io::Error {
    let e = io::Error::last_os_error();
    io::Error::new(e.kind(), format!("{what}: {e}"))
}

unsafe fn close(handle: usize) {
    CloseHandle(handle as HANDLE);
}

impl Pty {
    pub fn spawn(argv: &[String], size: PtySize) -> io::Result<(Pty, Box<dyn Read + Send>)> {
        check_argv(argv)?;
        unsafe {
            let mut in_read: HANDLE = std::mem::zeroed();
            let mut in_write: HANDLE = std::mem::zeroed();
            let mut out_read: HANDLE = std::mem::zeroed();
            let mut out_write: HANDLE = std::mem::zeroed();
            if CreatePipe(&mut in_read, &mut in_write, std::ptr::null(), 0) == 0 {
                return Err(os_error("CreatePipe (input)"));
            }
            if CreatePipe(&mut out_read, &mut out_write, std::ptr::null(), 0) == 0 {
                let e = os_error("CreatePipe (output)");
                close(in_read as usize);
                close(in_write as usize);
                return Err(e);
            }

            let mut hpc: HPCON = std::mem::zeroed();
            let hr = CreatePseudoConsole(coord(size), in_read, out_write, 0, &mut hpc);
            // The pseudoconsole holds its own ends now; ours are closed so the
            // pipes end when it does.
            close(in_read as usize);
            close(out_write as usize);
            if hr != 0 {
                close(in_write as usize);
                close(out_read as usize);
                return Err(io::Error::new(io::ErrorKind::Other, format!("CreatePseudoConsole failed: 0x{:08x}", hr as u32)));
            }

            // The attribute list that attaches the child to the pseudoconsole.
            let mut list_bytes: usize = 0;
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut list_bytes);
            // Pointer-aligned storage, as the API requires.
            let mut storage: Vec<usize> = vec![0; list_bytes / std::mem::size_of::<usize>() + 1];
            let list = storage.as_mut_ptr() as *mut c_void;
            if InitializeProcThreadAttributeList(list as _, 1, 0, &mut list_bytes) == 0 {
                let e = os_error("InitializeProcThreadAttributeList");
                ClosePseudoConsole(hpc);
                close(in_write as usize);
                close(out_read as usize);
                return Err(e);
            }
            if UpdateProcThreadAttribute(
                list as _,
                0,
                ATTR_PSEUDOCONSOLE,
                hpc as *const c_void,
                std::mem::size_of::<HPCON>(),
                std::ptr::null_mut(),
                std::ptr::null(),
            ) == 0
            {
                let e = os_error("UpdateProcThreadAttribute");
                DeleteProcThreadAttributeList(list as _);
                ClosePseudoConsole(hpc);
                close(in_write as usize);
                close(out_read as usize);
                return Err(e);
            }

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
            startup.lpAttributeList = list as _;
            let mut info: PROCESS_INFORMATION = std::mem::zeroed();
            let mut cmdline: Vec<u16> = std::ffi::OsStr::new(&build_command_line(argv)).encode_wide().chain(std::iter::once(0)).collect();
            let ok = CreateProcessW(
                std::ptr::null(),
                cmdline.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT,
                std::ptr::null(),
                std::ptr::null(),
                &startup.StartupInfo,
                &mut info,
            );
            let created = if ok == 0 { Some(os_error("CreateProcessW")) } else { None };
            DeleteProcThreadAttributeList(list as _);
            if let Some(e) = created {
                ClosePseudoConsole(hpc);
                close(in_write as usize);
                close(out_read as usize);
                return Err(e);
            }
            close(info.hThread as usize);

            let reader = File::from_raw_handle(out_read as RawHandle);
            let input = File::from_raw_handle(in_write as RawHandle);
            let pty = Pty { pseudo_console: hpc as usize, process: info.hProcess as usize, pid: info.dwProcessId, input, exit: None };
            Ok((pty, Box::new(reader)))
        }
    }

    pub fn write_input(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.input.write_all(bytes)?;
        self.input.flush()
    }

    pub fn resize(&self, size: PtySize) -> io::Result<()> {
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
        unsafe {
            // WAIT_OBJECT_0 is 0; any other answer (timeout included) is "still running".
            if WaitForSingleObject(self.process as HANDLE, 0) != 0 {
                return Ok(None);
            }
            let mut code: u32 = 0;
            if GetExitCodeProcess(self.process as HANDLE, &mut code) == 0 {
                return Err(os_error("GetExitCodeProcess"));
            }
            self.exit = Some(code as i32);
            Ok(self.exit)
        }
    }

    pub fn kill(&mut self) {
        unsafe {
            TerminateProcess(self.process as HANDLE, 1);
        }
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        unsafe {
            if self.exit.is_none() {
                TerminateProcess(self.process as HANDLE, 1);
            }
            // Closing the pseudoconsole ends the output pipe, which ends the reader.
            ClosePseudoConsole(self.pseudo_console as HPCON);
            close(self.process);
        }
    }
}
