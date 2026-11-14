import { describe, it, expect } from 'vitest'
import baselineJson from '../../resources/model-registry.json'
import { resolveModelInfo, type ModelEntry, type ModelRegistry, type OverlayModelEntry } from '../../src/shared/model-registry'

const reg = baselineJson as unknown as ModelRegistry

describe('resolveModelInfo — behaviour-identity snapshots (pin today)', () => {
  // Chart colours must match getModelColor (modelColors.ts:6-13) exactly.
  it.each([
    ['claude-fable-5', 'var(--chart-fable)'],
    ['claude-opus-4-8-20260601', 'var(--chart-opus)'],
    ['Opus 4.7 (1M context)', 'var(--chart-opus)'],
    ['claude-sonnet-4-6', 'var(--chart-sonnet)'],
    ['gpt-5.5', 'var(--chart-codex)'],
    ['o3-codex', 'var(--chart-codex)'],
    ['claude-haiku-4-5', 'var(--chart-other)'],
  ])('chart colour for %s', (model, color) => {
    expect(resolveModelInfo(reg, model).colors.chart).toBe(color)
  })
  it('haiku agentPill override preserved (registry colorOverrides)', () => {
    expect(resolveModelInfo(reg, 'haiku').colors.agentPill).toBe('var(--status-success)')
    expect(resolveModelInfo(reg, 'opus').colors.agentPill).toBe('var(--chart-opus)')
  })
  it('chart short label = family label (getModelShort parity)', () => {
    expect(resolveModelInfo(reg, 'claude-opus-4-8').chartLabel).toBe('opus')
    expect(resolveModelInfo(reg, 'claude-fable-5-20260603').chartLabel).toBe('fable')
  })
  it('alias matches resolve exactly, including opus[1m]', () => {
    // The family aliases always point at the NEWEST model in the family, so
    // this target moves with each new Opus (#385 added claude-opus-5; P4.11
    // claude-opus-5-5 and claude-sonnet-5-5, which Claude Code's opus and
    // sonnet aliases resolve to on the Anthropic API).
    expect(resolveModelInfo(reg, 'opus[1m]').id).toBe('claude-opus-5-5')
    expect(resolveModelInfo(reg, 'opus').id).toBe('claude-opus-5-5')
    expect(resolveModelInfo(reg, 'sonnet').id).toBe('claude-sonnet-5-5')
    expect(resolveModelInfo(reg, 'fable').family).toBe('fable')
  })
  it('exact + longest-prefix id matching picks the specific entry', () => {
    expect(resolveModelInfo(reg, 'claude-opus-4-8-fast').label).toBe('Opus 4.8 Fast')
    expect(resolveModelInfo(reg, 'claude-opus-4-7-20260101').label).toBe('Opus 4.7')
  })
  it('[host] P4.11: Opus 5.5 and Sonnet 5.5 are entries of their own, not Opus 5 and Sonnet 5 by prefix', () => {
    for (const [id, label] of [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-opus-5', 'Opus 5'], ['claude-sonnet-5', 'Sonnet 5']]) {
      const info = resolveModelInfo(reg, id)
      expect(info.id, id).toBe(id)
      expect(info.label, id).toBe(label)
      expect(info.matchKind, id).toBe('exact')
    }
    // Fallback prices from Anthropic's current model reference (per MTok).
    const price = (id: string) => reg.models.find((m) => m.id === id)?.fallbackPricing
    expect(price('claude-opus-5-5')).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
    expect(price('claude-sonnet-5-5')).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
  })
  it('substring pattern order is load-bearing: generic opus text lands on the first opus entry', () => {
    // Unchanged invariant (first opus entry wins); the registry is ordered
    // newest-first per family, so that entry is now claude-opus-5-5.
    expect(resolveModelInfo(reg, 'foo-opus-bar').id).toBe('claude-opus-5-5')
    expect(resolveModelInfo(reg, 'foo-opus-bar').matchKind).toBe('pattern')
  })
  it('codex family groups under the "codex" chart label (intended change vs old verbatim labels)', () => {
    expect(resolveModelInfo(reg, 'gpt-5.5').chartLabel).toBe('codex')
    expect(resolveModelInfo(reg, 'o3-codex').chartLabel).toBe('codex')
  })
})

describe('resolveModelInfo — graceful defaults for unknowns', () => {
  it('unknown model: known=false, verbatim label, deterministic hashed colour NOT a chart token', () => {
    const a = resolveModelInfo(reg, 'claude-thinking-7')
    const b = resolveModelInfo(reg, 'claude-thinking-7')
    expect(a.known).toBe(false)
    expect(a.label).toBe('claude-thinking-7')
    expect(a.colors.chart).toBe(b.colors.chart)         // deterministic
    expect(a.colors.chart).toMatch(/^#/)                 // hex from the unknown palette, never var(--chart-*)
  })
  it('unknown model: efforts null (assume-all-valid)', () => {
    expect(resolveModelInfo(reg, 'claude-thinking-7').efforts).toBeNull()
  })
  it('empty input resolves without throwing', () => {
    expect(resolveModelInfo(reg, '').known).toBe(false)
  })
})

// planning #309, item 4. A partner platform puts its own text around a model's
// id (`us.anthropic.claude-opus-4-7-v1:0`), so no id or id-prefix match helps
// and the name is placed by pattern. The first pattern in list order used to
// win, and each family's plain pattern (`opus`) sits on its newest entry, so
// an older model's id resolved, and was priced, as the newest.
describe('resolveModelInfo: the most specific pattern wins', () => {
  const entry = (id: string): ModelEntry => {
    const m = reg.models.find((x) => x.id === id)
    if (!m) throw new Error(`the bundled file has no ${id}`)
    return m
  }
  // Each family's newest entry (it holds the family alias), then its older ones.
  const FAMILIES: [string, string, string[]][] = [
    ['fable', 'claude-fable-5-2', ['claude-fable-5-1', 'claude-fable-5']],
    ['opus', 'claude-opus-5-5', ['claude-opus-5', 'claude-opus-4-8-fast', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5']],
    ['sonnet', 'claude-sonnet-5-5', ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5']],
    ['haiku', 'claude-haiku-5-5', ['claude-haiku-4-5']],
  ]
  // The forms a partner platform gives an id, and how each is placed.
  const FORMS: [string, (id: string) => string, 'pattern' | 'prefix'][] = [
    ['Bedrock', (id) => `us.anthropic.${id}-v1:0`, 'pattern'],
    ['Bedrock, dated', (id) => `anthropic.${id}-20260101-v1:0`, 'pattern'],
    ['Bedrock, by its full resource name', (id) => `arn:aws:bedrock:us-east-1:000000000000:inference-profile/global.anthropic.${id}-v1:0`, 'pattern'],
    ['Vertex', (id) => `${id}@20260101`, 'prefix'],
    ['Vertex, behind a provider name', (id) => `vertex_ai/${id}@20260101`, 'pattern'],
  ]

  it('the table names every Claude Code model the bundled file has', () => {
    const listed = FAMILIES.flatMap(([, newest, older]) => [newest, ...older]).sort()
    expect(listed).toEqual(reg.models.filter((m) => m.id.startsWith('claude-')).map((m) => m.id).sort())
    for (const [family, newest] of FAMILIES) expect(entry(newest).aliases, family).toContain(family)
  })

  describe.each(FAMILIES)('%s', (family, newest, older) => {
    it.each(FORMS)('%s: an older model\'s id is its own entry, with its own label and price', (_form, form, kind) => {
      for (const id of older) {
        const name = form(id)
        expect(resolveModelInfo(reg, name), name).toMatchObject({
          known: true, id, label: entry(id).label, matchKind: kind, fallbackPricing: entry(id).fallbackPricing,
        })
      }
    })
    it.each(FORMS)('%s: the newest model\'s id is still the newest entry', (_form, form, kind) => {
      const name = form(newest)
      expect(resolveModelInfo(reg, name), name).toMatchObject({
        known: true, id: newest, label: entry(newest).label, matchKind: kind, fallbackPricing: entry(newest).fallbackPricing,
      })
    })
    it('the newest id itself, its dated form and the family alias are the newest entry, as before', () => {
      expect(resolveModelInfo(reg, newest)).toMatchObject({ id: newest, matchKind: 'exact' })
      expect(resolveModelInfo(reg, `${newest}-20260101`)).toMatchObject({ id: newest, matchKind: 'prefix' })
      expect(resolveModelInfo(reg, family)).toMatchObject({ id: newest, matchKind: 'alias' })
    })
    it('a name with only the family in it (a display name, a version not listed) stays on the entry with the family\'s plain pattern', () => {
      const plain = reg.models.find((m) => m.patterns.includes(family))?.id
      const display = `${family[0].toUpperCase()}${family.slice(1)}`
      for (const name of [`${display} 9 (1M context)`, `my-${family}-build`, `us.anthropic.claude-${family}-9-v1:0`, `claude-3-5-${family}-20241022`]) {
        expect(resolveModelInfo(reg, name), name).toMatchObject({ known: true, id: plain, matchKind: 'pattern' })
      }
    })
    it('a version that carries on past an older entry\'s (with a hyphen or a dot) is not that entry\'s: it goes to the family\'s plain pattern', () => {
      // `opus-5` is the start of `opus-5-9` and `opus-5.9`, and names neither.
      // (Before, `fable-5-1-9` went to Fable 5.1, the first entry in list
      // order with a pattern in it; the other families' already went here.)
      const plain = reg.models.find((m) => m.patterns.includes(family))?.id
      for (const id of older.filter((x) => /\d$/.test(x))) {
        for (const name of [`us.anthropic.${id}-9-v1:0`, `anthropic/${id}.9`, `x/${id}-9`]) {
          expect(resolveModelInfo(reg, name), name).toMatchObject({ known: true, id: plain, matchKind: 'pattern' })
        }
      }
    })
  })

  it('Opus 5.5 and Sonnet 5.5 written with a dot are not Opus 5 and Sonnet 5', () => {
    expect(resolveModelInfo(reg, 'anthropic/claude-opus-5.5')).toMatchObject({ id: 'claude-opus-5-5', matchKind: 'pattern' })
    expect(resolveModelInfo(reg, 'anthropic/claude-sonnet-5.5')).toMatchObject({ id: 'claude-sonnet-5-5', matchKind: 'pattern' })
  })

  it('a dated id of Fable 5 inside a platform\'s text is Fable 5, though its year starts with a 2', () => {
    // `fable-5-2` is in `claude-fable-5-20260101`, where it stops inside the date.
    for (const name of ['anthropic.claude-fable-5-20260101-v1:0', 'us.anthropic.claude-fable-5-20251001-v1:0']) {
      expect(resolveModelInfo(reg, name), name).toMatchObject({ id: 'claude-fable-5', label: 'Fable 5', matchKind: 'pattern' })
    }
  })

  // The rule itself, on a list made for it.
  const model = (id: string, patterns: string[]): ModelEntry => ({ id, patterns, family: 'opus', label: id })
  const list = (...models: ModelEntry[]): ModelRegistry => ({ ...reg, models })
  const BEDROCK_4_7 = 'us.anthropic.claude-opus-4-7-v1:0'

  it('a longer pattern on a later entry wins over a shorter one on an earlier entry', () => {
    const r = list(model('first', ['opus']), model('second', ['opus-4-7']))
    expect(resolveModelInfo(r, BEDROCK_4_7)).toMatchObject({ id: 'second', matchKind: 'pattern' })
    expect(resolveModelInfo(r, 'us.anthropic.claude-opus-4-6-v1:0')).toMatchObject({ id: 'first', matchKind: 'pattern' })
  })

  it('an entry is as specific as its longest pattern that hits, not its longest pattern', () => {
    const r = list(model('first', ['claude-opus', 'a-much-longer-pattern-that-is-not-in-the-name']), model('second', ['claude-opus-4-7']))
    expect(resolveModelInfo(r, BEDROCK_4_7).id).toBe('second')
  })

  it('patterns of the same length: the first entry in list order wins, whichever way the list runs', () => {
    const a = model('a-entry', ['anthropic'])
    const b = model('b-entry', ['us.anthro'])
    expect(resolveModelInfo(list(a, b), BEDROCK_4_7).id).toBe('a-entry')
    expect(resolveModelInfo(list(b, a), BEDROCK_4_7).id).toBe('b-entry')
  })

  it('patterns of the same length with model data in use: the first in the bundled file\'s order wins', () => {
    const a = model('a-entry', ['anthropic'])
    const b = model('b-entry', ['us.anthro'])
    expect(resolveModelInfo({ ...list(a, b), shippedOrder: ['b-entry', 'a-entry'] }, BEDROCK_4_7).id).toBe('b-entry')
  })

  it('a pattern held to the start of the name counts by its length, as any other', () => {
    expect(resolveModelInfo(list(model('first', ['^us.']), model('second', ['opus'])), BEDROCK_4_7).id).toBe('second')
    expect(resolveModelInfo(list(model('first', ['opus']), model('second', ['^us.anthropic.'])), BEDROCK_4_7).id).toBe('second')
  })

  it('a pattern that stops inside a version number does not count: the name is another version', () => {
    // `opus-5` is the start of `opus-5-5`, and the newest entry has only the
    // family's plain pattern.
    const r = list(model('newest', ['opus']), model('older', ['opus-5']))
    for (const name of ['us.anthropic.claude-opus-5-5-v1:0', 'anthropic/claude-opus-5.5', 'x/claude-opus-5-5', 'us.anthropic.claude-opus-5-12-v1:0', 'x/claude-opus-51']) {
      expect(resolveModelInfo(r, name).id, name).toBe('newest')
    }
    // Where the version ends there, the pattern is the name's own: at the end
    // of the name, before a date (eight digits), before any other text.
    for (const name of ['x/claude-opus-5', 'us.anthropic.claude-opus-5-v1:0', 'us.anthropic.claude-opus-5-20260101-v1:0', 'vertex_ai/claude-opus-5@20260101', 'x/claude-opus-5.json', 'x/claude-opus-5-fast']) {
      expect(resolveModelInfo(r, name).id, name).toBe('older')
    }
  })

  it('a pattern found twice counts when one of the places is whole', () => {
    const r = list(model('newest', ['opus']), model('older', ['opus-5']))
    expect(resolveModelInfo(r, 'opus-5-5/claude-opus-5').id).toBe('older')
    expect(resolveModelInfo(r, 'opus-5-5/claude-opus-5-5').id).toBe('newest')
  })

  it('a pattern held to the start of the name is held to the same rule', () => {
    const r = list(model('newest', ['opus']), model('older', ['^opus-5']))
    expect(resolveModelInfo(r, 'opus-5-5-x').id).toBe('newest')
    expect(resolveModelInfo(r, 'opus-5-x').id).toBe('older')
  })

  it('a pattern that stops inside a version number still places the name when nothing covers more', () => {
    // Placed before, placed now: nothing that had a family loses it.
    expect(resolveModelInfo(list(model('only', ['opus-5'])), 'x/claude-opus-5-5')).toMatchObject({ known: true, id: 'only', matchKind: 'pattern' })
    // And the first in list order of two that count nothing, as before.
    const r = list(model('one', ['opus-5']), model('two', ['claude-opus-5']))
    expect(resolveModelInfo(r, 'x/claude-opus-5-5').id).toBe('one')
  })

  it('an entry\'s own id inside a name places nothing: only its patterns do', () => {
    expect(resolveModelInfo(list(model('claude-opus-5-5', [])), 'us.anthropic.claude-opus-5-5-v1:0').known).toBe(false)
    // In the bundled file: a name around an id whose entry has no pattern is
    // not placed, as before.
    expect(resolveModelInfo(reg, 'azure/gpt-5.5').known).toBe(false)
  })

  it('a regular expression (a hand-edited overlay only) places a name only when no plain pattern does', () => {
    const expression = model('by-expression', ['^.*opus-4-7.*$'])
    expect(resolveModelInfo(list(expression, model('by-text', ['opus'])), BEDROCK_4_7).id).toBe('by-text')
    expect(resolveModelInfo(list(expression, model('by-text', ['sonnet'])), BEDROCK_4_7)).toMatchObject({ id: 'by-expression', matchKind: 'pattern' })
    // Two expressions: the first in list order, as before.
    expect(resolveModelInfo(list(model('one', ['^us\\.']), model('two', ['^us\\.anthropic\\.claude-opus'])), BEDROCK_4_7).id).toBe('one')
  })

  it('a pattern that is not plain text and not an expression counts by its length', () => {
    const r = list(model('first', ['opus']), model('second', ['Opus 4.7']))
    expect(resolveModelInfo(r, 'Opus 4.7 (1M context)').id).toBe('second')
    expect(resolveModelInfo(r, 'Opus 4.6 (1M context)').id).toBe('first')
  })

  it('an id-prefix still comes before any pattern, however long', () => {
    const r = list(model('claude-opus-4-7', ['opus-4-7']), model('other', ['claude-opus-4-7-2026']))
    expect(resolveModelInfo(r, 'claude-opus-4-7-20260101')).toMatchObject({ id: 'claude-opus-4-7', matchKind: 'prefix' })
  })

  // What the first match in list order settled before, it still settles.
  it('the family is the first match\'s: a longer pattern in another family does not take the name', () => {
    const other: ModelEntry = { ...model('other', ['claude-opus-4-7-v1']), family: 'sonnet' }
    expect(resolveModelInfo(list(model('first', ['opus']), other), BEDROCK_4_7)).toMatchObject({ id: 'first', family: 'opus' })
    expect(resolveModelInfo(list(other, model('first', ['opus'])), BEDROCK_4_7)).toMatchObject({ id: 'other', family: 'sonnet' })
    // In the bundled file: a name with two families in it stays in the family
    // of the first entry in list order that matches, though the other's
    // pattern is the longer.
    expect(resolveModelInfo(reg, 'my-sonnet-opus-mix')).toMatchObject({ id: 'claude-opus-5-5', family: 'opus', matchKind: 'pattern' })
  })

  it('an entry the user or Sentinel added takes no name from a shipped entry, however long its pattern', () => {
    const added = (id: string, patterns: string[]): OverlayModelEntry =>
      ({ ...model(id, patterns), provenance: { addedBy: 'sentinel', date: '2026-11-14' } })
    const r = list(model('claude-opus-5-5', ['opus']), model('claude-opus-4-7', ['opus-4-7']), added('claude-opus-6', ['anthropic.claude-opus', 'opus-6']))
    // A shipped entry's own id, still its own; and a version nothing lists
    // stays where the family's plain pattern is.
    expect(resolveModelInfo(r, BEDROCK_4_7).id).toBe('claude-opus-4-7')
    expect(resolveModelInfo(r, 'us.anthropic.claude-opus-6-v1:0').id).toBe('claude-opus-5-5')
    // A name no shipped pattern matches is the added entry's, as before; and
    // among added entries the most specific takes it.
    const own = list(model('claude-opus-5-5', ['opus']), added('claude-zeta-1', ['zeta']), added('claude-zeta-2', ['zeta-2']))
    expect(resolveModelInfo(own, 'us.anthropic.claude-zeta-2-v1:0').id).toBe('claude-zeta-2')
    expect(resolveModelInfo(own, 'us.anthropic.claude-zeta-9-v1:0').id).toBe('claude-zeta-1')
  })
})
