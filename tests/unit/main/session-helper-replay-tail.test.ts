/**
 * The last of a replay a tab is shown after the line saying earlier output is
 * not shown (2.1.3-beta.12, plan section A1; src/main/session-helper/replay-tail.ts),
 * checked against xterm.js itself (@xterm/headless, the tab's terminal): rows
 * are never counted fewer than the terminal takes, the cut never lands inside
 * an escape sequence, a line over the budget is cut inside, a wrapped line
 * under it is left out whole, and the left-out part's alternate screen and
 * input modes are carried across the cut.
 */
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'
import fs from 'fs'
import path from 'path'
import { columns, replayTail, rowsOf } from '../../../src/main/session-helper/replay-tail'
import { TERMINAL_SCROLLBACK_LINES } from '../../../src/shared/terminal-scrollback'

/** The rows the tab's terminal takes for `text`, written to a new one: its normal screen's lines down to the cursor. */
async function rowsTaken(text: string, cols: number): Promise<number> {
  const term = new Terminal({ cols, rows: 24, scrollback: 100_000, allowProposedApi: true })
  try {
    await new Promise<void>((res) => term.write(text, res))
    const b = term.buffer.normal
    return b.baseY + b.cursorY + 1
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

  it('a line feed inside an OSC, DCS, SOS, PM or APC string does nothing, and BEL, ST, CAN or SUB ends the string', async () => {
    for (const [text, rows] of [
      ['\x1b]0;a\nb\x07x', 1],
      ['\x1bPq\nab\x1b\\x', 1],
      ['\x1b_\n\x1b\\x', 1],
      ['\x1bX\n\x9cx', 1],
      ['\x90q\n\x9cx', 1],
      ['\x1b]0;t\x18\r\nline', 2],
      ['\x1b]0;t\x1a\r\nline', 2],
      ['\x1bPq\x18\r\nline', 2],
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

  it('the alternate screen entered and left again in the left-out part: nothing to leave', () => {
    expect(replayTail(`\x1b[?1049h${'x\r\n'.repeat(30)}\x1b[?1049l${lines}`, 80, 5)).toMatchObject({ before: '', after: '' })
  })

  it('a full reset: the normal screen and the modes as they start', () => {
    expect(replayTail(`\x1b[?1h\x1bc${lines}`, 80, 5)).toMatchObject({
      before: '\x1b[?47l',
      after: '\x1b[?1l\x1b[?7h\x1b[?25h\x1b[?45l\x1b[?66l\x1b[?1000l\x1b[?1004l\x1b[?1006l\x1b[?2004l',
    })
  })

  it('only what comes before the cut: a mode set in the part that is shown is not carried', () => {
    expect(replayTail(`${lines}\x1b[?2004h${'x\r\n'.repeat(3)}`, 80, 5).after).toBe('')
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
