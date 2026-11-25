// @vitest-environment jsdom
/**
 * aicc_planning#421 (beta.17 C10): the Live (scroll to bottom) button shows
 * after any scroll that leaves the view above the bottom, not only after a
 * wheel event TerminalView hears. xterm 6 stops each wheel event it moves the
 * view with (terminal-live-button-xterm.test.ts measures it on the app's
 * xterm), so TerminalView's wheel listener heard a wheel only at the top or
 * the bottom; onScroll, which every scroll fires, only took the button away.
 * Now a view left above the bottom is checked once it has settled (80 ms, the
 * wheel's check), so a move that passes through during a write or a resize
 * shows nothing, and at the bottom nothing is armed.
 *
 * aicc_planning#422: TerminalView wires keepLineSelection
 * (terminal/lineSelectionKeep.ts, under test in terminal-line-selection.test.ts)
 * to the terminal it opens.
 *
 * Harness: terminalview-console-repaint.test.tsx's mocks; the terminal's
 * onScroll listeners are kept so a test can move its view.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const H = vi.hoisted(() => {
  class MockTerminal {
    static last: any = null
    options: any
    cols = 80
    rows = 24
    element: HTMLElement | null = null
    written: string[] = []
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, length: 0, cursorY: 0, getLine: (_y: number) => undefined } }
    focus = () => {}
    scrollToBottom = () => {}
    constructor(opts?: any) { this.options = { ...(opts ?? {}) }; MockTerminal.last = this }
    open(el: HTMLElement) { this.element = el }
    loadAddon() {}
    onData() { return { dispose() {} } }
    scrollListeners: Array<() => void> = []
    onScroll(cb: () => void) { this.scrollListeners.push(cb); return { dispose() {} } }
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    registerLinkProvider() { return { dispose() {} } }
    refresh() {}
    paste() {}
    clearSelection() {}
    getSelection() { return '' }
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
    write(data: string, cb?: () => void) { this.written.push(data); cb?.() }
    writeln(data: string) { this.written.push(`${data}\r\n`) }
    dispose() {}
  }
  const sessionState: any = { sessions: [] as any[], activeSessionId: 's-1', updateSession: () => {} }
  /** What happened, in order: the aligner's calls and the PTY resizes. */
  const log: string[] = []
  const aligners: Array<{ term: unknown; written: string[]; asIs: boolean[] }> = []
  const fit = { cols: 103, rows: 27 }
  return { MockTerminal, sessionState, log, aligners, fit, kept: [] as Array<{ term: unknown; opened: boolean }>, spawned: new Set<string>(), tokens: new Map<string, number>(), counter: { last: 0 } }
})

vi.mock('../../../src/renderer/components/terminal/consoleRepaint', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/renderer/components/terminal/consoleRepaint')>()
  return {
    ...real,
    createConsoleRepaintAligner: (term: unknown) => {
      const a = { term, written: [] as string[], asIs: [] as boolean[] }
      H.aligners.push(a)
      return {
        noteResize: () => { H.log.push('noteResize') },
        write: (data: string, parsed?: () => void, asIs?: boolean) => { a.written.push(data); a.asIs.push(!!asIs); parsed?.() },
      }
    },
  }
})
vi.mock('@xterm/xterm/css/xterm.css', () => ({ default: {} }))
vi.mock('@xterm/xterm', () => ({ Terminal: H.MockTerminal }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      const t = H.MockTerminal.last
      if (!t) return
      t.cols = H.fit.cols
      t.rows = H.fit.rows
    }
    proposeDimensions() { return { cols: H.fit.cols, rows: H.fit.rows } }
  },
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() { return { dispose() {} } } clearTextureAtlas() {} dispose() {} } }))
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
    gpuRenderingEnabled: () => false,
  }
})
vi.mock('../../../src/renderer/stores/pasteHintStore', () => {
  const st = { show: () => {} }
  return { usePasteHintStore: Object.assign((sel: any) => sel(st), { getState: () => st }) }
})
vi.mock('../../../src/renderer/utils/inputDiagnostics', () => ({ installInputDiagnostics: () => () => {}, describeBytes: () => '' }))
vi.mock('../../../src/renderer/components/terminal', async () => {
  const R = await import('react')
  return { ScrollToBottomButton: (p: { onClick: () => void }) => R.createElement('button', { title: 'Scroll to bottom', onClick: p.onClick }) }
})
vi.mock('../../../src/renderer/components/terminal/lineSelectionKeep', () => ({
  keepLineSelection: (term: any) => { H.kept.push({ term, opened: !!term.element }); return { dispose() {} } },
}))
vi.mock('../../../src/renderer/hooks/useStatuslineSubscription', () => ({ useStatuslineSubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useEffortSubscription', () => ({ useEffortSubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useWatchdogSubscription', () => ({ useWatchdogSubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useAccountIdentitySubscription', () => ({ useAccountIdentitySubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useActiveTabEffect', () => ({ useActiveTabEffect: () => {} }))
vi.mock('../../../src/renderer/hooks/useCursorLayerVisibility', () => ({ useCursorLayerVisibility: () => {} }))

/** The PTY output listener TerminalView registers, per session, and its
 *  listener for a replay at the holder's size (C8). */
const dataListeners = new Map<string, (data: string) => void>()
const replayListeners = new Map<string, (notice: unknown) => void>()
const spawn = vi.fn((_id: string, _opts: Record<string, unknown>) => Promise.resolve({ started: true }))
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: {
    write: vi.fn(),
    resize: vi.fn((_id: string, c: number, r: number) => { H.log.push(`resize ${c}x${r}`) }),
    spawn,
    onData: vi.fn((id: string, cb: (data: string) => void) => { dataListeners.set(id, cb); return () => { dataListeners.delete(id) } }),
    onReplayAtHolderSize: vi.fn((id: string, cb: (notice: unknown) => void) => { replayListeners.set(id, cb); return () => { replayListeners.delete(id) } }),
    onExit: vi.fn(() => () => {}),
  },
  ptyIntegrity: { report: vi.fn() },
  inputDebug: { enabled: vi.fn(async () => false), log: vi.fn() },
  clipboard: { readText: vi.fn(async () => '') },
  ssh: { onSessionInfo: vi.fn(() => () => {}), onFlowState: vi.fn(() => () => {}) },
}

Element.prototype.getBoundingClientRect = function () {
  return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON() { return {} } } as DOMRect
}
/** The pane's ResizeObserver callbacks, so a test can say the pane changed size. */
const observers: Array<() => void> = []
class RO { constructor(cb: () => void) { observers.push(cb) } observe() {} unobserve() {} disconnect() {} }
;(globalThis as any).ResizeObserver = RO
;(window as any).ResizeObserver = RO
Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), load: () => Promise.resolve([]), check: () => true }, configurable: true })

let rafQueue: FrameRequestCallback[] = []
const installRaf = () => {
  const req = (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length }
  ;(window as any).requestAnimationFrame = req
  ;(globalThis as any).requestAnimationFrame = req
  ;(window as any).cancelAnimationFrame = () => {}
  ;(globalThis as any).cancelAnimationFrame = () => {}
}
const frame = () => { const q = rafQueue; rafQueue = []; q.forEach((cb) => cb(0)) }
const microtasks = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }

const { default: TerminalView } = await import('../../../src/renderer/components/TerminalView')

let container: HTMLDivElement
let root: Root

const mountShell = async () => {
  H.sessionState.sessions = [{ id: 's-1', label: 'shell', workingDirectory: 'C:/proj', color: '#89b4fa', sessionType: 'local', provider: 'claude', shellOnly: true }]
  act(() => { root.render(React.createElement(TerminalView as any, { sessionId: 's-1', cwd: 'C:/proj', isActive: true, shellOnly: true })) })
  await act(async () => {
    frame() // initTerminal: the terminal, its aligner and its output listener
    await microtasks()
    frame() // fitAndSpawn
    await microtasks()
  })
}
beforeEach(() => {
  rafQueue = []
  installRaf()
  spawn.mockClear()
  H.spawned.clear()
  H.tokens.clear()
  H.log.length = 0
  H.aligners.length = 0
  H.kept.length = 0
  H.fit.cols = 103
  H.fit.rows = 27
  H.MockTerminal.last = null
  observers.length = 0
  dataListeners.clear()
  replayListeners.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const term = () => H.MockTerminal.last
/** Moves the stand-in terminal's view and fires its onScroll, as xterm does. */
const scrollTo = (viewportY: number, baseY: number) => act(() => {
  term().buffer.active.viewportY = viewportY
  term().buffer.active.baseY = baseY
  for (const cb of term().scrollListeners) cb()
})
const live = () => container.querySelector('button[title="Scroll to bottom"]')

describe('the Live button after a scroll TerminalView hears no wheel for (aicc_planning#421)', () => {
  it('a view moved above the bottom (a wheel xterm stopped, the scroll bar, the keyboard): shown once it has settled', async () => {
    ;(window as any).electronPlatform = 'win32'
    await mountShell()
    scrollTo(12, 20)
    expect(live(), 'not before it has settled').toBeNull()
    await act(async () => { await sleep(120) })
    expect(live()).not.toBeNull()
  })

  it('a view that passes above the bottom and back within the settle time (a write, a resize): never shown', async () => {
    ;(window as any).electronPlatform = 'win32'
    await mountShell()
    scrollTo(12, 20)
    expect(live(), 'not at once').toBeNull()
    scrollTo(20, 20)
    await act(async () => { await sleep(120) })
    expect(live()).toBeNull()
  })

  it('at the bottom (output following), onScroll arms nothing', async () => {
    ;(window as any).electronPlatform = 'win32'
    await mountShell()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      for (let i = 0; i < 50; i++) scrollTo(20 + i, 20 + i)
      expect(timers.mock.calls.filter((c) => c[1] === 80)).toHaveLength(0)
    } finally { timers.mockRestore() }
    await act(async () => { await sleep(120) })
    expect(live()).toBeNull()
  })

  it('shown by a wheel TerminalView hears (at the top), then back at the bottom: taken away at once', async () => {
    ;(window as any).electronPlatform = 'win32'
    await mountShell()
    term().buffer.active.viewportY = 0
    term().buffer.active.baseY = 20
    act(() => { term().element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })) })
    await act(async () => { await sleep(120) })
    expect(live()).not.toBeNull()
    scrollTo(20, 20)
    expect(live()).toBeNull()
  })
})

describe("a triple-click's line across a change of the columns (aicc_planning#422)", () => {
  it('TerminalView wires keepLineSelection to the terminal it opened', async () => {
    ;(window as any).electronPlatform = 'win32'
    await mountShell()
    expect(H.kept).toHaveLength(1)
    expect(H.kept[0].term).toBe(term())
    expect(H.kept[0].opened, 'after term.open').toBe(true)
  })
})
