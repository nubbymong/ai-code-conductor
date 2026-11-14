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

function harness(opts: { maxRestarts?: number; stableResetMs?: number } = {}) {
  const kids: Kid[] = []
  const emitted: Array<{ channel: string; payload: unknown }> = []
  const fork = vi.fn((): ForkedTranscriptsWorker => {
    const t = new FakeTranscriptsWorkerTransport()
    const kid: Kid = { t, exit: () => {}, kills: 0 }
    kids.push(kid)
    return { transport: t, kill: () => { kid.kills++ }, onExit: (cb: () => void) => { kid.exit = cb }, pid: 4242 }
  })
  const sup = new LogSupervisor({
    forkChild: fork, dbPath: '/tmp/fake-transcripts.db',
    emit: (channel, payload) => emitted.push({ channel, payload }),
    ...opts,
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
