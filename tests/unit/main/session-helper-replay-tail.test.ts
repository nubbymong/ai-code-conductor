/**
 * The last of a replay a tab is shown after the line saying earlier output is
 * not shown (2.1.3-beta.12, plan section A1; src/main/session-helper/replay-tail.ts),
 * checked against xterm.js itself (@xterm/headless, the tab's terminal): rows
 * are never counted fewer than the terminal takes, the cut never lands inside
 * an escape sequence, a line of the budget's rows or more (or one followed only
 * by empty rows) is cut inside, a wrapped line under it is otherwise left out
 * whole, and the left-out part's alternate screen and input modes are carried
 * across the cut.
 *
 * 2.1.3-beta.13, plan section A2 (aicc_planning#374): given the tab's rows,
 * the cursor's row is followed too, so a Windows console's wrapped line (the
 * recorded one in tests/fixtures/replay/) counts the rows the tab gives it,
 * a cut lands at the start of a console's line, not on its second or third
 * row, and random streams of cursor moves, saves, both screens, scroll
 * regions and origin mode (fixed seeds) never count fewer rows than the tab
 * adds, the whole stream and what follows a cut alike.
 *
 * 2.1.3-beta.13, plan section A4 (aicc_planning#382): given a gap too, the
 * answer says where the tab's scrollback may be cleared (the start of the
 * newest row a line feed added at most the gap after the cut); written as
 * helper-pty.ts writes it (the notice on the row above the last), the notice
 * is the first row the tab keeps, a wrap's row leaves the rest above the
 * notice, the alternate screen gets no clear, and on the random streams the
 * rows from the notice on are the same with the clear and without; on
 * hand-built streams that write where the count does not follow the cursor
 * (origin mode set or reset, a restore after a soft reset), every row that is
 * not empty is kept. A soft reset in the left-out part leaves the carried
 * modes as it leaves the tab's.
 *
 * Not checked here: a program's own tab stops, a backspace at a row's end
 * with reverse wraparound set, and a repeat after a sequence the tab ignores
 * (the exceptions replay-tail.ts names); combining characters, emoji and an
 * autowrap turned off (counted wider: more rows, but for the exception
 * replay-tail.ts names for the rows given); the erase
 * of the screen above the cursor (CSI 1 J, left out of the random streams; no
 * erase moves the cursor or adds a row in the tab); a terminal resized while
 * it reads; where the cut lands in random streams (only that what follows it
 * never takes more rows than counted); a clear after a count that falls short
 * of the tab's (the exceptions replay-tail.ts names: it would drop the
 * notice, and a kept row more for each further row short); a tab that showed
 * anything before the notice (helper-pty.ts gives no gap then).
 */
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'
import fs from 'fs'
import path from 'path'
import { columns, replayTail, rowsOf } from '../../../src/main/session-helper/replay-tail'
import { TERMINAL_SCROLLBACK_LINES } from '../../../src/shared/terminal-scrollback'

/** The rows the tab's terminal takes for `text`, written to a new one: its normal screen's lines down to the cursor. */
async function rowsTaken(text: string, cols: number): Promise<number> {
  // The log off: a string the tab ends in error would print xterm.js's parse error to stderr, for nothing.
  const term = new Terminal({ cols, rows: 24, scrollback: 100_000, allowProposedApi: true, logLevel: 'off' })
  try {
    await new Promise<void>((res) => term.write(text, res))
    const b = term.buffer.normal
    return b.baseY + b.cursorY + 1
  } finally {
    term.dispose()
  }
}

/** The tab's terminal after `text`, 80 by 24: the screen in use, its normal screen's lines, and the cursor. */
async function screenAfter(text: string): Promise<{ type: string; normal: string[]; x: number; y: number }> {
  const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true })
  try {
    await new Promise<void>((res) => term.write(text, res))
    const b = term.buffer.normal
    const normal: string[] = []
    for (let i = 0; i < b.length; i++) normal.push(b.getLine(i)?.translateToString(true) ?? '')
    return { type: term.buffer.active.type, normal, x: term.buffer.active.cursorX, y: term.buffer.active.cursorY }
  } finally {
    term.dispose()
  }
}

/** `n` numbered lines, from 1. */
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}\r\n`).join('')

/** A stand-in for the notice helper-pty.ts writes. */
const NOTICE = '[the notice]'

/** The tab's input modes after `text`, in a new terminal 80 by 24. */
async function modesAfter(text: string): Promise<Record<string, unknown>> {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, logLevel: 'off' })
  try {
    await new Promise<void>((res) => term.write(text, res))
    return { ...term.modes }
  } finally {
    term.dispose()
  }
}

/** The column the tab's terminal is at after `text`. */
async function cursorAfter(text: string, cols: number): Promise<number> {
  const term = new Terminal({ cols, rows: 24, allowProposedApi: true })
  try {
    await new Promise<void>((res) => term.write(text, res))
    return term.buffer.active.cursorX
  } finally {
    term.dispose()
  }
}

describe('rows, counted as the tab counts them', () => {
  it('each control that moves down a row counts one: line feed, vertical tab, form feed, index and next line, 7-bit and 8-bit', async () => {
    const text = 'a\nb\x0bc\x0cd\x1bDe\x1bEf\x84g\x85h'
    expect(await rowsTaken(text, 80)).toBe(8)
    expect(rowsOf(text, 80)).toBe(8)
  })

  it('a bare line feed keeps the column, as in the tab, so 70-column lines ending in a line feed alone take more rows', async () => {
    const text = `${'x'.repeat(70)}\n`.repeat(40)
    const tab = await rowsTaken(text, 80)
    expect(tab).toBeGreaterThan(41)
    expect(rowsOf(text, 80)).toBe(tab)
  })

  it('the wide characters of the tab\'s Unicode 6 table count two columns, the others one', async () => {
    for (const cp of [0x1100, 0x2329, 0x232a, 0x2e80, 0x3000, 0xac00, 0xf900, 0xfe10, 0xfe19, 0xfe30, 0xfe50, 0xfe6f, 0xff01, 0xffe0, 0x20000]) {
      expect(await cursorAfter(String.fromCodePoint(cp), 80), cp.toString(16)).toBe(2)
      expect(columns(cp), cp.toString(16)).toBe(2)
    }
    for (const cp of [0x41, 0xe9, 0x303f, 0xfe1a, 0xfe70, 0xff61]) {
      expect(await cursorAfter(String.fromCodePoint(cp), 80), cp.toString(16)).toBe(1)
      expect(columns(cp), cp.toString(16)).toBe(1)
    }
  })

  it('a wide character that does not fit the last column wraps early', async () => {
    const text = String.fromCodePoint(0x4e2d).repeat(81)
    expect(await rowsTaken(text, 81)).toBe(3)
    expect(rowsOf(text, 81)).toBe(3)
  })

  it('a tab moves to the next multiple of 8 and stops at the last column', async () => {
    for (const text of [`${'\t'.repeat(20)}x`, `00001\t\t\t\t${'x'.repeat(9)}`]) {
      expect(rowsOf(text, 40), JSON.stringify(text)).toBe(await rowsTaken(text, 40))
    }
    expect(rowsOf(`${'\t'.repeat(20)}x`, 40)).toBe(1)
    expect(rowsOf(`00001\t\t\t\t${'x'.repeat(9)}`, 40)).toBe(2)
  })

  it('escape sequences take no width, 7-bit and 8-bit, and a line feed inside a CSI still moves down a row', async () => {
    for (const [text, rows] of [
      [`${'x'.repeat(79)}\x1b[38;5;1m\x9b0my`, 1],
      [`${'x'.repeat(79)}\x1b]0;a title\x07\x9d0;more\x9cy`, 1],
      ['\x1b[3\n1mz', 2],
    ] as const) {
      expect(await rowsTaken(text, 80), JSON.stringify(text)).toBe(rows)
      expect(rowsOf(text, 80), JSON.stringify(text)).toBe(rows)
    }
  })

  it('a line feed inside an OSC, DCS, SOS, PM or APC string does nothing, and BEL, ST, CAN or SUB ends the string; a character past U+009F ends a SOS, PM or APC string, or a DCS one before its final byte, and what follows is text, but not a DCS string the tab ignores to its end', async () => {
    const x = 'x'.repeat(200)
    for (const [text, rows] of [
      ['\x1b]0;a\nb\x07x', 1],
      ['\x1bPq\nab\x1b\\x', 1],
      ['\x1b_\n\x1b\\x', 1],
      ['\x1bX\n\x9cx', 1],
      ['\x90q\n\x9cx', 1],
      ['\x1b]0;t\x18\r\nline', 2],
      ['\x1b]0;t\x1a\r\nline', 2],
      ['\x1bPq\x18\r\nline', 2],
      // Ended in error by the character past U+009F: the 200 characters and the line feeds after it are text.
      [`\x1b_abc\u00e9${x}\x1b\\end`, 3],
      [`\x9fabc\u00e9${x}\x9cend`, 3],
      [`\x1b^\u00e9${x}\x1b\\end`, 3],
      [`\x1bX\u4e2d${x}\x1b\\end`, 3],
      [`\x1b_${String.fromCodePoint(0x1f600)}${x}\x1b\\end`, 3],
      ['\x1b_\u00e9a\r\nb\r\nc\x1b\\end', 3],
      [`\x1bP\u00e9${x}\x1b\\end`, 3],
      [`\x1bP1;2\u00e9${x}\x1b\\end`, 3],
      [`\x1bP$\u00e9${x}\x1b\\end`, 3],
      [`\x90\u00e9${x}\x9cend`, 3],
      // Not ended: a string of ASCII only, a DCS string past its final byte, an OSC string, and a DCS string the tab
      // ignores to its end (a prefix after a parameter, a parameter after an intermediate), whose carriage return
      // does not move the column either.
      [`\x1b_Gf=100;AAAA${x}\x1b\\end`, 1],
      [`\x1bPq\u00e9${x}\x1b\\end`, 1],
      [`\x1b]0;\u00e9${x}\x07end`, 1],
      [`\x1bP1?\u00e9${x}\x1b\\end`, 1],
      [`\x1bP$1\u00e9${x}\x1b\\end`, 1],
      [`${'x'.repeat(70)}\x1bP1?\u00e9\r\x1b\\${'y'.repeat(20)}`, 2],
    ] as const) {
      expect(await rowsTaken(text, 80), JSON.stringify(text)).toBe(rows)
      expect(rowsOf(text, 80), JSON.stringify(text)).toBe(rows)
    }
  })

  it('the moves that set the column are followed: CSI C, G and H, a repeat, a cursor saved and restored', async () => {
    // On the cursor's own row: a move down the screen takes no row of the scrollback, so the tab's count here would differ.
    for (const text of [
      `abc\x1b[70C${'x'.repeat(20)}`,
      `${'x'.repeat(75)}\x1b[5G${'y'.repeat(10)}`,
      `${'x'.repeat(75)}\x1b[1;5H${'y'.repeat(10)}`,
      `${'x'.repeat(10)}\x1b[1;71H${'y'.repeat(20)}`,
      'a\x1b[200b',
      `${'x'.repeat(70)}\x1b7\r\x1b8${'y'.repeat(20)}`,
      `${'x'.repeat(70)}\x1b[s\r\x1b[u${'y'.repeat(20)}`,
      `${'x'.repeat(70)}\b\b\b\b${'y'.repeat(14)}`,
    ]) {
      expect(rowsOf(text, 80), JSON.stringify(text)).toBe(await rowsTaken(text, 80))
    }
    expect(rowsOf('a\x1b[200b', 80)).toBe(3)
    expect(rowsOf(`${'x'.repeat(70)}\x1b7\r\x1b8${'y'.repeat(20)}`, 80)).toBe(2)
  })

  it('a sub-parameter (after a colon) belongs to the parameter before it, as in the tab: CSI 1:3;70H is column 70', async () => {
    for (const text of [`\x1b[1:3;70H${'y'.repeat(20)}`, `\x1b[:5;70H${'y'.repeat(20)}`, `\x1b[1:2:3;70f${'y'.repeat(20)}`]) {
      expect(rowsOf(text, 80), JSON.stringify(text)).toBe(await rowsTaken(text, 80))
    }
    expect(rowsOf(`\x1b[1:3;70H${'y'.repeat(20)}`, 80)).toBe(2)
  })

  it('what a program writes on the alternate screen adds no row, its line feeds and its wraps alike, and leaving it restores the column', async () => {
    const text = `a\r\n\x1b[?1049h${'x\r\n'.repeat(100)}${'y'.repeat(500)}\x1b[?1049lb\r\n`
    expect(await rowsTaken(text, 80)).toBe(3)
    expect(rowsOf(text, 80)).toBe(3)
  })

  it('a mixed stream is never counted fewer rows than the tab takes', async () => {
    const parts = [
      'plain line\r\n', 'bare\n', `${'w'.repeat(95)}\r\n`, '\x1b[1;31mred\x1b[0m\r\n', '\t\ttabbed\r\n',
      `${String.fromCodePoint(0x4e2d).repeat(50)}\r\n`, '\x1b]0;title\nwith a break\x07after\r\n', 'a\x1bDb\x1bEc\r\n',
      'ff\x0cvt\x0bend\r\n', `${'z'.repeat(60)}\x1b[30C${'z'.repeat(10)}\r\n`, '\x1b[?25l\x1b[?25h\r\n', `emoji ${String.fromCodePoint(0x1f600)}\r\n`,
    ]
    let text = ''
    for (let i = 0; i < 300; i++) text += parts[(i * 7) % parts.length]
    for (const cols of [10, 37, 80, 132]) {
      expect(rowsOf(text, cols), `${cols} columns`).toBeGreaterThanOrEqual(await rowsTaken(text, cols))
    }
  })
})

describe('where the cut lands', () => {
  it('all of it fits: nothing left out, nothing carried', () => {
    expect(replayTail('one\r\ntwo\r\n', 80, 10)).toEqual({ from: 0, left: 0, part: false, before: '', after: '' })
  })

  it('lines of one row: the newest that fit, with the cursor\'s row', () => {
    const text = 'line\r\n'.repeat(100)
    const t = replayTail(text, 80, 10)
    expect(t).toMatchObject({ from: 91 * 6, left: 91, part: false })
    expect(rowsOf(text.slice(t.from), 80)).toBe(10)
  })

  it('a last line that alone takes more rows than the budget is cut inside, at the start of one of its rows', () => {
    const text = `${'a\r\n'.repeat(5)}${'x'.repeat(100)}`
    // Ten rows of ten: the last three start at its 71st character.
    expect(replayTail(text, 10, 3)).toMatchObject({ from: 15 + 70, left: 5, part: true })
  })

  it('an earlier line that alone takes more rows than the budget is cut inside, so the rows after it are filled', () => {
    const text = `p\r\n${'x'.repeat(100)}\r\n$ `
    // The prompt's row, and the last three of the long line's ten.
    expect(replayTail(text, 10, 4)).toMatchObject({ from: 3 + 70, left: 1, part: true })
  })

  it('a line that takes the budget\'s rows exactly, then a line break at the end: cut inside, so the tab is not shown the notice alone', () => {
    const text = `${'x'.repeat(30)}\r\n`
    const t = replayTail(text, 10, 3)
    expect(t).toMatchObject({ from: 10, left: 0, part: true })
    expect(rowsOf(text.slice(t.from), 10)).toBe(3)
  })

  it('a line under the budget followed only by empty rows at the end: cut inside, so the tab is not shown only empty rows', () => {
    const text = `${'x'.repeat(20)}\r\n\r\n`
    const t = replayTail(text, 10, 3)
    expect(t).toMatchObject({ from: 10, left: 0, part: true })
    expect(rowsOf(text.slice(t.from), 10)).toBe(3)
  })

  it('a wrapped line that takes fewer rows than the budget is left out whole, not cut', () => {
    const text = `${'y'.repeat(30)}\r\n`.repeat(4)
    expect(replayTail(text, 10, 8)).toMatchObject({ from: 64, left: 2, part: false })
  })

  it('the cut never lands inside an escape sequence: a line feed in a CSI or an OSC string is no line start', () => {
    const old = 'old\r\n'.repeat(50)
    const csi = `${old}\x1b[3\n1mred\r\n${'new\r\n'.repeat(5)}`
    const t = replayTail(csi, 80, 7)
    expect(csi.slice(t.from).startsWith('new\r\n')).toBe(true)
    expect(rowsOf(csi.slice(t.from), 80)).toBeLessThanOrEqual(7)
    const osc = `${old}\x1b]0;a\nb\nc\x07title line\r\n${'new\r\n'.repeat(5)}`
    expect(osc.slice(replayTail(osc, 80, 7).from)).toBe(`\x1b]0;a\nb\nc\x07title line\r\n${'new\r\n'.repeat(5)}`)
  })

  it('the cut never lands on the alternate screen: what a program drew there takes no row, so its start is kept', () => {
    const program = `\x1b[?1049h\x1b[?1h${'\x1b[H'.concat('screen\r\n'.repeat(23)).repeat(600)}`
    const text = `${'shell\r\n'.repeat(12_000)}${program}`
    const t = replayTail(text, 80, 9_000)
    expect(text.slice(t.from).endsWith(program)).toBe(true)
    expect(t.from).toBe((12_000 - 8_999) * 7)
    expect(t).toMatchObject({ before: '', after: '' })
  })
})

describe('what the left-out part carries across the cut', () => {
  const lines = 'line\r\n'.repeat(50)

  it('the input modes it set or reset, each at its last value, in the order of their last change; ESC = and ESC > as the keypad mode', () => {
    const t = replayTail(`\x1b[?2004h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1000l\x1b=\x1b[?1;1006h${lines}`, 80, 5)
    expect(t.before).toBe('')
    expect(t.after).toBe('\x1b[?2004h\x1b[?25l\x1b[?1002h\x1b[?1000l\x1b[?66h\x1b[?1h\x1b[?1006h')
    expect(replayTail(`\x1b>${lines}`, 80, 5).after).toBe('\x1b[?66l')
  })

  it('no mode that moves the cursor or changes the screen: origin, column mode, synchronized output, the cursor save; no other prefix, no intermediates', () => {
    expect(replayTail(`\x1b[?6h\x1b[?3h\x1b[?2026h\x1b[?1048h\x1b[>1h\x1b[?1$h\x1b[4h${lines}`, 80, 5)).toMatchObject({ before: '', after: '' })
  })

  it('the alternate screen left in the left-out part: left before the notice, so the notice is on the normal screen', () => {
    expect(replayTail(`\x1b[?1000l\x1b[?1l\x1b[?1049l${lines}`, 80, 5)).toMatchObject({ before: '\x1b[?1049l', after: '\x1b[?1000l\x1b[?1l' })
    expect(replayTail(`\x1b[?47l${lines}`, 80, 5).before).toBe('\x1b[?47l')
  })

  it('the alternate screen entered and left again in the left-out part: left all the same, with 47, which restores no cursor', () => {
    expect(replayTail(`\x1b[?1049h${'x\r\n'.repeat(30)}\x1b[?1049l${lines}`, 80, 5)).toMatchObject({ before: '\x1b[?47l', after: '' })
  })

  it('a tab still on the alternate screen (its leave no longer held), the left-out part entering and leaving it again: the tab ends on the normal screen with the notice there; on a tab already on the normal screen, the leave changes nothing', async () => {
    const replay = `${'old\r\n'.repeat(20)}\x1b[?1049h${'\x1b[Hprogram B\r\n'.repeat(5)}\x1b[?1049l${numbered(100)}`
    const t = replayTail(replay, 80, 40)
    const piece = (before: string) => `\x18${before}\x1b[0m\r\n${NOTICE}\r\n${t.after}${replay.slice(t.from)}`
    const onAlternate = await screenAfter(`shell\r\n\x1b[?1049h\x1b[Hprogram A\r\n${piece(t.before)}`)
    expect(onAlternate.type).toBe('normal')
    expect(onAlternate.normal).toContain(NOTICE)
    expect(onAlternate.normal).toContain('line 100')
    expect(t).toMatchObject({ before: '\x1b[?47l', after: '' })
    const shell = numbered(40)
    expect(await screenAfter(`${shell}${piece(t.before)}`)).toEqual(await screenAfter(`${shell}${piece('')}`))
  })

  it('a full reset: the normal screen and the modes as they start', () => {
    expect(replayTail(`\x1b[?1h\x1bc${lines}`, 80, 5)).toMatchObject({
      before: '\x1b[?47l',
      after: '\x1b[?1l\x1b[?7h\x1b[?25h\x1b[?45l\x1b[?66l\x1b[?1000l\x1b[?1004l\x1b[?1006l\x1b[?2004l',
    })
  })

  it('a soft reset (CSI ! p, with parameters or none): the input modes as it leaves them, the mouse modes kept, as in the tab; with another intermediate or a prefix it is no soft reset', async () => {
    const replay = `\x1b[?1000h\x1b[?1006h\x1b[?1h\x1b[?2004h\x1b[?25l\x1b[?45h\x1b=\x1b[?1004h\x1b[?7l\x1b[!p${lines}`
    const t = replayTail(replay, 80, 5)
    expect(t).toMatchObject({ before: '', after: '\x1b[?1000h\x1b[?1006h\x1b[?1l\x1b[?7h\x1b[?25h\x1b[?45l\x1b[?66l\x1b[?1004l\x1b[?2004l' })
    // The tab left as the whole replay leaves it: the notice, what is carried, then what follows the cut.
    expect(await modesAfter(`\x18\x1b[0m\r\n${NOTICE}\r\n${t.after}${replay.slice(t.from)}`)).toEqual(await modesAfter(replay))
    expect(replayTail(`\x1b[?1h\x1b[5!p${lines}`, 80, 5).after).toBe('\x1b[?1l\x1b[?7h\x1b[?25h\x1b[?45l\x1b[?66l\x1b[?1004l\x1b[?2004l')
    for (const not of ['\x1b[!!p', '\x1b[?!p', '\x1b[!"p']) expect(replayTail(`\x1b[?1h${not}${lines}`, 80, 5).after, JSON.stringify(not)).toBe('\x1b[?1h')
  })

  it('only what comes before the cut: a mode set in the part that is shown is not carried', () => {
    expect(replayTail(`${lines}\x1b[?2004h${'x\r\n'.repeat(3)}`, 80, 5).after).toBe('')
  })
})

describe("the cursor's row followed, with the tab's rows given (2.1.3-beta.13, plan section A2)", () => {
  const FIXTURE = path.resolve(__dirname, '..', '..', 'fixtures', 'replay', 'conpty-wrapped-lines-103x27.json')
  const recorded = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cols: number; rows: number; lines: number; text: string }

  /** The rows a terminal `cols` by `rows` adds to its scrollback while it reads `text`, after `before`. */
  async function added(text: string, cols: number, rows: number, before = ''): Promise<number> {
    const term = new Terminal({ cols, rows, scrollback: 100_000, allowProposedApi: true, logLevel: 'off' })
    try {
      let start = 0
      await new Promise<void>((res) => {
        term.write(before, () => { start = term.buffer.normal.baseY })
        term.write(text, res)
      })
      return term.buffer.normal.baseY - start
    } finally {
      term.dispose()
    }
  }
  /** Puts a new terminal's cursor on its last row, where the count starts it. */
  const atLastRow = (rows: number) => '\n'.repeat(rows - 1)
  const lines = (n: number, s = 'y') => `${s}\r\n`.repeat(n)

  it('the recorded console line: 3 rows a line at the 27 rows it was made for, as the tab gives it; 5 at 26, 1 at 28; 5 with no rows given, as before', async () => {
    const { text, cols } = recorded
    expect(recorded).toMatchObject({ cols: 103, rows: 27, lines: 27 })
    for (const [rows, perLine] of [[27, 3], [26, 5], [28, 1]] as const) {
      // The tab's own count once its screen scrolls, the recording written once before it.
      expect(await added(text, cols, rows, text), `${rows} rows`).toBe(27 * perLine)
      expect(rowsOf(text, cols, rows) - 1, `${rows} rows`).toBe(27 * perLine)
    }
    expect(rowsOf(text, cols) - 1).toBe(27 * 5)
  })

  it('the recorded fixture holds the console\'s lines and nothing else: no path, no name, checked as the screen corpus is (tests/unit/shared/screen-corpus.test.ts, case 4)', () => {
    const raw = fs.readFileSync(FIXTURE, 'utf8')
    expect(recorded.text.replace(/\r\n|\x1b\[26;103H/g, '')).toMatch(/^(long \d+ y+|y+)+$/)
    // The corpus's checks: a home folder but the generic ones, an e-mail shape, a key shape.
    for (const m of raw.matchAll(/(?:\b[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)([^\\/\s"'<>|:*?\x00-\x1f]+)/gi)) expect(['user', 'runneradmin', 'runner']).toContain(m[1].toLowerCase())
    expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/)
    for (const re of [/\bsk-[A-Za-z0-9_-]{16,}/, /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/]) {
      expect(raw).not.toMatch(re)
    }
  })

  it('a line feed or a wrap adds a row only at the last row: a cursor moved up then has rows to come down', async () => {
    for (const text of [
      `${lines(20, 'x')}\x1b[4A${lines(10)}`,
      `\x1b[H${'w'.repeat(800)}`,
      `\x1b[Hx\x1b[799b${lines(12)}`,
      `${lines(5)}\x1b[3A${'w'.repeat(400)}\r\n`,
    ]) {
      expect(rowsOf(text, 80, 10) - 1, JSON.stringify(text)).toBe(await added(text, 80, 10, atLastRow(10)))
    }
    // From the top: ten rows of one line, and no row added.
    expect(rowsOf(`\x1b[H${'w'.repeat(800)}`, 80, 10)).toBe(1)
    expect(rowsOf(`\x1b[H${'w'.repeat(800)}`, 80)).toBe(10)
  })

  it('a cursor moved up is held at the top row: CSI A and F past the top, and ESC M at it', async () => {
    for (const text of [`\x1b[100A${lines(15)}`, `\x1b[100F${lines(15)}`, `${'\x1bM'.repeat(30)}${lines(15)}`, `\x1b[3A\x1b[3A\x1b[3A\x1b[3A${lines(15)}`]) {
      expect(rowsOf(text, 80, 10) - 1, JSON.stringify(text)).toBe(await added(text, 80, 10, atLastRow(10)))
      expect(rowsOf(text, 80, 10) - 1, JSON.stringify(text)).toBe(6)
    }
  })

  it('ESC M raises it a row; the 8-bit reverse index (0x8d) does not, as the tab ignores it', async () => {
    const seven = `\x1bM\x1bM\x1bM${lines(5)}`
    expect(rowsOf(seven, 80, 10) - 1).toBe(await added(seven, 80, 10, atLastRow(10)))
    expect(rowsOf(seven, 80, 10) - 1).toBe(2)
    const eight = `\x8d\x8d\x8d${lines(5)}`
    expect(await added(eight, 80, 10, atLastRow(10))).toBe(5)
    expect(rowsOf(eight, 80, 10) - 1).toBe(5)
  })

  it('a cursor put on a row (CSI H, f and d) or moved down (CSI B, E and e) is followed', async () => {
    for (const text of [
      `\x1b[3;1H${lines(10)}`, `\x1b[3;5f${lines(10)}`, `\x1b[3d${lines(10)}`, `\x1b[99;1H${lines(10)}`, `\x1b[0;0H${lines(10)}`,
      `\x1b[H\x1b[4B${lines(10)}`, `\x1b[H\x1b[4E${lines(10)}`, `\x1b[H\x1b[4e${lines(10)}`, `\x1b[H\x1b[99B${lines(10)}`, `\x1b[5A\x1b[2B${lines(10)}`,
    ]) {
      expect(rowsOf(text, 80, 10) - 1, JSON.stringify(text)).toBe(await added(text, 80, 10, atLastRow(10)))
    }
    expect(rowsOf(`\x1b[3;1H${lines(10)}`, 80, 10) - 1).toBe(3)
  })

  it('a cursor saved and restored carries its row, on each screen apart', async () => {
    for (const text of [
      `\x1b[H\x1b7${lines(5)}\x1b8${lines(12)}`,
      `\x1b[H\x1b[s${lines(5)}\x1b[u${lines(12)}`,
      `\x1b[H\x1b[?1048h${lines(5)}\x1b[?1048l${lines(12)}`,
      // Saved on the normal screen, then a save of the alternate screen's own: the normal screen's comes back.
      `\x1b[H\x1b7\x1b[?47h\x1b[10;1H\x1b7\x1b[?47l\x1b8${lines(12)}`,
      // 1049 saves the cursor as it enters and puts it back as it leaves.
      `\x1b[H\x1b[?1049h\x1b[10;1H${lines(3)}\x1b[?1049l${lines(12)}`,
    ]) {
      expect(rowsOf(text, 80, 10) - 1, JSON.stringify(text)).toBe(await added(text, 80, 10, atLastRow(10)))
    }
    expect(rowsOf(`\x1b[H\x1b7${lines(5)}\x1b8${lines(12)}`, 80, 10) - 1).toBe(3)
  })

  it('a scroll region that is not the whole screen counts every line feed and wrap, as with no rows given, on its own screen only', async () => {
    const regions = [
      // Its first row the screen's: the rows it scrolls off go to the scrollback.
      `\x1b[1;5r\x1b[H${lines(20)}`,
      // A region on the normal screen stays through a visit to the alternate one.
      `\x1b[1;5r\x1b[?47h\x1b[?47l\x1b[H${lines(20)}`,
      `\x1b[1;5r\x1b[?1049h\x1b[r\x1b[?1049l\x1b[H${lines(20)}`,
      `\x1b[2;8r${lines(30)}`,
      `\x1b[2;8r\x1b[?6h\x1b[3;1H${lines(30)}`,
      // A sub-parameter is no bottom margin: CSI 1:0;5r is rows 1 to 5.
      `\x1b[1:0;5r\x1b[H${lines(20)}`,
    ]
    for (const text of regions) {
      const tab = await added(text, 80, 10, atLastRow(10))
      expect(rowsOf(text, 80, 10), JSON.stringify(text)).toBe(rowsOf(text, 80))
      expect(rowsOf(text, 80, 10) - 1, JSON.stringify(text)).toBeGreaterThanOrEqual(tab)
    }
    expect(await added(regions[1], 80, 10, atLastRow(10))).toBe(16)
    // Followed again once the region is the whole screen, or went with the alternate screen it was set on.
    for (const text of [`\x1b[2;8r${lines(30)}\x1b[r${lines(15)}`, `\x1b[?1049h\x1b[2;5r\x1b[?1049l\x1b[H${lines(20)}`, `\x1b[2;8r\x1b[?47h\x1b[?47l\x1b[r${lines(15)}`]) {
      const tab = await added(text, 80, 10, atLastRow(10))
      expect(rowsOf(text, 80, 10) - 1, JSON.stringify(text)).toBeGreaterThanOrEqual(tab)
      expect(rowsOf(text, 80, 10), JSON.stringify(text)).toBeLessThan(rowsOf(text, 80))
    }
    expect(rowsOf(`\x1b[?1049h\x1b[2;5r\x1b[?1049l\x1b[H${lines(20)}`, 80, 10) - 1).toBe(11)
  })

  it('a line feed above the last row adds no row but starts a line: the cut counts it among the lines left out', async () => {
    const text = `\x1b[H${numbered(30)}`
    // Nine line feeds come down the screen, the other 21 add rows; five rows kept are the last four lines and the cursor's.
    expect(rowsOf(text, 80, 10) - 1).toBe(21)
    expect(await added(text, 80, 10, atLastRow(10))).toBe(21)
    const t = replayTail(text, 80, 5, 10)
    expect(t).toMatchObject({ from: text.indexOf('line 27\r\n'), left: 26, part: false })
    expect(replayTail(text, 80, 5)).toMatchObject({ from: t.from, left: 26, part: false })
  })

  it('a full reset puts the cursor at the top row, and its saved place too, and ends a scroll region', async () => {
    for (const text of [`\x1b[2;8r\x1bc${lines(12)}\x1b8${lines(12)}`, `\x1b7\x1bc${lines(12)}\x1b8${lines(12)}`]) {
      // Nine of each twelve line feeds come down the screen: three rows each.
      expect(await added(text, 80, 10, atLastRow(10)), JSON.stringify(text)).toBe(6)
      expect(rowsOf(text, 80, 10) - 1, JSON.stringify(text)).toBe(6)
    }
  })

  /*
   * A line feed that adds a row and is followed by a cursor moved up before
   * anything is printed starts no line: a Windows console wraps a line so
   * (a line break, then back up to the row above), and a cut at that row
   * would leave the row above with only its last character, under the
   * notice. With the line starts taken back, a cut lands at a console line's
   * first row, and the lines left out are the console's lines.
   */
  /** One line as the console writes it at 103 by 27, 2.5 rows long (the recorded shape: tests/fixtures/replay/). */
  const consoleLine = (n: number) => {
    const text = `long ${n} ${'y'.repeat(250)}`
    const [a, b, c] = [text.slice(0, 103), text.slice(103, 206), text.slice(206)]
    return `${a}\r\n\x1b[26;103H${a.slice(-1)}${b}\r\n\x1b[26;103H${b.slice(-1)}${c}\r\n`
  }

  it('the recorded line is the shape consoleLine writes', () => {
    const first = Number(/^long (\d+) /.exec(recorded.text)![1])
    expect(recorded.text).toBe(Array.from({ length: 27 }, (_, i) => consoleLine(first + i)).join(''))
  })

  it('a cut lands at a console line\'s first row, whatever rows the end takes, and counts the console\'s lines left out; the tab, its cursor on the last row and the notice on the row above (plan section A4), shows the notice, then each kept line on its 3 rows, once the scrollback is cleared where the 25 empty rows above the notice left the screen', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => consoleLine(1000 + i)).join('')
    for (const [end, budget] of [['$ ', 100], ['done\r\n$ ', 100], ['done\r\nmore\r\n$ ', 100], ['$ ', 101], ['$ ', 102]] as const) {
      const text = `${lines}${end}`
      const t = replayTail(text, 103, budget, 27, 25)
      const shown = text.slice(t.from)
      expect(shown, `${JSON.stringify(end)}, ${budget}`).toMatch(/^long \d+ y/)
      expect(t, `${JSON.stringify(end)}, ${budget}`).toMatchObject({ part: false, left: Number(/^long (\d+) /.exec(shown)![1]) - 1000 })
      expect(rowsOf(shown, 103, 27)).toBeLessThanOrEqual(budget)
      // Each console line's 3 rows are each made by a line feed: the 25th row after the cut starts after the 25th line
      // break (the ninth line's first, before its jump back up).
      let at = 0
      for (let k = 0; k < 25; k++) at = shown.indexOf('\r\n', at) + 2
      expect(t.clear, `${JSON.stringify(end)}, ${budget}`).toBe(t.from + at)
      const term = new Terminal({ cols: 103, rows: 27, scrollback: 1000, allowProposedApi: true })
      try {
        await new Promise<void>((res) => term.write(`\x1b[26;1H${NOTICE}\r\n${shown.slice(0, at)}\x1b[3J${shown.slice(at)}`, res))
        const b = term.buffer.normal
        const rows = Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '')
        expect(rows[0]).toBe(NOTICE)
        const first = 1
        expect(rows[first], `${JSON.stringify(end)}, ${budget}`).toMatch(/^long \d+ y{93}$/)
        // Each kept line: its number and 93 y, then 103 y, then 54 y.
        const kept = (shown.match(/long \d+ /g) ?? []).length
        for (let k = 0; k < kept; k++) {
          expect(rows.slice(first + 3 * k, first + 3 * k + 3), `line ${k}`).toEqual([`long ${1400 - kept + k} ${'y'.repeat(93)}`, 'y'.repeat(103), 'y'.repeat(54)])
        }
      } finally {
        term.dispose()
      }
    }
  })

  it('a line feed then a cursor moved up starts no line (CSI A, F, H, d, ESC M, a cursor restored higher); one followed by text first, or by no move up, still does', () => {
    // Saved at the top; 40 lines bring the cursor to the last row; "x" and its line feed add row R; the move; then
    // back on row R, and three lines. Five rows kept from the last: row R is the first, so the cut is at its start
    // when its line feed started a line, and at the line after it when that line feed was taken back.
    const at = (move: string) => `\x1b[H\x1b7${numbered(40)}x\r\n${move}${'y'.repeat(5)}\x1b[10;1H\r\n${numbered(3)}`
    for (const up of ['\x1b[A', '\x1b[F', '\x1b[1;1H', '\x1b[3d', '\x1bM', '\x1b8']) {
      const text = at(up)
      expect(replayTail(text, 80, 5, 10), JSON.stringify(up)).toMatchObject({ from: text.lastIndexOf('line 1\r\n'), left: 41, part: false })
    }
    for (const notUp of ['z\x1b[A', '\x1b[B', '\x1b[10;5H', '\x1b[0m']) {
      const text = at(notUp)
      expect(replayTail(text, 80, 5, 10), JSON.stringify(notUp)).toMatchObject({ from: text.lastIndexOf('x\r\n') + 3, left: 41, part: false })
    }
    // Without the rows: today's line starts, every line feed one.
    const plain = at('\x1b[A')
    expect(replayTail(plain, 80, 5)).toMatchObject({ from: plain.lastIndexOf('x\r\n') + 3, left: 41, part: false })
  })

  /*
   * Random streams, fixed seeds. Each is read at its size and written to a
   * terminal of that size (one per size, a full reset between streams):
   *  1. from a cursor on any row, it adds no more rows than counted;
   *  2. cut for a random budget, what follows the cut, written as helper-pty.ts
   *     writes it to a new tab (the leave, the notice, the cursor put on the
   *     last row, the carried modes), adds no more rows than counted for it.
   * And the rows are used: some streams count fewer rows with them than
   * without.
   */
  const SIZES: Array<[number, number]> = []
  for (const c of [2, 5, 20, 80, 93, 103]) for (const r of [1, 2, 3, 10, 26, 27]) SIZES.push([c, r])

  function streams(seed: number, n: number, o: { alt?: boolean; region?: boolean; reset?: boolean }) {
    let s = seed
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
    const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1))
    const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]
    const token = (cols: number, rows: number): string => {
      const k = rnd()
      if (k < 0.26) return pick(['x', 'ab', 'y'.repeat(int(1, cols + 5)), 'z'.repeat(cols), String.fromCodePoint(0x4e2d).repeat(int(1, 6))])
      if (k < 0.40) return pick(['\r\n', '\n', '\r', '\r\n\r\n', '\x0b', '\x0c', '\x1bD', '\x1bE', '\x84', '\x85', 'q\r\n'.repeat(int(1, rows + 2))])
      if (k < 0.48) return `\x1b[${pick(['', int(0, rows + 3)])}${pick([';', `:${int(0, 9)};`, ''])}${pick(['', int(0, cols + 3)])}${pick(['H', 'f'])}`
      if (k < 0.56) return `\x1b[${pick(['', int(0, rows + 2), int(50, 300)])}${pick(['A', 'B', 'E', 'F', 'e'])}`
      if (k < 0.60) return `\x1b[${pick(['', int(0, rows + 2)])}d`
      if (k < 0.64) return pick(['\x1bM', '\x8d', '\x1bM\x1bM', '\x1bM'.repeat(int(1, rows + 2))])
      if (k < 0.70) return pick(['\x1b7', '\x1b8', '\x1b[s', '\x1b[u', '\x1b[?1048h', '\x1b[?1048l'])
      if (k < 0.74) return `\x1b[${int(0, cols + 2)}${pick(['G', 'C', 'D', '`', 'a'])}`
      if (k < 0.78) return pick(['\t', '\b', '\x1b[2J', '\x1b[K', '\x1b[J', '\x1b[0m', '\x1b[38:2:1:2:3m', `\x1b[${int(1, 3)}S`, `\x1b[${int(1, 3)}T`, `\x1b[${int(1, 3)}L`, `\x1b[${int(1, 3)}M`, '\x1b[3J'])
      if (k < 0.81) return `x\x1b[${int(1, cols * 2)}b`
      if (k < 0.86 && o.alt) return pick(['\x1b[?1049h', '\x1b[?1049l', '\x1b[?47h', '\x1b[?47l', '\x1b[?1047h', '\x1b[?1047l'])
      if (k < 0.93 && o.region) return pick([`\x1b[${int(1, rows)};${int(1, rows)}r`, '\x1b[r', `\x1b[;${int(1, rows)}r`, `\x1b[${int(2, rows)}r`, `\x1b[1;${int(1, rows)}r`, `\x1b[1:${int(0, 9)};${int(1, rows + 1)}r`, '\x1b[?6h', '\x1b[?6l', '\x1b[!p'])
      if (k < 0.95 && o.reset) return pick(['\x1bc', '\x1b#8'])
      return 'q'
    }
    return Array.from({ length: n }, () => {
      const [cols, rows] = pick(SIZES)
      let text = ''
      for (let j = int(5, 160); j > 0; j--) text += token(cols, rows)
      const start = int(0, rows - 1)
      const total = rowsOf(text, cols, rows)
      // The empty rows above the notice when helper-pty.ts writes it on the row above the last (plan section A4).
      const notice = rowsOf(NOTICE, cols)
      const gap = notice < rows ? rows - 1 - notice : undefined
      const t = replayTail(text, cols, int(1, total + 2), rows, gap)
      return { cols, rows, text, start, counted: total - 1, plain: rowsOf(text, cols) - 1, t, tail: total - rowsOf(text.slice(0, t.from), cols, rows), notice, gap }
    })
  }

  /** For each item, the rows a terminal adds while it reads the second text, after a full reset and the first. */
  function addedEach(cols: number, rows: number, items: Array<[string, string]>): Promise<number[]> {
    return new Promise((res) => {
      const term = new Terminal({ cols, rows, scrollback: 100_000, allowProposedApi: true, logLevel: 'off' })
      const got: number[] = []
      let start = 0
      if (items.length === 0) { term.dispose(); res(got); return }
      items.forEach(([before, text], i) => {
        term.write(`\x18\x1bc${before}`, () => { start = term.buffer.normal.baseY })
        term.write(text, () => {
          got.push(term.buffer.normal.baseY - start)
          if (i === items.length - 1) { term.dispose(); res(got) }
        })
      })
    })
  }

  for (const [what, seed, o] of [
    ['text, line feeds and cursor moves', 7, {}],
    ['the alternate screen too', 11, { alt: true }],
    ['scroll regions and origin mode too', 13, { alt: true, region: true }],
    ['full resets too', 17, { alt: true, region: true, reset: true }],
  ] as const) {
    it(`random streams of ${what}, at 36 sizes: never fewer rows than the tab adds, the whole stream and what follows a cut alike`, async () => {
      const all = streams(seed, 600, o)
      const fewer: string[] = []
      for (const [cols, rows] of SIZES) {
        const mine = all.filter((s) => s.cols === cols && s.rows === rows)
        const whole = await addedEach(cols, rows, mine.map((s) => ['\n'.repeat(s.start) + '\r', s.text]))
        const tail = await addedEach(cols, rows, mine.map((s) => [`\x18${s.t.before}\x1b[0m${NOTICE}\r\n\x1b[${rows};1H${s.t.after}`, s.text.slice(s.t.from)]))
        mine.forEach((s, i) => {
          if (whole[i] > s.counted) fewer.push(`whole, ${cols}x${rows}: ${whole[i]} > ${s.counted}: ${JSON.stringify(s.text)}`)
          if (tail[i] > s.tail) fewer.push(`after the cut at ${s.t.from}, ${cols}x${rows}: ${tail[i]} > ${s.tail}: ${JSON.stringify(s.text)}`)
        })
      }
      expect(fewer.slice(0, 3)).toEqual([])
      // 396 to 469 of the 600, by seed.
      expect(all.filter((s) => s.counted < s.plain).length).toBeGreaterThan(300)
    })
  }

  /*
   * 2.1.3-beta.13, plan section A4 (aicc_planning#382): helper-pty.ts writes
   * the notice on the row above the tab's last row, so `gap` empty rows lie
   * above it; given that gap, the answer says where the tab's scrollback may
   * be cleared: the start of the newest row a line feed added at most `gap`
   * rows after the cut. There only those empty rows have left the screen.
   */
  describe('where the scrollback may be cleared (2.1.3-beta.13, plan section A4)', () => {
    /** What helper-pty.ts shows for `t` at the holder's size, a tab `rows` high: the notice above the last row, the clear put in, or left out. */
    const pieceFor = (text: string, t: ReturnType<typeof replayTail>, rows: number, cols: number, withClear = true) => {
      const shown = text.slice(t.from)
      const at = withClear && t.clear !== undefined ? t.clear - t.from : -1
      return `\x18${t.before}\x1b[0m\x1b[${rows - rowsOf(NOTICE, cols)};1H${NOTICE}\r\n${t.after}${at < 0 ? shown : `${shown.slice(0, at)}\x1b[3J${shown.slice(at)}`}`
    }
    /** Every row of the normal screen's buffer after `stream`, in a new terminal `cols` by `rows`. */
    async function bufferAfter(stream: string, cols: number, rows: number): Promise<{ normal: string[]; type: string }> {
      const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true, logLevel: 'off' })
      try {
        await new Promise<void>((res) => term.write(stream, res))
        const b = term.buffer.normal
        return { normal: Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? ''), type: term.buffer.active.type }
      } finally {
        term.dispose()
      }
    }

    it('exactly the gap after the cut when a line feed made that row: in the tab the empty rows above the notice go, and nothing else', async () => {
      const text = numbered(60)
      // 61 rows, 30 kept: the cut at line 32; 10 rows less the notice's and the last is a gap of 8, so line 40.
      const t = replayTail(text, 80, 30, 10, 8)
      expect(t).toMatchObject({ from: text.indexOf('line 32\r\n'), left: 31, part: false, clear: text.indexOf('line 40\r\n') })
      expect((await bufferAfter(pieceFor(text, t, 10, 80), 80, 10)).normal.slice(0, 3)).toEqual([NOTICE, 'line 32', 'line 33'])
      expect((await bufferAfter(pieceFor(text, t, 10, 80, false), 80, 10)).normal.slice(0, 10)).toEqual([...Array(8).fill(''), NOTICE, 'line 32'])
      // One row start later and the notice is cleared with them.
      const late = { ...t, clear: text.indexOf('line 41\r\n') }
      expect((await bufferAfter(pieceFor(text, late, 10, 80), 80, 10)).normal[0]).toBe('line 32')
      // The same from the text's start, nothing cut.
      expect(replayTail(text, 80, 100, 10, 8)).toMatchObject({ from: 0, clear: text.indexOf('line 9\r\n') })
    })

    it('an earlier one when that row is a wrap\'s: the rest of the empty rows stay above the notice, never under it', async () => {
      const text = `${'a\r\n'.repeat(7)}${'w'.repeat(100)}\r\n${numbered(5)}`
      const t = replayTail(text, 80, 100, 10, 8)
      // Rows 1 to 7 are the line feeds' (the 7th starts the long line); row 8 is its wrap.
      expect(t).toMatchObject({ from: 0, clear: text.indexOf('w') })
      expect((await bufferAfter(pieceFor(text, t, 10, 80), 80, 10)).normal.slice(0, 4)).toEqual(['', NOTICE, 'a', 'a'])
    })

    it('none with no row a line feed made in reach, with no gap, with a gap of 0, or without the rows', () => {
      const long = 'w'.repeat(2000)
      expect(replayTail(long, 80, 100, 10, 8).clear).toBeUndefined()
      expect(replayTail(numbered(60), 80, 30, 10).clear).toBeUndefined()
      expect(replayTail(numbered(60), 80, 30, 10, 0).clear).toBeUndefined()
      expect(replayTail(numbered(60), 80, 30, undefined, 8).clear).toBeUndefined()
      expect('clear' in replayTail(numbered(60), 80, 30, 10)).toBe(false)
    })

    it('never on the alternate screen: line feeds there make no row, so the clear is before the switch, or after the switch back', async () => {
      const stay = `x\r\n\x1b[?1047h${'y\r\n'.repeat(20)}`
      const t = replayTail(stay, 80, 100, 10, 8)
      expect(t.clear).toBe(3)
      const after = await bufferAfter(pieceFor(stay, t, 10, 80), 80, 10)
      expect(after.type).toBe('alternate')
      expect(after.normal.slice(after.normal.indexOf(NOTICE))).toEqual([NOTICE, 'x', ''])
      const back = `x\r\n\x1b[?1047h${'y\r\n'.repeat(20)}\x1b[?1047l${numbered(20)}`
      const u = replayTail(back, 80, 100, 10, 8)
      expect(u.clear).toBe(back.indexOf('line 8\r\n'))
      expect((await bufferAfter(pieceFor(back, u, 10, 80), 80, 10)).normal.slice(0, 3)).toEqual([NOTICE, 'x', 'line 1'])
    })

    it('not after anything that could leave a character above the row the cut starts, or move those rows: the cursor on such a row, a cursor saved (1049 too) or a soft reset, a scroll region, origin mode set or reset, the screen moved up or down, filled or reset; a cursor moved within the rows shown is no such thing', async () => {
      for (const what of ['\x1b[H', '\x1b[5;1H', '\x1b[6A', '\x1bM\x1bM\x1bM\x1bM', '\x1b7', '\x1b[s', '\x1b[?1048h', '\x1b[?1049h\x1b[?1049l', '\x1b[1;10r', '\x1b[2;5r', '\x1b[?6h', '\x1b[?6l', '\x1b[S', '\x1b[2T', '\x1b#8', '\x1bc', '\x1b[!p', '\x1b[5!p']) {
        const text = `${numbered(3)}${what}${numbered(20)}`
        // Three rows on, the cursor on the last row: the clear goes where the third line feed left it, and no further.
        expect(replayTail(text, 80, 100, 10, 8).clear, JSON.stringify(what)).toBe(numbered(3).length)
      }
      // On the alternate screen the cursor anywhere, a cursor saved, a soft reset and the screen moved touch none of
      // the normal screen's rows, so long as the cursor is back within the rows shown when 1047 brings it to the
      // normal screen.
      const onAlt = `${numbered(3)}\x1b[?1047h\x1b[H\x1b7\x1b[!p\x1b[S\x1b[2T\x1b[10;1H\x1b[?1047l${numbered(20)}`
      expect(replayTail(onAlt, 80, 100, 10, 8).clear).toBe(onAlt.indexOf('line 6\r\n', onAlt.indexOf('\x1b[?1047l')))
      // There a scroll region, a fill or origin mode set or reset puts the cursor where the count does not follow
      // it, and a cursor left high is high on the normal screen too.
      for (const what of ['\x1b[2;5r\x1b[10;1H', '\x1b#8\x1b[10;1H', '\x1b[?6h', '\x1b[?6l', '\x1b[H']) {
        const text = `${numbered(3)}\x1b[?1047h${what}\x1b[?1047l${numbered(20)}`
        expect(replayTail(text, 80, 100, 10, 8).clear, JSON.stringify(what)).toBe(numbered(3).length)
      }
      // Three rows on, row 8 of 10 is the cut's own (the rows shown are the last four): nothing stops, and in the tab
      // the notice is the first row, as without the clear but for the empty rows.
      const within = `${numbered(3)}\x1b[8;1Hw${numbered(20)}`
      const t = replayTail(within, 80, 100, 10, 8)
      expect(t.clear).toBeGreaterThan(numbered(3).length)
      const a = (await bufferAfter(pieceFor(within, t, 10, 80), 80, 10)).normal
      const b = (await bufferAfter(pieceFor(within, t, 10, 80, false), 80, 10)).normal
      expect(a[0]).toBe(NOTICE)
      expect(a).toEqual(b.slice(b.indexOf(NOTICE)))
    })

    it('in the tab, text written at home after origin mode is set or reset, or at a restore with no save after a soft reset, stays where it was written: the clear drops only empty rows', async () => {
      const kept = (rows: string[]) => rows.slice(rows.findIndex((r) => r !== ''))
      for (const text of [
        `${numbered(3)}\x1b[?6hTOP\x1b[10;1H${numbered(20)}`,
        `${numbered(3)}\x1b[?6lTOP\x1b[10;1H${numbered(20)}`,
        `${numbered(3)}\x1b[!p${numbered(3)}\x1b8X\x1b[10;1H${numbered(20)}`,
      ]) {
        const t = replayTail(text, 80, 100, 10, 8)
        const a = (await bufferAfter(pieceFor(text, t, 10, 80), 80, 10)).normal
        const b = (await bufferAfter(pieceFor(text, t, 10, 80, false), 80, 10)).normal
        expect(kept(a), JSON.stringify(text)).toEqual(kept(b))
      }
    })

    /** For each item, the normal screen's rows after a full reset and `stream`, in one terminal `cols` by `rows`. */
    function normalEach(cols: number, rows: number, streams: string[]): Promise<string[][]> {
      return new Promise((res) => {
        const term = new Terminal({ cols, rows, scrollback: 100_000, allowProposedApi: true, logLevel: 'off' })
        const got: string[][] = []
        if (streams.length === 0) { term.dispose(); res(got); return }
        streams.forEach((s, i) => {
          term.write(`\x18\x1bc${s}`, () => {
            const b = term.buffer.normal
            got.push(Array.from({ length: b.length }, (_, k) => b.getLine(k)?.translateToString(true) ?? ''))
            if (i === streams.length - 1) { term.dispose(); res(got) }
          })
        })
      })
    }

    for (const [what, seed, o] of [
      ['text, line feeds and cursor moves', 7, {}],
      ['the alternate screen too', 11, { alt: true }],
      ['scroll regions and origin mode too', 13, { alt: true, region: true }],
      ['full resets too', 17, { alt: true, region: true, reset: true }],
    ] as const) {
      it(`random streams of ${what} (the same as above): from the notice's row on, the tab's rows are the same with the clear and without, and the notice is there in both or neither`, async () => {
        const all = streams(seed, 600, o).filter((s) => s.gap !== undefined)
        const differ: string[] = []
        let cleared = 0
        for (const [cols, rows] of SIZES) {
          const mine = all.filter((s) => s.cols === cols && s.rows === rows)
          const withClear = await normalEach(cols, rows, mine.map((s) => pieceFor(s.text, s.t, rows, cols)))
          const without = await normalEach(cols, rows, mine.map((s) => pieceFor(s.text, s.t, rows, cols, false)))
          mine.forEach((s, i) => {
            if (s.t.clear !== undefined) cleared++
            const a = withClear[i].indexOf(NOTICE)
            const b = without[i].indexOf(NOTICE)
            // From the notice on; when the stream's own erase or reset took the notice in both, from the first row
            // that is not empty (all the clear may drop is empty rows at the top).
            const from = (rows: string[], k: number) => {
              const at = k >= 0 ? k : rows.findIndex((r) => r !== '')
              return at < 0 ? [] : rows.slice(at)
            }
            const same = (a < 0) === (b < 0) && JSON.stringify(from(withClear[i], a)) === JSON.stringify(from(without[i], b))
            if (!same) differ.push(`${cols}x${rows}, cut at ${s.t.from}, clear at ${s.t.clear}: ${JSON.stringify(s.text)}`)
          })
        }
        expect(differ.slice(0, 3)).toEqual([])
        // 82 to 157 of them have a clear, by seed.
        expect(cleared).toBeGreaterThan(60)
      })
    }
  })
})

describe('one scrollback, for the tab and the trim', () => {
  const src = (...parts: string[]) => fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'src', ...parts), 'utf8')

  it(`a tab keeps ${TERMINAL_SCROLLBACK_LINES} lines, the tab reads the constant, and the session helper trims to the same one`, () => {
    // AGENTS.md: more costs about 1 GB of memory per terminal.
    expect(TERMINAL_SCROLLBACK_LINES).toBe(10_000)
    const view = src('renderer', 'components', 'TerminalView.tsx')
    expect(view).toContain('scrollback: TERMINAL_SCROLLBACK_LINES')
    expect(view).not.toMatch(/scrollback:\s*\d/)
    expect(src('main', 'session-helper', 'helper-pty.ts')).toContain("import { TERMINAL_SCROLLBACK_LINES } from '../../shared/terminal-scrollback'")
  })
})
