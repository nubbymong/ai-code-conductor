// Provider names are looked up, not compared.
//
// The main process outside the provider packages (src/main, leaving out
// src/main/providers) should ask the provider registry what a provider is and
// can do, and not test a provider id against a name written in the code. Each
// such test is a place a new provider would take another provider's path, and
// each id defaulted to a name in place is one more place that decides the
// default provider on its own.
//
// WHAT IS COUNTED, per file. A provider name is one of the app's provider ids
// (PROVIDER_IDS) as a string literal: in single quotes, double quotes or
// backticks, bare or in its own parentheses (with or without an `as` cast).
//
// A comparison is any of:
//  - a name on either side of `===`, `!==`, `==` or `!=`;
//  - a name as a `case` label;
//  - a name handed to `.includes(`, `.startsWith(`, `.endsWith(`, `.indexOf(`
//    or `.has(`, and a list written in place that holds a name and is asked
//    `.includes(` or `.indexOf(`;
//  - any of the above through a named constant whose value is a name: a
//    `const` declared at the start of a line and set to a name, in the file
//    that declares it and in a file that imports it by that name.
//
// An id defaulted to a name is any of:
//  - anything that ends in an identifier, `)` or `]`, then `??`, `||`, `??=`
//    or `||=`, then a name;
//  - a parameter or a destructured field given a name as its default (an enum
//    member set to a name reads the same, and is counted too).
//
// What is NOT counted: a name that is assigned, passed, returned, used as a
// key or a value, or listed in a type; a call that takes a name and is then
// compared with something else; and anything under src/main/providers, where
// each provider's own package may say its own name.
//
// Each file has its own ceiling: the two numbers as they stand, kept in
// tests/wp1/provider-name-ceilings.json beside the other reviewed lists of
// that kind. A file above either of its numbers fails (a new name check was
// added: use the provider registry instead), and so does a file that had none
// and now has one, so a check added in one file is never hidden by one
// removed in another. A file below a number fails too, asking for that number
// to be lowered, so the numbers only ever go down.
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

interface Counts { comparisons: number; rederivations: number }

/** Each file's two numbers as they stand, and their sums. Lower a number
 *  when its count drops and take a file out when both reach none; never
 *  raise one and never add a file. */
const CEILINGS_FILE = 'tests/wp1/provider-name-ceilings.json'
const ceilings = JSON.parse(readFileSync(resolve(ROOT, ...CEILINGS_FILE.split('/')), 'utf8')) as { schema: string; total: Counts; files: Record<string, Counts> }
const CEILING: Readonly<Record<string, Counts>> = ceilings.files
/** The sums as they stand, stated here as well so that a change to the
 *  ceilings file is a change to this test too. */
const TOTAL: Counts = { comparisons: 77, rederivations: 32 }

const NAMES = PROVIDER_IDS.join('|')
/** A provider name as a string literal, in any of the three quotes. */
const BARE = `['"\`](?:${NAMES})['"\`]`
const CAST = `(?:\\s+as\\s+[\\w.]+)?`
/** The same in its own parentheses (one pair or two), never a call's. */
const WRAPPED = `(?<![\\w$)\\]])\\(\\s*(?:${BARE}${CAST}|\\(\\s*${BARE}${CAST}\\s*\\))\\s*\\)`
const NAME = `(?:${BARE}|${WRAPPED})`

/** The named constants a file declares whose value is a provider name: a
 *  `const` at the start of a line, set to a name and nothing else. */
function constantsOf(text: string): Array<{ name: string; exported: boolean }> {
  const declared = new RegExp(`^(export\\s+)?const\\s+([A-Za-z_$][\\w$]*)\\s*(?::\\s*[^=\\n]+?)?\\s*=\\s*${NAME}(?:\\s+as\\s+const)?\\s*;?\\s*(?://.*)?$`, 'gm')
  return [...text.matchAll(declared)].map((m) => ({ name: m[2], exported: Boolean(m[1]) }))
}

/** The two patterns for a file in which `constants` are names for a provider name. */
function patterns(constants: readonly string[]): { comparison: RegExp; rederivation: RegExp } {
  const named = constants.map((c) => c.replace(/\$/g, '\\$')).join('|')
  const operand = named ? `(?:${NAME}|\\b(?:${named})\\b)` : NAME
  const comparison = new RegExp([
    `[!=]==?\\s*${operand}`,
    `${operand}\\s*[!=]==?`,
    `\\bcase\\s+${operand}\\s*:`,
    `\\.(?:includes|startsWith|endsWith|indexOf|has)\\(\\s*${operand}`,
    `\\[[^\\]\\n]*${BARE}[^\\]\\n]*\\]\\s*\\.(?:includes|indexOf)\\(`,
  ].join('|'), 'g')
  const rederivation = new RegExp([
    `[\\w$\\])]\\s*(?:\\?\\?=?|\\|\\|=?)\\s*${NAME}`,
    `(?<=[(,{]\\s*)(?:(?:readonly|public|private|protected)\\s+)*[A-Za-z_$][\\w$]*\\??\\s*(?::\\s*[^=,(){}\\n]+?)?\\s*=\\s*${NAME}(?=\\s*[,)}])`,
  ].join('|'), 'g')
  return { comparison, rederivation }
}

/** The two counts of `text`. `imported` are the constants it takes from other
 *  files; the ones it declares itself are found here. */
function countIn(text: string, imported: readonly string[] = []): Counts {
  const { comparison, rederivation } = patterns([...new Set([...constantsOf(text).map((c) => c.name), ...imported])])
  return { comparisons: (text.match(comparison) ?? []).length, rederivations: (text.match(rederivation) ?? []).length }
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** Whether `text` imports `name` by that name. */
const importsByName = (text: string, name: string): boolean =>
  new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${name.replace(/\$/g, '\\$')}\\b[^}]*\\}`).test(text)

/** Every file in scope that holds a name check, with its two counts. */
function scan(): Array<{ file: string } & Counts> {
  const files = sourceFiles(join(ROOT, ...SCOPE.split('/')))
    .map((full) => ({ file: relative(ROOT, full).split(sep).join('/'), text: readFileSync(full, 'utf8') }))
    .filter(({ file }) => !file.startsWith(LEFT_OUT))
  const exported = files.flatMap(({ file, text }) => constantsOf(text).filter((c) => c.exported).map((c) => ({ file, name: c.name })))
  return files
    .map(({ file, text }) => ({ file, ...countIn(text, exported.filter((e) => e.file !== file && importsByName(text, e.name)).map((e) => e.name)) }))
    .filter((f) => f.comparisons > 0 || f.rederivations > 0)
    .sort((a, b) => (a.file < b.file ? -1 : 1))
}

const KINDS: Array<[keyof Counts, string]> = [['comparisons', 'comparisons with a provider name'], ['rederivations', 'ids defaulted to a provider name']]

/** Everything that is off its ceiling, one line each; none when every file is on its own. */
function problems(found: ReadonlyArray<{ file: string } & Counts>, ceiling: Readonly<Record<string, Counts>>): string[] {
  const out: string[] = []
  const seen = new Map(found.map((f) => [f.file, f]))
  for (const f of found) {
    const allowed = Object.hasOwn(ceiling, f.file) ? ceiling[f.file] : undefined
    if (!allowed) {
      out.push(`${f.file}: has ${f.comparisons} comparison(s) with a provider name and ${f.rederivations} id(s) defaulted to one, and had none: use the provider registry instead of a new name check`)
      continue
    }
    for (const [kind, what] of KINDS) {
      if (f[kind] > allowed[kind]) out.push(`${f.file}: ${f[kind]} ${what}, and its ceiling is ${allowed[kind]}: use the provider registry instead of a new name check`)
      if (f[kind] < allowed[kind]) out.push(`${f.file}: ${f[kind]} ${what}, and its ceiling is ${allowed[kind]}: lower its ceiling to ${f[kind]}`)
    }
  }
  for (const file of Object.keys(ceiling)) {
    if (!seen.has(file)) out.push(`${file}: no provider-name check is left in it: take it out of the ceilings`)
  }
  return out
}

const sum = (rows: ReadonlyArray<Counts>): Counts => rows.reduce<Counts>((t, r) => ({ comparisons: t.comparisons + r.comparisons, rederivations: t.rederivations + r.rederivations }), { comparisons: 0, rederivations: 0 })

describe('provider-name checks in src/main outside src/main/providers, file by file', () => {
  const found = scan()

  it('the scan reads src/main and leaves src/main/providers out', () => {
    expect(found.length).toBeGreaterThan(0)
    expect(found.filter((f) => f.file.startsWith(LEFT_OUT))).toEqual([])
    expect(found.every((f) => f.file.startsWith(`${SCOPE}/`))).toBe(true)
    expect(Object.keys(CEILING).filter((file) => file.startsWith(LEFT_OUT) || !file.startsWith(`${SCOPE}/`))).toEqual([])
  })

  it('no file is above either of its ceilings, no file has gained its first check, and each ceiling follows its count down', () => {
    const off = problems(found, CEILING)
    const asTheyStand = found.map((f) => `    "${f.file}": { "comparisons": ${f.comparisons}, "rederivations": ${f.rederivations} }`).join(',\n')
    expect(off, `${off.join('\n')}\n\nThe counts as they stand (${CEILINGS_FILE}):\n${asTheyStand}`).toEqual([])
  })

  it('the ceilings file is well formed, and its numbers add up to the totals stated in it and here', () => {
    expect(ceilings.schema).toBe('provider-name-ceilings/1')
    for (const [file, counts] of Object.entries(CEILING)) {
      expect(Object.keys(counts).sort(), file).toEqual(['comparisons', 'rederivations'])
      for (const n of Object.values(counts)) expect(Number.isInteger(n) && n >= 0, file).toBe(true)
      expect(counts.comparisons + counts.rederivations, `${file} holds no check: take it out`).toBeGreaterThan(0)
    }
    expect(sum(Object.values(CEILING))).toEqual(TOTAL)
    expect(ceilings.total).toEqual(TOTAL)
    expect(sum(found)).toEqual(TOTAL)
  })
})

describe('what the count sees, spelling by spelling', () => {
  const [first, second = first] = PROVIDER_IDS
  const ONE_COMPARISON: Counts = { comparisons: 1, rederivations: 0 }
  const ONE_DEFAULT: Counts = { comparisons: 0, rederivations: 1 }
  const NOTHING: Counts = { comparisons: 0, rederivations: 0 }

  it.each<[string, string]>([
    ['strict equality, the name on the right', `if (p === '${first}') {}`],
    ['strict inequality, double quotes', `if (p !== "${second}") {}`],
    ['the name on the left', `if ('${first}' === p) {}`],
    ['loose equality', `if (p == '${second}') {}`],
    ['loose inequality', `if (p != '${first}') {}`],
    ['a template literal', `if (p === \`${first}\`) {}`],
    ['a template literal on the left', `if (\`${second}\` !== p) {}`],
    ['the name in its own parentheses', `if (p === ('${first}')) {}`],
    ['the name in its own parentheses, on the left', `if (('${second}') !== p) {}`],
    ['the name in two pairs of parentheses', `if (p === (('${first}'))) {}`],
    ['the name cast in its own parentheses', `if (p === ('${first}' as ProviderId)) {}`],
    ['a case label', `switch (p) { case '${first}': break }`],
    ['a case label, spaced and double-quoted', `switch (p) { case "${second}" : break }`],
    ['includes', `if (list.includes('${first}')) {}`],
    ['startsWith', `if (key.startsWith("${second}")) {}`],
    ['endsWith', `if (key.endsWith('${first}')) {}`],
    ['indexOf', `if (list.indexOf('${second}') >= 0) {}`],
    ['has', `if (set.has('${first}')) {}`],
    ['a list written in place, asked includes', `if (['${first}', '${second}'].includes(p)) {}`],
    ['a list written in place, asked indexOf', `if (["${second}"].indexOf(p) < 0) {}`],
    ['a named constant, compared', `const THE_ID: Kind = '${second}'\nfind((p) => p.providerId === THE_ID)`],
    ['a named constant, on the left', `export const THE_ID = '${first}' as const\nif (THE_ID !== id) {}`],
    ['a named constant as a case label', `const THE_ID = '${first}'\nswitch (p) { case THE_ID: break }`],
    ['a named constant handed to includes', `const THE_ID = "${second}"\nif (list.includes(THE_ID)) {}`],
  ])('a comparison: %s', (_what, text) => {
    expect(countIn(text)).toEqual(ONE_COMPARISON)
  })

  it('a comparison through a constant another file exports is seen in the file that imports it by name', () => {
    const text = `import { THE_ID, other } from './ids'\nif (p === THE_ID) {}`
    expect(countIn(text)).toEqual(NOTHING)
    expect(countIn(text, ['THE_ID'])).toEqual(ONE_COMPARISON)
  })

  it('two comparisons on one line are two, and a defaulted id that is then compared is one of each', () => {
    expect(countIn(`if (p == '${first}' || p != '${second}') {}`).comparisons).toBe(2)
    expect(countIn(`const a = (x ?? '${first}') === '${second}' ? 1 : 2`)).toEqual({ comparisons: 1, rederivations: 1 })
  })

  it.each<[string, string]>([
    ['?? after a member', `const a = options?.provider ?? '${first}'`],
    ['?? after a plain identifier, double quotes', `const b = launchProvider ?? "${first}"`],
    ['?? after any identifier, whatever it is called', `const c = kind ?? '${second}'`],
    ['?? after a call', `const d = pick() ?? '${first}'`],
    ['?? after an index', `const e = list[0] ?? '${second}'`],
    ['?? and a template literal', `const f = id ?? \`${first}\``],
    ['?? and the name in its own parentheses', `const g = id ?? ('${first}')`],
    ['||', `const h = id || '${second}'`],
    ['??=', `id ??= '${first}'`],
    ['||=', `id ||= '${second}'`],
    ['a default parameter', `function start(provider = '${first}') {}`],
    ['a default parameter with a type', `function hold(win: Win, agent: '${first}' | '${second}' | null = '${first}'): void {}`],
    ['a default parameter of an arrow function', `const run = (id: string, subject: Kind = '${second}') => id`],
    ['a constructor parameter', `class A { constructor(private readonly id: Kind = '${first}') {} }`],
    ['a destructured field', `const { provider = '${second}' } = options`],
    ['a destructured parameter', `function open({ cwd, provider = '${first}' }: Options) {}`],
  ])('an id defaulted to a name: %s', (_what, text) => {
    expect(countIn(text)).toEqual(ONE_DEFAULT)
  })

  it.each<[string, string]>([
    ['a name that is assigned', `const a = '${first}'`],
    ['a name assigned to something that exists', `chosen = '${second}'`],
    ['a name that is passed', `start('${first}', "${second}")`],
    ['a name that is returned', `const g = () => '${first}'`],
    ['a name as a value', `const o = { provider: '${first}' }`],
    ['a name as a key', `const kinds = { ${first}: 'shell', ${second}: 'direct' }`],
    ['a list of names', `const all = ['${first}', '${second}']`],
    ['a type that lists names', `type P = '${first}' | '${second}'`],
    ['a name in a conditional', `const n = cond ? '${first}' : '${second}'`],
    ['a call that takes a name, compared with something else', `if (refusal('${first}') === null) {}`],
    ['a method call that takes a name, compared with something else', `if (service?.ready('${second}') === true) {}`],
    ['a lookup by name', `const p = table.get('${first}')`],
    ['a longer word that begins with a name', `if (p === '${first}-code') {}`],
    ['a longer word that ends with a name', `if (p === 'not-${second}') {}`],
    ['an id defaulted to something that is not a name', `const a = id ?? fallback`],
    ['an ordering test', `if (p >= '${first}') {}`],
    ['a named constant that is only passed', `const THE_ID = '${first}'\nstart(THE_ID)`],
    ['a constant that is not at the start of a line', `function f() {\n  const local = '${second}'\n  return x === local\n}`],
    ['another file\'s constant, not imported here', `if (p === THE_ID) {}`],
  ])('not counted: %s', (_what, text) => {
    expect(countIn(text)).toEqual(NOTHING)
  })
})

describe('what a file off its ceiling is told', () => {
  const files = [{ file: 'src/main/a.ts', comparisons: 2, rederivations: 0 }, { file: 'src/main/b.ts', comparisons: 1, rederivations: 4 }]
  const onIt = { 'src/main/a.ts': { comparisons: 2, rederivations: 0 }, 'src/main/b.ts': { comparisons: 1, rederivations: 4 } }

  it('every file on its own ceiling: nothing', () => {
    expect(problems(files, onIt)).toEqual([])
  })

  it('a file above a ceiling is named with both numbers and told what to do', () => {
    expect(problems(files, { ...onIt, 'src/main/b.ts': { comparisons: 1, rederivations: 3 } }))
      .toEqual(['src/main/b.ts: 4 ids defaulted to a provider name, and its ceiling is 3: use the provider registry instead of a new name check'])
  })

  it('a check added in one file is not hidden by one removed in another: both files are named', () => {
    const moved = [{ file: 'src/main/a.ts', comparisons: 1, rederivations: 0 }, { file: 'src/main/b.ts', comparisons: 2, rederivations: 4 }]
    expect(sum(moved)).toEqual(sum(files))
    expect(problems(moved, onIt)).toEqual([
      'src/main/a.ts: 1 comparisons with a provider name, and its ceiling is 2: lower its ceiling to 1',
      'src/main/b.ts: 2 comparisons with a provider name, and its ceiling is 1: use the provider registry instead of a new name check',
    ])
  })

  it('a file that had no check and has one now is named', () => {
    expect(problems([...files, { file: 'src/main/c.ts', comparisons: 1, rederivations: 0 }], onIt))
      .toEqual(['src/main/c.ts: has 1 comparison(s) with a provider name and 0 id(s) defaulted to one, and had none: use the provider registry instead of a new name check'])
  })

  it('a file below a ceiling is told its new number, and one with no check left is to be taken out', () => {
    expect(problems([files[1]], { ...onIt, 'src/main/b.ts': { comparisons: 3, rederivations: 4 } })).toEqual([
      'src/main/b.ts: 1 comparisons with a provider name, and its ceiling is 3: lower its ceiling to 1',
      'src/main/a.ts: no provider-name check is left in it: take it out of the ceilings',
    ])
  })
})
