// The session input module (2.1.3-beta.9 section A1; ADR-030 component row
// 3's submit): the one door through which main types into a session on its
// own initiative. Main decides here what goes in for the Watchdog's retry
// (submitRetry), an Agent Canvas marker (submitMarker) and Ask
// Conductor's question on Codex (askQuestion, handOffAskQuestion), and nowhere
// else. A Claude Code marker is the one this module does not type itself: it
// is held by canvas/claude-marker-typing.ts and typed by the renderer at main's
// request. tests/unit/main/session-input-ownership.test.ts holds every other
// place in main that types into a session to a shrinking allow-list.
//
// Since 2.1.3-beta.9 section A2 it also pastes a channel message (pasteEnvelope) and types
// the quit keys into a CLI the app started (sendExitKeys, for the PTY
// manager's gracefulExitPty only, which decides which sessions get them).
//
// Since 2.1.3-beta.15 section B3 (aicc_planning#393) the quit keys are not
// this module's: each provider package names its own (SessionProvider.exitKeys),
// reached through the registry, and sendExitKeys types the session's. Claude
// Code's are the ones this module typed before; Codex's are Escape, Ctrl-C at
// 30 ms and Ctrl-C again at 1,500 ms, with no /exit. That changes what a Codex
// session's quit types, written at sendExitKeys, and nothing else said below.
//
// Since 2.1.3-beta.10 section A1 (#333) it also types a command bar prompt
// button's text (submitPrompt), asked by the renderer over pty:submitPrompt.
// That door is new, not moved: it has its own rule, order and delay, written
// at it. Everything said below about the moved bodies is about the others.
//
// Since 2.1.3-beta.16 section X1 (aicc_planning#405) it also types a saved
// image's path into a Claude Code session on this computer as the CLI's own
// paste (submitImage), asked by the renderer over pty:submitPrompt with the
// image's path. That door is new too, with its own rule and waits, written at
// it, and the same per-session order as the prompt buttons'.
//
// Since 2.1.3-beta.17 section C6 (aicc_planning#415) the same door pastes an
// image into a Codex session on this computer too, by the Codex package's
// image rule (SessionRunScreen.submitImage), reached through the registry as
// the submit primitive is; what that rule cannot paste the renderer types by
// its own Codex rule, written at submitImage.
//
// Since 2.1.3-beta.10 section A2 the Watchdog's retry comes in through one
// door, submitRetry: a Codex session's goes through the Codex package's
// submit primitive, as a canvas marker's does, instead of the raw writer
// (typeKeys, removed) the Watchdog typed it through by a rule of its own; a
// Claude Code session's is submitLine's, unchanged. That changes how a Codex
// retry is typed, written at submitRetry, and nothing else said below.
//
// Each function's body moved here from the PTY manager as it was: nothing
// typed, its order or its timing changed, and no queue, delay or check added,
// but for what beta.9's A2 changed in sendExitKeys, described at that function: it
// writes each quit key only while the terminal it was handed is still the
// session's, and a key whose write fails is dropped rather than thrown. (Like
// every door that types through a port, pasteEnvelope also throws before the
// ports are registered.)
// The rules of WHEN to type stay where they were (the Watchdog's in
// watchdog/session-watchdog.ts, the Claude Code marker's in
// canvas/claude-marker-typing.ts, the Codex composer's in the Codex package);
// they type only through what this module hands them.
//
// ONE WAY ROUND. This module imports nothing from the PTY manager: the PTY
// manager registers its ports here when it loads (setSessionInputPorts), so
// the imports run one way. Every byte this module types into a terminal goes
// through the port's write (writePty, unchanged: its duplicate guard, its
// 256-byte chunking and its launch-pending buffer), or through the Codex
// package's run screen, reached through the provider registry as the PTY
// manager reaches it (WP1 rule R4: no deep import into a provider package).
// The two beta.9 A2 doors are the exceptions, as they were in the PTY manager: a
// channel envelope and the quit keys are written to the session's terminal
// process itself, never through writePty's duplicate guard, and each only
// while that process is still the session's (for the quit keys, new in beta.9's A2).
import type { BrowserWindow } from 'electron'
import type { IPty } from 'node-pty'
import { getProvider } from '../providers'
import type { ExitKey, SessionRunScreen } from '../providers/types'
import type { ProviderId } from '../../shared/types'
import { IPC } from '../../shared/ipc-channels'
import { codexPromptKeeps } from '../../shared/codex-screen'
import { TMUX_WHEEL_EXIT_KEY } from '../../shared/tmux-wheel'
import type { SubmitTextResult, AskConductorNotice, PromptButtonResult } from '../../shared/types'
import { MARKER_FALLBACK_FLUSH_MS } from '../canvas/canvas-marker-queue'
import { queueClaudeMarkerLine } from '../canvas/claude-marker-typing'
import { logInfo } from '../debug-logger'
import { PasteQueue } from '../paste-queue'
import { runChunkedWrite, WRITE_CHUNK_SIZE, WRITE_CHUNK_DELAY } from '../pty-chunked-write'

/** What the PTY manager lends this module, registered when it loads. */
export interface SessionInputPorts {
  /** writePty, unchanged: every byte this module types into a terminal, but a channel envelope's and the quit keys, which go to the run itself (pasteEnvelope, sendExitKeys). */
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

/** WP2 PR 4, P4.1: the Codex package's reading of each run's screen (its pane,
 *  or since 2.1.3-beta.14 B2 a held run's holder's screen) and its submit
 *  primitive (providers/codex/session-screen.ts), from the registered
 *  provider: main reaches a provider package only through the registry,
 *  never by importing it. Undefined when none is registered. The PTY manager
 *  resizes and closes each run's reading through this one copy (it opens and
 *  feeds it through its provider's runScreen at the launch). Only the
 *  PTY manager imports it, and session-input-ownership.test.ts counts a
 *  submit on what it returns as typing, outside this module. */
export function codexRunScreen(): SessionRunScreen | undefined {
  try { return getProvider('codex').runScreen } catch { return undefined }
}

/**
 * #85 — submit a programmatic LINE into a session (the watchdog's retry into a
 * Claude Code session, through submitRetry), leaving tmux copy-mode first when
 * the session is tmux-wrapped.
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

/** 2.1.3-beta.10 section A2: how long a Codex session's Watchdog retry waits
 *  for Codex's ready, empty composer before it answers not delivered. */
export const RETRY_CODEX_READY_WAIT_MS = 5_000

/**
 * 2.1.3-beta.10 section A2 (aicc_planning #336): the Watchdog's retry into a
 * session, by its CLI's rule. The Watchdog decides when to retry and what;
 * this decides only how the retry is typed.
 *
 * - A Codex session's goes through the Codex package's submit primitive, as a
 *   canvas marker's and Ask Conductor's question do: typed only at Codex's
 *   ready, empty composer (ready on two reads 300 ms apart), its Enter only
 *   once the text is confirmed on screen, a text not confirmed taken back with
 *   Ctrl+U (only while the composer holds nothing but it), and only into the
 *   run whose screen it read. The answer says whether it was delivered, and why
 *   not. Its RETRY_CODEX_READY_WAIT_MS counts from this call (`readyBy`), so
 *   a retry queued behind another submission for the run is not typed later
 *   than that; and `stillWanted`, the Watchdog's "its incident is still the
 *   one it was sent for", is asked before each poll and just before the text
 *   is typed: an incident that is over leaves the retry untyped (PR #746
 *   review).
 * - Every other session's (Claude Code's: on this computer, held by the
 *   session helper, or over SSH) is submitLine's, byte for byte, and answers
 *   nothing. It is typed at once, as the Watchdog decides, so `stillWanted`
 *   has nothing to guard there.
 *
 * Throws before the PTY manager registers its ports, as every door does.
 */
export function submitRetry(sessionId: string, text: string, stillWanted?: () => boolean): void | Promise<SubmitTextResult> {
  if (port().isCodexSession(sessionId)) {
    // The primitive answers a session whose screen it does not read itself.
    const screen = codexRunScreen()
    if (!screen) return Promise.resolve({ delivered: false, reason: 'session-gone' })
    return screen.submit(sessionId, text, {
      readyWaitMs: RETRY_CODEX_READY_WAIT_MS,
      readyBy: Date.now() + RETRY_CODEX_READY_WAIT_MS,
      ...(stillWanted ? { stillWanted } : {}),
    })
  }
  submitLine(sessionId, text)
}

/** #333: how long a prompt button's Enter follows the last slice of its text
 *  (the delay the renderer's Codex rule uses, codexComposer.ts). */
export const PROMPT_ENTER_DELAY_MS = 300
/** #333: the same text pressed again for a session within this long is
 *  dropped (the window of writePty's duplicate guard, which a write that does
 *  not end in Enter no longer reaches). */
export const PROMPT_REPEAT_WINDOW_MS = 300
/** #333: how long a Codex session's prompt button waits for Codex's ready,
 *  empty composer before it answers busy. */
export const PROMPT_CODEX_READY_WAIT_MS = 5_000
/** #333: the longest text a Codex session's prompt button hands the submit
 *  primitive, in code points: the most it is known to type and confirm
 *  (askConductor:handOff caps a question at 8,000). It types the text in one
 *  write, unsliced, and a missed confirm waits out a window that grows with
 *  the length before it takes the text back. A longer one is refused. */
export const PROMPT_CODEX_MAX_CODE_POINTS = 8_000

/** Send the prompt (the default), or type it only (Settings, Custom
 *  Commands): main reads which from the saved settings at each press. */
export type PromptButtonMode = 'send' | 'type'

/** Each session's prompt presses and images (submitImage), one at a time in
 *  the order asked for: the tail of its chain, kept only while one is in hand. */
const promptChains = new Map<string, Promise<unknown>>()
/** Each session's last prompt press, for the repeat window, kept for that long. */
const lastPromptPress = new Map<string, { text: string; at: number }>()

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Resolves `delayMs` (PROMPT_ENTER_DELAY_MS unless given) after the last
 *  slice writePty cuts `data` into has gone (a write over WRITE_CHUNK_SIZE units goes in slices
 *  WRITE_CHUNK_DELAY ms apart, pty-chunked-write.ts). The delay first, then
 *  one WRITE_CHUNK_DELAY wait per slice after the first. Counted from the
 *  slices, not from the call: a slice still to go when the delay ends (main
 *  was held up, or writePty held the text for a launch line and is replaying
 *  it) had its timer set before each of these waits is, and timers of one
 *  length run in the order they were set, so each wait ends only after one
 *  more slice went. */
async function textSettled(data: string, delayMs: number = PROMPT_ENTER_DELAY_MS): Promise<void> {
  await wait(delayMs)
  const slices = data.length > WRITE_CHUNK_SIZE ? Math.ceil(data.length / WRITE_CHUNK_SIZE) : 1
  for (let i = 1; i < slices; i++) await wait(WRITE_CHUNK_DELAY)
}

/**
 * One press, typed, into `pressedFor` only: the terminal process the session
 * had when the press was taken (submitPrompt). A press that waited behind
 * another while the session restarted types nothing into the new process.
 * Every typed outcome ends only once its text has settled (textSettled), so
 * the next press cannot land between its slices. Never rejects: a write that
 * throws is the session gone.
 */
async function typePrompt(sessionId: string, text: string, mode: PromptButtonMode, pressedFor: IPty | undefined): Promise<PromptButtonResult> {
  const gone: PromptButtonResult = { outcome: 'not-sent', reason: 'session-gone' }
  try {
    const p = port()
    // No process: writePty would hold the text for a later start.
    const live = (): boolean => !!pressedFor && p.run(sessionId) === pressedFor
    if (!live()) return gone
    const leave = p.tmuxWrapped(sessionId) ? TMUX_WHEEL_EXIT_KEY : ''
    const data = `${leave}${text}`
    if (mode === 'send' && p.isCodexSession(sessionId)) {
      if ([...text].length > PROMPT_CODEX_MAX_CODE_POINTS) return { outcome: 'not-sent', reason: 'refused-text' }
      // The primitive answers a session whose screen it does not read itself.
      const screen = codexRunScreen()
      const result: SubmitTextResult = screen
        ? await screen.submit(sessionId, text, { readyWaitMs: PROMPT_CODEX_READY_WAIT_MS })
        : { delivered: false, reason: 'session-gone' }
      if (result.delivered) return { outcome: 'sent' }
      if (result.reason !== 'refused-text') return { outcome: 'not-sent', reason: result.reason }
      // Refused before anything was typed (a control character, a line
      // break, a character Codex's composer drops): typed with no Enter, as a
      // press always left it on Codex, for the user to check and send.
      if (!live()) return gone
      p.write(sessionId, data)
      await textSettled(data)
      return { outcome: 'typed', reason: 'refused-text' }
    }
    p.write(sessionId, data)
    await textSettled(data)
    if (mode === 'type') return { outcome: 'typed' }
    if (!live()) return gone
    // Its own write, with the leave key again: the wheel may have opened
    // tmux's scrollback since the text went, and copy-mode would take a bare
    // Enter. Outside copy-mode the key does nothing (submitLine).
    p.write(sessionId, `${leave}\r`)
    return { outcome: 'sent' }
  } catch {
    return gone
  }
}

function promptOutcomeWords(result: PromptButtonResult): string {
  switch (result.outcome) {
    case 'sent': return 'sent'
    case 'typed': return result.reason ? `typed and not sent (${result.reason})` : 'typed only, as the setting says'
    case 'dropped': return 'pressed again within the repeat window, so dropped'
    default: return `not sent (${result.reason})`
  }
}

/**
 * #333 (2.1.3-beta.10 section A1): a command bar prompt button's text for the
 * agent in a session's main pane, by one rule for every session, on this
 * computer and over SSH. `mode` is the user's setting, which main reads.
 *
 * - Type: the text through the write port (writePty: its 256-byte slices and
 *   its launch-pending buffer still apply), after the tmux leave key for an
 *   SSH Persistent session as submitLine does, and no Enter.
 * - Send, a session that is not Codex (Claude Code, on this computer, held by
 *   the session helper or over SSH): the text as above, then Enter as its own
 *   write PROMPT_ENTER_DELAY_MS after the text's last slice went (textSettled),
 *   and only while the session's terminal process is still the one the text
 *   went to; on an SSH Persistent session the Enter's write starts with the
 *   leave key too. The Enter never rides in the text's write: Codex takes one
 *   write of both as a paste and never submits it, and #333 reports a session
 *   on this computer where such a write was typed and not sent.
 * - Send, a Codex session: the Codex package's submit primitive, as canvas
 *   notes and Ask Conductor use it, with PROMPT_CODEX_READY_WAIT_MS to wait
 *   for the ready, empty composer; its answer is the answer. A text it refuses
 *   before typing is typed with no Enter, and the answer says so. A text over
 *   PROMPT_CODEX_MAX_CODE_POINTS is not handed to it: nothing is typed, and
 *   the answer is not sent (`refused-text`).
 *
 * A press types only into the terminal process the session had when it was
 * pressed: none, or one replaced while the press waited, takes nothing
 * (`session-gone`). The same text pressed again for the session within
 * PROMPT_REPEAT_WINDOW_MS is dropped. A session's presses go one at a time in
 * the order pressed: a second waits for the first one's Enter (or its answer,
 * on Codex), and for a typed one's text to settle. A press in the first
 * 300 ms of a local Claude Code launch, while writePty holds writes for the
 * launch line, gets its Enter after the held text too: the hold ends on a
 * 300 ms timer set when the session started, before this press's own 300 ms
 * wait was set, so the replay has started when that wait ends, and the slice
 * waits after it follow the replayed slices. The log
 * names a prompt by its length only. Throws before the PTY manager registers
 * its ports, as every door does; otherwise never rejects.
 *
 * The rule for a session that is not Codex lives here, beside submitLine,
 * until main can read a Claude Code screen (S13); it then belongs in the
 * Claude Code package.
 */
export function submitPrompt(sessionId: string, text: string, mode: PromptButtonMode): Promise<PromptButtonResult> {
  const pressedFor = port().run(sessionId)
  const chars = [...text].length
  const now = Date.now()
  const last = lastPromptPress.get(sessionId)
  if (last && last.text === text && now - last.at < PROMPT_REPEAT_WINDOW_MS) {
    logInfo(`[prompt-button] ${sessionId}: a prompt of ${chars} characters ${promptOutcomeWords({ outcome: 'dropped' })}`)
    return Promise.resolve({ outcome: 'dropped' })
  }
  const press = { text, at: now }
  lastPromptPress.set(sessionId, press)
  setTimeout(() => { if (lastPromptPress.get(sessionId) === press) lastPromptPress.delete(sessionId) }, PROMPT_REPEAT_WINDOW_MS)
  const before = promptChains.get(sessionId)
  const go = (): Promise<PromptButtonResult> => typePrompt(sessionId, text, mode, pressedFor)
  const next = (before ? before.then(go, go) : go()).then((result) => {
    logInfo(`[prompt-button] ${sessionId}: a prompt of ${chars} characters ${promptOutcomeWords(result)}`)
    return result
  })
  promptChains.set(sessionId, next)
  void next.then(() => { if (promptChains.get(sessionId) === next) promptChains.delete(sessionId) })
  return next
}

/** 2.1.3-beta.16 X1.2: how long the image door waits after the path's
 *  bracketed paste has gone before it types the sentence, and how long the
 *  Enter follows the sentence. These are the waits probe P11 measured with
 *  (helper/probes/p11-probe.cjs; the Windows test machine, Claude Code
 *  2.1.330, 2026-11-23): in 5 of 5 paste runs Claude Code showed its
 *  "[Image #1]" placeholder 1.5 s after the paste and sent the picture with
 *  the turn. Shorter waits were not measured. */
export const IMAGE_PASTE_SETTLE_MS = 1_500
export const IMAGE_ENTER_DELAY_MS = 700
/** X1.2: the longest image path and sentence the door takes. */
export const IMAGE_PATH_MAX_CHARS = 4_096
export const IMAGE_SENTENCE_MAX_CHARS = 1_000

/** 2.1.3-beta.17 C6: how long a Codex session's image waits for Codex's
 *  ready, empty composer, as a prompt button does. */
export const IMAGE_CODEX_READY_WAIT_MS = PROMPT_CODEX_READY_WAIT_MS

/** What the image door did: `sent`; `not-taken`, an image it did not paste
 *  (an SSH Persistent session, or since 2.1.3-beta.17 C6 a Codex session it
 *  could not paste the image into), which the caller then sends its own way;
 *  or `not-sent` and why. */
export type ImageSubmitResult =
  | { outcome: 'sent' }
  | { outcome: 'not-taken' }
  | { outcome: 'not-sent'; reason: 'session-gone' | 'refused-text' }

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

/** Whether `text` holds a control character (C0, DEL or C1): in a path one
 *  could end the bracketed paste early and be read as keys. */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true
  }
  return false
}

/** C6: one image into a Codex session's run `pressedFor` only, by the Codex
 *  package's image rule (SessionRunScreen.submitImage), reached through the
 *  registry. What that rule could not paste is `not-taken`, the log saying
 *  why and whether what it typed may still be at the prompt: the caller then
 *  types today's line by its own Codex rule, which types only into a ready,
 *  empty composer, so a paste left at the prompt gets nothing more and a
 *  note. Never rejects. */
async function typeCodexImage(sessionId: string, imagePath: string, sentence: string, pressedFor: IPty): Promise<{ result: ImageSubmitResult; why: string }> {
  try {
    if (port().run(sessionId) !== pressedFor) return { result: { outcome: 'not-sent', reason: 'session-gone' }, why: '' }
    const screen = codexRunScreen()
    if (!screen?.submitImage || !screen.has(sessionId)) return { result: { outcome: 'not-taken' }, why: 'main reads no screen for it' }
    const r = await screen.submitImage(sessionId, imagePath, sentence, { readyWaitMs: IMAGE_CODEX_READY_WAIT_MS })
    if (r.pasted) return { result: { outcome: 'sent' }, why: '' }
    if (r.reason === 'session-gone' || r.reason === 'refused-text') return { result: { outcome: 'not-sent', reason: r.reason }, why: '' }
    return { result: { outcome: 'not-taken' }, why: `${r.reason}${r.left ? ', what it typed may still be at the prompt' : ''}` }
  } catch {
    return { result: { outcome: 'not-sent', reason: 'session-gone' }, why: '' }
  }
}

/** One image, typed into `pressedFor` only (submitImage). Never rejects: a
 *  write that throws is the session gone. */
async function typeImage(sessionId: string, imagePath: string, sentence: string, pressedFor: IPty): Promise<ImageSubmitResult> {
  const gone: ImageSubmitResult = { outcome: 'not-sent', reason: 'session-gone' }
  try {
    const p = port()
    const live = (): boolean => p.run(sessionId) === pressedFor
    if (!live()) return gone
    const paste = `${PASTE_START}${imagePath}${PASTE_END}`
    p.write(sessionId, paste)
    await textSettled(paste, IMAGE_PASTE_SETTLE_MS)
    if (!live()) return gone
    const words = ` ${sentence}`
    p.write(sessionId, words)
    await textSettled(words, IMAGE_ENTER_DELAY_MS)
    if (!live()) return gone
    p.write(sessionId, '\r')
    return { outcome: 'sent' }
  } catch {
    return gone
  }
}

/**
 * 2.1.3-beta.16 X1.2 (aicc_planning#405): a saved image (Snap's picture, or
 * Alt+V's) into a Claude Code session on this computer, as the CLI's own
 * paste. Probe P11 found Claude Code attaches a path it gets as a bracketed
 * paste, as its own paste does, and only reads a path typed as text as words
 * (ADR-030, the P11 result). So the path goes in as a bracketed paste
 * (ESC [200~ path ESC [201~), then, IMAGE_PASTE_SETTLE_MS after it went, a
 * space and the sentence, then, IMAGE_ENTER_DELAY_MS after that, Enter, each
 * its own write through the write port (writePty), and each only while the
 * session's terminal process is still the one it had when this was asked.
 * The Enter always goes: the prompt buttons' Type it only setting is theirs.
 *
 * A Codex session (2.1.3-beta.17 C6, aicc_planning#415): the Codex package's
 * image rule, reached through the registry (typeCodexImage), since Codex's
 * submit primitive refuses a control character and a bracketed paste holds
 * two. It waits up to IMAGE_CODEX_READY_WAIT_MS for Codex's ready, empty
 * composer, as a prompt button does, pastes the path, reads Codex's image
 * placeholder on the screen the composer rule reads (the holder's for a held
 * session, main's pane otherwise), then has the submit primitive type the
 * sentence, confirm it and press Enter (providers/codex/session-screen.ts,
 * pasteImageIntoCodexComposer, says how). What it could not paste (not ready
 * in the wait, no placeholder, Codex's warning count showing, the sentence
 * not confirmed) it takes back as the composer rule takes text back, or, when
 * it cannot do that for certain, leaves and types nothing more; either way it
 * answers `not-taken`, with one log line saying why: the renderer then types
 * today's line by its own Codex rule, which types only into a ready, empty
 * composer and otherwise says why it typed nothing (a paste left at the
 * prompt: that the image is there and was not sent).
 *
 * Not this door's (`not-taken`, nothing typed; the renderer keeps its own way
 * for it): an SSH Persistent session (tmux). The renderer asks only for a
 * session on this computer: an SSH session gets the image through the host
 * fetch tool, and a plain terminal never reaches here. A path or sentence
 * holding a control character, an empty path, or one over its cap is refused
 * (`refused-text`) and nothing is typed. A session with no terminal process
 * takes nothing. Images and prompt presses for one session go one at a time,
 * in order (promptChains). The log names an image by its path's length only.
 * Throws before the PTY manager registers its ports, as every door does;
 * otherwise never rejects.
 */
export function submitImage(sessionId: string, imagePath: string, sentence: string): Promise<ImageSubmitResult> {
  const p = port()
  const chars = [...imagePath].length
  const done = (result: ImageSubmitResult, why = ''): ImageSubmitResult => {
    const what = result.outcome === 'sent' ? 'sent as a paste'
      : result.outcome === 'not-taken' ? `not taken (${why ? `${why}; ` : ''}the session gets it its own way)`
        : `not sent (${result.reason})`
    logInfo(`[image-paste] ${sessionId}: an image path of ${chars} characters ${what}`)
    return result
  }
  if (p.tmuxWrapped(sessionId)) return Promise.resolve(done({ outcome: 'not-taken' }))
  if (!imagePath || imagePath.length > IMAGE_PATH_MAX_CHARS || sentence.length > IMAGE_SENTENCE_MAX_CHARS || hasControlChar(imagePath) || hasControlChar(sentence)) {
    return Promise.resolve(done({ outcome: 'not-sent', reason: 'refused-text' }))
  }
  const pressedFor = p.run(sessionId)
  if (!pressedFor) return Promise.resolve(done({ outcome: 'not-sent', reason: 'session-gone' }))
  const codex = p.isCodexSession(sessionId)
  const before = promptChains.get(sessionId)
  const go = (): Promise<ImageSubmitResult> => codex
    ? typeCodexImage(sessionId, imagePath, sentence, pressedFor).then(({ result, why }) => done(result, why))
    : typeImage(sessionId, imagePath, sentence, pressedFor).then((result) => done(result))
  const next = before ? before.then(go, go) : go()
  promptChains.set(sessionId, next)
  void next.then(() => { if (promptChains.get(sessionId) === next) promptChains.delete(sessionId) })
  return next
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
 * does for a session whose screen it does not read, so its canvas is told.
 * Otherwise it answers nothing: a marker the chain drops untyped (held past its bound, its run
 * ended) is told to its canvas by the chain itself. `canvasId`, the canvas
 * the marker was filed on when the caller named one, goes with the line, so
 * the same words filed on two canvases stay two markers.
 */
export function submitMarker(sessionId: string, line: string, canvasId?: string): void | Promise<SubmitTextResult> {
  if (port().isCodexSession(sessionId)) {
    // The primitive answers a session whose screen it does not read itself (review A-8).
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
 * the run's screen (its pane, or its holder's) and its submit primitive,
 * never as the raw question and Enter (Codex submits no such write, PB3). The characters Codex's prompt
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

/** 2.1.3-beta.15 B3: the quit keys `agent`'s provider package names, or none
 *  (no agent, or a provider not registered, or registered without keys). */
function exitKeysOf(agent: ProviderId | null | undefined): readonly ExitKey[] {
  if (!agent) return []
  try { return getProvider(agent).exitKeys ?? [] } catch { return [] }
}

/**
 * The quit keys into a CLI the app started, for the PTY manager's
 * gracefulExitPty only, which decides which sessions get them (a
 * tmux-persistent remote is detached and a terminal whose CLI the app did not
 * start is closed, both without them). Since 2.1.3-beta.15 B3 they are the
 * keys the session's provider package names (`agent`, the CLI the session
 * runs; SessionProvider.exitKeys), each at its time from this call, the first
 * at once, written to `proc` itself, as the PTY manager wrote them. Claude
 * Code's are Escape (cancel any pending input) at once, Ctrl-C (interrupt
 * anything) at 100 ms, then /exit and Enter at 300 ms, as before; Codex's are
 * Escape at once, Ctrl-C at 30 ms and Ctrl-C again at 1,500 ms, and no /exit
 * (providers/codex/index.ts says why). A session with no agent,
 * or whose provider names none, gets none: its quit ends at gracefulExitPty's
 * timeout (gracefulExitPty hands a Terminal only SSH tab whose launch line the
 * app typed the SSH surface's provider, so that one keeps Claude Code's keys).
 * Each key only while `proc` is still the session's terminal
 * process: one that ended, or was replaced by a new run, gets none of the
 * rest. (The PTY manager asked only whether the session still had a terminal,
 * so a replaced one got the rest.)
 * A key whose write fails (a process that has died, its exit not yet told) is
 * dropped, as the envelope writer's slices are (R-010): it never throws out
 * of a timer or out of gracefulExitPty, whose exit listener or timeout then
 * ends the quit. The next key is still tried, at its time. Throws before the
 * PTY manager registers its ports, as every door does, and types nothing.
 */
export function sendExitKeys(sessionId: string, proc: IPty, agent: ProviderId | null | undefined): void {
  const p = port()
  const live = (): boolean => p.run(sessionId) === proc
  const key = (data: string): void => {
    if (!live()) return
    try { proc.write(data) } catch { /* already gone */ }
  }
  for (const { data, atMs } of exitKeysOf(agent)) {
    if (atMs > 0) setTimeout(() => key(data), atMs)
    else key(data)
  }
}
