// The session input module (2.1.3-beta.9 section A1; ADR-030 component row
// 3's submit): the one door through which main types into a session on its
// own initiative. Main decides here what goes in for the Watchdog's retry
// (submitRetry), an Agent Canvas marker (submitMarker) and Ask
// Conductor's question on Codex (askQuestion, handOffAskQuestion), and nowhere
// else. A Claude Code marker is the one main does not type itself: the
// Claude Code package hands it to canvas/claude-marker-typing.ts, which has
// the renderer type it at main's request (in a tab through the session helper
// on its machine the renderer types the line alone, and the package types its
// Enter through the write port: 2.1.3-beta.19 section 6.1).
// tests/unit/main/session-input-ownership.test.ts holds every other place in
// main that types into a session to a shrinking allow-list.
//
// ONE SEAM (2.1.3-beta.18 section 4, aicc_planning#432; ADR-030 component
// rows 3 and 14). Each door used to ask one question, "is it Codex?", and
// type Claude Code's way for every other session. Now it asks which provider
// runs the session (the port's providerOf) and types through that provider's
// run screen, by the package's rule for the door (SessionRunScreen's retry,
// prompt, marker, image and ask): the Codex package's members are the Codex
// calls this module made (providers/codex/run-screen-doors.ts), and the
// Claude Code package's are the Claude Code rules this module typed
// (providers/claude/run-screen.ts), moved there unchanged. A provider with no
// member for a door takes nothing there and the door logs one line: no
// session is ever typed into by another provider's rule. What the doors
// still decide themselves is the same for every provider: the order of a
// session's presses and images, the repeat window, "Type it only", the image
// door's checks, each door's waits (handed to the member), the dock's
// notices and the logs. Nothing typed into a Claude Code or Codex session
// changes by one byte, in order or in time. The sections below that say
// "Claude Code's" or "Codex's" describe those packages' members.
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
// Since 2.1.3-beta.21 phase 2 (ADR-032, aicc_planning#447) every picture goes
// in through the CLI's own clipboard paste instead: a new door,
// pasteFromClipboard, types the CLI's paste key as one write for the paste
// module (src/main/paste), then reads its placeholder and, for a press from
// outside the terminal and for Snap, types the sentence and Enter, through
// the run screen's `clipboard` member. No path. submitImage stays, unchanged,
// for the path route behind the test switch only (pty:submitPrompt refuses
// an image path otherwise), and goes in 2.1.3-beta.22.
//
// Since 2.1.3-beta.10 section A2 the Watchdog's retry comes in through one
// door, submitRetry: a Codex session's goes through the Codex package's
// submit primitive, as a canvas marker's does, instead of the raw writer
// (typeKeys, removed) the Watchdog typed it through by a rule of its own; a
// Claude Code session's is the tmux leave key on an SSH Persistent session,
// then the line and Enter in one write, unchanged (since 2.1.3-beta.18
// section 4 the Claude Code package's retry member). That changes how a Codex
// retry is typed, written at submitRetry, and nothing else said below. Since
// the 2.1.3-beta.18 fix round a tab through the session helper on its machine
// gets the retry's Enter as its own write (RunScreenTyping.wholeWrites),
// written at submitRetry too, and since PR 763 fix round 9 every Claude Code
// tab does.
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
// 256-byte chunking and its launch-pending buffer), whether a door writes it
// or a run screen's member writes it through the RunScreenTyping the door
// hands it, or through the Codex package's own submit primitive; a provider
// package is reached only through the provider registry, as the PTY manager
// reaches it (WP1 rule R4: no deep import into a provider package).
// The two beta.9 A2 doors are the exceptions, as they were in the PTY manager: a
// channel envelope and the quit keys are written to the session's terminal
// process itself, never through writePty's duplicate guard, and each only
// while that process is still the session's (for the quit keys, new in beta.9's A2).
import type { BrowserWindow } from 'electron'
import type { IPty } from 'node-pty'
import { getProvider } from '../providers'
import type { ExitKey, RunScreenClipboardResult, RunScreenTyping, SessionRunScreen } from '../providers/types'
import type { ProviderId } from '../../shared/types'
import { PROVIDER_IDS } from '../../shared/providers'
import { IPC } from '../../shared/ipc-channels'
import { TMUX_WHEEL_EXIT_KEY } from '../../shared/tmux-wheel'
import type { SubmitTextResult, AskConductorNotice, PromptButtonResult } from '../../shared/types'
import { MARKER_FALLBACK_FLUSH_MS } from '../canvas/canvas-marker-queue'
import { logInfo } from '../debug-logger'
import { PasteQueue } from '../paste-queue'
import { runChunkedWrite, WRITE_CHUNK_SIZE, WRITE_CHUNK_DELAY } from '../pty-chunked-write'
import { isRemoteHelperTab, remoteTabScreen } from '../remote-helper'
import { PROMPT_ENTER_DELAY_MS, REPEAT_WINDOW_MS } from './enter-delay'

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
  /** 2.1.3-beta.18 section 4: the provider whose CLI the session's terminal
   *  runs now (the one its live PTY was started for; for a Terminal only SSH
   *  tab whose launch line the app typed, the SSH surface's, as the quit keys
   *  read it), or null: a plain shell, or no session. Every door types
   *  through that provider's run screen, and only through it. */
  providerOf: (sessionId: string) => ProviderId | null
  /** Whether the PTY manager recorded the session as an Ask Conductor launch whose later questions this module types (its codexAskSessions: today only a Codex session launched as Ask; a Claude Code Ask session is not recorded, so its hand-off takes nothing here, and a new provider's Ask launch must be recorded there before its ask member is reached). */
  isAskSession: (sessionId: string) => boolean
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

/** 2.1.3-beta.18 section 4 (aicc_planning#432): the run screen of the
 *  provider that runs `sessionId` (the port's providerOf), from the registered
 *  provider: main reaches a provider package only through the registry,
 *  never by importing it, and never by a provider's name. Undefined for a
 *  session no provider runs, or whose provider is not registered or has no
 *  run screen. (It replaces codexRunScreen, which fetched the Codex package's
 *  by name for every session.) Throws before the PTY manager registers its
 *  ports, as every door does. */
function screenOf(sessionId: string): SessionRunScreen | undefined {
  const p = port()
  let id: ProviderId | null
  try { id = p.providerOf(sessionId) } catch { return undefined }
  if (!id) return undefined
  try { return getProvider(id).runScreen } catch { return undefined }
}

/** A door the session's provider has no member for: nothing is typed (never
 *  another provider's way), and one log line says so, by the session and the
 *  door only. */
function notTaken(sessionId: string, what: string): void {
  logInfo(`[session-input] ${sessionId}: ${what} was not taken: the session's provider has no rule for it, so nothing was typed`)
}

/** What a door hands a run screen's member (RunScreenTyping) for `run`, the
 *  session's terminal process when the door was asked: the write port, the
 *  tmux leave key on an SSH Persistent session (read now, when the door is
 *  asked), whether the session is a tab through the session helper on its
 *  machine (wholeWrites, read now too, from the remote helper's own record of
 *  the tabs it started), whether the run is still the session's, and
 *  textSettled; for such a tab whose connection reads its holder's screen,
 *  that read (heldScreen, 2.1.3-beta.21: Claude Code's clipboard paste reads
 *  its placeholder there, ADR-032).
 *  #85: the wheel opens tmux's scrollback view on an SSH Persistent session,
 *  and copy-mode swallows input, so a pane the user scrolled up in would take
 *  a retry or a prompt instead of the CLI. The leave key is given for every
 *  wrapped session because main cannot see copy-mode: outside it, tmux's root
 *  table binds that key to nothing (verified against tmux 3.4, 2026-09-20). */
function typingFor(sessionId: string, run: IPty | undefined): RunScreenTyping {
  const p = port()
  const helperTab = isRemoteHelperTab(sessionId)
  const heldScreen = helperTab ? remoteTabScreen(sessionId) : undefined
  return {
    leave: p.tmuxWrapped(sessionId) ? TMUX_WHEEL_EXIT_KEY : '',
    wholeWrites: helperTab,
    live: () => !!run && p.run(sessionId) === run,
    write: (data) => p.write(sessionId, data),
    settled: (data, delayMs) => textSettled(data, delayMs),
    ...(heldScreen ? { heldScreen } : {}),
  }
}

/** Every registered provider's run screen, each handed to `each`. */
function eachRunScreen(each: (screen: SessionRunScreen) => void): void {
  for (const id of PROVIDER_IDS) {
    let screen: SessionRunScreen | undefined
    try { screen = getProvider(id).runScreen } catch { continue }
    if (screen) each(screen)
  }
}

/** 2.1.3-beta.18 section 4: a session's run ended or its session went (the
 *  PTY manager's launch failure and teardown): each registered provider's run
 *  screen closes its reading of it, if it has one (a submission still
 *  waiting on it reports the session gone and types nothing more). Every
 *  provider's, not the one providerOf names: by then the session's terminal
 *  may be gone. A run screen with nothing for the session does nothing. */
export function closeRunScreens(sessionId: string): void {
  eachRunScreen((screen) => screen.close(sessionId))
}

/** 2.1.3-beta.18 section 4: the PTY manager's resize of a session's terminal,
 *  for each registered provider's reading of it (a holder keeps its own size;
 *  a run screen with nothing for the session does nothing). */
export function resizeRunScreens(sessionId: string, cols: number, rows: number): void {
  eachRunScreen((screen) => screen.resize(sessionId, cols, rows))
}

/** 2.1.3-beta.10 section A2: how long the Watchdog's retry waits for a CLI's
 *  ready, empty composer, where its provider's rule reads one (Codex's),
 *  before it answers not delivered. */
export const RETRY_CODEX_READY_WAIT_MS = 5_000

/**
 * 2.1.3-beta.10 section A2 (aicc_planning #336): the Watchdog's retry into a
 * session, by its CLI's rule (since 2.1.3-beta.18 section 4 the retry member
 * of the run screen of the provider that runs it). The Watchdog decides when
 * to retry and what; this decides only how the retry is typed.
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
 * - A Claude Code session's (on this computer, held by the session helper,
 *   or over SSH) is the line, then Enter as its own write
 *   PROMPT_ENTER_DELAY_MS after the line's last slice, and only while the run
 *   is still the one the line went to, as a prompt button's Send goes; on an
 *   SSH Persistent session each write starts with the leave key. It answers
 *   nothing. It is typed at once, as the Watchdog decides, so `stillWanted`
 *   has nothing to guard there; the same text asked again within 300 ms is
 *   dropped. Claude Code takes a control character as a key only in a read
 *   shorter than 64 characters, so a line and its Enter in one write that
 *   reached it as one read stayed typed and unsent: first seen in a tab
 *   through the session helper on its machine (split in the 2.1.3-beta.18
 *   fix round), then on a local Windows tab (every tab split in PR 763 fix
 *   round 9).
 * - A session whose provider has no retry rule (or no provider, or none
 *   registered) gets nothing typed, one log line, and the answer not
 *   delivered (`session-gone`), so the Watchdog logs it.
 *
 * Throws before the PTY manager registers its ports, as every door does.
 */
export function submitRetry(sessionId: string, text: string, stillWanted?: () => boolean): void | Promise<SubmitTextResult> {
  const screen = screenOf(sessionId)
  if (!screen?.retry) {
    notTaken(sessionId, 'a Watchdog retry')
    return Promise.resolve({ delivered: false, reason: 'session-gone' })
  }
  return screen.retry(sessionId, text, {
    readyWaitMs: RETRY_CODEX_READY_WAIT_MS,
    readyBy: Date.now() + RETRY_CODEX_READY_WAIT_MS,
    ...(stillWanted ? { stillWanted } : {}),
    enterDelayMs: PROMPT_ENTER_DELAY_MS,
  }, typingFor(sessionId, port().run(sessionId)))
}

/** #333: how long a prompt button's Enter follows the last slice of its text
 *  (the delay the renderer's Codex rule uses, codexComposer.ts). Set in
 *  ./enter-delay.ts, which the Claude Code and Codex packages' run screens
 *  read too (the wait their held terminals' queued lone Enter keeps). */
export { PROMPT_ENTER_DELAY_MS }
/** #333: the same text pressed again for a session within this long is
 *  dropped (the window of writePty's duplicate guard, which a write that does
 *  not end in Enter no longer reaches). Set in ./enter-delay.ts, the one
 *  value Claude Code's run screen drops a repeated retry by too. */
export const PROMPT_REPEAT_WINDOW_MS = REPEAT_WINDOW_MS
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
 * the next press cannot land between its slices. Since 2.1.3-beta.18
 * section 4 a Send is the prompt member of the run screen of the provider
 * that runs the session, handed the door's waits and the run; "Type it only"
 * is this door's own, for any provider with that member; a provider without
 * it takes nothing (`session-gone`, and one log line). Never rejects: a
 * write that throws is the session gone.
 */
async function typePrompt(sessionId: string, text: string, mode: PromptButtonMode, pressedFor: IPty | undefined): Promise<PromptButtonResult> {
  const gone: PromptButtonResult = { outcome: 'not-sent', reason: 'session-gone' }
  try {
    const typing = typingFor(sessionId, pressedFor)
    // No process: writePty would hold the text for a later start.
    if (!typing.live()) return gone
    const screen = screenOf(sessionId)
    if (!screen?.prompt) {
      notTaken(sessionId, 'a prompt button\'s text')
      return gone
    }
    if (mode === 'send') {
      return await screen.prompt(sessionId, text, { readyWaitMs: PROMPT_CODEX_READY_WAIT_MS, maxCodePoints: PROMPT_CODEX_MAX_CODE_POINTS, enterDelayMs: PROMPT_ENTER_DELAY_MS }, typing)
    }
    const data = `${typing.leave}${text}`
    typing.write(data)
    await textSettled(data)
    return { outcome: 'typed' }
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
 *   SSH Persistent session as the Watchdog's retry does, and no Enter.
 * - Send, a Claude Code session (on this computer, held by the session
 *   helper or over SSH; the Claude Code package's prompt member since
 *   2.1.3-beta.18 section 4): the text as above, then Enter as its own
 *   write PROMPT_ENTER_DELAY_MS after the text's last slice went (textSettled),
 *   and only while the session's terminal process is still the one the text
 *   went to; on an SSH Persistent session the Enter's write starts with the
 *   leave key too. The Enter never rides in the text's write: Codex takes one
 *   write of both as a paste and never submits it, and #333 reports a session
 *   on this computer where such a write was typed and not sent.
 * - Send, a Codex session (the Codex package's prompt member): the Codex
 *   package's submit primitive, as canvas
 *   notes and Ask Conductor use it, with PROMPT_CODEX_READY_WAIT_MS to wait
 *   for the ready, empty composer; its answer is the answer. A text it refuses
 *   before typing is typed with no Enter, and the answer says so. A text over
 *   PROMPT_CODEX_MAX_CODE_POINTS is not handed to it: nothing is typed, and
 *   the answer is not sent (`refused-text`).
 * - A session whose provider has no prompt member (or no provider): nothing
 *   is typed, in either mode, and the answer is not sent (`session-gone`).
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
 * Claude Code's rule lived here, in this module, until 2.1.3-beta.18
 * section 4 moved it, unchanged, into the Claude Code package's run screen
 * (providers/claude/run-screen.ts).
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
 *  could not paste the image into, or since 2.1.3-beta.18 section 4 a
 *  session whose provider has no image rule), which the caller then sends
 *  its own way (for that last one, none: the renderer types nothing),
 *  with `left` when the paste main typed may still be at the prompt (it could
 *  not take it back for certain), so the caller types nothing more; or
 *  `not-sent` and why. */
export type ImageSubmitResult =
  | { outcome: 'sent' }
  | { outcome: 'not-taken'; left?: true }
  | { outcome: 'not-sent'; reason: 'session-gone' | 'refused-text' }

/** Whether `text` holds a control character (C0, DEL or C1): in a path one
 *  could end the bracketed paste early and be read as keys. */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true
  }
  return false
}

/** One image into the run `pressedFor` only (submitImage), by the image
 *  member of `screen`, the run screen of the provider that ran the session
 *  when the image was asked for (2.1.3-beta.18 section 4; C6's Codex rule and
 *  X1.2's Claude Code paste are those packages' members). What the member
 *  could not paste is `not-taken`, the log saying why: with `left` when what
 *  it typed may still be at the prompt, so the caller types nothing more and
 *  says the image is there; without, the caller types its own line. A
 *  provider with no image member takes nothing (`not-taken`). Never rejects:
 *  a write that throws is the session gone. */
async function typeImage(sessionId: string, imagePath: string, sentence: string, pressedFor: IPty, screen: SessionRunScreen | undefined): Promise<{ result: ImageSubmitResult; why: string }> {
  const gone: { result: ImageSubmitResult; why: string } = { result: { outcome: 'not-sent', reason: 'session-gone' }, why: '' }
  try {
    const typing = typingFor(sessionId, pressedFor)
    if (!typing.live()) return gone
    if (!screen?.image) return { result: { outcome: 'not-taken' }, why: 'the session\'s provider has no image rule, so main typed nothing' }
    const r = await screen.image(sessionId, imagePath, sentence, { readyWaitMs: IMAGE_CODEX_READY_WAIT_MS, settleMs: IMAGE_PASTE_SETTLE_MS, enterDelayMs: IMAGE_ENTER_DELAY_MS }, typing)
    if (r.pasted) return { result: { outcome: 'sent' }, why: '' }
    if (r.reason === 'session-gone' || r.reason === 'refused-text') return { result: { outcome: 'not-sent', reason: r.reason }, why: '' }
    return { result: r.left ? { outcome: 'not-taken', left: true } : { outcome: 'not-taken' }, why: `${r.reason}${r.left ? ', what it typed may still be at the prompt' : ''}` }
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
 * (Since 2.1.3-beta.18 section 4 this is the Claude Code package's image
 * member, handed IMAGE_PASTE_SETTLE_MS and IMAGE_ENTER_DELAY_MS by this door.)
 *
 * A Codex session (2.1.3-beta.17 C6, aicc_planning#415): the Codex package's
 * image rule, reached through the registry (the Codex package's image member
 * since 2.1.3-beta.18 section 4), since Codex's
 * submit primitive refuses a control character and a bracketed paste holds
 * two. It waits up to IMAGE_CODEX_READY_WAIT_MS for Codex's ready, empty
 * composer, as a prompt button does, pastes the path, reads Codex's image
 * placeholder on the screen the composer rule reads (the holder's for a held
 * session, main's pane otherwise), then has the submit primitive type the
 * sentence, confirm it and press Enter (providers/codex/session-screen.ts,
 * pasteImageIntoCodexComposer, says how). What it could not paste (not ready
 * in the wait, no placeholder, the sentence not confirmed; since
 * 2.1.3-beta.17 C9 Codex's warning count is read as its composer readers
 * read it, not refused) it takes back as the composer rule takes text back,
 * or, when it cannot do that for certain, leaves and types nothing more;
 * either way it answers `not-taken`, with one log line saying why. Taken
 * back: the renderer then types today's line by its own Codex rule, which
 * types only into a ready, empty composer and otherwise says why it typed
 * nothing. Left: the answer carries `left`, and the renderer types nothing
 * and says the image is at the prompt and was not sent.
 *
 * Not this door's (`not-taken`, nothing typed; the renderer keeps its own way
 * for it): an SSH Persistent session (tmux), and (2.1.3-beta.18 section 4)
 * a session whose provider has no image member. The renderer asks only for a
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
      : result.outcome === 'not-taken' ? `not taken (${why ? `${why}; ` : ''}${result.left ? 'nothing more is typed' : 'the session gets it its own way'})`
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
  // The provider that runs the session now decides the rule, as the Codex
  // test did, at the ask and not at the chain's turn.
  const screen = screenOf(sessionId)
  const before = promptChains.get(sessionId)
  const go = (): Promise<ImageSubmitResult> => typeImage(sessionId, imagePath, sentence, pressedFor, screen).then(({ result, why }) => done(result, why))
  const next = before ? before.then(go, go) : go()
  promptChains.set(sessionId, next)
  void next.then(() => { if (promptChains.get(sessionId) === next) promptChains.delete(sessionId) })
  return next
}

/** ADR-032 (plan 2.1.3-beta.21 phase 2, 2.1.3): how long the clipboard
 *  paste waits for the CLI's image placeholder after its key. The rule, fixed
 *  in PW1's header before it ran: PW1's worst case at 3 busy processes, for
 *  the key the app sends on Windows (ESC v), over both CLIs, times 2, at most
 *  10 s. Applied to every PW1 reading (review round 1, R1-1), so 10 s, the
 *  cap. Probe run 46128029706 (GitHub's Windows runner, 4 CPUs, the app's
 *  bundled ConPTY, the app on a fresh, empty PowerShell module analysis
 *  cache): Claude Code 2.1.332's own clipboard read (Windows PowerShell),
 *  for ESC v, showed no placeholder within PW1's 15 s bound at 0, 1, 2 and
 *  3 busy processes (4 of 4); the one placeholder seen, 13.7 s into the
 *  grade 1 Ctrl+V row, is most likely that grade's ESC v read ending late
 *  (Claude Code ignores Ctrl+V on Windows, run 46128921672). So its worst
 *  case is over 15 s and twice that is over the cap. On a warm cache (probe
 *  run 46128921672) it showed "[Image #1]" 926, 914, 1030 and 1250 ms after
 *  ESC v at 0, 1, 2 and 3 busy processes; Codex 0.157.1 31 to 76 ms there and
 *  31 to 120 ms on the cold cache (it reads the clipboard without
 *  PowerShell); every turn carried the picture by its decoded pixels. (Claude
 *  Code ignored Ctrl+V on Windows at every grade, as its table says.) The
 *  gate's presses (runs 46129823039 and 46130805592, at 2.5 s) stand: the
 *  poll stops at the placeholder, so the longer wait changes only a press
 *  whose CLI shows none, which then waits up to 10 s before it says so,
 *  instead of saying so while a slower computer's CLI is still reading the
 *  picture. */
export const CLIPBOARD_PLACEHOLDER_WAIT_MS = 10_000
/** ADR-032: how long the Enter follows the sentence typed after the picture
 *  (the image door's own, IMAGE_ENTER_DELAY_MS). */
export const CLIPBOARD_ENTER_DELAY_MS = IMAGE_ENTER_DELAY_MS
/** ADR-032: how long a press from outside the terminal, or Snap, waits for
 *  a CLI's ready, empty composer before its key, where the CLI's rule reads
 *  one (Codex's), as an image's path did. */
export const CLIPBOARD_READY_WAIT_MS = IMAGE_CODEX_READY_WAIT_MS

/** What the clipboard paste door did (pasteFromClipboard): the run screen's
 *  answer, or `refused-key` (a key that is not one of the paste keys a
 *  provider table names, or a sentence it refuses: nothing typed), or
 *  `not-taken` (an SSH Persistent session, or a provider with no clipboard
 *  member: nothing typed). */
export type ClipboardPasteDoorResult = RunScreenClipboardResult | { outcome: 'refused-key' | 'not-taken' }

/** The keys the door types: one control byte (Ctrl and a letter), or ESC and
 *  one letter or control byte (Alt and a letter, Ctrl and Alt and a letter),
 *  the shapes the provider tables' chord table makes. Never a bracketed paste
 *  (ESC [ ...), never more than one key, and never Ctrl+C or Ctrl+D (which
 *  end a CLI) or a byte a terminal reads as Backspace, Tab, a new line or
 *  Enter. */
export function isPasteKeyBytes(key: string): boolean {
  return typeof key === 'string' && /^(?:\u001b?[\u0001\u0002\u0005-\u0007\u000b\u000c\u000e-\u001a]|\u001b[A-Za-z])$/.test(key)
}

/** The provider whose CLI runs `sessionId` now (the PTY manager's port), or
 *  null: a plain shell, or no session. For the paste module, which reads that
 *  provider's clipboard paste table (ADR-032 row 14) before it asks the door. */
export function providerOfSession(sessionId: string): ProviderId | null {
  try { return port().providerOf(sessionId) } catch { return null }
}

/**
 * ADR-032 (plan 2.1.3-beta.21 phase 2, 2.1.3; aicc_planning#447): the CLI's
 * own clipboard image paste into a session. The paste module (src/main/paste)
 * has decided the press is an image paste and written this computer's
 * clipboard if it had to; this door types the key the session's provider
 * table names (`key`), as ONE write, never inside a bracketed paste, through
 * the run screen of the provider that runs the session (its `clipboard`
 * member): Codex's reads its placeholder on main's screen reading of the run,
 * Claude Code's on the session's terminal view. `sentence` (a press from
 * outside the terminal, and Snap) is typed after the placeholder, then Enter;
 * null (a press in the terminal) types nothing after the key. No path is
 * typed, and nothing is taken back.
 *
 * A key that is not a paste key's shape (isPasteKeyBytes), or a sentence over
 * IMAGE_SENTENCE_MAX_CHARS or holding a control character, is refused
 * (`refused-key`) and nothing is typed. An SSH Persistent session (tmux) and
 * a provider with no clipboard member take nothing (`not-taken`). A session
 * with no terminal process takes nothing (`session-gone`). Pastes, images
 * and prompt presses for one session go one at a time, in order
 * (promptChains). The log names no key, no picture and no path. Throws before
 * the PTY manager registers its ports, as every door does; otherwise never
 * rejects.
 */
export function pasteFromClipboard(sessionId: string, key: string, sentence: string | null): Promise<ClipboardPasteDoorResult> {
  const p = port()
  const done = (result: ClipboardPasteDoorResult): ClipboardPasteDoorResult => {
    logInfo(`[clipboard-paste] ${sessionId}: ${sentence === null ? 'a press in the terminal' : 'a press from outside the terminal'}: ${result.outcome}`)
    return result
  }
  if (!isPasteKeyBytes(key) || (sentence !== null && (sentence.length > IMAGE_SENTENCE_MAX_CHARS || hasControlChar(sentence)))) {
    return Promise.resolve(done({ outcome: 'refused-key' }))
  }
  if (p.tmuxWrapped(sessionId)) return Promise.resolve(done({ outcome: 'not-taken' }))
  const pressedFor = p.run(sessionId)
  if (!pressedFor) return Promise.resolve(done({ outcome: 'session-gone' }))
  const screen = screenOf(sessionId)
  const go = async (): Promise<ClipboardPasteDoorResult> => {
    try {
      const typing = typingFor(sessionId, pressedFor)
      if (!typing.live()) return done({ outcome: 'session-gone' })
      if (!screen?.clipboard) {
        notTaken(sessionId, 'a clipboard image paste')
        return done({ outcome: 'not-taken' })
      }
      return done(await screen.clipboard(sessionId, key, sentence, {
        readyWaitMs: CLIPBOARD_READY_WAIT_MS, placeholderWaitMs: CLIPBOARD_PLACEHOLDER_WAIT_MS, enterDelayMs: CLIPBOARD_ENTER_DELAY_MS,
      }, typing))
    } catch {
      return done({ outcome: 'session-gone' })
    }
  }
  const before = promptChains.get(sessionId)
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
 * A Claude Code session's is held, in the order handed in, and
 * typed only when the session's own screen reads Claude Code's ready, empty
 * prompt, by the same reading the status strip's controls type through
 * (canvas/claude-marker-typing.ts). Only into the run it was handed for, the
 * session's terminal process (a restart is a new run; a Claude Code started
 * again by hand in the same terminal is not). It answers nothing: a marker
 * the chain drops untyped (held past its bound, its run ended) is told to
 * its canvas by the chain itself. `canvasId`, the canvas the marker was
 * filed on when the caller named one, goes with the line, so the same words
 * filed on two canvases stay two markers. In a tab through the session
 * helper on its machine (RunScreenTyping.wholeWrites, 2.1.3-beta.19 section
 * 6.1) its Enter is its own write, PROMPT_ENTER_DELAY_MS after the line, and
 * only while the run is still the one the line went to, as the retry's is.
 *
 * Since 2.1.3-beta.18 section 4 each of those is the marker member of the
 * run screen of the provider that runs the session, handed the marker
 * queue's bound and the run. A session with no run takes nothing and answers
 * not delivered (the session gone), so its canvas is told; so does a session
 * whose provider has no marker member, with one log line, and nothing typed.
 */
export function submitMarker(sessionId: string, line: string, canvasId?: string): void | Promise<SubmitTextResult> {
  const run = port().run(sessionId)
  if (!run) {
    logInfo(`[canvas-marker] ${sessionId}: no running session, so a marker was not typed`)
    return Promise.resolve({ delivered: false, reason: 'session-gone' })
  }
  const screen = screenOf(sessionId)
  if (!screen?.marker) {
    notTaken(sessionId, 'a canvas marker')
    return Promise.resolve({ delivered: false, reason: 'session-gone' })
  }
  return screen.marker(sessionId, line, { readyWaitMs: MARKER_FALLBACK_FLUSH_MS, ...(canvasId !== undefined ? { canvasId } : {}) }, typingFor(sessionId, run))
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
 * rejects. Since 2.1.3-beta.18 section 4 this is the ask member of the run
 * screen of the provider that runs the session (the Codex package's, which
 * logs it), handed ASK_READY_WAIT_MS and the dock's "removed" notice; the
 * door keeps the dock's "not delivered" notice. A session whose provider has
 * no ask member gets nothing typed, one log line, and that notice
 * (`session-gone`).
 *
 * It does NOT check that the session launched as Ask Conductor: it is for the
 * PTY manager's Ask launch only, which has just put the session among the Ask
 * sessions. Every other caller goes through handOffAskQuestion, which checks.
 * session-input-ownership.test.ts holds it to the PTY manager.
 */
export async function askQuestion(win: BrowserWindow, sessionId: string, question: string): Promise<SubmitTextResult> {
  let result: SubmitTextResult = { delivered: false, reason: 'session-gone' }
  try {
    const screen = screenOf(sessionId)
    if (!screen?.ask) notTaken(sessionId, 'an Ask question')
    else result = await screen.ask(sessionId, question, { readyWaitMs: ASK_READY_WAIT_MS, removed: (count) => sendAskNotice(win, { sessionId, kind: 'removed', count }) })
  } catch {
    result = { delivered: false, reason: 'session-gone' }
  }
  if (!result.delivered) sendAskNotice(win, { sessionId, kind: 'not-delivered', reason: result.reason })
  return result
}

/**
 * WP2 PR 4, P4.3: a question for a LIVE Ask session on Codex
 * (askConductor:handOff), through the same door as the launch's. Only a
 * running session that launched as Ask, of a provider with an ask member
 * (2.1.3-beta.18 section 4: today Codex's), takes one; anything else is the
 * session gone, and nothing is typed (one log line for an Ask session whose
 * provider has no ask member).
 */
export function handOffAskQuestion(win: BrowserWindow, sessionId: string, question: string): Promise<SubmitTextResult> {
  if (!port().isAskSession(sessionId)) return Promise.resolve({ delivered: false, reason: 'session-gone' })
  if (!screenOf(sessionId)?.ask) {
    notTaken(sessionId, 'an Ask question')
    return Promise.resolve({ delivered: false, reason: 'session-gone' })
  }
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
