import { describe, it, expect } from 'vitest'
// Plain ESM with main() behind an argv[1] check: importing it runs nothing.
import { HELPER_PATHS, touchesHelper, decideHelper, main } from '../../../scripts/ci/helper-scope.mjs'

const BASE = 'b'.repeat(40)
const HEAD = 'c'.repeat(40)
const MERGE = 'd'.repeat(40)

/** A fake git for a PR merge commit whose diff against the base is `paths`. */
function git(paths: string[], parents = `${MERGE} ${BASE} ${HEAD}\n`) {
  const calls: string[][] = []
  const run = (args: string[]) => {
    calls.push(args)
    if (args[0] === 'rev-list') return parents
    if (args[0] === 'diff') return paths.map((p) => `${p}\0`).join('')
    throw new Error(`unexpected git ${args.join(' ')}`)
  }
  return { run, calls }
}

describe('helper-scope: what makes the Helper job build', () => {
  it('anything under helper/, the workflow that runs the job and this script; nothing else', () => {
    expect(HELPER_PATHS.map(String)).toEqual(['/^helper\\//', '/^\\.github\\/workflows\\/ci\\.yml$/', '/^scripts\\/ci\\/helper-scope\\.mjs$/'])
    for (const p of [
      'helper/Cargo.toml',
      'helper/Cargo.lock',
      'helper/src/frame.rs',
      'helper/fixtures/frames.json',
      'helper/probes/p7-windows-survival.ps1',
      'helper/rust-toolchain.toml',
      '.github/workflows/ci.yml',
      'scripts/ci/helper-scope.mjs',
    ]) {
      expect(touchesHelper(p), p).toBe(true)
    }
    for (const p of [
      'src/main/index.ts',
      'package.json',
      'docs/remote/helper-protocol.md',
      'tests/unit/scripts/helper-fixtures.test.ts',
      '.github/workflows/release.yml',
      'scripts/ci/change-scope.mjs',
      'helper',
      'xhelper/a.rs',
      'src/helper/a.rs',
      'resources/helper/a.rs',
      'helpers/a.rs',
      '',
    ]) {
      expect(touchesHelper(p), p).toBe(false)
    }
    for (const p of [null, undefined, 7, {}]) expect(touchesHelper(p as never)).toBe(false)
  })
})

describe('helper-scope: the decision', () => {
  it('builds when a helper path changed, and skips when none did', () => {
    expect(decideHelper({ eventName: 'pull_request', paths: ['src/a.ts', 'helper/src/ring.rs'] })).toMatchObject({ helper: true })
    expect(decideHelper({ eventName: 'pull_request', paths: ['.github/workflows/ci.yml'] }).helper).toBe(true)
    expect(decideHelper({ eventName: 'pull_request', paths: ['src/a.ts', 'README.md'] })).toEqual({ helper: false, reason: 'no helper path changed (2 path(s) checked)' })
  })

  it('names the first path and how many matched', () => {
    const d = decideHelper({ eventName: 'pull_request', paths: ['a.ts', 'helper/x.rs', 'helper/y.rs'] })
    expect(d.reason).toBe('2 changed path(s) in the helper or its job, first: helper/x.rs')
  })

  it('fails closed: whatever it cannot read for certain builds the helper', () => {
    expect(decideHelper({ eventName: 'push', paths: ['README.md'] }).helper).toBe(true)
    expect(decideHelper({ eventName: 'workflow_dispatch', paths: null }).helper).toBe(true)
    expect(decideHelper({ eventName: '', paths: null }).helper).toBe(true)
    expect(decideHelper({ eventName: 'pull_request', paths: null }).helper).toBe(true)
    expect(decideHelper({ eventName: 'pull_request', paths: [] }).helper).toBe(true)
  })
})

describe('helper-scope: main() writes the output the workflow reads', () => {
  const run = (env: Record<string, string>, g = git([])) => {
    const writes: Array<[string, string]> = []
    const logs: string[] = []
    const code = main(env, { runGit: g.run, write: (f: string, t: string) => writes.push([f, t]), log: (s: string) => logs.push(s) })
    return { code, writes, logs, g }
  }

  it('writes helper=false for a PR that leaves the helper alone, helper=true for one that touches it', () => {
    const off = run({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_OUTPUT: 'out.txt' }, git(['src/a.ts', 'docs/x.md']))
    expect(off.code).toBe(0)
    expect(off.writes).toEqual([['out.txt', 'helper=false\n']])
    expect(off.logs).toEqual(['helper=false: no helper path changed (2 path(s) checked)'])
    const on = run({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_OUTPUT: 'out.txt' }, git(['helper/Cargo.toml']))
    expect(on.writes).toEqual([['out.txt', 'helper=true\n']])
  })

  it('does not ask git outside a pull request, and answers true', () => {
    const r = run({ GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: 'out.txt' })
    expect(r.g.calls).toEqual([])
    expect(r.writes).toEqual([['out.txt', 'helper=true\n']])
  })

  it('answers true when git cannot say (not a merge commit, or git fails)', () => {
    const notMerge = run({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_OUTPUT: 'o' }, git(['README.md'], `${HEAD} ${BASE}\n`))
    expect(notMerge.writes).toEqual([['o', 'helper=true\n']])
    const broken = { run: () => { throw new Error('git is gone') }, calls: [] as string[][] }
    const r = run({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_OUTPUT: 'o' }, broken)
    expect(r.writes).toEqual([['o', 'helper=true\n']])
  })

  it('writes nothing when there is no output file, and still logs', () => {
    const r = run({ GITHUB_EVENT_NAME: 'pull_request' }, git(['README.md']))
    expect(r.writes).toEqual([])
    expect(r.logs.length).toBe(1)
  })
})
