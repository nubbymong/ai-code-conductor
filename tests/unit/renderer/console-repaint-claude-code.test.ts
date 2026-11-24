// aicc_planning#404: a Claude Code tab that grows keeps the rows above its banner.
//
// beta.15's VM line (vm:A1, the same on the published beta.14) read a Claude Code
// tab grown from 103x27 to 140x28 lose the 11 shell rows above its banner. Claude
// Code draws its screen again at the new size, so the console's paint after the size
// starts at the banner (`ESC[?25l`, a colour, `ESC[H`), and its lower lines (Claude
// Code's rules and status row at the new width) are not xterm's rows: the aligner
// (src/renderer/components/terminal/consoleRepaint.ts) could not place it bottom up
// and wrote it as it came, from xterm's top row down over the shell's rows. It now
// finds the paint's top lines lower on xterm's screen and moves xterm's rows above
// them to its scrollback first.
//
// Here M1's recorded Claude Code tab (console-repaint-cc-streams.ts) is written into
// xterm's own terminal with no window (@xterm/headless 6.0.0, the version the app
// ships) with the renderer's terminal options, as console-repaint-after-resize.test.ts
// does: from the rows the VM read before the size, once as the renderer wrote it
// before the aligner and once through it. Each recording gives the VM's reading row
// for row; the published control's paints are rebuilt to their recorded length.
//
// Not checked here: a Claude Code tab grown in two steps (103x27 to 140x24 to
// 140x28): vm:A1 on A1's head kept the lengths of its three pieces of output (1752,
// 1049 and 1065 characters), not their bytes. The VM line on this fix's head reads it.
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'
import { TERMINAL_SCROLLBACK_LINES } from '../../../src/shared/terminal-scrollback'
import { alignConsoleRepaint, createConsoleRepaintAligner } from '../../../src/renderer/components/terminal/consoleRepaint'
import {
  RECORDED_CC_RESIZES, PUBLISHED_CONTROL, controlPaint, expandRules, type RecordedCcResize, type RecordedRows,
} from './console-repaint-cc-streams'

const size = (s: string): [number, number] => s.split('x').map(Number) as [number, number]

/** The renderer's terminal as far as the buffer goes (as in
 *  console-repaint-after-resize.test.ts): made at xterm's 80x24, then sized. */
function makeTerminal(at: string): Terminal {
  const term = new Terminal({ cols: 80, rows: 24, scrollback: TERMINAL_SCROLLBACK_LINES, allowProposedApi: true })
  term.resize(...size(at))
  return term
}

const write = (term: Terminal, s: string) => new Promise<void>((done) => term.write(s, done))

/** The terminal with the rows the VM read: each row's text, a wrapped row by
 *  the line running on from the row above, the blank rows below, the cursor. */
async function restore(r: RecordedRows): Promise<Terminal> {
  const term = makeTerminal(r.size)
  const rows = r.rows.map(expandRules)
  let s = ''
  rows.forEach((text, i) => {
    if (i > 0 && !r.wrapped.includes(i)) s += '\r\n'
    s += r.wrapped.includes(i + 1) ? text.padEnd(term.cols, ' ') : text
  })
  s += '\r\n'.repeat(r.length - rows.length)
  await write(term, s + `\x1b[${r.cursor[1] + 1};${r.cursor[0] + 1}H`)
  return term
}

interface Held { size: string; baseY: number; cursor: [number, number]; length: number; wrapped: number[]; rows: string[] }

/** The terminal as the VM's buffer reading gives it. */
function held(term: Terminal): Held {
  const b = term.buffer.active
  const rows = Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true, 0, term.cols) ?? '')
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()
  const wrapped = Array.from({ length: b.length }, (_, i) => (b.getLine(i)?.isWrapped ? i : -1)).filter((i) => i >= 0)
  return { size: `${term.cols}x${term.rows}`, baseY: b.baseY, cursor: [b.cursorX, b.cursorY], length: b.length, wrapped, rows }
}

const asRead = (r: RecordedRows): Held => ({ ...r, rows: r.rows.map(expandRules) })

/** Each line of the buffer (a row and the rows wrapped on to it), with the
 *  row it starts on. */
function lines(term: Terminal): Array<{ row: number; text: string }> {
  const b = term.buffer.active
  const out: Array<{ row: number; text: string }> = []
  for (let i = 0; i < b.length; i++) {
    const text = b.getLine(i)?.translateToString(true, 0, term.cols) ?? ''
    if (b.getLine(i)?.isWrapped && out.length > 0) out[out.length - 1].text += text
    else out.push({ row: i, text })
  }
  return out.map((l) => ({ row: l.row, text: l.text.trimEnd() }))
}

const count = (term: Terminal, text: string) => lines(term).filter((l) => l.text === text).length

/** One recording, from the VM's rows before its first size: written as it came
 *  (the renderer before the aligner) or through the aligner, told each size as
 *  the renderer sends it. */
async function replay(before: RecordedRows, events: RecordedCcResize['events'], aligned: boolean): Promise<Terminal> {
  const term = await restore(before)
  const aligner = aligned ? createConsoleRepaintAligner(term, { now: () => 0 }) : null
  for (const ev of events) {
    if ('resize' in ev) {
      term.resize(...size(ev.resize))
      aligner?.noteResize()
    } else {
      const data = expandRules(ev.write)
      await new Promise<void>((done) => { if (aligner) aligner.write(data, done); else term.write(data, done) })
    }
  }
  return term
}

const byName = (name: string) => RECORDED_CC_RESIZES.find((r) => r.name === name)!
const paintOf = (name: string) => {
  const ev = byName(name).events.find((e) => 'write' in e)
  return expandRules((ev as { write: string }).write)
}

describe('M1\'s recorded Claude Code tab on the published beta.14 (aicc_planning#404)', () => {
  for (const rec of RECORDED_CC_RESIZES) {
    const sizes = [rec.before.size, ...rec.events.flatMap((e) => ('resize' in e ? [e.resize] : []))].join(' to ')
    it(`${rec.name} (${sizes}): the recording is whole; written as it came and through the aligner, the VM's reading row for row`, async () => {
      for (const ev of rec.events) if ('write' in ev) expect(expandRules(ev.write), 'the recorded output, to the character').toHaveLength(ev.chars)
      expect(held(await restore(rec.before)), 'the rows the VM read before the size').toEqual(asRead(rec.before))
      expect(held(await replay(rec.before, rec.events, false))).toEqual(asRead(rec.after))
      expect(held(await replay(rec.before, rec.events, true))).toEqual(asRead(rec.after))
    }, 20_000)
  }

  it('on the grows the shell\'s rows with text stay above Claude Code\'s screen, each once (they were above xterm\'s screen before the size)', async () => {
    for (const name of ['g-ccmain-grow', 'g-cctrust-grow']) {
      const rec = byName(name)
      const term = await replay(rec.before, rec.events, true)
      expect([count(term, 'Windows PowerShell'), count(term, 'Copyright (C) Microsoft Corporation. All rights reserved.')], name).toEqual([1, 1])
    }
    const main = await replay(byName('g-ccmain-grow').before, byName('g-ccmain-grow').events, true)
    expect(count(main, ' ▐▛███▛█   Claude Code v2.1.328')).toBe(1)
    const trust = await replay(byName('g-cctrust-grow').before, byName('g-cctrust-grow').events, true)
    // The console ran the question's first line on from its rule above.
    expect(lines(trust).filter((l) => l.text.endsWith(' Accessing workspace:'))).toHaveLength(1)
  }, 20_000)
})

describe('the published beta.14\'s Claude Code tab grown from 103x27 to 140x28 (A1\'s VM line, aicc_planning#404)', () => {
  const grow = controlPaint(paintOf('g-ccmain-grow'))
  const max = controlPaint(paintOf('g-ccmain-max'))
  const growEvents = [{ resize: '140x28' }, { write: grow, chars: grow.length }]
  const maxEvents = [{ resize: '103x27' }, { write: max, chars: max.length }]
  const BANNER = PUBLISHED_CONTROL.read.topRow

  /** The lines above the banner before the size: PowerShell's header and the
   *  line that started Claude Code, which the console wrapped over 6 rows. */
  const shellLines = async () => {
    const all = lines(await restore(PUBLISHED_CONTROL.before))
    return all.slice(0, all.findIndex((l) => l.text === BANNER)).map((l) => l.text)
  }

  it('each paint rebuilt from g-ccmain\'s comes to the length the VM recorded', () => {
    expect([grow.length, max.length]).toEqual([PUBLISHED_CONTROL.growChars, PUBLISHED_CONTROL.maxChars])
  })

  it('written as it came, the VM\'s reading: the banner on xterm\'s top row, none of the shell\'s 11 rows left', async () => {
    const shell = await shellLines()
    expect(shell).toHaveLength(6)
    const term = await replay(PUBLISHED_CONTROL.before, growEvents, false)
    const h = held(term)
    expect([h.baseY, h.cursor, h.rows[0]]).toEqual([PUBLISHED_CONTROL.read.baseY, PUBLISHED_CONTROL.read.cursor, BANNER])
    for (const text of shell.filter((t) => t !== '')) expect(count(term, text), text).toBe(0)
  }, 20_000)

  it('through the aligner the shell\'s lines are kept above the banner, each once, and the screen is the console\'s paint', async () => {
    const shell = await shellLines()
    const today = held(await replay(PUBLISHED_CONTROL.before, growEvents, false))
    const term = await replay(PUBLISHED_CONTROL.before, growEvents, true)
    const b = term.buffer.active
    const all = lines(term)
    const bannerAt = all.findIndex((l) => l.text === BANNER)
    expect(all.slice(0, bannerAt).map((l) => l.text)).toEqual(shell)
    // The 11 rows at 103 columns are 9 at 140: they are the scrollback, the
    // banner is xterm's top row.
    expect([b.baseY, all[bannerAt].row]).toEqual([9, 9])
    expect(count(term, BANNER)).toBe(1)
    for (const text of shell.filter((t) => t !== '')) expect(count(term, text), text).toBe(1)
    // On the screen, row for row and the cursor, what today's path gives.
    const screen = held(term).rows.slice(b.baseY)
    expect(screen).toEqual(today.rows.slice(today.baseY))
    expect([b.cursorX, b.cursorY]).toEqual(today.cursor)
  }, 20_000)

  it('maximised again (140x28 to 103x27): the shell\'s lines are still above the banner, each once', async () => {
    const shell = await shellLines()
    const term = await replay(PUBLISHED_CONTROL.before, [...growEvents, ...maxEvents], true)
    const all = lines(term)
    const bannerAt = all.findIndex((l) => l.text === BANNER)
    expect(all.slice(0, bannerAt).map((l) => l.text)).toEqual(shell)
    for (const text of shell.filter((t) => t !== '')) expect(count(term, text), text).toBe(1)
    // Not handled (consoleRepaint.ts): xterm re-wraps Claude Code's rules and
    // status row at the narrower width and moves the banner's top two rows to
    // its scrollback, and the console paints them again on its top rows, as
    // M1's g-ccmain-max read on the published beta.14.
    expect(count(term, BANNER)).toBe(2)
  }, 20_000)
})

/** A small terminal holding a shell's rows, then a program's screen: its two
 *  header lines, a blank row, a rule and its input row with the cursor on it. */
async function programTerminal(opts: { head?: string[]; cursorRow?: number } = {}): Promise<Terminal> {
  const term = new Terminal({ cols: 30, rows: 10, scrollback: 100, allowProposedApi: true })
  const head = opts.head ?? ['$ shell 1', 'shell 2', '$ start program']
  await write(term, [...head, 'HEADER A', 'HEADER B', '', '-'.repeat(20), '> input'].join('\r\n'))
  if (opts.cursorRow !== undefined) await write(term, `\x1b[${opts.cursorRow + 1};1H`)
  return term
}

/** The program's screen drawn again at a wider size, as the console paints it:
 *  its top lines, its rule at the new width, its input row, blank rows. */
function programPaint(top: string[], rows = 10): string {
  const body = [...top, '', '='.repeat(30), '> input']
  while (body.length < rows) body.push('')
  return '\x1b[?25l\x1b[H' + body.map((l) => `${l}\x1b[K`).join('\r\n') + `\x1b[${top.length + 3};8H\x1b[?25h`
}

const screenOf = (term: Terminal) => Array.from({ length: term.rows }, (_, i) => term.buffer.active.getLine(term.buffer.active.baseY + i)?.translateToString(true) ?? '')

describe('a paint whose top lines xterm holds lower on its screen', () => {
  it('xterm\'s rows above them go to its scrollback, each once, then the paint as it came', async () => {
    const term = await programTerminal()
    const paint = programPaint(['HEADER A', 'HEADER B'])
    const out = alignConsoleRepaint(paint, term)
    expect(out).toBe(`\x1b[?25l\x1b[10;1H${'\n'.repeat(3)}${paint}`)
    await write(term, out!)
    expect(lines(term).slice(0, 3).map((l) => l.text)).toEqual(['$ shell 1', 'shell 2', '$ start program'])
    expect(term.buffer.active.baseY).toBe(3)
    expect(screenOf(term).slice(0, 5)).toEqual(['HEADER A', 'HEADER B', '', '='.repeat(30), '> input'])
    expect(count(term, 'HEADER A')).toBe(1)
  })

  it('a blank top line: from the blank row above the lines', async () => {
    const term = await programTerminal({ head: ['$ shell 1', 'shell 2', ''] })
    const paint = programPaint(['', 'HEADER A', 'HEADER B'])
    expect(alignConsoleRepaint(paint, term)).toBe(`\x1b[?25l\x1b[10;1H${'\n'.repeat(2)}${paint}`)
  })

  it('found top down: with the same lines twice on the screen, the upper ones (fewest rows moved)', async () => {
    const term = await programTerminal({ head: ['$ shell 1', 'HEADER A', 'HEADER B', 'middle'] })
    const paint = programPaint(['HEADER A', 'HEADER B'])
    expect(alignConsoleRepaint(paint, term)).toBe(`\x1b[?25l\x1b[10;1H\n${paint}`)
  })
})

describe('another program\'s paint is written as it came, as before', () => {
  it('top lines that are not on xterm\'s screen', async () => {
    expect(alignConsoleRepaint(programPaint(['OTHER A', 'OTHER B']), await programTerminal())).toBeNull()
  })

  it('one line with text in common, then a line that differs', async () => {
    expect(alignConsoleRepaint(programPaint(['HEADER A', 'OTHER B']), await programTerminal())).toBeNull()
  })

  it('top lines that xterm holds on or below its cursor\'s row', async () => {
    expect(alignConsoleRepaint(programPaint(['HEADER A', 'HEADER B']), await programTerminal({ cursorRow: 1 }))).toBeNull()
  })

  it('blank top lines and no line with text after them in common', async () => {
    expect(alignConsoleRepaint(programPaint(['', 'OTHER A', 'OTHER B']), await programTerminal({ head: ['$ shell 1', '', 'shell 2'] }))).toBeNull()
  })

  it('top lines already on xterm\'s top row: nothing is above them', async () => {
    const term = await programTerminal({ head: [] })
    expect(alignConsoleRepaint(programPaint(['HEADER A', 'HEADER B']), term)).toBeNull()
  })

  it('top lines already on xterm\'s top row, and the same two lines again lower on the screen: the paint is in place, no row lands twice', async () => {
    // A block shown twice (the same banner after a program ran twice): the
    // lower copy is not where the paint starts.
    const term = await programTerminal({ head: ['HEADER A', 'HEADER B', 'x', 'y'] })
    const paint = programPaint(['HEADER A', 'HEADER B', 'x', 'y', 'HEADER A', 'HEADER B'])
    const out = alignConsoleRepaint(paint, term)
    expect(out).toBeNull()
    await write(term, out ?? paint)
    expect([term.buffer.active.baseY, count(term, 'x'), count(term, 'y')]).toEqual([0, 1, 1])
  })

  it('a paint with more lines than the screen has', async () => {
    expect(alignConsoleRepaint(programPaint(['HEADER A', 'HEADER B'], 12), await programTerminal())).toBeNull()
  })

  it('the alternate screen, holding the shell\'s rows and the program\'s screen', async () => {
    // The rows are drawn on the alternate screen, so only its type stops the
    // branch: line breaks on its bottom row would drop its top rows, not keep them.
    const term = new Terminal({ cols: 30, rows: 10, scrollback: 100, allowProposedApi: true })
    await write(term, '\x1b[?1049h\x1b[H' + ['$ shell 1', 'shell 2', '$ start program', 'HEADER A', 'HEADER B', '', '-'.repeat(20), '> input'].join('\r\n'))
    expect(alignConsoleRepaint(programPaint(['HEADER A', 'HEADER B']), term)).toBeNull()
  })
})
