/**
 * Snap's own overlay page: one per display (src/main/snap/overlay.ts). It asks
 * main for its display's picture, shows it at the display's DIP size with a
 * crosshair, draws the dragged rectangle with its size, and answers once:
 * the rectangle (Enter), Whole screen, or Cancel (the button or Escape; main
 * also takes Escape before this page does). The selection itself is
 * ./selection.ts.
 */
import './snap-overlay.css'
import type { SnapOverlayInit, SnapOverlayMessage } from '../../shared/snap-overlay'
import { createOverlayController, sizeLabel, type OverlayState, type Point } from './selection'

/** The two calls the overlay preload (src/preload/snap-overlay.ts) exposes. */
interface SnapOverlayBridge {
  ready(): Promise<SnapOverlayInit>
  answer(message: SnapOverlayMessage): void
}

declare global {
  interface Window {
    snapOverlay?: SnapOverlayBridge
  }
}

/** Above this many px from the top, the size label sits above the rectangle; nearer, inside it. */
const LABEL_ROOM = 28

function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`the overlay page has no #${id}`)
  return found as T
}

export async function startOverlayPage(bridge: SnapOverlayBridge | undefined = window.snapOverlay): Promise<void> {
  if (!bridge) return
  const init = await bridge.ready()
  const picture = byId<HTMLImageElement>('picture')
  const selection = byId<HTMLDivElement>('selection')
  const size = byId<HTMLSpanElement>('size')
  const bar = byId<HTMLDivElement>('bar')
  const body = document.body

  const render = (state: OverlayState): void => {
    body.classList.toggle('has-rect', state.rect !== null)
    body.classList.toggle('dragging', state.dragging)
    if (!state.rect) return
    const { x, y, width, height } = state.rect
    selection.style.left = `${x}px`
    selection.style.top = `${y}px`
    selection.style.width = `${width}px`
    selection.style.height = `${height}px`
    size.textContent = sizeLabel(state.rect, init.scale)
    size.classList.toggle('inside', y < LABEL_ROOM)
  }

  const controller = createOverlayController({ width: init.width, height: init.height }, (m) => bridge.answer(m), render)

  // The picture at the display's DIP size: one CSS pixel is one DIP of it.
  picture.style.width = `${init.width}px`
  picture.style.height = `${init.height}px`
  picture.addEventListener('load', () => body.classList.add('pictured'), { once: true })
  picture.src = init.picture

  let last: Point = { x: 0, y: 0 }
  const at = (e: MouseEvent): Point => (last = { x: e.clientX, y: e.clientY })

  document.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || bar.contains(e.target as Node)) return
    e.preventDefault()
    // Keep the drag when the pointer leaves the window (onto another display).
    try { body.setPointerCapture(e.pointerId) } catch { /* no capture: the drag ends at the edge */ }
    controller.pointerDown(at(e))
  })
  document.addEventListener('pointermove', (e: PointerEvent) => controller.pointerMove(at(e)))
  document.addEventListener('pointerup', (e: PointerEvent) => controller.pointerUp(at(e)))
  document.addEventListener('pointercancel', () => controller.pointerUp(last))
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    // A focused button takes its own Enter (Whole screen, Cancel).
    if (e.key === 'Enter' && document.activeElement instanceof HTMLButtonElement) return
    if (controller.key(e.key)) e.preventDefault()
  })
  byId('whole').addEventListener('click', () => controller.wholeScreen())
  byId('cancel').addEventListener('click', () => controller.cancel())
  render(controller.state)
}

void startOverlayPage()
