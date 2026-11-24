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
// aicc_planning#414: the same tab grown and then narrowed again showed its banner's
// top rows twice (beta.16 B3's VM line, 3 of 3; M1's g-ccmain-max). Replayed here,
// xterm's re-wrap at the narrower width moved the top of its screen up one row for
// each row it added (the rule above the cursor and the status row), blank rows at
// its bottom or not, and the console's paint started at the banner, two rows above
// xterm's screen. The aligner now brings those rows down before the paint.
//
// aicc_planning#414 (C5b): the console can answer a narrowing with its own re-wrap
// of its screen first and Claude Code's paint after it (C5's VM line on the
// published beta.16, RECORDED_TWO_PAINTS): its full-width rules run on into the
// row below with no line break, so the re-wrap holds lines longer than a row and has
// fewer lines than the screen has rows. On a tab grown first it starts at the banner
// two rows above xterm's screen too; the aligner now counts each line by the rows it
// takes and brings those rows down for it as well.
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
import { alignConsoleRepaint, cellsOf, createConsoleRepaintAligner } from '../../../src/renderer/components/terminal/consoleRepaint'
import {
  RECORDED_CC_RESIZES, PUBLISHED_CONTROL, RECORDED_TWO_PAINTS, controlPaint, expandRules, type RecordedCcResize, type RecordedRows,
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

/** g-ccmain-max through the aligner (aicc_planning#414): xterm's re-wrap moved
 *  the banner's top two rows up into its scrollback (baseY 4 to 6) and the
 *  console painted them again on its top rows (the VM's rows 4 and 5 are its
 *  rows 6 and 7); they are brought down first, so the screen is the console's
 *  paint from the banner on and the rows above it are the shell's: the VM's
 *  reading with those two rows once, the screen's top two rows higher. */
const MAX = RECORDED_CC_RESIZES.find((r) => r.name === 'g-ccmain-max')!
const MAX_ALIGNED: RecordedRows = {
  ...MAX.after, baseY: MAX.after.baseY - 2, length: MAX.after.length - 2,
  rows: MAX.after.rows.filter((_, i) => i !== 4 && i !== 5),
}

/** Each recording through the aligner: the VM's reading, but for the
 *  narrowing the aligner now places. */
const alignedAfter = (rec: RecordedCcResize): RecordedRows => (rec.name === 'g-ccmain-max' ? MAX_ALIGNED : rec.after)

describe('M1\'s recorded Claude Code tab on the published beta.14 (aicc_planning#404, #414)', () => {
  for (const rec of RECORDED_CC_RESIZES) {
    const sizes = [rec.before.size, ...rec.events.flatMap((e) => ('resize' in e ? [e.resize] : []))].join(' to ')
    const through = rec.name === 'g-ccmain-max' ? 'through the aligner the banner once' : 'through the aligner the same'
    it(`${rec.name} (${sizes}): the recording is whole; written as it came, the VM's reading row for row; ${through}`, async () => {
      for (const ev of rec.events) if ('write' in ev) expect(expandRules(ev.write), 'the recorded output, to the character').toHaveLength(ev.chars)
      expect(held(await restore(rec.before)), 'the rows the VM read before the size').toEqual(asRead(rec.before))
      expect(held(await replay(rec.before, rec.events, false))).toEqual(asRead(rec.after))
      expect(held(await replay(rec.before, rec.events, true))).toEqual(asRead(alignedAfter(rec)))
    }, 20_000)
  }

  it('g-ccmain-max, written as it came: xterm\'s re-wrap moved the banner\'s top two rows up into its scrollback before the paint, and the paint wrote them again (the VM\'s reading)', async () => {
    const rec = byName('g-ccmain-max')
    const term = await restore(rec.before)
    term.resize(...size('103x27'))
    // The rule above the cursor's row and the status row each take one more
    // row at 103 columns: the top of the screen moves up two rows, though the
    // screen's bottom 19 rows held no text.
    expect([term.buffer.active.baseY, lines(term)[term.buffer.active.baseY].text]).toEqual([6, ' ▝▝   ▝▝   C:\\Users\\User\\p2w\\projects\\web-app'])
    const today = await replay(rec.before, rec.events, false)
    expect([count(today, ' ▐▛███▛█   Claude Code v2.1.328'), count(today, '▝▜██████▀  Opus 5.5 with medium effort · API Usage Billing')]).toEqual([2, 2])
    // The VM's rows 4 and 5 are its rows 6 and 7 again (MAX_ALIGNED leaves them out).
    expect(rec.after.rows.slice(4, 6)).toEqual(rec.after.rows.slice(6, 8))
  }, 20_000)

  it('g-ccmain-max through the aligner: each of the banner\'s rows and the shell\'s once, the screen the console\'s paint, the cursor where it put it', async () => {
    const rec = byName('g-ccmain-max')
    const term = await replay(rec.before, rec.events, true)
    for (const text of [...rec.before.rows.slice(0, 2), ' ▐▛███▛█   Claude Code v2.1.328', '▝▜██████▀  Opus 5.5 with medium effort · API Usage Billing', ' ▝▝   ▝▝   C:\\Users\\User\\p2w\\projects\\web-app']) {
      expect(count(term, text), text).toBe(1)
    }
    // The paint written as it came on a terminal whose top row is the banner's
    // gives the same screen, row for row.
    const b = term.buffer.active
    const fresh = makeTerminal('103x27')
    await write(fresh, paintOf('g-ccmain-max'))
    expect(held(term).rows.slice(b.baseY)).toEqual(held(fresh).rows)
    expect([b.cursorX, b.cursorY]).toEqual([2, 6])
  }, 20_000)

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

  it('maximised again (140x28 to 103x27): the shell\'s lines are still above the banner, each once, and the banner shows once (B3\'s VM line on beta.16 read its top rows twice, aicc_planning#414)', async () => {
    const shell = await shellLines()
    const term = await replay(PUBLISHED_CONTROL.before, [...growEvents, ...maxEvents], true)
    const all = lines(term)
    const bannerAt = all.findIndex((l) => l.text === BANNER)
    expect(all.slice(0, bannerAt).map((l) => l.text)).toEqual(shell)
    for (const text of shell.filter((t) => t !== '')) expect(count(term, text), text).toBe(1)
    // xterm re-wraps Claude Code's rules and status row at the narrower width
    // and moves the banner's top two rows to its scrollback; they are brought
    // down before the console paints them again on its top rows.
    expect(count(term, BANNER)).toBe(1)
    expect(count(term, '▝▜██████▀  Opus 5.5 with medium effort · API Usage Billing')).toBe(1)
    // The banner is xterm's top row, where the console's paint put it.
    expect(all[bannerAt].row).toBe(term.buffer.active.baseY)
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

const RULE_30 = '-'.repeat(30)
const STATUS_30 = 'mode on' + ' '.repeat(10) + 'not logged in'

/** A terminal holding `shell` lines of a shell in its scrollback, then a
 *  program's screen from its top row at 30 columns: two header lines, a blank
 *  row, a full-width rule, its input row with the cursor on it, a full-width
 *  rule, a full-width status row and blank rows (`bottom`: a line on its last
 *  row; `cursorAtBottom`: the cursor on its last row instead). Then narrowed
 *  to 20 columns, as xterm narrows it: the rule above the cursor and the
 *  status row take one more row each, and the top of its screen moves up two
 *  rows (the program's header lines); three with the cursor on its last row. */
async function narrowedTerminal(opts: { shell?: number; bottom?: string; cursorAtBottom?: boolean } = {}): Promise<Terminal> {
  const term = new Terminal({ cols: 30, rows: 10, scrollback: 100, allowProposedApi: true })
  const shell = Array.from({ length: opts.shell ?? 12 }, (_, i) => `$ shell ${i + 1}`)
  const screen = ['HEADER A', 'HEADER B', '', RULE_30, '> input', RULE_30, STATUS_30, '', '', opts.bottom ?? '']
  await write(term, [...shell, ...screen].join('\r\n') + (opts.cursorAtBottom ? '\x1b[10;1H' : '\x1b[5;8H'))
  term.resize(20, 10)
  return term
}

/** The program's screen drawn again at 20 columns, as the console paints it. */
function narrowPaint(top: string[] = ['HEADER A', 'HEADER B']): string {
  const body = [...top, '', '-'.repeat(20), '> input', '-'.repeat(20), 'mode on  logged out']
  while (body.length < 10) body.push('')
  return '\x1b[?25l\x1b[H' + body.map((l) => `${l}\x1b[K`).join('\r\n') + `\x1b[${top.length + 3};8H\x1b[?25h`
}

/** What the paint shows on a terminal of its own: the console's screen. */
async function paintedAlone(paint: string): Promise<string[]> {
  const t = new Terminal({ cols: 20, rows: 10, scrollback: 100, allowProposedApi: true })
  await write(t, paint)
  return screenOf(t)
}

/** Every row of the terminal and where its top and cursor are. */
const stateOf = (term: Terminal) => ({ ...held(term), rows: lines(term).map((l) => l.text) })

describe('a narrowing\'s paint whose top lines xterm holds just above its screen (aicc_planning#414)', () => {
  for (const shell of [12, 1]) {
    it(`${shell === 12 ? 'more scrollback than rows below the cursor' : 'less scrollback than rows below the cursor'} (${shell} shell line(s)): the header lines are brought down, each line once, the screen the console's`, async () => {
      const term = await narrowedTerminal({ shell })
      expect(term.buffer.active.baseY, 'xterm moved the header lines up into its scrollback').toBe(shell + 2)
      const paint = narrowPaint()
      const out = alignConsoleRepaint(paint, term)
      expect(out).not.toBeNull()
      await write(term, out!)
      const b = term.buffer.active
      expect(b.baseY).toBe(shell)
      for (let i = 1; i <= shell; i++) expect(count(term, `$ shell ${i}`), `$ shell ${i}`).toBe(1)
      expect([count(term, 'HEADER A'), count(term, 'HEADER B')]).toEqual([1, 1])
      expect(screenOf(term)).toEqual(await paintedAlone(paint))
      expect([b.cursorX, b.cursorY, term.cols, term.rows]).toEqual([7, 4, 20, 10])
    })
  }

  it('written as it came (beta.16): the header lines show twice', async () => {
    const term = await narrowedTerminal()
    await write(term, narrowPaint())
    expect([count(term, 'HEADER A'), count(term, 'HEADER B')]).toEqual([2, 2])
  })

  it('a line on the last row of xterm\'s screen: the paint writes that row again on either path, so bringing rows down loses nothing more', async () => {
    const aligned = await narrowedTerminal({ bottom: 'last row' })
    await write(aligned, alignConsoleRepaint(narrowPaint(), aligned)!)
    const asItCame = await narrowedTerminal({ bottom: 'last row' })
    await write(asItCame, narrowPaint())
    expect([count(aligned, 'HEADER A'), count(aligned, 'last row')]).toEqual([1, 0])
    expect([count(asItCame, 'HEADER A'), count(asItCame, 'last row')]).toEqual([2, 0])
    for (let i = 1; i <= 12; i++) expect(count(aligned, `$ shell ${i}`), `$ shell ${i}`).toBe(1)
  })

  it('through the aligner after a size: the same, and the output after the paint follows it', async () => {
    const term = await narrowedTerminal()
    const aligner = createConsoleRepaintAligner(term, { now: () => 0 })
    aligner.noteResize()
    await new Promise<void>((done) => aligner.write(`${narrowPaint()}\x1b[8;1Hafter`, done))
    expect([count(term, 'HEADER A'), count(term, 'HEADER B'), term.buffer.active.baseY]).toEqual([1, 1, 12])
    expect(screenOf(term)[4]).toBe('> input')
    expect(screenOf(term)[7]).toBe('after')
  })

  it('the console\'s own re-wrap first (each 30-column rule run on into the row below, no line break: 7 lines over the 10 rows), then the program\'s paint: placed by the rows its lines take, each line once, the screen the program\'s (aicc_planning#414, C5b)', async () => {
    const term = await narrowedTerminal()
    const rewrap = consoleRewrap()
    expect(rewrap.split('\r\n')).toHaveLength(7)
    const out = alignConsoleRepaint(rewrap, term)
    expect(out, 'C5 (f1999f08) wrote it as it came: 7 lines, not 10').not.toBeNull()
    await write(term, out!)
    expect(term.buffer.active.baseY).toBe(12)
    expect(screenOf(term)).toEqual(await paintedAlone(rewrap))
    // Then the program's paint, after the same size: already in place, written as it came.
    const program = narrowPaint()
    expect(alignConsoleRepaint(program, term)).toBeNull()
    await write(term, program)
    for (let i = 1; i <= 12; i++) expect(count(term, `$ shell ${i}`), `$ shell ${i}`).toBe(1)
    expect([count(term, 'HEADER A'), count(term, 'HEADER B')]).toEqual([1, 1])
    expect(screenOf(term)).toEqual(await paintedAlone(program))
  })

  it('the two paints written as they came (C5 too, for the re-wrap): the header lines show twice', async () => {
    const term = await narrowedTerminal()
    await write(term, consoleRewrap())
    await write(term, narrowPaint())
    expect([count(term, 'HEADER A'), count(term, 'HEADER B')]).toEqual([2, 2])
  })

  it('a line of wide characters counted two cells each (15 of them take two rows at 20 columns): placed', async () => {
    const term = await narrowedTerminal()
    const wide = '漢'.repeat(15)
    const paint = narrowPaint().replace('mode on  logged out\x1b[K\r\n\x1b[K', `${wide}\x1b[K`)
    expect(paint.split('\r\n')).toHaveLength(9)
    expect(await paintedAlone(paint)).toContain('漢'.repeat(5))
    expect(alignConsoleRepaint(paint, term)).not.toBeNull()
    expect(count(term, 'HEADER A')).toBe(1)
  })
})

/** The console's own re-wrap of narrowedTerminal's screen at 20 columns, as
 *  C5's VM recorded one (RECORDED_TWO_PAINTS): it keeps its top row, and each
 *  30-column rule runs on into the row below it with no line break. */
function consoleRewrap(): string {
  const body = ['HEADER A', 'HEADER B', '', RULE_30 + '> input', RULE_30 + STATUS_30, '', '']
  return '\x1b[?25l\x1b[H' + body.map((l) => `${l}\x1b[K`).join('\r\n') + '\x1b[5;18H\x1b[?25h'
}

describe('a narrowing whose console paints its own re-wrap first, lines longer than a row (C5\'s VM line on the published beta.16, aicc_planning#414)', () => {
  const { grown, grownPaint } = RECORDED_TWO_PAINTS
  const first: RecordedCcResize = RECORDED_TWO_PAINTS.first
  const BANNER = ' ▐▛███▛█   Claude Code v2.1.330'
  const BANNER_2 = '▝▜██████▀  Opus 5.5 with medium effort · API Usage Billing'
  const rewrap = expandRules((first.events[1] as { write: string }).write)
  const program = expandRules(grownPaint.write)

  /** The console's re-wrap of the grown tab's screen, built from pn-pcn1's, not
   *  recorded so: its lines from the banner on (the grown tab's console screen
   *  starts at the banner), blank rows to fill the screen, the cursor on the
   *  input row (pn-pcn1's column, its row 11 rows higher, as the banner is). */
  const grownRewrap = (() => {
    const lines = rewrap.slice(0, rewrap.indexOf('\x1b[18;40H')).split('\r\n').slice(6)
    lines[0] = '\x1b[?25l\x1b[38;2;215;119;87m\x1b[H' + lines[0]
    return [...lines, ...Array<string>(11).fill('\x1b[K')].join('\r\n') + '\x1b[7;40H\x1b[?25h'
  })()

  /** The paint on a 103x27 terminal of its own: the top of its screen, how many
   *  of its rows run on from the row above, and its rows. */
  const alone = async (paint: string) => {
    const t = makeTerminal('103x27')
    await write(t, paint)
    const b = t.buffer.active
    const runOn = Array.from({ length: b.length }, (_, i) => b.getLine(i)?.isWrapped).filter(Boolean).length
    return { baseY: b.baseY, runOn, rows: held(t).rows }
  }

  it('pn-pcn1 (140x28 to 103x27): the recording is whole; the console\'s re-wrap is 20 lines over the screen\'s 27 rows, 7 of them run on; through the aligner, the VM\'s reading', async () => {
    for (const ev of first.events) if ('write' in ev) expect(expandRules(ev.write), 'the recorded output, to the character').toHaveLength(ev.chars)
    expect(held(await restore(first.before)), 'the rows the VM read before the size').toEqual(asRead(first.before))
    expect(rewrap.split('\r\n')).toHaveLength(20)
    expect(await alone(rewrap)).toMatchObject({ baseY: 0, runOn: 7 })
    expect(held(await replay(first.before, first.events, true))).toEqual(asRead(first.after))
  }, 20_000)

  it('the tab grown again (pn-pcn1b) and narrowed with the same two paints: written as it came, the banner\'s top two rows twice; through the aligner once, the shell\'s lines once, the screen Claude Code\'s paint', async () => {
    expect(held(await restore(grown)), 'the rows the VM read before the size').toEqual(asRead(grown))
    expect(program).toHaveLength(grownPaint.chars)
    expect(grownRewrap.split('\r\n')).toHaveLength(25)
    expect(await alone(grownRewrap)).toMatchObject({ baseY: 0, runOn: 2 })
    const events = [{ resize: '103x27' }, { write: grownRewrap, chars: grownRewrap.length }, { write: program, chars: program.length }]
    const today = await replay(grown, events, false)
    expect([count(today, BANNER), count(today, BANNER_2)]).toEqual([2, 2])
    const term = await replay(grown, events, true)
    expect([count(term, BANNER), count(term, BANNER_2)], 'C5 (f1999f08): 2 and 2').toEqual([1, 1])
    for (const text of ['Windows PowerShell', 'Copyright (C) Microsoft Corporation. All rights reserved.']) expect(count(term, text), text).toBe(1)
    const b = term.buffer.active
    expect(held(term).rows.slice(b.baseY)).toEqual((await alone(program)).rows)
    expect([b.cursorX, b.cursorY]).toEqual([2, 6])
  }, 20_000)
})

describe('a paint that is not a narrowing\'s of this screen is written as it came, the terminal left as it was', () => {
  const unchanged = async (paint: string, term: Terminal) => {
    const before = stateOf(term)
    expect(alignConsoleRepaint(paint, term)).toBeNull()
    expect(stateOf(term)).toEqual(before)
  }

  it('top lines that xterm does not hold above its screen', async () => {
    await unchanged(narrowPaint(['OTHER A', 'OTHER B']), await narrowedTerminal())
  })

  it('only one line with text in common above the screen', async () => {
    await unchanged(narrowPaint(['HEADER A', 'OTHER B']), await narrowedTerminal())
  })

  it('more rows above xterm\'s screen than its screen has below its cursor (the cursor on its last row): they do not come down', async () => {
    const term = await narrowedTerminal({ cursorAtBottom: true })
    expect([term.buffer.active.baseY, term.buffer.active.cursorY]).toEqual([15, 9])
    await unchanged(narrowPaint(), term)
  })

  it('a paint already in place, its top lines also just above xterm\'s screen (a block shown twice): no rows brought down', async () => {
    const term = new Terminal({ cols: 20, rows: 10, scrollback: 100, allowProposedApi: true })
    const shell = Array.from({ length: 12 }, (_, i) => `$ shell ${i + 1}`)
    const screen = ['HEADER A', 'HEADER B', '', '-'.repeat(20), '> input', '-'.repeat(20), 'old status', '', '', '']
    await write(term, [...shell, 'HEADER A', 'HEADER B', ...screen].join('\r\n') + '\x1b[5;8H')
    expect([term.buffer.active.baseY, screenOf(term)[0]]).toEqual([14, 'HEADER A'])
    await unchanged(narrowPaint(), term)
  })

  it('a paint of fewer rows than the screen has', async () => {
    const short = narrowPaint().replace(/\r\n\x1b\[K(?=\x1b\[5;8H)/, '')
    expect(short.split('\r\n')).toHaveLength(9)
    await unchanged(short, await narrowedTerminal())
  })

  it('a paint of more rows than the screen has: 10 lines, one of them longer than a row (11 rows)', async () => {
    const long = narrowPaint().replace('mode on  logged out', 'mode on  logged out and more')
    expect(long.split('\r\n')).toHaveLength(10)
    await unchanged(long, await narrowedTerminal())
  })
})

describe('the cells a line of the console\'s paint takes, as xterm writes it (aicc_planning#414, C5b)', () => {
  /** The cells xterm gives each code point in `codes`: written after an `a`
   *  on a row of its own, it is where the `|` after it lands (the row's last
   *  one), less one. */
  async function xtermCells(codes: number[]): Promise<number[]> {
    const term = new Terminal({ cols: 10, rows: 1, scrollback: codes.length + 10, allowProposedApi: true })
    await write(term, codes.map((c) => `a${String.fromCodePoint(c)}|`).join('\r\n'))
    const b = term.buffer.active
    return codes.map((_, i) => {
      const line = b.getLine(i)!
      for (let x = 9; x >= 0; x--) if (line.getCell(x)?.getChars() === '|') return x - 1
      return -1
    })
  }

  it('cellsOf gives xterm\'s own width for every code point of the Basic Multilingual Plane and the ones it lists above it', async () => {
    const codes: number[] = []
    for (let c = 0xa0; c <= 0xffff; c++) if (c < 0xd800 || c > 0xdfff) codes.push(c)
    for (let c = 0x20; c < 0x7f; c++) codes.push(c)
    for (const [from, to] of [[0x10a00, 0x10a40], [0x1d160, 0x1d250], [0x1f300, 0x1f6ff], [0x1f900, 0x1faff], [0x1fffe, 0x20010], [0x2fff0, 0x30010], [0x3fff0, 0x3ffff], [0xe0000, 0xe01f0]]) {
      for (let c = from; c <= to; c++) codes.push(c)
    }
    const want = await xtermCells(codes)
    const differ = codes.filter((c, i) => cellsOf(c) !== want[i]).map((c) => c.toString(16))
    expect(differ).toEqual([])
    expect(new Set(want)).toEqual(new Set([0, 1, 2]))
  }, 60_000)

  it('a combining mark takes no cell: a line of 20 cells with one in it is one row at 20 columns, and the narrowing\'s paint holding it is placed', async () => {
    const accent = String.fromCodePoint(0x301)
    const paint = narrowPaint().replace('mode on  logged out', `mode on  logge${accent}d out!`)
    expect((await paintedAlone(paint))[6]).toBe(`mode on  logge${accent}d out!`)
    const term = await narrowedTerminal()
    expect(alignConsoleRepaint(paint, term)).not.toBeNull()
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
