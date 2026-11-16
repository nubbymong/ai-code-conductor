import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { BaseSequencer } from 'vitest/node'
import { HEAVY_TEST_FILES, pathsOfPart, shardRange } from '../../../scripts/ci/shard-by-weight.mjs'
import config, { WeightedShardSequencer } from '../../../vitest.config'

/**
 * scripts/ci/shard-by-weight.mjs and the sequencer vitest.config.ts gives it:
 * which files each Windows CI part (`vitest run --shard=i/4`) runs. The one
 * property that matters most is that no file is lost: every file is in
 * exactly one part, for any number of parts.
 */

const ROOT = resolve(__dirname, '../../..')
const SLASH_ROOT = ROOT.replace(/\\/g, '/')

/** The files the suite collects (vitest.config.ts `include`, less `.native.`), read from disk. */
function suiteFiles(): string[] {
  const out: string[] = []
  for (const [dir, re] of [['tests/unit', /\.test\.tsx?$/], ['tests/wp1', /\.test\.tsx?$/], ['tests/integration', /\.test\.ts$/]] as const) {
    if (!existsSync(resolve(ROOT, dir))) continue
    for (const f of readdirSync(resolve(ROOT, dir), { recursive: true }) as string[]) {
      const p = `${dir}/${f.replace(/\\/g, '/')}`
      if (re.test(p) && !/\.native\.test\./.test(p)) out.push(p)
    }
  }
  return out.sort()
}

const loadOf = (paths: string[]) => paths.reduce((n, p) => n + (HEAVY_TEST_FILES.get(p) ?? 0), 0)

describe('shard-by-weight: each part of a split run, and no file lost', () => {
  const files = suiteFiles()

  it('names only files the suite runs', () => {
    expect(files.length).toBeGreaterThan(1000)
    for (const [p, s] of HEAVY_TEST_FILES) {
      expect(files, p).toContain(p)
      expect(Number.isFinite(s) && s > 0, p).toBe(true)
    }
  })

  it('every file of the suite is in exactly one part, for any number of parts', () => {
    for (let count = 1; count <= 8; count++) {
      const parts = Array.from({ length: count }, (_, i) => pathsOfPart(files, i + 1, count))
      const all = parts.flat()
      expect(all.length, `${count} parts`).toBe(files.length)
      expect(new Set(all).size, `${count} parts`).toBe(files.length)
      expect([...all].sort(), `${count} parts`).toEqual(files)
      // The light files are split evenly: part sizes, less the heavy files, differ by one at most.
      const light = parts.map((p) => p.filter((f) => !HEAVY_TEST_FILES.has(f)).length)
      expect(Math.max(...light) - Math.min(...light), `${count} parts`).toBeLessThanOrEqual(1)
    }
  })

  it('in four parts, the heavy files are spread: no part carries much more than its share', () => {
    const loads = [1, 2, 3, 4].map((i) => loadOf(pathsOfPart(files, i, 4)))
    const total = loadOf(files)
    expect(loads.reduce((a, b) => a + b, 0)).toBe(total)
    // Greedy placement, heaviest first, is within 4/3 of the best placement,
    // which is at least the larger of a quarter of the total and the heaviest file.
    const best = Math.max(total / 4, Math.max(...HEAVY_TEST_FILES.values()))
    for (const l of loads) expect(l, loads.join(', ')).toBeLessThanOrEqual((4 / 3) * best)
    expect(Math.min(...loads), loads.join(', ')).toBeGreaterThan(0)
  })

  it('the order the files come in changes nothing', () => {
    const shuffled = [...files].reverse()
    for (const i of [1, 2, 3, 4]) expect([...pathsOfPart(shuffled, i, 4)].sort()).toEqual([...pathsOfPart(files, i, 4)].sort())
  })

  it('without heavy files, it is vitest\'s own split, file for file', async () => {
    const paths = files.filter((p) => !HEAVY_TEST_FILES.has(p))
    const specs = paths.map((p) => ({ moduleId: `${SLASH_ROOT}/${p}` }))
    for (const count of [1, 3, 4, 5]) {
      for (let index = 1; index <= count; index++) {
        const base = new BaseSequencer({ config: { root: SLASH_ROOT, shard: { index, count } } } as never)
        const theirs = (await base.shard(specs as never)).map((s: { moduleId: string }) => s.moduleId.slice(SLASH_ROOT.length + 1))
        expect(pathsOfPart(paths, index, count), `${index} of ${count}`).toEqual(theirs)
      }
    }
    // And the range matches vitest's for every size.
    for (let total = 0; total <= 30; total++) {
      for (let count = 1; count <= 7; count++) {
        for (let index = 1; index <= count; index++) {
          expect(shardRange(total, index, count)).toEqual(new BaseSequencer({ config: {} } as never).calculateShardRange(total, index, count))
        }
      }
    }
  })

  it('refuses a part that does not exist and a list it cannot read, so a broken call fails the run', () => {
    for (const [index, count] of [[0, 4], [5, 4], [1, 0], [1.5, 4], [1, 2.5], [Number.NaN, 4]]) expect(() => pathsOfPart(files, index, count), `${index} of ${count}`).toThrow()
    expect(() => pathsOfPart(['a.test.ts', 'a.test.ts'], 1, 2)).toThrow(/listed twice/)
    expect(() => pathsOfPart(['a.test.ts', ''], 1, 2)).toThrow(/not a path/)
    expect(() => pathsOfPart('a.test.ts' as never, 1, 2)).toThrow(/not a list/)
    expect(pathsOfPart([], 2, 4)).toEqual([])
  })
})

describe('vitest.config.ts: a split run uses this split, and the order stays vitest\'s', () => {
  it('the config names the sequencer, which leaves the order inside a part to vitest', () => {
    expect(config.test?.sequence?.sequencer).toBe(WeightedShardSequencer)
    expect(Object.getPrototypeOf(WeightedShardSequencer)).toBe(BaseSequencer)
    expect(Object.prototype.hasOwnProperty.call(WeightedShardSequencer.prototype, 'sort')).toBe(false)
  })

  it('maps vitest\'s files to repository paths, and gives back the same file objects', async () => {
    const files = suiteFiles()
    const specs = files.map((p) => ({ moduleId: `${SLASH_ROOT}/${p}`, project: 'unit' }))
    const seen: string[] = []
    for (const index of [1, 2, 3, 4]) {
      const seq = new WeightedShardSequencer({ config: { root: ROOT, shard: { index, count: 4 } } } as never)
      const got = (await seq.shard(specs as never)) as unknown as typeof specs
      for (const s of got) expect(specs).toContain(s)
      const paths = got.map((s) => s.moduleId.slice(SLASH_ROOT.length + 1))
      expect([...paths].sort()).toEqual([...pathsOfPart(files, index, 4)].sort())
      seen.push(...paths)
    }
    expect(seen.sort()).toEqual(files)
    // Not split at all: everything, untouched.
    const whole = new WeightedShardSequencer({ config: { root: ROOT } } as never)
    expect(await whole.shard(specs as never)).toBe(specs)
  })
})
