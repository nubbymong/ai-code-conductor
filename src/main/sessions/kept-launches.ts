// An app update keeps a held agent session's CLI running (S16 step 4,
// aicc_planning#387 with #359; Windows, with the agent sessions' switch on).
// This is the seam between the session helper (session-helper/manager.ts),
// which decides which sessions an update keeps and records them, and a
// launch's bindings (launch-bindings.ts), which know what a launch put on
// disk. It imports one type alone, so neither side imports the other: the helper
// says which sessions are kept, and the launch bindings hand over how to
// describe one and how to remove what one left on disk.
//
// A kept session's files stay through its kill: its per-session settings
// file, MCP config and status URL file, and a Codex session's hook folder.
// What the launch bound in this run's memory still goes at the kill, as
// before: this run is ending, and a take-over (S16 step 5) makes it again.
import type { ProviderId } from '../../shared/providers/ids'

/** What the release records of a session it keeps, as this run knows it:
 *  the conversation it is on, the account it runs on (an opaque id; null for
 *  the provider's default account, or not known), and the folder of its
 *  launch's hook file (a Codex session's; null when it has none). */
export interface KeptLaunchFacts {
  conversation: string | null
  account: string | null
  hookFolder: string | null
}

/** A kept session, as its record names it: the tab's id, its provider, and
 *  its launch's hook folder. */
export interface KeptLaunch {
  sessionId: string
  provider: ProviderId
  hookFolder: string | null
}

/** What the launch bindings hand over, once, when they load. */
export interface KeptLaunchBindings {
  describe(sessionId: string): KeptLaunchFacts
  /** Remove what the kept session left on disk: its three per-session files
   *  and its hook folder. Only once the session is no longer kept: it ended,
   *  or it is being ended. */
  remove(kept: KeptLaunch): void
}

const NOTHING_KNOWN: KeptLaunchFacts = { conversation: null, account: null, hookFolder: null }

let bindings: KeptLaunchBindings | null = null
let kept: ((sessionId: string) => boolean) | null = null

/** launch-bindings.ts, when it loads. */
export function setKeptLaunchBindings(b: KeptLaunchBindings | null): void {
  bindings = b
}

/** session-helper/manager.ts, when it loads: whether an update keeps this
 *  tab's session running now. */
export function setKeptLaunchCheck(check: ((sessionId: string) => boolean) | null): void {
  kept = check
}

/** True while an app update keeps this session's CLI running: what its launch
 *  put on disk stays when its process is killed. */
export function launchKeptForUpdate(sessionId: string): boolean {
  try {
    return kept?.(sessionId) === true
  } catch {
    return false
  }
}

/** What the release records of this session; nothing known when the launch
 *  bindings are not loaded, or reading them fails. */
export function describeKeptLaunch(sessionId: string): KeptLaunchFacts {
  try {
    return bindings?.describe(sessionId) ?? NOTHING_KNOWN
  } catch {
    return NOTHING_KNOWN
  }
}

/** Remove what a kept session left on disk. Never throws. */
export function removeKeptLaunch(k: KeptLaunch): void {
  try {
    bindings?.remove(k)
  } catch {
    /* each removal is best-effort; the start-up sweeps remain */
  }
}
