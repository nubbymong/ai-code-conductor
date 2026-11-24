/**
 * aicc_planning#422: a selection of whole lines (a triple-click's line, or a
 * drag from a line's first cell to past its last) stays on its lines when
 * only the terminal's columns change.
 *
 * xterm keeps a triple-click's line as a start and a length, the length being
 * the row's width when it was made (SelectionService._selectLineAt), not as
 * rows. When only the columns change xterm keeps the selection (it clears one
 * only when the rows change: xtermjs/xterm.js#5300), and that length at a
 * narrower width runs on into the next row: a copy ends with a line break and
 * the next row's first cells. Its re-wrap of a longer line above the
 * selection also moves the selected line to another row, which xterm's
 * selection does not follow.
 *
 * So a selection of whole lines is noted when it is made: a marker on its
 * first row (xterm moves a marker with the rows its re-wrap adds or joins
 * above it) and how many lines it holds (a line wrapped over several rows
 * counts once). After a change of the columns alone, that many whole lines
 * from the marker's row are selected again, at the new width. A selection
 * that is not of whole lines (a drag inside a row, or over some of a wrapped
 * line's rows) and Select all are left as xterm keeps them; a change of the
 * rows clears any selection in xterm and is left so. Selecting again is
 * noted the same way, so a later change of the columns keeps it too.
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

/** The part of the app's xterm (@xterm/xterm) this needs. @xterm/headless has
 *  no selection: it gets nothing. */
export interface LineSelectionTerminal {
  readonly cols: number
  readonly rows: number
  readonly buffer: {
    readonly active: {
      readonly baseY: number
      readonly cursorY: number
      readonly length: number
      getLine(y: number): { readonly isWrapped: boolean } | undefined
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

/** The last row of the line on row `y`: the rows after it that continue it
 *  (wrapped) belong to it. */
function lineEnd(buf: Buffer, y: number): number {
  while (buf.getLine(y + 1)?.isWrapped) y++
  return y
}

export function keepLineSelection(term: LineSelectionTerminal): Disposable {
  if (!canSelect(term)) return { dispose() {} }
  const t = term
  let size = { cols: t.cols, rows: t.rows }
  let noted: { marker: Marker; lines: number } | null = null

  const forget = (): void => {
    noted?.marker.dispose()
    noted = null
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
    const buf = t.buffer.active
    // Whole rows: from a row's first cell to past its last.
    if (!at || at.start.x !== 0 || at.end.x !== t.cols) return
    // Select all (the whole buffer) is xterm's to keep.
    if (at.start.y === 0 && at.end.y >= buf.length - 1) return
    // Whole lines only: a row that continues a line, or whose line goes on
    // below, is part of a line (a drag over some of its rows): xterm's to keep.
    if (buf.getLine(at.start.y)?.isWrapped || buf.getLine(at.end.y + 1)?.isWrapped) return
    let lines = 0
    for (let y = at.start.y; y <= at.end.y; y = lineEnd(buf, y) + 1) lines++
    const marker = t.registerMarker(at.start.y - (buf.baseY + buf.cursorY))
    if (marker) noted = { marker, lines }
  }

  const keep = (cols: number): void => {
    if (!noted) return
    // A marker xterm disposed went with its row (trimmed off the top); with
    // nothing selected, it was cleared since it was noted.
    if (noted.marker.isDisposed || !t.hasSelection()) { forget(); return }
    const buf = t.buffer.active
    const first = noted.marker.line
    let last = first - 1
    for (let n = 0; n < noted.lines && last + 1 < buf.length; n++) last = lineEnd(buf, last + 1)
    // Fires onSelectionChange when the cells differ from the last it fired
    // for: noted again, at this width.
    t.select(0, first, (last - first + 1) * cols)
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
