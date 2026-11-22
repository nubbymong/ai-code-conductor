// [host] An edited Claude account keeps its place in the saved list
// (aicc_planning#383). Every edit of an account (made inactive or active,
// renamed, a sign-in refreshed) used to take its record out of profiles.json
// and put it on the end, so every list read in saved order (Settings, the
// switch-account menu, Account usage, the launch chooser) reordered after an
// edit. An edit now replaces the record where it stands; only an account that
// is not listed yet goes on the end.
//
// Not checked here: the screens that read the list (their own tests keep
// them steady), and a new account made by createProfile or a capture, which
// account-profiles-strict-writers.test.ts already asserts goes on the end.
//
// Host-safe: only profiles.json in a temp folder of the test's own is written.
// Every program start is refused, no link is made and no access list is read
// or changed.
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

vi.mock('../../../src/main/debug-logger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/debug-logger')>()
  return { ...real, logWarn: () => {}, logInfo: () => {}, logError: () => {} }
})

import {
  _setRootsForTest, getProfilesRoot, getProfileConfigDir, listProfiles, upsertProfile,
  healPlaceholderNames, migrateProfilesToHomeLayout,
} from '../../../src/main/account-profiles'
import { seedProfiles } from './profiles-file-helpers'
import type { AccountProfile } from '../../../src/shared/account-types'

const A: AccountProfile = { id: 'profile-a1', name: 'Home', accountEmail: 'a@example.com', createdAt: 1, isPrimary: true }
const B: AccountProfile = { id: 'profile-b2', name: 'Work', accountEmail: 'b@example.com', createdAt: 2 }
const C: AccountProfile = { id: 'profile-c3', name: 'Side', accountEmail: 'c@example.com', createdAt: 3 }
const D: AccountProfile = { id: 'profile-d4', name: 'New', accountEmail: '', createdAt: 4 }
const THREE = [A, B, C]

let tmp = ''
let file = ''
const realRead = fs.readFileSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-accounts-place-'))
  _setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'shared') })
  file = path.join(getProfilesRoot(), 'profiles.json')
  vi.spyOn(fs, 'symlinkSync').mockImplementation(() => { throw new Error('no link in this test') })
  vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw new Error('no link in this test') })
})
afterEach(() => {
  vi.restoreAllMocks()
  _setRootsForTest(null)
  if (tmp && path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

const seed = (profiles: unknown[], more: Record<string, unknown> = {}): void => {
  seedProfiles(file, JSON.stringify({ ...more, profiles }, null, 2))
}
const ids = (): string[] => listProfiles().map((p) => p.id)
const onDisk = (): Record<string, unknown> => JSON.parse(realRead(file, 'utf8')) as Record<string, unknown>

describe('upsertProfile: an account that is listed is replaced where it stands', () => {
  it.each([
    ['first', A],
    ['middle', B],
    ['last', C],
  ])('editing the %s account leaves every account where it was, and only that record changes', (_where, edited) => {
    seed(THREE)
    upsertProfile({ ...edited, name: 'Renamed' })
    expect(ids()).toEqual([A.id, B.id, C.id])
    expect(listProfiles()).toEqual(THREE.map((p) => (p.id === edited.id ? { ...p, name: 'Renamed' } : p)))
  })

  it.each([
    ['first', A],
    ['middle', B],
    ['last', C],
  ])('making the %s account inactive and active again moves nothing, at either step', (_where, edited) => {
    seed(THREE)
    upsertProfile({ ...edited, active: false })
    expect(ids()).toEqual([A.id, B.id, C.id])
    expect(listProfiles().find((p) => p.id === edited.id)?.active).toBe(false)
    upsertProfile({ ...edited, active: true })
    expect(ids()).toEqual([A.id, B.id, C.id])
    expect(listProfiles().find((p) => p.id === edited.id)?.active).toBe(true)
  })

  it('a refreshed sign-in (the email set) keeps the place', () => {
    seed([A, { ...B, accountEmail: '' }, C])
    upsertProfile({ ...B, accountEmail: 'fresh@example.com' })
    expect(listProfiles().map((p) => `${p.id}:${p.accountEmail}`)).toEqual([`${A.id}:${A.accountEmail}`, `${B.id}:fresh@example.com`, `${C.id}:${C.accountEmail}`])
  })

  it('the record is replaced whole, at the same place: a field the new record does not carry is gone', () => {
    seed([A, { ...B, active: false }, C])
    upsertProfile(B)
    expect(listProfiles()[1]).toEqual(B)
    expect(Object.keys(listProfiles()[1])).not.toContain('active')
  })

  it('two records with one id (a hand-edited file): one is left, at the first one\'s place', () => {
    seed([A, B, { ...A, name: 'Second copy' }, C])
    upsertProfile({ ...A, name: 'Renamed' })
    expect(listProfiles().map((p) => `${p.id}:${p.name}`)).toEqual([`${A.id}:Renamed`, `${B.id}:Work`, `${C.id}:Side`])
  })
})

describe('upsertProfile: an account that is not listed goes on the end', () => {
  it('a new account is appended after every other', () => {
    seed(THREE)
    upsertProfile(D)
    expect(ids()).toEqual([A.id, B.id, C.id, D.id])
    expect(listProfiles()).toEqual([...THREE, D])
  })

  it('a new account into a list with no accounts, and into no file at all', () => {
    seed([])
    upsertProfile(D)
    expect(listProfiles()).toEqual([D])
    fs.rmSync(file)
    upsertProfile(A)
    expect(listProfiles()).toEqual([A])
  })

  it('an account added after an edit still goes last: the edit did not make "last" mean anything', () => {
    seed(THREE)
    upsertProfile({ ...A, name: 'Renamed' })
    upsertProfile(D)
    expect(ids()).toEqual([A.id, B.id, C.id, D.id])
  })
})

describe('an edit changes nothing else in the file', () => {
  it('every other top-level key, and every entry that is not a profile object, stays exactly where it was', () => {
    seed([null, A, 'stray', B, 7, C], { schema: 2, note: { kept: true, list: [1, 2] } })
    const before = onDisk()
    upsertProfile({ ...B, name: 'Renamed' })
    const after = onDisk()
    expect(Object.keys(after)).toEqual(['schema', 'note', 'profiles'])
    expect(after.schema).toBe(2)
    expect(after.note).toEqual(before.note)
    expect(after.profiles).toEqual([null, A, 'stray', { ...B, name: 'Renamed' }, 7, C])
  })

  it('a new account goes after the entries that are not profile objects too, and they are all kept', () => {
    seed([null, A, 'stray'], { schema: 2 })
    upsertProfile(B)
    expect(onDisk().profiles).toEqual([null, A, 'stray', B])
  })
})

describe('the other writers that edit an account in place keep its place', () => {
  it('healPlaceholderNames: the accounts it heals stay where they were', () => {
    seed([{ ...A, name: 'New account' }, B, { ...C, name: 'New account' }])
    healPlaceholderNames()
    expect(listProfiles().map((p) => `${p.id}:${p.name}`)).toEqual([`${A.id}:`, `${B.id}:Work`, `${C.id}:`])
  })

  it('migrateProfilesToHomeLayout: the account whose email it resets stays where it was', () => {
    seed(THREE)
    // The first account is on the old layout (sign-in files, no .claude folder);
    // the others are on the new one, so they are passed over.
    const old = getProfileConfigDir(A.id)
    fs.mkdirSync(old, { recursive: true })
    fs.writeFileSync(path.join(old, '.claude.json'), '{}')
    for (const p of [B, C]) fs.mkdirSync(path.join(getProfileConfigDir(p.id), '.claude'), { recursive: true })
    migrateProfilesToHomeLayout()
    expect(listProfiles().map((p) => `${p.id}:${p.accountEmail}`)).toEqual([`${A.id}:`, `${B.id}:${B.accountEmail}`, `${C.id}:${C.accountEmail}`])
  })
})
