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
import type { DiagnosticsSnapshot, ServiceMeasured, ServiceState } from '../../shared/service-health'
import { createProcessCpuSampler } from '../services/process-cpu'
import type { ProcessCpuMetric, ProcessCpuSampler } from '../services/process-cpu'
import type { ForkedTkWorker } from './fork-tokenomics-worker'
import type { ToTkWorker, FromTkWorker } from './tk-worker-transport'
import type { TkConfigDim, TkPricing, TkIndexStatus, TkSessionsRoot, TkAccountReread, TkAccountKey, TkWalkCount, TkWalkStats } from './tk-types'
import { tkSessionUuidOk, tkClaudeAccountKeyOk, TK_SESSION_ACCOUNTS_KEPT } from './tk-types'

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
  /** Session attributions a supervisor stopped before this one still held
   *  (Tokenomics switched off and on again): kept here as its own, and sent
   *  to the worker when it is ready. */
  sessionAccounts?: Iterable<readonly [string, TkAccountKey]>
  emit: (channel: string, payload: unknown) => void
  /** 2.1.3-beta.4: the app's process figures (Electron's
   *  app.getAppMetrics()), for the worker's CPU share on its Services row.
   *  Without it the row has no CPU figure. Asked at most once in 5 s, and
   *  only when the row is read (a Services push, or the view's own read), so
   *  the share is the average since the read before (see process-cpu.ts). */
  processMetrics?: () => readonly ProcessCpuMetric[]
  now?: () => number
  maxRestarts?: number
  /** A worker ready and running this long gives the restart budget back (default 5 min). */
  stableResetMs?: number
  queryTimeoutMs?: number
}

export interface TkIndexProgress { filesDone: number; filesTotal: number; eventsIngested: number; phase: string; accountReread?: TkAccountReread | null }
export interface TkIndexCompleteEvent { firstIndex: boolean; drained: boolean; filesFailed: number; eventsTotal: number }

const DEFAULT_QUERY_TIMEOUT_MS = 15_000
/** Counter changes (Events, In-flight) reach the Services view at most this often. */
const COALESCE_MS = 250

/** A walk's counts as the worker reports them: whole numbers, none negative. */
function walkCountOk(v: unknown): v is TkWalkCount {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return ['dirs', 'entries', 'files'].every((k) => Number.isSafeInteger(c[k]) && (c[k] as number) >= 0)
}
/** A full pass's figures, copied, or null when they are not well formed. */
function walkStatsOf(v: unknown): TkWalkStats | null {
  if (!v || typeof v !== 'object') return null
  const w = v as Record<string, unknown>
  if (!walkCountOk(w.transcripts) || !walkCountOk(w.rollouts)) return null
  if (![w.at, w.ms, w.filesRead].every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) return null
  const copy = (c: TkWalkCount): TkWalkCount => ({ dirs: c.dirs, entries: c.entries, files: c.files })
  return { at: w.at as number, ms: w.ms as number, transcripts: copy(w.transcripts), rollouts: copy(w.rollouts), filesRead: w.filesRead as number }
}

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
  private readySubs = new Set<(s: TkIndexStatus) => void>()
  /** 2.1.3-beta.4: what the current worker's last full pass over the
   *  transcript roots touched, as it reported it. Null until one has
   *  finished, and again for each new worker, so its row never shows a
   *  pass the worker before it made beside its own CPU share. */
  private lastWalk: TkWalkStats | null = null
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
  /** The window that coalesces counter-driven row pushes (schedulePush). */
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null
  private coalesceDirty = false
  /** 2.1.3-beta.4: the current worker's CPU share, sampled for its row. A
   *  new one for each worker, so a sample is never of the one before. */
  private cpu: ProcessCpuSampler | null = null

  constructor(private opts: TokenomicsSupervisorOptions) {
    this.realmDirsKnown = Array.isArray(opts.codexRealmSessionsDirs)
    for (const [sessionId, accountKey] of opts.sessionAccounts ?? []) this.keepSessionAccount(sessionId, accountKey)
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
    const metrics = this.opts.processMetrics
    this.cpu = metrics ? createProcessCpuSampler({ metrics, now: () => this.now() }) : null
    // A manual restart forks the next worker without an exit first, so the
    // last pass is let go here as well as on an exit.
    this.lastWalk = null
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
        // 2.1.3-beta.4: what the index knows as its worker comes up, so a
        // page open while Tokenomics is switched on shows what was recorded
        // before at once, not after the first whole pass.
        const status = this.getIndexStatus()
        for (const cb of this.readySubs) { try { cb(status) } catch { /* ignore */ } }
        return
      }
      case 'index-progress': {
        if (from !== this.worker) return
        this.lastAccountReread = m.accountReread ?? null
        this.lastProgress = { filesDone: m.filesDone, filesTotal: m.filesTotal, eventsIngested: m.eventsIngested, phase: m.phase, accountReread: this.lastAccountReread }
        for (const cb of this.progressSubs) { try { cb(this.lastProgress) } catch { /* ignore */ } }
        return
      }
      case 'index-complete': {
        // A replaced worker's late completion is not the current worker's state.
        if (from !== this.worker) return
        // A sweep FINISHING is not a first index. With a per-tick byte budget a
        // multi-GB rollout needs tens of sweeps, so latching on the message
        // itself put the dashboard up over a fraction of the user's spend and
        // called it complete. `drained` is the worker saying every file it
        // visited was actually read to the end.
        if (m.drained) this.firstIndexComplete = true
        const eventsChanged = this.lastEventsTotal !== m.eventsTotal
        this.lastEventsTotal = m.eventsTotal
        this.lastFilesFailed = m.filesFailed
        this.lastIndexAt = this.now()
        // 2.1.3-beta.4: a full pass says what its walks touched; a pass over
        // the reported transcripts alone says nothing and changes nothing. (A
        // replaced worker's pass was turned away above.)
        if (m.walk !== undefined) this.lastWalk = walkStatsOf(m.walk) ?? this.lastWalk
        for (const cb of this.completeSubs) { try { cb({ firstIndex: m.firstIndex, drained: m.drained, filesFailed: m.filesFailed, eventsTotal: m.eventsTotal }) } catch { /* ignore */ } }
        if (eventsChanged) this.schedulePush()
        return
      }
      case 'health': {
        // Only the current worker's counters are the row's.
        if (from !== this.worker) return
        const eventsChanged = this.lastEventsTotal !== m.eventsTotal
        this.lastEventsTotal = m.eventsTotal
        if (eventsChanged) this.schedulePush()
        return
      }
      // An answer is matched by its request id, and a restart or an exit rejects
      // every pending query at once (ids are never reused), so a replaced worker
      // can settle nothing that is still pending: no identity check is needed.
      case 'query-result': {
        const p = this.pending.get(m.id)
        if (p) { this.pending.delete(m.id); clearTimeout(p.timer); p.resolve(m.rows); this.schedulePush() }
        return
      }
      case 'error': {
        if (m.id !== undefined) {
          const p = this.pending.get(m.id)
          if (p) { this.pending.delete(m.id); clearTimeout(p.timer); p.reject(new Error(m.message)); this.schedulePush() }
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
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`tokenomics query timed out after ${timeoutMs}ms (kind=${kind})`))
          this.schedulePush()
        }
      }, timeoutMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.schedulePush()
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
  /** The page's Rescan (2.1.3-beta.4): every transcript is read again from
   *  its first byte; what is stored stays. Held for a worker that is not
   *  listening yet, once, like `reindex`. False, and nothing held, when no
   *  worker will come to read it: the restarts are used up for the run,
   *  this supervisor is shutting down, or the worker is alive but reported
   *  a fault before it was ready (a database it could not open), which
   *  leaves it never ready and never restarted. A worker being started, or
   *  one to come after a crash, is held for as before. */
  rescan(): boolean {
    if (this.degraded || this.sup.isShuttingDown()) return false
    if (this.worker && !this.listening && this.lastError) return false
    this.sendOrBuffer({ type: 'rescan' })
    return true
  }
  /** What the current worker's last full pass over the transcript roots
   *  touched (for the Services panel), or null when it has finished none. */
  getLastWalkStats(): TkWalkStats | null {
    const w = this.lastWalk
    return w ? { ...w, transcripts: { ...w.transcripts }, rollouts: { ...w.rollouts } } : null
  }
  /** Usage track MP10: a Claude session id and the account it runs under
   *  now. The same again sends nothing; another account applies from then
   *  on (MP10 round 1); anything not well formed is dropped. Sent at once to
   *  a worker that listens; otherwise only kept (the latest per session,
   *  within the bound) for the next ready to send. */
  setSessionAccount(sessionId: string, accountKey: TkAccountKey): void {
    if (this.sup.isShuttingDown() || !this.keepSessionAccount(sessionId, accountKey)) return
    if (this.listening && this.worker) this.worker.transport.post({ type: 'set-session-account', sessionId, accountKey })
  }
  /** Keep a session's attribution as the latest (the oldest dropped past the
   *  bound). False when it is not well formed or is the one already kept. */
  private keepSessionAccount(sessionId: string, accountKey: TkAccountKey): boolean {
    if (!tkSessionUuidOk(sessionId) || !tkClaudeAccountKeyOk(accountKey)) return false
    if (this.sessionAccounts.get(sessionId) === accountKey) return false
    this.sessionAccounts.delete(sessionId)
    this.sessionAccounts.set(sessionId, accountKey)
    if (this.sessionAccounts.size > TK_SESSION_ACCOUNTS_KEPT) {
      const oldest = this.sessionAccounts.keys().next()
      if (!oldest.done) this.sessionAccounts.delete(oldest.value)
    }
    return true
  }
  /** The attributions kept, oldest first: handed to the next supervisor when
   *  Tokenomics is switched off and on again, so one made while no worker
   *  was listening is not lost with this one. */
  keptSessionAccounts(): Array<[string, TkAccountKey]> { return [...this.sessionAccounts] }

  onIndexProgress(cb: (p: TkIndexProgress) => void): () => void { this.progressSubs.add(cb); return () => { this.progressSubs.delete(cb) } }
  onIndexComplete(cb: (c: TkIndexCompleteEvent) => void): () => void { this.completeSubs.add(cb); return () => { this.completeSubs.delete(cb) } }
  /** Fires with the fault status when the worker reports an uncorrelated error
   *  (e.g. a failed DB open). The handler layer forwards it to the renderer. */
  onIndexError(cb: (s: TkIndexStatus) => void): () => void { this.errorSubs.add(cb); return () => { this.errorSubs.delete(cb) } }
  /** Fires with the index status each time a worker reports itself ready
   *  (2.1.3-beta.4). The handler layer forwards it to the renderer. */
  onIndexReady(cb: (s: TkIndexStatus) => void): () => void { this.readySubs.add(cb); return () => { this.readySubs.delete(cb) } }

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
    // 2.1.3-beta.4: the worker's process id while there is a worker, and
    // what it was measured to cost.
    row.pid = this.worker ? this.workerPid() : null
    const measured = this.measured()
    if (measured) row.measured = measured
    return { capturedAt: this.now(), services: [row], log: [] }
  }

  /** The OS process id of the current worker, once the app knows it (a
   *  utility process has none until it has spawned). */
  private workerPid(): number | null {
    try {
      const pid = this.worker?.pid?.()
      return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null
    } catch {
      return null
    }
  }

  /** What the worker was measured to cost, for its Services row: its CPU
   *  share (when the app's process figures were given and list it; the
   *  average since the row was last sampled, see process-cpu.ts), and the
   *  transcripts its own last full pass found and looked at (each one found
   *  is checked for a change, and those that changed are read). None
   *  without a worker, and none when there is no figure. */
  private measured(): ServiceMeasured | undefined {
    if (!this.worker || this.sup.isShuttingDown()) return undefined
    const pid = this.workerPid()
    const cpu = pid !== null && this.cpu ? this.cpu.sample(pid) : null
    const walk = this.lastWalk
    const files = walk ? walk.transcripts.files + walk.rollouts.files : undefined
    const cpuPercent = cpu?.cpuPercent
    if (cpuPercent === undefined && files === undefined) return undefined
    return {
      ...(cpuPercent !== undefined ? { cpuPercent } : {}),
      ...(files !== undefined ? { filesTouchedLastScan: files } : {}),
      // When the CPU share was sampled, or else when that pass finished.
      sampledAt: cpu && cpuPercent !== undefined ? cpu.sampledAt : walk!.at,
    }
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

  /** Tell the Services view the row changed because a counter did (Events, In-flight),
   *  at most once per COALESCE_MS. The first change goes out at once; changes inside
   *  the window are held and sent together when it ends, so the last value always
   *  lands and a burst of queries is two pushes, not one per query. */
  private schedulePush(): void {
    if (this.sup.isShuttingDown()) return
    if (this.coalesceTimer) { this.coalesceDirty = true; return }
    this.pushHealth()
    this.openCoalesceWindow()
  }

  private openCoalesceWindow(): void {
    const timer = setTimeout(() => {
      this.coalesceTimer = null
      if (!this.coalesceDirty) return
      this.coalesceDirty = false
      if (this.sup.isShuttingDown()) return
      this.pushHealth()
      this.openCoalesceWindow()
    }, COALESCE_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.coalesceTimer = timer
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
    this.cpu = null
    this.lastWalk = null
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
    this.cpu = null
    this.listening = false
    // The supervisor's shutdown suppresses the exit callback that clears this,
    // so clear it here: a stopped row shows no uptime.
    this.readyAt = null
    if (this.coalesceTimer) { clearTimeout(this.coalesceTimer); this.coalesceTimer = null }
    this.coalesceDirty = false
    // The row reads stopped from here. Say so: nothing else would tell the
    // Services view when the service is shut down while the app keeps running.
    this.pushHealth()
  }
}
