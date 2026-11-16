// 2.1.3-beta.6, plan section E: the resume list offers a conversation whose
// recorded folder is the same folder as the session's by REAL path (a symlinked
// folder, a Windows junction), not only by spelling, and asks the disk for real
// paths asynchronously, bounded, once per folder.
//
// The real path is answered here by a stand-in for fs.promises.realpath, so
// these cases run on every platform with no link made. The same rules with a
// real symlink or junction are in the codex resume-real-path-links test, which
// runs in CI.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'

type Listed = { id: string; cwd: string; sourceCwd: string; mtime: number; label: string }
type Worktree = { path: string; branch: string | null; isMain: boolean }
// Helper module is plain Node.js (CommonJS); use require() to import.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../../../scripts/lib/codex-resume-picker-lib.js') as {
  walkRollouts: (home: string, maxDays: number, where: string | Worktree[], platform?: string) => Listed[]
  walkRolloutsAsync: (home: string, maxDays: number, where: string | Worktree[], platform?: string, deps?: { realpath?: (p: string) => Promise<string>; waitMs?: number }) => Promise<Listed[]>
  realPathLookup: (deps?: { realpath?: (p: string) => Promise<string>; waitMs?: number }) => (p: string) => Promise<string | null>
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFs = require('fs') as typeof import('fs')

const REAL = '/proj/real'
const LINK = '/proj/link'
const LINK2 = '/proj/link-two'
const OTHER = '/proj/other'
const ALL_ONE_FOLDER: Record<string, string> = { [REAL]: REAL, [LINK]: REAL, [LINK2]: REAL, [OTHER]: OTHER }

let home: string
let day: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccc-e1-picker-real-path-'))
  const now = new Date()
  day = join(home, 'sessions', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'))
  mkdirSync(day, { recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  // Only a folder this file made (its own prefix, directly in the temp folder) is removed.
  if (dirname(home) === tmpdir() && /^ccc-e1-picker-real-path-/.test(basename(home))) rmSync(home, { recursive: true, force: true })
})

const idOf = (n: number): string => `019dd000-0001-7000-8000-${String(n).padStart(12, '0')}`
/** A rollout recording `cwd`; `ageSec` older than now, so the order is known. */
function put(n: number, cwd: string, ageSec = n): string {
  const file = join(day, `rollout-${n}-${idOf(n)}.jsonl`)
  writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: idOf(n), cwd, model: 'gpt-5.5' } }) + '\n')
  const t = new Date(Date.now() - ageSec * 1000)
  utimesSync(file, t, t)
  return file
}
function fakeReal(known: Record<string, string>) {
  return vi.fn(async (p: string) => {
    const hit = known[p]
    if (hit === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    return hit
  })
}

describe('a conversation recorded under the real folder, the session is in the link', () => {
  it('is offered, with the folder the session is in as where it starts', async () => {
    put(1, REAL)
    const out = await lib.walkRolloutsAsync(home, 30, LINK, undefined, { realpath: fakeReal(ALL_ONE_FOLDER) })
    expect(out.map((c) => c.id)).toEqual([idOf(1)])
    expect(out[0]).toMatchObject({ cwd: REAL, sourceCwd: LINK })
  })

  it('is not offered by the walk that compares the spelling alone (as before)', () => {
    put(1, REAL)
    expect(lib.walkRollouts(home, 30, LINK)).toEqual([])
  })
})

describe('a conversation recorded under the link, the session is in the real folder', () => {
  it('is offered', async () => {
    put(1, LINK)
    const out = await lib.walkRolloutsAsync(home, 30, REAL, undefined, { realpath: fakeReal(ALL_ONE_FOLDER) })
    expect(out.map((c) => c.id)).toEqual([idOf(1)])
    expect(out[0]).toMatchObject({ cwd: LINK, sourceCwd: REAL })
  })

  it('and one recorded under another link to the same folder', async () => {
    put(1, LINK2)
    const out = await lib.walkRolloutsAsync(home, 30, LINK, undefined, { realpath: fakeReal(ALL_ONE_FOLDER) })
    expect(out.map((c) => c.id)).toEqual([idOf(1)])
  })
})

describe('a git worktree list, one of which is the link', () => {
  it('lists the conversation under the worktree it is the same folder as, tagged as that worktree', async () => {
    put(1, REAL)
    put(2, OTHER)
    const worktrees: Worktree[] = [
      { path: '/proj/main', branch: 'main', isMain: true },
      { path: LINK, branch: 'feature', isMain: false },
    ]
    const out = await lib.walkRolloutsAsync(home, 30, worktrees, undefined, { realpath: fakeReal({ ...ALL_ONE_FOLDER, '/proj/main': '/proj/main' }) })
    expect(out.map((c) => [c.id, c.sourceCwd])).toEqual([[idOf(1), LINK]])
  })
})

describe('a folder that is not the session\'s, by spelling or by real path', () => {
  it('is not offered', async () => {
    put(1, OTHER)
    expect(await lib.walkRolloutsAsync(home, 30, LINK, undefined, { realpath: fakeReal(ALL_ONE_FOLDER) })).toEqual([])
  })
})

describe('a folder whose real path cannot be had', () => {
  it('is compared by its spelling: not offered by link, and an exact spelling is still offered', async () => {
    put(1, REAL)
    put(2, LINK)
    const out = await lib.walkRolloutsAsync(home, 30, LINK, undefined, { realpath: fakeReal({}) })
    expect(out.map((c) => c.id)).toEqual([idOf(2)])
  })

  it('a stand-in that throws where it is called is the same', async () => {
    put(1, REAL)
    put(2, LINK)
    const broken = (() => { throw new Error('boom') }) as unknown as (p: string) => Promise<string>
    const out = await lib.walkRolloutsAsync(home, 30, LINK, undefined, { realpath: broken })
    expect(out.map((c) => c.id)).toEqual([idOf(2)])
  })

  it('one that does not answer is waited for only so long, and the drive it is on is not asked again', async () => {
    put(1, REAL)
    put(2, OTHER)
    put(3, LINK)
    const hung = vi.fn((_p: string) => new Promise<string>(() => {}))
    const started = Date.now()
    const out = await lib.walkRolloutsAsync(home, 30, LINK, undefined, { realpath: hung, waitMs: 30 })
    expect(out.map((c) => c.id)).toEqual([idOf(3)])
    expect(Date.now() - started).toBeLessThan(5_000)
    // Only the session's own folder was asked (and not answered): the
    // recorded ones, on the same drive, were not waited for in turn.
    expect(hung.mock.calls.map((c) => c[0])).toEqual([LINK])
  })
})

describe('a folder that did not answer in time', () => {
  /** Answers the known folders, and never answers HUNG. */
  const hangingOn = (hung: string, known: Record<string, string>) => vi.fn((p: string): Promise<string> => (p === hung ? new Promise<string>(() => {}) : p in known ? Promise.resolve(known[p]) : Promise.reject(new Error(`ENOENT: ${p}`))))
  const HUNG = '/proj/hung'

  it('does not hide a conversation recorded under the real folder the session\'s link is already known to have', async () => {
    put(1, REAL, 30)
    put(2, HUNG, 10)
    const out = await lib.walkRolloutsAsync(home, 30, LINK, undefined, { realpath: hangingOn(HUNG, ALL_ONE_FOLDER), waitMs: 30 })
    expect(out.map((c) => c.id)).toEqual([idOf(1)])
  })

  it('does not take back an answer already had: a link asked before is still resolved after it', async () => {
    put(1, LINK2, 30)
    put(2, HUNG, 20)
    put(3, LINK2, 10)
    const real = hangingOn(HUNG, ALL_ONE_FOLDER)
    const out = await lib.walkRolloutsAsync(home, 30, REAL, undefined, { realpath: real, waitMs: 30 })
    expect(out.map((c) => c.id)).toEqual([idOf(3), idOf(1)])
    // The link was asked once; the folder that did not answer was asked once.
    expect(real.mock.calls.map((c) => c[0]).sort()).toEqual([HUNG, LINK2, REAL].sort())
  })

  it('does not ask a new folder on the same drive once one has not answered', async () => {
    put(1, OTHER, 30)
    put(2, HUNG, 10)
    const real = hangingOn(HUNG, ALL_ONE_FOLDER)
    await lib.walkRolloutsAsync(home, 30, LINK, undefined, { realpath: real, waitMs: 30 })
    expect(real.mock.calls.map((c) => c[0])).toEqual([LINK, HUNG])
  })
})

describe('what the lookup asks the disk', () => {
  it('each folder once, however many rollouts name it', async () => {
    for (let n = 1; n <= 5; n++) put(n, OTHER)
    const real = fakeReal(ALL_ONE_FOLDER)
    await lib.walkRolloutsAsync(home, 30, LINK, undefined, { realpath: real })
    expect(real.mock.calls.map((c) => c[0]).sort()).toEqual([LINK, OTHER].sort())
  })

  it('never a relative spelling or a network share', async () => {
    put(1, '//server/share/proj')
    put(2, 'relative/dir')
    put(3, '')
    const real = fakeReal(ALL_ONE_FOLDER)
    await lib.walkRolloutsAsync(home, 30, LINK, undefined, { realpath: real })
    expect(real.mock.calls.map((c) => c[0])).toEqual([LINK])
  })

  it('with fs.promises.realpath, never the synchronous call', async () => {
    const project = join(home, 'project')
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(project)
    mkdirSync(elsewhere)
    put(1, elsewhere)
    put(2, project)
    const syncFull = vi.spyOn(nodeFs, 'realpathSync')
    const syncNative = vi.spyOn(nodeFs.realpathSync, 'native')
    const asyncReal = vi.spyOn(nodeFs.promises, 'realpath')
    const out = await lib.walkRolloutsAsync(home, 30, project)
    expect(out.map((c) => c.id)).toEqual([idOf(2)])
    expect(asyncReal).toHaveBeenCalled()
    expect(syncFull).not.toHaveBeenCalled()
    expect(syncNative).not.toHaveBeenCalled()
  })

  it('the lookup keeps a failure too, and never rejects', async () => {
    const real = fakeReal({ [LINK]: REAL })
    const look = lib.realPathLookup({ realpath: real })
    expect(await look(LINK)).toBe(REAL)
    expect(await look('/proj/missing')).toBeNull()
    expect(await look('/proj/missing')).toBeNull()
    expect(real.mock.calls.map((c) => c[0])).toEqual([LINK, '/proj/missing'])
  })
})

describe('what is listed is what the spelling walk lists', () => {
  it('the same conversations in the same order, when every folder is spelled alike', async () => {
    put(1, LINK, 30)
    put(2, LINK, 10)
    put(3, OTHER, 20)
    put(4, LINK, 20)
    const sync = lib.walkRollouts(home, 30, LINK)
    const async_ = await lib.walkRolloutsAsync(home, 30, LINK, undefined, { realpath: fakeReal(ALL_ONE_FOLDER) })
    expect(async_).toEqual(sync)
    expect(sync.map((c) => c.id)).toEqual([idOf(2), idOf(4), idOf(1)])
  })

  it('at most twenty, newest first', async () => {
    for (let n = 1; n <= 25; n++) put(n, LINK, n)
    const out = await lib.walkRolloutsAsync(home, 30, LINK, undefined, { realpath: fakeReal(ALL_ONE_FOLDER) })
    expect(out).toHaveLength(20)
    expect(out.map((c) => c.id)).toEqual(lib.walkRollouts(home, 30, LINK).map((c) => c.id))
    expect(out[0].id).toBe(idOf(1))
  })

  it('nothing when there is no sessions folder', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ccc-e1-picker-real-path-empty-'))
    try {
      expect(await lib.walkRolloutsAsync(empty, 30, LINK, undefined, { realpath: fakeReal(ALL_ONE_FOLDER) })).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
