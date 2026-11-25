//! Hook events through a holder (protocol section 15, capability `hooks`):
//! the hook mode run as Claude Code runs a command hook (`aicc-helper hook`,
//! the event on its standard input), a holder started with `hold --detach`,
//! and test connections standing in for the app. Stand-in holders on a real
//! endpoint cover what a real holder of this version never does: a hello
//! without `hooks`, no answer, no hello at all.

use aicc_helper::client::Client;
use aicc_helper::frame::{self, Body, Direction, Frame};
use aicc_helper::hello::{self, Hello, LOCAL_CAPS};
use aicc_helper::hook::{ACK_CAPS, SESSION_ENV, STORE_ENV};
use aicc_helper::json::{self, Value};
use aicc_helper::pids;
use aicc_helper::serve::HOLDER_CAPS;
use aicc_helper::store::{self, Record};
use aicc_helper::transport::{self, Listener};
use std::ffi::OsString;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
const FAKE: &str = env!("CARGO_BIN_EXE_aicc-fake-cli");
const NONCE: &str = "0123456789abcdef0123456789abcdef";
const WAIT: Duration = Duration::from_secs(20);
/// The hook mode's 2 s, and time to start and end its process.
const HOOK_BOUND: Duration = Duration::from_millis(2500);

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// Every test here starts processes, one at a time: on Windows a child
/// inherits every inheritable handle of its parent, so a spawn on one test
/// thread could carry another thread's pipe ends (as in probe_transport.rs).
fn one_at_a_time() -> MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A new, empty folder of this test, 0700 whatever the umask on macOS and
/// Linux (a crate's tests share one process and its umask), removed when
/// dropped.
struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Folder {
        let dir = std::env::temp_dir().join(format!("aicc-hooks-test-{name}-{}", std::process::id()));
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

/// Every entry of `dir` by name, with the bytes of each file and when it was
/// last written (a file written again with the same bytes shows there), in
/// name order.
fn files(dir: &Folder) -> Vec<(String, Vec<u8>, Option<SystemTime>)> {
    let mut out: Vec<(String, Vec<u8>, Option<SystemTime>)> = fs::read_dir(&dir.0)
        .expect("read the folder")
        .map(|entry| {
            let entry = entry.expect("an entry");
            let modified = entry.metadata().and_then(|m| m.modified()).ok();
            (entry.file_name().to_string_lossy().into_owned(), fs::read(entry.path()).unwrap_or_default(), modified)
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

/// A hook event as Claude Code writes it, with `more` (members, each after
/// a comma) at the end.
fn event_input(kind: &str, more: &str) -> String {
    format!("{{\"session_id\":\"0b7c5f1e-6a3d-4c8e-9f21-5d4e3c2b1a00\",\"transcript_path\":\"/home/u/.claude/projects/p/s.jsonl\",\"cwd\":\"/home/u/p\",\"hook_event_name\":\"{kind}\"{more}}}")
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
    let base = std::env::temp_dir().join(format!("aicc-hooks-detach-{tag}-{}", std::process::id()));
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

/// One run of the hook mode.
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

/// Run `aicc-helper hook` with `args`, `input` on its standard input, the way
/// Claude Code runs a command hook.
fn hook_run(args: &[&str], input: &[u8]) -> Ran {
    hook_run_with(args, input, &[])
}

/// `hook_run`, with in the hook mode's environment the variables `env`
/// names, and neither of the two it reads a store and a session from
/// otherwise (`hook::STORE_ENV`, `hook::SESSION_ENV`).
fn hook_run_with(args: &[&str], input: &[u8], env: &[(&str, &str)]) -> Ran {
    let started = Instant::now();
    let mut command = Command::new(HELPER);
    command.arg("hook").args(args).env_remove(STORE_ENV).env_remove(SESSION_ENV);
    for (name, value) in env {
        command.env(name, value);
    }
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().expect("start the hook mode");
    let mut stdin = child.stdin.take().expect("its standard input");
    let input = input.to_vec();
    // The hook mode may stop reading at its deadline: a write it does not
    // take is not a failure here. The input ends when the writer is done.
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let out = child.wait_with_output().expect("wait for the hook mode");
    let _ = writer.join();
    Ran { code: out.status.code(), stdout: out.stdout, stderr: out.stderr, took: started.elapsed() }
}

fn hook_to(store_dir: &Folder, sid: &str, input: &[u8]) -> Ran {
    hook_run(&["--store", &store_dir.arg(), "--session", sid], input)
}

/// A connection standing in for the app: the JSON messages it read and has
/// not yet looked at, in the order they came, and what the terminal showed.
struct App {
    client: Client,
    got: Vec<Value>,
    screen: Vec<u8>,
    next_id: u64,
}

impl App {
    /// Connect, read the hello and ack it with `caps`.
    fn connect(rec: &Record, caps: &[&str]) -> App {
        let mut client = Client::to_record(rec, WAIT).expect("connect to the holder and read its hello");
        client.send(hello::ack_message(1, caps)).expect("ack the hello");
        App { client, got: Vec::new(), screen: Vec::new(), next_id: 2 }
    }

    /// Wait until the terminal has shown `needle`; messages that come
    /// meanwhile are kept.
    fn wait_text(&mut self, needle: &str) {
        let until = Instant::now() + WAIT;
        while !String::from_utf8_lossy(&self.screen).contains(needle) {
            match self.client.recv(until.saturating_duration_since(Instant::now())) {
                Ok(Some(Frame { channel: 1, body: Body::Raw(bytes) })) => self.screen.extend_from_slice(&bytes),
                Ok(Some(Frame { body: Body::Json(v), .. })) => self.got.push(v),
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => panic!("{needle:?} never appeared on the terminal: {:?}", String::from_utf8_lossy(&self.screen)),
            }
        }
    }

    fn id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 2;
        id
    }

    /// The next JSON message from the stream, before `until`; None at the
    /// end of the stream or when none came.
    fn read(&mut self, until: Instant) -> Option<Value> {
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            match self.client.recv(left) {
                Ok(Some(Frame { channel: 0, body: Body::Json(v) })) => return Some(v),
                Ok(Some(Frame { channel: 1, body: Body::Raw(bytes) })) => self.screen.extend_from_slice(&bytes),
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

    /// The next `n` messages, each of them a hook event.
    fn events(&mut self, n: usize) -> Vec<Value> {
        let mut out = Vec::new();
        for i in 0..n {
            let m = self.next(WAIT).unwrap_or_else(|| panic!("hook event {} of {n} never came", i + 1));
            assert_eq!(t_of(&m), "event", "expected a hook event, got {}", m.to_json());
            out.push(m);
        }
        out
    }

    /// True once the holder has closed this connection; what came before
    /// the end is kept.
    fn closed(&mut self) -> bool {
        let until = Instant::now() + WAIT;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            match self.client.recv(left) {
                Ok(Some(Frame { body: Body::Json(v), .. })) => self.got.push(v),
                Ok(Some(_)) => {}
                Ok(None) => return true,
                Err(e) if transport::is_timeout(&e) => return false,
                Err(_) => return true,
            }
        }
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

/// Launch the fake CLI from `app`'s connection.
fn launch(app: &mut App, cwd: &Folder) {
    launch_declaring(app, cwd, None);
}

/// Launch the fake CLI from `app`'s connection, declaring the hook kinds
/// its session takes (`hookKinds`), or none.
fn launch_declaring(app: &mut App, cwd: &Folder, kinds: Option<&[&str]>) {
    let id = app.id();
    let env = Value::Obj(launch_env().into_iter().map(|(k, v)| (k, Value::Str(v))).collect());
    let mut fields = vec![("argv", Value::strs(&[FAKE])), ("cwd", Value::Str(cwd.arg())), ("env", env), ("cols", Value::uint(120)), ("rows", Value::uint(30))];
    if let Some(kinds) = kinds {
        fields.push(("hookKinds", Value::strs(kinds)));
    }
    let launched = app.call(msg("term.launch", id, fields));
    assert_eq!(t_of(&launched), "term.launched", "{}", launched.to_json());
}

/// Attach `app` from offset 0. Nothing may come before the reply.
fn attach(app: &mut App) {
    let id = app.id();
    let attached = app.call(msg("term.attach", id, vec![("from", Value::uint(0))]));
    assert_eq!(t_of(&attached), "term.attached", "{}", attached.to_json());
    assert!(app.got.is_empty(), "before term.attached came {:?}", texts(&app.got));
}

/// Post one hook event from `app`'s connection; the seq it took.
fn post(app: &mut App, n: u64) -> u64 {
    let id = app.id();
    let payload = Value::obj(vec![("hook_event_name", Value::str("Notification")), ("n", Value::uint(n))]);
    let taken = app.call(msg("hook.event", id, vec![("kind", Value::str("Notification")), ("payload", payload)]));
    assert_eq!(t_of(&taken), "hook.taken", "{}", taken.to_json());
    num(&taken, "seq").expect("a seq")
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
fn hook_runs_reach_the_attached_app_in_order_and_whole() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-order");
    let work = Folder::new("work-order");
    let sid = "hooks-order-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = App::connect(&held.0, &ACK_CAPS);
    assert_eq!(app.client.hello.caps, vec!["core".to_string(), "local".to_string(), "hooks".to_string(), "mcp".to_string(), "away".to_string(), "screen".to_string(), "title".to_string(), "status".to_string()]);
    launch(&mut app, &work);
    attach(&mut app);

    // Three runs, three events: in order, seq rising by one, the payload as
    // Claude Code wrote it.
    let inputs = [
        event_input("Stop", ",\"stop_hook_active\":false"),
        event_input("Notification", ",\"message\":\"Claude needs your permission to use Bash\""),
        event_input("UserPromptSubmit", ",\"prompt\":\"caf\\u00e9 \\ud83d\\ude00 and a \\\"quote\\\"\""),
    ];
    for input in &inputs {
        let ran = hook_to(&store_dir, sid, input.as_bytes());
        assert!(ran.quiet(), "{}", ran.say());
    }
    let events = app.events(3);
    for (n, (event, input)) in events.iter().zip(&inputs).enumerate() {
        let sent = json::parse(input.as_bytes()).expect("the input is JSON");
        assert_eq!(num(event, "seq"), Some(n as u64 + 1), "{}", event.to_json());
        assert_eq!(event.get("kind"), sent.get("hook_event_name"), "{}", event.to_json());
        assert_eq!(event.get("payload"), Some(&sent), "the payload changed on the way: {}", event.to_json());
        assert!(event.get("lost").is_none(), "{}", event.to_json());
    }

    // A 100 KiB tool output: the tool's input and output become their
    // sizes, the rest is whole, and the payload says it was cut.
    let big = event_input("PostToolUse", &format!(",\"tool_name\":\"Bash\",\"tool_input\":{{\"command\":\"cat big.txt\"}},\"tool_response\":\"{}\"", "x".repeat(100 * 1024)));
    let ran = hook_to(&store_dir, sid, big.as_bytes());
    assert!(ran.quiet(), "{}", ran.say());
    let event = app.events(1).remove(0);
    assert_eq!(num(&event, "seq"), Some(4), "{}", event.to_json());
    let want = json::parse(event_input("PostToolUse", ",\"tool_name\":\"Bash\",\"tool_input\":{\"cut\":25},\"tool_response\":{\"cut\":102402},\"cut\":true").as_bytes()).expect("JSON");
    assert_eq!(event.get("payload"), Some(&want), "{}", event.to_json());

    // A tool output cut inside a surrogate pair, as Node writes it: the
    // lone half reads as the replacement character, and the event comes.
    let lone = event_input("PostToolUse", ",\"tool_name\":\"Bash\",\"tool_response\":\"cut mid-emoji \\ud83d\"");
    let ran = hook_to(&store_dir, sid, lone.as_bytes());
    assert!(ran.quiet(), "{}", ran.say());
    let event = app.events(1).remove(0);
    assert_eq!(num(&event, "seq"), Some(5), "{}", event.to_json());
    let response = event.get("payload").and_then(|p| p.get("tool_response")).and_then(Value::as_str);
    assert_eq!(response, Some("cut mid-emoji \u{fffd}"), "{}", event.to_json());
    end(&held.0);
}

#[test]
fn a_hook_run_that_cannot_pass_its_event_on_exits_0_and_says_nothing() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-quiet");
    let work = Folder::new("work-quiet");
    let sid = "hooks-quiet-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = App::connect(&held.0, &ACK_CAPS);
    launch(&mut app, &work);
    attach(&mut app);
    let good = event_input("Stop", "");

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
        let ran = hook_run(args, good.as_bytes());
        assert!(ran.quiet(), "{args:?}: {}", ran.say());
    }
    assert!(!missing.exists(), "the hook mode made the store");

    // What came on standard input is not an event this session takes:
    // nothing, not JSON, not an object, a kind its holder (launched with no
    // hookKinds, so the nine) does not take, a name given twice, or over
    // 4 MiB. The hook mode sends the other kind on (its own check is the
    // kind's shape alone) and the holder refuses it.
    let over = format!("{{\"hook_event_name\":\"Stop\",\"x\":\"{}\"}}", "x".repeat(4 * 1024 * 1024));
    for (what, input) in [
        ("nothing", Vec::new()),
        ("not JSON", b"not json".to_vec()),
        ("not an object", b"[\"Stop\"]".to_vec()),
        ("another kind", event_input("PermissionRequest", "").into_bytes()),
        ("a name given twice", event_input("Stop", ",\"hook_event_name\":\"PreToolUse\"").into_bytes()),
        ("over 4 MiB", over.into_bytes()),
    ] {
        let ran = hook_to(&store_dir, sid, &input);
        assert!(ran.quiet(), "{what}: {}", ran.say());
    }

    // None of those reached the holder. The attached app would have got it
    // within the run, so a second more is ample.
    if let Some(m) = app.next(Duration::from_secs(1)) {
        panic!("a run that should have sent nothing reached the app: {}", m.to_json());
    }

    // A holder that serves 16 connections already (the app and 15 more)
    // answers busy, and nothing reaches the app.
    let idle: Vec<Client> = (0..15).map(|_| Client::to_record(&held.0, WAIT).expect("an idle connection")).collect();
    let ran = hook_to(&store_dir, sid, good.as_bytes());
    assert!(ran.quiet(), "busy: {}", ran.say());
    assert!(ran.took < HOOK_BOUND, "busy: {}", ran.say());
    if let Some(m) = app.next(Duration::from_secs(1)) {
        panic!("a run the holder answered busy reached the app: {}", m.to_json());
    }
    drop(idle);

    // The next good run's event is the session's first, whole. (A run made
    // while the holder still counts the idle connections is busy too, and
    // is made again.)
    let mut first = None;
    for _ in 0..10 {
        let ran = hook_to(&store_dir, sid, good.as_bytes());
        assert!(ran.quiet(), "{}", ran.say());
        first = app.next(Duration::from_secs(3));
        if first.is_some() {
            break;
        }
    }
    let first = first.expect("no hook event came once the idle connections had gone");
    assert_eq!(t_of(&first), "event", "{}", first.to_json());
    assert_eq!(num(&first, "seq"), Some(1), "a run that should have sent nothing took a seq: {}", first.to_json());
    assert_eq!(first.get("payload"), Some(&json::parse(good.as_bytes()).expect("JSON")), "{}", first.to_json());
    end(&held.0);
}

#[test]
fn a_hook_run_against_a_stale_record_exits_0_and_leaves_the_record_as_it_is() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-stale");
    // A record whose holder is gone: nothing listens on its endpoint. The
    // hook mode writes no file: unlike list mode, it does not remove it.
    let sid = "hooks-stale-01";
    let gone = transport::endpoint_name(sid, &"0".repeat(transport::ENDPOINT_RANDOM_HEX));
    store::prepare(&store_dir.0).expect("a store");
    store::write(&store_dir.0, &record(sid, &gone)).expect("a record");
    let before = files(&store_dir);
    assert!(before.iter().any(|(name, _, _)| name == &format!("{sid}.json")), "no record: {before:?}");
    let ran = hook_to(&store_dir, sid, event_input("Stop", "").as_bytes());
    assert!(ran.quiet(), "a stale record: {}", ran.say());
    assert!(ran.took < HOOK_BOUND, "a stale record: {}", ran.say());
    assert_eq!(files(&store_dir), before, "the hook mode removed or changed a stale record");
}

#[test]
fn events_wait_while_no_connection_takes_them_and_the_last_256_come_with_the_count_lost() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-queue");
    let work = Folder::new("work-queue");
    let sid = "hooks-queue-01";
    let held = Held(hold(&store_dir, sid));

    // A connection that posts hook events and holds no terminal. The
    // holder writes nothing for them: the store is as it was.
    let mut poster = App::connect(&held.0, &ACK_CAPS);
    launch(&mut poster, &work);
    let before = files(&store_dir);
    assert!(!before.is_empty(), "no record in the store");
    for n in 1..=300 {
        assert_eq!(post(&mut poster, n), n);
    }
    assert_eq!(files(&store_dir), before, "posting hook events changed the store");

    // The app's own ack (core and local) takes the terminal and is never
    // sent a hook event; it may not post one either.
    let mut plain = App::connect(&held.0, &LOCAL_CAPS);
    attach(&mut plain);
    if let Some(m) = plain.next(Duration::from_secs(1)) {
        panic!("a connection that did not ack hooks got {}", m.to_json());
    }
    plain.client.send(msg("hook.event", 100, vec![("kind", Value::str("Stop")), ("payload", Value::obj(Vec::new()))])).expect("send");
    let refused = plain.next(WAIT).expect("an answer");
    assert_eq!((t_of(&refused), refused.get("code").and_then(Value::as_str)), ("error", Some("unknown-type")), "{}", refused.to_json());
    assert!(plain.closed(), "the holder kept a connection that sent a type it does not allow");

    // A connection that acks hooks and attaches gets the newest 256 right
    // after its reply, the first saying 44 were lost.
    let mut app = App::connect(&held.0, &ACK_CAPS);
    attach(&mut app);
    let events = app.events(256);
    for (i, event) in events.iter().enumerate() {
        let seq = 45 + i as u64;
        assert_eq!(num(event, "seq"), Some(seq), "{}", event.to_json());
        assert_eq!(event.get("payload").and_then(|p| num(p, "n")), Some(seq), "{}", event.to_json());
        let lost = if i == 0 { Some(44) } else { None };
        assert_eq!(num(event, "lost"), lost, "{}", event.to_json());
    }
    // The poster holds no terminal: it got none of them.
    if let Some(m) = poster.next(Duration::from_millis(500)) {
        panic!("the poster got {}", m.to_json());
    }

    // Detached, the app gets no more; the next attach gets what came
    // meanwhile, with nothing lost.
    let id = app.id();
    let detached = app.call(msg("term.detach", id, vec![]));
    assert_eq!(t_of(&detached), "term.detached", "{}", detached.to_json());
    assert_eq!(post(&mut poster, 301), 301);
    assert_eq!(post(&mut poster, 302), 302);
    assert!(app.closed(), "the holder kept a detached connection open");
    assert!(app.got.iter().all(|m| t_of(m) != "event"), "a hook event after term.detached: {:?}", texts(&app.got));
    let mut again = App::connect(&held.0, &ACK_CAPS);
    attach(&mut again);
    let events = again.events(2);
    assert_eq!(events.iter().map(|e| num(e, "seq")).collect::<Vec<_>>(), vec![Some(301), Some(302)]);
    assert!(events.iter().all(|e| e.get("lost").is_none()), "{:?}", texts(&events));
    end(&held.0);
}

#[test]
fn a_holder_that_ends_drops_its_hook_events_and_the_next_one_counts_from_1() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-ends");
    let work = Folder::new("work-ends");
    let sid = "hooks-ends-01";

    // Two events wait in a holder no connection takes them from; it ends.
    let first = Held(hold(&store_dir, sid));
    let mut poster = App::connect(&first.0, &ACK_CAPS);
    launch(&mut poster, &work);
    assert_eq!(post(&mut poster, 1), 1);
    assert_eq!(post(&mut poster, 2), 2);
    end(&first.0);
    assert!(!pids::alive(first.0.pid), "the first holder still runs");

    // A new holder of the session has none of them, and counts from 1.
    let second = Held(hold(&store_dir, sid));
    let mut app = App::connect(&second.0, &ACK_CAPS);
    launch(&mut app, &work);
    attach(&mut app);
    if let Some(m) = app.next(Duration::from_secs(1)) {
        panic!("a new holder sent {}", m.to_json());
    }
    let mut poster = App::connect(&second.0, &ACK_CAPS);
    assert_eq!(post(&mut poster, 3), 1);
    let event = app.events(1).remove(0);
    assert_eq!(event.get("payload").and_then(|p| num(p, "n")), Some(3), "{}", event.to_json());
    assert!(event.get("lost").is_none(), "{}", event.to_json());
    end(&second.0);
}

#[test]
fn a_holder_whose_hello_does_not_offer_hooks_is_sent_nothing() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-older");
    let sid = "hooks-older-01";
    let read = stand_in(&store_dir, sid, Some(&LOCAL_CAPS[..]));
    let ran = hook_to(&store_dir, sid, event_input("Stop", "").as_bytes());
    assert!(ran.quiet(), "{}", ran.say());
    assert!(ran.took < HOOK_BOUND, "{}", ran.say());
    let bytes = read.recv_timeout(WAIT).expect("the stand-in saw the hook mode go");
    assert_eq!(bytes.len(), 0, "the hook mode wrote to a holder that does not offer hooks");
}

#[test]
fn a_hook_run_against_a_holder_that_never_answers_ends_by_its_deadline() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-mute");
    let input = event_input("Stop", "");

    // A hello that offers what a holder of this version offers, then
    // nothing: the hook mode acks, sends its event, and waits for a reply
    // that never comes. Its ack is its own three caps, never `mcp`, so a
    // holder from 2.1.3-beta.8 or beta.9 takes it too.
    let sid = "hooks-mute-0001";
    let read = stand_in(&store_dir, sid, Some(&HOLDER_CAPS[..]));
    let ran = hook_to(&store_dir, sid, input.as_bytes());
    assert!(ran.quiet(), "{}", ran.say());
    assert!(ran.took < HOOK_BOUND, "{}", ran.say());
    let bytes = read.recv_timeout(WAIT).expect("the stand-in saw the hook mode go");
    let ack = match frame::read_frame(&mut Cursor::new(&bytes[..]), Direction::AppToHelper) {
        Ok(Some(Frame { channel: 0, body: Body::Json(v) })) => v,
        Ok(Some(f)) => panic!("the hook mode's first frame is not a message: {f:?}"),
        Ok(None) => panic!("the hook mode sent nothing to a holder that offers hooks"),
        Err(e) => panic!("the hook mode's first frame does not read ({e}): {} bytes", bytes.len()),
    };
    assert_eq!(t_of(&ack), "hello.ack", "{}", ack.to_json());
    assert_eq!(hello::parse_ack(&ack), Some((1, vec!["core".to_string(), "local".to_string(), "hooks".to_string()])), "{}", ack.to_json());

    // No hello at all.
    let sid = "hooks-mute-0002";
    let _read = stand_in(&store_dir, sid, None);
    let ran = hook_to(&store_dir, sid, input.as_bytes());
    assert!(ran.quiet(), "{}", ran.say());
    assert!(ran.took < HOOK_BOUND, "{}", ran.say());
}

#[test]
fn a_hook_run_whose_standard_input_never_ends_ends_by_its_deadline() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-open");
    let store_arg = store_dir.arg();
    let started = Instant::now();
    let mut child = Command::new(HELPER)
        .args(["hook", "--store", store_arg.as_str(), "--session", "hooks-open-0001"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start the hook mode");
    // Part of an event, and the input left open, as a writer that hangs.
    let mut stdin = child.stdin.take().expect("its standard input");
    let _ = stdin.write_all(b"{\"hook_event_name\":\"Stop\",");
    let _ = stdin.flush();
    let mut ended = None;
    while ended.is_none() && started.elapsed() < WAIT {
        ended = child.try_wait().expect("look at the hook mode");
        std::thread::sleep(Duration::from_millis(20));
    }
    let took = started.elapsed();
    if ended.is_none() {
        let _ = child.kill();
    }
    let out = child.wait_with_output().expect("the hook mode's output");
    drop(stdin);
    let ran = Ran { code: out.status.code(), stdout: out.stdout, stderr: out.stderr, took };
    assert!(ran.quiet(), "{}", ran.say());
    assert!(ran.took < HOOK_BOUND, "{}", ran.say());
}

/// An argument that is not Unicode: bytes that are not UTF-8 on macOS and
/// Linux, a lone surrogate on Windows.
fn not_unicode() -> OsString {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        OsString::from_vec(b"/tmp/aicc-\xff-store".to_vec())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        let mut wide: Vec<u16> = "C:\\aicc-".encode_utf16().collect();
        wide.push(0xD800);
        OsString::from_wide(&wide)
    }
}

#[test]
fn a_hook_run_with_an_argument_that_is_not_unicode_exits_0_and_says_nothing() {
    let _serial = one_at_a_time();
    for args in [
        vec![OsString::from("hook"), OsString::from("--store"), not_unicode(), OsString::from("--session"), OsString::from("hooks-wide-0001")],
        vec![OsString::from("hook"), not_unicode()],
    ] {
        let started = Instant::now();
        let out = Command::new(HELPER).args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output().expect("run the hook mode");
        let ran = Ran { code: out.status.code(), stdout: out.stdout, stderr: out.stderr, took: started.elapsed() };
        assert!(ran.quiet(), "{args:?}: {}", ran.say());
    }
}

#[test]
fn no_hook_event_follows_term_exit_and_the_next_attach_gets_what_came_after() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-exit");
    let work = Folder::new("work-exit");
    let sid = "hooks-exit-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = App::connect(&held.0, &ACK_CAPS);
    launch(&mut app, &work);
    attach(&mut app);
    app.wait_text("FAKE-CLI READY");
    app.client.send_raw(1, b"exit 3\r").expect("type into the terminal");
    let exit = app.next(WAIT).expect("a message once the program exits");
    assert_eq!((t_of(&exit), num(&exit, "code")), ("term.exit", Some(3)), "{}", exit.to_json());

    // An event after the program's end is not sent to the app that was told
    // of the end: it waits, and the next attach gets it after its reply.
    let mut poster = App::connect(&held.0, &ACK_CAPS);
    assert_eq!(post(&mut poster, 1), 1);
    if let Some(m) = app.next(Duration::from_secs(1)) {
        panic!("after term.exit the app got {}", m.to_json());
    }
    let mut again = App::connect(&held.0, &ACK_CAPS);
    attach(&mut again);
    let events = again.events(1);
    assert_eq!(num(&events[0], "seq"), Some(1), "{}", events[0].to_json());
    assert!(events[0].get("lost").is_none(), "{}", events[0].to_json());
    end(&held.0);
}

/// Six kinds a launch may declare for a CLI other than Claude Code (section 5
/// of the 2.1.3-beta.18 plan declares these for a held session):
/// PermissionRequest, not one of the nine, among them.
const DECLARED_SIX: [&str; 6] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"];

#[test]
fn the_kinds_a_launch_declares_decide_which_hook_events_its_holder_takes() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-kinds");
    let work = Folder::new("work-kinds");
    let permission = event_input("PermissionRequest", ",\"tool_name\":\"Bash\"");
    let notification = event_input("Notification", ",\"message\":\"Claude is waiting for your input\"");
    let stop = event_input("Stop", "");

    // A holder launched with the six: the hook mode, run as a CLI runs it,
    // passes PermissionRequest and Stop on, and the holder refuses
    // Notification, which is not among them. Each run is answered at once.
    let sid = "hooks-kinds-01";
    let declared = Held(hold(&store_dir, sid));
    let mut app = App::connect(&declared.0, &ACK_CAPS);
    launch_declaring(&mut app, &work, Some(&DECLARED_SIX[..]));
    attach(&mut app);
    for input in [&permission, &notification, &stop] {
        let ran = hook_to(&store_dir, sid, input.as_bytes());
        assert!(ran.quiet() && ran.took < HOOK_BOUND, "{}", ran.say());
    }
    let events = app.events(2);
    for (n, (event, input)) in events.iter().zip([&permission, &stop]).enumerate() {
        let sent = json::parse(input.as_bytes()).expect("JSON");
        assert_eq!(num(event, "seq"), Some(n as u64 + 1), "{}", event.to_json());
        assert_eq!(event.get("kind"), sent.get("hook_event_name"), "{}", event.to_json());
        assert_eq!(event.get("payload"), Some(&sent), "{}", event.to_json());
    }
    if let Some(m) = app.next(Duration::from_secs(1)) {
        panic!("a kind the launch did not declare reached the app: {}", m.to_json());
    }
    end(&declared.0);

    // A holder launched without hookKinds takes the nine, as before:
    // Notification is passed on and PermissionRequest is dropped.
    let sid = "hooks-kinds-02";
    let nine = Held(hold(&store_dir, sid));
    let mut app = App::connect(&nine.0, &ACK_CAPS);
    launch(&mut app, &work);
    attach(&mut app);
    for input in [&permission, &notification] {
        let ran = hook_to(&store_dir, sid, input.as_bytes());
        assert!(ran.quiet() && ran.took < HOOK_BOUND, "{}", ran.say());
    }
    let event = app.events(1).remove(0);
    assert_eq!((num(&event, "seq"), event.get("kind").and_then(Value::as_str)), (Some(1), Some("Notification")), "{}", event.to_json());
    if let Some(m) = app.next(Duration::from_secs(1)) {
        panic!("PermissionRequest reached the app through a holder that declared no kinds: {}", m.to_json());
    }
    end(&nine.0);
}

#[test]
fn a_hook_run_reads_a_store_and_a_session_left_out_from_the_environment() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-env");
    let work = Folder::new("work-env");
    let sid = "hooks-env-0001";
    let held = Held(hold(&store_dir, sid));
    let mut app = App::connect(&held.0, &ACK_CAPS);
    launch(&mut app, &work);
    attach(&mut app);
    let store_arg = store_dir.arg();
    let stop = event_input("Stop", "");

    // Both from the environment; the session from the command line over a
    // variable that names another; the store from the command line and the
    // session from its variable.
    let runs: [(&[&str], Vec<(&str, &str)>); 3] = [
        (&[], vec![(STORE_ENV, store_arg.as_str()), (SESSION_ENV, sid)]),
        (&["--session", sid], vec![(STORE_ENV, store_arg.as_str()), (SESSION_ENV, "hooks-other-01")]),
        (&["--store", store_arg.as_str()], vec![(SESSION_ENV, sid)]),
    ];
    for (n, (args, env)) in runs.iter().enumerate() {
        let ran = hook_run_with(args, stop.as_bytes(), env);
        assert!(ran.quiet(), "{args:?} {env:?}: {}", ran.say());
        let event = app.events(1).remove(0);
        assert_eq!(num(&event, "seq"), Some(n as u64 + 1), "{args:?} {env:?}: {}", event.to_json());
    }
    // A session named by neither: nothing.
    let ran = hook_run_with(&[], stop.as_bytes(), &[(STORE_ENV, store_arg.as_str())]);
    assert!(ran.quiet(), "{}", ran.say());
    if let Some(m) = app.next(Duration::from_secs(1)) {
        panic!("a run with no session reached the app: {}", m.to_json());
    }
    end(&held.0);
}
