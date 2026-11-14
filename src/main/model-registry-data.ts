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
//    resolves to. A shipped model's patterns and aliases are always the
//    bundled file's (the file's are left out; its label, prices and other
//    fields are used), and a name is tried against the shipped entries, in
//    the bundled file's order, before a model only the file has
//    (mergeModelData here, matchEntry in model-registry.ts). So a model the
//    file adds is its exact id and its aliases, and beyond those only a name
//    nothing shipped places;
//  - and a model the build does not ship takes no name the bundled file
//    alone gives to one of its own entries: its ID is refused only when
//    the bundled file places it by an exact id or an alias (a shipped
//    name), so an id reached by an id-prefix or a pattern
//    (`claude-fable-5-3`, `claude-opus-6`) is free, which is how a new model
//    is added; each ALIAS is refused when the bundled file places it by an
//    exact id or an alias, or by an id-prefix or a pattern when the alias
//    does not start with the model's own id. An alias that does
//    (`claude-fable-5-3-20270101`, `claude-fable-5-3[1m]`) is the model's own
//    name, and one nothing places is free. A refused name refuses the whole
//    file, and the log names the shipped entry;
//  - a pattern is plain text (literalPattern), matched as text. Nothing in
//    the file is ever compiled into a regular expression.
//
// Pure: no file, no network. model-registry-remote.ts reads the file and
// model-registry-service.ts puts it to use.
import { z } from 'zod'
import {
  familyProvider, followsModelPickerRule, literalPattern, resolveModelInfo,
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

/** The shipped entry that has `id` as its exact id or one of its aliases. An id
 *  the bundled file only reaches by an id-prefix or a pattern (`claude-fable-5-3`
 *  is reached through `claude-fable-5`) is a new model's own name. */
function idHeldBy(bundled: ModelRegistry, id: string): string | undefined {
  const at = placedBy(bundled, id)
  return at && (at.kind === 'exact' || at.kind === 'alias') ? at.id : undefined
}

/** The shipped entry that stops `alias` being the alias of the model `own`: one
 *  that has it as an exact id or an alias, or one the bundled file reaches it
 *  on by an id-prefix or a pattern when it does not start with `own`'s id. An
 *  alias that starts with its model's id (`claude-fable-5-3-20270101`,
 *  `claude-fable-5-3[1m]`) is that model's own name; one nothing places is free. */
function aliasHeldBy(bundled: ModelRegistry, alias: string, own: string): string | undefined {
  const at = placedBy(bundled, alias)
  if (!at) return undefined
  if (at.kind === 'exact' || at.kind === 'alias') return at.id
  return alias.startsWith(own) ? undefined : at.id
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
    // file's (as mergeRegistry holds an overlay to).
    const base = shipped.get(m.id)
    if (base && familyProvider(base.family) !== familyProvider(m.family)) return refuse(`models: ${m.id} is moved to the other assistant`)
    // An entry that is only the start of a name would take the label and the
    // price of every model not listed yet. What the bundled file itself has
    // (its catch-all entry, its short pattern) is the build's own and stays.
    if (!base && !isFullModelName(m.id, m.family)) return refuse(`models: ${m.id} is not a full model name of its family`)
    // A model the build does not ship takes no name the bundled file alone
    // gives to one of its own entries. Its ID is refused only when that is an
    // exact id or an alias (a shipped name): an id the bundled file reaches by
    // an id-prefix or a pattern (`claude-fable-5-3`, `claude-opus-6`) is how a
    // new model is added. Each ALIAS is refused when the bundled file places it
    // by an exact id or alias, or by an id-prefix or a pattern when it does not
    // start with the model's own id; one that does is the model's own name, and
    // one nothing places is free. Exact ids and aliases are looked up first
    // (matchEntry), so a refused name would leave the shipped entry for the new one.
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
 *    refusing it would lock this build out of every later file. And the
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
    const kept: ModelEntry = { ...rest, patterns: base.patterns }
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
