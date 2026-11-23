/**
 * #399 (2.1.3-beta.16, plan section B4): a Global prompt button can send to
 * every open agent session, not only to the tab it was pressed in.
 *
 * A button's scope decides only where it SHOWS (Global: on every config's
 * bar); a press types into its own tab. A broadcast press hands the same text
 * to each open agent session through that session's own prompt path,
 * `pty.submitPrompt`, the path a single press already takes (#333): main types
 * it by one rule for every session, the agent's own submit rule and the "Type
 * it only" setting hold, and main decides per session whether it can take it
 * now. Main already takes any session's id there (pty-handlers.ts), so
 * nothing in main changes.
 *
 * The owner's answers (chat, 2026-11-23):
 *  - who: every open agent tab, SSH and background tabs included; never a
 *    terminal-only tab, Ask Conductor, a tab whose process has ended, or a tab
 *    whose last launch started nothing (`broadcastTargets`);
 *  - a tab that cannot take it: its own path decides, as a single press does,
 *    and the pressed tab shows one note with the count (`broadcastNote`);
 *  - which buttons: "Broadcasty should onlly be for simple prompts": a Global
 *    prompt for the agent with no arguments, no remembered Ctrl+click
 *    arguments and no secret (`broadcastBlocker`). Shell lines never go to
 *    every session: one press would run a command in every terminal.
 *
 * No React and no store here, so the rules are testable on their own.
 */
import type { Session } from '../stores/sessionStore'
import type { CustomCommand } from '../stores/commandStore'
import type { PromptButtonResult, SubmitNotDeliveredReason } from '../../shared/types'
import { sessionCapabilities } from './session-capabilities'

/** The option's name in the button's edit dialog. */
export const BROADCAST_OPTION_LABEL = 'Send to every open session'

/** What the pill on a broadcast button says to a tooltip and a screen reader. */
export const BROADCAST_PILL_LABEL = 'Sends to every open session'

/** The fields of a session that decide whether a broadcast reaches it. */
export type BroadcastSession = Pick<Session, 'id' | 'provider' | 'sessionType' | 'shellOnly' | 'configId' | 'sshConfig' | 'kind' | 'ptyExited' | 'neverStarted'>

/**
 * Whether a broadcast reaches this session: an open agent tab, local or SSH,
 * shown or in the background. Not a terminal-only tab (its main pane is a
 * shell: the add-account and install tabs are too), not Ask Conductor (a help
 * session, not a workspace), not a tab whose process ended (`ptyExited`), not
 * a tab whose last launch started nothing (`neverStarted`).
 */
export function isBroadcastTarget(session: BroadcastSession): boolean {
  if (session.ptyExited || session.neverStarted) return false
  const caps = sessionCapabilities(session)
  return caps.agent !== null && !caps.isAsk
}

/** The sessions one broadcast press goes to, by id, in tab order, each once. */
export function broadcastTargets(sessions: readonly BroadcastSession[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const s of sessions) {
    if (!s || typeof s.id !== 'string' || seen.has(s.id) || !isBroadcastTarget(s)) continue
    seen.add(s.id)
    ids.push(s.id)
  }
  return ids
}

/** The fields of a button that decide whether it can go to every session. */
export type BroadcastFields = Pick<CustomCommand, 'scope' | 'kind' | 'target' | 'defaultArgs' | 'lastCustomArgs' | 'hasSecretArg'>

/**
 * Why this button cannot go to every open session, in one line for the edit
 * dialog, or null when it can. Only a simple prompt can (#399 Q4): a prompt
 * for the agent (an old record with no stored kind is one unless it aims at
 * the partner shell or carries a secret, as layout.ts's effectiveKind reads a
 * Global record), shown on every config's bar, with no arguments, no
 * remembered Ctrl+click arguments and no secret argument.
 */
export function broadcastBlocker(cmd: BroadcastFields): string | null {
  const prompt = cmd.kind ? cmd.kind === 'prompt' : !cmd.hasSecretArg
  if (!prompt || cmd.target === 'partner') return 'Only a prompt can go to every open session.'
  if (cmd.scope !== 'global') return 'Only a Global button can go to every open session.'
  if (cmd.hasSecretArg || cmd.defaultArgs?.length || cmd.lastCustomArgs?.length) return 'Only a prompt with no arguments can go to every open session.'
  return null
}

/** Whether a plain press of this button goes to every open session: its
 *  option is on and it is a simple prompt. A record that has the option but
 *  is no longer one (hand-edited, say) presses as a single button. */
export function isBroadcastButton(cmd: BroadcastFields & Pick<CustomCommand, 'broadcast'>): boolean {
  return cmd.broadcast === true && broadcastBlocker(cmd) === null
}

/** What one broadcast press did, counted from each session's own answer. */
export interface BroadcastTally {
  /** The sessions the press went to. */
  total: number
  /** Typed and submitted. */
  sent: number
  /** Typed and left in the prompt: the "Type it only" setting, or a text that
   *  session's prompt cannot take. */
  typed: number
  /** Nothing typed: the session was busy past its bound, showing a question of
   *  its own, or not running (ended, restarted, or never started this run). */
  busyOrEnded: number
  /** Nothing typed for another reason: too tall to check, never drawn, or a
   *  text main refused. */
  refused: number
  /** Nothing typed because the same text had just gone to it (main drops a
   *  repeat within 300 ms). */
  repeats: number
}

const BUSY_OR_ENDED: ReadonlySet<SubmitNotDeliveredReason> = new Set<SubmitNotDeliveredReason>(['busy-timeout', 'prompt-on-screen', 'session-gone'])

/** Count each session's answer. An answer the bar cannot read counts as the
 *  session gone, as a single press reads a failed bridge. */
export function tallyBroadcast(results: readonly PromptButtonResult[]): BroadcastTally {
  const t: BroadcastTally = { total: results.length, sent: 0, typed: 0, busyOrEnded: 0, refused: 0, repeats: 0 }
  for (const r of results) {
    if (r && r.outcome === 'sent') t.sent += 1
    else if (r && r.outcome === 'typed') t.typed += 1
    else if (r && r.outcome === 'dropped') t.repeats += 1
    else if (r && r.outcome === 'not-sent' && !BUSY_OR_ENDED.has(r.reason)) t.refused += 1
    else t.busyOrEnded += 1
  }
  return t
}

const sessions = (n: number) => `${n} session${n === 1 ? '' : 's'}`

/**
 * The one note the pressed tab shows (#399 Q3), e.g. "Sent to 5 of 7
 * sessions (2 busy or ended)." Null when there is nothing to say: every
 * session dropped the press as a repeat, as a single press says nothing then.
 */
export function broadcastNote(t: BroadcastTally): string | null {
  if (t.total === 0) return 'No open agent session to send to.'
  if (t.repeats === t.total) return null
  const done = t.sent > 0 && t.typed > 0
    ? `Sent to ${t.sent} and typed into ${t.typed}`
    : t.typed > 0 ? `Typed into ${t.typed}` : `Sent to ${t.sent}`
  const why: string[] = []
  if (t.busyOrEnded) why.push(`${t.busyOrEnded} busy or ended`)
  if (t.refused) why.push(`${t.refused} could not take it`)
  if (t.repeats) why.push(`${t.repeats} already sent`)
  return `${done} of ${sessions(t.total)}${why.length ? ` (${why.join(', ')})` : ''}.`
}

/** Main's prompt path for one session, as the preload exposes it. */
export type SubmitPrompt = (args: { sessionId: string; text: string }) => Promise<PromptButtonResult>

const GONE: PromptButtonResult = { outcome: 'not-sent', reason: 'session-gone' }

/**
 * Send `text` to each session once, through `submit` (main's prompt path), all
 * at once: main keeps one queue per session, so one busy session holds up only
 * itself. `before` runs for each session just before its send (the bar drops
 * the wheel's tmux scrollback belief there: main leaves copy-mode itself).
 * Answers with the count of what each session's own path did.
 */
export async function broadcastPrompt(
  text: string,
  sessionIds: readonly string[],
  submit: SubmitPrompt,
  before?: (sessionId: string) => void,
): Promise<BroadcastTally> {
  const ids = Array.from(new Set(sessionIds))
  const results = await Promise.all(ids.map((sessionId) => {
    try {
      before?.(sessionId)
      return Promise.resolve(submit({ sessionId, text })).catch(() => GONE)
    } catch {
      return Promise.resolve(GONE)
    }
  }))
  return tallyBroadcast(results)
}
