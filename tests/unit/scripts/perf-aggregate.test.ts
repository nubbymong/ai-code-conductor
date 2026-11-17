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
type Row = { t: number; pid: number; ppid: number; name: string; created: number; cpuSec: number; cycles?: number; tc?: number; privateBytes: number; workingSet: number; handles: number; threads: number; ioOps: number; cmd?: string }
type RoleSummary = { role: string; processes: number; minConcurrent: number; maxConcurrent: number; intervals: number; cpuMean: number | null; cpuP95: number | null; cpuMax: number | null; cpuSource: string | null; cpuTickMean: number | null; privateMb: number | null; workingSetMb: number | null; ioOpsPerSec: number | null; handles: number | null; threads: number | null }
const A = req('./lib/aggregate.cjs') as {
  normalizeRow: (raw: Record<string, unknown>) => Row
  parseSampleText: (text: string) => { header: Record<string, unknown> | null; ticks: Array<Record<string, unknown>>; rows: Row[] }
  cpuPercent: (prev: Row, cur: Row) => number | null
  cpuSample: (prev: Row, cur: Row, cyclesPerSec: number | null) => { pct: number; source: string } | null
  functionTimes: (profile: unknown, names: string[]) => { totalMs: number; byName: Record<string, { selfMs: number; inclusiveMs: number }> }
  ratePerSec: (a: number, b: number, dtMs: number) => number | null
  percentile: (values: number[], p: number) => number | null
  summarizeByRole: (rows: Row[], o: { from?: number; to?: number; roleOf: (r: Row) => string | null; cyclesPerSec?: number | null }) => RoleSummary[]
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
  ppid: 1, name: 'AI Code Conductor.exe', created: 1_000, privateBytes: 100 * 1024 * 1024, workingSet: 0, handles: 500, threads: 20, ioOps: 0, ...o,
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

  it('takes the nearest rank upwards when it falls between two values', () => {
    // 0.95 x 21 = 19.95: the 20th smallest (rounding down would give the 19th).
    expect(A.percentile(Array.from({ length: 21 }, (_, i) => i + 1), 95)).toBe(20)
    // 0.95 x 31 = 29.45: the 30th smallest (rounding to the nearest would give the 29th).
    expect(A.percentile(Array.from({ length: 31 }, (_, i) => i + 1), 95)).toBe(30)
    expect(A.percentile([7], 95)).toBe(7)
    expect(A.percentile([], 95)).toBeNull()
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
    expect(s.workingSetMb).toBeCloseTo(0, 6)
    expect(s.handles).toBeCloseTo(1_000, 6) // 500 + 500 per tick
    expect(s.threads).toBeCloseTo(40, 6)
    expect([s.minConcurrent, s.maxConcurrent]).toEqual([2, 2])
  })

  it('counts how many of a role ran at once, fewest and most over the ticks', () => {
    // pid 601 runs throughout; 602 only at ticks 1 and 2; 603 only at tick 2.
    const rows = [
      row({ t: ticks[0], pid: 601, cpuSec: 1 }), row({ t: ticks[1], pid: 601, cpuSec: 1 }), row({ t: ticks[2], pid: 601, cpuSec: 1 }),
      row({ t: ticks[1], pid: 602, cpuSec: 1 }), row({ t: ticks[2], pid: 602, cpuSec: 1 }),
      row({ t: ticks[2], pid: 603, cpuSec: 1 }),
    ]
    const [s] = A.summarizeByRole(rows, { roleOf: () => 'fake-claude' })
    expect(s.processes).toBe(3) // distinct over the window...
    expect([s.minConcurrent, s.maxConcurrent]).toEqual([1, 3]) // ...but never three at once until the last tick
  })
})

describe('sample lines with real VM command lines', () => {
  const lines = [
    JSON.stringify({ kind: 'header', tag: 'n1-idle', t: t0, samplerPid: 9001, intervalSec: 5, durationSec: 10, logicalCpus: 4, memMb: 8192 }),
    ...[0, 1, 2].flatMap((k) => [
      JSON.stringify({ kind: 'tick', t: t0 + k * 5_000, k, n: 5, queryMs: 10 + k }),
      JSON.stringify({ kind: 'p', t: t0 + k * 5_000, pid: 100, ppid: 4, name: 'AI Code Conductor.exe', created: t0 - 60_000, user: 20e7 + k * 4e6, kernel: 5e7 + k * 1e6, priv: 300 * 1024 * 1024, ws: 0, handles: 900, threads: 40, rops: 5_000 + k * 100, wops: 2_000 + k * 50, ...(k === 0 ? { cmd: CMD.main } : {}) }),
      JSON.stringify({ kind: 'p', t: t0 + k * 5_000, pid: 110, ppid: 100, name: 'AI Code Conductor.exe', created: t0 - 59_000, user: 30e7 + k * 1e7, kernel: 1e7, priv: 200 * 1024 * 1024, ws: 0, handles: 400, threads: 25, rops: 0, wops: 0, ...(k === 0 ? { cmd: CMD.renderer } : {}) }),
      JSON.stringify({ kind: 'p', t: t0 + k * 5_000, pid: 111, ppid: 100, name: 'AI Code Conductor.exe', created: t0 - 59_500, user: 1e7 + k * 2e6, kernel: 1e6, priv: 80 * 1024 * 1024, ws: 0, handles: 300, threads: 12, rops: 0, wops: 0, ...(k === 0 ? { cmd: CMD.gpu } : {}) }),
      JSON.stringify({ kind: 'p', t: t0 + k * 5_000, pid: 120, ppid: 100, name: 'AI Code Conductor.exe', created: t0 - 58_000, user: 2e7 + k * 1.5e6, kernel: 1e6, priv: 60 * 1024 * 1024, ws: 0, handles: 200, threads: 10, rops: 0, wops: 0, ...(k === 0 ? { cmd: CMD.utility } : {}) }),
      JSON.stringify({ kind: 'p', t: t0 + k * 5_000, pid: 130, ppid: 100, name: 'node.exe', created: t0 - 50_000, user: 1e7 + k * 5e5, kernel: 0, priv: 40 * 1024 * 1024, ws: 0, handles: 100, threads: 9, rops: 0, wops: 0, ...(k === 0 ? { cmd: CMD.fake } : {}) }),
    ]),
  ].join('\r\n')

  it('parses the header and rows, carries each command line, and splits the window by role', () => {
    const parsed = A.parseSampleText('\uFEFF' + lines)
    expect(parsed.header && parsed.header.logicalCpus).toBe(4)
    expect(parsed.rows).toHaveLength(15)
    // Each tick says how long the process query took (the report prints its mean).
    expect(parsed.ticks.map((t) => t.queryMs)).toEqual([10, 11, 12])
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

describe('CPU from the cycle counts', () => {
  // The sampler's cycle counter runs at 3 GHz here; Windows' ticks see much
  // less of a process that runs in short bursts.
  const HZ = 3e9
  const at = (k: number) => t0 + k * 5_000
  // 0.25 s of CPU per 5 s interval by cycles (5 %), while the tick-charged
  // time moves only 0.05 s (1 %); the cycle count is read 20 ms after the
  // row's own time.
  const burst = (pid: number, n: number, o: Partial<Row> = {}) => Array.from({ length: n }, (_, k) => row({ t: at(k), pid, cpuSec: 10 + k * 0.05, cycles: 1e12 + k * 0.25 * HZ, tc: at(k) + 20, ...o }))

  it('prefers the cycles over the ticks for an interval whose two samples have them', () => {
    const [a, b] = burst(700, 2)
    expect(A.cpuSample(a, b, HZ)).toEqual({ pct: expect.closeTo(5, 6), source: 'cycles' })
    expect(A.cpuSample(a, b, null)).toEqual({ pct: expect.closeTo(1, 6), source: 'windows' })
    expect(A.cpuSample(a, { ...b, cycles: NaN }, HZ)).toEqual({ pct: expect.closeTo(1, 6), source: 'windows' })
  })

  it('times the cycles by when they were read, not by the row', () => {
    const [a, b] = burst(701, 2)
    // The second count read 1 s later than its row: the same cycles over 6 s, not 5.
    expect(A.cpuSample(a, { ...b, tc: b.tc! + 1_000 }, HZ)!.pct).toBeCloseTo((0.25 / 6) * 100, 6)
  })

  it('is null across a pid reuse or a cycle count that went back', () => {
    const [a, b] = burst(702, 2)
    expect(A.cpuSample(a, { ...b, created: b.created + 1 }, HZ)).toBeNull()
    expect(A.cpuSample(a, { ...b, cycles: a.cycles! - 1 }, HZ)).toBeNull()
  })

  it('gives the mean and the p95 from the cycles, says so, and keeps the tick mean beside them', () => {
    const [s] = A.summarizeByRole(burst(703, 5), { roleOf: () => 'renderer', cyclesPerSec: HZ })
    expect(s.cpuSource).toBe('cycles')
    expect(s.cpuMean).toBeCloseTo(5, 6)
    expect(s.cpuP95).toBeCloseTo(5, 6)
    expect(s.cpuTickMean).toBeCloseTo(1, 6)
  })

  it('says windows without the counter rate, and mixed when only some intervals had cycles', () => {
    expect(A.summarizeByRole(burst(704, 5), { roleOf: () => 'renderer' })[0].cpuSource).toBe('windows')
    const rows = burst(705, 5)
    rows[4] = { ...rows[4], cycles: NaN }
    const [s] = A.summarizeByRole(rows, { roleOf: () => 'renderer', cyclesPerSec: HZ })
    expect(s.cpuSource).toBe('mixed')
    expect(s.cpuMean).toBeCloseTo((3 * 5 + 1) / 4, 6)
  })

  it('reads a sample line with a cycle count', () => {
    const r = A.normalizeRow({ kind: 'p', t: t0, pid: 9, ppid: 1, name: 'x.exe', created: 5, user: 0, kernel: 0, cyc: 123456789, tc: t0 + 7 })
    expect([r.cycles, r.tc]).toEqual([123456789, t0 + 7])
    expect(Number.isNaN(A.normalizeRow({ kind: 'p', t: t0, pid: 9 }).cycles)).toBe(true)
  })
})

describe('named functions in a CPU profile', () => {
  const f = (functionName: string) => ({ functionName, url: 'x.js', lineNumber: 1, columnNumber: 0, scriptId: '1' })
  // root > App > RateLimitBar > formatResetTime; RateLimitBar > RateLimitBar (a nested one) > formatResetTime; root > idle
  const profile = {
    nodes: [
      { id: 1, callFrame: f('(root)'), children: [2, 9] },
      { id: 2, callFrame: f('App'), children: [3] },
      { id: 3, callFrame: f('RateLimitBar'), children: [4, 5] },
      { id: 4, callFrame: f('formatResetTime'), children: [] },
      { id: 5, callFrame: f('RateLimitBar'), children: [6] },
      { id: 6, callFrame: f('formatResetTime'), children: [] },
      { id: 9, callFrame: f('(idle)'), children: [] },
    ],
    samples: [4, 4, 3, 6, 9, 2, 9],
    timeDeltas: [0, 1000, 1000, 1000, 1000, 1000, 1000],
  }

  it('reports self time and inclusive time, counting a recursive name once per sample', () => {
    const r = A.functionTimes(profile, ['RateLimitBar', 'formatResetTime', 'Missing'])
    expect(r.totalMs).toBeCloseTo(6, 6)
    expect(r.byName.formatResetTime).toEqual({ selfMs: expect.closeTo(3, 6), inclusiveMs: expect.closeTo(3, 6) })
    // samples 4, 4, 3, 6 are under RateLimitBar (6 under it twice); 3 is its own frame.
    expect(r.byName.RateLimitBar).toEqual({ selfMs: expect.closeTo(1, 6), inclusiveMs: expect.closeTo(4, 6) })
    expect(r.byName.Missing).toEqual({ selfMs: 0, inclusiveMs: 0 })
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
  const roleOf = (m: { type: string; name?: string }) => (m.type === 'Browser' ? 'main' : m.type === 'Tab' ? 'renderer' : m.name === 'ccc-transcripts' ? 'logging' : m.name === 'ccc-tokenomics' ? 'tokenomics' : m.name || null)

  it('is the cumulative CPU between the snapshots over the time between them, per role', () => {
    const cpu = A.appCpuByRole(a, b, roleOf)
    expect(cpu.get('main')).toBeCloseTo(1, 6)
    expect(cpu.get('renderer')).toBeCloseTo(8, 6)
    expect(cpu.get('tokenomics')).toBeCloseTo(0.2, 6)
    expect(cpu.get('logging')).toBeCloseTo(0.1, 6)
  })

  it('sums the processes of one role', () => {
    const both = (m: { type: string; name?: string }) => (m.type === 'Utility' && m.name !== 'ccc-hooks-gateway' && m.name !== 'ccc-other' ? 'workers' : roleOf(m))
    expect(A.appCpuByRole(a, b, both).get('workers')).toBeCloseTo(0.3, 6) // 0.2 % + 0.1 %
  })

  it('leaves out a process whose figure went back (read as no figure, not as a negative share)', () => {
    const back = snap(t0 + 60_000, [[100, 'Browser', null, 1_000.25, 2.4], [110, 'Tab', null, 1_100.5, 16.8]])
    const cpu = A.appCpuByRole(a, back, roleOf)
    expect(cpu.has('main')).toBe(false)
    expect(cpu.get('renderer')).toBeCloseTo(8, 6)
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
