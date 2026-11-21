// @vitest-environment jsdom
/**
 * aicc_planning#374 (P1.1, plan 2.1.3-beta.13 section A1): a pane's first fit,
 * and so its PTY's size, waits for the pane's renderer. The WebGL addon is
 * attached by its own effect, which React runs after the terminal is built;
 * a fit that wins that race measures the DOM renderer's wider cell, so the
 * PTY starts at 93 columns where WebGL fits 103 (the beta.12 VM check). Here
 * the fit's width follows whether WebGL is loaded: 93 columns until the addon
 * is, 103 after. The real installWebglWithRecovery runs, with the addon class
 * under test control (it loads, or its constructor throws).
 *
 * The race is made by running the build frame and the fit frame inside one
 * act(): React keeps the effects of that act until it ends, so the fit runs
 * before the WebGL effect, as it can in the app. Before the fix the view
 * spawned on that frame at 93 columns.
 *
 * Guards that pass on the old view by design: GPU rendering off, and an
 * inactive pane, spawn on the first fit frame (no WebGL is attached there).
 * Harness: terminalview-account-launch.test.tsx's mocks.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const H = vi.hoisted(() => {
  /** The WebGL addon: its constructor throws when `throws` is set. */
  class MockWebgl {
    static throws = false
    static built = 0
    constructor() {
      if (MockWebgl.throws) throw new Error('no WebGL here')
      MockWebgl.built++
    }
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
  return { MockTerminal, MockWebgl, sessionState, spawned, tokens, counter, settings, webglLoaded: false }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({ default: {} }))
vi.mock('@xterm/xterm', () => ({ Terminal: H.MockTerminal }))
// The cell the fit measures: the DOM renderer's (93 columns) until the WebGL
// addon is loaded, WebGL's (103) after, as on the 1024x768 VM.
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      const t = H.MockTerminal.last
      if (!t) return
      t.cols = H.webglLoaded ? 103 : 93
      t.rows = 27
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
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: {
    write: vi.fn(),
    resize: vi.fn(),
    spawn,
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
  },
  inputDebug: { enabled: vi.fn(async () => false), log: vi.fn() },
  clipboard: { readText: vi.fn(async () => '') },
  ssh: { onSessionInfo: vi.fn(() => () => {}), onFlowState: vi.fn(() => () => {}) },
}

Element.prototype.getBoundingClientRect = function () {
  return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON() { return {} } } as DOMRect
}
class RO { observe() {} unobserve() {} disconnect() {} }
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

const mount = (isActive = true) => {
  H.sessionState.sessions = [{ id: 's-1', label: 'shell', workingDirectory: 'C:/proj', color: '#89b4fa', sessionType: 'local', provider: 'claude', shellOnly: true }]
  act(() => { root.render(React.createElement(TerminalView as any, { sessionId: 's-1', cwd: 'C:/proj', isActive, shellOnly: true })) })
}
/**
 * The build frame, then the fit frame, with React's effects held back until
 * both have run (one act): the race the VM lost. Answers how many frames the
 * fit was put off within it (each queues the next), none when it fitted.
 */
const buildAndFitBeforeEffects = async () => {
  await act(async () => {
    frame() // initTerminal: builds the terminal, setTerminalReady(true), asks for document.fonts.ready
    await microtasks() // fonts.ready settled: the fit frame is queued
    frame() // fitAndSpawn, before the WebGL effect has run
  })
}
const spawnedCols = () => spawn.mock.calls.map((c) => [c[1].cols, c[1].rows])

beforeEach(() => {
  rafQueue = []
  installRaf()
  spawn.mockClear()
  H.spawned.clear()
  H.tokens.clear()
  H.settings.gpu = true
  H.webglLoaded = false
  H.MockWebgl.throws = false
  H.MockWebgl.built = 0
  H.MockTerminal.last = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('the first fit waits for the pane\'s renderer (aicc_planning#374, P1.1)', () => {
  it('a fit frame that runs before the WebGL effect spawns nothing; the next frame, with WebGL loaded, spawns at WebGL\'s 103 columns', async () => {
    mount()
    await buildAndFitBeforeEffects()
    // The act ended: the WebGL effect has run now.
    expect(H.MockWebgl.built).toBe(1)
    expect(spawnedCols(), 'no spawn on the frame before the renderer').toEqual([])
    await act(async () => { frame() })
    expect(spawnedCols()).toEqual([[103, 27]])
  })

  it('GPU rendering off: no WebGL to wait for, so it spawns on the first fit frame, at the DOM renderer\'s size', async () => {
    H.settings.gpu = false
    mount()
    await buildAndFitBeforeEffects()
    expect(H.MockWebgl.built).toBe(0)
    expect(spawnedCols()).toEqual([[93, 27]])
  })

  it('an inactive pane: no WebGL is attached to it, so it spawns on the first fit frame', async () => {
    mount(false)
    await buildAndFitBeforeEffects()
    expect(H.MockWebgl.built).toBe(0)
    expect(spawnedCols()).toEqual([[93, 27]])
  })

  it('a WebGL constructor that throws still spawns: the effect leaves a handle on the DOM renderer, and the next frame fits and spawns', async () => {
    H.MockWebgl.throws = true
    mount()
    await buildAndFitBeforeEffects()
    expect(spawnedCols(), 'not before the effect has run').toEqual([])
    await act(async () => { frame() })
    expect(spawnedCols()).toEqual([[93, 27]])
  })

  it('an effect that never runs: the fit is put off 30 frames, then it fits and spawns as before', async () => {
    mount()
    // Every frame inside one act, so React runs no effect meanwhile (it runs
    // them when the act ends, after the spawn).
    let frames = 0
    let builtBySpawn = -1
    await act(async () => {
      frame() // initTerminal
      await microtasks()
      while (spawn.mock.calls.length === 0 && rafQueue.length > 0 && frames < 100) {
        frame()
        frames++
      }
      builtBySpawn = H.MockWebgl.built
    })
    expect(builtBySpawn, 'the effect had not run by the spawn').toBe(0)
    // 30 frames put off, the 31st fits.
    expect(frames).toBe(31)
    expect(spawnedCols()).toEqual([[93, 27]])
  })

  it('a view torn down while its fit waits leaves no frame behind and spawns nothing', async () => {
    mount()
    await act(async () => {
      frame()
      await microtasks()
      frame() // put off: the next fit frame is queued
    })
    expect(spawn).not.toHaveBeenCalled()
    act(() => { root.unmount() })
    frame()
    expect(rafQueue, 'no fit frame after teardown').toHaveLength(0)
    expect(spawn).not.toHaveBeenCalled()
    root = createRoot(container)
  })
})
