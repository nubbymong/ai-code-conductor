//! The Unix terminal: `openpty`, the child on the slave side with a new
//! session and the slave as its controlling terminal.
//!
//! The new session is also a new process group whose id is the child's pid,
//! so `end_tree` reaches everything the child started that stayed in it: a
//! hangup first, as a closed terminal would send, then a kill.
//!
//! Unsafe code sits only in the modules that call the C library or the
//! Windows API where `std` has no safe form; the library denies it elsewhere.
#![allow(unsafe_code)]

use super::{check_argv, check_cwd, check_env, PtySize, SpawnOptions};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// What a launch adds when its environment has no `TERM`.
const DEFAULT_TERM: &str = "xterm-256color";

pub struct Pty {
    master: File,
    child: Child,
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
        let reader = master.try_clone()?;
        Ok((Pty { master, child }, Box::new(reader)))
    }

    pub fn write_input(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.master.write_all(bytes)?;
        self.master.flush()
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

    /// End the whole tree: hang up the child's process group, give it `grace`
    /// to go, then kill whatever is left of it.
    pub fn end_tree(&mut self, grace: Duration) {
        let pgid = self.child.id() as libc::pid_t;
        // The group is the child's own (setsid above); never signal group 0
        // (our own) or 1.
        if pgid <= 1 {
            return;
        }
        unsafe {
            libc::killpg(pgid, libc::SIGHUP);
            libc::killpg(pgid, libc::SIGCONT);
        }
        let deadline = Instant::now() + grace;
        loop {
            // Reap the first process as it goes, so it does not linger as a
            // zombie that keeps the group alive.
            let _ = self.child.try_wait();
            if unsafe { libc::killpg(pgid, 0) } != 0 {
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                _ => break,
            }
        }
    }

    /// End the tree at once.
    pub fn kill(&mut self) {
        self.end_tree(Duration::ZERO);
    }

    /// Nothing to do on Unix: the reader ends when the last process holding
    /// the terminal is gone.
    pub fn close_output(&mut self) {}
}

impl Drop for Pty {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            self.kill();
        }
    }
}
