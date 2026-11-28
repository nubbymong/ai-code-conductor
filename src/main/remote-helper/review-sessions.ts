/**
 * Which remote tabs may ask for a review on their machine (2.1.3-beta.21,
 * nubbymong/aicc_planning#446), by app session id: the machine and the tab's
 * working folder there. A Claude Code tab through the session helper
 * registers at its start (./index.ts remoteHelperPty), once per start, and
 * its registration goes with the session's (conductor-mcp-server.ts
 * unregister at every spawn's teardown and at its exit).
 * Registering does not offer the tool: the tool host decides per connection
 * (conductor-mcp-server.ts, from the machine's record).
 *
 * SECURITY: a folder that is the host's home folder or a folder above it is
 * never registered, as lifecycle.ts refuses the home folder on this computer:
 * mode `paths` could otherwise read the host account's own files into a
 * review. The host read refuses it again there (scripts.ts `reviewread`).
 *
 * This file imports nothing of Electron, and nothing of the app's own.
 */
import * as path from 'path'

/** Where a remote tab's review runs: its machine and its folder there. */
export interface RemoteReviewTarget {
  /** The machine's device id (its record is read again when a review runs). */
  did: string
  /** The tab's working folder on the host: an absolute path there. */
  cwd: string
}

const targets = new Map<string, RemoteReviewTarget>()

/** True when `cwd` (a path on the host) is the host's home folder `home`, a
 *  folder above it, or the root. */
export function hostFolderIsHomeOrAbove(cwd: string, home: string): boolean {
  const norm = (p: string) => path.posix.normalize(p).replace(/\/+$/, '') || '/'
  const c = norm(cwd)
  const h = norm(home)
  return c === '/' || c === h || h.startsWith(`${c}/`)
}

/** Register a remote tab for a review on its machine. Refused (false) for a
 *  folder that is not absolute on the host, or is its home folder or above. */
export function registerRemoteReviewSession(sessionId: string, target: RemoteReviewTarget, home: string): boolean {
  targets.delete(sessionId)
  if (!target.cwd.startsWith('/') || hostFolderIsHomeOrAbove(target.cwd, home)) return false
  targets.set(sessionId, { did: target.did, cwd: target.cwd })
  return true
}

/** The tab's registration, or null for a session that is not a registered remote tab. */
export function remoteReviewTarget(sessionId: string): RemoteReviewTarget | null {
  return targets.get(sessionId) ?? null
}

/** The registration goes (the session's teardown, or its next start). */
export function forgetRemoteReviewSession(sessionId: string): void {
  targets.delete(sessionId)
}
