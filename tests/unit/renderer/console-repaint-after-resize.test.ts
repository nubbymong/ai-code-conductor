// aicc_planning#394: on Windows, a terminal that grows keeps its last lines.
//
// The console built into Windows paints its whole screen again after each size
// it is given, from its own top row down. On a grow xterm keeps its cursor on
// the same row and pulls older rows down out of its scrollback, while the
// console's lines move up: the paint lands on xterm's older lines and they are
// lost. beta.15 M1 measured it on the published beta.14 (Windows 11 build 22621,
// 10,000 lines of `long N ` and 250 `y`, a plain terminal): every grow lost
// lines, on both helper switch states; going narrower kept every line.
//
// Here M1's recorded streams (console-repaint-streams.ts: the console's output,
// each resize the tab's terminal took, and the console's paint after it) are
// written into xterm's own terminal with no window (@xterm/headless 6.0.0, the
// version the app ships) with the renderer's terminal options, once as the
// renderer writes them today and once through the aligner
// (src/renderer/components/terminal/consoleRepaint.ts). Today's path gives
// M1's VM readings line for line; the aligner keeps every line, on every path.
//
// TerminalView's source is read here for the options it gives its terminal,
// the sizes it tells the aligner before it sends them and its own lines; its
// hunk runs in tests/unit/renderer/terminalview-console-repaint.test.tsx.
//
// Not checked here:
//  - another Windows build and a tab on the console host the app ships: the VM
//    line on A1's head reads them;
//  - a Claude Code tab's screen: console-repaint-claude-code.test.ts replays it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Terminal } from '@xterm/headless'
import { TERMINAL_SCROLLBACK_LINES } from '../../../src/shared/terminal-scrollback'
import {
  alignConsoleRepaint, createConsoleRepaintAligner, consoleRepaintApplies, REPAINT_WINDOW_MS, type RepaintTerminal,
} from '../../../src/renderer/components/terminal/consoleRepaint'
import { RECORDED_RESIZES, RECORDED_RESTORES, expandRuns, restoreReplay, type RecordedResize, type RecordedRestore } from './console-repaint-streams'

const PROMPT = 'PS C:\\fixture\\long-lines\\work\\resizes>'
const Y = 'y'.repeat(250)
const PAINT_START = '\x1b[?25l\x1b[H'
/** The start of a paint whose first cell is in a colour the console did not
 *  last send: the colour comes before the cursor home (5 of the 9 paints in
 *  M1's Claude Code tab recordings begin
 *  `ESC[?25l ESC[38;2;215;119;87m ESC[H`). */
const PAINT_START_COLOURED = '\x1b[?25l\x1b[33m\x1b[H'
const PAINT_END = '\x1b[?25h'

const size = (s: string): [number, number] => s.split('x').map(Number) as [number, number]

/** The renderer's terminal as far as the buffer goes: made at xterm's 80x24,
 *  given its size at its first fit, before any output. (@xterm/headless lets
 *  its buffer be read only with allowProposedApi; it changes nothing else.) */
function makeTerminal(at: string): Terminal {
  const term = new Terminal({ cols: 80, rows: 24, scrollback: TERMINAL_SCROLLBACK_LINES, allowProposedApi: true })
  term.resize(...size(at))
  return term
}

const lines = (from: number, to: number): string => {
  let s = ''
  for (let n = from; n <= to; n++) s += `long ${n} ${Y}\r\n`
  return s
}

interface Scan { whole: number; first: number | null; last: number | null; gaps: string[]; pieces: string[]; beyondWidth: number; verdict: string }

/** M1's scan of the whole buffer: each line (a row and the rows wrapped on to
 *  it) must be `long N ` and 250 `y`, the numbers one after another; a piece
 *  of one is named unless it is on row 0 (the line the top of the scrollback
 *  cut). Rows are joined as they are, so a line with a gap inside is a piece. */
function scan(term: Terminal): Scan {
  const b = term.buffer.active
  const cols = term.cols
  const row = (i: number, last: boolean) => b.getLine(i)?.translateToString(last, 0, cols) ?? ''
  let lastText = -1
  for (let i = 0; i < b.length; i++) if (row(i, true)) lastText = i
  const r: Scan = { whole: 0, first: null, last: null, gaps: [], pieces: [], beyondWidth: 0, verdict: '' }
  let prev: number | null = null
  for (let i = 0; i <= lastText;) {
    let n = 1
    while (i + n < b.length && b.getLine(i + n)?.isWrapped) n++
    let s = ''
    for (let j = 0; j < n; j++) {
      s += row(i + j, j === n - 1)
      if ((b.getLine(i + j)?.translateToString(true).length ?? 0) > cols) r.beyondWidth++
    }
    s = s.trimEnd()
    const m = /^long (\d+) (y+)$/.exec(s)
    if (m && m[2].length === 250) {
      r.whole++
      const no = Number(m[1])
      if (r.first === null) r.first = no
      if (prev !== null && no !== prev + 1) r.gaps.push(`at row ${i} line ${no} follows line ${prev}`)
      prev = no
      r.last = no
    } else if (/y{4}/.test(s) && i !== 0) {
      r.pieces.push(`row ${i} (${n} row(s), ${s.length} chars)`)
    }
    i += n
  }
  const ok = r.gaps.length === 0 && r.pieces.length === 0 && r.whole > 0 && r.beyondWidth === 0
  r.verdict = ok ? 'ALL-OK' : `FIRST GAP: ${r.gaps[0] ?? '(no number gap)'}${r.pieces[0] ? `; first piece: ${r.pieces[0]}` : ''}`
  return r
}

/** One recording written as the renderer writes it: today straight into the
 *  terminal, or through the aligner, told each size as the renderer sends it
 *  (after its fit). */
async function replay(rec: RecordedResize, aligned: boolean): Promise<Terminal> {
  const term = makeTerminal(rec.start)
  const now = 0
  const aligner = aligned ? createConsoleRepaintAligner(term, { now: () => now }) : null
  const write = (s: string) => new Promise<void>((done) => { if (aligner) aligner.write(s, done); else term.write(s, done) })
  // The lines before the recording's tail, enough to fill the scrollback at
  // either width (10,000 rows), as the same text.
  await write(lines(rec.firstLine - 5200, rec.firstLine - 1))
  for (const ev of rec.events) {
    if (ev.write !== undefined) await write(expandRuns(ev.write))
    else if (ev.resize) {
      term.resize(...size(ev.resize))
      aligner?.noteResize()
    }
  }
  return term
}

const byName = (name: string) => RECORDED_RESIZES.find((r) => r.name === name)!

/** M1's readings on the VM (the published beta.14, switches off; the held
 *  path read the same lines). */
const TODAY: Record<string, string> = {
  'off1-grow': 'FIRST GAP: at row 6660 line 9993 follows line 9987; first piece: row 6658 (2 row(s), 157 chars)',
  'off2-grow': 'FIRST GAP: at row 6661 line 9993 follows line 9988; first piece: row 6658 (3 row(s), 297 chars)',
  'off1-shrink': 'FIRST GAP: at row 6659 line 9993 follows line 9986; first piece: row 6656 (3 row(s), 297 chars)',
  'off1-max': 'ALL-OK',
}

describe('TerminalView writes to and sizes its terminal as this file replays it', () => {
  it('TerminalView sets no option that changes how xterm re-wraps or moves its rows', () => {
    const src = readFileSync(resolve(__dirname, '../../../src/renderer/components/TerminalView.tsx'), 'utf8')
    expect(src, 'an option here changes the replay: re-run it with that option').not.toMatch(/windowsPty|windowsMode|reflowCursorLine|convertEol/)
    expect(src).toMatch(/scrollback: TERMINAL_SCROLLBACK_LINES/)
  })

  it('TerminalView tells the aligner every size it sends to the PTY, the unmount restore apart, and writes its own lines through it', () => {
    const src = readFileSync(resolve(__dirname, '../../../src/renderer/components/TerminalView.tsx'), 'utf8').split(/\r?\n/)
    const sends = src
      .map((l, i) => ({ l: l.trim(), told: src[i - 1]?.includes('consoleRepaint?.noteResize()') === true }))
      .filter((s) => s.l.includes('window.electronAPI.pty.resize('))
    expect(sends).toHaveLength(6)
    expect(sends.filter((s) => !s.told).map((s) => s.l)).toEqual([
      'try { window.electronAPI.pty.resize(sessionId, lastSentCols, lastSentRows) } catch { /* main gone */ }',
    ])
    expect(src.join('\n')).toContain('if (consoleRepaint) consoleRepaint.write(`${line}\\r\\n`)')
  })
})

describe('M1\'s recorded resizes, written as the renderer writes them today (aicc_planning#394)', () => {
  for (const rec of RECORDED_RESIZES) {
    it(`${rec.name} (${[rec.start, ...rec.events.filter((e) => e.resize).map((e) => e.resize)].join(' to ')}): M1's VM reading`, async () => {
      expect(scan(await replay(rec, false)).verdict).toBe(TODAY[rec.name])
    }, 20_000)
  }
})

describe('the same resizes through the aligner keep every line (aicc_planning#394)', () => {
  for (const rec of RECORDED_RESIZES) {
    it(`${rec.name}: every line whole, the prompt and the cursor where the console put them`, async () => {
      const term = await replay(rec, true)
      const r = scan(term)
      expect(r.verdict).toBe('ALL-OK')
      // The lines the scrollback held before the resize, to the last one; the
      // rows scrolled up for the paint can take the oldest past the
      // scrollback's cap, as more output would.
      expect(r.last).toBe(10000)
      expect(r.first).toBeGreaterThanOrEqual(6659)
      expect(r.first).toBeLessThanOrEqual(6660)
      expect(r.whole).toBe(10000 - r.first! + 1)
      const b = term.buffer.active
      expect(b.getLine(b.baseY + b.cursorY)?.translateToString(true)).toBe(PROMPT)
      expect(b.cursorX).toBe(PROMPT.length + 1)
    }, 20_000)
  }

  it('off1-grow: the console\'s paint lands on the rows it was meant for, the prompt on its row 19 with blank rows below', async () => {
    const term = await replay(byName('off1-grow'), true)
    const b = term.buffer.active
    expect([term.cols, term.rows, b.cursorY]).toEqual([140, 28, 18])
    const screen = Array.from({ length: term.rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? '')
    expect(screen[2]).toBe(`long 9993 ${Y.slice(0, 130)}`)
    expect(screen[16]).toBe(`long 10000 ${Y.slice(0, 129)}`)
    expect(screen[17]).toBe(Y.slice(129))
    expect(screen[18]).toBe(PROMPT)
    expect(screen.slice(19)).toEqual(Array(9).fill(''))
    // Line 9992 is whole on the two rows above, not the console's piece of it.
    expect(screen[0]).toBe(`long 9992 ${Y.slice(0, 130)}`)
  }, 20_000)
})

/** C8's restore as the renderer writes it (TerminalView's writeAtHolderSize
 *  and fitAfterReplay): the tab's terminal at its own size, then at the
 *  holder's for the replay, written as it came; fitted back to its own size
 *  and that size sent; then the console's paint at it. */
async function restore(r: RecordedRestore, aligned: boolean): Promise<Terminal> {
  const term = makeTerminal(r.tab)
  const aligner = aligned ? createConsoleRepaintAligner(term, { now: () => 0 }) : null
  const write = (s: string, asIs = false) => new Promise<void>((done) => { if (aligner) aligner.write(s, done, asIs); else term.write(s, done) })
  // The tab's own fits sent a size just before: the replay is still not looked into.
  aligner?.noteResize()
  term.resize(...size(r.holder))
  await write(restoreReplay(r), true)
  term.resize(...size(r.tab))
  aligner?.noteResize()
  await write(expandRuns(r.paint))
  return term
}

/** beta.14 C8's VM readings on 441823db (3 of 3 each way). */
const RESTORED_TODAY: Record<string, string> = {
  'u1-keep': 'FIRST GAP: at row 6622 line 9993 follows line 9986; first piece: row 6619 (3 row(s), 297 chars)',
  'd1-09': 'ALL-OK',
}

describe('a held terminal restored after its window changed size, its replay at the holder\'s size (C8, aicc_planning#392)', () => {
  for (const r of RECORDED_RESTORES) {
    it(`${r.name} (holder ${r.holder}, tab ${r.tab}): today's path gives the VM's reading; the aligner keeps every line, the notice on row 0`, async () => {
      expect(restoreReplay(r), 'the replay is the recorded one').toHaveLength(r.length)
      expect(scan(await restore(r, false)).verdict).toBe(RESTORED_TODAY[r.name])
      const term = await restore(r, true)
      const s = scan(term)
      expect(s.verdict).toBe('ALL-OK')
      expect([s.whole, s.first, s.last]).toEqual([10000 - r.firstLine + 1, r.firstLine, 10000])
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('[Earlier output of this terminal is no longer held, so it is not shown.]')
    }, 30_000)
  }
})

/** A small terminal with a few long lines on it, for the cases below. */
async function smallTerminal(cols = 20, rows = 6, count = 8): Promise<Terminal> {
  const term = new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true })
  await new Promise<void>((done) => term.write(Array.from({ length: count }, (_, i) => `L${i + 1} ` + 'y'.repeat(30)).join('\r\n') + '\r\n$ ', done))
  return term
}

describe('a paint that is not this terminal\'s screen is written as it came', () => {
  it('lines that do not match the terminal\'s rows', async () => {
    const term = await smallTerminal()
    expect(alignConsoleRepaint(`${PAINT_START}other text\x1b[K\r\nmore\x1b[K\r\n$ \x1b[K\x1b[3;3H${PAINT_END}`, term)).toBeNull()
  })

  it('the alternate screen', async () => {
    const term = await smallTerminal()
    await new Promise<void>((done) => term.write('\x1b[?1049h', done))
    expect(alignConsoleRepaint(`${PAINT_START}${'y'.repeat(9)}\x1b[K\r\n$\x1b[K\x1b[2;3H${PAINT_END}`, term)).toBeNull()
  })

  it('a sequence the console does not use in its paint (a cursor position before the end)', async () => {
    const term = await smallTerminal()
    expect(alignConsoleRepaint(`${PAINT_START}${'y'.repeat(9)}\x1b[K\x1b[2;1H$\x1b[K\x1b[2;3H${PAINT_END}`, term)).toBeNull()
  })

  it('a paint with more rows than the screen', async () => {
    const term = await smallTerminal()
    const blank = '\x1b[K\r\n'.repeat(8)
    // The last two lines as the console holds them, then more blank rows than fit.
    const paint = `${PAINT_START}${'y'.repeat(10)}\x1b[K\r\nL8 ${'y'.repeat(30)}\x1b[K\r\n$\x1b[K\r\n${blank}\x1b[3;3H${PAINT_END}`
    expect(alignConsoleRepaint(paint, term)).toBeNull()
  })

  it('the console\'s own paint of this screen is moved: the same lines, written where the terminal holds them', async () => {
    const term = await smallTerminal()
    // The console holds the end of L7 (10 of its 33 characters), L8 and the prompt.
    const paint = `${PAINT_START}${'y'.repeat(10)}\x1b[K\r\nL8 ${'y'.repeat(30)}\x1b[K\r\n$\x1b[K\r\n\x1b[K\r\n\x1b[K\x1b[4;3H${PAINT_END}`
    const out = alignConsoleRepaint(paint, term)
    expect(out).not.toBeNull()
    await new Promise<void>((done) => term.write(out!, done))
    const b = term.buffer.active
    const screen = Array.from({ length: term.rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? '')
    // L7 keeps its start: the console's piece of it is not written over it.
    expect(screen).toEqual(['y'.repeat(13), 'L8 ' + 'y'.repeat(17), 'y'.repeat(13), '$', '', ''])
    expect(b.getLine(b.baseY - 1)?.translateToString(true)).toBe('L7 ' + 'y'.repeat(17))
    expect([b.cursorY, b.cursorX]).toEqual([3, 2])
  })

  it('the same paint with the first cell\'s colour before its cursor home (the console sends it when the colour is not the one it last sent) is moved too, the colour kept', async () => {
    const term = await smallTerminal()
    const paint = `${PAINT_START_COLOURED}${'y'.repeat(10)}\x1b[K\r\nL8 ${'y'.repeat(30)}\x1b[K\r\n$\x1b[K\r\n\x1b[K\r\n\x1b[K\x1b[4;3H${PAINT_END}`
    const out = alignConsoleRepaint(paint, term)
    expect(out).not.toBeNull()
    expect(out).toContain('\x1b[33m')
    await new Promise<void>((done) => term.write(out!, done))
    const b = term.buffer.active
    const screen = Array.from({ length: term.rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? '')
    expect(screen).toEqual(['y'.repeat(13), 'L8 ' + 'y'.repeat(17), 'y'.repeat(13), '$', '', ''])
    expect(b.getLine(b.baseY - 1)?.translateToString(true)).toBe('L7 ' + 'y'.repeat(17))
    expect([b.cursorY, b.cursorX]).toEqual([3, 2])
  })
})

/** A terminal that records what is written to it and parses on a later task,
 *  as xterm does. `refuses`: the writes it throws on, as xterm does once about
 *  50 MB waits to be parsed (a refused write is not recorded). */
function recordingTerminal(refuses: (data: string) => boolean = () => false) {
  const writes: string[] = []
  const pending: Array<() => void> = []
  const term: RepaintTerminal = {
    cols: 20,
    rows: 6,
    buffer: { active: { type: 'normal', baseY: 0, viewportY: 0, cursorY: 0, getLine: () => undefined } },
    write(data, cb) {
      if (refuses(data)) throw new Error('xterm refused the write')
      writes.push(data)
      pending.push(() => cb?.())
    },
    // It holds no rows: nothing brings them down, nor puts a view back.
    resize() { throw new Error('not sized by the aligner') },
    scrollLines() { throw new Error('not scrolled by the aligner') },
    scrollToLine() { throw new Error('not scrolled by the aligner') },
  }
  const parse = () => { while (pending.length) pending.shift()!() }
  return { term, writes, parse }
}

describe('the aligner writes in order, and only a paint after a size is looked at', () => {
  const PAINT = `${PAINT_START}x\x1b[K\x1b[1;2H${PAINT_END}`

  it('no size sent: a paint is written as it came, in one write', () => {
    const t = recordingTerminal()
    const a = createConsoleRepaintAligner(t.term, { now: () => 0 })
    a.write(`a${PAINT}b`)
    expect(t.writes).toEqual([`a${PAINT}b`])
  })

  it(`a size sent more than ${REPAINT_WINDOW_MS} ms before: written as it came`, () => {
    let now = 0
    const t = recordingTerminal()
    const a = createConsoleRepaintAligner(t.term, { now: () => now })
    a.noteResize()
    now = REPAINT_WINDOW_MS + 1
    a.write(PAINT)
    expect(t.writes).toEqual([PAINT])
  })

  it('output written as it came (a held terminal\'s replay) is not looked into, even right after a size', () => {
    const t = recordingTerminal()
    const a = createConsoleRepaintAligner(t.term, { now: () => 0 })
    a.noteResize()
    a.write(`a${PAINT}b`, undefined, true)
    expect(t.writes).toEqual([`a${PAINT}b`])
  })

  it('a paint split across two writes is written as it came', () => {
    const t = recordingTerminal()
    const a = createConsoleRepaintAligner(t.term, { now: () => 0 })
    a.noteResize()
    a.write(PAINT.slice(0, 8))
    a.write(PAINT.slice(8))
    expect(t.writes).toEqual([PAINT.slice(0, 8), PAINT.slice(8)])
  })

  it('after a size: what came before the paint is parsed first; what comes after it, in the chunk and in later writes, follows it in order; parsed runs once all of it is', () => {
    const t = recordingTerminal()
    const a = createConsoleRepaintAligner(t.term, { now: () => 0 })
    let parsed = 0
    a.noteResize()
    a.write(`a${PAINT}b`, () => { parsed++ })
    a.write('c')
    expect(t.writes, 'the paint waits for what came before it').toEqual(['a'])
    t.parse()
    // The recording terminal holds no rows, so the paint is written as it came.
    expect(t.writes).toEqual(['a', PAINT, 'b', 'c'])
    expect(parsed).toBe(1)
  })

  it('a paint that begins with its first cell\'s colour before the cursor home is looked at too: it waits for what came before it', () => {
    const coloured = `${PAINT_START_COLOURED}x\x1b[K\x1b[1;2H${PAINT_END}`
    const t = recordingTerminal()
    const a = createConsoleRepaintAligner(t.term, { now: () => 0 })
    a.noteResize()
    a.write(`a${coloured}b`)
    expect(t.writes, 'the paint waits for what came before it').toEqual(['a'])
    t.parse()
    expect(t.writes).toEqual(['a', coloured, 'b'])
  })

  it('xterm refuses the output before a paint: its caller is told, as before, and later output still reaches the terminal', () => {
    const t = recordingTerminal((d) => d === 'a')
    const a = createConsoleRepaintAligner(t.term, { now: () => 0 })
    let parsed = 0
    a.noteResize()
    expect(() => a.write(`a${PAINT}b`)).toThrow('xterm refused the write')
    a.write('later', () => { parsed++ })
    expect(t.writes).toEqual(['later'])
    t.parse()
    expect(parsed).toBe(1)
  })

  it('xterm refuses the output after a paint and a write queued behind it: each caller is told it is done, nothing is thrown into xterm\'s write loop', () => {
    const t = recordingTerminal((d) => d === 'after' || d === 'queued')
    const a = createConsoleRepaintAligner(t.term, { now: () => 0 })
    let afterParsed = 0
    let queuedParsed = 0
    a.noteResize()
    a.write(`a${PAINT}after`, () => { afterParsed++ })
    a.write('queued', () => { queuedParsed++ })
    expect(t.writes).toEqual(['a'])
    expect(() => t.parse()).not.toThrow()
    expect([afterParsed, queuedParsed]).toEqual([1, 1])
    expect(t.writes).toEqual(['a', PAINT])
    // The aligner goes on.
    a.write('later')
    expect(t.writes).toEqual(['a', PAINT, 'later'])
  })
})

describe('which terminals go through the aligner', () => {
  it('on Windows, a terminal on the console built into Windows', () => {
    expect(consoleRepaintApplies({ platform: 'win32', shipsOwnConsole: false })).toBe(true)
  })
  it('not one on the console host the app ships, and none on macOS or Linux', () => {
    expect(consoleRepaintApplies({ platform: 'win32', shipsOwnConsole: true })).toBe(false)
    expect(consoleRepaintApplies({ platform: 'darwin', shipsOwnConsole: false })).toBe(false)
    expect(consoleRepaintApplies({ platform: 'linux', shipsOwnConsole: false })).toBe(false)
    expect(consoleRepaintApplies({ platform: undefined, shipsOwnConsole: false })).toBe(false)
  })
})
