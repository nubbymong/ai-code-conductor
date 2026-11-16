//! The Windows transport: a named pipe (protocol section 15).
//!
//! Every instance carries one security descriptor,
//! `O:<user SID>D:P(A;;GA;;;<user SID>)`: the current user owns it, and a
//! protected list with one entry, that user, says who may open it, so no
//! other account (and no inherited entry) can. The owner matters as much as
//! the list: an owner may always change the list. Remote clients are
//! refused, the first instance is made with `FILE_FLAG_FIRST_PIPE_INSTANCE`
//! (a name someone else already made fails the bind), and a next instance is
//! made before a connected one is handed out, so a client never finds the
//! name missing. An instance a failed connect leaves is reset and kept
//! listening for the same reason. Every later instance shares the first
//! one's security descriptor, so each is checked to be owned by the user and
//! to carry the user-only list before it is used: should the name ever pass
//! to a pipe someone else made, the holder refuses to join it.
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
    DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
    SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
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

/// The SDDL of a pipe the user with SID text `sid` owns and alone may open.
/// A token may always name its own user as an owner.
pub(crate) fn user_only_sddl(sid: &str) -> String {
    format!("O:{sid}D:P(A;;GA;;;{sid})")
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
/// was being cancelled still counts. The system writes into the `OVERLAPPED`
/// while the call runs, so it is reached only through the one raw pointer
/// the call was given, never through a reference.
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
            let wait = match deadline {
                Some(d) => d.saturating_duration_since(Instant::now()).as_millis().clamp(1, u128::from(POLL)) as u32,
                None => POLL,
            };
            if unsafe { WaitForSingleObject(event.0, wait) } == WAIT_OBJECT_0 {
                break;
            }
            let shut = closed.load(Ordering::SeqCst);
            let expired = deadline.map_or(false, |d| Instant::now() >= d);
            if shut || expired {
                let mut n: u32 = 0;
                unsafe {
                    CancelIoEx(handle, ov_ptr);
                    // Wait for the cancel to land: `ov` must outlive the call.
                    if GetOverlappedResult(handle, ov_ptr, &mut n, 1) != 0 {
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
    if unsafe { GetOverlappedResult(handle, ov_ptr, &mut n, 0) } == 0 {
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
}

impl Stream {
    fn from_handle(handle: Handle) -> Stream {
        Stream { inner: Arc::new(Inner { handle, closed: AtomicBool::new(false) }), read_timeout: None }
    }

    /// A second handle on the same connection, for another thread. Its read
    /// timeout starts unset.
    pub fn try_clone(&self) -> io::Result<Stream> {
        Ok(Stream { inner: Arc::clone(&self.inner), read_timeout: None })
    }

    /// One write of `buf`, done within `limit`; how much it took.
    fn write_once(&self, buf: &[u8], limit: Duration) -> io::Result<usize> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "the connection was shut down"));
        }
        let h = self.inner.handle.0;
        let len = buf.len().min(u32::MAX as usize) as u32;
        let ptr = buf.as_ptr();
        let n = overlapped(h, &self.inner.closed, Some(limit), |ov| unsafe { WriteFile(h, ptr, len, std::ptr::null_mut(), ov) })?;
        Ok(n as usize)
    }

    /// Write all of `buf` within `limit` in all, however slowly the peer
    /// reads: each write waits only for the time that is left.
    pub fn write_all_within(&mut self, buf: &[u8], limit: Duration) -> io::Result<()> {
        let deadline = Instant::now() + limit;
        let mut rest = buf;
        while !rest.is_empty() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "the peer did not take the message in time"));
            }
            match self.write_once(rest, left)? {
                0 => return Err(io::Error::new(io::ErrorKind::WriteZero, "the connection took no bytes")),
                n => rest = &rest[n..],
            }
        }
        Ok(())
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
        self.write_once(buf, WRITE_TIMEOUT)
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

    /// A new instance of the pipe. A later one joins the pipe the name
    /// names and takes on that pipe's security descriptor, not the one it is
    /// made with, so it is used only if the user owns that pipe and its list
    /// is the user-only one.
    fn instance(&self, first: bool) -> io::Result<Handle> {
        let h = make_instance(&self.name, &self.descriptor, first)?;
        if !first {
            if let Err(why) = user_only(h.0, &self.user) {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("the pipe's name is held by a pipe that is not private: {why}")));
            }
        }
        Ok(h)
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
        if let Err(e) = connect_client(&h) {
            // Reset and kept listening, so the name stays while the holder
            // lives. One that cannot be reset is replaced, but only by an
            // instance that was made: until then it keeps the name.
            let keep = if unsafe { DisconnectNamedPipe(h.0) } != 0 {
                h
            } else {
                self.instance(false).unwrap_or(h)
            };
            *crate::holder::lock(&self.pending) = Some(keep);
            return Err(e);
        }
        // Keep one instance listening before handing this one out. If that
        // fails, the next accept makes one.
        let next = self.instance(false).ok();
        *crate::holder::lock(&self.pending) = next;
        Ok(Stream::from_handle(h))
    }

    /// The current user owns the pipe, and its access list has exactly one
    /// entry: allow, that user.
    pub fn check_private(&self) -> Result<(), String> {
        let guard = crate::holder::lock(&self.pending);
        match guard.as_ref() {
            Some(h) => user_only(h.0, &self.user),
            None => Err("no instance to read the access list from".to_string()),
        }
    }

    /// Nothing to refresh on Windows.
    pub fn touch(&self) {}

    /// Nothing to remove on Windows: the name goes with the last handle.
    pub fn remove(&self) {}
}

/// Make one instance of the pipe `name` with `descriptor`.
fn make_instance(name: &[u16], descriptor: &LocalBox, first: bool) -> io::Result<Handle> {
    let attrs = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let mut open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
    if first {
        open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    let pipe_mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
    let h = unsafe { CreateNamedPipeW(name.as_ptr(), open_mode, pipe_mode, PIPE_UNLIMITED_INSTANCES, PIPE_BUFFER, PIPE_BUFFER, 0, &attrs) };
    if h == INVALID_HANDLE_VALUE {
        return Err(os_error("CreateNamedPipeW"));
    }
    Ok(Handle(h))
}

/// Wait on instance `h` until a client is connected to it. A client that
/// opened it and closed it again before this call leaves it needing a reset
/// first (`ERROR_NO_DATA`): it is reset and waits again, so a client that
/// came and went never stops the holder listening.
fn connect_client(h: &Handle) -> io::Result<()> {
    loop {
        let event = new_event()?;
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        ov.hEvent = event.0;
        let ov_ptr: *mut OVERLAPPED = &mut ov;
        if unsafe { ConnectNamedPipe(h.0, ov_ptr) } != 0 {
            return Ok(());
        }
        match unsafe { GetLastError() } {
            // A client came between making the instance and this call.
            ERROR_PIPE_CONNECTED => return Ok(()),
            ERROR_IO_PENDING => {
                let mut n: u32 = 0;
                // `ov` outlives the wait, which lasts until a client comes.
                if unsafe { GetOverlappedResult(h.0, ov_ptr, &mut n, 1) } == 0 {
                    return Err(os_error("ConnectNamedPipe"));
                }
                return Ok(());
            }
            ERROR_NO_DATA => {
                if unsafe { DisconnectNamedPipe(h.0) } == 0 {
                    return Err(os_error("DisconnectNamedPipe"));
                }
            }
            code => return Err(io::Error::from_raw_os_error(code as i32)),
        }
    }
}

/// The pipe behind `h` is `user`'s alone: `user` owns it (an owner may
/// always change the list, so another owner could let itself in later), and
/// its access list has exactly one entry: allow, `user`.
fn user_only(h: HANDLE, user: &UserSid) -> Result<(), String> {
    unsafe {
        let mut owner: PSID = std::ptr::null_mut();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let rc = GetSecurityInfo(
            h,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        );
        if rc != 0 {
            return Err(format!("GetSecurityInfo failed: {rc}"));
        }
        let _owned = LocalBox(sd);
        if owner.is_null() || EqualSid(owner, user.sid()) == 0 {
            return Err("the pipe is owned by another account".to_string());
        }
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
        if EqualSid(sid, user.sid()) == 0 {
            return Err("the entry names another account".to_string());
        }
    }
    Ok(())
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
            return Ok(Stream::from_handle(Handle(h)));
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
    use std::sync::mpsc;

    #[test]
    fn the_descriptor_names_one_owner_and_one_allow_entry_for_one_account() {
        assert_eq!(user_only_sddl("S-1-5-21-1-2-3-1001"), "O:S-1-5-21-1-2-3-1001D:P(A;;GA;;;S-1-5-21-1-2-3-1001)");
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

    #[test]
    fn a_client_that_came_and_went_before_the_accept_does_not_stop_the_listening() {
        let l = Arc::new(Listener::bind("transport-came-01").unwrap());
        // A client opens the waiting instance and closes it before any accept.
        drop(connect(l.endpoint(), Duration::from_secs(5)).expect("connect"));
        let server = Arc::clone(&l);
        let served = std::thread::spawn(move || {
            let mut s = server.accept().expect("the next client is accepted");
            s.write_all_within(b"served", Duration::from_secs(5)).expect("write");
        });
        let mut c = connect(l.endpoint(), Duration::from_secs(10)).expect("the name is still there for the next client");
        c.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut buf = [0u8; 16];
        let n = c.read(&mut buf).expect("read");
        assert_eq!(&buf[..n], b"served");
        served.join().unwrap();
    }

    fn squat_name(n: &str) -> String {
        format!(r"\\.\pipe\aicc-helper-transport-squat-{n}-{}", crate::random::hex(16).unwrap())
    }

    /// A holder's listener on `endpoint` with no instance of its own: the
    /// pipe of that name is someone else's.
    fn joining(endpoint: &str) -> Listener {
        let user = UserSid::current().unwrap();
        let descriptor = security_descriptor(&user_only_sddl(&user.to_text().unwrap())).unwrap();
        Listener { endpoint: endpoint.to_string(), name: wide(endpoint), user, descriptor, pending: Mutex::new(None) }
    }

    fn refuses_to_join(l: &Listener, what: &str) {
        match l.instance(false) {
            Ok(_) => panic!("an instance of {what} was used"),
            Err(e) => assert_eq!(e.kind(), io::ErrorKind::PermissionDenied, "{what}: {e:?}"),
        }
        assert!(l.accept().is_err(), "an accept handed out an instance of {what}");
    }

    #[test]
    fn a_later_instance_of_a_pipe_someone_else_made_is_refused() {
        // A pipe of that name that anyone may open, made first.
        let endpoint = squat_name("01");
        let open = security_descriptor("D:P(A;;GA;;;WD)").unwrap();
        let _theirs = make_instance(&wide(&endpoint), &open, true).unwrap();
        refuses_to_join(&joining(&endpoint), "a pipe anyone may open");
        // A later instance of the holder's own pipe is used.
        let mine = Listener::bind("transport-squat-02").unwrap();
        assert!(mine.instance(false).is_ok());
    }

    /// The holder's own list, but another owner, who may change the list at
    /// any time. Administrators stands in for that owner: a token that holds
    /// it may name it as an owner, and CI runs as an administrator.
    #[test]
    fn a_later_instance_of_a_pipe_with_the_users_list_and_another_owner_is_refused() {
        let me = UserSid::current().unwrap().to_text().unwrap();
        let endpoint = squat_name("03");
        let theirs = security_descriptor(&format!("O:BAD:P(A;;GA;;;{me})")).and_then(|sd| make_instance(&wide(&endpoint), &sd, true));
        match theirs {
            Ok(_theirs) => refuses_to_join(&joining(&endpoint), "a pipe another account owns"),
            // ERROR_INVALID_OWNER: this account may not name Administrators.
            // CI must run it, so there it fails instead.
            Err(e) if e.to_string().contains("os error 1307") && std::env::var_os("CI").is_none() => {
                eprintln!("skipped: this account cannot make a pipe that Administrators owns ({e})");
            }
            Err(e) => panic!("could not make a pipe that Administrators owns: {e}"),
        }
    }

    #[test]
    fn a_message_to_a_peer_that_takes_a_little_at_a_time_stops_at_its_deadline() {
        let l = Arc::new(Listener::bind("transport-slow-01").unwrap());
        let server = Arc::clone(&l);
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut s = server.accept().expect("accept");
            let started = Instant::now();
            let r = s.write_all_within(&vec![7u8; 16 * 1024 * 1024], Duration::from_secs(1));
            let _ = tx.send((r, started.elapsed()));
        });
        let mut c = connect(l.endpoint(), Duration::from_secs(10)).expect("connect");
        // 64 KiB every 300 ms: each wait for room is short, the whole message is not.
        let reader = std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                std::thread::sleep(Duration::from_millis(300));
                match c.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
            }
        });
        let (r, took) = rx.recv_timeout(Duration::from_secs(20)).expect("the write waited past its limit");
        let e = r.expect_err("16 MiB went to a peer taking about 200 KiB a second");
        assert!(super::super::is_timeout(&e), "{e:?}");
        assert!(took < Duration::from_secs(3), "one message stretched its 1 second limit to {took:?}");
        reader.join().unwrap();
    }
}
