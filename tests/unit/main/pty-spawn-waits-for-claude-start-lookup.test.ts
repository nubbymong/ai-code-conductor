/**
 * On Windows, while the start's PATH refresh and first Claude Code lookup
 * still run (claude-start-lookup.ts), pty:spawn holds a local Claude Code
 * launch as a prepared spawn and starts it only once they have answered (or
 * the wait's bound passed), so a tab restored at start finds the Claude Code
 * they find instead of saying "not found" until Check again (regression since
 * #638). A close of the tab while it waits starts nothing. A launch over SSH,
 * a terminal-only one and a Codex one are not held by this, and nothing is
 * held once the start has answered (off Windows it is never pending).
 *
 * Driven through the REAL pty:spawn and pty:kill handlers on a fake ipcMain;
 * the start lookup's pending/wait pair is answered here (held on a gate the
 * test opens) and pty-manager is faked, so nothing spawns.
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
  getKeptCodexConversationSource: () => undefined,
  getKeptCodexConversation: () => undefined,
  holdsCodexLaunchLease: () => false,
  codexLaunchLeaseTaken: () => false,
}))
// The start's PATH refresh and first lookup: pending until the test opens the gate.
const lookup = vi.hoisted(() => ({ pending: false, settled: Promise.resolve() as Promise<void>, open: () => {}, waits: 0 }))
vi.mock('../../../src/main/claude-start-lookup', () => ({
  CLAUDE_START_LOOKUP_WAIT_MS: 5000,
  claudeStartLookupPending: () => lookup.pending,
  awaitClaudeStartLookup: () => { lookup.waits++; return lookup.settled },
}))
vi.mock('../../../src/main/script-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/script-folders')>()),
  scriptFoldersPending: () => false,
  awaitScriptFolders: () => Promise.resolve(),
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
vi.mock('../../../src/main/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/hooks')>()),
  getGateway: () => null,
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
/** Hold the start's lookup: pending, settled only when the test opens the gate. */
function holdTheLookup(): void {
  lookup.pending = true
  lookup.settled = new Promise<void>((resolve) => {
    lookup.open = () => { lookup.pending = false; resolve() }
  })
}

beforeEach(() => {
  live.clear(); pending.clear()
  spawnPty.mockClear(); beginSpawnPreparation.mockClear()
  lookup.pending = false
  lookup.settled = Promise.resolve()
  lookup.open = () => {}
  lookup.waits = 0
})

describe('a local Claude Code launch while the start\'s PATH refresh and first Claude Code lookup still run', () => {
  // Mutation to prove this can fail: decide the hold false (or drop the wait).
  it('is held as a prepared spawn and starts only once they have answered', async () => {
    holdTheLookup()
    const started = outcome(spawn({}, S, { cwd: 'C:/w' }))
    await settleAllButTheGate()
    expect(spawnPty).not.toHaveBeenCalled()
    expect(beginSpawnPreparation).toHaveBeenCalledTimes(1)
    expect(lookup.waits).toBe(1)
    expect(pending.has(S)).toBe(true)
    lookup.open()
    expect(await started).toBe('started')
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(live.has(S)).toBe(true)
  })

  // Mutation to prove this can fail: wait without holding the launch as a prepared spawn.
  it('a close of the tab while it waits starts nothing', async () => {
    holdTheLookup()
    const started = outcome(spawn({}, S, { cwd: 'C:/w' }))
    await settleAllButTheGate()
    kill({}, S)
    lookup.open()
    expect(await started).toBe('not-started')
    expect(spawnPty).not.toHaveBeenCalled()
    expect(live.has(S)).toBe(false)
  })
})

describe('what the start\'s Claude Code lookup does not hold', () => {
  it('a launch over SSH, a terminal-only one and a Codex one start while it still runs', async () => {
    holdTheLookup()
    const shapes: Array<Record<string, unknown>> = [
      { cwd: 'C:/w', ssh: { host: 'build-box', port: 22, username: 'nick', remotePath: '~/proj' } },
      { cwd: 'C:/w', shellOnly: true },
      { cwd: 'C:/w', provider: 'codex', codexOptions: { permissionsPreset: 'standard' } },
    ]
    for (const [i, options] of shapes.entries()) {
      const sid = `d${i}d2e3f4a5b6c1d2e3f4a5b6`
      expect(await outcome(spawn({}, sid, options)), JSON.stringify(options)).toBe('started')
      expect(live.has(sid)).toBe(true)
    }
    expect(lookup.waits).toBe(0)
    lookup.open()
  })

  it('once it has answered (and always off Windows), a local launch starts at once, unheld', async () => {
    expect(await outcome(spawn({}, S, { cwd: 'C:/w' }))).toBe('started')
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(beginSpawnPreparation).not.toHaveBeenCalled()
    expect(lookup.waits).toBe(0)
  })
})
