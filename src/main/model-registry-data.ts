// Model definitions as data (2.1.3-beta.1): the rules a model file read from
// the network must pass before the app uses it, and how it joins the file
// shipped with the build.
//
// The file is text from outside the app. It reaches both model pickers, the
// cost figures, and (a picked model's id or alias) a `/model <value>` line
// typed into a live session, so every part of it is held to a strict shape:
//
//  - only the fields the bundled file (resources/model-registry.json) has;
//    an unknown field anywhere refuses the whole file;
//  - every string bounded and plain (no control or hidden character); ids,
//    aliases, families, efforts and picker values from a small alphabet that
//    cannot read as a flag or carry a second line; a colour only a theme
//    variable or a six-digit hex, never anything a style could load;
//  - numbers finite and in range (a price at most 1000 per million tokens);
//  - a format version, so an older app ignores a format it does not know
//    (the format is in the file's name too: model-registry-remote.ts);
//  - a revision, so a file older than the build's own is never used
//    (model-registry-service.ts);
//  - a model the build does not ship has a full name (its family and a
//    version), and a new pattern is at least four characters: an entry that
//    is only the start of a name would match every model not listed yet;
//  - a model the build does not ship has no pattern the bundled file already
//    has on one of its own entries (`opus`): it is after the names that
//    entry stands for, and cannot have them (the next rule), so it is a
//    mistake in the file and the log says so;
//  - THE RULE: a file never changes what a name the build already places
//    resolves to. A shipped model's patterns, aliases and family are always
//    the bundled file's (the file's are left out; its label, prices and other
//    fields are used), and a name is tried against the shipped entries, in
//    the bundled file's order, before a model only the file has
//    (mergeModelData here, matchEntry in model-registry.ts). So a model the
//    file adds is its exact id and its aliases, and beyond those only a name
//    nothing shipped places;
//  - and a model the build does not ship takes no name the bundled file
//    alone gives to one of its own entries: its ID is refused when the
//    bundled file places it by an exact id or an alias (a shipped name), so
//    an id reached by an id-prefix or a pattern (`claude-fable-5-3`,
//    `claude-opus-6`) is free, which is how a new model is added; each ALIAS
//    is refused when the bundled file places it by an exact id or an alias,
//    or by an id-prefix or a pattern when the alias does not start with the
//    model's own id, or when it does but the shipped entry's id starts with
//    the model's own id as well (`claude-opus-4` does not own
//    `claude-opus-4-7[1m]`). An alias that is the model's own
//    (`claude-fable-5-3-20270101`, `claude-fable-5-3[1m]`) is its name, and
//    one nothing places is free. In every case, the id and every alias, a
//    dated (`-YYYYMMDD`) or bracketed (`[1m]`) form of a shipped entry's id
//    is that shipped entry's name and refused (`claude-opus-4-5-20260101`,
//    `gpt-5.5-20260101`), though the bundled file only reaches it by an
//    id-prefix. And a name is read as the matcher reads it against the ids,
//    as written and with each dot between two digits as a hyphen
//    (2.1.3-beta.3): a shipped id written with a dot (`claude-opus-5.5`), or a
//    dated or bracketed form of it (`claude-opus-4.7-20260101`), is that
//    shipped entry's name and refused as the same name written with a hyphen
//    is. An alias is held against its model's own id in the same two
//    readings, so that id written the other way is the model's own name
//    (`claude-opus-5.7` on `claude-opus-5-7`), and the shipped id is held
//    against the model's in them too (`gpt-5-5` does not own `gpt-5.5-x`).
//    For an alias the shipped ids are read with a dot as a hyphen as well,
//    which the matcher never does, so a shipped model's name written with a
//    hyphen for its dot is held for that model too (`gpt-5.6` does not own
//    `gpt-5-6-sol`, nor `gpt-5-5` `gpt-5-5-x`). A refused name refuses the
//    whole file, and the log names the shipped entry;
//  - a pattern is plain text (literalPattern), matched as text. Nothing in
//    the file is ever compiled into a regular expression.
//
// Pure: no file, no network. model-registry-remote.ts reads the file and
// model-registry-service.ts puts it to use.
import { z } from 'zod'
import {
  dotsAsHyphens, familyProvider, followsModelPickerRule, literalPattern, longestIdNameStartsWith, resolveModelInfo,
  type EffortLevelSpec, type ModelEntry, type ModelMatchKind, type ModelProvider, type ModelRegistry, type OverlayModelEntry,
} from '../shared/model-registry'
import { stripSpoofableText } from '../shared/safe-text'

/** The format this version reads. A file with a higher one is ignored. It is
 *  part of the file's name as well (MODEL_DATA_URL), so a later format is
 *  published beside this one and never in its place. */
export const MODEL_DATA_FORMAT = 1

/** A price is per million tokens. No model costs near this. */
export const MODEL_DATA_MAX_PRICE = 1000
/** A pattern the bundled entry does not already have is at least this long. */
export const MODEL_DATA_MIN_PATTERN = 4

const ID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/
/** An alias or picker value: an id's alphabet plus the brackets of `opus[1m]`. */
const ALIAS_RE = /^[a-z0-9][a-z0-9.[\]-]{0,63}$/
const FAMILY_RE = /^[a-z][a-z0-9-]{0,31}$/
const EFFORT_RE = /^[a-z][a-z0-9-]{0,23}$/
/** A theme variable or a six-digit hex: nothing a style could load or chain. */
const COLOR_RE = /^(?:var\(--[a-z][a-z0-9-]{0,47}\)|#[0-9a-fA-F]{6})$/

/** Text a person reads: bounded, with nothing hidden in it and no control
 *  character (stripSpoofableText leaves such a text as it is). */
const text = (max: number) => z.string().min(1).max(max).refine((s) => s.trim() === s && stripSpoofableText(s, max) === s, 'not plain text')

const price = z.number().min(0).max(MODEL_DATA_MAX_PRICE)
/** When the file was last edited, as a whole number that only grows (the
 *  date, YYYYMMDD). The build's own file carries one too. */
const revision = z.number().int().min(1).max(99999999)
const effortValue = z.string().regex(EFFORT_RE)
const color = z.string().regex(COLOR_RE)
const pickerValue = z.string().regex(ALIAS_RE)

const modelSchema = z.strictObject({
  id: z.string().regex(ID_RE),
  patterns: z.array(z.string().refine((p) => literalPattern(p) !== null, 'not a plain pattern')).max(8),
  aliases: z.array(pickerValue).max(8).optional(),
  family: z.string().regex(FAMILY_RE),
  label: text(64),
  efforts: z.array(effortValue).max(16).optional(),
  fallbackPricing: z.strictObject({ input: price, output: price, cacheRead: price, cacheWrite: price }).optional(),
  pickable: z.boolean().optional(),
  articleExempt: z.boolean().optional(),
})

const familySchema = z.strictObject({
  label: text(32),
  color,
  colorOverrides: z.strictObject({ agentPill: color }).optional(),
})

const effortLevels = z.array(z.strictObject({ value: effortValue, label: text(32), hint: text(160).optional() })).min(1).max(16)

const fileSchema = z.strictObject({
  formatVersion: z.literal(MODEL_DATA_FORMAT),
  revision,
  models: z.array(modelSchema).min(1).max(256),
  families: z.record(z.string().regex(FAMILY_RE), familySchema),
  effortLevels,
  providerEffortLevels: z.strictObject({ codex: effortLevels }),
  dropdown: z.array(z.strictObject({ value: pickerValue, label: text(32), hint: text(160).optional() })).max(32),
})

export type ModelDataResult = { ok: true; data: ModelRegistry; revision: number } | { ok: false; reason: string }

const refuse = (reason: string): ModelDataResult => ({ ok: false, reason: stripSpoofableText(reason, 160) })

/** The field names a reason may name. A key the file made up (a family's
 *  name, say) is never repeated: a reason ends in the log, and the last good
 *  copy is read from a folder the app does not own alone. */
const FIELD_NAMES = new Set([
  'formatVersion', 'revision', 'models', 'families', 'effortLevels', 'providerEffortLevels', 'dropdown', 'id', 'patterns', 'aliases', 'family',
  'label', 'efforts', 'fallbackPricing', 'input', 'output', 'cacheRead', 'cacheWrite', 'pickable', 'articleExempt', 'color',
  'colorOverrides', 'agentPill', 'value', 'hint',
])
const whereOf = (path: readonly PropertyKey[]): string =>
  path.map((p) => (typeof p === 'number' ? String(p) : FIELD_NAMES.has(String(p)) ? String(p) : '(a name)')).join('.') || 'file'

/** A key named `__proto__` anywhere in the file: JSON.parse makes it an own
 *  property, and a later spread or assign would make it a prototype. */
function hasProtoKey(v: unknown, depth = 0): boolean {
  if (!v || typeof v !== 'object' || depth > 8) return false
  if (Object.prototype.hasOwnProperty.call(v, '__proto__')) return true
  return Object.values(v as Record<string, unknown>).some((x) => hasProtoKey(x, depth + 1))
}

/** A model the build does not ship is named in full: a Claude Code model by
 *  its family and a version (`claude-fable-6`), any other by a name with a
 *  digit in it (`gpt-7`). A shorter id (`claude`, `gpt`) is the start of
 *  every later name, and a name is matched by the longest id it starts with. */
const FULL_MODEL_NAME: Record<ModelProvider, (id: string, family: string) => boolean> = {
  claude: (id, family) => {
    const start = `claude-${family}-`
    return id.startsWith(start) && /^[0-9]/.test(id.slice(start.length))
  },
  codex: (id) => /[0-9]/.test(id),
}
const isFullModelName = (id: string, family: string): boolean => FULL_MODEL_NAME[familyProvider(family)](id, family)

/** The shipped entry the bundled file alone places `name` on, with how: by its
 *  exact id, by one of its aliases, by the longest id `name` starts with (a
 *  dated id, `[1m]`), or by a pattern. Undefined when nothing places it. Asked
 *  of the matcher itself (resolveModelInfo), so the two cannot drift apart. */
function placedBy(bundled: ModelRegistry, name: string): { id: string; kind: ModelMatchKind } | undefined {
  const at = resolveModelInfo(bundled, name)
  return at.known && at.matchKind ? { id: at.id, kind: at.matchKind } : undefined
}

/** Whether `name` is the shipped id `shipped` with a date (`-YYYYMMDD...`) or a
 *  context size (`[1m]`) after it: that shipped model's own name. */
function isDatedOrBracketedForm(name: string, shipped: string): boolean {
  if (!name.startsWith(shipped)) return false
  const rest = name.slice(shipped.length)
  // The '[' branch is defence in depth: the picker rule may already refuse such a name.
  return /^-\d{8}/.test(rest) || rest.startsWith('[')
}

/** The shipped id `name` is a dated or bracketed form of, whichever entry the
 *  matcher placed it on: `claude-fable-5-20260101` is `claude-fable-5`'s, though
 *  it starts with `claude-fable-5-2` as well. (The matcher puts it on
 *  `claude-fable-5` too since 2.1.3-beta.3; this does not rest on that.)
 *
 *  This check and the one below it (dottedFormOfShipped) look at the shipped
 *  ids themselves. Where the build places a name is otherwise the matcher's
 *  answer (placedBy), so validation follows the matcher: when its rules
 *  change, what a file may carry changes with them. Two files changed sides
 *  with the matcher of 2.1.3-beta.3, and both are meant
 *  (tests/unit/model-data-schema.test.ts pins them). An id that ends in a
 *  digit is no longer the start of a name whose next character is a digit, so
 *  `gpt-5.55` is not `gpt-5.5`'s by an id-prefix and a new `gpt-5` may have it
 *  as an alias: refused before, taken now. And a name is read with each dot
 *  between two digits as a hyphen too, so `claude-opus-4.7` is
 *  `claude-opus-4-7`'s and a new `claude-opus-4` may not have it as an alias:
 *  taken before, refused now. */
function formOfShipped(bundled: ModelRegistry, name: string): string | undefined {
  return bundled.models.find((m) => isDatedOrBracketedForm(name, m.id))?.id
}

/** The shipped id `name` is when it is read the matcher's second way, with
 *  each dot between two digits as a hyphen (dotsAsHyphens, 2.1.3-beta.3):
 *  that id itself (`claude-opus-5.5` is `claude-opus-5-5`), or one it is a
 *  dated or bracketed form of (`claude-opus-4.7-20260101`,
 *  `claude-opus-4.7[1m]`). Undefined for a name with no such dot.
 *
 *  The matcher reads a name both ways against the ids
 *  (longestIdNameStartsWith), so it puts such a name on that shipped entry by
 *  an id match, which the app trusts for a label, a price and an effort list.
 *  The name is the shipped model's as the same name written with a hyphen is,
 *  and a new model is refused it in the same way. Only ids are read like
 *  this: the matcher takes an alias as it is written. */
function dottedFormOfShipped(bundled: ModelRegistry, name: string): string | undefined {
  const hyphened = dotsAsHyphens(name)
  if (hyphened === name) return undefined
  return bundled.models.find((m) => m.id === hyphened)?.id ?? formOfShipped(bundled, hyphened)
}

/** The shipped entry that has `id` as its exact id or one of its aliases, or
 *  whose id `id` is a dated or bracketed form of (of ANY shipped id, not only the
 *  one the matcher placed it on), or whose id `id` is, or is such a form of,
 *  when it is read with a dot as a hyphen (dottedFormOfShipped). An id the
 *  bundled file only reaches by an id-prefix or a pattern otherwise
 *  (`claude-fable-5-3` is reached through `claude-fable-5`) is a new model's
 *  own name. */
function idHeldBy(bundled: ModelRegistry, id: string): string | undefined {
  const form = formOfShipped(bundled, id)
  if (form) return form
  const at = placedBy(bundled, id)
  if (at && (at.kind === 'exact' || at.kind === 'alias')) return at.id
  return dottedFormOfShipped(bundled, id)
}

/** The shipped id that keeps `aliasAsRead` (an alias with each dot between two
 *  digits read as a hyphen, which starts with its model's id `own`) when the
 *  shipped ids are read that way as well.
 *
 *  The matcher does not read an id that way. It finds an id in a name as the
 *  id is written, and reads a dot in the name as a hyphen, never a hyphen as
 *  a dot. So a shipped id written with a dot (`gpt-5.6-sol`) is not found in
 *  the same name written with a hyphen: `gpt-5-6-sol` starts with no shipped
 *  id, and only the catch-all pattern places it. An alias that starts with
 *  its model's own id is let past a pattern, so without this check a new
 *  `gpt-5.6` or `gpt-5-6` has `gpt-5-6-sol`: the longer shipped model's name
 *  in the other spelling. Where a name goes is not changed here (`gpt-5-5`
 *  is still not `gpt-5.5`, and a new model may have it as its id); what a
 *  new model may list as an alias is.
 *
 *  The two rules that hold where the matcher does find a shipped id hold in
 *  this reading too:
 *   - a dated or bracketed form of a shipped id is that model's, however long
 *     `own` is: `gpt-5-5-20260101` is not `gpt-5.5-`'s;
 *   - of two ids that both start the alias, the shipped one keeps it unless
 *     `own` is longer: `gpt-5-6-sol` is not `gpt-5.6`'s and `gpt-5-5-x` is
 *     not `gpt-5-5`'s, while `gpt-5-5-pro` is `gpt-5.5-pro`'s. An id starts
 *     a name as the matcher has it (longestIdNameStartsWith), not where the
 *     number carries on: `gpt-5-55` is not held for `gpt-5.5`.
 *
 *  The second is asked only of a shipped id longer than the one the matcher
 *  found in the alias (`found`, its length: 0 when only a pattern placed the
 *  alias). The id the matcher did find is the caller's to hold against
 *  `own`, so each of the two checks answers for its own ids. */
function heldInHyphenSpelling(bundled: ModelRegistry, aliasAsRead: string, own: string, found: number): string | undefined {
  const shipped = bundled.models.map((m) => ({ id: m.id, asRead: dotsAsHyphens(m.id) }))
  const form = shipped.find((m) => isDatedOrBracketedForm(aliasAsRead, m.asRead))
  if (form) return form.id
  const start = longestIdNameStartsWith(aliasAsRead, shipped.map((m) => m.asRead))
  if (start.length <= found || start.length < own.length) return undefined
  return shipped.find((m) => m.asRead === start)?.id
}

/** The shipped entry that stops `alias` being the alias of the model `own`: one
 *  that has it as an exact id or an alias, or whose id it is a dated or
 *  bracketed form of, or whose id it is, or is such a form of, when it is
 *  read with a dot as a hyphen (dottedFormOfShipped), or one the bundled file
 *  reaches it on by an id-prefix or a pattern when it does not start with
 *  `own`'s id, or when it does but the shipped id starts with `own` too
 *  (`claude-opus-4-7[1m]` is not `claude-opus-4`'s). An alias that starts
 *  with its model's id (`claude-fable-5-3-20270101`, `claude-fable-5-3[1m]`)
 *  is that model's own name; one nothing places is free.
 *
 *  "Starts with" is asked as the matcher reads a name against the ids: of the
 *  two as they are written, and of the two read with each dot between two
 *  digits as a hyphen. So a model's own id written the other way is its own
 *  name too: `claude-opus-5.7` and `claude-opus-5.7-20270101` on
 *  `claude-opus-5-7`, `claude-opus-5-7` on `claude-opus-5.7`. Without that a
 *  new model in a shipped family could not be given the name a gateway writes
 *  for it: the name stayed on the older model whose id it starts with
 *  (`claude-opus-5`), by a match the app trusts.
 *
 *  And an alias that starts with `own` is held against the shipped ids read
 *  with a dot as a hyphen as well, which the matcher never does
 *  (heldInHyphenSpelling): `gpt-5-6-sol` is not a new `gpt-5.6`'s. */
function aliasHeldBy(bundled: ModelRegistry, alias: string, own: string): string | undefined {
  const form = formOfShipped(bundled, alias)
  if (form) return form
  const at = placedBy(bundled, alias)
  if (at && (at.kind === 'exact' || at.kind === 'alias')) return at.id
  const dotted = dottedFormOfShipped(bundled, alias)
  if (dotted) return dotted
  if (!at) return undefined
  const aliasAsRead = dotsAsHyphens(alias)
  if (!alias.startsWith(own) && !aliasAsRead.startsWith(dotsAsHyphens(own))) return at.id
  const spelled = heldInHyphenSpelling(bundled, aliasAsRead, own, at.kind === 'prefix' ? at.id.length : 0)
  if (spelled) return spelled
  // Whether the shipped id starts with `own` too is asked the same two ways,
  // of each of the three names. Of `own` as the alias reads it, for the
  // matcher may have found the shipped id in the alias read with a dot as a
  // hyphen: `claude-opus-4.8-f` in `claude-opus-4.8-fast-x` is
  // `claude-opus-4-8-f`, which the shipped `claude-opus-4-8-fast` starts
  // with. And of the shipped id read that way as well, for it may be written
  // with a dot where `own` has a hyphen: `gpt-5-5` does not own `gpt-5.5-x`,
  // which carries on from the shipped `gpt-5.5`. So of two ids that are both
  // a start of the alias, the shipped one keeps it unless `own` is longer.
  const ownAsRead = aliasAsRead.slice(0, own.length)
  const shippedStartsWithOwn = [at.id, dotsAsHyphens(at.id)].some((id) => id.startsWith(own) || id.startsWith(ownAsRead))
  return shippedStartsWithOwn ? at.id : undefined
}

/**
 * A parsed model file against the rules above. `bundled` is the file shipped
 * with the build: a model it carries stays with its own assistant.
 */
export function validateModelData(value: unknown, bundled: ModelRegistry): ModelDataResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse('not a model file')
  const version = (value as { formatVersion?: unknown }).formatVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return refuse('no format version')
  if (version > MODEL_DATA_FORMAT) return refuse(`format ${version} is newer than this version reads (${MODEL_DATA_FORMAT})`)
  if (hasProtoKey(value)) return refuse('a __proto__ key')
  const parsed = fileSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    // Where, and what kind of fault: never the file's own text.
    return refuse(`${whereOf(issue?.path ?? [])}: ${issue?.code ?? 'invalid'}`)
  }
  const { formatVersion: _format, revision: fileRevision, ...file } = parsed.data
  void _format
  if (Object.keys(file.families).length > 32) return refuse('families: too many')
  // Each assistant's own effort levels, by the provider a family belongs to.
  const { codex: otherLevels } = file.providerEffortLevels
  const effortsOf: Record<ModelProvider, Set<string>> = {
    claude: new Set(file.effortLevels.map((l) => l.value)),
    codex: new Set(otherLevels.map((l) => l.value)),
  }
  const shipped = new Map(bundled.models.map((m) => [m.id, m]))
  // Each pattern the bundled file has, by its text, and the entry it is on.
  const keptOn = new Map<string, string>()
  for (const b of bundled.models) {
    for (const p of b.patterns ?? []) {
      const kept = literalPattern(p)?.text
      if (kept && !keptOn.has(kept)) keptOn.set(kept, b.id)
    }
  }
  const seen = new Set<string>()
  for (const m of file.models) {
    if (seen.has(m.id)) return refuse(`models: ${m.id} is listed more than once`)
    seen.add(m.id)
    if (!Object.prototype.hasOwnProperty.call(file.families, m.family)) return refuse(`models: ${m.id} names a family the file does not define`)
    // An id or alias is what a picker hands to a launch or types into a
    // session, so it follows the rule of its family's own picker.
    const names = [m.id, ...(m.aliases ?? [])]
    for (const v of names) {
      if (!followsModelPickerRule(m.family, v)) return refuse(`models: ${m.id} has a name its picker does not take`)
    }
    const levels = effortsOf[familyProvider(m.family)]
    if ((m.efforts ?? []).some((e) => !levels.has(e))) return refuse(`models: ${m.id} lists an effort that is not one of its levels`)
    // Which assistant a shipped model belongs to is the code's, never a
    // file's (as mergeRegistry holds an overlay to). Another family of the
    // same assistant is not refused: mergeModelData leaves it out, as it
    // does a shipped model's patterns.
    const base = shipped.get(m.id)
    if (base && familyProvider(base.family) !== familyProvider(m.family)) return refuse(`models: ${m.id} is moved to the other assistant`)
    // An entry that is only the start of a name would take the label and the
    // price of every model not listed yet. What the bundled file itself has
    // (its catch-all entry, its short pattern) is the build's own and stays.
    if (!base && !isFullModelName(m.id, m.family)) return refuse(`models: ${m.id} is not a full model name of its family`)
    // A model the build does not ship takes no name the bundled file alone
    // gives to one of its own entries. Its ID is refused when that is an exact
    // id or an alias (a shipped name), or a dated or [1m] form of a shipped id:
    // an id the bundled file reaches by an id-prefix or a pattern otherwise
    // (`claude-fable-5-3`, `claude-opus-6`) is how a new model is added. Each
    // ALIAS is refused when the bundled file places it by an exact id or alias,
    // a dated or [1m] form of a shipped id, or by an id-prefix or a pattern when
    // it does not start with the model's own id (or the shipped id starts with
    // it too); one that is the model's own name, and one nothing places is free. Exact ids and aliases are looked up first
    // (matchEntry), so a refused name would leave the shipped entry for the new one.
    // The id and each alias are read as the matcher reads a name against the
    // ids, as written and with each dot between two digits as a hyphen: a
    // shipped id written with a dot, or a dated or [1m] form of it, is refused
    // as the same name written with a hyphen is (dottedFormOfShipped), and an
    // alias that is the model's own id written the other way is its own name
    // (aliasHeldBy). An alias is held against the shipped ids read with a dot
    // as a hyphen too: a shipped model's name written with a hyphen for its
    // dot is not a new model's (heldInHyphenSpelling).
    const holder = base ? undefined : [idHeldBy(bundled, m.id), ...(m.aliases ?? []).map((a) => aliasHeldBy(bundled, a, m.id))].find((id) => id !== undefined)
    if (holder) return refuse(`models: ${m.id} has a name the build already places on ${holder}`)
    const had = new Set(base?.patterns ?? [])
    for (const p of m.patterns) {
      const patternText = literalPattern(p)?.text ?? ''
      if (!had.has(p) && patternText.length < MODEL_DATA_MIN_PATTERN) return refuse(`models: ${m.id} has a pattern too short to add`)
      // A model the build does not ship that carries a pattern the build has
      // on one of its own entries (the family's `opus`, with or without `^`)
      // is after the label and the price of every name that entry stands
      // for. It could not have them (a shipped entry is tried first, see
      // mergeModelData), so it is a mistake in the file, and it is said.
      const keeper = base ? undefined : keptOn.get(patternText)
      if (keeper) return refuse(`models: ${m.id} has a pattern the build already has on ${keeper}`)
    }
  }
  return { ok: true, data: file as ModelRegistry, revision: fileRevision }
}

/** A model file's text against the rules above. */
export function parseModelData(text: string, bundled: ModelRegistry): ModelDataResult {
  let value: unknown
  try { value = JSON.parse(text) } catch { return refuse('not JSON') }
  return validateModelData(value, bundled)
}

/** A validated model file as the text kept for the next start. */
export function modelDataText(data: ModelRegistry, revision: number): string {
  return JSON.stringify({ formatVersion: MODEL_DATA_FORMAT, revision, ...data }, null, 2)
}

/** The file's rows first, in its order, then the bundled rows it does not
 *  have: a row can be added or corrected, never taken away. */
function joinByValue<T extends { value: string }>(file: readonly T[], bundled: readonly T[]): T[] {
  const has = new Set(file.map((x) => x.value))
  return [...file, ...bundled.filter((x) => !has.has(x.value))]
}

/**
 * The bundled file with a validated model file joined to it: the baseline
 * every reader's list is built from (the user's overlay still goes on top).
 *
 *  - The file's models come first, in its order, and win for an id both
 *    carry; a model only the bundled file carries stays, after them. So the
 *    file can add a model and correct one, and can never take one away.
 *  - A file never changes what a name the build already places resolves to.
 *    A shipped model's patterns and aliases are the bundled file's, whatever
 *    the file gives it (an entry the bundled file gives no aliases has
 *    none). They are left out, not refused: a file edited for a later
 *    build may well have other patterns on a model this build ships, and
 *    refusing it would lock this build out of every later file. Its family
 *    is the bundled file's in the same way: a name placed by a pattern goes
 *    to an entry of the family its first match is in (matchByPrefixOrPattern),
 *    so a shipped model given another family would be passed over there, and
 *    the names its own pattern places would go to another entry. And the
 *    result carries the bundled file's own order (`shippedOrder`, in memory
 *    only), which a name is placed by, a model only the file has being
 *    tried last (matchEntry). The order of `models`, which is the pickers',
 *    is still the file's.
 *  - Whether a model the bundled file carries is offered in a picker is the
 *    bundled file's to say (`pickable`), so the file cannot hide one, nor
 *    offer the catch-all entry that is not a model.
 *  - A model the bundled file does not carry is marked as added from the
 *    model data (`provenance`, as an overlay entry is): the model list
 *    shipped with this build cannot name it, so it is never reported as
 *    possibly retired (evaluateModelCoverage).
 *  - Families, each assistant's effort levels and the picker's alias rows
 *    join the same way, by name: the file adds and corrects, and what only
 *    the bundled file has stays. So no file can empty a picker.
 *
 * `date`: when the file was read (YYYY-MM-DD). The result is read-only, as
 * mergeRegistry's is.
 */
export function mergeModelData(bundled: ModelRegistry, data: ModelRegistry | null, date: string): ModelRegistry {
  if (!data) return bundled
  const shipped = new Map(bundled.models.map((m) => [m.id, m]))
  const fetched = new Set(data.models.map((m) => m.id))
  const added = (m: ModelEntry): OverlayModelEntry => ({ ...m, provenance: { addedBy: 'model-data', date } })
  const corrected = (m: ModelEntry, base: ModelEntry): ModelEntry => {
    const { pickable: _theirs, aliases: _names, ...rest } = m
    void _theirs; void _names
    const kept: ModelEntry = { ...rest, patterns: base.patterns, family: base.family }
    if (base.aliases !== undefined) kept.aliases = base.aliases
    return base.pickable === undefined ? kept : { ...kept, pickable: base.pickable }
  }
  const otherLevels: Record<string, EffortLevelSpec[]> = { ...(bundled.providerEffortLevels ?? {}) }
  for (const [provider, levels] of Object.entries(data.providerEffortLevels ?? {})) {
    otherLevels[provider] = joinByValue(levels, bundled.providerEffortLevels?.[provider] ?? [])
  }
  return {
    models: [
      ...data.models.map((m) => { const base = shipped.get(m.id); return base ? corrected(m, base) : added(m) }),
      ...bundled.models.filter((m) => !fetched.has(m.id)),
    ],
    families: { ...bundled.families, ...data.families },
    effortLevels: joinByValue(data.effortLevels, bundled.effortLevels),
    providerEffortLevels: otherLevels,
    dropdown: joinByValue(data.dropdown, bundled.dropdown),
    shippedOrder: bundled.models.map((m) => m.id),
  }
}
