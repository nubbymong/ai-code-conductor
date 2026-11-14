// Provider names are looked up, not compared.
//
// The main process outside the provider packages (src/main, leaving out
// src/main/providers) should ask the provider registry what a provider is and
// can do, and not compare a provider id with a name written in the code. Each
// such comparison is a place a new provider would silently take another
// provider's path, and each `provider ?? '<name>'` is one more place that
// decides the default provider on its own.
//
// This counts both kinds and holds them to a ceiling: the numbers as they
// stood when the test was written. A count above its ceiling fails (a new name
// check was added: use the provider registry instead). A count below its
// ceiling fails too, asking for the ceiling to be lowered to the new count, so
// the numbers only ever go down.
//
// The names are read from the app's own list of provider ids, so a provider
// added later is counted from the day it is listed.
//
// Reads source files only; nothing is started.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { PROVIDER_IDS } from '../../../src/shared/providers/ids'

const ROOT = resolve(__dirname, '..', '..', '..')
const SCOPE = 'src/main'
const LEFT_OUT = 'src/main/providers/'

/** The counts as they stand: 71 and 27 before a local launch looked its
 *  provider up in the registry, 69 and 27 since. Lower one when its count
 *  drops; never raise one. */
const CEILING = { comparisons: 69, rederivations: 27 }

const NAMES = PROVIDER_IDS.join('|')
const QUOTE = `['"]`
/** A provider name compared for equality, the name on either side. */
const COMPARISON = new RegExp(`[!=]==?\\s*${QUOTE}(?:${NAMES})${QUOTE}|${QUOTE}(?:${NAMES})${QUOTE}\\s*[!=]==?`, 'g')
/** A provider id defaulted to a name in place: `provider ?? '<name>'`. */
const REDERIVATION = new RegExp(`(?:provider|Provider|providerId)\\s*\\?\\?\\s*${QUOTE}(?:${NAMES})${QUOTE}`, 'g')

interface Counts { comparisons: number; rederivations: number }

function countIn(text: string): Counts {
  return { comparisons: (text.match(COMPARISON) ?? []).length, rederivations: (text.match(REDERIVATION) ?? []).length }
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** Every file in scope that holds a name check, with its two counts. */
function scan(): Array<{ file: string } & Counts> {
  return sourceFiles(join(ROOT, ...SCOPE.split('/')))
    .map((full) => ({ full, file: relative(ROOT, full).split(sep).join('/') }))
    .filter(({ file }) => !file.startsWith(LEFT_OUT))
    .map(({ full, file }) => ({ file, ...countIn(readFileSync(full, 'utf8')) }))
    .filter((f) => f.comparisons > 0 || f.rederivations > 0)
    .sort((a, b) => (a.file < b.file ? -1 : 1))
}

/** What a count outside its ceiling says, or null when it is on it. */
function verdict(kind: keyof Counts, what: string, found: Array<{ file: string } & Counts>, ceiling: number): string | null {
  const total = found.reduce((sum, f) => sum + f[kind], 0)
  if (total === ceiling) return null
  if (total < ceiling) return `${what}: ${total} found, and the ceiling is ${ceiling}: lower the ceiling to ${total}`
  const byFile = found.filter((f) => f[kind] > 0).map((f) => `  ${f[kind]}  ${f.file}`).join('\n')
  return `${what}: ${total} found, and the ceiling is ${ceiling}: use the provider registry instead of a new name check. The files that hold them:\n${byFile}`
}

describe('provider names in the main process outside the provider packages', () => {
  const found = scan()

  it('the scan reads the main process and leaves the provider packages out', () => {
    expect(found.length).toBeGreaterThan(0)
    expect(found.filter((f) => f.file.startsWith(LEFT_OUT))).toEqual([])
    expect(found.every((f) => f.file.startsWith(`${SCOPE}/`))).toBe(true)
  })

  it('comparisons with a provider name do not go up, and the ceiling follows them down', () => {
    expect(verdict('comparisons', 'provider-name comparisons', found, CEILING.comparisons)).toBeNull()
  })

  it('provider ids defaulted to a name in place do not go up, and the ceiling follows them down', () => {
    expect(verdict('rederivations', 'provider ids defaulted to a name', found, CEILING.rederivations)).toBeNull()
  })
})

describe('the count itself', () => {
  const [first, second = first] = PROVIDER_IDS

  it('sees a name on either side, in either kind of quote, strict or loose, equal or not', () => {
    expect(countIn(`if (p === '${first}') {}`).comparisons).toBe(1)
    expect(countIn(`if (p !== "${second}") {}`).comparisons).toBe(1)
    expect(countIn(`if ('${first}' === p) {}`).comparisons).toBe(1)
    expect(countIn(`if (p == '${first}' || p != '${second}') {}`).comparisons).toBe(2)
    expect(countIn(`const a = (x ?? '${first}') === '${second}' ? '${second}' : '${first}'`)).toEqual({ comparisons: 1, rederivations: 0 })
  })

  it('sees an id defaulted to a name, whatever the id is called', () => {
    expect(countIn(`const a = options?.provider ?? '${first}'`).rederivations).toBe(1)
    expect(countIn(`const b = launchProvider ?? "${first}"`).rederivations).toBe(1)
    expect(countIn(`const c = run.providerId ?? '${second}'`).rederivations).toBe(1)
  })

  it('does not count a name that is assigned, passed or returned', () => {
    expect(countIn(`const a = '${first}'; f('${second}'); const g = () => '${first}'`)).toEqual({ comparisons: 0, rederivations: 0 })
    expect(countIn(`const kinds = { ${first}: 'shell', ${second}: 'direct' }`)).toEqual({ comparisons: 0, rederivations: 0 })
  })

  it('a count above its ceiling names the files and says what to do; one below says the new ceiling', () => {
    const files = [{ file: 'src/main/a.ts', comparisons: 2, rederivations: 0 }, { file: 'src/main/b.ts', comparisons: 1, rederivations: 4 }]
    expect(verdict('comparisons', 'provider-name comparisons', files, 3)).toBeNull()
    const above = verdict('comparisons', 'provider-name comparisons', files, 2)
    expect(above).toContain('use the provider registry instead')
    expect(above).toContain('2  src/main/a.ts')
    expect(above).toContain('1  src/main/b.ts')
    expect(verdict('rederivations', 'provider ids defaulted to a name', files, 2)).not.toContain('src/main/a.ts')
    expect(verdict('comparisons', 'provider-name comparisons', files, 5)).toBe('provider-name comparisons: 3 found, and the ceiling is 5: lower the ceiling to 3')
  })
})
