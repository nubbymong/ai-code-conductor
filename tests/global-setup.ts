// Vitest global setup and teardown (#559): runs once in the main process, before
// and after the whole run. Setup gives the run a tag (tests/helpers/vitest-run-tag.mjs)
// that the workers put in the name of their temp folders, and records this process as
// the run's owner. The teardown is a backstop that removes the per-worker
// `ccc-vitest-<tag>-*` temp roots THIS run's killed worker left behind, and never
// another run's; its own owner record; any `ccc-vitest-*` folder that has not been
// touched for 24 hours AND whose run's owner is gone (a killed run's litter, so it
// cannot pile up, while a long watch run's folders stay); and a stray drive-root
// `\mock` from any hardcoded mock path, so a test run never leaves litter on the drive.
// In CI (or with CCC_TEMP_REPORT set) setup reads the names at the top of the temp
// folder, and the teardown then prints one line naming the entries that appeared there
// while the run went on, besides its own folders, with how many names were there at the
// start and how many now, or that the folder could not be read (#332). The line prints
// after the cleanup, so it also names each of this run's own entries still there, with
// what the cleanup did to it and a few paths inside it. Vitest stops its last workers
// only after this teardown, so one more line, when the main process exits, names this
// run's own entries still there then. A local run does not read the temp folder for it.
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import {
  RUN_TAG_ENV,
  isOwnerAlive,
  isRunTag,
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

/** What the cleanup did with this run's own entries: the names it removed, and the ones it could not, with the error code. */
export interface SweepResult {
  removed: string[]
  failed: Map<string, string>
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
): SweepResult {
  const failed = new Map<string, string>()
  const onError = (name: string, err: unknown): void => {
    failed.set(name, String((err as { code?: unknown } | null)?.code ?? 'error'))
  }
  const removed = removeRunTempFolders(tmp, tag, onError)
  const owner = `ccc-vitest-owner-${tag}.json`
  removeRunOwner(tmp, tag, onError)
  if (isRunTag(tag) && !failed.has(owner)) removed.push(owner)
  removeStaleTempFolders(tmp, undefined, undefined, isAlive)
  for (const root of roots) {
    try {
      const mock = path.join(root, 'mock')
      if (fs.existsSync(mock)) fs.rmSync(mock, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  return { removed, failed }
}

/** The names at the top of `dir`, or null when it cannot be read. */
function readNames(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir)
  } catch {
    return null
  }
}

/** Whether `name` is one of this run's own: a `ccc-vitest-<tag>-*` folder or its owner record. */
function isOwnName(name: string, tag: string): boolean {
  return name.startsWith(`ccc-vitest-${tag}-`) || name.startsWith(`ccc-vitest-owner-${tag}`)
}

/**
 * The names in `names` (read from `tmp`) that are not in `before`, other than this run's
 * own and vitest's own folder for module copies (`vitestTmp`, its project.tmpDir, which
 * vitest removes as it closes, right after this teardown); sorted. A name says nothing
 * about who made the entry: another run or program that started meanwhile adds to the
 * list too (none does in a CI job).
 */
function newNames(tmp: string, names: string[], before: ReadonlySet<string>, tag: string, vitestTmp?: string): string[] {
  const vitests = vitestTmp && path.dirname(path.resolve(vitestTmp)) === path.resolve(tmp) ? path.basename(vitestTmp) : null
  return names.filter((name) => !before.has(name) && name !== vitests && !isOwnName(name, tag)).sort()
}

/** Up to `limit` paths inside `dir`, depth first and sorted, for the line; none for a file or a folder that cannot be read. */
function heldPaths(dir: string, limit = 5): string[] {
  const out: string[] = []
  const walk = (rel: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (out.length >= limit) return
      const p = rel ? `${rel}/${e.name}` : e.name
      const had = out.length
      if (e.isDirectory() && depth < 3) walk(p, depth + 1)
      if (out.length === had) out.push(e.isDirectory() ? `${p}/` : p)
    }
  }
  walk('', 0)
  return out
}

/**
 * This run's own entries at the top of `tmp` (`names`) that were not there at the start,
 * each with what the cleanup did to it (when `sweep` is given) and a few paths inside it.
 */
function ownLeftovers(tmp: string, names: string[], before: ReadonlySet<string>, tag: string, sweep?: SweepResult): string[] {
  return names
    .filter((name) => !before.has(name) && isOwnName(name, tag))
    .sort()
    .map((name) => {
      const notes: string[] = []
      if (sweep) {
        const code = sweep.failed.get(name)
        notes.push(code ? `removal failed: ${code}` : sweep.removed.includes(name) ? 'removed, then made again' : 'made after the cleanup read the folder')
      }
      const held = heldPaths(path.join(tmp, name))
      if (held.length) notes.push(`holds ${held.join(', ')}`)
      return notes.length ? `${name} (${notes.join('; ')})` : name
    })
}

/** "; N of this run's own still there <when>: ..." or nothing. */
function ownPart(left: string[], when: string): string {
  return left.length ? `; ${left.length} of this run's own still there ${when}: ${left.join(', ')}` : ''
}

/**
 * The names at the top of the machine temp folder when a run starts, for the teardown's
 * line (#332). Read only in CI or with CCC_TEMP_REPORT set: a local run does not read
 * the temp folder for a line it never prints. Undefined when the run does not report,
 * null when the folder cannot be read.
 * @param tmp the machine temp folder
 * @param env the environment that decides it; a test passes its own
 */
export function tempNamesAtStart(tmp: string, env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> | null | undefined {
  if (!env.CI && !env.CCC_TEMP_REPORT) return undefined
  const names = readNames(tmp)
  return names === null ? null : new Set(names)
}

/**
 * The teardown's one line (#332): the entries new at the top of the machine temp folder
 * since the run started, other than this run's own and vitest's folder, with how many
 * names were there at the start and how many now, so an empty listing cannot pass for a
 * clean run. The line prints after the cleanup, so any of this run's own entries still
 * there is a leftover the cleanup missed: each is named, with what the cleanup did to it
 * and a few paths inside it. A folder that could not be read at either end is said so,
 * and nothing is compared.
 * @param tmp the machine temp folder
 * @param before the names in it when the run started, or null when they could not be read
 * @param tag this run's tag
 * @param vitestTmp vitest's temp folder for this run, when known
 * @param sweep what the cleanup did, when known
 */
export function tempReportLine(
  tmp: string,
  before: ReadonlySet<string> | null,
  tag: string,
  vitestTmp?: string,
  sweep?: SweepResult,
): string {
  const now = readNames(tmp)
  if (before === null || now === null) {
    return `[temp check] ${tmp} could not be read ${before === null ? 'when this run started' : 'at the end of this run'}, so nothing was compared`
  }
  const added = newNames(tmp, now, before, tag, vitestTmp)
  const shown = added.slice(0, 100).join(', ')
  const more = added.length > 100 ? `, and ${added.length - 100} more` : ''
  const counted = `${added.length} new ${added.length === 1 ? 'entry' : 'entries'}`
  const own = ownPart(ownLeftovers(tmp, now, before, tag, sweep), 'after the cleanup')
  return `[temp check] ${counted} at the top of ${tmp} since this run started (${before.size} there at the start, ${now.length} now)${added.length ? `: ${shown}${more}` : ''}${own}`
}

/**
 * The line for when the run's main process exits (#332), after vitest has stopped every
 * worker: how many of this run's own entries are still at the top of `tmp`, each named
 * as in tempReportLine.
 */
export function tempExitLine(tmp: string, before: ReadonlySet<string> | null, tag: string, sweep?: SweepResult): string {
  const now = readNames(tmp)
  if (before === null || now === null) return `[temp check] ${tmp} could not be read when this run's process exited`
  const left = ownLeftovers(tmp, now, before, tag, sweep)
  return `[temp check] when this run's process exited: ${left.length ? ownPart(left, 'then').slice(2) : "none of this run's own still there"}`
}

/** @param project the project vitest hands a global setup (only its tmpDir is read) */
export default function (project?: { tmpDir?: string }) {
  // Before any worker starts, so the workers inherit it.
  const tag = newRunTag()
  process.env[RUN_TAG_ENV] = tag
  const tmp = os.tmpdir()
  // Before this run writes anything there; undefined (nothing read) unless the run reports.
  const before = tempNamesAtStart(tmp)
  // This process is the run's owner: another run's teardown keeps this run's folders
  // for as long as it is alive, however old they are (a watch run can last for days).
  writeRunOwner(tmp, tag)
  return () => {
    const sweep = sweepAfterRun(tag)
    if (before === undefined) return
    console.log(tempReportLine(tmp, before, tag, project?.tmpDir, sweep))
    // Vitest awaits its last workers' exits only after this teardown (pool.close in
    // Vitest.close), so look once more when this process exits. A synchronous write: an
    // exit listener cannot wait for a stream.
    process.once('exit', () => {
      try {
        fs.writeSync(1, `${tempExitLine(tmp, before, tag, sweep)}\n`)
      } catch {
        /* stdout closed */
      }
    })
  }
}
