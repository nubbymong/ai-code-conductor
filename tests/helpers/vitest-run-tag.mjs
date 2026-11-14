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
      fs.rmSync(path.join(tmp, name), { recursive: true, force: true })
      removed.push(name)
    } catch {
      /* best effort */
    }
  }
  return removed
}
