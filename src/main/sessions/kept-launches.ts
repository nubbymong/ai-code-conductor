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
// file, MCP config and status URL file, and its launch's hook folder.
// What the launch bound in this run's memory still goes at the kill, as
// before: this run is ending, and a take-over (S16 step 5) makes it again.
//
// 2.1.3-beta.17 (S16 step 5, aicc_planning#412): the next start's restored
// tab asks, through the same seam, for the session the helper keeps for it
// (takeKeptSession), and the launch bindings make the take-over's bindings.
import type { IPty } from 'node-pty'
import type { ProviderId } from '../../shared/providers/ids'

/** What the release records of a session it keeps, as this run knows it:
 *  the conversation it is on, the account it runs on (an opaque id; null for
 *  the provider's default account, or not known), and the folder of its
 *  launch's hook file (null when its launch has none). */
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

/** What the last run's update recorded of a session a tab takes over: what
 *  its release knew (KeptLaunchFacts), the folder its CLI was launched in
 *  (null when the record does not say: one an earlier version wrote), and
 *  when the update let go of it. */
export interface KeptSessionFacts extends KeptLaunchFacts {
  folder: string | null
  /** When the update let go of it, in ms; 0 when the record does not say. */
  at: number
}

/** A session the helper kept for a tab, now taken over: its terminal, and
 *  what was recorded of it. */
export interface KeptTakeOver {
  pty: IPty
  kept: KeptSessionFacts
}

type TakeOver = (sessionId: string, provider: ProviderId, size: { cols: number; rows: number }, account?: string | null) => KeptTakeOver | null
let takeOver: TakeOver | null = null

/** session-helper/manager.ts, when it loads. */
export function setKeptTakeOver(t: TakeOver | null): void {
  takeOver = t
}

/** The session the helper keeps for this tab and provider, taken over now
 *  (S16 step 5): null when it keeps none (the tab starts its CLI the usual
 *  way), or when asking fails. `account`, when given: only a session the
 *  release recorded on that account (the account lease the tab's launch
 *  was prepared with, or the account it names). */
export function takeKeptSession(sessionId: string, provider: ProviderId, size: { cols: number; rows: number }, account?: string | null): KeptTakeOver | null {
  try {
    return takeOver?.(sessionId, provider, size, account) ?? null
  } catch {
    return null
  }
}
