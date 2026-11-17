// @vitest-environment jsdom
/**
 * aicc_planning #313: TerminalView builds its terminal only once the terminal
 * font has loaded (capped), so xterm's cell measure and the WebGL glyph atlas
 * never see a stand-in face. jsdom has no fonts or canvas: document.fonts.load
 * is a controlled promise here, and the proof is when `new Terminal` runs.
 * Before the fix the terminal was built on the first animation frame, whatever
 * the font was doing. The cases for an already loaded face and for a page
 * without document.fonts.load guard that unchanged fast path, so they pass on
 * the old view by design. Harness: the terminalview-focus-handoff mocks.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const H = vi.hoisted(() => {
  class MockTerminal {
    static last: any = null
    static built = 0
    static fits = 0
    options: any
    cols = 80
    rows = 24
    element: HTMLElement | null = null
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, length: 0, cursorY: 0 } }
    focus: any
    scrollToBottom = () => {}
    constructor(opts?: any) {
      this.options = { ...(opts ?? {}) }
      const calls: unknown[] = []
      const f: any = () => { calls.push(1) }
      f.calls = calls
      f.mockClear = () => { calls.length = 0 }
      this.focus = f
      MockTerminal.last = this
      MockTerminal.built++
    }
    open(el: HTMLElement) { this.element = el }
    loadAddon() {}
    onData() { return { dispose() {} } }
    onScroll() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    registerLinkProvider() { return { dispose() {} } }
    refresh() {}
    paste() {}
    clearSelection() {}
    getSelection() { return '' }
    dispose() {}
  }
  const sessionState = {
    sessions: [
      { id: 's-1', label: 'one', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', provider: 'claude', model: 'sonnet' },
    ],
    activeSessionId: 's-1',
    updateSession: () => {},
  }
  // The terminal settings TerminalView reads (empty: every default).
  const settingsState: { settings: { terminal: Record<string, unknown> } } = { settings: { terminal: {} } }
  return { MockTerminal, sessionState, settingsState }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({ default: {} }))
vi.mock('@xterm/xterm', () => ({ Terminal: H.MockTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { H.MockTerminal.fits++ } proposeDimensions() { return { cols: 80, rows: 24 } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
vi.mock('../../../src/renderer/components/terminal/terminalWebgl', () => ({
  installWebglWithRecovery: () => ({ dispose() {}, clearTextureAtlas: () => false, isActive: () => false }),
  createAtlasResync: () => () => {},
}))
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
vi.mock('../../../src/renderer/session-persistence', () => ({ persistLastUsedAccount: () => {} }))
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => {
  const st = { profiles: [] }
  return { useAccountProfilesStore: Object.assign((sel: any) => sel(st), { getState: () => st }) }
})
vi.mock('../../../src/renderer/stores/accountGateStore', () => {
  const st = { pendingBySession: {}, open: () => {}, close: () => {} }
  return { useAccountGateStore: Object.assign((sel: any) => sel(st), { getState: () => st }), GATE_CANCELLED: 'cancelled' }
})
vi.mock('../../../src/renderer/stores/sshCloseStore', () => ({ forgetSessionBrowserProfile: () => {} }))
vi.mock('../../../src/renderer/ptyTracker', () => ({
  hasSpawned: () => true,
  markSpawned: () => {},
  clearSpawned: () => {},
  killSessionPty: () => {},
}))
vi.mock('../../../src/renderer/components/SshFlowOverlay', () => ({ default: () => null }))
vi.mock('../../../src/renderer/utils/resumePicker', () => ({ shouldUseResumePicker: () => false }))
vi.mock('../../../src/renderer/utils/sessionLaunch', () => ({ shouldGateAccountChoice: () => false, formatSpawnError: () => '' }))
vi.mock('../../../src/renderer/components/TerminalContextMenu', () => ({ default: () => null }))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const st = H.settingsState
  return {
    useSettingsStore: Object.assign((sel: any) => sel(st), { getState: () => st }),
    DEFAULT_TERMINAL_SETTINGS: {},
    gpuRenderingEnabled: () => false,
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

// window.electronAPI: setup.ts installed a base; extend with what TerminalView touches.
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: {
    write: vi.fn(),
    resize: vi.fn(),
    spawn: vi.fn(async () => true),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
  },
  inputDebug: { enabled: vi.fn(async () => false), log: vi.fn() },
  clipboard: { readText: vi.fn(async () => '') },
  ssh: { onSessionInfo: vi.fn(() => () => {}), onFlowState: vi.fn(() => () => {}) },
}


// jsdom gaps: no layout, so initTerminal would spin on a 0x0 container.
Element.prototype.getBoundingClientRect = function () {
  return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON() { return {} } } as DOMRect
}
class RO { observe() {} unobserve() {} disconnect() {} }
;(globalThis as any).ResizeObserver = RO
;(window as any).ResizeObserver = RO

// document.fonts under test control: each load() call is recorded and answers
// with whatever `nextLoad` makes (a deferred promise by default).
type Deferred = { promise: Promise<unknown>; resolve: (v?: unknown) => void; reject: (e?: unknown) => void }
const deferred = (): Deferred => {
  let resolve!: Deferred['resolve']
  let reject!: Deferred['reject']
  const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
let loadCalls: string[] = []
let pending: Deferred[] = []
let fontsImpl: any = null
const controlledFonts = () => ({
  ready: Promise.resolve(),
  load: (spec: string) => { loadCalls.push(spec); const d = deferred(); pending.push(d); return d.promise },
})
Object.defineProperty(document, 'fonts', { configurable: true, get: () => fontsImpl })

let rafQueue: FrameRequestCallback[] = []
const installRaf = () => {
  const req = (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length }
  ;(window as any).requestAnimationFrame = req
  ;(globalThis as any).requestAnimationFrame = req
  ;(window as any).cancelAnimationFrame = () => {}
  ;(globalThis as any).cancelAnimationFrame = () => {}
}
const flushRaf = () => { const q = rafQueue; rafQueue = []; q.forEach((cb) => cb(0)) }
/** Frames and microtasks, a few rounds: what a real mount gets in its first frames. */
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await act(async () => { flushRaf(); await Promise.resolve() })
}

const { default: TerminalView } = await import('../../../src/renderer/components/TerminalView')
const { TERMINAL_FONT_WAIT_CAP_MS, TERMINAL_FONT_FALLBACKS } = await import('../../../src/renderer/components/terminal/terminalFont')

let container: HTMLDivElement
let root: Root
const mount = () => act(() => { root.render(React.createElement(TerminalView as any, { sessionId: 's-1', isActive: true })) })
/** The face specs a built terminal draws, from the options it was given. */
const facesOf = (o: any) => [`${o.fontWeight} ${o.fontSize}px ${o.fontFamily}`, `${o.fontWeightBold} ${o.fontSize}px ${o.fontFamily}`]

beforeEach(() => {
  rafQueue = []
  loadCalls = []
  pending = []
  fontsImpl = controlledFonts()
  installRaf()
  H.settingsState.settings.terminal = {}
  H.MockTerminal.last = null
  H.MockTerminal.built = 0
  H.MockTerminal.fits = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
})

describe('TerminalView waits for the terminal font before building the terminal (#313)', () => {
  it('asks for the regular and bold faces it will draw, and builds nothing while they load', async () => {
    mount()
    await settle()
    expect(loadCalls).toEqual([`450 13px ${TERMINAL_FONT_FALLBACKS}`, `700 13px ${TERMINAL_FONT_FALLBACKS}`])
    expect(H.MockTerminal.built).toBe(0)
  })

  it('builds the terminal once the faces have loaded, with the very faces it waited for', async () => {
    mount()
    await settle()
    expect(H.MockTerminal.built).toBe(0)
    pending.forEach((d) => d.resolve([]))
    await settle()
    expect(H.MockTerminal.built).toBe(1)
    const o = H.MockTerminal.last.options
    expect(o.fontFamily).toBe(TERMINAL_FONT_FALLBACKS)
    // The size and both weights xterm (and so the atlas) draws are the ones
    // the wait loaded: one source, so a changed default cannot split them.
    expect(facesOf(o)).toEqual(loadCalls)
  })

  it('with a chosen family, size and weight, waits for those faces and builds with them', async () => {
    H.settingsState.settings.terminal = { fontFamily: 'Fira Code', fontSize: 15, fontWeight: 400 }
    mount()
    await settle()
    expect(loadCalls).toEqual([`400 15px 'Fira Code', ${TERMINAL_FONT_FALLBACKS}`, `700 15px 'Fira Code', ${TERMINAL_FONT_FALLBACKS}`])
    pending.forEach((d) => d.resolve([]))
    await settle()
    expect(H.MockTerminal.built).toBe(1)
    expect(facesOf(H.MockTerminal.last.options)).toEqual(loadCalls)
  })

  it('a load that fails still starts the terminal', async () => {
    mount()
    await settle()
    pending[0].reject(new Error('bad font'))
    await settle()
    expect(H.MockTerminal.built).toBe(1)
  })

  it('a load that never ends starts the terminal after the cap, not before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mount()
    await settle()
    vi.advanceTimersByTime(TERMINAL_FONT_WAIT_CAP_MS - 1)
    await settle()
    expect(H.MockTerminal.built).toBe(0)
    vi.advanceTimersByTime(1)
    await settle()
    expect(H.MockTerminal.built).toBe(1)
  })

  it('a load AND a document.fonts.ready that never end: built after one cap, fitted after the next (Copilot, PR 702)', async () => {
    // ready waits for every font the page is loading, so a stalled load keeps
    // it pending too. The fit and PTY start after initTerminal must not wait
    // on it for ever.
    fontsImpl = { ...controlledFonts(), ready: new Promise(() => {}) }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mount()
    await settle()
    vi.advanceTimersByTime(TERMINAL_FONT_WAIT_CAP_MS)
    await settle()
    expect(H.MockTerminal.built).toBe(1)
    expect(H.MockTerminal.fits).toBe(0)
    vi.advanceTimersByTime(TERMINAL_FONT_WAIT_CAP_MS - 1)
    await settle()
    expect(H.MockTerminal.fits).toBe(0)
    vi.advanceTimersByTime(1)
    await settle()
    expect(H.MockTerminal.fits).toBe(1)
  })

  it('a ready that settles fits on the next frame, without waiting for the cap', async () => {
    mount()
    await settle()
    pending.forEach((d) => d.resolve([]))
    await settle()
    expect(H.MockTerminal.built).toBe(1)
    expect(H.MockTerminal.fits).toBe(1)
  })

  it('a face that is already loaded starts the terminal on the first frame, with no load and no wait', async () => {
    fontsImpl = { ...controlledFonts(), check: (spec: string) => { loadCalls.push('check ' + spec); return true } }
    mount()
    expect(rafQueue).toHaveLength(1) // queued during the mount itself, as before #313
    await act(async () => { flushRaf() })
    expect(H.MockTerminal.built).toBe(1)
    expect(loadCalls.every((c) => c.startsWith('check '))).toBe(true)
  })

  it('a face that is not loaded yet (check false) waits for it', async () => {
    fontsImpl = { ...controlledFonts(), check: () => false }
    mount()
    await settle()
    expect(H.MockTerminal.built).toBe(0)
    pending.forEach((d) => d.resolve([]))
    await settle()
    expect(H.MockTerminal.built).toBe(1)
  })

  it('without document.fonts.load the terminal is built on the first frame, as before', async () => {
    // Guards the unchanged fast path at the view (the branch itself is pinned
    // in terminal-font.test.ts, terminalFontReady).
    fontsImpl = { ready: Promise.resolve() }
    mount()
    expect(rafQueue).toHaveLength(1) // queued during the mount itself, as before #313
    await act(async () => { flushRaf() })
    expect(H.MockTerminal.built).toBe(1)
  })

  it('a view torn down while it waits cancels the wait: neither the font nor the cap queues a frame after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mount()
    await settle()
    expect(H.MockTerminal.built).toBe(0)
    act(() => { root.unmount() })
    flushRaf()
    expect(rafQueue).toHaveLength(0)
    pending.forEach((d) => d.resolve([]))
    vi.advanceTimersByTime(TERMINAL_FONT_WAIT_CAP_MS)
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(rafQueue, 'no initTerminal frame after teardown').toHaveLength(0)
    expect(H.MockTerminal.built).toBe(0)
    root = createRoot(container)
  })

  it('a view torn down before its first fit cancels the capped fonts.ready wait: no fit frame after', async () => {
    fontsImpl = { ...controlledFonts(), ready: new Promise(() => {}), check: () => true }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mount()
    await act(async () => { flushRaf() })
    expect(H.MockTerminal.built).toBe(1)
    act(() => { root.unmount() })
    flushRaf()
    expect(rafQueue).toHaveLength(0)
    vi.advanceTimersByTime(TERMINAL_FONT_WAIT_CAP_MS)
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(rafQueue, 'no fitAndSpawn frame after teardown').toHaveLength(0)
    expect(H.MockTerminal.fits).toBe(0)
    root = createRoot(container)
  })
})
