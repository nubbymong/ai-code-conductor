// Windows: the Claude Code version probe and the "what would help" check
// after a check found no CLI ask their file tests through the shared one
// (windows-programs.ts folderFileTest), as every other walk of PATH for a
// program does (tests/unit/main/windows-path-shared-lookup.test.ts).
//
// The version probe keeps a walk of its own (claude.exe in any folder, then
// claude.cmd, then claude.bat) and made its own file tests, so a folder on a
// share that is down held one more thread for it, and one more for each name
// the check after a failed lookup asked for.
//
// Host-safe: the file test is a stand-in for every path under the made-up
// folder below; any other path is the real call. Nothing is started:
// child_process and the PowerShell profile question are mocked.
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
const { findOnWindowsPathAsync, _resetFolderFileTestForTest } = await import('../../../src/main/windows-programs')
const { installFolderDeps } = await import('../../../src/main/install-folder-path')

const ROOT = 'C:\\ccc-test-shared-lookup-8e1c'
/** A folder on a share that does not answer until the test says so. */
const DOWN = `${ROOT}\\down`
const GOOD = `${ROOT}\\good`
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedPath = process.env.PATH

type Held = { found: () => void; none: () => void; fail: (code: string) => void }
let good = new Set<string>()
let asked: string[] = []
let held = new Map<string, Held>()
let mostAtOnce = 0

const inDown = (p: string): boolean => p.toLowerCase().startsWith(`${DOWN.toLowerCase()}\\`)
const askedInDown = (): string[] => asked.filter(inDown).map((p) => p.slice(DOWN.length + 1))
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r))
}
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

beforeEach(() => {
  _resetClaudeCliVersionForTest()
  _resetFolderFileTestForTest()
  good = new Set()
  asked = []
  held = new Map()
  mostAtOnce = 0
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.PATH = `${DOWN};${GOOD}`
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
      const key = `${p}#${asked.length}`
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
  for (const test of [...held.values()]) test.fail('ENETUNREACH')
  await settle()
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
})

describe('Windows: the Claude Code version probe asks through the shared file test', () => {
  // Mutation to prove this can fail: give the probe its own file test again.
  it('it makes no test of its own in a folder another walk is waiting on, and passes the folder once that test says it cannot be reached', async () => {
    good.add(`${GOOD}\\claude.exe`.toLowerCase())
    good.add(`${GOOD}\\gh.exe`.toLowerCase())
    const gh = findOnWindowsPathAsync(['gh.exe'], { PATH: process.env.PATH })
    await settle()
    const probe = resolveClaudeExecutable()
    await settle()
    expect(askedInDown()).toEqual(['gh.exe'])
    expect(held.size).toBe(1)
    const [found] = await endDownUntilDone(Promise.all([probe, gh]), (test) => test.fail('ENETUNREACH'))
    expect(found).toBe(`${GOOD}\\claude.exe`)
    // The folder was asked once in all: the probe took that answer for it.
    expect(askedInDown()).toEqual(['gh.exe'])
    expect(mostAtOnce).toBe(1)
  })

  it('with the folder to itself it still asks it for each name, in its order, and waits for each answer', async () => {
    good.add(`${GOOD}\\claude.cmd`.toLowerCase())
    const probe = resolveClaudeExecutable()
    await settle()
    expect(askedInDown()).toEqual(['claude.exe'])
    expect(asked.filter((p) => !inDown(p))).toEqual([])
    expect(await endDownUntilDone(probe, (test) => test.none())).toBe(`${GOOD}\\claude.cmd`)
    // claude.exe in every folder, then claude.cmd in every folder.
    expect(asked.map((p) => p.slice(ROOT.length + 1))).toEqual(['down\\claude.exe', 'good\\claude.exe', 'down\\claude.cmd', 'good\\claude.cmd'])
    expect(mostAtOnce).toBe(1)
  })
})

describe('Windows: the check for what would help after a lookup found nothing asks through the shared file test', () => {
  // Mutation to prove this can fail: give the check its own file test again.
  it('its file test waits behind another walk\'s test in the folder, and a folder that cannot be reached answers "not a file"', async () => {
    const gh = findOnWindowsPathAsync(['gh.exe'], { PATH: `${DOWN}` })
    await settle()
    const isFile = installFolderDeps().isFile
    const first = isFile(`${DOWN}\\claude.exe`)
    await settle()
    expect(askedInDown()).toEqual(['gh.exe'])
    for (const test of [...held.values()]) test.fail('ENETUNREACH')
    expect(await first).toBe(false)
    expect(await gh).toBeNull()
    expect(askedInDown()).toEqual(['gh.exe'])
    // And a file that is there answers true.
    good.add(`${GOOD}\\claude.exe`.toLowerCase())
    expect(await isFile(`${GOOD}\\claude.exe`)).toBe(true)
    expect(await isFile(`${GOOD}\\claude.cmd`)).toBe(false)
  })
})
