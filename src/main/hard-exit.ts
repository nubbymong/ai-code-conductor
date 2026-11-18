/**
 * What every exit through `app.exit` runs first.
 *
 * `app.exit` skips before-quit, so the quit teardown (quitTeardown in
 * index.ts) does not run on these paths: an update install, once the
 * installer has started (ipc/update-handlers.ts), and SIGTERM (index.ts).
 * hardExitTeardown is what they run instead. Each step is synchronous,
 * idempotent and never throws, so it cannot stop the exit.
 *
 * Today it has one step: end the vision browser the app started
 * (killSpawnedBrowser), which would otherwise outlive the app.
 */

import { killSpawnedBrowser } from './vision-manager'

/** The steps every `app.exit` path runs, in order. */
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
 * signal must not route through it. A step that throws never skips the ones
 * after it, so the exit always comes.
 */
export function exitOnSigterm(deps: SigtermExitDeps): void {
  try { deps.flushSessions() } catch { /* best-effort */ }
  try { deps.flushIndexingGaps() } catch { /* best-effort */ }
  hardExitTeardown()
  deps.exit(0)
}
