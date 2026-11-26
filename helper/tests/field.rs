//! The field mode (`aicc-helper field --file <path under home> --key <dotted
//! key>`, from 2.1.3-beta.19) as a program, the way the app runs it on a
//! remote machine for a helper tab's account (aicc_planning#434): the string
//! at the key of a JSON file in the home folder it is given (`HOME`) and one
//! line end, or nothing at all, and exit 0 whatever the file holds; exit 2 on
//! a command line it does not take. Nothing ever goes to standard error on
//! exit 0. On Windows it prints nothing.

use std::fs;
use std::path::PathBuf;
#[cfg(unix)]
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
const KEY: &str = "oauthAccount.emailAddress";

/// A new, empty folder of this test, its mode set outright on Unix, removed
/// when dropped.
struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Folder {
        let dir = std::env::temp_dir().join(format!("aicc-field-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a folder");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).expect("its mode");
        }
        Folder(dir)
    }

    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, bytes).expect("write a file");
        path
    }

    /// A folder in this one, its mode set outright.
    #[cfg(unix)]
    fn dir(&self, name: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = self.0.join(name);
        fs::create_dir(&path).expect("a folder");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("its mode");
        path
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

type Ran = (Option<i32>, String, String);

/// Run the field mode on `args`, with `HOME` set to `home` (unset for None),
/// and give up after 10 s: its exit code, standard output and error.
fn field(home: Option<&str>, args: &[&str]) -> Ran {
    let mut command = Command::new(HELPER);
    command.arg("field").args(args).env_remove("HOME").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(home) = home {
        command.env("HOME", home);
    }
    let mut child = command.spawn().expect("run the field mode");
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().expect("look at the field mode").is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the field mode on {args:?} still ran after 10 s");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let out = child.wait_with_output().expect("its output");
    (out.status.code(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

#[cfg(unix)]
fn in_home(home: &Folder, file: &str) -> Ran {
    field(Some(home.0.to_str().expect("a Unicode path")), &["--file", file, "--key", KEY])
}

/// Printed the value and one line end, nothing else, and exited 0.
#[cfg(unix)]
fn printed(ran: Ran, value: &str, what: &str) {
    assert_eq!(ran, (Some(0), format!("{value}\n"), String::new()), "{what}");
}

/// Printed nothing at all, and exited 0.
fn nothing(ran: Ran, what: &str) {
    assert_eq!(ran, (Some(0), String::new(), String::new()), "{what}");
}

const ACCOUNT: &[u8] = br#"{"numStartups":3,"oauthAccount":{"accountUuid":"u","emailAddress":"a@b.c"},"projects":{"/home/u/p":{"allowedTools":[]}}}"#;

#[cfg(unix)]
#[test]
fn the_string_at_the_key_is_printed_from_a_path_relative_to_home_or_absolute_inside_it() {
    let home = Folder::new("value");
    let file = home.file(".claude.json", ACCOUNT);
    printed(in_home(&home, ".claude.json"), "a@b.c", "a path relative to home");
    printed(in_home(&home, file.to_str().expect("a Unicode path")), "a@b.c", "an absolute path inside home");
    home.dir("sub");
    home.file("sub/account.json", ACCOUNT);
    printed(in_home(&home, "sub/account.json"), "a@b.c", "a file in a folder in home");
    printed(field(Some(home.0.to_str().expect("a Unicode path")), &["--file", ".claude.json", "--key", "oauthAccount.accountUuid"]), "u", "another key");
    // The provider package names the key: none is compiled in.
    nothing(field(Some(home.0.to_str().expect("a Unicode path")), &["--file", ".claude.json", "--key", "numStartups"]), "a number is not a string");
}

#[cfg(unix)]
#[test]
fn a_link_is_followed_as_claude_code_follows_it() {
    use std::os::unix::fs::symlink;
    let home = Folder::new("link");
    home.dir("dotfiles");
    let real = home.file("dotfiles/claude.json", ACCOUNT);
    symlink(&real, home.0.join(".claude.json")).expect("a link");
    printed(in_home(&home, ".claude.json"), "a@b.c", "a dotfiles link");
}

#[cfg(unix)]
#[test]
fn anything_but_the_string_prints_nothing_and_exits_0() {
    let home = Folder::new("nothing");
    let home_arg = home.0.to_str().expect("a Unicode path").to_string();
    home.file(".claude.json", ACCOUNT);
    nothing(field(Some(home_arg.as_str()), &["--file", ".claude.json", "--key", "oauthAccount.missing"]), "a missing key");
    nothing(field(Some(home_arg.as_str()), &["--file", ".claude.json", "--key", "oauthAccount"]), "an object");
    nothing(in_home(&home, "missing.json"), "a file that is not there");
    home.file("text.json", b"oauthAccount.emailAddress = a@b.c");
    nothing(in_home(&home, "text.json"), "a file that is not JSON");
    home.file("long.json", format!("{{\"oauthAccount\":{{\"emailAddress\":\"{}\"}}}}", "x".repeat(1025)).as_bytes());
    nothing(in_home(&home, "long.json"), "a value over 1 KiB");
    home.file("edge.json", format!("{{\"oauthAccount\":{{\"emailAddress\":\"{}\"}}}}", "x".repeat(1024)).as_bytes());
    printed(in_home(&home, "edge.json"), &"x".repeat(1024), "a value of exactly 1 KiB");
    home.file("bell.json", br#"{"oauthAccount":{"emailAddress":"a@b.c\u0007"}}"#);
    nothing(in_home(&home, "bell.json"), "a value with a control character");
    // At most 5 MiB.
    let head = br#"{"oauthAccount":{"emailAddress":"a@b.c"},"pad":""#;
    let pad = 5 * 1024 * 1024 - head.len() - 2;
    let mut big = head.to_vec();
    big.extend(std::iter::repeat(b'x').take(pad + 1));
    big.extend_from_slice(b"\"}");
    home.file("big.json", &big);
    nothing(in_home(&home, "big.json"), "a file over 5 MiB");
    // Only a path under home.
    nothing(in_home(&home, "../outside.json"), "a path out of home");
    nothing(in_home(&home, "/etc/hosts"), "an absolute path outside home");
    nothing(in_home(&home, "./.claude.json"), "a path with a . part");
    nothing(field(None, &["--file", ".claude.json", "--key", KEY]), "no HOME");
    nothing(field(Some("/"), &["--file", &format!("{}/.claude.json", home_arg.trim_start_matches('/')), "--key", KEY]), "HOME is /");
    nothing(field(Some("relative/home"), &["--file", ".claude.json", "--key", KEY]), "a HOME that is not absolute");
}

#[cfg(unix)]
#[allow(unsafe_code)]
fn mkfifo(path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).expect("a path with no NUL");
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo {}", path.display());
}

/// Not a regular file of the user's own: another user's file (a link to
/// /etc/hosts, which root owns), a folder, a device and a FIFO, which is
/// never opened, so nothing waits for a writer.
#[cfg(unix)]
#[test]
fn another_users_file_and_anything_but_a_regular_file_print_nothing_and_exit_0() {
    use std::os::unix::fs::{symlink, MetadataExt};
    let home = Folder::new("special");
    let mine = fs::metadata(&home.0).expect("the home folder").uid();
    let hosts = fs::metadata("/etc/hosts").expect("/etc/hosts");
    if hosts.uid() != mine {
        symlink("/etc/hosts", home.0.join("hosts.json")).expect("a link");
        nothing(in_home(&home, "hosts.json"), "another user's file");
    }
    home.dir("folder.json");
    nothing(in_home(&home, "folder.json"), "a folder");
    symlink("/dev/null", home.0.join("device.json")).expect("a link");
    nothing(in_home(&home, "device.json"), "a device");
    mkfifo(&home.0.join("fifo.json"));
    let asked = Instant::now();
    nothing(in_home(&home, "fifo.json"), "a FIFO");
    assert!(asked.elapsed() < Duration::from_secs(5), "a FIFO held the field mode up for {:?}", asked.elapsed());
}

#[test]
fn a_command_line_it_does_not_take_exits_2_and_prints_nothing_on_standard_output() {
    for args in [vec!["--file", ".claude.json"], vec!["--key", KEY], vec!["--file", "a", "--key", "b", "--file", "c"], vec!["--file", "a", "--key", "b", "--other", "c"], vec!["--file"]] {
        let (code, stdout, stderr) = field(Some("/tmp"), &args);
        assert_eq!(code, Some(2), "{args:?}: {stderr}");
        assert!(stdout.is_empty(), "{args:?}: {stdout}");
        assert!(stderr.contains("aicc-helper:"), "{args:?}: {stderr}");
    }
}

#[cfg(windows)]
#[test]
fn on_windows_the_field_mode_prints_nothing_and_exits_0() {
    let home = Folder::new("windows");
    home.file(".claude.json", ACCOUNT);
    nothing(field(Some(home.0.to_str().expect("a Unicode path")), &["--file", ".claude.json", "--key", KEY]), "Windows");
}
