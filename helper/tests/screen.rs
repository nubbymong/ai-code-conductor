//! The holder's screen (plan 2.1.3-beta.12 section A3, aicc_planning#342).
//!
//!  1. Every recording of the screen corpus (helper/fixtures/screens/), its
//!     chunks fed to the screen as the holder feeds it, gives the rows the
//!     corpus committed for xterm.js 6.0.0 (tests/unit/shared/screen-corpus.test.ts)
//!     after each resize mark and after the last chunk, and the same last 200
//!     lines; the folder is read, so a recording added later is covered too.
//!  2. The same bytes in one piece and a byte at a time give the same rows.
//!  3. 300 lines through a 40-row screen leave the last 200 in the tail.
//!  4. A huge parameter and a 16 MiB string return within a bound, keep the
//!     screen's memory bounded and leave the screen usable.
//!  5. The modes read as the sequences set them, in one piece and a byte at a
//!     time; a recording that switches to the alternate screen reads it.
//!  6. A holder answers `screen.read` and `screen.tail` to a connection that
//!     acked `screen`, attached or not, and changes nothing: no offset, no
//!     attach, no size; it refuses a connection that did not ack `screen`,
//!     and a relay; a resize resizes its screen.
//!  7. What the screen costs: its memory and its parse rate on the corpus,
//!     written to the job's summary.
//!
//! Not checked here: the rows named in WIDTH_ROWS, and nothing else, which
//! the crate and xterm.js 6.0.0 show apart only because they count a
//! character's cells by different Unicode versions.

use aicc_helper::client::Client;
use aicc_helper::frame::{Body, Frame};
use aicc_helper::hello;
use aicc_helper::json::{self, Value};
use aicc_helper::pids;
use aicc_helper::pty::PtySize;
use aicc_helper::screen::{self, js_blank, Modes, Read, Screen, TailLine};
use aicc_helper::store::Record;
use aicc_helper::transport;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

// ── what this thread has allocated and not freed ───────────────────────────

/// The system allocator, counting the bytes each thread holds, so a test can
/// see what the screen keeps without other tests' threads in the count.
struct Counting;

thread_local! {
    static LIVE: Cell<isize> = const { Cell::new(0) };
}

fn count(delta: isize) {
    let _ = LIVE.try_with(|l| l.set(l.get() + delta));
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc(layout);
        if !p.is_null() {
            count(layout.size() as isize);
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(layout);
        if !p.is_null() {
            count(layout.size() as isize);
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        count(-(layout.size() as isize));
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = System.realloc(ptr, layout, new_size);
        if !p.is_null() {
            count(new_size as isize - layout.size() as isize);
        }
        p
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// The bytes this thread holds now.
fn live() -> isize {
    LIVE.with(Cell::get)
}

// ── the corpus ──────────────────────────────────────────────────────────────

fn screens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join("screens")
}

fn load(path: &Path) -> Value {
    let bytes = fs::read(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    json::parse(&bytes).unwrap_or_else(|e| panic!("{} is not JSON: {e:?}", path.display()))
}

fn num(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or_else(|| panic!("no number {key} in {}", v.to_json()))
}

fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_else(|| panic!("no string {key}"))
}

enum Event {
    Chunk(Vec<u8>),
    Resize(PtySize),
    Other,
}

struct Recording {
    cols: u16,
    rows: u16,
    events: Vec<Event>,
}

/// Every recording's name, from the folder.
fn recording_names() -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(screens_dir())
        .expect("the corpus folder")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json") && !n.ends_with(".rows.json"))
        .map(|n| n[..n.len() - ".json".len()].to_string())
        .collect();
    names.sort();
    names
}

fn read_recording(name: &str) -> Recording {
    let v = load(&screens_dir().join(format!("{name}.json")));
    let events = v
        .get("events")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("{name}: no events"))
        .iter()
        .map(|e| match (e.get("text").and_then(Value::as_str), e.get("ev").and_then(Value::as_str)) {
            (Some(text), _) => Event::Chunk(text.as_bytes().to_vec()),
            (None, Some("resize")) => Event::Resize(PtySize { cols: num(e, "cols") as u16, rows: num(e, "rows") as u16 }),
            _ => Event::Other,
        })
        .collect();
    Recording { cols: num(&v, "cols") as u16, rows: num(&v, "rows") as u16, events }
}

/// A committed screen: its head (after what, at which event, its size, the
/// screen in use) and its rows as JSON.
struct Snap {
    head: String,
    lines: Vec<Value>,
}

struct Committed {
    snaps: Vec<Snap>,
    tail: Vec<String>,
}

fn read_committed(name: &str) -> Committed {
    let v = load(&screens_dir().join(format!("{name}.rows.json")));
    let snaps = v
        .get("screens")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("{name}: no screens"))
        .iter()
        .map(|s| Snap {
            head: format!("{} {} {}x{} {}", string(s, "after"), num(s, "event"), num(s, "cols"), num(s, "rows"), string(s, "buffer")),
            lines: s.get("lines").and_then(Value::as_array).cloned().unwrap_or_default(),
        })
        .collect();
    let tail = v.get("tail").and_then(Value::as_array).unwrap_or_else(|| panic!("{name}: no tail")).iter().map(|l| l.as_str().expect("a tail line").to_string()).collect();
    Committed { snaps, tail }
}

/// How a replay hands the chunks to the screen.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum How {
    AsRecorded,
    OnePiece,
    ByteByByte,
}

/// What a replay gives: each screen (after what, at which event, the read),
/// and the last 200 lines after the last chunk.
struct Made {
    snaps: Vec<(&'static str, usize, Read)>,
    tail: Vec<TailLine>,
}

/// Feed a recording to a screen as the holder feeds its screen: every chunk
/// from the first byte, the screen resized at each resize mark. `how` says
/// whether the chunks between two marks go as they were recorded, in one
/// piece, or a byte at a time.
fn replay(rec: &Recording, how: How) -> Made {
    let mut s = Screen::new(PtySize { cols: rec.cols, rows: rec.rows });
    let mut pending: Vec<u8> = Vec::new();
    let flush = |s: &mut Screen, pending: &mut Vec<u8>| {
        match how {
            How::OnePiece => s.feed(pending),
            How::ByteByByte => {
                for b in pending.iter() {
                    s.feed(std::slice::from_ref(b));
                }
            }
            How::AsRecorded => {}
        }
        pending.clear();
    };
    let mut snaps = Vec::new();
    for (i, e) in rec.events.iter().enumerate() {
        match e {
            Event::Chunk(bytes) if how == How::AsRecorded => s.feed(bytes),
            Event::Chunk(bytes) => pending.extend_from_slice(bytes),
            Event::Resize(size) => {
                flush(&mut s, &mut pending);
                s.resize(*size);
                snaps.push(("resize", i, s.read()));
            }
            Event::Other => {}
        }
    }
    flush(&mut s, &mut pending);
    snaps.push(("last chunk", rec.events.len().saturating_sub(1), s.read()));
    let tail = s.tail(screen::TAIL_MAX);
    Made { snaps, tail }
}

fn row_json(l: &screen::Line) -> Value {
    Value::obj(vec![("text", Value::str(&l.text)), ("typed", Value::str(&l.typed)), ("inverse", Value::str(&l.inverse)), ("width", Value::uint(u64::from(l.width))), ("end", Value::uint(u64::from(l.end)))])
}

/// The tail's text as the corpus keeps it: trailing blank lines dropped.
fn tail_text(tail: &[TailLine]) -> Vec<String> {
    let mut out: Vec<String> = tail.iter().map(|l| l.text.clone()).collect();
    while out.last().map_or(false, |l| js_blank(l)) {
        out.pop();
    }
    out
}

/// True when the crate counts `c` two cells wide.
fn wide_in_crate(c: char) -> bool {
    let mut s = Screen::new(PtySize { cols: 4, rows: 1 });
    s.feed(c.to_string().as_bytes());
    s.read().lines[0].end == 2
}

/// Where a replay and the committed rows differ: "screen 2 row 7", "screen
/// 2" (its head), "tail line 3", "tail length", each with what each side
/// has, and the text of the committed row or line.
fn differences(made: &Made, want: &Committed) -> BTreeMap<String, (String, String)> {
    let mut out = BTreeMap::new();
    if made.snaps.len() != want.snaps.len() {
        out.insert("screens".to_string(), (format!("{} screens, {} committed", made.snaps.len(), want.snaps.len()), String::new()));
    }
    for (k, ((after, event, read), snap)) in made.snaps.iter().zip(&want.snaps).enumerate() {
        let head = format!("{after} {event} {}x{} {}", read.cols, read.rows, read.modes.screen_word());
        if head != snap.head {
            out.insert(format!("screen {k}"), (format!("ours {head}, xterm {}", snap.head), String::new()));
        }
        for r in 0..read.lines.len().max(snap.lines.len()) {
            let ours = read.lines.get(r).map(|l| row_json(l).to_json()).unwrap_or_default();
            let theirs = snap.lines.get(r).map(Value::to_json).unwrap_or_default();
            if ours != theirs {
                let text = snap.lines.get(r).and_then(|l| l.get("text")).and_then(Value::as_str).unwrap_or("").to_string();
                out.insert(format!("screen {k} row {r}"), (format!("ours  {ours}\n      xterm {theirs}"), text));
            }
        }
    }
    let ours = tail_text(&made.tail);
    if ours.len() != want.tail.len() {
        out.insert("tail length".to_string(), (format!("{} lines, {} committed", ours.len(), want.tail.len()), String::new()));
    }
    for (k, (a, b)) in ours.iter().zip(&want.tail).enumerate() {
        if a != b {
            out.insert(format!("tail line {k}"), (format!("ours  {a:?}\n      xterm {b:?}"), b.clone()));
        }
    }
    out
}

/// The rows of the corpus the crate and xterm.js 6.0.0 show apart only
/// because the crate counts a character's cells by current Unicode and
/// xterm.js 6.0.0 by Unicode 6 (which counts it one cell): the recording, the
/// row ("screen K row R" or "tail line K"), and the character. This is the
/// "Not checked" list of case 1 and may hold nothing else (plan 2.1.3-beta.12
/// section A3; Questions, 3: neither side gives way in this beta). Each entry
/// must still differ, its character must be in the committed row, and the
/// crate must count it two cells.
///
/// Codex 0.157.1's update notice on macOS starts "✨" (U+2728, SPARKLES, an
/// emoji drawn wide by default since Unicode 9). Codex counts it two cells
/// and writes the text after it two cells on; xterm.js 6.0.0 gives it one,
/// so its row keeps a blank cell the crate's row has not (checked with
/// @xterm/headless 6.0.0 when this list was written: one cell).
const WIDTH_ROWS: &[(&str, &str, char)] = &[
    ("codex-macos-ready", "screen 0 row 1", '\u{2728}'),
    ("codex-macos-ready", "screen 1 row 1", '\u{2728}'),
    ("codex-macos-ready", "screen 2 row 1", '\u{2728}'),
    ("codex-macos-ready", "screen 3 row 1", '\u{2728}'),
    ("codex-macos-ready", "tail line 1", '\u{2728}'),
];

#[test]
fn every_recording_gives_the_committed_rows_after_each_resize_and_the_last_chunk() {
    let names = recording_names();
    assert!(names.len() >= 28, "only {} recordings in {}", names.len(), screens_dir().display());
    let mut unexpected: Vec<String> = Vec::new();
    let mut stale: Vec<String> = Vec::new();
    let mut compared = 0usize;
    for name in &names {
        let rec = read_recording(name);
        let want = read_committed(name);
        let made = replay(&rec, How::AsRecorded);
        let diffs = differences(&made, &want);
        compared += want.snaps.iter().map(|s| s.lines.len()).sum::<usize>() + want.tail.len();
        for (place, (detail, text)) in &diffs {
            let listed = WIDTH_ROWS.iter().find(|(n, p, _)| n == name && p == place);
            match listed {
                Some((_, _, ch)) if text.contains(*ch) && wide_in_crate(*ch) => {}
                Some((_, _, ch)) => stale.push(format!("{name} {place}: listed for {ch:?}, which {}", if text.contains(*ch) { "the crate counts one cell" } else { "is not in the committed row" })),
                None => {
                    let wide: Vec<String> = text.chars().filter(|c| !c.is_ascii() && wide_in_crate(*c)).map(|c| format!("U+{:04X}", c as u32)).collect();
                    unexpected.push(format!("{name} {place} (wide in the crate: {wide:?}):\n      {detail}"));
                }
            }
        }
        for (n, place, ch) in WIDTH_ROWS.iter().filter(|(n, _, _)| n == name) {
            if !diffs.contains_key(*place) {
                stale.push(format!("{n} {place}: listed for {ch:?}, but the rows agree now: remove it from WIDTH_ROWS"));
            }
        }
    }
    for (n, place, _) in WIDTH_ROWS {
        if !names.iter().any(|x| x == n) {
            stale.push(format!("{n} {place}: no such recording"));
        }
    }
    assert!(compared > 1000, "only {compared} rows and lines compared");
    let shown: Vec<&String> = unexpected.iter().take(300).collect();
    assert!(
        unexpected.is_empty() && stale.is_empty(),
        "{} rows differ from xterm.js 6.0.0's and are not in WIDTH_ROWS, {} entries of WIDTH_ROWS are stale:\n{}\n{}",
        unexpected.len(),
        stale.len(),
        shown.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n"),
        stale.join("\n")
    );
}

#[test]
fn the_same_bytes_in_one_piece_and_a_byte_at_a_time_give_the_same_rows() {
    for name in recording_names() {
        let rec = read_recording(&name);
        let recorded = replay(&rec, How::AsRecorded);
        for how in [How::OnePiece, How::ByteByByte] {
            let made = replay(&rec, how);
            assert_eq!(made.snaps.len(), recorded.snaps.len(), "{name} {how:?}");
            for (k, (a, b)) in made.snaps.iter().zip(&recorded.snaps).enumerate() {
                assert!(a.2 == b.2, "{name} {how:?}: screen {k} differs from the chunks as recorded:\n{:?}\n{:?}", a.2, b.2);
            }
            assert_eq!(made.tail, recorded.tail, "{name} {how:?}: the tail differs from the chunks as recorded");
        }
    }
}

#[test]
fn three_hundred_lines_through_a_40_row_screen_leave_the_last_200_in_the_tail() {
    let mut s = Screen::new(PtySize { cols: 80, rows: 40 });
    let lines: Vec<String> = (1..=300).map(|n| format!("line {n}")).collect();
    s.feed(lines.join("\r\n").as_bytes());
    let before = s.read();
    let tail = s.tail(200);
    let texts: Vec<&str> = tail.iter().map(|l| l.text.as_str()).collect();
    let want: Vec<&str> = lines[100..].iter().map(String::as_str).collect();
    assert_eq!(texts, want);
    // No more than 200, however many are asked for and whatever the
    // screen's rows: 200 of scrollback is all the screen keeps.
    assert_eq!(s.tail(10_000), tail);
    assert_eq!(s.tail(5).iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), vec!["line 296", "line 297", "line 298", "line 299", "line 300"]);
    // A tail read leaves the screen as it was.
    assert_eq!(s.read(), before);
    assert_eq!(before.lines[39].text, "line 300");
    assert_eq!(before.lines[0].text, "line 261");
    // On a screen of 10 rows, the same: 200 lines of scrollback and 10 rows,
    // and the tail the last 200 of them.
    let mut s = Screen::new(PtySize { cols: 80, rows: 10 });
    s.feed(lines.join("\r\n").as_bytes());
    assert_eq!(s.tail(200).iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), want);
}

#[test]
fn a_huge_parameter_and_a_16_mib_string_return_within_a_bound_and_leave_the_screen_usable() {
    // The case main clamps: a repeat of the last character with a count of
    // fourteen digits. The parser reads at most 9999 of it, so 1 + 9999
    // characters are written: 50 whole rows of 200, and nothing scrolls.
    let mut s = Screen::new(PtySize { cols: 200, rows: 100 });
    let began = Instant::now();
    s.feed(b"x\x1b[99999999999999b");
    let took = began.elapsed();
    assert!(took < Duration::from_secs(5), "a repeat with a huge count took {took:?}");
    let r = s.read();
    let xs: usize = r.lines.iter().map(|l| l.text.matches('x').count()).sum();
    assert_eq!(xs, 1 + screen::PARAM_CEILING as usize, "the repeat wrote {xs} characters");
    assert_eq!(s.tail(200).len(), 100, "the repeat scrolled the screen");
    // The same count split across chunks is read the same.
    let mut split = Screen::new(PtySize { cols: 200, rows: 100 });
    for part in [&b"x\x1b[999"[..], &b"9999"[..], &b"9999999b"[..]] {
        split.feed(part);
    }
    assert_eq!(split.read(), r);

    // A 16 MiB OSC string, never ended but by BEL: the parser keeps at most
    // 1 KiB of it, so the screen holds no more than before, and the text after
    // it shows.
    let mut osc = Vec::with_capacity((16 << 20) + 16);
    osc.extend_from_slice(b"\x1b]0;");
    osc.resize(4 + (16 << 20), b'a');
    osc.push(0x07);
    osc.extend_from_slice(b"\r\nafter the string");
    let held = live();
    let began = Instant::now();
    s.feed(&osc);
    let took = began.elapsed();
    let grew = live() - held;
    assert!(took < Duration::from_secs(20), "a 16 MiB string took {took:?}");
    assert!(grew < 64 * 1024, "the screen holds {grew} more bytes after a 16 MiB string");
    let r = s.read();
    assert_eq!(r.lines[50].text, "after the string", "{:?}", &r.lines[48..52]);
    // DCS and APC strings of 16 MiB are not kept either.
    for start in [&b"\x1bP1;2|"[..], &b"\x1b_"[..]] {
        let mut long = start.to_vec();
        long.resize(start.len() + (16 << 20), b'b');
        long.extend_from_slice(b"\x1b\\\r\nand after that");
        let held = live();
        s.feed(&long);
        assert!(live() - held < 64 * 1024, "a string after {start:?} is kept");
    }
    let r = s.read();
    assert_eq!(r.lines[52].text, "and after that", "{:?}", &r.lines[50..54]);
}

/// The modes after `bytes`, fed in one piece and a byte at a time.
fn modes_after(s: &mut Screen, dripped: &mut Screen, bytes: &[u8]) -> Modes {
    s.feed(bytes);
    for b in bytes {
        dripped.feed(std::slice::from_ref(b));
    }
    assert_eq!(s.modes(), dripped.modes(), "after {:?}, a byte at a time", String::from_utf8_lossy(bytes));
    s.modes()
}

#[test]
fn the_modes_read_as_the_sequences_set_them() {
    let size = PtySize { cols: 40, rows: 5 };
    let (mut s, mut dripped) = (Screen::new(size), Screen::new(size));
    let none = modes_after(&mut s, &mut dripped, b"");
    assert_eq!(
        none,
        Modes { alternate: false, bracketed_paste: false, application_cursor: false, application_keypad: false, mouse: "none", mouse_encoding: "default", cursor_hidden: false }
    );
    let m = modes_after(&mut s, &mut dripped, b"\x1b[?1049h");
    assert_eq!((m.alternate, m.screen_word()), (true, "alternate"));
    let m = modes_after(&mut s, &mut dripped, b"\x1b[?2004h");
    assert!(m.alternate && m.bracketed_paste);
    let m = modes_after(&mut s, &mut dripped, b"\x1b[?1000h\x1b[?1006h");
    assert_eq!((m.mouse, m.mouse_encoding), ("press-release", "sgr"));
    let m = modes_after(&mut s, &mut dripped, b"\x1b[?1002h");
    assert_eq!(m.mouse, "button-motion");
    let m = modes_after(&mut s, &mut dripped, b"\x1b[?1003h\x1b[?1005h");
    assert_eq!((m.mouse, m.mouse_encoding), ("any-motion", "utf8"));
    let m = modes_after(&mut s, &mut dripped, b"\x1b[?1h\x1b=\x1b[?25l");
    assert!(m.application_cursor && m.application_keypad && m.cursor_hidden);
    // Each off by its own sequence, one at a time.
    let m = modes_after(&mut s, &mut dripped, b"\x1b[?2004l");
    assert!(!m.bracketed_paste && m.alternate && m.mouse == "any-motion");
    let m = modes_after(&mut s, &mut dripped, b"\x1b[?1003l\x1b[?1005l");
    assert_eq!((m.mouse, m.mouse_encoding), ("none", "default"));
    let m = modes_after(&mut s, &mut dripped, b"\x1b[?1l\x1b>\x1b[?25h");
    assert!(!m.application_cursor && !m.application_keypad && !m.cursor_hidden);
    let m = modes_after(&mut s, &mut dripped, b"\x1b[?1049l");
    assert_eq!(m, none);
    // The screen in use is the one the rows come from.
    let m = modes_after(&mut s, &mut dripped, b"normal text\x1b[?1049h\x1b[Halternate text");
    assert!(m.alternate);
    assert_eq!(s.read().lines[0].text, "alternate text");
    let m = modes_after(&mut s, &mut dripped, b"\x1b[?1049l");
    assert!(!m.alternate);
    assert_eq!(s.read().lines[0].text, "normal text");
    assert_eq!(s.read(), dripped.read());
}

#[test]
fn a_recording_that_switches_to_the_alternate_screen_reads_alternate_and_normal_after_it_switches_back() {
    let mut seen = 0;
    for name in recording_names() {
        let want = read_committed(&name);
        if !want.snaps.last().map_or(false, |s| s.head.ends_with(" alternate")) {
            continue;
        }
        let rec = read_recording(&name);
        let mut s = Screen::new(PtySize { cols: rec.cols, rows: rec.rows });
        for e in &rec.events {
            match e {
                Event::Chunk(bytes) => s.feed(bytes),
                Event::Resize(size) => s.resize(*size),
                Event::Other => {}
            }
        }
        assert_eq!(s.modes().screen_word(), "alternate", "{name}");
        s.feed(b"\x1b[?1049l");
        assert_eq!(s.modes().screen_word(), "normal", "{name}");
        seen += 1;
    }
    assert!(seen >= 10, "only {seen} recordings end on the alternate screen");
}

// ── what the screen costs ──────────────────────────────────────────────────

/// `lines` full rows of `cols` characters.
fn full_rows(cols: u16, lines: usize) -> Vec<u8> {
    let row = "x".repeat(usize::from(cols));
    vec![row; lines].join("\r\n").into_bytes()
}

/// The bytes one screen of `size` holds once its screen and its 200 lines of
/// scrollback are full, and once the alternate screen is full too.
fn memory_of(size: PtySize) -> (isize, isize) {
    let before = live();
    let mut s = Screen::new(size);
    s.feed(&full_rows(size.cols, screen::SCROLLBACK_LINES + usize::from(size.rows)));
    // A tail read widens the scrollback rows it shows to the screen's width.
    let _ = s.tail(screen::TAIL_MAX);
    let normal = live() - before;
    s.feed(b"\x1b[?1049h");
    s.feed(&full_rows(size.cols, usize::from(size.rows)));
    let both = live() - before;
    drop(s);
    (normal, both)
}

fn mib(bytes: isize) -> String {
    format!("{:.2} MiB", bytes as f64 / (1024.0 * 1024.0))
}

/// Lines for this run's summary, as the job shows it, and the test's output.
fn report(lines: &[String]) {
    // Straight to standard error, which the test harness does not hold back
    // for a test that passes (it holds back only what the print macros
    // write), so the job's log shows the figures too.
    let mut err = std::io::stderr();
    for l in lines {
        let _ = writeln!(err, "screen cost ({}): {l}", std::env::consts::OS);
    }
    if let Ok(path) = std::env::var("GITHUB_STEP_SUMMARY") {
        if let Ok(mut f) = fs::OpenOptions::new().append(true).open(path) {
            let _ = writeln!(f, "\n**The holder's screen ({}, the test build)**\n", std::env::consts::OS);
            for l in lines {
                let _ = writeln!(f, "- {l}");
            }
        }
    }
}

#[test]
fn what_the_screen_costs() {
    let (normal, both) = memory_of(PtySize { cols: 120, rows: 40 });
    let (big_normal, big_both) = memory_of(PtySize { cols: 1000, rows: 1000 });
    let recordings: Vec<Recording> = recording_names().iter().map(|n| read_recording(n)).collect();
    let bytes: usize = recordings.iter().flat_map(|r| r.events.iter()).map(|e| if let Event::Chunk(b) = e { b.len() } else { 0 }).sum();
    let mut best = Duration::MAX;
    for _ in 0..3 {
        let began = Instant::now();
        for rec in &recordings {
            let mut s = Screen::new(PtySize { cols: rec.cols, rows: rec.rows });
            for e in &rec.events {
                match e {
                    Event::Chunk(b) => s.feed(b),
                    Event::Resize(size) => s.resize(*size),
                    Event::Other => {}
                }
            }
        }
        best = best.min(began.elapsed());
    }
    let rate = bytes as f64 / best.as_secs_f64();
    report(&[
        format!("120 x 40 with 200 lines of scrollback, all full: {} ({} with the alternate screen full too)", mib(normal), mib(both)),
        format!("1000 x 1000, the largest a launch may ask for, all full: {} ({} with the alternate screen full too)", mib(big_normal), mib(big_both)),
        format!("parse rate on the corpus ({} recordings, {} bytes): {:.2} MB/s, best of 3", recordings.len(), bytes, rate / 1e6),
    ]);
    assert!(normal > 0 && both >= normal);
    assert!(both < 2 * 1024 * 1024, "a 120 x 40 screen holds {}", mib(both));
    assert!(big_both < 80 * 1024 * 1024, "a 1000 x 1000 screen holds {}", mib(big_both));
    // The busiest CLI the corpus recorded writes up to 44 KiB a second while
    // a turn runs (the corpus fragment); the test build parses well past it.
    assert!(rate > 100.0 * 1024.0, "{rate:.0} bytes a second");
}

// ── through a holder ──────────────────────────────────────────────────────

const HELPER: &str = env!("CARGO_BIN_EXE_aicc-helper");
const FAKE: &str = env!("CARGO_BIN_EXE_aicc-fake-cli");
const WAIT: Duration = Duration::from_secs(20);

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// The tests that start processes run one at a time: on Windows a child
/// inherits every inheritable handle of its parent (as in hooks.rs).
fn one_at_a_time() -> MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A new, empty folder of this test, removed when dropped.
struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Folder {
        let dir = std::env::temp_dir().join(format!("aicc-screen-test-{name}-{}", std::process::id()));
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

/// Start a detached holder; the record it printed. Its output goes to
/// files: the holder outlives the starter, and would hold a pipe open.
fn hold(store_dir: &Folder, sid: &str) -> Record {
    let base = std::env::temp_dir().join(format!("aicc-screen-detach-{sid}-{}", std::process::id()));
    let (out_path, err_path) = (base.with_extension("out"), base.with_extension("err"));
    let store = store_dir.arg();
    let status = Command::new(HELPER)
        .args(["hold", "--detach", "--store", store.as_str(), "--session", sid, "--away", "60"])
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

/// A holder this test started, ended when dropped.
struct Held(Record);

impl Drop for Held {
    fn drop(&mut self) {
        if !pids::alive(self.0.pid) {
            return;
        }
        if let Ok(mut client) = Client::to_record(&self.0, WAIT) {
            if client.ack().is_ok() && client.send(msg("term.end", 2, vec![])).is_ok() {
                let deadline = Instant::now() + WAIT;
                while pids::alive(self.0.pid) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
}

fn msg(t: &str, id: u64, more: Vec<(&str, Value)>) -> Value {
    let mut members = vec![("t", Value::str(t)), ("id", Value::uint(id))];
    members.extend(more);
    Value::obj(members)
}

fn t_of(v: &Value) -> &str {
    v.get("t").and_then(Value::as_str).unwrap_or("")
}

/// A connection standing in for the app: the JSON messages it read and has
/// not yet looked at, and what its terminal showed.
struct App {
    client: Client,
    got: Vec<Value>,
    shown: Vec<u8>,
    next_id: u64,
}

impl App {
    /// Connect, read the hello and ack it with `caps`.
    fn connect(rec: &Record, caps: &[&str]) -> App {
        let mut client = Client::to_record(rec, WAIT).expect("connect to the holder and read its hello");
        client.send(hello::ack_message(1, caps)).expect("ack the hello");
        App { client, got: Vec::new(), shown: Vec::new(), next_id: 2 }
    }

    fn id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 2;
        id
    }

    /// The next JSON message before `until`; None at the end of the stream
    /// or when none came. Terminal output meanwhile is kept.
    fn read(&mut self, until: Instant) -> Option<Value> {
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            match self.client.recv(left) {
                Ok(Some(Frame { channel: 0, body: Body::Json(v) })) => return Some(v),
                Ok(Some(Frame { channel: 1, body: Body::Raw(bytes) })) => self.shown.extend_from_slice(&bytes),
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => return None,
            }
        }
    }

    /// Send `v` and wait for its answer; what came before it is kept.
    fn call(&mut self, v: Value) -> Value {
        let id = v.get("id").and_then(Value::as_u64).expect("a request id");
        self.client.send(v).expect("send a request");
        let until = Instant::now() + WAIT;
        loop {
            let m = self.read(until).unwrap_or_else(|| panic!("no answer to request {id}; got {:?}", self.got.iter().map(Value::to_json).collect::<Vec<_>>()));
            if m.get("re").and_then(Value::as_u64) == Some(id) {
                return m;
            }
            self.got.push(m);
        }
    }

    /// Wait until the terminal has shown `needle`.
    fn wait_text(&mut self, needle: &str) {
        let until = Instant::now() + WAIT;
        while !String::from_utf8_lossy(&self.shown).contains(needle) {
            match self.client.recv(until.saturating_duration_since(Instant::now())) {
                Ok(Some(Frame { channel: 1, body: Body::Raw(bytes) })) => self.shown.extend_from_slice(&bytes),
                Ok(Some(Frame { body: Body::Json(v), .. })) => self.got.push(v),
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => panic!("{needle:?} never appeared: {:?}", String::from_utf8_lossy(&self.shown)),
            }
        }
    }

    /// True once the holder has closed this connection.
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

    /// `screen.read` until a row shows `needle` (the screen is fed after the
    /// attached connection's output); the last answer.
    fn read_until_shown(&mut self, needle: &str) -> Value {
        let until = Instant::now() + WAIT;
        loop {
            let id = self.id();
            let answer = self.call(msg("screen.read", id, vec![]));
            assert_eq!(t_of(&answer), "screen.rows", "{}", answer.to_json());
            if rows_text(&answer).iter().any(|t| t.contains(needle)) {
                return answer;
            }
            assert!(Instant::now() < until, "no row showed {needle:?}: {}", answer.to_json());
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// Each row's text in a `screen.rows` or each line's in a `screen.lines`.
fn rows_text(answer: &Value) -> Vec<String> {
    answer.get("lines").and_then(Value::as_array).map(|ls| ls.iter().filter_map(|l| l.get("text").and_then(Value::as_str).map(str::to_string)).collect()).unwrap_or_default()
}

/// This test's environment, as much of it as a launch allows.
fn launch_env() -> Value {
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
    Value::Obj(env)
}

/// Launch the fake CLI at `cols` by `rows` from `app`, attach it from offset
/// 0, and wait for its banner.
fn launch_and_attach(app: &mut App, cwd: &Folder, cols: u64, rows: u64) {
    let id = app.id();
    let launched = app.call(msg("term.launch", id, vec![("argv", Value::strs(&[FAKE])), ("cwd", Value::Str(cwd.arg())), ("env", launch_env()), ("cols", Value::uint(cols)), ("rows", Value::uint(rows))]));
    assert_eq!(t_of(&launched), "term.launched", "{}", launched.to_json());
    let id = app.id();
    let attached = app.call(msg("term.attach", id, vec![("from", Value::uint(0))]));
    assert_eq!(t_of(&attached), "term.attached", "{}", attached.to_json());
    app.wait_text("FAKE-CLI READY");
}

#[test]
fn a_holder_answers_both_reads_attached_or_not_and_changes_nothing() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-reads");
    let work = Folder::new("work-reads");
    let sid = "screen-reads-01";
    let held = Held(hold(&store_dir, sid));
    // Before a launch there is no screen: not-found, and the connection stays.
    let mut early = App::connect(&held.0, &["core", "screen"]);
    assert!(early.client.hello.caps.iter().any(|c| c == "screen"), "{:?}", early.client.hello.caps);
    let id = early.id();
    let answer = early.call(msg("screen.read", id, vec![]));
    assert_eq!((t_of(&answer), answer.get("code").and_then(Value::as_str)), ("error", Some("not-found")), "{}", answer.to_json());
    let id = early.id();
    let answer = early.call(msg("screen.tail", id, vec![("count", Value::uint(3))]));
    assert_eq!(answer.get("code").and_then(Value::as_str), Some("not-found"), "{}", answer.to_json());

    // The app attached, as it acks today; it reads the screen as well.
    let mut app = App::connect(&held.0, &["core", "local", "screen"]);
    launch_and_attach(&mut app, &work, 100, 20);
    let rows = app.read_until_shown("FAKE-CLI READY");
    assert_eq!((num(&rows, "cols"), num(&rows, "rows")), (100, 20), "{}", rows.to_json());
    assert_eq!(rows.get("cut"), Some(&Value::Bool(false)));
    assert_eq!(rows_text(&rows).len(), 20);
    let modes = rows.get("modes").expect("modes");
    assert_eq!(modes.keys().map(|k| k.len()), Some(7), "{}", modes.to_json());
    assert!(screen::SCREEN_WORDS.contains(&string(modes, "screen")));
    assert!(screen::MOUSE_WORDS.contains(&string(modes, "mouse")));
    assert!(screen::ENCODING_WORDS.contains(&string(modes, "mouse_encoding")));
    let cursor = rows.get("cursor").expect("cursor");
    assert!(num(cursor, "row") < 20 && num(cursor, "col") <= 100, "{}", cursor.to_json());

    // A connection that is not attached reads both, and is still not
    // attached after: it may not resize or detach.
    let mut reader = App::connect(&held.0, &["core", "local", "screen"]);
    let rows = reader.read_until_shown("FAKE-CLI READY");
    assert_eq!(num(&rows, "cols"), 100);
    let id = reader.id();
    let lines = reader.call(msg("screen.tail", id, vec![("count", Value::uint(200))]));
    assert_eq!(t_of(&lines), "screen.lines", "{}", lines.to_json());
    assert!(rows_text(&lines).iter().any(|t| t.contains("FAKE-CLI READY")), "{}", lines.to_json());
    assert!(rows_text(&lines).len() <= 200);
    for (t, more) in [("term.resize", vec![("cols", Value::uint(50)), ("rows", Value::uint(10))]), ("term.detach", vec![])] {
        let id = reader.id();
        let answer = reader.call(msg(t, id, more));
        assert_eq!(answer.get("code").and_then(Value::as_str), Some("not-connected"), "{t} after a read: {}", answer.to_json());
    }

    // The attached app was not replaced, and its live output goes on from
    // where it was: typed input is echoed to it, once.
    app.client.send_raw(1, b"after the reads\r").expect("type");
    app.wait_text("echo: after the reads");
    // Nothing came to it but its output: no error, no replay.
    assert!(!app.got.iter().any(|m| t_of(m) == "error" || t_of(m) == "term.attached"), "the app was told {:?}", app.got.iter().map(Value::to_json).collect::<Vec<_>>());
    let rows = reader.read_until_shown("echo: after the reads");
    assert_eq!((num(&rows, "cols"), num(&rows, "rows")), (100, 20), "a read changed the size");
    // A new attach from 0 still replays everything: no offset moved.
    let mut again = App::connect(&held.0, &["core", "local"]);
    let id = again.id();
    let attached = again.call(msg("term.attach", id, vec![("from", Value::uint(0))]));
    assert_eq!(num(&attached, "ring_start"), 0, "{}", attached.to_json());
    again.wait_text("echo: after the reads");
    assert!(String::from_utf8_lossy(&again.shown).contains("FAKE-CLI READY"));
}

#[test]
fn a_read_from_a_connection_that_did_not_ack_screen_or_from_a_relay_is_refused() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-refused");
    let work = Folder::new("work-refused");
    let sid = "screen-refused-01";
    let held = Held(hold(&store_dir, sid));
    // The attached app takes tool streams, so a relay can open one.
    let mut app = App::connect(&held.0, &["core", "local", "mcp"]);
    launch_and_attach(&mut app, &work, 80, 24);

    // Everything a holder offers but `screen`: a read is a type this
    // connection does not allow, and it is closed. The same for the tail.
    for request in [msg("screen.read", 2, vec![]), msg("screen.tail", 2, vec![("count", Value::uint(5))])] {
        let mut other = App::connect(&held.0, &["core", "local", "hooks", "mcp", "away"]);
        other.client.send(request.clone()).expect("send");
        // A refusal of a type the connection does not allow names no request.
        let answer = other.read(Instant::now() + WAIT).expect("an answer");
        assert_eq!(answer.get("code").and_then(Value::as_str), Some("unknown-type"), "{}", answer.to_json());
        assert!(other.closed(), "a connection that did not ack screen stayed open after {}", request.to_json());
    }
    // The app's own connection did not ack it either.
    app.client.send(msg("screen.read", 100, vec![])).expect("send");
    assert!(app.closed(), "the app's connection stayed open after a read it did not ack");
    assert!(app.got.iter().any(|m| m.get("code").and_then(Value::as_str) == Some("unknown-type")), "{:?}", app.got.iter().map(Value::to_json).collect::<Vec<_>>());

    // A relay: it acked `screen`, and opened a tool stream, so it is a relay
    // for the rest of its life and reads no screen.
    let mut app = App::connect(&held.0, &["core", "local", "mcp"]);
    let id = app.id();
    let attached = app.call(msg("term.attach", id, vec![("from", Value::uint(0))]));
    assert_eq!(t_of(&attached), "term.attached", "{}", attached.to_json());
    let mut relay = App::connect(&held.0, &["core", "mcp", "screen"]);
    let id = relay.id();
    let answer = relay.call(msg("screen.read", id, vec![]));
    assert_eq!(t_of(&answer), "screen.rows", "before it opens a stream it may read: {}", answer.to_json());
    relay.client.send(Value::obj(vec![("t", Value::str("mcp.open")), ("stream", Value::uint(1))])).expect("open a stream");
    let until = Instant::now() + WAIT;
    loop {
        let m = app.read(until).expect("the app was never told of the stream");
        if t_of(&m) == "mcp.open" {
            break;
        }
    }
    relay.client.send(msg("screen.tail", 4, vec![("count", Value::uint(1))])).expect("send");
    let answer = relay.read(Instant::now() + WAIT).expect("an answer");
    assert_eq!(answer.get("code").and_then(Value::as_str), Some("unknown-type"), "{}", answer.to_json());
    assert!(relay.closed(), "a relay stayed open after a screen read");
}

#[test]
fn a_resize_resizes_the_holders_screen() {
    let _serial = one_at_a_time();
    let store_dir = Folder::new("store-resize");
    let work = Folder::new("work-resize");
    let sid = "screen-resize-01";
    let held = Held(hold(&store_dir, sid));
    let mut app = App::connect(&held.0, &["core", "local", "screen"]);
    launch_and_attach(&mut app, &work, 100, 20);
    for (cols, rows) in [(80u64, 10u64), (120, 30)] {
        let id = app.id();
        let resized = app.call(msg("term.resize", id, vec![("cols", Value::uint(cols)), ("rows", Value::uint(rows))]));
        assert_eq!(t_of(&resized), "term.resized", "{}", resized.to_json());
        let id = app.id();
        let answer = app.call(msg("screen.read", id, vec![]));
        assert_eq!((num(&answer, "cols"), num(&answer, "rows")), (cols, rows), "{}", answer.to_json());
        assert_eq!(rows_text(&answer).len() as u64, rows);
    }
}
