// @vitest-environment jsdom
// aicc_planning#422 (beta.17 C10): a triple-click line selection across a narrowing of the
// columns only, on the app's xterm (@xterm/xterm 6.0.0) in jsdom, its cell measured as 9x17
// as console-repaint-narrow-keep.test.ts does. The clicks go through xterm's own mouse
// handler (SelectionService.handleMouseDown: the third press has detail 3).
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

/** `shell` lines of a shell, then a program's screen at 30x10 with the cursor
 *  on its input row (console-repaint-narrow-keep.test.ts's programTerminal). */
async function programTerminal(shell: number, rows = 10): Promise<Terminal> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const term = new Terminal({ cols: 30, rows, scrollback: 200 })
  term.open(host)
  made.push(term)
  const screen = ['HEADER A', 'HEADER B', '', RULE_30, '> input', RULE_30, STATUS_30]
  while (screen.length < rows) screen.push('')
  const lines = [...Array.from({ length: shell }, (_, i) => `$ shell ${i + 1}`), ...screen]
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

  it('a drag inside a row below a longer line the narrowing re-wraps: xterm leaves it on its row, which now holds the longer line\'s last part (kept so: a drag is not a line)', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const term = new Terminal({ cols: 30, rows: 10, scrollback: 200 })
    term.open(host)
    made.push(term)
    await write(term, ['$ shell 1', 'x'.repeat(25), '$ shell 3', '$ shell 4'].join('\r\n'))
    await frame()
    keepLineSelection(term)
    dragCells(term, 2, 0, 4)
    expect(term.getSelection()).toBe('$ she')
    term.resize(20, 10)
    expect(pos(term)).toEqual([0, 2, 5, 2])
    expect(term.getSelection()).toBe('xxxxx')
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

  it('a drag over the second row of a wrapped line, from its first cell to past its last: not taken for a line (left as xterm keeps it)', async () => {
    const term = await linesTerminal(30, ['$ shell 1', 'z'.repeat(30) + 'w'.repeat(15), '$ shell 3'])
    keepLineSelection(term)
    const select = vi.spyOn(term, 'select')
    dragCells(term, 2, 0, 29)
    expect(term.getSelection()).toBe('w'.repeat(15))
    term.resize(20, 10)
    expect(select).not.toHaveBeenCalled()
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
