// Model/effort registry — single source of truth for model identity (spec:
// docs/superpowers/specs/2026-06-11-ccc-sentinel-design.md §4). Pure data +
// pure functions only: both processes hold their own snapshot (main
// authoritative, renderer hydrated via IPC). No Node imports here.

export interface ModelPricingSpec { input: number; output: number; cacheRead: number; cacheWrite: number }

export interface FamilySpec {
  label: string                              // short chart form ("opus")
  color: string                              // default colour token/hex
  colorOverrides?: Record<string, string>    // per-surface, e.g. { agentPill: 'var(--status-success)' }
}

export interface ModelEntry {
  id: string                                 // REQUIRED canonical model id — merge/reconcile key
  patterns: string[]                         // matched (case-insensitive substring-or-regex) against raw model ids
  aliases?: string[]                         // exact CLI alias values ('opus', 'opus[1m]')
  family: string                             // must exist in families{}
  label: string                              // pretty per-model label ("Opus 4.8")
  color?: string                             // optional per-model override of families[family].color
  efforts?: string[]
  fallbackPricing?: ModelPricingSpec
  /** false = never offer this entry as a pinned model-picker row (#385). For
   *  catch-all entries whose `id` is not a launchable model id (`codex-family`).
   *  Absent means pickable, so a Sentinel/user overlay entry shows up in both
   *  pickers with no code change. */
  pickable?: boolean
  /** true = we carry this model deliberately even though Anthropic's Claude Code
   *  model-configuration article does not list it, so neither the release gate
   *  nor the Sentinel check reports it as possibly-retired (#385). */
  articleExempt?: boolean
}

export interface OverlayProvenance {
  /** `model-data` (2.1.3-beta.1): not an overlay entry at all, but a model the
   *  fetched model file carries and this build's own file does not
   *  (mergeModelData, main). It is marked the same way because the same thing
   *  is true of it: the lists shipped with this build cannot name it. */
  addedBy: 'sentinel' | 'user' | 'model-data'
  date: string
  ccVersion?: string
  cccVersion?: string
  reason?: string
}
export interface OverlayModelEntry extends ModelEntry { provenance: OverlayProvenance }

export interface EffortLevelSpec { value: string; label: string; hint?: string }
export interface DropdownOptionSpec { value: string; label: string; hint?: string }

export interface ModelRegistry {
  models: ModelEntry[]
  families: Record<string, FamilySpec>
  /** Claude Code's effort levels. */
  effortLevels: EffortLevelSpec[]
  /** Another provider's effort levels, by provider id (P3.8, row 40: `codex`).
   *  Top-level on purpose: mergeRegistry never takes it from an overlay. */
  providerEffortLevels?: Record<string, EffortLevelSpec[]>
  /** Ordered ALIAS rows ("Opus 1M" → 'opus[1m]'). These are the family aliases
   *  that always follow the newest model; the pinned per-version rows are
   *  DERIVED from `models` by buildModelPickerRows() (#385) so a Sentinel or
   *  user overlay entry reaches both pickers without a code change. */
  dropdown: DropdownOptionSpec[]
  /** The ids of the models the build ships, in the bundled file's order
   *  (2.1.3-beta.1). Set in memory by mergeModelData (main) when model data
   *  is in use, and never part of a file: `models` is then in the fetched
   *  file's order, which is the pickers', and matchEntry places a name by this
   *  order instead, so a fetched file cannot change it. */
  shippedOrder?: string[]
  /** Set in memory by withInstalledCodexModels when the Codex models are the
   *  installed Codex's own list (aicc_planning#362): the version that printed
   *  it. Never part of a file: withInstalledCodexModels sets or clears it on
   *  every registry the app's readers get. */
  installedCodex?: { version: string }
}

export interface RegistryOverlay {
  models?: OverlayModelEntry[]
  families?: Record<string, FamilySpec>
}

/**
 * Merge an overlay (sentinel/user additions) into the static baseline registry.
 * Merged snapshots are READ-ONLY: nested arrays/objects alias the static baseline
 * import; mutating a snapshot would corrupt the baseline for all later merges.
 */
export function mergeRegistry(baseline: ModelRegistry, overlay: RegistryOverlay | null): ModelRegistry {
  if (!overlay) return { ...baseline, models: [...baseline.models], families: { ...baseline.families } }
  const byId = new Map<string, ModelEntry>(baseline.models.map((m) => [m.id, m]))
  const shipped = new Map<string, ModelEntry>(baseline.models.map((m) => [m.id, m]))
  for (const o of overlay.models ?? []) {
    // P3.8 round 1 (R1): which provider a shipped model belongs to is the
    // code's, not an overlay's. An overlay entry that would move a shipped id
    // to the other provider (a Codex id into a Claude family, a Claude id
    // into the codex family) is ignored; the shipped entry stays.
    const base = o ? shipped.get(o.id) : undefined
    if (base && familyProvider(base.family) !== familyProvider(o.family)) continue
    byId.set(o.id, o)
  }
  return {
    ...baseline,
    models: [...byId.values()],
    families: { ...baseline.families, ...(overlay.families ?? {}) },
  }
}

export interface ReconcileResult {
  overlay: RegistryOverlay                   // overlay after auto-retire
  autoRetired: OverlayModelEntry[]           // sentinel entries the new baseline now covers
  retireProposals: OverlayModelEntry[]       // user entries the new baseline now covers (never auto-removed)
}

/**
 * First launch after a CCC update: a new baseline "rectifies" overlay entries it now covers (spec §4).
 * Callers must pass a loaded (possibly-empty) overlay, never null.
 */
export function reconcileOverlay(baseline: ModelRegistry, overlay: RegistryOverlay): ReconcileResult {
  const baseIds = new Set(baseline.models.map((m) => m.id))
  const kept: OverlayModelEntry[] = []
  const autoRetired: OverlayModelEntry[] = []
  const retireProposals: OverlayModelEntry[] = []
  for (const o of overlay.models ?? []) {
    if (!baseIds.has(o.id)) { kept.push(o); continue }
    if (o.provenance.addedBy === 'sentinel') autoRetired.push(o)
    else { kept.push(o); retireProposals.push(o) }
  }
  return { overlay: { ...overlay, models: kept }, autoRetired, retireProposals }
}

// ── Resolution ──

export interface ResolvedModelInfo {
  known: boolean
  id: string                                 // matched entry id, or the raw input when unknown
  family: string | null
  label: string                              // entry label, or verbatim input when unknown
  chartLabel: string                         // families[family].label, or verbatim input
  /** HOW the entry matched. exact/alias/prefix are version-faithful (safe to
   *  show the entry's versioned label); pattern is a fuzzy family catch-all
   *  (an old claude-opus-4-5 hits the "opus" pattern on the 4.8 entry — its
   *  label would claim the wrong version). null when unknown. */
  matchKind: ModelMatchKind | null
  colors: { default: string; chart: string; agentPill: string }
  efforts: string[] | null                   // null = unknown → callers assume all valid (spec §3)
  fallbackPricing?: ModelPricingSpec
}

// Dedicated unknown-model palette (spec §3): hex hues distinct from the 5 chart
// tokens — copper stays Opus-only (modelColors.ts:4-5). Hash pattern mirrors
// identity-colors.ts (stable key, deterministic pick).
const UNKNOWN_MODEL_PALETTE = ['#9a8cf0', '#3ba8d4', '#34b39a', '#9bbf4e', '#e8794a', '#ef5f7e'] as const

export function hashUnknownModelColor(modelId: string): string {
  let h = 0
  for (let i = 0; i < modelId.length; i++) h = (h * 31 + modelId.charCodeAt(i)) >>> 0
  return UNKNOWN_MODEL_PALETTE[h % UNKNOWN_MODEL_PALETTE.length]
}

export type ModelMatchKind = 'exact' | 'alias' | 'prefix' | 'pattern'

/** A pattern that is plain text: lower-case letters, digits, dots and
 *  hyphens, at most 64 of them, with an optional leading `^` meaning "the
 *  name starts with this". */
const LITERAL_PATTERN_RE = /^(\^?)([a-z0-9][a-z0-9.-]{0,63})$/

/**
 * A pattern as plain text, or null when it is not one (2.1.3-beta.1).
 *
 * One rule, two readers, so they cannot drift apart: the check on a fetched
 * model file admits only patterns this returns non-null for
 * (model-registry-data.ts), and matchEntry matches every such pattern as
 * text. So nothing from a fetched file is ever compiled into a regular
 * expression. Every pattern in the bundled file is of this form too.
 */
export function literalPattern(p: unknown): { text: string; atStart: boolean } | null {
  const m = typeof p === 'string' ? LITERAL_PATTERN_RE.exec(p) : null
  return m ? { text: m[2], atStart: m[1] === '^' } : null
}

/**
 * Entries this matcher will consider: those with a usable string `id`.
 *
 * `registry-overlay.json` is a hand-editable user file and validateProposal runs
 * on APPLY, not on load, so an entry that satisfies none of `ModelEntry` reaches
 * here intact — as does an entry that is legitimately alias-only (id + aliases,
 * no `patterns`), which is a shape a user may reasonably write. Neither may
 * throw: resolvePickedModelId() runs on EVERY render of the session status strip
 * with a statusline-supplied model name, so one bad entry — or one model name
 * the registry cannot place — used to take the whole footer down with a
 * `TypeError: m.patterns is not iterable` (ADR-009 MAJOR-2 on #404).
 */
export function usableEntries(registry: ModelRegistry): ModelEntry[] {
  return (registry?.models ?? []).filter(
    (m): m is ModelEntry => !!m && typeof m.id === 'string' && m.id.length > 0,
  )
}

/** A model only the fetched model file has: mergeModelData (main) marks it. */
function isModelDataEntry(m: ModelEntry): boolean {
  return (m as Partial<OverlayModelEntry>).provenance?.addedBy === 'model-data'
}

/**
 * The entries a name is tried against when it is no entry's id or alias, as
 * two lists: the first is tried in full before the second (2.1.3-beta.1),
 * but for a name that is the own id, in another form, of a model in the
 * second (matchByOwnForm, 2.1.3-beta.4).
 *
 * The rule: a fetched model file never changes what a name the build already
 * places resolves to, beyond the names that are a new model's own. So the
 * second list is the models only the fetched file has, and the first is
 * every other entry: the shipped ones in the bundled file's order
 * (`shippedOrder`; the fetched file's own order is the pickers', not this
 * one's), then the user's and Sentinel's own additions in list order, which
 * is where they stand without model data. With no model data in use the
 * first list is `models` as it is (no order is given, and the sort below is
 * stable, so it moves nothing).
 */
function entriesByStanding(registry: ModelRegistry, models: ModelEntry[]): [ModelEntry[], ModelEntry[]] {
  const order = Array.isArray(registry?.shippedOrder) ? registry.shippedOrder : []
  const rank = new Map<string, number>(order.map((id, i) => [id, i]))
  // An entry the order does not name comes after every one it names; entries
  // of the same rank keep list order (Array.prototype.sort is stable).
  const at = (m: ModelEntry): number => rank.get(m.id) ?? rank.size
  const standing = models.filter((m) => !isModelDataEntry(m)).sort((a, b) => at(a) - at(b))
  return [standing, models.filter(isModelDataEntry)]
}

function matchEntry(
  registry: ModelRegistry,
  modelId: string,
): { entry: ModelEntry; kind: ModelMatchKind } | null {
  const raw = typeof modelId === 'string' ? modelId.trim() : ''
  if (!raw) return null
  const models = usableEntries(registry)
  // 1. exact id
  const exact = models.find((m) => m.id === raw)
  if (exact) return { entry: exact, kind: 'exact' }
  // 2. exact alias (CLI alias values like 'opus', 'opus[1m]').
  //    Array.isArray, not `?.includes`: a hand-edited overlay whose `aliases` is
  //    a bare STRING would otherwise substring-match via String.prototype.includes.
  const alias = models.find((m) => Array.isArray(m.aliases) && m.aliases.includes(raw))
  if (alias) return { entry: alias, kind: 'alias' }
  // 3 and 4, first over every entry that is not the fetched model file's own
  // addition. Such an addition places a name none of those does, and, ahead
  // of their patterns, a name that is its own id in another form
  // (matchByOwnForm). A name a standing id starts is never looked at again.
  const [standing, added] = entriesByStanding(registry, models)
  const byStandingId = matchByIdStart(standing, raw)
  if (byStandingId) return byStandingId
  const byStandingPattern = matchByPattern(standing, raw)
  return matchByOwnForm(added, standing, raw, byStandingPattern?.entry ?? null)
    ?? byStandingPattern
    ?? matchByIdStart(added, raw)
    ?? matchByPattern(added, raw)
}

/**
 * Whether a model name starts with an id as an id, not only as text
 * (2.1.3-beta.3). An id that ends in a digit is not the start of a name whose
 * next character is a digit too: the number carries on there, so it is
 * another number. `claude-fable-5-2` is the start of
 * `claude-fable-5-20260101`, the dated id of Fable 5, and is not its model:
 * that name was shown, and priced, as Fable 5.2.
 */
function nameStartsWithId(name: string, id: string): boolean {
  if (!name.startsWith(id)) return false
  return !(/\d/.test(id.charAt(id.length - 1)) && /\d/.test(name.charAt(id.length)))
}

/** A name with each dot between two digits read as a hyphen:
 *  `claude-opus-5.5` as `claude-opus-5-5`, `anthropic/claude-opus-4.7` as
 *  `anthropic/claude-opus-4-7`. The name as it is when it has no such dot: a
 *  dot with a letter on either side is not a version's (`claude-opus-4-8.fast`
 *  is not `claude-opus-4-8-fast`). The result is as long as the name.
 *  Exported for the check on a fetched model file (model-registry-data.ts),
 *  which reads a new model's names the same two ways. */
export function dotsAsHyphens(name: string): string {
  return name.replace(/(\d)\.(?=\d)/g, '$1-')
}

/** The longest of `ids` that one reading of a name starts with as an id, or ''. */
function longestIdOfReading(reading: string, ids: readonly string[]): string {
  let best = ''
  for (const id of ids) {
    if (id.length > best.length && nameStartsWithId(reading, id)) best = id
  }
  return best
}

/**
 * The longest of `ids` a model name starts with as an id (nameStartsWithId),
 * or '' when it starts with none (2.1.3-beta.3).
 *
 * The name is read two ways, as the pattern step reads it (patternReach): as
 * written, and with each dot between two digits as a hyphen (dotsAsHyphens).
 * `claude-opus-5.5` as written starts with `claude-opus-5` alone (a dot
 * follows, not a digit), so it was Opus 5: shown, and priced, as the base
 * model, by a match every reader trusts. Read as `claude-opus-5-5` it starts
 * with `claude-opus-5-5` too, and the longest id takes it. So for the Claude
 * models the build ships, whose ids are all written with hyphens, a name
 * written with a dot goes to the entry the same name written with a hyphen
 * goes to.
 *
 * That holds for those models. A model only a fetched model file has is
 * tried after the ids of every standing entry (matchEntry), so a name a
 * standing id starts stays with that entry: with a fetched
 * `claude-opus-5-7`, `claude-opus-5.7` is still Opus 5's. (The file may list
 * that name as an alias of its model, and an alias is looked up before this
 * step: aliasHeldBy in model-registry-data.ts.) A name no standing id starts
 * is the fetched model's when it is that model's own id written this way,
 * ahead of a standing entry's pattern (matchByOwnForm): with a fetched
 * `claude-opus-6-1`, `claude-opus-6.1` is that model, not the entry with the
 * family's plain pattern. And an id that is itself written with a dot is not
 * the same id written with a hyphen (`gpt-5.5` is a model, `gpt-5-5` is
 * not).
 *
 * The longest id of either reading takes the name; of two as long, the one
 * the name as written starts with. An id is compared as it is written, so one
 * with a dot in it (`gpt-5.5`) is found in the name as written, as before,
 * and a hyphen is never read as a dot. A name with no dot between two digits
 * has one reading. So every name that had an id still has one, and only a
 * longer id takes it from the one it had.
 *
 * One rule for every reader that takes the longest id a name starts with:
 * the matcher below, and the two price-key lookups in Tokenomics
 * (toPriceModel in tk-parse.ts, normalizeModelForPricing in tk-pricing.ts).
 * So the three cannot disagree about where an id ends, or about a dot.
 */
export function longestIdNameStartsWith(name: string, ids: readonly string[]): string {
  const asWritten = longestIdOfReading(name, ids)
  const hyphened = dotsAsHyphens(name)
  if (hyphened === name) return asWritten
  const second = longestIdOfReading(hyphened, ids)
  return second.length > asWritten.length ? second : asWritten
}

/** Step 3: the entry of `models` with the longest id the name starts with. */
function matchByIdStart(
  models: ModelEntry[],
  raw: string,
): { entry: ModelEntry; kind: ModelMatchKind } | null {
  // 3. longest id-prefix (date-suffixed ids: claude-opus-4-7-20260101), the
  //    name read as written and with a dotted version as a hyphenated one
  //    (claude-opus-5.5). An id that stops inside a number is not one
  //    (longestIdNameStartsWith). Of entries with that id, the first.
  const id = longestIdNameStartsWith(raw, models.map((m) => m.id))
  const prefix = id ? models.find((m) => m.id === id) : undefined
  return prefix ? { entry: prefix, kind: 'prefix' } : null
}

/**
 * Whether `name` is `id` with a date (`-YYYYMMDD...`) or a context size
 * (`[1m]`) after it: that id's model under its own name.
 *
 * One rule, two readers: the check on a fetched model file refuses a new
 * model such a form of a shipped id (model-registry-data.ts), and the
 * matcher gives a model only the fetched file has such a form of its own id
 * (matchByOwnForm).
 */
export function isDatedOrBracketedForm(name: string, id: string): boolean {
  if (!name.startsWith(id)) return false
  const rest = name.slice(id.length)
  // The '[' branch is defence in depth: the picker rule may already refuse such a name.
  return /^-\d{8}/.test(rest) || rest.startsWith('[')
}

/**
 * Whether a standing entry keeps a name that is, in another form, the own id
 * `own` of a model only the fetched model file has (matchByOwnForm).
 * `hyphened` is the name with each dot between two digits as a hyphen;
 * `patternHit` the standing entry a pattern places the name on, if one does.
 *
 * The two holds are the ones the check on a fetched file applies to an
 * alias that starts with its model's own id (aliasHeldBy in
 * model-registry-data.ts), so the matcher gives a new model no name its
 * file could not have listed:
 *
 *  - The standing entry the pattern step places the name on has an id that
 *    starts with `own` too, as written or as the name reads it: the longer
 *    standing id keeps the name (`claude-haiku-5-20270101` stays where the
 *    build has it beside a fetched `claude-haiku-5`, because that is
 *    `claude-haiku-5-5`).
 *  - A standing id written with a dot, read with that dot as a hyphen, has
 *    the name: as a dated or bracketed form of it, or as an id at least as
 *    long as `own` that the name starts with. The id step never reads an id
 *    that way, so it did not find it: beside the shipped `gpt-5.5`, a
 *    fetched `gpt-5-5` is not given `gpt-5-5-20260101`. (A standing id with
 *    no such dot was the id step's to find, which comes first.)
 */
function standingKeepsName(hyphened: string, own: string, standing: ModelEntry[], patternHit: ModelEntry | null): boolean {
  if (patternHit) {
    const ownAsRead = hyphened.slice(0, own.length)
    for (const id of [patternHit.id, dotsAsHyphens(patternHit.id)]) {
      if (id.startsWith(own) || id.startsWith(ownAsRead)) return true
    }
  }
  for (const s of standing) {
    const spelled = dotsAsHyphens(s.id)
    if (spelled === s.id) continue
    if (isDatedOrBracketedForm(hyphened, spelled)) return true
    if (spelled.length >= own.length && nameStartsWithId(hyphened, spelled)) return true
  }
  return false
}

/**
 * Between the two halves of the standing list: the model only the fetched
 * model file has (`added`) whose own id the name is, in another form
 * (2.1.3-beta.4). Asked only of a name no standing id starts.
 *
 * Such a model was tried after every standing entry, patterns included. So
 * in a family the build ships, its dated id (`claude-opus-6-1-20270101`),
 * its id with a context size (`claude-opus-6-1[1m]`) and its id with the
 * version written with a dot (`claude-opus-6.1`) all went to the entry with
 * the family's plain pattern, by a pattern: the new model's own label, price
 * and effort list were not used for them, unless its file listed each of
 * those names as an alias.
 *
 * The forms are the ones a shipped id already has by the id step: the id
 * with a date or a context size after it (isDatedOrBracketedForm), the name
 * read as written or with each dot between two digits as a hyphen, and the
 * id itself in that second reading. Of two models, the one with the longer
 * id; of two as long, the one the name as written starts with. Nothing else
 * moves: a name that only starts with the id
 * (`claude-opus-6-1-fast`, a partner platform's `claude-opus-6-1@20270101`)
 * stays where it was, and so does every name a standing entry keeps
 * (standingKeepsName). The match is by an id, so it is one the app trusts
 * for a label, a price and an effort list, as a shipped model's dated id is.
 */
function matchByOwnForm(
  added: ModelEntry[],
  standing: ModelEntry[],
  raw: string,
  patternHit: ModelEntry | null,
): { entry: ModelEntry; kind: ModelMatchKind } | null {
  if (added.length === 0) return null
  const hyphened = dotsAsHyphens(raw)
  let best: ModelEntry | null = null
  // Whether `best` has the name as it is written, not only as it reads.
  let bestAsWritten = false
  for (const m of added) {
    const asWritten = isDatedOrBracketedForm(raw, m.id)
    if (!asWritten && hyphened !== m.id && !isDatedOrBracketedForm(hyphened, m.id)) continue
    // The longer id; of two as long, the one the name as written starts with
    // (the tie rule of longestIdNameStartsWith).
    if (best && (m.id.length < best.id.length || (m.id.length === best.id.length && (bestAsWritten || !asWritten)))) continue
    if (standingKeepsName(hyphened, m.id, standing, patternHit)) continue
    best = m
    bestAsWritten = asWritten
  }
  return best ? { entry: best, kind: 'prefix' } : null
}

/** Step 4: the entry of `models` whose pattern places the name. */
function matchByPattern(
  models: ModelEntry[],
  raw: string,
): { entry: ModelEntry; kind: ModelMatchKind } | null {
  // 4. first pattern match in the order given, as before: it settles the
  //    family the name is in, and whether the name is a shipped entry's or
  //    one of the user's or Sentinel's own. Then, among the entries of that
  //    family and that origin, the one whose match covers the most of the
  //    name takes it (patternReach). The tie-break: of entries that cover as
  //    much, the first in the order given.
  const lower = raw.toLowerCase()
  // The name read a second way, for a version written with a dot (patternReach).
  const hyphened = dotsAsHyphens(lower)
  let best: ModelEntry | null = null
  let bestReach = NO_PATTERN_HIT
  for (const m of models) {
    // Past the first match, only its own family and origin are looked at.
    // (A shipped entry's family is the bundled file's, whatever a fetched
    // model file gives it: mergeModelData, main.)
    if (best && (m.family !== best.family || isOverlaySourced(m) !== isOverlaySourced(best))) continue
    const reach = patternReach(m, lower, hyphened)
    if (reach > bestReach) { best = m; bestReach = reach }
  }
  return best ? { entry: best, kind: 'pattern' } : null
}

/** patternReach: none of the entry's patterns matches the name. */
const NO_PATTERN_HIT = -1

/** What follows a match that ends in a digit when the version number carries
 *  on past it: another digit (`5-2` then `0260101`), or a dot or a hyphen
 *  and one or two digits (`5` then `.5`, `5` then `-5`). A date, eight
 *  digits, is not a version: `opus-5` then `-20260101` is Opus 5. */
const VERSION_CARRIES_ON_RE = /^(?:\d|[.-]\d{1,2}(?!\d))/

/** Whether the text of `lower` that ends at `end` stops inside a version
 *  number, so that it names another version than the one it spells. */
function stopsInsideVersion(lower: string, end: number): boolean {
  return /\d/.test(lower.charAt(end - 1)) && VERSION_CARRIES_ON_RE.test(lower.slice(end))
}

/**
 * How much of a name (lower-cased) a text pattern covers: its length when it
 * is found there whole, 0 when every place it is found stops inside a version
 * number, NO_PATTERN_HIT when it is not found at all (which is exactly when
 * it did not match before). `atStart`: only the start of the name counts.
 */
function textReach(lower: string, text: string, atStart: boolean): number {
  if (atStart) {
    if (!lower.startsWith(text)) return NO_PATTERN_HIT
    return stopsInsideVersion(lower, text.length) ? 0 : text.length
  }
  let reach = NO_PATTERN_HIT
  for (let at = lower.indexOf(text); at !== -1; at = lower.indexOf(text, at + 1)) {
    if (!stopsInsideVersion(lower, at + text.length)) return text.length
    reach = 0
  }
  return reach
}

/**
 * How much of a name (lower-cased) an entry's patterns cover, or
 * NO_PATTERN_HIT when none of them matches it (2.1.3-beta.2).
 *
 * The first pattern to match, in the order given, used to place the name
 * outright. Each family's plain pattern (`opus`) sits on one entry, the
 * newest for most, so a partner platform's id of an older model
 * (`us.anthropic.claude-opus-4-7-v1:0`, which no id or id-prefix matches)
 * was placed on the newest and took its label and price, though the older
 * entry's own pattern (`opus-4-7`) matched too.
 *
 * The first match still says which family the name is in and whose it is, so
 * no name moves to another family, and an entry the user or Sentinel added
 * (one with a `provenance`) takes no name from a shipped entry, nor a shipped
 * entry one from it. Within that family and origin, the entry that covers the
 * most of the name now takes it (matchByPattern):
 *
 *  - A pattern that is text counts its length: a plain pattern, and one that
 *    is text but not plain (a capital, a space: a hand-edited overlay only).
 *  - But a pattern found only where the version number carries on after it
 *    counts 0: `opus-5` is in `claude-opus-5-5` and in `claude-opus-5.5`,
 *    and names neither. Such a name goes where a version no entry lists
 *    goes (`claude-opus-5-7`): to the entry with the family's plain pattern.
 *  - A regular expression (a hand-edited overlay only) has no length to
 *    compare and counts 0 too: any text pattern found whole outranks it.
 *
 * A pattern that counts 0 has still matched: it places the name when nothing
 * covers more, so no name is placed, or left unplaced, that was not before.
 *
 * A missing/!Array `patterns` makes the entry unmatchable by pattern; it
 * stays reachable by id, alias and prefix.
 *
 * This is one reading of the name. patternReach takes the better of two.
 */
function readingReach(m: ModelEntry, lower: string): number {
  let reach = NO_PATTERN_HIT
  const patterns = Array.isArray(m.patterns) ? m.patterns : []
  for (const p of patterns) {
    if (typeof p !== 'string' || !p) continue
    // A plain pattern is matched as text and never compiled: the only kind
    // a fetched model file may carry (literalPattern). Anything else can
    // only come from the user's own hand-edited overlay, and is read as it
    // always was.
    const literal = literalPattern(p)
    if (literal) {
      reach = Math.max(reach, textReach(lower, literal.text, literal.atStart))
    } else {
      try {
        if (p.startsWith('^') || p.endsWith('$')) {
          if (new RegExp(p, 'i').test(lower)) reach = Math.max(reach, 0)
        } else {
          reach = Math.max(reach, textReach(lower, p.toLowerCase(), false))
        }
      } catch { /* malformed pattern in a hand-edited overlay: skip, never crash a render */ }
    }
  }
  return reach
}

/**
 * How much of a name an entry's patterns cover, the name read two ways
 * (2.1.3-beta.3): as written (`lower`), and with each dot between two digits
 * as a hyphen (`hyphened`: dotsAsHyphens). The reading that covers more
 * counts; NO_PATTERN_HIT when neither is matched.
 *
 * A gateway writes a version with a dot (`anthropic/claude-opus-4.7`) and the
 * version patterns are written with a hyphen (`opus-4-7`), so none was found
 * in such a name. It went to the entry with the family's plain pattern, and
 * an older model was shown as the newest of its family.
 *
 * Each reading is held to every rule of readingReach, the version rule
 * included: `anthropic/claude-opus-4.75` and `anthropic/claude-opus-4.7.1`
 * are not Opus 4.7. (This step is reached only by a name that starts with no
 * id: with nothing before it, `claude-opus-4.7.1` starts with the id
 * `claude-opus-4-7` and is placed by it, as `claude-opus-4-7-1` is.) A
 * pattern written with a dot is still found in the name as written. The
 * second reading only adds matches, so a name that was placed is still
 * placed; one that was not is placed now only by a version pattern found in
 * it this way. In the bundled file every such name already had its family's
 * plain pattern in it, so none changes family or becomes placed.
 */
function patternReach(m: ModelEntry, lower: string, hyphened: string): number {
  const reach = readingReach(m, lower)
  return hyphened === lower ? reach : Math.max(reach, readingReach(m, hyphened))
}

export function resolveModelInfo(registry: ModelRegistry, modelId: string): ResolvedModelInfo {
  const match = matchEntry(registry, modelId)
  if (!match) {
    const hashed = hashUnknownModelColor(modelId)
    return {
      known: false, id: modelId, family: null, label: modelId, chartLabel: modelId,
      matchKind: null,
      colors: { default: hashed, chart: hashed, agentPill: hashed },
      efforts: null,
    }
  }
  const entry = match.entry
  // ResolvedModelInfo declares `label` and `chartLabel` as `string`, and every
  // consumer believes that — isModelActive() and shortModelName() both call
  // string methods on `label` unguarded. `label` and `family` are only
  // TYPE-required, though: matchEntry admits any entry with a usable `id`, so a
  // hand-edited registry-overlay.json entry with no `label` used to make this
  // function RETURN undefined in a string field, which crashed the whole
  // SessionStatusStrip render as soon as the model picker opened (a second
  // ADR-009 MAJOR-2 entry point, found re-verifying #404). Fixed here, at the
  // source, so no present or future consumer has to re-derive the guard.
  const family = typeof entry.family === 'string' && entry.family ? entry.family : null
  const fam = family ? registry.families?.[family] : undefined
  const label = typeof entry.label === 'string' && entry.label ? entry.label : entry.id
  const famLabel = typeof fam?.label === 'string' && fam.label ? fam.label : null
  const base = entry.color ?? fam?.color ?? hashUnknownModelColor(modelId)
  const colors = {
    default: base,
    chart: fam?.colorOverrides?.chart ?? base,
    agentPill: fam?.colorOverrides?.agentPill ?? base,
  }
  return {
    known: true, id: entry.id, family, label,
    chartLabel: famLabel ?? family ?? entry.id, matchKind: match.kind, colors,
    efforts: entry.efforts ?? null, fallbackPricing: entry.fallbackPricing,
  }
}

// ── Model-picker rows (#385) ────────────────────────────────────────
//
// The pickers used to render `dropdown` verbatim, so only the five family
// aliases were ever offered and a pinned version (Opus 4.6) could not be chosen
// even though the registry knew it. Rows are now built as:
//
//   1. the curated ALIAS rows from `dropdown`, first, under one "Latest" group
//      ("Opus" -> always the newest Opus), then
//   2. PINNED rows derived from `models`, grouped under their family
//      ("Opus 4.6" -> 'claude-opus-4-6').
//
// Deriving (2) from `models` is what makes a Sentinel/user overlay entry
// selectable with no code change: mergeRegistry() puts it in `models`, and it
// appears in both pickers on the next render.

export type ModelPickerRowKind = 'alias' | 'pinned'

export interface ModelPickerRow {
  value: string                              // the exact string handed to `--model` / `/model`
  label: string
  hint?: string
  group: string                              // 'Latest' for alias rows, else the family display label
  kind: ModelPickerRowKind
  family?: string                            // pinned rows only
}

export const ALIAS_GROUP_LABEL = 'Latest'

/** The providers whose sessions pick a model from this registry. */
export type ModelProvider = 'claude' | 'codex'

/** The family whose models Codex sessions run (P3.8, row 39). */
export const CODEX_FAMILY = 'codex'

/**
 * The provider whose sessions run a family's models: the codex family is
 * Codex's, every other family Claude Code's. Fixed in code, not read from the
 * family's data: an overlay replaces a whole family entry (mergeRegistry), so
 * a hand-edited overlay could otherwise move a Codex model into Claude's
 * picker, where it would be written into a Claude session as `/model <id>`.
 */
export function familyProvider(family: string | null | undefined): ModelProvider {
  return family === CODEX_FAMILY ? 'codex' : 'claude'
}

/** A Codex model id as a launch takes it (`-m <id>`): bounded, charset-limited,
 *  its first character a letter or digit so it can never read as a flag. The
 *  pty:spawn schema holds a Codex model to this (sanitize-restored-spawn-
 *  options.ts re-exports it), and the Codex picker offers only ids that pass
 *  (P3.8 round 1, R1): a row it offered could otherwise be one the launch
 *  refuses. */
export const CODEX_MODEL_ID_MAX = 64
export const CODEX_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/
export function isCodexModelId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= CODEX_MODEL_ID_MAX && CODEX_MODEL_ID_RE.test(v)
}

/**
 * The charset the PTY IPC boundary already enforces for a `--model` value
 * (`src/main/ipc/pty-handlers.ts`), mirrored for values written into a LIVE PTY
 * as a slash command (`/model <v>`, `/effort <v>`).
 *
 * That path has no schema in front of it. The pinned picker rows are derived
 * from the registry, and `registry-overlay.json` is a hand-editable user file
 * whose entries are validated on APPLY rather than on load — so an id carrying a
 * newline would be written into the PTY as a second, attacker-chosen line.
 * Defence in depth (the overlay is a local file, not remote input), and it costs
 * a regex. Legit values: 'opus', 'opus[1m]', 'claude-opus-4-8', 'xhigh'.
 * Here, beside the registry, so main holds a proposed entry to the same rule
 * (sentinel-apply.ts); `src/renderer/lib/claude-cli-options.ts` re-exports it.
 */
export const PICKER_VALUE_RE = /^[a-zA-Z0-9._[\]-]+$/

/** True when `v` is safe to write into a PTY as a slash-command argument. */
export function isWritablePickerValue(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 && PICKER_VALUE_RE.test(v)
}

/** A model name (an entry's id or one of its aliases) as the model picker of
 *  the family's provider takes it: Claude Code's picker writes the value into
 *  a live session as `/model <v>` (isWritablePickerValue); Codex's offers only
 *  ids its launch takes (isCodexModelId). The provider is the code's
 *  (familyProvider), never the entry's. */
export function followsModelPickerRule(family: string | null | undefined, v: unknown): v is string {
  return familyProvider(family) === 'claude' ? isWritablePickerValue(v) : isCodexModelId(v)
}

/** A provider's effort levels, in display order: Claude Code's are the
 *  registry's `effortLevels`, another provider's its `providerEffortLevels`
 *  entry (none when the registry has none for it). */
export function effortLevelsFor(registry: ModelRegistry, provider: ModelProvider = 'claude'): EffortLevelSpec[] {
  if (provider === 'claude') return registry?.effortLevels ?? []
  const levels = registry?.providerEffortLevels?.[provider]
  return Array.isArray(levels) ? levels : []
}

/** Family display label ("opus" -> "Opus"), falling back to the family key. */
export function familyDisplayLabel(registry: ModelRegistry, family: string): string {
  const raw = registry.families?.[family]?.label ?? family
  if (typeof raw !== 'string' || !raw) return 'Other'
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

/**
 * A model label/reading reduced to a comparable form: trailing parentheticals
 * dropped ("Opus 4.7 (1M context)" -> "opus 4.7"), trimmed, lowercased.
 */
export function normalizeModelLabel(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase()
}

/**
 * The registry id a set of readings refers to, or undefined when none of them
 * can be placed on a specific entry.
 *
 * Callers pass the readings they have in preference order — typically the live
 * statusline `display_name` first, then the id the session was spawned with.
 * A reading is accepted when it matches an entry VERSION-faithfully (exact id /
 * alias / id-prefix) or when it is exactly an entry's label: the statusline
 * reports "Opus 4.6", which can only ever `pattern`-match and is therefore
 * distrusted everywhere else, but as a label it names its entry precisely.
 * That is what keeps per-model effort gating working after a mid-session
 * /model change, when the spawn-time id has gone stale (review Q2).
 */
export function resolvePickedModelId(
  registry: ModelRegistry,
  ...readings: (string | null | undefined)[]
): string | undefined {
  for (const reading of readings) {
    if (!reading) continue
    const info = resolveModelInfo(registry, reading)
    if (info.known && info.matchKind !== 'pattern') return info.id
    const norm = normalizeModelLabel(reading)
    // usableEntries, not `registry.models` — the label scan returns an `id`, and
    // a null/id-less entry in a hand-edited overlay threw here too (#404 MAJOR-2).
    const byLabel = usableEntries(registry).find(
      (m) => typeof m.label === 'string' && normalizeModelLabel(m.label) === norm,
    )
    if (byLabel) return byLabel.id
  }
  return undefined
}

/**
 * Ordered picker rows: alias rows first, then pinned versions grouped by family.
 *
 * Family order follows the alias rows (so the Opus pins sit under the Opus
 * alias), with any family that has no alias row appended in `models` order.
 * Within a family, pins keep `models` order (newest first by convention).
 * Entries with `pickable === false` are skipped: their `id` is a matcher, not a
 * launchable model.
 *
 * `provider` (P3.8, row 39): only the rows of that provider's families
 * (familyProvider). Claude Code's is the default, so every caller that
 * predates Codex models in the registry still gets exactly Claude's rows.
 */
export function buildModelPickerRows(registry: ModelRegistry, provider: ModelProvider = 'claude'): ModelPickerRow[] {
  const aliasRows: ModelPickerRow[] = (registry.dropdown ?? [])
    .filter((d) => familyProvider(resolveModelInfo(registry, d.value).family) === provider)
    .map((d) => ({
      value: d.value, label: d.label, hint: d.hint, group: ALIAS_GROUP_LABEL, kind: 'alias' as const,
    }))

  // Never offer the same string twice: an alias row wins over an identical pin.
  const seen = new Set(aliasRows.map((r) => r.value))

  const pinsByFamily = new Map<string, ModelPickerRow[]>()
  for (const m of registry.models ?? []) {
    if (!m || m.pickable === false) continue
    // `registry-overlay.json` is a hand-editable user file: loadOverlay only
    // fails open on invalid JSON and validateProposal runs on APPLY, not on
    // load, so a malformed entry reaches here intact. Before #385 the pickers
    // read `dropdown` only and never touched `models`, so a missing `family`
    // was harmless; now it would throw and take both pickers down with it.
    // Skip the entry and say so rather than crash the render (review Q3).
    if (typeof m.id !== 'string' || !m.id || typeof m.family !== 'string' || !m.family) {
      // eslint-disable-next-line no-console
      console.warn('[model-registry] skipping malformed model entry (needs a string id and family):', m)
      continue
    }
    if (familyProvider(m.family) !== provider) continue
    // P3.8 round 1 (R1): a Codex row is only an id a launch takes (`-m <id>`);
    // an overlay id the pty:spawn schema would refuse is never offered.
    if (provider === 'codex' && !isCodexModelId(m.id)) continue
    if (seen.has(m.id)) continue
    seen.add(m.id)
    const row: ModelPickerRow = {
      value: m.id,
      label: m.label || m.id,
      group: familyDisplayLabel(registry, m.family),
      kind: 'pinned',
      family: m.family,
    }
    const list = pinsByFamily.get(m.family)
    if (list) list.push(row)
    else pinsByFamily.set(m.family, [row])
  }

  const familyOrder: string[] = []
  const pushFamily = (f: string | null | undefined): void => {
    if (f && pinsByFamily.has(f) && !familyOrder.includes(f)) familyOrder.push(f)
  }
  for (const row of aliasRows) pushFamily(resolveModelInfo(registry, row.value).family)
  for (const f of pinsByFamily.keys()) pushFamily(f)

  const pinned: ModelPickerRow[] = []
  for (const f of familyOrder) pinned.push(...(pinsByFamily.get(f) ?? []))
  return [...aliasRows, ...pinned]
}

/** Group consecutive rows into ordered { title, rows } sections for a popover. */
export function groupPickerRows(rows: ModelPickerRow[]): { title: string; rows: ModelPickerRow[] }[] {
  const out: { title: string; rows: ModelPickerRow[] }[] = []
  for (const row of rows) {
    const last = out[out.length - 1]
    if (last && last.title === row.group) last.rows.push(row)
    else out.push({ title: row.group, rows: [row] })
  }
  return out
}

export interface EffortRow { value: string; label: string; hint?: string; supported: boolean }

/**
 * Effort levels for a model, each marked `supported`.
 *
 * A model's `efforts` list is only trusted when the registry matched the model
 * VERSION-faithfully (exact id / alias / id-prefix). A `pattern` hit is the
 * fuzzy family catch-all -- a statusline reading of "Opus 4.6" pattern-matches
 * the newest Opus entry, whose effort list may differ -- so those, and unknown
 * models, fall back to "all supported" (spec §3: null efforts = assume valid).
 * Unsupported levels are DISABLED by callers rather than hidden, so the list
 * never silently changes shape under the user.
 *
 * `provider` (P3.8, row 40): the levels are that provider's (effortLevelsFor),
 * and only a model of that provider's families gates them; another
 * provider's model is not this provider's to judge, so it enables everything,
 * as an unknown model does.
 */
export function buildEffortRows(
  registry: ModelRegistry,
  modelId: string | undefined | null,
  provider: ModelProvider = 'claude',
): EffortRow[] {
  const levels = effortLevelsFor(registry, provider)
  const info = modelId ? resolveModelInfo(registry, modelId) : null
  const trustworthy = !!info && info.known && info.matchKind !== 'pattern' && familyProvider(info.family) === provider
  const allowed = trustworthy && info!.efforts ? new Set(info!.efforts) : null
  return levels.map((l) => ({
    value: l.value, label: l.label, hint: l.hint,
    supported: allowed ? allowed.has(l.value) : true,
  }))
}

/**
 * Whether a Codex session on `model` runs `effort` (P3.8): no effort (the
 * model's own default) always does; a level Codex's list does not hold (a
 * legacy 'none' or 'minimal') never does; otherwise the model's own levels
 * decide, a model the registry cannot place taking any level. The session
 * dialog, the command bar pill and the launch in main all ask this.
 */
export function codexEffortRuns(registry: ModelRegistry, model: string | null | undefined, effort: string | null | undefined): boolean {
  if (!effort) return true
  return buildEffortRows(registry, model || null, 'codex').some((e) => e.value === effort && e.supported)
}

// ── The Codex models from the installed Codex's own list (aicc_planning#362) ──

/** The models the installed Codex lists in its own picker, read from it
 *  (`codex debug models --bundled`, main), each with the reasoning levels it
 *  lists for it, and the version that printed the list. */
export interface InstalledCodexModels {
  version: string
  models: ReadonlyArray<{ id: string; label: string; efforts?: readonly string[] }>
}

/**
 * The registry as the Codex pickers and the Codex launch see it once the
 * installed Codex's own list has been read: the Codex models are that list's,
 * in its order, each with the levels it lists. A registry row of the same id
 * only adds what the list does not carry (its price, its colour) or corrects
 * it (its label); a list-only model gets a row of its own. A Codex row the
 * list does not name stays, not offered (`pickable: false`), so a session
 * already on it is still placed and priced. A listed id that a Claude model
 * of the registry has as its id or an alias is never offered (the Claude
 * entry keeps it), nor is one a launch would refuse (isCodexModelId).
 *
 * No list, or a list with no model it can offer: the registry alone, as
 * before. Pure; the same list applied twice gives the same registry.
 */
export function withInstalledCodexModels(registry: ModelRegistry, list: InstalledCodexModels | null | undefined): ModelRegistry {
  const { installedCodex: _was, ...alone } = registry
  void _was
  const listed = Array.isArray(list?.models) && typeof list?.version === 'string' ? list!.models : []
  const models: ModelEntry[] = Array.isArray(registry?.models) ? registry.models : []
  const isCodexRow = (m: ModelEntry | null | undefined): boolean =>
    !!m && typeof m.id === 'string' && familyProvider(m.family) === 'codex'
  // The names Claude's entries answer to: never a Codex row's.
  const claudeNames = new Set<string>()
  for (const m of models) {
    if (!m || typeof m.id !== 'string' || isCodexRow(m)) continue
    claudeNames.add(m.id)
    if (Array.isArray(m.aliases)) for (const a of m.aliases) if (typeof a === 'string') claudeNames.add(a)
  }
  const picked: Array<{ id: string; label: string; efforts?: readonly string[] }> = []
  const ids = new Set<string>()
  for (const m of listed) {
    if (!m || !isCodexModelId(m.id) || ids.has(m.id) || claudeNames.has(m.id)) continue
    ids.add(m.id)
    picked.push(m)
  }
  if (picked.length === 0) return alone
  const ownRow = new Map<string, ModelEntry>()
  for (const m of models) if (isCodexRow(m) && ids.has(m.id) && !ownRow.has(m.id)) ownRow.set(m.id, m)
  const listedRows: ModelEntry[] = picked.map((m) => {
    const row = ownRow.get(m.id)
    const efforts = Array.isArray(m.efforts) ? m.efforts.filter((e): e is string => typeof e === 'string') : row?.efforts
    if (!row) {
      const label = typeof m.label === 'string' && m.label ? m.label : m.id
      return { id: m.id, patterns: [], family: CODEX_FAMILY, label, ...(efforts ? { efforts } : {}) }
    }
    const { pickable: _p, ...kept } = row
    void _p
    return { ...kept, ...(efforts ? { efforts } : {}) }
  })
  // The listed rows stand together where the first Codex row stood; every
  // other Codex row stays in place, not offered.
  const out: ModelEntry[] = []
  let placed = false
  for (const m of models) {
    if (isCodexRow(m) && !placed) { out.push(...listedRows); placed = true }
    if (isCodexRow(m) && ids.has(m.id)) continue
    out.push(isCodexRow(m) && m.pickable !== false ? { ...m, pickable: false } : m)
  }
  if (!placed) out.push(...listedRows)
  return { ...alone, models: out, installedCodex: { version: list!.version } }
}

// ── Model coverage vs. the published Claude Code model configuration (#385) ──
//
// Anthropic's Claude Code model configuration support article is the reference
// for the model options we offer (owner, #385).
// `resources/claude-code-model-configuration.json` is a hand-refreshed snapshot
// of its Supported models table, and this comparison runs in TWO places so the
// registry cannot quietly drift from it:
//   - the Sentinel check (src/main/sentinel/sentinel-models.ts), at runtime, and
//   - the release gate (scripts/release-gate.mjs), which refuses the cut.
// The gate is dependency-free ESM that runs before `npm ci`, so it carries its
// own copy of this logic; tests/unit/model-coverage-parity.test.ts asserts the
// two implementations agree on every fixture.

export interface ExpectedModelSpec { id: string; label?: string }
export interface ExpectedModelSet {
  source?: string
  fetchedAt?: string                         // ISO date the article was last read
  models: ExpectedModelSpec[]
}

export interface ModelCoverageResult {
  ok: boolean
  reason: string | null
  missing: ExpectedModelSpec[]               // article lists it, the registry does not
  extra: ExpectedModelSpec[]                 // registry carries it, the article does not (retired/renamed?)
  covered: { id: string; by: string }[]
  /** The Codex half (P3.8 round 2, GS): Codex ids the registry lists more
   *  than once; they cover nothing and fail the check. */
  duplicates?: string[]
  /** The Codex half (aicc_planning#362): listed ids a Claude model of the
   *  registry has as its id or an alias; the Codex picker never offers them,
   *  and they fail the check. */
  taken?: string[]
}

/** True for an entry that came from the overlay (Sentinel- or user-added). */
export function isOverlaySourced(entry: ModelEntry): boolean {
  return !!(entry as Partial<OverlayModelEntry>).provenance
}

/** An article id is covered by a registry id when equal, or equal minus a -YYYYMMDD suffix. */
export function registryIdCovers(registryId: string, expectedId: string): boolean {
  if (registryId === expectedId) return true
  const m = /^(.*)-(\d{8})$/.exec(expectedId)
  return !!m && m[1] === registryId
}

/**
 * Compare the registry against the article snapshot.
 *
 * Fails closed on an empty/missing expected set: a check that passes because it
 * had nothing to compare is worse than no check.
 */
export function evaluateModelCoverage(
  registry: ModelRegistry,
  expected: ExpectedModelSet | null | undefined,
): ModelCoverageResult {
  const registryModels = registry?.models ?? []
  const expectedModels = expected?.models ?? []
  if (expectedModels.length === 0) {
    return {
      ok: false,
      reason: 'the expected-models fixture is empty or missing — cannot verify the registry (fail closed)',
      missing: [], extra: [], covered: [],
    }
  }
  const missing: ExpectedModelSpec[] = []
  const covered: { id: string; by: string }[] = []
  const usedRegistryIds = new Set<string>()
  for (const exp of expectedModels) {
    const hit = registryModels.find((m) => registryIdCovers(m.id, exp.id))
    if (hit) { covered.push({ id: exp.id, by: hit.id }); usedRegistryIds.add(hit.id) }
    else missing.push({ id: exp.id, label: exp.label })
  }
  // Claude models we carry that the article no longer names. Excluded:
  //  - non-Claude entries (the codex catch-all) — not the article's business
  //  - `articleExempt` entries — carried deliberately
  //  - OVERLAY entries (they carry `provenance`) — a model Sentinel or the user
  //    just added is necessarily absent from a snapshot frozen before it, and
  //    reporting it as "possibly retired" the moment it is added contradicts
  //    the whole point of letting an overlay add one (review Q4).
  const extra = registryModels
    .filter((m) => typeof m.id === 'string' && m.id.startsWith('claude-')
      && !usedRegistryIds.has(m.id) && m.articleExempt !== true && !isOverlaySourced(m))
    .map((m) => ({ id: m.id, label: m.label }))
  return {
    ok: missing.length === 0,
    reason: missing.length === 0
      ? null
      : `${missing.length} model(s) from the Claude Code model configuration article are not in the registry`,
    missing, extra, covered,
  }
}

/**
 * The Codex half (P3.8, row 39): the registry's Codex models against the
 * models a Codex CLI lists in its own model picker (the list shipped with
 * this build, `resources/codex-model-catalogue.json`, or one read from the
 * installed Codex). An id is covered by a registry entry of the codex family
 * with the same id (Codex ids carry no date suffix); `extra` is a launchable
 * Codex model the list no longer names, never an overlay entry; an empty or
 * missing list fails closed. Round 2 (GS): only an id the Codex picker offers
 * (isCodexModelId) covers one; an id the registry lists more than once covers
 * nothing and fails the check (the pickers would disagree about it); a file
 * whose `models` is not a list reads as empty.
 *
 * aicc_planning#362: a listed id the registry lacks (`missing`) no longer
 * fails it. The Codex picker offers the installed Codex's own list, so a model
 * Codex adds needs no registry row (withInstalledCodexModels). What still
 * fails, besides an empty list and a duplicate, is a listed id that a Claude
 * model of the registry has as its id or an alias (`taken`): the Codex picker
 * never offers such an id.
 */
export function evaluateCodexModelCoverage(
  registry: ModelRegistry,
  expected: ExpectedModelSet | null | undefined,
): ModelCoverageResult {
  const entries = Array.isArray(registry?.models) ? usableEntries(registry) : []
  const count = new Map<string, number>()
  for (const m of entries) count.set(m.id, (count.get(m.id) ?? 0) + 1)
  const expectedModels = (Array.isArray(expected?.models) ? expected!.models : [])
    .filter((m) => !!m && typeof m.id === 'string' && m.id.length > 0)
  const listedIds = new Set(expectedModels.map((m) => m.id))
  const duplicates = [...count].filter(([id, n]) => n > 1
    && (listedIds.has(id) || entries.some((m) => m.id === id && familyProvider(m.family) === 'codex'))).map(([id]) => id)
  const codexModels = entries.filter((m) => familyProvider(m.family) === 'codex' && m.pickable !== false
    && isCodexModelId(m.id) && count.get(m.id) === 1)
  if (expectedModels.length === 0) {
    return {
      ok: false,
      reason: 'the expected Codex models list is empty or missing, so the registry cannot be verified (fail closed)',
      missing: [], extra: [], covered: [],
    }
  }
  const claudeNames = new Set<string>()
  for (const m of entries) {
    if (familyProvider(m.family) === 'codex') continue
    claudeNames.add(m.id)
    if (Array.isArray(m.aliases)) for (const a of m.aliases) if (typeof a === 'string') claudeNames.add(a)
  }
  const missing: ExpectedModelSpec[] = []
  const covered: { id: string; by: string }[] = []
  const taken: string[] = []
  for (const exp of expectedModels) {
    const hit = codexModels.find((m) => m.id === exp.id)
    if (hit) covered.push({ id: exp.id, by: hit.id })
    else missing.push({ id: exp.id, label: exp.label })
    if (claudeNames.has(exp.id) && !duplicates.includes(exp.id)) taken.push(exp.id)
  }
  const extra = codexModels
    .filter((m) => !listedIds.has(m.id) && !isOverlaySourced(m))
    .map((m) => ({ id: m.id, label: m.label }))
  return {
    ok: duplicates.length === 0 && taken.length === 0,
    reason: duplicates.length > 0 ? `${duplicates.length} Codex model id(s) are listed more than once in the registry`
      : taken.length > 0 ? `${taken.length} model(s) the Codex CLI lists have the id or alias of a Claude model in the registry` : null,
    missing, extra, covered, duplicates, taken,
  }
}
