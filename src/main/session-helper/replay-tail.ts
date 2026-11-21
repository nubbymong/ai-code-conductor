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
 * repeat (CSI b) and a cursor saved and restored. A cursor moved up or down
 * only moves on the screen and adds no row to the scrollback, so it is not
 * counted. The alternate screen has no scrollback: what a program writes there
 * adds no row, and the cut never lands in it. Where this differs from the tab
 * it counts more rows, not fewer (combining characters and the emoji blocks
 * count a column or two, an autowrap turned off is ignored), with three known
 * exceptions. A program's own tab stops (HTS, TBC) are not followed, so a tab
 * after it cleared them may go further than counted, at most a row a line. A
 * repeat (CSI b) that follows a sequence the tab ignores or ends in error, or
 * an 8-bit CSI, string introducer or ST, is not counted: the tab still repeats
 * the character printed before it, and here that character is forgotten (or
 * taken as narrower). And on the alternate screen, where no row is counted, a
 * column counted further than the tab's (a combining character, an emoji, an
 * autowrap turned off) can wrap there, while the tab wraps only after the
 * program left that screen with mode 47 or 1047, which restore no cursor: at
 * most a row each time. No program is known to write such a repeat, or to
 * leave that screen so and write on without setting the column first.
 *
 * The cut is at the start of a row the text took, never inside an escape
 * sequence or a character: at the start of a line, unless the line there alone
 * takes as many rows as the budget or more, or only empty rows follow it, which
 * is then cut inside, at the start of one of its rows, so the tab is never
 * shown only the notice while there is output to show.
 *
 * What the left-out part changes in the terminal's state is carried across the
 * cut (`before` and `after`): leaving the alternate screen whenever that part
 * switched it (before the notice, so the notice is on the normal screen; the
 * cut is never on it, so the whole replay is on the normal screen there), and
 * the DEC private modes that are flags only (cursor keys, autowrap, cursor
 * blink and visibility, reverse wrap, the keypad, mouse reporting and its
 * encoding, focus events, bracketed paste), each at its last value, in the
 * order of their last change. That is as the whole replay would have left
 * them, but for one thing: after a full reset the cursor is shown again
 * (AFTER_RESET says why). Colours are not carried (the notice resets them),
 * nor the character set or a scroll region.
 *
 * Memory is bounded by the budget, whatever the text: only the row starts that
 * can still be kept are remembered.
 */

/** The parser's states, as far as they matter here. */
const GROUND = 0
const ESC = 1
/** After ESC and one or more intermediate bytes (0x20-0x2f). */
const ESC_MORE = 2
const CSI = 3
/** A CSI that went wrong (a prefix byte after a parameter): read to its end, then nothing done. */
const CSI_IGNORE = 4
/** An OSC string: BEL, ST, CAN or SUB ends it. */
const OSC = 5
/**
 * A DCS string, or an SOS, PM or APC one: ST, CAN or SUB ends it, and the C0 controls in it do nothing. As in
 * xterm.js, a character past U+009F ends it in error, except in a DCS string past its final byte, or one the tab
 * ignores to its end.
 */
const STRING = 6

/** The DEC private modes carried across the cut: flags, with no effect on the cursor or on what the screen shows. */
const CARRIED_MODES = new Set([1, 7, 12, 25, 45, 66, 9, 1000, 1002, 1003, 1004, 1006, 1016, 2004])
/** The modes that switch to the alternate screen and back. */
const ALTERNATE_SCREEN = new Set([47, 1047, 1049])
/** What a full reset (ESC c) leaves the carried modes at. The cursor blink (12) is the tab's own setting and stays. The cursor is shown again (25) on purpose: xterm.js 6.0.0 leaves a hidden cursor hidden after a full reset, and a shell should not be left without one. */
const AFTER_RESET: ReadonlyArray<readonly [number, boolean]> = [
  [1, false], [7, true], [25, true], [45, false], [66, false], [1000, false], [1004, false], [1006, false], [2004, false],
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

/** A terminal `cols` wide reading text, rows and modes only. */
class Reader {
  /** Rows the text moved down on the normal screen, by line feeds and wraps. */
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
  /** The row of the last character printed on the normal screen; -1 before any. */
  private textRow = -1
  private state = GROUND
  private prefix = 0
  private params: number[] = []
  private param = 0
  /** A CSI or DCS parameter, prefix or separator byte was read. */
  private any = false
  /** A CSI or DCS intermediate byte was read. */
  private more = false
  /** The string read is a DCS one. */
  private dcs = false
  /**
   * The DCS string's final byte was read, or a byte the tab ignores the string from (a prefix after a parameter, a
   * parameter after an intermediate): past it, a character past U+009F is its text, not an error.
   */
  private hooked = false
  /** The carried modes at their last value, in the order of their last change. */
  private readonly modes = new Map<number, boolean>()
  private altFirst: { mode: number; on: boolean } | undefined

  constructor(cols: number, budget?: number) {
    // As xterm.js: a terminal is at least two columns wide.
    this.width = Math.max(2, Math.floor(cols) || 0)
    if (budget !== undefined) {
      this.starts = new RowStarts(Math.max(1, Math.floor(budget)))
      this.starts.add(0, 0, 0, 0)
    }
  }

  read(text: string, end: number): void {
    for (let i = 0; i < end; i++) {
      const c = text.charCodeAt(i)
      // In any state: ESC starts a sequence, CAN and SUB end one, and the 8-bit controls act as in the tab.
      if (c === 0x1b) { this.state = ESC; continue }
      if (c === 0x18 || c === 0x1a) { this.state = GROUND; this.last = 0; continue }
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
            // A final byte (a character set, say), or a character that ends it in error.
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
          if (c === 0x07) this.state = GROUND
          break
        case STRING:
          // A string's text, and the C0 controls in it: nothing. A character past U+009F ends it in error, as in
          // the tab, which reads what follows as text; in a DCS string past its final byte, or one the tab ignores to
          // its end, it is the string's text.
          if (c >= 0xa0) { if (!this.hooked) this.state = GROUND }
          else if (this.dcs && !this.hooked && c >= 0x20) {
            if (c >= 0x40 || (c >= 0x30 && (this.more || (c >= 0x3c && this.any)))) this.hooked = true
            else if (c >= 0x30) this.any = true
            else this.more = true
          }
          break
      }
    }
  }

  private inEscape(c: number, i: number): void {
    if (c < 0x20) this.execute(c, i, false)
    else if (c === 0x5b) this.startCsi()
    else if (c === 0x5d) this.state = OSC
    else if (c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) { this.state = STRING; this.dcs = c === 0x50; this.hooked = false; this.any = false; this.more = false }
    else if (c <= 0x2f) this.state = ESC_MORE
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
      this.param = Math.min(PARAM_MAX, this.param * 10 + c - 0x30)
      this.any = true
    } else if (c === 0x3a || c === 0x3b) {
      if (this.params.length < PARAMS_MAX) this.params.push(this.param)
      this.param = 0
      this.any = true
    } else if (c >= 0x3c && c <= 0x3f) {
      // A prefix (? > < =) only as the first byte.
      if (this.any) this.state = CSI_IGNORE
      else {
        this.prefix = c
        this.any = true
      }
    } else if (c <= 0x2f) this.more = true
    else {
      // A final byte; a character past 0x7e ends it in error. One with intermediates does nothing here.
      this.state = GROUND
      if (c <= 0x7e && !this.more) {
        if (this.params.length < PARAMS_MAX) this.params.push(this.param)
        this.csi(c)
      }
      this.last = 0
    }
  }

  /** Where to cut (with a budget given). */
  cut(): { from: number; left: number; part: boolean } {
    return this.starts ? this.starts.cut(this.row, this.textRow) : { from: 0, left: 0, part: false }
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
    if (c === 0x9b) this.startCsi()
    else if (c === 0x9d) this.state = OSC
    else if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) { this.state = STRING; this.dcs = c === 0x90; this.hooked = false; this.any = false; this.more = false }
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
  }

  /** A C0 control carried out; `ground`: read as text, so what follows it can start a line. */
  private execute(c: number, i: number, ground: boolean): void {
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
      if (!this.alt) this.rowAt(i, false)
    }
    this.col += w
    this.last = w
    if (!this.alt) this.textRow = this.row
  }

  /** A line feed (and the others that move down a row); `next`: the line that starts after it. */
  private lineFeed(next: number | undefined): void {
    this.col = this.held()
    if (this.alt) return
    if (next === undefined) this.row++
    else this.rowAt(next, true)
  }

  /** A new row on the normal screen, starting at `index`. */
  private rowAt(index: number, lineStart: boolean): void {
    this.row++
    if (lineStart) {
      this.lineRow = this.row
      this.lines++
    }
    this.starts?.add(index, this.row, this.lineRow, this.lines)
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
    if (this.col + w > this.width) {
      this.col = 0
      if (!this.alt) this.row++
    }
    const room = Math.floor((this.width - this.col) / w)
    if (n <= room) { this.col += n * w; if (!this.alt) this.textRow = this.row; return }
    const perRow = Math.floor(this.width / w)
    const rest = n - room
    const rows = Math.ceil(rest / perRow)
    if (!this.alt) { this.row += rows; this.textRow = this.row }
    this.col = (rest - (rows - 1) * perRow) * w
  }

  private save(): void {
    this.saved[this.alt ? 1 : 0] = this.col
  }

  private restore(): void {
    this.col = Math.min(this.saved[this.alt ? 1 : 0], this.width - 1)
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
      case 0x41: case 0x42: case 0x64: case 0x65: this.col = this.held(); break // A B d e
      case 0x43: case 0x61: this.col = Math.min(this.width - 1, this.held() + count); break // C a
      case 0x44: this.col = Math.max(0, this.held() - count); break // D
      case 0x45: case 0x46: this.col = 0; break // E F
      case 0x47: case 0x60: this.col = column(0); break // G `
      case 0x48: case 0x66: this.col = column(1); break // H f
      case 0x49: this.tab(count); break // I
      case 0x5a: this.backTab(count); break // Z
      case 0x62: this.repeat(count); break // b
      case 0x73: this.save(); break // s
      case 0x75: this.restore(); break // u
    }
  }

  private escape(final: number, i: number): void {
    this.last = 0
    if (final === 0x44) this.lineFeed(i + 1) // D: index
    else if (final === 0x45) { this.col = 0; this.lineFeed(i + 1) } // E: next line
    else if (final === 0x37) this.save()
    else if (final === 0x38) this.restore()
    // The keypad: ESC = and ESC > set the flag mode 66 sets.
    else if (final === 0x3d) this.mode(66, true)
    else if (final === 0x3e) this.mode(66, false)
    else if (final === 0x63) {
      // A full reset: the normal screen, the cursor home, the modes as they start.
      this.mode(47, false)
      this.col = 0
      this.saved = [0, 0]
      for (const [m, on] of AFTER_RESET) this.mode(m, on)
    }
  }

  private mode(m: number, on: boolean): void {
    if (ALTERNATE_SCREEN.has(m)) {
      // As xterm.js: 1049 saves the cursor on the screen it leaves, and restores it on the normal one.
      if (on && m === 1049) this.save()
      this.alt = on
      if (!on && m === 1049) this.restore()
      if (!this.altFirst) this.altFirst = { mode: m, on }
    } else if (m === 1048) {
      if (on) this.save()
      else this.restore()
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
}

/** Where to cut `text` so that what follows takes at most `budget` rows of a terminal `cols` wide, and what the left-out part carries. */
export function replayTail(text: string, cols: number, budget: number): ReplayTail {
  const rows = new Reader(cols, budget)
  rows.read(text, text.length)
  const { from, left, part } = rows.cut()
  if (from === 0) return { from, left, part, before: '', after: '' }
  const state = new Reader(cols)
  state.read(text, from)
  return { from, left, part, ...state.carried() }
}

/** The rows `text` takes in a terminal `cols` wide, written from a row's start. */
export function rowsOf(text: string, cols: number): number {
  const r = new Reader(cols)
  r.read(text, text.length)
  return r.row + 1
}
