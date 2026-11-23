import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
import { evalIf, evalValue, type GhaContext } from '../../helpers/gha-expr'
import { TEST_JOB_RE } from '../../../scripts/release-gate.mjs'

/**
 * The Probe P21 (os) job of ci.yml (ADR-030, probe P21; plan 2.1.3-beta.15,
 * section B5, aicc_planning#391). It builds the helper and runs its capture
 * mode three times on the GitHub Windows runner, the console reading the test
 * machine could not take, so it must start ONLY on a dispatch that names it,
 * never on a pull request or a push, and must not be one of the checks a PR
 * waits for. Its condition is EVALUATED here for each event, the way
 * probe-p19-job.test.ts evaluates the Probe P19 job's, not matched as text.
 *
 * Not checked here: what the probe measures and how it judges a run
 * (probe-p21.test.ts reads the judging; the measurement is the dispatch), the
 * PowerShell side, whether Rust or the runner's session behave (the dispatch
 * shows it), and the steps' bash beyond the flags it passes.
 */

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')
type Step = { name?: string; if?: unknown; uses?: string; run?: string; shell?: string; env?: Record<string, unknown>; with?: Record<string, unknown>; 'working-directory'?: string }
type Job = { name?: string; if?: unknown; needs?: unknown; 'runs-on'?: string; env?: Record<string, unknown>; steps: Step[]; strategy?: { matrix: Record<string, unknown> }; permissions?: Record<string, string>; 'continue-on-error'?: unknown }
type Input = { type?: string; default?: unknown; required?: boolean }
const ci = yaml.load(read('.github/workflows/ci.yml')) as { on: { pull_request: { types: string[] }; workflow_dispatch: { inputs: Record<string, Input> } }; jobs: Record<string, Job> }
const job = ci.jobs['probe-p21']
const script = read('helper/probes/p21-capture.cjs')

/** The checks the branch rulesets require (as in ci-cadence.test.ts). */
const REQUIRED_CHECKS = ['Test (windows-2025)', 'Test (macos-latest)']
const OSES = ['windows-2025']

const pr = (action: string, label?: string): GhaContext => ({
  github: { event_name: 'pull_request', event: { action, ...(label ? { label: { name: label } } : {}), pull_request: { number: 12, labels: [{ name: 'ci-run' }] } } },
  inputs: {},
})
const push = (): GhaContext => ({ github: { event_name: 'push', event: {} }, inputs: {} })
// GitHub's two views of a dispatch's inputs: the inputs context keeps each
// input's type, github.event.inputs holds every value as a string.
const dispatch = (inputs: Record<string, unknown>): GhaContext => ({
  github: { event_name: 'workflow_dispatch', event: { inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v)])) } },
  inputs,
})
const runs = (ctx: GhaContext) => {
  expect(job, 'ci.yml has no `probe-p21` job').toBeDefined()
  return evalIf(job.if, ctx)
}
const step = (start: string): Step => {
  const s = job.steps.find((x) => String(x.name ?? '').startsWith(start))
  expect(s, `no step named "${start}..."`).toBeDefined()
  return s as Step
}

describe('ci.yml: the Probe P21 job runs only on a dispatch that names it', () => {
  it('exists, as Probe P21 (windows-2025), on the Windows runner only', () => {
    expect(job, 'ci.yml has no `probe-p21` job').toBeDefined()
    expect(job.strategy?.matrix.os).toEqual(OSES)
    expect(OSES.map((os) => String(evalValue(job.name, { matrix: { os } })))).toEqual(['Probe P21 (windows-2025)'])
    expect(OSES.map((os) => String(evalValue(job['runs-on'], { matrix: { os } })))).toEqual(['windows-2025'])
    // The one job of that name: nothing else reports as a Probe P21.
    expect(Object.entries(ci.jobs).filter(([, j]) => String(j.name ?? '').startsWith('Probe P21')).map(([id]) => id)).toEqual(['probe-p21'])
  })

  it('never starts on a pull request, whatever the action or the labels, nor on a push', () => {
    for (const action of ci.on.pull_request.types) expect(runs(pr(action, action === 'labeled' || action === 'unlabeled' ? 'ci-run' : undefined)), `pull_request ${action}`).toBe(false)
    expect(runs(push()), 'push').toBe(false)
  })

  it('starts on a dispatch with probe_p21 set, and on no other dispatch', () => {
    expect(runs(dispatch({ conformance_prove_red: false, probe_p21: true }))).toBe(true)
    expect(runs(dispatch({ conformance_prove_red: false, probe_p21: false }))).toBe(false)
    expect(runs(dispatch({ conformance_prove_red: false }))).toBe(false)
    expect(runs(dispatch({}))).toBe(false)
    // Every other input of the workflow turned on (a boolean true, a text a version): still not it.
    const others = Object.entries(ci.on.workflow_dispatch.inputs).filter(([name]) => name !== 'probe_p21')
    expect(others.length, 'the other inputs are read from the workflow').toBeGreaterThan(2)
    const all = Object.fromEntries(others.map(([name, input]) => [name, input.type === 'boolean' ? true : '1.2.3']))
    expect(runs(dispatch(all))).toBe(false)
    expect(runs(dispatch({ ...all, probe_p21: true }))).toBe(true)
  })

  it('is not started by the Probe P19 dispatch, and does not start it', () => {
    expect(evalIf(ci.jobs['probe-p19'].if, dispatch({ probe_p21: true }))).toBe(false)
    expect(evalIf(ci.jobs['probe-p19'].if, dispatch({ probe_p19: true }))).toBe(true)
    expect(runs(dispatch({ probe_p19: true }))).toBe(false)
  })

  it('is named by one boolean dispatch input that is off unless set', () => {
    const input = ci.on.workflow_dispatch.inputs.probe_p21
    expect(input, 'no probe_p21 dispatch input').toBeDefined()
    expect(input.type).toBe('boolean')
    expect(input.default).toBe(false)
    expect(input.required).toBe(false)
  })

  it('is none of the required checks and does not read as a Test job, so neither a PR nor the release gate waits on it', () => {
    for (const os of OSES) {
      const name = String(evalValue(job.name, { matrix: { os } }))
      expect(REQUIRED_CHECKS).not.toContain(name)
      expect(name.startsWith('Test (')).toBe(false)
      expect(TEST_JOB_RE.test(name)).toBe(false)
    }
    expect(job.needs).toBeUndefined()
    expect(Object.values(ci.jobs).some((j) => ([] as unknown[]).concat(j.needs ?? []).includes('probe-p21'))).toBe(false)
    // A measurement: a verdict that says the mode does not capture is a result, not a red job.
    expect(job['continue-on-error']).toBeUndefined()
  })
})

describe('ci.yml: the Probe P21 job only reads, and takes the console reading', () => {
  it('has read-only permissions, no secret anywhere, and a checkout that leaves no token on disk', () => {
    expect(job.permissions).toEqual({ contents: 'read' })
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|GITHUB_TOKEN|github\.token/)
    const checkout = job.steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout@'))
    expect(checkout?.with).toEqual({ 'persist-credentials': false })
  })

  it('pins every action by commit, as the Helper job does, and installs no package of its own', () => {
    const uses = job.steps.filter((s) => s.uses).map((s) => String(s.uses))
    expect(uses.length).toBeGreaterThanOrEqual(2)
    for (const u of uses) expect(u, u).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/)
    for (const s of job.steps) expect(String(s.run ?? ''), String(s.name)).not.toMatch(/\b(npm|npx|pip|choco|winget)\b/)
  })

  it('reads no expression in a shell line: the output folder reaches the step through env, and `runner` is a step context, not a job one', () => {
    for (const s of job.steps) expect(String(s.run ?? ''), String(s.name)).not.toContain('${{')
    // The runner context is not available in a job's env: a value read from it there makes the whole workflow invalid.
    expect(JSON.stringify(job.env ?? {})).not.toContain('runner.')
    expect(step('Run probe P21').env).toEqual({ P21_OUT: '${{ runner.temp }}/probe-p21' })
  })

  it('builds the helper in release with the lock file, before it measures', () => {
    const names = job.steps.map((s) => String(s.name ?? s.uses))
    const build = step('Build the helper')
    expect(build.run).toBe('cargo build --locked --release --bin aicc-helper')
    expect(build['working-directory']).toBe('helper')
    expect(names.indexOf(String(build.name))).toBeLessThan(names.indexOf('Run probe P21'))
  })

  it('measures from the runner\'s own session, then reads the verdict and says the SSH half was not run there', () => {
    const run = String(step('Run probe P21').run)
    const measure = /node helper\/probes\/p21-capture\.cjs measure ([^\n]*)/.exec(run)
    const verdict = /node helper\/probes\/p21-capture\.cjs verdict ([^\n]*)/.exec(run)
    expect(measure, 'no measure command').not.toBeNull()
    expect(verdict, 'no verdict command').not.toBeNull()
    expect(measure![1]).toContain('--helper helper/target/release/aicc-helper.exe')
    expect(measure![1]).toContain('--session console')
    expect(measure![1]).toContain('--out "$P21_OUT"')
    const label = /--label (\S+)/.exec(measure![1])![1]
    // The verdict reads the reading the measurement wrote, by its label.
    expect(verdict![1]).toContain(`--console ${label}`)
    expect(verdict![1]).toContain('--out "$P21_OUT"')
    // The SSH half is said not to have run, with a reason; no SSH reading is named.
    expect(verdict![1]).toMatch(/--ssh-not-run "[^"]{20,}"/)
    expect(verdict![1]).not.toMatch(/--ssh\s/)
    // Every flag it passes is one the probe's own usage lines name.
    for (const flag of new Set([...measure![1].matchAll(/--[a-z-]+/g), ...verdict![1].matchAll(/--[a-z-]+/g)].map((m) => m[0]))) expect(script, flag).toContain(flag)
    // The verdict is read only when the measurement ran to its end, and the step ends with the status of the failing one.
    expect(run).toMatch(/if \[ "\$rc" = 0 \]; then/)
    expect(run).toMatch(/exit "\$rc"\s*$/)
    // The lines are in the job summary too.
    expect(run).toContain('>> "$GITHUB_STEP_SUMMARY"')
  })

  it('uploads the readings and the verdict as probe-p21-<os> even when the probe could not run', () => {
    const upload = step('Upload the readings')
    expect(String(upload.uses)).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/)
    expect(upload.if).toBe('always()')
    expect(upload.with?.name).toBe('probe-p21-${{ matrix.os }}')
    // The folder the probe writes to is the folder uploaded.
    expect(String(upload.with?.path)).toBe(String(step('Run probe P21').env?.P21_OUT))
  })
})
