import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * The Rust session helper (helper/) is dormant: the installer must not carry
 * it. package.json's `build.files` is a whitelist and `extraResources` /
 * `extraFiles` copy named files, so a helper/ that sits at the top level is
 * not packaged. This fails the moment any of those lists would take it, or the
 * folder moves under resources/ (which `resources/**\/*` ships whole).
 */

const ROOT = resolve(__dirname, '../../..')
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')) as { build: Record<string, unknown> }

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

type Entry = { list: 'files' | 'extraResources' | 'extraFiles'; value: string }

/**
 * Every path or glob a `files`, `extraResources` or `extraFiles` list names,
 * anywhere under `build` (the platform sections too). An entry is a string, or
 * a { from, to } object whose `from` is what gets copied.
 */
function packagingEntries(node: unknown, out: Entry[] = []): Entry[] {
  if (Array.isArray(node)) node.forEach((n) => packagingEntries(n, out))
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'files' || k === 'extraResources' || k === 'extraFiles') {
        for (const item of ([] as unknown[]).concat(v)) {
          if (typeof item === 'string') out.push({ list: k, value: item })
          else if (item && typeof item === 'object' && typeof (item as { from?: unknown }).from === 'string') out.push({ list: k, value: (item as { from: string }).from })
        }
      } else packagingEntries(v, out)
    }
  }
  return out
}

/** A path the helper folder holds, or will hold. */
const HELPER_FILES = [
  'helper/Cargo.toml',
  'helper/Cargo.lock',
  'helper/rust-toolchain.toml',
  'helper/src/main.rs',
  'helper/src/pty/windows.rs',
  'helper/fixtures/frames.json',
  'helper/probes/p7-windows-survival.ps1',
  'helper/target/release/aicc-helper',
  'helper/target/release/aicc-helper.exe',
]

describe('the dormant Rust helper is not in the installer', () => {
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

  it('no `files` entry of the installer matches a path in helper/', () => {
    const globs = entries.filter((e) => e.list === 'files').map((e) => e.value)
    expect(globs.length).toBeGreaterThan(0)
    for (const glob of globs.filter((g) => !g.startsWith('!'))) {
      const re = globToRegExp(glob)
      for (const file of HELPER_FILES) expect(re.test(file), `"${glob}" would package ${file}`).toBe(false)
    }
  })

  it('no extraResources or extraFiles entry names helper/', () => {
    const copied = entries.filter((e) => e.list !== 'files').map((e) => e.value)
    expect(copied.length).toBeGreaterThan(0)
    for (const value of copied) {
      const norm = value.replace(/\\/g, '/').replace(/^\.\//, '')
      expect(norm.startsWith('helper'), `${value} reaches into helper/`).toBe(false)
      for (const file of HELPER_FILES) expect(globToRegExp(norm).test(file), `${value} would copy ${file}`).toBe(false)
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
  })

  it('helper/ is a top-level folder, not under resources/ or src/ (resources/ ships whole)', () => {
    expect(existsSync(resolve(ROOT, 'helper/Cargo.toml'))).toBe(true)
    for (const bad of ['resources/helper', 'src/helper', 'src/main/helper', 'build/helper']) expect(existsSync(resolve(ROOT, bad)), bad).toBe(false)
  })
})
