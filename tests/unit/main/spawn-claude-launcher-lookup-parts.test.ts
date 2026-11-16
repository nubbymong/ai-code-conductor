import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { itemsOfPart } from '../../helpers/items-of-part'

/**
 * The launcher lookup checks in real shells are spread over four files, one
 * part each (spawn-claude-launcher-lookup-powershell-harness.ts), so the
 * Windows CI parts can run them side by side. The harness picks each route's
 * part by its index, so a route added there needs no file to name it. That
 * holds only while the files call parts 1 to n of one n, once each, one file
 * per part, with at least n routes: a file deleted or renamed, two files on
 * one part, or a file saying (1, 3) would drop routes from CI with the run
 * still green. This file checks it host-safe: it reads those files as text
 * and imports none of them (they start real processes, so they carry the
 * quarantine header and run in CI only).
 */

const DIR = __dirname
const PART_FILE = /^spawn-claude-launcher-lookup-powershell(-\d+)?\.test\.ts$/
const HARNESS = 'spawn-claude-launcher-lookup-powershell-harness.ts'

/** What is wrong with the split, from each part file's text and the harness's (none: []). */
function splitProblems(files: Array<[string, string]>, harness: string): string[] {
  const problems: string[] = []
  const calls: Array<{ file: string; part: number; parts: number }> = []
  for (const [file, text] of files) {
    const literal = [...text.matchAll(/\bdescribeLauncherLookup\(\s*(\d+)\s*,\s*(\d+)\s*\)/g)]
    const any = text.match(/\bdescribeLauncherLookup\(/g)?.length ?? 0
    if (any !== literal.length) problems.push(`${file}: a describeLauncherLookup call whose part is not written as two numbers`)
    if (literal.length !== 1) problems.push(`${file}: ${literal.length} describeLauncherLookup calls, not 1`)
    for (const m of literal) calls.push({ file, part: Number(m[1]), parts: Number(m[2]) })
  }
  const counts = [...new Set(calls.map((c) => c.parts))]
  if (counts.length !== 1) {
    problems.push(`the files do not agree on the number of parts: ${counts.join(', ') || 'none'}`)
    return problems
  }
  const n = counts[0]
  if (n !== files.length) problems.push(`${n} parts, but ${files.length} part files`)
  const parts = calls.map((c) => c.part).sort((a, b) => a - b)
  const want = Array.from({ length: n }, (_, i) => i + 1)
  if (parts.join(',') !== want.join(',')) problems.push(`the parts called are ${parts.join(', ')}, not ${want.join(', ')}`)
  // Each part needs a route of its own, or a file checks nothing of the lookup.
  const block = harness.match(/\nconst ROUTES\b[^\n]*\n([\s\S]*?)\n\]\n/)
  const routes = block ? block[1].split('\n').filter((l) => /^\s*\['/.test(l)).length : 0
  if (routes < n) problems.push(`${routes} routes in the harness, fewer than the ${n} parts`)
  return problems
}

const readParts = (): Array<[string, string]> =>
  readdirSync(DIR).filter((f) => PART_FILE.test(f)).sort().map((f) => [f, readFileSync(join(DIR, f), 'utf-8')])
const harnessText = () => readFileSync(join(DIR, HARNESS), 'utf-8').replace(/\r\n/g, '\n')

describe('the launcher lookup checks: four files, parts 1 to 4 of 4, every route in CI', () => {
  it('the four files call parts 1 to 4 of 4, once each, and the harness has a route for each', () => {
    const files = readParts()
    expect(files.map(([f]) => f)).toEqual([
      'spawn-claude-launcher-lookup-powershell-2.test.ts',
      'spawn-claude-launcher-lookup-powershell-3.test.ts',
      'spawn-claude-launcher-lookup-powershell-4.test.ts',
      'spawn-claude-launcher-lookup-powershell.test.ts',
    ])
    expect(splitProblems(files, harnessText())).toEqual([])
    // The harness splits by the helper tested below.
    expect(harnessText()).toMatch(/return itemsOfPart\(ROUTES, part, parts\)/)
  })

  it('the check fails on each way a route can drop out', () => {
    const files = readParts()
    const harness = harnessText()
    const without = (name: string) => files.filter(([f]) => f !== name)
    const edit = (name: string, from: string, to: string): Array<[string, string]> => files.map(([f, t]) => [f, f === name ? t.replace(from, to) : t])
    // A file deleted (or renamed out of the pattern): three files, parts 1, 2 and 4 of 4.
    expect(splitProblems(without('spawn-claude-launcher-lookup-powershell-3.test.ts'), harness)).toEqual(['4 parts, but 3 part files', 'the parts called are 1, 2, 4, not 1, 2, 3, 4'])
    // Two files on one part.
    expect(splitProblems(edit('spawn-claude-launcher-lookup-powershell-4.test.ts', 'describeLauncherLookup(4, 4)', 'describeLauncherLookup(3, 4)'), harness)).toEqual(['the parts called are 1, 2, 3, 3, not 1, 2, 3, 4'])
    // A file with the wrong count.
    expect(splitProblems(edit('spawn-claude-launcher-lookup-powershell-2.test.ts', 'describeLauncherLookup(2, 4)', 'describeLauncherLookup(2, 3)'), harness)).toEqual(['the files do not agree on the number of parts: 3, 4'])
    // A file that calls no part, or calls it in a way this cannot read.
    expect(splitProblems(edit('spawn-claude-launcher-lookup-powershell-2.test.ts', 'describeLauncherLookup(2, 4)', ''), harness)).toEqual(['spawn-claude-launcher-lookup-powershell-2.test.ts: 0 describeLauncherLookup calls, not 1', 'the parts called are 1, 3, 4, not 1, 2, 3, 4'])
    expect(splitProblems(edit('spawn-claude-launcher-lookup-powershell-2.test.ts', 'describeLauncherLookup(2, 4)', 'describeLauncherLookup(PART, 4)'), harness)[0]).toBe('spawn-claude-launcher-lookup-powershell-2.test.ts: a describeLauncherLookup call whose part is not written as two numbers')
    // Fewer routes than parts.
    const oneRoute = harness.replace(/(\nconst ROUTES\b[^\n]*\n\s*\['[^\n]*\n)(?:\s*\['[^\n]*\n)+/, '$1')
    expect(splitProblems(files, oneRoute)).toEqual(['1 routes in the harness, fewer than the 4 parts'])
  })
})

describe('itemsOfPart: every item in exactly one part', () => {
  it('splits by index, round again from part 1, for any number of items and parts', () => {
    expect(itemsOfPart(['a', 'b', 'c', 'd', 'e'], 1, 4)).toEqual(['a', 'e'])
    expect(itemsOfPart(['a', 'b', 'c', 'd', 'e'], 4, 4)).toEqual(['d'])
    for (let parts = 1; parts <= 6; parts++) {
      for (let size = 0; size <= 9; size++) {
        const items = Array.from({ length: size }, (_, i) => i)
        const all = Array.from({ length: parts }, (_, i) => itemsOfPart(items, i + 1, parts)).flat()
        expect(all.sort((a, b) => a - b), `${size} items in ${parts} parts`).toEqual(items)
      }
    }
  })

  it('throws on a part that does not exist', () => {
    for (const [part, parts] of [[0, 4], [5, 4], [1, 0], [1.5, 4], [1, 2.5], [Number.NaN, 4]]) expect(() => itemsOfPart([1, 2], part, parts), `${part} of ${parts}`).toThrow(/no part/)
  })
})
