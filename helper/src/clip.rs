//! The clip mode (`aicc-helper clip`, from 2.1.3-beta.21; ADR-032; the
//! clipboard stand-in of docs/remote/helper-protocol.md section 15): the
//! picture this computer sent a remote helper tab (`file.put`, into the
//! session's `paste/` folder), served to the CLI's own clipboard paste on the
//! host. Claude Code on Linux reads a picture by running `xclip` or
//! `wl-paste`, which it finds by `PATH`. For a launch that asks for the
//! stand-in, the app's `files` fixed script (src/main/remote-helper/scripts.ts)
//! writes two scripts of two lines into `sessions/<sid>/bin/` (the folder and
//! each script 0700), and the launch puts that folder first on `PATH`:
//!
//! ```text
//! #!/bin/sh
//! exec '<helper>' clip --store '<store>' --session '<sid>' --as <name> [--real '<path>'] -- "$@"
//! ```
//!
//! A link alone could not name the session: the CLI runs it by `PATH` as
//! `xclip`, and `/proc/self/exe` is the helper binary.
//!
//! ```text
//! aicc-helper clip --store <folder> --session <sid> --as xclip|wl-paste [--real <path>] -- [args...]
//! ```
//!
//! Each option is given once, `--` ends them, and what follows is the tool's
//! own arguments, as given (they may not be Unicode). `--store` is an absolute
//! path of plain names whose folder is not `/`; `--session` matches the
//! session id pattern, so no path part reaches a folder name; `--real`, the
//! real tool of that name as the fixed script found it, is an absolute path of
//! plain names outside the session's `bin/` folder (by its names, and by its
//! real path when both are there). Anything else is a command line the mode
//! does not take: exit 2, nothing read and nothing started.
//!
//! The mode reads only `sessions/<sid>/paste/` beside the store
//! (`<store>/../sessions/<sid>/paste`, taken by the store's own parent, never
//! through `..`): the store's parent, `sessions`, the session's folder and
//! `paste` must each be a real folder of this user's own, mode 0700, never a
//! link. The current picture is the file there named `paste-<n>.png` or
//! `paste-<n>.jpg` (`<n>` 1 to 9 digits, no leading zero) of the highest
//! `<n>`; two names sharing it are no current picture. It must be a regular
//! file of this user's own of 1 byte to 20 MiB, opened without following a
//! link and without waiting, the one looked at, and begin with its type's
//! signature (PNG's eight bytes, JPEG's `FF D8 FF`): a file of text under that
//! name is no picture. Its type, `image/png` or `image/jpeg`, comes from its
//! name.
//!
//! It answers only the shapes Claude Code sends (probe PR1 records them):
//!
//! - as `xclip`: `-selection clipboard`, `-o` and `-t TARGETS`, in any order,
//!   each once: it prints the current picture's type and a line end;
//! - as `xclip`: `-selection clipboard`, `-o` and `-t <type>`: a read;
//! - as `wl-paste`: `--list-types` (or `-l`) alone: it prints the type and a
//!   line end;
//! - as `wl-paste`: `--type <type>` (or `-t <type>`), with or without
//!   `--no-newline` (or `-n`), each once: a read.
//!
//! A read of the current picture's type writes its bytes. With no current
//! picture a list, and a read of `image/png` or `image/jpeg`, print nothing
//! and exit 1. Any other use (another shape, a read of another type, a text
//! read, a write to the clipboard) goes to the real tool: its `--real` path is
//! started by `execve`, with no search of `PATH`, the arguments after `--` as
//! given and the environment unchanged, and its exit status is the tool's.
//! With no `--real` it prints nothing and exits 1. The mode never serves text,
//! never reads another session's folder or any other file, and never touches a
//! display or the host's clipboard itself; it starts no process but the real
//! tool, writes nothing and opens no connection. On Windows it does not run:
//! a command line it takes exits 1; one it does not take exits 2.

use crate::hello;
pub use crate::paste::Kind;
use crate::paste::picture_name;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;

/// The largest picture served: 20 MiB, `file.put`'s bound for one picture.
pub const MAX_PICTURE_BYTES: u64 = 20 * 1024 * 1024;
/// The most names the `paste/` folder may hold for a current picture to be
/// found there: `file.put` keeps one picture and at most one upload.
pub const MAX_PASTE_ENTRIES: usize = 1024;
/// The exit status with nothing printed: no current picture, no real tool, or
/// a picture that could not be written out.
pub const EXIT_NOTHING: u8 = 1;
/// The exit status of a command line the mode does not take.
pub const EXIT_USAGE: u8 = 2;

const CLIP_USAGE: &str = "usage: aicc-helper clip --store <folder> --session <sid> --as xclip|wl-paste [--real <path>] -- [args...]";

/// The tool the stand-in runs as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Xclip,
    WlPaste,
}

impl Tool {
    /// The tool of that name, or None.
    pub fn named(name: &str) -> Option<Tool> {
        match name {
            "xclip" => Some(Tool::Xclip),
            "wl-paste" => Some(Tool::WlPaste),
            _ => None,
        }
    }
}

/// What the tool's arguments ask for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ask {
    /// The types on the clipboard.
    List,
    /// The clipboard's content of this type.
    Read(String),
    /// Anything else: the real tool's.
    Other,
}

/// What `args`, the tool's own arguments, ask of `tool`: only the shapes the
/// module comment lists are a list or a read; an argument that is not Unicode
/// makes any of them another use.
pub fn ask(tool: Tool, args: &[OsString]) -> Ask {
    let mut words: Vec<&str> = Vec::with_capacity(args.len());
    for a in args {
        match a.to_str() {
            Some(w) => words.push(w),
            None => return Ask::Other,
        }
    }
    match tool {
        Tool::Xclip => xclip_ask(&words),
        Tool::WlPaste => wl_paste_ask(&words),
    }
}

fn xclip_ask(words: &[&str]) -> Ask {
    let mut selection = false;
    let mut out = false;
    let mut target: Option<&str> = None;
    let mut i = 0;
    while i < words.len() {
        match words[i] {
            "-selection" if !selection => {
                if words.get(i + 1).copied() != Some("clipboard") {
                    return Ask::Other;
                }
                selection = true;
                i += 2;
            }
            "-o" if !out => {
                out = true;
                i += 1;
            }
            "-t" if target.is_none() => {
                match words.get(i + 1).copied() {
                    Some(t) => target = Some(t),
                    None => return Ask::Other,
                }
                i += 2;
            }
            _ => return Ask::Other,
        }
    }
    match (selection, out, target) {
        (true, true, Some("TARGETS")) => Ask::List,
        (true, true, Some(t)) => Ask::Read(t.to_string()),
        _ => Ask::Other,
    }
}

fn wl_paste_ask(words: &[&str]) -> Ask {
    if words.len() == 1 && (words[0] == "--list-types" || words[0] == "-l") {
        return Ask::List;
    }
    let mut no_newline = false;
    let mut target: Option<&str> = None;
    let mut i = 0;
    while i < words.len() {
        match words[i] {
            "--no-newline" | "-n" if !no_newline => {
                no_newline = true;
                i += 1;
            }
            "--type" | "-t" if target.is_none() => {
                match words.get(i + 1).copied() {
                    Some(t) => target = Some(t),
                    None => return Ask::Other,
                }
                i += 2;
            }
            _ => return Ask::Other,
        }
    }
    match target {
        Some(t) => Ask::Read(t.to_string()),
        None => Ask::Other,
    }
}

/// The mode's command line, as taken.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Options {
    pub store: PathBuf,
    pub sid: String,
    pub tool: Tool,
    pub real: Option<PathBuf>,
    /// The tool's own arguments, after `--`.
    pub args: Vec<OsString>,
}

/// An absolute path of plain names: the root, then one or more names, none of
/// them `..` (a `.` is no name: the path's parts drop it).
pub fn plain_absolute(p: &Path) -> bool {
    let mut parts = p.components();
    if parts.next() != Some(Component::RootDir) {
        return false;
    }
    let mut names = 0;
    for part in parts {
        match part {
            Component::Normal(_) => names += 1,
            _ => return false,
        }
    }
    names > 0
}

/// The session's own folder beside `store`: `<store's parent>/sessions/<sid>`.
pub fn session_folder(store: &Path, sid: &str) -> Option<PathBuf> {
    Some(store.parent()?.join("sessions").join(sid))
}

/// The mode's command line (the arguments after `clip`), or why it is not
/// one the mode takes.
pub fn parse(raw: &[OsString]) -> Result<Options, String> {
    let mut store: Option<PathBuf> = None;
    let mut sid: Option<String> = None;
    let mut tool: Option<Tool> = None;
    let mut real: Option<PathBuf> = None;
    let mut i = 0;
    let rest = loop {
        let word = match raw.get(i) {
            None => return Err("clip needs -- before the tool's arguments".to_string()),
            Some(a) => match a.to_str() {
                Some(w) => w,
                None => return Err("clip takes Unicode option names only".to_string()),
            },
        };
        if word == "--" {
            break i + 1;
        }
        let value = match raw.get(i + 1) {
            Some(v) => v,
            None => return Err(format!("{word} needs a value")),
        };
        match word {
            "--store" if store.is_none() => store = Some(PathBuf::from(value)),
            "--session" if sid.is_none() => match value.to_str() {
                Some(s) if hello::valid_sid(s) => sid = Some(s.to_string()),
                _ => return Err("--session breaks the session id pattern".to_string()),
            },
            "--as" if tool.is_none() => match value.to_str().and_then(Tool::named) {
                Some(t) => tool = Some(t),
                None => return Err("--as is xclip or wl-paste".to_string()),
            },
            "--real" if real.is_none() => real = Some(PathBuf::from(value)),
            "--store" | "--session" | "--as" | "--real" => return Err(format!("{word} is given twice")),
            _ => return Err(format!("unknown option {word}")),
        }
        i += 2;
    };
    let store = match store {
        Some(s) => s,
        None => return Err("clip needs --store".to_string()),
    };
    let under_root = store.parent().map_or(true, |p| p == Path::new("/"));
    if !plain_absolute(&store) || under_root {
        return Err("--store is not an absolute path of plain names below a folder of its own".to_string());
    }
    let sid = match sid {
        Some(s) => s,
        None => return Err("clip needs --session".to_string()),
    };
    let tool = match tool {
        Some(t) => t,
        None => return Err("clip needs --as".to_string()),
    };
    if let Some(r) = &real {
        if !plain_absolute(r) {
            return Err("--real is not an absolute path of plain names".to_string());
        }
        let bin = match session_folder(&store, &sid) {
            Some(folder) => folder.join("bin"),
            None => return Err("clip needs --store".to_string()),
        };
        if r.starts_with(&bin) || real_path_inside(r, &bin) {
            return Err("--real lies inside the session's bin folder".to_string());
        }
    }
    Ok(Options { store, sid, tool, real, args: raw[rest..].to_vec() })
}

/// `path`'s real path lies inside `folder`'s, when both are there to read.
fn real_path_inside(path: &Path, folder: &Path) -> bool {
    match (std::fs::canonicalize(path), std::fs::canonicalize(folder)) {
        (Ok(p), Ok(f)) => p.starts_with(&f),
        _ => false,
    }
}

/// The stand-in's run, from the arguments after `clip`.
pub fn command(raw: &[OsString]) -> ExitCode {
    match parse(raw) {
        Ok(o) => ExitCode::from(run(&o)),
        Err(why) => {
            let _ = writeln!(std::io::stderr(), "aicc-helper: {why}\n{CLIP_USAGE}");
            ExitCode::from(EXIT_USAGE)
        }
    }
}

/// One answer, as the module comment says: its exit status, or the real
/// tool's, which it then is.
#[cfg(unix)]
pub fn run(o: &Options) -> u8 {
    let me = crate::store::euid();
    match ask(o.tool, &o.args) {
        Ask::List => match current_picture(&o.store, &o.sid, me) {
            Some((kind, _)) => write_out(format!("{}\n", kind.mime()).as_bytes()),
            None => EXIT_NOTHING,
        },
        // A read of a type the stand-in never serves is the real tool's,
        // and reads nothing here.
        Ask::Read(t) => match Kind::of_mime(&t) {
            None => to_real(o),
            Some(asked) => match current_picture(&o.store, &o.sid, me) {
                Some((kind, bytes)) if kind == asked => write_out(&bytes),
                Some(_) => to_real(o),
                None => EXIT_NOTHING,
            },
        },
        Ask::Other => to_real(o),
    }
}

/// On Windows the mode does not run.
#[cfg(not(unix))]
pub fn run(_o: &Options) -> u8 {
    let _ = writeln!(std::io::stderr(), "aicc-helper: clip runs on macOS and Linux only");
    EXIT_NOTHING
}

/// `bytes` on standard output: 0 once all of it is written, else 1.
#[cfg(unix)]
fn write_out(bytes: &[u8]) -> u8 {
    let mut out = std::io::stdout().lock();
    if out.write_all(bytes).is_err() || out.flush().is_err() {
        return EXIT_NOTHING;
    }
    0
}

/// The real tool, started in this process's place by its absolute path with
/// the tool's arguments as given; 1 when there is none or it cannot start.
#[cfg(unix)]
fn to_real(o: &Options) -> u8 {
    use std::os::unix::process::CommandExt;
    let real = match &o.real {
        Some(r) => r,
        None => return EXIT_NOTHING,
    };
    let err = std::process::Command::new(real).args(&o.args).exec();
    let _ = writeln!(std::io::stderr(), "aicc-helper: clip: {} could not be started: {err}", real.display());
    EXIT_NOTHING
}

/// The current picture's name among `names`, with its type: the picture name
/// (`paste::picture_name`, the one rule `file.put` takes names by) of the
/// highest number; None when there is none, or two share it.
pub fn newest<'a, I: IntoIterator<Item = &'a str>>(names: I) -> Option<(&'a str, Kind)> {
    let mut best: Option<(u32, &'a str, Kind)> = None;
    let mut tie = false;
    for name in names {
        let (n, kind) = match picture_name(name) {
            Some(p) => p,
            None => continue,
        };
        match best {
            Some((m, _, _)) if n < m => {}
            Some((m, _, _)) if n == m => tie = true,
            _ => {
                best = Some((n, name, kind));
                tie = false;
            }
        }
    }
    if tie {
        None
    } else {
        best.map(|(_, name, kind)| (name, kind))
    }
}

/// The current picture of session `sid` beside `store`, read as the module
/// comment says, for the user `me`: its type and its bytes, or None. The mode
/// gives its own user id; a test gives another to stand in for another
/// user's folder or file.
#[cfg(unix)]
pub fn current_picture(store: &Path, sid: &str, me: u32) -> Option<(Kind, Vec<u8>)> {
    let paste = paste_folder(store, sid, me)?;
    let mut names: Vec<String> = Vec::new();
    for (count, entry) in std::fs::read_dir(&paste).ok()?.enumerate() {
        if count >= MAX_PASTE_ENTRIES {
            return None;
        }
        if let Ok(name) = entry.ok()?.file_name().into_string() {
            names.push(name);
        }
    }
    let (name, kind) = newest(names.iter().map(String::as_str))?;
    read_picture(&paste.join(name), kind, me)
}

/// `sessions/<sid>/paste` beside `store`, when it and every folder from the
/// store's parent down to it is a real folder of `me`'s own, mode 0700.
#[cfg(unix)]
fn paste_folder(store: &Path, sid: &str, me: u32) -> Option<PathBuf> {
    if !hello::valid_sid(sid) {
        return None;
    }
    let device = store.parent()?;
    let sessions = device.join("sessions");
    let session = sessions.join(sid);
    let paste = session.join("paste");
    let way = [device, sessions.as_path(), session.as_path(), paste.as_path()];
    if way.iter().all(|folder| private_folder(folder, me)) {
        Some(paste)
    } else {
        None
    }
}

/// A real folder (never a link) of `me`'s own, mode 0700.
#[cfg(unix)]
fn private_folder(p: &Path, me: u32) -> bool {
    use std::os::unix::fs::MetadataExt;
    match std::fs::symlink_metadata(p) {
        Ok(md) => md.file_type().is_dir() && md.uid() == me && (md.mode() & 0o777) == 0o700,
        Err(_) => false,
    }
}

/// The picture at `path` of type `kind`: a regular file of `me`'s own of 1
/// byte to `MAX_PICTURE_BYTES`, never a link, opened without waiting and
/// without becoming a controlling terminal, the one looked at, beginning with
/// its type's signature.
#[cfg(unix)]
fn read_picture(path: &Path, kind: Kind, me: u32) -> Option<(Kind, Vec<u8>)> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let named = std::fs::symlink_metadata(path).ok()?;
    if !named.file_type().is_file() || named.uid() != me || named.len() == 0 || named.len() > MAX_PICTURE_BYTES {
        return None;
    }
    let file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY).open(path).ok()?;
    let md = file.metadata().ok()?;
    if !md.file_type().is_file() || (md.dev(), md.ino()) != (named.dev(), named.ino()) || md.uid() != me || md.len() > MAX_PICTURE_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_PICTURE_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_PICTURE_BYTES || !bytes.starts_with(kind.signature()) {
        return None;
    }
    Some((kind, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(words: &[&str]) -> Vec<OsString> {
        words.iter().map(|w| OsString::from(*w)).collect()
    }

    #[test]
    fn the_bounds_are_20_mib_and_1024_names() {
        assert_eq!(MAX_PICTURE_BYTES, 20_971_520);
        assert_eq!(MAX_PASTE_ENTRIES, 1024);
        assert_eq!((EXIT_NOTHING, EXIT_USAGE), (1, 2));
    }

    #[test]
    fn xclip_answers_only_claude_codes_list_and_read_in_any_order() {
        let x = |w: &[&str]| ask(Tool::Xclip, &os(w));
        for list in [
            &["-selection", "clipboard", "-o", "-t", "TARGETS"][..],
            &["-selection", "clipboard", "-t", "TARGETS", "-o"][..],
            &["-o", "-t", "TARGETS", "-selection", "clipboard"][..],
            &["-t", "TARGETS", "-o", "-selection", "clipboard"][..],
        ] {
            assert_eq!(x(list), Ask::List, "{list:?}");
        }
        assert_eq!(x(&["-selection", "clipboard", "-t", "image/png", "-o"]), Ask::Read("image/png".to_string()));
        assert_eq!(x(&["-o", "-selection", "clipboard", "-t", "image/jpeg"]), Ask::Read("image/jpeg".to_string()));
        // A text read names a text type or none: never a list, and a read of
        // its own type the run sends to the real tool.
        assert_eq!(x(&["-selection", "clipboard", "-o", "-t", "UTF8_STRING"]), Ask::Read("UTF8_STRING".to_string()));
        for other in [
            &[][..],
            &["-selection", "clipboard", "-o"][..],
            &["-o", "-t", "TARGETS"][..],
            &["-selection", "clipboard", "-t", "TARGETS"][..],
            &["-selection", "primary", "-o", "-t", "TARGETS"][..],
            &["-selection", "clip", "-o", "-t", "TARGETS"][..],
            &["-selection"][..],
            &["-selection", "clipboard", "-o", "-t"][..],
            &["-selection", "clipboard", "-o", "-o", "-t", "TARGETS"][..],
            &["-selection", "clipboard", "-selection", "clipboard", "-o", "-t", "TARGETS"][..],
            &["-selection", "clipboard", "-o", "-t", "TARGETS", "-t", "image/png"][..],
            &["-selection", "clipboard", "-i"][..],
            &["-selection", "clipboard", "-i", "-t", "image/png"][..],
            &["-selection", "clipboard", "-o", "-t", "TARGETS", "-verbose"][..],
            &["-sel", "clip", "-o", "-t", "TARGETS"][..],
            &["-out", "-selection", "clipboard", "-t", "TARGETS"][..],
        ] {
            assert_eq!(x(other), Ask::Other, "{other:?}");
        }
    }

    #[test]
    fn wl_paste_answers_only_a_list_alone_and_a_typed_read() {
        let w = |words: &[&str]| ask(Tool::WlPaste, &os(words));
        assert_eq!(w(&["--list-types"]), Ask::List);
        assert_eq!(w(&["-l"]), Ask::List);
        for (words, t) in [
            (&["--type", "image/png"][..], "image/png"),
            (&["-t", "image/png"][..], "image/png"),
            (&["--type", "image/jpeg", "--no-newline"][..], "image/jpeg"),
            (&["-n", "-t", "image/png"][..], "image/png"),
            (&["--no-newline", "--type", "text/plain"][..], "text/plain"),
        ] {
            assert_eq!(w(words), Ask::Read(t.to_string()), "{words:?}");
        }
        for other in [
            &[][..],
            &["-n"][..],
            &["--no-newline"][..],
            &["--list-types", "-n"][..],
            &["-l", "-l"][..],
            &["--type"][..],
            &["--type", "image/png", "-t", "image/png"][..],
            &["-n", "-n", "-t", "image/png"][..],
            &["--primary", "--type", "image/png"][..],
            &["-p", "-t", "image/png"][..],
            &["--watch", "cat"][..],
            &["--type=image/png"][..],
        ] {
            assert_eq!(w(other), Ask::Other, "{other:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_argument_that_is_not_unicode_is_another_use() {
        use std::os::unix::ffi::OsStringExt;
        let mut args = os(&["-selection", "clipboard", "-o", "-t"]);
        args.push(OsString::from_vec(vec![0x66, 0xff]));
        assert_eq!(ask(Tool::Xclip, &args), Ask::Other);
        assert_eq!(ask(Tool::WlPaste, &[OsString::from("-t"), OsString::from_vec(vec![0xff])]), Ask::Other);
    }

    // The name rule itself, picture_name, is tested where it lives
    // (paste.rs, a_picture_name_is_paste_a_number_and_png_or_jpg), with
    // every name this file's own test of it took or refused.

    #[test]
    fn the_current_picture_is_the_highest_number_and_a_tie_is_none() {
        assert_eq!(newest(["paste-2.png", "paste-10.jpg", "paste-9.png"]), Some(("paste-10.jpg", Kind::Jpeg)), "numbers, not letters");
        assert_eq!(newest(["paste-3.png", ".part-4", "notes.txt", "paste-04.png"]), Some(("paste-3.png", Kind::Png)));
        assert_eq!(newest(["paste-3.png", "paste-3.jpg"]), None, "two pictures share the number");
        assert_eq!(newest(["paste-3.png", "paste-3.jpg", "paste-5.png"]), Some(("paste-5.png", Kind::Png)), "a tie below the highest is no tie");
        assert_eq!(newest(["paste-5.png", "paste-3.png", "paste-3.jpg"]), Some(("paste-5.png", Kind::Png)));
        assert_eq!(newest(Vec::<&str>::new()), None);
        assert_eq!(newest([".part-1", "paste-0.png"]), None);
    }

    fn raw(words: &[&str]) -> Vec<OsString> {
        os(words)
    }

    const SID: &str = "rm0123456789abcdef0123456789abcd";

    #[test]
    fn the_command_line_is_each_option_once_then_dashes_then_the_tools_own() {
        let o = parse(&raw(&["--store", "/home/u/.aicc/d/store", "--session", SID, "--as", "xclip", "--real", "/usr/bin/xclip", "--", "-selection", "clipboard", "-o"])).expect("taken");
        assert_eq!(o.store, PathBuf::from("/home/u/.aicc/d/store"));
        assert_eq!(o.sid, SID);
        assert_eq!(o.tool, Tool::Xclip);
        assert_eq!(o.real, Some(PathBuf::from("/usr/bin/xclip")));
        assert_eq!(o.args, raw(&["-selection", "clipboard", "-o"]));
        let o = parse(&raw(&["--as", "wl-paste", "--session", SID, "--store", "/s/store", "--"])).expect("taken");
        assert_eq!((o.tool, o.real, o.args.len()), (Tool::WlPaste, None, 0));
        // What follows -- is the tool's, options of the mode's own included.
        let o = parse(&raw(&["--store", "/s/store", "--session", SID, "--as", "xclip", "--", "--real", "/x", "--"])).expect("taken");
        assert_eq!((o.real, o.args), (None, raw(&["--real", "/x", "--"])));
    }

    const OK: [&str; 6] = ["--store", "/s/store", "--session", SID, "--as", "xclip"];

    /// The command line OK, then `extra`, as the mode takes it.
    fn with(extra: &[&str]) -> Result<Options, String> {
        let mut w: Vec<&str> = OK.to_vec();
        w.extend_from_slice(extra);
        parse(&raw(&w))
    }

    #[test]
    fn a_command_line_it_does_not_take_is_refused() {
        assert!(with(&["--"]).is_ok());
        for (words, what) in [
            (&OK[..], "no --"),
            (&["--store", "/s/store", "--session", SID, "--"][..], "no --as"),
            (&["--store", "/s/store", "--as", "xclip", "--"][..], "no --session"),
            (&["--session", SID, "--as", "xclip", "--"][..], "no --store"),
            (&["--store", "/s/store", "--session", SID, "--as", "xclip", "--store", "/t/store", "--"][..], "--store twice"),
            (&["--store", "/s/store", "--session", SID, "--as", "xclip", "--as", "xclip", "--"][..], "--as twice"),
            (&["--store", "/s/store", "--session", SID, "--as", "xclip", "--real", "/a", "--real", "/b", "--"][..], "--real twice"),
            (&["--store", "/s/store", "--session", SID, "--session", SID, "--as", "xclip", "--"][..], "--session twice"),
            (&["--store", "/s/store", "--session", SID, "--as", "xsel", "--"][..], "another tool"),
            (&["--store", "/s/store", "--session", SID, "--as", "xclip", "--other", "x", "--"][..], "an unknown option"),
            (&["--store", "/s/store", "--session", SID, "--as", "xclip", "--real"][..], "a value missing"),
        ] {
            assert!(parse(&raw(words)).is_err(), "{what}");
        }
        for store in ["store", "./store", "/store", "/", "/a/../store", "/a/store/..", ""] {
            assert!(parse(&raw(&["--store", store, "--session", SID, "--as", "xclip", "--"])).is_err(), "--store {store:?}");
        }
        // The session id pattern: no path part reaches a folder name.
        for sid in ["../rmother000000", "rm0123456789/../x", "rm01234", "rm0123456789abcdef0123456789abcdef0", ".rm0123456789", "rm012345678 9", ""] {
            assert!(parse(&raw(&["--store", "/s/store", "--session", sid, "--as", "xclip", "--"])).is_err(), "--session {sid:?}");
        }
        // The real tool: absolute, plain, and never in the session's own bin/.
        for real in ["xclip", "bin/xclip", "./xclip", "/usr/../usr/bin/xclip", ""] {
            assert!(with(&["--real", real, "--"]).is_err(), "--real {real:?}");
        }
        let bin = format!("/s/sessions/{SID}/bin");
        for real in [format!("{bin}/xclip"), format!("{bin}/wl-paste"), bin.clone(), format!("{bin}/x/y")] {
            assert!(with(&["--real", real.as_str(), "--"]).is_err(), "--real {real:?} lies in bin/");
        }
        let like = format!("/s/sessions/{SID}/binx/xclip");
        assert!(with(&["--real", like.as_str(), "--"]).is_ok(), "a folder named like bin is not bin");
        assert!(with(&["--real", "/s/sessions/rmanother00000000/bin/xclip", "--"]).is_ok(), "another session's bin is not this one's");
    }

    #[cfg(unix)]
    #[test]
    fn an_option_that_is_not_unicode_is_refused_and_a_store_that_is_not_is_taken() {
        use std::os::unix::ffi::OsStringExt;
        let mut words = raw(&["--store", "/s/store", "--session", SID, "--as", "xclip"]);
        words.push(OsString::from_vec(vec![0x2d, 0x2d, 0xff]));
        words.push(OsString::from("x"));
        words.push(OsString::from("--"));
        assert!(parse(&words).is_err());
        let store = OsString::from_vec(b"/home/\xffu/.aicc/d/store".to_vec());
        let words = vec![OsString::from("--store"), store.clone(), OsString::from("--session"), OsString::from(SID), OsString::from("--as"), OsString::from("xclip"), OsString::from("--")];
        assert_eq!(parse(&words).expect("taken").store, PathBuf::from(store));
    }

    /// A folder of this test, `mode` set outright, never left to the umask.
    ///
    /// The lib tests share one process and its umask, and a socket bind
    /// beside them sets it to 0177 around each bind (transport/unix.rs,
    /// `bind_private`), and two binds that overlap can leave it there for the
    /// rest of the run. A level `create_dir_all` made while it was 0177 was
    /// 0600, with no search bit, so the next level could not be made inside it
    /// ("Permission denied", seen on the macOS runner). So each missing level
    /// is made on its own and set to 0700 before the next is made in it.
    #[cfg(unix)]
    fn folder(at: &Path, mode: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let missing: Vec<&Path> = at.ancestors().take_while(|p| matches!(std::fs::symlink_metadata(p), Err(e) if e.kind() == std::io::ErrorKind::NotFound)).collect();
        for level in missing.iter().rev() {
            std::fs::create_dir(level).expect("a folder");
            std::fs::set_permissions(level, std::fs::Permissions::from_mode(0o700)).expect("its mode");
        }
        std::fs::set_permissions(at, std::fs::Permissions::from_mode(mode)).expect("its mode");
        at.to_path_buf()
    }

    #[cfg(unix)]
    fn png(tail: &[u8]) -> Vec<u8> {
        let mut b = Kind::Png.signature().to_vec();
        b.extend_from_slice(tail);
        b
    }

    /// Another user's folder or file (this test's own, read as if by another
    /// user id) is never read; nor is one open to others, or a link.
    #[cfg(unix)]
    #[test]
    fn only_folders_and_a_file_of_the_users_own_are_read() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = std::env::temp_dir().join(format!("aicc-clip-unit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let device = folder(&root.join("device"), 0o700);
        let store = device.join("store");
        let paste = folder(&device.join("sessions").join(SID).join("paste"), 0o700);
        folder(&device.join("sessions"), 0o700);
        folder(&device.join("sessions").join(SID), 0o700);
        let me = crate::store::euid();
        std::fs::write(paste.join("paste-1.png"), png(b"one")).expect("write");
        assert_eq!(current_picture(&store, SID, me), Some((Kind::Png, png(b"one"))));
        assert_eq!(current_picture(&store, SID, me.wrapping_add(1)), None, "another user's folders were read");
        // Each folder on the way, open to its group: nothing.
        for f in [device.clone(), device.join("sessions"), device.join("sessions").join(SID), paste.clone()] {
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o750)).expect("its mode");
            assert_eq!(current_picture(&store, SID, me), None, "{} open to its group", f.display());
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o700)).expect("its mode");
        }
        assert_eq!(current_picture(&store, SID, me), Some((Kind::Png, png(b"one"))));
        // The picture a link: nothing, even to a picture of the user's own.
        std::fs::remove_file(paste.join("paste-1.png")).expect("remove");
        std::fs::write(root.join("elsewhere.png"), png(b"elsewhere")).expect("write");
        symlink(root.join("elsewhere.png"), paste.join("paste-2.png")).expect("a link");
        assert_eq!(current_picture(&store, SID, me), None, "a link was followed");
        std::fs::remove_file(paste.join("paste-2.png")).expect("remove");
        // A session id that breaks its pattern reads nothing.
        assert_eq!(current_picture(&store, "../x", me), None);
        std::fs::remove_dir_all(&root).expect("clean up");
    }
}
