//! The status line through a holder (protocol section 15, capability
//! `status`, from 2.1.3-beta.18): the status mode run as a CLI runs its status
//! line command (`aicc-helper status`, the status on its standard input), a
//! holder started with `hold --detach`, and test connections standing in for
//! the app. Stand-in holders on a real endpoint cover what a real holder of
//! this version never does: a hello without `status`, no answer, no hello.

use aicc_helper::client::Client;
use aicc_helper::frame::{self, Body, Direction, Frame};
use aicc_helper::hello::{self, Hello, LOCAL_CAPS};
use aicc_helper::hook::{SESSION_ENV, STORE_ENV};
use aicc_helper::json::{self, Value};
use aicc_helper::pids;
use aicc_helper::serve::{HOLDER_CAPS, STATUS_EVERY};
use aicc_helper::status::ACK_CAPS;
use aicc_helper::store::{self, Record};
use aicc_helper::transport::{self, Listener};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
const FAKE: &str = env!("CARGO_BIN_EXE_aicc-fake-cli");
const NONCE: &str = "0123456789abcdef0123456789abcdef";
const WAIT: Duration = Duration::from_secs(20);
/// The status mode's 2 s, and time to start and end its process.
const STATUS_BOUND: Duration = Duration::from_millis(2500);
/// What the app acks for a tab that takes the status line.
const APP_CAPS: [&str; 3] = ["core", "local", "status"];

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// Every test here starts processes, one at a time: on Windows a child
/// inherits every inheritable handle of its parent, so a spawn on one test
/// thread could carry another thread's pipe ends (as in hooks.rs).
fn one_at_a_time() -> MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A new, empty folder of this test, 0700 whatever the umask on macOS and
/// Linux (a crate's tests share one process and its umask), removed when
/// dropped.
struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Folder {
        let dir = std::env::temp_dir().join(format!("aicc-status-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a folder");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).expect("the folder's mode");
        }
        Folder(dir)
    }

    fn arg(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Every entry of `dir` by name, with the bytes of each file, in name order.
fn files(dir: &Folder) -> Vec<(String, Vec<u8>)> {
    let mut out: Vec<(String, Vec<u8>)> = fs::read_dir(&dir.0)
        .expect("read the folder")
        .map(|entry| {
            let entry = entry.expect("an entry");
            (entry.file_name().to_string_lossy().into_owned(), fs::read(entry.path()).unwrap_or_default())
        })
        .collect();
    out.sort();
    out
}

fn t_of(v: &Value) -> &str {
    v.get("t").and_then(Value::as_str).unwrap_or("")
}

fn num(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(Value::as_u64)
}

fn texts(messages: &[Value]) -> Vec<String> {
    messages.iter().map(Value::to_json).collect()
}

fn msg(t: &str, id: u64, more: Vec<(&str, Value)>) -> Value {
    let mut members = vec![("t", Value::str(t)), ("id", Value::uint(id))];
    members.extend(more);
    Value::obj(members)
}

/// A status as Claude Code writes it to its status line command, with `n`
/// in it to tell one from another.
fn status_input(n: u64) -> String {
    format!("{{\"session_id\":\"0b7c5f1e-6a3d-4c8e-9f21-5d4e3c2b1a00\",\"cwd\":\"/home/u/p\",\"model\":{{\"id\":\"model-1\",\"display_name\":\"Model\"}},\"cost\":{{\"total_cost_usd\":0.5}},\"n\":{n}}}")
}

/// A record of this test's process for `sid`, naming `endpoint`.
fn record(sid: &str, endpoint: &str) -> Record {
    Record {
        session: sid.to_string(),
        label: String::new(),
        pid: std::process::id(),
        endpoint: endpoint.to_string(),
        nonce: NONCE.to_string(),
        helper: "0.1.0".to_string(),
        started: store::now_ms(),
        away: 120,
        attached: false,
        child: "running".to_string(),
        code: None,
    }
}

/// Run `aicc-helper` with `args`, its output going to files: a holder it
/// starts outlives it, and would hold a pipe open.
fn detaching(args: &[&str], tag: &str) -> (bool, String, String) {
    let base = std::env::temp_dir().join(format!("aicc-status-detach-{tag}-{}", std::process::id()));
    let out_path = base.with_extension("out");
    let err_path = base.with_extension("err");
    let status = Command::new(HELPER)
        .args(args)
        .stdin(Stdio::null())
        .stdout(fs::File::create(&out_path).expect("a file for stdout"))
        .stderr(fs::File::create(&err_path).expect("a file for stderr"))
        .status()
        .expect("run the helper");
    let stdout = fs::read_to_string(&out_path).unwrap_or_default();
    let stderr = fs::read_to_string(&err_path).unwrap_or_default();
    let _ = fs::remove_file(&out_path);
    let _ = fs::remove_file(&err_path);
    (status.success(), stdout, stderr)
}

/// Start a detached holder; the record it printed.
fn hold(store_dir: &Folder, sid: &str) -> Record {
    let (ok, stdout, stderr) = detaching(&["hold", "--detach", "--store", &store_dir.arg(), "--session", sid, "--away", "60"], sid);
    assert!(ok, "hold --detach failed: {stdout} / {stderr}");
    let v = json::parse(stdout.trim().as_bytes()).unwrap_or_else(|e| panic!("hold printed {stdout:?} ({e:?})"));
    Record::from_value(&v).unwrap_or_else(|e| panic!("hold printed a record that does not read ({e}): {stdout}"))
}

/// End a holder that still runs, from a fresh connection; quiet, as a
/// test's clean-up may run while it is failing.
fn end(rec: &Record) {
    if !pids::alive(rec.pid) {
        return;
    }
    if let Ok(mut client) = Client::to_record(rec, WAIT) {
        if client.ack().is_ok() && client.send(msg("term.end", 2, vec![])).is_ok() {
            let deadline = Instant::now() + WAIT;
            while pids::alive(rec.pid) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// A holder this test started, ended when dropped. Declared after its
/// folders, so it is dropped before them.
struct Held(Record);

impl Drop for Held {
    fn drop(&mut self) {
        end(&self.0);
    }
}

/// One run of the status mode.
struct Ran {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    took: Duration,
}

impl Ran {
    /// Exit 0, and not a byte on standard output or standard error.
    fn quiet(&self) -> bool {
        self.code == Some(0) && self.stdout.is_empty() && self.stderr.is_empty()
    }

    fn say(&self) -> String {
        format!("exit {:?} after {:?}; stdout {:?}; stderr {:?}", self.code, self.took, String::from_utf8_lossy(&self.stdout), String::from_utf8_lossy(&self.stderr))
    }
}

/// Run `aicc-helper status` with `args`, `input` on its standard input, and
/// in its environment the variables `env` names and neither of the two it
/// reads otherwise, the way a CLI runs its status line command.
fn status_run_with(args: &[&str], input: &[u8], env: &[(&str, &str)]) -> Ran {
    let started = Instant::now();
    let mut command = Command::new(HELPER);
    command.arg("status").args(args).env_remove(STORE_ENV).env_remove(SESSION_ENV);
    for (name, value) in env {
        command.env(name, value);
    }
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().expect("start the status mode");
    let mut stdin = child.stdin.take().expect("its standard input");
    let input = input.to_vec();
    // The status mode may stop reading at its deadline: a write it does not
    // take is not a failure here. The input ends when the writer is done.
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let out = child.wait_with_output().expect("wait for the status mode");
    let _ = writer.join();
    Ran { code: out.status.code(), stdout: out.stdout, stderr: out.stderr, took: started.elapsed() }
}

fn status_run(args: &[&str], input: &[u8]) -> Ran {
    status_run_with(args, input, &[])
}

fn status_to(store_dir: &Folder, sid: &str, input: &[u8]) -> Ran {
    status_run(&["--store", &store_dir.arg(), "--session", sid], input)
}

/// A connection standing in for the app: the JSON messages it read and has
/// not yet looked at, in the order they came.
struct App {
    client: Client,
    got: Vec<Value>,
    next_id: u64,
}

impl App {
    /// Connect, read the hello and ack it with `caps`.
    fn connect(rec: &Record, caps: &[&str]) -> App {
        let mut client = Client::to_record(rec, WAIT).expect("connect to the holder and read its hello");
        client.send(hello::ack_message(1, caps)).expect("ack the hello");
        App { client, got: Vec::new(), next_id: 2 }
    }

    fn id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 2;
        id
    }

    /// The next JSON message from the stream, before `until`; None at the
    /// end of the stream or when none came. Terminal output is passed over.
    fn read(&mut self, until: Instant) -> Option<Value> {
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            match self.client.recv(left) {
                Ok(Some(Frame { channel: 0, body: Body::Json(v) })) => return Some(v),
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => return None,
            }
        }
    }

    /// The next JSON message, one already read first, within `wait`.
    fn next(&mut self, wait: Duration) -> Option<Value> {
        if !self.got.is_empty() {
            return Some(self.got.remove(0));
        }
        self.read(Instant::now() + wait)
    }

    /// Send `v` and wait for its answer; what came before it is kept.
    fn call(&mut self, v: Value) -> Value {
        let id = v.get("id").and_then(Value::as_u64).expect("a request id");
        self.client.send(v).expect("send a request");
        let until = Instant::now() + WAIT;
        loop {
            let m = match self.read(until) {
                Some(m) => m,
                None => panic!("no answer to request {id}; got {:?}", texts(&self.got)),
            };
            if num(&m, "re") == Some(id) {
                return m;
            }
            self.got.push(m);
        }
    }

    /// The next `n` messages, each of them a status.
    fn statuses(&mut self, n: usize) -> Vec<Value> {
        let mut out = Vec::new();
        for i in 0..n {
            let m = self.next(WAIT).unwrap_or_else(|| panic!("status {} of {n} never came", i + 1));
            assert_eq!(t_of(&m), "status", "expected a status, got {}", m.to_json());
            out.push(m);
        }
        out
    }

    /// Nothing more within `wait`.
    fn nothing_more(&mut self, wait: Duration, what: &str) {
        if let Some(m) = self.next(wait) {
            panic!("{what}: got {}", m.to_json());
        }
    }

    /// Post one status from this connection; the seq it took.
    fn post(&mut self, n: u64) -> u64 {
        let id = self.id();
        let payload = json::parse(status_input(n).as_bytes()).expect("JSON");
        let taken = self.call(msg("status.set", id, vec![("payload", payload)]));
        assert_eq!(t_of(&taken), "status.taken", "{}", taken.to_json());
        num(&taken, "seq").expect("a seq")
    }
}

/// What a launch hands the fake CLI: this test's environment, as much of it
/// as a launch allows.
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

/// Launch the fake CLI from `app`'s connection, then attach it from offset 0.
fn launch_and_attach(app: &mut App, cwd: &Folder) {
    let id = app.id();
    let env = Value::Obj(launch_env().into_iter().map(|(k, v)| (k, Value::Str(v))).collect());
    let launched = app.call(msg(
        "term.launch",
        id,
        vec![("argv", Value::strs(&[FAKE])), ("cwd", Value::Str(cwd.arg())), ("env", env), ("cols", Value::uint(120)), ("rows", Value::uint(30))],
    ));
    assert_eq!(t_of(&launched), "term.launched", "{}", launched.to_json());
    let id = app.id();
    let attached = app.call(msg("term.attach", id, vec![("from", Value::uint(0))]));
    assert_eq!(t_of(&attached), "term.attached", "{}", attached.to_json());
    assert!(app.got.is_empty(), "before term.attached came {:?}", texts(&app.got));
}

/// The status `n` as the holder passes it on: `status_input(n)`, compact.
fn payload_of(n: u64) -> Value {
    json::parse(status_input(n).as_bytes()).expect("JSON")
}

#[test]
fn a_status_run_reaches_each_connection_that_acked_status_once_and_says_nothing() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-reach");
    let work = Folder::new("work-reach");
    let sid = "status-reach-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = App::connect(&held.0, &APP_CAPS);
    assert_eq!(app.client.hello.caps, HOLDER_CAPS.iter().map(|c| c.to_string()).collect::<Vec<String>>());
    launch_and_attach(&mut app, &work);
    // A second app connection that acked status, attached to nothing; one
    // that did not ack it (the app's own ack of before); and one that acked
    // it without `local`, as the status mode does, which only posts.
    let mut reader = App::connect(&held.0, &APP_CAPS);
    let mut plain = App::connect(&held.0, &LOCAL_CAPS);
    let mut poster = App::connect(&held.0, &ACK_CAPS);
    let before = files(&store_dir);

    for n in 1..=2 {
        let ran = status_to(&store_dir, sid, status_input(n).as_bytes());
        assert!(ran.quiet(), "{}", ran.say());
        assert!(ran.took < STATUS_BOUND, "{}", ran.say());
        for (who, conn) in [("the attached app", &mut app), ("a reader", &mut reader)] {
            let got = conn.statuses(1).remove(0);
            assert_eq!(num(&got, "seq"), Some(n), "{who}: {}", got.to_json());
            assert_eq!(got.get("payload"), Some(&payload_of(n)), "{who}: the payload changed on the way: {}", got.to_json());
            assert_eq!(got.keys(), Some(vec!["t", "seq", "payload"]), "{who}: {}", got.to_json());
        }
    }
    // Each once: nothing more for either, and nothing at all for the
    // connection that did not ack status or for the one that acked it
    // without `local`. The holder wrote nothing for them.
    app.nothing_more(Duration::from_secs(1), "the attached app, after its two");
    reader.nothing_more(Duration::from_millis(300), "the reader, after its two");
    plain.nothing_more(Duration::from_millis(300), "a connection that did not ack status");
    poster.nothing_more(Duration::from_millis(300), "a connection that acked status without local");
    assert_eq!(files(&store_dir), before, "a status changed the store");
    // That one may post: the third status, from it, reaches both.
    assert_eq!(poster.post(3), 3);
    for conn in [&mut app, &mut reader] {
        let got = conn.statuses(1).remove(0);
        assert_eq!((num(&got, "seq"), got.get("payload")), (Some(3), Some(&payload_of(3))), "{}", got.to_json());
    }
    assert!(poster.got.is_empty(), "the poster was sent {:?}", texts(&poster.got));
    end(&held.0);
}

#[test]
fn the_newest_status_is_kept_while_no_connection_takes_it_and_sent_once_on_an_ack() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-slot");
    let sid = "status-slot-01";
    let held = Held(hold(&store_dir, sid));

    // Three statuses while no connection takes the status: one slot keeps
    // the newest only.
    for n in 1..=3 {
        let ran = status_to(&store_dir, sid, status_input(n).as_bytes());
        assert!(ran.quiet(), "{}", ran.say());
    }
    // An ack of status is sent the newest at once, once: the third, never
    // the first two.
    let mut app = App::connect(&held.0, &APP_CAPS);
    let got = app.statuses(1).remove(0);
    assert_eq!((num(&got, "seq"), got.get("payload")), (Some(3), Some(&payload_of(3))), "{}", got.to_json());
    app.nothing_more(Duration::from_secs(1), "after the newest on its ack");
    // So is a later connection's: once a connection, not once a holder.
    let mut again = App::connect(&held.0, &APP_CAPS);
    let got = again.statuses(1).remove(0);
    assert_eq!(num(&got, "seq"), Some(3), "{}", got.to_json());
    again.nothing_more(Duration::from_millis(300), "after the newest on its ack");
    // A fourth goes to both.
    let ran = status_to(&store_dir, sid, status_input(4).as_bytes());
    assert!(ran.quiet(), "{}", ran.say());
    for conn in [&mut app, &mut again] {
        let got = conn.statuses(1).remove(0);
        assert_eq!((num(&got, "seq"), got.get("payload")), (Some(4), Some(&payload_of(4))), "{}", got.to_json());
    }
    end(&held.0);
}

#[test]
fn rounds_of_status_are_at_most_ten_a_second_and_the_newest_wins() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-rate");
    let sid = "status-rate-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = App::connect(&held.0, &APP_CAPS);
    let mut poster = App::connect(&held.0, &["core", "status"]);

    // Thirty statuses as fast as one connection can post them.
    let started = Instant::now();
    for n in 1..=30 {
        assert_eq!(poster.post(n), n);
    }
    // The app gets the newest at last, and in rising order; what was
    // posted between two rounds is passed over.
    let mut seqs: Vec<u64> = Vec::new();
    while seqs.last() != Some(&30) {
        let got = app.statuses(1).remove(0);
        let seq = num(&got, "seq").expect("a seq");
        assert_eq!(got.get("payload"), Some(&payload_of(seq)), "{}", got.to_json());
        seqs.push(seq);
    }
    let took = started.elapsed();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "out of order or twice: {seqs:?}");
    // Rounds begin at least STATUS_EVERY apart on the holder's clock, and
    // all of them fell within `took`: so at most this many.
    let most = (took.as_millis() / STATUS_EVERY.as_millis()) as usize + 1;
    assert!(seqs.len() <= most, "{} statuses in {took:?}, more than {most}: {seqs:?}", seqs.len());
    app.nothing_more(Duration::from_millis(500), "after the newest");
    end(&held.0);
}

#[test]
fn a_status_run_that_cannot_pass_its_status_on_exits_0_and_says_nothing() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-quiet");
    let work = Folder::new("work-quiet");
    let sid = "status-quiet-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = App::connect(&held.0, &APP_CAPS);
    launch_and_attach(&mut app, &work);
    let good = status_input(1);

    // The command line: none, no session, a session id that breaks its
    // pattern, an unknown option, a store that is not there.
    let store_arg = store_dir.arg();
    let missing = store_dir.0.join("missing");
    let missing_arg = missing.to_string_lossy().into_owned();
    for args in [
        &[][..],
        &["--store", store_arg.as_str()][..],
        &["--store", store_arg.as_str(), "--session", "bad id"][..],
        &["--store", store_arg.as_str(), "--session", sid, "--verbose", "1"][..],
        &["--store", missing_arg.as_str(), "--session", sid][..],
    ] {
        let ran = status_run(args, good.as_bytes());
        assert!(ran.quiet(), "{args:?}: {}", ran.say());
    }
    assert!(!missing.exists(), "the status mode made the store");

    // What came on standard input is not one status within the bounds:
    // nothing, not JSON, not an object, two objects, a name given twice,
    // over 65,280 bytes as compact JSON, or over 4 MiB.
    let head = "{\"pad\":\"";
    let over_payload = format!("{head}{}\"}}", "x".repeat(65_281 - head.len() - 2));
    assert_eq!(over_payload.len(), 65_281);
    let over_stdin = format!("{{\"pad\":\"{}\"}}", "x".repeat(4 * 1024 * 1024));
    for (what, input) in [
        ("nothing", Vec::new()),
        ("not JSON", b"not json".to_vec()),
        ("not an object", b"[1,2]".to_vec()),
        ("two objects", b"{\"a\":1}{\"b\":2}".to_vec()),
        ("a name given twice", b"{\"cwd\":\"/a\",\"cwd\":\"/b\"}".to_vec()),
        ("over 65,280 bytes", over_payload.into_bytes()),
        ("over 4 MiB", over_stdin.into_bytes()),
    ] {
        let ran = status_to(&store_dir, sid, &input);
        assert!(ran.quiet(), "{what}: {}", ran.say());
    }
    // None of those reached the holder. The attached app would have got it
    // within the run (no round had begun), so a second more is ample.
    app.nothing_more(Duration::from_secs(1), "a run that should have sent nothing");

    // The next good run's status is the session's first.
    let ran = status_to(&store_dir, sid, good.as_bytes());
    assert!(ran.quiet(), "{}", ran.say());
    let got = app.statuses(1).remove(0);
    assert_eq!(num(&got, "seq"), Some(1), "a run that should have sent nothing took a seq: {}", got.to_json());
    end(&held.0);
}

/// A stand-in holder on a real endpoint, with a record in `store_dir`: it
/// writes a hello offering `caps` (no hello at all for None), then reads
/// until the client goes, and never answers. It hands on the bytes it read.
fn stand_in(store_dir: &Folder, sid: &str, caps: Option<&[&str]>) -> mpsc::Receiver<Vec<u8>> {
    let listener = Listener::bind(sid).expect("listen");
    store::prepare(&store_dir.0).expect("a store");
    store::write(&store_dir.0, &record(sid, listener.endpoint())).expect("a record");
    let line = caps.map(|caps| {
        let h = Hello { nonce: NONCE, helper_version: "0.1.0", sha256: None, os: std::env::consts::OS, arch: std::env::consts::ARCH, caps, sid, state: "live" };
        hello::hello_line(&h).expect("a hello line")
    });
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut read: Vec<u8> = Vec::new();
        if let Ok(mut s) = listener.accept() {
            if let Some(line) = line {
                let _ = s.write_all(format!("{line}\n").as_bytes());
                let _ = s.flush();
            }
            let _ = s.set_read_timeout(Some(WAIT));
            let mut buf = [0u8; 4096];
            loop {
                match s.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => read.extend_from_slice(&buf[..n]),
                }
            }
        }
        let _ = tx.send(read);
    });
    rx
}

#[test]
fn a_status_run_with_no_holder_or_one_that_never_answers_ends_within_2_s_and_says_nothing() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-mute");
    let input = status_input(1);

    // A record whose holder is gone: nothing listens on its endpoint. The
    // status mode writes no file: the record stays as it is.
    let sid = "status-gone-0001";
    let gone = transport::endpoint_name(sid, &"0".repeat(transport::ENDPOINT_RANDOM_HEX));
    store::prepare(&store_dir.0).expect("a store");
    store::write(&store_dir.0, &record(sid, &gone)).expect("a record");
    let before = files(&store_dir);
    let ran = status_to(&store_dir, sid, input.as_bytes());
    assert!(ran.quiet() && ran.took < STATUS_BOUND, "no holder: {}", ran.say());
    assert_eq!(files(&store_dir), before, "the status mode removed or changed a stale record");

    // A hello that offers what a holder of this version offers, then
    // nothing: the status mode acks core and status alone, sends its
    // status, and waits for a reply that never comes.
    let sid = "status-mute-0001";
    let read = stand_in(&store_dir, sid, Some(&HOLDER_CAPS[..]));
    let ran = status_to(&store_dir, sid, input.as_bytes());
    assert!(ran.quiet() && ran.took < STATUS_BOUND, "no answer: {}", ran.say());
    let bytes = read.recv_timeout(WAIT).expect("the stand-in saw the status mode go");
    let mut sent = Cursor::new(&bytes[..]);
    let ack = match frame::read_frame(&mut sent, Direction::AppToHelper) {
        Ok(Some(Frame { channel: 0, body: Body::Json(v) })) => v,
        other => panic!("the status mode's first frame is not a message: {other:?}"),
    };
    assert_eq!(hello::parse_ack(&ack), Some((1, ACK_CAPS.iter().map(|c| c.to_string()).collect::<Vec<String>>())), "{}", ack.to_json());
    let set = match frame::read_frame(&mut sent, Direction::AppToHelper) {
        Ok(Some(Frame { channel: 0, body: Body::Json(v) })) => v,
        other => panic!("the status mode's second frame is not a message: {other:?}"),
    };
    let want = msg("status.set", 2, vec![("payload", payload_of(1))]);
    assert_eq!(set.to_json(), want.to_json());

    // A holder from before the status line (no `status` in its hello) is
    // sent nothing, not even the ack.
    let sid = "status-older-001";
    let read = stand_in(&store_dir, sid, Some(&HOLDER_CAPS[..7]));
    let ran = status_to(&store_dir, sid, input.as_bytes());
    assert!(ran.quiet() && ran.took < STATUS_BOUND, "an older holder: {}", ran.say());
    let bytes = read.recv_timeout(WAIT).expect("the stand-in saw the status mode go");
    assert_eq!(bytes.len(), 0, "the status mode wrote to a holder that does not offer status");

    // No hello at all.
    let sid = "status-mute-0002";
    let _read = stand_in(&store_dir, sid, None);
    let ran = status_to(&store_dir, sid, input.as_bytes());
    assert!(ran.quiet() && ran.took < STATUS_BOUND, "no hello: {}", ran.say());
}

#[test]
fn a_status_run_whose_standard_input_never_ends_ends_within_2_s() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-open");
    let store_arg = store_dir.arg();
    let started = Instant::now();
    let mut child = Command::new(HELPER)
        .args(["status", "--store", store_arg.as_str(), "--session", "status-open-0001"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start the status mode");
    // Part of a status, and the input left open, as a writer that hangs.
    let mut stdin = child.stdin.take().expect("its standard input");
    let _ = stdin.write_all(b"{\"model\":");
    let _ = stdin.flush();
    let mut ended = None;
    while ended.is_none() && started.elapsed() < WAIT {
        ended = child.try_wait().expect("look at the status mode");
        std::thread::sleep(Duration::from_millis(20));
    }
    let took = started.elapsed();
    if ended.is_none() {
        let _ = child.kill();
    }
    let out = child.wait_with_output().expect("the status mode's output");
    drop(stdin);
    let ran = Ran { code: out.status.code(), stdout: out.stdout, stderr: out.stderr, took };
    assert!(ran.quiet() && ran.took < STATUS_BOUND, "{}", ran.say());
}

#[test]
fn the_status_mode_reads_a_store_and_a_session_left_out_from_the_environment() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-env");
    let sid = "status-env-0001";
    let held = Held(hold(&store_dir, sid));
    let mut app = App::connect(&held.0, &APP_CAPS);
    let store_arg = store_dir.arg();

    // Both from the environment; the session from the command line over a
    // variable that names another; the store from the command line and the
    // session from its variable.
    let runs: [(&[&str], Vec<(&str, &str)>); 3] = [
        (&[], vec![(STORE_ENV, store_arg.as_str()), (SESSION_ENV, sid)]),
        (&["--session", sid], vec![(STORE_ENV, store_arg.as_str()), (SESSION_ENV, "status-other-01")]),
        (&["--store", store_arg.as_str()], vec![(SESSION_ENV, sid)]),
    ];
    for (n, (args, env)) in runs.iter().enumerate() {
        let n = n as u64 + 1;
        let ran = status_run_with(args, status_input(n).as_bytes(), env);
        assert!(ran.quiet(), "{args:?} {env:?}: {}", ran.say());
        let got = app.statuses(1).remove(0);
        assert_eq!((num(&got, "seq"), got.get("payload")), (Some(n), Some(&payload_of(n))), "{args:?} {env:?}: {}", got.to_json());
    }
    // A session named by neither: nothing.
    let ran = status_run_with(&[], status_input(9).as_bytes(), &[(STORE_ENV, store_arg.as_str())]);
    assert!(ran.quiet(), "{}", ran.say());
    app.nothing_more(Duration::from_secs(1), "a run with no session");
    end(&held.0);
}
