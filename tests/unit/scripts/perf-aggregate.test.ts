/**
 * [host] The performance harness's arithmetic (scripts/perf/lib/aggregate.cjs):
 * CPU percent from two cumulative CPU-time samples of the same process, the
 * p95 over a window, a reused pid (same pid, new start time) never read as
 * the old process's counters going on, I/O operations per second from
 * cumulative counters, and the renderer's metric deltas.
 *
 * Pure functions on in-memory rows: nothing is written to disk and nothing
 * is started; the one file read is the fixture of real command lines from
 * the Windows test VM (2.1.3-beta.6, installed app on a staging root).
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'

const PERF = resolve(__dirname, '..', '..', '..', 'scripts', 'perf')
const req = createRequire(join(PERF, 'report.cjs'))
type Row = { t: number; pid: number; ppid: number; name: string; created: number; cpuSec: number; privateBytes: number; workingSet: number; handles: number; threads: number; ioOps: number; otherOps: number; cmd?: string }
type RoleSummary = { role: string; processes: number; intervals: number; cpuMean: number | null; cpuP95: number | null; cpuMax: number | null; privateMb: number | null; ioOpsPerSec: number | null; handles: number | null }
const A = req('./lib/aggregate.cjs') as {
  normalizeRow: (raw: Record<string, unknown>) => Row
  parseSampleText: (text: string) => { header: Record<string, unknown> | null; ticks: unknown[]; rows: Row[] }
  cpuPercent: (prev: Row, cur: Row) => number | null
  ratePerSec: (a: number, b: number, dtMs: number) => number | null
  percentile: (values: number[], p: number) => number | null
  summarizeByRole: (rows: Row[], o: { from?: number; to?: number; roleOf: (r: Row) => string | null }) => RoleSummary[]
  perfMetricsDelta: (a: unknown, b: unknown) => Record<string, number> | null
  appCpuByRole: (a: unknown, b: unknown, roleOf: (m: { pid: number; type: string; name?: string }) => string | null) => Map<string, number>
  markdownTable: (cols: Array<{ label: string; get: (r: unknown) => unknown; align?: string }>, rows: unknown[]) => string
}
const Cl = req('./lib/classify-process.cjs') as {
  classifyProcess: (p: { pid: number; name: string; cmd?: string }, ctx?: Record<string, unknown>) => string
  contextFrom: (o: Record<string, unknown>) => Record<string, unknown>
}

// Real command lines from the VM (tests/fixtures/perf/vm-cmdlines.json).
const VM = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'fixtures', 'perf', 'vm-cmdlines.json'), 'utf8')) as Record<string, string>
const CMD = { main: VM.main, renderer: VM.renderer, gpu: VM.gpu, utility: VM.nodeService, fake: VM.fakeClaude }

let t0 = 1_763_330_000_000
const row = (o: Partial<Row> & { t: number; pid: number; cpuSec: number }): Row => ({
  ppid: 1, name: 'AI Code Conductor.exe', created: 1_000, privateBytes: 100 * 1024 * 1024, workingSet: 0, handles: 500, threads: 20, ioOps: 0, otherOps: 0, ...o,
})

describe('CPU percent from two cumulative CPU-time samples', () => {
  it('is the CPU seconds used between the samples over the seconds between them, in percent of one core', () => {
    const prev = row({ t: t0 + 100_000, pid: 7, cpuSec: 40 })
    const cur = row({ t: t0 + 105_000, pid: 7, cpuSec: 40.25 })
    expect(A.cpuPercent(prev, cur)).toBeCloseTo(5, 6)
  })

  it('reads Win32_Process user and kernel time as 100 ns units', () => {
    const a = A.normalizeRow({ kind: 'p', t: t0, pid: 9, ppid: 1, name: 'x.exe', created: 5, user: 30_000_000, kernel: 10_000_000 })
    const b = A.normalizeRow({ kind: 'p', t: t0 + 2_000, pid: 9, ppid: 1, name: 'x.exe', created: 5, user: 35_000_000, kernel: 11_000_000 })
    expect(a.cpuSec).toBeCloseTo(4, 6)
    expect(A.cpuPercent(a, b)).toBeCloseTo(30, 6) // 0.6 s over 2 s
  })

  it('is null when no time passed or the counter went back', () => {
    expect(A.cpuPercent(row({ t: t0, pid: 1, cpuSec: 1 }), row({ t: t0, pid: 1, cpuSec: 2 }))).toBeNull()
    expect(A.cpuPercent(row({ t: t0, pid: 1, cpuSec: 2 }), row({ t: t0 + 5_000, pid: 1, cpuSec: 1 }))).toBeNull()
  })
})

describe('a window per role', () => {
  // Ticks every 5 s; one process whose CPU rises 0.1 s per tick (2 %), with a
  // 2.5 s burst (50 %) in two intervals of twenty.
  const ticks = Array.from({ length: 21 }, (_, k) => t0 + k * 5_000)
  const burst = new Set([7, 15])
  let cpu = 10
  const steady = ticks.map((t, k) => {
    if (k > 0) cpu += burst.has(k) ? 2.5 : 0.1
    return row({ t, pid: 300, cpuSec: cpu, ioOps: 1_000 + k * 50 })
  })

  it('takes the mean and the nearest-rank p95 over the intervals', () => {
    const [s] = A.summarizeByRole(steady, { roleOf: () => 'main' })
    expect(s.intervals).toBe(20)
    expect(s.cpuMean).toBeCloseTo((18 * 2 + 2 * 50) / 20, 6)
    // 20 intervals: the 19th smallest is the first burst.
    expect(s.cpuP95).toBeCloseTo(50, 6)
    expect(s.cpuMax).toBeCloseTo(50, 6)
    expect(A.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 95)).toBe(19)
  })

  it('turns cumulative read and write operation counts into operations per second', () => {
    const [s] = A.summarizeByRole(steady, { roleOf: () => 'main' })
    expect(s.ioOpsPerSec).toBeCloseTo(10, 6) // 50 operations every 5 s
    expect(A.ratePerSec(100, 160, 3_000)).toBeCloseTo(20, 6)
    expect(A.ratePerSec(160, 100, 3_000)).toBeNull()
  })

  it('keeps only the ticks inside [from, to]', () => {
    const [s] = A.summarizeByRole(steady, { from: ticks[0], to: ticks[5], roleOf: () => 'main' })
    expect(s.intervals).toBe(5)
    expect(s.cpuMean).toBeCloseTo(2, 6)
  })

  it('does not read a reused pid (same pid, new start time) as the old process going on', () => {
    // pid 400 ends after tick 1; a new, busy process gets pid 400 before tick 2.
    const rows = [
      row({ t: ticks[0], pid: 400, created: 1_000, cpuSec: 50 }),
      row({ t: ticks[1], pid: 400, created: 1_000, cpuSec: 50.5 }), // 10 %
      row({ t: ticks[2], pid: 400, created: ticks[1] + 1_000, cpuSec: 53 }),
      row({ t: ticks[3], pid: 400, created: ticks[1] + 1_000, cpuSec: 53.25 }), // 5 %
    ]
    const [s] = A.summarizeByRole(rows, { roleOf: () => 'shell' })
    expect(s.processes).toBe(2)
    expect(s.intervals).toBe(3)
    // 10 %, nothing for the interval the new process started in, 5 %. Read as
    // one process, the middle interval would be 2.5 s / 5 s = 50 %.
    expect(s.cpuMean).toBeCloseTo(5, 6)
    expect(s.cpuMax).toBeCloseTo(10, 6)
    expect(A.cpuPercent(rows[1], rows[2])).toBeNull()
  })

  it('sums the processes of one role per interval and per tick', () => {
    const rows = [0, 1, 2].flatMap((k) => [
      row({ t: ticks[k], pid: 501, created: 10, cpuSec: 1 + k * 0.5, privateBytes: 30 * 1024 * 1024 }),
      row({ t: ticks[k], pid: 502, created: 11, cpuSec: 2 + k * 0.25, privateBytes: 10 * 1024 * 1024 }),
    ])
    const [s] = A.summarizeByRole(rows, { roleOf: () => 'fake-claude' })
    expect(s.processes).toBe(2)
    expect(s.cpuMean).toBeCloseTo(15, 6) // 10 % + 5 %
    expect(s.privateMb).toBeCloseTo(40, 6)
  })
})

describe('real sample lines from the VM', () => {
  const lines = [
    JSON.stringify({ kind: 'header', tag: 'n1-idle', t: t0, samplerPid: 9001, intervalSec: 5, durationSec: 10, logicalCpus: 4, memMb: 8192 }),
    ...[0, 1, 2].flatMap((k) => [
      JSON.stringify({ kind: 'tick', t: t0 + k * 5_000, k, n: 5 }),
      JSON.stringify({ kind: 'p', t: t0 + k * 5_000, pid: 100, ppid: 4, name: 'AI Code Conductor.exe', created: t0 - 60_000, user: 20e7 + k * 4e6, kernel: 5e7 + k * 1e6, priv: 300 * 1024 * 1024, ws: 0, handles: 900, threads: 40, rops: 5_000 + k * 100, wops: 2_000 + k * 50, oops: 0, ...(k === 0 ? { cmd: CMD.main } : {}) }),
      JSON.stringify({ kind: 'p', t: t0 + k * 5_000, pid: 110, ppid: 100, name: 'AI Code Conductor.exe', created: t0 - 59_000, user: 30e7 + k * 1e7, kernel: 1e7, priv: 200 * 1024 * 1024, ws: 0, handles: 400, threads: 25, rops: 0, wops: 0, oops: 0, ...(k === 0 ? { cmd: CMD.renderer } : {}) }),
      JSON.stringify({ kind: 'p', t: t0 + k * 5_000, pid: 111, ppid: 100, name: 'AI Code Conductor.exe', created: t0 - 59_500, user: 1e7 + k * 2e6, kernel: 1e6, priv: 80 * 1024 * 1024, ws: 0, handles: 300, threads: 12, rops: 0, wops: 0, oops: 0, ...(k === 0 ? { cmd: CMD.gpu } : {}) }),
      JSON.stringify({ kind: 'p', t: t0 + k * 5_000, pid: 120, ppid: 100, name: 'AI Code Conductor.exe', created: t0 - 58_000, user: 2e7 + k * 1.5e6, kernel: 1e6, priv: 60 * 1024 * 1024, ws: 0, handles: 200, threads: 10, rops: 0, wops: 0, oops: 0, ...(k === 0 ? { cmd: CMD.utility } : {}) }),
      JSON.stringify({ kind: 'p', t: t0 + k * 5_000, pid: 130, ppid: 100, name: 'node.exe', created: t0 - 50_000, user: 1e7 + k * 5e5, kernel: 0, priv: 40 * 1024 * 1024, ws: 0, handles: 100, threads: 9, rops: 0, wops: 0, oops: 0, ...(k === 0 ? { cmd: CMD.fake } : {}) }),
    ]),
  ].join('\r\n')

  it('parses the header and rows, carries each command line, and splits the window by role', () => {
    const parsed = A.parseSampleText('\uFEFF' + lines)
    expect(parsed.header && parsed.header.logicalCpus).toBe(4)
    expect(parsed.rows).toHaveLength(15)
    const ctx = Cl.contextFrom({ appMetrics: [{ pid: 120, type: 'Utility', name: 'ccc-tokenomics' }], webContents: [{ pid: 110, url: 'file:///C:/x/resources/app.asar/out/renderer/index.html' }] })
    const roles = A.summarizeByRole(parsed.rows, { roleOf: (r) => Cl.classifyProcess(r, ctx) })
    const cpu = Object.fromEntries(roles.map((r) => [r.role, r.cpuMean]))
    expect(cpu.main).toBeCloseTo(10, 6) // 0.5 s per 5 s
    expect(cpu.renderer).toBeCloseTo(20, 6)
    expect(cpu.gpu).toBeCloseTo(4, 6)
    expect(cpu['utility:ccc-tokenomics']).toBeCloseTo(3, 6)
    expect(cpu['fake-claude']).toBeCloseTo(1, 6)
    expect(roles.find((r) => r.role === 'main')!.ioOpsPerSec).toBeCloseTo(30, 6)
  })
})

describe("CPU from the app's own process figures", () => {
  // Two app.getAppMetrics snapshots 60 s apart (cumulative CPU seconds), as main-inspector takes them.
  const snap = (t: number, list: Array<[number, string, string | null, number, number]>) => ({ t, appMetrics: list.map(([pid, type, name, creationTime, cpuSec]) => ({ pid, type, name, creationTime, cpuSec })) })
  const a = snap(t0, [[100, 'Browser', null, 1_000.25, 3], [110, 'Tab', null, 1_100.5, 12], [120, 'Utility', 'ccc-tokenomics', 1_200, 1], [121, 'Utility', 'ccc-transcripts', 1_210, 1], [130, 'Utility', 'ccc-hooks-gateway', 1_300, 2]])
  const b = snap(t0 + 60_000, [
    [100, 'Browser', null, 1_000.25, 3.6], // 0.6 s in 60 s: 1 %
    [110, 'Tab', null, 1_100.5, 16.8], // 4.8 s: 8 %
    [120, 'Utility', 'ccc-tokenomics', 1_200, 1.12], // 0.12 s: 0.2 %
    [121, 'Utility', 'ccc-transcripts', 1_210, 1.06], // 0.06 s: 0.1 %
    [130, 'Utility', 'ccc-hooks-gateway', 59_000, 2.9], // restarted between the snapshots (same pid, new start time): left out, not read as +0.9 s
    [140, 'Utility', 'ccc-other', 30_000, 9], // started between the snapshots: left out
  ])
  const roleOf = (m: { type: string; name?: string }) => (m.type === 'Browser' ? 'main' : m.type === 'Tab' ? 'renderer' : m.name === 'ccc-transcripts' ? 'logging' : m.name === 'ccc-tokenomics' ? 'logging' : m.name || null)

  it('is the cumulative CPU between the snapshots over the time between them, summed per role', () => {
    const cpu = A.appCpuByRole(a, b, roleOf)
    expect(cpu.get('main')).toBeCloseTo(1, 6)
    expect(cpu.get('renderer')).toBeCloseTo(8, 6)
    expect(cpu.get('logging')).toBeCloseTo(0.3, 6)
  })

  it('leaves out a process that started, or restarted with the same pid, between the snapshots', () => {
    const cpu = A.appCpuByRole(a, b, roleOf)
    expect(cpu.has('ccc-hooks-gateway')).toBe(false)
    expect(cpu.has('ccc-other')).toBe(false)
  })

  it('reads nothing from a failed snapshot or no time between them', () => {
    expect(A.appCpuByRole({ error: 'no inspector' }, b, roleOf).size).toBe(0)
    expect(A.appCpuByRole(a, { ...a }, roleOf).size).toBe(0)
  })
})

describe('the renderer between two Performance.getMetrics readings', () => {
  it('reads the renderer main thread busy share from TaskDuration over Timestamp', () => {
    const a = [{ name: 'Timestamp', value: 1000 }, { name: 'TaskDuration', value: 10 }, { name: 'ScriptDuration', value: 4 }, { name: 'LayoutCount', value: 100 }, { name: 'RecalcStyleCount', value: 50 }, { name: 'LayoutDuration', value: 1 }, { name: 'RecalcStyleDuration', value: 1 }]
    const b = [{ name: 'Timestamp', value: 1060 }, { name: 'TaskDuration', value: 22 }, { name: 'ScriptDuration', value: 7 }, { name: 'LayoutCount', value: 160 }, { name: 'RecalcStyleCount', value: 650 }, { name: 'LayoutDuration', value: 1.6 }, { name: 'RecalcStyleDuration', value: 2.2 }, { name: 'JSHeapUsedSize', value: 50 * 1024 * 1024 }]
    const d = A.perfMetricsDelta(a, b)!
    expect(d.wallSec).toBe(60)
    expect(d.taskBusyPct).toBeCloseTo(20, 6)
    expect(d.scriptBusyPct).toBeCloseTo(5, 6)
    expect(d.layoutsPerSec).toBeCloseTo(1, 6)
    expect(d.recalcStylesPerSec).toBeCloseTo(10, 6)
    expect(d.recalcStyleMsPerSec).toBeCloseTo(20, 6)
    expect(d.heapMb).toBeCloseTo(50, 6)
  })

  it('is null when no time passed between the readings', () => {
    expect(A.perfMetricsDelta([{ name: 'Timestamp', value: 5 }], [{ name: 'Timestamp', value: 5 }])).toBeNull()
  })
})

describe('the Markdown table', () => {
  it('escapes a pipe and prints a dash for a missing number', () => {
    const t = A.markdownTable([{ label: 'A', align: 'left', get: (r) => (r as { a: string }).a }, { label: 'B', get: (r) => (r as { b: number }).b }], [{ a: 'x|y', b: NaN }])
    expect(t.split('\n')).toEqual(['| A | B |', '| :-- | --: |', '| x\\|y | - |'])
  })
})
