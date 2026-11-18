//! What every Windows process start in the helper shares: the holder's own
//! start (`detach.rs`) and a terminal's child (`pty/windows.rs`).
//!
//! Handle types differ between `windows-sys` versions (an integer or a
//! pointer), so handles are held as `usize` and converted with `as` at each
//! call, which both forms accept.
#![allow(unsafe_code)]

use std::ffi::{c_void, OsStr};
use std::io;
use std::os::windows::ffi::OsStrExt;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Console::HPCON;
use windows_sys::Win32::System::Threading::{
    DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList, UpdateProcThreadAttribute, WaitForSingleObject,
};

/// `EXTENDED_STARTUPINFO_PRESENT`: the start-up block carries an attribute list.
pub(crate) const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
/// `STARTF_USESTDHANDLES`.
pub(crate) const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
/// `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`: attribute 2, input only.
const ATTR_HANDLE_LIST: usize = 0x0002_0002;
/// `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`: attribute 22, input only.
const ATTR_PSEUDOCONSOLE: usize = 0x0002_0016;
/// `WAIT_OBJECT_0`: the process has exited.
pub(crate) const WAIT_OBJECT_0: u32 = 0;
/// `WAIT_TIMEOUT`: it is still running.
const WAIT_TIMEOUT: u32 = 0x0000_0102;

/// The last error, named for the call that failed.
pub(crate) fn os_error(what: &str) -> io::Error {
    let e = io::Error::last_os_error();
    io::Error::new(e.kind(), format!("{what}: {e}"))
}

/// `s` as a NUL-ended UTF-16 string.
pub(crate) fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

pub(crate) unsafe fn close(handle: usize) {
    CloseHandle(handle as HANDLE);
}

/// The exit code of `process` once it has exited, `None` while it runs. A
/// wait that fails is an error, never "still running".
pub(crate) fn exit_code(process: usize) -> io::Result<Option<u32>> {
    match unsafe { WaitForSingleObject(process as HANDLE, 0) } {
        WAIT_OBJECT_0 => {}
        WAIT_TIMEOUT => return Ok(None),
        _ => return Err(os_error("WaitForSingleObject")),
    }
    let mut code: u32 = 0;
    if unsafe { GetExitCodeProcess(process as HANDLE, &mut code) } == 0 {
        return Err(os_error("GetExitCodeProcess"));
    }
    Ok(Some(code))
}

/// A process and thread attribute list with one attribute, deleted when it
/// is dropped. It owns what the attribute points to, so that lives exactly
/// as long as the list. Its storage is on the heap, so moving it moves no
/// pointer the list holds.
pub(crate) struct AttrList {
    /// Pointer-aligned storage, as the API requires.
    storage: Vec<usize>,
    /// The handles a handle list names; empty for any other attribute.
    handles: Vec<HANDLE>,
}

impl AttrList {
    /// Name the only handles the child may inherit. Each must be
    /// inheritable, and the start must ask for inheritance.
    pub(crate) fn handle_list(handles: &[usize]) -> io::Result<AttrList> {
        let mut list = AttrList::new(handles.iter().map(|h| *h as HANDLE).collect())?;
        let value = list.handles.as_ptr() as *const c_void;
        let size = std::mem::size_of::<HANDLE>() * list.handles.len();
        list.update(ATTR_HANDLE_LIST, value, size)?;
        Ok(list)
    }

    /// Attach the child to a pseudoconsole. The attribute's value is the
    /// pseudoconsole handle itself, not a pointer to it.
    pub(crate) fn pseudoconsole(hpc: HPCON) -> io::Result<AttrList> {
        let mut list = AttrList::new(Vec::new())?;
        list.update(ATTR_PSEUDOCONSOLE, hpc as *const c_void, std::mem::size_of::<HPCON>())?;
        Ok(list)
    }

    fn new(handles: Vec<HANDLE>) -> io::Result<AttrList> {
        let mut bytes: usize = 0;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut bytes);
        }
        let mut storage: Vec<usize> = vec![0; bytes / std::mem::size_of::<usize>() + 1];
        if unsafe { InitializeProcThreadAttributeList(storage.as_mut_ptr() as _, 1, 0, &mut bytes) } == 0 {
            return Err(os_error("InitializeProcThreadAttributeList"));
        }
        // From here on, dropping it deletes the list.
        Ok(AttrList { storage, handles })
    }

    fn update(&mut self, attribute: usize, value: *const c_void, size: usize) -> io::Result<()> {
        let ok = unsafe { UpdateProcThreadAttribute(self.as_ptr() as _, 0, attribute, value, size, std::ptr::null_mut(), std::ptr::null()) };
        if ok == 0 {
            return Err(os_error("UpdateProcThreadAttribute"));
        }
        Ok(())
    }

    /// The list, for `STARTUPINFOEXW::lpAttributeList`.
    pub(crate) fn as_ptr(&mut self) -> *mut c_void {
        self.storage.as_mut_ptr() as *mut c_void
    }
}

impl Drop for AttrList {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.as_ptr() as _);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wait_that_fails_is_an_error() {
        // A null handle: the wait fails at once.
        let waited = exit_code(0);
        assert!(waited.is_err(), "a wait that failed read as {waited:?}");
    }
}
