import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
import { evalIf, evalValue, type GhaContext } from '../../helpers/gha-expr'

/**
 * The Helper (os) job of ci.yml, as the workflow carries it out. It builds the
 * Rust session helper the installer ships, is NOT a required check, decides inside the job
 * (the way the Test jobs do) and so can never leave a check waiting. Its
 * conditions are EVALUATED here, not matched as text.
 */

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')
type Step = { name?: string; id?: string; if?: unknown; uses?: string; run?: string; with?: Record<string, unknown>; shell?: string; 'working-directory'?: string; 'continue-on-error'?: unknown }
type Job = { name?: string; if?: unknown; needs?: unknown; steps: Step[]; strategy?: { matrix: Record<string, unknown> }; permissions?: Record<string, string>; 'timeout-minutes'?: number; 'continue-on-error'?: unknown }
type Input = { description?: string; type?: string; required?: boolean; default?: unknown }
const ci = yaml.load(read('.github/workflows/ci.yml')) as { on: { workflow_dispatch: { inputs: Record<string, Input> } }; jobs: Record<string, Job> }
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
/**
 * A dispatch as GitHub gives it: `github.event.inputs` holds every declared
 * input as a string (a boolean one as 'true' or 'false', its default when the
 * dispatch leaves it out), and the `inputs` context holds the same values with
 * their declared types.
 */
const dispatch = (given: Record<string, string>): GhaContext => {
  const strings: Record<string, string> = {}
  const typed: Record<string, unknown> = {}
  for (const [name, input] of Object.entries(ci.on.workflow_dispatch.inputs)) {
    const value = name in given ? given[name] : String(input.default ?? '')
    strings[name] = value
    typed[name] = input.type === 'boolean' ? value === 'true' : value
  }
  return { github: { event_name: 'workflow_dispatch', event: { inputs: strings } }, inputs: typed }
}
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

  it('the job starts on a pull request, a push or a dispatch that names it; its only conditions are the event, that input and the Test jobs label and edit rule, never the paths', () => {
    const on = (event: string, action = 'opened', extra: Record<string, unknown> = {}) => evalIf(job.if, { github: { event_name: event, event: { action, pull_request: { labels: [] }, ...extra } }, inputs: {} })
    expect(on('pull_request', 'opened')).toBe(true)
    expect(on('pull_request', 'synchronize')).toBe(true)
    expect(on('pull_request', 'reopened')).toBe(true)
    expect(on('push', '')).toBe(true)
    // A dispatch whose payload names no input at all.
    expect(on('workflow_dispatch', '')).toBe(false)
    expect(String(job.if)).not.toMatch(/scope|paths|needs\.|labels|helper\//)
    expect(job.needs).toBeUndefined()
    expect(job['continue-on-error']).toBeUndefined()
    expect(job.permissions).toEqual({ contents: 'read' })
  })

  it('a label change other than ci-run and an edit that is not a base change do not start three runners; ci-run and a base change do', () => {
    const on = (action: string, extra: Record<string, unknown>) => evalIf(job.if, { github: { event_name: 'pull_request', event: { action, pull_request: { labels: [] }, ...extra } }, inputs: {} })
    expect(on('labeled', { label: { name: 'desktop-tested' } })).toBe(false)
    expect(on('unlabeled', { label: { name: 'ci-run' } })).toBe(false)
    expect(on('edited', { changes: { title: { from: 'old' } } })).toBe(false)
    expect(on('edited', {})).toBe(false)
    // `ci-run` added replaces the in-flight run of the same group, so it must still build.
    expect(on('labeled', { label: { name: 'ci-run' } })).toBe(true)
    expect(on('edited', { changes: { base: { ref: { from: 'main' } } } })).toBe(true)
  })

  it('a dispatch runs it only when it names the helper input (a yes or no, default no), given as GitHub gives it', () => {
    expect(ci.on.workflow_dispatch.inputs.helper, 'ci.yml has no `helper` dispatch input').toMatchObject({ type: 'boolean', required: false, default: false })
    expect(ci.on.workflow_dispatch.inputs.helper.description).toMatch(/\S/)
    expect(evalIf(job.if, dispatch({ helper: 'true' }))).toBe(true)
    // Left out, the input is its default, 'false'; a string 'false' is not a yes.
    expect(evalIf(job.if, dispatch({}))).toBe(false)
    expect(evalIf(job.if, dispatch({ helper: 'false' }))).toBe(false)
    // Every other input, set, neither starts it alone nor stops it beside a yes.
    const others = Object.keys(ci.on.workflow_dispatch.inputs).filter((name) => name !== 'helper')
    expect(others.length).toBeGreaterThan(0)
    for (const name of others) {
      const value = ci.on.workflow_dispatch.inputs[name].type === 'boolean' ? 'true' : 'set'
      expect(evalIf(job.if, dispatch({ [name]: value })), name).toBe(false)
      expect(evalIf(job.if, dispatch({ helper: 'true', [name]: value })), name).toBe(true)
    }
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

/**
 * The static Linux helper (plan 2.1.3-beta.13 C2, aicc_planning#377): the
 * Linux leg also builds the helper for musl, checks the file is static and
 * uploads it as helper-linux-musl, first for probes P3 and P6 on remote
 * hosts. From 2.1.3-beta.17 the Windows installer carries that file, built by
 * release.yml with these steps word for word (helper-release-job.test.ts).
 *
 * Not checked here: that the musl build links, and that readelf prints what
 * the check looks for. Only CI builds Rust; the check step runs itself on the
 * glibc debug build on every run and fails unless it finds that one dynamic.
 */
describe('ci.yml: the static Linux helper, on the Linux leg only', () => {
  const STATIC = ['Build the static Linux helper', 'Check the Linux helper is static', 'Upload the static Linux helper']
  const runs = (name: string, present: string | undefined, os: string) => evalIf(named(name).if, stepCtx('true', present, os))

  it('builds, checks and uploads, in that order, after the build and test every OS runs', () => {
    const at = (name: string) => job.steps.findIndex((s) => s.name === name)
    const [build, check, upload] = STATIC.map(at)
    expect(build, 'no static build step').toBeGreaterThan(at('Test'))
    expect(at('Test')).toBeGreaterThan(at('Build'))
    expect(check).toBe(build + 1)
    expect(upload).toBe(check + 1)
  })

  it('runs on Linux only, and only once Cargo.lock is committed', () => {
    for (const name of STATIC) {
      expect(runs(name, 'true', 'ubuntu-latest'), name).toBe(true)
      expect(runs(name, 'true', 'windows-2025'), name).toBe(false)
      expect(runs(name, 'true', 'macos-latest'), name).toBe(false)
      for (const os of OSES) expect(runs(name, 'false', os), `${name} on ${os} with no Cargo.lock`).toBe(false)
    }
  })

  it('builds the release helper for x86_64-unknown-linux-musl with --locked, in helper/', () => {
    const step = named('Build the static Linux helper')
    expect(step['working-directory']).toBe('helper')
    const lines = (step.run ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    expect(lines).toEqual([
      'rustup target add x86_64-unknown-linux-musl',
      'cargo build --locked --release --target x86_64-unknown-linux-musl --bin aicc-helper',
      'mkdir -p target/helper-linux-musl',
      'cp target/x86_64-unknown-linux-musl/release/aicc-helper target/helper-linux-musl/',
    ])
  })

  it('the check only reads: no secret, no expression, no action, nothing written but the step summary', () => {
    const step = named('Check the Linux helper is static')
    const run = step.run ?? ''
    expect(step.uses).toBeUndefined()
    expect(step.with).toBeUndefined()
    expect((step as { env?: unknown }).env).toBeUndefined()
    expect(run).not.toMatch(/\$\{\{/)
    expect(run).not.toMatch(/secret|token|password|\bcurl\b|\bwget\b|\bssh\b/i)
    expect(run).not.toMatch(/(^|[\s;&|])(rm|mv|cp|chmod|chown|ln|tee|dd|install|strip|patchelf)\s/m)
    // Every redirection that writes goes to the step summary.
    const writes = run.match(/>>?\s*\S+/g) ?? []
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) expect(w).toMatch(/^>>\s*"\$GITHUB_STEP_SUMMARY"$/)
  })

  it('the check fails on a program interpreter, a shared library or a file that is not x86-64 ELF, and must find the glibc debug build dynamic', () => {
    const run = named('Check the Linux helper is static').run ?? ''
    expect(run).toContain('readelf --file-header --wide "$1") || return 2')
    expect(run).toContain("grep -q 'Class:[[:space:]]*ELF64'")
    expect(run).toContain("grep -q 'Machine:[[:space:]]*Advanced Micro Devices X86-64'")
    expect(run).toContain("grep -q 'INTERP' <<<\"$segs\" && return 1")
    expect(run).toContain("grep -q '(NEEDED)' <<<\"$dyn\" && return 1")
    // The built file must be static: any status but 0 fails the step.
    expect(run).toMatch(/built=target\/helper-linux-musl\/aicc-helper\n\s*rc=0; is_static "\$built" \|\| rc=\$\?/)
    expect(run).toMatch(/if \[ "\$rc" != 0 \]; then\n[^\n]*\n\s*exit 1/)
    // The glibc debug build must be found not static (1): 0 or 2 fails the step.
    expect(run).toMatch(/rc=0; is_static target\/debug\/aicc-helper \|\| rc=\$\?\n\s*if \[ "\$rc" != 1 \]; then\n[^\n]*\n\s*exit 1/)
    // The debug build it reads is the one the Build step makes on this runner.
    expect(named('Build').run).toBe('cargo build --locked --all-targets')
  })

  it('uploads it as helper-linux-musl from the Linux job only, with an action pinned by commit', () => {
    const upload = named('Upload the static Linux helper')
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/)
    expect(upload.with).toEqual({ name: 'helper-linux-musl', path: 'helper/target/helper-linux-musl', 'if-no-files-found': 'error', 'retention-days': 14 })
  })

  it('no step of the job reads a secret or a token', () => {
    const text = JSON.stringify(job.steps)
    expect(text).not.toMatch(/secrets\.|github\.token|GITHUB_TOKEN/)
  })

  // The Pi's setup note 8 (no TCP listener): the helper's own source has no
  // networking at all, checked on every Helper run; the arm64 job builds the same source.
  it('the helper source is checked for networking types on every leg, once Cargo.lock is committed', () => {
    const check = named('No networking in the helper source')
    expect(check['working-directory']).toBe('helper')
    expect(check.run).toContain("grep -rnE 'std::net|TcpStream|TcpListener|UdpSocket|ToSocketAddrs' src tests")
    expect(check.run).toMatch(/exit 1/)
    for (const os of OSES) expect(runs(check.name!, 'true', os), os).toBe(true)
  })
})

/**
 * The arm64 Helper job (2.1.3-beta.19, section 1.3, aicc_planning#438): on
 * GitHub's arm64 runner it builds and tests the helper as the Helper job does,
 * then builds the release helper for aarch64-unknown-linux-musl natively,
 * checks it is a static AArch64 program, runs it once and uploads it as
 * helper-linux-musl-arm64. Its condition, decision and step conditions are the
 * Helper job's; release.yml and the release/* test installer build the file
 * with its four steps word for word (helper-release-job.test.ts).
 *
 * Not checked here: that the build links on the runner, that readelf prints
 * AArch64, or that the file runs (a dispatch shows those: the check step
 * proves itself on the glibc debug build each run, and the run step fails
 * unless the file prints this crate's version).
 */
describe('ci.yml: the arm64 Helper job', () => {
  const arm = ci.jobs['helper-linux-arm64'] as Job & { 'runs-on'?: string; env?: Record<string, string> }
  const ARM_OS = 'ubuntu-24.04-arm'
  const armStep = (name: string) => {
    const s = arm.steps.find((x) => x.name === name)
    if (!s) throw new Error(`no step named "${name}"`)
    return s
  }
  const armCtx = (helper: string | undefined): GhaContext => ({ github: { event_name: 'pull_request' }, runner: { os: 'Linux' }, steps: { scope: { outputs: helper === undefined ? {} : { helper } } } })
  const ARM_FOUR = ['Build the static arm64 Linux helper', 'Check the arm64 Linux helper is static', 'Run the arm64 Linux helper once', 'Upload the static arm64 Linux helper']
  /** A step as it does its work: everything but its condition. */
  const work = (s: Step) => ({ name: s.name, uses: s.uses, with: s.with, shell: s.shell, run: s.run, wd: s['working-directory'] })

  it('runs on GitHub\'s arm64 runner under a name that is no required check and no Test job, reading only, with the Helper job\'s environment', () => {
    expect(arm, 'ci.yml has no helper-linux-arm64 job').toBeDefined()
    expect(arm.name).toBe('Helper (ubuntu-24.04-arm)')
    expect(arm['runs-on']).toBe(ARM_OS)
    expect(REQUIRED_CHECKS).not.toContain(arm.name)
    expect(arm.name!.startsWith('Test (')).toBe(false)
    expect(arm.strategy).toBeUndefined()
    expect(arm.needs).toBeUndefined()
    expect(arm['continue-on-error']).toBeUndefined()
    expect(arm.permissions).toEqual({ contents: 'read' })
    expect(arm['timeout-minutes']).toBe(job['timeout-minutes'])
    expect(arm.env).toEqual((job as Job & { env?: Record<string, string> }).env)
    expect(JSON.stringify(arm.steps)).not.toMatch(/secrets\.|github\.token|GITHUB_TOKEN/)
    for (const s of arm.steps) {
      if (s.uses) expect(s.uses, s.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
      expect(s['continue-on-error'], s.name).toBeUndefined()
    }
  })

  it('starts exactly when the Helper job does: the same condition, so a dispatch that names helper runs it, and no other dispatch does', () => {
    expect(arm.if).toBe(job.if)
    expect(evalIf(arm.if, dispatch({ helper: 'true' }))).toBe(true)
    expect(evalIf(arm.if, dispatch({}))).toBe(false)
    for (const name of Object.keys(ci.on.workflow_dispatch.inputs).filter((n) => n !== 'helper')) {
      const value = ci.on.workflow_dispatch.inputs[name].type === 'boolean' ? 'true' : 'set'
      expect(evalIf(arm.if, dispatch({ [name]: value })), name).toBe(false)
    }
  })

  it('checks out with the base and decides as the Helper job does; every later step is skipped by the literal helper=false only', () => {
    const [checkout, scope, ...rest] = arm.steps
    expect(checkout).toEqual(job.steps[0])
    expect(scope).toEqual(job.steps[1])
    expect(rest.length).toBe(7)
    for (const s of rest) {
      expect(s.if, `${s.name} has no condition`).toBeDefined()
      expect(evalIf(s.if, armCtx('false')), s.name).toBe(false)
      expect(evalIf(s.if, armCtx('true')), s.name).toBe(true)
      expect(evalIf(s.if, armCtx(undefined)), s.name).toBe(true)
    }
  })

  it('builds and tests the helper as the Helper job does, with --locked, then the four arm64 steps in order', () => {
    for (const name of ['Install the pinned Rust toolchain', 'Build', 'Test']) expect(work(armStep(name)), name).toEqual(work(named(name)))
    const minutes = (s: Step) => (s as Record<string, unknown>)['timeout-minutes']
    expect(minutes(armStep('Test'))).toBe(minutes(named('Test')))
    expect(minutes(armStep('Test'))).toBe(15)
    const at = (name: string) => arm.steps.findIndex((s) => s.name === name)
    expect(ARM_FOUR.map(at)).toEqual([at('Test') + 1, at('Test') + 2, at('Test') + 3, at('Test') + 4])
    expect(at('Test')).toBe(at('Build') + 1)
    for (const s of arm.steps) {
      if (/^\s*(cargo|rustup|rustc)\b/m.test(s.run ?? '')) expect(s['working-directory'], s.name).toBe('helper')
      for (const line of (s.run ?? '').split('\n')) if (/^\s*cargo (build|test|run|check|clippy)\b/.test(line)) expect(line, `${s.name}: ${line}`).toContain('--locked')
    }
  })

  it('builds the release helper for aarch64-unknown-linux-musl, natively, into the folder the installer takes it from', () => {
    const lines = (armStep('Build the static arm64 Linux helper').run ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    expect(lines).toEqual([
      'rustup target add aarch64-unknown-linux-musl',
      'cargo build --locked --release --target aarch64-unknown-linux-musl --bin aicc-helper',
      'mkdir -p target/helper-linux-musl-arm64',
      'cp target/aarch64-unknown-linux-musl/release/aicc-helper target/helper-linux-musl-arm64/',
    ])
    // No cross linker and no other target: the runner is the machine kind.
    expect(JSON.stringify(arm.steps)).not.toMatch(/x86_64|CARGO_TARGET_|linker|rust-lld|cross\b/)
  })

  it('the check is the Helper job\'s, for the AArch64 machine: it only reads, fails on an interpreter, a shared library or another machine, and must find the glibc debug build dynamic', () => {
    const run = armStep('Check the arm64 Linux helper is static').run ?? ''
    const x86 = named('Check the Linux helper is static').run ?? ''
    // The same check with three words changed: the machine, its name and the file.
    expect(run).toBe(x86
      .replace("grep -q 'Machine:[[:space:]]*Advanced Micro Devices X86-64'", "grep -q 'Machine:[[:space:]]*AArch64'")
      .replace('# 0 static, 1 not static, 2 not an x86-64 ELF file or not read.', '# 0 static, 1 not static, 2 not an AArch64 ELF file or not read.')
      .replace('built=target/helper-linux-musl/aicc-helper', 'built=target/helper-linux-musl-arm64/aicc-helper')
      .replace('echo "Static Linux helper:', 'echo "Static arm64 Linux helper:')
      .replace('is not a static x86-64 ELF program', 'is not a static AArch64 ELF program'))
    expect(run).toContain("grep -q 'Machine:[[:space:]]*AArch64' <<<\"$hdr\" || return 2")
    expect(run).toMatch(/rc=0; is_static target\/debug\/aicc-helper \|\| rc=\$\?\n\s*if \[ "\$rc" != 1 \]; then\n[^\n]*\n\s*exit 1/)
    const writes = run.match(/>>?\s*\S+/g) ?? []
    for (const w of writes) expect(w).toMatch(/^>>\s*"\$GITHUB_STEP_SUMMARY"$/)
    expect(run).not.toMatch(/(^|[\s;&|])(rm|mv|cp|chmod|chown|ln|tee|dd|install|strip|patchelf)\s/m)
  })

  it('runs the file once, and fails unless it prints this crate\'s version from helper/Cargo.toml\'s package section', () => {
    const s = armStep('Run the arm64 Linux helper once')
    expect(s['working-directory']).toBe('helper')
    const run = s.run ?? ''
    expect(run).toContain('said=$(target/helper-linux-musl-arm64/aicc-helper version)')
    expect(run).toContain(`want="aicc-helper $(awk -F'"' '/^\\[/ { p = ($0 == "[package]") } p && /^version = / { print $2; exit }' Cargo.toml)"`)
    expect(run).toMatch(/if \[ "\$said" != "\$want" \]; then\n[^\n]*\n\s*exit 1/)
    expect(run).not.toMatch(/\$\{\{/)
    for (const w of run.match(/>>?\s*\S+/g) ?? []) expect(w).toMatch(/^>>\s*"\$GITHUB_STEP_SUMMARY"$/)
  })

  it('uploads it as helper-linux-musl-arm64, a name of its own, with an action pinned by commit', () => {
    const upload = armStep('Upload the static arm64 Linux helper')
    expect(upload.uses).toBe(named('Upload the static Linux helper').uses)
    expect(upload.with).toEqual({ name: 'helper-linux-musl-arm64', path: 'helper/target/helper-linux-musl-arm64', 'if-no-files-found': 'error', 'retention-days': 14 })
  })
})
