/**
 * tk-supervisor.ts — the usage-index (tokenomics) service.
 *
 * The worker's lifecycle (fork, exit, backoff, restart budget and its recovery,
 * shutdown) is the one Supervisor's (src/main/services/supervisor.ts), shared
 * with the hooks and logging services. What is kept here is this service's
 * own: the worker's messages, the query layer, the index status, its row in the
 * Services panel, and what is
 * held for a worker that is not listening yet.
 */
import { logError, logWarn, logInfo } from '../debug-logger'
import { Supervisor } from '../services/supervisor'
import { IPC } from '../../shared/ipc-channels'
import { createInitialHealth, SERVICE_ID, SERVICE_LABEL } from '../../shared/service-health'
import type { DiagnosticsSnapshot, ServiceState } from '../../shared/service-health'
import type { ForkedTkWorker } from './fork-tokenomics-worker'
import type { ToTkWorker, FromTkWorker } from './tk-worker-transport'
import type { TkConfigDim, TkPricing, TkIndexStatus, TkSessionsRoot, TkAccountReread, TkAccountKey } from './tk-types'
import { tkSessionUuidOk, tkClaudeAccountKeyOk } from './tk-types'

export interface TokenomicsSupervisorOptions {
  forkChild: () => ForkedTkWorker
  dbPath: string
  pricing: Record<string, TkPricing>
  configs: TkConfigDim[]
  claudeProjectsDir: string
  codexSessionsDir: string
  /** WP2 (plan A13): the transcript folders of the app's Codex accounts,
   *  each with the account's key (usage track MP9). */
  codexRealmSessionsDirs?: TkSessionsRoot[]
  emit: (channel: string, payload: unknown) => void
  now?: () => number
  maxRestarts?: number
  /** A worker ready and running this long gives the restart budget back (default 5 min). */
  stableResetMs?: number
  queryTimeoutMs?: number
}

export interface TkIndexProgress { filesDone: number; filesTotal: number; eventsIngested: number; phase: string; accountReread?: TkAccountReread | null }
export interface TkIndexCompleteEvent { firstIndex: boolean; drained: boolean; filesFailed: number; eventsTotal: number }

/** Session attributions kept for the next worker that is ready (MP10),
 *  oldest dropped. */
const SESSION_ACCOUNTS_KEPT = 4096
const DEFAULT_QUERY_TIMEOUT_MS = 15_000

export class TokenomicsSupervisor {
  private worker: ForkedTkWorker | null = null
  private listening = false
  private sup: Supervisor<ForkedTkWorker>
  private pending = new Map<number, { resolve: (r: unknown[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private nextId = 1
  /** What a worker that is not listening yet is sent once it is: the latest
   *  message of each kind, in the order of their newest arrival. Bounded by the
   *  number of kinds (B9): each kind replaces the worker's whole state for it
   *  (or, for `reindex`, asks once for what one sweep does), so an older one
   *  of the same kind adds nothing. */
  private buffer: ToTkWorker[] = []
  private progressSubs = new Set<(p: TkIndexProgress) => void>()
  private completeSubs = new Set<(c: TkIndexCompleteEvent) => void>()
  private errorSubs = new Set<(s: TkIndexStatus) => void>()
  private lastProgress: TkIndexProgress = { filesDone: 0, filesTotal: 0, eventsIngested: 0, phase: 'initial' }
  private firstIndexComplete = false
  private lastEventsTotal = 0
  /** Files the last sweep could not read at all. Reported, never blocking. */
  private lastFilesFailed = 0
  private lastIndexAt: number | null = null
  /** MP9: the one-off account attribution, as the worker last reported it. */
  private lastAccountReread: TkAccountReread | null = null
  /** MP10: each Claude session's latest attribution, sent whole on each
   *  ready: to a worker that was not listening when it was made, and again
   *  to a restarted worker (one that died before storing it). */
  private sessionAccounts = new Map<string, TkAccountKey>()
  /** MP9 round 1 (Q-4): the Codex account folders have been named (given at
   *  construction, or set since); a restarted worker is told so. */
  private realmDirsKnown: boolean
  // Set when the worker reports an UNCORRELATED error (e.g. a failed DB open,
  // which leaves the worker alive but never `ready` — no exit, no restart). The
  // renderer consumes this so the tokenomics page can stop showing 'indexing'
  // forever and surface a fault instead of a perpetual spinner.
  private lastError: { message: string; ts: number } | null = null
  // For the Services row (getDiagnosticsSnapshot): a worker has been forked at
  // least once, when the current one was ready (none while it is down or has
  // not opened), when it was last heard from, and why the last one went away.
  private forked = false
  private readyAt: number | null = null
  private lastHeardAt = 0
  private lastExit: { message: string; ts: number } | null = null

  constructor(private opts: TokenomicsSupervisorOptions) {
    this.realmDirsKnown = Array.isArray(opts.codexRealmSessionsDirs)
    this.sup = new Supervisor<ForkedTkWorker>({
      forkChild: () => this.opts.forkChild(),
      maxRestarts: opts.maxRestarts,
      stableResetMs: opts.stableResetMs,
      // This service's rule, kept: a ready worker starts the backoff over at once.
      resetBackoffOnUp: true,
      onSpawn: (w) => this.onSpawned(w),
      onExit: (forkError) => this.onExit(forkError),
      // Out of budget: there is no fallback, so the index is degraded (queries
      // reject with degraded=true) until a restart is asked for from the
      // Services panel (manualRestart).
      onExhausted: () => { this.pushHealth() },
      onBudgetRestored: () => {
        logInfo('[tokenomics] worker stable; restart budget restored')
        this.pushHealth()
      },
    })
  }
  private now(): number { return this.opts.now ? this.opts.now() : Date.now() }
  /** Out of restarts: the index is down until a restart is asked for. */
  private get degraded(): boolean { return this.sup.isExhausted() }

  start(): void {
    if (this.worker || this.sup.isShuttingDown()) return
    this.sup.start()
  }

  private onSpawned(w: ForkedTkWorker): void {
    // Fresh worker, clean slate: a fatal error from a previous worker must not
    // keep the renderer's error banner latched after a successful restart.
    this.lastError = null
    this.worker = w
    this.listening = false
    this.forked = true
    // A new worker has no ready time until it is ready, so the row never counts
    // the age of the one it replaced.
    this.readyAt = null
    w.transport.onMessage((m) => this.onMessage(m, w))
    // MP10: the attributions kept are sent when this worker is ready (below).
    w.transport.post({
      type: 'open', dbPath: this.opts.dbPath, pricing: this.opts.pricing, configs: this.opts.configs,
      claudeProjectsDir: this.opts.claudeProjectsDir, codexSessionsDir: this.opts.codexSessionsDir,
      codexRealmSessionsDirs: this.opts.codexRealmSessionsDirs ?? [],
      codexRealmDirsKnown: this.realmDirsKnown,
    })
    this.pushHealth()
  }

  private onMessage(m: FromTkWorker, from: ForkedTkWorker): void {
    if (from === this.worker) this.lastHeardAt = this.now()
    switch (m.type) {
      case 'ready': {
        // A replaced or exited worker's `ready` still draining out of its pipe
        // is not the current worker's: nothing is sent to a worker that has
        // not opened, and no stable period starts.
        if (!this.sup.markUp(from)) return
        this.listening = true
        this.readyAt = this.now()
        // The DB's own record of a completed first index. Without this the
        // page said "Indexing usage data" on EVERY launch until a fresh sweep
        // completed - and stayed there for hours when the sweep wedged on the
        // Codex tail, over a database that had been complete since July.
        if (m.firstIndexComplete) { this.firstIndexComplete = true; this.lastEventsTotal = m.eventsTotal }
        const buf = this.buffer
        this.buffer = []
        for (const msg of buf) this.worker?.transport.post(msg)
        // MP10: every attribution kept, once (the index ignores one it
        // already has): the latest per session, within the bound.
        for (const [sessionId, accountKey] of this.sessionAccounts) this.worker?.transport.post({ type: 'set-session-account', sessionId, accountKey })
        this.pushHealth()
        return
      }
      case 'index-progress': {
        this.lastAccountReread = m.accountReread ?? null
        this.lastProgress = { filesDone: m.filesDone, filesTotal: m.filesTotal, eventsIngested: m.eventsIngested, phase: m.phase, accountReread: this.lastAccountReread }
        for (const cb of this.progressSubs) { try { cb(this.lastProgress) } catch { /* ignore */ } }
        return
      }
      case 'index-complete': {
        // A sweep FINISHING is not a first index. With a per-tick byte budget a
        // multi-GB rollout needs tens of sweeps, so latching on the message
        // itself put the dashboard up over a fraction of the user's spend and
        // called it complete. `drained` is the worker saying every file it
        // visited was actually read to the end.
        if (m.drained) this.firstIndexComplete = true
        this.lastEventsTotal = m.eventsTotal
        this.lastFilesFailed = m.filesFailed
        this.lastIndexAt = this.now()
        for (const cb of this.completeSubs) { try { cb({ firstIndex: m.firstIndex, drained: m.drained, filesFailed: m.filesFailed, eventsTotal: m.eventsTotal }) } catch { /* ignore */ } }
        return
      }
      case 'health': { this.lastEventsTotal = m.eventsTotal; return }
      case 'query-result': {
        const p = this.pending.get(m.id)
        if (p) { this.pending.delete(m.id); clearTimeout(p.timer); p.resolve(m.rows) }
        return
      }
      case 'error': {
        if (m.id !== undefined) {
          const p = this.pending.get(m.id)
          if (p) { this.pending.delete(m.id); clearTimeout(p.timer); p.reject(new Error(m.message)) }
          return
        }
        // Uncorrelated error: the worker stays alive (e.g. a failed DB open never
        // posts `ready`, so onExit/restart never fires and queries reject forever).
        // Mirror LogSupervisor: log it loudly and record a fatal state so the UI
        // can stop showing 'indexing' instead of spinning silently forever.
        logError('[tokenomics] worker error:', m.message)
        // A worker that a manual restart has already replaced: its late error
        // is not the new worker's, so nothing is recorded against that one.
        if (this.worker !== null && from !== this.worker) return
        this.lastError = { message: m.message, ts: this.now() }
        const status = this.getIndexStatus()
        for (const cb of this.errorSubs) { try { cb(status) } catch { /* ignore */ } }
        this.pushHealth()
        return
      }
      case 'log': {
        // Forward the worker's own logs to the main debug log (were discarded).
        const lvl = m.entry.level
        const fn = lvl === 'error' ? logError : lvl === 'warn' ? logWarn : logInfo
        fn('[tokenomics worker]', m.entry.message)
        return
      }
    }
  }

  query(kind: string, args: Record<string, unknown>): Promise<unknown[]> {
    if (this.sup.isShuttingDown()) return Promise.reject(new Error('tokenomics supervisor shutting down'))
    if (!this.listening || !this.worker) return Promise.reject(new Error(`tokenomics worker not ready (degraded=${this.degraded})`))
    const id = this.nextId++
    return new Promise<unknown[]>((resolve, reject) => {
      const timeoutMs = this.opts.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`tokenomics query timed out after ${timeoutMs}ms (kind=${kind})`)) }, timeoutMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.worker!.transport.post({ type: 'query', id, kind, args })
    })
  }

  private sendOrBuffer(msg: ToTkWorker): void {
    if (this.listening && this.worker) { this.worker.transport.post(msg); return }
    const held = this.buffer.findIndex((m) => m.type === msg.type)
    if (held !== -1) this.buffer.splice(held, 1)
    this.buffer.push(msg)
  }

  setPricing(pricing: Record<string, TkPricing>): void { this.opts.pricing = pricing; this.sendOrBuffer({ type: 'set-pricing', pricing }) }
  setConfigs(configs: TkConfigDim[]): void { this.opts.configs = configs; this.sendOrBuffer({ type: 'set-configs', configs }) }
  /** Kept for a restarted worker's `open`, and sent to the running one. */
  setCodexRealmSessionsDirs(dirs: TkSessionsRoot[]): void {
    const copy = dirs.map((d) => ({ dir: d.dir, accountKey: d.accountKey }))
    this.opts.codexRealmSessionsDirs = copy
    this.realmDirsKnown = true
    this.sendOrBuffer({ type: 'set-codex-realm-dirs', dirs: copy.map((d) => ({ ...d })) })
  }
  reindex(): void { this.sendOrBuffer({ type: 'reindex' }) }
  /** Usage track MP10: a Claude session id and the account it runs under
   *  now. The same again sends nothing; another account applies from then
   *  on (MP10 round 1); anything not well formed is dropped. Sent at once to
   *  a worker that listens; otherwise only kept (the latest per session,
   *  within the bound) for the next ready to send. */
  setSessionAccount(sessionId: string, accountKey: TkAccountKey): void {
    if (this.sup.isShuttingDown() || !tkSessionUuidOk(sessionId) || !tkClaudeAccountKeyOk(accountKey)) return
    if (this.sessionAccounts.get(sessionId) === accountKey) return
    this.sessionAccounts.delete(sessionId)
    this.sessionAccounts.set(sessionId, accountKey)
    if (this.sessionAccounts.size > SESSION_ACCOUNTS_KEPT) {
      const oldest = this.sessionAccounts.keys().next()
      if (!oldest.done) this.sessionAccounts.delete(oldest.value)
    }
    if (this.listening && this.worker) this.worker.transport.post({ type: 'set-session-account', sessionId, accountKey })
  }

  onIndexProgress(cb: (p: TkIndexProgress) => void): () => void { this.progressSubs.add(cb); return () => { this.progressSubs.delete(cb) } }
  onIndexComplete(cb: (c: TkIndexCompleteEvent) => void): () => void { this.completeSubs.add(cb); return () => { this.completeSubs.delete(cb) } }
  /** Fires with the fault status when the worker reports an uncorrelated error
   *  (e.g. a failed DB open). The handler layer forwards it to the renderer. */
  onIndexError(cb: (s: TkIndexStatus) => void): () => void { this.errorSubs.add(cb); return () => { this.errorSubs.delete(cb) } }

  getIndexStatus(): TkIndexStatus {
    const error = this.lastError?.message ?? null
    return {
      firstIndexComplete: this.firstIndexComplete,
      // A fatal error means the index will never complete on its own; stop
      // reporting 'indexing' so the page leaves its perpetual spinner.
      indexing: !this.firstIndexComplete && error === null,
      filesDone: this.lastProgress.filesDone,
      filesTotal: this.lastProgress.filesTotal,
      eventsTotal: this.lastEventsTotal,
      filesFailed: this.lastFilesFailed,
      lastIndexAt: this.lastIndexAt,
      error,
      accountReread: this.lastAccountReread,
    }
  }

  /** The Services row (src/main/services/service-registry.ts): where the
   *  worker is now. This service keeps no log ring of its own (its lines go to
   *  the main debug log), so the snapshot's log is empty. */
  getDiagnosticsSnapshot(): DiagnosticsSnapshot {
    const row = createInitialHealth(SERVICE_ID.tokenomics, SERVICE_LABEL.tokenomics, 'utility-process')
    row.state = this.rowState()
    row.startedAt = this.readyAt
    // Queries sent to the worker and not answered yet.
    row.inFlight = this.pending.size
    row.eventsTotal = this.lastEventsTotal
    row.restartCount = this.sup.getRestarts()
    row.lastError = this.lastError ?? this.lastExit
    row.lastHeartbeatAt = this.lastHeardAt
    return { capturedAt: this.now(), services: [row], log: [] }
  }

  private rowState(): ServiceState {
    if (this.sup.isShuttingDown() || !this.forked) return 'stopped'
    if (this.sup.isExhausted()) return 'degraded'   // out of restarts, and there is no fallback
    if (!this.worker) return 'crashed'              // exited: the next one is forked after the backoff
    if (this.listening) return 'listening'
    if (this.lastError) return 'degraded'           // alive but never ready (its database did not open)
    return this.sup.getRestarts() > 0 ? 'restarting' : 'starting'
  }

  /** Tell the Services view the row changed. Goes through the same channel as
   *  the hooks and logging rows; the window may be gone during teardown. */
  private pushHealth(): void {
    try { this.opts.emit(IPC.SERVICE_HEALTH_UPDATE, this.getDiagnosticsSnapshot()) } catch { /* window gone */ }
  }

  /** A restart asked for from the Services panel. The restart budget and the
   *  backoff start over (a spent budget is forgiven), the worker is replaced,
   *  and the new one is sent `open` again, so it re-opens the index and picks
   *  up where the files are now. Queries the old worker had not answered are
   *  rejected at once, because it will not answer them. Declined while
   *  shutting down, and on a supervisor that was never started: its row reads
   *  stopped, the panel offers no restart for a stopped row, and this agrees,
   *  so a restart never becomes a first start. */
  manualRestart(serviceId: string): { ok: boolean; reason?: string } {
    if (serviceId !== SERVICE_ID.tokenomics) return { ok: false, reason: 'unknown-service' }
    if (!this.forked) return { ok: false, reason: 'stopped' }
    const refusal = this.sup.restartRefusal()
    if (refusal !== null) return { ok: false, reason: refusal }
    logInfo('[tokenomics] manual restart requested')
    this.listening = false
    this.rejectPending('tokenomics worker restarted')
    this.sup.restart()
    this.pushHealth()
    return { ok: true }
  }

  private rejectPending(reason: string): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)) }
    this.pending.clear()
  }

  private onExit(forkError?: Error): void {
    if (forkError) logError('[tokenomics] worker could not be forked:', forkError.message)
    this.listening = false
    this.readyAt = null
    this.rejectPending('tokenomics worker exited')
    this.worker = null
    this.lastExit = { message: forkError ? `fork failed: ${forkError.message}` : 'worker exited', ts: this.now() }
    this.pushHealth()
    // The supervisor forks the next worker after the backoff, or stops until a restart is asked for.
  }

  shutdown(): void {
    this.sup.shutdown()
    this.rejectPending('tokenomics supervisor shut down')
    try { this.worker?.transport.post({ type: 'shutdown' }) } catch { /* ignore */ }
    try { this.worker?.kill() } catch { /* ignore */ }
    this.worker = null
    this.listening = false
    // The row reads stopped from here. Say so: nothing else would tell the
    // Services view when the service is shut down while the app keeps running.
    this.pushHealth()
  }
}
