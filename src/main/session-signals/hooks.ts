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
// same redaction and bounding, a ring of its own per session, and HOOKS_EVENT
// to the renderer in the same shape.
import type { HookEvent } from '../../shared/hook-types'
import { IPC } from '../../shared/ipc-channels'
import { onGateway } from '../hooks/index'
import { RING_BUFFER_CAP, type RingBufferEntry } from '../hooks/hooks-types'
import { redactHookPayload } from '../hooks/hook-payload-redactor'
import { boundPayloadForFeed } from '../hooks/bound-feed-payload'
import { boundScalar, boundSummary, buildSummary } from '../hooks/hooks-gateway'
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

/** The entry for any transport: hand one hook event to every consumer. */
export function hookEvent(e: HookEvent, source: HookSignalSource): void {
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

/** Subscribe to the hooks gateway, once: to the gateway set now, or when one
 *  is set, and to each gateway set after it (onGateway drops the earlier
 *  subscription). Called once, at boot, by startSessionSignals. */
export function startHookSignals(): void {
  if (unbind) return
  unbind = onGateway((gw) => gw.subscribe((e) => hookEvent(e, 'gateway')))
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
/** False while the hooks master switch is off (Settings): the gateway takes
 *  nothing then, so neither does this. */
let helperTaken = true

export function setHookFeedEmit(emit: ((channel: string, payload: unknown) => void) | null): void {
  feedEmit = emit
}

/** The hooks master switch (ipc/hooks-handlers.ts HOOKS_TOGGLE). Off drops
 *  every helper ring, as the gateway's stop drops its buffers. */
export function setHelperHooksTaken(on: boolean): void {
  helperTaken = on
  if (!on) {
    helperRings.clear()
    helperOverflowed.clear()
    helperLostLogged.clear()
  }
}

/**
 * The feed entry of a helper event: what the gateway's ingest makes of the
 * same body (hooks-gateway.ts), with the same functions. The kind is the
 * payload's own `hook_event_name` (the holder and readEventFrame both check
 * the two are the same).
 */
function helperFeedEntry(sessionId: string, kind: string, parsed: Record<string, unknown>): RingBufferEntry {
  const event = boundScalar(kind) as string
  const toolName = boundScalar(
    typeof parsed.tool_name === 'string'
      ? (parsed.tool_name as string)
      : typeof parsed.toolName === 'string'
        ? (parsed.toolName as string)
        : undefined,
  )
  const rawPayload =
    parsed.payload && typeof parsed.payload === 'object'
      ? (parsed.payload as Record<string, unknown>)
      : (parsed as Record<string, unknown>)
  let redacted: Record<string, unknown>
  try {
    redacted = redactHookPayload(rawPayload)
  } catch {
    redacted = { error: 'redaction-failed' }
  }
  return {
    sessionId,
    event,
    toolName,
    summary: boundSummary(buildSummary(event, toolName, redacted)),
    payload: boundPayloadForFeed(redacted),
    ts: Date.now(),
  }
}

/**
 * One hook event of `sessionId` (the app's id for the tab) that its holder
 * passed on. In the gateway's order: the transcript path first (lifted before
 * redaction, through sanitiseTranscriptPath; a value that does not pass is
 * dropped and logged by its length only), then the entry into the session's
 * ring, the consumers, and the renderer. Events the holder dropped while no
 * app was attached (`lost`) are logged once per session.
 */
export function helperHookEvent(sessionId: string, e: HelperHookEvent): void {
  if (!helperTaken) return
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
  const entry = helperFeedEntry(sessionId, e.kind, parsed)
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
 *  the gateway's go when the session is unregistered. */
export function endHelperHooks(sessionId: string): void {
  helperRings.delete(sessionId)
  helperOverflowed.delete(sessionId)
  helperLostLogged.delete(sessionId)
}

/**
 * The feed history of a session (ipc/hooks-handlers.ts HOOKS_GET_BUFFER):
 * the gateway's ring as it is, unless some of the session's events came
 * through the helper; then both rings in the order the events came (the
 * gateway still takes the session's PreToolUse), the newest RING_BUFFER_CAP.
 */
export function hookFeedBuffer(sessionId: string, gatewayRing: RingBufferEntry[]): RingBufferEntry[] {
  const mine = helperRings.get(sessionId)
  if (!mine || mine.length === 0) return gatewayRing
  const merged = [...gatewayRing, ...mine].sort((a, b) => a.ts - b.ts)
  return merged.length > RING_BUFFER_CAP ? merged.slice(merged.length - RING_BUFFER_CAP) : merged
}

/** Test seam: forget every consumer, the gateway binding, the sink, and the
 *  helper's rings and emit. */
export function _resetHookSignalsForTest(): void {
  consumers.clear()
  if (unbind) { unbind(); unbind = null }
  transcriptPathSink = null
  feedEmit = null
  helperTaken = true
  helperRings.clear()
  helperOverflowed.clear()
  helperLostLogged.clear()
}
