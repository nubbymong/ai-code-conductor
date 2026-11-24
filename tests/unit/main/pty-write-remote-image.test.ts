/**
 * The renderer's write door, `pty:write` (plan 2.1.3-beta.17, section A2,
 * plan-review finding 6; aicc_planning#411): for a tab through the session
 * helper, the app's own image request is asked about WHOLE, before writePty
 * cuts a write longer than 256 bytes into slices, so a slice can never split
 * the tool's name and let the rest of the line (its Enter included) reach the
 * CLI. A write the remote module holds back never reaches writePty; every
 * other write reaches it unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const on = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: (ch: string, fn: (...a: unknown[]) => unknown) => { on.set(ch, fn) } },
  BrowserWindow: class {},
}))
const writePty = vi.fn()
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: vi.fn(), writePty: (...a: unknown[]) => writePty(...a), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(),
  endSshRemote: vi.fn(), probeTmuxLive: vi.fn(),
}))
const holdBackRemoteImage = vi.fn((_id: string, _data: string) => false)
vi.mock('../../../src/main/remote-helper', () => ({
  isRemoteHelperTab: () => false,
  holdBackRemoteImage: (id: string, data: string) => holdBackRemoteImage(id, data),
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
