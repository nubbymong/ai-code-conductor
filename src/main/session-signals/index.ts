// src/main/session-signals/index.ts
// The session signals module: the one owner of what a status line or a hook
// event means (ADR-030 component row 13; 2.1.3-beta.8, section A2).
//   hooks.ts   the one subscriber to the hooks gateway; consumers take events
//              from it (onHookEvent), and the transcript path the gateway
//              reports goes through it to main's route.
//   status.ts  the status line fan-out (deliverStatus) and its two sinks.
// It moves meaning only: every transport (the gateway, the status file watch,
// the MCP /status ingest, the SSH sentinel) stays where it was.
import { setHookTranscriptPathSink, startHookSignals } from './hooks'

export { onHookEvent, hookEvent, transcriptPath } from './hooks'
export type { HookConsumer, HookSignalSource } from './hooks'
export { deliverStatus, setTranscriptPathSink, setStatuslineUsageSink } from './status'

export interface SessionSignalSinks {
  /** Where a transcript path a hook reported goes: main's route, which calls
   *  pty-manager's routeHookTranscriptPath. */
  onTranscriptPath: (sessionId: string, path: string) => void
}

/** Start the module, once, at boot: the transcript route, and the one
 *  subscription to whichever hooks gateway is set now or later. */
export function startSessionSignals(sinks: SessionSignalSinks): void {
  setHookTranscriptPathSink(sinks.onTranscriptPath)
  startHookSignals()
}
