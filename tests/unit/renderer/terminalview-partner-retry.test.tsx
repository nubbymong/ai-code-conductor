// @vitest-environment jsdom
/**
 * #86: the partner shell of an SSH session connects to the host, so its pane
 * carries the SSH overlay, whose "Couldn't reach the host" Retry restarts the
 * session (useRestartSession). The partner has no session record of its own
 * (its PTY id is `<session id>-partner`), so the Retry did nothing there. It
 * now restarts the partner, and only the partner, of the session it belongs to:
 * useRestartSession's partner branch, as the command bar's Restart does in the
 * partner view. A session's own pane is unchanged.
 *
 * Mounts the REAL TerminalView with the harness of
 * terminalview-integrity-generation.test.tsx (xterm and IPC mocked).
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
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, length: 0, cursorY: 0 } }
    constructor(opts?: any) {
      this.options = { ...(opts ?? {}) }
      MockTerminal.last = this
    }
    focus() {}
    scrollToBottom() {}
    open(el: HTMLElement) { this.element = el }
    loadAddon() {}
    onData() { return { dispose() {} } }
    onScroll() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    registerLinkProvider() { return { dispose() {} } }
    write() {}
    writeln() {}
    refresh() {}
    paste() {}
    clearSelection() {}
    getSelection() { return '' }
    dispose() {}
  }
  const sessionState = {
    sessions: [
      { id: 's-1', label: 'one', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', provider: 'claude', model: 'sonnet' },
      { id: 's-2', label: 'two', workingDirectory: '~', color: '#89b4fa', sessionType: 'ssh', provider: 'claude', model: 'sonnet', sshConfig: { host: 'build-box', port: 22, username: 'nick', remotePath: '~' } },
    ],
    activeSessionId: 's-1',
    updateSession: () => {},
  }
  return { MockTerminal, sessionState }
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
const restartCalls = vi.hoisted(() => [] as Array<{ session: any; isShowingPartner: unknown; restart: () => boolean }>)
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({
  useRestartSession: (session: any, isShowingPartner?: unknown) => {
    const restart = () => true
    restartCalls.push({ session, isShowingPartner, restart })
    return { restart, recover: () => {} }
  },
}))
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
const overlays = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('../../../src/renderer/components/SshFlowOverlay', () => ({ default: (p: Record<string, unknown>) => { overlays.push(p); return null } }))
vi.mock('../../../src/renderer/utils/resumePicker', () => ({ shouldUseResumePicker: () => false }))
vi.mock('../../../src/renderer/utils/sessionLaunch', () => ({ shouldGateAccountChoice: () => false, formatSpawnError: () => '' }))
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

type DataCb = (data: string) => void
const dataCbs: DataCb[] = []
const report = vi.fn()

// window.electronAPI: setup.ts installed a base; extend with what TerminalView touches.
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: {
    write: vi.fn(),
    resize: vi.fn(),
    spawn: vi.fn(async () => true),
    onData: vi.fn((_id: string, cb: DataCb) => { dataCbs.push(cb); return () => {} }),
    onExit: vi.fn(() => () => {}),
  },
  ptyIntegrity: { report },
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
if (!(document as any).fonts) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), load: () => Promise.resolve([]) }, configurable: true })
}

let rafQueue: FrameRequestCallback[] = []
let rafId = 0
const installRaf = () => {
  const req = (cb: FrameRequestCallback) => { rafQueue.push(cb); return ++rafId }
  const cancel = () => {}
  ;(window as any).requestAnimationFrame = req
  ;(globalThis as any).requestAnimationFrame = req
  ;(window as any).cancelAnimationFrame = cancel
  ;(globalThis as any).cancelAnimationFrame = cancel
}
const flushRaf = () => { const q = rafQueue; rafQueue = []; q.forEach((cb) => cb(0)) }

const { default: TerminalView } = await import('../../../src/renderer/components/TerminalView')

const SSH = { host: 'build-box', port: 22, username: 'nick', remotePath: '~', detachable: false }
let container: HTMLDivElement
let root: Root

const mount = async (props: Record<string, unknown>) => {
  act(() => { root.render(React.createElement(TerminalView as any, { isActive: true, ...props })) })
  for (let i = 0; i < 4; i++) await act(async () => { flushRaf(); await Promise.resolve() })
}

beforeEach(() => {
  rafQueue = []
  installRaf()
  restartCalls.length = 0
  overlays.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  H.MockTerminal.last = null
})

describe('the SSH overlay\'s Retry in a partner pane (#86)', () => {
  it('restarts the partner of the session it belongs to (the partner branch)', async () => {
    await mount({ sessionId: 's-2-partner', configId: 'cfg', shellOnly: true, ssh: SSH })
    const last = restartCalls[restartCalls.length - 1]
    expect(last.session?.id).toBe('s-2')
    expect(last.isShowingPartner).toBe(true)
    const overlay = overlays[overlays.length - 1]
    expect(overlay).toBeTruthy()
    expect(overlay.onRetry).toBe(last.restart)
  })

  it('a session\'s own pane restarts the session, as before (not the partner branch)', async () => {
    await mount({ sessionId: 's-2', configId: 'cfg', ssh: SSH })
    const last = restartCalls[restartCalls.length - 1]
    expect(last.session?.id).toBe('s-2')
    expect(last.isShowingPartner ?? false).toBe(false) // the hook's default: the session's own restart
    expect(overlays[overlays.length - 1].onRetry).toBe(last.restart)
  })

  // A LOCAL partner has no SSH overlay, so it has no use for its session's
  // record, and subscribing to it would re-render the pane on every statusline
  // tick of the session. Mutation to prove this can fail: look
  // up the parent for every partner id again, ssh or not.
  it('a local partner (no ssh) does not look up the session it belongs to', async () => {
    await mount({ sessionId: 's-1-partner', configId: 'cfg', shellOnly: true })
    const last = restartCalls[restartCalls.length - 1]
    expect(last.session).toBeUndefined()
    expect(last.isShowingPartner).toBe(false)
  })

  it('a partner id whose session is gone has nothing to restart', async () => {
    await mount({ sessionId: 'gone-partner', configId: 'cfg', shellOnly: true, ssh: SSH })
    const last = restartCalls[restartCalls.length - 1]
    expect(last.session).toBeUndefined()
  })
})
