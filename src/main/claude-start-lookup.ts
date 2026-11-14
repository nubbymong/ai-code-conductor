// Windows, at start, with Claude Code switched on: a walk of PATH for Claude
// Code and, when it is in no folder PATH names, PATH from the registry, then
// the first Claude Code lookup, then the version probe; and the launches
// that wait for them.
//
// A launch names Claude Code by its full path or starts nothing (#638,
// providers/claude/spawn.ts), and it cannot wait. A tab restored at start was
// launched before this process's PATH was brought up to date and before the
// PowerShell profile had answered, so it said "not found" until Check again.
//
// At start main therefore marks the start pending and walks PATH for Claude
// Code once, in a launch's order (claude-cli-probe.ts
// claudeOnWindowsPathAsync: the walk only, the PowerShell profile not asked,
// its answer kept for the launch). The walk is never made in place: a PATH
// folder on a share that does not answer can hold one file test for tens of
// seconds, and this runs before the first window exists.
//
// Found: the start ends there. Nothing more is held, PATH is not refreshed,
// the registry is not read, and the version probe starts at once.
//
// Not found: main brings PATH up to date once (windows-path-refresh.ts
// refreshWindowsPath, by its own rules), then looks for Claude Code once
// (claude-cli-probe.ts findClaudeOnWindowsAsync: the PATH walk, then the
// PowerShell profile), then runs the version probe.
//
// A local Claude launch asked for while the start is pending waits for it
// (ipc/pty-handlers.ts), at most CLAUDE_START_LOOKUP_WAIT_MS, and then
// resolves as any launch does: a full path, or the same refusal as before.
// The start as a whole ends at CLAUDE_START_DEADLINE_MS at the latest: from
// then on nothing is held, whatever step still runs.
//
// While Claude Code is switched off (or its settings cannot be read), and
// off Windows, nothing is walked, refreshed or waited for: the version probe
// is handed over at once, as before this module existed.
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
// Settings shows) reads PATH too, so it runs after the walk and, when that
// found none, after the refresh and the first lookup
// (claudeStartLookupSettled): its answer is then one for the PATH they
// leave, and it asks the profile nothing while the registry is read. It does
// not wait for the version probe, and its wait has the same bound as a
// launch's, so no provider's status stays "not checked yet" for longer than
// that.

import { logInfo, logWarn } from './debug-logger'

/** How long a launch waits for the start (the walk of PATH and, when that
 *  finds no Claude Code, the PATH refresh, the first lookup and the version
 *  probe), and how long the look for each provider's CLI waits for all but
 *  the probe. A cap, not the sum of what the steps may take: in the usual
 *  case they end well inside it, but each has a longer limit of its own (the
 *  registry read, the PowerShell profile question at
 *  windows-programs.ts POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS, the version
 *  probe and the first-start warm-up before it). Past it a launch resolves
 *  on what is known, and is refused as before when that is nothing. */
export const CLAUDE_START_LOOKUP_WAIT_MS = 15_000

/** How long the start as a whole may hold anything. When it passes while a
 *  step still runs, the start is no longer pending: every wait ends, and a
 *  launch asked for later does not wait at all. The steps themselves run on
 *  to their own ends. */
export const CLAUDE_START_DEADLINE_MS = 2 * CLAUDE_START_LOOKUP_WAIT_MS

/** The start's steps (startClaudeAtBoot makes them from what main hands it). */
export interface ClaudeStartLookupSteps {
  /** Main's launch rule for Claude Code: false while it is switched off or
   *  its settings cannot be read. One that throws is false. Not called off
   *  Windows. */
  claudeOn: () => boolean
  /** Whether Claude Code is in a folder this process's PATH names now: the
   *  walk in a launch's order, off the event loop, the PowerShell profile not
   *  asked. One that fails is "not found". */
  onPath: () => Promise<boolean>
  /** Bring this process's PATH up to date from the registry. */
  refreshPath: () => Promise<unknown>
  /** Look for Claude Code once, keeping the answer a launch reads. */
  lookup: () => Promise<unknown>
  /** The version probe at start. What it returns settles once the probe has
   *  answered: the launches the start holds wait for that. */
  versionProbe: () => Promise<unknown>
}

/** Launches are held: from the start until the walk has found Claude Code,
 *  the version probe has answered, or the deadline has passed. */
let pending = false
/** The walk, the PATH refresh and the first lookup still run (what the look
 *  for each provider's CLI waits for). */
let lookupRunning = false
/** A launch has waited out the bound during this start: logged once. */
let boundLogged = false
/** The deadline's timer, while the start is pending. */
let deadline: ReturnType<typeof setTimeout> | null = null
/** Which start this is: what an earlier one still has running changes
 *  nothing (main starts once; the test seam starts again). */
let starts = 0
const launchWaiters: Array<() => void> = []
const lookupWaiters: Array<() => void> = []

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e))
/** A log line of a step or of the deadline. A logger that throws is not a
 *  reason to skip the next step or to keep a launch held. */
function say(log: (line: string) => void, line: string): void {
  try { log(line) } catch { /* nothing to do about it */ }
}
const probeFailed = (e: unknown): void => { say(logWarn, `[start] The Claude Code version probe failed (${why(e)}); the version stays unknown`) }

function claudeIsOn(steps: ClaudeStartLookupSteps): boolean {
  try { return steps.claudeOn() === true } catch { return false }
}

/** Start the version probe now, in this turn; nothing waits for it. */
function probeNow(steps: ClaudeStartLookupSteps): void {
  try {
    void Promise.resolve(steps.versionProbe()).catch(probeFailed)
  } catch (e) {
    probeFailed(e)
  }
}

/** End every wait in `waiters`, leaving it empty. */
function release(waiters: Array<() => void>): void {
  for (const f of waiters.splice(0)) f()
}

/** As before any start: nothing pending, no deadline, every wait ended. */
function clear(): void {
  if (deadline !== null) clearTimeout(deadline)
  deadline = null
  pending = false
  lookupRunning = false
  release(launchWaiters)
  release(lookupWaiters)
}

/** Start `start`'s walk, refresh and first lookup are over. */
function lookupEnded(start: number): void {
  if (start !== starts) return
  lookupRunning = false
  release(lookupWaiters)
}

/** Start `start` holds nothing any longer. */
function startEnded(start: number): void {
  if (start === starts) clear()
}

/** Run the start's steps. Main calls it once (startClaudeAtBoot). It returns
 *  at once, with the start already pending when there is anything to wait
 *  for. A step that fails does not stop the next, and is logged. */
export function startClaudeLookup(steps: ClaudeStartLookupSteps, platform: string = process.platform): void {
  const start = ++starts
  clear()
  if (platform !== 'win32' || !claudeIsOn(steps)) {
    // As before the fix: the probe at once, in this turn, nothing waiting.
    probeNow(steps)
    return
  }
  pending = true
  lookupRunning = true
  deadline = setTimeout(() => {
    say(logInfo, `[start] The look for Claude Code at start has not ended after ${CLAUDE_START_DEADLINE_MS / 1000} s; no launch is held for it any longer, and each resolves on what is known`)
    startEnded(start)
  }, CLAUDE_START_DEADLINE_MS)
  ;(deadline as { unref?: () => void }).unref?.()
  // The walk begins in this turn and is waited for off it; one that throws
  // before it has anything to wait for is a walk that failed.
  void new Promise<boolean>((resolve) => { resolve(steps.onPath()) })
    .then((found) => found === true, (e: unknown) => {
      say(logWarn, `[start] The walk of PATH for Claude Code failed (${why(e)}); PATH is brought up to date and Claude Code looked for`)
      return false
    })
    .then((found) => {
      if (found) {
        // Claude Code is where a launch looks: nothing to refresh, nothing
        // more to wait for, and the probe at once.
        startEnded(start)
        probeNow(steps)
        return undefined
      }
      return Promise.resolve()
        .then(() => steps.refreshPath())
        .catch((e: unknown) => { say(logWarn, `[start] PATH was not brought up to date from the registry (${why(e)}); Claude Code is looked for on the PATH there is`) })
        .then(() => steps.lookup())
        .catch((e: unknown) => { say(logWarn, `[start] The first Claude Code lookup failed (${why(e)}); a launch looks for itself`) })
        .then(() => {
          lookupEnded(start)
          return steps.versionProbe()
        })
        .catch(probeFailed)
        .then(() => { startEnded(start) })
    })
}

/** Whether the start still holds launches: its walk has not found Claude
 *  Code, its refresh, first lookup and version probe have not all answered,
 *  and its deadline has not passed (a launch that starts now waits for them,
 *  awaitClaudeStartLookup). Never true while Claude Code is switched off,
 *  nor off Windows. */
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
    // Whatever `onBound` does, a logger that throws included, the wait ends.
    const timer = setTimeout(() => {
      try { onBound() } catch { /* the wait ends all the same */ } finally { finish() }
    }, waitMs)
    ;(timer as { unref?: () => void }).unref?.()
    waiters.push(finish)
  })
}

/** A local Claude launch: wait, at most `waitMs`, for the start (its walk
 *  and, when that found no Claude Code, its refresh, first lookup and
 *  version probe). At once when it has ended, when its deadline has passed,
 *  or when nothing started it. Every launch asked for while it is pending
 *  waits, each by its own bound (a retry of a tab refused during a slow
 *  start too: the answer may come while it waits). The first wait the bound
 *  ends is logged, once for the start. Never rejects. */
export function awaitClaudeStartLookup(waitMs: number = CLAUDE_START_LOOKUP_WAIT_MS): Promise<void> {
  if (!pending) return Promise.resolve()
  return waitIn(launchWaiters, waitMs, () => {
    if (boundLogged) return
    boundLogged = true
    logInfo(`[start] Still looking for Claude Code after ${waitMs / 1000} s (PATH from the registry, the first lookup, the version probe); a launch waits no longer and resolves on what is known`)
  })
}

/** For work at start that reads PATH and that nothing waits for (the look
 *  for each provider's CLI, startClaudeAtBoot): after the start's walk and,
 *  when that found no Claude Code, its refresh and first lookup, at most
 *  `waitMs` (then it runs on the PATH there is, and that is logged). It does
 *  not wait for the version probe. At once when they have answered, when
 *  the start's deadline has passed, or when nothing started them. Never
 *  rejects. */
export function claudeStartLookupSettled(waitMs: number = CLAUDE_START_LOOKUP_WAIT_MS): Promise<void> {
  if (!lookupRunning) return Promise.resolve()
  return waitIn(lookupWaiters, waitMs, () => {
    logInfo(`[start] PATH from the registry and the first Claude Code lookup still running after ${waitMs / 1000} s; each provider's CLI is looked for on the PATH there is`)
  })
}

/** What main hands the start (index.ts): the functions themselves, so that
 *  what is done with them is here, where a test can run it. */
export interface ClaudeStartAtBoot {
  /** Main's launch rule for Claude Code (claude-cli-version.ts
   *  claudeCliProbeAllowed). */
  claudeOn: () => boolean
  /** This process's environment: the PATH a launch reads. */
  env: NodeJS.ProcessEnv
  /** The walk of PATH for Claude Code, off the event loop, its answer kept
   *  for a launch (claude-cli-probe.ts claudeOnWindowsPathAsync). */
  walkPath: (env: NodeJS.ProcessEnv) => Promise<string | null>
  /** windows-path-refresh.ts refreshWindowsPath. */
  refreshPath: () => Promise<unknown>
  /** The lookup: the walk, then the PowerShell profile (claude-cli-probe.ts
   *  findClaudeOnWindowsAsync). */
  findClaude: (env: NodeJS.ProcessEnv) => Promise<unknown>
  /** The version probe; what it returns settles once it has answered. */
  versionProbe: () => Promise<unknown>
  /** The accounts start-up work the look for each provider's CLI comes
   *  after, as a promise that does not reject; null when the accounts
   *  service did not start (nothing is looked for then). */
  accountsWork: Promise<unknown> | null
  /** The look for each switched-on provider's CLI (provider-accounts.ts
   *  discoverProvidersAtStart). */
  discover: () => unknown
}

/** The start, as main runs it once, before any window exists: the start is
 *  pending when this returns (on Windows, Claude Code switched on), so a
 *  launch a window asks for afterwards waits for it. Claude Code is not
 *  looked for, by the walk or by the lookup, while it is switched off. Then,
 *  after the accounts work, the look for each provider's CLI: on Windows it
 *  reads PATH, so it waits (bounded, claudeStartLookupSettled) for the walk,
 *  the refresh and the first lookup, which are under way by the time the
 *  accounts work can have answered; a look on the PATH from before would say
 *  "missing" until Check again for a CLI the refresh adds. */
export function startClaudeAtBoot(boot: ClaudeStartAtBoot, platform: string = process.platform): void {
  startClaudeLookup({
    claudeOn: boot.claudeOn,
    onPath: () => boot.walkPath(boot.env).then((found) => found !== null),
    refreshPath: boot.refreshPath,
    lookup: () => (boot.claudeOn() ? boot.findClaude(boot.env) : Promise.resolve(null)),
    versionProbe: boot.versionProbe,
  }, platform)
  if (boot.accountsWork === null) return
  void boot.accountsWork
    .then(() => claudeStartLookupSettled())
    .then(() => { boot.discover() })
}

/** Test seam: as before any start. */
export function _resetClaudeStartLookupForTest(): void {
  starts += 1
  clear()
  boundLogged = false
}
