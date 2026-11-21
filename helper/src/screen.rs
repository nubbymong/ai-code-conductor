//! The session's screen, kept by its holder (plan 2.1.3-beta.12 section A3,
//! aicc_planning#342).
//!
//! The shape of the change and nothing behind it, so the tests that come
//! with it build and can be seen red before the change: a blank screen of
//! the launch's size that output never reaches, a resize never changes and
//! whose modes are never set.

use crate::pty::PtySize;

/// Lines of scrollback the screen keeps: the Watchdog pane's 200.
pub const SCROLLBACK_LINES: usize = 200;
/// The most lines `screen.tail` gives: the Watchdog's tail.
pub const TAIL_MAX: usize = 200;
/// The largest CSI parameter that reaches the parser: main's ceiling.
pub const PARAM_CEILING: u32 = 9999;

/// One row as the app's readers take it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub text: String,
    pub typed: String,
    pub inverse: String,
    pub width: u16,
    pub end: u16,
}

/// One line of the tail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailLine {
    pub text: String,
    pub typed: String,
}

/// The program's terminal modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Modes {
    pub alternate: bool,
    pub bracketed_paste: bool,
    pub application_cursor: bool,
    pub application_keypad: bool,
    pub mouse: &'static str,
    pub mouse_encoding: &'static str,
    pub cursor_hidden: bool,
}

impl Modes {
    /// The screen in use, as a word.
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

/// What `screen.read` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Read {
    pub cols: u16,
    pub rows: u16,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub lines: Vec<Line>,
    pub modes: Modes,
}

/// `s` with its trailing white space dropped.
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end()
}

/// True when `s` is empty or only white space.
pub fn js_blank(s: &str) -> bool {
    s.trim().is_empty()
}

/// A session's screen.
pub struct Screen {
    size: PtySize,
}

impl Screen {
    pub fn new(size: PtySize) -> Screen {
        Screen { size }
    }

    pub fn feed(&mut self, _bytes: &[u8]) {}

    pub fn resize(&mut self, _size: PtySize) {}

    pub fn size(&self) -> PtySize {
        self.size
    }

    pub fn modes(&self) -> Modes {
        Modes { alternate: false, bracketed_paste: false, application_cursor: false, application_keypad: false, mouse: MOUSE_WORDS[0], mouse_encoding: ENCODING_WORDS[0], cursor_hidden: false }
    }

    pub fn read(&self) -> Read {
        let blank = Line { text: String::new(), typed: String::new(), inverse: String::new(), width: self.size.cols, end: 0 };
        Read { cols: self.size.cols, rows: self.size.rows, cursor_row: 0, cursor_col: 0, lines: vec![blank; usize::from(self.size.rows)], modes: self.modes() }
    }

    pub fn tail(&mut self, _count: usize) -> Vec<TailLine> {
        Vec::new()
    }
}
