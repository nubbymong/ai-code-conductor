// @vitest-environment jsdom
/**
 * aicc_planning#398 (plan 2.1.3-beta.15 section B2): a tab hidden between its
 * terminal's set-up and its first fit starts its PTY at its own size, not at
 * xterm.js's default 80x24. initTerminal waits for a pane with a size, but the
 * fit runs later (after the font wait and one more frame), and a tab switched
 * away from meanwhile is display: none (App.tsx). The fit addon has nothing to
 * measure there and leaves the terminal at 80x24; before the fix the view
 * spawned at that size (beta.14's C5 VM re-check: a console host started with
 * `--width 80 --height 24` while the other tabs read 103x27).
 *
 * Here the pane's size is under test control, and the fit addon behaves as the
 * real one does: no size, no change; a size, the columns its cell fits (8 px
 * with WebGL loaded, 8.86 px on the DOM renderer, so 824 px is 103 or 93
 * columns, as on the 1024x768 VM). Tabs are switched by rendering the view with
 * isActive off and on again, with the pane's size gone and back.
 *
 * The resize observer does nothing for a pane with no size: with only the fit
 * changed, a pane waiting hidden for its first fit would send 80x24 to main,
 * and a view that took over a running PTY would leave it at 80x24 (its first
 * fit records the tab's size without sending it).
 *
 * Guards that pass on the old view by design: a pane on screen spawns on its
 * first fit frame (GPU rendering on and off); a view that takes over a running
 * PTY never resizes it to 80x24 (the old view fitted the hidden pane at once
 * and recorded 80x24, so its observer sent the tab's size when shown); and a
 * started pane hidden and shown at another size gets nothing from its
 * observer while hidden and the new size once shown (the observer holds back
 * only a pane with no size).
 * Harness: terminalview-renderer-wait.test.tsx's mocks.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const H = vi.hoisted(() => {
  class MockWebgl {
    static built = 0
    constructor() { MockWebgl.built++ }
    onContextLoss() { return { dispose() {} } }
    clearTextureAtlas() {}
    dispose() { H.webglLoaded = false }
  }
  class MockTerminal {
    static last: any = null
    options: any
    cols = 80
    rows = 24
    element: HTMLElement | null = null
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, length: 0, cursorY: 0, getLine: (_y: number) => undefined } }
    focus = () => {}
    scrollToBottom = () => {}
    constructor(opts?: any) { this.options = { ...(opts ?? {}) }; MockTerminal.last = this }
    open(el: HTMLElement) { this.element = el }
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
    loadAddon(addon: unknown) { if (addon instanceof MockWebgl) H.webglLoaded = true }
    onData() { return { dispose() {} } }
    onScroll() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    registerLinkProvider() { return { dispose() {} } }
    refresh() {}
    paste() {}
    clearSelection() {}
    getSelection() { return '' }
    write() {}
    writeln() {}
    dispose() {}
  }
  const sessionState: any = {
    sessions: [] as any[],
    activeSessionId: 's-1',
    updateSession: () => {},
  }
  const spawned = new Set<string>()
  const tokens = new Map<string, number>()
  const counter = { last: 0 }
  const settings = { gpu: true }
  /** The pane's laid-out size: 0x0 while its tab is hidden (display: none). */
  const rect = { width: 824, height: 540 }
  return { MockTerminal, MockWebgl, sessionState, spawned, tokens, counter, settings, rect, webglLoaded: false }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({ default: {} }))
vi.mock('@xterm/xterm', () => ({ Terminal: H.MockTerminal }))
// As @xterm/addon-fit 0.11.0: a hidden pane gives no dimensions, so fit()
// changes nothing; a pane with a size gets the columns and rows its cell fits.
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      const t = H.MockTerminal.last
      if (!t || H.rect.width === 0 || H.rect.height === 0) return
      t.cols = Math.floor(H.rect.width / (H.webglLoaded ? 8 : 8.86))
      t.rows = Math.floor(H.rect.height / 20)
    }
    proposeDimensions() { return { cols: 80, rows: 24 } }
  },
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: H.MockWebgl }))
vi.mock('../../../src/renderer/components/terminal/atlasCoordinator', () => ({
  atlasCoordinator: { register: () => () => {}, notifyCleared: () => {}, resyncIfBehind: () => {} },
}))
vi.mock('../../../src/renderer/components/terminal/staleGlyphRepaint', () => ({
  createStaleGlyphRepainter: () => ({ schedule() {}, settle() {}, settleStrong() {}, strongIfStale() {}, dispose() {} }),
  shouldRepaintOnOutput: () => false,
  shouldSoftRepaintOnOutput: () => false,
  outputRepaintIntervalMs: () => 1000,
  ACTIVATION_MAX_STALE_MS: 1000,
  WHEEL_ACTIVE_MS: 100,
}))
vi.mock('../../../src/renderer/components/terminal/terminalTheme', () => ({ getTerminalTheme: () => ({ background: '#000000' }) }))
vi.mock('../../../src/renderer/components/terminal/terminalKeybindings', () => ({ installTerminalKeybindings: () => () => {} }))
vi.mock('../../../src/renderer/components/terminal/repaintRegistry', () => ({
  registerRepainter: () => () => {},
  requestResync: () => {},
  scheduleBleedRepaints: () => {},
}))
vi.mock('../../../src/renderer/components/terminal/geometryResync', () => ({
  createGeometryResync: () => ({ fire() {}, dispose() {} }),
}))
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign((sel: any) => sel(H.sessionState), { getState: () => H.sessionState }),
}))
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({ useRestartSession: () => ({ restart: () => {} }) }))
vi.mock('../../../src/renderer/session-persistence', () => ({
  persistLastUsedAccount: () => {},
  persistSessionProviderAccount: () => Promise.resolve(),
}))
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => {
  const st = { profiles: [] }
  return { useAccountProfilesStore: Object.assign((sel: any) => sel(st), { getState: () => st }) }
})
vi.mock('../../../src/renderer/stores/sshCloseStore', () => ({ forgetSessionBrowserProfile: () => {} }))
vi.mock('../../../src/renderer/ptyTracker', () => ({
  hasSpawned: (id: string) => H.spawned.has(id),
  markSpawned: (id: string) => { H.spawned.add(id); const t = ++H.counter.last; H.tokens.set(id, t); return t },
  isCurrentSpawn: (id: string, t: number | undefined) => H.spawned.has(id) && t !== undefined && H.tokens.get(id) === t,
  clearSpawned: (id: string) => { H.spawned.delete(id); H.tokens.delete(id) },
  killSessionPty: () => {},
}))
vi.mock('../../../src/renderer/components/SshFlowOverlay', () => ({ default: () => null }))
vi.mock('../../../src/renderer/utils/resumePicker', () => ({ shouldUseResumePicker: () => false }))
vi.mock('../../../src/renderer/components/TerminalContextMenu', () => ({ default: () => null }))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const st = { settings: { terminal: {} } }
  return {
    useSettingsStore: Object.assign((sel: any) => sel(st), { getState: () => st }),
    DEFAULT_TERMINAL_SETTINGS: {},
    gpuRenderingEnabled: () => H.settings.gpu,
  }
})
vi.mock('../../../src/renderer/stores/pasteHintStore', () => {
  const st = { show: () => {} }
  return { usePasteHintStore: Object.assign((sel: any) => sel(st), { getState: () => st }) }
})
vi.mock('../../../src/renderer/utils/inputDiagnostics', () => ({ installInputDiagnostics: () => () => {}, describeBytes: () => '' }))
vi.mock('../../../src/renderer/components/terminal', () => ({ ScrollToBottomButton: () => null }))
vi.mock('../../../src/renderer/hooks/useStatuslineSubscription', () => ({ useStatuslineSubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useEffortSubscription', () => ({ useEffortSubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useWatchdogSubscription', () => ({ useWatchdogSubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useAccountIdentitySubscription', () => ({ useAccountIdentitySubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useActiveTabEffect', () => ({ useActiveTabEffect: () => {} }))
vi.mock('../../../src/renderer/hooks/useCursorLayerVisibility', () => ({ useCursorLayerVisibility: () => {} }))

const spawn = vi.fn((_id: string, _opts: Record<string, unknown>) => Promise.resolve({ started: true }))
const resize = vi.fn((_id: string, _cols: number, _rows: number) => {})
/** aicc_planning#423: each tab main was told is shown, with the spawns made by then. */
const shownTold: Array<{ id: string; spawnsBefore: number }> = []
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: {
    write: vi.fn(),
    resize,
    spawn,
    tabShown: (id: string) => { shownTold.push({ id, spawnsBefore: spawn.mock.calls.length }) },
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
  },
  inputDebug: { enabled: vi.fn(async () => false), log: vi.fn() },
  clipboard: { readText: vi.fn(async () => '') },
  ssh: { onSessionInfo: vi.fn(() => () => {}), onFlowState: vi.fn(() => () => {}) },
}

Element.prototype.getBoundingClientRect = function () {
  const { width, height } = H.rect
  return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() { return {} } } as DOMRect
}
/** The view's resize observers, fired by hand (a size change, as the browser would). */
let observers: Array<() => void> = []
class RO {
  constructor(cb: () => void) { observers.push(cb) }
  observe() {} unobserve() {} disconnect() {}
}
;(globalThis as any).ResizeObserver = RO
;(window as any).ResizeObserver = RO
// The font is loaded (check() true), so the terminal is built on the first
// frame and the fit waits only on document.fonts.ready, already settled.
Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), load: () => Promise.resolve([]), check: () => true }, configurable: true })

let rafQueue: FrameRequestCallback[] = []
const installRaf = () => {
  const req = (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length }
  ;(window as any).requestAnimationFrame = req
  ;(globalThis as any).requestAnimationFrame = req
  ;(window as any).cancelAnimationFrame = () => {}
  ;(globalThis as any).cancelAnimationFrame = () => {}
}
/** One frame: what was queued for it runs; what it queues waits for the next. */
const frame = () => { const q = rafQueue; rafQueue = []; q.forEach((cb) => cb(0)) }
const microtasks = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }

const { default: TerminalView } = await import('../../../src/renderer/components/TerminalView')

let container: HTMLDivElement
let root: Root

const render = (isActive: boolean) => {
  act(() => { root.render(React.createElement(TerminalView as any, { sessionId: 's-1', cwd: 'C:/proj', isActive, shellOnly: true })) })
}
const mount = () => {
  H.sessionState.sessions = [{ id: 's-1', label: 'shell', workingDirectory: 'C:/proj', color: '#89b4fa', sessionType: 'local', provider: 'claude', shellOnly: true }]
  render(true)
}
/** The set-up frame: initTerminal builds the terminal on a pane with a size,
 *  and the font wait (settled) queues the fit frame. React's effects run when
 *  the act ends, so the active pane has its WebGL renderer after it. */
const setUp = async () => {
  await act(async () => {
    frame()
    await microtasks()
  })
}
/** The tab switched away from: its pane loses its size, the view goes inactive. */
const hide = () => { H.rect.width = 0; H.rect.height = 0; render(false) }
/** The tab shown again, at the size its pane has now. */
const show = (width = 824, height = 540) => { H.rect.width = width; H.rect.height = height; render(true) }
const spawnedSizes = () => spawn.mock.calls.map((c) => [c[1].cols, c[1].rows])
/** Each resize observer fires, and its 80 ms debounce runs out. */
const fireObservers = async () => {
  await act(async () => {
    observers.forEach((cb) => cb())
    await new Promise((r) => setTimeout(r, 120))
  })
}

beforeEach(() => {
  rafQueue = []
  observers = []
  installRaf()
  spawn.mockClear()
  resize.mockClear()
  shownTold.length = 0
  H.spawned.clear()
  H.tokens.clear()
  H.settings.gpu = true
  H.webglLoaded = false
  H.MockWebgl.built = 0
  H.MockTerminal.last = null
  H.rect.width = 824
  H.rect.height = 540
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('a tab hidden before its first fit starts its terminal at its own size (aicc_planning#398)', () => {
  it('hidden between its set-up and its fit: nothing spawns while it is hidden; shown, it spawns at its own 103x27, never 80x24', async () => {
    mount()
    await setUp()
    hide()
    await act(async () => { frame() }) // the fit frame, on a hidden pane
    expect(spawnedSizes(), 'no spawn while the pane has no size').toEqual([])
    for (let i = 0; i < 100; i++) await act(async () => { frame() })
    expect(spawnedSizes(), 'still none after 100 hidden frames').toEqual([])
    expect(rafQueue, 'one fit frame waiting, not one per frame').toHaveLength(1)
    show()
    await act(async () => { frame() })
    expect(spawnedSizes()).toEqual([[103, 27]])
  })

  it('shown at another size (the window changed while it was hidden): it spawns at the size it has when shown', async () => {
    mount()
    await setUp()
    hide()
    for (let i = 0; i < 5; i++) await act(async () => { frame() })
    show(960, 600)
    await act(async () => { frame() })
    expect(spawnedSizes()).toEqual([[120, 30]])
  })

  it('a pane on screen spawns on its first fit frame, at once', async () => {
    mount()
    await setUp()
    await act(async () => { frame() })
    expect(spawnedSizes()).toEqual([[103, 27]])
  })

  it('a pane on screen with GPU rendering off spawns on its first fit frame, at the DOM renderer\'s size', async () => {
    H.settings.gpu = false
    mount()
    await setUp()
    await act(async () => { frame() })
    expect(H.MockWebgl.built).toBe(0)
    expect(spawnedSizes()).toEqual([[93, 27]])
  })

  it('its resize observer sends main no size while the pane waits hidden; shown, the spawn carries the size', async () => {
    mount()
    await setUp()
    hide()
    await act(async () => { frame() })
    await fireObservers() // the pane lost its size: the observer fires
    expect(resize.mock.calls, 'no 80x24 reaches main from a hidden pane').toEqual([])
    show()
    await act(async () => { frame() })
    await fireObservers() // the pane has its size again
    expect(spawnedSizes()).toEqual([[103, 27]])
    expect(resize.mock.calls, 'the observer finds the size the spawn carried').toEqual([])
  })

  it('a started pane hidden and shown at another size: its observer sends main nothing while hidden, and the new size once shown', async () => {
    mount()
    await setUp()
    await act(async () => { frame() })
    expect(spawnedSizes()).toEqual([[103, 27]])
    hide()
    await fireObservers() // the pane lost its size
    expect(resize.mock.calls, 'nothing from a hidden pane').toEqual([])
    show(960, 600)
    await fireObservers() // shown, at the window's new size
    expect(resize.mock.calls).toEqual([['s-1', 120, 30]])
  })

  it('a view that takes over a running PTY, hidden before its first fit: no 80x24 reaches that PTY, and nothing spawns', async () => {
    H.spawned.add('s-1') // the session's PTY is running already (a remount)
    mount()
    await setUp()
    hide()
    await act(async () => { frame() })
    await fireObservers()
    show()
    await act(async () => { frame() })
    await fireObservers()
    expect(spawn).not.toHaveBeenCalled()
    expect(resize.mock.calls.filter((c) => c[1] === 80 && c[2] === 24), 'the running PTY is never resized to 80x24').toEqual([])
  })

  it('the wait for a size spends none of the renderer\'s frames: an active pane with no size, then its size, still waits for its WebGL renderer', async () => {
    mount()
    // Every frame inside one act, so React runs no effect meanwhile: the
    // pane is active and has no WebGL renderer until the act ends.
    await act(async () => {
      frame() // initTerminal, on a pane with a size
      H.rect.width = 0
      H.rect.height = 0
      await microtasks() // the fit frame is queued
      for (let i = 0; i < 40; i++) frame()
      H.rect.width = 824
      H.rect.height = 540
      frame() // a size now, but no renderer yet: put off a frame
    })
    expect(spawnedSizes(), 'not before the renderer').toEqual([])
    expect(H.MockWebgl.built).toBe(1)
    await act(async () => { frame() })
    expect(spawnedSizes()).toEqual([[103, 27]])
  })

  it('aicc_planning#423: main is told the tab is shown only once it is, once, just before it starts; never while it waits hidden', async () => {
    mount()
    await setUp()
    hide()
    for (let i = 0; i < 20; i++) await act(async () => { frame() })
    expect(shownTold, 'nothing while the pane has no size').toEqual([])
    show()
    await act(async () => { frame() })
    expect(shownTold).toEqual([{ id: 's-1', spawnsBefore: 0 }])
    expect(spawnedSizes()).toEqual([[103, 27]])
    hide()
    show()
    for (let i = 0; i < 3; i++) await act(async () => { frame() })
    expect(shownTold, 'not again for a tab that started').toHaveLength(1)
  })

  it('aicc_planning#423: a view that takes over a running PTY (a remount) tells main nothing', async () => {
    H.spawned.add('s-1')
    mount()
    await setUp()
    await act(async () => { frame() })
    expect(shownTold).toEqual([])
  })

  it('a view torn down while it waits for a size leaves no frame behind and spawns nothing', async () => {
    mount()
    await setUp()
    hide()
    await act(async () => { frame() })
    act(() => { root.unmount() })
    frame()
    expect(rafQueue, 'no fit frame after teardown').toHaveLength(0)
    expect(spawn).not.toHaveBeenCalled()
    root = createRoot(container)
  })
})

/**
 * 2.1.3-beta.19 fix round, item RESTARTCANVAS (Rocky line, outside finding 2):
 * Restart pressed while the Agent Canvas pane was in front of the tab's
 * terminal started nothing until the terminal was shown again (pressed
 * 10:23:13.887Z; the start came 69 s later, 3 s after the terminal was
 * brought back). Measured cause: the Restart remounts the terminal view, and
 * the view builds its terminal and starts its PTY only once its pane has a
 * size; with a pane in front, App lays the terminal's pane out `display:
 * none`, so it has none (initTerminal waits a frame at a time, forever).
 *
 * Here App's pane is built as App builds it (terminal/coveredPane.ts), under a
 * layout that gives an element no size while it or a parent is `display:
 * none`, and the area's size otherwise. At the old head (no coveredPane) the
 * pane stays `display: none`, as App had it.
 */
describe('a Restart while another pane is in front of the terminal starts at once (2.1.3-beta.19 fix round)', () => {
  const AREA = { width: 824, height: 540 }
  /** The module by a path built at run time, so this file still loads where it is absent (the old head). */
  const COVERED_PANE = ['..', '..', '..', 'src', 'renderer', 'components', 'terminal', 'coveredPane'].join('/')
  const loadCoveredPane = (): Promise<typeof import('../../../src/renderer/components/terminal/coveredPane')> => import(/* @vite-ignore */ COVERED_PANE)
  /** A layout: no size inside anything `display: none`, the area's size otherwise. */
  function laidOut(this: Element): DOMRect {
    for (let el: Element | null = this; el; el = el.parentElement) {
      if ((el as HTMLElement).style?.display === 'none') return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() { return {} } } as DOMRect
    }
    return { ...AREA, top: 0, left: 0, right: AREA.width, bottom: AREA.height, x: 0, y: 0, toJSON() { return {} } } as DOMRect
  }

  type CoveredPane = typeof import('../../../src/renderer/components/terminal/coveredPane')
  /** App's session pane with the Agent Canvas open: its terminal's pane, then the canvas. */
  function SessionWithCanvas({ covered, id }: { covered: CoveredPane | null; id: string }): React.ReactElement {
    const waiting = covered ? covered.useTerminalSizeWaitStore((s) => s.waiting[id] === true) : false
    const style: React.CSSProperties = covered ? covered.terminalPaneStyle({ shown: false, startsBehind: waiting }) : { display: 'none', minHeight: 0 }
    return React.createElement('div', { style: waiting ? { position: 'relative' } : {} },
      React.createElement('div', { 'data-testid': 'terminal-pane', style },
        React.createElement(TerminalView as any, { sessionId: id, cwd: 'C:/proj', isActive: false, shellOnly: true })),
      React.createElement('div', { 'data-testid': 'canvas-pane' }, 'the Agent Canvas'))
  }
  const shellRecord = (id: string) => ({ id, label: 'shell', workingDirectory: 'C:/proj', color: '#89b4fa', sessionType: 'local', provider: 'claude', shellOnly: true })
  const twelveFrames = async () => {
    for (let i = 0; i < 12; i++) {
      await act(async () => { frame(); await microtasks() })
    }
  }

  it('the canvas in front, a terminal never shown: the remounted view starts at once at its pane\'s size, behind the canvas, which stays in front; then its pane is hidden again', async () => {
    const covered = await loadCoveredPane().catch(() => null)
    const real = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = laidOut
    try {
      // An id no other test showed: no size on screen is known for it.
      H.sessionState.sessions = [shellRecord('s-never-shown')]
      act(() => { root.render(React.createElement(SessionWithCanvas, { covered, id: 's-never-shown' })) })
      await twelveFrames()
      // Started, at the pane's own size (the DOM renderer's cell: 93 columns in 824 px), not 80x24.
      expect(spawnedSizes()).toEqual([[93, 27]])
      // The canvas is still in front, and the terminal's pane is hidden again once it started.
      const pane = container.querySelector('[data-testid="terminal-pane"]') as HTMLElement
      expect(pane.style.display).toBe('none')
      expect(container.querySelector('[data-testid="canvas-pane"]')).not.toBeNull()
    } finally {
      Element.prototype.getBoundingClientRect = real
    }
  })

  /**
   * Second pass (RESTARTCANVAS): the view behind the canvas is not active, so
   * it has no WebGL renderer and fits on the DOM renderer's cell, 93 columns
   * where the shown terminal fits 103. It starts at the size it last had on
   * screen, so it is not resized when it is shown again.
   */
  it('a terminal last shown at 103x27, restarted behind the canvas: it starts at 103x27, the size it is shown at again, not the DOM renderer\'s 93 columns', async () => {
    const covered = await loadCoveredPane().catch(() => null)
    const real = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = laidOut
    try {
      H.sessionState.sessions = [shellRecord('s-shown')]
      // On screen first, with its WebGL renderer: started at 103x27.
      act(() => {
        root.render(React.createElement('div', { key: 'shown' },
          React.createElement(TerminalView as any, { sessionId: 's-shown', cwd: 'C:/proj', isActive: true, shellOnly: true })))
      })
      await twelveFrames()
      expect(spawnedSizes()).toEqual([[103, 27]])
      // Restart with the canvas in front: its PTY ends (the tracker forgets
      // it) and the view is mounted again, behind the canvas.
      H.spawned.delete('s-shown')
      spawn.mockClear()
      resize.mockClear()
      act(() => { root.render(React.createElement(SessionWithCanvas, { key: 'restarted', covered, id: 's-shown' })) })
      await twelveFrames()
      expect(H.webglLoaded, 'the view behind the canvas draws on the DOM renderer').toBe(false)
      expect(spawnedSizes()).toEqual([[103, 27]])
      expect(resize.mock.calls, 'no other size reaches main').toEqual([])
      const pane = container.querySelector('[data-testid="terminal-pane"]') as HTMLElement
      expect(pane.style.display).toBe('none')
    } finally {
      Element.prototype.getBoundingClientRect = real
    }
  })

  it('while it waits behind the canvas its pane is laid out at the area\'s size but invisible, and takes no pointer', async () => {
    const { terminalPaneStyle } = await loadCoveredPane()
    expect(terminalPaneStyle({ shown: true, startsBehind: false })).toEqual({ display: 'flex', minHeight: 0 })
    expect(terminalPaneStyle({ shown: false, startsBehind: false })).toEqual({ display: 'none', minHeight: 0 })
    expect(terminalPaneStyle({ shown: false, startsBehind: true })).toEqual({ display: 'flex', minHeight: 0, position: 'absolute', inset: 0, visibility: 'hidden', pointerEvents: 'none' })
  })

  it('App builds both terminal panes with it: the main one behind a pane in front, the partner one only when it is the view that pane covers', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const app = readFileSync(join(process.cwd(), 'src/renderer/App.tsx'), 'utf8')
    expect(app).toContain("const mainStartsBehind = altPaneShowing && !isShowingPartner && sizeWaits[session.id] === true")
    expect(app).toContain("const partnerStartsBehind = altPaneShowing && isShowingPartner && sizeWaits[partnerPtyId] === true")
    expect(app).toContain('style={terminalPaneStyle({ shown: !isShowingPartner && !altPaneShowing, startsBehind: mainStartsBehind })}')
    expect(app).toContain('style={terminalPaneStyle({ shown: isShowingPartner && !altPaneShowing, startsBehind: partnerStartsBehind })}')
  })
})
