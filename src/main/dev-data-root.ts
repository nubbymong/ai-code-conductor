/**
 * The data root of a dev or end-to-end run: the one place the rule is written
 * (aicc_planning#335).
 *
 * The rule: `CCC_E2E_DATA_DIR` first, packaged or not, because an end-to-end
 * run's root is disposable and is never a real user's install; else
 * `CCC_DEV_DATA_DIR` when the app is not packaged (an installed app ignores
 * it); and only a full (absolute) path. A run with such a root keeps its
 * own files there, away from an installed app on the same computer
 * (docs/dev-alongside-prod.md).
 *
 * Its callers: devSessionDataDir (data-paths.ts), and helperRootDir and
 * instanceRecordPath (session-helper/install.ts). Each decides what it does
 * when there is no root, or when the root is not a full path; none keeps its
 * own copy of the rule.
 *
 * A LEAF: it imports `path` and nothing else. No Electron, registry or logger
 * import, because install.ts is loaded by helper tests that mock little, and
 * data-paths.ts already pulls in the registry and the logger.
 */
import * as path from 'path'

/**
 * The dev or end-to-end data root for this run: the root when it is a full
 * path; `undefined` when there is none (neither variable applies, or the one
 * that does is empty); `null` when the root that applies is not a full path.
 * A root that is not a full path is never swapped for the other variable: an
 * end-to-end root that is relative gives `null`, even with a dev root set.
 *
 * "Full" is judged by the rules of `platform` when it is named (`path.win32`
 * for win32, `path.posix` otherwise), and by this computer's rules when it is
 * not: a drive-letter root such as `C:\x` is full on Windows and is not on
 * macOS or Linux.
 */
export function devDataRoot(env: NodeJS.ProcessEnv, isPackaged: boolean, platform?: NodeJS.Platform): string | null | undefined {
  const root = env.CCC_E2E_DATA_DIR || (isPackaged ? undefined : env.CCC_DEV_DATA_DIR)
  if (!root) return undefined
  const rules = platform === undefined ? path : platform === 'win32' ? path.win32 : path.posix
  return rules.isAbsolute(root) ? root : null
}
