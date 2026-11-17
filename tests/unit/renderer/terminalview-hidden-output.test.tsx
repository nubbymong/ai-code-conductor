// @vitest-environment jsdom
/**
 * aicc_planning#303: a terminal that is not on screen takes its PTY output in
 * batches, one write per HIDDEN_OUTPUT_FLUSH_MS; the one on screen writes
 * every chunk at once. hidden-output-queue.test.ts pins the queue; this file
 * mounts the REAL TerminalView (xterm and IPC mocked, after
 * terminalview-account-launch.test.tsx) and pins the wiring: the visible
 * terminal, the batch, the flush when the tab is shown, the order before the
 * lines the app writes itself (exit, spawn end, launch failure), the flush
 * before the resume nudge, a screen read, and the unmount.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type LogEntry = [string, ...unknown[]]

const H = vi.hoisted(() => {
  /** Every write to a terminal, every scroll to the bottom and every PTY
   *  resize, in the order they happened. */
  const log: LogEntry[] = []
  class MockTerminal {
    static last: any = null
    options: any
    cols = 80
    rows = 24
    element: HTMLElement | null = null
    disposed = false
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, length: 0, cursorY: 0, getLine: (_y: number) => undefined } }
    focus = () => {}
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
    scrollToBottom() { log.push([this.disposed ? 'scroll-after-dispose' : 'scroll']) }
    write(s: unknown) { log.push([this.disposed ? 'write-after-dispose' : 'write', s]) }
    writeln(s: string) { log.push([this.disposed ? 'writeln-after-dispose' : 'writeln', s]) }
    dispose() { this.disposed = true }
  }
  const sessionState: any = {
    sessions: [] as any[],
    activeSessionId: 's-1',
    updateSession: () => {},
  }
  const spawned = new Set<string>()
  const tokens = new Map<string, number>()
  const counter = { last: 0 }
  return { MockTerminal, sessionState, spawned, tokens, counter, log }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({ default: {} }))
vi.mock('@xterm/xterm', () => ({ Terminal: H.MockTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } } }))
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

// pty:spawn calls are deferreds the test settles; pty:exit and the output go
// to whichever view is listening now.
type Settle = { resolve: (v?: unknown) => void; reject: (e: unknown) => void }
const settles: Settle[] = []
const spawn = vi.fn((_id: string, _opts: Record<string, unknown>) => new Promise((resolve, reject) => { settles.push({ resolve, reject }) }))
let fireExit: ((code: number) => void) | null = null
let sendData: ((data: string) => void) | null = null
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: {
    write: vi.fn(),
    resize: vi.fn((_id: string, c: number, r: number) => { H.log.push(['resize', c, r]) }),
    spawn,
    onData: vi.fn((_id: string, cb: (data: string) => void) => { sendData = cb; return () => { if (sendData === cb) sendData = null } }),
    onExit: vi.fn((_id: string, cb: (code: number) => void) => { fireExit = cb; return () => { if (fireExit === cb) fireExit = null } }),
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
if (!(document as any).fonts) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), load: () => Promise.resolve([]), check: () => true }, configurable: true })
}

let rafQueue: FrameRequestCallback[] = []
const installRaf = () => {
  const req = (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length }
  ;(window as any).requestAnimationFrame = req
  ;(globalThis as any).requestAnimationFrame = req
  ;(window as any).cancelAnimationFrame = () => {}
  ;(globalThis as any).cancelAnimationFrame = () => {}
}
const flushRaf = () => { const q = rafQueue; rafQueue = []; q.forEach((cb) => cb(0)) }

const { default: TerminalView } = await import('../../../src/renderer/components/TerminalView')
// The flush interval (HIDDEN_OUTPUT_FLUSH_MS, pinned in hidden-output-queue.test.ts).
const HIDDEN_OUTPUT_FLUSH_MS = 1000
const { readSessionScreen } = await import('../../../src/renderer/components/terminal/screenRegistry')
const { reportSpawnEnd, forgetSpawnEnd } = await import('../../../src/renderer/utils/spawnEndNotice')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { useLaunchAckStore } = await import('../../../src/renderer/stores/launchAckStore')
const { useAccountGateStore } = await import('../../../src/renderer/stores/accountGateStore')
const { snapshot } = await import('./accounts-snapshot-harness')

let container: HTMLDivElement
let root: Root

const claudeSession = (over: Record<string, unknown> = {}) => (
  { id: 's-1', label: 'api-server', workingDirectory: 'C:/proj', color: '#89b4fa', sessionType: 'local', provider: 'claude', model: '', ...over }
)

const render = (isActive: boolean) => {
  act(() => {
    root.render(React.createElement(TerminalView as any, { key: 'a', sessionId: 's-1', cwd: 'C:/proj', isActive, provider: 'claude' }))
  })
}
/** Drain frames and microtasks until the view has done what it will. */
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => { flushRaf(); await Promise.resolve(); await Promise.resolve() })
}
/** Mount the view of s-1. `running`: onto a PTY that is already running (no
 *  spawn); otherwise this view spawns it (the spawn is left pending). Fake
 *  timers from here on, so each test drives the flush interval. */
const mount = async (opts: { isActive: boolean; running?: boolean; session?: Record<string, unknown> }) => {
  H.sessionState.sessions = [opts.session ?? claudeSession()]
  if (opts.running ?? true) H.spawned.add('s-1')
  render(opts.isActive)
  await settle()
  expect(sendData, 'the view listens for the PTY output').not.toBeNull()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  H.log.length = 0
}
const send = (data: string) => act(() => { sendData!(data) })
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })
const writes = () => H.log.filter((e) => e[0] === 'write').map((e) => e[1])
/** The log without scrolls: the writes, lines and resizes, in order. */
const order = () => H.log.filter((e) => e[0] !== 'scroll')

beforeEach(() => {
  rafQueue = []
  installRaf()
  spawn.mockClear()
  settles.length = 0
  fireExit = null
  sendData = null
  H.log.length = 0
  H.spawned.clear()
  H.tokens.clear()
  forgetSpawnEnd('s-1')
  H.MockTerminal.last = null
  useProviderAccountsStore.setState({ snapshot: snapshot(), loaded: true })
  useLaunchAckStore.setState({ queue: [] })
  useAccountGateStore.setState({ queue: [], predetermined: [], restored: [] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  vi.useRealTimers()
  container.remove()
})

describe('TerminalView output while on screen and while hidden (aicc_planning#303)', () => {
  it('the visible terminal writes every chunk at once', async () => {
    await mount({ isActive: true })
    send('a')
    send('b')
    expect(writes()).toEqual(['a', 'b'])
  })

  it('a hidden terminal writes its output as one batch per interval, in order', async () => {
    await mount({ isActive: false })
    send('a'); send('b'); send('c')
    expect(writes()).toEqual([])
    advance(HIDDEN_OUTPUT_FLUSH_MS - 1)
    expect(writes()).toEqual([])
    advance(1)
    expect(writes()).toEqual(['abc'])
    send('d')
    advance(HIDDEN_OUTPUT_FLUSH_MS)
    expect(writes()).toEqual(['abc', 'd'])
  })

  it('the follow decision is taken once per batch: at the bottom it scrolls once, not once per chunk', async () => {
    await mount({ isActive: false })
    send('a'); send('b'); send('c')
    advance(HIDDEN_OUTPUT_FLUSH_MS)
    expect(H.log).toEqual([['write', 'abc'], ['scroll']])
  })

  it('a hidden terminal scrolled up stays where it is after a batch', async () => {
    await mount({ isActive: false })
    const buf = H.MockTerminal.last.buffer.active
    buf.baseY = 40
    buf.viewportY = 10
    send('a'); send('b')
    advance(HIDDEN_OUTPUT_FLUSH_MS)
    expect(H.log).toEqual([['write', 'ab']])
  })

  it('shown again: what was queued is written at once, before the interval ends', async () => {
    await mount({ isActive: false })
    send('x'); send('y')
    expect(writes()).toEqual([])
    render(true)
    expect(writes()).toEqual(['xy'])
    send('z')
    expect(writes()).toEqual(['xy', 'z'])
    advance(HIDDEN_OUTPUT_FLUSH_MS)
    expect(writes()).toEqual(['xy', 'z'])
  })

  it('hidden again after being shown: batched again', async () => {
    await mount({ isActive: true })
    send('a')
    render(false)
    send('b'); send('c')
    expect(writes()).toEqual(['a'])
    advance(HIDDEN_OUTPUT_FLUSH_MS)
    expect(writes()).toEqual(['a', 'bc'])
  })
})

describe('the lines the app writes itself come after the queued output (aicc_planning#303)', () => {
  it('a session that exits while hidden: its last output, then the exit line, nothing after', async () => {
    await mount({ isActive: false })
    send('last '); send('words')
    act(() => { fireExit!(0) })
    expect(order()).toEqual([['write', 'last words'], ['writeln', '\r\n\x1b[90m[Process exited with code 0]\x1b[0m']])
    advance(HIDDEN_OUTPUT_FLUSH_MS)
    expect(order()).toHaveLength(2)
  })

  it('a start that ended elsewhere (spawn end notice): the queued output, then its line', async () => {
    await mount({ isActive: false })
    send('queued')
    act(() => { reportSpawnEnd('s-1', 'ended with nothing started') })
    expect(order()).toEqual([['write', 'queued'], ['writeln', 'ended with nothing started']])
  })

  it('a launch that fails: anything queued, then the failure line', async () => {
    await mount({ isActive: false, running: false })
    expect(spawn).toHaveBeenCalledTimes(1)
    send('stray')
    await act(async () => { settles[0].reject(new Error('Claude Code CLI not found on PATH')) })
    const o = order()
    expect(o[0]).toEqual(['write', 'stray'])
    expect(o[1][0]).toBe('writeln')
    expect(String(o[1][1])).toContain('Failed to launch session')
  })

  it('the resume nudge: the replay queued so far is written before the PTY is resized', async () => {
    await mount({ isActive: false, running: false, session: claudeSession({ resumeUuid: '0b9c3c62-2f0a-4c55-9a64-4b1f1d1a1e7f', resumeCwd: 'C:/proj' }) })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][1].resume).toBeDefined()
    await act(async () => { settles[0].resolve({ started: true }) })
    H.log.length = 0
    send('replay one '); send('replay two')
    // The nudge fires once a burst has been quiet for 600 ms: before the
    // hidden terminal's own flush.
    advance(600)
    const o = order()
    const shrink = o.findIndex((e) => e[0] === 'resize' && e[2] === 23)
    expect(shrink).toBeGreaterThan(-1)
    expect(o.slice(0, shrink)).toEqual([['write', 'replay one replay two']])
  })
})

describe('a screen read and the unmount (aicc_planning#303)', () => {
  it('a read of a hidden terminal with output queued writes it and answers no screen; the next read answers', async () => {
    await mount({ isActive: false })
    send('busy')
    expect(readSessionScreen('s-1')).toBeNull()
    expect(writes()).toEqual(['busy'])
    const next = readSessionScreen('s-1')
    expect(next).not.toBeNull()
    expect(next).toHaveLength(24)
  })

  it('after a read the hidden terminal writes each chunk at once, so the reads that follow are current', async () => {
    await mount({ isActive: false })
    expect(readSessionScreen('s-1')).not.toBeNull()
    send('a')
    expect(writes()).toEqual(['a'])
    expect(readSessionScreen('s-1')).not.toBeNull()
  })

  it('unmounted while hidden: the queued output goes with the terminal, and no timer writes later', async () => {
    await mount({ isActive: false })
    send('never shown')
    act(() => { root.unmount() })
    root = createRoot(container)
    advance(HIDDEN_OUTPUT_FLUSH_MS * 2)
    expect(H.log.filter((e) => String(e[0]).endsWith('after-dispose'))).toEqual([])
    expect(writes()).toEqual([])
  })
})
