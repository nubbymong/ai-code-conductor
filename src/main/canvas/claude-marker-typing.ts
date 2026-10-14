// A canvas marker line into a Claude Code session, typed only at Claude
// Code's READY, EMPTY prompt.
//
// A marker line is typed only at Claude Code's ready, empty prompt, held until
// then, in order, for at most CLAUDE_MARKER_HOLD_MS, and dropped with its run,
// as the status strip's controls type only there. A marker dropped untyped is
// told to its canvas as not sent. Main holds no reading of a Claude session's
// screen, so it asks the renderer, whose terminal shows it.
//
// THE RULE. The same reading the status strip's Compact, model and effort
// controls type through (src/shared/claude-screen.ts, read by
// src/renderer/lib/claudePrompt.ts on the session's own terminal). For each
// marker, in order, one at a time per session:
//  1. ask the renderer to READ the screen (a probe, nothing typed);
//  2. only when it reads Claude Code's ready, empty prompt, wait
//     CLAUDE_MARKER_SECOND_READ_MS, check the run is still the one the marker
//     was handed for, and ask the renderer to TYPE the line, which it does
//     only if the screen still reads ready and empty at that moment (and no
//     line was typed into the session in the last second);
//  3. anything else (a question, a running turn, text at the prompt, a view
//     of the history, a screen it does not recognise, no answer at all): type
//     nothing, wait CLAUDE_MARKER_POLL_MS and read again.
// Fail closed: a marker is HELD until the prompt reads ready and empty, and is
// never typed on any other reading. It is held for at most
// CLAUDE_MARKER_HOLD_MS from when its turn in the chain begins (unless a type
// request went unanswered: the bound then waits for a probe to answer, so the
// bound never reports a line the renderer may have typed), and only while its
// run lives. It is dropped when that bound passes, when its run ends (the
// session's markers die with it, as the queue's do), when the session's
// markers are cleared, or when the renderer refuses the request as not well
// formed (no later read changes that). A dropped marker is never typed later
// (except one whose type request was already sent when its session's markers
// were cleared: see below), and never dropped unseen: it goes, with the canvas
// it was filed on, to the canvas wiring's not-delivered report
// (setClaudeMarkerUndelivered), and the canvas says on that review that it was
// not sent, and why (a marker with no canvas named, which only a direct caller
// hands in, is logged).
//
// When the session's markers are cleared (forgetClaudeMarkers, at its
// session's end or restart), every marker still held for it is reported there
// at once, in the order handed in, not at its next read, so the canvas wiring
// can tell these before the ones its queue holds (filed after them). Its own
// run then stops at its next check, asks the renderer for nothing more and
// reports nothing more. That includes a marker whose type request is still
// unanswered: the run it may reach is ending, so it is reported as the session
// gone, as when its run ends first (typeClaudeMarkerWhenReady). That request
// was already on its way, so the renderer may still type the line after the
// canvas has been told it was not sent; main only logs that answer.
//
// A RUN is the session's terminal process, not Claude Code's own: a new run of
// the terminal (a restart) never receives a marker held for the one before,
// but a Claude Code started again by hand in the same terminal does, once its
// prompt reads ready and empty, within the bound.
//
// GIVEN BACK TO THE QUEUE. A held marker does not spend its bound here while
// an agent turn runs that the session's canvas marker queue can see (Claude
// Code's hook stream). It is offered back to that queue
// (setClaudeMarkerHoldAgain) once any of these has happened since it was
// handed in:
//  - a line was typed ahead of it (that line starts a turn);
//  - a marker ahead of it was given back (this one, filed after it, follows
//    it to the queue rather than being typed ahead of it; it may have been
//    handed in after the line was typed, before the queue read the turn
//    open);
//  - a turn began: Claude Code's UserPromptSubmit reached the queue
//    (noteClaudeMarkerTurnBegun), for example when the user sends text they
//    had typed at the prompt, or for a line typed just before this marker
//    was handed in.
// The queue takes it only while it reads a turn open. It then waits there,
// in order, for the turn's Stop under the queue's own fallback bound, and is
// handed in again with a bound of its own. The markers behind one given back
// are offered in turn straight away, before any hook event can reach the
// queue, so it still reads the turn open and takes each, in order. A marker
// is offered back only while no type request of its own is unanswered (it is
// handed in again under a new id, so one the renderer may have typed is
// never offered), and only while its run lives. From then on it is the
// queue's. With no hook stream no turn reads open or is reported begun, and
// nothing is given back.
//
// Each marker has one id, the same on every request for it, so a marker the
// renderer typed whose answer came after main stopped waiting is not typed a
// second time. A line the same as one still held for the session, filed on
// the same canvas, is collapsed into it, as the queue collapses an identical
// pending line; the same words filed on another canvas are another marker,
// typed in their turn (two canvases of one session can file the same words).
//
// The renderer half is one main -> renderer request and one reply, id
// correlated, with a timeout (as canvas-snapshot-broker.ts does): this module
// owns the pending map and the timeout; the IPC layer moves the bytes.

import { randomId } from '../../shared/id'
import { CLAUDE_MARKER_REFUSED } from '../../shared/canvas-marker-line'
import type { CanvasMarkerUndelivered, ClaudeMarkerAnswer, ClaudeMarkerAsk, ClaudeMarkerMode, SubmitNotDeliveredReason } from '../../shared/types'
import { MARKER_FALLBACK_FLUSH_MS } from './canvas-marker-queue'
import { logInfo, logWarn } from '../debug-logger'

/** How often a held marker's prompt is read again. */
export const CLAUDE_MARKER_POLL_MS = 1_000
/** Ready means ready on two reads this far apart: a frame half drawn, or a
 *  question arriving just as the prompt is read, is not taken for it. */
export const CLAUDE_MARKER_SECOND_READ_MS = 300
/** How long one request waits for the renderer's answer (a window that is
 *  reloading or gone answers nothing). No answer is not ready. */
export const CLAUDE_MARKER_ANSWER_MS = 5_000
/** How long one marker is held while the prompt does not read ready and
 *  empty, from when its turn in the session's chain begins. After it the
 *  marker is dropped, never typed, and its canvas is told it was not sent.
 *  The marker queue's own fallback bound, reused on purpose: it is also the
 *  bound the other provider's marker submit waits (pty-manager's
 *  writeCanvasMarkerLine), so the canvas notice's "for two minutes" holds for
 *  every session. */
export const CLAUDE_MARKER_HOLD_MS = MARKER_FALLBACK_FLUSH_MS

/** One request to the renderer, as the IPC layer sends it. False when there
 *  was no window to send it to. */
type Sender = (ask: ClaudeMarkerAsk) => boolean

/** The canvas wiring's not-delivered report (canvas-marker-delivery.ts). */
type Undelivered = (u: CanvasMarkerUndelivered) => void

/** The canvas marker queue's holdAgain (canvas-marker-delivery.ts): takes a
 *  marker back while the session's turn reads open (true), else takes
 *  nothing (false). */
type HoldAgain = (sessionId: string, line: string, canvasId: string | undefined) => boolean

interface Pending {
  resolve: (answer: ClaudeMarkerAnswer | null) => void
  timer: ReturnType<typeof setTimeout>
}

let sender: Sender | null = null
let undelivered: Undelivered | null = null
let holdAgain: HoldAgain | null = null
const pending = new Map<string, Pending>()

/** Installed by the IPC layer, which owns the window handle. */
export function setClaudeMarkerSender(fn: Sender | null): void {
  sender = fn
}

/** Installed by the canvas wiring at boot (startCanvasMarkerQueue): where a
 *  dropped marker is reported, with the canvas it was filed on. */
export function setClaudeMarkerUndelivered(fn: Undelivered | null): void {
  undelivered = fn
}

/** Installed by the canvas wiring at boot (startCanvasMarkerQueue): where a
 *  held marker is given back while a turn runs (see GIVEN BACK TO THE QUEUE
 *  above). */
export function setClaudeMarkerHoldAgain(fn: HoldAgain | null): void {
  holdAgain = fn
}

/** Ask the renderer to read (probe) or type at the session's Claude Code
 *  prompt, for the marker `markerId`. Resolves its answer, or null when there
 *  was no window or no answer in CLAUDE_MARKER_ANSWER_MS. Never rejects. */
export function askClaudePrompt(sessionId: string, mode: ClaudeMarkerMode, line: string, markerId: string): Promise<ClaudeMarkerAnswer | null> {
  if (!sender) return Promise.resolve(null)
  const requestId = randomId()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      resolve(null)
    }, CLAUDE_MARKER_ANSWER_MS)
    ;(timer as { unref?: () => void }).unref?.()
    pending.set(requestId, { resolve, timer })
    let sent = false
    try { sent = sender?.({ requestId, sessionId, markerId, mode, line }) === true } catch { sent = false }
    if (!sent) {
      clearTimeout(timer)
      pending.delete(requestId)
      resolve(null)
    }
  })
}

/** Whatever arrived on the answer channel. An unknown, late or malformed
 *  answer is dropped. */
export function resolveClaudeMarkerAnswer(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return
  const answer = raw as Partial<ClaudeMarkerAnswer>
  if (typeof answer.requestId !== 'string') return
  const waiting = pending.get(answer.requestId)
  if (!waiting) return
  pending.delete(answer.requestId)
  clearTimeout(waiting.timer)
  const reason = typeof answer.reason === 'string' ? answer.reason.slice(0, 200) : undefined
  waiting.resolve({ requestId: answer.requestId, ok: answer.ok === true, ...(reason !== undefined ? { reason } : {}) })
}

export interface ClaudeMarkerTypingDeps {
  /** One request to the renderer (askClaudePrompt in the app). */
  ask: (mode: ClaudeMarkerMode) => Promise<ClaudeMarkerAnswer | null>
  /** Still the run the marker was handed for, and its markers not cleared. */
  live: () => boolean
  sleep: (ms: number) => Promise<void>
  /** The clock the hold bound is read on (Date.now in the app). */
  now?: () => number
  log?: (msg: string) => void
  /** Give the marker back to the canvas marker queue now, if that is right
   *  for it (queueClaudeMarkerLine). True when the queue took it: the hold
   *  then ends, nothing typed. Asked before each read while the run lives
   *  and no type request of this marker is unanswered. */
  giveBack?: () => boolean
}

/** How a marker's hold ended. */
export type ClaudeMarkerOutcome = 'typed' | 'gone' | 'refused' | 'timeout' | 'given-back'

/**
 * Type one marker line at Claude Code's ready, empty prompt, holding it until
 * the prompt reads so (see the rule above). Resolves 'typed'; 'gone' when its
 * run ended or its session's markers were cleared first; 'refused' when the
 * renderer refused the request as not well formed; 'timeout' when the prompt
 * still did not read ready and empty CLAUDE_MARKER_HOLD_MS after it began;
 * 'given-back' when deps.giveBack took it. Never rejects.
 */
export async function typeClaudeMarkerWhenReady(deps: ClaudeMarkerTypingDeps): Promise<ClaudeMarkerOutcome> {
  const ask = async (mode: ClaudeMarkerMode): Promise<ClaudeMarkerAnswer | null> => {
    try { return await deps.ask(mode) } catch { return null }
  }
  const now = (): number => {
    try { return deps.now ? deps.now() : Date.now() } catch { return Date.now() }
  }
  const giveBack = (): boolean => {
    try { return deps.giveBack?.() === true } catch { return false }
  }
  const holdUntil = now() + CLAUDE_MARKER_HOLD_MS
  let lastReason: string | undefined
  // A type request that got no answer may still have been typed (its answer
  // late). The bound never ends the hold until a probe answers, because a
  // probe for a marker the renderer typed reads as typed: the bound never
  // reports a line that may have been typed. A run that ends first still ends
  // the hold as 'gone', reported as the session gone, even though the
  // renderer may have typed the line into that run meanwhile: the run it
  // reached is over. Nor is the marker given back until a probe answers.
  let typeUnanswered = false
  for (;;) {
    if (!deps.live()) return 'gone'
    if (!typeUnanswered && giveBack()) return 'given-back'
    const probe = await ask('probe')
    if (!deps.live()) return 'gone'
    if (probe?.ok === true) {
      // The type request below decides typeUnanswered for this pass.
      await deps.sleep(CLAUDE_MARKER_SECOND_READ_MS)
      if (!deps.live()) return 'gone'
      const typed = await ask('type')
      if (typed?.ok === true) return 'typed'
      if (typed?.reason === CLAUDE_MARKER_REFUSED) return 'refused'
      typeUnanswered = typed === null
      lastReason = typed?.reason ?? 'no answer'
    } else {
      if (probe?.reason === CLAUDE_MARKER_REFUSED) return 'refused'
      if (probe !== null) typeUnanswered = false
      const reason = probe?.reason ?? 'no answer'
      // One line each time the reason changes, not one a second.
      if (reason !== lastReason) {
        try { deps.log?.(`held: ${reason}`) } catch { /* a log line never breaks the rule */ }
      }
      lastReason = reason
    }
    if (!typeUnanswered && now() >= holdUntil) return 'timeout'
    await deps.sleep(CLAUDE_MARKER_POLL_MS)
  }
}

/** One marker still held for a session: its line, the canvas it was filed on,
 *  the not-delivered report installed when it was handed in, and whether that
 *  report has been told about it already (forgetClaudeMarkers tells it at
 *  once; its run then reports nothing more). */
interface HeldMarker {
  line: string
  canvasId: string | undefined
  tell: Undelivered | null
  told: boolean
}

/** Per session: the markers in flight, one at a time, in the order handed in;
 *  the markers still held (not yet typed or dropped), in the order handed in,
 *  each keyed by its line and the canvas it was filed on (heldKey); how many
 *  markers have been typed; how many have been given back to the queue; how
 *  many turns the queue has seen begin; and a generation that clearing the
 *  session's markers moves on. */
interface SessionChain {
  generation: number
  chain: Promise<unknown>
  held: Map<string, HeldMarker>
  typed: number
  givenBack: number
  turnsBegun: number
}

const chains = new Map<string, SessionChain>()

/** A held marker's key: its line and the canvas it was filed on (none when
 *  the caller named none), as the queue keys its own collapse. */
const heldKey = (line: string, canvasId: string | undefined): string => JSON.stringify([line, canvasId ?? null])

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const t = setTimeout(resolve, Math.max(0, ms))
  ;(t as { unref?: () => void }).unref?.()
})

type Dropped = Exclude<ClaudeMarkerOutcome, 'typed' | 'given-back'>

/** What the canvas is told about a dropped marker, in the not-delivered
 *  reasons it already shows (its notice's words for each). */
const DROP_REASON: Record<Dropped, SubmitNotDeliveredReason> = {
  timeout: 'busy-timeout',
  gone: 'session-gone',
  refused: 'refused-text',
}

/** The log line's words for each. */
const DROP_WORDS: Record<Dropped, string> = {
  timeout: `its prompt did not read ready and empty within ${CLAUDE_MARKER_HOLD_MS} ms`,
  gone: 'the session ended or its markers were cleared',
  refused: 'the renderer refused it as not well formed',
}

/** Tell the canvas a marker it filed was not sent. A marker with no canvas
 *  named (only direct callers; canvas:agentMarker always names one) tells no
 *  canvas, as the other provider's not-delivered path does. */
function reportDropped(tell: Undelivered | null, sessionId: string, canvasId: string | undefined, line: string, reason: SubmitNotDeliveredReason): void {
  if (!canvasId) {
    logWarn(`[canvas-marker] ${sessionId}: no canvas was named for the dropped marker, so no canvas is told`)
    return
  }
  if (!tell) {
    logWarn(`[canvas-marker] ${sessionId}: no canvas wiring to tell about the dropped marker`)
    return
  }
  try { tell({ sessionId, canvasId, line, reason }) } catch { /* the window is gone */ }
}

/**
 * Hand one marker line to the session's chain: typed at Claude Code's ready,
 * empty prompt after every marker handed in before it (the queue's order is
 * kept). `runLive` says whether the run the marker was handed for is still
 * the session's terminal process. `canvasId` is the canvas the marker was
 * filed on, when the caller named one. A line the same as one still held for
 * the session and filed on the same canvas is collapsed into it; the same
 * line about another canvas is held and typed as its own marker. A marker
 * dropped untyped (see the rule above) is reported once, with its canvas, to
 * the not-delivered report installed when it was handed in. A marker behind a
 * line typed since it was handed in, or behind a marker given back since
 * then, or held when a turn began since then, is given back to the queue
 * while a turn reads open (see GIVEN BACK TO THE QUEUE above), through the
 * holdAgain installed when it was handed in. Returns at once.
 */
export function queueClaudeMarkerLine(sessionId: string, line: string, runLive: () => boolean, canvasId?: string): void {
  let entry = chains.get(sessionId)
  if (!entry) {
    entry = { generation: 0, chain: Promise.resolve(), held: new Map(), typed: 0, givenBack: 0, turnsBegun: 0 }
    chains.set(sessionId, entry)
  }
  const mine = entry
  const key = heldKey(line, canvasId)
  if (mine.held.has(key)) {
    logInfo(`[canvas-marker] ${sessionId}: a marker the same as one still held for Claude Code, for the same canvas, was collapsed into it`)
    return
  }
  const tell = undelivered
  const record: HeldMarker = { line, canvasId, tell, told: false }
  mine.held.set(key, record)
  const generation = mine.generation
  const markerId = randomId()
  const back = holdAgain
  const typedBefore = mine.typed
  const givenBackBefore = mine.givenBack
  const turnsBegunBefore = mine.turnsBegun
  const live = (): boolean => {
    if (chains.get(sessionId) !== mine || mine.generation !== generation) return false
    try { return runLive() } catch { return false }
  }
  // Offered back only once, since it was handed in, a marker ahead of it was
  // typed (its turn runs) or given back (it waits in the queue, and this one
  // follows it there), or a turn began (it runs while this one waits); the
  // queue takes it only while a turn reads open. Only the marker at the head
  // of the chain is typed or given back, so those two counts move, after this
  // one was handed in, only for a marker ahead of it; the turns count moves
  // for every turn the queue sees begin in the session.
  const giveBack = (): boolean => back !== null
    && (mine.typed !== typedBefore || mine.givenBack !== givenBackBefore || mine.turnsBegun !== turnsBegunBefore)
    && live() && back(sessionId, line, canvasId) === true
  const run = async (): Promise<void> => {
    let result: ClaudeMarkerOutcome = 'gone'
    try {
      result = await typeClaudeMarkerWhenReady({
        ask: (mode) => askClaudePrompt(sessionId, mode, line, markerId),
        live,
        sleep,
        now: () => Date.now(),
        log: (msg) => logInfo(`[canvas-marker] ${sessionId}: a marker for Claude Code is ${msg}`),
        giveBack,
      })
    } finally {
      mine.held.delete(key)
    }
    if (result === 'typed') {
      mine.typed++
      logInfo(`[canvas-marker] ${sessionId}: a marker was typed at Claude Code's ready prompt${record.told ? ' as its session\'s markers were cleared (it was already reported as not sent, the session gone)' : ''}`)
      return
    }
    if (result === 'given-back') {
      mine.givenBack++
      logInfo(`[canvas-marker] ${sessionId}: a held marker was given back and waits in the queue for the turn to end (one ahead of it was typed or given back, or a turn began)`)
      return
    }
    // Reported once, when the session's markers were cleared: never twice.
    if (record.told) return
    logWarn(`[canvas-marker] ${sessionId}: a held marker was dropped, untyped: ${DROP_WORDS[result]}`)
    reportDropped(tell, sessionId, canvasId, line, DROP_REASON[result])
  }
  const next = mine.chain.then(run, run)
  mine.chain = next.catch(() => undefined)
}

/** A turn began in the session: Claude Code's UserPromptSubmit reached the
 *  canvas marker queue (the canvas wiring calls this right after the queue
 *  has read it). Every marker held for the session now is offered back to
 *  the queue before its next read (one further down the chain, before its
 *  first), unless a type request of its own is unanswered, so it waits for
 *  that turn's Stop there rather than spending its bound at the prompt (see
 *  GIVEN BACK TO THE QUEUE above). A marker handed in after this call is not
 *  offered for it. A session with no marker handed in is left as it is. */
export function noteClaudeMarkerTurnBegun(sessionId: string): void {
  const entry = chains.get(sessionId)
  if (entry) entry.turnsBegun++
}

/** The session's run ended, or its markers were cleared: every marker still
 *  held for it is reported as not sent (the session gone) at once, in the
 *  order handed in, and then stops at its next check, asking the renderer
 *  for nothing more and reporting nothing more (a type request already sent
 *  may still be answered, even typed: see the header). Synchronous, so the
 *  caller (forgetCanvasMarkers) can tell these before the markers its queue
 *  holds, which were filed after them. Idempotent: the session's chain is
 *  removed here, so a second call finds nothing. */
export function forgetClaudeMarkers(sessionId: string): void {
  const entry = chains.get(sessionId)
  if (!entry) return
  entry.generation++
  chains.delete(sessionId)
  const still = [...entry.held.values()]
  if (still.length === 0) return
  logWarn(`[canvas-marker] ${sessionId}: ${still.length} held marker(s) for Claude Code dropped, untyped: ${DROP_WORDS.gone}`)
  for (const marker of still) {
    // Marked before it is told, so nothing the report does can tell it twice.
    marker.told = true
    reportDropped(marker.tell, sessionId, marker.canvasId, marker.line, DROP_REASON.gone)
  }
}

/** Test seam. */
export function _resetClaudeMarkerTypingForTest(): void {
  for (const waiting of pending.values()) clearTimeout(waiting.timer)
  pending.clear()
  for (const entry of chains.values()) entry.generation++
  chains.clear()
  sender = null
  undelivered = null
  holdAgain = null
}
