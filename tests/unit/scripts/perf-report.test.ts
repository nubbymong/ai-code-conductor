/**
 * [host] The performance harness's report logic (scripts/perf/report.cjs):
 * which CPU figure a cell shows and where it came from (the sampler's cycle
 * counts, the app's own figure, or Windows' tick-charged time, marked), the
 * group totals without counting a role twice, which sampled processes are the
 * app's, the reduced-motion A/B/A parts cut at their switches (the app's
 * figures from the marks, a failed mark falling back with its source said),
 * the ablations read against the spread of their all-on windows (every run's
 * together, and no verdict from fewer than three windows), the runs
 * that failed, the estimated Tokenomics sweeps, main's profile split and the
 * spread of a grid run twice.
 *
 * Pure functions on in-memory data: nothing is read, written or started.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { join, resolve } from 'path'

const PERF = resolve(__dirname, '..', '..', '..', 'scripts', 'perf')
const req = createRequire(join(PERF, 'report.cjs'))
type Cpu = { value: number | null; source: string | null }
type Role = { role: string; cpuMean: number | null; cpuSource: string | null; [k: string]: unknown }
type Cell = { tag: string; kind?: string | null; off?: string; n?: number; roles: Role[]; appCpu: Record<string, number> }
const R = req('./report.cjs') as {
  groupOf: (role: string) => string | null
  cpuOf: (cell: Cell, role: string) => Cpu
  groupCpu: (cell: Cell, group: string) => { value: number; sources: string[] }
  markCpu: (c: Cpu) => string
  markGroup: (g: { value: number; sources: string[] }) => string
  roleFunction: (parsed: unknown, ctx: Record<string, unknown>, record: Record<string, unknown>, runRec: Record<string, unknown>) => (row: Record<string, unknown>) => string | null
  abParts: (ab: Record<string, unknown>, parsed: unknown, ctx: Record<string, unknown>, record: Record<string, unknown>, runRec: Record<string, unknown>) => Array<{ name: string; rendererCpu: Cpu; gpuCpu: Cpu; mainCpu: Cpu; valid: boolean }>
  ablationSummary: (cells: Cell[]) => { refMean: number; spread: number | null; enough: boolean; rows: Array<{ cell: Cell; saved: number | null; aboveNoise: boolean | null }> } | null
  pooledAblation: (runs: Cell[][]) => { totals: number[]; refMean: number; spread: number | null; enough: boolean; rows: Array<{ off: string; runs: Array<{ value: number } | null>; mean: number; saved: number; aboveNoise: boolean | null }> } | null
  verdictWord: (row: { saved: number | null; aboveNoise: boolean | null }) => string
  failedRuns: (record: Record<string, unknown>) => Array<{ id: string; windows: number; errors: string[] }>
  expectedSweeps: (appStartedAt: number, from: number, to: number) => Array<{ k: number; earliest: number; latest: number; where: string }>
  mainProfileSplit: (p: Record<string, unknown>) => { busyMs: number; servicesPct: number; gcPct: number; programPct: number; unattributedPct: number }
  repeatSpread: (runs: Cell[][]) => { tags: string[]; rows: Array<{ label: string; byTag: Record<string, { values: number[]; mean: number; spread: number | null }> }> }
}
const C = req('./lib/classify-process.cjs') as { contextFrom: (o: Record<string, unknown>) => Record<string, unknown> }
const A = req('./lib/aggregate.cjs') as { normalizeRow: (raw: Record<string, unknown>) => Record<string, unknown> }

const role = (r: string, cpuMean: number | null, cpuSource: string | null): Role => ({ role: r, cpuMean, cpuSource })

describe('the CPU a cell shows, and where it came from', () => {
  const cell: Cell = {
    tag: 'n25-busy',
    roles: [role('renderer', 30, 'cycles'), role('main', 1.5, 'windows'), role('gpu', 4, 'mixed'), role('pty-host', 0.1, 'windows'), role('fake-claude', 2, 'cycles')],
    appCpu: { renderer: 29, main: 7.5, 'utility:ccc-tokenomics': 0.6 },
  }

  it('takes the cycle counts when every interval had them', () => {
    expect(R.cpuOf(cell, 'renderer')).toEqual({ value: 30, source: 'cycles' })
    expect(R.cpuOf(cell, 'fake-claude')).toEqual({ value: 2, source: 'cycles' })
  })

  it("falls back to the app's figure for its own processes, and says so", () => {
    expect(R.cpuOf(cell, 'main')).toEqual({ value: 7.5, source: 'app' })
    // Some intervals without cycles: not a cycle figure.
    expect(R.cpuOf({ ...cell, appCpu: { gpu: 4.4 } }, 'gpu')).toEqual({ value: 4.4, source: 'app' })
    // Only in the app's figures (no sample row).
    expect(R.cpuOf(cell, 'utility:ccc-tokenomics')).toEqual({ value: 0.6, source: 'app' })
  })

  it("falls back to Windows' ticks, and says so, where the app has no figure", () => {
    expect(R.cpuOf(cell, 'pty-host')).toEqual({ value: 0.1, source: 'windows' })
    // A failed snapshot leaves no app figure: the Electron role is then Windows', marked as such.
    expect(R.cpuOf({ ...cell, appCpu: {} }, 'main')).toEqual({ value: 1.5, source: 'windows' })
    expect(R.cpuOf(cell, 'vision-chrome')).toEqual({ value: null, source: null })
  })

  it('marks every cell that is not from the cycle counts', () => {
    expect(R.markCpu({ value: 30, source: 'cycles' })).toBe('30.00')
    expect(R.markCpu({ value: 7.5, source: 'app' })).toBe('7.50 a')
    expect(R.markCpu({ value: 0.1, source: 'windows' })).toBe('0.10 w')
    expect(R.markCpu({ value: null, source: null })).toBe('-')
  })

  it('sums a group over its roles, each once, and lists the sources in the sum', () => {
    // app: renderer 30 (cycles) + main 7.5 (app) + gpu 4 (Windows, no app figure) + tokenomics 0.6 (app only).
    const app = R.groupCpu(cell, 'app')
    expect(app.value).toBeCloseTo(42.1, 6)
    expect(app.sources).toEqual(['app', 'cycles', 'windows'])
    expect(R.markGroup(app)).toBe('42.10 a w')
    const terminals = R.groupCpu(cell, 'terminals')
    expect(terminals.value).toBeCloseTo(2.1, 6)
    expect(R.markGroup(terminals)).toBe('2.10 w')
    expect(R.groupOf('wmi')).toBeNull()
    expect(R.groupOf('node')).toBe('terminals')
  })
})

describe("which sampled processes are the app's", () => {
  const STAGE = 'C:\\Users\\User\\b7p-run'
  const APP = 'C:\\Programs\\AI Code Conductor\\AI Code Conductor.exe'
  const HELPER = 'C:\\Programs\\AI Code Conductor\\resources\\helper\\aicc-helper.exe'
  const p = (pid: number, ppid: number, name: string, created: number, cmd: string) => A.normalizeRow({ kind: 'p', t: 1, pid, ppid, name, created, user: 0, kernel: 0, cmd })
  const parsed = {
    header: { samplerPid: 9001 },
    rows: [
      p(100, 4, 'AI Code Conductor.exe', 1_000, `"${APP}" --user-data-dir=${STAGE}\\data\\electron-userdata`),
      p(110, 100, 'AI Code Conductor.exe', 1_100, `"${APP}" --type=renderer`),
      p(900, 100, 'node.exe', 500, 'node old.js'), // its parent id is 100 from before the app started
      p(300, 4, 'aicc-helper.exe', 2_000, `"${HELPER}" hold --store ${STAGE}\\data\\home\\AppData\\Local\\aicc-helper\\store --session 1`),
      p(301, 4, 'aicc-helper.exe', 2_000, `"${HELPER}" hold --store C:\\Users\\User\\AppData\\Local\\aicc-helper\\store --session 2`),
      p(5, 4, 'MsMpEng.exe', 10, ''),
      p(6, 4, 'WmiPrvSE.exe', 10, 'C:\\Windows\\system32\\wbem\\wmiprvse.exe'),
      p(400, 4, 'chrome.exe', 2_500, `"chrome.exe" --user-data-dir=${STAGE}\\data\\tmp\\chrome-debug-9222 --headless=new`),
      p(401, 4, 'chrome.exe', 2_500, '"chrome.exe" --type=renderer'),
      p(9001, 4, 'powershell.exe', 3_000, 'powershell -File sample-processes.ps1'),
      p(9002, 4, 'node.exe', 3_000, 'node run-matrix.cjs'),
    ],
  }
  const roleOf = R.roleFunction(parsed, C.contextFrom({ stageRoot: STAGE }), { stageRoot: STAGE, harnessPids: [9002] }, { appPid: 100 })
  const of = (pid: number) => roleOf(parsed.rows.find((r) => r.pid === pid)!)

  it('keeps the app tree and drops a process whose parent id is stale', () => {
    expect([of(100), of(110), of(900)]).toEqual(['main', 'renderer', null])
  })

  it("keeps the staging root's own helper and vision browser, not another install's or another Chrome", () => {
    expect([of(300), of(301), of(400), of(401)]).toEqual(['helper-hold', null, 'vision-chrome', null])
  })

  it('always keeps Defender, WMI and the harness (by pid)', () => {
    expect([of(5), of(6), of(9001), of(9002)]).toEqual(['defender', 'wmi', 'harness', 'harness'])
  })
})

describe('the reduced-motion A/B/A parts', () => {
  const t0 = 1_763_330_000_000
  const HZ = 1e9
  const APP = 'C:\\Programs\\AI Code Conductor\\AI Code Conductor.exe'
  // The renderer at 10 % before the first switch, 4 % while reduced, 10 % again after the second;
  // ticks every 5 s, the switches half way between two ticks.
  const ticks = Array.from({ length: 14 }, (_, k) => t0 + k * 5_000)
  const switchAt = t0 + 22_500
  const backAt = t0 + 42_500
  const rate = (t: number) => (t <= switchAt ? 0.1 : t <= backAt ? 0.04 : 0.1)
  let cyc = 0
  const rows = ticks.flatMap((t, k) => {
    if (k > 0) cyc += rate(t) * 5 * HZ
    return [
      A.normalizeRow({ kind: 'p', t, pid: 100, ppid: 4, name: 'AI Code Conductor.exe', created: 1_000, user: 0, kernel: 0, cyc: 1e9, tc: t, ...(k === 0 ? { cmd: `"${APP}"` } : {}) }),
      A.normalizeRow({ kind: 'p', t, pid: 110, ppid: 100, name: 'AI Code Conductor.exe', created: 1_100, user: k * 1e5, kernel: 0, cyc, tc: t, ...(k === 0 ? { cmd: `"${APP}" --type=renderer` } : {}) }),
    ]
  })
  const metrics = (busy: number) => ({ start: { metrics: [{ name: 'Timestamp', value: 0 }, { name: 'TaskDuration', value: 0 }] }, end: { metrics: [{ name: 'Timestamp', value: 20 }, { name: 'TaskDuration', value: busy }] } })
  // The app's own figures at each mark (cumulative CPU seconds of the renderer).
  const mark = (t: number, cpuSec: number) => ({ t, appMetrics: [{ pid: 100, type: 'Browser', creationTime: 1_000, cpuSec: 1 }, { pid: 110, type: 'Tab', creationTime: 1_100, cpuSec }] })
  const marks = { start: mark(t0, 0), switch: mark(switchAt, 2.25), back: mark(backAt, 3.05), end: mark(t0 + 65_000, 5.3) }
  const ab = { from: t0, switchAt, backAt, to: t0 + 65_000, result: { reduceMatched: true, asIs: metrics(4), reduced: metrics(2), asIs2: metrics(4), marks } }
  const ctx = C.contextFrom({})
  const record = { stageRoot: 'C:\\x' }

  it('cuts each part at its switches: an interval that spans one belongs to neither', () => {
    const parts = R.abParts(ab, { header: { cyclesPerSec: HZ }, rows }, ctx, record, { appPid: 100 })
    expect(parts.map((x) => x.name)).toEqual(['as is', 'reduced', 'as is again'])
    // Read across a switch, a part would mix 10 % and 4 %.
    expect(parts[0].rendererCpu).toEqual({ value: expect.closeTo(10, 6), source: 'cycles' })
    expect(parts[1].rendererCpu).toEqual({ value: expect.closeTo(4, 6), source: 'cycles' })
    expect(parts[2].rendererCpu).toEqual({ value: expect.closeTo(10, 6), source: 'cycles' })
    expect(parts.every((x) => x.valid)).toBe(true)
  })

  it("takes each part's app figure from the marks around it when the samples have no cycle counts", () => {
    const noCycles = rows.map((r) => ({ ...r, cycles: NaN }))
    const parts = R.abParts(ab, { header: {}, rows: noCycles }, ctx, record, { appPid: 100 })
    // 2.25 s over 22.5 s, 0.8 s over 20 s, 2.25 s over 22.5 s.
    expect(parts.map((x) => x.rendererCpu)).toEqual([{ value: expect.closeTo(10, 6), source: 'app' }, { value: expect.closeTo(4, 6), source: 'app' }, { value: expect.closeTo(10, 6), source: 'app' }])
  })

  it("falls back to Windows' figure, and says so, when a mark failed", () => {
    const failed = { ...ab, result: { ...ab.result, marks: { ...marks, switch: { error: 'inspector gone' } } } }
    const parts = R.abParts(failed, { header: {}, rows: rows.map((r) => ({ ...r, cycles: NaN })) }, ctx, record, { appPid: 100 })
    expect(parts[0].rendererCpu.source).toBe('windows')
    expect(parts[1].rendererCpu.source).toBe('windows')
    expect(parts[2].rendererCpu.source).toBe('app')
  })

  it('marks the reduced part not valid when the page did not take the emulation, and reads an older two-part record', () => {
    const parts = R.abParts({ ...ab, result: { ...ab.result, reduceMatched: false } }, { header: { cyclesPerSec: HZ }, rows }, ctx, record, { appPid: 100 })
    expect(parts[1].valid).toBe(false)
    const old = R.abParts({ from: t0, switchAt, to: t0 + 45_000, result: { reduceMatched: true, asIs: metrics(4), reduced: metrics(2) } }, { header: { cyclesPerSec: HZ }, rows }, ctx, record, { appPid: 100 })
    expect(old.map((x) => x.name)).toEqual(['as is', 'reduced'])
  })
})

describe('the ablations, read against their all-on windows', () => {
  const cell = (tag: string, off: string, renderer: number, kind: string | undefined = 'ablation'): Cell => ({ tag, kind, off, n: 25, roles: [role('renderer', renderer, 'cycles')], appCpu: {} })
  const cells = [
    cell('n25-busy', 'none', 99, 'grid'), // a grid window, not an ablation
    cell('n25-busy-off-none', 'none', 40),
    cell('n25-busy-off-tokenomics', 'tokenomics', 39),
    cell('n25-busy-off-logging', 'logging', 37.5),
    cell('n25-busy-off-hooks', 'hooks', 40.5),
    cell('n25-busy-off-none-again', 'none', 42),
    cell('n25-busy-off-none-third', 'none', 41),
  ]

  it('takes the mean of the all-on windows as the reference and their spread as the noise', () => {
    const s = R.ablationSummary(cells)!
    expect(s.refMean).toBeCloseTo(41, 6)
    expect(s.spread).toBeCloseTo(2, 6)
    expect(s.enough).toBe(true)
    const by = Object.fromEntries(s.rows.filter((r) => r.cell.off !== 'none').map((r) => [r.cell.off, r]))
    expect(by.tokenomics.saved).toBeCloseTo(2, 6)
    expect(by.tokenomics.aboveNoise).toBe(false) // not larger than the spread
    expect(by.logging.saved).toBeCloseTo(3.5, 6)
    expect(by.logging.aboveNoise).toBe(true)
    expect(by.hooks.aboveNoise).toBe(false)
    expect(s.rows).toHaveLength(6)
    expect([R.verdictWord(by.tokenomics), R.verdictWord(by.logging), R.verdictWord(by.hooks)]).toEqual(['no', 'yes', 'no'])
    expect(R.verdictWord({ saved: -3.5, aboveNoise: true })).toBe('yes (it cost more off)')
    expect(R.verdictWord(s.rows.find((r) => r.cell.off === 'none')!)).toBe('-')
  })

  // The VM's two runs (installed 2.1.3-beta.6, harness 1588c81b): the all-on windows' app totals,
  // 35.29 and 35.25 in run 1, 34.57 and 33.26 in run 2. Run 1's Tokenomics-off window, 34.71, saves
  // 0.56 against run 1's own two, which agree within 0.04 by chance.
  const run1 = [cell('n25-busy-off-none', 'none', 35.29), cell('n25-busy-off-tokenomics', 'tokenomics', 34.71), cell('n25-busy-off-none-again', 'none', 35.25)]
  const run2 = [cell('n25-busy-off-none', 'none', 34.57), cell('n25-busy-off-tokenomics', 'tokenomics', 33.355), cell('n25-busy-off-none-again', 'none', 33.26)]

  it("gives no verdict from one run's two all-on windows: too few for a noise figure", () => {
    const s = R.ablationSummary(run1)!
    expect(s.spread).toBeCloseTo(0.04, 6)
    expect(s.enough).toBe(false)
    const tok = s.rows.find((r) => r.cell.off === 'tokenomics')!
    expect(tok.saved).toBeCloseTo(0.56, 6)
    expect(tok.aboveNoise).toBeNull()
    expect(R.verdictWord(tok)).toBe('too few all-on windows for a noise figure')
  })

  it("reads several runs' savings against every run's all-on windows together: 0.56 against a spread of 2.03 is no", () => {
    const p = R.pooledAblation([run1, run2])!
    expect(p.totals).toEqual([35.29, 35.25, 34.57, 33.26])
    expect(p.refMean).toBeCloseTo(34.5925, 6)
    expect(p.spread).toBeCloseTo(2.03, 6)
    expect(p.enough).toBe(true)
    expect(p.rows).toHaveLength(1)
    const tok = p.rows[0]
    expect(tok.off).toBe('tokenomics')
    expect(tok.runs.map((r) => r && r.value)).toEqual([34.71, 33.355])
    expect(tok.saved).toBeCloseTo(0.56, 6)
    expect(tok.aboveNoise).toBe(false)
    expect(R.verdictWord(tok)).toBe('no')
  })

  it('pools a service a run lacks from the runs that have it, and needs three all-on windows in all', () => {
    const p = R.pooledAblation([run1, [cell('n25-busy-off-none', 'none', 34.57), cell('n25-busy-off-none-again', 'none', 33.26), cell('n25-busy-off-logging', 'logging', 31)]])!
    const by = Object.fromEntries(p.rows.map((r) => [r.off, r]))
    expect(by.tokenomics.runs.map((r) => r && r.value)).toEqual([34.71, null])
    expect(by.tokenomics.mean).toBeCloseTo(34.71, 6)
    expect(by.logging.saved).toBeCloseTo(3.5925, 6)
    expect(R.verdictWord(by.logging)).toBe('yes')
    // Two runs of an older record, one all-on window each: two in all, no verdict.
    const two = R.pooledAblation([run1.slice(0, 2), run2.slice(0, 2)])!
    expect(two.enough).toBe(false)
    expect(two.rows[0].aboveNoise).toBeNull()
    expect(R.pooledAblation([[cell('n1-idle', 'none', 1, 'grid')]])).toBeNull()
  })

  it('has no noise figure with one all-on window, and reads an older record by its tags', () => {
    const old = cells.slice(0, 5).map((c) => ({ ...c, kind: undefined }))
    const s = R.ablationSummary(old)!
    expect(s.spread).toBeNull()
    expect(s.refMean).toBeCloseTo(40, 6)
    expect(s.rows.every((r) => r.aboveNoise === null)).toBe(true)
    expect(R.ablationSummary([cell('n1-idle', 'none', 1, 'grid')])).toBeNull()
  })
})

describe('the runs that failed', () => {
  it('lists a run with errors, a run with no window, and a planned run that never started', () => {
    const record = {
      plan: [{ id: 'n1' }, { id: 'n10' }, { id: 'n25' }, { id: 'n25-off-none' }],
      runs: [
        { id: 'n1', windows: [{}, {}], errors: [] },
        { id: 'n10', windows: [], errors: ['only 3 of 10 sessions started'] },
        { id: 'n25', windows: [], errors: [] },
      ],
    }
    expect(R.failedRuns(record)).toEqual([
      { id: 'n10', n: undefined, off: undefined, windows: 0, errors: ['only 3 of 10 sessions started'] },
      { id: 'n25', n: undefined, off: undefined, windows: 0, errors: [] },
      { id: 'n25-off-none', n: undefined, off: undefined, windows: 0, errors: ['not run'] },
    ])
  })
})

describe('the estimated Tokenomics sweeps', () => {
  const start = 1_000_000
  const s = (sec: number) => start + sec * 1000

  it('expects a walk about every 5 minutes from the start, with a growing slack', () => {
    // Window 330 s to 510 s after the start: walk 1 (300 to 325 s) ends before it.
    expect(R.expectedSweeps(start, s(330), s(510))).toEqual([])
    // Window 350 s to 530 s... walk 2 is at 600 s at the earliest: none.
    expect(R.expectedSweeps(start, s(350), s(530))).toEqual([])
    // Window 560 s to 740 s: walk 2 (600 to 630 s) inside.
    expect(R.expectedSweeps(start, s(560), s(740))).toEqual([{ k: 2, earliest: s(600), latest: s(630), where: 'in' }])
    // Window 610 s to 790 s: walk 2 may have begun just before it.
    expect(R.expectedSweeps(start, s(610), s(790)).map((x) => x.where)).toEqual(['edge'])
    expect(R.expectedSweeps(NaN, s(0), s(1))).toEqual([])
  })
})

describe("main's profile split", () => {
  it('gives services, garbage collection, native and not attributed as shares of the busy time', () => {
    const split = R.mainProfileSplit({ totalMs: 1_000, idleMs: 800, gcMs: 20, programMs: 40, unattributedMs: 20, byService: { statusline: 80, tokenomics: 40 } })
    expect(split.busyMs).toBe(200)
    expect([split.servicesPct, split.gcPct, split.programPct, split.unattributedPct]).toEqual([60, 10, 20, 10])
  })
})

describe('a grid run twice', () => {
  const cell = (tag: string, renderer: number, cli: number): Cell => ({ tag, roles: [role('renderer', renderer, 'cycles'), role('fake-claude', cli, 'cycles')], appCpu: {} })

  it('gives each cell the mean and spread of its runs, for the tags every run has', () => {
    const sp = R.repeatSpread([[cell('n1-idle', 1, 0.1), cell('n25-busy', 40, 2)], [cell('n1-idle', 1.4, 0.1), cell('n25-busy', 43, 2.5), cell('extra', 1, 1)]])
    expect(sp.tags).toEqual(['n1-idle', 'n25-busy'])
    const app = sp.rows.find((r) => r.label === 'App total')!
    expect(app.byTag['n25-busy']).toEqual({ values: [40, 43], mean: 41.5, spread: 3 })
    expect(app.byTag['n1-idle'].spread).toBeCloseTo(0.4, 6)
    expect(sp.rows.find((r) => r.label === 'Terminals total')!.byTag['n25-busy'].spread).toBeCloseTo(0.5, 6)
    expect(sp.rows.map((r) => r.label)).toContain('Renderer (app window)')
  })
})
