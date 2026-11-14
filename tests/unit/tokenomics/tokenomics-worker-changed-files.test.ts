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
 * A folder reported as changed starts no walk on Windows (which reports it
 * beside every write to a file in it) and makes one due everywhere else. A
 * file that is not a transcript starts none anywhere. The transcripts a sweep
 * found written, the 200 read last, are asked their size by the 5 s timer and
 * read when they grew, for the writes the watcher does not report (on
 * Windows, the ones made through a handle that stays open), however long ago
 * they were read. Rollups a walk left dirty (an attribution between two pages
 * of their rebuild, a rebuild that failed) are rebuilt at the next 5 s tick
 * with no walk.
 *
 * Host-safe: the real worker and real transcript files in a temp folder, a
 * wrapped fs that counts folder listings and file reads and hands the
 * watcher's callback to the test, and an in-memory stand-in for the index
 * database (better-sqlite3 is built for Electron; the totals are covered with
 * the real database in tests/unit/native/tokenomics-dirty-sweep.native.test.ts).
 * No process starts, no real watcher runs and no link is planted. Events are
 * reported as on Windows unless a case says otherwise (process.platform reads
 * as that platform while the worker handles the event), so every case runs
 * the same wherever the suite runs.
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
  /** Rollup rebuilds started, and how many steps each takes (the worker
   *  yields between two steps). */
  rebuilds: 0,
  rebuildSteps: 1,
  /** The rebuild that is running: the steps it has left, and how often a
   *  stored row had been stamped when it began. */
  rebuild: null as { left: number; epoch: number } | null,
  dirtyEpoch: 0,
  /** Session attributions received. */
  attributions: 0,
  /** The next rebuild step throws, once: a rebuild that fails. */
  failNextRebuildStep: false,
  /** The next rollupsDirty throws, once. */
  failNextRollupsDirty: false,
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
    rollupsDirty: () => {
      if (db.failNextRollupsDirty) { db.failNextRollupsDirty = false; throw new Error('simulated read failure') }
      return db.meta.get('rollupsDirty') === '1'
    },
    beginRollupRebuild: () => { db.rebuilds++; db.rebuild = { left: db.rebuildSteps, epoch: db.dirtyEpoch } },
    // As the database: the step that reaches the end swaps the rebuilt
    // rollups in, and they stay dirty when a row was stamped meanwhile.
    stepRollupRebuild: () => {
      if (db.failNextRebuildStep) { db.failNextRebuildStep = false; throw new Error('simulated rebuild failure') }
      const r = db.rebuild
      if (!r) return { done: 0, total: 0, finished: true }
      if (--r.left > 0) return { done: db.rebuildSteps - r.left, total: db.rebuildSteps, finished: false }
      if (db.dirtyEpoch === r.epoch) db.meta.set('rollupsDirty', '0')
      db.rebuild = null
      return { done: db.rebuildSteps, total: db.rebuildSteps, finished: true }
    },
    getMeta: (k: string) => db.meta.get(k),
    setMeta: (k: string, v: string) => {
      if (db.failNextSetMeta) { db.failNextSetMeta = false; throw new Error('simulated write failure') }
      db.meta.set(k, v)
    },
    eventCount: () => db.events,
    upsertConfigs: () => {},
    // As the database: an attribution while the rollups are dirty or being
    // rebuilt stamps the stored rows and leaves the rollups dirty, for
    // another rebuild.
    setSessionAccount: () => {
      db.attributions++
      if (db.rebuild !== null || db.meta.get('rollupsDirty') === '1') { db.dirtyEpoch++; db.meta.set('rollupsDirty', '1') }
      return { recorded: true, stamped: 1 }
    },
    queryAccounts: () => [],
    close: () => {},
  }),
}))

import { createTokenomicsWorker, TK_FULL_SWEEP_MS, TK_ACTIVE_MAX } from '../../../src/main/tokenomics/tokenomics-worker'
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
/** A Claude session id, as a transcript file names it. */
const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
/** The ten minutes after which a transcript was no longer asked about, as
 *  first written. */
const OLD_ACTIVE_MS = 10 * 60_000

describe('tokenomics worker: changed-files sweep (#302)', () => {
  let tmp = ''
  let claudeDir = ''
  let codexDir = ''
  let stopWorker: (() => void) | null = null
  /** The app's side of the worker's channel. */
  let transport: FakeTkWorkerTransport | null = null
  /** Folder listings, and how many were of the transcript root: one per full walk. */
  let listings = 0
  let walks = 0
  /** Files the worker asked the size of, and files it opened to read. */
  let statted: string[] = []
  let opened: string[] = []
  /** Every path the worker asked about without following a link: one per
   *  watcher event that names a path, and one per transcript the 5 s timer
   *  checks. */
  let lstatted: string[] = []
  let completes: Complete[] = []
  /** How many files each finished sweep said it could not read. */
  let failed: number[] = []
  /** How many rollup rebuilds had started as each sweep finished. */
  let rebuildsAt: number[] = []
  /** Told of every message from the worker, as it is posted. */
  let onWorkerMessage: ((m: FromTkWorker) => void) | null = null
  let waiters: Array<(m: FromTkWorker) => boolean> = []
  const bounds = new Set<ReturnType<typeof setTimeout>>()
  /** The live watchers, by folder: what the worker handed each to be told of
   *  a change, and of the watcher's own failure. */
  const watchCbs = new Map<string, WatchCb>()
  const watchErrs = new Map<string, (err: unknown) => void>()
  /** Folders whose watcher cannot be started. */
  const unwatchable = new Set<string>()
  /** What the worker logged as a warning, and as an error. */
  let warnings: string[] = []
  let errors: string[] = []
  /** Paths whose size cannot be asked without following a link: the error
   *  code each fails with. */
  const lstatFails = new Map<string, string>()
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
        case 'lstatSync': return (p: string, o?: unknown) => {
          lstatted.push(String(p))
          const code = lstatFails.get(String(p))
          if (code) throw Object.assign(new Error(`${code}: simulated`), { code })
          return linkAt && String(p) === linkAt ? LINK : (realFs.lstatSync as (p: string, o?: unknown) => unknown)(p, o)
        }
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
  const clearCounts = (): void => { listings = 0; walks = 0; statted = []; opened = []; lstatted = [] }
  const transcript = (name: string): string => path.join(claudeDir, 'F--proj', `${name}.jsonl`)
  /** The five transcripts every test starts with. */
  const five = (): string[] => [0, 1, 2, 3, 4].map((i) => transcript(`s${i}`))
  /** Report an event as the watcher of `dir` would on `platform`:
   *  process.platform reads as it while the worker handles the event, and
   *  no longer. */
  const fire = (dir: string, event: string, filename: string | null, platform: NodeJS.Platform = 'win32'): void => {
    const host = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...host, value: platform })
    try { watchCbs.get(dir)!(event, filename) } finally { Object.defineProperty(process, 'platform', host) }
  }
  /** Only the periodic timer and the clock are faked: sweeps still run on real
   *  timers, so the test decides when 5 s (or 5 min) has passed. */
  const fakeTheTimer = (): void => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }) }

  /** Start the worker on the temp tree; by default wait for its first sweep. */
  async function start(opts: { maxTickBytes?: number; waitFirst?: boolean; watchDebounceMs?: number; realmDirsKnown?: boolean } = {}): Promise<void> {
    const fake = new FakeTkWorkerTransport()
    transport = fake
    fake.onMessage((m) => {
      if (m.type === 'index-complete') { completes.push({ firstIndex: m.firstIndex, drained: m.drained }); failed.push(m.filesFailed); rebuildsAt.push(db.rebuilds) }
      if (m.type === 'log' && m.entry.level === 'warn') warnings.push(m.entry.message)
      if (m.type === 'log' && m.entry.level === 'error') errors.push(m.entry.message)
      onWorkerMessage?.(m)
      waiters = waiters.filter((w) => !w(m))
    })
    const first = opts.waitFirst === false ? null : nextSweep('the first sweep')
    const w = createTokenomicsWorker(fake.asWorkerSide(), { fs: wrapped, watchDebounceMs: opts.watchDebounceMs ?? 5, maxTickBytes: opts.maxTickBytes })
    stopWorker = () => w.stop()
    fake.post({ type: 'open', dbPath: path.join(tmp, 'tk.db'), pricing: PRICING, configs: [], claudeProjectsDir: claudeDir, codexSessionsDir: codexDir, codexRealmDirsKnown: opts.realmDirsKnown })
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
    db.rebuilds = 0; db.rebuildSteps = 1; db.rebuild = null; db.dirtyEpoch = 0; db.attributions = 0
    db.failNextRebuildStep = false; db.failNextRollupsDirty = false
    clearCounts()
    completes = []; failed = []; rebuildsAt = []; waiters = []; warnings = []; errors = []
    onWorkerMessage = null; transport = null
    watchCbs.clear(); watchErrs.clear(); unwatchable.clear(); lstatFails.clear()
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

    // Windows reports the folder as changed beside every write to a file in
    // it (measured: an append to proj\a.jsonl gives 'change proj' and then
    // 'change proj\a.jsonl'; a nested one gives 'change proj\sid\subagents'
    // and then the file). The file reports its own event, so the folder's
    // starts nothing.
    it('a write as Windows reports it, the folder and then the transcript, reads that transcript and lists nothing', async () => {
      await start()
      const reported = transcript('s2')
      realFs.appendFileSync(reported, line('more-2'))
      // Written and not reported: a walk would read it too.
      realFs.appendFileSync(transcript('s3'), line('more-3'))
      clearCounts()
      const read = nextSweep('the changed-files sweep')
      fire(claudeDir, 'change', 'F--proj')
      fire(claudeDir, 'change', path.join('F--proj', 's2.jsonl'))
      await read
      // And no walk follows it.
      await settle()
      expect(listings).toBe(0)
      expect(opened).toEqual([reported])
      expect(new Set(statted)).toEqual(new Set([reported]))
      expect(db.events).toBe(6)
    })

    it('a nested write as Windows reports it reads that transcript and lists nothing', async () => {
      const dir = path.join(claudeDir, 'F--proj', 's9', 'subagents')
      realFs.mkdirSync(dir, { recursive: true })
      const nested = path.join(dir, 'agent-x.jsonl')
      realFs.writeFileSync(nested, line('sub-0'))
      await start()
      realFs.appendFileSync(nested, line('sub-1'))
      clearCounts()
      const read = nextSweep('the changed-files sweep')
      fire(claudeDir, 'change', path.join('F--proj', 's9', 'subagents'))
      fire(claudeDir, 'change', path.join('F--proj', 's9', 'subagents', 'agent-x.jsonl'))
      await read
      await settle()
      expect(listings).toBe(0)
      expect(opened).toEqual([nested])
      expect(db.events).toBe(5 + 2)
    })

    it('a folder reported as changed, with nothing else, starts no sweep', async () => {
      await start()
      // Written and not reported: a walk would read it.
      realFs.writeFileSync(transcript('unseen'), line('unseen'))
      clearCounts()
      fire(claudeDir, 'change', 'F--proj')
      await settle()
      expect({ listings, statted, opened, sweeps: completes.length }).toEqual({ listings: 0, statted: [], opened: [], sweeps: 1 })
      expect(db.events).toBe(5)
    })

    // Only on Windows is a folder's 'change' known to come beside a file's
    // own event. Elsewhere it may be all the watcher says of what happened
    // below the folder (on macOS, events it dropped), so a walk stays due.
    for (const platform of ['darwin', 'linux'] as const) {
      it(`a folder reported as changed makes the next sweep a full one on ${platform}`, async () => {
        await start()
        // Written and not reported: only a walk can find it.
        realFs.writeFileSync(transcript('unseen'), line('unseen'))
        clearCounts()
        const full = nextSweep('the full sweep')
        fire(claudeDir, 'change', 'F--proj', platform)
        // The event itself lists nothing: the walk runs later, off the timer.
        expect(listings).toBe(0)
        await full
        expect(walks).toBe(1)
        expect(opened).toEqual([transcript('unseen')])
        expect(db.events).toBe(6)
      })

      it(`a file that is not a transcript starts no sweep on ${platform} either`, async () => {
        await start()
        realFs.writeFileSync(transcript('unseen'), line('unseen'))
        realFs.writeFileSync(path.join(claudeDir, 'F--proj', 'notes.txt'), 'not a transcript')
        clearCounts()
        fire(claudeDir, 'rename', path.join('F--proj', 'notes.txt'), platform)
        fire(claudeDir, 'change', path.join('F--proj', 'notes.txt'), platform)
        await settle()
        expect({ listings, statted, opened, sweeps: completes.length }).toEqual({ listings: 0, statted: [], opened: [], sweeps: 1 })
        expect(db.events).toBe(5)
      })
    }

    // Claude Code writes more than transcripts under the projects folder
    // (tool results, memory files, a subagent's .meta.json). The walk reads
    // none of them, so a report of one starts none.
    it('a file that is not a transcript, made or written, starts no sweep', async () => {
      await start()
      realFs.writeFileSync(transcript('unseen'), line('unseen'))
      realFs.writeFileSync(path.join(claudeDir, 'F--proj', 'notes.txt'), 'not a transcript')
      clearCounts()
      fire(claudeDir, 'rename', path.join('F--proj', 'notes.txt'))
      fire(claudeDir, 'change', path.join('F--proj', 'notes.txt'))
      await settle()
      expect({ listings, statted, opened, sweeps: completes.length }).toEqual({ listings: 0, statted: [], opened: [], sweeps: 1 })
      expect(db.events).toBe(5)
    })

    it('an event that starts nothing does not put off the sweep a reported transcript is waiting for', async () => {
      await start({ watchDebounceMs: 400 })
      realFs.appendFileSync(transcript('s2'), line('more-2'))
      realFs.writeFileSync(path.join(claudeDir, 'F--proj', 'notes.txt'), 'not a transcript')
      clearCounts()
      // The pause before a sweep is on this test's clock from here.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      fire(claudeDir, 'change', path.join('F--proj', 's2.jsonl'))
      vi.advanceTimersByTime(300)
      expect(db.events).toBe(5)
      // Neither starts the pause again.
      fire(claudeDir, 'change', 'F--proj')
      fire(claudeDir, 'change', path.join('F--proj', 'notes.txt'))
      vi.advanceTimersByTime(100)
      // Read 400 ms after its report, not 400 ms after the last event.
      expect(db.events).toBe(6)
      expect(opened).toEqual([transcript('s2')])
      expect(listings).toBe(0)
    })

    it('a folder that was made is walked, for what was written in it before the watcher reached it', async () => {
      await start()
      const dir = path.join(claudeDir, 'F--other')
      realFs.mkdirSync(dir)
      realFs.writeFileSync(path.join(dir, 'new.jsonl'), line('new'))
      clearCounts()
      const full = nextSweep('the full sweep')
      fire(claudeDir, 'rename', 'F--other')
      // The event itself lists nothing: the walk runs later, off the timer.
      expect(listings).toBe(0)
      await full
      expect(walks).toBe(1)
      expect(opened).toEqual([path.join(dir, 'new.jsonl')])
      expect(db.events).toBe(6)
    })

    const noTranscript: Array<[string, 'claude' | 'codex', string, string | null]> = [
      ['no file name', 'claude', 'rename', null],
      ['no file name, as a change', 'claude', 'change', null],
      // Not the projects folder itself, reported as changed (which starts
      // nothing on Windows, as these events are reported here).
      ['an empty file name', 'claude', 'change', ''],
      ['a folder that was made or moved', 'claude', 'rename', 'F--proj'],
      ['a deleted transcript', 'claude', 'rename', path.join('F--proj', 'gone.jsonl')],
      ['a deleted file that is not a transcript', 'claude', 'rename', path.join('F--proj', 'gone.txt')],
      ['a name that is gone, as a change', 'claude', 'change', path.join('F--proj', 'gone.tmp')],
      // Not narrowed yet: any event in a Codex sessions folder walks everything.
      ['a rollout in the Codex sessions folder', 'codex', 'rename', 'rollout-2026-08-01T00-00-00-x.jsonl'],
      ['a folder changed in the Codex sessions folder', 'codex', 'change', '2026'],
    ]
    for (const [what, where, event, filename] of noTranscript) {
      it(`an event that names ${what} makes the next sweep a full one`, async () => {
        realFs.mkdirSync(path.join(codexDir, '2026'))
        await start()
        // Written but never reported: only a full walk can find it.
        realFs.writeFileSync(transcript('unseen'), line('unseen'))
        clearCounts()
        const full = nextSweep('the full sweep')
        fire(where === 'claude' ? claudeDir : codexDir, event, filename)
        // The event itself lists nothing: the walk runs later, off the timer.
        expect(listings).toBe(0)
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
      const ticks = TK_FULL_SWEEP_MS / TAIL_MS - 1
      vi.advanceTimersByTime(TK_FULL_SWEEP_MS - TAIL_MS)
      await settle()
      expect({ listings, statted, opened }).toEqual({ listings: 0, statted: [], opened: [] })
      // All it asks is the size of the five transcripts read at start, once
      // each per tick.
      expect(lstatted).toHaveLength(ticks * 5)
      expect(new Set(lstatted)).toEqual(new Set(five()))
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

  describe('a transcript written with no report from the watcher', () => {
    // On Windows a write through a handle that stays open raises no watcher
    // event for the file until the handle closes (measured: five writes
    // 500 ms apart reported nothing, then one 'change' at the close). The 5 s
    // walk used to find those; now the 5 s timer asks the size of the
    // transcripts a sweep found written, and reads the ones that moved.
    it('is read at the next 5 s tick, and no folder is listed', async () => {
      fakeTheTimer()
      await start()
      realFs.appendFileSync(transcript('s2'), line('more-2'))
      clearCounts()
      const read = nextSweep('the sweep at the next tick')
      vi.advanceTimersByTime(TAIL_MS)
      await read
      expect(listings).toBe(0)
      expect(opened).toEqual([transcript('s2')])
      expect(db.events).toBe(6)
      // One size check for each transcript read lately, and no other.
      expect([...lstatted].sort()).toEqual(five().sort())
    })

    it('a transcript reported as made while it is still empty is read at the next tick once it is written', async () => {
      fakeTheTimer()
      await start()
      // A session makes its transcript, the watcher reports that, and the
      // session then writes through the handle it kept.
      const made = transcript('s8')
      realFs.writeFileSync(made, '')
      const seen = nextSweep('the sweep that sees the empty transcript')
      fire(claudeDir, 'rename', path.join('F--proj', 's8.jsonl'))
      await seen
      expect(db.events).toBe(5)
      realFs.appendFileSync(made, line('first'))
      clearCounts()
      const read = nextSweep('the sweep at the next tick')
      vi.advanceTimersByTime(TAIL_MS)
      await read
      expect(listings).toBe(0)
      expect(opened).toEqual([made])
      expect(db.events).toBe(6)
    })

    // A session that pauses and then writes again through the handle it kept
    // has no other report: Windows reports its folder as changed at most,
    // which names no file and starts nothing. As first written a transcript
    // was no longer asked about ten minutes after it was read, and such a
    // write then waited for the next timed walk.
    it('one read longer ago than ten minutes, then written with only its folder reported as changed, is read at the next tick', async () => {
      fakeTheTimer()
      await start()
      // Eleven minutes with nothing written: the timed walks at 5 and 10 min
      // read nothing.
      vi.advanceTimersByTime(TK_FULL_SWEEP_MS)
      await settle()
      vi.advanceTimersByTime(OLD_ACTIVE_MS - TK_FULL_SWEEP_MS)
      await settle()
      vi.advanceTimersByTime(60_000)
      await settle()
      expect(walks).toBe(3)
      expect(db.events).toBe(5)
      realFs.appendFileSync(transcript('s2'), line('more-2'))
      clearCounts()
      fire(claudeDir, 'change', 'F--proj')
      const read = nextSweep('the sweep at the next tick')
      vi.advanceTimersByTime(TAIL_MS)
      await read
      expect(listings).toBe(0)
      expect(opened).toEqual([transcript('s2')])
      expect(db.events).toBe(6)
      // The folder's event asked about the folder; the tick asked about each
      // transcript read at start, eleven minutes ago.
      expect([...lstatted].sort()).toEqual([path.join(claudeDir, 'F--proj'), ...five()].sort())
    })

    it('at most TK_ACTIVE_MAX are asked about, the ones read longest ago dropped', async () => {
      fakeTheTimer()
      await start()
      // The transcript read first at start is read again, so of the five it
      // is now the one read last.
      const first = opened[0]
      realFs.appendFileSync(first, line('again'))
      let read = nextSweep('the changed-files sweep')
      fire(claudeDir, 'change', path.relative(claudeDir, first))
      await read
      // One fewer new transcripts than the bound, each reported as it is made.
      const made = Array.from({ length: TK_ACTIVE_MAX - 1 }, (_, i) => transcript(`n${i}`))
      for (const f of made) realFs.writeFileSync(f, line(path.basename(f)))
      read = nextSweep('the changed-files sweep')
      for (const f of made) fire(claudeDir, 'rename', path.relative(claudeDir, f))
      await read
      expect(db.events).toBe(5 + 1 + made.length)
      clearCounts()
      vi.advanceTimersByTime(TAIL_MS)
      await settle()
      // The other four read at start are no longer asked about.
      expect(lstatted).toHaveLength(TK_ACTIVE_MAX)
      expect(new Set(lstatted)).toEqual(new Set([first, ...made]))
      expect(listings).toBe(0)
    })

    it('one that was deleted is asked about once more and then forgotten, with no walk', async () => {
      fakeTheTimer()
      await start()
      realFs.rmSync(transcript('s4'))
      clearCounts()
      vi.advanceTimersByTime(TAIL_MS)
      await settle()
      expect(lstatted).toContain(transcript('s4'))
      clearCounts()
      vi.advanceTimersByTime(TAIL_MS)
      await settle()
      expect(lstatted).toHaveLength(4)
      expect(lstatted).not.toContain(transcript('s4'))
      expect(listings).toBe(0)
    })

    // A size check can fail for a file that is still there (in use, a drive
    // that does not answer). As first written any failure forgot the
    // transcript, and its later writes waited for the next timed walk.
    it('one whose size cannot be asked for a tick is kept: written since with no report, it is read at a later tick', async () => {
      fakeTheTimer()
      await start()
      lstatFails.set(transcript('s2'), 'EBUSY')
      clearCounts()
      vi.advanceTimersByTime(TAIL_MS)
      await settle()
      expect(lstatted).toContain(transcript('s2'))
      expect(completes).toHaveLength(1)
      lstatFails.clear()
      realFs.appendFileSync(transcript('s2'), line('more-2'))
      clearCounts()
      const read = nextSweep('the sweep at a later tick')
      vi.advanceTimersByTime(TAIL_MS)
      await read
      expect(listings).toBe(0)
      expect(opened).toEqual([transcript('s2')])
      expect(db.events).toBe(6)
    })

    it('one whose path no longer leads to a file (ENOTDIR) is asked about once more and then forgotten, as a deleted one', async () => {
      fakeTheTimer()
      await start()
      lstatFails.set(transcript('s4'), 'ENOTDIR')
      clearCounts()
      vi.advanceTimersByTime(TAIL_MS)
      await settle()
      expect(lstatted).toContain(transcript('s4'))
      clearCounts()
      vi.advanceTimersByTime(TAIL_MS)
      await settle()
      expect(lstatted).toHaveLength(4)
      expect(lstatted).not.toContain(transcript('s4'))
      expect(listings).toBe(0)
    })

    it('one that cannot be read is tried once, then left to its next report or the next walk', async () => {
      fakeTheTimer()
      await start()
      denied = transcript('s1')
      realFs.appendFileSync(denied, line('more-1'))
      const tried = nextSweep('the sweep at the next tick')
      vi.advanceTimersByTime(TAIL_MS)
      await tried
      expect(failed.at(-1)).toBe(1)
      expect(warnings.filter((w) => w.includes('open failed'))).toHaveLength(1)
      // Not tried again at every tick: no sweep, and nothing more in the log.
      const sweeps = completes.length
      vi.advanceTimersByTime(TAIL_MS * 3)
      await settle()
      expect(completes).toHaveLength(sweeps)
      expect(warnings.filter((w) => w.includes('open failed'))).toHaveLength(1)
      // Its next report tries it again, and it is read once it can be.
      denied = ''
      const read = nextSweep('the changed-files sweep')
      fire(claudeDir, 'change', path.join('F--proj', 's1.jsonl'))
      await read
      expect(failed.at(-1)).toBe(0)
      expect(db.events).toBe(6)
    })

    it('a size check that fails does not stop the timer: the transcript is handed to the sweep', async () => {
      fakeTheTimer()
      await start()
      realFs.appendFileSync(transcript('s2'), line('more-2'))
      clearCounts()
      // The index cannot be asked how far the first transcript checked was read.
      db.failNextGetCursor = true
      const read = nextSweep('the sweep at the next tick')
      expect(() => vi.advanceTimersByTime(TAIL_MS)).not.toThrow()
      await read
      expect(opened).toEqual([transcript('s2')])
      expect(db.events).toBe(6)
      expect(listings).toBe(0)
    })
  })

  describe('rollups a walk left dirty', () => {
    // A drained walk rebuilds the rollups when they are dirty. They can be
    // dirty with no walk due: a session attribution that arrives between two
    // pages of the rebuild leaves them dirty for another one, a rebuild can
    // fail, and an attribution the rollups cannot follow leaves them dirty
    // at any time. The 5 s walk used to rebuild them; as first written the
    // changed-files sweep never did, so the totals by account waited for the
    // next timed walk.
    it('an attribution that arrives between two pages of the rebuild is settled at the next 5 s tick, with no walk', async () => {
      fakeTheTimer()
      db.meta.set('rollupsDirty', '1')
      db.rebuildSteps = 3
      let sent = false
      onWorkerMessage = (m) => {
        if (sent || m.type !== 'index-progress' || m.accountReread?.stage !== 'rebuild') return
        sent = true
        transport!.post({ type: 'set-session-account', sessionId: SESSION, accountKey: 'claude:acct-a' })
      }
      await start()
      expect({ sent, attributions: db.attributions, rebuilds: db.rebuilds }).toEqual({ sent: true, attributions: 1, rebuilds: 1 })
      // The rebuild ran to its end and the rollups are still dirty.
      expect(db.rebuild).toBeNull()
      expect(db.meta.get('rollupsDirty')).toBe('1')
      clearCounts()
      const settled = nextSweep('the sweep that settles the accounts')
      vi.advanceTimersByTime(TAIL_MS)
      await settled
      expect(db.rebuilds).toBe(2)
      expect(db.meta.get('rollupsDirty')).toBe('0')
      expect({ listings, statted, opened }).toEqual({ listings: 0, statted: [], opened: [] })
      // Settled: the ticks that follow start nothing.
      const sweeps = completes.length
      vi.advanceTimersByTime(TAIL_MS * 3)
      await settle()
      expect(completes).toHaveLength(sweeps)
      expect(db.rebuilds).toBe(2)
    })

    it('a rebuild that fails is tried again at the next 5 s tick, with no walk', async () => {
      fakeTheTimer()
      db.meta.set('rollupsDirty', '1')
      db.failNextRebuildStep = true
      await start()
      expect(errors.filter((e) => e.includes('account attribution failed'))).toHaveLength(1)
      expect(db.rebuilds).toBe(1)
      expect(db.meta.get('rollupsDirty')).toBe('1')
      clearCounts()
      const settled = nextSweep('the sweep that settles the accounts')
      vi.advanceTimersByTime(TAIL_MS)
      await settled
      expect(db.rebuilds).toBe(2)
      expect(db.meta.get('rollupsDirty')).toBe('0')
      expect({ listings, statted, opened }).toEqual({ listings: 0, statted: [], opened: [] })
      expect(errors).toHaveLength(1)
    })

    it('a changed-files sweep rebuilds them once it has read what was reported', async () => {
      await start()
      // Left dirty with no sweep running, as by an attribution the rollups
      // could not follow.
      db.meta.set('rollupsDirty', '1')
      realFs.appendFileSync(transcript('s2'), line('more-2'))
      clearCounts()
      const read = nextSweep('the changed-files sweep')
      fire(claudeDir, 'change', path.join('F--proj', 's2.jsonl'))
      await read
      expect(opened).toEqual([transcript('s2')])
      expect(db.events).toBe(6)
      expect(db.rebuilds).toBe(1)
      expect(db.meta.get('rollupsDirty')).toBe('0')
      expect(listings).toBe(0)
      expect(completes.at(-1)).toEqual({ firstIndex: false, drained: true })
    })

    // As a walk: nothing is settled before the account folders are named
    // (the Codex history is re-read once they are, and the rollups would be
    // rebuilt twice).
    it('nothing is rebuilt until the account folders are named; the walk that follows the naming rebuilds', async () => {
      fakeTheTimer()
      db.meta.set('rollupsDirty', '1')
      await start({ realmDirsKnown: false })
      expect(db.rebuilds).toBe(0)
      clearCounts()
      vi.advanceTimersByTime(TAIL_MS * 3)
      await settle()
      expect({ rebuilds: db.rebuilds, listings, sweeps: completes.length }).toEqual({ rebuilds: 0, listings: 0, sweeps: 1 })
      // Not by a changed-files sweep either.
      realFs.appendFileSync(transcript('s2'), line('more-2'))
      const read = nextSweep('the changed-files sweep')
      fire(claudeDir, 'change', path.join('F--proj', 's2.jsonl'))
      await read
      expect({ rebuilds: db.rebuilds, listings, events: db.events }).toEqual({ rebuilds: 0, listings: 0, events: 6 })
      const walked = nextSweep('the walk after the naming')
      transport!.post({ type: 'set-codex-realm-dirs', dirs: [] })
      await walked
      expect(walks).toBe(1)
      expect(db.rebuilds).toBe(1)
      expect(db.meta.get('rollupsDirty')).toBe('0')
    })

    // As a walk: only once every byte is read.
    it('a changed-files sweep that leaves bytes to read rebuilds nothing; the walk that reads them to the end does', async () => {
      fakeTheTimer()
      // Each pass reads at most 512 bytes of a file: two of its lines.
      await start({ maxTickBytes: 512 })
      db.meta.set('rollupsDirty', '1')
      realFs.appendFileSync(transcript('s2'), Array.from({ length: 12 }, (_, i) => line(`more-${i}`)).join(''))
      const sweeps = completes.length
      const read = nextSweep('the changed-files sweep')
      fire(claudeDir, 'change', path.join('F--proj', 's2.jsonl'))
      await read
      expect(completes.at(-1)).toEqual({ firstIndex: false, drained: false })
      expect(db.rebuilds).toBe(0)
      // The walk the 5 s timer runs, and the ones that follow it at once.
      const drained = drainedSweep('the walk that reads it to its end')
      vi.advanceTimersByTime(TAIL_MS)
      await drained
      expect(db.events).toBe(5 + 12)
      const since = rebuildsAt.slice(sweeps)
      expect(since.length).toBeGreaterThan(2)
      expect(since.slice(0, -1).every((r) => r === 0)).toBe(true)
      expect(since.at(-1)).toBe(1)
      expect(db.meta.get('rollupsDirty')).toBe('0')
    })

    it('a check of the rollups that fails does not stop the timer: the sweep is asked to settle them', async () => {
      fakeTheTimer()
      await start()
      db.meta.set('rollupsDirty', '1')
      db.failNextRollupsDirty = true
      clearCounts()
      const settled = nextSweep('the sweep that settles the accounts')
      expect(() => vi.advanceTimersByTime(TAIL_MS)).not.toThrow()
      await settled
      expect(db.rebuilds).toBe(1)
      expect(db.meta.get('rollupsDirty')).toBe('0')
      expect(listings).toBe(0)
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
