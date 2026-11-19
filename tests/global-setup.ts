// Vitest global setup and teardown (#559): runs once in the main process, before
// and after the whole run. Setup gives the run a tag (tests/helpers/vitest-run-tag.mjs)
// that the workers put in the name of their temp folders, and records this process as
// the run's owner. The teardown is a backstop that removes the per-worker
// `ccc-vitest-<tag>-*` temp roots THIS run's killed worker left behind, and never
// another run's; its own owner record; any `ccc-vitest-*` folder that has not been
// touched for 24 hours AND whose run's owner is gone (a killed run's litter, so it
// cannot pile up, while a long watch run's folders stay); and a stray drive-root
// `\mock` from any hardcoded mock path, so a test run never leaves litter on the drive.
// In CI (or with CCC_TEMP_REPORT set) the teardown then prints one line naming the
// entries that appeared at the top of the temp folder while the run went on, besides
// its own folders (#332).
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import {
  RUN_TAG_ENV,
  isOwnerAlive,
  newRunTag,
  removeRunOwner,
  removeRunTempFolders,
  removeStaleTempFolders,
  writeRunOwner,
  type RunOwner,
} from './helpers/vitest-run-tag.mjs'

/**
 * The folders a stray `/mock` can land in. A drive-relative `/mock` resolves onto
 * whichever drive is current, so a suite run from C: scattered to C:\mock and one from
 * F: to F:\mock. Sweep the roots that can be hit: the cwd drive, the temp drive, and C:.
 */
function mockRoots(): string[] {
  return [
    ...new Set([process.cwd(), os.tmpdir(), 'C:\\'].map((p) => path.parse(path.resolve(p)).root)),
  ]
}

/**
 * What the teardown does once a run is over. A named export, not `setup` or `teardown`
 * (vitest reads those names), so a test can run it on a scratch folder.
 * @param tag this run's tag
 * @param tmp the folder that holds the `ccc-vitest-*` folders
 * @param roots the folders that may hold a stray `mock`
 * @param isAlive whether another run's owner is still there; a test fakes it
 */
export function sweepAfterRun(
  tag: string,
  tmp: string = os.tmpdir(),
  roots: string[] = mockRoots(),
  isAlive: (owner: RunOwner) => boolean = isOwnerAlive,
): void {
  removeRunTempFolders(tmp, tag)
  removeRunOwner(tmp, tag)
  removeStaleTempFolders(tmp, undefined, undefined, isAlive)
  for (const root of roots) {
    try {
      const mock = path.join(root, 'mock')
      if (fs.existsSync(mock)) fs.rmSync(mock, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

/** The names at the top of `dir`, or none when it cannot be read. */
function namesIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * The entries that appeared at the top of the machine temp folder while a run went on
 * (#332): the names there now that were not there when it started, other than its own
 * `ccc-vitest-<tag>-*` folders and owner record, and vitest's own folder for module
 * copies (`vitestTmp`, its project.tmpDir), which vitest removes as it closes, right
 * after this teardown. A name says nothing about who made the entry: another run or
 * program that started meanwhile adds to the list too (none does in a CI job). Names
 * only, sorted; nothing is read or removed.
 * @param tmp the machine temp folder
 * @param before the names in it when the run started
 * @param tag this run's tag
 * @param vitestTmp vitest's temp folder for this run, when known
 */
export function addedTempEntries(tmp: string, before: ReadonlySet<string>, tag: string, vitestTmp?: string): string[] {
  const own = [`ccc-vitest-${tag}-`, `ccc-vitest-owner-${tag}`]
  const vitests = vitestTmp && path.dirname(path.resolve(vitestTmp)) === path.resolve(tmp) ? path.basename(vitestTmp) : null
  return namesIn(tmp)
    .filter((name) => !before.has(name) && name !== vitests && !own.some((p) => name.startsWith(p)))
    .sort()
}

/** One line in a CI log (or with CCC_TEMP_REPORT set): the entries new in the temp folder since the run started. */
function reportTempEntries(tmp: string, before: ReadonlySet<string>, tag: string, vitestTmp?: string): void {
  if (!process.env.CI && !process.env.CCC_TEMP_REPORT) return
  const added = addedTempEntries(tmp, before, tag, vitestTmp)
  const shown = added.slice(0, 100).join(', ')
  const more = added.length > 100 ? `, and ${added.length - 100} more` : ''
  console.log(`[temp check] ${added.length} new entries at the top of ${tmp} since this run started${added.length ? `: ${shown}${more}` : ''}`)
}

/** @param project the project vitest hands a global setup (only its tmpDir is read) */
export default function (project?: { tmpDir?: string }) {
  // Before any worker starts, so the workers inherit it.
  const tag = newRunTag()
  process.env[RUN_TAG_ENV] = tag
  const tmp = os.tmpdir()
  const before = new Set(namesIn(tmp))
  // This process is the run's owner: another run's teardown keeps this run's folders
  // for as long as it is alive, however old they are (a watch run can last for days).
  writeRunOwner(tmp, tag)
  return () => {
    sweepAfterRun(tag)
    reportTempEntries(tmp, before, tag, project?.tmpDir)
  }
}
