//! The bridge mode (`aicc-helper bridge`, from 2.1.3-beta.17, remote step 1):
//! one connection to a session's holder, carried over the bridge's standard
//! input and output, as the app carries it over an `ssh -T` exec to a holder
//! on another machine. The test stands in for the app on the far side of the
//! bridge's pipes: a holder of the fake CLI started with `hold --detach` for
//! the protocol exchange, and a stand-in holder on a real endpoint where the
//! test needs exact bytes both ways, a holder that never closes, or more
//! than the bridge's queue for standard output holds. A standard error that
//! cannot be written leaves every exit status as documented.
//!
//! On Windows the mode does not run: it exits 1.

use std::process::{Command, Stdio};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");

#[cfg(windows)]
#[test]
fn the_bridge_does_not_run_on_windows_and_exits_1() {
    for args in [&["bridge", "--store", ".", "--session", "brdg-0001"][..], &["bridge"][..]] {
        let out = Command::new(HELPER).args(args).stdin(Stdio::null()).output().expect("run the helper");
        assert_eq!(out.status.code(), Some(1), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        assert!(out.stdout.is_empty(), "{args:?} printed on standard output");
        // A standard error that cannot be written changes nothing: 1, not
        // 101 from a panic.
        let (read_end, write_end) = std::io::pipe().expect("a pipe");
        drop(read_end);
        let out = Command::new(HELPER).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(write_end).output().expect("run the helper");
        assert_eq!(out.status.code(), Some(1), "{args:?} with standard error closed: {}", out.status);
        assert!(out.stdout.is_empty(), "{args:?} printed on standard output");
    }
}

#[cfg(unix)]
mod on_unix {
    use super::{Command, Stdio, HELPER};
    use aicc_helper::bridge::MAX_QUEUED;
    use aicc_helper::client::{self, Client};
    use aicc_helper::frame::{self, Body, Direction, Frame};
    use aicc_helper::hello::{self, LOCAL_CAPS, MAX_HELLO_LINE};
    use aicc_helper::json::{self, Value};
    use aicc_helper::pids;
    use aicc_helper::store::{self, Record};
    use aicc_helper::transport::{self, Listener};
    use std::ffi::OsStr;
    use std::fs;
    use std::io::{Read, Write};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, ChildStdin, ExitStatus};
    use std::sync::mpsc::{self, Receiver};
    use std::sync::{Mutex, MutexGuard};
    use std::thread;
    use std::time::{Duration, Instant};

    const FAKE: &str = env!("CARGO_BIN_EXE_aicc-fake-cli");
    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    const WAIT: Duration = Duration::from_secs(20);

    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

    /// One test at a time: each starts processes, and a holder's away clock
    /// and its connections are easier to read alone.
    fn one_at_a_time() -> MutexGuard<'static, ()> {
        ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A new, empty folder of this test, 0700 whatever the umask (a crate's
    /// tests share one process and its umask), removed when dropped.
    struct Folder(PathBuf);

    impl Folder {
        fn new(name: &str) -> Folder {
            let dir = std::env::temp_dir().join(format!("aicc-bridge-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("a folder");
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).expect("the folder's mode");
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

    fn msg(t: &str, id: u64, more: Vec<(&str, Value)>) -> Value {
        let mut members = vec![("t", Value::str(t)), ("id", Value::uint(id))];
        members.extend(more);
        Value::obj(members)
    }

    /// The fake CLI, in `cwd`, with this test's environment.
    fn launch_msg(id: u64, cwd: &Path) -> Value {
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
        msg(
            "term.launch",
            id,
            vec![
                ("argv", Value::strs(&[FAKE])),
                ("cwd", Value::Str(cwd.to_string_lossy().into_owned())),
                ("env", Value::Obj(env)),
                ("cols", Value::uint(120)),
                ("rows", Value::uint(24)),
            ],
        )
    }

    /// Start a detached holder; the record it printed. Its output goes to
    /// files: the holder outlives this call, and would hold a pipe open.
    fn hold(store_dir: &Folder, sid: &str) -> Record {
        let base = std::env::temp_dir().join(format!("aicc-bridge-detach-{sid}-{}", std::process::id()));
        let out_path = base.with_extension("out");
        let err_path = base.with_extension("err");
        let status = Command::new(HELPER)
            .args(["hold", "--detach", "--store", &store_dir.arg(), "--session", sid])
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
        let v = json::parse(stdout.trim().as_bytes()).unwrap_or_else(|e| panic!("hold printed {stdout:?} ({e:?})"));
        Record::from_value(&v).unwrap_or_else(|e| panic!("hold printed a record that does not read ({e}): {stdout}"))
    }

    /// A holder this test started, ended when dropped (quietly: the clean-up
    /// may run while the test is failing). Declared after its folders.
    struct Held(Record);

    impl Drop for Held {
        fn drop(&mut self) {
            if !pids::alive(self.0.pid) {
                return;
            }
            if let Ok(mut c) = Client::to_record(&self.0, WAIT) {
                if c.ack().is_ok() && c.send(msg("term.end", 2, vec![])).is_ok() {
                    let deadline = Instant::now() + WAIT;
                    while pids::alive(self.0.pid) && Instant::now() < deadline {
                        thread::sleep(Duration::from_millis(50));
                    }
                }
            }
        }
    }

    /// A record in `store_dir` for `sid` naming `endpoint` and `pid`, as a
    /// holder writes it.
    fn write_record(store_dir: &Folder, sid: &str, endpoint: &str, pid: u32) {
        store::prepare(&store_dir.0).expect("a store");
        let rec = Record {
            session: sid.to_string(),
            label: String::new(),
            pid,
            endpoint: endpoint.to_string(),
            nonce: NONCE.to_string(),
            helper: "0.1.0".to_string(),
            started: store::now_ms(),
            lifetime: aicc_helper::store::Lifetime::Away(120),
            attached: false,
            child: "running".to_string(),
            code: None,
        };
        store::write(&store_dir.0, &rec).expect("a record");
    }

    /// One bridge run: its standard input, and its standard output read by a
    /// thread of its own, so a test never blocks on it past its own limit.
    struct Bridge {
        child: Child,
        stdin: Option<ChildStdin>,
        out: Receiver<Option<Vec<u8>>>,
        buf: Vec<u8>,
        ended: bool,
        screen: Vec<u8>,
        messages: Vec<Value>,
    }

    impl Bridge {
        fn start(store_dir: &Folder, sid: &str) -> Bridge {
            let mut child = Command::new(HELPER)
                .args(["bridge", "--store", &store_dir.arg(), "--session", sid])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .expect("start the bridge");
            let mut stdout = child.stdout.take().expect("its standard output");
            let (tx, out) = mpsc::channel();
            thread::spawn(move || {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    match stdout.read(&mut buf) {
                        Ok(0) | Err(_) => {
                            let _ = tx.send(None);
                            return;
                        }
                        Ok(n) => {
                            if tx.send(Some(buf[..n].to_vec())).is_err() {
                                return;
                            }
                        }
                    }
                }
            });
            let stdin = child.stdin.take();
            Bridge { child, stdin, out, buf: Vec::new(), ended: false, screen: Vec::new(), messages: Vec::new() }
        }

        /// Wait for more of standard output, until `until`: false at its end or
        /// when nothing more came in time.
        fn fill(&mut self, until: Instant) -> bool {
            if self.ended {
                return false;
            }
            match self.out.recv_timeout(until.saturating_duration_since(Instant::now())) {
                Ok(Some(bytes)) => {
                    self.buf.extend_from_slice(&bytes);
                    true
                }
                Ok(None) => {
                    self.ended = true;
                    false
                }
                Err(_) => false,
            }
        }

        /// The first line of standard output, without its line end.
        fn line(&mut self) -> Vec<u8> {
            let until = Instant::now() + WAIT;
            loop {
                if let Some(at) = self.buf.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = self.buf.drain(..=at).collect();
                    return line[..line.len() - 1].to_vec();
                }
                assert!(self.fill(until), "no whole line came through the bridge: {:?}", String::from_utf8_lossy(&self.buf));
            }
        }

        /// The next frame, as the app reads it; None at the end or past `until`.
        fn frame(&mut self, until: Instant) -> Option<Frame> {
            loop {
                if self.buf.len() >= 4 {
                    let rest = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
                    if self.buf.len() >= 4 + rest {
                        let bytes: Vec<u8> = self.buf.drain(..4 + rest).collect();
                        return Some(frame::decode(&bytes, Direction::HelperToApp).unwrap_or_else(|e| panic!("a frame that does not decode came through the bridge: {e:?}")));
                    }
                }
                if !self.fill(until) {
                    return None;
                }
            }
        }

        /// Read one frame into the screen or the messages; false at the end or
        /// past `until`.
        fn pump(&mut self, until: Instant) -> bool {
            match self.frame(until) {
                Some(Frame { channel: 1, body: Body::Raw(bytes) }) => self.screen.extend_from_slice(&bytes),
                Some(Frame { channel: 0, body: Body::Json(v) }) => self.messages.push(v),
                Some(other) => panic!("a frame on an unexpected channel: {other:?}"),
                None => return false,
            }
            true
        }

        fn send(&mut self, v: Value) {
            let bytes = frame::encode(&Frame::json(0, v), Direction::AppToHelper).expect("a frame");
            self.write(&bytes);
        }

        fn send_raw(&mut self, channel: u32, bytes: &[u8]) {
            let bytes = frame::encode(&Frame::raw(channel, bytes.to_vec()), Direction::AppToHelper).expect("a frame");
            self.write(&bytes);
        }

        fn write(&mut self, bytes: &[u8]) {
            let stdin = self.stdin.as_mut().expect("standard input is still open");
            stdin.write_all(bytes).and_then(|_| stdin.flush()).expect("write to the bridge");
        }

        /// Send `v` and wait for the message that answers its id.
        fn call(&mut self, v: Value) -> Value {
            let id = v.get("id").and_then(Value::as_u64).expect("a request id");
            self.send(v);
            let until = Instant::now() + WAIT;
            loop {
                if let Some(at) = self.messages.iter().position(|m| m.get("re").and_then(Value::as_u64) == Some(id)) {
                    return self.messages.remove(at);
                }
                if !self.pump(until) {
                    let seen: Vec<String> = self.messages.iter().map(Value::to_json).collect();
                    panic!("no answer to {id}; messages {seen:?}");
                }
            }
        }

        fn wait_text(&mut self, needle: &str) {
            let until = Instant::now() + WAIT;
            while !String::from_utf8_lossy(&self.screen).contains(needle) {
                assert!(self.pump(until), "{needle:?} never came through the bridge: {:?}", String::from_utf8_lossy(&self.screen));
            }
        }

        /// Close the bridge's standard input, as the app letting go does.
        fn close_input(&mut self) {
            drop(self.stdin.take());
        }

        /// Everything left on standard output, to its end.
        fn rest(&mut self) -> Vec<u8> {
            let until = Instant::now() + WAIT;
            while self.fill(until) {}
            assert!(self.ended, "standard output did not end within {WAIT:?}");
            std::mem::take(&mut self.buf)
        }

        /// The bridge's exit status, within `limit`.
        fn wait(&mut self, limit: Duration) -> ExitStatus {
            exit_within(&mut self.child, limit)
        }
    }

    /// A bridge's exit status, within `limit`; past it the bridge is ended
    /// and the test fails.
    fn exit_within(child: &mut Child, limit: Duration) -> ExitStatus {
        let until = Instant::now() + limit;
        loop {
            if let Some(status) = child.try_wait().expect("ask for the bridge's status") {
                return status;
            }
            if Instant::now() >= until {
                let _ = child.kill();
                let _ = child.wait();
                panic!("the bridge did not exit within {limit:?}");
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// Write `len` bytes to `s`, `block` over and over, then flush.
    fn send_repeated(s: &mut impl Write, block: &[u8], len: usize) -> std::io::Result<()> {
        let mut left = len;
        while left > 0 {
            let n = left.min(block.len());
            s.write_all(&block[..n])?;
            left -= n;
        }
        s.flush()
    }

    impl Drop for Bridge {
        fn drop(&mut self) {
            if let Ok(None) = self.child.try_wait() {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }

    /// `len` bytes holding every byte value, line ends and zeros included.
    fn pattern(len: usize, step: usize) -> Vec<u8> {
        (0..len).map(|i| ((i * step + i / 251) % 256) as u8).collect()
    }

    /// Where two byte strings first differ, for a message.
    fn first_difference(a: &[u8], b: &[u8]) -> String {
        match a.iter().zip(b).position(|(x, y)| x != y) {
            Some(at) => format!("they differ first at byte {at} ({} and {} bytes)", a.len(), b.len()),
            None => format!("one is a prefix of the other ({} and {} bytes)", a.len(), b.len()),
        }
    }

    /// The app's side through the bridge: the holder's hello exactly as a
    /// direct connection reads it, a launch, an attach with the fake CLI's
    /// output and a typed line. Standard input ending leaves the session
    /// held, and a second bridge attaches again with the replay. Then the
    /// holder ends the session and closes the connection: the bridge passes
    /// its answer and exits 0.
    #[test]
    fn the_hello_and_a_term_attach_exchange_pass_through_and_the_session_outlives_the_bridge() {
        let _serial = one_at_a_time();
        let store_dir = Folder::new("exchange-store");
        let work = Folder::new("exchange-work");
        let held = Held(hold(&store_dir, "brdg-0001"));
        let rec = held.0.clone();

        // What a direct connection reads first, before any launch.
        let direct = {
            let mut s = transport::connect(&rec.endpoint, WAIT).expect("connect to the holder");
            client::read_line(&mut s, MAX_HELLO_LINE, WAIT).expect("the holder's hello")
        };

        let mut b = Bridge::start(&store_dir, &rec.session);
        let line = b.line();
        assert_eq!(String::from_utf8_lossy(&line), direct, "the hello line did not come through as the holder sends it");
        hello::parse_hello_line(&direct, &rec.nonce, &rec.session).expect("the holder's own hello, with its record's nonce and session");
        b.send(hello::ack_message(1, &LOCAL_CAPS));
        let launched = b.call(launch_msg(2, &work.0));
        assert_eq!(t_of(&launched), "term.launched", "{}", launched.to_json());
        let attached = b.call(msg("term.attach", 4, vec![("from", Value::uint(0))]));
        assert_eq!(t_of(&attached), "term.attached", "{}", attached.to_json());
        b.wait_text("FAKE-CLI READY");
        b.send_raw(1, b"over the bridge\r");
        b.wait_text("echo: over the bridge");

        // The app lets go: the bridge ends its half, the holder closes its
        // own, and the bridge exits 0. The session is still held.
        b.close_input();
        let status = b.wait(WAIT);
        assert_eq!(status.code(), Some(0), "the bridge's exit once its standard input ended: {status}");
        assert!(pids::alive(rec.pid), "the holder ended with the bridge's connection");

        // A second bridge, as the app re-attaches after a dropped link: the
        // replay brings what was on the terminal.
        let mut again = Bridge::start(&store_dir, &rec.session);
        let line = again.line();
        hello::parse_hello_line(&String::from_utf8_lossy(&line), &rec.nonce, &rec.session).expect("the holder's hello again");
        again.send(hello::ack_message(1, &LOCAL_CAPS));
        let attached = again.call(msg("term.attach", 2, vec![("from", Value::uint(0))]));
        assert_eq!(t_of(&attached), "term.attached", "{}", attached.to_json());
        again.wait_text("echo: over the bridge");

        // The holder ends the session and closes: its answer comes through,
        // and then the bridge exits 0.
        let ended = again.call(msg("term.end", 4, vec![]));
        assert_eq!(t_of(&ended), "term.ended", "{}", ended.to_json());
        let status = again.wait(WAIT);
        assert_eq!(status.code(), Some(0), "the bridge's exit once the holder closed: {status}");
        let deadline = Instant::now() + WAIT;
        while pids::alive(rec.pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(!pids::alive(rec.pid), "the holder outlived term.end");
    }

    /// Every byte value, both ways, exactly as it came: a stand-in holder
    /// sends one pattern and reads another to its end, then closes. The
    /// bridge's standard input ends after its pattern, which ends the
    /// stand-in's reading.
    #[test]
    fn the_bytes_pass_both_ways_exactly_as_they_came() {
        let _serial = one_at_a_time();
        bytes_both_ways("bytes", 0);
    }

    /// How many times the next test runs the bytes exchange.
    const HALF_CLOSE_ROUNDS: usize = 1000;

    /// The bytes exchange again and again. The bridge ends its half of the
    /// connection just as the stand-in holder takes the last of standard
    /// input's bytes and reads again, and that read must see the end. On
    /// macOS it could sleep on, though the end was there for any new look at
    /// the socket, until the bridge gave up after `HALF_CLOSE_WAIT` and
    /// exited 1: 10 of 2000 rounds on macOS CI with the read as it was before
    /// `transport::unix::wait_readable`, none of 2000 on Linux. A holder
    /// reads its connection with the same `Stream::read` as the stand-in.
    #[test]
    fn the_holder_sees_the_end_of_standard_input_however_it_races_the_last_bytes() {
        let _serial = one_at_a_time();
        for round in 1..=HALF_CLOSE_ROUNDS {
            bytes_both_ways("bytes-rounds", round);
        }
    }

    /// One bytes exchange through a new bridge (`round` names it in a failure).
    fn bytes_both_ways(name: &str, round: usize) {
        let store_dir = Folder::new(&format!("{name}-{round}"));
        let sid = "brdg-0002";
        let listener = Listener::bind(sid).expect("listen");
        write_record(&store_dir, sid, listener.endpoint(), std::process::id());
        let to_app = pattern(300_000, 7);
        let from_app = pattern(200_000, 13);
        let sending = to_app.clone();
        let (got_tx, got) = mpsc::channel();
        thread::spawn(move || {
            let mut received = Vec::new();
            if let Ok(mut s) = listener.accept() {
                let _ = s.write_all(&sending).and_then(|_| s.flush());
                let _ = s.set_read_timeout(Some(WAIT));
                let mut buf = [0u8; 8192];
                loop {
                    match s.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => received.extend_from_slice(&buf[..n]),
                    }
                }
            }
            let _ = got_tx.send(received);
        });

        let mut b = Bridge::start(&store_dir, sid);
        let mut stdin = b.stdin.take().expect("standard input");
        let input = from_app.clone();
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
            // Dropped here: standard input ends after the pattern.
        });
        let started = Instant::now();
        let out = b.rest();
        assert!(out == to_app, "round {round}: what the holder sent did not reach standard output as it was: {}", first_difference(&out, &to_app));
        let received = got.recv_timeout(WAIT).expect("the stand-in read to its end");
        assert!(received == from_app, "round {round}: what standard input brought did not reach the holder as it was: {}", first_difference(&received, &from_app));
        let status = b.wait(WAIT);
        assert_eq!(status.code(), Some(0), "round {round}: {status} after {:?}", started.elapsed());
    }

    /// No record, a record whose holder's process is gone, and a record
    /// whose endpoint has nothing on it: each exits 3, and nothing is printed
    /// on standard output.
    #[test]
    fn no_holder_for_the_session_exits_3() {
        let _serial = one_at_a_time();
        let no_holder = |store_dir: &Folder, sid: &str, case: &str| {
            let out = Command::new(HELPER).args(["bridge", "--store", &store_dir.arg(), "--session", sid]).stdin(Stdio::null()).output().expect("run the bridge");
            assert_eq!(out.status.code(), Some(3), "{case}: {}", String::from_utf8_lossy(&out.stderr));
            assert!(out.stdout.is_empty(), "{case}: printed on standard output");
        };

        let empty = Folder::new("no-record");
        store::prepare(&empty.0).expect("a store");
        no_holder(&empty, "brdg-0003", "no record");
        let missing = Folder::new("no-store");
        let _ = fs::remove_dir_all(&missing.0);
        no_holder(&missing, "brdg-0003", "no store folder");

        // A holder that is gone: its process ended, though its endpoint
        // still has a listener on it (the process id is the first check).
        let gone = Folder::new("gone");
        let listener = Listener::bind("brdg-0004").expect("listen");
        let mut ended = Command::new(HELPER).arg("version").stdout(Stdio::null()).spawn().expect("start a process");
        let dead_pid = ended.id();
        ended.wait().expect("it ends");
        write_record(&gone, "brdg-0004", listener.endpoint(), dead_pid);
        no_holder(&gone, "brdg-0004", "the holder's process is gone");

        // A record whose endpoint nothing listens on any more.
        let stale = Folder::new("stale");
        let endpoint = {
            let l = Listener::bind("brdg-0005").expect("listen");
            l.endpoint().to_string()
        };
        write_record(&stale, "brdg-0005", &endpoint, std::process::id());
        no_holder(&stale, "brdg-0005", "nothing listens on the endpoint");
        drop(listener);
    }

    /// A command line the bridge does not take exits 2, before it reads a
    /// record or connects, and prints nothing on standard output.
    #[test]
    fn a_usage_error_exits_2() {
        let _serial = one_at_a_time();
        let store_dir = Folder::new("usage");
        let dir = store_dir.arg();
        let cases: Vec<Vec<&OsStr>> = vec![
            vec![],
            vec![OsStr::new("--store")],
            vec![OsStr::new("--store"), OsStr::new(&dir)],
            vec![OsStr::new("--session"), OsStr::new("brdg-0006")],
            vec![OsStr::new("--store"), OsStr::new(""), OsStr::new("--session"), OsStr::new("brdg-0006")],
            vec![OsStr::new("--store"), OsStr::new(&dir), OsStr::new("--session"), OsStr::new("bad")],
            vec![OsStr::new("--store"), OsStr::new(&dir), OsStr::new("--store"), OsStr::new(&dir), OsStr::new("--session"), OsStr::new("brdg-0006")],
            vec![OsStr::new("--store"), OsStr::new(&dir), OsStr::new("--session"), OsStr::new("brdg-0006"), OsStr::new("--away"), OsStr::new("5")],
            vec![OsStr::new("--store"), OsStr::from_bytes(b"/tmp/\xff"), OsStr::new("--session"), OsStr::new("brdg-0006")],
        ];
        for args in cases {
            let out = Command::new(HELPER).arg("bridge").args(&args).stdin(Stdio::null()).output().expect("run the bridge");
            assert_eq!(out.status.code(), Some(2), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
            assert!(out.stdout.is_empty(), "{args:?}: printed on standard output");
        }
    }

    /// Standard input ended, and the holder never closes its half: the bridge
    /// gives up after its wait, ends the connection and exits 1.
    #[test]
    fn a_holder_that_does_not_close_after_standard_input_ends_gets_exit_1() {
        let _serial = one_at_a_time();
        let store_dir = Folder::new("no-close");
        let sid = "brdg-0007";
        let listener = Listener::bind(sid).expect("listen");
        write_record(&store_dir, sid, listener.endpoint(), std::process::id());
        let (saw_end_tx, saw_end) = mpsc::channel();
        let (release_tx, release) = mpsc::channel::<()>();
        thread::spawn(move || {
            if let Ok(mut s) = listener.accept() {
                let _ = s.set_read_timeout(Some(WAIT));
                let mut buf = [0u8; 1024];
                let ended = loop {
                    match s.read(&mut buf) {
                        Ok(0) => break true,
                        Ok(_) => {}
                        Err(_) => break false,
                    }
                };
                let _ = saw_end_tx.send(ended);
                // Hold the connection open until the test is done.
                let _ = release.recv_timeout(Duration::from_secs(60));
            }
        });
        let mut b = Bridge::start(&store_dir, sid);
        b.close_input();
        assert_eq!(saw_end.recv_timeout(WAIT), Ok(true), "the stand-in did not see the bridge's half end");
        let status = b.wait(WAIT);
        assert_eq!(status.code(), Some(1), "{status}");
        assert!(b.rest().is_empty(), "the bridge printed something of its own");
        let _ = release_tx.send(());
    }

    /// A standard error that cannot be written, as once the ssh link has
    /// dropped and sshd has closed all three pipes: the bridge still exits
    /// with its own status, 3 with no holder and 2 on a usage error, never
    /// 101 from a panic.
    #[test]
    fn a_closed_standard_error_does_not_change_the_exit_status() {
        let _serial = one_at_a_time();
        let store_dir = Folder::new("closed-stderr");
        store::prepare(&store_dir.0).expect("a store");
        let dir = store_dir.arg();
        let cases: [(&[&str], i32); 2] = [(&["bridge", "--store", dir.as_str(), "--session", "brdg-0008"], 3), (&["bridge", "--store", dir.as_str()], 2)];
        for (args, code) in cases {
            let (read_end, write_end) = std::io::pipe().expect("a pipe");
            drop(read_end);
            let out = Command::new(HELPER).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(write_end).output().expect("run the bridge");
            assert_eq!(out.status.code(), Some(code), "{args:?} with standard error closed: {}", out.status);
            assert!(out.stdout.is_empty(), "{args:?}: printed on standard output");
        }
    }

    /// The queue for standard output counts only what standard output has
    /// not taken yet: more than `MAX_QUEUED` passes in all while standard
    /// output keeps reading. A stand-in holder sends five eighths of the
    /// bound, waits until the test has read all of it, sends as much again
    /// and closes.
    #[test]
    fn more_than_the_queue_bound_passes_in_all_when_standard_output_is_read() {
        let _serial = one_at_a_time();
        let store_dir = Folder::new("past-bound");
        let sid = "brdg-0009";
        let listener = Listener::bind(sid).expect("listen");
        write_record(&store_dir, sid, listener.endpoint(), std::process::id());
        let part = MAX_QUEUED * 5 / 8;
        let block = pattern(1024 * 1024, 7);
        let sending = block.clone();
        let (go_tx, go) = mpsc::channel::<()>();
        thread::spawn(move || {
            if let Ok(mut s) = listener.accept() {
                if send_repeated(&mut s, &sending, part).is_ok() && go.recv_timeout(Duration::from_secs(60)).is_ok() {
                    let _ = send_repeated(&mut s, &sending, part);
                }
                // Dropped here: the stand-in closes the connection.
            }
        });

        let mut b = Bridge::start(&store_dir, sid);
        let until = Instant::now() + WAIT;
        while b.buf.len() < part {
            assert!(b.fill(until), "only {} of the first {part} bytes came through the bridge", b.buf.len());
        }
        let _ = go_tx.send(());
        let out = b.rest();
        let status = b.wait(WAIT);
        assert_eq!(out.len(), 2 * part, "standard output carried {} of {} bytes; the bridge exited {status}", out.len(), 2 * part);
        assert!(out.chunks(block.len()).all(|c| c == &block[..c.len()]), "what the holder sent did not reach standard output as it was");
        assert_eq!(status.code(), Some(0), "{status}");
    }

    /// Standard output that is never read: once more than `MAX_QUEUED` is
    /// waiting for it, the bridge ends the connection and exits 1, saying
    /// why, though the holder still holds the connection open.
    #[test]
    fn standard_output_not_read_past_the_bound_gets_exit_1() {
        let _serial = one_at_a_time();
        let store_dir = Folder::new("bound");
        let sid = "brdg-0010";
        let listener = Listener::bind(sid).expect("listen");
        write_record(&store_dir, sid, listener.endpoint(), std::process::id());
        let (release_tx, release) = mpsc::channel::<()>();
        thread::spawn(move || {
            if let Ok(mut s) = listener.accept() {
                // A write fails once the bridge has ended the connection.
                let _ = send_repeated(&mut s, &pattern(1024 * 1024, 7), MAX_QUEUED + 16 * 1024 * 1024);
                // Hold the connection open until the test is done.
                let _ = release.recv_timeout(Duration::from_secs(60));
            }
        });

        let mut child = Command::new(HELPER)
            .args(["bridge", "--store", &store_dir.arg(), "--session", sid])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start the bridge");
        // Standard input stays open, and standard output open and unread.
        let _stdin = child.stdin.take();
        let _stdout = child.stdout.take();
        let mut stderr = child.stderr.take().expect("its standard error");
        let said = thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            text
        });
        let status = exit_within(&mut child, WAIT);
        let said = said.join().unwrap_or_default();
        assert_eq!(status.code(), Some(1), "{status}: {said}");
        assert!(said.contains("more than 64 MiB behind the holder"), "standard error: {said:?}");
        let _ = release_tx.send(());
    }
}
