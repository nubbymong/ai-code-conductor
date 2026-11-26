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
 * This file imports nothing of Electron: the window is given as the little it
 * needs.
 */
import type { IPty } from 'node-pty'
import { IPC } from '../../shared/ipc-channels'
import { SSH_THROUGH_HELPER, type RemoteActionResult, type RemoteMachineSessions } from '../../shared/remote-machines'
import type { DetachedRemote, DetachedRemoteLiveness } from '../../shared/types'
import { DEFAULT_PROVIDER_ID, type ProviderId } from '../../shared/providers/ids'
import { tryGetProvider } from '../providers'
import { colorFgBgValue, resolveHostColorScheme } from '../providers/host-color-scheme'
import type { ProviderRemoteLaunch, RemoteHostFile, RemoteLaunchOptions } from '../providers/types'
import type { SSHOptions } from '../ssh-options'
import { ROUTE_WHY, routeSshTab, type PersistentStanding, type Route } from './route'
import { NoticePty, RemoteDriver, RemoteHelperPty, remoteCwd, remoteHelperCommands, remoteLaunchSpec, remoteSessionId, type RemoteLaunchPlan } from './session'
import { listKept, machineSessions } from './kept'
import type { HolderKind } from './scripts'
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
  /** The SHA-256 the installer's manifest gives the Linux helper; null: none. */
  bundledSha256: () => string | null
  /** The system's dark preference (Electron's nativeTheme), for the theme 'system'. */
  systemPrefersDark: () => boolean
  /** What the tab was sent, for the PTY integrity count: the session id and the text's length. */
  onOutput: (sessionId: string, length: number) => void
  log: (message: string) => void
  /** Where a tab's status line, hook events and tool streams go (2.1.3-beta.18
   *  section 3.2). Absent: a tab through the helper gets none of them. */
  signals?: RemoteSignalDeps
  /** The left-running registry as saved (session-state.ts
   *  readDetachedRemotesRegistry), read at an SSH Persistent tab's start for
   *  its config's tmux entries (2.1.3-beta.19). Absent: none. */
  registry?: () => readonly DetachedRemote[]
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
}

/** The tabs a restore brought back (pty:tabsRestored, 2.1.3-beta.19): an SSH
 *  Persistent one that starts with no mark takes the usual path. */
export function noteRestoredRemoteTabs(ids: readonly string[]): void {
  for (const id of ids) restoredTabs.add(id)
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
  model?: string
  effortLevel?: string
  permissionMode?: string
  extraArgs?: string
  disableAutoMemory?: boolean
  /** The saved config the tab was started from (2.1.3-beta.19: its tmux state). */
  configId?: string
  /** The tab's saved mark (2.1.3-beta.19): its session is kept by the helper. */
  remoteVia?: 'helper'
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
export function remoteLaunchOf(via: ProviderRemoteLaunch, m: RemoteMachineRecord, options: RemoteSpawnOptions, settings: Readonly<Record<string, unknown>> | null, systemPrefersDark: () => boolean, sid: string, cols: number, rows: number, tools = false, resumes = false): RemoteLaunchPlan {
  const remotePath = options.ssh?.remotePath
  const launchOptions: RemoteLaunchOptions = {
    model: options.model,
    effortLevel: options.effortLevel,
    permissionMode: options.permissionMode,
    extraArgs: options.extraArgs,
    disableAutoMemory: options.disableAutoMemory,
    // `resumes`: a marked tab whose kept session is gone launches again on
    // its conversation (2.1.3-beta.19), as a reconnect does.
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
  const persistent = ssh.detachable !== false
  // A tab's mark (2.1.3-beta.19): its saved record's, or its last start's this run.
  const marked = persistent && (options.remoteVia === 'helper' || lastPath.get(sessionId) === 'kept')
  const startsNothing = (r: Extract<Route, { via: 'nothing' }>): IPty => {
    d.log(`[remote-helper] ${sessionId}: nothing started, because its session is kept by the session helper and ${r.why}`)
    const note = new NoticePty(`This tab's session is kept by the session helper on its machine, and it cannot be opened now: ${r.why}. To open it, ${r.step}.`, cols, rows)
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
    const r = routeSshTab({ platform: d.platform, switchOn: false, ssh, shellOnly: options.shellOnly === true, machine: undefined, bundledSha256: null, standing: { marked, sessionUnderTmux: false, configUnderTmux: false } })
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
      bundledSha256: d.bundledSha256(),
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
  let pty: RemoteHelperPty
  try {
    // The app's tools go to the tab only while it serves them (asked once, at the start).
    let tools = false
    try { tools = d.signals?.toolsServed() === true } catch { tools = false }
    const plan = remoteLaunchOf(provider.remoteLaunch, m, { ...options, provider: providerId }, settings, d.systemPrefersDark, remoteSessionId(sessionId), cols, rows, tools, marked)
    pty = new RemoteHelperPty({
      appPtyId: sessionId,
      machine: m,
      installId: d.machines.installId(),
      runner: d.runner,
      spec: plan.spec,
      plan,
      kind,
      ...(d.signals ? { signals: d.signals } : {}),
      log: d.log,
    })
  } catch (err) {
    const why = (err as Error).message
    return marked ? startsNothing({ via: 'nothing', why, step: 'press Check on the Machines page, then Restart' }) : usualPath(why)
  }
  d.log(`[remote-helper] ${sessionId}: through the session helper on ${m.user}@${m.host}:${m.port} (${m.did.slice(0, 8)}), session ${pty.sid}${kind === 'until-ended' ? ', kept until it is ended' : ''}`)
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
    win.webContents.send(`pty:data:${sessionId}`, data)
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
  if (!m) return { ok: false, message: 'That machine is not on this computer\'s list.' }
  for (const p of openTabs.values()) if (p.sid === sid) return { ok: false, message: 'A tab shows that session. Close it there and choose End.' }
  const listed = await listKept({ runner: d.runner, installId: d.machines.installId(), log: d.log }, m)
  if (!listed.ok) return { ok: false, message: `Nothing was ended: ${listed.why}.` }
  const rec = listed.sessions.find((s) => s.record.session === sid)
  if (!rec) return { ok: true, message: 'That session had ended already.' }
  const driver = RemoteDriver.forEnd({ appPtyId: rec.record.label, machine: m, installId: d.machines.installId(), runner: d.runner, log: d.log, ...(d.signals ? { signals: d.signals } : {}) })
  const r = await driver.endKept(rec.record)
  d.log(`[remote-helper] ${sid}: ${r.ok ? 'ended' : `not ended (${r.why})`} on ${m.host} from the Machines page`)
  return r.ok ? { ok: true, message: `Ended the session on ${m.host}.` } : { ok: false, message: `The session on ${m.host} was not ended: ${r.why}.` }
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
  const held = new Set(listed.sessions.map((s) => s.record.session))
  return { outcome: 'verified', liveSessionIds: sessionIds.filter((id) => held.has(remoteSessionId(id))) }
}
