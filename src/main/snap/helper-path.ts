/**
 * Which helper a Snap press runs (plan 2.1.3-beta.16 A1, aicc_planning#401).
 *
 * In an installed app, the helper the installer put beside it
 * (session-helper/install.ts bundledHelperPath). An end-to-end run starts the
 * app from out/main, where that path holds nothing, so it names the helper it
 * built through SNAP_TEST_HELPER_ENV, the test-only helper path. A packaged
 * app never reads it.
 */
import path from 'path'

export const SNAP_TEST_HELPER_ENV = 'CCC_E2E_SNAP_HELPER'

/** The helper a press runs: the test-only path, in an app that is not
 *  packaged, when one is set (an absolute path, else none); otherwise the
 *  helper beside the app when it is there. Null when there is none. */
export function snapHelperPath(o: { isPackaged: boolean; env: NodeJS.ProcessEnv; bundled: string; exists: (p: string) => boolean }): string | null {
  const forced = o.isPackaged ? undefined : o.env[SNAP_TEST_HELPER_ENV]
  if (forced) return path.isAbsolute(forced) ? forced : null
  return o.exists(o.bundled) ? o.bundled : null
}
