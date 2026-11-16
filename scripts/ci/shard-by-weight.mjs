// Which test files one part of a split run gets (`vitest run --shard=i/n`).
//
// vitest's own split sorts the files by a hash of their path and cuts the
// list into n runs of equal length. That is fair to files of equal weight,
// and the Windows suite has a few that are not: each Windows PowerShell 5.1
// start costs 18 to 30 s on the CI runner, and the files below start dozens.
// They are about half of the suite's time, and the hash put five of them in
// one part and none in another (12 minutes against 3; PR #694).
//
// So the files named below go first, heaviest first, each to the part with
// the least weight so far. Every other file is split as vitest splits it:
// sorted by the sha1 of '/<path>', cut into n runs of equal length. A file
// renamed or added is never lost: it is then a light file, still in exactly
// one part. Each Windows CI part lists its slowest files in its summary, so a
// weight that drifts shows there.
//
// Inside a part the heavy files also start first, heaviest first
// (heavyFirst): vitest, with no cache of earlier runs, starts the largest
// files first, and the split launcher files are a few lines each, so they
// started last and set the end of their part (316 s into part 2 of run
// 43788398848, then 314 s more).
//
// Used only by vitest.config.ts's sequencer, and only for a split run
// (--shard): the Windows CI parts. The release workflow runs the suite whole,
// in vitest's own order.
import { createHash } from 'node:crypto'

/** Seconds per file on the windows-2025 runner, rounded: as measured in run
 *  43793925573 of PR #694 (each part's "Slowest test files" summary), a run
 *  with the launcher file split and the slow files started first.
 *  Every other file took under 31 s. Heaviest first; paths are as
 *  `git ls-files` prints them. */
export const HEAVY_TEST_FILES = new Map([
  ['tests/unit/main/spawn-claude-launcher-lookup-powershell.test.ts', 418],
  ['tests/unit/main/spawn-claude-picker-node-powershell.test.ts', 360],
  ['tests/unit/main/spawn-claude-agents-powershell.test.ts', 274],
  ['tests/unit/main/spawn-claude-launcher-lookup-powershell-2.test.ts', 273],
  ['tests/unit/main/spawn-claude-launcher-lookup-powershell-3.test.ts', 269],
  ['tests/unit/main/spawn-claude-launcher-lookup-powershell-4.test.ts', 268],
  ['tests/unit/main/owner-only-folders-real.test.ts', 89],
  ['tests/unit/main/spawn-claude-user-args-powershell.test.ts', 78],
  ['tests/wp1/fake-cli.test.ts', 55],
])

/** vitest's equal split: the [start, end) of part `index` (1-based) of `total`
 *  items in `count` parts, the first `total % count` parts one longer. */
export function shardRange(total, index, count) {
  const base = Math.floor(total / count)
  const extra = total % count
  if (extra >= index) return [(base + 1) * (index - 1), (base + 1) * index]
  const start = extra * (base + 1) + (index - extra - 1) * base
  return [start, start + base]
}

const sha1 = (s) => createHash('sha1').update(s).digest('hex')
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The paths of part `index` of `count`, from every path in the run. Each path
 * is in exactly one part, for any count. Throws on a part that does not exist
 * or a path that is not a string or is listed twice, so a broken call fails
 * the run instead of dropping files.
 */
export function pathsOfPart(paths, index, count, weights = HEAVY_TEST_FILES) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`no such split: ${count} parts`)
  if (!Number.isInteger(index) || index < 1 || index > count) throw new Error(`no such part: ${index} of ${count}`)
  if (!Array.isArray(paths)) throw new Error('the paths are not a list')
  const seen = new Set()
  for (const p of paths) {
    if (typeof p !== 'string' || p === '') throw new Error(`not a path: ${JSON.stringify(p)}`)
    if (seen.has(p)) throw new Error(`listed twice: ${p}`)
    seen.add(p)
  }
  const weightOf = (p) => weights.get(p) ?? 0
  const heavy = paths.filter((p) => weightOf(p) > 0).sort((a, b) => weightOf(b) - weightOf(a) || byText(a, b))
  const load = new Array(count).fill(0)
  const mine = []
  for (const p of heavy) {
    let k = 0
    for (let i = 1; i < count; i++) if (load[i] < load[k]) k = i
    load[k] += weightOf(p)
    if (k === index - 1) mine.push(p)
  }
  const light = paths
    .filter((p) => weightOf(p) <= 0)
    .map((p) => ({ p, h: sha1(`/${p}`) }))
    .sort((a, b) => byText(a.h, b.h) || byText(a.p, b.p))
    .map(({ p }) => p)
  const [start, end] = shardRange(light.length, index, count)
  return [...mine, ...light.slice(start, end)]
}

/**
 * `items` in the order a part runs them: the heavy ones first, heaviest
 * first, then every other one in the order given. Nothing is added or lost.
 */
export function heavyFirst(items, pathOf, weights = HEAVY_TEST_FILES) {
  const weightOf = (it) => weights.get(pathOf(it)) ?? 0
  const heavy = items.filter((it) => weightOf(it) > 0).sort((a, b) => weightOf(b) - weightOf(a) || byText(pathOf(a), pathOf(b)))
  return [...heavy, ...items.filter((it) => weightOf(it) <= 0)]
}
