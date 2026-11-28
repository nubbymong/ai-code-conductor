/**
 * Remote step 1's door from the PTY manager (2.1.3-beta.17, plan section A2).
 *
 * pty-manager.ts asks remoteHelperPty once per SSH spawn, at the top of its
 * SSH branch, after the branch refuses a provider SSH does not run. It answers a terminal through
 * the session helper on the tab's machine when routeSshTab says so and the
 * tab's provider has a remote launch (asked through the registry by the
 * tab's provider id, 2.1.3-beta.18 section 2), and null otherwise; null
 * leaves the SSH branch exactly as it was (the usual SSH
 * path), and either way one log line says which and why. The switch is read
 * first: while it is off nothing else of the feature is asked (its records
 * file is not read or made). Until main plugs in the deps
 * (setRemoteHelperDeps, from ipc/remote-machines-handlers.ts at start-up)
 * every tab takes the usual path.
 *
 * 2.1.3-beta.19 section 1.2: an SSH Persistent tab goes through the helper
 * too, kept there until it is ended (route.ts). Main remembers each SSH tab's
 * last path by app session id for the run, and is told which tabs a restore
 * brought back (noteRestoredRemoteTabs); a tab's saved mark comes with its
 * spawn (`remoteVia`). Such a tab's flow state names the machine that keeps
 * it (`kept`), so the renderer marks its saved record at once. A marked tab
 * the helper cannot take now starts nothing and says the step.
 *
 * 2.1.3-beta.20 section 3 (Sign in on this machine): a tab whose config
 * names an account (`profileId`) starts on that account's sign-in on the
 * machine, as ./session.ts reads it at the launch: its own folder there, the
 * machine's own sign-in when that is the account, or nothing, with the
 * renderer told why (REMOTE_ACCOUNT_NOTICE). A sign-in tab
 * (`remoteAccountSignIn`, with its account) runs the CLI's own sign-in in the
 * account's folder there; it only ever goes through the helper (never the
 * usual path), as a plain SSH tab (the away clock), and its end reads the
 * machine again. The Machines page's accounts (each machine's last read, no
 * exec) and a sign-out on a machine are this file's too
 * (remoteAccountsState, signOutRemoteAccount), and so are Check's and the
 * start-up list's reads (readRemoteAccounts) and Remove's sign-outs
 * (signOutForRemove).
 *
 * This file imports nothing of Electron: the window is given as the little it
 * needs.
 */
import type { IPty } from 'node-pty'
import { IPC } from '../../shared/ipc-channels'
import { SSH_THROUGH_HELPER, type RemoteActionResult, type RemoteMachineSessions } from '../../shared/remote-machines'
import type { HostAccountNotice, HostAccountsState, HostAdoptRequest, HostAdoptResult, HostMachineAccounts, HostSignOutRequest, HostSignOutResult } from '../../shared/host-accounts'
import type { DetachedRemote, DetachedRemoteLiveness } from '../../shared/types'
import { DEFAULT_PROVIDER_ID, PROVIDER_IDS, type ProviderId } from '../../shared/providers/ids'
import { tryGetProvider } from '../providers'
import { colorFgBgValue, resolveHostColorScheme } from '../providers/host-color-scheme'
import type { ProviderRemoteLaunch, RemoteAccounts, RemoteHostFile, RemoteLaunchOptions } from '../providers/types'
import type { SSHOptions } from '../ssh-options'
import { ROUTE_WHY, routeSshTab, type PersistentStanding, type Route } from './route'
import { NoticePty, RemoteDriver, RemoteHelperPty, remoteCwd, remoteHelperCommands, remoteLaunchSpec, remoteSessionId, type RemoteLaunchPlan, type RemoteTabAccount } from './session'
import { accountAliasesOf, accountFolder, accountNamer, adoptAccountFolders, hostAccountsState, machineAccounts, readMachineAccounts, signOutListOnMachine, signOutOnMachine, type HostProfile } from './host-accounts'
import { joinNames, namedAccounts, notHeldName, sentenceStart } from '../../shared/host-accounts'
import { ACCOUNT_PROFILE_RE } from './scripts'
import { listKept, machineSessions } from './kept'
import type { HolderKind } from './scripts'
import { HOST_READS_MAX, hostReadProblem, sessionFilesInput } from './session-files'
import type { RemoteSignalDeps } from './signals'
import { machineName, type RemoteMachineRecord, type RemoteMachines } from './machines'
import type { SshRunner } from './ssh-exec'
import { registerRemoteReviewSession } from './review-sessions'

export type { RemoteSignalDeps } from './signals'

export interface RemoteHelperDeps {
  platform: NodeJS.Platform
  /** The saved settings, read at each spawn; null when they do not read. */
  settings: () => Record<string, unknown> | null
  machines: RemoteMachines
  runner: SshRunner
  /** The SHA-256 the installer's manifest gives the Linux helper for an
   *  architecture (the machine's own); null: none for it. */
  bundledSha256: (arch: string) => string | null
  /** The system's dark preference (Electron's nativeTheme), for the theme 'system'. */
  systemPrefersDark: () => boolean
  /** What the tab was sent, for the PTY integrity count: the session id and the text's length. */
  onOutput: (sessionId: string, length: number) => void
  log: (message: string) => void
  /** Where a tab's status line, hook events and tool streams go (2.1.3-beta.18
   *  section 3.2). Absent: a tab through the helper gets none of them. */
  signals?: RemoteSignalDeps
  /** The Session Watchdog for a tab through the helper (2.1.3-beta.19 fix
   *  round): armed once its CLI runs in its holder, fed what the tab is sent.
   *  Absent: such a tab has none. */
  watchdog?: RemoteWatchdogDeps
  /** The left-running registry as saved (session-state.ts
   *  readDetachedRemotesRegistry), read at an SSH Persistent tab's start for
   *  its config's tmux entries (2.1.3-beta.19). Absent: none. */
  registry?: () => readonly DetachedRemote[]
  /** 2.1.3-beta.20 section 3.1.4: what this computer holds of an account
   *  for its sign-in, read when a sign-in tab starts: its email (so the CLI's
   *  sign-in asks for that account) and its sign-in method (fix round,
   *  MINOR-5: as this computer's own sign-in of it uses). Absent, or a field
   *  left out: none is named, and the method is the CLI's default. */
  profileSignIn?: (profileId: string) => { email?: string; method?: string }
}

/** What a tab through the helper needs of the Session Watchdog
 *  (watchdog/remote-helper-tab.ts gives it). */
export interface RemoteWatchdogDeps {
  /** The tab's CLI runs in its holder (its first attach): arm its Watchdog,
   *  as a usual SSH tab's is armed at its claude-running latch. */
  arm(sessionId: string, tab: { provider: ProviderId; shellOnly: boolean; ask: boolean; cols: number; rows: number }): void
  /** What the tab was sent, as a usual tab's output feeds it. */
  feed(sessionId: string, data: string): void
}

let deps: RemoteHelperDeps | null = null

export function setRemoteHelperDeps(d: RemoteHelperDeps | null): void {
  deps = d
}

/** The open tabs through the helper, by app session id. */
const openTabs = new Map<string, RemoteHelperPty>()
/** Each tab whose latest start went through the helper, by app session id,
 *  until it is closed or started again: a start that failed at once (its
 *  terminal over, out of openTabs) still has no SSH flow. A marked tab that
 *  started nothing is here too (its note is its terminal). */
const startedThroughHelper = new Map<string, IPty>()
/** 2.1.3-beta.19: each SSH tab's last path this run, by app session id,
 *  until the tab is closed: `kept` through the helper until it is ended (an
 *  SSH Persistent tab's), `clock` through it with the away clock, `today`
 *  the usual path. */
const lastPath = new Map<string, 'kept' | 'clock' | 'today'>()
/** The SSH Persistent tabs whose last start took the usual path, by app
 *  session id, with their config's id: their config is under tmux. */
const todayTabs = new Map<string, string | undefined>()
/** The tabs the last restore brought back (their saved mark, if any, comes
 *  with their spawn): one with no mark reads as tmux. */
const restoredTabs = new Set<string>()
/** The machine that keeps each kept tab's session, by app session id, for
 *  the flow state's catch-up. */
const keptOn = new Map<string, string>()
/** The kept tabs whose terminal attached at least once this run, by app session id, until the tab is closed: only such a tab, one a restore brought back, or one opened by Re-attach launches again on its conversation when its kept session is gone; a tab whose first start failed starts fresh. */
const keptShown = new Set<string>()

/** How many open tabs go through the helper on machine `did` (Remove waits for none). */
export function remoteTabsOn(did: string): number {
  let n = 0
  for (const p of openTabs.values()) if (p.machineDid === did) n++
  return n
}

/** True while this app session's tab was last started through the helper,
 *  also once that start has failed, until the tab is closed or started again
 *  (the SSH flow overlay is not shown for it). */
export function isRemoteHelperTab(sessionId: string): boolean {
  return startedThroughHelper.has(sessionId)
}

/** The tab was closed or restarted (the renderer's kill door): its start is
 *  forgotten. A close also forgets its path (2.1.3-beta.19); a Restart keeps
 *  it, so the tab starts again on the path it started on. */
export function forgetRemoteHelperTab(sessionId: string, restart = false): void {
  startedThroughHelper.delete(sessionId)
  if (restart) return
  lastPath.delete(sessionId)
  todayTabs.delete(sessionId)
  restoredTabs.delete(sessionId)
  keptOn.delete(sessionId)
  keptShown.delete(sessionId)
}

/** The tabs a restore brought back (pty:tabsRestored, 2.1.3-beta.19): an SSH
 *  Persistent one that starts with no mark takes the usual path. One the
 *  renderer names with `tmuxConfigId` (a restored SSH Persistent tab with no
 *  mark) puts its config under tmux at once, before it spawns: a restored tab
 *  not on screen spawns only once shown, and a new tab of that config
 *  meanwhile must not take the helper (D13: one config, one path). A forged
 *  value can only keep a config on the usual path. */
export function noteRestoredRemoteTabs(tabs: ReadonlyArray<{ id: string; tmuxConfigId?: string }>): void {
  for (const t of tabs) {
    restoredTabs.add(t.id)
    if (t.tmuxConfigId !== undefined) todayTabs.set(t.id, t.tmuxConfigId)
  }
}

/** The flow state main answers for a tab through the helper (its catch-up):
 *  with the machine that keeps it, for a kept tab. */
export function remoteHelperFlowState(sessionId: string): { state: string; kept?: { did: string } } | null {
  if (!startedThroughHelper.has(sessionId)) return null
  const did = keptOn.get(sessionId)
  return did ? { state: SSH_THROUGH_HELPER, kept: { did } } : { state: SSH_THROUGH_HELPER }
}

/** The left-running entries that hold a config under tmux: a tmux one (or
 *  one from before the field had another value) for this config, by its id,
 *  or by its host, user and port when the entry has no config id. */
function configUnderTmux(d: RemoteHelperDeps, configId: string | undefined, ssh: SSHOptions, sessionId: string): boolean {
  for (const [id, cfg] of todayTabs) if (id !== sessionId && configId !== undefined && cfg === configId) return true
  let entries: readonly DetachedRemote[] = []
  try { entries = d.registry?.() ?? [] } catch { entries = [] }
  return entries.some((e) => e.mux !== 'helper' && (configId !== undefined && e.configId !== undefined
    ? e.configId === configId
    : e.host === ssh.host && e.username === ssh.username && (e.port ?? 22) === ssh.port))
}

/** The spawn options this reads: pty-manager's own, structurally. */
export interface RemoteSpawnOptions {
  /** The tab's provider; absent: DEFAULT_PROVIDER_ID, as for every spawn. */
  provider?: ProviderId
  ssh?: SSHOptions
  shellOnly?: boolean
  /** An Ask Conductor tab: its Watchdog never arms (#266 MAJOR-5). */
  isAsk?: boolean
  model?: string
  effortLevel?: string
  permissionMode?: string
  extraArgs?: string
  disableAutoMemory?: boolean
  /** The saved config the tab was started from (2.1.3-beta.19: its tmux state). */
  configId?: string
  /** The tab's saved mark (2.1.3-beta.19): its session is kept by the helper. */
  remoteVia?: 'helper'
  /** 2.1.3-beta.20 section 3.1.7: the config's account (a profile id of this
   *  computer). Through the helper, it decides which sign-in the tab runs on
   *  there; absent, the machine's own sign-in, as before. */
  profileId?: string
  /** 2.1.3-beta.20 section 3.1.4 (shared/host-accounts.ts
   *  HOST_SIGN_IN_SPAWN_FIELD): a sign-in tab for `profileId` on the tab's
   *  machine. */
  remoteAccountSignIn?: boolean
}

/** 2.1.3-beta.20 section 3: the provider whose accounts sign in on hosts
 *  (the first registered one with remote accounts; Claude Code in this
 *  release), or null. */
export function remoteAccountsProvider(): { provider: ProviderId; via: RemoteAccounts } | null {
  for (const id of PROVIDER_IDS) {
    const via = tryGetProvider(id)?.remoteLaunch?.accounts?.()
    if (via) return { provider: id, via }
  }
  return null
}

/** What a window must offer for the tab's output. */
export interface OutputWindow {
  isDestroyed(): boolean
  webContents: { send(channel: string, ...args: unknown[]): void }
}

/** The terminal's own variables for the launch: the app's light or dark
 *  scheme (COLORFGBG, host-color-scheme.ts), as the usual SSH launch sets it,
 *  so the CLI draws for the tab's background. */
export function remoteTerminalEnv(settings: Readonly<Record<string, unknown>> | null, systemPrefersDark: () => boolean): Record<string, string> {
  const theme = typeof settings?.theme === 'string' ? settings.theme : undefined
  // The system is asked only when the theme follows it.
  return { COLORFGBG: colorFgBgValue(resolveHostColorScheme(theme, theme === 'system' ? systemPrefersDark() : true)) }
}

/**
 * The tab's launch on machine `m`, from its provider's remote launch (`via`):
 * the tab's saved options and the settings this start read, whether the app
 * serves its tools to it (`tools`), the helper's commands for session `sid`,
 * and every host read not made yet (the session's driver reads them and asks
 * the launch again before the holder starts: ./session.ts). Throws, saying
 * why, when a host read or a session file the launch names cannot be given to
 * the host, or the launch names a variable the session helper's launch sets
 * itself; the tab then takes the usual path, or, when it is marked as kept
 * by the helper, starts nothing and says the step.
 */
export function remoteLaunchOf(via: ProviderRemoteLaunch, m: RemoteMachineRecord, options: RemoteSpawnOptions, settings: Readonly<Record<string, unknown>> | null, systemPrefersDark: () => boolean, sid: string, cols: number, rows: number, tools = false, resumes = false, account: Pick<RemoteLaunchOptions, 'configDir' | 'signIn'> = {}): RemoteLaunchPlan {
  const remotePath = options.ssh?.remotePath
  const launchOptions: RemoteLaunchOptions = {
    // 2.1.3-beta.20 section 3: the account's own folder on the host, and a sign-in tab's sign-in.
    ...(account.configDir ? { configDir: account.configDir } : {}),
    ...(account.signIn ? { signIn: account.signIn } : {}),
    model: options.model,
    effortLevel: options.effortLevel,
    permissionMode: options.permissionMode,
    extraArgs: options.extraArgs,
    disableAutoMemory: options.disableAutoMemory,
    // `resumes`: a marked tab whose kept session is gone launches again on
    // its conversation (2.1.3-beta.19), as a reconnect does: one whose
    // terminal attached this run, one a restore brought back, or one opened
    // by Re-attach (remoteHelperPty); a tab whose first start failed starts fresh.
    reconnect: !!options.ssh?.reconnect || resumes,
    cwd: remoteCwd(remotePath, m.home),
    settings,
    tools,
  }
  const reads = via.hostReads(launchOptions, m)
  if (reads.length > HOST_READS_MAX) throw new Error(`its provider asks for more than ${HOST_READS_MAX} files on the host`)
  for (const r of reads) {
    const why = hostReadProblem(r)
    if (why) throw new Error(`its provider asks for a host file that cannot be read (${why})`)
  }
  const helper = remoteHelperCommands(m, sid)
  const notRead: RemoteHostFile[] = reads.map((r) => ({ from: r.from, path: r.path, content: null }))
  const first = via.launch(launchOptions, m, helper, notRead)
  if (first.files.length > 0) sessionFilesInput(first.files)
  const spec = remoteLaunchSpec(m, first, remoteTerminalEnv(settings, systemPrefersDark), remotePath, cols, rows)
  return { provider: options.provider ?? DEFAULT_PROVIDER_ID, via, options: launchOptions, helper, reads, first, spec }
}

/**
 * The SSH branch's one question: this tab through the session helper, or the
 * usual path (null)? One log line either way. Nothing here throws into the
 * spawn: records that do not read send the tab the usual way, or, for a tab
 * marked as kept by the helper, start nothing and say the step (2.1.3-beta.19).
 */
export function remoteHelperPty(win: OutputWindow, sessionId: string, options: RemoteSpawnOptions, cols: number, rows: number): IPty | null {
  // Each start asks the route again; what it keeps from the last one is the
  // tab's path (lastPath) and its mark, so a tab stays on the path it started on.
  startedThroughHelper.delete(sessionId)
  const d = deps
  const ssh = options.ssh
  // 2.1.3-beta.20 section 3.1.4: a sign-in tab never takes the usual path.
  if (ssh && options.remoteAccountSignIn === true) return signInPty(win, sessionId, options, ssh, cols, rows)
  if (!d || !ssh) return null
  const usual = (why: string): null => {
    d.log(`[remote-helper] ${sessionId}: the usual SSH path, because ${why}`)
    return null
  }
  let settings: Record<string, unknown> | null
  try {
    settings = d.settings()
  } catch {
    settings = null
  }
  const persistent = ssh.detachable !== false
  // A tab's mark (2.1.3-beta.19): its saved record's, or its last start's this run.
  const marked = persistent && (options.remoteVia === 'helper' || lastPath.get(sessionId) === 'kept')
  // Launched again on its conversation when its kept session is gone: only a
  // marked tab that showed its session this run, was restored, or is a Re-attach.
  const resumes = marked && (keptShown.has(sessionId) || restoredTabs.has(sessionId) || ssh.reconnect === true)
  const startsNothing = (r: Extract<Route, { via: 'nothing' }>): IPty => {
    d.log(`[remote-helper] ${sessionId}: nothing started, because its session is kept by the session helper and ${r.why}`)
    const note = new NoticePty(`This tab's session is kept by the session helper on its machine, and it cannot be opened now: ${r.why}. Next: ${r.step}.`, cols, rows)
    startedThroughHelper.set(sessionId, note)
    // Its note reaches the tab as a helper tab's output does (counted the same way).
    note.onData((data) => {
      if (win.isDestroyed()) return
      d.onOutput(sessionId, data.length)
      win.webContents.send(`pty:data:${sessionId}`, data)
    })
    if (!win.isDestroyed()) win.webContents.send(`${IPC.SSH_FLOW_STATE}:${sessionId}`, { state: SSH_THROUGH_HELPER })
    return note
  }
  const usualPath = (why: string): null => {
    if (persistent) {
      lastPath.set(sessionId, 'today')
      todayTabs.set(sessionId, options.configId)
    }
    return usual(why)
  }
  // The switch first: while it is off, the machine records and the manifest
  // are not asked for (a dormant feature makes no file and fails no spawn).
  if (settings?.remoteSessionsThroughHelper !== true) {
    const r = routeSshTab({ platform: d.platform, switchOn: false, ssh, shellOnly: options.shellOnly === true, machine: undefined, bundledSha256: () => null, standing: { marked, sessionUnderTmux: false, configUnderTmux: false } })
    // Remembered all the same: a tab started on the usual path while the
    // switch was off stays there when it is turned on.
    return r.via === 'nothing' ? startsNothing(r) : usualPath(ROUTE_WHY.off)
  }
  let route: Route
  try {
    const standing: PersistentStanding | undefined = persistent
      ? {
          marked,
          sessionUnderTmux: lastPath.get(sessionId) === 'today' || (restoredTabs.has(sessionId) && options.remoteVia !== 'helper'),
          configUnderTmux: !marked && configUnderTmux(d, options.configId, ssh, sessionId),
        }
      : undefined
    route = routeSshTab({
      platform: d.platform,
      switchOn: true,
      ssh,
      shellOnly: options.shellOnly === true,
      machine: d.machines.findByTarget(ssh),
      bundledSha256: d.bundledSha256,
      ...(standing ? { standing } : {}),
    })
  } catch (err) {
    return marked
      ? startsNothing({ via: 'nothing', why: `the session helper's records could not be read (${(err as Error).message})`, step: 'press Check on the Machines page, then Restart' })
      : usualPath(`the session helper's records could not be read (${(err as Error).message})`)
  }
  if (route.via === 'nothing') return startsNothing(route)
  if (route.via === 'today') return usualPath(route.why)
  const m = route.machine
  const kind: HolderKind = route.kind
  // The launch is the tab's provider's, asked through the registry by its id.
  const providerId = options.provider ?? DEFAULT_PROVIDER_ID
  const provider = tryGetProvider(providerId)
  if (!provider?.remoteLaunch) {
    const why = `its provider (${provider?.displayName ?? providerId}) has no launch through the session helper`
    return marked ? startsNothing({ via: 'nothing', why, step: 'End it on the Machines page' }) : usualPath(why)
  }
  const remote = provider.remoteLaunch
  let pty: RemoteHelperPty
  try {
    // The app's tools go to the tab only while it serves them (asked once, at the start).
    let tools = false
    try { tools = d.signals?.toolsServed() === true } catch { tools = false }
    const launchOn = (account: Pick<RemoteLaunchOptions, 'configDir'> = {}): RemoteLaunchPlan =>
      remoteLaunchOf(remote, m, { ...options, provider: providerId }, settings, d.systemPrefersDark, remoteSessionId(sessionId), cols, rows, tools, resumes, account)
    // 2.1.3-beta.20 section 3.1.7: the config's account decides. Its launch
    // on its own folder there, and the same on the machine's own sign-in;
    // the start's read of the machine picks one, or starts nothing.
    const accounts = remote.accounts?.()
    const profileId = typeof options.profileId === 'string' && ACCOUNT_PROFILE_RE.test(options.profileId) ? options.profileId : undefined
    const plan = accounts && profileId ? launchOn({ configDir: accountFolder(m, profileId) }) : launchOn()
    let account: RemoteTabAccount | undefined
    if (accounts && profileId) {
      const own = launchOn()
      account = { profileId, via: accounts, signIn: false, own: { plan: own, spec: own.spec }, notice: (n) => sendNotice(win, n), aliases: accountAliasesOf(settings) }
    }
    pty = new RemoteHelperPty({
      appPtyId: sessionId,
      machine: m,
      installId: d.machines.installId(),
      runner: d.runner,
      spec: plan.spec,
      plan,
      kind,
      ...(d.signals ? { signals: d.signals } : {}),
      ...(account ? { account } : {}),
      log: d.log,
    })
  } catch (err) {
    const why = (err as Error).message
    return marked ? startsNothing({ via: 'nothing', why, step: 'press Check on the Machines page, then Restart' }) : usualPath(why)
  }
  d.log(`[remote-helper] ${sessionId}: through the session helper on ${m.user}@${m.host}:${m.port} (${m.did.slice(0, 8)}), session ${pty.sid}${kind === 'until-ended' ? ', kept until it is ended' : ''}`)
  // 2.1.3-beta.21 (aicc_planning#446): a Claude Code tab (the one kind whose
  // reviewer is Codex) may ask for a Codex review on its machine, in its
  // folder there; never for the home folder there or a folder above it, as
  // a local tab is never registered for its home folder (lifecycle.ts). Its
  // registration goes with the session's (conductor-mcp-server.ts
  // unregisterCodexReviewSession); whether the tool is offered is decided per
  // connection, from the machine's record.
  if (providerId === 'claude' && options.shellOnly !== true) {
    const reviewCwd = remoteCwd(ssh.remotePath, m.home)
    if (!registerRemoteReviewSession(sessionId, { did: m.did, cwd: reviewCwd }, m.home)) {
      d.log(`[remote-helper] ${sessionId}: codex_review NOT registered: its folder on ${m.host} resolves to the home folder or above it. Set a real project folder to enable review.`)
    }
  }
  openTabs.set(sessionId, pty)
  startedThroughHelper.set(sessionId, pty)
  if (persistent) todayTabs.delete(sessionId)
  lastPath.set(sessionId, kind === 'until-ended' ? 'kept' : 'clock')
  if (kind === 'until-ended') keptOn.set(sessionId, m.did)
  else keptOn.delete(sessionId)
  // The tab's SSH flow overlay hides now, also over a card the usual path
  // left on it (a Restart after the switch went on); its catch-up poll reads
  // the same from isRemoteHelperTab. A kept tab's names its machine, so the
  // renderer marks its saved record at this start (a crash keeps the mark).
  if (!win.isDestroyed()) win.webContents.send(`${IPC.SSH_FLOW_STATE}:${sessionId}`, kind === 'until-ended' ? { state: SSH_THROUGH_HELPER, kept: { did: m.did } } : { state: SSH_THROUGH_HELPER })
  let over = false
  pty.onData((data) => {
    if (over || win.isDestroyed()) return
    // Counted as every other tab's output is (pty-manager's recordPtyData), so
    // the Services page's byte gap holds for this tab too.
    d.onOutput(sessionId, data.length)
    try { d.watchdog?.feed(sessionId, data) } catch { /* the Watchdog's own */ }
    win.webContents.send(`pty:data:${sessionId}`, data)
  })
  // 2.1.3-beta.19 fix round: the Watchdog arms once the CLI runs in the
  // holder (the tab's first attach), as an SSH tab's: the pane is drawn by
  // the host, so its retry needs Claude Code's own chrome on screen.
  pty.onRunning(() => {
    if (over) return
    try {
      d.watchdog?.arm(sessionId, { provider: providerId, shellOnly: options.shellOnly === true, ask: options.isAsk === true, cols: pty.cols, rows: pty.rows })
    } catch (err) {
      d.log(`[remote-helper] ${sessionId}: the Watchdog could not be armed (${(err as Error).message})`)
    }
  })
  pty.onExit(() => {
    // An exit of its own (a link given up on); a killed one was counted at its
    // kill, and a close's exit comes after the close forgot the tab.
    if (!over && pty.untilEnded && pty.everShown) keptShown.add(sessionId)
    over = true
    if (openTabs.get(sessionId) === pty) openTabs.delete(sessionId)
  })
  // A Restart or a close: its late output never reaches the tab's next terminal.
  const kill = pty.kill.bind(pty)
  pty.kill = (signal?: string) => {
    over = true
    if (openTabs.get(sessionId) === pty) openTabs.delete(sessionId)
    if (startedThroughHelper.get(sessionId) === pty) startedThroughHelper.delete(sessionId)
    if (pty.untilEnded && pty.everShown) keptShown.add(sessionId)
    kill(signal)
  }
  return pty
}

// ── 2.1.3-beta.20 section 3: Sign in on this machine ──────────────────────

/** A helper tab's account notice, to the renderer (REMOTE_ACCOUNT_NOTICE). */
function sendNotice(win: OutputWindow, n: HostAccountNotice): void {
  if (!win.isDestroyed()) win.webContents.send(IPC.REMOTE_ACCOUNT_NOTICE, n)
}

/** Where the account execs run. */
const accountsCtx = (d: RemoteHelperDeps) => ({ runner: d.runner, installId: d.machines.installId(), log: d.log })

/** A sign-in tab that cannot start: a note that says why, never the usual
 *  path (which would start a session, not a sign-in). */
function signInNotStarted(win: OutputWindow, sessionId: string, why: string, cols: number, rows: number): IPty {
  const d = deps
  d?.log(`[remote-helper] ${sessionId}: the sign-in tab started nothing, because ${why}`)
  const note = new NoticePty(`Sign in on this machine did not start: ${why}.`, cols, rows)
  startedThroughHelper.set(sessionId, note)
  note.onData((data) => {
    if (win.isDestroyed()) return
    d?.onOutput(sessionId, data.length)
    win.webContents.send(`pty:data:${sessionId}`, data)
  })
  if (!win.isDestroyed()) win.webContents.send(`${IPC.SSH_FLOW_STATE}:${sessionId}`, { state: SSH_THROUGH_HELPER })
  return note
}

/**
 * Section 3.1.4: a sign-in tab. The CLI's own sign-in runs in the account's
 * folder on the tab's machine (made at its start: scripts.ts `account
 * make`), through the session helper as a plain SSH tab (the away clock, no
 * tmux, no mark), with no status line, hooks or tools. It never takes the
 * usual path: when the helper cannot take it, it starts nothing and says
 * why. Its end (the sign-in done, given up, or the tab closed) reads the
 * machine again and tells the renderer the account's state there: signed in
 * as the account, signed in as another (marked, never used, Sign out
 * offered), or not signed in.
 */
function signInPty(win: OutputWindow, sessionId: string, options: RemoteSpawnOptions, ssh: SSHOptions, cols: number, rows: number): IPty {
  const d = deps
  if (!d) return signInNotStarted(win, sessionId, ROUTE_WHY.platform, cols, rows)
  const profileId = options.profileId
  if (typeof profileId !== 'string' || !ACCOUNT_PROFILE_RE.test(profileId)) return signInNotStarted(win, sessionId, 'no account of this computer was named for it', cols, rows)
  let settings: Record<string, unknown> | null
  try { settings = d.settings() } catch { settings = null }
  if (settings?.remoteSessionsThroughHelper !== true) return signInNotStarted(win, sessionId, `${ROUTE_WHY.off}; turn it on in Settings, General, first`, cols, rows)
  let route: Route
  try {
    // As a plain SSH tab: the sign-in ends with its tab, and no tmux question applies.
    route = routeSshTab({ platform: d.platform, switchOn: true, ssh: { ...ssh, detachable: false }, shellOnly: false, machine: d.machines.findByTarget(ssh), bundledSha256: d.bundledSha256 })
  } catch (err) {
    return signInNotStarted(win, sessionId, `the session helper's records could not be read (${(err as Error).message})`, cols, rows)
  }
  if (route.via !== 'helper') return signInNotStarted(win, sessionId, route.why, cols, rows)
  const m = route.machine
  const providerId = options.provider ?? DEFAULT_PROVIDER_ID
  const remote = tryGetProvider(providerId)?.remoteLaunch
  const via = remote?.accounts?.()
  if (!remote || !via) return signInNotStarted(win, sessionId, 'its provider\'s accounts do not sign in on other machines', cols, rows)
  let pty: RemoteHelperPty
  try {
    let held: { email?: string; method?: string } = {}
    try { held = d.profileSignIn?.(profileId) ?? {} } catch { held = {} }
    const signIn = { ...(held.email ? { email: held.email } : {}), ...(held.method ? { method: held.method } : {}) }
    const plan = remoteLaunchOf(remote, m, { ...options, provider: providerId, ssh: { ...ssh, reconnect: false } }, settings, d.systemPrefersDark, remoteSessionId(sessionId), cols, rows, false, false, { configDir: accountFolder(m, profileId), signIn })
    pty = new RemoteHelperPty({ appPtyId: sessionId, machine: m, installId: d.machines.installId(), runner: d.runner, spec: plan.spec, plan, kind: 'away', account: { profileId, via, signIn: true }, log: d.log })
  } catch (err) {
    return signInNotStarted(win, sessionId, (err as Error).message, cols, rows)
  }
  d.log(`[remote-helper] ${sessionId}: the sign-in of ${profileId} on ${m.user}@${m.host}:${m.port} (${m.did.slice(0, 8)}) through the session helper, session ${pty.sid}`)
  openTabs.set(sessionId, pty)
  startedThroughHelper.set(sessionId, pty)
  if (!win.isDestroyed()) win.webContents.send(`${IPC.SSH_FLOW_STATE}:${sessionId}`, { state: SSH_THROUGH_HELPER })
  let over = false
  pty.onData((data) => {
    if (over || win.isDestroyed()) return
    d.onOutput(sessionId, data.length)
    win.webContents.send(`pty:data:${sessionId}`, data)
  })
  let readAfter = false
  pty.onExit(() => {
    over = true
    if (openTabs.get(sessionId) === pty) openTabs.delete(sessionId)
    if (readAfter) return
    readAfter = true
    // Its end reads the machine again (section 3.1.6), whatever ended it.
    void readMachineAccounts(accountsCtx(d), m, via).then((acc) => {
      const a = acc.accounts.find((x) => x.profileId === profileId)
      const state = a?.state ?? 'not-read'
      d.log(`[remote-helper] ${sessionId}: after the sign-in of ${profileId} on ${m.host}, it reads ${state}`)
      sendNotice(win, { kind: 'sign-in-ended', sessionId, did: m.did, profileId, state, ...(state === 'someone-else' && a?.facts?.identity ? { identity: a.facts.identity } : {}) })
    })
  })
  const kill = pty.kill.bind(pty)
  pty.kill = (signal?: string) => {
    over = true
    if (openTabs.get(sessionId) === pty) openTabs.delete(sessionId)
    if (startedThroughHelper.get(sessionId) === pty) startedThroughHelper.delete(sessionId)
    kill(signal)
  }
  return pty
}

/** Every added machine's accounts, as their last reads found them (no exec):
 *  the Machines page and the account cards (MACHINES_REMOTE_ACCOUNTS). */
export async function remoteAccountsState(): Promise<HostAccountsState> {
  const d = deps
  const a = remoteAccountsProvider()
  if (!d || !a) return { machines: [] }
  let profiles: readonly HostProfile[] = []
  try { profiles = await a.via.profiles() } catch { profiles = [] }
  return hostAccountsState(d.machines.list().map((m) => m.did), profiles)
}

/** Section 3.1.6: a read of each machine named (all of them when absent),
 *  one exec per machine, at once: after a Check that passed, and at the
 *  start-up list. Each read goes to the listener as it lands. */
export async function readRemoteAccounts(dids?: readonly string[]): Promise<HostMachineAccounts[]> {
  const d = deps
  const a = remoteAccountsProvider()
  if (!d || !a) return []
  const machines = d.machines.list().filter((m) => !dids || dids.includes(m.did))
  return Promise.all(machines.map((m) => readMachineAccounts(accountsCtx(d), m, a.via)))
}

/** How a sign-out's exit status reads. */
function signOutExitText(code: number | null): string {
  if (code === 127) return 'Claude Code was not found there'
  if (code === 124) return 'it did not finish within 60 s'
  return code === null ? 'it gave no exit status' : `it exited ${code}`
}

/** Where to end a sign-in the app could not sign out with the service. */
const END_IT_THERE = 'in your Claude account settings on claude.ai'

/** Final review round 2 (F2-1): the account aliases the saved settings hold
 *  now, so main's answers name accounts as the renderer does; none when the
 *  settings do not read. */
function aliasesNow(d: RemoteHelperDeps): Record<string, string> | undefined {
  try { return accountAliasesOf(d.settings()) } catch { return undefined }
}

/**
 * Section 3.1.8: Sign out on a machine. Refused while a tab on that account
 * runs through the helper there, and (2.1.3-beta.20 fix round, MINOR-3)
 * while the helper keeps a session there that no open tab shows (a tab
 * closed with Leave running, or one inside its away clock): such a session's
 * CLI may run in that account's folder, and its account is not known here.
 * Then the machine is read (one exec), and the account's state decides
 * (MINOR-4): signed in as the machine's own sign-in, it is signed out only
 * with `confirmMachineOwn` (Q5: the renderer asks first, naming it as the
 * machine's own sign-in), its `~/.claude` stays, and a folder of it left
 * there goes too; signed in in its own folder (as itself or as another
 * account), or a folder of it left with no sign-in, the CLI's own sign-out
 * runs in that folder and the folder goes (only it). The machine is read
 * again after it, and the answer carries the account's state then.
 */
export async function signOutRemoteAccount(req: HostSignOutRequest): Promise<HostSignOutResult> {
  const d = deps
  const a = remoteAccountsProvider()
  if (!d || !a) return { ok: false, message: 'Remote sessions through the session helper are not available here.' }
  const m = d.machines.get(req.did)
  if (!m) return { ok: false, message: 'That machine is not on this computer\'s list.' }
  if (!ACCOUNT_PROFILE_RE.test(req.profileId)) return { ok: false, message: 'That is not an account of this computer.' }
  const name = machineName(m)
  // Open tabs on another account are known not to use this one's folder.
  const otherTabs = new Set<string>()
  for (const p of openTabs.values()) {
    if (p.machineDid !== m.did) continue
    if (p.profileId === req.profileId) return { ok: false, message: `A tab on that account runs on ${name}. Close it, then sign out.` }
    otherTabs.add(p.sid)
  }
  const kept = await listKept({ runner: d.runner, installId: d.machines.installId(), log: d.log }, m)
  if (!kept.ok) return { ok: false, message: `Nothing was signed out: the sessions on ${name} could not be listed (${kept.why}).` }
  const unknown = kept.sessions.filter((s) => !otherTabs.has(s.session))
  if (unknown.length > 0) {
    return { ok: false, message: `The session helper keeps ${unknown.length === 1 ? 'a session' : `${unknown.length} sessions`} on ${name} that no open tab shows (a tab closed with Leave running, or one closed in the last two minutes), and it may run on that account. Nothing was signed out: end ${unknown.length === 1 ? 'it' : 'them'} on the Machines page, or wait for a closed tab's session to end, then sign out.` }
  }
  let profiles: readonly HostProfile[] = []
  try { profiles = await a.via.profiles() } catch { profiles = [] }
  // Final review round 2 (F2-1): the Machines page shows this answer word for
  // word, so the account is named as its card names it, with a capital where
  // that starts a sentence. Round 3 (F3-1): a folder of an account this
  // computer does not hold (a read's `others`) is named so, never by its id.
  const who = accountNamer(profiles, aliasesNow(d))(req.profileId)
  const Who = sentenceStart(who)
  const ctx = accountsCtx(d)
  const before = await readMachineAccounts(ctx, m, a.via)
  if (!before.ok) return { ok: false, message: `Nothing was signed out: the accounts on ${name} could not be read (${before.why ?? 'no answer'}).`, state: 'not-read' }
  const acc = before.accounts.find((x) => x.profileId === req.profileId)
  const folder = acc?.folder === true || before.others.includes(req.profileId)
  const machineOwn = acc?.state === 'machine-own'
  if (!machineOwn && !folder) return { ok: true, message: `${Who} is not signed in on ${name}.`, state: acc?.state ?? 'not-signed-in' }
  if (machineOwn && req.confirmMachineOwn !== true) {
    return { ok: false, needsConfirm: 'machine-own', state: 'machine-own', message: `${Who} is signed in on ${name} by that machine's own sign-in (its ~/.claude), so signing it out signs out Claude Code there for everything that uses that sign-in.` }
  }
  const run = await signOutOnMachine(ctx, m, a.via, machineOwn ? 'own' : { profileId: req.profileId })
  // The machine's own sign-in out, a folder of the account left there goes too.
  const stray = machineOwn && folder && run.ok ? await signOutOnMachine(ctx, m, a.via, { profileId: req.profileId }) : null
  const after = await readMachineAccounts(ctx, m, a.via)
  const state = after.accounts.find((x) => x.profileId === req.profileId)?.state
  const withState = state ? { state } : {}
  d.log(`[remote-helper] sign-out of ${req.profileId}${machineOwn ? ' (the machine\'s own sign-in)' : ''} on ${m.host}: ${run.ok ? `logout ${run.logout ?? 'none'}, folder ${run.removed ? 'removed' : 'kept'}` : run.why}${stray ? `; its folder left there: ${stray.ok ? (stray.removed || stray.gone ? 'removed' : 'kept') : stray.why}` : ''}`)
  if (!run.ok) return { ok: false, message: `${Who} was not signed out on ${name}: ${run.why}.`, ...withState }
  if (run.gone) return { ok: true, message: `${Who} was not signed in on ${name} any more.`, signedOutWithService: false, ...withState }
  const told = run.logout === 0
  if (!machineOwn) {
    return told
      ? { ok: true, message: `Signed ${who} out on ${name}, and removed its folder there.`, signedOutWithService: true, ...withState }
      : { ok: run.removed, message: `Removed the sign-in of ${who} from ${name}. Claude Code's sign-out there did not finish (${signOutExitText(run.logout)}), so to end that sign-in everywhere, sign it out ${END_IT_THERE}.`, signedOutWithService: false, ...withState }
  }
  const strayText = stray && !stray.ok ? ` A folder of ${who} left there was not removed: ${stray.why}.` : stray ? ` A folder of ${who} left there was removed too.` : ''
  return told
    ? { ok: !stray || stray.ok, message: `Signed out ${name}'s own sign-in (${who}).${strayText}`, signedOutWithService: true, ...withState }
    : { ok: false, message: `${name}'s own sign-in (${who}) was not signed out: Claude Code's sign-out there did not finish (${signOutExitText(run.logout)}). Run "claude auth logout" there, or end that sign-in ${END_IT_THERE}.${strayText}`, signedOutWithService: false, ...withState }
}

/**
 * Section 3.1.8: Remove's sign-outs, while the machine answers (2.1.3-beta.20
 * fix round, MAJOR-1 and MAJOR-2). The account folders of this computer
 * there, named one by one (each of its accounts, and its folders of accounts
 * it no longer holds that the last read found), are signed out by the CLI's
 * own sign-out and removed, in one exec that needs no read first; only a
 * folder holding this install's marker is touched. A folder the app on
 * another computer made there is left, and the answer says so, as it names
 * any of this computer's folders left (an account removed here that no read
 * found). The machine's own sign-in is left as it is. The first folder that
 * cannot be removed stops Remove, and the answer says which. With the device
 * folder already gone there, nothing is signed out and Remove goes on as
 * before, naming what is still signed in there.
 */
export async function signOutForRemove(m: RemoteMachineRecord): Promise<{ ok: boolean; message: string }> {
  const d = deps
  const a = remoteAccountsProvider()
  if (!d || !a) return { ok: true, message: '' }
  const name = machineName(m)
  let profiles: readonly HostProfile[] = []
  try { profiles = await a.via.profiles() } catch { profiles = [] }
  // Final review round 2 (F2-1): named as the machine's card names them (the
  // page shows this answer as its notice); sentenceStart where a name starts a
  // sentence. Round 3 (F3-1): folders of accounts this computer does not hold
  // are counted as the card counts them ("an account no longer on this
  // computer"), and every list is joined as the card joins it (joinNames).
  const nameOf = accountNamer(profiles, aliasesNow(d))
  const held = new Set(profiles.map((p) => p.id))
  const isHeld = (id: string): boolean => held.has(id)
  const ids = [...profiles.map((p) => p.id), ...machineAccounts(m.did, profiles).others]
  const run = await signOutListOnMachine(accountsCtx(d), m, a.via, ids)
  const done = namedAccounts(run.folders.filter((f) => f.removed && f.logout === 0).map((f) => f.profileId), nameOf, isHeld)
  const untold = namedAccounts(run.folders.filter((f) => f.removed && f.logout !== 0).map((f) => f.profileId), nameOf, isHeld)
  d.log(`[remote-helper] Remove's sign-outs on ${m.host}: ${run.folders.map((f) => `${f.profileId} logout ${f.logout ?? 'none'}${f.removed ? ', removed' : ''}`).join('; ') || 'none'}${run.ok ? `${run.deviceGone ? '; its device folder was gone' : ''}${run.left.length ? `; left ${run.left.join(', ')}` : ''}${run.elsewhere.length ? `; another computer's: ${run.elsewhere.join(', ')}` : ''}` : `; stopped: ${run.why}`}`)
  if (!run.ok) {
    const before = namedAccounts(run.folders.filter((f) => f.removed).map((f) => f.profileId), nameOf, isHeld)
    return { ok: false, message: `Nothing more was removed: the accounts signed in on ${name} could not all be signed out (${run.why ?? 'no answer'}).${before.count ? ` Signed out first: ${before.text}.` : ''}` }
  }
  if (run.deviceGone) return { ok: true, message: (await accountsLeftText(m)).trim() }
  const parts: string[] = []
  if (done.count) parts.push(`Signed out ${done.text} there first.`)
  if (untold.count) {
    const one = untold.count === 1
    parts.push(`Removed the ${one ? 'sign-in' : 'sign-ins'} of ${untold.text} from it; Claude Code's sign-out there did not finish for ${one ? 'it' : 'them'}, so end ${one ? 'that sign-in' : 'those sign-ins'} ${END_IT_THERE}.`)
  }
  // Round 3 (F3-1): this install's folders the list did not name are for
  // accounts this computer does not hold, so they are named so (counted).
  if (run.left.length) {
    const one = run.left.length === 1
    parts.push(`${sentenceStart(notHeldName(run.left.length))} ${one ? 'stays' : 'stay'} signed in there: sign ${one ? 'it' : 'them'} out there, or end ${one ? 'that sign-in' : 'those sign-ins'} ${END_IT_THERE}.`)
  }
  // Round 2 (R1): a folder with the marker of the builds before the install id
  // was in it, for an account this computer does not hold, is left and named
  // (round 3, F3-1: as every surface names such an account, never by its id).
  if (run.old.length) {
    const one = run.old.length === 1
    parts.push(`${one ? 'The folder' : 'The folders'} an earlier build of the app made there for ${notHeldName(run.old.length)} ${one ? 'stays' : 'stay'} signed in there as ${one ? 'it is' : 'they are'}: sign ${one ? 'it' : 'them'} out there, or end ${one ? 'that sign-in' : 'those sign-ins'} ${END_IT_THERE}.`)
  }
  if (run.elsewhere.length) {
    const one = run.elsewhere.length === 1
    // Round 2 (R1): every one named by this computer's accounts: most likely its own from an earlier install whose id was lost.
    parts.push(run.elsewhere.every(isHeld)
      ? `${sentenceStart(joinNames(run.elsewhere.map(nameOf)))}: ${one ? 'its folder' : 'their folders'} there ${one ? 'carries' : 'carry'} another install's mark, and may be this computer's own from an earlier install of the app; ${one ? 'it was' : 'they were'} left as ${one ? 'it is' : 'they are'}. To sign ${one ? 'it' : 'them'} out from here, add the machine again and choose Adopt on its card; or sign ${one ? 'it' : 'them'} out on that machine.`
      : `${one ? 'One account folder' : `${run.elsewhere.length} account folders`} there ${one ? 'is' : 'are'} used by the app on another computer, and ${one ? 'was' : 'were'} left as ${one ? 'it is' : 'they are'}.`)
  }
  return { ok: true, message: parts.join(' ') }
}

/**
 * Round 2 (R1): Adopt on a machine's card, the user's own choice: folders
 * the machine's last read names as another install's, for accounts this
 * computer holds (its own from an earlier install whose id was lost, most
 * likely), get this install's marker; nothing is signed in, out or removed.
 * Any other id is refused before anything runs (adoptAccountFolders).
 */
export async function adoptRemoteAccounts(req: HostAdoptRequest): Promise<HostAdoptResult> {
  const d = deps
  const a = remoteAccountsProvider()
  if (!d || !a) return { ok: false, message: 'Remote sessions through the session helper are not available here.', adopted: [] }
  const m = d.machines.get(req.did)
  if (!m) return { ok: false, message: "That machine is not on this computer's list.", adopted: [] }
  const r = await adoptAccountFolders(accountsCtx(d), m, a.via, req.profileIds, aliasesNow(d))
  // Final review round 2 (F2-2): main's sentence reaches the log only when some id was not adopted.
  d.log(`[remote-helper] Adopt on ${m.host}: ${r.adopted.length ? r.adopted.join(', ') : 'none'}${r.ok ? '' : ` (${r.message})`}`)
  return r
}

/** Section 3.1.8: a machine that does not answer keeps what is signed in
 *  there. The accounts its last answered read found there, and where to end
 *  each; '' when it found none (or it was never read this run, which says so). */
export async function accountsLeftText(m: RemoteMachineRecord): Promise<string> {
  const a = remoteAccountsProvider()
  if (!a) return ''
  let profiles: readonly HostProfile[] = []
  try { profiles = await a.via.profiles() } catch { profiles = [] }
  const acc = machineAccounts(m.did, profiles)
  const name = machineName(m)
  if (acc.readAt === null) return ` The app has not read which accounts are signed in on ${name} since it started; any signed in there stay signed in until you sign them out there, or end those sign-ins ${END_IT_THERE}.`
  // Final review round 2 (F2-1): named as the machine's card names them.
  // Round 3 (F3-1): its folders of accounts this computer does not hold
  // counted as the card counts them, never by their ids, and joined as the
  // card joins them (Remove's not-answering question, removeNotAnsweringText).
  const d = deps
  const nameOf = accountNamer(profiles, d ? aliasesNow(d) : undefined)
  const held = new Set(acc.accounts.map((x) => x.profileId))
  const left = namedAccounts([...acc.accounts.filter((x) => x.folder).map((x) => x.profileId), ...acc.others], nameOf, (id) => held.has(id))
  if (left.count === 0) return ''
  const one = left.count === 1
  return ` ${sentenceStart(left.text)} ${one ? 'stays' : 'stay'} signed in on ${name} until you sign ${one ? 'it' : 'them'} out there, or end ${one ? 'that sign-in' : 'those sign-ins'} ${END_IT_THERE}.`
}

/** One machine's sessions, by list mode (2.1.3-beta.19 section 1.2). */
async function sessionsOn(d: RemoteHelperDeps, m: RemoteMachineRecord): Promise<RemoteMachineSessions> {
  return machineSessions(m.did, await listKept({ runner: d.runner, installId: d.machines.installId(), log: d.log }, m))
}

/** The sessions the helper keeps on each machine named (all of them when
 *  `dids` is absent): one list exec per machine, at once. */
export async function listRemoteSessions(dids?: readonly string[]): Promise<RemoteMachineSessions[]> {
  const d = deps
  if (!d) return []
  const machines = d.machines.list().filter((m) => !dids || dids.includes(m.did))
  return Promise.all(machines.map((m) => sessionsOn(d, m)))
}

/** End on the Machines card: one kept session, by its machine and the
 *  helper's session id, that no open tab holds. */
export async function endRemoteSession(did: string, sid: string): Promise<RemoteActionResult> {
  const d = deps
  if (!d) return { ok: false, message: 'Remote sessions through the session helper are not available here.' }
  const m = d.machines.get(did)
  // A machine removed since keeps no session this app can reach: Remove is
  // refused while its helper lists one (machines.ts remove). So there is
  // nothing to end, and a close's End closes the tab and records no
  // left-running entry for it (2.1.3-beta.19 final-head review).
  if (!m) return { ok: true, message: 'That machine is no longer on this computer\'s list, so nothing is kept there for this app to end.' }
  for (const p of openTabs.values()) if (p.sid === sid) return { ok: false, message: 'A tab shows that session. Close it there and choose End.' }
  const listed = await listKept({ runner: d.runner, installId: d.machines.installId(), log: d.log }, m)
  if (!listed.ok) return { ok: false, message: `Nothing was ended: ${listed.why}.` }
  const rec = listed.sessions.find((s) => s.session === sid)
  if (!rec) return { ok: true, message: 'That session had ended already.' }
  const driver = RemoteDriver.forEnd({ appPtyId: rec.label, machine: m, installId: d.machines.installId(), runner: d.runner, log: d.log, ...(d.signals ? { signals: d.signals } : {}) })
  const r = await driver.endKept(rec)
  d.log(`[remote-helper] ${sid}: ${r.ok ? 'ended' : `not ended (${r.why})`} on ${m.host} from the Machines page`)
  return r.ok ? { ok: true, message: `Ended the session on ${machineName(m)}.` } : { ok: false, message: `The session on ${machineName(m)} was not ended: ${r.why}.` }
}

/**
 * End of a tab's own kept session, by its app session id (the close
 * question's End, or Remove of a session left running): the open tab's, or,
 * with none open, the one on machine `did` (the left-running entry's).
 */
export async function endRemoteTab(sessionId: string, did?: string): Promise<RemoteActionResult> {
  const open = openTabs.get(sessionId)
  if (open) {
    const r = await open.end()
    return r.ok ? { ok: true, message: 'Ended.' } : { ok: false, message: `The session was not ended: ${r.why}.` }
  }
  if (!did) return { ok: false, message: 'No machine keeps that session.' }
  return endRemoteSession(did, remoteSessionId(sessionId))
}

/**
 * A left-running entry's liveness by list mode (2.1.3-beta.19 section 1.2),
 * for the config `target` reaches: 'verified' with the app session ids whose
 * holder list mode names, or 'unverified' when the machine is not added or
 * list mode did not answer (fail-open: nothing is pruned).
 */
export async function remoteHelperLiveness(target: { host: string; port: number; username: string }, sessionIds: readonly string[]): Promise<DetachedRemoteLiveness> {
  const d = deps
  const unverified: DetachedRemoteLiveness = { outcome: 'unverified', liveSessionIds: [] }
  if (!d) return unverified
  let m: RemoteMachineRecord | undefined
  try { m = d.machines.findByTarget(target) } catch { m = undefined }
  if (!m) return unverified
  const listed = await listKept({ runner: d.runner, installId: d.machines.installId(), log: d.log }, m)
  if (!listed.ok) return unverified
  const held = new Set(listed.sessions.map((s) => s.session))
  return { outcome: 'verified', liveSessionIds: sessionIds.filter((id) => held.has(remoteSessionId(id))) }
}
