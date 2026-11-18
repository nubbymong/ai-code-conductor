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
// the gateway; nothing here changes what an event does.
import type { HookEvent } from '../../shared/hook-types'
import { onGateway } from '../hooks/index'

/** Where a hook event or a transcript path came from. Only the hooks gateway
 *  for now; the session helper is a later slice. */
export type HookSignalSource = 'gateway'

export type HookConsumer = (e: HookEvent, source: HookSignalSource) => void

const consumers = new Set<HookConsumer>()

/** Hear every hook event, after the consumers registered before this one.
 *  Returns the unsubscribe; a consumer registered again goes to the end. */
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

/** A transcript path the gateway lifted from a hook POST, handed to the route
 *  once. A throw reaches the caller (the supervisor catches it, as before). */
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

/** Test seam: forget every consumer, the gateway binding and the sink. */
export function _resetHookSignalsForTest(): void {
  consumers.clear()
  if (unbind) { unbind(); unbind = null }
  transcriptPathSink = null
}

/** Test seam: how many consumers are registered. */
export function _hookConsumerCountForTest(): number {
  return consumers.size
}
