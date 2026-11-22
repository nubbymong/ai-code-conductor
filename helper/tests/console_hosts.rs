//! aicc_planning #330: when the app is ended from outside, a console host it
//! made for a tab can keep running, with no app left to close it. At its next
//! start the app runs `aicc-helper console-hosts` with the pid and creation
//! time it recorded for the run before, and that ends each such host, and
//! nothing else.
//!
//! The run here is `aicc-helper __console-parent`: like the app with one tab,
//! it opens one terminal on Windows' own ConPTY, so it has one `conhost.exe`
//! child (it is started with no console of its own), and waits. Whether a
//! host outlives its run by itself depends on the Windows build: on the CI
//! runner it usually ends with it. So the test does not wait for chance. Once
//! the host is seen, every thread of it is suspended, so it cannot end by
//! itself, and then the run is ended from outside: from then on only an end
//! from outside can end that host (a suspended process can still be ended).
//! A second run, which keeps running, has a host of its own that must keep
//! running too. Every process is held by a handle from the moment it is seen,
//! so its pid cannot pass to another process while the test looks at it; the
//! run's own handle is held to the end, so its pid stays the run's, as it does
//! when a process still has a handle to an app that was ended.
//!
//! aicc_planning #363: while the app runs, a terminal on Windows' own ConPTY
//! whose program ended by itself keeps its console host, because node-pty
//! forgets the pseudoconsole, unclosed, when the program exits. The app times
//! the terminal's start and, after the program's exit, runs `aicc-helper
//! end-console-host` with that time. Here this test process is the app: it
//! opens terminals itself (the helper's own `Pty`, whose pseudoconsole stays
//! open until it is dropped, as node-pty's stays), so their hosts are its
//! children, and the mode it runs names it as the process that started it.
#![cfg(windows)]

use aicc_helper::pty::{Pty, PtySize};
use std::io::{BufRead, BufReader, Read};
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
/// The terminal's console host.
const HOST: &str = "conhost.exe";

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

/// A process held open from the moment it was seen. Ended when dropped, so
/// a failed run leaves nothing behind (a suspended process is ended too).
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

    /// Suspend every thread of it, looking again until none is left running.
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
}

impl Drop for Held {
    fn drop(&mut self) {
        unsafe {
            if WaitForSingleObject(self.handle, 0) == WAIT_TIMEOUT {
                TerminateProcess(self.handle, 1);
                WaitForSingleObject(self.handle, 2000);
            }
            CloseHandle(self.handle);
        }
    }
}

/// A run, ended and waited for when dropped; its handle is held until then.
struct Run(Child);

impl Drop for Run {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Start a run and wait for it to say its terminal is open.
fn start_run() -> Run {
    let mut child = Command::new(HELPER)
        .arg("__console-parent")
        .creation_flags(DETACHED_PROCESS)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("start aicc-helper __console-parent");
    let out = child.stdout.take().expect("its standard output");
    let run = Run(child);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    match rx.recv_timeout(Duration::from_secs(20)) {
        Ok(line) if line == "ready" => run,
        other => panic!("aicc-helper __console-parent did not say it was ready: {other:?}"),
    }
}

/// The run's console host, held: its one `conhost.exe` child, made no earlier than it.
fn host_of(run: &Run) -> Held {
    let since = made_at(run.0.as_raw_handle() as HANDLE).expect("the run's start time");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        for id in children(run.0.id(), HOST) {
            if let Some(h) = Held::open(id) {
                // Held, its id is its own: it is the run's when it still names
                // the run as its parent and was not made before it.
                if made_at(h.handle).is_some_and(|t| t >= since) && children(run.0.id(), HOST).contains(&id) {
                    return h;
                }
            }
        }
        assert!(Instant::now() < deadline, "no console host of run {} was seen", run.0.id());
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// `aicc-helper console-hosts --pid <pid> --created <created>`: whether it
/// exited 0, its standard output and its standard error.
fn console_hosts(pid: u32, created: u64) -> (bool, String, String) {
    let out = Command::new(HELPER)
        .args(["console-hosts", "--pid", &pid.to_string(), "--created", &created.to_string()])
        .stdin(Stdio::null())
        .output()
        .expect("run aicc-helper console-hosts");
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

/// The tests here run one at a time: each starts runs with terminals, suspends
/// and ends processes, and has the mode read the whole process list.
static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn one_at_a_time() -> std::sync::MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner())
}

/// The count after `"ended":` in the mode's answer.
fn ended_in(out: &str) -> Option<u32> {
    let at = out.find("\"ended\":")? + "\"ended\":".len();
    out[at..].chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

#[test]
fn it_ends_the_console_host_a_run_ended_from_outside_left_and_nothing_else() {
    let _serial = one_at_a_time();
    let mut old = start_run();
    let old_pid = old.0.id();
    // The run's creation time in the form the app records: steps of 100 ns
    // since 1601, to the microsecond (start.rs app_created).
    let created = made_at(old.0.as_raw_handle() as HANDLE).expect("the run's start time") / 10 * 10;
    let host = host_of(&old);
    let mut other = start_run();
    let other_host = host_of(&other);

    // While the run still runs, its pid has its creation time: nothing is ended.
    let (ok, out, err) = console_hosts(old_pid, created);
    assert!(ok, "{out}{err}");
    assert_eq!(ended_in(&out), Some(0), "{out}{err}");
    assert!(host.running(), "the host of a run that still runs was ended");

    // A record whose pid another process has now: here the other run, made
    // after the record's start. Its host was made after that start and before
    // this mode, but after the pid's owner too, so it names that owner as its
    // parent, not the run the record is of: nothing is ended.
    let (ok, out, err) = console_hosts(other.0.id(), created);
    assert!(ok, "{out}{err}");
    assert_eq!(ended_in(&out), Some(0), "{out}{err}");
    assert!(other_host.running(), "a host made after the pid's owner was ended");

    // The host cannot end by itself from now on; then the run is ended from outside.
    assert!(host.freeze(), "the run's host could not be suspended");
    old.0.kill().expect("end the run from outside");
    let _ = old.0.wait();
    assert!(host.running(), "the suspended host ended with its run");

    // A record of another start is another run's: nothing is ended.
    let (ok, out, err) = console_hosts(old_pid, created + 10_000_000);
    assert!(ok, "{out}{err}");
    assert_eq!(ended_in(&out), Some(0), "{out}{err}");
    assert!(host.running(), "a host was ended for a record of another start");

    // The run's own record: its host is ended, and nothing else.
    let (ok, out, err) = console_hosts(old_pid, created);
    assert!(ok, "{out}{err}");
    assert!(out.starts_with(&format!("{{\"pid\":{},\"created\":\"", std::process::id())), "it names the process that started it: {out}");
    assert_eq!(ended_in(&out), Some(1), "{out}{err}");
    assert!(host.gone_within(Duration::from_secs(5)), "the host the run left (process {}) still ran", host.pid);
    assert!(other_host.running(), "the host of a run that still runs was ended");
    assert!(matches!(other.0.try_wait(), Ok(None)), "the other run was ended");
}

/// A run ended from outside, its host suspended first so only an end from
/// outside can end it: the run (its handle held, so its pid stays its own),
/// its pid, its creation time in the app's form, and its host.
fn ended_run_with_host() -> (Run, u32, u64, Held) {
    let mut run = start_run();
    let pid = run.0.id();
    let created = made_at(run.0.as_raw_handle() as HANDLE).expect("the run's start time") / 10 * 10;
    let host = host_of(&run);
    // A moment for the host to finish starting, as the first test's looks give it.
    std::thread::sleep(Duration::from_millis(300));
    assert!(host.running(), "the run's host (process {}) ended by itself before it was suspended", host.pid);
    assert!(host.freeze(), "the run's host (process {}) could not be suspended (still running: {})", host.pid, host.running());
    run.0.kill().expect("end the run from outside");
    let _ = run.0.wait();
    assert!(host.running(), "the suspended host ended with its run");
    (run, pid, created, host)
}

/// The run's own record ends its host: so a case that ended nothing before
/// did so by its rule, not because the host could not be ended.
fn its_own_record_ends_it(pid: u32, created: u64, host: &Held) {
    let (ok, out, err) = console_hosts(pid, created);
    assert!(ok, "{out}{err}");
    assert_eq!(ended_in(&out), Some(1), "{out}{err}");
    assert!(host.gone_within(Duration::from_secs(5)), "the host the run left (process {}) still ran", host.pid);
}

#[test]
fn a_record_whose_pid_another_process_took_after_its_run_had_gone_ends_nothing() {
    // The record is of a start one second before the process that has the
    // pid now (the ended run, still held here). So that process took the pid
    // after the record's run had gone, and the host was made after it: it is
    // not the record's run's host, and nothing is ended.
    let _serial = one_at_a_time();
    let (_run, pid, created, host) = ended_run_with_host();
    let (ok, out, err) = console_hosts(pid, created - 10_000_000);
    assert!(ok, "{out}{err}");
    assert_eq!(ended_in(&out), Some(0), "{out}{err}");
    assert!(host.running(), "a host made after the pid's owner was ended");
    its_own_record_ends_it(pid, created, &host);
}

#[test]
fn a_record_from_before_windows_last_started_ends_nothing() {
    // Nothing of a run from before the last start of Windows runs now.
    let _serial = one_at_a_time();
    let (_run, pid, created, host) = ended_run_with_host();
    let (ok, out, err) = console_hosts(pid, 1);
    assert!(ok, "{out}{err}");
    assert_eq!(ended_in(&out), Some(0), "{out}{err}");
    assert!(err.contains("before Windows last started"), "no note for a record from before the last start: {err}");
    assert!(host.running(), "a host was ended for a record from before the last start");
    its_own_record_ends_it(pid, created, &host);
}

#[test]
fn with_no_record_it_only_says_which_process_started_it() {
    let _serial = one_at_a_time();
    let out = Command::new(HELPER).arg("console-hosts").stdin(Stdio::null()).output().expect("run aicc-helper console-hosts");
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(out.status.success(), "{text}{}", String::from_utf8_lossy(&out.stderr));
    let me = made_at(unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() }).expect("this test's start time") / 10 * 10;
    assert_eq!(text.trim(), format!("{{\"pid\":{},\"created\":\"{me}\",\"ended\":0}}", std::process::id()));
}

/// The system time now, in steps of 100 ns since 1601 (UTC), as the app
/// passes a terminal's start time.
fn filetime_now() -> u64 {
    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("after 1970");
    since.as_secs() * 10_000_000 + u64::from(since.subsec_nanos()) / 100 + 116_444_736_000_000_000
}

/// A terminal of this process on Windows' own ConPTY, kept open until it is
/// dropped, and the time its start took: from just before the pseudoconsole
/// was made to just after (`to` not included).
struct Terminal {
    pty: Pty,
    from: u64,
    to: u64,
}

/// Open a terminal running `argv`, its output read and dropped.
fn terminal(argv: &[String]) -> Terminal {
    let from = filetime_now();
    let (pty, mut out) = Pty::spawn(argv, PtySize::default()).expect("open a terminal");
    let to = filetime_now() + 1;
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while matches!(out.read(&mut buf), Ok(n) if n > 0) {}
    });
    Terminal { pty, from, to }
}

/// A program that ends by itself about a second after it starts: cmd.exe
/// from the system folder, pinging this computer twice, a second apart.
/// Not at once: on the CI runner, with `cmd /c exit` (a program that ends a
/// few milliseconds after its start), at least one host of two had ended by
/// itself half a second later (Helper job, run 45032572689), where the hosts
/// of programs that ran a while stay (probe P19, and the published beta.13's
/// five on the test VM).
fn ends_soon() -> Vec<String> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let mut argv = vec![format!(r"{root}\System32\cmd.exe")];
    argv.extend(["/c", "ping", "-n", "2", "127.0.0.1"].iter().map(|a| a.to_string()));
    argv
}

/// A program that keeps running while its terminal is open.
fn keeps_running() -> Vec<String> {
    vec![HELPER.to_string(), "__echo".to_string()]
}

/// Wait until the terminal's program has exited.
fn wait_ended(t: &mut Terminal) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !matches!(t.pty.try_wait(), Ok(Some(_))) {
        assert!(Instant::now() < deadline, "the terminal's program did not end");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The console host this process made in `[from, to)`, held: its one
/// `conhost.exe` child made then.
fn host_made_in(from: u64, to: u64) -> Held {
    let me = std::process::id();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        for id in children(me, HOST) {
            if let Some(h) = Held::open(id) {
                if made_at(h.handle).is_some_and(|t| t >= from && t < to) && children(me, HOST).contains(&id) {
                    return h;
                }
            }
        }
        assert!(Instant::now() < deadline, "no console host made by this process in that time was seen");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// `aicc-helper end-console-host --made-from <from> --made-to <to>`: whether
/// it exited 0, its standard output and its standard error.
fn end_console_host(from: u64, to: u64) -> (bool, String, String) {
    let out = Command::new(HELPER)
        .args(["end-console-host", "--made-from", &from.to_string(), "--made-to", &to.to_string()])
        .stdin(Stdio::null())
        .output()
        .expect("run aicc-helper end-console-host");
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

#[test]
fn a_terminal_whose_program_ended_has_its_console_host_ended_once_and_no_other() {
    let _serial = one_at_a_time();
    // A terminal whose program still runs, started first: its host is never ended.
    let live = terminal(&keeps_running());
    let live_host = host_made_in(live.from, live.to);
    let mut ended = terminal(&ends_soon());
    let host = host_made_in(ended.from, ended.to);
    wait_ended(&mut ended);
    // As node-pty leaves it: the program has ended, the pseudoconsole is open.
    std::thread::sleep(Duration::from_millis(500));
    assert!(host.running(), "the host of a terminal whose program ended (process {}) ended by itself", host.pid);

    let (ok, out, err) = end_console_host(ended.from, ended.to);
    assert!(ok, "{out}{err}");
    assert!(out.starts_with(&format!("{{\"pid\":{},\"created\":\"", std::process::id())), "it names the process that started it: {out}");
    assert_eq!(ended_in(&out), Some(1), "{out}{err}");
    assert!(host.gone_within(Duration::from_secs(5)), "the host of the terminal whose program ended (process {}) still ran", host.pid);
    assert!(live_host.running(), "the host of a terminal still running was ended");

    // Once: asked again for the same start, nothing more is ended.
    let (ok, out, err) = end_console_host(ended.from, ended.to);
    assert!(ok, "{out}{err}");
    assert_eq!(ended_in(&out), Some(0), "{out}{err}");
    assert!(live_host.running(), "the host of a terminal still running was ended");
}

#[test]
fn two_terminals_started_in_one_time_have_neither_host_ended_by_it() {
    let _serial = one_at_a_time();
    let from = filetime_now();
    let mut a = terminal(&ends_soon());
    let mut b = terminal(&ends_soon());
    let to = filetime_now() + 1;
    let host_a = host_made_in(a.from, a.to);
    let host_b = host_made_in(b.from, b.to);
    wait_ended(&mut a);
    wait_ended(&mut b);
    std::thread::sleep(Duration::from_millis(500));
    assert!(host_a.running() && host_b.running(), "a host of a terminal whose program ended ended by itself");

    // A time that holds both starts cannot say which terminal ended: neither host is ended.
    let (ok, out, err) = end_console_host(from, to);
    assert!(ok, "{out}{err}");
    assert_eq!(ended_in(&out), Some(0), "{out}{err}");
    assert!(err.contains("2 console hosts were made in that time"), "no note for two hosts: {err}");
    assert!(host_a.running() && host_b.running(), "a host was ended for a time that holds two starts");

    // Each start's own time ends its own host, and only that one.
    let (ok, out, err) = end_console_host(a.from, a.to);
    assert!(ok, "{out}{err}");
    assert_eq!(ended_in(&out), Some(1), "{out}{err}");
    assert!(host_a.gone_within(Duration::from_secs(5)), "the first terminal's host (process {}) still ran", host_a.pid);
    assert!(host_b.running(), "the second terminal's host was ended for the first one's start");
}

#[test]
fn a_start_time_it_cannot_take_is_refused() {
    // More than ten seconds is not one start; nothing is read or ended.
    let out = Command::new(HELPER)
        .args(["end-console-host", "--made-from", "1", "--made-to", "100000002"])
        .stdin(Stdio::null())
        .output()
        .expect("run aicc-helper end-console-host");
    let err = String::from_utf8_lossy(&out.stderr).into_owned();
    assert_eq!(out.status.code(), Some(2), "{err}");
    assert!(err.contains("by ten seconds at most"), "not refused for its length: {err}");
    assert!(out.stdout.is_empty(), "it answered: {}", String::from_utf8_lossy(&out.stdout));
}
