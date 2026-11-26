//! A holder that runs until it is ended (`hold --until-ended`, from
//! 2.1.3-beta.19, protocol change 14), as a program over its local
//! transport, the way the app uses it for an SSH Persistent tab:
//!
//! - It has no away clock: with nobody attached it outlives a clock holder's
//!   away time, and it ends with its program, or at `term.end`.
//! - Its record keeps today's fields with `away` null and
//!   `"lifetime":"until-ended"` after it, and list mode prints it so; a clock
//!   holder's record is today's, field for field.
//! - While nobody is attached it keeps the newest status, queues hook events,
//!   and its relay holds a tool call and then gives the fixed answer, as a
//!   clock holder does (that code is unchanged, serve.rs and relay.rs).
//! - On macOS and Linux its socket and run folder are marked as used often
//!   enough that a cleaner of old files in /tmp never finds them old (the
//!   Raspberry Pi notes, 2: systemd-tmpfiles takes entries untouched for 10
//!   days), and a socket taken all the same is bound again at the same name,
//!   so the holder is still reached. Both for either kind of holder.
//!
//! The records are read here as JSON, the bytes the app reads.

use aicc_helper::client::Client;
use aicc_helper::frame::{Body, Frame};
use aicc_helper::hello;
use aicc_helper::json::{self, Value};
use aicc_helper::pids;
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
const FAKE: &str = env!("CARGO_BIN_EXE_aicc-fake-cli");
const WAIT: Duration = Duration::from_secs(20);
/// How long the relay holds a call in the build `cargo test` runs
/// (`relay::TEST_HOLD`); the build the installer ships holds 30 s.
const HOLD: Duration = Duration::from_secs(4);
/// ADR-030 D1's words: the relay's answer in the app's place.
const UPDATING: &str = "AI Code Conductor is updating, try again shortly";
/// What the app acks on a helper tab's connection: the terminal, hook
/// events, tool streams and the status line.
const APP_ACK: [&str; 5] = ["core", "local", "hooks", "mcp", "status"];
/// A clock holder's record: today's twelve fields, in their order.
const CLOCK_FIELDS: [&str; 12] = ["v", "session", "label", "pid", "endpoint", "nonce", "helper", "started", "away", "attached", "child", "code"];
/// An until-ended holder's record: the same with `lifetime` after `away`.
const UNTIL_ENDED_FIELDS: [&str; 13] = ["v", "session", "label", "pid", "endpoint", "nonce", "helper", "started", "away", "lifetime", "attached", "child", "code"];

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// Every test here starts processes, one at a time (as probe_transport.rs).
fn one_at_a_time() -> MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A new, empty folder of this test, its mode set outright on Unix, removed
/// when dropped.
struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Folder {
        let dir = std::env::temp_dir().join(format!("aicc-until-ended-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a folder");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).expect("its mode");
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

/// A holder's record as `hold --detach` and `list` print it.
#[derive(Clone, Debug)]
struct Rec(Value);

impl Rec {
    fn text(&self, key: &str) -> String {
        self.0.get(key).and_then(Value::as_str).unwrap_or_else(|| panic!("no string {key} in {}", self.0.to_json())).to_string()
    }

    fn pid(&self) -> u32 {
        self.0.get("pid").and_then(Value::as_u64).expect("a pid") as u32
    }

    fn keys(&self) -> Vec<String> {
        self.0.keys().expect("an object").into_iter().map(str::to_string).collect()
    }
}

fn t_of(v: &Value) -> &str {
    v.get("t").and_then(Value::as_str).unwrap_or("")
}

fn texts(messages: &[Value]) -> Vec<String> {
    messages.iter().map(Value::to_json).collect()
}

fn msg(t: &str, id: u64, more: Vec<(&str, Value)>) -> Value {
    let mut members = vec![("t", Value::str(t)), ("id", Value::uint(id))];
    members.extend(more);
    Value::obj(members)
}

/// Run the helper with `args`, its output going to files (a holder it
/// starts outlives it, and would hold a pipe open): its exit code, standard
/// output and standard error.
fn run_detaching(args: &[&str], tag: &str) -> (Option<i32>, String, String) {
    let base = std::env::temp_dir().join(format!("aicc-until-ended-run-{tag}-{}", std::process::id()));
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
    (status.code(), stdout, stderr)
}

/// Start a detached holder with `lifetime` (`--until-ended`, or `--away N`);
/// the record it printed.
fn hold(store: &Folder, sid: &str, lifetime: &[&str]) -> Rec {
    let store_arg = store.arg();
    let mut args: Vec<&str> = vec!["hold", "--detach", "--store", store_arg.as_str(), "--session", sid, "--label", "Test terminal"];
    args.extend_from_slice(lifetime);
    let (code, stdout, stderr) = run_detaching(&args, sid);
    assert_eq!(code, Some(0), "hold --detach {lifetime:?} failed: {stdout} / {stderr}");
    Rec(json::parse(stdout.trim().as_bytes()).unwrap_or_else(|e| panic!("hold printed {stdout:?} ({e:?})")))
}

/// The sessions list mode prints.
fn list(store: &Folder) -> Vec<Rec> {
    let store_arg = store.arg();
    let out = Command::new(HELPER).args(["list", "--store", store_arg.as_str()]).output().expect("run list");
    assert!(out.status.success(), "list failed: {}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let v = json::parse(text.trim().as_bytes()).unwrap_or_else(|e| panic!("list printed {text:?} ({e:?})"));
    v.get("sessions").and_then(Value::as_array).expect("sessions").iter().cloned().map(Rec).collect()
}

/// The record file of `sid` in `store`, if there is one.
fn record_file(store: &Folder, sid: &str) -> Option<Value> {
    let bytes = fs::read(store.0.join(format!("{sid}.json"))).ok()?;
    Some(json::parse(&bytes).expect("a record file is JSON"))
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

/// What a launch hands the fake CLI: this test's environment, as much of it
/// as a launch allows.
fn launch_env() -> Value {
    let mut seen: Vec<String> = Vec::new();
    let mut env: Vec<(String, Value)> = Vec::new();
    for (k, v) in std::env::vars() {
        let folded = k.to_uppercase();
        if k.is_empty() || k.contains('=') || k.chars().count() > 255 || v.chars().count() > 32767 || seen.contains(&folded) {
            continue;
        }
        seen.push(folded);
        env.push((k, Value::Str(v)));
    }
    env.truncate(1000);
    Value::Obj(env)
}

/// One connection to a holder, as the app holds it.
struct App {
    client: Client,
    got: Vec<Value>,
    screen: Vec<u8>,
    next_id: u64,
}

impl App {
    /// Connect, read the hello (it must carry the record's nonce and
    /// session) and ack it with `caps`.
    fn connect(rec: &Rec, caps: &[&str]) -> App {
        let mut client = Client::connect(&rec.text("endpoint"), &rec.text("nonce"), &rec.text("session"), WAIT).expect("connect to the holder and read its hello");
        client.send(hello::ack_message(1, caps)).expect("ack the hello");
        App { client, got: Vec::new(), screen: Vec::new(), next_id: 2 }
    }

    fn id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 2;
        id
    }

    /// Read one frame by `until`: false at the end of the stream, on an
    /// error, or once `until` has passed.
    fn pump(&mut self, until: Instant) -> bool {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        match self.client.recv(left) {
            Ok(Some(Frame { body: Body::Json(v), .. })) => {
                self.got.push(v);
                true
            }
            Ok(Some(Frame { body: Body::Raw(bytes), .. })) => {
                self.screen.extend_from_slice(&bytes);
                true
            }
            Ok(None) | Err(_) => false,
        }
    }

    /// The first message `pick` chooses, from those that came or come.
    fn wait_for(&mut self, what: &str, pick: impl Fn(&Value) -> bool) -> Value {
        let until = Instant::now() + WAIT;
        loop {
            if let Some(at) = self.got.iter().position(&pick) {
                return self.got.remove(at);
            }
            if !self.pump(until) {
                panic!("no {what}; got {:?}", texts(&self.got));
            }
        }
    }

    /// Send `v` and wait for the message that answers its id.
    fn call(&mut self, v: Value) -> Value {
        let id = v.get("id").and_then(Value::as_u64).expect("a request id");
        self.client.send(v).expect("send a request");
        self.wait_for(&format!("answer to request {id}"), |m| m.get("re").and_then(Value::as_u64) == Some(id))
    }

    /// Launch `argv` in `cwd`; the program's process id.
    fn launch(&mut self, argv: &[&str], cwd: &Folder) -> u32 {
        let id = self.id();
        let launched = self.call(msg(
            "term.launch",
            id,
            vec![("argv", Value::strs(argv)), ("cwd", Value::Str(cwd.arg())), ("env", launch_env()), ("cols", Value::uint(120)), ("rows", Value::uint(30))],
        ));
        assert_eq!(t_of(&launched), "term.launched", "{}", launched.to_json());
        launched.get("pid").and_then(Value::as_u64).expect("a pid") as u32
    }

    fn attach(&mut self) {
        let id = self.id();
        let attached = self.call(msg("term.attach", id, vec![("from", Value::uint(0))]));
        assert_eq!(t_of(&attached), "term.attached", "{}", attached.to_json());
    }

    fn wait_text(&mut self, needle: &str) {
        let until = Instant::now() + WAIT;
        while !String::from_utf8_lossy(&self.screen).contains(needle) {
            if !self.pump(until) {
                panic!("{needle:?} never appeared on the terminal: {:?}", String::from_utf8_lossy(&self.screen));
            }
        }
    }

    fn type_line(&mut self, line: &str) {
        self.client.send_raw(1, format!("{line}\r").as_bytes()).expect("type into the terminal");
    }
}

/// Launch the fake CLI from a connection of its own, then let go of it
/// without attaching: the program runs and nobody is attached.
fn launch_and_let_go(rec: &Rec, cwd: &Folder) -> u32 {
    let mut app = App::connect(rec, &hello::LOCAL_CAPS);
    app.launch(&[FAKE], cwd)
}

/// End a holder from a fresh connection and wait for it to be gone.
fn end(rec: &Rec) {
    let mut app = App::connect(rec, &hello::LOCAL_CAPS);
    let id = app.id();
    let ended = app.call(msg("term.end", id, vec![]));
    assert_eq!(t_of(&ended), "term.ended", "{}", ended.to_json());
    assert!(gone(rec.pid(), WAIT), "the holder outlived term.end");
}

/// A holder this test started, ended when dropped if it still runs (a test
/// that fails leaves none behind). Declared after its folders.
struct Held(Rec);

impl Drop for Held {
    fn drop(&mut self) {
        if !pids::alive(self.0.pid()) {
            return;
        }
        if let Ok(mut client) = Client::connect(&self.0.text("endpoint"), &self.0.text("nonce"), &self.0.text("session"), WAIT) {
            if client.send(hello::ack_message(1, &hello::LOCAL_CAPS)).is_ok() && client.send(msg("term.end", 2, vec![])).is_ok() {
                gone(self.0.pid(), WAIT);
            }
        }
    }
}

#[test]
fn an_until_ended_holder_outlives_a_clock_holders_away_time_and_list_names_its_kind() {
    let _serial = one_at_a_time();
    let store = Folder::new("store-outlives");
    let work = Folder::new("work-outlives");
    // Both launched, and nobody attached: only the clock holder runs out.
    // Each is launched right after its start, well inside 3 s.
    let kept = Held(hold(&store, "until-0001", &["--until-ended"]));
    let child = launch_and_let_go(&kept.0, &work);
    let clocked = Held(hold(&store, "until-0002", &["--away", "3"]));
    launch_and_let_go(&clocked.0, &work);
    // The clock holder's record is today's, field for field; the
    // until-ended one has no away clock and says so.
    assert_eq!(clocked.0.keys(), CLOCK_FIELDS.to_vec(), "{}", clocked.0 .0.to_json());
    assert_eq!(clocked.0 .0.get("away").and_then(Value::as_u64), Some(3));
    assert_eq!(kept.0.keys(), UNTIL_ENDED_FIELDS.to_vec(), "{}", kept.0 .0.to_json());
    assert_eq!(kept.0 .0.get("away"), Some(&Value::Null));
    assert_eq!(kept.0.text("lifetime"), "until-ended");
    assert!(gone(clocked.0.pid(), WAIT), "the clock holder outlived its 3 s away time");
    std::thread::sleep(Duration::from_secs(4));
    assert!(pids::alive(kept.0.pid()), "the until-ended holder ran out like a clock holder");
    assert!(pids::alive(child), "the until-ended holder's program was ended");
    // List mode names it, with its kind, as start-up and the Machines page read it.
    let listed = list(&store);
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(listed[0].text("session"), "until-0001");
    assert_eq!(listed[0].keys(), UNTIL_ENDED_FIELDS.to_vec());
    assert_eq!(listed[0].0.get("away"), Some(&Value::Null));
    assert_eq!(listed[0].text("lifetime"), "until-ended");
    assert_eq!(listed[0].text("child"), "running");
    // It ends at term.end: its program, its record and its socket with it.
    end(&kept.0);
    assert!(gone(child, WAIT), "the program outlived term.end");
    assert!(record_file(&store, "until-0001").is_none(), "the record outlived the holder");
    #[cfg(unix)]
    assert!(!Path::new(&kept.0.text("endpoint")).exists(), "the socket outlived the holder");
}

#[test]
fn an_until_ended_holder_ends_with_its_program_when_nobody_is_attached() {
    let _serial = one_at_a_time();
    let store = Folder::new("store-program");
    let work = Folder::new("work-program");
    let kept = Held(hold(&store, "until-0003", &["--until-ended"]));
    // A program that sleeps 2 s and exits, launched from a connection that
    // never attaches.
    let child = {
        let mut app = App::connect(&kept.0, &hello::LOCAL_CAPS);
        app.launch(&[FAKE, "--sleep", "2"], &work)
    };
    assert!(gone(child, WAIT), "the program did not exit");
    assert!(gone(kept.0.pid(), WAIT), "the until-ended holder outlived its program");
    assert!(record_file(&store, "until-0003").is_none(), "the record outlived the holder");
    #[cfg(unix)]
    assert!(!Path::new(&kept.0.text("endpoint")).exists(), "the socket outlived the holder");
}

#[test]
fn an_until_ended_holder_whose_program_exits_with_the_app_attached_ends_once_the_app_lets_go() {
    let _serial = one_at_a_time();
    let store = Folder::new("store-attached");
    let work = Folder::new("work-attached");
    let kept = Held(hold(&store, "until-0004", &["--until-ended"]));
    let mut app = App::connect(&kept.0, &hello::LOCAL_CAPS);
    app.launch(&[FAKE], &work);
    app.attach();
    app.wait_text("FAKE-CLI READY");
    app.type_line("exit 3");
    let exit = app.wait_for("term.exit", |m| t_of(m) == "term.exit");
    assert_eq!(exit.get("code").and_then(Value::as_i64), Some(3), "{}", exit.to_json());
    // The attached app sees the end: the holder waits for it, as any does.
    std::thread::sleep(Duration::from_secs(1));
    assert!(pids::alive(kept.0.pid()), "the holder did not wait for the attached app");
    drop(app);
    assert!(gone(kept.0.pid(), WAIT), "the until-ended holder outlived its program once the app let go");
    assert!(record_file(&store, "until-0004").is_none(), "the record outlived the holder");
}

/// A status as Claude Code writes it to its status line command.
fn status_input(n: u64) -> String {
    format!("{{\"session_id\":\"0b7c5f1e-6a3d-4c8e-9f21-5d4e3c2b1a00\",\"model\":{{\"id\":\"model-1\",\"display_name\":\"Model\"}},\"n\":{n}}}")
}

/// A hook event as Claude Code writes it.
fn event_input(n: u64) -> String {
    format!("{{\"session_id\":\"0b7c5f1e-6a3d-4c8e-9f21-5d4e3c2b1a00\",\"cwd\":\"/home/u/p\",\"hook_event_name\":\"Notification\",\"n\":{n}}}")
}

/// Run `aicc-helper <mode>` (status or hook) for the session, with `input`
/// on its standard input, as a CLI runs it: it exits 0 and says nothing.
fn feed(mode: &str, store: &Folder, sid: &str, input: &str) {
    let store_arg = store.arg();
    let mut child = Command::new(HELPER)
        .args([mode, "--store", store_arg.as_str(), "--session", sid])
        .env_remove("AICC_HELPER_STORE")
        .env_remove("AICC_HELPER_SESSION")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start the mode");
    let mut stdin = child.stdin.take().expect("its standard input");
    let _ = stdin.write_all(input.as_bytes());
    drop(stdin);
    let out = child.wait_with_output().expect("wait for the mode");
    assert_eq!(out.status.code(), Some(0), "{mode}");
    assert!(out.stdout.is_empty() && out.stderr.is_empty(), "{mode} said {:?} / {:?}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
}

/// The relay as a CLI runs it for its tool server: pipes for its standard
/// input and output, each line it prints read as it comes.
struct Relay {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: mpsc::Receiver<String>,
}

impl Relay {
    fn start(store: &Folder, sid: &str) -> Relay {
        let store_arg = store.arg();
        let mut child = Command::new(HELPER)
            .args(["mcp", "--store", store_arg.as_str(), "--session", sid])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the relay");
        let stdout = child.stdout.take().expect("its standard output");
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            let mut out = std::io::BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match out.read_line(&mut line) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {
                        if tx.send(line).is_err() {
                            return;
                        }
                    }
                }
            }
        });
        Relay { stdin: child.stdin.take(), child, lines }
    }

    fn write(&mut self, text: &str) {
        let stdin = self.stdin.as_mut().expect("its standard input is open");
        stdin.write_all(text.as_bytes()).expect("write to the relay");
        stdin.flush().expect("flush the relay's input");
    }

    fn line(&self, wait: Duration) -> Option<String> {
        self.lines.recv_timeout(wait).ok()
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.stdin = None;
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

#[test]
fn with_nobody_attached_an_until_ended_holder_keeps_the_newest_status_queues_hook_events_and_holds_a_tool_call() {
    let _serial = one_at_a_time();
    let store = Folder::new("store-away");
    let work = Folder::new("work-away");
    let sid = "until-0005";
    let kept = Held(hold(&store, sid, &["--until-ended"]));
    launch_and_let_go(&kept.0, &work);
    let since = Instant::now();
    // Three statuses: one slot keeps the newest. Two hook events: they wait.
    for n in 1..=3 {
        feed("status", &store, sid, &status_input(n));
    }
    for n in 1..=2 {
        feed("hook", &store, sid, &event_input(n));
    }
    // A tool call from the CLI's relay: held, then the fixed answer.
    let mut relay = Relay::start(&store, sid);
    let written = Instant::now();
    relay.write("{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"tools/call\",\"params\":{\"name\":\"echo\",\"arguments\":{\"text\":\"call 11\"}}}\n");
    let answer = relay.line(HOLD + Duration::from_secs(10)).expect("the held tool call was never answered");
    assert!(written.elapsed() >= HOLD, "the held tool call was answered after {:?}, before its time", written.elapsed());
    assert_eq!(answer, format!("{{\"jsonrpc\":\"2.0\",\"id\":11,\"result\":{{\"content\":[{{\"type\":\"text\",\"text\":\"{UPDATING}\"}}],\"isError\":true}}}}\n"));
    // Past a 3 s clock's time all along with nobody attached: still held.
    if since.elapsed() < Duration::from_secs(4) {
        std::thread::sleep(Duration::from_secs(4) - since.elapsed());
    }
    assert!(pids::alive(kept.0.pid()), "the until-ended holder ended with nobody attached");
    // The app comes back: the newest status once, on its ack; the two hook
    // events in order after its attach; and the relay's kept stream.
    let mut app = App::connect(&kept.0, &APP_ACK);
    let status = app.wait_for("the newest status", |m| t_of(m) == "status");
    assert_eq!(status.get("seq").and_then(Value::as_u64), Some(3), "{}", status.to_json());
    assert_eq!(status.get("payload").and_then(|p| p.get("n")).and_then(Value::as_u64), Some(3), "{}", status.to_json());
    app.attach();
    for n in 1..=2 {
        let event = app.wait_for("a hook event", |m| t_of(m) == "event");
        assert_eq!(event.get("seq").and_then(Value::as_u64), Some(n), "{}", event.to_json());
        assert_eq!(event.get("payload").and_then(|p| p.get("n")).and_then(Value::as_u64), Some(n), "{}", event.to_json());
    }
    app.wait_for("the relay's kept stream", |m| t_of(m) == "mcp.open");
    assert!(app.got.iter().all(|m| t_of(m) != "status"), "a second status: {:?}", texts(&app.got));
    drop(relay);
    drop(app);
    end(&kept.0);
}

/// The Raspberry Pi notes, 4: with sshd's `ClientAliveInterval 0` nothing
/// tells the far side that a link died, so a bridge whose ssh link is lost
/// keeps its connection to the holder open. The holder notices by itself: a
/// connection with no frame from the app in 60 s (the app pings every 15 s)
/// is dropped, and the session is kept, detached, for the next attach.
#[test]
fn a_connection_that_goes_silent_is_dropped_after_60_s_and_the_session_is_kept() {
    let _serial = one_at_a_time();
    let store = Folder::new("store-silent");
    let work = Folder::new("work-silent");
    let sid = "until-0012";
    let kept = Held(hold(&store, sid, &["--until-ended"]));
    let mut app = App::connect(&kept.0, &hello::LOCAL_CAPS);
    let child = app.launch(&[FAKE], &work);
    app.attach();
    // The attach was the app's last frame: from here it sends nothing, and
    // its connection stays open.
    let silent = Instant::now();
    app.wait_text("FAKE-CLI READY");
    let until = silent + Duration::from_secs(80);
    while app.pump(until) {}
    let took = silent.elapsed();
    assert!(took < Duration::from_secs(80), "a silent connection was kept for {took:?}");
    assert!(took >= Duration::from_secs(50), "a silent connection was dropped after {took:?}, before the 60 s");
    assert!(pids::alive(kept.0.pid()) && pids::alive(child), "the session was ended with the connection");
    let deadline = Instant::now() + WAIT;
    while record_file(&store, sid).and_then(|r| r.get("attached").and_then(Value::as_bool)) != Some(false) {
        assert!(Instant::now() < deadline, "the record still says attached");
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut again = App::connect(&kept.0, &hello::LOCAL_CAPS);
    again.attach();
    again.wait_text("FAKE-CLI READY");
    drop(again);
    end(&kept.0);
}

#[test]
fn until_ended_and_an_away_clock_cannot_be_given_together() {
    let _serial = one_at_a_time();
    let store = Folder::new("store-both");
    let store_arg = store.arg();
    for args in [
        vec!["hold", "--detach", "--store", store_arg.as_str(), "--session", "until-0009", "--until-ended", "--away", "60"],
        vec!["hold", "--store", store_arg.as_str(), "--session", "until-0009", "--away", "60", "--until-ended"],
    ] {
        let (code, stdout, stderr) = run_detaching(&args, "until-0009");
        assert_eq!(code, Some(2), "{args:?}: {stdout} / {stderr}");
        assert!(stderr.contains("--until-ended and --away cannot be given together"), "{args:?}: {stderr}");
        assert!(stdout.is_empty(), "{args:?}: {stdout}");
    }
    assert!(record_file(&store, "until-0009").is_none(), "a holder was started");
}

/// The modification time of `path` (a link not followed) is within the
/// last minute.
#[cfg(unix)]
fn fresh(path: &Path) -> bool {
    fs::symlink_metadata(path).and_then(|m| m.modified()).map_or(false, |t| t.elapsed().map_or(true, |age| age < Duration::from_secs(60)))
}

/// Set the access and modification times of `path` (a socket, a folder) to
/// `secs` ago, as a file left alone that long has them.
#[cfg(unix)]
fn age(path: &Path, secs: u64) {
    use std::os::unix::ffi::OsStrExt;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("after 1970").as_secs();
    let when = libc::timeval { tv_sec: (now - secs) as libc::time_t, tv_usec: 0 };
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).expect("a path with no NUL");
    let times = [when, when];
    assert_eq!(unsafe { libc::utimes(c.as_ptr(), times.as_ptr()) }, 0, "utimes {}", path.display());
}

/// The Raspberry Pi notes, 2: an idle holder's socket and run folder, left
/// eleven days alone (past the ten days systemd-tmpfiles allows), are marked
/// as used again within the holder's interval (2 s in this build, an hour
/// in the shipped one), so a cleaner of /tmp never finds them old.
#[cfg(unix)]
#[test]
fn an_idle_holders_socket_and_run_folder_are_marked_as_used_before_a_cleaner_of_tmp_finds_them_old() {
    let _serial = one_at_a_time();
    let store = Folder::new("store-touch");
    let work = Folder::new("work-touch");
    for (sid, lifetime) in [("until-0006", &["--away", "60"][..]), ("until-0007", &["--until-ended"][..])] {
        let rec = Held(hold(&store, sid, lifetime));
        launch_and_let_go(&rec.0, &work);
        let socket = PathBuf::from(rec.0.text("endpoint"));
        let folder = socket.parent().expect("the run folder").to_path_buf();
        age(&socket, 11 * 24 * 3600);
        age(&folder, 11 * 24 * 3600);
        let deadline = Instant::now() + WAIT;
        while !(fresh(&socket) && fresh(&folder)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(fresh(&socket), "{lifetime:?}: the socket was left eleven days old");
        assert!(fresh(&folder), "{lifetime:?}: the run folder was left eleven days old");
        end(&rec.0);
    }
}

/// The Raspberry Pi notes, 2: a socket taken all the same (a cleaner of /tmp
/// that does not spare it, a removal by hand) is bound again at the same
/// name within a few ticks, so the holder is still reached: list mode keeps
/// its record and a connection reaches its program. The record names the
/// same endpoint as before.
#[cfg(unix)]
#[test]
fn a_holder_whose_socket_was_taken_binds_it_again_and_is_still_reached() {
    use std::os::unix::fs::MetadataExt;
    let _serial = one_at_a_time();
    let store = Folder::new("store-rebind");
    let work = Folder::new("work-rebind");
    for (sid, lifetime) in [("until-0010", &["--away", "60"][..]), ("until-0011", &["--until-ended"][..])] {
        let rec = Held(hold(&store, sid, lifetime));
        let child = launch_and_let_go(&rec.0, &work);
        let socket = PathBuf::from(rec.0.text("endpoint"));
        let first = fs::symlink_metadata(&socket).expect("the socket").ino();
        fs::remove_file(&socket).expect("take the socket, as a sweep of /tmp does");
        let deadline = Instant::now() + WAIT;
        let again = loop {
            if let Ok(md) = fs::symlink_metadata(&socket) {
                break md;
            }
            assert!(Instant::now() < deadline, "{lifetime:?}: the socket was never bound again");
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_ne!(again.ino(), first, "{lifetime:?}: the same file");
        assert_eq!(again.mode() & 0o777, 0o600, "{lifetime:?}: the socket bound again is open to others");
        let listed = list(&store);
        assert!(listed.iter().any(|r| r.text("session") == sid && r.pid() == rec.0.pid() && r.text("endpoint") == rec.0.text("endpoint")), "{lifetime:?}: list mode lost the holder: {listed:?}");
        let mut app = App::connect(&rec.0, &hello::LOCAL_CAPS);
        app.attach();
        app.wait_text("FAKE-CLI READY");
        assert!(pids::alive(child), "{lifetime:?}: the program was ended");
        drop(app);
        end(&rec.0);
        assert!(!socket.exists(), "{lifetime:?}: the socket bound again outlived the holder");
    }
}
