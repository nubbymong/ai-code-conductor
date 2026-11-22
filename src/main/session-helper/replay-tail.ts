/**
 * How much of a replay a tab is shown after the line saying earlier output is
 * not shown, so that the line stays within the tab's scrollback (2.1.3-beta.12,
 * plan section A1; helper-pty.ts, showHeld). A holder replays up to 2 MiB:
 * that is some 28,000 lines of plain text, and a tab keeps
 * TERMINAL_SCROLLBACK_LINES.
 *
 * The replay is read the way the tab's terminal (xterm.js 6) reads it, as far
 * as rows go: its parser's states (an escape sequence, an OSC, DCS, SOS, PM or
 * APC string, the 8-bit forms, CAN and SUB; a character past U+009F ends a
 * SOS, PM or APC string, or a DCS one before its final byte, in error, and
 * what follows is text, but not a DCS string the tab ignores to its end), its
 * Unicode 6 widths (the tab loads no Unicode 11 addon), and its cursor. A row
 * is added by a line feed, vertical tab, form feed, index or next line (ESC D,
 * ESC E, and the 8-bit forms), and by a wrap: a character that does not fit
 * the row, a wide one at the last column too. A bare line feed keeps the
 * column, as in the tab. The column follows the carriage return, backspace,
 * tab, the cursor moves that set it (CSI C, D, E, F, G, H, f, `, a, I, Z), the
 * repeat (CSI b) and a cursor saved and restored. A parameter's sub-parameters
 * (after a colon) belong to it, as in the tab. A cursor moved up or down only
 * moves on the screen and adds no row to the scrollback, so it is not counted.
 * The alternate screen has no scrollback: what a program writes there
 * adds no row, and the cut never lands in it.
 *
 * Given the tab's rows as well (2.1.3-beta.13, plan section A2,
 * aicc_planning#374; helper-pty.ts gives them only when the tab is at the size
 * its holder's output was made for), the cursor's row is followed too: how
 * many rows it is above the screen's last row, from 0 to the rows less one,
 * and never more than it really is (it starts at 0). A line feed or a wrap
 * then adds a row only at the last row. A Windows console writes a wrapped
 * line with a jump back to the row above, so without its row followed such a
 * line counts 5 rows where the tab shows 3. A cursor moved up (CSI A and F,
 * ESC M) raises it, one moved down (CSI B, E and e) lowers it, one put on a row
 * (CSI H, f and d) sets it, and a cursor saved and restored (on each screen)
 * carries it (the tab puts it back on the row it was saved on, or higher once
 * the screen scrolled); a full reset puts it, and its saved place, at the top
 * row. A scroll region that is not the whole screen, on the screen in use,
 * stops the row being followed: there every line feed and wrap adds a row, as
 * with no rows given, and the cursor is taken to be at the last row. The 8-bit
 * reverse index (0x8d) is not followed: xterm.js 6.0.0 ignores it. A line feed
 * that adds no row still starts a line, on no new row. A line feed that adds a
 * row and is followed by a cursor moved up before anything is printed starts
 * no line: the console went back to the line before (the wrapped line above),
 * and the row is that line's. So a row the cut can land at always has the
 * cursor at the last row, and a cut at a line's start does not land in the
 * middle of a console's wrapped line (helper-pty.ts starts what it shows on
 * the last row).
 *
 * Where this differs from the tab
 * it counts more rows, not fewer (combining characters and the emoji blocks
 * count a column or two, an autowrap turned off is ignored), with five known
 * exceptions. A program's own tab stops (HTS, TBC) are not followed, so a tab
 * after it cleared them may go further than counted, at most a row a line.
 * With reverse wraparound set (mode 45), a backspace at a row's end leaves the
 * tab on the last column while the count goes one further back, so the tab
 * wraps a character sooner: at most a row each time. A repeat (CSI b) that
 * follows a sequence the tab ignores or ends in error, or an 8-bit CSI, string
 * introducer or ST, is not counted: the tab still repeats the character
 * printed before it, and here that character is forgotten (or taken as
 * narrower). On the alternate screen, where no row is counted, a column
 * counted further than the tab's (a combining character, an emoji, an
 * autowrap turned off) can wrap there, while the tab wraps only after the
 * program left that screen with mode 47 or 1047, which restore no cursor: at
 * most a row each time. And with the rows given, a column counted further
 * than the tab's (those three, or a line inserted or deleted, which puts the
 * tab at the row's start) can wrap above the last row, where a wrap adds no
 * row, before the tab does; a cursor then put on a row, or held at the top or
 * the last row, with its column kept (CSI d; CSI A, B, e or ESC M at the
 * edge) is counted on the tab's row again, and the tab's own wrap after it is
 * missed: at most a row each time. No program is known to write such a
 * repeat, to leave that screen so and write on without setting the column
 * first, or to keep the column across such a move and write on past the
 * row's end.
 *
 * The cut is at the start of a row the text took, never inside an escape
 * sequence or a character: at the start of a line, unless the line there alone
 * takes as many rows as the budget or more, or only empty rows follow it, which
 * is then cut inside, at the start of one of its rows, so the tab is never
 * shown only the notice while there is output to show.
 *
 * Given the rows and a `gap` as well (2.1.3-beta.13, plan section A4,
 * aicc_planning#382; helper-pty.ts then writes the notice on the row above the
 * tab's last row, with `gap` empty rows above it), it also answers where the
 * tab's scrollback may be cleared (`clear`). What is shown is read again from
 * the cut, as a new tab reads it (the cursor on the last row, nothing saved,
 * no scroll region), and the answer is the start of the newest row a line
 * feed added at most `gap` rows on. There the screen has moved up as many rows
 * as counted, or fewer where the count is over, so what left it is empty rows
 * from above the notice, and a clear of the scrollback (CSI 3 J) drops them
 * and nothing else. Only while those rows stay empty and in place: the reading
 * stops at the cursor on a row above the cut's on the normal screen (a
 * character there, or a line inserted or deleted there, would leave with
 * them); at a scroll region set, the screen filled (ESC # 8), or origin mode
 * set or reset, on either screen (the cursor goes home, where the count does
 * not follow it, and 47 and 1047 bring it back); at the screen moved up or
 * down (CSI S, T) or reset; at a cursor saved on the normal screen (xterm.js
 * counts a saved row from the scrollback's top, so a clear between the save and
 * the restore would move the cursor down); and at a soft reset (CSI ! p) on
 * either screen: it saves the top row of the screen in use as the cursor's
 * place, which on the normal screen is counted the same way, and on the
 * alternate screen is where the count's saved place does not follow it, so a
 * restore there and then 47 or 1047 would bring the cursor back above the cut's
 * row. A row a line feed added before the reading stops is the answer. A row a
 * wrap starts is not taken: it starts at the character that wraps, before the
 * screen moves, so a clear there would leave one empty row above
 * the notice. Such a row start is never inside an escape sequence or a
 * character, and never on the alternate screen. Where the count falls short of
 * the tab's (the exceptions above), the screen has moved further, and a clear
 * there drops the notice's row too, and one kept row more for each further row
 * the count is short.
 *
 * What the left-out part changes in the terminal's state is carried across the
 * cut (`before` and `after`): leaving the alternate screen whenever that part
 * switched it (before the notice, so the notice is on the normal screen; the
 * cut is never on it, so the whole replay is on the normal screen there), and
 * the DEC private modes that are flags only (cursor keys, autowrap, cursor
 * blink and visibility, reverse wrap, the keypad, mouse reporting and its
 * encoding, focus events, bracketed paste), each at its last value, in the
 * order of their last change, a full reset and a soft reset (CSI ! p) setting
 * them as they set the tab's. That is as the whole replay would have left
 * them, but for one thing: after a full reset the cursor is shown again
 * (AFTER_RESET says why). Colours are not carried (the notice resets them),
 * nor the character set or a scroll region.
 *
 * Memory is bounded by the budget, whatever the text: only the row starts that
 * can still be kept are remembered.
 *
 * The same parser reads a take-over's terminal queries (2.1.3-beta.13, plan
 * section A3, aicc_planning#360; replay-queries.ts): a reader of the sequences
 * themselves is told where each starts, where a CSI ends and with what, where
 * a DCS string hooks and where a string ends. Here those hooks do nothing.
 */

/** The parser's states, as far as they matter here (and in replay-queries.ts). */
const GROUND = 0
export const ESC = 1
/** After ESC and one or more intermediate bytes (0x20-0x2f). */
const ESC_MORE = 2
export const CSI = 3
/** A CSI that went wrong (a prefix byte after a parameter): read to its end, then nothing done. */
const CSI_IGNORE = 4
/** An OSC string: BEL, ST, CAN or SUB ends it. */
export const OSC = 5
/**
 * A DCS string, or an SOS, PM or APC one: ST, CAN or SUB ends it, and the C0 controls in it do nothing. As in
 * xterm.js, a character past U+009F ends it in error, except in a DCS string past its final byte, or one the tab
 * ignores to its end.
 */
export const STRING = 6

/** The DEC private modes carried across the cut: flags, with no effect on the cursor or on what the screen shows. */
const CARRIED_MODES = new Set([1, 7, 12, 25, 45, 66, 9, 1000, 1002, 1003, 1004, 1006, 1016, 2004])
/** The modes that switch to the alternate screen and back. */
const ALTERNATE_SCREEN = new Set([47, 1047, 1049])
/** What a full reset (ESC c) leaves the carried modes at. The cursor blink (12) is the tab's own setting and stays. The cursor is shown again (25) on purpose: xterm.js 6.0.0 leaves a hidden cursor hidden after a full reset, and a shell should not be left without one. */
const AFTER_RESET: ReadonlyArray<readonly [number, boolean]> = [
  [1, false], [7, true], [25, true], [45, false], [66, false], [1000, false], [1004, false], [1006, false], [2004, false],
]
/** What a soft reset (CSI ! p) leaves the carried modes at, as xterm.js 6.0.0 does: a full reset's, but the mouse modes stay. Here xterm.js itself shows the cursor again. */
const AFTER_SOFT_RESET: ReadonlyArray<readonly [number, boolean]> = [
  [1, false], [7, true], [25, true], [45, false], [66, false], [1004, false], [2004, false],
]
/** As xterm.js: at most 32 parameters, each at most 2^31 - 1. */
const PARAMS_MAX = 32
const PARAM_MAX = 0x7fffffff

/** The columns xterm.js's Unicode 6 table gives a character, with the two emoji blocks two as well (wider than the tab). */
export function columns(cp: number): 1 | 2 {
  if (cp < 0x1100) return 1
  return cp <= 0x115f || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe19)
    || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)
    ? 2
    : 1
}

/** The start of each row the text took, the newest `budget` of them (a ring). */
class RowStarts {
  private readonly cap: number
  private readonly index: Int32Array
  private readonly row: Int32Array
  /** The row its line started on: the same as `row` for a line's start. */
  private readonly lineRow: Int32Array
  /** How many lines came before its line. */
  private readonly lineNo: Int32Array
  private head = 0
  private size = 0

  constructor(private readonly budget: number) {
    this.cap = budget + 1
    this.index = new Int32Array(this.cap)
    this.row = new Int32Array(this.cap)
    this.lineRow = new Int32Array(this.cap)
    this.lineNo = new Int32Array(this.cap)
  }

  /** A row starts at `index`; rows older than the last `budget` are let go of. */
  add(index: number, row: number, lineRow: number, lineNo: number): void {
    while (this.size > 0 && this.row[this.head] < row + 1 - this.budget) {
      this.head = (this.head + 1) % this.cap
      this.size--
    }
    const at = (this.head + this.size) % this.cap
    this.index[at] = index
    this.row[at] = row
    this.lineRow[at] = lineRow
    this.lineNo[at] = lineNo
    this.size++
  }

  /** The newest row's line, told again: it started no line after all (Reader.demote). */
  relabel(lineRow: number, lineNo: number): void {
    if (this.size === 0) return
    const at = (this.head + this.size - 1) % this.cap
    this.lineRow[at] = lineRow
    this.lineNo[at] = lineNo
  }

  /** Where to cut, with the text's last row `last` and the row of its last character printed `text`. */
  cut(last: number, text: number): { from: number; left: number; part: boolean } {
    const target = last + 1 - this.budget
    const at = (k: number) => (this.head + k) % this.cap
    let k = 0
    while (k < this.size - 1 && this.row[at(k)] < target) k++
    const e = at(k)
    if (this.row[e] === this.lineRow[e]) return { from: this.index[e], left: this.lineNo[e], part: false }
    // Inside a line: from the next line's start, unless this line alone takes as many rows as the budget or more
    // (with the next line's own row it would not fit, and the tab would be shown that next line alone), or nothing
    // is printed from the next line's start on (the tab would be shown only empty rows).
    for (let j = k + 1; j < this.size; j++) {
      const n = at(j)
      if (this.row[n] !== this.lineRow[n]) continue
      if (this.row[n] - this.lineRow[e] >= this.budget || this.row[n] > text) break
      return { from: this.index[n], left: this.lineNo[n], part: false }
    }
    return { from: this.index[e], left: this.lineNo[e], part: true }
  }
}

/**
 * What a reading from the cut looks for (replayTail's `clear`): the newest row a line feed added, at most `gap` rows
 * on, before anything that could put a character above the row the cut starts or move the rows above it.
 */
interface ClearWatch {
  gap: number
  clear: number | undefined
  /** Something could have changed the rows above the cut's row: no clear from here on. */
  stop: boolean
}

/** A terminal `cols` wide reading text, rows and modes only. */
export class Reader {
  /** Rows the text moved down on the normal screen, by line feeds and wraps (with the rows given, at the last row). */
  row = 0
  private readonly width: number
  private readonly starts: RowStarts | undefined
  private col = 0
  /** The column ESC 7 (and its kin) saved: on the normal screen, and on the alternate one. */
  private saved = [0, 0]
  private alt = false
  /** The width of the character just printed, for CSI b; 0 once anything else came. */
  private last = 0
  private lineRow = 0
  private lines = 0
  /** The row the line before the newest one started on: what `lineRow` goes back to when a line start is taken back (demote). */
  private prevLineRow = 0
  /** The row of the last character printed on the normal screen; -1 before any. */
  private textRow = -1
  /** The tab's rows, when given: then the cursor's row is followed too. */
  private readonly height: number | undefined
  /** How many rows the cursor is above the screen's last row: never more than it really is, so never a row too few. */
  private up = 0
  /** The same, as saved with the cursor: on the normal screen, and on the alternate one. */
  private savedUp = [0, 0]
  /** A scroll region that is not the whole screen is set (on the normal screen, on the alternate one): every line feed and wrap then counts a row, as with no rows given, and `up` stays 0. */
  private region = [false, false]
  /**
   * With the rows given: the newest row was added by a line feed that started a line, and nothing was printed or
   * added since. A cursor moved up now takes that line start back (demote).
   */
  private fresh = false
  /** A reading from the cut for replayTail's `clear` (clearAfter): what it found so far. */
  private readonly watch: ClearWatch | undefined
  protected state = GROUND
  /** The CSI's or DCS string's prefix byte (? > < =), or 0. */
  protected prefix = 0
  protected params: number[] = []
  private param = 0
  /** A CSI or DCS parameter, prefix or separator byte was read. */
  private any = false
  /** A CSI or DCS intermediate byte was read. */
  private more = false
  /**
   * The CSI's or DCS string's intermediate bytes, as the tab collects them (`$` for DECRQM and DECRQSS; `!` alone for
   * a soft reset). After ESC, only its first intermediate (`#` for ESC # 8).
   */
  protected inter = ''
  /** The CSI's digits go to a sub-parameter (after a colon), until the next semicolon. */
  private sub = false
  /** The string read is a DCS one. */
  protected dcs = false
  /**
   * The DCS string's final byte was read, or a byte the tab ignores the string from (a prefix after a parameter, a
   * parameter after an intermediate): past it, a character past U+009F is its text, not an error.
   */
  protected hooked = false
  /** The carried modes at their last value, in the order of their last change. */
  private readonly modes = new Map<number, boolean>()
  private altFirst: { mode: number; on: boolean } | undefined

  constructor(cols: number, budget?: number, rows?: number, gap?: number) {
    // As xterm.js: a terminal is at least two columns wide.
    this.width = Math.max(2, Math.floor(cols) || 0)
    this.height = rows === undefined ? undefined : Math.max(1, Math.floor(rows) || 1)
    if (budget !== undefined) {
      this.starts = new RowStarts(Math.max(1, Math.floor(budget)))
      this.starts.add(0, 0, 0, 0)
    }
    if (gap !== undefined && this.height !== undefined) {
      this.watch = { gap, clear: undefined, stop: false }
      // A new tab: a cursor restored with none saved goes to the top row, as in xterm.js.
      this.savedUp = [this.height - 1, this.height - 1]
    }
  }

  /** Reads `text` from `from` to `end`: what came before `from` was read already, in this state. */
  read(text: string, end: number, from = 0): void {
    const w = this.watch
    for (let i = from; i < end; i++) {
      // Reading for the clear: done once the gap is passed, or once the cursor was on a row above the cut's on the
      // normal screen (a character there, or a line inserted or deleted there, would leave the screen with the empty
      // rows), or once the rows above it could have moved.
      if (w !== undefined && (w.stop || this.row > w.gap || (!this.alt && this.up > this.row))) break
      const c = text.charCodeAt(i)
      // In any state: ESC starts a sequence, CAN and SUB end one, and the 8-bit controls act as in the tab. ESC
      // ends a string as its end does (the tab acts on it); CAN and SUB cancel it.
      if (c === 0x1b) { this.leave(i, true); this.state = ESC; this.began(i); continue }
      if (c === 0x18 || c === 0x1a) { this.leave(i, false); this.state = GROUND; this.last = 0; continue }
      if (c >= 0x80 && c <= 0x9f) { this.c1(c, i); continue }
      if (c === 0x7f) continue // DEL: nothing, in any state
      switch (this.state) {
        case GROUND:
          if (c < 0x20) this.execute(c, i, true)
          else if (c >= 0xd800 && c <= 0xdbff) {
            const cp = text.codePointAt(i)!
            this.print(i, columns(cp))
            if (cp > 0xffff) i++
          } else this.print(i, columns(c))
          break
        case ESC:
          this.inEscape(c, i)
          break
        case ESC_MORE:
          if (c < 0x20) this.execute(c, i, false)
          else if (c >= 0x30) {
            // A final byte (a character set, say), or a character that ends it in error. ESC # 8 fills the screen and
            // puts the cursor home.
            if (this.inter === '#' && c === 0x38) this.unsettled(true)
            this.state = GROUND
            this.last = 0
          }
          break
        case CSI:
          this.inCsi(c, i)
          break
        case CSI_IGNORE:
          if (c < 0x20) this.execute(c, i, false)
          else if (c >= 0x40 && c <= 0x7e) {
            this.state = GROUND
            this.last = 0
          }
          break
        case OSC:
          if (c === 0x07) { this.leave(i, true); this.state = GROUND }
          break
        case STRING:
          // A string's text, and the C0 controls in it: nothing. A character past U+009F ends it in error, as in
          // the tab, which reads what follows as text; in a DCS string past its final byte, or one the tab ignores to
          // its end, it is the string's text.
          if (c >= 0xa0) { if (!this.hooked) { this.leave(i, false); this.state = GROUND } }
          else if (this.dcs && !this.hooked && c >= 0x20) {
            if (c >= 0x40 || (c >= 0x30 && (this.more || (c >= 0x3c && this.any)))) {
              this.hooked = true
              if (c >= 0x40) this.hook(c)
            } else if (c >= 0x30) {
              // A prefix only as the first byte: one after a parameter is the ignore above.
              if (c >= 0x3c) this.prefix = c
              this.any = true
            } else {
              this.more = true
              this.inter += String.fromCharCode(c)
            }
          }
          break
      }
    }
  }

  private inEscape(c: number, i: number): void {
    if (c < 0x20) this.execute(c, i, false)
    else if (c === 0x5b) this.startCsi()
    else if (c === 0x5d) this.state = OSC
    else if (c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) this.startString(c === 0x50)
    else if (c <= 0x2f) { this.state = ESC_MORE; this.inter = String.fromCharCode(c) }
    else {
      // A final byte; a character past 0x7e ends it in error.
      this.state = GROUND
      if (c <= 0x7e) this.escape(c, i)
    }
  }

  private inCsi(c: number, i: number): void {
    if (c < 0x20) this.execute(c, i, false)
    else if (this.more && c >= 0x30 && c <= 0x3f) this.state = CSI_IGNORE
    else if (c >= 0x30 && c <= 0x39) {
      if (!this.sub) this.param = Math.min(PARAM_MAX, this.param * 10 + c - 0x30)
      this.any = true
    } else if (c === 0x3b) {
      if (this.params.length < PARAMS_MAX) this.params.push(this.param)
      this.param = 0
      this.sub = false
      this.any = true
    } else if (c === 0x3a) {
      // A sub-parameter, as in xterm.js: it belongs to the parameter before it, and is no parameter of its own.
      this.sub = true
      this.any = true
    } else if (c >= 0x3c && c <= 0x3f) {
      // A prefix (? > < =) only as the first byte.
      if (this.any) this.state = CSI_IGNORE
      else {
        this.prefix = c
        this.any = true
      }
    } else if (c <= 0x2f) {
      this.more = true
      this.inter += String.fromCharCode(c)
    } else {
      // A final byte; a character past 0x7e ends it in error. One with intermediates does nothing here, but a soft
      // reset (CSI ! p, with parameters or none, as in xterm.js: `!` the only intermediate, no prefix).
      this.state = GROUND
      if (c <= 0x7e) {
        if (this.params.length < PARAMS_MAX) this.params.push(this.param)
        if (!this.more) this.csi(c)
        else if (c === 0x70 && this.inter === '!' && this.prefix === 0) this.softReset()
        this.csiEnd(c, i)
      }
      this.last = 0
    }
  }

  // ── what a reader of the sequences themselves is told (replay-queries.ts); nothing here ──

  /** A sequence starts at `i`: an ESC, or an 8-bit CSI, OSC, DCS, SOS, PM or APC introducer. */
  protected began(_i: number): void { /* nothing here */ }
  /** The CSI read ends with its final byte, `final`, at `i`, intermediates or not; its prefix, intermediates and parameters are read. */
  protected csiEnd(_final: number, _i: number): void { /* nothing here */ }
  /** The DCS string read reaches its final byte, `final`, where the tab hooks it; its prefix and intermediates are read. Not told for one the tab ignores. */
  protected hook(_final: number): void { /* nothing here */ }
  /** The string read (OSC, DCS, SOS, PM or APC) ends at `i`: `done` when the tab acts on it there (ESC, ST, and BEL for an OSC), not when CAN, SUB, another 8-bit control or an error cuts it short. */
  protected stringEnd(_i: number, _done: boolean): void { /* nothing here */ }

  /** Whatever ends at `i` ends a string being read. */
  private leave(i: number, done: boolean): void {
    if (this.state === OSC || this.state === STRING) this.stringEnd(i, done)
  }

  private startString(dcs: boolean): void {
    this.state = STRING
    this.dcs = dcs
    this.hooked = false
    this.any = false
    this.more = false
    this.prefix = 0
    this.inter = ''
  }

  /** Where to cut (with a budget given). */
  cut(): { from: number; left: number; part: boolean } {
    return this.starts ? this.starts.cut(this.row, this.textRow) : { from: 0, left: 0, part: false }
  }

  /** Read for the clear: where it found the scrollback may be cleared, if anywhere. */
  clearFound(): number | undefined {
    return this.watch?.clear
  }

  /**
   * Read for the clear: the rows above the cut's row could change now, so no clear after this. On the normal screen
   * only, unless `either`: the cursor, or the place saved for it, went where the count does not follow it, and a
   * switch back with 47 or 1047 (after a restore, for the saved place) brings the cursor to the normal screen.
   */
  private unsettled(either = false): void {
    if (this.watch !== undefined && (either || !this.alt)) this.watch.stop = true
  }

  /** What the text read changed in the terminal's state, to carry across the cut. */
  carried(): { before: string; after: string } {
    // Read up to a cut, which is never on the alternate screen, so the whole replay is on the normal screen there.
    // Leave it whenever the text switched it: the tab can still be on it (the leave of the program it showed was
    // in the bytes no longer held, or the enter is a repeat). The text's own leave when it left first; 47 when it
    // entered first, which restores no cursor, so on a tab already on the normal screen it does nothing (1049
    // would move the cursor to a stale saved place).
    const before = this.altFirst ? `\x1b[?${this.altFirst.on ? 47 : this.altFirst.mode}l` : ''
    let after = ''
    for (const [m, on] of this.modes) after += `\x1b[?${m}${on ? 'h' : 'l'}`
    return { before, after }
  }

  private c1(c: number, i: number): void {
    this.last = 0
    // ST ends a string as its end does; any other 8-bit control cuts it short.
    this.leave(i, c === 0x9c)
    if (c === 0x9b) { this.startCsi(); this.began(i) }
    else if (c === 0x9d) { this.state = OSC; this.began(i) }
    else if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) { this.startString(c === 0x90); this.began(i) }
    else {
      // ST (0x9c) only ends a string; the others are carried out.
      this.state = GROUND
      if (c === 0x84) this.lineFeed(i + 1)
      else if (c === 0x85) { this.col = 0; this.lineFeed(i + 1) }
    }
  }

  private startCsi(): void {
    this.state = CSI
    this.prefix = 0
    this.params = []
    this.param = 0
    this.any = false
    this.more = false
    this.inter = ''
    this.sub = false
  }

  /** A C0 control carried out; `ground`: read as text, so what follows it can start a line. */
  protected execute(c: number, i: number, ground: boolean): void {
    this.last = 0
    if (c === 0x0a || c === 0x0b || c === 0x0c) this.lineFeed(ground ? i + 1 : undefined)
    else if (c === 0x0d) this.col = 0
    else if (c === 0x08) this.col = Math.max(0, this.held() - 1)
    else if (c === 0x09) this.tab(1)
  }

  /** The cursor's column with a wrap still pending taken back, as xterm.js's cursor moves do first. */
  private held(): number {
    return Math.min(this.col, this.width - 1)
  }

  private print(i: number, w: number): void {
    if (this.col + w > this.width) {
      this.col = 0
      if (this.down(1) > 0 && !this.alt) this.rowAt(i, false)
    }
    this.col += w
    this.last = w
    this.fresh = false
    if (!this.alt) this.textRow = this.row
  }

  /** A line feed (and the others that move down a row); `next`: the line that starts after it. */
  private lineFeed(next: number | undefined): void {
    this.col = this.held()
    const added = this.down(1)
    if (this.alt) return
    if (next === undefined) {
      this.row += added
      if (added > 0) this.fresh = false
    } else if (added > 0) this.rowAt(next, true)
    else {
      // Above the last row: a line starts, on no new row.
      this.lineRow = this.row
      this.lines++
      this.fresh = false
    }
  }

  /** The cursor moves down `n` rows by line feeds or wraps: how many of them add a row (with the rows given, only those at the screen's last row). */
  private down(n: number): number {
    const free = Math.min(this.up, n)
    this.up -= free
    return n - free
  }

  /** A scroll region that is not the whole screen is set on the screen in use. */
  private inRegion(): boolean {
    return this.region[this.alt ? 1 : 0]
  }

  /** The cursor's row (as `up`) set by a cursor move: one moved up before anything is printed on a new line's row takes that line start back. */
  private setUp(up: number): void {
    if (up > this.up && this.fresh) this.demote()
    this.up = up
  }

  /**
   * The newest row's line feed started no line after all: the cursor went back up before anything was printed, as a
   * Windows console does for a wrapped line, so the row belongs to the line before. The cut then treats it as inside
   * that line.
   */
  private demote(): void {
    this.fresh = false
    this.lineRow = this.prevLineRow
    this.lines--
    this.starts?.relabel(this.lineRow, this.lines)
  }

  /** The cursor moves up (`n` > 0) or down the screen, adding no row. Not followed in a scroll region. */
  private move(n: number): void {
    if (this.height === undefined || this.inRegion()) return
    this.setUp(Math.max(0, Math.min(this.height - 1, this.up + n)))
  }

  /** The cursor is put on screen row `r` (from 1). Not followed in a scroll region (origin mode puts it elsewhere). */
  private toRow(r: number): void {
    if (this.height === undefined || this.inRegion()) return
    this.setUp(this.height - Math.max(1, Math.min(this.height, r || 1)))
  }

  /** A new row on the normal screen, starting at `index`. */
  private rowAt(index: number, lineStart: boolean): void {
    this.row++
    if (lineStart) {
      this.prevLineRow = this.lineRow
      this.lineRow = this.row
      this.lines++
    }
    this.fresh = lineStart && this.height !== undefined
    this.starts?.add(index, this.row, this.lineRow, this.lines)
    // Read for the clear: a line feed has moved the screen up already where its row starts (a wrap's row starts at the
    // character that wraps, before the screen moves).
    const w = this.watch
    if (w !== undefined && lineStart && !w.stop && this.row <= w.gap) w.clear = index
  }

  private tab(n: number): void {
    if (this.col >= this.width) return
    for (let k = 0; k < n && this.col < this.width - 1; k++) this.col = Math.min(this.width - 1, (Math.floor(this.col / 8) + 1) * 8)
  }

  private backTab(n: number): void {
    if (this.col >= this.width) return
    for (let k = 0; k < n && this.col > 0; k++) this.col = (Math.ceil(this.col / 8) - 1) * 8
  }

  /** CSI b: the character just printed, `n` times more. Rows only: no row starts inside the sequence. */
  private repeat(n: number): void {
    const w = this.last
    if (w === 0) return
    this.fresh = false
    if (this.col + w > this.width) {
      this.col = 0
      const added = this.down(1)
      if (!this.alt) this.row += added
    }
    const room = Math.floor((this.width - this.col) / w)
    if (n <= room) { this.col += n * w; if (!this.alt) this.textRow = this.row; return }
    const perRow = Math.floor(this.width / w)
    const rest = n - room
    const rows = Math.ceil(rest / perRow)
    const added = this.down(rows)
    if (!this.alt) { this.row += added; this.textRow = this.row }
    this.col = (rest - (rows - 1) * perRow) * w
  }

  private save(): void {
    this.saved[this.alt ? 1 : 0] = this.col
    this.savedUp[this.alt ? 1 : 0] = this.up
    // xterm.js keeps a saved row counted from the scrollback's top, so a clear after it moves where it is restored.
    this.unsettled()
  }

  /**
   * CSI ! p, as xterm.js: the carried modes as it sets them (AFTER_SOFT_RESET), and the saved cursor of the screen in
   * use put on that screen's top row. On the normal screen that row is counted from the scrollback's top, so a clear
   * after it moves where a restore lands; on the alternate screen the count's own saved place does not follow it, and
   * a restore there, then 47 or 1047, brings the cursor to the normal screen above the rows shown.
   */
  private softReset(): void {
    this.unsettled(true)
    for (const [m, on] of AFTER_SOFT_RESET) this.mode(m, on)
  }

  private restore(): void {
    this.col = Math.min(this.saved[this.alt ? 1 : 0], this.width - 1)
    // The tab puts the cursor back on the row it was saved on, or higher (the screen scrolled since).
    this.setUp(this.inRegion() ? 0 : this.savedUp[this.alt ? 1 : 0])
  }

  private csi(final: number): void {
    const ps = this.params
    const count = Math.max(1, ps[0] ?? 0)
    const column = (k: number) => Math.min(this.width - 1, Math.max(0, (ps[k] || 1) - 1))
    if (this.prefix === 0x3f) {
      if (final === 0x68 || final === 0x6c) for (const m of ps) this.mode(m, final === 0x68)
      return
    }
    if (this.prefix !== 0) return
    switch (final) {
      case 0x41: this.col = this.held(); this.move(count); break // A
      case 0x42: case 0x65: this.col = this.held(); this.move(-count); break // B e
      case 0x64: this.col = this.held(); this.toRow(ps[0]); break // d
      case 0x43: case 0x61: this.col = Math.min(this.width - 1, this.held() + count); break // C a
      case 0x44: this.col = Math.max(0, this.held() - count); break // D
      case 0x45: this.col = 0; this.move(-count); break // E
      case 0x46: this.col = 0; this.move(count); break // F
      case 0x47: case 0x60: this.col = column(0); break // G `
      case 0x48: case 0x66: this.col = column(1); this.toRow(ps[0]); break // H f
      case 0x49: this.tab(count); break // I
      case 0x5a: this.backTab(count); break // Z
      case 0x62: this.repeat(count); break // b
      case 0x72: this.margins(ps[0] || 1, ps.length < 2 ? 0 : ps[1]); break // r
      case 0x73: this.save(); break // s
      case 0x75: this.restore(); break // u
      case 0x53: case 0x54: this.unsettled(); break // S T: the screen moved up or down, and the rows above the cut's with it
    }
  }

  /** DECSTBM, as xterm.js: a region that is not the whole screen stops the row being followed; either way the cursor goes home. */
  private margins(top: number, bottom: number): void {
    if (this.height === undefined) return
    if (bottom > this.height || bottom === 0) bottom = this.height
    if (bottom <= top) return
    // The cursor goes home (or to the region's top), where the count does not follow it.
    this.unsettled(true)
    const part = !(top === 1 && bottom === this.height)
    this.region[this.alt ? 1 : 0] = part
    this.col = 0
    this.setUp(part ? 0 : this.height - 1)
  }

  protected escape(final: number, i: number): void {
    this.last = 0
    if (final === 0x44) this.lineFeed(i + 1) // D: index
    else if (final === 0x45) { this.col = 0; this.lineFeed(i + 1) } // E: next line
    else if (final === 0x4d) this.move(1) // M: reverse index
    else if (final === 0x37) this.save()
    else if (final === 0x38) this.restore()
    // The keypad: ESC = and ESC > set the flag mode 66 sets.
    else if (final === 0x3d) this.mode(66, true)
    else if (final === 0x3e) this.mode(66, false)
    else if (final === 0x63) {
      // A full reset: the normal screen, the cursor home, the modes as they start.
      this.mode(47, false)
      this.unsettled()
      this.col = 0
      this.saved = [0, 0]
      // As xterm.js: the cursor at the top, and its saved place on each screen too; no scroll region.
      const top = this.height === undefined ? 0 : this.height - 1
      this.up = top
      this.savedUp = [top, top]
      this.region = [false, false]
      this.fresh = false
      for (const [m, on] of AFTER_RESET) this.mode(m, on)
    }
  }

  private mode(m: number, on: boolean): void {
    if (ALTERNATE_SCREEN.has(m)) {
      // As xterm.js: 1049 saves the cursor on the screen it leaves, and restores it on the normal one. The cursor
      // keeps its place across a switch, and the alternate screen's scroll region goes once it is left. A line start
      // is not taken back by what a switch does to the cursor.
      this.fresh = false
      if (on && m === 1049) this.save()
      this.alt = on
      if (!on) this.region[1] = false
      if (!on && m === 1049) this.restore()
      if (this.inRegion()) this.up = 0
      if (!this.altFirst) this.altFirst = { mode: m, on }
    } else if (m === 1048) {
      if (on) this.save()
      else this.restore()
    } else if (m === 6) {
      // Origin mode set or reset puts the tab's cursor home, where the count does not follow it, and 47 and 1047 bring it back.
      this.unsettled(true)
    } else if (CARRIED_MODES.has(m)) {
      this.modes.delete(m)
      this.modes.set(m, on)
    }
  }
}

/** What of a replay to show after the notice: from `from` on, with `before` and `after` around the notice. */
export interface ReplayTail {
  /** Where what is shown starts: the start of a row, never inside an escape sequence or a character. */
  from: number
  /** Whole lines left out, before `from`. */
  left: number
  /** `from` is inside a line, whose start is left out too. */
  part: boolean
  /** Written before the notice: the alternate screen left, whenever the left-out part switched it. */
  before: string
  /** Written after the notice, before the text from `from`: the carried modes the left-out part set or reset. */
  after: string
  /** With the rows and a gap given: where in `text` the tab's scrollback may be cleared (from `from` on), if anywhere. */
  clear?: number
}

/**
 * Where to cut `text` so that what follows takes at most `budget` rows of a terminal `cols` wide, and what the
 * left-out part carries. With `height` (the terminal's rows), the cursor's row is followed too; with a `gap` as
 * well, the answer says where the scrollback may be cleared once `gap` empty rows above the notice left the screen.
 */
export function replayTail(text: string, cols: number, budget: number, height?: number, gap?: number): ReplayTail {
  const rows = new Reader(cols, budget, height)
  rows.read(text, text.length)
  const { from, left, part } = rows.cut()
  const clear = height === undefined || gap === undefined ? undefined : clearAfter(text, from, cols, height, gap)
  const at = clear === undefined ? {} : { clear }
  if (from === 0) return { from, left, part, before: '', after: '', ...at }
  const state = new Reader(cols)
  state.read(text, from)
  return { from, left, part, ...state.carried(), ...at }
}

/**
 * Where the scrollback may be cleared once what is shown from `from` has moved `gap` empty rows off the screen: read
 * from `from` as a new tab `rows` high reads it (the cursor on the last row, nothing saved, no scroll region), the
 * cursor's row followed. Only rows that stayed empty may go, so it stops at the first sign that a row above the one
 * `from` starts on could hold anything but that (the cursor on such a row of the normal screen, a scroll region set,
 * origin mode set or reset, the screen moved up or down, filled or reset, a cursor saved, a soft reset) and answers the
 * newest row a line feed added before it.
 */
function clearAfter(text: string, from: number, cols: number, rows: number, gap: number): number | undefined {
  if (gap < 1) return undefined
  const r = new Reader(cols, undefined, rows, gap)
  r.read(text, text.length, from)
  return r.clearFound()
}

/** The rows `text` takes in a terminal `cols` wide, written from a row's start; with `height`, its cursor's row followed. */
export function rowsOf(text: string, cols: number, height?: number): number {
  const r = new Reader(cols, undefined, height)
  r.read(text, text.length)
  return r.row + 1
}
