/**
 * service-supervisor.ts — the hooks gateway service.
 *
 * Its child's lifecycle (fork, exit, backoff, restart budget, desired state,
 * manual restart, shutdown) is the one Supervisor's (./supervisor.ts). What is
 * kept here is the hooks service's own: its health row and log ring, the
 * messages its child sends, the long-lived proxy, and what "out of budget"
 * means for hooks (fail open to the in-process gateway).
 */
import { HooksGatewayProxy } from './hooks-gateway-proxy'
import { Supervisor } from './supervisor'
import { createInitialHealth, computeThroughput } from '../../shared/service-health'
import { IPC } from '../../shared/ipc-channels'
import type { ServiceHealth, ServiceLogEntry, DiagnosticsSnapshot, ThroughputSample } from '../../shared/service-health'
import type { ChildTransport, FromChildMessage } from './service-transport'

export interface ForkedChild {
  transport: ChildTransport
  kill: () => void
  onExit: (cb: () => void) => void
}

export interface ServiceSupervisorOptions {
  forkChild: () => ForkedChild
  defaultPort: number
  emit: (channel: string, payload: unknown) => void
  now?: () => number   // injectable clock for tests
  maxRestarts?: number // fail open to in-process after this many failed restarts (default 5)
  stableResetMs?: number // a child up and running this long gives the restart budget back (default 5 min)
  // Logs v2 (Task 8): sink for transcript paths the child gateway lifts from hook
  // POSTs (earliest + exact discovery source). Routed to main's transcript binder.
  // Also handed to the in-process gateway on fail-open so discovery survives.
  onTranscriptPath?: (sessionId: string, path: string) => void
}

const LOG_CAP = 200

export class ServiceSupervisor {
  private opts: ServiceSupervisorOptions
  private now: () => number
  private health: ServiceHealth = createInitialHealth('hooks', 'Hooks gateway')
  // Last (eventsTotal, ts) sample throughput was computed against — see
  // computeThroughput. Reset to null on respawn so a restart's counter reset
  // can't read as a negative/huge rate.
  private prevThroughput: ThroughputSample | null = null
  private log: ServiceLogEntry[] = []
  private child: ForkedChild | null = null
  private proxy: HooksGatewayProxy | null = null
  private sup: Supervisor<ForkedChild>
  /** Set while the Settings toggle is turning the service on: a child forked
   *  then is a fresh start, whatever the restart count says. */
  private turningOn = false

  constructor(opts: ServiceSupervisorOptions) {
    this.opts = opts
    this.now = opts.now ?? (() => Date.now())
    this.sup = new Supervisor<ForkedChild>({
      forkChild: () => this.opts.forkChild(),
      maxRestarts: opts.maxRestarts,
      stableResetMs: opts.stableResetMs,
      onSpawn: (c) => this.onChildSpawned(c),
      onExit: (forkError) => this.onChildExit(forkError),
      // Out of budget. The supervisor has latched that BEFORE this runs, so
      // activateFallback()'s own child.kill() cannot re-enter the exit path
      // and log a spurious second 'falling open'.
      onExhausted: () => this.activateFallback(),
      onRestartCount: (restarts) => { this.health = { ...this.health, restartCount: restarts } },
      onBudgetRestored: () => {
        this.appendLog('info', 'budget-restored', 'hooks child stable; restart budget restored')
        this.pushHealth()
      },
    })
  }

  getDiagnosticsSnapshot(): DiagnosticsSnapshot {
    return { capturedAt: this.now(), services: [{ ...this.health }], log: [...this.log] }
  }

  getProxy(): HooksGatewayProxy | null { return this.proxy }

  private appendLog(level: ServiceLogEntry['level'], code: string, message: string): void {
    this.log.push({ ts: this.now(), serviceId: 'hooks', level, code, message })
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP)
  }

  // Push the live diagnostics snapshot to the renderer. Called after every
  // health mutation (and after a forwarded child log lands) so the health pill +
  // services console reflect reality without polling. Guarded: the window may be
  // gone during teardown.
  private pushHealth(): void {
    try { this.opts.emit(IPC.SERVICE_HEALTH_UPDATE, this.getDiagnosticsSnapshot()) } catch { /* window gone */ }
  }

  // The supervisor owns the SINGLE transport subscription (ChildTransport.onMessage
  // is last-writer-wins). It consumes bound/health/log itself and forwards the
  // proxy-relevant messages (event/dropped/permission-open) via handleChildMessage.
  private onChildMessage(m: FromChildMessage, from: ForkedChild): void {
    // Once we've failed open (or are shutting down) the child is dead; ignore any
    // messages still draining out of the pipe so a stale `bound`/`health` can't
    // flip the host back to utility-process and clobber the `degraded` state.
    if (this.sup.isShuttingDown() || this.proxy?.isInProcessFallback()) return
    if (m.type === 'bound') {
      // Turned off since this child was told to start (B8): the desired state
      // wins. The child is told to stop again and nothing is reported as bound.
      if (!this.sup.isWanted()) {
        try { this.child?.transport.post({ type: 'stop' }) } catch { /* child gone */ }
        return
      }
      // A replaced or exited child's `bound` still draining out of its pipe is
      // not the current child's: nothing is shown as bound, and no stable
      // period starts for a child that has not reported itself.
      if (!this.sup.markUp(from)) return
      this.health = {
        ...this.health,
        state: 'listening',
        host: 'utility-process',
        port: m.port,
        pid: m.pid,
        startedAt: this.health.startedAt ?? this.now(),
      }
      this.appendLog('info', 'bound', `bound :${m.port} pid=${m.pid}`)
      this.pushHealth()
    } else if (m.type === 'health') {
      // A replaced child's last heartbeat, still draining out of its pipe, is
      // not the current child's: its counters are not shown, and it is not the
      // sample the next throughput is measured against.
      if (from !== this.child) return
      const ts = this.now()
      const sample: ThroughputSample = { eventsTotal: m.eventsTotal, ts }
      const throughputPerSec = computeThroughput(this.prevThroughput, sample)
      this.prevThroughput = sample
      this.health = {
        ...this.health,
        inFlight: m.inFlight,
        eventsTotal: m.eventsTotal,
        dropsTotal: m.dropsTotal,
        throughputPerSec,
        childLoopStallsLastMin: m.stallsLastMin,
        lastHeartbeatAt: ts,
      }
      this.pushHealth()
    } else if (m.type === 'log') {
      this.log.push(m.entry)
      if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP)
      this.pushHealth()
    } else if (m.type === 'bind-failed') {
      // A replaced child's late bind failure is not the current child's. It is
      // logged; the current child is neither shown as crashed nor killed.
      if (from !== this.child) {
        this.appendLog('info', 'bind-failed-replaced', `a replaced hooks child failed to bind: ${m.error}`)
        this.pushHealth()
        return
      }
      if (this.sup.isWanted()) {
        this.health = { ...this.health, state: 'crashed', lastError: { message: m.error, ts: this.now() } }
        this.appendLog('error', 'bind-failed', `hooks child failed to bind: ${m.error}`)
      } else {
        // Turned off since this child was told to start (B8): nothing is
        // wanted bound, so this is not a failure to show. It stays stopped,
        // with no error left on the card.
        this.appendLog('info', 'bind-failed-while-off', `hooks child failed to bind while turned off: ${m.error}`)
      }
      this.pushHealth()
      // Escalate like an exit: the child is alive but useless. Kill it so the normal
      // exit-driven restart/backoff -> fail-open path runs (single-owner of that logic).
      // Do NOT forward bind-failed to the proxy.
      try { this.child?.kill() } catch { /* best-effort */ }
      return
    } else if (m.type === 'transcript-path') {
      // Logs v2 (Task 8): hand the lifted transcript path to the binder. A throw
      // in the sink must not break child-message routing.
      try { this.opts.onTranscriptPath?.(m.sid, m.path) } catch { /* sink must not break routing */ }
      return
    }
    // Forward `bound` to the proxy too so its status/HOOKS_STATUS broadcast and
    // start()-await-bound resolve in the production (supervisor-driven) path, not
    // just when the proxy self-subscribes.
    if (m.type === 'bound' || m.type === 'event' || m.type === 'dropped' || m.type === 'permission-open') {
      this.proxy?.handleChildMessage(m)
    }
  }

  start(): HooksGatewayProxy {
    this.sup.start()
    return this.proxy!
  }

  /** The Settings toggle, through the proxy's start()/stop() (B8). Off: the
   *  service shows as stopped and stays off (no crash restart, no manual
   *  restart) until it is turned on again. On: a child still running is simply
   *  told to start by the proxy, as before; with none running one is forked
   *  here, and its spawn path has already told it to start (returns true). */
  private setWanted(on: boolean): boolean {
    if (this.sup.isShuttingDown()) return false   // quitting: the proxy's stop() is only a goodbye
    if (this.sup.isWanted() === on) return this.sup.setWanted(on)
    if (!on) {
      this.sup.setWanted(false)
      this.health = { ...this.health, state: 'stopped' }
      this.appendLog('info', 'disabled', 'hooks gateway turned off')
      this.pushHealth()
      return false
    }
    // Said and shown BEFORE the supervisor acts, so the log reads in the order
    // things happened and whatever the fork does next has the last word: a
    // fresh child is shown as starting, a fork that fails as crashed (the
    // supervisor's backoff then brings the next one up; nothing is thrown at
    // the Settings toggle).
    this.health = { ...this.health, state: 'starting' }
    this.appendLog('info', 'enabled', 'hooks gateway turned on')
    this.turningOn = true
    const forked = this.sup.setWanted(true)
    this.turningOn = false
    this.pushHealth()
    return forked
  }

  /** User-requested restart of a service. In utility-process mode this kills the
   *  current child and immediately respawns, resetting the restart/backoff/fail-open
   *  counters so a manual restart is a clean slate (not counted against the fail-open
   *  budget). Declines in in-process fallback (live un-fail-open is deferred, spec §7)
   *  and during shutdown, and while turned off. The old child's kill fires its
   *  onExit, but the supervisor ignores a non-current child's exit so no spurious
   *  extra spawn occurs. */
  manualRestart(serviceId: string): { ok: boolean; reason?: string } {
    if (serviceId !== 'hooks') return { ok: false, reason: 'unknown-service' }
    if (this.sup.isShuttingDown()) return { ok: false, reason: 'shutting-down' }
    if (this.proxy?.isInProcessFallback()) return { ok: false, reason: 'fallback' } // live revert deferred (spec §7)
    // Turned off in Settings (B8): a restart must not turn it back on.
    if (!this.sup.isWanted()) return { ok: false, reason: 'disabled' }
    this.appendLog('info', 'manual-restart', 'manual restart requested')
    // Clean slate + kill + fork; the spawn path rebinds the long-lived proxy,
    // replays secrets, starts. A fork that fails is shown as crashed and the
    // supervisor's backoff forks the next.
    this.sup.restart()
    this.pushHealth()
    return { ok: true }
  }

  private onChildSpawned(c: ForkedChild): void {
    this.child = c
    if (!this.proxy) {
      this.proxy = new HooksGatewayProxy({
        transport: c.transport,
        defaultPort: this.opts.defaultPort,
        emit: this.opts.emit,
        selfSubscribe: false,
        onTranscriptPath: this.opts.onTranscriptPath,
        onDesiredState: (on) => this.setWanted(on),
      })
    } else {
      this.proxy.rebindTransport(c.transport)   // point the long-lived proxy at the NEW child
    }
    c.transport.onMessage((m) => this.onChildMessage(m, c))
    // S1 replay-before-listen: register the known secrets on the new child BEFORE it
    // binds/announces, so a request landing right after bind validates against a
    // populated secret map. The child applies `register` synchronously on receipt and
    // only binds on `start`, so the ordering holds.
    this.proxy.replaySecretsTo(c.transport)
    // Fresh child = fresh per-instance counters; forget the prior throughput
    // sample so the next health beat starts a clean interval (no negative rate).
    this.prevThroughput = null
    // Turned on again in Settings is a fresh start, not a restart, even when
    // earlier crashes are still counted.
    const restart = this.sup.getRestarts() > 0 && !this.turningOn
    this.health = { ...this.health, state: restart ? 'restarting' : 'starting' }
    this.appendLog('info', 'child-up', `hooks child forked (${this.turningOn ? 'turned on' : `restart ${this.sup.getRestarts()}`})`)
    this.pushHealth()
    void this.proxy.start()
  }

  private onChildExit(forkError?: Error): void {
    // Turned off (B8): the supervisor leaves it down, so this is not a crash
    // on its way to a restart. It stays shown as stopped.
    if (!this.sup.isWanted()) {
      this.health = { ...this.health, state: 'stopped' }
      this.appendLog('info', 'exited-while-off', 'hooks child exited while turned off; not restarted')
      this.pushHealth()
      return
    }
    if (forkError) {
      // The fork itself failed (a restart, or turned on again): shown as a
      // crash with the reason; the supervisor's backoff tries the next one.
      this.health = { ...this.health, state: 'crashed', lastError: { message: `fork failed: ${forkError.message}`, ts: this.now() } }
      this.appendLog('error', 'fork-failed', `hooks child could not be forked: ${forkError.message}`)
    } else {
      this.health = { ...this.health, state: 'crashed', lastError: { message: 'child exited', ts: this.now() } }
      this.appendLog('error', 'crashed', 'hooks child exited unexpectedly')
    }
    this.pushHealth()
  }

  /** Tear down the child path and run the gateway in-process (proxy.failOpen). */
  private activateFallback(): void {
    this.appendLog('warn', 'fallback', 'falling open to in-process gateway')
    this.child?.kill()   // free the port BEFORE the in-process gateway binds (mutual exclusion)
    this.health = { ...this.health, host: 'in-process-fallback', state: 'degraded', restartCount: this.sup.getRestarts() }
    this.proxy?.failOpen()
    this.pushHealth()
  }

  shutdown(): void {
    this.sup.shutdown()
    try { this.child?.kill() } catch { /* best-effort */ }
  }
}
