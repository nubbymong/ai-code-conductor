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
// Where it looks, in this order:
//   a. the release PR's own run. A beta release commit is the squash merge of
//      its release PR, so GitHub lists that PR for the commit with the commit
//      as its merge commit. The green ci.yml runs on the PR's head are read
//      directly, however many other commits had green runs since. A run there
//      counts only under conditions 2 to 5 above, checked by the same
//      functions as for the window (commitTree, listGreenRuns,
//      proveCommitRuns). When this finds nothing, or any read in it fails, one
//      log line says why and the window runs; it never refuses on its own;
//   b. the window: the newest page of green ci.yml runs, as below.
//
// Zero dependencies (plain node, global fetch), like scripts/release-gate.mjs,
// whose API helper and Test job names it shares.
//
//   node scripts/ci/reuse-green-ci.mjs            # in release.yml (env below)
//   node scripts/ci/reuse-green-ci.mjs --channel beta --repo owner/name --tree <40hex> [--sha <40hex>]
//
// Env: CHANNEL, GITHUB_REPOSITORY, GITHUB_TOKEN or GH_TOKEN (actions: read,
// contents: read and pull-requests: read are enough), GITHUB_OUTPUT,
// GITHUB_STEP_SUMMARY. The release commit is the checked-out one (or --sha).

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
 *  suite. The release PR's own run (a. above) is read first with its own
 *  count: one page of pull requests for the release commit, one page of green
 *  runs on the PR's head, and the same job-list bounds. */
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

/** Condition 3: the git tree of a commit, read from GitHub. Throws on a shape
 *  it does not expect. Both searches call it. */
export async function commitTree(get, repo, sha) {
  const commit = await get(`/repos/${repo}/git/commits/${sha}`)
  if (!commit || commit.sha !== sha || !commit.tree || typeof commit.tree.sha !== 'string') throw new Error(`GitHub returned no tree for commit ${sha}`)
  return commit.tree.sha
}

/** Condition 2: the green ci.yml runs of one listing (`query` is its query
 *  string), newest first, as GitHub lists them. Both searches call it. */
export async function listGreenRuns(get, repo, query) {
  const listing = await get(`/repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?${query}`)
  if (!listing || !Array.isArray(listing.workflow_runs)) throw new Error('GitHub returned no workflow_runs list')
  return listing.workflow_runs.filter((r) => isReusableRun(r, repo))
}

/** What one search has read so far, for its bounds and its reasons. */
export function newTally() {
  return {
    lists: 0, // job lists read
    unproven: 0, // of them: the run ran the Test jobs (or its list was not whole) and proves nothing
    idle: 0, // of them: a label or edit run, no Test job ran
    rejected: [],
  }
}

function idleNote(tally, lead) {
  return tally.idle === 0 ? '' : `${lead}${tally.idle} ${lead === '' ? '' : 'more were '}label or edit runs that ran no tests`
}

/** Why a search that saw runs on the tree found none that proves it. */
function unprovenNote(tally) {
  return tally.rejected.length > 0 ? tally.rejected[0] + idleNote(tally, '; ') : idleNote(tally, '')
}

/**
 * Conditions 4 and 5 for the green runs on ONE commit, newest first: the
 * caller has checked that the commit has the release tree (commitTree). Both
 * searches call this, each with its own tally. Returns `{ run }` for the first
 * run that proves the tree, `{ stop }` (the reason) when a bound is reached
 * first, and `{}` when no run on the commit proves it.
 */
export async function proveCommitRuns({ repo, tree, sha, runs, get, tally }) {
  let baseProblem // of the commit's pull requests: read once, when a pull-request run on it comes up
  for (const run of runs) {
    if (run.event !== 'push') {
      if (baseProblem === undefined) {
        const pulls = await get(`/repos/${repo}/commits/${sha}/pulls?per_page=${MAX_PULLS}`)
        if (!Array.isArray(pulls)) throw new Error(`GitHub returned no pull request list for commit ${sha}`)
        baseProblem = prBaseProblem(pulls, run, repo)
      }
      if (baseProblem !== null) { tally.rejected.push(`run ${run.id}: ${baseProblem}`); continue }
    }
    if (tally.unproven >= MAX_JOB_READS || tally.lists >= MAX_JOB_LISTS) {
      return { stop: `stopped after ${tally.lists} job lists on this tree without proof (${tally.rejected.length > 0 ? unprovenNote(tally) : `${tally.idle} of them label or edit runs that ran no tests`})` }
    }
    tally.lists += 1
    const page = await get(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)
    if (!page || !Array.isArray(page.jobs) || !Number.isInteger(page.total_count)) throw new Error(`GitHub returned no job list for run ${run.id}`)
    if (page.total_count !== page.jobs.length) { tally.unproven += 1; tally.rejected.push(`run ${run.id}: its job list is not complete`); continue }
    if (ranNoTests(page.jobs)) { tally.idle += 1; continue }
    const problems = treeProofProblems(page.jobs, run.id, tree)
    if (problems.length === 0) return { run }
    tally.unproven += 1
    tally.rejected.push(`run ${run.id}: ${problems[0]}`)
  }
  return {}
}

/**
 * Search a. above: the release PR's own run. `sha` is the release commit.
 * Returns `{ run, pr }` for a run that passes conditions 2 to 5, or `{ why }`
 * (nothing found, and why). A read that fails throws; the caller turns that
 * into a reason and runs the window.
 */
export async function findReleasePrRun({ repo, tree, sha, get }) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) return { why: 'the release commit could not be read' }
  const pulls = await get(`/repos/${repo}/commits/${sha}/pulls?per_page=${MAX_PULLS}`)
  if (!Array.isArray(pulls)) throw new Error(`GitHub returned no pull request list for commit ${sha}`)
  // Open PRs whose branch already holds the commit are listed too; their merge commit is another one.
  const pr = pulls.find((p) => p && typeof p === 'object' && p.merge_commit_sha === sha && Number.isInteger(p.number) && p.base && REUSE_PR_BASES.includes(p.base.ref))
  if (!pr) return { why: `no pull request into ${REUSE_PR_BASES.join(' or ')} was merged as commit ${sha.slice(0, 12)}` }
  const name = `PR ${pr.number}`
  const head = pr.head && typeof pr.head.sha === 'string' && SHA_RE.test(pr.head.sha) ? pr.head.sha : null
  if (!head) return { why: `${name} has no readable head commit` }
  const headTree = await commitTree(get, repo, head)
  if (headTree !== tree) return { why: `the head of ${name} (commit ${head.slice(0, 12)}) has tree ${headTree}, not the release tree ${tree}` }
  const runs = (await listGreenRuns(get, repo, `head_sha=${head}&status=success&per_page=${MAX_RUNS}`)).filter((r) => r.head_sha === head)
  if (runs.length === 0) return { why: `${name} has no green ${CI_WORKFLOW} run on its head (commit ${head.slice(0, 12)})` }
  const tally = newTally()
  const found = await proveCommitRuns({ repo, tree, sha: head, runs, get, tally })
  if (found.run) return { run: found.run, pr }
  return { why: `no green ${CI_WORKFLOW} run of ${name} proves the suite ran on this tree (${found.stop || unprovenNote(tally)})` }
}

/**
 * The search itself: the release PR's own run first (when `sha`, the release
 * commit, is given), then the window. `get` is one GET against the GitHub
 * REST API, parsed; it may throw. A throw in the window is the caller's to
 * catch; a throw in the release PR's search only sends the search on to the
 * window. `note` receives the one line that says why the release PR's own
 * run was not reused.
 *
 * @param {{ repo: string, tree: string, sha?: string, get: (pathAndQuery: string) => Promise<any>, note?: (line: string) => void }} input
 * @returns {Promise<{ reuse: boolean, runId: number|null, url: string|null, reason: string }>}
 */
export async function findReusableRun({ repo, tree, sha, get, note = () => {} }) {
  const no = (reason) => ({ reuse: false, runId: null, url: null, reason })
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return no('no repository name to search')
  if (typeof tree !== 'string' || !SHA_RE.test(tree)) return no('the release tree hash could not be read')

  // a. The release PR's own run.
  let why
  try {
    const direct = await findReleasePrRun({ repo, tree, sha, get })
    if (direct.run) {
      const run = direct.run
      return { reuse: true, runId: run.id, url: typeof run.html_url === 'string' ? run.html_url : null, reason: `run ${run.id} (the release PR's own run, PR ${direct.pr.number}) passed the suite on Windows, macOS and Linux for tree ${tree}` }
    }
    why = direct.why
  } catch (err) {
    why = `could not check it (${err && err.message ? err.message : err})`
  }
  note(`Release PR's own run not reused: ${why}. Searching the last ${MAX_RUNS} green ${CI_WORKFLOW} runs.`)

  // b. The window.
  const runs = await listGreenRuns(get, repo, `status=success&per_page=${MAX_RUNS}`)
  if (runs.length === 0) return no(`no green ${CI_WORKFLOW} run from this repository in the last ${MAX_RUNS} successful runs`)

  // Newest first, as GitHub lists them: the distinct commits, then each one's tree.
  const shas = [...new Set(runs.map((r) => r.head_sha))].slice(0, MAX_COMMITS)
  const tally = newTally()
  let sameTree = 0
  for (const commit of shas) {
    if ((await commitTree(get, repo, commit)) !== tree) continue
    sameTree += 1
    const found = await proveCommitRuns({ repo, tree, sha: commit, runs: runs.filter((r) => r.head_sha === commit), get, tally })
    if (found.stop) return no(found.stop)
    if (found.run) {
      const run = found.run
      return { reuse: true, runId: run.id, url: typeof run.html_url === 'string' ? run.html_url : null, reason: `${CI_WORKFLOW} run ${run.id} (${run.event}, commit ${commit.slice(0, 12)}) passed the suite on Windows, macOS and Linux for tree ${tree}` }
    }
  }
  if (sameTree === 0) return no(`no green ${CI_WORKFLOW} run for a commit with tree ${tree}`)
  return no(`a green ${CI_WORKFLOW} run has this tree but none proves the suite ran on it (${unprovenNote(tally)})`)
}

/**
 * The decision, for any input: never throws. Off the beta channel nothing is
 * read from GitHub at all.
 *
 * @param {{ channel: string, repo: string, tree: string, sha?: string, get: (p: string) => Promise<any>, note?: (line: string) => void }} input
 */
export async function decideReuse({ channel, repo, tree, sha, get, note }) {
  if (channel !== REUSE_CHANNEL) return { reuse: false, runId: null, url: null, reason: `channel is ${channel || '(unset)'}, not ${REUSE_CHANNEL}: the full suite runs` }
  try {
    return await findReusableRun({ repo, tree, sha, get, note })
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

const gitOut = (args) => execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })

/** The tree of the checked-out commit, or '' when git cannot say. */
export function readHeadTree(runGit = gitOut) {
  try { return String(runGit(['rev-parse', '--verify', 'HEAD^{tree}'])).trim() } catch { return '' }
}

/** The checked-out commit (the one being released), or '' when git cannot say. */
export function readHeadCommit(runGit = gitOut) {
  try { return String(runGit(['rev-parse', '--verify', 'HEAD^{commit}'])).trim() } catch { return '' }
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
    const sha = channel === REUSE_CHANNEL ? (argValue(argv, '--sha') || (io.readHeadCommit || readHeadCommit)()) : ''
    const token = env.GITHUB_TOKEN || env.GH_TOKEN || null
    const get = io.get || ((p) => githubGet(p, { token, fetchImpl: io.fetchImpl || globalThis.fetch }))
    decision = await decideReuse({ channel, repo, tree, sha, get, note: log })
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
