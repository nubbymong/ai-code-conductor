//! The field mode (`aicc-helper field`, from 2.1.3-beta.19): one string from
//! a JSON file in the user's home folder, for the label of a helper tab (the
//! account its CLI runs as, aicc_planning#434). Which file and which key are
//! the provider package's (src/main/providers/), given on the command line:
//! nothing here names one.
//!
//! ```text
//! aicc-helper field --file <path under home> --key <dotted key>
//! ```
//!
//! It prints the string at that key and one line end, or nothing at all, and
//! exits 0 either way (2 on a command line it does not take, `main.rs`):
//!
//! - The path is relative to the home folder (`HOME`: an absolute path that
//!   is not `/`), or absolute inside it; every part a plain name (no empty
//!   part, no `.` or `..`).
//! - The file is opened as Claude Code opens it, a link followed (beta.18's
//!   home read does the same, src/main/remote-helper/scripts.ts ONE_READ),
//!   and must then be a regular file of this user's own of at most
//!   `MAX_FILE_BYTES` (5 MiB, the bound under which the usual SSH path reads
//!   the same file, src/main/providers/claude/statusline-gather.ts). A FIFO,
//!   a device or a folder in its place is never opened: the name is looked
//!   at first, then the file is opened without waiting and without becoming
//!   a controlling terminal, and the checks are made again on the file
//!   opened, which must be the one looked at.
//! - It must be JSON (`json.rs`: UTF-8, depth 32 at most). The key names
//!   object members from the top, separated by dots
//!   (`oauthAccount.emailAddress`): 1 to `MAX_KEY_PARTS` parts, none empty,
//!   `MAX_KEY_BYTES` at most, no control character. A member named twice on
//!   the way gives nothing.
//! - The value must be a string of 1 to `MAX_VALUE_BYTES` (1 KiB) of UTF-8
//!   with no control character.
//!
//! Nothing is written, run or sent, and the file is read once. On Windows the
//! mode prints nothing: the machines it serves are macOS and Linux.

use crate::json::Value;
use std::path::PathBuf;
#[cfg(unix)]
use std::path::Path;

/// The largest file read: 5 MiB.
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// The longest value printed, in bytes of UTF-8: 1 KiB.
pub const MAX_VALUE_BYTES: usize = 1024;
/// The most parts a key may have.
pub const MAX_KEY_PARTS: usize = 16;
/// The longest key, in bytes.
pub const MAX_KEY_BYTES: usize = 256;

/// The field mode on `--file` and `--key`: what it prints, without the line
/// end, or None for nothing.
pub fn run(file: &str, key: &str) -> Option<String> {
    #[cfg(unix)]
    {
        let home = std::env::var("HOME").ok()?;
        let path = path_under(&home, file)?;
        read_field(&path, key, crate::store::euid())
    }
    #[cfg(not(unix))]
    {
        let _ = (file, key);
        None
    }
}

/// The file `file` names under `home`, or None when it is not a path under
/// home: `home` an absolute path other than `/`, `file` relative to it or
/// absolute inside it, every part of either a plain name.
pub fn path_under(home: &str, file: &str) -> Option<PathBuf> {
    let home = home.strip_suffix('/').unwrap_or(home);
    if !plain_parts(home.strip_prefix('/')?) {
        return None;
    }
    let rel = if file.starts_with('/') { file.strip_prefix(home)?.strip_prefix('/')? } else { file };
    if !plain_parts(rel) {
        return None;
    }
    Some(PathBuf::from(format!("{home}/{rel}")))
}

/// One or more parts separated by single slashes, none of them empty, `.`
/// or `..`, and no NUL character.
fn plain_parts(s: &str) -> bool {
    !s.is_empty() && s.split('/').all(|p| !p.is_empty() && p != "." && p != ".." && !p.contains('\0'))
}

/// The string at `key` in `doc`, as the field mode prints it: None for a key
/// that breaks its rules, a member missing or named twice on the way, or a
/// value that is not a string of 1 to 1 KiB with no control character.
pub fn value_at(doc: &Value, key: &str) -> Option<String> {
    if key.is_empty() || key.len() > MAX_KEY_BYTES || key.chars().any(char::is_control) {
        return None;
    }
    let parts: Vec<&str> = key.split('.').collect();
    if parts.len() > MAX_KEY_PARTS || parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    let mut at = doc;
    for part in &parts {
        let members = match at {
            Value::Obj(members) => members,
            _ => return None,
        };
        let mut named = members.iter().filter(|(k, _)| k.as_str() == *part);
        let (_, v) = named.next()?;
        if named.next().is_some() {
            return None;
        }
        at = v;
    }
    match at {
        Value::Str(s) if !s.is_empty() && s.len() <= MAX_VALUE_BYTES && !s.chars().any(char::is_control) => Some(s.clone()),
        _ => None,
    }
}

/// The string at `key` in the JSON file at `path`, links followed, from a
/// regular file of the user `me` of at most `MAX_FILE_BYTES`; None for
/// anything else. The field mode gives its own user id; a test gives
/// another to stand in for another user's file.
#[cfg(unix)]
pub fn read_field(path: &Path, key: &str, me: u32) -> Option<String> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    // By its name first, a link followed: anything but a regular file is
    // never opened.
    let named = std::fs::metadata(path).ok()?;
    if !named.is_file() {
        return None;
    }
    let file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY).open(path).ok()?;
    // Then the file opened, which must be the one looked at: what the name
    // names may have changed in between.
    let md = file.metadata().ok()?;
    if !md.is_file() || (md.dev(), md.ino()) != (named.dev(), named.ino()) || md.uid() != me || md.len() > MAX_FILE_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).ok()?;
    // A file that grew past the bound since it was looked at.
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return None;
    }
    value_at(&crate::json::parse(&bytes).ok()?, key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    #[test]
    fn the_bounds_are_5_mib_1_kib_16_parts_and_256_bytes() {
        assert_eq!(MAX_FILE_BYTES, 5_242_880);
        assert_eq!(MAX_VALUE_BYTES, 1024);
        assert_eq!((MAX_KEY_PARTS, MAX_KEY_BYTES), (16, 256));
    }

    #[test]
    fn a_path_under_home_is_relative_to_it_or_absolute_inside_it_with_plain_parts_only() {
        assert_eq!(path_under("/home/u", ".claude.json"), Some(PathBuf::from("/home/u/.claude.json")));
        assert_eq!(path_under("/home/u/", "/home/u/.claude.json"), Some(PathBuf::from("/home/u/.claude.json")));
        assert_eq!(path_under("/home/u", ".config/x/settings.json"), Some(PathBuf::from("/home/u/.config/x/settings.json")));
        for (home, file) in [
            ("/home/u", "../v/.claude.json"),
            ("/home/u", "a/../../etc/passwd"),
            ("/home/u", "./.claude.json"),
            ("/home/u", "a/./b"),
            ("/home/u", "a//b"),
            ("/home/u", "a/"),
            ("/home/u", ""),
            ("/home/u", "/etc/passwd"),
            ("/home/u", "/home/user2/.claude.json"),
            ("/home/u", "/home/u"),
            ("/home/u", "/home/u/"),
            ("/home/u", "/home/u/../v/x"),
            ("/home/u", "a\0b"),
            ("/", ".claude.json"),
            ("", ".claude.json"),
            ("home/u", ".claude.json"),
            ("/home/../u", ".claude.json"),
        ] {
            assert_eq!(path_under(home, file), None, "home {home:?}, file {file:?}");
        }
    }

    #[test]
    fn the_value_is_one_string_of_at_most_1_kib_with_no_control_character() {
        let doc = |t: &str| json::parse(t.as_bytes()).expect("JSON");
        let d = doc(r#"{"oauthAccount":{"emailAddress":"a@b.c","n":1,"o":{},"e":"","c":"a\u0007b","t":"a\tb"},"top":"t","dup":{"x":"1"},"dup":{"x":"2"},"list":["a"]}"#);
        assert_eq!(value_at(&d, "oauthAccount.emailAddress"), Some("a@b.c".to_string()));
        assert_eq!(value_at(&d, "top"), Some("t".to_string()));
        for key in [
            "oauthAccount.missing",
            "missing",
            "oauthAccount.n",
            "oauthAccount.o",
            "oauthAccount",
            "oauthAccount.e",
            "oauthAccount.c",
            "oauthAccount.t",
            "top.x",
            "dup.x",
            "list",
            "list.0",
            "",
            ".top",
            "top.",
            "oauthAccount..emailAddress",
            "top\u{7}",
        ] {
            assert_eq!(value_at(&d, key), None, "key {key:?}");
        }
        let edge = "x".repeat(MAX_VALUE_BYTES);
        let d = doc(&format!("{{\"k\":\"{edge}\",\"over\":\"{edge}x\",\"wide\":\"{}\"}}", "\u{e9}".repeat(MAX_VALUE_BYTES / 2 + 1)));
        assert_eq!(value_at(&d, "k"), Some(edge));
        assert_eq!(value_at(&d, "over"), None, "a value over 1 KiB");
        assert_eq!(value_at(&d, "wide"), None, "1 KiB counts bytes, not characters");
        // A key of more parts or bytes than its bounds is no key.
        let nested = format!("{}\"v\"{}", "{\"k\":".repeat(MAX_KEY_PARTS + 1), "}".repeat(MAX_KEY_PARTS + 1));
        let d = doc(&nested);
        assert_eq!(value_at(&d, &vec!["k"; MAX_KEY_PARTS].join(".")), None, "16 parts reach an object, not the string");
        assert_eq!(value_at(&d, &vec!["k"; MAX_KEY_PARTS + 1].join(".")), None, "a key of 17 parts");
        assert_eq!(value_at(&doc("{\"k\":\"v\"}"), &"k".repeat(MAX_KEY_BYTES + 1)), None, "a key over 256 bytes");
    }

    /// A folder of this test, its mode set outright: the lib tests share
    /// one process and its umask.
    #[cfg(unix)]
    fn folder(name: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = std::env::temp_dir().join(format!("aicc-field-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("a folder");
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700)).expect("its mode");
        p
    }

    #[cfg(unix)]
    #[allow(unsafe_code)]
    fn mkfifo(path: &Path) {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).expect("a path with no NUL");
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo {}", path.display());
    }

    /// The file: a regular one of the user's own of at most 5 MiB, a link
    /// followed; another user's (this test's own, read as if by another
    /// user id), a folder, a FIFO (never opened, so nothing waits for a
    /// writer), a device and a file past the bound give nothing.
    #[cfg(unix)]
    #[test]
    fn only_a_regular_file_of_the_users_own_of_at_most_5_mib_is_read() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        use std::time::{Duration, Instant};
        let dir = folder("read");
        let me = crate::store::euid();
        let key = "oauthAccount.emailAddress";
        let file = dir.join("account.json");
        std::fs::write(&file, br#"{"oauthAccount":{"emailAddress":"a@b.c"}}"#).expect("write");
        assert_eq!(read_field(&file, key, me), Some("a@b.c".to_string()));
        assert_eq!(read_field(&file, key, me.wrapping_add(1)), None, "another user's file was read");
        let link = dir.join("link.json");
        symlink(&file, &link).expect("a link");
        assert_eq!(read_field(&link, key, me), Some("a@b.c".to_string()), "a link was not followed");
        assert_eq!(read_field(&link, key, me.wrapping_add(1)), None, "a link to another user's file was read");
        let sub = dir.join("sub");
        std::fs::create_dir(&sub).expect("a folder");
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o700)).expect("its mode");
        assert_eq!(read_field(&sub, key, me), None, "a folder");
        let fifo = dir.join("fifo");
        mkfifo(&fifo);
        let asked = Instant::now();
        assert_eq!(read_field(&fifo, key, me), None, "a FIFO");
        assert!(asked.elapsed() < Duration::from_secs(2), "a FIFO held the read up for {:?}", asked.elapsed());
        assert_eq!(read_field(Path::new("/dev/null"), key, me), None, "a device");
        assert_eq!(read_field(&dir.join("missing.json"), key, me), None, "a file that is not there");
        let text = dir.join("text.json");
        std::fs::write(&text, b"not JSON").expect("write");
        assert_eq!(read_field(&text, key, me), None, "a file that is not JSON");
        // Exactly 5 MiB is read; one byte more is not.
        let big = dir.join("big.json");
        let head = r#"{"oauthAccount":{"emailAddress":"a@b.c"},"pad":""#;
        let pad = MAX_FILE_BYTES as usize - head.len() - 2;
        std::fs::write(&big, format!("{head}{}\"}}", "x".repeat(pad))).expect("write");
        assert_eq!(std::fs::metadata(&big).expect("its size").len(), MAX_FILE_BYTES);
        assert_eq!(read_field(&big, key, me), Some("a@b.c".to_string()), "a file of exactly 5 MiB");
        std::fs::write(&big, format!("{head}{}\"}}", "x".repeat(pad + 1))).expect("write");
        assert_eq!(read_field(&big, key, me), None, "a file over 5 MiB");
        std::fs::remove_dir_all(&dir).expect("clean up");
    }
}
