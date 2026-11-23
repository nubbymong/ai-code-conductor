// @vitest-environment jsdom
/**
 * aicc_planning#394: on Windows, TerminalView puts a terminal's output through
 * the console repaint aligner (terminal/consoleRepaint.ts) and tells it each
 * size it sends to the PTY, so the console's paint after a resize is written
 * where the terminal holds its lines. Only for a terminal on the console built
 * into Windows: a local Codex session runs on the console host the app ships,
 * and macOS and Linux have no console at all; their output is written straight
 * into the terminal, as before.
 *
 * The aligner itself is under test in console-repaint-after-resize.test.ts;
 * here it is a stand-in that records what it is given, with the real rule of
 * which terminals it applies to. Harness: terminalview-renderer-wait.test.tsx's
 * mocks.
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
    onScroll() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    registerLinkProvider() { return { dispose() {} } }
    refresh() {}
    paste() {}
    clearSelection() {}
    getSelection() { return '' }
    write(data: string, cb?: () => void) { this.written.push(data); cb?.() }
    writeln(data: string) { this.written.push(`${data}\r\n`) }
    dispose() {}
  }
  const sessionState: any = { sessions: [] as any[], activeSessionId: 's-1', updateSession: () => {} }
  /** What happened, in order: the aligner's calls and the PTY resizes. */
  const log: string[] = []
  const aligners: Array<{ term: unknown; written: string[] }> = []
  const fit = { cols: 103, rows: 27 }
  return { MockTerminal, sessionState, log, aligners, fit, spawned: new Set<string>(), tokens: new Map<string, number>(), counter: { last: 0 } }
})

vi.mock('../../../src/renderer/components/terminal/consoleRepaint', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/renderer/components/terminal/consoleRepaint')>()
  return {
    ...real,
    createConsoleRepaintAligner: (term: unknown) => {
      const a = { term, written: [] as string[] }
      H.aligners.push(a)
      return {
        noteResize: () => { H.log.push('noteResize') },
        write: (data: string, parsed?: () => void) => { a.written.push(data); parsed?.() },
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
vi.mock('../../../src/renderer/components/terminal', () => ({ ScrollToBottomButton: () => null }))
vi.mock('../../../src/renderer/hooks/useStatuslineSubscription', () => ({ useStatuslineSubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useEffortSubscription', () => ({ useEffortSubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useWatchdogSubscription', () => ({ useWatchdogSubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useAccountIdentitySubscription', () => ({ useAccountIdentitySubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useActiveTabEffect', () => ({ useActiveTabEffect: () => {} }))
vi.mock('../../../src/renderer/hooks/useCursorLayerVisibility', () => ({ useCursorLayerVisibility: () => {} }))

/** The PTY output listener TerminalView registers, per session. */
const dataListeners = new Map<string, (data: string) => void>()
const spawn = vi.fn((_id: string, _opts: Record<string, unknown>) => Promise.resolve({ started: true }))
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: {
    write: vi.fn(),
    resize: vi.fn((_id: string, c: number, r: number) => { H.log.push(`resize ${c}x${r}`) }),
    spawn,
    onData: vi.fn((id: string, cb: (data: string) => void) => { dataListeners.set(id, cb); return () => { dataListeners.delete(id) } }),
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
/** A Codex session's view, built only (its launch asks for accounts first). */
const buildCodex = async () => {
  H.sessionState.sessions = [{ id: 's-1', label: 'codex', workingDirectory: 'C:/proj', color: '#89b4fa', sessionType: 'local', provider: 'codex' }]
  act(() => { root.render(React.createElement(TerminalView as any, { sessionId: 's-1', cwd: 'C:/proj', isActive: true, provider: 'codex' })) })
  await act(async () => { frame() })
}
/** The pane changed size: the view's debounced fit and resize. */
const paneResized = async (cols: number, rows: number) => {
  H.fit.cols = cols
  H.fit.rows = rows
  await act(async () => {
    observers.forEach((cb) => cb())
    await new Promise((r) => setTimeout(r, 120))
  })
}
const output = (data: string) => act(() => { dataListeners.get('s-1')!(data) })

const PAINT = '\x1b[?25l\x1b[Hx\x1b[K\x1b[1;2H\x1b[?25h'

beforeEach(() => {
  rafQueue = []
  installRaf()
  spawn.mockClear()
  H.spawned.clear()
  H.tokens.clear()
  H.log.length = 0
  H.aligners.length = 0
  H.fit.cols = 103
  H.fit.rows = 27
  H.MockTerminal.last = null
  observers.length = 0
  dataListeners.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('TerminalView puts output through the console repaint aligner on Windows only (aicc_planning#394)', () => {
  it('Windows, a plain terminal: the aligner gets the terminal, each size sent to the PTY, and the output, which is not written past it', async () => {
    ;(window as any).electronPlatform = 'win32'
    await mountShell()
    expect(H.aligners).toHaveLength(1)
    expect(H.aligners[0].term).toBe(H.MockTerminal.last)
    await paneResized(140, 28)
    expect(H.log.slice(-2), 'the aligner is told before the size goes').toEqual(['noteResize', 'resize 140x28'])
    output(PAINT)
    expect(H.aligners[0].written).toContain(PAINT)
    expect(H.MockTerminal.last.written).not.toContain(PAINT)
  })

  it('Windows, a Codex session (the console host the app ships): no aligner, output written straight in', async () => {
    ;(window as any).electronPlatform = 'win32'
    await buildCodex()
    expect(H.aligners).toHaveLength(0)
    output(PAINT)
    expect(H.MockTerminal.last.written).toContain(PAINT)
  })

  it('macOS and Linux: no aligner, output written straight in', async () => {
    for (const platform of ['darwin', 'linux']) {
      ;(window as any).electronPlatform = platform
      await mountShell()
      expect(H.aligners, platform).toHaveLength(0)
      await paneResized(140, 28)
      expect(H.log, platform).not.toContain('noteResize')
      output(PAINT)
      expect(H.MockTerminal.last.written, platform).toContain(PAINT)
      act(() => { root.unmount() })
      root = createRoot(container)
      H.log.length = 0
      H.fit.cols = 103
      H.fit.rows = 27
    }
  })
})
