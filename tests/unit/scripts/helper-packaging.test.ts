import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'

/**
 * 2.1.3-beta.6 (plan section B): the installer ships the session helper, and
 * only it. Each platform section of package.json's `build` copies the one
 * release program the release workflow builds in helper/
 * (helper/target/release/aicc-helper, with .exe on Windows) to
 * resources/helper/, and nothing else of helper/ (its source, fixtures,
 * probes, the fake CLI or a debug build) reaches the installer.
 * `build.files` is a whitelist and `extraResources` / `extraFiles` copy named
 * files, so a helper/ at the top level is packaged only by those entries.
 * scripts/verify-bundled-helper.mjs then checks the packaged copy itself.
 *
 * From 2.1.3-beta.17 (A1, remote step 1) the Windows package also carries the
 * static Linux helper the release job downloads to
 * helper/target/helper-linux-musl/, as resources/helper/linux-x64/aicc-helper,
 * and the manifest scripts/write-helper-manifest.mjs writes to
 * helper/target/helper-manifest/, as resources/helper/manifest.json. Each is a
 * folder entry with a one-file filter, so nothing else beside them ships.
 * From 2.1.3-beta.19 (section 1.3) it also carries the arm64 static Linux
 * helper the arm64 job's artifact puts in helper/target/helper-linux-musl-arm64/,
 * as resources/helper/linux-arm64/aicc-helper, by a folder entry of its own.
 */

const ROOT = resolve(__dirname, '../../..')
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')) as { build: Record<string, Record<string, unknown>>; scripts: Record<string, string> }

/** electron-builder's file globs, enough for the patterns this repo uses: `**` crosses folders, `*` does not. */
function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      i++
      if (pattern[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else {
        re += '.*'
      }
    } else if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/**
 * `value` is the path or glob. For a FileSet object it is the source root
 * (`from`, the project root when omitted) and `filter` is the list of globs,
 * relative to that root, that pick files under it (electron-builder's default
 * is everything).
 */
type Entry = { list: 'files' | 'extraResources' | 'extraFiles'; value: string; fileSet?: { filter: string[] } }

/**
 * Every path or glob a `files`, `extraResources` or `extraFiles` list names,
 * anywhere under `build` (the platform sections too). An entry is a string, or
 * a { from, to, filter } FileSet object: `from` is the source root that gets
 * copied and `filter` narrows what under it.
 */
function packagingEntries(node: unknown, out: Entry[] = []): Entry[] {
  if (Array.isArray(node)) node.forEach((n) => packagingEntries(n, out))
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'files' || k === 'extraResources' || k === 'extraFiles') {
        for (const item of ([] as unknown[]).concat(v)) {
          if (typeof item === 'string') out.push({ list: k, value: item })
          else if (item && typeof item === 'object') {
            const set = item as { from?: unknown; filter?: unknown }
            const filter = ([] as unknown[]).concat(set.filter ?? []).filter((f): f is string => typeof f === 'string')
            out.push({ list: k, value: typeof set.from === 'string' ? set.from : '.', fileSet: { filter: filter.length > 0 ? filter : ['**/*'] } })
          }
        }
      } else packagingEntries(v, out)
    }
  }
  return out
}

/** A project-relative path as electron-builder reads it: forward slashes, no `./`, no trailing slash. */
const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')

/**
 * Would this packaging entry take `file` (a project-relative path)? A string
 * is a path or glob. A FileSet takes what is under its source root and matches
 * one of its filters, judged against the path relative to that root. Negated
 * filters are ignored, so the answer errs towards "it would ship".
 */
function takes(entry: Entry, file: string): boolean {
  const root = normPath(entry.value)
  if (!entry.fileSet) {
    if (entry.value.startsWith('!')) return false
    // A path or glob; a bare folder name takes everything under it.
    return globToRegExp(root).test(file) || globToRegExp(`${root}/**`).test(file)
  }
  const filters = entry.fileSet.filter.filter((f) => !f.startsWith('!'))
  if (root === '' || root === '.') return filters.some((f) => globToRegExp(normPath(f)).test(file))
  if (root.includes('*')) return globToRegExp(root).test(file) || globToRegExp(`${root}/**`).test(file)
  if (file === root) return true
  if (!file.startsWith(`${root}/`)) return false
  const rel = file.slice(root.length + 1)
  return filters.some((f) => globToRegExp(normPath(f)).test(rel))
}

/** A path the helper folder holds, or will hold, that must never ship. */
const HELPER_FILES = [
  'helper/Cargo.toml',
  'helper/Cargo.lock',
  'helper/rust-toolchain.toml',
  'helper/src/main.rs',
  'helper/src/pty/windows.rs',
  'helper/fixtures/frames.json',
  'helper/probes/p7-windows-survival.ps1',
  'helper/target/debug/aicc-helper',
  'helper/target/debug/aicc-helper.exe',
  'helper/target/release/aicc-fake-cli',
  'helper/target/release/aicc-fake-cli.exe',
  'helper/target/release/aicc-helper.d',
  'helper/target/release/aicc-helper.pdb',
  'helper/target/release/aicc_helper.pdb',
  'helper/target/release/deps/aicc_helper-0123456789abcdef.exe',
  'helper/target/release/build/aicc-helper-0123456789abcdef/output',
  // The musl build's own output, and anything else beside the files the
  // Windows package takes from the Linux helper's and the manifest's folders.
  'helper/target/x86_64-unknown-linux-musl/release/aicc-helper',
  'helper/target/x86_64-unknown-linux-musl/release/aicc-helper.d',
  'helper/target/helper-linux-musl/aicc-fake-cli',
  'helper/target/aarch64-unknown-linux-musl/release/aicc-helper',
  'helper/target/aarch64-unknown-linux-musl/release/aicc-helper.d',
  'helper/target/helper-linux-musl-arm64/aicc-fake-cli',
  'helper/target/helper-manifest/manifest.json.tmp',
]

/**
 * The one file each platform ships (`file`), and the packaging entry that puts
 * it under resources/helper/ (`entry`). Windows uses a FOLDER entry with a
 * filter, not a single-file entry: electron-builder copies a single-file
 * extraResources entry straight across (app-builder-lib fileMatcher copyFiles,
 * the `fromStat.isFile()` branch) and never runs it through the transformer
 * that signs each .exe, so 2.1.3-beta.6's first release build packaged an
 * unsigned helper and failed its Verify Windows signature step.
 */
const SHIPPED = {
  win: { entry: { from: 'helper/target/release', to: 'helper', filter: ['aicc-helper.exe'] }, file: 'helper/target/release/aicc-helper.exe' },
  mac: { entry: { from: 'helper/target/release/aicc-helper', to: 'helper/aicc-helper' }, file: 'helper/target/release/aicc-helper' },
  linux: { entry: { from: 'helper/target/release/aicc-helper', to: 'helper/aicc-helper' }, file: 'helper/target/release/aicc-helper' },
} as const

/**
 * The two more files the Windows package carries (2.1.3-beta.17): the static
 * Linux helper and the manifest, each by a folder entry with a one-file filter.
 */
const WIN_LINUX = [
  { entry: { from: 'helper/target/helper-linux-musl', to: 'helper/linux-x64', filter: ['aicc-helper'] }, file: 'helper/target/helper-linux-musl/aicc-helper' },
  { entry: { from: 'helper/target/helper-linux-musl-arm64', to: 'helper/linux-arm64', filter: ['aicc-helper'] }, file: 'helper/target/helper-linux-musl-arm64/aicc-helper' },
  { entry: { from: 'helper/target/helper-manifest', to: 'helper', filter: ['manifest.json'] }, file: 'helper/target/helper-manifest/manifest.json' },
] as const

describe('the installer ships the release session helper and nothing else of helper/', () => {
  const entries = packagingEntries(pkg.build)

  it('the packaging lists are read (a vacuous pass is no pass)', () => {
    const values = entries.map((e) => e.value)
    expect(values).toContain('out/**/*')
    expect(values).toContain('resources/**/*')
    expect(entries.some((e) => e.list === 'files')).toBe(true)
    expect(entries.some((e) => e.list === 'extraResources')).toBe(true)
  })

  it('the matcher agrees with electron-builder on the patterns in use', () => {
    expect(globToRegExp('resources/**/*').test('resources/icon.png')).toBe(true)
    expect(globToRegExp('resources/**/*').test('resources/a/b/c.txt')).toBe(true)
    expect(globToRegExp('out/**/*').test('out/main/index.js')).toBe(true)
    expect(globToRegExp('NOTICE').test('NOTICE')).toBe(true)
    expect(globToRegExp('scripts/vision-cli.js').test('scripts/vision-cli.js')).toBe(true)
    expect(globToRegExp('scripts/*.js').test('scripts/a/b.js')).toBe(false)
    // The shape a careless line would take, and it WOULD match:
    expect(globToRegExp('helper/**/*').test('helper/Cargo.toml')).toBe(true)
    expect(globToRegExp('**/*').test('helper/Cargo.toml')).toBe(true)
  })

  it('each platform copies exactly its release helper to resources/helper/ (Windows by a folder entry, so it is signed)', () => {
    for (const [platform, want] of Object.entries(SHIPPED)) {
      const section = packagingEntries(pkg.build[platform]).filter((e) => e.list !== 'files')
      const helperEntries = section.filter((e) => normPath(e.value).startsWith('helper'))
      // Windows: the helper, then the static Linux helper and its manifest.
      expect(helperEntries, platform).toHaveLength(platform === 'win' ? 1 + WIN_LINUX.length : 1)
      const raw = ([] as unknown[]).concat(pkg.build[platform].extraResources ?? []).find((x) => !!x && typeof x === 'object' && (x as { from?: string }).from === want.entry.from)
      expect(raw, platform).toEqual(want.entry)
      expect(takes(helperEntries[0], want.file), platform).toBe(true)
      expect(pkg.build[platform].extraFiles, platform).toBeUndefined()
    }
  })

  it('the Windows package carries the static Linux helper and its manifest, each by a folder entry that takes its one file (2.1.3-beta.17)', () => {
    const raw = ([] as unknown[]).concat(pkg.build.win.extraResources ?? [])
    expect(raw).toEqual([SHIPPED.win.entry, ...WIN_LINUX.map((w) => w.entry)])
    for (const want of WIN_LINUX) {
      const [one] = packagingEntries({ extraResources: [want.entry] })
      expect(takes(one, want.file), want.file).toBe(true)
      for (const file of [...HELPER_FILES, SHIPPED.win.file]) expect(takes(one, file), `${want.entry.from} would copy ${file}`).toBe(false)
    }
    // The macOS and Linux packages carry neither.
    for (const platform of ['mac', 'linux']) {
      for (const want of WIN_LINUX) expect(packagingEntries(pkg.build[platform]).some((e) => takes(e, want.file)), `${platform}: ${want.file}`).toBe(false)
    }
    // Where the release job puts them is where the scripts read and write them.
    const src = readFileSync(resolve(ROOT, 'scripts/verify-bundled-helper.mjs'), 'utf-8')
    expect(src).toContain(`export const LINUX_HELPER_SOURCE = '${WIN_LINUX[0].file}'`)
    expect(src).toContain(`export const LINUX_ARM64_HELPER_SOURCE = '${WIN_LINUX[1].file}'`)
    expect(src).toContain(`export const MANIFEST_SOURCE = '${WIN_LINUX[2].file}'`)
    expect(src).toContain("export const LINUX_HELPER = 'linux-x64/aicc-helper'")
    expect(src).toContain("export const LINUX_ARM64_HELPER = 'linux-arm64/aicc-helper'")
  })

  it('the Windows helper entry is one electron-builder signs: a folder, not a single file', () => {
    const raw = ([] as unknown[]).concat(pkg.build.win.extraResources ?? []).find((x) => !!x && typeof x === 'object' && normPath(String((x as { from?: string }).from)).startsWith('helper')) as { from: string; filter?: string[] }
    expect(raw).toBeDefined()
    // A `from` that names the .exe itself takes the unsigned single-file path.
    expect(raw.from.endsWith('.exe')).toBe(false)
    expect(existsSync(resolve(ROOT, raw.from)) ? statSync(resolve(ROOT, raw.from)).isDirectory() : true, 'from must be a folder when it exists').toBe(true)
    expect(raw.filter).toEqual(['aicc-helper.exe'])
    // Three win settings would stop the extraResources signer for this entry too.
    expect(pkg.build.win.signExecutable, 'signExecutable false stops the extraResources signer').not.toBe(false)
    expect(pkg.build.win.signAndEditExecutable, 'signAndEditExecutable false stops it too').not.toBe(false)
    expect(pkg.build.win.signExts, 'signExts can exclude .exe').toBeUndefined()
  })

  it('the helper is not in the top-level lists, which every platform shares (one platform\'s program would reach the others)', () => {
    for (const list of ['files', 'extraResources', 'extraFiles'] as const) {
      for (const entry of packagingEntries({ [list]: pkg.build[list] ?? [] })) {
        expect(normPath(entry.value).startsWith('helper'), `${entry.value} reaches into helper/`).toBe(false)
      }
    }
  })

  it('no `files` entry of the installer matches a path in helper/, the shipped program included (it goes outside the app archive)', () => {
    const listed = entries.filter((e) => e.list === 'files')
    expect(listed.length).toBeGreaterThan(0)
    for (const entry of listed) {
      for (const file of [...HELPER_FILES, SHIPPED.win.file, SHIPPED.mac.file, ...WIN_LINUX.map((w) => w.file)]) expect(takes(entry, file), `${JSON.stringify(entry)} would package ${file}`).toBe(false)
    }
  })

  it('no extraResources or extraFiles entry takes anything of helper/ but the release helper', () => {
    const copied = entries.filter((e) => e.list !== 'files')
    expect(copied.length).toBeGreaterThan(0)
    for (const entry of copied) {
      for (const file of HELPER_FILES) expect(takes(entry, file), `${JSON.stringify(entry)} would copy ${file}`).toBe(false)
    }
    // And the release helper is taken, so the check above is not vacuous.
    expect(copied.some((e) => takes(e, SHIPPED.win.file))).toBe(true)
    expect(copied.some((e) => takes(e, SHIPPED.mac.file))).toBe(true)
    for (const want of WIN_LINUX) expect(copied.some((e) => takes(e, want.file)), want.file).toBe(true)
  })

  it('FileSet objects keep their source root and filter, and the check judges them (a flattened `from` once matched nothing)', () => {
    const read = (files: unknown[]): Entry[] => packagingEntries({ files })
    // The case that slipped past a guard that only read the root as a glob:
    const [whole] = read([{ from: 'helper', to: 'helper', filter: ['**/*'] }])
    expect(whole.fileSet?.filter).toEqual(['**/*'])
    for (const file of HELPER_FILES) expect(takes(whole, file), file).toBe(true)
    // No filter means everything under the root; a bare filter object means the project root.
    const [noFilter] = read([{ from: 'helper' }])
    expect(takes(noFilter, 'helper/src/main.rs')).toBe(true)
    const [rootSet] = read([{ filter: ['helper/**'] }])
    expect(takes(rootSet, 'helper/Cargo.toml')).toBe(true)
    expect(takes(rootSet, 'out/main/index.js')).toBe(false)
    // A narrower root or filter is judged against the path under that root.
    const [sub] = read([{ from: 'helper/src', filter: ['**/*.rs'] }])
    expect(takes(sub, 'helper/src/pty/windows.rs')).toBe(true)
    expect(takes(sub, 'helper/Cargo.toml')).toBe(false)
    // Roots that are not the helper stay clear of it, and a string path to the folder is caught.
    const [resources] = read([{ from: 'resources', to: 'res', filter: ['**/*'] }])
    for (const file of HELPER_FILES) expect(takes(resources, file), file).toBe(false)
    const [folder] = read(['helper'])
    expect(takes(folder, 'helper/Cargo.toml')).toBe(true)
    expect(takes(read(['!helper/**'])[0], 'helper/Cargo.toml')).toBe(false)
    // Each platform's entry takes its one file and nothing else.
    for (const want of [...Object.values(SHIPPED), ...WIN_LINUX]) {
      const [one] = read([want.entry])
      expect(takes(one, want.file)).toBe(true)
      for (const file of HELPER_FILES) expect(takes(one, file), file).toBe(false)
    }
  })

  it('every file the helper job and the probe need is tracked, not caught by an ignore rule (*.ps1 is ignored repo-wide)', () => {
    const ignored = (p: string): boolean => {
      try {
        execFileSync('git', ['-C', ROOT, 'check-ignore', '-q', '--', p], { stdio: 'ignore' })
        return true // exit 0: some rule ignores it
      } catch {
        return false // exit 1: not ignored
      }
    }
    for (const file of [...HELPER_FILES.filter((f) => !f.includes('/target/')), 'helper/Cargo.lock', 'helper/probes/README.md', 'helper/src/bin/aicc-fake-cli.rs']) {
      expect(ignored(file), `${file} is ignored by .gitignore and would never be committed`).toBe(false)
    }
    // The build output, on the other hand, must be ignored.
    expect(ignored('helper/target/release/aicc-helper.exe')).toBe(true)
    for (const want of WIN_LINUX) expect(ignored(want.file), want.file).toBe(true)
  })

  it('helper/ is a top-level folder, not under resources/ or src/ (resources/ ships whole)', () => {
    expect(existsSync(resolve(ROOT, 'helper/Cargo.toml'))).toBe(true)
    for (const bad of ['resources/helper', 'src/helper', 'src/main/helper', 'build/helper']) expect(existsSync(resolve(ROOT, bad)), bad).toBe(false)
  })

  it('each packaging job builds the helper before it packages, and checks what it packaged', () => {
    const wf = readFileSync(resolve(ROOT, '.github/workflows/release.yml'), 'utf-8').replace(/\r\n/g, '\n')
    const builds = [...wf.matchAll(/- name: Build the session helper\n/g)].map((m) => m.index!)
    expect(builds).toHaveLength(3)
    for (const [job, pack] of [
      ['build-windows', 'npx electron-builder --win --publish never'],
      ['build-macos', 'npx electron-builder --mac dmg --publish never'],
      ['build-linux', 'npx electron-builder --linux --publish never'],
    ]) {
      const jobStart = wf.indexOf(`\n  ${job}:\n`)
      expect(jobStart, job).toBeGreaterThan(0)
      const nextJob = /\n {2}[a-z0-9-]+:\n/g
      nextJob.lastIndex = jobStart + 1
      const jobEnd = nextJob.exec(wf)?.index ?? wf.length
      const at = wf.indexOf(pack, jobStart)
      expect(at > jobStart && at < jobEnd, `${job}: ${pack}`).toBe(true)
      // A helper build sits in this job, before its packaging step.
      expect(builds.some((b) => b > jobStart && b < at), job).toBe(true)
      // And the packaged copy is checked in this job, after the native module check.
      const native = wf.indexOf('run: npm run verify:package', at)
      const verify = wf.indexOf('run: npm run verify:helper', at)
      expect(native > at && native < jobEnd, `${job}: verify:package`).toBe(true)
      expect(verify > native && verify < jobEnd, `${job}: verify:helper`).toBe(true)
    }
    for (const b of builds) expect(wf.slice(b, b + 400)).toContain('cargo build --release --locked')
    expect(pkg.scripts['verify:helper']).toBe('node scripts/verify-bundled-helper.mjs')
  })

  it('a release/* test installer from ci.yml carries the helper too: built before it is packaged and checked after, under the same condition', () => {
    type Step = { name?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown>; 'working-directory'?: string }
    const ci = yaml.load(readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf-8')) as { jobs: Record<string, { if?: string; needs?: unknown; steps: Step[] }> }
    // Windows (from 2.1.3-beta.17): a job of its own, for a release/* source
    // branch only, that needs the Linux job building the static Linux helper.
    const win = ci.jobs['release-windows-installer']
    expect(win.if).toContain("startsWith(github.head_ref, 'release/')")
    expect(win.needs).toEqual(['release-helper-linux', 'release-helper-linux-arm64'])
    expect(ci.jobs['release-helper-linux'].if).toBe(win.if)
    expect(ci.jobs['release-helper-linux-arm64'].if).toBe(win.if)
    const ws = win.steps
    const wat = (pred: (s: Step) => boolean, what: string) => {
      const i = ws.findIndex(pred)
      expect(i, what).toBeGreaterThan(-1)
      return i
    }
    const wbuild = wat((s) => /cargo build --release --locked/.test(s.run ?? ''), 'the helper build')
    expect(ws[wbuild]['working-directory']).toBe('helper')
    const download = wat((s) => /^actions\/download-artifact@/.test(s.uses ?? ''), 'the Linux helper download')
    expect(ws[download].with).toEqual({ name: 'helper-linux-musl-installer', path: 'helper/target/helper-linux-musl' })
    const armDownload = wat((s) => s.name === 'Download the static arm64 Linux helper', 'the arm64 Linux helper download')
    expect(ws[armDownload].with).toEqual({ name: 'helper-linux-musl-arm64-installer', path: 'helper/target/helper-linux-musl-arm64' })
    const manifest = wat((s) => s.run?.trim() === 'node scripts/write-helper-manifest.mjs', 'the manifest')
    const wpack = wat((s) => s.run?.trim() === 'npx electron-builder --win --config.npmRebuild=false', 'the packaging')
    const wverify = wat((s) => s.run?.trim() === 'npm run verify:helper', 'the packaged check')
    expect(wbuild).toBeLessThan(wpack)
    expect(download).toBeLessThan(manifest)
    expect(armDownload).toBeLessThan(manifest)
    expect(manifest).toBeLessThan(wpack)
    expect(wverify).toBeGreaterThan(wpack)
    // The job's own condition is the only one: every step of it runs.
    for (const s of ws) expect(s.if, s.name).toBeUndefined()
    for (const [job, pack] of [
      ['test', 'npx electron-builder --mac'],
    ] as const) {
      const steps = ci.jobs[job].steps
      const at = steps.findIndex((s) => s.run?.trim() === pack)
      expect(at, `${job}: ${pack}`).toBeGreaterThan(0)
      const cond = steps[at].if
      expect(cond, job).toContain("startsWith(github.head_ref, 'release/')")
      const build = steps.findIndex((s) => /cargo build --release --locked/.test(s.run ?? ''))
      expect(build, `${job}: the helper build`).toBeGreaterThan(-1)
      expect(build, `${job}: built before it is packaged`).toBeLessThan(at)
      expect(steps[build]['working-directory'], job).toBe('helper')
      expect(steps[build].if, job).toBe(cond)
      const verify = steps.findIndex((s) => s.run?.trim() === 'npm run verify:helper')
      expect(verify, `${job}: checked after it is packaged`).toBeGreaterThan(at)
      expect(steps[verify].if, job).toBe(cond)
    }
  })

  it('every packaging script checks the helper it packaged, the Store package included', () => {
    // Any script that runs electron-builder packages the helper, so a new one is held to this too.
    const packaging = Object.keys(pkg.scripts).filter((name) => /\belectron-builder\b/.test(pkg.scripts[name]))
    expect(packaging.sort()).toEqual(['package', 'package:linux', 'package:mac', 'package:store', 'package:win'])
    for (const name of packaging) {
      expect(pkg.scripts[name], name).toMatch(/&& npm run verify:helper$/)
      // A Windows package writes the Linux helper's manifest before electron-builder runs.
      const writes = pkg.scripts[name].indexOf('node scripts/write-helper-manifest.mjs && ')
      if (/electron-builder --win\b/.test(pkg.scripts[name])) {
        expect(writes, name).toBeGreaterThan(-1)
        expect(writes, name).toBeLessThan(pkg.scripts[name].indexOf('electron-builder --win'))
      } else expect(writes, name).toBe(-1)
    }
  })
})
