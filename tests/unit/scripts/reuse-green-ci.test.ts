import { describe, it, expect } from 'vitest'
// Plain ESM with main() behind an argv[1] check, like release-gate.mjs:
// importing it runs nothing. GitHub is injected as `get`.
import {
  REUSE_CHANNEL, CI_WORKFLOW_PATH, REUSE_EVENTS, MAX_RUNS, MAX_COMMITS, MAX_JOB_READS,
  testedTreeStep, isReusableRun, treeProofProblems, findReusableRun, decideReuse, formatDecision, readHeadTree, main,
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
const greenJobs = (runId = 100) => [job('windows-2025', {}, runId), job('macos-latest', {}, runId), job('ubuntu-latest', {}, runId),
  { run_id: runId, name: 'Changelog in sync', status: 'completed', conclusion: 'success', steps: [] }]

/** A fake GitHub: the runs listing, each commit's tree, each run's jobs. Records every path asked. */
function github({ runs = [run()], trees = { [HEAD]: TREE } as Record<string, string>, jobs = { 100: greenJobs() } as Record<number, unknown[]>, total = {} as Record<number, number> } = {}) {
  const asked: string[] = []
  const get = async (p: string) => {
    asked.push(p)
    if (p.startsWith(`/repos/${REPO}/actions/workflows/ci.yml/runs?`)) return { total_count: runs.length, workflow_runs: runs }
    const c = /^\/repos\/o\/r\/git\/commits\/([0-9a-f]{40})$/.exec(p)
    if (c) { if (!(c[1] in trees)) throw new Error(`GitHub API 404 for ${p}`); return { sha: c[1], tree: { sha: trees[c[1]] } } }
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
  it('finds the green run whose commit has the release tree and whose Test jobs prove it, in three reads', async () => {
    const g = github()
    expect(await find(g)).toEqual({ reuse: true, runId: 100, url: 'https://github.com/o/r/actions/runs/100', reason: `ci.yml run 100 (pull_request, commit ${HEAD.slice(0, 12)}) passed the suite on Windows, macOS and Linux for tree ${TREE}` })
    expect(g.asked).toEqual([
      `/repos/${REPO}/actions/workflows/ci.yml/runs?status=success&per_page=${MAX_RUNS}`,
      `/repos/${REPO}/git/commits/${HEAD}`,
      `/repos/${REPO}/actions/runs/100/jobs?filter=latest&per_page=100`,
    ])
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
    const labelOnly = (id: number) => [{ run_id: id, name: 'Desktop test gate', status: 'completed', conclusion: 'success', steps: [] }, { run_id: id, name: 'Test (${{ matrix.os }})', status: 'completed', conclusion: 'skipped', steps: [] }]
    const g = github({ runs: [run({ id: 100 }), run({ id: 99 }), run({ id: 98 }), run({ id: 97 })], jobs: { 100: labelOnly(100), 99: labelOnly(99), 98: labelOnly(98), 97: greenJobs(97) } })
    const r = await find(g)
    expect(r.reuse).toBe(true)
    expect(r.runId).toBe(97)
    expect(g.asked.filter((p) => p.includes('/git/commits/'))).toHaveLength(1)
    expect(g.asked.filter((p) => p.includes('/jobs')).map((p) => /runs\/(\d+)/.exec(p)![1])).toEqual(['100', '99', '98', '97'])
  })

  it('a run on the tree that does not prove it is refused, with the first reason', async () => {
    const docsOnly = [job('windows-2025', { steps: [step('Decide the scope')] }), job('macos-latest', { steps: [step('Decide the scope')] }), job('ubuntu-latest')]
    expect(await find(github({ jobs: { 100: docsOnly } }))).toEqual({ reuse: false, runId: null, url: null, reason: `a green ci.yml run has this tree but none proves the suite ran on it (run 100: Test (windows-2025) has no green "Tested tree ${TREE}" step)` })
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
    const inside = github({ runs: many, trees, jobs: { [many[MAX_COMMITS - 1].id as number]: greenJobs(many[MAX_COMMITS - 1].id as number) } })
    expect(await find(inside)).toMatchObject({ reuse: true, runId: many[MAX_COMMITS - 1].id })
    // Job lists: MAX_JOB_READS unproven runs on the tree, then stop, although the next one would prove it.
    const burst = Array.from({ length: MAX_JOB_READS + 1 }, (_, i) => run({ id: 500 - i }))
    const jobs = Object.fromEntries(burst.map((r, i) => [r.id, i === MAX_JOB_READS ? greenJobs(r.id as number) : []]))
    const b = github({ runs: burst, jobs })
    const stopped = await find(b)
    expect(stopped.reuse).toBe(false)
    expect(stopped.reason).toMatch(new RegExp(`^read ${MAX_JOB_READS} runs on this tree without proof`))
    expect(b.asked.filter((p) => p.includes('/jobs'))).toHaveLength(MAX_JOB_READS)
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
