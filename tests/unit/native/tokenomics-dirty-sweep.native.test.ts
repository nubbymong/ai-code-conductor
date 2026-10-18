// aicc_planning#302: a transcript the watcher reports is read on its own; the
// whole ~/.claude/projects tree is walked only when a full sweep is due. The
// worker runs with a real in-memory database and the real file system, wrapped
// so the test can count directory listings and fire watcher events by hand.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
