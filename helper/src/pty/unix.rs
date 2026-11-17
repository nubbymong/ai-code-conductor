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
//! signals that id again, however often it is called. One field remembers
//! that (`tree_gone`) and one check at the top of `end_tree` reads it: what
//! the session looks like later proves nothing, since the id may by then
//! name another process's group.
//!
//! The child is reaped in one place: `try_wait`, which `end_tree` also uses,
//! so reaping it (which frees its id) and every decision to signal its
//! session happen through `&mut self`, and in the holder under the
//! terminal's one lock. The holder learns of the exit from an exit watch
//! (`exit_watch`) whose thread blocks in `waitid` with `WNOWAIT` without the
//! lock: it sees the exit but leaves the child unreaped, still holding its
//! id, and the holder then reaps it through `try_wait` under the lock. A
//! watch that reaped would free the id outside the lock, and an end running
//! on another thread at that moment could still signal it. std's `Child` is
//! not kept: its own waits would be a second reaper.
//!
//! That needs SIGCHLD at its default. On Linux an ignored SIGCHLD is handed
//! down through exec, and a process that ignores it has its children reaped
//! by the system as they exit, outside the terminal: a starter that ignored
//! it left `try_wait` unable to read the code and `end_tree` never seeing
//! the child reaped. (macOS did not show this in CI.) Each start sets
//! SIGCHLD back to its default first, on both.
//!
//! Unsafe code sits only in the modules that call the C library or the
//! Windows API where `std` has no safe form; the library denies it elsewhere.
#![allow(unsafe_code)]

use super::{check_argv, check_cwd, check_env, check_windows_fields, Conpty, PtySize, SpawnOptions};
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::FromRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, ExitStatus, Stdio};
#[cfg(test)]
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

/// What a launch adds when its environment has no `TERM`.
const DEFAULT_TERM: &str = "xterm-256color";

/// The exit code of a reaped child: its own code, or 128 + n when signal n
/// ended it.
fn code_of(status: ExitStatus) -> i32 {
    match status.code() {
        Some(code) => code,
        None => 128 + status.signal().unwrap_or(0),
    }
}

/// A wait for a terminal's child to exit, for a thread of its own
/// (`Pty::exit_watch`). It never reaps the child (see the module comment).
pub struct ExitWatch {
    pid: libc::pid_t,
    /// The terminal's count of status checks (`Pty::status_checks`).
    #[cfg(test)]
    checks: Arc<AtomicUsize>,
    /// Set by a test that needs the wait to fail (`failing`).
    #[cfg(test)]
    fail: bool,
}

impl ExitWatch {
    /// Block until the child has exited, leaving it unreaped for the
    /// terminal's `try_wait`. No clock wakes the thread meanwhile, and the
    /// terminal's lock is not needed. A wait cut short by a signal is made
    /// again. A child the terminal has already reaped counts as exited. Any
    /// other failure is an error, so the caller reports an exit instead of
    /// waiting on.
    pub fn wait(self) -> io::Result<()> {
        #[cfg(test)]
        if self.fail {
            return Err(io::Error::other("a wait made to fail by a test"));
        }
        loop {
            #[cfg(test)]
            self.checks.fetch_add(1, Ordering::SeqCst);
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let rc = unsafe { libc::waitid(libc::P_PID, self.pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) };
            if rc == 0 {
                return Ok(());
            }
            let e = io::Error::last_os_error();
            match e.raw_os_error() {
                Some(libc::EINTR) => continue,
                Some(libc::ECHILD) => return Ok(()),
                _ => return Err(e),
            }
        }
    }

    /// This watch with a wait that fails at once, for a test of what the
    /// caller does then.
    #[cfg(test)]
    pub(crate) fn failing(mut self) -> ExitWatch {
        self.fail = true;
        self
    }
}

pub struct Pty {
    master: File,
    /// The child's process id: also its session's and first group's id.
    pid: libc::pid_t,
    /// Its exit code once `try_wait` has reaped it.
    exit: Option<i32>,
    /// Set once the child has been reaped and nothing of its session can be
    /// left (seen empty, or every member sent a kill): from then on its id
    /// may name an unrelated process, and nothing is sent to it.
    tree_gone: bool,
    /// How a signal reaches the session: always `signal_session`; a test
    /// records what is sent through it.
    signal: fn(libc::pid_t, libc::c_int),
    /// Whether anything of the session still runs: always `session_left`; a
    /// test stands in for an id that another process's group holds by now.
    session_left: fn(libc::pid_t) -> bool,
    /// How many times the child's status was asked of the system: each
    /// `waitpid` in `try_wait` and each `waitid` in this terminal's exit
    /// watches (test builds only).
    #[cfg(test)]
    checks: Arc<AtomicUsize>,
}

fn winsize(size: PtySize) -> libc::winsize {
    libc::winsize { ws_row: size.rows, ws_col: size.cols, ws_xpixel: 0, ws_ypixel: 0 }
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
        // The terminal alone reaps the child (module comment), so SIGCHLD
        // must not be ignored when it starts.
        unsafe {
            libc::signal(libc::SIGCHLD, libc::SIG_DFL);
        }
        let child = cmd.spawn()?;
        // `cmd` still holds the parent's copies of the slave; drop them so the
        // reader sees the end when the child is gone.
        drop(cmd);
        // Only the id is kept: the terminal reaps the child (module comment).
        let pid = child.id() as libc::pid_t;
        drop(child);
        // The terminal owns the child from here, so a failure below ends it
        // (`Drop`) instead of leaving it running unheld.
        let pty = Pty {
            master,
            pid,
            exit: None,
            tree_gone: false,
            signal: signal_session,
            session_left,
            #[cfg(test)]
            checks: Arc::default(),
        };
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
        self.pid as u32
    }

    /// A wait for the child's exit, for a thread that blocks on it without
    /// the terminal (`ExitWatch::wait`). It never reaps: the caller then
    /// reaps through `try_wait`.
    pub fn exit_watch(&self) -> io::Result<ExitWatch> {
        Ok(ExitWatch {
            pid: self.pid,
            #[cfg(test)]
            checks: Arc::clone(&self.checks),
            #[cfg(test)]
            fail: false,
        })
    }

    /// How many times the child's status has been asked of the system so
    /// far, by `try_wait` and by this terminal's exit watches.
    #[cfg(test)]
    pub(crate) fn status_checks(&self) -> usize {
        self.checks.load(Ordering::SeqCst)
    }

    /// The exit code once the child has exited (128 + n when signal n ended
    /// it). This is the one place the child is reaped, without waiting; the
    /// code is kept, so it is reaped at most once.
    pub fn try_wait(&mut self) -> io::Result<Option<i32>> {
        if let Some(code) = self.exit {
            return Ok(Some(code));
        }
        let mut status: libc::c_int = 0;
        #[cfg(test)]
        self.checks.fetch_add(1, Ordering::SeqCst);
        let got = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
        if got == 0 {
            return Ok(None);
        }
        if got != self.pid {
            return Err(io::Error::last_os_error());
        }
        let code = code_of(ExitStatus::from_raw(status));
        self.exit = Some(code);
        Ok(Some(code))
    }

    /// End the whole tree: hang up the child's session, give it `grace` to
    /// go, then kill whatever is left of it. Once the tree is gone this does
    /// nothing (see the module comment).
    pub fn end_tree(&mut self, grace: Duration) {
        // The only check that keeps an id another process holds by now from
        // being signalled: `over` reports what the session looks like now.
        if self.tree_gone {
            return;
        }
        let sid = self.pid;
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

    /// True once the child has been reaped (`try_wait`, at most once).
    fn reaped(&mut self) -> bool {
        matches!(self.try_wait(), Ok(Some(_)))
    }

    /// Reap the child if it has exited, so it does not linger as a zombie
    /// that keeps its group alive. True when it has been reaped and nothing
    /// is left in its session, which `tree_gone` then remembers. This says
    /// only what is true now; it is asked only while the tree is not gone.
    fn over(&mut self, sid: libc::pid_t) -> bool {
        if self.reaped() && !(self.session_left)(sid) {
            self.tree_gone = true;
            return true;
        }
        false
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
        if let Ok(None) = self.try_wait() {
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

    /// Records a signal and sends nothing: for a session that must never
    /// be signalled, so a test that fails cannot reach a real process.
    fn record_only(sid: libc::pid_t, sig: libc::c_int) {
        SENT.lock().unwrap_or_else(|p| p.into_inner()).push((sid, sig));
    }

    fn sent_to(sid: libc::pid_t) -> Vec<libc::c_int> {
        SENT.lock().unwrap_or_else(|p| p.into_inner()).iter().filter(|(s, _)| *s == sid).map(|(_, sig)| *sig).collect()
    }

    fn wait_for_exit(pty: &mut Pty) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while pty.try_wait().expect("wait").is_none() {
            assert!(Instant::now() < deadline, "the shell never exited");
            std::thread::sleep(Duration::from_millis(10));
        }
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
        wait_for_exit(&mut pty);
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

    #[test]
    fn once_the_tree_is_gone_its_id_is_never_signalled_whatever_it_names_now() {
        let mut pty = start("exit 0");
        pty.signal = record_only;
        let sid = pty.pid() as libc::pid_t;
        wait_for_exit(&mut pty);
        // Seen over once: the child reaped, its session empty.
        pty.end_tree(Duration::from_secs(2));
        assert!(pty.tree_gone, "a reaped child with an empty session was not seen as gone");
        // Then the id is given to another process, which leads a group of
        // that id: the session reads as running again.
        pty.session_left = |_| true;
        pty.end_tree(Duration::from_millis(100));
        pty.kill();
        assert_eq!(sent_to(sid), Vec::<libc::c_int>::new(), "an id another process holds by now was signalled");
    }

    /// The child is ended from outside the terminal. The exit watch sees the
    /// exit but does not reap the child, so its id stays held (a child not
    /// yet reaped still answers signal 0) until the terminal reaps it through
    /// `try_wait`, where every decision to signal the session is made too. An
    /// end after that sends the session nothing: its id may name another
    /// process by then.
    #[test]
    fn the_exit_watch_never_reaps_so_only_the_terminal_frees_the_childs_id() {
        // `exec`: the shell becomes the sleep, so the session holds one process.
        let mut pty = start("exec sleep 60");
        let sid = pty.pid() as libc::pid_t;
        let watch = pty.exit_watch().expect("an exit watch");
        assert_eq!(unsafe { libc::kill(sid, libc::SIGKILL) }, 0, "the child could not be ended from outside");
        watch.wait().expect("the wait");
        assert_eq!(unsafe { libc::kill(sid, 0) }, 0, "the exit watch reaped the child: its id was freed outside the terminal");
        // From here a signal is recorded and never sent: the id is freed next.
        pty.signal = record_only;
        assert_eq!(pty.try_wait().expect("try_wait"), Some(128 + libc::SIGKILL));
        pty.end_tree(Duration::from_secs(2));
        pty.kill();
        assert!(pty.tree_gone, "a reaped child with an empty session was not seen as gone");
        assert_eq!(sent_to(sid), Vec::<libc::c_int>::new(), "a session whose child was reaped was signalled");
    }

    /// A watch made after the terminal has reaped the child answers at once.
    /// The wait runs on a thread of its own, so one that blocked fails this
    /// test within 2 s instead of hanging it.
    #[test]
    fn an_exit_watch_of_a_child_already_reaped_answers_at_once() {
        let mut pty = start("exit 3");
        wait_for_exit(&mut pty);
        assert_eq!(pty.try_wait().expect("try_wait"), Some(3));
        let watch = pty.exit_watch().expect("an exit watch");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(watch.wait().map_err(|e| e.to_string()));
        });
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(waited) => waited.expect("the wait of a child already reaped"),
            Err(_) => panic!("the wait of a child already reaped did not answer within 2 s"),
        }
    }
}
