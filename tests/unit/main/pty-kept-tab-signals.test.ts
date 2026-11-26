/**
 * aicc_planning#423 (beta.17 B1c): what the renderer says of its restored tabs
 * reaches the session helper through the REAL pty handlers: the tabs Resume
 * restored (pty:tabsRestored; B1d, each with a local agent tab's folder, a
 * bounded string), a tab shown and starting now (pty:tabShown),
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
  it('the tabs Resume restored reach the helper as they are, each with its folder when it has one (B1d)', () => {
    restored(fromApp, [{ id: TAB, cwd: 'C:\\Users\\someone\\project' }, { id: OTHER }])
    expect(told).toEqual([['restored', [{ id: TAB, cwd: 'C:\\Users\\someone\\project' }, { id: OTHER }]]])
  })

  it('2.1.3-beta.19: a restored SSH Persistent tab with no mark names its config (tmuxConfigId); the helper\'s kept launches get the id and folder only', () => {
    restored(fromApp, [{ id: TAB, tmuxConfigId: 'cfg0123abc' }, { id: OTHER, cwd: 'C:\\x' }])
    expect(told).toEqual([['restored', [{ id: TAB }, { id: OTHER, cwd: 'C:\\x' }]]])
  })

  it('a folder at the bound (4096 characters) reads', () => {
    restored(fromApp, [{ id: TAB, cwd: 'C'.repeat(4096) }])
    expect(told).toEqual([['restored', [{ id: TAB, cwd: 'C'.repeat(4096) }]]])
  })

  it('a tab shown reaches the helper', () => {
    shown(fromApp, TAB)
    expect(told).toEqual([['shown', TAB]])
  })

  it('another sender, or a subframe of the app\'s window: nothing reaches the helper', () => {
    restored(fromElsewhere, [{ id: TAB, cwd: 'C:\\x' }])
    shown(fromElsewhere, TAB)
    restored(fromSubframe, [{ id: TAB, cwd: 'C:\\x' }])
    shown(fromSubframe, TAB)
    expect(told).toEqual([])
  })

  it.each([
    ['not a list', { id: TAB }],
    ['a list of bare ids (the earlier payload)', [TAB, OTHER]],
    ['a list with an id that is not a tab id', [{ id: TAB }, { id: '../x' }]],
    ['a list with a non-string id', [{ id: TAB }, { id: 7 }]],
    ['a list with a folder that is not a string', [{ id: TAB, cwd: 7 }]],
    ['a list with an empty folder', [{ id: TAB, cwd: '' }]],
    ['a list with a folder longer than 4096 characters', [{ id: TAB, cwd: 'C'.repeat(4097) }]],
    ['a list with a field it does not name', [{ id: TAB, cwd: 'C:\\x', root: 'C:\\' }]],
    ['a list with a config id outside the config id pattern', [{ id: TAB, tmuxConfigId: '../cfg' }]],
    ['a list with a config id that is not a string', [{ id: TAB, tmuxConfigId: 7 }]],
    ['a list longer than any app makes', Array.from({ length: 1001 }, () => ({ id: TAB }))],
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
