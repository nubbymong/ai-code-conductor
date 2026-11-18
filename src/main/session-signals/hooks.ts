// src/main/session-signals/hooks.ts
// What a hook event means: the one subscriber to the hooks gateway in the main
// process (ADR-030 component row 13; 2.1.3-beta.8, section A2).
//
// Before this module, each consumer subscribed to the gateway on its own: the
// notification rules, the effort tracker, the canvas marker queue's turn
// boundary, the attention dot, the conversation claim (src/main/index.ts) and
// the Watchdog's StopFailure. Each now takes events from here (onHookEvent),
// and this module holds the one gateway subscription. Delivery is what the
// gateway's own fan-out did: every consumer gets every event, once, in the
// order the consumers registered (a Set keeps insertion order, as the
// gateway's subscriber set did), each event to the consumers registered when
// it arrived, and a consumer that throws stops none of the others.
//
// The renderer's HOOKS_EVENT feed, the ring buffer and the redaction stay in
// the gateway for the events it takes; nothing here changes what an event
// does.
//
// 2.1.3-beta.8, section A4: a second transport. A Claude Code session the
// session helper holds sends its hook events (all but PreToolUse) through its
// holder, and the session helper manager hands each one here
// (helperHookEvent). Such an event gets what the gateway gives its own before
// the same fan-out: the transcript path through the same shape filter, the
// feed entry from the gateway's own builder (feedEntryOf: the redaction and
// the bounding), a ring of its own per session, and HOOKS_EVENT to the
// renderer in the same shape. It is taken only while the gateway would take
// its own, read from the gateway at each event.
import type { HookEvent } from '../../shared/hook-types'
import { IPC } from '../../shared/ipc-channels'
import { onGateway, type HooksGatewayLike } from '../hooks/index'
import { RING_BUFFER_CAP, type RingBufferEntry } from '../hooks/hooks-types'
import { feedEntryOf } from '../hooks/hooks-gateway'
import { sanitiseTranscriptPath } from '../logging/transcript-discovery'
import { logWarn } from '../debug-logger'

/** Where a hook event or a transcript path came from: the hooks gateway, or
 *  a session's holder (the session helper). */
export type HookSignalSource = 'gateway' | 'helper'

export type HookConsumer = (e: HookEvent, source: HookSignalSource) => void

const consumers = new Set<HookConsumer>()

/** Hear every hook event, after the consumers registered before this one.
 *  Returns the unsubscribe. Registering a consumer already registered changes
 *  nothing; one that unsubscribed and registers again goes to the end. */
export function onHookEvent(cb: HookConsumer): () => void {
  consumers.add(cb)
  return () => { consumers.delete(cb) }
}

/** The order hook events reached main, across both transports: the feed
 *  history read (hookFeedBuffer) lists a session's events from the two rings
 *  in this order. Keyed by the event itself, the very object each ring keeps. */
const arrival = new WeakMap<object, number>()
let arrivals = 0

/** The entry for any transport: hand one hook event to every consumer. */
export function hookEvent(e: HookEvent, source: HookSignalSource): void {
  if (e && typeof e === 'object') arrival.set(e, ++arrivals)
  for (const cb of [...consumers]) {
    try { cb(e, source) } catch { /* a consumer that throws must not stop the others */ }
  }
}

let transcriptPathSink: ((sessionId: string, path: string) => void) | null = null

/** Where a transcript path a hook reported goes (main's route, which calls
 *  pty-manager's routeHookTranscriptPath). Set once, at boot. */
export function setHookTranscriptPathSink(sink: ((sessionId: string, path: string) => void) | null): void {
  transcriptPathSink = sink
}

/** A transcript path a transport lifted from a hook event (and passed through
 *  sanitiseTranscriptPath), handed to the route once. A throw reaches the
 *  caller (the supervisor catches it, as before). */
export function transcriptPath(sessionId: string, path: string, _source: HookSignalSource): void {
  transcriptPathSink?.(sessionId, path)
}

let unbind: (() => void) | null = null
/** The gateway this module is subscribed to now (the one onGateway bound). */
let bound: HooksGatewayLike | null = null

/** Subscribe to the hooks gateway, once: to the gateway set now, or when one
 *  is set, and to each gateway set after it (onGateway drops the earlier
 *  subscription). Called once, at boot, by startSessionSignals. */
export function startHookSignals(): void {
  if (unbind) return
  unbind = onGateway((gw) => {
    bound = gw
    const off = gw.subscribe((e) => hookEvent(e, 'gateway'))
    return () => {
      off()
      if (bound === gw) bound = null
    }
  })
}

// ── hook events through the session helper (section A4) ──────────────────────

/** One hook event a session's holder passed on (session-helper/protocol.ts
 *  readEventFrame): the payload as Claude Code wrote it (cut by the hook mode
 *  when it was large, which a top-level `"cut": true` says), untrusted text. */
export interface HelperHookEvent {
  kind: string
  payload: Record<string, unknown>
  /** How many events the holder dropped just before this one. */
  lost?: number
}

/** Where HOOKS_EVENT and HOOKS_DROPPED go: the window, as the gateway's own
 *  emit sends them. Set once, at boot. */
let feedEmit: ((channel: string, payload: unknown) => void) | null = null
/** The feed history of each session whose hooks come through the helper, as
 *  the gateway keeps one for its own (hooks-gateway.ts getBuffer). */
const helperRings = new Map<string, RingBufferEntry[]>()
/** Sessions whose ring overflowed (HOOKS_DROPPED goes once), and whose lost
 *  events were logged (once). */
const helperOverflowed = new Set<string>()
const helperLostLogged = new Set<string>()

export function setHookFeedEmit(emit: ((channel: string, payload: unknown) => void) | null): void {
  feedEmit = emit
}

/**
 * Whether the app takes hook events now: the gateway this module is bound to
 * is on and listening, so it would take its own (a gateway that is off, one
 * whose child has not bound yet or is restarting, and the never-started one
 * of a boot with the hooks switch saved off, take none). Read live at each
 * helper event and at each switch to the helper (app-wiring.ts), never
 * mirrored from what a toggle once answered: a start that gave up waiting
 * for its child's bind is followed by a bind later, with no toggle.
 */
export function helperHooksTaken(): boolean {
  const s = bound?.status()
  return s?.enabled === true && s.listening === true
}

/**
 * One hook event of `sessionId` (the app's id for the tab) that its holder
 * passed on. In the gateway's order: the transcript path first (lifted before
 * redaction, through sanitiseTranscriptPath; a value that does not pass is
 * dropped and logged by its length only), then the feed entry (the gateway's
 * own feedEntryOf, so the redaction and the bounding cannot drift from it;
 * the kind is the payload's own `hook_event_name`, which readEventFrame
 * checks), the entry into the session's ring, the consumers, and the
 * renderer. Events the holder dropped while no app was attached (`lost`) are
 * logged once per session. None is taken while the gateway would take none
 * (helperHooksTaken).
 */
export function helperHookEvent(sessionId: string, e: HelperHookEvent): void {
  if (!helperHooksTaken()) return
  if (typeof e.lost === 'number' && e.lost > 0 && !helperLostLogged.has(sessionId)) {
    helperLostLogged.add(sessionId)
    logWarn(`[hooks] the session helper dropped ${e.lost} hook event(s) of ${sessionId} while the app was not attached`)
  }
  const parsed = e.payload
  const tp = sanitiseTranscriptPath(parsed.transcript_path)
  if (tp) {
    try { transcriptPath(sessionId, tp, 'helper') } catch { /* discovery sink must not break the hook path */ }
  } else if (parsed.transcript_path !== undefined) {
    logWarn(`[hooks] dropped an unusable transcript_path from the session helper sid=${sessionId} type=${typeof parsed.transcript_path} length=${typeof parsed.transcript_path === 'string' ? parsed.transcript_path.length : 'n/a'}`)
  }
  const entry = feedEntryOf(sessionId, e.kind, parsed)
  const ring = helperRings.get(sessionId) ?? []
  ring.push(entry)
  if (ring.length > RING_BUFFER_CAP) {
    ring.splice(0, ring.length - RING_BUFFER_CAP)
    if (!helperOverflowed.has(sessionId)) {
      helperOverflowed.add(sessionId)
      try { feedEmit?.(IPC.HOOKS_DROPPED, { sessionId }) } catch { /* destroyed window */ }
    }
  }
  helperRings.set(sessionId, ring)
  hookEvent(entry as HookEvent, 'helper')
  try { feedEmit?.(IPC.HOOKS_EVENT, entry as HookEvent) } catch { /* destroyed window */ }
}

/** The session's run through the helper is over: its ring and marks go, as
 *  the gateway's go when the session is unregistered. The hooks switch going
 *  off is not this: see dropHelperRings. */
export function endHelperHooks(sessionId: string): void {
  helperRings.delete(sessionId)
  helperOverflowed.delete(sessionId)
  helperLostLogged.delete(sessionId)
}

/**
 * The hooks switch went off and the gateway the app runs cleared its own
 * rings at its stop: every session's helper ring goes with them, and so do
 * the overflow marks (the gateway clears its latches there too). Without
 * this the history read would return a held session's helper events without
 * the PreToolUse entries that went. The history read keeps both rings or
 * neither, so this is called for exactly the gateways that clear theirs at a
 * stop: the in-process HooksGateway (a boot with the switch saved off and
 * then turned on in Settings), and the proxy after its fail-open, whose stop
 * stops that one. The proxy with its child out of process keeps its rings at
 * a stop, so it does not call this (ipc/hooks-handlers.ts HOOKS_TOGGLE). The
 * fail-open itself keeps both as well: the proxy hands its mirror of the
 * child's rings to the in-process gateway it starts (hooks-gateway-proxy.ts
 * failOpen, HooksGateway.seedBuffers), so after it the gateway's ring still
 * holds the PreToolUse entries from before it, next to the helper's ring. The
 * lost-event marks stay: they belong to a session's run, not to a ring.
 */
export function dropHelperRings(): void {
  helperRings.clear()
  helperOverflowed.clear()
}

/**
 * The feed history of a session (ipc/hooks-handlers.ts HOOKS_GET_BUFFER):
 * the gateway's ring as it is, unless some of the session's events came
 * through the helper; then both rings in the order the events reached main
 * (the gateway still takes the session's PreToolUse), whatever their clocks
 * say, the newest RING_BUFFER_CAP. An event this module never saw (none, as
 * the module hears every gateway event from the start) goes first, by time.
 */
export function hookFeedBuffer(sessionId: string, gatewayRing: RingBufferEntry[]): RingBufferEntry[] {
  const mine = helperRings.get(sessionId)
  if (!mine || mine.length === 0) return gatewayRing
  const order = (e: RingBufferEntry) => arrival.get(e) ?? 0
  const merged = [...gatewayRing, ...mine].sort((a, b) => order(a) - order(b) || a.ts - b.ts)
  return merged.length > RING_BUFFER_CAP ? merged.slice(merged.length - RING_BUFFER_CAP) : merged
}

/** Test seam: forget every consumer, the gateway binding, the sink, and the
 *  helper's rings and emit. */
export function _resetHookSignalsForTest(): void {
  consumers.clear()
  if (unbind) { unbind(); unbind = null }
  bound = null
  transcriptPathSink = null
  feedEmit = null
  helperRings.clear()
  helperOverflowed.clear()
  helperLostLogged.clear()
}
