// platform-config.json: the macOS and Linux stand-in for the Windows
// registry (registry.ts). A small JSON file under the home folder that holds
// where the app keeps its data and its resources, and a few other settings,
// each a name and a text value.
//
// It follows the rule github-config.json follows (github/github-config-store.ts):
//
//  - No file starts empty: the first write makes it. A file with nothing in
//    it holds no setting and is taken the same way.
//  - A file that is there but did not read is REFUSED and left byte for byte:
//    it could not be opened, it is not JSON, or it is not the shape this
//    version knows (anything but one JSON object whose values are all text).
//    A write then saves nothing and answers false. It used to start from an
//    empty set and save that over the file, so one change replaced every
//    saved setting with that one change.
//  - While the file does not read, a reader is answered from the values last
//    read or written in this run, when there are any: the settings in memory
//    are kept, not dropped for a file that may read again in a moment.
//  - A write stages a copy beside the file and renames it over it
//    (atomic-write.ts), so a write that fails part way leaves the old file
//    whole. It used to write over the file in place. The staged copy is
//    created with the permission mode the file has, so a file its user made
//    readable by its owner alone stays so.
//
// THE FILE'S SHAPE IS FIXED: one JSON object whose values are all text, and
// nothing else, for good. It has no version field, so this is the whole
// contract between versions of the app. A file of any other shape is one
// this version does not know: it is refused for reads as well as writes and
// left byte for byte, as github-config.json is when its schema version is
// not this build's. So a later version must never write anything but a text
// value here (no number, no true or false, no list, no nested object): an
// older build that then reads the file would read no data folder from it,
// start on the default one and show first-run setup, and could save nothing
// until the file is repaired or removed. A setting that needs another shape
// goes in a file of its own, or is written here as text.
//
// Synchronous, as its callers are (data-paths.ts reads it at start-up).
// Never used on Windows.
import { homedir } from 'os'
import { join } from 'path'
import { lstatSync, mkdirSync, readFileSync, statSync } from 'fs'
import { atomicWriteFileSync } from './atomic-write'
import { logWarn } from './debug-logger'
import { failureKind } from './failure-kind'

const FILENAME = 'platform-config.json'

// The same rule as the data directory: a fresh install writes under the
// current brand, an install that already has a config file keeps using it
// (moving it would strand the pointer to the user's data directory).
const BRAND_DIR = join(homedir(), '.ai-code-conductor')
const LEGACY_DIRS = [join(homedir(), '.claude-conductor')]

/** A text with nothing in it: no characters, or only a byte-order mark, white
 *  space and NUL characters (`\s` covers the byte-order mark). */
const NOTHING_IN_IT = /^[\s\0]*$/

/** The settings a file holds, by name. No prototype, so a name such as
 *  `constructor` is a setting the file does not have, never an inherited
 *  property. */
type Values = Record<string, string>

type Loaded =
  /** The file read: its values, and where it is. */
  | { state: 'read'; dir: string; file: string; values: Values }
  /** No file (or one with nothing in it): a write starts empty, at `file`. */
  | { state: 'none'; dir: string; file: string }
  /** A file is there and did not read. Nothing is saved over it. */
  | { state: 'unreadable' }

/** The values last read from the file or written to it in this run, kept for
 *  readers while the file does not read. Null when the last look found no
 *  file, or before any look. */
let lastGood: Values | null = null
/** The kinds of failure logged since the file last read (warnOnce). */
const warned = new Set<string>()

// What the log says about a read or a write that failed is the kind of
// failure (failure-kind.ts), never the error's own text: a JSON error quotes
// the characters around the place the parse stopped, and a file error
// carries the full path, which is under the home folder.

/** One log line per kind of failure until the file reads again: a file that
 *  stays unreadable is read at every lookup, and the first line of a kind
 *  says all the later ones would. */
function warnOnce(kind: string): void {
  if (warned.has(kind)) return
  warned.add(kind)
  logWarn(`[platform-config] ${FILENAME} is there but did not read (${kind}). It is left as it is, and nothing is saved over it until it reads again.`)
}

/** A look gave an answer (the values, or "no file"): the next failure of any
 *  kind is logged again. */
function didRead<T extends Loaded>(answer: T): T {
  warned.clear()
  lastGood = answer.state === 'read' ? answer.values : null
  return answer
}

function didNotRead(kind: string): Loaded {
  warnOnce(kind)
  return { state: 'unreadable' }
}

/** "No such file": the file is not there, or a step of its path is not a
 *  folder (so no file can be there). */
function saysNotThere(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Whether there is no file, asked once more after a read said so. One "no
 *  such file" answer is not taken as proof (a file being replaced, or held
 *  by another program, can answer that for a moment): only a second one is
 *  "no file". A file that is there after all, or a path that cannot be
 *  looked at, is a read that failed. */
function reallyMissing(file: string): boolean {
  try {
    lstatSync(file)
    return false
  } catch (err) {
    return saysNotThere(err)
  }
}

/** Whether the file has nothing in it, asked once more after a read gave
 *  `first`: only the same nothing a second time is "nothing in it". */
function reallyEmpty(file: string, first: string): boolean {
  try {
    return readFileSync(file, 'utf-8') === first
  } catch {
    return false
  }
}

/** The values a file's text holds, or the kind of fault that makes it a
 *  file this version does not read. A byte-order mark an editor put before
 *  the text is passed over. */
function parseValues(raw: string): { values: Values } | { fault: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
  } catch {
    return { fault: 'not valid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { fault: 'not one JSON object' }
  }
  const values: Values = Object.create(null)
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') return { fault: 'a value that is not text' }
    values[name] = value
  }
  return { values }
}

/**
 * The one look at the file, which every read and write goes through. The
 * current brand's file first, then each legacy location: the first one that
 * is there is the file in use, as before. A file that is there and did not
 * read ends the look: a later location is not read in its place, and no new
 * file is started beside it.
 */
function load(): Loaded {
  for (const dir of [BRAND_DIR, ...LEGACY_DIRS]) {
    const file = join(dir, FILENAME)
    let raw: string
    try {
      raw = readFileSync(file, 'utf-8')
    } catch (err) {
      if (!saysNotThere(err)) return didNotRead(failureKind(err))
      if (reallyMissing(file)) continue
      return didNotRead('the file was reported missing, and a second look did not confirm it')
    }
    if (NOTHING_IN_IT.test(raw)) {
      if (reallyEmpty(file, raw)) return didRead({ state: 'none', dir, file })
      return didNotRead('the file read as empty, and a second look did not confirm it')
    }
    const parsed = parseValues(raw)
    if ('fault' in parsed) return didNotRead(parsed.fault)
    return didRead({ state: 'read', dir, file, values: parsed.values })
  }
  return didRead({ state: 'none', dir: BRAND_DIR, file: join(BRAND_DIR, FILENAME) })
}

/** One setting, or null when the file does not have it. While the file is
 *  there but does not read: the value last read or written in this run, or
 *  null when there is none. */
export function readPlatformConfigValue(name: string): string | null {
  const got = load()
  const values = got.state === 'read' ? got.values : got.state === 'none' ? null : lastGood
  const value = values?.[name]
  return typeof value === 'string' ? value : null
}

/** The permission mode of the file as it is now (the file a link at its
 *  path leads to), or undefined when there is no file to ask. */
function modeOf(file: string): number | undefined {
  try {
    return statSync(file).mode & 0o777
  } catch {
    return undefined
  }
}

/** Save one setting beside the ones the file already holds. True only once
 *  the file is written. False, with the file left as it was, when the file
 *  is there but did not read, when its folder could not be made, or when
 *  the write failed (a read-only or full home folder).
 *
 *  The staged copy is created with the mode the file has, so the file that
 *  replaces it is no more widely readable than it was (a mode is honoured
 *  when a file is created, and the process's own mask still applies, as for
 *  any new file). The first write of a new file names no mode. */
export function writePlatformConfigValue(name: string, value: string): boolean {
  if (typeof name !== 'string' || typeof value !== 'string') return false
  const got = load()
  if (got.state === 'unreadable') return false
  const next: Values = Object.assign(Object.create(null), got.state === 'read' ? got.values : null)
  next[name] = value
  try {
    mkdirSync(got.dir, { recursive: true })
    const mode = modeOf(got.file)
    atomicWriteFileSync(got.file, JSON.stringify(next, null, 2), mode === undefined ? undefined : { mode })
  } catch (err) {
    // By the kind of failure: the error's own text carries the full path.
    logWarn(`[platform-config] ${FILENAME} could not be saved (${failureKind(err)})`)
    return false
  }
  lastGood = next
  return true
}

/** Whether the file is there now and does not read, so nothing can be saved
 *  until it is repaired or removed. For a caller that has to say why a save
 *  was refused (the folder step of first-run setup). */
export function platformConfigUnreadable(): boolean {
  return load().state === 'unreadable'
}
