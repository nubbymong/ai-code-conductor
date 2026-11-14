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

// The file test under a launch's own walk of PATH (the last cases): the real
// bound over a stand-in, so no file of this computer is read. A folder in
// `walk.hung` does not answer until its tests in `walk.held` are answered.
const walk = vi.hoisted(() => ({ present: new Set<string>(), hung: new Set<string>(), held: [] as Array<() => void>, asked: [] as string[] }))
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  const stat = (p: string): Promise<boolean> => {
    walk.asked.push(p)
    if (!walk.hung.has(p.slice(0, p.lastIndexOf('\\')).toLowerCase())) return Promise.resolve(walk.present.has(p.toLowerCase()))
    return new Promise<boolean>((resolve) => { walk.held.push(() => resolve(walk.present.has(p.toLowerCase()))) })
  }
  return { ...real, fileTestWithin: (waitMs?: number) => real.fileTestWithin(waitMs, stat) }
})

// The start module itself: not a stand-in.
const { startClaudeLookup, claudeStartLookupPending, CLAUDE_START_LOOKUP_WAIT_MS, CLAUDE_START_DEADLINE_MS, _resetClaudeStartLookupForTest } =
  await import('../../../src/main/claude-start-lookup')
const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
// The launch's own walk: the real module, and the real answers a launch reads.
const { armClaudeLaunchWalk, _resetClaudeLaunchWalkForTest } = await import('../../../src/main/claude-launch-walk')
const { recentClaudeOnWindows, recordClaudeOnWindows, _resetClaudeWindowsLookupForTest } = await import('../../../src/main/claude-cli-probe')
const { WINDOWS_PATH_FILE_TEST_WAIT_MS, _resetFileTestWithinForTest } = await import('../../../src/main/windows-programs')
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
  walk.asked.length = 0
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

// The same handler, at any later time: a launch with no recent answer about
// Claude Code to read (planning #309, item 7). The real launch-walk module
// (src/main/claude-launch-walk.ts) and the real walk are behind it; only the
// file test under the walk's bound is a stand-in. Windows only: nothing is
// ever held for this anywhere else.
describe('a local Claude Code launch with no answer about Claude Code to read, through the real pty:spawn handler', () => {
  const GONE = 'S:\\gone'
  const TOOLS = 'C:\\Tools'
  const savedPath = process.env.PATH
  beforeEach(() => {
    walk.hung = new Set([GONE.toLowerCase()])
    walk.present = new Set([`${TOOLS}\\claude.exe`.toLowerCase()])
    walk.held = []
    _resetClaudeLaunchWalkForTest()
    _resetClaudeWindowsLookupForTest()
    _resetFileTestWithinForTest()
    process.env.PATH = `${GONE};${TOOLS}`
  })
  afterEach(() => {
    for (const answer of walk.held.splice(0)) answer()
    _resetClaudeLaunchWalkForTest()
    _resetClaudeWindowsLookupForTest()
    _resetFileTestWithinForTest()
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
  })

  // Mutations to prove this can fail: decide the hold false (the launch then
  // walks in place); wait for the walk without holding the launch as a
  // prepared spawn; give the folder no bound.
  it.runIf(process.platform === 'win32')('is held as a prepared spawn while PATH is walked off the event loop, and starts once the folder that does not answer has had its bounded time', async () => {
    armClaudeLaunchWalk()
    const started = outcome(spawn({}, S, { cwd: 'C:/w' }))
    await settle()
    expect(preparations, 'held as a prepared spawn').toBe(1)
    await vi.advanceTimersByTimeAsync(WINDOWS_PATH_FILE_TEST_WAIT_MS - 1)
    expect(await now(started), 'not before the bound of the folder').toBe('still held')
    expect(spawned).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(await now(started)).toBe('started')
    expect(spawned).toEqual([{ sid: S, options: { cwd: 'C:/w' } }])
    // What the launch reads: the full path the walk found past that folder.
    expect(recentClaudeOnWindows(process.env)).toBe(`${TOOLS}\\claude.exe`)
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutation to prove this can fail: hold every launch, whatever is kept.
  it.runIf(process.platform === 'win32')('with a recent answer kept it is not held: no preparation, and it starts at once', async () => {
    armClaudeLaunchWalk()
    recordClaudeOnWindows(process.env.PATH ?? '', `${TOOLS}\\claude.exe`, Date.now())
    expect(await now(outcome(spawn({}, S, { cwd: 'C:/w' })))).toBe('started')
    expect(preparations, 'no preparation: nothing to wait for').toBe(0)
    expect(spawned).toEqual([{ sid: S, options: { cwd: 'C:/w' } }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.runIf(process.platform === 'win32')('before main has started nothing is held, whatever is kept', async () => {
    expect(await now(outcome(spawn({}, S, { cwd: 'C:/w' })))).toBe('started')
    expect(preparations).toBe(0)
    expect(walk.asked).toEqual([])
  })

  // Mutation to prove this can fail: wait without holding the launch as a prepared spawn.
  it.runIf(process.platform === 'win32')('a second spawn of the same session id while the first is held for the walk supersedes it: one launch starts, the newer one', async () => {
    armClaudeLaunchWalk()
    const first = outcome(spawn({}, S, { cwd: 'C:/first' }))
    await settle()
    const second = outcome(spawn({}, S, { cwd: 'C:/second' }))
    await settle()
    expect(preparations).toBe(2)
    expect(spawned).toEqual([])
    await vi.advanceTimersByTimeAsync(WINDOWS_PATH_FILE_TEST_WAIT_MS)
    expect(await now(first)).toBe('not-started')
    expect(await now(second)).toBe('started')
    expect(spawned).toEqual([{ sid: S, options: { cwd: 'C:/second' } }])
    // Both waited for the one walk.
    expect(walk.asked.filter((p) => p.startsWith(GONE))).toEqual([`${GONE}\\claude.exe`])
  })

  // A terminal tab names no Claude Code at all.
  it.runIf(process.platform === 'win32')('a terminal-only launch is not held by it', async () => {
    armClaudeLaunchWalk()
    expect(await now(outcome(spawn({}, S, { cwd: 'C:/w', shellOnly: true })))).toBe('started')
    expect(preparations).toBe(0)
    expect(walk.asked).toEqual([])
  })
})
