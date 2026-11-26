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
 * This file imports nothing of Electron: the window is given as the little it
 * needs.
 */
import type { IPty } from 'node-pty'
import { IPC } from '../../shared/ipc-channels'
import { SSH_THROUGH_HELPER } from '../../shared/remote-machines'
import { DEFAULT_PROVIDER_ID, type ProviderId } from '../../shared/providers/ids'
import { tryGetProvider } from '../providers'
import { colorFgBgValue, resolveHostColorScheme } from '../providers/host-color-scheme'
import type { ProviderRemoteLaunch, RemoteHostFile, RemoteLaunchOptions } from '../providers/types'
import type { SSHOptions } from '../ssh-options'
import { ROUTE_WHY, routeSshTab, type Route } from './route'
import { RemoteHelperPty, remoteCwd, remoteHelperCommands, remoteLaunchSpec, remoteSessionId, type RemoteLaunchPlan } from './session'
import { HOST_READS_MAX, hostReadProblem, sessionFilesInput } from './session-files'
import type { RemoteSignalDeps } from './signals'
import type { RemoteMachineRecord, RemoteMachines } from './machines'
import type { SshRunner } from './ssh-exec'

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
 *  terminal over, out of openTabs) still has no SSH flow. */
const startedThroughHelper = new Map<string, RemoteHelperPty>()

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

/** The tab was closed (the renderer's kill door): its start is forgotten. */
export function forgetRemoteHelperTab(sessionId: string): void {
  startedThroughHelper.delete(sessionId)
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
 * itself; the tab then takes the usual path.
 */
export function remoteLaunchOf(via: ProviderRemoteLaunch, m: RemoteMachineRecord, options: RemoteSpawnOptions, settings: Readonly<Record<string, unknown>> | null, systemPrefersDark: () => boolean, sid: string, cols: number, rows: number, tools = false): RemoteLaunchPlan {
  const remotePath = options.ssh?.remotePath
  const launchOptions: RemoteLaunchOptions = {
    model: options.model,
    effortLevel: options.effortLevel,
    permissionMode: options.permissionMode,
    extraArgs: options.extraArgs,
    disableAutoMemory: options.disableAutoMemory,
    reconnect: !!options.ssh?.reconnect,
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
 * spawn: records that do not read send the tab the usual way.
 */
export function remoteHelperPty(win: OutputWindow, sessionId: string, options: RemoteSpawnOptions, cols: number, rows: number): IPty | null {
  // Each start decides afresh; only one through the helper is remembered.
  startedThroughHelper.delete(sessionId)
  const d = deps
  const ssh = options.ssh
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
  // The switch first: while it is off, the machine records and the manifest
  // are not asked for (a dormant feature makes no file and fails no spawn).
  if (settings?.remoteSessionsThroughHelper !== true) return usual(ROUTE_WHY.off)
  let route: Route
  try {
    route = routeSshTab({
      platform: d.platform,
      switchOn: true,
      ssh,
      shellOnly: options.shellOnly === true,
      machine: d.machines.findByTarget(ssh),
      bundledSha256: d.bundledSha256,
    })
  } catch (err) {
    return usual(`the session helper's records could not be read (${(err as Error).message})`)
  }
  if (route.via === 'today') return usual(route.why)
  const m = route.machine
  // The launch is the tab's provider's, asked through the registry by its id.
  const providerId = options.provider ?? DEFAULT_PROVIDER_ID
  const provider = tryGetProvider(providerId)
  if (!provider?.remoteLaunch) return usual(`its provider (${provider?.displayName ?? providerId}) has no launch through the session helper`)
  let pty: RemoteHelperPty
  try {
    // The app's tools go to the tab only while it serves them (asked once, at the start).
    let tools = false
    try { tools = d.signals?.toolsServed() === true } catch { tools = false }
    const plan = remoteLaunchOf(provider.remoteLaunch, m, { ...options, provider: providerId }, settings, d.systemPrefersDark, remoteSessionId(sessionId), cols, rows, tools)
    pty = new RemoteHelperPty({
      appPtyId: sessionId,
      machine: m,
      installId: d.machines.installId(),
      runner: d.runner,
      spec: plan.spec,
      plan,
      ...(d.signals ? { signals: d.signals } : {}),
      log: d.log,
    })
  } catch (err) {
    return usual((err as Error).message)
  }
  d.log(`[remote-helper] ${sessionId}: through the session helper on ${m.user}@${m.host}:${m.port} (${m.did.slice(0, 8)}), session ${pty.sid}`)
  openTabs.set(sessionId, pty)
  startedThroughHelper.set(sessionId, pty)
  // The tab's SSH flow overlay hides now, also over a card the usual path
  // left on it (a Restart after the switch went on); its catch-up poll reads
  // the same from isRemoteHelperTab.
  if (!win.isDestroyed()) win.webContents.send(`${IPC.SSH_FLOW_STATE}:${sessionId}`, { state: SSH_THROUGH_HELPER })
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
    over = true
    if (openTabs.get(sessionId) === pty) openTabs.delete(sessionId)
  })
  // A Restart or a close: its late output never reaches the tab's next terminal.
  const kill = pty.kill.bind(pty)
  pty.kill = (signal?: string) => {
    over = true
    if (openTabs.get(sessionId) === pty) openTabs.delete(sessionId)
    if (startedThroughHelper.get(sessionId) === pty) startedThroughHelper.delete(sessionId)
    kill(signal)
  }
  return pty
}
