//! The Unix terminal: `openpty`, the child on the slave side with a new
//! session and the slave as its controlling terminal.
//!
//! The new session is also a new process group whose id is the child's pid.
//! `end_tree` reaches that group and every other process still in the
//! session (a job-control shell puts each job in a group of its own, inside
//! the same session): a hangup first, as a closed terminal would send, then a
//! kill. Linux finds the session's processes in /proc, macOS with
//! `proc_listallpids`. A process that left the session on purpose (a daemon
//! that called setsid) is beyond it, as it is beyond a closed terminal.
//!
//! The session's id is the child's pid, so it is safe to signal only while
//! that id cannot name anyone else: while the child has not been reaped, or
//! while anything is still in its session (the kernel gives no new process an
//! id that a live group or session still carries). Once the child has been
//! reaped and its session is empty, or has been sent a kill, `end_tree` never
//! signals that id again, however often it is called.
//!
//! Unsafe code sits only in the modules that call the C library or the
//! Windows API where `std` has no safe form; the library denies it elsewhere.
#![allow(unsafe_code)]

use super::{check_argv, check_cwd, check_env, PtySize, SpawnOptions};
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::FromRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// What a launch adds when its environment has no `TERM`.
const DEFAULT_TERM: &str = "xterm-256color";

pub struct Pty {
    master: File,
    child: Child,
    /// Set once the child has been reaped and nothing of its session can be
    /// left (seen empty, or every member sent a kill): from then on its id
    /// may name an unrelated process, and nothing is sent to it.
    tree_gone: bool,
    /// How a signal reaches the session: always `signal_session`; a test
    /// records what is sent through it.
    signal: fn(libc::pid_t, libc::c_int),
}

fn winsize(size: PtySize) -> libc::winsize {
    libc::winsize { ws_row: size.rows, ws_col: size.cols, ws_xpixel: 0, ws_ypixel: 0 }
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
        let mut master_fd: libc::c_int = -1;
        let mut slave_fd: libc::c_int = -1;
        let ws = winsize(opts.size);
        // The null terminal settings and the window size are passed as the
        // pointer types every libc version of `openpty` accepts.
        let rc = unsafe {
            libc::openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                std::ptr::null::<libc::termios>() as *mut libc::termios,
                &ws as *const libc::winsize as *mut libc::winsize,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        // Each end is owned by a File from here on, so every path below closes it.
        let master = unsafe { File::from_raw_fd(master_fd) };
        let slave = unsafe { File::from_raw_fd(slave_fd) };
        // The child must not inherit the master side.
        unsafe {
            libc::fcntl(master_fd, libc::F_SETFD, libc::FD_CLOEXEC);
            libc::fcntl(slave_fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }

        let argv = opts.argv;
        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..]);
        match opts.env {
            Some(env) => {
                // The launch's environment is the child's whole environment.
                cmd.env_clear();
                cmd.envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
                if !env.iter().any(|(k, _)| k == "TERM") {
                    cmd.env("TERM", DEFAULT_TERM);
                }
            }
            None => {
                if std::env::var_os("TERM").is_none() {
                    cmd.env("TERM", DEFAULT_TERM);
                }
            }
        }
        if let Some(cwd) = opts.cwd {
            cmd.current_dir(cwd);
        }
        cmd.stdin(Stdio::from(slave.try_clone()?));
        cmd.stdout(Stdio::from(slave.try_clone()?));
        cmd.stderr(Stdio::from(slave));
        unsafe {
            cmd.pre_exec(|| {
                // A new session, with the slave (already on fd 0) as its terminal.
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = cmd.spawn()?;
        // `cmd` still holds the parent's copies of the slave; drop them so the
        // reader sees the end when the child is gone.
        drop(cmd);
        // The terminal owns the child from here, so a failure below ends it
        // (`Drop`) instead of leaving it running unheld.
        let pty = Pty { master, child, tree_gone: false, signal: signal_session };
        let reader = pty.master.try_clone()?;
        Ok((pty, Box::new(reader)))
    }

    /// A second handle on the master side, for a thread that writes alone.
    pub fn input_writer(&self) -> io::Result<File> {
        self.master.try_clone()
    }

    pub fn resize(&self, size: PtySize) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        let ws = winsize(size);
        let rc = unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ as _, &ws as *const libc::winsize) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// The exit code once the child has exited (128 + n when signal n ended it).
    pub fn try_wait(&mut self) -> io::Result<Option<i32>> {
        match self.child.try_wait()? {
            None => Ok(None),
            Some(status) => Ok(Some(match status.code() {
                Some(code) => code,
                None => 128 + status.signal().unwrap_or(0),
            })),
        }
    }

    /// End the whole tree: hang up the child's session, give it `grace` to
    /// go, then kill whatever is left of it. Once the tree is gone this does
    /// nothing (see the module comment).
    pub fn end_tree(&mut self, grace: Duration) {
        if self.tree_gone {
            return;
        }
        let sid = self.child.id() as libc::pid_t;
        // The session and its first group are the child's own (setsid above);
        // never signal group 0 (our own) or 1.
        if sid <= 1 {
            self.tree_gone = true;
            return;
        }
        if self.over(sid) {
            // The child went and took its tree with it: nothing to send.
            return;
        }
        (self.signal)(sid, libc::SIGHUP);
        (self.signal)(sid, libc::SIGCONT);
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
            if self.over(sid) {
                // Gone after the hangup: no kill follows.
                return;
            }
        }
        (self.signal)(sid, libc::SIGKILL);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.reaped() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        // Everything left in the session has been sent a kill, which cannot
        // be caught: once the child is reaped, nothing more could be sent
        // that is sure to reach only this tree.
        if self.reaped() {
            self.tree_gone = true;
        }
    }

    /// True once the child has exited and been reaped (std keeps its status,
    /// so this reaps it at most once).
    fn reaped(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }

    /// Reap the child if it has exited, so it does not linger as a zombie
    /// that keeps its group alive. True, and remembered, once it has been
    /// reaped and nothing is left in its session.
    fn over(&mut self, sid: libc::pid_t) -> bool {
        if self.reaped() && !session_left(sid) {
            self.tree_gone = true;
        }
        self.tree_gone
    }

    /// End the tree at once.
    pub fn kill(&mut self) {
        self.end_tree(Duration::ZERO);
    }

    /// Nothing to do on Unix: the reader ends when the last process holding
    /// the terminal is gone.
    pub fn close_output(&mut self) {}
}

/// The processes in session `sid`, other than this one.
#[cfg(target_os = "linux")]
fn session_members(sid: libc::pid_t) -> Vec<libc::pid_t> {
    let me = std::process::id() as libc::pid_t;
    let mut out = Vec::new();
    if let Ok(dir) = std::fs::read_dir("/proc") {
        for entry in dir.flatten() {
            let pid = match entry.file_name().to_str().and_then(|n| n.parse::<libc::pid_t>().ok()) {
                Some(p) => p,
                None => continue,
            };
            if pid > 1 && pid != me && unsafe { libc::getsid(pid) } == sid {
                out.push(pid);
            }
        }
    }
    out
}

/// The processes in session `sid`, other than this one.
#[cfg(target_vendor = "apple")]
fn session_members(sid: libc::pid_t) -> Vec<libc::pid_t> {
    let me = std::process::id() as libc::pid_t;
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Vec::new();
    }
    // Room for processes started since the count.
    let mut pids: Vec<libc::pid_t> = vec![0; count as usize + 256];
    let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
    let got = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    if got <= 0 {
        return Vec::new();
    }
    pids.truncate((got as usize).min(pids.len()));
    pids.retain(|&pid| pid > 1 && pid != me && unsafe { libc::getsid(pid) } == sid);
    pids
}

/// Elsewhere only the first group is reached.
#[cfg(not(any(target_os = "linux", target_vendor = "apple")))]
fn session_members(_sid: libc::pid_t) -> Vec<libc::pid_t> {
    Vec::new()
}

/// Send `sig` to the session's first group and to every other process in it.
fn signal_session(sid: libc::pid_t, sig: libc::c_int) {
    unsafe {
        libc::killpg(sid, sig);
    }
    for pid in session_members(sid) {
        unsafe {
            libc::kill(pid, sig);
        }
    }
}

/// True while anything of the session runs: its first group, or another
/// process in it that is not a zombie waiting to be reaped.
fn session_left(sid: libc::pid_t) -> bool {
    if unsafe { libc::killpg(sid, 0) } == 0 {
        return true;
    }
    session_members(sid).into_iter().any(|pid| crate::pids::alive(pid as u32))
}

impl Drop for Pty {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            self.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Every signal the tests below sent, by session.
    static SENT: Mutex<Vec<(libc::pid_t, libc::c_int)>> = Mutex::new(Vec::new());

    fn record(sid: libc::pid_t, sig: libc::c_int) {
        SENT.lock().unwrap_or_else(|p| p.into_inner()).push((sid, sig));
        signal_session(sid, sig);
    }

    fn sent_to(sid: libc::pid_t) -> Vec<libc::c_int> {
        SENT.lock().unwrap_or_else(|p| p.into_inner()).iter().filter(|(s, _)| *s == sid).map(|(_, sig)| *sig).collect()
    }

    fn start(script: &str) -> Pty {
        let argv = vec!["/bin/sh".to_string(), "-c".to_string(), script.to_string()];
        let (mut pty, _reader) = Pty::spawn(&argv, PtySize::default()).expect("a shell starts on a terminal");
        pty.signal = record;
        pty
    }

    #[test]
    fn a_session_that_is_over_is_never_signalled() {
        let mut pty = start("exit 0");
        let sid = pty.pid() as libc::pid_t;
        let deadline = Instant::now() + Duration::from_secs(20);
        while pty.try_wait().expect("wait").is_none() {
            assert!(Instant::now() < deadline, "the shell never exited");
            std::thread::sleep(Duration::from_millis(10));
        }
        // The child is reaped and its session is empty, so its id may name
        // another process by now: every end after this sends nothing.
        pty.end_tree(Duration::from_secs(2));
        pty.end_tree(Duration::from_secs(2));
        pty.kill();
        assert_eq!(sent_to(sid), Vec::<libc::c_int>::new(), "a session that was over was signalled");
    }

    #[test]
    fn a_running_session_is_ended_once_and_never_signalled_after() {
        let mut pty = start("sleep 60");
        let sid = pty.pid() as libc::pid_t;
        pty.end_tree(Duration::from_secs(2));
        let first = sent_to(sid);
        assert!(first.contains(&libc::SIGHUP), "no hangup was sent: {first:?}");
        assert!(pty.try_wait().expect("wait").is_some(), "the shell outlived the end");
        pty.end_tree(Duration::from_secs(2));
        pty.kill();
        assert_eq!(sent_to(sid), first, "an ended session was signalled again");
    }
}
