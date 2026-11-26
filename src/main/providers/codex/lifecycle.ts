// 2.1.3-beta.19 section 2 (aicc_planning#439): Codex's lifecycle object
// (SessionProvider.lifecycle): what the app makes around a local Codex
// session and drops when it ends. The bodies of bindCodexLaunch,
// registerCodexLaunchTools, codexTakeOver and rewriteKeptCodexHooks are
// sessions/launch-bindings.ts's at cc36c7f3, moved with no change (ADR-021):
// the PTY manager's records come from `core` (providers/types.ts
// LifecycleCore) in place of the bindings' ports. The serving while the tab is
// not shown, the unbind and the description are the Codex halves of
// serveKeptLaunchUnseen, unbindCodexLease and describeLaunch, which now ask
// the session's provider for them instead of testing its launch style.
import * as path from 'path'
import type * as pty from 'node-pty'
import type { BrowserWindow } from 'electron'
import type { ProviderId } from '../../../shared/providers'
import type { AccountLease } from '../core'
import type { LifecycleCore, LifecycleKeptSession, LifecycleTakeOver, ProviderLifecycle, ProviderSpawnCommand, ResumePick, SessionProvider, TelemetryOptions } from '../types'
import { getGateway } from '../../hooks'
import { logError, logInfo, logWarn } from '../../debug-logger'
import { isHomeOrAncestor } from '../../path-utils'
import { decorateStatuslineWithColour } from '../../account-color'
import { getWatchdogManager } from '../../watchdog/watchdog-manager'
import { getPtyIntegrityMonitor } from '../../services/pty-integrity-monitor'
import { openNotIndexedWindow } from '../../logging/indexing-gaps'
import { getCodexLogBinder } from '../../logging/codex-log-binder'
import { registerClaudeReviewSession } from '../../conductor-mcp-server'
import type { CodexCanvasLaunch } from '../../canvas/codex-canvas-launch'
import { registerCodexCanvasRoots, codexDesignatedWorktree } from '../../canvas/codex-canvas-roots'
import { noteCodexSessionGuidance, forgetCodexSessionGuidance } from '../../canvas/codex-guidance'

/** A Codex launch's hook file: the file that hands its gateway token to the
 *  hook, with the way to remove it. */
interface CodexHookFile { hookFile: string; dispose(): void }

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

/**
 * A Codex launch's conversation and registrations, once its process has
 * started: the Codex log binder's launch, the folder its watcher matches by,
 * the rollout watch-and-claim telemetry, the claude_review registration, and
 * the Agent Canvas roots and guidance.
 */
function bindCodexLaunch(binding: CodexLaunchBinding, core: LifecycleCore): void {
  const {
    notIndexedSessions, codexContextRollouts, keptCodexConversations, lastCodexHookRollout, codexTelemetrySources,
    noteCodexFolder, keepCodexConversation, markCodexConversationUncertain, clearCodexDoubtFromHook, noteCodexContextRollout, endSessionNotIndexed,
  } = core
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
 * handler, as its local launch's (local-launch.ts; the colour answers take only live queries:
 * the session helper takes the replay's queries out); the Ask mark; and its
 * telemetry, review registration and Agent Canvas roots (bindCodexLaunch), the
 * telemetry claiming the saved conversation by its id, or for a launch through
 * the resume list through its kept pick file (aicc_planning#419).
 */
function codexTakeOver(b: LifecycleTakeOver, launch: { lease: AccountLease; sessionsDir: string }, proc: pty.IPty, kept: LifecycleKeptSession, launchCwd: string, core: LifecycleCore): void {
  const { ptySessions, codexHookFiles, codexHookedLaunches, codexAskSessions, keepCodexConversation, codexRunWriters, settleServedToken, bindCodexLease, bindCodexPane } = core
  const { sessionId, resolvedCwd, win } = b
  const provider = b.launch.provider
  // 2.1.3-beta.18 (ADR-030 S12): a launch whose hook events went through its
  // holder (its record's mark) runs its forwarder from its own environment,
  // which names the holder and never this file: nothing is written again, and
  // its events come through the take-over's attach. Without the mark (its
  // hooks were on the Hooks gateway, or 2.1.3-beta.17 or earlier kept it) the
  // file is written again with this run's port and a new token, as before.
  const throughHolder = kept.hooks === 'holder'
  const hookFile = throughHolder ? null : rewriteKeptCodexHooks(sessionId, kept.hookFolder, provider, core)
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
  }, core)
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
function rewriteKeptCodexHooks(sessionId: string, hookFolder: string | null, provider: SessionProvider, core: LifecycleCore): CodexHookFile | null {
  const { noteGatewayToken, dropGatewayToken } = core
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


/** Codex's lifecycle object. */
export const CODEX_LIFECYCLE: ProviderLifecycle<CodexLaunchBinding> = Object.freeze<ProviderLifecycle<CodexLaunchBinding>>({
  bind: bindCodexLaunch,
  // A Codex take-over needs its launch's preparation: its lease names the account.
  keptAccount: (b: LifecycleTakeOver) => (b.codexLaunch?.lease ? { account: b.codexLaunch.lease.accountId ?? null } : null),
  takeOver: (b: LifecycleTakeOver, proc: pty.IPty, kept: LifecycleKeptSession, launchCwd: string, core: LifecycleCore): string | undefined => {
    codexTakeOver(b, b.codexLaunch!, proc, kept, launchCwd, core)
    return undefined
  },
  serveUnseen: (kept, provider, resolvedCwd, core) => {
    const { sessionId } = kept
    // 2.1.3-beta.18: one whose hook events go through its holder (its
    // record's mark) has them taken by its keeper; its file is not written.
    if (kept.hooks !== 'holder') rewriteKeptCodexHooks(sessionId, kept.hookFolder, provider, core)
    registerCodexLaunchTools({ sessionId, resolvedCwd, codexCanvas: { designatedWorktree: codexDesignatedWorktree(resolvedCwd, sessionId), guidance: null } })
  },
  /** WP2: the Codex session's account lease (see codexLaunchLeases). */
  unbind: (sessionId, core) => {
    const { codexLaunchLeases } = core
    const codexLease = codexLaunchLeases.get(sessionId)
    if (codexLease) {
      codexLaunchLeases.delete(sessionId)
      codexLease.release()
    }
  },
  /** Its claim (the conversation it is on), its lease's account, its hook
   *  folder, and (aicc_planning#419) a launch through the resume list's pick. */
  describe: (sessionId, core) => {
    const { codexLaunchLeases, codexHookFiles, keptCodexConversations, codexTelemetrySources } = core
    const hookFile = codexHookFiles.get(sessionId)?.hookFile
    let pick: ResumePick | null = null
    try { pick = codexTelemetrySources.get(sessionId)?.pick?.() ?? null } catch { pick = null }
    return { conversation: keptCodexConversations.get(sessionId)?.uuid ?? null, account: codexLaunchLeases.get(sessionId)?.accountId ?? null, hookFolder: hookFile ? path.dirname(hookFile) : null, ...(pick ? { pick } : {}) }
  },
})
