// HOST QUARANTINE: plants a symbolic link (macOS, Linux) or a junction (Windows) in a temp folder. [CI] [VM] only -- never run on the owner's machine.
// 2.1.3-beta.6, plan section E: a Codex conversation started in a symlinked
// folder is resumed, and listed in the resume list, from either spelling of
// the folder. The cases of resume-real-path.test.ts and
// codex-resume-picker-real-path.test.ts, with the real disk: a symbolic link on
// macOS and Linux, and a junction on Windows (making one needs no
// administrator rights), so each CI runner covers its own system.
import { describe, it, expect, vi, afterEach, beforeEach, type Mock } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, rmdirSync, unlinkSync, symlinkSync, utimesSync } from 'fs'
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
  warmCodexResume, resolveCodexResume, makeRealPathLookup, sameDirectory,
  __resetWarmedCodexResumeForTests,
} from '../../../../src/main/providers/codex/rollout-lookup'

type Listed = { id: string; cwd: string; sourceCwd: string }
// Helper module is plain Node.js (CommonJS); use require() to import.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const picker = require('../../../../scripts/lib/codex-resume-picker-lib.js') as {
  walkRollouts: (home: string, maxDays: number, where: string) => Listed[]
  walkRolloutsAsync: (home: string, maxDays: number, where: string) => Promise<Listed[]>
}

const ID = '019dd000-0001-7000-8000-0000000000e3'
const LINK_KIND = process.platform === 'win32' ? 'junction' : 'dir'

interface Project { base: string; real: string; link: string; sessions: string; configured: string }
const made: string[] = []
afterEach(() => {
  vi.useRealTimers()
  // Only a folder this file made (its own prefix, directly in the temp folder)
  // is removed, and the link first: never through it.
  for (const t of made.splice(0)) {
    if (dirname(t) !== tmpdir() || !/^ccc-e1-links-/.test(basename(t))) continue
    const link = join(t, 'link')
    try { rmdirSync(link) } catch { try { unlinkSync(link) } catch { /* not made, or already gone */ } }
    rmSync(t, { recursive: true, force: true })
  }
})
beforeEach(() => { __resetWarmedCodexResumeForTests() })

/** A project folder, a link to it (a junction on Windows), a sessions folder and a configured folder, in a temp folder. */
function project(): Project {
  const unresolved = mkdtempSync(join(tmpdir(), 'ccc-e1-links-'))
  made.push(unresolved)
  // The temp folder itself can sit behind a link (macOS /var) or be spelled
  // with a short name (Windows RUNNER~1): its real path, as the disk names it
  // (the native call, which also gives Windows its long names), so the link
  // made here is the only one the cases are about.
  const base = fs.realpathSync.native(unresolved)
  const real = join(base, 'project')
  const link = join(base, 'link')
  const configured = join(base, 'configured')
  mkdirSync(real)
  mkdirSync(configured)
  symlinkSync(real, link, LINK_KIND)
  return { base, real, link, sessions: join(base, 'sessions'), configured }
}

/** A rollout recording `cwd`, in the day folder its own time names. */
function put(sessionsDir: string, ymd: [string, string, string], id: string, cwd: string): string {
  const dir = join(sessionsDir, ...ymd)
  mkdirSync(dir, { recursive: true })
  const iso = `${ymd[0]}-${ymd[1]}-${ymd[2]}T12:00:00.000Z`
  const file = join(dir, `rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`)
  writeFileSync(file, JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, cwd } }) + '\n')
  return file
}

const ctxFor = (p: Project) => ({ sessionsDir: p.sessions, configuredCwd: p.configured, homeOrAbove: () => false })

describe('a real link to a folder', () => {
  it('has the same real path as the folder, asked asynchronously', async () => {
    const p = project()
    const look = makeRealPathLookup()
    const viaLink = await look(p.link)
    const viaReal = await look(p.real)
    expect(viaLink).not.toBeNull()
    expect(viaReal).not.toBeNull()
    expect(sameDirectory(viaLink as string, viaReal as string)).toBe(true)
    expect(sameDirectory(p.link, p.real)).toBe(false)
  })
})

describe('a conversation recorded under the real folder, the tab kept the link', () => {
  it('is resumed in the tab\'s folder', async () => {
    const p = project()
    const file = put(p.sessions, ['2026', '09', '01'], ID, p.real)
    await warmCodexResume({ uuid: ID, cwd: p.link }, { sessionsDir: p.sessions })
    expect(resolveCodexResume({ uuid: ID, cwd: p.link }, ctxFor(p))).toEqual({ resumeId: ID, cwd: resolve(p.link), cwdMismatch: false, path: file })
  })

  it('and, with no look made, starts in the configured folder and says so (as before)', () => {
    const p = project()
    put(p.sessions, ['2026', '09', '01'], ID, p.real)
    expect(resolveCodexResume({ uuid: ID, cwd: p.link }, ctxFor(p))).toMatchObject({ cwd: p.configured, cwdMismatch: true })
  })
})

describe('a conversation recorded under the link, the tab kept the real folder', () => {
  it('is resumed in the tab\'s folder', async () => {
    const p = project()
    const file = put(p.sessions, ['2026', '09', '01'], ID, p.link)
    await warmCodexResume({ uuid: ID, cwd: p.real }, { sessionsDir: p.sessions })
    expect(resolveCodexResume({ uuid: ID, cwd: p.real }, ctxFor(p))).toEqual({ resumeId: ID, cwd: resolve(p.real), cwdMismatch: false, path: file })
  })
})

describe('a link whose folder is gone', () => {
  it('cannot be resolved, so the spelling decides: the configured folder, and it says so', async () => {
    const p = project()
    put(p.sessions, ['2026', '09', '01'], ID, p.real)
    rmdirSync(p.real)
    await warmCodexResume({ uuid: ID, cwd: p.link }, { sessionsDir: p.sessions })
    expect(resolveCodexResume({ uuid: ID, cwd: p.link }, ctxFor(p))).toMatchObject({ cwd: p.configured, cwdMismatch: true })
  })
})

describe('the lookup never makes the synchronous real-path call', () => {
  type SyncReal = Mock<typeof fs.realpathSync> & { native: Mock<typeof fs.realpathSync.native> }
  const syncReal = (): SyncReal => fs.realpathSync as unknown as SyncReal

  it('through a real link, both ways round', async () => {
    const p = project()
    const forward = ID
    const backward = '019dd000-0001-7000-8000-0000000000e4'
    put(p.sessions, ['2026', '09', '01'], forward, p.real)
    put(p.sessions, ['2026', '09', '01'], backward, p.link)
    syncReal().mockClear()
    syncReal().native.mockClear()
    await warmCodexResume({ uuid: forward, cwd: p.link }, { sessionsDir: p.sessions })
    await warmCodexResume({ uuid: backward, cwd: p.real }, { sessionsDir: p.sessions })
    // The folder looks themselves: the launch's own home-folder guard is a separate check (injected off here).
    expect(resolveCodexResume({ uuid: forward, cwd: p.link }, ctxFor(p))).toMatchObject({ cwdMismatch: false })
    expect(resolveCodexResume({ uuid: backward, cwd: p.real }, ctxFor(p))).toMatchObject({ cwdMismatch: false })
    expect(syncReal()).not.toHaveBeenCalled()
    expect(syncReal().native).not.toHaveBeenCalled()
  })
})

describe('the resume list, with a real link', () => {
  const idForward = '019dd000-0001-7000-8000-0000000000e5'
  const idBackward = '019dd000-0001-7000-8000-0000000000e6'
  function rollouts(p: Project): string {
    const home = join(p.base, 'codex-home')
    const now = new Date()
    const dir = join(home, 'sessions', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'))
    mkdirSync(dir, { recursive: true })
    const write = (name: string, id: string, cwd: string, agoSec: number): void => {
      const file = join(dir, name)
      writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd, model: 'gpt-5.5' } }) + '\n')
      const t = new Date(Date.now() - agoSec * 1000)
      utimesSync(file, t, t)
    }
    write(`rollout-a-${idForward}.jsonl`, idForward, p.real, 10)
    write(`rollout-b-${idBackward}.jsonl`, idBackward, p.link, 20)
    return home
  }

  it('lists a conversation recorded under the real folder when the session is in the link', async () => {
    const p = project()
    const home = rollouts(p)
    // By spelling alone, only the one recorded under the link itself.
    expect(picker.walkRollouts(home, 30, p.link).map((c) => c.id)).toEqual([idBackward])
    const out = await picker.walkRolloutsAsync(home, 30, p.link)
    expect(out.map((c) => c.id)).toEqual([idForward, idBackward])
    expect(out.every((c) => c.sourceCwd === p.link)).toBe(true)
  })

  it('and one recorded under the link when the session is in the real folder', async () => {
    const p = project()
    const home = rollouts(p)
    expect(picker.walkRollouts(home, 30, p.real).map((c) => c.id)).toEqual([idForward])
    const out = await picker.walkRolloutsAsync(home, 30, p.real)
    expect(out.map((c) => c.id)).toEqual([idForward, idBackward])
  })
})
