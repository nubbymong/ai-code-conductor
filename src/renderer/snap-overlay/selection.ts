/**
 * The selection on Snap's own overlay page, kept apart from the page's DOM so
 * it can be tested on its own (tests/unit/renderer/snap-overlay-selection.test.ts).
 *
 * A drag draws a rectangle; Enter takes it once the drag has ended. A click is
 * no rectangle. Whole screen and Escape (or Cancel) answer at once. The page
 * answers once. Points are CSS pixels in the page, which are DIP within the
 * display (the window sits at the display's bounds, zoom 1); every rectangle is
 * clamped to the display.
 */
import { clampRectToSize, type Rect, type SnapOverlayMessage } from '../../shared/snap-overlay'

export interface Point {
  x: number
  y: number
}

export interface OverlayState {
  /** The rectangle drawn so far, or null. */
  rect: Rect | null
  dragging: boolean
  answered: boolean
}

export interface OverlayController {
  /** A copy of the state as it is now. */
  readonly state: OverlayState
  pointerDown(p: Point): void
  pointerMove(p: Point): void
  pointerUp(p: Point): void
  /** A key the page saw; true when the key did something (the page then keeps it). */
  key(key: string): boolean
  wholeScreen(): void
  cancel(): void
}

function rectBetween(a: Point, b: Point, size: { width: number; height: number }): Rect | null {
  return clampRectToSize(
    { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) },
    size,
  )
}

export function createOverlayController(
  size: { width: number; height: number },
  send: (message: SnapOverlayMessage) => void,
  onChange?: (state: OverlayState) => void,
): OverlayController {
  const state: OverlayState = { rect: null, dragging: false, answered: false }
  let start: Point | null = null

  const snapshot = (): OverlayState => ({ ...state, rect: state.rect && { ...state.rect } })
  const changed = (): void => onChange?.(snapshot())
  const answer = (message: SnapOverlayMessage): void => {
    if (state.answered) return
    state.answered = true
    state.dragging = false
    start = null
    send(message)
    changed()
  }

  return {
    get state() {
      return snapshot()
    },
    pointerDown(p) {
      if (state.answered) return
      start = p
      state.dragging = true
      state.rect = null
      changed()
    },
    pointerMove(p) {
      if (!state.dragging || !start) return
      state.rect = rectBetween(start, p, size)
      changed()
    },
    pointerUp(p) {
      if (!state.dragging || !start) return
      state.rect = rectBetween(start, p, size)
      state.dragging = false
      start = null
      changed()
    },
    key(key) {
      if (state.answered) return false
      if (key === 'Escape') {
        answer({ kind: 'cancel' })
        return true
      }
      if (key === 'Enter' && !state.dragging && state.rect) {
        answer({ kind: 'rect', rect: { ...state.rect } })
        return true
      }
      return false
    },
    wholeScreen() {
      answer({ kind: 'whole' })
    },
    cancel() {
      answer({ kind: 'cancel' })
    },
  }
}

/** The rectangle's size in the picture's own pixels: what a capture of it holds before any downscale. */
export function sizeLabel(rect: Rect, scale: number): string {
  return `${Math.round(rect.width * scale)} × ${Math.round(rect.height * scale)}`
}
