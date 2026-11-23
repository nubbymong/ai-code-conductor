//! `aicc-helper capture` (protocol section 15, "Capturing the displays"): on
//! macOS and Linux the mode says it is not supported and writes nothing; on
//! Windows it takes only `--out <absolute folder>`, and a run either writes
//! one BMP per display it lists, of the size it lists, or says there is no
//! desktop and writes nothing. It never writes over a file that is there.
//! Whether the pixels are a real picture of the screen is probe P21's
//! question (helper/probes/README.md), not this test's: a CI runner's
//! desktop may be blank.

use std::path::PathBuf;
use std::process::{Command, Output};

fn helper(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_aicc-helper")).args(args).output().expect("run the helper")
}

/// A new, empty folder of this test's own.
fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("aicc-capture-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a test folder");
    dir
}

fn files_in(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir).expect("the folder").map(|e| e.expect("an entry").file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[cfg(not(windows))]
#[test]
fn off_windows_the_mode_is_not_supported_and_writes_nothing() {
    let dir = folder("unsupported");
    let out = helper(&["capture", "--out", &dir.to_string_lossy()]);
    assert_eq!(out.status.code(), Some(4), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(out.stdout.is_empty(), "it printed {}", String::from_utf8_lossy(&out.stdout));
    assert!(String::from_utf8_lossy(&out.stderr).contains("not supported"));
    assert!(files_in(&dir).is_empty());
    // A command line it would refuse on Windows gets the same answer here.
    let out = helper(&["capture"]);
    assert_eq!(out.status.code(), Some(4));
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(windows)]
mod windows {
    use super::{files_in, folder, helper};
    use aicc_helper::capture::{bmp_header, pixel_bytes, BMP_HEADER_BYTES};
    use aicc_helper::json;
    use std::io::Write;

    #[test]
    fn a_command_line_it_does_not_take_exits_2_and_writes_nothing() {
        let dir = folder("usage");
        let d = dir.to_string_lossy().into_owned();
        for bad in [
            vec!["capture"],
            vec!["capture", "--out"],
            vec!["capture", "--out", "relative"],
            vec!["capture", "--out", d.as_str(), "--out", d.as_str()],
            vec!["capture", "--out", d.as_str(), "--window", "1"],
        ] {
            let out = helper(&bad);
            assert_eq!(out.status.code(), Some(2), "{bad:?}: {}", String::from_utf8_lossy(&out.stderr));
            assert!(out.stdout.is_empty(), "{bad:?} printed {}", String::from_utf8_lossy(&out.stdout));
            assert!(String::from_utf8_lossy(&out.stderr).contains("usage: aicc-helper capture --out <folder>"), "{bad:?}");
        }
        assert!(files_in(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_that_is_not_there_exits_1() {
        let dir = folder("gone").join("not-there");
        let out = helper(&["capture", "--out", &dir.to_string_lossy()]);
        assert_eq!(out.status.code(), Some(1), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(out.stdout.is_empty());
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(dir.parent().expect("its parent"));
    }

    /// One run: it wrote each display it listed at the size it listed, or it
    /// said there was no desktop and wrote nothing. The file names it wrote.
    fn written_or_no_desktop(dir: &std::path::Path) -> Option<Vec<String>> {
        let out = helper(&["capture", "--out", &dir.to_string_lossy()]);
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        let wrote = match out.status.code() {
            Some(0) => true,
            Some(3) => false,
            other => panic!("capture exited {other:?}: {stderr}"),
        };
        // Which branch this runner took, in the job log: written straight to
        // stderr, which the test harness does not capture, so a pass shows
        // whether the grab and the write ran at all.
        let _ = writeln!(std::io::stderr(), "capture test: exit {:?} ({})", out.status.code(), if wrote { "displays written" } else { "no desktop on this runner" });
        if !wrote {
            assert!(stderr.contains("no desktop to capture"), "{stderr}");
            assert!(out.stdout.is_empty());
            assert!(files_in(dir).is_empty(), "a run with no desktop left files");
            return None;
        }
        let text = String::from_utf8(out.stdout).expect("UTF-8");
        assert_eq!(text.matches('\n').count(), 1, "one line: {text}");
        let line = json::parse(text.trim_end().as_bytes()).expect("the line is JSON");
        let rows = line.get("displays").and_then(|v| v.as_array()).expect("displays").clone();
        assert!(!rows.is_empty(), "a run that wrote no display exited 0");
        let mut names = Vec::new();
        for (i, row) in rows.iter().enumerate() {
            let file = row.get("file").and_then(|v| v.as_str()).expect("file").to_string();
            assert_eq!(file, format!("display-{}.bmp", i + 1));
            let width = row.get("width").and_then(|v| v.as_u64()).expect("width") as u32;
            let height = row.get("height").and_then(|v| v.as_u64()).expect("height") as u32;
            let dpi = row.get("dpi").and_then(|v| v.as_u64()).expect("dpi") as u32;
            let scale = row.get("scale").and_then(|v| v.as_u64()).expect("scale") as u32;
            assert_eq!(scale, (dpi * 100 + 48) / 96);
            assert!(row.get("left").and_then(|v| v.as_i64()).is_some() && row.get("top").and_then(|v| v.as_i64()).is_some());
            assert!(row.get("primary").and_then(|v| v.as_bool()).is_some());
            let bytes = std::fs::read(dir.join(&file)).expect("the display's file");
            assert_eq!(bytes.len(), BMP_HEADER_BYTES + pixel_bytes(width, height), "{file}");
            assert_eq!(&bytes[..BMP_HEADER_BYTES], &bmp_header(width, height, dpi).expect("a header")[..], "{file}");
            assert!(bytes[BMP_HEADER_BYTES..].chunks_exact(4).all(|px| px[3] == 255), "{file}: a pixel is not opaque");
            names.push(file);
        }
        assert_eq!(rows.iter().filter(|r| r.get("primary").and_then(|v| v.as_bool()) == Some(true)).count(), 1, "one primary display");
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(files_in(dir), sorted, "the folder holds exactly the files listed");
        Some(names)
    }

    #[test]
    fn a_run_writes_each_display_it_lists_or_says_there_is_no_desktop() {
        let dir = folder("run");
        let written = written_or_no_desktop(&dir);
        if let Some(names) = written {
            // A second run into the same folder writes over nothing: it
            // fails, and the first run's files are as they were.
            let before: Vec<Vec<u8>> = names.iter().map(|n| std::fs::read(dir.join(n)).expect("a file")).collect();
            let out = helper(&["capture", "--out", &dir.to_string_lossy()]);
            assert_eq!(out.status.code(), Some(1), "{}", String::from_utf8_lossy(&out.stderr));
            assert!(out.stdout.is_empty());
            let after: Vec<Vec<u8>> = names.iter().map(|n| std::fs::read(dir.join(n)).expect("a file")).collect();
            assert!(before == after, "a second run changed a file");
            let mut sorted = names.clone();
            sorted.sort();
            assert_eq!(files_in(&dir), sorted, "a failed run left a file of its own");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
