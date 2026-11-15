// The walk of PATH a launch goes through, with its OWN file tests
// (windows-programs.ts isRegularFileSync and isRegularFileAsync): no stand-in
// is passed to findOnWindowsPath or findOnWindowsPathAsync here, so what is
// under test is what the app runs. The other cases of the walk pass a
// stand-in, and so would stay green if the real file tests swallowed a
// failure the walk has to read, or threw for a file that is simply not there.
//
// What the file tests answer, and what the walk makes of it:
// - not there (ENOENT), or below something that is not a folder (ENOTDIR):
//   "no such file", and the folder is asked for the next name;
// - a reason known to be about the one file (EPERM, EACCES, EBUSY): that file
//   is passed, and the one beside it is still found;
// - any other reason (a timeout, a host that is down, a reason Node.js has no
//   code for): the folder is passed, and asked exactly once in the walk.
//
// Host-safe: fs.statSync and fs.promises.stat are stand-ins for every path
// under the made-up folder below, so no file of this computer is asked for
// there; any other path is the real call. PATH is passed in, and names only
// folders under the made-up one. Nothing is started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { findOnWindowsPath, findOnWindowsPathAsync } from '../../../src/main/windows-programs'

const ROOT = 'C:\\ccc-test-own-file-test-3d9a'
const FIRST = `${ROOT}\\first`
const LATER = `${ROOT}\\later`
const NAMES = ['claude.exe', 'claude.cmd', 'claude.bat']
const ENV = { PATH: `${FIRST};${LATER}` }

/** What the stand-ins answer for a path under ROOT: `true` is a regular
 *  file, `'folder'` is something there that is not a file, a string is the
 *  error code the test fails with, and a path not listed is not there. */
let disk = new Map<string, true | string>()
/** Every path under ROOT asked of the one-at-a-time test (fs.statSync), and
 *  of the one off the event loop (fs.promises.stat), in order. */
let askedSync: string[] = []
let askedAsync: string[] = []

function answer(p: string): { isFile: () => boolean } {
  const found = disk.get(p)
  if (found === true) return { isFile: () => true }
  if (found === 'folder') return { isFile: () => false }
  throw Object.assign(new Error('the file test failed'), { code: found ?? 'ENOENT' })
}

beforeEach(() => {
  disk = new Map()
  askedSync = []
  askedAsync = []
  const realStatSync = fs.statSync.bind(fs) as (p: unknown, o?: unknown) => unknown
  vi.spyOn(fs, 'statSync').mockImplementation(((p: unknown, o?: unknown) => {
    if (typeof p !== 'string' || !p.startsWith(`${ROOT}\\`)) return realStatSync(p, o)
    askedSync.push(p)
    return answer(p)
  }) as never)
  const realStat = fs.promises.stat.bind(fs.promises) as (p: unknown, o?: unknown) => Promise<unknown>
  vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: unknown, o?: unknown) => {
    if (typeof p !== 'string' || !p.startsWith(`${ROOT}\\`)) return realStat(p, o)
    askedAsync.push(p)
    return answer(p)
  }) as never)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('the walk in place, with its own file test (findOnWindowsPath, no stand-in)', () => {
  it('finds a regular file by its full path, and asks through fs.statSync only', () => {
    disk.set(`${LATER}\\claude.cmd`, true)
    expect(findOnWindowsPath(NAMES, ENV, undefined, 'name')).toBe(`${LATER}\\claude.cmd`)
    expect(askedSync).toEqual([`${FIRST}\\claude.exe`, `${LATER}\\claude.exe`, `${FIRST}\\claude.cmd`, `${LATER}\\claude.cmd`])
    expect(askedAsync).toEqual([])
  })

  // Mutation to prove this can fail: pass the folder for any failed test.
  it.each(['EPERM', 'EACCES', 'EBUSY'])('claude.exe cannot be read (%s): the claude.cmd beside it is found, not a later folder\'s', (code) => {
    disk.set(`${FIRST}\\claude.exe`, code).set(`${FIRST}\\claude.cmd`, true).set(`${LATER}\\claude.cmd`, true)
    expect(findOnWindowsPath(NAMES, ENV, undefined, 'name')).toBe(`${FIRST}\\claude.cmd`)
    expect(askedSync).toEqual([`${FIRST}\\claude.exe`, `${LATER}\\claude.exe`, `${FIRST}\\claude.cmd`])
    askedSync = []
    // In folder order too (how the helper programs are looked for).
    expect(findOnWindowsPath(NAMES, ENV)).toBe(`${FIRST}\\claude.cmd`)
    expect(askedSync).toEqual([`${FIRST}\\claude.exe`, `${FIRST}\\claude.cmd`])
  })

  // Mutations to prove this can fail: answer "not there" for every failed
  // test in isRegularFileSync (the folder is then asked for every name), or
  // pass only the one file for a reason that is not on the short list.
  it.each(['ETIMEDOUT', 'UNKNOWN', 'EHOSTUNREACH', 'EIO'])('a folder that fails its file test with %s is asked exactly once, in either order, and the later folder\'s program is named', (code) => {
    disk.set(`${FIRST}\\claude.exe`, code).set(`${FIRST}\\claude.cmd`, code).set(`${FIRST}\\claude.bat`, code).set(`${LATER}\\claude.bat`, true)
    expect(findOnWindowsPath(NAMES, ENV, undefined, 'name')).toBe(`${LATER}\\claude.bat`)
    expect(askedSync.filter((p) => p.startsWith(`${FIRST}\\`))).toEqual([`${FIRST}\\claude.exe`])
    askedSync = []
    expect(findOnWindowsPath(NAMES, ENV)).toBe(`${LATER}\\claude.bat`)
    expect(askedSync.filter((p) => p.startsWith(`${FIRST}\\`))).toEqual([`${FIRST}\\claude.exe`])
  })

  // Mutation to prove this can fail: throw for these in isRegularFileSync
  // (the folder is then passed, and its claude.cmd is never asked for).
  it.each(['ENOENT', 'ENOTDIR', 'folder'])('a file that is not there, or is not a file (%s), is "no such file": its folder is still asked for the next name', (how) => {
    disk.set(`${FIRST}\\claude.exe`, how).set(`${FIRST}\\claude.cmd`, true).set(`${LATER}\\claude.cmd`, true)
    expect(findOnWindowsPath(NAMES, ENV, undefined, 'name')).toBe(`${FIRST}\\claude.cmd`)
  })

  it('a file that cannot be read is never named itself', () => {
    disk.set(`${FIRST}\\claude.exe`, 'EPERM')
    expect(findOnWindowsPath(NAMES, { PATH: FIRST }, undefined, 'name')).toBeNull()
    expect(askedSync).toEqual([`${FIRST}\\claude.exe`, `${FIRST}\\claude.cmd`, `${FIRST}\\claude.bat`])
  })
})

describe('the walk off the event loop, with its own file test (findOnWindowsPathAsync, no stand-in)', () => {
  it('finds a regular file by its full path, and asks through fs.promises.stat only', async () => {
    disk.set(`${LATER}\\claude.cmd`, true)
    expect(await findOnWindowsPathAsync(NAMES, ENV, undefined, 'name')).toBe(`${LATER}\\claude.cmd`)
    expect(askedAsync).toEqual([`${FIRST}\\claude.exe`, `${LATER}\\claude.exe`, `${FIRST}\\claude.cmd`, `${LATER}\\claude.cmd`])
    expect(askedSync).toEqual([])
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'])('claude.exe cannot be read (%s): the claude.cmd beside it is found, not a later folder\'s', async (code) => {
    disk.set(`${FIRST}\\claude.exe`, code).set(`${FIRST}\\claude.cmd`, true).set(`${LATER}\\claude.cmd`, true)
    expect(await findOnWindowsPathAsync(NAMES, ENV, undefined, 'name')).toBe(`${FIRST}\\claude.cmd`)
    expect(askedAsync).toEqual([`${FIRST}\\claude.exe`, `${LATER}\\claude.exe`, `${FIRST}\\claude.cmd`])
    askedAsync = []
    expect(await findOnWindowsPathAsync(NAMES, ENV)).toBe(`${FIRST}\\claude.cmd`)
    expect(askedAsync).toEqual([`${FIRST}\\claude.exe`, `${FIRST}\\claude.cmd`])
  })

  it.each(['ETIMEDOUT', 'UNKNOWN', 'EHOSTUNREACH', 'EIO'])('a folder that fails its file test with %s is asked exactly once, in either order, and the later folder\'s program is named', async (code) => {
    disk.set(`${FIRST}\\claude.exe`, code).set(`${FIRST}\\claude.cmd`, code).set(`${FIRST}\\claude.bat`, code).set(`${LATER}\\claude.bat`, true)
    expect(await findOnWindowsPathAsync(NAMES, ENV, undefined, 'name')).toBe(`${LATER}\\claude.bat`)
    expect(askedAsync.filter((p) => p.startsWith(`${FIRST}\\`))).toEqual([`${FIRST}\\claude.exe`])
    askedAsync = []
    expect(await findOnWindowsPathAsync(NAMES, ENV)).toBe(`${LATER}\\claude.bat`)
    expect(askedAsync.filter((p) => p.startsWith(`${FIRST}\\`))).toEqual([`${FIRST}\\claude.exe`])
  })

  it.each(['ENOENT', 'ENOTDIR', 'folder'])('a file that is not there, or is not a file (%s), is "no such file": its folder is still asked for the next name', async (how) => {
    disk.set(`${FIRST}\\claude.exe`, how).set(`${FIRST}\\claude.cmd`, true).set(`${LATER}\\claude.cmd`, true)
    expect(await findOnWindowsPathAsync(NAMES, ENV, undefined, 'name')).toBe(`${FIRST}\\claude.cmd`)
  })

  it('a file that cannot be read is never named itself', async () => {
    disk.set(`${FIRST}\\claude.exe`, 'EBUSY')
    expect(await findOnWindowsPathAsync(NAMES, { PATH: FIRST }, undefined, 'name')).toBeNull()
    expect(askedAsync).toEqual([`${FIRST}\\claude.exe`, `${FIRST}\\claude.cmd`, `${FIRST}\\claude.bat`])
  })
})
