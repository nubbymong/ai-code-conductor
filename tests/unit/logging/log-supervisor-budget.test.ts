// The logging service on the one supervisor (planning #307, B9): the restart
// budget is given back after a period of stable running, so a few unrelated
// crashes over days no longer leave session logging degraded for the run.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LogSupervisor } from '../../../src/main/logging/log-supervisor'
import type { ForkedTranscriptsWorker } from '../../../src/main/logging/fork-transcripts-worker'
import { FakeTranscriptsWorkerTransport } from '../../../src/main/logging/log-worker-transport'
import { IPC } from '../../../src/shared/ipc-channels'

const STABLE_MS = 5 * 60_000

interface Kid { t: FakeTranscriptsWorkerTransport; exit: () => void; kills: number }

function harness(opts: { maxRestarts?: number; stableResetMs?: number; killExits?: boolean } = {}) {
  const { killExits = false, ...supOpts } = opts
  const kids: Kid[] = []
  const emitted: Array<{ channel: string; payload: unknown }> = []
  const fork = vi.fn((): ForkedTranscriptsWorker => {
    const t = new FakeTranscriptsWorkerTransport()
    const kid: Kid = { t, exit: () => {}, kills: 0 }
    kids.push(kid)
    return { transport: t, kill: () => { kid.kills++; if (killExits) kid.exit() }, onExit: (cb: () => void) => { kid.exit = cb }, pid: 4242 }
  })
  const sup = new LogSupervisor({
    forkChild: fork, dbPath: '/tmp/fake-transcripts.db',
    emit: (channel, payload) => emitted.push({ channel, payload }),
    ...supOpts,
  })
  sup.start()
  const last = () => kids[kids.length - 1]
  const ready = () => last().t.emitToMain({ type: 'ready' })
  const health = () => sup.getDiagnosticsSnapshot().services[0]
  return { sup, fork, kids, emitted, last, ready, health }
}

describe('logging service: the restart budget recovers (B9)', () => {
  let h: ReturnType<typeof harness> | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { h?.sup.shutdown(); h = undefined; vi.useRealTimers() })

  it('a stable period gives the budget back and says so', () => {
    h = harness()
    h.ready()
    h.last().exit()
    vi.advanceTimersByTime(300)
    h.ready()
    expect(h.health().restartCount).toBe(1)
    vi.advanceTimersByTime(STABLE_MS - 1)
    expect(h.health().restartCount).toBe(1)
    h.emitted.length = 0
    vi.advanceTimersByTime(1)
    expect(h.health().restartCount).toBe(0)
    expect(h.health().state).toBe('listening')
    expect(h.sup.getDiagnosticsSnapshot().log.at(-1)?.code).toBe('budget-restored')
    expect(h.emitted.some((e) => e.channel === IPC.SERVICE_HEALTH_UPDATE)).toBe(true)
  })

  it('crashes far apart never degrade logging for the run', () => {
    h = harness({ maxRestarts: 2 })
    h.ready()
    for (let i = 0; i < 8; i++) {
      h.last().exit()
      vi.advanceTimersByTime(5000)
      h.ready()
      vi.advanceTimersByTime(STABLE_MS)
    }
    expect(h.fork).toHaveBeenCalledTimes(9)
    expect(h.health().state).toBe('listening')
  })

  it('a worker that opens and dies inside the period still uses the budget up', () => {
    h = harness({ maxRestarts: 2 })
    for (let i = 0; i < 3; i++) {
      h.ready()
      vi.advanceTimersByTime(STABLE_MS - 5000)
      h.last().exit()
      vi.advanceTimersByTime(4999)
    }
    expect(h.fork).toHaveBeenCalledTimes(3)
    expect(h.health().state).toBe('degraded')
  })

  it('a worker that never opens gives nothing back', () => {
    h = harness()
    h.ready()
    h.last().exit()
    vi.advanceTimersByTime(300)
    vi.advanceTimersByTime(10 * STABLE_MS)
    expect(h.health().restartCount).toBe(1)
  })

  it('without a stable period the backoff climbs, as before (a ready does not reset it)', () => {
    h = harness()
    h.ready()
    h.last().exit(); vi.advanceTimersByTime(300); h.ready()
    h.last().exit()
    vi.advanceTimersByTime(900)          // the second step is 1000ms
    expect(h.fork).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(100)
    expect(h.fork).toHaveBeenCalledTimes(3)
  })

  it('the period is the one given', () => {
    h = harness({ stableResetMs: 2000 })
    h.ready()
    h.last().exit(); vi.advanceTimersByTime(300); h.ready()
    vi.advanceTimersByTime(1999)
    expect(h.health().restartCount).toBe(1)
    vi.advanceTimersByTime(1)
    expect(h.health().restartCount).toBe(0)
  })

  it('a Services-panel restart still works, and starts the period over', () => {
    h = harness()
    h.ready()
    h.last().exit(); vi.advanceTimersByTime(300); h.ready()
    vi.advanceTimersByTime(STABLE_MS - 1000)
    expect(h.sup.manualRestart('logging')).toEqual({ ok: true })
    expect(h.fork).toHaveBeenCalledTimes(3)
    expect(h.health().restartCount).toBe(0)
    expect(h.kids[1].kills).toBe(1)
    h.ready()                                                 // the new worker is up
    h.last().exit(); vi.advanceTimersByTime(300); h.ready()   // one crash after the manual restart
    vi.advanceTimersByTime(STABLE_MS - 1)
    expect(h.health().restartCount).toBe(1)   // the old period did not carry over
    vi.advanceTimersByTime(1)
    expect(h.health().restartCount).toBe(0)
  })

  it('shutdown leaves no timer behind', () => {
    h = harness()
    h.ready()
    h.last().exit(); vi.advanceTimersByTime(300); h.ready()
    h.sup.shutdown()
    vi.advanceTimersByTime(STABLE_MS)
    expect(h.health().restartCount).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

// Review round: a replaced worker's late ready, and a fork that fails.
describe('logging service: a replaced worker\'s late ready', () => {
  let h: ReturnType<typeof harness> | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { h?.sup.shutdown(); h = undefined; vi.useRealTimers() })

  it('after crashes: nothing is shown as listening, nothing is replayed, and no budget comes back', () => {
    h = harness()
    h.ready()
    h.last().exit(); vi.advanceTimersByTime(300)      // worker 2: never ready
    h.last().exit(); vi.advanceTimersByTime(1100)     // worker 3: never ready
    expect(h.health().restartCount).toBe(2)
    h.sup.runEnd('s1', 1, 'exited')                   // held until a worker has opened the DB
    h.emitted.length = 0
    h.kids[1].t.emitToMain({ type: 'ready' })         // worker 2's ready, still draining out of its pipe
    expect(h.health().state).toBe('restarting')
    expect(h.last().t.workerMessages.map((m) => m.type)).toEqual(['open'])
    expect(h.emitted).toEqual([])
    vi.advanceTimersByTime(STABLE_MS + 10)
    expect(h.health().restartCount).toBe(2)
    expect(h.sup.getDiagnosticsSnapshot().log.map((l) => l.code)).not.toContain('budget-restored')
    h.ready()                                         // the current worker's own ready is taken
    expect(h.health().state).toBe('listening')
    expect(h.last().t.workerMessages.map((m) => m.type)).toEqual(['open', 'run-end'])
  })

  it('after a Services-panel restart: the new worker is still starting', async () => {
    h = harness()
    h.ready()
    expect(h.sup.manualRestart('logging')).toEqual({ ok: true })
    h.kids[0].t.emitToMain({ type: 'ready' })
    expect(h.health().state).toBe('starting')
    await expect(h.sup.query('runs', {})).rejects.toThrow('not available')
    h.ready()
    expect(h.health().state).toBe('listening')
  })
})

describe('logging service: a fork that fails', () => {
  let h: ReturnType<typeof harness> | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { h?.sup.shutdown(); h = undefined; vi.useRealTimers() })

  it('on a Services-panel restart: shown as crashed with the reason, then brought up by the backoff', () => {
    h = harness({ killExits: true })
    h.ready()
    h.fork.mockImplementationOnce(() => { throw new Error('no fork') })
    expect(h.sup.manualRestart('logging')).toEqual({ ok: true })
    expect(h.kids[0].kills).toBe(1)
    expect(h.health().state).toBe('crashed')
    expect(h.health().lastError?.message).toBe('fork failed: no fork')
    expect(h.sup.getDiagnosticsSnapshot().log.at(-1)).toMatchObject({
      level: 'error', code: 'fork-failed', message: 'logging worker could not be forked: no fork',
    })
    vi.advanceTimersByTime(300)
    expect(h.fork).toHaveBeenCalledTimes(3)
    expect(h.health().state).toBe('restarting')
    h.ready()
    expect(h.health().state).toBe('listening')
  })

  it('an ordinary crash is still worded as one', () => {
    h = harness()
    h.ready()
    h.last().exit()
    expect(h.health().lastError?.message).toBe('worker exited')
    expect(h.sup.getDiagnosticsSnapshot().log.at(-1)).toMatchObject({
      level: 'error', code: 'crashed', message: 'logging worker exited unexpectedly',
    })
  })
})
