// 2.1.3-beta.4: the Tokenomics Services row carries its worker's process id
// and what the worker was measured to cost: its CPU share (from the app's
// process figures, sampled at most once in five seconds and only when the
// row is read) and the transcripts the last full pass found and looked at.
// With no worker, or Tokenomics off, there is no measured block.
//
// Host-safe. The worker is a fake transport and the app's process figures
// are made up: Electron's app.getAppMetrics() is never called here. The
// service case fakes the fork module, the settings and the paths.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TokenomicsSupervisor } from '../../../src/main/tokenomics/tk-supervisor'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'
import type { ForkedTkWorker } from '../../../src/main/tokenomics/fork-tokenomics-worker'
import type { ProcessCpuMetric } from '../../../src/main/services/process-cpu'
import { createServiceRegistry } from '../../../src/main/services/service-registry'
import type { ServiceHealth } from '../../../src/shared/service-health'

const logs = vi.hoisted(() => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/debug-logger', () => logs)

// The service case: the fork module gives a worker with a process id and the
// app's process figures, both made up here.
const app = vi.hoisted(() => ({ metrics: [] as unknown[], metricsCalls: 0, pid: 7001 as number | null }))
vi.mock('../../../src/main/tokenomics/fork-tokenomics-worker', async () => {
  const { FakeTkWorkerTransport: Fake } = await import('../../../src/main/tokenomics/tk-worker-transport')
  return {
    forkTokenomicsWorker: () => {
      const t = new Fake()
      t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: true, eventsTotal: 1 }) })
      return { transport: t, kill: () => t.kill(), onExit: () => {}, pid: () => app.pid }
    },
    appProcessMetrics: () => { app.metricsCalls++; return app.metrics },
  }
})
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: vi.fn(() => []),
  // No settings file yet: Tokenomics is on.
  readConfigChecked: vi.fn(() => ({ outcome: 'absent', value: null })),
}))
vi.mock('../../../src/main/data-paths', () => ({ getDataDirectory: () => 'F:\\data', getResourcesDirectory: () => 'F:\\resources' }))
vi.mock('../../../src/main/tokenomics/tk-pricing', () => ({ getAllPricing: () => ({}), fetchModelPricing: vi.fn(() => Promise.resolve()) }))
vi.mock('../../../src/main/model-registry-service', () => ({ onRegistryReload: vi.fn(() => () => {}) }))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => null }))

const { initTokenomics, shutdownTokenomics, getTokenomicsSupervisor } = await import('../../../src/main/tokenomics/tokenomics-service')

const T0 = 1_800_000_000_000
const WALK = { at: T0 - 60_000, ms: 42, transcripts: { dirs: 5, entries: 12, files: 6 }, rollouts: { dirs: 4, entries: 6, files: 3 }, filesRead: 2 }
const proc = (pid: number, cpuSeconds: number, creationTime = T0 - 20_000): ProcessCpuMetric =>
  ({ pid, creationTime, cpu: { percentCPUUsage: 0, cumulativeCPUUsage: cpuSeconds } })

/** A supervisor over fake workers, each with a process id, on a clock the
 *  test moves, with the app's process figures as the test sets them. */
function harness(opts: { metrics?: boolean } = {}) {
  // `pids`: the process id each worker forked gets, in turn (4321, 4322, ...
  // when not set).
  const w = { t: T0, list: [] as ProcessCpuMetric[], calls: 0, exits: [] as Array<() => void>, pids: [] as number[] }
  const kids: Array<{ t: FakeTkWorkerTransport; pid: number | null }> = []
  const fork = vi.fn((): ForkedTkWorker => {
    const t = new FakeTkWorkerTransport()
    const kid = { t, pid: (w.pids[kids.length] ?? 4321 + kids.length) as number | null }
    kids.push(kid)
    return { transport: t, kill: () => t.kill(), onExit: (cb) => { w.exits.push(cb) }, pid: () => kid.pid }
  })
  const sup = new TokenomicsSupervisor({
    forkChild: fork, dbPath: ':memory:', pricing: {}, configs: [], claudeProjectsDir: '/c', codexSessionsDir: '/x', emit: () => {},
    now: () => w.t,
    ...(opts.metrics === false ? {} : { processMetrics: () => { w.calls++; return w.list } }),
  })
  const row = (): ServiceHealth => sup.getDiagnosticsSnapshot().services[0]
  const ready = () => kids[kids.length - 1].t.emitToMain({ type: 'ready', firstIndexComplete: true, eventsTotal: 3 })
  const pass = (walk: unknown = WALK) => kids[kids.length - 1].t.emitToMain({ type: 'index-complete', firstIndex: false, drained: true, filesFailed: 0, eventsTotal: 3, walk: walk as never })
  return { w, kids, fork, sup, row, ready, pass }
}

describe('the Tokenomics Services row: its process id and measured cost (2.1.3-beta.4)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('carries the worker\'s process id while there is a worker, and none before, while it is down or after shutdown', () => {
    const h = harness()
    expect(h.row().pid).toBeNull()                  // not started
    h.sup.start()
    expect(h.row().pid).toBe(4321)                  // forked: its id
    h.kids[0].pid = null
    expect(h.row().pid).toBeNull()                  // a utility process that has not spawned yet has none
    h.kids[0].pid = 4321
    h.ready()
    expect(h.row().pid).toBe(4321)
    h.w.exits[0]()                                  // exited: no worker, no id
    expect(h.row().pid).toBeNull()
    vi.advanceTimersByTime(300)                     // the next one is forked
    expect(h.row().pid).toBe(4322)
    h.sup.shutdown()
    expect(h.row().pid).toBeNull()
  })

  it('measures the worker\'s CPU share from the app\'s figures for its own process id, and the transcripts the last full pass looked at', () => {
    const h = harness()
    // 3 s of CPU in the 20 s since the worker started: 15% of one core. Another
    // process in the list is not the worker.
    h.w.list = [proc(99, 400), proc(4321, 3)]
    h.sup.start()
    h.ready()
    h.pass()
    expect(h.row().measured).toEqual({ cpuPercent: 15, filesTouchedLastScan: 9, sampledAt: T0 })
    // The next sample, 10 s on: 0.5 s more, 5%.
    h.w.t += 10_000
    h.w.list = [proc(99, 400), proc(4321, 3.5)]
    expect(h.row().measured).toEqual({ cpuPercent: 5, filesTouchedLastScan: 9, sampledAt: T0 + 10_000 })
    h.sup.shutdown()
  })

  it('the files figure is every transcript the last full pass found, in both walks; the next full pass replaces it', () => {
    const h = harness({ metrics: false })
    h.sup.start()
    h.ready()
    expect(h.row().measured).toBeUndefined()        // no pass yet, and no process figures
    h.pass()
    expect(h.row().measured).toEqual({ filesTouchedLastScan: 9, sampledAt: WALK.at })
    h.pass({ ...WALK, at: WALK.at + 1000, transcripts: { dirs: 1, entries: 1, files: 1 }, rollouts: { dirs: 1, entries: 1, files: 0 } })
    expect(h.row().measured).toEqual({ filesTouchedLastScan: 1, sampledAt: WALK.at + 1000 })
    h.sup.shutdown()
  })

  it('asks the app for its figures at most once in five seconds, however often the row is read', () => {
    const h = harness()
    h.w.list = [proc(4321, 3)]
    h.sup.start()                                   // the row pushed as it is forked asks once
    h.ready()
    expect(h.w.calls).toBe(1)
    for (let i = 0; i < 50; i++) { h.w.t += 99; h.row() }
    expect(h.w.calls).toBe(1)
    h.w.t += 5_000
    h.row()
    expect(h.w.calls).toBe(2)
    for (let i = 0; i < 50; i++) { h.w.t += 99; h.row() }
    expect(h.w.calls).toBe(2)
    h.sup.shutdown()
  })

  it('a restarted worker is measured from its own start, not against the one before, even under the same process id', () => {
    const h = harness()
    h.w.pids = [4321, 4321]
    h.w.list = [proc(4321, 30)]
    h.sup.start()
    h.ready()
    expect(h.row().measured?.cpuPercent).toBe(150)
    h.w.t += 1_000
    // The new worker, 2 s old with 0.1 s of CPU, under the id the old one had.
    h.w.list = [proc(4321, 0.1, h.w.t - 2_000)]
    expect(h.sup.manualRestart('tokenomics')).toEqual({ ok: true })
    expect(h.kids).toHaveLength(2)
    h.ready()
    // 5% at once: not the old worker's last sample, and no five-second wait
    // carried over from it.
    expect(h.row().measured).toEqual({ cpuPercent: 5, sampledAt: h.w.t })
    h.sup.shutdown()
  })

  it('a restarted worker\'s row has no files figure from the worker before it, and a pass the replaced one sends late is not its', () => {
    const h = harness({ metrics: false })
    h.sup.start()
    h.ready()
    h.pass()
    expect(h.row().measured).toEqual({ filesTouchedLastScan: 9, sampledAt: WALK.at })
    expect(h.sup.manualRestart('tokenomics')).toEqual({ ok: true })
    expect(h.kids).toHaveLength(2)
    expect(h.row().measured).toBeUndefined()
    expect(h.sup.getLastWalkStats()).toBeNull()
    // The old worker's pass, still draining out of its pipe after the restart.
    h.kids[0].t.emitToMain({ type: 'index-complete', firstIndex: false, drained: true, filesFailed: 0, eventsTotal: 3, walk: WALK })
    h.ready()
    expect(h.row().measured).toBeUndefined()
    // The new worker's own first full pass.
    h.pass({ ...WALK, at: WALK.at + 5_000, transcripts: { dirs: 1, entries: 2, files: 2 } })
    expect(h.row().measured).toEqual({ filesTouchedLastScan: 5, sampledAt: WALK.at + 5_000 })
    h.sup.shutdown()
  })

  it('no measured block without a worker: never started, down between restarts, or shut down', () => {
    const h = harness()
    h.w.list = [proc(4321, 3), proc(4322, 3)]
    expect(h.row().measured).toBeUndefined()        // never started
    h.sup.start()
    h.ready()
    h.pass()
    expect(h.row().measured).toBeDefined()
    h.w.exits[0]()                                  // down: there is no worker
    expect(h.row().measured).toBeUndefined()
    expect(h.sup.getLastWalkStats()).toBeNull()     // and its last pass went with it
    vi.advanceTimersByTime(300)
    h.w.t += 10_000
    // The next worker: its own CPU share, and no files figure until its own
    // first full pass (the one before it made the last).
    expect(h.row().measured).toEqual({ cpuPercent: 0, sampledAt: T0 + 10_000 })
    h.ready()
    h.pass({ ...WALK, at: T0 + 10_000, rollouts: { dirs: 4, entries: 6, files: 4 } })
    expect(h.row().measured?.filesTouchedLastScan).toBe(10)
    h.sup.shutdown()
    expect(h.row().measured).toBeUndefined()
    expect(h.row().state).toBe('stopped')
  })

  it('a worker the app does not list yet, or figures that cannot be read, give no CPU share; the files figure stands', () => {
    const h = harness()
    h.w.list = [proc(99, 1)]
    h.sup.start()
    h.ready()
    h.pass()
    expect(h.row().measured).toEqual({ filesTouchedLastScan: 9, sampledAt: WALK.at })
    const broken = new TokenomicsSupervisor({
      forkChild: () => ({ transport: new FakeTkWorkerTransport(), kill: () => {}, onExit: () => {}, pid: () => 4321 }),
      dbPath: ':memory:', pricing: {}, configs: [], claudeProjectsDir: '/c', codexSessionsDir: '/x', emit: () => {},
      processMetrics: () => { throw new Error('no figures') },
    })
    broken.start()
    expect(() => broken.getDiagnosticsSnapshot()).not.toThrow()
    expect(broken.getDiagnosticsSnapshot().services[0].measured).toBeUndefined()
    broken.shutdown()
    h.sup.shutdown()
  })

  it('reaches the Services view through the registry, beside the other rows', () => {
    const h = harness()
    h.w.list = [proc(4321, 3)]
    h.sup.start()
    h.ready()
    h.pass()
    const registry = createServiceRegistry({
      hooks: () => null, logging: () => null, tokenomics: () => h.sup, watchdog: () => null,
      mcp: () => ({ running: false, port: 0 }),
    })
    const rows = registry.snapshot().services
    const tk = rows.find((r) => r.id === 'tokenomics')!
    expect([tk.pid, tk.measured]).toEqual([4321, { cpuPercent: 15, filesTouchedLastScan: 9, sampledAt: T0 }])
    for (const r of rows.filter((x) => x.id !== 'tokenomics')) expect(r.measured, r.id).toBeUndefined()
    // Tokenomics off: no supervisor, so a stopped row with no id and no measured block.
    const off = createServiceRegistry({
      hooks: () => null, logging: () => null, tokenomics: () => null, watchdog: () => null,
      mcp: () => ({ running: false, port: 0 }),
    }).snapshot().services.find((r) => r.id === 'tokenomics')!
    expect([off.state, off.pid, off.measured]).toEqual(['stopped', null, undefined])
    h.sup.shutdown()
  })
})

describe('the service hands the supervisor the app\'s process figures (2.1.3-beta.4)', () => {
  afterEach(() => shutdownTokenomics())

  it('the worker\'s row carries its process id and its CPU share from the app\'s figures', () => {
    app.pid = 7001
    app.metrics = [{ pid: 7001, creationTime: Date.now() - 10_000, cpu: { percentCPUUsage: 0, cumulativeCPUUsage: 1 } }]
    app.metricsCalls = 0
    initTokenomics({ emit: () => {} })
    const row = getTokenomicsSupervisor()!.getDiagnosticsSnapshot().services[0]
    expect(row.pid).toBe(7001)
    expect(app.metricsCalls).toBe(1)
    // About 10% (1 s of CPU in about 10 s); the clock here is the real one.
    expect(row.measured?.cpuPercent).toBeGreaterThan(5)
    expect(row.measured?.cpuPercent).toBeLessThan(11)
  })

  it('off: no supervisor, so nothing asks the app for its figures', async () => {
    const cm = await import('../../../src/main/config-manager')
    vi.mocked(cm.readConfigChecked).mockReturnValueOnce({ outcome: 'ok', value: { tokenomicsEnabled: false } } as never)
    app.metricsCalls = 0
    initTokenomics({ emit: () => {} })
    expect(getTokenomicsSupervisor()).toBeNull()
    expect(app.metricsCalls).toBe(0)
  })
})
