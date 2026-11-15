import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ServiceSupervisor } from '../../../src/main/services/service-supervisor'
import { FakeChildTransport } from '../../../src/main/services/service-transport'

describe('ServiceSupervisor lifecycle', () => {
  let sup: ServiceSupervisor | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(async () => {
    vi.useRealTimers()
    await sup?.getProxy()?.stop()   // close any in-process socket from fail-open
    sup = undefined
  })

  it('restarts the child on unexpected exit (forkChild called again after backoff)', () => {
    let exitCb: (() => void) | null = null
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {} })
    sup.start()
    expect(fork).toHaveBeenCalledTimes(1)
    exitCb?.()                       // simulate crash
    vi.advanceTimersByTime(300)      // first backoff (250ms)
    expect(fork).toHaveBeenCalledTimes(2)
    expect(sup.getDiagnosticsSnapshot().services[0].restartCount).toBe(1)
  })

  it('fails open to in-process after N failed restarts', () => {
    let exitCb: (() => void) | null = null
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {}, maxRestarts: 2 })
    sup.start()
    for (let i = 0; i < 3; i++) { exitCb?.(); vi.advanceTimersByTime(5000) }
    expect(sup.getProxy()?.isInProcessFallback()).toBe(true)
    const h = sup.getDiagnosticsSnapshot().services[0]
    expect(h.host).toBe('in-process-fallback')
    expect(h.state).toBe('degraded')
  })

  it('fail-open drops the dead child process id and event-loop stalls from the row', () => {
    let exitCb: (() => void) | null = null
    let curT: FakeChildTransport | null = null
    const fork = vi.fn(() => {
      curT = new FakeChildTransport()
      return { transport: curT, kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }
    })
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {}, maxRestarts: 1 })
    sup.start()
    curT!.emitToParent({ type: 'bound', port: 19430, pid: 4242 })
    curT!.emitToParent({ type: 'health', inFlight: 0, eventsTotal: 5, dropsTotal: 0, stallsLastMin: 3 })
    const live = sup.getDiagnosticsSnapshot().services[0]
    expect([live.pid, live.childLoopStallsLastMin]).toEqual([4242, 3])
    for (let i = 0; i < 2; i++) { exitCb?.(); vi.advanceTimersByTime(5000) }   // -> fallback
    const h = sup.getDiagnosticsSnapshot().services[0]
    expect(h.host).toBe('in-process-fallback')
    // The child is gone: its process id and its stalls are not the gateway's now.
    expect([h.pid, h.childLoopStallsLastMin]).toEqual([null, 0])
  })

  describe('the row follows the current child', () => {
    let clock = 1000
    let exitCb: (() => void) | null = null
    let curT: FakeChildTransport | null = null
    let forks = 0
    /** Fork number `failOn` (1-based) throws; every other fork gives a fresh child. */
    function build(failOn = 0) {
      clock = 1000; exitCb = null; curT = null; forks = 0
      const fork = vi.fn(() => {
        forks++
        if (forks === failOn) throw new Error('spawn refused')
        curT = new FakeChildTransport()
        return { transport: curT, kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }
      })
      sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {}, now: () => clock })
      sup.start()
    }
    const row = () => sup!.getDiagnosticsSnapshot().services[0]
    const bound = (pid: number) => curT!.emitToParent({ type: 'bound', port: 19430, pid })

    it('a crash leaves no pid, uptime or stalls; the next bound starts the uptime over', () => {
      build()
      bound(4242)
      curT!.emitToParent({ type: 'health', inFlight: 0, eventsTotal: 5, dropsTotal: 0, stallsLastMin: 3 })
      expect([row().pid, row().startedAt, row().childLoopStallsLastMin]).toEqual([4242, 1000, 3])
      clock = 9000
      exitCb?.()
      expect(row()).toMatchObject({ state: 'crashed', pid: null, startedAt: null, childLoopStallsLastMin: 0, lastError: { message: 'child exited' } })
      vi.advanceTimersByTime(300)   // first backoff: the next child is forked, not bound yet
      expect(row()).toMatchObject({ state: 'restarting', pid: null, startedAt: null, childLoopStallsLastMin: 0, restartCount: 1, eventsTotal: 5 })
      clock = 20000
      bound(5252)
      expect(row()).toMatchObject({ state: 'listening', pid: 5252, startedAt: 20000 })
    })

    it('a Services-panel restart shows the new child as starting, with no pid or uptime until it binds', () => {
      build()
      bound(4242)
      clock = 5000
      expect(sup!.manualRestart('hooks')).toEqual({ ok: true })
      expect(row()).toMatchObject({ state: 'starting', pid: null, startedAt: null, childLoopStallsLastMin: 0 })
      clock = 6000
      bound(77)
      expect(row()).toMatchObject({ state: 'listening', pid: 77, startedAt: 6000 })
    })

    it('a fork that fails leaves no pid or uptime of the child it was to replace', () => {
      build(2)
      bound(4242)
      clock = 5000
      sup!.manualRestart('hooks')   // the second fork throws
      expect(forks).toBe(2)
      expect(row()).toMatchObject({ state: 'crashed', pid: null, startedAt: null, lastError: { message: 'fork failed: spawn refused' } })
    })

    it('a child that exits while the service is turned off leaves no pid or uptime on the stopped row', async () => {
      build()
      bound(4242)
      await sup!.getProxy()!.stop()   // the Settings toggle, off
      exitCb?.()
      expect(row()).toMatchObject({ state: 'stopped', pid: null, startedAt: null, childLoopStallsLastMin: 0 })
    })
  })

  it('bind-failed escalates to a restart (kill -> exit -> backoff -> re-fork)', () => {
    let exitCb: (() => void) | null = null
    let curT: FakeChildTransport | null = null
    // kill() fires the stored exit callback (as a real utilityProcess does), so the
    // bind-failed handler's child.kill() drives the exit-based restart path end-to-end.
    const fork = vi.fn(() => {
      curT = new FakeChildTransport()
      return { transport: curT, kill: () => exitCb?.(), onExit: (cb: () => void) => { exitCb = cb } }
    })
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {} })
    sup.start()
    expect(fork).toHaveBeenCalledTimes(1)
    curT!.emitToParent({ type: 'bind-failed', error: 'bind-failed after 5 attempts' })
    expect(sup.getDiagnosticsSnapshot().services[0].state).toBe('crashed')
    vi.advanceTimersByTime(300)   // first backoff (250ms)
    expect(fork).toHaveBeenCalledTimes(2)   // escalation re-forked the child
    expect(sup.getDiagnosticsSnapshot().services[0].restartCount).toBe(1)
  })

  it('ignores the self-kill exit after fail-open (single fallback log, no re-entry)', () => {
    let exitCb: (() => void) | null = null
    // kill() synchronously fires the stored exit callback — the WORST case for
    // re-entry (the real utilityProcess fires it async). The supervisor's exhausted latch (set
    // before activateFallback runs its kill) must suppress it either way.
    const fork = vi.fn(() => ({
      transport: new FakeChildTransport(),
      kill: () => { exitCb?.() },
      onExit: (cb: () => void) => { exitCb = cb },
    }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {}, maxRestarts: 1 })
    sup.start()
    for (let i = 0; i < 2; i++) { exitCb?.(); vi.advanceTimersByTime(5000) }
    expect(sup.getProxy()?.isInProcessFallback()).toBe(true)
    const fallbackLogs = sup.getDiagnosticsSnapshot().log.filter((l) => l.code === 'fallback')
    expect(fallbackLogs).toHaveLength(1)   // the kill-triggered re-entry was ignored
  })

  it('does NOT restart when shutting down', () => {
    let exitCb: (() => void) | null = null
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {} })
    sup.start(); sup.shutdown(); exitCb?.(); vi.advanceTimersByTime(5000)
    expect(fork).toHaveBeenCalledTimes(1)
  })

  it('shutdown() during the backoff window cancels the pending restart (no resurrection)', () => {
    let exitCb: (() => void) | null = null
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {} })
    sup.start()
    exitCb?.()              // crash -> schedules a backoff restart
    sup.shutdown()          // races the backoff timer
    vi.advanceTimersByTime(5000)
    expect(fork).toHaveBeenCalledTimes(1)   // the pending restart was cancelled
  })

  it('manualRestart (utility mode) kills + respawns and resets counters', () => {
    let exitCb: (() => void) | null = null
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {} })
    sup.start()
    exitCb?.(); vi.advanceTimersByTime(300)      // one crash -> restartCount 1
    expect(sup.getDiagnosticsSnapshot().services[0].restartCount).toBe(1)
    const r = sup.manualRestart('hooks')
    expect(r.ok).toBe(true)
    expect(fork).toHaveBeenCalledTimes(3)        // initial + backoff respawn + manual respawn
    expect(sup.getDiagnosticsSnapshot().services[0].restartCount).toBe(0)  // counters reset
  })

  it('manualRestart returns {ok:false, reason:"fallback"} when in in-process fallback', () => {
    let exitCb: (() => void) | null = null
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {}, maxRestarts: 1 })
    sup.start()
    for (let i = 0; i < 2; i++) { exitCb?.(); vi.advanceTimersByTime(5000) }   // -> fallback
    expect(sup.getProxy()?.isInProcessFallback()).toBe(true)
    const forkCalls = fork.mock.calls.length
    const r = sup.manualRestart('hooks')
    expect(r).toEqual({ ok: false, reason: 'fallback' })
    expect(fork).toHaveBeenCalledTimes(forkCalls)   // no respawn in fallback
  })

  it('manualRestart returns {ok:false, reason:"shutting-down"} after shutdown', () => {
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: () => {} }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {} })
    sup.start()
    sup.shutdown()
    expect(sup.manualRestart('hooks')).toEqual({ ok: false, reason: 'shutting-down' })
  })

  it('routes a child transcript-path message to onTranscriptPath (Logs v2 T8)', () => {
    let curT: FakeChildTransport | null = null
    const fork = vi.fn(() => { curT = new FakeChildTransport(); return { transport: curT, kill: () => {}, onExit: () => {} } })
    const got: Array<{ sid: string; path: string }> = []
    sup = new ServiceSupervisor({
      forkChild: fork, defaultPort: 0, emit: () => {},
      onTranscriptPath: (sid, path) => got.push({ sid, path }),
    })
    sup.start()
    curT!.emitToParent({ type: 'transcript-path', sid: 's1', path: '/home/.claude/projects/p/conv.jsonl' })
    expect(got).toEqual([{ sid: 's1', path: '/home/.claude/projects/p/conv.jsonl' }])
  })
})
