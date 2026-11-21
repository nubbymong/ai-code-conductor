//! The session's screen, kept by its holder (plan 2.1.3-beta.12 section A3,
//! aicc_planning#342; ADR-030 D1: the holder keeps the PTY, the output and
//! the screen).
//!
//! Every byte of the session's output goes to the ring first, then here
//! (`holder.rs`), for the session's whole life, attached or not. The screen
//! is the `vt100` crate's terminal at the session's size with 200 lines of
//! scrollback, read the way the app's readers read xterm.js: a row as
//! `readXtermScreen` (in src/shared) returns it and a tail line
//! as the Watchdog's pane gives it (`translateToString(true)`). Two read-only
//! requests answer from it (`serve.rs`, capability `screen`). Nothing here
//! decides anything from what a screen shows (ADR-030 row 4).
//!
//! The bound. The parse runs on the thread that carries the session's
//! output, so no output may make it slow or large:
//!  - a CSI parameter above 9999 reaches the parser as 9999, as main cuts it
//!    for its panes (src/main/watchdog/watchdog-manager.ts, `clampAnsiChunk`).
//!    A repeat (`CSI n b`), the one sequence whose work grows with its
//!    parameter, then writes at most 9999 cells; every other sequence's work
//!    is bounded by the screen's size, at most 1000 by 1000 cells
//!    (`request::MAX_TERM_CELLS`);
//!  - the crate is built without its `std` feature (helper/Cargo.toml), so its
//!    parser keeps an OSC string in a 1 KiB buffer and drops the rest, where
//!    with `std` it keeps the whole string; DCS, SOS, PM and APC strings are
//!    not kept at all. So no output makes the screen hold more than its cells.
//!
//! Widths: the crate counts a character's cells by current Unicode, and
//! xterm.js 6.0.0 by Unicode 6, so a row with a character the two count
//! differently can differ (helper/tests/screen.rs names each such row of the
//! corpus). Neither gives way in 2.1.3-beta.12 (plan, Questions, 3).

use crate::pty::PtySize;
use std::num::NonZeroU16;

/// Lines of scrollback the screen keeps: the Watchdog pane's 200.
pub const SCROLLBACK_LINES: usize = 200;
/// The most lines `screen.tail` gives: the Watchdog's tail.
pub const TAIL_MAX: usize = 200;
/// The largest CSI parameter that reaches the parser: main's ceiling.
pub const PARAM_CEILING: u32 = 9999;

/// One row as the app's readers take it (`ScreenLine`): its text, the same
/// with every dim cell a space, the same with every cell that is not inverse a
/// space (each trimmed of trailing white space), the row's width in cells, and
/// the cell just past its last one that is not blank.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub text: String,
    pub typed: String,
    pub inverse: String,
    pub width: u16,
    pub end: u16,
}

/// One line of the tail as the Watchdog's pane gives it: its text up to its
/// last cell that holds a character (`translateToString(true)`), and the
/// same cells with every dim one a space, trimmed of trailing white space.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailLine {
    pub text: String,
    pub typed: String,
}

/// The program's terminal modes as the crate keeps them, each read with its
/// own accessor (named in the comment). Fixed words and yes or no values,
/// never bytes to pass on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Modes {
    /// `Screen::alternate_screen`: the alternate screen is in use.
    pub alternate: bool,
    /// `Screen::bracketed_paste`.
    pub bracketed_paste: bool,
    /// `Screen::application_cursor`: application cursor keys.
    pub application_cursor: bool,
    /// `Screen::application_keypad`.
    pub application_keypad: bool,
    /// `Screen::mouse_protocol_mode`, as `mouse_word` names it.
    pub mouse: &'static str,
    /// `Screen::mouse_protocol_encoding`, as `encoding_word` names it.
    pub mouse_encoding: &'static str,
    /// `Screen::hide_cursor`.
    pub cursor_hidden: bool,
}

impl Modes {
    /// The screen in use, as a word: `normal` or `alternate`.
    pub fn screen_word(&self) -> &'static str {
        if self.alternate {
            "alternate"
        } else {
            "normal"
        }
    }
}

/// The words for the screen in use.
pub const SCREEN_WORDS: [&str; 2] = ["normal", "alternate"];
/// The words for the mouse reporting mode.
pub const MOUSE_WORDS: [&str; 5] = ["none", "press", "press-release", "button-motion", "any-motion"];
/// The words for the mouse reporting encoding.
pub const ENCODING_WORDS: [&str; 3] = ["default", "utf8", "sgr"];

/// The mouse reporting mode's word. Every mode the crate has is named here,
/// so a crate that adds one does not build until it has a word.
pub fn mouse_word(mode: vt100::MouseProtocolMode) -> &'static str {
    match mode {
        vt100::MouseProtocolMode::None => MOUSE_WORDS[0],
        vt100::MouseProtocolMode::Press => MOUSE_WORDS[1],
        vt100::MouseProtocolMode::PressRelease => MOUSE_WORDS[2],
        vt100::MouseProtocolMode::ButtonMotion => MOUSE_WORDS[3],
        vt100::MouseProtocolMode::AnyMotion => MOUSE_WORDS[4],
    }
}

/// The mouse reporting encoding's word, as `mouse_word`.
pub fn encoding_word(encoding: vt100::MouseProtocolEncoding) -> &'static str {
    match encoding {
        vt100::MouseProtocolEncoding::Default => ENCODING_WORDS[0],
        vt100::MouseProtocolEncoding::Utf8 => ENCODING_WORDS[1],
        vt100::MouseProtocolEncoding::Sgr => ENCODING_WORDS[2],
    }
}

/// What `screen.read` answers: the size, the cursor's cell (its column is
/// `cols` while a wrap is pending after the last cell was written), every row
/// from the top, and the modes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Read {
    pub cols: u16,
    pub rows: u16,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub lines: Vec<Line>,
    pub modes: Modes,
}

/// A session's screen.
pub struct Screen {
    parser: vt100::Parser,
    clamp: Clamp,
}

/// A size as the crate takes it: rows, then columns, neither 0.
fn dims(size: PtySize) -> (NonZeroU16, NonZeroU16) {
    (NonZeroU16::new(size.rows).unwrap_or(NonZeroU16::MIN), NonZeroU16::new(size.cols).unwrap_or(NonZeroU16::MIN))
}

/// White space as JavaScript's `\s` and `trim` know it, so a row is trimmed
/// as the app's readers trim it.
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// `s` with its trailing white space (as JavaScript knows it) dropped.
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(js_space)
}

/// True when `s` is empty or only white space, as `s.trim() === ''` is.
pub fn js_blank(s: &str) -> bool {
    s.chars().all(js_space)
}

/// `n` spaces: a blanked cell is as many spaces as its text has UTF-16
/// units, as `' '.repeat(ch.length)` gives in the readers.
fn spaces(out: &mut String, of: &str) {
    for _ in 0..of.encode_utf16().count() {
        out.push(' ');
    }
}

/// The visible row `row` of `screen` as `readXtermScreen` reads a row.
fn row_line(screen: &vt100::Screen, row: u16, cols: u16) -> Line {
    let (mut text, mut typed, mut inverse) = (String::new(), String::new(), String::new());
    let mut end = 0u16;
    for col in 0..cols {
        let cell = match screen.cell(row, col) {
            Some(c) => c,
            None => break,
        };
        // The second half of a wide character.
        if cell.is_wide_continuation() {
            continue;
        }
        let ch = if cell.has_contents() { cell.contents() } else { " " };
        text.push_str(ch);
        if cell.dim() {
            spaces(&mut typed, ch);
        } else {
            typed.push_str(ch);
        }
        if cell.inverse() {
            inverse.push_str(ch);
        } else {
            spaces(&mut inverse, ch);
        }
        if !js_blank(ch) {
            end = col + if cell.is_wide() { 2 } else { 1 };
        }
    }
    Line { text: js_trim_end(&text).to_string(), typed: js_trim_end(&typed).to_string(), inverse: js_trim_end(&inverse).to_string(), width: cols, end }
}

/// The visible row `row` of `screen` as a tail line: its cells up to the last
/// one that holds a character (an erased cell holds none; a written space
/// does), an empty cell as a space, as `translateToString(true)` gives it.
fn tail_line(screen: &vt100::Screen, row: u16, cols: u16) -> TailLine {
    let mut last = 0u16;
    for col in 0..cols {
        match screen.cell(row, col) {
            Some(cell) if cell.has_contents() => last = col + if cell.is_wide() { 2 } else { 1 },
            Some(_) => {}
            None => break,
        }
    }
    let (mut text, mut typed) = (String::new(), String::new());
    for col in 0..cols {
        let cell = match screen.cell(row, col) {
            Some(c) => c,
            None => break,
        };
        if cell.is_wide_continuation() {
            continue;
        }
        let ch = if cell.has_contents() { cell.contents() } else { " " };
        if col < last {
            text.push_str(ch);
        }
        if cell.dim() {
            spaces(&mut typed, ch);
        } else {
            typed.push_str(ch);
        }
    }
    TailLine { text, typed: js_trim_end(&typed).to_string() }
}

impl Screen {
    /// A blank screen of `size` with `SCROLLBACK_LINES` of scrollback.
    pub fn new(size: PtySize) -> Screen {
        let (rows, cols) = dims(size);
        Screen { parser: vt100::Parser::new(rows, cols, SCROLLBACK_LINES), clamp: Clamp::default() }
    }

    /// Feed the session's output, in the order it came; a chunk may end
    /// anywhere, inside a character or a sequence.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
    }

    /// The session's terminal changed size.
    pub fn resize(&mut self, size: PtySize) {
        let (rows, cols) = dims(size);
        self.parser.set_size(rows, cols);
    }

    /// The size: columns and rows.
    pub fn size(&self) -> PtySize {
        let (rows, cols) = self.parser.screen().size();
        PtySize { cols: cols.get(), rows: rows.get() }
    }

    /// The modes, each from its own accessor.
    pub fn modes(&self) -> Modes {
        let s = self.parser.screen();
        Modes {
            alternate: s.alternate_screen(),
            bracketed_paste: s.bracketed_paste(),
            application_cursor: s.application_cursor(),
            application_keypad: s.application_keypad(),
            mouse: mouse_word(s.mouse_protocol_mode()),
            mouse_encoding: encoding_word(s.mouse_protocol_encoding()),
            cursor_hidden: s.hide_cursor(),
        }
    }

    /// The screen now: its size, the cursor, every row from the top of the
    /// screen in use (below any scrollback), and the modes.
    pub fn read(&self) -> Read {
        let s = self.parser.screen();
        let PtySize { cols, rows } = self.size();
        let (cursor_row, cursor_col) = s.cursor_position();
        let lines = (0..rows).map(|r| row_line(s, r, cols)).collect();
        Read { cols, rows, cursor_row, cursor_col, lines, modes: self.modes() }
    }

    /// The last `count` lines, oldest first: scrollback, then the screen in
    /// use (the alternate screen has none). At most `TAIL_MAX`; fewer when
    /// fewer are held. The crate shows scrollback only by scrolling its view,
    /// so the view is scrolled, read and put back before this returns.
    pub fn tail(&mut self, count: usize) -> Vec<TailLine> {
        let count = count.min(TAIL_MAX);
        let PtySize { cols, rows } = self.size();
        let rows_n = usize::from(rows);
        let screen = self.parser.screen_mut();
        let held = screen.scrollback_len();
        let total = held + rows_n;
        let first = total.saturating_sub(count);
        let mut out = Vec::with_capacity(total - first);
        // Scrollback line i is the top visible row with the view scrolled
        // back by `held - i`; each scroll shows up to `rows` of them.
        let mut i = first;
        while i < held {
            let back = held - i;
            screen.set_scrollback(back);
            let shown = back.min(rows_n);
            for r in 0..shown {
                out.push(tail_line(screen, r as u16, cols));
            }
            i += shown;
        }
        screen.set_scrollback(0);
        for r in first.saturating_sub(held)..rows_n {
            out.push(tail_line(screen, r as u16, cols));
        }
        out
    }
}

/// Where the clamp is in the output, as the parser would be: plain text (or
/// a string the parser keeps or skips, which only an ESC ends as far as a CSI
/// goes), just after ESC, in a CSI's parameters (`entry`: nothing of them
/// read yet, so a private marker may come), or in the part of a CSI whose
/// digits the parser no longer reads.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Lex {
    #[default]
    Text,
    Esc,
    Params {
        entry: bool,
    },
    Ignored,
}

/// Cuts every numeric parameter of a CSI sequence to `PARAM_CEILING` on its
/// way to the parser, by value, so the result is the same however the output
/// is split into chunks. It follows the parser's own rules for where a CSI
/// begins and ends (vte 0.15.0): ESC `[` begins one; a final byte, CAN, SUB
/// or ESC ends it; a C0 control inside it is carried out where it stands and
/// the parameter goes on. A parameter's digits are held until it ends, then
/// written as its value (leading zeros dropped, which the parser reads the
/// same), so nothing but the value of a parameter above the ceiling changes.
/// A C0 control, DEL or a byte from 0x80 inside a held parameter is passed on
/// at once: the parser carries out or ignores it the same before or after
/// the digits.
#[derive(Debug, Default)]
struct Clamp {
    lex: Lex,
    /// The parameter being read: its value so far, whether it has a digit,
    /// and whether its value passed the ceiling.
    value: u32,
    digits: bool,
    over: bool,
}

impl Clamp {
    /// Write the parameter being read, if it has digits, and start the next.
    fn flush(&mut self, out: &mut Vec<u8>) {
        if self.digits {
            let v = if self.over { PARAM_CEILING } else { self.value };
            out.extend_from_slice(v.to_string().as_bytes());
        }
        self.value = 0;
        self.digits = false;
        self.over = false;
    }

    /// `bytes`, clamped, for the parser.
    fn pass(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(bytes.len());
        for &b in bytes {
            match self.lex {
                Lex::Text => {
                    out.push(b);
                    if b == 0x1b {
                        self.lex = Lex::Esc;
                    }
                }
                Lex::Esc => {
                    out.push(b);
                    self.lex = match b {
                        b'[' => Lex::Params { entry: true },
                        0x1b => Lex::Esc,
                        // CAN and SUB end the sequence.
                        0x18 | 0x1a => Lex::Text,
                        // Carried out or ignored, and ESC still stands.
                        0x00..=0x17 | 0x19 | 0x1c..=0x1f | 0x7f..=0xff => Lex::Esc,
                        // An intermediate, a final byte, or the start of a
                        // string: no CSI before the next ESC.
                        _ => Lex::Text,
                    };
                }
                Lex::Params { entry } => match b {
                    b'0'..=b'9' => {
                        if !self.over {
                            let v = self.value * 10 + u32::from(b - b'0');
                            if v > PARAM_CEILING {
                                self.over = true;
                            } else {
                                self.value = v;
                            }
                        }
                        self.digits = true;
                        self.lex = Lex::Params { entry: false };
                    }
                    b':' | b';' => {
                        self.flush(&mut out);
                        out.push(b);
                        self.lex = Lex::Params { entry: false };
                    }
                    // A private marker, first after ESC [: parameters follow.
                    0x3c..=0x3f if entry => {
                        out.push(b);
                        self.lex = Lex::Params { entry: false };
                    }
                    // A marker later, or an intermediate: the parser reads
                    // no more parameters of this sequence.
                    0x3c..=0x3f | 0x20..=0x2f => {
                        self.flush(&mut out);
                        out.push(b);
                        self.lex = Lex::Ignored;
                    }
                    0x40..=0x7e | 0x18 | 0x1a => {
                        self.flush(&mut out);
                        out.push(b);
                        self.lex = Lex::Text;
                    }
                    0x1b => {
                        self.flush(&mut out);
                        out.push(b);
                        self.lex = Lex::Esc;
                    }
                    // A C0 control, DEL, or a byte from 0x80: at once.
                    _ => out.push(b),
                },
                Lex::Ignored => {
                    out.push(b);
                    self.lex = match b {
                        0x40..=0x7e | 0x18 | 0x1a => Lex::Text,
                        0x1b => Lex::Esc,
                        _ => Lex::Ignored,
                    };
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clamped(input: &[u8]) -> Vec<u8> {
        Clamp::default().pass(input)
    }

    /// The same bytes a byte at a time.
    fn dripped(input: &[u8]) -> Vec<u8> {
        let mut c = Clamp::default();
        let mut out = Vec::new();
        for b in input {
            out.extend(c.pass(std::slice::from_ref(b)));
        }
        out
    }

    #[test]
    fn a_parameter_above_the_ceiling_is_cut_to_it_and_nothing_else_changes() {
        let cases: [(&[u8], &[u8]); 12] = [
            (b"plain 123456789 text", b"plain 123456789 text"),
            (b"\x1b[38;2;255;100;0mred\x1b[m", b"\x1b[38;2;255;100;0mred\x1b[m"),
            (b"\x1b[?2004h\x1b[?1049h\x1b[?9001h", b"\x1b[?2004h\x1b[?1049h\x1b[?9001h"),
            (b"x\x1b[99999999999b", b"x\x1b[9999b"),
            (b"\x1b[9999b\x1b[10000b", b"\x1b[9999b\x1b[9999b"),
            // Leading zeros go: the parser reads the same value.
            (b"\x1b[0005;0;00H", b"\x1b[5;0;0H"),
            (b"\x1b[4:3m\x1b[58:2::1:2:3m", b"\x1b[4:3m\x1b[58:2::1:2:3m"),
            // A C0 control inside a parameter is carried out where it stands,
            // and the parameter goes on: it comes before the held digits.
            (b"\x1b[12\n34567b", b"\x1b[\n9999b"),
            // After an intermediate the parser reads no more parameters.
            (b"\x1b[1$123456p", b"\x1b[1$123456p"),
            // CAN ends the sequence; the digits after it are text.
            (b"\x1b[123\x18456789", b"\x1b[123\x18456789"),
            // ESC after ESC still begins a CSI; ESC ( [ does not.
            (b"\x1b\x1b[77777C\x1b([77777", b"\x1b\x1b[9999C\x1b([77777"),
            // A string ends at ESC, which may begin a CSI.
            (b"\x1b]0;99999\x07\x1b]0;t\x1b\\\x1b[123456A", b"\x1b]0;99999\x07\x1b]0;t\x1b\\\x1b[9999A"),
        ];
        for (input, want) in cases {
            assert_eq!(clamped(input), want, "{:?}", String::from_utf8_lossy(input));
            assert_eq!(dripped(input), want, "a byte at a time: {:?}", String::from_utf8_lossy(input));
        }
    }

    #[test]
    fn a_parameter_split_across_chunks_is_held_until_it_ends() {
        let mut c = Clamp::default();
        assert_eq!(c.pass(b"x\x1b[12"), b"x\x1b[");
        assert_eq!(c.pass(b"345"), b"");
        assert_eq!(c.pass(b"67b!"), b"9999b!");
        assert_eq!(c.lex, Lex::Text);
    }

    #[test]
    fn rows_are_trimmed_as_javascript_trims_them() {
        assert_eq!(js_trim_end("a b \u{a0}\u{3000}\t"), "a b");
        assert_eq!(js_trim_end("a\u{feff}"), "a");
        // U+0085 is white space to Rust, not to JavaScript.
        assert_eq!(js_trim_end("a\u{85}"), "a\u{85}");
        assert!(js_blank("") && js_blank(" \u{2003}") && !js_blank("\u{85}"));
    }

    #[test]
    fn a_dim_or_inverse_cell_is_blanked_by_its_utf16_length() {
        let mut s = Screen::new(PtySize { cols: 10, rows: 2 });
        s.feed("a\x1b[2m\u{1f600}b\x1b[22;7mc\x1b[m d   ".as_bytes());
        let row = &s.read().lines[0];
        assert_eq!(row.text, "a\u{1f600}bc d");
        assert_eq!(row.typed, "a   c d");
        assert_eq!(row.inverse, "    c");
        assert_eq!((row.width, row.end), (10, 7));
        // The tail keeps written spaces, and blanks dim cells as the row does.
        let tail = s.tail(2);
        assert_eq!(tail[0], TailLine { text: "a\u{1f600}bc d   ".to_string(), typed: "a   c d".to_string() });
        assert_eq!(tail[1], TailLine { text: String::new(), typed: String::new() });
    }

    #[test]
    fn every_mode_word_is_one_of_the_fixed_words() {
        let m = Screen::new(PtySize::default()).modes();
        assert_eq!((m.screen_word(), m.mouse, m.mouse_encoding), ("normal", "none", "default"));
        assert!(!m.bracketed_paste && !m.application_cursor && !m.application_keypad && !m.cursor_hidden);
        assert_eq!(Modes { alternate: true, ..m }.screen_word(), "alternate");
        for mode in [vt100::MouseProtocolMode::None, vt100::MouseProtocolMode::Press, vt100::MouseProtocolMode::PressRelease, vt100::MouseProtocolMode::ButtonMotion, vt100::MouseProtocolMode::AnyMotion] {
            assert!(MOUSE_WORDS.contains(&mouse_word(mode)));
        }
        for encoding in [vt100::MouseProtocolEncoding::Default, vt100::MouseProtocolEncoding::Utf8, vt100::MouseProtocolEncoding::Sgr] {
            assert!(ENCODING_WORDS.contains(&encoding_word(encoding)));
        }
        assert_eq!(SCREEN_WORDS, ["normal", "alternate"]);
    }
}
