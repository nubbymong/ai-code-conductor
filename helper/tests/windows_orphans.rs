//! #317: nothing the self-test starts outlives it, however it ends.
//!
//! On Windows `CreatePseudoConsole` starts the terminal's console host
//! (`conhost.exe --headless`) as a child of the process that calls it: here,
//! `aicc-helper selftest`. Only `ClosePseudoConsole` ends that host on
//! purpose. A self-test ended by force never calls it, and one that ends
//! normally can exit before the thread that closes its terminal has run. On
//! the Windows 11 test VM (build 22621) the host then kept running after 1 of
//! 12 forced ends and 3 of 4 normal ends of the 2.1.3-beta.6 helper. On the
//! CI runner (Windows Server 2025, build 26100) the host ended with the
//! self-test even before the fix, and this test passed there against the
//! unfixed self-test: in CI it holds the guarantee, and checks that the
//! self-test still passes inside its job, rather than showing the leak.
//!
//! The test runs the real helper. The self-test is started with no console of
//! its own, so every `conhost.exe` child it has is its terminal's host. That
//! host and the terminal's child are each held open by a process handle from
//! the moment they are seen, so a reused process id is never taken for one,
//! and one left running is ended before the test fails. Every try is
//! checked, also a forced end that missed the moment.
//!
//! Probabilistic by nature: the self-test is short, so a forced end lands
//! while its terminal is open only when the poll catches that moment. Such a
//! moment is taken to be when the terminal's child (`aicc-helper __echo`) and
//! every host are still running and the self-test has not exited, checked
//! right before the end. The test repeats forced ends until `MID_RUN` of them
//! landed that way, and also runs the self-test to its normal end
//! `NORMAL_RUNS` times. A leak that happens in only some runs can still pass
//! by chance; it cannot fail by chance.
#![cfg(windows)]

use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
/// `DETACHED_PROCESS`: no console of its own, so no console host but its terminal's.
const DETACHED_PROCESS: u32 = 0x0000_0008;
/// `WAIT_OBJECT_0`: the process has exited.
const WAIT_OBJECT_0: u32 = 0;
/// `WAIT_TIMEOUT`: it is still running.
const WAIT_TIMEOUT: u32 = 0x0000_0102;
/// How long a process the self-test started may outlive it.
const GONE_WITHIN: Duration = Duration::from_secs(5);
/// Forced ends that must land while the terminal is open.
const MID_RUN: usize = 8;
/// Forced ends tried at most to get them.
const MAX_FORCED: usize = 60;
/// Self-tests run to their normal end.
const NORMAL_RUNS: usize = 6;

/// The running children of `parent` whose program is `exe`, by process id.
fn children(parent: u32, exe: &str) -> Vec<u32> {
    let mut found = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return found;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snap, &mut entry) != 0;
        while more {
            let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            if entry.th32ParentProcessID == parent && String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case(exe) {
                found.push(entry.th32ProcessID);
            }
            more = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
    found
}

/// A process held open from the moment it was seen.
struct Held {
    pid: u32,
    handle: HANDLE,
}

impl Held {
    fn open(pid: u32) -> Option<Held> {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, 0, pid) };
        if handle.is_null() {
            None
        } else {
            Some(Held { pid, handle })
        }
    }

    fn running(&self) -> bool {
        unsafe { WaitForSingleObject(self.handle, 0) == WAIT_TIMEOUT }
    }

    fn gone_within(&self, wait: Duration) -> bool {
        unsafe { WaitForSingleObject(self.handle, wait.as_millis() as u32) == WAIT_OBJECT_0 }
    }

    /// End a process the test found left running, so a failed run leaves nothing behind.
    fn end(&self) {
        unsafe {
            TerminateProcess(self.handle, 1);
            WaitForSingleObject(self.handle, 2000);
        }
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

fn start_selftest() -> Child {
    Command::new(HELPER)
        .arg("selftest")
        .creation_flags(DETACHED_PROCESS)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start aicc-helper selftest")
}

/// What the self-test starts: its terminal's child and the console host.
const STARTED: [&str; 2] = ["aicc-helper.exe", "conhost.exe"];

/// Every child of `pid` that the self-test starts and `held` does not have
/// yet, held from now on. After `pid` has exited this still finds them: its
/// id stays this process's while the test holds it.
fn hold_new(pid: u32, held: &mut Vec<Held>) {
    for exe in STARTED {
        for id in children(pid, exe) {
            if !held.iter().any(|h| h.pid == id) {
                if let Some(h) = Held::open(id) {
                    held.push(h);
                }
            }
        }
    }
}

/// One forced end. Waits for the terminal's child, then ends the self-test,
/// counting the end as mid-run when that child and every console host still
/// ran right before it. Returns everything the self-test was seen to start,
/// looked at again after the end and held open, whether or not the moment
/// was caught, and whether the end landed mid-run.
fn forced_end() -> (Vec<Held>, bool) {
    let mut selftest = start_selftest();
    let pid = selftest.id();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut echo = None;
    while echo.is_none() && Instant::now() < deadline && matches!(selftest.try_wait(), Ok(None)) {
        echo = children(pid, "aicc-helper.exe").into_iter().find_map(Held::open);
    }
    let mut started = Vec::new();
    let mut mid_run = false;
    if let Some(echo) = echo {
        for id in children(pid, "conhost.exe") {
            if let Some(h) = Held::open(id) {
                started.push(h);
            }
        }
        let open = !started.is_empty() && started.iter().all(Held::running) && echo.running();
        mid_run = open && matches!(selftest.try_wait(), Ok(None)) && selftest.kill().is_ok();
        started.push(echo);
    }
    let _ = selftest.kill();
    let _ = selftest.wait();
    hold_new(pid, &mut started);
    (started, mid_run)
}

/// One self-test run to its end: whether it passed, its answer, and
/// everything it was seen to start, held open.
fn normal_end() -> (bool, String, Vec<Held>) {
    let mut selftest = start_selftest();
    let pid = selftest.id();
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut started = Vec::new();
    while matches!(selftest.try_wait(), Ok(None)) && Instant::now() < deadline {
        hold_new(pid, &mut started);
    }
    if matches!(selftest.try_wait(), Ok(None)) {
        let _ = selftest.kill();
        let _ = selftest.wait();
    }
    // Before `wait_with_output` lets the id go.
    hold_new(pid, &mut started);
    let out = selftest.wait_with_output().expect("read the self-test's answer");
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    (out.status.success() && text.contains("{\"ok\":true,"), text, started)
}

/// The ones still running `GONE_WITHIN` after the self-test ended, each named
/// with `how`; every one of them is ended.
fn left_running(started: &[Held], how: &str) -> Vec<String> {
    let mut left = Vec::new();
    for p in started {
        if !p.gone_within(GONE_WITHIN) {
            left.push(format!("process {} after {how}", p.pid));
            p.end();
        }
    }
    left
}

#[test]
fn nothing_the_self_test_starts_outlives_it_however_it_ends() {
    let mut left = Vec::new();
    let mut landed = 0;
    let mut tried = 0;
    while landed < MID_RUN && tried < MAX_FORCED {
        tried += 1;
        // Every try is checked, also one whose moment was missed: it still
        // ended the self-test, or let it end.
        let (started, mid_run) = forced_end();
        if mid_run {
            landed += 1;
        }
        left.extend(left_running(&started, if mid_run { "a forced end mid-run" } else { "a forced end" }));
    }
    let mut failed = Vec::new();
    for _ in 0..NORMAL_RUNS {
        let (ok, text, started) = normal_end();
        left.extend(left_running(&started, "a normal end"));
        if !ok {
            failed.push(text);
        }
    }
    assert!(landed >= 1, "no forced end landed while the self-test's terminal was open in {tried} tries");
    assert!(failed.is_empty(), "the self-test itself failed: {failed:?}");
    assert!(left.is_empty(), "{} of the self-test's processes outlived it by {GONE_WITHIN:?} ({landed} forced ends mid-run in {tried} tries, {NORMAL_RUNS} normal ends): {left:?}", left.len());
}
