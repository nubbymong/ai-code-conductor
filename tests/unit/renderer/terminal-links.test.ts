import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ILink } from '@xterm/xterm'
import { decorateTerminalLinks, createLinkHoverControl, LINK_HOVER_CLASS } from '../../../src/renderer/components/terminal/terminalLinks'

// hover/leave ignore the event arg (they key off the URI), so a plain cast
// avoids needing a DOM environment for MouseEvent. activate reads the button
// (aicc_planning#126), so its events carry one.
const EV = {} as MouseEvent
const click = (button: number, ctrlKey = false) => ({ button, ctrlKey }) as MouseEvent
const LEFT = click(0)

function fakeLink(text: string): ILink {
  return {
    range: { start: { x: 1, y: 1 }, end: { x: text.length, y: 1 } },
    text,
    activate: () => { throw new Error('original activate should be replaced') },
  }
}

describe('decorateTerminalLinks (#21)', () => {
  it('returns undefined when given no links', () => {
    expect(decorateTerminalLinks(undefined, { open: () => {}, onHover: () => {}, onLeave: () => {} })).toBeUndefined()
  })

  it('turns BOTH hover decorations OFF (underline: #562 selection flicker; pointerCursor: 2026-09-02 hover flicker)', () => {
    // xterm clears + re-asks the hovered link on every viewport re-render, so
    // any decoration it owns strobes at render cadence in a busy session. The
    // hand cursor is managed by createLinkHoverControl instead.
    const [d] = decorateTerminalLinks([fakeLink('https://x.dev')], { open: () => {}, onHover: () => {}, onLeave: () => {} })!
    expect(d.decorations?.underline).toBe(false)
    expect(d.decorations?.pointerCursor).toBe(false)
  })

  it('routes activate through open() with the matched URI (both http and https)', () => {
    const open = vi.fn()
    const links = decorateTerminalLinks(
      [fakeLink('https://a.dev'), fakeLink('http://b.local')],
      { open, onHover: () => {}, onLeave: () => {} },
    )!
    links[0].activate(LEFT, 'https://a.dev')
    links[1].activate(LEFT, 'http://b.local')
    expect(open).toHaveBeenNthCalledWith(1, 'https://a.dev')
    expect(open).toHaveBeenNthCalledWith(2, 'http://b.local')
  })

  describe('only a plain left click opens the link (aicc_planning#126)', () => {
    // xterm calls activate on the mouseup of ANY button over a link, so a
    // right-click (whose job is the context menu with "Copy link address")
    // also opened the browser. The decorator now filters the gesture.
    afterEach(() => { vi.unstubAllGlobals() })
    const decorate = () => {
      const open = vi.fn()
      const [d] = decorateTerminalLinks([fakeLink('https://x.dev')], { open, onHover: () => {}, onLeave: () => {} })!
      return { d, open }
    }

    it('a left click (button 0) opens', () => {
      const { d, open } = decorate()
      d.activate(LEFT, 'https://x.dev')
      expect(open).toHaveBeenCalledExactlyOnceWith('https://x.dev')
    })

    it('a right click (button 2) does not open', () => {
      const { d, open } = decorate()
      d.activate(click(2), 'https://x.dev')
      expect(open).not.toHaveBeenCalled()
    })

    it('a middle click (button 1) does not open', () => {
      const { d, open } = decorate()
      d.activate(click(1), 'https://x.dev')
      expect(open).not.toHaveBeenCalled()
    })

    it('on macOS, Ctrl + left click (the context-menu gesture) does not open', () => {
      vi.stubGlobal('window', { electronPlatform: 'darwin' })
      const { d, open } = decorate()
      d.activate(click(0, true), 'https://x.dev')
      expect(open).not.toHaveBeenCalled()
      // ...but a plain left click on macOS still opens.
      d.activate(LEFT, 'https://x.dev')
      expect(open).toHaveBeenCalledExactlyOnceWith('https://x.dev')
    })

    it('on Windows, Ctrl + left click is still a left click and opens', () => {
      vi.stubGlobal('window', { electronPlatform: 'win32' })
      const { d, open } = decorate()
      d.activate(click(0, true), 'https://x.dev')
      expect(open).toHaveBeenCalledExactlyOnceWith('https://x.dev')
    })
  })

  it('records the hovered URI and clears it on leave (for the Copy-link menu item)', () => {
    const onHover = vi.fn()
    const onLeave = vi.fn()
    const [d] = decorateTerminalLinks([fakeLink('https://x.dev')], { open: () => {}, onHover, onLeave })!
    d.hover!(EV, 'https://x.dev')
    d.leave!(EV, 'https://x.dev')
    expect(onHover).toHaveBeenCalledWith('https://x.dev')
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('passes range and text through unchanged', () => {
    const src = fakeLink('https://x.dev/path')
    const [d] = decorateTerminalLinks([src], { open: () => {}, onHover: () => {}, onLeave: () => {} })!
    expect(d.text).toBe('https://x.dev/path')
    expect(d.range).toEqual(src.range)
  })
})

describe('createLinkHoverControl (2026-09-02 hover-flicker fix)', () => {
  afterEach(() => { vi.useRealTimers() })

  function fakeEl() {
    const classes = new Set<string>()
    return {
      el: {
        classList: {
          add: (c: string) => { classes.add(c) },
          remove: (c: string) => { classes.delete(c) },
        },
      } as unknown as HTMLElement,
      has: () => classes.has(LINK_HOVER_CLASS),
    }
  }

  it('the hover class stays OUT of the claude-session cursor-nuke net (never contains "xterm-cursor")', () => {
    // terminalTheme.ts hides any element matching [class*="xterm-cursor"]
    // inside a Claude session (display:none !important) — reusing xterm's own
    // xterm-cursor-pointer here display:noned the ENTIRE terminal on hover
    // (review blocker, 2026-09-02), and xterm strobing that class per render
    // is what made the original flicker so visible. App-owned name only.
    expect(LINK_HOVER_CLASS).not.toMatch(/xterm-cursor/)
    // ...and the injected stylesheet actually pairs a cursor rule with it.
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const theme = fs.readFileSync(
      path.resolve(__dirname, '../../../src/renderer/components/terminal/terminalTheme.ts'),
      'utf-8',
    )
    expect(theme).toContain('LINK_HOVER_CLASS}')
    expect(theme).toContain('cursor: pointer !important')
  })

  it('hover applies the hand cursor and records the URI immediately', () => {
    const f = fakeEl()
    const c = createLinkHoverControl(() => f.el)
    c.hover('https://x.dev')
    expect(f.has()).toBe(true)
    expect(c.current()).toBe('https://x.dev')
  })

  it("xterm's re-render churn (leave then immediate re-hover) never drops the cursor or the URI", () => {
    // The bug: xterm clears + re-asks the hovered link on every viewport
    // re-render, so leave/hover fired at render cadence and the hand cursor
    // strobed. The debounced leave makes the gap invisible.
    vi.useFakeTimers()
    const f = fakeEl()
    const c = createLinkHoverControl(() => f.el, 150)
    c.hover('https://x.dev')
    for (let i = 0; i < 10; i++) {
      c.leave()
      vi.advanceTimersByTime(20) // re-provide lands well inside the debounce
      c.hover('https://x.dev')
      expect(f.has()).toBe(true)
      expect(c.current()).toBe('https://x.dev')
    }
    // ...and a right-click inside a churn gap still sees the URI (latent race).
    c.leave()
    vi.advanceTimersByTime(100)
    expect(c.current()).toBe('https://x.dev')
    // Run the debounce out (Copilot nit: no pending fake timer left behind) —
    // which also pins the other half: an UNCANCELLED leave does clear.
    vi.advanceTimersByTime(51)
    expect(c.current()).toBeNull()
    expect(f.has()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a real departure clears the cursor and the URI after the delay', () => {
    vi.useFakeTimers()
    const f = fakeEl()
    const c = createLinkHoverControl(() => f.el, 150)
    c.hover('https://x.dev')
    c.leave()
    vi.advanceTimersByTime(151)
    expect(f.has()).toBe(false)
    expect(c.current()).toBeNull()
  })

  it('moving between two links keeps the cursor and swaps the URI', () => {
    vi.useFakeTimers()
    const f = fakeEl()
    const c = createLinkHoverControl(() => f.el, 150)
    c.hover('https://a.dev')
    c.leave()
    c.hover('https://b.dev')
    vi.advanceTimersByTime(500)
    expect(f.has()).toBe(true)
    expect(c.current()).toBe('https://b.dev')
  })

  it('dispose cancels a pending leave and clears state at once', () => {
    vi.useFakeTimers()
    const f = fakeEl()
    const c = createLinkHoverControl(() => f.el, 150)
    c.hover('https://x.dev')
    c.leave()
    c.dispose()
    expect(f.has()).toBe(false)
    expect(c.current()).toBeNull()
    vi.advanceTimersByTime(500) // the cancelled timer must not fire anything
    expect(vi.getTimerCount()).toBe(0)
  })

  it('tolerates a missing element (terminal not yet opened / already disposed)', () => {
    const c = createLinkHoverControl(() => null)
    c.hover('https://x.dev')
    expect(c.current()).toBe('https://x.dev')
    c.dispose()
    expect(c.current()).toBeNull()
  })
})
