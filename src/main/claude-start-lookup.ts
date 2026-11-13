// Windows, at start: when Claude Code is in no folder PATH names, PATH from
// the registry, then the first Claude Code lookup, then the version probe,
// and the launches that wait for them.
//
// A launch names Claude Code by its full path or starts nothing (#638,
// providers/claude/spawn.ts), and it cannot wait. A tab restored at start was
// launched before this process's PATH was brought up to date and before the
// PowerShell profile had answered, so it said "not found" until Check again.
//
// At start main therefore walks PATH for Claude Code once, as a launch does
// (claude-cli-probe.ts claudeOnWindowsPathNow: the walk only, the PowerShell
// profile not asked).
//
// Found: nothing here changes what the app did before. No launch is held,
// PATH is not refreshed, and the version probe runs at once.
//
// Not found: main brings PATH up to date once (windows-path-refresh.ts
// refreshWindowsPath, by its own rules), then looks for Claude Code once
// (claude-cli-probe.ts findClaudeOnWindowsAsync: the PATH walk, then the
// PowerShell profile), then runs the version probe. A local Claude launch
// asked for meanwhile waits for all three (ipc/pty-handlers.ts), at most
// CLAUDE_START_LOOKUP_WAIT_MS, and then resolves as any launch does: a full
// path, or the same refusal as before.
//
// Off Windows nothing is walked, refreshed or waited for: the version probe
// runs at once.
//
// The version probe comes after the lookup so that it runs the Claude Code a
// launch names. One started before the refresh would look on the PATH from
// before: a miss there is not asked about again by a launch for a minute
// (claude-cli-version.ts), and its question to the PowerShell profile is one
// the lookup has to wait out and ask again when the refresh adds folders.
// The held launches are released once the probe has answered, not before:
// a launch reads the version as it starts (managed-launch-diagnostics.ts),
// and one let go earlier would report it as not yet verified only because it
// was held.
//
// The look for each provider's CLI at start (the accounts service's, what
// Settings shows) reads PATH too, so main runs it after the refresh and the
// first lookup (claudeStartLookupSettled): its answer is then one for the
// PATH they leave, and it asks the profile nothing while the registry is
// read. It does not wait for the version probe, and its wait has the same
// bound as a launch's, so no provider's status stays "not checked yet" for
// longer than that.

import { logInfo, logWarn } from './debug-logger'

/** How long a launch waits for the start (the PATH refresh, the first lookup
 *  and the version probe), and how long the look for each provider's CLI
 *  waits for the first two. A registry read, a PowerShell profile question
 *  (10 s at most, windows-programs.ts POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS)
 *  and the version probe fit in it. */
export const CLAUDE_START_LOOKUP_WAIT_MS = 15_000

/** What main hands the start (index.ts). */
export interface ClaudeStartLookupSteps {
  /** Whether Claude Code is in a folder this process's PATH names now: the
   *  walk a launch makes, in place, the PowerShell profile not asked. Not
   *  called off Windows. */
  onPathNow: () => boolean
  /** Bring this process's PATH up to date from the registry. */
  refreshPath: () => Promise<unknown>
  /** Look for Claude Code once, keeping the answer a launch reads. */
  lookup: () => Promise<unknown>
  /** The version probe at start. What it returns settles once the probe has
   *  answered: the launches the start holds wait for that. */
  versionProbe: () => Promise<unknown>
}

/** Launches are held: from the start until the version probe has answered. */
let pending = false
/** The PATH refresh and the first lookup still run (what the look for each
 *  provider's CLI waits for). */
let lookupRunning = false
/** A launch has waited out the bound during this start: logged once. */
let boundLogged = false
const launchWaiters: Array<() => void> = []
const lookupWaiters: Array<() => void> = []

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const probeFailed = (e: unknown): void => { logWarn(`[start] The Claude Code version probe failed (${why(e)}); the version stays unknown`) }

/** The walk's answer; one that throws is "not found", and is logged. */
function foundOnPathNow(steps: ClaudeStartLookupSteps): boolean {
  try {
    return steps.onPathNow() === true
  } catch (e) {
    logWarn(`[start] The walk of PATH for Claude Code failed (${why(e)}); PATH is brought up to date and Claude Code looked for`)
    return false
  }
}

/** End every wait in `waiters`, leaving it empty. */
function release(waiters: Array<() => void>): void {
  for (const f of waiters.splice(0)) f()
}

/** Run the start's steps. Main calls it once (index.ts). A step that fails
 *  does not stop the next, and is logged. */
export function startClaudeLookup(steps: ClaudeStartLookupSteps, platform: string = process.platform): void {
  if (platform !== 'win32' || foundOnPathNow(steps)) {
    // As before the fix: the probe at once, in this turn, nothing waiting.
    try {
      void Promise.resolve(steps.versionProbe()).catch(probeFailed)
    } catch (e) {
      probeFailed(e)
    }
    return
  }
  pending = true
  lookupRunning = true
  void Promise.resolve()
    .then(() => steps.refreshPath())
    .catch((e: unknown) => { logWarn(`[start] PATH was not brought up to date from the registry (${why(e)}); Claude Code is looked for on the PATH there is`) })
    .then(() => steps.lookup())
    .catch((e: unknown) => { logWarn(`[start] The first Claude Code lookup failed (${why(e)}); a launch looks for itself`) })
    .then(() => {
      lookupRunning = false
      release(lookupWaiters)
      return steps.versionProbe()
    })
    .catch(probeFailed)
    .then(() => {
      pending = false
      release(launchWaiters)
    })
}

/** Whether the start still holds launches: its refresh, first lookup and
 *  version probe have not all answered (a launch that starts now waits for
 *  them, awaitClaudeStartLookup). Never true when the walk at start found
 *  Claude Code, nor off Windows. */
export function claudeStartLookupPending(): boolean {
  return pending
}

/** A wait in `waiters`, ended by their release or after `waitMs`, whichever
 *  comes first; `onBound` runs when it is the bound. */
function waitIn(waiters: Array<() => void>, waitMs: number, onBound: () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    // Cleared by a release (finish), so it runs only when the bound passed.
    const timer = setTimeout(() => {
      onBound()
      finish()
    }, waitMs)
    ;(timer as { unref?: () => void }).unref?.()
    waiters.push(finish)
  })
}

/** A local Claude launch: wait, at most `waitMs`, for the start's refresh,
 *  first lookup and version probe. At once when they have answered or when
 *  nothing started them. Every launch asked for while they run waits, each
 *  by its own bound (a retry of a tab refused during a slow start too: the
 *  answer may come while it waits). The first wait the bound ends is logged,
 *  once for the start. Never rejects. */
export function awaitClaudeStartLookup(waitMs: number = CLAUDE_START_LOOKUP_WAIT_MS): Promise<void> {
  if (!pending) return Promise.resolve()
  return waitIn(launchWaiters, waitMs, () => {
    if (boundLogged) return
    boundLogged = true
    logInfo(`[start] Still looking for Claude Code after ${waitMs / 1000} s (PATH from the registry, the first lookup, the version probe); a launch waits no longer and resolves on what is known`)
  })
}

/** For work at start that reads PATH and that nothing waits for (the look
 *  for each provider's CLI, index.ts): after the start's refresh and first
 *  lookup, at most `waitMs` (then it runs on the PATH there is, and that is
 *  logged). It does not wait for the version probe. At once when the two
 *  have answered, or when nothing started them. Never rejects. */
export function claudeStartLookupSettled(waitMs: number = CLAUDE_START_LOOKUP_WAIT_MS): Promise<void> {
  if (!lookupRunning) return Promise.resolve()
  return waitIn(lookupWaiters, waitMs, () => {
    logInfo(`[start] PATH from the registry and the first Claude Code lookup still running after ${waitMs / 1000} s; each provider's CLI is looked for on the PATH there is`)
  })
}

/** Test seam: as before any start. */
export function _resetClaudeStartLookupForTest(): void {
  pending = false
  lookupRunning = false
  boundLogged = false
  launchWaiters.length = 0
  lookupWaiters.length = 0
}
