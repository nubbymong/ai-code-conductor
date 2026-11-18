// The ssh every SSH start runs (a session, its End exec, the liveness probe),
// moved here from pty-manager.ts (planning #310, item 5).
import * as os from 'os'

import { findOnWindowsPath } from './windows-programs'

/** What an SSH start says on Windows when no ssh.exe is in a folder PATH
 *  names in full. */
export const SSH_NOT_ON_PATH = 'ssh was not found in a folder PATH names (ssh.exe). Add the folder that holds ssh.exe to your PATH as a full path, then restart the app.'

/** The ssh every SSH start runs (a session, its End exec, the liveness
 *  probe), asked for at the start itself. On Windows: the full path of the
 *  first ssh.exe in the folders PATH names in full (findOnWindowsPath, the
 *  rule the app's other programs follow there), never a bare name; with none
 *  there it THROWS SSH_NOT_ON_PATH and nothing starts. Elsewhere `ssh` by
 *  name from PATH, as before. The walk reads PATH's folders in order on this
 *  thread, as the system's own search for a bare name did at the start. */
export function sshProgram(platform: NodeJS.Platform = os.platform(), env: NodeJS.ProcessEnv = process.env): string {
  if (platform !== 'win32') return 'ssh'
  const found = findOnWindowsPath(['ssh.exe'], env)
  if (!found) throw new Error(SSH_NOT_ON_PATH)
  return found
}
