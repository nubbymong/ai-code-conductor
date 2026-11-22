// @vitest-environment jsdom
/**
 * 2.1.3-beta.14, plan section C8 (aicc_planning#392): a restored terminal
 * whose tab did not reach its holder's size is told, on its own channel, the
 * holder's size and the length of its next chunk, its replay. The view writes
 * that chunk with its terminal at the holder's size, and once xterm has parsed
 * it, fits the terminal to the tab and gives main the tab's size, even when it
 * is the size last sent: main sends the holder nothing until it hears it. No
 * other fit runs and no size goes to main while the replay is being written.
 * A chunk of another length is written as it comes, and spends the notice.
 *
 * The terminal is a mock that records its resizes and writes in order and
 * keeps each write's parse callback until the test runs it (xterm parses on a
 * later task). The fit gives the tab's size, 93x27. Harness:
 * terminalview-renderer-wait.test.tsx's mocks.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const H = vi.hoisted(() => {
  /** In order: the terminal's resizes, writes and fits, and each size given to main. */
  const calls: string[] = []
  /** Each write's parse callback, until the test runs it. */
  const parsed: Array<() => void> = []
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
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; calls.push(`resize ${cols}x${rows}`) }
    write(data: string, cb?: () => void) { calls.push(`write ${data}`); if (cb) parsed.push(cb) }
    writeln() {}
    dispose() {}
  }
  const sessionState: any = { sessions: [] as any[], activeSessionId: 's-1', updateSession: () => {} }
  const spawned = new Set<string>()
  const tokens = new Map<string, number>()
  const counter = { last: 0 }
  /** Each channel's callback the view subscribed, by name. */
  const subs: { data?: (d: string) => void; replayAt?: (n: unknown) => void; ro?: () => void } = {}
  return { MockTerminal, calls, parsed, sessionState, spawned, tokens, counter, subs }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({ default: {} }))
vi.mock('@xterm/xterm', () => ({ Terminal: H.MockTerminal }))
// The tab's size: 93 by 27.
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      const t = H.MockTerminal.last
      if (!t) return
      if (t.cols !== 93 || t.rows !== 27) H.calls.push('fit 93x27')
      t.cols = 93
      t.rows = 27
    }
    proposeDimensions() { return { cols: 93, rows: 27 } }
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

const spawn = vi.fn((_id: string, _opts: Record<string, unknown>) => Promise.resolve({ started: true }))
const ptyResize = vi.fn((_id: string, cols: number, rows: number) => { H.calls.push(`size to main ${cols}x${rows}`) })
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: {
    write: vi.fn(),
    resize: ptyResize,
    spawn,
    onData: vi.fn((_id: string, cb: (d: string) => void) => { H.subs.data = cb; return () => { H.subs.data = undefined } }),
    onExit: vi.fn(() => () => {}),
    onReplayAtHolderSize: vi.fn((_id: string, cb: (n: unknown) => void) => { H.subs.replayAt = cb; return () => { H.subs.replayAt = undefined } }),
  },
  inputDebug: { enabled: vi.fn(async () => false), log: vi.fn() },
  clipboard: { readText: vi.fn(async () => '') },
  ssh: { onSessionInfo: vi.fn(() => () => {}), onFlowState: vi.fn(() => () => {}) },
}

Element.prototype.getBoundingClientRect = function () {
  return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON() { return {} } } as DOMRect
}
/** The view's resize observer: the test fires it (a window resize). */
class RO { constructor(cb: () => void) { H.subs.ro = cb } observe() {} unobserve() {} disconnect() {} }
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

/** The view mounted and spawned at the tab's 93x27; the calls so far cleared. */
const mounted = async (isActive = true) => {
  H.sessionState.activeSessionId = isActive ? 's-1' : 'other'
  H.sessionState.sessions = [{ id: 's-1', label: 'shell', workingDirectory: 'C:/proj', color: '#89b4fa', sessionType: 'local', provider: 'claude', shellOnly: true }]
  act(() => { root.render(React.createElement(TerminalView as any, { sessionId: 's-1', cwd: 'C:/proj', isActive, shellOnly: true })) })
  await act(async () => {
    frame() // initTerminal
    await microtasks()
    frame() // fitAndSpawn
  })
  expect(spawn.mock.calls.map((c) => [c[1].cols, c[1].rows])).toEqual([[93, 27]])
  H.calls.length = 0
  ptyResize.mockClear()
}
const REPLAY = '\x18\x1b[0m\x1b[26;1H[Earlier output of this terminal is no longer held, so it is not shown.]\r\nline 1\r\n'
const notice = (n: unknown) => act(() => { H.subs.replayAt!(n) })
const chunk = (d: string) => act(() => { H.subs.data!(d) })
/** xterm parses every write handed to it so far. */
const parseAll = () => act(() => { for (const cb of H.parsed.splice(0)) cb() })
/** A window resize: the observer, then its 80 ms debounce. */
const windowResized = async () => {
  H.subs.ro!()
  await act(async () => { await new Promise((r) => setTimeout(r, 120)) })
}

beforeEach(() => {
  rafQueue = []
  installRaf()
  spawn.mockClear()
  ptyResize.mockClear()
  H.calls.length = 0
  H.parsed.length = 0
  H.spawned.clear()
  H.tokens.clear()
  H.MockTerminal.last = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe("a restored terminal's replay at its holder's size (aicc_planning#392)", () => {
  it("the next chunk of the notice's length: written with the terminal at 103x27, then, once parsed, fitted to the tab's 93x27 and that size given to main, though it is the size last sent", async () => {
    await mounted()
    notice({ cols: 103, rows: 27, length: REPLAY.length })
    chunk(REPLAY)
    expect(H.calls).toEqual(['resize 103x27', `write ${REPLAY}`])
    parseAll()
    expect(H.calls).toEqual(['resize 103x27', `write ${REPLAY}`, 'fit 93x27', 'size to main 93x27'])
    expect(ptyResize).toHaveBeenCalledTimes(1)
  })

  it('a window resize while the replay is being written runs no fit and sends main no size; the fit after the parse does both', async () => {
    await mounted()
    notice({ cols: 103, rows: 27, length: REPLAY.length })
    chunk(REPLAY)
    await windowResized()
    expect(H.calls).toEqual(['resize 103x27', `write ${REPLAY}`])
    expect(ptyResize).not.toHaveBeenCalled()
    parseAll()
    expect(H.calls.slice(2)).toEqual(['fit 93x27', 'size to main 93x27'])
    // Afterwards a window resize fits as before (here to the same size: nothing sent).
    await windowResized()
    expect(ptyResize).toHaveBeenCalledTimes(1)
  })

  it('output after the replay is written after it, and only the replay is written at the holder\'s size', async () => {
    await mounted()
    notice({ cols: 103, rows: 27, length: REPLAY.length })
    chunk(REPLAY)
    chunk('PS> ')
    expect(H.calls).toEqual(['resize 103x27', `write ${REPLAY}`, 'write PS> '])
    parseAll()
    expect(H.calls.slice(3)).toEqual(['fit 93x27', 'size to main 93x27'])
  })

  it('a chunk of another length is written as it comes, and spends the notice: a later chunk of that length is not taken for the replay', async () => {
    await mounted()
    notice({ cols: 103, rows: 27, length: REPLAY.length })
    chunk('x')
    chunk(REPLAY)
    parseAll()
    expect(H.calls).toEqual(['write x', `write ${REPLAY}`])
    expect(ptyResize).not.toHaveBeenCalled()
  })

  it('a notice that does not read (a size out of range, not whole numbers) is none', async () => {
    await mounted()
    for (const bad of [{ cols: 0, rows: 27, length: REPLAY.length }, { cols: 103, rows: 1001, length: REPLAY.length }, { cols: '103', rows: 27, length: REPLAY.length }, null]) {
      notice(bad)
      chunk(REPLAY)
    }
    parseAll()
    expect(H.calls.filter((c) => c.startsWith('resize') || c.startsWith('fit'))).toEqual([])
    expect(ptyResize).not.toHaveBeenCalled()
  })

  it('a hidden terminal: what it queued is written first, then the replay at the holder\'s size at once, not queued', async () => {
    await mounted(false)
    chunk('queued before\r\n')
    expect(H.calls).toEqual([])
    notice({ cols: 103, rows: 27, length: REPLAY.length })
    chunk(REPLAY)
    expect(H.calls).toEqual(['write queued before\r\n', 'resize 103x27', `write ${REPLAY}`])
    parseAll()
    expect(H.calls.slice(3)).toEqual(['fit 93x27', 'size to main 93x27'])
  })

  it('a view torn down before the replay is parsed fits nothing and sends main no size', async () => {
    await mounted()
    notice({ cols: 103, rows: 27, length: REPLAY.length })
    chunk(REPLAY)
    act(() => { root.unmount() })
    root = createRoot(container)
    parseAll()
    expect(H.calls).toEqual(['resize 103x27', `write ${REPLAY}`])
    expect(ptyResize).not.toHaveBeenCalled()
    expect(H.subs.replayAt, 'unsubscribed with the view').toBeUndefined()
  })
})
