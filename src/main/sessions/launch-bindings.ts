// A launch's bindings (S16 step 3, aicc_planning#375): what the app makes
// around a local Claude Code or Codex session's process, and drops when the
// session ends. Moved here from pty-manager.ts with no change in behaviour: the
// same calls in the same order and the same log lines, each function called
// where its code was. A take-over of a held agent session (S16 step 5) makes
// the same bindings for a CLI that is already running by calling the same
// functions.
//
// 2.1.3-beta.19 section 2 (aicc_planning#439): each provider's own part is its
// package's lifecycle object (SessionProvider.lifecycle; providers/claude and
// providers/codex lifecycle.ts): the bind a launch makes once its process has
// started, the take-over's bindings, the serving while a tab is not shown,
// the teardown's first part and the description for keeping. This module asks
// the session's provider for it through the registry, never by its name or
// its launch style, and hands it pty-manager.ts's records (lifecycleCore).
//
// A Codex launch, in its order (providers/codex/local-launch.ts):
// mintCodexHooks (before its command is built), keepCodexHooks (once it is
// built), bindCodexLease (right before the spawn), then bindCodexPane and its
// lifecycle's bind (after it). A Claude Code launch: its lifecycle's bind,
// right after its spawn. Every launch: bindLoggingRun, once the session is
// registered. The end of a session: unbindLaunchFiles at its own exit, or at
// once at a quit's or an update's kill (killAllPty and gracefulExitPty's
// forced kill: the app may be gone before the exit is reported,
// aicc_planning#385; a Codex launch's waits for its exit), and in the teardown
// every kill and every exit runs (cleanupSessionResources)
// unbindLaunchProvider (the session's provider's own unbind),
// unbindLaunchTelemetry and unbindLaunchRegistrations, each at its own place
// in that teardown.
//
// S16 step 4 (aicc_planning#387, #359): a session an app update keeps running
// (kept-launches.ts launchKeptForUpdate) keeps what its launch put on disk
// through its kill: unbindLaunchFiles leaves its three per-session files, and
// unbindLaunchTelemetry its Codex hook folder and (aicc_planning#419) its
// resume list's pick folder. What the unbinds drop from this
// run's memory still goes. describeLaunch says what the release records of
// it, and removeKeptLaunchFiles removes what it left once it is no longer kept.
//
// S16 step 5 (2.1.3-beta.17, aicc_planning#412): the next start's restored tab
// takes such a Claude Code or Codex session over in place of its launch
// (takeOverKeptLaunch): the session helper shows its terminal again, and its
// provider's lifecycle object makes the launch's bindings again for the CLI
// that runs, with no launch. A Codex session's hook file is written again in
// its kept folder with a token minted for the take-over.
//
// aicc_planning#423 (B1d): until then, a session kept for a restored tab that
// is not shown yet is served its Conductor tool calls (serveKeptLaunchUnseen:
// the tool host's record and the review and canvas registrations, and a Codex
// session's hook file written again), with nothing of its account, telemetry
// or conversation. The take-over's own teardown clears that first, and
// unserveKeptLaunchUnseen drops it when the session is kept no longer.
// B1e: that teardown leaves a Codex session's served token for the take-over
// to write its own over (keepServedToken), so the hook events the Hooks
// gateway took for the tab stay in its record; and pty-manager.ts binds no
// transcript a session kept for its tab names until its take-over
// (keptForItsTab).
//
// What stays in pty-manager.ts, and why:
//  - the per-session records and the helpers that keep them, which much of
//    pty-manager.ts reads: it hands them over once, when it loads
//    (setLaunchBindingPorts), so this module imports nothing of it;
//  - the two raw writers into a Codex PTY, the pane's and the colour answer's:
//    they are handed in, and the session input check
//    (tests/unit/main/session-input-ownership.test.ts) counts them there;
//  - Ask Conductor's opening question, typed through a door only
//    pty-manager.ts may use (session-input's askQuestion), and the run
//    screens, which pty-manager.ts closes for this module;
//  - every comparison with a provider name: pty-manager.ts works each one out
//    and hands the answer in (tests/unit/architecture/provider-name-ratchet.test.ts,
//    which counts tests of a launch style, a style standing for a provider:
//    this module holds none).
import * as fs from 'fs'
import { nativeTheme } from 'electron'
import type * as pty from 'node-pty'
import { PROVIDER_IDS, type ProviderId } from '../../shared/providers'
import type { AccountLease } from '../providers/core'
import type { LifecycleCore, LifecycleTakeOver, ProviderLifecycle, SessionProvider, SessionRunScreen, TelemetrySource } from '../providers/types'
import { getGateway } from '../hooks'
import { removeLocalSessionSettings, removeLocalSessionMcpConfig, removeLocalSessionStatusUrl, getLocalSessionStatusUrlPath, writeLocalSessionStatusUrl } from '../hooks/per-session-settings'
import { logInfo, logError, logWarn } from '../debug-logger'
import { readConfig } from '../config-manager'
import { resolveCwd } from '../path-utils'
import { clampAnsiChunk } from '../watchdog/watchdog-manager'
import { createColorQueryResponder, terminalReplyColors, type ColorQueryResponder } from '../terminal-query-responder'
import { shouldRegisterRun } from '../logging/should-register-run'
import { getLogSupervisor } from '../logging/logging-service'
import { getCodexLogBinder } from '../logging/codex-log-binder'
import { buildResumeTranscriptPath } from '../spawn-claude-command'
import { clearClaudeAccount, getAccountIdentity, stopWatchingAccountIdentity } from '../claude-account-identity'
import { unregisterCodexReviewSession, releaseMcpSessionProvider, recordHeldToolSession, getConductorMcpPort } from '../conductor-mcp-server'
import { revokeCanvasUatRoots } from '../canvas/canvas-store'
import { forgetCanvasMarkers } from '../canvas/canvas-marker-delivery'
import { forgetCodexSessionGuidance } from '../canvas/codex-guidance'
import { tryGetProvider } from '../providers'
import { launchKeptForUpdate, setKeptLaunchBindings, takeKeptSession, type KeptLaunch, type KeptLaunchFacts, type KeptUnseen } from './kept-launches'
import { HelperPty } from '../session-helper/helper-pty'
// B1e: pty-manager.ts's hook transcript route asks it, through this module (its one import of the kept-session seam).
export { keptForItsTab } from './kept-launches'

/** A Codex launch's hook file: the file that hands its gateway token to the
 *  hook, with the way to remove it. */
export interface CodexHookFile { hookFile: string; dispose(): void }

/** What a Codex launch holds of its hooks between mintCodexHooks and
 *  keepCodexHooks: the hook file, and whether the launch minted the session's
 *  gateway token. The launch (providers/codex/local-launch.ts) keeps both for its failed-launch path. */
export interface CodexHooks { hookFile: CodexHookFile | null; tokenMinted: boolean }

/** The per-session records and helpers of pty-manager.ts that a launch's
 *  bindings read and write, handed over once when it loads. Each is
 *  pty-manager.ts's own; this module keeps no record of its own. */
export interface LaunchBindingPorts {
  ptySessions: ReadonlyMap<string, { ptyProcess: pty.IPty }>
  codexHookFiles: Map<string, CodexHookFile>
  codexHookedLaunches: Set<string>
  codexLaunchLeases: Map<string, AccountLease>
  takenCodexLeases: WeakSet<AccountLease>
  codexAskSessions: Set<string>
  codexTelemetrySources: Map<string, TelemetrySource>
  indexedRuns: Map<string, { configId?: string; provider: ProviderId }>
  notIndexedSessions: Map<string, { since: number; provider: ProviderId }>
  codexContextRollouts: Map<string, { path: string; sessionsDir: string }>
  keptCodexConversations: Pick<Map<string, { uuid: string }>, 'delete' | 'get'>
  lastCodexHookRollout: Pick<Map<string, unknown>, 'delete'>
  claudeTranscripts: Pick<Map<string, string>, 'delete' | 'get'>
  claudeFolders: Pick<Map<string, unknown>, 'delete'>
  codexFolders: Pick<Map<string, unknown>, 'delete'>
  noteGatewayToken(sessionId: string, codex: boolean): void
  dropGatewayToken(sessionId: string): void
  forgetCodexHooks(sessionId: string): void
  keepCodexConversation(sessionId: string, conversation: { uuid: string; cwd: string }, accountId?: string, how?: { inferred: boolean }): void
  markCodexConversationUncertain(uuid: string): void
  clearCodexDoubtFromHook(uuid: string): void
  noteCodexContextRollout(sessionId: string, rollout: { path: string; sessionsDir: string } | null): void
  endSessionNotIndexed(sessionId: string, now: number, opts?: { coversStay?: boolean }): void
  noteCodexFolder(sessionId: string, cwd: string): void
  savedConfigLoggingOff(configs: unknown, configId: string | undefined, provider: ProviderId): boolean | undefined
  noteClaudeFolder(sessionId: string, launchCwd: string): void
  noteClaudeTranscript(sessionId: string, transcriptPath: string): void
  markSessionNotIndexed(sessionId: string, provider: ProviderId, since: number, now?: number): void
  /** Closes the session's reading in every registered provider's run screen
   *  (Codex's pane, or a held run's holder's screen; session-input's
   *  closeRunScreens since 2.1.3-beta.18 section 4), which only
   *  pty-manager.ts reaches. */
  closeCodexRunScreen(sessionId: string): void
  /** Where a local agent process works, until its exit (pty-manager.ts's
   *  record for ending the runs in a folder). */
  noteAgentRunFolder(proc: pty.IPty, sessionId: string, folder: string): void
  /** A Codex run's two raw writers, its pane's and its colour answer's
   *  (pty-manager.ts's, where the session input check counts them), for a
   *  take-over's pane as for a launch's. */
  codexRunWriters(codexRun: pty.IPty): Pick<CodexPaneBinding, 'write' | 'writeColourAnswer'>
  /** The sessions whose latest gateway token a Codex launch minted
   *  (pty-manager.ts's record, read for holdsCodexGatewayToken). */
  codexGatewayTokens: ReadonlySet<string>
}

let registered: LaunchBindingPorts | null = null

/** pty-manager.ts hands its records and helpers over, once, when it loads. */
export function setLaunchBindingPorts(p: LaunchBindingPorts): void {
  registered = p
}

function ports(): LaunchBindingPorts {
  if (!registered) throw new Error('The launch bindings were used before the PTY manager registered its ports.')
  return registered
}

/** A Codex run's reading of its screen (its pane, or B2 its holder's screen), from the launch that started it. */
export interface CodexPaneBinding {
  sessionId: string
  /** The run's process: the reading is current while the session's PTY is this one. */
  codexRun: pty.IPty
  /** The provider's own reading of a run's screen, when it has one. */
  runScreen: SessionRunScreen | undefined
  cols: number
  rows: number
  /** The raw writer the run screen types through: pty-manager.ts's, into codexRun. */
  write: (data: string) => void
  /** Writes one colour answer into codexRun: pty-manager.ts's. */
  writeColourAnswer: (bytes: string) => void
}

/** A launch's logging run, from the launch. The answers that compare a
 *  provider name are pty-manager.ts's. */
export interface LoggingRunBinding {
  sessionId: string
  options: (Parameters<typeof shouldRegisterRun>[0] & { configId?: string; configLabel?: string }) | undefined
  localLaunch: { id: ProviderId } | null
  effectiveLaunchCwd: string
  resumeUuidForBind: string | null
  resolvedProfileId: string | undefined
  codexLaunchedAt: number | undefined
  claudeLaunchedAt: number | undefined
  /** The assistant whose config switch the run follows: Codex for a Codex session, else Claude Code. */
  runProvider: ProviderId
  /** A local Codex session (neither SSH nor a terminal tab). */
  codexRunProvider: boolean
  /** A local Claude Code session (neither SSH nor a terminal tab). */
  claudeRunProvider: boolean
  /** The assistant the run row names: the session's own, Claude Code when it names none. */
  provider: ProviderId
}

/** What the launch reads back from its logging run. */
export interface LoggingRun {
  /** The log service the run is registered with; null when it is not indexed. */
  logSup: ReturnType<typeof getLogSupervisor> | null
  /** A local Codex run, whose transcript the Codex log binder binds. */
  codexLocalRun: boolean
}

/**
 * A Codex launch's hooks, before its command is built (P3.10, rows 43, 46, 47,
 * 63): when the Hooks gateway is on and listening, a token minted for the
 * session and the file that hands it to the hook (never a command line). A
 * launch that could not prepare them gets no hook file; a token it minted is
 * in the answer, so its failure path gives it back. A throw from the gateway
 * itself goes on to that path with nothing minted.
 */
export function mintCodexHooks(sessionId: string, provider: SessionProvider): CodexHooks {
  const { noteGatewayToken } = ports()
  let hookFile: CodexHookFile | null = null
  let tokenMinted = false
  const gw = getGateway()
  const gwStatus = gw?.status()
  if (gw && gwStatus?.listening && gwStatus.port && provider.prepareSessionHooks) {
    try {
      const secret = gw.registerSession(sessionId)
      tokenMinted = true
      noteGatewayToken(sessionId, true)
      // Round 1 (A5): in the app's own data folder; round 4 (P1): in the
      // hook folder prepared beforehand (owner-only, checked here without
      // starting anything), else no hooks.
      hookFile = provider.prepareSessionHooks(sessionId, gwStatus.port, secret)
    } catch (err) {
      logError(`[pty] Failed to prepare Codex hooks for ${sessionId}: ${(err as Error)?.message ?? err}`)
      hookFile = null
    }
  }
  return { hookFile, tokenMinted }
}

/**
 * Once the command is built: a hook file the launch carries is kept with the
 * session and the launch is marked hooked; one it does not carry goes at once.
 * The answer holds no hook file, and the token only while the launch carries it.
 */
export function keepCodexHooks(sessionId: string, hooks: CodexHooks, hooked: boolean): CodexHooks {
  const { codexHookFiles, codexHookedLaunches, dropGatewayToken } = ports()
  let { hookFile, tokenMinted } = hooks
  // P3.10: a hook file the launch did not use goes at once; one it uses
  // goes with the session's resources. Round 1 (B2): a token nothing will
  // use (no hook file, or hooks the launch could not carry) goes too.
  if (hookFile && hooked) {
    codexHookFiles.set(sessionId, hookFile)
    codexHookedLaunches.add(sessionId)
  } else if (hookFile) {
    try { hookFile.dispose() } catch { /* best-effort */ }
  }
  hookFile = null
  if (tokenMinted && !hooked) {
    dropGatewayToken(sessionId)
    tokenMinted = false
  }
  return { hookFile, tokenMinted }
}

/** The account lease is the session's from here, right before its PTY spawns
 *  (WP2, plan A10). The Codex lifecycle's unbind (unbindLaunchProvider) releases it with the session's resources,
 *  and a failed launch through its own path. */
export function bindCodexLease(sessionId: string, lease: AccountLease): void {
  const { codexLaunchLeases, takenCodexLeases } = ports()
  codexLaunchLeases.set(sessionId, lease)
  takenCodexLeases.add(lease)
}

/**
 * A Codex run's pane (WP2 PR 4, P4.1), once its process has started: main's
 * own reading of the run's screen for the submit primitive, current while the
 * session's PTY is this run, and Codex's colour answers. Answers the colour
 * responder, whose filter the run's data handler reads each chunk through.
 *
 * 2.1.3-beta.14 B2 (aicc_planning#388): a run the session helper may hold
 * (its terminal is a HelperPty) is read from its holder's screen when, at its
 * first byte, that terminal is on a holder whose connection reads the screen
 * and its title (HelperPty.screenRead; the title from 2.1.3-beta.15); then no
 * pane is opened for it. Otherwise, and for a run node-pty started, the pane,
 * as before: one opened at the first byte still has every byte of the run's
 * output.
 */
export function bindCodexPane(binding: CodexPaneBinding): ColorQueryResponder {
  const { ptySessions } = ports()
  const { sessionId, codexRun, runScreen, cols, rows, write, writeColourAnswer } = binding
  const held = codexRun instanceof HelperPty ? { held: () => codexRun.screenRead } : {}
  if (codexRun && runScreen) runScreen.open(sessionId, { cols, rows, write, current: () => ptySessions.get(sessionId)?.ptyProcess === codexRun, clamp: clampAnsiChunk, ...held })
  // Codex's colour query (OSC 10/11 `?`), answered here in main the moment
  // the PTY emits it and kept from the renderer, so xterm.js does not answer
  // it a second time (terminal-query-responder.ts). Codex waits 100 ms for
  // the answer and reads a later one as typed text in its composer; the
  // renderer's answer can be later than that while it is busy drawing.
  // Only for the run bound here: Claude sessions, plain terminals and SSH
  // sessions keep xterm.js's own answers.
  const colorQueries = createColorQueryResponder({
    colors: () => terminalReplyColors(readConfig('settings'), nativeTheme.shouldUseDarkColors),
    reply: (bytes) => {
      try { writeColourAnswer(bytes) } catch (err) { logWarn(`[pty-manager] Codex ${sessionId}: the terminal colour answer could not be written: ${(err as Error)?.message ?? err}`) }
    },
  })
  return colorQueries
}

/**
 * The launch's logging run (Logs v2; P3.12, P3.16), once the session is
 * registered, for every launch (an SSH session and a terminal tab too, which
 * are never indexed): registered with the transcripts worker under the logging
 * switches, or marked not indexed, and a local Codex run's log binder started.
 */
export function bindLoggingRun(binding: LoggingRunBinding): LoggingRun {
  const { savedConfigLoggingOff, noteClaudeFolder, noteClaudeTranscript, indexedRuns, markSessionNotIndexed } = ports()
  const {
    sessionId, options, localLaunch, effectiveLaunchCwd, resumeUuidForBind, resolvedProfileId, codexLaunchedAt, claudeLaunchedAt,
    runProvider, codexRunProvider, claudeRunProvider, provider,
  } = binding
  // Record the run via the transcripts worker pipeline (Logs v2). Gated on the
  // live `loggingEnabled` setting (default-true) and never for shell-only
  // sessions (full gating refinement = Task 9). The captured account (set by
  // Claude Code's lifecycle bind for non-shell Claude sessions) + configId/profileId are stamped
  // so runs can be filtered by config/account.
  const configLabel = options?.configLabel || 'default'
  // Reading settings here (rather than relying solely on the supervisor's
  // existence) gives a LIVE disable: if logging was enabled at boot (so the
  // supervisor is running) but the user later turns it off in Settings, new
  // runs are skipped immediately — the worker keeps running idle. Asymmetry: if
  // logging was DISABLED at boot there is no supervisor, so a mid-run enable
  // needs a restart.
  const settings = readConfig<{ loggingEnabled?: boolean; loggingConsentSeen?: boolean; loggingConsentVersion?: number }>('settings') ?? {}
  // P3.12 round 2 (W3): the config's own switch as saved now (a Restart, a
  // Switch Account or a restore carries the value it was launched with).
  const savedOff = savedConfigLoggingOff(readConfig<unknown>('configs'), options?.configId, runProvider)
  const registerOptions = savedOff === undefined ? (options ?? {}) : { ...(options ?? {}), loggingEnabled: !savedOff }
  // Single source of truth for the run-registration decision (Task 9):
  // local Claude or (P3.12) local Codex, not shell-only, not SSH, per-config
  // loggingEnabled !== false, global loggingEnabled !== false. The matching
  // runEnd/endRun on exit are gated on this same `logSup` being non-null, so a
  // run is only ended if it was registered.
  const registersRun = shouldRegisterRun(registerOptions, settings)
  const logSup = registersRun ? getLogSupervisor() : null
  // P3.12 round 1 (V1): a spawn that is not indexed (logging off, a shell, SSH)
  // ends whatever run this session id still had open (a Restart's old process
  // exits after this spawn, so its own exit does not), so nothing is added to
  // it; one that is indexed is recorded for the logging switches.
  // P3.16 (M1): a local Claude session's projects folder (round 1, N1) and,
  // when it resumes one exactly, its conversation are known at launch; its
  // hooks and status line name the transcript after.
  if (claudeRunProvider && effectiveLaunchCwd) noteClaudeFolder(sessionId, effectiveLaunchCwd)
  if (claudeRunProvider && resumeUuidForBind && effectiveLaunchCwd) {
    const resumed = buildResumeTranscriptPath(effectiveLaunchCwd, resumeUuidForBind)
    if (resumed) noteClaudeTranscript(sessionId, resumed)
  }
  if (logSup) {
    // A run is registered only for a local launch that starts a provider
    // (shouldRegisterRun leaves out SSH sessions and terminal tabs), so it is
    // indexed under the provider this launch looked up in the registry.
    indexedRuns.set(sessionId, { ...(options?.configId ? { configId: options.configId } : {}), provider: localLaunch?.id ?? runProvider })
  } else {
    indexedRuns.delete(sessionId)
    try { getLogSupervisor()?.runEnd(sessionId, Date.now(), 'exited') } catch { /* best-effort */ }
    // P3.12 (X1, X3): a local session running not indexed marks the
    // conversations it is on (P3.16 M1: a Claude session as a Codex one).
    // Round 1 (N3): only a run the switches and rules leave out; one they
    // index whose log service is missing this time marks nothing.
    if (!registersRun) {
      if (codexRunProvider) markSessionNotIndexed(sessionId, runProvider, codexLaunchedAt ?? Date.now(), Date.now())
      else if (claudeRunProvider) markSessionNotIndexed(sessionId, runProvider, claudeLaunchedAt ?? Date.now(), Date.now())
    }
  }
  logSup?.runStart({
    sessionId,
    configId: options?.configId,
    configLabel,
    // FIX 4: the effective launch cwd (resume override when active, else the
    // configured resolvedCwd) — not the bare resolvedCwd.
    projectCwd: effectiveLaunchCwd,
    // accountEmail is typically undefined here: identity is captured asynchronously
    // AFTER spawn (recheckSessionIdentity / startWatchingAccountIdentity wired in
    // Claude Code's lifecycle bind). The run row therefore stamps a null email; configId and
    // profileId ARE stamped correctly at spawn. runAccount() back-fills the email
    // once the identity poll resolves (wired in a later task).
    accountEmail: getAccountIdentity(sessionId)?.email,
    profileId: resolvedProfileId,
    provider,
    startedAt: Date.now(),
  })
  // P3.12 (row 31): a local Codex run's transcript is the rollout its own
  // watcher claims (the Codex log binder, told by the Codex lifecycle bind's onRollout), bound
  // from here on; Claude's discovery after this, in pty-manager.ts (its heuristic scan of
  // ~/.claude/projects, its resume-bind) is Claude's alone.
  const codexLocalRun = codexRunProvider
  if (codexLocalRun) getCodexLogBinder()?.startRun(sessionId, !!logSup)
  return { logSup, codexLocalRun }
}

/** A restored tab's launch, which a take-over replaces (2.1.3-beta.17, S16
 *  step 5): the provider the launch looked up (pty-manager.ts LocalLaunch),
 *  whose lifecycle object makes the take-over's bindings (2.1.3-beta.19
 *  section 2: by the provider, never by a name or a launch style), the
 *  configured folder resolved, the terminal's size, a Codex launch's
 *  preparation (its lease and sessions folder), the account a Claude Code
 *  launch names, and an Ask Conductor launch (providers/types.ts
 *  LifecycleTakeOver). */
export type KeptTakeOverBinding = LifecycleTakeOver

/** What a take-over hands back to the launch it replaces: the session's
 *  terminal, and what its logging run and transcript binding read in place
 *  of a launch's. */
export interface KeptSessionTakenOver {
  ptyProcess: pty.IPty
  /** The folder its CLI was launched in: the record's, else the configured folder. */
  launchCwd: string
  /** The conversation it is on, or null. */
  conversation: string | null
  /** The account profile it runs on; undefined for the default account. */
  profileId: string | undefined
  /** The moment its not-indexed windows open from: when the update let go
   *  of it (never later than now), so what its CLI wrote while no app ran is
   *  in a window; now when the record does not say. */
  since: number
}

/**
 * 2.1.3-beta.17 (plan section B1, S16 step 5, aicc_planning#412): the
 * restored tab of a Claude Code or Codex session the last run's update kept
 * running takes it over, in place of its launch (pty-manager.ts, one entry
 * before the provider branches). Null when the session helper keeps no
 * session for this tab and provider on the account the tab's launch is
 * prepared on (a Codex one's lease, or the account a Claude Code launch
 * names), or for a Codex launch with no preparation: then the launch runs as
 * before, and ends the kept session first. A Claude Code session runs on the
 * account it names or not at all, so one kept on another account (Settings,
 * Accounts, 'Ask each time', then another account picked) is never taken over.
 *
 * Nothing is launched and nothing typed: the resume, the per-session files
 * and the launch line are skipped, as the CLI runs. What the launch binds is
 * made again for that CLI, before its holder is attached, by the session's
 * provider's lifecycle object (2.1.3-beta.19 section 2; providers/claude and
 * providers/codex lifecycle.ts): the tool host's record of the session, with
 * no credential (its tool streams come through its holder), and where the run
 * works, here; the rest there (Claude Code: its status line's address file,
 * its account capture and registrations, its data handler; Codex: its hook
 * file, none when its hook events go through its holder, its lease, its
 * conversation, its pane and colour answers, its data handler, its telemetry
 * and registrations). A provider with no lifecycle object is not taken over.
 * The session's entry, its watchdog, its logging run and, for Claude Code,
 * its transcript binding (by the saved conversation, from the folder it runs
 * in) follow in pty-manager.ts from what this answers, before its hook events
 * can bind a transcript.
 */
export function takeOverKeptLaunch(b: KeptTakeOverBinding): KeptSessionTakenOver | null {
  const lifecycle = b.launch.provider.lifecycle
  // The account its provider asks for: none (a Codex launch with no
  // preparation, whose lease names the account), any, or one. B1e: no
  // take-over: a token its serving kept goes before the launch mints its own.
  const wanted = lifecycle?.keptAccount(b)
  if (!lifecycle || !wanted) { settleServedToken(b.sessionId); return null }
  const size = { cols: b.cols, rows: b.rows }
  const taken = 'account' in wanted ? takeKeptSession(b.sessionId, b.launch.id, size, wanted.account) : takeKeptSession(b.sessionId, b.launch.id, size)
  if (!taken) { settleServedToken(b.sessionId); return null }
  const { pty: proc, kept } = taken
  const launchCwd = kept.folder ?? b.resolvedCwd
  let profileId: string | undefined
  try {
    noteLaunchProvider(b.sessionId, b.launch.id)
    recordHeldToolSession(b.sessionId, b.launch.id)
    ports().noteAgentRunFolder(proc, b.sessionId, launchCwd)
    profileId = lifecycle.takeOver(b, proc, kept, launchCwd, lifecycleCore())
  } catch (err) {
    // As a launch that failed after its process started: its CLI is ended
    // (the holder's end), what was bound goes, and the throw goes on to the
    // spawn's caller. Its tab reads the failure, and a Restart resumes it.
    logWarn(`[pty] ${b.sessionId}: the take-over failed after it attached; its CLI is ended (${(err as Error)?.message ?? err})`)
    try { proc.kill() } catch { /* already gone */ }
    servedTokens.delete(b.sessionId)
    try { ports().dropGatewayToken(b.sessionId) } catch { /* best-effort */ }
    for (const unbind of [unbindLaunchProvider, unbindLaunchTelemetry, unbindLaunchRegistrations, clearClaudeAccount, stopWatchingAccountIdentity]) {
      try { unbind(b.sessionId) } catch { /* best-effort */ }
    }
    // What its launch left on disk goes too, as a failed launch's does: no
    // exit handler of this session will remove it.
    removeFailedLaunchFiles(b.sessionId)
    if (kept.hookFolder) {
      try { b.launch.provider.removeSessionHookFolder?.(kept.hookFolder) } catch { /* best-effort; the sweep remains */ }
    }
    if (kept.pick) {
      try { b.launch.provider.removeSessionPickFolder?.(kept.pick) } catch { /* best-effort */ }
    }
    throw err
  }
  logInfo(`[pty] ${b.sessionId}: took over the session the last update kept running, with no launch (conversation ${kept.conversation ?? 'none'})`)
  const now = Date.now()
  return { ptyProcess: proc, launchCwd, conversation: kept.conversation, profileId, since: kept.at > 0 ? Math.min(kept.at, now) : now }
}

/** Sessions kept for a restored tab not shown yet that serveKeptLaunchUnseen
 *  served (B1d), until a launch's teardown of the tab's id
 *  (unbindLaunchRegistrations) or its unserving clears the mark. */
const unseenServed = new Set<string>()

/**
 * aicc_planning#423 (B1d): the session an update kept for a restored tab
 * that is not shown yet is served its Conductor tool calls until its
 * take-over, as the take-over serves them, so its running turn's tool calls
 * do not wait in its relay and get the answer that the app is updating. Only
 * while the tool host is serving (false otherwise, and nothing is bound):
 * the tool host's record of the session with no credential, and the review
 * and canvas registrations, from the tab's configured folder (`cwd`, the
 * renderer's, resolved as a launch's is) by its provider's lifecycle object
 * (2.1.3-beta.19 section 2: not served when it has none); for a Codex session
 * with a kept hook folder, its hook file written again with a new token
 * (providers/codex/lifecycle.ts rewriteKeptCodexHooks), so its hook events reach this run, unless its hook
 * events go through its holder (2.1.3-beta.18, the record's mark: its keeper
 * takes them). Nothing of the account, the telemetry, the logging run or
 * the conversation, and no hook file or hooked launch is recorded, so no
 * hook claims a transcript before its take-over. The take-over's spawn runs
 * the teardown first (killPty), which clears all of it and the mark (B1e:
 * but leaves the gateway token, keepServedToken, for the take-over to write
 * its own over), and makes it again. What this bound goes with
 * unserveKeptLaunchUnseen.
 */
export function serveKeptLaunchUnseen(kept: KeptUnseen, cwd: string | undefined): boolean {
  if (!(getConductorMcpPort() > 0)) return false
  const provider = tryGetProvider(kept.provider)
  const lifecycle = provider?.lifecycle
  if (!provider || !lifecycle) return false
  const { sessionId } = kept
  const resolvedCwd = resolveCwd(cwd)
  try {
    recordHeldToolSession(sessionId, kept.provider)
    unseenServed.add(sessionId)
    lifecycle.serveUnseen(kept, provider, resolvedCwd, lifecycleCore())
  } catch (err) {
    logWarn(`[pty] ${sessionId}: the session kept for this tab could not be served its Conductor tools while its tab is not shown (${(err as Error)?.message ?? err})`)
    unserveKeptLaunchUnseen(sessionId)
    return false
  }
  logInfo(`[pty] ${sessionId}: the session kept for this tab is served its Conductor tools while its tab is not shown`)
  return true
}

/** B1e: sessions whose gateway token, minted when they were served while
 *  their tab was not shown, the kill before a launch of the tab kept
 *  (keepServedToken), until that launch or the session's end settles it. */
const servedTokens = new Set<string>()

/**
 * aicc_planning#423 (B1e): the kill before a launch of the tab (pty-manager.ts
 * endLiveRun) leaves the gateway token of a session served while its tab was
 * not shown, rather than unregistering it, which would also drop the hook
 * events the Hooks gateway took for the tab: the take-over that follows writes
 * its own token over it (providers/codex/lifecycle.ts codexTakeOver), and the gateway keeps those events
 * in the tab's record. Settled by that launch (takeOverKeptLaunch) or the
 * session's end (unserveKeptLaunchUnseen). True when left.
 */
export function keepServedToken(sessionId: string): boolean {
  if (!unseenServed.has(sessionId)) return false
  servedTokens.add(sessionId)
  return true
}

/** B1e: a token keepServedToken left is settled: `replaced` when the
 *  take-over wrote its own over it; otherwise it goes now, with the events
 *  the gateway holds for it, unless a launch since has made the session's
 *  token another's (a Claude Code launch's). */
function settleServedToken(sessionId: string, replaced = false): void {
  if (!servedTokens.delete(sessionId) || replaced) return
  if (ports().codexGatewayTokens.has(sessionId)) ports().dropGatewayToken(sessionId)
}

/** B1d: a session served while its tab was not shown is kept no longer: what
 *  serveKeptLaunchUnseen bound goes (its registrations and its gateway
 *  token). Nothing when the mark is gone: a launch of the tab has torn it
 *  down already and bound its own, which stay. B1e: a token that teardown
 *  left goes (settleServedToken): a tab's close kills first (pty:kill). */
export function unserveKeptLaunchUnseen(sessionId: string): void {
  settleServedToken(sessionId)
  if (!unseenServed.has(sessionId)) return
  unbindLaunchRegistrations(sessionId)
  ports().dropGatewayToken(sessionId)
}

/** Whether a Codex launch's gateway token is the session's latest (one
 *  served while its tab is not shown too, B1d): its hook events are Codex's,
 *  for the attention source, whether or not a PTY of it runs here. */
export function holdsCodexGatewayToken(sessionId: string): boolean {
  return registered?.codexGatewayTokens.has(sessionId) === true
}

/** The session's own end (its exit, when no newer process has taken the
 *  session over, or a quit's or an update's kill: killAllPty and
 *  gracefulExitPty's forced kill, which the app does not outlive,
 *  aicc_planning#385; a Codex launch's waits for its exit): its gateway
 *  token and its per-session files go. A session an app update keeps running
 *  keeps its files (S16 step 4): its CLI still reads them, and
 *  removeKeptLaunchFiles removes them once it is not kept. */
export function unbindLaunchFiles(sessionId: string): void {
  const { dropGatewayToken } = ports()
  // (P3.10 round 1, B1: with the record that a Codex launch minted it.)
  dropGatewayToken(sessionId)
  if (launchKeptForUpdate(sessionId)) return
  removeLocalSessionSettings(sessionId)
  removeLocalSessionMcpConfig(sessionId)
  // ADR-009 token custody: the status-URL sidecar carries this session's MCP
  // token, so it is swept on the SAME teardown as the other two.
  removeLocalSessionStatusUrl(sessionId)
}

/** A local launch that failed after its process started (pty-manager.ts's
 *  unwinding of it): its three per-session files, each removed
 *  best-effort, in the order its exit removes them. Moved here with no change
 *  (2.1.3-beta.17), so pty-manager.ts stays within its line cap. */
export function removeFailedLaunchFiles(sessionId: string): void {
  try { removeLocalSessionSettings(sessionId) } catch { /* best-effort */ }
  try { removeLocalSessionMcpConfig(sessionId) } catch { /* best-effort */ }
  try { removeLocalSessionStatusUrl(sessionId) } catch { /* best-effort */ }
}

/** 2.1.3-beta.19 section 2: the provider each session's local launch (or
 *  take-over) started, by the tab's id, until its teardown's first part. */
const launchProviders = new Map<string, ProviderId>()

/** pty-manager.ts, once a local launch has registered its session (and a
 *  take-over, here): the provider that launch started. */
export function noteLaunchProvider(sessionId: string, id: ProviderId): void {
  launchProviders.set(sessionId, id)
}

/** The lifecycle objects asked for a session (its teardown's first part, its
 *  description): its launch's provider's; every registered provider's when
 *  no launch of it is known (a terminal tab, an SSH session, a launch that
 *  failed before it registered) or its provider has none, each of which does
 *  nothing for a session it holds nothing for. */
function lifecyclesFor(sessionId: string): ProviderLifecycle[] {
  const id = launchProviders.get(sessionId)
  const own = id ? tryGetProvider(id)?.lifecycle : undefined
  if (own) return [own]
  return PROVIDER_IDS.flatMap((each) => {
    const lifecycle = tryGetProvider(each)?.lifecycle
    return lifecycle ? [lifecycle] : []
  })
}

/** The records and doors a provider's lifecycle object is handed
 *  (providers/types.ts LifecycleCore): pty-manager.ts's, with this module's. */
export function lifecycleCore(): LifecycleCore {
  return { ...ports(), bindCodexLease, bindCodexPane, settleServedToken }
}

/** Teardown, first part (cleanupSessionResources): what the session's
 *  provider's own launch holds goes, by its lifecycle object's unbind (a Codex
 *  session's account lease). Nothing happens when none is held. */
export function unbindLaunchProvider(sessionId: string): void {
  const lifecycles = lifecyclesFor(sessionId)
  launchProviders.delete(sessionId)
  for (const lifecycle of lifecycles) lifecycle.unbind(sessionId, lifecycleCore())
}

/** Teardown, second part: the run's telemetry and conversation records, the
 *  Codex log binder's claim and the Codex launch's hooks. Each step does
 *  nothing when there is nothing to drop. A session an app update keeps
 *  running keeps its hook folder (S16 step 4): its CLI's hook reads the file
 *  in it at every event, and removeKeptLaunchFiles removes it once it is not
 *  kept. So does its resume list's pick folder (aicc_planning#419). */
export function unbindLaunchTelemetry(sessionId: string): void {
  const { codexTelemetrySources, codexHookFiles, notIndexedSessions, claudeTranscripts, claudeFolders, codexFolders, endSessionNotIndexed, forgetCodexHooks } = ports()
  const kept = launchKeptForUpdate(sessionId)
  // Let go of here, so forgetCodexHooks below finds no file to remove.
  if (kept) codexHookFiles.delete(sessionId)
  // Stop Codex telemetry source if one was registered for this session. On a
  // natural Codex exit (user typed exit/quit, Ctrl+D, crash) this is the ONLY
  // place that stops the 500ms full-file-read tail poller — killPty isn't hit
  // until the tab is closed, so without this the poller ran for the dead tab.
  const codexTel = codexTelemetrySources.get(sessionId)
  // P3.12 (Y1): a session ending holds no conversation while not indexed
  // (P3.16 M1: and the Claude transcript and folder it was on are not the next
  // launch's).
  notIndexedSessions.delete(sessionId)
  claudeTranscripts.delete(sessionId)
  claudeFolders.delete(sessionId)
  codexFolders.delete(sessionId)
  endSessionNotIndexed(sessionId, Date.now())
  if (codexTel) {
    try { codexTel.stop(kept ? { keepPickFolder: true } : undefined) } catch { /* noop */ }
    codexTelemetrySources.delete(sessionId)
    // P3.12 round 2 (Q3): a session reading this one's conversation beside
    // it holds it now (its watcher says so, and its logs bind it).
    for (const [other, source] of codexTelemetrySources) {
      if (other === sessionId) continue
      try { source.recheckShared?.() } catch { /* one session's watch never breaks another's */ }
    }
  }
  // P3.12 round 1 (Q1): the Codex log binder's claim goes with the session's
  // resources (killPty runs this before every spawn, a Claude one too), so a
  // tab respawned as another assistant keeps nothing of it; a Codex launch
  // begins its own afterwards.
  try { getCodexLogBinder()?.endRun(sessionId) } catch { /* best-effort */ }
  // P3.10: the launch's hook file (its token) and its hooked mark go with
  // the session's resources; the gateway's token for it goes on exit, as a
  // Claude session's does, and a respawn mints a new one.
  forgetCodexHooks(sessionId)
}

/** Teardown, third part: the registrations each launch makes again (the
 *  review tools, the MCP credential's assistant, the canvas roots and
 *  markers), the Codex run screen, the Ask mark and the launch's guidance record.
 *  Each step does nothing when there is nothing to drop. */
export function unbindLaunchRegistrations(sessionId: string): void {
  const { codexAskSessions, closeCodexRunScreen } = ports()
  // B1d: this teardown (a launch's, before it binds its own) ends what
  // serveKeptLaunchUnseen bound with the rest, so unserving that session
  // later (unserveKeptLaunchUnseen) leaves the launch's bindings alone.
  unseenServed.delete(sessionId)
  // SECURITY (adversarial review, #188): deregister codex_review here so
  // registration is strictly RE-ESTABLISHED per spawn. spawnPty calls killPty
  // (→ this) before it re-registers, so a session that restarts into a
  // home-rooted, SSH, shell-only or Codex state cannot INHERIT the stale
  // registration (and stale cwd) from a prior local-Claude spawn — which would
  // otherwise defeat the home-dir refusal and the "SSH never registers"
  // invariant. Idempotent: a no-op when the session was never registered.
  unregisterCodexReviewSession(sessionId)
  // #628 review: the record of which assistant this session's MCP credential
  // went to is per launch too, so a session id relaunched on another assistant
  // (an Ask tab revived on Claude after Codex) is served that assistant's tools.
  releaseMcpSessionProvider(sessionId)
  // SECURITY (adversarial review, 2026-08-15 — BLOCKER 1): the canvas serving
  // allowlist dies with the session, for the identical reason. The first cut
  // had NO production revocation at all — a root registered by any local spawn
  // stayed servable for the life of the app process, so a session that exited
  // hours ago still contributed a readable project to whichever agent was
  // running now. Re-established per spawn (spawnPty calls killPty → here before
  // it re-registers), so a session that restarts into a home-rooted, SSH,
  // shell-only or Codex state inherits nothing.
  revokeCanvasUatRoots(sessionId)
  // SECURITY (adversarial review, 2026-09-01 — HIGH): drop this session's
  // canvas markers here, for the same per-spawn isolation invariant as the
  // watchdog teardown that follows this call in cleanupSessionResources.
  //
  // `forgetCanvasMarkers` was wired ONLY to the `pty:kill` IPC listener
  // (pty-handlers.ts). That listener fires when the RENDERER closes a tab — it
  // does not fire for the two paths that respawn a session UNDER THE SAME ID:
  // Restart, and switch-account. So a marker queued against the old
  // conversation ("Approved v7 on the canvas · canvas_version_verdict
  // recorded") survived the teardown with `turnOpen` still true, and the NEW
  // process's first `SessionStart` hook — an event this queue treats as a
  // boundary and flushes on — wrote it straight into the fresh conversation.
  // The agent is then told a verdict was filed on work it has never seen, in a
  // line whose whole purpose is to trigger the canvas skill. A natural PTY exit
  // reached neither the listener nor any other clear, so the marker simply sat
  // there until something flushed it.
  //
  // Here it is covered by BOTH callers (killPty and the natural-exit block), and
  // spawnPty calls killPty → here before a respawn, so the new session inherits
  // nothing. Idempotent: a no-op for a session with no queue. The module holds
  // no static import of pty-manager (its PTY end is injected at boot from
  // index.ts), so importing it here introduces no cycle.
  forgetCanvasMarkers(sessionId)
  // WP2 PR 4, P4.1: the submit primitive's reading of a Codex run (its pane,
  // or B2 its holder's screen) goes with it (a submission still waiting on it
  // reports the session gone, and types nothing into the next run), and so
  // does the launch's guidance record.
  closeCodexRunScreen(sessionId)
  codexAskSessions.delete(sessionId)
  forgetCodexSessionGuidance(sessionId)
}

/** A conversation id as Claude Code and Codex make one (a UUID). */
const CONVERSATION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * What the release of a session an app update keeps running records of it
 * (S16 step 4), read before its kill from what this run bound for it, as its
 * provider's lifecycle object describes it (2.1.3-beta.19 section 2): the
 * conversation it is on (a Codex session's claim, a Claude Code session's
 * transcript, by its file name), the account (a Codex session's lease, the
 * profile a Claude Code session started under; null for the default
 * account) and its Codex hook folder. Each is null when not known: a session
 * that has not started a conversation yet has none. And (aicc_planning#419)
 * a launch through the resume list's pick, from its watcher, while the pick
 * folder is still the one made.
 */
export function describeLaunch(sessionId: string): KeptLaunchFacts {
  const parts = lifecyclesFor(sessionId).map((lifecycle) => lifecycle.describe(sessionId, lifecycleCore()))
  const conversation = parts.map((p) => p.conversation).find((id): id is string => typeof id === 'string' && CONVERSATION_ID_RE.test(id)) ?? null
  const account = parts.map((p) => p.account).find((a): a is string => typeof a === 'string') ?? null
  const hookFolder = parts.map((p) => p.hookFolder).find((f): f is string => typeof f === 'string') ?? null
  const pick = parts.map((p) => p.pick).find((k) => k !== undefined)
  return { conversation, account, hookFolder, ...(pick ? { pick } : {}) }
}

/**
 * What a kept session left on disk, removed once it is no longer kept (S16
 * step 4): the next start ended it, the update did not start, or a quit or a
 * new start of its tab came first. Its three per-session files, as its exit
 * would have removed them, and its hook folder, which its provider removes
 * only from its own hook root. And (aicc_planning#419) its resume list's pick
 * folder, which its provider removes only while it is still the one made.
 */
export function removeKeptLaunchFiles(kept: KeptLaunch): void {
  removeLocalSessionSettings(kept.sessionId)
  removeLocalSessionMcpConfig(kept.sessionId)
  removeLocalSessionStatusUrl(kept.sessionId)
  if (kept.hookFolder) {
    try { tryGetProvider(kept.provider)?.removeSessionHookFolder?.(kept.hookFolder) } catch (err) { logWarn(`[pty] ${kept.sessionId}: the hook folder an update kept could not be removed: ${(err as Error)?.message ?? err}`) }
  }
  if (kept.pick) {
    try { tryGetProvider(kept.provider)?.removeSessionPickFolder?.(kept.pick) } catch { /* best-effort */ }
  }
}

/**
 * aicc_planning#423: a session the next start keeps for its tab, until the
 * take-over. Its status line's address file, where its launch wrote one,
 * names the last run's address and credential, which this run's Conductor
 * server refuses: each status its CLI sent meanwhile was a refused request
 * before its status line wrote its status file instead. Emptied, its status
 * line writes that file with no request (statusline.ts); the file stays, so
 * the take-over still writes this run's address into it (providers/claude/lifecycle.ts claudeTakeOver).
 */
export function holdKeptLaunchFiles(kept: KeptLaunch): void {
  if (fs.existsSync(getLocalSessionStatusUrlPath(kept.sessionId))) writeLocalSessionStatusUrl(kept.sessionId, '')
}

setKeptLaunchBindings({ describe: describeLaunch, remove: removeKeptLaunchFiles, hold: holdKeptLaunchFiles, serve: serveKeptLaunchUnseen, unserve: unserveKeptLaunchUnseen })
