// @vitest-environment jsdom
// aicc_planning#421 (beta.17 C10): measured first, on the app's xterm (@xterm/xterm 6.0.0)
// in jsdom, with its cell measured as 9x17 as console-repaint-narrow-keep.test.ts does.
//
// TerminalView showed its Live (scroll to bottom) button from its wheel listener on the
// element the terminal is opened in, 80 ms after the last wheel event; its onScroll only
// cleared it. xterm 6 scrolls with VS Code's scrollable element, which calls
// stopPropagation() on every wheel event it scrolls the view with
// (scrollableElement.ts _onMouseWheel: consumeMouseWheel = didScroll). So that listener
// heard a wheel only when the view could not move (at the top or at the bottom): a scroll
// up that stopped short of the top never showed the button until the next output. Not a
// harness effect: the stop is xterm's for any wheel that moved its scroll position, whatever
// the size of its step (one row, a mouse notch, a touchpad's fractional steps and a
// line-mode wheel are measured below). Every way a user moves the view (wheel, scroll bar, keyboard)
// does fire xterm's onScroll with the view above the bottom, which the fix reads.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { Terminal } from '@xterm/xterm'

const stubbed: Array<{ proto: object; key: string; was: PropertyDescriptor | undefined }> = []
function stub(proto: object, key: string, value: PropertyDescriptor): void {
  stubbed.push({ proto, key, was: Object.getOwnPropertyDescriptor(proto, key) })
  Object.defineProperty(proto, key, { configurable: true, ...value })
}

beforeAll(() => {
  // xterm measures its cell from a span of 32 W's (DomMeasureStrategy): 9x17.
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
/** A frame of the app's xterm: its scroll bar takes the buffer's size (Viewport). */
const frame = () => new Promise<void>((done) => setTimeout(done, 40))

/** A terminal of 30x10 opened in `host` (TerminalView's container), 40 lines
 *  written: its view at the bottom, 30 rows above its screen. */
async function scrolledTerminal(): Promise<{ term: Terminal; host: HTMLElement; screen: HTMLElement }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const term = new Terminal({ cols: 30, rows: 10, scrollback: 200 })
  term.open(host)
  made.push(term)
  await write(term, Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\r\n'))
  await frame()
  const screen = host.querySelector('.xterm-screen') as HTMLElement
  expect([term.buffer.active.baseY, term.buffer.active.viewportY, !!screen]).toEqual([30, 30, true])
  return { term, host, screen }
}

/** Where a listener on `host` hears a wheel event: TerminalView's listener is
 *  `bubble` (addEventListener with no options). */
function listen(host: HTMLElement): string[] {
  const heard: string[] = []
  host.addEventListener('wheel', () => heard.push('capture'), { capture: true })
  host.addEventListener('wheel', () => heard.push('bubble'))
  return heard
}

const wheel = (on: HTMLElement, deltaY: number, deltaMode = 0) =>
  on.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode, bubbles: true, cancelable: true }))

describe('xterm 6 and a wheel over its screen (the measurement, aicc_planning#421)', () => {
  // One row's height (the VM line's step), a mouse notch on Windows (100 px)
  // and a touchpad's small fractional steps, all deltaMode 0 (pixels); a
  // line-mode wheel (deltaMode 1) too. jsdom's WheelEvent has no wheelDeltaY,
  // so xterm reads deltaY here (mouseEvent.ts: -deltaY / 40) where Chromium's
  // event has one and xterm reads that (wheelDeltaY / 120): the size of the
  // step differs from the app's, the stop does not (scrollableElement.ts
  // _onMouseWheel stops any wheel that moved its scroll position).
  const shapes: Array<[string, number[], number]> = [
    ['one row\'s height (17 px), the VM line\'s step', [-17], 0],
    ['a mouse notch (100 px)', [-100], 0],
    ['a touchpad: fractional steps', [-2.5, -3.75, -4.25, -6.5, -7.25], 0],
    ['a line-mode wheel (3 lines)', [-3], 1],
  ]
  for (const [what, steps, mode] of shapes) {
    it(`${what}: the view moves up, and a listener on the terminal's element hears it only in the capture phase (xterm stops it)`, async () => {
      const { term, host, screen } = await scrolledTerminal()
      const heard = listen(host)
      for (const d of steps) wheel(screen, d, mode)
      const b = term.buffer.active
      // The view has moved by the time the event has gone, before any timer.
      expect(b.viewportY, 'the view moved up at once').toBeLessThan(b.baseY)
      expect(heard.filter((h) => h === 'bubble'), 'never heard after xterm (the old listener)').toEqual([])
      expect(heard.filter((h) => h === 'capture')).toHaveLength(steps.length)
    })
  }

  it('at the top already (the VM line\'s big steps, C5): the view cannot move, xterm lets the event go on, and the old listener hears it', async () => {
    const { term, host, screen } = await scrolledTerminal()
    term.scrollToTop()
    await frame()
    expect(term.buffer.active.viewportY).toBe(0)
    const heard = listen(host)
    wheel(screen, -60000)
    expect(heard).toEqual(['capture', 'bubble'])
  })
})

describe('every way a user moves the view fires xterm\'s onScroll with the view above the bottom (what the fix reads)', () => {
  it('a wheel step of one row\'s height', async () => {
    const { term, screen } = await scrolledTerminal()
    const seen: Array<[number, number]> = []
    term.onScroll(() => seen.push([term.buffer.active.viewportY, term.buffer.active.baseY]))
    wheel(screen, -17)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)![0]).toBeLessThan(seen.at(-1)![1])
  })

  it('the scroll bar (xterm moves its view from it, as scrollLines does for a drag)', async () => {
    const { term } = await scrolledTerminal()
    const seen: Array<[number, number]> = []
    term.onScroll(() => seen.push([term.buffer.active.viewportY, term.buffer.active.baseY]))
    term.scrollLines(-3)
    expect(seen).toEqual([[27, 30]])
  })

  it('the keyboard (Shift+PageUp on xterm\'s text area)', async () => {
    const { term } = await scrolledTerminal()
    const seen: Array<[number, number]> = []
    term.onScroll(() => seen.push([term.buffer.active.viewportY, term.buffer.active.baseY]))
    const ev = new KeyboardEvent('keydown', { key: 'PageUp', code: 'PageUp', shiftKey: true, bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'keyCode', { value: 33 })
    term.textarea!.dispatchEvent(ev)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)![0]).toBeLessThan(seen.at(-1)![1])
  })

  it('output at the bottom fires onScroll too, always at the bottom (nothing to arm)', async () => {
    const { term } = await scrolledTerminal()
    const seen: Array<[number, number]> = []
    term.onScroll(() => seen.push([term.buffer.active.viewportY, term.buffer.active.baseY]))
    await write(term, '\r\n' + Array.from({ length: 25 }, (_, i) => `more ${i + 1}`).join('\r\n'))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.filter(([v, base]) => v < base)).toEqual([])
  })
})
