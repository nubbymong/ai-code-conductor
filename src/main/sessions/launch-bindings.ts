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
// its own exit, and in the teardown every kill and every exit runs
// (cleanupSessionResources) unbindCodexLease, unbindLaunchTelemetry and
// unbindLaunchRegistrations, each at its own place in that teardown.
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
//    and hands the answer in (tests/unit/architecture/provider-name-ratchet.test.ts).
import { nativeTheme, type BrowserWindow } from 'electron'
import type * as pty from 'node-pty'
import type { ProviderId } from '../../shared/providers'
import type { AccountLease } from '../providers/core'
import type { ProviderSpawnCommand, SessionProvider, SessionRunScreen, TelemetrySource } from '../providers/types'
import { getGateway } from '../hooks'
import { removeLocalSessionSettings, removeLocalSessionMcpConfig, removeLocalSessionStatusUrl } from '../hooks/per-session-settings'
import { logInfo, logError, logWarn } from '../debug-logger'
import { readConfig } from '../config-manager'
import { isHomeOrAncestor } from '../path-utils'
import { decorateStatuslineWithColour } from '../account-color'
import { clampAnsiChunk } from '../watchdog/watchdog-manager'
import { createColorQueryResponder, terminalReplyColors, type ColorQueryResponder } from '../terminal-query-responder'
import { shouldRegisterRun } from '../logging/should-register-run'
import { openNotIndexedWindow } from '../logging/indexing-gaps'
import { getLogSupervisor } from '../logging/logging-service'
import { getCodexLogBinder } from '../logging/codex-log-binder'
import { buildResumeTranscriptPath } from '../spawn-claude-command'
import { captureClaudeAccount, getAccountIdentity, pushAccountIdentity, startWatchingAccountIdentity } from '../claude-account-identity'
import { registerCodexReviewSession, registerClaudeReviewSession, unregisterCodexReviewSession, releaseMcpSessionProvider } from '../conductor-mcp-server'
import { registerCanvasUatRoot, revokeCanvasUatRoots, designateCanvasWorktreeRoot, canvasRootRefusalReason, describeCanvasRootRefusal, setCanvasRootRefusal } from '../canvas/canvas-store'
import { forgetCanvasMarkers } from '../canvas/canvas-marker-delivery'
import type { CodexCanvasLaunch } from '../canvas/codex-canvas-launch'
import { registerCodexCanvasRoots } from '../canvas/codex-canvas-roots'
import { noteCodexSessionGuidance, forgetCodexSessionGuidance } from '../canvas/codex-guidance'

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
  keptCodexConversations: Pick<Map<string, unknown>, 'delete'>
  lastCodexHookRollout: Pick<Map<string, unknown>, 'delete'>
  claudeTranscripts: Pick<Map<string, unknown>, 'delete'>
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
  /** Closes the session's pane of the Codex run screen, which only
   *  pty-manager.ts reaches. */
  closeCodexRunScreen(sessionId: string): void
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

/** A Codex run's pane, from the launch that started it. */
export interface CodexPaneBinding {
  sessionId: string
  /** The run's process: the pane is current while the session's PTY is this one. */
  codexRun: pty.IPty
  /** The provider's own reading of a run's screen, when it has one. */
  runScreen: SessionRunScreen | undefined
  cols: number
  rows: number
  /** The raw writer the pane types through: pty-manager.ts's, into codexRun. */
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
  built: Pick<ProviderSpawnCommand, 'resumeId' | 'resumePath' | 'pickFile' | 'pickFolder'>
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
 */
export function bindCodexPane(binding: CodexPaneBinding): ColorQueryResponder {
  const { ptySessions } = ports()
  const { sessionId, codexRun, runScreen, cols, rows, write, writeColourAnswer } = binding
  if (codexRun && runScreen) runScreen.open(sessionId, { cols, rows, write, current: () => ptySessions.get(sessionId)?.ptyProcess === codexRun, clamp: clampAnsiChunk })
  // Codex's colour query (OSC 10/11 `?`), answered here in main the moment
  // the PTY emits it and kept from the renderer, so xterm.js does not answer
  // it a second time (terminal-query-responder.ts). Codex waits 100 ms for
  // the answer and reads a later one as typed text in its composer; the
  // renderer's answer can be later than that while it is busy drawing.
  // Only this branch: Claude sessions, plain terminals and SSH sessions keep
  // xterm.js's own answers.
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
      ...(built.pickFile ? { pickFile: built.pickFile, pickFolder: built.pickFolder } : {}),
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

  // Every LOCAL Claude session with a real project folder REGISTERS for
  // codex_review here; registering does not offer the tool. Whether it is
  // offered is decided per MCP connection (offeredReviewTool, called from
  // conductor-mcp-server createServer): the Conductor tools master and the
  // codex_review switch (Settings, General, Built-in tools) must be on,
  // Codex must be enabled, and a Codex review must be preparable now (the
  // accounts service's reviewReady: the provider on and a reviewer account
  // ready). SSH sessions never reach this branch, so the tool only ever
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

/** The session's own end (its exit, when no newer process has taken the
 *  session over): its gateway token and its per-session files go. */
export function unbindLaunchFiles(sessionId: string): void {
  const { dropGatewayToken } = ports()
  // (P3.10 round 1, B1: with the record that a Codex launch minted it.)
  dropGatewayToken(sessionId)
  removeLocalSessionSettings(sessionId)
  removeLocalSessionMcpConfig(sessionId)
  // ADR-009 token custody: the status-URL sidecar carries this session's MCP
  // token, so it is swept on the SAME teardown as the other two.
  removeLocalSessionStatusUrl(sessionId)
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
 *  nothing when there is nothing to drop. */
export function unbindLaunchTelemetry(sessionId: string): void {
  const { codexTelemetrySources, notIndexedSessions, claudeTranscripts, claudeFolders, codexFolders, endSessionNotIndexed, forgetCodexHooks } = ports()
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
    try { codexTel.stop() } catch { /* noop */ }
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
 *  markers), the Codex pane, the Ask mark and the launch's guidance record.
 *  Each step does nothing when there is nothing to drop. */
export function unbindLaunchRegistrations(sessionId: string): void {
  const { codexAskSessions, closeCodexRunScreen } = ports()
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
  // watchdog below.
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
  // WP2 PR 4, P4.1: the submit primitive's pane of a Codex run goes with it
  // (a submission still waiting on it reports the session gone, and types
  // nothing into the next run), and so does the launch's guidance record.
  closeCodexRunScreen(sessionId)
  codexAskSessions.delete(sessionId)
  forgetCodexSessionGuidance(sessionId)
}
