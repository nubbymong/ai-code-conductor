import { describe, it, expect } from 'vitest'
// Plain ESM with main() behind an argv[1] check: importing it runs nothing.
import { DOCS_ONLY, ALWAYS_FULL_OS, isDocsPath, isDocsOnly, changedPaths, decideScope, main } from '../../../scripts/ci/change-scope.mjs'

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

describe('change-scope: what counts as documentation only', () => {
  it('Markdown anywhere and the documentation trees are documentation; nothing else is', () => {
    expect(DOCS_ONLY.map(String)).toEqual(['/\\.md$/', '/^docs\\//', '/^CONTEXT\\.d\\//', '/^architecture\\//'])
    for (const p of ['README.md', 'AGENTS.md', 'docs/x.md', 'docs/wp1/evidence/run.json', 'docs/img/shot.png', 'CONTEXT.d/2026-11-14-x.md', 'architecture/decisions/a.md', 'architecture/diagram.svg', '.claude/skills/adversarial-review/SKILL.md', 'src/main/notes.md']) {
      expect(isDocsPath(p), p).toBe(true)
    }
    for (const p of ['src/main/index.ts', 'package.json', 'package-lock.json', '.github/workflows/ci.yml', 'scripts/ci/change-scope.mjs', 'tests/unit/x.test.ts', 'README.md.js', 'README.MD', 'mydocs/x.ts', 'src/docs/x.ts', 'xdocs/a.ts', 'CONTEXT.dx/a.ts', 'CONTEXT.d', 'docs', 'architecturex/a.ts', 'src/renderer/changelog.ts', '.claude/skills/adversarial-review/adv-marker.sh', '']) {
      expect(isDocsPath(p), p).toBe(false)
    }
    for (const p of [null, undefined, 7, {}]) expect(isDocsPath(p as never)).toBe(false)
  })

  it('a change is documentation only when every path is, and there is at least one', () => {
    expect(isDocsOnly(['README.md', 'docs/a.png'])).toBe(true)
    expect(isDocsOnly(['README.md', 'src/x.ts'])).toBe(false)
    expect(isDocsOnly(['src/x.ts', 'README.md'])).toBe(false)
    expect(isDocsOnly([])).toBe(false)
    expect(isDocsOnly(null as never)).toBe(false)
  })
})

describe('change-scope: the paths a pull request changes', () => {
  it('are the difference between the merge commit and its first parent, the base', () => {
    const g = git(['README.md', 'docs/a b.md', 'src/x.ts'])
    expect(changedPaths(g.run)).toEqual(['README.md', 'docs/a b.md', 'src/x.ts'])
    expect(g.calls).toEqual([['rev-list', '--parents', '-n', '1', 'HEAD'], ['diff', '--name-only', '--no-renames', '-z', BASE, MERGE]])
    expect(changedPaths(git([]).run)).toEqual([])
  })

  it('cannot be read from a commit that is not a two-parent merge, or when git fails', () => {
    expect(changedPaths(git(['README.md'], `${MERGE} ${BASE}\n`).run)).toBe(null)
    expect(changedPaths(git(['README.md'], `${MERGE}\n`).run)).toBe(null)
    expect(changedPaths(git(['README.md'], `${MERGE} ${BASE} ${HEAD} ${'e'.repeat(40)}\n`).run)).toBe(null)
    expect(changedPaths(() => { throw new Error('shallow') })).toBe(null)
    expect(changedPaths((args: string[]) => { if (args[0] === 'diff') throw new Error('bad object'); return `${MERGE} ${BASE} ${HEAD}` })).toBe(null)
  })
})

describe('change-scope: the decision', () => {
  const docs = ['README.md', 'docs/x.md']
  it('skips the suite only for a documentation-only pull request, off Linux', () => {
    expect(ALWAYS_FULL_OS).toBe('Linux')
    expect(decideScope({ eventName: 'pull_request', runnerOs: 'Windows', paths: docs })).toEqual({ suite: false, reason: 'documentation only (2 path(s)): the suite runs on Linux alone' })
    expect(decideScope({ eventName: 'pull_request', runnerOs: 'macOS', paths: docs }).suite).toBe(false)
    // Linux keeps the whole suite: tests read the Markdown they guard.
    expect(decideScope({ eventName: 'pull_request', runnerOs: 'Linux', paths: docs })).toEqual({ suite: true, reason: 'Linux always runs the suite' })
  })

  it('runs the suite for any code path, any other event, and anything it cannot read', () => {
    expect(decideScope({ eventName: 'pull_request', runnerOs: 'Windows', paths: [...docs, 'src/x.ts', 'package.json'] })).toEqual({ suite: true, reason: '2 changed path(s) outside the documentation, first: src/x.ts' })
    expect(decideScope({ eventName: 'pull_request', runnerOs: 'Windows', paths: [] })).toEqual({ suite: true, reason: 'no changed path was listed' })
    expect(decideScope({ eventName: 'pull_request', runnerOs: 'Windows', paths: null })).toEqual({ suite: true, reason: 'the changed paths could not be read' })
    for (const eventName of ['push', 'workflow_dispatch', 'pull_request_target', '', 'PULL_REQUEST']) {
      expect(decideScope({ eventName, runnerOs: 'Windows', paths: docs }).suite, eventName).toBe(true)
    }
    expect(decideScope({ eventName: 'push', runnerOs: 'Windows', paths: docs }).reason).toBe('a push run always runs the suite')
    for (const runnerOs of ['', 'linux', 'Windows']) expect(decideScope({ eventName: 'pull_request', runnerOs, paths: ['src/x.ts'] }).suite, runnerOs).toBe(true)
  })
})

describe('change-scope: the step', () => {
  const run = (env: Record<string, string>, runGit: (args: string[]) => string) => {
    const files: Record<string, string> = {}
    const code = main(env, { log: () => {}, write: (f: string, t: string) => { files[f] = (files[f] ?? '') + t }, runGit })
    return { code, out: files.out }
  }
  const env = (os: string, event = 'pull_request') => ({ GITHUB_EVENT_NAME: event, RUNNER_OS: os, GITHUB_OUTPUT: 'out' })

  it('writes suite=false for a docs-only PR on Windows and macOS, and suite=true everywhere else', () => {
    expect(run(env('Windows'), git(['README.md']).run)).toEqual({ code: 0, out: 'suite=false\n' })
    expect(run(env('macOS'), git(['docs/a.md', 'CONTEXT.d/x.md']).run)).toEqual({ code: 0, out: 'suite=false\n' })
    expect(run(env('Windows'), git(['README.md', 'src/x.ts']).run)).toEqual({ code: 0, out: 'suite=true\n' })
    expect(run(env('Windows'), git([]).run)).toEqual({ code: 0, out: 'suite=true\n' })
    expect(run(env('Windows'), git(['README.md'], `${MERGE} ${BASE}\n`).run)).toEqual({ code: 0, out: 'suite=true\n' })
    expect(run(env('Windows'), () => { throw new Error('git missing') })).toEqual({ code: 0, out: 'suite=true\n' })
  })

  it('does not ask git where the answer cannot change: on Linux and on a push', () => {
    const seen: string[][] = []
    const spy = (args: string[]): string => { seen.push(args); throw new Error('git was asked') }
    expect(run(env('Linux'), spy)).toEqual({ code: 0, out: 'suite=true\n' })
    expect(run(env('Windows', 'push'), spy)).toEqual({ code: 0, out: 'suite=true\n' })
    expect(seen).toEqual([])
  })

  it('a write that fails fails the step: the job goes red instead of skipping the suite unseen', () => {
    expect(() => main(env('Windows'), { log: () => {}, write: () => { throw new Error('disk full') }, runGit: git(['README.md']).run })).toThrow(/disk full/)
    // With no output file there is nothing to write.
    expect(main({ GITHUB_EVENT_NAME: 'pull_request', RUNNER_OS: 'Windows' }, { log: () => {}, write: () => { throw new Error('not called') }, runGit: git(['README.md']).run })).toBe(0)
  })
})
