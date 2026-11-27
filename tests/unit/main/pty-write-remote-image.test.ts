/**
 * The renderer's write door, `pty:write` (plan 2.1.3-beta.17, section A2,
 * plan-review finding 6; aicc_planning#411). From 2.1.3-beta.18 (plan section
 * 3.2) a tab through the session helper has the image fetch tool, so the
 * app's own image request is no longer held back there: every write, that
 * one included, reaches writePty whole and unchanged. The kill door (a close or a Restart)
 * forgets a remote tab's start after killPty. The SSH flow door answers
 * 'through-helper' for a tab through the helper that has no SSH flow (also
 * after a start that failed), so the overlay's catch-up poll does not put the
 * 'Waiting for SSH login' card back over it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const on = new Map<string, (...a: unknown[]) => unknown>()
const handles = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handles.set(ch, fn) },
    on: (ch: string, fn: (...a: unknown[]) => unknown) => { on.set(ch, fn) },
  },
  BrowserWindow: class {},
}))
const writePty = vi.fn()
const order: string[] = []
const sshFlow = vi.fn((_id: string): { getState: () => unknown } | undefined => undefined)
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: vi.fn(), writePty: (...a: unknown[]) => writePty(...a), resizePty: vi.fn(), killPty: (id: string) => { order.push(`killPty ${id}`) },
  getSshFlow: (id: string) => sshFlow(id),
  endSshRemote: vi.fn(), probeTmuxLive: vi.fn(),
}))
const helperTab = vi.fn((_id: string) => false)
/** The machine that keeps a kept tab's session (2.1.3-beta.19 section 1.2), by app session id. */
const keptOn = new Map<string, string>()
// Since section 1.2 the SSH flow door asks remoteHelperFlowState (a kept tab's
// answer names its machine); stood in for here by the same rule.
vi.mock('../../../src/main/remote-helper', () => ({
  remoteHelperFlowState: (id: string) => {
    if (!helperTab(id)) return null
    const did = keptOn.get(id)
    return did ? { state: 'through-helper', kept: { did } } : { state: 'through-helper' }
  },
  forgetRemoteHelperTab: (id: string) => { order.push(`forget ${id}`) },
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn() }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => 'pw' }))
vi.mock('../../../src/main/session-state', () => ({ readDetachedRemotesRegistry: () => [] }))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
registerPtyHandlers(() => ({} as never))
const write = on.get('pty:write')!

const LONG = `${'x'.repeat(300)} (use mcp__conductor__fetch_host_screenshot with filename="a.png" to load the image from the Conductor host)\r`

beforeEach(() => {
  writePty.mockClear()
})

describe('pty:write and a tab through the session helper', () => {
  it('the app\'s own image request reaches writePty whole and unchanged, on a tab through the helper as on any other', () => {
    expect(write).toBeTypeOf('function')
    helperTab.mockImplementation(() => true)
    try {
      write({}, 'tab-remote', LONG)
      expect(writePty).toHaveBeenCalledTimes(1)
      expect(writePty).toHaveBeenCalledWith('tab-remote', LONG)
    } finally {
      helperTab.mockImplementation(() => false)
    }
  })

  it('every other write reaches writePty whole and unchanged', () => {
    write({}, 'tab-any', LONG)
    expect(writePty).toHaveBeenCalledTimes(1)
    expect(writePty).toHaveBeenCalledWith('tab-any', LONG)
    write({}, 'tab-any', 'ls\r')
    expect(writePty).toHaveBeenLastCalledWith('tab-any', 'ls\r')
  })
})

describe('pty:kill and a tab through the session helper', () => {
  it('a close or a Restart forgets the tab\'s start through the helper after killPty (a start that failed is over already, so killPty does not reach it)', () => {
    const kill = on.get('pty:kill')!
    order.length = 0
    kill({}, 'tab-remote', 'close')
    kill({}, 'tab-again', 'restart')
    expect(order).toEqual(['killPty tab-remote', 'forget tab-remote', 'killPty tab-again', 'forget tab-again'])
  })
})

describe('ssh:flow:getState and a tab through the session helper', () => {
  it('a tab through the helper with no SSH flow answers through-helper; any other tab with none answers connecting; a flow answers for itself', async () => {
    const getState = handles.get('ssh:flow:getState')!
    expect(getState).toBeTypeOf('function')
    try {
      helperTab.mockImplementation(() => true)
      sshFlow.mockImplementation(() => undefined)
      expect(await getState({}, 'tab-remote')).toEqual({ state: 'through-helper' })
      expect(helperTab).toHaveBeenCalledWith('tab-remote')
      // A kept tab's answer names the machine that keeps it (2.1.3-beta.19 section 1.2).
      keptOn.set('tab-kept', '0123456789abcdef0123456789abcdef')
      expect(await getState({}, 'tab-kept')).toEqual({ state: 'through-helper', kept: { did: '0123456789abcdef0123456789abcdef' } })
      keptOn.clear()
      helperTab.mockImplementation(() => false)
      expect(await getState({}, 'tab-usual')).toEqual({ state: 'connecting' })
      // A flow of its own wins, whatever the helper says.
      helperTab.mockImplementation(() => true)
      sshFlow.mockImplementation(() => ({ getState: () => ({ state: 'claude-running' }) }))
      expect(await getState({}, 'tab-flow')).toEqual({ state: 'claude-running' })
    } finally {
      helperTab.mockImplementation(() => false)
      sshFlow.mockImplementation(() => undefined)
    }
  })
})
