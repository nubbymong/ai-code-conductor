/**
 * aicc_planning#306, items 2 and 4 (2.1.3-beta.5).
 *
 * Item 2: the usage worker opens the Claude projects folder by its real path
 * (kept as given when that cannot be resolved), and after a COMPLETE full walk
 * drops the progress rows of transcripts that no longer exist: in batches,
 * never after a walk that failed or fell short (a folder that would not list,
 * a missing root, a root that lists empty, a pass that threw), and never any
 * stored usage event.
 *
 * Item 4: a full walk does not list a subagent folder again when its folder
 * state (modified time, id, size) is the same as at the walk that last read it
 * and it had been left alone for a moment before that. A transcript added to
 * it changes the folder and is read; the first walk after start, a Rescan and
 * a re-index read every folder; a change deeper down is still found.
 *
 * Host-safe: the real worker and real transcript files in a temp folder, a
 * wrapped fs that counts folder listings and can make one fail, and an
 * in-memory stand-in for the index database (better-sqlite3 is built for
 * Electron; the two new database methods are covered with the real database
 * in tests/unit/native/tk-db-prune.native.test.ts). No process starts, no real
 * watcher runs and no link is planted: a link is shown by the wrapped fs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as realFs from 'fs'
import * as os from 'os'
import * as path from 'path'

type Cursor = { path: string; size: number; mtime: number; lastOffset: number; lastIngestedAt?: number; scannedTo?: number; readMark?: string; codexSessionId?: string; codexTurns?: number }
const db = vi.hoisted(() => ({
  cursors: new Map<string, Cursor>(),
  meta: new Map<string, string>(),
  /** Usage rows stored. The worker has no way to remove one: nothing here does. */
  events: 0,
  /** The next setMeta throws, once: a pass that fails part-way. */
  failNextSetMeta: false,
  /** The size of each call that deleted progress rows, and the paths. */
  deleteCalls: [] as string[][],
  /** The next listing of the progress paths throws, once. */
  failNextList: false,
}))
vi.mock('../../../src/main/tokenomics/tk-db', () => ({
  TK_REBUILD_PAGE: 5000,
  openTkDb: () => ({
    getFileCursor: (p: string) => db.cursors.get(p) ?? null,
    setFileCursor: (c: Cursor) => { db.cursors.set(c.path, c) },
    insertEvents: (b: unknown[]) => { db.events += b.length; return b.length },
    insertEventsWithCursor: (b: unknown[], c: Cursor) => { db.events += b.length; db.cursors.set(c.path, c); return b.length },
    getSessionCwd: () => '',
    accountRereadPending: () => false,
    finishAccountReread: () => {},
    rollupsDirty: () => false,
    beginRollupRebuild: () => {},
    stepRollupRebuild: () => ({ done: 1, total: 1, finished: true }),
    getMeta: (k: string) => db.meta.get(k),
    setMeta: (k: string, v: string) => {
      if (db.failNextSetMeta) { db.failNextSetMeta = false; throw new Error('simulated write failure') }
      db.meta.set(k, v)
    },
    eventCount: () => db.events,
    upsertConfigs: () => {},
    setSessionAccount: () => ({ recorded: true, stamped: 1 }),
    resetFileProgress: () => {
      for (const [p, c] of db.cursors) db.cursors.set(p, { ...c, lastOffset: 0, scannedTo: 0, readMark: '', codexSessionId: '', codexTurns: 0 })
      return db.cursors.size
    },
    listFilePaths: () => {
      if (db.failNextList) { db.failNextList = false; throw new Error('simulated read failure') }
      return [...db.cursors.keys()]
    },
    deleteFileRows: (paths: string[]) => { db.deleteCalls.push([...paths]); let n = 0; for (const p of paths) if (db.cursors.delete(p)) n++; return n },
    querySummary: () => ({}),
    querySessions: () => ({ rows: [], nextCursor: null }),
    querySessionDetail: () => null,
    queryAccounts: () => [],
    close: () => {},
  }),
}))

import { createTokenomicsWorker } from '../../../src/main/tokenomics/tokenomics-worker'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'
import type { FromTkWorker } from '../../../src/main/tokenomics/tk-worker-transport'

const PRICING = { 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }
const line = (id: string): string => JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T10:00:00Z', sessionId: 's1', requestId: `r-${id}`,
  message: { id: `m-${id}`, model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 10 } } }) + '\n'
const HOUR = 60 * 60_000

describe('tokenomics worker: dead progress rows and subagent folders (#306)', () => {
  let tmp = ''
  let claudeDir = ''
  let codexDir = ''
  let stopWorker: (() => void) | null = null
  let transport: FakeTkWorkerTransport | null = null
  /** Every folder listed, files asked the size of, files opened. */
  let listed: string[] = []
  let statted: string[] = []
  let opened: string[] = []
  let completes = 0
  let infos: string[] = []
  let warnings: string[] = []
  let errors: string[] = []
  let waiters: Array<(m: FromTkWorker) => boolean> = []
  const bounds = new Set<ReturnType<typeof setTimeout>>()
  /** Folders that cannot be listed, by path. */
  const listFails = new Set<string>()
  /** A folder path given to the worker, and the real path the wrapped fs
   *  resolves it to (a link, shown without planting one). */
  const realPaths = new Map<string, string>()
  /** Folder paths whose real path cannot be resolved. */
  const unresolvable = new Set<string>()
  /** Files whose next open fails, once. */
  const openFailsOnce = new Set<string>()
  /** The callbacks the worker gave each folder watcher, to report a write by hand. */
  let watchCallbacks: Array<{ dir: string; cb: (event: string, filename: string) => void }> = []

  const wrapped = new Proxy(realFs, {
    get(target, prop) {
      switch (prop) {
        case 'readdirSync': return (dir: string, o: unknown) => {
          listed.push(String(dir))
          if (listFails.has(String(dir))) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
          return (realFs.readdirSync as (d: string, o: unknown) => unknown)(dir, o)
        }
        case 'statSync': return (p: string, o?: unknown) => {
          statted.push(String(p))
          return (realFs.statSync as (p: string, o?: unknown) => unknown)(p, o)
        }
        case 'openSync': return (p: string, flags: string) => {
          opened.push(String(p))
          if (openFailsOnce.delete(String(p))) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
          return realFs.openSync(p, flags)
        }
        case 'watch': return (dir: string, _o: unknown, cb?: (event: string, filename: string) => void) => {
          if (cb) watchCallbacks.push({ dir: String(dir), cb })
          return { close() {}, on() {} }
        }
        case 'realpathSync': return Object.assign((p: string): string => realFs.realpathSync(p), {
          native: (p: string): string => {
            if (unresolvable.has(p)) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
            return realPaths.get(p) ?? realFs.realpathSync.native(p)
          },
        })
        default: return (target as unknown as Record<PropertyKey, unknown>)[prop]
      }
    },
  }) as typeof realFs

  function waitFor(what: string, pred: (m: FromTkWorker) => boolean, bound = 10_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { bounds.delete(timer); reject(new Error(`${what}: not within ${bound} ms`)) }, bound)
      bounds.add(timer)
      waiters.push((m) => {
        if (!pred(m)) return false
        clearTimeout(timer); bounds.delete(timer); resolve()
        return true
      })
    })
  }
  /** The next pass to say it is complete (ask BEFORE doing what causes it). */
  const nextSweep = (what: string): Promise<void> => waitFor(what, (m) => m.type === 'index-complete')
  /** Long enough for what the worker does after a pass says it is complete
   *  (the dropping of gone rows runs after that message). */
  const settle = (ms = 100): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const clearCounts = (): void => { listed = []; statted = []; opened = [] }

  async function start(given?: string, maxTickBytes?: number): Promise<void> {
    const fake = new FakeTkWorkerTransport()
    transport = fake
    fake.onMessage((m) => {
      if (m.type === 'index-complete') completes++
      if (m.type === 'log' && m.entry.level === 'info') infos.push(m.entry.message)
      if (m.type === 'log' && m.entry.level === 'warn') warnings.push(m.entry.message)
      if (m.type === 'log' && m.entry.level === 'error') errors.push(m.entry.message)
      waiters = waiters.filter((w) => !w(m))
    })
    const first = nextSweep('the first sweep')
    const w = createTokenomicsWorker(fake.asWorkerSide(), { fs: wrapped, watchDebounceMs: 5, ...(maxTickBytes ? { maxTickBytes } : {}) })
    stopWorker = () => w.stop()
    fake.post({ type: 'open', dbPath: path.join(tmp, 'tk.db'), pricing: PRICING, configs: [], claudeProjectsDir: given ?? claudeDir, codexSessionsDir: codexDir })
    await first
    await settle()
  }
  /** Another full pass over every folder, without the worker forgetting what
   *  it remembers of the subagent folders (naming the account folders again
   *  makes one due). */
  async function fullPass(): Promise<void> {
    const pass = nextSweep('a full pass')
    transport!.post({ type: 'set-codex-realm-dirs', dirs: [] })
    await pass
    await settle()
  }
  async function send(type: 'reindex' | 'rescan'): Promise<void> {
    const pass = nextSweep(`the pass after ${type}`)
    transport!.post({ type })
    await pass
    await settle()
  }

  const proj = (...p: string[]): string => path.join(claudeDir, 'F--proj', ...p)
  const subs = (): string => proj('s9', 'subagents')
  const agent = (name: string): string => path.join(subs(), `${name}.jsonl`)
  /** Make a folder look as if it was last written an hour ago. */
  const age = (dir: string): void => { const t = new Date(Date.now() - HOUR); realFs.utimesSync(dir, t, t) }
  const make = (file: string, id: string): void => { realFs.mkdirSync(path.dirname(file), { recursive: true }); realFs.writeFileSync(file, line(id)) }

  beforeEach(() => {
    tmp = realFs.realpathSync.native(realFs.mkdtempSync(path.join(os.tmpdir(), 'tkprune-')))
    claudeDir = path.join(tmp, 'claude')
    codexDir = path.join(tmp, 'codex')
    realFs.mkdirSync(path.join(claudeDir, 'F--proj'), { recursive: true })
    realFs.mkdirSync(codexDir, { recursive: true })
    for (let i = 0; i < 4; i++) make(proj(`s${i}.jsonl`), `init-${i}`)
    db.cursors.clear(); db.meta.clear(); db.events = 0; db.failNextSetMeta = false; db.deleteCalls = []; db.failNextList = false
    clearCounts()
    completes = 0; infos = []; warnings = []; errors = []; waiters = []; transport = null
    listFails.clear(); realPaths.clear(); unresolvable.clear(); openFailsOnce.clear(); watchCallbacks = []
  })
  afterEach(() => {
    try { stopWorker?.() } catch { /* stopped */ }
    stopWorker = null
    for (const timer of bounds) clearTimeout(timer)
    bounds.clear()
    realFs.rmSync(tmp, { recursive: true, force: true })
  })

  const rows = (): string[] => [...db.cursors.keys()].sort()
  const four = (): string[] => [0, 1, 2, 3].map((i) => proj(`s${i}.jsonl`))

  describe('the projects folder is opened by its real path (item 2)', () => {
    it('a folder given as a link is read, and its rows are kept, under the real path', async () => {
      const link = path.join(tmp, 'profile-link', 'projects')
      realPaths.set(link, claudeDir)
      await start(link)
      expect(rows()).toEqual(four().sort())
      expect(rows().filter((p) => p.startsWith(link))).toEqual([])
      // Nothing was listed under the link's own path.
      expect(listed.filter((d) => d.startsWith(path.join(tmp, 'profile-link')))).toEqual([])
    })

    it('the path as given is kept when it cannot be resolved', async () => {
      unresolvable.add(claudeDir)
      await start(claudeDir)
      expect(rows()).toEqual(four().sort())
      expect(errors).toEqual([])
    })
  })

  describe('rows of transcripts that are gone (item 2)', () => {
    it('a complete full walk drops the rows of transcripts that no longer exist, and keeps the rest and every stored event', async () => {
      await start()
      expect(rows()).toHaveLength(4)
      const stored = db.events
      realFs.rmSync(proj('s1.jsonl'))
      realFs.rmSync(proj('s3.jsonl'))
      await fullPass()
      expect(rows()).toEqual([proj('s0.jsonl'), proj('s2.jsonl')])
      // No stored usage was touched and nothing was read again.
      expect(db.events).toBe(stored)
      expect(infos.some((m) => /dropped the progress of 2 transcripts/.test(m))).toBe(true)
    })

    it('rows under another path (the folder\'s link, before it was opened by its real path) are dropped once the real files are listed', async () => {
      await start()
      const old = path.join(tmp, 'profile-link', 'projects', 'F--proj', 's0.jsonl')
      db.cursors.set(old, { path: old, size: 10, mtime: 1, lastOffset: 10, scannedTo: 10 })
      await fullPass()
      expect(rows()).toEqual(four().sort())
    })

    it('rows are dropped in batches, and every one of them goes', async () => {
      await start()
      for (let i = 0; i < 1300; i++) { const p = proj(`gone-${i}.jsonl`); db.cursors.set(p, { path: p, size: 1, mtime: 1, lastOffset: 1, scannedTo: 1 }) }
      await fullPass()
      expect(rows()).toEqual(four().sort())
      expect(db.deleteCalls.length).toBeGreaterThanOrEqual(3)
      expect(Math.max(...db.deleteCalls.map((c) => c.length))).toBeLessThanOrEqual(500)
      expect(db.deleteCalls.flat()).toHaveLength(1300)
    })

    it('a rollout row is dropped only when its file is not found, and one whose file is there is kept', async () => {
      await start()
      const there = path.join(tmp, 'elsewhere', 'rollout-2026-08-01T00-00-00-there.jsonl')
      const missing = path.join(tmp, 'elsewhere', 'rollout-2026-08-01T00-00-00-missing.jsonl')
      realFs.mkdirSync(path.dirname(there), { recursive: true })
      realFs.writeFileSync(there, 'x\n')
      for (const p of [there, missing]) db.cursors.set(p, { path: p, size: 2, mtime: 1, lastOffset: 2, scannedTo: 2 })
      await fullPass()
      expect(rows()).toEqual([...four(), there].sort())
    })

    it('a row written since the pass began (a transcript made after its folder was listed) is kept, and an older one is dropped', async () => {
      await start()
      const fresh = proj('made-during-the-pass.jsonl')
      const stale = proj('gone-long-ago.jsonl')
      db.cursors.set(fresh, { path: fresh, size: 1, mtime: 1, lastOffset: 1, scannedTo: 1, lastIngestedAt: Date.now() + 60_000 })
      db.cursors.set(stale, { path: stale, size: 1, mtime: 1, lastOffset: 1, scannedTo: 1, lastIngestedAt: 1 })
      await fullPass()
      expect(rows()).toContain(fresh)
      expect(rows()).not.toContain(stale)
    })

    describe('and never after a walk that did not list the whole tree', () => {
      /** Seed the rows, take two transcripts away, then make a full walk. */
      async function goneThenWalk(spoil: () => void): Promise<void> {
        await start()
        realFs.rmSync(proj('s1.jsonl'))
        realFs.rmSync(proj('s3.jsonl'))
        spoil()
        await fullPass()
      }

      it('a folder that would not list', async () => {
        realFs.mkdirSync(path.join(claudeDir, 'G--other'))
        await goneThenWalk(() => { listFails.add(path.join(claudeDir, 'G--other')) })
        expect(rows()).toEqual(four().sort())
        expect(db.deleteCalls).toEqual([])
      })

      it('the root itself would not list', async () => {
        await goneThenWalk(() => { listFails.add(claudeDir) })
        expect(rows()).toEqual(four().sort())
        expect(db.deleteCalls).toEqual([])
      })

      it('the root is missing', async () => {
        await goneThenWalk(() => { realFs.rmSync(claudeDir, { recursive: true, force: true }) })
        expect(rows()).toEqual(four().sort())
        expect(db.deleteCalls).toEqual([])
      })

      it('the root lists empty (as a drive that is not mounted does)', async () => {
        await goneThenWalk(() => { realFs.rmSync(path.join(claudeDir, 'F--proj'), { recursive: true, force: true }) })
        expect(rows()).toEqual(four().sort())
        expect(db.deleteCalls).toEqual([])
      })

      it('the pass threw before it finished', async () => {
        await start()
        realFs.rmSync(proj('s1.jsonl'))
        db.failNextSetMeta = true
        // A pass that threw says nothing is complete; its error is logged.
        const failed = waitFor('the failure is logged', (m) => m.type === 'log' && m.entry.level === 'error')
        transport!.post({ type: 'set-codex-realm-dirs', dirs: [] })
        await failed
        await settle()
        expect(rows()).toContain(proj('s1.jsonl'))
        expect(db.deleteCalls).toEqual([])
        // The next pass is whole, and drops it.
        await fullPass()
        expect(rows()).not.toContain(proj('s1.jsonl'))
      })

      it('listing the rows failed: it is logged as a warning, no pass fails, and nothing is dropped', async () => {
        await start()
        realFs.rmSync(proj('s1.jsonl'))
        db.failNextList = true
        await fullPass()
        expect(rows()).toContain(proj('s1.jsonl'))
        expect(warnings.some((m) => /dropping the progress of gone transcripts failed/.test(m))).toBe(true)
        expect(errors).toEqual([])
        // The next complete walk drops it.
        await fullPass()
        expect(rows()).not.toContain(proj('s1.jsonl'))
      })
    })
  })

  describe('subagent folders that have not changed are not listed again (item 4)', () => {
    /** A session with one subagent transcript, its folders left alone. */
    function plantSubagents(): void {
      make(agent('agent-a'), 'sub-a')
      age(subs()); age(proj('s9')); age(proj())
    }

    it('the first walk after start reads every folder', async () => {
      plantSubagents()
      await start()
      expect(listed).toContain(subs())
      expect(opened).toContain(agent('agent-a'))
      expect(db.cursors.has(agent('agent-a'))).toBe(true)
    })

    it('an unchanged subagent folder is asked about but not listed, its transcripts are not asked about, and their rows are kept', async () => {
      plantSubagents()
      await start()
      clearCounts()
      await fullPass()
      // The folder's state was read; the folder was not listed and its
      // transcript was neither asked about nor opened.
      expect(statted).toContain(subs())
      expect(listed).not.toContain(subs())
      expect(statted).not.toContain(agent('agent-a'))
      expect(opened).not.toContain(agent('agent-a'))
      // Its row stays: the transcript is still there.
      expect(db.cursors.has(agent('agent-a'))).toBe(true)
      expect(db.deleteCalls).toEqual([])
      // The rest of the tree is walked as before.
      expect(listed).toEqual(expect.arrayContaining([claudeDir, proj(), proj('s9')]))
      expect(statted).toContain(proj('s0.jsonl'))
    })

    it('a transcript added to the folder changes it, so the folder is listed and the transcript read', async () => {
      plantSubagents()
      await start()
      const before = db.events
      make(agent('agent-b'), 'sub-b')
      clearCounts()
      await fullPass()
      expect(listed).toContain(subs())
      expect(opened).toContain(agent('agent-b'))
      expect(db.events).toBe(before + 1)
      // Left alone for a while after that, it is not listed again.
      age(subs())
      clearCounts()
      await fullPass()
      await fullPass()
      // Once (it is remembered as it is then), not at each walk.
      expect(listed.filter((d) => d === subs())).toHaveLength(1)
    })

    it('a folder written to a moment ago is not trusted: it is listed again at the next walk', async () => {
      make(agent('agent-a'), 'sub-a')
      age(proj('s9')); age(proj())
      // Written, as far as the folder says, a minute from now: never settled.
      const soon = new Date(Date.now() + 60_000)
      realFs.utimesSync(subs(), soon, soon)
      await start()
      clearCounts()
      await fullPass()
      expect(listed).toContain(subs())
    })

    it('a change deeper down is found though the folder above it has not changed', async () => {
      const run = path.join(subs(), 'workflows', 'run-1')
      make(path.join(run, 'agent-w1.jsonl'), 'w1')
      for (const d of [run, path.join(subs(), 'workflows'), subs(), proj('s9'), proj()]) age(d)
      await start()
      expect(db.cursors.has(path.join(run, 'agent-w1.jsonl'))).toBe(true)
      // A second transcript lands in the deepest folder only.
      make(path.join(run, 'agent-w2.jsonl'), 'w2')
      clearCounts()
      const before = db.events
      await fullPass()
      expect(listed).toContain(run)
      expect(listed).not.toContain(subs())
      expect(opened).toContain(path.join(run, 'agent-w2.jsonl'))
      expect(db.events).toBe(before + 1)
    })

    it('Rescan reads every folder again', async () => {
      plantSubagents()
      await start()
      await fullPass()
      clearCounts()
      await send('rescan')
      expect(listed).toContain(subs())
      expect(opened).toContain(agent('agent-a'))
    })

    it('a re-index reads every folder again', async () => {
      plantSubagents()
      await start()
      await fullPass()
      clearCounts()
      await send('reindex')
      expect(listed).toContain(subs())
    })

    it('the first walk after the worker starts again reads every folder', async () => {
      plantSubagents()
      await start()
      await fullPass()
      stopWorker?.(); stopWorker = null
      clearCounts()
      await start()
      expect(listed).toContain(subs())
    })

    it('a transcript longer than one budget is read to its end across passes though its folder has not changed', async () => {
      const big = agent('agent-big')
      realFs.mkdirSync(path.dirname(big), { recursive: true })
      const count = 60
      realFs.writeFileSync(big, Array.from({ length: count }, (_, i) => line(`big-${i}`)).join(''))
      age(subs()); age(proj('s9')); age(proj())
      const size = realFs.statSync(big).size
      // About a tenth of the file at a time.
      await start(undefined, Math.ceil(size / 10))
      for (let i = 0; i < 30 && (db.cursors.get(big)?.lastOffset ?? 0) < size; i++) await fullPass()
      expect(db.cursors.get(big)?.lastOffset).toBe(size)
      expect(db.events).toBe(4 + count)
    })

    it('a transcript the watcher reported and one budget did not finish is read to its end at the next walks though its folder has not changed', async () => {
      plantSubagents()
      const oneLine = Buffer.byteLength(line('x'))
      // A budget of about twenty lines: the first walk reads everything and remembers the folder.
      await start(undefined, oneLine * 20)
      expect(db.cursors.has(agent('agent-a'))).toBe(true)
      // The transcript grows in place by three budgets; its folder is not touched.
      const count = 60
      realFs.appendFileSync(agent('agent-a'), Array.from({ length: count }, (_, i) => line(`grow-${i}`)).join(''))
      const size = realFs.statSync(agent('agent-a')).size
      // The watcher reports it: the reported read stops at the budget.
      const reported = nextSweep('the reported read')
      for (const w of watchCallbacks) if (w.dir === claudeDir) w.cb('change', path.relative(claudeDir, agent('agent-a')))
      await reported
      await settle()
      expect(db.cursors.get(agent('agent-a'))?.lastOffset ?? 0).toBeLessThan(size)
      // The full walks that follow list the folder again and finish it.
      for (let i = 0; i < 30 && (db.cursors.get(agent('agent-a'))?.lastOffset ?? 0) < size; i++) await fullPass()
      expect(db.cursors.get(agent('agent-a'))?.lastOffset).toBe(size)
      expect(db.events).toBe(5 + count)
    })

    it('a transcript that could not be opened is tried again at the next walk though its folder has not changed', async () => {
      plantSubagents()
      openFailsOnce.add(agent('agent-a'))
      await start()
      expect(db.cursors.has(agent('agent-a'))).toBe(false)
      await fullPass()
      expect(opened.filter((p) => p === agent('agent-a')).length).toBeGreaterThanOrEqual(2)
      expect(db.cursors.has(agent('agent-a'))).toBe(true)
      expect(db.events).toBe(5)
    })

    it('a transcript removed from a remembered folder changes it, so the folder is listed and the transcript\'s row is dropped', async () => {
      plantSubagents()
      await start()
      realFs.rmSync(agent('agent-a'))
      // Removing it changed the folder.
      await fullPass()
      expect(listed).toContain(subs())
      expect(db.cursors.has(agent('agent-a'))).toBe(false)
    })
  })
})
