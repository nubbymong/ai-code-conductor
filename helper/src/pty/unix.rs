//! The Unix terminal: `openpty`, the child on the slave side with a new
//! session and the slave as its controlling terminal.
//!
//! The only unsafe code in the helper sits in this file, the Windows one and
//! `detach.rs`: calls into the C library that have no safe form in `std`.
#![allow(unsafe_code)]

use super::{check_argv, PtySize};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, Stdio};

pub struct Pty {
    master: File,
    child: Child,
}

fn winsize(size: PtySize) -> libc::winsize {
    libc::winsize { ws_row: size.rows, ws_col: size.cols, ws_xpixel: 0, ws_ypixel: 0 }
}

impl Pty {
    pub fn spawn(argv: &[String], size: PtySize) -> io::Result<(Pty, Box<dyn Read + Send>)> {
        check_argv(argv)?;
        let mut master_fd: libc::c_int = -1;
        let mut slave_fd: libc::c_int = -1;
        let ws = winsize(size);
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

        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..]);
        if std::env::var_os("TERM").is_none() {
            cmd.env("TERM", "xterm-256color");
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

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            self.kill();
        }
    }
}
