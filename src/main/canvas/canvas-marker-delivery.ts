// The live wiring for the canvas marker queue (#580).
//
// Kept apart from `canvas-marker-queue.ts` on purpose: the queue is the RULE
// (pure, no Electron, no PTY, unit-testable flat) and this is the singleton
// around it.
//
// Nothing heavy is imported HERE either, and that is deliberate rather than
// tidy: the IPC handler that calls `deliverCanvasMarker` lives in
// canvas-handlers.ts, and a static import of pty-manager (or the hooks gateway)
// from there drags `electron.app` into every canvas handler test that mocks
// Electron minimally. So both ends are INJECTED at boot from src/main/index.ts,
// where those modules already live.
//
// WP2 PR 4, P4.1: a Codex session's markers go through the submit primitive
// (src/main/providers/codex/composer-submit.ts), whose answer comes later and
// may be "not delivered" (no ready prompt within the queue's own bound, a
// prompt on screen, a write never drawn). The wiring's `write` may therefore
// answer with a promise of that result, and a marker that was not delivered
// is handed to `onUndelivered` with the canvas it was filed on, so the canvas
// can show it on the review it belongs to. A Claude Code session's write
// answers nothing at once (or, with no run to type into, not delivered, the
// session gone): it hands the line to canvas/claude-marker-typing.ts, which
// holds it and types it only at Claude Code's ready, empty prompt, and which
// hands a marker it drops untyped (still held after its bound, its run ended,
// or refused) to the same `onUndelivered` itself, installed below at boot. A
// Claude Code marker is given back to the queue when, since it was handed on,
// a marker ahead of it was typed or given back, or a turn began (Claude
// Code's UserPromptSubmit, which the hook stream below passes on to
// claude-marker-typing.ts after the queue has read it), and a turn reads
// open. It goes through the queue's holdAgain, also installed below, and is
// handed on again at that turn's Stop or the queue's fallback. So a Claude
// Code marker handed on by the queue is typed, told to its canvas, or held by
// the queue again.
//
// When a session ends or restarts (forgetCanvasMarkers), a marker still held
// for it is told to `onUndelivered` as well (the session gone), once: first
// each Claude Code marker held at its prompt, at once and in the order handed
// in, then each marker the queue holds, held again or not, for any assistant,
// in order. That is the order they were filed in. Main writes none of them
// after that, and asks the renderer to type none of them. The exception is a
// Claude Code marker whose type request was already sent (at most one per
// session, the one at the head of its chain): the renderer may still type it.
// Its canvas is told it was not sent all the same, and main logs the late
// answer (claude-marker-typing.ts).
//
// Not every marker that does not reach the agent reaches a canvas. These are
// dropped with a log line only, and no canvas is told:
//  - the markers the queue drops, the oldest first, when more than
//    MARKER_QUEUE_MAX wait;
//  - a marker whose write answers later (a Codex session's, waiting for
//    Codex's prompt) and has not answered when its session ends:
//    forgetCanvasMarkers clears its awaiting record before that answer
//    arrives, so the not delivered answer that follows (the session gone,
//    once the run's screen is closed) tells no canvas;
//  - a marker filed with no canvas named (only direct callers;
//    canvas:agentMarker always names one), wherever it is dropped.

import { CanvasMarkerQueue } from './canvas-marker-queue'
import { forgetClaudeMarkers, noteClaudeMarkerTurnBegun, setClaudeMarkerHoldAgain, setClaudeMarkerUndelivered } from './claude-marker-typing'
import { logInfo, logWarn } from '../debug-logger'
import type { CanvasMarkerUndelivered, SubmitTextResult } from '../../shared/types'

export interface CanvasMarkerWiring {
  /** Deliver one line to the session's agent (main appends the submit key).
   *  A Codex session's write answers later, with whether it was delivered.
   *  `canvasId` is the canvas the marker was filed on, when one was named. */
  write: (sessionId: string, line: string, canvasId?: string) => void | Promise<SubmitTextResult>
  /**
   * Subscribe to Claude Code's own hook stream — the turn boundary. Optional:
   * with hooks disabled there is no boundary to observe, no turn ever reads as
   * open, and every marker is handed on immediately (for Claude Code, still
   * typed only at its ready, empty prompt; claude-marker-typing.ts). Without
   * it the feature loses the turn boundary, not the report: a marker that is
   * then not typed within its bound is still told to its canvas as not sent
   * (onUndelivered).
   */
  subscribe?: (cb: (sessionId: string, event: string) => void) => void
  /** P4.1: a marker that did not reach the agent, with the canvas it was
   *  filed on: one the submit primitive did not deliver, a Claude Code
   *  marker claude-marker-typing.ts dropped untyped (still held after its
   *  bound, its run ended, its session's markers cleared, or refused) or that
   *  had no run to go to, or one the queue still held when its session ended
   *  or restarted. Never called for a delivered or typed one, except a Claude
   *  Code marker whose type request was already sent when its session's
   *  markers were cleared: it is told at the clear and may still be typed
   *  (see the header). */
  onUndelivered?: (u: CanvasMarkerUndelivered) => void
}

let queue: CanvasMarkerQueue | null = null

/** The marker writes still awaiting an answer, per session. The canvas a
 *  marker was filed on travels with its own write (ADR-009 round 1: never
 *  looked up by the line, which two canvases of one session can share); this
 *  only says the session has not ended since, so a late answer for a session
 *  that ended tells no canvas. Each entry goes with its answer. */
const awaiting = new Map<string, Set<object>>()

/** The queue's write: the wiring's, with a later answer followed up. */
function writeThrough(wiring: CanvasMarkerWiring, sessionId: string, line: string, canvasId: string | undefined): void {
  const answer = wiring.write(sessionId, line, canvasId)
  if (!answer || typeof (answer as Promise<SubmitTextResult>).then !== 'function') return
  const token = {}
  let tokens = awaiting.get(sessionId)
  if (!tokens) {
    tokens = new Set()
    awaiting.set(sessionId, tokens)
  }
  tokens.add(token)
  const settle = (): boolean => {
    const current = awaiting.get(sessionId)
    const held = !!current?.delete(token)
    if (current && current.size === 0) awaiting.delete(sessionId)
    return held
  }
  void (answer as Promise<SubmitTextResult>).then(
    (result) => {
      const stillHeld = settle()
      if (!result || result.delivered !== false) return
      if (!canvasId || !stillHeld) {
        logWarn(`[canvas-marker] a marker for ${sessionId} was not delivered (${result.reason}); ${canvasId ? 'the session ended or its markers were cleared since' : 'no canvas was named for it'}, so no canvas is told`)
        return
      }
      logInfo(`[canvas-marker] a marker for ${sessionId} was not delivered (${result.reason})`)
      try { wiring.onUndelivered?.({ sessionId, canvasId, line, reason: result.reason }) } catch { /* the window is gone */ }
    },
    () => { settle() },
  )
}

/** A marker the queue still held when its session ended or restarted: told
 *  to its canvas as not sent (the session gone), as the chain tells one of
 *  its own. A marker with no canvas named (only direct callers;
 *  canvas:agentMarker always names one) tells no canvas. */
function tellForgotten(wiring: CanvasMarkerWiring, sessionId: string, line: string, canvasId: string | undefined): void {
  if (!canvasId) {
    logWarn(`[canvas-marker] ${sessionId}: no canvas was named for a marker held when its session ended, so no canvas is told`)
    return
  }
  try { wiring.onUndelivered?.({ sessionId, canvasId, line, reason: 'session-gone' }) } catch { /* the window is gone */ }
}

/** Wire the queue to the PTY and the hook stream. Called once, at boot. */
export function startCanvasMarkerQueue(wiring: CanvasMarkerWiring): void {
  if (queue) return
  queue = new CanvasMarkerQueue({
    write: (sessionId, line, canvasId) => writeThrough(wiring, sessionId, line, canvasId),
    forgotten: (sessionId, line, canvasId) => tellForgotten(wiring, sessionId, line, canvasId),
  })
  // A Claude Code marker dropped untyped is told to its canvas through the
  // same report (claude-marker-typing.ts calls it with the canvas).
  setClaudeMarkerUndelivered(wiring.onUndelivered ? (u) => wiring.onUndelivered?.(u) : null)
  // A Claude Code marker given back while a turn runs waits here, not at the
  // prompt, while that turn reads open.
  setClaudeMarkerHoldAgain((sessionId, line, canvasId) => queue?.holdAgain(sessionId, line, canvasId) ?? false)
  if (wiring.subscribe) {
    wiring.subscribe((sessionId, event) => {
      queue?.noteHookEvent(sessionId, event)
      // A turn began: a Claude Code marker waiting at the prompt goes back to
      // the queue, which now reads that turn open, rather than spending its
      // bound during it. Told after the queue has read the event.
      if (event === 'UserPromptSubmit') noteClaudeMarkerTurnBegun(sessionId)
    })
    logInfo('[canvas-marker] watching the hook stream for agent turn boundaries')
  } else {
    logInfo('[canvas-marker] no hook stream, so markers are handed on immediately (for Claude Code, still typed only at its ready, empty prompt)')
  }
}

/**
 * Deliver one canvas marker line to a session's agent, now or at the end of the
 * turn in flight. The renderer reaches this through `canvas:agentMarker`.
 * `canvasId` (P4.1): the canvas the marker was filed on, for the notice when
 * a session's marker does not reach the agent (a Codex session's not
 * delivered, a Claude Code session's dropped untyped).
 *
 * Before boot wiring (and in tests that never wire it) there is nothing to
 * deliver to; say so rather than pretending it went out.
 */
export function deliverCanvasMarker(sessionId: string, line: string, canvasId?: string): 'sent' | 'queued' | 'unwired' {
  if (!queue) return 'unwired'
  return queue.deliver(sessionId, line, typeof canvasId === 'string' && canvasId ? canvasId : undefined)
}

/** A session's PTY is gone; drop anything still held for it, at Claude
 *  Code's prompt (claude-marker-typing.ts) and in the queue, and tell each
 *  marker's canvas it was not sent (the session gone), once.
 *
 *  ORDER. The canvas is told in the order the decisions were filed, so a user
 *  who retypes the notices from the top sends them in that order. Every
 *  marker held at Claude Code's prompt was filed before every marker the
 *  queue holds: the queue hands nothing on while it holds any, and a marker
 *  given back to it takes the markers behind it along (canvas-marker-queue.ts,
 *  holdAgain). So the prompt's are told first, at once and in the order handed
 *  in, then the queue's, in the order held. Idempotent: a second call finds
 *  nothing. */
export function forgetCanvasMarkers(sessionId: string): void {
  forgetClaudeMarkers(sessionId)
  queue?.forget(sessionId)
  awaiting.delete(sessionId)
}

/** Test seam. */
export function _resetCanvasMarkerQueueForTest(): void {
  queue = null
  awaiting.clear()
  setClaudeMarkerUndelivered(null)
  setClaudeMarkerHoldAgain(null)
}
