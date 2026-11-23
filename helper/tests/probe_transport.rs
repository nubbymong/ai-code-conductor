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
use std::io::{PipeReader, PipeWriter, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex, MutexGuard};
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
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn helper(args: &[&str]) -> Ran {
    let out = Command::new(HELPER).args(args).output().expect("run the helper");
    Ran {
        ok: out.status.success(),
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

/// Run `hold --detach` with its output going to files, not pipes. The holder
/// outlives this call, so a pipe would stay open until it ends and a reader
/// waiting for end of file would wait with it. Files do not have that problem,
/// and the holder also keeps none of its starter's handles (see
/// `a_detached_holder_keeps_none_of_its_starters_handles`).
fn helper_detaching(args: &[&str], tag: &str) -> Ran {
    helper_detaching_from(Path::new(HELPER), args, tag)
}

/// `helper_detaching` with a copy of the helper at `program`.
fn helper_detaching_from(program: &Path, args: &[&str], tag: &str) -> Ran {
    let base = std::env::temp_dir().join(format!("aicc-helper-detach-{tag}-{}", std::process::id()));
    let out_path = base.with_extension("out");
    let err_path = base.with_extension("err");
    let status = Command::new(program)
        .args(args)
        .env(HOLDER_ONLY, "from-the-holder")
        .stdin(Stdio::null())
        .stdout(fs::File::create(&out_path).expect("a file for stdout"))
        .stderr(fs::File::create(&err_path).expect("a file for stderr"))
        .status()
        .expect("run the helper");
    let ran = Ran {
        ok: status.success(),
        code: status.code(),
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
    hold_from(Path::new(HELPER), store_dir, sid, away)
}

/// `hold` with a copy of the helper at `program`: the holder runs from it.
fn hold_from(program: &Path, store_dir: &Path, sid: &str, away: u64) -> Record {
    let store_arg = store_dir.to_string_lossy().into_owned();
    let away_arg = away.to_string();
    let ran = helper_detaching_from(program, &["hold", "--detach", "--store", &store_arg, "--session", sid, "--label", "Test terminal", "--away", &away_arg], sid);
    assert!(ran.ok, "hold --detach failed: {} / {}", ran.stdout, ran.stderr);
    let rec = record_of(&ran);
    // Which way `hold --detach` started the holder (`detach.rs`): out of this
    // process's job, or, where the job forbids that, inside it with a note on
    // stderr. The note must say where the holder is, and a test process in no
    // job starts it the first way.
    #[cfg(windows)]
    {
        let inside = win::in_a_job(rec.pid);
        let noted = ran.stderr.contains(IN_JOB_NOTE);
        if inside != noted || (inside && !win::this_process_in_a_job()) {
            end_quietly(&rec);
            panic!("the holder (process {}) is {}in a job, and hold --detach said: {:?}", rec.pid, if inside { "" } else { "not " }, ran.stderr);
        }
    }
    rec
}

/// The record `hold --detach` printed.
fn record_of(ran: &Ran) -> Record {
    Record::from_value(&as_json(ran)).unwrap_or_else(|e| panic!("hold printed a record that does not read ({e}): {} / {}", ran.stdout, ran.stderr))
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
    launch_msg_with(id, program, cwd, launch_env())
}

fn launch_msg_with(id: u64, program: &str, cwd: &Path, env: Vec<(String, String)>) -> Value {
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
    assert_eq!(first.client.hello.caps, vec!["core".to_string(), "local".to_string(), "hooks".to_string(), "mcp".to_string(), "away".to_string(), "screen".to_string(), "title".to_string()]);
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
    // A second launch is busy. It is kept small: once a session is launched
    // a frame's JSON is at most 64 KiB, and this test's environment may be more.
    let id = first.id();
    expect_error(&first.call(launch_msg_with(id, FAKE, &work, vec![("A".to_string(), "b".to_string())])), "busy");
    record_becomes(&store_dir, sid, "child running", |r| r.child == "running");
    // Over 64 KiB of JSON once the session is launched: refused on its
    // length alone, and the connection closed; the session goes on. Only the
    // length and the head are sent: a holder that refuses a frame does not
    // read the rest, and a small socket buffer (macOS) would hold up a write
    // of all of it.
    let mut big = App::connect(&rec, true);
    let id = big.id();
    let whole = frame::encode(&Frame::json(0, msg("ping", id, vec![("pad", Value::Str("x".repeat(70_000)))])), Direction::AppToHelper).expect("encode");
    assert!(whole.len() > 70_000);
    big.client.send_bytes(&whole[..9]).expect("send");
    big.error("bad-frame");
    assert!(big.closed(), "a frame over the limit left its connection open");

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
    // It comes from a connection that is not attached: the attached one is
    // told the program's end, and closed.
    let mut fourth = App::connect(&rec, true);
    let id = fourth.id();
    let ended = fourth.call(msg("term.end", id, vec![]));
    expect_t(&ended, "term.ended");
    let exit = third.event("term.exit");
    assert_eq!(exit.get("code").map(Value::to_json), ended.get("code").map(Value::to_json), "term.exit and term.ended differ: {} / {}", exit.to_json(), ended.to_json());
    assert!(exit.get("code").is_some(), "the end of a launched session has an exit code: {}", ended.to_json());
    assert!(third.closed(), "the attached connection stayed open after the end");
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
    assert_eq!(twice.code, Some(3), "hold --detach for a live session: {}", twice.stderr);
    assert!(twice.stderr.contains("already running"), "the holder's own reason was not passed on: {}", twice.stderr);
    // Without --detach the same.
    let plain = helper(&["hold", "--store", &store_arg, "--session", "probe-0005"]);
    assert_eq!(plain.code, Some(3), "hold for a live session: {}", plain.stderr);
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

/// Let the children this test starts inherit `end`, the way every handle the
/// app lets a child inherit reaches the `hold --detach` it starts.
#[cfg(windows)]
fn inheritable(end: PipeWriter) -> PipeWriter {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
    let ok = unsafe { SetHandleInformation(end.as_raw_handle() as HANDLE, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) };
    assert_ne!(ok, 0, "make the pipe end inheritable: {}", std::io::Error::last_os_error());
    end
}

#[cfg(unix)]
fn inheritable(end: PipeWriter) -> PipeWriter {
    use std::os::fd::AsRawFd;
    // Clear close-on-exec, which std sets on every descriptor it makes.
    let ok = unsafe { libc::fcntl(end.as_raw_fd(), libc::F_SETFD, 0) };
    assert_eq!(ok, 0, "make the pipe end inheritable: {}", std::io::Error::last_os_error());
    end
}

/// Read `end` on a thread of its own. The channel gets how the read ended:
/// `Ok(0)` is end of file with nothing read, which comes once every write end
/// of the pipe is closed. Nothing writes to it, so anything else is a fault.
fn end_of_file(mut end: PipeReader) -> mpsc::Receiver<std::io::Result<usize>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut got = Vec::new();
        let _ = tx.send(end.read_to_end(&mut got));
    });
    rx
}

/// A child this test started, ended and waited for when dropped, so a test
/// that fails leaves it running no longer than the test.
struct Running(std::process::Child);

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A test's store folder, removed when dropped.
struct Store(PathBuf);

impl Store {
    fn new(name: &str) -> Store {
        Store(temp_dir(name))
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A holder this test started, ended when dropped if it still runs. Declared
/// after its `Store`, so it is dropped first.
struct Held(Record);

impl Drop for Held {
    fn drop(&mut self) {
        end_quietly(&self.0);
    }
}

/// End a holder that still runs, without a panic: clean-up for a test that
/// may already be failing.
fn end_quietly(rec: &Record) {
    if !pids::alive(rec.pid) {
        return;
    }
    if let Ok(mut client) = Client::to_record(rec, WAIT) {
        if client.ack().is_ok() && client.send(msg("term.end", 2, vec![])).is_ok() {
            let _ = gone(rec.pid, WAIT);
        }
    }
}

/// What became of a pipe end a `hold --detach` was given.
struct Passed {
    /// The control kept the pipe open while it ran, so a handle that was
    /// passed on can be seen.
    control_held: bool,
    /// How reading the pipe ended once only the holder could still hold it;
    /// `None` when it had not ended 2 s later.
    end: Option<std::io::Result<usize>>,
}

impl Passed {
    fn ended(&self) -> Result<(), String> {
        ended_cleanly(&self.end)
    }
}

/// Ok when a read from `end_of_file` came to the end of the pipe with nothing
/// written: every write end is closed. `None` is a read that had not ended.
fn ended_cleanly(end: &Option<std::io::Result<usize>>) -> Result<(), String> {
    match end {
        Some(Ok(0)) => Ok(()),
        Some(Ok(n)) => Err(format!("{n} bytes came down a pipe nothing writes to")),
        Some(Err(e)) => Err(format!("reading the pipe failed: {e}")),
        None => Err("it was still open 2 s after every other end had closed".to_string()),
    }
}

/// Give `start` (a `hold --detach`) an inheritable pipe end, the way every
/// handle the app lets a child inherit reaches it. Then a plain child is
/// given the same end, as the control; this test closes its own end; the
/// control must keep the pipe open, and once the control is gone only the
/// holder could.
fn given_a_pipe<R>(start: impl FnOnce() -> R) -> (R, Passed) {
    let (read_end, write_end) = std::io::pipe().expect("a pipe");
    let write_end = inheritable(write_end);
    let ended = end_of_file(read_end);
    let started = start();
    // Started once `hold --detach` has exited. It is still given the end,
    // because this test holds it until the next line.
    // The control only has to run through the 500 ms wait two lines down; its
    // `Running` guard ends it there, and no other program starts in between.
    // The 20 s is a cap for a control whose guard never ran.
    let control = Running(Command::new(FAKE).args(["--sleep", "20"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("start the fake CLI"));
    drop(write_end);
    let early = ended.recv_timeout(Duration::from_millis(500));
    drop(control);
    let control_held = early.is_err();
    let end = match early {
        Ok(read) => Some(read),
        Err(_) => ended.recv_timeout(Duration::from_secs(2)).ok(),
    };
    (started, Passed { control_held, end })
}

#[test]
fn a_detached_holder_keeps_none_of_its_starters_handles() {
    let _serial = one_at_a_time();
    let store = Store::new("store-handles");
    let (held, passed) = given_a_pipe(|| Held(hold(&store.0, "probe-0010", 60)));
    let pid = held.0.pid;
    assert!(passed.control_held, "the pipe ended while a child that inherited it still ran: this test cannot see a handle that was passed on");
    if let Err(why) = passed.ended() {
        panic!("the holder (process {pid}) kept the pipe its starter was given open: {why}");
    }
    assert!(pids::alive(pid), "the holder (process {pid}) was not running");
    let listed = list(&store.0);
    assert_eq!(listed.sessions.iter().map(|s| s.pid).collect::<Vec<_>>(), vec![pid], "list mode did not show the holder");
}

// ── The Windows launch fields `line` and `conpty` ────────────────────────────

/// cmd.exe by its full path, as the app names it.
#[cfg(windows)]
fn cmd_exe() -> String {
    let root = std::env::var("SystemRoot").expect("SystemRoot is set");
    format!("{root}\\System32\\cmd.exe")
}

/// A launch of `argv` with this test's environment and `more` fields.
#[cfg(windows)]
fn launch_msg_more(id: u64, argv: &[&str], cwd: &Path, more: Vec<(&str, Value)>) -> Value {
    let mut members = vec![
        ("argv", Value::strs(argv)),
        ("cwd", Value::Str(cwd.to_string_lossy().into_owned())),
        ("env", Value::Obj(launch_env().into_iter().map(|(k, v)| (k, Value::Str(v))).collect())),
        ("cols", Value::uint(250)),
        ("rows", Value::uint(24)),
    ];
    members.extend(more);
    msg("term.launch", id, members)
}

/// Hold a session, launch it with `launch`, let its program run to its end,
/// then read all it wrote: its exit code and its screen.
#[cfg(windows)]
fn run_to_the_end(store_dir: &Path, sid: &str, launch: impl FnOnce(u64) -> Value) -> (Option<i64>, String) {
    let held = Held(hold(store_dir, sid, 60));
    let mut app = App::connect(&held.0, true);
    let id = app.id();
    expect_t(&app.call(launch(id)), "term.launched");
    record_becomes(store_dir, sid, "the program's exit", |r| r.child == "exited");
    let id = app.id();
    let attached = app.call(msg("term.attach", id, vec![("from", Value::uint(0))]));
    expect_t(&attached, "term.attached");
    assert_eq!(field(&attached, "running").as_bool(), Some(false));
    // The whole replay comes before the answer to the next request.
    let id = app.id();
    expect_t(&app.call(msg("ping", id, vec![])), "pong");
    (field(&attached, "code").as_i64(), app.text())
}

#[cfg(windows)]
#[test]
fn an_exact_command_line_reaches_cmd_as_given_and_the_same_words_as_an_argument_list_do_not() {
    let _serial = one_at_a_time();
    let store = Store::new("store-line");
    // A .cmd file in a folder with a space in its name, as npm can put
    // its .cmd launchers under a user folder with a space in it.
    let work = Store::new("work line");
    let script = work.0.join("say words.cmd");
    fs::write(&script, "@echo off\r\necho words:[%~1][%~2]\r\n").expect("write the .cmd file");
    let cmd = cmd_exe();
    let inner = format!("\"{}\" alpha \"two words\"", script.display());
    // The line the app hands node-pty for an npm .cmd launcher today:
    // cmd.exe in its /s form, which strips exactly the outer pair of quotes.
    let line = format!("{cmd} /d /s /c \"{inner}\"");
    let (code, screen) = run_to_the_end(&store.0, "probe-0020", |id| launch_msg_more(id, &[&cmd], &work.0, vec![("line", Value::Str(line))]));
    assert!(screen.contains("words:[alpha][two words]"), "the .cmd file did not get its words as given: {screen:?}");
    assert_eq!(code, Some(0), "{screen:?}");
    // The same words as an argument list are quoted for CommandLineToArgvW,
    // which is not how cmd.exe reads its line: it is mangled.
    let (code, screen) = run_to_the_end(&store.0, "probe-0021", |id| launch_msg_more(id, &[&cmd, "/d", "/s", "/c", &inner], &work.0, vec![]));
    assert!(!screen.contains("words:[alpha][two words]"), "an argument list reached cmd.exe whole, so the line is not what made the difference: {screen:?}");
    assert_ne!(code, Some(0), "{screen:?}");
}

#[cfg(windows)]
#[test]
fn with_an_exact_command_line_the_program_started_is_argv0_never_the_first_word_of_the_line() {
    let _serial = one_at_a_time();
    let store = Store::new("store-argv0");
    let cmd = cmd_exe();
    // The line's first word names a program that does not exist. The holder
    // gives CreateProcessW argv[0] as the program (lpApplicationName), so
    // cmd.exe starts, skips that first word as its own name and runs the
    // rest. Were the program taken from the line, the start would fail (io).
    let line = "C:\\nope\\not-here.exe /d /c echo argv0-ran";
    let (code, screen) = run_to_the_end(&store.0, "probe-0023", |id| launch_msg_more(id, &[&cmd], &store.0, vec![("line", Value::str(line))]));
    assert!(screen.contains("argv0-ran"), "argv[0] did not run the line: {screen:?}");
    assert_eq!(code, Some(0), "{screen:?}");
}

/// A held program gets the Ctrl+C its terminal sends, as one node-pty starts
/// does. `timeout /nobreak` ignores every key: only a Ctrl+C ends it before
/// its 60 seconds, so with Ctrl+C turned off for the holder (its own process
/// group, `hold --detach`) and handed on to the program, no exit comes within
/// the wait.
#[cfg(windows)]
#[test]
fn a_held_program_gets_the_ctrl_c_its_terminal_sends() {
    let _serial = one_at_a_time();
    let store = Store::new("store-ctrlc");
    let work = Store::new("work-ctrlc");
    let root = std::env::var("SystemRoot").expect("SystemRoot is set");
    let timeout = format!("{root}\\System32\\timeout.exe");
    let held = Held(hold(&store.0, "probe-0030", 60));
    let mut app = App::connect(&held.0, true);
    let id = app.id();
    expect_t(&app.call(launch_msg_more(id, &[&timeout, "/t", "60", "/nobreak"], &work.0, vec![])), "term.launched");
    let id = app.id();
    expect_t(&app.call(msg("term.attach", id, vec![("from", Value::uint(0))])), "term.attached");
    // It waits now ("press CTRL+C to quit"): a Ctrl+C before it reads its
    // console would reach no one.
    app.wait_text("CTRL+C");
    let typed = Instant::now();
    app.client.send_raw(1, b"\x03").expect("type Ctrl+C");
    let exit = app.event("term.exit");
    assert!(typed.elapsed() < Duration::from_secs(15), "the program ended {:?} after the Ctrl+C, not at once", typed.elapsed());
    assert_ne!(field(&exit, "code").as_i64(), Some(0), "the program ran its 60 seconds to the end: {}", exit.to_json());
}

/// Remove `path`, a folder or a junction: a junction as a link, never
/// through to the folder it points at. Gone already is fine.
#[cfg(windows)]
fn remove_folder_or_link(path: &Path) {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => fs::remove_dir(path).expect("remove the junction"),
        Ok(_) => fs::remove_dir_all(path).expect("remove the folder"),
        Err(_) => {}
    }
}

#[cfg(windows)]
#[test]
fn on_the_bundled_conpty_with_no_usable_conpty_dll_beside_the_holder_a_launch_answers_io_and_starts_nothing() {
    let _serial = one_at_a_time();
    let store = Store::new("store-bundled");
    // A copy of the helper in a folder of its own, so nothing is beside it
    // but what this test puts there.
    let bin = Store::new("bin-bundled");
    let exe = bin.0.join("aicc-helper.exe");
    fs::copy(HELPER, &exe).expect("copy the helper");
    let sid = "probe-0022";
    let held = Held(hold_from(&exe, &store.0, sid, 60));
    let mut app = App::connect(&held.0, true);
    // The program writes this file in its own folder (the launch's cwd), by
    // a relative name, so no path with a space in it can send it elsewhere.
    let marker = store.0.join("started.txt");
    let cmd = cmd_exe();
    let writes_marker = "echo started>started.txt";
    let conpty = bin.0.join("conpty");
    let elsewhere = bin.0.join("elsewhere");
    // A real library that loads but is not a ConPTY: none of its calls.
    let loads = format!("{}\\System32\\version.dll", std::env::var("SystemRoot").expect("SystemRoot is set"));
    let put = |dir: &Path, name: &str, real: bool| {
        fs::create_dir_all(dir).expect("a folder");
        if real {
            fs::copy(&loads, dir.join(name)).expect("copy a library that loads");
        } else {
            fs::write(dir.join(name), b"not a program").expect("a stand-in file");
        }
    };
    let folder_named = |name: &str| fs::create_dir_all(conpty.join(name)).expect("a folder with a file's name");
    // Each way it is unusable, with the reason the answer must give. The
    // library that loads is last: the holder must unload it again.
    let ways: Vec<(&str, &str, Box<dyn Fn() + '_>)> = vec![
        ("no conpty folder", "conpty is missing", Box::new(|| {})),
        (
            "a conpty folder that is a junction to one with both files",
            "conpty is not a plain folder",
            Box::new(|| {
                put(&elsewhere, "conpty.dll", true);
                put(&elsewhere, "OpenConsole.exe", false);
                let made = Command::new(&cmd).args(["/d", "/c", "mklink", "/J"]).arg(&conpty).arg(&elsewhere).output().expect("run mklink");
                assert!(made.status.success(), "mklink /J: {}", String::from_utf8_lossy(&made.stdout));
            }),
        ),
        ("a conpty.dll that is a folder", "conpty.dll is not a plain file", Box::new(|| folder_named("conpty.dll"))),
        ("a conpty.dll that loads, with no OpenConsole.exe", "OpenConsole.exe is missing", Box::new(|| put(&conpty, "conpty.dll", true))),
        (
            "an OpenConsole.exe that is a folder",
            "OpenConsole.exe is not a plain file",
            Box::new(|| {
                put(&conpty, "conpty.dll", true);
                folder_named("OpenConsole.exe");
            }),
        ),
        (
            "files that do not load",
            "conpty.dll does not load",
            Box::new(|| {
                put(&conpty, "conpty.dll", false);
                put(&conpty, "OpenConsole.exe", false);
            }),
        ),
        (
            "a library that loads without the ConPTY's calls",
            "has no ConptyCreatePseudoConsole",
            Box::new(|| {
                put(&conpty, "conpty.dll", true);
                put(&conpty, "OpenConsole.exe", false);
            }),
        ),
    ];
    for (way, why, set_up) in &ways {
        remove_folder_or_link(&conpty);
        let _ = fs::remove_dir_all(&elsewhere);
        set_up();
        let id = app.id();
        let answer = app.call(launch_msg_more(id, &[&cmd, "/d", "/c", writes_marker], &store.0, vec![("conpty", Value::str("bundled"))]));
        expect_error(&answer, "io");
        let text = answer.get("text").and_then(Value::as_str).unwrap_or("");
        assert!(text.contains("bundled ConPTY") && text.contains(*why), "{way}: the answer does not say {why:?}: {text:?}");
        assert_eq!(read_record(&store.0, sid).child, "waiting", "{way}: a launch that failed changed the record");
    }
    // A library without the calls was unloaded again: its file can be
    // written, which Windows refuses while a program has it loaded. A virus
    // scanner may hold the new file a moment, so this tries for a while.
    let dll = conpty.join("conpty.dll");
    let deadline = Instant::now() + Duration::from_secs(5);
    let rewritten = loop {
        match fs::write(&dll, b"not a program") {
            Ok(()) => break Ok(()),
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => break Err(e),
        }
    };
    assert!(rewritten.is_ok(), "the library without the ConPTY's calls is still loaded in the holder: {rewritten:?}");
    std::thread::sleep(Duration::from_millis(500));
    assert!(!marker.exists(), "a launch answered io and still ran its program");
    // Nothing was started, so the holder still takes a launch: the same one
    // on the system ConPTY, which does write the file, so its absence above
    // is the program not having run.
    let id = app.id();
    expect_t(&app.call(launch_msg_more(id, &[&cmd, "/d", "/c", writes_marker], &store.0, vec![])), "term.launched");
    let deadline = Instant::now() + WAIT;
    while !marker.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(marker.exists(), "the same launch on the system ConPTY did not write {}", marker.display());
}

/// What `hold --detach` says on stderr when the holder could not leave its
/// starter's job (`main.rs`).
#[cfg(windows)]
const IN_JOB_NOTE: &str = "the holder runs inside the job";

/// Windows only: jobs, and `hold --detach` started inside one, for the
/// holder's way out of its starter's job (`detach.rs`, probe P7).
#[cfg(windows)]
mod win {
    use super::Ran;
    use std::ffi::c_void;
    use std::fs;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, SetHandleInformation, BOOL, HANDLE, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, GetCurrentProcess, GetExitCodeProcess, OpenProcess, ResumeThread, TerminateProcess, WaitForSingleObject,
        PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, STARTUPINFOW,
    };

    /// `CREATE_SUSPENDED`: the starter runs only once it is in the job.
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    /// `STARTF_USESTDHANDLES`.
    const STARTF_USESTDHANDLES: u32 = 0x0000_0100;

    fn last_error() -> std::io::Error {
        std::io::Error::last_os_error()
    }

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// A job this test made. Closing it ends every process still in it.
    pub struct Job(HANDLE);

    impl Job {
        /// `may_leave`: whether a process in it may start a child outside it.
        pub fn new(may_leave: bool) -> Job {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                assert!(!handle.is_null(), "make a job: {}", last_error());
                let job = Job(handle);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | if may_leave { JOB_OBJECT_LIMIT_BREAKAWAY_OK } else { 0 };
                let ok = SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                assert_ne!(ok, 0, "set the job's limits: {}", last_error());
                job
            }
        }

        /// Whether process `pid` is in this job.
        pub fn holds(&self, pid: u32) -> bool {
            in_job(pid, self.0)
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// Whether process `pid` is in `job`, or in any job when `job` is null.
    fn in_job(pid: u32, job: HANDLE) -> bool {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            assert!(!process.is_null(), "open process {pid}: {}", last_error());
            let mut inside: BOOL = 0;
            let ok = IsProcessInJob(process, job, &mut inside);
            let e = last_error();
            CloseHandle(process);
            assert_ne!(ok, 0, "ask whether process {pid} is in a job: {e}");
            inside != 0
        }
    }

    /// Whether process `pid` is in any job.
    pub fn in_a_job(pid: u32) -> bool {
        in_job(pid, std::ptr::null_mut())
    }

    /// Whether this test process is in a job: a CI runner may start it in one.
    pub fn this_process_in_a_job() -> bool {
        let mut inside: BOOL = 0;
        let ok = unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut inside) };
        assert_ne!(ok, 0, "ask whether this process is in a job: {}", last_error());
        inside != 0
    }

    fn inherit(file: &fs::File) {
        let ok = unsafe { SetHandleInformation(file.as_raw_handle() as HANDLE, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) };
        assert_ne!(ok, 0, "make a file handle inheritable: {}", last_error());
    }

    /// Run the helper with `args` as a process in `job` from its first
    /// instruction: started suspended with every handle this process lets a
    /// child inherit (as the app starts `hold --detach`), put in the job,
    /// then let run. Its output goes to files, as in `helper_detaching`.
    pub fn run_in_job(job: &Job, args: &[&str], tag: &str) -> Ran {
        let base = std::env::temp_dir().join(format!("aicc-helper-job-{tag}-{}", std::process::id()));
        let out_path = base.with_extension("out");
        let err_path = base.with_extension("err");
        let out = fs::File::create(&out_path).expect("a file for stdout");
        let err = fs::File::create(&err_path).expect("a file for stderr");
        inherit(&out);
        inherit(&err);
        let mut words = vec![super::HELPER.to_string()];
        words.extend(args.iter().map(|a| a.to_string()));
        let mut line = wide(&aicc_helper::cmdline::build_command_line(&words));
        let app = wide(super::HELPER);
        let code = unsafe {
            let mut startup: STARTUPINFOW = std::mem::zeroed();
            startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdOutput = out.as_raw_handle() as HANDLE;
            startup.hStdError = err.as_raw_handle() as HANDLE;
            let mut info: PROCESS_INFORMATION = std::mem::zeroed();
            let ok = CreateProcessW(
                app.as_ptr(),
                line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                CREATE_SUSPENDED,
                std::ptr::null(),
                std::ptr::null(),
                &startup,
                &mut info,
            );
            assert_ne!(ok, 0, "start hold --detach: {}", last_error());
            if AssignProcessToJobObject(job.0, info.hProcess) == 0 {
                let e = last_error();
                TerminateProcess(info.hProcess, 1);
                CloseHandle(info.hThread);
                CloseHandle(info.hProcess);
                panic!("put hold --detach in the job: {e}");
            }
            if ResumeThread(info.hThread) == u32::MAX {
                let e = last_error();
                TerminateProcess(info.hProcess, 1);
                CloseHandle(info.hThread);
                CloseHandle(info.hProcess);
                panic!("let hold --detach run: {e}");
            }
            CloseHandle(info.hThread);
            // WAIT_OBJECT_0 is 0: it exited in time.
            let exited = WaitForSingleObject(info.hProcess, 30_000) == 0;
            if !exited {
                TerminateProcess(info.hProcess, 1);
            }
            let mut code: u32 = 1;
            GetExitCodeProcess(info.hProcess, &mut code);
            CloseHandle(info.hProcess);
            if exited {
                Some(code as i32)
            } else {
                None
            }
        };
        drop(out);
        drop(err);
        let ran = Ran {
            ok: code == Some(0),
            code,
            stdout: fs::read_to_string(&out_path).unwrap_or_default(),
            stderr: fs::read_to_string(&err_path).unwrap_or_default(),
        };
        let _ = fs::remove_file(&out_path);
        let _ = fs::remove_file(&err_path);
        ran
    }
}

/// The retry inside the starter's job (`detach.rs`, probe P7): the job
/// forbids leaving it, so the first start, which asks to leave, is refused
/// and the second starts the holder inside the job. That start too must hand
/// the holder none of its starter's handles.
#[cfg(windows)]
#[test]
fn inside_a_job_that_forbids_leaving_it_the_holder_runs_in_the_job_and_keeps_none_of_its_starters_handles() {
    let _serial = one_at_a_time();
    let store = Store::new("store-in-job");
    let job = win::Job::new(false);
    let store_arg = store.0.to_string_lossy().into_owned();
    let args: &[&str] = &["hold", "--detach", "--store", &store_arg, "--session", "probe-0011", "--label", "Test terminal", "--away", "60"];
    let (ran, passed) = given_a_pipe(|| win::run_in_job(&job, args, "in-job"));
    assert!(ran.ok, "hold --detach inside a job failed ({:?}): {} / {}", ran.code, ran.stdout, ran.stderr);
    let held = Held(record_of(&ran));
    let pid = held.0.pid;
    assert!(ran.stderr.contains(IN_JOB_NOTE), "hold --detach did not say the holder runs inside the job: {:?}", ran.stderr);
    assert!(job.holds(pid), "the holder (process {pid}) is not in the job its starter ran in");
    assert!(passed.control_held, "the pipe ended while a child that inherited it still ran: this test cannot see a handle that was passed on");
    if let Err(why) = passed.ended() {
        panic!("the holder (process {pid}), started inside the job, kept the pipe its starter was given open: {why}");
    }
    assert!(pids::alive(pid), "the holder (process {pid}) was not running");
}

/// The first start (`detach.rs`): a job that lets a process leave it keeps
/// no holder, and `hold --detach` says nothing about a job.
#[cfg(windows)]
#[test]
fn inside_a_job_that_lets_a_process_leave_it_the_holder_leaves_the_job() {
    let _serial = one_at_a_time();
    let store = Store::new("store-leave-job");
    let job = win::Job::new(true);
    let store_arg = store.0.to_string_lossy().into_owned();
    let args: &[&str] = &["hold", "--detach", "--store", &store_arg, "--session", "probe-0012", "--label", "Test terminal", "--away", "60"];
    let ran = win::run_in_job(&job, args, "leave-job");
    assert!(ran.ok, "hold --detach inside a job failed ({:?}): {} / {}", ran.code, ran.stdout, ran.stderr);
    let held = Held(record_of(&ran));
    let pid = held.0.pid;
    let inside = job.holds(pid);
    let noted = ran.stderr.contains(IN_JOB_NOTE);
    if win::this_process_in_a_job() {
        // A job around this test may itself forbid leaving it; then the
        // holder stays, and the note must say so.
        assert_eq!(noted, inside, "the holder (process {pid}) is {}in the job, and hold --detach said: {:?}", if inside { "" } else { "not " }, ran.stderr);
    } else {
        assert!(!inside, "the holder (process {pid}) stayed in a job that lets a process leave it");
        assert!(!noted, "hold --detach said the holder runs inside the job: {:?}", ran.stderr);
    }
    assert!(pids::alive(pid), "the holder (process {pid}) was not running");
}

/// A copy of the pipe end at a number above the soft limit set next: a
/// starter may lower its limit after it opened a descriptor, and the holder
/// must close that one too.
#[cfg(unix)]
const HIGH_FD: i32 = 200;
#[cfg(unix)]
const LOWERED_SOFT_LIMIT: libc::rlim_t = 64;

/// Run `aicc-helper __close-check <way>` given an inheritable pipe end, at
/// its own number and copied to `HIGH_FD`, with the soft limit lowered below
/// that copy. Ok once the pipe has ended while the check still runs. The
/// child holds the pipe until it closes it: the copy is made in the child
/// itself, so there is no control to run here.
#[cfg(unix)]
fn close_check(way: &str) -> Result<(), String> {
    use std::io::BufRead;
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    let (read_end, write_end) = std::io::pipe().expect("a pipe");
    let write_end = inheritable(write_end);
    let fd = write_end.as_raw_fd();
    let ended = end_of_file(read_end);
    let mut cmd = Command::new(HELPER);
    cmd.args(["__close-check", way]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    // In the child between fork and exec, so only calls that are safe there.
    unsafe {
        cmd.pre_exec(move || {
            if libc::dup2(fd, HIGH_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
            if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            limit.rlim_cur = LOWERED_SOFT_LIMIT;
            if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut check = Running(cmd.spawn().expect("start __close-check"));
    drop(write_end);
    let stdout = check.0.stdout.take().expect("its stdout");
    let (tx, said) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = std::io::BufReader::new(stdout).read_line(&mut line);
        let _ = tx.send(line);
    });
    let line = said.recv_timeout(Duration::from_secs(20)).unwrap_or_default();
    if line.trim() != "closed" {
        let status = check.0.try_wait();
        return Err(format!("it did not say closed: {line:?} (exit {status:?})"));
    }
    let end = ended.recv_timeout(Duration::from_secs(2)).ok();
    let still_running = matches!(check.0.try_wait(), Ok(None));
    // Its standard input ends, and so does it.
    drop(check.0.stdin.take());
    ended_cleanly(&end)?;
    if !still_running {
        return Err("it exited before the pipe could be seen to end while it ran".to_string());
    }
    Ok(())
}

/// `hold`'s first step on macOS and Linux (`detach.rs`), each way it can
/// take: every descriptor from 3 up that the starter was given is closed.
#[cfg(unix)]
#[test]
fn each_way_of_closing_inherited_descriptors_closes_them_all() {
    let _serial = one_at_a_time();
    let mut ways = vec!["best", "listing", "every-number"];
    // Every Linux runner's kernel has `close_range` (5.9 and later).
    if cfg!(target_os = "linux") {
        ways.push("range");
    }
    let failed: Vec<String> = ways.iter().filter_map(|way| close_check(way).err().map(|why| format!("{way}: {why}"))).collect();
    assert!(failed.is_empty(), "a descriptor the holder was given stayed open: {failed:?}");
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
