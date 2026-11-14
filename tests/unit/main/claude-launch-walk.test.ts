// Windows, after the start: a local Claude Code launch names Claude Code by
// the full path found in a folder PATH names, or starts nothing, and it
// cannot wait. With no recent answer to read it walked PATH itself, in place,
// on the main process's own thread, where a folder on a share that does not
// answer holds everything for tens of seconds (planning #309, item 7; the
// start's own walk was moved off that thread before).
//
// Now a launch with no answer to read waits (pty:spawn holds it as a prepared
// spawn) for a walk made off the event loop, each folder given a bounded time
// (claude-launch-walk.ts). The launch then reads the answer that walk kept:
// the full path found, or the same refusal as before. It walks nothing in
// place, and it never names a bare `claude`.
//
// Host-safe: the PATH walks' file tests, the look for node.exe and the
// PowerShell profile question are stand-ins answered here. Nothing is
// started, no file of this computer is read, and PATH is put back after each
// case. A file test a case left held is answered after it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  platform: 'win32' as NodeJS.Platform,
  /** The files the PATH walk finds, lower-cased. */
  present: new Set<string>(),
  /** Folders whose file tests do not answer (a share that is down), lower-cased. */
  hung: new Set<string>(),
  /** The file tests held there; `release()` answers them all. */
  held: [] as Array<() => void>,
  /** The file tests asked off the event loop, and the walks they belong to. */
  asked: [] as string[],
  walks: 0,
  /** Walks of PATH made in place, on the caller's own turn (what a launch
   *  did), and which names they were for. */
  walksInPlace: [] as string[],
  /** The look for node.exe: whether an answer is kept, and the looks made. */
  nodeKept: true,
  nodeLooks: 0,
  nodeLookKeeps: true,
}))
const release = (): void => { for (const answer of h.held.splice(0)) answer() }

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => h.platform }))
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  /** The stand-in file test: held for a folder that does not answer. */
  const stat = (p: string): Promise<boolean> => {
    h.asked.push(p)
    const folder = p.slice(0, p.lastIndexOf('\\')).toLowerCase()
    if (!h.hung.has(folder)) return Promise.resolve(h.present.has(p.toLowerCase()))
    return new Promise<boolean>((resolve) => { h.held.push(() => resolve(h.present.has(p.toLowerCase()))) })
  }
  return {
    ...real,
    // The real bound, over the stand-in file test.
    fileTestWithin: (waitMs?: number) => real.fileTestWithin(waitMs, stat),
    findOnWindowsPath: (names: readonly string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') => {
      h.walksInPlace.push(names.join(','))
      // A walk in place cannot be given up: a folder that does not answer
      // would hold the main process, which is what must not happen.
      return real.findOnWindowsPath(names, env, (p) => {
        if (h.hung.has(p.slice(0, p.lastIndexOf('\\')).toLowerCase())) throw new Error('this file test would hold the main process')
        return h.present.has(p.toLowerCase())
      }, order)
    },
    findOnWindowsPathAsync: (names: readonly string[], env: NodeJS.ProcessEnv, test?: (p: string) => Promise<boolean>, order?: 'folder' | 'name') => {
      h.walks += 1
      return real.findOnWindowsPathAsync(names, env, test ?? stat, order)
    },
    findWithPowerShellProfile: () => Promise.resolve({ outcome: 'none' as const }),
  }
})
vi.mock('../../../src/main/spawn-claude-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/spawn-claude-command')>()),
  pickerNodeAnswerKept: () => h.nodeKept,
  warmPickerNodeOnWindows: () => {
    h.nodeLooks += 1
    if (h.nodeLookKeeps) h.nodeKept = true
    return Promise.resolve()
  },
}))

const { armClaudeLaunchWalk, claudeLaunchWalkPending, awaitClaudeLaunchWalk, _resetClaudeLaunchWalkForTest } = await import('../../../src/main/claude-launch-walk')
const { startClaudeAtBoot, _resetClaudeStartLookupForTest } = await import('../../../src/main/claude-start-lookup')
const { WINDOWS_PATH_FILE_TEST_WAIT_MS, _resetFileTestWithinForTest } = await import('../../../src/main/windows-programs')
const { claudeOnWindowsPathAsync, recordClaudeOnWindows, CLAUDE_NOT_ON_PATH, CLAUDE_LOOKUP_REUSE_MS, _resetClaudeWindowsLookupForTest } = await import('../../../src/main/claude-cli-probe')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')

const GONE = 'S:\\gone'
const TOOLS = 'C:\\Tools'
const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm'
const WAIT = WINDOWS_PATH_FILE_TEST_WAIT_MS
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedPath = process.env.PATH

/** The launch: what a session's start names (providers/claude/spawn.ts resolveClaudeBinary). */
const launch = (): { cmd: string; args: string[] } | null => new ClaudeProvider().resolveBinary()
/** Let every promise that has nothing to wait for settle (the timers are stand-ins). */
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0) }
/** Whether a wait has ended by now. */
const ended = async (p: Promise<void>): Promise<boolean> => {
  let done = false
  void p.then(() => { done = true })
  await flush()
  return done
}

beforeEach(() => {
  h.platform = 'win32'
  h.present = new Set()
  h.hung = new Set()
  h.held = []
  h.asked = []
  h.walks = 0
  h.walksInPlace = []
  h.nodeKept = true
  h.nodeLooks = 0
  h.nodeLookKeeps = true
  _resetClaudeLaunchWalkForTest()
  _resetClaudeStartLookupForTest()
  _resetClaudeWindowsLookupForTest()
  _resetFileTestWithinForTest()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  vi.useFakeTimers()
})
afterEach(async () => {
  release()
  await flush()
  vi.useRealTimers()
  _resetClaudeLaunchWalkForTest()
  _resetClaudeStartLookupForTest()
  _resetClaudeWindowsLookupForTest()
  _resetFileTestWithinForTest()
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
})

describe('a launch with no answer about Claude Code to read, with a PATH folder that does not answer', () => {
  // Mutations to prove this can fail: walk in place; wait for the folder
  // without a bound; let the launch walk again after the walk it waited for.
  it('waits for a walk off the event loop that gives the folder its bounded time, then names the Claude Code in the next folder: nothing is walked in place', async () => {
    process.env.PATH = `${GONE};${NPM}`
    h.hung = new Set([GONE.toLowerCase()])
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase()])
    armClaudeLaunchWalk()
    expect(claudeLaunchWalkPending(false), 'the launch is held').toBe(true)
    const walked = awaitClaudeLaunchWalk(false)
    expect(h.walksInPlace, 'no file test on the caller\'s turn').toEqual([])
    await vi.advanceTimersByTimeAsync(WAIT - 1)
    expect(await ended(walked), 'not before the folder\'s bound').toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await ended(walked)).toBe(true)
    // The folder that did not answer was asked once, not once a name.
    expect(h.asked.filter((p) => p.startsWith(GONE))).toEqual([`${GONE}\\claude.exe`])
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace, 'the launch read the answer the walk kept').toEqual([])
    expect(h.walks).toBe(1)
    expect(claudeLaunchWalkPending(false), 'the next launch has an answer to read').toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutations to prove this can fail: fall back to the name `claude` when the
  // walk found none; walk in place when the kept answer is "none".
  it('with Claude Code in no folder that answers, the launch is refused as before: never a bare name, and still nothing walked in place', async () => {
    process.env.PATH = `${GONE};${TOOLS}`
    h.hung = new Set([GONE.toLowerCase()])
    // It is there, on the share that does not answer: that is not known, so it is not found.
    h.present = new Set([`${GONE}\\claude.exe`.toLowerCase()])
    armClaudeLaunchWalk()
    const walked = awaitClaudeLaunchWalk(false)
    await vi.advanceTimersByTimeAsync(WAIT)
    expect(await ended(walked)).toBe(true)
    expect(() => launch()).toThrow(CLAUDE_NOT_ON_PATH)
    expect(h.walksInPlace).toEqual([])
    // An answer that comes late changes nothing for this launch.
    release()
    await flush()
    expect(() => launch()).toThrow(CLAUDE_NOT_ON_PATH)
    expect(h.walksInPlace).toEqual([])
  })

  it('the next launch asks again, off the event loop, and does not wait for the folder while its earlier test is still held', async () => {
    process.env.PATH = `${GONE};${TOOLS}`
    h.hung = new Set([GONE.toLowerCase()])
    armClaudeLaunchWalk()
    await vi.advanceTimersByTimeAsync(0)
    const first = awaitClaudeLaunchWalk(false)
    await vi.advanceTimersByTimeAsync(WAIT)
    expect(await ended(first)).toBe(true)
    expect(() => launch()).toThrow(CLAUDE_NOT_ON_PATH)
    // Claude Code is installed meanwhile, in a folder PATH already names.
    h.present = new Set([`${TOOLS}\\claude.exe`.toLowerCase()])
    expect(claudeLaunchWalkPending(false), 'a "none" kept is asked again').toBe(true)
    h.asked = []
    expect(await ended(awaitClaudeLaunchWalk(false)), 'no bound passes').toBe(true)
    expect(h.asked.filter((p) => p.startsWith(GONE)), 'the folder is not asked again yet').toEqual([])
    expect(launch()).toEqual({ cmd: `${TOOLS}\\claude.exe`, args: [] })
    expect(h.walks).toBe(2)
    expect(h.walksInPlace).toEqual([])
  })

  it('launches asked for together (tabs restored after a wake) wait for one walk', async () => {
    process.env.PATH = `${GONE};${NPM}`
    h.hung = new Set([GONE.toLowerCase()])
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase()])
    armClaudeLaunchWalk()
    const waits = [awaitClaudeLaunchWalk(false), awaitClaudeLaunchWalk(false), awaitClaudeLaunchWalk(false)]
    await vi.advanceTimersByTimeAsync(WAIT)
    for (const w of waits) expect(await ended(w)).toBe(true)
    expect(h.walks).toBe(1)
    expect(h.asked.filter((p) => p.startsWith(GONE))).toHaveLength(1)
  })
})

describe('a launch on a PATH whose folders all answer', () => {
  it('with no answer to read: the walk ends with no bound passing, and the launch names what it found', async () => {
    process.env.PATH = `${TOOLS};${NPM}`
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase(), `${TOOLS}\\claude.bat`.toLowerCase()])
    armClaudeLaunchWalk()
    expect(claudeLaunchWalkPending(false)).toBe(true)
    expect(await ended(awaitClaudeLaunchWalk(false))).toBe(true)
    // A launch's order: claude.cmd in any folder before claude.bat in any.
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutation to prove this can fail: hold every launch, whatever is kept.
  it('with a recent answer kept (the usual case, the CLI check\'s): nothing is held and nothing walked', async () => {
    process.env.PATH = `${TOOLS};${NPM}`
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase()])
    armClaudeLaunchWalk()
    expect(await claudeOnWindowsPathAsync(process.env)).toBe(`${NPM}\\claude.cmd`)
    h.walks = 0
    expect(claudeLaunchWalkPending(false)).toBe(false)
    expect(await ended(awaitClaudeLaunchWalk(false))).toBe(true)
    expect(h.walks).toBe(0)
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toEqual([])
  })

  it('an answer older than a minute is not one to read: the launch is held and walks again', async () => {
    process.env.PATH = `${TOOLS};${NPM}`
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase()])
    armClaudeLaunchWalk()
    recordClaudeOnWindows(process.env.PATH, `${NPM}\\claude.cmd`, Date.now() - CLAUDE_LOOKUP_REUSE_MS)
    expect(claudeLaunchWalkPending(false)).toBe(true)
    expect(await ended(awaitClaudeLaunchWalk(false))).toBe(true)
    expect(h.walks).toBe(1)
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toEqual([])
  })
})

describe('what a launch that waited for no walk still does', () => {
  // The launch's own last resort is kept: a caller with no walk of this PATH
  // at all (nothing held it) still finds Claude Code, in place, as before.
  it('with no walk of this PATH at all, it walks in place, as before', () => {
    process.env.PATH = `${TOOLS};${NPM}`
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase()])
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toEqual(['claude.exe,claude.cmd,claude.bat'])
  })

  // Mutation to prove this can fail: walk in place whenever no Claude Code is known.
  it('with a walk of this PATH less than a minute ago that found none, it does not walk again in place', async () => {
    process.env.PATH = `${TOOLS};${NPM}`
    expect(await claudeOnWindowsPathAsync(process.env)).toBeNull()
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase()])
    expect(() => launch()).toThrow(CLAUDE_NOT_ON_PATH)
    expect(h.walksInPlace).toEqual([])
    // Once that answer is a minute old, or PATH reads differently, it does.
    process.env.PATH = `${NPM};${TOOLS}`
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toHaveLength(1)
  })
})

describe('when a launch is held for the walk', () => {
  it('not before main has started: nothing is held and nothing walked (a suite that drives pty:spawn alone)', async () => {
    process.env.PATH = `${GONE};${NPM}`
    h.hung = new Set([GONE.toLowerCase()])
    expect(claudeLaunchWalkPending(true)).toBe(false)
    expect(await ended(awaitClaudeLaunchWalk(true))).toBe(true)
    expect(h.walks).toBe(0)
    expect(h.nodeLooks).toBe(0)
  })

  // Mutation to prove this can fail: do not arm it at start.
  it('from main\'s start on (startClaudeAtBoot), on every platform it starts on', () => {
    process.env.PATH = `${TOOLS};${NPM}`
    startClaudeAtBoot({
      claudeOn: () => false,
      env: process.env,
      walkPath: () => Promise.resolve(null),
      refreshPath: () => Promise.resolve(),
      findClaude: () => Promise.resolve(null),
      versionProbe: () => Promise.resolve(),
      accountsWork: null,
      discover: () => {},
    }, 'linux')
    expect(claudeLaunchWalkPending(false, process.env, 'win32')).toBe(true)
  })

  it('never off Windows', async () => {
    process.env.PATH = `${GONE};${NPM}`
    armClaudeLaunchWalk()
    for (const platform of ['linux', 'darwin']) {
      expect(claudeLaunchWalkPending(true, process.env, platform)).toBe(false)
      expect(await ended(awaitClaudeLaunchWalk(true, process.env, platform))).toBe(true)
    }
    expect(h.walks).toBe(0)
    expect(h.nodeLooks).toBe(0)
  })
})

describe('a launch that opens the resume list (it starts node.exe, found the same way)', () => {
  // Mutation to prove this can fail: leave node.exe to the launch's walk in place.
  it('with no answer about node.exe kept, it is held and waits for that look too, though Claude Code is known', async () => {
    process.env.PATH = `${TOOLS};${NPM}`
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase()])
    armClaudeLaunchWalk()
    await claudeOnWindowsPathAsync(process.env)
    h.walks = 0
    h.nodeKept = false
    expect(claudeLaunchWalkPending(true)).toBe(true)
    expect(claudeLaunchWalkPending(false), 'a launch that opens no resume list is not held for it').toBe(false)
    expect(await ended(awaitClaudeLaunchWalk(true))).toBe(true)
    expect(h.nodeLooks).toBe(1)
    expect(h.walks, 'Claude Code was not walked for again').toBe(0)
    expect(claudeLaunchWalkPending(true)).toBe(false)
  })

  it('a look that ended with no answer for this PATH (one in flight from before a refresh) is made once more, and no more than that', async () => {
    process.env.PATH = `${TOOLS};${NPM}`
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase()])
    armClaudeLaunchWalk()
    await claudeOnWindowsPathAsync(process.env)
    h.nodeKept = false
    h.nodeLookKeeps = false
    expect(await ended(awaitClaudeLaunchWalk(true))).toBe(true)
    expect(h.nodeLooks).toBe(2)
  })

  it('with both to look for, both looks are made, and the launch waits for both', async () => {
    process.env.PATH = `${GONE};${NPM}`
    h.hung = new Set([GONE.toLowerCase()])
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase()])
    h.nodeKept = false
    armClaudeLaunchWalk()
    const walked = awaitClaudeLaunchWalk(true)
    await flush()
    expect(h.nodeLooks).toBe(1)
    expect(await ended(walked), 'the walk for Claude Code has not ended').toBe(false)
    await vi.advanceTimersByTimeAsync(WAIT)
    expect(await ended(walked)).toBe(true)
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toEqual([])
  })
})
