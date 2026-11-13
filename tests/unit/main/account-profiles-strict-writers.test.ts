// [host] profiles.json is never written back from a failed read. The three
// writers of the saved accounts list (upsertProfile,
// deleteProfileMeta, setPrimaryProfile) used to read it through listProfiles,
// which answers ANY failure with an empty list, and then saved what they were
// given: one read that failed while another program held the file, and the
// next account edit replaced every saved account with the one being edited.
// They now read strictly: no file is an empty list (the file is made), a file
// that did not read completely is left byte for byte as it is and the writer
// throws ProfilesUnreadableError, and every other top-level key is kept. A
// caller with a step it cannot take back reads the list once, before the step,
// and writes from that read, so nothing can stop reading in between.
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
  _setRootsForTest, getProfilesRoot, getProfileConfigDir, listProfiles, readProfilesStrict, updateProfilesStrict,
  upsertProfile, deleteProfileMeta, setPrimaryProfile, createProfile, safeTeardownProfile, captureGlobalLogin,
  healPlaceholderNames, migrateProfilesToHomeLayout, migrateProfilesToCanonicalLayout,
  ProfilesUnreadableError, PROFILES_UNREADABLE,
} from '../../../src/main/account-profiles'
import { seedProfiles, failProfileReads } from './profiles-file-helpers'
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

const seed = (text: string): Buffer => seedProfiles(file, text)
const failReadsOfProfiles = (code: string, after: 'now' | 'after-one-read' = 'now'): void => failProfileReads(file, code, after)

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

describe.each(WRITERS)('%s never writes profiles.json back from a failed read', (_name, write) => {
  it.each(['EBUSY', 'EPERM', 'EACCES'])('a read that fails with %s: the named error, and the two saved accounts stay byte for byte', (code) => {
    const before = seed(TWO)
    failReadsOfProfiles(code)
    const thrown = caughtFrom(write)
    // The file first: losing the saved accounts is what this guards.
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

  it('the error is one fixed sentence: it names the file, never its path, and says nothing was changed', () => {
    seed('{ not json')
    const caught = caughtFrom(write)
    expect(caught).toBeInstanceOf(ProfilesUnreadableError)
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(PROFILES_UNREADABLE)
    expect(PROFILES_UNREADABLE).toBe('The accounts list (profiles.json) could not be read, so nothing was changed.')
    expect(PROFILES_UNREADABLE).not.toContain(tmp)
  })
})

describe('one parser for every reader and writer of the list', () => {
  const BOM = String.fromCharCode(0xfeff)

  it('a byte-order mark before the text is passed over: the list reads, and a writer edits it', () => {
    seed(BOM + TWO)
    expect(listProfiles().map((p) => p.id)).toEqual([A.id, B.id])
    expect(readProfilesStrict()?.map((p) => p.id)).toEqual([A.id, B.id])
    upsertProfile(C)
    expect(updateProfilesStrict((all) => { all[0].name = 'Edited'; return true })).toBe(true)
    expect(listProfiles().map((p) => `${p.id}:${p.name}`)).toEqual([`${A.id}:Edited`, `${B.id}:Work`, `${C.id}:New`])
  })

  it.each([
    ['cut short', TWO.slice(0, TWO.length - 40)],
    ['empty', ''],
    ['not an object', '[]'],
    ['with a profiles key that is not a list', JSON.stringify({ profiles: { [A.id]: A } })],
  ])('a file that is %s: an empty list to a reader, null to the strict read, false to the strict edit, untouched', (_what, text) => {
    const before = seed(text)
    expect(listProfiles()).toEqual([])
    expect(readProfilesStrict()).toBeNull()
    expect(updateProfilesStrict(() => true)).toBe(false)
    expectUntouched(before)
  })

  it('no file: an empty list to both reads, and the strict edit answers false without making one', () => {
    expect(listProfiles()).toEqual([])
    expect(readProfilesStrict()).toEqual([])
    expect(updateProfilesStrict(() => true)).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('the three writers on a file that reads', () => {
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

describe('callers of the writers, with a list that cannot be read', () => {
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

  it('safeTeardownProfile reads the list once: a list that stops reading after that read cannot stop the removal half-way', () => {
    seed(TWO)
    const home = getProfileConfigDir(B.id)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'gone.txt'), 'x')
    failReadsOfProfiles('EBUSY', 'after-one-read')
    safeTeardownProfile(B.id)
    vi.mocked(fs.readFileSync).mockRestore()
    expect(fs.existsSync(home)).toBe(false)
    expect(readProfilesStrict()?.map((p) => p.id)).toEqual([A.id])
  })

  it('captureGlobalLogin throws the named error before it makes anything: no account folder, the file untouched', () => {
    const before = seed('{ "profiles": [ {"id": "profile-a1"')
    // A global sign-in to capture, beside the shared folder.
    fs.mkdirSync(path.join(tmp, 'shared'), { recursive: true })
    fs.writeFileSync(path.join(tmp, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }))
    expect(() => captureGlobalLogin()).toThrow(ProfilesUnreadableError)
    expectUntouched(before)
    expect(vi.mocked(fs.symlinkSync)).not.toHaveBeenCalled()
  })

  it('healPlaceholderNames with a list that cannot be read: nothing thrown, nothing written', () => {
    const before = seed(JSON.stringify({ profiles: [{ ...A, name: 'New account' }] }).slice(0, -3))
    expect(() => healPlaceholderNames()).not.toThrow()
    expectUntouched(before)
  })

  it('healPlaceholderNames reads the list once: every name is healed although the list stops reading after that read', () => {
    seed(JSON.stringify({ profiles: [{ ...A, name: 'New account' }, { ...B, name: 'New account' }] }, null, 2))
    failReadsOfProfiles('EBUSY', 'after-one-read')
    expect(() => healPlaceholderNames()).not.toThrow()
    vi.mocked(fs.readFileSync).mockRestore()
    expect(listProfiles().map((p) => `${p.id}:${p.name}`)).toEqual([`${A.id}:`, `${B.id}:`])
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

describe('the home-layout migration and the accounts list', () => {
  /** An account on the old layout: a home holding its sign-in files and no .claude folder. */
  function oldLayoutHome(id: string): string {
    const home = getProfileConfigDir(id)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, '.claude.json'), '{}')
    fs.writeFileSync(path.join(home, '.credentials.json'), '{}')
    return home
  }
  const signInFiles = (home: string) => ['.claude.json', '.credentials.json'].filter((f) => fs.existsSync(path.join(home, f)))

  it.each([
    ['a read that fails', (text: string) => { const b = seed(text); failReadsOfProfiles('EBUSY'); return b }],
    ['a file cut short', (text: string) => seed(text.slice(0, -5))],
  ])('%s: nothing is migrated for this start, no sign-in file is removed, and the log says so once', (_what, arrange) => {
    const homes = [oldLayoutHome(A.id), oldLayoutHome(B.id)]
    const before = arrange(TWO)
    expect(() => migrateProfilesToHomeLayout()).not.toThrow()
    expect(realRead(file).equals(before)).toBe(true)
    for (const home of homes) {
      expect(signInFiles(home)).toEqual(['.claude.json', '.credentials.json'])
      expect(fs.existsSync(path.join(home, '.claude'))).toBe(false)
    }
    expect(logs.warn).toEqual([`[profiles] home-layout migration skipped: ${PROFILES_UNREADABLE}`])
  })

  it('reads the list once: every email reset is saved although the list stops reading after that read', () => {
    const homes = [oldLayoutHome(A.id), oldLayoutHome(B.id)]
    seed(TWO)
    // The links are best-effort in this step; none is made here.
    vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw new Error('no link in this test') })
    failReadsOfProfiles('EBUSY', 'after-one-read')
    expect(() => migrateProfilesToHomeLayout()).not.toThrow()
    vi.mocked(fs.readFileSync).mockRestore()
    for (const home of homes) expect(signInFiles(home)).toEqual([])
    expect(listProfiles().map((p) => `${p.id}:${p.accountEmail}`).sort()).toEqual([`${A.id}:`, `${B.id}:`])
    expect(logs.warn).toEqual([])
  })
})

describe('an entry of the list that is not a profile object is passed over by the start-up steps', () => {
  it('the two migrations and the name heal do not throw on a null or a stray string, and still do their work', () => {
    seed(JSON.stringify({ profiles: [null, 'stray', 7, { ...A, name: 'New account' }] }))
    expect(() => migrateProfilesToCanonicalLayout()).not.toThrow()
    expect(() => migrateProfilesToHomeLayout()).not.toThrow()
    expect(() => healPlaceholderNames()).not.toThrow()
    const list = (JSON.parse(realRead(file, 'utf8')) as { profiles: unknown[] }).profiles
    expect(list).toEqual([null, 'stray', 7, { ...A, name: '' }])
  })
})
