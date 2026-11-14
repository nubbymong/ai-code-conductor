import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
import { evalExpr, evalIf, evalValue, type GhaContext } from '../../helpers/gha-expr'
import { testedTreeStep, CI_WORKFLOW_PATH } from '../../../scripts/ci/reuse-green-ci.mjs'

/**
 * The fast beta cadence (ADR-028), as the workflows carry it out. The
 * conditions are EVALUATED here against the events GitHub sends, not matched
 * as text: what matters is which runs start, which are cancelled and which
 * checks report, and a condition can read right and do the wrong thing.
 */

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')
type Step = { name?: string; id?: string; if?: unknown; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; shell?: string; 'continue-on-error'?: unknown }
type Job = { name?: string; if?: unknown; needs?: string | string[]; steps: Step[]; permissions?: Record<string, string>; outputs?: Record<string, string>; strategy?: { matrix: Record<string, unknown> }; 'runs-on'?: string; 'continue-on-error'?: unknown; concurrency?: unknown }
type Workflow = { on: Record<string, any>; jobs: Record<string, Job>; concurrency?: { group: string; 'cancel-in-progress': unknown }; permissions?: Record<string, string> }
const load = (p: string) => yaml.load(read(p)) as Workflow

const ci = load('.github/workflows/ci.yml')
const release = load('.github/workflows/release.yml')

/** The checks the three branch rulesets require (protect-beta, protect-main,
 *  protect-release-lines), as read on 2026-11-14. Rulesets are not in the
 *  repository, so the names are held here: a job renamed away from one of
 *  them would leave every PR waiting on a check that never reports. */
const REQUIRED_CHECKS = ['Test (windows-2025)', 'Test (macos-latest)']

// ── The events ──────────────────────────────────────────────────────
/** `base` is the PR's base branch now; `changes` is what an `edited` event
 *  says changed (GitHub sends `changes.base.ref.from` only when the base did). */
type PrOpts = { labels?: string[]; label?: string; number?: number; runId?: number; base?: string | null; changes?: Record<string, unknown> }
const pr = (action: string, { labels = [], label, number = 12, runId = 5001, base = 'beta', changes }: PrOpts = {}): GhaContext => ({
  github: {
    event_name: 'pull_request', run_id: runId, workflow: 'CI', ref: `refs/pull/${number}/merge`, head_ref: 'fix/thing', base_ref: base ?? '',
    event: {
      action, number, ...(label ? { label: { name: label } } : {}), ...(changes ? { changes } : {}),
      pull_request: { number, labels: labels.map((name) => ({ name })), ...(base === null ? {} : { base: { ref: base } }) },
    },
  },
  inputs: {},
})
/** The two kinds of `edited` event: the base branch was changed, or only text was. */
const retargeted = (from: string, opts: PrOpts = {}) => pr('edited', { ...opts, changes: { base: { ref: { from }, sha: { from: 'a'.repeat(40) } } } })
const textEdited = (opts: PrOpts = {}) => pr('edited', { ...opts, changes: { title: { from: 'old title' }, body: { from: 'old text' } } })
const push = (runId = 7001, ref = 'refs/heads/main'): GhaContext => ({ github: { event_name: 'push', run_id: runId, workflow: 'CI', ref, head_ref: '', event: {} }, inputs: {} })
const dispatch = (runId = 9001): GhaContext => ({ github: { event_name: 'workflow_dispatch', run_id: runId, workflow: 'CI', ref: 'refs/heads/beta', head_ref: '', event: {} }, inputs: { codex_rc_version: '', conformance_prove_red: false } })

const group = (ctx: GhaContext) => String(evalValue(ci.concurrency!.group, ctx))
const cancels = (ctx: GhaContext) => evalIf(ci.concurrency!['cancel-in-progress'], ctx)
const runs = (job: string, ctx: GhaContext) => evalIf(ci.jobs[job].if, ctx)

describe('the expression evaluator the workflow tests stand on', () => {
  it('reads GitHub expressions as GitHub does: precedence, operand values, loose and case-blind comparison, the .* filter', () => {
    const ctx: GhaContext = { github: { event_name: 'pull_request', event: { pull_request: { labels: [{ name: 'ci-run' }, { name: 'Bug' }] } } }, inputs: { on: true }, steps: { a: { outputs: { v: 'true' } } } }
    expect(evalExpr("true || false && false", ctx)).toBe(true)
    expect(evalExpr("(true || false) && false", ctx)).toBe(false)
    expect(evalExpr("false && 'x' || 'y'", ctx)).toBe('y')
    expect(evalExpr("true && 'x' || 'y'", ctx)).toBe('x')
    expect(evalExpr("github.event_name == 'PULL_REQUEST'", ctx)).toBe(true)
    expect(evalExpr("github.event_name != 'push'", ctx)).toBe(true)
    expect(evalExpr("contains(github.event.pull_request.labels.*.name, 'ci-run')", ctx)).toBe(true)
    expect(evalExpr("contains(github.event.pull_request.labels.*.name, 'bug')", ctx)).toBe(true)
    expect(evalExpr("contains(github.event.pull_request.labels.*.name, 'ci')", ctx)).toBe(false)
    expect(evalExpr("contains('release/v1', 'RELEASE/')", ctx)).toBe(true)
    expect(evalExpr("github.event.label.name == 'ci-run'", ctx)).toBe(false)
    expect(evalExpr("github.event.label.name", ctx)).toBe(null)
    expect(evalExpr("steps.a.outputs.v != 'false'", ctx)).toBe(true)
    expect(evalExpr("steps.missing.outputs.v != 'false'", ctx)).toBe(true)
    expect(evalExpr("steps.missing.outputs.v == ''", ctx)).toBe(true)
    expect(evalExpr("!inputs.on", ctx)).toBe(false)
    expect(evalExpr("format('a-{0}-{1}', 7, 'b')", ctx)).toBe('a-7-b')
    expect(evalExpr("startsWith('release/x', 'release/') && !cancelled()", ctx)).toBe(true)
    expect(evalExpr("'it''s'", ctx)).toBe("it's")
    expect(evalValue("${{ inputs.on && 'yes' || 'no' }}", ctx)).toBe('yes')
    expect(evalValue("pre-${{ github.event_name }}-post", ctx)).toBe('pre-pull_request-post')
    expect(evalIf("${{ !inputs.on }}", ctx)).toBe(false)
    expect(evalIf(undefined, ctx)).toBe(true)
    expect(() => evalExpr("hashFiles('x')", ctx)).toThrow(/unsupported function/)
    expect(() => evalExpr("nope.x == 1", ctx)).toThrow(/unknown context/)
    expect(() => evalExpr("github.event_name ==", ctx)).toThrow()
  })
})

describe('ci.yml: a newer run supersedes the older one, and only where that is safe', () => {
  it('starts on every PR event the label and base checks need, and on a push to main only', () => {
    expect(ci.on.pull_request.types).toEqual(['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled', 'edited'])
    expect(ci.on.pull_request.branches).toEqual(['main', 'beta', 'release/**'])
    expect(ci.on.push).toEqual({ branches: ['main'] })
    // No workflow-level path filter: a run that never starts never reports, and
    // a required check that never reports blocks the merge.
    for (const ev of ['pull_request', 'push']) for (const k of ['paths', 'paths-ignore']) expect(ci.on[ev][k], `${ev}.${k}`).toBeUndefined()
  })

  it('a push to the same PR cancels the run before it; another PR, a push to main and a dispatch are never cancelled', () => {
    expect(ci.concurrency, 'ci.yml has no concurrency').toBeDefined()
    // The code events of one PR share a group, and that group cancels.
    const code = group(pr('synchronize'))
    expect(code).toBe('ci-pr-12')
    for (const action of ['opened', 'reopened', 'synchronize']) {
      expect(group(pr(action, { labels: ['ci-run'] })), action).toBe(code)
      expect(cancels(pr(action)), action).toBe(true)
    }
    expect(group(pr('synchronize', { runId: 5002 }))).toBe(code)
    expect(group(pr('synchronize', { number: 13 }))).toBe('ci-pr-13')
    // A push (main is the only branch that pushes here) and a dispatch each get
    // a group of their own, so nothing can cancel them and none waits on another.
    expect(group(push(7001))).toBe('ci-run-7001')
    expect(group(push(7002))).toBe('ci-run-7002')
    expect(cancels(push())).toBe(false)
    expect(group(dispatch(9001))).toBe('ci-run-9001')
    expect(cancels(dispatch())).toBe(false)
    for (const ref of ['refs/heads/main', 'refs/heads/beta', 'refs/heads/release/v2.1.3']) expect(cancels(push(7003, ref)), ref).toBe(false)
  })

  it('a label change never cancels the tests of the same PR: it runs in a group of its own, except the ci-run label that asks for them', () => {
    const code = group(pr('synchronize', { labels: ['ci-run'] }))
    const labels = 'ci-pr-12-labels'
    expect(group(pr('labeled', { labels: ['ci-run', 'desktop-tested'], label: 'desktop-tested' }))).toBe(labels)
    expect(group(pr('labeled', { labels: ['ci-run', 'runtime-validated'], label: 'runtime-validated' }))).toBe(labels)
    expect(group(pr('unlabeled', { labels: ['ci-run'], label: 'desktop-tested' }))).toBe(labels)
    expect(group(pr('unlabeled', { labels: [], label: 'ci-run' }))).toBe(labels)
    expect(labels).not.toBe(code)
    // Adding ci-run asks for a test run: it joins the code group and replaces the run in it.
    expect(group(pr('labeled', { labels: ['ci-run'], label: 'ci-run' }))).toBe(code)
    // Label runs of another PR are apart too.
    expect(group(pr('labeled', { labels: ['x'], label: 'x', number: 13 }))).toBe('ci-pr-13-labels')
  })

  it('an edit of the title or description never cancels the tests either; a change of base branch is a code event and does', () => {
    const code = group(pr('synchronize', { labels: ['ci-run'] }))
    expect(group(textEdited({ labels: ['ci-run'] }))).toBe('ci-pr-12-labels')
    expect(group(pr('edited', { labels: ['ci-run'] }))).toBe('ci-pr-12-labels')
    expect(group(pr('edited', { labels: ['ci-run'], changes: {} }))).toBe('ci-pr-12-labels')
    expect(group(textEdited({ number: 13 }))).toBe('ci-pr-13-labels')
    // The merge under test changed: the run on the old base is superseded.
    expect(group(retargeted('beta', { labels: ['ci-run'], base: 'main' }))).toBe(code)
    expect(group(retargeted('main', { base: 'beta' }))).toBe(code)
    expect(cancels(retargeted('beta', { base: 'main' }))).toBe(true)
  })

  it('no job has a concurrency of its own, and no other workflow cancels a run', () => {
    for (const [id, job] of Object.entries(ci.jobs)) expect(job.concurrency, id).toBeUndefined()
    // The release is never cancelled or queued behind another: it has no concurrency at all.
    expect(release.concurrency).toBeUndefined()
    for (const [id, job] of Object.entries(release.jobs)) expect(job.concurrency, id).toBeUndefined()
    expect(Object.keys(release.on)).toEqual(['workflow_dispatch'])
  })
})

describe('ci.yml: a label change does not restart the tests', () => {
  const MATRIX_JOBS = ['test', 'codex-conformance']

  it('the OS matrices run on a push, on a PR event that carries ci-run, and when ci-run is added: on no other label change', () => {
    for (const job of MATRIX_JOBS) {
      expect(runs(job, push()), job).toBe(true)
      for (const action of ['opened', 'synchronize', 'reopened']) {
        expect(runs(job, pr(action, { labels: ['ci-run'] })), `${job} ${action} with ci-run`).toBe(true)
        expect(runs(job, pr(action, { labels: ['desktop-tested'] })), `${job} ${action} without ci-run`).toBe(false)
        expect(runs(job, pr(action)), `${job} ${action} with no label`).toBe(false)
      }
      expect(runs(job, pr('labeled', { labels: ['ci-run'], label: 'ci-run' })), `${job}: ci-run added`).toBe(true)
      expect(runs(job, pr('labeled', { labels: ['ci-run', 'desktop-tested'], label: 'desktop-tested' })), `${job}: another label added`).toBe(false)
      expect(runs(job, pr('labeled', { labels: ['ci-run', 'in-beta'], label: 'in-beta' })), `${job}: another label added`).toBe(false)
      expect(runs(job, pr('unlabeled', { labels: ['ci-run'], label: 'desktop-tested' })), `${job}: a label removed`).toBe(false)
      expect(runs(job, pr('unlabeled', { labels: [], label: 'ci-run' })), `${job}: ci-run removed`).toBe(false)
      // An edit is not a code change either, unless it changes the base branch.
      expect(runs(job, textEdited({ labels: ['ci-run'] })), `${job}: title edited`).toBe(false)
      expect(runs(job, pr('edited', { labels: ['ci-run'] })), `${job}: edited, nothing named`).toBe(false)
      expect(runs(job, retargeted('beta', { labels: ['ci-run'], base: 'main' })), `${job}: base changed`).toBe(true)
      expect(runs(job, retargeted('beta', { labels: [], base: 'main' })), `${job}: base changed, no ci-run`).toBe(false)
    }
    expect(runs('test', dispatch())).toBe(false)
    expect(runs('codex-conformance', dispatch())).toBe(true)
  })

  it('the label-driven check still updates on every PR event, and the cheap always-on jobs are never skipped', () => {
    for (const action of ci.on.pull_request.types as string[]) {
      const ctx = pr(action, { labels: ['ci-run'], label: 'desktop-tested' })
      expect(runs('desktop-gate', ctx), action).toBe(true)
      // A skipped job reports "skipped" under its own name, over an earlier red
      // result for the same commit: these two run again instead (about a minute).
      expect(runs('changelog', ctx), action).toBe(true)
      expect(runs('ssh-smoke', ctx), action).toBe(true)
    }
    expect(runs('desktop-gate', push())).toBe(false)
  })
})

describe('ci.yml: the Desktop test gate is at release level on beta, and pre-release on stable (ADR-028, rule 9)', () => {
  const gate = ci.jobs['desktop-gate']
  const GATE_LABELS = ['desktop-tested', 'runtime-validated', 'skip-desktop-test']
  const NOT_MAIN = ['beta', 'release/v2.1.3', 'release/v2.2.0', 'maintenance', 'main-old', 'not-main', 'mainline']
  /** What the gate job does with a PR event: which step runs, and how it ends.
   *  The job's own condition, the two step conditions and the label step's
   *  three env expressions are evaluated; the label step's script is fixed
   *  text (pinned below) that passes on any of the three being 'true'. */
  const decide = (ctx: GhaContext): { ran: string[]; pass: boolean } | 'not run' => {
    if (!evalIf(gate.if, ctx)) return 'not run'
    const ran = gate.steps.filter((s) => evalIf(s.if, ctx))
    const pass = ran.length === 1 && (ran[0] === gate.steps[0] || Object.values(gate.steps[1].env!).some((e) => evalValue(e, ctx) === true))
    return { ran: ran.map((s) => (s === gate.steps[0] ? 'released-beta' : 'label')), pass }
  }

  it('keeps its name, runs on every PR event whatever the base or the labels, and can never be skipped or pass on a failure', () => {
    expect(gate.name).toBe('Desktop test gate')
    // Decided inside the job: a job skipped by its condition reports as passed.
    expect(gate.if).toBe("github.event_name == 'pull_request'")
    expect(gate.needs).toBeUndefined()
    expect(gate['continue-on-error']).toBeUndefined()
    expect(gate.steps).toHaveLength(2)
    for (const s of gate.steps) {
      expect(s['continue-on-error'], s.name).toBeUndefined()
      expect(s.uses, s.name).toBeUndefined()
      expect(String(s.if), s.name).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/)
    }
    for (const action of ci.on.pull_request.types as string[]) for (const base of ['beta', 'main', 'release/v2.1.3']) expect(runs('desktop-gate', pr(action, { base })), `${action} into ${base}`).toBe(true)
    expect(runs('desktop-gate', dispatch())).toBe(false)
  })

  it('a PR into beta or a release line passes with no label, on every event, and says where desktop testing happens', () => {
    for (const base of NOT_MAIN) {
      for (const action of ci.on.pull_request.types as string[]) {
        for (const labels of [[], ['ci-run'], ['desktop-tested'], ['skip-desktop-test', 'ci-run']]) {
          expect(decide(pr(action, { base, labels, label: labels[0] })), `${action} into ${base} with [${labels}]`).toEqual({ ran: ['released-beta'], pass: true })
        }
      }
    }
    const step = gate.steps[0]
    expect(step.env).toEqual({ BASE_REF: '${{ github.event.pull_request.base.ref }}' })
    // One line, and nothing in it can fail the step.
    expect(step.run).toBe(`echo "This PR targets '$BASE_REF', not main. Desktop testing happens on the released beta build, not per PR, and no label is needed. Gate open."`)
    expect(step.run).not.toMatch(/\$\{\{/)
  })

  it('a PR into main, the stable promotion, still needs one of the three labels', () => {
    for (const action of ci.on.pull_request.types as string[]) {
      expect(decide(pr(action, { base: 'main' })), `${action}, no label`).toEqual({ ran: ['label'], pass: false })
      expect(decide(pr(action, { base: 'main', labels: ['ci-run', 'in-beta', 'desktop-test', 'desktop-tested-not'] })), `${action}, other labels`).toEqual({ ran: ['label'], pass: false })
      for (const l of GATE_LABELS) expect(decide(pr(action, { base: 'main', labels: ['ci-run', l], label: l })), `${action}, ${l}`).toEqual({ ran: ['label'], pass: true })
    }
    // Branch names compare without case in an expression, and a base that
    // cannot be read is treated as main: both need the label (fail closed).
    for (const base of ['MAIN', 'Main', '', null]) {
      expect(decide(pr('opened', { base })), `base ${JSON.stringify(base)}`).toEqual({ ran: ['label'], pass: false })
      expect(decide(pr('opened', { base, labels: ['desktop-tested'] })), `base ${JSON.stringify(base)}, labelled`).toEqual({ ran: ['label'], pass: true })
    }
    const step = gate.steps[1]
    expect(step.env).toEqual({
      HAS_TESTED: "${{ contains(github.event.pull_request.labels.*.name, 'desktop-tested') }}",
      HAS_RUNTIME: "${{ contains(github.event.pull_request.labels.*.name, 'runtime-validated') }}",
      HAS_SKIP: "${{ contains(github.event.pull_request.labels.*.name, 'skip-desktop-test') }}",
    })
    // The script, whole: it passes on one of the three and otherwise ends in exit 1.
    expect(step.run).toBe([
      'if [ "$HAS_TESTED" = "true" ]; then',
      `  echo "PR carries 'desktop-tested' — a human exercised the packaged app on a real desktop. Gate open."`,
      '  exit 0',
      'fi',
      'if [ "$HAS_RUNTIME" = "true" ]; then',
      `  echo "PR carries 'runtime-validated' — automated runtime validation passed (VM Playwright e2e and/or the live SSH statusline matrix). Gate open."`,
      '  exit 0',
      'fi',
      'if [ "$HAS_SKIP" = "true" ]; then',
      `  echo "PR carries 'skip-desktop-test' — no runtime test required (docs/deps/CI/changelog-only). Gate open."`,
      '  exit 0',
      'fi',
      `echo "::error::Desktop test gate: a PR into main (the stable promotion) must carry 'desktop-tested' (a human launched and exercised the packaged app), 'runtime-validated' (automated VM e2e and/or the live SSH statusline matrix passed), or 'skip-desktop-test' (docs/deps/CI/changelog-only) before it can merge. See CONTRIBUTING.md > Desktop-test gate."`,
      'exit 1',
      '',
    ].join('\n'))
  })

  it('a green earned on a beta base does not survive a retarget to main: the base change is an event, and the gate is decided again', () => {
    expect(decide(pr('synchronize', { base: 'beta' }))).toEqual({ ran: ['released-beta'], pass: true })
    // GitHub sends `edited` for a base change, and nothing else.
    expect(ci.on.pull_request.types).toContain('edited')
    expect(ci.on.pull_request.branches).toContain('main')
    expect(decide(retargeted('beta', { base: 'main' }))).toEqual({ ran: ['label'], pass: false })
    expect(decide(retargeted('release/v2.1.3', { base: 'main', labels: ['ci-run'] }))).toEqual({ ran: ['label'], pass: false })
    expect(decide(retargeted('beta', { base: 'main', labels: ['desktop-tested'] }))).toEqual({ ran: ['label'], pass: true })
    // And the other way: off main, the label stops mattering.
    expect(decide(retargeted('main', { base: 'beta' }))).toEqual({ ran: ['released-beta'], pass: true })
    // On a PR into main a label change is still an event that decides it again.
    for (const t of ['labeled', 'unlabeled']) expect(ci.on.pull_request.types).toContain(t)
    expect(decide(pr('unlabeled', { base: 'main', labels: ['ci-run'], label: 'desktop-tested' }))).toEqual({ ran: ['label'], pass: false })
    expect(decide(pr('labeled', { base: 'main', labels: ['ci-run', 'runtime-validated'], label: 'runtime-validated' }))).toEqual({ ran: ['label'], pass: true })
    // A text edit of a PR into main decides it again as well, from the labels it has now.
    expect(decide(textEdited({ base: 'main' }))).toEqual({ ran: ['label'], pass: false })
  })

  it('no release-evidence gate was added for it: the release workflow and the release gate know nothing of these labels', () => {
    const text = read('.github/workflows/release.yml') + read('scripts/release-gate.mjs')
    for (const l of GATE_LABELS) expect(text, l).not.toContain(l)
  })
})

describe('ci.yml: a docs-only change skips the suite on Windows and macOS, and the required checks still report', () => {
  const test = ci.jobs.test
  const oses = (test.strategy?.matrix.os ?? []) as string[]
  const stepCtx = (suite: string | undefined, os: string, headRef = 'fix/thing'): GhaContext => ({
    github: { event_name: 'pull_request', head_ref: headRef, sha: 'a'.repeat(40) },
    runner: { os }, matrix: { os: os === 'Windows' ? 'windows-2025' : os === 'macOS' ? 'macos-latest' : 'ubuntu-latest' },
    steps: { scope: { outputs: suite === undefined ? {} : { suite } }, tree: { outputs: { sha: 'b'.repeat(40) } } },
  })

  it('the required checks are the names the Test matrix reports, and the job is never skipped for its paths', () => {
    expect(test.name).toBe('Test (${{ matrix.os }})')
    const reported = oses.map((os) => String(evalValue(test.name, { matrix: { os } })))
    for (const check of REQUIRED_CHECKS) expect(reported, check).toContain(check)
    // The job's own condition knows nothing of paths: the decision is taken inside it.
    expect(String(test.if)).not.toMatch(/scope|paths|needs\./)
    expect(test.needs).toBeUndefined()
  })

  it('the job checks out the merge commit with its base, decides the scope, and every later step obeys it', () => {
    const [checkout, scope, ...rest] = test.steps
    expect(checkout.uses).toMatch(/^actions\/checkout@/)
    // Depth 2: the merge commit and its parents, so the diff against the base can be read.
    expect(checkout.with).toEqual({ 'fetch-depth': 2 })
    expect(checkout.if).toBeUndefined()
    expect(scope.id).toBe('scope')
    expect(scope.run).toBe('node scripts/ci/change-scope.mjs')
    expect(scope.if).toBeUndefined()
    expect(scope['continue-on-error']).toBeUndefined()
    expect(rest.length).toBeGreaterThan(8)
    for (const step of rest) {
      const label = step.name ?? step.uses ?? step.run
      expect(step.if, `"${label}" has no condition`).toBeDefined()
      for (const os of ['Windows', 'macOS', 'Linux']) {
        // Skipped on the literal 'false', whatever else the step asks for.
        expect(evalIf(step.if, stepCtx('false', os)), `"${label}" on ${os}, suite=false`).toBe(false)
        expect(evalIf(step.if, stepCtx('false', os, 'release/v2.1.3')), `"${label}" on ${os}, suite=false, release branch`).toBe(false)
        // And only on it: 'true', and an output that was never written, leave
        // the step to its own condition (fail closed: the suite runs).
        expect(evalIf(step.if, stepCtx(undefined, os)), `"${label}" on ${os}, no output`).toBe(evalIf(step.if, stepCtx('true', os)))
        expect(evalIf(step.if, stepCtx(undefined, os, 'release/v2.1.3')), `"${label}" on ${os}, no output, release branch`).toBe(evalIf(step.if, stepCtx('true', os, 'release/v2.1.3')))
      }
    }
  })

  it('with the suite on, the steps run where they ran before', () => {
    const on = (name: string, os: string, headRef?: string) => evalIf(test.steps.find((s) => s.name === name)!.if, stepCtx('true', os, headRef))
    for (const os of ['Windows', 'macOS', 'Linux']) {
      for (const name of ['Install dependencies', 'Install Electron binary', 'Typecheck', 'Fetch the WP1 ledger\'s bound commit', 'Unit tests', 'Unit tests (native / SQLite under Electron-as-Node)', 'Build']) expect(on(name, os), `${name} on ${os}`).toBe(true)
    }
    expect(on('Rebuild native modules', 'Windows')).toBe(false)
    expect(on('Rebuild native modules', 'macOS')).toBe(true)
    expect(on('Rebuild native modules', 'Linux')).toBe(true)
    expect(on('Package Windows installer (release/* branches only)', 'Windows', 'release/v2.1.3')).toBe(true)
    expect(on('Package Windows installer (release/* branches only)', 'Windows')).toBe(false)
    expect(on('Package Windows installer (release/* branches only)', 'macOS', 'release/v2.1.3')).toBe(false)
    expect(on('Package macOS DMG (release/* branches only)', 'macOS', 'release/v2.1.3')).toBe(true)
    expect(on('Upload Windows installer', 'Windows', 'release/v2.1.3')).toBe(true)
    expect(on('Upload macOS DMG', 'Linux', 'release/v2.1.3')).toBe(false)
    expect(test.steps.find((s) => s.name === 'Unit tests')!.run).toBe('npx vitest run')
    expect(test.steps.find((s) => s.name === 'Unit tests')!.env).toBeUndefined()
  })

  it('the job ends by naming the tree it tested, after the suite and the build, and only when the suite ran', () => {
    const names = test.steps.map((s) => s.name)
    const read = test.steps[test.steps.length - 2]
    const last = test.steps[test.steps.length - 1]
    expect(read.id).toBe('tree')
    expect(read.run).toBe(`echo "sha=$(git rev-parse --verify 'HEAD^{tree}')" >> "$GITHUB_OUTPUT"`)
    expect(read.shell).toBe('bash')
    expect(last.name).toBe('Tested tree ${{ steps.tree.outputs.sha }}')
    // The name the release looks for is the name this step gets.
    expect(evalValue(last.name, stepCtx('true', 'Linux'))).toBe(testedTreeStep('b'.repeat(40)))
    for (const before of ['Unit tests', 'Unit tests (native / SQLite under Electron-as-Node)', 'Build']) expect(names.indexOf(before), before).toBeLessThan(names.length - 2)
    expect(names.indexOf('Unit tests')).toBeGreaterThan(1)
    // Neither step survives a failure or a skipped suite: no always(), no continue-on-error.
    for (const s of [read, last]) {
      expect(String(s.if)).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/)
      expect(s['continue-on-error']).toBeUndefined()
      expect(evalIf(s.if, stepCtx('false', 'Windows'))).toBe(false)
    }
  })
})

describe('release.yml: a beta release reuses green CI for the same tree; a stable release runs the suite', () => {
  const reuse = release.jobs['ci-reuse']
  const relCtx = (channel: string, reuseOut: string | undefined, dryRun = false): GhaContext => ({
    inputs: { channel, dry_run: dryRun, skip_vt: false },
    needs: { gate: { result: 'success', outputs: {} }, 'ci-reuse': { result: 'success', outputs: reuseOut === undefined ? {} : { reuse: reuseOut } } },
    secrets: {}, env: {}, steps: {},
  })
  const suiteStepsOf = (id: string) => release.jobs[id].steps.filter((s) => /\bvitest\b/.test(s.run ?? ''))

  it('the lookup job reads and never writes, is never skipped, and cannot fail the release', () => {
    expect(reuse, 'release.yml has no ci-reuse job').toBeDefined()
    expect(reuse.permissions).toEqual({ contents: 'read', actions: 'read' })
    // A skipped job skips the jobs that need it: this one has no condition, and
    // a failure in it counts as a pass for them.
    expect(reuse.if).toBeUndefined()
    expect(reuse.needs).toBeUndefined()
    expect(reuse['continue-on-error']).toBe(true)
    const find = reuse.steps.find((s) => s.id === 'find')!
    expect(find.run).toBe('node scripts/ci/reuse-green-ci.mjs')
    expect(find['continue-on-error']).toBe(true)
    expect(find.env).toEqual({ GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}', CHANNEL: '${{ inputs.channel }}' })
    expect(reuse.outputs).toEqual({ reuse: '${{ steps.find.outputs.reuse }}', run_id: '${{ steps.find.outputs.run_id }}' })
    // Nothing but the checkout, node and the lookup: no install, no secret beyond the read token.
    expect(reuse.steps.map((s) => s.uses?.replace(/@.*/, '') ?? s.run)).toEqual(['actions/checkout', 'actions/setup-node', 'node scripts/ci/reuse-green-ci.mjs'])
    expect(JSON.stringify(reuse)).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/)
  })

  it('the two jobs that run the suite wait for the lookup, and skip the suite on beta only, on the literal true only', () => {
    for (const id of ['build-windows', 'build-linux']) {
      expect(release.jobs[id].needs, id).toEqual(['gate', 'ci-reuse'])
      const steps = suiteStepsOf(id)
      expect(steps.map((s) => s.name), id).toEqual(['Run tests'])
      const cond = steps[0].if
      expect(cond, `${id}: Run tests has no condition`).toBeDefined()
      expect(evalIf(cond, relCtx('beta', 'true')), `${id} beta, reuse`).toBe(false)
      expect(evalIf(cond, relCtx('beta', 'true', true)), `${id} beta dry run, reuse`).toBe(false)
      for (const out of ['false', '', undefined, 'True ', '1', 'yes']) expect(evalIf(cond, relCtx('beta', out)), `${id} beta, reuse=${out}`).toBe(true)
      // Stable and dev run the suite whatever the lookup printed.
      for (const channel of ['stable', 'dev', '']) for (const out of ['true', 'false', undefined]) expect(evalIf(cond, relCtx(channel, out)), `${id} ${channel}, reuse=${out}`).toBe(true)
      // The stable candidate phase is declared on the step as before.
      expect(steps[0].env).toEqual({ WP1_PHASE: "${{ inputs.channel == 'stable' && !inputs.dry_run && 'candidate' || '' }}" })
      expect(steps[0].run).toBe('npx vitest run')
    }
  })

  it('nothing else in the release depends on the lookup: no build, signing, notarization, upload or publish step', () => {
    const mentions: string[] = []
    for (const [id, job] of Object.entries(release.jobs)) {
      if (/ci-reuse/.test(String(job.if ?? ''))) mentions.push(`${id} (job)`)
      for (const s of job.steps) if (/ci-reuse/.test(JSON.stringify({ if: s.if, env: s.env, with: s.with, run: s.run }))) mentions.push(`${id}: ${s.name}`)
    }
    expect(mentions).toEqual(['build-windows: Run tests', 'build-linux: Run tests'])
    // The jobs that ran no suite are wired as before.
    expect(release.jobs['build-macos'].needs).toBe('gate')
    expect(release.jobs.release.needs).toEqual(['build-windows', 'build-macos', 'build-linux'])
    expect(release.jobs.gate.needs).toBeUndefined()
    expect(suiteStepsOf('build-macos')).toEqual([])
  })

  it('what CI ran is what the release would run: the same command on the same runner images, in the workflow the lookup reads', () => {
    expect(CI_WORKFLOW_PATH).toBe('.github/workflows/ci.yml')
    const ciOses = ci.jobs.test.strategy!.matrix.os as string[]
    const ciSuite = ci.jobs.test.steps.find((s) => s.name === 'Unit tests')!
    for (const id of ['build-windows', 'build-linux']) {
      expect(ciOses, id).toContain(release.jobs[id]['runs-on'])
      expect(suiteStepsOf(id)[0].run).toBe(ciSuite.run)
    }
  })
})

describe('the written rules match (AGENTS.md, CONTRIBUTING.md, the adversarial-review skill, ADR-028)', () => {
  it('no doc still asks for an open-ended review loop or a separate version-bump PR', () => {
    const skill = read('.claude/skills/adversarial-review/SKILL.md')
    expect(skill).not.toMatch(/until a pass returns clean/i)
    expect(skill).not.toMatch(/repeat fix -> re-attack/i)
    expect(skill).toMatch(/one pass, one fix batch, one confirmation/i)
    expect(skill).toMatch(/narrow check of that fix diff/i)
    const agents = read('AGENTS.md')
    expect(agents).toMatch(/## Beta cadence/)
    expect(agents).toMatch(/ADR-028/)
    for (const doc of ['AGENTS.md', 'CONTRIBUTING.md']) {
      const text = read(doc)
      expect(text, doc).toMatch(/one review round/i)
      expect(text, doc).toMatch(/last content PR/i)
      expect(text, doc).toMatch(/reuses? green CI/i)
    }
    expect(read('architecture/decisions/2026-11-14-adr-028-fast-beta-cadence.md')).toMatch(/^# ADR-028: /)
  })

  it('rule 9 is written where the old rule was: a PR into beta needs no desktop-test label, the promotion PR into main does', () => {
    const rule = /Desktop testing is at release level on beta and pre-release on stable,\s+not per PR/
    for (const doc of ['AGENTS.md', 'CONTRIBUTING.md', 'architecture/decisions/2026-11-14-adr-028-fast-beta-cadence.md']) expect(read(doc), doc).toMatch(rule)
    const contributing = read('CONTRIBUTING.md')
    expect(contributing).toMatch(/A PR into `beta` \(or a `release\/\*` line\) needs no label/)
    expect(contributing).toMatch(/A PR into `main` \(the stable promotion, `release\/vX\.Y\.Z` → `main`\) must\s+carry a label/)
    // The old rule, in the words it had: every PR needed the label to merge.
    expect(contributing).not.toMatch(/a PR does not merge on\s+green CI alone/)
    expect(contributing).not.toMatch(/branch protection for `beta`/)
    // The loop skills, their contract and the PR body loop-tree writes no longer
    // send a beta PR to a desktop test or ask a human for the label.
    for (const doc of ['.claude/skills/StartLoop/SKILL.md', '.claude/skills/SessionLoop/SKILL.md', 'docs/loop-autonomy.md', 'scripts/loop-tree.mjs', '.claude/skills/adversarial-review/SKILL.md']) {
      const text = read(doc)
      expect(text, doc).not.toMatch(/after a desktop test/i)
      expect(text, doc).not.toMatch(/appl(y|ies) `desktop-tested`/i)
      expect(text, doc).not.toMatch(/exercised in the desktop app/i)
      expect(text, doc).not.toMatch(/\(desktop-tested[ ,]/)
    }
    // What stays true is still said: a headless run cannot vouch for the screen.
    expect(read('.claude/skills/StartLoop/SKILL.md')).toMatch(/NOT desktop-verified/)
    expect(read('scripts/loop-tree.mjs')).toMatch(/NOT desktop-verified by the loop/)
  })
})
