#!/usr/bin/env node
// The Desktop test gate's decision (ADR-028, rule 9; #309). Desktop testing is
// at RELEASE level on beta and PRE-RELEASE on stable, not per PR:
//   - a PR into any base but `main` passes with no label, and says that
//     desktop testing happens on the released beta build;
//   - a PR into `main` (the stable promotion, release/vX.Y.Z -> main) must
//     carry `desktop-tested`, `runtime-validated` or `skip-desktop-test`.
//
// ci.yml's `desktop-gate` job runs this on every pull_request event. It reads
// the pull request AS IT IS NOW from GitHub, and takes nothing from the event
// the run was started with except the PR's number. That is deliberate: a run
// started again by hand ("Re-run all jobs") replays its first event, so a run
// that began while the PR was into `beta`, or still carried `desktop-tested`,
// would otherwise report green again after the PR was retargeted to `main` or
// lost the label, and sit as the newest check on the commit.
//
// A pull request that cannot be read decides nothing: the check fails and says
// so (exit 1). It is never treated as "not main".
//
// Zero dependencies (plain node, global fetch), like scripts/release-gate.mjs,
// whose API helper it shares.
//
//   node scripts/ci/desktop-gate.mjs                        # in ci.yml (env below)
//   node scripts/ci/desktop-gate.mjs --repo owner/name --pr 123
//
// Env: GITHUB_REPOSITORY, PR_NUMBER, GITHUB_TOKEN or GH_TOKEN (pull-requests:
// read is enough).

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { githubGet } from '../release-gate.mjs'

/** The base branch whose PRs are the stable promotion. */
export const STABLE_BASE = 'main'
/** The labels that open the gate on a PR into main, in the order they are named. */
export const GATE_LABELS = ['desktop-tested', 'runtime-validated', 'skip-desktop-test']
/** How many times the pull request is read before the check gives up. */
export const READ_ATTEMPTS = 3
const RETRY_WAIT_MS = 2000

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/
const PR_RE = /^[1-9][0-9]*$/

const OPENED_BY = {
  'desktop-tested': 'a human exercised the packaged app on a real desktop',
  'runtime-validated': 'automated runtime validation passed (VM Playwright e2e and/or the live SSH statusline matrix)',
  'skip-desktop-test': 'no runtime test required (docs/deps/CI/changelog-only)',
}

/** The line for a check that could not decide. */
export function unreadMessage(number, why) {
  return `::error::Desktop test gate: could not read pull request #${number} as it is now (${why}). Nothing was decided; re-run this job.`
}

/**
 * The decision, from a pull request as GitHub serves it
 * (GET /repos/{repo}/pulls/{number}). Never throws.
 *
 * @param {any} pull
 * @param {number} number the pull request that was asked for
 * @returns {{ pass: boolean, message: string }}
 */
export function decideGate(pull, number) {
  const unread = (why) => ({ pass: false, message: unreadMessage(number, why) })
  if (!pull || typeof pull !== 'object' || Array.isArray(pull)) return unread('GitHub returned no pull request')
  if (!Number.isInteger(number) || pull.number !== number) return unread('GitHub answered with another pull request')
  const base = pull.base && typeof pull.base === 'object' ? pull.base.ref : null
  if (typeof base !== 'string' || base.trim() === '') return unread('no base branch in the answer')
  if (!Array.isArray(pull.labels) || !pull.labels.every((l) => l && typeof l === 'object' && typeof l.name === 'string')) return unread('no label list in the answer')

  // Not exact on purpose: a base that differs from `main` only in case is
  // asked for the label too, as the workflow expression this replaces did.
  if (base.toLowerCase() !== STABLE_BASE) {
    return { pass: true, message: `This PR targets '${base}', not ${STABLE_BASE}. Desktop testing happens on the released beta build, not per PR, and no label is needed. Gate open.` }
  }
  // A label name has no case on GitHub.
  const names = pull.labels.map((l) => l.name.toLowerCase())
  const has = GATE_LABELS.find((l) => names.includes(l))
  if (has) return { pass: true, message: `PR into ${STABLE_BASE} carries '${has}' - ${OPENED_BY[has]}. Gate open.` }
  return { pass: false, message: `::error::Desktop test gate: a PR into ${STABLE_BASE} (the stable promotion) must carry 'desktop-tested' (a human launched and exercised the packaged app), 'runtime-validated' (automated VM e2e and/or the live SSH statusline matrix passed), or 'skip-desktop-test' (docs/deps/CI/changelog-only) before it can merge. See CONTRIBUTING.md > Desktop-test gate.` }
}

/**
 * The pull request as it is now. A failed read is tried again, READ_ATTEMPTS
 * reads in all; the last error is thrown.
 *
 * @param {{ repo: string, number: number, get: (pathAndQuery: string) => Promise<any>, sleep?: (ms: number) => Promise<void> }} input
 */
export async function readPull({ repo, number, get, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let last
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    try {
      return await get(`/repos/${repo}/pulls/${number}`)
    } catch (err) {
      last = err
      if (attempt < READ_ATTEMPTS) await sleep(RETRY_WAIT_MS)
    }
  }
  throw last
}

function argValue(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}

/** The step: 0 when the gate is open, 1 when it is closed or could not be decided. */
export async function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  let decision
  const asked = argValue(argv, '--pr') || env.PR_NUMBER || ''
  try {
    const repo = argValue(argv, '--repo') || env.GITHUB_REPOSITORY || ''
    if (!REPO_RE.test(repo)) decision = { pass: false, message: unreadMessage(asked || '?', 'no repository name') }
    else if (!PR_RE.test(asked)) decision = { pass: false, message: unreadMessage(asked || '?', 'no pull request number') }
    else {
      const number = Number(asked)
      const token = env.GH_TOKEN || env.GITHUB_TOKEN || null
      const get = io.get || ((p) => githubGet(p, { token, fetchImpl: io.fetchImpl || globalThis.fetch }))
      decision = decideGate(await readPull({ repo, number, get, sleep: io.sleep }), number)
    }
  } catch (err) {
    decision = { pass: false, message: unreadMessage(asked || '?', err && err.message ? err.message : String(err)) }
  }
  // A line that cannot be printed does not open the gate.
  try { (io.log || ((s) => console.log(s)))(decision.message) } catch { return 1 }
  return decision.pass ? 0 : 1
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  // exitCode, not process.exit(): see scripts/release-gate.mjs. A crash is a closed gate.
  main().then((code) => { process.exitCode = code === 0 ? 0 : 1 }, () => { process.exitCode = 1 })
}
