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
 * it, its cursor too. A paint that does not match (another program's screen,
 * a size that changed again, a shape not seen) is written as it came, as
 * before.
 *
 * Not handled, written as it came, as before (a grow can then still lose
 * lines):
 *  - a paint made while the program has the cursor hidden: the console sends
 *    neither `ESC[?25l` nor `ESC[?25h` around it (M1's g-cctrust-* streams);
 *  - a cursor on a wrapped line (a command longer than a row typed at the
 *    prompt, Claude Code's input row under its full-width rule): xterm does
 *    not re-wrap the line its cursor is on, the console does, so that line
 *    does not match;
 *  - a program that draws its screen again at the new size before the
 *    console paints (M1's g-ccmain-* streams, 8 ms after the size).
 * Not measured: a narrowing right after a grow with no output between. xterm
 * then keeps the blank rows under its cursor and moves its rows up into its
 * scrollback; a console that fills its blank rows sends a paint that would
 * need xterm's rows moved down, and it is written as it came.
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
      getLine(y: number): RepaintLine | undefined
    }
  }
  write(data: string, callback?: () => void): void
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
      text = ''
      i += 2
      continue
    }
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return null
    text += paint[i]
    i++
  }
  lines.push(text.trimEnd())
  if (topEnd < 0) topEnd = body
  return { lines, topEnd, topKeep, placesCursor }
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
 * terminal as it is once everything before the paint is written.
 */
export function alignConsoleRepaint(paint: string, term: RepaintTerminal): string | null {
  const buf = term.buffer.active
  if (buf.type !== 'normal') return null
  const read = readPaint(paint)
  if (!read) return null
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
  // holds it. A paint that would need them down cannot be placed (rows do not
  // come back down out of xterm's scrollback), and one that needs more rows
  // than the screen has is not this terminal's screen: both are written as
  // they came.
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
        let out: string | null = null
        try { out = alignConsoleRepaint(paint, term) } catch { out = null }
        waiting = false
        try { term.write(out ?? paint) } catch { /* xterm refused it: lost either way */ }
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
