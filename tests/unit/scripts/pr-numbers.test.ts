import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
import { evalIf } from '../../helpers/gha-expr'
// Plain ESM with main() behind an argv[1] check: importing it runs nothing.
import * as prNumbers from '../../../scripts/ci/pr-numbers.mjs'
import { PTY_MANAGER, PTY_MANAGER_LINE_CAP, OVERRIDE_LABEL, countLines, buildReport, renderSummary, main } from '../../../scripts/ci/pr-numbers.mjs'

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')

const CAP = PTY_MANAGER_LINE_CAP
const report = (over: Partial<Parameters<typeof buildReport>[0]> = {}) =>
  buildReport({ paths: ['src/renderer/App.tsx'], ptyLines: CAP, baseLines: CAP, labels: [], ...over })

// The live SSH matrix is retired (owner, 2026-11-22). AGENTS.md says so in one
// line, and the job no longer reports a blast radius or a matrix owed.
// Not checked: the other docs that once named the matrix (the adversarial
// review skill, CONTRIBUTING.md), and the tests/live files, which stay.
describe('pr-numbers: the live SSH matrix is retired', () => {
  it('AGENTS.md carries the retirement line and no longer the gate', () => {
    const agents = read('AGENTS.md')
    expect(agents).toContain('The live SSH matrix (tests/live/ssh-statusline-*) is retired (owner, 2026-11-22).')
    expect(agents).not.toContain('SSH statusline changes need the live SSH matrix before merge')
    expect(agents).not.toContain('npm run test:live:ssh')
  })

  it('the job reports no blast radius and no matrix, and pty-manager.ts is the one file with a cap', () => {
    expect('RADIUS_FILES' in prNumbers).toBe(false)
    expect(PTY_MANAGER).toBe('src/main/pty-manager.ts')
    expect(() => readFileSync(resolve(ROOT, PTY_MANAGER))).not.toThrow()
    for (const paths of [['src/main/ssh-tmux.ts'], [PTY_MANAGER, 'src/main/ansi-strip.ts'], null]) {
      const text = renderSummary(report({ paths }))
      expect(text, String(paths)).not.toMatch(/blast radius|SSH matrix|test:live/i)
    }
  })
})

describe('pr-numbers: the cap has one source of truth', () => {
  const adr = read('architecture/decisions/2026-11-15-adr-030-one-session-helper-on-every-machine.md')

  it('PTY_MANAGER_LINE_CAP is a positive whole number, and ADR-030 points at it instead of repeating it', () => {
    expect(Number.isInteger(CAP) && CAP > 0).toBe(true)
    expect(adr).toContain('`PTY_MANAGER_LINE_CAP` in `scripts/ci/pr-numbers.mjs` is the one source of the number')
    // The ADR states the starting value once, dated, and nothing else in it carries a cap number.
    expect(adr.match(/\d,\d{3} on 2026-11-15/g)?.length).toBe(1)
    expect(adr).not.toMatch(/Capped at \d/)
  })

  it('ADR-030 keeps the old 8,128 only inside the sentence about #681', () => {
    expect(adr).not.toContain('(8,128 lines)')
    expect(adr.match(/8,128/g)?.length).toBe(1)
    expect(adr).toMatch(/#681 raised it from 8,128 before the check existed/)
  })
})

describe('pr-numbers: countLines counts as wc -l does, plus an unterminated last line', () => {
  it('counts', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a\n')).toBe(1)
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\r\nb\r\n')).toBe(2)
    expect(countLines('\n\n')).toBe(2)
    expect(countLines(null as never)).toBe(0)
  })
})

describe('pr-numbers: the table over fixed path lists', () => {
  it('a renderer-only PR: the length and the cap, no failure', () => {
    const r = report({ paths: ['src/renderer/components/Foo.tsx', 'tests/unit/foo.test.ts'] })
    expect(r.ptyTouched).toBe(false)
    expect(r.failed).toBe(false)
    const text = renderSummary(r)
    expect(text).toContain(`| \`src/main/pty-manager.ts\` length | ${CAP} lines, cap ${CAP}, +0 against the base (${CAP}) |`)
    expect(text).toContain('| Cap | at the cap |')
    expect(text).not.toContain('Could not read the changed paths')
  })

  it('a PR that touches an SSH file but not pty-manager.ts: no failure, and the same two rows', () => {
    const r = report({ paths: ['src/main/ssh-tmux.ts', 'tests/unit/ssh-tmux.test.ts'] })
    expect(r.ptyTouched).toBe(false)
    expect(r.failed).toBe(false)
    expect(renderSummary(r).split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Check') && !l.startsWith('| ---'))).toHaveLength(2)
  })
})

describe('pr-numbers: the cap on pty-manager.ts', () => {
  it('fails when a PR makes pty-manager.ts longer than the cap, and names the number', () => {
    const r = report({ paths: [PTY_MANAGER], ptyLines: CAP + 1 })
    expect(r.exceeds).toBe(true)
    expect(r.failed).toBe(true)
    expect(r.overBy).toBe(1)
    expect(r.ptyTouched).toBe(true)
    const text = renderSummary(r)
    expect(text).toContain('FAIL: over the cap by 1')
    expect(text).toContain(OVERRIDE_LABEL)
    expect(text).toContain(`| \`src/main/pty-manager.ts\` length | ${CAP + 1} lines, cap ${CAP}, +1 against the base (${CAP}) |`)
  })

  it('passes at the cap, and one line under it', () => {
    expect(report({ paths: [PTY_MANAGER], ptyLines: CAP, baseLines: CAP }).failed).toBe(false)
    expect(report({ paths: [PTY_MANAGER], ptyLines: CAP - 1, baseLines: CAP }).failed).toBe(false)
  })

  it('a shorter file says to lower the cap with it, so the cap only goes down', () => {
    const r = report({ paths: [PTY_MANAGER], ptyLines: CAP - 40, baseLines: CAP })
    expect(r.failed).toBe(false)
    expect(r.lowerTheCap).toBe(true)
    expect(renderSummary(r)).toContain(`lower \`PTY_MANAGER_LINE_CAP\` in \`scripts/ci/pr-numbers.mjs\` to ${CAP - 40}`)
    expect(report({ paths: ['README.md'], ptyLines: CAP - 40, baseLines: CAP - 40 }).lowerTheCap).toBe(false)
  })

  it('a PR that grows the file but stays under the cap is not told to lower the cap', () => {
    const grows = report({ paths: [PTY_MANAGER], ptyLines: CAP - 16, baseLines: CAP - 66 })
    expect(grows.failed).toBe(false)
    expect(grows.lowerTheCap).toBe(false)
    expect(renderSummary(grows)).not.toContain('lower `PTY_MANAGER_LINE_CAP`')
    // Same length as the base: nothing was shortened either.
    expect(report({ paths: [PTY_MANAGER], ptyLines: CAP - 40, baseLines: CAP - 40 }).lowerTheCap).toBe(false)
    // Base unknown: no basis to say the PR shortened it.
    expect(report({ paths: [PTY_MANAGER], ptyLines: CAP - 40, baseLines: null }).lowerTheCap).toBe(false)
  })

  it(`the ${OVERRIDE_LABEL} label lets it pass, and the summary says so`, () => {
    const r = report({ paths: [PTY_MANAGER], ptyLines: CAP + 12, labels: ['ci-run', OVERRIDE_LABEL] })
    expect(r.exceeds).toBe(true)
    expect(r.override).toBe(true)
    expect(r.failed).toBe(false)
    const text = renderSummary(r)
    expect(text).toContain(`over the cap by 12 (${OVERRIDE_LABEL} label: passing)`)
    expect(text).toContain(`The \`${OVERRIDE_LABEL}\` label is on this PR, so growing \`src/main/pty-manager.ts\` past ${CAP} lines does not fail the job.`)
    // A look-alike label does not count.
    expect(report({ paths: [PTY_MANAGER], ptyLines: CAP + 12, labels: ['cap-overrides', 'override'] }).failed).toBe(true)
  })

  it('the label on a PR that does not need it is said to be unneeded', () => {
    const text = renderSummary(report({ labels: [OVERRIDE_LABEL] }))
    expect(text).toContain(`The \`${OVERRIDE_LABEL}\` label is on this PR; it is not needed here.`)
  })

  it('the label is never called unneeded when the file could not be read, because then it is what passes the job', () => {
    const r = report({ ptyLines: null, baseLines: null, labels: [OVERRIDE_LABEL] })
    expect(r.failed).toBe(false)
    const text = renderSummary(r)
    expect(text).toContain(`could not read the file (${OVERRIDE_LABEL} label: passing)`)
    expect(text).not.toContain('it is not needed here')
  })

  it('a file already over the cap is not blamed on a PR that leaves it alone or shortens it', () => {
    expect(report({ paths: ['README.md'], ptyLines: CAP + 40, baseLines: CAP + 40 }).failed).toBe(false)
    const shorter = report({ paths: [PTY_MANAGER], ptyLines: CAP + 10, baseLines: CAP + 40 })
    expect(shorter.failed).toBe(false)
    expect(renderSummary(shorter)).toContain('over the cap by 10, but this PR does not make it longer')
    // Touched and made longer while over: that is the failure.
    expect(report({ paths: [PTY_MANAGER], ptyLines: CAP + 41, baseLines: CAP + 40 }).failed).toBe(true)
  })

  it('a deleted file is under any cap', () => {
    expect(report({ paths: [PTY_MANAGER], ptyLines: 0, baseLines: CAP }).failed).toBe(false)
  })

  it('fails closed on what it cannot read: paths unknown means touched; an unreadable file fails', () => {
    const unknownPaths = report({ paths: null })
    expect(unknownPaths.ptyTouched).toBe(true)
    expect(unknownPaths.failed).toBe(false)
    expect(renderSummary(unknownPaths)).toContain('Could not read the changed paths, so `src/main/pty-manager.ts` counts as touched.')
    // Paths unknown and over the cap with no base to compare: it fails.
    expect(report({ paths: null, ptyLines: CAP + 1, baseLines: null }).failed).toBe(true)
    // Paths unknown, over the cap, but not longer than a known base: it passes.
    expect(report({ paths: null, ptyLines: CAP + 1, baseLines: CAP + 1 }).failed).toBe(false)
    const unreadable = report({ ptyLines: null, baseLines: null })
    expect(unreadable.failed).toBe(true)
    expect(renderSummary(unreadable)).toContain('FAIL: could not read src/main/pty-manager.ts')
    expect(report({ ptyLines: null, baseLines: null, labels: [OVERRIDE_LABEL] }).failed).toBe(false)
  })
})

describe('pr-numbers: main() in a job', () => {
  const BASE = 'b'.repeat(40)
  const HEAD = 'c'.repeat(40)
  const MERGE = 'd'.repeat(40)
  const ptyText = (n: number) => 'x\n'.repeat(n)

  function run(opts: { paths: string[]; lines: number; baseLines?: number; labels?: string[]; env?: Record<string, string>; parents?: string; gitFails?: boolean; readFails?: string | boolean }) {
    const writes: Array<[string, string]> = []
    const logs: string[] = []
    const calls: string[][] = []
    const runGit = (args: string[]) => {
      calls.push(args)
      if (opts.gitFails) throw new Error('git is gone')
      if (args[0] === 'rev-list') return opts.parents ?? `${MERGE} ${BASE} ${HEAD}\n`
      if (args[0] === 'diff') return opts.paths.map((p) => `${p}\0`).join('')
      if (args[0] === 'show') {
        expect(args[1]).toBe(`${BASE}:src/main/pty-manager.ts`)
        return ptyText(opts.baseLines ?? opts.lines)
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    }
    const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: 'event.json', GITHUB_STEP_SUMMARY: 'summary.md', ...(opts.env ?? {}) }
    const code = main(env, {
      runGit,
      readFile: (p: string) => {
        expect(p).toBe('src/main/pty-manager.ts')
        if (opts.readFails) {
          const e = new Error('cannot read') as Error & { code?: string }
          if (typeof opts.readFails === 'string') e.code = opts.readFails
          throw e
        }
        return ptyText(opts.lines)
      },
      readEvent: () => ({ pull_request: { labels: (opts.labels ?? []).map((name) => ({ name })) } }),
      write: (f: string, t: string) => writes.push([f, t]),
      log: (s: string) => logs.push(s),
    })
    return { code, writes, logs, calls }
  }

  it('a renderer-only PR: exit 0, and the summary gives the length and the cap', () => {
    const r = run({ paths: ['src/renderer/App.tsx'], lines: CAP })
    expect(r.code).toBe(0)
    expect(r.writes.length).toBe(1)
    expect(r.writes[0][0]).toBe('summary.md')
    expect(r.writes[0][1]).toContain(`| \`src/main/pty-manager.ts\` length | ${CAP} lines, cap ${CAP}, +0 against the base (${CAP}) |`)
    expect(r.writes[0][1]).toContain('| Cap | at the cap |')
  })

  it('a PR that adds a line to src/main/ssh-tmux.ts: exit 0, and no matrix is asked for', () => {
    const r = run({ paths: ['src/main/ssh-tmux.ts'], lines: CAP })
    expect(r.code).toBe(0)
    expect(r.writes[0][1]).not.toMatch(/SSH matrix|test:live/i)
  })

  it('a PR that grows pty-manager.ts: exit 1, an error line names the cap, and the table still prints', () => {
    const r = run({ paths: [PTY_MANAGER], lines: CAP + 3, baseLines: CAP })
    expect(r.code).toBe(1)
    expect(r.logs.join('\n')).toContain('::error title=pty-manager.ts is over its cap::')
    expect(r.logs.join('\n')).toContain(`the cap is ${CAP}`)
    expect(r.writes[0][1]).toContain('FAIL: over the cap by 3')
  })

  it('the same PR with the cap-override label: exit 0, and the summary says why', () => {
    const r = run({ paths: [PTY_MANAGER], lines: CAP + 3, baseLines: CAP, labels: [OVERRIDE_LABEL] })
    expect(r.code).toBe(0)
    expect(r.writes[0][1]).toContain(`${OVERRIDE_LABEL} label: passing`)
  })

  it('reads the base length from the merge commit first parent, only through git show', () => {
    const r = run({ paths: [PTY_MANAGER], lines: CAP - 5, baseLines: CAP })
    expect(r.code).toBe(0)
    expect(r.calls.map((c) => c[0]).sort()).toEqual(['diff', 'rev-list', 'rev-list', 'show'])
    expect(r.writes[0][1]).toContain(`-5 against the base (${CAP})`)
  })

  it('does nothing outside a pull request', () => {
    const r = run({ paths: [], lines: CAP + 99, env: { GITHUB_EVENT_NAME: 'push' } })
    expect(r.code).toBe(0)
    expect(r.writes).toEqual([])
    expect(r.calls).toEqual([])
  })

  it('fails closed when git cannot answer: pty-manager.ts counts as touched; a file over the cap with no base to compare fails', () => {
    const ok = run({ paths: [], lines: CAP, gitFails: true })
    expect(ok.code).toBe(0)
    expect(ok.writes[0][1]).toContain('Could not read the changed paths, so `src/main/pty-manager.ts` counts as touched.')
    const over = run({ paths: [], lines: CAP + 1, gitFails: true })
    expect(over.code).toBe(1)
    // Not a merge commit: no base either.
    const notMerge = run({ paths: [PTY_MANAGER], lines: CAP + 1, parents: `${HEAD} ${BASE}\n` })
    expect(notMerge.code).toBe(1)
  })

  it('an unreadable pty-manager.ts fails; a deleted one does not', () => {
    expect(run({ paths: [PTY_MANAGER], lines: 0, readFails: true }).code).toBe(1)
    const gone = run({ paths: [PTY_MANAGER], lines: 0, readFails: 'ENOENT', baseLines: CAP })
    expect(gone.code).toBe(0)
    expect(gone.writes[0][1]).toContain('| Cap | ')
    // Absent but not in the changed paths (the job started in the wrong folder): unreadable, so it fails.
    expect(run({ paths: ['README.md'], lines: 0, readFails: 'ENOENT', baseLines: CAP }).code).toBe(1)
    // Absent and the changed paths could not be read either: fails closed.
    expect(run({ paths: [], lines: 0, readFails: 'ENOENT', gitFails: true }).code).toBe(1)
  })

  it('a PR that shortens pty-manager.ts passes, and says to lower the cap in the summary and in a warning annotation', () => {
    const r = run({ paths: [PTY_MANAGER], lines: CAP - 7, baseLines: CAP })
    expect(r.code).toBe(0)
    expect(r.writes[0][1]).toContain(`to ${CAP - 7} so it only goes down`)
    expect(r.logs.join('\n')).toContain(`::warning title=lower the pty-manager.ts cap::`)
    // No warning when nothing needs lowering.
    expect(run({ paths: ['README.md'], lines: CAP }).logs.join('\n')).not.toContain('::warning')
  })

  it('writes no summary file when the runner gives none, and still prints the table', () => {
    const r = run({ paths: ['README.md'], lines: CAP, env: { GITHUB_STEP_SUMMARY: '' } })
    expect(r.writes).toEqual([])
    expect(r.logs.join('\n')).toContain('### PR numbers')
  })

  it('a missing or broken event file means no labels, not a crash', () => {
    const writes: string[] = []
    const code = main(
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: 'nope.json' },
      { runGit: (a: string[]) => (a[0] === 'rev-list' ? `${MERGE} ${BASE} ${HEAD}` : a[0] === 'diff' ? '' : 'x\n'), readFile: () => 'x\n', readEvent: () => { throw new Error('ENOENT') }, write: (_f: string, t: string) => writes.push(t), log: () => {} },
    )
    expect(code).toBe(0)
  })
})

describe('ci.yml: the PR numbers job always runs on a pull request and decides inside', () => {
  const ci = yaml.load(read('.github/workflows/ci.yml')) as { jobs: Record<string, { name?: string; if?: unknown; needs?: unknown; steps: Array<Record<string, unknown>>; permissions?: Record<string, string>; strategy?: { matrix: { os: string[] } }; 'continue-on-error'?: unknown }> }
  const job = ci.jobs['pr-numbers']
  const REQUIRED_CHECKS = ['Test (windows-2025)', 'Test (macos-latest)']

  it('is named PR numbers, is no required check, and leaves the Test jobs alone', () => {
    expect(job, 'ci.yml has no pr-numbers job').toBeDefined()
    expect(job.name).toBe('PR numbers')
    expect(REQUIRED_CHECKS).not.toContain(job.name)
    expect(ci.jobs.test.name).toBe('Test (${{ matrix.os }})')
    expect(ci.jobs.test.strategy?.matrix.os).toEqual(['macos-latest', 'ubuntu-latest'])
    expect(ci.jobs['test-windows'].name).toBe('Test (${{ matrix.os }})')
    expect(ci.jobs['test-windows'].strategy?.matrix.os).toEqual(['windows-2025'])
    expect(job.permissions).toEqual({ contents: 'read' })
  })

  it('its only condition is the event: it starts on every pull_request action, whatever the labels or paths', () => {
    const on = (event: string, action?: string, labels: string[] = []) => evalIf(job.if, { github: { event_name: event, event: { action, pull_request: { labels: labels.map((name) => ({ name })) } } } })
    for (const action of ['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled', 'edited']) {
      expect(on('pull_request', action), action).toBe(true)
      expect(on('pull_request', action, ['ci-run', 'cap-override']), action + ' with labels').toBe(true)
    }
    expect(on('push')).toBe(false)
    expect(on('workflow_dispatch')).toBe(false)
    expect(String(job.if)).not.toMatch(/paths|labels|scope|needs\./)
    expect(job.needs).toBeUndefined()
    expect(job['continue-on-error']).toBeUndefined()
  })

  it('checks out with the base and runs the script, and no step has a condition of its own', () => {
    const [checkout, run, ...rest] = job.steps
    expect(rest).toEqual([])
    expect(String(checkout.uses)).toMatch(/^actions\/checkout@[0-9a-f]{40}$/)
    expect(checkout.with).toEqual({ 'fetch-depth': 2, 'persist-credentials': false })
    expect(run.run).toBe('node scripts/ci/pr-numbers.mjs')
    for (const step of job.steps) {
      expect(step.if, String(step.name ?? step.uses)).toBeUndefined()
      expect(step['continue-on-error']).toBeUndefined()
    }
  })
})
