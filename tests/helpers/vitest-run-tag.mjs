// One tag per vitest run, so a run removes only the temp folders it made.
//
// tests/global-setup.ts makes the tag when a run starts and puts it in the
// environment, which the test workers inherit. Every temp folder the harness makes
// straight under the machine temp folder is named `ccc-vitest-<tag>-...`: the
// per-worker root (tests/helpers/test-tmp.ts) and the isolated home
// (tests/helpers/home-guard-core.mjs). When the run ends, its teardown removes the
// folders that carry its own tag and leaves the rest, which belong to another run
// going on at the same time (two agents, or a watch run beside a full run).
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const RUN_TAG_ENV = 'CCC_VITEST_RUN_TAG'

// A folder that cannot be removed straight away (a virus scanner or indexer holding a
// file in it on Windows) is retried a few times before it is given up on.
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }

// A `ccc-vitest-*` folder this old is litter unless its run's owner is still alive.
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

// Eight lower-case hex digits: fixed length, so no tag is the start of another, and
// nothing that could be read as a path.
const RUN_TAG_RE = /^[0-9a-f]{8}$/

/** A new tag for a run. */
export function newRunTag() {
  return crypto.randomBytes(4).toString('hex')
}

/** @param {unknown} value */
export function isRunTag(value) {
  return typeof value === 'string' && RUN_TAG_RE.test(value)
}

/**
 * The start of the name of a folder this run makes straight under the machine temp
 * folder. `kind` is an optional word after the tag, such as 'home-'. A process that
 * did not start under global setup has no tag and gets the plain `ccc-vitest-` name,
 * which no teardown removes.
 * @param {string} [kind]
 * @param {Record<string, string | undefined>} [env]
 */
export function runTempPrefix(kind = '', env = process.env) {
  const tag = env[RUN_TAG_ENV]
  return isRunTag(tag) ? `ccc-vitest-${tag}-${kind}` : `ccc-vitest-${kind}`
}

/**
 * Remove the folders in `tmp` that carry this run's tag, and nothing else. Without a
 * well-formed tag it removes nothing: it never falls back to every `ccc-vitest-*`.
 * @param {string} tmp
 * @param {string} tag
 * @returns {string[]} the names removed
 */
export function removeRunTempFolders(tmp, tag) {
  /** @type {string[]} */
  const removed = []
  if (!isRunTag(tag)) return removed
  const prefix = `ccc-vitest-${tag}-`
  let names
  try {
    names = fs.readdirSync(tmp)
  } catch {
    return removed
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    try {
      fs.rmSync(path.join(tmp, name), RM_OPTIONS)
      removed.push(name)
    } catch {
      /* best effort */
    }
  }
  return removed
}

// The process that owns a run, so a sweep can tell a run that is still going on from
// one that was killed. A watch run can stay up for days, and a write inside a folder
// that already exists does not move the modified time of the folder above it, so age
// alone cannot say a run is over. Global setup writes one small file per tag straight
// under the machine temp folder (`ccc-vitest-owner-<tag>.json`: the pid of the vitest
// main process and the time it started) and the run's own teardown removes it. Both
// the temp roots and the isolated homes carry the tag, so one record covers them all.
const OWNER_PREFIX = 'ccc-vitest-owner-'
const OWNER_NAME_RE = /^ccc-vitest-owner-([0-9a-f]{8})\.json$/
const FOLDER_TAG_RE = /^ccc-vitest-([0-9a-f]{8})-/
const OWNER_MAX_BYTES = 1024

/**
 * @typedef {object} RunOwner
 * @property {number} pid the vitest main process of the run
 * @property {number} startedAt when that run started, in ms since the epoch
 */

/** @param {string} tmp @param {string} tag */
function ownerPath(tmp, tag) {
  return path.join(tmp, `${OWNER_PREFIX}${tag}.json`)
}

/**
 * Record who owns the run `tag`. Best effort: with no record the run's folders fall
 * back to the plain 24-hour rule.
 * @param {string} tmp
 * @param {string} tag
 * @param {RunOwner} [owner] defaults to this process, started now
 * @returns {boolean} whether the record was written
 */
export function writeRunOwner(tmp, tag, owner = { pid: process.pid, startedAt: Date.now() }) {
  if (!isRunTag(tag)) return false
  try {
    // 'wx': never write through a file or link that is already there.
    fs.writeFileSync(ownerPath(tmp, tag), JSON.stringify({ pid: owner.pid, startedAt: owner.startedAt }), {
      flag: 'wx',
    })
    return true
  } catch {
    return false
  }
}

/**
 * The record of the run `tag`, or null when there is none or it cannot be trusted: not
 * a plain file, too big, not JSON, or a pid that is not a positive whole number (0 and
 * negative pids mean a process group to the liveness probe, never one process).
 * @param {string} tmp
 * @param {string} tag
 * @returns {RunOwner | null}
 */
export function readRunOwner(tmp, tag) {
  if (!isRunTag(tag)) return null
  try {
    const file = ownerPath(tmp, tag)
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.size > OWNER_MAX_BYTES) return null
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!data || !Number.isSafeInteger(data.pid) || data.pid <= 0) return null
    if (typeof data.startedAt !== 'number' || !Number.isFinite(data.startedAt)) return null
    return { pid: data.pid, startedAt: data.startedAt }
  } catch {
    return null
  }
}

/** Remove the record of the run `tag`. @param {string} tmp @param {string} tag */
export function removeRunOwner(tmp, tag) {
  if (!isRunTag(tag)) return
  try {
    fs.rmSync(ownerPath(tmp, tag), RM_OPTIONS)
  } catch {
    /* best effort */
  }
}

/**
 * Whether the process in `owner` is still there. Signal 0 only asks the operating
 * system whether the pid exists; it sends nothing. ESRCH means it is gone. EPERM means
 * it exists but belongs to someone else, which is alive. Anything else is taken as
 * alive too, because wrongly keeping a folder costs disk and wrongly removing one
 * breaks a run. A pid that was handed to another program since the run died looks
 * alive until that program ends; the next sweep then takes the folder.
 * @param {RunOwner} owner
 * @returns {boolean}
 */
export function isOwnerAlive(owner) {
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (err) {
    return !(err && /** @type {{ code?: string }} */ (err).code === 'ESRCH')
  }
}

/**
 * Remove the `ccc-vitest-*` folders in `tmp` that were last modified more than
 * `maxAgeMs` ago and whose run is over. A run's own teardown removes only its own
 * folders, so a folder left by a run that was killed would otherwise stay for good;
 * this bounds that litter. A young folder is never touched. An old folder is kept
 * while its run's owner (see `writeRunOwner`) is still alive, because a long watch run
 * can outlive 24 hours without the root folder's modified time moving. An old folder
 * with no owner record (made before owner records, by a config that has no global
 * setup, or whose record was lost) keeps the plain age rule. Only real folders: a link
 * or a file with such a name is left alone. Owner records of runs that are over and
 * older than `maxAgeMs` are removed too.
 * @param {string} tmp
 * @param {number} [maxAgeMs]
 * @param {number} [now]
 * @param {(owner: RunOwner) => boolean} [isAlive] the liveness check; a test fakes it
 * @returns {string[]} the names removed (folders only)
 */
export function removeStaleTempFolders(tmp, maxAgeMs = STALE_AFTER_MS, now = Date.now(), isAlive = isOwnerAlive) {
  /** @type {string[]} */
  const removed = []
  let names
  try {
    names = fs.readdirSync(tmp)
  } catch {
    return removed
  }
  /** @type {Map<string, boolean>} */
  const ownerAlive = new Map()
  /** @param {string} tag */
  const ownedByLiveRun = (tag) => {
    let alive = ownerAlive.get(tag)
    if (alive === undefined) {
      const owner = readRunOwner(tmp, tag)
      try {
        alive = owner !== null && isAlive(owner)
      } catch {
        alive = true // a check that fails cannot say the run is over: keep the folder
      }
      ownerAlive.set(tag, alive)
    }
    return alive
  }
  for (const name of names) {
    if (!name.startsWith('ccc-vitest-')) continue
    const full = path.join(tmp, name)
    try {
      const st = fs.lstatSync(full)
      if (!st.isDirectory() || now - st.mtimeMs <= maxAgeMs) continue
      const tag = FOLDER_TAG_RE.exec(name)?.[1]
      if (tag && ownedByLiveRun(tag)) continue
      fs.rmSync(full, RM_OPTIONS)
      removed.push(name)
    } catch {
      /* best effort */
    }
  }
  for (const name of names) {
    const tag = OWNER_NAME_RE.exec(name)?.[1]
    if (!tag) continue
    try {
      const st = fs.lstatSync(path.join(tmp, name))
      if (!st.isFile() || now - st.mtimeMs <= maxAgeMs || ownedByLiveRun(tag)) continue
      removeRunOwner(tmp, tag)
    } catch {
      /* best effort */
    }
  }
  return removed
}
