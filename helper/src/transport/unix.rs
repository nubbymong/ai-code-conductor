//! The Unix transport: a socket in `/tmp/aicc-<uid>` (protocol section 15).
//!
//! The folder must be a real folder (not a link) owned by the user; it is made
//! 0700, and set back to 0700 if its mode drifted. The socket is bound with a
//! umask of 0177, so it is 0600 from its first moment, and is set to 0600
//! again after. Every accepted connection's peer user id must be the user's;
//! one that is not is closed before a byte is written. A client checks the
//! folder, the socket's type and owner, and the peer user id the same way.
#![allow(unsafe_code)]

use super::WRITE_TIMEOUT;
use std::ffi::CString;
use std::fs;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn euid() -> u32 {
    unsafe { libc::geteuid() }
}

/// The user's run folder: every holder socket of this user lives in it.
pub fn run_dir() -> PathBuf {
    PathBuf::from(format!("/tmp/aicc-{}", euid()))
}

/// True when a connection from `peer_uid` may be served by a holder running as `me`.
pub fn peer_allowed(peer_uid: u32, me: u32) -> bool {
    peer_uid == me
}

fn refused(what: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, what)
}

/// Check a run folder as a client must find it: a real folder, the user's,
/// open to nobody else.
fn check_dir(dir: &Path) -> io::Result<()> {
    let md = fs::symlink_metadata(dir)?;
    if !md.file_type().is_dir() {
        return Err(refused(format!("{} is not a real folder", dir.display())));
    }
    if md.uid() != euid() {
        return Err(refused(format!("{} belongs to another user", dir.display())));
    }
    if md.mode() & 0o077 != 0 {
        return Err(refused(format!("{} is open to other users", dir.display())));
    }
    Ok(())
}

/// Make the run folder, or check the one that is there and set its mode back
/// to 0700. A link, a file, or a folder of another user is refused.
pub fn prepare_run_dir(dir: &Path) -> io::Result<()> {
    match fs::symlink_metadata(dir) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => match fs::DirBuilder::new().mode(0o700).create(dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        },
        Err(e) => return Err(e),
    }
    let md = fs::symlink_metadata(dir)?;
    if !md.file_type().is_dir() {
        return Err(refused(format!("{} is not a real folder", dir.display())));
    }
    if md.uid() != euid() {
        return Err(refused(format!("{} belongs to another user", dir.display())));
    }
    if md.mode() & 0o777 != 0o700 {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    check_dir(dir)
}

/// The peer's user id and, where the OS says, its process id.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_cred(fd: libc::c_int) -> io::Result<(u32, Option<u32>)> {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_PEERCRED, &mut cred as *mut libc::ucred as *mut libc::c_void, &mut len) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    let pid = if cred.pid > 0 { Some(cred.pid as u32) } else { None };
    Ok((cred.uid, pid))
}

#[cfg(target_vendor = "apple")]
fn peer_cred(fd: libc::c_int) -> io::Result<(u32, Option<u32>)> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    let rc = unsafe { libc::getsockopt(fd, libc::SOL_LOCAL, libc::LOCAL_PEERPID, &mut pid as *mut libc::pid_t as *mut libc::c_void, &mut len) };
    let pid = if rc == 0 && pid > 0 { Some(pid as u32) } else { None };
    Ok((uid, pid))
}

/// Any other Unix: the peer cannot be checked, so no connection is served.
#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
fn peer_cred(_fd: libc::c_int) -> io::Result<(u32, Option<u32>)> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "this OS cannot say who the peer is"))
}

pub struct Stream {
    inner: UnixStream,
    peer_pid: Option<u32>,
}

impl Stream {
    fn new(inner: UnixStream, peer_pid: Option<u32>) -> io::Result<Stream> {
        inner.set_write_timeout(Some(WRITE_TIMEOUT))?;
        Ok(Stream { inner, peer_pid })
    }

    /// A second handle on the same connection, for another thread.
    pub fn try_clone(&self) -> io::Result<Stream> {
        Ok(Stream { inner: self.inner.try_clone()?, peer_pid: self.peer_pid })
    }

    /// None waits for ever. A read that waited this long fails with a timeout.
    pub fn set_read_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
        self.inner.set_read_timeout(timeout)
    }

    /// End the connection both ways at once. A blocked reader on any clone
    /// wakes with the end of the stream. On macOS bytes the peer has not read
    /// yet can be lost, so a connection that ends after a last message uses
    /// `close_after_writes`.
    pub fn shutdown(&self) {
        unsafe {
            libc::shutdown(self.inner.as_raw_fd(), libc::SHUT_RDWR);
        }
    }

    /// End the connection after what was written: the peer reads it, then the
    /// end of the stream. The cut both ways, which also wakes a reader blocked
    /// on this side, comes `LINGER` later.
    pub fn close_after_writes(&self) {
        unsafe {
            libc::shutdown(self.inner.as_raw_fd(), libc::SHUT_WR);
        }
        match self.inner.try_clone() {
            Ok(late) => {
                std::thread::spawn(move || {
                    std::thread::sleep(super::LINGER);
                    unsafe {
                        libc::shutdown(late.as_raw_fd(), libc::SHUT_RDWR);
                    }
                });
            }
            Err(_) => self.shutdown(),
        }
    }

    /// Wait up to `max` for the peer to close its end, which it does once it
    /// has read everything; what it still sends is read and dropped. Used
    /// before the holder exits, so its last message is not cut off.
    pub fn wait_peer_close(&self, max: Duration) {
        let mut s = match self.inner.try_clone() {
            Ok(s) => s,
            Err(_) => return,
        };
        let deadline = std::time::Instant::now() + max;
        let mut buf = [0u8; 4096];
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() || s.set_read_timeout(Some(left)).is_err() {
                return;
            }
            match s.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        }
    }

    /// The peer's process id, where the OS reports it.
    pub fn peer_pid(&self) -> Option<u32> {
        self.peer_pid
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

pub struct Listener {
    inner: UnixListener,
    path: PathBuf,
    endpoint: String,
    /// Device and inode of the socket file we bound, so `remove` never
    /// deletes a file someone put in its place.
    id: (u64, u64),
}

fn endpoint_dir(path: &Path) -> io::Result<&Path> {
    let dir = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "an endpoint needs a folder"))?;
    if dir != run_dir() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{} is not this user's run folder", dir.display())));
    }
    Ok(dir)
}

impl Listener {
    /// Listen on a new random endpoint for `sid`.
    pub fn bind(sid: &str) -> io::Result<Listener> {
        let random = crate::random::hex(super::ENDPOINT_RANDOM_HEX / 2)?;
        Listener::bind_at(&super::endpoint_name(sid, &random))
    }

    /// Listen on exactly `endpoint`, which must be in the run folder. A file
    /// already there is never removed: the bind fails instead.
    pub fn bind_at(endpoint: &str) -> io::Result<Listener> {
        let path = PathBuf::from(endpoint);
        let dir = endpoint_dir(&path)?;
        prepare_run_dir(dir)?;
        // 0600 from the moment the file exists. The umask is the process's,
        // so it is put back at once.
        let old = unsafe { libc::umask(0o177) };
        let bound = UnixListener::bind(&path);
        unsafe {
            libc::umask(old);
        }
        let inner = bound?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        let md = fs::symlink_metadata(&path)?;
        Ok(Listener { inner, path, endpoint: endpoint.to_string(), id: (md.dev(), md.ino()) })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// The next connection whose peer is this user. Others are closed unread.
    pub fn accept(&self) -> io::Result<Stream> {
        loop {
            let (s, _) = self.inner.accept()?;
            match peer_cred(s.as_raw_fd()) {
                Ok((uid, pid)) if peer_allowed(uid, euid()) => return Stream::new(s, pid),
                _ => drop(s),
            }
        }
    }

    /// The folder is 0700 and the socket 0600, both this user's.
    pub fn check_private(&self) -> Result<(), String> {
        let dir = self.path.parent().ok_or("no folder")?;
        let d = fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
        if !d.file_type().is_dir() || d.uid() != euid() || d.mode() & 0o777 != 0o700 {
            return Err(format!("the run folder is not a 0700 folder of this user (mode {:o})", d.mode() & 0o7777));
        }
        let s = fs::symlink_metadata(&self.path).map_err(|e| e.to_string())?;
        if !s.file_type().is_socket() || s.uid() != euid() || s.mode() & 0o777 != 0o600 {
            return Err(format!("the socket is not a 0600 socket of this user (mode {:o})", s.mode() & 0o7777));
        }
        Ok(())
    }

    /// Mark the socket and its folder as used now, so a cleaner of old files
    /// in /tmp does not take them from a long session.
    pub fn touch(&self) {
        for p in [self.path.as_path(), self.path.parent().unwrap_or(Path::new("/"))] {
            if p == Path::new("/") {
                continue;
            }
            if let Ok(c) = CString::new(p.as_os_str().as_bytes()) {
                unsafe {
                    libc::utimes(c.as_ptr(), std::ptr::null());
                }
            }
        }
    }

    /// Remove the socket file, if it is still the one we bound.
    pub fn remove(&self) {
        if let Ok(md) = fs::symlink_metadata(&self.path) {
            if (md.dev(), md.ino()) == self.id {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.remove();
    }
}

/// Remove the socket file a gone holder left, if it is in this user's run
/// folder and is this user's socket. List mode calls it for stale records.
pub fn remove_stale_endpoint(endpoint: &str) {
    let path = Path::new(endpoint);
    if endpoint_dir(path).is_err() {
        return;
    }
    if let Ok(md) = fs::symlink_metadata(path) {
        if md.file_type().is_socket() && md.uid() == euid() {
            let _ = fs::remove_file(path);
        }
    }
}

fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "the holder did not take the connection in time")
}

/// Wait until a connect in progress on `fd` has finished, by `deadline`.
fn wait_connected(fd: RawFd, deadline: Instant) -> io::Result<()> {
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(timed_out());
        }
        let mut p = libc::pollfd { fd, events: libc::POLLOUT, revents: 0 };
        let ms = left.as_millis().clamp(1, i32::MAX as u128) as libc::c_int;
        let n = unsafe { libc::poll(&mut p, 1, ms) };
        if n < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e);
        }
        if n == 0 {
            continue;
        }
        let mut err: libc::c_int = 0;
        let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        if unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_ERROR, (&mut err as *mut libc::c_int).cast(), &mut len) } < 0 {
            return Err(io::Error::last_os_error());
        }
        if err != 0 {
            return Err(io::Error::from_raw_os_error(err));
        }
        return Ok(());
    }
}

/// Connect to the socket at `path` within `timeout`. A blocking connect on
/// Linux waits for as long as the listener's backlog is full (a holder that
/// is stopped or stuck). This socket is nonblocking while it connects, so
/// that case answers at once and is tried again until `timeout`, then fails
/// as a timeout, which proves nothing about the holder (`means_gone`).
fn connect_within(path: &Path, timeout: Duration) -> io::Result<UnixStream> {
    let bytes = path.as_os_str().as_bytes();
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.len() >= addr.sun_path.len() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "the socket path is too long"));
    }
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (dst, src) in addr.sun_path.iter_mut().zip(bytes) {
        *dst = *src as libc::c_char;
    }
    let len = (std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1) as libc::socklen_t;
    #[cfg(target_vendor = "apple")]
    {
        addr.sun_len = len as u8;
    }
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    // Owned from here, so every return below closes it.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    unsafe {
        libc::fcntl(raw, libc::F_SETFD, libc::FD_CLOEXEC);
    }
    #[cfg(target_vendor = "apple")]
    {
        // A write to a closed peer fails instead of raising SIGPIPE.
        let one: libc::c_int = 1;
        unsafe {
            libc::setsockopt(raw, libc::SOL_SOCKET, libc::SO_NOSIGPIPE, (&one as *const libc::c_int).cast(), std::mem::size_of::<libc::c_int>() as libc::socklen_t);
        }
    }
    let flags = unsafe { libc::fcntl(raw, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let deadline = Instant::now() + timeout;
    loop {
        let rc = unsafe { libc::connect(raw, (&addr as *const libc::sockaddr_un).cast(), len) };
        if rc == 0 {
            break;
        }
        let err = io::Error::last_os_error();
        match err.raw_os_error() {
            Some(libc::EINTR) => continue,
            Some(libc::EISCONN) => break,
            // Linux: the backlog is full and nothing was started. Again soon.
            Some(libc::EAGAIN) => {
                if Instant::now() >= deadline {
                    return Err(timed_out());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Some(libc::EINPROGRESS) | Some(libc::EALREADY) => {
                wait_connected(raw, deadline)?;
                break;
            }
            _ => return Err(err),
        }
    }
    if unsafe { libc::fcntl(raw, libc::F_SETFL, flags) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(UnixStream::from(fd))
}

/// Connect to a holder's endpoint within `timeout`. `NotFound` or
/// `ConnectionRefused` mean no holder listens there; a timeout means no clear
/// answer.
pub fn connect(endpoint: &str, timeout: Duration) -> io::Result<Stream> {
    let path = Path::new(endpoint);
    check_dir(endpoint_dir(path)?)?;
    let md = fs::symlink_metadata(path)?;
    if !md.file_type().is_socket() || md.uid() != euid() {
        return Err(refused(format!("{endpoint} is not a socket of this user")));
    }
    let s = connect_within(path, timeout)?;
    let (uid, pid) = peer_cred(s.as_raw_fd())?;
    if !peer_allowed(uid, euid()) {
        return Err(refused("the holder on that socket runs as another user".to_string()));
    }
    Stream::new(s, pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("aicc-transport-{name}-{}", std::process::id()));
        let _ = fs::remove_file(&p);
        let _ = fs::remove_dir(&p);
        p
    }

    #[test]
    fn only_the_same_user_is_served() {
        assert!(peer_allowed(501, 501));
        assert!(!peer_allowed(0, 501), "not even root");
        assert!(!peer_allowed(502, 501));
    }

    #[test]
    fn a_run_folder_is_made_0700_and_a_loose_one_is_tightened() {
        let dir = scratch("dir");
        prepare_run_dir(&dir).unwrap();
        assert_eq!(fs::symlink_metadata(&dir).unwrap().mode() & 0o777, 0o700);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(check_dir(&dir).is_err(), "a client refuses a folder others can enter");
        prepare_run_dir(&dir).unwrap();
        assert_eq!(fs::symlink_metadata(&dir).unwrap().mode() & 0o777, 0o700);
        fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn a_link_or_a_file_in_place_of_the_run_folder_is_refused() {
        let target = scratch("target");
        fs::create_dir(&target).unwrap();
        let link = scratch("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(prepare_run_dir(&link).is_err(), "a link to a folder");
        assert!(check_dir(&link).is_err());
        fs::remove_file(&link).unwrap();
        fs::remove_dir(&target).unwrap();
        let file = scratch("file");
        fs::write(&file, b"x").unwrap();
        assert!(prepare_run_dir(&file).is_err(), "a file");
        fs::remove_file(&file).unwrap();
    }

    #[test]
    fn an_endpoint_outside_the_run_folder_is_refused() {
        let elsewhere = std::env::temp_dir().join("aicc-elsewhere-sess-0001-0123456789abcdef.sock");
        assert!(Listener::bind_at(&elsewhere.to_string_lossy()).is_err());
        assert!(connect(&elsewhere.to_string_lossy(), Duration::from_secs(1)).is_err());
    }

    /// A holder that has stopped taking connections fills its backlog. Linux
    /// would make a blocking connect wait for as long as that lasts.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_connect_to_a_full_backlog_times_out_instead_of_waiting() {
        let l = Listener::bind("transport-full-01").unwrap();
        // The smallest backlog: one connection may wait to be accepted.
        assert_eq!(unsafe { libc::listen(l.inner.as_raw_fd(), 0) }, 0);
        let endpoint = l.endpoint().to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut waiting = Vec::new();
            for _ in 0..64 {
                match connect(&endpoint, Duration::from_millis(300)) {
                    Ok(s) => waiting.push(s),
                    Err(e) => {
                        let _ = tx.send((waiting.len(), Some(e)));
                        return;
                    }
                }
            }
            let _ = tx.send((waiting.len(), None));
        });
        let (taken, e) = rx.recv_timeout(Duration::from_secs(20)).expect("a connect waited on a full backlog");
        let e = e.unwrap_or_else(|| panic!("{taken} connections and the backlog never filled"));
        assert!(taken >= 1, "not even the first connection was taken: {e:?}");
        assert!(super::super::is_timeout(&e), "{e:?}");
        assert!(!super::super::means_gone(&e), "a full backlog is not a gone holder: {e:?}");
        drop(l);
    }

    #[test]
    fn a_bound_socket_is_private_and_its_name_cannot_be_bound_twice() {
        let l = Listener::bind("transport-0001").unwrap();
        l.check_private().unwrap();
        assert!(Listener::bind_at(l.endpoint()).is_err(), "a second bind over a live socket");
        let path = PathBuf::from(l.endpoint());
        drop(l);
        assert!(!path.exists(), "the socket file stays after the listener is gone");
    }
}
