#!/usr/bin/env node
// A beta release reuses green CI for the same tree instead of running the
// suite again (ADR-028, rule 4). release.yml's `ci-reuse` job runs this before
// the build jobs; they skip their "Run tests" step only when it prints
// reuse=true. A stable release never reuses: it runs the suite as before.
//
// The answer is reuse=true only when ALL of this holds, read from GitHub:
//   1. the channel is beta;
//   2. a ci.yml run in THIS repository, not from a fork, on a pull request or
//      a push, is completed with conclusion success;
//   3. the commit that run was started for has the SAME git tree as the commit
//      being released (so the ci.yml that ran is the one being released);
//   4. in that run each Test job (Windows, macOS, Linux) is green AND has a
//      green step named "Tested tree <that tree>". The step runs after the
//      suite, on the tree the job really checked out. A pull-request run tests
//      the merge of the branch into its base, so a branch that was behind its
//      base tested another tree and does not count; a docs-only run that
//      skipped the suite has no such step and does not count either.
// Anything else (no such run, a doubt, an API error, a shape this does not
// expect) is reuse=false, and the release runs the full suite as it always
// did. This script never fails the release: it exits 0 whatever happens.
//
// Zero dependencies (plain node, global fetch), like scripts/release-gate.mjs,
// whose API helper and Test job names it shares.
//
//   node scripts/ci/reuse-green-ci.mjs            # in release.yml (env below)
//   node scripts/ci/reuse-green-ci.mjs --channel beta --repo owner/name --tree <40hex>
//
// Env: CHANNEL, GITHUB_REPOSITORY, GITHUB_TOKEN or GH_TOKEN (actions: read and
// contents: read are enough), GITHUB_OUTPUT, GITHUB_STEP_SUMMARY.

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CI_WORKFLOW, TEST_JOB_RE, TEST_OS_FAMILIES, githubGet } from '../release-gate.mjs'

export const REUSE_CHANNEL = 'beta'
export const CI_WORKFLOW_PATH = `.github/workflows/${CI_WORKFLOW}`
/** The events whose ci.yml run tests a tree: a dispatch runs no Test job. */
export const REUSE_EVENTS = ['pull_request', 'push']
/** How far back the search reads: one page of runs, this many distinct
 *  commits, this many job lists. Past any of them: the full suite. */
export const MAX_RUNS = 100
export const MAX_COMMITS = 30
export const MAX_JOB_READS = 10

const SHA_RE = /^[0-9a-f]{40}$/
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/

/** The name of the step a ci.yml Test job ends with (ci.yml builds the same
 *  name from the tree it checked out; tests/unit/scripts/ci-cadence.test.ts
 *  pins the two together). */
export function testedTreeStep(tree) {
  return `Tested tree ${tree}`
}

/** True for a run that may stand in for the release's own suite: completed
 *  green, of ci.yml, started by a PR or a push, in this repository and not
 *  from a fork. Every field must be present and exact (fail closed). */
export function isReusableRun(run, repo) {
  if (!run || typeof run !== 'object') return false
  if (!Number.isInteger(run.id) || run.id <= 0) return false
  if (run.status !== 'completed' || run.conclusion !== 'success') return false
  if (run.path !== CI_WORKFLOW_PATH) return false
  if (!REUSE_EVENTS.includes(run.event)) return false
  if (typeof run.head_sha !== 'string' || !SHA_RE.test(run.head_sha)) return false
  const base = run.repository
  const head = run.head_repository
  if (!base || !head) return false
  if (base.full_name !== repo || head.full_name !== repo) return false
  if (!Number.isInteger(base.id) || base.id !== head.id) return false
  return true
}

/** What a run's job list proves about `tree`: every OS family has a Test job,
 *  each Test job is green, and each has a green "Tested tree <tree>" step.
 *  Returns the problems (none: the run tested exactly this tree). */
export function treeProofProblems(jobs, runId, tree) {
  const problems = []
  if (!Array.isArray(jobs)) return ['no job list']
  const want = testedTreeStep(tree)
  const families = Object.fromEntries(TEST_OS_FAMILIES.map((f) => [f, 0]))
  for (const job of jobs) {
    const m = job && typeof job.name === 'string' ? TEST_JOB_RE.exec(job.name) : null
    if (!m) continue
    if (job.run_id !== runId) { problems.push(`${job.name} belongs to another run`); continue }
    families[m[1]] += 1
    if (job.status !== 'completed' || job.conclusion !== 'success') {
      problems.push(`${job.name} is ${job.status === 'completed' ? job.conclusion : job.status}, not green`)
      continue
    }
    const steps = Array.isArray(job.steps) ? job.steps : []
    const proof = steps.filter((s) => s && s.name === want)
    if (proof.length !== 1 || proof[0].status !== 'completed' || proof[0].conclusion !== 'success') {
      problems.push(`${job.name} has no green "${want}" step`)
    }
  }
  for (const f of TEST_OS_FAMILIES) if (families[f] === 0) problems.push(`no "Test (${f}-...)" job`)
  return problems
}

/**
 * The search itself. `get` is one GET against the GitHub REST API, parsed; it
 * may throw, and a throw is the caller's to catch.
 *
 * @param {{ repo: string, tree: string, get: (pathAndQuery: string) => Promise<any> }} input
 * @returns {Promise<{ reuse: boolean, runId: number|null, url: string|null, reason: string }>}
 */
export async function findReusableRun({ repo, tree, get }) {
  const no = (reason) => ({ reuse: false, runId: null, url: null, reason })
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return no('no repository name to search')
  if (typeof tree !== 'string' || !SHA_RE.test(tree)) return no('the release tree hash could not be read')

  const listing = await get(`/repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?status=success&per_page=${MAX_RUNS}`)
  if (!listing || !Array.isArray(listing.workflow_runs)) throw new Error('GitHub returned no workflow_runs list')
  const runs = listing.workflow_runs.filter((r) => isReusableRun(r, repo))
  if (runs.length === 0) return no(`no green ${CI_WORKFLOW} run from this repository in the last ${MAX_RUNS} successful runs`)

  // Newest first, as GitHub lists them: the distinct commits, then each one's tree.
  const shas = [...new Set(runs.map((r) => r.head_sha))].slice(0, MAX_COMMITS)
  let jobReads = 0
  let sameTree = 0
  const rejected = []
  for (const sha of shas) {
    const commit = await get(`/repos/${repo}/git/commits/${sha}`)
    if (!commit || commit.sha !== sha || !commit.tree || typeof commit.tree.sha !== 'string') throw new Error(`GitHub returned no tree for commit ${sha}`)
    if (commit.tree.sha !== tree) continue
    sameTree += 1
    for (const run of runs.filter((r) => r.head_sha === sha)) {
      if (jobReads >= MAX_JOB_READS) return no(`read ${MAX_JOB_READS} runs on this tree without proof (${rejected[0]})`)
      jobReads += 1
      const page = await get(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)
      if (!page || !Array.isArray(page.jobs) || !Number.isInteger(page.total_count)) throw new Error(`GitHub returned no job list for run ${run.id}`)
      if (page.total_count !== page.jobs.length) { rejected.push(`run ${run.id}: its job list is not complete`); continue }
      const problems = treeProofProblems(page.jobs, run.id, tree)
      if (problems.length === 0) {
        return { reuse: true, runId: run.id, url: typeof run.html_url === 'string' ? run.html_url : null, reason: `${CI_WORKFLOW} run ${run.id} (${run.event}, commit ${sha.slice(0, 12)}) passed the suite on Windows, macOS and Linux for tree ${tree}` }
      }
      rejected.push(`run ${run.id}: ${problems[0]}`)
    }
  }
  if (sameTree === 0) return no(`no green ${CI_WORKFLOW} run for a commit with tree ${tree}`)
  return no(`a green ${CI_WORKFLOW} run has this tree but none proves the suite ran on it (${rejected[0]})`)
}

/**
 * The decision, for any input: never throws. Off the beta channel nothing is
 * read from GitHub at all.
 *
 * @param {{ channel: string, repo: string, tree: string, get: (p: string) => Promise<any> }} input
 */
export async function decideReuse({ channel, repo, tree, get }) {
  if (channel !== REUSE_CHANNEL) return { reuse: false, runId: null, url: null, reason: `channel is ${channel || '(unset)'}, not ${REUSE_CHANNEL}: the full suite runs` }
  try {
    return await findReusableRun({ repo, tree, get })
  } catch (err) {
    return { reuse: false, runId: null, url: null, reason: `could not check (${err && err.message ? err.message : err}): the full suite runs` }
  }
}

/** The step outputs and the job summary, as text. */
export function formatDecision(d, tree) {
  const outputs = [`reuse=${d.reuse ? 'true' : 'false'}`, `run_id=${d.reuse ? d.runId : ''}`]
  const summary = d.reuse
    ? [`### Suite not re-run: green CI reused`, '', `- CI run: ${d.url ? `[${d.runId}](${d.url})` : d.runId}`, `- Tree: \`${tree}\``, `- ${d.reason}`]
    : [`### Full suite runs in this release`, '', `- ${d.reason}`]
  return { outputs: outputs.join('\n') + '\n', summary: summary.join('\n') + '\n' }
}

function argValue(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}

/** The tree of the checked-out commit, or '' when git cannot say. */
export function readHeadTree(runGit = (args) => execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })) {
  try { return String(runGit(['rev-parse', '--verify', 'HEAD^{tree}'])).trim() } catch { return '' }
}

export async function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const log = io.log || ((s) => console.log(s))
  const write = io.write || ((file, text) => appendFileSync(file, text))
  let decision
  let tree = ''
  try {
    const channel = argValue(argv, '--channel') || env.CHANNEL || ''
    const repo = argValue(argv, '--repo') || env.GITHUB_REPOSITORY || ''
    // Off the beta channel git is not even asked: nothing here can change a stable release.
    tree = channel === REUSE_CHANNEL ? (argValue(argv, '--tree') || (io.readHeadTree || readHeadTree)()) : ''
    const token = env.GITHUB_TOKEN || env.GH_TOKEN || null
    const get = io.get || ((p) => githubGet(p, { token, fetchImpl: io.fetchImpl || globalThis.fetch }))
    decision = await decideReuse({ channel, repo, tree, get })
  } catch (err) {
    decision = { reuse: false, runId: null, url: null, reason: `could not check (${err && err.message ? err.message : err}): the full suite runs` }
  }
  const text = formatDecision(decision, tree)
  log(decision.reuse ? `Reuse: ${decision.reason}` : `No reuse: ${decision.reason}`)
  // A write that fails leaves the outputs unset, which the build jobs read as "run the suite".
  try { if (env.GITHUB_OUTPUT) write(env.GITHUB_OUTPUT, text.outputs) } catch (err) { log(`could not write the step outputs: ${err && err.message}`) }
  try { if (env.GITHUB_STEP_SUMMARY) write(env.GITHUB_STEP_SUMMARY, text.summary) } catch { /* the summary is a record, not the decision */ }
  return 0
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  // exitCode, not process.exit(): see scripts/release-gate.mjs.
  main().then(() => { process.exitCode = 0 }, () => { process.exitCode = 0 })
}
