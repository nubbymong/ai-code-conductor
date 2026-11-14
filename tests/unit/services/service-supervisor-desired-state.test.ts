// The hooks service on the one supervisor (planning #307, B8 and B9).
// B8: the Settings toggle is the service's desired state. Off stays off: a
// crash restart and a Services-panel restart never start it again.
// B9: the restart budget is given back after a period of stable running, so a
// few unrelated crashes over days no longer push the service into fallback.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ServiceSupervisor } from '../../../src/main/services/service-supervisor'
import { FakeChildTransport } from '../../../src/main/services/service-transport'
import type { ToChildMessage } from '../../../src/main/services/service-transport'
import { IPC } from '../../../src/shared/ipc-channels'

const STABLE_MS = 5 * 60_000

interface Kid { t: FakeChildTransport; got: ToChildMessage[]; exit: () => void; kills: number }

function harness(opts: { maxRestarts?: number; stableResetMs?: number } = {}) {
  const kids: Kid[] = []
  const emitted: Array<{ channel: string; payload: unknown }> = []
  const fork = vi.fn(() => {
    const t = new FakeChildTransport()
    const kid: Kid = { t, got: [], exit: () => {}, kills: 0 }
    t.onChild((m) => kid.got.push(m))
    kids.push(kid)
    return { transport: t, kill: () => { kid.kills++ }, onExit: (cb: () => void) => { kid.exit = cb } }
  })
  const sup = new ServiceSupervisor({
    forkChild: fork, defaultPort: 0,   // 0: a fail-open bind takes any free port, never the app's own
    emit: (channel, payload) => emitted.push({ channel, payload }),
    ...opts,
  })
  const proxy = sup.start()
  const last = () => kids[kids.length - 1]
  const bound = (kid: Kid = last()) => kid.t.emitToParent({ type: 'bound', port: 19430, pid: 7 })
  const health = () => sup.getDiagnosticsSnapshot().services[0]
  const starts = (kid: Kid) => kid.got.filter((m) => m.type === 'start')
  return { sup, proxy, fork, kids, emitted, last, bound, health, starts }
}

describe('hooks service: desired state (B8)', () => {
  let h: ReturnType<typeof harness> | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(async () => {
    vi.useRealTimers()
    await h?.proxy.stop()   // close any in-process socket from fail-open
    h?.sup.shutdown()
    h = undefined
  })

  it('turned off, a crash does not start the service again', async () => {
    h = harness()
    h.bound()
    await h.proxy.stop()              // the Settings toggle, off
    h.kids[0].exit()                  // the child crashes while off
    vi.advanceTimersByTime(60_000)    // well past every backoff
    expect(h.fork).toHaveBeenCalledTimes(1)
    expect(h.kids.slice(1).flatMap((k) => h!.starts(k))).toEqual([])
    expect(h.health().state).toBe('stopped')
    expect(h.proxy.status()).toEqual({ enabled: false, listening: false, port: null })
  })

  it('turned off, a Services-panel restart is declined and starts nothing', async () => {
    h = harness()
    h.bound()
    await h.proxy.stop()
    const before = h.kids[0].got.length
    expect(h.sup.manualRestart('hooks')).toEqual({ ok: false, reason: 'disabled' })
    vi.advanceTimersByTime(60_000)
    expect(h.fork).toHaveBeenCalledTimes(1)
    expect(h.kids[0].kills).toBe(0)
    expect(h.kids[0].got.slice(before)).toEqual([])
    expect(h.health().state).toBe('stopped')
  })

  it('turning off shows the service as stopped, and says so to the renderer', async () => {
    h = harness()
    h.bound()
    expect(h.health().state).toBe('listening')
    h.emitted.length = 0
    await h.proxy.stop()
    expect(h.kids[0].got.at(-1)).toEqual({ type: 'stop' })   // the child is told, as before
    expect(h.health().state).toBe('stopped')
    expect(h.emitted.some((e) => e.channel === IPC.SERVICE_HEALTH_UPDATE)).toBe(true)
    expect(h.sup.getDiagnosticsSnapshot().log.at(-1)?.code).toBe('disabled')
  })

  it('turned on again with the child alive: the same child is told to start, nothing is forked', async () => {
    h = harness()
    h.bound()
    await h.proxy.stop()
    const p = h.proxy.start()
    expect(h.fork).toHaveBeenCalledTimes(1)
    expect(h.kids[0].kills).toBe(0)
    expect(h.kids[0].got.at(-1)).toEqual({ type: 'start', port: 0 })
    expect(h.starts(h.kids[0])).toHaveLength(2)   // the first start, and this one
    expect(h.health().state).toBe('starting')
    h.bound()
    expect(h.health().state).toBe('listening')
    expect((await p).listening).toBe(true)
  })

  it('turned on again after a crash while off: a fresh child, secrets first, started once', async () => {
    h = harness()
    const secret = h.proxy.registerSession('s1')
    h.bound()
    await h.proxy.stop()
    h.kids[0].exit()
    vi.advanceTimersByTime(60_000)
    const p = h.proxy.start()
    expect(h.fork).toHaveBeenCalledTimes(2)
    expect(h.kids[1].got).toEqual([
      { type: 'register', sid: 's1', secret },
      { type: 'start', port: 0 },
    ])
    // Not a crash restart: nothing is counted against the budget.
    expect(h.health().restartCount).toBe(0)
    expect(h.health().state).toBe('starting')
    expect(h.sup.getDiagnosticsSnapshot().log.slice(-2).map((l) => l.code)).toEqual(['child-up', 'enabled'])
    h.bound()
    expect((await p)).toEqual({ enabled: true, listening: true, port: 19430 })
    expect(h.health().state).toBe('listening')
  })

  it('turned off during a backoff, the pending restart is dropped; on again starts one child', async () => {
    h = harness()
    h.bound()
    h.kids[0].exit()                  // crash: a restart is 250ms away
    await h.proxy.stop()              // off inside the backoff window
    vi.advanceTimersByTime(60_000)
    expect(h.fork).toHaveBeenCalledTimes(1)
    expect(h.health().state).toBe('stopped')
    void h.proxy.start()
    expect(h.fork).toHaveBeenCalledTimes(2)
    expect(h.starts(h.kids[1])).toHaveLength(1)
    vi.advanceTimersByTime(60_000)
    expect(h.fork).toHaveBeenCalledTimes(2)   // and the dropped restart never fires
  })

  it('turned on during a backoff, the restart already on its way is the one start', async () => {
    h = harness()
    h.bound()
    await h.proxy.stop()
    void h.proxy.start()              // on again, child alive
    h.kids[0].exit()                  // crash while on: a restart is 250ms away
    void h.proxy.start()              // a second "on" inside the backoff window
    expect(h.fork).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(300)
    expect(h.fork).toHaveBeenCalledTimes(2)
    expect(h.starts(h.kids[1])).toHaveLength(1)
    expect(h.health().restartCount).toBe(1)
  })

  it('a child that reports bound after being turned off is told to stop, and stays stopped', async () => {
    h = harness()
    await h.proxy.stop()              // off before the child answered the first start
    const before = h.kids[0].got.length
    h.emitted.length = 0
    h.bound()                         // the late answer
    expect(h.kids[0].got.slice(before)).toEqual([{ type: 'stop' }])
    expect(h.health().state).toBe('stopped')
    expect(h.proxy.status().listening).toBe(false)
    expect(h.emitted.filter((e) => e.channel === IPC.HOOKS_STATUS)).toEqual([])
  })

  it('on (the default) a crash still restarts and starts the service, as before', () => {
    h = harness()
    h.bound()
    h.kids[0].exit()
    vi.advanceTimersByTime(300)
    expect(h.fork).toHaveBeenCalledTimes(2)
    expect(h.starts(h.kids[1])).toHaveLength(1)
    expect(h.health().state).toBe('restarting')
  })

  it('at quit the gateway stop that follows shutdown is only a goodbye: nothing is re-labelled', async () => {
    h = harness()
    h.bound()
    h.sup.shutdown()
    h.emitted.length = 0
    const logged = h.sup.getDiagnosticsSnapshot().log.length
    await h.proxy.stop()              // index.ts: getGateway()?.stop() after the supervisor's shutdown
    expect(h.kids[0].got.at(-1)).toEqual({ type: 'stop' })
    expect(h.health().state).toBe('listening')
    expect(h.sup.getDiagnosticsSnapshot().log).toHaveLength(logged)
    expect(h.emitted).toEqual([])
  })

  it('in fallback the toggle drives the in-process gateway and never forks', async () => {
    h = harness({ maxRestarts: 1 })
    for (let i = 0; i < 2; i++) { h.last().exit(); vi.advanceTimersByTime(5000) }
    expect(h.proxy.isInProcessFallback()).toBe(true)
    const forks = h.fork.mock.calls.length
    vi.useRealTimers()
    await h.proxy.stop()
    expect(h.proxy.status().listening).toBe(false)
    expect((await h.proxy.start()).listening).toBe(true)
    expect(h.fork).toHaveBeenCalledTimes(forks)
    expect(h.sup.manualRestart('hooks')).toEqual({ ok: false, reason: 'fallback' })
  })
})

describe('hooks service: the restart budget recovers (B9)', () => {
  let h: ReturnType<typeof harness> | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(async () => {
    vi.useRealTimers()
    await h?.proxy.stop()
    h?.sup.shutdown()
    h = undefined
  })

  it('a stable period gives the budget back and says so', () => {
    h = harness()
    h.bound()
    h.kids[0].exit()
    vi.advanceTimersByTime(300)
    h.bound()
    expect(h.health().restartCount).toBe(1)
    vi.advanceTimersByTime(STABLE_MS - 1)
    expect(h.health().restartCount).toBe(1)   // not before the period is up
    h.emitted.length = 0
    vi.advanceTimersByTime(1)
    expect(h.health().restartCount).toBe(0)
    expect(h.sup.getDiagnosticsSnapshot().log.at(-1)?.code).toBe('budget-restored')
    expect(h.emitted.some((e) => e.channel === IPC.SERVICE_HEALTH_UPDATE)).toBe(true)
  })

  it('crashes far apart never reach fallback', () => {
    h = harness({ maxRestarts: 2 })
    h.bound()
    for (let i = 0; i < 8; i++) {
      h.last().exit()
      vi.advanceTimersByTime(5000)       // past any backoff: the child is back
      h.bound()
      vi.advanceTimersByTime(STABLE_MS)  // and runs stably
    }
    expect(h.proxy.isInProcessFallback()).toBe(false)
    expect(h.fork).toHaveBeenCalledTimes(9)
    expect(h.health().state).toBe('listening')
  })

  it('the backoff starts over after a stable period', () => {
    h = harness()
    h.bound()
    h.kids[0].exit(); vi.advanceTimersByTime(300); h.bound()   // first crash: 250ms
    vi.advanceTimersByTime(STABLE_MS)
    h.last().exit()
    vi.advanceTimersByTime(300)          // 250ms again, not the second step's 1000ms
    expect(h.fork).toHaveBeenCalledTimes(3)
  })

  it('without a stable period the backoff climbs, as before', () => {
    h = harness()
    h.bound()
    h.kids[0].exit(); vi.advanceTimersByTime(300); h.bound()
    h.last().exit()
    vi.advanceTimersByTime(900)          // the second step is 1000ms
    expect(h.fork).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(100)
    expect(h.fork).toHaveBeenCalledTimes(3)
  })

  it('a child that comes up and dies inside the period still uses the budget up', () => {
    h = harness({ maxRestarts: 2 })
    for (let i = 0; i < 3; i++) {
      h.bound()
      vi.advanceTimersByTime(STABLE_MS - 5000)
      h.last().exit()
      vi.advanceTimersByTime(4999)
    }
    expect(h.proxy.isInProcessFallback()).toBe(true)
    expect(h.fork).toHaveBeenCalledTimes(3)
  })

  it('a child that never comes up gives nothing back', () => {
    h = harness()
    h.bound()
    h.kids[0].exit()
    vi.advanceTimersByTime(300)          // forked again, never bound
    vi.advanceTimersByTime(10 * STABLE_MS)
    expect(h.health().restartCount).toBe(1)
  })

  it('a second bound from the same child does not start the period over', async () => {
    h = harness()
    h.bound()
    h.kids[0].exit(); vi.advanceTimersByTime(300); h.bound()
    vi.advanceTimersByTime(STABLE_MS - 1000)
    await h.proxy.stop()
    void h.proxy.start()
    h.bound()                            // the same child, bound again
    vi.advanceTimersByTime(1000)
    expect(h.health().restartCount).toBe(0)
  })

  it('the period is the one given', () => {
    h = harness({ stableResetMs: 2000 })
    h.bound()
    h.kids[0].exit(); vi.advanceTimersByTime(300); h.bound()
    vi.advanceTimersByTime(1999)
    expect(h.health().restartCount).toBe(1)
    vi.advanceTimersByTime(1)
    expect(h.health().restartCount).toBe(0)
  })

  it('shutdown drops the period timer with the rest', () => {
    h = harness()
    h.bound()
    h.kids[0].exit(); vi.advanceTimersByTime(300); h.bound()
    h.sup.shutdown()
    vi.advanceTimersByTime(STABLE_MS)
    expect(h.health().restartCount).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
