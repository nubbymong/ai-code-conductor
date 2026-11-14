/**
 * supervisor.ts — the ONE supervisor every supervised service runs on.
 *
 * It owns what the hooks, logging and usage-index services used to each keep a
 * copy of (planning #307, point 8): forking the child, noticing its exit, the
 * backoff, the restart budget, the manual restart, and shutdown. A service
 * keeps only what is its own: the messages it exchanges with its child, its
 * health row, its buffers. It is told what happened through the hooks below
 * and never holds a restart counter or a restart timer itself.
 *
 * Two things the copies did not have:
 *  - Desired state (B8). A service is wanted on or off. Off stays off: a crash
 *    is not restarted, a pending restart is dropped, and a manual restart is
 *    declined, until the service is wanted on again.
 *  - A budget that recovers (B9). Once a child has reported itself up and has
 *    then run for `stableResetMs` without exiting, the restart count and the
 *    backoff go back to zero. A child that never comes up, or dies inside the
 *    period, gives nothing back, so a crash loop still runs the budget out.
 *    Only the current child's own report counts: one still draining out of a
 *    replaced child's pipe is refused.
 *
 * A fork that fails after the first start is a child that died at birth: it
 * goes down the same exit path (backoff, budget), so the service is never left
 * with no child and nothing on its way.
 *
 * No default export (project convention).
 */

/** What the supervisor needs of a forked child. Each service's fork helper
 *  returns this plus its own transport. */
export interface SupervisedChild {
  kill: () => void
  onExit: (cb: () => void) => void
}

export interface SupervisorOptions<C extends SupervisedChild> {
  forkChild: () => C
  /** A child was just forked (first start, crash restart, manual restart, or
   *  wanted on again with none running): subscribe to it and send it its
   *  opening messages. Runs before the exit listener is attached. */
  onSpawn: (child: C) => void
  /** The current child exited on its own, or (with `forkError`) the fork
   *  that was to replace it failed. Runs for a service that is wanted off too
   *  (ask `isWanted()`); that one is then left down. */
  onExit: (forkError?: Error) => void
  /** The restart budget is spent: nothing more is forked until a manual
   *  restart. The service falls back, or degrades. */
  onExhausted: () => void
  /** The restart count changed (a crash restart, a manual restart's reset, or
   *  a stable period giving the budget back). */
  onRestartCount?: (restarts: number) => void
  /** A stable period gave a used budget back (`onRestartCount(0)` came first). */
  onBudgetRestored?: () => void
  /** Restart budget (default 5). */
  maxRestarts?: number
  /** How long a child must run after reporting itself up before the budget is
   *  given back (default 5 minutes). */
  stableResetMs?: number
  /** The usage index's rule, kept: a child reporting itself up starts the
   *  backoff over at once (the restart count still waits for the period). */
  resetBackoffOnUp?: boolean
}

export const SUPERVISOR_BACKOFFS_MS = [250, 1000, 4000, 4000, 4000]
export const SUPERVISOR_STABLE_RESET_MS = 5 * 60_000

type Timer = ReturnType<typeof setTimeout>
// A supervisor timer never keeps the process alive on its own.
function unref(t: Timer): Timer { (t as unknown as { unref?: () => void }).unref?.(); return t }

export class Supervisor<C extends SupervisedChild> {
  private child: C | null = null
  /** The current child has not exited (as far as its exit listener knows). */
  private alive = false
  private started = false
  /** Desired state: the service is wanted on. */
  private wanted = true
  private shuttingDown = false
  /** The budget is spent; terminal until a manual restart. Set BEFORE
   *  `onExhausted` runs, so a kill made there cannot re-enter the exit path. */
  private exhausted = false
  private restarts = 0
  private backoffIdx = 0
  private restartTimer: Timer | null = null
  private stableTimer: Timer | null = null
  /** The current child has reported itself up (once per child). */
  private up = false

  constructor(private opts: SupervisorOptions<C>) {}

  getRestarts(): number { return this.restarts }
  isWanted(): boolean { return this.wanted }
  isShuttingDown(): boolean { return this.shuttingDown }
  isExhausted(): boolean { return this.exhausted }

  /** First start: the service is wanted on and its child is forked. */
  start(): void {
    this.started = true
    this.wanted = true
    this.launch()
  }

  private launch(): void {
    const c = this.opts.forkChild()
    this.child = c
    this.alive = true
    this.up = false
    this.opts.onSpawn(c)
    // A replaced child's late exit is not the current child's.
    c.onExit(() => { if (this.child === c) this.onChildExit() })
  }

  /** Every fork after the first start; the child before it has exited or been
   *  let go. A fork that throws (or a spawn hook that does) is a child that
   *  died at birth: it goes down the exit path, so the backoff tries again and
   *  the budget still runs out. Returns true when a child was forked. */
  private relaunch(): boolean {
    this.child = null
    try {
      this.launch()
      return true
    } catch (e) {
      // Forked and then its spawn hook threw: no exit listener is on it yet,
      // so it is killed here. (The cast undoes a narrowing: launch() is what
      // assigns `child`.)
      const halfStarted = this.child as C | null
      try { halfStarted?.kill() } catch { /* best-effort */ }
      this.onChildExit(e instanceof Error ? e : new Error(String(e)))
      return false
    }
  }

  /** The service says `child` is up (bound, ready). From here the stable
   *  period runs; a second report from the same child does not start it over.
   *  Returns false, and does nothing, when the report is not the current live
   *  child's (a replaced or exited child's message still draining out of its
   *  pipe): the service then ignores it too. */
  markUp(child: C): boolean {
    if (this.shuttingDown || child !== this.child || !this.alive) return false
    if (this.opts.resetBackoffOnUp) this.backoffIdx = 0
    if (this.up) return true
    this.up = true
    this.stableTimer = unref(setTimeout(() => {
      this.stableTimer = null
      const counted = this.restarts > 0
      this.restarts = 0
      this.backoffIdx = 0
      if (counted) {
        this.opts.onRestartCount?.(0)
        this.opts.onBudgetRestored?.()
      }
    }, this.opts.stableResetMs ?? SUPERVISOR_STABLE_RESET_MS))
    return true
  }

  private clearStable(): void {
    if (this.stableTimer !== null) { clearTimeout(this.stableTimer); this.stableTimer = null }
  }

  private clearRestart(): void {
    if (this.restartTimer !== null) { clearTimeout(this.restartTimer); this.restartTimer = null }
  }

  private onChildExit(forkError?: Error): void {
    // Ignore exits once shutting down OR once the budget is spent (the latter
    // so a kill made while falling back cannot re-enter and re-run this).
    if (this.shuttingDown || this.exhausted) return
    this.alive = false
    this.clearStable()
    this.opts.onExit(forkError)
    if (!this.wanted) return   // off stays off (B8)
    if (this.restarts >= (this.opts.maxRestarts ?? 5)) {
      this.exhausted = true
      this.opts.onExhausted()
      return
    }
    const delay = SUPERVISOR_BACKOFFS_MS[Math.min(this.backoffIdx, SUPERVISOR_BACKOFFS_MS.length - 1)]
    this.backoffIdx++
    this.restartTimer = unref(setTimeout(() => {
      this.restartTimer = null
      if (this.shuttingDown) return   // shutdown() raced the backoff: do not resurrect the child
      this.restarts++
      this.opts.onRestartCount?.(this.restarts)
      this.relaunch()
    }, delay))
  }

  /** Set the desired state. Off drops a pending restart and leaves any running
   *  child to the service (it tells its child to stop serving). On forks a
   *  child when none is running and none is on its way. Returns true when this
   *  call forked one. */
  setWanted(on: boolean): boolean {
    this.wanted = on
    if (!on) { this.clearRestart(); return false }
    if (!this.started || this.shuttingDown || this.exhausted) return false
    if (this.alive || this.restartTimer !== null) return false
    return this.relaunch()
  }

  /** Why a manual restart cannot run now, or null when it can. */
  restartRefusal(): 'shutting-down' | 'disabled' | null {
    if (this.shuttingDown) return 'shutting-down'
    if (!this.wanted) return 'disabled'
    return null
  }

  /** User-requested restart: a clean slate (the budget and the backoff start
   *  over, a spent budget is forgiven), the current child is killed and a new
   *  one forked (when that fork fails, the backoff forks the next). Does
   *  nothing, and returns false, when `restartRefusal()` gives a reason. */
  restart(): boolean {
    if (this.restartRefusal() !== null) return false
    this.clearRestart()
    this.clearStable()
    this.restarts = 0
    this.backoffIdx = 0
    this.exhausted = false
    this.opts.onRestartCount?.(0)
    // Let go of the old child BEFORE killing it, so its exit (late, or fired
    // by the kill itself) is not taken for the new child's.
    const old = this.child
    this.child = null
    try { old?.kill() } catch { /* best-effort */ }
    this.relaunch()
    return true
  }

  /** Final: nothing is forked after this. The service kills its own child
   *  (after any goodbye it wants to send it). */
  shutdown(): void {
    this.shuttingDown = true
    this.clearRestart()
    this.clearStable()
  }
}
