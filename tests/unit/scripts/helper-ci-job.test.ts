import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
import { evalIf, evalValue, type GhaContext } from '../../helpers/gha-expr'

/**
 * The Helper (os) job of ci.yml, as the workflow carries it out. It builds the
 * dormant Rust session helper, is NOT a required check, decides inside the job
 * (the way the Test jobs do) and so can never leave a check waiting. Its
 * conditions are EVALUATED here, not matched as text.
 */

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')
type Step = { name?: string; id?: string; if?: unknown; uses?: string; run?: string; with?: Record<string, unknown>; shell?: string; 'working-directory'?: string; 'continue-on-error'?: unknown }
type Job = { name?: string; if?: unknown; needs?: unknown; steps: Step[]; strategy?: { matrix: Record<string, unknown> }; permissions?: Record<string, string>; 'timeout-minutes'?: number; 'continue-on-error'?: unknown }
const ci = yaml.load(read('.github/workflows/ci.yml')) as { jobs: Record<string, Job> }
const job = ci.jobs.helper

/** The checks the branch rulesets require; the helper job is none of them. */
const REQUIRED_CHECKS = ['Test (windows-2025)', 'Test (macos-latest)']
const OSES = ['windows-2025', 'macos-latest', 'ubuntu-latest']
const RUNNER_OS: Record<string, string> = { 'windows-2025': 'Windows', 'macos-latest': 'macOS', 'ubuntu-latest': 'Linux' }

const stepCtx = (helper: string | undefined, present: string | undefined, os: string): GhaContext => ({
  github: { event_name: 'pull_request' },
  runner: { os: RUNNER_OS[os] },
  matrix: { os },
  steps: { scope: { outputs: helper === undefined ? {} : { helper } }, lock: { outputs: present === undefined ? {} : { present } } },
})
const named = (name: string) => {
  const s = job.steps.find((x) => x.name === name)
  if (!s) throw new Error(`no step named "${name}"`)
  return s
}

describe('ci.yml: the Helper job exists, on the three OSes, and is not a required check', () => {
  it('is named Helper (os) for windows-2025, macos-latest and ubuntu-latest', () => {
    expect(job, 'ci.yml has no `helper` job').toBeDefined()
    expect(job.name).toBe('Helper (${{ matrix.os }})')
    expect(job.strategy?.matrix.os).toEqual(OSES)
    expect(OSES.map((os) => String(evalValue(job.name, { matrix: { os } })))).toEqual(['Helper (windows-2025)', 'Helper (macos-latest)', 'Helper (ubuntu-latest)'])
  })

  it('its names are none of the required checks and none begin with "Test (", so the release gate never reads them', () => {
    const reported = OSES.map((os) => String(evalValue(job.name, { matrix: { os } })))
    for (const name of reported) {
      expect(REQUIRED_CHECKS).not.toContain(name)
      expect(name.startsWith('Test (')).toBe(false)
    }
    // And the Test jobs keep their names, so the required checks still report
    // (Windows runs in parts; its check is the job named after it).
    expect(ci.jobs.test.name).toBe('Test (${{ matrix.os }})')
    expect(ci.jobs.test.strategy?.matrix.os).toEqual(['macos-latest', 'ubuntu-latest'])
    expect(ci.jobs['test-windows'].name).toBe('Test (${{ matrix.os }})')
    expect(ci.jobs['test-windows'].strategy?.matrix.os).toEqual(['windows-2025'])
  })

  it('the job starts on a pull request or a push; its only conditions are the event and the Test jobs label and edit rule, never the paths', () => {
    const on = (event: string, action = 'opened', extra: Record<string, unknown> = {}) => evalIf(job.if, { github: { event_name: event, event: { action, pull_request: { labels: [] }, ...extra } } })
    expect(on('pull_request', 'opened')).toBe(true)
    expect(on('pull_request', 'synchronize')).toBe(true)
    expect(on('pull_request', 'reopened')).toBe(true)
    expect(on('push', '')).toBe(true)
    expect(on('workflow_dispatch', '')).toBe(false)
    expect(String(job.if)).not.toMatch(/scope|paths|needs\.|labels|helper\//)
    expect(job.needs).toBeUndefined()
    expect(job['continue-on-error']).toBeUndefined()
    expect(job.permissions).toEqual({ contents: 'read' })
  })

  it('a label change other than ci-run and an edit that is not a base change do not start three runners; ci-run and a base change do', () => {
    const on = (action: string, extra: Record<string, unknown>) => evalIf(job.if, { github: { event_name: 'pull_request', event: { action, pull_request: { labels: [] }, ...extra } } })
    expect(on('labeled', { label: { name: 'desktop-tested' } })).toBe(false)
    expect(on('unlabeled', { label: { name: 'ci-run' } })).toBe(false)
    expect(on('edited', { changes: { title: { from: 'old' } } })).toBe(false)
    expect(on('edited', {})).toBe(false)
    // `ci-run` added replaces the in-flight run of the same group, so it must still build.
    expect(on('labeled', { label: { name: 'ci-run' } })).toBe(true)
    expect(on('edited', { changes: { base: { ref: { from: 'main' } } } })).toBe(true)
  })
})

describe('ci.yml: the Helper job decides inside, and every later step obeys it', () => {
  it('checks out with the base, then decides, with no condition on either', () => {
    const [checkout, scope] = job.steps
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/)
    expect(checkout.with).toEqual({ 'fetch-depth': 2, 'persist-credentials': false })
    expect(checkout.if).toBeUndefined()
    expect(scope.id).toBe('scope')
    expect(scope.run).toBe('node scripts/ci/helper-scope.mjs')
    expect(scope.if).toBeUndefined()
    expect(scope['continue-on-error']).toBeUndefined()
  })

  it('every step after the decision is skipped by the literal helper=false, on every OS, and only by it', () => {
    const rest = job.steps.slice(2)
    expect(rest.length).toBeGreaterThan(8)
    for (const step of rest) {
      const label = step.name ?? step.uses ?? step.run
      expect(step.if, `"${label}" has no condition`).toBeDefined()
      for (const os of OSES) {
        for (const present of ['true', 'false', undefined]) {
          expect(evalIf(step.if, stepCtx('false', present, os)), `"${label}" on ${os}, helper=false, lock ${present}`).toBe(false)
        }
        // An output that was never written is not 'false': the step goes on as for 'true'.
        for (const present of ['true', 'false']) {
          expect(evalIf(step.if, stepCtx(undefined, present, os)), `"${label}" on ${os}, no output, lock ${present}`).toBe(evalIf(step.if, stepCtx('true', present, os)))
        }
      }
    }
  })

  it('every third-party action is pinned by commit, and no step is allowed to fail quietly', () => {
    for (const step of job.steps) {
      if (step.uses) expect(step.uses, step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
      expect(step['continue-on-error'], step.name).toBeUndefined()
    }
  })
})

describe('ci.yml: Cargo.lock, --locked and the artifacts', () => {
  const runs = (name: string, present: string, os: string) => evalIf(named(name).if, stepCtx('true', present, os))

  it('with no Cargo.lock: generate one, upload it from Linux as helper-cargo-lock, and fail saying to commit it; build nothing', () => {
    const lock = named('Check that Cargo.lock is committed')
    expect(lock.id).toBe('lock')
    expect(lock.run).toContain('cargo generate-lockfile')
    expect(lock.run).toContain('present=true')
    expect(lock.run).toContain('present=false')
    const upload = named('Upload the generated Cargo.lock')
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/)
    expect(upload.with).toMatchObject({ name: 'helper-cargo-lock', path: 'helper/Cargo.lock', 'if-no-files-found': 'error' })
    expect(runs('Upload the generated Cargo.lock', 'false', 'ubuntu-latest')).toBe(true)
    // One upload under one name: the other two runners would collide on it.
    expect(runs('Upload the generated Cargo.lock', 'false', 'windows-2025')).toBe(false)
    expect(runs('Upload the generated Cargo.lock', 'false', 'macos-latest')).toBe(false)
    const fail = named('Fail until Cargo.lock is committed')
    expect(fail.run).toMatch(/helper-cargo-lock/)
    expect(fail.run).toMatch(/commit it as helper\/Cargo\.lock/)
    expect(fail.run).toMatch(/exit 1/)
    for (const os of OSES) {
      expect(runs('Fail until Cargo.lock is committed', 'false', os), os).toBe(true)
      for (const build of ['Build', 'Test', 'Count the crates in Cargo.lock', 'No networking in the helper source']) expect(runs(build, 'false', os), `${build} on ${os}`).toBe(false)
    }
  })

  it('with Cargo.lock committed: build and test run, and every cargo build or test uses --locked', () => {
    for (const os of OSES) {
      expect(runs('Fail until Cargo.lock is committed', 'true', os), os).toBe(false)
      expect(runs('Upload the generated Cargo.lock', 'true', os), os).toBe(false)
      for (const step of ['Count the crates in Cargo.lock', 'No networking in the helper source', 'Build', 'Test']) expect(runs(step, 'true', os), `${step} on ${os}`).toBe(true)
    }
    for (const step of job.steps) {
      for (const line of (step.run ?? '').split('\n')) {
        if (/^\s*cargo (build|test|run|check|clippy)\b/.test(line)) expect(line, `${step.name}: ${line}`).toContain('--locked')
      }
    }
    expect(named('Test').run).toBe('cargo test --locked')
    expect(named('Build').run).toBe('cargo build --locked --all-targets')
  })

  it('counts the crates and fails above 24 (under 25, the helper itself included)', () => {
    const run = named('Count the crates in Cargo.lock').run ?? ''
    expect(run).toContain("grep -c '^name = ' Cargo.lock")
    expect(run).toContain('"$n" -gt 24')
  })

  it('uploads the Windows build as helper-windows, from the Windows job only, with the probe script beside it', () => {
    const upload = named('Upload the Windows helper')
    expect(upload.with).toMatchObject({ name: 'helper-windows', path: 'helper/target/helper-windows', 'if-no-files-found': 'error' })
    expect(runs('Upload the Windows helper', 'true', 'windows-2025')).toBe(true)
    expect(runs('Upload the Windows helper', 'true', 'macos-latest')).toBe(false)
    expect(runs('Upload the Windows helper', 'true', 'ubuntu-latest')).toBe(false)
    expect(runs('Upload the Windows helper', 'false', 'windows-2025')).toBe(false)
    const build = named('Build the Windows release binaries').run ?? ''
    expect(build).toContain('cargo build --locked --release')
    for (const f of ['aicc-helper.exe', 'aicc-fake-cli.exe', 'p7-windows-survival.ps1']) expect(build, f).toContain(f)
  })

  it('every cargo step runs in helper/, and the toolchain comes from the pinned file', () => {
    for (const step of job.steps) {
      if (/^\s*(cargo|rustup|rustc)\b/m.test(step.run ?? '')) expect(step['working-directory'], step.name).toBe('helper')
    }
    expect(named('Install the pinned Rust toolchain').run).toContain('rustup toolchain install')
    const toolchain = read('helper/rust-toolchain.toml')
    expect(toolchain).toMatch(/channel\s*=\s*"\d+\.\d+\.\d+"/)
  })
})
