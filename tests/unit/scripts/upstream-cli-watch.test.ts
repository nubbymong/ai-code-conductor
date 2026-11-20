import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
import { evalValue } from '../../helpers/gha-expr'
// Plain ESM with main() behind an argv[1] check: importing it runs nothing.
// npm, gh, the files and the clock are all injected, so no case here touches
// the network.
import {
  CLIS, CI_WORKFLOW, WATCH_WORKFLOW, RECORD_ARTIFACT, RC_OSES, PLANNING_REPO,
  isVersion, compareVersions, readTested, parseRecord, mergeRecord, recordedGreen, decide,
  expectedLegNames, installStepName, classifyRun, ticketTitle, findPreviousRecord, dispatchAndWait, main,
} from '../../../scripts/ci/upstream-cli-watch.mjs'

/**
 * The daily upstream CLI watch (aicc_planning#368): the newest published Codex
 * and Claude Code are looked up, compared with the newest version the app was
 * tested with, and, when newer and not already checked green, ci.yml is
 * dispatched on beta with the version so the real-CLI conformance jobs run
 * against it. The logic lives in the script so it is tested here with no
 * network; the workflow only calls it and gh.
 */

const ROOT = resolve(__dirname, '../../..')
const readRepo = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf-8').replace(/\r\n/g, '\n')

// ---------------------------------------------------------------------------
// A fake world: the repo's two constants, npm, gh, files and a clock.
// ---------------------------------------------------------------------------
type GhCall = { args: string[]; token?: string }
const CODEX_SRC = (v: string) => `export const CODEX_MIN_SUPPORTED_VERSION = '0.153.4'\nexport const CODEX_MAX_TESTED_VERSION = '${v}'\n`
const CLAUDE_SRC = (v: string) => `export const CLAUDE_MIN_MANAGED_CLI_VERSION = '${v}'\n`

interface WorldOpts {
  codexTested?: string
  claudeTested?: string
  codexLatest?: string
  claudeLatest?: string
  record?: unknown
  /** Jobs the dispatched ci.yml run ends with. */
  jobs?: Array<{ name: string; conclusion: string; status?: string; url?: string; steps?: Array<{ name: string; conclusion: string }> }>
  runConclusion?: string
  neverCompletes?: boolean
  env?: Record<string, string>
  planningIssues?: Array<{ number: number; title: string; state: string }>
  /** What started the watch run that left the record (default: the schedule). */
  recordEvent?: string | null
  /** A newer, completed watch run started by a pull request, with a record that marks the newest versions green. */
  plantedRun?: boolean
}

function world(o: WorldOpts = {}) {
  const clock = { t: Date.parse('2026-11-21T05:41:00Z') }
  const manualRunAt = new Date(clock.t - 30_000).toISOString()
  const gh: GhCall[] = []
  const npm: string[][] = []
  const outputs: Record<string, string> = {}
  const outputLines: string[] = []
  let summary = ''
  const log: string[] = []
  const files = new Map<string, string>()
  const repoFiles: Record<string, string> = {
    'src/main/providers/codex/cli-contract.ts': CODEX_SRC(o.codexTested ?? '0.170.0'),
    'src/main/providers/claude/managed-launch.ts': CLAUDE_SRC(o.claudeTested ?? '2.1.278'),
  }
  const newRuns: Array<Record<string, unknown>> = []
  let polls = 0
  const dispatched: string[][] = []
  const planningIssues = [...(o.planningIssues ?? [])]
  const created: string[][] = []
  const edited: string[][] = []

  const jobsFor = (): NonNullable<WorldOpts['jobs']> => o.jobs ?? []

  const deps = {
    root: '/repo',
    readRepoFile: (rel: string) => {
      if (!(rel in repoFiles)) throw new Error(`ENOENT ${rel}`)
      return repoFiles[rel]
    },
    readText: (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`)
      return files.get(p) as string
    },
    writeText: (p: string, t: string) => { files.set(p, t) },
    appendText: (p: string, t: string) => {
      if (p === 'OUT') { for (const line of t.split('\n').filter(Boolean)) { outputLines.push(line); const i = line.indexOf('='); outputs[line.slice(0, i)] = line.slice(i + 1) } }
      else if (p === 'SUM') summary += t
      else files.set(p, (files.get(p) ?? '') + t)
    },
    mkdirp: () => {},
    log: (line: string) => { log.push(line) },
    now: () => new Date(clock.t),
    sleep: async (ms: number) => { clock.t += ms },
    npm: async (args: string[]) => {
      npm.push(args)
      if (args[1] === CLIS.codex.npm) return `${o.codexLatest ?? '0.171.0'}\n`
      if (args[1] === CLIS.claude.npm) return `${o.claudeLatest ?? '2.1.329'}\n`
      throw new Error(`unexpected npm ${args.join(' ')}`)
    },
    gh: async (args: string[], opts: { token?: string } = {}) => {
      gh.push({ args, token: opts.token })
      const [a, b] = args
      if (a === 'run' && b === 'list') {
        const wf = args[args.indexOf('--workflow') + 1]
        if (wf === WATCH_WORKFLOW) {
          const rec = o.record
          const ev = o.recordEvent === undefined ? 'schedule' : o.recordEvent
          const withEvent = (r: Record<string, unknown>, event: string | null) => (event === null ? r : { ...r, event })
          const planted = o.plantedRun ? [{ databaseId: 20, conclusion: 'success', createdAt: '2026-11-21T00:00:00Z', event: 'pull_request' }] : []
          return JSON.stringify([
            ...planted,
            ...(rec === undefined ? [] : [
              withEvent({ databaseId: 30, conclusion: 'cancelled', createdAt: '2026-11-20T05:41:00Z' }, 'schedule'),
              withEvent({ databaseId: 40, conclusion: 'failure', createdAt: '2026-11-19T05:41:00Z' }, 'workflow_dispatch'),
              withEvent({ databaseId: 50, conclusion: 'success', createdAt: '2026-11-18T05:41:00Z' }, ev),
            ]),
          ])
        }
        // Two runs of an earlier dispatch are already there: an old one, and a manual one started
        // half a minute before the watch's own, which only its id (not its time) tells apart.
        return JSON.stringify([
          { databaseId: 100, createdAt: '2026-11-20T10:00:00Z', url: 'https://github.com/o/r/actions/runs/100', status: 'completed', conclusion: 'success', headBranch: 'beta', event: 'workflow_dispatch' },
          { databaseId: 99, createdAt: manualRunAt, url: 'https://github.com/o/r/actions/runs/99', status: 'in_progress', conclusion: '', headBranch: 'beta', event: 'workflow_dispatch' },
          ...newRuns,
        ])
      }
      if (a === 'run' && b === 'download') {
        const id = args[2]
        const dir = args[args.indexOf('--dir') + 1]
        if (id === '40') throw new Error('no valid artifacts found to download')
        if (id === '20') { files.set(`${dir}/record.json`, JSON.stringify({ schema: 1, entries: [{ cli: 'codex', version: '0.171.0', result: 'green', at: '2026-11-21T00:00:00.000Z', ciRun: null }, { cli: 'claude', version: '2.1.329', result: 'green', at: '2026-11-21T00:00:00.000Z', ciRun: null }] })); return '' }
        if (id === '50') { files.set(`${dir}/record.json`, typeof o.record === 'string' ? o.record : JSON.stringify(o.record)); return '' }
        throw new Error(`unexpected download ${id}`)
      }
      if (a === 'workflow' && b === 'run') {
        dispatched.push(args)
        newRuns.push({ databaseId: 101, createdAt: new Date(clock.t + 3000).toISOString(), url: 'https://github.com/o/r/actions/runs/101', status: 'queued', conclusion: '', headBranch: 'beta', event: 'workflow_dispatch' })
        return ''
      }
      if (a === 'run' && b === 'view') {
        polls += 1
        const done = !o.neverCompletes && polls >= 3
        return JSON.stringify({ status: done ? 'completed' : 'in_progress', conclusion: done ? (o.runConclusion ?? 'success') : '', url: 'https://github.com/o/r/actions/runs/101', jobs: jobsFor().map((j) => ({ status: 'completed', url: 'https://github.com/o/r/actions/runs/101/job/1', ...j })) })
      }
      if (a === 'issue' && b === 'list') {
        return JSON.stringify(planningIssues)
      }
      if (a === 'issue' && b === 'create') { created.push(args); return 'https://github.com/nubbymong/aicc_planning/issues/999\n' }
      if (a === 'issue' && b === 'edit') { edited.push(args); return '' }
      throw new Error(`unexpected gh ${args.join(' ')}`)
    },
    timing: { newRunWaitMs: 60_000, newRunPollMs: 5_000, runWaitMs: 10 * 60_000, runPollMs: 30_000 },
  }
  const baseEnv = { GITHUB_OUTPUT: 'OUT', GITHUB_STEP_SUMMARY: 'SUM', RUNNER_TEMP: '/tmp/r', GITHUB_REPOSITORY: 'o/r', GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '777', ...o.env }
  return { deps, gh, npm, outputs, outputLines, get summary() { return summary }, log, files, dispatched, created, edited, clock, baseEnv, planningIssues }
}

const NEWEST = { codex: '0.171.0', claude: '2.1.329' }
const installSteps = (cli: 'codex' | 'claude', version: string) => [
  { name: 'Set up job', conclusion: 'success' },
  { name: 'Install dependencies', conclusion: 'success' },
  { name: installStepName(cli, version), conclusion: 'success' },
  { name: 'Post Run actions/checkout', conclusion: 'success' },
]
const goodLegs = (cli: 'codex' | 'claude', conclusions: Record<string, string> = {}, installed: string = NEWEST[cli]) =>
  expectedLegNames(cli).map((name: string, i: number) => ({ name, conclusion: conclusions[RC_OSES[i]] ?? 'success', steps: installSteps(cli, installed) }))
const otherJobs = [
  { name: 'Changelog in sync', conclusion: 'success' },
  { name: 'Codex CLI minimum (ubuntu-latest)', conclusion: 'success' },
  { name: 'Codex CLI pinned (ubuntu-latest)', conclusion: 'success' },
  { name: 'Desktop test gate', conclusion: 'skipped' },
  { name: 'Test (${{ matrix.os }})', conclusion: 'skipped' },
]

// ---------------------------------------------------------------------------
describe('versions: a strict plain semver, compared by precedence', () => {
  it('accepts plain and prerelease semver and nothing else', () => {
    for (const v of ['0.171.0', '2.1.329', '10.20.30', '0.172.0-alpha.1', '1.0.0-rc.1', '1.0.0-0']) expect(isVersion(v), v).toBe(true)
    for (const v of [
      '', '1.2', '1.2.3.4', 'v1.2.3', ' 1.2.3', '1.2.3 ', '1.2.3\n', '01.2.3', '1.02.3', '1.2.03', '1.2.3+build', '-1.2.3', '1.2.3-', '1.2.3-01',
      '1.2.3; rm -rf x', '1.2.3 --repo evil/x', '$(id)', '1.2.3`id`', '1.2.3|x', '1.2.3&x', '1.2.3\r', `1.2.3-${'a'.repeat(80)}`, 'latest', '^1.2.3', '1.x.3',
    ]) expect(isVersion(v), JSON.stringify(v)).toBe(false)
    for (const v of [undefined, null, 5, {}, ['1.2.3']]) expect(isVersion(v as never)).toBe(false)
  })

  it('orders numerically, not as text, and a prerelease is below its release', () => {
    expect(compareVersions('0.171.0', '0.170.0')).toBeGreaterThan(0)
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0)
    expect(compareVersions('2.1.329', '2.1.329')).toBe(0)
    expect(compareVersions('2.1.99', '2.1.100')).toBeLessThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-beta')).toBeLessThan(0)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
    expect(compareVersions('0.172.0-alpha.1', '0.171.0')).toBeGreaterThan(0)
  })
})

describe('the tested-up-to versions are read from the app code, not restated', () => {
  it('reads Codex from its contract and Claude Code from the managed-launch floor, in the real files', () => {
    const t = readTested(readRepo)
    const codex = /^export const CODEX_MAX_TESTED_VERSION = '([^']+)'/m.exec(readRepo('src/main/providers/codex/cli-contract.ts'))
    const claude = /^export const CLAUDE_MIN_MANAGED_CLI_VERSION = '([^']+)'/m.exec(readRepo('src/main/providers/claude/managed-launch.ts'))
    expect(codex && claude).toBeTruthy()
    expect(t).toEqual({ codex: codex![1], claude: claude![1] })
    expect(isVersion(t.codex) && isVersion(t.claude)).toBe(true)
  })

  it('names the file and the constant when one is missing or not a plain semver: the watch fails, it never guesses', () => {
    const only = (rel: string, text: string) => (r: string) => (r === rel ? text : readRepo(r))
    expect(() => readTested(only('src/main/providers/codex/cli-contract.ts', "export const OTHER = '1.2.3'\n"))).toThrow(/cli-contract\.ts.*CODEX_MAX_TESTED_VERSION/)
    expect(() => readTested(only('src/main/providers/claude/managed-launch.ts', "export const CLAUDE_MIN_MANAGED_CLI_VERSION = 'latest'\n"))).toThrow(/managed-launch\.ts.*CLAUDE_MIN_MANAGED_CLI_VERSION/)
    expect(() => readTested(() => { throw new Error('ENOENT') })).toThrow(/ENOENT|cli-contract/)
  })
})

describe('the record of checked versions', () => {
  const entry = (cli: string, version: string, result: string, at = '2026-11-20T05:50:00.000Z') => ({ cli, version, result, at, ciRun: 'https://github.com/o/r/actions/runs/5' })

  it('parses a good record and refuses a bad one, naming why', () => {
    const rec = { schema: 1, entries: [entry('codex', '0.171.0', 'green')] }
    expect(parseRecord(JSON.stringify(rec))).toEqual(rec)
    for (const bad of [
      '', 'not json', '[]', '{}', JSON.stringify({ schema: 2, entries: [] }), JSON.stringify({ schema: 1, entries: 'x' }),
      JSON.stringify({ schema: 1, entries: [entry('gemini', '1.0.0', 'green')] }),
      JSON.stringify({ schema: 1, entries: [entry('codex', '1.0', 'green')] }),
      JSON.stringify({ schema: 1, entries: [entry('codex', '1.0.0', 'amber')] }),
      JSON.stringify({ schema: 1, entries: [{ ...entry('codex', '1.0.0', 'green'), at: 'yesterday' }] }),
      JSON.stringify({ schema: 1, entries: [{ ...entry('codex', '1.0.0', 'green'), ciRun: 'javascript:alert(1)' }] }),
    ]) expect(() => parseRecord(bad), bad).toThrow(/record/i)
  })

  it('finds a green entry for exactly that CLI and version, and a red one is not green', () => {
    const rec = parseRecord(JSON.stringify({ schema: 1, entries: [entry('codex', '0.171.0', 'green'), entry('claude', '2.1.329', 'red'), entry('claude', '2.1.300', 'green')] }))
    expect(recordedGreen(rec, 'codex', '0.171.0')).toBeTruthy()
    expect(recordedGreen(rec, 'codex', '0.171.1')).toBeNull()
    expect(recordedGreen(rec, 'claude', '2.1.329')).toBeNull()
    expect(recordedGreen(rec, 'claude', '2.1.300')).toBeTruthy()
    expect(recordedGreen(rec, 'codex', '2.1.300')).toBeNull()
  })

  it('merges new results: the newest result of a CLI and version replaces the older one, and the list stays bounded', () => {
    const prev = parseRecord(JSON.stringify({ schema: 1, entries: [entry('claude', '2.1.329', 'red', '2026-11-19T05:50:00.000Z'), entry('codex', '0.170.0', 'green', '2026-11-18T05:50:00.000Z')] }))
    const next = mergeRecord(prev, [{ cli: 'claude', version: '2.1.329', result: 'green' }], { at: '2026-11-21T05:50:00.000Z', ciRun: 'https://github.com/o/r/actions/runs/101' })
    expect(next.entries.filter((e: { cli: string; version: string }) => e.cli === 'claude' && e.version === '2.1.329')).toEqual([{ cli: 'claude', version: '2.1.329', result: 'green', at: '2026-11-21T05:50:00.000Z', ciRun: 'https://github.com/o/r/actions/runs/101' }])
    expect(recordedGreen(next, 'codex', '0.170.0')).toBeTruthy()
    // The input is not changed.
    expect(prev.entries).toHaveLength(2)
    let big = prev
    for (let i = 0; i < 300; i += 1) big = mergeRecord(big, [{ cli: 'codex', version: `0.${200 + i}.0`, result: 'green' }], { at: `2027-01-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`, ciRun: null })
    expect(big.entries.length).toBeLessThanOrEqual(200)
    expect(recordedGreen(big, 'codex', '0.499.0')).toBeTruthy()
  })
})

describe('decide: when a version needs checking', () => {
  const rec = (...e: Array<[string, string, string]>) => parseRecord(JSON.stringify({ schema: 1, entries: e.map(([c, v, r]) => ({ cli: c, version: v, result: r, at: '2026-11-20T05:50:00.000Z', ciRun: null })) }))
  const tested = { codex: '0.170.0', claude: '2.1.278' }

  it('checks a version newer than the tested-up-to one that is not recorded green', () => {
    const d = decide({ tested, latest: { codex: '0.171.0', claude: '2.1.329' }, record: rec() })
    expect(d.codex.action).toBe('check')
    expect(d.claude.action).toBe('check')
    expect(d.codex.reason).toMatch(/0\.171\.0.*0\.170\.0/)
  })

  it('skips a version that is not newer than the tested-up-to one', () => {
    for (const latest of ['0.170.0', '0.169.9', '0.170.0-alpha.1']) expect(decide({ tested, latest: { codex: latest, claude: '2.1.278' }, record: rec() }).codex.action, latest).toBe('skip')
    expect(decide({ tested, latest: { codex: '0.170.0', claude: '2.1.278' }, record: rec() }).claude.action).toBe('skip')
  })

  it('does not run a version already checked green, says so, and runs it again when it was red or another version was green', () => {
    const latest = { codex: '0.171.0', claude: '2.1.329' }
    const d = decide({ tested, latest, record: rec(['codex', '0.171.0', 'green'], ['claude', '2.1.329', 'red']) })
    expect(d.codex.action).toBe('skip')
    expect(d.codex.reason).toMatch(/already checked green/)
    expect(d.claude.action).toBe('check')
    expect(decide({ tested, latest, record: rec(['codex', '0.170.5', 'green']) }).codex.action).toBe('check')
  })
})

describe('the previous record is read with gh, from the newest run that left one', () => {
  const good = { schema: 1, entries: [{ cli: 'codex', version: '0.171.0', result: 'green', at: '2026-11-20T05:50:00.000Z', ciRun: null }] }

  it('skips a cancelled run and a run with no artifact, and reads the first record it can', async () => {
    const w = world({ record: good })
    const rec = await findPreviousRecord({ gh: w.deps.gh, readText: w.deps.readText, dir: '/tmp/r/prev', log: w.deps.log })
    expect(rec).toEqual(good)
    const calls = w.gh.map((c) => c.args.join(' '))
    expect(calls[0]).toMatch(new RegExp(`^run list --workflow ${WATCH_WORKFLOW} `))
    expect(calls.some((c) => c.startsWith('run download 30 '))).toBe(false)
    expect(calls.filter((c) => c.startsWith('run download')).map((c) => c.split(' ')[2])).toEqual(['40', '50'])
    expect(calls.find((c) => c.startsWith('run download 50'))).toContain(`--name ${RECORD_ARTIFACT}`)
  })

  it('is an empty record when no run ever left one, and says so', async () => {
    const w = world()
    const rec = await findPreviousRecord({ gh: w.deps.gh, readText: w.deps.readText, dir: '/tmp/r/prev', log: w.deps.log })
    expect(rec).toEqual({ schema: 1, entries: [] })
    expect(w.log.join('\n')).toMatch(/no earlier record/i)
  })

  it('reads the record only from scheduled or manually started runs of the watch', async () => {
    const w = world({ record: good, plantedRun: true })
    const rec = await findPreviousRecord({ gh: w.deps.gh, readText: w.deps.readText, dir: '/tmp/r/prev', log: w.deps.log })
    expect(rec).toEqual(good)
    const calls = w.gh.map((c) => c.args.join(' '))
    expect(calls[0]).toMatch(/--json [^ ]*\bevent\b/)
    expect(calls.some((c) => c.startsWith('run download 20 '))).toBe(false)
    expect(w.log.join('\n')).toMatch(/run 20 was passed over/)
  })

  it('takes a record from a manual start, and passes over a run of any other kind or with none named', async () => {
    const manual = world({ record: good, recordEvent: 'workflow_dispatch' })
    expect(await findPreviousRecord({ gh: manual.deps.gh, readText: manual.deps.readText, dir: '/tmp/r/prev', log: manual.deps.log })).toEqual(good)
    for (const ev of ['pull_request', 'push', 'workflow_run', 'pull_request_target', 'issues', null]) {
      const w = world({ record: good, recordEvent: ev })
      expect(await findPreviousRecord({ gh: w.deps.gh, readText: w.deps.readText, dir: '/tmp/r/prev', log: w.deps.log }), String(ev)).toEqual({ schema: 1, entries: [] })
      expect(w.gh.some((c) => c.args[1] === 'download' && c.args[2] === '50'), String(ev)).toBe(false)
    }
  })

  it('plans a version that only a passed-over run marks green: it is checked, not skipped', async () => {
    const w = world({ record: { schema: 1, entries: [] }, plantedRun: true })
    expect(await main(['plan'], w.baseEnv, w.deps)).toBe(0)
    expect(w.outputs.codex_version).toBe('0.171.0')
    expect(w.outputs.claude_version).toBe('2.1.329')
    expect(JSON.parse(w.outputs.record)).toEqual({ schema: 1, entries: [] })
  })

  it('passes over a record that does not parse instead of trusting it', async () => {
    const w = world({ record: '{"schema":1,"entries":[{"cli":"codex","version":"x","result":"green","at":"2026-11-20T05:50:00.000Z"}]}' })
    const rec = await findPreviousRecord({ gh: w.deps.gh, readText: w.deps.readText, dir: '/tmp/r/prev', log: w.deps.log })
    expect(rec).toEqual({ schema: 1, entries: [] })
    expect(w.log.join('\n')).toMatch(/not a valid record/i)
  })
})

describe('dispatchAndWait: one ci.yml run on beta, found by its id and waited for', () => {
  it('dispatches ci.yml on the ref with only the inputs asked for, finds the new run among older ones, and waits for it', async () => {
    const w = world({ jobs: [...goodLegs('codex'), ...otherJobs] })
    const run = await dispatchAndWait({ gh: w.deps.gh, sleep: w.deps.sleep, now: w.deps.now, ref: 'beta', inputs: { codex_rc_version: '0.171.0' }, timing: w.deps.timing })
    expect(w.dispatched).toEqual([['workflow', 'run', CI_WORKFLOW, '--ref', 'beta', '-f', 'codex_rc_version=0.171.0']])
    expect(run.runId).toBe('101')
    expect(run.url).toBe('https://github.com/o/r/actions/runs/101')
    expect(run.status).toBe('completed')
    expect(run.conclusion).toBe('success')
    expect(run.timedOut).toBe(false)
    expect(run.jobs.length).toBe(goodLegs('codex').length + otherJobs.length)
  })

  it('passes both inputs when both CLIs are asked for', async () => {
    const w = world({ jobs: [] })
    await dispatchAndWait({ gh: w.deps.gh, sleep: w.deps.sleep, now: w.deps.now, ref: 'beta', inputs: { codex_rc_version: '0.171.0', claude_rc_version: '2.1.329' }, timing: w.deps.timing })
    expect(w.dispatched[0]).toEqual(['workflow', 'run', CI_WORKFLOW, '--ref', 'beta', '-f', 'codex_rc_version=0.171.0', '-f', 'claude_rc_version=2.1.329'])
  })

  it('refuses an input that is not a plain semver or a ref that is not a plain branch name before it calls gh', async () => {
    const w = world()
    await expect(dispatchAndWait({ gh: w.deps.gh, sleep: w.deps.sleep, now: w.deps.now, ref: 'beta', inputs: { codex_rc_version: '0.171.0; id' }, timing: w.deps.timing })).rejects.toThrow(/plain semver/)
    await expect(dispatchAndWait({ gh: w.deps.gh, sleep: w.deps.sleep, now: w.deps.now, ref: '--repo=evil/x', inputs: { codex_rc_version: '0.171.0' }, timing: w.deps.timing })).rejects.toThrow(/ref/)
    await expect(dispatchAndWait({ gh: w.deps.gh, sleep: w.deps.sleep, now: w.deps.now, ref: 'beta', inputs: { 'x; y': '0.171.0' }, timing: w.deps.timing })).rejects.toThrow(/input/)
    expect(w.gh).toEqual([])
  })

  it('reports a run that does not finish in time as timed out, never as passed', async () => {
    const w = world({ neverCompletes: true })
    const run = await dispatchAndWait({ gh: w.deps.gh, sleep: w.deps.sleep, now: w.deps.now, ref: 'beta', inputs: { codex_rc_version: '0.171.0' }, timing: w.deps.timing })
    expect(run.timedOut).toBe(true)
    expect(run.runId).toBe('101')
  })

  it('fails when no new run ever shows up', async () => {
    const w = world()
    const gh = async (args: string[], o?: { token?: string }) => (args[0] === 'workflow' ? '' : w.deps.gh(args, o))
    await expect(dispatchAndWait({ gh, sleep: w.deps.sleep, now: w.deps.now, ref: 'beta', inputs: { codex_rc_version: '0.171.0' }, timing: w.deps.timing })).rejects.toThrow(/no new .*run/i)
  })

  it('says what a refused dispatch means when ci.yml has no dispatch trigger on the ref', async () => {
    const w = world()
    const gh = async (args: string[]) => { if (args[0] === 'workflow') throw new Error("HTTP 422: Workflow does not have 'workflow_dispatch' trigger"); return '[]' }
    await expect(dispatchAndWait({ gh, sleep: w.deps.sleep, now: w.deps.now, ref: 'beta', inputs: { codex_rc_version: '0.171.0' }, timing: w.deps.timing })).rejects.toThrow(/workflow_dispatch.*default branch|default branch.*workflow_dispatch/s)
  })
})

describe('dispatchAndWait: a failed poll is tried again, and the run link is kept', () => {
  const asked = { ref: 'beta', inputs: { codex_rc_version: '0.171.0' } }
  const flaky = (w: ReturnType<typeof world>, fails: (args: string[], n: number) => boolean) => {
    const seen = new Map<string, number>()
    return async (args: string[], o?: { token?: string }) => {
      const key = args.slice(0, 2).join(' ')
      const n = (seen.get(key) ?? 0) + 1
      seen.set(key, n)
      if (fails(args, n)) throw new Error(`gh ${key} failed: HTTP 502: Bad Gateway`)
      return w.deps.gh(args, o)
    }
  }

  it('gives the same result when one read of the run fails and the next works', async () => {
    const jobs = [...goodLegs('codex'), ...otherJobs]
    const clean = world({ jobs })
    const expected = await dispatchAndWait({ gh: clean.deps.gh, sleep: clean.deps.sleep, now: clean.deps.now, ...asked, timing: clean.deps.timing })
    const w = world({ jobs })
    const lines: string[] = []
    const run = await dispatchAndWait({ gh: flaky(w, (a, n) => a[1] === 'view' && n === 2), sleep: w.deps.sleep, now: w.deps.now, ...asked, timing: w.deps.timing, log: (l: string) => lines.push(l) })
    expect(run).toEqual(expected)
    expect(lines.join('\n')).toMatch(/502/)
  })

  it('gives the same result when one look for the new run fails and the next works', async () => {
    const jobs = [...goodLegs('codex'), ...otherJobs]
    const clean = world({ jobs })
    const expected = await dispatchAndWait({ gh: clean.deps.gh, sleep: clean.deps.sleep, now: clean.deps.now, ...asked, timing: clean.deps.timing })
    const w = world({ jobs })
    const run = await dispatchAndWait({ gh: flaky(w, (a, n) => a[1] === 'list' && n === 2), sleep: w.deps.sleep, now: w.deps.now, ...asked, timing: w.deps.timing })
    expect(run).toEqual(expected)
  })

  it('gives up after five reads in a row fail, with the id and link of the run it dispatched on the error', async () => {
    const w = world({ jobs: [...goodLegs('codex'), ...otherJobs] })
    let views = 0
    const inner = flaky(w, () => false)
    const gh = async (args: string[], o?: { token?: string }) => { if (args[1] === 'view') { views += 1; throw new Error('gh run view failed: HTTP 502: Bad Gateway') } return inner(args, o) }
    const err = await dispatchAndWait({ gh, sleep: w.deps.sleep, now: w.deps.now, ...asked, timing: w.deps.timing }).catch((e: unknown) => e) as Error & { runId?: string; runUrl?: string }
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/502/)
    expect(err.runId).toBe('101')
    expect(err.runUrl).toBe('https://github.com/o/r/actions/runs/101')
    expect(views).toBe(5)
  })

  it('gives up after five looks for the new run in a row fail, with no run to name', async () => {
    const w = world()
    let lists = 0
    const gh = async (args: string[], o?: { token?: string }) => {
      if (args[1] === 'list') { lists += 1; if (lists > 1) throw new Error('gh run list failed: HTTP 502: Bad Gateway') }
      return w.deps.gh(args, o)
    }
    const err = await dispatchAndWait({ gh, sleep: w.deps.sleep, now: w.deps.now, ...asked, timing: w.deps.timing }).catch((e: unknown) => e) as Error & { runId?: string }
    expect(err.message).toMatch(/502/)
    expect(err.runId).toBeUndefined()
    expect(lists).toBe(6)
  })

  it('says where to look when the dispatch is refused for an input ci.yml does not take: at the ref, not at a promotion', async () => {
    const w = world()
    const gh = async (args: string[]) => { if (args[0] === 'workflow') throw new Error('HTTP 422: Unexpected inputs provided: ["claude_rc_version"]'); return '[]' }
    const err = await dispatchAndWait({ gh, sleep: w.deps.sleep, now: w.deps.now, ref: 'beta', inputs: { claude_rc_version: '2.1.329' }, timing: w.deps.timing }).catch((e: unknown) => e) as Error
    expect(err.message).toMatch(/Unexpected inputs provided/)
    expect(err.message).toMatch(/look at ci\.yml on beta first/)
    expect(err.message).toMatch(/not the default branch's copy/)
    expect(err.message).not.toMatch(/promotion|arrives with|wait for/i)
  })
})

describe('classifyRun: which check failed for which CLI version', () => {
  const run = (jobs: Array<{ name: string; conclusion: string }>, over: Record<string, unknown> = {}) => ({ runId: '101', url: 'https://github.com/o/r/actions/runs/101', status: 'completed', conclusion: 'success', timedOut: false, jobs: jobs.map((j) => ({ status: 'completed', url: 'u', ...j })), ...over })
  const wanted = { codex: '0.171.0', claude: '2.1.329' }

  it('expects the rc legs on all three operating systems, named as ci.yml names them', () => {
    expect(RC_OSES).toEqual(['windows-2025', 'macos-latest', 'ubuntu-latest'])
    expect(expectedLegNames('codex')).toEqual(['Codex CLI rc (windows-2025)', 'Codex CLI rc (macos-latest)', 'Codex CLI rc (ubuntu-latest)'])
    expect(expectedLegNames('claude')).toEqual(['Claude Code CLI rc (windows-2025)', 'Claude Code CLI rc (macos-latest)', 'Claude Code CLI rc (ubuntu-latest)'])
  })

  it('is green for a CLI when every rc leg passed, and the other checks of the run do not matter to it', () => {
    const r = classifyRun(run([...goodLegs('codex'), ...goodLegs('claude'), ...otherJobs]), wanted)
    expect(r.results.codex).toEqual({ version: '0.171.0', result: 'green', failing: [] })
    expect(r.results.claude).toEqual({ version: '2.1.329', result: 'green', failing: [] })
    expect(r.others).toEqual([])
  })

  it('is red for the CLI whose rc leg failed, naming the leg, and green for the other', () => {
    const r = classifyRun(run([...goodLegs('codex', { 'macos-latest': 'failure' }), ...goodLegs('claude'), ...otherJobs], { conclusion: 'failure' }), wanted)
    expect(r.results.codex.result).toBe('red')
    expect(r.results.codex.failing).toEqual(['Codex CLI rc (macos-latest) (failure)'])
    expect(r.results.claude.result).toBe('green')
  })

  it('treats a cancelled, timed-out, skipped or missing rc leg as red', () => {
    for (const c of ['cancelled', 'timed_out', 'skipped', 'neutral', '']) {
      const r = classifyRun(run([...goodLegs('codex', { 'ubuntu-latest': c }), ...otherJobs]), { codex: '0.171.0' })
      expect(r.results.codex.result, c).toBe('red')
    }
    const missing = classifyRun(run([...goodLegs('codex').slice(0, 2), ...otherJobs]), { codex: '0.171.0' })
    expect(missing.results.codex.result).toBe('red')
    expect(missing.results.codex.failing).toEqual(['Codex CLI rc (ubuntu-latest) (did not run)'])
    const none = classifyRun(run(otherJobs), { codex: '0.171.0' })
    expect(none.results.codex.result).toBe('red')
  })

  it('reports a failing check that belongs to no rc leg as an other check, and does not blame a CLI version for it', () => {
    const r = classifyRun(run([...goodLegs('claude'), { name: 'Codex CLI minimum (windows-2025)', conclusion: 'failure' }, { name: 'Changelog in sync', conclusion: 'failure' }, ...otherJobs], { conclusion: 'failure' }), { claude: '2.1.329' })
    expect(r.results.claude.result).toBe('green')
    expect(r.others).toEqual(['Codex CLI minimum (windows-2025) (failure)', 'Changelog in sync (failure)'])
    expect(r.results.codex).toBeUndefined()
  })

  it('a run that timed out makes every CLI asked for red, saying so, and says which legs had not started', () => {
    const r = classifyRun(run([], { timedOut: true, status: 'in_progress', conclusion: '' }), wanted)
    expect(r.results.codex.result).toBe('red')
    expect(r.results.claude.result).toBe('red')
    expect(r.results.codex.failing[0]).toMatch(/did not finish/)
    expect(r.results.codex.failing).toContain('Codex CLI rc (macos-latest) (had not started)')
  })

  it('a run that timed out still names the legs that already failed, and the ones still running with their status', () => {
    const legs = goodLegs('codex')
    const jobs = [
      { ...legs[0], conclusion: 'failure' },
      { ...legs[1], conclusion: '', status: 'in_progress' },
      legs[2],
      ...otherJobs,
    ]
    const r = classifyRun(run(jobs, { timedOut: true, status: 'in_progress', conclusion: '' }), { codex: '0.171.0' })
    expect(r.results.codex.result).toBe('red')
    expect(r.results.codex.failing).toEqual([
      expect.stringMatching(/did not finish/),
      'Codex CLI rc (windows-2025) (failure)',
      'Codex CLI rc (macos-latest) (in_progress)',
    ])
  })

  it('counts a leg as passed only when it installed the version asked for: a run someone else started for another version is red', () => {
    const r = classifyRun(run([...goodLegs('codex', {}, '0.170.0'), ...goodLegs('claude', {}, '2.1.328'), ...otherJobs]), wanted)
    expect(r.results.codex.result).toBe('red')
    expect(r.results.codex.failing).toEqual(expectedLegNames('codex').map((n: string) => `${n} (did not install 0.171.0)`))
    expect(r.results.claude.failing).toEqual(expectedLegNames('claude').map((n: string) => `${n} (did not install 2.1.329)`))
  })

  it('does not take an install step that failed, was skipped, or belongs to the other CLI, for the install', () => {
    const legs = goodLegs('codex')
    for (const steps of [
      [{ name: installStepName('codex', '0.171.0'), conclusion: 'failure' }],
      [{ name: installStepName('codex', '0.171.0'), conclusion: 'skipped' }],
      [{ name: installStepName('claude', '0.171.0'), conclusion: 'success' }],
      [{ name: `${installStepName('codex', '0.171.0')} twice`, conclusion: 'success' }],
      [],
    ]) {
      const r = classifyRun(run([{ ...legs[0], steps }, legs[1], legs[2], ...otherJobs]), { codex: '0.171.0' })
      expect(r.results.codex.failing, JSON.stringify(steps)).toEqual(['Codex CLI rc (windows-2025) (did not install 0.171.0)'])
    }
  })

  it('names the install step the way ci.yml names it, for both CLIs', () => {
    expect(installStepName('codex', '0.171.0')).toBe('Install Codex 0.171.0 into its own prefix')
    expect(installStepName('claude', '2.1.329')).toBe('Install Claude Code 2.1.329 into its own prefix')
  })

  it('names a run that failed with no failing job, so a red run is never read as passed', () => {
    const r = classifyRun(run([...goodLegs('codex')], { conclusion: 'cancelled' }), { codex: '0.171.0' })
    expect(r.others.join(' ')).toMatch(/cancelled/)
  })

  it('matches the job names ci.yml really produces', () => {
    const ci = yaml.load(readRepo('.github/workflows/ci.yml')) as { jobs: Record<string, { name: string; steps: Array<{ name?: string }>; strategy: { matrix: { os: string[]; cli: unknown } } }> }
    for (const [id, cli] of [['codex-conformance', 'codex'], ['claude-conformance', 'claude']] as const) {
      const job = ci.jobs[id]
      expect(job, `ci.yml has no ${id} job`).toBeDefined()
      expect(job.strategy.matrix.os).toEqual(RC_OSES)
      // The Codex job builds its axis with an expression (the rc leg only when a version was given).
      const cliAxis = typeof job.strategy.matrix.cli === 'string'
        ? evalValue(job.strategy.matrix.cli, { github: { event_name: 'workflow_dispatch' }, inputs: { codex_rc_version: '0.171.0', claude_rc_version: '2.1.329' } })
        : job.strategy.matrix.cli
      expect(cliAxis, `${id} matrix has no rc leg`).toContain('rc')
      const names = RC_OSES.map((os) => String(evalValue(job.name, { matrix: { os, cli: 'rc' } })))
      expect(names, id).toEqual(expectedLegNames(cli))
      // The step the watch reads to know which version the leg installed.
      const stepNames = job.steps.map((s) => String(s.name ?? '')).filter((n) => /into its own prefix/.test(n))
      expect(stepNames, `${id} install step`).toHaveLength(1)
      expect(String(evalValue(stepNames[0], { steps: { ver: { outputs: { version: '9.8.7' } } } })), id).toBe(installStepName(cli, '9.8.7'))
    }
  })

  it('matches the inputs ci.yml takes: one plain-text input per CLI, empty by default', () => {
    const ci = yaml.load(readRepo('.github/workflows/ci.yml')) as { on: { workflow_dispatch: { inputs: Record<string, { type: string; default: string; required: boolean }> } } }
    for (const cli of Object.values(CLIS) as Array<{ input: string }>) {
      const input = ci.on.workflow_dispatch.inputs[cli.input]
      expect(input, `ci.yml has no ${cli.input} input`).toBeDefined()
      expect(input.type).toBe('string')
      expect(input.default).toBe('')
      expect(input.required).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
describe('plan: look up, compare, de-duplicate, report', () => {
  it('asks npm for the newest Codex and Claude Code the way the app installs them, and plans a check for both when newer', async () => {
    const w = world()
    const code = await main(['plan'], w.baseEnv, w.deps)
    expect(code).toBe(0)
    expect(w.npm).toEqual([['view', '@openai/codex', 'version'], ['view', '@anthropic-ai/claude-code', 'version']])
    expect(w.outputs.codex_version).toBe('0.171.0')
    expect(w.outputs.claude_version).toBe('2.1.329')
    expect(w.outputs.any).toBe('true')
    expect(JSON.parse(w.outputs.record)).toEqual({ schema: 1, entries: [] })
    for (const line of w.outputLines) expect(line).not.toMatch(/\n/)
    expect(w.summary).toMatch(/Codex/)
    expect(w.summary).toMatch(/0\.171\.0/)
    expect(w.summary).toMatch(/2\.1\.329/)
    expect(w.summary).toMatch(/0\.170\.0/)
  })

  it('plans nothing when neither is newer than the tested-up-to version, and still keeps the record', async () => {
    const w = world({ codexLatest: '0.170.0', claudeLatest: '2.1.278' })
    expect(await main(['plan'], w.baseEnv, w.deps)).toBe(0)
    expect(w.outputs.any).toBe('false')
    expect(w.outputs.codex_version).toBe('')
    expect(w.outputs.claude_version).toBe('')
    expect(w.files.get('/tmp/r/upstream-cli-watch/record.json')).toBeDefined()
    expect(w.summary).toMatch(/not newer/i)
  })

  it('does not plan a version the record says was already checked green', async () => {
    const w = world({ record: { schema: 1, entries: [{ cli: 'codex', version: '0.171.0', result: 'green', at: '2026-11-20T05:50:00.000Z', ciRun: null }] } })
    expect(await main(['plan'], w.baseEnv, w.deps)).toBe(0)
    expect(w.outputs.codex_version).toBe('')
    expect(w.outputs.claude_version).toBe('2.1.329')
    expect(w.outputs.any).toBe('true')
    expect(w.summary).toMatch(/already checked green/)
    // The carried record is the one the check job gets.
    expect(JSON.parse(w.outputs.record).entries).toHaveLength(1)
  })

  it('fails, naming the CLI, when npm answers with something that is not a plain semver', async () => {
    for (const bad of ['', 'undefined', '0.171.0 --foo', '<html>', '0.171']) {
      const w = world({ codexLatest: bad })
      expect(await main(['plan'], w.baseEnv, w.deps), bad).toBe(1)
      expect(w.log.join('\n')).toMatch(/@openai\/codex.*plain semver/)
      expect(w.outputs.codex_version ?? '').toBe('')
    }
  })

  it('fails when the tested-up-to constant cannot be read', async () => {
    const w = world()
    w.deps.readRepoFile = () => { throw new Error('ENOENT') }
    expect(await main(['plan'], w.baseEnv, w.deps)).toBe(1)
  })
})

describe('check: dispatch, wait, record, and fail on red', () => {
  const env = (w: ReturnType<typeof world>, extra: Record<string, string> = {}) => ({ ...w.baseEnv, WATCH_REF: 'beta', PREVIOUS_RECORD: JSON.stringify({ schema: 1, entries: [] }), ...extra })

  it('green: exits 0, dispatches once with both versions, and records both as green with the run link', async () => {
    const w = world({ jobs: [...goodLegs('codex'), ...goodLegs('claude'), ...otherJobs] })
    expect(await main(['check'], env(w, { CODEX_VERSION: '0.171.0', CLAUDE_VERSION: '2.1.329' }), w.deps)).toBe(0)
    expect(w.dispatched).toHaveLength(1)
    expect(w.dispatched[0]).toEqual(['workflow', 'run', CI_WORKFLOW, '--ref', 'beta', '-f', 'codex_rc_version=0.171.0', '-f', 'claude_rc_version=2.1.329'])
    const rec = parseRecord(w.files.get('/tmp/r/upstream-cli-watch/record.json') as string)
    expect(recordedGreen(rec, 'codex', '0.171.0')?.ciRun).toBe('https://github.com/o/r/actions/runs/101')
    expect(recordedGreen(rec, 'claude', '2.1.329')).toBeTruthy()
    expect(w.outputs.failures).toBe('[]')
    expect(w.summary).toMatch(/Codex 0\.171\.0.*green/is)
  })

  it('red: exits 1, names the CLI, the version, each failing check and the ci.yml run link, and records red', async () => {
    const w = world({ jobs: [...goodLegs('codex', { 'windows-2025': 'failure', 'ubuntu-latest': 'cancelled' }), ...goodLegs('claude'), ...otherJobs], runConclusion: 'failure' })
    expect(await main(['check'], env(w, { CODEX_VERSION: '0.171.0', CLAUDE_VERSION: '2.1.329' }), w.deps)).toBe(1)
    expect(w.summary).toMatch(/Codex 0\.171\.0/)
    expect(w.summary).toContain('Codex CLI rc (windows-2025) (failure)')
    expect(w.summary).toContain('Codex CLI rc (ubuntu-latest) (cancelled)')
    expect(w.summary).toContain('https://github.com/o/r/actions/runs/101')
    const rec = parseRecord(w.files.get('/tmp/r/upstream-cli-watch/record.json') as string)
    expect(recordedGreen(rec, 'codex', '0.171.0')).toBeNull()
    expect(recordedGreen(rec, 'claude', '2.1.329')).toBeTruthy()
    expect(JSON.parse(w.outputs.failures)).toEqual([{ cli: 'codex', version: '0.171.0', failing: ['Codex CLI rc (windows-2025) (failure)', 'Codex CLI rc (ubuntu-latest) (cancelled)'], ciRun: 'https://github.com/o/r/actions/runs/101' }])
  })

  it('red for a failing check outside the rc legs too, but records the CLI versions as the legs say', async () => {
    const w = world({ jobs: [...goodLegs('claude'), { name: 'Codex CLI pinned (macos-latest)', conclusion: 'failure' }, ...otherJobs], runConclusion: 'failure' })
    expect(await main(['check'], env(w, { CLAUDE_VERSION: '2.1.329' }), w.deps)).toBe(1)
    expect(w.summary).toContain('Codex CLI pinned (macos-latest) (failure)')
    const rec = parseRecord(w.files.get('/tmp/r/upstream-cli-watch/record.json') as string)
    expect(recordedGreen(rec, 'claude', '2.1.329')).toBeTruthy()
    expect(w.outputs.failures).toBe('[]')
  })

  it('red when the run does not finish in time', async () => {
    const w = world({ neverCompletes: true })
    expect(await main(['check'], env(w, { CODEX_VERSION: '0.171.0' }), w.deps)).toBe(1)
    expect(w.summary).toMatch(/did not finish/)
  })

  it('red when the run does not finish in time, still naming the leg that had already failed and the one still running', async () => {
    const legs = goodLegs('codex')
    const w = world({ neverCompletes: true, jobs: [{ ...legs[0], conclusion: 'failure' }, { ...legs[1], conclusion: '', status: 'in_progress' }, legs[2], ...otherJobs] })
    expect(await main(['check'], env(w, { CODEX_VERSION: '0.171.0' }), w.deps)).toBe(1)
    expect(w.summary).toMatch(/did not finish/)
    expect(w.summary).toContain('Codex CLI rc (windows-2025) (failure)')
    expect(w.summary).toContain('Codex CLI rc (macos-latest) (in_progress)')
    expect(w.summary).not.toContain('Codex CLI rc (ubuntu-latest)')
    expect(JSON.parse(w.outputs.failures)[0].failing).toHaveLength(3)
  })

  it('survives one failed read of the run while waiting', async () => {
    const w = world({ jobs: [...goodLegs('codex'), ...otherJobs] })
    let views = 0
    const inner = w.deps.gh
    w.deps.gh = async (args: string[], o: { token?: string } = {}) => { if (args[1] === 'view') { views += 1; if (views === 2) throw new Error('gh run view failed: HTTP 502: Bad Gateway') } return inner(args, o) }
    expect(await main(['check'], env(w, { CODEX_VERSION: '0.171.0' }), w.deps)).toBe(0)
    expect(w.summary).toMatch(/Codex 0\.171\.0.*green/is)
    expect(w.log.join('\n')).toMatch(/502/)
  })

  it('when every read of the run fails, says so, links the ci.yml run that was dispatched, and keeps the old record', async () => {
    const w = world({ jobs: [...goodLegs('codex'), ...otherJobs] })
    const inner = w.deps.gh
    w.deps.gh = async (args: string[], o: { token?: string } = {}) => { if (args[1] === 'view') throw new Error('gh run view failed: HTTP 502: Bad Gateway'); return inner(args, o) }
    const previous = JSON.stringify({ schema: 1, entries: [{ cli: 'codex', version: '0.170.0', result: 'green', at: '2026-11-19T05:50:00.000Z', ciRun: null }] })
    expect(await main(['check'], env(w, { CODEX_VERSION: '0.171.0', PREVIOUS_RECORD: previous }), w.deps)).toBe(1)
    expect(w.summary).toMatch(/could not be checked/)
    expect(w.summary).toMatch(/502/)
    expect(w.summary).toContain('https://github.com/o/r/actions/runs/101')
    expect(w.outputs.failures).toBe('[]')
    expect(recordedGreen(parseRecord(w.files.get('/tmp/r/upstream-cli-watch/record.json') as string), 'codex', '0.170.0')).toBeTruthy()
  })

  it('refuses a version that is not a plain semver before it calls gh at all', async () => {
    for (const bad of ['0.171.0 --repo evil/x', '$(id)', '0.171', '-f x=y', '0.171.0\n-f foo=bar']) {
      const w = world()
      expect(await main(['check'], env(w, { CODEX_VERSION: bad }), w.deps), bad).toBe(1)
      expect(w.gh, bad).toEqual([])
    }
  })

  it('refuses a ref that is not a plain branch name, and a run with nothing to check', async () => {
    const w = world()
    expect(await main(['check'], env(w, { CODEX_VERSION: '0.171.0', WATCH_REF: '--ref=x' }), w.deps)).toBe(1)
    expect(await main(['check'], env(w, {}), w.deps)).toBe(1)
    expect(w.gh).toEqual([])
  })

  it('dispatches on beta unless told another ref', async () => {
    const w = world({ jobs: [...goodLegs('codex'), ...otherJobs] })
    const e = env(w, { CODEX_VERSION: '0.171.0' })
    delete (e as Record<string, string | undefined>).WATCH_REF
    expect(await main(['check'], e, w.deps)).toBe(0)
    expect(w.dispatched[0].slice(0, 5)).toEqual(['workflow', 'run', CI_WORKFLOW, '--ref', 'beta'])
  })

  it('refuses a damaged previous record instead of overwriting the history with an empty one', async () => {
    const w = world({ jobs: [...goodLegs('codex'), ...otherJobs] })
    expect(await main(['check'], env(w, { CODEX_VERSION: '0.171.0', PREVIOUS_RECORD: '{"schema":9}' }), w.deps)).toBe(1)
    expect(w.gh).toEqual([])
  })
})

describe('ticket: optional, dormant without its secret, one issue per CLI version', () => {
  const failures = JSON.stringify([{ cli: 'codex', version: '0.171.0', failing: ['Codex CLI rc (windows-2025) (failure)'], ciRun: 'https://github.com/o/r/actions/runs/101' }])
  const env = (w: ReturnType<typeof world>, extra: Record<string, string> = {}) => ({ ...w.baseEnv, FAILURES: failures, WATCH_RUN_URL: 'https://github.com/o/r/actions/runs/777', ...extra })

  it('names the issue exactly, per CLI and version', () => {
    expect(PLANNING_REPO).toBe('nubbymong/aicc_planning')
    expect(ticketTitle('codex', '0.171.0')).toBe('Upstream CLI watch: Codex 0.171.0 fails the conformance checks')
    expect(ticketTitle('claude', '2.1.329')).toBe('Upstream CLI watch: Claude Code 2.1.329 fails the conformance checks')
  })

  it('without the secret it skips with one line and calls nothing', async () => {
    for (const e of [{}, { AICC_PLANNING_ISSUES_TOKEN: '' }, { AICC_PLANNING_ISSUES_TOKEN: '   ' }]) {
      const w = world()
      expect(await main(['ticket'], env(w, e), w.deps)).toBe(0)
      expect(w.gh).toEqual([])
      const lines = w.log.filter((l) => /AICC_PLANNING_ISSUES_TOKEN/.test(l))
      expect(lines).toHaveLength(1)
      expect(lines[0]).not.toContain('\n')
      expect(lines[0]).toMatch(/skip/i)
    }
  })

  it('with the secret and no issue yet, searches by the exact title first and then creates exactly one, with the planning token only', async () => {
    const w = world()
    expect(await main(['ticket'], env(w, { AICC_PLANNING_ISSUES_TOKEN: 'tok-123' }), w.deps)).toBe(0)
    const kinds = w.gh.map((c) => c.args.slice(0, 2).join(' '))
    expect(kinds).toEqual(['issue list', 'issue create'])
    expect(w.gh.every((c) => c.token === 'tok-123')).toBe(true)
    const search = w.gh[0].args
    expect(search).toContain(PLANNING_REPO)
    expect(search.join(' ')).toContain('"Upstream CLI watch: Codex 0.171.0 fails the conformance checks"')
    expect(search).toContain('all')
    expect(w.created).toHaveLength(1)
    expect(w.created[0]).toContain('Upstream CLI watch: Codex 0.171.0 fails the conformance checks')
    expect(JSON.stringify(w.log)).not.toContain('tok-123')
    const bodyFile = w.created[0][w.created[0].indexOf('--body-file') + 1]
    const body = w.files.get(bodyFile) as string
    expect(body).toContain('Codex CLI rc (windows-2025) (failure)')
    expect(body).toContain('https://github.com/o/r/actions/runs/101')
    expect(body).not.toContain('tok-123')
  })

  it('updates the one issue that has that exact title and never opens a second, even when it is closed', async () => {
    for (const state of ['OPEN', 'CLOSED']) {
      const w = world({ planningIssues: [{ number: 41, title: 'Upstream CLI watch: Codex 0.171.0 fails the conformance checks', state }, { number: 42, title: 'Upstream CLI watch: Codex 0.171.0 fails the conformance checks (copy)', state: 'OPEN' }] })
      expect(await main(['ticket'], env(w, { AICC_PLANNING_ISSUES_TOKEN: 'tok-123' }), w.deps)).toBe(0)
      expect(w.created, state).toEqual([])
      expect(w.edited, state).toHaveLength(1)
      expect(w.edited[0].slice(0, 3)).toEqual(['issue', 'edit', '41'])
    }
  })

  it('does not take a different version, or a longer title, for the same issue', async () => {
    const w = world({ planningIssues: [{ number: 40, title: 'Upstream CLI watch: Codex 0.171.00 fails the conformance checks', state: 'OPEN' }, { number: 43, title: 'x Upstream CLI watch: Codex 0.171.0 fails the conformance checks', state: 'OPEN' }] })
    expect(await main(['ticket'], env(w, { AICC_PLANNING_ISSUES_TOKEN: 'tok-123' }), w.deps)).toBe(0)
    expect(w.created).toHaveLength(1)
    expect(w.edited).toEqual([])
  })

  it('refuses failure data that is not what the check job writes, and keeps odd characters out of the issue', async () => {
    const w = world()
    for (const bad of ['not json', '{}', JSON.stringify([{ cli: 'gemini', version: '1.0.0', failing: [], ciRun: null }]), JSON.stringify([{ cli: 'codex', version: '1.0', failing: [], ciRun: null }]), JSON.stringify([{ cli: 'codex', version: '0.171.0', failing: [], ciRun: 'http://evil.example/x' }])]) {
      expect(await main(['ticket'], env(w, { AICC_PLANNING_ISSUES_TOKEN: 'tok-123', FAILURES: bad }), w.deps), bad).toBe(1)
    }
    expect(w.gh).toEqual([])
    const w2 = world()
    const odd = JSON.stringify([{ cli: 'claude', version: '2.1.329', failing: ['Claude Code CLI rc (ubuntu-latest) (failure) <script>@someone`id`'], ciRun: 'https://github.com/o/r/actions/runs/101' }])
    expect(await main(['ticket'], env(w2, { AICC_PLANNING_ISSUES_TOKEN: 'tok-123', FAILURES: odd }), w2.deps)).toBe(0)
    const bodyFile = w2.created[0][w2.created[0].indexOf('--body-file') + 1]
    const body = w2.files.get(bodyFile) as string
    expect(body).not.toMatch(/[<>`@]/)
  })

  it('does nothing and says so when no check failed', async () => {
    const w = world()
    expect(await main(['ticket'], env(w, { AICC_PLANNING_ISSUES_TOKEN: 'tok-123', FAILURES: '[]' }), w.deps)).toBe(0)
    expect(w.gh).toEqual([])
  })
})

describe('main: modes', () => {
  it('refuses an unknown mode', async () => {
    const w = world()
    expect(await main(['frobnicate'], w.baseEnv, w.deps)).toBe(2)
    expect(await main([], w.baseEnv, w.deps)).toBe(2)
  })

  it('never writes a secret, a token or a repository variable: it has no call that could', () => {
    const src = readRepo('scripts/ci/upstream-cli-watch.mjs')
    // The shape every call in the script has (gh([...]) and deps.gh([...])), and the shape of a call that names the file.
    const calls = /\bgh\(\s*\[\s*'(secret|variable|api|auth)'/
    const named = /gh['"],\s*\[?\s*['"](secret|variable|api|auth)['"]/
    expect(src).not.toMatch(calls)
    expect(src).not.toMatch(named)
    expect(src).not.toMatch(/git['"],\s*\[?\s*['"](push|commit)['"]/)
    expect(src).not.toMatch(/process\.env\.GITHUB_TOKEN/)
    // The check can fail: each way of writing one, appended to the real text, is caught.
    for (const mutant of ["await deps.gh(['secret', 'set', 'X'])", "await gh(['variable', 'set', 'X', '--body', 'y'])", "await deps.gh(['api', '-X', 'PATCH', 'repos/o/r'])", "await gh(['auth', 'token'])"]) expect(`${src}\n${mutant}`, mutant).toMatch(calls)
    expect(`${src}\nawait exec('gh', ['secret', 'set', 'X'])`).toMatch(named)
  })

  it('asks gh for exactly these things: list and download runs, dispatch the one workflow, view a run, search, edit and create an issue', () => {
    const src = readRepo('scripts/ci/upstream-cli-watch.mjs')
    const verbs = [...src.matchAll(/\bgh\(\s*\[\s*'([a-z-]+)',\s*'([a-z-]+)'/g)].map((m) => `${m[1]} ${m[2]}`)
    expect(verbs.length).toBeGreaterThan(0)
    expect([...new Set(verbs)].sort()).toEqual(['issue create', 'issue edit', 'issue list', 'run download', 'run list', 'run view', 'workflow run'])
  })
})
