//! `aicc-helper start` (protocol section 15, "Starting a program"): on
//! Windows the program it starts keeps none of the starter's handles, it says
//! which process it started in the form the app checks, and it starts only a
//! program named by an absolute path that is not a batch file and that
//! Windows opens as named. On macOS and Linux the mode refuses.

#[cfg(unix)]
#[test]
fn the_start_mode_refuses_on_macos_and_linux() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_aicc-helper"))
        .args(["start", "--cwd", "/tmp", "--", "/bin/sleep", "1"])
        .output()
        .expect("run the helper");
    assert_eq!(out.status.code(), Some(1), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(out.stdout.is_empty(), "it printed {}", String::from_utf8_lossy(&out.stdout));
    assert!(String::from_utf8_lossy(&out.stderr).contains("Windows only"));
}

#[cfg(windows)]
mod windows {
    use aicc_helper::json::{self, Value};
    use aicc_helper::pids;
    use std::io::{PipeReader, PipeWriter, Read};
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::{mpsc, Mutex, MutexGuard};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
    const FAKE: &str = env!("CARGO_BIN_EXE_aicc-fake-cli");

    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

    /// A child inherits every inheritable handle of this process, so a test
    /// that starts one while another test's pipe end is inheritable would
    /// carry that end into it. Taking this lock first keeps them apart; a
    /// lock a failed test poisoned is used again.
    fn one_at_a_time() -> MutexGuard<'static, ()> {
        ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    struct Ran {
        code: Option<i32>,
        stdout: String,
        stderr: String,
    }

    fn helper(args: &[&str]) -> Ran {
        let out = Command::new(HELPER).args(args).output().expect("run the helper");
        Ran { code: out.status.code(), stdout: String::from_utf8_lossy(&out.stdout).into_owned(), stderr: String::from_utf8_lossy(&out.stderr).into_owned() }
    }

    fn folder() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }

    /// `aicc-helper start --cwd <temp> -- <program> <args>`.
    fn start(program: &str, args: &[&str]) -> Ran {
        let cwd = folder();
        let mut all = vec!["start", "--cwd", cwd.as_str(), "--", program];
        all.extend_from_slice(args);
        helper(&all)
    }

    /// The line `start` printed, read as the app reads it: exactly a pid and
    /// a creation time of digits.
    fn started(ran: &Ran) -> (u32, String) {
        assert_eq!(ran.code, Some(0), "start failed: {}", ran.stderr);
        let line = ran.stdout.trim_end();
        assert!(!line.contains('\n'), "start printed more than one line: {:?}", ran.stdout);
        let v: Value = json::parse(line.as_bytes()).unwrap_or_else(|e| panic!("{line:?} is not JSON: {e:?}"));
        assert_eq!(v.keys(), Some(vec!["pid", "created"]), "{line}");
        let pid = v.get("pid").and_then(Value::as_u64).expect("a pid");
        let created = v.get("created").and_then(Value::as_str).expect("a creation time").to_string();
        assert!(!created.is_empty() && created.len() <= 20 && created.bytes().all(|b| b.is_ascii_digit()), "{line}");
        (u32::try_from(pid).expect("a 32-bit pid"), created)
    }

    /// A process this test started through `start`, ended when dropped.
    struct Started(u32);

    impl Drop for Started {
        fn drop(&mut self) {
            unsafe {
                let h = OpenProcess(PROCESS_TERMINATE, 0, self.0);
                if !h.is_null() {
                    TerminateProcess(h, 1);
                    CloseHandle(h);
                }
            }
        }
    }

    /// A child this test started itself, ended and waited for when dropped.
    struct Running(std::process::Child);

    impl Drop for Running {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn inheritable(end: PipeWriter) -> PipeWriter {
        use std::os::windows::io::AsRawHandle;
        let ok = unsafe { SetHandleInformation(end.as_raw_handle() as HANDLE, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) };
        assert_ne!(ok, 0, "make the pipe end inheritable: {}", std::io::Error::last_os_error());
        end
    }

    /// Read `end` on a thread of its own; the channel gets how the read ended.
    /// Nothing writes to the pipe, so `Ok(0)` (its end) is the only good answer.
    fn end_of_file(mut end: PipeReader) -> mpsc::Receiver<std::io::Result<usize>> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut got = Vec::new();
            let _ = tx.send(end.read_to_end(&mut got));
        });
        rx
    }

    /// What `Win32_Process` says of `pid`: its program and its creation time
    /// in the form the app's verified end checks (`windowsEndScript` in
    /// src/main/vision-browser-owner.ts).
    fn as_the_app_reads_it(pid: u32) -> (String, String) {
        let root = std::env::var("SystemRoot").expect("SystemRoot is set");
        let ps = PathBuf::from(root).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
        let script = format!(
            "$ErrorActionPreference = 'Stop'; $p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId={pid}'; [string]$p.ExecutablePath; [string]$p.CreationDate.ToFileTimeUtc()"
        );
        let out = Command::new(ps).args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script.as_str()]).stdin(Stdio::null()).output().expect("run PowerShell");
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        assert!(out.status.success(), "PowerShell failed: {}", String::from_utf8_lossy(&out.stderr));
        let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
        let exe = lines.next().unwrap_or_default().to_string();
        let created = lines.next().unwrap_or_default().to_string();
        (exe, created)
    }

    #[test]
    fn the_program_it_starts_keeps_none_of_the_starters_handles() {
        let _serial = one_at_a_time();
        let (read_end, write_end) = std::io::pipe().expect("a pipe");
        let write_end = inheritable(write_end);
        let ended = end_of_file(read_end);
        // The helper is given the pipe end, as the app's every inheritable
        // handle reaches it, and has exited when this returns.
        let ran = start(FAKE, &["--sleep", "10"]);
        let (pid, _) = started(&ran);
        let _child = Started(pid);
        // The control: the same program, started the plain way, given the same end.
        let control = Running(Command::new(FAKE).args(["--sleep", "10"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("start the fake CLI"));
        drop(write_end);
        let early = ended.recv_timeout(Duration::from_millis(500));
        drop(control);
        assert!(early.is_err(), "the pipe ended while a child that inherited it still ran: this test cannot see a handle that was passed on");
        let end = ended.recv_timeout(Duration::from_secs(2));
        match end {
            Ok(Ok(0)) => {}
            Ok(Ok(n)) => panic!("{n} bytes came down a pipe nothing writes to"),
            Ok(Err(e)) => panic!("reading the pipe failed: {e}"),
            Err(_) => panic!("the started program (process {pid}) kept the pipe its starter was given open: it was still open 2 s after every other end had closed"),
        }
        assert!(pids::alive(pid), "the started program (process {pid}) was not running");
    }

    #[test]
    fn it_says_which_process_it_started_in_the_form_the_app_checks() {
        let _serial = one_at_a_time();
        // More than one start: a creation time the app reads another way
        // (rounded rather than cut to the microsecond) would differ for some.
        for _ in 0..4 {
            let ran = start(FAKE, &["--sleep", "10"]);
            let (pid, created) = started(&ran);
            let _child = Started(pid);
            let (exe, app_created) = as_the_app_reads_it(pid);
            assert_eq!(exe.to_lowercase(), FAKE.to_lowercase(), "process {pid} is not the program that was started");
            assert_eq!(created, app_created, "the start time printed for process {pid} is not the one the app reads");
        }
    }

    #[test]
    fn it_does_not_wait_for_the_program() {
        let _serial = one_at_a_time();
        let begun = Instant::now();
        let ran = start(FAKE, &["--sleep", "10"]);
        let (pid, _) = started(&ran);
        let _child = Started(pid);
        assert!(begun.elapsed() < Duration::from_secs(5), "start took {:?}", begun.elapsed());
        assert!(pids::alive(pid), "the started program (process {pid}) was not running");
    }

    #[test]
    fn a_program_it_must_not_start_is_refused_and_nothing_starts() {
        let _serial = one_at_a_time();
        let fake_with_a_trailing_dot = format!("{FAKE}.");
        let fake_by_a_part_of_dots = {
            let p = PathBuf::from(FAKE);
            let dir = p.parent().expect("a folder").to_string_lossy().into_owned();
            let name = p.file_name().expect("a name").to_string_lossy().into_owned();
            format!("{dir}\\.\\{name}")
        };
        let batch = std::env::temp_dir().join("aicc-start-test.cmd").to_string_lossy().into_owned();
        // A relative or bare name (never searched for), a batch file, and
        // names Windows would open as the fake CLI.
        for program in ["aicc-fake-cli.exe", "cmd.exe", batch.as_str(), fake_with_a_trailing_dot.as_str(), fake_by_a_part_of_dots.as_str()] {
            let ran = start(program, &["--sleep", "10"]);
            assert_eq!(ran.code, Some(1), "{program:?} was not refused: {} {}", ran.stdout, ran.stderr);
            assert!(ran.stdout.is_empty(), "{program:?}: start printed {:?}", ran.stdout);
            assert!(ran.stderr.contains("refused"), "{program:?}: {}", ran.stderr);
        }
        // A program that is not there fails, with nothing printed.
        let missing = std::env::temp_dir().join("aicc-start-test-missing.exe").to_string_lossy().into_owned();
        let ran = start(&missing, &[]);
        assert_eq!(ran.code, Some(1), "{}", ran.stderr);
        assert!(ran.stdout.is_empty(), "{:?}", ran.stdout);
        assert!(ran.stderr.contains("could not start"), "{}", ran.stderr);
        // A command line it cannot read.
        let ran = helper(&["start", "--cwd", folder().as_str(), FAKE]);
        assert_eq!(ran.code, Some(2), "{}", ran.stderr);
    }
}
