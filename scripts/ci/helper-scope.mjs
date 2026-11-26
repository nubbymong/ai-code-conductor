#!/usr/bin/env node
// The Helper (os) job, and from 2.1.3-beta.19 the arm64 Helper job
// (ci.yml helper-linux-arm64), build and test the Rust session helper (helper/),
// and only when a change touches it. Like the Test jobs (scripts/ci/change-scope.mjs)
// each decides INSIDE the job: the job always starts, on all its runners, runs
// this right after checkout, and every later step is skipped by a step-level
// `if` on the `helper` output. A job-level path filter is never used, so the
// job always reports under its own name and can never leave a check waiting.
//
// What counts as "touches the helper":
//   - anything under helper/ (the code, the fixtures, the probes, the lock file)
//   - the workflow that runs the job (.github/workflows/ci.yml)
//   - this script
//   - the import check the job's Windows leg runs on the built helper
//     (scripts/check-pe-imports.mjs), so a change to it meets a real program
//
// Anything this cannot read for certain (not a pull request, not a merge
// commit, git failing, an empty list) answers helper=true: the job builds.
//
//   node scripts/ci/helper-scope.mjs      # env: GITHUB_EVENT_NAME, GITHUB_OUTPUT

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { changedPaths } from './change-scope.mjs'

/** The paths that make the helper job build. */
export const HELPER_PATHS = [/^helper\//, /^\.github\/workflows\/ci\.yml$/, /^scripts\/ci\/helper-scope\.mjs$/, /^scripts\/check-pe-imports\.mjs$/]

export function touchesHelper(p) {
  return typeof p === 'string' && p.length > 0 && HELPER_PATHS.some((re) => re.test(p))
}

/**
 * @param {{ eventName: string, paths: string[]|null }} input
 * @returns {{ helper: boolean, reason: string }}
 */
export function decideHelper({ eventName, paths }) {
  if (eventName !== 'pull_request') return { helper: true, reason: `a ${eventName || '(unknown)'} run always builds the helper` }
  if (paths === null) return { helper: true, reason: 'the changed paths could not be read' }
  if (paths.length === 0) return { helper: true, reason: 'no changed path was listed' }
  const hit = paths.find(touchesHelper)
  if (hit !== undefined) return { helper: true, reason: `${paths.filter(touchesHelper).length} changed path(s) in the helper or its job, first: ${hit}` }
  return { helper: false, reason: `no helper path changed (${paths.length} path(s) checked)` }
}

const defaultRunGit = (args) => execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })

export function main(env = process.env, io = {}) {
  const log = io.log || ((s) => console.log(s))
  const write = io.write || ((file, text) => appendFileSync(file, text))
  let decision
  try {
    const eventName = env.GITHUB_EVENT_NAME || ''
    // git is asked only where its answer can change the outcome.
    const paths = eventName === 'pull_request' ? changedPaths(io.runGit || defaultRunGit) : null
    decision = decideHelper({ eventName, paths })
  } catch (err) {
    decision = { helper: true, reason: `could not decide (${err && err.message ? err.message : err})` }
  }
  log(`helper=${decision.helper}: ${decision.reason}`)
  // ci.yml skips the steps only on the literal 'false': an output that was never
  // written builds the helper, and a write that throws fails the step and so the job.
  if (env.GITHUB_OUTPUT) write(env.GITHUB_OUTPUT, `helper=${decision.helper ? 'true' : 'false'}\n`)
  return 0
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) process.exitCode = main()
