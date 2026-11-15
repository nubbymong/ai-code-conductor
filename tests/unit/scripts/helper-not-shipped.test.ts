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
    const listed = entries.filter((e) => e.list === 'files')
    expect(listed.length).toBeGreaterThan(0)
    for (const entry of listed) {
      for (const file of HELPER_FILES) expect(takes(entry, file), `${JSON.stringify(entry)} would package ${file}`).toBe(false)
    }
  })

  it('no extraResources or extraFiles entry names helper/', () => {
    const copied = entries.filter((e) => e.list !== 'files')
    expect(copied.length).toBeGreaterThan(0)
    for (const entry of copied) {
      expect(normPath(entry.value).startsWith('helper'), `${entry.value} reaches into helper/`).toBe(false)
      for (const file of HELPER_FILES) expect(takes(entry, file), `${JSON.stringify(entry)} would copy ${file}`).toBe(false)
    }
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
