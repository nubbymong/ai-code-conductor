/**
 * Typing a slash command into Claude Code from outside its terminal: the
 * status strip's Compact (/compact), and its model and effort pills (/model,
 * /effort). A line is typed only into Claude Code's READY, EMPTY prompt, read
 * from the session's live screen (src/shared/claude-screen.ts); on any other
 * screen nothing is typed and the caller is told why, in words for the user.
 * The line and its newline go in one write, as before.
 *
 * After a line is typed, another line for the same session within
 * CLAUDE_SETTLE_MS is not typed (it is not queued either) and the caller is
 * told so: until the screen has had time to show the first line, it still
 * reads as the empty prompt the first was typed into.
 *
 * An Agent Canvas marker line into a Claude Code session goes through the same
 * gate: main holds the marker and asks, over
 * canvas:claudeMarkerAsk, for a read of the prompt (a probe, nothing typed) or
 * for the line to be typed; this answers from the session's own screen
 * (answerClaudeMarkerAsk), and main keeps the marker held until it is typed
 * or its two-minute bound passes (then the canvas is told it was not sent).
 * A marker already typed reads as typed again and is never typed twice.
 */
import { readClaudeScreen } from '../../shared/claude-screen'
import { CLAUDE_MARKER_REFUSED, canvasMarkerLineOk } from '../../shared/canvas-marker-line'
import type { ClaudeMarkerAnswer } from '../../shared/types'
import { readSessionScreen, type ScreenLine } from '../components/terminal/screenRegistry'
import { writeSessionInput } from '../components/terminal/tmuxWheelScroll'

export const CLAUDE_NOT_AT_PROMPT = 'Claude Code is not at its prompt, so nothing was sent.'
export const CLAUDE_BUSY_NOW = 'Claude Code is busy with a turn, so nothing was sent.'
export const CLAUDE_TEXT_IN_PROMPT = 'Something is already typed at the Claude Code prompt, so nothing was added.'
export const CLAUDE_SCROLLED_BACK = 'The terminal is scrolled back, so nothing was sent. Scroll to the bottom, then try again.'
export const CLAUDE_SENT_JUST_NOW = 'A command was just sent to Claude Code, so nothing more was sent.'

/** How long after a typed line the session takes no other. */
export const CLAUDE_SETTLE_MS = 1000

export interface ClaudePromptDeps {
  readScreen: (sessionId: string) => ScreenLine[] | null
  write: (sessionId: string, data: string) => void
  setTimeout: (fn: () => void, ms: number) => unknown
  /** Sessions a line was typed into in the last CLAUDE_SETTLE_MS; the app's
   *  one set when not given. */
  settling?: Set<string>
  /** Canvas markers already typed (answerClaudeMarkerAsk); the app's one set
   *  when not given. */
  typedMarkers?: Set<string>
}

/** The sessions a line was just typed into, app-wide. */
const settlingSessions = new Set<string>()

export const defaultClaudePromptDeps: ClaudePromptDeps = {
  readScreen: readSessionScreen,
  write: writeSessionInput,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  settling: settlingSessions,
}

export interface ClaudeTyping {
  /** Whether the line was typed. */
  typed: boolean
  /** Why it was not, in words for the user. */
  reason?: string
}

/**
 * Type `line` (a slash command and its newline) into the session's Claude
 * Code prompt when, and only when, the live screen shows that prompt ready and
 * empty, and no line was typed into the session in the last CLAUDE_SETTLE_MS.
 * Otherwise types nothing and says why.
 */
export function typeAtClaudePrompt(
  sessionId: string,
  line: string,
  deps: ClaudePromptDeps = defaultClaudePromptDeps,
): ClaudeTyping {
  const settling = deps.settling ?? settlingSessions
  const refusal = claudePromptRefusal(sessionId, deps)
  if (refusal) return { typed: false, reason: refusal }
  settling.add(sessionId)
  deps.setTimeout(() => settling.delete(sessionId), CLAUDE_SETTLE_MS)
  deps.write(sessionId, line)
  return { typed: true }
}

/** Why nothing may be typed into the session's Claude Code prompt now, in
 *  words for the user; null when the live screen shows that prompt ready and
 *  empty and no line was typed into the session in the last CLAUDE_SETTLE_MS. */
function claudePromptRefusal(sessionId: string, deps: ClaudePromptDeps): string | null {
  const settling = deps.settling ?? settlingSessions
  if (settling.has(sessionId)) return CLAUDE_SENT_JUST_NOW
  const read = readClaudeScreen(deps.readScreen(sessionId))
  if (read.screen === 'busy') return CLAUDE_BUSY_NOW
  if (read.screen === 'scrolled-back') return CLAUDE_SCROLLED_BACK
  if (read.screen !== 'ready') return CLAUDE_NOT_AT_PROMPT
  if (read.text !== '') return CLAUDE_TEXT_IN_PROMPT
  return null
}

/** No request id or session id is anywhere near this long. */
const MAX_ID = 200
/** The Enter a marker line is submitted with, as main's programmatic lines
 *  into Claude Code always were. */
const MARKER_ENTER = String.fromCharCode(13)

/** How many typed markers are remembered. Main types one at a time per
 *  session, so this is far more than one late answer needs. */
const TYPED_MARKERS_KEPT = 256

/** The canvas markers typed into a session, app-wide. */
const typedMarkerIds = new Set<string>()

function rememberTyped(typed: Set<string>, key: string): void {
  typed.add(key)
  while (typed.size > TYPED_MARKERS_KEPT) {
    const oldest = typed.values().next().value
    if (oldest === undefined) break
    typed.delete(oldest)
  }
}

const idOk = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID

/**
 * Answer one of main's canvas marker requests (canvas:claudeMarkerAsk) from
 * the session's live screen. 'probe': whether Claude Code's prompt reads
 * ready and empty, nothing typed. 'type': the line and its Enter typed, in one
 * write, only if it reads so now (typeAtClaudePrompt, which also keeps the
 * line out of a session another line was just typed into). A marker already
 * typed (its answer reached main after main stopped waiting) reads as typed
 * for either mode and is not typed again. A request that is not well formed
 * types nothing and answers CLAUDE_MARKER_REFUSED; null when it cannot even
 * be answered.
 */
export function answerClaudeMarkerAsk(raw: unknown, deps: ClaudePromptDeps = defaultClaudePromptDeps): ClaudeMarkerAnswer | null {
  if (!raw || typeof raw !== 'object') return null
  const ask = raw as Record<string, unknown>
  if (!idOk(ask.requestId)) return null
  const requestId = ask.requestId
  if (!idOk(ask.sessionId) || !idOk(ask.markerId) || (ask.mode !== 'probe' && ask.mode !== 'type') || !canvasMarkerLineOk(ask.line)) {
    return { requestId, ok: false, reason: CLAUDE_MARKER_REFUSED }
  }
  const typedMarkers = deps.typedMarkers ?? typedMarkerIds
  const key = JSON.stringify([ask.sessionId, ask.markerId])
  if (typedMarkers.has(key)) return { requestId, ok: true }
  if (ask.mode === 'probe') {
    const refusal = claudePromptRefusal(ask.sessionId, deps)
    return refusal ? { requestId, ok: false, reason: refusal } : { requestId, ok: true }
  }
  const typing = typeAtClaudePrompt(ask.sessionId, ask.line + MARKER_ENTER, deps)
  if (!typing.typed) return { requestId, ok: false, reason: typing.reason }
  rememberTyped(typedMarkers, key)
  return { requestId, ok: true }
}

let markerHostArmed = false

/** Answer main's canvas marker requests for the renderer's life. Armed once,
 *  from App's boot effect; idempotent. */
export function setupClaudeMarkerHost(): void {
  if (markerHostArmed) return
  const canvas = window.electronAPI?.canvas
  if (typeof canvas?.onClaudeMarkerAsk !== 'function' || typeof canvas.answerClaudeMarker !== 'function') return
  markerHostArmed = true
  canvas.onClaudeMarkerAsk((raw) => {
    const answer = answerClaudeMarkerAsk(raw)
    if (answer) canvas.answerClaudeMarker(answer)
  })
}
