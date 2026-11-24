// Snap's own overlay, the page's half (src/renderer/snap-overlay/selection.ts;
// ADR-030 D4): a drag gives its rectangle and Enter takes it, a click gives
// none, Whole screen and Escape answer at once, a rectangle is clamped to the
// display, and the page answers once. (Which display answered is main's to say:
// tests/unit/main/snap-overlay.test.ts.)
import { describe, it, expect } from 'vitest'
import { createOverlayController, sizeLabel } from '../../../src/renderer/snap-overlay/selection'
import type { SnapOverlayMessage } from '../../../src/shared/snap-overlay'

const SIZE = { width: 1920, height: 1080 }

function setup() {
  const sent: SnapOverlayMessage[] = []
  const controller = createOverlayController(SIZE, (m) => sent.push(m))
  const drag = (from: [number, number], to: [number, number]) => {
    controller.pointerDown({ x: from[0], y: from[1] })
    controller.pointerMove({ x: (from[0] + to[0]) / 2, y: (from[1] + to[1]) / 2 })
    controller.pointerMove({ x: to[0], y: to[1] })
    controller.pointerUp({ x: to[0], y: to[1] })
  }
  return { sent, controller, drag }
}

describe('the selection', () => {
  it('a drag gives its rectangle, and Enter takes it', () => {
    const { sent, controller, drag } = setup()
    drag([100, 50], [300, 170])
    expect(controller.state.rect).toEqual({ x: 100, y: 50, width: 200, height: 120 })
    expect(sent).toEqual([])
    expect(controller.key('Enter')).toBe(true)
    expect(sent).toEqual([{ kind: 'rect', rect: { x: 100, y: 50, width: 200, height: 120 } }])
  })

  it('a drag up and to the left gives the same rectangle', () => {
    const { controller, drag } = setup()
    drag([300, 170], [100, 50])
    expect(controller.state.rect).toEqual({ x: 100, y: 50, width: 200, height: 120 })
  })

  it('the rectangle follows the pointer while the drag is under way', () => {
    const { controller } = setup()
    controller.pointerDown({ x: 10, y: 10 })
    controller.pointerMove({ x: 60, y: 40 })
    expect(controller.state).toMatchObject({ dragging: true, rect: { x: 10, y: 10, width: 50, height: 30 } })
  })

  it('a click gives no rectangle, and Enter then sends nothing', () => {
    const { sent, controller } = setup()
    controller.pointerDown({ x: 500, y: 500 })
    controller.pointerUp({ x: 501, y: 500 })
    expect(controller.state.rect).toBeNull()
    expect(controller.key('Enter')).toBe(false)
    expect(sent).toEqual([])
  })

  it('Enter with no rectangle sends nothing', () => {
    const { sent, controller } = setup()
    expect(controller.key('Enter')).toBe(false)
    expect(sent).toEqual([])
  })

  it('Enter during a drag sends nothing; the drag must end first', () => {
    const { sent, controller } = setup()
    controller.pointerDown({ x: 10, y: 10 })
    controller.pointerMove({ x: 200, y: 200 })
    expect(controller.key('Enter')).toBe(false)
    expect(sent).toEqual([])
  })

  it('a rectangle dragged past the display edge is clamped to the display', () => {
    const { sent, controller, drag } = setup()
    drag([1900, 1000], [2500, -300])
    expect(controller.state.rect).toEqual({ x: 1900, y: 0, width: 20, height: 1000 })
    controller.key('Enter')
    expect(sent).toEqual([{ kind: 'rect', rect: { x: 1900, y: 0, width: 20, height: 1000 } }])
  })

  it('a new drag replaces the last rectangle; a click clears it', () => {
    const { controller, drag } = setup()
    drag([0, 0], [100, 100])
    drag([200, 200], [250, 260])
    expect(controller.state.rect).toEqual({ x: 200, y: 200, width: 50, height: 60 })
    drag([400, 400], [400, 400])
    expect(controller.state.rect).toBeNull()
  })

  it('Whole screen answers at once, with or without a rectangle', () => {
    const { sent, controller, drag } = setup()
    drag([0, 0], [100, 100])
    controller.wholeScreen()
    expect(sent).toEqual([{ kind: 'whole' }])
  })

  it('Escape and Cancel cancel', () => {
    const a = setup()
    expect(a.controller.key('Escape')).toBe(true)
    expect(a.sent).toEqual([{ kind: 'cancel' }])
    const b = setup()
    b.controller.cancel()
    expect(b.sent).toEqual([{ kind: 'cancel' }])
  })

  it('other keys do nothing', () => {
    const { sent, controller, drag } = setup()
    drag([0, 0], [100, 100])
    expect(controller.key('a')).toBe(false)
    expect(controller.key(' ')).toBe(false)
    expect(sent).toEqual([])
  })

  it('the page answers once', () => {
    const { sent, controller, drag } = setup()
    controller.wholeScreen()
    drag([0, 0], [100, 100])
    controller.key('Enter')
    controller.key('Escape')
    controller.cancel()
    controller.wholeScreen()
    expect(sent).toEqual([{ kind: 'whole' }])
    expect(controller.state.answered).toBe(true)
  })
})

describe('the size shown beside the rectangle', () => {
  it("is the picture's own pixels: DIP times the display's scale", () => {
    expect(sizeLabel({ x: 0, y: 0, width: 200, height: 120 }, 1)).toBe('200 × 120')
    expect(sizeLabel({ x: 0, y: 0, width: 200, height: 120 }, 1.5)).toBe('300 × 180')
    expect(sizeLabel({ x: 0, y: 0, width: 33.4, height: 10 }, 1.25)).toBe('42 × 13')
  })
})
