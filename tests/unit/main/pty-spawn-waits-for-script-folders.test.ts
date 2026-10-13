/**
 * While the start's check of the resources folder's scripts folders, and the
 * deploys into them, still run (script-folders.ts), pty:spawn holds a local
 * Claude Code or Codex launch as a prepared spawn and starts it only once
 * they have run (or the wait's bound passed), so a tab restored at start gets
 * its status line, resume list and hooks; a close of the tab while it waits
 * starts nothing. A launch over SSH and a terminal-only one are not held by
 * this, and nothing is held once the start's check has run. A local Codex
 * launch waits for its hook folders only once this wait is over, so that
 * wait's own bound covers the hook folders alone.
 *
 * Driven through the REAL pty:spawn and pty:kill handlers on a fake ipcMain;
 * the scripts folders' pending/wait pair is answered here (held on a gate the
 * test opens), pty-manager is faked (a Set of session ids with a PTY, one
 * of spawns it is still preparing, as pty-manager's preparations behave), and
 * so is a Codex launch's account (the accounts service's preparation), so
 * nothing spawns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  BrowserWindow: class {},
  app: { getVersion: () => '0.0.0-test' },
}))
const live = new Set<string>()
const pending = new Set<string>()
const spawnPty = vi.fn((_win: unknown, sid: string, _o: unknown) => { live.add(sid) })
const beginSpawnPreparation = vi.fn((win: unknown, sid: string) => {
  pending.add(sid)
  // A close (killPty) cancels it, as pty-manager's does.
  return { get current() { return pending.has(sid) }, spawn: (o: unknown) => { pending.delete(sid); spawnPty(win, sid, o) }, abandon: () => { pending.delete(sid) } }
})
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: (w: unknown, s: string, o: unknown) => spawnPty(w, s, o),
  writePty: vi.fn(), resizePty: vi.fn(),
  killPty: (id: string) => { live.delete(id); pending.delete(id) },
  getSshFlow: () => undefined, endSshRemote: vi.fn(),
  beginSpawnPreparation: (w: unknown, s: string) => beginSpawnPreparation(w, s),
  isSessionWritable: (id: string) => live.has(id),
  isSessionLiveOrStarting: (id: string) => live.has(id) || pending.has(id),
  endAgentRunsInFolder: async () => true,
  // A Codex launch: no conversation kept from an earlier run (nothing to carry).
  getKeptCodexConversationSource: () => undefined,
  getKeptCodexConversation: () => undefined,
  holdsCodexLaunchLease: () => false,
  codexLaunchLeaseTaken: () => false,
}))
// The start's check of the scripts folders: pending until the test opens the gate.
const folders = vi.hoisted(() => ({ pending: false, settled: Promise.resolve() as Promise<void>, open: () => {}, waits: 0 }))
vi.mock('../../../src/main/script-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/script-folders')>()),
  scriptFoldersPending: () => folders.pending,
  awaitScriptFolders: () => { folders.waits++; return folders.settled },
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
vi.mock('../../../src/main/help-workspace', () => ({ ensureHelpWorkspace: vi.fn(() => '/res/help'), helpWorkspaceDir: (dir: string) => `${dir}/help` }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
// The Hooks gateway (off unless a case turns it on), and a Codex launch's
// wait for its hook folders, counted: when it began, against the scripts
// folders' check.
const hookFolders = vi.hoisted(() => ({ listening: false, waits: [] as string[] }))
vi.mock('../../../src/main/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/hooks')>()),
  getGateway: () => (hookFolders.listening ? { status: () => ({ enabled: true, listening: true, port: 51234 }) } : null),
}))
vi.mock('../../../src/main/codex-hook-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/codex-hook-folders')>()),
  awaitCodexHookFolders: () => {
    hookFolders.waits.push(folders.pending ? 'while the scripts folders are checked' : 'after the scripts folders')
    return Promise.resolve(true)
  },
}))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: () => null,
    remoteLaunchRefusal: () => null,
    // A local Codex launch's account, as the accounts service prepares it.
    prepareLaunch: async () => ({ ok: true, lease: { accountId: 'acct-1', release: () => {} }, executable: '/proven/codex', env: {}, sessionsDir: '/realm/sessions', home: '/realm' }),
    snapshot: () => ({ accounts: [] }),
  }),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  startProfileStepsPending: () => false,
  startProfileStepsSettled: () => Promise.resolve(),
}))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!
const kill = handlers.get('pty:kill')!

const S = 'c1d2e3f4a5b6c1d2e3f4a5b6'
const outcome = async (p: unknown): Promise<string> => {
  try {
    const r = await p as { refused?: { code?: string }; started?: boolean } | undefined
    return r?.refused?.code ?? (r?.started === false ? 'not-started' : 'started')
  } catch (e) {
    return `threw: ${(e as Error).message}`
  }
}
/** Let every promise the handler is waiting on, other than the gate, settle. */
const settleAllButTheGate = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
/** Hold the start's check of the scripts folders: pending, settled only when the test opens the gate. */
function holdTheFolders(): void {
  folders.pending = true
  folders.settled = new Promise<void>((resolve) => {
    folders.open = () => { folders.pending = false; resolve() }
  })
}

beforeEach(() => {
  live.clear(); pending.clear()
  spawnPty.mockClear(); beginSpawnPreparation.mockClear()
  folders.pending = false
  folders.settled = Promise.resolve()
  folders.open = () => {}
  folders.waits = 0
  hookFolders.listening = false
  hookFolders.waits = []
})

describe('a local Claude Code launch while the start\'s check of the scripts folders still runs', () => {
  // Mutation to prove this can fail: decide the hold false (or drop the wait).
  it('is held as a prepared spawn and starts only once the check and the deploys have run', async () => {
    holdTheFolders()
    const started = outcome(spawn({}, S, { cwd: 'C:/w' }))
    await settleAllButTheGate()
    expect(spawnPty).not.toHaveBeenCalled()
    expect(beginSpawnPreparation).toHaveBeenCalledTimes(1)
    expect(folders.waits).toBe(1)
    expect(pending.has(S)).toBe(true)
    folders.open()
    expect(await started).toBe('started')
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(live.has(S)).toBe(true)
  })

  // Mutation to prove this can fail: wait without holding the launch as a prepared spawn.
  it('a close of the tab while it waits starts nothing', async () => {
    holdTheFolders()
    const started = outcome(spawn({}, S, { cwd: 'C:/w' }))
    await settleAllButTheGate()
    kill({}, S)
    folders.open()
    expect(await started).toBe('not-started')
    expect(spawnPty).not.toHaveBeenCalled()
    expect(live.has(S)).toBe(false)
  })
})

describe('a local Codex launch while the start\'s check of the scripts folders still runs', () => {
  // The Codex resume list and the app's hooks run from the scripts folders
  // too. Mutation to prove this can fail: hold only a Claude Code launch
  // (launchProvider === 'claude' in holdForScripts).
  it('is held and starts only once the check and the deploys have run', async () => {
    holdTheFolders()
    const started = outcome(spawn({}, S, { cwd: 'C:/w', provider: 'codex', codexOptions: { permissionsPreset: 'standard' } }))
    await settleAllButTheGate()
    expect(spawnPty).not.toHaveBeenCalled()
    expect(folders.waits).toBe(1)
    expect(pending.has(S)).toBe(true)
    folders.open()
    expect(await started).toBe('started')
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(live.has(S)).toBe(true)
    // The Hooks gateway is off here: no wait for the hook folders at all.
    expect(hookFolders.waits).toEqual([])
  })

  // The start wires the Codex hook folders only after the scripts folders'
  // check and the deploys (index.ts), and a launch's wait for the hook
  // folders has a bound of its own. Waited for first, that bound would have
  // to cover the scripts folders' check too, and a tab restored at start
  // could lose its hooks for its whole session. Mutation to prove this can
  // fail: wait for the hook folders before the scripts folders.
  it('with the Hooks gateway listening: its wait for the hook folders begins only once the scripts folders\' wait is over', async () => {
    hookFolders.listening = true
    holdTheFolders()
    const started = outcome(spawn({}, S, { cwd: 'C:/w', provider: 'codex', codexOptions: { permissionsPreset: 'standard' } }))
    await settleAllButTheGate()
    expect(folders.waits).toBe(1)
    expect(hookFolders.waits).toEqual([])
    expect(spawnPty).not.toHaveBeenCalled()
    folders.open()
    expect(await started).toBe('started')
    expect(hookFolders.waits).toEqual(['after the scripts folders'])
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })
})

describe('what the scripts folders\' check does not hold', () => {
  it('a launch over SSH and a terminal-only one start while the check still runs', async () => {
    holdTheFolders()
    const shapes: Array<Record<string, unknown>> = [
      { cwd: 'C:/w', ssh: { host: 'build-box', port: 22, username: 'nick', remotePath: '~/proj' } },
      { cwd: 'C:/w', shellOnly: true },
    ]
    for (const [i, options] of shapes.entries()) {
      const sid = `d${i}d2e3f4a5b6c1d2e3f4a5b6`
      expect(await outcome(spawn({}, sid, options)), JSON.stringify(options)).toBe('started')
      expect(live.has(sid)).toBe(true)
    }
    expect(folders.waits).toBe(0)
    folders.open()
  })

  it('once the check has run, a local launch starts at once, unheld', async () => {
    expect(await outcome(spawn({}, S, { cwd: 'C:/w' }))).toBe('started')
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(beginSpawnPreparation).not.toHaveBeenCalled()
    expect(folders.waits).toBe(0)
  })
})
