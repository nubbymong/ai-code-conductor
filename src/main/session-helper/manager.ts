/**
 * The session helper on This computer (2.1.3-beta.6, plan section B).
 *
 * With Settings, General, "Plain terminals through the session helper" on, a
 * Terminal only tab and a partner terminal start inside a holder of the
 * helper instead of straight under the app, so the terminal outlives an app
 * crash: at the next start the app finds every held terminal, keeps each one
 * alive at once (a holder nobody attaches to ends itself after two minutes),
 * and a restored tab with the same id shows its terminal again, scrollback
 * first. A held terminal no tab shows is listed on the Machines page, where
 * Re-attach opens a tab on it and End ends it. A normal quit ends every one.
 *
 * Off (the default), every terminal starts exactly as before: spawnPlainPty
 * is then node-pty's own spawn with the same arguments. Nothing else here
 * runs then, but for a start's clean-up of old helper copies (2.1.3-beta.15,
 * below).
 * Only a terminal the renderer marks plain (a Terminal only tab, a partner
 * terminal) comes here: SSH sessions and the app's own shell tabs (a sign-in,
 * an install or update command, the first-run install terminal) never do.
 *
 * 2.1.3-beta.7 (plan section A3): a second setting, "... sessions through the
 * session helper" (agentSessionsThroughHelper), off by default, carries the
 * local agent sessions too (each provider's CLI in a tab): spawnAgentPty. The
 * launch is the one the PTY manager builds, unchanged: the same program,
 * arguments, folder and environment, and a typed launch line is still typed.
 * A program that reads one exact Windows command line goes as the launch's
 * `line`, and one on node-pty's bundled ConPTY asks for the helper's copy of
 * it (`conpty`). An agent session is never shown again after a crash: the
 * next start ends it, and its tab resumes the conversation the usual way
 * (plan s11, Q1). Either setting brings the helper up; after a crash, or
 * with an agent session a quit could not end in time, it comes up with both
 * off too, to end what was left held.
 *
 * 2.1.3-beta.8 (plan section B2): an app update on Windows lets go of each
 * held plain or partner terminal whose tab was saved, instead of ending it
 * (releaseForUpdate). Its holder's away clock starts, the running mark stays
 * (saying "update"), and the new version's start takes the crash path: the
 * restored tab shows the terminal again. Agent sessions still ended at an
 * update then (see 2.1.3-beta.14 below), and macOS and Linux keep ending
 * every one. A terminal kept for a
 * tab that no tab took over runs on through the update and is kept again,
 * unless the user discarded the saved sessions (section B3).
 *
 * 2.1.3-beta.8 (plan section A4): a Claude Code session the helper holds sends
 * its hook events through its holder when the holder offers `hooks` (hookRoute):
 * its per-session settings file is switched to the helper's hook mode once the
 * holder launched it and before its launch line is typed, and each event the
 * holder passes on reaches the session signals module under the tab's id.
 * From 2.1.3-beta.14 (S16 step 2) PreToolUse goes that way too.
 *
 * 2.1.3-beta.9 (plan section B1): with the agent sessions' setting on,
 * Insights' Claude Code report runs through the helper too (spawnRunPty): a
 * terminal of the app's own, not a tab's, under the run's own id. It takes the
 * agent sessions' path: a crash's start ends it, Re-attach refuses it, and the
 * Machines page lists it with End. It has no per-session settings file, so its
 * hooks never go through its holder.
 *
 * 2.1.3-beta.11 (plan section B1): given the tool functions for a provider
 * (deps.tools), an agent session's connections ack `mcp`, and each tool
 * stream its holder opens is handed to the tool host under the tab's id
 * (toolRoute).
 *
 * 2.1.3-beta.11 (plan section B2): app-wiring.ts gives them for Claude Code
 * and Codex, so with the agent sessions' setting on, a held session's CLI
 * starts the helper's relay as its Conductor tool server in place of the
 * loopback server: a Claude Code session's MCP config file is switched once
 * its holder launched it and before its launch line is typed, and a Codex
 * session's launch is given the relay form (toolRoute). One that cannot be
 * switched keeps the loopback route, with one log line.
 *
 * 2.1.3-beta.12 (plan section B2): when the link to a switched session's
 * holder drops and the terminal attaches again, the holder gives back the
 * streams it kept (plan section B1). Each is served as a new one is: under
 * the tab's id, for the launch that was switched, and only while the tool
 * host still has the session's record. A stream served on a connection that
 * attached again has one log line.
 *
 * 2.1.3-beta.14 (plan section A1, S16 step 4, aicc_planning#387 with #359):
 * an app update on Windows, with the agent sessions' setting on, lets go of
 * a held agent session of a saved tab too, with its CLI running, when its
 * tool calls (and a Claude Code session's hook events) go through its holder,
 * and records it for the next start; its kill keeps the files its launch
 * wrote (releaseForUpdate). Until the take-over was built (step 5, below),
 * the next start read each record, logged what a take-over would bind,
 * removed the record and those files, and ended the session as before, so
 * nothing a user saw changed. An update that does not start ends it at once
 * (reclaim).
 *
 * 2.1.3-beta.17 (plan section B1, S16 steps 5 and 6, aicc_planning#412): the
 * next start keeps each such session for its restored tab (keptAtStart) when
 * the mark says the last run ended for an update, the agent sessions'
 * setting is on, its provider's take-over is wired (deps.takeOver), its
 * holder's record is in the store and its tab is among the saved sessions;
 * any other is ended as before. The tab's spawn takes it over with no launch
 * (takeOverKept): the terminal is shown again, its replay first, as a plain
 * terminal's is after a crash, and its hook events and tool streams go to
 * this run from the attach. A tool stream given back on that first
 * connection is served with `notifications/tools/list_changed` for a provider
 * whose CLI lists its tools again on it (a tools entry's listsAgain: Claude
 * Code's, probe P20). One no tab takes over within KEPT_TAKE_OVER_WAIT_MS,
 * and one whose tab starts a new CLI instead, is ended. B1c
 * (aicc_planning#423): a restored tab not on screen starts, and takes its
 * session over, only once it is shown, so the limit stops from Resume
 * (restoredTabs) until its tab is shown (tabShown); a closed tab ends its
 * session at once (tabClosed).
 *
 * 2.1.3-beta.14 (plan section B2, aicc_planning#388): an agent session of a
 * provider in deps.screens (app-wiring.ts gives Codex's) asks on its
 * connections for the holder's screen reads with the screen's title, and its
 * terminal hands out the read (HelperPty.screenRead): its composer rule reads
 * the holder's screen, and main opens no pane of its own for it.
 *
 * 2.1.3-beta.15 (plan section B1, aicc_planning#397): a start with both
 * settings off, no running mark and no agent record makes no manager; it
 * removes the old helper copies instead (removeOldCopiesWithHelperOff): the
 * installed helper lists the holders once, and every version or staging
 * folder no listed holder's version needs goes. A manager made later in that
 * run copies only once that has ended (deps.copyAfter).
 */
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { HeldSession, HelperState, MachineActionResult, MachineStatus, MachinesSource, SelfTestResult } from '../../shared/machines'
import { isPartnerPtyId, parentOfPartnerPtyId } from '../../shared/multi-spawn-rule'
import { randomId } from '../../shared/id'
import { PROVIDER_IDS, type ProviderId } from '../../shared/providers/ids'
import { bundledConptyFailed } from '../bundled-conpty'
import { spawnEndingConsoleHost } from '../console-host-end'
import { processGone } from '../process-alive'
import { HolderConnection, type ConnectionOptions } from './connection'
import { HelperPty, NothingStartedError, type HelperPtyDriver, type RedrawWay } from './helper-pty'
import {
  APP_PTY_ID_RE,
  HELPER_FOLDER_RE,
  SID_RE,
  checkLaunch,
  heldAgentSessionId,
  heldIdKind,
  heldSessionId,
  helperOs,
  isAbsoluteFor,
  parseSelfTestResult,
  parseVersionLine,
  readListing,
  readRecord,
  type HelperOs,
  type HolderRecord,
  type HookEventFrame,
  type LaunchSpec,
  type McpMessage,
} from './protocol'
import type { HelperHookTarget, HelperHooksResult } from '../hooks/session-hooks-writer'
import type { HelperMcpConfigResult } from '../hooks/per-session-settings'
import type { HeldToolLaunch, HeldToolLaunchAnswer, HeldToolRelay, ResumePick } from '../providers/types'
import { describeKeptLaunch, holdKeptLaunch, removeKeptLaunch, setKeptLaunchCheck, setKeptTabSignals, setKeptTakeOver } from '../sessions/kept-launches'
import { InstallError, bundledConptySource, checkedConpty, copyMatches, installHelperCopy, removeOldVersionFolders, sha256File, type InstalledHelper } from './install'

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

type SpawnArgs = string[] | string
type SpawnOptions = pty.IPtyForkOptions | pty.IWindowsPtyForkOptions

/** What the PTY manager says of a terminal it starts. `plain`: a Terminal only
 *  tab or a partner terminal, the only ones the helper may carry. */
export interface PlainSpawnContext {
  sessionId: string
  elevated?: boolean
  plain?: boolean
}

/** What the PTY manager says of an agent session it starts: the tab's app PTY
 *  id, and which provider's CLI runs in it. */
export interface AgentSpawnContext {
  sessionId: string
  kind: ProviderId
  /** A run of the app's own (spawnRunPty), not a tab: `sessionId` is the
   *  run's id. It has no per-session settings file, so no hook route. */
  run?: boolean
}

/** What a run of the app's own says of the terminal it starts (2.1.3-beta.9):
 *  the run's id, the same for every run of the same kind and account, and
 *  which provider's CLI runs in it. */
export interface RunSpawnContext {
  runId: string
  kind: ProviderId
}

/** Which terminals the helper carries: the two settings. */
export interface HelperRouting {
  /** "Plain terminals through the session helper". */
  plain: boolean
  /** The agent sessions' setting (agentSessionsThroughHelper). */
  agents: boolean
}

export interface SessionHelperDeps {
  platform?: NodeJS.Platform
  /** The per-user folder (install.ts helperRootDir). */
  root: string
  /** The helper the installer put beside the app. */
  bundled: string
  /** node-pty's `conpty` folder, copied beside the helper (install.ts
   *  bundledConptySource; null: none). Asked once, when the copy is made. */
  conptySource?: () => string | null
  exec?: (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>
  spawnDirect?: (file: string, args: SpawnArgs, opts: SpawnOptions) => IPty
  openStream?: ConnectionOptions['openStream']
  checkEndpointFolder?: ConnectionOptions['checkEndpointFolder']
  /** How long a holder may take to answer a request (tests shorten it). */
  replyTimeoutMs?: number
  newTabId?: () => string
  log?: (message: string) => void
  now?: () => number
  /** The wait between tries to end an agent session's earlier holder (tests shorten it). */
  sleep?: (ms: number) => Promise<void>
  /** Whether no process has this id (process-alive.ts; tests answer for a fake holder). */
  processGone?: (pid: number) => boolean
  /** Agent sessions' hooks through their holders, by provider (app-wiring.ts
   *  gives Claude Code's only). A provider with none keeps its hooks on the
   *  hooks gateway. */
  hooks?: Partial<Record<ProviderId, HelperHookDeps>>
  /** Agent sessions' tool calls through their holders, by provider
   *  (2.1.3-beta.11, plan sections B1 and B2). app-wiring.ts gives Claude
   *  Code's and Codex's. A provider with none keeps its tools on the loopback
   *  route, and its connections ask for no `mcp`. */
  tools?: Partial<Record<ProviderId, HelperToolDeps>>
  /** Agent sessions whose connections ask for the holder's screen reads with
   *  the screen's title, by provider (2.1.3-beta.14, plan section B2,
   *  aicc_planning#388). app-wiring.ts gives Codex's: its composer rule
   *  reads a held session's screen from the holder (HelperPty.screenRead). A
   *  provider with none asks for neither, as before. */
  screens?: Partial<Record<ProviderId, true>>
  /** Providers whose agent session an app update kept running is taken over
   *  by its restored tab at the next start (2.1.3-beta.17, S16 step 5;
   *  app-wiring.ts gives Claude Code's and Codex's). A kept session of any
   *  other is ended at that start, as before. */
  takeOver?: Partial<Record<ProviderId, true>>
  /** The tab ids in the saved file this start restores from (app-wiring.ts
   *  reads it): a kept session whose tab is not among them is not kept for
   *  it. Asked once, only when a kept session would be kept; absent: every
   *  tab counts as restored. */
  savedTabs?: () => ReadonlySet<string>
  /** How long a kept session waits for its tab to take it over (tests shorten it). */
  keptTakeOverWaitMs?: number
  /** The start-up clean-up of old helper copies a start with both settings
   *  off began (2.1.3-beta.15, plan section B1, aicc_planning#397;
   *  app-wiring.ts, removeOldCopiesWithHelperOff): the copy is made only once
   *  it has ended, so it never removes the copy made now. */
  copyAfter?: Promise<unknown>
}

/** What a session's tool calls through its holder need of the app
 *  (2.1.3-beta.11, plan sections B1 and B2). */
export interface HelperToolDeps {
  /** Serve one tool stream the tab's holder opened, for the tab's session
   *  (conductor-mcp-server.ts serveToolStream, which takes the session's CLI
   *  from its own record). It calls the link's take before it returns. False
   *  when it refused the stream: it has closed the link then. `toolsChanged`
   *  (2.1.3-beta.17, S16 step 6): the stream was given back to this run by a
   *  CLI an update kept running, so the CLI is told its tool list may have
   *  changed (`notifications/tools/list_changed`). */
  serve(appPtyId: string, link: HelperToolLink, opts?: { toolsChanged?: boolean }): boolean
  /** The provider's CLI lists its tools again on
   *  `notifications/tools/list_changed` (probe P20 (c): Claude Code does,
   *  Codex does not), so a stream a take-over is given back is served with it. */
  listsAgain?: boolean
  /** Whether the tool host serves tool streams now (the Conductor tools'
   *  server is started). A session is switched to its holder only then. */
  serving(): boolean
  /** Claude Code: point the tab's per-session MCP config at the helper's
   *  relay (per-session-settings.ts switchMcpConfigToHelper), once its holder
   *  launched it and before its launch line is typed. A provider gives this or
   *  relayLaunch; given both, only relayLaunch is used. */
  useRelayConfig?(appPtyId: string, relay: HeldToolRelay): HelperMcpConfigResult
  /** Codex: the launch's arguments with its tool server started as the
   *  helper's relay (the Codex package's heldToolLaunch), asked for the launch
   *  a holder runs only: the usual start keeps the spawn's own arguments. */
  relayLaunch?(appPtyId: string, launch: HeldToolLaunch, relay: HeldToolRelay): HeldToolLaunchAnswer
}

/** One tool stream as the tool host is handed it (conductor-mcp-server.ts
 *  ToolStreamLink). */
export interface HelperToolLink {
  /** One JSON-RPC message to the session's CLI. */
  send(message: McpMessage): void
  /** What takes each message the CLI sends, and what hears the stream end
   *  from the holder's side. Once; a message before it is dropped. */
  take(onMessage: (message: McpMessage) => void, onClose: () => void): void
  /** End the stream from the tool host's side. */
  close(): void
}

/** One tab's tool streams through its holder (toolRoute). */
interface ToolRoute {
  /** The CLI was pointed at its holder: its tool calls go through it. */
  isOn(): boolean
  connected(conn: HolderConnection): void
  /** Its holder took the launch; its launch line is not typed yet. Claude
   *  Code: its config file is switched. Codex: a relay form sent counts. */
  launched?(conn: HolderConnection): void
  /** Codex: what its holder launches, the connection's hello read. */
  launchArgs?(conn: HolderConnection): Pick<LaunchSpec, 'argv' | 'line'> | undefined
}

/** Why a session's tools stay on the loopback route, for its one log line:
 *  what the Claude Code config switch answered. */
const MCP_CONFIG_STAYS_BECAUSE: Record<Exclude<HelperMcpConfigResult, 'switched'>, string> = {
  'no-conductor': 'its MCP config file holds no conductor entry of the app\'s (the built-in tools are off, the tool host was not started when it started, or the file was not written)',
  'unsafe-path': 'the helper\'s path or its store\'s path cannot be written into its MCP config exactly',
  'not-written': 'its MCP config file could not be written',
}

/** The same, for what a Codex launch's relay form answered. */
const RELAY_LAUNCH_STAYS_BECAUSE: Record<Extract<HeldToolLaunchAnswer, { refused: string }>['refused'], string> = {
  'no-tools': 'its launch names no conductor tool server of the app\'s (the built-in tools are off, or the tool host was not started when it was built)',
  'unsafe-path': 'the helper\'s path or its store\'s path cannot be given on its launch exactly',
  'cmd-line': 'its launch is one command line through cmd.exe, or hands its arguments to one (an npm launcher), and the relay\'s arguments cannot pass that line\'s quoting rule',
}

/**
 * One tool stream a holder opened on a connection, as the tool host is handed
 * it: what the tool host sends goes on the stream, and what the relay sends
 * reaches it, until either side ends the stream or the connection goes.
 */
class StreamLink implements HelperToolLink {
  private onMessage: ((message: McpMessage) => void) | null = null
  private onClose: (() => void) | null = null
  private over = false

  constructor(private readonly conn: HolderConnection, private readonly stream: number, private readonly forget: () => void) {}

  send(message: McpMessage): void {
    if (this.over) return
    // One the holder would not read is answered and ends the stream on the
    // connection's side (connection.ts sendMcp): the tool host's side ends too.
    if (this.conn.sendMcp(this.stream, message) === 'refused') this.ended()
  }

  take(onMessage: (message: McpMessage) => void, onClose: () => void): void {
    if (this.over || this.onMessage) return
    this.onMessage = onMessage
    this.onClose = onClose
  }

  close(): void {
    if (this.over) return
    this.over = true
    this.conn.closeMcp(this.stream)
    this.forget()
  }

  /** One message the relay sent on the stream. */
  deliver(message: McpMessage): void {
    if (!this.over) this.onMessage?.(message)
  }

  /** The stream ended from the holder's side, or its connection went. */
  ended(): void {
    if (this.over) return
    this.over = true
    this.conn.closeMcp(this.stream)
    this.forget()
    try { this.onClose?.() } catch { /* the tool host's own */ }
  }
}

/** What a Claude Code session's hooks through its holder need of the app
 *  (2.1.3-beta.8, plan section A4). */
export interface HelperHookDeps {
  /** Whether the app takes hook events now: the hooks gateway is on and
   *  listening (session-signals/hooks.ts helperHooksTaken). A session is
   *  switched to the helper only then. */
  taking(): boolean
  /** Point the tab's per-session settings file at the helper's hook mode, for
   *  every injected event (session-hooks-writer.ts switchHooksToHelper). */
  useHelperHooks(appPtyId: string, target: HelperHookTarget): HelperHooksResult
  /** One hook event the tab's holder passed on (the session signals module). */
  event(appPtyId: string, e: HookEventFrame): void
  /** The tab's session through the helper is over: its hook events with it. */
  ended(appPtyId: string): void
}

/** One Claude Code session's hooks through its holder (hookRoute). */
interface HookRoute {
  /** Its settings file was switched: its hook events go through its holder. */
  isOn(): boolean
  launched(conn: HolderConnection): void
  event(e: HookEventFrame): void
  ended(): void
}

/** Why a session's hooks stay on the gateway, for its one log line. */
const HOOKS_STAY_BECAUSE: Record<Exclude<HelperHooksResult, 'switched'>, string> = {
  'no-gateway-hooks': 'its settings file holds no hooks of the hooks gateway (the gateway was off or not listening when it started, or the file was not written)',
  'unsafe-path': 'the helper\'s path cannot be given to Claude Code\'s hook launcher safely',
  'not-written': 'its settings file could not be written',
}

/** What the Services row shows. */
export interface SessionHelperServiceState {
  state: HelperState
  held: number
  lastError: { message: string; ts: number } | null
}

/** The Machines page's tab target for a Re-attach. */
export type ReattachTab = NonNullable<MachineActionResult['tab']>

export const HELPER_SENTENCES = {
  notInstalled: 'The session helper is not part of this installation.',
  noVersion: 'The installed session helper did not say which version it is.',
  notHeld: 'That terminal is no longer held.',
  alreadyShowing: 'That terminal is already showing in a tab.',
  noAnswer: 'The session helper did not answer.',
  selfTestOff: 'The session helper is off, so there is nothing to test.',
  selfTestUnavailable: 'The session helper cannot run its self-test now.',
  insideJob: 'Windows keeps the session helper inside the app\'s own job here, so a held terminal ends when the app does and does not survive a crash.',
  offNothingToEnd: 'The session helper is off, so it holds no terminal to end.',
  offNothingToReattach: 'The session helper is off, so it holds no terminal to re-attach.',
  agentNotReattached: 'An agent session cannot be re-attached. Its own tab resumes the conversation.',
  updating: 'The app is being updated. Re-attach the terminal once the new version has opened.',
  agentNotCleared: '[The session helper still runs the session this tab had before, and could not end it, so a second one was not started. Restart this tab in a few minutes.]',
  runNotCleared: '[The session helper still runs the terminal this report started before, and could not end it, so a second one was not started. Try again in a few minutes.]',
  /** A take-over whose holder could not be attached (2.1.3-beta.17): its CLI was ended. */
  agentNotTakenOver: '[The session the update kept running could not be shown again here, so it was ended. Restart this tab to resume its conversation.]',
  /** A report's terminal whose holder could no longer be reached (helper-pty.ts LOST_EXIT_CODE). */
  runLost: 'The session helper lost this report\'s terminal. Run the report again.',
} as const

/** What the Machines page calls the terminal of a run of the app's own, by
 *  the first part of the run's id (spawnRunPty). An agent session's tab id
 *  never starts that way: the app makes those of letters and digits alone. */
const RUN_NAMES: Readonly<Record<string, string>> = { insights: 'Insights report' }

function runName(label: string): string | null {
  const first = /^([a-z]+)-/.exec(label)?.[1]
  return first !== undefined && Object.prototype.hasOwnProperty.call(RUN_NAMES, first) ? RUN_NAMES[first] : null
}

/** The Machines page's line while the switch is off and terminals are still
 *  held. `runs` of the `n` are reports of the app's own (2.1.3-beta.9), which
 *  have no tab: they go when the report finishes. */
export function offStillHoldingSentence(n: number, runs = 0): string {
  const one = n === 1
  const until = runs <= 0
    ? (one ? 'its tab closes' : 'their tabs close')
    : runs >= n
      ? (one ? 'its report finishes' : 'their reports finish')
      : 'their tabs close or their reports finish,'
  return `Switched off. It still holds ${one ? '1 terminal' : `${n} terminals`} until ${until} or you end ${one ? 'it' : 'them'} here.`
}

const VERSION_TIMEOUT_MS = 10_000
const HOLD_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 15_000
const SELF_TEST_TIMEOUT_MS = 25_000
/** How much of the self-test's standard-error note goes in the log line. */
const SELF_TEST_NOTE_CHARS = 200
const ENDING_WAIT_MS = 5_000
/** An agent session's earlier holder that did not end when asked is asked
 *  again this often, while the helper still lists it. */
const AGENT_CLEAR_RETRY_MS = 2_000
/** The longest an agent session's start waits for an earlier holder that does
 *  not answer: its away clock (it ends itself that long after the app let go
 *  of it), at most this much, and AGENT_CLEAR_GRACE_MS more. */
const AGENT_CLEAR_AWAY_CAP_MS = 5 * 60_000
const AGENT_CLEAR_GRACE_MS = 10_000
/** A copy that could not be put in place is tried again by a terminal started this long after. */
const INSTALL_RETRY_AFTER_MS = 60_000
/** `hold`'s exit status when a holder for the session runs already (protocol 15). */
const EXIT_ALREADY_RUNNING = 3
const MARKER = 'app-running.json'
const BINDINGS = 'bindings.json'
/** The folder of the records of agent sessions an update kept running (S16 step 4). */
const KEPT = 'kept'
/** How long a start keeps a session an update kept running for its restored
 *  tab to take over (S16 step 5) while no restored tab waits for it unseen:
 *  from the start until Resume restores its tab (the resume prompt left open,
 *  or answered Don't open), and from the moment its tab is first shown (its
 *  launch may wait at its account picker: Settings, Accounts, 'Ask each
 *  time'). Then it is ended. A restored tab not on screen mounts its terminal
 *  only when it is shown (App.tsx renders it with display: none, and
 *  TerminalView starts it once its pane has a size), so between the two its
 *  session is kept with no limit (restoredTabs, aicc_planning#423): until the
 *  tab is shown and takes it over, or is closed. */
const KEPT_TAKE_OVER_WAIT_MS = 5 * 60_000

/**
 * What an app update's release records of an agent session it keeps running
 * (2.1.3-beta.14, plan section A1, S16 step 4), for the next start: the
 * holder's session id, the tab's app id and the provider (the three bound
 * together: the provider's agent id for the tab is the session id), the
 * conversation the session is on, the account it runs on (an opaque id; null
 * for the provider's default account, or not known) and its Codex hook
 * folder. A session with no conversation yet is recorded with none.
 * 2.1.3-beta.17 (S16 step 5): the folder its CLI was launched in, and
 * whether it runs on node-pty's bundled ConPTY, for its take-over; a record
 * an earlier version wrote has no folder (null) and reads as not bundled.
 * `pick` (aicc_planning#419): a launch through the resume list's pick file,
 * its folder as made and the decision read last, for the take-over's watcher.
 */
export interface KeptRecord {
  session: string
  label: string
  provider: ProviderId
  conversation: string | null
  account: string | null
  hookFolder: string | null
  folder: string | null
  bundled?: true
  pick?: ResumePick
  at: number
}

const CONVERSATION_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const ACCOUNT_RE = /^[A-Za-z0-9._:@-]{1,128}$/
const FOLDER_MAX = 1024

/** A folder a kept record names: absolute, at most FOLDER_MAX characters,
 *  with no control character; null otherwise. */
function absoluteFolder(x: unknown): string | null {
  return typeof x === 'string' && x.length <= FOLDER_MAX && path.isAbsolute(x) && !/[\x00-\x1f\x7f]/.test(x) ? x : null
}

/** The folder a kept session's CLI runs in (its launch's cwd, which the
 *  helper was given): read by the rule a launch is checked by for the
 *  helper's system (protocol.ts isAbsoluteFor, as checkLaunch reads it), not
 *  by this process's path rules; otherwise as absoluteFolder. */
function launchFolder(x: unknown, os: HelperOs): string | null {
  return typeof x === 'string' && x.length <= FOLDER_MAX && isAbsoluteFor(x, os) && !/[\x00-\x1f\x7f]/.test(x) ? x : null
}

/** A kept record's pick (aicc_planning#419): an absolute file named
 *  pick.json and its folder's identity (device and file id, real path), with
 *  the decision read last when it reads; null when it does not read. */
function keptPickOf(x: unknown): ResumePick | null {
  const p = x && typeof x === 'object' ? x as Record<string, unknown> : {}
  const f = p.folder && typeof p.folder === 'object' ? p.folder as Record<string, unknown> : {}
  const d = p.decided && typeof p.decided === 'object' ? p.decided as Record<string, unknown> : {}
  const file = absoluteFolder(p.file)
  const real = absoluteFolder(f.real)
  if (!file || path.basename(file) !== 'pick.json' || typeof f.id !== 'string' || !/^\d{1,40}:\d{1,40}$/.test(f.id) || !real) return null
  const decided = typeof d.id === 'string' && CONVERSATION_RE.test(d.id) ? { id: d.id } : typeof d.fresh === 'number' && Number.isFinite(d.fresh) ? { fresh: d.fresh } : null
  return { file, folder: { id: f.id, real }, ...(decided ? { decided } : {}) }
}

/** A kept record read strictly, from its file under the name `sid`: null
 *  when its id, tab and provider are not one agent session of this app's. A
 *  conversation, an account, a hook folder, a launch folder or a pick that
 *  does not read is none. `os`: the helper's system, for the launch folder. */
function keptRecordOf(v: unknown, sid: string, os: HelperOs): KeptRecord | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (r.v !== 1 || r.session !== sid || heldIdKind(sid) !== 'agent') return null
  const label = r.label
  if (typeof label !== 'string' || !APP_PTY_ID_RE.test(label)) return null
  const provider = PROVIDER_IDS.find((p) => heldAgentSessionId(label, p) === sid)
  if (provider === undefined || r.provider !== provider) return null
  const text = (x: unknown, re: RegExp): string | null => (typeof x === 'string' && re.test(x) ? x : null)
  const pick = keptPickOf(r.pick)
  return {
    session: sid,
    label,
    provider,
    conversation: text(r.conversation, CONVERSATION_RE),
    account: text(r.account, ACCOUNT_RE),
    hookFolder: absoluteFolder(r.hookFolder),
    folder: launchFolder(r.folder, os),
    ...(r.bundled === true ? { bundled: true as const } : {}),
    ...(pick ? { pick } : {}),
    at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
  }
}

/** The kept records in the helper's folder, by session id; null for one that
 *  does not read. No holder is asked. `os`: the helper's system (helperOs). */
function readKeptStore(root: string, os: HelperOs = helperOs()): Array<{ sid: string; record: KeptRecord | null }> {
  const dir = path.join(root, KEPT)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: Array<{ sid: string; record: KeptRecord | null }> = []
  for (const name of names.sort()) {
    const m = /^(.+)\.json$/.exec(name)
    if (!m || !SID_RE.test(m[1])) continue
    let record: KeptRecord | null = null
    try { record = keptRecordOf(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')), m[1], os) } catch { /* below */ }
    out.push({ sid: m[1], record })
  }
  return out
}

/** What a kept session's record says it is on, for its log lines: the hook
 *  folder by its name alone. */
function keptBindsText(r: KeptRecord): string {
  return `conversation ${r.conversation ?? 'none'}, account ${r.account ?? 'default'}, hook folder ${r.hookFolder ? path.basename(r.hookFolder) : 'none'}`
}

/** The variables a helper command gets: what the system itself needs to run
 *  a program, nothing of the app's own. A launched terminal gets its full
 *  environment in the launch frame, never from here. No home folder either:
 *  every folder the helper uses is named on its command line. */
const HELPER_ENV_NAMES = ['SystemRoot', 'SYSTEMROOT', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'TMPDIR', 'LOCALAPPDATA', 'PATH', 'Path', 'LANG', 'LC_ALL', 'USER', 'LOGNAME']

function helperEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of HELPER_ENV_NAMES) {
    const v = process.env[name]
    if (typeof v === 'string' && !Object.keys(env).some((k) => k.toLowerCase() === name.toLowerCase())) env[name] = v
  }
  return env
}

function execHelper(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: helperEnv(), encoding: 'utf8' }, (err, stdout, stderr) => {
      const raw = (err as { code?: unknown } | null)?.code
      resolve({ code: err ? (typeof raw === 'number' ? raw : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** node-pty's spawn, the one place this module starts a terminal the usual
 *  way: on the ConPTY built into Windows its console host is ended once its
 *  program has ended (aicc_planning #363, console-host-end.ts). */
function spawnWithNodePty(file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
  return spawnEndingConsoleHost(opts, () => pty.spawn(file, args, opts))
}

const lastLine = (s: string): string => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? ''
const firstLine = (s: string): string => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class SessionHelperManager implements MachinesSource {
  private readonly os: HelperOs
  private readonly root: string
  private readonly store: string
  private readonly deps: Required<Pick<SessionHelperDeps, 'exec' | 'spawnDirect' | 'newTabId' | 'log' | 'now' | 'conptySource' | 'sleep' | 'processGone'>> & SessionHelperDeps

  /** Plain terminals go through the helper (the first setting). */
  private plainOn = false
  /** Agent sessions go through the helper (the second setting). */
  private agentsOn = false
  private started = false
  /** This run began after a crash: what the store holds is kept, not ended. */
  private afterCrash = false
  /** A normal quit has begun: nothing new is held or kept. */
  private quitting = false
  /** An app update let go of the held terminals (releaseForUpdate): nothing
   *  new is held until reclaim() says the update did not go ahead. */
  private updating = false
  /** The terminals releaseForUpdate let go of, by session id. `kept`: an
   *  agent session's, with what its release recorded (S16 step 4). */
  private readonly released = new Map<string, { record: HolderRecord; pty: HelperPty; kept?: KeptRecord }>()
  /** Agent sessions the last run's update kept running that this start keeps
   *  for their restored tabs to take over (S16 step 5), by session id: what
   *  the release recorded, the holder's record, and the time limit (null
   *  while its tab is restored and not yet shown, aicc_planning#423).
   *  `shown`: its tab was shown. */
  private readonly keptForTabs = new Map<string, { kept: KeptRecord; record: HolderRecord; timer: ReturnType<typeof setTimeout> | null; shown?: true }>()
  /** An agent session's routes, by its terminal: what an update asks before
   *  it keeps one running (releaseForUpdate). */
  private readonly agentRoutes = new WeakMap<HelperPty, { kind: ProviderId; tools: ToolRoute; hooks?: HookRoute }>()
  /** What reclaim() kept after an update that did not start, while no tab
   *  has taken it over again: its tab's terminal read as ended. */
  private readonly reclaimed = new Map<string, HolderRecord>()
  /** Settles once the ends the last releaseForUpdate sent were answered. */
  private updateEnds: Promise<void> = Promise.resolve()
  private state: HelperState = 'off'
  private detail: string | undefined
  private version: string | undefined
  private selfTest: SelfTestResult | undefined
  private lastError: { message: string; ts: number } | null = null
  private info: InstalledHelper | null = null
  private installing: Promise<InstalledHelper | null> | null = null
  /** When a copy that could not be put in place may be tried again; null: not that failure. */
  private installRetryAt: number | null = null
  /** One copy made again at a time: every caller that found a mismatch waits for it. */
  private recopying: Promise<InstalledHelper> | null = null
  /** `hold` said Windows keeps its holders inside the app's job (no crash survival). */
  private insideJob = false
  /** Held terminals a tab may take over: left by a crash, or named by Re-attach. */
  private readonly adoptable = new Map<string, HolderRecord>()
  /** Connections that keep a crash's held terminals alive until a tab takes them. */
  private readonly keepers = new Map<string, { record: HolderRecord; conn?: HolderConnection; ready: Promise<void> }>()
  /** The app's terminals through the helper, by session id. */
  private readonly live = new Map<string, HelperPty>()
  private readonly endings = new Map<string, Promise<void>>()
  /** Agent session ids whose earlier holder is being ended (clearAgent): true
   *  once it is gone. `after` is the end of this run's own terminal of that id
   *  the clear waited for, if any. */
  private readonly agentClears = new Map<string, { done: Promise<boolean>; after: Promise<void> | undefined }>()
  /** Agent session ids whose earlier holder could not be ended: the next start asks again. */
  private readonly agentsNotCleared = new Set<string>()
  /** A tab Re-attach opened, by its app id, and the held terminal it shows. */
  private readonly bindings = new Map<string, string>()
  /** The tabs the app last saved, by id, with their names. */
  private readonly savedTabs = new Map<string, string>()
  private listing: HolderRecord[] = []
  private changeListener: (() => void) | null = null

  constructor(deps: SessionHelperDeps) {
    this.os = helperOs(deps.platform)
    this.root = deps.root
    this.store = path.join(deps.root, 'store')
    this.deps = {
      exec: execHelper,
      spawnDirect: spawnWithNodePty,
      newTabId: () => randomId(),
      log: () => { /* silent */ },
      now: () => Date.now(),
      conptySource: () => bundledConptySource({ platform: deps.platform }),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      processGone,
      ...deps,
    }
  }

  /** On: either setting is. */
  private get enabled(): boolean {
    return this.plainOn || this.agentsOn
  }

  onChange(listener: (() => void) | null): void {
    this.changeListener = listener
  }

  private changed(): void {
    try { this.changeListener?.() } catch { /* the listener's own */ }
  }

  /** True while either setting is on. */
  isEnabled(): boolean {
    return this.enabled
  }

  /** True while a new plain terminal goes through the helper. */
  routesPlain(): boolean {
    return this.plainOn && !this.quitting && !this.updating
  }

  /** True while a new agent session goes through the helper. */
  routesAgents(): boolean {
    return this.agentsOn && !this.quitting && !this.updating
  }

  /** True when a held terminal waits for the tab with this app id. */
  holdsFor(appPtyId: string): boolean {
    return this.adoptable.has(this.sidFor(appPtyId))
  }

  /** True while a holder this agent session had may still run (one a crash
   *  left, this run's own, being ended or not ended, or one an update keeps
   *  running): its next start waits for that end, and starts nothing while it
   *  is not confirmed. */
  endingFor(ctx: AgentSpawnContext): boolean {
    if (!APP_PTY_ID_RE.test(ctx.sessionId)) return false
    const sid = heldAgentSessionId(ctx.sessionId, ctx.kind)
    // One an update keeps running (S16 step 4) still runs its CLI too, and so
    // does one this start keeps for its tab to take over (S16 step 5).
    return this.endings.has(sid) || this.agentClears.has(sid) || this.agentsNotCleared.has(sid) || this.released.get(sid)?.kept !== undefined || this.keptForTabs.has(sid)
  }

  /**
   * Switch on (at start-up, or when a setting is turned on), with which
   * terminals the helper carries: plain terminals unless `plain` is false,
   * agent sessions only when `agents` is true. Both false is a start with
   * both settings off that still has something to deal with: a crash's held
   * terminals, or agent sessions a quit could not end in time. Nothing new
   * is carried then. What runs synchronously decides, before any tab can
   * ask, which held terminals a restored tab takes over and which agent
   * sessions are ended, so a tab restored at once already waits for that
   * end; the copy, the listing and the self-test follow. The answer settles
   * once all of those have, the self-test included (it reads and runs the
   * copy): the app does not wait for it, a test's teardown does.
   *
   * With both settings off after a crash, a plain terminal the crash left
   * held is still kept for its tab, as one is when its setting is switched
   * off during a run: only agent sessions are ended (plan s11, Q1).
   */
  start(opts: { atStartup: boolean; plain?: boolean; agents?: boolean }): Promise<void> {
    this.plainOn = opts.plain ?? true
    this.agentsOn = opts.agents ?? false
    if (this.started) {
      if (this.state === 'starting') {
        this.changed()
        return Promise.resolve()
      }
      if (this.info) {
        // Set up already. One that failed its own self-test is tested again,
        // and this start settles once that test has.
        const tested = this.state === 'failed' ? this.selfTestSettled() : Promise.resolve()
        this.changed()
        return tested
      }
      // A helper that could not be set up is tried again.
      this.installing = null
      this.installRetryAt = null
      this.state = 'starting'
      this.detail = undefined
      this.changed()
      return this.bringUp(this.afterCrash)
    }
    this.started = true
    this.state = 'starting'
    let crashed = false
    let updated = false
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
      const marker = path.join(this.root, MARKER)
      crashed = opts.atStartup && fs.existsSync(marker)
      // An update's mark takes the same path; only the log line differs.
      if (crashed) updated = markReason(marker) === 'update'
      this.writeMarker()
    } catch (err) {
      this.deps.log(`[session-helper] the helper folder could not be prepared: ${message(err)}`)
    }
    this.afterCrash = crashed
    // What the last run's update kept running (S16 steps 4 and 5): each one
    // its restored tab can take over is kept for it, now, before any tab
    // starts; any other is logged and what it left on disk goes now, and the
    // session is ended below with every other agent session in the store.
    this.keptAtStart(crashed && updated)
    if (crashed) {
      this.loadBindings()
      // Kept at once, before the copy and the listing: each record's own hello
      // proves its holder, and a slow listing cannot use up the two minutes.
      // An agent session is ended at once instead (plan s11, Q1): its hooks
      // and tools were this run's alone, so its tab resumes the conversation.
      // One an update kept running is ended too, unless it was kept above for
      // its tab to take over (S16 step 5).
      let agents = 0
      for (const r of this.readStoreRecords()) {
        if (heldIdKind(r.session) === 'agent') {
          if (this.keptForTabs.has(r.session)) continue
          agents++
          void this.clearAgent(r.session, r)
          continue
        }
        this.adoptable.set(r.session, r)
        this.keep(r)
      }
      const forTabs = this.keptForTabs.size
      this.deps.log(`[session-helper] ${updated ? 'the app was updated' : 'the app did not quit normally'}; ${this.adoptable.size} held terminal(s) may be shown again, ${forTabs > 0 ? `${forTabs} agent session(s) are kept for their tabs to take over, ` : ''}and ${agents} agent session(s) it held are ended`)
    } else {
      this.saveBindings()
      // An agent session a normal quit could not end in time (its end was
      // sent, its answer not waited for): ended now, before its tab, restored
      // at once, starts its CLI again. Plain ones wait for the listing.
      const agents = this.readStoreRecords().filter((r) => heldIdKind(r.session) === 'agent')
      for (const r of agents) void this.clearAgent(r.session, r)
      if (agents.length > 0) this.deps.log(`[session-helper] ${agents.length} agent session(s) the last quit left held are ended`)
    }
    this.changed()
    return this.bringUp(crashed)
  }

  /** A setting changed while the helper is on: which terminals it carries from now on. */
  setRouting(routing: HelperRouting): void {
    this.plainOn = routing.plain
    this.agentsOn = routing.agents
    this.changed()
  }

  /** Switch off: new terminals start the usual way. Terminals already through
   *  the helper keep running until their tabs close, and a held terminal a
   *  restored tab comes back to is still shown again. */
  stopRouting(): void {
    this.setRouting({ plain: false, agents: false })
  }

  private async bringUp(crashed: boolean): Promise<void> {
    const info = await this.installed()
    // A quit that began meanwhile has ended everything: nothing more to bring up.
    if (!info || this.quitting) return
    let records: HolderRecord[] = []
    let listed = false
    try {
      records = await this.list()
      listed = true
    } catch (err) {
      this.deps.log(`[session-helper] the held terminals could not be listed: ${message(err)}`)
    }
    if (this.quitting) return
    if (crashed) {
      // Every held terminal at once: a holder nobody attaches to ends itself
      // two minutes after the app went. The keepers started from the store's
      // records stand; the listing adds any the store read missed. A record
      // whose holder is gone drops out when its keeper cannot reach it. An
      // agent session the store read missed is ended, as at the start; one a
      // tab of this run holds by now is that tab's.
      for (const r of records) {
        // One an update let go of meanwhile is the next version's to keep,
        // and one kept for its tab to take over (S16 step 5) is that tab's.
        if (this.live.has(r.session) || this.keepers.has(r.session) || this.endings.has(r.session) || this.agentClears.has(r.session) || this.released.has(r.session) || this.keptForTabs.has(r.session)) continue
        if (heldIdKind(r.session) === 'agent') { void this.clearAgent(r.session, r); continue }
        this.adoptable.set(r.session, r)
        this.keep(r)
      }
      if (listed) {
        const held = new Set([...records.map((r) => r.session), ...this.adoptable.keys(), ...this.live.keys()])
        for (const [appId, sid] of [...this.bindings]) if (!held.has(sid)) this.bindings.delete(appId)
        this.saveBindings()
      }
    } else {
      // Left by a normal quit that could not end them: ended now. A terminal
      // this run holds or keeps for a tab is not one of those.
      // An agent session's goes through clearAgent, not waited for here, so
      // its tab's next start waits for it: start() began that for each one
      // the store read found, and the listing adds any it missed. One an
      // update let go of while the listing ran is not one of those either.
      const left = records.filter((r) => !this.live.has(r.session) && !this.keepers.has(r.session) && !this.adoptable.has(r.session) && !this.released.has(r.session))
      for (const r of left) if (heldIdKind(r.session) === 'agent' && !this.agentClears.has(r.session)) void this.clearAgent(r.session, r)
      await Promise.allSettled(left.filter((r) => heldIdKind(r.session) !== 'agent').map((r) => this.endRecord(r)))
    }
    if (!this.info) return
    this.state = 'ready'
    this.changed()
    // Beside the clean-up below, and waited for at the end: the self-test
    // reads the copy (its hash) and runs it, so the self-test this start began
    // no longer has the copy open once the start settles (CI run 45341253799).
    const selfTest = this.selfTestSettled()
    // Every folder of a version a listed or live holder reports is kept, the
    // current version's other builds included (#322); every other old folder
    // goes (see removeOldVersionFolders).
    const heldVersions = new Set([...this.listing, ...this.heldRecords()].map((r) => r.helper))
    const removed = await removeOldVersionFolders(this.root, info.folder, heldVersions)
    if (removed.length > 0) this.deps.log(`[session-helper] removed old helper folder(s): ${removed.join(', ')}`)
    await selfTest
  }

  /** A self-test begun on the app's own account (not asked for from the
   *  Machines page): settles once it has, never failing (runSelfTest records
   *  its result). */
  private selfTestSettled(): Promise<void> {
    return this.runSelfTest().then(() => undefined, () => undefined)
  }

  /** The helper's copy, put in place once. Null when it cannot be used. */
  private installed(): Promise<InstalledHelper | null> {
    if (!this.installing) this.installing = this.install()
    return this.installing
  }

  private async install(): Promise<InstalledHelper | null> {
    const { bundled } = this.deps
    // A start-up clean-up of old copies still running (deps.copyAfter) ends first.
    if (this.deps.copyAfter) await this.deps.copyAfter.catch(() => undefined)
    try {
      if (!fs.statSync(bundled).isFile()) throw new Error('not a file')
    } catch {
      this.fail(HELPER_SENTENCES.notInstalled, 'not-installed')
      return null
    }
    try {
      const sha256 = await sha256File(bundled)
      const v = await this.deps.exec(bundled, ['version'], VERSION_TIMEOUT_MS)
      const version = v.code === 0 ? parseVersionLine(v.stdout) : null
      if (!version) throw new InstallError(HELPER_SENTENCES.noVersion)
      this.version = version
      // No copy is made once a quit began.
      if (this.quitting) return null
      // node-pty's bundled ConPTY goes beside the copy too (Windows), for an
      // agent session that runs on it; missing, only that is unavailable.
      this.info = await installHelperCopy({ bundled, root: this.root, version, sha256, platform: this.deps.platform, conptySource: this.deps.conptySource() })
      this.installRetryAt = null
      this.deps.log(`[session-helper] helper ${version} ready in ${this.info.folder}`)
      return this.info
    } catch (err) {
      this.fail(err instanceof InstallError ? err.message : `The session helper could not be set up: ${message(err)}`, 'failed', err)
      return null
    }
  }

  private fail(detail: string, state: HelperState = 'failed', cause?: unknown): void {
    this.state = state
    this.detail = detail
    this.info = null
    // A copy that could not be put in place (a file another program still
    // had open) is tried again by a later terminal.
    this.installRetryAt = cause instanceof InstallError && cause.kind === 'copy' ? this.deps.now() + INSTALL_RETRY_AFTER_MS : null
    this.lastError = { message: detail, ts: this.deps.now() }
    this.deps.log(`[session-helper] ${detail}`)
    this.changed()
  }

  /** A later terminal tries again a copy that could not be put in place. */
  private retryInstallIfDue(): void {
    if (this.state !== 'failed' || this.info || this.installRetryAt === null || this.quitting) return
    if (this.deps.now() < this.installRetryAt) return
    this.deps.log('[session-helper] trying the helper copy again')
    this.installRetryAt = null
    this.installing = null
    this.state = 'starting'
    this.detail = undefined
    this.changed()
    void this.bringUp(this.afterCrash)
  }

  /**
   * The copy holders run from, checked against the installed helper before
   * every use. A copy that no longer matches is made again once; a second
   * mismatch, or a copy that fails, leaves the helper failed and nothing is
   * started through it.
   */
  private async checkedExe(): Promise<string> {
    const info = await this.installed()
    const now = this.info
    if (!info || !now) throw new Error(this.detail ?? HELPER_SENTENCES.notInstalled)
    if (await copyMatches(now.exe, now.sha256)) return now.exe
    if (this.quitting) throw new Error('The app is quitting.')
    if (!this.recopying) {
      this.deps.log('[session-helper] the helper copy does not match the installed helper; copying it again')
      // The whole version folder is made again, the bundled ConPTY's copy in
      // it too: from the same node-pty folder the first copy was asked for.
      const again = installHelperCopy({ bundled: this.deps.bundled, root: this.root, version: now.version, sha256: now.sha256, platform: this.deps.platform, conptySource: now.conptySource })
      this.recopying = again
      void again.catch(() => { /* answered below */ }).finally(() => { if (this.recopying === again) this.recopying = null })
    }
    try {
      this.info = await this.recopying
      return this.info.exe
    } catch (err) {
      if (this.info) this.fail(err instanceof InstallError ? err.message : message(err), 'failed', err)
      throw err
    }
  }

  // ── terminals ──────────────────────────────────────────────────────────────

  /** The held session id for an app PTY id. A terminal Re-attach moved to a
   *  new tab stays with that tab: its first tab then gets a session of its own,
   *  derived from where that one went, and derived again while the one it
   *  derives is bound to another tab too (a terminal moved, then its
   *  replacement moved as well). Never an id another tab is bound to: a
   *  terminal started under one would end that tab's held terminal. */
  sidFor(appPtyId: string): string {
    const bound = this.bindings.get(appPtyId)
    if (bound) return bound
    let seed = appPtyId
    let sid = heldSessionId(seed)
    // Each seed is new, so each id tried is new, and each one found taken is
    // the id of a different binding: one try more than there are bindings
    // always finds a free one.
    for (let i = 0; i <= this.bindings.size; i++) {
      let other: string | undefined
      for (const [o, s] of this.bindings) if (s === sid && o !== appPtyId) { other = o; break }
      if (other === undefined) return sid
      seed = `${seed}/after/${other}`
      sid = heldSessionId(seed)
    }
    // Only when two seeds hash alike: an id no binding has.
    this.deps.log(`[session-helper] ${appPtyId}: every id derived for this tab is bound to another tab; it gets a new one`)
    return heldSessionId(`${seed}/after/${randomId()}`)
  }

  /**
   * A plain or partner terminal: through a holder when the plain terminals'
   * setting is on and the helper can carry it, else node-pty's spawn with
   * these same arguments.
   * A held terminal waiting for this tab is shown again whatever the state:
   * taking it over runs no copy of the helper and launches nothing.
   */
  spawn(ctx: PlainSpawnContext, file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
    const direct = () => this.deps.spawnDirect(file, args, opts)
    if (ctx.plain !== true || typeof args === 'string' || !APP_PTY_ID_RE.test(ctx.sessionId)) return direct()
    const sid = this.sidFor(ctx.sessionId)
    // While an update goes on nothing is taken over either: the kill that
    // follows would end it, and the next version shows it again.
    const adopt = this.quitting || this.updating || this.live.has(sid) ? undefined : this.adoptable.get(sid)
    if (adopt) {
      this.adoptable.delete(sid)
      this.reclaimed.delete(sid)
      this.pinOwnId(ctx.sessionId, sid)
      const held = this.launchSpec(file, args, opts)
      return this.track(new HelperPty({ sid, label: ctx.sessionId, spec: held, adopt, driver: this.plainDriver(direct, false), redraw: this.redrawFor(held) }), ctx.sessionId)
    }
    if (!this.routesPlain()) return direct()
    this.retryInstallIfDue()
    if (this.state !== 'starting' && this.state !== 'ready') return direct()
    // An elevated tab runs its shell under gsudo or sudo, which ask for a
    // password at their own console: left the usual way, also when only the
    // program says so.
    if (ctx.elevated || /^g?sudo(\.exe)?$/i.test(file.split(/[\\/]/).pop() ?? '')) return direct()
    const spec = this.launchSpec(file, args, opts)
    const refused = checkLaunch(spec, this.os)
    if (refused) {
      this.deps.log(`[session-helper] ${ctx.sessionId}: started the usual way, because the helper would refuse ${refused.why}`)
      return direct()
    }
    this.pinOwnId(ctx.sessionId, sid)
    return this.track(new HelperPty({ sid, label: ctx.sessionId, spec, driver: this.plainDriver(direct, true), redraw: this.redrawFor(spec) }), ctx.sessionId)
  }

  /**
   * How a terminal's program is asked to redraw after a replay from the
   * middle of its output (helper-pty.ts, redrawOnce): one resize at the tab's
   * own size on the console built into Windows, which draws its whole screen
   * again on any resize (probe P19) and so moves no row under a shell at its
   * prompt; one row shorter and back on node-pty's bundled ConPTY, macOS and
   * Linux, where a resize to the same size redraws nothing (2.1.3-beta.13,
   * plan section A4).
   */
  private redrawFor(spec: LaunchSpec): RedrawWay {
    return this.os === 'windows' && spec.conpty !== 'bundled' ? 'same-size' : 'nudge'
  }

  /**
   * A tab whose first terminal Re-attach moved to another tab runs under an
   * id of its own, derived from that other tab (sidFor). It is kept as this
   * tab's binding once a terminal runs under it, so moving that first
   * terminal again later does not change it, and the tab still finds its
   * own held terminal. The binding goes when the terminal ends (track),
   * unless an update let it go or a newer terminal of this tab runs under
   * the id.
   */
  private pinOwnId(appPtyId: string, sid: string): void {
    if (sid === heldSessionId(appPtyId) || this.bindings.get(appPtyId) === sid) return
    this.bindings.set(appPtyId, sid)
    this.saveBindings()
  }

  /**
   * An agent session (a provider's CLI in a local tab): through a holder when
   * its setting is on and the helper can carry this launch, else node-pty's
   * spawn with these same arguments. Never a take-over here: a held agent
   * session a crash left is ended, not shown again (plan s11, Q1), and one
   * an update kept running is taken over by takeOverKept, which runs no
   * launch. Either way, while
   * a holder this tab had may still run its CLI (a crash's, a Restart's, one
   * that did not end when asked), it starts only once that holder is gone
   * (clearAgent), so two CLIs never run on one conversation. When that cannot
   * be confirmed, it starts nothing, and the tab says why.
   */
  spawnAgent(ctx: AgentSpawnContext, file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
    if (!APP_PTY_ID_RE.test(ctx.sessionId)) return this.deps.spawnDirect(file, args, opts)
    const sid = heldAgentSessionId(ctx.sessionId, ctx.kind)
    // Its tab started again while an update keeps its session running (S16
    // step 4): that session is no longer kept. Its record and what it left on
    // disk go now, before this launch writes its own, and it is ended before
    // this one starts (clearAgent): never two CLIs on one conversation.
    const keptNow = this.released.get(sid)
    if (keptNow?.kept) {
      this.released.delete(sid)
      this.forgetKept(keptNow.kept)
      this.deps.log(`[session-helper] ${sid}: its tab started again during the update, so the session the update kept running is ended first`)
      void this.clearAgent(sid, keptNow.record)
    }
    // Its tab starts a new CLI while this start keeps the last run's for it to
    // take over (S16 step 5): that one is ended first, the same way.
    if (this.keptForTabs.has(sid)) this.endKeptForTab(sid, 'its tab started a new CLI instead of taking it over')
    const spec = this.agentSpec(file, args, opts)
    const usual = this.usualStart(file, args, opts, ctx.sessionId)
    // Set when the earlier holder could not be ended: then the usual way
    // starts nothing either, and the tab (or the run) reads why.
    let notCleared = false
    const direct = (): IPty => (notCleared ? notStartedPty(ctx.run ? HELPER_SENTENCES.runNotCleared : HELPER_SENTENCES.agentNotCleared, opts) : usual())
    // What the log calls the one that starts: a tab, or a run of the app's own.
    const whose = ctx.run ? 'this report' : 'this tab'
    // A run ends its own way (Insights' report: report.html written, or its
    // time limit), and node-pty never ended it for a failing output: on a
    // fallback path its terminal is not ended for one either (helper-pty.ts).
    const own: Partial<HelperPtyDriver> = ctx.run ? { endsOnIoFailure: false } : {}
    const cleared = async (): Promise<void> => {
      if (await this.clearAgent(sid)) return
      notCleared = true
      throw new NothingStartedError(`the holder ${whose} had before is still running and could not be ended`)
    }
    const usualWay = (why: string, said: boolean): IPty => {
      if (!this.endingFor(ctx)) {
        if (said) this.deps.log(`[session-helper] ${ctx.sessionId}: started the usual way, because ${why}`)
        return this.deps.spawnDirect(file, args, opts)
      }
      // Not through the helper, but only once that holder is gone: a terminal
      // whose hold waits for it and then hands over to the usual start (none
      // when the tab ended it meanwhile).
      const driver: HelperPtyDriver = {
        ...this.driver(direct, false, false),
        ...own,
        hold: async (_sid, _label, abandoned) => {
          await cleared()
          if (abandoned()) throw new NothingStartedError('it was ended before it started')
          throw new Error(`${why}; it waited for the end of ${whose}'s earlier holder first`)
        },
      }
      return new HelperPty({ sid, label: ctx.sessionId, spec, driver, redraw: this.redrawFor(spec) })
    }
    if (!this.routesAgents()) return usualWay('agent sessions do not go through the session helper now', false)
    this.retryInstallIfDue()
    // A run says so in the log; a tab's session does not (as before).
    if (this.state !== 'starting' && this.state !== 'ready') return usualWay(`the session helper is ${this.state}`, ctx.run === true)
    const refused = checkLaunch(spec, this.os)
    if (refused) return usualWay(`the helper would refuse ${refused.why}`, true)
    const hooks = this.hookRoute(ctx, sid)
    const tools = this.toolRoute(ctx, sid, { file, args, opts })
    // B2: a provider whose composer rule reads its held session's screen from
    // the holder asks for the screen reads and their title.
    const screen = this.deps.screens?.[ctx.kind] === true
    const driver: HelperPtyDriver = { ...this.driver(direct, true, spec.conpty === 'bundled', cleared, hooks, tools, screen, screen), ...own }
    const wrapper = this.track(new HelperPty({ sid, label: ctx.sessionId, spec, driver, redraw: this.redrawFor(spec) }), ctx.sessionId)
    if (hooks) void wrapper.ended.then(() => hooks.ended())
    if (tools) this.agentRoutes.set(wrapper, { kind: ctx.kind, tools, ...(hooks ? { hooks } : {}) })
    return wrapper
  }

  /**
   * A terminal of a run of the app's own (2.1.3-beta.9, plan section B1:
   * Insights' Claude Code report): an agent session under the run's own id
   * (heldAgentSessionId of the run id), so everything spawnAgent does holds
   * for it. A crash's start ends it and never shows it again, Re-attach
   * refuses it, and while an earlier holder of the same run may still run, it
   * starts only once that one is gone. No hook route: a run has no per-session
   * settings file. A run id no holder can carry as its label starts the usual
   * way, with one log line.
   */
  spawnRun(ctx: RunSpawnContext, file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
    if (!APP_PTY_ID_RE.test(ctx.runId)) {
      this.deps.log('[session-helper] a run started the usual way, because its id cannot be the label of a holder')
      return this.deps.spawnDirect(file, args, opts)
    }
    return this.spawnAgent({ sessionId: ctx.runId, kind: ctx.kind, run: true }, file, args, opts)
  }

  /**
   * 2.1.3-beta.17 (plan section B1, S16 step 5, aicc_planning#412): the
   * restored tab of an agent session the last run's update kept running takes
   * that session over, with no launch: nothing is held, launched or typed. Its
   * holder's terminal is shown in the tab again, its replay first, as a plain
   * terminal's is after a crash (the holder's size read first, the replay's
   * terminal queries not answered again, a redraw after a replay from the
   * middle). Its hook events and its tool streams go to this run from the
   * attach: the run that launched it switched both to its holder, which is
   * why its update kept it. A tool stream given back on that first
   * connection is served with `notifications/tools/list_changed` when its
   * provider's CLI lists its tools again (listsAgain, S16 step 6). The
   * record goes now; what its launch put on disk is the session's again, and
   * goes at its end as a launch's does. A take-over whose holder cannot be
   * attached ends its CLI, and the tab says to restart it. Null when no
   * session waits for this tab (it starts its CLI the usual way), and while
   * the app quits or updates. `account` (a Codex launch's lease, or the
   * account a Claude Code launch names): the account the tab's launch is
   * prepared on; a kept session on another one is not taken over, so the
   * launch goes on and ends it first (spawnAgent).
   */
  takeOverKept(ctx: AgentSpawnContext, size: { cols: number; rows: number }, account?: string | null): { pty: HelperPty; kept: KeptRecord } | null {
    if (ctx.run || !APP_PTY_ID_RE.test(ctx.sessionId)) return null
    const sid = heldAgentSessionId(ctx.sessionId, ctx.kind)
    const entry = this.keptForTabs.get(sid)
    if (!entry || this.quitting || this.updating || this.live.has(sid)) return null
    if (account !== undefined && entry.kept.account !== account) {
      this.deps.log(`[session-helper] ${sid}: the kept session runs on another account than tab ${ctx.sessionId}'s launch, so the tab starts a new CLI`)
      return null
    }
    this.keptForTabs.delete(sid)
    if (entry.timer) clearTimeout(entry.timer)
    this.removeKeptRecord(sid)
    const { kept, record } = entry
    const hooks = this.hookRoute(ctx, sid, true)
    const tools = this.toolRoute(ctx, sid, undefined, true)
    const spec: LaunchSpec = { argv: [''], cwd: kept.folder ?? '', env: {}, cols: size.cols, rows: size.rows, ...(kept.bundled ? { conpty: 'bundled' as const } : {}) }
    const direct = (): IPty => notStartedPty(HELPER_SENTENCES.agentNotTakenOver, size)
    // Its connections read the holder's size (`screen`), as a plain take-over's
    // do; the screen's title too for a provider whose composer rule reads it.
    // Its `direct` starts nothing: it only says the session was ended.
    const driver: HelperPtyDriver = { ...this.driver(direct, false, false, undefined, hooks, tools, true, this.deps.screens?.[ctx.kind] === true), startsNothing: true }
    const wrapper = this.track(new HelperPty({ sid, label: ctx.sessionId, spec, adopt: record, driver, redraw: this.redrawFor(spec) }), ctx.sessionId)
    if (hooks) void wrapper.ended.then(() => hooks.ended())
    // Its routes, for the next update to keep it again.
    if (tools) this.agentRoutes.set(wrapper, { kind: ctx.kind, tools, ...(hooks ? { hooks } : {}) })
    this.deps.log(`[session-helper] ${sid}: tab ${ctx.sessionId} takes over the ${kept.provider} session the last run's update kept running, with no launch (${keptBindsText(kept)})`)
    return { pty: wrapper, kept }
  }

  /**
   * A Claude Code session's hooks through its holder (2.1.3-beta.8, plan
   * section A4), when the app wires them for its provider (deps.hooks: Claude
   * Code's only, so none for another provider's session). Its connections
   * ack `hooks` when the holder offers it. Its per-session settings file is
   * written for the hooks gateway by the PTY manager in the same synchronous
   * run as the spawn call (pty-manager.ts: spawnAgentPty, then
   * writeLocalSessionSettings and injectHooks), so always before the holder
   * answers term.launched. Once the holder launched it, and before the
   * attach sends its launch line, that file is switched to the helper's hook
   * mode for every injected event, PreToolUse included (2.1.3-beta.14, S16
   * step 2), if the gateway is taking hook events then; a holder without
   * `hooks`, a gateway that is off or not listening, or a file that cannot be
   * switched, leaves the session on the gateway, with one log line. Then each
   * event the holder passes on reaches the signals module under the tab's
   * id, once (a `seq` seen already is dropped, section 15, on this connection
   * or an earlier one). Nothing a holder sends is taken before the switch.
   * None for a run of the app's own (spawnRun): it has no such file.
   *
   * `takenOver` (2.1.3-beta.17, S16 step 5): the session an update kept
   * running, whose file the run that launched it switched (its update kept
   * it only so): on from the attach, so the events its holder queued while no
   * app took them come first. The signals module takes them while the
   * gateway is on and listening, as for any session through the helper.
   */
  private hookRoute(ctx: AgentSpawnContext, sid: string, takenOver = false): HookRoute | undefined {
    if (ctx.run) return undefined
    const deps = this.deps.hooks?.[ctx.kind]
    if (!deps) return undefined
    const appId = ctx.sessionId
    let on = takenOver
    let lastSeq = 0
    if (takenOver) this.deps.log(`[session-helper] ${appId}: its hook events go through its holder from the take-over, PreToolUse included`)
    return {
      isOn: () => on,
      launched: (conn) => {
        // Relies on the PTY manager having written the file already: it does,
        // with no await between the spawn call and the write (see above).
        const exe = this.info?.exe
        if (!conn.hooks || !exe) {
          this.deps.log(`[session-helper] ${appId}: its hooks stay on the hooks gateway, because ${conn.hooks ? 'the helper copy is not known' : 'its holder does not offer hook events'}`)
          return
        }
        if (!deps.taking()) {
          this.deps.log(`[session-helper] ${appId}: its hooks stay on the hooks gateway, because the hooks gateway is off or not listening, so no hook event would be taken`)
          return
        }
        const r = deps.useHelperHooks(appId, { helperPath: exe, store: this.store, sid, launcher: this.os === 'windows' ? 'git-bash' : 'sh' })
        if (r !== 'switched') {
          this.deps.log(`[session-helper] ${appId}: its hooks stay on the hooks gateway, because ${HOOKS_STAY_BECAUSE[r]}`)
          return
        }
        on = true
        this.deps.log(`[session-helper] ${appId}: its hook events go through its holder, PreToolUse included`)
      },
      event: (e) => {
        if (!on || e.seq <= lastSeq) return
        lastSeq = e.seq
        deps.event(appId, e)
      },
      ended: () => {
        if (on) deps.ended(appId)
      },
    }
  }

  /**
   * A session's tool calls through its holder (2.1.3-beta.11, plan sections
   * B1 and B2), when the app gives the tool functions for its provider
   * (deps.tools: Claude Code's and Codex's). Its connections ack `mcp` when
   * the holder offers it.
   *
   * The switch (B2), once per launch: the session's CLI is pointed at the
   * helper's relay (`<helper copy> mcp --store <store> --session <sid>`) in
   * place of the loopback server, only when its holder offers `mcp` (the
   * app's own copy has the relay mode), the helper copy is known, and the
   * tool host is serving. Claude Code reads its MCP config file when its
   * launch line starts it, so the file is switched once the holder launched
   * the session and before that line is typed (`launched`), as its hooks are.
   * Codex names its tool server in the launch itself, built before the holder
   * existed, so the launch the holder runs gets the relay form, its hello
   * read (`launchArgs`), and counts as switched once the holder took it
   * (`launched`); the usual start it falls back to keeps the spawn's own
   * arguments. A session that cannot be switched keeps the loopback
   * route, with one log line saying why. The paths go into the session's own
   * file or launch only, never into a log line.
   *
   * Each `mcp.open` on a connection of a switched session becomes a link the
   * tool host is handed under the tab's id: the session a call acts for is the
   * tab, never anything a message says. One before the switch, or on a session
   * that was not switched, is not served. Each `mcp` goes to its stream's
   * link, and the stream's `mcp.close`, or the connection's close, ends it.
   * None for a run of the app's own (spawnRun).
   *
   * The switch is kept per launch, not per connection: a stream the holder
   * gives back on the connection that attached again (one it kept while the
   * link was down) is served as any other, by a link of that connection, with
   * one log line for each such stream.
   *
   * `takenOver` (2.1.3-beta.17, S16 steps 5 and 6): the session an update
   * kept running, whose CLI the run that launched it pointed at the relay
   * (its update kept it only so), with no launch here: on from the attach.
   * Every stream its holder opens on the take-over's first connection is
   * served with `toolsChanged` when the provider's CLI lists its tools again
   * on being told (listsAgain): the ones kept while no app took them, since
   * this run's tool list may not be the one that CLI read, and any the CLI
   * opens on that connection later, which lists from this run anyway.
   */
  private toolRoute(ctx: AgentSpawnContext, sid: string, launch: { file: string; args: SpawnArgs; opts: SpawnOptions } | undefined, takenOver = false): ToolRoute | undefined {
    if (ctx.run) return undefined
    const deps = this.deps.tools?.[ctx.kind]
    if (!deps) return undefined
    const appId = ctx.sessionId
    /** The CLI was pointed at the relay: its holder's streams are served. */
    let on = takenOver
    if (takenOver) this.deps.log(`[session-helper] ${appId}: its Conductor tools go through its holder from the take-over`)
    const stays = (why: string): void => this.deps.log(`[session-helper] ${appId}: its Conductor tools stay on the loopback route, because ${why}`)
    const switched = (): void => {
      on = true
      this.deps.log(`[session-helper] ${appId}: its Conductor tools go through its holder`)
    }
    /** The relay for this session, or null (and the log line) when the session cannot be switched. */
    const relayFor = (conn: HolderConnection): HeldToolRelay | null => {
      const exe = this.info?.exe
      if (!conn.mcp) { stays('its holder does not offer tool streams'); return null }
      if (!exe) { stays('the helper copy is not known'); return null }
      if (!deps.serving()) { stays('the tool host is not serving'); return null }
      return { helperPath: exe, store: this.store, sid }
    }
    /** The connections opened to this launch's holder: the first is the launch's. */
    let connections = 0
    const route: ToolRoute = {
      isOn: () => on,
      connected: (conn) => {
        const again = connections++ > 0
        // S16 step 6: the take-over's first connection is given the streams
        // the holder kept; their CLI is told its tool list may have changed.
        const toolsChanged = takenOver && !again && deps.listsAgain === true
        const links = new Map<number, StreamLink>()
        // The connection reports these only when it acked `mcp`, and only for
        // a stream the holder opened on it (connection.ts): that is the guard.
        conn.on('mcpOpen', (stream) => {
          const link = new StreamLink(conn, stream, () => { if (links.get(stream) === link) links.delete(stream) })
          if (!on) {
            link.close()
            this.deps.log(`[session-helper] ${appId}: a tool stream its holder opened was not served, because its CLI was not pointed at its holder`)
            return
          }
          links.set(stream, link)
          let served = false
          try {
            served = toolsChanged ? deps.serve(appId, link, { toolsChanged: true }) : deps.serve(appId, link)
          } catch (err) {
            this.deps.log(`[session-helper] ${appId}: the tool host failed on a tool stream: ${message(err)}`)
          }
          if (!served) {
            link.close()
            this.deps.log(`[session-helper] ${appId}: a tool stream its holder opened was not served`)
          } else if (again) {
            this.deps.log(`[session-helper] ${appId}: a tool stream is served on the connection that attached again (one its holder kept while the link was down, or a new one)`)
          } else if (toolsChanged) {
            this.deps.log(`[session-helper] ${appId}: a tool stream is served on the take-over's connection, and its CLI is told its tool list may have changed`)
          }
        })
        conn.on('mcp', (stream, m) => links.get(stream)?.deliver(m))
        conn.on('mcpClose', (stream) => links.get(stream)?.ended())
        conn.on('close', () => { for (const link of [...links.values()]) link.ended() })
      },
    }
    // A take-over launches nothing: its CLI was switched by the run that launched it.
    if (takenOver || !launch) return route
    // One switch per launch: by its launch when the provider names its tool
    // server there, else by its config file.
    const useRelayConfig = deps.relayLaunch ? undefined : deps.useRelayConfig
    if (useRelayConfig) {
      route.launched = (conn) => {
        // Relies on the PTY manager having written the file already: it does,
        // with no await between the spawn call and the write (hookRoute).
        const relay = relayFor(conn)
        if (!relay) return
        let r: HelperMcpConfigResult
        try {
          r = useRelayConfig(appId, relay)
        } catch {
          // What it threw can name a path: the line says only what failed.
          stays('its MCP config file could not be switched')
          return
        }
        if (r !== 'switched') { stays(MCP_CONFIG_STAYS_BECAUSE[r]); return }
        switched()
      }
    }
    const relayLaunch = deps.relayLaunch
    if (relayLaunch) {
      /** The launch last asked for is the relay form. It counts once the
       *  holder took it (`launched`): one it refused falls back to the usual
       *  start, with the spawn's own arguments. */
      let relayed = false
      route.launched = () => { if (relayed) switched() }
      route.launchArgs = (conn) => {
        relayed = false
        const relay = relayFor(conn)
        if (!relay) return undefined
        let answer: HeldToolLaunchAnswer
        try {
          // The environment the launch goes with (launchSpec reads the same).
          answer = relayLaunch(appId, { file: launch.file, args: launch.args, env: launch.opts.env ?? process.env }, relay)
        } catch {
          stays('its launch\'s relay form could not be made')
          return undefined
        }
        if ('refused' in answer) { stays(RELAY_LAUNCH_STAYS_BECAUSE[answer.refused]); return undefined }
        // The same program, folder and environment; only its arguments differ.
        const spec = this.agentSpec(launch.file, answer.args, launch.opts)
        const refused = checkLaunch(spec, this.os)
        if (refused) { stays(`the helper would refuse its relay form (${refused.why})`); return undefined }
        relayed = true
        return { argv: spec.argv, ...(spec.line !== undefined ? { line: spec.line } : {}) }
      }
    }
    return route
  }

  /**
   * An agent session's launch: the very program, folder, environment and size
   * the spawn was given. An argument line given as one string (an npm
   * launcher run through cmd.exe, which node-pty passes verbatim) goes as the
   * exact command line node-pty would have made of it, with the program alone
   * in argv; node-pty's bundled ConPTY becomes the helper's (`conpty`).
   * checkLaunch refuses either off Windows.
   */
  private agentSpec(file: string, args: SpawnArgs, opts: SpawnOptions): LaunchSpec {
    const spec = this.launchSpec(file, typeof args === 'string' ? [] : args, opts)
    if (typeof args === 'string') spec.line = nodePtyCommandLine(file, args)
    if ((opts as pty.IWindowsPtyForkOptions).useConptyDll === true) spec.conpty = 'bundled'
    return spec
  }

  /**
   * The usual way for an agent session the helper did not carry after all:
   * node-pty with the spawn's own arguments. One on node-pty's bundled ConPTY
   * that node-pty cannot start there starts on the system ConPTY instead, and
   * the rest of the run uses that one (bundledConptyFailed). That is what the
   * PTY manager's own spawn does when node-pty throws, but by the time a
   * holder has failed that spawn has long returned, so it is done here.
   */
  private usualStart(file: string, args: SpawnArgs, opts: SpawnOptions, label: string): () => IPty {
    return () => {
      try {
        return this.deps.spawnDirect(file, args, opts)
      } catch (err) {
        const { useConptyDll, ...system } = opts as pty.IWindowsPtyForkOptions
        if (useConptyDll !== true) throw err
        let started: IPty
        try { started = this.deps.spawnDirect(file, args, system) } catch { throw err }
        bundledConptyFailed(String((err as Error)?.message ?? err))
        this.deps.log(`[session-helper] ${label}: node-pty's bundled ConPTY failed to start it; started on the system ConPTY`)
        return started
      }
    }
  }

  private track(wrapper: HelperPty, appId: string): HelperPty {
    const sid = wrapper.sid
    this.live.set(sid, wrapper)
    void wrapper.ended.then(() => {
      // Only the terminal that still holds this id lets go of it: a tab
      // started again before this one finished ending runs under the same
      // id and keeps its binding. One let go of for an update keeps its
      // binding too: the tab Re-attach opened for it shows it again at the
      // next start.
      if (this.live.get(sid) !== wrapper) return this.changed()
      this.live.delete(sid)
      if (!wrapper.isReleased) for (const [bound, s] of [...this.bindings]) if (s === sid && bound === appId) this.bindings.delete(bound)
      this.saveBindings()
      this.changed()
    })
    this.changed()
    return wrapper
  }

  private launchSpec(file: string, args: string[], opts: SpawnOptions): LaunchSpec {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.env ?? process.env)) if (typeof v === 'string') env[k] = v
    const cwd = opts.cwd ?? process.cwd()
    if (this.os === 'unix') {
      // What node-pty sets on a Unix terminal, so the shell sees the same.
      env.PWD = cwd
      env.TERM = opts.name || env.TERM || 'xterm-256color'
    }
    return { argv: [file, ...args], cwd, env, cols: opts.cols ?? 80, rows: opts.rows ?? 24 }
  }

  /** `bundled`: the launch asks for the bundled ConPTY, whose copy beside the
   *  helper is checked before the holder starts. `cleared` (an agent
   *  session): what must settle before a holder starts, in place of the plain
   *  terminal's wait for an earlier holder's end; it throws to start none.
   *  `hooks`: a Claude Code session's hooks through its holder (hookRoute).
   *  `tools`: a session's tool calls through its holder (toolRoute).
   *  `screen`: its connections ask for the holder's screen reads (plainDriver;
   *  B2, an agent session of a provider in deps.screens). `title`: beside
   *  `screen`, they ask for the screen's title too (B2). */
  private driver(direct: () => IPty, checkHash: boolean, bundled = false, cleared?: () => Promise<void>, hooks?: HookRoute, tools?: ToolRoute, screen = false, title = false): HelperPtyDriver {
    // The hooks' switch and the tools' switch are each their own: one that
    // fails or throws leaves the other as it would be alone.
    const atLaunch = [hooks ? (conn: HolderConnection) => hooks.launched(conn) : null, tools?.launched ?? null].filter((f): f is (conn: HolderConnection) => void => f !== null)
    return {
      hold: (sid, label, abandoned) => this.hold(sid, label, abandoned, bundled, cleared),
      connect: (record) => this.connectFor(record, checkHash, hooks, tools, screen, title),
      ...(atLaunch.length > 0 ? {
        launched: (conn: HolderConnection) => {
          const errors: unknown[] = []
          for (const f of atLaunch) {
            try { f(conn) } catch (err) { errors.push(err) }
          }
          // Thrown once every switch has run: helper-pty logs it with the
          // holder's id, as it did when the hooks' switch was the only one.
          if (errors.length === 1 && errors[0] instanceof Error) throw errors[0]
          if (errors.length > 0) throw new Error(errors.map(message).join('; '))
        },
      } : {}),
      ...(tools?.launchArgs ? { launchArgs: tools.launchArgs } : {}),
      direct,
      ending: (sid, done) => {
        this.endings.set(sid, done)
        void done.finally(() => { if (this.endings.get(sid) === done) this.endings.delete(sid) })
      },
      attachedChanged: () => this.changed(),
      log: (m) => this.deps.log(m),
      now: () => this.deps.now(),
    }
  }

  /** A plain or partner terminal's driver: its connections ask for `screen`,
   *  so a take-over reads the holder's size before its replay is shown
   *  (helper-pty.ts; 2.1.3-beta.13, plan section A1). */
  private plainDriver(direct: () => IPty, checkHash: boolean): HelperPtyDriver {
    return this.driver(direct, checkHash, false, undefined, undefined, undefined, true)
  }

  private async open(record: HolderRecord, sha256?: string, hooks?: HookRoute, tools?: ToolRoute, screen = false, title = false): Promise<HolderConnection> {
    const conn = await HolderConnection.open({
      record,
      os: this.os,
      sha256,
      openStream: this.deps.openStream,
      checkEndpointFolder: this.deps.checkEndpointFolder,
      replyTimeoutMs: this.deps.replyTimeoutMs,
      ...(hooks ? { hooks: true } : {}),
      ...(tools ? { mcp: true } : {}),
      ...(screen ? { screen: true } : {}),
      ...(screen && title ? { title: true } : {}),
    })
    // The connection reports an event only when it acked `hooks` (connection.ts;
    // tests/unit/main/session-helper-connection.test.ts): that is the one guard.
    if (hooks) conn.on('event', (e) => hooks.event(e))
    if (tools) tools.connected(conn)
    return conn
  }

  private async hold(sid: string, label: string, abandoned: () => boolean, bundled = false, cleared?: () => Promise<void>): Promise<HolderRecord> {
    if (cleared) {
      // An agent session: no earlier holder of its id may still run (clearAgent).
      await cleared()
    } else {
      const previous = this.endings.get(sid)
      if (previous) await waitAtMost(previous, ENDING_WAIT_MS)
    }
    const exe = await this.checkedExe()
    if (bundled) {
      // Checked against node-pty's files before every launch on it, as the
      // helper's own copy is. Unavailable: the session starts the usual way,
      // on node-pty's own bundled ConPTY, and no holder is started for it.
      const copy = this.info ? await checkedConpty(this.info) : null
      if (!copy || !copy.available) throw new Error(`the bundled ConPTY beside the helper is not available (${copy && !copy.available ? copy.reason : 'no helper copy'})`)
    }
    // A holder of this session nobody is taking over (a terminal this run
    // could not end): ended first, so the new one can start. One that does not
    // answer is gone, and `hold` replaces its record.
    const left = this.readStoreRecords().find((r) => r.session === sid)
    if (left) {
      try {
        await this.endRecord(left)
      } catch (err) {
        this.deps.log(`[session-helper] ${sid}: the holder left for this terminal did not answer (${message(err)}); starting a new one`)
      }
    }
    // Nothing is started for a terminal no longer wanted: one its tab ended
    // (a Restart, a close) while it waited above, which would otherwise start
    // a holder beside the next start's, or one a quit ended. Checked after
    // the last wait, so nothing can end it between this and the start.
    if (abandoned()) throw new NothingStartedError('it was ended before its holder started')
    if (this.quitting) throw new Error('the app is quitting')
    const r = await this.deps.exec(exe, ['hold', '--store', this.store, '--session', sid, '--label', label, '--detach'], HOLD_TIMEOUT_MS)
    if (r.code === EXIT_ALREADY_RUNNING) {
      // A holder of this session runs already: the app connects to it (section 15).
      const running = this.readStoreRecords().find((x) => x.session === sid)
      if (running) return running
      throw new Error('a holder for this terminal runs already, and its record cannot be read')
    }
    if (r.code !== 0) throw new Error(firstLine(r.stderr) || `the helper exited with ${r.code}`)
    if (/does not let a process leave/.test(r.stderr) && !this.insideJob) {
      // The holder runs, but inside the app's job: it ends with the app.
      this.insideJob = true
      this.deps.log(`[session-helper] ${firstLine(r.stderr)}`)
      this.changed()
    }
    let record: HolderRecord | null = null
    try {
      record = readRecord(JSON.parse(lastLine(r.stdout)), this.os)
    } catch { /* below */ }
    if (!record || record.session !== sid) throw new Error('the helper answered no record for this terminal')
    return record
  }

  private async connectFor(record: HolderRecord, checkHash: boolean, hooks?: HookRoute, tools?: ToolRoute, screen = false, title = false): Promise<HolderConnection> {
    // A keeper attaches first; the tab's attach then replaces it, never the other way.
    const keeper = this.keepers.get(record.session)
    if (keeper) await keeper.ready
    return this.open(record, checkHash ? this.info?.sha256 : undefined, hooks, tools, screen, title)
  }

  /** Keep a held terminal alive (attached, output dropped) until a tab takes it. */
  private keep(record: HolderRecord): void {
    const sid = record.session
    if (this.quitting || this.keepers.has(sid)) return
    const entry: { record: HolderRecord; conn?: HolderConnection; ready: Promise<void> } = { record, ready: Promise.resolve() }
    entry.ready = (async () => {
      try {
        const conn = await this.open(record)
        entry.conn = conn
        conn.on('close', () => {
          if (this.keepers.get(sid) === entry) this.keepers.delete(sid)
          this.changed()
        })
        conn.on('notice', (code: string) => { if (code === 'replaced') conn.close() })
        await conn.request({ t: 'term.attach', from: 0 })
      } catch (err) {
        this.deps.log(`[session-helper] ${sid}: the held terminal could not be kept: ${message(err)}`)
        if (this.keepers.get(sid) === entry) {
          this.keepers.delete(sid)
          // Not reachable now, so not taken over: its tab starts a new terminal.
          if (this.adoptable.get(sid) === record) this.adoptable.delete(sid)
          // An agent session kept for its tab (S16 step 5): ended, and its tab
          // starts a new CLI once that end is confirmed.
          if (this.keptForTabs.get(sid)?.record === record) this.endKeptForTab(sid, 'its holder could not be reached')
        }
        entry.conn?.close()
        this.changed()
      }
    })()
    this.keepers.set(sid, entry)
  }

  /**
   * Make sure no earlier holder of this agent session id still runs: one a
   * crash left (ended now, never kept or shown again, plan s11 Q1), one this
   * run is ending (a Restart), or one that did not end when asked. Answers
   * true once none runs, so the tab may start its CLI; false when that could
   * not be confirmed, and then nothing may start for it. One at a time for an
   * id: every start that asks shares the answer. `record` is the crash's or
   * the listing's; without one the store is read for it.
   */
  private clearAgent(sid: string, record?: HolderRecord): Promise<boolean> {
    const earlier = this.endings.get(sid)
    const pending = this.agentClears.get(sid)
    if (pending) {
      if (!earlier || earlier === pending.after) return pending.done
      // A terminal of this id began ending after that clear started: its end
      // is waited for too. A backstop: a start the tab ends while it waits
      // here starts no holder (hold() checks `abandoned`), so today that end
      // is over at once.
      return pending.done.then((ok) => ok && this.clearAgent(sid))
    }
    const p = (async () => {
      // This run's own end first: it settles once its holder answered, or
      // after helper-pty.ts END_WAIT_MS when it did not (then the store still
      // has its record).
      if (earlier) await earlier.catch(() => { /* settled */ })
      const left = record ?? this.readStoreRecords().find((r) => r.session === sid)
      if (!left) return true
      return this.endUntilGone(left)
    })()
    const entry = { done: p, after: earlier }
    this.agentClears.set(sid, entry)
    void p.then((ok) => {
      if (this.agentClears.get(sid) === entry) this.agentClears.delete(sid)
      if (ok) this.agentsNotCleared.delete(sid)
      else this.agentsNotCleared.add(sid)
      this.changed()
    })
    return p
  }

  /**
   * End an agent session's earlier holder, and keep asking while the helper
   * still lists it: a holder that cannot be reached ends itself by its away
   * clock once the app let go of it, so this waits that long at most
   * (AGENT_CLEAR_AWAY_CAP_MS at the most, and AGENT_CLEAR_GRACE_MS more).
   * True once it ended or is gone.
   */
  private async endUntilGone(record: HolderRecord): Promise<boolean> {
    const sid = record.session
    const until = this.deps.now() + Math.min(record.away * 1000, AGENT_CLEAR_AWAY_CAP_MS) + AGENT_CLEAR_GRACE_MS
    let said = false
    for (;;) {
      try {
        await this.endRecord(record)
        this.deps.log(`[session-helper] ${sid}: ended the agent session's earlier holder`)
        return true
      } catch (err) {
        if (!said) this.deps.log(`[session-helper] ${sid}: the agent session's earlier holder did not answer its end (${message(err)}); waiting until it is gone`)
        said = true
      }
      if (await this.holderGone(record)) {
        this.deps.log(`[session-helper] ${sid}: the agent session's earlier holder is gone`)
        return true
      }
      if (this.quitting || this.deps.now() >= until) {
        this.deps.log(`[session-helper] ${sid}: the agent session's earlier holder is still running and could not be ended; nothing is started for its terminal`)
        return false
      }
      await this.deps.sleep(AGENT_CLEAR_RETRY_MS)
    }
  }

  /** True when this holder no longer runs: the helper's own listing (which
   *  checks its process and its endpoint) no longer has it, or, when the
   *  helper cannot list now, no process has its id. */
  private async holderGone(record: HolderRecord): Promise<boolean> {
    try {
      return !(await this.list()).some((r) => r.session === record.session && r.pid === record.pid)
    } catch {
      return this.deps.processGone(record.pid)
    }
  }

  /** End a held terminal no tab of this run started. */
  private async endRecord(record: HolderRecord): Promise<void> {
    const keeper = this.keepers.get(record.session)
    let conn: HolderConnection | undefined
    try {
      if (keeper) await keeper.ready
      conn = keeper?.conn && !keeper.conn.isClosed ? keeper.conn : await this.open(record)
      await conn.request({ t: 'term.end' })
    } finally {
      conn?.close()
      this.keepers.delete(record.session)
      this.adoptable.delete(record.session)
      this.reclaimed.delete(record.session)
      // One kept for its tab to take over (S16 step 5; ended from the
      // Machines page, say): no longer kept, and its record and files go.
      this.forgetKeptForTab(record.session)
    }
  }

  /** The records in the store as written, read strictly; no holder is asked. */
  private readStoreRecords(): HolderRecord[] {
    return readStore(this.store, this.os)
  }

  /** List mode: the live holders, oldest first (stale records are removed by the helper). */
  async list(): Promise<HolderRecord[]> {
    const exe = await this.checkedExe()
    const r = await this.deps.exec(exe, ['list', '--store', this.store], LIST_TIMEOUT_MS)
    if (r.code !== 0) throw new Error(firstLine(r.stderr) || `the helper exited with ${r.code}`)
    const listing = readListing(lastLine(r.stdout), this.os)
    if (!listing) throw new Error('the helper answered a listing that does not read')
    this.listing = listing.sessions
    return this.listing
  }

  /** The held terminals this run knows without asking the helper: taken over
   *  by a tab, through it now, or kept for a tab. Oldest first. */
  private heldRecords(): HolderRecord[] {
    const by = new Map<string, HolderRecord>()
    for (const [sid, w] of this.live) if (w.throughHelper && w.heldRecord) by.set(sid, w.heldRecord)
    for (const [sid, k] of this.keepers) if (!by.has(sid)) by.set(sid, k.record)
    for (const [sid, r] of this.adoptable) if (!by.has(sid)) by.set(sid, r)
    return [...by.values()].sort((a, b) => a.started - b.started || (a.session < b.session ? -1 : 1))
  }

  /** The ids of the terminals the helper holds for this run now. */
  private heldIds(): Set<string> {
    const held = new Set<string>([...this.adoptable.keys(), ...this.keepers.keys()])
    for (const [sid, w] of this.live) if (w.throughHelper) held.add(sid)
    return held
  }

  /**
   * An app update on Windows (update-handlers.ts, just before every PTY is
   * killed and the installer starts): each plain or partner terminal through
   * a holder is let go of instead of ended, when its tab (a partner's is its
   * session's) is saved twice over: in the app's last save (noteSavedTabs)
   * and in `restorable`, the tabs in the saved file the next start restores
   * from. `restorable` is null when the user chose "Close sessions" on the
   * update dialog (the renderer says so with the install call; app-wiring
   * passes it on), so then none is. Its holder's away clock starts (two
   * minutes) and the next start, finding the running mark, shows it again in
   * its tab. A terminal still starting and one whose tab was not saved are
   * left to the kill that follows, which ends them as before.
   *
   * An agent session (2.1.3-beta.14, plan section A1, S16 step 4): with the
   * agent sessions' setting on, one whose tab is saved the same way is let go
   * of too, with its CLI running, when its tool calls go through its holder
   * and, for a provider whose hook events can go through one (deps.hooks:
   * Claude Code), its hook events too. Its release is recorded first, in the
   * helper's folder (`kept/<session id>.json`): the provider, the conversation
   * it is on, the account and its Codex hook folder (describeKeptLaunch), and
   * its kill keeps what its launch put on disk (keepsLaunchOf). The next
   * start keeps it for its restored tab to take over (2.1.3-beta.17, S16
   * step 5: keptAtStart, takeOverKept), or reads the record, removes it and
   * those files, and ends the session as before. Any other agent session (one
   * on the loopback route, a run of the app's own) is left to the kill.
   *
   * A held terminal kept for a tab that no tab took over (one a crash left,
   * one Re-attach opened a tab for, one an earlier reclaim() kept) is not
   * reached by that kill. When `restorable` is a set (Save, even with no tab
   * saved; an update with no tab open, which shows no dialog; a saved file
   * that did not read), it is neither let go of nor ended: it runs on past
   * the exit, and the next start, taking the crash path, keeps it again
   * (section B3). When it is null, it is ended now, so none is left held.
   * The mark is written again saying "update" and stays. Nothing new goes
   * through the helper until reclaim(). Off Windows nothing is let go of.
   * Answers how many were.
   */
  releaseForUpdate(restorable: ReadonlySet<string> | null): number {
    if (this.os !== 'windows' || this.quitting) return 0
    this.updating = true
    const saved = (tab: string) => restorable !== null && this.savedTabs.has(tab) && restorable.has(tab)
    let n = 0
    let agents = 0
    for (const [sid, w] of this.live) {
      if (!w.throughHelper || w.isReleased) continue
      const kind = heldIdKind(sid)
      const keeps = kind === 'agent' ? this.keepable(w) : null
      if (kind !== 'plain' && !keeps) continue
      const record = w.heldRecord
      const tab = parentOfPartnerPtyId(w.label) ?? w.label
      if (!record || !saved(tab)) continue
      // An agent session's record is written before it is let go of: one
      // that cannot be recorded is left to the kill, which ends it.
      const kept = keeps ? this.recordKept(sid, w.label, keeps.kind, w.launchShape) : undefined
      if (keeps && !kept) continue
      if (!w.release()) {
        if (kept) this.removeKeptRecord(sid)
        continue
      }
      this.released.set(sid, kept ? { record, pty: w, kept } : { record, pty: w })
      if (kept) {
        agents++
        this.deps.log(`[session-helper] ${sid}: an app update lets go of this ${kept.provider} session of tab ${kept.label} with its CLI running, and records it for the next start (${keptBindsText(kept)})`)
      }
      n++
    }
    // Kept and no tab took it over (a crash's, Re-attach's or reclaim()'s):
    // the kill does not reach it, so its holder runs on past the app's exit.
    // That is what the user chose with Save; only "Close sessions" ends it here.
    const ends: Promise<unknown>[] = []
    let leftRunning = 0
    for (const [sid, r] of new Map([...this.reclaimed, ...this.adoptable])) {
      if (this.live.has(sid) || heldIdKind(sid) !== 'plain') continue
      if (restorable !== null) {
        leftRunning++
        this.deps.log(`[session-helper] ${sid}: kept with no tab showing it; left running through the update, for the next start to keep again`)
        continue
      }
      this.reclaimed.delete(sid)
      ends.push(this.endRecord(r).catch((err) => this.deps.log(`[session-helper] ${sid}: could not be ended at the update: ${message(err)}`)))
    }
    this.updateEnds = Promise.allSettled(ends).then(() => undefined)
    try {
      this.writeMarker('update')
    } catch (err) {
      this.deps.log(`[session-helper] the running mark could not be written for the update: ${message(err)}`)
    }
    const tail = restorable === null
      ? `the sessions were discarded, so ${ends.length} kept terminal(s) are ended`
      : `${leftRunning} kept terminal(s) are left running`
    this.deps.log(`[session-helper] an app update: ${n - agents} held terminal(s) are let go of, for the new version to show again${agents > 0 ? `, and ${agents} agent session(s) are let go of with their CLIs running, recorded for the next start` : ''}; ${tail}`)
    this.changed()
    return n
  }

  /** Settles once every end the last releaseForUpdate sent was answered (or
   *  failed): the kept terminals ended because the user discarded the saved
   *  sessions. The caller bounds the wait; the app exits next. */
  endsForUpdate(): Promise<void> {
    return this.updateEnds
  }

  /** True while an app update keeps this tab's agent session running (S16
   *  step 4): what its launch put on disk stays at its kill (kept-launches.ts,
   *  read by launch-bindings.ts). */
  keepsLaunchOf(appPtyId: string): boolean {
    if (!this.updating) return false
    for (const e of this.released.values()) if (e.kept?.label === appPtyId) return true
    return false
  }

  /** The routes of an agent session an update may keep running: the agent
   *  sessions' setting on, its tool calls through its holder, and its hook
   *  events too when its provider's can go through one. Null otherwise. */
  private keepable(w: HelperPty): { kind: ProviderId } | null {
    if (!this.agentsOn) return null
    const routes = this.agentRoutes.get(w)
    if (!routes || !routes.tools.isOn()) return null
    if (routes.hooks && !routes.hooks.isOn()) return null
    return { kind: routes.kind }
  }

  /** Record the release of an agent session an update keeps running, in the
   *  helper's folder, with the folder its CLI was launched in and its ConPTY
   *  (`shape`, for the take-over). Undefined, with one log line, when it
   *  cannot be written. */
  private recordKept(sid: string, label: string, provider: ProviderId, shape: { cwd: string; bundled: boolean }): KeptRecord | undefined {
    const record = keptRecordOf({ v: 1, session: sid, label, provider, ...describeKeptLaunch(label), folder: shape.cwd, ...(shape.bundled ? { bundled: true } : {}), at: this.deps.now() }, sid, this.os)
    if (!record) {
      this.deps.log(`[session-helper] ${sid}: the agent session could not be recorded, so it is ended at the update as before`)
      return undefined
    }
    try {
      const dir = path.join(this.root, KEPT)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ v: 1, ...record }), { mode: 0o600 })
      return record
    } catch (err) {
      this.deps.log(`[session-helper] ${sid}: the agent session could not be recorded (${message(err)}), so it is ended at the update as before`)
      this.removeKeptRecord(sid)
      return undefined
    }
  }

  private removeKeptRecord(sid: string): void {
    try { fs.rmSync(path.join(this.root, KEPT, `${sid}.json`), { force: true }) } catch { /* the next start removes it */ }
  }

  /** An agent session an update kept running that is kept no longer: its
   *  record, and what its launch left on disk (kept-launches.ts). */
  private forgetKept(k: KeptRecord): void {
    removeKeptLaunch({ sessionId: k.label, provider: k.provider, hookFolder: k.hookFolder, ...(k.pick ? { pick: k.pick } : {}) })
    this.removeKeptRecord(k.session)
  }

  /**
   * At start (S16 steps 4 and 5): the agent sessions the last run's update
   * kept running, as its records name them. Each is kept for its restored
   * tab to take over (takeOverKept) when this start follows that update
   * (`updated`: the running mark says so), the agent sessions' setting is on,
   * its provider's take-over is wired (deps.takeOver), its holder's record is
   * in the store, and its tab is among the saved sessions this start restores
   * (deps.savedTabs, when given): a keeper holds its holder (its away clock
   * stops), its record and what it left on disk stay for the tab (its status
   * line's address file emptied: holdKeptLaunch), and it is ended if no tab
   * takes it over within KEPT_TAKE_OVER_WAIT_MS, a limit that stops while its
   * tab is restored and not yet shown (restoredTabs). Any other is
   * ended at this start as before, and its tab resumes its conversation in a
   * new CLI: never two on one conversation. Its record is read and logged,
   * then the record and what the session left on disk go, now, before any
   * tab can start its CLI again and write its own; the session itself is
   * ended with every other agent session the store holds (clearAgent, in
   * start), which a tab of it waits for. A record that does not read is
   * removed alone. Synchronous.
   */
  private keptAtStart(updated: boolean): void {
    const held = new Map(this.readStoreRecords().map((r) => [r.session, r]))
    let saved: ReadonlySet<string> | null | undefined
    const savedTabs = (): ReadonlySet<string> | null => {
      if (saved === undefined) {
        try { saved = this.deps.savedTabs?.() ?? null } catch { saved = new Set() }
      }
      return saved
    }
    for (const { sid, record: kept } of readKeptStore(this.root, this.os)) {
      if (!kept) {
        this.deps.log(`[session-helper] ${sid}: a record of an agent session an update kept running did not read, and is removed`)
        this.removeKeptRecord(sid)
        continue
      }
      const record = held.get(sid)
      const why = !updated ? 'this start does not follow an app update'
        : this.os !== 'windows' ? 'it is not on Windows'
          : !this.agentsOn ? 'agent sessions do not go through the session helper now'
            : this.deps.takeOver?.[kept.provider] !== true ? 'a take-over of this provider\'s sessions is not built'
              : !record ? 'its holder\'s record is not in the store (its holder ended)'
                : savedTabs()?.has(kept.label) === false ? 'its tab is not among the saved sessions'
                  : null
      const what = `the last run's update kept this ${kept.provider} session of tab ${kept.label} running (${keptBindsText(kept)})`
      if (why !== null || !record) {
        this.deps.log(`[session-helper] ${sid}: ${what}; it is ended, and its tab resumes the conversation as before, because ${why ?? 'its holder is not known'}`)
        this.forgetKept(kept)
        continue
      }
      this.keptForTabs.set(sid, { kept, record, timer: this.keptWait(sid, record, '') })
      this.keep(record)
      // aicc_planning#423: its status line's address file names the last
      // run's address and credential, which this run refuses; emptied, its
      // status line writes its status file until the take-over writes it again.
      holdKeptLaunch({ sessionId: kept.label, provider: kept.provider, hookFolder: kept.hookFolder })
      this.deps.log(`[session-helper] ${sid}: ${what}; it is kept for its tab to take over`)
    }
  }

  /** A kept session's time limit (KEPT_TAKE_OVER_WAIT_MS), from now: it is
   *  ended if its tab has not taken it over by then. `since` ends the log
   *  line's reason. */
  private keptWait(sid: string, record: HolderRecord, since: string): ReturnType<typeof setTimeout> {
    const waitMs = this.deps.keptTakeOverWaitMs ?? KEPT_TAKE_OVER_WAIT_MS
    return setTimeout(() => {
      if (this.keptForTabs.get(sid)?.record === record) this.endKeptForTab(sid, `its tab did not take it over within ${waitMs} ms${since}`)
    }, waitMs)
  }

  /**
   * aicc_planning#423: Resume restored these tabs (the renderer says so as it
   * restores them, session-persistence.ts). A session kept for one of them
   * waits for it with no time limit from now: a restored tab not on screen
   * mounts its terminal, and asks for the take-over, only once it is shown.
   * The limit runs again from when the tab is shown (tabShown); a closed tab
   * ends it at once (tabClosed). One kept for a tab not among them keeps its
   * limit.
   */
  restoredTabs(ids: ReadonlyArray<string>): void {
    const open = new Set(ids)
    for (const [sid, e] of this.keptForTabs) {
      if (e.shown || !e.timer || !open.has(e.kept.label)) continue
      clearTimeout(e.timer)
      e.timer = null
      this.deps.log(`[session-helper] ${sid}: tab ${e.kept.label} was restored, so the session is kept for it until the tab is shown and takes it over, or is closed`)
    }
  }

  /** aicc_planning#423: this tab is shown and starts now (TerminalView's first
   *  start; its launch may wait at its account picker first). A session kept
   *  for it with no time limit gets its limit again, from now. */
  tabShown(appPtyId: string): void {
    for (const [sid, e] of this.keptForTabs) {
      if (e.kept.label !== appPtyId || e.shown) continue
      e.shown = true
      if (e.timer) continue
      e.timer = this.keptWait(sid, e.record, ' of being shown')
      this.deps.log(`[session-helper] ${sid}: tab ${appPtyId} is shown, so the session kept for it waits for its take-over from now`)
    }
  }

  /** aicc_planning#423: this tab was closed. A session kept for it is ended
   *  now, with its record and what it left on disk. */
  tabClosed(appPtyId: string): void {
    for (const [sid, e] of [...this.keptForTabs]) {
      if (e.kept.label === appPtyId) this.endKeptForTab(sid, 'its tab was closed')
    }
  }

  /** An agent session kept for its tab (S16 step 5) is kept no longer: its
   *  time limit stops, and its record and what it left on disk go. Nothing
   *  is ended here (see endKeptForTab). */
  private forgetKeptForTab(sid: string): void {
    const entry = this.keptForTabs.get(sid)
    if (!entry) return
    this.keptForTabs.delete(sid)
    if (entry.timer) clearTimeout(entry.timer)
    this.forgetKept(entry.kept)
  }

  /** An agent session kept for its tab that the tab will not take over: it is
   *  ended (clearAgent, which its tab's next start waits for), with its
   *  record and what it left on disk, and one log line says why. */
  private endKeptForTab(sid: string, why: string): void {
    const entry = this.keptForTabs.get(sid)
    if (!entry) return
    this.forgetKeptForTab(sid)
    this.deps.log(`[session-helper] ${sid}: the session kept for tab ${entry.kept.label} to take over is ended, because ${why}`)
    void this.clearAgent(sid, entry.record)
  }

  /** Ends the holder of an agent session an update kept running, now (the
   *  update did not start). A start of its tab meanwhile waits for it. */
  private endKeptHolder(record: HolderRecord): void {
    const sid = record.session
    const done = this.endRecord(record).catch((err) => this.deps.log(`[session-helper] ${sid}: the agent session the update let go of could not be ended (${message(err)}); its tab's next start waits until it is gone`))
    this.endings.set(sid, done)
    void done.finally(() => { if (this.endings.get(sid) === done) this.endings.delete(sid) })
  }

  /**
   * The update did not go ahead (its installer could not be started): what
   * releaseForUpdate let go of is kept for its tab, as after a crash, and
   * listed on the Machines page, where Re-attach opens a new Terminal only
   * tab on it (its own tab's terminal read as ended); its tab started again
   * takes it over too. A terminal of it not yet killed is ended here in this
   * app alone; its holder runs on. An agent session it let go of (S16 step 4)
   * is never kept for a tab, nor listed: it is ended now, as the kill would
   * have done, and its record and what its launch left on disk go. The
   * running mark is the usual one again, and new terminals go through the
   * helper again. Answers how many are kept.
   */
  reclaim(): number {
    if (!this.updating) return 0
    this.updating = false
    const released = [...this.released.values()]
    this.released.clear()
    let kept = 0
    let ended = 0
    for (const { record, pty: w, kept: agent } of released) {
      try { w.kill() } catch { /* over already */ }
      if (agent) {
        this.forgetKept(agent)
        this.endKeptHolder(record)
        ended++
        continue
      }
      kept++
      if (this.quitting) continue
      this.adoptable.set(record.session, record)
      this.reclaimed.set(record.session, record)
      this.keep(record)
    }
    try {
      if (!this.quitting) this.writeMarker()
    } catch (err) {
      this.deps.log(`[session-helper] the running mark could not be written again: ${message(err)}`)
    }
    this.deps.log(`[session-helper] the update did not start; ${kept} held terminal(s) are kept for their tabs${ended > 0 ? `, and ${ended} agent session(s) it let go of are ended` : ''}`)
    this.changed()
    return kept
  }

  /** The app's running mark: there while the app runs, gone after a normal quit. */
  private writeMarker(reason?: 'update'): void {
    fs.writeFileSync(path.join(this.root, MARKER), JSON.stringify({ v: 1, pid: process.pid, at: this.deps.now(), ...(reason ? { reason } : {}) }))
  }

  /**
   * At a normal quit: every terminal through the helper is ended. The end
   * messages go now; the answer settles once each holder said it ended (a
   * terminal still starting, or a keeper still connecting, is ended as soon
   * as it is up). The caller bounds the wait. The running mark goes at once:
   * this was a normal quit, so the next start ends anything left instead of
   * taking it over. Null when nothing went through the helper.
   */
  shutdown(): Promise<void> | null {
    this.quitting = true
    this.plainOn = false
    this.agentsOn = false
    const waits: Promise<unknown>[] = []
    for (const w of this.live.values()) {
      // Every one is ended; only one through a holder is waited for (one that
      // fell back to the usual way ends with the app, as any terminal does).
      const through = w.throughHelper
      try { w.kill() } catch { /* already gone */ }
      if (through) waits.push(w.ended)
    }
    for (const [sid, k] of this.keepers) {
      waits.push(k.ready.then(async () => {
        const conn = k.conn
        if (!conn || conn.isClosed) return
        try { await conn.request({ t: 'term.end' }) } finally { conn.close() }
      }))
      this.keepers.delete(sid)
    }
    // Let go of for an update that this quit overtook: ended too (one that
    // does not answer ends by its away clock, and the next start ends it).
    // An agent session's record and what its launch left on disk go with it.
    for (const { record, kept } of this.released.values()) {
      waits.push(this.endRecord(record).catch(() => { /* above */ }))
      if (kept) this.forgetKept(kept)
    }
    // Kept for a tab that has not taken it over (S16 step 5): its keeper's
    // end above ends it, and its record and what it left on disk go.
    for (const sid of [...this.keptForTabs.keys()]) this.forgetKeptForTab(sid)
    this.released.clear()
    this.reclaimed.clear()
    this.adoptable.clear()
    try { fs.rmSync(path.join(this.root, MARKER), { force: true }) } catch { /* the next start ends what is left */ }
    return waits.length === 0 ? null : Promise.allSettled(waits).then(() => undefined)
  }

  /** The app saved its tabs: which ones are open, and what they are called. */
  noteSavedTabs(tabs: ReadonlyArray<{ id: string; label?: string; customName?: string }>): void {
    this.savedTabs.clear()
    for (const t of tabs) if (typeof t.id === 'string') this.savedTabs.set(t.id, t.customName || t.label || '')
  }

  serviceState(): SessionHelperServiceState {
    const held = this.heldIds().size
    // Switched off with terminals still held: the helper is still at work for them.
    return { state: this.enabled || held > 0 ? this.state : 'off', held, lastError: this.lastError }
  }

  // ── the Machines page ──────────────────────────────────────────────────────

  private appIdOf(r: HolderRecord): string {
    for (const [appId, sid] of this.bindings) if (sid === r.session) return appId
    return r.label
  }

  /**
   * The provider of an agent session's record: the one whose id, with the
   * record's label (the tab's app id), makes the record's session id. Null for
   * a plain terminal, and for an agent id this app did not make for that label.
   */
  private providerOf(r: HolderRecord): ProviderId | null {
    if (heldIdKind(r.session) !== 'agent' || !APP_PTY_ID_RE.test(r.label)) return null
    return PROVIDER_IDS.find((p) => heldAgentSessionId(r.label, p) === r.session) ?? null
  }

  /** A held terminal as the page shows it; null for an agent id no provider makes. */
  private toHeld(r: HolderRecord): HeldSession | null {
    if (heldIdKind(r.session) === 'agent') {
      const provider = this.providerOf(r)
      if (!provider) return null
      // A tab of this run shows it only through the terminal that holder was
      // started for. A holder a crash or a quit left is being ended, never
      // shown again, even while its tab waits for that end under the same id
      // to start a new one: no tab shows it. One an update kept running for
      // its tab to take over (aicc_planning#423) waits for that tab, which may
      // be restored and not yet shown: it reads as a tab's, not as being ended.
      const w = this.live.get(r.session)
      const own = w && w.heldRecord?.pid === r.pid ? w : undefined
      const forTab = this.keptForTabs.get(r.session)?.record.pid === r.pid
      // Its kind names the provider; End only, never Re-attach (the page). A
      // run of the app's own goes by what it is (an Insights report), and is
      // marked as one, so the page asks about the report, not a tab.
      const run = runName(r.label)
      return {
        id: r.session,
        kind: provider,
        label: run ?? (this.savedTabs.get(r.label) || 'Session'),
        startedAt: r.started,
        attached: !!own && own.isAttached,
        tabOpen: !!own || forTab,
        ...(run !== null ? { run: true } : {}),
      }
    }
    const appId = this.appIdOf(r)
    const partner = isPartnerPtyId(r.label)
    const base = parentOfPartnerPtyId(appId) ?? appId
    const name = this.savedTabs.get(base) || this.savedTabs.get(parentOfPartnerPtyId(r.label) ?? r.label) || ''
    const label = partner ? (name ? `${name}, partner terminal` : 'Partner terminal') : (name || 'Terminal')
    const w = this.live.get(r.session)
    return {
      id: r.session,
      kind: partner ? 'partner' : 'plain',
      label,
      startedAt: r.started,
      attached: !!w && w.isAttached,
      tabOpen: !!w || this.savedTabs.has(base),
    }
  }

  /** The held terminals: the helper's listing, or (when it cannot be read) what this run knows. */
  private async heldListing(): Promise<HolderRecord[]> {
    if (this.info) {
      try {
        return await this.list()
      } catch (err) {
        this.deps.log(`[session-helper] list failed: ${message(err)}`)
      }
    }
    return this.heldRecords()
  }

  private knownRecord(id: string): HolderRecord | undefined {
    return this.listing.find((r) => r.session === id) ?? this.heldRecords().find((r) => r.session === id)
  }

  async status(): Promise<MachineStatus> {
    const base = { id: 'this-computer' as const, name: 'This computer' }
    const heldNow = this.heldIds().size
    if (!this.enabled && heldNow === 0) return { ...base, helper: { state: 'off' }, sessions: [] }
    const sessions = (await this.heldListing()).map((r) => this.toHeld(r)).filter((s): s is HeldSession => s !== null)
    const detail = [
      this.detail,
      this.insideJob ? HELPER_SENTENCES.insideJob : undefined,
      !this.enabled ? offStillHoldingSentence(Math.max(heldNow, sessions.length), sessions.filter((s) => s.run === true).length) : undefined,
    ].filter(Boolean).join(' ')
    return {
      ...base,
      helper: {
        state: this.enabled ? this.state : 'off',
        ...(this.version ? { version: this.version } : {}),
        ...(this.selfTest ? { selfTest: this.selfTest } : {}),
        ...(detail ? { detail } : {}),
      },
      sessions,
    }
  }

  async runSelfTest(): Promise<SelfTestResult> {
    if (!this.enabled) return { ok: false, at: this.deps.now(), detail: HELPER_SENTENCES.selfTestOff }
    let exe: string
    try {
      exe = await this.checkedExe()
    } catch {
      return { ok: false, at: this.deps.now(), detail: this.detail ?? HELPER_SENTENCES.selfTestUnavailable }
    }
    const nonce = randomBytes(16).toString('hex')
    const r = await this.deps.exec(exe, ['selftest', '--nonce', nonce], SELF_TEST_TIMEOUT_MS)
    const report = parseSelfTestResult(r.stdout, nonce)
    let result: SelfTestResult
    if (!report) {
      result = { ok: false, at: this.deps.now(), detail: 'The self-test gave no answer the app could read.' }
    } else if (report.ok && report.checks.every((c) => c.ok)) {
      result = { ok: true, at: this.deps.now(), detail: `All ${report.checks.length} checks passed.` }
    } else {
      const failed = report.checks.filter((c) => !c.ok).map((c) => (c.detail ? `${c.name} (${c.detail})` : c.name))
      result = { ok: false, at: this.deps.now(), detail: `These checks failed: ${failed.join(', ') || 'unknown'}.` }
    }
    this.selfTest = result
    // A helper that fails its own test carries no terminal until a test passes.
    if (this.info) {
      this.state = result.ok ? 'ready' : 'failed'
      this.detail = result.ok ? undefined : result.detail
    }
    // Standard error is never the result, but a note there is kept in the log:
    // on Windows the self-test writes one there when it ran without its job,
    // so its terminal's host could outlive it (aicc_planning#317).
    const note = firstLine(r.stderr).slice(0, SELF_TEST_NOTE_CHARS)
    this.deps.log(`[session-helper] self-test: ${result.ok ? 'passed' : 'failed'}: ${result.detail}${note ? ` Its note: ${note}` : ''}`)
    if (!result.ok) this.lastError = { message: result.detail ?? 'The self-test failed.', ts: result.at }
    this.changed()
    return result
  }

  async endSession(id: string): Promise<MachineActionResult> {
    if (!this.enabled && !this.heldIds().has(id)) return { ok: false, message: HELPER_SENTENCES.offNothingToEnd }
    const w = this.live.get(id)
    if (w && w.throughHelper) {
      w.kill()
      await Promise.race([w.ended, new Promise((r) => setTimeout(r, ENDING_WAIT_MS))])
      return { ok: true }
    }
    let record = this.knownRecord(id)
    if (!record && this.enabled) {
      try { record = (await this.list()).find((r) => r.session === id) } catch { /* below */ }
    }
    if (!record) return { ok: false, message: HELPER_SENTENCES.notHeld }
    try {
      await this.endRecord(record)
    } catch (err) {
      this.deps.log(`[session-helper] ${id}: end failed: ${message(err)}`)
      return { ok: false, message: HELPER_SENTENCES.noAnswer }
    }
    for (const [appId, sid] of [...this.bindings]) if (sid === id) this.bindings.delete(appId)
    this.saveBindings()
    this.changed()
    return { ok: true }
  }

  async reattach(id: string): Promise<MachineActionResult> {
    if (!this.enabled && !this.heldIds().has(id)) return { ok: false, message: HELPER_SENTENCES.offNothingToReattach }
    // Nothing moves while an update goes on (also when one began while the
    // listing ran): the next version shows each kept terminal in its own tab.
    if (this.updating) return { ok: false, message: HELPER_SENTENCES.updating }
    const record = (await this.heldListing()).find((r) => r.session === id)
    if (this.updating) return { ok: false, message: HELPER_SENTENCES.updating }
    if (!record) return { ok: false, message: HELPER_SENTENCES.notHeld }
    // An agent session is never taken over by another tab: its hooks and
    // tools belong to its own (plan s11). End is what the page offers.
    if (heldIdKind(record.session) === 'agent') return { ok: false, message: HELPER_SENTENCES.agentNotReattached }
    const held = this.toHeld(record)
    if (!held) return { ok: false, message: HELPER_SENTENCES.notHeld }
    if (held.attached) return { ok: false, message: HELPER_SENTENCES.alreadyShowing }
    const appId = this.appIdOf(record)
    const partner = isPartnerPtyId(appId)
    const base = parentOfPartnerPtyId(appId) ?? appId
    // Kept by reclaim() after an update that did not start: its tab's
    // terminal read as ended, so bringing that tab forward shows nothing. It
    // goes to a new tab, as one no tab shows does.
    if (held.tabOpen && !(this.reclaimed.has(id) && !this.live.has(id))) {
      // Its tab is open: brought forward, and showing it attaches it.
      return { ok: true, tab: { id: base, label: held.label, open: false, partner } }
    }
    // No tab shows it: a new Terminal only tab, bound to it. The binding
    // moves: a tab an earlier Re-attach bound to it (one whose terminal read
    // as ended after an update that did not start) gets a terminal of its
    // own if it starts again, and never claims or ends this one.
    const tabId = this.deps.newTabId()
    for (const [bound, sid] of [...this.bindings]) if (sid === id) this.bindings.delete(bound)
    this.bindings.set(tabId, id)
    this.adoptable.set(id, record)
    this.saveBindings()
    const tab: ReattachTab = { id: tabId, label: held.label, open: true, partner: false }
    return { ok: true, tab }
  }

  // ── bindings ───────────────────────────────────────────────────────────────

  private loadBindings(): void {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.root, BINDINGS), 'utf8')) as { v?: unknown; bindings?: unknown }
      if (v.v !== 1 || !v.bindings || typeof v.bindings !== 'object') return
      for (const [appId, sid] of Object.entries(v.bindings as Record<string, unknown>)) {
        if (APP_PTY_ID_RE.test(appId) && typeof sid === 'string' && SID_RE.test(sid)) this.bindings.set(appId, sid)
      }
    } catch { /* none yet */ }
  }

  private saveBindings(): void {
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(this.root, BINDINGS), JSON.stringify({ v: 1, bindings: Object.fromEntries(this.bindings) }))
    } catch { /* kept in memory for this run */ }
  }
}

// ── the one manager of this run ─────────────────────────────────────────────

let current: SessionHelperManager | null = null

export function setSessionHelper(manager: SessionHelperManager | null): void {
  current = manager
}

// A launch's bindings ask this run's manager whether an update keeps a tab's
// session running (S16 step 4), through the seam that imports neither.
setKeptLaunchCheck((appPtyId) => current?.keepsLaunchOf(appPtyId) === true)
// And a restored tab's launch asks it for the session it keeps for the tab
// to take over (S16 step 5), the same way.
setKeptTakeOver((appPtyId, provider, size, account) => current?.takeOverKept({ sessionId: appPtyId, kind: provider }, size, account) ?? null)
// And what the renderer says of its restored tabs (aicc_planning#423: the
// tabs Resume restored, one shown, one closed) reaches it the same way.
setKeptTabSignals({
  restored: (ids) => current?.restoredTabs(ids),
  shown: (appPtyId) => current?.tabShown(appPtyId),
  closed: (appPtyId) => current?.tabClosed(appPtyId),
})

export function getSessionHelper(): SessionHelperManager | null {
  return current
}

/**
 * The PTY manager's spawn for a shell-only terminal. Exactly node-pty's spawn
 * with these arguments (spawnWithNodePty) unless it is a plain terminal
 * (`ctx.plain`) and the plain terminals' setting is on, or the helper holds a
 * terminal this tab comes back to.
 */
export function spawnPlainPty(ctx: PlainSpawnContext, file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
  const m = current
  if (!m || ctx.plain !== true || (!m.routesPlain() && !m.holdsFor(ctx.sessionId))) return spawnWithNodePty(file, args, opts)
  return m.spawn(ctx, file, args, opts)
}

/**
 * The PTY manager's spawn for a local agent session (2.1.3-beta.7). Exactly
 * node-pty's spawn with these arguments (spawnWithNodePty) unless the agent
 * sessions' setting is on, or this tab's earlier holder is still being ended
 * (then it starts after that end).
 */
export function spawnAgentPty(ctx: AgentSpawnContext, file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
  const m = current
  if (!m || (!m.routesAgents() && !m.endingFor(ctx))) return spawnWithNodePty(file, args, opts)
  return m.spawnAgent(ctx, file, args, opts)
}

/**
 * The spawn for a terminal of a run of the app's own (2.1.3-beta.9, plan
 * section B1): Insights' Claude Code report. Exactly node-pty's spawn with
 * these arguments (spawnWithNodePty) unless the agent sessions' setting is
 * on, or an earlier holder of the same run is still being ended (then it
 * starts after that end); otherwise the agent sessions' path under the run's
 * id (spawnRun).
 */
export function spawnRunPty(ctx: RunSpawnContext, file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
  const m = current
  if (!m || (!m.routesAgents() && !m.endingFor({ sessionId: ctx.runId, kind: ctx.kind }))) return spawnWithNodePty(file, args, opts)
  return m.spawnRun(ctx, file, args, opts)
}

/** True when the app's running mark is in the helper's folder: the last run
 *  that had the helper on did not quit normally. */
export function crashMarkIn(root: string): boolean {
  try {
    return fs.existsSync(path.join(root, MARKER))
  } catch {
    return false
  }
}

/**
 * 2.1.3-beta.15 (plan section B1, aicc_planning#397): a start with both
 * settings off, no running mark and no agent record makes no manager, so the
 * manager's clean-up of old version folders (bringUp) never runs and every
 * update would leave its copy behind. This one runs instead (app-wiring.ts),
 * only when the helper's folder holds a version or staging folder (one folder
 * read, so a user who never used the helper starts nothing): the installed
 * helper lists the holders (no copy is made and no holder is started), and
 * every version folder no listed holder's version needs goes, with the
 * staging folders a failed copy left (removeOldVersionFolders, with no current
 * folder). A listing that fails removes nothing, and so does `stop()`
 * answering true once the listing is back (a setting turned on meanwhile: the
 * manager owns the folder from then, and waits for this to end before it
 * copies, deps.copyAfter). One log line names what went. Answers the folders
 * removed.
 */
export async function removeOldCopiesWithHelperOff(opts: { root: string; bundled: string; stop: () => boolean; log: (message: string) => void; platform?: NodeJS.Platform; exec?: SessionHelperDeps['exec'] }): Promise<string[]> {
  if (!oldCopiesIn(opts.root) || opts.stop()) return []
  let versions: Set<string>
  try {
    if (!fs.statSync(opts.bundled).isFile()) throw new Error('the installed helper is not a file')
    const r = await (opts.exec ?? execHelper)(opts.bundled, ['list', '--store', path.join(opts.root, 'store')], LIST_TIMEOUT_MS)
    if (r.code !== 0) throw new Error(firstLine(r.stderr) || `the helper exited with ${r.code}`)
    const listing = readListing(lastLine(r.stdout), helperOs(opts.platform))
    if (!listing) throw new Error('the helper answered a listing that does not read')
    versions = new Set(listing.sessions.map((s) => s.helper))
  } catch (err) {
    opts.log(`[session-helper] with both settings off, the held terminals could not be listed, so no old helper folder is removed: ${message(err)}`)
    return []
  }
  if (opts.stop()) return []
  const removed = await removeOldVersionFolders(opts.root, null, versions)
  if (removed.length > 0) opts.log(`[session-helper] with both settings off, removed old helper folder(s): ${removed.join(', ')}`)
  return removed
}

/** True when the helper's folder holds a version folder or a staging folder
 *  a failed copy left (one folder read). */
function oldCopiesIn(root: string): boolean {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).some((d) => d.isDirectory() && (d.name.startsWith('.new-') || HELPER_FOLDER_RE.test(d.name)))
  } catch {
    return false
  }
}

/** Why the running mark was left: "update" when an app update let go of the
 *  held terminals (releaseForUpdate); null for a crash, or a mark that does
 *  not read. */
function markReason(marker: string): 'update' | null {
  try {
    const v = JSON.parse(fs.readFileSync(marker, 'utf8')) as { reason?: unknown } | null
    return v && typeof v === 'object' && v.reason === 'update' ? 'update' : null
  } catch {
    return null
  }
}

/**
 * True when the helper's store has a record of an agent session: a holder a
 * run left, because its quit could not wait for the end it sent (or it
 * crashed). The next start makes the manager for it whatever the settings
 * say, so the tab, restored, waits for that holder's end before it starts its
 * CLI again. Read strictly, as the manager reads its store; no holder is asked.
 * A record of one an update kept running (S16 step 4) counts too, read or
 * not, so the start that ends it also removes what it left.
 */
export function agentRecordsIn(root: string, platform?: NodeJS.Platform): boolean {
  return readStore(path.join(root, 'store'), helperOs(platform)).some((r) => heldIdKind(r.session) === 'agent') || readKeptStore(root, helperOs(platform)).length > 0
}

/**
 * The tabs whose agent sessions the helper keeps for the next run (S16 step
 * 4, aicc_planning#359): the app ids its records of sessions an update kept
 * running name. The start-up sweeps of per-session files pass these by
 * (index.ts). The start that reads the records runs before the sweeps: it
 * keeps a record, and the session's files, only for a session it keeps for
 * its tab to take over (S16 step 5); any other it ends, removing its record
 * and files, so only those are passed by.
 */
export function keptSessionIdsIn(root: string): Set<string> {
  const ids = new Set<string>()
  for (const { record } of readKeptStore(root)) if (record) ids.add(record.label)
  return ids
}

/** The Codex hook folders the same records name: the sweep of left-behind
 *  hook folders passes these by, whatever their age (#359). */
export function keptHookFoldersIn(root: string): string[] {
  const out: string[] = []
  for (const { record } of readKeptStore(root)) if (record?.hookFolder) out.push(record.hookFolder)
  return out
}

/** The records in a store folder as written, read strictly; no holder is asked. */
function readStore(store: string, os: HelperOs): HolderRecord[] {
  let names: string[]
  try {
    names = fs.readdirSync(store)
  } catch {
    return []
  }
  const out: HolderRecord[] = []
  for (const name of names) {
    const m = /^(.+)\.json$/.exec(name)
    if (!m || !SID_RE.test(m[1])) continue
    try {
      const r = readRecord(JSON.parse(fs.readFileSync(path.join(store, name), 'utf8')), os)
      if (r && r.session === m[1]) out.push(r)
    } catch { /* being written, or not a record */ }
  }
  return out
}

/**
 * The command line node-pty gives Windows for a program and an argument line
 * passed as one string (node-pty windowsPtyAgent.js argsToCommandLine): the
 * program, quoted the way node-pty quotes one argument, a space, then the
 * line exactly; the program alone, as it is, for an empty line.
 */
export function nodePtyCommandLine(file: string, line: string): string {
  return line.length === 0 ? file : `${quoteLikeNodePty(file)} ${line}`
}

/** One argument as node-pty's argsToCommandLine writes it. */
function quoteLikeNodePty(arg: string): string {
  const first = arg[0]
  const last = arg[arg.length - 1]
  const lopsided = (first !== '"') !== (last !== '"')
  const unquoted = first !== '"' && last !== '"'
  const quote = arg === '' || ((arg.includes(' ') || arg.includes('\t')) && arg.length > 1 && (lopsided || unquoted))
  let out = quote ? '"' : ''
  let backslashes = 0
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i]
    if (c === '\\') {
      backslashes++
    } else if (c === '"') {
      out += `${'\\'.repeat(backslashes * 2 + 1)}"`
      backslashes = 0
    } else {
      out += `${'\\'.repeat(backslashes)}${c}`
      backslashes = 0
    }
  }
  return quote ? `${out}${'\\'.repeat(backslashes * 2)}"` : `${out}${'\\'.repeat(backslashes)}`
}

/**
 * A terminal in which nothing started: it shows `text` once and ends at once
 * (exit code 1), as a session whose program failed does. For an agent
 * session that may not start while its tab's earlier holder still runs.
 */
function notStartedPty(text: string, opts: SpawnOptions): IPty {
  const onData = new Set<(d: string) => void>()
  const onExit = new Set<(e: { exitCode: number; signal?: number }) => void>()
  let over = false
  const end = () => {
    if (over) return
    over = true
    for (const l of [...onExit]) { try { l({ exitCode: 1 }) } catch { /* the listener's own */ } }
  }
  const p = {
    pid: 0,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    process: '',
    handleFlowControl: false,
    onData: (l: (d: string) => void) => { onData.add(l); return { dispose: () => { onData.delete(l) } } },
    onExit: (l: (e: { exitCode: number; signal?: number }) => void) => { onExit.add(l); return { dispose: () => { onExit.delete(l) } } },
    write: () => { /* nothing runs */ },
    resize: () => { /* nothing runs */ },
    clear: () => { /* nothing runs */ },
    pause: () => { /* nothing runs */ },
    resume: () => { /* nothing runs */ },
    kill: () => end(),
  }
  // After the caller's listeners are on, as node-pty's own events come.
  setTimeout(() => {
    if (over) return
    for (const l of [...onData]) { try { l(`\r\n${text}\r\n`) } catch { /* the listener's own */ } }
    end()
  }, 0)
  return p as unknown as IPty
}

/** Waits for `p`, or `ms`, whichever is first; never throws. */
function waitAtMost(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([p.then(() => undefined, () => undefined), new Promise<void>((r) => { timer = setTimeout(r, ms) })]).finally(() => clearTimeout(timer))
}

/**
 * Calls `then` with whether this PTY shows a held terminal, once that is known:
 * true when a take-over attached (nothing is typed into it at launch), false for
 * any other terminal and for a take-over that failed and started a new shell the
 * usual way. Synchronously when it is known already (every terminal not through
 * the helper), so the usual launch keeps its timing.
 */
export function whenHeldKnown(p: unknown, then: (held: boolean) => void): void {
  if (!(p instanceof HelperPty)) { then(false); return }
  if (p.adoptionKnown !== undefined) { then(p.adoptionKnown); return }
  void p.adoption.then(then)
}
