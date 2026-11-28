//! The clip mode (`aicc-helper clip`, from 2.1.3-beta.21; ADR-032), the
//! clipboard stand-in, as a remote session's CLI reaches it: through the
//! two-line sh script the `files` fixed script writes under each name into the
//! session's `bin/` folder (docs/remote/helper-protocol.md section 15), run by
//! its name with `bin/` first on `PATH`, as Claude Code runs `xclip` and
//! `wl-paste`. The test lays out a device folder as the scripts do, with the
//! session's `paste/` folder `file.put` fills, a real tool of each name that
//! says it ran (its path, a variable and its arguments) and exits 7, and a
//! decoy of each name further on `PATH` that the stand-in must never start.
//!
//! The 2.1.3-beta.21 plan's mutants each have a test that only they turn red:
//! a read outside `paste/`, the real tool found through `PATH`, text served,
//! another session's picture served.
//!
//! On Windows the mode does not run: it exits 1.

use std::process::{Command, Stdio};

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
const SID: &str = "rm0123456789abcdef0123456789abcd";

#[cfg(windows)]
#[test]
fn the_clip_mode_does_not_run_on_windows_and_exits_1() {
    let out = Command::new(HELPER)
        .args(["clip", "--store", "/s/store", "--session", SID, "--as", "xclip", "--", "-selection", "clipboard", "-o", "-t", "TARGETS"])
        .stdin(Stdio::null())
        .output()
        .expect("run the helper");
    assert_eq!(out.status.code(), Some(1), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(out.stdout.is_empty(), "printed on standard output");
    // A command line it does not take is a usage error there too.
    let out = Command::new(HELPER).args(["clip", "--as", "xsel", "--"]).stdin(Stdio::null()).output().expect("run the helper");
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty(), "printed on standard output");
}

#[cfg(unix)]
mod on_unix {
    use super::{Command, Stdio, HELPER, SID};
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::time::Duration;

    /// Another session on the same device.
    const OTHER: &str = "rmfedcba9876543210fedcba98765432";
    const LIST_X: &[&str] = &["-selection", "clipboard", "-o", "-t", "TARGETS"];
    const READ_X_PNG: &[&str] = &["-selection", "clipboard", "-t", "image/png", "-o"];
    const MIB: usize = 1024 * 1024;

    type Ran = (Option<i32>, Vec<u8>, String);

    fn png(body: &[u8]) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
        b.extend_from_slice(body);
        b
    }

    fn jpeg(body: &[u8]) -> Vec<u8> {
        let mut b = b"\xff\xd8\xff".to_vec();
        b.extend_from_slice(body);
        b
    }

    /// A folder, its mode set outright (the tests share one umask).
    fn dir(p: &Path, mode: u32) -> PathBuf {
        fs::create_dir_all(p).expect("a folder");
        fs::set_permissions(p, fs::Permissions::from_mode(mode)).expect("its mode");
        p.to_path_buf()
    }

    /// A script only its owner may run, as the files script writes them.
    fn script(p: &Path, text: &str) {
        fs::write(p, text).expect("write a script");
        fs::set_permissions(p, fs::Permissions::from_mode(0o700)).expect("its mode");
    }

    /// One session's folders.
    struct Session {
        folder: PathBuf,
        paste: PathBuf,
        bin: PathBuf,
    }

    /// One machine's device folder as the scripts lay it out (`store` is
    /// never made: the mode reads only beside it), in a folder of this test
    /// removed when dropped; and the real tools and the decoys.
    struct Device {
        root: PathBuf,
        device: PathBuf,
        store: PathBuf,
        tools: PathBuf,
        decoys: PathBuf,
        marker: PathBuf,
    }

    impl Device {
        fn new(name: &str) -> Device {
            let root = std::env::temp_dir().join(format!("aicc-clip-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            dir(&root, 0o700);
            let device = dir(&root.join("device"), 0o700);
            dir(&device.join("sessions"), 0o700);
            let tools = dir(&root.join("tools"), 0o700);
            let decoys = dir(&root.join("decoys"), 0o700);
            let marker = root.join("decoy-ran");
            for name in ["xclip", "wl-paste"] {
                script(
                    &tools.join(name),
                    "#!/bin/sh\nprintf 'REAL %s %s' \"$0\" \"${AICC_CLIP_TEST:-unset}\"\nfor a in \"$@\"; do printf ' [%s]' \"$a\"; done\nprintf '\\n'\nexit 7\n",
                );
                script(&decoys.join(name), &format!("#!/bin/sh\necho decoy > '{}'\nexit 9\n", marker.display()));
            }
            Device { store: device.join("store"), root, device, tools, decoys, marker }
        }

        /// A session's folder with its `paste/` and `bin/` folders, and in
        /// `bin/` the two scripts in the protocol's two-line form, `--real`
        /// naming this test's real tool of that name (or left out).
        fn session(&self, sid: &str, real: bool) -> Session {
            let folder = dir(&self.device.join("sessions").join(sid), 0o700);
            let paste = dir(&folder.join("paste"), 0o700);
            let bin = dir(&folder.join("bin"), 0o700);
            for name in ["xclip", "wl-paste"] {
                let real_part = if real { format!(" --real '{}'", self.tools.join(name).display()) } else { String::new() };
                script(
                    &bin.join(name),
                    &format!("#!/bin/sh\nexec '{HELPER}' clip --store '{}' --session '{sid}' --as {name}{real_part} -- \"$@\"\n", self.store.display()),
                );
            }
            Session { folder, paste, bin }
        }

        /// `program` with `args`, with only `PATH` and one variable of the
        /// test's own set, from the test's folder, given up after 20 s:
        /// its exit code, standard output and standard error.
        fn exec(&self, program: &Path, path: &str, args: &[&str]) -> Ran {
            let child = Command::new(program)
                .args(args)
                .env_clear()
                .env("PATH", path)
                .env("AICC_CLIP_TEST", "kept")
                .current_dir(&self.root)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("start it");
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(child.wait_with_output());
            });
            let out = rx
                .recv_timeout(Duration::from_secs(20))
                .unwrap_or_else(|_| panic!("{} {args:?} still ran after 20 s", program.display()))
                .expect("its output");
            (out.status.code(), out.stdout, String::from_utf8_lossy(&out.stderr).into_owned())
        }

        /// `tool` run by its name as Claude Code runs it: found on `PATH`,
        /// the session's `bin/` first, then the decoys.
        fn run(&self, s: &Session, tool: &str, args: &[&str]) -> Ran {
            let path = format!("{}:{}:/usr/bin:/bin", s.bin.display(), self.decoys.display());
            self.exec(Path::new(tool), &path, args)
        }

        /// The helper's clip mode run directly, with the decoys on `PATH`.
        fn clip(&self, args: &[&str]) -> Ran {
            let path = format!("{}:/usr/bin:/bin", self.decoys.display());
            let mut all = vec!["clip"];
            all.extend_from_slice(args);
            self.exec(Path::new(HELPER), &path, &all)
        }

        fn store_arg(&self) -> String {
            self.store.to_str().expect("a Unicode path").to_string()
        }

        /// The real tool ran, as itself, with the environment unchanged and
        /// the arguments as given.
        fn real_ran(&self, ran: Ran, tool: &str, args: &[&str], what: &str) {
            let mut line = format!("REAL {} kept", self.tools.join(tool).display());
            for a in args {
                line.push_str(&format!(" [{a}]"));
            }
            line.push('\n');
            assert_eq!((ran.0, String::from_utf8_lossy(&ran.1).into_owned()), (Some(7), line), "{what}: {}", ran.2);
            self.no_decoy(what);
        }

        fn no_decoy(&self, what: &str) {
            assert!(!self.marker.exists(), "{what}: a tool found through PATH ran");
        }
    }

    impl Drop for Device {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    /// Exit 0, exactly these bytes, nothing on standard error.
    fn served(ran: Ran, bytes: &[u8], what: &str) {
        assert_eq!(ran.0, Some(0), "{what}: {}", ran.2);
        assert!(ran.1 == bytes, "{what}: {} bytes out, {} expected", ran.1.len(), bytes.len());
        assert_eq!(ran.2, "", "{what}");
    }

    /// Exit 1 and nothing at all on standard output.
    fn nothing(ran: Ran, what: &str) {
        assert_eq!(ran.0, Some(1), "{what}: {}", ran.2);
        assert!(ran.1.is_empty(), "{what}: printed {:?}", String::from_utf8_lossy(&ran.1));
    }

    /// Exit 2, nothing on standard output, and why on standard error.
    fn refused(ran: Ran, what: &str) {
        assert_eq!(ran.0, Some(2), "{what}: {}", ran.2);
        assert!(ran.1.is_empty(), "{what}: printed {:?}", String::from_utf8_lossy(&ran.1));
        assert!(ran.2.contains("aicc-helper:"), "{what}: {}", ran.2);
    }

    fn names(folder: &Path) -> Vec<String> {
        let mut n: Vec<String> = fs::read_dir(folder).expect("read the folder").map(|e| e.expect("an entry").file_name().to_string_lossy().into_owned()).collect();
        n.sort();
        n
    }

    #[test]
    fn a_list_and_a_read_of_the_current_picture_are_served_under_both_names_in_every_order() {
        let d = Device::new("serve");
        let s = d.session(SID, true);
        let one = png(b"one");
        fs::write(s.paste.join("paste-1.png"), &one).expect("write");
        for list in [
            LIST_X,
            &["-selection", "clipboard", "-t", "TARGETS", "-o"][..],
            &["-o", "-t", "TARGETS", "-selection", "clipboard"][..],
            &["-t", "TARGETS", "-o", "-selection", "clipboard"][..],
        ] {
            served(d.run(&s, "xclip", list), b"image/png\n", &format!("xclip {list:?}"));
        }
        served(d.run(&s, "xclip", READ_X_PNG), &one, "xclip read");
        served(d.run(&s, "xclip", &["-o", "-selection", "clipboard", "-t", "image/png"]), &one, "xclip read, another order");
        served(d.run(&s, "wl-paste", &["--list-types"]), b"image/png\n", "wl-paste --list-types");
        served(d.run(&s, "wl-paste", &["-l"]), b"image/png\n", "wl-paste -l");
        for read in [&["--type", "image/png"][..], &["-t", "image/png", "-n"][..], &["--no-newline", "--type", "image/png"][..]] {
            served(d.run(&s, "wl-paste", read), &one, &format!("wl-paste {read:?}"));
        }
        // The current picture is the highest number, by its digits: a JPEG
        // after it is served as one, and a read of the other type is the
        // real tool's.
        let two = jpeg(b"two");
        fs::write(s.paste.join("paste-2.jpg"), &two).expect("write");
        served(d.run(&s, "xclip", LIST_X), b"image/jpeg\n", "a JPEG listed");
        served(d.run(&s, "xclip", &["-selection", "clipboard", "-o", "-t", "image/jpeg"]), &two, "a JPEG read");
        served(d.run(&s, "wl-paste", &["--type", "image/jpeg"]), &two, "a JPEG read by wl-paste");
        d.real_ran(d.run(&s, "xclip", READ_X_PNG), "xclip", READ_X_PNG, "a read of the type the current picture is not");
        let ten = png(b"ten");
        fs::write(s.paste.join("paste-10.png"), &ten).expect("write");
        served(d.run(&s, "xclip", READ_X_PNG), &ten, "10 is after 2");
        // The mode wrote nothing: paste/ holds what the test put there.
        assert_eq!(names(&s.paste), ["paste-1.png", "paste-10.png", "paste-2.jpg"]);
        d.no_decoy("serving");
    }

    /// Mutant "text served": a text read with a picture there still goes to
    /// the real tool, never gets the picture.
    #[test]
    fn a_text_read_and_every_other_use_go_to_the_real_tool_as_given_with_a_picture_there() {
        let d = Device::new("other");
        let s = d.session(SID, true);
        fs::write(s.paste.join("paste-1.png"), png(b"one")).expect("write");
        for args in [
            &["-selection", "clipboard", "-o"][..],
            &["-selection", "clipboard", "-o", "-t", "UTF8_STRING"][..],
            &["-selection", "clipboard", "-o", "-t", "text/plain"][..],
            &["-selection", "clipboard", "-o", "-t", "STRING"][..],
            &["-selection", "clipboard", "-i"][..],
            &["-selection", "clipboard", "-i", "-t", "image/png"][..],
            &["-selection", "primary", "-o", "-t", "TARGETS"][..],
            &["-o", "-t", "image/png"][..],
            &[][..],
            &["-selection", "clipboard", "-o", "-t", "a b'c\"d $HOME"][..],
        ] {
            d.real_ran(d.run(&s, "xclip", args), "xclip", args, &format!("xclip {args:?}"));
        }
        for args in [&[][..], &["--type", "text/plain"][..], &["-t", "text/plain;charset=utf-8", "-n"][..], &["--primary", "--type", "image/png"][..], &["--watch", "cat"][..], &["-n"][..]] {
            d.real_ran(d.run(&s, "wl-paste", args), "wl-paste", args, &format!("wl-paste {args:?}"));
        }
    }

    /// Mutant "the real tool found through PATH": with no `--real`, every
    /// other use prints nothing and exits 1, and no tool of that name on
    /// `PATH` starts (the script is run by its path here, with only the
    /// decoys on `PATH`).
    #[test]
    fn with_no_real_tool_any_other_use_prints_nothing_and_starts_nothing_found_by_path() {
        let d = Device::new("noreal");
        let s = d.session(SID, false);
        let one = png(b"one");
        fs::write(s.paste.join("paste-1.png"), &one).expect("write");
        let path = format!("{}:/usr/bin:/bin", d.decoys.display());
        for (tool, args) in [
            ("xclip", &["-selection", "clipboard", "-o"][..]),
            ("xclip", &["-selection", "clipboard", "-o", "-t", "text/plain"][..]),
            ("xclip", &["-selection", "clipboard", "-i"][..]),
            ("wl-paste", &[][..]),
            ("wl-paste", &["--type", "text/plain"][..]),
        ] {
            nothing(d.exec(&s.bin.join(tool), &path, args), &format!("{tool} {args:?}"));
            d.no_decoy(&format!("{tool} {args:?}"));
        }
        // Its own answers stand without one.
        served(d.exec(&s.bin.join("xclip"), &path, LIST_X), b"image/png\n", "a list with no real tool");
        served(d.exec(&s.bin.join("wl-paste"), &path, &["--type", "image/png"]), &one, "a read with no real tool");
        d.no_decoy("its own answers");
    }

    #[test]
    fn with_no_current_picture_a_list_or_an_image_read_prints_nothing_and_exits_1() {
        let d = Device::new("none");
        let s = d.session(SID, true);
        let empty = |what: &str| {
            nothing(d.run(&s, "xclip", LIST_X), &format!("{what}: xclip list"));
            nothing(d.run(&s, "xclip", READ_X_PNG), &format!("{what}: xclip read"));
            nothing(d.run(&s, "xclip", &["-selection", "clipboard", "-o", "-t", "image/jpeg"]), &format!("{what}: xclip JPEG read"));
            nothing(d.run(&s, "wl-paste", &["-l"]), &format!("{what}: wl-paste list"));
            nothing(d.run(&s, "wl-paste", &["--type", "image/png"]), &format!("{what}: wl-paste read"));
        };
        empty("an empty paste folder");
        // A text read is still the real tool's.
        d.real_ran(d.run(&s, "xclip", &["-selection", "clipboard", "-o"]), "xclip", &["-selection", "clipboard", "-o"], "a text read");
        // Names that are not a picture's, and a folder under one.
        for name in ["paste-01.png", "paste-0.png", ".part-3", "paste-1.gif", "paste-1.png.txt", "paste-1.jpeg", "notes.txt"] {
            fs::write(s.paste.join(name), png(b"x")).expect("write");
        }
        dir(&s.paste.join("paste-7.png"), 0o700);
        empty("names that are not a picture's, and a folder");
        fs::remove_dir(s.paste.join("paste-7.png")).expect("remove");
        // Two pictures share the highest number: neither is current.
        fs::write(s.paste.join("paste-3.png"), png(b"3")).expect("write");
        fs::write(s.paste.join("paste-3.jpg"), jpeg(b"3")).expect("write");
        empty("two names share the highest number");
        // No paste folder at all.
        let _ = fs::remove_dir_all(&s.paste);
        empty("no paste folder");
        d.no_decoy("no picture");
    }

    /// The picture must be a regular file of 1 byte to 20 MiB that begins
    /// with its type's signature: text under a picture's name is no picture.
    #[test]
    fn the_picture_is_a_file_of_at_most_20_mib_that_begins_with_its_types_signature() {
        let d = Device::new("file");
        let s = d.session(SID, true);
        let at = s.paste.join("paste-1.png");
        for (bytes, what) in [
            (b"hello, this is text".to_vec(), "text under a PNG's name"),
            (jpeg(b"a JPEG"), "a JPEG under a PNG's name"),
            (Vec::new(), "an empty file"),
            (b"\x89PNG".to_vec(), "a PNG's signature cut short"),
        ] {
            fs::write(&at, &bytes).expect("write");
            nothing(d.run(&s, "xclip", LIST_X), &format!("{what}: list"));
            nothing(d.run(&s, "xclip", READ_X_PNG), &format!("{what}: read"));
        }
        fs::write(s.paste.join("paste-2.jpg"), png(b"a PNG")).expect("write");
        nothing(d.run(&s, "xclip", LIST_X), "a PNG under a JPEG's name");
        fs::remove_file(s.paste.join("paste-2.jpg")).expect("remove");
        // Exactly 20 MiB is served; one byte more is not.
        let mut big = png(b"");
        big.resize(20 * MIB, 0x5a);
        fs::write(&at, &big).expect("write");
        served(d.run(&s, "xclip", READ_X_PNG), &big, "a picture of exactly 20 MiB");
        big.push(0x5a);
        fs::write(&at, &big).expect("write");
        nothing(d.run(&s, "xclip", LIST_X), "a picture over 20 MiB");
        nothing(d.run(&s, "xclip", READ_X_PNG), "a picture over 20 MiB");
    }

    /// Mutant "a read outside paste/": pictures in the session's own folder,
    /// its bin/, the sessions folder, the device folder and the store are
    /// never served, and a link out of paste/ is never followed. This device
    /// has one session only.
    #[test]
    fn only_the_sessions_paste_folder_is_read_and_no_link_out_of_it() {
        let d = Device::new("outside");
        let s = d.session(SID, true);
        let elsewhere = png(b"elsewhere");
        let store = dir(&d.store, 0o700);
        for (folder, name) in [
            (&s.folder, "paste-5.png"),
            (&s.bin, "paste-6.png"),
            (&d.device.join("sessions"), "paste-7.png"),
            (&d.device, "paste-8.png"),
            (&store, "paste-9.png"),
            (&d.root, "paste-4.png"),
        ] {
            fs::write(folder.join(name), &elsewhere).expect("write");
        }
        nothing(d.run(&s, "xclip", LIST_X), "pictures outside paste/ only");
        nothing(d.run(&s, "wl-paste", &["--type", "image/png"]), "pictures outside paste/ only");
        // A link in paste/ to a picture of the user's own outside it.
        symlink(s.folder.join("paste-5.png"), s.paste.join("paste-2.png")).expect("a link");
        nothing(d.run(&s, "xclip", LIST_X), "a link to a picture outside paste/");
        nothing(d.run(&s, "xclip", READ_X_PNG), "a link to a picture outside paste/");
        fs::remove_file(s.paste.join("paste-2.png")).expect("remove");
        // Its own picture is served, and only it.
        let mine = png(b"mine");
        fs::write(s.paste.join("paste-1.png"), &mine).expect("write");
        served(d.run(&s, "xclip", READ_X_PNG), &mine, "its own picture beside the others");
        // paste/ itself a link to a folder of the user's own: nothing.
        let away = dir(&d.root.join("away"), 0o700);
        fs::write(away.join("paste-3.png"), &elsewhere).expect("write");
        fs::rename(&s.paste, d.root.join("paste-kept")).expect("move paste/ away");
        symlink(&away, &s.paste).expect("a link");
        nothing(d.run(&s, "xclip", LIST_X), "paste/ a link");
        d.no_decoy("outside paste/");
    }

    /// Mutant "another session's picture served": a session with no picture
    /// gets nothing while another session on the device has one, and each
    /// session is served its own.
    #[test]
    fn a_session_is_served_its_own_picture_and_never_another_sessions() {
        let d = Device::new("sessions");
        let a = d.session(SID, true);
        let b = d.session(OTHER, true);
        let theirs = png(b"theirs");
        fs::write(b.paste.join("paste-9.png"), &theirs).expect("write");
        nothing(d.run(&a, "xclip", LIST_X), "a session with no picture beside one that has");
        nothing(d.run(&a, "xclip", READ_X_PNG), "a session with no picture beside one that has");
        nothing(d.run(&a, "wl-paste", &["--type", "image/png"]), "a session with no picture beside one that has");
        served(d.run(&b, "xclip", READ_X_PNG), &theirs, "the other session's own");
        let mine = png(b"mine");
        fs::write(a.paste.join("paste-1.png"), &mine).expect("write");
        served(d.run(&a, "xclip", READ_X_PNG), &mine, "its own, though the other's number is higher");
        served(d.run(&b, "xclip", READ_X_PNG), &theirs, "the other's own");
        d.no_decoy("two sessions");
    }

    /// Every folder from the store's parent down to paste/ must be a real
    /// folder of the user's own, 0700: one open to others, or the session's
    /// folder a link to another session's, gives nothing. Run directly, as
    /// the session's own scripts would run inside the moved folder.
    #[test]
    fn each_folder_on_the_way_is_private_and_no_link() {
        let d = Device::new("way");
        let a = d.session(SID, true);
        let b = d.session(OTHER, true);
        fs::write(a.paste.join("paste-1.png"), png(b"mine")).expect("write");
        fs::write(b.paste.join("paste-1.png"), png(b"theirs")).expect("write");
        let store = d.store_arg();
        let list = |sid: &str| d.clip(&["--store", store.as_str(), "--session", sid, "--as", "xclip", "--", "-selection", "clipboard", "-o", "-t", "TARGETS"]);
        served(list(SID), b"image/png\n", "as laid out");
        for folder in [d.device.clone(), d.device.join("sessions"), a.folder.clone(), a.paste.clone()] {
            for mode in [0o750, 0o705, 0o701, 0o600] {
                fs::set_permissions(&folder, fs::Permissions::from_mode(mode)).expect("its mode");
                nothing(list(SID), &format!("{} at {mode:o}", folder.display()));
                fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).expect("its mode");
            }
        }
        served(list(SID), b"image/png\n", "as laid out again");
        // The session's folder a link to another session's: nothing.
        fs::rename(&a.folder, d.root.join("a-kept")).expect("move it away");
        symlink(&b.folder, &a.folder).expect("a link");
        nothing(list(SID), "the session's folder a link to another's");
        served(list(OTHER), b"image/png\n", "the other session itself");
        d.no_decoy("the way");
    }

    #[test]
    fn a_command_line_it_does_not_take_exits_2_and_starts_nothing() {
        let d = Device::new("usage");
        let s = d.session(SID, true);
        fs::write(s.paste.join("paste-1.png"), png(b"one")).expect("write");
        let store = d.store_arg();
        let tool = d.tools.join("xclip").to_str().expect("a Unicode path").to_string();
        let in_bin = s.bin.join("xclip").to_str().expect("a Unicode path").to_string();
        let link = d.root.join("link-into-bin");
        symlink(s.bin.join("xclip"), &link).expect("a link");
        let link = link.to_str().expect("a Unicode path").to_string();
        let st = store.as_str();
        let cases: Vec<(Vec<&str>, &str)> = vec![
            (vec!["--store", st, "--session", SID, "--as", "xclip", "-selection", "clipboard", "-o"], "no --"),
            (vec!["--store", st, "--session", SID, "--"], "no --as"),
            (vec!["--store", st, "--as", "xclip", "--"], "no --session"),
            (vec!["--session", SID, "--as", "xclip", "--"], "no --store"),
            (vec!["--store", st, "--session", SID, "--as", "xsel", "--"], "another tool"),
            (vec!["--store", st, "--session", SID, "--as", "xclip", "--as", "xclip", "--"], "--as twice"),
            (vec!["--store", st, "--session", SID, "--as", "xclip", "--verbose", "1", "--"], "an unknown option"),
            (vec!["--store", "store", "--session", SID, "--as", "xclip", "--"], "a relative store"),
            (vec!["--store", st, "--session", "../sessions/rmfedcba9876543210fedcba98765432", "--as", "xclip", "--"], "a session naming another's folder"),
            (vec!["--store", st, "--session", "rm0123/../../x", "--as", "xclip", "--"], "a session with path parts"),
            (vec!["--store", st, "--session", SID, "--as", "xclip", "--real", "xclip", "--"], "a relative real tool"),
            (vec!["--store", st, "--session", SID, "--as", "xclip", "--real", in_bin.as_str(), "--"], "a real tool in the session's bin/"),
            (vec!["--store", st, "--session", SID, "--as", "xclip", "--real", link.as_str(), "--"], "a real tool whose real path is in bin/"),
            (vec!["--store", st, "--session", SID, "--as", "xclip", "--real", tool.as_str(), "--real", tool.as_str(), "--"], "--real twice"),
        ];
        for (args, what) in cases {
            let mut with_list = args.clone();
            with_list.extend_from_slice(LIST_X);
            refused(d.clip(&with_list), what);
        }
        d.no_decoy("command lines refused");
        // The same mode with a command line it takes.
        served(d.clip(&["--store", st, "--session", SID, "--as", "xclip", "--real", tool.as_str(), "--", "-selection", "clipboard", "-o", "-t", "TARGETS"]), b"image/png\n", "taken");
    }
}
