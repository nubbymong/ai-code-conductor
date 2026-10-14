// Canvas -> agent marker delivery, queued across the agent's turn (#580).
//
// THE BUG. When the user files a verdict on the Agent Canvas the panel writes
// one line into the session's PTY -- "Approved v7 on the canvas ·
// canvas_version_verdict recorded", or "Review #3 — 5 notes · canvas_review R3"
// -- and that line is the ONLY thing that tells the agent anything happened.
// The skill (canvas-plugin.ts) triggers on the literal text.
//
// The write was unconditional and immediate: `pty.write(sessionId, line + '\r')`
// straight through `writePty`, which has no idle gate of its own. That is fine
// at a prompt and useless mid-turn -- Claude Code's TUI is not reading a user
// line while it is streaming a response, so a marker fired during an agent turn
// is swallowed by the terminal and never becomes a message. Two live
// occurrences on #580: a clean APPROVAL delivered nothing at all, because a
// clean approval creates NO review record either (submitReview refuses a round
// with no notes, by design) -- the marker IS the whole delivery. The same
// approval fired at an idle prompt arrived fine.
//
// THE FIX. Hold the line while the turn is open and flush it at the boundary.
// The boundary is not guessed from terminal text: CCC already runs a hooks
// gateway that receives Claude Code's own `UserPromptSubmit` / `PreToolUse` /
// `PostToolUse` / `Stop` events per session, so the turn is observed, not
// inferred.
//
// FAIL-OPEN BY CONSTRUCTION. The queue only ever engages on POSITIVE evidence
// that a turn is open. With hooks disabled (or a gateway that never binds) no
// turn-opening event arrives, `turnOpen` is false, and every marker is handed
// on immediately. What it is handed to (pty-manager's writeCanvasMarkerLine)
// still types it only at the agent's ready prompt: for Claude Code, held
// until then for at most CLAUDE_MARKER_HOLD_MS (claude-marker-typing.ts,
// which names the one exception: a type request that went unanswered), after
// which it is dropped and told to its canvas as not sent. A Claude Code
// marker handed on comes back here (holdAgain) when, since it was handed on,
// a marker ahead of it was typed or came back, or a turn began
// (claude-marker-typing.ts), and a turn reads open; it then waits for that
// turn's Stop like any other. A marker this queue still holds when its
// session ends or restarts is told to its canvas as not sent (forget), and
// never written later. A turn that opens and never closes (crash, kill, a
// Stop that never fires) is caught by a bounded fallback flush, so a marker
// is never held here for good.

import { logInfo, logWarn } from '../debug-logger'

/** How long the hook stream may stay silent while a marker is held, before it
 *  is flushed without a `Stop` (one that may never come). Counted from the
 *  later of the first held marker and the last turn-opening hook since then
 *  (aicc_planning#81).
 *
 *  Silence is all it can see. Only a turn-opening hook re-arms it (a prompt
 *  sent, a tool starting or finishing, a subagent starting), and no hook
 *  fires while a tool runs or while the agent thinks or writes. So two
 *  minutes with no tool starting or finishing (a long build or test run, or
 *  the agent thinking or writing at length) count as silence, and the held
 *  marker is handed on while the turn may still be running. What it is
 *  handed to still types it only at the agent's ready prompt (pty-manager's
 *  writeCanvasMarkerLine), waiting for it within this same bound for every
 *  assistant (for Claude Code, CLAUDE_MARKER_HOLD_MS in
 *  claude-marker-typing.ts), after which the canvas is told the marker was
 *  not sent. The known-issues entry for canvas verdicts describes both;
 *  change them together. */
export const MARKER_FALLBACK_FLUSH_MS = 120_000

/** Nothing sane queues this many; the cap stops a stuck session growing. */
export const MARKER_QUEUE_MAX = 32

export interface MarkerQueueDeps {
  /** Deliver one line to the session's agent, with the canvas it was filed on
   *  when the caller named one (WP2 PR 4: it travels with the line itself). */
  write: (sessionId: string, line: string, canvasId?: string) => void
  /** Arm the fallback flush. Returns its canceller. Injected for tests. */
  setTimer?: (fn: () => void, ms: number) => () => void
  /** Told once for each marker forget drops (its session ended or restarted
   *  while the marker was held here), in the order held, with the canvas it
   *  was filed on when the caller named one. Never told for a marker
   *  written. */
  forgotten?: (sessionId: string, line: string, canvasId?: string) => void
}

/** One held marker: its line and the canvas it was filed on, and whether it
 *  came back here after it was handed on (holdAgain). */
interface PendingMarker {
  line: string
  canvasId?: string
  heldAgain?: true
}

interface SessionState {
  turnOpen: boolean
  pending: PendingMarker[]
  cancelFallback: (() => void) | null
}

/**
 * Which hook events say a turn is OPEN.
 *
 * Deliberately narrow. `Notification` is excluded because Claude Code fires it
 * for "waiting for your input", i.e. precisely when the turn is NOT open, and a
 * false "open" would park every marker until the next real turn ended.
 * `SubagentStop` does not close the main turn, and `SessionStart` /
 * `StopFailure` say nothing about one.
 */
const TURN_OPENING_EVENTS: ReadonlySet<string> = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
])

export class CanvasMarkerQueue {
  private readonly sessions = new Map<string, SessionState>()
  private readonly write: (sessionId: string, line: string, canvasId?: string) => void
  private readonly setTimer: (fn: () => void, ms: number) => () => void
  private readonly forgotten: ((sessionId: string, line: string, canvasId?: string) => void) | null

  constructor(deps: MarkerQueueDeps) {
    this.write = deps.write
    this.forgotten = deps.forgotten ?? null
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms)
      // Never hold the process open for a marker.
      if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
        (t as unknown as { unref: () => void }).unref()
      }
      return () => clearTimeout(t)
    })
  }

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId)
    if (!s) {
      s = { turnOpen: false, pending: [], cancelFallback: null }
      this.sessions.set(sessionId, s)
    }
    return s
  }

  /**
   * Deliver a canvas marker line to the agent -- now if it can be read now,
   * otherwise at the end of the turn that is in flight.
   *
   * Returns 'sent' or 'queued' so the caller (and the tests) can tell which
   * happened without reaching into the state. `canvasId`, when given, stays
   * with the line through the queue to its write.
   */
  deliver(sessionId: string, line: string, canvasId?: string): 'sent' | 'queued' {
    const s = this.state(sessionId)
    if (!s.turnOpen) {
      this.write(sessionId, line, canvasId)
      return 'sent'
    }
    // COLLAPSE an identical pending line (adversarial review, 2026-09-01).
    //
    // The cap below drops the OLDEST, which is the right call for a queue of
    // DISTINCT verdicts — but it makes the queue evictable by repetition. A
    // re-render loop, a double-click, a panel effect that re-fires: 32 copies of
    // one line and the approval this whole module exists to save is gone, silently
    // (a warn line the user never sees). The markers are idempotent NOTIFICATIONS
    // — "Approved v7", "Review #3 — 5 notes · canvas_review R3" — so a repeat
    // carries no information the first copy did not, and delivering it twice would
    // make the agent fetch the same round twice anyway.
    //
    // Dedupe against PENDING only, never against what has already been written: a
    // second identical verdict in a LATER turn is a real event and must go out.
    // The cap stays as the backstop for genuinely distinct floods.
    // WP2 PR 4: the same line about ANOTHER canvas is a different event (two
    // canvases of one session can file the same words), so it is not collapsed.
    if (s.pending.some((p) => p.line === line && p.canvasId === canvasId)) {
      logInfo(`[canvas-marker] duplicate marker for ${sessionId} collapsed into the pending one`)
      this.armFallback(sessionId, s)
      return 'queued'
    }
    if (s.pending.length >= MARKER_QUEUE_MAX) {
      // Drop the OLDEST: the newest verdict is the one that still describes
      // the canvas, and an unbounded queue on a wedged session is worse than a
      // dropped stale line. Loud, because it should never happen.
      const dropped = s.pending.shift()
      logWarn(`[canvas-marker] queue full for ${sessionId} -- dropped the oldest marker: ${dropped?.line}`)
    }
    s.pending.push({ line, ...(canvasId !== undefined ? { canvasId } : {}) })
    logInfo(`[canvas-marker] agent turn is open for ${sessionId} — queued marker (${s.pending.length} pending)`)
    this.armFallback(sessionId, s)
    return 'queued'
  }

  /**
   * Hold again a marker this queue handed on that was not typed: one the
   * Claude Code chain (claude-marker-typing.ts) gives back because a turn it
   * would otherwise wait through at the prompt is running (a line typed
   * ahead of it opened one, a marker ahead of it came back, or a turn began
   * while it waited). Taken only while a turn reads open (true); with the
   * turn read closed nothing is taken or written (false), and the caller
   * keeps it.
   *
   * ORDER. While a turn reads open nothing is handed on, and a turn reads
   * closed only once everything held has been flushed, so every marker held
   * here now was filed after every marker this queue has already handed on.
   * A marker held again therefore goes ahead of those, after any held again
   * before it. It then waits for the turn's Stop under the same fallback
   * bound as the rest. That covers the markers held here; the markers still
   * in the Claude Code chain behind one held again (handed on before it was
   * given back, so filed after it) are given back right after it, in their
   * order, while the turn still reads open (claude-marker-typing.ts), so
   * none of them is typed ahead of it.
   *
   * A marker held again counts toward MARKER_QUEUE_MAX like any other: when
   * it makes the queue overfull the oldest marker held is dropped, with a log
   * line only, as deliver drops one, even when that is a marker held again
   * (so only the latest decisions are kept, and in order). Declining it
   * instead would leave it in the chain, where it could be typed ahead of a
   * marker given back just before it.
   */
  holdAgain(sessionId: string, line: string, canvasId?: string): boolean {
    const s = this.sessions.get(sessionId)
    if (!s || !s.turnOpen) return false
    const at = s.pending.findIndex((p) => !p.heldAgain)
    s.pending.splice(at === -1 ? s.pending.length : at, 0, { line, ...(canvasId !== undefined ? { canvasId } : {}), heldAgain: true })
    if (s.pending.length > MARKER_QUEUE_MAX) {
      const dropped = s.pending.shift()
      logWarn(`[canvas-marker] queue full for ${sessionId} -- dropped the oldest marker: ${dropped?.line}`)
    }
    logInfo(`[canvas-marker] agent turn is open for ${sessionId}, so a marker handed on is held again (${s.pending.length} pending)`)
    this.armFallback(sessionId, s)
    return true
  }

  /** A hook event arrived for this session. */
  noteHookEvent(sessionId: string, event: string): void {
    if (event === 'Stop') {
      const s = this.sessions.get(sessionId)
      if (!s) return
      s.turnOpen = false
      this.flush(sessionId)
      return
    }
    // A restart (or a resume) is a fresh prompt: whatever turn we thought was
    // open belonged to the process that is gone, and anything still held has
    // been waiting for a Stop that will never come.
    if (event === 'SessionStart') {
      const s = this.sessions.get(sessionId)
      if (!s) return
      s.turnOpen = false
      this.flush(sessionId)
      return
    }
    if (!TURN_OPENING_EVENTS.has(event)) return
    const s = this.state(sessionId)
    if (!s.turnOpen) s.turnOpen = true
    // The turn just showed it is alive, so the fallback starts again from now
    // (aicc_planning#81). It is there for a turn whose hook stream has gone
    // SILENT, and armed once at queue time it measured the marker's age
    // instead: a long turn still firing tool hooks had its marker typed into
    // it after 120 s, where the TUI swallowed it. Only while something is
    // held; an idle session's hooks arm nothing.
    //
    // Known tradeoff: the event name does not say which agent fired it, so a
    // background subagent's tool hooks after the main turn's Stop reopen the
    // turn (as before) and now also keep a marker held until they go quiet or
    // the main agent's next Stop. A delay, never a loss.
    if (s.pending.length > 0) this.rearmFallback(sessionId, s)
  }

  /**
   * Write everything held for this session, oldest first.
   *
   * ORDER IS THE POINT: two rounds filed in one turn must reach the agent in
   * the order the user filed them, or "Review #4" arrives describing notes the
   * agent has not been told about yet.
   */
  flush(sessionId: string): number {
    const s = this.sessions.get(sessionId)
    if (!s) return 0
    s.cancelFallback?.()
    s.cancelFallback = null
    if (s.pending.length === 0) return 0
    const held = s.pending
    s.pending = []
    logInfo(`[canvas-marker] flushing ${held.length} queued marker(s) for ${sessionId}`)
    for (const marker of held) this.write(sessionId, marker.line, marker.canvasId)
    return held.length
  }

  /** The session is gone (it ended, or restarts as a new run): nothing left
   *  to deliver it to. Every marker still held for it, held again or not, is
   *  told once to `forgotten`, in order, and never written. Idempotent. */
  forget(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.cancelFallback?.()
    // Gone before anything is told, so a second forget, or anything the
    // report does, finds nothing left to tell or write.
    this.sessions.delete(sessionId)
    if (s.pending.length === 0) return
    logWarn(`[canvas-marker] session ${sessionId} ended with ${s.pending.length} undelivered marker(s)`)
    for (const marker of s.pending) {
      try { this.forgotten?.(sessionId, marker.line, marker.canvasId) } catch { /* a report never breaks the teardown */ }
    }
  }

  /** Test/diagnostic view. */
  pendingCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.pending.length ?? 0
  }

  /** Whether this session's agent turn reads open (test/diagnostic view). */
  isTurnOpen(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.turnOpen ?? false
  }

  /**
   * Restart the fallback from now. armFallback returns early while a timer
   * exists (so a burst of markers arms one, not one each), so this cancels the
   * current one first and then arms a fresh one.
   */
  private rearmFallback(sessionId: string, s: SessionState): void {
    s.cancelFallback?.()
    s.cancelFallback = null
    this.armFallback(sessionId, s)
  }

  private armFallback(sessionId: string, s: SessionState): void {
    if (s.cancelFallback) return
    const cancel = this.setTimer(() => {
      const live = this.sessions.get(sessionId)
      // Only the timer that is still the session's own may flush. A superseded
      // one (re-armed by a later hook, aicc_planning#81) or one from a forgotten
      // session is stale even if the runtime fires it anyway, and must not
      // clear the canceller of the timer that replaced it.
      if (!live || live.cancelFallback !== cancel) return
      live.cancelFallback = null
      if (live.pending.length === 0) return
      logWarn(
        `[canvas-marker] no hook and no Stop for ${sessionId} in ${MARKER_FALLBACK_FLUSH_MS}ms, ` +
        `flushing ${live.pending.length} marker(s) anyway (late beats lost)`,
      )
      // The turn is presumed over: a hook stream that went silent this long is
      // a crashed/killed turn, and holding for a boundary that will never
      // arrive is the loss this whole module exists to prevent.
      live.turnOpen = false
      this.flush(sessionId)
    }, MARKER_FALLBACK_FLUSH_MS)
    s.cancelFallback = cancel
  }
}
