import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
import { evalIf, evalValue, type GhaContext } from '../../helpers/gha-expr'
import { TEST_JOB_RE } from '../../../scripts/release-gate.mjs'

/**
 * The Snap e2e (os) job of ci.yml (plan 2.1.3-beta.16, section A1;
 * aicc_planning#401). It builds the helper and the app and presses Snap on the
 * GitHub Windows runner's own desktop, so it must start ONLY on a dispatch that
 * names it, never on a pull request or a push, and must not be one of the
 * checks a PR or the release gate waits for: it is section evidence, like a
 * test-machine line. Playwright must run with retries off, and a run the
 * report shows as retried or flaky must fail the job (rule 27). Its condition
 * is EVALUATED here for each event, as probe-p21-job.test.ts does.
 *
 * Not checked here: what the spec asserts (the dispatch shows it), the
 * scripts' judging (snap-e2e-scripts.test.ts), and the steps' bash beyond the
 * flags they pass.
 */

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')
type Step = { name?: string; if?: unknown; uses?: string; run?: string; shell?: string; env?: Record<string, unknown>; with?: Record<string, unknown>; 'working-directory'?: string }
type Job = { name?: string; if?: unknown; needs?: unknown; 'runs-on'?: string; env?: Record<string, unknown>; steps: Step[]; strategy?: { matrix: Record<string, unknown> }; permissions?: Record<string, string>; 'continue-on-error'?: unknown; 'timeout-minutes'?: number }
type Input = { type?: string; default?: unknown; required?: boolean }
const ci = yaml.load(read('.github/workflows/ci.yml')) as { on: { pull_request: { types: string[] }; workflow_dispatch: { inputs: Record<string, Input> } }; jobs: Record<string, Job> }
const job = ci.jobs['snap-e2e']

/** The checks the branch rulesets require (as in ci-cadence.test.ts). */
const REQUIRED_CHECKS = ['Test (windows-2025)', 'Test (macos-latest)']
const OSES = ['windows-2025']
const SPEC = 'tests/e2e/snap-windows.spec.ts'

const pr = (action: string, label?: string): GhaContext => ({
  github: { event_name: 'pull_request', event: { action, ...(label ? { label: { name: label } } : {}), pull_request: { number: 12, labels: [{ name: 'ci-run' }] } } },
  inputs: {},
})
const push = (): GhaContext => ({ github: { event_name: 'push', event: {} }, inputs: {} })
const dispatch = (inputs: Record<string, unknown>): GhaContext => ({
  github: { event_name: 'workflow_dispatch', event: { inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v)])) } },
  inputs,
})
const runs = (ctx: GhaContext) => {
  expect(job, 'ci.yml has no `snap-e2e` job').toBeDefined()
  return evalIf(job.if, ctx)
}
const step = (start: string): Step => {
  const s = job.steps.find((x) => String(x.name ?? '').startsWith(start))
  expect(s, `no step named "${start}..."`).toBeDefined()
  return s as Step
}
const names = () => job.steps.map((s) => String(s.name ?? s.uses))

describe('ci.yml: the Snap e2e job runs only on a dispatch that names it', () => {
  it('exists, as Snap e2e (windows-2025), on the Windows runner only', () => {
    expect(job, 'ci.yml has no `snap-e2e` job').toBeDefined()
    expect(job.strategy?.matrix.os).toEqual(OSES)
    expect(OSES.map((os) => String(evalValue(job.name, { matrix: { os } })))).toEqual(['Snap e2e (windows-2025)'])
    expect(OSES.map((os) => String(evalValue(job['runs-on'], { matrix: { os } })))).toEqual(['windows-2025'])
    expect(Object.entries(ci.jobs).filter(([, j]) => String(j.name ?? '').startsWith('Snap e2e')).map(([id]) => id)).toEqual(['snap-e2e'])
  })

  it('never starts on a pull request, whatever the action or the labels, nor on a push', () => {
    for (const action of ci.on.pull_request.types) expect(runs(pr(action, action === 'labeled' || action === 'unlabeled' ? 'ci-run' : undefined)), `pull_request ${action}`).toBe(false)
    expect(runs(push()), 'push').toBe(false)
  })

  it('starts on a dispatch with snap_e2e set, and on no other dispatch', () => {
    expect(runs(dispatch({ conformance_prove_red: false, snap_e2e: true }))).toBe(true)
    expect(runs(dispatch({ conformance_prove_red: false, snap_e2e: false }))).toBe(false)
    expect(runs(dispatch({}))).toBe(false)
    const others = Object.entries(ci.on.workflow_dispatch.inputs).filter(([name]) => name !== 'snap_e2e')
    expect(others.length, 'the other inputs are read from the workflow').toBeGreaterThan(2)
    const all = Object.fromEntries(others.map(([name, input]) => [name, input.type === 'boolean' ? true : '1.2.3']))
    expect(runs(dispatch(all))).toBe(false)
    expect(runs(dispatch({ ...all, snap_e2e: true }))).toBe(true)
  })

  it('does not start the Probe P21 or the Probe P19 job, and neither of their dispatches starts it', () => {
    expect(evalIf(ci.jobs['probe-p21'].if, dispatch({ snap_e2e: true }))).toBe(false)
    expect(evalIf(ci.jobs['probe-p19'].if, dispatch({ snap_e2e: true }))).toBe(false)
    expect(runs(dispatch({ probe_p21: true }))).toBe(false)
    expect(runs(dispatch({ probe_p19: true }))).toBe(false)
  })

  it('is named by one boolean dispatch input that is off unless set', () => {
    const input = ci.on.workflow_dispatch.inputs.snap_e2e
    expect(input, 'no snap_e2e dispatch input').toBeDefined()
    expect(input.type).toBe('boolean')
    expect(input.default).toBe(false)
    expect(input.required).toBe(false)
  })

  it('is none of the required checks, not a Test job, not needed by any job, and not in release.yml or the release gate', () => {
    for (const os of OSES) {
      const name = String(evalValue(job.name, { matrix: { os } }))
      expect(REQUIRED_CHECKS).not.toContain(name)
      expect(name.startsWith('Test (')).toBe(false)
      expect(TEST_JOB_RE.test(name)).toBe(false)
    }
    expect(job.needs).toBeUndefined()
    expect(Object.values(ci.jobs).some((j) => ([] as unknown[]).concat(j.needs ?? []).includes('snap-e2e'))).toBe(false)
    expect(job['continue-on-error']).toBeUndefined()
    expect(read('.github/workflows/release.yml')).not.toMatch(/snap[-_]e2e|snap-windows/)
    expect(read('scripts/release-gate.mjs')).not.toMatch(/snap[-_ ]e2e|snap-windows/i)
  })
})

describe('ci.yml: the Snap e2e job only reads, runs Playwright once per test, and keeps its readings', () => {
  it('has read-only permissions, no secret anywhere, and a checkout that leaves no token on disk', () => {
    expect(job.permissions).toEqual({ contents: 'read' })
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|GITHUB_TOKEN|github\.token/)
    const checkout = job.steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout@'))
    expect(checkout?.with).toEqual({ 'persist-credentials': false })
  })

  it('pins every action by commit', () => {
    const uses = job.steps.filter((s) => s.uses).map((s) => String(s.uses))
    expect(uses.length).toBeGreaterThanOrEqual(3)
    for (const u of uses) expect(u, u).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/)
  })

  it('reads no expression in a shell line, and no runner value in the job env', () => {
    for (const s of job.steps) expect(String(s.run ?? ''), String(s.name)).not.toContain('${{')
    expect(JSON.stringify(job.env ?? {})).not.toContain('runner.')
  })

  it('builds the helper in release with the lock file and checks its imports, installs as the Windows test jobs do, and builds the app, before Playwright runs', () => {
    const build = step('Build the helper')
    expect(build.run).toBe('cargo build --locked --release --bin aicc-helper')
    expect(build['working-directory']).toBe('helper')
    expect(step('Check the helper carries its own C runtime').run).toBe('node scripts/check-pe-imports.mjs helper/target/release/aicc-helper.exe')
    expect(step('Install dependencies').run).toBe('npm ci --ignore-scripts')
    expect(step('Install Electron binary').run).toBe('node node_modules/electron/install.js')
    expect(step('Build the app').run).toBe('npm run build')
    const order = ['Build the helper (release)', 'Check the helper carries its own C runtime', 'Install dependencies', 'Install Electron binary', 'Build the app', 'Capture from a basic-user token', 'Run the Snap end-to-end check', 'Fail a run Playwright retried or reported flaky', 'Upload the readings and the report']
    const at = order.map((n) => names().indexOf(n))
    expect(at.every((i) => i >= 0), JSON.stringify(names())).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('runs the one spec with retries off and one worker, handing it the built helper', () => {
    const run = step('Run the Snap end-to-end check')
    const cmd = String(run.run).trim()
    expect(cmd.startsWith(`npx playwright test ${SPEC} `), cmd).toBe(true)
    // The flag that turns playwright.config.ts's one retry off, and no other retry setting.
    expect(cmd.split(/\s+/)).toContain('--retries=0')
    expect(cmd.split(/\s+/)).toContain('--workers=1')
    expect(cmd.match(/--retries\b/g)).toHaveLength(1)
    expect(cmd).not.toMatch(/--repeat-each|--last-failed|\|\||continue-on-error/)
    // The JSON report the next step reads is written where it reads it.
    expect(cmd).toMatch(/--reporter=\S*\bjson\b/)
    expect(run.env?.PLAYWRIGHT_JSON_OUTPUT_NAME).toBe(step('Fail a run Playwright retried').env?.REPORT)
    expect(String(run.env?.SNAP_E2E_HELPER)).toMatch(/helper\\target\\release\\aicc-helper\.exe$/)
    expect(String(run.env?.SNAP_E2E_OUT)).toBe('${{ runner.temp }}/snap-e2e')
    expect(read(SPEC)).toContain('SNAP_E2E_HELPER')
  })

  // Plan 2.1.3-beta.18, section 7.5 (aicc_planning#428): the spec's Codex tab
  // runs Codex 0.157.1 from npm, installed as the Probe P19 job installs it.
  it('installs Codex 0.157.1 from npm into a prefix and a cache of its own with scripts off, before Playwright runs, and hands the spec that prefix', () => {
    const install = step('Install Codex 0.157.1 into its own prefix')
    expect(install.shell).toBe('bash')
    expect(String(install.run).trim()).toBe('npm install --global --prefix "$PREFIX" --ignore-scripts --cache "$NPM_CACHE" --no-audit --no-fund "@openai/codex@$CODEX_VERSION"')
    expect(install.env?.CODEX_VERSION).toBe('0.157.1')
    expect(install.env?.PREFIX).toBe('${{ runner.temp }}/snap-codex')
    expect(install.env?.NPM_CACHE).toBe('${{ runner.temp }}/npm-snap-codex-cache')
    expect(names().indexOf('Install Codex 0.157.1 into its own prefix')).toBeLessThan(names().indexOf('Run the Snap end-to-end check'))
    expect(step('Run the Snap end-to-end check').env?.SNAP_E2E_CODEX).toBe(install.env?.PREFIX)
    expect(read(SPEC)).toContain('SNAP_E2E_CODEX')
  })

  it('fails the job when the report shows a retried, flaky or failed test, even after a red Playwright step', () => {
    const check = step('Fail a run Playwright retried or reported flaky')
    expect(String(check.run).trim()).toBe('node scripts/ci/playwright-no-retry.mjs "$REPORT"')
    expect(check.shell).toBe('bash')
    expect(check.if).toBe('${{ !cancelled() }}')
  })

  it('reads one capture from a basic-user token, as a measurement, into the folder it uploads', () => {
    const basic = step('Capture from a basic-user token')
    expect(String(basic.run).trim()).toBe('node scripts/ci/snap-basic-user.mjs --helper helper/target/release/aicc-helper.exe --out "$SNAP_OUT/basic-user"')
    expect(basic.shell).toBe('bash')
    expect(basic.env?.SNAP_OUT).toBe('${{ runner.temp }}/snap-e2e')
  })

  it('uploads the readings and the report as snap-e2e-<os> even when a step failed', () => {
    const upload = step('Upload the readings')
    expect(String(upload.uses)).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/)
    expect(upload.if).toBe('always()')
    expect(upload.with?.name).toBe('snap-e2e-${{ matrix.os }}')
    expect(String(upload.with?.path)).toContain(String(step('Run the Snap end-to-end check').env?.SNAP_E2E_OUT))
  })

  it('has a job timeout, which no step raises', () => {
    expect(job['timeout-minutes']).toBe(45)
    for (const s of job.steps) expect((s as { 'timeout-minutes'?: unknown })['timeout-minutes'], String(s.name)).toBeUndefined()
  })
})

// nubbymong/aicc_planning#445 (review F2): the same dispatch runs the Account
// usage page's layout spec against the built app, after the Snap check and
// whatever it answered, with retries off, and fails on a retried or flaky test
// as the Snap check does; its report goes into the folder that is uploaded.
describe('ci.yml: the Snap e2e dispatch also runs the Account usage layout spec', () => {
  const LAYOUT_SPEC = 'tests/e2e/account-usage-grid.spec.ts'

  it('runs that one spec with retries off and one worker, after the app is built, whatever the Snap check answered', () => {
    const run = step('Run the Account usage layout check')
    const cmd = String(run.run).trim()
    expect(cmd.startsWith(`npx playwright test ${LAYOUT_SPEC} `), cmd).toBe(true)
    expect(cmd.split(/\s+/)).toContain('--retries=0')
    expect(cmd.split(/\s+/)).toContain('--workers=1')
    expect(cmd.match(/--retries\b/g)).toHaveLength(1)
    expect(cmd).not.toMatch(/--repeat-each|--last-failed|\|\||continue-on-error/)
    expect(cmd).toMatch(/--reporter=\S*\bjson\b/)
    expect(run.if).toBe('${{ !cancelled() }}')
    expect(names().indexOf('Build the app')).toBeLessThan(names().indexOf('Run the Account usage layout check'))
    expect(names().indexOf('Run the Snap end-to-end check')).toBeLessThan(names().indexOf('Run the Account usage layout check'))
    expect(read(LAYOUT_SPEC)).toContain('ACCOUNT_USAGE_GRID_CLASS')
  })

  it('fails the job when its report shows a retried, flaky or failed test, and uploads that report', () => {
    const run = step('Run the Account usage layout check')
    const check = step('Fail a layout run Playwright retried or reported flaky')
    expect(String(check.run).trim()).toBe('node scripts/ci/playwright-no-retry.mjs "$REPORT"')
    expect(check.if).toBe('${{ !cancelled() }}')
    expect(check.env?.REPORT).toBe(run.env?.PLAYWRIGHT_JSON_OUTPUT_NAME)
    expect(String(run.env?.PLAYWRIGHT_JSON_OUTPUT_NAME).startsWith(`${String(step('Run the Snap end-to-end check').env?.SNAP_E2E_OUT)}/`)).toBe(true)
    expect(run.env?.PLAYWRIGHT_JSON_OUTPUT_NAME).not.toBe(step('Run the Snap end-to-end check').env?.PLAYWRIGHT_JSON_OUTPUT_NAME)
    expect(names().indexOf('Fail a layout run Playwright retried or reported flaky')).toBeLessThan(names().indexOf('Upload the readings and the report'))
  })
})
