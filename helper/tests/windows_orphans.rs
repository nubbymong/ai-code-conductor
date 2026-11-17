//! #317: nothing the self-test starts outlives it, however it ends.
//!
//! On Windows `CreatePseudoConsole` starts the terminal's console host
//! (`conhost.exe --headless`) as a child of the process that calls it: here,
//! `aicc-helper selftest`. Only `ClosePseudoConsole` ends that host on
//! purpose, and a self-test ended by force never calls it. Whether the host
//! then ends by itself depends on the Windows build. On the Windows 11 test VM
//! (build 22621) the 2.1.3-beta.6 helper left it running after 1 of 12 forced
//! ends and 3 of 4 normal ends; that was measured by hand, not by this test.
//! On the CI runner (Windows Server 2025, build 26100) the host ended with the
//! self-test, so a test that waits for a host to stay by chance cannot fail
//! there.
//!
//! So the forced ends here do not wait for chance. As soon as the self-test's
//! host is seen, every thread of it is suspended, so it cannot end by itself
//! on any build, and the self-test is then ended by force. From then on only
//! the self-test's job can end that host (a suspended process can still be
//! ended). Without the job the host stays, on every build, and the test
//! fails; with it, the host goes when the self-test does. The test needs
//! `FORCED` such ends in at most `MAX_TRIES` tries, and fails if fewer land.
//! It also runs the self-test to its normal end `NORMAL_RUNS` times, with
//! nothing suspended, and expects nothing it started to outlive it, and no
//! note on its standard error that it ran without its job.
//!
//! The self-test is started with no console of its own, so every
//! `conhost.exe` child it has is its terminal's host. Every process it starts
//! is held by a process handle from the moment it is seen, so its id cannot
//! pass to another process while the test looks at it. A process counts as
//! the self-test's only when, held, it still names the self-test as its
//! parent and was made no earlier than the self-test: one that was already
//! running is never taken for one, even when its parent once had the same id.
//! One the test finds still running is ended before the test fails. A failure
//! means that a process the self-test started still ran `GONE_WITHIN` after
//! the self-test had gone.
#![cfg(windows)]

use std::io::Read;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next, PROCESSENTRY32W, TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::Threading::{
    GetProcessIdOfThread, GetProcessTimes, OpenProcess, OpenThread, SuspendThread, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
/// `DETACHED_PROCESS`: no console of its own, so no console host but its terminal's.
const DETACHED_PROCESS: u32 = 0x0000_0008;
/// `WAIT_OBJECT_0`: the process has exited.
const WAIT_OBJECT_0: u32 = 0;
/// `WAIT_TIMEOUT`: it is still running.
const WAIT_TIMEOUT: u32 = 0x0000_0102;
/// How long a process the self-test started may outlive it.
const GONE_WITHIN: Duration = Duration::from_secs(5);
/// Forced ends that must land: the host seen and suspended, then the
/// self-test ended by force while it still ran.
const FORCED: usize = 5;
/// Forced ends tried at most to land them.
const MAX_TRIES: usize = 30;
/// Self-tests run to their normal end.
const NORMAL_RUNS: usize = 6;
/// How long the test waits for the self-test's output once it has gone.
const READ_WAIT: Duration = Duration::from_secs(10);
/// The terminal's console host.
const HOST: &str = "conhost.exe";
/// The terminal's child (`aicc-helper __echo`).
const CHILD: &str = "aicc-helper.exe";
/// What the self-test writes on standard error when it runs without its job
/// (`end_children_with_selftest`, main.rs).
const NO_JOB_NOTE: &str = "may outlive it";

/// The ids of the running processes whose parent is `parent` and whose
/// program is `exe`, as the process list has them now.
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

/// The ids of the threads of process `pid`, as the thread list has them now.
fn threads_of(pid: u32) -> Vec<u32> {
    let mut found = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap == INVALID_HANDLE_VALUE {
            return found;
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut more = Thread32First(snap, &mut entry) != 0;
        while more {
            if entry.th32OwnerProcessID == pid {
                found.push(entry.th32ThreadID);
            }
            more = Thread32Next(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
    found
}

/// When the process behind `handle` was made, as a FILETIME count.
fn made_at(handle: HANDLE) -> Option<u64> {
    let zero = || FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let (mut made, mut exited, mut kernel, mut user) = (zero(), zero(), zero(), zero());
    if unsafe { GetProcessTimes(handle, &mut made, &mut exited, &mut kernel, &mut user) } == 0 {
        return None;
    }
    Some((u64::from(made.dwHighDateTime) << 32) | u64::from(made.dwLowDateTime))
}

/// A process held open from the moment it was seen.
struct Held {
    pid: u32,
    handle: HANDLE,
    /// The terminal's console host, not the terminal's child.
    host: bool,
}

impl Held {
    fn open(pid: u32, host: bool) -> Option<Held> {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, 0, pid) };
        if handle.is_null() {
            None
        } else {
            Some(Held { pid, handle, host })
        }
    }

    fn running(&self) -> bool {
        unsafe { WaitForSingleObject(self.handle, 0) == WAIT_TIMEOUT }
    }

    fn gone_within(&self, wait: Duration) -> bool {
        unsafe { WaitForSingleObject(self.handle, wait.as_millis() as u32) == WAIT_OBJECT_0 }
    }

    /// Suspend every thread of it, looking again until none is left running
    /// (a thread can start another while the others are being suspended).
    /// True when it still runs with its threads suspended: from then on it
    /// cannot end by itself.
    fn freeze(&self) -> bool {
        let mut frozen: Vec<u32> = Vec::new();
        for _ in 0..10 {
            let mut more = false;
            for tid in threads_of(self.pid) {
                if frozen.contains(&tid) {
                    continue;
                }
                unsafe {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION, 0, tid);
                    if thread.is_null() {
                        continue;
                    }
                    // A thread id can pass to another process's thread after
                    // the list was taken: only this process's is suspended.
                    if GetProcessIdOfThread(thread) == self.pid && SuspendThread(thread) != u32::MAX {
                        frozen.push(tid);
                        more = true;
                    }
                    CloseHandle(thread);
                }
            }
            if !more {
                break;
            }
        }
        !frozen.is_empty() && self.running()
    }

    /// End a process the test found left running, so a failed run leaves
    /// nothing behind (a suspended process is ended too).
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

/// When the self-test was made.
fn made_at_of(selftest: &Child) -> u64 {
    made_at(selftest.as_raw_handle() as HANDLE).expect("the self-test's start time")
}

/// Every process the self-test `parent` (made at `since`) started and `held`
/// does not have yet, held from now on. After the self-test has exited this
/// still finds them: its id stays its own while the test holds its `Child`.
fn hold_new(parent: u32, since: u64, held: &mut Vec<Held>) {
    for exe in [CHILD, HOST] {
        for id in children(parent, exe) {
            if held.iter().any(|h| h.pid == id) {
                continue;
            }
            let Some(h) = Held::open(id, exe == HOST) else { continue };
            // Held, its id is its own: it is the self-test's when it still
            // names the self-test as its parent and was not made before it.
            if made_at(h.handle).is_some_and(|t| t >= since) && children(parent, exe).contains(&id) {
                held.push(h);
            }
        }
    }
}

/// Reads `pipe` to its end on a thread of its own; the text comes on the
/// receiver. A full pipe never holds the self-test up, and a process left
/// holding the pipe never holds the test up.
fn read_all(mut pipe: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        let _ = tx.send(String::from_utf8_lossy(&bytes).into_owned());
    });
    rx
}

/// One forced end. Holds what the self-test starts as it appears; once its
/// host is seen, suspends it and, if the self-test still runs, ends the
/// self-test by force: that end has landed. Landed or not, the self-test is
/// ended, and everything it was seen to start is looked for again and
/// returned, held.
fn forced_end() -> (Vec<Held>, bool) {
    let mut selftest = start_selftest();
    let pid = selftest.id();
    let since = made_at_of(&selftest);
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut started: Vec<Held> = Vec::new();
    let mut frozen = false;
    while !frozen && Instant::now() < deadline && matches!(selftest.try_wait(), Ok(None)) {
        hold_new(pid, since, &mut started);
        frozen = started.iter().any(|h| h.host && h.freeze());
    }
    let landed = frozen && matches!(selftest.try_wait(), Ok(None)) && selftest.kill().is_ok();
    let _ = selftest.kill();
    let _ = selftest.wait();
    // Before `selftest` is dropped and its id let go.
    hold_new(pid, since, &mut started);
    (started, landed)
}

/// One self-test run to its end, nothing suspended.
struct NormalRun {
    /// It exited with success.
    exited_ok: bool,
    out: mpsc::Receiver<String>,
    err: mpsc::Receiver<String>,
    /// What it started that still ran once it had gone, held.
    started: Vec<Held>,
}

fn normal_end() -> NormalRun {
    let mut selftest = start_selftest();
    let out = read_all(selftest.stdout.take().expect("the self-test's standard output"));
    let err = read_all(selftest.stderr.take().expect("the self-test's standard error"));
    let pid = selftest.id();
    let since = made_at_of(&selftest);
    let deadline = Instant::now() + Duration::from_secs(60);
    while matches!(selftest.try_wait(), Ok(None)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if matches!(selftest.try_wait(), Ok(None)) {
        let _ = selftest.kill();
    }
    let exited_ok = selftest.wait().map(|s| s.success()).unwrap_or(false);
    // Once it has gone, and before `selftest` is dropped and its id let go.
    let mut started = Vec::new();
    hold_new(pid, since, &mut started);
    NormalRun { exited_ok, out, err, started }
}

/// The ones still running `GONE_WITHIN` after the self-test ended, each named
/// with `how`; every one of them is ended.
fn left_running(started: &[Held], how: &str) -> Vec<String> {
    let mut left = Vec::new();
    for p in started {
        if !p.gone_within(GONE_WITHIN) {
            left.push(format!("{} {} after {how}", if p.host { HOST } else { CHILD }, p.pid));
            p.end();
        }
    }
    left
}

#[test]
fn nothing_the_self_test_starts_outlives_it_however_it_ends() {
    let mut left = Vec::new();
    let mut landed = 0;
    let mut tries = 0;
    while landed < FORCED && tries < MAX_TRIES {
        tries += 1;
        // Every try is checked, also one that did not land: it still ended
        // the self-test, or let it end.
        let (started, mid_run) = forced_end();
        if mid_run {
            landed += 1;
        }
        left.extend(left_running(&started, if mid_run { "a forced end with the host suspended" } else { "a forced end that did not land" }));
    }
    let mut failed = Vec::new();
    let mut notes = Vec::new();
    for _ in 0..NORMAL_RUNS {
        let run = normal_end();
        // Ended first if left running, so no process left holding its pipes
        // holds up the reading of its answer.
        left.extend(left_running(&run.started, "a normal end"));
        let out = run.out.recv_timeout(READ_WAIT).unwrap_or_default();
        let err = run.err.recv_timeout(READ_WAIT).unwrap_or_default();
        if !(run.exited_ok && out.contains("{\"ok\":true,")) {
            failed.push(format!("{out}{err}"));
        }
        if err.contains(NO_JOB_NOTE) {
            notes.push(err);
        }
    }
    assert!(
        left.is_empty(),
        "{} of the self-test's processes outlived it by {GONE_WITHIN:?} ({landed} forced ends landed in {tries} tries, {NORMAL_RUNS} normal ends): {left:?}",
        left.len()
    );
    assert!(landed >= FORCED, "only {landed} of {tries} forced ends landed with the self-test's host suspended; {FORCED} are needed");
    assert!(failed.is_empty(), "the self-test itself failed: {failed:?}");
    assert!(notes.is_empty(), "the self-test ran without its job: {notes:?}");
}
