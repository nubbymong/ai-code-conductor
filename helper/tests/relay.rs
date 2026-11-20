//! Tool streams through a holder (protocol section 15, capability `mcp`):
//! the relay run as a CLI runs a tool server (`aicc-helper mcp`, pipes for
//! its standard input and output), a holder started with `hold --detach`, a
//! test connection standing in for the app, and test connections standing in
//! for relays where a real relay never does what is tested (open a ninth
//! stream, send a terminal message, a message the app would not take). A
//! stand-in holder on a real endpoint stands in for one from before tool
//! streams, and for one from before `away`.
//!
//! Kept streams (capability `away`, from 2.1.3-beta.12): a relay that acked
//! `away` keeps its stream while no connection takes tool streams, holds the
//! calls its CLI makes meanwhile, and answers in the app's place what cannot
//! wait. A test connection that acks as a relay from before `away` stands in
//! for one, and is served as before.
//!
//! Not checked here, by reasoning only: an app connection that lets go (a
//! detach or a dropped connection) just as a newer one attaches, when the
//! newer one takes tool streams before the older one's streams are kept.
//! Those streams are kept after the newer one was given the kept ones, and
//! the holder's clock gives them to it on its next tick (serve.rs,
//! `give_stranded`). No test can place an attach inside that window on
//! purpose.

use aicc_helper::client::Client;
use aicc_helper::frame::{self, Body, Direction, Frame};
use aicc_helper::hello::{self, Hello, LOCAL_CAPS};
use aicc_helper::hook::ACK_CAPS as HOOK_ACK;
use aicc_helper::json::{self, Value};
use aicc_helper::pids;
use aicc_helper::request::MAX_MCP_TO_APP;
use aicc_helper::serve::{mcp_close, mcp_message, mcp_open, MAX_TOOL_STREAMS};
use aicc_helper::store::{self, Record};
use aicc_helper::transport::{self, Listener};
use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
const FAKE: &str = env!("CARGO_BIN_EXE_aicc-fake-cli");
const NONCE: &str = "0123456789abcdef0123456789abcdef";
const WAIT: Duration = Duration::from_secs(20);
/// How soon a relay that cannot have its stream exits: its 2 s to connect
/// and read the hello, and time to start and end its process.
const BOUND: Duration = Duration::from_secs(5);
/// What a relay acked before `away` (2.1.3-beta.10 and 11), and what one
/// still acks from a holder that does not offer it. A connection that acks
/// this is served as before: its stream ends when the app lets go.
const RELAY_ACK: [&str; 3] = ["core", "local", "mcp"];
/// What a relay acks from a holder that offers `away` (from 2.1.3-beta.12).
const KEEPING_ACK: [&str; 4] = ["core", "local", "mcp", "away"];
/// What the app acks (protocol.ts helloAck): never `away`, which only a relay acks.
const APP_ACK: [&str; 4] = ["core", "local", "hooks", "mcp"];
/// How long the relay holds a call in the build `cargo test` runs
/// (`relay::TEST_HOLD`, pinned in relay.rs's own tests). The build the
/// installer ships holds 30 s.
const HOLD: Duration = Duration::from_secs(4);
/// D1's words: the text of every answer the relay gives in the app's place.
const UPDATING: &str = "AI Code Conductor is updating, try again shortly";

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// Every test here starts processes, one at a time: on Windows a child
/// inherits every inheritable handle of its parent, so a spawn on one test
/// thread could carry another thread's pipe ends (as in probe_transport.rs).
fn one_at_a_time() -> MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A new, empty folder of this test, removed when dropped.
struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Folder {
        let dir = std::env::temp_dir().join(format!("aicc-relay-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a folder");
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

fn parse(text: &str) -> Value {
    json::parse(text.as_bytes()).unwrap_or_else(|e| panic!("not JSON ({e:?}): {text}"))
}

/// A JSON array holding one string, `bytes` long as compact JSON.
fn message_of_size(bytes: usize) -> String {
    format!("[\"{}\"]", "x".repeat(bytes - 4))
}

/// `mcp.away` and `mcp.back`, the bytes the protocol documents (and
/// helper/fixtures/local.json's `away` part holds).
fn mcp_away(stream: u64) -> Value {
    parse(&format!("{{\"t\":\"mcp.away\",\"stream\":{stream}}}"))
}

fn mcp_back(stream: u64) -> Value {
    parse(&format!("{{\"t\":\"mcp.back\",\"stream\":{stream}}}"))
}

/// A call with this id (as JSON) and method, and no params.
fn call(id: &str, method: &str) -> String {
    format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"{method}\"}}")
}

/// A `tools/call` with this id.
fn tool_call(id: u64) -> String {
    format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"tools/call\",\"params\":{{\"name\":\"echo\",\"arguments\":{{\"text\":\"call {id}\"}}}}}}")
}

/// A `tools/call` with this id that is `bytes` long as compact JSON.
fn tool_call_of_size(id: u64, bytes: usize) -> String {
    let head = format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"tools/call\",\"params\":{{\"name\":\"echo\",\"arguments\":{{\"text\":\"");
    let tail = "\"}}}";
    format!("{head}{}{tail}", "x".repeat(bytes - head.len() - tail.len()))
}

/// The app's answer to the call with this id.
fn answer(id: u64) -> String {
    format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{\"content\":[{{\"type\":\"text\",\"text\":\"answer {id}\"}}]}}}}")
}

/// A cancel for the call with this id.
fn cancel(id: u64) -> String {
    format!("{{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{{\"requestId\":{id},\"reason\":\"no longer wanted\"}}}}")
}

/// The answer the relay gives in the app's place to the call with this id
/// (as JSON), without its line end: to a `tools/call` a result the model
/// reads, one text item with the error mark set; to any other call a
/// JSON-RPC error. Both with D1's words.
fn updating_json(id: &str, tool: bool) -> String {
    if tool {
        format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{\"content\":[{{\"type\":\"text\",\"text\":\"{UPDATING}\"}}],\"isError\":true}}}}")
    } else {
        format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"error\":{{\"code\":-32603,\"message\":\"{UPDATING}\"}}}}")
    }
}

/// That answer as the line the CLI reads.
fn updating(id: &str, tool: bool) -> Vec<u8> {
    format!("{}\n", updating_json(id, tool)).into_bytes()
}

/// The lines as text, for a message that says what came.
fn shown(lines: &[Vec<u8>]) -> Vec<String> {
    lines.iter().map(|l| String::from_utf8_lossy(l).into_owned()).collect()
}

/// Run `aicc-helper` with `args`, its output going to files: a holder it
/// starts outlives it, and would hold a pipe open.
fn detaching(args: &[&str], tag: &str) -> (bool, String, String) {
    let base = std::env::temp_dir().join(format!("aicc-relay-detach-{tag}-{}", std::process::id()));
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
    hold_away(store_dir, sid, 60)
}

/// Start a detached holder whose away clock is `away` seconds.
fn hold_away(store_dir: &Folder, sid: &str, away: u64) -> Record {
    let away = away.to_string();
    let (ok, stdout, stderr) = detaching(&["hold", "--detach", "--store", &store_dir.arg(), "--session", sid, "--away", &away], sid);
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

/// A connection standing in for the app, or for a relay: the JSON messages
/// it read and has not yet looked at, in the order they came, and what the
/// terminal showed.
struct Conn {
    client: Client,
    got: Vec<Value>,
    screen: Vec<u8>,
    next_id: u64,
}

impl Conn {
    /// Connect, read the hello and ack it with `caps`.
    fn connect(rec: &Record, caps: &[&str]) -> Conn {
        let mut client = Client::to_record(rec, WAIT).expect("connect to the holder and read its hello");
        client.send(hello::ack_message(1, caps)).expect("ack the hello");
        Conn { client, got: Vec::new(), screen: Vec::new(), next_id: 2 }
    }

    /// A connection that acks as the relay does and opens its stream
    /// `stream`.
    fn relay(rec: &Record, stream: u64) -> Conn {
        let mut c = Conn::connect(rec, &RELAY_ACK);
        c.client.send(mcp_open(stream)).expect("open a stream");
        c
    }

    /// A connection that acks as a relay from 2.1.3-beta.12 does a holder
    /// that offers `away`, and opens its stream `stream`.
    fn keeping_relay(rec: &Record, stream: u64) -> Conn {
        let mut c = Conn::connect(rec, &KEEPING_ACK);
        c.client.send(mcp_open(stream)).expect("open a stream");
        c
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

    /// The next message, which must be `want` exactly.
    fn expect(&mut self, want: &Value) {
        let m = self.next(WAIT).unwrap_or_else(|| panic!("{} never came", want.to_json()));
        assert_eq!(m.to_json(), want.to_json());
    }

    /// The next message, which must be an `error` with this code.
    fn expect_error(&mut self, code: &str) {
        let m = self.next(WAIT).unwrap_or_else(|| panic!("no {code} error came"));
        assert_eq!((t_of(&m), m.get("code").and_then(Value::as_str)), ("error", Some(code)), "{}", m.to_json());
    }

    /// Nothing comes within `wait`.
    fn quiet_for(&mut self, wait: Duration) {
        if let Some(m) = self.next(wait) {
            panic!("expected nothing, got {}", m.to_json());
        }
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

    /// Wait until the terminal has shown `needle`.
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

/// The app: a connection that acks what the app acks (`APP_ACK`), launches
/// the fake CLI and attaches.
fn app_attached(rec: &Record, cwd: &Folder) -> Conn {
    let mut app = Conn::connect(rec, &APP_ACK);
    assert!(app.client.hello.caps.iter().any(|c| c == "mcp"), "the holder does not offer mcp: {:?}", app.client.hello.caps);
    let id = app.id();
    let env = Value::Obj(launch_env().into_iter().map(|(k, v)| (k, Value::Str(v))).collect());
    let launched = app.call(msg(
        "term.launch",
        id,
        vec![("argv", Value::strs(&[FAKE])), ("cwd", Value::Str(cwd.arg())), ("env", env), ("cols", Value::uint(120)), ("rows", Value::uint(30))],
    ));
    assert_eq!(t_of(&launched), "term.launched", "{}", launched.to_json());
    attach(&mut app);
    app
}

/// Attach `conn` from offset 0. Nothing may come before the reply.
fn attach(conn: &mut Conn) {
    let id = conn.id();
    let attached = conn.call(msg("term.attach", id, vec![("from", Value::uint(0))]));
    assert_eq!(t_of(&attached), "term.attached", "{}", attached.to_json());
    assert!(conn.got.is_empty(), "before term.attached came {:?}", texts(&conn.got));
}

/// An app connection that acks `core` and `local` only, launches the fake
/// CLI and attaches: it takes no tool streams, so a relay's stream waits.
fn attached_without_tools(rec: &Record, cwd: &Folder) -> Conn {
    let mut app = Conn::connect(rec, &LOCAL_CAPS);
    let id = app.id();
    let env = Value::Obj(launch_env().into_iter().map(|(k, v)| (k, Value::Str(v))).collect());
    let launched = app.call(msg(
        "term.launch",
        id,
        vec![("argv", Value::strs(&[FAKE])), ("cwd", Value::Str(cwd.arg())), ("env", env), ("cols", Value::uint(80)), ("rows", Value::uint(24))],
    ));
    assert_eq!(t_of(&launched), "term.launched", "{}", launched.to_json());
    attach(&mut app);
    app.wait_text("FAKE-CLI READY");
    app
}

/// `conn` detaches: the holder closes it, and no tool message follows the
/// reply.
fn detach(conn: &mut Conn) {
    let id = conn.id();
    let detached = conn.call(msg("term.detach", id, vec![]));
    assert_eq!(t_of(&detached), "term.detached", "{}", detached.to_json());
    let before = conn.got.len();
    assert!(conn.closed(), "the holder kept a detached connection open");
    assert!(conn.got[before..].iter().all(|m| !t_of(m).starts_with("mcp")), "a tool message after term.detached: {:?}", texts(&conn.got[before..]));
}

/// `conn` pings and waits for the `pong`: the holder answers a connection's
/// messages in order, so everything it sent before has been carried out.
fn settled(conn: &mut Conn) {
    let id = conn.id();
    let pong = conn.call(msg("ping", id, vec![]));
    assert_eq!(t_of(&pong), "pong", "{}", pong.to_json());
}

/// One run of the relay, as a CLI starts its tool server: pipes for its
/// standard input, output and error. Each line it prints is read as it
/// comes; it is killed if it still runs when dropped.
struct Relay {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: mpsc::Receiver<Vec<u8>>,
    /// Its standard output, kept open and never read (`start_unread`).
    unread: Option<ChildStdout>,
    stderr: mpsc::Receiver<Vec<u8>>,
    started: Instant,
}

impl Relay {
    fn start(store_dir: &Folder, sid: &str) -> Relay {
        Relay::with_args(&["--store", &store_dir.arg(), "--session", sid])
    }

    /// A relay whose CLI keeps its standard output open and never reads it.
    fn start_unread(store_dir: &Folder, sid: &str) -> Relay {
        Relay::spawn(&["--store", &store_dir.arg(), "--session", sid], false)
    }

    fn with_args(args: &[&str]) -> Relay {
        Relay::spawn(args, true)
    }

    fn spawn(args: &[&str], read_out: bool) -> Relay {
        let started = Instant::now();
        let mut child = Command::new(HELPER)
            .arg("mcp")
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start the relay");
        let stdout = child.stdout.take().expect("its standard output");
        let mut stderr = child.stderr.take().expect("its standard error");
        let (line_tx, lines) = mpsc::channel();
        let unread = if read_out {
            std::thread::spawn(move || {
                let mut out = std::io::BufReader::new(stdout);
                loop {
                    let mut line = Vec::new();
                    match out.read_until(b'\n', &mut line) {
                        Ok(0) | Err(_) => return,
                        Ok(_) => {
                            if line_tx.send(line).is_err() {
                                return;
                            }
                        }
                    }
                }
            });
            None
        } else {
            drop(line_tx);
            Some(stdout)
        };
        let (err_tx, stderr_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut text = Vec::new();
            let _ = stderr.read_to_end(&mut text);
            let _ = err_tx.send(text);
        });
        Relay { stdin: child.stdin.take(), child, lines, unread, stderr: stderr_rx, started }
    }

    /// Write `text` to its standard input, as the CLI does.
    fn write(&mut self, text: &str) {
        let stdin = self.stdin.as_mut().expect("its standard input is open");
        stdin.write_all(text.as_bytes()).expect("write to the relay");
        stdin.flush().expect("flush the relay's input");
    }

    /// End its standard input, as a CLI does at its normal end.
    fn end_input(&mut self) {
        self.stdin = None;
    }

    /// The next line it printed, its line end included, within `wait`.
    fn line(&self, wait: Duration) -> Option<Vec<u8>> {
        self.lines.recv_timeout(wait).ok()
    }

    /// The next line it prints, within `wait`, which must be `want`.
    fn expect_line(&self, want: &[u8], wait: Duration) {
        let got = self.line(wait).unwrap_or_else(|| panic!("{:?} was never printed", String::from_utf8_lossy(want)));
        assert_eq!(String::from_utf8_lossy(&got), String::from_utf8_lossy(want));
    }

    /// It still runs `wait` from now: it did not exit.
    fn runs_on(&mut self, wait: Duration, what: &str) {
        if let Some(status) = self.exit_by(Instant::now() + wait) {
            panic!("{what}: the relay exited ({status})");
        }
    }

    /// Its exit, if it exits by `until`.
    fn exit_by(&mut self, until: Instant) -> Option<ExitStatus> {
        loop {
            if let Some(status) = self.child.try_wait().expect("look at the relay") {
                return Some(status);
            }
            if Instant::now() >= until {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Once it has exited: every line it printed that was not read yet, and
    /// all it wrote on standard error.
    fn rest(&self) -> (Vec<Vec<u8>>, Vec<u8>) {
        let mut lines = Vec::new();
        while let Ok(line) = self.lines.recv_timeout(WAIT) {
            lines.push(line);
        }
        (lines, self.stderr.recv_timeout(WAIT).unwrap_or_default())
    }

    /// It exits 1 within `BOUND` of `started`, having printed nothing at all.
    fn fails_quietly(&mut self, what: &str) {
        let status = self.exit_by(self.started + BOUND).unwrap_or_else(|| panic!("{what}: the relay still runs after {BOUND:?}"));
        assert_eq!(status.code(), Some(1), "{what}: {status}");
        let (lines, stderr) = self.rest();
        assert!(lines.is_empty(), "{what}: it printed {:?}", lines.iter().map(|l| String::from_utf8_lossy(l).into_owned()).collect::<Vec<_>>());
        assert!(stderr.is_empty(), "{what}: it wrote {:?} on standard error", String::from_utf8_lossy(&stderr));
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        // Its output closes only once it has gone.
        drop(self.unread.take());
    }
}

/// A stand-in holder on a real endpoint, with a record in `store_dir`: it
/// writes a hello offering `caps`, then reads until the client goes, and
/// never answers. It says how many bytes it read.
fn stand_in(store_dir: &Folder, sid: &str, caps: &[&str]) -> mpsc::Receiver<usize> {
    let listener = Listener::bind(sid).expect("listen");
    store::prepare(&store_dir.0).expect("a store");
    let rec = Record {
        session: sid.to_string(),
        label: String::new(),
        pid: std::process::id(),
        endpoint: listener.endpoint().to_string(),
        nonce: NONCE.to_string(),
        helper: "0.1.0".to_string(),
        started: store::now_ms(),
        away: 120,
        attached: false,
        child: "running".to_string(),
        code: None,
    };
    store::write(&store_dir.0, &rec).expect("a record");
    let h = Hello { nonce: NONCE, helper_version: "0.1.0", sha256: None, os: std::env::consts::OS, arch: std::env::consts::ARCH, caps, sid, state: "live" };
    let line = hello::hello_line(&h).expect("a hello line");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut read: usize = 0;
        if let Ok(mut s) = listener.accept() {
            let _ = s.write_all(format!("{line}\n").as_bytes());
            let _ = s.flush();
            let _ = s.set_read_timeout(Some(WAIT));
            let mut buf = [0u8; 4096];
            loop {
                match s.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => read += n,
                }
            }
        }
        let _ = tx.send(read);
    });
    rx
}

/// A stand-in holder like `stand_in`, offering `caps`, that reads the first
/// frame a relay sends (its ack), hands it on and closes the connection.
fn stand_in_ack(store_dir: &Folder, sid: &str, caps: &[&str]) -> mpsc::Receiver<Option<Value>> {
    let listener = Listener::bind(sid).expect("listen");
    store::prepare(&store_dir.0).expect("a store");
    let rec = Record {
        session: sid.to_string(),
        label: String::new(),
        pid: std::process::id(),
        endpoint: listener.endpoint().to_string(),
        nonce: NONCE.to_string(),
        helper: "0.1.0".to_string(),
        started: store::now_ms(),
        away: 120,
        attached: false,
        child: "running".to_string(),
        code: None,
    };
    store::write(&store_dir.0, &rec).expect("a record");
    let h = Hello { nonce: NONCE, helper_version: "0.1.0", sha256: None, os: std::env::consts::OS, arch: std::env::consts::ARCH, caps, sid, state: "live" };
    let line = hello::hello_line(&h).expect("a hello line");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut first = None;
        if let Ok(mut s) = listener.accept() {
            let _ = s.write_all(format!("{line}\n").as_bytes());
            let _ = s.flush();
            let _ = s.set_read_timeout(Some(WAIT));
            if let Ok(Some(Frame { body: Body::Json(v), .. })) = frame::read_frame(&mut s, Direction::AppToHelper) {
                first = Some(v);
            }
        }
        let _ = tx.send(first);
    });
    rx
}

#[test]
fn requests_and_answers_pass_through_the_relay_whole_and_in_order() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-pass");
    let work = Folder::new("work-pass");
    let sid = "relay-pass-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = app_attached(&held.0, &work);
    let mut relay = Relay::start(&store_dir, sid);
    // The holder numbers the stream itself, from 1.
    app.expect(&mcp_open(1));

    // Three requests in one write, the first before any initialize, as a CLI
    // may send them: each reaches the app whole, in order, on the stream.
    let requests = [
        r#"{"jsonrpc":"2.0","id":0,"method":"server/discover"}"#,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"a CLI","version":"1.0.0"}}}"#,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"text":"café 😀 \"quoted\" \\ and a tab\t \u0001"}}}"#,
    ];
    relay.write(&requests.iter().map(|r| format!("{r}\n")).collect::<String>());
    for request in requests {
        let m = app.next(WAIT).unwrap_or_else(|| panic!("{request} never reached the app"));
        assert_eq!(m.get("message").map(Value::to_json).as_deref(), Some(request), "a request changed on the way");
        assert_eq!(m.to_json(), mcp_message(1, parse(request)).to_json());
    }

    // Three answers, one of them 2 MiB (over what a frame to the app holds,
    // within what a frame from it may): each reaches the CLI as one line, the
    // same bytes, in order.
    let big = format!("{{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{{\"content\":[{{\"type\":\"image\",\"data\":\"{}\",\"mimeType\":\"image/png\"}}]}}}}", "A".repeat(2 * 1024 * 1024));
    let answers = [
        r#"{"jsonrpc":"2.0","id":0,"error":{"code":-32601,"message":"Method not found"}}"#.to_string(),
        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"conductor","version":"1"}}}"#.to_string(),
        big,
    ];
    for answer in &answers {
        app.client.send(mcp_message(1, parse(answer))).expect("answer");
    }
    for answer in &answers {
        let line = relay.line(WAIT).expect("an answer on the relay's standard output");
        assert_eq!(String::from_utf8_lossy(&line).len(), answer.len() + 1, "an answer changed length on the way");
        assert_eq!(line, format!("{answer}\n").into_bytes(), "an answer changed on the way");
    }

    // A line whose message is over what the app takes is dropped; the line
    // after it still goes, so the stream is still usable.
    let after = r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}}"#;
    relay.write(&format!("{}\n{after}\n", message_of_size(MAX_MCP_TO_APP + 1)));
    app.expect(&mcp_message(1, parse(after)));

    // The end of its input closes the stream, and it exits 0 having printed
    // the answers and nothing else.
    relay.end_input();
    app.expect(&mcp_close(1));
    let status = relay.exit_by(Instant::now() + WAIT).expect("the relay still runs after its input ended");
    assert_eq!(status.code(), Some(0), "{status}");
    let (lines, stderr) = relay.rest();
    assert!(lines.is_empty(), "it printed more: {:?}", lines.iter().map(|l| String::from_utf8_lossy(l).into_owned()).collect::<Vec<_>>());
    assert!(stderr.is_empty(), "it wrote {:?} on standard error", String::from_utf8_lossy(&stderr));
    // The session runs on.
    app.client.send_raw(1, b"still here\r").expect("type into the terminal");
    app.wait_text("echo: still here");

    // A relay whose input ends at once had its stream all the same: it opens,
    // closes, and the relay exits 0.
    let mut brief = Relay::start(&store_dir, sid);
    brief.end_input();
    app.expect(&mcp_open(2));
    app.expect(&mcp_close(2));
    let status = brief.exit_by(Instant::now() + WAIT).expect("the relay still runs after its input ended");
    assert_eq!(status.code(), Some(0), "{status}");
    end(&held.0);
}

#[test]
fn with_no_stream_to_have_the_relay_exits_1_at_once_and_prints_nothing() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-none");
    let work = Folder::new("work-none");

    // Command lines it does not take, and a session with no record. Its input
    // stays open: it does not wait for the end of it.
    let store_arg = store_dir.arg();
    for args in [
        &[][..],
        &["--store", store_arg.as_str()][..],
        &["--store", store_arg.as_str(), "--session", "bad id"][..],
        &["--store", store_arg.as_str(), "--session", "relay-none-01", "--verbose", "1"][..],
        &["--store", store_arg.as_str(), "--session", "relay-none-01"][..],
    ] {
        Relay::with_args(args).fails_quietly(&format!("{args:?}"));
    }

    // A holder with no connection attached: `mcp.open` is answered
    // not-connected. Nothing is launched yet, so the relay is refused although
    // it acks `away`: a stream is kept only while the session's program runs.
    let sid = "relay-none-02";
    let held = Held(hold(&store_dir, sid));
    Relay::start(&store_dir, sid).fails_quietly("nothing attached");
    // Its input closed at once: still 1, as it never had a stream, whichever
    // comes first, the end of its input or the refusal.
    for _ in 0..3 {
        let mut closed = Relay::start(&store_dir, sid);
        closed.end_input();
        closed.fails_quietly("nothing attached, its input closed at once");
    }

    // The app attached, but its ack did not name mcp (the app's own ack, with
    // hooks): it is passed nothing, and a relay that did not ack `away` is
    // not-connected. (The relay itself acks `away` and is kept:
    // `an_open_while_nothing_takes_tool_streams_is_kept_counts_toward_the_bound_and_ends_with_the_program`.)
    let mut plain = Conn::connect(&held.0, &HOOK_ACK);
    let id = plain.id();
    let env = Value::Obj(launch_env().into_iter().map(|(k, v)| (k, Value::Str(v))).collect());
    let launched = plain.call(msg(
        "term.launch",
        id,
        vec![("argv", Value::strs(&[FAKE])), ("cwd", Value::Str(work.arg())), ("env", env), ("cols", Value::uint(80)), ("rows", Value::uint(24))],
    ));
    assert_eq!(t_of(&launched), "term.launched", "{}", launched.to_json());
    attach(&mut plain);
    let mut by_hand = Conn::relay(&held.0, 1);
    by_hand.expect_error("not-connected");
    plain.quiet_for(Duration::from_secs(1));
    end(&held.0);
}

#[test]
fn a_holder_from_before_tool_streams_is_sent_nothing() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-older");
    let sid = "relay-older-01";
    let read = stand_in(&store_dir, sid, &["core", "local", "hooks"]);
    Relay::start(&store_dir, sid).fails_quietly("a holder without mcp");
    let bytes = read.recv_timeout(WAIT).expect("the stand-in saw the relay go");
    assert_eq!(bytes, 0, "the relay wrote to a holder that does not offer mcp");
}

#[test]
fn a_connection_that_opened_a_tool_stream_never_uses_the_terminal() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-term");
    let work = Folder::new("work-term");
    let sid = "relay-term-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = app_attached(&held.0, &work);
    app.wait_text("FAKE-CLI READY");

    // The attached connection opens no stream; it stays.
    app.client.send(mcp_open(1)).expect("send");
    app.expect_error("bad-field");

    // A relay that tries to attach, resize or end: unknown-type and a close,
    // and its stream ends with it. The app keeps the terminal.
    for (n, (t, more)) in [("term.attach", vec![("from", Value::uint(0))]), ("term.resize", vec![("cols", Value::uint(90)), ("rows", Value::uint(20))]), ("term.end", vec![])].into_iter().enumerate() {
        let mut relay = Conn::relay(&held.0, 7);
        let stream = n as u64 + 1;
        app.expect(&mcp_open(stream));
        relay.client.send(msg(t, 2, more)).expect("send");
        relay.expect_error("unknown-type");
        assert!(relay.closed(), "the holder kept a relay that sent {t}");
        app.expect(&mcp_close(stream));
    }
    // Typed bytes from a relay never reach the program.
    let mut relay = Conn::relay(&held.0, 7);
    app.expect(&mcp_open(4));
    relay.client.send_raw(1, b"typed by a relay\r").expect("send");
    relay.expect_error("bad-frame");
    assert!(relay.closed(), "the holder kept a relay that typed");
    app.expect(&mcp_close(4));

    assert!(pids::alive(held.0.pid), "a relay ended the session");
    let id = app.id();
    let resized = app.call(msg("term.resize", id, vec![("cols", Value::uint(100)), ("rows", Value::uint(40))]));
    assert_eq!(t_of(&resized), "term.resized", "the app lost the terminal: {}", resized.to_json());
    app.client.send_raw(1, b"from the app\r").expect("type into the terminal");
    app.wait_text("echo: from the app");
    assert!(!String::from_utf8_lossy(&app.screen).contains("typed by a relay"), "a relay's bytes reached the program");
    end(&held.0);
}

#[test]
fn a_relays_message_over_what_the_app_takes_is_too_large_and_its_stream_goes_on() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-large");
    let work = Folder::new("work-large");
    let sid = "relay-large-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = app_attached(&held.0, &work);
    let mut relay = Conn::relay(&held.0, 5);
    app.expect(&mcp_open(1));

    // The most the app takes goes through, on the holder's number.
    let most = parse(&message_of_size(MAX_MCP_TO_APP));
    relay.client.send(mcp_message(5, most.clone())).expect("send");
    app.expect(&mcp_message(1, most));
    // One byte more is too-large, and nothing reaches the app.
    relay.client.send(mcp_message(5, parse(&message_of_size(MAX_MCP_TO_APP + 1)))).expect("send");
    relay.expect_error("too-large");
    app.quiet_for(Duration::from_secs(1));
    // The stream goes on, both ways, each side on its own number.
    let ping = parse(r#"{"jsonrpc":"2.0","id":9,"method":"ping"}"#);
    relay.client.send(mcp_message(5, ping.clone())).expect("send");
    app.expect(&mcp_message(1, ping));
    let pong = parse(r#"{"jsonrpc":"2.0","id":9,"result":{}}"#);
    app.client.send(mcp_message(1, pong.clone())).expect("send");
    relay.expect(&mcp_message(5, pong));

    // A number that is not the sender's stream is not-found, both ways.
    relay.client.send(mcp_message(6, parse("{}"))).expect("send");
    relay.expect_error("not-found");
    app.client.send(mcp_message(2, parse("{}"))).expect("send");
    app.expect_error("not-found");
    // Only a relay ends a stream.
    app.client.send(mcp_close(1)).expect("send");
    app.expect_error("not-found");
    relay.client.send(mcp_close(5)).expect("send");
    app.expect(&mcp_close(1));
    relay.client.send(mcp_message(5, parse("{}"))).expect("send");
    relay.expect_error("not-found");
    end(&held.0);
}

#[test]
fn a_session_has_at_most_its_bound_of_tool_streams_and_a_closed_one_makes_room() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-bound");
    let work = Folder::new("work-bound");
    let sid = "relay-bound-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = app_attached(&held.0, &work);
    let mut relays: Vec<Conn> = Vec::new();
    for n in 1..=MAX_TOOL_STREAMS as u64 {
        relays.push(Conn::relay(&held.0, 1));
        app.expect(&mcp_open(n));
    }
    // One more is busy, takes no number, and nothing reaches the app.
    let mut extra = Conn::relay(&held.0, 1);
    extra.expect_error("busy");
    app.quiet_for(Duration::from_secs(1));
    // A relay opens one stream at a time.
    relays[0].client.send(mcp_open(2)).expect("send");
    relays[0].expect_error("bad-field");
    // Once one closes, the next opens, on a number not used before.
    relays[0].client.send(mcp_close(1)).expect("send");
    app.expect(&mcp_close(1));
    extra.client.send(mcp_open(1)).expect("send");
    app.expect(&mcp_open(MAX_TOOL_STREAMS as u64 + 1));
    assert_eq!(MAX_TOOL_STREAMS, 8);
    end(&held.0);
}

#[test]
fn when_the_app_lets_go_every_stream_ends_and_each_relay_is_told() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-go");
    let work = Folder::new("work-go");
    let sid = "relay-go-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = app_attached(&held.0, &work);
    // Two relays that did not ack `away` (the relay itself acks it: see
    // `when_the_app_lets_go_a_relay_that_acked_away_keeps_its_stream_for_the_next_attach`).
    let mut by_hand = Conn::relay(&held.0, 3);
    app.expect(&mcp_open(1));
    let mut other = Conn::relay(&held.0, 1);
    app.expect(&mcp_open(2));

    // The app detaches: each relay is told, on its own number; the session
    // runs on.
    let id = app.id();
    let detached = app.call(msg("term.detach", id, vec![]));
    assert_eq!(t_of(&detached), "term.detached", "{}", detached.to_json());
    assert!(app.closed(), "the holder kept a detached connection open");
    assert!(app.got.iter().all(|m| !t_of(m).starts_with("mcp")), "a tool message after term.detached: {:?}", texts(&app.got));
    by_hand.expect(&mcp_close(3));
    other.expect(&mcp_close(1));
    by_hand.client.send(mcp_message(3, parse("{}"))).expect("send");
    by_hand.expect_error("not-found");

    // A newer attach takes the terminal and tool streams; the one it
    // replaced has its streams ended the same way.
    let mut second = Conn::connect(&held.0, &APP_ACK);
    attach(&mut second);
    by_hand.client.send(mcp_open(3)).expect("send");
    second.expect(&mcp_open(3));
    let mut third = Conn::connect(&held.0, &APP_ACK);
    attach(&mut third);
    by_hand.expect(&mcp_close(3));
    second.expect_error("replaced");
    assert!(second.closed(), "the holder kept a replaced connection open");
    assert!(second.got.iter().all(|m| !t_of(m).starts_with("mcp")), "a tool message to a replaced connection: {:?}", texts(&second.got));
    assert!(pids::alive(held.0.pid), "the session ended");
    end(&held.0);
}

#[test]
fn a_relay_that_goes_without_a_word_ends_its_stream() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-drop");
    let work = Folder::new("work-drop");
    let sid = "relay-drop-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = app_attached(&held.0, &work);

    // A connection that drops without `mcp.close`, as a relay whose CLI was
    // ended from outside does: the app is told.
    let by_hand = Conn::relay(&held.0, 1);
    app.expect(&mcp_open(1));
    drop(by_hand);
    app.expect(&mcp_close(1));

    // The relay itself, killed with its input still open.
    let mut relay = Relay::start(&store_dir, sid);
    app.expect(&mcp_open(2));
    relay.child.kill().expect("kill the relay");
    let _ = relay.child.wait();
    app.expect(&mcp_close(2));
    end(&held.0);
}

#[test]
fn a_relay_whose_holder_goes_away_exits_1_and_prints_nothing() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-gone");
    let work = Folder::new("work-gone");
    let sid = "relay-gone-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = app_attached(&held.0, &work);
    let mut relay = Relay::start(&store_dir, sid);
    app.expect(&mcp_open(1));

    // The session ends (`term.end` from another connection): the holder
    // tells no relay, and its process exits. The relay reads the end of its
    // connection and exits 1 at once, having printed nothing.
    end(&held.0);
    assert!(!pids::alive(held.0.pid), "the holder still runs after term.end");
    relay.started = Instant::now();
    relay.fails_quietly("the holder went away");
}

#[test]
fn a_relay_whose_cli_stops_reading_still_sees_its_stream_end() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-unread");
    let work = Folder::new("work-unread");
    let sid = "relay-unread-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = app_attached(&held.0, &work);
    app.wait_text("FAKE-CLI READY");
    let mut relay = Relay::start_unread(&store_dir, sid);
    app.expect(&mcp_open(1));
    // An answer of 2 MiB the CLI never reads: more than any pipe holds, so
    // the relay's write of it to standard output cannot finish.
    let big = format!("{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{\"data\":\"{}\"}}}}", "A".repeat(2 * 1024 * 1024));
    app.client.send(mcp_message(1, parse(&big))).expect("send");
    std::thread::sleep(Duration::from_millis(500));
    // The holder ends the stream (the program exits; a relay that acked
    // `away` keeps its stream when the app lets go, but not past its
    // program): the relay sees the end all the same, and exits 1 once what
    // waits for the CLI has had its time.
    app.client.send_raw(1, b"exit 3\r").expect("type into the terminal");
    let status = relay.exit_by(Instant::now() + aicc_helper::relay::DRAIN + BOUND).expect("the relay did not see its stream end while its CLI was not reading");
    assert_eq!(status.code(), Some(1), "{status}");
    end(&held.0);
}

#[test]
fn after_the_program_exits_no_attach_takes_tool_streams() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-exited");
    let work = Folder::new("work-exited");
    let sid = "relay-exited-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = app_attached(&held.0, &work);
    app.wait_text("FAKE-CLI READY");
    let mut relay = Conn::relay(&held.0, 1);
    app.expect(&mcp_open(1));

    // The program's end ends the stream, and the relay is told.
    app.client.send_raw(1, b"exit 3\r").expect("type into the terminal");
    relay.expect(&mcp_close(1));
    let exit = app.next(WAIT).expect("a message once the program exits");
    assert_eq!((t_of(&exit), num(&exit, "code")), ("term.exit", Some(3)), "{}", exit.to_json());

    // An attach after the end only replays, on the same connection or a new
    // one: neither takes tool streams, and nothing is passed to it.
    attach(&mut app);
    relay.client.send(mcp_open(1)).expect("send");
    relay.expect_error("not-connected");
    let mut again = Conn::connect(&held.0, &APP_ACK);
    attach(&mut again);
    let mut late = Conn::relay(&held.0, 1);
    late.expect_error("not-connected");
    again.quiet_for(Duration::from_secs(1));
    end(&held.0);
}

// ── Kept streams (capability `away`, from 2.1.3-beta.12) ─────────────────────

#[test]
fn when_the_app_lets_go_a_relay_that_acked_away_keeps_its_stream_for_the_next_attach() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-kept");
    let work = Folder::new("work-kept");
    let sid = "relay-kept-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = app_attached(&held.0, &work);
    let mut relay = Relay::start(&store_dir, sid);
    app.expect(&mcp_open(1));
    let mut plain = Conn::relay(&held.0, 5);
    app.expect(&mcp_open(2));

    // The app lets go. The relay acked `away`: its stream is kept, and it
    // runs on and prints nothing. A relay that did not ack it is told
    // `mcp.close`, as before.
    detach(&mut app);
    plain.expect(&mcp_close(5));
    relay.runs_on(BOUND, "the app let go");
    assert!(relay.line(Duration::ZERO).is_none(), "the relay printed something when the app let go");

    // The next attach that acked mcp is given the kept stream, on the
    // holder's number, and it carries calls again.
    let mut second = Conn::connect(&held.0, &APP_ACK);
    attach(&mut second);
    second.expect(&mcp_open(1));
    let request = tool_call(4);
    relay.write(&format!("{request}\n"));
    second.expect(&mcp_message(1, parse(&request)));
    second.client.send(mcp_message(1, parse(&answer(4)))).expect("send");
    relay.expect_line(format!("{}\n", answer(4)).as_bytes(), WAIT);
    let mut keeper = Conn::keeping_relay(&held.0, 3);
    second.expect(&mcp_open(3));

    // A newer attach replaces it. Each stream is kept, its relay told
    // `mcp.away` on its own number, then given to the newer attach (which
    // gets `mcp.open` for each, in the order they were opened) and its relay
    // told `mcp.back`. The replaced connection gets no tool message.
    let mut third = Conn::connect(&held.0, &APP_ACK);
    attach(&mut third);
    keeper.expect(&mcp_away(3));
    keeper.expect(&mcp_back(3));
    second.expect_error("replaced");
    assert!(second.closed(), "the holder kept a replaced connection open");
    assert!(second.got.iter().all(|m| !t_of(m).starts_with("mcp")), "a tool message to a replaced connection: {:?}", texts(&second.got));
    third.expect(&mcp_open(1));
    third.expect(&mcp_open(3));
    let ping = parse(r#"{"jsonrpc":"2.0","id":9,"method":"ping"}"#);
    keeper.client.send(mcp_message(3, ping.clone())).expect("send");
    third.expect(&mcp_message(3, ping));
    let pong = parse(r#"{"jsonrpc":"2.0","id":9,"result":{}}"#);
    third.client.send(mcp_message(3, pong.clone())).expect("send");
    keeper.expect(&mcp_message(3, pong));

    // While it is kept, a message on the stream is not-connected and the
    // stream goes on.
    detach(&mut third);
    keeper.expect(&mcp_away(3));
    keeper.client.send(mcp_message(3, parse(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#))).expect("send");
    keeper.expect_error("not-connected");
    settled(&mut keeper);

    // The session ends: the holder tells no one, and the relay exits 1.
    end(&held.0);
    let status = relay.exit_by(Instant::now() + BOUND).expect("the relay still runs after its session ended");
    assert_eq!(status.code(), Some(1), "{status}");
    let (lines, stderr) = relay.rest();
    assert!(lines.is_empty(), "it printed more: {:?}", shown(&lines));
    assert!(stderr.is_empty(), "it wrote {:?} on standard error", String::from_utf8_lossy(&stderr));
}

#[test]
fn a_call_made_while_the_app_is_away_waits_for_it_and_one_the_app_had_is_answered_at_once() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-wait");
    let work = Folder::new("work-wait");
    let sid = "relay-wait-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = app_attached(&held.0, &work);
    let mut relay = Relay::start(&store_dir, sid);
    app.expect(&mcp_open(1));
    // A call the app has and has not answered.
    let had = tool_call(10);
    relay.write(&format!("{had}\n"));
    app.expect(&mcp_message(1, parse(&had)));

    // The app lets go: that call reached an app that is gone. It is answered
    // at once, and never sent a second time (a tool call may not be safe to
    // repeat).
    detach(&mut app);
    relay.expect_line(&updating("10", true), BOUND);

    // Calls made now are held: nothing is sent or written for them yet.
    let calls = [tool_call(11), call("12", "tools/list"), tool_call(13)];
    relay.write(&calls.iter().map(|c| format!("{c}\n")).collect::<String>());
    assert!(relay.line(Duration::from_millis(500)).is_none(), "a held call was answered");

    // The next attach that acked mcp gets the stream, then the held calls in
    // the order they came, and nothing more: not the call the app had.
    let mut second = Conn::connect(&held.0, &APP_ACK);
    attach(&mut second);
    second.expect(&mcp_open(1));
    for c in &calls {
        second.expect(&mcp_message(1, parse(c)));
    }
    second.quiet_for(Duration::from_secs(1));
    // Their answers reach the CLI, and no other answer comes for them.
    for id in [11, 12, 13] {
        second.client.send(mcp_message(1, parse(&answer(id)))).expect("send");
    }
    for id in [11, 12, 13] {
        relay.expect_line(format!("{}\n", answer(id)).as_bytes(), WAIT);
    }
    assert!(relay.line(HOLD + Duration::from_secs(1)).is_none(), "a call that went to the app was answered in its place too");
    end(&held.0);
}

#[test]
fn a_call_still_held_when_its_time_is_up_gets_the_fixed_answer_and_is_dropped() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-expire");
    let work = Folder::new("work-expire");
    let sid = "relay-expire-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = app_attached(&held.0, &work);
    let mut relay = Relay::start(&store_dir, sid);
    app.expect(&mcp_open(1));
    // Two calls the app has when it lets go, a tool call and another: each is
    // answered at once, in the order they were sent, each in its form.
    let had = [tool_call(20), call("\"r21\"", "resources/list")];
    relay.write(&had.iter().map(|c| format!("{c}\n")).collect::<String>());
    for c in &had {
        app.expect(&mcp_message(1, parse(c)));
    }
    detach(&mut app);
    relay.expect_line(&updating("20", true), BOUND);
    relay.expect_line(&updating("\"r21\"", false), BOUND);

    // Two calls held: nothing for them until their time is up, then the fixed
    // answer, byte for byte, in the order they came.
    let written = Instant::now();
    relay.write(&format!("{}\n{}\n", tool_call(22), call("\"r23\"", "prompts/list")));
    assert!(relay.line(HOLD - Duration::from_secs(1)).is_none(), "a held call was answered before its time");
    relay.expect_line(&updating("22", true), BOUND + Duration::from_secs(1));
    assert!(written.elapsed() >= HOLD, "a held call was answered after {:?}, before its time", written.elapsed());
    relay.expect_line(&updating("\"r23\"", false), BOUND);

    // A batch is answered at once, call by call (its notification gets
    // nothing), and never held.
    let batch = format!("[{},{{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{{}}}},{}]", tool_call(24), call("25", "tools/list"));
    relay.write(&format!("{batch}\n"));
    relay.expect_line(format!("[{},{}]\n", updating_json("24", true), updating_json("25", false)).as_bytes(), BOUND);

    // What was answered never reaches an app: the next attach is given the
    // stream and nothing more.
    let mut second = Conn::connect(&held.0, &APP_ACK);
    attach(&mut second);
    second.expect(&mcp_open(1));
    second.quiet_for(Duration::from_secs(1));
    assert!(relay.line(Duration::ZERO).is_none(), "the relay printed more");
    end(&held.0);
}

#[test]
fn at_most_32_calls_and_4_mib_wait_and_a_cancel_drops_a_held_call() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-held");
    let work = Folder::new("work-held");
    let sid = "relay-held-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = app_attached(&held.0, &work);
    let mut relay = Relay::start(&store_dir, sid);
    app.expect(&mcp_open(1));
    let had = tool_call(30);
    relay.write(&format!("{had}\n"));
    app.expect(&mcp_message(1, parse(&had)));
    detach(&mut app);
    relay.expect_line(&updating("30", true), BOUND);

    // 32 calls wait; the 33rd is answered at once.
    let waiting: Vec<u64> = (100..132).collect();
    let mut text: String = waiting.iter().map(|id| format!("{}\n", call(&id.to_string(), "tools/list"))).collect();
    text.push_str(&format!("{}\n", tool_call(132)));
    relay.write(&text);
    relay.expect_line(&updating("132", true), BOUND);
    // A cancel for a held call drops it, and nothing is written for it; one
    // for a call that is not held changes nothing.
    relay.write(&format!("{}\n{}\n", cancel(105), cancel(999)));
    for id in waiting.iter().filter(|id| **id != 105) {
        relay.expect_line(&updating(&id.to_string(), false), HOLD + BOUND);
    }
    assert!(relay.line(Duration::from_secs(1)).is_none(), "something was written for the cancelled call");

    // By size: four calls of the most a message may be wait (4,193,280
    // bytes); the fifth would take them past 4 MiB and is answered at once; a
    // small call after it still fits, and waits.
    let most = MAX_MCP_TO_APP;
    assert!(4 * most <= 4 * 1024 * 1024 && 5 * most > 4 * 1024 * 1024);
    let mut text = String::new();
    for id in 200..=204 {
        text.push_str(&tool_call_of_size(id, most));
        text.push('\n');
    }
    text.push_str(&format!("{}\n", tool_call(205)));
    relay.write(&text);
    relay.expect_line(&updating("204", true), BOUND);
    for id in [200, 201, 202, 203, 205] {
        relay.expect_line(&updating(&id.to_string(), true), HOLD + BOUND);
    }
    assert!(relay.line(Duration::from_secs(1)).is_none(), "the relay printed more");
    end(&held.0);
}

#[test]
fn an_open_while_nothing_takes_tool_streams_is_kept_counts_toward_the_bound_and_ends_with_the_program() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-open-away");
    let work = Folder::new("work-open-away");
    let sid = "relay-open-away-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = attached_without_tools(&held.0, &work);

    // Nothing takes tool streams: a relay that acked `away` has its stream
    // taken, numbered and kept, and is told `mcp.away` on its own number.
    let mut kept: Vec<(u64, Conn)> = Vec::new();
    for n in 1..=MAX_TOOL_STREAMS as u64 {
        let mut k = Conn::keeping_relay(&held.0, n);
        k.expect(&mcp_away(n));
        kept.push((n, k));
    }
    // A kept stream counts as an open one: the ninth is busy, and so is the
    // relay itself.
    let mut ninth = Conn::keeping_relay(&held.0, 9);
    ninth.expect_error("busy");
    Relay::start(&store_dir, sid).fails_quietly("a ninth stream");
    // A relay that did not ack `away` is not-connected, as before.
    let mut plain = Conn::relay(&held.0, 1);
    plain.expect_error("not-connected");
    app.quiet_for(Duration::from_secs(1));

    // Two kept streams close, which makes room: the ninth is kept now, and so
    // is the relay, which runs on.
    for (n, mut k) in kept.drain(..2) {
        k.client.send(mcp_close(n)).expect("send");
        settled(&mut k);
    }
    ninth.client.send(mcp_open(9)).expect("send");
    ninth.expect(&mcp_away(9));
    let mut relay = Relay::start(&store_dir, sid);
    relay.runs_on(BOUND, "a stream kept while nothing takes tool streams");

    // The program exits while the streams are kept: a session keeps nothing
    // past its program, so each relay is told `mcp.close` on its own number,
    // and the relay exits 1.
    app.client.send_raw(1, b"exit 3\r").expect("type into the terminal");
    for (n, k) in kept.iter_mut() {
        k.expect(&mcp_close(*n));
    }
    ninth.expect(&mcp_close(9));
    let status = relay.exit_by(Instant::now() + BOUND).expect("the relay still runs after the program exited");
    assert_eq!(status.code(), Some(1), "{status}");
    let exit = app.next(WAIT).expect("a message once the program exits");
    assert_eq!((t_of(&exit), num(&exit, "code")), ("term.exit", Some(3)), "{}", exit.to_json());
    let mut late = Conn::keeping_relay(&held.0, 1);
    late.expect_error("not-connected");
    end(&held.0);
}

#[test]
fn a_kept_stream_ends_with_its_session_when_the_away_clock_runs_out() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-clock");
    let work = Folder::new("work-clock");
    let sid = "relay-clock-01";
    let away = Duration::from_secs(5);
    let held = Held(hold_away(&store_dir, sid, away.as_secs()));
    let mut app = app_attached(&held.0, &work);
    let mut relay = Relay::start(&store_dir, sid);
    app.expect(&mcp_open(1));
    detach(&mut app);
    let detached = Instant::now();
    relay.runs_on(Duration::from_secs(1), "the app let go");
    // The away clock ends the session. A kept stream does not hold it open:
    // the holder tells no one, and the relay reads the end of its connection
    // and exits 1.
    let status = relay.exit_by(detached + away + BOUND).expect("the relay outlived its session");
    assert_eq!(status.code(), Some(1), "{status}");
    let deadline = Instant::now() + WAIT;
    while pids::alive(held.0.pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!pids::alive(held.0.pid), "the holder still runs after its away clock ran out");
}

#[test]
fn a_relay_acks_away_only_when_its_holder_offers_it() {
    let _serial = one_at_a_time();
    let before: &[&str] = &["core", "local", "hooks", "mcp"];
    let now: &[&str] = &["core", "local", "hooks", "mcp", "away"];
    for (n, offered, acked) in [(1, before, &RELAY_ACK[..]), (2, now, &KEEPING_ACK[..])] {
        let store_dir = Folder::new(&format!("store-ack-{n}"));
        let sid = format!("relay-ack-0{n}");
        let first = stand_in_ack(&store_dir, &sid, offered);
        Relay::start(&store_dir, &sid).fails_quietly("a holder that closes after the ack");
        let ack = first.recv_timeout(WAIT).expect("the stand-in saw the relay").expect("the relay sent no frame");
        assert_eq!(ack.to_json(), hello::ack_message(1, acked).to_json(), "offered {offered:?}");
    }
}
