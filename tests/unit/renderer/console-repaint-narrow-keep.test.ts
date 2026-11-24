// @vitest-environment jsdom
// aicc_planning#414 (beta.17 C5b): what a narrowing's paint placed by bringing xterm's
// rows down (src/renderer/components/terminal/consoleRepaint.ts, bringRowsDown) does to
// a selection and to a view the user has scrolled up.
//
// bringRowsDown sizes xterm twice (to its cursor's row, then back) to bring rows down
// out of its scrollback. On C5's head (f1999f08) that cleared any selection (xterm's
// SelectionService clears one whenever its rows change) and moved a scrolled-up view
// up one row for each row brought down (Buffer.resize). Measured here first, on xterm
// itself: the window's own narrowing clears a selection when its rows change too (a
// window maximised back, as B3's 140x28 to 103x27), and keeps it when only its
// columns change (a narrower window of the same height, a pane opened beside the
// terminal); written as it came, the paint leaves a scrolled-up view where it was.
//
// The app's xterm (@xterm/xterm 6.0.0: a selection, and a view moved by its scroll
// bar) runs here in jsdom with its cell measured as 9x17 (jsdom lays nothing out);
// @xterm/headless (the other console-repaint test files') has no selection and no
// scroll bar, and is checked for the view too.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { Terminal as AppTerminal } from '@xterm/xterm'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { alignConsoleRepaint, createConsoleRepaintAligner, type RepaintTerminal } from '../../../src/renderer/components/terminal/consoleRepaint'

const stubbed: Array<{ proto: object; key: string; was: PropertyDescriptor | undefined }> = []
function stub(proto: object, key: string, value: PropertyDescriptor): void {
  stubbed.push({ proto, key, was: Object.getOwnPropertyDescriptor(proto, key) })
  Object.defineProperty(proto, key, { configurable: true, ...value })
}

beforeAll(() => {
  // xterm measures its cell from a span of 32 W's (DomMeasureStrategy): 9x17.
  stub(HTMLElement.prototype, 'offsetWidth', { get: () => 9 * 32 })
  stub(HTMLElement.prototype, 'offsetHeight', { get: () => 17 })
  // No canvas in jsdom: xterm falls back to the span.
  stub(HTMLCanvasElement.prototype, 'getContext', { value: () => null, writable: true })
  if (!window.matchMedia) {
    stub(window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }), writable: true })
  }
})

afterAll(() => {
  for (const { proto, key, was } of stubbed.reverse()) {
    if (was) Object.defineProperty(proto, key, was)
    else delete (proto as Record<string, unknown>)[key]
  }
})

const made: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const t of made.splice(0)) t.dispose()
  document.body.replaceChildren()
})

type Kind = 'app' | 'headless'
type AnyTerminal = AppTerminal | HeadlessTerminal

function makeTerminal(kind: Kind, cols: number, rows: number): AnyTerminal {
  if (kind === 'headless') {
    const t = new HeadlessTerminal({ cols, rows, scrollback: 200, allowProposedApi: true })
    made.push(t)
    return t
  }
  const el = document.createElement('div')
  document.body.appendChild(el)
  const t = new AppTerminal({ cols, rows, scrollback: 200, allowProposedApi: true })
  t.open(el)
  made.push(t)
  return t
}

const write = (term: AnyTerminal, s: string) => new Promise<void>((done) => term.write(s, done))
/** A frame of the app's xterm: its scroll bar takes the buffer's size (Viewport). */
const frame = () => new Promise<void>((done) => setTimeout(done, 40))
const lineAt = (term: AnyTerminal, y: number) => term.buffer.active.getLine(y)?.translateToString(true) ?? ''
const count = (term: AnyTerminal, text: string) => {
  let n = 0
  for (let y = 0; y < term.buffer.active.length; y++) if (lineAt(term, y) === text) n++
  return n
}

const RULE_30 = '-'.repeat(30)
const STATUS_30 = 'mode on' + ' '.repeat(10) + 'not logged in'

/** `shell` lines of a shell, then a program's screen from its top row at 30
 *  columns and `rows` rows: two header lines, a blank row, a full-width rule,
 *  its input row with the cursor on it, a full-width rule, a full-width status
 *  row, blank rows (console-repaint-claude-code.test.ts's narrowedTerminal). */
async function programTerminal(kind: Kind, shell: number, rows = 10): Promise<AnyTerminal> {
  const term = makeTerminal(kind, 30, rows)
  const screen = ['HEADER A', 'HEADER B', '', RULE_30, '> input', RULE_30, STATUS_30]
  while (screen.length < rows) screen.push('')
  const lines = [...Array.from({ length: shell }, (_, i) => `$ shell ${i + 1}`), ...screen]
  await write(term, lines.join('\r\n') + '\x1b[5;8H')
  await frame()
  return term
}

/** The program's screen drawn again at 20 columns and 10 rows, as the console
 *  paints it. */
function narrowPaint(): string {
  const body = ['HEADER A', 'HEADER B', '', '-'.repeat(20), '> input', '-'.repeat(20), 'mode on  logged out']
  while (body.length < 10) body.push('')
  return '\x1b[?25l\x1b[H' + body.map((l) => `${l}\x1b[K`).join('\r\n') + '\x1b[5;8H\x1b[?25h'
}

/** The console's paint after a size already given to xterm, through the
 *  aligner, told of the size as TerminalView tells it. */
async function paintThroughAligner(term: AnyTerminal): Promise<void> {
  const aligner = createConsoleRepaintAligner(term as unknown as RepaintTerminal, { now: () => 0 })
  aligner.noteResize()
  await new Promise<void>((done) => aligner.write(narrowPaint(), done))
}

/** The window narrowed to 20x10 (xterm's own resize, then the size sent to the
 *  console), and the console's paint through the aligner. */
async function narrowAndPaint(term: AnyTerminal): Promise<void> {
  term.resize(20, 10)
  await paintThroughAligner(term)
}

describe('a selection across the window\'s own narrowing, on xterm itself (the measurement)', () => {
  it('columns and rows (a window maximised back): xterm clears it before any paint', async () => {
    const term = await programTerminal('app', 12, 11) as AppTerminal
    term.select(0, 2, 9)
    expect(term.getSelection()).toBe('$ shell 3')
    term.resize(20, 10)
    expect(term.hasSelection()).toBe(false)
  })

  it('columns only (a narrower window of the same height): xterm keeps it', async () => {
    const term = await programTerminal('app', 12) as AppTerminal
    term.select(0, 2, 9)
    term.resize(20, 10)
    expect(term.getSelection()).toBe('$ shell 3')
  })
})

describe('a narrowing of columns only whose paint xterm\'s rows are brought down for (aicc_planning#414, C5b)', () => {
  it('a selection in the scrollback is selected again: the same text (C5, f1999f08: cleared)', async () => {
    const term = await programTerminal('app', 12) as AppTerminal
    term.select(0, 2, 9)
    await narrowAndPaint(term)
    // The paint was placed: the header lines once, xterm's top row its top line.
    expect([count(term, 'HEADER A'), count(term, 'HEADER B'), term.buffer.active.baseY]).toEqual([1, 1, 12])
    expect(term.getSelection()).toBe('$ shell 3')
  })

  it('a selection on a line the paint was found by (above xterm\'s screen before it, its top row after): the same text', async () => {
    const term = await programTerminal('app', 12) as AppTerminal
    term.resize(20, 10)
    term.select(0, 12, 8)
    expect(term.getSelection()).toBe('HEADER A')
    expect(term.buffer.active.baseY).toBe(14)
    await paintThroughAligner(term)
    expect([term.buffer.active.baseY, lineAt(term, 12)]).toEqual([12, 'HEADER A'])
    expect(term.getSelection()).toBe('HEADER A')
  })

  it('a selection over two rows comes back whole', async () => {
    const term = await programTerminal('app', 12) as AppTerminal
    term.resize(20, 10)
    term.select(3, 2, 20 + 5)
    const before = term.getSelection()
    expect(before).toBe('hell 3\n$ shell ')
    await paintThroughAligner(term)
    expect([count(term, 'HEADER A'), term.getSelection()]).toEqual([1, before])
  })

  it('no selection: none is made', async () => {
    const term = await programTerminal('app', 12) as AppTerminal
    await narrowAndPaint(term)
    expect(term.hasSelection()).toBe(false)
  })
})

describe('a view the user has scrolled up, across a narrowing whose paint xterm\'s rows are brought down for (aicc_planning#414, C5b)', () => {
  // 40 shell lines and the program's screen: before the narrowing xterm's top
  // row is 40; xterm's own narrowing moves it to 42 (the header lines above it);
  // the paint brings 5 rows down (its screen's rows below the cursor), 2 for the
  // header lines and 3 scrolled back up by line breaks: its top row is 40 again.
  for (const kind of ['app', 'headless'] as const) {
    it(`${kind}: scrolled up past the rows brought down (10 rows up): the view stays on its rows, the same text at its top (C5, f1999f08: 5 rows higher)`, async () => {
      const term = await programTerminal(kind, 40)
      term.scrollLines(-10)
      term.resize(20, 10)
      await frame()
      const view = term.buffer.active.viewportY
      expect([view, lineAt(term, view), term.buffer.active.baseY]).toEqual([30, '$ shell 31', 42])
      await paintThroughAligner(term)
      expect([term.buffer.active.baseY, count(term, 'HEADER A')], 'the paint was placed').toEqual([40, 1])
      expect([term.buffer.active.viewportY, lineAt(term, term.buffer.active.viewportY)]).toEqual([30, '$ shell 31'])
      // The scroll bar agrees with the view: a step up from there is one row up.
      term.scrollLines(-1)
      expect(term.buffer.active.viewportY).toBe(29)
    })

    it(`${kind}: scrolled up fewer rows than were brought down (1 row up): the view is put back on its rows once the paint is written (C5: 5 rows higher)`, async () => {
      const term = await programTerminal(kind, 40)
      term.scrollLines(-1)
      term.resize(20, 10)
      await frame()
      expect([term.buffer.active.viewportY, lineAt(term, 39)]).toEqual([39, '$ shell 40'])
      await paintThroughAligner(term)
      expect([term.buffer.active.viewportY, lineAt(term, term.buffer.active.viewportY)]).toEqual([39, '$ shell 40'])
      term.scrollLines(-1)
      expect(term.buffer.active.viewportY).toBe(38)
    })

    it(`${kind}: at the bottom, the view stays at the bottom`, async () => {
      const term = await programTerminal(kind, 40)
      term.resize(20, 10)
      await paintThroughAligner(term)
      const b = term.buffer.active
      expect([b.baseY, b.viewportY, count(term, 'HEADER A')]).toEqual([40, 40, 1])
    })
  }

  for (const kind of ['app', 'headless'] as const) {
    it(`${kind}: the moment the rows are brought down, before the paint is written, the view is already on its rows (no frame shows it moved)`, async () => {
      const term = await programTerminal(kind, 40)
      term.scrollLines(-10)
      term.resize(20, 10)
      await frame()
      expect(alignConsoleRepaint(narrowPaint(), term as unknown as RepaintTerminal)).not.toBeNull()
      expect([term.buffer.active.baseY, term.buffer.active.viewportY]).toEqual([37, 30])
      term.scrollLines(-1)
      expect(term.buffer.active.viewportY).toBe(29)
    })
  }

  it('app: scrolled up fewer rows than were brought down, the view never reaches the bottom on the way (TerminalView\'s onScroll would count the user back at the bottom)', async () => {
    const term = await programTerminal('app', 40) as AppTerminal
    term.scrollLines(-1)
    term.resize(20, 10)
    await frame()
    const seen: Array<[number, number]> = []
    const sub = term.onScroll(() => seen.push([term.buffer.active.viewportY, term.buffer.active.baseY]))
    await paintThroughAligner(term)
    sub.dispose()
    expect(term.buffer.active.viewportY).toBe(39)
    expect(seen.filter(([view, base]) => view >= base)).toEqual([])
  })

  it('headless, written as it came (no aligner): the view stays where it was, the header lines twice', async () => {
    const term = await programTerminal('headless', 40)
    term.scrollLines(-10)
    term.resize(20, 10)
    await write(term, narrowPaint())
    expect([term.buffer.active.viewportY, count(term, 'HEADER A')]).toEqual([30, 2])
  })
})
