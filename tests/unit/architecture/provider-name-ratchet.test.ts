// Provider names are looked up, not compared.
//
// The app's code outside the provider packages should ask the provider
// registry what a provider is and can do, and not test a provider id against
// a name written in the code. Each such test is a place a new provider would
// take another provider's path, and each id defaulted to a name in place is
// one more place that decides the default provider on its own.
//
// WHERE, per file: every TypeScript file (.ts, .tsx) under src/main,
// src/renderer, src/shared and src/preload, leaving out src/main/providers and
// each provider's own folder under src/renderer/providers (one per id in
// PROVIDER_IDS), where each provider's own package may say its own name. Those
// left out are read for the constants they export, and never counted.
//
// WHAT IS COUNTED, per file. Code only: before anything is matched, every
// comment is blanked, and so is the text of every string and template literal
// that is not exactly a provider name or a launch style (the expressions inside
// a template literal's `${}` are code, and stay). A provider name is one of the
// app's provider ids (PROVIDER_IDS) as a string literal: in single quotes,
// double quotes or backticks, bare or in its own parentheses, with or without
// `as` or `satisfies` and a type that is a plain or dotted name.
//
// A comparison is any of:
//  - a name on either side of `===`, `!==`, `==` or `!=`;
//  - a name as a `case` label;
//  - a name handed to `.includes(`, `.startsWith(`, `.endsWith(`, `.indexOf(`
//    or `.has(`;
//  - any of those three through a named constant whose value is a name: a
//    `const` declared at the start of a line and set to a name;
//  - a list that holds a name, asked `.includes(`, `.indexOf(` or `.has(`:
//    written in place (bare, cast in its own parentheses, or handed to
//    `new Set(`), or kept in a `const` declared at the start of a line and
//    written on that line (a list, or a `new Set(` of one).
// A constant, a name's or a list's, counts in the file that declares it and
// in every file that imports it, by that name or under another
// (`import { A as B }`: in that file it is `B`, and `A` is not counted),
// wherever under src it is exported from. The import is matched by the
// constant's name, not by the file the import names.
//
// An id defaulted to a name is any of:
//  - anything that ends in an identifier, `)` or `]`, then `??`, `||`, `??=`
//    or `||=`, then a name;
//  - a parameter or a destructured field given a name as its default (an enum
//    member set to a name reads the same, and is counted too);
//  - a conditional that gives back what it asked about, or else a name:
//    `x ? x : 'name'`, the same asked `!== undefined` or `!= null` (either
//    operator, either word), and turned round, `x === undefined ? 'name' : x`
//    and `!x ? 'name' : x`, where `x` is an identifier or a chain of members;
//  - a property set to a name with a spread after it in the same braces
//    (`{ provider: 'name', ...options }`), with nothing bracketed between.
//
// A registry lookup by a name is a call of one of the registries' lookups
// with a name (any spelling above, or a named constant whose value is one) as
// its first argument. The lookups are read from the two registries
// (src/main/providers/core/registry.ts, src/renderer/providers/core/registry.ts):
// each function they export that takes a provider id and gives back that
// provider, its package or its descriptor (getProvider, tryGetProvider,
// getProviderPackage, tryGetProviderPackage, getRendererProvider,
// tryGetRendererProvider), called by its own name or by the name a file
// imports it under. A loop over the registered providers, or the session's
// own provider id, names none.
//
// A launch-style test is a comparison, in any of the shapes above, with one of
// the launch styles' words (LocalLaunchStyle in src/main/pty-manager.ts, read
// from its source) in place of a provider name. A style stands for one
// provider's launch, so a test of it is a provider test by another name. The
// count reads words, not types, in every folder above: one of those words
// compared for any other reason is counted all the same (`mode === 'direct'`
// in a renderer file is one). Give that other thing another word, or narrow
// this count to the files that hold a launch style in the same change.
//
// In src/main/remote-helper alone, a CLI's own words, which belong in the
// provider's package: a string that is exactly one long flag (`'--effort'`,
// or one with its value after `=`); a CLI variable, a name that starts with a
// provider id in capitals and `_` (CLAUDE_CODE_DISABLE_MOUSE), in code or as a
// whole string; and a string that is a path ending in a provider's CLI name
// (`'/usr/local/bin/' + id`, the id being the CLI's name). The helper's own
// command lines are longer strings, not one flag of a CLI, and are not counted.
//
// What is NOT counted:
//  - a name that is assigned, passed (to anything but a lookup), returned,
//    used as a key or a value, or listed in a type; a call that takes a name
//    and is then compared with something else;
//  - anything in a comment, and anything written inside a string or a
//    template literal (the text of a script the app writes out included);
//  - a conditional that asks some other way (`typeof x === 'string' ? x :
//    'name'`), about two different things, or about something that is not an
//    identifier or a chain of members (a call, an index);
//  - a default given by `Object.assign`, by a spread in other braces, or by a
//    spread with something bracketed between it and the name; a name set
//    after the spread is assigned, not defaulted;
//  - a list of names written over several lines, kept in a `const` that is
//    not at the start of a line, or built from something else;
//  - a constant reached through a namespace import (`ids.THE_ID`) or through
//    `require`, or exported again under another name;
//  - a name under `as` or `satisfies` with a type that is not a plain or
//    dotted name (a generic, a union), where that type stands between the
//    name and what would count it: on the left of a comparison, or as a
//    default parameter;
//  - a lookup through a function of the app's own that wraps a registry
//    lookup, or whose id is worked out in place (a conditional; an id
//    defaulted to a name is counted as that);
//  - the registries' other calls that take a provider id (realmEnvForProvider,
//    ambientAuthVariablesForProvider, sanitizeManagedSettingsFor,
//    authoritySettingsKeysFor, managedLaunchPreflightFor,
//    minimumManagedCliVersionFor, providerCapability), and the app's own that
//    do (providerOnNow, providerProbeRefusal, the accounts service's);
//  - a boolean that stands for a provider (an `is<Provider>Session` flag),
//    handed in or worked out elsewhere;
//  - a launch style kept in a row, passed or returned (LOCAL_LAUNCH_STYLE);
//  - in src/main/remote-helper: a flag with one dash (`'-p'`, ssh's own), a
//    flag or variable inside a longer string (a command line), a flag built
//    in a template literal with `${}`, the machine record's `claudePath` field
//    and the probe's `command -v`;
//  - in a .tsx file, JSX is read as code: an apostrophe, a quote or `//` in
//    the text between tags reads as the start of a string or a comment, which
//    hides the rest of that line (a backtick, up to the next backtick); and a
//    closing tag's `/` with another `/` after it on the line reads as a
//    regular expression, so a string that holds that second `/` is read
//    inside out and can hide a check after it on the line
//    (`<a>x</a>{'x/y'}{p === 'name'}`);
//  - a file under src that is not TypeScript (src/main/first-start-worker.cjs),
//    and anything outside src (scripts, helper, tests);
//  - anything under src/main/providers and src/renderer/providers/<id>, where
//    each provider's own package may say its own name.
//
// Each file has its own ceilings: its numbers as they stand, kept in
// tests/wp1/provider-name-ceilings.json beside the other reviewed lists of
// that kind (a file lists the counts it holds; one it does not list is none).
// A file above any of its numbers fails (a new check was added: use the
// provider registry instead), and so does a file that had none and now has
// one, so a check added in one file is never hidden by one removed in another.
// A file below a number fails too, asking for that number to be lowered, so
// the numbers only ever go down.
//
// The names are read from the app's own list of provider ids, so a provider
// added later is counted, and its renderer package left out, from the day it
// is listed.
//
// Reads source files only; nothing is started.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { PROVIDER_IDS } from '../../../src/shared/providers/ids'

const ROOT = resolve(__dirname, '..', '..', '..')
const readSource = (file: string): string => readFileSync(resolve(ROOT, ...file.split('/')), 'utf8')

/** The folders whose code is counted. */
const SCOPES = ['src/main', 'src/renderer', 'src/shared', 'src/preload'] as const
/** Each provider's own package: read for the constants it exports, and never counted. */
const LEFT_OUT: readonly string[] = ['src/main/providers/', ...PROVIDER_IDS.map((id) => `src/renderer/providers/${id}/`)]
/** The folder whose CLI flags, variables and paths are counted. */
const REMOTE_HELPER = 'src/main/remote-helper/'
const inScope = (file: string): boolean => SCOPES.some((s) => file.startsWith(`${s}/`))
const isCounted = (file: string): boolean => inScope(file) && !LEFT_OUT.some((l) => file.startsWith(l))

const KINDS = ['comparisons', 'rederivations', 'lookups', 'launchStyleTests', 'remoteCliTerms'] as const
type Kind = typeof KINDS[number]
type Counts = Record<Kind, number>
const NONE: Counts = { comparisons: 0, rederivations: 0, lookups: 0, launchStyleTests: 0, remoteCliTerms: 0 }
/** What each count is, and what to do in place of a new one. */
const KIND_TEXT: Readonly<Record<Kind, { what: string; instead: string }>> = {
  comparisons: { what: 'comparisons with a provider name', instead: 'use the provider registry instead of a new name check' },
  rederivations: { what: 'ids defaulted to a provider name', instead: 'use the provider registry instead of a new name check' },
  lookups: { what: 'registry lookups by a provider name', instead: 'loop over the registered providers, or look up the session\'s own provider, instead of naming one' },
  launchStyleTests: { what: 'launch styles compared with a style', instead: 'ask the provider\'s package instead of testing its launch style' },
  remoteCliTerms: { what: 'CLI flags, variables and paths named in the remote helper', instead: 'let the provider\'s package build its CLI\'s launch instead' },
}

interface Source { file: string; text: string }
/** A constant a file knows: a name for a word, or for a list that holds one. */
interface Known { name: string; kind: 'name' | 'list' }

/** Each file's numbers as they stand, and their sums. Lower a number when its
 *  count drops and take it out at none (a file, when it holds none); never
 *  raise one and never add a file. */
const CEILINGS_FILE = 'tests/wp1/provider-name-ceilings.json'
const ceilings = JSON.parse(readSource(CEILINGS_FILE)) as { schema: string; total: Counts; files: Record<string, Partial<Counts>> }
const CEILING: Readonly<Record<string, Partial<Counts>>> = ceilings.files
/** The sums as they stand, stated here as well so that a change to the
 *  ceilings file is a change to this test too. */
const TOTAL: Counts = { comparisons: 269, rederivations: 91, lookups: 20, launchStyleTests: 2, remoteCliTerms: 0 }

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const IDS = PROVIDER_IDS.map(escapeRe).join('|')
const IDENT = `[A-Za-z_$][\\w$]*`
/** `as` or `satisfies` and a plain or dotted type name, any number of times. */
const CAST = `(?:\\s+(?:as|satisfies)\\s+[\\w.$]+)*`

/** The spellings of one set of words as string literals. */
interface Words { list: readonly string[]; bare: string; name: string }
function wordsOf(list: readonly string[]): Words {
  /** A word as a string literal, in any of the three quotes. */
  const bare = `['"\`](?:${list.map(escapeRe).join('|')})['"\`]`
  /** The same in its own parentheses (one pair or two), never a call's. */
  const wrapped = `(?<![\\w$)\\]])\\(\\s*(?:${bare}${CAST}|\\(\\s*${bare}${CAST}\\s*\\))\\s*\\)`
  return { list, bare, name: `(?:${bare}|${wrapped})${CAST}` }
}
const PROVIDER_NAMES = wordsOf(PROVIDER_IDS)

/** The launch styles' words, read from LocalLaunchStyle's own line. */
const STYLE_SOURCE = 'src/main/pty-manager.ts'
const STYLE_WORDS: readonly string[] = (() => {
  const line = /^export type LocalLaunchStyle\s*=\s*(.+)$/m.exec(readSource(STYLE_SOURCE))
  return line ? [...line[1].matchAll(/'([^'\n]+)'/g)].map((w) => w[1]) : []
})()
const STYLES: Words | null = STYLE_WORDS.length ? wordsOf(STYLE_WORDS) : null

/** The registries' lookups: each function a registry exports that takes a
 *  provider id and gives back that provider, its package or its descriptor. */
const REGISTRIES = ['src/main/providers/core/registry.ts', 'src/renderer/providers/core/registry.ts']
const LOOKUPS: readonly string[] = REGISTRIES.flatMap((file) => [...readSource(file)
  .matchAll(/^export function (\w+)\(id: ProviderId\): (?:SessionProvider|ProviderPackage|RendererProviderDescriptor)(?: \| null)? \{/gm)].map((m) => m[1]))

/** A CLI's own words in the remote helper, by what a whole string is. */
const CLI_VARIABLE_HEADS = PROVIDER_IDS.map((id) => id.toUpperCase().replace(/[^A-Z0-9]/g, '_')).join('|')
const CLI_FLAG = /^--[A-Za-z][\w-]*(?:=[^\n]*)?$/
const CLI_VARIABLE = new RegExp(`^(?:${CLI_VARIABLE_HEADS})_[A-Z0-9_]*[A-Z0-9]$`)
const CLI_PATH = new RegExp(`[/\\\\](?:${IDS})(?:\\.exe)?$`)
const isCliWord = (s: string): boolean => CLI_FLAG.test(s) || CLI_VARIABLE.test(s) || CLI_PATH.test(s)

const isProviderName = (s: string): boolean => (PROVIDER_IDS as readonly string[]).includes(s)
const isNameOrStyle = (s: string): boolean => isProviderName(s) || STYLE_WORDS.includes(s)

/** The words a regular expression may follow (after any other word, `/` divides). */
const BEFORE_A_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])

/**
 * `text` as code alone: every comment blanked, and the text of every string
 * and template literal that is not exactly a word `keep` keeps (a provider
 * name, when not told otherwise). A blanked character becomes a space and line
 * breaks stay, so every line keeps its place. Strings, template literals
 * (with what their `${}` hold, which is code) and regular expressions are
 * stepped over whole: a `//` inside one starts no comment, and a quote inside
 * a comment or a regular expression opens no string.
 */
function codeOf(text: string, keep: (s: string) => boolean = isProviderName): string {
  const out = text.split('')
  const n = text.length
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }
  /** How far a backslash at `at` reaches: over the one character it escapes,
   *  or over a whole line break, so a checkout with either kind reads alike. */
  const escaped = (at: number): number => (text[at + 1] === '\r' && text[at + 2] === '\n' ? 3 : 2)
  /** One entry for each `${` that is open: how many `{` are open inside it. */
  const braces: number[] = []
  /** The last piece of code passed: a word, a punctuation mark, or `value`
   *  for the end of a string, a template literal or a regular expression. */
  let last = ''
  let lastAt = -1
  let i = 0
  /** From inside a template literal (`opened`: just past its backtick) to its
   *  closing backtick, or to the next `${`, where code starts again. */
  const templateText = (opened: boolean): void => {
    const from = i
    while (i < n) {
      const c = text[i]
      if (c === '\\') { i += escaped(i); continue }
      if (c === '`') {
        if (!(opened && keep(text.slice(from, i)))) blank(from, i)
        i++
        last = 'value'
        return
      }
      if (c === '$' && text[i + 1] === '{') {
        blank(from, i)
        i += 2
        braces.push(0)
        last = '{'
        lastAt = i - 1
        return
      }
      i++
    }
    blank(from, n)
  }
  /** Whether a `/` here starts a regular expression (and does not divide). */
  const regexMayStart = (): boolean => {
    if (last === '') return true
    if (last === 'value') return false
    if (/^[\w$]/.test(last)) return BEFORE_A_REGEX.has(last)
    if (last === ')' || last === ']') return false
    if ((last === '+' || last === '-') && text[lastAt - 1] === last) return false
    if (last === '!' && /[\w$)\]]/.test(text[lastAt - 1] ?? '')) return false
    return true
  }
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      const to = end < 0 ? n : end
      blank(i, to)
      i = to
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const to = end < 0 ? n : end + 2
      blank(i, to)
      i = to
      continue
    }
    if (c === '\'' || c === '"') {
      const from = ++i
      while (i < n && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? escaped(i) : 1
      if (!keep(text.slice(from, i))) blank(from, i)
      if (text[i] === c) i++
      last = 'value'
      continue
    }
    if (c === '`') { i++; templateText(true); continue }
    if (c === '/') {
      if (regexMayStart()) {
        let j = i + 1
        let inClass = false
        let closed = false
        for (; j < n && text[j] !== '\n'; j++) {
          const r = text[j]
          if (r === '\\') { j++; continue }
          if (inClass) { if (r === ']') inClass = false; continue }
          if (r === '[') { inClass = true; continue }
          if (r === '/') { closed = true; break }
        }
        if (closed) {
          i = j + 1
          while (i < n && /[A-Za-z]/.test(text[i])) i++
          last = 'value'
          continue
        }
      }
      last = c
      lastAt = i
      i++
      continue
    }
    if (c === '{') {
      if (braces.length) braces[braces.length - 1]++
      last = c
      lastAt = i
      i++
      continue
    }
    if (c === '}') {
      if (braces.length && braces[braces.length - 1] === 0) { braces.pop(); i++; templateText(false); continue }
      if (braces.length) braces[braces.length - 1]--
      last = c
      lastAt = i
      i++
      continue
    }
    if (/[\w$]/.test(c)) {
      let j = i + 1
      while (j < n && /[\w$]/.test(text[j])) j++
      last = text.slice(i, j)
      lastAt = j - 1
      i = j
      continue
    }
    if (/\s/.test(c)) { i++; continue }
    last = c
    lastAt = i
    i++
  }
  return out.join('')
}

/** The constants `code` declares for one of `words` or for a list that holds
 *  one: a `const` at the start of a line, set to a word and nothing else, or
 *  to a list (or a `new Set(` of one) written on that line. */
function declaredIn(code: string, words: Words = PROVIDER_NAMES): Array<Known & { exported: boolean }> {
  const head = `^(export\\s+)?const\\s+(${IDENT})\\s*(?::\\s*[^=\\n]+?)?\\s*=\\s*`
  const name = new RegExp(`${head}${words.name}\\s*;?\\s*$`, 'gm')
  const list = new RegExp(`${head}(?:new\\s+Set\\s*(?:<[^>\\n]*>)?\\s*\\(\\s*)?\\[[^\\]\\n]*${words.bare}[^\\]\\n]*\\]`, 'gm')
  return [
    ...[...code.matchAll(name)].map((m) => ({ name: m[2], kind: 'name' as const, exported: Boolean(m[1]) })),
    ...[...code.matchAll(list)].map((m) => ({ name: m[2], kind: 'list' as const, exported: Boolean(m[1]) })),
  ]
}

/** The patterns for `words` in a file that knows the constants `known`, and
 *  calls the registry lookups by the names `lookups`. */
function patterns(words: Words, known: ReadonlyArray<Known>, lookups: readonly string[] = []): { comparison: RegExp; rederivation: RegExp; lookup: RegExp | null } {
  const oneOf = (kind: Known['kind']): string => known.filter((k) => k.kind === kind).map((k) => k.name.replace(/\$/g, '\\$')).join('|')
  const named = oneOf('name')
  const lists = oneOf('list')
  const operand = named ? `(?:${words.name}|\\b(?:${named})\\b)` : words.name
  const asked = `\\s*\\.(?:includes|indexOf|has)\\(`
  /** An identifier or a chain of members, kept as `group` to be met again. */
  const same = (group: string): string => `(?<![\\w$.])(?<${group}>${IDENT}(?:\\??\\.${IDENT})*)`
  const then = `\\?(?![.?])\\s*`
  const comparison = new RegExp([
    `[!=]==?\\s*${operand}`,
    `${operand}\\s*[!=]==?`,
    `\\bcase\\s+${operand}\\s*:`,
    `\\.(?:includes|startsWith|endsWith|indexOf|has)\\(\\s*${operand}`,
    `\\[[^\\]\\n]*${words.bare}[^\\]\\n]*\\](?:\\s+as\\s+[^()\\n]+)?\\s*\\)?${asked}`,
    ...(lists ? [`(?:\\b(?:${lists})\\b|\\(\\s*(?:${lists})\\s+as\\s+[^()\\n]+\\))${asked}`] : []),
  ].join('|'), 'g')
  const rederivation = new RegExp([
    `[\\w$\\])]\\s*(?:\\?\\?=?|\\|\\|=?)\\s*${words.name}`,
    `(?<=[(,{]\\s*)(?:(?:readonly|public|private|protected)\\s+)*${IDENT}\\??\\s*(?::\\s*[^=,(){}\\n]+?)?\\s*=\\s*${words.name}(?=\\s*[,)}])`,
    `${same('kept')}\\s*(?:!==?\\s*(?:undefined|null)\\s*)?${then}\\k<kept>\\s*:\\s*${words.name}`,
    `${same('absent')}\\s*===?\\s*(?:undefined|null)\\s*${then}${words.name}\\s*:\\s*\\k<absent>(?![\\w$.])`,
    `!\\s*${same('falsy')}\\s*${then}${words.name}\\s*:\\s*\\k<falsy>(?![\\w$.])`,
    `[{,]\\s*${IDENT}\\s*:\\s*${words.name}\\s*,(?:[^{}()\\[\\]]*?,)?\\s*\\.\\.\\.[\\w$]`,
  ].join('|'), 'g')
  const lookup = lookups.length ? new RegExp(`\\b(?:${lookups.map(escapeRe).join('|')})\\s*\\(\\s*${operand}\\s*[,)]`, 'g') : null
  return { comparison, rederivation, lookup }
}

const matches = (code: string, re: RegExp | null): number => (re ? (code.match(re) ?? []).length : 0)

/** The CLI flags, variables and paths in `text`, a file of the remote helper. */
function remoteCliTermsIn(text: string): number {
  const code = codeOf(text, isCliWord)
  const flags = /['"`]--[A-Za-z][\w-]*(?:=[^'"`\n]*)?['"`]/g
  const variables = new RegExp(`(?<![\\w$])(?:${CLI_VARIABLE_HEADS})_[A-Z0-9_]*[A-Z0-9](?![\\w$])`, 'g')
  const paths = new RegExp(`['"\`][^'"\`\\n]*[/\\\\](?:${IDS})(?:\\.exe)?['"\`]`, 'g')
  return matches(code, flags) + matches(code, variables) + matches(code, paths)
}

/** The names `code` knows `name` by: `name` itself where it is imported as it
 *  is, and each name it is imported under (`import { name as other }`). */
function importedAs(code: string, name: string): string[] {
  const out: string[] = []
  for (const clause of code.matchAll(/\bimport\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const part of clause[1].split(',')) {
      const m = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part)
      if (m && m[1] === name) out.push(m[2] ?? m[1])
    }
  }
  return out
}

/** A constant some file exports, and which words it holds. */
interface Exported extends Known { file: string; words: 'names' | 'styles' }

/** All of one file's counts. `exported` are the constants files export; the
 *  ones it declares itself are found here. */
function countFile({ file, text }: Source, code: string, exported: readonly Exported[]): Counts {
  const imported = (words: Exported['words']): Known[] => exported
    .filter((e) => e.words === words && e.file !== file)
    .flatMap((e) => importedAs(code, e.name).map((name) => ({ name, kind: e.kind })))
  const lookups = [...LOOKUPS, ...LOOKUPS.flatMap((l) => importedAs(code, l))]
  const names = patterns(PROVIDER_NAMES, [...declaredIn(code), ...imported('names')], lookups)
  const styles = STYLES ? patterns(STYLES, [...declaredIn(code, STYLES), ...imported('styles')]) : null
  return {
    comparisons: matches(code, names.comparison),
    rederivations: matches(code, names.rederivation),
    lookups: matches(code, names.lookup),
    launchStyleTests: styles ? matches(code, styles.comparison) : 0,
    remoteCliTerms: file.startsWith(REMOTE_HELPER) ? remoteCliTermsIn(text) : 0,
  }
}

/** Every file of `counted` with its counts, whatever they are. `elsewhere`
 *  are files read for the constants they export and never counted. Pure. */
function countAll(counted: ReadonlyArray<Source>, elsewhere: ReadonlyArray<Source> = []): Array<{ file: string } & Counts> {
  const read = (s: Source): Source & { code: string } => ({ ...s, code: codeOf(s.text, isNameOrStyle) })
  const mine = counted.map(read)
  const exported: Exported[] = [...mine, ...elsewhere.map(read)].flatMap(({ file, code }) => [
    ...declaredIn(code).filter((d) => d.exported).map((d) => ({ file, name: d.name, kind: d.kind, words: 'names' as const })),
    ...(STYLES ? declaredIn(code, STYLES).filter((d) => d.exported).map((d) => ({ file, name: d.name, kind: d.kind, words: 'styles' as const })) : []),
  ])
  return mine.map((s) => ({ file: s.file, ...countFile(s, s.code, exported) }))
}

const holdsAny = (c: Counts): boolean => KINDS.some((k) => c[k] > 0)

/**
 * Every file of `counted` that holds a check, with its counts, in the order of
 * their names. `elsewhere` are files read for the constants they export and
 * never counted themselves. Pure: it reads the texts it is given.
 */
function scanTexts(counted: ReadonlyArray<Source>, elsewhere: ReadonlyArray<Source> = []): Array<{ file: string } & Counts> {
  return countAll(counted, elsewhere).filter(holdsAny).sort((a, b) => (a.file < b.file ? -1 : 1))
}

/** The counts of one file's text, by itself (`file` says where it is). */
const countIn = (text: string, file = 'src/main/a.ts'): Counts => {
  const { file: _file, ...counts } = countAll([{ file, text }])[0]
  return counts
}

/** `sources` split into the files counted and the ones only read. */
function select(sources: ReadonlyArray<Source>): { counted: Source[]; elsewhere: Source[] } {
  return { counted: sources.filter((s) => isCounted(s.file)), elsewhere: sources.filter((s) => !isCounted(s.file)) }
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Every file in scope that holds a check, with its counts. */
function scan(): Array<{ file: string } & Counts> {
  const sources = SCOPES.flatMap((dir) => sourceFiles(join(ROOT, ...dir.split('/'))))
    .map((full) => ({ file: relative(ROOT, full).split(sep).join('/'), text: readFileSync(full, 'utf8') }))
  const { counted, elsewhere } = select(sources)
  return scanTexts(counted, elsewhere)
}

/** Everything that is off its ceiling, one line each; none when every file is on its own. */
function problems(found: ReadonlyArray<{ file: string } & Counts>, ceiling: Readonly<Record<string, Partial<Counts>>>): string[] {
  const out: string[] = []
  const seen = new Set(found.map((f) => f.file))
  for (const f of found) {
    const allowed = Object.hasOwn(ceiling, f.file) ? ceiling[f.file] : undefined
    for (const kind of KINDS) {
      const { what, instead } = KIND_TEXT[kind]
      const cap = allowed?.[kind] ?? 0
      if (!allowed) { if (f[kind] > 0) out.push(`${f.file}: ${f[kind]} ${what}, and it had none: ${instead}`); continue }
      if (f[kind] > cap) out.push(`${f.file}: ${f[kind]} ${what}, and its ceiling is ${cap}: ${instead}`)
      if (f[kind] < cap) out.push(`${f.file}: ${f[kind]} ${what}, and its ceiling is ${cap}: ${f[kind] ? `lower its ceiling to ${f[kind]}` : `take "${kind}" out of its line`}`)
    }
  }
  for (const file of Object.keys(ceiling)) {
    if (!seen.has(file)) out.push(`${file}: no provider-name check is left in it: take it out of the ceilings`)
  }
  return out
}

const sum = (rows: ReadonlyArray<Partial<Counts>>): Counts => rows.reduce<Counts>((t, r) => {
  const next = { ...t }
  for (const k of KINDS) next[k] += r[k] ?? 0
  return next
}, { ...NONE })

/** One file's line in the ceilings file: the counts it holds. */
const heldOf = (c: Counts): Partial<Counts> => Object.fromEntries(KINDS.filter((k) => c[k] > 0).map((k) => [k, c[k]]))

describe('provider-name checks in src outside the provider packages, file by file', () => {
  const found = scan()

  it('the scan reads src/main, src/renderer, src/shared and src/preload, and leaves each provider package out', () => {
    expect(found.length).toBeGreaterThan(0)
    expect(found.filter((f) => LEFT_OUT.some((l) => f.file.startsWith(l)))).toEqual([])
    expect(found.every((f) => isCounted(f.file))).toBe(true)
    for (const scope of ['src/main/', 'src/renderer/', 'src/shared/']) expect(found.some((f) => f.file.startsWith(scope)), scope).toBe(true)
    expect(Object.keys(CEILING).filter((file) => !isCounted(file))).toEqual([])
    // Each provider's renderer package is left out by its id, and the
    // renderer's provider core is not a package: it is counted.
    expect(LEFT_OUT).toEqual(['src/main/providers/', ...PROVIDER_IDS.map((id) => `src/renderer/providers/${id}/`)])
    expect(isCounted('src/renderer/providers/core/registry.ts')).toBe(true)
  })

  it('the lookups, the launch styles and the CLI names are read from the code, not written here', () => {
    expect(LOOKUPS).toEqual(expect.arrayContaining(['getProvider', 'tryGetProvider', 'getProviderPackage', 'tryGetProviderPackage', 'getRendererProvider', 'tryGetRendererProvider']))
    expect(STYLE_WORDS.length, `LocalLaunchStyle is no longer on one line of ${STYLE_SOURCE}: read its words again, or take the launch-style count out if the styles are gone`).toBeGreaterThan(0)
    for (const id of PROVIDER_IDS) expect(isCliWord(`/usr/local/bin/${id}`), id).toBe(true)
  })

  it('no file is above any of its ceilings, no file has gained its first check, and each ceiling follows its count down', () => {
    const off = problems(found, CEILING)
    const asTheyStand = JSON.stringify(Object.fromEntries(found.map(({ file, ...c }) => [file, heldOf(c)])), null, 2)
    expect(off, `${off.join('\n')}\n\nThe counts as they stand (${CEILINGS_FILE}, "files"):\n${asTheyStand}\n\nand their sums: ${JSON.stringify(sum(found))}`).toEqual([])
  })

  it('the ceilings file is well formed, and its numbers add up to the totals stated in it and here', () => {
    expect(ceilings.schema).toBe('provider-name-ceilings/2')
    for (const [file, counts] of Object.entries(CEILING)) {
      expect(Object.keys(counts).every((k) => (KINDS as readonly string[]).includes(k)), file).toBe(true)
      for (const n of Object.values(counts)) expect(Number.isInteger(n) && (n as number) > 0, `${file}: a count it holds is 1 or more; one it does not hold is left out`).toBe(true)
      expect(Object.keys(counts).length, `${file} holds no check: take it out`).toBeGreaterThan(0)
    }
    expect(sum(Object.values(CEILING))).toEqual(TOTAL)
    expect(ceilings.total).toEqual(TOTAL)
    expect(sum(found)).toEqual(TOTAL)
  })
})

describe('the new shapes and folders are counted', () => {
  const [first, second = first] = PROVIDER_IDS
  const [style] = STYLE_WORDS
  // One registry lookup by a name in a main file, one launch-style test in
  // another, one comparison in a renderer file and one CLI flag in the remote
  // helper: none of them is in the ceilings, so each is named.
  const fixture: Source[] = [
    { file: 'src/main/fixture-lookup.ts', text: `const p = getProvider('${first}')\n` },
    { file: 'src/main/fixture-style.ts', text: `if (launch.style === '${style}') start()\n` },
    { file: 'src/renderer/fixture-view.tsx', text: `export const View = ({ p }: Props) => (p === '${second}' ? <A /> : <B />)\n` },
    { file: 'src/shared/fixture-shared.ts', text: `export const kind = (id?: string) => id ?? '${first}'\n` },
    { file: 'src/main/remote-helper/fixture-launch.ts', text: `args.push('--fixture-flag')\n` },
    // Each provider's own package says its own name, and is not counted.
    ...PROVIDER_IDS.map((id) => ({ file: `src/renderer/providers/${id}/fixture.ts`, text: `if (p === '${id}') {}\n` })),
    { file: 'src/main/providers/fixture.ts', text: `const p = getProvider('${first}')\n` },
  ]

  it('a fixture with one of each, in a file the ceilings do not hold, fails the ceilings check once per file', () => {
    const { counted, elsewhere } = select(fixture)
    expect(problems(scanTexts(counted, elsewhere), {})).toEqual([
      `src/main/fixture-lookup.ts: 1 ${KIND_TEXT.lookups.what}, and it had none: ${KIND_TEXT.lookups.instead}`,
      `src/main/fixture-style.ts: 1 ${KIND_TEXT.launchStyleTests.what}, and it had none: ${KIND_TEXT.launchStyleTests.instead}`,
      `src/main/remote-helper/fixture-launch.ts: 1 ${KIND_TEXT.remoteCliTerms.what}, and it had none: ${KIND_TEXT.remoteCliTerms.instead}`,
      `src/renderer/fixture-view.tsx: 1 ${KIND_TEXT.comparisons.what}, and it had none: ${KIND_TEXT.comparisons.instead}`,
      `src/shared/fixture-shared.ts: 1 ${KIND_TEXT.rederivations.what}, and it had none: ${KIND_TEXT.rederivations.instead}`,
    ])
  })
})

describe('what the count sees, spelling by spelling', () => {
  const [first, second = first] = PROVIDER_IDS
  const ONE_COMPARISON: Counts = { ...NONE, comparisons: 1 }
  const ONE_DEFAULT: Counts = { ...NONE, rederivations: 1 }

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
    ['the name under satisfies in its own parentheses', `if (p === ('${second}' satisfies ProviderId)) {}`],
    ['the name under satisfies in its own parentheses, on the left', `if (('${first}' satisfies Kind) !== p) {}`],
    ['the name cast, on the left', `if ('${first}' as ProviderId === p) {}`],
    ['the name cast twice, on the left', `if ('${second}' as const satisfies core.ProviderId == p) {}`],
    ['a case label', `switch (p) { case '${first}': break }`],
    ['a case label, spaced and double-quoted', `switch (p) { case "${second}" : break }`],
    ['a case label under a cast', `switch (p) { case '${first}' as ProviderId: break }`],
    ['includes', `if (list.includes('${first}')) {}`],
    ['startsWith', `if (key.startsWith("${second}")) {}`],
    ['endsWith', `if (key.endsWith('${first}')) {}`],
    ['indexOf', `if (list.indexOf('${second}') >= 0) {}`],
    ['has', `if (set.has('${first}')) {}`],
    ['a list written in place, asked includes', `if (['${first}', '${second}'].includes(p)) {}`],
    ['a list written in place, asked indexOf', `if (["${second}"].indexOf(p) < 0) {}`],
    ['a list written in place and cast, asked includes', `if ((['${first}', '${second}'] as readonly string[]).includes(p)) {}`],
    ['a Set written in place, asked has', `if (new Set(['${first}', '${second}']).has(p)) {}`],
    ['a named constant, compared', `const THE_ID: Kind = '${second}'\nfind((p) => p.providerId === THE_ID)`],
    ['a named constant, on the left', `export const THE_ID = '${first}' as const\nif (THE_ID !== id) {}`],
    ['a named constant under satisfies, compared', `const THE_ID = '${first}' satisfies ProviderId\nif (id === THE_ID) {}`],
    ['a named constant as a case label', `const THE_ID = '${first}'\nswitch (p) { case THE_ID: break }`],
    ['a named constant handed to includes', `const THE_ID = "${second}"\nif (list.includes(THE_ID)) {}`],
    ['a named constant with a comment after it', `const THE_ID = '${first}' // the default\nif (p === THE_ID) {}`],
    ['a list kept in a constant, asked includes', `const KNOWN = ['${first}', '${second}'] as const\nif (KNOWN.includes(p)) {}`],
    ['a list kept in a constant, asked indexOf', `export const KNOWN: readonly string[] = ["${second}"]\nif (KNOWN.indexOf(p) < 0) {}`],
    ['a list kept in a typed constant, cast where it is asked', `const KNOWN: readonly Kind[] = ['${first}', '${second}']\nif ((KNOWN as readonly string[]).includes(p)) {}`],
    ['a Set kept in a constant, asked has', `const KNOWN = new Set<string>(['${first}', '${second}'])\nif (KNOWN.has(p)) {}`],
    ['inside the braces of a template literal', `const s = \`a \${p === '${first}' ? 1 : 2} b\``],
    ['after a string that holds two slashes', `const u = 'http://host/path'; if (p === '${first}') {}`],
    ['after a regular expression that holds a quote', `const q = /['"\`]/.test(s); if (p === '${second}') {}`],
    ['after a regular expression that holds two slashes in a class', `const q = s.replace(/[//]+/g, ''); if (p === '${first}') {}`],
    ['after a division, with a comment that holds a slash after it', `const half = n / 2; if (p === '${first}') {} // one / two`],
    ['after a comment that holds a quote', `// it isn't\nif (p === '${second}') {}`],
    ['between two block comments', `/* a */ if (p === '${first}') {} /* b */`],
  ])('a comparison: %s', (_what, text) => {
    expect(countIn(text)).toEqual(ONE_COMPARISON)
  })

  it('two comparisons on one line are two, and a defaulted id that is then compared is one of each', () => {
    expect(countIn(`if (p == '${first}' || p != '${second}') {}`).comparisons).toBe(2)
    expect(countIn(`const a = (x ?? '${first}') === '${second}' ? 1 : 2`)).toEqual({ ...NONE, comparisons: 1, rederivations: 1 })
  })

  it('a renderer file and a shared file are read the same, JSX and all', () => {
    expect(countIn(`export const Row = ({ p }: Props) => <span>{p === '${first}' ? 'A' : 'B'}</span>`, 'src/renderer/components/Row.tsx')).toEqual(ONE_COMPARISON)
    expect(countIn(`export const pick = (id?: Kind) => id ?? '${second}'`, 'src/shared/pick.ts')).toEqual(ONE_DEFAULT)
  })

  it.each<[string, string]>([
    ['?? after a member', `const a = options?.provider ?? '${first}'`],
    ['?? after a plain identifier, double quotes', `const b = launchProvider ?? "${first}"`],
    ['?? after any identifier, whatever it is called', `const c = kind ?? '${second}'`],
    ['?? after a call', `const d = pick() ?? '${first}'`],
    ['?? after an index', `const e = list[0] ?? '${second}'`],
    ['?? and a template literal', `const f = id ?? \`${first}\``],
    ['?? and the name in its own parentheses', `const g = id ?? ('${first}')`],
    ['?? and the name under satisfies in its own parentheses', `const g = id ?? ('${second}' satisfies ProviderId)`],
    ['||', `const h = id || '${second}'`],
    ['??=', `id ??= '${first}'`],
    ['||=', `id ||= '${second}'`],
    ['a default parameter', `function start(provider = '${first}') {}`],
    ['a default parameter with a type', `function hold(win: Win, agent: '${first}' | '${second}' | null = '${first}'): void {}`],
    ['a default parameter under a cast', `function start(provider = '${second}' as ProviderId) {}`],
    ['a default parameter of an arrow function', `const run = (id: string, subject: Kind = '${second}') => id`],
    ['a constructor parameter', `class A { constructor(private readonly id: Kind = '${first}') {} }`],
    ['a destructured field', `const { provider = '${second}' } = options`],
    ['a destructured parameter', `function open({ cwd, provider = '${first}' }: Options) {}`],
    ['a conditional that gives back what it asked about', `const a = id ? id : '${first}'`],
    ['the same over a chain of members', `const a = options?.provider ? options?.provider : "${second}"`],
    ['the same asked whether it is undefined', `const a = id !== undefined ? id : '${first}'`],
    ['the same asked whether it is null, loosely', `const a = opts.provider != null ? opts.provider : '${second}'`],
    ['a conditional turned round, asked whether it is undefined', `const a = opts.provider === undefined ? '${first}' : opts.provider`],
    ['a conditional turned round, asked whether it is null, loosely', `const a = id == null ? ('${second}') : id`],
    ['a conditional turned round with a not', `const a = !id ? '${first}' : id`],
    ['a name set before a spread', `const o = { provider: '${first}', ...options }`],
    ['a name set before a spread, with other fields between', `start({ cwd, provider: "${second}", cols: 80, ...rest })`],
    ['a name set before a spread, over lines', `const o = {\n  provider: '${first}',\n  cwd,\n  ...options,\n}`],
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
    ['a lookup in a table by name', `const p = table.get('${first}')`],
    ['a longer word that begins with a name', `if (p === '${first}-code') {}`],
    ['a longer word that ends with a name', `if (p === 'not-${second}') {}`],
    ['an id defaulted to something that is not a name', `const a = id ?? fallback`],
    ['an ordering test', `if (p >= '${first}') {}`],
    ['a named constant that is only passed', `const THE_ID = '${first}'\nstart(THE_ID)`],
    ['a constant that is not at the start of a line', `function f() {\n  const local = '${second}'\n  return x === local\n}`],
    ['another file\'s constant, not imported here', `if (p === THE_ID) {}`],
    ['a comparison in a line comment', `// if (p === '${first}') {}`],
    ['a comparison in a comment after code', `start() // p === '${second}'`],
    ['a comparison in a block comment', `/* p === '${first}' */ start()`],
    ['a comparison and a default in a comment over lines', `/**\n * p === '${first}'\n * id ?? '${second}'\n */\nstart()`],
    ['a default in a line comment', `// const a = id ?? '${first}'`],
    ['a named constant declared in a comment', `// const THE_ID = '${first}'\nif (p === THE_ID) {}`],
    ['a comparison written inside a string', `log("p === '${first}'")`],
    ['a default written inside a string', `log('id ?? "${second}"')`],
    ['a comparison written inside a template literal', `const script = \`if (p === '${first}') {}\``],
    ['a comparison written inside a template literal, beside its braces', `const script = \`\${indent}if (p === "${second}") {}\${end}\``],
    ['a comment written inside a string, and nothing after it', `const u = '// p === x'`],
    ['a comparison on the second line of a string carried over a line break', `log('one \\\nif (p === "${first}") {}')`],
    ['the same in a file whose lines end in a return and a line feed', `log('one \\\r\nif (p === "${second}") {}')`],
    ['a conditional over two different things', `const a = cond ? id : '${first}'`],
    ['a conditional that asks the type', `const a = typeof id === 'string' ? id : '${second}'`],
    ['a conditional that asks about a call', `const a = pick() ? pick() : '${first}'`],
    ['a conditional whose other arm is a longer chain', `const a = id ? id.kind : '${second}'`],
    ['a name set after a spread', `const o = { ...options, provider: '${first}' }`],
    ['a name set before a spread in other braces', `const o = { provider: '${second}', nested: { ...options } }`],
    ['a name set before a list that spreads', `const o = { provider: '${first}', all: [...list] }`],
    ['a name set before a call that spreads', `const o = { provider: '${second}', made: make(...parts) }`],
    ['a default handed to Object.assign', `const o = Object.assign({ provider: '${first}' }, options)`],
    ['a list of names kept in a constant that is only passed', `const KNOWN = ['${first}', '${second}']\nstart(KNOWN)`],
    ['a list kept in a constant that is not at the start of a line', `function f() {\n  const local = ['${first}']\n  return local.includes(x)\n}`],
    ['a list written over lines, asked includes', `const hit = [\n  '${first}',\n  '${second}',\n].includes(p)`],
    ['a list built from something else, asked includes', `const KNOWN = Object.keys(ROWS)\nif (KNOWN.includes(p)) {}`],
    ['another file\'s list, not imported here', `if (KNOWN.includes(p)) {}`],
    ['a name cast to a generic type, on the left', `if ('${first}' as Id<Kind> === p) {}`],
  ])('not counted: %s', (_what, text) => {
    expect(countIn(text)).toEqual(NONE)
  })
})

describe('registry lookups by a name, launch-style tests and the remote helper\'s CLI words, spelling by spelling', () => {
  const [first, second = first] = PROVIDER_IDS
  const [style, otherStyle = style] = STYLE_WORDS
  const ONE_LOOKUP: Counts = { ...NONE, lookups: 1 }
  const ONE_STYLE_TEST: Counts = { ...NONE, launchStyleTests: 1 }
  const REMOTE = `${REMOTE_HELPER}launch.ts`

  it.each<[string, string]>([
    ['getProvider', `const p = getProvider('${first}')`],
    ['tryGetProvider, then a member', `tryGetProvider("${second}")?.warm?.()`],
    ['getProviderPackage, a template literal', `const pkg = getProviderPackage(\`${first}\`)`],
    ['tryGetProviderPackage, then a member', `const r = tryGetProviderPackage('${second}')?.review`],
    ['the renderer\'s getRendererProvider', `const d = getRendererProvider('${first}')`],
    ['the renderer\'s tryGetRendererProvider', `const d = tryGetRendererProvider('${second}')`],
    ['a lookup reached as a member', `const p = registry.getProvider('${first}')`],
    ['a lookup over lines', `const p = getProvider(\n  '${second}',\n)`],
    ['a name cast where it is handed in', `const p = getProvider('${first}' as ProviderId)`],
    ['a name in its own parentheses', `const p = getProvider(('${second}'))`],
    ['a named constant handed in', `const THE_ID = '${first}'\nconst p = tryGetProvider(THE_ID)`],
    ['a lookup imported under another name', `import { getProvider as providerFor } from './providers'\nconst p = providerFor('${second}')`],
  ])('a registry lookup by a name: %s', (_what, text) => {
    expect(countIn(text)).toEqual(ONE_LOOKUP)
  })

  it.each<[string, string]>([
    ['a lookup by the session\'s own id', `const p = getProvider(session.providerId)`],
    ['a loop over the registered providers', `for (const { call } of providerMembers(['sweep'])) call()`],
    ['a lookup in a comment', `// getProvider('${first}').deploy()`],
    ['a lookup written inside a string', `log("getProvider('${second}')")`],
    ['another function whose name ends in a lookup\'s', `forgetProvider('${first}')`],
    ['another function whose name begins with a lookup\'s', `getProviderLabel('${second}')`],
    ['another call that takes a provider id', `realmEnvForProvider('${first}', env, patch)`],
  ])('not a lookup: %s', (_what, text) => {
    expect(countIn(text).lookups).toBe(0)
  })

  it('an id defaulted to a name and handed to a lookup is a default, not a lookup', () => {
    expect(countIn(`const p = getProvider(id ?? '${first}')`)).toEqual({ ...NONE, rederivations: 1 })
  })

  it.each<[string, string]>([
    ['a member compared with a style', `if (launch.style === '${style}') {}`],
    ['an optional member, turned round', `if ('${otherStyle}' !== localLaunch?.style) {}`],
    ['a style in a constant of its own', `const LAUNCH = '${style}'\nconst launchedSo = b.style === LAUNCH`],
    ['a case label', `switch (style) { case '${otherStyle}': break }`],
    ['a list of styles asked includes', `if (['${style}'].includes(s)) {}`],
  ])('a launch-style test: %s', (_what, text) => {
    expect(countIn(text)).toEqual(ONE_STYLE_TEST)
  })

  it.each<[string, string]>([
    ['a style assigned', `const s: LocalLaunchStyle = '${style}'`],
    ['a row of styles', `const ROWS = Object.freeze({ ${first}: '${otherStyle}', ${second}: '${style}' })`],
    ['a style in a comment', `// launch.style === '${style}'`],
    ['a longer word that begins with a style', `if (s === '${style}ory') {}`],
  ])('not a launch-style test: %s', (_what, text) => {
    expect(countIn(text)).toEqual(NONE)
  })

  it.each<[string, string, number]>([
    ['a long flag', `args.push('--effort', level)`, 1],
    ['a long flag in double quotes, with its value after =', `args.push("--model=opus")`, 1],
    ['two flags on one line', `args.push('--permission-mode', mode, '--continue')`, 2],
    ['a CLI variable set as a member', `env.${first.toUpperCase()}_CODE_DISABLE_MOUSE = '1'`, 1],
    ['a CLI variable named in a string', `env['${second.toUpperCase()}_HOME'] = home`, 1],
    ['a path that ends in a provider\'s CLI', `const cli = m.cliPath ?? '/usr/local/bin/${first}'`, 1],
  ])('a CLI word in the remote helper: %s', (_what, text, n) => {
    expect(countIn(text, REMOTE)).toEqual({ ...NONE, remoteCliTerms: n })
    // Outside the remote helper the same text is not this count's.
    expect(countIn(text).remoteCliTerms).toBe(0)
  })

  it.each<[string, string]>([
    ['the end of options', `args.push('-p', String(port), '--', host)`],
    ['a flag inside a command line', `const probe = 'command -v ${first} --version'`],
    ['a flag built in a template literal', `args.push(\`--model=\${model}\`)`],
    ['a flag in a comment', `// --effort is the CLI's`],
    ['the machine record\'s field', `const p = m.${first}Path`],
    ['a terminal\'s own variable', `env.COLORFGBG = value`],
    ['a path to another program', `const sh = '/bin/sh'`],
    ['a path that only begins with a provider\'s CLI name', `const p = '/usr/local/bin/${first}-helper'`],
  ])('not a CLI word in the remote helper: %s', (_what, text) => {
    expect(countIn(text, REMOTE)).toEqual(NONE)
  })
})

describe('what is matched is code alone', () => {
  const [first, second = first] = PROVIDER_IDS

  it('a comment is blanked and every line keeps its place', () => {
    expect(codeOf(`a // b\n/* c\nd */ e`)).toBe(`a     \n    \n     e`)
    expect(codeOf(`a // b\r\nc`)).toBe(`a     \r\nc`)
  })

  it('a string that is a provider name stays, in any of the three quotes; the text of any other is blanked', () => {
    expect(codeOf(`['${first}', "${second}", \`${first}\`]`)).toBe(`['${first}', "${second}", \`${first}\`]`)
    expect(codeOf(`f('x ${first}', "it's", \`\${a}-${second}\`)`)).toBe(`f('${' '.repeat(first.length + 2)}', "    ", \`\${a}${' '.repeat(second.length + 1)}\`)`)
  })

  it('a string carried over a line break by a backslash is one string, whichever way the line ends', () => {
    for (const eol of ['\n', '\r\n']) {
      expect(codeOf(`const s = 'a \\${eol}p === x'; q() // r`), JSON.stringify(eol)).toBe(`const s = '   ${eol}       '; q()     `)
    }
  })

  it('a template literal inside the braces of another is stepped through, and the code after both is code', () => {
    const text = `const s = \`a \${ok ? \`b \${c} d\` : { e: 1 }.e} f\` // g`
    expect(codeOf(text)).toBe(`const s = \`  \${ok ? \`  \${c}  \` : { e: 1 }.e}  \`     `)
  })

  it('a regular expression is left as it is, and a division is not taken for one', () => {
    expect(codeOf(`x.replace(/\\/\\/[^/'"]*$/, '') // y`)).toBe(`x.replace(/\\/\\/[^/'"]*$/, '')     `)
    expect(codeOf(`const r = a / b / c // d`)).toBe(`const r = a / b / c     `)
    expect(codeOf(`const r = (a + b) / 2 + list[0] / 3 + i++ / 4 // d`)).toBe(`const r = (a + b) / 2 + list[0] / 3 + i++ / 4     `)
    expect(codeOf(`if (!/^'/.test(s)) return /"/ // e`)).toBe(`if (!/^'/.test(s)) return /"/     `)
  })
})

describe('a constant one file exports, in the files that import it', () => {
  const [first, second = first] = PROVIDER_IDS
  const exporter: Source = {
    file: 'src/main/ids.ts',
    text: `export const THE_ID = '${first}'\nexport const KNOWN = ['${first}', '${second}'] as const\nconst KEPT_HERE = '${second}'\n`,
  }
  const scanWith = (...importers: Source[]): Array<{ file: string } & Counts> => scanTexts([exporter, ...importers])
  const comparisons = (file: string, n = 1): { file: string } & Counts => ({ file, ...NONE, comparisons: n })

  it('the file that only declares them holds no check', () => {
    expect(scanTexts([exporter])).toEqual([])
  })

  it('a file that imports the constant by name and compares with it is counted', () => {
    const importer = { file: 'src/main/by-name.ts', text: `import { other, THE_ID } from './ids'\nif (p === THE_ID) {}` }
    expect(scanWith(importer)).toEqual([comparisons('src/main/by-name.ts')])
  })

  it('an import written over lines, with a type beside it, is read the same', () => {
    const importer = { file: 'src/main/over-lines.ts', text: `import {\n  type Kind,\n  THE_ID,\n} from './ids'\nswitch (p) { case THE_ID: break }` }
    expect(scanWith(importer)).toEqual([comparisons('src/main/over-lines.ts')])
  })

  it('a file that does not import it is not counted, though it uses the same word', () => {
    const stranger = { file: 'src/main/stranger.ts', text: `const THE_ID = pick()\nif (p === THE_ID) {}` }
    expect(scanWith(stranger)).toEqual([])
  })

  it('a file whose import of it is in a comment is not counted', () => {
    const commented = { file: 'src/main/commented.ts', text: `// import { THE_ID } from './ids'\nif (p === THE_ID) {}` }
    expect(scanWith(commented)).toEqual([])
  })

  // One import under another name, in two files that each compare with one
  // of the two words, so each word is held by itself: in one file together, a
  // scan that took the constant by the name it was exported under, and not by
  // the one this file knows it by, would count one comparison all the same.
  const UNDER_ANOTHER_NAME = `import { THE_ID as DEFAULT_ID } from './ids'`

  it('a file that imports it under another name is counted where it compares with that name', () => {
    const byItsNameHere = { file: 'src/main/aliased.ts', text: `${UNDER_ANOTHER_NAME}\nif (p === DEFAULT_ID) {}` }
    expect(scanWith(byItsNameHere)).toEqual([comparisons('src/main/aliased.ts')])
  })

  it('and is not counted where it compares with the name the constant was exported under, which is no name of it there', () => {
    const byItsFirstName = { file: 'src/main/aliased-first-name.ts', text: `${UNDER_ANOTHER_NAME}\nif (q === THE_ID) {}` }
    expect(scanWith(byItsFirstName)).toEqual([])
  })

  it('a list another file exports is counted where it is asked, by name or under another, and not by its first name where it is imported under another', () => {
    const byName = { file: 'src/main/list-by-name.ts', text: `import { KNOWN } from './ids'\nif (KNOWN.includes(p)) {}` }
    const aliased = { file: 'src/main/list-aliased.ts', text: `import { KNOWN as ALL } from './ids'\nif ((ALL as readonly string[]).indexOf(p) < 0) {}` }
    const byItsFirstName = { file: 'src/main/list-aliased-first-name.ts', text: `import { KNOWN as ALL } from './ids'\nif (KNOWN.includes(p)) {}` }
    expect(scanWith(byName, aliased, byItsFirstName)).toEqual([comparisons('src/main/list-aliased.ts'), comparisons('src/main/list-by-name.ts')])
  })

  it('a constant the other file keeps to itself is not counted in a file that names it', () => {
    const importer = { file: 'src/main/kept.ts', text: `import { KEPT_HERE } from './ids'\nif (p === KEPT_HERE) {}` }
    expect(scanWith(importer)).toEqual([])
  })

  it('a constant reached through a namespace import is not counted', () => {
    const namespaced = { file: 'src/main/namespaced.ts', text: `import * as ids from './ids'\nif (p === ids.THE_ID) {}` }
    expect(scanWith(namespaced)).toEqual([])
  })

  it('the file that declares a constant is counted where it compares with it', () => {
    const both = { file: 'src/main/both.ts', text: `export const HERE = "${second}"\nif (p !== HERE) {}\nconst a = id ?? '${first}'` }
    const importer = { file: 'src/main/after.ts', text: `import { HERE } from './both'\nif (HERE === p) {}` }
    expect(scanTexts([importer, both])).toEqual([
      comparisons('src/main/after.ts'),
      { file: 'src/main/both.ts', ...NONE, comparisons: 1, rederivations: 1 },
    ])
  })

  it('a constant exported from a file that is read but not counted is counted in the file that imports it, and handed to a lookup', () => {
    const elsewhere: Source = { file: 'src/main/providers/ids.ts', text: `export const SHARED_ID = '${first}'\nif (p === SHARED_ID) {}` }
    const importer = { file: 'src/renderer/uses-shared.ts', text: `import { SHARED_ID } from '../main/providers/ids'\nif (p === SHARED_ID) {}\nconst d = getRendererProvider(SHARED_ID)` }
    expect(scanTexts([importer], [elsewhere])).toEqual([{ file: 'src/renderer/uses-shared.ts', ...NONE, comparisons: 1, lookups: 1 }])
    // Without that file the word is not known to be a name.
    expect(scanTexts([importer])).toEqual([])
  })

  it('a launch style kept in a constant another file exports is counted where it is compared', () => {
    const [style] = STYLE_WORDS
    const exporting: Source = { file: 'src/main/styles.ts', text: `export const THE_STYLE = '${style}'\n` }
    const importer = { file: 'src/main/uses-style.ts', text: `import { THE_STYLE } from './styles'\nif (launch.style === THE_STYLE) {}` }
    expect(scanTexts([exporting, importer])).toEqual([{ file: 'src/main/uses-style.ts', ...NONE, launchStyleTests: 1 }])
  })
})

describe('what a file off its ceiling is told', () => {
  const files = [{ file: 'src/main/a.ts', ...NONE, comparisons: 2 }, { file: 'src/main/b.ts', ...NONE, comparisons: 1, rederivations: 4 }]
  const onIt = { 'src/main/a.ts': { comparisons: 2 }, 'src/main/b.ts': { comparisons: 1, rederivations: 4 } }

  it('every file on its own ceiling: nothing', () => {
    expect(problems(files, onIt)).toEqual([])
  })

  it('a file above a ceiling is named with both numbers and told what to do', () => {
    expect(problems(files, { ...onIt, 'src/main/b.ts': { comparisons: 1, rederivations: 3 } }))
      .toEqual(['src/main/b.ts: 4 ids defaulted to a provider name, and its ceiling is 3: use the provider registry instead of a new name check'])
  })

  it('a check added in one file is not hidden by one removed in another: both files are named', () => {
    const moved = [{ file: 'src/main/a.ts', ...NONE, comparisons: 1 }, { file: 'src/main/b.ts', ...NONE, comparisons: 2, rederivations: 4 }]
    expect(sum(moved)).toEqual(sum(files))
    expect(problems(moved, onIt)).toEqual([
      'src/main/a.ts: 1 comparisons with a provider name, and its ceiling is 2: lower its ceiling to 1',
      'src/main/b.ts: 2 comparisons with a provider name, and its ceiling is 1: use the provider registry instead of a new name check',
    ])
  })

  it('a file that had no check and has one now is named, once for each count it holds', () => {
    expect(problems([...files, { file: 'src/main/c.ts', ...NONE, comparisons: 1, lookups: 2 }], onIt)).toEqual([
      'src/main/c.ts: 1 comparisons with a provider name, and it had none: use the provider registry instead of a new name check',
      `src/main/c.ts: 2 registry lookups by a provider name, and it had none: ${KIND_TEXT.lookups.instead}`,
    ])
  })

  it('a file that gains its first of a count it did not hold is named with a ceiling of none', () => {
    expect(problems([{ ...files[0], launchStyleTests: 1 }, files[1]], onIt))
      .toEqual([`src/main/a.ts: 1 launch styles compared with a style, and its ceiling is 0: ${KIND_TEXT.launchStyleTests.instead}`])
  })

  it('a file below a ceiling is told its new number, a count that reached none is to be taken out of its line, and a file with no check left is to be taken out', () => {
    expect(problems([files[1]], { ...onIt, 'src/main/b.ts': { comparisons: 3, rederivations: 4, lookups: 1 } })).toEqual([
      'src/main/b.ts: 1 comparisons with a provider name, and its ceiling is 3: lower its ceiling to 1',
      'src/main/b.ts: 0 registry lookups by a provider name, and its ceiling is 1: take "lookups" out of its line',
      'src/main/a.ts: no provider-name check is left in it: take it out of the ceilings',
    ])
  })
})
