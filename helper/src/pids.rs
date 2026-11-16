//! Is a process still running? List mode uses it to tell a live session record
//! from one a crashed holder left behind (protocol section 15), and the tests
//! use it to show that ending a session ends its whole process tree.
#![allow(unsafe_code)]

/// True while a process with this id exists. A process of another user that
/// happens to have the id counts as existing; list mode then checks the
/// endpoint, so a reused id never makes a stale record look live.
#[cfg(unix)]
pub fn alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // Signal 0 sends nothing: it only asks whether the process exists.
    let exists = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    exists && !zombie(pid)
}

/// A process that has exited but not been reaped yet still answers signal 0.
/// Linux says so in /proc; elsewhere the parent (or launchd) reaps at once.
#[cfg(unix)]
fn zombie(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        // The state is the first field after the name, which is in brackets
        // and may itself hold spaces and brackets.
        Ok(stat) => match stat.rfind(')') {
            Some(at) => matches!(stat[at + 1..].trim_start().chars().next(), Some('Z') | Some('X')),
            None => false,
        },
        Err(_) => false,
    }
}

#[cfg(windows)]
pub fn alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // Refused means it exists and belongs to someone we may not query.
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_is_alive_and_id_zero_is_not() {
        assert!(alive(std::process::id()));
        assert!(!alive(0));
    }

    #[test]
    fn a_child_that_has_exited_and_been_waited_for_is_not_alive() {
        let exe = std::env::current_exe().unwrap();
        // The test binary itself with a filter that matches no test: it exits at once.
        let mut child = std::process::Command::new(exe)
            .arg("no-test-has-this-name-0001")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!alive(pid), "an exited, reaped child still reads as alive");
    }
}
