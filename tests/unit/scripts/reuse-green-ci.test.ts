import { describe, it, expect } from 'vitest'
// Plain ESM with main() behind an argv[1] check, like release-gate.mjs:
// importing it runs nothing. GitHub is injected as `get`.
import {
  REUSE_CHANNEL, CI_WORKFLOW_PATH, REUSE_EVENTS, REUSE_PR_BASES, MAX_RUNS, MAX_COMMITS, MAX_JOB_READS, MAX_JOB_LISTS, MAX_PULLS,
  testedTreeStep, isReusableRun, prBaseProblem, ranNoTests, treeProofProblems, findReusableRun, decideReuse, formatDecision, readHeadTree, readHeadCommit, main,
} from '../../../scripts/ci/reuse-green-ci.mjs'

const REPO = 'o/r'
const TREE = 'a'.repeat(40)
const OTHER_TREE = 'b'.repeat(40)
const sha = (n: number) => n.toString(16).padStart(40, '0')
const HEAD = sha(1)
/** The release commit on beta (the squash merge of the release PR), and the PR's head. */
const RELEASE = sha(0xbeef)
const PR_HEAD = sha(0xcafe)

type Over = Record<string, unknown>
const run = (over: Over = {}) => ({
  id: 100, status: 'completed', conclusion: 'success', path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: HEAD,
  html_url: 'https://github.com/o/r/actions/runs/100',
  repository: { id: 7, full_name: REPO }, head_repository: { id: 7, full_name: REPO }, ...over,
})
const step = (name: string, over: Over = {}) => ({ name, status: 'completed', conclusion: 'success', ...over })
const job = (os: string, over: Over = {}, runId = 100) => ({
  run_id: runId, name: `Test (${os})`, status: 'completed', conclusion: 'success',
  steps: [step('Unit tests'), step('Build'), step(`Tested tree ${TREE}`)], ...over,
})
/** A pull request as GitHub lists it for a commit: merged into beta, in this repository, its head the run's commit. */
const pull = (over: Over = {}) => ({ number: 5, state: 'closed', base: { ref: 'beta', repo: { id: 7, full_name: REPO } }, head: { sha: HEAD, repo: { id: 7, full_name: REPO } }, ...over })
/** A run that ran no Test job: what a label change or a title edit leaves on the commit. */
const idleJobs = (id: number) => [{ run_id: id, name: 'Desktop test gate', status: 'completed', conclusion: 'success', steps: [] }, { run_id: id, name: 'Test (${{ matrix.os }})', status: 'completed', conclusion: 'skipped', steps: [] }]
/** A run that ran the Test jobs and proves nothing: a docs-only change skipped the suite on Windows and macOS. */
const docsOnlyJobs = (id = 100) => [job('windows-2025', { steps: [step('Decide the scope')] }, id), job('macos-latest', { steps: [step('Decide the scope')] }, id), job('ubuntu-latest', {}, id)]
const greenJobs = (runId = 100) => [job('windows-2025', {}, runId), job('macos-latest', {}, runId), job('ubuntu-latest', {}, runId),
  { run_id: runId, name: 'Changelog in sync', status: 'completed', conclusion: 'success', steps: [] }]

/** A fake GitHub: the runs listing, each commit's tree and pull requests, each run's jobs. Records every path asked. */
function github({ runs = [run()], trees = { [HEAD]: TREE } as Record<string, string>, jobs = { 100: greenJobs() } as Record<number, unknown[]>, total = {} as Record<number, number>, pulls = { [HEAD]: [pull()] } as Record<string, unknown> } = {}) {
  const asked: string[] = []
  const get = async (p: string) => {
    asked.push(p)
    if (p.startsWith(`/repos/${REPO}/actions/workflows/ci.yml/runs?`)) {
      // As GitHub does: a head_sha in the query lists that commit's runs only.
      const h = /[?&]head_sha=([0-9a-f]{40})(&|$)/.exec(p)
      const list = h ? runs.filter((r) => r.head_sha === h[1]) : runs
      return { total_count: list.length, workflow_runs: list }
    }
    const c = /^\/repos\/o\/r\/git\/commits\/([0-9a-f]{40})$/.exec(p)
    if (c) { if (!(c[1] in trees)) throw new Error(`GitHub API 404 for ${p}`); return { sha: c[1], tree: { sha: trees[c[1]] } } }
    const pl = /^\/repos\/o\/r\/commits\/([0-9a-f]{40})\/pulls\?per_page=100$/.exec(p)
    if (pl) { if (!(pl[1] in pulls)) throw new Error(`GitHub API 404 for ${p}`); return pulls[pl[1]] }
    const j = /^\/repos\/o\/r\/actions\/runs\/(\d+)\/jobs\?filter=latest&per_page=100$/.exec(p)
    if (j) { const list = jobs[Number(j[1])]; if (!list) throw new Error(`GitHub API 404 for ${p}`); return { total_count: total[Number(j[1])] ?? list.length, jobs: list } }
    throw new Error(`unexpected request ${p}`)
  }
  return { get, asked }
}
const find = (g: { get: (p: string) => Promise<unknown> }, over: Over = {}) => findReusableRun({ repo: REPO, tree: TREE, get: g.get, ...over } as never)

describe('reuse-green-ci: which CI run may stand in for the release suite', () => {
  it('a green ci.yml run from this repository, on a PR or a push, qualifies; anything else does not', () => {
    expect(isReusableRun(run(), REPO)).toBe(true)
    expect(isReusableRun(run({ event: 'push' }), REPO)).toBe(true)
    expect(REUSE_EVENTS).toEqual(['pull_request', 'push'])
    expect(CI_WORKFLOW_PATH).toBe('.github/workflows/ci.yml')
    const refused: Over[] = [
      { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'skipped' }, { conclusion: null },
      { status: 'in_progress' }, { status: 'queued', conclusion: 'success' },
      { path: '.github/workflows/release.yml' }, { path: '.github/workflows/ci.yaml' }, { path: undefined },
      { event: 'workflow_dispatch' }, { event: 'pull_request_target' }, { event: 'schedule' }, { event: undefined },
      // From a fork: the head repository is another one, by name or by id.
      { head_repository: { id: 8, full_name: 'evil/r' } }, { head_repository: { id: 8, full_name: REPO } }, { head_repository: { id: 7, full_name: 'evil/r' } },
      { head_repository: null }, { head_repository: undefined }, { head_repository: { full_name: REPO } },
      // Not this repository.
      { repository: { id: 7, full_name: 'o/other' } }, { repository: null }, { repository: { id: undefined, full_name: REPO }, head_repository: { id: undefined, full_name: REPO } },
      { head_sha: 'abc' }, { head_sha: undefined }, { head_sha: 'A'.repeat(40) },
      { id: undefined }, { id: '100' }, { id: 0 },
    ]
    for (const over of refused) expect(isReusableRun(run(over), REPO), JSON.stringify(over)).toBe(false)
    for (const bad of [null, undefined, 'run', 7]) expect(isReusableRun(bad, REPO)).toBe(false)
    expect(isReusableRun(run(), 'O/R')).toBe(false)
  })

  it('a run proves a tree only when every OS has a green Test job that ends with a green "Tested tree" step for it', () => {
    expect(testedTreeStep(TREE)).toBe(`Tested tree ${TREE}`)
    expect(treeProofProblems(greenJobs(), 100, TREE)).toEqual([])
    const without = (os: string) => greenJobs().filter((j) => j.name !== `Test (${os})`)
    expect(treeProofProblems(without('windows-2025'), 100, TREE)).toEqual(['no "Test (windows-...)" job'])
    expect(treeProofProblems(without('macos-latest'), 100, TREE)).toEqual(['no "Test (macos-...)" job'])
    expect(treeProofProblems(without('ubuntu-latest'), 100, TREE)).toEqual(['no "Test (ubuntu-...)" job'])
    expect(treeProofProblems([], 100, TREE)).toEqual(['no "Test (windows-...)" job', 'no "Test (macos-...)" job', 'no "Test (ubuntu-...)" job'])
    expect(treeProofProblems(null, 100, TREE)).toEqual(['no job list'])
    const withJob = (j: unknown) => [...greenJobs().filter((x) => x.name !== 'Test (windows-2025)'), j]
    // A job that did not end green.
    for (const over of [{ conclusion: 'failure' }, { conclusion: 'skipped' }, { conclusion: 'cancelled' }]) {
      expect(treeProofProblems(withJob(job('windows-2025', over)), 100, TREE), JSON.stringify(over)).toEqual([`Test (windows-2025) is ${over.conclusion}, not green`])
    }
    expect(treeProofProblems(withJob(job('windows-2025', { status: 'in_progress', conclusion: null })), 100, TREE)).toEqual(['Test (windows-2025) is in_progress, not green'])
    // A green job that never ran the suite (a docs-only run), or tested another tree, or whose proof step was skipped or failed.
    const noProof = [`Test (windows-2025) has no green "Tested tree ${TREE}" step`]
    expect(treeProofProblems(withJob(job('windows-2025', { steps: [step('Decide the scope')] })), 100, TREE)).toEqual(noProof)
    expect(treeProofProblems(withJob(job('windows-2025', { steps: [step(`Tested tree ${OTHER_TREE}`)] })), 100, TREE)).toEqual(noProof)
    expect(treeProofProblems(withJob(job('windows-2025', { steps: [step(`Tested tree ${TREE}`, { conclusion: 'skipped' })] })), 100, TREE)).toEqual(noProof)
    expect(treeProofProblems(withJob(job('windows-2025', { steps: [step(`Tested tree ${TREE}`, { conclusion: 'failure' })] })), 100, TREE)).toEqual(noProof)
    expect(treeProofProblems(withJob(job('windows-2025', { steps: [step(`Tested tree ${TREE}`, { status: 'in_progress', conclusion: null })] })), 100, TREE)).toEqual(noProof)
    expect(treeProofProblems(withJob(job('windows-2025', { steps: [step(`Tested tree ${TREE} `)] })), 100, TREE)).toEqual(noProof)
    expect(treeProofProblems(withJob(job('windows-2025', { steps: [step(`Tested tree ${TREE}`), step(`Tested tree ${TREE}`)] })), 100, TREE)).toEqual(noProof)
    expect(treeProofProblems(withJob(job('windows-2025', { steps: undefined })), 100, TREE)).toEqual(noProof)
    // A job of another run proves nothing here, and leaves its OS unproven.
    expect(treeProofProblems(withJob(job('windows-2025', {}, 999)), 100, TREE)).toEqual(['Test (windows-2025) belongs to another run', 'no "Test (windows-...)" job'])
    // A second leg of one OS must be green too.
    expect(treeProofProblems([...greenJobs(), job('windows-2022', { conclusion: 'failure' })], 100, TREE)).toEqual(['Test (windows-2022) is failure, not green'])
    // Only a job named as ci.yml names its Test jobs counts.
    expect(treeProofProblems([{ ...job('windows-2025'), name: 'Test (windows-2025) extra' }, job('macos-latest'), job('ubuntu-latest')], 100, TREE)).toEqual(['no "Test (windows-...)" job'])
  })
})

describe('reuse-green-ci: the search', () => {
  it('finds the green run whose commit has the release tree and whose Test jobs prove it: four reads for a PR run, three for a push', async () => {
    const g = github()
    expect(await find(g)).toEqual({ reuse: true, runId: 100, url: 'https://github.com/o/r/actions/runs/100', reason: `ci.yml run 100 (pull_request, commit ${HEAD.slice(0, 12)}) passed the suite on Windows, macOS and Linux for tree ${TREE}` })
    expect(g.asked).toEqual([
      `/repos/${REPO}/actions/workflows/ci.yml/runs?status=success&per_page=${MAX_RUNS}`,
      `/repos/${REPO}/git/commits/${HEAD}`,
      `/repos/${REPO}/commits/${HEAD}/pulls?per_page=${MAX_PULLS}`,
      `/repos/${REPO}/actions/runs/100/jobs?filter=latest&per_page=100`,
    ])
    // A push run executed the workflow of its own commit: no pull request is read, and none is needed.
    const p = github({ runs: [run({ event: 'push' })], pulls: {} })
    expect(await find(p)).toMatchObject({ reuse: true, runId: 100 })
    expect(p.asked).toEqual([
      `/repos/${REPO}/actions/workflows/ci.yml/runs?status=success&per_page=${MAX_RUNS}`,
      `/repos/${REPO}/git/commits/${HEAD}`,
      `/repos/${REPO}/actions/runs/100/jobs?filter=latest&per_page=100`,
    ])
  })

  it('a pull-request run counts only when the PR it ran for is into beta or main, in this repository', async () => {
    expect(REUSE_PR_BASES).toEqual(['beta', 'main'])
    expect(MAX_PULLS).toBe(100)
    // A PR run executes the workflow of the MERGE into its base, so the same
    // tree does not pin the ci.yml that ran unless the base is a protected line.
    const refuse = async (list: unknown, why: RegExp) => {
      const g = github({ pulls: { [HEAD]: list } })
      const r = await find(g)
      expect(r.reuse, String(why)).toBe(false)
      expect(r.reason, String(why)).toMatch(why)
      // Refused before its job list is read: it costs no job read.
      expect(g.asked.some((p) => p.includes('/jobs')), String(why)).toBe(false)
    }
    const into = (ref: unknown, over: Over = {}) => pull({ base: { ref, repo: { id: 7, full_name: REPO } }, ...over })
    await refuse([into('not-a-protected-base')], /run 100: pull request #5 is into not-a-protected-base, not beta or main/)
    // A release line can be created by anyone who can push, with any ci.yml in it: not accepted.
    await refuse([into('release/v2.1.3')], /is into release\/v2\.1\.3, not beta or main/)
    for (const ref of ['Beta', 'beta ', 'BETA', 'beta2', 'refs/heads/beta', 'Main', '']) await refuse([into(ref)], /not beta or main/)
    // The base is in another repository, by id or by name.
    await refuse([pull({ base: { ref: 'beta', repo: { id: 8, full_name: REPO } } })], /pull request #5 is into another repository/)
    await refuse([pull({ base: { ref: 'beta', repo: { id: 7, full_name: 'evil/r' } } })], /pull request #5 is into another repository/)
    // No pull request is listed (GitHub lists the merged and the open ones), or none whose head is the run's commit.
    await refuse([], /no pull request is listed for commit 0{12}/)
    await refuse([pull({ head: { sha: sha(2) } })], /no pull request with commit 0{12} as its head/)
    await refuse([pull({ head: undefined })], /no pull request with commit 0{12} as its head/)
    // Every pull request of the commit must qualify, not one of them.
    await refuse([pull(), into('scratch', { number: 6 })], /pull request #6 is into scratch/)
    await refuse([into('scratch', { number: 6, head: { sha: sha(2) } }), pull()], /pull request #6 is into scratch/)
    // An entry that cannot be read, or a list that may not be whole.
    for (const bad of [null, 'x', {}, { number: 5 }, pull({ base: null }), into(7), pull({ base: { ref: 'beta' } }), pull({ base: { ref: 'beta', repo: { id: '7', full_name: REPO } } })]) await refuse([pull(), bad], /a pull request of commit 0{12} has no readable base/)
    await refuse(Array.from({ length: MAX_PULLS }, () => pull()), /too many pull requests/)
    // main is a protected line too, and one fewer than the page is whole.
    expect(await find(github({ pulls: { [HEAD]: [into('main')] } }))).toMatchObject({ reuse: true, runId: 100 })
    expect(await find(github({ pulls: { [HEAD]: Array.from({ length: MAX_PULLS - 1 }, () => pull()) } }))).toMatchObject({ reuse: true, runId: 100 })
    // The function itself, on the run's own repository id.
    expect(prBaseProblem([pull()], run(), REPO)).toBe(null)
    expect(prBaseProblem([pull()], run({ repository: { id: 9, full_name: REPO } }), REPO)).toBe('pull request #5 is into another repository')
    expect(prBaseProblem([pull()], run(), 'o/other')).toBe('pull request #5 is into another repository')
  })

  it('the pull requests are read once per commit, and a push run on the same commit still counts', async () => {
    // Three PR runs on one commit whose PR is into an unprotected base, and an older push run.
    const scratch = [pull({ base: { ref: 'scratch', repo: { id: 7, full_name: REPO } } })]
    const runs = [run({ id: 103 }), run({ id: 102 }), run({ id: 101 }), run({ id: 100, event: 'push' })]
    const g = github({ runs, pulls: { [HEAD]: scratch } })
    expect(await find(g)).toMatchObject({ reuse: true, runId: 100 })
    expect(g.asked.filter((p) => p.includes('/pulls'))).toHaveLength(1)
    expect(g.asked.filter((p) => p.includes('/jobs'))).toEqual([`/repos/${REPO}/actions/runs/100/jobs?filter=latest&per_page=100`])
    // With no push run behind them: refused, and the reason is the base.
    const none = await find(github({ runs: runs.slice(0, 3), pulls: { [HEAD]: scratch } }))
    expect(none).toEqual({ reuse: false, runId: null, url: null, reason: 'a green ci.yml run has this tree but none proves the suite ran on it (run 103: pull request #5 is into scratch, not beta or main)' })
  })

  it('a run for a commit with another tree is never read further', async () => {
    const g = github({ trees: { [HEAD]: OTHER_TREE } })
    expect(await find(g)).toEqual({ reuse: false, runId: null, url: null, reason: `no green ci.yml run for a commit with tree ${TREE}` })
    expect(g.asked.some((p) => p.includes('/jobs'))).toBe(false)
  })

  it('a run from a fork, of another workflow or not green is dropped before any commit is read', async () => {
    const g = github({ runs: [run({ head_repository: { id: 8, full_name: 'evil/r' } }), run({ id: 101, path: '.github/workflows/x.yml' }), run({ id: 102, conclusion: 'failure' }), run({ id: 103, event: 'workflow_dispatch' })] })
    expect(await find(g)).toEqual({ reuse: false, runId: null, url: null, reason: `no green ci.yml run from this repository in the last ${MAX_RUNS} successful runs` })
    expect(g.asked).toHaveLength(1)
  })

  it('label-only runs on the same commit are passed over for the run that ran the suite, newest first', async () => {
    // Four runs on one commit, as a burst of label changes leaves them: only run 97 ran the Test jobs to the end.
    const g = github({ runs: [run({ id: 100 }), run({ id: 99 }), run({ id: 98 }), run({ id: 97 })], jobs: { 100: idleJobs(100), 99: idleJobs(99), 98: idleJobs(98), 97: greenJobs(97) } })
    const r = await find(g)
    expect(r.reuse).toBe(true)
    expect(r.runId).toBe(97)
    expect(g.asked.filter((p) => p.includes('/git/commits/'))).toHaveLength(1)
    expect(g.asked.filter((p) => p.includes('/jobs')).map((p) => /runs\/(\d+)/.exec(p)![1])).toEqual(['100', '99', '98', '97'])
  })

  it('label and edit runs that ran no tests do not use up the reads kept for runs that did', async () => {
    expect(MAX_JOB_READS).toBe(10)
    expect(MAX_JOB_LISTS).toBe(40)
    expect(ranNoTests(idleJobs(1))).toBe(true)
    expect(ranNoTests([])).toBe(true)
    expect(ranNoTests([{ name: 'Changelog in sync', conclusion: 'success' }])).toBe(true)
    expect(ranNoTests(greenJobs())).toBe(false)
    expect(ranNoTests(docsOnlyJobs())).toBe(false)
    expect(ranNoTests([job('windows-2025', { conclusion: 'failure' })])).toBe(false)
    expect(ranNoTests([job('windows-2025', { conclusion: 'cancelled' }), ...idleJobs(1)])).toBe(false)
    // After the test run: in-beta, a release label, a title edit... each leaves a
    // green run on the same commit, newer than the one that ran the suite.
    const burst = (idle: number) => {
      const runs = Array.from({ length: idle + 1 }, (_, i) => run({ id: 900 - i }))
      const jobs = Object.fromEntries(runs.map((r, i) => [r.id, i === idle ? greenJobs(r.id as number) : idleJobs(r.id as number)]))
      return { g: github({ runs, jobs }), last: runs[idle].id }
    }
    for (const idle of [MAX_JOB_READS, MAX_JOB_READS + 2, MAX_JOB_LISTS - 1]) {
      const { g, last } = burst(idle)
      expect(await find(g), `${idle} label runs first`).toMatchObject({ reuse: true, runId: last })
      expect(g.asked.filter((p) => p.includes('/jobs'))).toHaveLength(idle + 1)
    }
    // The search is still bounded: MAX_JOB_LISTS job lists in all, and the reason says what they were.
    const { g } = burst(MAX_JOB_LISTS)
    const stopped = await find(g)
    expect(stopped).toEqual({ reuse: false, runId: null, url: null, reason: `stopped after ${MAX_JOB_LISTS} job lists on this tree without proof (${MAX_JOB_LISTS} of them label or edit runs that ran no tests)` })
    expect(g.asked.filter((p) => p.includes('/jobs'))).toHaveLength(MAX_JOB_LISTS)
    // Nothing but label runs on the tree: said so, not hidden behind a first refusal.
    const only = Array.from({ length: 3 }, (_, i) => run({ id: 700 - i }))
    expect((await find(github({ runs: only, jobs: Object.fromEntries(only.map((r) => [r.id, idleJobs(r.id as number)])) }))).reason)
      .toBe('a green ci.yml run has this tree but none proves the suite ran on it (3 label or edit runs that ran no tests)')
    // A mix: the first refusal of a run that did run tests, then the count of the label runs.
    const mix = [run({ id: 603 }), run({ id: 602 }), run({ id: 601 })]
    expect((await find(github({ runs: mix, jobs: { 603: idleJobs(603), 602: docsOnlyJobs(602), 601: idleJobs(601) } }))).reason)
      .toBe(`a green ci.yml run has this tree but none proves the suite ran on it (run 602: Test (windows-2025) has no green "Tested tree ${TREE}" step; 2 more were label or edit runs that ran no tests)`)
  })

  it('a run on the tree that does not prove it is refused, with the first reason', async () => {
    expect(await find(github({ jobs: { 100: docsOnlyJobs() } }))).toEqual({ reuse: false, runId: null, url: null, reason: `a green ci.yml run has this tree but none proves the suite ran on it (run 100: Test (windows-2025) has no green "Tested tree ${TREE}" step)` })
    // A job list GitHub says is longer than the page it sent: not read as complete.
    const r = await find(github({ total: { 100: 5 } }))
    expect(r.reuse).toBe(false)
    expect(r.reason).toMatch(/run 100: its job list is not complete/)
  })

  it('an older commit with the same tree is found behind newer commits with other trees', async () => {
    const runs = [run({ id: 300, head_sha: sha(3) }), run({ id: 200, head_sha: sha(2) }), run({ id: 100, head_sha: HEAD, event: 'push' })]
    const g = github({ runs, trees: { [sha(3)]: OTHER_TREE, [sha(2)]: 'c'.repeat(40), [HEAD]: TREE } })
    const r = await find(g)
    expect(r).toMatchObject({ reuse: true, runId: 100 })
    expect(r.reason).toMatch(/^ci\.yml run 100 \(push, /)
    expect(g.asked.filter((p) => p.includes('/jobs'))).toEqual([`/repos/${REPO}/actions/runs/100/jobs?filter=latest&per_page=100`])
  })

  it('the search is bounded: so many commits, so many job lists, then the full suite', async () => {
    const many = Array.from({ length: MAX_COMMITS + 5 }, (_, i) => run({ id: 1000 - i, head_sha: sha(1000 - i) }))
    const trees = Object.fromEntries(many.map((r) => [r.head_sha as string, OTHER_TREE]))
    // The matching commit is just past the bound: not reached.
    trees[many[MAX_COMMITS].head_sha as string] = TREE
    const g = github({ runs: many, trees, jobs: { [many[MAX_COMMITS].id as number]: greenJobs(many[MAX_COMMITS].id as number) } })
    expect((await find(g)).reuse).toBe(false)
    expect(g.asked.filter((p) => p.includes('/git/commits/'))).toHaveLength(MAX_COMMITS)
    // And just inside it: reached.
    trees[many[MAX_COMMITS].head_sha as string] = OTHER_TREE
    trees[many[MAX_COMMITS - 1].head_sha as string] = TREE
    const reached = many[MAX_COMMITS - 1]
    const inside = github({ runs: many, trees, jobs: { [reached.id as number]: greenJobs(reached.id as number) }, pulls: { [reached.head_sha as string]: [pull({ head: { sha: reached.head_sha } })] } })
    expect(await find(inside)).toMatchObject({ reuse: true, runId: many[MAX_COMMITS - 1].id })
    // Job lists: MAX_JOB_READS runs that ran the tests and prove nothing, then stop, although the next one would prove it.
    const burst = Array.from({ length: MAX_JOB_READS + 1 }, (_, i) => run({ id: 500 - i }))
    const jobs = Object.fromEntries(burst.map((r, i) => [r.id, i === MAX_JOB_READS ? greenJobs(r.id as number) : docsOnlyJobs(r.id as number)]))
    const b = github({ runs: burst, jobs })
    const stopped = await find(b)
    expect(stopped).toEqual({ reuse: false, runId: null, url: null, reason: `stopped after ${MAX_JOB_READS} job lists on this tree without proof (run 500: Test (windows-2025) has no green "Tested tree ${TREE}" step)` })
    expect(b.asked.filter((p) => p.includes('/jobs'))).toHaveLength(MAX_JOB_READS)
    // A job list that is not whole counts as one of them.
    expect((await find(github({ runs: burst, jobs, total: Object.fromEntries(burst.map((r) => [r.id, 9])) }))).reason).toBe(`stopped after ${MAX_JOB_READS} job lists on this tree without proof (run 500: its job list is not complete)`)
    // One fewer unproven run before it: found.
    const fits = burst.slice(1)
    expect(await find(github({ runs: fits, jobs }))).toMatchObject({ reuse: true, runId: fits[fits.length - 1].id })
  })

  it('a tree or a repository name that is not exact is refused before GitHub is asked', async () => {
    for (const tree of ['', 'abc', 'A'.repeat(40), `${TREE} `, 'a'.repeat(64), undefined, null]) {
      const g = github()
      expect(await find(g, { tree }), String(tree)).toEqual({ reuse: false, runId: null, url: null, reason: 'the release tree hash could not be read' })
      expect(g.asked).toEqual([])
    }
    for (const repo of ['', 'o', 'o/r/x', 'o/r?x=1', '../r', undefined]) {
      const g = github()
      expect((await find(g, { repo })).reason, String(repo)).toBe('no repository name to search')
      expect(g.asked).toEqual([])
    }
  })

  it('an answer in a shape it does not expect throws, for the caller to turn into the full suite', async () => {
    const shaped = (first: unknown) => ({ get: async (p: string) => (p.includes('/workflows/') ? first : github().get(p)) })
    await expect(find(shaped({}))).rejects.toThrow(/no workflow_runs list/)
    await expect(find(shaped(null))).rejects.toThrow(/no workflow_runs list/)
    await expect(find(shaped([]))).rejects.toThrow(/no workflow_runs list/)
    const commit = (answer: unknown) => ({ get: async (p: string) => (p.includes('/git/commits/') ? answer : github().get(p)) })
    await expect(find(commit({ sha: HEAD }))).rejects.toThrow(/no tree for commit/)
    await expect(find(commit({ sha: sha(9), tree: { sha: TREE } }))).rejects.toThrow(/no tree for commit/)
    await expect(find(commit(null))).rejects.toThrow(/no tree for commit/)
    const jobs = (answer: unknown) => ({ get: async (p: string) => (p.includes('/jobs') ? answer : github().get(p)) })
    await expect(find(jobs({ jobs: greenJobs() }))).rejects.toThrow(/no job list for run 100/)
    await expect(find(jobs({ total_count: 4 }))).rejects.toThrow(/no job list for run 100/)
    await expect(find(github({ trees: {} }))).rejects.toThrow(/404/)
    // The pull-request list of the commit: not a list, or not served.
    for (const answer of [null, {}, { message: 'Not Found' }, 'x']) await expect(find(github({ pulls: { [HEAD]: answer } }))).rejects.toThrow(/no pull request list for commit/)
    await expect(find(github({ pulls: {} }))).rejects.toThrow(/404/)
    expect((await decideReuse({ channel: 'beta', repo: REPO, tree: TREE, get: github({ pulls: {} }).get })).reuse).toBe(false)
  })
})

describe("reuse-green-ci: the release PR's own run, found directly before the window (aicc_planning#361)", () => {
  // 2.1.3-beta.9 (release run 44624973440): the release PR's green run 44469921465
  // on its head had the release tree, but 42 other commits had green runs after
  // it that day, so it sat outside the MAX_COMMITS window and the suite ran again.
  const WINDOW = `/repos/${REPO}/actions/workflows/ci.yml/runs?status=success&per_page=${MAX_RUNS}`
  const RELEASE_PULLS = `/repos/${REPO}/commits/${RELEASE}/pulls?per_page=${MAX_PULLS}`
  const HEAD_RUNS = `/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${PR_HEAD}&status=success&per_page=${MAX_RUNS}`
  const windowNote = (why: string) => `Release PR's own run not reused: ${why}. Searching the last ${MAX_RUNS} green ci.yml runs.`
  /** What GitHub lists for the release commit: open PRs whose branch already holds it (another merge commit), and the release PR merged as it. */
  const releasePulls = (over: Over = {}) => [
    pull({ number: 744, state: 'open', merge_commit_sha: sha(0x744), head: { sha: sha(0x7440) } }),
    pull({ number: 728, merge_commit_sha: RELEASE, head: { sha: PR_HEAD }, ...over }),
  ]
  /** What GitHub lists for the PR's head: the release PR, into beta, with the head as its head. */
  const headPulls = () => [pull({ number: 728, head: { sha: PR_HEAD } })]
  const ownRun = (over: Over = {}) => run({ id: 1500, head_sha: PR_HEAD, html_url: 'https://github.com/o/r/actions/runs/1500', ...over })
  /** 40 commits with green runs on other trees, newest first, then the release PR's head: past the window. */
  const busyDay = () => {
    const busy = Array.from({ length: 40 }, (_, i) => run({ id: 3000 - i, head_sha: sha(3000 - i) }))
    return { runs: [...busy, ownRun()], trees: { ...Object.fromEntries(busy.map((r) => [r.head_sha as string, OTHER_TREE])), [PR_HEAD]: TREE } }
  }
  const findAt = async (g: { get: (p: string) => Promise<unknown> }) => {
    const notes: string[] = []
    const r = await find(g, { sha: RELEASE, note: (line: string) => notes.push(line) })
    return { r, notes }
  }

  it("reuses the release PR's own green run 40 commits back, past MAX_COMMITS, where the window finds nothing", async () => {
    const { runs, trees } = busyDay()
    expect(runs.indexOf(runs[runs.length - 1])).toBeGreaterThan(MAX_COMMITS)
    const pulls = { [RELEASE]: releasePulls(), [PR_HEAD]: headPulls() }
    const jobs = { 1500: greenJobs(1500) }
    // The window alone does not reach it.
    const w = github({ runs, trees, pulls, jobs })
    expect(await find(w)).toEqual({ reuse: false, runId: null, url: null, reason: `no green ci.yml run for a commit with tree ${TREE}` })
    expect(w.asked.filter((p) => p.includes('/git/commits/'))).toHaveLength(MAX_COMMITS)
    // From the release commit: found directly, and the window is never read.
    const g = github({ runs, trees, pulls, jobs })
    const { r, notes } = await findAt(g)
    expect(r).toEqual({ reuse: true, runId: 1500, url: 'https://github.com/o/r/actions/runs/1500', reason: `run 1500 (the release PR's own run, PR 728) passed the suite on Windows, macOS and Linux for tree ${TREE}` })
    expect(notes).toEqual([])
    expect(g.asked).toEqual([
      RELEASE_PULLS,
      `/repos/${REPO}/git/commits/${PR_HEAD}`,
      HEAD_RUNS,
      `/repos/${REPO}/commits/${PR_HEAD}/pulls?per_page=${MAX_PULLS}`,
      `/repos/${REPO}/actions/runs/1500/jobs?filter=latest&per_page=100`,
    ])
    // A newer label or edit run on the head (beta.9's run 44474363273) is passed over, as in the window.
    const labelled = github({ runs: [ownRun({ id: 1501 }), ...runs], trees, pulls, jobs: { 1501: idleJobs(1501), ...jobs } })
    expect((await findAt(labelled)).r).toMatchObject({ reuse: true, runId: 1500 })
    // The decision and main say which path found it.
    expect(await decideReuse({ channel: 'beta', repo: REPO, tree: TREE, sha: RELEASE, get: github({ runs, trees, pulls, jobs }).get })).toMatchObject({ reuse: true, runId: 1500 })
    const lines: string[] = []
    const files: Record<string, string> = {}
    const io = { log: (l: string) => lines.push(l), write: (f: string, t: string) => { files[f] = (files[f] ?? '') + t }, get: github({ runs, trees, pulls, jobs }).get, readHeadTree: () => TREE, readHeadCommit: () => RELEASE }
    expect(await main([], { CHANNEL: 'beta', GITHUB_REPOSITORY: REPO, GITHUB_OUTPUT: 'out' }, io)).toBe(0)
    expect(lines).toEqual([`Reuse: run 1500 (the release PR's own run, PR 728) passed the suite on Windows, macOS and Linux for tree ${TREE}`])
    expect(files.out).toBe('reuse=true\nrun_id=1500\n')
  })

  it('a release PR whose head has another tree is not reused directly: one line says so, then the window runs', async () => {
    // Its jobs even name the release tree: the tree of its commit decides, as in the window.
    const pulls = { [RELEASE]: releasePulls(), [PR_HEAD]: headPulls(), [HEAD]: [pull()] }
    const trees = { [PR_HEAD]: OTHER_TREE, [HEAD]: TREE }
    const why = windowNote(`the head of PR 728 (commit ${PR_HEAD.slice(0, 12)}) has tree ${OTHER_TREE}, not the release tree ${TREE}`)
    // The window then finds a run on the tree, and says so in its own words.
    const g = github({ runs: [ownRun(), run()], trees, pulls, jobs: { 1500: greenJobs(1500), 100: greenJobs() } })
    const { r, notes } = await findAt(g)
    expect(r).toEqual({ reuse: true, runId: 100, url: 'https://github.com/o/r/actions/runs/100', reason: `ci.yml run 100 (pull_request, commit ${HEAD.slice(0, 12)}) passed the suite on Windows, macOS and Linux for tree ${TREE}` })
    expect(notes).toEqual([why])
    expect(g.asked.slice(0, 3)).toEqual([RELEASE_PULLS, `/repos/${REPO}/git/commits/${PR_HEAD}`, WINDOW])
    expect(g.asked).not.toContain(HEAD_RUNS)
    expect(g.asked.filter((p) => p.includes('/jobs'))).toEqual([`/repos/${REPO}/actions/runs/100/jobs?filter=latest&per_page=100`])
    // With nothing on the tree in the window: refused, with the window's reason.
    const none = await findAt(github({ runs: [ownRun()], trees, pulls, jobs: { 1500: greenJobs(1500) } }))
    expect(none.r).toEqual({ reuse: false, runId: null, url: null, reason: `no green ci.yml run for a commit with tree ${TREE}` })
    expect(none.notes).toEqual([why])
  })

  it('a run of the release PR without a green "Tested tree" step in each Test job is not reused directly, nor any run the window would refuse', async () => {
    const pulls = { [RELEASE]: releasePulls(), [PR_HEAD]: headPulls() }
    const trees = { [PR_HEAD]: TREE }
    const proof = `Tested tree ${TREE}`
    // A label run and a docs-only run on the head: refused directly, then refused by the window too.
    const g = github({ runs: [ownRun({ id: 1501 }), ownRun()], trees, pulls, jobs: { 1501: idleJobs(1501), 1500: docsOnlyJobs(1500) } })
    const { r, notes } = await findAt(g)
    const unproven = `run 1500: Test (windows-2025) has no green "${proof}" step; 1 more were label or edit runs that ran no tests`
    expect(notes).toEqual([windowNote(`no green ci.yml run of PR 728 proves the suite ran on this tree (${unproven})`)])
    expect(r).toEqual({ reuse: false, runId: null, url: null, reason: `a green ci.yml run has this tree but none proves the suite ran on it (${unproven})` })
    expect(g.asked.indexOf(WINDOW)).toBeGreaterThan(g.asked.indexOf(HEAD_RUNS))
    // Each shape the window refuses, on the release PR's head and nowhere else: never reused directly.
    const wJob = (over: Over) => [job('windows-2025', over, 1500), job('macos-latest', {}, 1500), job('ubuntu-latest', {}, 1500)]
    const refused: Array<[string, { runs?: unknown[], trees?: Record<string, string>, jobs?: Record<number, unknown[]>, total?: Record<number, number>, pulls?: Record<string, unknown> }, RegExp]> = [
      ['the proof step names another tree', { jobs: { 1500: wJob({ steps: [step(`Tested tree ${OTHER_TREE}`)] }) } }, /has no green "Tested tree a{40}" step/],
      ['the proof step failed', { jobs: { 1500: wJob({ steps: [step(proof, { conclusion: 'failure' })] }) } }, /has no green "Tested tree a{40}" step/],
      ['a Test job failed', { jobs: { 1500: wJob({ conclusion: 'failure' }) } }, /Test \(windows-2025\) is failure, not green/],
      ['an OS has no Test job', { jobs: { 1500: greenJobs(1500).filter((j) => j.name !== 'Test (macos-latest)') } }, /no "Test \(macos-\.\.\.\)" job/],
      ['the job list is not whole', { total: { 1500: 9 } }, /run 1500: its job list is not complete/],
      ['the head is also in a PR into another base', { pulls: { [RELEASE]: releasePulls(), [PR_HEAD]: [...headPulls(), pull({ number: 6, base: { ref: 'scratch', repo: { id: 7, full_name: REPO } }, head: { sha: PR_HEAD } })] } }, /run 1500: pull request #6 is into scratch, not beta or main/],
      ['the run is from a fork', { runs: [ownRun({ head_repository: { id: 8, full_name: 'evil/r' } })] }, /PR 728 has no green ci\.yml run on its head/],
      ['the run did not end green', { runs: [ownRun({ conclusion: 'failure' })] }, /PR 728 has no green ci\.yml run on its head/],
      ['the run was a dispatch', { runs: [ownRun({ event: 'workflow_dispatch' })] }, /PR 728 has no green ci\.yml run on its head/],
      ['the run is of another workflow', { runs: [ownRun({ path: '.github/workflows/release.yml' })] }, /PR 728 has no green ci\.yml run on its head/],
      ['no run on the head at all', { runs: [run()], trees: { [PR_HEAD]: TREE, [HEAD]: OTHER_TREE } }, /PR 728 has no green ci\.yml run on its head \(commit 0{12}\)/],
    ]
    for (const [what, over, why] of refused) {
      const x = await findAt(github({ runs: [ownRun()], trees, pulls, jobs: { 1500: greenJobs(1500) }, ...over } as never))
      expect(x.r.reuse, what).toBe(false)
      expect(x.notes, what).toHaveLength(1)
      expect(x.notes[0], what).toMatch(why)
    }
    // GitHub lists another commit's run under head_sha (it should not): it is dropped, so it never skips condition 4.
    const stray = run({ id: 1700, head_sha: sha(0xdead) })
    const sloppy = github({ runs: [ownRun(), stray], trees: { [PR_HEAD]: TREE, [sha(0xdead)]: OTHER_TREE }, pulls, jobs: { 1500: docsOnlyJobs(1500), 1700: greenJobs(1700) } })
    const s = await findAt({ get: async (p: string) => (p === HEAD_RUNS ? { total_count: 2, workflow_runs: [ownRun(), stray] } : sloppy.get(p)) })
    expect(s.r.reuse).toBe(false)
    expect(sloppy.asked).not.toContain(`/repos/${REPO}/actions/runs/1700/jobs?filter=latest&per_page=100`)
    // The bounds hold here too: MAX_JOB_READS runs that prove nothing, then stop, although the next would prove it.
    const burst = Array.from({ length: MAX_JOB_READS + 1 }, (_, i) => ownRun({ id: 1600 - i }))
    const jobs = Object.fromEntries(burst.map((b, i) => [b.id, i === MAX_JOB_READS ? greenJobs(b.id as number) : docsOnlyJobs(b.id as number)]))
    const b = await findAt(github({ runs: burst, trees, pulls, jobs }))
    expect(b.notes[0]).toContain(`(stopped after ${MAX_JOB_READS} job lists on this tree without proof (run 1600: `)
    expect(b.r.reuse).toBe(false)
  })

  it('a release commit with no merged PR, or one into another branch, falls back to the window', async () => {
    const short = RELEASE.slice(0, 12)
    const noPr = windowNote(`no pull request into beta or main was merged as commit ${short}`)
    const into = (ref: string) => releasePulls({ base: { ref, repo: { id: 7, full_name: REPO } } })
    const cases: Array<[string, unknown, string]> = [
      ['no PR is listed', [], noPr],
      ['only open PRs that hold the commit, merged as another commit', releasePulls().slice(0, 1), noPr],
      ['the PR was merged into a release line', into('release/v2.1.3'), noPr],
      ['the PR was merged into another branch', into('scratch'), noPr],
      ['the PR has no number', releasePulls({ number: undefined }), noPr],
      ['the PR has no readable head', releasePulls({ head: { sha: 'abc' } }), windowNote('PR 728 has no readable head commit')],
    ]
    for (const [what, list, note] of cases) {
      // The window holds the default green PR run on the tree.
      const g = github({ runs: [ownRun(), run()], trees: { [PR_HEAD]: TREE, [HEAD]: TREE }, pulls: { [RELEASE]: list, [PR_HEAD]: headPulls(), [HEAD]: [pull()] }, jobs: { 1500: greenJobs(1500), 100: greenJobs() } })
      const { r, notes } = await findAt(g)
      expect(notes, what).toEqual([note])
      // Found by the window, newest first: the PR head's own run, in the window's words.
      expect(r, what).toEqual({ reuse: true, runId: 1500, url: 'https://github.com/o/r/actions/runs/1500', reason: `ci.yml run 1500 (pull_request, commit ${PR_HEAD.slice(0, 12)}) passed the suite on Windows, macOS and Linux for tree ${TREE}` })
      expect(g.asked.slice(0, 2), what).toEqual([RELEASE_PULLS, WINDOW])
    }
    // main is a protected line too: found directly.
    const intoMain = github({ runs: [ownRun()], trees: { [PR_HEAD]: TREE }, pulls: { [RELEASE]: into('main'), [PR_HEAD]: [pull({ number: 728, base: { ref: 'main', repo: { id: 7, full_name: REPO } }, head: { sha: PR_HEAD } })] }, jobs: { 1500: greenJobs(1500) } })
    expect((await findAt(intoMain)).r.reason).toMatch(/^run 1500 \(the release PR's own run, PR 728\)/)
    // No release commit to start from (none given, or not a hash): nothing is asked for it.
    for (const s of [undefined, '', 'abc', RELEASE.toUpperCase()]) {
      const notes: string[] = []
      const g = github()
      expect(await find(g, { sha: s, note: (l: string) => notes.push(l) }), String(s)).toMatchObject({ reuse: true, runId: 100 })
      expect(notes, String(s)).toEqual([windowNote('the release commit could not be read')])
      expect(g.asked[0], String(s)).toBe(WINDOW)
    }
  })

  it("when a read for the release PR fails, the window runs as before: the release is never refused for it", async () => {
    // The release commit's PR list: GitHub answers non-200 (githubGet throws on it), the call throws, or the answer is not a list.
    const failing = (answer: (p: string) => Promise<unknown>, at = RELEASE_PULLS) => {
      const g = github()
      const asked: string[] = []
      return { asked, get: async (p: string) => { asked.push(p); return p === at ? answer(p) : g.get(p) } }
    }
    const cases: Array<[string, (p: string) => Promise<unknown>, string]> = [
      ['a 502', async (p) => { throw new Error(`GitHub API 502 for ${p.replace(/[?&]per_page=.*$/, '')}`) }, `could not check it (GitHub API 502 for /repos/${REPO}/commits/${RELEASE}/pulls)`],
      ['a network error', async () => { throw new TypeError('fetch failed') }, 'could not check it (fetch failed)'],
      ['not a list', async () => ({ message: 'Not Found' }), `could not check it (GitHub returned no pull request list for commit ${RELEASE})`],
      ['null', async () => null, `could not check it (GitHub returned no pull request list for commit ${RELEASE})`],
    ]
    const windowFound = { reuse: true, runId: 100, url: 'https://github.com/o/r/actions/runs/100', reason: `ci.yml run 100 (pull_request, commit ${HEAD.slice(0, 12)}) passed the suite on Windows, macOS and Linux for tree ${TREE}` }
    for (const [what, answer, why] of cases) {
      const g = failing(answer)
      const { r, notes } = await findAt(g)
      expect(notes, what).toEqual([windowNote(why)])
      expect(r, what).toEqual(windowFound)
      expect(g.asked.slice(0, 2), what).toEqual([RELEASE_PULLS, WINDOW])
      expect((await decideReuse({ channel: 'beta', repo: REPO, tree: TREE, sha: RELEASE, get: failing(answer).get })).reuse, what).toBe(true)
    }
    // A later read of the release PR's search fails: the window still runs.
    const later = { [RELEASE]: releasePulls(), [PR_HEAD]: headPulls(), [HEAD]: [pull()] }
    for (const at of [`/repos/${REPO}/git/commits/${PR_HEAD}`, HEAD_RUNS, `/repos/${REPO}/commits/${PR_HEAD}/pulls?per_page=${MAX_PULLS}`, `/repos/${REPO}/actions/runs/1500/jobs?filter=latest&per_page=100`]) {
      const base = github({ runs: [ownRun(), run()], trees: { [PR_HEAD]: TREE, [HEAD]: TREE }, pulls: later, jobs: { 1500: greenJobs(1500), 100: greenJobs() } })
      let failed = false
      const get = async (p: string) => { if (p === at && !failed) { failed = true; throw new Error('GitHub API 500 for x') } return base.get(p) }
      const notes: string[] = []
      expect(await find({ get }, { sha: RELEASE, note: (l: string) => notes.push(l) }), at).toMatchObject({ reuse: true })
      expect(notes, at).toEqual([windowNote('could not check it (GitHub API 500 for x)')])
    }
    // End to end through main and githubGet: a 403 on the PR list, then the window's reuse.
    const g = github()
    const fetchImpl = async (url: string) => {
      const p = url.replace('https://api.github.com', '')
      if (p === RELEASE_PULLS) return { ok: false, status: 403, json: async () => ({}) }
      const body = await g.get(p)
      return { ok: true, status: 200, json: async () => body }
    }
    const lines: string[] = []
    const files: Record<string, string> = {}
    const io = { log: (l: string) => lines.push(l), write: (f: string, t: string) => { files[f] = (files[f] ?? '') + t }, fetchImpl, readHeadTree: () => TREE, readHeadCommit: () => RELEASE }
    expect(await main([], { CHANNEL: 'beta', GITHUB_REPOSITORY: REPO, GITHUB_OUTPUT: 'out' }, io)).toBe(0)
    expect(lines).toEqual([windowNote(`could not check it (GitHub API 403 for /repos/${REPO}/commits/${RELEASE}/pulls)`), `Reuse: ${windowFound.reason}`])
    expect(files.out).toBe('reuse=true\nrun_id=100\n')
  })
})

describe('reuse-green-ci: the decision the release reads', () => {
  it('only the beta channel may reuse: any other channel asks GitHub nothing and runs the suite', async () => {
    expect(REUSE_CHANNEL).toBe('beta')
    for (const channel of ['stable', 'dev', '', 'BETA', 'beta ', undefined]) {
      const g = github()
      const d = await decideReuse({ channel, repo: REPO, tree: TREE, get: g.get } as never)
      expect(d.reuse, String(channel)).toBe(false)
      expect(d.reason, String(channel)).toMatch(/not beta: the full suite runs$/)
      expect(g.asked, String(channel)).toEqual([])
    }
    expect((await decideReuse({ channel: 'beta', repo: REPO, tree: TREE, get: github().get })).reuse).toBe(true)
  })

  it('any error from GitHub is the full suite, never a failure', async () => {
    const boom = async () => { throw new Error('GitHub API 503 for /x') }
    expect(await decideReuse({ channel: 'beta', repo: REPO, tree: TREE, get: boom })).toEqual({ reuse: false, runId: null, url: null, reason: 'could not check (GitHub API 503 for /x): the full suite runs' })
    const late = github({ trees: {} })
    expect((await decideReuse({ channel: 'beta', repo: REPO, tree: TREE, get: late.get })).reuse).toBe(false)
  })

  it('prints reuse=true and the run id only for a reuse, and the summary names the run', () => {
    const yes = formatDecision({ reuse: true, runId: 100, url: 'https://github.com/o/r/actions/runs/100', reason: 'because' }, TREE)
    expect(yes.outputs).toBe('reuse=true\nrun_id=100\n')
    expect(yes.summary).toBe(`### Suite not re-run: green CI reused\n\n- CI run: [100](https://github.com/o/r/actions/runs/100)\n- Tree: \`${TREE}\`\n- because\n`)
    expect(formatDecision({ reuse: true, runId: 100, url: null, reason: 'because' }, TREE).summary).toContain('- CI run: 100\n')
    const no = formatDecision({ reuse: false, runId: null, url: null, reason: 'why not' }, TREE)
    expect(no.outputs).toBe('reuse=false\nrun_id=\n')
    expect(no.summary).toBe('### Full suite runs in this release\n\n- why not\n')
  })

  it('main writes the outputs and the summary, reads the tree from git on beta only, and exits 0 whatever happens', async () => {
    const files: Record<string, string> = {}
    const io = (over: Over = {}) => ({ log: () => {}, write: (f: string, t: string) => { files[f] = (files[f] ?? '') + t }, get: github().get, readHeadTree: () => TREE, readHeadCommit: () => RELEASE, ...over })
    const env = { CHANNEL: 'beta', GITHUB_REPOSITORY: REPO, GITHUB_OUTPUT: 'out', GITHUB_STEP_SUMMARY: 'sum' }
    expect(await main([], env, io())).toBe(0)
    expect(files.out).toBe('reuse=true\nrun_id=100\n')
    expect(files.sum).toContain('[100](https://github.com/o/r/actions/runs/100)')
    // Stable: the tree is not read, GitHub is not asked, the suite runs.
    for (const k of Object.keys(files)) delete files[k]
    let read = 0
    const g = github()
    expect(await main([], { ...env, CHANNEL: 'stable' }, io({ get: g.get, readHeadTree: () => { read++; return TREE }, readHeadCommit: () => { read++; return RELEASE } }))).toBe(0)
    expect(files.out).toBe('reuse=false\nrun_id=\n')
    expect(read).toBe(0)
    expect(g.asked).toEqual([])
    // The arguments win over the environment.
    for (const k of Object.keys(files)) delete files[k]
    expect(await main(['--channel', 'stable'], env, io())).toBe(0)
    expect(files.out).toBe('reuse=false\nrun_id=\n')
    for (const k of Object.keys(files)) delete files[k]
    expect(await main(['--channel', 'beta', '--repo', REPO, '--tree', OTHER_TREE], { GITHUB_OUTPUT: 'out' }, io({ readHeadTree: () => { throw new Error('not asked') } }))).toBe(0)
    expect(files.out).toBe('reuse=false\nrun_id=\n')
    // --sha names the release commit instead of git.
    const asked: string[] = []
    const g2 = github()
    expect(await main(['--sha', sha(0xfeed)], env, io({ get: async (p: string) => { asked.push(p); return g2.get(p) }, readHeadCommit: () => { throw new Error('not asked') } }))).toBe(0)
    expect(asked[0]).toBe(`/repos/${REPO}/commits/${sha(0xfeed)}/pulls?per_page=${MAX_PULLS}`)
    // git cannot say, the tree reader throws, GitHub throws, the output file cannot be written: 0 each time, and no reuse.
    for (const over of [{ readHeadTree: () => '' }, { readHeadTree: () => { throw new Error('no git') } }, { get: async () => { throw new Error('down') } }]) {
      for (const k of Object.keys(files)) delete files[k]
      expect(await main([], env, io(over))).toBe(0)
      expect(files.out).toBe('reuse=false\nrun_id=\n')
    }
    expect(await main([], env, io({ write: () => { throw new Error('disk full') } }))).toBe(0)
    // No output file named: nothing written.
    for (const k of Object.keys(files)) delete files[k]
    expect(await main([], { CHANNEL: 'beta', GITHUB_REPOSITORY: REPO }, io())).toBe(0)
    expect(files).toEqual({})
  })

  it('reads the tree of the checked-out commit, and nothing when git fails', () => {
    const calls: string[][] = []
    expect(readHeadTree((args: string[]) => { calls.push(args); return `${TREE}\n` })).toBe(TREE)
    expect(calls).toEqual([['rev-parse', '--verify', 'HEAD^{tree}']])
    expect(readHeadTree(() => { throw new Error('not a repository') })).toBe('')
    // And the release commit itself, for the release PR's own run.
    const commitCalls: string[][] = []
    expect(readHeadCommit((args: string[]) => { commitCalls.push(args); return `${RELEASE}\n` })).toBe(RELEASE)
    expect(commitCalls).toEqual([['rev-parse', '--verify', 'HEAD^{commit}']])
    expect(readHeadCommit(() => { throw new Error('not a repository') })).toBe('')
  })
})
