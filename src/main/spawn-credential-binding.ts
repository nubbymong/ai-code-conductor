/**
 * Which secrets a spawn may receive is decided by the saved config ON DISK,
 * never by the request alone.
 *
 * The renderer describes a spawn (an SSH block, a terminal command line) and
 * names the config it belongs to; main then resolves that config's secrets
 * from the OS keychain and injects them. Those two halves must agree: the
 * secrets stored for config X are only ever offered to X's own host and X's own
 * command line, as the user saved them. A request whose SSH block or command
 * line differs from the saved config is refused (SSH) or runs without the
 * secret (terminal) -- fail closed, and say so in the log.
 *
 * Pure and dependency-free so it can be tested exhaustively; the pty:spawn
 * handler is the only caller.
 */

import type { SshRuntime } from '../shared/types'

export interface SavedSshLike {
  host: string
  port: number
  username: string
  remotePath: string
  postCommand?: string
  dockerContainer?: string
  detachable?: boolean
  remoteOs?: 'auto' | 'unix' | 'windows'
  runtime?: SshRuntime
}

export interface SavedConfigLike {
  id: string
  sessionType?: 'local' | 'ssh'
  shellOnly?: boolean
  terminalOptions?: { command?: string; args?: string; hasSecretArg?: boolean; elevated?: boolean }
  sshConfig?: SavedSshLike
}

export interface RequestedSsh {
  host: string
  port: number
  username: string
  remotePath: string
  postCommand?: string
  /** Runtime-only flags the renderer owns; they carry no secret and pass through. */
  reconnect?: boolean
  detachable?: boolean
  remoteOs?: 'auto' | 'unix' | 'windows'
  /** Structured container runtime — NEVER taken from the request: the binding
   *  injects the SAVED config's runtime, the same trust rule as postCommand. */
  runtime?: SshRuntime
}

export type SshBinding =
  | { ok: true; ssh: RequestedSsh }
  | { ok: false; reason: string }

/** The saved config with this id, or null when the file is missing/malformed or the id is unknown. */
export function findSavedConfig(configs: unknown, configId: string | undefined): SavedConfigLike | null {
  if (!configId || !Array.isArray(configs)) return null
  for (const c of configs) {
    if (c && typeof c === 'object' && (c as { id?: unknown }).id === configId) return c as SavedConfigLike
  }
  return null
}

const same = (a: string | undefined, b: string | undefined) => (a ?? '') === (b ?? '')

/** How the bound block is used. */
export interface SshBindingMode {
  /** #86: the partner shell of an SSH session -- a PLAIN connection to the
   *  config's own host: the same host, port, user and remote path are required,
   *  but it runs no post-connect command and no container runtime, and never
   *  persists (tmux off). Only ever takes things away from the saved block. */
  plainShell?: boolean
}

/**
 * The SSH block a spawn may run with. When the request names a config, the
 * block must be that config's own (host, port, username, remotePath,
 * postCommand); the result is built from the SAVED block so nothing the
 * renderer added rides along, with the renderer's runtime-only `reconnect`
 * kept. A request that names a config it does not match, a config that is not
 * SSH, or an id that does not exist is refused.
 *
 * A plain shell (`mode.plainShell`, the partner of an SSH session) is bound to
 * the same saved host, port, user and remote path, and asks for no post-connect
 * command (one that asks for any is refused): its block carries none, no
 * runtime, no reconnect, and persistence off, whatever the saved config says.
 */
export function bindSshToSavedConfig(requested: RequestedSsh, configId: string | undefined, configs: unknown, mode: SshBindingMode = {}): SshBinding {
  const saved = findSavedConfig(configs, configId)
  if (!saved) return { ok: false, reason: `no saved config with id ${configId ?? '(none)'}` }
  if (saved.sessionType !== 'ssh' || !saved.sshConfig) return { ok: false, reason: `config ${saved.id} is not an SSH config` }
  const s = saved.sshConfig
  if (!same(requested.host, s.host)) return { ok: false, reason: `host differs from the saved config` }
  if (Number(requested.port) !== Number(s.port)) return { ok: false, reason: `port differs from the saved config` }
  if (!same(requested.username, s.username)) return { ok: false, reason: `username differs from the saved config` }
  if (!same(requested.remotePath, s.remotePath)) return { ok: false, reason: `remote path differs from the saved config` }
  if (mode.plainShell === true) {
    if ((requested.postCommand ?? '') !== '') return { ok: false, reason: `a plain shell runs no post-connect command` }
    return {
      ok: true,
      ssh: {
        host: s.host,
        port: Number(s.port),
        username: s.username,
        remotePath: s.remotePath,
        detachable: false,
        ...(s.remoteOs !== undefined ? { remoteOs: s.remoteOs } : {}),
      },
    }
  }
  if (!same(requested.postCommand, s.postCommand)) return { ok: false, reason: `post-connect command differs from the saved config` }
  return {
    ok: true,
    ssh: {
      host: s.host,
      port: Number(s.port),
      username: s.username,
      remotePath: s.remotePath,
      ...(s.postCommand ? { postCommand: s.postCommand } : {}),
      ...(s.runtime ? { runtime: s.runtime } : {}),
      ...(s.detachable !== undefined ? { detachable: s.detachable } : {}),
      ...(s.remoteOs !== undefined ? { remoteOs: s.remoteOs } : {}),
      ...(requested.reconnect !== undefined ? { reconnect: requested.reconnect } : {}),
    },
  }
}

/**
 * Whether a terminal-only spawn is entitled to the config's secret argument:
 * the saved config must be terminal-only with a secret argument on record, and
 * the requested command line must be the saved one. Otherwise the shell runs
 * without the secret.
 */
export function argSecretAllowed(
  requested: { command?: string; args?: string } | undefined,
  configId: string | undefined,
  configs: unknown,
): boolean {
  const saved = findSavedConfig(configs, configId)
  if (!saved || !saved.shellOnly || !saved.terminalOptions?.hasSecretArg) return false
  return same(requested?.command, saved.terminalOptions.command) && same(requested?.args, saved.terminalOptions.args)
}
