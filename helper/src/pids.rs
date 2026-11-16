//! Is a process still running, and when did it start? List mode uses both to
//! tell a live session record from one a crashed holder left behind
//! (protocol section 15, `store::holder_gone`), and the tests use `alive` to
//! show that ending a session ends its whole process tree.
#![allow(unsafe_code)]

/// How much later than a record's `started` the process with its id may have
/// started and still be taken for its holder. A holder starts before it
/// writes its record, so its own start is never later; the slack is for a
/// clock that was set meanwhile (Linux works a start out from the boot time,
/// which moves with the clock) and for start times kept to the second. Ids
/// are handed out in turn on macOS and Linux, so one given out again within
/// a minute is not likely.
pub const START_SLACK_MS: u64 = 60_000;

/// True while a process with this id exists. A process of another user that
/// happens to have the id counts as existing: the id may have been given to
/// another process since a record was written, which the endpoint, or else
/// `started_after`, tells apart (`store::holder_gone`).
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
/// Linux says so in /proc. macOS has no /proc, so there such a process counts
/// as running until its parent reaps it: a holder reaps its own child, and a
/// process whose parent is gone is reaped by launchd, but a process whose
/// parent is alive and does not reap it reads as alive.
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

/// True when the process with this id is known to have started more than
/// `START_SLACK_MS` after `ms` (milliseconds since 1970): it is not the
/// process that had the id at `ms`. False when its start cannot be read.
pub fn started_after(pid: u32, ms: u64) -> bool {
    started_ms(pid).map_or(false, |start| start > ms.saturating_add(START_SLACK_MS))
}

/// When the process with this id started, in milliseconds since 1970 (UTC).
/// Linux: field 22 of `/proc/<pid>/stat`, in clock ticks after the boot,
/// plus the boot time in `/proc/stat`.
#[cfg(target_os = "linux")]
pub fn started_ms(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The fields after the name (in brackets, which may hold spaces and
    // brackets itself) start at field 3, so field 22 is the 20th of them.
    let ticks: u64 = stat[stat.rfind(')')? + 1..].split_whitespace().nth(19)?.parse().ok()?;
    let boot_secs: u64 = std::fs::read_to_string("/proc/stat").ok()?.lines().find_map(|l| l.strip_prefix("btime "))?.trim().parse().ok()?;
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if hz <= 0 {
        return None;
    }
    boot_secs.checked_mul(1000)?.checked_add(ticks.checked_mul(1000)? / hz as u64)
}

/// When the process with this id started, in milliseconds since 1970 (UTC).
/// macOS keeps it with the process (`proc_pidinfo`, `PROC_PIDTBSDINFO`).
#[cfg(target_vendor = "apple")]
pub fn started_ms(pid: u32) -> Option<u64> {
    if pid == 0 || pid > i32::MAX as u32 {
        return None;
    }
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let got = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    if got != size {
        return None;
    }
    info.pbi_start_tvsec.checked_mul(1000)?.checked_add(info.pbi_start_tvusec / 1000)
}

/// Not read on any other Unix.
#[cfg(all(unix, not(any(target_os = "linux", target_vendor = "apple"))))]
pub fn started_ms(_pid: u32) -> Option<u64> {
    None
}

/// When the process with this id started, in milliseconds since 1970 (UTC):
/// its creation time.
#[cfg(windows)]
pub fn started_ms(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid == 0 {
        return None;
    }
    let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
    }
    // Steps of 100 ns since 1601; 11644473600 s from then to 1970.
    let steps = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    (steps / 10_000).checked_sub(11_644_473_600_000)
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

    /// The start is read in the right unit: this test process started a
    /// moment ago, not in 1970 and not in the future.
    #[cfg(any(target_vendor = "apple", windows))]
    #[test]
    fn this_process_started_a_moment_ago_and_after_any_earlier_record() {
        let me = std::process::id();
        let now = crate::store::now_ms();
        let start = started_ms(me).expect("this process's start can be read");
        assert!(start <= now + 1_000, "started {start}, after now {now}");
        assert!(now.saturating_sub(start) < 6 * 3_600_000, "started {start}, hours before now {now}");
        // A record written before this process started is not its record.
        assert!(started_after(me, 1));
        assert!(started_after(me, start - START_SLACK_MS - 1_000));
        // A record written after it started can be.
        assert!(!started_after(me, now));
        assert!(!started_after(me, start));
        assert!(started_ms(0).is_none());
        assert!(!started_after(0, 1));
    }

    /// Another user's process has a start too: launchd (id 1) is root's,
    /// and it started before this test process.
    #[cfg(target_vendor = "apple")]
    #[test]
    fn the_start_of_a_process_of_another_user_can_be_read() {
        let launchd = started_ms(1).expect("launchd's start can be read");
        let me = started_ms(std::process::id()).expect("this process's start can be read");
        assert!(launchd > 0 && launchd <= me, "launchd started {launchd}, this process {me}");
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
