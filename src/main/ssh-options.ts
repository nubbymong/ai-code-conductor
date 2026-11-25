/**
 * The SSH block of a session's spawn. It lived in pty-manager.ts, which
 * re-exports it; it has a module of its own (2.1.3-beta.17, plan section A2)
 * so the remote helper's code (src/main/remote-helper/), which imports nothing
 * of Electron, can read it without importing the PTY manager.
 */
import type { SshRuntime } from '../shared/types'

export interface SSHOptions {
  host: string
  port: number
  username: string
  remotePath: string
  password?: string
  postCommand?: string
  /** Structured container runtime (item e) — injected from the SAVED config by
   *  spawn-credential-binding, composed into the effective post-command below. */
  runtime?: SshRuntime
  sudoPassword?: string
  /**
   * #242 tier 5: true when this spawn respawns a session that had
   * previously reached `claude-running` over THIS SSH config — set by the
   * renderer session store (never persisted to disk; see Session.
   * sshReachedClaudeRunning in sessionStore.ts) when it re-spawns, e.g. via
   * the Restart control after a dropped connection. Consumed by
   * writeClaudeCmd via buildSshClaudeFlags (ssh-tmux.ts) to decide whether
   * the bare (non-tmux) launch should carry `--continue`. Undefined/false
   * on a session's first-ever spawn, where there is no prior conversation
   * to continue.
   */
  reconnect?: boolean
  /**
   * SSH tmux enhancement (item 1): "Detachable" (persistent remote session)
   * toggle, from SshConfig.detachable. DEFAULT ON — only an explicit `false`
   * disables the #242 tmux-persistence ladder (no detection, no staging, no
   * silent install), leaving a bare `claude` that resumes via `--continue`
   * on reconnect. Owner requirement: tmux must never be installed silently,
   * so persistence is user-controlled by this flag.
   */
  detachable?: boolean
  /**
   * SSH tmux enhancement (item 3): remote OS. 'windows' selects the Windows
   * setup path (PowerShell delivery + CONOUT$ shim + cmd.exe launch, no tmux);
   * 'auto'/'unix'/undefined keep the POSIX path unchanged. PROTOTYPE.
   */
  remoteOs?: 'auto' | 'unix' | 'windows'
}
