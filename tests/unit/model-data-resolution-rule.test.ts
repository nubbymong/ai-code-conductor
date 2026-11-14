/**
 * Model definitions as data (2.1.3-beta.1): a fetched model file never changes
 * what a name the build already places resolves to.
 *
 * The rule (model-registry-data.ts, matchEntry in model-registry.ts): a
 * shipped model's patterns and aliases are the bundled file's, and every
 * entry that is not the fetched file's own addition is tried, shipped ones in
 * the bundled file's order, before a model only the fetched file has. So such
 * a model is reached by its exact id or one of its aliases, and beyond that
 * only by a name nothing else places. And what it takes is held to this: its
 * ID is refused only when the bundled file alone places it by an exact id or
 * an alias (a shipped name), so an id reached by an id-prefix or a pattern
 * (claude-fable-5-3, claude-opus-5-6, gpt-5.5-pro, claude-opus-6) is its own;
 * each ALIAS is refused when the bundled file alone places it by an exact id
 * or an alias, or by an id-prefix or a pattern when it does not start with the
 * model's own id (claude-fable-5-3-20270101 and claude-fable-5-3[1m] are its
 * own names; claude-opus-latest-x on claude-opus-6 is not) or when the shipped
 * entry's id starts with the model's own id too (claude-opus-4 does not own
 * claude-opus-4-7[1m]). And a dated (-YYYYMMDD) or [1m] form of ANY shipped
 * entry's id is refused for the id and for every alias, however it is
 * placed: claude-opus-4-5-20260101 is claude-opus-4-5's, never a new model's.
 * A file with a refused name is refused whole.
 *
 * A property test: a fixed list of names against a set of fetched files that
 * try to take names. Most pass every check and are put to use; one that is
 * refused is not used at all, as in the app. For every name, the registry
 * with the file says what the registry without it says, but for two cases: a
 * name that is the id or an alias of a model only the file has, and that is its
 * own by the rule above (isFilesOwn), is that model; and a name
 * nothing places without the file may be placed by such a model (that is how
 * a new family is added). Pure: no file, no network.
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

// ── The fetched files: each tries to take names. One with a third part is
// refused, for that reason; every other passes validateModelData ──

const HOSTILE: [string, (f: Loose) => void, string?][] = [
  ['a new model, listed first, with near-variants of its family\'s pattern', (f) => {
    f.models.unshift({ id: 'claude-opus-9', patterns: ['opus-', 'claude-opus', '^claude-', 'anthropic'], family: 'opus', label: 'Opus 9', fallbackPricing: HIGH })
  }],
  ['a new model, listed first, whose patterns reach every family and the other assistant', (f) => {
    f.models.unshift({ id: 'claude-haiku-9', patterns: ['claude', 'fable-', 'sonnet-', 'haiku-', 'gpt-5', 'gpt-9', 'mini'], family: 'haiku', label: 'Haiku 9', fallbackPricing: HIGH })
  }],
  ['a new Codex model, listed first, with near-variants of the Codex patterns', (f) => {
    f.models.unshift({ id: 'gpt-9', patterns: ['^gpt-9', 'gpt-5.', 'codex-', '^o9-m'], family: 'codex', label: 'GPT-9' })
  }],
  ['a new model whose id is the start of shipped models\' ids', (f) => {
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
    f.models.unshift({ id: 'claude-fable-9', patterns: ['fable-9', 'fable-5-', 'claude-fable'], aliases: ['claude-fable-9-next'], family: 'fable', label: 'Fable 9', fallbackPricing: HIGH })
    f.models.push({ id: 'claude-sonnet-9', patterns: ['sonnet-9', 'claude-sonnet'], aliases: ['claude-sonnet-9-next'], family: 'sonnet', label: 'Sonnet 9', fallbackPricing: HIGH })
  }],
  // A shipped model's aliases are the bundled file's too.
  ['a shipped alias moved to another shipped entry, listed first, with a shipped model\'s [1m] name as a second', (f) => {
    const was = find(f, 'claude-opus-5-5')
    was.aliases = was.aliases.filter((a: string) => a !== 'opus')
    const m = find(f, 'claude-opus-4-5')
    m.aliases = ['opus', 'claude-opus-4-8[1m]']
    f.models = [m, ...f.models.filter((x: Loose) => x !== m)]
  }],
  ['shipped aliases taken away: one of two, all as an empty list, all with the field', (f) => {
    find(f, 'claude-fable-5-2').aliases = ['fable']
    find(f, 'claude-opus-5-5').aliases = []
    delete find(f, 'claude-sonnet-5-5').aliases
  }],
  ['every shipped alias taken away', (f) => {
    for (const m of f.models) delete m.aliases
  }],
  // A model only the file has, with a name the build already gives to a
  // shipped entry by an id or an alias: the file is refused.
  ['a new model, listed first, that takes over its family\'s alias', (f) => {
    const was = find(f, 'claude-opus-5-5')
    was.aliases = was.aliases.filter((a: string) => a !== 'opus')
    f.models.unshift({ id: 'claude-opus-6', patterns: ['opus-6', 'opus-5-5-', 'claude-opus-'], aliases: ['opus'], family: 'opus', label: 'Opus 6', fallbackPricing: HIGH })
  }, 'models: claude-opus-6 has a name the build already places on claude-opus-5-5'],
  ['a new model with a shipped alias the shipped entry still has, as its second alias', (f) => {
    f.models.unshift({ id: 'claude-fable-9', patterns: ['fable-9'], aliases: ['claude-fable-9-next', 'fable[1m]'], family: 'fable', label: 'Fable 9', fallbackPricing: HIGH })
  }, 'models: claude-fable-9 has a name the build already places on claude-fable-5-2'],
  ['a new model with a shipped model\'s dated id as an alias', (f) => {
    f.models.unshift({ id: 'claude-opus-9', patterns: ['opus-9'], aliases: ['claude-opus-4-8-20260101'], family: 'opus', label: 'Opus 9', fallbackPricing: HIGH })
  }, 'models: claude-opus-9 has a name the build already places on claude-opus-4-8'],
  ['a new model with a shipped model\'s [1m] name as an alias', (f) => {
    f.models.unshift({ id: 'claude-sonnet-9', patterns: ['sonnet-9'], aliases: ['claude-sonnet-4-6[1m]'], family: 'sonnet', label: 'Sonnet 9', fallbackPricing: HIGH })
  }, 'models: claude-sonnet-9 has a name the build already places on claude-sonnet-4-6'],
  ['a new model with a shipped id as an alias', (f) => {
    f.models.unshift({ id: 'claude-haiku-9', patterns: ['haiku-9'], aliases: ['claude-haiku-4-5'], family: 'haiku', label: 'Haiku 9', fallbackPricing: HIGH })
  }, 'models: claude-haiku-9 has a name the build already places on claude-haiku-4-5'],
  ['a new model with an alias the bundled file reaches by a pattern, that does not start with the new id', (f) => {
    f.models.unshift({ id: 'claude-opus-6', patterns: ['opus-6'], aliases: ['claude-opus-latest-x'], family: 'opus', label: 'Opus 6', fallbackPricing: HIGH })
  }, 'models: claude-opus-6 has a name the build already places on claude-opus-5-5'],
  // The new id is the start of a shipped id, so an alias that starts with the
  // new id can still be a dated or [1m] form of that shipped id: its name.
  ['a new model (claude-opus-4) with a shipped model\'s dated id as an alias, that starts with the new id', (f) => {
    f.models.unshift({ id: 'claude-opus-4', patterns: ['opus-4'], aliases: ['claude-opus-4-7-20260101'], family: 'opus', label: 'Opus 4', fallbackPricing: HIGH })
  }, 'models: claude-opus-4 has a name the build already places on claude-opus-4-7'],
  ['a new model (claude-opus-4) with a shipped model\'s [1m] name as an alias, that starts with the new id', (f) => {
    f.models.unshift({ id: 'claude-opus-4', patterns: ['opus-4'], aliases: ['claude-opus-4-7[1m]'], family: 'opus', label: 'Opus 4', fallbackPricing: HIGH })
  }, 'models: claude-opus-4 has a name the build already places on claude-opus-4-7'],
  ['a new model (claude-haiku-4) with a shipped model\'s dated id as an alias, that starts with the new id', (f) => {
    f.models.unshift({ id: 'claude-haiku-4', patterns: ['haiku-4'], aliases: ['claude-haiku-4-5-20251001'], family: 'haiku', label: 'Haiku 4', fallbackPricing: HIGH })
  }, 'models: claude-haiku-4 has a name the build already places on claude-haiku-4-5'],
  // A model only the file has, whose ID the bundled file reaches by an
  // id-prefix or a pattern (not by an exact id or an alias): the file's own,
  // with its aliases that start with that id. These are the files that add a
  // model without a release.
  ['Fable 5.3: its id is reached by the shipped claude-fable-5\'s id-prefix; its aliases start with its id', (f) => {
    f.models.unshift({ id: 'claude-fable-5-3', patterns: ['fable-5-3'], aliases: ['claude-fable-5-3[1m]', 'claude-fable-5-3-20270101'], family: 'fable', label: 'Fable 5.3', fallbackPricing: HIGH })
  }],
  ['Opus 5.6: its id is reached by the shipped claude-opus-5\'s id-prefix', (f) => {
    f.models.unshift({ id: 'claude-opus-5-6', patterns: ['opus-5-6'], family: 'opus', label: 'Opus 5.6', fallbackPricing: HIGH })
  }],
  ['a new Codex model whose id is reached by the shipped gpt-5.5\'s id-prefix', (f) => {
    f.models.unshift({ id: 'gpt-5.5-pro', patterns: [], family: 'codex', label: 'GPT-5.5 Pro' })
  }],
  ['Opus 6: its id is reached by the family pattern; its [1m] alias starts with its id', (f) => {
    f.models.unshift({ id: 'claude-opus-6', patterns: ['opus-6'], aliases: ['claude-opus-6[1m]'], family: 'opus', label: 'Opus 6', fallbackPricing: HIGH })
  }],
  ['a new model whose id is a longer form of a shipped id, but not a dated or [1m] one', (f) => {
    f.models.unshift({ id: 'claude-opus-5-5-2', patterns: [], family: 'opus', label: 'Opus 5.5.2', fallbackPricing: HIGH })
  }],
  // A model only the file has whose id is a dated or [1m] form of a shipped id
  // (of ANY shipped id, not only the one the matcher places it on): the bundled
  // file places it by an id-prefix, but it is the shipped model's name, and the
  // file's model would win it. Refused.
  ['a new model whose id is a shipped model\'s dated id', (f) => {
    f.models.unshift({ id: 'claude-opus-4-5-20260101', patterns: [], family: 'opus', label: 'Opus 4.5 (dated)', fallbackPricing: HIGH })
  }, 'models: claude-opus-4-5-20260101 has a name the build already places on claude-opus-4-5'],
  ['a new Codex model whose id is a shipped id\'s dated id', (f) => {
    f.models.unshift({ id: 'gpt-5.5-20260101', patterns: [], family: 'codex', label: 'GPT-5.5 (dated)' })
  }, 'models: gpt-5.5-20260101 has a name the build already places on gpt-5.5'],
  // The matcher places these on claude-fable-5-2 by id-prefix (they start with
  // 'claude-fable-5-2'), but each is the dated form of the shipped claude-fable-5.
  ['a new model whose id is the dated id of claude-fable-5, placed on claude-fable-5-2 by id-prefix', (f) => {
    f.models.unshift({ id: 'claude-fable-5-20260101', patterns: [], family: 'fable', label: 'Fable 5 (dated)', fallbackPricing: HIGH })
  }, 'models: claude-fable-5-20260101 has a name the build already places on claude-fable-5'],
  ['a new model whose id is another dated id of claude-fable-5', (f) => {
    f.models.unshift({ id: 'claude-fable-5-20251001', patterns: [], family: 'fable', label: 'Fable 5 (dated)', fallbackPricing: HIGH })
  }, 'models: claude-fable-5-20251001 has a name the build already places on claude-fable-5'],
  ['a new model (claude-fable-5-20) with the dated id of claude-fable-5 as an alias, that starts with the new id', (f) => {
    f.models.unshift({ id: 'claude-fable-5-20', patterns: [], aliases: ['claude-fable-5-20260101'], family: 'fable', label: 'Fable 5.20', fallbackPricing: HIGH })
  }, 'models: claude-fable-5-20 has a name the build already places on claude-fable-5'],
]

/** The validated file, as the service would put it to use. */
function checked(change: (f: Loose) => void): ModelRegistry {
  const r = validateModelData(file(change), bundled)
  if (!r.ok) throw new Error(`the file was refused, so it tests nothing: ${r.reason}`)
  return r.data
}
/** A fetched file as the service treats it: `written` is the file as it
 *  came, `data` what is put to use (nothing when the file is refused, and
 *  then `reason` says why). */
function fetched(change: (f: Loose) => void): { written: Loose; data: ModelRegistry | null; reason: string | null } {
  const written = file(change)
  const r = validateModelData(written, bundled)
  return r.ok ? { written, data: r.data, reason: null } : { written, data: null, reason: r.reason }
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

/** Whether a name a model only the fetched file has carries is the file's own
 *  (the final rule): its ID, unless the bundled file alone places it by an
 *  exact id or an alias; an ALIAS, when nothing in the bundled file places it,
 *  or when only an id-prefix or a pattern does, it starts with the model's
 *  own id and the shipped entry's id does not. Never a dated or [1m] form of
 *  the shipped entry's id (the id or the alias). A name the bundled file gives to a shipped entry by an exact id or
 *  an alias is never the file's own. */
const isFilesOwn = (name: string, kind: 'exact' | 'alias', modelId: string): boolean => {
  // A dated or [1m] form of a shipped id is that model's name, never the file's.
  // (Of ANY shipped id, not only the one the matcher placed it on.)
  const isForm = (shipped: string) => name.startsWith(shipped) && /^(-\d{8}|\[)/.test(name.slice(shipped.length))
  if (bundled.models.some((m) => isForm(m.id))) return false
  const at = placed(bundled, name)
  if (!at.known) return true
  if (at.matchKind === 'exact' || at.matchKind === 'alias') return false
  return kind === 'exact' || (name.startsWith(modelId) && !at.id.startsWith(modelId))
}

/**
 * The names a fetched file changed against the rule. `written` is the file
 * as it came, `used` whether it was put to use (a refused file is not),
 * `merged` the registry with it and `alone` the same registry without it.
 * Empty when the rule holds.
 */
function namesTaken(written: Loose, used: boolean, merged: ModelRegistry, alone: ModelRegistry): string[] {
  const shipped = new Set(bundled.models.map((m) => m.id))
  const added: Loose[] = written.models.filter((m: Loose) => !shipped.has(m.id))
  const addedIds = new Set<string>(added.map((m) => m.id))
  // What only the fetched file has, by the names that mean it outright.
  const own = new Map<string, { id: string; kind: 'exact' | 'alias' }>()
  for (const m of added) for (const a of m.aliases ?? []) if (!own.has(a)) own.set(a, { id: m.id, kind: 'alias' })
  for (const m of added) own.set(m.id, { id: m.id, kind: 'exact' })

  const wrong: string[] = []
  for (const name of [...NAMES, ...own.keys()]) {
    const got = placed(merged, name)
    const mine = own.get(name)
    // The file's own: when the file is in use, and the name is its own by
    // the rule (isFilesOwn).
    if (mine && used && isFilesOwn(name, mine.kind, mine.id)) {
      if (got.id !== mine.id || got.matchKind !== mine.kind) wrong.push(`${name}: ${got.id} (${got.matchKind}), not the file's own ${mine.id} (${mine.kind})`)
      continue
    }
    const want = placed(alone, name)
    if (JSON.stringify(got) === JSON.stringify(want)) continue
    // A name nothing places without the file may go to a model only the file has.
    if (used && !want.known && addedIds.has(got.id) && (got.matchKind === 'pattern' || got.matchKind === 'prefix')) continue
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

  it.each(HOSTILE)('%s', (_what, change, refusedFor) => {
    const { written, data, reason } = fetched(change)
    expect(namesTaken(written, data !== null, inUse(data), bundled)).toEqual([])
    // And as the window gets it: a copy sent from the main process.
    expect(namesTaken(written, data !== null, structuredClone(inUse(data)), bundled)).toEqual([])
    // A file that is refused is refused for the name it is after, and the
    // reason names the shipped entry that has it; every other file is used.
    expect(reason).toBe(refusedFor ?? null)
  })

  it('the files that are refused are the ones after a shipped id or alias, or an alias the build places and the new id does not start; the others are in use', () => {
    const refused = HOSTILE.filter(([, , refusedFor]) => refusedFor !== undefined)
    expect(refused).toHaveLength(14)
    expect(HOSTILE.length - refused.length).toBe(18)
    for (const [what, change] of HOSTILE) expect(fetched(change).data === null, what).toBe(refused.some(([w]) => w === what))
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

  it('a shipped model\'s patterns and aliases are the bundled file\'s, whatever the fetched file gives it', () => {
    for (const [what, change] of HOSTILE) {
      const merged = inUse(fetched(change).data)
      for (const b of bundled.models) {
        const m = merged.models.find((x) => x.id === b.id)
        expect(m?.patterns, `${what}: ${b.id}`).toEqual(b.patterns)
        expect(m?.aliases, `${what}: ${b.id}`).toEqual(b.aliases)
        // An entry the bundled file gives no aliases has no such field at all.
        expect(Object.keys(m ?? {}).includes('aliases'), `${what}: ${b.id}`).toBe(Object.keys(b).includes('aliases'))
      }
    }
    // The other fields a file may correct are still corrected.
    const merged = inUse(checked((f) => {
      const m = find(f, 'claude-opus-4-5'); m.patterns = ['opus']; m.aliases = ['opus']; m.label = 'Opus 4.5!'; m.fallbackPricing.input = 7
      const n = find(f, 'claude-opus-5-5'); n.aliases = ['opus[1m]']; n.label = 'Opus 5.5!'; n.fallbackPricing.input = 9
    }))
    expect(resolveModelInfo(merged, 'claude-opus-4-5')).toMatchObject({ label: 'Opus 4.5!', fallbackPricing: { input: 7 } })
    expect(resolveModelInfo(merged, 'opus')).toMatchObject({ id: 'claude-opus-5-5', matchKind: 'alias', label: 'Opus 5.5!', fallbackPricing: { input: 9 } })
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
      const { written, data } = fetched(change)
      expect(namesTaken(written, data !== null, inUse(data, OVERLAY), alone), what).toEqual([])
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
