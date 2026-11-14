// [host] An account removed while its sign-in folders are being checked leaves
// no folder behind, whatever file identity the folder made in its place
// reports. The check asks the owner-only rule about a home and waits; the rule
// makes a missing folder before it reads it back, so a home removed during
// that wait is made again by the check itself. The check used to tell that
// from the home's file identity alone ("another folder now, and not listed"),
// and a file system that hands a freed inode number to the next folder made
// (ext4) gives the folder made again the identity of the one removed: nothing
// was dropped, and the removed account kept a folder. A removal is now
// recorded when it happens, and the check drops what is in a removed home's
// place on that record.
//
// The identity alone still decides nothing by itself, and neither does the
// record: a home is dropped only when its account is not listed, and a home
// that was made and never removed is kept while it is not listed yet (an
// account is made before it is listed).
//
// Host-safe: every program start is refused, no link is made (the link calls
// do nothing), no access list is read or changed, and the owner-only rule is
// replaced through the test seam. The folders are real, in a temp folder of
// the test's own. The file identity a profile home reports is replaced where
// a test says so, on the one read the check makes of it (lstat).
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

// The random part of a new account's id (three bytes), fixed where a test
// says so; every other call is the real one.
const pinned = vi.hoisted(() => ({ idBytes: null as string | null }))
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>()
  const randomBytes = ((size: number, ...rest: unknown[]) => (
    pinned.idBytes !== null && size === 3 && rest.length === 0
      ? Buffer.from(pinned.idBytes, 'hex')
      : (real.randomBytes as (...a: unknown[]) => unknown)(size, ...rest)
  )) as typeof real.randomBytes
  return { ...real, randomBytes, default: { ...real, randomBytes } }
})

vi.mock('../../../src/main/debug-logger', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/debug-logger')>()
  return { ...real, logWarn: () => {}, logInfo: () => {}, logError: () => {} }
})

import {
  _setRootsForTest, _setCredentialFolderRuleForTest, getProfilesRoot, getProfileConfigDir, listProfiles, upsertProfile,
  createProfile, captureGlobalLogin, safeTeardownProfile, checkProfileCredentialFolders, credentialFoldersVerdict,
} from '../../../src/main/account-profiles'
import type { AccountProfile } from '../../../src/shared/account-types'

const PREFIX = 'ccc-removed-home-check-'
const A: AccountProfile = { id: 'profile-mabc123-a1b2c3', name: 'Home', accountEmail: 'a@example.com', createdAt: 1 }
const B: AccountProfile = { id: 'profile-mdef456-d4e5f6', name: 'Work', accountEmail: 'b@example.com', createdAt: 2 }
let base = ''

/** Whether `p` is a profile home: a folder named as an account directly inside the accounts folder. */
const isHomePath = (p: string): boolean =>
  path.basename(p).startsWith('profile-') && path.resolve(path.dirname(p)).toLowerCase() === path.resolve(getProfilesRoot()).toLowerCase()

/** The account homes in the accounts folder now. */
const homesLeft = (): string[] => fs.readdirSync(getProfilesRoot()).filter((n) => n.startsWith('profile-')).sort()

/** The file identity a folder reports to the check (the same read, lstat), or null when no folder is there. */
function reportedId(dir: string): string | null {
  try {
    const st = fs.lstatSync(dir, { bigint: true })
    return st.isDirectory() ? `${st.dev}:${st.ino}` : null
  } catch { return null }
}

/** Every folder at a profile home's path reports one file identity: what a
 *  file system that hands a freed inode number to the next folder made does
 *  for a home made where one was just removed. */
function everyHomeReportsOneIdentity(): void {
  const reused = BigInt(4242424242)
  const realLstat = fs.lstatSync
  vi.spyOn(fs, 'lstatSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
    const st = (realLstat as (...a: unknown[]) => unknown)(p, ...rest) as { ino?: unknown } | undefined
    if (st && typeof st.ino === 'bigint' && typeof p === 'string' && isHomePath(p)) st.ino = reused
    return st
  }) as typeof fs.lstatSync)
}

/** The rule as the app's would answer for folders it made owner-only: each
 *  missing one made inside its parent, every one passed. */
const madeAndPassed = (dirs: readonly string[]) => dirs.map((dir) => {
  if (!fs.existsSync(dir) && fs.existsSync(path.dirname(dir))) fs.mkdirSync(dir)
  return { dir, ok: true, detail: 'owner-only' }
})

/** What the rule saw of a home: its identity when asked, whether it was gone
 *  when the answer came (so the rule made it again), and its identity then. */
type Seen = { asked: string | null; goneAtAnswer: boolean; answered: string | null }

/** The rule, answering later (as a Windows PowerShell start does): every call
 *  recorded, each answer held until `release`, a missing folder made then. */
function gatedRule(): { calls: string[][]; seen: Map<string, Seen>; release: () => void; homeAsked: () => string | undefined } {
  const calls: string[][] = []
  const seen = new Map<string, Seen>()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  _setCredentialFolderRuleForTest(async (dirs) => {
    calls.push([...dirs])
    const homes = dirs.filter(isHomePath)
    const asked = homes.map(reportedId)
    await gate
    const gone = homes.map((h) => !fs.existsSync(h))
    const out = madeAndPassed(dirs)
    homes.forEach((h, i) => seen.set(h, { asked: asked[i], goneAtAnswer: gone[i], answered: reportedId(h) }))
    return out
  })
  return { calls, seen, release, homeAsked: () => calls.map((c) => c[0]).find(isHomePath) }
}

/** The premise of a removal test: the rule was asked about the home, found it
 *  gone when it answered and made it again, and the folder it made reported
 *  the identity of the one removed. */
function expectMadeAgainWithTheSameIdentity(seen: Seen | undefined): void {
  expect(seen?.asked).toEqual(expect.any(String))
  expect(seen?.goneAtAnswer).toBe(true)
  expect(seen?.answered).toBe(seen?.asked)
}

/** A listed account with its home and config folder, as a signed-in account has them. */
function listedAccount(p: AccountProfile): string {
  upsertProfile(p)
  const home = getProfileConfigDir(p.id)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  return home
}

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  const resourcesDir = path.join(base, 'res')
  const shared = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true })
  fs.mkdirSync(shared, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot: shared })
  _setCredentialFolderRuleForTest(null)
  // A global sign-in to capture, beside the shared folder.
  fs.writeFileSync(path.join(base, 'home', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }))
  fs.writeFileSync(path.join(shared, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"a-token-value"}}')
  // No link is made in this file: making an account folder gets past these calls and nothing is linked.
  vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {})
  vi.spyOn(fs, 'linkSync').mockImplementation(() => {})
})

afterEach(() => {
  pinned.idBytes = null
  vi.restoreAllMocks()
  _setCredentialFolderRuleForTest(null)
  _setRootsForTest(null)
  // TEST CLEANUP GUARD: this suite's own temp folder only.
  if (path.basename(base).startsWith(PREFIX)) fs.rmSync(base, { recursive: true, force: true })
  base = ''
})

describe('an account removed while its folders are checked leaves no folder, though the folder made in its place reports the removed one\'s identity', () => {
  it('a capture refused while its new home is checked: the home the check makes again goes', async () => {
    everyHomeReportsOneIdentity()
    const rule = gatedRule()
    // No checked home is ready, so the capture's writes wait for the new
    // account's check: nothing is written, and the account is removed.
    expect(captureGlobalLogin()).toBeNull()
    expect(listProfiles()).toEqual([])
    expect(homesLeft()).toEqual([])
    const home = rule.homeAsked()
    expect(home).toBeDefined()
    rule.release()
    await checkProfileCredentialFolders(path.basename(home!))
    expectMadeAgainWithTheSameIdentity(rule.seen.get(home!))
    expect(homesLeft()).toEqual([])
    expect(listProfiles()).toEqual([])
  })

  it('an account the user removes while its folders are checked: the home the check makes again goes', async () => {
    everyHomeReportsOneIdentity()
    const home = listedAccount(A)
    const rule = gatedRule()
    const check = checkProfileCredentialFolders(A.id)
    expect(rule.homeAsked()).toBe(home)
    safeTeardownProfile(A.id)
    expect(homesLeft()).toEqual([])
    rule.release()
    await check
    expectMadeAgainWithTheSameIdentity(rule.seen.get(home))
    expect(homesLeft()).toEqual([])
    expect(listProfiles()).toEqual([])
  })
})

describe('a home is dropped only for an account that is not listed, and never for one that was made and not removed', () => {
  it('a removal that fails before the folder goes leaves the account listed and whole: the check keeps its home', async () => {
    const home = listedAccount(A)
    fs.writeFileSync(path.join(home, 'kept.txt'), 'still here')
    const rule = gatedRule()
    const check = checkProfileCredentialFolders(A.id)
    // The folder cannot be read just then (a file another program holds does
    // that on Windows): the removal throws, and the list is not touched.
    const realReaddir = fs.readdirSync
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && path.resolve(p) === path.resolve(home)) throw Object.assign(new Error('EBUSY: simulated'), { code: 'EBUSY' })
      return (realReaddir as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof fs.readdirSync)
    expect(() => safeTeardownProfile(A.id)).toThrow(/EBUSY/)
    readdir.mockRestore()
    expect(listProfiles().map((p) => p.id)).toEqual([A.id])
    rule.release()
    await check
    expect(fs.readFileSync(path.join(home, 'kept.txt'), 'utf8')).toBe('still here')
    expect(credentialFoldersVerdict([home, path.join(home, '.claude')])).toEqual({ ok: true })
  })

  // An account is made before it is listed (a capture copies the sign-in in
  // between), so a home that is not listed yet is not a removed one. The list
  // write is made to fail here, which leaves the new account exactly there:
  // its home made, its entry not on the list, nothing of it removed.
  it.each([
    ['with an id of its own', false],
    ['with the id of an account removed earlier this run', true],
  ])('an account being made, its home made and its entry not listed yet, keeps its home through the check on it: %s', async (_what, removedBefore) => {
    listedAccount(A)
    const rule = gatedRule()
    if (removedBefore) {
      // B is removed, and the next account made is given B's id.
      listedAccount(B)
      safeTeardownProfile(B.id)
      expect(homesLeft()).toEqual([A.id])
      const [, stamp, bytes] = B.id.split('-')
      vi.spyOn(Date, 'now').mockReturnValue(parseInt(stamp, 36))
      pinned.idBytes = bytes
    }
    // Only the write of the list: it makes sure of the list's own folder
    // first, and that is the one call refused here.
    const realMkdir = fs.mkdirSync
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (typeof p === 'string' && path.resolve(p) === path.resolve(getProfilesRoot())) throw Object.assign(new Error('ENOSPC: simulated'), { code: 'ENOSPC' })
      return (realMkdir as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof fs.mkdirSync)
    expect(() => createProfile('New')).toThrow(/ENOSPC/)
    mkdir.mockRestore()
    if (removedBefore) { vi.mocked(Date.now).mockRestore(); pinned.idBytes = null }
    const home = rule.homeAsked()
    expect(home).toBeDefined()
    if (removedBefore) expect(path.basename(home!)).toBe(B.id)
    expect(listProfiles().map((p) => p.id)).toEqual([A.id])
    expect(reportedId(home!)).not.toBeNull()
    rule.release()
    await checkProfileCredentialFolders(path.basename(home!))
    expect(homesLeft()).toEqual([A.id, path.basename(home!)].sort())
    expect(credentialFoldersVerdict([home!, path.join(home!, '.claude')])).toEqual({ ok: true })
  })
})
