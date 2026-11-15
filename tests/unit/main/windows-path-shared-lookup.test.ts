// Windows: one shared lookup for every walk of PATH made off the event loop.
//
// A file test in a PATH folder on a share that does not answer holds one of
// the few threads file tests share until it ends, tens of seconds later. The
// walk for Claude Code and the look for node.exe keep to one file test at a
// time in a folder, across every walk (windows-programs.ts folderFileTest).
// The app's other walks did not: the GitHub CLI, npm and the Node.js tools
// check each made file tests of their own, so one folder that is down held a
// thread for each of them (planning #310, item 5).
//
// findOnWindowsPathAsync now makes its file tests through that same shared
// test whenever the caller hands it none of its own. So every walk for a
// program asks a folder one file at a time, a walk that asks for a file
// another walk is already asking for takes that answer, and a walk that
// waited behind a test which ended by saying the folder cannot be reached
// passes the folder without a test of its own. PATH's order still holds: a
// folder that has not answered is waited for, never passed over.
//
// Host-safe: the file test is a stand-in for every path under the made-up
// folder below, so no file of this computer is asked for there; any other
// path is the real call. Nothing is started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'

const { findOnWindowsPathAsync, _resetFolderFileTestForTest } = await import('../../../src/main/windows-programs')
const { ghStartCommand } = await import('../../../src/main/github/gh-program')
const { npmCommand } = await import('../../../src/main/legacy-version-manager')
const { nodeToolsFoundWith } = await import('../../../src/main/node-tools-probe')

const ROOT = 'C:\\ccc-test-shared-lookup-4d9a'
/** A folder on a share that does not answer until the test says so. */
const DOWN = `${ROOT}\\down`
const GOOD = `${ROOT}\\good`
const ENV = (): NodeJS.ProcessEnv => ({ PATH: `${DOWN};${GOOD}`, SystemRoot: 'C:\\Windows' })

/** What the stand-in answers for a file under GOOD: listed is a regular
 *  file, not listed is not there. */
let good = new Set<string>()
/** Every file under ROOT that was asked for, in order. */
let asked: string[] = []
/** The file tests in DOWN that have not ended, by file, each with how to end it. */
let held = new Map<string, Held>()
/** The most file tests that were outstanding in DOWN at one time. */
let mostAtOnce = 0

const inDown = (p: string): boolean => p.toLowerCase().startsWith(`${DOWN.toLowerCase()}\\`)
const askedInDown = (): string[] => asked.filter(inDown)
/** Lets every step that can run now, run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r))
}

beforeEach(() => {
  _resetFolderFileTestForTest()
  good = new Set()
  asked = []
  held = new Map()
  mostAtOnce = 0
  const realStat = fs.promises.stat.bind(fs.promises) as (p: unknown, o?: unknown) => Promise<unknown>
  vi.spyOn(fs.promises, 'stat').mockImplementation(((p: unknown, o?: unknown) => {
    if (typeof p !== 'string' || !p.toLowerCase().startsWith(`${ROOT.toLowerCase()}\\`)) return realStat(p, o)
    asked.push(p)
    if (!inDown(p)) {
      return good.has(p.toLowerCase())
        ? Promise.resolve({ isFile: () => true })
        : Promise.reject(Object.assign(new Error('the file test failed'), { code: 'ENOENT' }))
    }
    return new Promise((resolve, reject) => {
      const key = `${p}#${held.size}`
      const end = (): void => { held.delete(key) }
      held.set(key, {
        found: () => { end(); resolve({ isFile: () => true }) },
        none: () => { end(); reject(Object.assign(new Error('the file test failed'), { code: 'ENOENT' })) },
        fail: (code) => { end(); reject(Object.assign(new Error('the file test failed'), { code })) },
      })
      mostAtOnce = Math.max(mostAtOnce, held.size)
    })
  }) as never)
})
afterEach(async () => {
  // Nothing is left waiting on a folder of this test.
  for (const h of [...held.values()]) h.fail('ENETUNREACH')
  await settle()
  vi.restoreAllMocks()
})

type Held = { found: () => void; none: () => void; fail: (code: string) => void }

/** Ends every file test in DOWN with `end`, also the ones made meanwhile,
 *  until `all` has ended. */
async function endDownUntilDone<T>(all: Promise<T>, end: (test: Held) => void): Promise<T> {
  let done = false
  const result = all.finally(() => { done = true })
  for (let i = 0; i < 200 && !done; i++) {
    for (const test of [...held.values()]) end(test)
    await settle()
  }
  expect(done, 'the walks ended').toBe(true)
  return result
}

/** The walks the app makes for other programs than Claude Code, started
 *  together, as a start-up or an update check starts them. */
function startTheAppsWalks(env: NodeJS.ProcessEnv) {
  return {
    gh: ghStartCommand(['--version'], env, 'win32'),
    npm: npmCommand(['--version'], false, 'win32', env),
    nodeTools: nodeToolsFoundWith({ platform: 'win32', env }),
    git: findOnWindowsPathAsync(['git.exe'], env),
  }
}

describe('Windows: the app\'s walks of PATH for other programs share one file test at a time in a folder', () => {
  // Mutation to prove this can fail: give findOnWindowsPathAsync the plain file test again.
  it('a folder that does not answer holds one file test, however many walks ask it', async () => {
    for (const f of ['gh.exe', 'npm.cmd', 'node.exe', 'git.exe']) good.add(`${GOOD}\\${f}`.toLowerCase())
    const walks = startTheAppsWalks(ENV())
    await settle()
    // Four walks are under way and each has to ask DOWN first. One test is out.
    expect(held.size).toBe(1)
    expect(mostAtOnce).toBe(1)
    expect(askedInDown()).toHaveLength(1)
    // Nothing went past the folder that has not answered.
    expect(asked.filter((p) => !inDown(p))).toEqual([])

    // The folder fails at last, by saying it cannot be reached: that is the
    // answer for every walk that waited there, and none makes a test of its
    // own. (The Node.js tools check then walks once more, for node.exe, and
    // that walk asks the folder for itself: one more test, still one at a time.)
    const [gh, npm, nodeTools, git] = await endDownUntilDone(
      Promise.all([walks.gh, walks.npm, walks.nodeTools, walks.git]),
      (test) => test.fail('ENETUNREACH'),
    )
    expect('refused' in gh ? gh.refused : gh.file).toBe(`${GOOD}\\gh.exe`)
    expect('refused' in npm ? npm.refused : npm.args.join(' ')).toContain(`${GOOD}\\npm.cmd`)
    expect(nodeTools).toBe(true)
    expect(git).toBe(`${GOOD}\\git.exe`)
    expect(mostAtOnce).toBe(1)
    expect(askedInDown().map((p) => p.slice(DOWN.length + 1))).toEqual(['gh.exe', 'node.exe'])
  })

  it('a folder that answers "not there" is asked again by each walk for its own file, still one test at a time', async () => {
    for (const f of ['gh.exe', 'npm.cmd', 'node.exe', 'git.exe']) good.add(`${GOOD}\\${f}`.toLowerCase())
    const walks = startTheAppsWalks(ENV())
    // Each test in DOWN ends with "not there" as soon as it is made.
    const [gh, , nodeTools, git] = await endDownUntilDone(
      Promise.all([walks.gh, walks.npm, walks.nodeTools, walks.git]),
      (test) => test.none(),
    )
    expect(git).toBe(`${GOOD}\\git.exe`)
    expect(nodeTools).toBe(true)
    expect('refused' in gh ? gh.refused : gh.file).toBe(`${GOOD}\\gh.exe`)
    expect(mostAtOnce).toBe(1)
    // Every file each walk needed was asked for in DOWN: nothing was passed over.
    const down = askedInDown().map((p) => p.slice(DOWN.length + 1).toLowerCase())
    for (const f of ['gh.exe', 'npm.exe', 'npm.cmd', 'git.exe']) expect(down, f).toContain(f)
  })

  // Mutation to prove this can fail: start a test for a file another walk is already asking for.
  it('two walks for the same program take one answer', async () => {
    good.add(`${GOOD}\\gh.exe`.toLowerCase())
    const first = findOnWindowsPathAsync(['gh.exe'], ENV())
    const second = findOnWindowsPathAsync(['gh.exe'], ENV())
    await settle()
    expect(askedInDown()).toEqual([`${DOWN}\\gh.exe`])
    for (const h of [...held.values()]) h.none()
    expect(await first).toBe(`${GOOD}\\gh.exe`)
    expect(await second).toBe(`${GOOD}\\gh.exe`)
    expect(askedInDown()).toEqual([`${DOWN}\\gh.exe`])
  })

  it('PATH\'s order holds: a folder that answers late that it holds the program is the answer, not a later folder', async () => {
    good.add(`${GOOD}\\gh.exe`.toLowerCase())
    const walk = findOnWindowsPathAsync(['gh.exe'], ENV())
    await settle()
    // The later folder was not asked while the earlier one had not answered.
    expect(asked).toEqual([`${DOWN}\\gh.exe`])
    for (const h of [...held.values()]) h.found()
    expect(await walk).toBe(`${DOWN}\\gh.exe`)
    expect(asked).toEqual([`${DOWN}\\gh.exe`])
  })

  it('a failure about the one file is not handed to a walk that waited for another file: that walk asks for its own', async () => {
    good.add(`${GOOD}\\gh.exe`.toLowerCase())
    const gh = findOnWindowsPathAsync(['gh.exe'], ENV())
    await settle()
    const git = findOnWindowsPathAsync(['git.exe'], ENV())
    await settle()
    expect(askedInDown()).toEqual([`${DOWN}\\gh.exe`])
    // gh.exe in DOWN cannot be read (in use): that says nothing about git.exe there.
    for (const h of [...held.values()]) h.fail('EBUSY')
    await settle()
    expect(askedInDown()).toEqual([`${DOWN}\\gh.exe`, `${DOWN}\\git.exe`])
    for (const h of [...held.values()]) h.found()
    expect(await git).toBe(`${DOWN}\\git.exe`)
    expect(await gh).toBe(`${GOOD}\\gh.exe`)
  })

  it('a caller\'s own file test is used as it is given', async () => {
    const mine: string[] = []
    const own = async (p: string): Promise<boolean> => { mine.push(p); return p === `${GOOD}\\tool.exe` }
    expect(await findOnWindowsPathAsync(['tool.exe'], ENV(), own)).toBe(`${GOOD}\\tool.exe`)
    expect(mine).toEqual([`${DOWN}\\tool.exe`, `${GOOD}\\tool.exe`])
    expect(asked).toEqual([])
  })
})
