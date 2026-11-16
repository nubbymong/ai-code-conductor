//! The helper as a program, over its local transport (protocol section 15):
//! `hold --detach` starts a holder that outlives the command, `list` finds it,
//! and a client in this test process connects to its pipe or socket, acks the
//! hello, launches the fake CLI with a folder and an environment, attaches,
//! types, re-attaches from an offset and ends it, the way the app will.
//! Connecting from a fresh client after the first one has gone is the part
//! that stands in for "the app reconnects to a holder after a crash".

use aicc_helper::client::Client;
use aicc_helper::frame::{self, Body, Direction, Frame};
use aicc_helper::json::{self, Value};
use aicc_helper::pids;
use aicc_helper::store::{self, Listing, Record};
use aicc_helper::transport;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
const FAKE: &str = env!("CARGO_BIN_EXE_aicc-fake-cli");
const NONCE: &str = "0123456789abcdef0123456789abcdef";
const WAIT: Duration = Duration::from_secs(20);
/// Set on the holder's own process only: a launch that leaves it out must not
/// hand it to the child.
const HOLDER_ONLY: &str = "AICC_HOLDER_ONLY";

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// Every test here starts processes, one at a time. On Windows a child
/// inherits every inheritable handle in the parent, so a test that starts a
/// holder while another test thread is mid-spawn could carry that thread's
/// pipe ends into the holder, and that thread would then wait for the holder
/// to end. Taking this lock first keeps the spawns apart. A test that failed
/// while holding it must not stop the others, so a poisoned lock is reused.
fn one_at_a_time() -> MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("aicc-helper-test-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("a folder");
    dir
}

struct Ran {
    ok: bool,
    stdout: String,
    stderr: String,
}

fn helper(args: &[&str]) -> Ran {
    let out = Command::new(HELPER).args(args).output().expect("run the helper");
    Ran { ok: out.status.success(), stdout: String::from_utf8_lossy(&out.stdout).into_owned(), stderr: String::from_utf8_lossy(&out.stderr).into_owned() }
}

/// Run `hold --detach` with its output going to files, not pipes. The holder
/// outlives this call, so a pipe would stay open until it ends and a reader
/// waiting for end of file would wait with it. Files do not have that problem,
/// and the helper also clears inheritance on its own standard handles.
fn helper_detaching(args: &[&str], tag: &str) -> Ran {
    let base = std::env::temp_dir().join(format!("aicc-helper-detach-{tag}-{}", std::process::id()));
    let out_path = base.with_extension("out");
    let err_path = base.with_extension("err");
    let status = Command::new(HELPER)
        .args(args)
        .env(HOLDER_ONLY, "from-the-holder")
        .stdin(Stdio::null())
        .stdout(fs::File::create(&out_path).expect("a file for stdout"))
        .stderr(fs::File::create(&err_path).expect("a file for stderr"))
        .status()
        .expect("run the helper");
    let ran = Ran {
        ok: status.success(),
        stdout: fs::read_to_string(&out_path).unwrap_or_default(),
        stderr: fs::read_to_string(&err_path).unwrap_or_default(),
    };
    let _ = fs::remove_file(&out_path);
    let _ = fs::remove_file(&err_path);
    ran
}

fn as_json(ran: &Ran) -> Value {
    json::parse(ran.stdout.trim().as_bytes()).unwrap_or_else(|e| panic!("stdout is not JSON ({e:?}): {:?} / stderr {:?}", ran.stdout, ran.stderr))
}

fn field<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or_else(|| panic!("missing {key} in {}", v.to_json()))
}

fn t_of(v: &Value) -> &str {
    v.get("t").and_then(Value::as_str).unwrap_or("")
}

/// Start a detached holder; the record it printed.
fn hold(store_dir: &Path, sid: &str, away: u64) -> Record {
    let store_arg = store_dir.to_string_lossy().into_owned();
    let away_arg = away.to_string();
    let ran = helper_detaching(&["hold", "--detach", "--store", &store_arg, "--session", sid, "--label", "Test terminal", "--away", &away_arg], sid);
    assert!(ran.ok, "hold --detach failed: {} / {}", ran.stdout, ran.stderr);
    Record::from_value(&as_json(&ran)).unwrap_or_else(|e| panic!("hold printed a record that does not read ({e}): {}", ran.stdout))
}

fn list(store_dir: &Path) -> Listing {
    let ran = helper(&["list", "--store", &store_dir.to_string_lossy()]);
    assert!(ran.ok, "list failed: {}", ran.stderr);
    Listing::from_value(&as_json(&ran)).unwrap_or_else(|e| panic!("list printed a listing that does not read ({e}): {}", ran.stdout))
}

fn gone(pid: u32, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if !pids::alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    !pids::alive(pid)
}

fn msg(t: &str, id: u64, more: Vec<(&str, Value)>) -> Value {
    let mut members = vec![("t", Value::str(t)), ("id", Value::uint(id))];
    members.extend(more);
    Value::obj(members)
}

/// What a launch hands the child: this test's environment (as much of it as
/// a launch allows), plus one variable of its own.
fn launch_env() -> Vec<(String, String)> {
    let mut seen: Vec<String> = Vec::new();
    let mut env: Vec<(String, String)> = Vec::new();
    for (k, v) in std::env::vars() {
        let folded = k.to_uppercase();
        if k.is_empty() || k.contains('=') || k.chars().count() > 255 || v.chars().count() > 32767 || seen.contains(&folded) || folded == HOLDER_ONLY {
            continue;
        }
        seen.push(folded);
        env.push((k, v));
    }
    env.truncate(1000);
    env.push(("AICC_LAUNCH_VALUE".to_string(), "from-the-launch".to_string()));
    env
}

fn launch_msg(id: u64, program: &str, cwd: &Path) -> Value {
    let env = launch_env();
    msg(
        "term.launch",
        id,
        vec![
            ("argv", Value::strs(&[program])),
            ("cwd", Value::Str(cwd.to_string_lossy().into_owned())),
            ("env", Value::Obj(env.into_iter().map(|(k, v)| (k, Value::Str(v))).collect())),
            ("cols", Value::uint(250)),
            ("rows", Value::uint(24)),
        ],
    )
}

/// One connection to a holder, as the app holds it: what the terminal sent
/// on channel 1, and control messages not yet looked at.
struct App {
    client: Client,
    screen: Vec<u8>,
    events: Vec<Value>,
    next_id: u64,
}

impl App {
    /// Connect and read the hello; `ack` answers it with `core` and `local`.
    fn connect(rec: &Record, ack: bool) -> App {
        let mut client = Client::to_record(rec, WAIT).expect("connect to the holder and read its hello");
        if ack {
            client.ack().expect("ack the hello");
        }
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

    fn events_text(&self) -> Vec<String> {
        self.events.iter().map(Value::to_json).collect()
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
                panic!("no {what}; screen {:?}; messages {:?}", self.text(), self.events_text());
            }
        }
    }

    /// Send `v` and wait for the message that answers its id.
    fn call(&mut self, v: Value) -> Value {
        let id = v.get("id").and_then(Value::as_u64).expect("a request id");
        self.client.send(v.clone()).expect("send a request");
        self.wait_message(&format!("answer to {}", v.get("t").map(Value::to_json).unwrap_or_default()), |e| e.get("re").and_then(Value::as_u64) == Some(id))
    }

    /// Wait for a message of type `t`.
    fn event(&mut self, t: &str) -> Value {
        self.wait_message(t, |e| t_of(e) == t)
    }

    /// Wait for an `error` with this code.
    fn error(&mut self, code: &str) -> Value {
        self.wait_message(&format!("{code} error"), |e| t_of(e) == "error" && e.get("code").and_then(Value::as_str) == Some(code))
    }

    fn wait_text(&mut self, needle: &str) {
        let until = Instant::now() + WAIT;
        while !self.text().contains(needle) {
            if !self.pump(until) {
                panic!("{needle:?} never appeared on the terminal: {:?}", self.text());
            }
        }
    }

    fn type_line(&mut self, line: &str) {
        self.client.send_raw(1, format!("{line}\r").as_bytes()).expect("type into the terminal");
    }

    /// True once the holder has closed this connection.
    fn closed(&mut self) -> bool {
        let until = Instant::now() + WAIT;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            match self.client.recv(left) {
                Ok(Some(Frame { body: Body::Json(v), .. })) => self.events.push(v),
                Ok(Some(_)) => {}
                Ok(None) => return true,
                Err(e) if transport::is_timeout(&e) => return false,
                Err(_) => return true,
            }
        }
    }
}

fn expect_t(v: &Value, t: &str) {
    assert_eq!(t_of(v), t, "expected {t}, got {}", v.to_json());
}

fn expect_error(v: &Value, code: &str) {
    assert_eq!(t_of(v), "error", "expected an error, got {}", v.to_json());
    assert_eq!(v.get("code").and_then(Value::as_str), Some(code), "{}", v.to_json());
}

fn read_record(store_dir: &Path, sid: &str) -> Record {
    store::read(store_dir, sid).expect("the record is there").expect("the record reads")
}

/// Wait until the record shows what `check` looks for.
fn record_becomes(store_dir: &Path, sid: &str, what: &str, check: impl Fn(&Record) -> bool) {
    let deadline = Instant::now() + WAIT;
    loop {
        let late = Instant::now() >= deadline;
        match store::read(store_dir, sid) {
            Some(Ok(rec)) if check(&rec) => return,
            other if late => panic!("the record of {sid} never showed {what}: {other:?}"),
            _ => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// End a holder from a fresh connection, and wait for it to be gone.
fn end(rec: &Record) {
    let mut app = App::connect(rec, true);
    let id = app.id();
    expect_t(&app.call(msg("term.end", id, vec![])), "term.ended");
    assert!(gone(rec.pid, WAIT), "the holder outlived term.end");
}

/// Have the fake CLI start a sleeping copy of itself; its process id.
fn grandchild_pid(app: &mut App) -> u32 {
    app.type_line("spawn-grandchild");
    app.wait_text("grandchild: ");
    let until = Instant::now() + WAIT;
    loop {
        let all = app.text();
        let at = all.find("grandchild: ").expect("the line") + "grandchild: ".len();
        let digits: String = all[at..].chars().take_while(char::is_ascii_digit).collect();
        // The id is whole once something other than a digit follows it.
        let whole = all[at + digits.len()..].chars().next().is_some();
        if !digits.is_empty() && whole {
            let pid: u32 = digits.parse().expect("a process id");
            assert!(pids::alive(pid), "the grandchild is not running");
            return pid;
        }
        if !app.pump(until) {
            panic!("no whole process id after grandchild: {all:?}");
        }
    }
}

#[test]
fn a_detached_holder_is_listed_launched_attached_again_and_ended() {
    let _serial = one_at_a_time();
    let store_dir = temp_dir("store-main");
    let work = temp_dir("work-main");
    let work_name = work.file_name().unwrap().to_string_lossy().into_owned();
    let sid = "probe-0001";
    let rec = hold(&store_dir, sid, 60);
    assert_eq!(rec.session, sid);
    assert_eq!(rec.label, "Test terminal");
    assert_eq!(rec.child, "waiting");
    assert_eq!(rec.away, 60);
    assert!(!rec.attached);
    assert!(transport::valid_endpoint(&rec.endpoint, sid), "endpoint {:?}", rec.endpoint);
    assert!(pids::alive(rec.pid), "hold --detach returned, and its holder is not running");

    // List mode finds it, as start-up and the Machines page will.
    let listed = list(&store_dir);
    assert_eq!(listed.sessions, vec![read_record(&store_dir, sid)]);
    assert_eq!((listed.removed, listed.skipped), (0, 0));

    let mut first = App::connect(&rec, true);
    assert_eq!(first.client.hello.state, "new");
    assert_eq!(first.client.hello.caps, vec!["core".to_string(), "local".to_string()]);
    let id = first.id();
    expect_t(&first.call(msg("ping", id, vec![])), "pong");
    let id = first.id();
    expect_error(&first.call(msg("term.attach", id, vec![("from", Value::uint(0))])), "not-found");

    // Launch: its folder and its whole environment, nothing of the holder's own.
    let id = first.id();
    let launched = first.call(launch_msg(id, FAKE, &work));
    expect_t(&launched, "term.launched");
    let child = field(&launched, "pid").as_u64().expect("pid") as u32;
    assert!(pids::alive(child));
    let id = first.id();
    expect_error(&first.call(launch_msg(id, FAKE, &work)), "busy");
    record_becomes(&store_dir, sid, "child running", |r| r.child == "running");

    let id = first.id();
    let attached = first.call(msg("term.attach", id, vec![("from", Value::uint(0))]));
    expect_t(&attached, "term.attached");
    assert_eq!(field(&attached, "from").as_u64(), Some(0));
    assert_eq!(field(&attached, "running").as_bool(), Some(true));
    assert_eq!(field(&attached, "truncated").as_bool(), Some(false));
    assert!(attached.get("code").is_none(), "a running session has no exit code: {}", attached.to_json());
    first.wait_text("FAKE-CLI READY");
    record_becomes(&store_dir, sid, "attached", |r| r.attached);
    first.type_line("pwd");
    first.wait_text(&work_name);
    first.type_line("env AICC_LAUNCH_VALUE");
    first.wait_text("env AICC_LAUNCH_VALUE=from-the-launch");
    first.type_line(&format!("env {HOLDER_ONLY}"));
    first.wait_text(&format!("env {HOLDER_ONLY} unset"));
    let id = first.id();
    expect_t(&first.call(msg("term.resize", id, vec![("cols", Value::uint(120)), ("rows", Value::uint(40))])), "term.resized");
    let grandchild = grandchild_pid(&mut first);
    let seen = first.screen.len() as u64;

    // A second connection (the app after a restart) attaches from the offset
    // the first one reached: the first is told it was replaced, and closed.
    let mut second = App::connect(&rec, true);
    assert_eq!(second.client.hello.state, "live");
    let id = second.id();
    let again = second.call(msg("term.attach", id, vec![("from", Value::uint(seen))]));
    expect_t(&again, "term.attached");
    assert_eq!(field(&again, "from").as_u64(), Some(seen));
    first.error("replaced");
    assert!(first.closed(), "the replaced connection stayed open");
    second.type_line("second-line");
    second.wait_text("echo: second-line");
    assert!(!second.text().contains("FAKE-CLI READY"), "output before the offset was replayed: {:?}", second.text());
    let id = second.id();
    expect_t(&second.call(msg("term.detach", id, vec![])), "term.detached");
    assert!(second.closed(), "the holder kept a detached connection open");
    record_becomes(&store_dir, sid, "detached", |r| !r.attached);
    assert!(pids::alive(child), "detaching ended the session");

    // A third attaches from 0 and is replayed everything.
    let mut third = App::connect(&rec, true);
    let id = third.id();
    expect_t(&third.call(msg("term.attach", id, vec![("from", Value::uint(0))])), "term.attached");
    third.wait_text("echo: second-line");
    assert!(third.text().contains("FAKE-CLI READY"));
    let id = third.id();
    expect_error(&third.call(msg("term.attach", id, vec![("from", Value::uint(999_999_999))])), "bad-field");

    // Ending ends the whole tree, the holder, its record and its endpoint.
    let id = third.id();
    expect_t(&third.call(msg("term.end", id, vec![])), "term.ended");
    assert!(gone(rec.pid, WAIT), "the holder outlived term.end");
    assert!(gone(child, WAIT), "the program outlived term.end");
    assert!(gone(grandchild, WAIT), "the program's own child outlived term.end");
    assert!(store::read(&store_dir, sid).is_none(), "the record outlived the holder");
    #[cfg(unix)]
    assert!(!Path::new(&rec.endpoint).exists(), "the socket outlived the holder");
    assert!(list(&store_dir).sessions.is_empty());
    let _ = fs::remove_dir_all(&store_dir);
    let _ = fs::remove_dir_all(&work);
}

#[test]
fn when_the_program_exits_the_app_is_told_and_a_later_attach_sees_the_end() {
    let _serial = one_at_a_time();
    let store_dir = temp_dir("store-exit");
    let work = temp_dir("work-exit");
    let sid = "probe-0002";
    let rec = hold(&store_dir, sid, 60);
    let mut app = App::connect(&rec, true);
    let id = app.id();
    expect_t(&app.call(launch_msg(id, FAKE, &work)), "term.launched");
    let id = app.id();
    expect_t(&app.call(msg("term.attach", id, vec![("from", Value::uint(0))])), "term.attached");
    app.wait_text("FAKE-CLI READY");
    app.type_line("last-words");
    app.wait_text("echo: last-words");
    app.type_line("exit 3");
    let exit = app.event("term.exit");
    assert_eq!(field(&exit, "code").as_i64(), Some(3));
    record_becomes(&store_dir, sid, "the exit code", |r| r.child == "exited" && r.code == Some(3));
    drop(app);
    assert!(pids::alive(rec.pid), "the holder must wait for the app after its program exits");

    let mut later = App::connect(&rec, true);
    let id = later.id();
    let attached = later.call(msg("term.attach", id, vec![("from", Value::uint(0))]));
    expect_t(&attached, "term.attached");
    assert_eq!(field(&attached, "running").as_bool(), Some(false));
    assert_eq!(field(&attached, "code").as_i64(), Some(3));
    later.wait_text("echo: last-words");
    let id = later.id();
    let ended = later.call(msg("term.end", id, vec![]));
    expect_t(&ended, "term.ended");
    assert_eq!(field(&ended, "code").as_i64(), Some(3));
    assert!(gone(rec.pid, WAIT), "the holder outlived term.end");
    let _ = fs::remove_dir_all(&store_dir);
    let _ = fs::remove_dir_all(&work);
}

#[test]
fn the_away_clock_ends_a_session_nobody_is_attached_to() {
    let _serial = one_at_a_time();
    let store_dir = temp_dir("store-away");
    let work = temp_dir("work-away");
    // A holder nobody ever connects to.
    let idle = hold(&store_dir, "probe-0003", 1);
    assert!(gone(idle.pid, WAIT), "an idle holder outlived its away clock");
    assert!(store::read(&store_dir, "probe-0003").is_none(), "the idle holder left its record");

    // A session whose app went away without a word.
    let rec = hold(&store_dir, "probe-0004", 2);
    let mut app = App::connect(&rec, true);
    let id = app.id();
    let launched = app.call(launch_msg(id, FAKE, &work));
    expect_t(&launched, "term.launched");
    let child = field(&launched, "pid").as_u64().expect("pid") as u32;
    let id = app.id();
    expect_t(&app.call(msg("term.attach", id, vec![("from", Value::uint(0))])), "term.attached");
    app.wait_text("FAKE-CLI READY");
    let grandchild = grandchild_pid(&mut app);
    // While an app is attached the clock does not run.
    std::thread::sleep(Duration::from_secs(4));
    assert!(pids::alive(rec.pid), "the away clock ran while an app was attached");
    drop(app);
    assert!(gone(rec.pid, WAIT), "the holder outlived its away clock");
    assert!(gone(child, WAIT), "the program outlived the away clock");
    assert!(gone(grandchild, WAIT), "the program's own child outlived the away clock");
    assert!(store::read(&store_dir, "probe-0004").is_none(), "the holder left its record");
    let _ = fs::remove_dir_all(&store_dir);
    let _ = fs::remove_dir_all(&work);
}

#[test]
fn list_removes_records_whose_holder_is_gone_and_skips_unreadable_ones() {
    let _serial = one_at_a_time();
    let store_dir = temp_dir("store-list");
    store::prepare(&store_dir).expect("prepare the store");
    // A process id that has just ended.
    let mut done = Command::new(FAKE).args(["--sleep", "0"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("start");
    let dead_pid = done.id();
    done.wait().expect("wait");
    let random = "a".repeat(transport::ENDPOINT_RANDOM_HEX);
    let record = |sid: &str, pid: u32| Record {
        session: sid.to_string(),
        label: String::new(),
        pid,
        endpoint: transport::endpoint_name(sid, &random),
        nonce: NONCE.to_string(),
        helper: aicc_helper::VERSION.to_string(),
        started: store::now_ms(),
        away: 120,
        attached: false,
        child: "running".to_string(),
        code: None,
    };
    // Its holder's process is gone.
    store::write(&store_dir, &record("stale-dead-pid", dead_pid)).expect("write");
    // Its process id runs (this test), but nothing listens on its endpoint.
    store::write(&store_dir, &record("stale-no-endpoint", std::process::id())).expect("write");
    // Not a version 1 record.
    fs::write(store::record_path(&store_dir, "not-a-record-01"), b"{\"v\":9}").expect("write");
    let listed = list(&store_dir);
    assert!(listed.sessions.is_empty(), "{:?}", listed.sessions);
    assert_eq!(listed.removed, 2);
    assert_eq!(listed.skipped, 1);
    assert!(store::read(&store_dir, "stale-dead-pid").is_none());
    assert!(store::read(&store_dir, "stale-no-endpoint").is_none());
    assert!(store::record_path(&store_dir, "not-a-record-01").exists(), "list must leave a file it cannot read alone");
    // A store that is not there lists nothing, and is not made.
    let missing = store_dir.join("missing");
    assert!(list(&missing).sessions.is_empty());
    assert!(!missing.exists(), "list made the store");
    let _ = fs::remove_dir_all(&store_dir);
}

#[test]
fn a_second_holder_for_a_live_session_is_refused() {
    let _serial = one_at_a_time();
    let store_dir = temp_dir("store-twice");
    let rec = hold(&store_dir, "probe-0005", 30);
    let store_arg = store_dir.to_string_lossy().into_owned();
    let twice = helper_detaching(&["hold", "--detach", "--store", &store_arg, "--session", "probe-0005"], "twice");
    assert!(!twice.ok, "a second holder started for a live session: {}", twice.stdout);
    assert_eq!(read_record(&store_dir, "probe-0005").pid, rec.pid, "the second holder replaced the live one's record");
    end(&rec);
    let _ = fs::remove_dir_all(&store_dir);
}

#[test]
fn the_holder_refuses_what_the_protocol_refuses() {
    let _serial = one_at_a_time();
    let store_dir = temp_dir("store-refuse");
    let rec = hold(&store_dir, "probe-0006", 30);

    // The first frame must be the ack.
    let mut early = App::connect(&rec, false);
    early.client.send(msg("ping", 2, vec![])).expect("send");
    early.error("unknown-type");
    assert!(early.closed());

    // An ack of a capability the holder did not offer.
    let mut greedy = App::connect(&rec, false);
    greedy.client.send(aicc_helper::hello::ack_message(1, &["core", "files"])).expect("send");
    greedy.error("bad-field");
    assert!(greedy.closed());

    // An unknown type closes the connection.
    let mut app = App::connect(&rec, true);
    app.client.send(msg("term.bogus", 2, vec![])).expect("send");
    app.error("unknown-type");
    assert!(app.closed());

    // A bad field is answered and the connection stays.
    let mut app = App::connect(&rec, true);
    let id = app.id();
    expect_error(&app.call(launch_msg(id, "aicc-fake-cli", &store_dir)), "bad-field");
    let id = app.id();
    expect_t(&app.call(msg("ping", id, vec![])), "pong");
    let id = app.id();
    expect_error(&app.call(msg("term.resize", id, vec![("cols", Value::uint(80)), ("rows", Value::uint(24))])), "not-connected");
    let id = app.id();
    expect_error(&app.call(msg("term.detach", id, vec![])), "not-connected");
    // Terminal bytes with no terminal attached close the connection.
    app.client.send_raw(1, b"typed\r").expect("send");
    app.error("bad-frame");
    assert!(app.closed());

    // Sixteen connections at once; the seventeenth is told busy, and closed.
    let held: Vec<App> = (0..16).map(|_| App::connect(&rec, false)).collect();
    let mut extra = App::connect(&rec, false);
    extra.error("busy");
    assert!(extra.closed());
    drop(held);
    std::thread::sleep(Duration::from_secs(1));
    end(&rec);
    let _ = fs::remove_dir_all(&store_dir);
}

/// Lines the fake CLI floods the terminal with: more than the connection
/// itself buffers on each OS (a Linux socket takes about 200 KB, a macOS one
/// about 16 KB, the pipe 64 KiB), so with the app not reading for a moment
/// output queues up in the holder for the attach, and fewer than would fill
/// that queue.
#[cfg(target_os = "linux")]
const FLOOD_LINES: u32 = 24_000;
#[cfg(target_vendor = "apple")]
const FLOOD_LINES: u32 = 5_000;
#[cfg(windows)]
const FLOOD_LINES: u32 = 10_000;

#[test]
fn attaching_again_on_the_same_connection_carries_the_new_attach_only() {
    let _serial = one_at_a_time();
    let store_dir = temp_dir("store-again");
    let work = temp_dir("work-again");
    let rec = hold(&store_dir, "probe-0007", 60);
    let mut app = App::connect(&rec, true);
    let id = app.id();
    expect_t(&app.call(launch_msg(id, FAKE, &work)), "term.launched");
    let id = app.id();
    expect_t(&app.call(msg("term.attach", id, vec![("from", Value::uint(0))])), "term.attached");
    app.wait_text("FAKE-CLI READY");
    app.type_line(&format!("flood {FLOOD_LINES}"));
    // Not reading for a moment: the connection fills, the rest queues.
    std::thread::sleep(Duration::from_millis(800));
    let again = app.id();
    app.client.send(msg("term.attach", again, vec![("from", Value::uint(0))])).expect("attach again");
    // Everything after the second reply belongs to the second attach: the
    // output from 0, in order, with nothing the first attach had queued.
    let until = Instant::now() + WAIT;
    let mut after: Option<Vec<u8>> = None;
    loop {
        if after.as_ref().map_or(false, |a| String::from_utf8_lossy(a).contains("flood done")) {
            break;
        }
        let left = until.saturating_duration_since(Instant::now());
        assert!(!left.is_zero(), "the flood never finished after the second attach");
        match app.client.recv(left) {
            Ok(Some(Frame { channel: 1, body: Body::Raw(bytes) })) => {
                if let Some(a) = after.as_mut() {
                    a.extend_from_slice(&bytes);
                }
            }
            Ok(Some(Frame { channel: 0, body: Body::Json(v) })) if v.get("re").and_then(Value::as_u64) == Some(again) => {
                expect_t(&v, "term.attached");
                assert_eq!(field(&v, "from").as_u64(), Some(0));
                after = Some(Vec::new());
            }
            other => panic!("not the flood or the second reply: {other:?}"),
        }
    }
    let after = after.expect("the second reply");
    // A fresh connection's replay from 0 is the output itself.
    let mut check = App::connect(&rec, true);
    let id = check.id();
    let attached = check.call(msg("term.attach", id, vec![("from", Value::uint(0))]));
    expect_t(&attached, "term.attached");
    assert_eq!(field(&attached, "truncated").as_bool(), Some(false), "the ring did not hold the flood");
    let ring_end = field(&attached, "ring_end").as_u64().expect("ring_end") as usize;
    let until = Instant::now() + WAIT;
    while check.screen.len() < ring_end {
        assert!(check.pump(until), "the replay never came whole");
    }
    let output = &check.screen[..ring_end];
    if !output.starts_with(&after) {
        let at = output.iter().zip(&after).position(|(a, b)| a != b).unwrap_or(output.len().min(after.len()));
        panic!(
            "after the second reply the stream is not the output from 0: it differs at byte {at} of {} (output {} bytes): {:?}",
            after.len(),
            output.len(),
            String::from_utf8_lossy(&after[at.saturating_sub(40)..(at + 40).min(after.len())])
        );
    }
    drop(app);
    drop(check);
    end(&rec);
    let _ = fs::remove_dir_all(&store_dir);
    let _ = fs::remove_dir_all(&work);
}

#[test]
fn of_two_holders_started_at_once_for_one_session_exactly_one_runs() {
    let _serial = one_at_a_time();
    let store_dir = temp_dir("store-race");
    let store_arg = store_dir.to_string_lossy().into_owned();
    let starts: Vec<_> = (0..2)
        .map(|i| {
            let store_arg = store_arg.clone();
            std::thread::spawn(move || {
                helper_detaching(&["hold", "--detach", "--store", &store_arg, "--session", "probe-0008", "--away", "30"], &format!("race{i}"))
            })
        })
        .collect();
    let ran: Vec<Ran> = starts.into_iter().map(|t| t.join().expect("a start")).collect();
    let told: Vec<(bool, &str, &str)> = ran.iter().map(|r| (r.ok, r.stdout.as_str(), r.stderr.as_str())).collect();
    let won: Vec<&Ran> = ran.iter().filter(|r| r.ok).collect();
    assert_eq!(won.len(), 1, "both or neither started: {told:?}");
    let rec = Record::from_value(&as_json(won[0])).unwrap_or_else(|e| panic!("the winner printed a record that does not read ({e}): {told:?}"));
    let listed = list(&store_dir);
    assert_eq!(listed.sessions.len(), 1, "{:?}", listed.sessions);
    assert_eq!(listed.sessions[0].pid, rec.pid, "the record is not the running holder's");
    end(&rec);
    let _ = fs::remove_dir_all(&store_dir);
}

#[test]
fn a_frame_sent_a_byte_at_a_time_must_still_come_whole_in_time() {
    let _serial = one_at_a_time();
    let store_dir = temp_dir("store-slow");
    let rec = hold(&store_dir, "probe-0009", 60);
    let mut app = App::connect(&rec, false);
    let started = Instant::now();
    // A whole ack, a byte every 2 seconds: each read is quick, the frame is not.
    let ack = frame::encode(&Frame::json(0, aicc_helper::hello::ack_message(1, &["core", "local"])), Direction::AppToHelper).expect("encode");
    let mut told: Option<Value> = None;
    for byte in &ack {
        if started.elapsed() > Duration::from_secs(20) {
            break;
        }
        let _ = app.client.send_bytes(&[*byte]);
        match app.client.recv(Duration::from_secs(2)) {
            Ok(Some(Frame { body: Body::Json(v), .. })) => {
                told = Some(v);
                break;
            }
            Ok(None) => break,
            _ => {}
        }
    }
    let told = told.unwrap_or_else(|| panic!("no timeout after {:?} of a frame a byte at a time", started.elapsed()));
    expect_error(&told, "timeout");
    assert!(started.elapsed() < Duration::from_secs(16), "the 10 second limit stretched to {:?}", started.elapsed());
    assert!(app.closed());
    end(&rec);
    let _ = fs::remove_dir_all(&store_dir);
}

#[test]
fn selftest_passes_and_prints_one_result_line() {
    let _serial = one_at_a_time();
    let ran = helper(&["selftest", "--nonce", NONCE]);
    assert!(ran.ok, "selftest failed: {} / {}", ran.stdout, ran.stderr);
    let line = ran.stdout.trim();
    let prefix = format!("AICC-RESULT {NONCE} ");
    assert!(line.starts_with(&prefix), "{line:?}");
    let body = json::parse(line[prefix.len()..].as_bytes()).expect("the result is JSON");
    assert_eq!(field(&body, "ok").as_bool(), Some(true));
    let checks = field(&body, "checks").as_array().expect("checks");
    let names: Vec<&str> = checks.iter().map(|c| field(c, "name").as_str().expect("name")).collect();
    assert_eq!(names, vec!["frame-codec", "hello", "ring", "terminal-hold-attach", "local-transport"]);
}

#[test]
fn hello_prints_a_line_the_parser_accepts() {
    let _serial = one_at_a_time();
    let ran = helper(&["hello", "--nonce", NONCE, "--session", "sess-0001", "--state", "new"]);
    assert!(ran.ok, "{}", ran.stderr);
    let parsed = aicc_helper::hello::parse_hello_line(ran.stdout.trim(), NONCE, "sess-0001").expect("the hello reads");
    assert_eq!(parsed.proto, vec![1]);
    assert_eq!(parsed.state, "new");
    let bad = helper(&["hello", "--nonce", "short", "--session", "sess-0001"]);
    assert!(!bad.ok);
}

#[test]
fn the_command_line_refuses_what_it_does_not_know() {
    let _serial = one_at_a_time();
    let cases: [&[&str]; 11] = [
        &["hold", "--store"],
        &["hold", "--session", "probe-0007"],
        &["hold", "--store", "x", "--session", "bad id"],
        &["hold", "--store", "x", "--session", "probe-0007", "--away", "0"],
        &["hold", "--store", "x", "--session", "probe-0007", "--away", "86401"],
        &["hold", "--store", "x", "--session", "probe-0007", "--ring-bytes", "10"],
        &["hold", "--store", "x", "--session", "probe-0007", "--store", "y"],
        &["hold", "--store", "x", "--session", "probe-0007", "--what"],
        &["list"],
        // The file transport's commands are gone.
        &["attach", "--dir", "x"],
        &["end", "--dir", "x"],
    ];
    for args in cases {
        let ran = helper(args);
        assert!(!ran.ok, "{args:?} was accepted");
        assert!(!Path::new("x").exists(), "{args:?} made a store");
    }
}
