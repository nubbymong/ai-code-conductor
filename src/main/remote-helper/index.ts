/**
 * Remote step 1's door from the PTY manager (2.1.3-beta.17, plan section A2).
 *
 * pty-manager.ts asks remoteHelperPty once per SSH spawn, at the top of its
 * SSH branch, after the branch refuses a provider SSH does not run. It answers a terminal through
 * the session helper on the tab's machine when routeSshTab says so, and null
 * otherwise; null leaves the SSH branch exactly as it was (the usual SSH
 * path), and either way one log line says which and why. Until main plugs in
 * the deps (setRemoteHelperDeps, from ipc/machines-handlers.ts at start-up)
 * every tab takes the usual path.
 *
 * This file imports nothing of Electron: the window is given as the little it
 * needs.
 */
import type { IPty } from 'node-pty'
import type { SSHOptions } from '../ssh-options'
import { routeSshTab } from './route'
import { RemoteHelperPty, heldBackImage, remoteLaunchSpec } from './session'
import type { RemoteMachines } from './machines'
import type { SshRunner } from './ssh-exec'

export interface RemoteHelperDeps {
  platform: NodeJS.Platform
  /** The saved settings, read at each spawn; null when they do not read. */
  settings: () => Record<string, unknown> | null
  machines: RemoteMachines
  runner: SshRunner
  /** The SHA-256 the installer's manifest gives the Linux helper; null: none. */
  bundledSha256: () => string | null
  log: (message: string) => void
}

let deps: RemoteHelperDeps | null = null

export function setRemoteHelperDeps(d: RemoteHelperDeps | null): void {
  deps = d
}

/** The open tabs through the helper, by app session id. */
const openTabs = new Map<string, RemoteHelperPty>()

/** How many open tabs go through the helper on machine `did` (Remove waits for none). */
export function remoteTabsOn(did: string): number {
  let n = 0
  for (const p of openTabs.values()) if (p.machineDid === did) n++
  return n
}

/** True while this app session's tab runs through the helper (the SSH flow
 *  overlay is not shown for it). */
export function isRemoteHelperTab(sessionId: string): boolean {
  return openTabs.has(sessionId)
}

/**
 * The renderer's write for a tab through the helper, read whole before the
 * PTY manager cuts a long one into 256-byte slices (writePty): the app's own
 * image request (the host image fetch tool, which such a tab does not have in
 * this preview) is held back entire, and the tab says so. A slice could
 * otherwise split the tool's name and let the rest of the line, its Enter
 * included, reach the CLI. True when it was held back.
 */
export function holdBackRemoteImage(sessionId: string, data: string): boolean {
  const pty = openTabs.get(sessionId)
  if (!pty || typeof data !== 'string' || !heldBackImage(data)) return false
  pty.holdBackImage()
  return true
}

/** The spawn options this reads: pty-manager's own, structurally. */
export interface RemoteSpawnOptions {
  ssh?: SSHOptions
  shellOnly?: boolean
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

/** The CLI's arguments: the config's model, effort, permission mode and extra
 *  arguments, as the usual SSH launch line gives them, and --continue on a
 *  reconnect. Values are arguments (no shell parses them on the way). */
export function remoteCliArgs(o: RemoteSpawnOptions): string[] {
  const args: string[] = []
  if (o.effortLevel) args.push('--effort', o.effortLevel)
  if (o.model) args.push('--model', o.model)
  if (o.permissionMode && o.permissionMode !== 'default') args.push('--permission-mode', o.permissionMode)
  if (o.ssh?.reconnect) args.push('--continue')
  const extra = o.extraArgs?.trim()
  if (extra) args.push(...extra.split(/\s+/))
  return args
}

/** The CLI's own switches the settings set, as the usual SSH launch sets them. */
export function remoteCliEnv(settings: Record<string, unknown> | null, o: RemoteSpawnOptions): Record<string, string> {
  const env: Record<string, string> = {}
  if (o.disableAutoMemory) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  if (settings?.classicTerminalCopyPaste !== false) {
    env.CLAUDE_CODE_DISABLE_MOUSE = '1'
    env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1'
  }
  if (settings?.clickableQuestions !== true) env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS = '1'
  if (settings?.disableBackgroundTasks !== false) env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
  return env
}

/**
 * The SSH branch's one question: this tab through the session helper, or the
 * usual path (null)? One log line either way.
 */
export function remoteHelperPty(win: OutputWindow, sessionId: string, options: RemoteSpawnOptions, cols: number, rows: number): IPty | null {
  const d = deps
  const ssh = options.ssh
  if (!d || !ssh) return null
  const settings = d.settings()
  const route = routeSshTab({
    platform: d.platform,
    switchOn: settings?.remoteSessionsThroughHelper === true,
    ssh,
    shellOnly: options.shellOnly === true,
    machine: d.machines.findByTarget(ssh),
    bundledSha256: d.bundledSha256(),
  })
  if (route.via === 'today') {
    d.log(`[remote-helper] ${sessionId}: the usual SSH path, because ${route.why}`)
    return null
  }
  const m = route.machine
  let pty: RemoteHelperPty
  try {
    pty = new RemoteHelperPty({
      appPtyId: sessionId,
      machine: m,
      installId: d.machines.installId(),
      runner: d.runner,
      spec: remoteLaunchSpec(m, remoteCliArgs(options), remoteCliEnv(settings, options), ssh.remotePath, cols, rows),
      log: d.log,
    })
  } catch (err) {
    d.log(`[remote-helper] ${sessionId}: the usual SSH path, because ${(err as Error).message}`)
    return null
  }
  d.log(`[remote-helper] ${sessionId}: through the session helper on ${m.user}@${m.host}:${m.port} (${m.did.slice(0, 8)}), session ${pty.sid}`)
  openTabs.set(sessionId, pty)
  let over = false
  pty.onData((data) => {
    if (over || win.isDestroyed()) return
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
    kill(signal)
  }
  return pty
}
