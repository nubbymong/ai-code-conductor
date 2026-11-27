// @vitest-environment jsdom
/**
 * 2.1.3-beta.19 section 1.2: the two lines that carry a tab's mark between
 * main and the renderer, through the REAL TerminalView (xterm and IPC mocked;
 * the harness of terminalview-account-launch.test.tsx):
 *
 *  - a flow-state push with `kept` (main: this tab's session is kept by the
 *    session helper on machine did until it is ended) marks the session and
 *    saves the set at once (markKeptByHelper);
 *  - a marked SSH session's spawn carries remoteVia 'helper', so main never
 *    starts it on the usual SSH path (tmux would start a second CLI beside the
 *    one its holder keeps); an unmarked one's, and a local one's, carry none.
 *
 * Each case is red with its TerminalView line taken out.
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
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, length: 0, cursorY: 0, getLine: (_y: number) => undefined } }
    lines: string[] = []
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
    // ED2 (erase the viewport), as xterm applies it: what was written goes.
    write(s: unknown) { if (typeof s === 'string' && s.includes('\x1b[2J')) this.lines = [] }
    writeln(s: string) { this.lines.push(s) }
    dispose() {}
  }
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
  const sessionState: any = {
    sessions: [] as any[],
    activeSessionId: 's-1',
    updateSession: (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }) },
  }
  const spawned = new Set<string>()
  // The spawn tokens ptyTracker hands out (markSpawned) and checks (isCurrentSpawn).
  const tokens = new Map<string, number>()
  const counter = { last: 0 }
  const cleared: string[] = []
  /** persistSessionProviderAccount calls: [sessionId, providerAccountId]. */
  const persisted: unknown[][] = []
  /** persistLastUsedAccount calls: [sessionId, profileId, options?]. */
  const lastUsed: unknown[][] = []
  return { MockTerminal, sessionState, updates, spawned, tokens, counter, cleared, persisted, lastUsed }
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
/** persistSessionState calls (markKeptByHelper saves at once). */
const saved = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../src/renderer/session-persistence', () => ({
  persistSessionState: () => { saved.count++; return Promise.resolve() },
  persistLastUsedAccount: (...a: unknown[]) => { H.lastUsed.push(a) },
  persistSessionProviderAccount: (...a: unknown[]) => { H.persisted.push(a); return Promise.resolve() },
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
  clearSpawned: (id: string) => { H.spawned.delete(id); H.tokens.delete(id); H.cleared.push(id) },
  killSessionPty: () => {},
}))
// A marker, so a test can see whether an SSH tab shows its flow card.
vi.mock('../../../src/renderer/components/SshFlowOverlay', async () => {
  const R = await import('react')
  return { default: () => R.createElement('div', { 'data-testid': 'ssh-flow-overlay' }) }
})
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

// pty:spawn calls are deferreds the test settles, one per call; pty:exit is a
// callback it fires at whichever view is listening now.
type Settle = { resolve: (v?: unknown) => void; reject: (e: unknown) => void }
const settles: Settle[] = []
const spawn = vi.fn((_id: string, _opts: Record<string, unknown>) => new Promise((resolve, reject) => { settles.push({ resolve, reject }) }))
/** The flow-state callback the view listening now gave main. */
let flowState: ((msg: { state: string; kept?: { did: string } }) => void) | null = null
let fireExit: ((code: number) => void) | null = null
/** The session's output, as main sends it to the view listening now. */
let sendData: ((data: string) => void) | null = null
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: {
    write: vi.fn(),
    resize: vi.fn(),
    spawn,
    onData: vi.fn((_id: string, cb: (data: string) => void) => { sendData = cb; return () => { if (sendData === cb) sendData = null } }),
    onExit: vi.fn((_id: string, cb: (code: number) => void) => { fireExit = cb; return () => { if (fireExit === cb) fireExit = null } }),
  },
  inputDebug: { enabled: vi.fn(async () => false), log: vi.fn() },
  clipboard: { readText: vi.fn(async () => '') },
  ssh: {
    onSessionInfo: vi.fn(() => () => {}),
    onFlowState: vi.fn((_id: string, cb: (msg: { state: string; kept?: { did: string } }) => void) => { flowState = cb; return () => { if (flowState === cb) flowState = null } }),
  },
}

Element.prototype.getBoundingClientRect = function () {
  return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON() { return {} } } as DOMRect
}
class RO { observe() {} unobserve() {} disconnect() {} }
;(globalThis as any).ResizeObserver = RO
;(window as any).ResizeObserver = RO
// The terminal font is already loaded (check() true), as it is for every
// terminal after the first, so the view starts on its first frame (#313: only
// a terminal built before its font has loaded waits for it; that wait is
// covered in terminalview-font-wait.test.tsx).
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

const { SSH_THROUGH_HELPER } = await import('../../../src/shared/remote-machines')

let container: HTMLDivElement
let root: Root

const DID = '0123456789abcdef0123456789abcdef'
const SSH = { host: 'pi.lan', port: 22, username: 'nick', remotePath: '~' }
const sshSession = (over: Record<string, unknown> = {}) => ({ id: 's-1', label: 'pi', workingDirectory: '~', color: '#89b4fa', sessionType: 'ssh', provider: 'claude', model: '', ...over })
const localSession = () => ({ id: 's-1', label: 'proj', workingDirectory: 'C:/proj', color: '#89b4fa', sessionType: 'local', provider: 'claude', model: '' })

const mount = (session: Record<string, unknown>, withSsh: boolean) => {
  H.sessionState.sessions = [session]
  act(() => {
    root.render(React.createElement(TerminalView as any, { key: 'a', sessionId: 's-1', cwd: withSsh ? '~' : 'C:/proj', isActive: true, provider: 'claude', ...(withSsh ? { ssh: SSH } : {}) }))
  })
}
/** Drain frames and microtasks until the view has done what it will. */
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => { flushRaf(); await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  rafQueue = []
  installRaf()
  spawn.mockClear()
  settles.length = 0
  flowState = null
  H.updates.length = 0
  H.spawned.clear()
  H.tokens.clear()
  saved.count = 0
  H.MockTerminal.last = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('the mark of a tab the session helper keeps, between main and the renderer (TerminalView)', () => {
  it('a marked SSH session\'s spawn carries remoteVia helper, so main never starts it on the usual SSH path', async () => {
    mount(sshSession({ remoteVia: 'helper', remoteDid: DID }), true)
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][1].remoteVia).toBe('helper')
  })

  it('an unmarked SSH session\'s spawn and a local session\'s carry none', async () => {
    mount(sshSession(), true)
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][1].remoteVia).toBeUndefined()
    act(() => { root.unmount() })
    root = createRoot(container)
    H.spawned.clear()
    spawn.mockClear()
    // A local session that somehow holds the mark: no SSH, so no mark is sent.
    mount({ ...localSession(), remoteVia: 'helper', remoteDid: DID }, false)
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][1].remoteVia).toBeUndefined()
  })

  it('a flow-state push naming the machine that keeps it marks the session (remoteVia, remoteDid) and saves at once', async () => {
    mount(sshSession(), true)
    await settle()
    expect(flowState).not.toBeNull()
    await act(async () => { flowState!({ state: SSH_THROUGH_HELPER, kept: { did: DID } }) })
    expect(H.updates).toContainEqual({ id: 's-1', patch: { remoteVia: 'helper', remoteDid: DID } })
    expect(saved.count).toBe(1)
  })

  it('a flow-state push with no kept machine marks nothing', async () => {
    mount(sshSession(), true)
    await settle()
    await act(async () => { flowState!({ state: SSH_THROUGH_HELPER }) })
    expect(H.updates.some((u) => 'remoteVia' in u.patch)).toBe(false)
    expect(saved.count).toBe(0)
  })
})
