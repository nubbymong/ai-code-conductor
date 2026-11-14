import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TokenomicsSupervisor } from '../../../src/main/tokenomics/tk-supervisor'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'
import type { ToTkWorker } from '../../../src/main/tokenomics/tk-worker-transport'
import type { ForkedTkWorker } from '../../../src/main/tokenomics/fork-tokenomics-worker'

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
// stable running (it had no way back at all: it has no manual restart).
const STABLE_MS = 5 * 60_000

interface Kid { t: FakeTkWorkerTransport; got: ToTkWorker[]; exit: () => void; kills: number }

function harness(opts: { maxRestarts?: number; stableResetMs?: number; autoReady?: boolean } = {}) {
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
    expect(h.fork).toHaveBeenCalledTimes(3)   // degraded is for the run
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
