/**
 * aicc_planning#302: between full walks the usage worker reads only the
 * transcripts the folder watcher reported. The whole tree is listed at start,
 * on a re-index, on an event that names no transcript, and as a safety net
 * every TK_FULL_SWEEP_MS. A full walk that leaves work behind runs again
 * until every file is read, a changed-files sweep that fails makes the next
 * sweep a full one, a named folder with no watcher (it did not exist yet, or
 * its watcher failed) is tried again by the 5 s timer, and a reported
 * transcript that is a link is left alone, as the full walk leaves it.
 *
 * Host-safe: the real worker and real transcript files in a temp folder, a
 * wrapped fs that counts folder listings and file reads and hands the
 * watcher's callback to the test, and an in-memory stand-in for the index
 * database (better-sqlite3 is built for Electron; the totals are covered with
 * the real database in tests/unit/native/tokenomics-dirty-sweep.native.test.ts).
 * No process starts, no real watcher runs and no link is planted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as realFs from 'fs'
import * as os from 'os'
import * as path from 'path'

type Cursor = { path: string; size: number; mtime: number; lastOffset: number; scannedTo?: number }
const db = vi.hoisted(() => ({
  cursors: new Map<string, Cursor>(),
  meta: new Map<string, string>(),
  /** Rows stored. Nothing is deduplicated here, so bytes read twice show up. */
  events: 0,
  /** The next setMeta throws, once: a full sweep that fails part-way. */
  failNextSetMeta: false,
  /** The next getFileCursor throws, once: a sweep that fails before it reads a file. */
  failNextGetCursor: false,
}))
vi.mock('../../../src/main/tokenomics/tk-db', () => ({
  TK_REBUILD_PAGE: 5000,
  openTkDb: () => ({
    getFileCursor: (p: string) => {
      if (db.failNextGetCursor) { db.failNextGetCursor = false; throw new Error('simulated read failure') }
      return db.cursors.get(p) ?? null
    },
    setFileCursor: (c: Cursor) => { db.cursors.set(c.path, c) },
    insertEvents: (b: unknown[]) => { db.events += b.length; return b.length },
    insertEventsWithCursor: (b: unknown[], c: Cursor) => { db.events += b.length; db.cursors.set(c.path, c); return b.length },
    getSessionCwd: () => '',
    accountRereadPending: () => db.meta.get('accountReread') === 'pending',
    finishAccountReread: () => { db.meta.set('accountReread', 'done') },
    rollupsDirty: () => false,
    beginRollupRebuild: () => {},
    stepRollupRebuild: () => ({ done: 0, total: 0, finished: true }),
    getMeta: (k: string) => db.meta.get(k),
    setMeta: (k: string, v: string) => {
      if (db.failNextSetMeta) { db.failNextSetMeta = false; throw new Error('simulated write failure') }
      db.meta.set(k, v)
    },
    eventCount: () => db.events,
    upsertConfigs: () => {},
    setSessionAccount: () => {},
    queryAccounts: () => [],
    close: () => {},
  }),
}))

import { createTokenomicsWorker, TK_FULL_SWEEP_MS } from '../../../src/main/tokenomics/tokenomics-worker'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'
import type { FromTkWorker } from '../../../src/main/tokenomics/tk-worker-transport'

const PRICING = { 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }
/** The worker's periodic timer. */
const TAIL_MS = 5000
/** One billed turn, as a transcript line (about 200 bytes). */
const line = (id: string): string => JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T10:00:00Z', sessionId: 's1', requestId: `r-${id}`,
  message: { id: `m-${id}`, model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 10 } } }) + '\n'
/** A Codex rollout: its header line, then one line per turn. */
function rollout(id: string, turns: number): string {
  const lines = [JSON.stringify({ type: 'session_meta', timestamp: '2026-08-01T00:00:00Z', payload: { id, cwd: '/work/proj', model: 'gpt-5.5' } })]
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ type: 'event_msg', timestamp: `2026-08-01T00:00:${String(10 + i).padStart(2, '0')}Z`, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 10 }, last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 10 } } } }))
  }
  return lines.join('\n') + '\n'
}
/** Long enough for a debounced sweep (5 ms here) to have run many times over. */
const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms))

type WatchCb = (event: string, filename: string | null) => void
type Complete = { firstIndex: boolean; drained: boolean }

describe('tokenomics worker: changed-files sweep (#302)', () => {
  let tmp = ''
  let claudeDir = ''
  let codexDir = ''
  let stopWorker: (() => void) | null = null
  /** Folder listings, and how many were of the transcript root: one per full walk. */
  let listings = 0
  let walks = 0
  /** Files the worker asked the size of, and files it opened to read. */
  let statted: string[] = []
  let opened: string[] = []
  let completes: Complete[] = []
  /** How many files each finished sweep said it could not read. */
  let failed: number[] = []
  let waiters: Array<(m: FromTkWorker) => boolean> = []
  const bounds = new Set<ReturnType<typeof setTimeout>>()
  /** The live watchers, by folder: what the worker handed each to be told of
   *  a change, and of the watcher's own failure. */
  const watchCbs = new Map<string, WatchCb>()
  const watchErrs = new Map<string, (err: unknown) => void>()
  /** Folders whose watcher cannot be started. */
  const unwatchable = new Set<string>()
  /** What the worker logged as a warning. */
  let warnings: string[] = []
  /** A path the wrapped fs shows as a link to `linkTarget`: lstat says link,
   *  stat and open follow it. Nothing is on disk at the path itself. */
  let linkAt = ''
  let linkTarget = ''
  /** A file whose reads come back empty although it has bytes. */
  let stuck = ''
  /** A file that cannot be opened. */
  let denied = ''
  const stuckFds = new Set<number>()

  const follow = (p: unknown): string => (linkAt && String(p) === linkAt ? linkTarget : String(p))
  const LINK = { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false }
  const wrapped = new Proxy(realFs, {
    get(target, prop) {
      switch (prop) {
        case 'readdirSync': return (dir: string, o: unknown) => {
          listings++
          if (path.resolve(String(dir)) === path.resolve(claudeDir)) walks++
          return (realFs.readdirSync as (d: string, o: unknown) => unknown)(dir, o)
        }
        case 'watch': return (dir: string, _o: unknown, cb: WatchCb) => {
          if (unwatchable.has(dir)) throw new Error('simulated watch failure')
          watchCbs.set(dir, cb)
          return {
            close() { if (watchCbs.get(dir) === cb) { watchCbs.delete(dir); watchErrs.delete(dir) } },
            on(event: string, handler: (err: unknown) => void) { if (event === 'error') watchErrs.set(dir, handler) },
          }
        }
        case 'statSync': return (p: string, o?: unknown) => {
          statted.push(String(p))
          return (realFs.statSync as (p: string, o?: unknown) => unknown)(follow(p), o)
        }
        case 'lstatSync': return (p: string, o?: unknown) => (linkAt && String(p) === linkAt ? LINK : (realFs.lstatSync as (p: string, o?: unknown) => unknown)(p, o))
        case 'openSync': return (p: string, flags: string) => {
          if (denied && String(p) === denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
          opened.push(String(p))
          const fd = realFs.openSync(follow(p), flags)
          if (stuck && String(p) === stuck) stuckFds.add(fd)
          return fd
        }
        case 'readSync': return (fd: number, ...rest: unknown[]) => (stuckFds.has(fd) ? 0 : (realFs.readSync as (fd: number, ...r: unknown[]) => number)(fd, ...rest))
        case 'closeSync': return (fd: number) => { stuckFds.delete(fd); realFs.closeSync(fd) }
        default: return (target as unknown as Record<PropertyKey, unknown>)[prop]
      }
    },
  }) as typeof realFs

  /** Resolves on the first message from the worker that matches, within a
   *  bound. Ask BEFORE doing what causes the message. The bound is generous
   *  for a loaded CI runner; a passing run never waits for it. */
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
  const nextSweep = (what: string): Promise<void> => waitFor(what, (m) => m.type === 'index-complete')
  const drainedSweep = (what: string): Promise<void> => waitFor(what, (m) => m.type === 'index-complete' && m.drained)
  const clearCounts = (): void => { listings = 0; walks = 0; statted = []; opened = [] }
  const transcript = (name: string): string => path.join(claudeDir, 'F--proj', `${name}.jsonl`)
  const fire = (dir: string, event: string, filename: string | null): void => watchCbs.get(dir)!(event, filename)
  /** Only the periodic timer and the clock are faked: sweeps still run on real
   *  timers, so the test decides when 5 s (or 5 min) has passed. */
  const fakeTheTimer = (): void => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }) }

  /** Start the worker on the temp tree; by default wait for its first sweep. */
  async function start(opts: { maxTickBytes?: number; waitFirst?: boolean } = {}): Promise<void> {
    const fake = new FakeTkWorkerTransport()
    fake.onMessage((m) => {
      if (m.type === 'index-complete') { completes.push({ firstIndex: m.firstIndex, drained: m.drained }); failed.push(m.filesFailed) }
      if (m.type === 'log' && m.entry.level === 'warn') warnings.push(m.entry.message)
      waiters = waiters.filter((w) => !w(m))
    })
    const first = opts.waitFirst === false ? null : nextSweep('the first sweep')
    const w = createTokenomicsWorker(fake.asWorkerSide(), { fs: wrapped, watchDebounceMs: 5, maxTickBytes: opts.maxTickBytes })
    stopWorker = () => w.stop()
    fake.post({ type: 'open', dbPath: path.join(tmp, 'tk.db'), pricing: PRICING, configs: [], claudeProjectsDir: claudeDir, codexSessionsDir: codexDir })
    if (first) await first
  }

  beforeEach(() => {
    tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'tkchanged-'))
    claudeDir = path.join(tmp, 'claude')
    codexDir = path.join(tmp, 'codex')
    realFs.mkdirSync(path.join(claudeDir, 'F--proj'), { recursive: true })
    realFs.mkdirSync(codexDir, { recursive: true })
    for (let i = 0; i < 5; i++) realFs.writeFileSync(transcript(`s${i}`), line(`init-${i}`))
    db.cursors.clear(); db.meta.clear(); db.events = 0; db.failNextSetMeta = false; db.failNextGetCursor = false
    clearCounts()
    completes = []; failed = []; waiters = []; warnings = []
    watchCbs.clear(); watchErrs.clear(); unwatchable.clear()
    linkAt = ''; linkTarget = ''; stuck = ''; stuckFds.clear(); denied = ''
  })
  afterEach(() => {
    try { stopWorker?.() } catch { /* stopped */ }
    stopWorker = null
    for (const timer of bounds) clearTimeout(timer)
    bounds.clear()
    vi.useRealTimers()
    realFs.rmSync(tmp, { recursive: true, force: true })
  })

  describe('what is read', () => {
    it('the first sweep lists the tree and reads every transcript', async () => {
      await start()
      expect(walks).toBe(1)
      expect([...opened].sort()).toEqual([0, 1, 2, 3, 4].map((i) => transcript(`s${i}`)).sort())
      expect(db.events).toBe(5)
      expect(completes).toEqual([{ firstIndex: true, drained: true }])
    })

    it('a reported transcript is read on its own: no folder is listed and no other file is touched', async () => {
      await start()
      const reported = transcript('s2')
      const unreported = transcript('s3')
      realFs.appendFileSync(reported, line('more-2'))
      realFs.appendFileSync(unreported, line('more-3'))
      clearCounts()
      const read = nextSweep('the changed-files sweep')
      fire(claudeDir, 'change', path.join('F--proj', 's2.jsonl'))
      await read
      expect(listings).toBe(0)
      expect(opened).toEqual([reported])
      expect(new Set(statted)).toEqual(new Set([reported]))
      expect(db.events).toBe(6)
      // It says it is done, as a full sweep does, so the Usage page refreshes.
      expect(completes.at(-1)).toEqual({ firstIndex: false, drained: true })
      // The file nobody reported waits for the next full walk: here, a folder event.
      expect(db.cursors.get(unreported)!.size).toBeLessThan(realFs.statSync(unreported).size)
      const full = nextSweep('the full sweep')
      fire(claudeDir, 'rename', 'F--proj')
      await full
      expect(walks).toBe(1)
      expect(db.events).toBe(7)
    })

    it('a newly made transcript, a nested one included, is read on its own', async () => {
      await start()
      const dir = path.join(claudeDir, 'F--proj', 's9', 'subagents')
      realFs.mkdirSync(dir, { recursive: true })
      realFs.writeFileSync(path.join(dir, 'agent-x.jsonl'), line('sub'))
      clearCounts()
      const read = nextSweep('the changed-files sweep')
      fire(claudeDir, 'rename', path.join('F--proj', 's9', 'subagents', 'agent-x.jsonl'))
      await read
      expect(listings).toBe(0)
      expect(opened).toEqual([path.join(dir, 'agent-x.jsonl')])
      expect(db.events).toBe(6)
    })

    const noTranscript: Array<[string, 'claude' | 'codex', string | null]> = [
      ['no file name', 'claude', null],
      ['a folder', 'claude', 'F--proj'],
      ['a deleted transcript', 'claude', path.join('F--proj', 'gone.jsonl')],
      ['a file that is not a transcript', 'claude', path.join('F--proj', 'notes.txt')],
      // Not narrowed yet: any event in a Codex sessions folder walks everything.
      ['a rollout in the Codex sessions folder', 'codex', 'rollout-2026-08-01T00-00-00-x.jsonl'],
    ]
    for (const [what, where, filename] of noTranscript) {
      it(`an event that names ${what} makes the next sweep a full one`, async () => {
        await start()
        // Written but never reported: only a full walk can find it.
        realFs.writeFileSync(transcript('unseen'), line('unseen'))
        clearCounts()
        const full = nextSweep('the full sweep')
        fire(where === 'claude' ? claudeDir : codexDir, 'rename', filename)
        await full
        expect(walks).toBe(1)
        expect(opened).toEqual([transcript('unseen')])
        expect(db.events).toBe(6)
      })
    }

    it('a transcript that could not be read stays counted while others are read on their own, until it is read', async () => {
      denied = transcript('s1')
      await start()
      expect(failed).toEqual([1])
      expect(db.events).toBe(4)
      // Another file's change says nothing about the one that could not be read.
      realFs.appendFileSync(transcript('s2'), line('more-2'))
      let read = nextSweep('the changed-files sweep')
      fire(claudeDir, 'change', path.join('F--proj', 's2.jsonl'))
      await read
      expect(failed.at(-1)).toBe(1)
      // Reported and still not readable: the same one file, counted once.
      read = nextSweep('the changed-files sweep')
      fire(claudeDir, 'change', path.join('F--proj', 's1.jsonl'))
      await read
      expect(failed.at(-1)).toBe(1)
      // Reported and readable now: read, and no longer counted.
      denied = ''
      read = nextSweep('the changed-files sweep')
      fire(claudeDir, 'change', path.join('F--proj', 's1.jsonl'))
      await read
      expect(failed.at(-1)).toBe(0)
      expect(db.events).toBe(6)
    })

    it('the 5 s timer lists and reads nothing until a full sweep is due again, then walks once', async () => {
      fakeTheTimer()
      await start()
      clearCounts()
      // Every tick but the last of the five minutes.
      vi.advanceTimersByTime(TK_FULL_SWEEP_MS - TAIL_MS)
      await settle()
      expect({ listings, statted, opened }).toEqual({ listings: 0, statted: [], opened: [] })
      expect(completes).toHaveLength(1)
      const due = nextSweep('the safety-net sweep')
      vi.advanceTimersByTime(TAIL_MS)
      await due
      expect(walks).toBe(1)
    })
  })

  describe('a full sweep that leaves work behind', () => {
    it('runs again at once, with no event or timer tick, until every byte is read; then it stops', async () => {
      const big = transcript('big')
      realFs.writeFileSync(big, Array.from({ length: 12 }, (_, i) => line(`big-${i}`)).join(''))
      const drained = drainedSweep('a drained sweep')
      // Each pass reads at most 512 bytes of a file: two of its lines.
      await start({ maxTickBytes: 512 })
      expect(completes[0]).toEqual({ firstIndex: false, drained: false })
      await drained
      // Every pass was a full walk that read further; only the last drained.
      expect(completes.length).toBeGreaterThan(2)
      expect(completes.slice(0, -1).every((c) => !c.drained && !c.firstIndex)).toBe(true)
      expect(completes.at(-1)).toEqual({ firstIndex: true, drained: true })
      expect(walks).toBe(completes.length)
      expect(db.cursors.get(big)!.scannedTo).toBe(realFs.statSync(big).size)
      expect(db.events).toBe(5 + 12)
      // Nothing walks again once the bytes are read.
      await settle()
      expect(walks).toBe(completes.length)
    })

    it('a Codex account re-read that needs several passes finishes without waiting for the next timed walk', async () => {
      const day = path.join(codexDir, '2026', '08', '01')
      realFs.mkdirSync(day, { recursive: true })
      const file = path.join(day, 'rollout-2026-08-01T00-00-00-a.jsonl')
      realFs.writeFileSync(file, rollout('cx-a', 10))
      db.meta.set('accountReread', 'pending')
      const drained = drainedSweep('a drained sweep')
      await start({ maxTickBytes: 512 })
      expect(completes[0]).toEqual({ firstIndex: false, drained: false })
      // Not done while a rollout still has bytes to read.
      expect(db.meta.get('accountReread')).toBe('pending')
      await drained
      expect(completes.length).toBeGreaterThan(2)
      expect(db.cursors.get(file)!.scannedTo).toBe(realFs.statSync(file).size)
      expect(db.events).toBe(5 + 10)
      expect(db.meta.get('accountReread')).toBe('done')
    })

    it('a pass that left bytes without moving a cursor is not repeated at once; the 5 s timer retries it', async () => {
      fakeTheTimer()
      stuck = transcript('s4')
      await start()
      expect(completes).toEqual([{ firstIndex: false, drained: false }])
      // No spin: a repeat at once would have walked many times by now.
      await settle()
      expect(walks).toBe(1)
      const retried = nextSweep('the retry at the next tick')
      vi.advanceTimersByTime(TAIL_MS)
      await retried
      expect(walks).toBe(2)
      expect(completes.at(-1)).toEqual({ firstIndex: false, drained: false })
      // Once the file can be read, the next tick's pass drains.
      stuck = ''
      const drained = drainedSweep('the drained sweep')
      vi.advanceTimersByTime(TAIL_MS)
      await drained
      expect(walks).toBe(3)
      expect(db.events).toBe(5)
    })

    it('a sweep that fails part-way is due again at the next 5 s tick', async () => {
      fakeTheTimer()
      db.failNextSetMeta = true
      const failure = waitFor('the failed sweep', (m) => m.type === 'log' && m.entry.level === 'error')
      await start({ waitFirst: false })
      await failure
      expect(completes).toEqual([])
      const again = drainedSweep('the sweep after the failure')
      vi.advanceTimersByTime(TAIL_MS)
      await again
      expect(walks).toBe(2)
      expect(completes).toEqual([{ firstIndex: true, drained: true }])
    })
  })

  describe('a changed-files sweep that fails part-way', () => {
    it('makes the next sweep a full one, run by the 5 s timer and not at once', async () => {
      fakeTheTimer()
      await start()
      // Two reported transcripts: the sweep fails on the first and never
      // reaches the second, and both are out of the set by then.
      realFs.appendFileSync(transcript('s1'), line('more-1'))
      realFs.appendFileSync(transcript('s2'), line('more-2'))
      clearCounts()
      db.failNextGetCursor = true
      const failure = waitFor('the failed sweep', (m) => m.type === 'log' && m.entry.level === 'error')
      fire(claudeDir, 'change', path.join('F--proj', 's1.jsonl'))
      fire(claudeDir, 'change', path.join('F--proj', 's2.jsonl'))
      await failure
      await settle()
      expect({ walks, opened, events: db.events }).toEqual({ walks: 0, opened: [], events: 5 })
      const full = nextSweep('the full sweep after the failure')
      vi.advanceTimersByTime(TAIL_MS)
      await full
      expect(walks).toBe(1)
      expect([...opened].sort()).toEqual([transcript('s1'), transcript('s2')].sort())
      expect(db.events).toBe(7)
    })
  })

  describe('a named folder with no watcher', () => {
    it('costs no walk while it does not exist; once it does, the next 5 s tick watches it and reads what it holds', async () => {
      fakeTheTimer()
      realFs.rmSync(codexDir, { recursive: true, force: true })
      await start()
      expect(watchCbs.has(codexDir)).toBe(false)
      clearCounts()
      vi.advanceTimersByTime(TAIL_MS * 3)
      await settle()
      expect({ listings, statted, opened }).toEqual({ listings: 0, statted: [], opened: [] })
      // An account's first session makes its sessions folder and writes there.
      const day = path.join(codexDir, '2026', '08', '01')
      realFs.mkdirSync(day, { recursive: true })
      realFs.writeFileSync(path.join(day, 'rollout-2026-08-01T00-00-00-a.jsonl'), rollout('cx-a', 2))
      const found = nextSweep('the walk that finds the new folder')
      vi.advanceTimersByTime(TAIL_MS)
      await found
      expect(watchCbs.has(codexDir)).toBe(true)
      expect(walks).toBe(1)
      expect(db.events).toBe(5 + 2)
      // Watched now: the timer walks nothing more.
      clearCounts()
      vi.advanceTimersByTime(TAIL_MS * 3)
      await settle()
      expect(listings).toBe(0)
      expect(warnings).toEqual([])
    })

    it('is walked by the 5 s timer when its watcher fails, as every folder was, until it is watched again', async () => {
      fakeTheTimer()
      await start()
      // The watcher of the projects folder fails and cannot be started again.
      unwatchable.add(claudeDir)
      watchErrs.get(claudeDir)!(new Error('simulated watcher failure'))
      expect(watchCbs.has(claudeDir)).toBe(false)
      // Written with no watcher to report it: the next tick's walk reads it.
      realFs.appendFileSync(transcript('s2'), line('more-2'))
      clearCounts()
      let walked = nextSweep('the walk at the next tick')
      vi.advanceTimersByTime(TAIL_MS)
      await walked
      expect(walks).toBe(1)
      expect(db.events).toBe(6)
      walked = nextSweep('the walk at the tick after')
      vi.advanceTimersByTime(TAIL_MS)
      await walked
      expect(walks).toBe(2)
      // It can be watched again: one walk for what was missed, then none.
      unwatchable.delete(claudeDir)
      walked = nextSweep('the walk as the watcher starts again')
      vi.advanceTimersByTime(TAIL_MS)
      await walked
      expect(watchCbs.has(claudeDir)).toBe(true)
      expect(walks).toBe(3)
      vi.advanceTimersByTime(TAIL_MS * 3)
      await settle()
      expect(walks).toBe(3)
      // Said once in the log, not at every try.
      expect(warnings.filter((w) => w.includes('fs.watch'))).toHaveLength(1)
      // And a transcript reported by the new watcher is read on its own again.
      realFs.appendFileSync(transcript('s3'), line('more-3'))
      clearCounts()
      const read = nextSweep('the changed-files sweep')
      fire(claudeDir, 'change', path.join('F--proj', 's3.jsonl'))
      await read
      expect(listings).toBe(0)
      expect(opened).toEqual([transcript('s3')])
    })
  })

  describe('a reported transcript that is a link', () => {
    // The full walk skips links. The link here is simulated (lstat says link,
    // stat and open follow it), so the rule is checked on every platform and
    // no real link is planted where this file runs.
    it('is not read and starts no walk', async () => {
      await start()
      linkTarget = path.join(tmp, 'elsewhere.jsonl')
      realFs.writeFileSync(linkTarget, line('elsewhere'))
      linkAt = transcript('linked')
      clearCounts()
      fire(claudeDir, 'rename', path.join('F--proj', 'linked.jsonl'))
      await settle()
      expect(opened).toEqual([])
      expect(db.cursors.has(linkAt)).toBe(false)
      expect(db.events).toBe(5)
      expect(listings).toBe(0)
    })
  })
})
