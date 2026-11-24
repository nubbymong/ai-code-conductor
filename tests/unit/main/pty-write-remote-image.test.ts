/**
 * The renderer's write door, `pty:write` (plan 2.1.3-beta.17, section A2,
 * plan-review finding 6; aicc_planning#411): for a tab through the session
 * helper, the app's own image request is asked about WHOLE, before writePty
 * cuts a write longer than 256 bytes into slices, so a slice can never split
 * the tool's name and let the rest of the line (its Enter included) reach the
 * CLI. A write the remote module holds back never reaches writePty; every
 * other write reaches it unchanged. The kill door (a close or a Restart)
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
const holdBackRemoteImage = vi.fn((_id: string, _data: string) => false)
const helperTab = vi.fn((_id: string) => false)
vi.mock('../../../src/main/remote-helper', () => ({
  isRemoteHelperTab: (id: string) => helperTab(id),
  holdBackRemoteImage: (id: string, data: string) => holdBackRemoteImage(id, data),
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
  holdBackRemoteImage.mockClear()
})

describe('pty:write and a tab through the session helper', () => {
  it('asks the remote module about the whole write first; one it holds back never reaches writePty', () => {
    expect(write).toBeTypeOf('function')
    holdBackRemoteImage.mockImplementationOnce(() => true)
    write({}, 'tab-remote', LONG)
    expect(holdBackRemoteImage).toHaveBeenCalledWith('tab-remote', LONG)
    expect(writePty).not.toHaveBeenCalled()
  })

  it('every other write reaches writePty whole and unchanged', () => {
    write({}, 'tab-any', LONG)
    expect(holdBackRemoteImage).toHaveBeenCalledWith('tab-any', LONG)
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
