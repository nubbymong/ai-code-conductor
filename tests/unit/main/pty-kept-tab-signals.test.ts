/**
 * aicc_planning#423 (beta.17 B1c): what the renderer says of its restored tabs
 * reaches the session helper through the REAL pty handlers: the tabs Resume
 * restored (pty:tabsRestored), a tab shown and starting now (pty:tabShown),
 * and a tab closed (pty:kill with no reason). A session an update kept for a
 * restored tab not on screen waits for that tab with no time limit until it
 * is shown, and a close ends it at once (session-helper-take-over.test.ts
 * holds the manager to that). A Restart's kill is not a close: its tab starts
 * again and takes the session over. Only the app's own window is heard, and a
 * payload that does not read is dropped.
 *
 * The manager is a recorder behind the seam (kept-launches.ts
 * setKeptTabSignals); pty-manager is faked as pty-spawn-restart-pending.test.ts
 * fakes it. Nothing spawns.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  BrowserWindow: class {},
}))
const killed: Array<[string, unknown]> = []
// Only what these handlers reach; nothing here starts a launch.
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: vi.fn(), writePty: vi.fn(), resizePty: vi.fn(),
  killPty: (id: string, opts: unknown) => { killed.push([id, opts]) },
  getSshFlow: () => undefined, endSshRemote: vi.fn(),
  beginSpawnPreparation: () => ({ current: true, spawn: vi.fn(), abandon: vi.fn() }),
  isSessionWritable: () => false,
  isSessionLiveOrStarting: () => false,
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/hooks')>()),
  getGateway: () => null,
  isExactBindSourceActive: () => true,
}))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => null }))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
const { setKeptTabSignals } = await import('../../../src/main/sessions/kept-launches')

/** The app's window as trusted-sender.ts reads it: its web contents and main frame. */
const mainFrame = { name: 'the app window main frame' }
const webContents = { mainFrame, send: vi.fn() }
const appWindow = { isDestroyed: () => false, webContents }
registerPtyHandlers(() => appWindow as never)
const fromApp = { sender: webContents, senderFrame: mainFrame }
const fromElsewhere = { sender: { mainFrame: {} }, senderFrame: {} }
const fromSubframe = { sender: webContents, senderFrame: { name: 'a subframe' } }

const told: Array<[string, unknown]> = []
const kill = handlers.get('pty:kill')!
const restored = handlers.get('pty:tabsRestored')!
const shown = handlers.get('pty:tabShown')!

const TAB = 'abcdef0123456789abcdee11'
const OTHER = 'abcdef0123456789abcdee12'

beforeEach(() => {
  told.length = 0
  killed.length = 0
  setKeptTabSignals({
    restored: (ids) => { told.push(['restored', [...ids]]) },
    shown: (id) => { told.push(['shown', id]) },
    closed: (id) => { told.push(['closed', id]) },
  })
})
afterAll(() => setKeptTabSignals(null))

describe('pty:kill: a close ends the session kept for the tab; a Restart does not', () => {
  it('a close (no reason): the PTY is killed as before, and the helper is told the tab closed', () => {
    kill({}, TAB)
    expect(killed).toEqual([[TAB, { reason: 'close' }]])
    expect(told).toEqual([['closed', TAB]])
  })

  it('a Restart\'s kill: killed as a Restart, and nothing is said of a close (its tab starts again and takes the session over)', () => {
    kill({}, TAB, 'restart')
    expect(killed).toEqual([[TAB, { reason: 'restart' }]])
    expect(told).toEqual([])
  })
})

describe('pty:tabsRestored and pty:tabShown: from the app\'s window only, and only a payload that reads', () => {
  it('the tabs Resume restored reach the helper as they are', () => {
    restored(fromApp, [TAB, OTHER])
    expect(told).toEqual([['restored', [TAB, OTHER]]])
  })

  it('a tab shown reaches the helper', () => {
    shown(fromApp, TAB)
    expect(told).toEqual([['shown', TAB]])
  })

  it('another sender, or a subframe of the app\'s window: nothing reaches the helper', () => {
    restored(fromElsewhere, [TAB])
    shown(fromElsewhere, TAB)
    restored(fromSubframe, [TAB])
    shown(fromSubframe, TAB)
    expect(told).toEqual([])
  })

  it.each([
    ['not a list', TAB],
    ['a list with a value that is not a tab id', [TAB, '../x']],
    ['a list with a non-string', [TAB, 7]],
    ['a list longer than any app makes', Array.from({ length: 1001 }, () => TAB)],
  ])('pty:tabsRestored with %s: dropped', (_what, payload) => {
    restored(fromApp, payload)
    expect(told).toEqual([])
  })

  it.each([
    ['not a string', [TAB]],
    ['an empty id', ''],
    ['an id with a path in it', '..\\x'],
  ])('pty:tabShown with %s: dropped', (_what, payload) => {
    shown(fromApp, payload)
    expect(told).toEqual([])
  })
})
