import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
import { evalIf, evalValue, type GhaContext } from '../../helpers/gha-expr'
import { TEST_JOB_RE } from '../../../scripts/release-gate.mjs'

/**
 * The Probe P19 (os) job of ci.yml (ADR-030, probe P19; plan 2.1.3-beta.11,
 * section A1). It installs two third-party CLIs and runs them, so it must
 * start ONLY on a dispatch that names it, never on a pull request or a push,
 * and must not be one of the checks a PR waits for. Its condition is
 * EVALUATED here for each event, the way helper-ci-job.test.ts evaluates the
 * Helper job's, not matched as text.
 *
 * Not checked here: what the probe measures (helper/probes/README.md; a
 * measurement, not a test), the steps' order and options, and whether the
 * CLIs' packages run install scripts (the job passes --ignore-scripts; that
 * is read in review).
 */

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')
type Job = { name?: string; if?: unknown; needs?: unknown; steps: Array<Record<string, unknown>>; strategy?: { matrix: Record<string, unknown> }; permissions?: Record<string, string>; 'continue-on-error'?: unknown }
type Input = { type?: string; default?: unknown; required?: boolean }
const ci = yaml.load(read('.github/workflows/ci.yml')) as { on: { pull_request: { types: string[] }; workflow_dispatch: { inputs: Record<string, Input> } }; jobs: Record<string, Job> }
const job = ci.jobs['probe-p19']

/** The checks the branch rulesets require (as in ci-cadence.test.ts). */
const REQUIRED_CHECKS = ['Test (windows-2025)', 'Test (macos-latest)']
const OSES = ['windows-2025', 'macos-latest', 'ubuntu-latest']

const pr = (action: string, label?: string): GhaContext => ({
  github: { event_name: 'pull_request', event: { action, ...(label ? { label: { name: label } } : {}), pull_request: { number: 12, labels: [{ name: 'ci-run' }] } } },
  inputs: {},
})
const push = (): GhaContext => ({ github: { event_name: 'push', event: {} }, inputs: {} })
const dispatch = (inputs: Record<string, unknown>): GhaContext => ({ github: { event_name: 'workflow_dispatch', event: { inputs } }, inputs })
const runs = (ctx: GhaContext) => evalIf(job.if, ctx)

describe('ci.yml: the Probe P19 job runs only on a dispatch that names it', () => {
  it('exists, as Probe P19 (os) on windows-2025, macos-latest and ubuntu-latest', () => {
    expect(job, 'ci.yml has no `probe-p19` job').toBeDefined()
    expect(job.strategy?.matrix.os).toEqual(OSES)
    expect(OSES.map((os) => String(evalValue(job.name, { matrix: { os } })))).toEqual(['Probe P19 (windows-2025)', 'Probe P19 (macos-latest)', 'Probe P19 (ubuntu-latest)'])
  })

  it('never starts on a pull request, whatever the action or the labels, nor on a push', () => {
    for (const action of ci.on.pull_request.types) expect(runs(pr(action, action === 'labeled' || action === 'unlabeled' ? 'ci-run' : undefined)), `pull_request ${action}`).toBe(false)
    expect(runs(push()), 'push').toBe(false)
  })

  it('starts on a dispatch with probe_p19 set, and on no other dispatch', () => {
    expect(runs(dispatch({ codex_rc_version: '', conformance_prove_red: false, probe_p19: true }))).toBe(true)
    expect(runs(dispatch({ codex_rc_version: '', conformance_prove_red: false, probe_p19: false }))).toBe(false)
    // A release-level dispatch of the Codex conformance legs does not start it.
    expect(runs(dispatch({ codex_rc_version: '0.160.0', conformance_prove_red: true, probe_p19: false }))).toBe(false)
    expect(runs(dispatch({ codex_rc_version: '', conformance_prove_red: false }))).toBe(false)
    expect(runs(dispatch({}))).toBe(false)
  })

  it('is named by one boolean dispatch input that is off unless set', () => {
    const input = ci.on.workflow_dispatch.inputs.probe_p19
    expect(input, 'no probe_p19 dispatch input').toBeDefined()
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
    expect(Object.values(ci.jobs).some((j) => ([] as unknown[]).concat(j.needs ?? []).includes('probe-p19'))).toBe(false)
  })

  it('only reads: read-only permissions and no secret anywhere in the job', () => {
    expect(job.permissions).toEqual({ contents: 'read' })
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|GITHUB_TOKEN|github\.token/)
    const checkout = job.steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout@'))
    expect(checkout?.with).toEqual({ 'persist-credentials': false })
  })
})
