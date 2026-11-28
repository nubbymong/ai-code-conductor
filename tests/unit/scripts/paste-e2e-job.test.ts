import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
import { evalIf, evalValue, type GhaContext } from '../../helpers/gha-expr'
import { TEST_JOB_RE } from '../../../scripts/release-gate.mjs'

/**
 * The Paste e2e (os) job of ci.yml (plan 2.1.3-beta.21 phase 3, 3.2 and 3.3;
 * ADR-032; aicc_planning#447). It builds the app and runs real Claude Code
 * and Codex on the GitHub macOS and Ubuntu runners, so it must start ONLY on
 * a dispatch that names its part (`paste_e2e`: probe or readings), never on a
 * pull request or a push, and must not be one of the checks a PR or the
 * release gate waits for: it is section evidence. Playwright runs with
 * retries off, and each run's report is read by the no-retry check, which
 * runs even after a red Playwright step. On Linux the spec runs once per
 * state of the programs Claude Code reads the clipboard with, under Xvfb,
 * in the order neither, xclip, then wl-paste alone. Its
 * condition is EVALUATED here for each event, as snap-e2e-job.test.ts does.
 * Red on e89996bb: no such job.
 *
 * Not checked here: what the spec asserts (the dispatch shows it).
 */

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')
type Step = { name?: string; if?: unknown; uses?: string; run?: string; shell?: string; env?: Record<string, unknown>; with?: Record<string, unknown> }
type Job = { name?: string; if?: unknown; needs?: unknown; 'runs-on'?: string; env?: Record<string, unknown>; steps: Step[]; strategy?: { matrix: Record<string, unknown> }; permissions?: Record<string, string>; 'continue-on-error'?: unknown; 'timeout-minutes'?: unknown }
type Input = { type?: string; default?: unknown; required?: boolean; description?: string }
const ci = yaml.load(read('.github/workflows/ci.yml')) as { on: { pull_request: { types: string[] }; workflow_dispatch: { inputs: Record<string, Input> } }; jobs: Record<string, Job> }
const job = ci.jobs['paste-e2e']

const REQUIRED_CHECKS = ['Test (windows-2025)', 'Test (macos-latest)']
const OSES = ['macos-latest', 'ubuntu-latest']
const SPEC = 'tests/e2e/paste-unix.spec.ts'

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
  expect(job, 'ci.yml has no `paste-e2e` job').toBeDefined()
  return evalIf(job.if, ctx)
}
const step = (name: string): Step => {
  const s = job.steps.find((x) => x.name === name)
  expect(s, `no step named "${name}"`).toBeDefined()
  return s as Step
}
const names = () => job.steps.map((s) => String(s.name ?? s.uses))
/** Whether a step runs on `os` for the dispatch's part, after earlier steps passed. */
const on = (s: Step, os: 'macOS' | 'Linux', part: string) => s.if === undefined || evalIf(s.if, { ...dispatch({ paste_e2e: part }), runner: { os } })

describe('ci.yml: the Paste e2e job runs only on a dispatch that names its part', () => {
  it('exists, as Paste e2e (macos-latest) and (ubuntu-latest)', () => {
    expect(job, 'ci.yml has no `paste-e2e` job').toBeDefined()
    expect(job.strategy?.matrix.os).toEqual(OSES)
    expect(OSES.map((os) => String(evalValue(job.name, { matrix: { os } })))).toEqual(['Paste e2e (macos-latest)', 'Paste e2e (ubuntu-latest)'])
    expect(OSES.map((os) => String(evalValue(job['runs-on'], { matrix: { os } })))).toEqual(OSES)
    expect(Object.entries(ci.jobs).filter(([, j]) => String(j.name ?? '').startsWith('Paste e2e')).map(([id]) => id)).toEqual(['paste-e2e'])
  })

  it('never starts on a pull request, whatever the action or the labels, nor on a push', () => {
    for (const action of ci.on.pull_request.types) expect(runs(pr(action, action === 'labeled' || action === 'unlabeled' ? 'ci-run' : undefined)), `pull_request ${action}`).toBe(false)
    expect(runs(push()), 'push').toBe(false)
  })

  it('starts on a dispatch with paste_e2e probe or readings, and on no other dispatch', () => {
    expect(runs(dispatch({ paste_e2e: 'probe' }))).toBe(true)
    expect(runs(dispatch({ paste_e2e: 'readings' }))).toBe(true)
    for (const v of ['', 'gate', 'true', 'probe readings']) expect(runs(dispatch({ paste_e2e: v })), JSON.stringify(v)).toBe(false)
    // GitHub compares strings without case, so the spec reads the part in lower case too.
    expect(runs(dispatch({ paste_e2e: 'PROBE' }))).toBe(true)
    expect(read(SPEC)).toContain("(process.env.PASTE_E2E ?? '').toLowerCase()")
    expect(runs(dispatch({}))).toBe(false)
    const others = Object.entries(ci.on.workflow_dispatch.inputs).filter(([name]) => name !== 'paste_e2e')
    expect(others.length, 'the other inputs are read from the workflow').toBeGreaterThan(2)
    const all = Object.fromEntries(others.map(([name, input]) => [name, input.type === 'boolean' ? true : '1.2.3']))
    expect(runs(dispatch(all))).toBe(false)
    expect(runs(dispatch({ ...all, paste_e2e: 'probe' }))).toBe(true)
  })

  it('does not start the Snap e2e job, and the Snap e2e dispatch does not start it', () => {
    expect(evalIf(ci.jobs['snap-e2e'].if, dispatch({ paste_e2e: 'probe' }))).toBe(false)
    expect(runs(dispatch({ snap_e2e: true, snap_e2e_paste: 'probe' }))).toBe(false)
  })

  it('is named by one string input that is empty unless set', () => {
    const input = ci.on.workflow_dispatch.inputs.paste_e2e
    expect(input, 'no paste_e2e dispatch input').toBeDefined()
    expect(input.type).toBe('string')
    expect(input.default).toBe('')
    expect(input.required).toBe(false)
    expect(String(input.description)).toMatch(/probe.*PM1.*PM2.*PL1/)
  })

  it('is none of the required checks, not a Test job, not needed by any job, and not in release.yml or the release gate', () => {
    for (const os of OSES) {
      const name = String(evalValue(job.name, { matrix: { os } }))
      expect(REQUIRED_CHECKS).not.toContain(name)
      expect(name.startsWith('Test (')).toBe(false)
      expect(TEST_JOB_RE.test(name)).toBe(false)
    }
    expect(job.needs).toBeUndefined()
    expect(Object.values(ci.jobs).some((j) => ([] as unknown[]).concat(j.needs ?? []).includes('paste-e2e'))).toBe(false)
    expect(job['continue-on-error']).toBeUndefined()
    expect(read('.github/workflows/release.yml')).not.toMatch(/paste[-_]e2e|paste-unix/)
    expect(read('scripts/release-gate.mjs')).not.toMatch(/paste[-_ ]e2e|paste-unix/i)
  })
})

describe('ci.yml: the Paste e2e job only reads, runs Playwright once per test, and keeps its readings', () => {
  it('has read-only permissions, no secret anywhere, and a checkout that leaves no token on disk', () => {
    expect(job.permissions).toEqual({ contents: 'read' })
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|GITHUB_TOKEN|github\.token/)
    const checkout = job.steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout@'))
    expect(checkout?.with).toEqual({ 'persist-credentials': false })
  })

  it('pins every action by commit', () => {
    const uses = job.steps.filter((s) => s.uses).map((s) => String(s.uses))
    expect(uses.length).toBeGreaterThanOrEqual(4)
    for (const u of uses) expect(u, u).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/)
  })

  it('reads no expression in a shell line, and no runner value in the job env', () => {
    for (const s of job.steps) expect(String(s.run ?? ''), String(s.name)).not.toContain('${{')
    expect(JSON.stringify(job.env ?? {})).not.toContain('runner.')
  })

  it('installs, rebuilds the native modules for Electron, builds the app and installs both CLIs before any Playwright run', () => {
    expect(step('Install dependencies').run).toBe('npm ci --ignore-scripts')
    expect(step('Install Electron binary').run).toBe('node node_modules/electron/install.js')
    expect(String(step('Rebuild native modules').run)).toContain("onlyModules: ['node-pty', 'better-sqlite3']")
    expect(step('Build the app').run).toBe('npm run build')
    const codex = step('Install Codex 0.157.1 into its own prefix')
    expect(String(codex.run).trim()).toBe('npm install --global --prefix "$PREFIX" --ignore-scripts --cache "$NPM_CACHE" --no-audit --no-fund "@openai/codex@$CODEX_VERSION"')
    expect(codex.env?.CODEX_VERSION).toBe('0.157.1')
    const claude = step('Install Claude Code 2.1.332 into its own prefix')
    expect(String(claude.run).trim()).toBe('npm install --global --prefix "$PREFIX" --ignore-scripts --cache "$NPM_CACHE" --no-audit --no-fund "$CLAUDE_PACKAGE@$CLAUDE_VERSION"')
    expect(claude.env?.CLAUDE_VERSION).toBe('2.1.332')
    const firstRun = names().findIndex((n) => n.startsWith('Run the paste end-to-end check'))
    for (const n of ['Build the app', 'Install Codex 0.157.1 into its own prefix', 'Install Claude Code 2.1.332 into its own prefix', 'Locate the installed Claude Code']) expect(names().indexOf(n), n).toBeLessThan(firstRun)
  })

  it('each Playwright run is the one spec, retries off, one worker, its JSON report read by the next step even after a red run', () => {
    const runSteps = job.steps.filter((s) => String(s.name ?? '').startsWith('Run the paste end-to-end check'))
    expect(runSteps.map((s) => s.name)).toEqual([
      'Run the paste end-to-end check (macOS)',
      'Run the paste end-to-end check, neither program (Linux)',
      'Run the paste end-to-end check, xclip (Linux)',
      'Run the paste end-to-end check, wl-paste alone (Linux)',
    ])
    for (const run of runSteps) {
      const cmd = String(run.run).trim()
      const pw = cmd.slice(cmd.indexOf('npx playwright test'))
      expect(pw.startsWith(`npx playwright test ${SPEC} `), cmd).toBe(true)
      expect(pw.split(/\s+/)).toContain('--retries=0')
      expect(pw.split(/\s+/)).toContain('--workers=1')
      expect(cmd.match(/--retries\b/g)).toHaveLength(1)
      expect(cmd).not.toMatch(/--repeat-each|--last-failed|\|\||continue-on-error/)
      expect(pw).toMatch(/--reporter=\S*\bjson\b/)
      expect(run.env?.PASTE_E2E).toBe('${{ inputs.paste_e2e }}')
      expect(run.env?.PASTE_E2E_CODEX).toBe(step('Install Codex 0.157.1 into its own prefix').env?.PREFIX)
      expect(run.env?.PASTE_E2E_CLAUDE).toBe('${{ steps.claudebin.outputs.dir }}')
      const at = job.steps.indexOf(run)
      const check = job.steps[at + 1]
      expect(String(check.name), `the step after "${run.name}"`).toMatch(/^Fail a .*run Playwright retried or reported flaky/)
      expect(String(check.run).trim()).toBe('node scripts/ci/playwright-no-retry.mjs "$REPORT"')
      expect(check.env?.REPORT).toBe(run.env?.PLAYWRIGHT_JSON_OUTPUT_NAME)
      expect(String(check.if)).toContain('!cancelled()')
    }
    const reports = runSteps.map((s) => s.env?.PLAYWRIGHT_JSON_OUTPUT_NAME)
    expect(new Set(reports).size, 'each run its own report').toBe(reports.length)
    expect(read(SPEC)).toContain('PASTE_E2E_CLAUDE')
  })

  it('on Linux: under Xvfb, neither program first (both removed), then xclip, then wl-paste alone; each state named to the spec, for both parts', () => {
    const linux = job.steps.filter((s) => on(s, 'Linux', 'probe') && !on(s, 'macOS', 'probe'))
    const order = ['Let Electron\'s sandbox helper run (Linux)', 'Install Xvfb (Linux)', 'Remove xclip and wl-clipboard (Linux)', 'Run the paste end-to-end check, neither program (Linux)', 'Install xclip (Linux)', 'Run the paste end-to-end check, xclip (Linux)', 'Swap xclip for wl-clipboard (Linux)', 'Run the paste end-to-end check, wl-paste alone (Linux)']
    const at = order.map((n) => names().indexOf(n))
    expect(at.every((i) => i >= 0), JSON.stringify(names())).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    for (const n of order) expect(linux.map((s) => s.name), n).toContain(n)
    expect(String(step('Remove xclip and wl-clipboard (Linux)').run)).toMatch(/apt-get remove -y -q xclip wl-clipboard/)
    expect(String(step('Install xclip (Linux)').run)).toMatch(/apt-get install -y -q xclip$/)
    expect(String(step('Swap xclip for wl-clipboard (Linux)').run)).toMatch(/apt-get remove -y -q xclip\n.*apt-get install -y -q wl-clipboard/)
    const tools = { 'neither program': 'none', xclip: 'xclip', 'wl-paste alone': 'wl-paste' } as const
    for (const [label, value] of Object.entries(tools)) {
      const run = job.steps.find((s) => String(s.name).startsWith(`Run the paste end-to-end check, ${label}`))!
      expect(run.env?.PASTE_E2E_LINUX_TOOLS, label).toBe(value)
      expect(String(run.run).startsWith('xvfb-run -a '), label).toBe(true)
    }
    // Every state for both parts: readings check the hint without xclip,
    // with neither program and with wl-paste alone (PL1).
    for (const n of order) expect(on(step(n), 'Linux', 'readings'), n).toBe(true)
    // None of it on macOS, and the macOS run not on Linux.
    for (const n of order) expect(on(step(n), 'macOS', 'probe'), n).toBe(false)
    expect(on(step('Run the paste end-to-end check (macOS)'), 'Linux', 'probe')).toBe(false)
    expect(on(step('Run the paste end-to-end check (macOS)'), 'macOS', 'readings')).toBe(true)
  })

  it('uploads the readings and the reports as paste-e2e-<os> even when a step failed', () => {
    const upload = step('Upload the readings and the reports')
    expect(String(upload.uses)).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/)
    expect(upload.if).toBe('always()')
    expect(upload.with?.name).toBe('paste-e2e-${{ matrix.os }}')
    expect(String(upload.with?.path)).toContain(String(step('Run the paste end-to-end check (macOS)').env?.PASTE_E2E_OUT))
  })

  it('has a job timeout set per part, which no step raises', () => {
    const minutes = (part: string) => Number(evalValue(job['timeout-minutes'], dispatch({ paste_e2e: part })))
    expect(minutes('probe')).toBe(60)
    expect(minutes('readings')).toBe(50)
    for (const s of job.steps) expect((s as { 'timeout-minutes'?: unknown })['timeout-minutes'], String(s.name)).toBeUndefined()
  })
})
