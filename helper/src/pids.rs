//! Is a process still running, and when did it start? List mode uses both to
//! tell a live session record from one a crashed holder left behind
//! (protocol section 15, `store::holder_gone`), and the tests use `alive` to
//! show that ending a session ends its whole process tree.
#![allow(unsafe_code)]

/// How much later than a record's `started` the process with its id may have
/// started and still be taken for its holder. Only macOS and Windows read a
/// start (`started_ms`): each stamps a process with the time it started, and
/// no later change to the clock moves that stamp. A holder starts before it
/// writes its record, so its own stamp is never later than the record's
/// `started`, unless the clock was set back in the moment between the two;
/// the slack covers such a step of up to a minute. The cost: a process that
/// got the id within a minute of the record being written is not caught.
/// macOS hands ids out in turn, so that is not likely, and on Windows a
/// crashed holder's pipe is gone, which already marks its record stale.
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

/// `struct kinfo_proc` from `<sys/sysctl.h>` on 64-bit macOS, which libc does
/// not declare for Apple: the fields up to `kp_proc.p_pid`, then the rest as
/// bytes. `kp_proc` starts with a union of two pointers and the start time,
/// 16 bytes either way. The whole struct is 648 bytes; `started_ms` checks
/// that the kernel returned exactly that much and the asked-for id.
#[cfg(target_vendor = "apple")]
#[repr(C)]
struct KinfoProc {
    p_starttime: libc::timeval,
    _p_vmspace: usize,
    _p_sigacts: usize,
    _p_flag: libc::c_int,
    _p_stat: libc::c_char,
    p_pid: libc::pid_t,
    _rest: [u8; 648 - 44],
}

#[cfg(target_vendor = "apple")]
const _: () = assert!(std::mem::size_of::<KinfoProc>() == 648);

/// When the process with this id started, in milliseconds since 1970 (UTC).
/// macOS stamps it on the process when it starts. It is read with the
/// `kern.proc.pid.<pid>` sysctl, as `ps` does, which any user may read for
/// any process; `proc_pidinfo` refuses another user's process, and a reused
/// id often names one of root's.
#[cfg(target_vendor = "apple")]
pub fn started_ms(pid: u32) -> Option<u64> {
    if pid == 0 || pid > i32::MAX as u32 {
        return None;
    }
    let mut mib = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, pid as libc::c_int];
    let mut info = KinfoProc { p_starttime: libc::timeval { tv_sec: 0, tv_usec: 0 }, _p_vmspace: 0, _p_sigacts: 0, _p_flag: 0, _p_stat: 0, p_pid: 0, _rest: [0; 648 - 44] };
    let mut len: libc::size_t = std::mem::size_of::<KinfoProc>();
    let got = unsafe { libc::sysctl(mib.as_mut_ptr(), mib.len() as libc::c_uint, (&mut info as *mut KinfoProc).cast(), &mut len, std::ptr::null_mut(), 0) };
    // No such process gives 0 bytes.
    if got != 0 || len != std::mem::size_of::<KinfoProc>() || info.p_pid != pid as libc::pid_t {
        return None;
    }
    let secs = u64::try_from(info.p_starttime.tv_sec).ok()?;
    let micros = u64::try_from(info.p_starttime.tv_usec).ok()?;
    secs.checked_mul(1000)?.checked_add(micros / 1000)
}

/// Not read on Linux or any other Unix, so the start-time rule
/// (`store::holder_gone`) does nothing there. Linux gives a start only as
/// ticks after the boot, and the boot time those would be added to moves
/// with every change to the clock: after the clock is set forward, a live
/// holder would read as started after its own record. Linux does not need
/// the rule: a crashed holder's socket there is refused or missing, and
/// either already marks its record stale.
#[cfg(all(unix, not(target_vendor = "apple")))]
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
