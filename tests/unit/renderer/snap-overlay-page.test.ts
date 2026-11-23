// @vitest-environment jsdom
// Snap's own overlay page, its DOM wiring (src/renderer/snap-overlay/overlay-page.ts,
// on the page's own markup, src/renderer/snap-overlay.html): the picture shown
// at the display's DIP size, a drag drawn with its size in the picture's pixels,
// Enter takes it, a press on the bar is no drag, a focused button keeps its own
// Enter, Escape and the two buttons answer. The selection rules themselves are
// tests/unit/renderer/snap-overlay-selection.test.ts.
// Every test ends with an answer: a page that has answered ignores all input,
// so the listeners an earlier test left on this document stay inert.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { startOverlayPage } from '../../../src/renderer/snap-overlay/overlay-page'

const html = readFileSync(join(__dirname, '../../../src/renderer/snap-overlay.html'), 'utf-8')
const markup = html.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, '')
const INIT = { picture: 'data:image/jpeg;base64,AAAA', width: 1280, height: 720, scale: 1.5 }

const Pointer = (globalThis.PointerEvent ?? MouseEvent) as typeof MouseEvent
const pointer = (target: EventTarget, type: string, x: number, y: number, button = 0) =>
  target.dispatchEvent(new Pointer(type, { clientX: x, clientY: y, button, bubbles: true }))
const key = (target: EventTarget, k: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

async function open() {
  document.body.className = ''
  document.body.innerHTML = markup
  const answer = vi.fn()
  await startOverlayPage({ ready: async () => INIT, answer })
  return answer
}

function drag(from: [number, number], to: [number, number]) {
  pointer(document.body, 'pointerdown', ...from)
  pointer(document.body, 'pointermove', ...to)
  pointer(document.body, 'pointerup', ...to)
}

describe("Snap's overlay page", () => {
  it("shows the display's picture at its DIP size", async () => {
    const answer = await open()
    const picture = $<HTMLImageElement>('picture')
    expect(picture.getAttribute('src')).toBe(INIT.picture)
    expect(picture.style.width).toBe('1280px')
    expect(picture.style.height).toBe('720px')
    $('cancel').click()
    expect(answer).toHaveBeenCalledWith({ kind: 'cancel' })
  })

  it("draws the drag with its size in the picture's pixels, and Enter takes it", async () => {
    const answer = await open()
    drag([100, 50], [300, 170])
    expect(document.body.classList.contains('has-rect')).toBe(true)
    const sel = $('selection')
    expect([sel.style.left, sel.style.top, sel.style.width, sel.style.height]).toEqual(['100px', '50px', '200px', '120px'])
    expect($('size').textContent).toBe('300 × 180')
    expect(answer).not.toHaveBeenCalled()
    key(window, 'Enter')
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer).toHaveBeenCalledWith({ kind: 'rect', rect: { x: 100, y: 50, width: 200, height: 120 } })
  })

  it('puts the size inside a rectangle at the top edge', async () => {
    const answer = await open()
    drag([10, 2], [200, 100])
    expect($('size').classList.contains('inside')).toBe(true)
    key(window, 'Escape')
    expect(answer).toHaveBeenCalledWith({ kind: 'cancel' })
  })

  it('a press on the bar, or with another button, starts no drag', async () => {
    const answer = await open()
    pointer($('whole'), 'pointerdown', 640, 20)
    expect(document.body.classList.contains('dragging')).toBe(false)
    pointer(document.body, 'pointerdown', 100, 100, 2)
    expect(document.body.classList.contains('dragging')).toBe(false)
    $('whole').click()
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer).toHaveBeenCalledWith({ kind: 'whole' })
  })

  it('a focused button keeps its own Enter: the rectangle is not taken', async () => {
    const answer = await open()
    drag([100, 100], [400, 300])
    $<HTMLButtonElement>('cancel').focus()
    key($('cancel'), 'Enter')
    expect(answer).not.toHaveBeenCalled()
    $('cancel').click()
    expect(answer).toHaveBeenCalledTimes(1)
    expect(answer).toHaveBeenCalledWith({ kind: 'cancel' })
  })
})
