// Windows: every walk of PATH that asks through the shared file test
// (windows-programs.ts folderFileTest) carries a deadline of its own,
// WINDOWS_PATH_WALK_WAIT_MS from its start. While another walk's test is
// outstanding in a folder, the walk waits behind it and makes no test of its
// own there, and it never goes past the folder. Once its deadline has
// passed, it makes its own test in that folder (at most two outstanding),
// and that test's answer is the folder's answer. When the walk ends, its
// timer is gone.
//
// One case per place that wires the deadline in:
//  - the shared lookup itself (findOnWindowsPathAsync, with no file test of
//    the caller's own: git, the GitHub CLI, npm, the Node.js tools check);
//  - the Claude Code version probe (claude-cli-version.ts);
//  - the check for what would help after a lookup found nothing
//    (install-folder-path.ts installFolderDeps().isFile).
// The fourth place, the other provider's program lookup, has its case beside
// that lookup's own suite (tests/unit/providers).
//
// And the longest a set of walks can take in one folder that is down: with
// eight walks for eight programs, each file test there ending after the same
// time T for a reason that is not handed on, never more than two tests are
// outstanding, every walk makes its own, and the last walk has its answer
// at the deadline plus four times T.
//
// Host-safe: the file test is a stand-in for every path under the made-up
// folder below; any other path is the real call. The timers are stand-ins.
// Nothing is started: child_process and the PowerShell profile question are
// mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'

vi.mock('node:child_process', () => ({
  execFile: () => { throw new Error('nothing is started in this test') },
}))
vi.mock('../../../src/main/claude-cli-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/claude-cli-probe')>()),
  probeClaudeCli: async () => ({ installed: false, probe: 'login shell' }),
  claudeFromPowerShellProfile: async () => null,
}))

const { resolveClaudeExecutable, _resetClaudeCliVersionForTest } = await import('../../../src/main/claude-cli-version')
const { findOnWindowsPathAsync, folderFileTest, WINDOWS_PATH_WALK_WAIT_MS, _resetFolderFileTestForTest } = await import('../../../src/main/windows-programs')
const { installFolderDeps } = await import('../../../src/main/install-folder-path')

const ROOT = 'C:\\ccc-test-walk-deadline-sites-2f6b'
/** A folder on a share that does not answer until the test says so. */
const DOWN = `${ROOT}\\down`
const GOOD = `${ROOT}\\good`
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedPath = process.env.PATH

type Held = { file: string; found: () => void; fail: (code: string) => void }
/** Files under GOOD that are there (lower case). */
let good = new Set<string>()
/** Every file under ROOT that was asked for, in order. */
let asked: string[] = []
/** The file tests in DOWN that have not ended. */
let held: Held[] = []
/** The most file tests that were outstanding in DOWN at one time. */
let mostAtOnce = 0
/** When set, every file test in DOWN ends by itself after `ms`, failing with `code`. */
let downEnds: { ms: number; code: string } | null = null

const inDown = (p: string): boolean => p.toLowerCase().startsWith(`${DOWN.toLowerCase()}\\`)
const askedInDown = (): string[] => asked.filter(inDown).map((p) => p.slice(DOWN.length + 1))
const askedPastDown = (): string[] => asked.filter((p) => !inDown(p))
/** Lets every step that can run now, run (the timers are stand-ins). */
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0) }
const failure = (code: string): Error => Object.assign(new Error('the file test failed'), { code })
/** The test outstanding in DOWN for `name`. */
const heldFor = (name: string): Held => {
  const test = held.find((h) => h.file.toLowerCase() === `${DOWN}\\${name}`.toLowerCase())
  expect(test, `a test for ${name} is outstanding`).toBeDefined()
  return test as Held
}
/** Another walk's file test in DOWN, for another file: it stays outstanding
 *  until the test ends it. Asked through the shared file test with no
 *  deadline, so it sets no timer. */
const anotherWalksTest = (): void => { void folderFileTest()(`${DOWN}\\other.exe`).catch(() => false) }

beforeEach(() => {
  _resetClaudeCliVersionForTest()
  _resetFolderFileTestForTest()
  good = new Set()
  asked = []
  held = []
  mostAtOnce = 0
  downEnds = null
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.PATH = `${DOWN};${GOOD}`
  vi.useFakeTimers()
  const realStat = fs.promises.stat.bind(fs.promises) as (p: unknown, o?: unknown) => Promise<unknown>
  vi.spyOn(fs.promises, 'stat').mockImplementation(((p: unknown, o?: unknown) => {
    if (typeof p !== 'string' || !p.toLowerCase().startsWith(`${ROOT.toLowerCase()}\\`)) return realStat(p, o)
    asked.push(p)
    if (!inDown(p)) {
      return good.has(p.toLowerCase()) ? Promise.resolve({ isFile: () => true }) : Promise.reject(failure('ENOENT'))
    }
    return new Promise((resolve, reject) => {
      const mine: Held = {
        file: p,
        found: () => { held.splice(held.indexOf(mine), 1); resolve({ isFile: () => true }) },
        fail: (code) => { held.splice(held.indexOf(mine), 1); reject(failure(code)) },
      }
      held.push(mine)
      mostAtOnce = Math.max(mostAtOnce, held.length)
      const ends = downEnds
      if (ends) setTimeout(() => mine.fail(ends.code), ends.ms)
    })
  }) as never)
})
afterEach(async () => {
  // Nothing is left waiting on a folder of this test.
  for (const test of [...held]) test.fail('ENETUNREACH')
  await flush()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
})

describe('Windows: the shared lookup waits behind another walk\'s test until its own deadline, and no longer', () => {
  // Mutation to prove this can fail: ask through the shared file test with no deadline.
  it('no test of its own and nothing past the folder before the deadline; its own test in the folder at the deadline, whose answer is the folder\'s', async () => {
    good.add(`${GOOD}\\tool.exe`.toLowerCase())
    anotherWalksTest()
    await flush()
    const walk = findOnWindowsPathAsync(['tool.exe'], { PATH: `${DOWN};${GOOD}` })
    await flush()
    expect(askedInDown()).toEqual(['other.exe'])

    await vi.advanceTimersByTimeAsync(WINDOWS_PATH_WALK_WAIT_MS - 1)
    expect(askedInDown()).toEqual(['other.exe'])
    expect(askedPastDown()).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(askedInDown()).toEqual(['other.exe', 'tool.exe'])
    expect(held).toHaveLength(2)
    expect(askedPastDown()).toEqual([])

    heldFor('tool.exe').found()
    expect(await walk).toBe(`${DOWN}\\tool.exe`)
    expect(mostAtOnce).toBe(2)
    expect(askedPastDown()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutation to prove this can fail: leave the walk's timer running when the walk ends.
  it('a walk that ends before its deadline leaves no timer behind', async () => {
    good.add(`${GOOD}\\tool.exe`.toLowerCase())
    const walk = findOnWindowsPathAsync(['tool.exe'], { PATH: GOOD })
    expect(vi.getTimerCount()).toBe(1)
    expect(await walk).toBe(`${GOOD}\\tool.exe`)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a walk with a file test of the caller\'s own sets no timer', async () => {
    const walk = findOnWindowsPathAsync(['tool.exe'], { PATH: GOOD }, async () => true)
    expect(vi.getTimerCount()).toBe(0)
    expect(await walk).toBe(`${GOOD}\\tool.exe`)
  })
})

describe('Windows: the Claude Code version probe waits behind another walk\'s test until its own deadline, and no longer', () => {
  // Mutation to prove this can fail: give the probe's file test no deadline.
  it('no test of its own and nothing past the folder before the deadline; its own test in the folder at the deadline, whose answer is the folder\'s', async () => {
    good.add(`${GOOD}\\claude.exe`.toLowerCase())
    anotherWalksTest()
    await flush()
    const probe = resolveClaudeExecutable()
    await flush()
    expect(askedInDown()).toEqual(['other.exe'])

    await vi.advanceTimersByTimeAsync(WINDOWS_PATH_WALK_WAIT_MS - 1)
    expect(askedInDown()).toEqual(['other.exe'])
    expect(askedPastDown()).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(askedInDown()).toEqual(['other.exe', 'claude.exe'])
    expect(held).toHaveLength(2)
    expect(askedPastDown()).toEqual([])

    heldFor('claude.exe').found()
    expect(await probe).toBe(`${DOWN}\\claude.exe`)
    expect(mostAtOnce).toBe(2)
    expect(askedPastDown()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutation to prove this can fail: leave the probe's timer running when its walk ends.
  it('a probe whose walk ends before its deadline leaves no timer behind', async () => {
    good.add(`${GOOD}\\claude.exe`.toLowerCase())
    process.env.PATH = GOOD
    const probe = resolveClaudeExecutable()
    await flush()
    expect(await probe).toBe(`${GOOD}\\claude.exe`)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Windows: the check for what would help waits behind another walk\'s test until its own deadline, and no longer', () => {
  // Mutation to prove this can fail: give the check's file test no deadline.
  it('no test of its own before the deadline; its own test in the folder at the deadline, whose answer is the file\'s', async () => {
    anotherWalksTest()
    await flush()
    const first = installFolderDeps().isFile(`${DOWN}\\claude.exe`)
    await flush()
    expect(askedInDown()).toEqual(['other.exe'])

    await vi.advanceTimersByTimeAsync(WINDOWS_PATH_WALK_WAIT_MS - 1)
    expect(askedInDown()).toEqual(['other.exe'])

    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(askedInDown()).toEqual(['other.exe', 'claude.exe'])
    expect(held).toHaveLength(2)

    heldFor('claude.exe').found()
    expect(await first).toBe(true)
    expect(mostAtOnce).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  // Mutation to prove this can fail: leave the check's timer running when its test has answered.
  it('a test that answers before the deadline leaves no timer behind, found or not', async () => {
    good.add(`${GOOD}\\claude.exe`.toLowerCase())
    const isFile = installFolderDeps().isFile
    expect(await isFile(`${GOOD}\\claude.exe`)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(await isFile(`${GOOD}\\claude.cmd`)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Windows: the longest a set of walks takes in one folder that is down', () => {
  // Mutation to prove this can fail: let a third test start in the folder, or
  // give the walks no deadline (they then go one after another).
  it('eight walks, each test there ending after T for a reason that is not handed on: two tests at most, each walk makes its own, and the last answer comes at the deadline plus four times T', async () => {
    const T = 30_000
    const names = ['a.exe', 'b.exe', 'c.exe', 'd.exe', 'e.exe', 'f.exe', 'g.exe', 'h.exe']
    for (const n of names) good.add(`${GOOD}\\${n}`.toLowerCase())
    // UNKNOWN: one of the ways a share that is down answers, and not one of
    // the reasons one walk's test hands on to another's.
    downEnds = { ms: T, code: 'UNKNOWN' }
    const started = Date.now()
    const endedAfter: number[] = []
    const walks = names.map((n, i) => findOnWindowsPathAsync([n], { PATH: `${DOWN};${GOOD}` }).then((found) => {
      endedAfter[i] = Date.now() - started
      return found
    }))

    await vi.advanceTimersByTimeAsync(WINDOWS_PATH_WALK_WAIT_MS + 4 * T)
    await flush()
    // Each walk has the next folder's program: the folder that is down was
    // passed only once the walk's own test there had ended.
    expect(await Promise.all(walks)).toEqual(names.map((n) => `${GOOD}\\${n}`))
    expect(askedInDown().sort()).toEqual(names)
    expect(mostAtOnce).toBe(2)
    const W = WINDOWS_PATH_WALK_WAIT_MS
    expect(endedAfter).toEqual([T, W + T, W + 2 * T, W + 2 * T, W + 3 * T, W + 3 * T, W + 4 * T, W + 4 * T])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the same eight walks when the folder says it cannot be reached: that answer is handed on, and every walk has its answer by the deadline plus T', async () => {
    const T = 30_000
    const names = ['a.exe', 'b.exe', 'c.exe', 'd.exe', 'e.exe', 'f.exe', 'g.exe', 'h.exe']
    for (const n of names) good.add(`${GOOD}\\${n}`.toLowerCase())
    downEnds = { ms: T, code: 'ETIMEDOUT' }
    const started = Date.now()
    const endedAfter: number[] = []
    const walks = names.map((n, i) => findOnWindowsPathAsync([n], { PATH: `${DOWN};${GOOD}` }).then((found) => {
      endedAfter[i] = Date.now() - started
      return found
    }))

    await vi.advanceTimersByTimeAsync(WINDOWS_PATH_WALK_WAIT_MS + T)
    await flush()
    expect(await Promise.all(walks)).toEqual(names.map((n) => `${GOOD}\\${n}`))
    expect(mostAtOnce).toBe(2)
    // The first walk's own test, then one more made at the deadline.
    expect(askedInDown()).toEqual(['a.exe', 'b.exe'])
    expect(Math.max(...endedAfter)).toBe(WINDOWS_PATH_WALK_WAIT_MS + T)
    expect(vi.getTimerCount()).toBe(0)
  })
})
