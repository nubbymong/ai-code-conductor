// The Claude Code version probe (claude-cli-version.ts) on Windows walks PATH
// itself, in the launch's order: claude.exe in any folder, then claude.cmd,
// then claude.bat. One program file that cannot be read (access to it is
// denied, or it is in use while an update replaces it) says nothing about the
// file beside it. The probe read any failed file test as "this folder cannot
// be reached" and asked the folder nothing more, so claude.cmd beside a locked
// claude.exe was passed, and a later folder's Claude Code was resolved or none
// at all. A failure known to be about the one file (access denied, permission
// denied, in use) passes that file only now, and every other failure still
// passes the folder, so a share that is down is asked once: the same short
// list as the launch's own walk (windows-programs.ts oneFileCannotBeRead).
//
// Host-safe: the file test is a stand-in for every path under the made-up
// folder below, so no file of this computer is asked for there; any other
// path is the real call. Nothing is started: child_process and the PowerShell
// profile question are mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'

vi.mock('node:child_process', () => ({
  execFile: () => { throw new Error('nothing is started in this test') },
}))
vi.mock('../../../src/main/claude-cli-probe', () => ({
  probeClaudeCli: async () => ({ installed: false, probe: 'login shell' }),
  claudeFromPowerShellProfile: async () => null,
  setClaudeProfileLookupAllowed: () => {},
  CLAUDE_PROFILE_PROBE: 'Windows PowerShell profile',
}))

const { resolveClaudeExecutable, _resetClaudeCliVersionForTest } = await import('../../../src/main/claude-cli-version')

const ROOT = 'C:\\ccc-test-locked-file-7c2e'
const FIRST = `${ROOT}\\first`
const LATER = `${ROOT}\\later`
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedPath = process.env.PATH

/** What the stand-in answers for a file under ROOT: `true` is a regular file,
 *  a string is the error code its test fails with, and a file not listed is
 *  not there. */
let disk = new Map<string, true | string>()
/** Every file under ROOT that was asked for, in order. */
let asked: string[] = []

beforeEach(() => {
  _resetClaudeCliVersionForTest()
  disk = new Map()
  asked = []
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.PATH = `${FIRST};${LATER}`
  const realStat = fs.promises.stat.bind(fs.promises) as (p: unknown, o?: unknown) => Promise<unknown>
  vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: unknown, o?: unknown) => {
    if (typeof p !== 'string' || !p.startsWith(`${ROOT}\\`)) return realStat(p, o)
    asked.push(p)
    const answer = disk.get(p)
    if (answer === true) return { isFile: () => true }
    throw Object.assign(new Error('the file test failed'), { code: answer ?? 'ENOENT' })
  }) as never)
})
afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
})

describe('the Claude Code version probe on Windows, with one program file that cannot be read', () => {
  // Mutation to prove this can fail: answer `unreachable` for every failed
  // file test (the folder is then passed, and the later folder's is resolved).
  it.each(['EPERM', 'EACCES', 'EBUSY'])('claude.exe cannot be read (%s): the claude.cmd beside it is resolved, not a later folder\'s', async (code) => {
    disk.set(`${FIRST}\\claude.exe`, code)
    disk.set(`${FIRST}\\claude.cmd`, true)
    disk.set(`${LATER}\\claude.cmd`, true)
    expect(await resolveClaudeExecutable()).toBe(`${FIRST}\\claude.cmd`)
    expect(asked).toEqual([`${FIRST}\\claude.exe`, `${LATER}\\claude.exe`, `${FIRST}\\claude.cmd`])
  })

  it('with no later copy the claude.cmd beside it is resolved too, where the probe found none', async () => {
    process.env.PATH = FIRST
    disk.set(`${FIRST}\\claude.exe`, 'EPERM')
    disk.set(`${FIRST}\\claude.cmd`, true)
    expect(await resolveClaudeExecutable()).toBe(`${FIRST}\\claude.cmd`)
  })

  it('the file that cannot be read is never resolved itself', async () => {
    process.env.PATH = FIRST
    disk.set(`${FIRST}\\claude.exe`, 'EBUSY')
    expect(await resolveClaudeExecutable()).toBeNull()
    expect(asked).toEqual([`${FIRST}\\claude.exe`, `${FIRST}\\claude.cmd`, `${FIRST}\\claude.bat`])
  })

  // Mutation to prove this can fail: read no failure as the folder's, or only
  // the ones that name the network (a share that is down, and says so with a
  // reason Node.js has no code for, is then waited for once for every name).
  it.each(['EHOSTUNREACH', 'ETIMEDOUT', 'ENETUNREACH', 'UNKNOWN', 'EIO', 'ELOOP', 'EISDIR'])('a folder whose file test fails for any other reason (%s) is still passed once: it is asked for no other name', async (code) => {
    disk.set(`${FIRST}\\claude.exe`, code)
    disk.set(`${FIRST}\\claude.cmd`, true)
    disk.set(`${LATER}\\claude.cmd`, true)
    expect(await resolveClaudeExecutable()).toBe(`${LATER}\\claude.cmd`)
    expect(asked.filter((p) => p.startsWith(FIRST))).toEqual([`${FIRST}\\claude.exe`])
  })

  it.each(['ENOENT', 'ENOTDIR'])('a file that is not there (%s) is "no such file", as before: its folder is still asked for the next name', async (code) => {
    disk.set(`${FIRST}\\claude.exe`, code)
    disk.set(`${FIRST}\\claude.cmd`, true)
    disk.set(`${LATER}\\claude.cmd`, true)
    expect(await resolveClaudeExecutable()).toBe(`${FIRST}\\claude.cmd`)
  })

  // A file that cannot be read ranks exactly as one that is not there, in a
  // LATER folder too. The first folder holds claude.bat alone; the later one
  // a claude.exe that cannot be read, and a claude.cmd. The probe resolves
  // the later folder's claude.cmd: what it resolves when that folder has no
  // claude.exe at all. (Passing the whole later folder, as before, resolved
  // the first folder's claude.bat.)
  it.each(['EPERM', 'EACCES', 'EBUSY'])('a claude.exe that cannot be read (%s) in a later folder ranks as one that is not there: the same answer, asking the same files', async (code) => {
    disk.set(`${FIRST}\\claude.bat`, true)
    disk.set(`${LATER}\\claude.cmd`, true)
    expect(await resolveClaudeExecutable()).toBe(`${LATER}\\claude.cmd`)
    const whenAbsent = [...asked]
    asked = []
    _resetClaudeCliVersionForTest()
    disk.set(`${LATER}\\claude.exe`, code)
    expect(await resolveClaudeExecutable()).toBe(`${LATER}\\claude.cmd`)
    expect(asked).toEqual(whenAbsent)
    expect(asked).toEqual([`${FIRST}\\claude.exe`, `${LATER}\\claude.exe`, `${FIRST}\\claude.cmd`, `${LATER}\\claude.cmd`])
  })

  it('a later folder that cannot be reached is passed, and the first folder\'s claude.bat is resolved, as it always was', async () => {
    disk.set(`${FIRST}\\claude.bat`, true)
    disk.set(`${LATER}\\claude.exe`, 'UNKNOWN')
    disk.set(`${LATER}\\claude.cmd`, true)
    expect(await resolveClaudeExecutable()).toBe(`${FIRST}\\claude.bat`)
    expect(asked.filter((p) => p.startsWith(LATER))).toEqual([`${LATER}\\claude.exe`])
  })
})
