//! One pseudo-terminal with one child on it, the same shape on every OS:
//! `openpty` and a child on the slave on Unix, ConPTY on Windows. The helper
//! uses it to hold the CLI's terminal (protocol sections 5 and 15).
//!
//! `spawn_with` returns the terminal and a reader for what the child writes.
//! On Unix the reader ends when the child and everything it started have
//! closed the terminal. On Windows it ends only when the pseudoconsole is
//! closed (`close_output`), so callers watch the child with `try_wait` and do
//! not rely on the reader's end.
//!
//! The child is started in a unit that can be ended whole: a job object owned
//! by the holder on Windows (the holder itself is in none, probe P7), its own
//! session and process group on Unix. `end_tree` ends everything in it.

use std::io;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::Pty;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::Pty;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
}

impl Default for PtySize {
    fn default() -> PtySize {
        PtySize { cols: 80, rows: 24 }
    }
}

/// Which ConPTY a Windows terminal runs on (protocol change 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Conpty {
    /// The one built into Windows; on macOS and Linux, the only choice.
    #[default]
    System,
    /// The `conpty.dll` in a `conpty` folder beside the helper's own program
    /// file, with the `OpenConsole.exe` it starts. Windows only.
    Bundled,
}

/// What to start on the terminal.
///
/// `cwd: None` and `env: None` keep the holder's own folder and environment:
/// the self-test and the in-process tests use that. A launch frame always
/// gives both, and `env` is then the child's WHOLE environment: nothing of the
/// holder's own is added, except `TERM` on Unix when `env` has none.
///
/// `line` and `conpty` are for Windows only. `line` is the exact command
/// line the program is given; the program is still `argv[0]`, which then
/// holds it alone.
pub struct SpawnOptions<'a> {
    pub argv: &'a [String],
    pub cwd: Option<&'a str>,
    pub env: Option<&'a [(String, String)]>,
    pub size: PtySize,
    pub line: Option<&'a str>,
    pub conpty: Conpty,
}

pub(crate) fn check_argv(argv: &[String]) -> io::Result<()> {
    if argv.is_empty() || argv[0].is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "no program to run"));
    }
    if argv.iter().any(|a| a.contains('\0')) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "an argument holds a NUL character"));
    }
    Ok(())
}

/// The Windows fields, checked again here as the last line: refused on
/// macOS and Linux, and on Windows a line is never empty or split by a NUL,
/// and never comes with arguments that would say something else.
pub(crate) fn check_windows_fields(opts: &SpawnOptions) -> io::Result<()> {
    let invalid = |what: &str| Err(io::Error::new(io::ErrorKind::InvalidInput, what.to_string()));
    if cfg!(not(windows)) && (opts.line.is_some() || opts.conpty != Conpty::System) {
        return invalid("an exact command line and the bundled ConPTY are for Windows only");
    }
    if let Some(line) = opts.line {
        if line.is_empty() || line.contains('\0') {
            return invalid("the command line is empty or holds a NUL character");
        }
        if opts.argv.len() != 1 {
            return invalid("with a command line, argv holds the program alone");
        }
    }
    Ok(())
}

/// The launch frame is checked before it gets here (`request.rs`); this is the
/// last line, so a bad name can never split or end an environment block.
pub(crate) fn check_env(env: &[(String, String)]) -> io::Result<()> {
    for (name, value) in env {
        if name.is_empty() || name.contains('=') || name.contains('\0') || value.contains('\0') {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "an environment name is empty or holds = or NUL, or a value holds NUL"));
        }
    }
    Ok(())
}

pub(crate) fn check_cwd(cwd: &str) -> io::Result<()> {
    if cwd.is_empty() || cwd.contains('\0') {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "the folder is empty or holds a NUL character"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_environment_that_could_break_a_block_is_refused() {
        let ok = vec![("A".to_string(), "x=y".to_string())];
        assert!(check_env(&ok).is_ok(), "an = in a value is fine");
        for bad in [("", "x"), ("A=B", "x"), ("A\0", "x"), ("A", "x\0y")] {
            assert!(check_env(&[(bad.0.to_string(), bad.1.to_string())]).is_err(), "{bad:?}");
        }
        assert!(check_argv(&["/bin/sh".to_string(), "a\0b".to_string()]).is_err());
        assert!(check_cwd("").is_err() && check_cwd("/a\0").is_err() && check_cwd("/tmp").is_ok());
    }

    #[test]
    fn the_windows_fields_are_checked_again_before_a_start() {
        fn passes(argv: &[String], line: Option<&str>, conpty: Conpty) -> bool {
            check_windows_fields(&SpawnOptions { argv, cwd: None, env: None, size: PtySize::default(), line, conpty }).is_ok()
        }
        let one = vec!["C:\\Windows\\System32\\cmd.exe".to_string()];
        let two = vec![one[0].clone(), "/c".to_string()];
        assert!(passes(&two, None, Conpty::System), "an argument list as before");
        if cfg!(windows) {
            assert!(passes(&one, Some("cmd /c ver"), Conpty::Bundled));
            assert!(!passes(&two, Some("cmd /c ver"), Conpty::System), "a line with arguments");
            assert!(!passes(&one, Some(""), Conpty::System), "an empty line");
            assert!(!passes(&one, Some("a\0b"), Conpty::System), "a NUL in the line");
        } else {
            assert!(!passes(&one, Some("/bin/sh -c true"), Conpty::System));
            assert!(!passes(&one, None, Conpty::Bundled));
        }
    }
}
