// A launch's bindings (S16 step 3, aicc_planning#375): what the app makes
// around a local Claude Code or Codex session's process, and drops when the
// session ends. Moved here from pty-manager.ts with no change in behaviour: the
// same calls in the same order and the same log lines, each function called
// where its code was. A take-over of a held agent session (S16 step 5) makes
// the same bindings for a CLI that is already running by calling the same
// functions.
//
// A Codex launch, in pty-manager.ts's order: mintCodexHooks (before its command
// is built), keepCodexHooks (once it is built), bindCodexLease (right before
// the spawn), then bindCodexPane and bindCodexLaunch (after it). A Claude Code
// launch: bindClaudeLaunch, right after its spawn. Every launch: bindLoggingRun,
// once the session is registered. The end of a session: unbindLaunchFiles at
// its own exit, or at once at a quit's or an update's kill (killAllPty and
// gracefulExitPty's forced kill: the app may be gone before the exit is
// reported, aicc_planning#385; a Codex launch's waits for its exit), and in
// the teardown every kill and every exit runs (cleanupSessionResources)
// unbindCodexLease, unbindLaunchTelemetry and unbindLaunchRegistrations, each
// at its own place in that teardown.
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
// (takeOverKeptLaunch): the session helper shows its terminal again, and this
// module makes the launch's bindings again for the CLI that runs, with no
// launch. A Codex session's hook file is written again in its kept folder
// with a token minted for the take-over.
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
//  - the Codex run's data handler and its run folder note, beside the spawn,
//    as Claude Code's are; Ask Conductor's opening question, typed through a
//    door only pty-manager.ts may use (session-input's askQuestion); and the
//    Codex run screen, which pty-manager.ts closes for this module;
//  - a failed Codex launch's unwinding, which reads the hook file and token the
//    launch holds (mintCodexHooks and keepCodexHooks hand them back);
//  - every comparison with a provider name: pty-manager.ts works each one out
//    and hands the answer in (tests/unit/architecture/provider-name-ratchet.test.ts,
//    which counts this module's tests of a launch style, a style standing for
//    a provider, as launch-style tests).
import * as fs from 'fs'
import * as path from 'path'
import { nativeTheme, type BrowserWindow } from 'electron'
import type * as pty from 'node-pty'
import type { ProviderId } from '../../shared/providers'
import type { AccountLease } from '../providers/core'
import type { ProviderSpawnCommand, SessionProvider, SessionRunScreen, TelemetryOptions, TelemetrySource } from '../providers/types'
import { getGateway } from '../hooks'
import { removeLocalSessionSettings, removeLocalSessionMcpConfig, removeLocalSessionStatusUrl, getLocalSessionStatusUrlPath, writeLocalSessionStatusUrl, noteKeptLaunchStatusLine } from '../hooks/per-session-settings'
import { logInfo, logError, logWarn } from '../debug-logger'
import { readConfig } from '../config-manager'
import { isHomeOrAncestor, resolveCwd } from '../path-utils'
import { decorateStatuslineWithColour } from '../account-color'
import { clampAnsiChunk, getWatchdogManager } from '../watchdog/watchdog-manager'
import { getPtyIntegrityMonitor } from '../services/pty-integrity-monitor'
import { designatedWorktreeDir } from '../canvas/canvas-worktree'
import { createColorQueryResponder, terminalReplyColors, type ColorQueryResponder } from '../terminal-query-responder'
import { shouldRegisterRun } from '../logging/should-register-run'
import { openNotIndexedWindow } from '../logging/indexing-gaps'
import { getLogSupervisor } from '../logging/logging-service'
import { getCodexLogBinder } from '../logging/codex-log-binder'
import { buildResumeTranscriptPath } from '../spawn-claude-command'
import { captureClaudeAccount, clearClaudeAccount, getAccountIdentity, getClaudeProfileId, pushAccountIdentity, startWatchingAccountIdentity, stopWatchingAccountIdentity } from '../claude-account-identity'
import { registerCodexReviewSession, registerClaudeReviewSession, unregisterCodexReviewSession, releaseMcpSessionProvider, recordHeldToolSession, getConductorMcpPort } from '../conductor-mcp-server'
import { registerCanvasUatRoot, revokeCanvasUatRoots, designateCanvasWorktreeRoot, canvasRootRefusalReason, describeCanvasRootRefusal, setCanvasRootRefusal } from '../canvas/canvas-store'
import { forgetCanvasMarkers } from '../canvas/canvas-marker-delivery'
import type { CodexCanvasLaunch } from '../canvas/codex-canvas-launch'
import { registerCodexCanvasRoots, codexDesignatedWorktree } from '../canvas/codex-canvas-roots'
import { noteCodexSessionGuidance, forgetCodexSessionGuidance } from '../canvas/codex-guidance'
import { tryGetProvider } from '../providers'
import { launchKeptForUpdate, setKeptLaunchBindings, takeKeptSession, type KeptLaunch, type KeptLaunchFacts, type KeptSessionFacts, type KeptUnseen } from './kept-launches'
import { HelperPty } from '../session-helper/helper-pty'
// B1e: pty-manager.ts's hook transcript route asks it, through this module (its one import of the kept-session seam).
export { keptForItsTab } from './kept-launches'

/** A Codex launch's hook file: the file that hands its gateway token to the
 *  hook, with the way to remove it. */
export interface CodexHookFile { hookFile: string; dispose(): void }

/** What a Codex launch holds of its hooks between mintCodexHooks and
 *  keepCodexHooks: the hook file, and whether the launch minted the session's
 *  gateway token. pty-manager.ts keeps both for its failed-launch path. */
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
  /** How pty-manager.ts starts a provider's sessions (its launchStyleOf): a
   *  kept session served while its tab is not shown is bound by that way,
   *  as its take-over is, never by a name. */
  launchStyleOf(id: ProviderId): 'direct' | 'claude-shell' | undefined
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

/** A Codex launch's conversation and registrations, from the launch. */
export interface CodexLaunchBinding {
  win: BrowserWindow
  sessionId: string
  provider: SessionProvider
  launch: { lease: AccountLease; sessionsDir: string }
  /** Where the CLI runs: the resumed conversation's own folder, else the configured one. */
  codexCwd: string
  /** Taken right before the spawn: where the telemetry's claim window starts. */
  codexSpawnTimestamp: number
  built: Pick<ProviderSpawnCommand, 'resumeId' | 'resumePath' | 'pickFile' | 'pickFolder'> & Pick<TelemetryOptions, 'picked'>
  /** The session's configured project folder, resolved. */
  resolvedCwd: string
  codexCanvas: Pick<CodexCanvasLaunch, 'designatedWorktree' | 'guidance'>
  /** The assistant this run's not-indexed record names (bindLoggingRun marks it so). */
  runProvider: ProviderId
}

/** A Claude Code launch's account capture and registrations, from the launch. */
export interface ClaudeLaunchBinding {
  sessionId: string
  /** The account profile the launch resolved; undefined for the default account. */
  resolvedProfileId: string | undefined
  /** The folder Claude Code runs in, after the resume decision (a transcript can name it). */
  claudeCwd: string
  /** The session's configured project folder, resolved (no transcript reaches it). */
  resolvedCwd: string
  /** The worktree the app designates for the session, or null. */
  designatedWorktree: string | null
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
 *  (WP2, plan A10). unbindCodexLease releases it with the session's resources,
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
 * A Codex launch's conversation and registrations, once its process has
 * started: the Codex log binder's launch, the folder its watcher matches by,
 * the rollout watch-and-claim telemetry, the claude_review registration, and
 * the Agent Canvas roots and guidance.
 */
export function bindCodexLaunch(binding: CodexLaunchBinding): void {
  const {
    notIndexedSessions, codexContextRollouts, keptCodexConversations, lastCodexHookRollout, codexTelemetrySources,
    noteCodexFolder, keepCodexConversation, markCodexConversationUncertain, clearCodexDoubtFromHook, noteCodexContextRollout, endSessionNotIndexed,
  } = ports()
  const { win, sessionId, provider, launch, codexCwd, codexSpawnTimestamp, built, resolvedCwd, codexCanvas, runProvider } = binding
  // P3.12 (row 31): whatever an earlier launch of this session claimed is
  // not this run's; this launch's claims are held until its run is
  // recorded (a resume claims at once, inside ingestSessionTelemetry).
  getCodexLogBinder()?.beginLaunch(sessionId)
  // P3.12 (X1): this launch is not yet known as not indexed (its own run
  // block says, below); a claim it makes before that is not marked.
  notIndexedSessions.delete(sessionId)
  // PR-level ADR-009 round 1 (C1): the folder this launch runs in (its
  // watcher matches a new rollout by it), for its folder window when it is
  // not indexed.
  noteCodexFolder(sessionId, codexCwd)
  // P3.12 round 1 (B2): a launch on another account (Switch Account) is on
  // another account's folder: the rollout recorded for the Session
  // Context goes until this launch claims one.
  const contextBefore = codexContextRollouts.get(sessionId)
  if (contextBefore && contextBefore.sessionsDir !== launch.sessionsDir) codexContextRollouts.delete(sessionId)
  // Start rollout watch-and-claim telemetry. Updates are dispatched to the
  // renderer (statusline:update) identically to how Claude statusline
  // updates flow through statusline-watcher.ts. (Tokenomics is no longer fed
  // from telemetry ticks — the indexing worker reads raw transcripts.)
  const codexTelSrc = provider.ingestSessionTelemetry(
    sessionId,
    // The realm's own transcripts: a managed account never writes to ~/.codex.
    // P3.5: the resumed conversation is claimed wherever it is, the
    // picker's pick through its file, and the tab keeps what is claimed.
    {
      cwd: codexCwd,
      spawnTimestamp: codexSpawnTimestamp,
      sessionsDir: launch.sessionsDir,
      ...(built.resumeId ? { resumeId: built.resumeId } : {}),
      ...(built.resumeId && built.resumePath ? { resumePath: built.resumePath } : {}),
      ...(built.pickFile ? { pickFile: built.pickFile, pickFolder: built.pickFolder, ...(built.picked ? { picked: built.picked } : {}) } : {}),
      onClaim: (claimed) => {
        keepCodexConversation(sessionId, { uuid: claimed.id, cwd: claimed.cwd }, launch.lease.accountId, { inferred: claimed.exact !== true })
        // P3.6: a claim that could have been another session's.
        if (claimed.certain !== true) markCodexConversationUncertain(claimed.id)
        // P3.10: the session's own hook named it: this session is on it,
        // as Codex says, which clears P3.6's doubt -- unless a live launch
        // resumed it by id (clearCodexDoubtFromHook).
        else if (claimed.fromHook === true) clearCodexDoubtFromHook(claimed.id)
      },
      // The picker decided again after a claim: the session is no longer
      // on it. Round 1 (Q3): nor is the path its hook last named taken
      // as read (the same path again is handed to the watch).
      onRelease: () => {
        keptCodexConversations.delete(sessionId)
        lastCodexHookRollout.delete(sessionId)
      },
      // P3.6 (VM finding V2): on a conversation another session holds
      // (picked, resumed by id, or named by its hook): recorded as this
      // session's too, so a Switch refuses it as in use and says so.
      onShared: (shared) => {
        keepCodexConversation(sessionId, { uuid: shared.id, cwd: shared.cwd }, launch.lease.accountId, { inferred: shared.exact !== true })
        if (shared.fromHook === true) clearCodexDoubtFromHook(shared.id)
      },
      // P3.12 (rows 31, 32, 65): the rollout claimed, as the watcher
      // checked it (its realm, a plain rollout file), or null when let
      // go: the session's logs and name file (the Codex log binder) and
      // its GitHub Session Context read the conversation from this alone.
      onRollout: (rollout) => {
        noteCodexContextRollout(sessionId, rollout)
        // P3.12 (X1, Z1): a conversation a session not indexed is on: its
        // window opens when the session became not indexed, not now.
        // PR-level ADR-009 round 1 (C1): a claim let go closes the
        // conversation's window only; the folder's stays open.
        const notIndexed = notIndexedSessions.get(sessionId)
        if (notIndexed?.provider === runProvider) {
          if (rollout) { try { openNotIndexedWindow(sessionId, rollout.path, notIndexed.since, Date.now()) } catch { /* best-effort */ } }
          else endSessionNotIndexed(sessionId, Date.now(), { coversStay: true })
        }
        getCodexLogBinder()?.noteRollout(sessionId, rollout)
      },
    },
    (data) => {
      // Copilot review on PR #31 (p9.17): decorate at the send site so
      // the renderer receives accountColour. decorateStatuslineWithColour
      // is a no-op when the payload carries no accountEmail (Codex
      // telemetry currently does not), so this is safe + future-proof.
      // Tokenomics no longer ingests from telemetry ticks (the worker
      // indexes raw transcripts on its own timer); only the renderer send
      // remains.
      const decorated = decorateStatuslineWithColour(data)
      if (!win.isDestroyed()) win.webContents.send('statusline:update', decorated)
    },
  )
  codexTelemetrySources.set(sessionId, codexTelSrc)
  registerCodexLaunchTools({ sessionId, resolvedCwd, codexCanvas })
}

/**
 * A Codex launch's registrations (bindCodexLaunch; and aicc_planning#423,
 * B1d, a session kept for a restored tab not shown yet): the claude_review
 * registration, and the Agent Canvas roots and guidance.
 */
function registerCodexLaunchTools(binding: Pick<CodexLaunchBinding, 'sessionId' | 'resolvedCwd' | 'codexCanvas'>): void {
  const { sessionId, resolvedCwd, codexCanvas } = binding
  // WP2 commit 5b: a local Codex session may ask for a Claude review of
  // its configured project directory, never home or above it (the
  // codex_review rule, #188) -- and never the directory a resumed
  // conversation's rollout names (P3.5), which is transcript content, the
  // same line the Agent Canvas root holds in the Claude branch. Whether the tool is
  // offered is decided per MCP connection; killPty's unregister (run
  // before every spawn) clears this, so a respawn re-decides.
  if (isHomeOrAncestor(resolvedCwd)) {
    logWarn(`[pty] claude_review NOT registered for ${sessionId}: the project directory resolves to (or above) the home directory. Set a real project directory to enable review.`)
  } else {
    registerClaudeReviewSession(sessionId, resolvedCwd)
  }
  // WP2 PR 4, P4.1 (row 51): the Agent Canvas serving roots, by the
  // Claude branch's rule (canvas/codex-canvas-roots.ts): the configured
  // project directory and the designated worktree, never `codexCwd` or any
  // folder a rollout recorded. killPty's revoke (run before every spawn)
  // and the session's cleanup clear them. And what this launch carried of
  // the skills, for the canvas page's line (whatever route the builder
  // took: every route lists the account's own skills folder).
  registerCodexCanvasRoots(sessionId, resolvedCwd, codexCanvas.designatedWorktree)
  if (codexCanvas.guidance) noteCodexSessionGuidance(sessionId, codexCanvas.guidance)
  else forgetCodexSessionGuidance(sessionId)
}

/**
 * A Claude Code launch's account capture and registrations, right after its
 * process has started: the account the session runs on and the watch on it,
 * the codex_review registration, the Agent Canvas serving root, and the
 * designated worktree.
 */
export function bindClaudeLaunch(binding: ClaudeLaunchBinding): void {
  const { sessionId, resolvedProfileId, claudeCwd, resolvedCwd, designatedWorktree } = binding
  // B3: capture identity ONLY after the spawn succeeds — if pty.spawn throws,
  // no map entry is created (no leak), and shell-only sessions never reach
  // here. resolvedProfileId is undefined when no explicit or primary profile
  // resolved, so identity comes from the default account in that case.
  captureClaudeAccount(sessionId, resolvedProfileId)
  pushAccountIdentity(sessionId)
  // Watch for a mid-session account change (user runs /login in the terminal
  // without a respawn), so the strip/card/statusline follow the new account.
  startWatchingAccountIdentity(sessionId, resolvedProfileId)
  registerClaudeLaunchTools({ sessionId, claudeCwd, resolvedCwd, designatedWorktree })
}

/**
 * A Claude Code launch's registrations (bindClaudeLaunch; and
 * aicc_planning#423, B1d, a session kept for a restored tab not shown yet):
 * the codex_review registration, the Agent Canvas serving root, and the
 * designated worktree.
 */
function registerClaudeLaunchTools(binding: Pick<ClaudeLaunchBinding, 'sessionId' | 'claudeCwd' | 'resolvedCwd' | 'designatedWorktree'>): void {
  const { sessionId, claudeCwd, resolvedCwd, designatedWorktree } = binding
  // Every LOCAL Claude session with a real project folder REGISTERS for
  // codex_review here; registering does not offer the tool. Whether it is
  // offered is decided per MCP connection (offeredReviewTool, called from
  // conductor-mcp-server createServer): the Conductor tools master and the
  // codex_review switch (Settings, General, Built-in tools) must be on,
  // Codex must be enabled, and a Codex review must be preparable now (the
  // accounts service's reviewReady: the provider on and a reviewer account
  // ready). SSH sessions never reach this call, so the tool only ever
  // runs against paths that exist on this machine. The per-config
  // enableCodexReview flag is retired (ignored).
  //
  // SECURITY (adversarial review, #188): register the ACTUAL launch cwd
  // (`claudeCwd`, post-resume-override) — not the pre-override `resolvedCwd`
  // — and REFUSE to register when that cwd is the bare home directory. A
  // config whose workingDirectory is '.', empty, or a stale/deleted path
  // makes resolveCwd() silently fall back to os.homedir(); registering that
  // would let a prompt-injected session review ~/.ssh, ~/.claude, ~/.aws via
  // mode:'paths' (containment holds, but the ROOT is wrong). Since universal
  // opt-in removed the per-config gate that used to bound this, block it at
  // the source: no legitimate review targets the bare home dir.
  if (isHomeOrAncestor(claudeCwd)) {
    logWarn(`[pty] codex_review NOT registered for ${sessionId}: launch cwd resolves to (or above) the home directory (workingDirectory is '.', empty, a stale path, or points at home). Set a real project directory to enable review.`)
  } else {
    registerCodexReviewSession(sessionId, claudeCwd)
  }

  // The Agent Canvas serving allowlist rides the same decision, for the same
  // reason — but NOT against the same directory (adversarial review,
  // 2026-08-15, second pass).
  //
  // `claudeCwd` is TRANSCRIPT-DERIVED whenever an exact-resume applies. It
  // starts as `resolvedCwd` and is then overwritten with
  // `resolveResumeLaunch(effectiveTarget).claudeCwd`, which is
  // `target.cwd` — and `target` is either the persisted `options.resume` or
  // the self-captured `resolveResumeTargetFromTranscript()`, whose cwd is
  // THE FIRST `cwd` STRING IN THE TRANSCRIPT JSONL, verbatim. That file is
  // one the agent can write. So an agent that rewrites its own transcript's
  // first line to `"cwd":"C:\\Users\\<u>\\.claude"` and creates the matching
  // mangled projects directory names its own served root the next time the
  // user hits Restart or Switch-account. `isHomeOrAncestor` does not catch
  // it: `~/.claude` is a CHILD of home, not an ancestor. From there
  // `canvas_render { htmlPath: '…/.claude/.credentials.json' }` reads the
  // OAuth token and the pre-allowed `canvas_snapshot` reads it back out of
  // the DOM. The previous fix moved the registration to pty-manager.ts and
  // claimed "no served root is derived from transcript content any more";
  // moving the CALL did not change where the VALUE came from.
  //
  // So the canvas root is `resolvedCwd` — `resolveCwd(options.cwd)`, the
  // session's CONFIGURED project directory, which no transcript can reach —
  // and never the resume override. The cost is bounded and known: a session
  // that exact-resumes a conversation from OUTSIDE its configured project
  // directory can serve nothing (renders are refused, not misdirected).
  //
  // codex_review above deliberately keeps `claudeCwd`: changing what it
  // reviews is a separate behavioural decision, and its exposure is
  // different in kind (it reads for a review the user reads, with no
  // pre-allowed tool reading the bytes back). It is flagged, not changed.
  if (isHomeOrAncestor(resolvedCwd)) {
    logWarn(`[pty] canvas serving root NOT registered for ${sessionId}: the configured project directory resolves to (or above) the home directory (workingDirectory is '.', empty, a stale path, or points at home).`)
    setCanvasRootRefusal(sessionId, describeCanvasRootRefusal('home-or-ancestor', resolvedCwd))
  } else if (!registerCanvasUatRoot(sessionId, resolvedCwd)) {
    // Floor-checked again inside the store (absolute, real, a directory, not
    // home, not a volume root, not a dot-dir under home, not the resources
    // directory) — two independent refusals rather than one, because this is
    // the only thing standing between a prompt-injected agent and a file
    // read with the app's privileges.
    //
    // NAME the floor that refused (#371). "Refused by the canvas store" in a
    // log file, with the agent told to write where it already wrote, is an
    // undiagnosable dead end for the one configuration the resources-dir
    // floor exists for.
    const reason = canvasRootRefusalReason(sessionId, resolvedCwd)
    const explanation = reason ? describeCanvasRootRefusal(reason, resolvedCwd) : 'the canvas store refused it.'
    logWarn(`[pty] canvas serving root NOT registered for ${sessionId} (${reason ?? 'unknown'}): ${explanation}`)
    setCanvasRootRefusal(sessionId, explanation)
  }

  // The worktree designation is INDEPENDENT of the project root (#371). It
  // used to sit in the same else-if chain, so a project directory refused
  // by any floor also cost the session its worktree root — even though
  // `<parent>/ccc-wt/<sid>` neither contains nor sits under the resources
  // directory and would have been accepted. One refusal, not two.
  //
  // PENDING: the store consults it only once it exists as a real, un-linked
  // directory (canvas-store.designateCanvasWorktreeRoot). The path is CCC's,
  // the contents are the agent's own; nothing an agent can write moves it
  // (ADR-016).
  if (designatedWorktree) {
    if (designateCanvasWorktreeRoot(sessionId, designatedWorktree)) {
      logInfo(`[pty] canvas: designated session worktree ${designatedWorktree} for ${sessionId} (served once it exists)`)
    } else {
      logWarn(`[pty] canvas: designated session worktree ${designatedWorktree} for ${sessionId} was refused by the canvas store floor.`)
    }
  }
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
  // bindClaudeLaunch for non-shell Claude sessions) + configId/profileId are stamped
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
    // bindClaudeLaunch). The run row therefore stamps a null email; configId and
    // profileId ARE stamped correctly at spawn. runAccount() back-fills the email
    // once the identity poll resolves (wired in a later task).
    accountEmail: getAccountIdentity(sessionId)?.email,
    profileId: resolvedProfileId,
    provider,
    startedAt: Date.now(),
  })
  // P3.12 (row 31): a local Codex run's transcript is the rollout its own
  // watcher claims (the Codex log binder, told by bindCodexLaunch's onRollout), bound
  // from here on; Claude's discovery after this, in pty-manager.ts (its heuristic scan of
  // ~/.claude/projects, its resume-bind) is Claude's alone.
  const codexLocalRun = codexRunProvider
  if (codexLocalRun) getCodexLogBinder()?.startRun(sessionId, !!logSup)
  return { logSup, codexLocalRun }
}

/** A restored tab's launch, which a take-over replaces (2.1.3-beta.17, S16
 *  step 5). */
export interface KeptTakeOverBinding {
  win: BrowserWindow
  sessionId: string
  /** The provider the launch starts, and how pty-manager.ts starts it (its
   *  LocalLaunch): the take-over's bindings follow the way, never a name. */
  launch: { id: ProviderId; style: 'direct' | 'claude-shell'; provider: SessionProvider }
  /** The session's configured project folder, resolved. */
  resolvedCwd: string
  cols: number
  rows: number
  /** A Codex launch's preparation (pty:spawn's): its account lease and its
   *  realm's sessions folder. None: a Codex take-over is not made. */
  codexLaunch?: { lease: AccountLease; sessionsDir: string }
  /** The account a Claude Code launch names (pty:spawn's profileId): a kept
   *  session on another account is not taken over. None: any. */
  profileId?: string
  /** An Ask Conductor launch. */
  isAsk?: boolean
}

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
 * made again for that CLI, before its holder is attached, and in both cases
 * the tool host's record of the session, with no credential (its tool streams
 * come through its holder), and where the run works. A Claude Code session
 * (claudeTakeOver): its status line's address file, its account capture and
 * registrations, and its data handler. A Codex session (codexTakeOver): its
 * hook file (none when its hook events go through its holder, 2.1.3-beta.18),
 * its lease, its conversation, its pane and colour answers, its
 * data handler, its telemetry and registrations. The session's entry, its
 * watchdog, its logging run and, for Claude Code, its transcript binding (by
 * the saved conversation, from the folder it runs in) follow in pty-manager.ts
 * from what this answers, before its hook events can bind a transcript.
 */
export function takeOverKeptLaunch(b: KeptTakeOverBinding): KeptSessionTakenOver | null {
  const codex = b.launch.style === 'direct'
  // A Codex take-over needs its launch's preparation: its lease names the account.
  // B1e: no take-over: a token its serving kept goes before the launch mints its own.
  if (codex && !b.codexLaunch?.lease) { settleServedToken(b.sessionId); return null }
  const size = { cols: b.cols, rows: b.rows }
  const taken = codex
    ? takeKeptSession(b.sessionId, b.launch.id, size, b.codexLaunch?.lease.accountId ?? null)
    : b.profileId ? takeKeptSession(b.sessionId, b.launch.id, size, b.profileId) : takeKeptSession(b.sessionId, b.launch.id, size)
  if (!taken) { settleServedToken(b.sessionId); return null }
  const { pty: proc, kept } = taken
  const launchCwd = kept.folder ?? b.resolvedCwd
  try {
    recordHeldToolSession(b.sessionId, b.launch.id)
    ports().noteAgentRunFolder(proc, b.sessionId, launchCwd)
    if (codex) codexTakeOver(b, b.codexLaunch!, proc, kept, launchCwd)
    else claudeTakeOver(b, proc, kept, launchCwd)
  } catch (err) {
    // As a launch that failed after its process started: its CLI is ended
    // (the holder's end), what was bound goes, and the throw goes on to the
    // spawn's caller. Its tab reads the failure, and a Restart resumes it.
    logWarn(`[pty] ${b.sessionId}: the take-over failed after it attached; its CLI is ended (${(err as Error)?.message ?? err})`)
    try { proc.kill() } catch { /* already gone */ }
    servedTokens.delete(b.sessionId)
    try { ports().dropGatewayToken(b.sessionId) } catch { /* best-effort */ }
    for (const unbind of [unbindCodexLease, unbindLaunchTelemetry, unbindLaunchRegistrations, clearClaudeAccount, stopWatchingAccountIdentity]) {
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
  return { ptyProcess: proc, launchCwd, conversation: kept.conversation, profileId: codex ? undefined : (kept.account ?? undefined), since: kept.at > 0 ? Math.min(kept.at, now) : now }
}

/**
 * A Claude Code take-over's own bindings: its status line's address file
 * written again with this run's address, only where its launch wrote one (its
 * bridge reads the file each tick; this issues the session's credential into
 * that owner-only file, as a launch's settings write does); the account
 * capture and its watch, the review registration (the folder the CLI was
 * launched in, as a launch registers it) and the Agent Canvas roots (the
 * configured folder and the designated worktree, never a transcript's folder:
 * bindClaudeLaunch's rule); and the data handler, as the Claude Code branch's.
 */
function claudeTakeOver(b: KeptTakeOverBinding, proc: pty.IPty, kept: KeptSessionFacts, launchCwd: string): void {
  const { ptySessions } = ports()
  const { sessionId, resolvedCwd, win } = b
  // Whether its launch got the app's status line, for the Usage page (read
  // back from the settings file that launch wrote, which the update kept).
  noteKeptLaunchStatusLine(sessionId)
  if (fs.existsSync(getLocalSessionStatusUrlPath(sessionId))) {
    let url = ''
    try { url = tryGetProvider(b.launch.id)?.statusPostUrl?.(sessionId, undefined, getConductorMcpPort(), true) ?? '' } catch { url = '' }
    if (url) writeLocalSessionStatusUrl(sessionId, url)
    else removeLocalSessionStatusUrl(sessionId)
  }
  bindClaudeLaunch({ sessionId, resolvedProfileId: kept.account ?? undefined, claudeCwd: launchCwd, resolvedCwd, designatedWorktree: isHomeOrAncestor(resolvedCwd) ? null : designatedWorktreeDir(resolvedCwd, sessionId) })
  proc.onData((data) => {
    if (win.isDestroyed()) return
    // The generation guard of every session's data: only while this terminal is the session's.
    if (ptySessions.get(sessionId)?.ptyProcess !== proc) return
    getPtyIntegrityMonitor()?.recordPtyData(sessionId, data.length)
    getWatchdogManager()?.feedData(sessionId, data)
    win.webContents.send(`pty:data:${sessionId}`, data)
  })
}

/**
 * A Codex take-over's own bindings (B1.2), as its launch makes them, with no
 * launch: its hook file written again in its own folder (the release's record)
 * with this run's gateway port and a token minted for the take-over, when the
 * Hooks gateway is on and listening (the forwarder reads the file at every
 * event; mintCodexHooks's rule, the file in place of a new folder), unless
 * its launch sent its hook events through its holder (2.1.3-beta.18, the
 * record's mark: they come through the take-over's attach); the lease
 * of the account it runs on (the tab's launch was prepared on that one); the
 * conversation it is on, for the tab; its pane and colour answers
 * (bindCodexPane: a held run is read from its holder's screen); its data
 * handler, as the Codex branch's (the colour answers take only live queries:
 * the session helper takes the replay's queries out); the Ask mark; and its
 * telemetry, review registration and Agent Canvas roots (bindCodexLaunch), the
 * telemetry claiming the saved conversation by its id, or for a launch through
 * the resume list through its kept pick file (aicc_planning#419).
 */
function codexTakeOver(b: KeptTakeOverBinding, launch: { lease: AccountLease; sessionsDir: string }, proc: pty.IPty, kept: KeptSessionFacts, launchCwd: string): void {
  const { ptySessions, codexHookFiles, codexHookedLaunches, codexAskSessions, keepCodexConversation, codexRunWriters } = ports()
  const { sessionId, resolvedCwd, win } = b
  const provider = b.launch.provider
  // 2.1.3-beta.18 (ADR-030 S12): a launch whose hook events went through its
  // holder (its record's mark) runs its forwarder from its own environment,
  // which names the holder and never this file: nothing is written again, and
  // its events come through the take-over's attach. Without the mark (its
  // hooks were on the Hooks gateway, or 2.1.3-beta.17 or earlier kept it) the
  // file is written again with this run's port and a new token, as before.
  const throughHolder = kept.hooks === 'holder'
  const hookFile = throughHolder ? null : rewriteKeptCodexHooks(sessionId, kept.hookFolder, provider)
  // B1e: its token is now written over the one it was served with, if any; not written, that one goes.
  settleServedToken(sessionId, hookFile !== null)
  if (hookFile) {
    codexHookFiles.set(sessionId, hookFile)
    codexHookedLaunches.add(sessionId)
  }
  // Its hook events are its own through its holder: its hook names its transcript as a launch's does.
  if (throughHolder) codexHookedLaunches.add(sessionId)
  // Not written again: the file names the last run's port and token, so its
  // folder goes now, as a kept session's does once it is no longer kept.
  if (kept.hookFolder && !codexHookFiles.has(sessionId)) {
    try { provider.removeSessionHookFolder?.(kept.hookFolder) } catch { /* best-effort; the sweep remains */ }
  }
  logInfo(`[pty-manager] Codex hooks for ${sessionId}: ${throughHolder ? 'on, through its holder (its launch sent them there), so its hook file is not written again' : codexHookedLaunches.has(sessionId) ? 'on, its kept hook file written again' : 'off (its launch had none, the Hooks gateway is off or not listening, or its hook file could not be written again)'}`)
  bindCodexLease(sessionId, launch.lease)
  if (kept.conversation) keepCodexConversation(sessionId, { uuid: kept.conversation, cwd: launchCwd }, launch.lease.accountId, { inferred: false })
  const runScreen = provider.runScreen
  const colorQueries = bindCodexPane({ sessionId, codexRun: proc, runScreen, cols: b.cols, rows: b.rows, ...codexRunWriters(proc) })
  proc.onData((rawData) => {
    if (win.isDestroyed()) return
    if (ptySessions.get(sessionId)?.ptyProcess !== proc) return
    const data = colorQueries.filter(rawData)
    if (data === '') return
    getPtyIntegrityMonitor()?.recordPtyData(sessionId, data.length)
    getWatchdogManager()?.feedData(sessionId, data)
    runScreen?.feed(sessionId, data)
    win.webContents.send(`pty:data:${sessionId}`, data)
  })
  if (b.isAsk === true) codexAskSessions.add(sessionId)
  else codexAskSessions.delete(sessionId)
  bindCodexLaunch({
    win, sessionId, provider, launch, codexCwd: launchCwd, codexSpawnTimestamp: Date.now(),
    // A launch through the resume list (aicc_planning#419): its kept pick file
    // and folder, as the launch bound them, so the list's next decision is
    // read; the conversation it is on (else the decision read last) first.
    built: kept.pick
      ? { pickFile: kept.pick.file, pickFolder: kept.pick.folder, ...(kept.conversation ? { picked: { id: kept.conversation } } : kept.pick.decided ? { picked: kept.pick.decided } : {}) }
      : kept.conversation ? { resumeId: kept.conversation } : {},
    resolvedCwd, codexCanvas: { designatedWorktree: codexDesignatedWorktree(resolvedCwd, sessionId), guidance: null }, runProvider: b.launch.id,
  })
}

/**
 * A kept Codex session's hook file written again in its own folder with this
 * run's gateway port and a token minted for it, when the Hooks gateway is on
 * and listening (its take-over's, and B1d its serving while its tab is not
 * shown). The file, or null when it was not written: then no token is left
 * for it (one minted is dropped). Nothing is recorded of the file here.
 * 2.1.3-beta.18: asked only for a session whose record has no mark that its
 * hook events go through its holder (one 2.1.3-beta.17 or earlier kept, or
 * one whose hooks were on the Hooks gateway).
 */
function rewriteKeptCodexHooks(sessionId: string, hookFolder: string | null, provider: SessionProvider): CodexHookFile | null {
  const { noteGatewayToken, dropGatewayToken } = ports()
  const gw = getGateway()
  const gwStatus = gw?.status()
  if (!hookFolder || !gw || !gwStatus?.listening || !gwStatus.port || !provider.rewriteSessionHooks) return null
  let hookFile: CodexHookFile | null = null
  try {
    const secret = gw.registerSession(sessionId)
    noteGatewayToken(sessionId, true)
    hookFile = provider.rewriteSessionHooks(hookFolder, sessionId, gwStatus.port, secret)
  } catch (err) {
    logError(`[pty] Failed to write the kept Codex session's hook file again for ${sessionId}: ${(err as Error)?.message ?? err}`)
  }
  if (!hookFile) dropGatewayToken(sessionId)
  return hookFile
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
 * renderer's, resolved as a launch's is) by the way its provider's sessions
 * are started; for a Codex session with a kept hook folder, its hook file
 * written again with a new token (rewriteKeptCodexHooks), so its hook events
 * reach this run, unless its hook events go through its holder (2.1.3-beta.18,
 * the record's mark: its keeper takes them). Nothing of the account, the telemetry, the logging run or
 * the conversation, and no hook file or hooked launch is recorded, so no
 * hook claims a transcript before its take-over. The take-over's spawn runs
 * the teardown first (killPty), which clears all of it and the mark (B1e:
 * but leaves the gateway token, keepServedToken, for the take-over to write
 * its own over), and makes it again. What this bound goes with
 * unserveKeptLaunchUnseen.
 */
export function serveKeptLaunchUnseen(kept: KeptUnseen, cwd: string | undefined): boolean {
  if (!(getConductorMcpPort() > 0)) return false
  const style = ports().launchStyleOf(kept.provider)
  const provider = tryGetProvider(kept.provider)
  if (!style || !provider) return false
  const { sessionId } = kept
  const resolvedCwd = resolveCwd(cwd)
  try {
    recordHeldToolSession(sessionId, kept.provider)
    unseenServed.add(sessionId)
    if (style === 'direct') {
      // 2.1.3-beta.18: one whose hook events go through its holder (its
      // record's mark) has them taken by its keeper; its file is not written.
      if (kept.hooks !== 'holder') rewriteKeptCodexHooks(sessionId, kept.hookFolder, provider)
      registerCodexLaunchTools({ sessionId, resolvedCwd, codexCanvas: { designatedWorktree: codexDesignatedWorktree(resolvedCwd, sessionId), guidance: null } })
    } else {
      registerClaudeLaunchTools({ sessionId, claudeCwd: kept.folder ?? resolvedCwd, resolvedCwd, designatedWorktree: isHomeOrAncestor(resolvedCwd) ? null : designatedWorktreeDir(resolvedCwd, sessionId) })
    }
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
 * its own token over it (codexTakeOver), and the gateway keeps those events
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

/** Teardown, first part (cleanupSessionResources): the Codex session's
 *  account lease is released. Nothing happens when none is held. */
export function unbindCodexLease(sessionId: string): void {
  const { codexLaunchLeases } = ports()
  // WP2: the Codex session's account lease (see codexLaunchLeases).
  const codexLease = codexLaunchLeases.get(sessionId)
  if (codexLease) {
    codexLaunchLeases.delete(sessionId)
    codexLease.release()
  }
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
 * (S16 step 4), read before its kill from what this run bound for it: the
 * conversation it is on (a Codex session's claim, else the transcript a
 * Claude Code session named, by its file name), the account (a Codex
 * session's lease, else the profile a Claude Code session started under;
 * null for the default account) and its Codex hook folder. Each is null when
 * not known: a session that has not started a conversation yet has none.
 * And (aicc_planning#419) a launch through the resume list's pick, from its
 * watcher, while the pick folder is still the one made.
 */
export function describeLaunch(sessionId: string): KeptLaunchFacts {
  const { codexLaunchLeases, codexHookFiles, keptCodexConversations, claudeTranscripts, codexTelemetrySources } = ports()
  const claim = keptCodexConversations.get(sessionId)?.uuid
  const named = claudeTranscripts.get(sessionId)
  const fromName = named ? /([^\\/]+)\.jsonl$/.exec(named)?.[1] : undefined
  const conversation = [claim, fromName].find((id): id is string => typeof id === 'string' && CONVERSATION_ID_RE.test(id)) ?? null
  const account = codexLaunchLeases.get(sessionId)?.accountId ?? getClaudeProfileId(sessionId) ?? null
  const hookFile = codexHookFiles.get(sessionId)?.hookFile
  let pick: KeptLaunchFacts['pick'] | null = null
  try { pick = codexTelemetrySources.get(sessionId)?.pick?.() ?? null } catch { pick = null }
  return { conversation, account, hookFolder: hookFile ? path.dirname(hookFile) : null, ...(pick ? { pick } : {}) }
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
 * the take-over still writes this run's address into it (claudeTakeOver).
 */
export function holdKeptLaunchFiles(kept: KeptLaunch): void {
  if (fs.existsSync(getLocalSessionStatusUrlPath(kept.sessionId))) writeLocalSessionStatusUrl(kept.sessionId, '')
}

setKeptLaunchBindings({ describe: describeLaunch, remove: removeKeptLaunchFiles, hold: holdKeptLaunchFiles, serve: serveKeptLaunchUnseen, unserve: unserveKeptLaunchUnseen })
