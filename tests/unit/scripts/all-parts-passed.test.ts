import { describe, it, expect } from 'vitest'
import { decideParts, formatParts, main } from '../../../scripts/ci/all-parts-passed.mjs'

/**
 * scripts/ci/all-parts-passed.mjs: what `Test (windows-2025)` decides from the
 * jobs it needs. ci-cadence.test.ts runs it the way the workflow does; this
 * file covers the decision itself, every way it can go red included.
 */

const EXPECT = ['test-windows-part', 'test-windows-build']
const need = (result: unknown, suite: unknown = 'true') => ({ result, outputs: { suite } })
const green = (suite = 'true') => ({ 'test-windows-part': need('success', suite), 'test-windows-build': need('success', suite) })

describe('all-parts-passed: the required check passes only when every part did', () => {
  it('passes when every expected job succeeded, and says the suite ran', () => {
    expect(decideParts(green(), EXPECT)).toEqual({ ok: true, suite: true, problems: [], rows: [{ id: 'test-windows-part', result: 'success', suite: 'true' }, { id: 'test-windows-build', result: 'success', suite: 'true' }] })
  })

  it('a documentation-only change, every part skipping the suite, passes with suite=false', () => {
    expect(decideParts(green('false'), EXPECT)).toMatchObject({ ok: true, suite: false })
  })

  it('only the literal false skips: an output never written, or anything else, means the suite ran', () => {
    for (const suite of [undefined, '', 'true', 'False', 'no', 0]) {
      const d = decideParts({ 'test-windows-part': need('success', suite), 'test-windows-build': need('success', suite) }, EXPECT)
      expect(d, String(suite)).toMatchObject({ ok: true, suite: true })
    }
    expect(decideParts({ 'test-windows-part': { result: 'success' }, 'test-windows-build': { result: 'success', outputs: null } }, EXPECT)).toMatchObject({ ok: true, suite: true })
  })

  it('fails on any result but success, for each job', () => {
    for (const result of ['failure', 'cancelled', 'skipped', '', null, undefined, 'SUCCESS', 'neutral']) {
      for (const id of EXPECT) {
        const needs = { ...green(), [id]: need(result) }
        const d = decideParts(needs, EXPECT)
        expect(d.ok, `${id} ${String(result)}`).toBe(false)
        expect(d.suite).toBeNull()
        expect(d.problems).toEqual([`${id} is ${typeof result === 'string' && result !== '' ? result : 'unknown'}, not success`])
      }
    }
  })

  it('fails when a job is missing, an unexpected one is needed, or the parts disagree on the scope', () => {
    expect(decideParts({ 'test-windows-part': need('success') }, EXPECT).problems).toEqual(['test-windows-build is not among the jobs this one needs'])
    expect(decideParts({ ...green(), extra: need('success') }, EXPECT).problems).toEqual(['extra is needed but not in EXPECT'])
    expect(decideParts({ 'test-windows-part': need('success', 'false'), 'test-windows-build': need('success') }, EXPECT).problems).toEqual(['the parts disagree on the scope: some skipped the suite as documentation only, some ran it'])
    expect(decideParts({ 'test-windows-part': 'success', 'test-windows-build': need('success') }, EXPECT).problems).toEqual(['test-windows-part could not be read'])
    expect(decideParts({ 'test-windows-part': null, 'test-windows-build': need('success') }, EXPECT).problems).toEqual(['test-windows-part could not be read'])
  })

  it('fails when the needs or the expected list cannot be read', () => {
    for (const needs of [null, undefined, 'x', 7, [], [need('success')]]) expect(decideParts(needs, EXPECT), JSON.stringify(needs)).toMatchObject({ ok: false, problems: ['the needs context could not be read'] })
    for (const expected of [[], null, undefined, [''], [7]]) expect(decideParts(green(), expected as string[]), JSON.stringify(expected)).toMatchObject({ ok: false, problems: ['no job is named in EXPECT'] })
  })

  it('main: exit 1 and no output on red; exit 0 and the scope written on green; a write that fails is red', () => {
    const run = (env: Record<string, string>, failWrite = false) => {
      const writes: Array<[string, string]> = []
      const logs: string[] = []
      const code = main(env, { log: (s: string) => logs.push(s), write: (f: string, t: string) => { if (failWrite && f === 'out') throw new Error('disk full'); writes.push([f, t]) } })
      return { code, writes, logs }
    }
    const env = (needs: unknown) => ({ NEEDS: JSON.stringify(needs), EXPECT: EXPECT.join(' '), GITHUB_OUTPUT: 'out', GITHUB_STEP_SUMMARY: 'sum' })
    const ok = run(env(green()))
    expect(ok.code).toBe(0)
    expect(ok.writes.filter(([f]) => f === 'out')).toEqual([['out', 'suite=true\n']])
    expect(ok.writes.find(([f]) => f === 'sum')![1]).toMatch(/^### Every Windows part passed/)
    const docs = run(env(green('false')))
    expect(docs.writes.filter(([f]) => f === 'out')).toEqual([['out', 'suite=false\n']])
    const red = run(env({ ...green(), 'test-windows-part': need('failure') }))
    expect(red.code).toBe(1)
    expect(red.writes.filter(([f]) => f === 'out')).toEqual([])
    expect(red.logs).toContain('::error::test-windows-part is failure, not success')
    expect(red.writes.find(([f]) => f === 'sum')![1]).toMatch(/^### Not every Windows part passed/)
    // Unreadable JSON, and the expected list spaced any way.
    expect(run({ NEEDS: '{not json', EXPECT: EXPECT.join(' '), GITHUB_OUTPUT: 'out' }).code).toBe(1)
    expect(run({ NEEDS: JSON.stringify(green()), EXPECT: `  ${EXPECT.join('\n  ')}  `, GITHUB_OUTPUT: 'out' }).code).toBe(0)
    expect(run({ NEEDS: JSON.stringify(green()), GITHUB_OUTPUT: 'out' }).code).toBe(1)
    // The output is the decision the tree step reads: one that cannot be written is no pass.
    expect(run(env(green()), true).code).toBe(1)
  })

  it('the summary names each job and why the check failed', () => {
    const text = formatParts(decideParts({ ...green(), 'test-windows-build': need('cancelled') }, EXPECT))
    expect(text).toContain('| test-windows-part | success | ran |')
    expect(text).toContain('| test-windows-build | cancelled | ran |')
    expect(text).toContain('- test-windows-build is cancelled, not success')
    expect(formatParts(decideParts(green('false'), EXPECT))).toContain('| test-windows-part | success | skipped (documentation only) |')
    expect(formatParts(decideParts(null, EXPECT))).toContain('| (none read) | | |')
  })
})
