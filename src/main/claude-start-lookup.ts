// Windows, at start: PATH from the registry, then the first Claude Code
// lookup, and the launches that wait for them.
//
// A launch names Claude Code by its full path or starts nothing (#638,
// providers/claude/spawn.ts), and it cannot wait. A tab restored at start was
// launched before this process's PATH was brought up to date and before the
// PowerShell profile had answered, so it said "not found" until Check again.
// At start main therefore brings PATH up to date once (windows-path-refresh.ts
// refreshWindowsPath, by its own rules), then looks for Claude Code once
// (claude-cli-probe.ts findClaudeOnWindowsAsync: the PATH walk, then the
// PowerShell profile), and only then runs the version probe. A local Claude
// launch asked for meanwhile waits for both (ipc/pty-handlers.ts), at most
// CLAUDE_START_LOOKUP_WAIT_MS, and then resolves as any launch does: a full
// path, or the same refusal as before. Off Windows nothing is refreshed and
// nothing waits: the version probe runs at once.
//
// The version probe comes last on Windows so that it runs the Claude Code a
// launch names. One started before the refresh would look on the PATH from
// before: a miss there is not asked about again by a launch for a minute
// (claude-cli-version.ts), and its question to the PowerShell profile is one
// the lookup has to wait out and ask again when the refresh adds folders.
// What that costs: a launch the start releases is under way before the probe
// has answered, so its report says the version is not yet verified, as for
// any launch that comes before the probe's answer.
//
// The look for each provider's CLI at start (the accounts service's, what
// Settings shows) reads PATH too, so main runs it after these two
// (claudeStartLookupSettled): its answer is then one for the PATH they
// leave, and it asks the profile nothing while the registry is read.

import { logInfo, logWarn } from './debug-logger'

/** How long a launch waits for the start's PATH refresh and first lookup. */
export const CLAUDE_START_LOOKUP_WAIT_MS = 5000

/** What main hands the start (index.ts). */
export interface ClaudeStartLookupSteps {
  /** Bring this process's PATH up to date from the registry. */
  refreshPath: () => Promise<unknown>
  /** Look for Claude Code once, keeping the answer a launch reads. */
  lookup: () => Promise<unknown>
  /** The version probe at start: after both on Windows, at once elsewhere. */
  versionProbe: () => void
}

let pending = false
/** A launch has waited out the bound while the start still ran: the launches
 *  after it do not wait again (awaitClaudeStartLookup). */
let boundPassed = false
let waiters: Array<() => void> = []

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Run the start's steps. Main calls it once (index.ts). A step that fails
 *  does not stop the next, and is logged. */
export function startClaudeLookup(steps: ClaudeStartLookupSteps, platform: string = process.platform): void {
  if (platform !== 'win32') {
    steps.versionProbe()
    return
  }
  pending = true
  void Promise.resolve()
    .then(() => steps.refreshPath())
    .catch((e: unknown) => { logWarn(`[start] PATH was not brought up to date from the registry (${why(e)}); Claude Code is looked for on the PATH there is`) })
    .then(() => steps.lookup())
    .catch((e: unknown) => { logWarn(`[start] The first Claude Code lookup failed (${why(e)}); a launch looks for itself`) })
    .then(() => {
      pending = false
      const w = waiters
      waiters = []
      for (const f of w) f()
      steps.versionProbe()
    })
    .catch((e: unknown) => { logWarn(`[start] The Claude Code version probe did not start (${why(e)}); the version stays unknown`) })
}

/** Whether the start's refresh and first lookup are still running (a launch
 *  that starts now waits for them, awaitClaudeStartLookup). */
export function claudeStartLookupPending(): boolean {
  return pending
}

/** A local Claude launch: wait, at most `waitMs`, for the start's refresh and
 *  first lookup. At once when they ran, when nothing started them, or when a
 *  launch before this one already waited out the bound (a retry of a tab
 *  refused during a slow start is answered at once, not after the bound
 *  again). The first wait the bound ends is logged. Never rejects. */
export function awaitClaudeStartLookup(waitMs: number = CLAUDE_START_LOOKUP_WAIT_MS): Promise<void> {
  if (!pending || boundPassed) return Promise.resolve()
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
      if (!boundPassed) {
        boundPassed = true
        logInfo(`[start] Claude Code lookup still running after ${waitMs / 1000} s; launching on what is known, and later launches do not wait for it`)
      }
      finish()
    }, waitMs)
    ;(timer as { unref?: () => void }).unref?.()
    waiters.push(finish)
  })
}

/** For work at start that reads PATH and that nothing waits for (the look
 *  for each provider's CLI, index.ts): after the start's refresh and first
 *  lookup, however long they take (each has its own limit). At once when
 *  they ran, or when nothing started them. Never rejects. */
export function claudeStartLookupSettled(): Promise<void> {
  if (!pending) return Promise.resolve()
  return new Promise<void>((resolve) => { waiters.push(resolve) })
}

/** Test seam: as before any start. */
export function _resetClaudeStartLookupForTest(): void {
  pending = false
  boundPassed = false
  waiters = []
}
