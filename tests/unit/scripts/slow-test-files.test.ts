import { describe, it, expect } from 'vitest'
import { repoPath, slowestFiles, formatSlowest, main, DEFAULT_COUNT } from '../../../scripts/ci/slow-test-files.mjs'

/**
 * scripts/ci/slow-test-files.mjs: the slowest files of a vitest JSON report,
 * for the summary of each Windows CI part. It never fails the job.
 */

const ROOT = 'D:\\a\\repo\\repo'
const file = (rel: string, ms: number, tests = 2, status = 'passed', start = 1_000) => ({
  name: `D:/a/repo/repo/${rel}`, startTime: start, endTime: start + ms, status, assertionResults: Array.from({ length: tests }, () => ({})),
})

describe('slow-test-files: the slowest test files of one vitest run', () => {
  it('names files as the repository does, whatever the slashes or the drive letter case', () => {
    expect(repoPath('D:/a/repo/repo/tests/unit/x.test.ts', ROOT)).toBe('tests/unit/x.test.ts')
    expect(repoPath('d:\\a\\repo\\repo\\tests\\unit\\x.test.ts', ROOT)).toBe('tests/unit/x.test.ts')
    expect(repoPath('/home/runner/work/r/r/tests/a.test.ts', '/home/runner/work/r/r/')).toBe('tests/a.test.ts')
    // Outside the root, or a root that only shares a prefix: left as it is.
    expect(repoPath('D:/other/tests/x.test.ts', ROOT)).toBe('D:/other/tests/x.test.ts')
    expect(repoPath('D:/a/repo/repo2/x.test.ts', ROOT)).toBe('D:/a/repo/repo2/x.test.ts')
  })

  it('lists the slowest first, at most the count asked, with the totals of the whole report', () => {
    const report = { testResults: [file('tests/a.test.ts', 500), file('tests/b.test.ts', 41_000, 11), file('tests/c.test.ts', 2_000, 3, 'failed'), file('tests/d.test.ts', 2_000)] }
    const s = slowestFiles(report, 3, ROOT)
    expect(s.total).toBe(4)
    expect(s.sumMs).toBe(45_500)
    // Equal times are ordered by name, so the list is the same on every run.
    expect(s.files).toEqual([
      { file: 'tests/b.test.ts', ms: 41_000, tests: 11, status: 'passed' },
      { file: 'tests/c.test.ts', ms: 2_000, tests: 3, status: 'failed' },
      { file: 'tests/d.test.ts', ms: 2_000, tests: 2, status: 'passed' },
    ])
    const text = formatSlowest(s, 'part 2 of 4')
    expect(text).toMatch(/^### Slowest test files, part 2 of 4\n/)
    expect(text).toContain('4 files, 45.5 s of test time in all')
    expect(text).toContain('| 41.0 | 11 | `tests/b.test.ts` |')
    expect(text).toContain('| 2.0 | 3 | `tests/c.test.ts` (failed) |')
    expect(text).not.toContain('tests/a.test.ts')
  })

  it('skips entries it cannot read, and uses the default count for a count that is not a positive whole number', () => {
    const report = { testResults: [null, { name: 7 }, { name: 'x', startTime: 5, endTime: 1 }, { name: 'y', startTime: 'a', endTime: 9 }, file('tests/ok.test.ts', 10)] }
    expect(slowestFiles(report, 5, ROOT).files.map((f) => f.file)).toEqual(['tests/ok.test.ts'])
    const many = { testResults: Array.from({ length: 30 }, (_, i) => file(`tests/f${i}.test.ts`, i)) }
    for (const count of [Number.NaN, 0, -1, 2.5]) expect(slowestFiles(many, count, ROOT).files, String(count)).toHaveLength(DEFAULT_COUNT)
    for (const report of [null, {}, { testResults: 'x' }]) expect(slowestFiles(report, 5, ROOT)).toEqual({ files: [], total: 0, sumMs: 0 })
    expect(formatSlowest(slowestFiles({}, 5, ROOT), '')).toBe('### Slowest test files\n\nNo file times were read from the report.\n')
  })

  it('main writes the summary and exits 0, also when the report is missing or broken', () => {
    const run = (argv: string[], read: (f: string) => string) => {
      const writes: string[] = []
      const code = main(argv, { GITHUB_STEP_SUMMARY: 'sum' }, { log: () => {}, read, write: (_f: string, t: string) => { writes.push(t) }, root: ROOT })
      return { code, text: writes.join('') }
    }
    const good = run(['r.json', '1', 'part', '1', 'of', '4'], () => JSON.stringify({ testResults: [file('tests/a.test.ts', 3_000), file('tests/b.test.ts', 9_000)] }))
    expect(good.code).toBe(0)
    expect(good.text).toMatch(/^### Slowest test files, part 1 of 4\n/)
    expect(good.text).toContain('`tests/b.test.ts`')
    expect(good.text).not.toContain('`tests/a.test.ts`')
    const missing = run(['r.json', '15'], () => { throw new Error('ENOENT: no such file') })
    expect(missing).toEqual({ code: 0, text: '### Slowest test files\n\nNo report was read (ENOENT: no such file).\n' })
    expect(run(['r.json'], () => '{broken').code).toBe(0)
    expect(run([], () => '{}').text).toContain('No report was read (no report file was named)')
  })
})
