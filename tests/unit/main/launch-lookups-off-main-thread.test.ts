// 2.1.3-beta.5 (planning #310, item 5, the half outside the SSH branch): the
// program lookups a launch made in place on the main process's own thread,
// each with a slow fake folder (a PATH folder on a share that does not
// answer, a login shell that is slow to start):
//
//  - Claude Code, the last resort of the launch's resolution (providers/claude/
//    spawn.ts findClaudeOnWindows);
//  - node.exe for the resume list (spawn-claude-command.ts pickerNodeOnWindows);
//  - gsudo.exe for an elevated terminal (gsudo-lookup.ts, providers/claude/spawn.ts);
//  - macOS and Linux: the login shell asked for its PATH
//    (claude-cli-probe.ts claudeInLoginShellPathForLaunch).
//
// From the start of main on (armClaudeLaunchWalk) none of them walks PATH or
// starts a shell in place: the look is started off the event loop, the launch
// reads "no answer yet" and the answer lands for the next one. Before main has
// started no launch is asked for, and a unit test that drives one walks in
// place, as before. The Codex lookups are in tests/unit/providers/codex/spawn.test.ts.
//
// Host-safe: the real walks and kept answers over stand-in file tests, held
// for a folder that does not answer; a walk in place, or a login shell
// started in place, fails the case (it is what would hold the main process).
// child_process is a stand-in: no process is started. PATH and the platform
// are put back after each case.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  platform: 'win32' as NodeJS.Platform,
  /** The files the walks find, lower-cased. */
  present: new Set<string>(),
  /** Folders whose file tests do not answer, lower-cased. */
  slow: new Set<string>(),
  held: [] as Array<() => void>,
  /** File tests asked off the event loop. */
  asked: [] as string[],
  /** Walks made in place (the walk a launch must not make). */
  inPlace: [] as string[],
  /** Login shells started off the event loop, and the answers they wait for. */
  shellAsks: [] as Array<{ file: string; args: readonly string[] }>,
  shellHeld: [] as Array<(err: Error | null, stdout: string) => void>,
  /** Login shells started in place (what must not happen). */
  shellInPlace: 0,
}))
const release = (): void => { for (const t of h.held.splice(0)) t() }

vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => h.platform }))
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: vi.fn((file: string, args: readonly string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    h.shellAsks.push({ file, args })
    h.shellHeld.push(cb)
    return { stdin: { end: () => {} } }
  }),
  execFileSync: vi.fn(() => { h.shellInPlace++; throw new Error('a login shell must not be started in place') }),
  execSync: vi.fn(() => { h.shellInPlace++; throw new Error('a login shell must not be started in place') }),
}))
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
    if (!h.slow.has(folder)) return Promise.resolve(h.present.has(p.toLowerCase()))
    return new Promise<boolean>((resolve) => { h.held.push(() => resolve(h.present.has(p.toLowerCase()))) })
  }
  return {
    ...real,
    folderFileTest: (_stat?: unknown, deadline?: Parameters<typeof real.folderFileTest>[1]) => real.folderFileTest(stat, deadline),
    findOnWindowsPath: (names: readonly string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') => {
      h.inPlace.push(names.join(','))
      // A walk in place cannot be given up: a folder that does not answer
      // would hold the main process, which is what must not happen.
      return real.findOnWindowsPath(names, env, (p) => {
        if (h.slow.has(p.slice(0, p.lastIndexOf('\\')).toLowerCase())) throw new Error('this file test would hold the main process')
        return h.present.has(p.toLowerCase())
      }, order)
    },
  }
})

const { armClaudeLaunchWalk, claudeLaunchWalkPending, awaitClaudeLaunchWalk, _resetClaudeLaunchWalkForTest } = await import('../../../src/main/claude-launch-walk')
const probe = await import('../../../src/main/claude-cli-probe')
const { WINDOWS_PATH_WALK_WAIT_MS, _resetFolderFileTestForTest } = await import('../../../src/main/windows-programs')
const { pickerNodeFound, pickerNodeAnswerKept, _resetPickerNodeFoundForTest } = await import('../../../src/main/spawn-claude-command')
const gsudo = await import('../../../src/main/gsudo-lookup')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')
const { findClaudeOnWindows } = await import('../../../src/main/providers/claude/spawn')

const SLOW = 'S:\\slow'
const GOOD = 'C:\\Tools'
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SHELL: process.env.SHELL }
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0) }
const ended = async (p: Promise<unknown>): Promise<boolean> => {
  let done = false
  void p.then(() => { done = true })
  await flush()
  return done
}
const files = (...paths: string[]): Set<string> => new Set(paths.map((p) => p.toLowerCase()))
const reset = (): void => {
  _resetClaudeLaunchWalkForTest()
  probe._resetClaudeWindowsLookupForTest()
  probe._resetClaudeLoginShellLookupForTest()
  _resetPickerNodeFoundForTest()
  gsudo._resetGsudoLookupForTest()
  _resetFolderFileTestForTest()
}
const launch = (): { cmd: string; args: string[] } | null => new ClaudeProvider().resolveBinary()
/** An elevated terminal tab, as pty-manager asks for it. */
const elevatedTab = (): { cmd: string; args: string[] } => new ClaudeProvider().buildSpawnCommand({ sessionId: 'sid', shellOnly: true, elevated: true })

beforeEach(() => {
  h.platform = 'win32'
  h.present = new Set(); h.slow = new Set(); h.held = []; h.asked = []; h.inPlace = []
  h.shellAsks = []; h.shellHeld = []; h.shellInPlace = 0
  reset()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.SystemRoot = 'C:\\Windows'
  vi.useFakeTimers()
})
afterEach(async () => {
  h.slow = new Set()
  release()
  await flush()
  vi.useRealTimers()
  reset()
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})

describe('Claude Code, the last resort of a launch (Windows)', () => {
  // Mutation to prove this can fail: walk in place when no answer is kept.
  it('after main has started: with a PATH folder that does not answer and no answer kept, the call returns at once, walks nothing in place, starts the shared walk, and the answer lands for the next launch', async () => {
    process.env.PATH = `${SLOW};${GOOD}`
    h.slow = new Set([SLOW.toLowerCase()])
    h.present = files(`${GOOD}\\claude.exe`)
    armClaudeLaunchWalk()
    expect(findClaudeOnWindows(process.env)).toBeNull()
    expect(h.inPlace).toEqual([])
    await flush()
    // The walk started is the one every caller shares, off the event loop,
    // asking the first folder first, one file test at a time.
    expect(h.asked).toEqual([`${SLOW}\\claude.exe`])
    // The launch is told the look is under way (not "not found").
    expect(() => launch()).toThrow(probe.CLAUDE_LOOKUP_UNDER_WAY)
    expect(h.inPlace).toEqual([])
    expect(h.asked).toEqual([`${SLOW}\\claude.exe`])
    release()
    await flush()
    expect(probe.recentClaudeOnWindows(process.env)).toBe(`${GOOD}\\claude.exe`)
    expect(launch()).toEqual({ cmd: `${GOOD}\\claude.exe`, args: [] })
    expect(h.inPlace).toEqual([])
  })

  it('past the walk\'s deadline with the folder still unanswered, the launch is refused saying so, and still walks nothing in place', async () => {
    process.env.PATH = `${SLOW};${GOOD}`
    h.slow = new Set([SLOW.toLowerCase()])
    h.present = files(`${GOOD}\\claude.exe`)
    armClaudeLaunchWalk()
    const answered = probe.claudeOnWindowsPathAnswered(process.env)
    await vi.advanceTimersByTimeAsync(WINDOWS_PATH_WALK_WAIT_MS)
    expect(await answered).toBe(false)
    expect(probe.claudeOnWindowsPathUnanswered(process.env)).toBe(true)
    expect(() => launch()).toThrow(probe.CLAUDE_PATH_NOT_ANSWERING)
    expect(h.inPlace).toEqual([])
  })

  // Before main has started no launch is asked for: a unit test that drives
  // one has no walk to wait for, so it walks in place, as before.
  it('before main has started it walks in place, as before', () => {
    process.env.PATH = `${GOOD}`
    h.present = files(`${GOOD}\\claude.exe`)
    expect(findClaudeOnWindows(process.env)).toBe(`${GOOD}\\claude.exe`)
    expect(h.inPlace).toEqual(['claude.exe,claude.cmd,claude.bat'])
  })
})

describe('node.exe for the resume list (Windows)', () => {
  // Mutation to prove this can fail: walk in place when no answer is kept.
  it('after main has started: no answer kept and a folder that does not answer: no walk in place, the resume list is left out for this launch, the look is made off the event loop, and its answer lands', async () => {
    process.env.PATH = `${SLOW};${GOOD}`
    h.slow = new Set([SLOW.toLowerCase()])
    h.present = files(`${GOOD}\\node.exe`)
    armClaudeLaunchWalk()
    expect(pickerNodeFound()).toBe(false)
    expect(h.inPlace).toEqual([])
    await flush()
    expect(h.asked).toEqual([`${SLOW}\\node.exe`])
    expect(pickerNodeAnswerKept(process.env)).toBe(false)
    // A second launch while the look is under way joins it: one file test.
    expect(pickerNodeFound()).toBe(false)
    expect(h.asked).toEqual([`${SLOW}\\node.exe`])
    expect(h.inPlace).toEqual([])
    release()
    await flush()
    expect(pickerNodeAnswerKept(process.env)).toBe(true)
    expect(pickerNodeFound()).toBe(true)
    expect(h.inPlace).toEqual([])
  })

  it('before main has started it walks in place, as before', () => {
    process.env.PATH = `${GOOD}`
    h.present = files(`${GOOD}\\node.exe`)
    expect(pickerNodeFound()).toBe(true)
    expect(h.inPlace).toEqual(['node.exe'])
  })
})

describe('gsudo.exe for an elevated terminal (Windows)', () => {
  // Mutation to prove this can fail: walk in place when no answer is kept.
  it('after main has started: looked for once, off the event loop, before the launch; the terminal waits for it, then reads the answer', async () => {
    process.env.PATH = `${SLOW};${GOOD}`
    h.slow = new Set([SLOW.toLowerCase()])
    h.present = files(`${GOOD}\\gsudo.exe`)
    armClaudeLaunchWalk()
    expect(gsudo.gsudoAnswerKept()).toBe(false)
    // What pty:spawn does for an elevated terminal with no answer: wait,
    // bounded, for the look.
    const waited = gsudo.gsudoLookAnswered()
    expect(await ended(waited)).toBe(false)
    expect(h.asked).toEqual([`${SLOW}\\gsudo.exe`])
    // A terminal asked for in the meantime walks nothing in place either.
    expect(() => elevatedTab()).toThrow(gsudo.GSUDO_LOOKUP_UNDER_WAY)
    expect(h.inPlace).toEqual([])
    release()
    expect(await waited).toBe(true)
    expect(gsudo.gsudoAnswerKept()).toBe(true)
    expect(elevatedTab().cmd).toBe(`${GOOD}\\gsudo.exe`)
    expect(h.inPlace).toEqual([])
    // One look: asked once.
    expect(h.asked).toEqual([`${SLOW}\\gsudo.exe`, `${GOOD}\\gsudo.exe`])
  })

  it('a folder that never answers: the wait ends at the walk\'s deadline, and the terminal is refused with no walk in place', async () => {
    process.env.PATH = `${SLOW};${GOOD}`
    h.slow = new Set([SLOW.toLowerCase()])
    h.present = files(`${GOOD}\\gsudo.exe`)
    armClaudeLaunchWalk()
    const waited = gsudo.gsudoLookAnswered()
    await vi.advanceTimersByTimeAsync(WINDOWS_PATH_WALK_WAIT_MS - 1)
    expect(await ended(waited)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await waited).toBe(false)
    expect(gsudo.gsudoAnswerKept()).toBe(false)
    expect(() => elevatedTab()).toThrow(gsudo.GSUDO_LOOKUP_UNDER_WAY)
    expect(h.inPlace).toEqual([])
  })

  it('no gsudo.exe in a folder PATH names: the answer is kept, and the terminal says so', async () => {
    process.env.PATH = `${GOOD}`
    armClaudeLaunchWalk()
    expect(await gsudo.gsudoLookAnswered()).toBe(true)
    expect(gsudo.recentGsudo()).toBeNull()
    expect(() => elevatedTab()).toThrow(gsudo.GSUDO_NOT_FOUND)
  })

  it('an answer is kept for the PATH it was made under: another PATH has none', async () => {
    process.env.PATH = `${GOOD}`
    h.present = files(`${GOOD}\\gsudo.exe`)
    armClaudeLaunchWalk()
    await gsudo.gsudoLookAnswered()
    expect(gsudo.recentGsudo()).toBe(`${GOOD}\\gsudo.exe`)
    expect(gsudo.recentGsudo({ PATH: 'C:\\elsewhere' })).toBeUndefined()
  })

  it('before main has started it walks in place, as before', () => {
    process.env.PATH = `${GOOD}`
    h.present = files(`${GOOD}\\gsudo.exe`)
    expect(elevatedTab().cmd).toBe(`${GOOD}\\gsudo.exe`)
    expect(h.inPlace).toEqual(['gsudo.exe'])
  })
})

describe('the login shell asked for its PATH (macOS and Linux, a user whose shell is not of the sh family)', () => {
  const FISH = { PATH: '/usr/bin:/bin', SHELL: '/usr/bin/fish', HOME: '/home/someone' }
  const REPORTED = '__CCC_LOGIN_PATH_BEGIN__/opt/tools/bin:/usr/bin__CCC_LOGIN_PATH_END__'
  const answerShell = async (stdout = REPORTED): Promise<void> => {
    for (const cb of h.shellHeld.splice(0)) cb(null, stdout)
    await flush()
  }

  // Mutation to prove this can fail: start the login shell in place (execFileSync).
  it('with no answer kept, the launch asks nothing in place: it gets none at once, the shell is started once off the event loop, and the answer lands for the next launch', async () => {
    h.platform = 'linux'
    expect(probe.claudeInLoginShellPathForLaunch(FISH, 'linux')).toBeNull()
    expect(h.shellInPlace).toBe(0)
    expect(h.shellAsks).toHaveLength(1)
    expect(h.shellAsks[0].file).toBe('/usr/bin/fish')
    expect(h.shellAsks[0].args.slice(0, 2)).toEqual(['-l', '-c'])
    // A launch while the shell is still working joins the question.
    expect(probe.claudeInLoginShellPathForLaunch(FISH, 'linux')).toBeNull()
    expect(h.shellAsks).toHaveLength(1)
    expect(probe.recentClaudeInLoginShellPath(FISH, 'linux')).toBeUndefined()
    await answerShell()
    expect(probe.recentClaudeInLoginShellPath(FISH, 'linux')).toEqual({ path: '/opt/tools/bin:/usr/bin', claude: null })
    expect(probe.claudeInLoginShellPathForLaunch(FISH, 'linux')).toEqual({ path: '/opt/tools/bin:/usr/bin', claude: null })
    expect(h.shellAsks).toHaveLength(1)
    expect(h.shellInPlace).toBe(0)
  })

  it('a shell that gave no PATH is an answer too: kept, and not asked again at once', async () => {
    h.platform = 'linux'
    expect(probe.claudeInLoginShellPathForLaunch(FISH, 'linux')).toBeNull()
    await answerShell('nothing the app can read')
    expect(probe.recentClaudeInLoginShellPath(FISH, 'linux')).toBeNull()
    expect(probe.claudeInLoginShellPathForLaunch(FISH, 'linux')).toBeNull()
    expect(h.shellAsks).toHaveLength(1)
  })

  it('a user of an sh-family login shell is never asked', () => {
    expect(probe.claudeInLoginShellPathForLaunch({ ...FISH, SHELL: '/bin/zsh' }, 'linux')).toBeNull()
    expect(h.shellAsks).toEqual([])
    expect(h.shellInPlace).toBe(0)
  })

  // The launch waits for the question, as a launch on Windows waits for its walk.
  it('a launch is held for the question while main has started and no answer is kept, and not otherwise', async () => {
    expect(claudeLaunchWalkPending(false, FISH, 'linux'), 'before main has started').toBe(false)
    armClaudeLaunchWalk()
    expect(claudeLaunchWalkPending(false, FISH, 'linux')).toBe(true)
    expect(claudeLaunchWalkPending(false, { ...FISH, SHELL: '/bin/zsh' }, 'linux'), 'an sh-family shell').toBe(false)
    expect(h.shellAsks).toEqual([])
    const waited = awaitClaudeLaunchWalk(false, FISH, 'linux')
    expect(await ended(waited)).toBe(false)
    expect(h.shellAsks).toHaveLength(1)
    await answerShell()
    expect(await ended(waited)).toBe(true)
    expect(claudeLaunchWalkPending(false, FISH, 'linux'), 'the answer is kept').toBe(false)
    expect(h.shellInPlace).toBe(0)
  })
})
