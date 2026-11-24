/**
 * aicc_planning#422 and #424: a selection keeps its text when only the
 * terminal's columns change.
 *
 * xterm keeps a selection in buffer cells and moves none of it with its
 * re-wrap. When only the columns change xterm keeps the selection (it clears
 * one only when the rows change: xtermjs/xterm.js#5300), so after a re-wrap
 * its cells hold other text: a longer line above it re-wrapped moves the
 * selected text to other rows, and a selected line that wraps moves its own
 * text between its rows (measured: a drag over '$ she' under a 25-cell line
 * copies 'xxxxx' after 30 to 20 columns). A selection made by a start and a
 * length (a triple-click's line, SelectionService._selectLineAt;
 * consoleRepaint's selecting again) also runs on into the next row at a
 * narrower width: xterm reads its end from the length at the new width.
 *
 * So each end of a selection is noted when it is made: a marker on the first
 * row of its line (xterm moves a marker with the rows its re-wrap adds or
 * joins above it) and how many cells into that line it is (the line's rows
 * counted end to end, less the cell xterm leaves empty at a row's end when
 * the wide character after it does not fit, as its re-wrap counts them). An
 * end past the last cell of its line's last row stays past it, so a
 * triple-click's line stays that whole line. After a change of the columns
 * alone both ends are found again at the new width and, when xterm's cells
 * differ, selected again: the same text. xterm re-wraps no line of the
 * alternate buffer and not the line its cursor is on (Buffer.ts; TerminalView
 * leaves reflowCursorLine off): an end on such a line keeps its row and
 * column. Select all is left as xterm keeps it; a change of the rows clears
 * any selection in xterm and is left so; an end whose line was trimmed off the
 * top is not selected again. Selecting again is noted the same way, so a
 * later change of the columns keeps it too.
 *
 * xterm's select takes a start and a length, so a selection it has to select
 * again cannot end on a line's first cell (a drag down to a row's left edge,
 * whose copy ends with the line break before that line): it ends on the last
 * cell of the row before, the same cells, and the copy has no last line break.
 *
 * A clear keeps the note until the code that cleared it has run. xterm
 * reports no change when the cells it last reported are selected again after
 * a clear (SelectionService._fireEventIfSelectionChanged compares with them,
 * and clearSelection does not reset them), and consoleRepaint's
 * bringRowsDown does just that: its two sizes clear the selection, and it
 * selects the same cells again at once. Later, the same cells selected again
 * without a report can only be a drag by hand over exactly them (a click's
 * release reports the clear first, so a triple-click's line is reported),
 * and output may have moved other lines under them since (a full scrollback
 * drops rows from the top, and xterm keeps those cells where they were), so
 * the note goes then: xterm keeps a drag by its cells.
 */

interface Disposable { dispose(): void }

interface Marker extends Disposable {
  readonly line: number
  readonly isDisposed: boolean
}

interface Cell {
  getChars(): string
  getWidth(): number
}

/** The part of the app's xterm (@xterm/xterm) this needs. @xterm/headless has
 *  no selection: it gets nothing. */
export interface LineSelectionTerminal {
  readonly cols: number
  readonly rows: number
  readonly buffer: {
    readonly active: {
      readonly type?: 'normal' | 'alternate'
      readonly baseY: number
      readonly cursorY: number
      readonly length: number
      getLine(y: number): { readonly isWrapped: boolean; getCell?(x: number): Cell | undefined } | undefined
    }
  }
  onResize(listener: (size: { cols: number; rows: number }) => void): Disposable
  onSelectionChange?(listener: () => void): Disposable
  hasSelection?(): boolean
  getSelectionPosition?(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined
  select?(column: number, row: number, length: number): void
  registerMarker?(cursorYOffset?: number): Marker | undefined
}

type Buffer = LineSelectionTerminal['buffer']['active']

const canSelect = (t: LineSelectionTerminal): t is Required<LineSelectionTerminal> =>
  typeof t.onSelectionChange === 'function' && typeof t.hasSelection === 'function'
  && typeof t.getSelectionPosition === 'function' && typeof t.select === 'function'
  && typeof t.registerMarker === 'function'

/** The first row of the line on row `y`: the rows above it that it goes on
 *  from belong to it. */
function lineStart(buf: Buffer, y: number): number {
  while (y > 0 && buf.getLine(y)?.isWrapped) y--
  return y
}

/** The last row of the line on row `y`: the rows after it that continue it
 *  (wrapped) belong to it. */
function lineEnd(buf: Buffer, y: number): number {
  while (buf.getLine(y + 1)?.isWrapped) y++
  return y
}

/** The cells of row `y` (a row its line goes on from) that hold its line: all
 *  of them, or all but the last when xterm left that one empty because the
 *  wide character after it did not fit (its re-wrap skips that cell too:
 *  BufferReflow.ts, getWrappedLineTrimmedLength). */
function rowCells(buf: Buffer, y: number, cols: number): number {
  const end = buf.getLine(y)?.getCell?.(cols - 1)
  const next = buf.getLine(y + 1)?.getCell?.(0)
  return end && next && end.getChars() === '' && end.getWidth() === 1 && next.getWidth() === 2 ? cols - 1 : cols
}

/** One end of a selection: a marker on its line's first row, how many cells
 *  into the line it is, and its row in the line and its column (for a line
 *  xterm does not re-wrap). Past the last cell of the line's last row, the
 *  cells and the column are Infinity. */
interface End { marker: Marker; cells: number; row: number; x: number }

type At = { x: number; y: number }

export function keepLineSelection(term: LineSelectionTerminal): Disposable {
  if (!canSelect(term)) return { dispose() {} }
  const t = term
  let size = { cols: t.cols, rows: t.rows }
  let noted: { start: End; end: End } | null = null

  const forget = (): void => {
    noted?.start.marker.dispose()
    noted?.end.marker.dispose()
    noted = null
  }

  const endAt = ({ x, y }: At): End | null => {
    const buf = t.buffer.active
    const first = lineStart(buf, y)
    const last = lineEnd(buf, first)
    const past = y === last && x >= t.cols
    let cells = 0
    for (let r = first; r < y; r++) cells += rowCells(buf, r, t.cols)
    // A column past a row's cells (that row's line going on below) is where
    // the next row starts.
    cells += y === last ? x : Math.min(x, rowCells(buf, y, t.cols))
    const marker = t.registerMarker(first - (buf.baseY + buf.cursorY))
    return marker ? { marker, cells: past ? Infinity : cells, row: y - first, x: past ? Infinity : x } : null
  }

  const noteAt = (start: At, end: At): void => {
    const a = endAt(start)
    const b = a && endAt(end)
    if (a && b) noted = { start: a, end: b }
    else a?.marker.dispose()
  }

  /** Where `end` is at `cols` columns. One that falls where a row of its line
   *  ends: a start goes to the next row's first cell (as xterm's own drag
   *  starts there), an end stays at that row's end. Null when its line was
   *  trimmed off the top (xterm disposed its marker with its row). */
  const place = (end: End, cols: number, isStart: boolean): At | null => {
    if (end.marker.isDisposed) return null
    const buf = t.buffer.active
    const first = end.marker.line
    const last = lineEnd(buf, first)
    const cursor = buf.baseY + buf.cursorY
    // A line xterm did not re-wrap (the alternate buffer's, the cursor's):
    // its row and column.
    if (buf.type === 'alternate' || (cursor >= first && cursor <= last)) {
      return { x: Math.min(end.x, cols), y: first + Math.min(end.row, last - first) }
    }
    let left = end.cells
    for (let y = first; y < last; y++) {
      const cells = rowCells(buf, y, cols)
      if (left < cells || (!isStart && left === cells)) return { x: left, y }
      left -= cells
    }
    return { x: Math.min(left, cols), y: last }
  }

  const note = (): void => {
    if (!t.hasSelection()) {
      // Nothing selected: the note stays until the code that cleared it has
      // run (a microtask). xterm fires no change when the cells it last fired
      // for are selected again after a clear, as consoleRepaint's
      // bringRowsDown does after its two sizes; past that, see the header.
      // keep() drops the note when nothing is selected.
      if (noted) {
        queueMicrotask(() => {
          try { if (noted && !t.hasSelection()) forget() } catch { forget() }
        })
      }
      return
    }
    forget()
    const at = t.getSelectionPosition()
    if (!at) return
    // Select all (the whole buffer) is xterm's to keep: it takes in what is
    // written after it.
    if (at.start.x === 0 && at.start.y === 0 && at.end.x === t.cols && at.end.y >= t.buffer.active.length - 1) return
    noteAt(at.start, at.end)
  }

  const keep = (cols: number): void => {
    if (!noted) return
    // With nothing selected, it was cleared since it was noted.
    if (!t.hasSelection()) { forget(); return }
    const was = noted
    const start = place(was.start, cols, true)
    const end = place(was.end, cols, false)
    if (!start || !end) { forget(); return }
    const length = (end.y - start.y) * cols + end.x - start.x
    if (length <= 0) return
    const now = t.getSelectionPosition()
    if (!now || now.start.x !== start.x || now.start.y !== start.y || now.end.x !== end.x || now.end.y !== end.y) {
      // Fires onSelectionChange when the cells differ from the last it fired
      // for: noted again, at this width.
      t.select(start.x, start.y, length)
    }
    // Nothing fired (the same cells as xterm had, or as it last fired for):
    // noted again here, so a line xterm did not re-wrap is counted as it is now.
    if (noted === was) {
      forget()
      noteAt(start, end)
    }
  }

  const subs: Disposable[] = [
    t.onSelectionChange(note),
    t.onResize(({ cols, rows }) => {
      const was = size
      size = { cols, rows }
      // Columns only: a change of the rows clears it in xterm.
      if (rows !== was.rows || cols === was.cols) return
      try { keep(cols) } catch { /* the selection stays as xterm keeps it */ }
    }),
  ]
  return {
    dispose() {
      for (const s of subs) s.dispose()
      forget()
    },
  }
}
