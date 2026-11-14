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
//  - a pattern is plain text (literalPattern), matched as text. Nothing in
//    the file is ever compiled into a regular expression.
//
// Pure: no file, no network. model-registry-remote.ts reads the file and
// model-registry-service.ts puts it to use.
import { z } from 'zod'
import {
  familyProvider, followsModelPickerRule, literalPattern,
  type EffortLevelSpec, type ModelEntry, type ModelProvider, type ModelRegistry, type OverlayModelEntry,
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
  const seen = new Set<string>()
  for (const m of file.models) {
    if (seen.has(m.id)) return refuse(`models: ${m.id} is listed more than once`)
    seen.add(m.id)
    if (!Object.prototype.hasOwnProperty.call(file.families, m.family)) return refuse(`models: ${m.id} names a family the file does not define`)
    // An id or alias is what a picker hands to a launch or types into a
    // session, so it follows the rule of its family's own picker.
    for (const v of [m.id, ...(m.aliases ?? [])]) {
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
    const had = new Set(base?.patterns ?? [])
    for (const p of m.patterns) {
      if (!had.has(p) && (literalPattern(p)?.text.length ?? 0) < MODEL_DATA_MIN_PATTERN) return refuse(`models: ${m.id} has a pattern too short to add`)
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
    const { pickable: _theirs, ...rest } = m
    void _theirs
    return base.pickable === undefined ? rest : { ...rest, pickable: base.pickable }
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
  }
}
