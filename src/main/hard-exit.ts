/**
 * What the exits through `app.exit` that skip the quit teardown run first.
 *
 * `app.exit` skips before-quit, so the quit teardown (quitTeardown in
 * index.ts) does not run on two paths: an update install, once the installer
 * has started (ipc/update-handlers.ts), and SIGTERM (index.ts).
 * hardExitTeardown is what they run instead. Each step is synchronous,
 * idempotent and never throws, so it cannot stop the exit.
 *
 * Two other `app.exit` calls do not need it: the one when the providers
 * cannot be registered at start-up (index.ts, composeProviders), which comes
 * before vision has started anything, and the one that ends a normal quit
 * once the session helper has answered (session-helper/app-wiring.ts,
 * holdQuitForSessionHelper), which comes after the quit teardown has run.
 *
 * Today it has one step: end the vision browser the app started
 * (killSpawnedBrowser), which would otherwise outlive the app.
 */

import { killSpawnedBrowser } from './vision-manager'
import { logError } from './debug-logger'

/** The steps the update install and SIGTERM exits run before `app.exit`. */
export function hardExitTeardown(): void {
  try { killSpawnedBrowser() } catch { /* the exit goes ahead */ }
}

/** What the SIGTERM exit needs from the app (index.ts passes them in). */
export interface SigtermExitDeps {
  /** Persist the sessions (sessionDurability.flushOnExit). */
  flushSessions(): void
  /** Write the conversations written while not indexed (flushIndexingGaps). */
  flushIndexingGaps(): void
  /** app.exit. */
  exit(code: number): void
}

/**
 * The SIGTERM handler's body (task manager terminate, OS teardown): persist
 * the sessions, write the indexing gaps, run the hard-exit teardown, then
 * exit hard with code 0. app.quit() would be vetoed by the close dialog, so a
 * signal must not route through it. A step that throws is logged and skips
 * none of the ones after it, so the exit always comes.
 */
export function exitOnSigterm(deps: SigtermExitDeps): void {
  try { deps.flushSessions() } catch (err) { logStepFailed('The session flush', err) }
  try { deps.flushIndexingGaps() } catch (err) { logStepFailed('The indexing-gap flush', err) }
  hardExitTeardown()
  deps.exit(0)
}

/** One line in the debug log for a SIGTERM step that threw. The log itself
 *  never stops the exit either. */
function logStepFailed(step: string, err: unknown): void {
  try { logError(`[exit] ${step} at SIGTERM failed:`, err) } catch { /* the exit goes ahead */ }
}
