//! The Windows transport: a named pipe (protocol section 15).
//!
//! Every instance carries one security descriptor, `D:P(A;;GA;;;<user SID>)`:
//! a protected list with one entry, the current user, so no other account
//! (and no inherited entry) can open it. Remote clients are refused, the first
//! instance is made with `FILE_FLAG_FIRST_PIPE_INSTANCE` (a name someone else
//! already made fails the bind), and a next instance is made before a
//! connected one is handed out, so a client never finds the name missing.
//!
//! The handles are overlapped. A handle opened for plain blocking I/O lets
//! one call at a time through, so a thread waiting to read would hold up a
//! write from another; with overlapped I/O each call waits on its own event.
//! A read waits in slices of `POLL`, so `shutdown` (a flag and `CancelIoEx`)
//! and a read timeout both end it. A connection is closed by closing its
//! handle, never with `DisconnectNamedPipe`, which would drop bytes the
//! client has not read yet (a last reply, say).
#![allow(unsafe_code)]

use super::WRITE_TIMEOUT;
use std::ffi::c_void;
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY,
    ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1, SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::{
    AclSizeInformation, EqualSid, GetAce, GetAclInformation, GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION,
    DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
    SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeServerProcessId, WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{CreateEventW, GetCurrentProcess, OpenProcessToken, WaitForSingleObject};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

/// How often a waiting read or write looks at the closed flag and its time limit.
const POLL: u32 = 250;
/// Each direction's pipe buffer.
const PIPE_BUFFER: u32 = 64 * 1024;
/// `ACCESS_ALLOWED_ACE_TYPE`.
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
/// Only pipes on this machine.
const LOCAL_PIPE_PREFIX: &str = r"\\.\pipe\";

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn os_error(what: &str) -> io::Error {
    let e = io::Error::last_os_error();
    io::Error::new(e.kind(), format!("{what}: {e}"))
}

/// An owned kernel handle, closed on drop.
struct Handle(HANDLE);
// A kernel handle may be used from any thread.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// Memory the system allocated with `LocalAlloc`, freed on drop.
struct LocalBox(*mut c_void);
unsafe impl Send for LocalBox {}
unsafe impl Sync for LocalBox {}
impl Drop for LocalBox {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

fn new_event() -> io::Result<Handle> {
    // Manual reset, not signalled, no name.
    let h = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if h.is_null() {
        return Err(os_error("CreateEventW"));
    }
    Ok(Handle(h))
}

/// The current user's SID, as the `TOKEN_USER` buffer that holds it.
struct UserSid {
    buf: Vec<u64>,
}

impl UserSid {
    fn current() -> io::Result<UserSid> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(os_error("OpenProcessToken"));
            }
            let token = Handle(token);
            let mut len: u32 = 0;
            // The first call only says how big the answer is.
            GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut len);
            if len == 0 {
                return Err(os_error("GetTokenInformation (size)"));
            }
            // u64 storage keeps the TOKEN_USER and the SID in it aligned.
            let mut buf: Vec<u64> = vec![0; (len as usize + 7) / 8];
            if GetTokenInformation(token.0, TokenUser, buf.as_mut_ptr() as *mut c_void, len, &mut len) == 0 {
                return Err(os_error("GetTokenInformation"));
            }
            Ok(UserSid { buf })
        }
    }

    fn sid(&self) -> PSID {
        unsafe { (*(self.buf.as_ptr() as *const TOKEN_USER)).User.Sid }
    }

    fn to_text(&self) -> io::Result<String> {
        unsafe {
            let mut text: *mut u16 = std::ptr::null_mut();
            if ConvertSidToStringSidW(self.sid(), &mut text) == 0 {
                return Err(os_error("ConvertSidToStringSidW"));
            }
            let owned = LocalBox(text as *mut c_void);
            let mut n = 0usize;
            while *text.add(n) != 0 {
                n += 1;
            }
            let s = String::from_utf16_lossy(std::slice::from_raw_parts(text, n));
            drop(owned);
            Ok(s)
        }
    }
}

/// The SDDL of a pipe only the user with SID text `sid` may open.
pub(crate) fn user_only_sddl(sid: &str) -> String {
    format!("D:P(A;;GA;;;{sid})")
}

fn security_descriptor(sddl: &str) -> io::Result<LocalBox> {
    let text = wide(sddl);
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let ok = unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) };
    if ok == 0 {
        return Err(os_error("ConvertStringSecurityDescriptorToSecurityDescriptorW"));
    }
    Ok(LocalBox(sd))
}

/// Run one overlapped call and wait for it: until it completes, the
/// connection is shut down, or `limit` passes. A call that completed while it
/// was being cancelled still counts.
fn overlapped(handle: HANDLE, closed: &AtomicBool, limit: Option<Duration>, start: impl FnOnce(*mut OVERLAPPED) -> i32) -> io::Result<u32> {
    let event = new_event()?;
    let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
    ov.hEvent = event.0;
    let ov_ptr: *mut OVERLAPPED = &mut ov;
    if start(ov_ptr) == 0 {
        let err = unsafe { GetLastError() };
        if err != ERROR_IO_PENDING {
            return Err(io::Error::from_raw_os_error(err as i32));
        }
        let deadline = limit.map(|d| Instant::now() + d);
        loop {
            if unsafe { WaitForSingleObject(event.0, POLL) } == WAIT_OBJECT_0 {
                break;
            }
            let shut = closed.load(Ordering::SeqCst);
            let expired = deadline.map_or(false, |d| Instant::now() >= d);
            if shut || expired {
                let mut n: u32 = 0;
                unsafe {
                    CancelIoEx(handle, &ov);
                    // Wait for the cancel to land: `ov` must outlive the call.
                    if GetOverlappedResult(handle, &ov, &mut n, 1) != 0 {
                        return Ok(n);
                    }
                }
                return Err(if shut {
                    io::Error::new(io::ErrorKind::ConnectionAborted, "the connection was shut down")
                } else {
                    io::Error::new(io::ErrorKind::TimedOut, "the pipe did not answer in time")
                });
            }
        }
    }
    let mut n: u32 = 0;
    if unsafe { GetOverlappedResult(handle, &ov, &mut n, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(n)
}

/// The errors that mean the other end has gone: the end of the stream.
fn is_end(e: &io::Error) -> bool {
    if e.kind() == io::ErrorKind::ConnectionAborted {
        return true;
    }
    match e.raw_os_error() {
        Some(code) => [ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED, ERROR_NO_DATA, ERROR_OPERATION_ABORTED].iter().any(|c| *c as i32 == code),
        None => false,
    }
}

struct Inner {
    handle: Handle,
    closed: AtomicBool,
}

pub struct Stream {
    inner: Arc<Inner>,
    read_timeout: Option<Duration>,
    peer_pid: Option<u32>,
}

impl Stream {
    fn from_handle(handle: Handle, peer_pid: Option<u32>) -> Stream {
        Stream { inner: Arc::new(Inner { handle, closed: AtomicBool::new(false) }), read_timeout: None, peer_pid }
    }

    /// A second handle on the same connection, for another thread. Its read
    /// timeout starts unset.
    pub fn try_clone(&self) -> io::Result<Stream> {
        Ok(Stream { inner: Arc::clone(&self.inner), read_timeout: None, peer_pid: self.peer_pid })
    }

    /// None waits for ever. A read that waited this long fails with a timeout.
    pub fn set_read_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
        self.read_timeout = timeout;
        Ok(())
    }

    /// Stop the connection: every waiting read ends as the end of the stream,
    /// every later write fails. The handle closes when the last clone goes.
    pub fn shutdown(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        unsafe {
            CancelIoEx(self.inner.handle.0, std::ptr::null());
        }
    }

    /// End the connection after what was written. A pipe keeps what was
    /// written for the client after the holder's handle closes, so this is
    /// `shutdown`.
    pub fn close_after_writes(&self) {
        self.shutdown();
    }

    /// The Unix transport waits here for the peer to close; a pipe does not
    /// lose what was written when the holder exits, so nothing waits.
    pub fn wait_peer_close(&self, _max: Duration) {}

    /// On a client, the holder's process id as the pipe reports it.
    pub fn peer_pid(&self) -> Option<u32> {
        self.peer_pid
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.inner.closed.load(Ordering::SeqCst) {
            return Ok(0);
        }
        let h = self.inner.handle.0;
        let len = buf.len().min(u32::MAX as usize) as u32;
        let ptr = buf.as_mut_ptr();
        match overlapped(h, &self.inner.closed, self.read_timeout, |ov| unsafe { ReadFile(h, ptr, len, std::ptr::null_mut(), ov) }) {
            Ok(n) => Ok(n as usize),
            Err(e) if is_end(&e) => Ok(0),
            Err(e) => Err(e),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "the connection was shut down"));
        }
        let h = self.inner.handle.0;
        let len = buf.len().min(u32::MAX as usize) as u32;
        let ptr = buf.as_ptr();
        let n = overlapped(h, &self.inner.closed, Some(WRITE_TIMEOUT), |ov| unsafe { WriteFile(h, ptr, len, std::ptr::null_mut(), ov) })?;
        Ok(n as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub struct Listener {
    endpoint: String,
    name: Vec<u16>,
    user: UserSid,
    descriptor: LocalBox,
    /// The instance that waits for the next client.
    pending: Mutex<Option<Handle>>,
}

impl Listener {
    /// Listen on a new random endpoint for `sid`.
    pub fn bind(sid: &str) -> io::Result<Listener> {
        let random = crate::random::hex(super::ENDPOINT_RANDOM_HEX / 2)?;
        Listener::bind_at(&super::endpoint_name(sid, &random))
    }

    /// Listen on exactly `endpoint`. A pipe of that name that already exists,
    /// ours or anyone's, fails the bind.
    pub fn bind_at(endpoint: &str) -> io::Result<Listener> {
        if !endpoint.starts_with(LOCAL_PIPE_PREFIX) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a local pipe name"));
        }
        let user = UserSid::current()?;
        let descriptor = security_descriptor(&user_only_sddl(&user.to_text()?))?;
        let mut l = Listener { endpoint: endpoint.to_string(), name: wide(endpoint), user, descriptor, pending: Mutex::new(None) };
        let first = l.instance(true)?;
        l.pending = Mutex::new(Some(first));
        Ok(l)
    }

    fn instance(&self, first: bool) -> io::Result<Handle> {
        let attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.0,
            bInheritHandle: 0,
        };
        let mut open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
        if first {
            open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
        }
        let pipe_mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
        let h = unsafe { CreateNamedPipeW(self.name.as_ptr(), open_mode, pipe_mode, PIPE_UNLIMITED_INSTANCES, PIPE_BUFFER, PIPE_BUFFER, 0, &attrs) };
        if h == INVALID_HANDLE_VALUE {
            return Err(os_error("CreateNamedPipeW"));
        }
        Ok(Handle(h))
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Wait for the next client. Only the user's own processes can get this
    /// far: the pipe's security descriptor lets no one else open it.
    pub fn accept(&self) -> io::Result<Stream> {
        let taken = crate::holder::lock(&self.pending).take();
        let h = match taken {
            Some(h) => h,
            None => self.instance(false)?,
        };
        let event = new_event()?;
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        ov.hEvent = event.0;
        if unsafe { ConnectNamedPipe(h.0, &mut ov) } == 0 {
            match unsafe { GetLastError() } {
                // A client came between making the instance and this call.
                ERROR_PIPE_CONNECTED => {}
                ERROR_IO_PENDING => {
                    let mut n: u32 = 0;
                    if unsafe { GetOverlappedResult(h.0, &ov, &mut n, 1) } == 0 {
                        return Err(os_error("ConnectNamedPipe"));
                    }
                }
                code => return Err(io::Error::from_raw_os_error(code as i32)),
            }
        }
        // Keep one instance listening before handing this one out. If that
        // fails, the next accept makes one.
        let next = self.instance(false).ok();
        *crate::holder::lock(&self.pending) = next;
        Ok(Stream::from_handle(h, None))
    }

    /// The pipe's access list has exactly one entry: allow, the current user.
    pub fn check_private(&self) -> Result<(), String> {
        let guard = crate::holder::lock(&self.pending);
        let h = match guard.as_ref() {
            Some(h) => h.0,
            None => return Err("no instance to read the access list from".to_string()),
        };
        unsafe {
            let mut dacl: *mut ACL = std::ptr::null_mut();
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let rc = GetSecurityInfo(
                h,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut sd,
            );
            if rc != 0 {
                return Err(format!("GetSecurityInfo failed: {rc}"));
            }
            let _owned = LocalBox(sd);
            if dacl.is_null() {
                return Err("the pipe has no access list (anyone may open it)".to_string());
            }
            let mut info: ACL_SIZE_INFORMATION = std::mem::zeroed();
            if GetAclInformation(dacl, &mut info as *mut ACL_SIZE_INFORMATION as *mut c_void, std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation) == 0 {
                return Err("GetAclInformation failed".to_string());
            }
            if info.AceCount != 1 {
                return Err(format!("the access list has {} entries, not 1", info.AceCount));
            }
            let mut ace: *mut c_void = std::ptr::null_mut();
            if GetAce(dacl, 0, &mut ace) == 0 || ace.is_null() {
                return Err("GetAce failed".to_string());
            }
            let ace = ace as *const ACCESS_ALLOWED_ACE;
            if (*ace).Header.AceType != ACCESS_ALLOWED_ACE_TYPE {
                return Err(format!("the entry is of type {}, not allow", (*ace).Header.AceType));
            }
            let sid = std::ptr::addr_of!((*ace).SidStart) as *mut c_void;
            if EqualSid(sid, self.user.sid()) == 0 {
                return Err("the entry names another account".to_string());
            }
        }
        Ok(())
    }

    /// Nothing to refresh on Windows.
    pub fn touch(&self) {}

    /// Nothing to remove on Windows: the name goes with the last handle.
    pub fn remove(&self) {}
}

/// Nothing to remove on Windows: a pipe's name goes with its last handle.
pub fn remove_stale_endpoint(_endpoint: &str) {}

/// Connect to a holder's pipe. `NotFound` means no holder listens there. A
/// busy pipe is waited for, up to `timeout`.
pub fn connect(endpoint: &str, timeout: Duration) -> io::Result<Stream> {
    if !endpoint.starts_with(LOCAL_PIPE_PREFIX) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a local pipe name"));
    }
    let name = wide(endpoint);
    let deadline = Instant::now() + timeout;
    loop {
        // Identification only: the holder may learn who we are, never act as us.
        let h = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                std::ptr::null_mut(),
            )
        };
        if h != INVALID_HANDLE_VALUE {
            let h = Handle(h);
            let mut pid: u32 = 0;
            let peer = if unsafe { GetNamedPipeServerProcessId(h.0, &mut pid) } != 0 { Some(pid) } else { None };
            return Ok(Stream::from_handle(h, peer));
        }
        let err = unsafe { GetLastError() };
        let now = Instant::now();
        if err == ERROR_PIPE_BUSY && now < deadline {
            let wait = (deadline - now).as_millis().clamp(1, 1000) as u32;
            unsafe {
                WaitNamedPipeW(name.as_ptr(), wait);
            }
            continue;
        }
        return Err(io::Error::from_raw_os_error(err as i32));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_descriptor_names_one_allow_entry_for_one_account() {
        assert_eq!(user_only_sddl("S-1-5-21-1-2-3-1001"), "D:P(A;;GA;;;S-1-5-21-1-2-3-1001)");
        let me = UserSid::current().unwrap().to_text().unwrap();
        assert!(me.starts_with("S-1-"), "{me}");
    }

    #[test]
    fn a_bound_pipe_allows_only_this_user_and_its_name_cannot_be_bound_twice() {
        let l = Listener::bind("transport-0001").unwrap();
        l.check_private().unwrap();
        assert!(Listener::bind_at(l.endpoint()).is_err(), "a second first instance of a live name");
        assert!(Listener::bind_at(r"\\server\pipe\aicc-helper-transport-0001-00").is_err(), "a remote name");
        let gone = format!("{}-gone", l.endpoint());
        drop(l);
        match connect(&gone, Duration::from_millis(200)) {
            Err(e) => assert!(super::super::means_gone(&e), "{e:?}"),
            Ok(_) => panic!("connected to a pipe that does not exist"),
        }
    }
}
