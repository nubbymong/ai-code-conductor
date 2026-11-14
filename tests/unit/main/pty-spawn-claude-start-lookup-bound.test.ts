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
  // The help folder's runs have ended, unless a case holds an Ask launch for them (`walk.askRuns`).
  endAgentRunsInFolder: () => walk.askRuns ?? Promise.resolve(true),
  getKeptCodexConversationSource: () => undefined,
  getKeptCodexConversation: () => undefined,
  holdsCodexLaunchLease: () => false,
  codexLaunchLeaseTaken: () => false,
}))
vi.mock('../../../src/main/script-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/script-folders')>()),
  // Nothing to wait for, unless a case holds a launch for them (`walk.scripts`).
  scriptFoldersPending: () => walk.scripts !== null,
  awaitScriptFolders: () => walk.scripts ?? Promise.resolve(),
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
  // Every provider is on, unless a case switches one off while a launch is held (`walk.off`).
  getAccountsService: () => ({ launchRefusal: () => walk.off, remoteLaunchRefusal: () => null, snapshot: () => ({ accounts: [] }) }),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  startProfileStepsPending: () => false,
  startProfileStepsSettled: () => Promise.resolve(),
}))

// The file test under a launch's own walk of PATH (the last cases): the real
// rule (one file test at a time in a folder) over a stand-in, so no file of
// this computer is read. A folder in `walk.hung` does not answer until its
// tests in `walk.held` are answered. `walk.scripts`, when set, is the scripts
// folders' work a launch waits for first; `walk.askRuns` the end of the help
// folder's runs an Ask launch waits for last; `walk.off` why the accounts
// service refuses a launch now (the provider was switched off).
const walk = vi.hoisted(() => ({
  present: new Set<string>(), hung: new Set<string>(), held: [] as Array<() => void>, asked: [] as string[],
  scripts: null as Promise<void> | null,
  askRuns: null as Promise<boolean> | null,
  off: null as null | { code: string; providerId: string; message: string },
}))
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  const stat = (p: string): Promise<boolean> => {
    walk.asked.push(p)
    if (!walk.hung.has(p.slice(0, p.lastIndexOf('\\')).toLowerCase())) return Promise.resolve(walk.present.has(p.toLowerCase()))
    return new Promise<boolean>((resolve) => { walk.held.push(() => resolve(walk.present.has(p.toLowerCase()))) })
  }
  // The real rule, with the walk's own deadline, over the stand-in file test.
  return { ...real, folderFileTest: (_stat?: unknown, deadline?: Parameters<typeof real.folderFileTest>[1]) => real.folderFileTest(stat, deadline) }
})

// The start module itself: not a stand-in.
const { startClaudeLookup, claudeStartLookupPending, CLAUDE_START_LOOKUP_WAIT_MS, CLAUDE_START_DEADLINE_MS, _resetClaudeStartLookupForTest } =
  await import('../../../src/main/claude-start-lookup')
const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
// The launch's own walk: the real module, and the real answers a launch reads.
const { armClaudeLaunchWalk, _resetClaudeLaunchWalkForTest } = await import('../../../src/main/claude-launch-walk')
const { recentClaudeOnWindows, recordClaudeOnWindows, CLAUDE_LOOKUP_REUSE_MS, _resetClaudeWindowsLookupForTest } = await import('../../../src/main/claude-cli-probe')
const { WINDOWS_PATH_WALK_WAIT_MS, _resetFolderFileTestForTest } = await import('../../../src/main/windows-programs')
// The look for node.exe, which runs the resume list: the real module, and the real answer it keeps.
const { pickerNodeAnswerKept, _resetPickerNodeFoundForTest } = await import('../../../src/main/spawn-claude-command')
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

/** What a spawn has answered by now, as the handler answered it; 'still held' while it waits. */
const asItStands = (p: Promise<unknown>): Promise<unknown> => Promise.race([p, settle().then(() => 'still held')])
/** What the accounts service answers for a provider the user switched off. */
const OFF = { code: 'provider-off', providerId: 'claude', message: 'Claude Code is off. Turn it on in Settings, Accounts.' }

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
  walk.askRuns = null
  walk.off = null
  answer = () => {}
  _resetClaudeStartLookupForTest()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
  _resetClaudeStartLookupForTest()
  answer()
  walk.askRuns = null
  walk.off = null
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
// (src/main/claude-launch-walk.ts), the real walk and the real look for
// node.exe are behind it; only the file test under them is a stand-in.
// Nothing is ever held for this off Windows (the last case, which runs on
// every platform); the cases that hold a launch run on Windows only.
describe('a local Claude Code launch with no answer about Claude Code to read, through the real pty:spawn handler', () => {
  const GONE = 'S:\\gone'
  const TOOLS = 'C:\\Tools'
  const RESUME = { uuid: '0a1b2c3d-0a1b-4c2d-8e3f-0a1b2c3d4e5f', cwd: 'C:/w' }
  const savedPath = process.env.PATH
  const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
  const forget = (): void => {
    _resetClaudeLaunchWalkForTest()
    _resetClaudeWindowsLookupForTest()
    _resetPickerNodeFoundForTest()
    _resetFolderFileTestForTest()
  }
  /** The share is back: the folder answers from now on, and the tests held there are answered. */
  const shareBack = (): void => {
    walk.hung = new Set()
    for (const answer of walk.held.splice(0)) answer()
  }
  beforeEach(() => {
    walk.hung = new Set([GONE.toLowerCase()])
    walk.present = new Set([`${TOOLS}\\claude.exe`.toLowerCase()])
    walk.held = []
    walk.scripts = null
    forget()
    process.env.PATH = `${GONE};${TOOLS}`
  })
  afterEach(() => {
    walk.scripts = null
    shareBack()
    forget()
    Object.defineProperty(process, 'platform', PLATFORM)
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
  })

  // Mutations to prove this can fail: decide the hold false (the launch then
  // walks in place); wait for the walk without holding the launch as a
  // prepared spawn.
  it.runIf(process.platform === 'win32')('is held as a prepared spawn while PATH is walked off the event loop, and starts once the folder that had not answered has: what it reads is what the walk found', async () => {
    armClaudeLaunchWalk()
    const started = outcome(spawn({}, S, { cwd: 'C:/w' }))
    await settle()
    expect(preparations, 'held as a prepared spawn').toBe(1)
    await vi.advanceTimersByTimeAsync(WINDOWS_PATH_WALK_WAIT_MS - 1)
    expect(await now(started), 'held while the folder has not answered').toBe('still held')
    expect(spawned).toEqual([])
    shareBack()
    expect(await now(started)).toBe('started')
    expect(spawned).toEqual([{ sid: S, options: { cwd: 'C:/w' } }])
    // What the launch reads: the full path the walk found once every folder before it had answered.
    expect(recentClaudeOnWindows(process.env)).toBe(`${TOOLS}\\claude.exe`)
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutations to prove this can fail: no deadline for the walk (the launch
  // is held for as long as the share is down); a deadline that goes past the
  // folder and keeps the later folder's Claude Code.
  it.runIf(process.platform === 'win32')('is held until the walk\'s deadline and no longer: the hold ends with no answer kept, never the later folder\'s Claude Code (the launch is then refused, saying a PATH folder did not answer)', async () => {
    armClaudeLaunchWalk()
    const started = outcome(spawn({}, S, { cwd: 'C:/w' }))
    await settle()
    await vi.advanceTimersByTimeAsync(WINDOWS_PATH_WALK_WAIT_MS - 1)
    expect(await now(started), 'not before the deadline').toBe('still held')
    await vi.advanceTimersByTimeAsync(1)
    // The PTY manager, a stand-in here, is what refuses it (claude-launch-walk.test.ts).
    expect(await now(started), 'the hold has ended').toBe('started')
    expect(recentClaudeOnWindows(process.env), 'no answer was kept').toBeNull()
    expect(walk.asked, 'the later folder was not asked').toEqual([`${GONE}\\claude.exe`])
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
    shareBack()
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

  // A restored tab asks for the resume list AND names the conversation to
  // resume. The PTY manager drops a named conversation whose transcript or
  // folder is gone, and the launch then opens the list after all, with
  // node.exe. Mutation to prove this can fail: hold for node.exe only when no
  // conversation is named (the launch then walks PATH for node.exe in place).
  it.runIf(process.platform === 'win32')('a launch that asks for the resume list is held for the look for node.exe when no answer about it is kept, also when it names a conversation to resume', async () => {
    armClaudeLaunchWalk()
    recordClaudeOnWindows(process.env.PATH ?? '', `${TOOLS}\\claude.exe`, Date.now())
    walk.present = new Set([`${TOOLS}\\claude.exe`.toLowerCase(), `${TOOLS}\\node.exe`.toLowerCase()])
    expect(pickerNodeAnswerKept(), 'no answer about node.exe yet').toBe(false)
    const options = { cwd: 'C:/w', useResumePicker: true, resume: RESUME }
    const started = outcome(spawn({}, S, options))
    await settle()
    expect(preparations, 'held as a prepared spawn, though Claude Code is known').toBe(1)
    expect(spawned).toEqual([])
    expect(walk.asked, 'the look is under way, off the event loop').toEqual([`${GONE}\\node.exe`])
    shareBack()
    expect(await now(started)).toBe('started')
    expect(spawned).toEqual([{ sid: S, options }])
    expect(pickerNodeAnswerKept(), 'the launch line reads this answer: it walks nothing in place').toBe(true)
    // With the answer kept, the next such launch is not held.
    expect(await now(outcome(spawn({}, 'd1d2e3f4a5b6c1d2e3f4a5b6', options)))).toBe('started')
    expect(preparations).toBe(1)
  })

  it.runIf(process.platform === 'win32')('a launch that asks for no resume list is not held for node.exe', async () => {
    armClaudeLaunchWalk()
    recordClaudeOnWindows(process.env.PATH ?? '', `${TOOLS}\\claude.exe`, Date.now())
    expect(await now(outcome(spawn({}, S, { cwd: 'C:/w', resume: RESUME })))).toBe('started')
    expect(preparations).toBe(0)
    expect(walk.asked).toEqual([])
  })

  // Mutation to prove this can fail: run the two waits side by side.
  it.runIf(process.platform === 'win32')('the start\'s own wait, then the launch\'s walk, one after the other: the walk is not begun while the start still holds the launch', async () => {
    armClaudeLaunchWalk()
    aSlowStart()
    const started = outcome(spawn({}, S, { cwd: 'C:/w' }))
    await settle()
    await vi.advanceTimersByTimeAsync(CLAUDE_START_LOOKUP_WAIT_MS - 1)
    expect(walk.asked, 'the launch\'s walk has not begun').toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(walk.asked, 'begun when the start\'s wait ended').toEqual([`${GONE}\\claude.exe`])
    expect(await now(started)).toBe('still held')
    shareBack()
    expect(await now(started)).toBe('started')
  })

  // The hold is decided when the launch is asked for; an answer that was
  // recent then can have run out while the launch waited for something else.
  // Mutation to prove this can fail: wait for the walk only when the hold
  // was decided for it (the launch then walks PATH in place).
  it.runIf(process.platform === 'win32')('a launch held for something else, whose kept answer runs out meanwhile, waits for the walk before it starts', async () => {
    armClaudeLaunchWalk()
    recordClaudeOnWindows(process.env.PATH ?? '', `${TOOLS}\\claude.exe`, Date.now())
    let scriptsDone = (): void => {}
    walk.scripts = new Promise<void>((resolve) => { scriptsDone = resolve })
    const started = outcome(spawn({}, S, { cwd: 'C:/w' }))
    await settle()
    expect(preparations, 'held for the scripts folders').toBe(1)
    expect(walk.asked, 'not for the walk: an answer was kept').toEqual([])
    // The kept answer is a minute old by the time the scripts folders are done.
    recordClaudeOnWindows(process.env.PATH ?? '', `${TOOLS}\\claude.exe`, Date.now() - CLAUDE_LOOKUP_REUSE_MS)
    expect(recentClaudeOnWindows(process.env)).toBeNull()
    scriptsDone()
    await settle()
    expect(walk.asked, 'the walk is made now, off the event loop').toEqual([`${GONE}\\claude.exe`])
    expect(await now(started)).toBe('still held')
    shareBack()
    expect(await now(started)).toBe('started')
    expect(recentClaudeOnWindows(process.env)).toBe(`${TOOLS}\\claude.exe`)
  })

  // The rule at the top of pty:spawn is asked before every wait. A launch
  // held for the walk asks it again when the hold ends: Claude Code switched
  // off meanwhile starts nothing. Mutation to prove this can fail: do not
  // ask again after the waits (the launch then starts after the switch-off).
  it.runIf(process.platform === 'win32')('Claude Code switched off while the launch is held for the walk: when the hold ends it starts nothing, says why, and its preparation is given up', async () => {
    armClaudeLaunchWalk()
    const started = spawn({}, S, { cwd: 'C:/w' }) as Promise<unknown>
    await settle()
    expect(preparations, 'held as a prepared spawn').toBe(1)
    expect(spawned).toEqual([])
    // The user switches Claude Code off in Settings while the walk is under way.
    walk.off = OFF
    await vi.advanceTimersByTimeAsync(WINDOWS_PATH_WALK_WAIT_MS)
    expect(await asItStands(started)).toEqual({ started: false, refused: OFF })
    expect(spawned, 'nothing started after the switch-off').toEqual([])
    expect(current.has(S), 'the preparation was given up').toBe(false)
  })

  it.runIf(process.platform === 'win32')('switched off while the launch is held, and the folder answers before the deadline: still nothing starts', async () => {
    armClaudeLaunchWalk()
    const started = spawn({}, S, { cwd: 'C:/w' }) as Promise<unknown>
    await settle()
    walk.off = OFF
    shareBack()
    expect(await asItStands(started)).toEqual({ started: false, refused: OFF })
    expect(spawned).toEqual([])
    // Switched on again: the next launch starts, with the answer the walk kept.
    walk.off = null
    expect(await now(outcome(spawn({}, S, { cwd: 'C:/w' })))).toBe('started')
    expect(spawned).toEqual([{ sid: S, options: { cwd: 'C:/w' } }])
  })

  // A tab closed during the hold is not a refusal: it started nothing, and
  // the rule is not asked about a launch nobody wants any more.
  it.runIf(process.platform === 'win32')('closed while it is held, with Claude Code switched off too: it answers that nothing started, not a refusal', async () => {
    armClaudeLaunchWalk()
    const started = spawn({}, S, { cwd: 'C:/w' }) as Promise<unknown>
    await settle()
    current.delete(S)
    walk.off = OFF
    shareBack()
    expect(await asItStands(started)).toEqual({ started: false })
    expect(spawned).toEqual([])
  })

  // The same rule after the older holds, which also take seconds: here the
  // scripts folders. Runs on every platform (main has not started here, so
  // nothing is held for the walk and nothing is walked).
  it('Claude Code switched off while the launch is held for the scripts folders: it starts nothing and says why', async () => {
    let scriptsDone = (): void => {}
    walk.scripts = new Promise<void>((resolve) => { scriptsDone = resolve })
    const started = spawn({}, S, { cwd: 'C:/w' }) as Promise<unknown>
    await settle()
    expect(preparations, 'held for the scripts folders').toBe(1)
    walk.off = OFF
    scriptsDone()
    expect(await asItStands(started)).toEqual({ started: false, refused: OFF })
    expect(spawned).toEqual([])
    expect(current.has(S)).toBe(false)
  })

  // An Ask Conductor launch waits last for the runs in the help folder to
  // end. Mutation to prove this can fail: ask again only before that wait.
  it('Claude Code switched off while an Ask Conductor launch waits for the runs in the help folder to end: it starts nothing and says why', async () => {
    let runsEnded = (_ended: boolean): void => {}
    walk.askRuns = new Promise<boolean>((resolve) => { runsEnded = resolve })
    const started = spawn({}, S, { cwd: 'C:/res/help', isAsk: true }) as Promise<unknown>
    await settle()
    expect(preparations).toBe(1)
    expect(await asItStands(started), 'held for the runs to end').toBe('still held')
    walk.off = OFF
    runsEnded(true)
    expect(await asItStands(started)).toEqual({ started: false, refused: OFF })
    expect(spawned).toEqual([])
    expect(current.has(S)).toBe(false)
  })

  // Every case above holds a launch, so it runs on Windows only. This one
  // runs everywhere: main has started, PATH names a folder that does not
  // answer, and no answer is kept. Mutation to prove this can fail: decide
  // the hold as on Windows whatever the platform.
  it('off Windows nothing is held and nothing is walked, though main has started and no answer is kept', async () => {
    // On a Windows host the platform is a stand-in; elsewhere it is the host's own.
    if (process.platform === 'win32') Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    armClaudeLaunchWalk()
    expect(await now(outcome(spawn({}, S, { cwd: '/w', useResumePicker: true })))).toBe('started')
    expect(preparations).toBe(0)
    expect(walk.asked).toEqual([])
  })
})
