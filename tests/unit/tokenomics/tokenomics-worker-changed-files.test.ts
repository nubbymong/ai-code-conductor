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
 * they were read. Of more than 200 the ones modified last are kept, and a
 * transcript the walk at start finds as the index has it is asked about too
 * (review round 3). Rollups a walk left dirty (an attribution between two pages
 * of their rebuild, a rebuild that failed) are rebuilt at the next 5 s tick
 * with no walk.
 *
 * A file deleted and made again at the path of one already read is read from
 * its first byte, whatever its size: the index keeps a mark of its first
 * bytes and of the bytes just before where it stopped reading (review round
 * 3).
 *
 * 2.1.3-beta.4 (Tokenomics as an optional service): a full pass counts what
 * its two walks touched, and a guard fails when a walk lists a folder outside
 * the transcript roots, touches more than the fixture holds, goes deeper
 * than twelve folders below a root or follows a link; a worker started again
 * reads on from each file's stored progress; the page's Rescan reads every
 * file again from its first byte, and no pass says it is done while a
 * Rescan still waits for its own.
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

type Cursor = { path: string; size: number; mtime: number; lastOffset: number; scannedTo?: number; readMark?: string; codexSessionId?: string; codexTurns?: number }
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
  /** How often every file's progress was put back to its start (Rescan). */
  resets: 0,
  /** Queries answered: the kind, then what the database was handed. */
  queries: [] as unknown[][],
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
    // As the database: every file's progress back to its start; its size,
    // its time and whose file it is are kept.
    resetFileProgress: () => {
      db.resets++
      for (const [p, c] of db.cursors) db.cursors.set(p, { ...c, lastOffset: 0, scannedTo: 0, readMark: '', codexSessionId: '', codexTurns: 0 })
      return db.cursors.size
    },
    querySummary: (_pricing: unknown, filter: unknown) => { db.queries.push(['summary', filter]); return {} },
    querySessions: (_pricing: unknown, query: unknown) => { db.queries.push(['sessions', query]); return { rows: [], nextCursor: null } },
    querySessionDetail: (_pricing: unknown, sessionId: string, leftOut: unknown) => { db.queries.push(['session-detail', sessionId, leftOut]); return null },
    queryAccounts: (leftOut: unknown) => { db.queries.push(['accounts', leftOut]); return [] },
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
  /** Every folder listed, and how many names those listings returned. */
  let listed: string[] = []
  let entriesListed = 0
  /** Files the worker asked the size of, and files it opened to read. */
  let statted: string[] = []
  let opened: string[] = []
  /** Bytes the worker read from files. */
  let bytesRead = 0
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
  /** Folders the wrapped fs shows a link in: the link's name and the folder
   *  it leads to. Listing the folder returns the link among its names (a
   *  link, neither a file nor a folder, as a real one is listed); stat,
   *  list and open through the link follow it. Nothing is on disk at the
   *  link itself. */
  const dirLinks = new Map<string, { name: string; target: string }>()
  /** A file whose reads come back empty although it has bytes. */
  let stuck = ''
  /** A file that cannot be opened. */
  let denied = ''
  const stuckFds = new Set<number>()
  /** Files some of whose reads fail (EIO): which ones, counted from 0 on
   *  each open. */
  const readFails = new Map<string, (nth: number) => boolean>()
  const readsOf = new Map<number, { fails: (nth: number) => boolean; done: number }>()

  const follow = (p: unknown): string => {
    const s = String(p)
    if (linkAt && s === linkAt) return linkTarget
    for (const [parent, link] of dirLinks) {
      const at = path.join(parent, link.name)
      if (s === at) return link.target
      if (s.startsWith(at + path.sep)) return path.join(link.target, s.slice(at.length + 1))
    }
    return s
  }
  const LINK = { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false }
  const wrapped = new Proxy(realFs, {
    get(target, prop) {
      switch (prop) {
        case 'readdirSync': return (dir: string, o: unknown) => {
          listings++
          listed.push(String(dir))
          if (path.resolve(String(dir)) === path.resolve(claudeDir)) walks++
          const names = (realFs.readdirSync as (d: string, o: unknown) => unknown)(follow(dir), o)
          const link = dirLinks.get(String(dir))
          if (Array.isArray(names) && link) names.push({ name: link.name, ...LINK })
          if (Array.isArray(names)) entriesListed += names.length
          return names
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
          if (linkAt && String(p) === linkAt) return LINK
          for (const [parent, link] of dirLinks) if (String(p) === path.join(parent, link.name)) return LINK
          return (realFs.lstatSync as (p: string, o?: unknown) => unknown)(p, o)
        }
        case 'openSync': return (p: string, flags: string) => {
          if (denied && String(p) === denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
          opened.push(String(p))
          const fd = realFs.openSync(follow(p), flags)
          if (stuck && String(p) === stuck) stuckFds.add(fd)
          const fails = readFails.get(String(p))
          if (fails) readsOf.set(fd, { fails, done: 0 })
          return fd
        }
        case 'readSync': return (fd: number, ...rest: unknown[]) => {
          const reads = readsOf.get(fd)
          if (reads && reads.fails(reads.done++)) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })
          const n = stuckFds.has(fd) ? 0 : (realFs.readSync as (fd: number, ...r: unknown[]) => number)(fd, ...rest)
          bytesRead += n
          return n
        }
        case 'closeSync': return (fd: number) => { stuckFds.delete(fd); readsOf.delete(fd); realFs.closeSync(fd) }
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
  const clearCounts = (): void => { listings = 0; walks = 0; listed = []; entriesListed = 0; statted = []; opened = []; lstatted = []; bytesRead = 0 }
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

  /** Stop the worker and start another on the same index: the app started
   *  again, or the supervisor started the worker again. The counts start
   *  again with it. */
  async function restart(): Promise<void> {
    stopWorker?.()
    stopWorker = null
    clearCounts()
    await start()
  }
  /** More transcripts than the 5 s timer asks about, each with its own time
   *  of last writing: the first of them is the one written last, and the five
   *  every test starts with are the oldest of all. A listing by name finds
   *  the ones written last first. */
  function manyByAge(): string[] {
    const ago = (minutes: number): Date => new Date(Date.now() - minutes * 60_000)
    const made = Array.from({ length: TK_ACTIVE_MAX + 15 }, (_, i) => transcript(`m${String(i).padStart(3, '0')}`))
    made.forEach((f, i) => { realFs.writeFileSync(f, line(path.basename(f))); realFs.utimesSync(f, ago(i + 1), ago(i + 1)) })
    for (const f of five()) realFs.utimesSync(f, ago(10_000), ago(10_000))
    return made
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
    db.resets = 0; db.queries = []
    clearCounts()
    completes = []; failed = []; rebuildsAt = []; waiters = []; warnings = []; errors = []
    onWorkerMessage = null; transport = null
    watchCbs.clear(); watchErrs.clear(); unwatchable.clear(); lstatFails.clear()
    linkAt = ''; linkTarget = ''; stuck = ''; stuckFds.clear(); denied = ''
    dirLinks.clear()
    readFails.clear(); readsOf.clear()
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

    it('at most TK_ACTIVE_MAX are asked about, the ones modified longest ago dropped', async () => {
      fakeTheTimer()
      await start()
      // The transcript read first at start is written again, so of the five
      // it is now the one modified last.
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

    // A walk finds transcripts in the order the folders list them, which says
    // nothing of which are being written. As first written the 200 the walk
    // read last were kept, so a first index dropped a transcript being
    // written for an old one listed after it.
    it('a first index of more transcripts than TK_ACTIVE_MAX leaves the ones modified last asked about, wherever the walk found them', async () => {
      fakeTheTimer()
      const made = manyByAge()
      await start()
      expect(db.events).toBe(5 + made.length)
      clearCounts()
      vi.advanceTimersByTime(TAIL_MS)
      await settle()
      expect(lstatted).toHaveLength(TK_ACTIVE_MAX)
      expect(new Set(lstatted)).toEqual(new Set(made.slice(0, TK_ACTIVE_MAX)))
      expect(listings).toBe(0)
    })

    // A file system may keep times no finer than a second or two, so many
    // transcripts can share one.
    it('of transcripts modified at the same instant, the ones noted last are kept', async () => {
      fakeTheTimer()
      const made = Array.from({ length: TK_ACTIVE_MAX - 1 }, (_, i) => transcript(`e${i}`))
      for (const f of made) realFs.writeFileSync(f, line(path.basename(f)))
      const same = new Date(Date.now() - 60_000)
      for (const f of [...five(), ...made]) realFs.utimesSync(f, same, same)
      await start()
      // The walk notes them in the order it reads them: four more than are kept.
      expect(opened).toHaveLength(TK_ACTIVE_MAX + 4)
      const kept = opened.slice(-TK_ACTIVE_MAX)
      clearCounts()
      vi.advanceTimersByTime(TAIL_MS)
      await settle()
      expect(lstatted).toHaveLength(TK_ACTIVE_MAX)
      expect(new Set(lstatted)).toEqual(new Set(kept))
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

  describe('a transcript the index already holds in full when the worker starts', () => {
    // An app that starts again, or a worker the supervisor starts again,
    // finds most transcripts as the index has them and reads none of them.
    // As first written only a transcript that was read counted as found
    // written, so one written afterwards through a handle that stays open
    // waited for the next timed walk.
    it('written afterwards with no report, is read at the next 5 s tick, and no folder is listed', async () => {
      fakeTheTimer()
      await start()
      await restart()
      // Nothing to read: every transcript is as the index has it.
      expect(opened).toEqual([])
      expect(db.events).toBe(5)
      realFs.appendFileSync(transcript('s2'), line('more-2'))
      clearCounts()
      const read = nextSweep('the sweep at the next tick')
      vi.advanceTimersByTime(TAIL_MS)
      await read
      expect(listings).toBe(0)
      expect(opened).toEqual([transcript('s2')])
      expect(db.events).toBe(6)
      // One size check for each transcript the walk at start found, and no other.
      expect([...lstatted].sort()).toEqual(five().sort())
    })

    it('of more than TK_ACTIVE_MAX of them, the ones modified last are asked about, wherever the walk finds them', async () => {
      fakeTheTimer()
      const made = manyByAge()
      await start()
      await restart()
      expect(opened).toEqual([])
      clearCounts()
      vi.advanceTimersByTime(TAIL_MS)
      await settle()
      expect(lstatted).toHaveLength(TK_ACTIVE_MAX)
      expect(new Set(lstatted)).toEqual(new Set(made.slice(0, TK_ACTIVE_MAX)))
      expect(listings).toBe(0)
      // The one modified last of those left out, written with no report, waits
      // for the timed walk; one of those kept is read at the next tick.
      realFs.appendFileSync(made[TK_ACTIVE_MAX], line('left-out'))
      realFs.appendFileSync(made[TK_ACTIVE_MAX - 1], line('kept'))
      clearCounts()
      const read = nextSweep('the sweep at the next tick')
      vi.advanceTimersByTime(TAIL_MS)
      await read
      expect(opened).toEqual([made[TK_ACTIVE_MAX - 1]])
      expect(listings).toBe(0)
    })
  })

  describe('a file that is no longer the one the index read', () => {
    // The index keeps how far each file was read, and reads on from there. A
    // file deleted and made again at the same path was told from the one
    // read only by being shorter than that. Made again longer, its first
    // lines were skipped, or the first of them read from its middle, and
    // their usage was never counted. The index now keeps a mark of the
    // file's first bytes and of the bytes just before where it stopped, and
    // reads the file from its first byte when they are no longer there.
    // Nothing is deduplicated in this stand-in, so a line read twice shows
    // as well as one never read.
    const report = async (file: string, event = 'rename'): Promise<void> => {
      const read = nextSweep('the changed-files sweep')
      fire(claudeDir, event, path.relative(claudeDir, file))
      await read
    }
    /** Delete a file and make it again at once, at the same path. */
    const makeAgain = (file: string, content: string): void => { realFs.rmSync(file); realFs.writeFileSync(file, content) }

    // 'anew-0' is as long as 'init-2', so the old offset is the end of the
    // new file's first line; 'another-0' is longer, so it is inside it.
    for (const [what, id] of [['its lines as long as the old one', 'anew'], ['its lines longer than the old one', 'another']] as const) {
      it(`a transcript deleted and made again larger, ${what}, is read from its first byte: every line once`, async () => {
        await start()
        const f = transcript('s2')
        makeAgain(f, [0, 1, 2].map((i) => line(`${id}-${i}`)).join(''))
        clearCounts()
        await report(f)
        expect(db.events).toBe(5 + 3)
        expect(db.cursors.get(f)!.lastOffset).toBe(realFs.statSync(f).size)
        expect(opened).toEqual([f])
        expect(listings).toBe(0)
      })
    }

    it('one made again with exactly as many bytes as were read of the old one is read too', async () => {
      await start()
      const f = transcript('s2')
      makeAgain(f, line('anew-2'))
      expect(realFs.statSync(f).size).toBe(db.cursors.get(f)!.lastOffset)
      // Its time differs from the old file's, however fast it was made again.
      const later = new Date(Date.now() + 5000)
      realFs.utimesSync(f, later, later)
      await report(f)
      expect(db.events).toBe(5 + 1)
    })

    // The first bytes alone do not tell it: a file can start as the old one
    // did and go on otherwise. The bytes just before the old offset do.
    it('one made again with the first line the old one had and other lines after it is read from its first byte', async () => {
      const f = transcript('s2')
      realFs.writeFileSync(f, line('init-2') + line('next-2'))
      await start()
      expect(db.events).toBe(4 + 2)
      makeAgain(f, line('init-2') + [0, 1, 2].map((i) => line(`other-${i}`)).join(''))
      await report(f)
      expect(db.events).toBe(4 + 2 + 4)
      expect(db.cursors.get(f)!.lastOffset).toBe(realFs.statSync(f).size)
    })

    it('one found by the walk at start, made again larger while the worker was not running, is read from its first byte', async () => {
      await start()
      stopWorker!()
      stopWorker = null
      const f = transcript('s2')
      makeAgain(f, [0, 1, 2].map((i) => line(`anew-${i}`)).join(''))
      clearCounts()
      await start()
      expect(opened).toEqual([f])
      expect(db.events).toBe(5 + 3)
    })

    it('a transcript that only grew is read on from where it stopped: the new bytes and the few of the mark, never the file again', async () => {
      const big = transcript('big')
      realFs.writeFileSync(big, Array.from({ length: 200 }, (_, i) => line(`big-${i}`)).join(''))
      await start()
      expect(db.events).toBe(5 + 200)
      expect(realFs.statSync(big).size).toBeGreaterThan(30_000)
      for (const n of [1, 2]) {
        realFs.appendFileSync(big, line(`more-${n}`))
        clearCounts()
        await report(big, 'change')
        expect(db.events).toBe(5 + 200 + n)
        expect(opened).toEqual([big])
        // The new line, the bytes checked before the old offset and the ones
        // marked before the new one.
        expect(bytesRead).toBeLessThan(2048)
        const c = db.cursors.get(big)!
        expect(c.lastOffset).toBe(realFs.statSync(big).size)
        // The mark is of the bytes that end where reading stopped.
        expect(c.readMark).toMatch(new RegExp(`^${c.lastOffset}:\\d+:\\d+:[0-9a-f]+$`))
      }
    })

    it('a transcript whose time changed and nothing else is not read again, and keeps its mark', async () => {
      await start()
      const f = transcript('s2')
      const mark = db.cursors.get(f)!.readMark
      expect(mark).toBeTruthy()
      const later = new Date(Date.now() + 5000)
      realFs.utimesSync(f, later, later)
      clearCounts()
      await report(f, 'change')
      expect(db.events).toBe(5)
      expect(db.cursors.get(f)).toMatchObject({ mtime: realFs.statSync(f).mtimeMs, readMark: mark })
      // Looked at, to see that it is the file that was read: a few bytes.
      expect(bytesRead).toBeLessThan(512)
    })

    it('one whose bytes cannot be read to check them is counted as not read, its cursor left as it was, and read once they can be', async () => {
      await start()
      const f = transcript('s2')
      const before = { ...db.cursors.get(f)! }
      realFs.appendFileSync(f, line('more-2'))
      // The first read of the open is the check's; the ones after it would
      // succeed, so nothing is read on a guess of which file this is.
      readFails.set(f, (nth) => nth === 0)
      await report(f, 'change')
      expect(failed.at(-1)).toBe(1)
      expect(db.events).toBe(5)
      expect(db.cursors.get(f)).toEqual(before)
      expect(warnings.filter((w) => w.includes('read failed'))).toHaveLength(1)
      expect(errors).toEqual([])
      readFails.clear()
      await report(f, 'change')
      expect(failed.at(-1)).toBe(0)
      expect(db.events).toBe(6)
    })

    it('a mark that cannot be read once the lines are leaves the cursor with none: the lines stay counted, and the file is read on', async () => {
      await start()
      const f = transcript('fresh')
      realFs.writeFileSync(f, line('fresh-0'))
      // The read of its lines succeeds; the reads for the mark fail.
      readFails.set(f, (nth) => nth >= 1)
      await report(f)
      expect(db.events).toBe(6)
      expect(failed.at(-1)).toBe(0)
      expect(errors).toEqual([])
      expect(db.cursors.get(f)).toMatchObject({ lastOffset: realFs.statSync(f).size, readMark: '' })
      readFails.clear()
      realFs.appendFileSync(f, line('fresh-1'))
      await report(f, 'change')
      expect(db.events).toBe(7)
      expect(db.cursors.get(f)!.readMark).toBeTruthy()
    })

    // A database from before the mark was kept has none on any cursor, and
    // one that cannot be read is as none.
    const legacy: Array<[string, (c: Cursor) => void]> = [
      ['no mark', (c) => { delete c.readMark }],
      ['an empty mark', (c) => { c.readMark = '' }],
      ['a mark that cannot be read', (c) => { c.readMark = 'not-a-mark' }],
      ['a mark of more bytes than any mark has', (c) => { c.readMark = `${c.lastOffset}:9999:9999:${'0'.repeat(32)}` }],
    ]
    for (const [what, strip] of legacy) {
      it(`a cursor with ${what} reads on from where it was, and is marked as it is read`, async () => {
        await start()
        stopWorker!()
        stopWorker = null
        for (const c of db.cursors.values()) strip(c)
        const f = transcript('s2')
        realFs.appendFileSync(f, line('more-2'))
        clearCounts()
        await start()
        // Only the new line: the file is not read again from its first byte.
        expect(opened).toEqual([f])
        expect(db.events).toBe(6)
        const c = db.cursors.get(f)!
        expect(c.readMark).toMatch(new RegExp(`^${c.lastOffset}:\\d+:\\d+:[0-9a-f]+$`))
        // Marked now: made again larger, it is read from its first byte.
        makeAgain(f, [0, 1, 2].map((i) => line(`anew-${i}`)).join(''))
        await report(f)
        expect(db.events).toBe(6 + 3)
      })
    }

    // After a downgrade an older build reads on and moves the offset, and
    // leaves the mark as it was: of an earlier offset in the same file.
    it('a cursor an older build moved on, its mark still of the earlier offset, reads on from where it is', async () => {
      await start()
      const f = transcript('s2')
      const before = { ...db.cursors.get(f)! }
      realFs.appendFileSync(f, line('older-build'))
      const st = realFs.statSync(f)
      db.cursors.set(f, { ...before, size: st.size, mtime: st.mtimeMs, lastOffset: st.size, scannedTo: st.size })
      db.events++
      realFs.appendFileSync(f, line('more-2'))
      clearCounts()
      await report(f, 'change')
      expect(db.events).toBe(5 + 1 + 1)
      const c = db.cursors.get(f)!
      expect(c.readMark).toMatch(new RegExp(`^${c.lastOffset}:`))
      expect(c.readMark).not.toBe(before.readMark)
    })

    // The older build read a file made again shorter from its first byte, so
    // the mark is of an offset past the end of what is there now. What it
    // read cannot be checked, so the file is read from its first byte.
    it('a mark of an offset the file no longer reaches means another file: read from its first byte', async () => {
      const f = transcript('s2')
      realFs.writeFileSync(f, [0, 1, 2, 3].map((i) => line(`init-${i}`)).join(''))
      await start()
      expect(db.events).toBe(4 + 4)
      const before = { ...db.cursors.get(f)! }
      makeAgain(f, [0, 1].map((i) => line(`anew-${i}`)).join(''))
      const one = line('anew-0').length
      const st = realFs.statSync(f)
      // As the older build left it: the first line read, the mark untouched.
      db.cursors.set(f, { ...before, size: one, mtime: st.mtimeMs - 1, lastOffset: one, scannedTo: one })
      const events = db.events
      await report(f, 'change')
      expect(db.events).toBe(events + 2)
    })

    // Its turns are the same bytes whichever session they are in (as these
    // are written here), so only the header tells the two rollouts apart: the
    // file's first bytes. One read while it held no turn yet is marked too.
    for (const turns of [2, 0]) {
      it(`a Codex rollout of ${turns} turns deleted and made again larger is read from its first byte, as the session it now holds`, async () => {
        const day = path.join(codexDir, '2026', '08', '01')
        realFs.mkdirSync(day, { recursive: true })
        const name = 'rollout-2026-08-01T00-00-00-a.jsonl'
        const file = path.join(day, name)
        realFs.writeFileSync(file, rollout('cx-a', turns))
        await start()
        expect(db.events).toBe(5 + turns)
        expect(db.cursors.get(file)).toMatchObject({ codexSessionId: 'cx-a', codexTurns: turns })
        makeAgain(file, rollout('cx-b', 5))
        const full = nextSweep('the full sweep')
        fire(codexDir, 'rename', path.join('2026', '08', '01', name))
        await full
        expect(db.events).toBe(5 + turns + 5)
        expect(db.cursors.get(file)).toMatchObject({ codexSessionId: 'cx-b', codexTurns: 5, lastOffset: realFs.statSync(file).size })
      })
    }

    it('a Codex rollout made again with exactly as many bytes as were read of the old one is read too, as the session it now holds', async () => {
      const day = path.join(codexDir, '2026', '08', '01')
      realFs.mkdirSync(day, { recursive: true })
      const name = 'rollout-2026-08-01T00-00-00-a.jsonl'
      const file = path.join(day, name)
      realFs.writeFileSync(file, rollout('cx-a', 2))
      await start()
      expect(db.events).toBe(5 + 2)
      makeAgain(file, rollout('cx-b', 2))
      expect(realFs.statSync(file).size).toBe(db.cursors.get(file)!.lastOffset)
      const later = new Date(Date.now() + 5000)
      realFs.utimesSync(file, later, later)
      const full = nextSweep('the full sweep')
      fire(codexDir, 'rename', path.join('2026', '08', '01', name))
      await full
      expect(db.events).toBe(5 + 2 + 2)
      expect(db.cursors.get(file)).toMatchObject({ codexSessionId: 'cx-b', codexTurns: 2 })
    })

    it('a Codex rollout that only grew is read on from where it stopped', async () => {
      const day = path.join(codexDir, '2026', '08', '01')
      realFs.mkdirSync(day, { recursive: true })
      const name = 'rollout-2026-08-01T00-00-00-a.jsonl'
      const file = path.join(day, name)
      realFs.writeFileSync(file, rollout('cx-a', 2))
      await start()
      expect(db.events).toBe(5 + 2)
      // One more turn: the last line of a rollout of three.
      realFs.appendFileSync(file, rollout('cx-a', 3).split('\n').slice(-2).join('\n'))
      const full = nextSweep('the full sweep')
      fire(codexDir, 'change', path.join('2026', '08', '01', name))
      await full
      expect(db.events).toBe(5 + 2 + 1)
      const c = db.cursors.get(file)!
      expect(c).toMatchObject({ codexSessionId: 'cx-a', codexTurns: 3, lastOffset: realFs.statSync(file).size })
      expect(c.readMark).toMatch(new RegExp(`^${c.lastOffset}:`))
    })

    it('a Codex rollout whose bytes cannot be read to check them is counted as not read, its cursor left as it was, and read once they can be', async () => {
      const day = path.join(codexDir, '2026', '08', '01')
      realFs.mkdirSync(day, { recursive: true })
      const name = 'rollout-2026-08-01T00-00-00-a.jsonl'
      const file = path.join(day, name)
      realFs.writeFileSync(file, rollout('cx-a', 2))
      await start()
      const before = { ...db.cursors.get(file)! }
      realFs.appendFileSync(file, rollout('cx-a', 3).split('\n').slice(-2).join('\n'))
      // The first read of the open is the check's; the ones after it would succeed.
      readFails.set(file, (nth) => nth === 0)
      let full = nextSweep('the full sweep')
      fire(codexDir, 'change', path.join('2026', '08', '01', name))
      await full
      expect(failed.at(-1)).toBe(1)
      expect(db.events).toBe(5 + 2)
      expect(db.cursors.get(file)).toEqual(before)
      expect(errors).toEqual([])
      readFails.clear()
      full = nextSweep('the full sweep')
      fire(codexDir, 'change', path.join('2026', '08', '01', name))
      await full
      expect(failed.at(-1)).toBe(0)
      expect(db.events).toBe(5 + 2 + 1)
    })

    it('a Codex rollout whose time changed and nothing else is not read again, and keeps its mark and its session', async () => {
      const day = path.join(codexDir, '2026', '08', '01')
      realFs.mkdirSync(day, { recursive: true })
      const name = 'rollout-2026-08-01T00-00-00-a.jsonl'
      const file = path.join(day, name)
      realFs.writeFileSync(file, rollout('cx-a', 2))
      await start()
      const mark = db.cursors.get(file)!.readMark
      expect(mark).toBeTruthy()
      const later = new Date(Date.now() + 5000)
      realFs.utimesSync(file, later, later)
      const full = nextSweep('the full sweep')
      fire(codexDir, 'change', path.join('2026', '08', '01', name))
      await full
      expect(db.events).toBe(5 + 2)
      expect(db.cursors.get(file)).toMatchObject({ mtime: realFs.statSync(file).mtimeMs, readMark: mark, codexSessionId: 'cx-a', codexTurns: 2 })
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

  // 2.1.3-beta.4: Tokenomics as an optional service. A full pass counts what
  // its two walks touched and says so as it finishes (the Services panel
  // shows it). The walks start at the folders the app named and list nothing
  // outside them: the guards below fail when a walk widens (a folder outside
  // the roots, more than the fixture holds, a folder deeper than twelve
  // below a root, a link followed). Switched off and on again, the worker
  // reads on from each file's stored progress. The page's Rescan puts that
  // progress back to the start and reads every file again, and no pass says
  // it is done while a Rescan waits. The accounts Settings leaves out reach
  // the database with a query.
  describe('the optional service: counted walks, catching up, and Rescan (2.1.3-beta.4)', () => {
    type Walk = NonNullable<Extract<FromTkWorker, { type: 'index-complete' }>['walk']>
    /** What each finished pass said its walks touched: nothing, for a pass
     *  over the reported transcripts alone. */
    let walkOf: Array<Walk | undefined> = []
    /** Whether a worker said the index was complete as it opened. */
    let readyComplete: boolean[] = []
    beforeEach(() => {
      walkOf = []
      readyComplete = []
      onWorkerMessage = (m) => {
        if (m.type === 'index-complete') walkOf.push(m.walk)
        if (m.type === 'ready') readyComplete.push(m.firstIndexComplete)
      }
    })
    /** `p` is `root` or lies below it. */
    const under = (p: string, root: string): boolean => {
      const rel = path.relative(path.resolve(root), path.resolve(p))
      return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
    }
    const rolloutA = (): string => path.join(codexDir, '2026', '08', '01', 'rollout-2026-08-01T00-00-00-a.jsonl')
    /** An account's own sessions folder, named to the worker after it opens. */
    const realm = (): string => path.join(tmp, 'realms', 'acct-1', 'sessions')
    const rolloutB = (): string => path.join(realm(), '2026', '08', '02', 'rollout-2026-08-02T00-00-00-b.jsonl')
    const nested = (): string => path.join(claudeDir, 'F--proj', 's9', 'subagents', 'agent-x.jsonl')

    /**
     * The fixture tree. Under the three transcript roots, beside the five
     * transcripts every test starts with: a nested transcript, files that
     * are not transcripts, and an empty project. Outside the roots, close
     * by: what a wider walk would find.
     *
     *   claude/                    2 names   (the projects root)
     *     F--proj/                 7 names   s0..s4.jsonl, notes.txt, s9/
     *       s9/                    1 name
     *         subagents/           2 names   agent-x.jsonl, agent-x.meta.json
     *     G--empty/                0 names
     *   codex/                     1 name    (this computer's sessions root)
     *     2026/08/01/              1, 1, 2   rollout-...-a.jsonl, other.jsonl
     *   realms/acct-1/sessions/    1 name    (an account's sessions root)
     *     2026/08/02/              1, 1, 1   rollout-...-b.jsonl
     */
    function plant(): void {
      realFs.mkdirSync(path.dirname(nested()), { recursive: true })
      realFs.writeFileSync(nested(), line('sub'))
      realFs.writeFileSync(path.join(path.dirname(nested()), 'agent-x.meta.json'), '{}')
      realFs.writeFileSync(path.join(claudeDir, 'F--proj', 'notes.txt'), 'notes')
      realFs.mkdirSync(path.join(claudeDir, 'G--empty'))
      realFs.mkdirSync(path.dirname(rolloutA()), { recursive: true })
      realFs.writeFileSync(rolloutA(), rollout('cx-a', 2))
      realFs.writeFileSync(path.join(path.dirname(rolloutA()), 'other.jsonl'), line('not-a-rollout'))
      realFs.mkdirSync(path.dirname(rolloutB()), { recursive: true })
      realFs.writeFileSync(rolloutB(), rollout('cx-b', 3))
      // Outside every root.
      realFs.writeFileSync(path.join(tmp, 'decoy.jsonl'), line('decoy-above'))
      realFs.mkdirSync(path.join(tmp, 'claude-other', 'F--proj'), { recursive: true })
      realFs.writeFileSync(path.join(tmp, 'claude-other', 'F--proj', 'decoy.jsonl'), line('decoy-beside'))
      realFs.mkdirSync(path.join(tmp, 'realms', 'acct-2', 'sessions'), { recursive: true })
      realFs.writeFileSync(path.join(tmp, 'realms', 'acct-2', 'sessions', 'rollout-decoy.jsonl'), rollout('cx-decoy', 1))
      realFs.writeFileSync(path.join(tmp, 'realms', 'acct-1', 'rollout-above.jsonl'), rollout('cx-above', 1))
    }
    /** Name the account's folder to the running worker and wait for the
     *  pass that reads it. */
    async function nameRealm(): Promise<void> {
      const read = drainedSweep('the pass with the account folder')
      transport!.post({ type: 'set-codex-realm-dirs', dirs: [{ dir: realm(), accountKey: 'codex:acct-1' }] })
      await read
    }

    it('a full pass says what each of its two walks touched and how many files it opened', async () => {
      plant()
      await start()
      // The projects root and this computer's sessions root.
      expect(walkOf).toHaveLength(1)
      expect(walkOf[0]).toMatchObject({
        transcripts: { dirs: 5, entries: 12, files: 6 },
        rollouts: { dirs: 4, entries: 5, files: 1 },
        filesRead: 7,
      })
      expect(Number.isSafeInteger(walkOf[0]!.at)).toBe(true)
      expect(walkOf[0]!.ms).toBeGreaterThanOrEqual(0)
      // With the account's folder named: its walk is counted with the other.
      await nameRealm()
      expect(walkOf.at(-1)).toMatchObject({
        transcripts: { dirs: 5, entries: 12, files: 6 },
        rollouts: { dirs: 8, entries: 9, files: 2 },
        // Only the account's rollout is new; the rest is as the index has it.
        filesRead: 1,
      })
    })

    it('a pass over the reported transcripts alone walks nothing and reports no walk', async () => {
      await start()
      realFs.appendFileSync(transcript('s2'), line('more-2'))
      clearCounts()
      const read = nextSweep('the changed-files sweep')
      fire(claudeDir, 'change', path.join('F--proj', 's2.jsonl'))
      await read
      expect(listings).toBe(0)
      expect(walkOf).toHaveLength(2)
      expect(walkOf[0]).toBeDefined()
      expect(walkOf[1]).toBeUndefined()
    })

    // The guard that fails if a walk widens: it lists a folder outside the
    // transcript roots, opens anything but the fixture's transcripts, or
    // touches more than the fixture holds under the roots.
    it('no walk lists a folder outside the transcript roots, and only the transcripts under them are opened', async () => {
      plant()
      await start()
      await nameRealm()
      const roots = [claudeDir, codexDir, realm()]
      const inRoots = (p: string): boolean => roots.some((r) => under(p, r))

      // Every folder listed is a root or below one.
      expect(listed.filter((d) => !inRoots(d))).toEqual([])
      // Every file opened is one of the fixture's eight transcripts, and all
      // eight were: nothing more, nothing outside.
      expect([...new Set(opened)].sort()).toEqual([...five(), nested(), rolloutA(), rolloutB()].sort())
      // Every size asked is of a path under a root.
      expect(statted.filter((p) => !inRoots(p))).toEqual([])
      // A path looked at without following a link is under a root, or is a
      // folder a root lies in (how deep a link on a root's own path leads).
      expect(lstatted.filter((p) => !inRoots(p) && !roots.some((r) => under(r, p)))).toEqual([])
      // Only the roots are watched.
      expect([...watchCbs.keys()].sort()).toEqual([...roots].sort())

      // The counts are the fixture's, exactly, and they are what was really
      // listed: two passes, the second with the account's folder too.
      const [first, second] = [walkOf[0]!, walkOf.at(-1)!]
      expect(walkOf).toHaveLength(2)
      expect([first.transcripts, first.rollouts]).toEqual([{ dirs: 5, entries: 12, files: 6 }, { dirs: 4, entries: 5, files: 1 }])
      expect([second.transcripts, second.rollouts]).toEqual([{ dirs: 5, entries: 12, files: 6 }, { dirs: 8, entries: 9, files: 2 }])
      expect(listings).toBe(5 + 4 + 5 + 8)
      expect(entriesListed).toBe(12 + 5 + 12 + 9)
    })

    // The guard on depth. A walk lists its root (depth 0) and the folders
    // down to twelve below it, and no folder below that. A transcript in a
    // folder twelve down is read; one a folder further down is never found.
    // Both walks, each with its own chain of folders, so a limit moved at
    // either one, up or down, fails here.
    it('no walk lists a folder more than twelve below its root: a transcript twelve down is read, one thirteen down is never found', async () => {
      /** The folders `from`..13 below `root`, each inside the one before. */
      const chain = (top: string, from: number, prefix: string): string[] => {
        const out: string[] = []
        let dir = top
        for (let depth = from; depth <= 13; depth++) { dir = path.join(dir, `${prefix}${String(depth).padStart(2, '0')}`); out.push(dir) }
        return out
      }
      // The projects root: F--proj is one below it, k02 two, ... k13 thirteen.
      const k = chain(path.join(claudeDir, 'F--proj'), 2, 'k')
      const [k12, k13] = [k[k.length - 2], k[k.length - 1]]
      realFs.mkdirSync(k13, { recursive: true })
      const edge = path.join(k12, 'edge.jsonl')
      const beyond = path.join(k13, 'beyond.jsonl')
      realFs.writeFileSync(edge, line('edge'))
      realFs.writeFileSync(beyond, line('beyond'))
      // This computer's sessions root: r01 is one below it, ... r13 thirteen.
      const r = chain(codexDir, 1, 'r')
      const [r12, r13] = [r[r.length - 2], r[r.length - 1]]
      realFs.mkdirSync(r13, { recursive: true })
      const rolloutEdge = path.join(r12, 'rollout-2026-08-01T00-00-00-edge.jsonl')
      const rolloutBeyond = path.join(r13, 'rollout-2026-08-01T00-00-00-beyond.jsonl')
      realFs.writeFileSync(rolloutEdge, rollout('cx-edge', 1))
      realFs.writeFileSync(rolloutBeyond, rollout('cx-beyond', 1))

      await start()
      // Twelve down: listed, and its transcript read.
      expect(listed).toContain(k12)
      expect(listed).toContain(r12)
      expect(opened).toContain(edge)
      expect(opened).toContain(rolloutEdge)
      // Thirteen down: never listed, so what it holds is never asked about or opened.
      expect(listed).not.toContain(k13)
      expect(listed).not.toContain(r13)
      expect(opened).not.toContain(beyond)
      expect(opened).not.toContain(rolloutBeyond)
      expect(statted).not.toContain(beyond)
      expect(statted).not.toContain(rolloutBeyond)
      expect([...new Set(opened)].sort()).toEqual([...five(), edge, rolloutEdge].sort())
      expect(db.events).toBe(5 + 1 + 1)
      // The counts, exactly: thirteen folders listed by each walk (the root
      // and twelve below it), with the names they returned.
      expect(walkOf).toHaveLength(1)
      expect([walkOf[0]!.transcripts, walkOf[0]!.rollouts]).toEqual([{ dirs: 13, entries: 1 + 6 + 10 + 2, files: 6 }, { dirs: 13, entries: 1 + 11 + 2, files: 1 }])
      expect(listings).toBe(13 + 13)
    })

    // The guard on links. The link here is simulated (listed as a link,
    // and stat, list and open through it reach a folder outside the roots),
    // so the rule is checked on every platform and no real link is planted
    // where this file runs; real links are in the CI suite
    // (tests/unit/native/tokenomics-reindex-accounts.native.test.ts).
    it('a link inside a root is a name in its folder and is never followed: nothing behind it is listed, asked about or opened', async () => {
      plant()
      // What lies behind the links, outside every root: a transcript, and a rollout.
      const outside = path.join(tmp, 'outside')
      realFs.mkdirSync(path.join(outside, 'deeper'), { recursive: true })
      realFs.writeFileSync(path.join(outside, 'behind.jsonl'), line('behind'))
      realFs.writeFileSync(path.join(outside, 'deeper', 'rollout-2026-08-01T00-00-00-behind.jsonl'), rollout('cx-behind', 4))
      dirLinks.set(path.join(claudeDir, 'F--proj'), { name: 'linked', target: outside })
      dirLinks.set(codexDir, { name: 'linked', target: outside })
      const links = [path.join(claudeDir, 'F--proj', 'linked'), path.join(codexDir, 'linked')]
      const behind = (p: string): boolean => links.some((l) => under(p, l))

      await start()
      expect(listed.filter(behind)).toEqual([])
      expect(statted.filter(behind)).toEqual([])
      expect(opened.filter(behind)).toEqual([])
      expect([...new Set(opened)].sort()).toEqual([...five(), nested(), rolloutA()].sort())
      expect(db.events).toBe(5 + 1 + 2)
      // The fixture's counts with one more name in each linked folder: the link itself.
      expect(walkOf).toHaveLength(1)
      expect([walkOf[0]!.transcripts, walkOf[0]!.rollouts]).toEqual([{ dirs: 5, entries: 13, files: 6 }, { dirs: 4, entries: 6, files: 1 }])
      expect(listings).toBe(5 + 4)
    })

    it('switched off and on again, it reads only what was written while it was off', async () => {
      await start()
      expect(db.events).toBe(5)
      expect(readyComplete).toEqual([false])
      // Off: the worker stops. The index, with how far each file was read, stays.
      stopWorker!()
      stopWorker = null
      realFs.appendFileSync(transcript('s1'), line('while-off-1') + line('while-off-2'))
      realFs.writeFileSync(transcript('s7'), line('made-while-off'))
      clearCounts()
      // On: another worker on the same index.
      await start()
      // What was recorded before is there as it opens.
      expect(readyComplete).toEqual([false, true])
      expect([...opened].sort()).toEqual([transcript('s1'), transcript('s7')].sort())
      expect(db.events).toBe(5 + 3)
      expect(completes.at(-1)).toEqual({ firstIndex: false, drained: true })
      expect(db.resets).toBe(0)
    })

    it('Rescan puts every file back to its start and reads each again, once; what is stored stays', async () => {
      realFs.mkdirSync(path.dirname(rolloutA()), { recursive: true })
      realFs.writeFileSync(rolloutA(), rollout('cx-a', 2))
      await start()
      expect(db.events).toBe(5 + 2)
      clearCounts()
      const again = waitFor('the pass after Rescan', (m) => m.type === 'index-complete' && m.drained, 4000)
      transport!.post({ type: 'rescan' })
      // Asked again before it has finished: the one re-read, not another.
      transport!.post({ type: 'rescan' })
      await again
      expect(db.resets).toBe(1)
      expect(walks).toBe(1)
      expect([...opened].sort()).toEqual([...five(), rolloutA()].sort())
      // The stand-in stores every row it is handed, so each turn read again
      // shows here. The index itself keys each turn and stores it once: the
      // totals do not move (covered with the real database in
      // tests/unit/native/tokenomics-excluded-accounts.native.test.ts and
      // tests/unit/native/tokenomics-worker-ingest.native.test.ts).
      expect(db.events).toBe((5 + 2) * 2)
      // The rollout is read from its first byte: its identity and its turns
      // are learned again, as on a first read.
      expect(db.cursors.get(rolloutA())).toMatchObject({ codexSessionId: 'cx-a', codexTurns: 2, lastOffset: realFs.statSync(rolloutA()).size })
      for (const f of five()) expect(db.cursors.get(f)!.lastOffset).toBe(realFs.statSync(f).size)
      // Once: the next full walk finds every file as the index has it.
      clearCounts()
      const full = nextSweep('the next full walk')
      fire(claudeDir, 'rename', 'F--proj')
      await full
      expect(walks).toBe(1)
      expect(opened).toEqual([])
      expect(db.resets).toBe(1)
      // Asked again once it has finished: read again.
      clearCounts()
      const second = waitFor('the pass after a second Rescan', (m) => m.type === 'index-complete' && m.drained, 4000)
      transport!.post({ type: 'rescan' })
      await second
      expect(db.resets).toBe(2)
      expect([...opened].sort()).toEqual([...five(), rolloutA()].sort())
    })

    it('a Rescan asked while a pass runs is not finished by that pass: the next one reads what it had already read', async () => {
      for (let i = 0; i < 60; i++) realFs.writeFileSync(transcript(`n${String(i).padStart(2, '0')}`), line(`n-${i}`))
      let asked = false
      const watch = onWorkerMessage!
      onWorkerMessage = (m) => {
        watch(m)
        // The pass reports its progress after its fiftieth file: asked then,
        // with fifteen of the sixty-five still to read.
        if (!asked && m.type === 'index-progress' && m.filesDone === 50) { asked = true; transport!.post({ type: 'rescan' }) }
      }
      const drained = drainedSweep('the pass that follows the Rescan')
      await start({ waitFirst: false })
      await drained
      expect(asked).toBe(true)
      expect(db.resets).toBe(1)
      // The pass under way did not finish the index; the one after it did.
      expect(completes).toEqual([{ firstIndex: false, drained: false }, { firstIndex: true, drained: true }])
      // Sixty-five read by the first pass, and the fifty it had read before
      // the Rescan read again by the second.
      expect(db.events).toBe(65 + 50)
      await settle()
      expect(completes).toHaveLength(2)
    })

    // A pass that says it is done ends the page's "Rescanning". Neither a
    // pass over the reported transcripts nor a full pass that had read every
    // file before the Rescan arrived may say so: the Rescan's own pass has
    // not run yet. Both are asked while the pass settles the accounts, where
    // the worker yields (a rollup rebuild of two steps).
    it('a Rescan asked while a pass over the reported transcripts runs: that pass does not say it is done, the pass that follows does', async () => {
      await start()
      expect(completes).toEqual([{ firstIndex: true, drained: true }])
      db.meta.set('rollupsDirty', '1')
      db.rebuildSteps = 2
      let asked = false
      const watch = onWorkerMessage!
      onWorkerMessage = (m) => {
        watch(m)
        if (!asked && m.type === 'index-progress' && m.accountReread?.stage === 'rebuild') { asked = true; transport!.post({ type: 'rescan' }) }
      }
      realFs.appendFileSync(transcript('s2'), line('more-2'))
      const after = drainedSweep('the pass that follows the Rescan')
      fire(claudeDir, 'change', path.join('F--proj', 's2.jsonl'))
      await after
      expect(asked).toBe(true)
      expect(db.resets).toBe(1)
      // The pass over the reported transcript, then the Rescan's own.
      expect(completes.slice(1)).toEqual([{ firstIndex: false, drained: false }, { firstIndex: false, drained: true }])
      // Only the Rescan's pass walked.
      expect(walkOf.slice(1).map((w) => w !== undefined)).toEqual([false, true])
      await settle()
      expect(completes).toHaveLength(3)
    })

    it('a Rescan asked after a full pass has read every file, while it settles the accounts: that pass does not say it is done either', async () => {
      db.meta.set('rollupsDirty', '1')
      db.rebuildSteps = 2
      let asked = false
      const watch = onWorkerMessage!
      onWorkerMessage = (m) => {
        watch(m)
        if (!asked && m.type === 'index-progress' && m.accountReread?.stage === 'rebuild') { asked = true; transport!.post({ type: 'rescan' }) }
      }
      const drained = drainedSweep('the pass that follows the Rescan')
      await start({ waitFirst: false })
      await drained
      expect(asked).toBe(true)
      expect(db.resets).toBe(1)
      // The first pass read all five and then was asked: not done, and not
      // the first index. The Rescan's pass read them again and is.
      expect(completes).toEqual([{ firstIndex: false, drained: false }, { firstIndex: true, drained: true }])
      expect(db.events).toBe(5 + 5)
      await settle()
      expect(completes).toHaveLength(2)
    })

    // The Rescan's own pass has read every file from its start and settles
    // the accounts, where the worker yields. A second Rescan asked there is
    // the one still under way: nothing is reset again, and that pass says it
    // is done. It used to reset every file again and start the read over.
    it('a Rescan asked again while the Rescan\'s own pass settles the accounts is the same Rescan: nothing is reset again, and that pass says it is done', async () => {
      await start()
      expect(completes).toEqual([{ firstIndex: true, drained: true }])
      const eventsBefore = db.events
      db.meta.set('rollupsDirty', '1')
      db.rebuildSteps = 2
      let asked = false
      const watch = onWorkerMessage!
      onWorkerMessage = (m) => {
        watch(m)
        if (!asked && m.type === 'index-progress' && m.accountReread?.stage === 'rebuild') { asked = true; transport!.post({ type: 'rescan' }) }
      }
      clearCounts()
      const done = drainedSweep('the Rescan\'s own pass')
      transport!.post({ type: 'rescan' })
      await done
      expect(asked).toBe(true)
      expect(db.resets).toBe(1)
      expect(completes.slice(1)).toEqual([{ firstIndex: false, drained: true }])
      expect(walks).toBe(1)
      expect(db.events).toBe(eventsBefore + 5)
      await settle()
      expect(completes).toHaveLength(2)
      expect(db.resets).toBe(1)
      // Over: a Rescan asked now is a new one.
      const again = drainedSweep('the pass of the next Rescan')
      transport!.post({ type: 'rescan' })
      await again
      expect(db.resets).toBe(2)
    })

    it('the accounts Settings leaves out reach the database with each query', async () => {
      await start()
      const A = 'claude:acct-a'
      transport!.post({ type: 'query', id: 1, kind: 'summary', args: { configId: 'a', excludeAccountKeys: [A] } })
      transport!.post({ type: 'query', id: 2, kind: 'sessions', args: { limit: 5, excludeAccountKeys: [A] } })
      transport!.post({ type: 'query', id: 3, kind: 'session-detail', args: { sessionId: SESSION, excludeAccountKeys: [A] } })
      transport!.post({ type: 'query', id: 4, kind: 'accounts', args: { excludeAccountKeys: [A] } })
      transport!.post({ type: 'query', id: 5, kind: 'accounts', args: {} })
      expect(db.queries).toEqual([
        ['summary', { configId: 'a', excludeAccountKeys: [A] }],
        ['sessions', { limit: 5, excludeAccountKeys: [A] }],
        ['session-detail', SESSION, [A]],
        ['accounts', [A]],
        ['accounts', undefined],
      ])
    })
  })
})
