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
let waiters: Array<() => void> = []

/** Run the start's steps, once. A step that fails does not stop the next. */
export function startClaudeLookup(steps: ClaudeStartLookupSteps, platform: string = process.platform): void {
  if (platform !== 'win32') {
    steps.versionProbe()
    return
  }
  pending = true
  void Promise.resolve()
    .then(() => steps.refreshPath())
    .catch(() => { /* the lookup runs on the PATH there is */ })
    .then(() => steps.lookup())
    .catch(() => { /* a launch looks for itself */ })
    .then(() => {
      pending = false
      const w = waiters
      waiters = []
      for (const f of w) {
        try { f() } catch { /* one launch never stops another */ }
      }
      steps.versionProbe()
    })
    .catch(() => { /* the version stays unknown */ })
}

/** Whether the start's refresh and first lookup are still running (a launch
 *  that starts now waits for them, awaitClaudeStartLookup). */
export function claudeStartLookupPending(): boolean {
  return pending
}

/** A local Claude launch: wait, at most `waitMs`, for the start's refresh and
 *  first lookup. At once when they ran, or when nothing started them. Never
 *  rejects. */
export function awaitClaudeStartLookup(waitMs: number = CLAUDE_START_LOOKUP_WAIT_MS): Promise<void> {
  if (!pending) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, waitMs)
    ;(timer as { unref?: () => void }).unref?.()
    waiters.push(finish)
  })
}

/** Test seam: as before any start. */
export function _resetClaudeStartLookupForTest(): void {
  pending = false
  waiters = []
}
