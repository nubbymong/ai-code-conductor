// [host] aicc_planning B1 (from #307): profiles.json is never written back from
// a failed read. The three writers of the saved accounts list (upsertProfile,
// deleteProfileMeta, setPrimaryProfile) used to read it through listProfiles,
// which answers ANY failure with an empty list, and then saved what they were
// given: one read that failed while another program held the file, and the
// next account edit replaced every saved account with the one being edited.
// They now read strictly: no file is an empty list (the file is made), a file
// that did not read completely is left byte for byte as it is and the writer
// throws ProfilesUnreadableError, and every other top-level key is kept.
//
// Host-safe: the writers only read and write profiles.json, here in a temp
// folder of the test's own. Every program start is refused, no link is made
// (a link call is refused too) and no access list is read or changed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const no = (file: unknown) => { throw new Error(`no process in this test: ${String(file)}`) }
  const stubs = { execFileSync: vi.fn(no), execFile: vi.fn(no), spawn: vi.fn(no), spawnSync: vi.fn(no), execSync: vi.fn(no), exec: vi.fn(no), fork: vi.fn(no) }
  return { ...real, ...stubs, default: { ...real, ...stubs } }
})

const logs = vi.hoisted(() => ({ warn: [] as string[] }))
vi.mock('../../../src/main/debug-logger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/debug-logger')>()
  return { ...real, logWarn: (...a: unknown[]) => { logs.warn.push(a.map(String).join(' ')) }, logInfo: () => {}, logError: () => {} }
})

import {
  _setRootsForTest, getProfilesRoot, getProfileConfigDir, listProfiles, readProfilesStrict,
  upsertProfile, deleteProfileMeta, setPrimaryProfile, createProfile, safeTeardownProfile,
  healPlaceholderNames, ProfilesUnreadableError,
} from '../../../src/main/account-profiles'
import type { AccountProfile } from '../../../src/shared/account-types'

const A: AccountProfile = { id: 'profile-a1', name: 'Home', accountEmail: 'a@example.com', createdAt: 1, isPrimary: true }
const B: AccountProfile = { id: 'profile-b2', name: 'Work', accountEmail: 'b@example.com', createdAt: 2 }
const C: AccountProfile = { id: 'profile-c3', name: 'New', accountEmail: '', createdAt: 3 }
const TWO = JSON.stringify({ profiles: [A, B] }, null, 2)

let tmp = ''
let file = ''
const realRead = fs.readFileSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-b1-'))
  _setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'shared') })
  file = path.join(getProfilesRoot(), 'profiles.json')
  logs.warn.length = 0
  // No link is made in this file, whatever the code under test does.
  vi.spyOn(fs, 'symlinkSync').mockImplementation(() => { throw new Error('no link in this test') })
})
afterEach(() => {
  vi.restoreAllMocks()
  _setRootsForTest(null)
  if (tmp && path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

/** profiles.json with `text` in it, and those bytes. */
function seed(text: string): Buffer {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return realRead(file)
}

/** Every read of profiles.json from now on fails as a file another program
 *  holds; every other read is the real one. `passFirst` reads still succeed. */
function failReadsOfProfiles(code: string, passFirst = 0): void {
  let passed = 0
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (typeof p === 'string' && path.resolve(p) === path.resolve(file) && passed++ >= passFirst) {
      throw Object.assign(new Error(`${code}: simulated, open '${p}'`), { code })
    }
    return (realRead as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof fs.readFileSync)
}

/** The file is exactly `before`, and nothing was left beside it. */
function expectUntouched(before: Buffer): void {
  vi.mocked(fs.readFileSync).mockRestore?.()
  expect(realRead(file).equals(before), 'profiles.json changed').toBe(true)
  expect(fs.readdirSync(path.dirname(file))).toEqual(['profiles.json'])
}

/** What the call threw, or undefined when it returned. */
function caughtFrom(run: () => void): unknown {
  try { run() } catch (e) { return e }
  return undefined
}

const WRITERS: Array<[string, () => void]> = [
  ['upsertProfile', () => upsertProfile(C)],
  ['deleteProfileMeta', () => deleteProfileMeta(A.id)],
  ['setPrimaryProfile', () => setPrimaryProfile(B.id)],
]

describe.each(WRITERS)('%s never writes profiles.json back from a failed read (B1)', (_name, write) => {
  it.each(['EBUSY', 'EPERM', 'EACCES'])('a read that fails with %s: the named error, and the two saved accounts stay byte for byte', (code) => {
    const before = seed(TWO)
    failReadsOfProfiles(code)
    const thrown = caughtFrom(write)
    // The file first: this is the loss the ticket is about.
    expectUntouched(before)
    expect(listProfiles().map((p) => p.id)).toEqual([A.id, B.id])
    expect(thrown).toBeInstanceOf(ProfilesUnreadableError)
  })

  it.each([
    ['cut short', TWO.slice(0, TWO.length - 40)],
    ['empty', ''],
    ['not an object', '[]'],
    ['without a profiles list', JSON.stringify({ accounts: [A, B] })],
    ['with a profiles key that is not a list', JSON.stringify({ profiles: { [A.id]: A } })],
  ])('a file that is %s: the named error, and the file stays byte for byte', (_what, text) => {
    const before = seed(text)
    const thrown = caughtFrom(write)
    expectUntouched(before)
    expect(thrown).toBeInstanceOf(ProfilesUnreadableError)
  })

  it('the error names itself and says the change was not saved', () => {
    seed('{ not json')
    let caught: unknown
    try { write() } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(ProfilesUnreadableError)
    expect(caught).toBeInstanceOf(Error)
    expect((caught as ProfilesUnreadableError).name).toBe('ProfilesUnreadableError')
    expect((caught as ProfilesUnreadableError).code).toBe('PROFILES_UNREADABLE')
    expect((caught as Error).message).toMatch(/could not be read/)
    expect((caught as Error).message).toMatch(/not saved/)
  })
})

describe('the three writers on a file that reads (B1)', () => {
  it('no file yet is an empty list: upsertProfile makes it, with the one account', () => {
    expect(fs.existsSync(file)).toBe(false)
    upsertProfile(C)
    expect(JSON.parse(realRead(file, 'utf8'))).toEqual({ profiles: [C] })
    expect(listProfiles()).toEqual([C])
  })

  it('no file yet: deleteProfileMeta and setPrimaryProfile make an empty list, as they did', () => {
    deleteProfileMeta(A.id)
    expect(JSON.parse(realRead(file, 'utf8'))).toEqual({ profiles: [] })
    fs.rmSync(file)
    setPrimaryProfile(A.id)
    expect(JSON.parse(realRead(file, 'utf8'))).toEqual({ profiles: [] })
  })

  it('they still do what they did: add or replace by id, remove by id, mark exactly one primary', () => {
    seed(TWO)
    upsertProfile(C)
    expect(listProfiles().map((p) => p.id)).toEqual([A.id, B.id, C.id])
    upsertProfile({ ...A, name: 'Renamed' })
    expect(listProfiles().map((p) => `${p.id}:${p.name}`)).toEqual([`${B.id}:Work`, `${C.id}:New`, `${A.id}:Renamed`])
    setPrimaryProfile(B.id)
    expect(listProfiles().filter((p) => p.isPrimary).map((p) => p.id)).toEqual([B.id])
    deleteProfileMeta(B.id)
    expect(listProfiles().map((p) => p.id)).toEqual([C.id, A.id])
  })

  it('a top-level key the app does not know survives all three, in its place', () => {
    seed(JSON.stringify({ schema: 2, note: { kept: true, list: [1, 2] }, profiles: [A, B], trailing: 'x' }, null, 2))
    const others = () => {
      const top = JSON.parse(realRead(file, 'utf8')) as Record<string, unknown>
      expect(Object.keys(top)).toEqual(['schema', 'note', 'profiles', 'trailing'])
      return { schema: top.schema, note: top.note, trailing: top.trailing }
    }
    const kept = { schema: 2, note: { kept: true, list: [1, 2] }, trailing: 'x' }
    upsertProfile(C)
    expect(others()).toEqual(kept)
    expect(listProfiles().map((p) => p.id)).toEqual([A.id, B.id, C.id])
    deleteProfileMeta(A.id)
    expect(others()).toEqual(kept)
    expect(listProfiles().map((p) => p.id)).toEqual([B.id, C.id])
    setPrimaryProfile(C.id)
    expect(others()).toEqual(kept)
    expect(listProfiles().filter((p) => p.isPrimary).map((p) => p.id)).toEqual([C.id])
  })

  it('an entry of the list that is not a profile object goes back as it was', () => {
    seed(JSON.stringify({ profiles: [A, null, 'stray', B] }))
    upsertProfile(C)
    setPrimaryProfile(B.id)
    deleteProfileMeta(A.id)
    const list = (JSON.parse(realRead(file, 'utf8')) as { profiles: unknown[] }).profiles
    expect(list).toEqual([null, 'stray', { ...B, isPrimary: true }, { ...C, isPrimary: false }])
  })
})

describe('callers of the writers, with a list that cannot be read (B1)', () => {
  it('createProfile throws the named error before it makes anything: no folder, no link, the file untouched', () => {
    const before = seed('{ "profiles": [ {"id": "profile-a1"')
    expect(() => createProfile('Another')).toThrow(ProfilesUnreadableError)
    expectUntouched(before)
    expect(vi.mocked(fs.symlinkSync)).not.toHaveBeenCalled()
  })

  it('safeTeardownProfile throws the named error before it removes the account folder', () => {
    const before = seed('{ "profiles": [ {"id": "profile-a1"')
    const home = getProfileConfigDir(A.id)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'kept.txt'), 'still here')
    expect(() => safeTeardownProfile(A.id)).toThrow(ProfilesUnreadableError)
    expect(realRead(path.join(home, 'kept.txt'), 'utf8')).toBe('still here')
    expect(realRead(file).equals(before)).toBe(true)
  })

  it('safeTeardownProfile still removes the folder and the entry when the list reads', () => {
    seed(TWO)
    const home = getProfileConfigDir(B.id)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'gone.txt'), 'x')
    safeTeardownProfile(B.id)
    expect(fs.existsSync(home)).toBe(false)
    expect(readProfilesStrict()?.map((p) => p.id)).toEqual([A.id])
  })

  it('a start-up step (healPlaceholderNames) logs it once per write and goes on: nothing thrown, nothing written', () => {
    const before = seed(JSON.stringify({ profiles: [{ ...A, name: 'New account' }, { ...B, name: 'New account' }] }, null, 2))
    // Its own read of the list succeeds; each writer's read after that fails.
    failReadsOfProfiles('EBUSY', 1)
    expect(() => healPlaceholderNames()).not.toThrow()
    expectUntouched(before)
    expect(logs.warn).toHaveLength(2)
    for (const line of logs.warn) {
      expect(line).toMatch(/^\[profiles\] placeholder-name heal: /)
      expect(line).toMatch(/could not be read/)
    }
  })

  it('healPlaceholderNames still heals when the list reads, and an error that is not this one is still the caller\'s', () => {
    seed(JSON.stringify({ profiles: [{ ...A, name: 'New account' }, B] }))
    healPlaceholderNames()
    expect(listProfiles().map((p) => p.name)).toEqual(['Work', ''])
    expect(logs.warn).toEqual([])
    // Any other failure of the write goes on to the caller, as it always did.
    seed(JSON.stringify({ profiles: [{ ...A, name: 'New account' }] }))
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => { throw Object.assign(new Error('ENOSPC: simulated'), { code: 'ENOSPC' }) })
    expect(() => healPlaceholderNames()).toThrow(/ENOSPC/)
  })
})
