//! Session records (protocol section 15): one `<sid>.json` per holder in a
//! store folder the app names, so list mode can find every session this
//! user's holders hold, and tell a live one from one a crash left behind.
//!
//! A record is written whole to a temporary file and renamed over the old
//! one, so a reader never sees half of it. On Unix the store is 0700 and each
//! record 0600. The format carries its own version (`v`); a file that is not
//! a version 1 record is never removed by list mode, only counted as skipped.
//!
//! The store's lock file (`.lock`, never removed) is held, with the OS's own
//! file lock, while a holder checks for a live holder of its session and
//! writes its record, while list mode removes a stale record, and while a
//! holder removes its own. So two holders started for one session at the same
//! moment cannot both write a record, and list mode never removes a record
//! that a new holder put in place of the stale one it looked at.

use crate::hello::{valid_nonce, valid_sid};
use crate::json::{self, Value};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const RECORD_VERSION: u64 = 1;
pub const MAX_LABEL_CHARS: usize = 128;
pub const MAX_HELPER_VERSION_CHARS: usize = 64;
pub const DEFAULT_AWAY_SECS: u64 = 120;
pub const MAX_AWAY_SECS: u64 = 86_400;
/// What the first process is doing: not started, running, or gone.
pub const CHILD_STATES: [&str; 3] = ["waiting", "running", "exited"];
/// A temporary file older than this was left by a write that never finished.
const TMP_MAX_AGE: Duration = Duration::from_secs(60);
/// The store's lock file. Its name is not a record's, so list mode passes it by.
pub const LOCK_FILE: &str = ".lock";
/// How long to wait for the store's lock before giving up.
pub const LOCK_WAIT: Duration = Duration::from_secs(10);

const FIELDS: [&str; 12] = ["v", "session", "label", "pid", "endpoint", "nonce", "helper", "started", "away", "attached", "child", "code"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub session: String,
    pub label: String,
    /// The holder's process id.
    pub pid: u32,
    pub endpoint: String,
    /// What the holder's hello line must carry: proof the endpoint is its.
    pub nonce: String,
    /// The helper's version.
    pub helper: String,
    /// When the holder started, in milliseconds since 1970 (UTC).
    pub started: u64,
    /// The away clock, in seconds.
    pub away: u64,
    pub attached: bool,
    pub child: String,
    /// The first process's exit code, once `child` is `exited`.
    pub code: Option<i64>,
}

/// Up to 128 characters, none of them a control character.
pub fn valid_label(s: &str) -> bool {
    s.chars().count() <= MAX_LABEL_CHARS && !s.chars().any(char::is_control)
}

/// Milliseconds since 1970.
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Record {
    pub fn to_value(&self) -> Value {
        Value::obj(vec![
            ("v", Value::uint(RECORD_VERSION)),
            ("session", Value::str(&self.session)),
            ("label", Value::str(&self.label)),
            ("pid", Value::uint(u64::from(self.pid))),
            ("endpoint", Value::str(&self.endpoint)),
            ("nonce", Value::str(&self.nonce)),
            ("helper", Value::str(&self.helper)),
            ("started", Value::uint(self.started)),
            ("away", Value::uint(self.away)),
            ("attached", Value::Bool(self.attached)),
            ("child", Value::str(&self.child)),
            ("code", match self.code {
                Some(c) => Value::Num(c.to_string()),
                None => Value::Null,
            }),
        ])
    }

    pub fn to_json(&self) -> String {
        self.to_value().to_json()
    }

    /// Read a version 1 record strictly: every field present once, of its
    /// type and in its range, and nothing else.
    pub fn from_value(v: &Value) -> Result<Record, String> {
        let keys = v.keys().ok_or("not an object")?;
        if keys.len() != FIELDS.len() || FIELDS.iter().any(|f| keys.iter().filter(|k| *k == f).count() != 1) {
            return Err("the fields are not exactly the version 1 set".to_string());
        }
        if v.get("v").and_then(Value::as_u64) != Some(RECORD_VERSION) {
            return Err("not version 1".to_string());
        }
        let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string).ok_or(format!("{k} is not a string"));
        let session = text("session")?;
        if !valid_sid(&session) {
            return Err("session breaks its pattern".to_string());
        }
        let label = text("label")?;
        if !valid_label(&label) {
            return Err("label is over 128 characters or holds a control character".to_string());
        }
        let pid = match v.get("pid").and_then(Value::as_u64) {
            Some(p) if p >= 1 && p <= u64::from(u32::MAX) => p as u32,
            _ => return Err("pid is not a process id".to_string()),
        };
        let endpoint = text("endpoint")?;
        if !crate::transport::valid_endpoint(&endpoint, &session) {
            return Err("endpoint is not this session's pipe or socket name".to_string());
        }
        let nonce = text("nonce")?;
        if !valid_nonce(&nonce) {
            return Err("nonce is not 32 lower-case hex characters".to_string());
        }
        let helper = text("helper")?;
        if helper.is_empty() || helper.chars().count() > MAX_HELPER_VERSION_CHARS || helper.chars().any(char::is_control) {
            return Err("helper is not a version".to_string());
        }
        let started = match v.get("started").and_then(Value::as_u64) {
            Some(s) if s <= crate::request::MAX_SAFE_INTEGER => s,
            _ => return Err("started is not a time".to_string()),
        };
        let away = match v.get("away").and_then(Value::as_u64) {
            Some(a) if (1..=MAX_AWAY_SECS).contains(&a) => a,
            _ => return Err("away is not 1 to 86400 seconds".to_string()),
        };
        let attached = v.get("attached").and_then(Value::as_bool).ok_or("attached is not true or false")?;
        let child = text("child")?;
        if !CHILD_STATES.contains(&child.as_str()) {
            return Err("child is not waiting, running or exited".to_string());
        }
        let code = match v.get("code") {
            Some(Value::Null) if child != "exited" => None,
            Some(c) if child == "exited" => match c.as_i64() {
                Some(n) if n >= i64::from(i32::MIN) && n <= i64::from(u32::MAX) => Some(n),
                _ => return Err("code is not an exit code".to_string()),
            },
            _ => return Err("code must be null until the child exited, and a number after".to_string()),
        };
        Ok(Record { session, label, pid, endpoint, nonce, helper, started, away, attached, child, code })
    }
}

pub fn record_path(store: &Path, sid: &str) -> PathBuf {
    store.join(format!("{sid}.json"))
}

#[cfg(unix)]
#[allow(unsafe_code)]
fn euid() -> u32 {
    unsafe { libc::geteuid() }
}

/// Make the store folder if it is missing. On Unix it must be this user's,
/// and is set to 0700.
pub fn prepare(store: &Path) -> io::Result<()> {
    fs::create_dir_all(store)?;
    let md = fs::metadata(store)?;
    if !md.is_dir() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{} is not a folder", store.display())));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if md.uid() != euid() {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("{} belongs to another user", store.display())));
        }
        if md.mode() & 0o077 != 0 {
            fs::set_permissions(store, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

/// The store's lock, held until this is dropped.
pub struct StoreLock {
    file: fs::File,
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

/// Take the store's lock, waiting up to `LOCK_WAIT` for whoever has it.
pub fn lock(store: &Path) -> io::Result<StoreLock> {
    let mut opts = fs::OpenOptions::new();
    opts.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(store.join(LOCK_FILE))?;
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(StoreLock { file }),
            Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Err(fs::TryLockError::WouldBlock) => return Err(io::Error::new(io::ErrorKind::TimedOut, "the session store stayed locked")),
            Err(fs::TryLockError::Error(e)) => return Err(e),
        }
    }
}

/// True when `a` and `b` were written by the same holder.
fn same_holder(a: &Record, b: &Record) -> bool {
    a.pid == b.pid && a.nonce == b.nonce && a.endpoint == b.endpoint
}

/// Write `rec` whole: a temporary file first, then a rename over the old one.
pub fn write(store: &Path, rec: &Record) -> io::Result<()> {
    let path = record_path(store, &rec.session);
    let tmp = store.join(format!("{}.json.{}.tmp", rec.session, std::process::id()));
    let result = (|| -> io::Result<()> {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(rec.to_json().as_bytes())?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// The record of `sid`: None when there is none, `Some(Err)` when the file
/// is not a version 1 record.
pub fn read(store: &Path, sid: &str) -> Option<Result<Record, String>> {
    let bytes = match fs::read(record_path(store, sid)) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
        Err(e) => return Some(Err(e.to_string())),
    };
    Some(match json::parse(&bytes) {
        Ok(v) => Record::from_value(&v).and_then(|r| if r.session == sid { Ok(r) } else { Err("the record names another session".to_string()) }),
        Err(_) => Err("not JSON".to_string()),
    })
}

/// Remove the record of `sid` if it is still the one holder `pid` wrote. The
/// store's lock is taken when it can be; the record goes either way.
pub fn remove(store: &Path, sid: &str, pid: u32) {
    let _lock = lock(store).ok();
    if let Some(Ok(rec)) = read(store, sid) {
        if rec.pid == pid {
            let _ = fs::remove_file(record_path(store, sid));
        }
    }
}

/// What list mode learns by asking a record's endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    /// The holder answered with the record's nonce and session.
    Live,
    /// Nothing listens there, or something else answered: the record is stale.
    Gone,
    /// No clear answer (busy, slow): the record is kept and listed.
    Unknown,
}

/// What list mode prints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    pub sessions: Vec<Record>,
    /// Stale records removed by this listing.
    pub removed: u64,
    /// Files with a record's name that are not version 1 records, left alone.
    pub skipped: u64,
}

impl Listing {
    pub fn to_value(&self) -> Value {
        Value::obj(vec![
            ("v", Value::uint(RECORD_VERSION)),
            ("sessions", Value::Arr(self.sessions.iter().map(Record::to_value).collect())),
            ("removed", Value::uint(self.removed)),
            ("skipped", Value::uint(self.skipped)),
        ])
    }

    pub fn to_json(&self) -> String {
        self.to_value().to_json()
    }

    /// Read a listing strictly, as the app does.
    pub fn from_value(v: &Value) -> Result<Listing, String> {
        let keys = v.keys().ok_or("not an object")?;
        if keys != ["v", "sessions", "removed", "skipped"] {
            return Err("the fields are not v, sessions, removed, skipped in that order".to_string());
        }
        if v.get("v").and_then(Value::as_u64) != Some(RECORD_VERSION) {
            return Err("not version 1".to_string());
        }
        let items = v.get("sessions").and_then(Value::as_array).ok_or("sessions is not an array")?;
        let mut sessions = Vec::new();
        for item in items {
            sessions.push(Record::from_value(item)?);
        }
        let removed = v.get("removed").and_then(Value::as_u64).ok_or("removed is not a count")?;
        let skipped = v.get("skipped").and_then(Value::as_u64).ok_or("skipped is not a count")?;
        Ok(Listing { sessions, removed, skipped })
    }
}

/// `<sid>.json.<digits>.tmp`: the temporary file `write` makes.
fn is_tmp_name(name: &str) -> bool {
    let rest = match name.strip_suffix(".tmp") {
        Some(r) => r,
        None => return false,
    };
    match rest.rsplit_once(".json.") {
        Some((sid, digits)) => valid_sid(sid) && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// Every session in `store`. A record whose holder is gone (its process is
/// not running, or its endpoint has nothing on it or answers as someone
/// else) is removed with its socket file, under the store's lock and only if
/// the record is still the one found stale. Sessions are sorted by start
/// time, then session id. A missing store lists nothing and is not made.
pub fn list(store: &Path, probe: impl Fn(&Record) -> Probe) -> io::Result<Listing> {
    let mut listing = Listing { sessions: Vec::new(), removed: 0, skipped: 0 };
    let entries = match fs::read_dir(store) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(listing),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        if is_tmp_name(&name) {
            let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map_or(false, |age| age > TMP_MAX_AGE);
            if old {
                let _ = fs::remove_file(entry.path());
            }
            continue;
        }
        let sid = match name.strip_suffix(".json") {
            Some(s) if valid_sid(s) => s,
            _ => continue,
        };
        let rec = match read(store, sid) {
            None => continue,
            Some(Err(_)) => {
                listing.skipped += 1;
                continue;
            }
            Some(Ok(r)) => r,
        };
        let stale = !crate::pids::alive(rec.pid) || probe(&rec) == Probe::Gone;
        if !stale {
            listing.sessions.push(rec);
            continue;
        }
        // The probe took time without the lock; a holder started meanwhile
        // may have replaced the record. Look again under the lock.
        let _lock = match lock(store) {
            Ok(l) => l,
            // Busy for that long: leave it for the next listing.
            Err(_) => continue,
        };
        match read(store, sid) {
            Some(Ok(now)) if same_holder(&now, &rec) => {
                if fs::remove_file(record_path(store, sid)).is_ok() {
                    listing.removed += 1;
                }
                crate::transport::remove_stale_endpoint(&rec.endpoint);
            }
            // A new holder's record, written under the lock just now.
            Some(Ok(now)) => {
                if crate::pids::alive(now.pid) {
                    listing.sessions.push(now);
                }
            }
            Some(Err(_)) => listing.skipped += 1,
            None => {}
        }
    }
    listing.sessions.sort_by(|a, b| a.started.cmp(&b.started).then_with(|| a.session.cmp(&b.session)));
    Ok(listing)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn sample(sid: &str) -> Record {
        let random = &"0123456789abcdef0123456789abcdef"[..crate::transport::ENDPOINT_RANDOM_HEX];
        Record {
            session: sid.to_string(),
            label: "Terminal 1".to_string(),
            pid: std::process::id(),
            endpoint: crate::transport::endpoint_name(sid, random),
            nonce: "0123456789abcdef0123456789abcdef".to_string(),
            helper: "0.1.0".to_string(),
            started: 1_763_251_200_000,
            away: 120,
            attached: false,
            child: "running".to_string(),
            code: None,
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("aicc-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn a_record_round_trips_and_strict_reading_refuses_what_is_off() {
        let r = sample("store-0001");
        let back = Record::from_value(&json::parse(r.to_json().as_bytes()).unwrap()).unwrap();
        assert_eq!(back, r);
        let mut exited = r.clone();
        exited.child = "exited".to_string();
        exited.code = Some(-1073741510);
        assert_eq!(Record::from_value(&exited.to_value()).unwrap(), exited);
        for (what, change) in [
            ("v 2", r.to_json().replace("{\"v\":1,", "{\"v\":2,")),
            ("an extra field", r.to_json().replace("\"code\":null}", "\"code\":null,\"x\":1}")),
            ("a code while running", r.to_json().replace("\"code\":null", "\"code\":0")),
            ("a control character in the label", r.to_json().replace("Terminal 1", "Terminal\\u0007")),
            ("pid 0", r.to_json().replace(&format!("\"pid\":{}", r.pid), "\"pid\":0")),
            ("another session's endpoint", r.to_json().replace("\"session\":\"store-0001\"", "\"session\":\"store-0002\"")),
            ("an unknown child state", r.to_json().replace("\"running\"", "\"paused\"")),
        ] {
            let v = json::parse(change.as_bytes()).unwrap();
            assert!(Record::from_value(&v).is_err(), "{what}: {change}");
        }
        let mut no_code = exited.to_json();
        no_code = no_code.replace("\"code\":-1073741510", "\"code\":null");
        assert!(Record::from_value(&json::parse(no_code.as_bytes()).unwrap()).is_err(), "exited without a code");
    }

    #[test]
    fn write_read_and_remove_only_touch_our_own_record() {
        let store = scratch("rw");
        prepare(&store).unwrap();
        let r = sample("store-0002");
        write(&store, &r).unwrap();
        assert_eq!(read(&store, "store-0002"), Some(Ok(r.clone())));
        assert_eq!(read(&store, "store-0003"), None);
        remove(&store, "store-0002", r.pid + 1);
        assert!(read(&store, "store-0002").is_some(), "another holder's pid must not remove it");
        remove(&store, "store-0002", r.pid);
        assert_eq!(read(&store, "store-0002"), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            write(&store, &r).unwrap();
            assert_eq!(fs::metadata(record_path(&store, "store-0002")).unwrap().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(&store).unwrap().mode() & 0o777, 0o700);
        }
        fs::remove_dir_all(&store).unwrap();
    }

    #[test]
    fn list_keeps_live_records_removes_stale_ones_and_leaves_unknown_files() {
        let store = scratch("list");
        prepare(&store).unwrap();
        let mut live = sample("list-live-01");
        live.started = 2;
        let mut gone = sample("list-gone-01");
        gone.started = 1;
        let mut later = sample("list-live-00");
        later.started = 2;
        for r in [&live, &gone, &later] {
            write(&store, r).unwrap();
        }
        fs::write(record_path(&store, "list-other-1"), b"{\"v\":2}").unwrap();
        fs::write(store.join("notes.txt"), b"left alone").unwrap();
        let listing = list(&store, |r| if r.session == "list-gone-01" { Probe::Gone } else { Probe::Live }).unwrap();
        let names: Vec<&str> = listing.sessions.iter().map(|r| r.session.as_str()).collect();
        assert_eq!(names, vec!["list-live-00", "list-live-01"], "sorted by start, then id");
        assert_eq!((listing.removed, listing.skipped), (1, 1));
        assert!(read(&store, "list-gone-01").is_none());
        assert!(store.join("notes.txt").exists() && record_path(&store, "list-other-1").exists());
        let text = listing.to_json();
        assert_eq!(Listing::from_value(&json::parse(text.as_bytes()).unwrap()).unwrap(), listing);
        assert_eq!(list(&scratch("missing"), |_| Probe::Live).unwrap().sessions.len(), 0);
        assert!(!scratch("missing").exists(), "listing a missing store must not make it");
        fs::remove_dir_all(&store).unwrap();
    }

    #[test]
    fn a_dead_holder_is_stale_without_asking_its_endpoint() {
        let store = scratch("dead");
        prepare(&store).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("no-test-has-this-name-0002")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut dead = sample("list-dead-01");
        dead.pid = child.id();
        child.wait().unwrap();
        write(&store, &dead).unwrap();
        // The child is still held (on Windows its handle keeps the id from
        // being reused), so the record names a process that is not running.
        assert!(!crate::pids::alive(dead.pid));
        let listing = list(&store, |_| Probe::Gone).unwrap();
        assert_eq!((listing.sessions.len(), listing.removed), (0, 1));
        drop(child);
        fs::remove_dir_all(&store).unwrap();
    }

    #[test]
    fn list_never_removes_a_record_a_new_holder_wrote_while_the_old_one_was_probed() {
        let store = scratch("replaced");
        prepare(&store).unwrap();
        let old = sample("list-swap-01");
        write(&store, &old).unwrap();
        let mut new = sample("list-swap-01");
        new.nonce = "fedcba9876543210fedcba9876543210".to_string();
        new.started += 1;
        let listing = list(&store, |r| {
            assert_eq!(r, &old, "the probe is asked about the record it found");
            // A new holder replaces the record while the old one is asked.
            write(&store, &new).unwrap();
            Probe::Gone
        })
        .unwrap();
        assert_eq!(listing.removed, 0, "the new holder's record was removed as stale");
        assert_eq!(read(&store, "list-swap-01").expect("a record").expect("it reads"), new);
        assert_eq!(listing.sessions, vec![new.clone()], "the new holder is listed");
        fs::remove_dir_all(&store).unwrap();
    }

    #[test]
    fn the_store_lock_is_held_by_one_at_a_time() {
        let store = scratch("lock");
        prepare(&store).unwrap();
        let first = lock(&store).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let other = store.clone();
        std::thread::spawn(move || {
            let asked = Instant::now();
            let second = lock(&other);
            let _ = tx.send((second.is_ok(), asked.elapsed()));
        });
        std::thread::sleep(Duration::from_millis(400));
        drop(first);
        let (ok, waited) = rx.recv_timeout(LOCK_WAIT).expect("the second lock never came");
        assert!(ok, "the second lock failed");
        assert!(waited >= Duration::from_millis(300), "the second lock did not wait for the first: {waited:?}");
        fs::remove_dir_all(&store).unwrap();
    }

    #[test]
    fn temporary_names_are_recognised() {
        assert!(is_tmp_name("sess-0001.json.1234.tmp"));
        assert!(!is_tmp_name("sess-0001.json.tmp") && !is_tmp_name("x.json.12.tmp") && !is_tmp_name("sess-0001.json"));
    }
}
