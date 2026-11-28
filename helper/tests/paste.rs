//! The session's pictures through a holder (protocol section 15, capability
//! `paste`, from 2.1.3-beta.21; ADR-032; probe PH1's checks, here on each OS
//! the Helper job runs): a holder started with `hold --detach`, and test
//! connections standing in for the app. `file.put` and its bytes on the
//! paste channel put one picture into the session's own folder beside the
//! store (`<folder>/sessions/<sid>/paste`, the store being `<folder>/store`);
//! each refusal comes before a byte is taken, and the caps, a bad hash, a
//! byte past size, a stalled upload, a connection that lets go and the
//! session's end each leave nothing behind.

use aicc_helper::client::Client;
use aicc_helper::frame::{self, Body, Direction, Frame};
use aicc_helper::hello;
use aicc_helper::json::Value;
use aicc_helper::paste::{self, Sha256};
use aicc_helper::pids;
use aicc_helper::store::Record;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
const FAKE: &str = env!("CARGO_BIN_EXE_aicc-fake-cli");
const WAIT: Duration = Duration::from_secs(20);
/// The least a connection acks to send a picture (a helper tab on a remote
/// machine acks the rest it takes beside it).
const TAB_CAPS: [&str; 3] = ["core", "local", "paste"];

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// Every test here starts processes, one at a time (as in status.rs).
fn one_at_a_time() -> MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A new, empty folder of this test, 0700 on macOS and Linux, removed when
/// dropped. The holder's store is `store` in it, so the session's picture
/// folder is in it too.
struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Folder {
        let dir = std::env::temp_dir().join(format!("aicc-paste-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a folder");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).expect("the folder's mode");
        }
        Folder(dir)
    }

    fn store(&self) -> String {
        self.0.join("store").to_string_lossy().into_owned()
    }

    fn pictures(&self, sid: &str) -> PathBuf {
        self.0.join("sessions").join(sid).join("paste")
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The names in `dir`, sorted; none when it is not there.
fn names(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(dir).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    out.sort();
    out
}

/// Wait until `ok`, at most `wait`.
fn until(wait: Duration, mut ok: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + wait;
    while Instant::now() < end {
        if ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    ok()
}

fn t_of(v: &Value) -> &str {
    v.get("t").and_then(Value::as_str).unwrap_or("")
}

fn num(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(Value::as_u64)
}

fn code_of(v: &Value) -> &str {
    v.get("code").and_then(Value::as_str).unwrap_or("")
}

fn msg(t: &str, id: u64, more: Vec<(&str, Value)>) -> Value {
    let mut members = vec![("t", Value::str(t)), ("id", Value::uint(id))];
    members.extend(more);
    Value::obj(members)
}

fn sha_of(bytes: &[u8]) -> String {
    let mut s = Sha256::new();
    s.update(bytes);
    paste::hex(&s.finish())
}

/// A picture's bytes: `n` of them, not all alike.
fn picture(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i.wrapping_mul(31) + 7) as u8).collect()
}

/// The program's whole environment for a launch: the search path (and on
/// Windows the system folder), never this test's environment wholesale.
fn minimal_env() -> Value {
    let mut env: Vec<(String, Value)> = Vec::new();
    for name in ["PATH", "SystemRoot"] {
        if let Ok(v) = std::env::var(name) {
            env.push((name.to_string(), Value::Str(v)));
        }
    }
    Value::Obj(env)
}

/// Start a detached holder; the record it printed. Its output goes to files
/// in the test's folder: a holder it starts outlives it, and would hold a pipe open.
fn hold(folder: &Folder, sid: &str) -> Record {
    let out_path = folder.0.join(format!("detach-{sid}.out"));
    let err_path = folder.0.join(format!("detach-{sid}.err"));
    let status = Command::new(HELPER)
        .args(["hold", "--detach", "--store", &folder.store(), "--session", sid, "--away", "60"])
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
    let v = aicc_helper::json::parse(stdout.trim().as_bytes()).unwrap_or_else(|e| panic!("hold printed {stdout:?} ({e:?})"));
    Record::from_value(&v).unwrap_or_else(|e| panic!("hold printed a record that does not read ({e}): {stdout}"))
}

/// A holder this test started, ended when dropped (quietly: a clean-up may
/// run while the test is failing). Declared after its folder, so it is
/// dropped before it.
struct Held(Record);

impl Drop for Held {
    fn drop(&mut self) {
        if !pids::alive(self.0.pid) {
            return;
        }
        if let Ok(mut client) = Client::to_record(&self.0, WAIT) {
            if client.ack().is_ok() && client.send(msg("term.end", 2, vec![])).is_ok() {
                until(WAIT, || !pids::alive(self.0.pid));
            }
        }
    }
}

/// A connection standing in for the app: the JSON messages it read and has
/// not looked at yet, and the terminal's output.
struct App {
    client: Client,
    got: Vec<Value>,
    out: Vec<u8>,
    next_id: u64,
}

impl App {
    fn connect(rec: &Record, caps: &[&str]) -> App {
        let mut client = Client::to_record(rec, WAIT).expect("connect to the holder and read its hello");
        client.send(hello::ack_message(1, caps)).expect("ack the hello");
        App { client, got: Vec::new(), out: Vec::new(), next_id: 2 }
    }

    fn id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 2;
        id
    }

    /// The next JSON message before `until`, the terminal's output kept on
    /// the way; None at the end of the stream, or when none came.
    fn read(&mut self, until: Instant) -> Option<Value> {
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            match self.client.recv(left) {
                Ok(Some(Frame { channel: 0, body: Body::Json(v) })) => return Some(v),
                Ok(Some(Frame { channel: 1, body: Body::Raw(b) })) => self.out.extend_from_slice(&b),
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => return None,
            }
        }
    }

    /// The answer to request `id`, one already read first.
    fn answer_to(&mut self, id: u64, wait: Duration) -> Value {
        if let Some(at) = self.got.iter().position(|m| num(m, "re") == Some(id)) {
            return self.got.remove(at);
        }
        let until = Instant::now() + wait;
        loop {
            match self.read(until) {
                Some(m) if num(&m, "re") == Some(id) => return m,
                Some(m) => self.got.push(m),
                None => panic!("no answer to request {id}; got {:?}", self.got.iter().map(Value::to_json).collect::<Vec<String>>()),
            }
        }
    }

    fn call(&mut self, v: Value) -> Value {
        let id = num(&v, "id").expect("a request id");
        self.client.send(v).expect("send a request");
        self.answer_to(id, WAIT)
    }

    /// A ping answered: the connection is still served.
    fn pings(&mut self) -> bool {
        let id = self.id();
        if self.client.send(msg("ping", id, vec![])).is_err() {
            return false;
        }
        let until = Instant::now() + WAIT;
        loop {
            match self.read(until) {
                Some(m) if num(&m, "re") == Some(id) => return t_of(&m) == "pong",
                Some(m) => self.got.push(m),
                None => return false,
            }
        }
    }

    /// Send `file.put`, then a ping, and wait for its pong, as the app does:
    /// the holder answers in order, so a refusal of the request comes first.
    /// Ok(id) when it was taken (no byte has been sent yet), else the refusal.
    fn put(&mut self, name: &str, size: u64, sha: &str) -> Result<u64, Value> {
        let id = self.id();
        self.client.send(msg("file.put", id, vec![("name", Value::str(name)), ("size", Value::uint(size)), ("sha256", Value::str(sha))])).expect("send file.put");
        assert!(self.pings(), "no pong after file.put");
        match self.got.iter().position(|m| num(m, "re") == Some(id)) {
            Some(at) => Err(self.got.remove(at)),
            None => Ok(id),
        }
    }

    /// The bytes on the paste channel, at most 64 KiB a frame.
    fn chunks(&mut self, bytes: &[u8]) {
        for c in bytes.chunks(65536) {
            self.client.send_raw(paste::CHANNEL, c).expect("send a chunk");
        }
    }

    /// True once the holder closed this connection, within `wait`.
    fn closed_within(&mut self, wait: Duration) -> bool {
        let until = Instant::now() + wait;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            match self.client.recv(left) {
                Ok(Some(Frame { channel: 0, body: Body::Json(v) })) => self.got.push(v),
                Ok(Some(_)) => {}
                Ok(None) => return true,
                Err(e) if matches!(e.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock) => return false,
                Err(_) => return true,
            }
        }
    }

    /// The terminal's output holds `text`, within `wait`: looked at after
    /// every frame, so it answers as soon as the text is there.
    fn shows(&mut self, text: &str, wait: Duration) -> bool {
        let until = Instant::now() + wait;
        loop {
            if String::from_utf8_lossy(&self.out).contains(text) {
                return true;
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            match self.client.recv(left) {
                Ok(Some(Frame { channel: 0, body: Body::Json(v) })) => self.got.push(v),
                Ok(Some(Frame { channel: 1, body: Body::Raw(b) })) => self.out.extend_from_slice(&b),
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => return String::from_utf8_lossy(&self.out).contains(text),
            }
        }
    }
}

/// Launch the fake CLI from `app`'s connection in `cwd`, then attach it from 0.
fn launch_and_attach(app: &mut App, cwd: &Path) {
    let id = app.id();
    let launched = app.call(msg(
        "term.launch",
        id,
        vec![("argv", Value::strs(&[FAKE])), ("cwd", Value::Str(cwd.to_string_lossy().into_owned())), ("env", minimal_env()), ("cols", Value::uint(100)), ("rows", Value::uint(30))],
    ));
    assert_eq!(t_of(&launched), "term.launched", "{}", launched.to_json());
    let id = app.id();
    let attached = app.call(msg("term.attach", id, vec![("from", Value::uint(0))]));
    assert_eq!(t_of(&attached), "term.attached", "{}", attached.to_json());
    assert!(app.shows("FAKE-CLI READY", WAIT), "the fake CLI's banner never came");
}

#[test]
fn a_picture_round_trips_into_the_sessions_own_folder_and_replaces_the_one_before() {
    let _serial = one_at_a_time();
    let folder = Folder::new("round");
    let sid = "paste-round-01";
    let held = Held(hold(&folder, sid));
    let mut app = App::connect(&held.0, &TAB_CAPS);
    assert!(app.client.hello.caps.iter().any(|c| c == "paste"), "the hello offers no paste: {:?}", app.client.hello.caps);
    launch_and_attach(&mut app, &folder.0);
    let dir = folder.pictures(sid);
    let bytes = picture(150_000);
    let id = app.put("paste-1.png", bytes.len() as u64, &sha_of(&bytes)).unwrap_or_else(|r| panic!("refused: {}", r.to_json()));
    app.chunks(&bytes);
    let stored = app.answer_to(id, WAIT);
    // The hash only: no path, and nothing typed.
    assert_eq!(stored.to_json(), format!("{{\"t\":\"file.stored\",\"re\":{id},\"sha256\":\"{}\"}}", sha_of(&bytes)));
    assert_eq!(names(&dir), vec!["paste-1.png"]);
    assert_eq!(fs::read(dir.join("paste-1.png")).expect("the picture"), bytes);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| fs::metadata(p).expect("a mode").permissions().mode() & 0o777;
        assert_eq!(mode(&dir.join("paste-1.png")), 0o600);
        for f in [dir.clone(), folder.0.join("sessions").join(sid), folder.0.join("sessions")] {
            assert_eq!(mode(&f), 0o700, "{}", f.display());
        }
    }
    // Typed input is not held up while a picture is being sent, and the next
    // picture replaces the one before.
    let jpg = picture(70_000);
    let id = app.put("paste-2.jpg", jpg.len() as u64, &sha_of(&jpg)).unwrap_or_else(|r| panic!("refused: {}", r.to_json()));
    app.chunks(&jpg[..65536]);
    app.client.send_raw(1, b"during\r").expect("type");
    assert!(app.shows("echo: during", WAIT), "typed input waited behind the picture");
    app.chunks(&jpg[65536..]);
    assert_eq!(t_of(&app.answer_to(id, WAIT)), "file.stored");
    assert_eq!(names(&dir), vec!["paste-2.jpg"]);
    assert!(app.pings());
}

#[test]
fn every_refusal_comes_before_a_byte_and_the_connection_goes_on() {
    let _serial = one_at_a_time();
    let folder = Folder::new("refusals");
    let sid = "paste-refuse-01";
    let held = Held(hold(&folder, sid));
    let dir = folder.pictures(sid);
    let small = picture(10);
    let sha = sha_of(&small);
    let mut app = App::connect(&held.0, &TAB_CAPS);
    // Before a launch: not-found.
    assert_eq!(code_of(&app.put("paste-1.png", 10, &sha).unwrap_err()), "not-found");
    launch_and_attach(&mut app, &folder.0);
    // The request's own rules: bad-field and too-large.
    for (name, size, code) in [("paste-01.png", 10u64, "bad-field"), ("../paste-1.png", 10, "bad-field"), ("paste-1.gif", 10, "bad-field"), ("paste-1.png", 0, "bad-field"), ("paste-1.png", paste::MAX_PICTURE + 1, "too-large")] {
        let refusal = app.put(name, size, &sha).unwrap_err();
        assert_eq!(code_of(&refusal), code, "{name} {size}: {}", refusal.to_json());
    }
    // A name there already: bad-field.
    let id = app.put("paste-2.png", 10, &sha).expect("taken");
    app.chunks(&small);
    assert_eq!(t_of(&app.answer_to(id, WAIT)), "file.stored");
    assert_eq!(code_of(&app.put("paste-2.png", 10, &sha).unwrap_err()), "bad-field");
    // The folder's 100 MiB with what it holds (a sparse file stands in): one byte more is too large.
    let big = fs::File::create(dir.join("paste-9.png")).expect("a big file");
    big.set_len(paste::MAX_HELD - 20).expect("its size");
    drop(big);
    assert_eq!(code_of(&app.put("paste-3.png", 11, &sha).unwrap_err()), "too-large");
    fs::remove_file(dir.join("paste-9.png")).expect("remove the big file");
    // One at a time: a second picture while one is being sent is busy, from any connection.
    let open = app.put("paste-4.png", 10, &sha).expect("taken");
    assert_eq!(code_of(&app.put("paste-5.png", 10, &sha).unwrap_err()), "busy");
    app.chunks(&small);
    assert_eq!(t_of(&app.answer_to(open, WAIT)), "file.stored");
    // A connection that acked paste but is not attached: not-connected.
    let mut other = App::connect(&held.0, &TAB_CAPS);
    assert_eq!(code_of(&other.put("paste-6.png", 10, &sha).unwrap_err()), "not-connected");
    assert!(other.pings());
    // Every refusal came before a byte was taken: nothing but the stored
    // picture, and the connection is still served.
    assert_eq!(names(&dir), vec!["paste-4.png"]);
    assert!(app.pings());
    // A connection that did not ack paste: unknown-type, and it is closed.
    let mut plain = App::connect(&held.0, &["core", "local"]);
    let id = plain.id();
    plain.client.send(msg("file.put", id, vec![("name", Value::str("paste-7.png")), ("size", Value::uint(10)), ("sha256", Value::str(&sha))])).expect("send");
    assert!(plain.closed_within(WAIT), "a connection without paste was not closed");
    assert!(plain.got.iter().any(|m| code_of(m) == "unknown-type"), "{:?}", plain.got.iter().map(Value::to_json).collect::<Vec<String>>());
}

#[test]
fn a_bad_hash_a_byte_past_size_and_bytes_with_no_picture_leave_nothing() {
    let _serial = one_at_a_time();
    let folder = Folder::new("nothing");
    let sid = "paste-nothing-01";
    let held = Held(hold(&folder, sid));
    let dir = folder.pictures(sid);
    let mut app = App::connect(&held.0, &TAB_CAPS);
    launch_and_attach(&mut app, &folder.0);
    let bytes = picture(1000);
    // A bad hash: bad-field after the last byte, nothing kept, the connection goes on.
    let id = app.put("paste-1.png", 1000, &sha_of(b"another picture")).expect("taken");
    app.chunks(&bytes);
    assert_eq!(code_of(&app.answer_to(id, WAIT)), "bad-field");
    assert_eq!(names(&dir), Vec::<String>::new());
    assert!(app.pings());
    // A byte past size: too-large, and no partial file.
    let id = app.put("paste-2.png", 999, &sha_of(&bytes[..999])).expect("taken");
    app.chunks(&bytes);
    assert_eq!(code_of(&app.answer_to(id, WAIT)), "too-large");
    assert_eq!(names(&dir), Vec::<String>::new());
    assert!(app.pings());
    // Bytes on the paste channel with no picture being sent: bad-frame, and a close.
    app.chunks(b"stray");
    assert!(app.closed_within(WAIT), "stray bytes on the paste channel did not close the connection");
    assert!(app.got.iter().any(|m| code_of(m) == "bad-frame"));
}

#[test]
fn a_stalled_upload_ends_with_timeout_and_the_connection_goes_on() {
    let _serial = one_at_a_time();
    let folder = Folder::new("stall");
    let sid = "paste-stall-01";
    let held = Held(hold(&folder, sid));
    let dir = folder.pictures(sid);
    let mut app = App::connect(&held.0, &TAB_CAPS);
    launch_and_attach(&mut app, &folder.0);
    let bytes = picture(1000);
    let started = Instant::now();
    let id = app.put("paste-1.png", 1000, &sha_of(&bytes)).expect("taken");
    app.chunks(&bytes[..400]);
    assert_eq!(names(&dir), vec![".part-1"]);
    let answer = app.answer_to(id, paste::CHUNK_WAIT + WAIT);
    assert_eq!(code_of(&answer), "timeout", "{}", answer.to_json());
    assert!(started.elapsed() >= paste::CHUNK_WAIT - Duration::from_millis(300), "timed out after {:?}", started.elapsed());
    assert_eq!(names(&dir), Vec::<String>::new());
    // The connection goes on, and the next picture is taken.
    assert!(app.pings());
    let id = app.put("paste-2.png", 1000, &sha_of(&bytes)).expect("taken after the timeout");
    app.chunks(&bytes);
    assert_eq!(t_of(&app.answer_to(id, WAIT)), "file.stored");
}

#[test]
fn a_frame_begun_before_the_next_chunk_is_due_is_read_whole_and_the_overdue_upload_ends_with_the_link_up() {
    let _serial = one_at_a_time();
    let folder = Folder::new("midframe");
    let sid = "paste-midframe-01";
    let held = Held(hold(&folder, sid));
    let dir = folder.pictures(sid);
    let mut app = App::connect(&held.0, &TAB_CAPS);
    launch_and_attach(&mut app, &folder.0);
    let bytes = picture(1000);
    let id = app.put("paste-1.png", 1000, &sha_of(&bytes)).expect("taken");
    // The holder takes the chunk once it is sent, so the next one is due no
    // earlier than CHUNK_WAIT (CHUNK_WAIT_TEST in this build) after this.
    let sent = Instant::now();
    app.chunks(&bytes[..400]);
    // 64 KiB of typed input in one frame on the terminal channel, as a large
    // text paste sends it: lines of 256 bytes, each ended by Enter.
    let mut typed = Vec::with_capacity(frame::MAX_RAW);
    for i in 0..frame::MAX_RAW / 256 {
        typed.extend_from_slice(format!("{:<255}\r", format!("typed while a picture waits {i:03}")).as_bytes());
    }
    let whole = frame::encode(&Frame::raw(1, typed), Direction::AppToHelper).expect("a frame");
    // Its 9 header bytes 500 ms before the chunk is due, the rest 1 s later:
    // the frame is still arriving when the chunk wait runs out.
    std::thread::sleep((sent + paste::CHUNK_WAIT - Duration::from_millis(500)).saturating_duration_since(Instant::now()));
    app.client.send_bytes(&whole[..9]).expect("send the frame's header");
    std::thread::sleep(Duration::from_secs(1));
    let rest = app.client.send_bytes(&whole[9..]);
    // The upload's own timeout answer, not a close: the frame was read whole.
    let answer = app.answer_to(id, WAIT);
    assert_eq!((t_of(&answer), code_of(&answer)), ("error", "timeout"), "{}", answer.to_json());
    rest.expect("send the rest of the frame");
    assert_eq!(names(&dir), Vec::<String>::new());
    assert!(app.pings(), "the connection did not go on after the overdue upload's timeout");
}

#[test]
fn a_connection_that_lets_go_mid_picture_leaves_nothing_and_the_folder_goes_at_the_end() {
    let _serial = one_at_a_time();
    let folder = Folder::new("letgo");
    let sid = "paste-letgo-01";
    let held = Held(hold(&folder, sid));
    let dir = folder.pictures(sid);
    let bytes = picture(1000);
    let mut app = App::connect(&held.0, &TAB_CAPS);
    launch_and_attach(&mut app, &folder.0);
    // A detach mid-picture: its partial file goes.
    app.put("paste-1.png", 1000, &sha_of(&bytes)).expect("taken");
    app.chunks(&bytes[..300]);
    assert_eq!(names(&dir), vec![".part-1"]);
    let id = app.id();
    assert_eq!(t_of(&app.call(msg("term.detach", id, vec![]))), "term.detached");
    assert!(until(WAIT, || names(&dir).is_empty()), "left {:?}", names(&dir));
    // A replacement mid-picture: the same.
    let mut first = App::connect(&held.0, &TAB_CAPS);
    let id = first.id();
    assert_eq!(t_of(&first.call(msg("term.attach", id, vec![("from", Value::uint(0))]))), "term.attached");
    first.put("paste-2.png", 1000, &sha_of(&bytes)).expect("taken");
    first.chunks(&bytes[..300]);
    let mut second = App::connect(&held.0, &TAB_CAPS);
    let id = second.id();
    assert_eq!(t_of(&second.call(msg("term.attach", id, vec![("from", Value::uint(0))]))), "term.attached");
    assert!(first.closed_within(WAIT), "the replaced connection was not closed");
    assert!(until(WAIT, || names(&dir).is_empty()), "left {:?}", names(&dir));
    // A picture stored, then the session's end: the folder goes with it.
    let id = second.put("paste-3.png", 1000, &sha_of(&bytes)).expect("taken");
    second.chunks(&bytes);
    assert_eq!(t_of(&second.answer_to(id, WAIT)), "file.stored");
    assert_eq!(names(&dir), vec!["paste-3.png"]);
    let id = second.id();
    assert_eq!(t_of(&second.call(msg("term.end", id, vec![]))), "term.ended");
    assert!(until(WAIT, || !pids::alive(held.0.pid)), "the holder did not end");
    assert!(!dir.exists(), "the session's picture folder is still there: {:?}", names(&dir));
}
