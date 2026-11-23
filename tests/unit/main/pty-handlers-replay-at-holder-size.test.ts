/**
 * 2.1.3-beta.14, plan section C8 (aicc_planning#392): the PTY handlers give
 * the session helper's terminals the way a restored tab is told its replay is
 * at its holder's size: on the tab's own channel, to the app's window (the one
 * every spawn is given), answering whether it went. No window, or one already
 * destroyed: nothing is sent, and the answer is false, so the terminal waits
 * for no fit (helper-pty.ts).
 *
 * The real registerPtyHandlers on a fake ipcMain, with pty-manager, the logs,
 * the configs and the start-up ssh lookup mocked; helper-pty's setter is
 * caught, the rest of it real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const H = vi.hoisted(() => ({ notice: undefined as undefined | ((sessionId: string, notice: unknown) => boolean) }))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
  app: { getPath: () => '' },
}))
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: vi.fn(), writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(),
  endSshRemote: vi.fn(), probeTmuxLive: vi.fn(),
}))
vi.mock('../../../src/main/ssh-program', () => ({ startSshProgramLookup: vi.fn() }))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn() }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
vi.mock('../../../src/main/session-helper/helper-pty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/session-helper/helper-pty')>()),
  setReplayAtHolderSizeNotice: (notice: (sessionId: string, notice: unknown) => boolean) => { H.notice = notice },
}))

const send = vi.fn()
let destroyed = false
let win: unknown = { isDestroyed: () => destroyed, webContents: { send } }

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
registerPtyHandlers(() => win as never)

beforeEach(() => {
  send.mockClear()
  destroyed = false
  win = { isDestroyed: () => destroyed, webContents: { send } }
})

describe("a restored tab told its replay is at its holder's size (aicc_planning#392)", () => {
  it("goes on the tab's own channel to the app's window, as it is, and answers that it went", () => {
    expect(H.notice).toBeTypeOf('function')
    const at = { cols: 103, rows: 27, length: 9 }
    expect(H.notice!('s-1', at)).toBe(true)
    expect(send.mock.calls).toEqual([['pty:replayAtHolderSize:s-1', at]])
  })

  it('no window, or one destroyed: nothing is sent, and the answer is false', () => {
    destroyed = true
    expect(H.notice!('s-1', { cols: 103, rows: 27, length: 9 })).toBe(false)
    win = null
    expect(H.notice!('s-1', { cols: 103, rows: 27, length: 9 })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})
