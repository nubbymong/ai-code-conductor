// The before-quit teardown's hold on starts that do not pass through the
// first-start warm-up (ADR-025).
//
// From the quit on, a caller of the first-start warm-up (first-start-warmup.ts)
// is never answered, so none starts its own program into the teardown after
// the agents and terminals were ended. The warm-up reads that latch before it
// looks at the platform or the program, so every start that awaits it is
// held. But four starts ask for a warm-up only on some paths: the first-run
// setup terminal (on Windows only), and headless Claude Code runs, cloud
// agents and the Accounts panel's own `claude auth status` (for a direct
// claude.exe on Windows only). On macOS and Linux, and for an npm claude.cmd
// on Windows, they never passed through the warm-up, so its latch did not hold
// them. Each of the four now reads this hold in the same step as its own
// start, whatever the platform or the program, and starts nothing once it is
// set.
//
// It is set at the same moment as the warm-up's latch, by
// flushFirstStartWarmups, which only the before-quit teardown calls (through
// flushPendingProviderCliKills, index.ts). The exit that installs an update
// and SIGTERM end the app without it. No start other than those four reads it,
// so a start that neither awaits the warm-up nor is one of them (an SSH
// launch, a Claude Code session terminal, the Claude sign-out through the CLI
// runner, with the status read inside it) is not held by either.
import { logInfo } from './debug-logger'

let begun = false
let logged = false

/** At the before-quit teardown (flushFirstStartWarmups): from now on every
 *  start that reads the hold starts nothing. */
export function beginQuitHold(): void {
  begun = true
}

/**
 * Null while the app runs. Once the before-quit teardown has begun: an answer
 * that never comes, which the caller returns in place of starting its
 * program, as a held caller of the warm-up waits (the process is ending). The
 * first time, one line is logged, so a wait left by a quit that was cancelled
 * after the teardown can be traced. `what` names the start, for that line.
 */
export function quitHold<T>(what: string): Promise<T> | null {
  if (!begun) return null
  if (!logged) {
    logged = true
    try { logInfo(`[quit] the app is quitting: ${what} is held and starts nothing`) } catch { /* logging never breaks the hold */ }
  }
  return new Promise<T>(() => { /* the process is ending */ })
}

/** Tests only: the hold is lifted, and its line will be logged again. */
export function _resetQuitHoldForTest(): void {
  begun = false
  logged = false
}
