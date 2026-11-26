// 2.1.3-beta.19 section 2 (aicc_planning#439): Codex's local launch, its
// package's `localLaunch` group (SessionProvider.localLaunch). The body is
// pty-manager.ts's direct branch at cc36c7f3, moved with no change (ADR-021):
// the PTY manager now asks the session's provider for its group through the
// registry, names no provider, and hands it the session (`localLaunch`, the
// request) and its records and doors (`core`, src/main/providers/types.ts
// LocalLaunchCore), which the first lines below unpack under the names the
// body has always used. What the branch assigned in the PTY manager (the
// session's terminal, and when its process was started) is the answer. Its
// bind after the start is its package's lifecycle object's (2.1.3, lifecycle.ts).
import type * as pty from 'node-pty'
import { nativeTheme } from 'electron'
import { logInfo, logWarn } from '../../debug-logger'
import { conductorToolsMasterOn } from '../../conductor-tools-switch'
import { getConductorMcpPort } from '../../conductor-mcp-server'
import { prepareCodexCanvasLaunch } from '../../canvas/codex-canvas-launch'
import { readConfig } from '../../config-manager'
import { askConductorProjectDocMaxBytes } from '../../help-workspace'
import { bundledConptyChoice, bundledConptyFailed, SYSTEM_CONPTY_OPTIONS, type ConptySpawnOptions } from '../../bundled-conpty'
import { getPtyIntegrityMonitor } from '../../services/pty-integrity-monitor'
import { getWatchdogManager } from '../../watchdog/watchdog-manager'
import { stripSpoofableText } from '../../../shared/safe-text'
import { resolveHostColorScheme } from '../host-color-scheme'
import type { LocalLaunchCore, LocalLaunchRequest, LocalLaunchStarted, ProviderLocalLaunch, SpawnOptions } from '../types'
import { CODEX_LIFECYCLE } from './lifecycle'

/** A path as a log line names it (pty-manager.ts's own rule). */
const describePathForLog = (p: string): string => stripSpoofableText(p, 300)

function startCodexLocalLaunch(localLaunch: LocalLaunchRequest, core: LocalLaunchCore): LocalLaunchStarted {
  const { win, sessionId, options, resolvedCwd, cols, rows } = localLaunch
  const {
    mintCodexHooks, keepCodexHooks, bindCodexLease, bindCodexPane,
    keptCodexConversations, codexResumedById, keepCodexConversation, codexAskSessions, ptySessions, codexLaunchLeases, takenCodexLeases,
    releaseCodexLeaseOnExit, closeRunScreens, forgetCodexHooks, dropGatewayToken, codexConversationsOpenElsewhere, typeAskQuestion,
    askLaunchFolderHolds, spawnAgentPty, noteAgentRunFolder, codexRunWriters, watchBundledConptyEarlyExit,
  } = core
  let ptyProcess: pty.IPty
  let codexLaunchedAt: number
  // Codex local session — spawn `codex` directly. Codex itself owns the
  // REPL, so there is no shell-wrap-then-cd-then-launch dance like Claude
  // requires. cwd is propagated through pty.spawn options.
  // The PTY manager chooses it by the provider's package (its local launch
  // group), not by its name. shellOnly takes the PTY manager's other branch,
  // so the user gets a plain shell, regardless of provider selection.
  //
  // WP2 (plan A10): it runs ONLY in its account's realm, from the launch
  // pty:spawn prepared -- the executable setup proved and the realm's
  // environment. There is no other way to start one: no second resolution
  // of the executable, and never the ambient home.
  const launch = options?.codexLaunch
  if (!launch) {
    throw new Error('A Codex session needs its account: choose a Codex account for this session.')
  }
  // Copilot review on PR #31 (p9.15): buildSpawnCommand or pty.spawn can
  // throw before onExit is wired up (binary missing, ConPTY init failure,
  // node-pty resolver miss). A spawn that failed releases its lease, and
  // ends a PTY it had already started, so no Codex runs unheld.
  let started: pty.IPty | undefined
  // P3.10 (rows 43, 46, 47, 63): the app's hooks for this launch, when the
  // Hooks gateway is on and listening -- as the Claude branch's injectHooks:
  // a token minted for the session, and the file that hands it to the hook
  // (never a command line). The previous launch's are gone with its
  // resources (killPty above).
  let hookFile: { hookFile: string; dispose(): void } | null = null
  // Round 1 (B2): whether this launch minted the session's gateway token,
  // which goes again whenever nothing will use it.
  let tokenMinted = false
  try {
    const provider = localLaunch.provider
    ;({ hookFile, tokenMinted } = mintCodexHooks(sessionId, provider))
    // P3.5 (rows 34, 35): the conversation to resume exactly, as the Claude
    // branch does -- a restored tab's persisted one (options.resume), else,
    // on a Restart, the one the tab is on (kept across the kill). "Restart
    // and pick a conversation" (the picker) is never overridden by the kept
    // one. The builder resumes it only when its rollout is in this launch's
    // realm, checks the id again, and says where the CLI starts.
    // P3.6: a respawn onto another account from a conversation whose claim
    // was not certain resumes none (`freshConversation`, main only).
    let resumeTarget = options?.resume ?? (options?.useResumePicker || launch.freshConversation === true ? undefined : keptCodexConversations.get(sessionId))
    // P4.3 review RASK-1: an Ask launch resumes only a conversation of the
    // help folder it starts in, and starts the CLI there (askLaunchFolderHolds).
    if (options?.isAsk === true && resumeTarget) {
      const held = askLaunchFolderHolds(resumeTarget.cwd, resolvedCwd)
      if (!held) logInfo(`[pty-manager] Ask ${sessionId}: its conversation ran in another folder; started afresh in the help folder`)
      resumeTarget = held ? { uuid: resumeTarget.uuid, cwd: resolvedCwd } : undefined
    }
    // ADR-009 round 1 (PR 4): an opening question is honoured only on a
    // launch made as Ask Conductor; on any other it is ignored, and the log
    // says so in a fixed sentence (never the question).
    const askQuestion = options?.isAsk === true ? options?.askPrompt : undefined
    if (options?.askPrompt && options?.isAsk !== true) logWarn(`[pty-manager] Codex ${sessionId}: an opening question on a launch that is not Ask Conductor's is ignored`)
    // WP2 PR 4, P4.1 (row 51): the Agent Canvas for this launch, as a Claude
    // session has it (canvas/codex-canvas-launch.ts): the worktree CCC
    // designates from the CONFIGURED folder, and the skills in the account's
    // own skills folder (a managed realm's, or this computer's own Codex
    // folder: question 5, answered C), which every route lists.
    // The built-in tools switch, through the one checked read: off while the
    // settings cannot be read (conductor-tools-switch.ts).
    const codexToolsOn = conductorToolsMasterOn() && getConductorMcpPort() > 0
    const codexCanvas = prepareCodexCanvasLaunch({
      sessionId,
      configuredCwd: resolvedCwd,
      home: launch.home ?? launch.env.CODEX_HOME ?? '',
      managedSkillsDirFor: (home, resourcesDir) => provider.stagedSkillsDir?.(home, resourcesDir) ?? null,
      toolsOn: codexToolsOn,
      ...(launch.ownership ? { ownership: launch.ownership } : {}),
    })
    const codexSpawnOptions: SpawnOptions = {
      sessionId,
      provider: 'codex',
      // The configured directory, resolved: where an exact resume falls
      // back to when the conversation's own directory does not hold.
      cwd: resolvedCwd,
      cols,
      rows,
      useResumePicker: options?.useResumePicker,
      codexOptions: options?.codexOptions,
      realmLaunch: { executable: launch.executable, env: launch.env, sessionsDir: launch.sessionsDir },
      ...(resumeTarget ? { resume: { uuid: resumeTarget.uuid, cwd: resumeTarget.cwd } } : {}),
      // Same light/dark signal the local Claude spawn gets (book item 34).
      hostColorScheme: resolveHostColorScheme(
        readConfig<{ theme?: string }>('settings')?.theme,
        nativeTheme.shouldUseDarkColors,
      ),
      ...(hookFile ? { codexHooks: { hookFile: hookFile.hookFile } } : {}),
      // Round 1 (V2): for the picker, the conversations other tabs are on.
      ...(options?.useResumePicker ? { codexOpenElsewhere: codexConversationsOpenElsewhere(sessionId, launch.lease.accountId) } : {}),
      // WP2 PR 4, P4.3 (row 53): Ask Conductor's opening question (argv
      // after `--` on the direct route's fresh launch; otherwise typed
      // through the run screen below), and on every Ask launch the scope of the
      // help folder's AGENTS.md (its byte bound, no parent folder's).
      ...(askQuestion ? { askPrompt: askQuestion } : {}),
      ...(options?.isAsk === true ? { askProjectDocMaxBytes: askConductorProjectDocMaxBytes() } : {}),
    }
    const built = provider.buildSpawnCommand(codexSpawnOptions)
    const { cmd: spawnCmd, args: spawnArgs, env: spawnEnv, commandLine } = built
    const hooked = built.hooksInstalled === true && !!hookFile
    ;({ hookFile, tokenMinted } = keepCodexHooks(sessionId, { hookFile, tokenMinted }, hooked))
    // Round 1 (S4): the conversation this launch resumed by id keeps its doubt.
    if (built.resumeId) codexResumedById.set(sessionId, built.resumeId.toLowerCase())
    logInfo(`[pty-manager] Codex hooks for ${sessionId}: ${hooked ? 'on' : 'off (the Hooks gateway is off or not listening, or the hook could not be given on this launch)'}`)
    // Where the CLI runs: the resumed conversation's own directory, else the configured one.
    const codexCwd = built.cwd || resolvedCwd
    // The tab is on the conversation it resumes; a launch that resumes
    // nothing (the picker, a fresh start) lets the kept one go until the
    // status line claims the next.
    if (built.resumeId) keepCodexConversation(sessionId, { uuid: built.resumeId, cwd: codexCwd }, launch.lease.accountId, { inferred: false })
    else keptCodexConversations.delete(sessionId)
    // Said, never silent: the conversation's rollout does not record the
    // directory this session kept, so it resumes in the configured one.
    if (built.resumeId && built.resumeCwdMismatch) {
      logWarn(`[pty-manager] Codex resume for ${sessionId}: no rollout of ${built.resumeId} records the directory the session kept; resuming in ${describePathForLog(codexCwd)}`)
    }
    // P3.15 (row 71): on Windows a local Codex session runs under node-pty's
    // bundled ConPTY (its conpty.dll and the OpenConsole.exe beside it, the
    // console host Windows Terminal ships). The ConPTY built into Windows
    // repaints Codex's screen in place, so the terminal kept no scrollback
    // and the wheel did nothing; the bundled one passes Codex's scrolling
    // through. The system ConPTY when the bundled files are missing (said in
    // the launch line, with the folder it was looked for in when bundled, and
    // once in bundled-conpty.ts). Claude sessions, plain terminals and SSH
    // sessions keep the system ConPTY, as before.
    const conpty = bundledConptyChoice()
    const conptyNote = conpty.kind === 'bundled' ? ` conpty=bundled (${describePathForLog(conpty.dir)})`
      : conpty.kind === 'system' ? ` conpty=system (${describePathForLog(conpty.reason)})` : ''
    // The builder's log line (long or private values named by length); a
    // builder that gives none: no argument is logged.
    logInfo(`[pty-manager] Launching Codex PTY: ${spawnCmd} ${built.logLine ?? '(arguments not logged)'} cwd=${describePathForLog(codexCwd)} (resume=${built.resumeId ?? 'none'})${conptyNote}`)
    // WP2 PR 4, P4.1: the worktree CCC designates for the session, told to
    // its guard as a Claude session's is (ADR-016). Any inherited hint goes
    // first, in every spelling (Windows names are case-insensitive), and
    // none is set when the session designates none.
    for (const k of Object.keys(spawnEnv)) if (k.toUpperCase() === 'CCC_SESSION_WORKTREE') delete (spawnEnv as Record<string, string>)[k]
    if (codexCanvas.designatedWorktree) (spawnEnv as Record<string, string>).CCC_SESSION_WORKTREE = codexCanvas.designatedWorktree
    // Capture timestamp before spawn so the watch-and-claim window starts no later than PTY launch.
    const codexSpawnTimestamp = Date.now()
    codexLaunchedAt = codexSpawnTimestamp
    // The lease is this session's from here: the killPty above has already
    // released the previous spawn's (or will, once its process has ended).
    bindCodexLease(sessionId, launch.lease)
    // A cmd.exe line goes verbatim (see buildSpawnCommand's `commandLine`).
    // The ConPTY options are the choice's own; nothing else differs between
    // the bundled and the system ConPTY.
    const spawnCodexPty = (conptyOptions: ConptySpawnOptions): pty.IPty => spawnAgentPty({ sessionId, kind: 'codex' }, spawnCmd, commandLine ?? spawnArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: codexCwd,
      env: spawnEnv,
      ...conptyOptions,
    })
    let onBundledConpty = conpty.kind === 'bundled'
    try {
      ptyProcess = started = spawnCodexPty(conpty.options)
    } catch (err) {
      // P3.15 round 1 (F1): the bundled files can be there and still fail as
      // the session starts (blocked or damaged, OpenConsole.exe unable to
      // start). node-pty's startProcess then throws before Codex is started
      // (Codex is created later, in node-pty's connect). A throw after
      // startProcess (opening the console's input pipe) could in theory leave
      // that connect pending and start a Codex no one sees; not seen, and not
      // handled here. The session starts on the system ConPTY, and the rest
      // of the run uses it. A start that fails there too is not the bundled
      // ConPTY's fault (a missing executable): the first error goes on and
      // the choice stays.
      if (conpty.kind !== 'bundled') throw err
      try { ptyProcess = started = spawnCodexPty(SYSTEM_CONPTY_OPTIONS) } catch { throw err }
      onBundledConpty = false
      bundledConptyFailed(String((err as Error)?.message ?? err))
      logInfo(`[pty-manager] Codex PTY for ${sessionId}: the bundled ConPTY failed to start; started on the system ConPTY`)
    }
    if (onBundledConpty) watchBundledConptyEarlyExit(sessionId, started)
    // ADR-009 round 1 (PR 4): where this run works, until it has ended.
    noteAgentRunFolder(started, sessionId, codexCwd)
    // WP2 PR 4, P4.1: main's own reading of this run's screen, for the
    // submit primitive (the package's runScreen), fed below through the
    // Watchdog's CSI clamp.
    const codexRun = started
    const runScreen = provider.runScreen
    const colorQueries = bindCodexPane({ sessionId, codexRun, runScreen, cols, rows, ...codexRunWriters(codexRun) })
    ptyProcess.onData((rawData) => {
      if (win.isDestroyed()) return
      if (ptySessions.get(sessionId)?.ptyProcess !== ptyProcess) return // rc.15 review R9
      const data = colorQueries.filter(rawData)
      if (data === '') return
      getPtyIntegrityMonitor()?.recordPtyData(sessionId, data.length)
      // P3.10 (rows 43, 46): the Watchdog's pane and silence clock, as a
      // Claude session's; a no-op until the session arms one (off by default).
      getWatchdogManager()?.feedData(sessionId, data)
      runScreen?.feed(sessionId, data)
      win.webContents.send(`pty:data:${sessionId}`, data)
    })
    // WP2 PR 4, P4.3 (row 53): an Ask session takes later questions through
    // its run screen (handOffAskQuestion). A question this launch did not carry
    // on argv (the npm .cmd route, an exact resume, the picker, a question
    // argv may not hold) is typed there at Codex's first ready, empty
    // composer, never into its trust or sandbox screens; scheduled for once
    // spawnPty has registered this run (below the provider branches).
    if (options?.isAsk === true) codexAskSessions.add(sessionId)
    else codexAskSessions.delete(sessionId)
    if (askQuestion && !built.askPromptOnArgv) setImmediate(() => { void typeAskQuestion(win, sessionId, askQuestion) })
    CODEX_LIFECYCLE.bind({ win, sessionId, provider, launch, codexCwd, codexSpawnTimestamp, built, resolvedCwd, codexCanvas, runProvider: 'codex' }, core)
  } catch (err) {
    // P3.10: a launch that failed keeps no hook file or hooked mark, and
    // (round 1, B2) no gateway token it minted.
    closeRunScreens(sessionId)
    codexAskSessions.delete(sessionId)
    if (hookFile) { try { hookFile.dispose() } catch { /* best-effort */ } }
    forgetCodexHooks(sessionId)
    if (tokenMinted) dropGatewayToken(sessionId)
    if (codexLaunchLeases.get(sessionId) === launch.lease) codexLaunchLeases.delete(sessionId)
    if (started) {
      // A PTY that started: its lease goes when its process does.
      takenCodexLeases.add(launch.lease)
      releaseCodexLeaseOnExit(started, launch.lease)
      try { started.kill() } catch { /* already gone */ }
    } else {
      launch.lease.release()
    }
    throw err
  }
  return { ptyProcess, launchedAt: codexLaunchedAt }
}

/** Codex's local launch group: its CLI as the terminal's own program. */
export const CODEX_LOCAL_LAUNCH: ProviderLocalLaunch = Object.freeze({ start: startCodexLocalLaunch })
