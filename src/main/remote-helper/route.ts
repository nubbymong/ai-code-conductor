/**
 * Which SSH tabs go through the session helper on their machine (2.1.3-beta.17,
 * plan section A2, with plan-review finding 5). Every other tab takes the usual
 * SSH path unchanged, and the log says why in one line.
 *
 * Through the helper: the switch is on (Windows), the tab is a Claude Code
 * tab (not a plain terminal), it signs in by key, has no post-connect
 * command, no container and no Windows host, and its host, port and user are
 * a machine added on the Machines page, checked, and holding this build's
 * helper. The SSH branch refuses a provider it does not run before this is
 * asked, so the tab is Claude Code or a plain terminal here.
 *
 * Its saved config's Connection decides the holder's kind (2.1.3-beta.19
 * section 1.2; ADR-030 S25's second kind, D13). SSH (an explicit `detachable:
 * false`) keeps beta.18's away clock. SSH Persistent (a config with no
 * `detachable` value is SSH Persistent, shared/types.ts SshConfig.detachable)
 * is kept until it is ended, and goes through the helper only when the
 * machine's last Check read that logind does not end the user's processes at
 * logout (machines.ts logoutCleanUp), and the tab is not under tmux: its own
 * session last started on the usual path (a Restart of such a tab, or a
 * restored tab saved with no mark), or its config has a session there (a
 * registry tmux entry, or an open tab on the usual path), so one config never
 * has sessions on both paths. A tab keeps the path it started on.
 *
 * A tab marked as kept by the helper (its saved record's remoteVia, or its
 * last start this run) never takes the usual path: where the helper cannot be
 * used for it now, nothing starts, and the tab says the step that mends it.
 *
 * This file imports nothing of Electron.
 */
import { isContainerRuntime, parseDockerPostCommand } from '../../shared/container-command'
import type { SSHOptions } from '../ssh-options'
import { logoutCleanUp, type RemoteMachineRecord } from './machines'
import type { HolderKind } from './scripts'

export type Route =
  | { via: 'helper'; machine: RemoteMachineRecord; kind: HolderKind }
  | { via: 'today'; why: string }
  /** A marked tab the helper cannot take now: nothing starts, and the tab says `step`. */
  | { via: 'nothing'; why: string; step: string }

/** An SSH Persistent tab's standing (2.1.3-beta.19 section 1.2). */
export interface PersistentStanding {
  /** Kept by the helper: the saved record's remoteVia, or its last start this run. */
  marked: boolean
  /** Its own session last started on the usual path: a Restart of such a
   *  tab, or a tab restored with no mark (saved before beta.19, or never
   *  through the helper). */
  sessionUnderTmux: boolean
  /** Its config has a registry tmux entry, or an open tab on the usual path. */
  configUnderTmux: boolean
}

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
  /** An SSH Persistent tab's standing; absent reads as a new, unmarked tab
   *  whose config has nothing under tmux. */
  standing?: PersistentStanding
}

/** Why each tab takes the usual path, as the log line says it. */
export const ROUTE_WHY = {
  off: 'the remote sessions switch is off',
  platform: 'remote sessions through the session helper run from Windows only in this preview',
  shellOnly: 'it is a plain terminal (a Terminal only tab or a partner terminal), not a Claude Code tab',
  sessionUnderTmux: 'this tab\'s session runs under tmux; End it to move this config to the helper',
  configUnderTmux: 'its config has a session under tmux (left running, or open in another tab); End it to move this config to the helper',
  cleanUpOn: 'its machine\'s logind ends your processes when you log out (KillUserProcesses), so an SSH Persistent session could not outlive its connection there',
  cleanUpUnknown: 'its machine\'s last check did not read whether logind ends your processes when you log out; press Check on the Machines page',
  cleanUpUnread: 'its machine\'s last check got no answer from logind (no loginctl there, or no logind), so an SSH Persistent session keeps the usual SSH path',
  container: 'it runs Claude Code in a container',
  postCommand: 'it runs a post-connect command',
  password: 'it signs in with a password; the session helper uses key sign-in only in this preview',
  windowsHost: 'its remote OS is Windows; the session helper runs on Linux machines only in this preview',
  notAdded: 'its machine is not added on the Machines page',
  notChecked: 'its machine did not pass its last check on the Machines page; press Check there',
  noHelper: 'this build of the app carries no Linux session helper for its machine\'s architecture',
  oldHelper: 'its machine has a different session helper file from the one this build carries; press Check on the Machines page to install it',
} as const

/** The step a marked tab's note names, by why the helper cannot take it. */
export const MARKED_STEP = {
  switchOff: 'turn the switch on, or End it on the Machines page',
  check: 'press Check on the Machines page, then Restart',
  end: 'End it on the Machines page',
} as const

export function routeSshTab(i: RouteInput): Route {
  const ssh = i.ssh
  const persistent = ssh.detachable !== false
  const marked = persistent && i.standing?.marked === true
  // A marked tab never takes the usual path: it would start a second CLI
  // under tmux beside the one its holder keeps.
  const today = (why: string, step: string = MARKED_STEP.end): Route => (marked ? { via: 'nothing', why, step } : { via: 'today', why })
  if (!i.switchOn) return today(ROUTE_WHY.off, MARKED_STEP.switchOff)
  if (i.platform !== 'win32') return today(ROUTE_WHY.platform)
  if (i.shellOnly) return today(ROUTE_WHY.shellOnly)
  if (persistent && !marked) {
    if (i.standing?.sessionUnderTmux) return today(ROUTE_WHY.sessionUnderTmux)
    if (i.standing?.configUnderTmux) return today(ROUTE_WHY.configUnderTmux)
  }
  if (isContainerRuntime(ssh.runtime ?? parseDockerPostCommand(ssh.postCommand ?? '') ?? undefined)) return today(ROUTE_WHY.container)
  if (ssh.postCommand && ssh.postCommand.trim()) return today(ROUTE_WHY.postCommand)
  if (ssh.password) return today(ROUTE_WHY.password)
  if (ssh.remoteOs === 'windows') return today(ROUTE_WHY.windowsHost)
  if (!i.machine) return today(ROUTE_WHY.notAdded)
  if (!i.machine.check.ok) return today(ROUTE_WHY.notChecked, MARKED_STEP.check)
  const bundled = i.bundledSha256(i.machine.arch)
  if (!bundled) return today(ROUTE_WHY.noHelper, MARKED_STEP.check)
  if (i.machine.helper.sha256 !== bundled) return today(ROUTE_WHY.oldHelper, MARKED_STEP.check)
  // A new SSH Persistent session needs a machine that keeps it past a logout;
  // a marked one is held there already, and its holder answers for itself.
  if (persistent && !marked) {
    const cleanUp = logoutCleanUp(i.machine)
    if (cleanUp === 'on') return today(ROUTE_WHY.cleanUpOn)
    if (cleanUp === 'unknown') return today(ROUTE_WHY.cleanUpUnknown)
    if (cleanUp === 'unread') return today(ROUTE_WHY.cleanUpUnread)
  }
  return { via: 'helper', machine: i.machine, kind: persistent ? 'until-ended' : 'away' }
}
