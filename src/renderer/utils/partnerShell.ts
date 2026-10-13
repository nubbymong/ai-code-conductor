// #86: where a session's partner terminal runs, and what it is started with.
//
// A local session's partner is a plain shell on this PC, in the session's
// working directory. An SSH session's partner is a plain shell on the
// session's own host: the session's ssh block as partnerSshOf makes it (no
// post-connect command, no container runtime, persistence off), so it is its
// own plain connection and never a window in the session's tmux. Main takes it
// to the config's remote folder once it reaches its shell
// (main/ssh-partner-folder.ts); no folder is sent from here. Main recognises
// exactly this block as the session's partner (launch-one-at-a-time.ts), so it
// is never counted as a second copy of the config.
import type { Session, SSHConfig } from '../stores/sessionStore'
import { partnerSshOf, type PartnerSsh } from '../../shared/multi-spawn-rule'
import { stripSpoofableText } from '../../shared/safe-text'

export interface PartnerShell {
  /** The folder a local partner opens in; undefined over SSH (a remote path
   *  this PC cannot resolve) and for a session with no folder. */
  cwd: string | undefined
  /** The ssh block an SSH session's partner connects with; undefined for a
   *  partner on this PC. */
  ssh: PartnerSsh<SSHConfig> | undefined
  /** Where the shell runs, as the strip says it: "this PC" or "user@host". */
  where: string
}

export function partnerShellOf(session: Pick<Session, 'sessionType' | 'workingDirectory' | 'sshConfig'>): PartnerShell {
  const ssh = session.sessionType === 'ssh' ? session.sshConfig : undefined
  if (ssh) {
    // The user's own text for the machine, made safe to show (no controls, no
    // bidi tricks), as every other place the app names a host.
    return { cwd: undefined, ssh: partnerSshOf(ssh), where: stripSpoofableText(`${ssh.username}@${ssh.host}`, 200) }
  }
  // An SSH tab whose ssh block is missing gets what it always got: a shell on
  // this PC, at home; and the strip says so.
  return { cwd: session.sessionType === 'local' ? session.workingDirectory : undefined, ssh: undefined, where: 'this PC' }
}
