// aicc_planning#302: a transcript the watcher reports is read on its own; the
// whole ~/.claude/projects tree is walked only when a full sweep is due. The
// worker runs with a real in-memory database and the real file system, wrapped
// so the test can count directory listings and fire watcher events by hand.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as realFs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createTokenomicsWorker } from '../../../src/main/tokenomics/tokenomics-worker'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'
import type { FromTkWorker } from '../../../src/main/tokenomics/tk-worker-transport'

const PRICING = { 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }
const line = (id: string) => JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T10:00:00Z', sessionId: 's1', requestId: `r-${id}`,
  message: { id: `m-${id}`, model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }) + '\n'
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))

describe('tokenomics worker: changed-files sweep (#302)', () => {
  let tmp: string
  let stop: (() => void) | null = null
  let readdirs = 0
  const watchCbs = new Map<string, (event: string, filename: string | null) => void>()

  // The real fs, with directory listings counted and recursive watchers captured.
  const fs = new Proxy(realFs, {
    get(target, prop) {
      if (prop === 'readdirSync') return (...a: unknown[]) => { readdirs++; return (target.readdirSync as (...x: unknown[]) => unknown)(...a) }
      if (prop === 'watch') return (dir: string, _o: unknown, cb: (e: string, f: string | null) => void) => { watchCbs.set(dir, cb); return { close() {}, on() {} } }
      return (target as unknown as Record<string | symbol, unknown>)[prop]
    },
  }) as typeof realFs

  let claudeDir: string
  let msgs: FromTkWorker[]
  let fake: FakeTkWorkerTransport

  async function cost(): Promise<number> {
    const id = Math.floor(Math.random() * 1e9)
    fake.post({ type: 'query', id, kind: 'summary', args: {} })
    await tick(20)
    const res = msgs.find((m) => m.type === 'query-result' && (m as { id?: number }).id === id) as { rows: Array<{ kpis: { lifeToDateCostUsd: number } }> }
    return res.rows[0].kpis.lifeToDateCostUsd
  }

  beforeEach(async () => {
    tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'tkd-'))
    claudeDir = path.join(tmp, 'claude')
    realFs.mkdirSync(path.join(claudeDir, 'F--proj'), { recursive: true })
    for (let i = 0; i < 5; i++) realFs.writeFileSync(path.join(claudeDir, 'F--proj', `s${i}.jsonl`), line(`init-${i}`))
    readdirs = 0
    watchCbs.clear()
    msgs = []
    fake = new FakeTkWorkerTransport()
    fake.onMessage((m) => msgs.push(m))
    const w = createTokenomicsWorker(fake.asWorkerSide(), { fs, watchDebounceMs: 5 })
    stop = () => w.stop()
    fake.post({ type: 'open', dbPath: ':memory:', pricing: PRICING, configs: [], claudeProjectsDir: claudeDir, codexSessionsDir: path.join(tmp, 'codex') })
    await tick(100)
  })
  afterEach(() => { stop?.(); realFs.rmSync(tmp, { recursive: true, force: true }) })

  it('the first sweep walks the tree and reads everything', async () => {
    expect(readdirs).toBeGreaterThan(0)
    expect(await cost()).toBeCloseTo(25, 5)
  })

  it('a reported change reads that file without listing the tree', async () => {
    const f = path.join(claudeDir, 'F--proj', 's2.jsonl')
    realFs.appendFileSync(f, line('more'))
    readdirs = 0
    const before = msgs.filter((m) => m.type === 'index-complete').length
    watchCbs.get(claudeDir)!('change', path.join('F--proj', 's2.jsonl'))
    await tick(80)
    expect(readdirs).toBe(0)
    expect(await cost()).toBeCloseTo(30, 5)
    // ...and says so, so the Usage page refreshes.
    expect(msgs.filter((m) => m.type === 'index-complete').length).toBe(before + 1)
  })

  it('a newly made transcript is read on its own too', async () => {
    realFs.mkdirSync(path.join(claudeDir, 'F--proj', 's9', 'subagents'), { recursive: true })
    realFs.writeFileSync(path.join(claudeDir, 'F--proj', 's9', 'subagents', 'agent-x.jsonl'), line('sub'))
    readdirs = 0
    watchCbs.get(claudeDir)!('rename', path.join('F--proj', 's9', 'subagents', 'agent-x.jsonl'))
    await tick(80)
    expect(readdirs).toBe(0)
    expect(await cost()).toBeCloseTo(30, 5)
  })

  it('an event with no file name, a folder or a deleted file makes the next sweep a full one', async () => {
    for (const name of [null, 'F--proj', path.join('F--proj', 'gone.jsonl')]) {
      readdirs = 0
      watchCbs.get(claudeDir)!('rename', name)
      await tick(80)
      expect(readdirs, String(name)).toBeGreaterThan(0)
    }
  })

  it('a file the watcher never reported is still read by a full sweep (re-index)', async () => {
    realFs.writeFileSync(path.join(claudeDir, 'F--proj', 'unseen.jsonl'), line('unseen'))
    expect(await cost()).toBeCloseTo(25, 5)
    fake.post({ type: 'reindex' })
    await tick(100)
    expect(await cost()).toBeCloseTo(30, 5)
  })

  // A file deleted and made again at the path of one already read is read
  // from its first byte, whatever its size. On the real database a line it
  // shares with the file that was read is stored once.
  it('a transcript deleted and made again larger is counted in full: each of its lines once', async () => {
    const f = path.join(claudeDir, 'F--proj', 's2.jsonl')
    realFs.rmSync(f)
    // As long as the old line, so the old offset is the end of its first line.
    realFs.writeFileSync(f, line('anew-0') + line('anew-1') + line('anew-2'))
    readdirs = 0
    watchCbs.get(claudeDir)!('rename', path.join('F--proj', 's2.jsonl'))
    await tick(80)
    expect(readdirs).toBe(0)
    // The five stored at start (the old file's line stays) and the three new.
    expect(await cost()).toBeCloseTo(40, 5)
    // Read once: a re-index finds nothing more.
    fake.post({ type: 'reindex' })
    await tick(100)
    expect(await cost()).toBeCloseTo(40, 5)
  })

  it('one made again with a line the old file had among new ones stores that line once', async () => {
    const f = path.join(claudeDir, 'F--proj', 's2.jsonl')
    realFs.rmSync(f)
    realFs.writeFileSync(f, line('anew-0') + line('init-2') + line('anew-1'))
    watchCbs.get(claudeDir)!('rename', path.join('F--proj', 's2.jsonl'))
    await tick(80)
    expect(await cost()).toBeCloseTo(35, 5)
  })

  it('one put back with the bytes it had and more stores only the lines that are new', async () => {
    const f = path.join(claudeDir, 'F--proj', 's2.jsonl')
    realFs.rmSync(f)
    realFs.writeFileSync(f, line('init-2') + line('more-0') + line('more-1'))
    watchCbs.get(claudeDir)!('rename', path.join('F--proj', 's2.jsonl'))
    await tick(80)
    expect(await cost()).toBeCloseTo(35, 5)
  })

  it('totals after single-file changes equal a full re-index of the same data', async () => {
    for (const i of [0, 3]) {
      realFs.appendFileSync(path.join(claudeDir, 'F--proj', `s${i}.jsonl`), line(`x-${i}`))
      watchCbs.get(claudeDir)!('change', path.join('F--proj', `s${i}.jsonl`))
      await tick(60)
    }
    const incremental = await cost()
    fake.post({ type: 'reindex' })
    await tick(100)
    expect(await cost()).toBeCloseTo(incremental, 5)
    expect(incremental).toBeCloseTo(35, 5)
  })
})

// The index keeps, with how far each file was read, a mark of the bytes read
// up to there. It is kept in the database, so a worker that starts again
// (the app started again, or the supervisor starting the worker) tells a file
// made again while it was not running, and a database from before the mark
// was kept reads on as it always did.
describe('tokenomics worker: the mark of what was read, across a restart', () => {
  let tmp: string
  let claudeDir: string
  let dbPath: string
  let stop: (() => void) | null = null
  let msgs: FromTkWorker[]
  let fake: FakeTkWorkerTransport
  const s2 = (): string => path.join(claudeDir, 'F--proj', 's2.jsonl')
  // The real fs with no watcher started: each case starts its sweeps itself.
  const fs = new Proxy(realFs, {
    get(target, prop) {
      if (prop === 'watch') return () => ({ close() {}, on() {} })
      return (target as unknown as Record<string | symbol, unknown>)[prop]
    },
  }) as typeof realFs

  async function cost(): Promise<number> {
    const id = Math.floor(Math.random() * 1e9)
    fake.post({ type: 'query', id, kind: 'summary', args: {} })
    await tick(20)
    const res = msgs.find((m) => m.type === 'query-result' && (m as { id?: number }).id === id) as { rows: Array<{ kpis: { lifeToDateCostUsd: number } }> }
    return res.rows[0].kpis.lifeToDateCostUsd
  }
  async function startWorker(): Promise<void> {
    msgs = []
    fake = new FakeTkWorkerTransport()
    fake.onMessage((m) => msgs.push(m))
    const w = createTokenomicsWorker(fake.asWorkerSide(), { fs, watchDebounceMs: 5 })
    stop = () => w.stop()
    fake.post({ type: 'open', dbPath, pricing: PRICING, configs: [], claudeProjectsDir: claudeDir, codexSessionsDir: path.join(tmp, 'codex') })
    await tick(100)
  }
  async function stopWorker(): Promise<void> {
    stop?.()
    stop = null
    await tick(30)
  }

  beforeEach(async () => {
    tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'tkmark-'))
    claudeDir = path.join(tmp, 'claude')
    dbPath = path.join(tmp, 'tk.db')
    realFs.mkdirSync(path.join(claudeDir, 'F--proj'), { recursive: true })
    for (let i = 0; i < 5; i++) realFs.writeFileSync(path.join(claudeDir, 'F--proj', `s${i}.jsonl`), line(`init-${i}`))
    await startWorker()
  })
  afterEach(async () => { await stopWorker(); realFs.rmSync(tmp, { recursive: true, force: true }) })

  it('every cursor is stored with its mark, and a transcript made again larger while the worker was not running is counted in full', async () => {
    expect(await cost()).toBeCloseTo(25, 5)
    await stopWorker()
    const raw = new Database(dbPath)
    const rows = raw.prepare('SELECT path, lastOffset, readMark FROM tk_files').all() as Array<{ path: string; lastOffset: number; readMark: string }>
    raw.close()
    expect(rows).toHaveLength(5)
    for (const r of rows) expect(r.readMark, r.path).toMatch(new RegExp(`^${r.lastOffset}:\\d+:\\d+:[0-9a-f]{32}$`))
    realFs.rmSync(s2())
    realFs.writeFileSync(s2(), line('anew-0') + line('anew-1') + line('anew-2'))
    await startWorker()
    expect(await cost()).toBeCloseTo(40, 5)
  })

  it('a database from before the mark was kept: a transcript that grew is read on, and marked as it is read', async () => {
    await stopWorker()
    const raw = new Database(dbPath)
    raw.exec('ALTER TABLE tk_files DROP COLUMN readMark')
    raw.close()
    realFs.appendFileSync(s2(), line('more-0'))
    await startWorker()
    expect(await cost()).toBeCloseTo(30, 5)
    await stopWorker()
    const check = new Database(dbPath)
    const row = check.prepare('SELECT lastOffset, readMark FROM tk_files WHERE path = ?').get(s2()) as { lastOffset: number; readMark: string }
    const unmarked = check.prepare("SELECT COUNT(*) AS n FROM tk_files WHERE readMark = ''").get() as { n: number }
    check.close()
    expect(row.lastOffset).toBe(realFs.statSync(s2()).size)
    expect(row.readMark).toMatch(new RegExp(`^${row.lastOffset}:`))
    // The four not read since have none yet.
    expect(unmarked.n).toBe(4)
  })
})
