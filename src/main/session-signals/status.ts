// src/main/session-signals/status.ts
// What a status line means, once src/main/statusline-watcher.ts has parsed and
// sanitised it (ADR-030 component row 13; 2.1.3-beta.8, section A2). The body
// of the watcher's old fan-out, moved here as it was; the watcher keeps the
// parsing, the sanitising, the file watch and dispatchSSHStatuslineUpdate, and
// calls deliverStatus where it called the fan-out. The two sinks moved with it
// and are re-exported from the watcher for the code that imports them there.
import type { BrowserWindow } from 'electron'

import { decorateStatuslineWithColour } from '../account-color'
import { tryGetProvider } from '../providers'
import { sentinelObserve } from '../sentinel/index'
import { isBackgroundContext } from '../background-context'
import type { StatuslineData } from '../../shared/types'

// Logs v2 (Task 8): the transcript binder sink. The statusline JSON carries
// Claude Code's live `transcript_path` (continuous, exact discovery source);
// every fan-out forwards it here so the binder can tail the file. Registered at
// boot via setTranscriptPathSink(); null until then (and in unit tests).
let transcriptPathSink: ((sessionId: string, path: string) => void) | null = null

/** Register the transcript binder's notify sink (called once at boot). */
export function setTranscriptPathSink(sink: (sessionId: string, path: string) => void): void {
  transcriptPathSink = sink
}

// Plan P2: the account-usage page reuses an OPEN account's live figure instead of
// making its own redundant call. The figure is the buckets a live session's
// statusline just delivered, so it is harvested HERE at the fan-out, through a
// sink (like transcriptPathSink) so this module stays free of the account graph.
let statuslineUsageSink: ((sessionId: string, buckets: unknown, hasCredits: boolean, transcriptPath?: string) => void) | null = null
export function setStatuslineUsageSink(sink: (sessionId: string, buckets: unknown, hasCredits: boolean, transcriptPath?: string) => void): void {
  statuslineUsageSink = sink
}

/**
 * Common fan-out for any parsed StatuslineData payload — used by both the
 * file watcher and the SSH OSC sentinel dispatch path. Sends to the renderer
 * and per-session telemetry subscribers.
 *
 * Tokenomics no longer ingests from the statusline tick (the old
 * tokenomics-manager.handleStatuslineUpdate ran a full ~37k-session aggregate
 * rebuild on EVERY tick — the ~30s UI freeze). The tokenomics worker now
 * indexes from raw transcripts on its own fs-watch/timer.
 */
export function deliverStatus(data: StatuslineData, getWindow: (() => BrowserWindow | null) | null): void {
  // Copilot review on PR #31 (p9.17): decorate with accountColour HERE,
  // at the renderer-send site, so the ContextBar sees accountColour. Decorate
  // once and forward the enriched object to every consumer.
  const decorated = decorateStatuslineWithColour(data)
  // While a subagent / dynamic-workflow agent runs under this session, CC's
  // statusline reports the AGENT's model + effort. Strip those two fields from
  // the DISPLAY payload so the strip's pills stay pinned to the main window.
  // Everything else (context %, cost, tokens, rate limits, transcript path)
  // is session- or account-level and still flows. Sentinel (below) and the
  // transcript binder read the RAW `data`, so they are unaffected.
  let forDisplay = decorated
  if (isBackgroundContext(data.sessionId, data.transcriptPath)) {
    forDisplay = { ...decorated }
    delete forDisplay.model
    delete forDisplay.modelId
    delete forDisplay.effortLevel
  }
  if (getWindow) {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('statusline:update', forDisplay)
    }
  }
  tryGetProvider('claude')?.deliverStatusline?.(forDisplay)
  // Logs v2 (Task 8): forward the live transcript path to the binder (continuous,
  // exact discovery source). Guarded — the sink may not be registered yet (and
  // isn't in unit tests). A throw here must not break the statusline pipeline.
  if (data.transcriptPath && data.sessionId && transcriptPathSink) {
    try { transcriptPathSink(data.sessionId, data.transcriptPath) } catch { /* sink must not break fan-out */ }
  }
  // Plan P2: harvest the account-level usage this session just delivered so the
  // account-usage page can reuse an OPEN account's figure. Read from raw `data`
  // (account-level, so unaffected by the subagent model/effort strip on
  // forDisplay). Best-effort and guarded: the sink resolves the session's profile
  // and stores nothing for an SSH or default-home session, and must never break
  // the fan-out.
  if (data.sessionId && Array.isArray(data.usageBuckets) && data.usageBuckets.length > 0 && statuslineUsageSink) {
    // The transcript path goes with it: the sink files the figure under a
    // profile only when the transcript lies in that profile's folder.
    try { statuslineUsageSink(data.sessionId, data.usageBuckets, data.rateLimitExtra != null, data.transcriptPath) } catch { /* sink must not break fan-out */ }
  }
  // Sentinel Trigger A: observe the raw model id (modelId preferred; fall back to
  // model which may be a display name — the resolver handles both). Safe before
  // initSentinel: sentinelObserve is a no-op when the observer is not yet set.
  const rawModel = data.modelId ?? data.model
  if (typeof rawModel === 'string' && rawModel) {
    try { sentinelObserve({ kind: 'model', value: rawModel, source: 'statusline' }) } catch { /* must not break fan-out */ }
  }
}
