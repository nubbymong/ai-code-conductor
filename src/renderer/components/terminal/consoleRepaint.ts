/**
 * aicc_planning#394: on Windows, a terminal that grows keeps its last lines.
 *
 * The console built into Windows (ConPTY) keeps only the rows on its screen.
 * When it is given a new size it re-wraps those rows itself and paints its
 * whole screen again from its top row down, in one piece: `ESC[?25l`, the
 * first cell's colour when it is not the one last sent, `ESC[H`, each row, the
 * cursor, `ESC[?25h`. xterm re-wraps its own rows on the same
 * resize, its scrollback too. The two agree on every whole line; they differ
 * in where the screen starts:
 *  - on a grow, xterm pulls rows down from its scrollback and keeps its cursor
 *    on the same row, while the console's lines need fewer rows and move up,
 *    with blank rows below. The console's paint then lands on rows where xterm
 *    holds older lines, and those lines are lost. beta.15 M1 measured this on
 *    the published beta.14 (Windows 11 build 22621, 10,000 lines of `long N `
 *    and 250 `y`): 103x27 to 140x27 lost lines 9988 to 9992 on both runs
 *    that went that way; by way of 140x24 the other five lost 9989 to 9992;
 *  - the console's top row can be the end of a line whose start has left the
 *    console's screen. The console paints that end as a line of its own,
 *    starting at the left edge, over the whole line xterm holds there.
 *
 * So the console's paint that comes within REPAINT_WINDOW_MS of a size sent to
 * it is written where its lines are. Every line but its top one is found in
 * xterm's rows first, the same text in the same order, ending at xterm's last
 * row with text; then xterm's rows are scrolled up until the console's second
 * line lands on the row where xterm holds it, and the console's top line,
 * when it is that end (or the whole of the line xterm holds above), is not
 * written over xterm's line. Every row below it is painted as the console sent
 * it, its cursor too.
 *
 * A program that draws its screen again at the new size (Claude Code: its
 * rules and status row at the new width, 8 ms after the size in M1's
 * g-ccmain-* streams) sends a paint whose lower lines are not xterm's rows,
 * so it is not placed that way. When its top lines are lines xterm holds
 * lower on its screen, above its cursor, xterm's rows above them go to its
 * scrollback first and the paint is written as it came. beta.15's VM line
 * (vm:A1, the same on the published beta.14) read a Claude Code tab grown
 * from 103x27 to 140x28 lose the 11 shell rows above its banner: the paint
 * starts at the banner, which xterm held on its row 9.
 *
 * On a narrowing xterm re-wraps the rows a program drew at the old width
 * (Claude Code's rules and status row) and, when it holds scrollback, moves
 * the top of its screen up one row for each row that adds, with blank rows
 * below its cursor or not (its Buffer._reflowSmaller). The console keeps its
 * top row, so its paint starts with lines xterm now holds just above its
 * screen: written as it came, they showed twice (beta.16 B3's VM line: the
 * banner's top one or two rows, 3 of 3; M1's g-ccmain-max on the published
 * beta.14: its top two rows). Such a paint is placed when it takes the
 * console's whole screen (its lines counted by the rows each takes at the new
 * width: the console writes a line longer than a row with no line break
 * inside it, as in its own re-wrap of a full-width rule, painted before the
 * program draws again: the published beta.16 on C5's VM line, 1 of the 9
 * recorded narrowings of Claude Code's main screen, 20 lines over 27 rows 3 ms
 * after the size, the program's paint 15 ms later), its top lines are xterm's
 * lines from a row above its screen (top down, as above), and xterm's screen
 * has at least that many rows below its cursor: xterm's rows are brought down
 * until the paint's top line is on its top row, then the paint is written as
 * it came, a selection and a view the user has scrolled up kept on their rows
 * (bringRowsDown). A paint that matches none of these ways (another program's
 * screen, a size that changed again, a shape not seen) is written as it came,
 * as before.
 *
 * Not handled, written as it came, as before:
 *  - a paint made while the program has the cursor hidden: the console sends
 *    neither `ESC[?25l` nor `ESC[?25h` around it (M1's g-cctrust-* streams:
 *    on their grow the shell's rows with text are kept, and the blank row
 *    under them takes the console's blank top row);
 *  - a cursor on a wrapped line (a command longer than a row typed at the
 *    prompt, Claude Code's input row under its full-width rule): xterm does
 *    not re-wrap the line its cursor is on, the console does, so that line
 *    does not match: such a paint is placed only when its top lines are
 *    lines xterm holds lower on its screen or just above it (above);
 *  - a narrowing whose paint starts more rows above xterm's screen than xterm's
 *    screen has rows below its cursor: that many do not come down
 *    (bringRowsDown).
 * Not measured: a narrowing right after a grow with no output between. xterm
 * then keeps the blank rows under its cursor and moves its rows up into its
 * scrollback; a console that fills its blank rows sends a paint that would
 * need xterm's rows moved down: placed only as a narrowing's paint is (above),
 * else written as it came.
 *
 * Not checked here: whether a console host other than the one built into
 * Windows paints the same way. A session main starts on the console host the
 * app ships (src/main/bundled-conpty.ts) saw no line lost on a grow in M1's
 * runs, so its output is written as before (consoleRepaintApplies; the caller
 * says which sessions those are).
 */

/** How long after a size is sent to the console its paint is looked for. The
 *  paint came 1 to 6 ms after the size in M1's runs, on both paths (node-pty's
 *  console, and the session helper's). */
export const REPAINT_WINDOW_MS = 2000

/** How the console's paint of its whole screen begins and ends. The colour of
 *  the first cell, when the console sets one, comes before its cursor home. */
const PAINT_START = /\x1b\[\?25l((?:\x1b\[[0-9;]*m)*)\x1b\[H/
const PAINT_END = '\x1b[?25h'

/** A line longer than this many rows is not followed: a paint around it is
 *  written as it came. */
const MAX_ROWS_PER_LINE = 2000

/** The part of a row this reads (xterm's IBufferLine). */
export interface RepaintLine {
  readonly isWrapped: boolean
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined
}

/** The part of xterm's terminal this reads and writes: the app's Terminal
 *  (@xterm/xterm), and @xterm/headless's in the tests. */
export interface RepaintTerminal {
  readonly cols: number
  readonly rows: number
  readonly buffer: {
    readonly active: {
      readonly type: 'normal' | 'alternate'
      readonly baseY: number
      /** The row the view starts on: below baseY when the user has scrolled
       *  up. */
      readonly viewportY: number
      /** The cursor's row on the screen. */
      readonly cursorY: number
      getLine(y: number): RepaintLine | undefined
    }
  }
  write(data: string, callback?: () => void): void
  /** Sizes the terminal itself, not the console: a narrowing's paint
   *  (bringRowsDown) uses it to bring rows down out of the scrollback. */
  resize(columns: number, rows: number): void
  /** Moves the view: bringRowsDown puts a view the user has scrolled up back
   *  on its rows (putViewBack). */
  scrollLines(amount: number): void
  scrollToLine(line: number): void
  /** The app's xterm (@xterm/xterm) has a selection; @xterm/headless has
   *  none. bringRowsDown selects again what its sizes cleared. */
  hasSelection?(): boolean
  getSelectionPosition?(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined
  select?(column: number, row: number, length: number): void
}

/** Whether a terminal's output goes through the aligner: on Windows only, for
 *  a terminal on the console built into Windows (a plain terminal, a Claude
 *  Code session, an SSH session's ssh.exe), and not for one on the console
 *  host the app ships (`shipsOwnConsole`). */
export function consoleRepaintApplies(where: { platform: string | undefined; shipsOwnConsole: boolean }): boolean {
  return where.platform === 'win32' && !where.shipsOwnConsole
}

interface Paint {
  /** The console's lines, its top one first, each line's text with the
   *  spaces at its end left off. */
  lines: string[]
  /** Each line as it is written from the left edge: its text, and a number
   *  for each step to the right (`ESC[nC`), which stops at the last column
   *  and never starts a row (rowsOfPaint). */
  runs: Array<Array<string | number>>
  /** Where the top line's text ends in the paint: at the first line break, or
   *  at the paint's own cursor position when it has one line only. */
  topEnd: number
  /** The colour the console sent before its cursor home, when it sent one,
   *  and the colour and title sequences inside the top line: written when its
   *  text is not, so what follows it draws in the colours the console meant. */
  topKeep: string
  /** The paint ends by placing its cursor at a row and column. */
  placesCursor: boolean
}

/** Reads the console's paint, `PAINT_START` to `PAINT_END`. Null for any shape
 *  other than rows of text, colours, erases and cursor steps to the right,
 *  separated by CR LF, ending at an optional cursor position. */
function readPaint(paint: string): Paint | null {
  const body = paint.length - PAINT_END.length
  const lines: string[] = []
  const runs: Array<Array<string | number>> = []
  let run: Array<string | number> = []
  let text = ''
  let topEnd = -1
  const head = PAINT_START.exec(paint)
  if (!head || head.index !== 0) return null
  let topKeep = head[1]
  let placesCursor = false
  let i = head[0].length
  while (i < body) {
    const c = paint.charCodeAt(i)
    if (c === 0x1b) {
      const next = paint[i + 1]
      if (next === '[') {
        let j = i + 2
        while (j < body && /[0-9;]/.test(paint[j])) j++
        if (j >= body) return null
        const params = paint.slice(i + 2, j)
        const final = paint[j]
        const seq = paint.slice(i, j + 1)
        if (final === 'm') {
          if (lines.length === 0) topKeep += seq
        } else if (final === 'K') {
          if (params !== '' && params !== '0') return null
        } else if (final === 'X') {
          if (!/^\d*$/.test(params)) return null
        } else if (final === 'C') {
          if (!/^\d*$/.test(params)) return null
          const n = params === '' ? 1 : Number(params)
          if (n > 1000) return null
          text += ' '.repeat(Math.max(1, n))
          run.push(Math.max(1, n))
        } else if (final === 'H') {
          // The paint's own cursor: only as its last sequence.
          if (j + 1 !== body || !/^\d+;\d+$/.test(params)) return null
          placesCursor = true
          if (topEnd < 0) topEnd = i
        } else {
          return null
        }
        i = j + 1
        continue
      }
      if (next === ']') {
        let j = i + 2
        while (j < body && paint.charCodeAt(j) !== 0x07 && !(paint.charCodeAt(j) === 0x1b && paint[j + 1] === '\\')) j++
        if (j >= body) return null
        const stop = paint.charCodeAt(j) === 0x07 ? j + 1 : j + 2
        if (lines.length === 0) topKeep += paint.slice(i, stop)
        i = stop
        continue
      }
      return null
    }
    if (c === 0x0d) {
      if (paint.charCodeAt(i + 1) !== 0x0a) return null
      if (lines.length === 0) topEnd = i
      lines.push(text.trimEnd())
      runs.push(run)
      text = ''
      run = []
      i += 2
      continue
    }
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return null
    text += paint[i]
    if (typeof run[run.length - 1] === 'string') run[run.length - 1] += paint[i]
    else run.push(paint[i])
    i++
  }
  lines.push(text.trimEnd())
  runs.push(run)
  if (topEnd < 0) topEnd = body
  return { lines, runs, topEnd, topKeep, placesCursor }
}

/** The characters xterm gives no cell of their own (combining marks, format
 *  characters, the Hangul vowels and final consonants U+1160 to U+11FF):
 *  @xterm/xterm 6.0.0's UnicodeV6 tables (src/common/input/UnicodeV6.ts,
 *  from Markus Kuhn's wcwidth), as first and last code point of each run.
 *  console-repaint-claude-code.test.ts reads every width cellsOf gives
 *  against xterm's own. */
const NO_CELL: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], [0x0483, 0x0486], [0x0488, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf],
  [0x05c1, 0x05c2], [0x05c4, 0x05c5], [0x05c7, 0x05c7], [0x0600, 0x0603], [0x0610, 0x0615],
  [0x064b, 0x065e], [0x0670, 0x0670], [0x06d6, 0x06e4], [0x06e7, 0x06e8], [0x06ea, 0x06ed],
  [0x070f, 0x070f], [0x0711, 0x0711], [0x0730, 0x074a], [0x07a6, 0x07b0], [0x07eb, 0x07f3],
  [0x0901, 0x0902], [0x093c, 0x093c], [0x0941, 0x0948], [0x094d, 0x094d], [0x0951, 0x0954],
  [0x0962, 0x0963], [0x0981, 0x0981], [0x09bc, 0x09bc], [0x09c1, 0x09c4], [0x09cd, 0x09cd],
  [0x09e2, 0x09e3], [0x0a01, 0x0a02], [0x0a3c, 0x0a3c], [0x0a41, 0x0a42], [0x0a47, 0x0a48],
  [0x0a4b, 0x0a4d], [0x0a70, 0x0a71], [0x0a81, 0x0a82], [0x0abc, 0x0abc], [0x0ac1, 0x0ac5],
  [0x0ac7, 0x0ac8], [0x0acd, 0x0acd], [0x0ae2, 0x0ae3], [0x0b01, 0x0b01], [0x0b3c, 0x0b3c],
  [0x0b3f, 0x0b3f], [0x0b41, 0x0b43], [0x0b4d, 0x0b4d], [0x0b56, 0x0b56], [0x0b82, 0x0b82],
  [0x0bc0, 0x0bc0], [0x0bcd, 0x0bcd], [0x0c3e, 0x0c40], [0x0c46, 0x0c48], [0x0c4a, 0x0c4d],
  [0x0c55, 0x0c56], [0x0cbc, 0x0cbc], [0x0cbf, 0x0cbf], [0x0cc6, 0x0cc6], [0x0ccc, 0x0ccd],
  [0x0ce2, 0x0ce3], [0x0d41, 0x0d43], [0x0d4d, 0x0d4d], [0x0dca, 0x0dca], [0x0dd2, 0x0dd4],
  [0x0dd6, 0x0dd6], [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x0eb1, 0x0eb1],
  [0x0eb4, 0x0eb9], [0x0ebb, 0x0ebc], [0x0ec8, 0x0ecd], [0x0f18, 0x0f19], [0x0f35, 0x0f35],
  [0x0f37, 0x0f37], [0x0f39, 0x0f39], [0x0f71, 0x0f7e], [0x0f80, 0x0f84], [0x0f86, 0x0f87],
  [0x0f90, 0x0f97], [0x0f99, 0x0fbc], [0x0fc6, 0x0fc6], [0x102d, 0x1030], [0x1032, 0x1032],
  [0x1036, 0x1037], [0x1039, 0x1039], [0x1058, 0x1059], [0x1160, 0x11ff], [0x135f, 0x135f],
  [0x1712, 0x1714], [0x1732, 0x1734], [0x1752, 0x1753], [0x1772, 0x1773], [0x17b4, 0x17b5],
  [0x17b7, 0x17bd], [0x17c6, 0x17c6], [0x17c9, 0x17d3], [0x17dd, 0x17dd], [0x180b, 0x180d],
  [0x18a9, 0x18a9], [0x1920, 0x1922], [0x1927, 0x1928], [0x1932, 0x1932], [0x1939, 0x193b],
  [0x1a17, 0x1a18], [0x1b00, 0x1b03], [0x1b34, 0x1b34], [0x1b36, 0x1b3a], [0x1b3c, 0x1b3c],
  [0x1b42, 0x1b42], [0x1b6b, 0x1b73], [0x1dc0, 0x1dca], [0x1dfe, 0x1dff], [0x200b, 0x200f],
  [0x202a, 0x202e], [0x2060, 0x2063], [0x206a, 0x206f], [0x20d0, 0x20ef], [0x302a, 0x302f],
  [0x3099, 0x309a], [0xa806, 0xa806], [0xa80b, 0xa80b], [0xa825, 0xa826], [0xfb1e, 0xfb1e],
  [0xfe00, 0xfe0f], [0xfe20, 0xfe23], [0xfeff, 0xfeff], [0xfff9, 0xfffb],
  [0x10a01, 0x10a03], [0x10a05, 0x10a06], [0x10a0c, 0x10a0f], [0x10a38, 0x10a3a], [0x10a3f, 0x10a3f],
  [0x1d167, 0x1d169], [0x1d173, 0x1d182], [0x1d185, 0x1d18b], [0x1d1aa, 0x1d1ad], [0x1d242, 0x1d244],
  [0xe0001, 0xe0001], [0xe0020, 0xe007f], [0xe0100, 0xe01ef],
]

/** The cells xterm gives a character the console writes (no control
 *  character reaches here: readPaint refuses them): UnicodeV6's widths, the
 *  ones xterm uses when no other provider is loaded (TerminalView loads none).
 *  0 for one NO_CELL holds, 2 for the East Asian wide ranges it lists, 1 for
 *  every other. Exported for its test. */
export function cellsOf(code: number): number {
  let lo = 0
  let hi = NO_CELL.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (code < NO_CELL[mid][0]) hi = mid - 1
    else if (code > NO_CELL[mid][1]) lo = mid + 1
    else return 0
  }
  if (code < 0x1100) return 1
  if (code <= 0x115f || code === 0x2329 || code === 0x232a) return 2
  if (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) return 2
  if ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)) return 2
  if ((code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f)) return 2
  if ((code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)) return 2
  if ((code >= 0x20000 && code <= 0x2fffd) || (code >= 0x30000 && code <= 0x3fffd)) return 2
  return 1
}

/** How many rows the paint takes on a terminal `cols` columns wide: each line
 *  from the left edge, a character that does not fit on its row starting the
 *  next one, as xterm writes it (the console writes a line longer than a row
 *  with no line break inside it). Two kinds of input that no console paint
 *  holds are not counted as xterm counts them. */
function rowsOfPaint(read: Paint, cols: number): number {
  let rows = 0
  for (const run of read.runs) {
    let row = 1
    let col = 0
    for (const step of run) {
      if (typeof step === 'number') {
        col = Math.min(col + step, cols - 1)
        continue
      }
      for (const ch of step) {
        const cells = cellsOf(ch.codePointAt(0)!)
        if (col + cells > cols) { row++; col = 0 }
        col += cells
      }
    }
    rows += row
  }
  return rows
}

interface HeldLine {
  /** The row it starts on and the row it ends on (absolute rows). */
  start: number
  end: number
  /** Its text, the spaces at its end left off. */
  text: string
}

/** The line that ends on row `end`: back to the row that is not a wrapped
 *  continuation. Null past MAX_ROWS_PER_LINE rows or a row that is not there. */
function heldLine(term: RepaintTerminal, end: number): HeldLine | null {
  const buf = term.buffer.active
  let start = end
  while (start > 0 && buf.getLine(start)?.isWrapped) {
    start--
    if (end - start > MAX_ROWS_PER_LINE) return null
  }
  let text = ''
  for (let y = start; y <= end; y++) {
    const line = buf.getLine(y)
    if (!line) return null
    text += line.translateToString(y === end, 0, term.cols)
  }
  return { start, end, text: text.trimEnd() }
}

/** How many rows the last `length` characters of `held` take written alone
 *  from the left edge, as the console paints them. Null when they do not
 *  begin at a cell of their own. */
function rowsOfEnd(term: RepaintTerminal, held: HeldLine, length: number): number | null {
  const buf = term.buffer.active
  const cells: Array<{ chars: string; width: number }> = []
  for (let y = held.start; y <= held.end; y++) {
    const line = buf.getLine(y)
    if (!line) return null
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x)
      if (!cell) break
      const width = cell.getWidth()
      if (width === 0) continue
      cells.push({ chars: cell.getChars() || ' ', width })
    }
  }
  const from = held.text.length - length
  let at = 0
  let i = 0
  while (i < cells.length && at < from) { at += cells[i].chars.length; i++ }
  if (at !== from) return null
  let rows = 1
  let col = 0
  for (; i < cells.length && at < held.text.length; i++) {
    if (col + cells[i].width > term.cols) { rows++; col = 0 }
    col += cells[i].width
    at += cells[i].chars.length
  }
  return rows
}

/**
 * The console's paint `paint` (PAINT_START to PAINT_END) rewritten to land
 * where xterm holds its lines, or null to write it as it came. Reads the
 * terminal as it is once everything before the paint is written. A narrowing's
 * paint (bringRowsDown) sizes the terminal before it returns: what it returns
 * is then written. The aligner also runs its `settle` once that is written
 * (placeConsoleRepaint): this alone does not.
 */
export function alignConsoleRepaint(paint: string, term: RepaintTerminal): string | null {
  return placeConsoleRepaint(paint, term)?.out ?? null
}

/** A paint rewritten to land where xterm holds its lines. */
interface Placement {
  out: string
  /** Runs once `out` is written (bringRowsDown: a scrolled-up view put back
   *  on its rows after the line breaks in `out`). */
  settle?: () => void
}

function placeConsoleRepaint(paint: string, term: RepaintTerminal): Placement | null {
  if (term.buffer.active.type !== 'normal') return null
  const read = readPaint(paint)
  if (!read) return null
  const out = placeWholeScreen(read, paint, term) ?? keepRowsAboveTop(read, paint, term)
  return out !== null ? { out } : bringRowsDown(read, paint, term)
}

/** The paint placed when every line of it but its top one is xterm's line
 *  there, bottom up (the console's own paint of a plain terminal). */
function placeWholeScreen(read: Paint, paint: string, term: RepaintTerminal): string | null {
  const buf = term.buffer.active
  const { lines } = read
  // The console's last line with text, and the blank rows below it.
  let last = lines.length - 1
  while (last >= 0 && lines[last] === '') last--
  if (last < 0) return null
  const blankBelow = lines.length - 1 - last
  if (last === 0 && !read.placesCursor) return null
  // xterm's last row with text on its screen.
  const top = buf.baseY
  let row = top + term.rows - 1
  while (row >= top && (buf.getLine(row)?.translateToString(true, 0, term.cols) ?? '') === '') row--
  if (row < top) return null
  const lastRow = row
  // Every line of the paint but its top one, bottom up, is xterm's line there.
  for (let i = last; i >= 1; i--) {
    if (row < 0) return null
    const held = heldLine(term, row)
    if (!held || held.text !== lines[i]) return null
    row = held.start - 1
  }
  if (row < 0) return null
  // The console's top line is xterm's line above them, or its end.
  const above = heldLine(term, row)
  if (!above) return null
  const first = lines[0]
  let topRows: number | null
  if (first === '') topRows = above.text === '' ? 1 : null
  else topRows = above.text.endsWith(first) ? rowsOfEnd(term, above, first.length) : null
  if (topRows === null) return null
  // Scroll xterm's rows up until the paint's second line lands where xterm
  // holds it. A paint that would need them down is not placed this way (a
  // narrowing's paint is tried by bringRowsDown, below), and one that needs
  // more rows than the screen has is not this terminal's screen: neither is
  // placed here.
  const secondRow = above.end + 1
  const scroll = secondRow - topRows - top
  if (scroll < 0 || scroll > term.rows) return null
  if (topRows + (lastRow - secondRow + 1) + blankBelow > term.rows) return null
  let out = '\x1b[?25l'
  if (scroll > 0) out += `\x1b[${term.rows};1H` + '\n'.repeat(scroll)
  // Onto the top line's last row, past its text: the line break that follows
  // it in the paint takes the cursor to the second line's row.
  out += `\x1b[${topRows};1H` + read.topKeep + paint.slice(read.topEnd)
  return out
}

/** How many lines with text the paint's top lines and xterm's rows must share
 *  before xterm's rows above them are moved to its scrollback. */
const MIN_TOP_LINES_WITH_TEXT = 2

/** The line that starts on row `start` (an absolute row) and the rows wrapped
 *  on to it. Null when `start` is itself a wrapped row, past MAX_ROWS_PER_LINE
 *  rows, or a row that is not there. */
function lineFrom(term: RepaintTerminal, start: number): HeldLine | null {
  const buf = term.buffer.active
  const first = buf.getLine(start)
  if (!first || first.isWrapped) return null
  let end = start
  while (buf.getLine(end + 1)?.isWrapped) {
    end++
    if (end - start > MAX_ROWS_PER_LINE) return null
  }
  let text = ''
  for (let y = start; y <= end; y++) text += buf.getLine(y)!.translateToString(y === end, 0, term.cols)
  return { start, end, text: text.trimEnd() }
}

/**
 * A paint whose top lines xterm holds lower on its screen (a program that drew
 * its screen again at the new size, such as Claude Code: the console's paint
 * starts at its banner while xterm holds the shell's rows above it): xterm's
 * rows above those lines go to its scrollback, and the paint is written as it
 * came. The lines are found top down, from xterm's top row (a match there is a
 * paint already in place: null) to the row above its cursor: the first row
 * where the paint's top line starts and the lines after it are xterm's lines
 * after it, at least MIN_TOP_LINES_WITH_TEXT of them with text, before the
 * first line that differs (a line the program drew again at the new width) or
 * the cursor's row (xterm does not re-wrap it). Rows above the first such row
 * are not on the console's screen, so none of them is painted again. Null when
 * there is no such row.
 */
function keepRowsAboveTop(read: Paint, paint: string, term: RepaintTerminal): string | null {
  const buf = term.buffer.active
  const { lines } = read
  if (lines.length > term.rows || !Number.isInteger(buf.cursorY)) return null
  const top = buf.baseY
  const cursorRow = top + buf.cursorY
  for (let start = top; start < cursorRow; start++) {
    if (topLinesHeldFrom(lines, term, start, cursorRow) < MIN_TOP_LINES_WITH_TEXT) continue
    if (start === top) return null
    return '\x1b[?25l' + `\x1b[${term.rows};1H` + '\n'.repeat(start - top) + paint
  }
  return null
}

/** How many of the paint's top lines with text are xterm's lines from row
 *  `start` (an absolute row) on, in order: up to the first line that differs,
 *  a row that is not a line's first, or a line that reaches the cursor's row
 *  (xterm does not re-wrap it). */
function topLinesHeldFrom(lines: readonly string[], term: RepaintTerminal, start: number, cursorRow: number): number {
  let row = start
  let withText = 0
  for (const line of lines) {
    const held = lineFrom(term, row)
    if (!held || held.end >= cursorRow || held.text !== line) break
    if (line !== '') withText++
    row = held.end + 1
  }
  return withText
}

/**
 * A narrowing's paint: the console's whole screen, whose top lines xterm holds
 * just above its screen (the rows its re-wrap moved up into its scrollback).
 * xterm's rows are brought down until the paint's top line is on xterm's top
 * row, and the paint is written as it came. xterm brings rows down out of its
 * scrollback only when its screen gains rows while its cursor is on its last
 * row (Buffer.resize): its screen is cut to its cursor's row, then given its
 * rows back, each one brought down; the rows brought down past the paint's top
 * line go up again by line breaks on its bottom row. The rows its screen gives
 * up (below its cursor, and at its bottom) are rows the paint writes over when
 * it is written as it came too, as it writes every row of the screen: nothing
 * that path keeps is lost here but the rows it would show twice. Found from
 * the row just above xterm's screen up (the fewest rows brought down), at most
 * as many rows as xterm's screen has below its cursor (the most this brings
 * down). Null, before anything is changed, for a paint already in place, one
 * that takes fewer or more rows than the screen has (each line counted by the
 * rows it takes at this width, rowsOfPaint: the console writes a line longer
 * than a row with no line break inside it), or one found nowhere there.
 *
 * The two sizes are xterm's own resize. It clears a selection whenever its
 * rows change (SelectionService), and a view the user has scrolled up moves up
 * one row for each row brought down (Buffer.resize). Every row above the
 * cursor's keeps its place in the buffer, and the paint writes the lines it
 * was found by on the rows that held them, so the selection is selected again
 * where it was, its columns cut to the screen's width (xterm reads one that
 * runs past it to the row's end), and the view is put back on the row it started on
 * (putViewBack), once the paint is written (`settle`: the line breaks that
 * scroll the rows brought down back up do not move a view the user has
 * scrolled up) and, when its row is above xterm's screen already, at once too.
 */
function bringRowsDown(read: Paint, paint: string, term: RepaintTerminal): Placement | null {
  const buf = term.buffer.active
  const { lines } = read
  const { cols, rows } = term
  const cursorY = buf.cursorY
  if (!Number.isInteger(cursorY) || rowsOfPaint(read, cols) !== rows) return null
  const top = buf.baseY
  const cursorRow = top + cursorY
  if (topLinesHeldFrom(lines, term, top, cursorRow) >= MIN_TOP_LINES_WITH_TEXT) return null
  for (let down = 1; down <= Math.min(top, rows - 1 - cursorY); down++) {
    if (topLinesHeldFrom(lines, term, top - down, cursorRow) < MIN_TOP_LINES_WITH_TEXT) continue
    const view = buf.viewportY
    const selection = term.hasSelection?.() ? term.getSelectionPosition?.() : undefined
    term.resize(cols, cursorY + 1)
    term.resize(cols, rows)
    try {
      if (selection) { const from = Math.min(selection.start.x, cols); const to = Math.min(selection.end.x, cols); term.select?.(from, selection.start.y, (selection.end.y - selection.start.y) * cols + to - from) }
    } catch { /* the selection stays cleared */ }
    const settle = view < top ? () => putViewBack(term, view) : undefined
    // Now when its row is above xterm's screen again; else only once the line
    // breaks below have made room (moved to the bottom now, it would count as
    // back at the bottom: TerminalView's onScroll).
    if (settle && view < term.buffer.active.baseY) settle()
    const up = top - term.buffer.active.baseY - down
    return { out: up > 0 ? '\x1b[?25l' + `\x1b[${rows};1H` + '\n'.repeat(up) + paint : paint, settle }
  }
  return null
}

/** Puts a view the user has scrolled up back on row `view` (a row of the
 *  buffer, not of the screen; on the bottom row when the buffer's scrollback
 *  ends above it). The app's xterm moves its view by its scroll bar, which its
 *  own resize does not move: the step up makes it take the view from there
 *  first, so the move to `view` lands on that row in both xterms. */
function putViewBack(term: RepaintTerminal, view: number): void {
  try {
    term.scrollLines(-1)
    term.scrollToLine(view)
  } catch { /* the view stays where it is */ }
}

export interface ConsoleRepaintAligner {
  /** A size was just sent to the console: its paint may follow. */
  noteResize(): void
  /** Writes output to the terminal in order; the console's paint after a size
   *  where its lines are. `parsed` runs once all of `data` is parsed. `asIs`:
   *  output that is not the console's answer to a size (a held terminal's
   *  replay of what it printed before), written in order and as it came. */
  write(data: string, parsed?: () => void, asIs?: boolean): void
}

export function createConsoleRepaintAligner(term: RepaintTerminal, opts: { now: () => number }): ConsoleRepaintAligner {
  let lookUntil = Number.NEGATIVE_INFINITY
  /** A paint waits for the output before it to be parsed: later output
   *  waits behind it, in order. */
  let waiting = false
  const queue: Array<{ data: string; parsed?: () => void; asIs?: boolean }> = []

  const drain = (): void => {
    while (!waiting && queue.length > 0) {
      const next = queue.shift()!
      try { put(next.data, next.parsed, next.asIs) } catch { next.parsed?.() }
    }
  }

  const put = (data: string, parsed?: () => void, asIs?: boolean): void => {
    const start = !asIs && opts.now() <= lookUntil ? PAINT_START.exec(data) : null
    const at = start ? start.index : -1
    const end = start ? data.indexOf(PAINT_END, at + start[0].length) : -1
    if (end < 0) {
      term.write(data, parsed)
      return
    }
    const stop = end + PAINT_END.length
    const paint = data.slice(at, stop)
    const rest = data.slice(stop)
    waiting = true
    // The paint is read against the terminal once what came before it is on
    // the screen: xterm parses a write on a later task. xterm refuses a write
    // once about 50 MB waits to be parsed: a refused piece is lost, as before
    // the aligner; nothing is thrown into xterm's write loop and no caller is
    // left waiting.
    try {
      term.write(data.slice(0, at), () => {
        let placed: Placement | null = null
        try { placed = placeConsoleRepaint(paint, term) } catch { placed = null }
        waiting = false
        try { term.write(placed?.out ?? paint, placed?.settle) } catch { /* xterm refused it: lost either way */ }
        try { put(rest, parsed) } catch { parsed?.() }
        drain()
      })
    } catch (err) {
      // The output before the paint was refused: later output is not held
      // behind it, and this write's caller is told, as before the aligner.
      waiting = false
      throw err
    }
  }

  return {
    noteResize() { lookUntil = opts.now() + REPAINT_WINDOW_MS },
    write(data, parsed, asIs) {
      if (waiting) queue.push({ data, parsed, asIs })
      else put(data, parsed, asIs)
    },
  }
}
