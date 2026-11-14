import { describe, it, expect } from 'vitest'
// Plain ESM with main() behind an argv[1] check, like release-gate.mjs:
// importing it runs nothing. GitHub is injected as `get`.
import {
  REUSE_CHANNEL, CI_WORKFLOW_PATH, REUSE_EVENTS, REUSE_PR_BASES, MAX_RUNS, MAX_COMMITS, MAX_JOB_READS, MAX_JOB_LISTS, MAX_PULLS,
  testedTreeStep, isReusableRun, prBaseProblem, ranNoTests, treeProofProblems, findReusableRun, decideReuse, formatDecision, readHeadTree, main,
} from '../../../scripts/ci/reuse-green-ci.mjs'

const REPO = 'o/r'
const TREE = 'a'.repeat(40)
const OTHER_TREE = 'b'.repeat(40)
const sha = (n: number) => n.toString(16).padStart(40, '0')
const HEAD = sha(1)

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
    if (p.startsWith(`/repos/${REPO}/actions/workflows/ci.yml/runs?`)) return { total_count: runs.length, workflow_runs: runs }
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
    const io = (over: Over = {}) => ({ log: () => {}, write: (f: string, t: string) => { files[f] = (files[f] ?? '') + t }, get: github().get, readHeadTree: () => TREE, ...over })
    const env = { CHANNEL: 'beta', GITHUB_REPOSITORY: REPO, GITHUB_OUTPUT: 'out', GITHUB_STEP_SUMMARY: 'sum' }
    expect(await main([], env, io())).toBe(0)
    expect(files.out).toBe('reuse=true\nrun_id=100\n')
    expect(files.sum).toContain('[100](https://github.com/o/r/actions/runs/100)')
    // Stable: the tree is not read, GitHub is not asked, the suite runs.
    for (const k of Object.keys(files)) delete files[k]
    let read = 0
    const g = github()
    expect(await main([], { ...env, CHANNEL: 'stable' }, io({ get: g.get, readHeadTree: () => { read++; return TREE } }))).toBe(0)
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
  })
})
