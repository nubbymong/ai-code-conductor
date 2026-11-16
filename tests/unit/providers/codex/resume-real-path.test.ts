// 2.1.3-beta.6, plan section E: the resume lookup compares a conversation's
// folder by its REAL path too, off the main thread. A conversation started in a
// symlinked folder (or a Windows junction) is recorded under the link or the
// real folder, and the tab keeps the other.
//
// The real path is answered here by a stand-in for fs.promises.realpath, so
// these cases run on every platform with no link made. The same rules with a
// real symlink (macOS, Linux) and a real junction (Windows) are in
// resume-real-path-links.test.ts, which runs in CI.
import { describe, it, expect, vi, afterEach, beforeEach, type Mock } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, dirname, basename, resolve } from 'path'
import { tmpdir } from 'os'

// Wrap the synchronous real-path and stat calls, so a case can say none was
// made. They still do what they did.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const realpathSync = Object.assign(vi.fn(actual.realpathSync), { native: vi.fn(actual.realpathSync.native) })
  const statSync = vi.fn(actual.statSync)
  return { ...actual, realpathSync, statSync, default: { ...actual, realpathSync, statSync } }
})

import * as fs from 'fs'
import {
  warmCodexResume, resolveCodexResume, makeRealPathLookup, sameFolderByRealPath, isLocalAbsolutePath, codexDriveKeyOf,
  findCodexRollouts, chooseCodexRollout, sameDirectory,
  CODEX_WARMED_RESUME_TTL_MS, CODEX_WARMED_RESUME_MAX, CODEX_DISK_SILENT_MS,
  __resetWarmedCodexResumeForTests, __resetCodexDiskMemoryForTests, __warmedCodexResumeCountForTests, __codexRolloutLookupsForTests,
} from '../../../../src/main/providers/codex/rollout-lookup'

const ID = '019dd000-0001-7000-8000-0000000000e1'
const REAL = '/proj/real'
const LINK = '/proj/link'
const LINK2 = '/proj/link-two'
const CONFIGURED = '/proj/configured'

const temps: string[] = []
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'ccc-e1-real-path-')); temps.push(d); return d }
afterEach(() => {
  vi.useRealTimers()
  // Only a folder this file made (its own prefix, directly in the temp folder) is removed.
  for (const d of temps.splice(0)) if (dirname(d) === tmpdir() && /^ccc-e1-real-path-/.test(basename(d))) rmSync(d, { recursive: true, force: true })
})
beforeEach(() => { __resetWarmedCodexResumeForTests(); __resetCodexDiskMemoryForTests() })

/** A rollout recording `cwd`, in the day folder its own time names (so it is "dated"). */
function put(sessionsDir: string, ymd: [string, string, string], id: string, cwd: string): string {
  const dir = join(sessionsDir, ...ymd)
  mkdirSync(dir, { recursive: true })
  const iso = `${ymd[0]}-${ymd[1]}-${ymd[2]}T12:00:00.000Z`
  const file = join(dir, `rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`)
  writeFileSync(file, JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, cwd } }) + '\n')
  return file
}

/** A stand-in for fs.promises.realpath: the folders it knows answer, any other is "not found". */
function fakeReal(known: Record<string, string>): Mock<(p: string) => Promise<string>> {
  return vi.fn(async (p: string) => {
    const hit = known[p]
    if (hit === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    return hit
  })
}
const ALL_ONE_FOLDER = { [REAL]: REAL, [LINK]: REAL, [LINK2]: REAL }

/** The tab's folder is a folder, and not the home folder: the answers a warm-up gets from a normal disk. */
const fine = () => ({ isDirectory: vi.fn(async () => true), homeOrAbove: vi.fn(async () => false) })

type Warm = Parameters<typeof warmCodexResume>[1]
/** A warm-up with every disk answer a stand-in, unless the case gives its own. */
const warm = (target: { uuid: string; cwd: string }, sessionsDir: string, realpath: Warm['realpath'], more: Partial<Warm> = {}): Promise<void> =>
  warmCodexResume(target, { sessionsDir, realpath, ...fine(), ...more })

/** The launch's side: the folders it would otherwise ask the disk about in place are never asked. */
const ctxFor = (sessionsDir: string, more: Record<string, unknown> = {}) => ({
  sessionsDir, configuredCwd: CONFIGURED,
  dirExists: vi.fn((): boolean => { throw new Error('the launch asked the disk in place: dirExists') }),
  homeOrAbove: vi.fn((): boolean => { throw new Error('the launch asked the disk in place: homeOrAbove') }),
  ...more,
})
/** The same, for a launch that has no look to read (it asks in place, as before). */
const ctxInPlace = (sessionsDir: string, more: Record<string, unknown> = {}) => ({ sessionsDir, configuredCwd: CONFIGURED, dirExists: () => true, homeOrAbove: () => false, ...more })

describe('a conversation recorded under the real folder, the tab kept the link', () => {
  it('is resumed in the tab\'s folder, once the look has been made', async () => {
    const sessions = join(temp(), 'sessions')
    const file = put(sessions, ['2026', '09', '01'], ID, REAL)
    await warm({ uuid: ID, cwd: LINK }, sessions, fakeReal(ALL_ONE_FOLDER))
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toEqual({ resumeId: ID, cwd: resolve(LINK), cwdMismatch: false, path: file })
  })

  it('is, without the look, as before: the spelling differs, so it starts in the configured folder and says so', () => {
    const sessions = join(temp(), 'sessions')
    const file = put(sessions, ['2026', '09', '01'], ID, REAL)
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxInPlace(sessions))).toEqual({ resumeId: ID, cwd: CONFIGURED, cwdMismatch: true, path: file })
  })
})

describe('a conversation recorded under the link, the tab kept the real folder', () => {
  it('is resumed in the tab\'s folder, once the look has been made', async () => {
    const sessions = join(temp(), 'sessions')
    const file = put(sessions, ['2026', '09', '01'], ID, LINK)
    await warm({ uuid: ID, cwd: REAL }, sessions, fakeReal(ALL_ONE_FOLDER))
    expect(resolveCodexResume({ uuid: ID, cwd: REAL }, ctxFor(sessions))).toEqual({ resumeId: ID, cwd: resolve(REAL), cwdMismatch: false, path: file })
  })

  it('is, without the look, as before: the configured folder, and says so', () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, LINK)
    expect(resolveCodexResume({ uuid: ID, cwd: REAL }, ctxInPlace(sessions))).toMatchObject({ cwd: CONFIGURED, cwdMismatch: true })
  })
})

describe('two links to one folder', () => {
  it('a conversation recorded under one is resumed from the other', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, LINK2)
    await warm({ uuid: ID, cwd: LINK }, sessions, fakeReal(ALL_ONE_FOLDER))
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwd: resolve(LINK), cwdMismatch: false })
  })
})

describe('a folder that is not the tab\'s, by spelling or by real path', () => {
  it('stays a mismatch: the configured folder, and says so', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, '/proj/elsewhere')
    await warm({ uuid: ID, cwd: LINK }, sessions, fakeReal({ ...ALL_ONE_FOLDER, '/proj/elsewhere': '/proj/elsewhere' }))
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwd: CONFIGURED, cwdMismatch: true })
  })

  it('and a copy that records the tab\'s folder is chosen over one that does not, by real path too', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '02'], ID, '/proj/elsewhere')
    const mine = put(sessions, ['2026', '09', '01'], ID, REAL)
    await warm({ uuid: ID, cwd: LINK }, sessions, fakeReal({ ...ALL_ONE_FOLDER, '/proj/elsewhere': '/proj/elsewhere' }))
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ path: mine, cwd: resolve(LINK), cwdMismatch: false })
  })
})

describe('the exact spelling comes first', () => {
  // Mutation to prove this can fail: resolve the tab's folder before the walk, whatever the spelling says.
  it('a rollout that records the tab\'s folder as spelled makes no real-path call at all', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    const real = fakeReal(ALL_ONE_FOLDER)
    await warm({ uuid: ID, cwd: REAL }, sessions, real)
    expect(real).not.toHaveBeenCalled()
    expect(resolveCodexResume({ uuid: ID, cwd: REAL }, ctxFor(sessions))).toMatchObject({ cwd: resolve(REAL), cwdMismatch: false })
  })

  // Mutation to prove this can fail: ask only for the recorded folders.
  it('only when none matches by spelling, the tab\'s folder and each distinct recorded folder are asked, once each', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '03'], ID, LINK2)
    put(sessions, ['2026', '09', '02'], ID, LINK2)
    put(sessions, ['2026', '09', '01'], ID, REAL)
    const real = fakeReal(ALL_ONE_FOLDER)
    await warm({ uuid: ID, cwd: LINK }, sessions, real)
    expect(real.mock.calls.map((c) => c[0]).sort()).toEqual([LINK, LINK2, REAL].sort())
  })

  it('a copy that matches by spelling ends the look before any is asked, whatever else is recorded', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '02'], ID, '/proj/elsewhere')
    put(sessions, ['2026', '09', '01'], ID, LINK)
    const real = fakeReal(ALL_ONE_FOLDER)
    await warm({ uuid: ID, cwd: LINK }, sessions, real)
    expect(real).not.toHaveBeenCalled()
  })
})

describe('a folder whose real path cannot be had', () => {
  it('is compared by its spelling: no match by link, and an exact spelling still matches', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    const nothing = fakeReal({})
    await warm({ uuid: ID, cwd: LINK }, sessions, nothing)
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwd: CONFIGURED, cwdMismatch: true })
    await warm({ uuid: ID, cwd: REAL }, sessions, nothing)
    expect(resolveCodexResume({ uuid: ID, cwd: REAL }, ctxFor(sessions))).toMatchObject({ cwd: resolve(REAL), cwdMismatch: false })
  })

  it('a stand-in that throws where it is called is the same', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    const broken = vi.fn(() => { throw new Error('boom') }) as unknown as (p: string) => Promise<string>
    await warm({ uuid: ID, cwd: LINK }, sessions, broken)
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwd: CONFIGURED, cwdMismatch: true })
  })

  // Mutation to prove this can fail: wait for the folders one after the other.
  it('ones that do not answer are waited for once, all together, then the spelling decides', async () => {
    vi.useFakeTimers()
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '02'], ID, REAL)
    put(sessions, ['2026', '09', '01'], ID, '/proj/elsewhere')
    // The tab's folder and two recorded folders: none answers.
    const hung = vi.fn(() => new Promise<string>(() => {}))
    let done = false
    const warming = warm({ uuid: ID, cwd: LINK }, sessions, hung, { waitMs: 50 }).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(49)
    expect(done, 'still waiting just before the bound').toBe(false)
    expect(hung).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(2)
    await warming
    expect(done, 'one bound for all three, not one each').toBe(true)
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwd: CONFIGURED, cwdMismatch: true })
  })
})

describe('the real-path lookup', () => {
  it('asks the disk once per spelling, failures included', async () => {
    const real = fakeReal({ [LINK]: REAL })
    const look = makeRealPathLookup({ realpath: real })
    expect(await Promise.all([look(LINK), look(LINK), look(LINK)])).toEqual([REAL, REAL, REAL])
    expect(await look('/proj/missing')).toBeNull()
    expect(await look('/proj/missing')).toBeNull()
    expect(real.mock.calls.map((c) => c[0])).toEqual([LINK, '/proj/missing'])
  })

  it('never asks about a relative spelling or a network share written as a share', async () => {
    const real = fakeReal(ALL_ONE_FOLDER)
    const look = makeRealPathLookup({ realpath: real })
    for (const p of ['proj/link', './link', '', '//server/share/proj', '\\\\server\\share\\proj']) expect(await look(p), p).toBeNull()
    expect(real).not.toHaveBeenCalled()
    expect(isLocalAbsolutePath('/proj/link')).toBe(true)
    expect(isLocalAbsolutePath('C:\\proj\\link')).toBe(true)
    expect(isLocalAbsolutePath('C:/proj/link')).toBe(true)
    expect(isLocalAbsolutePath('//server/share')).toBe(false)
    expect(isLocalAbsolutePath('\\\\server\\share')).toBe(false)
  })

  it('does ask about a mapped drive letter (it looks local), bounded like any other', async () => {
    const real = fakeReal({ 'Z:\\proj': 'Z:\\real' })
    expect(await makeRealPathLookup({ realpath: real })('Z:\\proj')).toBe('Z:\\real')
    expect(real).toHaveBeenCalledTimes(1)
  })

  it('a look at a conversation asks each folder once, however many rollouts name it', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, LINK)
    put(sessions, ['2026', '09', '02'], ID, LINK)
    put(sessions, ['2026', '09', '03'], ID, LINK)
    const real = fakeReal(ALL_ONE_FOLDER)
    await warm({ uuid: ID, cwd: REAL }, sessions, real)
    expect(real.mock.calls.map((c) => c[0]).sort()).toEqual([LINK, REAL].sort())
  })

  it('a folder the tab names that is on a network share is compared by its spelling, with no disk call', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, '//server/share/proj')
    const real = fakeReal({})
    await warm({ uuid: ID, cwd: '//server/share/proj' }, sessions, real)
    expect(real).not.toHaveBeenCalled()
  })
})

describe('what the disk is not asked again, across lookups', () => {
  const later = (): Promise<void> => new Promise((r) => setImmediate(r))

  // Mutation to prove this can fail: keep the calls under way per lookup only.
  it('a folder still being asked is not asked again by the next lookup, which waits for the same call', async () => {
    let answer: () => void = () => {}
    const slow = vi.fn(() => new Promise<string>((resolveCall) => { answer = () => resolveCall(REAL) }))
    const first = makeRealPathLookup({ realpath: slow })(LINK)
    const second = makeRealPathLookup({ realpath: slow })(LINK)
    await later()
    expect(slow).toHaveBeenCalledTimes(1)
    answer()
    expect(await Promise.all([first, second])).toEqual([REAL, REAL])
    // Ended: the answer is not kept past the call, so the next lookup asks.
    const third = makeRealPathLookup({ realpath: slow })(LINK)
    await later()
    expect(slow).toHaveBeenCalledTimes(2)
    answer()
    expect(await third).toBe(REAL)
  })

  // Mutation to prove this can fail: forget the drive that did not answer.
  it('a drive that did not answer is left alone for a minute: no other folder on it is asked, and none is waited for', async () => {
    vi.useFakeTimers()
    const hung = vi.fn(() => new Promise<string>(() => {}))
    const first = makeRealPathLookup({ realpath: hung, waitMs: 50 })(LINK)
    await vi.advanceTimersByTimeAsync(51)
    expect(await first).toBeNull()
    expect(hung).toHaveBeenCalledTimes(1)
    // Another launch, another folder on the same drive: no call, an answer at once.
    expect(await makeRealPathLookup({ realpath: hung, waitMs: 50 })(LINK2)).toBeNull()
    expect(hung).toHaveBeenCalledTimes(1)
    // Past the minute it is asked again.
    await vi.advanceTimersByTimeAsync(CODEX_DISK_SILENT_MS + 1)
    const again = makeRealPathLookup({ realpath: hung, waitMs: 50 })(LINK2)
    await vi.advanceTimersByTimeAsync(51)
    expect(await again).toBeNull()
    expect(hung).toHaveBeenCalledTimes(2)
  })

  it('a drive that answers after all is asked again at once', async () => {
    vi.useFakeTimers()
    let answer: () => void = () => {}
    const slowThenFine = vi.fn((p: string) => (p === LINK ? new Promise<string>((resolveCall) => { answer = () => resolveCall(REAL) }) : Promise.resolve(REAL)))
    const first = makeRealPathLookup({ realpath: slowThenFine, waitMs: 50 })(LINK)
    await vi.advanceTimersByTimeAsync(51)
    expect(await first).toBeNull()
    expect(await makeRealPathLookup({ realpath: slowThenFine, waitMs: 50 })(LINK2), 'left alone while the call is out').toBeNull()
    answer()
    await vi.advanceTimersByTimeAsync(1)
    expect(await makeRealPathLookup({ realpath: slowThenFine, waitMs: 50 })(LINK2), 'asked again once the drive has answered').toBe(REAL)
  })

  it('another drive is not silenced by one that is down', async () => {
    vi.useFakeTimers()
    const hungOnZ = vi.fn((p: string) => (p.startsWith('Z:') ? new Promise<string>(() => {}) : Promise.resolve('C:\\real')))
    const z = makeRealPathLookup({ realpath: hungOnZ, waitMs: 50 })('Z:\\proj')
    await vi.advanceTimersByTimeAsync(51)
    expect(await z).toBeNull()
    expect(await makeRealPathLookup({ realpath: hungOnZ, waitMs: 50 })('C:\\proj')).toBe('C:\\real')
  })

  // Mutation to prove this can fail: treat every path on macOS and Linux as one drive.
  it('on macOS and Linux a mount is its own drive: a stale share under /mnt does not silence the root disk or another mount', () => {
    expect(codexDriveKeyOf('/mnt/share/old/project')).toBe('/mnt/share')
    expect(codexDriveKeyOf('/mnt/other/project')).toBe('/mnt/other')
    expect(codexDriveKeyOf('/Volumes/Backup/x')).toBe('/volumes/backup')
    expect(codexDriveKeyOf('/net/host/export/x')).toBe('/net/host')
    expect(codexDriveKeyOf('/media/me/USB/x')).toBe('/media/me/usb')
    expect(codexDriveKeyOf('/run/media/me/USB/x')).toBe('/run/media/me/usb')
    expect(codexDriveKeyOf('/mnt')).toBe('/mnt')
    expect(codexDriveKeyOf('/home/me/project')).toBe('/')
    expect(codexDriveKeyOf('/proj/link')).toBe('/')
    expect(codexDriveKeyOf('C:\\proj\\link')).toBe('c:')
    expect(codexDriveKeyOf('z:/proj')).toBe('z:')
  })

  it('a stale mount under /mnt leaves the root disk asked', async () => {
    vi.useFakeTimers()
    const staleMount = vi.fn((p: string) => (p.startsWith('/mnt/') ? new Promise<string>(() => {}) : Promise.resolve(REAL)))
    const stale = makeRealPathLookup({ realpath: staleMount, waitMs: 50 })('/mnt/share/old/project')
    await vi.advanceTimersByTimeAsync(51)
    expect(await stale).toBeNull()
    expect(await makeRealPathLookup({ realpath: staleMount, waitMs: 50 })(LINK)).toBe(REAL)
    expect(await makeRealPathLookup({ realpath: staleMount, waitMs: 50 })('/mnt/share/other')).toBeNull()
    expect(staleMount.mock.calls.map((c) => c[0])).toEqual(['/mnt/share/old/project', LINK])
  })
})

describe('what the launch no longer asks the disk, once it has read the look', () => {
  // Mutation to prove this can fail: ignore the look's answer and ask in place.
  it('it never asks whether the tab\'s folder is a folder, or the home folder, in place', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    await warm({ uuid: ID, cwd: LINK }, sessions, fakeReal(ALL_ONE_FOLDER))
    const ctx = ctxFor(sessions)
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctx)).toMatchObject({ cwd: resolve(LINK) })
    expect(ctx.dirExists).not.toHaveBeenCalled()
    expect(ctx.homeOrAbove).not.toHaveBeenCalled()
  })

  // Mutation to prove this can fail: leave out the existence answer.
  it('a tab folder that is not a folder starts in the configured folder', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    await warm({ uuid: ID, cwd: REAL }, sessions, fakeReal(ALL_ONE_FOLDER), { isDirectory: async () => false })
    expect(resolveCodexResume({ uuid: ID, cwd: REAL }, ctxFor(sessions))).toMatchObject({ cwd: CONFIGURED, cwdMismatch: false })
  })

  // Mutation to prove this can fail: leave out the home-folder answer.
  it('a tab folder that is the home folder or above it starts in the configured folder', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    await warm({ uuid: ID, cwd: REAL }, sessions, fakeReal(ALL_ONE_FOLDER), { homeOrAbove: async () => true })
    expect(resolveCodexResume({ uuid: ID, cwd: REAL }, ctxFor(sessions))).toMatchObject({ cwd: CONFIGURED, cwdMismatch: false })
  })

  it('but the configured folder itself is never guarded, as before (and the home verdict is not asked for it)', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    const stands = fine()
    stands.homeOrAbove.mockResolvedValue(true)
    await warmCodexResume({ uuid: ID, cwd: REAL }, { sessionsDir: sessions, realpath: fakeReal(ALL_ONE_FOLDER), configuredCwd: REAL, ...stands })
    expect(stands.homeOrAbove).not.toHaveBeenCalled()
    expect(resolveCodexResume({ uuid: ID, cwd: REAL }, ctxFor(sessions, { configuredCwd: REAL }))).toMatchObject({ cwd: resolve(REAL), cwdMismatch: false })
  })

  // Mutation to prove this can fail: leave a missing verdict as "not above home".
  it('a launch whose configured folder is not the one the look was told has no verdict, and does not use the tab\'s folder', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    // Told the configured folder is REAL (so no home verdict was asked), the launch's own is another.
    await warmCodexResume({ uuid: ID, cwd: REAL }, { sessionsDir: sessions, realpath: fakeReal(ALL_ONE_FOLDER), configuredCwd: REAL, ...fine() })
    expect(resolveCodexResume({ uuid: ID, cwd: REAL }, ctxFor(sessions))).toMatchObject({ cwd: CONFIGURED })
  })

  it('a folder it does not look at (no rollout records it) is not asked about', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, '/proj/elsewhere')
    const stands = fine()
    await warmCodexResume({ uuid: ID, cwd: LINK }, { sessionsDir: sessions, realpath: fakeReal({ ...ALL_ONE_FOLDER, '/proj/elsewhere': '/proj/elsewhere' }), ...stands })
    expect(stands.isDirectory).not.toHaveBeenCalled()
    expect(stands.homeOrAbove).not.toHaveBeenCalled()
  })

  // Mutation to prove this can fail: wait for the checks without a bound.
  it('checks that do not answer are waited for only so long: the tab\'s folder is then not used', async () => {
    vi.useFakeTimers()
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    let done = false
    const warming = warmCodexResume({ uuid: ID, cwd: REAL }, {
      sessionsDir: sessions, realpath: fakeReal(ALL_ONE_FOLDER), waitMs: 50,
      isDirectory: () => new Promise<boolean>(() => {}), homeOrAbove: () => new Promise<boolean>(() => {}),
    }).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(49)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await warming
    expect(done).toBe(true)
    expect(resolveCodexResume({ uuid: ID, cwd: REAL }, ctxFor(sessions))).toMatchObject({ cwd: CONFIGURED, cwdMismatch: false })
  })

  it('a relative folder is not asked about, and is not used', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, 'rel/dir')
    const stands = fine()
    await warmCodexResume({ uuid: ID, cwd: 'rel/dir' }, { sessionsDir: sessions, realpath: fakeReal({}), ...stands })
    expect(stands.isDirectory).not.toHaveBeenCalled()
    expect(resolveCodexResume({ uuid: ID, cwd: 'rel/dir' }, ctxFor(sessions))).toMatchObject({ cwd: CONFIGURED, cwdMismatch: false })
  })
})

describe('what a look keeps, and for how long', () => {
  it('is read once: the launch after it compares the spelling again', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    await warm({ uuid: ID, cwd: LINK }, sessions, fakeReal(ALL_ONE_FOLDER))
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwdMismatch: false })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxInPlace(sessions))).toMatchObject({ cwdMismatch: true })
  })

  it('is read only while fresh', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    await warm({ uuid: ID, cwd: LINK }, sessions, fakeReal(ALL_ONE_FOLDER), { now: () => 1_000 })
    const late = ctxInPlace(sessions, { now: () => 1_000 + CODEX_WARMED_RESUME_TTL_MS + 1 })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, late)).toMatchObject({ cwd: CONFIGURED, cwdMismatch: true })
  })

  it('is for that conversation, that realm and that folder only', async () => {
    const sessions = join(temp(), 'sessions')
    const other = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    put(other, ['2026', '09', '01'], ID, REAL)
    await warm({ uuid: ID, cwd: LINK }, sessions, fakeReal(ALL_ONE_FOLDER))
    // Another realm, and another folder of the same one, read none of it.
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxInPlace(other))).toMatchObject({ cwdMismatch: true })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK2 }, ctxInPlace(sessions))).toMatchObject({ cwdMismatch: true })
    // The look is still there for the launch it was made for.
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwdMismatch: false })
  })

  // Mutation to prove this can fail: leave the session out of the key.
  it('is for that session only: two tabs resuming one conversation in one folder each have their own', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    const real = fakeReal(ALL_ONE_FOLDER)
    await warm({ uuid: ID, cwd: LINK }, sessions, real, { sessionId: 'tab-one' })
    await warm({ uuid: ID, cwd: LINK }, sessions, real, { sessionId: 'tab-two' })
    expect(__warmedCodexResumeCountForTests()).toBe(2)
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions, { sessionId: 'tab-one' }))).toMatchObject({ cwd: resolve(LINK), cwdMismatch: false })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions, { sessionId: 'tab-two' }))).toMatchObject({ cwd: resolve(LINK), cwdMismatch: false })
    // A session that had no look read nothing of the others'.
    await warm({ uuid: ID, cwd: LINK }, sessions, real, { sessionId: 'tab-one' })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxInPlace(sessions, { sessionId: 'tab-three' }))).toMatchObject({ cwdMismatch: true })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxInPlace(sessions))).toMatchObject({ cwdMismatch: true })
  })

  it('a conversation the realm does not have is none, and the launch walks nothing again', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], '019dd000-0001-7000-8000-0000000000e2', REAL)
    const before = __codexRolloutLookupsForTests()
    await warm({ uuid: ID, cwd: LINK }, sessions, fakeReal(ALL_ONE_FOLDER))
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toBeNull()
    expect(__codexRolloutLookupsForTests() - before).toBe(1)
  })

  it('the realm is walked once when the launch reads the look, and twice when the look had run out', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    let before = __codexRolloutLookupsForTests()
    await warm({ uuid: ID, cwd: LINK }, sessions, fakeReal(ALL_ONE_FOLDER))
    resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))
    expect(__codexRolloutLookupsForTests() - before).toBe(1)
    before = __codexRolloutLookupsForTests()
    resolveCodexResume({ uuid: ID, cwd: LINK }, ctxInPlace(sessions))
    expect(__codexRolloutLookupsForTests() - before).toBe(1)
    before = __codexRolloutLookupsForTests()
    await warm({ uuid: ID, cwd: LINK }, sessions, fakeReal(ALL_ONE_FOLDER), { now: () => 1_000 })
    resolveCodexResume({ uuid: ID, cwd: LINK }, ctxInPlace(sessions, { now: () => 1_000 + CODEX_WARMED_RESUME_TTL_MS + 1 }))
    expect(__codexRolloutLookupsForTests() - before).toBe(2)
  })

  it('a target with no folder, or an id that is not a conversation id, keeps nothing', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    const real = fakeReal(ALL_ONE_FOLDER)
    const before = __codexRolloutLookupsForTests()
    await warm({ uuid: ID, cwd: '' }, sessions, real)
    await warm({ uuid: '../x', cwd: LINK }, sessions, real)
    await warmCodexResume(null, { sessionsDir: sessions, realpath: real })
    await warm({ uuid: ID, cwd: LINK }, '', real)
    expect(__codexRolloutLookupsForTests() - before).toBe(0)
    expect(real).not.toHaveBeenCalled()
    expect(__warmedCodexResumeCountForTests()).toBe(0)
  })
})

describe('how many looks are kept', () => {
  const named = (n: number): string[] => Array.from({ length: n }, (_, i) => `tab-${i + 1}`)
  async function warmSessions(sessions: string, ids: string[]): Promise<void> {
    const real = fakeReal(ALL_ONE_FOLDER)
    for (const sessionId of ids) await warm({ uuid: ID, cwd: LINK }, sessions, real, { sessionId })
  }

  // Mutation to prove this can fail: drop the cap.
  it('at most CODEX_WARMED_RESUME_MAX: the oldest goes first', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    await warmSessions(sessions, named(CODEX_WARMED_RESUME_MAX + 1))
    expect(__warmedCodexResumeCountForTests()).toBe(CODEX_WARMED_RESUME_MAX)
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxInPlace(sessions, { sessionId: 'tab-1' })), 'the oldest was dropped').toMatchObject({ cwdMismatch: true })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions, { sessionId: `tab-${CODEX_WARMED_RESUME_MAX + 1}` })), 'the newest is kept').toMatchObject({ cwdMismatch: false })
  })

  // Mutation to prove this can fail: make room before taking the same key out.
  it('a look made again for a launch already kept replaces it, and drops no other', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    await warmSessions(sessions, named(CODEX_WARMED_RESUME_MAX))
    await warmSessions(sessions, ['tab-5'])
    expect(__warmedCodexResumeCountForTests()).toBe(CODEX_WARMED_RESUME_MAX)
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions, { sessionId: 'tab-1' })), 'the oldest is still there').toMatchObject({ cwdMismatch: false })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions, { sessionId: 'tab-5' }))).toMatchObject({ cwdMismatch: false })
  })

  // Mutation to prove this can fail: leave the sweep out.
  it('a look nobody read goes at the next look after its time', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    const real = fakeReal(ALL_ONE_FOLDER)
    await warm({ uuid: ID, cwd: LINK }, sessions, real, { sessionId: 'old', now: () => 1_000 })
    await warm({ uuid: ID, cwd: LINK }, sessions, real, { sessionId: 'young', now: () => 1_000 + CODEX_WARMED_RESUME_TTL_MS })
    expect(__warmedCodexResumeCountForTests(), 'not yet old').toBe(2)
    await warm({ uuid: ID, cwd: LINK }, sessions, real, { sessionId: 'newer', now: () => 1_000 + CODEX_WARMED_RESUME_TTL_MS + 1 })
    expect(__warmedCodexResumeCountForTests(), 'the first is swept').toBe(2)
  })
})

describe('the lookup itself keeps its old rules', () => {
  it('without a test of its own it compares the spelling, as it did', () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    expect(chooseCodexRollout(findCodexRollouts(sessions, ID, undefined, LINK), LINK)).toMatchObject({ cwdMatched: false })
    expect(chooseCodexRollout(findCodexRollouts(sessions, ID, undefined, REAL), REAL)).toMatchObject({ cwdMatched: true })
  })

  it('a test it is given replaces the spelling comparison, for the walk and the choice', () => {
    const sessions = join(temp(), 'sessions')
    const file = put(sessions, ['2026', '09', '01'], ID, REAL)
    const isOwn = (recorded: string): boolean => sameDirectory(recorded, REAL)
    const found = findCodexRollouts(sessions, ID, undefined, LINK, isOwn)
    expect(found.map((f) => f.path)).toEqual([file])
    expect(chooseCodexRollout(found, LINK, isOwn)).toMatchObject({ cwdMatched: true })
  })
})

describe('a real path that differs from the recorded one only by case', () => {
  // The fold is sameDirectory's, on Windows: a real path the system gives
  // (its own capitals) against the spelling a rollout recorded.
  it.runIf(process.platform === 'win32')('is the same folder on Windows', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, 'c:\\proj\\real')
    await warm({ uuid: ID, cwd: 'C:\\proj\\link' }, sessions, fakeReal({ 'C:\\proj\\link': 'C:\\PROJ\\REAL', 'c:\\proj\\real': 'c:\\proj\\real' }))
    expect(resolveCodexResume({ uuid: ID, cwd: 'C:\\proj\\link' }, ctxFor(sessions))).toMatchObject({ cwdMismatch: false })
  })

  it.runIf(process.platform !== 'win32')('is another folder where case counts', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, '/proj/real')
    await warm({ uuid: ID, cwd: LINK }, sessions, fakeReal({ [LINK]: '/PROJ/REAL', '/proj/real': '/proj/real' }))
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwdMismatch: true })
  })
})

describe('no synchronous disk call is made by the lookup', () => {
  type SyncReal = Mock<typeof fs.realpathSync> & { native: Mock<typeof fs.realpathSync.native> }
  const syncReal = (): SyncReal => fs.realpathSync as unknown as SyncReal
  const syncStat = (): Mock<typeof fs.statSync> => fs.statSync as unknown as Mock<typeof fs.statSync>

  it('neither the look nor the launch\'s read of it calls realpathSync or statSync, with the real disk calls', async () => {
    const base = fs.realpathSync(temp())
    const project = join(base, 'project')
    mkdirSync(project)
    const sessions = join(base, 'sessions')
    put(sessions, ['2026', '09', '01'], ID, project)
    // The launch's own home-folder guard and existence check are not injected
    // away: the look answered them (the tab's folder is not the configured
    // one, so the home-folder guard is among them).
    const ctx = { sessionsDir: sessions, configuredCwd: base }
    syncReal().mockClear()
    syncReal().native.mockClear()
    syncStat().mockClear()
    // The default calls: fs.promises.realpath, fs.promises.stat.
    await warmCodexResume({ uuid: ID, cwd: project }, { sessionsDir: sessions })
    expect(resolveCodexResume({ uuid: ID, cwd: project }, ctx)).toMatchObject({ cwd: resolve(project), cwdMismatch: false })
    expect(syncReal()).not.toHaveBeenCalled()
    expect(syncReal().native).not.toHaveBeenCalled()
    expect(syncStat()).not.toHaveBeenCalled()
  })

  it('the spy does see the synchronous calls (so the case above could fail)', () => {
    const base = fs.realpathSync(temp())
    const project = join(base, 'project')
    mkdirSync(project)
    const sessions = join(base, 'sessions')
    put(sessions, ['2026', '09', '01'], ID, project)
    syncReal().native.mockClear()
    syncStat().mockClear()
    expect(sameFolderByRealPath(base, base)).toBe(true)
    expect(syncReal().native).toHaveBeenCalled()
    // No look made: the launch asks in place, as before.
    resolveCodexResume({ uuid: ID, cwd: project }, { sessionsDir: sessions, configuredCwd: base })
    expect(syncStat()).toHaveBeenCalled()
  })
})
