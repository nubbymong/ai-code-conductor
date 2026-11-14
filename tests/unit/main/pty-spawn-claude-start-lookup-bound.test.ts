/**
 * The hold pty:spawn puts on a local Claude Code launch while the start still
 * looks for Claude Code on Windows, with the REAL start module
 * (src/main/claude-start-lookup.ts) behind the REAL pty:spawn handler: its
 * own bound ends the hold and the launch starts; a newer spawn of the same
 * session id supersedes the one held; the start answering ends the hold
 * before the bound; and once the start's deadline has passed nothing is held.
 *
 * pty-spawn-waits-for-claude-start-lookup.test.ts answers the start module's
 * pending/wait pair itself, so nothing there ties the handler to the module's
 * bound. Here only pty-manager is faked, with preparations as pty-manager
 * makes them (one current per session id, superseded by a newer one,
 * cancelled by a close), so nothing spawns. setTimeout and clearTimeout are
 * stand-ins; every other timer is real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  BrowserWindow: class {},
  app: { getVersion: () => '0.0.0-test' },
}))
const live = new Set<string>()
/** The current preparation of each session id (a newer one supersedes it, a close cancels it). */
const current = new Map<string, symbol>()
/** Each launch that started: its session id and the options it started with. */
const spawned: Array<{ sid: string; options: unknown }> = []
let preparations = 0
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: (_w: unknown, sid: string, options: unknown) => { live.add(sid); spawned.push({ sid, options }) },
  writePty: vi.fn(), resizePty: vi.fn(),
  killPty: (id: string) => { live.delete(id); current.delete(id) },
  getSshFlow: () => undefined, endSshRemote: vi.fn(),
  beginSpawnPreparation: (_w: unknown, sid: string) => {
    preparations += 1
    const me = Symbol('preparation')
    current.set(sid, me)
    return {
      get current() { return current.get(sid) === me },
      spawn: (options: unknown) => {
        if (current.get(sid) !== me) throw new Error('this spawn was cancelled or superseded while it was prepared')
        current.delete(sid)
        live.add(sid)
        spawned.push({ sid, options })
      },
      abandon: () => { if (current.get(sid) === me) current.delete(sid) },
    }
  },
  isSessionWritable: (id: string) => live.has(id),
  isSessionLiveOrStarting: (id: string) => live.has(id) || current.has(id),
  endAgentRunsInFolder: async () => true,
  getKeptCodexConversationSource: () => undefined,
  getKeptCodexConversation: () => undefined,
  holdsCodexLaunchLease: () => false,
  codexLaunchLeaseTaken: () => false,
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
  getAccountsService: () => ({ launchRefusal: () => null, remoteLaunchRefusal: () => null, snapshot: () => ({ accounts: [] }) }),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  startProfileStepsPending: () => false,
  startProfileStepsSettled: () => Promise.resolve(),
}))

// The start module itself: not a stand-in.
const { startClaudeLookup, claudeStartLookupPending, CLAUDE_START_LOOKUP_WAIT_MS, CLAUDE_START_DEADLINE_MS, _resetClaudeStartLookupForTest } =
  await import('../../../src/main/claude-start-lookup')
const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!

const S = 'c1d2e3f4a5b6c1d2e3f4a5b6'
const outcome = async (p: unknown): Promise<string> => {
  try {
    const r = await p as { refused?: { code?: string }; started?: boolean } | undefined
    return r?.refused?.code ?? (r?.started === false ? 'not-started' : 'started')
  } catch (e) {
    return `threw: ${(e as Error).message}`
  }
}
/** Let every promise the handler waits on, other than the start, settle (setImmediate is real). */
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
/** The outcome of a spawn as it stands now: 'still held' while the handler
 *  waits on the start (said at once, not by the test's timeout). */
const now = (p: Promise<string>): Promise<string> => Promise.race([p, settle().then(() => 'still held')])

/** A start on Windows that found Claude Code in no folder PATH names and whose
 *  registry read has not answered; `answer` lets it. */
let answer = (): void => {}
function aSlowStart(): void {
  startClaudeLookup({
    claudeOn: () => true,
    onPath: () => Promise.resolve(false),
    refreshPath: () => new Promise<void>((resolve) => { answer = resolve }),
    lookup: () => Promise.resolve(null),
    versionProbe: () => Promise.resolve(),
  }, 'win32')
}

beforeEach(() => {
  live.clear(); current.clear(); spawned.length = 0; preparations = 0
  answer = () => {}
  _resetClaudeStartLookupForTest()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
  _resetClaudeStartLookupForTest()
  answer()
})

describe('a local Claude Code launch held by the real start module, through the real pty:spawn handler', () => {
  // Mutations to prove this can fail: hand the wait a bound of the handler's
  // own; decide the hold false; wait without a bound.
  it('the module\'s own bound elapses and the launch starts, with the options it was asked with', async () => {
    aSlowStart()
    const started = outcome(spawn({}, S, { cwd: 'C:/w' }))
    await settle()
    expect(preparations, 'held as a prepared spawn').toBe(1)
    await vi.advanceTimersByTimeAsync(CLAUDE_START_LOOKUP_WAIT_MS - 1)
    expect(await now(started), 'not before the bound').toBe('still held')
    expect(spawned).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(await now(started)).toBe('started')
    expect(spawned).toEqual([{ sid: S, options: { cwd: 'C:/w' } }])
    expect(claudeStartLookupPending(), 'the start itself has not answered').toBe(true)
  })

  // Mutation to prove this can fail: wait without holding the launch as a prepared spawn.
  it('a second spawn of the same session id while the first is held supersedes it: one launch starts, the newer one', async () => {
    aSlowStart()
    const first = outcome(spawn({}, S, { cwd: 'C:/first' }))
    await settle()
    await vi.advanceTimersByTimeAsync(5000)
    const second = outcome(spawn({}, S, { cwd: 'C:/second' }))
    await settle()
    expect(preparations).toBe(2)
    expect(spawned).toEqual([])
    // The first one's bound: it was superseded, so it starts nothing.
    await vi.advanceTimersByTimeAsync(CLAUDE_START_LOOKUP_WAIT_MS - 5000)
    expect(await now(first)).toBe('not-started')
    expect(await now(second)).toBe('still held')
    expect(spawned).toEqual([])
    // The second one's own bound, 5 s later.
    await vi.advanceTimersByTimeAsync(5000)
    expect(await now(second)).toBe('started')
    expect(spawned).toEqual([{ sid: S, options: { cwd: 'C:/second' } }])
    expect(live.has(S)).toBe(true)
  })

  // Mutation to prove this can fail: never release the launches when the start ends.
  it('the start answering ends the hold before the bound, and leaves no timer behind', async () => {
    aSlowStart()
    const started = outcome(spawn({}, S, { cwd: 'C:/w' }))
    await settle()
    expect(spawned).toEqual([])
    answer()
    expect(await now(started)).toBe('started')
    expect(spawned).toEqual([{ sid: S, options: { cwd: 'C:/w' } }])
    expect(claudeStartLookupPending()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutation to prove this can fail: no deadline for the start as a whole.
  it('once the start\'s deadline has passed a launch is not held at all, though the start has still not answered', async () => {
    aSlowStart()
    await vi.advanceTimersByTimeAsync(CLAUDE_START_DEADLINE_MS)
    expect(claudeStartLookupPending()).toBe(false)
    expect(await now(outcome(spawn({}, S, { cwd: 'C:/w' })))).toBe('started')
    expect(preparations, 'no preparation: nothing to wait for').toBe(0)
    expect(spawned).toEqual([{ sid: S, options: { cwd: 'C:/w' } }])
    expect(vi.getTimerCount()).toBe(0)
  })
})
