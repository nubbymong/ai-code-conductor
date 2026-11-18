// The session input module (2.1.3-beta.9 section A1; ADR-030 component row
// 3's submit): the one door through which main types into a session on its
// own initiative. Main decides here what goes in for the Watchdog's retry
// (submitLine, typeKeys), an Agent Canvas marker (submitMarker) and Ask
// Conductor's question on Codex (askQuestion, handOffAskQuestion), and nowhere
// else. A Claude Code marker is the one this module does not type itself: it
// is held by canvas/claude-marker-typing.ts and typed by the renderer at main's
// request. tests/unit/main/session-input-ownership.test.ts holds every other
// place in main that types into a session to a shrinking allow-list.
//
// Since section A2 it also pastes a channel message (pasteEnvelope) and types
// the quit keys into a CLI the app started (sendExitKeys, for the PTY
// manager's gracefulExitPty only, which decides which sessions get them).
//
// Each function's body moved here from the PTY manager as it was: nothing
// typed, its order or its timing changed, and no queue, delay or check added.
// The rules of WHEN to type stay where they were (the Watchdog's Codex rule in
// watchdog-manager.ts, the Claude Code marker's in canvas/claude-marker-typing.ts,
// the Codex composer's in the Codex package); they type only through what this
// module hands them.
//
// ONE WAY ROUND. This module imports nothing from the PTY manager: the PTY
// manager registers its ports here when it loads (setSessionInputPorts), so
// the imports run one way. Every byte this module types into a terminal goes
// through the port's write (writePty, unchanged: its duplicate guard, its
// 256-byte chunking and its launch-pending buffer), or through the Codex
// package's run screen, reached through the provider registry as the PTY
// manager reaches it (WP1 rule R4: no deep import into a provider package).
// The two A2 doors are the exceptions, as they were in the PTY manager: a
// channel envelope and the quit keys are written to the session's terminal
// process itself, each only while it is still the session's, and never
// through writePty's duplicate guard.
import type { BrowserWindow } from 'electron'
import type { IPty } from 'node-pty'
import { getProvider } from '../providers'
import type { SessionRunScreen } from '../providers/types'
import { IPC } from '../../shared/ipc-channels'
import { codexPromptKeeps } from '../../shared/codex-screen'
import { TMUX_WHEEL_EXIT_KEY } from '../../shared/tmux-wheel'
import type { SubmitTextResult, AskConductorNotice } from '../../shared/types'
import { MARKER_FALLBACK_FLUSH_MS } from '../canvas/canvas-marker-queue'
import { queueClaudeMarkerLine } from '../canvas/claude-marker-typing'
import { logInfo } from '../debug-logger'
import { PasteQueue } from '../paste-queue'
import { runChunkedWrite } from '../pty-chunked-write'

/** What the PTY manager lends this module, registered when it loads. */
export interface SessionInputPorts {
  /** writePty, unchanged: every byte this module types into a terminal. */
  write: (sessionId: string, data: string) => void
  /** The session's current terminal process (its ptyProcess), or none. A
   *  restart is a new one. */
  run: (sessionId: string) => IPty | undefined
  /** Whether the session's launch wrapped its CLI in a tmux persistence
   *  session on the host (an SSH Persistent session). */
  tmuxWrapped: (sessionId: string) => boolean
  /** Whether the session runs Codex now (a live PTY started as a Codex session). */
  isCodexSession: (sessionId: string) => boolean
  /** Whether the session's Codex launched as Ask Conductor (isAsk). */
  isCodexAskSession: (sessionId: string) => boolean
}

let ports: SessionInputPorts | null = null

/** The PTY manager's registration, once, when it loads. A second one throws
 *  and leaves the first in place: nothing else may redirect what the doors
 *  type. */
export function setSessionInputPorts(p: SessionInputPorts): void {
  if (ports) throw new Error('session input: the ports are already registered')
  ports = p
}

function port(): SessionInputPorts {
  if (!ports) throw new Error('session input: the PTY manager has not registered its ports')
  return ports
}

/** WP2 PR 4, P4.1: the Codex package's pane of each run and its submit
 *  primitive (providers/codex/session-screen.ts), from the registered
 *  provider: main reaches a provider package only through the registry,
 *  never by importing it. Undefined when none is registered. The PTY manager
 *  resizes and closes each run's pane through this one copy (it opens and
 *  feeds the pane through its provider's runScreen at the launch). Only the
 *  PTY manager imports it, and session-input-ownership.test.ts counts a
 *  submit on what it returns as typing, outside this module. */
export function codexRunScreen(): SessionRunScreen | undefined {
  try { return getProvider('codex').runScreen } catch { return undefined }
}

/**
 * #85 — submit a programmatic LINE into a session (the watchdog's retry),
 * leaving tmux copy-mode first when the session is tmux-wrapped.
 *
 * The wheel now opens tmux's scrollback view on an SSH Persistent session, and
 * copy-mode SWALLOWS input: a user who scrolled up to read something and then
 * walked away leaves the pane in a state where the watchdog's rate-limit retry
 * would go to the scrollback viewer instead of claude, and the session would
 * simply never resume. The leave key is prepended unconditionally for a wrapped
 * session because main cannot observe copy-mode: outside it, tmux's root table
 * binds that key to a silent no-op, so the cost of being wrong is nothing
 * (verified against tmux 3.4, 2026-09-20). Untouched for every other session.
 */
export function submitLine(sessionId: string, line: string): void {
  const prefix = port().tmuxWrapped(sessionId) ? TMUX_WHEEL_EXIT_KEY : ''
  port().write(sessionId, `${prefix}${line}\r`)
}

/** P3.10: a raw write into the session's PTY, for a Codex session's Watchdog
 *  retry: the Watchdog types the retry, then its Enter or its own Backspaces,
 *  by its own screen check (watchdog-manager submitCodex). Exactly the keys
 *  it is handed, through writePty. */
export function typeKeys(sessionId: string, data: string): void {
  port().write(sessionId, data)
}

/**
 * WP2 PR 4, P4.1: an Agent Canvas marker line into a session. A Codex
 * session's goes through the submit primitive (providers/codex/
 * composer-submit.ts), which types it only at Codex's ready, empty composer
 * (waiting, within the marker queue's own fallback bound, while a turn runs
 * or a prompt is up), submits it once it is confirmed on screen, and answers
 * whether it was delivered: Codex never submits one write of a line and its
 * Enter (PB3).
 *
 * Every other session's (Claude Code's) is held, in the order handed in, and
 * typed only when the session's own screen reads Claude Code's ready, empty
 * prompt, by the same reading the status strip's controls type through
 * (canvas/claude-marker-typing.ts). Only into the run it was handed for, the
 * session's terminal process (a restart is a new run; a Claude Code started
 * again by hand in the same terminal is not); a session with no run takes
 * nothing and answers not delivered (the session gone), as the branch above
 * does for a session with no pane, so its canvas is told. Otherwise it answers
 * nothing: a marker the chain drops untyped (held past its bound, its run
 * ended) is told to its canvas by the chain itself. `canvasId`, the canvas
 * the marker was filed on when the caller named one, goes with the line, so
 * the same words filed on two canvases stay two markers.
 */
export function submitMarker(sessionId: string, line: string, canvasId?: string): void | Promise<SubmitTextResult> {
  if (port().isCodexSession(sessionId)) {
    // The primitive answers a session with no pane itself (review A-8).
    const screen = codexRunScreen()
    if (!screen) return Promise.resolve({ delivered: false, reason: 'session-gone' })
    return screen.submit(sessionId, line, { readyWaitMs: MARKER_FALLBACK_FLUSH_MS })
  }
  const run = port().run(sessionId)
  if (!run) {
    logInfo(`[canvas-marker] ${sessionId}: no running session, so a marker was not typed`)
    return Promise.resolve({ delivered: false, reason: 'session-gone' })
  }
  queueClaudeMarkerLine(sessionId, line, () => port().run(sessionId) === run, canvasId)
}

/** WP2 PR 4, P4.3: how long an Ask question waits for Codex's ready, empty
 *  composer. A first Ask in a fresh account folder shows folder trust and the
 *  sandbox setup first, which the user answers (PB4), and a live tab may be
 *  mid-answer. Past it the question is not sent, and the dock says so and
 *  keeps it. */
export const ASK_READY_WAIT_MS = 300_000

/** One of Ask Conductor's notice lines, to the dock (askConductor:notice). */
function sendAskNotice(win: BrowserWindow, notice: AskConductorNotice): void {
  try { if (!win.isDestroyed()) win.webContents.send(IPC.ASK_CONDUCTOR_NOTICE, notice) } catch { /* the window is going */ }
}

/**
 * WP2 PR 4, P4.3 (row 53): type an Ask question into a Codex session through
 * the run's pane and its submit primitive, never as the raw question and
 * Enter (Codex submits no such write, PB3). The characters Codex's prompt
 * would drop are removed first and the dock told how many (section 10
 * question 6, default A); a question that is not sent is said, with why, and
 * the dock keeps it. The log names the question by its length only. Never
 * rejects.
 *
 * It does NOT check that the session launched as Ask Conductor: it is for the
 * PTY manager's Ask launch only, which has just put the session among the Ask
 * sessions. Every other caller goes through handOffAskQuestion, which checks.
 * session-input-ownership.test.ts holds it to the PTY manager.
 */
export async function askQuestion(win: BrowserWindow, sessionId: string, question: string): Promise<SubmitTextResult> {
  let result: SubmitTextResult
  try {
    const screen = codexRunScreen()
    if (!screen?.has(sessionId)) {
      result = { delivered: false, reason: 'session-gone' }
    } else {
      const { text, removed } = codexPromptKeeps(question)
      if (removed > 0) sendAskNotice(win, { sessionId, kind: 'removed', count: removed })
      result = text.trim() ? await screen.submit(sessionId, text, { readyWaitMs: ASK_READY_WAIT_MS }) : { delivered: false, reason: 'refused-text' }
    }
  } catch {
    result = { delivered: false, reason: 'session-gone' }
  }
  logInfo(`[codex-ask] ${sessionId}: a question of ${[...question].length} characters ${result.delivered ? 'typed into Codex\'s prompt' : `not delivered (${result.reason})`}`)
  if (!result.delivered) sendAskNotice(win, { sessionId, kind: 'not-delivered', reason: result.reason })
  return result
}

/**
 * WP2 PR 4, P4.3: a question for a LIVE Ask session on Codex
 * (askConductor:handOff), through the same door as the launch's. Only a
 * running Codex session that launched as Ask takes one; anything else is the
 * session gone, and nothing is typed.
 */
export function handOffAskQuestion(win: BrowserWindow, sessionId: string, question: string): Promise<SubmitTextResult> {
  if (!port().isCodexSession(sessionId) || !port().isCodexAskSession(sessionId)) return Promise.resolve({ delivered: false, reason: 'session-gone' })
  return askQuestion(win, sessionId, question)
}

// Per-session FIFO paste queues for channel envelopes (P3.1).
const pasteQueues = new Map<string, PasteQueue>()

// Guard-free chunked write (channel envelopes carry a unique ts: and must not
// be deduped). Mirrors the PTY manager's writeChunked: its 256-byte/12ms cadence.
function writeEnvelopeChunked(sessionId: string, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // Capture THIS pty up front and route through the R-010-tested
    // runChunkedWrite with an identity-guarded isAlive, so a respawn (new PTY
    // under the same sessionId) can't receive the tail of a half-written
    // envelope (P1.5 — mirrors writeChunked). onDone resolves the queue's writer.
    const proc = port().run(sessionId)
    if (!proc) return resolve()
    runChunkedWrite(data, {
      write: (slice) => proc.write(slice),
      isAlive: () => port().run(sessionId) === proc,
      onDone: resolve,
    })
  })
}

/**
 * A channel message into a session, as a Tier 1 paste (channel-bus.ts): a
 * fully-wrapped envelope, queued behind the session's earlier ones. Returns
 * how many waiting envelopes the queue dropped to take it (more than 16
 * waiting drops the oldest; 0 normally). Moved from the PTY manager's
 * pastePty as it was. Before the PTY manager registers its ports it throws,
 * as every door does, rather than queue what could never be typed.
 */
export function pasteEnvelope(sessionId: string, envelope: string): number {
  port()
  let q = pasteQueues.get(sessionId)
  if (!q) { q = new PasteQueue((d) => writeEnvelopeChunked(sessionId, d), 16); pasteQueues.set(sessionId, q) }
  return q.enqueue(envelope)
}

/** The session's paste queue stopped and dropped, with the PTY manager's other
 *  per-session state when its terminal goes (cleanupSessionResources): what
 *  waits is dropped, and an envelope in flight stops at its next slice, its
 *  terminal no longer the session's. */
export function cancelPastes(sessionId: string): void {
  pasteQueues.get(sessionId)?.cancel() // stop draining + drop pending before dropping the ref (P1.5)
  pasteQueues.delete(sessionId)
}

/**
 * The quit keys into a CLI the app started, for the PTY manager's
 * gracefulExitPty only, which decides which sessions get them (a
 * tmux-persistent remote is detached and a terminal whose CLI the app did not
 * start is closed, both without them). Escape (cancel any pending input) at
 * once, Ctrl-C (interrupt anything) at 100 ms, then /exit and Enter at 300 ms,
 * written to `proc` itself, as the PTY manager wrote them. Each only while
 * `proc` is still the session's terminal process: one that ended, or was
 * replaced by a new run, gets none of the rest. (The PTY manager asked only
 * whether the session still had a terminal, so a replaced one got the rest.)
 */
export function sendExitKeys(sessionId: string, proc: IPty): void {
  const live = (): boolean => port().run(sessionId) === proc
  if (live()) proc.write('\x1b') // Escape
  setTimeout(() => {
    if (live()) proc.write('\x03') // Ctrl+C to interrupt anything
  }, 100)
  setTimeout(() => {
    if (live()) proc.write('/exit\r')
  }, 300)
}
