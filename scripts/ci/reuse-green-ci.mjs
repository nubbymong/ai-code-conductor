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
//      being released. A push run executes the workflow of its own commit, so
//      for it the ci.yml that ran is the one being released;
//   4. a pull-request run executes the workflow of the MERGE of that commit
//      into the PR's base, and the merge takes the base's side of ci.yml where
//      the base changed it. So a PR run counts only when every pull request
//      GitHub lists for the commit is into `beta` or `main` in this
//      repository (the lines that exist and take changes only through an
//      owner-merged PR), and one of them has the commit as its head. A
//      release/* base is not accepted: such a branch can be created, with any
//      ci.yml in it, by anyone who can push. GitHub lists the merged and the
//      open pull requests of a commit and serves their base as it is now: a
//      PR closed without merging, or retargeted after its run, is not seen.
//      Both need push access and the owner's merge, which the required checks
//      of a ruleset already trust in the same way;
//   5. in that run each Test job (Windows, macOS, Linux) is green AND has a
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
/** The bases a pull-request run may have been merged into for the test (condition 4 above). */
export const REUSE_PR_BASES = ['beta', 'main']
/** How far back the search reads: one page of runs, this many distinct
 *  commits, one page of pull requests per commit, and job lists: at most
 *  MAX_JOB_READS of runs that ran the Test jobs and prove nothing, and
 *  MAX_JOB_LISTS in all. The second bound is there for the label and edit runs
 *  (in-beta, a release label, a title edit): each ends green on the same
 *  commit, newer than the run that ran the suite, and runs no test. They are
 *  passed over without using up the first bound. Past any bound: the full
 *  suite. */
export const MAX_RUNS = 100
export const MAX_COMMITS = 30
export const MAX_PULLS = 100
export const MAX_JOB_READS = 10
export const MAX_JOB_LISTS = 40

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

/**
 * Why a pull-request run on `run.head_sha` cannot stand in (condition 4), or
 * null. `pulls` is GitHub's list of the pull requests of that commit.
 */
export function prBaseProblem(pulls, run, repo) {
  const short = run.head_sha.slice(0, 12)
  if (pulls.length === 0) return `no pull request is listed for commit ${short}`
  if (pulls.length >= MAX_PULLS) return `too many pull requests are listed for commit ${short} to read them all`
  for (const p of pulls) {
    const base = p && typeof p === 'object' ? p.base : null
    if (!base || typeof base.ref !== 'string' || !base.repo || !Number.isInteger(base.repo.id) || typeof base.repo.full_name !== 'string') return `a pull request of commit ${short} has no readable base`
    if (base.repo.id !== run.repository.id || base.repo.full_name !== repo) return `pull request #${p.number} is into another repository`
    if (!REUSE_PR_BASES.includes(base.ref)) return `pull request #${p.number} is into ${base.ref}, not ${REUSE_PR_BASES.join(' or ')}`
  }
  if (!pulls.some((p) => p.head && p.head.sha === run.head_sha)) return `no pull request with commit ${short} as its head`
  return null
}

/** True for the job list of a run in which no Test job ran: a label change or
 *  an edit of the PR's text starts such a run (ci.yml skips the matrix). */
export function ranNoTests(jobs) {
  return !jobs.some((j) => j && typeof j.name === 'string' && j.name.startsWith('Test (') && j.conclusion !== 'skipped')
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
  let lists = 0 // job lists read
  let unproven = 0 // of them: the run ran the Test jobs (or its list was not whole) and proves nothing
  let idle = 0 // of them: a label or edit run, no Test job ran
  let sameTree = 0
  const rejected = []
  const idleNote = (lead) => (idle === 0 ? '' : `${lead}${idle} ${lead === '' ? '' : 'more were '}label or edit runs that ran no tests`)
  for (const sha of shas) {
    const commit = await get(`/repos/${repo}/git/commits/${sha}`)
    if (!commit || commit.sha !== sha || !commit.tree || typeof commit.tree.sha !== 'string') throw new Error(`GitHub returned no tree for commit ${sha}`)
    if (commit.tree.sha !== tree) continue
    sameTree += 1
    let baseProblem // of the commit's pull requests: read once, when a pull-request run on it comes up
    for (const run of runs.filter((r) => r.head_sha === sha)) {
      if (run.event !== 'push') {
        if (baseProblem === undefined) {
          const pulls = await get(`/repos/${repo}/commits/${sha}/pulls?per_page=${MAX_PULLS}`)
          if (!Array.isArray(pulls)) throw new Error(`GitHub returned no pull request list for commit ${sha}`)
          baseProblem = prBaseProblem(pulls, run, repo)
        }
        if (baseProblem !== null) { rejected.push(`run ${run.id}: ${baseProblem}`); continue }
      }
      if (unproven >= MAX_JOB_READS || lists >= MAX_JOB_LISTS) {
        return no(`stopped after ${lists} job lists on this tree without proof (${rejected.length > 0 ? rejected[0] + idleNote('; ') : `${idle} of them label or edit runs that ran no tests`})`)
      }
      lists += 1
      const page = await get(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)
      if (!page || !Array.isArray(page.jobs) || !Number.isInteger(page.total_count)) throw new Error(`GitHub returned no job list for run ${run.id}`)
      if (page.total_count !== page.jobs.length) { unproven += 1; rejected.push(`run ${run.id}: its job list is not complete`); continue }
      if (ranNoTests(page.jobs)) { idle += 1; continue }
      const problems = treeProofProblems(page.jobs, run.id, tree)
      if (problems.length === 0) {
        return { reuse: true, runId: run.id, url: typeof run.html_url === 'string' ? run.html_url : null, reason: `${CI_WORKFLOW} run ${run.id} (${run.event}, commit ${sha.slice(0, 12)}) passed the suite on Windows, macOS and Linux for tree ${tree}` }
      }
      unproven += 1
      rejected.push(`run ${run.id}: ${problems[0]}`)
    }
  }
  if (sameTree === 0) return no(`no green ${CI_WORKFLOW} run for a commit with tree ${tree}`)
  return no(`a green ${CI_WORKFLOW} run has this tree but none proves the suite ran on it (${rejected.length > 0 ? rejected[0] + idleNote('; ') : idleNote('')})`)
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
