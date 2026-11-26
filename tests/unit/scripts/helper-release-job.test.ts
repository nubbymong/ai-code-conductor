import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { posix, resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
import { LINUX_ARM64_HELPER_SOURCE, LINUX_HELPER_SOURCE, MANIFEST_SOURCE } from '../../../scripts/verify-bundled-helper.mjs'

/**
 * 2.1.3-beta.17 (A1, remote step 1): the Windows installer carries the static
 * Linux helper the app uploads to a Linux machine, and the manifest of its
 * hash. release.yml builds it in a Linux job with the Helper job's three
 * steps word for word, build-windows needs that job, downloads its file to
 * where package.json's extraResources takes it, and writes the manifest
 * before electron-builder signs and packages anything. ci.yml's release/*
 * test installer does the same in two jobs of its own. Read as the workflow
 * carries it out, not matched as text where it can be avoided.
 *
 * From 2.1.3-beta.19 (section 1.3, aicc_planning#438) the installer also
 * carries the arm64 static Linux helper: release.yml's helper-linux-arm64 job
 * and the release/* test installer's arm64 job build it on GitHub's arm64
 * runner with the arm64 Helper job's four steps word for word (ci.yml
 * helper-linux-arm64), and the Windows jobs need both Linux jobs and download
 * both files before the manifest is written.
 *
 * Not checked here: that the musl build links and that readelf prints what
 * the check looks for (only CI builds Rust; the check proves itself on the
 * glibc debug build every run), nor that a dry run of release.yml starts from
 * a branch (a dispatch shows that).
 */

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')
type Step = { name?: string; id?: string; if?: unknown; uses?: string; run?: string; with?: Record<string, unknown>; shell?: string; env?: Record<string, string>; 'working-directory'?: string; 'continue-on-error'?: unknown }
type Job = { name?: string; if?: unknown; needs?: string | string[]; steps: Step[]; permissions?: Record<string, string>; 'runs-on'?: string; env?: Record<string, string> }
const ci = yaml.load(read('.github/workflows/ci.yml')) as { jobs: Record<string, Job> }
const release = yaml.load(read('.github/workflows/release.yml')) as { jobs: Record<string, Job> }
const pkg = JSON.parse(read('package.json')) as { build: { win: { extraResources: Array<{ from: string; to: string; filter?: string[] }> } } }

/** The Helper job's three steps that make the static Linux helper. */
const THREE = ['Build the static Linux helper', 'Check the Linux helper is static', 'Upload the static Linux helper']
/** The arm64 Helper job's four steps that make the arm64 static Linux helper (2.1.3-beta.19). */
const ARM_FOUR = ['Build the static arm64 Linux helper', 'Check the arm64 Linux helper is static', 'Run the arm64 Linux helper once', 'Upload the static arm64 Linux helper']
const DEBUG_BUILD = 'Build the glibc debug helper the static check compares against'

const step = (job: Job, name: string): Step => {
  const s = job.steps.find((x) => x.name === name)
  if (!s) throw new Error(`no step named "${name}"`)
  return s
}
const indexOf = (job: Job, pred: (s: Step) => boolean, what: string): number => {
  const i = job.steps.findIndex(pred)
  if (i < 0) throw new Error(`no step for ${what}`)
  return i
}
/** A step as it does its work: everything but its condition. */
const work = (s: Step) => ({ name: s.name, uses: s.uses, with: s.with, shell: s.shell, run: s.run, env: s.env, wd: s['working-directory'] })
const needsOf = (job: Job) => ([] as string[]).concat(job.needs ?? [])

describe('release.yml: a Linux job builds the static Linux helper with the Helper job\'s steps', () => {
  const linux = release.jobs['helper-linux']
  const helper = ci.jobs.helper

  it('is a Linux job that needs the gate, has no condition (a dry run runs it too), reads only and holds no secret', () => {
    expect(linux, 'release.yml has no helper-linux job').toBeDefined()
    expect(linux.name).toBe('Static Linux helper')
    expect(linux['runs-on']).toBe('ubuntu-latest')
    expect(needsOf(linux)).toEqual(['gate'])
    expect(linux.if).toBeUndefined()
    expect(linux.permissions).toEqual({ contents: 'read' })
    expect(JSON.stringify(linux)).not.toMatch(/secrets\.|github\.token|GITHUB_TOKEN/)
    // build-windows, which needs it, has no condition either: a dry run builds,
    // signs and checks the Windows package with the Linux helper in it.
    expect(release.jobs['build-windows'].if).toBeUndefined()
  })

  it('its three steps are the Helper job\'s word for word, after the glibc debug build the check compares against', () => {
    for (const name of THREE) expect(work(step(linux, name)), name).toEqual(work(step(helper, name)))
    const at = (name: string) => linux.steps.findIndex((s) => s.name === name)
    const [build, check, upload] = THREE.map(at)
    expect(at(DEBUG_BUILD)).toBeGreaterThan(at('Install the pinned Rust toolchain'))
    expect(build).toBeGreaterThan(at(DEBUG_BUILD))
    expect([check, upload]).toEqual([build + 1, build + 2])
    // The debug build is the program the check must find not static.
    expect(step(linux, DEBUG_BUILD).run).toBe('cargo build --locked --bin aicc-helper')
    expect(step(helper, 'Check the Linux helper is static').run).toContain('is_static target/debug/aicc-helper')
    // The same toolchain step as the Helper job, and every cargo step in helper/ with --locked.
    expect(work(step(linux, 'Install the pinned Rust toolchain'))).toEqual(work(step(helper, 'Install the pinned Rust toolchain')))
    for (const s of linux.steps) {
      if (/^\s*(cargo|rustup|rustc)\b/m.test(s.run ?? '')) expect(s['working-directory'], s.name).toBe('helper')
      for (const line of (s.run ?? '').split('\n')) if (/^\s*cargo (build|test)\b/.test(line)) expect(line, s.name).toContain('--locked')
    }
    expect(step(linux, 'Upload the static Linux helper').with).toMatchObject({ name: 'helper-linux-musl', path: posix.dirname(LINUX_HELPER_SOURCE) })
  })
})

describe('release.yml: an arm64 job builds the arm64 static Linux helper with the arm64 Helper job\'s steps (2.1.3-beta.19)', () => {
  const arm = release.jobs['helper-linux-arm64']
  const armHelper = ci.jobs['helper-linux-arm64']

  it('is a job on GitHub\'s arm64 runner that needs the gate, has no condition (a dry run runs it too), reads only and holds no secret', () => {
    expect(arm, 'release.yml has no helper-linux-arm64 job').toBeDefined()
    expect(arm.name).toBe('Static arm64 Linux helper')
    expect(arm['runs-on']).toBe('ubuntu-24.04-arm')
    expect(needsOf(arm)).toEqual(['gate'])
    expect(arm.if).toBeUndefined()
    expect(arm.permissions).toEqual({ contents: 'read' })
    expect(JSON.stringify(arm)).not.toMatch(/secrets\.|github\.token|GITHUB_TOKEN/)
    expect(arm.env).toEqual(release.jobs['helper-linux'].env)
  })

  it('its four steps are the arm64 Helper job\'s word for word, on the same runner, after the glibc debug build the check compares against', () => {
    expect(arm['runs-on']).toBe(armHelper['runs-on'])
    for (const name of ARM_FOUR) expect(work(step(arm, name)), name).toEqual(work(step(armHelper, name)))
    const at = (name: string) => arm.steps.findIndex((s) => s.name === name)
    const [build, check, once, upload] = ARM_FOUR.map(at)
    expect(at(DEBUG_BUILD)).toBeGreaterThan(at('Install the pinned Rust toolchain'))
    expect(build).toBe(at(DEBUG_BUILD) + 1)
    expect([check, once, upload]).toEqual([build + 1, build + 2, build + 3])
    expect(step(arm, DEBUG_BUILD).run).toBe('cargo build --locked --bin aicc-helper')
    expect(work(step(arm, 'Install the pinned Rust toolchain'))).toEqual(work(step(ci.jobs.helper, 'Install the pinned Rust toolchain')))
    for (const s of arm.steps) {
      if (/^\s*(cargo|rustup|rustc)\b/m.test(s.run ?? '')) expect(s['working-directory'], s.name).toBe('helper')
      for (const line of (s.run ?? '').split('\n')) if (/^\s*cargo (build|test)\b/.test(line)) expect(line, s.name).toContain('--locked')
      expect(s.if, s.name).toBeUndefined()
    }
    expect(step(arm, 'Upload the static arm64 Linux helper').with).toMatchObject({ name: 'helper-linux-musl-arm64', path: posix.dirname(LINUX_ARM64_HELPER_SOURCE) })
    // The two Linux jobs upload under two names, so build-windows takes each.
    expect(step(arm, 'Upload the static arm64 Linux helper').with!.name).not.toBe(step(release.jobs['helper-linux'], 'Upload the static Linux helper').with!.name)
  })
})

describe('release.yml: build-windows packages the static Linux helper and its manifest', () => {
  const win = release.jobs['build-windows']

  it('needs both Linux jobs, beside the gate and the green-run lookup', () => {
    expect(needsOf(win)).toEqual(['gate', 'ci-reuse', 'helper-linux', 'helper-linux-arm64'])
    // The release job and the other builds are wired as before.
    expect(needsOf(release.jobs.release)).toEqual(['build-windows', 'build-macos', 'build-linux'])
    expect(needsOf(release.jobs['build-linux'])).toEqual(['gate', 'ci-reuse'])
  })

  it('downloads the file to where package.json takes it, writes the manifest, then signs and packages: in that order, each with no condition', () => {
    const helperBuild = indexOf(win, (s) => s.name === 'Build the session helper', 'the helper build')
    const download = indexOf(win, (s) => /^actions\/download-artifact@/.test(s.uses ?? ''), 'the download')
    const manifest = indexOf(win, (s) => s.run?.trim() === 'node scripts/write-helper-manifest.mjs', 'the manifest')
    const signing = indexOf(win, (s) => /eSigner/.test(s.name ?? ''), 'the signing setup')
    const pack = indexOf(win, (s) => /npx electron-builder --win --publish never/.test(s.run ?? ''), 'the packaging')
    const verify = indexOf(win, (s) => s.run?.trim() === 'npm run verify:helper', 'the packaged check')
    expect(helperBuild).toBeLessThan(download)
    expect(download).toBeLessThan(manifest)
    expect(manifest).toBeLessThan(signing)
    expect(manifest).toBeLessThan(pack)
    expect(verify).toBeGreaterThan(pack)
    for (const i of [download, manifest, verify]) expect(win.steps[i].if, win.steps[i].name).toBeUndefined()
    // The download takes what the Linux job uploads, to the folder the
    // extraResources entry copies and the manifest writer reads.
    const upload = step(release.jobs['helper-linux'], 'Upload the static Linux helper')
    expect(win.steps[download].with).toEqual({ name: upload.with!.name, path: posix.dirname(LINUX_HELPER_SOURCE) })
    // The arm64 file the same way, from the arm64 job, before the manifest too (2.1.3-beta.19).
    const armDownload = indexOf(win, (s) => s.name === 'Download the static arm64 Linux helper', 'the arm64 download')
    expect(win.steps[armDownload].uses).toBe(win.steps[download].uses)
    expect(win.steps[armDownload].if).toBeUndefined()
    expect(armDownload).toBeGreaterThan(helperBuild)
    expect(armDownload).toBeLessThan(manifest)
    const armUpload = step(release.jobs['helper-linux-arm64'], 'Upload the static arm64 Linux helper')
    expect(win.steps[armDownload].with).toEqual({ name: armUpload.with!.name, path: posix.dirname(LINUX_ARM64_HELPER_SOURCE) })
  })

  it('package.json copies each folder\'s one file to resources/helper/linux-x64 and linux-arm64, and the manifest to resources/helper', () => {
    const entries = pkg.build.win.extraResources
    expect(entries).toContainEqual({ from: posix.dirname(LINUX_HELPER_SOURCE), to: 'helper/linux-x64', filter: [posix.basename(LINUX_HELPER_SOURCE)] })
    expect(entries).toContainEqual({ from: posix.dirname(LINUX_ARM64_HELPER_SOURCE), to: 'helper/linux-arm64', filter: [posix.basename(LINUX_ARM64_HELPER_SOURCE)] })
    expect(entries).toContainEqual({ from: posix.dirname(MANIFEST_SOURCE), to: 'helper', filter: [posix.basename(MANIFEST_SOURCE)] })
    // The Windows helper's entry stays first and stays a folder entry (it is signed).
    expect(entries[0]).toEqual({ from: 'helper/target/release', to: 'helper', filter: ['aicc-helper.exe'] })
  })
})

describe('ci.yml: the release/* test installer packages them the same way, in two jobs of its own', () => {
  const linux = ci.jobs['release-helper-linux']
  const win = ci.jobs['release-windows-installer']
  const helper = ci.jobs.helper

  it('the Linux job runs the Helper job\'s steps, uploading under a name the Helper job does not use', () => {
    for (const name of THREE.slice(0, 2)) expect(work(step(linux, name)), name).toEqual(work(step(helper, name)))
    const upload = step(linux, 'Upload the static Linux helper')
    expect(work(upload)).toEqual({ ...work(step(helper, 'Upload the static Linux helper')), with: { ...step(helper, 'Upload the static Linux helper').with, name: 'helper-linux-musl-installer' } })
    // A run of a release/* PR can upload both, and two uploads of one name would collide.
    expect(upload.with!.name).not.toBe(step(helper, 'Upload the static Linux helper').with!.name)
    expect(step(linux, DEBUG_BUILD).run).toBe('cargo build --locked --bin aicc-helper')
    expect(linux.permissions).toEqual({ contents: 'read' })
  })

  it('the Windows job needs both Linux jobs, downloads their uploads to the folders package.json takes, and writes the manifest before packaging', () => {
    const arm = ci.jobs['release-helper-linux-arm64']
    expect(needsOf(win)).toEqual(['release-helper-linux', 'release-helper-linux-arm64'])
    expect(win.if).toBe(linux.if)
    expect(arm.if).toBe(linux.if)
    const download = indexOf(win, (s) => /^actions\/download-artifact@/.test(s.uses ?? ''), 'the download')
    expect(win.steps[download].with).toEqual({ name: step(linux, 'Upload the static Linux helper').with!.name, path: posix.dirname(LINUX_HELPER_SOURCE) })
    const armDownload = indexOf(win, (s) => s.name === 'Download the static arm64 Linux helper', 'the arm64 download')
    expect(win.steps[armDownload].with).toEqual({ name: step(arm, 'Upload the static arm64 Linux helper').with!.name, path: posix.dirname(LINUX_ARM64_HELPER_SOURCE) })
    const manifest = indexOf(win, (s) => s.run?.trim() === 'node scripts/write-helper-manifest.mjs', 'the manifest')
    const pack = indexOf(win, (s) => s.run?.trim() === 'npx electron-builder --win --config.npmRebuild=false', 'the packaging')
    expect(download).toBeLessThan(manifest)
    expect(armDownload).toBeLessThan(manifest)
    expect(manifest).toBeLessThan(pack)
    expect(win.permissions).toEqual({ contents: 'read' })
  })

  it('the arm64 job runs the arm64 Helper job\'s steps on the same runner, uploading under a name that job does not use', () => {
    const arm = ci.jobs['release-helper-linux-arm64']
    const armHelper = ci.jobs['helper-linux-arm64']
    expect(arm['runs-on']).toBe('ubuntu-24.04-arm')
    expect(arm['runs-on']).toBe(armHelper['runs-on'])
    for (const name of ARM_FOUR.slice(0, 3)) expect(work(step(arm, name)), name).toEqual(work(step(armHelper, name)))
    const upload = step(arm, 'Upload the static arm64 Linux helper')
    expect(work(upload)).toEqual({ ...work(step(armHelper, 'Upload the static arm64 Linux helper')), with: { ...step(armHelper, 'Upload the static arm64 Linux helper').with, name: 'helper-linux-musl-arm64-installer' } })
    expect(upload.with!.name).not.toBe(step(armHelper, 'Upload the static arm64 Linux helper').with!.name)
    expect(upload.with!.name).not.toBe(step(linux, 'Upload the static Linux helper').with!.name)
    expect(step(arm, DEBUG_BUILD).run).toBe('cargo build --locked --bin aicc-helper')
    expect(work(step(arm, 'Install the pinned Rust toolchain'))).toEqual(work(step(helper, 'Install the pinned Rust toolchain')))
    const at = (name: string) => arm.steps.findIndex((s) => s.name === name)
    expect(ARM_FOUR.map(at)).toEqual([at(DEBUG_BUILD) + 1, at(DEBUG_BUILD) + 2, at(DEBUG_BUILD) + 3, at(DEBUG_BUILD) + 4])
    for (const s of arm.steps) expect(s.if, s.name).toBeUndefined()
    expect(arm.permissions).toEqual({ contents: 'read' })
    expect(JSON.stringify(arm)).not.toMatch(/secrets\.|github\.token|GITHUB_TOKEN/)
  })
})
