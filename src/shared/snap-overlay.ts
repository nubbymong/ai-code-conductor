/**
 * What Snap's own overlay (src/main/snap/overlay.ts) and its page
 * (src/renderer/snap-overlay.html) say to each other, and the one clamp both
 * apply (ADR-030 D4: whole screen or a rectangle, nothing else).
 *
 * The page asks for its display's picture once ('ready') and answers once.
 * Every size here is in DIP (CSS pixels at zoom 1) within that one display,
 * with 0,0 at the display's top left.
 *
 * The overlay preload (src/preload/snap-overlay.ts) imports only types from
 * here: a sandboxed preload must be one file, so it shares no code module with
 * the app's main preload (see the note there).
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** What main hands a page that asks for its display's picture. */
export interface SnapOverlayInit {
  /** The display's picture as a data URL, shown at the display's DIP size. */
  picture: string
  /** The display's size in DIP: the page's viewport. */
  width: number
  height: number
  /** Physical pixels per DIP, so the page can show the picture's own pixel size. */
  scale: number
}

/** The page's one answer. */
export type SnapOverlayMessage =
  | { kind: 'rect'; rect: Rect }
  | { kind: 'whole' }
  | { kind: 'cancel' }

/** A rectangle narrower or shorter than this many DIP is no rectangle: a click, or a twitch of the mouse. */
export const SNAP_MIN_SIDE = 3

/**
 * The part of `rect` that lies on a display of `size`, or null when that part
 * is under SNAP_MIN_SIDE on either side (nothing on the display, a click, or
 * a rectangle given with a side that is not a positive finite number).
 */
export function clampRectToSize(rect: Rect, size: { width: number; height: number }): Rect | null {
  const { x, y, width, height } = rect
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  const left = Math.min(Math.max(x, 0), size.width)
  const top = Math.min(Math.max(y, 0), size.height)
  const right = Math.min(Math.max(x + width, 0), size.width)
  const bottom = Math.min(Math.max(y + height, 0), size.height)
  if (right - left < SNAP_MIN_SIDE || bottom - top < SNAP_MIN_SIDE) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}
