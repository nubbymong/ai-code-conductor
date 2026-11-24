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
 * joins above it, except in a full scrollback: see below) and how many cells
 * into that line it is (the line's rows counted end to end, less the cell
 * xterm leaves empty at a row's end when the wide character after it does not
 * fit, as its re-wrap counts them). An
 * end past the last cell of its line's last row stays past it, so a
 * triple-click's line stays that whole line. After a change of the columns
 * alone both ends are found again at the new width and, when xterm's cells
 * differ, selected again: the same text. xterm re-wraps no line of the
 * alternate buffer and not the line its cursor is on (Buffer.ts; TerminalView
 * leaves reflowCursorLine off): an end on such a line keeps its row and
 * column. Select all is left as xterm keeps it; a change of the rows clears
 * any selection in xterm and is left so; an end whose line was trimmed off the
 * top is not selected again. When the first row of the end's line goes off the
 * top (output in a full scrollback, a narrowing's trim), the note goes and
 * what xterm still has selected is cleared: xterm clears a drag there itself,
 * but a selection made by a start and a length (a triple-click's line, one
 * selected again by select) it moves to row 0, on other text, and never
 * clears (SelectionModel.handleTrim). A drag in progress is left to xterm.
 * When output takes only the start's line, the rest is kept: xterm keeps a
 * drag's end and moves its start to row 0, but a selection made by a start
 * and a length keeps its length and runs on past its end, so it is selected
 * again from row 0, column 0, to the noted end. A narrowing's trim leaves the
 * markers it keeps rows above their lines (see below), so a start's marker it
 * disposes does not mean that line has gone: the selection is cleared there,
 * as for an end's. xterm disposes a marker on a row a program erases or
 * deletes too (ESC[J and ESC[2J reset rows: InputHandler._resetBufferLine,
 * Buffer.clearMarkers; delete line and scroll up splice them out), with the
 * selection left on its cells: only a trim is acted on. A marker on the
 * buffer's first row, registered ahead of the ends' markers, tells them apart:
 * any trim takes it first. When an end's marker goes and that one is still
 * there, the note goes and the selection stays as xterm keeps it. Selecting
 * again is noted the same way, so a later change
 * of the columns keeps it too. A drag in progress (the left
 * button pressed in the terminal, not yet let go) is xterm's: it reports the
 * selection at the release, so a change of the columns before that drops the
 * note and selects nothing again.
 *
 * A full scrollback: the rows a narrowing's re-wrap adds push as many rows off
 * the top, and for the rows added among those xterm fires no insert while its
 * trim counts them (Buffer._reflowSmaller), so every marker left is that many
 * rows above its line (measured at 140x28 with 10,000 rows of scrollback: 64
 * rows). The buffer's last line stays the last, so a marker kept on its first
 * row while a selection is noted (set at the note and after each write) tells
 * how many, and both ends are placed that many rows down.
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
  onDispose?(listener: () => void): Disposable
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
  /** The element the terminal is opened in. */
  readonly element?: HTMLElement
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
  onWriteParsed?(listener: () => void): Disposable
  hasSelection?(): boolean
  getSelectionPosition?(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined
  select?(column: number, row: number, length: number): void
  clearSelection?(): void
  registerMarker?(cursorYOffset?: number): Marker | undefined
}

type Buffer = LineSelectionTerminal['buffer']['active']

type Selecting = LineSelectionTerminal & Required<Pick<LineSelectionTerminal,
  'onSelectionChange' | 'hasSelection' | 'getSelectionPosition' | 'select' | 'registerMarker'>>

const canSelect = (t: LineSelectionTerminal): t is Selecting =>
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
  // The left button pressed in the terminal and not yet let go: xterm is making
  // a selection it reports only at the release. It drags one with no other
  // button (SelectionService.handleMouseDown).
  let pressed = false
  const onUp = (): void => { pressed = false }
  const onDown = (e: MouseEvent): void => {
    if (e.button !== 0) return
    pressed = true
    // Heard once, wherever the mouse is let go: nothing stays on the document.
    t.element?.ownerDocument.addEventListener('mouseup', onUp, { capture: true, once: true })
  }
  t.element?.addEventListener('mousedown', onDown, true)
  /** On the first row of the buffer's last line while a selection is noted
   *  (markBottom): what keep() measures xterm's markers against. */
  let bottom: Marker | null = null
  /** On the buffer's first row while a selection is noted, registered ahead of
   *  the ends' markers (noteAt): any trim disposes it, and before theirs. */
  let top: Marker | null = null

  const forget = (): void => {
    // The note goes first, so its markers disposed here are not taken for
    // xterm's own disposal (noteAt).
    const was = noted
    noted = null
    was?.start.marker.dispose()
    was?.end.marker.dispose()
    bottom?.dispose()
    bottom = null
    top?.dispose()
    top = null
  }

  const bottomRow = (): number => {
    const buf = t.buffer.active
    return lineStart(buf, buf.length - 1)
  }

  /** Keeps the bottom marker on the buffer's last line: when a selection is
   *  noted, and after each write (output adds rows under it). */
  const markBottom = (): void => {
    if (!noted) return
    const buf = t.buffer.active
    const row = bottomRow()
    if (bottom && !bottom.isDisposed && bottom.line === row) return
    bottom?.dispose()
    bottom = t.registerMarker(row - (buf.baseY + buf.cursorY)) ?? null
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
    // Ahead of the ends' markers: xterm tells markers of a trim in the order
    // they were registered, so when a trim disposes an end's, this one is gone.
    const buf = t.buffer.active
    const guard = t.registerMarker(-(buf.baseY + buf.cursorY)) ?? null
    const a = endAt(start)
    const b = a && endAt(end)
    if (a && b) {
      const mine = { start: a, end: b }
      noted = mine
      top = guard
      markBottom()
      // xterm disposed the end's marker: the first row of its line went off the
      // top (output in a full scrollback, a narrowing's trim). xterm clears a
      // drag there, but a selection made by a start and a length (a
      // triple-click's line, one selected again by select) it moves to row 0,
      // on other text, and never clears (SelectionModel.handleTrim). So it is
      // cleared here; a drag in progress is xterm's and is left. A row a
      // program erased or deleted (the first-row marker still there): the note
      // goes and the selection stays as xterm keeps it.
      b.marker.onDispose?.(() => {
        if (noted !== mine) return
        const trimmed = guard?.isDisposed === true
        forget()
        if (trimmed && !pressed) t.clearSelection?.()
      })
      // xterm disposed the start's marker alone: the first row of the start's
      // line went off the top. After output the rest is kept (keepRest) once
      // the trim is over: xterm moves the end's marker after this one. A
      // narrowing's trim is keep()'s, which runs before then.
      a.marker.onDispose?.(() => {
        if (noted !== mine) return
        // Not a trim (its row erased or deleted): as xterm keeps it.
        if (guard?.isDisposed !== true) { forget(); return }
        queueMicrotask(() => {
          if (noted !== mine) return
          try {
            if (pressed || !t.hasSelection()) { forget(); return }
            const at = place(mine.end, t.cols, false, 0)
            if (at) keepRest(at, t.cols)
            else forget()
          } catch { forget() }
        })
      })
    } else {
      a?.marker.dispose()
      guard?.dispose()
    }
  }

  /** Where `end` is at `cols` columns, its marker `off` rows above its line.
   *  One that falls where a row of its line ends: a start goes to the next
   *  row's first cell (as xterm's own drag starts there), an end stays at that
   *  row's end. Null when its line was trimmed off the top (xterm disposed its
   *  marker with its row). */
  const place = (end: End, cols: number, isStart: boolean, off: number): At | null => {
    if (end.marker.isDisposed) return null
    const buf = t.buffer.active
    const first = end.marker.line + off
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

  /** Output took the start's line off the top and not the end's, at `end` at
   *  `cols` columns. A drag xterm keeps ends there already (it moves the
   *  drag's start to row 0): noted as xterm keeps it. A selection made by a
   *  start and a length keeps its length and runs on past the end: the rest is
   *  selected again, from row 0, column 0, to the noted end. */
  const keepRest = (end: At, cols: number): void => {
    const now = t.getSelectionPosition()
    if (now && now.end.x === end.x && now.end.y === end.y) {
      forget()
      noteAt(now.start, end)
      return
    }
    const length = end.y * cols + end.x
    if (length <= 0) { forget(); t.clearSelection?.(); return }
    const was = noted
    // Fires onSelectionChange (noted again there) unless the cells are the
    // last it fired for.
    t.select(0, 0, length)
    if (noted === was) {
      forget()
      noteAt({ x: 0, y: 0 }, end)
    }
  }

  /** After a write whose trim took the first-row marker and left the note: noted
   *  again where it is, so that marker is again ahead of the ends' markers. An
   *  end whose marker is gone is its hook's (noteAt). */
  const renew = (): void => {
    if (!noted || top?.isDisposed !== true) return
    const start = place(noted.start, t.cols, true, 0)
    const end = place(noted.end, t.cols, false, 0)
    if (!start || !end) return
    forget()
    noteAt(start, end)
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

  const keep = (cols: number, narrowed: boolean): void => {
    if (!noted) return
    // A drag in progress: the note is still the selection before it, and
    // xterm reports the new one at the release. Left to xterm.
    if (pressed) { forget(); return }
    // With nothing selected, it was cleared since it was noted.
    if (!t.hasSelection()) { forget(); return }
    const was = noted
    // A narrowing of a full scrollback: the rows its re-wrap adds push rows
    // off the top, and for the ones added among those rows xterm fires no
    // insert while its trim counts them (Buffer._reflowSmaller), so every
    // marker left is that many rows above its line. The buffer's last line
    // stays the last: its marker tells how many.
    const off = narrowed && bottom && !bottom.isDisposed ? Math.max(0, bottomRow() - bottom.line) : 0
    const start = place(was.start, cols, true, off)
    const end = place(was.end, cols, false, off)
    // A marker this narrowing's trim disposed (the end's is cleared by noteAt
    // already). Every marker it keeps is left rows above its line, so the
    // start's line may still be lower down, and xterm's cells hold other text:
    // cleared, as xterm clears a drag whose end goes.
    if (!start || !end) { forget(); t.clearSelection?.(); return }
    const length = (end.y - start.y) * cols + end.x - start.x
    // Nothing to select again: a note whose markers are off is dropped.
    if (length <= 0) { if (off) forget(); return }
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
      try { keep(cols, cols < was.cols) } catch { /* the selection stays as xterm keeps it */ }
    }),
  ]
  if (typeof t.onWriteParsed === 'function') subs.push(t.onWriteParsed(() => { try { renew() } catch { forget() } markBottom() }))
  return {
    dispose() {
      for (const s of subs) s.dispose()
      t.element?.removeEventListener('mousedown', onDown, true)
      forget()
    },
  }
}
