import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
import { evalIf, type GhaContext } from '../../helpers/gha-expr'
import { TEST_JOB_RE } from '../../../scripts/release-gate.mjs'
import { judge } from '../../../scripts/ci/vitest-ran.mjs'
import { LINUX_HELPER_SOURCE, MANIFEST_SOURCE } from '../../../scripts/verify-bundled-helper.mjs'
import { DEV_LINUX_HELPER, DEV_MANIFEST } from '../../../src/main/remote-helper/manifest'

/**
 * The Remote helper e2e job of ci.yml (plan 2.1.3-beta.17, section A2, rule
 * 35; aicc_planning#411). It drives the app's remote-helper code against a
 * localhost sshd on the Linux runner, so it must start ONLY on a dispatch
 * that names it, never on a pull request or a push, and must not be one of
 * the checks a PR or the release gate waits for: it is section evidence, like
 * a test-machine line. vitest must run its one file with retries off, under
 * the live config (the default one does not include tests/live), and a run in
 * which no test ran, or one did not pass, must fail the job (rule 27). Its
 * condition is EVALUATED here for each event, as snap-e2e-job.test.ts does.
 *
 * Not checked here: what the live file asserts (the dispatch shows it), and
 * the steps' bash beyond the flags and files they name.
 */

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')
type Step = { name?: string; if?: unknown; uses?: string; run?: string; shell?: string; env?: Record<string, unknown>; with?: Record<string, unknown>; 'working-directory'?: string }
type Job = { name?: string; if?: unknown; needs?: unknown; 'runs-on'?: string; env?: Record<string, unknown>; steps: Step[]; strategy?: unknown; permissions?: Record<string, string>; 'continue-on-error'?: unknown; 'timeout-minutes'?: number }
type Input = { type?: string; default?: unknown; required?: boolean }
const ci = yaml.load(read('.github/workflows/ci.yml')) as { on: { pull_request: { types: string[] }; workflow_dispatch: { inputs: Record<string, Input> } }; jobs: Record<string, Job> }
const job = ci.jobs['remote-helper-e2e']
const LIVE = 'tests/live/remote-helper-device.live.ts'
const REQUIRED_CHECKS = ['Test (windows-2025)', 'Test (macos-latest)']

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
  expect(job, 'ci.yml has no `remote-helper-e2e` job').toBeDefined()
  return evalIf(job.if, ctx)
}
const step = (start: string): Step => {
  const s = job.steps.find((x) => String(x.name ?? '').startsWith(start))
  expect(s, `no step named "${start}..."`).toBeDefined()
  return s as Step
}
const names = () => job.steps.map((s) => String(s.name ?? s.uses))

describe('ci.yml: the Remote helper e2e job runs only on a dispatch that names it', () => {
  it('exists once, on the Linux runner', () => {
    expect(job).toBeDefined()
    expect(String(job.name)).toBe('Remote helper e2e')
    expect(job['runs-on']).toBe('ubuntu-latest')
    expect(job.strategy).toBeUndefined()
    expect(Object.entries(ci.jobs).filter(([, j]) => String(j.name ?? '').startsWith('Remote helper e2e')).map(([id]) => id)).toEqual(['remote-helper-e2e'])
  })

  it('never starts on a pull request, whatever the action or the labels, nor on a push', () => {
    for (const action of ci.on.pull_request.types) expect(runs(pr(action, action === 'labeled' || action === 'unlabeled' ? 'ci-run' : undefined)), `pull_request ${action}`).toBe(false)
    expect(runs(push()), 'push').toBe(false)
  })

  it('starts on a dispatch with remote_helper_e2e set, and on no other dispatch', () => {
    expect(runs(dispatch({ remote_helper_e2e: true }))).toBe(true)
    expect(runs(dispatch({ remote_helper_e2e: false }))).toBe(false)
    expect(runs(dispatch({}))).toBe(false)
    const others = Object.entries(ci.on.workflow_dispatch.inputs).filter(([name]) => name !== 'remote_helper_e2e')
    expect(others.length, 'the other inputs are read from the workflow').toBeGreaterThan(2)
    const all = Object.fromEntries(others.map(([name, input]) => [name, input.type === 'boolean' ? true : '1.2.3']))
    expect(runs(dispatch(all))).toBe(false)
    expect(runs(dispatch({ ...all, remote_helper_e2e: true }))).toBe(true)
  })

  it('starts neither the Snap e2e nor the Helper job, and their dispatches do not start it', () => {
    expect(evalIf(ci.jobs['snap-e2e'].if, dispatch({ remote_helper_e2e: true }))).toBe(false)
    expect(evalIf(ci.jobs['helper'].if, dispatch({ remote_helper_e2e: true }))).toBe(false)
    expect(runs(dispatch({ snap_e2e: true }))).toBe(false)
    expect(runs(dispatch({ helper: true }))).toBe(false)
  })

  it('is named by one boolean dispatch input that is off unless set', () => {
    const input = ci.on.workflow_dispatch.inputs.remote_helper_e2e
    expect(input).toBeDefined()
    expect(input.type).toBe('boolean')
    expect(input.default).toBe(false)
    expect(input.required).toBe(false)
  })

  it('is none of the required checks, not a Test job, not needed by any job, and not in release.yml or the release gate', () => {
    const name = String(job.name)
    expect(REQUIRED_CHECKS).not.toContain(name)
    expect(name.startsWith('Test (')).toBe(false)
    expect(TEST_JOB_RE.test(name)).toBe(false)
    expect(job.needs).toBeUndefined()
    expect(Object.values(ci.jobs).some((j) => ([] as unknown[]).concat(j.needs ?? []).includes('remote-helper-e2e'))).toBe(false)
    expect(job['continue-on-error']).toBeUndefined()
    expect(read('.github/workflows/release.yml')).not.toMatch(/remote[-_]helper[-_]e2e|remote-helper-device/)
    expect(read('scripts/release-gate.mjs')).not.toMatch(/remote[-_ ]helper[-_ ]e2e|remote-helper-device/i)
  })
})

describe('ci.yml: the Remote helper e2e job only reads, runs its file once, and keeps its readings', () => {
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

  it('builds the static helper and the fake CLI with the lock file, as the Helper job builds its static helper, before the check runs', () => {
    const build = step('Build the static helper and the fake CLI')
    expect(String(build.run)).toContain('cargo build --locked --release --target x86_64-unknown-linux-musl --bin aicc-helper --bin aicc-fake-cli')
    expect(build['working-directory']).toBe('helper')
    // The helper goes where release.yml hands it to the Windows package, and where a dev run reads it.
    expect(String(build.run)).toContain('cp target/x86_64-unknown-linux-musl/release/aicc-helper target/helper-linux-musl/')
    expect(LINUX_HELPER_SOURCE).toBe(`helper/target/helper-linux-musl/aicc-helper`)
    expect(DEV_LINUX_HELPER).toBe(LINUX_HELPER_SOURCE)
    const order = ['Install the pinned Rust toolchain and the musl target', 'Build the static helper and the fake CLI', 'Install dependencies', 'Write the helper\'s manifest as for the installer', 'Provision an ephemeral key-auth sshd', 'Give the account rc files as a real one has', 'Write the hosts file (no secret)', 'Run the remote helper device check', 'Fail a run in which no test ran, or one did not pass', 'Upload the two programs, the manifest and the readings']
    const at = order.map((n) => names().indexOf(n))
    expect(at.every((i) => i >= 0), JSON.stringify(names())).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('writes the manifest with the installer\'s own script (A1\'s), which refuses a helper that is not static, and keeps a copy beside the programs', () => {
    const write = step('Write the helper\'s manifest as for the installer')
    const lines = String(write.run).trim().split('\n').map((l) => l.trim())
    expect(lines).toContain('set -euo pipefail')
    // It builds the x86-64 helper only, so the manifest lists what it has (2.1.3-beta.19: a package lists both).
    expect(lines).toContain('node scripts/write-helper-manifest.mjs --only-present')
    expect(lines.filter((l) => l.includes('write-helper-manifest'))).toHaveLength(1)
    expect(lines).toContain('cp helper/target/helper-manifest/manifest.json helper/target/remote-helper-e2e/manifest.json')
    expect(String(write.run)).not.toMatch(/\|\||continue-on-error|true\b/)
    expect(MANIFEST_SOURCE).toBe('helper/target/helper-manifest/manifest.json')
    expect(DEV_MANIFEST).toBe(MANIFEST_SOURCE)
  })

  it('runs the one live file under the live config with retries off, handing it the hosts file, the helper and its manifest, and the fake CLI', () => {
    const run = step('Run the remote helper device check')
    const cmd = String(run.run).trim()
    expect(cmd.startsWith(`npx vitest run --config vitest.live.config.ts ${LIVE} `), cmd).toBe(true)
    expect(cmd.split(/\s+/)).toContain('--retry=0')
    expect(cmd.match(/--retry\b/g)).toHaveLength(1)
    expect(cmd).not.toMatch(/--passWithNoTests|\|\||continue-on-error/)
    expect(cmd).toContain('--outputFile.json="$REMOTE_HELPER_OUT/vitest.json"')
    expect(run.env?.REMOTE_HELPER_HOSTS).toBe('${{ runner.temp }}/remote-helper-e2e/hosts.json')
    expect(run.env?.REMOTE_HELPER_BIN).toBe(DEV_LINUX_HELPER)
    expect(run.env?.REMOTE_HELPER_MANIFEST).toBe(DEV_MANIFEST)
    expect(run.env?.REMOTE_HELPER_FAKE_CLI).toBe('helper/target/remote-helper-e2e/aicc-fake-cli')
    // The default config never picks the live file up, so no other suite runs it.
    expect(read('vitest.config.ts')).not.toMatch(/tests\/live/)
    expect(read('vitest.live.config.ts')).toContain("'tests/live/**/*.live.ts'")
    for (const v of ['REMOTE_HELPER_HOSTS', 'REMOTE_HELPER_BIN', 'REMOTE_HELPER_MANIFEST', 'REMOTE_HELPER_FAKE_CLI']) expect(read(LIVE)).toContain(v)
    // The live file reads the helper through the app's own manifest reader.
    expect(read(LIVE)).toMatch(/readBundledLinuxHelper\(\{ manifest: need\('REMOTE_HELPER_MANIFEST'\), file: need\('REMOTE_HELPER_BIN'\) \}\)/)
  })

  // 2.1.3-beta.21 (plan phase 6, aicc_planning#446): probes PV1 and PV2 and a
  // review on the machine, after the device check, never beside it. Its
  // caller is real Claude Code 2.1.332 (plan 6.3's CI line), the one install
  // the paste check runs, made before the machine is added and Checked.
  it('then runs the review check: its own live file, retries off, the stand-in Codex the rc step put on the login PATH, its own report that must show a pass', () => {
    const at = (start: string) => names().findIndex((n) => n.startsWith(start))
    const rc = step('Give the account rc files')
    expect(String(rc.run)).toContain('cp helper/probes/pv-codex-stand-in.cjs "$HOME/aicc-e2e-bin/codex"')
    const run = step('Run the review check on the machine')
    const cmd = String(run.run).trim()
    expect(cmd.startsWith('npx vitest run --config vitest.live.config.ts tests/live/remote-review.live.ts '), cmd).toBe(true)
    expect(cmd.split(/\s+/)).toContain('--retry=0')
    expect(cmd.match(/--retry\b/g)).toHaveLength(1)
    expect(cmd).not.toMatch(/--passWithNoTests|\|\||continue-on-error/)
    expect(cmd).toContain('--outputFile.json="$REMOTE_HELPER_OUT/vitest-review.json"')
    expect(run.if).toBe('${{ !cancelled() }}')
    expect(run.env?.REMOTE_REVIEW_CODEX).toBe('stand-in')
    expect(run.env?.REMOTE_HELPER_BIN).toBe(DEV_LINUX_HELPER)
    expect(run.env?.REMOTE_HELPER_MANIFEST).toBe(DEV_MANIFEST)
    const check = step('Fail the review check when no test ran')
    expect(String(check.run).trim()).toBe('node scripts/ci/vitest-ran.mjs "$REPORT"')
    expect(check.if).toBe('${{ !cancelled() }}')
    expect(check.env?.REPORT).toBe('${{ runner.temp }}/remote-helper-e2e/vitest-review.json')
    // After the device check and its own verdict, before the upload.
    expect(at('Run the review check on the machine')).toBeGreaterThan(at('Fail a run in which no test ran'))
    expect(at('Fail the review check when no test ran')).toBeGreaterThan(at('Run the review check on the machine'))
    expect(at('Upload the two programs')).toBeGreaterThan(at('Fail the review check when no test ran'))
    for (const v of ['REMOTE_HELPER_HOSTS', 'REMOTE_HELPER_BIN', 'REMOTE_HELPER_MANIFEST', 'REMOTE_HELPER_FAKE_CLI', 'REMOTE_REVIEW_CODEX', 'REMOTE_REVIEW_CLAUDE']) expect(read('tests/live/remote-review.live.ts')).toContain(v)
  })

  it('the review check\'s caller is the real Claude Code the job installed once, not the fake CLI, pointed at P11\'s model stand-in by the rc step\'s env file', () => {
    const at = (start: string) => names().findIndex((n) => n.startsWith(start))
    const run = step('Run the review check on the machine')
    expect(run.env?.REMOTE_REVIEW_CLAUDE).toBe('${{ steps.claudebin.outputs.bin }}')
    expect(run.env?.REMOTE_HELPER_FAKE_CLI).toBeUndefined()
    // One install of Claude Code in the job, the paste check's, before the machine is added and Checked.
    expect(names().filter((n) => /^Install Claude Code/.test(n))).toHaveLength(1)
    expect(job.steps.filter((s) => /npm install\b/.test(String(s.run ?? '')))).toHaveLength(1)
    expect(at('Run the review check on the machine')).toBeGreaterThan(at('Locate the installed Claude Code'))
    expect(String(run.run)).not.toContain('npm')
    const live = read('tests/live/remote-review.live.ts')
    // The same env file the rc step reads, and P11's model stand-in with its scripted review turn.
    expect(String(step('Give the account rc files').run)).toContain(`[ -f "$HOME/.aicc-e2e-paste-env" ] && . "$HOME/.aicc-e2e-paste-env"`)
    expect(live).toContain("const ENV_FILE = '.aicc-e2e-paste-env'")
    expect(live).toContain("req('../../helper/probes/p11-model-stand-in.cjs')")
    expect(live).toContain("from './review-tool-host'")
  })

  // 2.1.3-beta.21 (plan block 5.3's CI line, ADR-032): a picture into a
  // Claude Code tab through the helper, with the real Claude Code 2.1.332.
  it('then runs the paste check: real Claude Code 2.1.332 from its platform package with scripts off into its own prefix, its own live file, retries off, its own report that must show a pass', () => {
    const at = (start: string) => names().findIndex((n) => n.startsWith(start))
    const pkg = step('Resolve this runner\'s Claude Code package')
    expect(String(pkg.run).trim()).toBe('node tests/integration/claude-conformance-ci.mjs package')
    const install = step('Install Claude Code 2.1.332 into its own prefix')
    expect(String(install.run).trim()).toBe('npm install --global --prefix "$PREFIX" --ignore-scripts --cache "$NPM_CACHE" --no-audit --no-fund "$CLAUDE_PACKAGE@$CLAUDE_VERSION"')
    expect(install.env?.CLAUDE_VERSION).toBe('2.1.332')
    expect(install.env?.CLAUDE_PACKAGE).toBe('${{ steps.claudepkg.outputs.package }}')
    const locate = step('Locate the installed Claude Code')
    expect(String(locate.run).trim()).toBe('node tests/integration/claude-conformance-ci.mjs bin "$PREFIX" "$CLAUDE_PACKAGE"')
    expect(locate.env?.PREFIX).toBe(install.env?.PREFIX)
    // The rc step's interactive login shell reads the check's env file (the model stand-in's address), and only that shell.
    const rc = String(step('Give the account rc files').run)
    expect(rc).toContain(`echo 'case $- in *i*) [ -f "$HOME/.aicc-e2e-paste-env" ] && . "$HOME/.aicc-e2e-paste-env";; esac'`)
    expect(read('tests/live/remote-paste.live.ts')).toContain("const ENV_FILE = '.aicc-e2e-paste-env'")
    const run = step('Run the clipboard paste check on the machine')
    const cmd = String(run.run).trim()
    expect(cmd.startsWith('npx vitest run --config vitest.live.config.ts tests/live/remote-paste.live.ts '), cmd).toBe(true)
    expect(cmd.split(/\s+/)).toContain('--retry=0')
    expect(cmd.match(/--retry\b/g)).toHaveLength(1)
    expect(cmd).not.toMatch(/--passWithNoTests|\|\||continue-on-error/)
    expect(cmd).toContain('--outputFile.json="$REMOTE_HELPER_OUT/vitest-paste.json"')
    expect(run.if).toBe('${{ !cancelled() }}')
    expect(run.env?.REMOTE_PASTE_CLAUDE).toBe('${{ steps.claudebin.outputs.bin }}')
    expect(run.env?.REMOTE_HELPER_BIN).toBe(DEV_LINUX_HELPER)
    expect(run.env?.REMOTE_HELPER_MANIFEST).toBe(DEV_MANIFEST)
    const check = step('Fail the paste check when no test ran')
    expect(String(check.run).trim()).toBe('node scripts/ci/vitest-ran.mjs "$REPORT"')
    expect(check.if).toBe('${{ !cancelled() }}')
    expect(check.env?.REPORT).toBe('${{ runner.temp }}/remote-helper-e2e/vitest-paste.json')
    // Installed before any check runs; after the review check and its verdict; before the upload.
    expect(at('Locate the installed Claude Code')).toBeGreaterThan(at('Install Claude Code 2.1.332'))
    expect(at('Install Claude Code 2.1.332')).toBeGreaterThan(at('Resolve this runner\'s Claude Code package'))
    expect(at('Run the remote helper device check')).toBeGreaterThan(at('Locate the installed Claude Code'))
    expect(at('Run the clipboard paste check on the machine')).toBeGreaterThan(at('Fail the review check when no test ran'))
    expect(at('Fail the paste check when no test ran')).toBeGreaterThan(at('Run the clipboard paste check on the machine'))
    expect(at('Upload the two programs')).toBeGreaterThan(at('Fail the paste check when no test ran'))
    for (const v of ['REMOTE_HELPER_HOSTS', 'REMOTE_HELPER_BIN', 'REMOTE_HELPER_MANIFEST', 'REMOTE_PASTE_CLAUDE']) expect(read('tests/live/remote-paste.live.ts')).toContain(v)
  })

  it('fails the job when no test ran or one did not pass, even after a red check step', () => {
    const check = step('Fail a run in which no test ran')
    expect(String(check.run).trim()).toBe('node scripts/ci/vitest-ran.mjs "$REPORT"')
    expect(check.if).toBe('${{ !cancelled() }}')
    expect(check.env?.REPORT).toBe('${{ runner.temp }}/remote-helper-e2e/vitest.json')
    expect(judge({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0 }).ok).toBe(false)
    expect(judge({ numTotalTests: 6, numPassedTests: 5, numFailedTests: 1 }).ok).toBe(false)
    expect(judge({ numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, testResults: [{ assertionResults: [{ retryCount: 1 }] }] }).ok).toBe(false)
    expect(judge({ numTotalTests: 6, numPassedTests: 6, numFailedTests: 0 }).ok).toBe(true)
  })

  it('uploads the two programs, the manifest and the readings even when a step failed', () => {
    const upload = step('Upload the two programs, the manifest and the readings')
    expect(String(upload.uses)).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/)
    expect(upload.if).toBe('always()')
    expect(upload.with?.name).toBe('remote-helper-e2e')
    expect(String(upload.with?.path)).toContain('helper/target/remote-helper-e2e')
    expect(String(upload.with?.path)).toContain('${{ runner.temp }}/remote-helper-e2e')
  })

  it('has a job timeout, which no step raises', () => {
    expect(job['timeout-minutes']).toBe(30)
    for (const s of job.steps) expect((s as { 'timeout-minutes'?: unknown })['timeout-minutes'], String(s.name)).toBeUndefined()
  })
})
