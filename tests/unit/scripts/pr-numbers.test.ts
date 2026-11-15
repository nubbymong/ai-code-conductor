import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
// js-yaml comes in with electron-builder and is pinned in package.json's
// overrides; nothing is installed for this test.
import yaml from 'js-yaml'
import { evalIf } from '../../helpers/gha-expr'
// Plain ESM with main() behind an argv[1] check: importing it runs nothing.
import { RADIUS_FILES, PTY_MANAGER, PTY_MANAGER_LINE_CAP, OVERRIDE_LABEL, countLines, buildReport, renderSummary, main } from '../../../scripts/ci/pr-numbers.mjs'

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')

const CAP = PTY_MANAGER_LINE_CAP
const report = (over: Partial<Parameters<typeof buildReport>[0]> = {}) =>
  buildReport({ paths: ['src/renderer/App.tsx'], ptyLines: CAP, baseLines: CAP, labels: [], ...over })

describe('pr-numbers: the radius list is the one in AGENTS.md', () => {
  /** The backtick paths of the "Touching any of the blast radius" sentence. */
  function agentsRadius(): string[] {
    const para = read('AGENTS.md')
      .split('\n')
      .find((l) => l.startsWith('- **SSH statusline changes need the live SSH matrix before merge**'))
    if (!para) throw new Error('the SSH live-matrix paragraph is gone from AGENTS.md')
    const from = para.indexOf('Touching any of the blast radius')
    const to = para.indexOf('? Run ', from)
    if (from < 0 || to < 0) throw new Error('the blast-radius sentence changed shape in AGENTS.md')
    return [...para.slice(from, to).matchAll(/`([^`]+)`/g)].map((m) => m[1])
  }

  it('is the same eight files, in no particular order', () => {
    const doc = agentsRadius()
    expect(doc.length).toBe(8)
    expect([...RADIUS_FILES].sort()).toEqual([...doc].sort())
  })

  it('every file in it exists, and pty-manager is the one with a cap', () => {
    for (const f of RADIUS_FILES) expect(() => readFileSync(resolve(ROOT, f)), f).not.toThrow()
    expect(PTY_MANAGER).toBe('src/main/pty-manager.ts')
    expect(RADIUS_FILES).toContain(PTY_MANAGER)
    expect(new Set(RADIUS_FILES).size).toBe(RADIUS_FILES.length)
  })
})

describe('pr-numbers: the cap and ADR-030', () => {
  it('the cap is 8,366, the length #681 left, and ADR-030 says so with one sentence about #681', () => {
    expect(CAP).toBe(8366)
    const adr = read('architecture/decisions/2026-11-15-adr-030-one-session-helper-on-every-machine.md')
    const shown = CAP.toLocaleString('en-US')
    expect(shown).toBe('8,366')
    expect(adr).toContain(`\`src/main/pty-manager.ts\` (${shown} lines)`)
    expect(adr).toContain(`Capped at ${shown}`)
    expect(adr).not.toMatch(/Capped at 8,128/)
    expect(adr).not.toContain('(8,128 lines)')
    // The old number survives only inside the sentence that explains the change.
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
  it('a renderer-only PR: radius not touched, matrix not owed, no failure', () => {
    const r = report({ paths: ['src/renderer/components/Foo.tsx', 'tests/unit/foo.test.ts'] })
    expect(r.touchesRadius).toBe(false)
    expect(r.hits).toEqual([])
    expect(r.matrixOwed).toBe(false)
    expect(r.failed).toBe(false)
    const text = renderSummary(r)
    expect(text).toContain('| Touches the SSH blast radius | no (0 of 8) |')
    expect(text).toContain('| Live SSH matrix | not owed |')
    expect(text).toContain('**live SSH matrix: not owed**')
    expect(text).not.toContain('live SSH matrix: owed')
    expect(text).toContain(`| \`src/main/pty-manager.ts\` length | ${CAP} lines, cap ${CAP}, +0 against the base (${CAP}) |`)
    expect(text).toContain('| Cap | at the cap |')
  })

  it('a PR that adds one line to ssh-tmux.ts: radius touched (1 of 8), matrix owed, still no failure', () => {
    const r = report({ paths: ['src/main/ssh-tmux.ts', 'tests/unit/ssh-tmux.test.ts'] })
    expect(r.touchesRadius).toBe(true)
    expect(r.hits).toEqual(['src/main/ssh-tmux.ts'])
    expect(r.matrixOwed).toBe(true)
    expect(r.failed).toBe(false)
    const text = renderSummary(r)
    expect(text).toContain('| Touches the SSH blast radius | yes, 1 of 8: `src/main/ssh-tmux.ts` |')
    expect(text).toContain('| Live SSH matrix | owed |')
    expect(text).toContain('**live SSH matrix: owed**')
    expect(text).toContain('npm run test:live:ssh')
  })

  it('each of the eight files, on its own, makes the matrix owed; a look-alike path does not', () => {
    for (const f of RADIUS_FILES) {
      const r = report({ paths: [f] })
      expect(r.matrixOwed, f).toBe(true)
      expect(r.hits, f).toEqual([f])
    }
    for (const p of ['src/main/ssh-tmux.ts.orig', 'src/main/ssh-tmux-other.ts', 'src/renderer/ssh-tmux.ts', 'src/main/providers/other/ui-detection.ts', 'docs/src/main/ansi-strip.ts', 'src/main/ansi-strip.test.ts']) {
      expect(report({ paths: [p] }).matrixOwed, p).toBe(false)
    }
  })

  it('lists several hits in the order the radius lists them', () => {
    const r = report({ paths: ['src/main/statusline-watcher.ts', 'src/main/ssh-tmux.ts', 'README.md'] })
    expect(r.hits).toEqual(['src/main/ssh-tmux.ts', 'src/main/statusline-watcher.ts'])
    expect(renderSummary(r)).toContain('yes, 2 of 8: `src/main/ssh-tmux.ts`, `src/main/statusline-watcher.ts`')
  })
})

describe('pr-numbers: the cap on pty-manager.ts', () => {
  it('fails when a PR makes pty-manager.ts longer than the cap, and names the number', () => {
    const r = report({ paths: [PTY_MANAGER], ptyLines: CAP + 1 })
    expect(r.exceeds).toBe(true)
    expect(r.failed).toBe(true)
    expect(r.overBy).toBe(1)
    expect(r.matrixOwed).toBe(true)
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

  it('fails closed on what it cannot read: paths unknown means touched and owed; an unreadable file fails', () => {
    const unknownPaths = report({ paths: null })
    expect(unknownPaths.matrixOwed).toBe(true)
    expect(unknownPaths.failed).toBe(false)
    expect(renderSummary(unknownPaths)).toContain('could not read the changed paths: treated as yes')
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

  it('a renderer-only PR: exit 0, summary says radius not touched and matrix not owed', () => {
    const r = run({ paths: ['src/renderer/App.tsx'], lines: CAP })
    expect(r.code).toBe(0)
    expect(r.writes.length).toBe(1)
    expect(r.writes[0][0]).toBe('summary.md')
    expect(r.writes[0][1]).toContain('| Touches the SSH blast radius | no (0 of 8) |')
    expect(r.writes[0][1]).toContain('**live SSH matrix: not owed**')
  })

  it('a PR that adds a line to src/main/ssh-tmux.ts: exit 0, summary says touched and owed', () => {
    const r = run({ paths: ['src/main/ssh-tmux.ts'], lines: CAP })
    expect(r.code).toBe(0)
    expect(r.writes[0][1]).toContain('yes, 1 of 8: `src/main/ssh-tmux.ts`')
    expect(r.writes[0][1]).toContain('**live SSH matrix: owed**')
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

  it('fails closed when git cannot answer: matrix owed; a file over the cap with no base to compare fails', () => {
    const ok = run({ paths: [], lines: CAP, gitFails: true })
    expect(ok.code).toBe(0)
    expect(ok.writes[0][1]).toContain('could not read the changed paths: treated as yes')
    expect(ok.writes[0][1]).toContain('**live SSH matrix: owed**')
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
    expect(ci.jobs.test.strategy?.matrix.os).toEqual(['windows-2025', 'macos-latest', 'ubuntu-latest'])
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
