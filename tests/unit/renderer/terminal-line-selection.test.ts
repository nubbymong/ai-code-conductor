// @vitest-environment jsdom
// aicc_planning#422 (beta.17 C10) and #424 (C11): a selection (a triple-click's line, a drag
// over part of a line) across a change of the columns only, on the app's xterm
// (@xterm/xterm 6.0.0) in jsdom, its cell measured as 9x17 as
// console-repaint-narrow-keep.test.ts does. The clicks and drags go through xterm's own
// mouse handler (SelectionService.handleMouseDown: the third press has detail 3).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { createConsoleRepaintAligner, type RepaintTerminal } from '../../../src/renderer/components/terminal/consoleRepaint'
import { keepLineSelection } from '../../../src/renderer/components/terminal/lineSelectionKeep'

const stubbed: Array<{ proto: object; key: string; was: PropertyDescriptor | undefined }> = []
function stub(proto: object, key: string, value: PropertyDescriptor): void {
  stubbed.push({ proto, key, was: Object.getOwnPropertyDescriptor(proto, key) })
  Object.defineProperty(proto, key, { configurable: true, ...value })
}

beforeAll(() => {
  stub(HTMLElement.prototype, 'offsetWidth', { get: () => 9 * 32 })
  stub(HTMLElement.prototype, 'offsetHeight', { get: () => 17 })
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

const made: Terminal[] = []
afterEach(() => {
  for (const t of made.splice(0)) t.dispose()
  document.body.replaceChildren()
})

const write = (term: Terminal, s: string) => new Promise<void>((done) => term.write(s, done))
const frame = () => new Promise<void>((done) => setTimeout(done, 40))
const pos = (term: Terminal) => {
  const p = term.getSelectionPosition()
  return p ? [p.start.x, p.start.y, p.end.x, p.end.y] : null
}

const RULE_30 = '-'.repeat(30)
const STATUS_30 = 'mode on' + ' '.repeat(10) + 'not logged in'

/** `shell` lines of a shell (that many `$ shell N`, or these lines), then a
 *  program's screen at 30x10 with the cursor on its input row
 *  (console-repaint-narrow-keep.test.ts's programTerminal). */
async function programTerminal(shell: number | string[], rows = 10): Promise<Terminal> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const term = new Terminal({ cols: 30, rows, scrollback: 200 })
  term.open(host)
  made.push(term)
  const screen = ['HEADER A', 'HEADER B', '', RULE_30, '> input', RULE_30, STATUS_30]
  while (screen.length < rows) screen.push('')
  const shellLines = typeof shell === 'number' ? Array.from({ length: shell }, (_, i) => `$ shell ${i + 1}`) : shell
  const lines = [...shellLines, ...screen]
  await write(term, lines.join('\r\n') + '\x1b[5;8H')
  await frame()
  return term
}

/** The mouse pressed and let go `count` times on a cell of the view, as a
 *  browser gives a double or triple click (each press's detail counts up). */
function clickCell(term: Terminal, col: number, viewRow: number, count: number): void {
  const screen = term.element!.querySelector('.xterm-screen') as HTMLElement
  const at = { clientX: col * 9 + 4, clientY: viewRow * 17 + 8, button: 0, bubbles: true, cancelable: true }
  for (let detail = 1; detail <= count; detail++) {
    screen.dispatchEvent(new MouseEvent('mousedown', { ...at, detail }))
    document.dispatchEvent(new MouseEvent('mouseup', { ...at, detail }))
  }
}

/** A drag along a row of the view from one cell to another. */
function dragCells(term: Terminal, viewRow: number, fromCol: number, toCol: number): void {
  const screen = term.element!.querySelector('.xterm-screen') as HTMLElement
  const y = viewRow * 17 + 8
  screen.dispatchEvent(new MouseEvent('mousedown', { clientX: fromCol * 9 + 1, clientY: y, button: 0, detail: 1, bubbles: true }))
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: toCol * 9 + 8, clientY: y, button: 0, buttons: 1, bubbles: true }))
  document.dispatchEvent(new MouseEvent('mouseup', { clientX: toCol * 9 + 8, clientY: y, button: 0, detail: 1, bubbles: true }))
}

/** A drag from the cell edge `fromX` of view row `fromRow` to the edge `toX`
 *  of view row `toRow` (0 to the columns: xterm takes the edge nearest the
 *  pointer, so these are the selection's own start and end). */
function dragBetween(term: Terminal, fromX: number, fromRow: number, toX: number, toRow: number): void {
  const screen = term.element!.querySelector('.xterm-screen') as HTMLElement
  const at = (x: number, row: number) => ({ clientX: x * 9 + 1, clientY: row * 17 + 8, button: 0, bubbles: true })
  screen.dispatchEvent(new MouseEvent('mousedown', { ...at(fromX, fromRow), detail: 1 }))
  document.dispatchEvent(new MouseEvent('mousemove', { ...at(toX, toRow), buttons: 1 }))
  document.dispatchEvent(new MouseEvent('mouseup', { ...at(toX, toRow), detail: 1 }))
}

/** The console's paint after a narrowing to 20x10, through the aligner as
 *  TerminalView gives it (console-repaint-narrow-keep.test.ts's paint). */
async function paintThroughAligner(term: Terminal): Promise<void> {
  const body = ['HEADER A', 'HEADER B', '', '-'.repeat(20), '> input', '-'.repeat(20), 'mode on  logged out']
  while (body.length < 10) body.push('')
  const paint = '\x1b[?25l\x1b[H' + body.map((l) => `${l}\x1b[K`).join('\r\n') + '\x1b[5;8H\x1b[?25h'
  const aligner = createConsoleRepaintAligner(term as unknown as RepaintTerminal, { now: () => 0 })
  aligner.noteResize()
  await new Promise<void>((done) => aligner.write(paint, done))
}

describe('a triple-click line selection and a narrowing of the columns only, on xterm itself (the measurement, aicc_planning#422)', () => {
  it('xterm keeps it as a start and a length: the end runs on into the next row, and a copy ends with a line break and that row\'s text', async () => {
    const term = await programTerminal(12)
    // The view starts on row 9 (12 shell lines, 10 rows: 9 above the screen).
    term.scrollToTop()
    await frame()
    clickCell(term, 3, 2, 3)
    expect(pos(term)).toEqual([0, 2, 30, 2])
    expect(term.getSelection()).toBe('$ shell 3')
    term.resize(20, 10)
    expect(pos(term), 'start (0,2), end past the row: (10,3)').toEqual([0, 2, 10, 3])
    expect(term.getSelection()).toBe('$ shell 3\n$ shell 4')
  })

  it('with the Claude Code paint after it, through the aligner (C5b selects it again by its start and length): the same run-on', async () => {
    const term = await programTerminal(12)
    term.scrollToTop()
    await frame()
    clickCell(term, 3, 2, 3)
    term.resize(20, 10)
    await paintThroughAligner(term)
    expect(term.getSelection()).toBe('$ shell 3\n$ shell 4')
  })

  it('a drag over the same row keeps its text exactly (xterm keeps its end)', async () => {
    const term = await programTerminal(12)
    term.scrollToTop()
    await frame()
    dragCells(term, 2, 0, 8)
    expect(term.getSelection()).toBe('$ shell 3')
    term.resize(20, 10)
    expect(term.getSelection()).toBe('$ shell 3')
    await paintThroughAligner(term)
    expect(term.getSelection()).toBe('$ shell 3')
  })

  it('the rows change as well: xterm clears it (SelectionService, rowsChanged)', async () => {
    const term = await programTerminal(12, 11)
    term.scrollToTop()
    await frame()
    clickCell(term, 3, 2, 3)
    expect(term.getSelection()).toBe('$ shell 3')
    term.resize(20, 10)
    expect(term.hasSelection()).toBe(false)
  })
})

/** Lines under a 25-cell line: a narrowing to 20 columns wraps it over two
 *  rows and moves every line below it a row down. */
const UNDER_LONG = ['$ shell 1', 'x'.repeat(25), '$ shell 3', '$ shell 4', '$ shell 5']
/** A 45-cell line of five runs, each told apart: A to D ten cells, E five. */
const RUNS_45 = 'A'.repeat(10) + 'B'.repeat(10) + 'C'.repeat(10) + 'D'.repeat(10) + 'E'.repeat(5)

describe('a drag over part of a line and a change of the columns only, on xterm itself (the measurement, aicc_planning#424)', () => {
  it('a drag inside a row below a longer line the narrowing re-wraps: xterm leaves it on its row, which now holds the longer line\'s last part', async () => {
    const term = await linesTerminal(30, UNDER_LONG)
    dragCells(term, 2, 0, 4)
    expect(term.getSelection()).toBe('$ she')
    term.resize(20, 10)
    expect(pos(term)).toEqual([0, 2, 5, 2])
    expect(term.getSelection()).toBe('xxxxx')
  })

  it('a drag over part of a wrapped line, across its row break: xterm keeps its cells, which now hold other parts of the line', async () => {
    const term = await linesTerminal(30, ['$ shell 1', RUNS_45, '$ shell 3'])
    dragBetween(term, 25, 1, 5, 2)
    expect(term.getSelection()).toBe('CCCCCDDDDD')
    term.resize(20, 10)
    expect(pos(term)).toEqual([25, 1, 5, 2])
    expect(term.getSelection(), 'narrowed').toBe('CCCCC')
    term.resize(50, 10)
    expect(pos(term)).toEqual([25, 1, 5, 2])
    expect(term.getSelection(), 'then widened past the line').toBe('CCCCCDDDDDDDDDDEEEEE\n$ she')
  })

  it('a drag over the ends of two lines below a longer line the narrowing re-wraps: other text', async () => {
    const term = await linesTerminal(30, UNDER_LONG)
    dragBetween(term, 2, 2, 5, 3)
    expect(term.getSelection()).toBe('shell 3\n$ she')
    term.resize(20, 10)
    expect(pos(term)).toEqual([2, 2, 5, 3])
    expect(term.getSelection()).toBe('xxx\n$ she')
  })

  it('with the Claude Code paint after it through the aligner (C5b selects it again by its start and length): the same other text', async () => {
    const term = await programTerminal(['$ shell 1', 'x'.repeat(25), ...Array.from({ length: 10 }, (_, i) => `$ shell ${i + 3}`)])
    term.scrollToTop()
    await frame()
    dragBetween(term, 0, 2, 5, 2)
    expect(term.getSelection()).toBe('$ she')
    term.resize(20, 10)
    await paintThroughAligner(term)
    expect(countOf(term, 'HEADER A'), 'the paint was placed').toBe(1)
    expect(pos(term)).toEqual([0, 2, 5, 2])
    expect(term.getSelection()).toBe('xxxxx')
  })

  it('a drag that ends on a line\'s first cell copies the line break before it; xterm\'s select (a start and a length) cannot end there: the same cells end at the row before, with no line break', async () => {
    const term = await linesTerminal(30, SHELL)
    dragBetween(term, 0, 2, 0, 4)
    expect(pos(term)).toEqual([0, 2, 0, 4])
    expect(term.getSelection()).toBe('$ shell 3\n$ shell 4\n')
    term.select(0, 2, 60)
    expect(pos(term)).toEqual([0, 2, 30, 3])
    expect(term.getSelection()).toBe('$ shell 3\n$ shell 4')
  })
})

/** A terminal of `cols`x10 with `lines` written, its cursor after the last:
 *  no rows above its screen, its view on row 0. */
async function linesTerminal(cols: number, lines: string[]): Promise<Terminal> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const term = new Terminal({ cols, rows: 10, scrollback: 200 })
  term.open(host)
  made.push(term)
  await write(term, lines.join('\r\n'))
  await frame()
  return term
}

const countOf = (term: Terminal, text: string) => {
  let n = 0
  for (let y = 0; y < term.buffer.active.length; y++) if (term.buffer.active.getLine(y)?.translateToString(true) === text) n++
  return n
}

const SHELL = ['$ shell 1', '$ shell 2', '$ shell 3', '$ shell 4', '$ shell 5', '$ shell 6']

describe('kept on its line by keepLineSelection, as TerminalView wires it (aicc_planning#422)', () => {
  it('a triple-click\'s line, the columns narrowed: the same line, exactly, with no line break and nothing of the next row (xterm: runs on)', async () => {
    const term = await programTerminal(12)
    keepLineSelection(term)
    term.scrollToTop()
    await frame()
    clickCell(term, 3, 2, 3)
    term.resize(20, 10)
    expect(pos(term)).toEqual([0, 2, 20, 2])
    expect(term.getSelection()).toBe('$ shell 3')
  })

  it('with the Claude Code paint after it through the aligner (C5b selects it again by its start and length): the same line, exactly, and the paint placed', async () => {
    const term = await programTerminal(12)
    keepLineSelection(term)
    term.scrollToTop()
    await frame()
    clickCell(term, 3, 2, 3)
    term.resize(20, 10)
    await paintThroughAligner(term)
    expect(countOf(term, 'HEADER A'), 'the paint was placed').toBe(1)
    expect(term.getSelection()).toBe('$ shell 3')
  })

  it('a second change of the columns after the Claude Code paint through the aligner: still the same line (C5b\'s two sizes clear it and it selects the same cells again, which xterm reports to no one)', async () => {
    const term = await programTerminal(12)
    keepLineSelection(term)
    term.scrollToTop()
    await frame()
    clickCell(term, 3, 2, 3)
    term.resize(20, 10)
    const resize = vi.spyOn(term, 'resize')
    const reported: Array<number[] | null> = []
    const sub = term.onSelectionChange(() => reported.push(pos(term)))
    await paintThroughAligner(term)
    sub.dispose()
    expect(resize.mock.calls, 'the paint went through bringRowsDown\'s two sizes').toEqual([[20, 5], [20, 10]])
    expect(reported, 'two clears reported; the same cells selected again, not').toEqual([null, null])
    expect(countOf(term, 'HEADER A'), 'the paint was placed').toBe(1)
    expect(term.getSelection()).toBe('$ shell 3')
    resize.mockRestore()
    term.resize(15, 10)
    expect(pos(term)).toEqual([0, 2, 15, 2])
    expect(term.getSelection()).toBe('$ shell 3')
  })

  it('cleared since it was noted (a change of the rows, typing, a single click), then the columns alone in the same turn: not selected again', async () => {
    const clears: Array<[string, (term: Terminal) => void]> = [
      ['a change of the rows', (term) => term.resize(30, 9)],
      ['typing', (term) => term.input('x', true)],
      ['a single click', (term) => clickCell(term, 3, 2, 1)],
    ]
    for (const [what, clear] of clears) {
      const term = await linesTerminal(30, SHELL)
      keepLineSelection(term)
      clickCell(term, 3, 2, 3)
      expect(term.getSelection(), what).toBe('$ shell 3')
      const select = vi.spyOn(term, 'select')
      clear(term)
      expect(term.hasSelection(), what).toBe(false)
      term.resize(20, term.rows)
      expect(select, what).not.toHaveBeenCalled()
      expect(term.hasSelection(), what).toBe(false)
    }
  })

  it('a line selected again after a change of the rows cleared it: kept at the next change of the columns (compared with the last size, not the first)', async () => {
    const term = await linesTerminal(30, SHELL)
    keepLineSelection(term)
    clickCell(term, 3, 2, 3)
    term.resize(30, 9)
    expect(term.hasSelection()).toBe(false)
    await frame()
    clickCell(term, 3, 2, 3)
    expect(term.getSelection()).toBe('$ shell 3')
    term.resize(20, 9)
    expect(term.getSelection()).toBe('$ shell 3')
  })

  it('the same cells dragged over by hand after typing cleared the line, output having moved other lines under them (xterm reports no change): left as xterm keeps a drag, not moved to the line noted before', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const term = new Terminal({ cols: 30, rows: 10, scrollback: 5 })
    term.open(host)
    made.push(term)
    // 15 lines fill the buffer (5 of scrollback and 10 rows): each line after drops one from the top.
    await write(term, Array.from({ length: 15 }, (_, i) => `L${i + 1}`).join('\r\n'))
    await frame()
    keepLineSelection(term)
    clickCell(term, 1, 2, 3)
    expect(term.getSelection()).toBe('L8')
    term.input('x', true)
    expect(term.hasSelection()).toBe(false)
    await write(term, '\r\nL16\r\nL17')
    const reported: Array<number[] | null> = []
    const sub = term.onSelectionChange(() => reported.push(pos(term)))
    dragCells(term, 2, 0, 29)
    sub.dispose()
    expect(term.getSelection(), 'two rows dropped from the top: L10 is on those cells now').toBe('L10')
    expect(reported, 'no change reported: the cells xterm last reported, the line\'s').toEqual([])
    const select = vi.spyOn(term, 'select')
    term.resize(20, 10)
    expect(term.getSelection()).toBe('L10')
    expect(select).not.toHaveBeenCalled()
  })

  it('a drag over the first row of a wrapped line, from its first cell to past its last: kept as xterm keeps it, not grown to the whole line', async () => {
    const term = await linesTerminal(30, ['$ shell 1', 'z'.repeat(30) + 'w'.repeat(15), '$ shell 3'])
    keepLineSelection(term)
    const select = vi.spyOn(term, 'select')
    dragCells(term, 1, 0, 29)
    expect(term.getSelection()).toBe('z'.repeat(30))
    term.resize(50, 10)
    expect(select).not.toHaveBeenCalled()
    expect(term.getSelection()).toBe('z'.repeat(30))
  })

  it('a drag over the second row of a wrapped line, from its first cell to past its last: the same part of the line, not grown to the whole line (xterm: the row\'s cells, other text)', async () => {
    const term = await linesTerminal(30, ['$ shell 1', 'z'.repeat(30) + 'w'.repeat(15), '$ shell 3'])
    keepLineSelection(term)
    dragCells(term, 2, 0, 29)
    expect(term.getSelection()).toBe('w'.repeat(15))
    term.resize(20, 10)
    expect(pos(term)).toEqual([10, 2, 20, 3])
    expect(term.getSelection()).toBe('w'.repeat(15))
  })

  it('a longer line above it re-wrapped by the narrowing moves its line down a row: the selection moves with it (xterm: stays on the row)', async () => {
    const term = await linesTerminal(30, ['$ shell 1', 'x'.repeat(25), '$ shell 3', '$ shell 4', '$ shell 5'])
    keepLineSelection(term)
    clickCell(term, 3, 2, 3)
    expect(term.getSelection()).toBe('$ shell 3')
    term.resize(20, 10)
    expect(term.buffer.active.getLine(3)?.translateToString(true), 'the line moved down a row').toBe('$ shell 3')
    expect(pos(term)).toEqual([0, 3, 20, 3])
    expect(term.getSelection()).toBe('$ shell 3')
  })

  it('the line itself longer than the new width: the whole line, over both its rows', async () => {
    const term = await linesTerminal(30, ['$ shell 1', '$ shell 2', 'y'.repeat(28), '$ shell 4'])
    keepLineSelection(term)
    clickCell(term, 3, 2, 3)
    term.resize(20, 10)
    expect(pos(term)).toEqual([0, 2, 20, 3])
    expect(term.getSelection()).toBe('y'.repeat(28))
  })

  it('two whole lines selected by a start and a length (as C5b selects one again): the same two lines (xterm: three)', async () => {
    const term = await linesTerminal(30, SHELL)
    keepLineSelection(term)
    term.select(0, 2, 60)
    expect(term.getSelection()).toBe('$ shell 3\n$ shell 4')
    term.resize(20, 10)
    expect(pos(term)).toEqual([0, 2, 20, 3])
    expect(term.getSelection()).toBe('$ shell 3\n$ shell 4')
  })

  it('a widening that joins the line\'s own two rows into one: the line alone (xterm: runs on into the next line)', async () => {
    const term = await linesTerminal(30, ['$ shell 1', '$ shell 2', 'z'.repeat(45), '$ shell 4', '$ shell 5'])
    keepLineSelection(term)
    clickCell(term, 3, 2, 3)
    expect(term.getSelection()).toBe('z'.repeat(45))
    term.resize(50, 10)
    expect(pos(term)).toEqual([0, 2, 50, 2])
    expect(term.getSelection()).toBe('z'.repeat(45))
  })

  it('a widening that joins a wrapped line above it moves its line up a row: the selection moves with it (xterm: stays on the row, the next line)', async () => {
    const term = await linesTerminal(20, ['$ shell 1', 'x'.repeat(25), '$ shell 3', '$ shell 4', '$ shell 5'])
    keepLineSelection(term)
    clickCell(term, 3, 3, 3)
    expect(term.getSelection()).toBe('$ shell 3')
    term.resize(30, 10)
    expect(term.buffer.active.getLine(2)?.translateToString(true), 'the line moved up a row').toBe('$ shell 3')
    expect(pos(term)).toEqual([0, 2, 30, 2])
    expect(term.getSelection()).toBe('$ shell 3')
  })

  it('a drag inside a row is kept as xterm keeps it: its end and its text', async () => {
    const term = await linesTerminal(30, SHELL)
    keepLineSelection(term)
    dragCells(term, 2, 0, 4)
    const before = pos(term)
    expect(term.getSelection()).toBe('$ she')
    term.resize(20, 10)
    expect(pos(term)).toEqual(before)
    expect(term.getSelection()).toBe('$ she')
  })

  it('the rows change as well: xterm clears it, and it is not selected again', async () => {
    const term = await linesTerminal(30, SHELL)
    keepLineSelection(term)
    const select = vi.spyOn(term, 'select')
    clickCell(term, 3, 2, 3)
    term.resize(20, 9)
    expect(term.hasSelection()).toBe(false)
    expect(select).not.toHaveBeenCalled()
  })

  it('Select all stays Select all: it takes in the output written after the narrowing', async () => {
    const term = await linesTerminal(30, SHELL)
    keepLineSelection(term)
    term.selectAll()
    term.resize(20, 10)
    await write(term, '\r\n' + Array.from({ length: 15 }, (_, i) => `later ${i + 1}`).join('\r\n'))
    expect(term.getSelection()).toContain('later 15')
  })

  it('the selected line trimmed off the top of the scrollback (its marker gone with it): not selected again', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const term = new Terminal({ cols: 30, rows: 10, scrollback: 5 })
    term.open(host)
    made.push(term)
    await write(term, SHELL.join('\r\n'))
    await frame()
    keepLineSelection(term)
    const select = vi.spyOn(term, 'select')
    clickCell(term, 3, 0, 3)
    expect(term.getSelection()).toBe('$ shell 1')
    await write(term, '\r\n' + Array.from({ length: 20 }, (_, i) => `later ${i + 1}`).join('\r\n'))
    term.resize(20, 10)
    expect(select).not.toHaveBeenCalled()
  })

  it('@xterm/headless (no selection): nothing is wired, nothing thrown', async () => {
    const { Terminal: Headless } = await import('@xterm/headless')
    const term = new Headless({ cols: 30, rows: 10, allowProposedApi: true })
    try {
      expect(() => keepLineSelection(term as never).dispose()).not.toThrow()
    } finally { term.dispose() }
  })
})

/** 40 wide characters, each told apart (U+4E00 on: two cells each). */
const WIDE_40 = Array.from({ length: 40 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('')

describe('a drag over part of a line kept on its text by keepLineSelection, as TerminalView wires it (aicc_planning#424)', () => {
  it('a drag inside a row below a longer line the narrowing re-wraps: the same text a row down, and back on its row when widened again (xterm: the longer line\'s last part)', async () => {
    const term = await linesTerminal(30, UNDER_LONG)
    keepLineSelection(term)
    dragCells(term, 2, 0, 4)
    term.resize(20, 10)
    expect(pos(term)).toEqual([0, 3, 5, 3])
    expect(term.getSelection()).toBe('$ she')
    term.resize(30, 10)
    expect(pos(term)).toEqual([0, 2, 5, 2])
    expect(term.getSelection()).toBe('$ she')
  })

  it('a drag over part of a wrapped line, across its row break: the same part, narrowed and then widened past the line (xterm: other parts)', async () => {
    const term = await linesTerminal(30, ['$ shell 1', RUNS_45, '$ shell 3'])
    keepLineSelection(term)
    dragBetween(term, 25, 1, 5, 2)
    term.resize(20, 10)
    expect(pos(term)).toEqual([5, 2, 15, 2])
    expect(term.getSelection()).toBe('CCCCCDDDDD')
    term.resize(50, 10)
    expect(pos(term)).toEqual([25, 1, 35, 1])
    expect(term.getSelection()).toBe('CCCCCDDDDD')
  })

  it('a drag from a cell that starts a row at the new width: its start on that row\'s first cell, as xterm\'s own drag gives it, not past the end of the row before', async () => {
    const term = await linesTerminal(30, ['$ shell 1', RUNS_45, '$ shell 3'])
    keepLineSelection(term)
    dragBetween(term, 20, 1, 5, 2)
    expect(term.getSelection()).toBe('C'.repeat(10) + 'DDDDD')
    term.resize(20, 10)
    expect(pos(term)).toEqual([0, 2, 15, 2])
    expect(term.getSelection()).toBe('C'.repeat(10) + 'DDDDD')
  })

  it('a drag over only the empty cells after a line\'s text, narrowed to fewer columns than its start: left selected as xterm keeps it (nothing to select again)', async () => {
    const term = await linesTerminal(30, UNDER_LONG)
    keepLineSelection(term)
    dragBetween(term, 20, 2, 25, 2)
    expect(term.hasSelection()).toBe(true)
    expect(term.getSelection()).toBe('')
    term.resize(20, 10)
    expect(term.hasSelection()).toBe(true)
    expect(term.getSelection()).toBe('')
  })

  it('a drag over the ends of two lines below a longer line the narrowing re-wraps: the same text (xterm: other text)', async () => {
    const term = await linesTerminal(30, UNDER_LONG)
    keepLineSelection(term)
    dragBetween(term, 2, 2, 5, 3)
    term.resize(20, 10)
    expect(pos(term)).toEqual([2, 3, 5, 4])
    expect(term.getSelection()).toBe('shell 3\n$ she')
  })

  it('with the Claude Code paint after it through the aligner (C5b selects the same cells again, which xterm reports to no one), then a second narrowing: the same text each time', async () => {
    const term = await programTerminal(['$ shell 1', 'x'.repeat(25), ...Array.from({ length: 10 }, (_, i) => `$ shell ${i + 3}`)])
    keepLineSelection(term)
    term.scrollToTop()
    await frame()
    dragBetween(term, 0, 2, 5, 2)
    term.resize(20, 10)
    expect(term.getSelection()).toBe('$ she')
    await paintThroughAligner(term)
    expect(countOf(term, 'HEADER A'), 'the paint was placed').toBe(1)
    expect(term.getSelection()).toBe('$ she')
    term.resize(12, 10)
    expect(pos(term), 'the longer line over three rows now').toEqual([0, 4, 5, 4])
    expect(term.getSelection()).toBe('$ she')
  })

  it('a widening that joins a wrapped line above it: a drag below moves up a row with its line (xterm: stays on the row, the next line)', async () => {
    const term = await linesTerminal(20, UNDER_LONG)
    keepLineSelection(term)
    dragCells(term, 3, 0, 4)
    expect(term.getSelection()).toBe('$ she')
    term.resize(30, 10)
    expect(pos(term)).toEqual([0, 2, 5, 2])
    expect(term.getSelection()).toBe('$ she')
  })

  it('a drag that ends past the end of its line\'s text: the same line at a narrower width, not run on into the next', async () => {
    const term = await linesTerminal(30, UNDER_LONG)
    keepLineSelection(term)
    dragBetween(term, 2, 2, 25, 2)
    expect(term.getSelection()).toBe('shell 3')
    term.resize(20, 10)
    expect(pos(term)).toEqual([2, 3, 20, 3])
    expect(term.getSelection()).toBe('shell 3')
  })

  it('a drag that starts past the end of its line\'s text and ends in the next line: the line break and the same text (its start kept at its line\'s end)', async () => {
    const term = await linesTerminal(30, UNDER_LONG)
    keepLineSelection(term)
    dragBetween(term, 25, 2, 5, 3)
    expect(term.getSelection()).toBe('\n$ she')
    term.resize(20, 10)
    expect(pos(term)).toEqual([20, 3, 5, 4])
    expect(term.getSelection()).toBe('\n$ she')
  })

  it('a drag over wide characters of a wrapped line, narrowed to a width that leaves each row\'s last cell empty: the same characters, and widened back (xterm\'s re-wrap skips those cells; counted, the drag would move a character)', async () => {
    const term = await linesTerminal(30, ['$ shell 1', WIDE_40, '$ shell 3'])
    keepLineSelection(term)
    const two = WIDE_40.slice(32, 34)
    dragBetween(term, 4, 3, 8, 3)
    expect(term.getSelection()).toBe(two)
    term.resize(21, 10)
    expect(pos(term)).toEqual([4, 4, 8, 4])
    expect(term.getSelection()).toBe(two)
    term.resize(30, 10)
    expect(pos(term)).toEqual([4, 3, 8, 3])
    expect(term.getSelection()).toBe(two)
  })

  it('a drag to past the end of a row whose last cell xterm left empty before a wide character: that cell is the row\'s end, not the next character', async () => {
    const term = await linesTerminal(21, ['$ shell 1', WIDE_40, '$ shell 3'])
    keepLineSelection(term)
    const two = WIDE_40.slice(8, 10)
    dragBetween(term, 16, 1, 21, 1)
    expect(term.getSelection()).toBe(two)
    term.resize(30, 10)
    expect(pos(term)).toEqual([16, 1, 20, 1])
    expect(term.getSelection()).toBe(two)
  })

  it('a drag over part of the line the cursor is on, which xterm does not re-wrap: the same text on its row (counted as re-wrapped, it would move)', async () => {
    const term = await linesTerminal(30, ['$ shell 1', '$ ' + RUNS_45])
    keepLineSelection(term)
    dragBetween(term, 2, 2, 12, 2)
    expect(term.getSelection()).toBe('D'.repeat(10))
    term.resize(20, 10)
    expect(pos(term)).toEqual([2, 2, 12, 2])
    expect(term.getSelection()).toBe('D'.repeat(10))
  })

  it('the cursor\'s line narrowed (not re-wrapped, its rows cut), then output moves the cursor on and a widening re-wraps it: counted as it is after the cut, the same text', async () => {
    const term = await linesTerminal(30, ['$ shell 1', '$ ' + RUNS_45])
    keepLineSelection(term)
    dragBetween(term, 2, 2, 12, 2)
    term.resize(20, 10)
    expect(term.getSelection()).toBe('D'.repeat(10))
    await write(term, '\r\n$ next')
    term.resize(30, 10)
    expect(pos(term)).toEqual([22, 1, 2, 2])
    expect(term.getSelection()).toBe('D'.repeat(10))
  })

  it('a drag over part of a wrapped line in the alternate buffer, which xterm does not re-wrap: the same text on its row', async () => {
    const term = await linesTerminal(30, ['\x1b[?1049h$ shell 1', RUNS_45, '$ shell 3'])
    expect(term.buffer.active.type).toBe('alternate')
    keepLineSelection(term)
    dragBetween(term, 0, 2, 5, 2)
    expect(term.getSelection()).toBe('DDDDD')
    term.resize(20, 10)
    expect(pos(term)).toEqual([0, 2, 5, 2])
    expect(term.getSelection()).toBe('DDDDD')
  })

  it('a drag that ends on a line\'s first cell, nothing moved by the narrowing: left as xterm keeps it, its last line break copied', async () => {
    const term = await linesTerminal(30, SHELL)
    keepLineSelection(term)
    const select = vi.spyOn(term, 'select')
    dragBetween(term, 0, 2, 0, 4)
    expect(term.getSelection()).toBe('$ shell 3\n$ shell 4\n')
    term.resize(20, 10)
    expect(select).not.toHaveBeenCalled()
    expect(term.getSelection()).toBe('$ shell 3\n$ shell 4\n')
  })

  it('a drag that ends on a line\'s first cell, its lines moved by the narrowing: the same lines, without the last line break (xterm\'s select cannot end on a line\'s first cell)', async () => {
    const term = await linesTerminal(30, UNDER_LONG)
    keepLineSelection(term)
    dragBetween(term, 0, 2, 0, 4)
    expect(term.getSelection()).toBe('$ shell 3\n$ shell 4\n')
    term.resize(20, 10)
    expect(pos(term)).toEqual([0, 3, 20, 4])
    expect(term.getSelection()).toBe('$ shell 3\n$ shell 4')
  })

  it('Select all across a widening that joins a wrapped line (the buffer\'s last row is a new one): still Select all, taking in the output written after it', async () => {
    const term = await linesTerminal(20, UNDER_LONG)
    keepLineSelection(term)
    term.selectAll()
    term.resize(30, 10)
    await write(term, '\r\n' + Array.from({ length: 15 }, (_, i) => `later ${i + 1}`).join('\r\n'))
    expect(term.getSelection()).toContain('later 15')
  })

  it('a drag whose first line was trimmed off the top of the scrollback (its marker gone with it): not selected again', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const term = new Terminal({ cols: 30, rows: 10, scrollback: 5 })
    term.open(host)
    made.push(term)
    await write(term, SHELL.join('\r\n'))
    await frame()
    keepLineSelection(term)
    dragBetween(term, 2, 0, 5, 2)
    expect(term.getSelection()).toBe('shell 1\n$ shell 2\n$ she')
    // 6 lines and 10 more fill the 15 rows of the buffer and one: the first line goes.
    await write(term, '\r\n' + Array.from({ length: 10 }, (_, i) => `later ${i + 1}`).join('\r\n'))
    expect(term.hasSelection(), 'xterm keeps the rest of it').toBe(true)
    const select = vi.spyOn(term, 'select')
    term.resize(20, 10)
    expect(select).not.toHaveBeenCalled()
  })
})

/** A session whose scrollback is full: 200 lines at 40 columns in a buffer of
 *  50 + 10 rows, every fifth a rule as wide as the screen (as a console draws
 *  them), then `screen` rows if given (a program's screen, its cursor set by it). */
async function fullTerminal(screen: string[] = [], after = ''): Promise<Terminal> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const term = new Terminal({ cols: 40, rows: 10, scrollback: 50 })
  term.open(host)
  made.push(term)
  const lines = Array.from({ length: 200 }, (_, i) => (i % 5 === 0 ? '-'.repeat(40) : `line ${i + 1} of the session`))
  await write(term, [...lines, ...screen].join('\r\n') + after)
  await frame()
  return term
}

const rowOf = (term: Terminal, text: string) => {
  for (let y = 0; y < term.buffer.active.length; y++) if (term.buffer.active.getLine(y)?.translateToString(true) === text) return y
  return -1
}

describe('a full scrollback: the rows a narrowing adds push rows off the top, and xterm leaves every marker that many rows above its line (aicc_planning#424)', () => {
  it('a drag over part of a line in view, narrowed by one column, widened back and narrowed to 25: the same text on its line (unfixed: the rule line above it)', async () => {
    const term = await fullTerminal()
    expect(term.buffer.active.length).toBe(60)
    keepLineSelection(term)
    dragBetween(term, 4, 6, 9, 6)
    expect(term.getSelection()).toBe(' 197 ')
    term.resize(39, 10)
    expect(term.buffer.active.length).toBe(60)
    expect(pos(term)).toEqual([4, rowOf(term, 'line 197 of the session'), 9, rowOf(term, 'line 197 of the session')])
    expect(term.getSelection()).toBe(' 197 ')
    term.resize(40, 10)
    expect(term.getSelection()).toBe(' 197 ')
    term.resize(25, 10)
    expect(term.getSelection()).toBe(' 197 ')
  })

  it('a triple-clicked line in view, narrowed by one column: the same line', async () => {
    const term = await fullTerminal()
    keepLineSelection(term)
    clickCell(term, 5, 6, 3)
    expect(term.getSelection()).toBe('line 197 of the session')
    term.resize(39, 10)
    expect(term.getSelection()).toBe('line 197 of the session')
  })

  it('output after the drag (rows added at the bottom), then narrowed: the same text', async () => {
    const term = await fullTerminal()
    keepLineSelection(term)
    dragBetween(term, 4, 6, 9, 6)
    expect(term.getSelection()).toBe(' 197 ')
    await write(term, '\r\n' + Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? '='.repeat(40) : `later ${i + 1}`)).join('\r\n'))
    expect(term.getSelection()).toBe(' 197 ')
    term.resize(39, 10)
    expect(term.getSelection()).toBe(' 197 ')
  })

  it('a program screen under it whose last row is as wide as the screen (re-wrapped too): a drag in the rows above, narrowed: the same text', async () => {
    const screen = ['HEADER A', 'HEADER B', '', '', '', '', '-'.repeat(40), '> input', '-'.repeat(40), 'mode on' + ' '.repeat(20) + 'not logged in']
    const term = await fullTerminal(screen, '\x1b[8;8H')
    expect(term.buffer.active.getLine(59)?.translateToString(true)).toBe(screen[9])
    keepLineSelection(term)
    term.scrollToLine(20)
    await frame()
    const text = term.buffer.active.getLine(26)!.translateToString(true)
    dragBetween(term, 4, 6, 9, 6)
    const picked = term.getSelection()
    expect(pos(term)).toEqual([4, 26, 9, 26])
    expect(picked).toBe(text.slice(4, 9))
    term.resize(39, 10)
    expect(term.getSelection()).toBe(picked)
    expect(pos(term)![1]).toBe(rowOf(term, text))
  })

  it('a drag over only the empty cells after a short line, narrowed to fewer columns than its start, then widened back: still those empty cells', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const term = new Terminal({ cols: 40, rows: 10, scrollback: 50 })
    term.open(host)
    made.push(term)
    await write(term, Array.from({ length: 200 }, (_, i) => (i % 5 === 0 ? '-'.repeat(40) : `l${i + 1}`)).join('\r\n'))
    await frame()
    keepLineSelection(term)
    dragBetween(term, 30, 6, 35, 6)
    expect(term.getSelection()).toBe('')
    term.resize(20, 10)
    expect(term.getSelection()).toBe('')
    term.resize(40, 10)
    expect(term.getSelection()).toBe('')
  })
})

describe('a drag in progress when the columns change (aicc_planning#424)', () => {
  it('an earlier drag noted, the mouse pressed and moved for a new one, the columns narrowed: the earlier one is not selected again, and the new drag goes on', async () => {
    const term = await linesTerminal(30, UNDER_LONG)
    keepLineSelection(term)
    dragCells(term, 2, 0, 4)
    expect(term.getSelection()).toBe('$ she')
    const select = vi.spyOn(term, 'select')
    const screen = term.element!.querySelector('.xterm-screen') as HTMLElement
    const at = (x: number, row: number) => ({ clientX: x * 9 + 1, clientY: row * 17 + 8, button: 0, bubbles: true })
    screen.dispatchEvent(new MouseEvent('mousedown', { ...at(2, 3), detail: 1 }))
    document.dispatchEvent(new MouseEvent('mousemove', { ...at(7, 3), buttons: 1 }))
    expect(term.getSelection()).toBe('shell')
    term.resize(20, 10)
    expect(select).not.toHaveBeenCalled()
    document.dispatchEvent(new MouseEvent('mousemove', { ...at(9, 4), buttons: 1 }))
    document.dispatchEvent(new MouseEvent('mouseup', { ...at(9, 4), detail: 1 }))
    expect(pos(term)).toEqual([2, 3, 9, 4])
    expect(term.getSelection()).toBe('shell 3\n$ shell 4')
    // The new one, reported at the release, is kept from here on.
    term.resize(30, 10)
    expect(term.getSelection()).toBe('shell 3\n$ shell 4')
  })

  it('the right button held (xterm drags no selection with it) while the columns narrow: the noted drag is kept on its text', async () => {
    const term = await linesTerminal(30, UNDER_LONG)
    keepLineSelection(term)
    dragCells(term, 2, 0, 4)
    expect(term.getSelection()).toBe('$ she')
    const screen = term.element!.querySelector('.xterm-screen') as HTMLElement
    const at = { clientX: 2 * 9 + 1, clientY: 3 * 17 + 8, button: 2, bubbles: true }
    screen.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 2, detail: 1 }))
    term.resize(20, 10)
    expect(pos(term)).toEqual([0, 3, 5, 3])
    expect(term.getSelection()).toBe('$ she')
    document.dispatchEvent(new MouseEvent('mouseup', { ...at, detail: 1 }))
    expect(term.getSelection()).toBe('$ she')
  })
})

describe('a selection that a trim takes above row 0: xterm clears a drag there, and moves one made by a start and a length (a triple-click\'s line, one selected again by select) to row 0, on other text (SelectionModel.handleTrim; aicc_planning#424)', () => {
  it('a triple-clicked line that a narrowing pushes off the top of a full scrollback: nothing stays selected (unfixed: the rule line on row 0)', async () => {
    const term = await fullTerminal()
    keepLineSelection(term)
    term.scrollToTop()
    await frame()
    clickCell(term, 5, 4, 3)
    expect(term.getSelection()).toBe('line 145 of the session')
    term.resize(39, 10)
    expect(rowOf(term, 'line 145 of the session')).toBe(-1)
    expect(term.hasSelection()).toBe(false)
  })

  it('a triple-clicked line still in the buffer after 40 to 20 columns, its marker gone with the rows pushed off: nothing stays selected (unfixed: other text on row 0)', async () => {
    const term = await fullTerminal()
    keepLineSelection(term)
    term.scrollToLine(27)
    await frame()
    clickCell(term, 5, 4, 3)
    expect(term.getSelection()).toBe('line 172 of the session')
    term.resize(20, 10)
    expect(rowOf(term, 'line 172 of the sess')).toBeGreaterThan(0)
    expect(term.hasSelection()).toBe(false)
  })

  it('a drag selected again once (40 to 39), then pushed off by a narrowing to 20: nothing stays selected, as xterm alone leaves a drag (unfixed: a selection on row 0)', async () => {
    const term = await fullTerminal()
    keepLineSelection(term)
    term.scrollToLine(8)
    await frame()
    dragBetween(term, 4, 4, 9, 4)
    expect(term.getSelection()).toBe(' 153 ')
    term.resize(39, 10)
    expect(term.getSelection()).toBe(' 153 ')
    term.resize(20, 10)
    expect(term.hasSelection()).toBe(false)
  })

  it('a drag selected again once (40 to 39), then pushed off the top by output alone: nothing stays selected, as xterm alone leaves a drag (unfixed: other text on row 0)', async () => {
    const term = await fullTerminal()
    keepLineSelection(term)
    dragBetween(term, 4, 6, 9, 6)
    term.resize(39, 10)
    expect(term.getSelection()).toBe(' 197 ')
    await write(term, '\r\n' + Array.from({ length: 80 }, (_, i) => `later ${i + 1}`).join('\r\n'))
    expect(term.hasSelection()).toBe(false)
  })

  it('a triple-clicked line pushed off the top by output alone: nothing stays selected (xterm alone keeps other text selected on row 0)', async () => {
    const term = await fullTerminal()
    keepLineSelection(term)
    clickCell(term, 5, 6, 3)
    expect(term.getSelection()).toBe('line 197 of the session')
    await write(term, '\r\n' + Array.from({ length: 80 }, (_, i) => `later ${i + 1}`).join('\r\n'))
    expect(term.hasSelection()).toBe(false)
  })

  it('a selection whose line output moves up but not off the top: kept, and kept at the next change of the columns (a guard)', async () => {
    const term = await fullTerminal()
    keepLineSelection(term)
    dragBetween(term, 4, 6, 9, 6)
    term.resize(39, 10)
    expect(term.getSelection()).toBe(' 197 ')
    await write(term, '\r\n' + Array.from({ length: 20 }, (_, i) => `later ${i + 1}`).join('\r\n'))
    expect(term.getSelection()).toBe(' 197 ')
    term.resize(30, 10)
    expect(term.getSelection()).toBe(' 197 ')
  })
})

describe('a drag in progress when output pushes the noted selection off the top (aicc_planning#424)', () => {
  it('an earlier drag on the top rows noted, the mouse pressed and moved for a new one lower down, 10 lines of output: the new drag goes on and its release is reported', async () => {
    const term = await fullTerminal()
    keepLineSelection(term)
    term.scrollToTop()
    await frame()
    dragBetween(term, 4, 3, 9, 3)
    expect(term.getSelection()).toBe(' 144 ')
    term.scrollToBottom()
    await frame()
    const screen = term.element!.querySelector('.xterm-screen') as HTMLElement
    const at = (x: number, row: number) => ({ clientX: x * 9 + 1, clientY: row * 17 + 8, button: 0, bubbles: true })
    screen.dispatchEvent(new MouseEvent('mousedown', { ...at(4, 6), detail: 1 }))
    document.dispatchEvent(new MouseEvent('mousemove', { ...at(9, 6), buttons: 1 }))
    expect(term.getSelection()).toBe(' 197 ')
    await write(term, '\r\n' + Array.from({ length: 10 }, (_, i) => `later ${i + 1}`).join('\r\n'))
    expect(term.getSelection()).toBe(' 197 ')
    document.dispatchEvent(new MouseEvent('mouseup', { ...at(9, 6), detail: 1 }))
    expect(term.getSelection()).toBe(' 197 ')
    term.resize(39, 10)
    expect(term.getSelection()).toBe(' 197 ')
  })
})

describe('a selection over several lines whose first line alone goes off the top (aicc_planning#424)', () => {
  it('a drag over three lines selected again once (40 to 39), its first line pushed off by output: the rest, from row 0, column 0, to its end, kept at the next change of the columns (unfixed: runs on past its end)', async () => {
    const term = await fullTerminal()
    keepLineSelection(term)
    dragBetween(term, 5, 4, 9, 6)
    const picked = '195 of the session\n' + '-'.repeat(40) + '\nline 197 '
    expect(term.getSelection()).toBe(picked)
    term.resize(39, 10)
    expect(term.getSelection()).toBe(picked)
    const row = term.getSelectionPosition()!.start.y
    await write(term, '\r\n' + Array.from({ length: row + 1 }, (_, i) => `later ${i + 1}`).join('\r\n'))
    expect(rowOf(term, 'line 195 of the session')).toBe(-1)
    expect(term.getSelection()).toBe('-'.repeat(40) + '\nline 197 ')
    expect(pos(term)!.slice(0, 2)).toEqual([0, 0])
    term.resize(40, 10)
    expect(term.getSelection()).toBe('-'.repeat(40) + '\nline 197 ')
  })

  it('a first drag over three lines at 39 columns (a rule line in two rows in the middle), its first line pushed off by output: the rest as xterm keeps it, then kept on its text through a widening that joins the rule\'s rows (xterm alone: runs on into the next line)', async () => {
    const term = await fullTerminal()
    term.resize(39, 10)
    keepLineSelection(term)
    const r = rowOf(term, 'line 195 of the session')
    expect(rowOf(term, 'line 197 of the session')).toBe(r + 3)
    term.scrollToLine(Math.max(0, r - 4))
    await frame()
    const v = r - term.buffer.active.viewportY
    dragBetween(term, 5, v, 9, v + 3)
    expect(term.getSelection()).toBe('195 of the session\n' + '-'.repeat(40) + '\nline 197 ')
    const select = vi.spyOn(term, 'select')
    await write(term, '\r\n' + Array.from({ length: r + 1 }, (_, i) => `later ${i + 1}`).join('\r\n'))
    expect(rowOf(term, 'line 195 of the session')).toBe(-1)
    // xterm keeps the drag's end and moves its start to row 0 (its column
    // kept): nothing selected again.
    const rest = '-'.repeat(35) + '\nline 197 '
    expect(term.getSelection()).toBe(rest)
    expect(select).not.toHaveBeenCalled()
    term.resize(40, 10)
    expect(term.getSelection()).toBe(rest)
  })

  it('a drag over three lines whose first line\'s marker a narrowing\'s trim takes, the line itself still in the buffer lower down: nothing stays selected, as when the end\'s goes (unfixed: other text on row 0)', async () => {
    const term = await fullTerminal()
    keepLineSelection(term)
    term.scrollToLine(6)
    await frame()
    dragBetween(term, 5, 4, 9, 6)
    expect(term.getSelection()).toBe('-'.repeat(35) + '\nline 152 of the session\nline 153 ')
    term.resize(39, 10)
    expect(rowOf(term, 'line 152 of the session')).toBeGreaterThan(0)
    expect(term.hasSelection()).toBe(false)
  })
})
