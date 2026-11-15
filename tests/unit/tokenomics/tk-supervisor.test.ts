import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TokenomicsSupervisor } from '../../../src/main/tokenomics/tk-supervisor'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'
import type { ToTkWorker } from '../../../src/main/tokenomics/tk-worker-transport'
import type { ForkedTkWorker } from '../../../src/main/tokenomics/fork-tokenomics-worker'
import { IPC } from '../../../src/shared/ipc-channels'
import type { DiagnosticsSnapshot } from '../../../src/shared/service-health'

// The service's own lines in the main debug log, kept out of the real logger.
const logs = vi.hoisted(() => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/debug-logger', () => logs)

function fakeFork() {
  const t = new FakeTkWorkerTransport()
  t.onWorker((m) => {
    if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 })
    if (m.type === 'query') t.emitToMain({ type: 'query-result', id: m.id, rows: [{ ok: m.kind }] })
  })
  return { transport: t, kill: () => t.kill(), onExit: () => {}, _t: t }
}

const baseOpts = () => ({ dbPath: ':memory:', pricing: {}, configs: [], claudeProjectsDir: '/c', codexSessionsDir: '/x', emit: () => {} })

describe('TokenomicsSupervisor', () => {
  it('starts, opens, and resolves queries', async () => {
    const sup = new TokenomicsSupervisor({ forkChild: fakeFork as any, ...baseOpts() })
    sup.start()
    const rows = await sup.query('summary', {})
    expect(rows).toEqual([{ ok: 'summary' }])
  })

  it('query rejects (never hangs) when worker not listening', async () => {
    const sup = new TokenomicsSupervisor({ forkChild: (() => { const t = new FakeTkWorkerTransport(); return { transport: t, kill: () => {}, onExit: () => {} } }) as any, ...baseOpts() })
    // not started -> not listening
    await expect(sup.query('summary', {})).rejects.toThrow()
  })

  it('forwards index-progress + index-complete to subscribers + tracks status', async () => {
    const fork = fakeFork()
    const sup = new TokenomicsSupervisor({ forkChild: (() => fork) as any, ...baseOpts() })
    let done = false
    const progresses: any[] = []
    sup.onIndexProgress((p) => progresses.push(p))
    sup.onIndexComplete(() => { done = true })
    sup.start()
    fork._t.emitToMain({ type: 'index-progress', filesDone: 1, filesTotal: 2, eventsIngested: 3, phase: 'initial' })
    fork._t.emitToMain({ type: 'index-complete', firstIndex: true, drained: true, filesFailed: 0, eventsTotal: 5 })
    expect(progresses).toHaveLength(1)
    expect(done).toBe(true)
    expect(sup.getIndexStatus().firstIndexComplete).toBe(true)
  })

  it('reports firstIndexComplete after a DRAINED sweep, including a reopen with firstIndex:false', () => {
    const fork = fakeFork()
    const sup = new TokenomicsSupervisor({ forkChild: (() => fork) as any, ...baseOpts() })
    sup.start()
    fork._t.emitToMain({ type: 'index-complete', firstIndex: false, drained: true, filesFailed: 0, eventsTotal: 9 })
    expect(sup.getIndexStatus().firstIndexComplete).toBe(true)
  })

  it('a sweep that finished WITHOUT draining does not count as a first index', () => {
    // This is the one that matters. A sweep finishing is not the same as every
    // file having been read: a per-tick byte budget means a multi-GB rollout
    // needs tens of sweeps. Latching on the message put the dashboard up over a
    // fraction of the user's spend and presented it as the whole figure.
    const fork = fakeFork()
    const sup = new TokenomicsSupervisor({ forkChild: (() => fork) as any, ...baseOpts() })
    sup.start()
    fork._t.emitToMain({ type: 'index-complete', firstIndex: false, drained: false, filesFailed: 0, eventsTotal: 3 })
    expect(sup.getIndexStatus().firstIndexComplete).toBe(false)
    expect(sup.getIndexStatus().indexing).toBe(true)
    // ...and the honest signal still arrives once the tree really is drained.
    fork._t.emitToMain({ type: 'index-complete', firstIndex: true, drained: true, filesFailed: 0, eventsTotal: 20 })
    expect(sup.getIndexStatus().firstIndexComplete).toBe(true)
  })

  it('query timeout rejects without hanging', async () => {
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 }) /* never answers queries */ })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts(), queryTimeoutMs: 30 })
    sup.start()
    await expect(sup.query('summary', {})).rejects.toThrow(/timed out/)
  })

  it('surfaces an uncorrelated worker error as a fatal index status (stops indexing)', () => {
    const t = new FakeTkWorkerTransport()
    // Emulate a failed DB open: worker stays alive, never posts `ready`, and
    // posts an UNcorrelated error (no id).
    t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'error', message: 'open failed: disk I/O error' }) })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts() })
    const errs: any[] = []
    sup.onIndexError((s) => errs.push(s))
    sup.start()
    expect(errs).toHaveLength(1)
    expect(errs[0].error).toMatch(/open failed/)
    const status = sup.getIndexStatus()
    expect(status.error).toMatch(/open failed/)
    expect(status.indexing).toBe(false)          // no perpetual spinner
    expect(status.firstIndexComplete).toBe(false)
  })

  it('a correlated error still rejects its query and is NOT treated as fatal', async () => {
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => {
      if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 })
      if (m.type === 'query') t.emitToMain({ type: 'error', id: m.id, message: 'bad query' })
    })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts() })
    const errs: any[] = []
    sup.onIndexError((s) => errs.push(s))
    sup.start()
    await expect(sup.query('summary', {})).rejects.toThrow(/bad query/)
    expect(errs).toHaveLength(0)
    expect(sup.getIndexStatus().error ?? null).toBe(null)
  })

  it('takes a completed index from the ready message, before any sweep runs', () => {
    // The supervisor learned this ONLY from a fresh index-complete, so a machine
    // whose index had been complete for months still showed "Indexing usage
    // data" on every launch — and showed it forever if the sweep wedged. The
    // line that fixed it had no test at all: deleting it left the whole suite
    // green, which is the state that lets a fix quietly stop working.
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: true, eventsTotal: 4200 }) })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts() })
    sup.start()
    const status = sup.getIndexStatus()
    expect(status.firstIndexComplete).toBe(true)
    expect(status.indexing).toBe(false)
    expect(status.eventsTotal).toBe(4200)
  })

  it('a ready that reports no completed index leaves the page indexing', () => {
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 }) })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts() })
    sup.start()
    expect(sup.getIndexStatus().firstIndexComplete).toBe(false)
    expect(sup.getIndexStatus().indexing).toBe(true)
  })

  it('shutdown rejects pending queries and is safe', async () => {
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 }) })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts(), queryTimeoutMs: 5000 })
    sup.start()
    const p = sup.query('summary', {})
    sup.shutdown()
    await expect(p).rejects.toThrow()
    expect(() => sup.shutdown()).not.toThrow()
  })

  // WP2 plan A13: each Codex account writes its transcripts in its own realm.
  // Usage track MP9: each folder goes with whose sessions it holds.
  it('hands the worker the Codex account folders with their account keys at open, and every change after', () => {
    const t = new FakeTkWorkerTransport()
    const seen: any[] = []
    t.onWorker((m) => {
      seen.push(m)
      if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 })
    })
    const A = { dir: '/r/a/sessions', accountKey: 'codex:acct-a' }
    const B = { dir: '/r/b/sessions', accountKey: 'codex:acct-b' }
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts(), codexRealmSessionsDirs: [A] })
    sup.start()
    expect(seen.find((m) => m.type === 'open')).toMatchObject({ codexSessionsDir: '/x', codexRealmSessionsDirs: [A] })
    const next = [A, B]
    sup.setCodexRealmSessionsDirs(next)
    expect(seen.at(-1)).toEqual({ type: 'set-codex-realm-dirs', dirs: [A, B] })
    // A copy: the caller's array changing later changes nothing sent.
    next[1].accountKey = 'codex:acct-z'
    expect(seen.at(-1).dirs[1].accountKey).toBe('codex:acct-b')
  })

  it('a restarted worker is opened with the folders as they were set, whatever the caller changed since', async () => {
    const t = new FakeTkWorkerTransport()
    const seen: any[] = []
    let exit: () => void = () => {}
    t.onWorker((m) => {
      seen.push(m)
      if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 })
    })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: (cb: () => void) => { exit = cb } })) as any, ...baseOpts() })
    sup.start()
    const next = [{ dir: '/r/a/sessions', accountKey: 'codex:acct-a' }]
    sup.setCodexRealmSessionsDirs(next)
    next[0].accountKey = 'codex:acct-z'
    exit()
    for (let i = 0; i < 100 && seen.filter((m) => m.type === 'open').length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    expect(seen.filter((m) => m.type === 'open').at(-1).codexRealmSessionsDirs).toEqual([{ dir: '/r/a/sessions', accountKey: 'codex:acct-a' }])
    sup.shutdown()
  })

  // MP9 round 1 (Q-4): the worker is told whether the account folders have
  // been named, so it does not settle the one-off attribution before.
  it('opens the worker saying whether the account folders are named yet, and a restarted one as they are now', async () => {
    const t = new FakeTkWorkerTransport()
    const seen: any[] = []
    let exit: () => void = () => {}
    t.onWorker((m) => {
      seen.push(m)
      if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 })
    })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: (cb: () => void) => { exit = cb } })) as any, ...baseOpts() })
    sup.start()
    expect(seen.find((m) => m.type === 'open').codexRealmDirsKnown).toBe(false)
    sup.setCodexRealmSessionsDirs([])
    exit()
    for (let i = 0; i < 100 && seen.filter((m) => m.type === 'open').length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    expect(seen.filter((m) => m.type === 'open').at(-1).codexRealmDirsKnown).toBe(true)
    sup.shutdown()
    // Given at construction: named from the start.
    const t2 = new FakeTkWorkerTransport()
    const seen2: any[] = []
    t2.onWorker((m) => { seen2.push(m) })
    const sup2 = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t2, kill: () => {}, onExit: () => {} })) as any, ...baseOpts(), codexRealmSessionsDirs: [] })
    sup2.start()
    expect(seen2.find((m) => m.type === 'open').codexRealmDirsKnown).toBe(true)
    sup2.shutdown()
  })

  it('reports the one-off account attribution while the worker says it runs, and not after', () => {
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: true, eventsTotal: 3 }) })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts() })
    sup.start()
    expect(sup.getIndexStatus().accountReread).toBeNull()
    t.emitToMain({ type: 'index-progress', filesDone: 1, filesTotal: 4, eventsIngested: 0, phase: 'incremental', accountReread: { stage: 'reread', done: 1, total: 4 } })
    expect(sup.getIndexStatus().accountReread).toEqual({ stage: 'reread', done: 1, total: 4 })
    t.emitToMain({ type: 'index-progress', filesDone: 4, filesTotal: 4, eventsIngested: 0, phase: 'incremental', accountReread: null })
    expect(sup.getIndexStatus().accountReread).toBeNull()
  })
})

// The usage index on the one supervisor (planning #307, B9): its while-down
// buffer is bounded, and its restart budget is given back after a period of
// stable running (it had no way back at all then: it had no manual restart).
const STABLE_MS = 5 * 60_000

interface Kid { t: FakeTkWorkerTransport; got: ToTkWorker[]; exit: () => void; kills: number }

function harness(opts: { maxRestarts?: number; stableResetMs?: number; autoReady?: boolean; now?: () => number; queryTimeoutMs?: number; emit?: (channel: string, payload: unknown) => void } = {}) {
  const { autoReady = true, ...supOpts } = opts
  const kids: Kid[] = []
  const fork = vi.fn((): ForkedTkWorker => {
    const t = new FakeTkWorkerTransport()
    const kid: Kid = { t, got: t.workerMessages, exit: () => {}, kills: 0 }
    t.onWorker((m) => {
      if (m.type === 'open' && autoReady) t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 })
      if (m.type === 'query') t.emitToMain({ type: 'query-result', id: m.id, rows: [{ ok: m.kind }] })
    })
    kids.push(kid)
    return { transport: t, kill: () => { kid.kills++ }, onExit: (cb: () => void) => { kid.exit = cb } }
  })
  const sup = new TokenomicsSupervisor({
    forkChild: fork, dbPath: ':memory:', pricing: {}, configs: [], claudeProjectsDir: '/c', codexSessionsDir: '/x',
    emit: () => {}, ...supOpts,
  })
  sup.start()
  const last = () => kids[kids.length - 1]
  const ready = () => last().t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 })
  return { sup, fork, kids, last, ready }
}

const price = (n: number) => ({ m: { input: n, output: n } }) as never
const config = (id: string) => [{ configId: id, label: id, workingDirectory: `/w/${id}` }]

describe('usage index: the while-down buffer is bounded (B9)', () => {
  let h: ReturnType<typeof harness> | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { h?.sup.shutdown(); h = undefined; vi.useRealTimers() })

  it('keeps the latest of each kind, however many arrive while the worker is not ready', () => {
    h = harness({ autoReady: false })
    for (let i = 0; i < 500; i++) h.sup.setPricing(price(i))
    for (let i = 0; i < 300; i++) h.sup.setConfigs(config(`c${i}`))
    for (let i = 0; i < 200; i++) h.sup.reindex()
    h.sup.setCodexRealmSessionsDirs([{ dir: '/r/a/sessions', accountKey: 'codex:acct-a' }])
    h.sup.setCodexRealmSessionsDirs([{ dir: '/r/b/sessions', accountKey: 'codex:acct-b' }])
    expect(h.kids[0].got.map((m) => m.type)).toEqual(['open'])   // nothing sent before ready
    h.ready()
    expect(h.kids[0].got.slice(1)).toEqual([
      { type: 'set-pricing', pricing: price(499) },
      { type: 'set-configs', configs: config('c299') },
      { type: 'reindex' },
      { type: 'set-codex-realm-dirs', dirs: [{ dir: '/r/b/sessions', accountKey: 'codex:acct-b' }] },
    ])
  })

  it('a newer message of a kind takes the place in the order of its newest arrival', () => {
    h = harness({ autoReady: false })
    h.sup.setPricing(price(1))
    h.sup.reindex()
    h.sup.setConfigs(config('a'))
    h.sup.setPricing(price(2))
    h.ready()
    expect(h.kids[0].got.slice(1)).toEqual([
      { type: 'reindex' },
      { type: 'set-configs', configs: config('a') },
      { type: 'set-pricing', pricing: price(2) },
    ])
  })

  it('stays bounded across a crash window too, and the next worker gets the latest', () => {
    h = harness()
    h.kids[0].exit()                       // down: a restart is 250ms away
    for (let i = 0; i < 1000; i++) h.sup.setPricing(price(i))
    vi.advanceTimersByTime(300)
    expect(h.fork).toHaveBeenCalledTimes(2)
    expect(h.kids[1].got).toEqual([
      expect.objectContaining({ type: 'open', pricing: price(999) }),
      { type: 'set-pricing', pricing: price(999) },
    ])
  })

  it('a listening worker is sent every message at once, as before', () => {
    h = harness()
    h.sup.setPricing(price(1))
    h.sup.setPricing(price(2))
    h.sup.reindex()
    h.sup.reindex()
    expect(h.kids[0].got.slice(1).map((m) => m.type)).toEqual(['set-pricing', 'set-pricing', 'reindex', 'reindex'])
  })
})

describe('usage index: the restart budget recovers (B9)', () => {
  let h: ReturnType<typeof harness> | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { h?.sup.shutdown(); h = undefined; vi.useRealTimers() })

  it('crashes far apart never degrade the index for the run', async () => {
    h = harness({ maxRestarts: 2 })
    for (let i = 0; i < 8; i++) {
      h.last().exit()
      vi.advanceTimersByTime(5000)         // forked again; it opens and is ready
      vi.advanceTimersByTime(STABLE_MS)
    }
    expect(h.fork).toHaveBeenCalledTimes(9)
    await expect(h.sup.query('summary', {})).resolves.toEqual([{ ok: 'summary' }])
  })

  it('a worker that opens and dies inside the period still uses the budget up', async () => {
    h = harness({ maxRestarts: 2 })
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(STABLE_MS - 5000)
      h.last().exit()
      vi.advanceTimersByTime(4999)
    }
    expect(h.fork).toHaveBeenCalledTimes(3)
    await expect(h.sup.query('summary', {})).rejects.toThrow('degraded=true')
    vi.advanceTimersByTime(10 * STABLE_MS)
    expect(h.fork).toHaveBeenCalledTimes(3)   // degraded until a restart is asked for
  })

  it('a worker that never becomes ready gives nothing back', () => {
    h = harness({ maxRestarts: 1, autoReady: false })
    h.last().exit()
    vi.advanceTimersByTime(300)            // forked again, never ready
    vi.advanceTimersByTime(10 * STABLE_MS)
    h.last().exit()                        // the budget of 1 is still spent
    vi.advanceTimersByTime(60_000)
    expect(h.fork).toHaveBeenCalledTimes(2)
  })

  it('the period is the one given', () => {
    h = harness({ maxRestarts: 1, stableResetMs: 2000 })
    h.last().exit(); vi.advanceTimersByTime(300)   // the one restart is spent; ready on open
    vi.advanceTimersByTime(2000)                   // stable for the period given
    h.last().exit(); vi.advanceTimersByTime(300)   // so this crash is restarted too
    expect(h.fork).toHaveBeenCalledTimes(3)
  })

  it('a ready starts the backoff over at once, as before', () => {
    h = harness()
    h.last().exit(); vi.advanceTimersByTime(300)   // 250ms, ready on open
    h.last().exit(); vi.advanceTimersByTime(300)   // 250ms again: the ready reset the step
    expect(h.fork).toHaveBeenCalledTimes(3)
  })

  it('without a ready the backoff climbs, as before', () => {
    h = harness({ autoReady: false })
    h.last().exit(); vi.advanceTimersByTime(300)
    h.last().exit(); vi.advanceTimersByTime(900)   // the second step is 1000ms
    expect(h.fork).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(100)
    expect(h.fork).toHaveBeenCalledTimes(3)
  })

  it('shutdown leaves no timer behind, and a late exit forks nothing', () => {
    h = harness()
    h.last().exit(); vi.advanceTimersByTime(300)
    const kid = h.last()
    h.sup.shutdown()
    expect(kid.got.at(-1)).toEqual({ type: 'shutdown' })
    expect(kid.kills).toBe(1)
    kid.exit()
    vi.advanceTimersByTime(STABLE_MS)
    expect(h.fork).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})

// Review round: a replaced worker's late ready, what the service says in the
// debug log, and a fork that fails.
describe('usage index: a replaced worker\'s late ready', () => {
  let h: ReturnType<typeof harness> | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { h?.sup.shutdown(); h = undefined; vi.useRealTimers() })

  it('is not the current worker\'s: nothing is sent, nothing is listening, and no budget comes back', async () => {
    h = harness({ maxRestarts: 1, autoReady: false })
    h.ready()                                       // worker 1 is up
    h.last().exit(); vi.advanceTimersByTime(300)    // worker 2: the one restart is spent, and it is never ready
    h.sup.setPricing(price(7))                      // held for a worker that is ready
    h.kids[0].t.emitToMain({ type: 'ready', firstIndexComplete: true, eventsTotal: 5 })   // worker 1's, still draining
    expect(h.kids[1].got.map((m) => m.type)).toEqual(['open'])
    await expect(h.sup.query('summary', {})).rejects.toThrow('not ready')
    expect(h.sup.getIndexStatus().firstIndexComplete).toBe(false)
    vi.advanceTimersByTime(STABLE_MS + 10)
    h.last().exit()
    vi.advanceTimersByTime(60_000)
    expect(h.fork).toHaveBeenCalledTimes(2)         // the budget of 1 is still spent
  })

  it('the current worker\'s own ready is taken as before', async () => {
    h = harness({ autoReady: false })
    h.last().exit(); vi.advanceTimersByTime(300)
    h.sup.setPricing(price(7))
    h.ready()
    expect(h.kids[1].got.map((m) => m.type)).toEqual(['open', 'set-pricing'])
  })
})

describe('usage index: what it says in the debug log', () => {
  let h: ReturnType<typeof harness> | undefined
  beforeEach(() => { vi.useFakeTimers(); logs.logInfo.mockClear(); logs.logError.mockClear() })
  afterEach(() => { h?.sup.shutdown(); h = undefined; vi.useRealTimers() })

  it('a stable period that gives a used budget back is logged', () => {
    h = harness()
    h.last().exit(); vi.advanceTimersByTime(250)    // one restart used; ready on open
    vi.advanceTimersByTime(STABLE_MS - 1)
    expect(logs.logInfo).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(logs.logInfo.mock.calls).toEqual([['[tokenomics] worker stable; restart budget restored']])
  })

  it('with nothing used, nothing is logged', () => {
    h = harness()
    vi.advanceTimersByTime(2 * STABLE_MS)
    expect(logs.logInfo).not.toHaveBeenCalled()
  })

  it('a crash restart whose fork fails is logged with the reason, and the backoff forks the next', async () => {
    h = harness()
    h.fork.mockImplementationOnce(() => { throw new Error('no fork') })
    h.last().exit()
    expect(logs.logError).not.toHaveBeenCalled()    // an ordinary exit says nothing here, as before
    vi.advanceTimersByTime(250)
    expect(logs.logError.mock.calls).toEqual([['[tokenomics] worker could not be forked:', 'no fork']])
    await expect(h.sup.query('summary', {})).rejects.toThrow('not ready')
    vi.advanceTimersByTime(1000)                    // the second step of the backoff
    expect(h.fork).toHaveBeenCalledTimes(3)
    await expect(h.sup.query('summary', {})).resolves.toEqual([{ ok: 'summary' }])
  })
})

// The usage index as one row in the service registry
// (src/main/services/service-registry.ts): where the worker is now, told to
// the Services view when it changes.
const rowOf = (sup: TokenomicsSupervisor) => sup.getDiagnosticsSnapshot().services[0]

describe('usage index: its Services row', () => {
  let h: ReturnType<typeof harness> | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { h?.sup.shutdown(); h = undefined; vi.useRealTimers() })

  it('is one Tokenomics row on a utility process, with no log of its own', () => {
    h = harness()
    const snap = h.sup.getDiagnosticsSnapshot()
    expect(snap.services).toHaveLength(1)
    expect(snap.log).toEqual([])
    const r = snap.services[0]
    expect([r.id, r.label, r.host]).toEqual(['tokenomics', 'Tokenomics', 'utility-process'])
  })

  it('reads stopped before it is started, starting once forked, listening once ready, stopped after shutdown', () => {
    const t = new FakeTkWorkerTransport()
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts(), now: () => 5000 })
    expect(rowOf(sup).state).toBe('stopped')
    sup.start()
    expect([rowOf(sup).state, rowOf(sup).startedAt]).toEqual(['starting', null])
    t.emitToMain({ type: 'ready', firstIndexComplete: true, eventsTotal: 4200 })
    const r = rowOf(sup)
    expect([r.state, r.startedAt, r.eventsTotal, r.lastHeartbeatAt, r.lastError]).toEqual(['listening', 5000, 4200, 5000, null])
    sup.shutdown()
    expect(rowOf(sup).state).toBe('stopped')
  })

  it('reads crashed with the reason while the worker is down, and restarting once the next is forked', () => {
    h = harness({ autoReady: false })
    h.ready()
    h.last().exit()
    let r = rowOf(h.sup)
    expect([r.state, r.lastError?.message]).toEqual(['crashed', 'worker exited'])
    vi.advanceTimersByTime(300)                     // the backoff forks the next
    r = rowOf(h.sup)
    expect([r.state, r.restartCount]).toEqual(['restarting', 1])
    h.ready()
    expect(rowOf(h.sup).state).toBe('listening')
  })

  it('its start time is the ready time of the current worker: each ready sets it, and a worker that is down or not ready has none', () => {
    let clock = 1000
    h = harness({ autoReady: false, now: () => clock })
    expect(rowOf(h.sup).startedAt).toBeNull()       // forked, not ready yet
    h.ready()
    expect(rowOf(h.sup).startedAt).toBe(1000)
    clock = 5000
    h.last().exit()                                 // crashed: no worker, so no age to show
    expect(rowOf(h.sup).startedAt).toBeNull()
    vi.advanceTimersByTime(300)                     // the next is forked, and is not ready yet
    expect(rowOf(h.sup).startedAt).toBeNull()
    clock = 6000
    h.ready()                                       // a crash restart starts the age over
    expect(rowOf(h.sup).startedAt).toBe(6000)
    clock = 9000
    expect(h.sup.manualRestart('tokenomics')).toEqual({ ok: true })
    expect(rowOf(h.sup).startedAt).toBeNull()       // a manual restart does too, from the press
    clock = 9500
    h.ready()
    expect(rowOf(h.sup).startedAt).toBe(9500)
  })

  it('reads degraded once the restart budget is spent', () => {
    h = harness({ maxRestarts: 1, autoReady: false })
    h.last().exit(); vi.advanceTimersByTime(300)    // the one restart
    h.last().exit(); vi.advanceTimersByTime(60_000)
    expect(h.fork).toHaveBeenCalledTimes(2)
    expect(rowOf(h.sup).state).toBe('degraded')
  })

  it('reads degraded, with the worker\'s own error, when the worker is alive but never ready', () => {
    h = harness({ autoReady: false })
    h.last().t.emitToMain({ type: 'error', message: 'open failed: disk I/O error' })
    const r = rowOf(h.sup)
    expect([r.state, r.lastError?.message]).toEqual(['degraded', 'open failed: disk I/O error'])
  })

  it('an error from a worker that is listening leaves the row listening, with the error shown', () => {
    h = harness()
    h.last().t.emitToMain({ type: 'error', message: 'worker handling failed: x' })
    const r = rowOf(h.sup)
    expect([r.state, r.lastError?.message]).toEqual(['listening', 'worker handling failed: x'])
  })

  it('tells the Services view each time the row changes, and only on that channel', () => {
    const pushed: string[] = []
    const channels = new Set<string>()
    h = harness({
      autoReady: false,
      emit: (channel, payload) => { channels.add(channel); pushed.push((payload as DiagnosticsSnapshot).services[0].state) },
    })
    expect(pushed).toEqual(['starting'])
    h.ready()
    expect(pushed).toEqual(['starting', 'listening'])
    h.last().exit()
    expect(pushed.at(-1)).toBe('crashed')
    vi.advanceTimersByTime(300)
    expect(pushed.at(-1)).toBe('restarting')
    h.last().t.emitToMain({ type: 'error', message: 'open failed' })
    expect(pushed.at(-1)).toBe('degraded')
    expect([...channels]).toEqual([IPC.SERVICE_HEALTH_UPDATE])
  })

  it('a window that is gone does not break the service', async () => {
    h = harness({ emit: () => { throw new Error('window gone') } })
    await expect(h.sup.query('summary', {})).resolves.toEqual([{ ok: 'summary' }])
    h.last().exit(); vi.advanceTimersByTime(300)
    expect(h.fork).toHaveBeenCalledTimes(2)
  })

  it('counts the queries the worker has not answered yet as in flight', async () => {
    h = harness()
    expect(rowOf(h.sup).inFlight).toBe(0)
    h.last().t.onWorker(() => {})                   // from here the worker answers nothing
    const first = h.sup.query('summary', {})
    const second = h.sup.query('by-model', {})
    // Each is rejected below; a failed expectation must not leave one unhandled.
    first.catch(() => {}); second.catch(() => {})
    expect(rowOf(h.sup).inFlight).toBe(2)
    h.sup.shutdown()                                // both are rejected
    await expect(first).rejects.toThrow('shut down')
    await expect(second).rejects.toThrow('shut down')
    expect(rowOf(h.sup).inFlight).toBe(0)
  })

  it('shutdown tells the Services view the row is stopped', () => {
    const pushed: string[] = []
    h = harness({ emit: (_channel, payload) => { pushed.push((payload as DiagnosticsSnapshot).services[0].state) } })
    pushed.length = 0
    h.sup.shutdown()
    expect(pushed).toEqual(['stopped'])
  })
})

// Until the registry there was no way back for a usage index that ran out of
// restarts: it stayed degraded until the app was relaunched.
describe('usage index: a restart asked for from the Services panel', () => {
  let h: ReturnType<typeof harness> | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { h?.sup.shutdown(); h = undefined; vi.useRealTimers() })

  it('answers unknown-service for any id but its own, and restarts nothing', () => {
    h = harness()
    for (const id of ['hooks', 'logging', 'watchdog', '', 'Tokenomics']) {
      expect(h.sup.manualRestart(id)).toEqual({ ok: false, reason: 'unknown-service' })
    }
    expect(h.fork).toHaveBeenCalledTimes(1)
    expect(h.kids[0].kills).toBe(0)
  })

  it('replaces the worker: the old one is killed, the new one is opened, and queries work again', async () => {
    h = harness()
    expect(h.sup.manualRestart('tokenomics')).toEqual({ ok: true })
    expect(h.fork).toHaveBeenCalledTimes(2)
    expect(h.kids[0].kills).toBe(1)
    expect(h.kids[1].got[0]).toMatchObject({ type: 'open', dbPath: ':memory:' })
    expect(rowOf(h.sup).state).toBe('listening')
    await expect(h.sup.query('summary', {})).resolves.toEqual([{ ok: 'summary' }])
  })

  it('rejects at once the queries the old worker had not answered', async () => {
    h = harness()
    h.kids[0].t.onWorker(() => {})                  // from here the first worker answers nothing
    const unanswered = h.sup.query('summary', {})
    h.sup.manualRestart('tokenomics')
    await expect(unanswered).rejects.toThrow('tokenomics worker restarted')
  })

  it('revives an index whose restart budget was spent, with the budget whole again', async () => {
    h = harness({ maxRestarts: 1 })
    h.last().exit(); vi.advanceTimersByTime(300)    // the one restart
    h.last().exit(); vi.advanceTimersByTime(60_000)
    expect(rowOf(h.sup).state).toBe('degraded')
    await expect(h.sup.query('summary', {})).rejects.toThrow('degraded=true')
    expect(h.sup.manualRestart('tokenomics')).toEqual({ ok: true })
    const r = rowOf(h.sup)
    expect([r.state, r.restartCount]).toEqual(['listening', 0])
    await expect(h.sup.query('summary', {})).resolves.toEqual([{ ok: 'summary' }])
    h.last().exit(); vi.advanceTimersByTime(300)    // a later crash is restarted again
    expect(h.fork).toHaveBeenCalledTimes(4)
  })

  it('is declined while shutting down, and forks nothing', () => {
    h = harness()
    h.sup.shutdown()
    expect(h.sup.manualRestart('tokenomics')).toEqual({ ok: false, reason: 'shutting-down' })
    expect(h.fork).toHaveBeenCalledTimes(1)
  })

  it('is refused on a supervisor that was never started, as its stopped row says, and forks nothing', () => {
    const fork = vi.fn()
    const pushed: unknown[] = []
    const sup = new TokenomicsSupervisor({ forkChild: fork as never, ...baseOpts(), emit: (_channel, payload) => { pushed.push(payload) } })
    try {
      expect(rowOf(sup).state).toBe('stopped')
      expect(sup.manualRestart('tokenomics')).toEqual({ ok: false, reason: 'stopped' })
      expect(fork).not.toHaveBeenCalled()
      expect(rowOf(sup).state).toBe('stopped')
      expect(pushed).toEqual([])
    } finally {
      sup.shutdown()
    }
  })

  it('when the new fork fails the row reads crashed with the reason, and the backoff forks the next', () => {
    h = harness()
    h.fork.mockImplementationOnce(() => { throw new Error('no fork') })
    expect(h.sup.manualRestart('tokenomics')).toEqual({ ok: true })
    const r = rowOf(h.sup)
    expect([r.state, r.lastError?.message]).toEqual(['crashed', 'fork failed: no fork'])
    vi.advanceTimersByTime(300)
    expect(rowOf(h.sup).state).toBe('listening')
  })

  it('a replaced worker\'s late error is not held against the new one', () => {
    h = harness({ autoReady: false })
    h.ready()
    h.sup.manualRestart('tokenomics')               // worker 2 is forked, not ready yet
    h.kids[0].t.emitToMain({ type: 'error', message: 'late, from the old worker' })
    expect(h.sup.getIndexStatus().error).toBeNull()
    const r = rowOf(h.sup)
    expect([r.state, r.lastError]).toEqual(['starting', null])
  })

  it('tells the Services view the row changed', () => {
    const pushed: string[] = []
    h = harness({ autoReady: false, emit: (_channel, payload) => { pushed.push((payload as DiagnosticsSnapshot).services[0].state) } })
    h.ready()
    pushed.length = 0
    h.sup.manualRestart('tokenomics')
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed.at(-1)).toBe('starting')
  })
})

// Review round on the registry PR: what a replaced worker may still change, how
// the row follows the counters, and what a shut down worker leaves on the row.
// Answers to queries are keyed by request id, and a restart or exit rejects every
// pending query at once (ids are never reused), so a replaced worker cannot
// settle one that is still pending: those messages need no identity check.
describe('usage index: a replaced worker\'s late messages', () => {
  let h: ReturnType<typeof harness> | undefined
  beforeEach(() => { vi.useFakeTimers(); logs.logInfo.mockClear() })
  afterEach(() => { h?.sup.shutdown(); h = undefined; vi.useRealTimers() })

  it('a late health, progress or completion changes nothing and tells nobody; its log lines are still forwarded', () => {
    const pushed: DiagnosticsSnapshot[] = []
    h = harness({ autoReady: false, emit: (_c, payload) => { pushed.push(payload as DiagnosticsSnapshot) } })
    h.ready()
    h.sup.manualRestart('tokenomics')               // worker 2 is forked
    h.ready()                                       // and ready
    const progress = vi.fn(); const complete = vi.fn()
    h.sup.onIndexProgress(progress); h.sup.onIndexComplete(complete)
    pushed.length = 0
    const old = h.kids[0].t
    old.emitToMain({ type: 'health', eventsTotal: 999, filesTracked: 1, dbBytes: 1 })
    old.emitToMain({ type: 'index-progress', filesDone: 9, filesTotal: 9, eventsIngested: 9, phase: 'initial' })
    old.emitToMain({ type: 'index-complete', firstIndex: true, drained: true, filesFailed: 3, eventsTotal: 777, walk: { at: 1, ms: 1, transcripts: { dirs: 1, entries: 1, files: 1 }, rollouts: { dirs: 1, entries: 1, files: 1 }, filesRead: 1 } })
    vi.advanceTimersByTime(1000)
    expect(progress).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(h.sup.getIndexStatus()).toMatchObject({ eventsTotal: 0, filesDone: 0, filesFailed: 0, lastIndexAt: null, firstIndexComplete: false })
    expect(rowOf(h.sup).eventsTotal).toBe(0)
    expect(h.sup.getLastWalkStats()).toBeNull()       // a replaced worker's walk figures are not the row's
    expect(pushed).toEqual([])
    old.emitToMain({ type: 'log', entry: { level: 'info', message: 'late line' } })
    expect(logs.logInfo).toHaveBeenCalledWith('[tokenomics worker]', 'late line')
  })

  it('the current worker\'s own health and completion are taken as before', () => {
    h = harness()
    h.last().t.emitToMain({ type: 'health', eventsTotal: 40, filesTracked: 1, dbBytes: 1 })
    expect(rowOf(h.sup).eventsTotal).toBe(40)
    h.last().t.emitToMain({ type: 'index-complete', firstIndex: true, drained: true, filesFailed: 0, eventsTotal: 55 })
    expect(h.sup.getIndexStatus().eventsTotal).toBe(55)
  })
})

describe('usage index: its row follows the counters', () => {
  let h: ReturnType<typeof harness> | undefined
  let pushed: DiagnosticsSnapshot[] = []
  const emit = (_c: string, payload: unknown) => { pushed.push(payload as DiagnosticsSnapshot) }
  const lastRow = () => pushed[pushed.length - 1].services[0]
  beforeEach(() => { vi.useFakeTimers(); pushed = [] })
  afterEach(() => { h?.sup.shutdown(); h = undefined; vi.useRealTimers() })

  it('a changed Events count from health or a completed sweep is pushed, an unchanged one is not', () => {
    h = harness({ emit })
    vi.advanceTimersByTime(1000)
    pushed.length = 0
    h.last().t.emitToMain({ type: 'health', eventsTotal: 50, filesTracked: 1, dbBytes: 1 })
    expect(pushed).toHaveLength(1)
    expect(lastRow().eventsTotal).toBe(50)
    vi.advanceTimersByTime(1000)
    h.last().t.emitToMain({ type: 'health', eventsTotal: 50, filesTracked: 1, dbBytes: 1 })
    expect(pushed).toHaveLength(1)                  // same count: nothing to say
    h.last().t.emitToMain({ type: 'index-complete', firstIndex: false, drained: true, filesFailed: 0, eventsTotal: 80 })
    expect(pushed).toHaveLength(2)
    expect(lastRow().eventsTotal).toBe(80)
  })

  it('a burst of queries is one push now and one trailing push with the last value, and the answers likewise', () => {
    h = harness({ emit })
    h.last().t.onWorker(() => {})                   // from here the worker answers nothing
    vi.advanceTimersByTime(1000)
    pushed.length = 0
    for (let i = 0; i < 5; i++) h.sup.query('summary', {}).catch(() => {})
    expect(pushed).toHaveLength(1)
    expect(lastRow().inFlight).toBe(1)
    vi.advanceTimersByTime(249)
    expect(pushed).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(pushed).toHaveLength(2)                  // the trailing push carries the last value
    expect(lastRow().inFlight).toBe(5)
    for (let id = 1; id <= 5; id++) h.last().t.emitToMain({ type: 'query-result', id, rows: [] })
    expect(pushed).toHaveLength(2)                  // inside the window: held
    vi.advanceTimersByTime(250)
    expect(pushed).toHaveLength(3)
    expect(lastRow().inFlight).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(pushed).toHaveLength(3)                  // nothing more to say, nothing pushed
  })

  it('a query that fails or times out is pushed too', async () => {
    h = harness({ emit, queryTimeoutMs: 30 })
    h.last().t.onWorker(() => {})
    vi.advanceTimersByTime(1000)
    const failing = h.sup.query('summary', {}).catch(() => {})
    expect(lastRow().inFlight).toBe(1)
    vi.advanceTimersByTime(20)                      // inside the query's timeout
    h.last().t.emitToMain({ type: 'error', id: 1, message: 'boom' })
    await failing
    vi.advanceTimersByTime(250)
    expect(lastRow().inFlight).toBe(0)
    vi.advanceTimersByTime(1000)
    const timing = h.sup.query('summary', {}).catch(() => {})
    expect(lastRow().inFlight).toBe(1)
    vi.advanceTimersByTime(30)                      // timed out
    await timing
    vi.advanceTimersByTime(250)
    expect(lastRow().inFlight).toBe(0)
  })

  it('shutdown clears the pending push, and nothing is pushed after it', () => {
    h = harness({ emit })
    h.last().t.onWorker(() => {})
    vi.advanceTimersByTime(1000)
    h.sup.query('summary', {}).catch(() => {})
    h.sup.query('summary', {}).catch(() => {})      // a trailing push is waiting
    h.sup.shutdown()
    const n = pushed.length
    expect(lastRow().state).toBe('stopped')
    vi.advanceTimersByTime(STABLE_MS)
    expect(pushed).toHaveLength(n)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a shut down worker leaves no uptime on the row, and the stopped push says so', () => {
    h = harness({ emit })
    expect(rowOf(h.sup).startedAt).not.toBeNull()
    h.sup.shutdown()
    expect(rowOf(h.sup)).toMatchObject({ state: 'stopped', startedAt: null })
    expect(lastRow()).toMatchObject({ state: 'stopped', startedAt: null })
  })
})

// 2.1.3-beta.4: Tokenomics as an optional service. What the supervisor
// gained for it: the page's Rescan, the last full pass's walk figures (for
// the Services panel), a status as each worker comes up, and attributions
// carried from a supervisor that was stopped.
describe('usage index: the optional service (2.1.3-beta.4)', () => {
  const SESSION_A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
  const SESSION_B = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'
  /** A worker the test makes ready itself. */
  function manual() {
    const t = new FakeTkWorkerTransport()
    const seen: ToTkWorker[] = []
    t.onWorker((m) => { seen.push(m) })
    const fork = { transport: t, kill: () => t.kill(), onExit: () => {} } as unknown as ForkedTkWorker
    const ready = (firstIndexComplete = false) => t.emitToMain({ type: 'ready', firstIndexComplete, eventsTotal: 4 })
    return { t, seen, fork, ready }
  }
  const WALK = { at: 1_700_000_000_000, ms: 42, transcripts: { dirs: 5, entries: 12, files: 6 }, rollouts: { dirs: 4, entries: 6, files: 1 }, filesRead: 7 }

  it('Rescan is sent to a listening worker at once, and held once for one that is not', () => {
    const w = manual()
    const sup = new TokenomicsSupervisor({ forkChild: () => w.fork, ...baseOpts() })
    sup.start()
    // Not ready yet: held, and three asks are one. Each says a worker will read it.
    expect([sup.rescan(), sup.rescan(), sup.rescan()]).toEqual([true, true, true])
    expect(w.seen.filter((m) => m.type === 'rescan')).toHaveLength(0)
    w.ready()
    expect(w.seen.filter((m) => m.type === 'rescan')).toHaveLength(1)
    expect(sup.rescan()).toBe(true)
    expect(w.seen.filter((m) => m.type === 'rescan')).toHaveLength(2)
    sup.shutdown()
  })

  it('Rescan is refused, and nothing is held, once no worker will come to read it: the restarts are used up, or it is shutting down', () => {
    vi.useFakeTimers()
    try {
      const held = (sup: TokenomicsSupervisor): string[] => (sup as unknown as { buffer: ToTkWorker[] }).buffer.map((m) => m.type)
      const h = harness({ maxRestarts: 1, autoReady: false })
      // Down and being started again: one will come, so it is held.
      h.last().exit()
      expect(h.sup.rescan()).toBe(true)
      expect(held(h.sup)).toEqual(['rescan'])
      vi.advanceTimersByTime(300)            // the one restart: forked again, never ready
      expect(h.fork).toHaveBeenCalledTimes(2)
      h.last().exit()                        // the restarts are used up
      vi.advanceTimersByTime(60_000)
      expect(h.fork).toHaveBeenCalledTimes(2)
      const before = held(h.sup)
      expect(h.sup.rescan()).toBe(false)
      expect(held(h.sup)).toEqual(before)
      h.sup.shutdown()

      // Shutting down: refused, whatever its worker was doing.
      const up = harness()
      expect(up.sup.rescan()).toBe(true)
      up.sup.shutdown()
      expect(up.sup.rescan()).toBe(false)
      expect(up.kids[0].got.filter((m) => m.type === 'rescan')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // A worker that cannot open its database stays alive and is never ready,
  // so nothing would ever read a Rescan held for it. One being started, or
  // between a crash and its restart, is still held for as before.
  it('Rescan is refused, and nothing is held, while the worker is alive but could not open its database; a worker started again takes it', () => {
    vi.useFakeTimers()
    try {
      const held = (sup: TokenomicsSupervisor): string[] => (sup as unknown as { buffer: ToTkWorker[] }).buffer.map((m) => m.type)
      const h = harness({ autoReady: false })
      h.last().t.emitToMain({ type: 'error', message: 'open failed: disk I/O error' })
      expect(h.sup.getIndexStatus().error).toMatch(/open failed/)
      expect(h.sup.rescan()).toBe(false)
      expect(held(h.sup)).toEqual([])
      // That worker exits: one will be started, so a Rescan is held for it.
      h.last().exit()
      expect(h.sup.rescan()).toBe(true)
      expect(held(h.sup)).toEqual(['rescan'])
      vi.advanceTimersByTime(300)
      expect(h.fork).toHaveBeenCalledTimes(2)
      h.ready()
      expect(h.kids[1].got.filter((m) => m.type === 'rescan')).toHaveLength(1)
      expect(h.sup.rescan()).toBe(true)
      expect(h.kids[1].got.filter((m) => m.type === 'rescan')).toHaveLength(2)
      h.sup.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps what the last full pass touched, readable as a copy; a pass with no walk leaves it', () => {
    const w = manual()
    const sup = new TokenomicsSupervisor({ forkChild: () => w.fork, ...baseOpts() })
    sup.start()
    w.ready()
    expect(sup.getLastWalkStats()).toBeNull()
    w.t.emitToMain({ type: 'index-complete', firstIndex: true, drained: true, filesFailed: 0, eventsTotal: 5, walk: WALK })
    expect(sup.getLastWalkStats()).toEqual(WALK)
    // A pass over the reported transcripts alone walks nothing and says nothing.
    w.t.emitToMain({ type: 'index-complete', firstIndex: false, drained: true, filesFailed: 0, eventsTotal: 6 })
    expect(sup.getLastWalkStats()).toEqual(WALK)
    // The next full pass replaces it.
    const next = { ...WALK, at: WALK.at + 300_000, transcripts: { dirs: 6, entries: 14, files: 7 }, filesRead: 1 }
    w.t.emitToMain({ type: 'index-complete', firstIndex: false, drained: true, filesFailed: 0, eventsTotal: 7, walk: next })
    expect(sup.getLastWalkStats()).toEqual(next)
    // A copy: changing what was handed out changes nothing kept.
    sup.getLastWalkStats()!.transcripts.files = 999
    expect(sup.getLastWalkStats()!.transcripts.files).toBe(7)
    sup.shutdown()
  })

  it('figures that are not well formed are not kept', () => {
    const w = manual()
    const sup = new TokenomicsSupervisor({ forkChild: () => w.fork, ...baseOpts() })
    sup.start()
    w.ready()
    w.t.emitToMain({ type: 'index-complete', firstIndex: true, drained: true, filesFailed: 0, eventsTotal: 5, walk: WALK })
    const bad: unknown[] = [
      null, 'walk', {}, { ...WALK, transcripts: undefined }, { ...WALK, rollouts: { dirs: 1, entries: 1 } },
      { ...WALK, transcripts: { dirs: -1, entries: 1, files: 1 } }, { ...WALK, transcripts: { dirs: 1.5, entries: 1, files: 1 } },
      { ...WALK, filesRead: 'many' }, { ...WALK, ms: Number.NaN }, { ...WALK, at: -5 },
    ]
    for (const walk of bad) {
      w.t.emitToMain({ type: 'index-complete', firstIndex: false, drained: true, filesFailed: 0, eventsTotal: 5, walk: walk as never })
      expect(sup.getLastWalkStats(), JSON.stringify(walk)).toEqual(WALK)
    }
    sup.shutdown()
  })

  it('says what the index holds each time a worker comes up', () => {
    const w = manual()
    const sup = new TokenomicsSupervisor({ forkChild: () => w.fork, ...baseOpts() })
    const statuses: Array<{ firstIndexComplete: boolean; indexing: boolean; eventsTotal: number }> = []
    const off = sup.onIndexReady((s) => statuses.push(s))
    sup.start()
    expect(statuses).toHaveLength(0)
    w.ready(true)
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toMatchObject({ firstIndexComplete: true, indexing: false, eventsTotal: 4 })
    off()
    w.ready(true)
    expect(statuses).toHaveLength(1)
    sup.shutdown()
  })

  it('attributions handed over from a stopped supervisor are sent when the worker is ready, with the ones made since', () => {
    const w = manual()
    const sup = new TokenomicsSupervisor({
      forkChild: () => w.fork, ...baseOpts(),
      // One well formed, and three that are not: dropped.
      sessionAccounts: [[SESSION_A, 'claude:acct-a'], ['not-a-session', 'claude:acct-a'], [SESSION_B, 'bogus'], [SESSION_B, '']],
    })
    sup.start()
    sup.setSessionAccount(SESSION_B, 'claude:acct-b')
    expect(sup.keptSessionAccounts()).toEqual([[SESSION_A, 'claude:acct-a'], [SESSION_B, 'claude:acct-b']])
    expect(w.seen.filter((m) => m.type === 'set-session-account')).toHaveLength(0)
    w.ready()
    expect(w.seen.filter((m) => m.type === 'set-session-account')).toEqual([
      { type: 'set-session-account', sessionId: SESSION_A, accountKey: 'claude:acct-a' },
      { type: 'set-session-account', sessionId: SESSION_B, accountKey: 'claude:acct-b' },
    ])
    // Still kept after a shutdown, for the next supervisor.
    sup.shutdown()
    expect(sup.keptSessionAccounts()).toHaveLength(2)
  })
})
