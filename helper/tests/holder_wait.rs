//! A held program's exit is reported at once (plan 2.1.3-beta.8 section B1).
//! The holder waits on its child instead of asking for the child's status
//! every 25 ms, so this checks that nothing is lost or late on the way:
//! whether the program exits 0, exits 7 or is ended from outside the holder,
//! the attached app gets `term.exit` with that code within 250 ms of the end,
//! and the record says `exited` with the same code within one more tick of
//! the holder's 250 ms clock.
//!
//! Each time is measured from just before the test made the program end (it
//! typed `exit <n>`, or ended the process itself), so it is never shorter than
//! the time from the program's own exit.

use aicc_helper::client::Client;
use aicc_helper::frame::{Body, Frame};
use aicc_helper::json::{self, Value};
use aicc_helper::pids;
use aicc_helper::store::{self, Record};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
const FAKE: &str = env!("CARGO_BIN_EXE_aicc-fake-cli");
const WAIT: Duration = Duration::from_secs(20);
/// How soon after the program's end the attached app is told (`term.exit`).
const TOLD_WITHIN: Duration = Duration::from_millis(250);
/// The record is written on the holder's 250 ms clock (serve.rs `TICK`),
/// which this change leaves as it is: it may come one tick after `term.exit`.
const RECORDED_WITHIN: Duration = Duration::from_millis(500);
/// The exit code a program ended from outside reports: 128 + SIGKILL on
/// macOS and Linux, and the code this test ends it with on Windows.
const KILLED_CODE: i64 = 137;

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// One start at a time, as in probe_transport.rs: on Windows a process started
/// while another test thread is mid-spawn could carry that thread's pipe ends.
/// A test that failed while holding the lock must not stop the others.
fn one_at_a_time() -> MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("aicc-holder-wait-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("a folder");
    dir
}

/// Start a detached holder; the record it printed. Its output goes to files,
/// not pipes: the holder outlives this call, and a pipe would stay open with it.
fn hold(store_dir: &Path, sid: &str) -> Record {
    let out_path = store_dir.with_extension("out");
    let err_path = store_dir.with_extension("err");
    let store_arg = store_dir.to_string_lossy().into_owned();
    let status = Command::new(HELPER)
        .args(["hold", "--detach", "--store", store_arg.as_str(), "--session", sid, "--label", "Exit test", "--away", "30"])
        .stdin(Stdio::null())
        .stdout(fs::File::create(&out_path).expect("a file for stdout"))
        .stderr(fs::File::create(&err_path).expect("a file for stderr"))
        .status()
        .expect("run the helper");
    let stdout = fs::read_to_string(&out_path).unwrap_or_default();
    let stderr = fs::read_to_string(&err_path).unwrap_or_default();
    let _ = fs::remove_file(&out_path);
    let _ = fs::remove_file(&err_path);
    assert!(status.success(), "hold --detach failed: {stdout} / {stderr}");
    let printed = json::parse(stdout.trim().as_bytes()).unwrap_or_else(|e| panic!("hold printed no JSON ({e:?}): {stdout:?} / {stderr:?}"));
    Record::from_value(&printed).unwrap_or_else(|e| panic!("hold printed a record that does not read ({e}): {stdout}"))
}

fn t_of(v: &Value) -> &str {
    v.get("t").and_then(Value::as_str).unwrap_or("")
}

fn msg(t: &str, id: u64, more: Vec<(&str, Value)>) -> Value {
    let mut members = vec![("t", Value::str(t)), ("id", Value::uint(id))];
    members.extend(more);
    Value::obj(members)
}

/// What a launch hands the child: this test's environment, as much of it as a
/// launch allows.
fn launch_env() -> Vec<(String, String)> {
    let mut seen: Vec<String> = Vec::new();
    let mut env: Vec<(String, String)> = Vec::new();
    for (k, v) in std::env::vars() {
        let folded = k.to_uppercase();
        if k.is_empty() || k.contains('=') || k.chars().count() > 255 || v.chars().count() > 32767 || seen.contains(&folded) {
            continue;
        }
        seen.push(folded);
        env.push((k, v));
    }
    env.truncate(1000);
    env
}

fn launch_msg(id: u64, cwd: &Path) -> Value {
    msg(
        "term.launch",
        id,
        vec![
            ("argv", Value::strs(&[FAKE])),
            ("cwd", Value::Str(cwd.to_string_lossy().into_owned())),
            ("env", Value::Obj(launch_env().into_iter().map(|(k, v)| (k, Value::Str(v))).collect())),
            ("cols", Value::uint(120)),
            ("rows", Value::uint(24)),
        ],
    )
}

/// One connection to a holder, as the app holds it.
struct App {
    client: Client,
    screen: Vec<u8>,
    events: Vec<Value>,
    next_id: u64,
}

impl App {
    fn connect(rec: &Record) -> App {
        let mut client = Client::to_record(rec, WAIT).expect("connect to the holder and read its hello");
        client.ack().expect("ack the hello");
        App { client, screen: Vec::new(), events: Vec::new(), next_id: 2 }
    }

    fn id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 2;
        id
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.screen).into_owned()
    }

    /// Read one frame; false at the end of the stream, on an error, or once
    /// `until` has passed.
    fn pump(&mut self, until: Instant) -> bool {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        match self.client.recv(left) {
            Ok(Some(Frame { channel: 1, body: Body::Raw(bytes) })) => {
                self.screen.extend_from_slice(&bytes);
                true
            }
            Ok(Some(Frame { channel: 0, body: Body::Json(v) })) => {
                self.events.push(v);
                true
            }
            Ok(Some(other)) => panic!("a frame on an unexpected channel: {other:?}"),
            Ok(None) | Err(_) => false,
        }
    }

    /// Wait for a message `pick` chooses, from those that came or come.
    fn wait_message(&mut self, what: &str, pick: impl Fn(&Value) -> bool) -> Value {
        let until = Instant::now() + WAIT;
        loop {
            if let Some(at) = self.events.iter().position(&pick) {
                return self.events.remove(at);
            }
            if !self.pump(until) {
                let messages: Vec<String> = self.events.iter().map(Value::to_json).collect();
                panic!("no {what}; screen {:?}; messages {messages:?}", self.text());
            }
        }
    }

    /// Send `v` and wait for the message that answers its id.
    fn call(&mut self, v: Value) -> Value {
        let id = v.get("id").and_then(Value::as_u64).expect("a request id");
        self.client.send(v).expect("send a request");
        self.wait_message("answer", |e| e.get("re").and_then(Value::as_u64) == Some(id))
    }

    fn wait_text(&mut self, needle: &str) {
        let until = Instant::now() + WAIT;
        while !self.text().contains(needle) {
            if !self.pump(until) {
                panic!("{needle:?} never appeared on the terminal: {:?}", self.text());
            }
        }
    }
}

/// End process `pid` from outside the holder, as another program could.
#[cfg(unix)]
fn end_from_outside(pid: u32) {
    let sent = unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    assert_eq!(sent, 0, "could not end the program: {}", std::io::Error::last_os_error());
}

/// End process `pid` from outside the holder, as another program could.
#[cfg(windows)]
fn end_from_outside(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
        assert!(!process.is_null(), "could not open the program: {}", std::io::Error::last_os_error());
        let ended = TerminateProcess(process, KILLED_CODE as u32);
        let why = std::io::Error::last_os_error();
        CloseHandle(process);
        assert_ne!(ended, 0, "could not end the program: {why}");
    }
}

/// How the program ends.
#[derive(Clone, Copy, Debug)]
enum Ending {
    /// It exits by itself with this code.
    Exits(i64),
    /// It is ended from outside the holder.
    FromOutside,
}

/// What one run saw.
struct Seen {
    told: Duration,
    told_code: Option<i64>,
    recorded: Duration,
    recorded_code: Option<i64>,
}

/// Launch the fake CLI in a detached holder, attach, end the program as
/// `ending` says, and time `term.exit` and the record. The holder is ended
/// before anything is checked, so a failed check leaves nothing running.
fn run(sid: &str, ending: Ending) -> Seen {
    let store_dir = temp_dir(&format!("store-{sid}"));
    let work = temp_dir(&format!("work-{sid}"));
    let rec = hold(&store_dir, sid);
    let mut app = App::connect(&rec);
    let id = app.id();
    let launched = app.call(launch_msg(id, &work));
    assert_eq!(t_of(&launched), "term.launched", "{}", launched.to_json());
    let child = launched.get("pid").and_then(Value::as_u64).expect("the launch answers the child's process id") as u32;
    let id = app.id();
    let attached = app.call(msg("term.attach", id, vec![("from", Value::uint(0))]));
    assert_eq!(t_of(&attached), "term.attached", "{}", attached.to_json());
    app.wait_text("FAKE-CLI READY");

    // The program ends at or after this moment.
    let began = Instant::now();
    match ending {
        Ending::Exits(code) => app.client.send_raw(1, format!("exit {code}\r").as_bytes()).expect("type into the terminal"),
        Ending::FromOutside => end_from_outside(child),
    }
    let exit = app.wait_message("term.exit", |e| t_of(e) == "term.exit");
    let told = began.elapsed();
    let told_code = exit.get("code").and_then(Value::as_i64);
    let (recorded, recorded_code) = loop {
        match store::read(&store_dir, sid) {
            Some(Ok(r)) if r.child == "exited" => break (began.elapsed(), r.code),
            other if began.elapsed() > WAIT => panic!("the record never said the program exited: {other:?}"),
            _ => std::thread::sleep(Duration::from_millis(5)),
        }
    };

    let id = app.id();
    let ended = app.call(msg("term.end", id, vec![]));
    assert_eq!(t_of(&ended), "term.ended", "{}", ended.to_json());
    let deadline = Instant::now() + WAIT;
    while pids::alive(rec.pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!pids::alive(rec.pid), "the holder outlived term.end");
    let _ = fs::remove_dir_all(&store_dir);
    let _ = fs::remove_dir_all(&work);
    Seen { told, told_code, recorded, recorded_code }
}

fn check(sid: &str, ending: Ending, code: i64) {
    let seen = run(sid, ending);
    assert_eq!(seen.told_code, Some(code), "{ending:?}: term.exit carried the wrong code");
    assert_eq!(seen.recorded_code, Some(code), "{ending:?}: the record carried the wrong code");
    assert!(seen.told <= TOLD_WITHIN, "{ending:?}: the app was told {:?} after the program's end (limit {TOLD_WITHIN:?})", seen.told);
    assert!(seen.recorded <= RECORDED_WITHIN, "{ending:?}: the record said exited {:?} after the program's end (limit {RECORDED_WITHIN:?})", seen.recorded);
}

#[test]
fn a_program_that_exits_0_is_reported_at_once() {
    let _serial = one_at_a_time();
    check("wait-0001", Ending::Exits(0), 0);
}

#[test]
fn a_program_that_exits_7_is_reported_at_once_with_its_code() {
    let _serial = one_at_a_time();
    check("wait-0002", Ending::Exits(7), 7);
}

#[test]
fn a_program_ended_from_outside_the_holder_is_reported_at_once() {
    let _serial = one_at_a_time();
    check("wait-0003", Ending::FromOutside, KILLED_CODE);
}
