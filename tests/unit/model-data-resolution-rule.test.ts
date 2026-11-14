/**
 * Model definitions as data (2.1.3-beta.1): a fetched model file never changes
 * what a name the build already places resolves to.
 *
 * The rule (model-registry-data.ts, matchEntry in model-registry.ts): a
 * shipped model's patterns are the bundled file's, and every entry that is
 * not the fetched file's own addition is tried, shipped ones in the bundled
 * file's order, before a model only the fetched file has. So such a model is
 * reached by its exact id or one of its aliases, and beyond that only by a
 * name nothing else places.
 *
 * A property test: a fixed list of names against a set of fetched files that
 * pass every check and try to take names. For every name, the registry with
 * the file says what the registry without it says, but for two cases: a name
 * that is the id or an alias of a model only the file has is that model; and
 * a name nothing places without the file may be placed by such a model (that
 * is how a new family is added). Pure: no file, no network.
 */
import { describe, it, expect } from 'vitest'
import bundledJson from '../../resources/model-registry.json'
import { mergeModelData, modelDataText, validateModelData } from '../../src/main/model-registry-data'
import {
  buildModelPickerRows, mergeRegistry, resolveModelInfo,
  type ModelEntry, type ModelRegistry, type OverlayModelEntry, type RegistryOverlay,
} from '../../src/shared/model-registry'

type Loose = Record<string, any>
const { formatVersion: _format, revision: _revision, ...bundledFile } = bundledJson as Loose
void _format; void _revision
const bundled = bundledFile as unknown as ModelRegistry

/** A fresh copy of the bundled file, as a fetched file would carry it. */
const file = (change: (f: Loose) => void): Loose => {
  const f = JSON.parse(JSON.stringify(bundledJson)) as Loose
  change(f)
  return f
}
const find = (f: Loose, id: string): Loose => f.models.find((m: Loose) => m.id === id)
const HIGH = { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 }

// ── The fetched files: each passes validateModelData and tries to take names ──

const HOSTILE: [string, (f: Loose) => void][] = [
  ['a new model, listed first, with near-variants of its family\'s pattern', (f) => {
    f.models.unshift({ id: 'claude-opus-9', patterns: ['opus-', 'claude-opus', '^claude-', 'anthropic'], family: 'opus', label: 'Opus 9', fallbackPricing: HIGH })
  }],
  ['a new model, listed first, whose patterns reach every family and the other assistant', (f) => {
    f.models.unshift({ id: 'claude-haiku-9', patterns: ['claude', 'fable-', 'sonnet-', 'haiku-', 'gpt-5', 'gpt-9', 'mini'], family: 'haiku', label: 'Haiku 9', fallbackPricing: HIGH })
  }],
  ['a new Codex model, listed first, with near-variants of the Codex patterns', (f) => {
    f.models.unshift({ id: 'gpt-9', patterns: ['^gpt-9', 'gpt-5.', 'codex-', '^o9-m'], family: 'codex', label: 'GPT-9' })
  }],
  ['a new model whose id is the start of a shipped model\'s dated names', (f) => {
    f.models.unshift({ id: 'claude-opus-5-5-2', patterns: [], family: 'opus', label: 'Opus 5.5.2', fallbackPricing: HIGH })
    f.models.unshift({ id: 'claude-sonnet-4', patterns: [], family: 'sonnet', label: 'Sonnet 4', fallbackPricing: HIGH })
  }],
  ['a shipped pattern given to another shipped entry, listed first', (f) => {
    const m = find(f, 'claude-opus-4-5')
    m.patterns = ['opus', ...m.patterns]
    f.models = [m, ...f.models.filter((x: Loose) => x !== m)]
  }],
  ['a shipped pattern moved from its entry to another', (f) => {
    find(f, 'claude-opus-5-5').patterns = []
    find(f, 'claude-opus-4-5').patterns = ['opus']
    find(f, 'claude-haiku-4-5').patterns = ['sonnet', 'haiku']
    find(f, 'claude-haiku-5-5').patterns = []
  }],
  ['a shipped entry given near-variants and another family\'s names', (f) => {
    const m = find(f, 'claude-haiku-4-5')
    m.patterns = ['haiku-4-5', 'claude-', 'fable-5', 'opus-', 'gpt-9']
    f.models = [m, ...f.models.filter((x: Loose) => x !== m)]
  }],
  ['every shipped pattern taken away', (f) => {
    for (const m of f.models) m.patterns = []
  }],
  ['the shipped entries in the opposite order', (f) => {
    f.models.reverse()
  }],
  ['a new model listed first and another listed last, each with an alias', (f) => {
    f.models.unshift({ id: 'claude-fable-9', patterns: ['fable-9', 'fable-5-', 'claude-fable'], aliases: ['fable-next'], family: 'fable', label: 'Fable 9', fallbackPricing: HIGH })
    f.models.push({ id: 'claude-sonnet-9', patterns: ['sonnet-9', 'claude-sonnet'], aliases: ['sonnet-next'], family: 'sonnet', label: 'Sonnet 9', fallbackPricing: HIGH })
  }],
  ['a new model, listed first, that takes over its family\'s alias', (f) => {
    const was = find(f, 'claude-opus-5-5')
    was.aliases = was.aliases.filter((a: string) => a !== 'opus')
    f.models.unshift({ id: 'claude-opus-6', patterns: ['opus-6', 'opus-5-5-', 'claude-opus-'], aliases: ['opus'], family: 'opus', label: 'Opus 6', fallbackPricing: HIGH })
  }],
]

/** The validated file, as the service would put it to use. */
function checked(change: (f: Loose) => void): ModelRegistry {
  const r = validateModelData(file(change), bundled)
  if (!r.ok) throw new Error(`the file was refused, so it tests nothing: ${r.reason}`)
  return r.data
}
/** The registry readers get: the bundled file, the model data, the overlay. */
const inUse = (data: ModelRegistry | null, overlay: RegistryOverlay | null = null): ModelRegistry =>
  mergeRegistry(mergeModelData(bundled, data, '2026-11-14'), overlay)

// ── The names ──

const CLAUDE_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku']
const claudeIds = bundled.models.filter((m) => m.family !== 'codex').map((m) => m.id)
const NAMES: string[] = [...new Set([
  // What the build names outright.
  ...bundled.models.map((m) => m.id),
  ...bundled.models.flatMap((m) => m.aliases ?? []),
  // A shipped id with a date or a context size after it.
  ...bundled.models.flatMap((m) => [`${m.id}-20260101`, `${m.id}[1m]`]),
  // A partner platform's id for each shipped Claude model...
  ...claudeIds.flatMap((id) => [`anthropic.${id}-v1:0`, `us.anthropic.${id}-20260101-v1:0`, `${id}@20260101`, `vertex/${id}@20260101`]),
  // ...and for a version of each family the build does not list.
  ...CLAUDE_FAMILIES.flatMap((f) => [
    `anthropic.claude-${f}-9-v1:0`, `us.anthropic.claude-${f}-9-v1:0`, `claude-${f}-9@20990101`, `vertex/claude-${f}-9@20990101`,
    `claude-${f}-9`, `claude-${f}-9-20990101`, `claude-${f}-4`, `claude-${f}-4-1-20250805`, `claude-${f}-4-20250514`, `claude-3-5-${f}-20241022`,
    `${f}-preview`, `my-${f}-build`, `${f[0].toUpperCase()}${f.slice(1)} 9 (1M context)`, `${f[0].toUpperCase()}${f.slice(1)} 4.8`,
  ]),
  // Names nothing places.
  'no-such-model', 'claude-thinking-7', 'claude-zeta-1', 'anthropic.claude-zeta-1-v1:0', 'mystery', 'llama-3-mini', 'anthropic.titan-text', 'x', '',
  // Codex names.
  'gpt-9-nova', 'gpt-9', 'gpt-5.5-20260101', 'gpt-5.2-mini', 'gpt-6-sol-fast', 'o9-mini', 'o3-codex', 'codex-mini-latest', 'my-codex-build', 'openai/gpt-9',
  // Names an entry of the user's own overlay is after (the last tests).
  'claude-opus-7', 'claude-opus-7-20270101', 'claude-opus-7@20270101', 'anthropic.claude-opus-7-v1:0',
])]

const placed = (registry: ModelRegistry, name: string) => resolveModelInfo(registry, name)

/**
 * The names the fetched file `data` changed against the rule: `merged` is
 * the registry with it, `alone` the same registry without it. Empty when
 * the rule holds.
 */
function namesTaken(data: ModelRegistry, merged: ModelRegistry, alone: ModelRegistry): string[] {
  const shipped = new Set(bundled.models.map((m) => m.id))
  const added = data.models.filter((m) => !shipped.has(m.id))
  const addedIds = new Set(added.map((m) => m.id))
  // What only the fetched file has, by the names that mean it outright.
  const own = new Map<string, { id: string; kind: 'exact' | 'alias' }>()
  for (const m of added) for (const a of m.aliases ?? []) if (!own.has(a)) own.set(a, { id: m.id, kind: 'alias' })
  for (const m of added) own.set(m.id, { id: m.id, kind: 'exact' })

  const wrong: string[] = []
  for (const name of [...NAMES, ...own.keys()]) {
    const got = placed(merged, name)
    const mine = own.get(name)
    if (mine) {
      if (got.id !== mine.id || got.matchKind !== mine.kind) wrong.push(`${name}: ${got.id} (${got.matchKind}), not the file's own ${mine.id} (${mine.kind})`)
      continue
    }
    const want = placed(alone, name)
    if (JSON.stringify(got) === JSON.stringify(want)) continue
    // A name nothing places without the file may go to a model only the file has.
    if (!want.known && addedIds.has(got.id) && (got.matchKind === 'pattern' || got.matchKind === 'prefix')) continue
    wrong.push(`${name}: ${got.id} (${got.matchKind}), without the file it is ${want.known ? `${want.id} (${want.matchKind})` : 'not placed'}`)
  }
  return wrong
}

describe('a fetched model file never changes what a name the build already places resolves to', () => {
  it('the list of names holds every way a name is placed, and names nothing places', () => {
    const kinds = new Set(NAMES.map((n) => String(placed(bundled, n).matchKind)))
    expect([...kinds].sort()).toEqual(['alias', 'exact', 'null', 'pattern', 'prefix'])
    expect(NAMES.length).toBeGreaterThan(200)
  })

  it.each(HOSTILE)('%s', (_what, change) => {
    const data = checked(change)
    expect(namesTaken(data, inUse(data), bundled)).toEqual([])
    // And as the window gets it: a copy sent from the main process.
    expect(namesTaken(data, structuredClone(inUse(data)), bundled)).toEqual([])
  })

  it('a model marked as the fetched file\'s own is tried last even in a registry that carries no order', () => {
    const marked: OverlayModelEntry = { id: 'claude-opus-9', patterns: ['opus', 'claude'], family: 'opus', label: 'Opus 9', provenance: { addedBy: 'model-data', date: '2026-11-14' } }
    const registry: ModelRegistry = { ...bundled, models: [marked, ...bundled.models] }
    expect(registry.shippedOrder).toBeUndefined()
    for (const name of ['anthropic.claude-opus-4-8-v1:0', 'claude-opus-9@20990101', 'claude-fable-5-1-20260801', 'Sonnet 4.6']) {
      expect(placed(registry, name), name).toEqual(placed(bundled, name))
    }
    expect(placed(registry, 'claude-thinking-7')).toMatchObject({ id: 'claude-opus-9', matchKind: 'pattern' })
  })

  it('a shipped model\'s patterns are the bundled file\'s, whatever the fetched file gives it', () => {
    for (const [what, change] of HOSTILE) {
      const merged = inUse(checked(change))
      for (const b of bundled.models) {
        expect(merged.models.find((m) => m.id === b.id)?.patterns, `${what}: ${b.id}`).toEqual(b.patterns)
      }
    }
    // The other fields a file may correct are still corrected.
    const merged = inUse(checked((f) => { const m = find(f, 'claude-opus-4-5'); m.patterns = ['opus']; m.label = 'Opus 4.5!'; m.fallbackPricing.input = 7 }))
    expect(resolveModelInfo(merged, 'claude-opus-4-5')).toMatchObject({ label: 'Opus 4.5!', fallbackPricing: { input: 7 } })
  })

  it('the picker order is still the fetched file\'s: the models are not put in another order', () => {
    const data = checked((f) => { f.models.reverse(); f.models.unshift({ id: 'claude-opus-9', patterns: ['opus-9'], family: 'opus', label: 'Opus 9' }) })
    const merged = inUse(data)
    expect(merged.models.map((m) => m.id)).toEqual(data.models.map((m) => m.id))
    const opus = (r: ModelRegistry) => buildModelPickerRows(r).filter((row) => row.kind === 'pinned' && row.family === 'opus').map((row) => row.value)
    expect(opus(merged)).toEqual(['claude-opus-9', ...opus(bundled).reverse()])
  })

  it('what orders the names is held in memory only: the kept copy of the file does not carry it', () => {
    const data = checked((f) => { f.models.unshift({ id: 'claude-opus-9', patterns: ['opus-9'], family: 'opus', label: 'Opus 9' }) })
    expect(inUse(data).shippedOrder).toEqual(bundled.models.map((m) => m.id))
    const kept = modelDataText(data, 20261114)
    expect(validateModelData(JSON.parse(kept), bundled).ok).toBe(true)
    expect(kept).not.toContain('provenance')
    expect(kept).not.toContain('shippedOrder')
    // Nor can a fetched file bring an order of its own.
    expect(validateModelData(file((f) => { f.shippedOrder = ['claude-opus-4-5'] }), bundled).ok).toBe(false)
    expect(Object.keys(JSON.parse(kept)).sort()).toEqual(Object.keys(bundledJson).sort())
  })
})

describe('a model only the fetched file has', () => {
  const ZETA = { id: 'claude-zeta-1', patterns: ['zeta'], aliases: ['zeta'], family: 'zeta', label: 'Zeta 1', fallbackPricing: { input: 6, output: 30, cacheRead: 0.15, cacheWrite: 7.5 } }
  const withZeta = (f: Loose): void => {
    f.families.zeta = { label: 'zeta', color: '#336699' }
    f.models.unshift(ZETA)
  }

  it('a new family with a pattern of its own still takes the names no shipped entry places', () => {
    const merged = inUse(checked(withZeta))
    for (const name of ['anthropic.claude-zeta-1-v1:0', 'vertex/claude-zeta-2@20990101', 'Zeta 1 (1M context)', 'my-zeta-build']) {
      expect(placed(bundled, name).known, name).toBe(false)
      expect(placed(merged, name), name).toMatchObject({ known: true, id: 'claude-zeta-1', family: 'zeta', matchKind: 'pattern', fallbackPricing: ZETA.fallbackPricing })
    }
    expect(placed(merged, 'claude-zeta-1')).toMatchObject({ id: 'claude-zeta-1', matchKind: 'exact', label: 'Zeta 1' })
    expect(placed(merged, 'zeta')).toMatchObject({ id: 'claude-zeta-1', matchKind: 'alias' })
    // A dated form of its id: nothing shipped places it, so the id does.
    expect(placed(merged, 'claude-zeta-1-20270101')).toMatchObject({ id: 'claude-zeta-1', matchKind: 'prefix' })
  })

  it('a name a shipped entry places too stays with the shipped entry', () => {
    const merged = inUse(checked(withZeta))
    for (const name of ['zeta-opus-mix', 'anthropic.claude-opus-zeta-v1:0', 'gpt-zeta', 'claude-opus-4-8-zeta']) {
      expect(placed(merged, name), name).toEqual(placed(bundled, name))
      expect(placed(merged, name).known, name).toBe(true)
    }
  })

  it('a new version of a shipped family is its exact id and its aliases; every other name stays where the build has it', () => {
    const merged = inUse(checked((f) => {
      f.models.unshift({ id: 'claude-opus-6', patterns: ['opus-6'], aliases: ['claude-opus-6[1m]'], family: 'opus', label: 'Opus 6', fallbackPricing: HIGH })
    }))
    expect(placed(merged, 'claude-opus-6')).toMatchObject({ id: 'claude-opus-6', matchKind: 'exact', label: 'Opus 6' })
    expect(placed(merged, 'claude-opus-6[1m]')).toMatchObject({ id: 'claude-opus-6', matchKind: 'alias' })
    for (const name of ['claude-opus-6-20270101', 'anthropic.claude-opus-6-v1:0', 'Opus 6 (1M context)']) {
      expect(placed(merged, name), name).toEqual(placed(bundled, name))
    }
  })
})

describe('the user\'s own overlay keeps its place', () => {
  const user = (m: Partial<ModelEntry> & { id: string }): OverlayModelEntry =>
    ({ patterns: [], family: 'opus', label: m.id, ...m, provenance: { addedBy: 'user', date: '2026-11-14' } })
  const OVERLAY: RegistryOverlay = {
    models: [
      // An entry of the user's own, with an id and a pattern of its own.
      user({ id: 'claude-opus-7', patterns: ['opus-7', 'mystery'], label: 'My Opus 7' }),
      // The user's own copy of a shipped entry, with other patterns.
      user({ id: 'claude-opus-4-6', patterns: ['opus-4-6', 'titan'], label: 'My Opus 4.6' }),
    ],
  }

  it('with any fetched file, a name resolves as it does with the bundled file and the overlay alone', () => {
    const alone = inUse(null, OVERLAY)
    // The overlay is in play: its entries place names the build alone does not.
    expect(placed(alone, 'claude-opus-7-20270101')).toMatchObject({ id: 'claude-opus-7', matchKind: 'prefix' })
    expect(placed(alone, 'mystery')).toMatchObject({ id: 'claude-opus-7', matchKind: 'pattern' })
    expect(placed(alone, 'anthropic.titan-text')).toMatchObject({ id: 'claude-opus-4-6', label: 'My Opus 4.6', matchKind: 'pattern' })
    for (const [what, change] of HOSTILE) {
      const data = checked(change)
      expect(namesTaken(data, inUse(data, OVERLAY), alone), what).toEqual([])
    }
  })

  it('the user\'s own copy of a model only the fetched file has is the user\'s: it is tried with the shipped entries', () => {
    const data = checked((f) => { f.models.unshift({ id: 'claude-opus-6', patterns: ['opus-6'], family: 'opus', label: 'Opus 6' }) })
    const overlay: RegistryOverlay = { models: [user({ id: 'claude-opus-6', patterns: ['opus-6', 'mystery'], label: 'My Opus 6' })] }
    const merged = inUse(data, overlay)
    expect(placed(merged, 'claude-opus-6-20270101')).toMatchObject({ id: 'claude-opus-6', label: 'My Opus 6', matchKind: 'prefix' })
    expect(placed(merged, 'mystery')).toMatchObject({ id: 'claude-opus-6', matchKind: 'pattern' })
    // Exactly where it stands without the fetched file: after the shipped
    // entries, wherever the fetched file lists the model.
    expect(placed(merged, 'anthropic.claude-opus-6-v1:0')).toMatchObject({ id: 'claude-opus-5-5', matchKind: 'pattern' })
    const alone = inUse(null, overlay)
    for (const name of NAMES) expect(placed(merged, name), name).toEqual(placed(alone, name))
  })
})
