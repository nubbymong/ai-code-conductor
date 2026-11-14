// Windows, after the start: a local Claude Code launch names Claude Code by
// the full path found in a folder PATH names, or starts nothing, and it
// cannot wait. With no recent answer to read it walked PATH itself, in place,
// on the main process's own thread, where a folder on a share that does not
// answer holds everything for tens of seconds (planning #309, item 7; the
// start's own walk was moved off that thread before).
//
// Now a launch with no answer to read waits (pty:spawn holds it as a prepared
// spawn) for a walk made off the event loop (claude-launch-walk.ts), the one
// walk every caller shares. PATH's order holds: the walk waits for every
// folder in turn and never passes one that has not answered, so it names what
// a walk in place would name. The launch waits for it until the walk's one
// deadline; past it the launch is refused, saying a PATH folder did not
// answer in time. Never a later folder's Claude Code, never a bare `claude`,
// and nothing walked in place.
//
// The real launch walk, the real kept answers, the real resolution and the
// real look for node.exe. Host-safe: the PATH walks' file tests and the
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
  /** The file tests held there: `release()` answers them all, `fail()` ends
   *  them as a share that is down ends a file test at last (the host did
   *  not answer in time), or with the error code given. */
  held: [] as Array<{ answer: () => void; fail: (code: string) => void }>,
  /** The file tests asked off the event loop, and the walks they belong to
   *  (by the names each walk was for). */
  asked: [] as string[],
  walks: [] as string[],
  /** A walk off the event loop fails as it begins. */
  walkThrows: false,
  /** Called as each walk off the event loop begins. */
  onWalk: null as null | (() => void),
  /** Walks of PATH made in place, on the caller's own turn (what a launch
   *  did), and which names they were for. */
  walksInPlace: [] as string[],
  /** The PowerShell profile question: how often it was asked, and its answer. */
  profileAsks: 0,
  profileAnswer: null as string | null,
}))
const release = (): void => { for (const t of h.held.splice(0)) t.answer() }
const fail = (code = 'ETIMEDOUT'): void => { for (const t of h.held.splice(0)) t.fail(code) }

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => h.platform }))
vi.mock('../../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/debug-logger')>()),
  logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(),
}))
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  /** The stand-in file test: held for a folder that does not answer. */
  const stat = (p: string): Promise<boolean> => {
    h.asked.push(p)
    const folder = p.slice(0, p.lastIndexOf('\\')).toLowerCase()
    if (!h.hung.has(folder)) return Promise.resolve(h.present.has(p.toLowerCase()))
    return new Promise<boolean>((resolve, reject) => {
      h.held.push({ answer: () => resolve(h.present.has(p.toLowerCase())), fail: (code) => reject(Object.assign(new Error('the file test failed'), { code })) })
    })
  }
  return {
    ...real,
    // The real rule (one file test at a time in a folder), with the walk's
    // own deadline, over the stand-in file test.
    folderFileTest: (_stat?: unknown, deadline?: Parameters<typeof real.folderFileTest>[1]) => real.folderFileTest(stat, deadline),
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
      h.walks.push(names.join(','))
      h.onWalk?.()
      if (h.walkThrows) throw new Error('the walk failed')
      return real.findOnWindowsPathAsync(names, env, test ?? stat, order)
    },
    findWithPowerShellProfile: () => {
      h.profileAsks += 1
      return Promise.resolve(h.profileAnswer ? { outcome: 'found' as const, path: h.profileAnswer } : { outcome: 'none' as const })
    },
  }
})

const { armClaudeLaunchWalk, claudeLaunchWalkPending, awaitClaudeLaunchWalk, _resetClaudeLaunchWalkForTest } = await import('../../../src/main/claude-launch-walk')
const { startClaudeAtBoot, _resetClaudeStartLookupForTest } = await import('../../../src/main/claude-start-lookup')
const { WINDOWS_PATH_WALK_WAIT_MS, _resetFolderFileTestForTest } = await import('../../../src/main/windows-programs')
const {
  claudeOnWindowsPathAsync, findClaudeOnWindowsAsync, recordClaudeOnWindows, recentClaudeOnWindows, claudeOnWindowsPathWalkedRecently, setClaudeProfileLookupAllowed,
  CLAUDE_NOT_ON_PATH, CLAUDE_PATH_NOT_ANSWERING, CLAUDE_LOOKUP_REUSE_MS, _resetClaudeWindowsLookupForTest,
} = await import('../../../src/main/claude-cli-probe')
const {
  buildClaudeLaunchCommand, launchStartsPicker, pickerNodeAnswerKept, warmPickerNodeOnWindows,
  CLAUDE_RESUME_LIST_SKIPPED_PATH_NOT_ANSWERING, PICKER_NODE_REUSE_MS, _resetPickerNodeFoundForTest,
} = await import('../../../src/main/spawn-claude-command')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')
const { logInfo } = await import('../../../src/main/debug-logger')

const GONE = 'S:\\gone'
const TOOLS = 'C:\\Tools'
const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm'
const NODEJS = 'C:\\nodejs'
const PICKER = 'C:\\ccc\\scripts\\resume-picker.js'
const CLAUDE_NAMES = 'claude.exe,claude.cmd,claude.bat'
const DEADLINE = WINDOWS_PATH_WALK_WAIT_MS
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedPath = process.env.PATH

/** The launch: what a session's start names (providers/claude/spawn.ts resolveClaudeBinary). */
const launch = (): { cmd: string; args: string[] } | null => new ClaudeProvider().resolveBinary()
/** Whether a launch line that asks for the resume list starts it (with the node.exe the app found). */
const opensList = (): boolean => launchStartsPicker({ useResumePicker: true, pickerScript: PICKER, platform: 'win32' })
/** Let every promise that has nothing to wait for settle (the timers are stand-ins). */
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0) }
/** Whether a wait has ended by now. */
const ended = async (p: Promise<void>): Promise<boolean> => {
  let done = false
  void p.then(() => { done = true })
  await flush()
  return done
}
const files = (...paths: string[]): Set<string> => new Set(paths.map((p) => p.toLowerCase()))
const reset = (): void => {
  _resetClaudeLaunchWalkForTest()
  _resetClaudeStartLookupForTest()
  _resetClaudeWindowsLookupForTest()
  _resetPickerNodeFoundForTest()
  _resetFolderFileTestForTest()
}

beforeEach(() => {
  h.platform = 'win32'
  h.present = new Set()
  h.hung = new Set()
  h.held = []
  h.asked = []
  h.walks = []
  h.walkThrows = false
  h.onWalk = null
  h.walksInPlace = []
  h.profileAsks = 0
  h.profileAnswer = null
  vi.mocked(logInfo).mockClear()
  reset()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  vi.useFakeTimers()
})
afterEach(async () => {
  h.onWalk = null
  h.hung = new Set()
  release()
  await flush()
  vi.useRealTimers()
  reset()
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
})

describe('PATH\'s order holds: a launch with no answer to read, and a PATH folder that does not answer', () => {
  // Mutations to prove this can fail: give the folder a time of its own and
  // go on to the next (the later folder's Claude Code is named); refuse with
  // the not-found message; walk in place once the wait has ended.
  it('waits for the walk until its deadline, not before; then it is refused, saying a PATH folder did not answer: never the later folder\'s Claude Code, no answer kept, nothing walked in place', async () => {
    process.env.PATH = `${GONE};${NPM}`
    h.hung = new Set([GONE.toLowerCase()])
    // The folder that does not answer holds Claude Code too: a walk in place names that one.
    h.present = files(`${GONE}\\claude.exe`, `${NPM}\\claude.cmd`)
    armClaudeLaunchWalk()
    expect(claudeLaunchWalkPending(false), 'the launch is held').toBe(true)
    const walked = awaitClaudeLaunchWalk(false)
    expect(h.walksInPlace, 'no file test on the caller\'s turn').toEqual([])
    await vi.advanceTimersByTimeAsync(DEADLINE - 1)
    expect(await ended(walked), 'not before the walk\'s deadline').toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await ended(walked)).toBe(true)
    expect(() => launch()).toThrow(CLAUDE_PATH_NOT_ANSWERING)
    expect(CLAUDE_PATH_NOT_ANSWERING, 'not the not-installed text').not.toContain('not found')
    expect(h.asked, 'the later folder was not asked: the earlier one has not answered').toEqual([`${GONE}\\claude.exe`])
    expect(recentClaudeOnWindows(process.env), 'no answer is kept').toBeNull()
    expect(claudeOnWindowsPathWalkedRecently(process.env)).toBe(false)
    expect(h.walksInPlace).toEqual([])
    // The folder answers at last: the walk ends, and names what PATH names first.
    release()
    await flush()
    expect(launch()).toEqual({ cmd: `${GONE}\\claude.exe`, args: [] })
    expect(h.walks, 'one walk in all').toEqual([CLAUDE_NAMES])
    expect(h.walksInPlace).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  // A file test on a share that is down ends by FAILING. Mutation to prove
  // this can fail: keep nothing, or never free the walk, when the test ends
  // by failing after the deadline.
  it('the folder says at last, after the deadline, that it cannot be reached: the walk goes on past it, as a walk in place does, keeps its answer, and the next launch reads it; a later walk asks the folder again', async () => {
    process.env.PATH = `${GONE};${NPM}`
    h.hung = new Set([GONE.toLowerCase()])
    h.present = files(`${NPM}\\claude.cmd`)
    armClaudeLaunchWalk()
    const walked = awaitClaudeLaunchWalk(false)
    await vi.advanceTimersByTimeAsync(DEADLINE)
    expect(await ended(walked)).toBe(true)
    expect(() => launch()).toThrow(CLAUDE_PATH_NOT_ANSWERING)
    // A launch asked for now joins the walk past its deadline: it does not wait again.
    expect(await ended(awaitClaudeLaunchWalk(false)), 'no further wait').toBe(true)
    expect(() => launch()).toThrow(CLAUDE_PATH_NOT_ANSWERING)
    expect(h.walks, 'and it started no walk of its own').toEqual([CLAUDE_NAMES])
    await vi.advanceTimersByTimeAsync(25_000)
    fail()
    await flush()
    expect(claudeLaunchWalkPending(false), 'the next launch has an answer to read').toBe(false)
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    // The folder that cannot be reached was asked once, not once a name.
    expect(h.asked.filter((p) => p.startsWith(GONE))).toEqual([`${GONE}\\claude.exe`])
    expect(h.walksInPlace).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    // A minute on, that answer is not one to read, and the folder is asked again.
    await vi.advanceTimersByTimeAsync(CLAUDE_LOOKUP_REUSE_MS)
    h.asked = []
    void awaitClaudeLaunchWalk(false)
    await flush()
    expect(h.asked).toEqual([`${GONE}\\claude.exe`])
  })

  it('a folder that answers before the deadline, however slowly, is waited for: the launch names what the walk found', async () => {
    process.env.PATH = `${GONE};${NPM}`
    h.hung = new Set([GONE.toLowerCase()])
    h.present = files(`${NPM}\\claude.cmd`)
    armClaudeLaunchWalk()
    const walked = awaitClaudeLaunchWalk(false)
    await vi.advanceTimersByTimeAsync(DEADLINE - 1)
    expect(await ended(walked)).toBe(false)
    // The share is back: it holds no Claude Code.
    h.hung = new Set()
    release()
    expect(await ended(walked)).toBe(true)
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutation to prove this can fail: a walk of its own for each launch, or
  // for the launch beside the CLI check's.
  it('launches asked for together (tabs restored after a wake) and the CLI check\'s own walk are one walk: the folder is asked once, and the check goes on waiting past the launches\' deadline', async () => {
    process.env.PATH = `${GONE};${NPM}`
    h.hung = new Set([GONE.toLowerCase()])
    h.present = files(`${NPM}\\claude.cmd`)
    armClaudeLaunchWalk()
    let checked: string | null = 'not answered yet'
    void claudeOnWindowsPathAsync(process.env).then((found) => { checked = found })
    const waits = [awaitClaudeLaunchWalk(false), awaitClaudeLaunchWalk(false), awaitClaudeLaunchWalk(false)]
    await vi.advanceTimersByTimeAsync(DEADLINE)
    for (const w of waits) expect(await ended(w)).toBe(true)
    expect(h.walks).toEqual([CLAUDE_NAMES])
    expect(h.asked).toEqual([`${GONE}\\claude.exe`])
    expect(checked, 'the check has no deadline').toBe('not answered yet')
    h.hung = new Set()
    release()
    await flush()
    expect(checked).toBe(`${NPM}\\claude.cmd`)
  })

  // Mutation to prove this can fail: record "none" (or anything) for a walk
  // that has not ended.
  it('a walk past its deadline overwrites nothing: an answer kept from a walk that ended is still the answer while it is recent, and is still there afterwards', async () => {
    process.env.PATH = `${GONE};${TOOLS}`
    h.present = files(`${TOOLS}\\claude.exe`)
    armClaudeLaunchWalk()
    expect(await claudeOnWindowsPathAsync(process.env), 'a walk that ended').toBe(`${TOOLS}\\claude.exe`)
    const keptAt = Date.now()
    // The share goes down; the CLI check's next walk does not end.
    h.hung = new Set([GONE.toLowerCase()])
    void claudeOnWindowsPathAsync(process.env)
    await vi.advanceTimersByTimeAsync(DEADLINE)
    expect(claudeLaunchWalkPending(false), 'an answer is kept: nothing to wait for').toBe(false)
    expect(launch(), 'the kept answer, not a refusal').toEqual({ cmd: `${TOOLS}\\claude.exe`, args: [] })
    // Once it is a minute old there is no answer to read, and the walk under way has none.
    await vi.advanceTimersByTimeAsync(CLAUDE_LOOKUP_REUSE_MS - DEADLINE)
    expect(() => launch()).toThrow(CLAUDE_PATH_NOT_ANSWERING)
    expect(recentClaudeOnWindows(process.env, () => keptAt + 1), 'the kept answer was not replaced').toBe(`${TOOLS}\\claude.exe`)
    expect(h.walksInPlace).toEqual([])
  })
})

// Why a launch is refused, as the session says it: the message alone.
const refusal = (): string => {
  try {
    return `started ${launch()?.cmd}`
  } catch (e) {
    return (e as Error).message
  }
}

describe('what a launch is told, and what it never starts, when the walk it waited for is past its deadline', () => {
  // A "none" is the answer for a minute, but a launch with a "none" kept is
  // held for a new walk all the same (a Claude Code installed since is seen
  // at once). When that walk misses its deadline, what the launch waited to
  // learn is not known. Mutation to prove this can fail: say "not found"
  // whenever a "none" under a minute old is kept.
  it('with a "none" under a minute old kept: refused saying a PATH folder did not answer, not that Claude Code was not found; and it works once the folder has answered', async () => {
    process.env.PATH = `${GONE};${TOOLS}`
    armClaudeLaunchWalk()
    expect(await claudeOnWindowsPathAsync(process.env), 'a walk that ended: none').toBeNull()
    expect(refusal()).toBe(CLAUDE_NOT_ON_PATH)
    await vi.advanceTimersByTimeAsync(30_000)
    // Claude Code is installed, and the share goes down.
    h.present = files(`${TOOLS}\\claude.exe`)
    h.hung = new Set([GONE.toLowerCase()])
    expect(claudeLaunchWalkPending(false), 'held for a new walk').toBe(true)
    const walked = awaitClaudeLaunchWalk(false)
    await vi.advanceTimersByTimeAsync(DEADLINE)
    expect(await ended(walked)).toBe(true)
    expect(claudeOnWindowsPathWalkedRecently(process.env), 'the "none" is still under a minute old').toBe(true)
    vi.mocked(logInfo).mockClear()
    expect(refusal()).toBe(CLAUDE_PATH_NOT_ANSWERING)
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(`[claude-provider] ${CLAUDE_PATH_NOT_ANSWERING}`)
    expect(vi.mocked(logInfo)).not.toHaveBeenCalledWith(`[claude-provider] ${CLAUDE_NOT_ON_PATH}`)
    expect(h.walksInPlace).toEqual([])
    // The share is back.
    h.hung = new Set()
    release()
    await flush()
    expect(refusal()).toBe(`started ${TOOLS}\\claude.exe`)
  })

  // The same reason whoever asks while that walk is overdue, and never the
  // not-installed text. Mutation to prove this can fail: drop the reason
  // (every such refusal then reads "not found").
  it('with no answer kept at all: the reason is that a folder did not answer, in the message and in the log, never "not found"', async () => {
    process.env.PATH = `${GONE};${NPM}`
    h.hung = new Set([GONE.toLowerCase()])
    armClaudeLaunchWalk()
    const walked = awaitClaudeLaunchWalk(false)
    await vi.advanceTimersByTimeAsync(DEADLINE)
    expect(await ended(walked)).toBe(true)
    vi.mocked(logInfo).mockClear()
    expect(refusal()).toBe(CLAUDE_PATH_NOT_ANSWERING)
    expect(refusal()).not.toBe(CLAUDE_NOT_ON_PATH)
    expect(CLAUDE_PATH_NOT_ANSWERING).toContain('did not answer in time')
    expect(CLAUDE_PATH_NOT_ANSWERING).not.toContain('not found')
    expect(CLAUDE_PATH_NOT_ANSWERING).not.toContain('not installed')
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(`[claude-provider] ${CLAUDE_PATH_NOT_ANSWERING}`)
    expect(vi.mocked(logInfo)).not.toHaveBeenCalledWith(`[claude-provider] ${CLAUDE_NOT_ON_PATH}`)
  })

  // The Claude Code the PowerShell profile named comes only after every
  // folder of PATH has said it holds none. Mutation to prove this can fail:
  // answer with the profile's Claude Code while the walk is past its
  // deadline (providers/claude/spawn.ts findClaudeOnWindows).
  it('never the Claude Code the PowerShell profile named: a folder of PATH has not said it holds none, so the launch is refused; once it has, the profile\'s is the answer', async () => {
    const FNM = 'C:\\Users\\me\\fnm\\claude.cmd'
    process.env.PATH = TOOLS
    h.profileAnswer = FNM
    setClaudeProfileLookupAllowed(() => true)
    armClaudeLaunchWalk()
    expect(await findClaudeOnWindowsAsync(process.env), 'the profile\'s answer is kept').toBe(FNM)
    // Another PATH value (no answer kept for it), whose first folder does not answer.
    process.env.PATH = `${GONE};${TOOLS}`
    h.hung = new Set([GONE.toLowerCase()])
    expect(claudeLaunchWalkPending(false)).toBe(true)
    const walked = awaitClaudeLaunchWalk(false)
    await vi.advanceTimersByTimeAsync(DEADLINE)
    expect(await ended(walked)).toBe(true)
    expect(refusal(), 'not the profile\'s Claude Code').toBe(CLAUDE_PATH_NOT_ANSWERING)
    expect(h.walksInPlace).toEqual([])
    // The folder answers at last: no Claude Code in any folder of PATH, so the profile's it is.
    h.hung = new Set()
    release()
    await flush()
    expect(refusal()).toBe(`started ${FNM}`)
  })
})

describe('two walks in one folder: the look for node.exe and the walk for Claude Code', () => {
  const SHARE = 'S:\\tools'

  // The CLI check's own order (ipc/cli-handlers.ts): the look for node.exe,
  // then the walk for Claude Code. The folder answers, but node.exe in it
  // cannot be read (access denied on that file). Mutation to prove this can
  // fail: hand the node.exe test's failure to the walk for Claude Code (it
  // then passes the folder, and the launch runs the later folder's Claude
  // Code for a minute).
  it('a node.exe test that fails for that file alone: the walk for Claude Code still asks the folder, and the launch names its Claude Code, not the later folder\'s', async () => {
    process.env.PATH = `${SHARE};${NODEJS}`
    h.hung = new Set([SHARE.toLowerCase()])
    h.present = files(`${SHARE}\\claude.exe`, `${NODEJS}\\claude.exe`, `${NODEJS}\\node.exe`)
    armClaudeLaunchWalk()
    void warmPickerNodeOnWindows()
    void claudeOnWindowsPathAsync(process.env)
    await flush()
    expect(h.asked, 'one test at a time in the folder').toEqual([`${SHARE}\\node.exe`])
    h.hung = new Set()
    fail('EPERM')
    await flush()
    expect(h.asked).toContain(`${SHARE}\\claude.exe`)
    expect(launch(), 'what a walk in place names').toEqual({ cmd: `${SHARE}\\claude.exe`, args: [] })
    // The look whose own test failed passes the folder, as a walk in place does.
    expect(opensList()).toBe(true)
    expect(h.walksInPlace).toEqual([])
  })

  // The mirror: claude.exe in the folder cannot be read, and the look for
  // node.exe waited behind that test.
  it('a claude.exe test that fails for that file alone: the look for node.exe still asks the folder, and the resume list runs with its node.exe', async () => {
    process.env.PATH = `${SHARE};${NODEJS}`
    h.hung = new Set([SHARE.toLowerCase()])
    h.present = files(`${SHARE}\\node.exe`, `${NODEJS}\\claude.exe`, `${NODEJS}\\node.exe`)
    armClaudeLaunchWalk()
    void claudeOnWindowsPathAsync(process.env)
    void warmPickerNodeOnWindows()
    await flush()
    expect(h.asked).toEqual([`${SHARE}\\claude.exe`])
    h.hung = new Set()
    fail('EACCES')
    await flush()
    expect(launch()).toEqual({ cmd: `${NODEJS}\\claude.exe`, args: [] })
    const line = buildClaudeLaunchCommand({ platform: 'win32', cwd: 'C:\\work', claudeBin: `${NODEJS}\\claude.exe`, extraFlags: '', agentsFlag: '', useResumePicker: true, pickerScript: PICKER })
    expect(line, 'the node.exe PATH names first').toContain(`${SHARE}\\node.exe`)
    expect(line).not.toContain(`${NODEJS}\\node.exe`)
    expect(h.walksInPlace).toEqual([])
  })

  // A share that is down fails every file the same way: the walk that
  // waited is not made to wait there once more.
  it('a test that fails because the folder cannot be reached is the answer for both walks: the folder is asked once', async () => {
    process.env.PATH = `${SHARE};${NODEJS}`
    h.hung = new Set([SHARE.toLowerCase()])
    h.present = files(`${NODEJS}\\claude.exe`, `${NODEJS}\\node.exe`)
    armClaudeLaunchWalk()
    void warmPickerNodeOnWindows()
    void claudeOnWindowsPathAsync(process.env)
    await vi.advanceTimersByTimeAsync(5_000)
    fail('EHOSTUNREACH')
    await flush()
    expect(h.asked.filter((p) => p.startsWith(SHARE))).toEqual([`${SHARE}\\node.exe`])
    expect(launch()).toEqual({ cmd: `${NODEJS}\\claude.exe`, args: [] })
    expect(opensList()).toBe(true)
  })
})

// A file test begun while a share was down can stay outstanding long after
// the share is back. A later walk of that folder waits behind it until its
// own deadline, no longer: the launch that waited is refused then (the walk
// has no answer yet), and the walk asks the folder itself.
describe('a file test an earlier walk left outstanding in a folder', () => {
  // Mutations to prove this can fail: wait behind the old test however long
  // it takes (every launch is then refused for as long); pass the folder
  // over at the deadline (the later folder's Claude Code is named).
  it('holds a later walk until that walk\'s own deadline: the launch is refused then, the walk asks the folder itself, never the later folder first, and the next launch reads its answer', async () => {
    // A walk of the PATH from before a refresh asked the share while it was down. Its test does not end.
    h.hung = new Set([GONE.toLowerCase()])
    void claudeOnWindowsPathAsync({ PATH: `${GONE};${NPM}` })
    await flush()
    expect(h.asked).toEqual([`${GONE}\\claude.exe`])
    await vi.advanceTimersByTimeAsync(60_000)
    // A launch on the PATH of now, which names the same folder first.
    process.env.PATH = `${GONE};${TOOLS}`
    h.present = files(`${TOOLS}\\claude.exe`)
    h.walks = []
    armClaudeLaunchWalk()
    const walked = awaitClaudeLaunchWalk(false)
    await vi.advanceTimersByTimeAsync(DEADLINE - 1)
    expect(await ended(walked), 'not before the walk\'s own deadline').toBe(false)
    expect(h.asked, 'no second test yet, and the later folder is not asked').toEqual([`${GONE}\\claude.exe`])
    await vi.advanceTimersByTimeAsync(1)
    expect(await ended(walked)).toBe(true)
    expect(refusal(), 'no answer yet: refused, saying so').toBe(CLAUDE_PATH_NOT_ANSWERING)
    expect(h.asked, 'the walk asks the folder itself; the later folder is still not asked').toEqual([`${GONE}\\claude.exe`, `${GONE}\\claude.exe`])
    // The share is back: the walk's own test answers (no Claude Code there). The old one is still outstanding.
    h.hung = new Set()
    h.held.splice(1, 1)[0].answer()
    await flush()
    expect(h.held, 'the old test has not ended').toHaveLength(1)
    expect(refusal()).toBe(`started ${TOOLS}\\claude.exe`)
    expect(h.walks, 'one walk for the launch').toEqual([CLAUDE_NAMES])
    expect(h.walksInPlace).toEqual([])
  })
})

describe('a launch on a PATH whose folders all answer', () => {
  it('with no answer to read: the walk ends with no deadline passing, and the launch names what it found', async () => {
    process.env.PATH = `${TOOLS};${NPM}`
    h.present = files(`${NPM}\\claude.cmd`, `${TOOLS}\\claude.bat`)
    armClaudeLaunchWalk()
    expect(claudeLaunchWalkPending(false)).toBe(true)
    expect(await ended(awaitClaudeLaunchWalk(false))).toBe(true)
    // A launch's order: claude.cmd in any folder before claude.bat in any.
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutations to prove this can fail: fall back to the name `claude` when the
  // walk found none; walk in place when the kept answer is "none".
  it('with Claude Code in no folder, the launch is refused as before, with the not-found message: never a bare name, and nothing walked in place', async () => {
    process.env.PATH = `${TOOLS};${NPM}`
    armClaudeLaunchWalk()
    expect(await ended(awaitClaudeLaunchWalk(false))).toBe(true)
    expect(() => launch()).toThrow(CLAUDE_NOT_ON_PATH)
    expect(h.walksInPlace).toEqual([])
  })

  it('a "none" kept is asked again, off the event loop, by the next launch: a Claude Code installed meanwhile is seen at once', async () => {
    process.env.PATH = `${TOOLS};${NPM}`
    armClaudeLaunchWalk()
    expect(await ended(awaitClaudeLaunchWalk(false))).toBe(true)
    expect(() => launch()).toThrow(CLAUDE_NOT_ON_PATH)
    h.present = files(`${TOOLS}\\claude.exe`)
    expect(claudeLaunchWalkPending(false)).toBe(true)
    expect(await ended(awaitClaudeLaunchWalk(false))).toBe(true)
    expect(launch()).toEqual({ cmd: `${TOOLS}\\claude.exe`, args: [] })
    expect(h.walks).toEqual([CLAUDE_NAMES, CLAUDE_NAMES])
    expect(h.walksInPlace).toEqual([])
  })

  // Mutation to prove this can fail: hold every launch, whatever is kept.
  it('with a recent answer kept (the usual case, the CLI check\'s): nothing is held and nothing walked', async () => {
    process.env.PATH = `${TOOLS};${NPM}`
    h.present = files(`${NPM}\\claude.cmd`)
    armClaudeLaunchWalk()
    expect(await claudeOnWindowsPathAsync(process.env)).toBe(`${NPM}\\claude.cmd`)
    h.walks = []
    expect(claudeLaunchWalkPending(false)).toBe(false)
    expect(await ended(awaitClaudeLaunchWalk(false))).toBe(true)
    expect(h.walks).toEqual([])
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toEqual([])
  })

  it('an answer a minute old is not one to read: the launch is held and walks again', async () => {
    process.env.PATH = `${TOOLS};${NPM}`
    h.present = files(`${NPM}\\claude.cmd`)
    armClaudeLaunchWalk()
    recordClaudeOnWindows(process.env.PATH, `${NPM}\\claude.cmd`, Date.now() - (CLAUDE_LOOKUP_REUSE_MS - 1))
    expect(claudeLaunchWalkPending(false), 'a millisecond short of a minute: still read').toBe(false)
    recordClaudeOnWindows(process.env.PATH, `${NPM}\\claude.cmd`, Date.now() - CLAUDE_LOOKUP_REUSE_MS)
    expect(claudeLaunchWalkPending(false)).toBe(true)
    expect(await ended(awaitClaudeLaunchWalk(false))).toBe(true)
    expect(h.walks).toEqual([CLAUDE_NAMES])
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toEqual([])
  })
})

describe('deciding whether a launch is held', () => {
  // Mutation to prove this can fail: decide by the lookup a launch reads,
  // which starts the PowerShell profile question when it has no answer.
  it('starts nothing: with a "none" kept and no answer from the PowerShell profile yet, the profile is not asked for the decision', async () => {
    process.env.PATH = TOOLS
    setClaudeProfileLookupAllowed(() => true)
    armClaudeLaunchWalk()
    expect(await claudeOnWindowsPathAsync(process.env)).toBeNull()
    expect(claudeLaunchWalkPending(false)).toBe(true)
    await flush()
    expect(h.profileAsks, 'the decision asked the profile nothing').toBe(0)
    // The launch itself still starts that question in the background, as before.
    expect(() => launch()).toThrow(CLAUDE_NOT_ON_PATH)
    await flush()
    expect(h.profileAsks).toBe(1)
  })

  it('a Claude Code the PowerShell profile named, kept, is a Claude Code that is known: nothing is held', async () => {
    const FNM = 'C:\\Users\\me\\fnm\\claude.cmd'
    process.env.PATH = TOOLS
    h.profileAnswer = FNM
    setClaudeProfileLookupAllowed(() => true)
    armClaudeLaunchWalk()
    expect(await findClaudeOnWindowsAsync(process.env)).toBe(FNM)
    expect(claudeLaunchWalkPending(false)).toBe(false)
    expect(launch()).toEqual({ cmd: FNM, args: [] })
  })
})

describe('what a launch that waited for no walk still does', () => {
  // The launch's own last resort is kept: a caller with no walk of this PATH
  // at all (nothing held it) still finds Claude Code, in place, as before.
  it('with no walk of this PATH at all, it walks in place, as before', () => {
    process.env.PATH = `${TOOLS};${NPM}`
    h.present = files(`${NPM}\\claude.cmd`)
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toEqual([CLAUDE_NAMES])
  })

  // Mutation to prove this can fail: walk in place whenever no Claude Code is known.
  it('with a walk of this PATH less than a minute ago that found none, it does not walk again in place; under another PATH it does', async () => {
    process.env.PATH = `${TOOLS};${NPM}`
    expect(await claudeOnWindowsPathAsync(process.env)).toBeNull()
    h.present = files(`${NPM}\\claude.cmd`)
    expect(() => launch()).toThrow(CLAUDE_NOT_ON_PATH)
    expect(h.walksInPlace).toEqual([])
    process.env.PATH = `${NPM};${TOOLS}`
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toHaveLength(1)
  })

  // Mutation to prove this can fail: take a "none" as the answer whatever its age.
  it('a "none" is the answer for a minute less a millisecond; a minute old, or dated after now, it is not, and the last resort runs', () => {
    process.env.PATH = `${TOOLS};${NPM}`
    h.present = files(`${NPM}\\claude.cmd`)
    const now = Date.now()
    recordClaudeOnWindows(process.env.PATH, null, now - (CLAUDE_LOOKUP_REUSE_MS - 1))
    expect(claudeOnWindowsPathWalkedRecently(process.env)).toBe(true)
    expect(() => launch()).toThrow(CLAUDE_NOT_ON_PATH)
    expect(h.walksInPlace).toEqual([])
    recordClaudeOnWindows(process.env.PATH, null, now + 5_000)
    expect(claudeOnWindowsPathWalkedRecently(process.env), 'an answer dated after now').toBe(false)
    recordClaudeOnWindows(process.env.PATH, null, now - CLAUDE_LOOKUP_REUSE_MS)
    expect(claudeOnWindowsPathWalkedRecently(process.env)).toBe(false)
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toEqual([CLAUDE_NAMES])
  })
})

describe('the wait itself (awaitClaudeLaunchWalk)', () => {
  // Mutation to prove this can fail: let a failed walk reject the wait.
  it('never rejects: a walk that fails keeps no answer, and the launch then resolves as it did before', async () => {
    process.env.PATH = `${TOOLS};${NPM}`
    h.present = files(`${NPM}\\claude.cmd`)
    h.walkThrows = true
    armClaudeLaunchWalk()
    await expect(awaitClaudeLaunchWalk(true)).resolves.toBeUndefined()
    expect(h.walks.sort()).toEqual([CLAUDE_NAMES, 'node.exe'])
    expect(recentClaudeOnWindows(process.env)).toBeNull()
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toEqual([CLAUDE_NAMES])
    expect(vi.getTimerCount()).toBe(0)
  })

  // PATH is brought up to date while the app runs (the refresh at start, a
  // check the user asks for), and a walk keeps its answer for the PATH it
  // walked. Mutation to prove this can fail: end the wait when the walks
  // end, whatever PATH reads by then (the launch then walks the new PATH in
  // place).
  it('PATH brought up to date while a file test is still unanswered: the wait looks again, off the event loop, at the PATH there is by then, and the launch walks nothing in place', async () => {
    process.env.PATH = `${GONE};${TOOLS}`
    h.hung = new Set([GONE.toLowerCase()])
    h.present = files(`${NPM}\\claude.cmd`)
    armClaudeLaunchWalk()
    const walked = awaitClaudeLaunchWalk(false)
    await flush()
    expect(h.held).toHaveLength(1)
    // The refresh adds a folder, and the share comes back.
    process.env.PATH = `${GONE};${TOOLS};${NPM}`
    h.hung = new Set()
    release()
    expect(await ended(walked)).toBe(true)
    expect(h.walks, 'the PATH from before, then the PATH of now').toEqual([CLAUDE_NAMES, CLAUDE_NAMES])
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toEqual([])
  })

  it('a PATH that reads differently after every walk is looked at three times, and no more', async () => {
    let n = 0
    process.env.PATH = 'C:\\p0'
    h.onWalk = () => { process.env.PATH = `C:\\p${++n}` }
    armClaudeLaunchWalk()
    expect(await ended(awaitClaudeLaunchWalk(false))).toBe(true)
    expect(h.walks).toEqual([CLAUDE_NAMES, CLAUDE_NAMES, CLAUDE_NAMES])
  })
})

describe('when a launch is held for the walk', () => {
  it('not before main has started: nothing is held and nothing walked (a suite that drives pty:spawn alone)', async () => {
    process.env.PATH = `${GONE};${NPM}`
    h.hung = new Set([GONE.toLowerCase()])
    expect(claudeLaunchWalkPending(true)).toBe(false)
    expect(await ended(awaitClaudeLaunchWalk(true))).toBe(true)
    expect(h.walks).toEqual([])
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
    expect(h.walks).toEqual([])
  })
})

describe('a launch that opens the resume list (it starts node.exe, found the same way)', () => {
  /** Claude Code is known for the PATH of now. */
  const claudeKnown = (): void => recordClaudeOnWindows(process.env.PATH ?? '', `${TOOLS}\\claude.exe`, Date.now())

  // Mutations to prove this can fail: leave node.exe to the launch's walk in
  // place; answer "kept" whatever is kept, or never.
  it('with no answer about node.exe kept, it is held and waits for that look too, though Claude Code is known; the answer is then kept, for that PATH and for a minute', async () => {
    process.env.PATH = `${TOOLS};${NODEJS}`
    h.present = files(`${NODEJS}\\node.exe`)
    armClaudeLaunchWalk()
    claudeKnown()
    expect(pickerNodeAnswerKept(), 'no look yet').toBe(false)
    expect(claudeLaunchWalkPending(true)).toBe(true)
    expect(claudeLaunchWalkPending(false), 'a launch that opens no resume list is not held for it').toBe(false)
    expect(await ended(awaitClaudeLaunchWalk(true))).toBe(true)
    expect(h.walks, 'Claude Code was not walked for again').toEqual(['node.exe'])
    expect(pickerNodeAnswerKept()).toBe(true)
    expect(claudeLaunchWalkPending(true)).toBe(false)
    expect(opensList()).toBe(true)
    expect(h.walksInPlace, 'the launch read the answer the look kept').toEqual([])
    expect(pickerNodeAnswerKept({ PATH: NODEJS }), 'not an answer for another PATH').toBe(false)
    await vi.advanceTimersByTimeAsync(PICKER_NODE_REUSE_MS - 1)
    expect(pickerNodeAnswerKept()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(pickerNodeAnswerKept(), 'a minute old').toBe(false)
  })

  it('a "none" about node.exe is an answer kept too: the launch is not held again, and starts Claude Code directly', async () => {
    process.env.PATH = TOOLS
    armClaudeLaunchWalk()
    claudeKnown()
    expect(await ended(awaitClaudeLaunchWalk(true))).toBe(true)
    expect(pickerNodeAnswerKept()).toBe(true)
    expect(claudeLaunchWalkPending(true)).toBe(false)
    expect(opensList()).toBe(false)
    expect(h.walksInPlace).toEqual([])
  })

  // Mutations to prove this can fail: give the folder a time of its own and
  // go on (a later folder's node.exe runs the list); walk in place when the
  // look has no answer.
  it('PATH\'s order holds for node.exe too: past the look\'s deadline the resume list is left out and the log says why, never a later folder\'s node.exe, and nothing is walked in place', async () => {
    process.env.PATH = `${GONE};${NODEJS}`
    h.hung = new Set([GONE.toLowerCase()])
    h.present = files(`${NODEJS}\\node.exe`)
    armClaudeLaunchWalk()
    claudeKnown()
    const walked = awaitClaudeLaunchWalk(true)
    await vi.advanceTimersByTimeAsync(DEADLINE - 1)
    expect(await ended(walked), 'not before the look\'s deadline').toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await ended(walked)).toBe(true)
    expect(opensList()).toBe(false)
    const line = buildClaudeLaunchCommand({ platform: 'win32', cwd: 'C:\\work', claudeBin: `${TOOLS}\\claude.exe`, extraFlags: '', agentsFlag: '', useResumePicker: true, pickerScript: PICKER })
    expect(line).toContain(`& '${TOOLS}\\claude.exe'`)
    expect(line).not.toContain('node.exe')
    expect(vi.mocked(logInfo)).toHaveBeenCalledWith(`[spawn-claude] ${CLAUDE_RESUME_LIST_SKIPPED_PATH_NOT_ANSWERING}`)
    expect(h.asked, 'the later folder was not asked').toEqual([`${GONE}\\node.exe`])
    expect(h.walksInPlace).toEqual([])
    // The folder answers at last (it holds no node.exe): the look ends, and the next launch opens the list.
    h.hung = new Set()
    release()
    await flush()
    expect(opensList()).toBe(true)
    expect(h.walksInPlace).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutation to prove this can fail: a file test of its own for each look
  // (one share that is down then holds two of the few threads).
  it('with both to look for, both looks are made and the launch waits for both, with one file test at a time in the folder that does not answer', async () => {
    process.env.PATH = `${GONE};${NPM}`
    h.hung = new Set([GONE.toLowerCase()])
    h.present = files(`${NPM}\\claude.cmd`, `${NPM}\\node.exe`)
    armClaudeLaunchWalk()
    const walked = awaitClaudeLaunchWalk(true)
    await flush()
    expect(h.walks.sort()).toEqual([CLAUDE_NAMES, 'node.exe'])
    expect(h.asked, 'one test outstanding there, for both looks').toEqual([`${GONE}\\claude.exe`])
    expect(await ended(walked)).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    fail()
    expect(await ended(walked)).toBe(true)
    expect(h.asked.filter((p) => p.startsWith(GONE)), 'asked once in all').toEqual([`${GONE}\\claude.exe`])
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(opensList()).toBe(true)
    expect(h.walksInPlace).toEqual([])
  })

  it('a look that ended with no answer for this PATH (one under way from before a refresh) is made once more, and no more than that', async () => {
    h.hung = new Set([GONE.toLowerCase()])
    void warmPickerNodeOnWindows({ PATH: GONE })
    process.env.PATH = `${TOOLS};${NODEJS}`
    h.present = files(`${NODEJS}\\node.exe`)
    armClaudeLaunchWalk()
    claudeKnown()
    const walked = awaitClaudeLaunchWalk(true)
    await flush()
    expect(h.walks, 'it joined the look under way').toEqual(['node.exe'])
    release()
    expect(await ended(walked)).toBe(true)
    expect(h.walks).toEqual(['node.exe', 'node.exe'])
    expect(pickerNodeAnswerKept()).toBe(true)
    expect(opensList()).toBe(true)
    expect(h.walksInPlace).toEqual([])
  })
})
