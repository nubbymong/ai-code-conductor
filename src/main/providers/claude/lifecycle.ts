// 2.1.3-beta.19 section 2 (aicc_planning#439): Claude Code's lifecycle
// object (SessionProvider.lifecycle): what the app makes around a local
// Claude Code session and drops when it ends. Claude Code's shell launch stays
// in pty-manager.ts until the local cutover; its lifecycle half moved here.
// The bodies of bindClaudeLaunch, registerClaudeLaunchTools and claudeTakeOver
// are sessions/launch-bindings.ts's at cc36c7f3, moved with no change
// (ADR-021): the PTY manager's records come from `core` (providers/types.ts
// LifecycleCore). The serving while the tab is not shown and the description
// are the Claude Code halves of serveKeptLaunchUnseen and describeLaunch.
import * as fs from 'fs'
import type * as pty from 'node-pty'
import type { LifecycleCore, LifecycleKeptSession, LifecycleTakeOver, ProviderLifecycle } from '../types'
import { tryGetProvider } from '../index'
import { logInfo, logWarn } from '../../debug-logger'
import { isHomeOrAncestor } from '../../path-utils'
import { getWatchdogManager } from '../../watchdog/watchdog-manager'
import { getPtyIntegrityMonitor } from '../../services/pty-integrity-monitor'
import { designatedWorktreeDir } from '../../canvas/canvas-worktree'
import { getLocalSessionStatusUrlPath, writeLocalSessionStatusUrl, removeLocalSessionStatusUrl, noteKeptLaunchStatusLine } from '../../hooks/per-session-settings'
import { captureClaudeAccount, getClaudeProfileId, pushAccountIdentity, startWatchingAccountIdentity } from '../../claude-account-identity'
import { registerCodexReviewSession, getConductorMcpPort } from '../../conductor-mcp-server'
import { registerCanvasUatRoot, designateCanvasWorktreeRoot, canvasRootRefusalReason, describeCanvasRootRefusal, setCanvasRootRefusal } from '../../canvas/canvas-store'

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

/**
 * A Claude Code launch's account capture and registrations, right after its
 * process has started: the account the session runs on and the watch on it,
 * the codex_review registration, the Agent Canvas serving root, and the
 * designated worktree.
 */
function bindClaudeLaunch(binding: ClaudeLaunchBinding): void {
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
 * A Claude Code take-over's own bindings: its status line's address file
 * written again with this run's address, only where its launch wrote one (its
 * bridge reads the file each tick; this issues the session's credential into
 * that owner-only file, as a launch's settings write does); the account
 * capture and its watch, the review registration (the folder the CLI was
 * launched in, as a launch registers it) and the Agent Canvas roots (the
 * configured folder and the designated worktree, never a transcript's folder:
 * bindClaudeLaunch's rule); and the data handler, as the Claude Code branch's.
 */
function claudeTakeOver(b: LifecycleTakeOver, proc: pty.IPty, kept: LifecycleKeptSession, launchCwd: string, core: LifecycleCore): void {
  const { ptySessions } = core
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


/** Claude Code's lifecycle object. */
export const CLAUDE_LIFECYCLE: ProviderLifecycle<ClaudeLaunchBinding> = Object.freeze<ProviderLifecycle<ClaudeLaunchBinding>>({
  bind: (binding: ClaudeLaunchBinding) => bindClaudeLaunch(binding),
  // A Claude Code session runs on the account it names or not at all; a
  // launch that names none takes the session on any.
  keptAccount: (b: LifecycleTakeOver) => (b.profileId ? { account: b.profileId } : {}),
  takeOver: (b: LifecycleTakeOver, proc: pty.IPty, kept: LifecycleKeptSession, launchCwd: string, core: LifecycleCore): string | undefined => {
    claudeTakeOver(b, proc, kept, launchCwd, core)
    return kept.account ?? undefined
  },
  serveUnseen: (kept, _provider, resolvedCwd) => {
    const { sessionId } = kept
    registerClaudeLaunchTools({ sessionId, claudeCwd: kept.folder ?? resolvedCwd, resolvedCwd, designatedWorktree: isHomeOrAncestor(resolvedCwd) ? null : designatedWorktreeDir(resolvedCwd, sessionId) })
  },
  /** Its launch holds nothing the teardown's first part drops: its account
   *  capture and watch end with its exit (pty-manager.ts). */
  unbind: () => {},
  /** The transcript it named (the conversation, by its file name) and the
   *  profile it started under. */
  describe: (sessionId, core) => {
    const named = core.claudeTranscripts.get(sessionId)
    return { conversation: (named ? /([^\\/]+)\.jsonl$/.exec(named)?.[1] : undefined) ?? null, account: getClaudeProfileId(sessionId) ?? null }
  },
})
