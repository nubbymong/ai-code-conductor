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

/// Flags for every send besides `MSG_DONTWAIT`: Linux can refuse to raise
/// SIGPIPE per call. Elsewhere a Rust program ignores SIGPIPE, and a client's
/// socket on macOS carries `SO_NOSIGPIPE` as well.
#[cfg(any(target_os = "linux", target_os = "android"))]
const SEND_FLAGS: libc::c_int = libc::MSG_NOSIGNAL;
#[cfg(not(any(target_os = "linux", target_os = "android")))]
const SEND_FLAGS: libc::c_int = 0;

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

/// The check every listener applies to a peer: the same user as this process.
fn same_user(peer_uid: u32) -> bool {
    peer_allowed(peer_uid, euid())
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

/// The peer's user id.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_uid(fd: libc::c_int) -> io::Result<u32> {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_PEERCRED, &mut cred as *mut libc::ucred as *mut libc::c_void, &mut len) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(cred.uid)
}

#[cfg(target_vendor = "apple")]
fn peer_uid(fd: libc::c_int) -> io::Result<u32> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}

/// Any other Unix: the peer cannot be checked, so no connection is served.
#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
fn peer_uid(_fd: libc::c_int) -> io::Result<u32> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "this OS cannot say who the peer is"))
}

pub struct Stream {
    inner: UnixStream,
}

/// A timeout set on a connection that has already ended both ways counts as
/// set. macOS refuses to set any socket option on such a socket, with EINVAL
/// (the peer closed it, or both halves were shut), where Linux sets the option.
/// That socket never waits: a read gives what is still buffered, then the
/// end of the stream, and a write fails at once. So the refusal is no error
/// here, and the read or write that follows says how the connection ended,
/// as it does on Linux (aicc_planning#396). It counts only when a read on
/// the socket would not wait now; any other refusal is the error it was.
#[cfg(target_vendor = "apple")]
fn set_unless_ended(fd: RawFd, set: io::Result<()>) -> io::Result<()> {
    match set {
        Err(e) if e.raw_os_error() == Some(libc::EINVAL) && read_would_not_wait(fd) => Ok(()),
        other => other,
    }
}

#[cfg(not(target_vendor = "apple"))]
fn set_unless_ended(_fd: RawFd, set: io::Result<()>) -> io::Result<()> {
    set
}

/// True when a read on `fd` would return at once: bytes, the end of the
/// stream, or an error.
#[cfg(target_vendor = "apple")]
fn read_would_not_wait(fd: RawFd) -> bool {
    let mut p = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
    unsafe { libc::poll(&mut p, 1, 0) > 0 }
}

impl Stream {
    fn new(inner: UnixStream) -> io::Result<Stream> {
        // For a plain `write` (a client's). The holder writes with
        // `write_all_within`, whose limit is for the whole message.
        set_unless_ended(inner.as_raw_fd(), inner.set_write_timeout(Some(WRITE_TIMEOUT)))?;
        Ok(Stream { inner })
    }

    /// A second handle on the same connection, for another thread.
    pub fn try_clone(&self) -> io::Result<Stream> {
        Ok(Stream { inner: self.inner.try_clone()? })
    }

    /// None waits for ever. A read that waited this long fails with a timeout.
    /// On a connection that has ended both ways, where a read never waits,
    /// this succeeds on every system (`set_unless_ended`).
    pub fn set_read_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
        set_unless_ended(self.inner.as_raw_fd(), self.inner.set_read_timeout(timeout))
    }

    /// Write all of `buf` within `limit` in all, however slowly the peer
    /// reads. Each send takes only what fits at once (`send_now`, which
    /// leaves the descriptor blocking for a reader on another clone), and a
    /// wait for room waits only for the time that is left. A socket's own
    /// send timeout cannot do this: it limits each wait inside one write, so
    /// a peer that takes a little at a time could stretch one message far
    /// past it.
    pub fn write_all_within(&mut self, buf: &[u8], limit: Duration) -> io::Result<()> {
        let deadline = Instant::now() + limit;
        let fd = self.inner.as_raw_fd();
        let mut rest = buf;
        while !rest.is_empty() {
            if Instant::now() >= deadline {
                return Err(too_slow());
            }
            match send_now(fd, rest) {
                Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "the connection took no bytes")),
                Ok(n) => rest = &rest[n..],
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => wait_writable(fd, deadline)?,
                Err(e) => return Err(e),
            }
        }
        Ok(())
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
    /// on this side, comes `LINGER` later; if no thread can be made to wait
    /// for that, it comes at once.
    pub fn close_after_writes(&self) {
        unsafe {
            libc::shutdown(self.inner.as_raw_fd(), libc::SHUT_WR);
        }
        let late = match self.inner.try_clone() {
            Ok(late) => late,
            Err(_) => return self.shutdown(),
        };
        let started = std::thread::Builder::new().spawn(move || {
            std::thread::sleep(super::LINGER);
            unsafe {
                libc::shutdown(late.as_raw_fd(), libc::SHUT_RDWR);
            }
        });
        if started.is_err() {
            self.shutdown();
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

fn too_slow() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "the peer did not take the message in time")
}

/// One send of what fits now, without waiting for room: `WouldBlock` when
/// nothing fits.
#[cfg(not(target_vendor = "apple"))]
fn send_now(fd: RawFd, buf: &[u8]) -> io::Result<usize> {
    let n = unsafe { libc::send(fd, buf.as_ptr().cast(), buf.len(), libc::MSG_DONTWAIT | SEND_FLAGS) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(n as usize)
}

/// One send of what fits now, without waiting for room: `WouldBlock` when
/// nothing fits. macOS does not honour `MSG_DONTWAIT` on a send: a blocking
/// send waits for room as often as it needs, each wait under the socket's
/// own timeout, so a peer that reads a little at a time keeps one send going
/// (a 16 MiB message took 12 minutes in CI). A socket that polls writable has
/// room for at least its low-water mark, and a send of no more than that
/// never waits; so this asks without waiting and sends that much.
#[cfg(target_vendor = "apple")]
fn send_now(fd: RawFd, buf: &[u8]) -> io::Result<usize> {
    let mut p = libc::pollfd { fd, events: libc::POLLOUT, revents: 0 };
    let ready = unsafe { libc::poll(&mut p, 1, 0) };
    if ready < 0 {
        return Err(io::Error::last_os_error());
    }
    if ready == 0 {
        return Err(io::Error::from(io::ErrorKind::WouldBlock));
    }
    // Room, or an error or a hang-up, which the send reports.
    let n = unsafe { libc::send(fd, buf.as_ptr().cast(), buf.len().min(low_water(fd)), SEND_FLAGS) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(n as usize)
}

/// The socket's send low-water mark: the room it has whenever it polls
/// writable (2048 bytes unless set). 1 if it cannot be read, which is slow
/// but never waits.
#[cfg(target_vendor = "apple")]
fn low_water(fd: RawFd) -> usize {
    let mut v: libc::c_int = 0;
    let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    let rc = unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_SNDLOWAT, (&mut v as *mut libc::c_int).cast(), &mut len) };
    if rc < 0 || v < 1 {
        return 1;
    }
    v as usize
}

/// Wait until `fd` can take more bytes, by `deadline`.
fn wait_writable(fd: RawFd, deadline: Instant) -> io::Result<()> {
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(too_slow());
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
        if n > 0 {
            // Room, or an error or a hang-up, which the next send reports.
            return Ok(());
        }
    }
}

pub struct Listener {
    inner: UnixListener,
    path: PathBuf,
    endpoint: String,
    /// Device and inode of the socket file we bound, so `remove` never
    /// deletes a file someone put in its place.
    id: (u64, u64),
    /// Whether a peer with this user id is served: always `same_user`; a
    /// test swaps it to show that a refused peer is closed unread.
    peer_ok: fn(u32) -> bool,
}

fn endpoint_dir(path: &Path) -> io::Result<&Path> {
    let dir = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "an endpoint needs a folder"))?;
    if dir != run_dir() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{} is not this user's run folder", dir.display())));
    }
    Ok(dir)
}

/// Bind a socket at `path` that is 0600 from the moment it exists. The umask
/// is the process's, so it is put back at once.
fn bind_private(path: &Path) -> io::Result<UnixListener> {
    let old = unsafe { libc::umask(0o177) };
    let bound = UnixListener::bind(path);
    unsafe {
        libc::umask(old);
    }
    bound
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
        let inner = bind_private(&path)?;
        // The file is ours from here: a failure below removes it again.
        let id = match fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).and_then(|()| fs::symlink_metadata(&path)) {
            Ok(md) => (md.dev(), md.ino()),
            Err(e) => {
                drop(inner);
                let _ = fs::remove_file(&path);
                return Err(e);
            }
        };
        Ok(Listener { inner, path, endpoint: endpoint.to_string(), id, peer_ok: same_user })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// The next connection whose peer is this user. Others are closed unread.
    pub fn accept(&self) -> io::Result<Stream> {
        loop {
            let (s, _) = self.inner.accept()?;
            match peer_uid(s.as_raw_fd()) {
                Ok(uid) if (self.peer_ok)(uid) => return Stream::new(s),
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

/// One connect to the socket at `path`, done by `deadline`. A blocking
/// connect on Linux waits for as long as the listener's backlog is full (a
/// holder that is stopped or stuck). This socket is nonblocking while it
/// connects, so that case answers at once and is tried again until the
/// deadline, then fails as a timeout, which proves nothing about the holder
/// (`means_gone`).
fn connect_once(path: &Path, deadline: Instant) -> io::Result<UnixStream> {
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
    // Closed on exec from its first moment where the OS can do that, so a
    // process another thread starts meanwhile never carries it; macOS has
    // no such flag, and it is set just after instead.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let kind = libc::SOCK_STREAM | libc::SOCK_CLOEXEC;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let kind = libc::SOCK_STREAM;
    let raw = unsafe { libc::socket(libc::AF_UNIX, kind, 0) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    // Owned from here, so every return below closes it.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        unsafe {
            libc::fcntl(raw, libc::F_SETFD, libc::FD_CLOEXEC);
        }
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

/// Connect within `timeout`.
#[cfg(not(target_vendor = "apple"))]
fn connect_within(path: &Path, timeout: Duration) -> io::Result<UnixStream> {
    connect_once(path, Instant::now() + timeout)
}

/// Connect within `timeout`. macOS refuses a connection to a socket whose
/// listen queue is full exactly as it refuses one with nothing listening
/// (`ECONNREFUSED`), so a refusal is tried again, on a new socket each time,
/// until `timeout`, and is then a timeout: no clear answer, never "nothing
/// there". A socket file with nothing on it (its holder died) is told apart
/// by the record's process id, which list mode checks first.
#[cfg(target_vendor = "apple")]
fn connect_within(path: &Path, timeout: Duration) -> io::Result<UnixStream> {
    let deadline = Instant::now() + timeout;
    loop {
        match connect_once(path, deadline) {
            Err(e) if e.raw_os_error() == Some(libc::ECONNREFUSED) => {
                if Instant::now() >= deadline {
                    return Err(timed_out());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            other => return other,
        }
    }
}

/// Connect to a holder's endpoint within `timeout`. `NotFound` (and, on
/// Linux, `ConnectionRefused`) mean no holder listens there; a timeout means
/// no clear answer.
pub fn connect(endpoint: &str, timeout: Duration) -> io::Result<Stream> {
    let path = Path::new(endpoint);
    check_dir(endpoint_dir(path)?)?;
    let md = fs::symlink_metadata(path)?;
    if !md.file_type().is_socket() || md.uid() != euid() {
        return Err(refused(format!("{endpoint} is not a socket of this user")));
    }
    let s = connect_within(path, timeout)?;
    if !peer_allowed(peer_uid(s.as_raw_fd())?, euid()) {
        return Err(refused("the holder on that socket runs as another user".to_string()));
    }
    Stream::new(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

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

    static REFUSED_ONE: AtomicBool = AtomicBool::new(false);

    /// Refuses the first peer it is asked about, then serves every one.
    fn refuse_the_first(_uid: u32) -> bool {
        REFUSED_ONE.swap(true, Ordering::SeqCst)
    }

    /// The listener's own check is what decides: a peer it refuses is closed
    /// before a byte is written, and the next one is served.
    #[test]
    fn a_peer_the_check_refuses_is_closed_before_a_byte_is_written() {
        let mut l = Listener::bind("transport-peer-01").unwrap();
        assert!((l.peer_ok)(euid()), "a listener serves its own user");
        assert!(!(l.peer_ok)(euid().wrapping_add(1)), "a listener serves another user");
        l.peer_ok = refuse_the_first;
        let l = Arc::new(l);
        let server = Arc::clone(&l);
        let served = std::thread::spawn(move || {
            let mut s = server.accept().expect("the second peer is served");
            s.write_all_within(b"served", Duration::from_secs(5)).expect("write");
            s.close_after_writes();
        });
        let mut buf = [0u8; 16];
        let mut first = connect(l.endpoint(), Duration::from_secs(5)).expect("connect");
        first.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        assert_eq!(first.read(&mut buf).expect("read"), 0, "a refused peer was written to");
        let mut second = connect(l.endpoint(), Duration::from_secs(5)).expect("connect");
        second.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let n = second.read(&mut buf).expect("read");
        assert_eq!(&buf[..n], b"served");
        served.join().unwrap();
    }

    static REFUSED_FIRST_OF_TWO: AtomicBool = AtomicBool::new(false);

    /// As `refuse_the_first`, with a flag of its own for the test below.
    fn refuse_the_first_of_two(_uid: u32) -> bool {
        REFUSED_FIRST_OF_TWO.swap(true, Ordering::SeqCst)
    }

    /// Wait until a read on `fd` would not wait, at most 10 seconds.
    fn wait_until_readable(fd: RawFd) {
        let mut p = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        let n = unsafe { libc::poll(&mut p, 1, 10_000) };
        assert_eq!(n, 1, "the listener did not close the refused peer in 10 seconds");
    }

    /// The test above in the order that raced on macOS (aicc_planning#396):
    /// the listener has already closed the refused peer when that peer sets
    /// its timeouts. macOS refuses to set any socket option on a connection that
    /// has ended both ways (EINVAL); the peer still becomes a stream, takes
    /// its read timeout and reads the end, as it does on Linux.
    #[test]
    fn a_peer_closed_before_it_sets_its_timeouts_still_reads_the_end() {
        let mut l = Listener::bind("transport-peer-02").unwrap();
        l.peer_ok = refuse_the_first_of_two;
        let l = Arc::new(l);
        let server = Arc::clone(&l);
        let served = std::thread::spawn(move || {
            let mut s = server.accept().expect("the second peer is served");
            s.write_all_within(b"served", Duration::from_secs(5)).expect("write");
            s.close_after_writes();
        });
        // The first peer's socket as `connect` opens it (`connect_within`; the
        // check of the peer's user id that `connect` makes next is left out),
        // held back before its first timeout until the listener has closed it.
        let raw = connect_within(Path::new(l.endpoint()), Duration::from_secs(5)).expect("connect");
        wait_until_readable(raw.as_raw_fd());
        let mut first = Stream::new(raw).expect("a connection the listener closed is still a stream");
        first.set_read_timeout(Some(Duration::from_secs(10))).expect("a connection the listener closed takes a read timeout");
        let mut buf = [0u8; 16];
        assert_eq!(first.read(&mut buf).expect("read"), 0, "a refused peer was written to");
        let mut second = connect(l.endpoint(), Duration::from_secs(5)).expect("connect");
        second.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let n = second.read(&mut buf).expect("read");
        assert_eq!(&buf[..n], b"served");
        served.join().unwrap();
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
        // Its mode set outright: the lib tests share one umask, which a bind
        // beside this test sets to 0177 for a moment (`bind_private`).
        fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
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

    /// Connect until the listener's queue is full; the connections taken.
    #[cfg(any(target_os = "linux", target_vendor = "apple"))]
    fn fill_the_queue(l: &Listener) -> Vec<Stream> {
        // A small backlog: a connection or two may wait to be accepted.
        // Not 0: macOS takes a backlog of 0 as its largest.
        assert_eq!(unsafe { libc::listen(l.inner.as_raw_fd(), 1) }, 0);
        let endpoint = l.endpoint().to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut waiting = Vec::new();
            for _ in 0..64 {
                match connect(&endpoint, Duration::from_millis(300)) {
                    Ok(s) => waiting.push(s),
                    Err(e) => {
                        let _ = tx.send((waiting, Some(e)));
                        return;
                    }
                }
            }
            let _ = tx.send((waiting, None));
        });
        let (taken, e) = rx.recv_timeout(Duration::from_secs(20)).expect("a connect waited on a full backlog");
        let e = e.unwrap_or_else(|| panic!("{} connections and the backlog never filled", taken.len()));
        assert!(!taken.is_empty(), "not even the first connection was taken: {e:?}");
        assert!(super::super::is_timeout(&e), "{e:?}");
        assert!(!super::super::means_gone(&e), "a full backlog is not a gone holder: {e:?}");
        taken
    }

    /// A holder that has stopped taking connections fills its backlog. Linux
    /// would make a blocking connect wait for as long as that lasts; macOS
    /// refuses the connection as if nothing listened there.
    #[cfg(any(target_os = "linux", target_vendor = "apple"))]
    #[test]
    fn a_connect_to_a_full_backlog_times_out_instead_of_waiting_or_refusing() {
        let l = Listener::bind("transport-full-01").unwrap();
        drop(fill_the_queue(&l));
        drop(l);
    }

    /// List mode keeps the record and the socket of a live holder whose
    /// backlog is full: that is no answer, never a gone holder.
    #[cfg(any(target_os = "linux", target_vendor = "apple"))]
    #[test]
    fn list_mode_keeps_the_record_and_the_socket_of_a_holder_with_a_full_backlog() {
        let l = Listener::bind("transport-full-02").unwrap();
        let waiting = fill_the_queue(&l);
        let store = std::env::temp_dir().join(format!("aicc-transport-store-{}", std::process::id()));
        let _ = fs::remove_dir_all(&store);
        crate::store::prepare(&store).unwrap();
        let rec = crate::store::Record {
            session: "transport-full-02".to_string(),
            label: String::new(),
            pid: std::process::id(),
            endpoint: l.endpoint().to_string(),
            nonce: "0123456789abcdef0123456789abcdef".to_string(),
            helper: "0.1.0".to_string(),
            // A holder writes its record after it starts, as this one would:
            // a record older than its process is another process's.
            started: crate::store::now_ms(),
            away: 120,
            attached: false,
            child: "waiting".to_string(),
            code: None,
        };
        crate::store::write(&store, &rec).unwrap();
        let listing = crate::store::list(&store, crate::client::probe).unwrap();
        assert_eq!(listing.sessions, vec![rec], "the record of a live holder was not listed");
        assert_eq!(listing.removed, 0);
        assert!(Path::new(l.endpoint()).exists(), "list mode removed a live holder's socket");
        drop(waiting);
        drop(l);
        fs::remove_dir_all(&store).unwrap();
    }

    /// A crashed holder leaves its socket file with nothing listening on it,
    /// and its process id may name another process by then. Linux refuses a
    /// connect there, which means the holder is gone: the probe says so
    /// although the record's id runs, and list mode removes the record and
    /// the socket file. Linux reads no start time, so this refusal is the one
    /// thing that clears such a record there.
    #[cfg(target_os = "linux")]
    #[test]
    fn list_mode_removes_the_record_and_the_socket_a_crashed_holder_left_on_linux() {
        let sid = "transport-dead-01";
        prepare_run_dir(&run_dir()).unwrap();
        let random = crate::random::hex(super::super::ENDPOINT_RANDOM_HEX / 2).unwrap();
        let endpoint = super::super::endpoint_name(sid, &random);
        let path = PathBuf::from(&endpoint);
        // Bound, then dropped as a crash drops it: the file stays, unheard.
        drop(bind_private(&path).unwrap());
        assert!(fs::symlink_metadata(&path).unwrap().file_type().is_socket(), "the socket file went with its listener");
        let store = std::env::temp_dir().join(format!("aicc-transport-crashed-{}", std::process::id()));
        let _ = fs::remove_dir_all(&store);
        crate::store::prepare(&store).unwrap();
        let rec = crate::store::Record {
            session: sid.to_string(),
            label: String::new(),
            // This test's own id, which runs: the id was given to another process.
            pid: std::process::id(),
            endpoint: endpoint.clone(),
            nonce: "0123456789abcdef0123456789abcdef".to_string(),
            helper: "0.1.0".to_string(),
            // Written after this process started, so no start-time rule
            // could take it for stale: only the refusal can.
            started: crate::store::now_ms(),
            away: 120,
            attached: false,
            child: "running".to_string(),
            code: None,
        };
        assert_eq!(crate::client::probe(&rec), crate::store::Probe::Gone, "a refused connect was not read as a gone holder");
        crate::store::write(&store, &rec).unwrap();
        let listing = crate::store::list(&store, crate::client::probe).unwrap();
        assert!(listing.sessions.is_empty(), "a crashed holder's record was listed: {:?}", listing.sessions);
        assert_eq!(listing.removed, 1);
        assert!(crate::store::read(&store, sid).is_none(), "list mode kept a crashed holder's record");
        assert!(!path.exists(), "list mode kept a crashed holder's socket file");
        fs::remove_dir_all(&store).unwrap();
    }

    #[test]
    fn a_message_to_a_peer_that_takes_a_little_at_a_time_stops_at_its_deadline() {
        let (mine, theirs) = UnixStream::pair().unwrap();
        let mut s = Stream::new(mine).unwrap();
        // 64 KiB every 300 ms: each wait for room is short, the whole message is not.
        let reader = std::thread::spawn(move || {
            let mut theirs = theirs;
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                std::thread::sleep(Duration::from_millis(300));
                match theirs.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
            }
        });
        let started = Instant::now();
        let e = s.write_all_within(&vec![7u8; 16 * 1024 * 1024], Duration::from_secs(1)).expect_err("16 MiB went to a peer taking about 200 KiB a second");
        let took = started.elapsed();
        assert!(super::super::is_timeout(&e), "{e:?}");
        assert!(took < Duration::from_secs(3), "one message stretched its 1 second limit to {took:?}");
        s.shutdown();
        drop(s);
        reader.join().unwrap();
    }

    #[test]
    fn a_socket_is_0600_from_its_bind_and_a_file_in_its_place_is_never_removed() {
        let dir = run_dir();
        prepare_run_dir(&dir).unwrap();
        let path = dir.join(format!("umask-check-{}.sock", std::process::id()));
        let _ = fs::remove_file(&path);
        let raw = bind_private(&path).unwrap();
        // Before anything sets its mode: the umask alone made it private.
        assert_eq!(fs::symlink_metadata(&path).unwrap().mode() & 0o777, 0o600);
        // Nothing listens on it now, and it is still never bound over.
        drop(raw);
        assert!(Listener::bind_at(&path.to_string_lossy()).is_err(), "a bind over a socket file that was there");
        assert!(path.exists(), "the bind removed a file that was there");
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn a_bound_socket_is_private_and_goes_with_its_listener() {
        let l = Listener::bind("transport-0001").unwrap();
        l.check_private().unwrap();
        let path = PathBuf::from(l.endpoint());
        drop(l);
        assert!(!path.exists(), "the socket file stays after the listener is gone");
    }
}
