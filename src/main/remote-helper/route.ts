/**
 * Which SSH tabs go through the session helper on their machine (2.1.3-beta.17,
 * plan section A2, with plan-review finding 5). Every other tab takes the usual
 * SSH path unchanged, and the log says why in one line.
 *
 * Through the helper: the switch is on (Windows), the tab is a Claude Code
 * tab (not a plain terminal), its saved config's Connection is SSH (an
 * explicit `detachable: false`: a config with no `detachable` value is SSH
 * Persistent, shared/types.ts SshConfig.detachable), it signs in by key, has
 * no post-connect command, no container and no Windows host, and its host,
 * port and user are a machine added on the Machines page, checked, and
 * holding this build's helper. The SSH branch refuses a provider it does not
 * run before this is asked, so the tab is Claude Code or a plain terminal here.
 *
 * This file imports nothing of Electron.
 */
import { isContainerRuntime, parseDockerPostCommand } from '../../shared/container-command'
import type { SSHOptions } from '../ssh-options'
import type { RemoteMachineRecord } from './machines'

export type Route =
  | { via: 'helper'; machine: RemoteMachineRecord }
  | { via: 'today'; why: string }

export interface RouteInput {
  platform: NodeJS.Platform
  switchOn: boolean
  ssh: SSHOptions
  shellOnly: boolean
  /** The machine added for this tab's host, port and user, if any. */
  machine: RemoteMachineRecord | undefined
  /** The SHA-256 of this build's Linux helper for an architecture, from its
   *  manifest; null when it has none for it. Asked with the machine's own
   *  architecture (2.1.3-beta.19: x86_64 and aarch64 each have their own). */
  bundledSha256: (arch: string) => string | null
}

/** Why each tab takes the usual path, as the log line says it. */
export const ROUTE_WHY = {
  off: 'the remote sessions switch is off',
  platform: 'remote sessions through the session helper run from Windows only in this preview',
  shellOnly: 'it is a plain terminal (a Terminal only tab or a partner terminal), not a Claude Code tab',
  persistent: 'its saved config\'s Connection is SSH Persistent (a config that never chose one is SSH Persistent); only Connection set to SSH runs through the session helper in this preview',
  container: 'it runs Claude Code in a container',
  postCommand: 'it runs a post-connect command',
  password: 'it signs in with a password; the session helper uses key sign-in only in this preview',
  windowsHost: 'its remote OS is Windows; the session helper runs on Linux machines only in this preview',
  notAdded: 'its machine is not added on the Machines page',
  notChecked: 'its machine did not pass its last check on the Machines page; press Check there',
  noHelper: 'this build of the app carries no Linux session helper for its machine\'s architecture',
  oldHelper: 'its machine has another version of the session helper; press Check on the Machines page to update it',
} as const

export function routeSshTab(i: RouteInput): Route {
  const today = (why: string): Route => ({ via: 'today', why })
  if (!i.switchOn) return today(ROUTE_WHY.off)
  if (i.platform !== 'win32') return today(ROUTE_WHY.platform)
  if (i.shellOnly) return today(ROUTE_WHY.shellOnly)
  const ssh = i.ssh
  if (ssh.detachable !== false) return today(ROUTE_WHY.persistent)
  if (isContainerRuntime(ssh.runtime ?? parseDockerPostCommand(ssh.postCommand ?? '') ?? undefined)) return today(ROUTE_WHY.container)
  if (ssh.postCommand && ssh.postCommand.trim()) return today(ROUTE_WHY.postCommand)
  if (ssh.password) return today(ROUTE_WHY.password)
  if (ssh.remoteOs === 'windows') return today(ROUTE_WHY.windowsHost)
  if (!i.machine) return today(ROUTE_WHY.notAdded)
  if (!i.machine.check.ok) return today(ROUTE_WHY.notChecked)
  const bundled = i.bundledSha256(i.machine.arch)
  if (!bundled) return today(ROUTE_WHY.noHelper)
  if (i.machine.helper.sha256 !== bundled) return today(ROUTE_WHY.oldHelper)
  return { via: 'helper', machine: i.machine }
}
