// The environment and the Codex folder codex-cli-compat.test.ts runs the PATH
// `codex` with (PR 4 VM checkpoint, F4), apart from that file, whose spawn
// runs as soon as it is loaded, so this part is checked on every run of the
// suite without starting anything (codex-cli-compat-env.test.ts). So are how
// that file finds `codex` on PATH, and when it may skip without one.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { codexCliEnv } from '../../src/main/providers/codex/cli-env'

/** The temp-folder prefix of a run's Codex folder: only a folder of this
 *  prefix, directly in the temp folder, is ever removed. */
export const COMPAT_HOME_PREFIX = 'ccc-cli-compat-home-'

/** The app's own allowlisted Codex environment (codexCliEnv): none of the
 *  caller's CODEX_* or OPENAI_* variables, so nothing names the real Codex
 *  folder or a credential, and CODEX_HOME the run's fresh folder. */
export function compatProbeEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return codexCliEnv(inherited, home, platform)
}

/** Removes `home` when it is a folder of this file's prefix directly in the
 *  temp folder; anything else is left as it is (false). */
export function removeCompatHome(home: string): boolean {
  if (path.dirname(home) !== os.tmpdir() || !path.basename(home).startsWith(COMPAT_HOME_PREFIX)) return false
  fs.rmSync(home, { recursive: true, force: true })
  return true
}

/** Runs `fn` with a fresh, empty Codex folder, removed after it, however it
 *  ends. */
export function withCompatHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), COMPAT_HOME_PREFIX))
  try {
    return fn(home)
  } finally {
    try { removeCompatHome(home) } catch { /* a leftover temp folder is harmless */ }
  }
}

/** A file there that a shell would start: a file (not a folder), and outside
 *  Windows one this user may run. */
function startable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The first `codex` the folders of `pathValue` hold, in their order, as a
 *  shell finds it: on Windows the names PATHEXT gives (`codex.cmd` for an
 *  npm install), elsewhere `codex` itself. Read from the folders, with no
 *  process started and no time limit. The suite's `where codex` under a 3 s
 *  limit read as none on a slow Windows runner where codex was on PATH
 *  (CI run 45756034358, the pinned Windows leg: its import took 6.13 s, the
 *  other two Windows legs' 2.86 s and 2.92 s), and the suite skipped. */
export function findCodexOnPath(
  pathValue: string | undefined,
  platform: NodeJS.Platform = process.platform,
  pathExt: string | undefined = process.env.PATHEXT,
  isStartable: (file: string) => boolean = startable,
): string | null {
  const win = platform === 'win32'
  const join = win ? path.win32.join : path.posix.join
  const folders = (pathValue ?? '').split(win ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => d !== '')
  const names = win
    ? (pathExt && pathExt.trim() !== '' ? pathExt : '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter((e) => e !== '').map((e) => `codex${e.toLowerCase()}`)
    : ['codex']
  for (const folder of folders) {
    for (const name of names) {
      const file = join(folder, name)
      if (isStartable(file)) return file
    }
  }
  return null
}

/** Set on every CI conformance leg (ci.yml codex-conformance: minimum, pinned
 *  or rc), each of which installs that Codex, puts its folder on PATH and
 *  proves `codex --version` there before the flag-drift step. */
export const CONFORMANCE_KIND_VAR = 'CCC_CODEX_CONFORMANCE_KIND'

/** Why the flag-drift suite must fail rather than skip with no codex found:
 *  on a conformance leg, which installed one, a skip would read as a green
 *  step over a failed install or look-up. Null where a skip is right (a
 *  developer machine, the unit legs: the variable is not set) or codex was
 *  found. */
export function noCodexFailure(found: string | null, env: Readonly<Record<string, string | undefined>>): string | null {
  if (found) return null
  const kind = (env[CONFORMANCE_KIND_VAR] ?? '').trim()
  if (kind === '') return null
  return `no codex was found on PATH on this ${kind} conformance leg (${CONFORMANCE_KIND_VAR} is set), which installs one first: the flag-drift suite must run here, not skip`
}
