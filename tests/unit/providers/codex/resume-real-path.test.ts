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

// Wrap the synchronous real-path calls, so a case can say none was made. They
// still do what they did.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const realpathSync = Object.assign(vi.fn(actual.realpathSync), { native: vi.fn(actual.realpathSync.native) })
  return { ...actual, realpathSync, default: { ...actual, realpathSync } }
})

import * as fs from 'fs'
import {
  warmCodexResume, resolveCodexResume, makeRealPathLookup, sameFolderByRealPath, isLocalAbsolutePath,
  findCodexRollouts, chooseCodexRollout, sameDirectory,
  CODEX_WARMED_RESUME_TTL_MS, __resetWarmedCodexResumeForTests, __codexRolloutLookupsForTests,
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
beforeEach(() => { __resetWarmedCodexResumeForTests() })

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

const ctxFor = (sessionsDir: string) => ({ sessionsDir, configuredCwd: CONFIGURED, dirExists: () => true, homeOrAbove: () => false })

describe('a conversation recorded under the real folder, the tab kept the link', () => {
  it('is resumed in the tab\'s folder, once the look has been made', async () => {
    const sessions = join(temp(), 'sessions')
    const file = put(sessions, ['2026', '09', '01'], ID, REAL)
    await warmCodexResume({ uuid: ID, cwd: LINK }, { sessionsDir: sessions, realpath: fakeReal(ALL_ONE_FOLDER) })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toEqual({ resumeId: ID, cwd: resolve(LINK), cwdMismatch: false, path: file })
  })

  it('is, without the look, as before: the spelling differs, so it starts in the configured folder and says so', () => {
    const sessions = join(temp(), 'sessions')
    const file = put(sessions, ['2026', '09', '01'], ID, REAL)
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toEqual({ resumeId: ID, cwd: CONFIGURED, cwdMismatch: true, path: file })
  })
})

describe('a conversation recorded under the link, the tab kept the real folder', () => {
  it('is resumed in the tab\'s folder, once the look has been made', async () => {
    const sessions = join(temp(), 'sessions')
    const file = put(sessions, ['2026', '09', '01'], ID, LINK)
    await warmCodexResume({ uuid: ID, cwd: REAL }, { sessionsDir: sessions, realpath: fakeReal(ALL_ONE_FOLDER) })
    expect(resolveCodexResume({ uuid: ID, cwd: REAL }, ctxFor(sessions))).toEqual({ resumeId: ID, cwd: resolve(REAL), cwdMismatch: false, path: file })
  })

  it('is, without the look, as before: the configured folder, and says so', () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, LINK)
    expect(resolveCodexResume({ uuid: ID, cwd: REAL }, ctxFor(sessions))).toMatchObject({ cwd: CONFIGURED, cwdMismatch: true })
  })
})

describe('two links to one folder', () => {
  it('a conversation recorded under one is resumed from the other', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, LINK2)
    await warmCodexResume({ uuid: ID, cwd: LINK }, { sessionsDir: sessions, realpath: fakeReal(ALL_ONE_FOLDER) })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwd: resolve(LINK), cwdMismatch: false })
  })
})

describe('a folder that is not the tab\'s, by spelling or by real path', () => {
  it('stays a mismatch: the configured folder, and says so', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, '/proj/elsewhere')
    const real = fakeReal({ ...ALL_ONE_FOLDER, '/proj/elsewhere': '/proj/elsewhere' })
    await warmCodexResume({ uuid: ID, cwd: LINK }, { sessionsDir: sessions, realpath: real })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwd: CONFIGURED, cwdMismatch: true })
  })

  it('and a copy that records the tab\'s folder is chosen over one that does not, by real path too', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '02'], ID, '/proj/elsewhere')
    const mine = put(sessions, ['2026', '09', '01'], ID, REAL)
    await warmCodexResume({ uuid: ID, cwd: LINK }, { sessionsDir: sessions, realpath: fakeReal({ ...ALL_ONE_FOLDER, '/proj/elsewhere': '/proj/elsewhere' }) })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ path: mine, cwd: resolve(LINK), cwdMismatch: false })
  })
})

describe('a folder whose real path cannot be had', () => {
  it('is compared by its spelling: no match by link, and an exact spelling still matches', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    const nothing = fakeReal({})
    await warmCodexResume({ uuid: ID, cwd: LINK }, { sessionsDir: sessions, realpath: nothing })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwd: CONFIGURED, cwdMismatch: true })
    await warmCodexResume({ uuid: ID, cwd: REAL }, { sessionsDir: sessions, realpath: nothing })
    expect(resolveCodexResume({ uuid: ID, cwd: REAL }, ctxFor(sessions))).toMatchObject({ cwd: resolve(REAL), cwdMismatch: false })
  })

  it('a stand-in that throws where it is called is the same', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    const broken = vi.fn(() => { throw new Error('boom') }) as unknown as (p: string) => Promise<string>
    await warmCodexResume({ uuid: ID, cwd: LINK }, { sessionsDir: sessions, realpath: broken })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwd: CONFIGURED, cwdMismatch: true })
  })

  it('one that does not answer is waited for only so long, then the spelling decides', async () => {
    vi.useFakeTimers()
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    const hung = vi.fn(() => new Promise<string>(() => {}))
    let done = false
    const warming = warmCodexResume({ uuid: ID, cwd: LINK }, { sessionsDir: sessions, realpath: hung, waitMs: 50 }).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(10)
    expect(done).toBe(false)
    // The tab's folder waits 50 ms, then the recorded one waits 50 ms: never longer.
    await vi.advanceTimersByTimeAsync(200)
    await warming
    expect(done).toBe(true)
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

  it('never asks about a relative spelling or a network share', async () => {
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

  it('a look at a conversation asks each folder once, however many rollouts name it', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, LINK)
    put(sessions, ['2026', '09', '02'], ID, LINK)
    put(sessions, ['2026', '09', '03'], ID, LINK)
    const real = fakeReal(ALL_ONE_FOLDER)
    await warmCodexResume({ uuid: ID, cwd: REAL }, { sessionsDir: sessions, realpath: real })
    expect(real.mock.calls.map((c) => c[0]).sort()).toEqual([LINK, REAL].sort())
  })

  it('a folder the tab names that is on a network share is compared by its spelling, with no disk call', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, '//server/share/proj')
    const real = fakeReal({})
    await warmCodexResume({ uuid: ID, cwd: '//server/share/proj' }, { sessionsDir: sessions, realpath: real })
    expect(real).not.toHaveBeenCalled()
    expect(resolveCodexResume({ uuid: ID, cwd: '//server/share/proj' }, ctxFor(sessions))).toMatchObject({ cwdMismatch: false })
  })
})

describe('what a look keeps, and for how long', () => {
  it('is read once: the launch after it compares the spelling again', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    await warmCodexResume({ uuid: ID, cwd: LINK }, { sessionsDir: sessions, realpath: fakeReal(ALL_ONE_FOLDER) })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwdMismatch: false })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwdMismatch: true })
  })

  it('is read only while fresh', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    await warmCodexResume({ uuid: ID, cwd: LINK }, { sessionsDir: sessions, realpath: fakeReal(ALL_ONE_FOLDER), now: () => 1_000 })
    const late = { ...ctxFor(sessions), now: () => 1_000 + CODEX_WARMED_RESUME_TTL_MS + 1 }
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, late)).toMatchObject({ cwd: CONFIGURED, cwdMismatch: true })
  })

  it('is for that conversation, that realm and that folder only', async () => {
    const sessions = join(temp(), 'sessions')
    const other = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    put(other, ['2026', '09', '01'], ID, REAL)
    await warmCodexResume({ uuid: ID, cwd: LINK }, { sessionsDir: sessions, realpath: fakeReal(ALL_ONE_FOLDER) })
    // Another realm, and another folder of the same one, read none of it.
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(other))).toMatchObject({ cwdMismatch: true })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK2 }, ctxFor(sessions))).toMatchObject({ cwdMismatch: true })
    // The look is still there for the launch it was made for.
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toMatchObject({ cwdMismatch: false })
  })

  it('a conversation the realm does not have is none, and the launch walks nothing again', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], '019dd000-0001-7000-8000-0000000000e2', REAL)
    const before = __codexRolloutLookupsForTests()
    await warmCodexResume({ uuid: ID, cwd: LINK }, { sessionsDir: sessions, realpath: fakeReal(ALL_ONE_FOLDER) })
    expect(resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))).toBeNull()
    expect(__codexRolloutLookupsForTests() - before).toBe(1)
  })

  it('the realm is walked once for a launch that was looked at, and once for one that was not', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    let before = __codexRolloutLookupsForTests()
    await warmCodexResume({ uuid: ID, cwd: LINK }, { sessionsDir: sessions, realpath: fakeReal(ALL_ONE_FOLDER) })
    resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))
    expect(__codexRolloutLookupsForTests() - before).toBe(1)
    before = __codexRolloutLookupsForTests()
    resolveCodexResume({ uuid: ID, cwd: LINK }, ctxFor(sessions))
    expect(__codexRolloutLookupsForTests() - before).toBe(1)
  })

  it('a target with no folder, or an id that is not a conversation id, keeps nothing', async () => {
    const sessions = join(temp(), 'sessions')
    put(sessions, ['2026', '09', '01'], ID, REAL)
    const real = fakeReal(ALL_ONE_FOLDER)
    const before = __codexRolloutLookupsForTests()
    await warmCodexResume({ uuid: ID, cwd: '' }, { sessionsDir: sessions, realpath: real })
    await warmCodexResume({ uuid: '../x', cwd: LINK }, { sessionsDir: sessions, realpath: real })
    await warmCodexResume(null, { sessionsDir: sessions, realpath: real })
    await warmCodexResume({ uuid: ID, cwd: LINK }, { sessionsDir: '', realpath: real })
    expect(__codexRolloutLookupsForTests() - before).toBe(0)
    expect(real).not.toHaveBeenCalled()
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

describe('no synchronous real-path call is made by the lookup', () => {
  type SyncReal = Mock<typeof fs.realpathSync> & { native: Mock<typeof fs.realpathSync.native> }
  const syncReal = (): SyncReal => fs.realpathSync as unknown as SyncReal

  it('neither the look nor the launch\'s read of it calls realpathSync, with the real disk call', async () => {
    const base = fs.realpathSync(temp())
    const project = join(base, 'project')
    mkdirSync(project)
    const sessions = join(base, 'sessions')
    put(sessions, ['2026', '09', '01'], ID, project)
    // The folder looks themselves, not the launch's home-folder guard (its own
    // check of the home folder, injected here) or its existence check.
    const ctx = { sessionsDir: sessions, configuredCwd: base, dirExists: () => true, homeOrAbove: () => false }
    syncReal().mockClear()
    syncReal().native.mockClear()
    // The default stand-in for the real path: fs.promises.realpath.
    await warmCodexResume({ uuid: ID, cwd: project }, { sessionsDir: sessions })
    expect(resolveCodexResume({ uuid: ID, cwd: project }, ctx)).toMatchObject({ cwdMismatch: false })
    expect(syncReal()).not.toHaveBeenCalled()
    expect(syncReal().native).not.toHaveBeenCalled()
  })

  it('the spy does see the synchronous call (so the case above could fail)', () => {
    const base = fs.realpathSync(temp())
    syncReal().native.mockClear()
    expect(sameFolderByRealPath(base, base)).toBe(true)
    expect(syncReal().native).toHaveBeenCalled()
  })
})
