#!/usr/bin/env node
// CI runs only what a change touches (ADR-028, rule 6): the safe minimum.
// A pull request that changes ONLY documentation skips the suite on Windows
// and macOS. ci.yml's Test jobs run this right after checkout and gate every
// later step on its `suite` output, so the job still starts, still ends green
// and still reports under its own name: `Test (windows-2025)` and
// `Test (macos-latest)` are required checks, and a job skipped as a whole
// never reports them.
//
// The Linux job always runs the whole suite: some tests read the Markdown they
// guard (AGENTS.md, the docs under docs/wp1/), so a docs-only change still gets
// one full run, on the fastest runner.
//
// Anything this cannot read for certain (not a pull request, not a merge
// commit, git failing, an empty list) answers suite=true: the suite runs.
//
//   node scripts/ci/change-scope.mjs      # env: GITHUB_EVENT_NAME, RUNNER_OS, GITHUB_OUTPUT

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Documentation: Markdown anywhere, and the documentation trees. */
export const DOCS_ONLY = [/\.md$/, /^docs\//, /^CONTEXT\.d\//, /^architecture\//]
/** The runner that keeps the whole suite on a docs-only change. */
export const ALWAYS_FULL_OS = 'Linux'

export function isDocsPath(p) {
  return typeof p === 'string' && p.length > 0 && DOCS_ONLY.some((re) => re.test(p))
}

/** True only for a non-empty list of documentation paths. */
export function isDocsOnly(paths) {
  return Array.isArray(paths) && paths.length > 0 && paths.every(isDocsPath)
}

/**
 * The paths a pull request changes: the difference between its base (the merge
 * commit's first parent) and the merge commit CI checked out. Null when HEAD
 * is not a two-parent merge commit or git cannot answer.
 *
 * @param {(args: string[]) => string} runGit
 * @returns {string[]|null}
 */
export function changedPaths(runGit) {
  try {
    const parents = String(runGit(['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(/\s+/)
    if (parents.length !== 3) return null
    const out = String(runGit(['diff', '--name-only', '--no-renames', '-z', parents[1], parents[0]]))
    return out.split('\0').filter((p) => p !== '')
  } catch {
    return null
  }
}

/**
 * @param {{ eventName: string, runnerOs: string, paths: string[]|null }} input
 * @returns {{ suite: boolean, reason: string }}
 */
export function decideScope({ eventName, runnerOs, paths }) {
  if (eventName !== 'pull_request') return { suite: true, reason: `a ${eventName || '(unknown)'} run always runs the suite` }
  if (runnerOs === ALWAYS_FULL_OS) return { suite: true, reason: `${ALWAYS_FULL_OS} always runs the suite` }
  if (paths === null) return { suite: true, reason: 'the changed paths could not be read' }
  if (!isDocsOnly(paths)) {
    const code = paths.filter((p) => !isDocsPath(p))
    return { suite: true, reason: paths.length === 0 ? 'no changed path was listed' : `${code.length} changed path(s) outside the documentation, first: ${code[0]}` }
  }
  return { suite: false, reason: `documentation only (${paths.length} path(s)): the suite runs on ${ALWAYS_FULL_OS} alone` }
}

const defaultRunGit = (args) => execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })

export function main(env = process.env, io = {}) {
  const log = io.log || ((s) => console.log(s))
  const write = io.write || ((file, text) => appendFileSync(file, text))
  let decision
  try {
    const eventName = env.GITHUB_EVENT_NAME || ''
    const runnerOs = env.RUNNER_OS || ''
    // git is asked only where its answer can change the outcome.
    const paths = eventName === 'pull_request' && runnerOs !== ALWAYS_FULL_OS ? changedPaths(io.runGit || defaultRunGit) : null
    decision = decideScope({ eventName, runnerOs, paths })
  } catch (err) {
    decision = { suite: true, reason: `could not decide (${err && err.message ? err.message : err})` }
  }
  log(`suite=${decision.suite}: ${decision.reason}`)
  // ci.yml skips the suite only on the literal 'false': an output that was never
  // written runs it, and a write that throws fails the step and so the job.
  if (env.GITHUB_OUTPUT) write(env.GITHUB_OUTPUT, `suite=${decision.suite ? 'true' : 'false'}\n`)
  return 0
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) process.exitCode = main()
