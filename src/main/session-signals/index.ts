// src/main/session-signals/index.ts
// The session signals module: the one owner of what a status line or a hook
// event means (ADR-030 component row 13; 2.1.3-beta.8, section A2).
//   hooks.ts   the one subscriber to the hooks gateway; consumers take events
//              from it (onHookEvent), and the transcript path the gateway
//              reports goes through it to main's route. From section A4 it
//              also takes the hook events a session's holder passes on
//              (helperHookEvent), with a feed ring of its own for them.
//   status.ts  the status line fan-out (deliverStatus) and its two sinks. The
//              sinks are not re-exported here, so a status sink cannot be
//              taken for the hook route's (setHookTranscriptPathSink): set
//              them through statusline-watcher.ts, which re-exports them.
// It moves meaning only: every transport (the gateway, the session helper,
// the status file watch, the MCP /status ingest, the SSH sentinel) stays
// where it was.
import { setHookFeedEmit, setHookTranscriptPathSink, startHookSignals } from './hooks'

export { onHookEvent, hookEvent, transcriptPath, helperHookEvent, endHelperHooks, dropHelperRings, hookFeedBuffer, helperHooksTaken } from './hooks'
export type { HookConsumer, HookSignalSource, HelperHookEvent } from './hooks'
export { deliverStatus } from './status'

export interface SessionSignalSinks {
  /** Where a transcript path a hook reported goes: main's route, which calls
   *  pty-manager's routeHookTranscriptPath. */
  onTranscriptPath: (sessionId: string, path: string) => void
  /** Where the feed of a hook event that came through the session helper goes
   *  (HOOKS_EVENT, HOOKS_DROPPED): the window, as the gateway's own emit. */
  emit?: (channel: string, payload: unknown) => void
}

/** Start the module, once, at boot: the transcript route, the helper events'
 *  feed, and the one subscription to whichever hooks gateway is set now or
 *  later. */
export function startSessionSignals(sinks: SessionSignalSinks): void {
  setHookTranscriptPathSink(sinks.onTranscriptPath)
  setHookFeedEmit(sinks.emit ?? null)
  startHookSignals()
}
