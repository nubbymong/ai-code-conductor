//! The field mode (`aicc-helper field --file <path under home> --key <dotted
//! key>`, from 2.1.3-beta.19) as a program, the way the app runs it on a
//! remote machine for a helper tab's account (aicc_planning#434): the string
//! at the key of a JSON file in the home folder it is given (`HOME`) and one
//! line end, or nothing at all, and exit 0 whatever the file holds; exit 2 on
//! a command line it does not take. Nothing ever goes to standard error on
//! exit 0. On Windows it prints nothing. From 2.1.3-beta.20 (section 3.1.2)
//! `--keys` prints one JSON object of several keys of the file, and every key
//! must be on the field mode's list: a sign-in's secrets never are.

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
    // The provider package names the key, from the field mode's list
    // (2.1.3-beta.20): a key off it is a command line it does not take.
    refused(field(Some(home.0.to_str().expect("a Unicode path")), &["--file", ".claude.json", "--key", "oauthAccount.accountUuid"]), "a key off the list");
    refused(field(Some(home.0.to_str().expect("a Unicode path")), &["--file", ".claude.json", "--key", "numStartups"]), "a key off the list");
}

/// Exited 2, printed nothing on standard output, and said why on standard error.
fn refused(ran: Ran, what: &str) {
    let (code, stdout, stderr) = ran;
    assert_eq!(code, Some(2), "{what}: {stderr}");
    assert!(stdout.is_empty(), "{what}: {stdout}");
    assert!(stderr.contains("aicc-helper:"), "{what}: {stderr}");
}

const CREDENTIALS: &[u8] = br#"{"claudeAiOauth":{"accessToken":"secret-access","refreshToken":"secret-refresh","expiresAt":1764000000000,"scopes":["user:inference"],"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}"#;

/// 2.1.3-beta.20 section 3.1.2: a sign-in's secrets are never read, by
/// `--key` or `--keys`, in any case, beside a key on the list or alone; nor
/// is any key off the list. Nothing is read: standard output stays empty
/// even with a file that holds them.
#[test]
fn secret_keys_and_keys_off_the_list_exit_2_and_print_nothing() {
    let home = Folder::new("secret");
    let home_arg = home.0.to_str().expect("a Unicode path").to_string();
    home.file(".credentials.json", CREDENTIALS);
    for key in ["claudeAiOauth.accessToken", "claudeAiOauth.refreshToken", "claudeAiOauth.AccessToken", "claudeAiOauth.REFRESHTOKEN", "claudeAiOauth.scopes", "claudeAiOauth"] {
        let both = format!("claudeAiOauth.subscriptionType,{key}");
        refused(field(Some(home_arg.as_str()), &["--file", ".credentials.json", "--key", key]), key);
        refused(field(Some(home_arg.as_str()), &["--file", ".credentials.json", "--keys", key]), key);
        refused(field(Some(home_arg.as_str()), &["--file", ".credentials.json", "--keys", both.as_str()]), key);
    }
    let nine = vec!["claudeAiOauth.expiresAt"; 9].join(",");
    for keys in ["", ",", "claudeAiOauth.expiresAt,", "claudeAiOauth.expiresAt,claudeAiOauth.expiresAt", nine.as_str()] {
        refused(field(Some(home_arg.as_str()), &["--file", ".credentials.json", "--keys", keys]), keys);
    }
    refused(field(Some(home_arg.as_str()), &["--file", ".credentials.json", "--key", KEY, "--keys", KEY]), "--key and --keys together");
}

/// `--keys`: one JSON object and one line end, each key found in the order
/// given, strings as `--key` takes them and integers of 0 to 2^53 - 1;
/// `{}` for a file that holds none of them.
#[cfg(unix)]
#[test]
fn several_keys_print_one_object_of_strings_and_integers() {
    let home = Folder::new("keys");
    let home_arg = home.0.to_str().expect("a Unicode path").to_string();
    home.dir(".claude");
    home.file(".claude/.credentials.json", CREDENTIALS);
    let ran = field(Some(home_arg.as_str()), &["--file", ".claude/.credentials.json", "--keys", "claudeAiOauth.subscriptionType,claudeAiOauth.rateLimitTier,claudeAiOauth.expiresAt"]);
    assert!(!ran.1.contains("secret"), "{}", ran.1);
    assert_eq!(
        ran,
        (Some(0), "{\"claudeAiOauth.subscriptionType\":\"max\",\"claudeAiOauth.rateLimitTier\":\"default_claude_max_20x\",\"claudeAiOauth.expiresAt\":1764000000000}\n".to_string(), String::new()),
        "the plan, tier and expiry"
    );
    home.file(".claude.json", ACCOUNT);
    assert_eq!(
        field(Some(home_arg.as_str()), &["--file", ".claude.json", "--keys", "oauthAccount.emailAddress,claudeAiOauth.expiresAt"]),
        (Some(0), "{\"oauthAccount.emailAddress\":\"a@b.c\"}\n".to_string(), String::new()),
        "a key the file does not hold is left out"
    );
    home.file("empty.json", b"{\"claudeAiOauth\":{}}");
    assert_eq!(field(Some(home_arg.as_str()), &["--file", "empty.json", "--keys", "claudeAiOauth.expiresAt"]), (Some(0), "{}\n".to_string(), String::new()), "none of the keys");
    home.file("odd.json", br#"{"claudeAiOauth":{"expiresAt":9007199254740992,"subscriptionType":7,"rateLimitTier":"a\"b"}}"#);
    assert_eq!(
        field(Some(home_arg.as_str()), &["--file", "odd.json", "--keys", "claudeAiOauth.expiresAt,claudeAiOauth.subscriptionType,claudeAiOauth.rateLimitTier"]),
        (Some(0), "{\"claudeAiOauth.subscriptionType\":7,\"claudeAiOauth.rateLimitTier\":\"a\\\"b\"}\n".to_string(), String::new()),
        "an integer past 2^53 - 1 is left out; a quote is escaped"
    );
}

/// `--keys` reads its file as `--key` does: a missing file, another user's,
/// or anything but a regular file prints nothing at all (not `{}`).
#[cfg(unix)]
#[test]
fn several_keys_of_a_missing_or_another_users_file_print_nothing() {
    use std::os::unix::fs::{symlink, MetadataExt};
    let home = Folder::new("keys-nothing");
    let home_arg = home.0.to_str().expect("a Unicode path").to_string();
    let keys = "oauthAccount.emailAddress,claudeAiOauth.expiresAt";
    nothing(field(Some(home_arg.as_str()), &["--file", ".claude.json", "--keys", keys]), "a file that is not there");
    let mine = fs::metadata(&home.0).expect("the home folder").uid();
    if fs::metadata("/etc/hosts").expect("/etc/hosts").uid() != mine {
        symlink("/etc/hosts", home.0.join("hosts.json")).expect("a link");
        nothing(field(Some(home_arg.as_str()), &["--file", "hosts.json", "--keys", keys]), "another user's file");
    }
    home.dir("folder.json");
    nothing(field(Some(home_arg.as_str()), &["--file", "folder.json", "--keys", keys]), "a folder");
    home.file("text.json", b"not JSON");
    nothing(field(Some(home_arg.as_str()), &["--file", "text.json", "--keys", keys]), "a file that is not JSON");
    nothing(field(Some(home_arg.as_str()), &["--file", "../outside.json", "--keys", keys]), "a path out of home");
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
    home.file("no-email.json", br#"{"oauthAccount":{"accountUuid":"u"}}"#);
    nothing(in_home(&home, "no-email.json"), "a missing key");
    home.file("object.json", br#"{"oauthAccount":{"emailAddress":{"a":"b"}}}"#);
    nothing(in_home(&home, "object.json"), "an object");
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
    nothing(field(Some(home.0.to_str().expect("a Unicode path")), &["--file", ".claude.json", "--keys", KEY]), "Windows, several keys");
}
