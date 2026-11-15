// Validation gate for Apply (spec §7): schema checks + the hijack guard. AI and
// observed patches go through the SAME path — both fully untrusted. Apply itself
// delegates to model-registry-service.applyOverlayEntry (atomic write + hot
// reload) — this module only decides whether a proposal is safe.
import { followsModelPickerRule, usableEntries } from '../../shared/model-registry'
import type { ModelRegistry, OverlayModelEntry } from '../../shared/model-registry'
import { idHeldBy } from '../model-registry-data'
import { stripSpoofableText } from '../../shared/safe-text'

const MAX_SANE_PER_1M_USD = 1000

/** Fixed, and never the value itself: a proposal is untrusted text. */
const NAME_RULE_ERROR = 'model name holds characters a model name cannot'

/** A proposal's pattern or family as a refusal names it: plain text (every
 *  control and invisible character a space), cut short. */
const shown = (v: string): string => stripSpoofableText(v, 120)

// Mirrors matchEntry's contract: anchored patterns are regexes, everything else
// is a case-insensitive substring (regex specials inert there).
function patternHits(pattern: string, candidate: string): boolean {
  if (pattern.startsWith('^') || pattern.endsWith('$')) {
    return new RegExp(pattern, 'i').test(candidate.toLowerCase())
  }
  return candidate.toLowerCase().includes(pattern.toLowerCase())
}

export function validateProposal(given: ModelRegistry, entry: OverlayModelEntry): { ok: boolean; error?: string } {
  // The registry as the matcher reads it: its entries with an id
  // (usableEntries). The user's own file is merged in as it is written, so
  // an entry there may have no id, or be no entry at all; the matcher passes
  // such a one over, and so does every check below.
  const registry: ModelRegistry = { ...given, models: usableEntries(given) }
  if (!entry.id || !entry.label || !entry.family) return { ok: false, error: 'id, label, family are required' }
  if (typeof entry.id !== 'string' || typeof entry.label !== 'string' || typeof entry.family !== 'string') {
    return { ok: false, error: 'id, label, family must be text' }
  }
  // The same name rule as the model picker of the family's provider, for the
  // id and every alias.
  if (!followsModelPickerRule(entry.family, entry.id)) return { ok: false, error: NAME_RULE_ERROR }
  if (entry.aliases !== undefined) {
    if (!Array.isArray(entry.aliases)) return { ok: false, error: 'aliases must be a list' }
    for (const a of entry.aliases) {
      if (!followsModelPickerRule(entry.family, a)) return { ok: false, error: NAME_RULE_ERROR }
    }
  }
  if (registry.models.some((m) => m.id === entry.id)) {
    return { ok: false, error: `id "${entry.id}" already exists in the registry — edit/revert that entry instead` }
  }
  // Alias-hijack guard (defense-in-depth): aliases resolve at priority 2 in
  // matchEntry, ahead of prefix/patterns. Merge order + the AI schema stripping
  // aliases already protect builtins, but manual overlay edits bypass both —
  // make collision impossible by construction.
  for (const a of entry.aliases ?? []) {
    const clash = registry.models.find((m) => m.id !== entry.id && (m.id === a || m.aliases?.includes(a)))
    if (clash) return { ok: false, error: `alias "${a}" collides with already-known model ${clash.id}` }
  }
  // The proposed id and each alias are held to the fetched-file name rule
  // (idHeldBy, model-registry-data.ts), asked of every entry the registry
  // has. A name is refused when it is a known id or alias, a known id with a
  // date or a context size after it (claude-opus-4-8-20260301,
  // claude-opus-4-8[1m]), or one of those with its version written with a
  // dot (claude-opus-5.5), and the refusal names the model that has the
  // name. A new version the registry reaches only by a shorter id or by a
  // pattern (claude-opus-5-7, claude-opus-6) is not such a name: that is how
  // a model is added.
  for (const name of [entry.id, ...(entry.aliases ?? [])]) {
    const holder = idHeldBy(registry, name)
    if (holder) return { ok: false, error: `"${name}" is a name the registry already gives to ${shown(holder)}` }
  }
  if (!entry.patterns?.length) return { ok: false, error: 'at least one pattern required' }
  for (const p of entry.patterns) {
    if (p.startsWith('^') || p.endsWith('$')) {
      try { new RegExp(p, 'i') } catch { return { ok: false, error: `anchored pattern does not compile: ${shown(p)}` } }
    }
  }
  const fp = entry.fallbackPricing
  if (fp) {
    if (!(fp.input > 0 && fp.output > 0 && fp.cacheRead >= 0 && fp.cacheWrite >= 0)) {
      return { ok: false, error: 'pricing must be positive (input/output) and non-negative (cache)' }
    }
    if (fp.input > MAX_SANE_PER_1M_USD || fp.output > MAX_SANE_PER_1M_USD) {
      return { ok: false, error: `pricing exceeds sanity bound ($${MAX_SANE_PER_1M_USD}/1M)` }
    }
  }
  if (entry.color && !/^(#[0-9a-fA-F]{6}|var\(--[\w-]+\))$/.test(entry.color)) {
    return { ok: false, error: 'colour must be #rrggbb or var(--token)' }
  }
  if (!registry.families[entry.family]) {
    return { ok: false, error: `family "${shown(entry.family)}" not in registry` }
  }
  // Hijack guard: would any pattern capture an id that already belongs to a
  // DIFFERENT known entry? Loud rejection instead of a quiet Apply (spec §7).
  for (const known of registry.models) {
    if (known.id === entry.id) continue
    for (const p of entry.patterns) {
      let hit = false
      try { hit = patternHits(p, known.id) } catch { /* unreachable: compile pre-checked */ }
      if (hit) return { ok: false, error: `pattern "${shown(p)}" re-matches already-known model ${known.id}` }
    }
  }
  return { ok: true }
}
