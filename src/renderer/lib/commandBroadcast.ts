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
 * aicc_planning#413 (2.1.3-beta.17, plan section C2): every broadcast press
 * asks first. A press of a button with the option, and a Shift+click on any
 * other simple Global prompt, open one chooser (command-bar/BroadcastChooser):
 * All, or the sessions the user ticks. The owner (chat, 2026-11-24): "when the
 * user clicks a broadcast button they should be given the option of all or
 * select session". The chooser lists `broadcastChoices`; its answer is
 * filtered again by `liveBroadcastPick` at the press, so a session that ended
 * while it was up gets nothing.
 *
 * aicc_planning#450 (2.1.3-beta.21, plan block 7): any send-a-prompt button
 * that is not a broadcast button can go to all sessions once, from its
 * right-click menu ("Send to all sessions…"): the same chooser, send path and
 * note, by `oneOffBroadcastBlocker`, the rule below without its Global line.
 * The button's own option does not change.
 *
 * No React and no store here, so the rules are testable on their own.
 */
import type { Session } from '../stores/sessionStore'
import type { CustomCommand } from '../stores/commandStore'
import type { PromptButtonResult, SubmitNotDeliveredReason } from '../../shared/types'
import { sessionCapabilities } from './session-capabilities'
import { PROVIDER_NAMES } from '../provider-names'

/** The option's name in the button's edit dialog. */
export const BROADCAST_OPTION_LABEL = 'Send to every open session'

/** What the pill on a broadcast button says to a tooltip and a screen reader:
 *  a press asks, All or the sessions you pick (#413). */
export const BROADCAST_PILL_LABEL = 'Sends to every open session, or the ones you pick'

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

/** #413: one line of the broadcast chooser's list. */
export interface BroadcastChoice {
  id: string
  /** The tab's name, as the tab strip shows it: its work name, else its config's. */
  name: string
  /** What the session's agent is called on screen (provider-names.ts). */
  agent: string
  /** The host an SSH session runs on, or null for a session on this computer. */
  machine: string | null
}

/** The fields of a session the chooser shows. */
export type BroadcastChoiceSession = BroadcastSession & Partial<Pick<Session, 'label' | 'customName'>>

/**
 * #413: the chooser's list. Of the sessions it listed when it opened
 * (`listed`), those a broadcast still reaches now, in tab order, each once. A
 * session that ends while the chooser is up drops out of it; one opened since
 * is not added, so All answers what the chooser showed. A terminal-only tab,
 * Ask Conductor and an ended tab are never listed (`isBroadcastTarget`).
 */
export function broadcastChoices(sessions: readonly BroadcastChoiceSession[], listed: readonly string[]): BroadcastChoice[] {
  const wanted = new Set(listed)
  const byId = new Map<string, BroadcastChoiceSession>()
  for (const s of sessions) if (s && typeof s.id === 'string' && !byId.has(s.id)) byId.set(s.id, s)
  const choices: BroadcastChoice[] = []
  for (const id of broadcastTargets(sessions)) {
    const s = byId.get(id)
    if (!s || !wanted.has(id)) continue
    const caps = sessionCapabilities(s)
    choices.push({
      id,
      name: s.customName?.trim() || s.label || id,
      agent: caps.agent ? PROVIDER_NAMES[caps.agent] : '',
      machine: caps.mainRunsOn === 'remote' ? (caps.remoteHost || 'SSH') : null,
    })
  }
  return choices
}

/**
 * #413, design point 1 (put to the owner 2026-11-24; built on its default
 * until answered): Choose sessions starts with every listed session ticked,
 * so a pick is "untick the ones to skip". Design point 2 (the same, its
 * default): every press starts here; a button keeps no pick from its last
 * press.
 */
export function chooserStartPick(listed: readonly string[]): string[] {
  return [...listed]
}

/**
 * #413: the sessions a chooser's answer goes to, read at the press: of the
 * ids picked, those a broadcast still reaches now, in tab order, each once.
 * A session that ended, or stopped being an agent tab, while the chooser was
 * up gets nothing.
 */
export function liveBroadcastPick(sessions: readonly BroadcastSession[], picked: readonly string[]): string[] {
  const wanted = new Set(picked)
  return broadcastTargets(sessions).filter((id) => wanted.has(id))
}

/** The fields of a button that decide whether it can go to every session. */
export type BroadcastFields = Pick<CustomCommand, 'scope' | 'kind' | 'target' | 'defaultArgs' | 'lastCustomArgs' | 'hasSecretArg'>

const NOT_A_PROMPT = 'Only a prompt can go to every open session.'
const NOT_GLOBAL = 'Only a Global button can go to every open session.'
const HAS_ARGUMENTS = 'Only a prompt with no arguments can go to every open session.'

/** A prompt for the agent. An old record with no stored kind is one unless
 *  it aims at the partner shell or carries a secret, as layout.ts's
 *  effectiveKind reads it on a Global button, or on any button in an agent
 *  session. */
function isAgentPrompt(cmd: BroadcastFields): boolean {
  const prompt = cmd.kind ? cmd.kind === 'prompt' : !cmd.hasSecretArg
  return prompt && cmd.target !== 'partner'
}

/** Arguments, remembered Ctrl+click arguments, or a secret argument. */
function hasArguments(cmd: BroadcastFields): boolean {
  return !!(cmd.hasSecretArg || cmd.defaultArgs?.length || cmd.lastCustomArgs?.length)
}

/**
 * Why this button cannot go to every open session, in one line for the edit
 * dialog, or null when it can. Only a simple prompt can (#399 Q4): a prompt
 * for the agent (isAgentPrompt), shown on every config's bar, with no
 * arguments, no remembered Ctrl+click arguments and no secret argument.
 */
export function broadcastBlocker(cmd: BroadcastFields): string | null {
  if (!isAgentPrompt(cmd)) return NOT_A_PROMPT
  if (cmd.scope !== 'global') return NOT_GLOBAL
  if (hasArguments(cmd)) return HAS_ARGUMENTS
  return null
}

/**
 * aicc_planning#450 (2.1.3-beta.21, plan block 7): why this button's prompt
 * cannot go to all sessions ONCE, from its right-click menu's "Send to all
 * sessions…", or null when it can. broadcastBlocker without its Global line,
 * so a Session prompt can go too: nothing is stored, and the bar the button
 * shows on does not change. The button's own option is neither read nor
 * changed here.
 */
export function oneOffBroadcastBlocker(cmd: BroadcastFields): string | null {
  if (!isAgentPrompt(cmd)) return NOT_A_PROMPT
  if (hasArguments(cmd)) return HAS_ARGUMENTS
  return null
}

/** Whether a plain press of this button is a broadcast press (it asks, All or
 *  the sessions picked: #413): its option is on and it is a simple prompt. A
 *  record that has the option but is no longer one (hand-edited, say)
 *  presses as a single button. */
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
