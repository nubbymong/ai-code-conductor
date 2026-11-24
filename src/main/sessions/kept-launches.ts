// An app update keeps a held agent session's CLI running (S16 step 4,
// aicc_planning#387 with #359; Windows, with the agent sessions' switch on).
// This is the seam between the session helper (session-helper/manager.ts),
// which decides which sessions an update keeps and records them, and a
// launch's bindings (launch-bindings.ts), which know what a launch put on
// disk. It imports types alone, so neither side imports the other: the helper
// says which sessions are kept, and the launch bindings hand over how to
// describe one and how to remove what one left on disk.
//
// A kept session's files stay through its kill: its per-session settings
// file, MCP config and status URL file, its launch's hook folder, and the
// resume list's pick folder (aicc_planning#419).
// What the launch bound in this run's memory still goes at the kill, as
// before: this run is ending, and a take-over (S16 step 5) makes it again.
//
// 2.1.3-beta.17 (S16 step 5, aicc_planning#412): the next start's restored
// tab asks, through the same seam, for the session the helper keeps for it
// (takeKeptSession), and the launch bindings make the take-over's bindings.
// aicc_planning#423 (B1d): a session kept for a restored tab that is not shown
// yet is served its Conductor tool calls through the same seam until then
// (serveKeptLaunch), and what that bound goes when it is kept no longer
// (unserveKeptLaunch).
import type { IPty } from 'node-pty'
import type { ProviderId } from '../../shared/providers/ids'
import type { ResumePick } from '../providers/types'

/** What the release records of a session it keeps, as this run knows it:
 *  the conversation it is on, the account it runs on (an opaque id; null for
 *  the provider's default account, or not known), and the folder of its
 *  launch's hook file (null when its launch has none). `pick`
 *  (aicc_planning#419): a launch through the resume list's pick file, its
 *  folder as made and the decision read last. */
export interface KeptLaunchFacts {
  conversation: string | null
  account: string | null
  hookFolder: string | null
  pick?: ResumePick
}

/** A kept session, as its record names it: the tab's id, its provider, and
 *  its launch's hook folder and pick. */
export interface KeptLaunch {
  sessionId: string
  provider: ProviderId
  hookFolder: string | null
  pick?: ResumePick
}

/** What the launch bindings hand over, once, when they load. */
export interface KeptLaunchBindings {
  describe(sessionId: string): KeptLaunchFacts
  /** Remove what the kept session left on disk: its three per-session files,
   *  its hook folder and its pick folder. Only once the session is no longer
   *  kept: it ended, or it is being ended. */
  remove(kept: KeptLaunch): void
  /** aicc_planning#423: the next start keeps the session for its tab. What
   *  its launch left that names the last run's address and credential, which
   *  this run refuses, is emptied until the take-over writes it again. */
  hold?(kept: KeptLaunch): void
  /** aicc_planning#423 (B1d): the session kept for a restored tab that is not
   *  shown is served its Conductor tool calls under the tab's id until the
   *  take-over: the tool host's record, the review and canvas registrations
   *  (`cwd`: the tab's configured folder), and the hook file in its kept hook
   *  folder, where it has one, written again. False when it is not served
   *  (the tool host is not serving). */
  serve?(kept: KeptUnseen, cwd: string | undefined): boolean
  /** What serve bound goes, once the session is kept no longer; nothing when
   *  a launch of the tab has cleared it already (its spawn's teardown). */
  unserve?(sessionId: string): void
}

/** A kept session to serve while its tab is not shown (B1d): as its record
 *  names it, with the folder its CLI was launched in (null: not recorded). */
export interface KeptUnseen extends KeptLaunch {
  folder: string | null
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

/** A session the next start keeps for its tab (aicc_planning#423): what its
 *  launch left naming the last run's address is emptied. Never throws. */
export function holdKeptLaunch(k: KeptLaunch): void {
  try {
    bindings?.hold?.(k)
  } catch {
    /* best-effort: its status line falls back to its status file */
  }
}

/** A session kept for a restored tab not shown: its tool calls served now
 *  (B1d). False when they are not, or when asking fails. */
export function serveKeptLaunch(k: KeptUnseen, cwd: string | undefined): boolean {
  try {
    return bindings?.serve?.(k, cwd) === true
  } catch {
    return false
  }
}

/** A session kept for its tab is kept no longer: what serveKeptLaunch bound
 *  goes. Never throws. */
export function unserveKeptLaunch(sessionId: string): void {
  try {
    bindings?.unserve?.(sessionId)
  } catch {
    /* best-effort: the tab's next launch makes its own bindings */
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

/** A tab Resume restored: its id, and (B1d) the folder a local agent tab's
 *  launch is configured in, for the canvas roots its kept session is served
 *  with while the tab is not shown. */
export interface RestoredTab {
  id: string
  cwd?: string
}

/** What the renderer says of its tabs that a session kept for a restored tab
 *  waits on (aicc_planning#423): the tabs Resume restored, a tab shown and
 *  starting now, and a tab closed. */
export interface KeptTabSignals {
  restored(tabs: ReadonlyArray<RestoredTab>): void
  shown(sessionId: string): void
  closed(sessionId: string): void
  /** B1e: whether a session is kept for this tab now, not yet taken over. */
  waits?(sessionId: string): boolean
}
let tabSignals: KeptTabSignals | null = null

/** session-helper/manager.ts, when it loads. */
export function setKeptTabSignals(s: KeptTabSignals | null): void {
  tabSignals = s
}

/** The IPC handlers (pty-handlers.ts) pass each one on. Never throw. */
export function keptTabsRestored(tabs: ReadonlyArray<RestoredTab>): void {
  try { tabSignals?.restored(tabs) } catch { /* each kept session keeps its time limit */ }
}
export function keptTabShown(sessionId: string): void {
  try { tabSignals?.shown(sessionId) } catch { /* its kept session keeps no limit then; a close or a quit ends it */ }
}
export function keptTabClosed(sessionId: string): void {
  try { tabSignals?.closed(sessionId) } catch { /* a quit ends it */ }
}

/** aicc_planning#423 (B1e): true while the helper keeps a session for this
 *  tab that the tab has not taken over: from the start that kept it until
 *  its take-over or its end. What it says then (its hook events, its status
 *  line) reaches the tab, and a transcript it names is bound by nothing
 *  until its take-over, which binds its logging run and transcript first.
 *  False when asking fails. */
export function keptForItsTab(sessionId: string): boolean {
  try { return tabSignals?.waits?.(sessionId) === true } catch { return false }
}
