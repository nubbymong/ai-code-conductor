/**
 * Model definitions as data (2.1.3-beta.1): the rules a fetched model file
 * must pass before the app uses it, how it joins the bundled file, and the
 * bundled file itself.
 *
 * The fetched file is text from the network, so every part of it is held to
 * a strict shape: only the fields the bundled file has, every string bounded
 * and plain, ids and patterns from a small alphabet, numbers in range, and a
 * format version so an older app ignores a newer format. A pattern is plain
 * text: nothing in the file is ever compiled into a regular expression.
 *
 * Pure: no file, no network.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import bundledJson from '../../resources/model-registry.json'
import snapshotJson from '../../resources/claude-code-model-configuration.json'
import { parseModelData, validateModelData, mergeModelData, MODEL_DATA_FORMAT } from '../../src/main/model-registry-data'
import { resolveModelInfo, evaluateModelCoverage, mergeRegistry, buildModelPickerRows, literalPattern, type ModelRegistry } from '../../src/shared/model-registry'

const bundled = bundledJson as unknown as ModelRegistry
type Loose = Record<string, any>
/** A fresh copy of the bundled file, as a fetched file would carry it. */
const file = (change?: (f: Loose) => void): Loose => {
  const f = JSON.parse(JSON.stringify(bundledJson)) as Loose
  change?.(f)
  return f
}
const NEW_MODEL = { id: 'claude-fable-6', patterns: ['fable-6'], family: 'fable', label: 'Fable 6', efforts: ['low', 'high'], fallbackPricing: { input: 6, output: 30, cacheRead: 0.15, cacheWrite: 7.5 } }
const reasonOf = (value: unknown): string => {
  const r = validateModelData(value, bundled)
  expect(r.ok, 'expected the file to be refused').toBe(false)
  return r.ok ? '' : r.reason
}

afterEach(() => { vi.restoreAllMocks() })

describe('the bundled file', () => {
  it('passes the rules a fetched file is held to, so it can be published as it is', () => {
    const r = validateModelData(file(), bundled)
    expect(r.ok ? 'ok' : r.reason).toBe('ok')
    expect((bundledJson as Loose).formatVersion).toBe(MODEL_DATA_FORMAT)
  })

  it('carries Fable 5.2 as the latest Fable, with its own prices', () => {
    const info = resolveModelInfo(bundled, 'claude-fable-5-2')
    expect(info).toMatchObject({ known: true, id: 'claude-fable-5-2', label: 'Fable 5.2', family: 'fable', matchKind: 'exact' })
    expect(info.fallbackPricing).toEqual({ input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 })
    // The family alias and a bare family name now mean 5.2; 5.1 and 5 keep their own ids.
    expect(resolveModelInfo(bundled, 'fable').id).toBe('claude-fable-5-2')
    expect(resolveModelInfo(bundled, 'some-fable-build').id).toBe('claude-fable-5-2')
    expect(resolveModelInfo(bundled, 'claude-fable-5-1').label).toBe('Fable 5.1')
    expect(resolveModelInfo(bundled, 'claude-fable-5-1-20260801').id).toBe('claude-fable-5-1')
    expect(resolveModelInfo(bundled, 'claude-fable-5').label).toBe('Fable 5')
    expect(bundled.models.filter((m) => m.aliases?.includes('fable')).map((m) => m.id)).toEqual(['claude-fable-5-2'])
    expect(buildModelPickerRows(bundled).some((r) => r.value === 'claude-fable-5-2' && r.kind === 'pinned')).toBe(true)
  })

  it('agrees with the model list shipped beside it: nothing missing, nothing called retired', () => {
    // The list shipped with this build was copied before Fable 5.2 was in
    // it, so the entry is marked as carried deliberately (articleExempt)
    // until that list is refreshed from the article.
    const r = evaluateModelCoverage(bundled, snapshotJson as never)
    expect(r.missing).toEqual([])
    expect(r.extra).toEqual([])
    expect(bundled.models.find((m) => m.id === 'claude-fable-5-2')?.articleExempt).toBe(true)
  })
})

describe('a fetched file is held to a strict shape', () => {
  it('a file that adds a model is taken', () => {
    const r = validateModelData(file((f) => { f.models.unshift(NEW_MODEL) }), bundled)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.models[0]).toEqual(NEW_MODEL)
      expect(r.data).not.toHaveProperty('formatVersion')
    }
  })

  it('text that is not JSON, or JSON that is not an object, is refused', () => {
    expect(parseModelData('{not json', bundled)).toMatchObject({ ok: false, reason: 'not JSON' })
    expect(parseModelData('[]', bundled).ok).toBe(false)
    expect(parseModelData('null', bundled).ok).toBe(false)
    expect(parseModelData(JSON.stringify(file()), bundled).ok).toBe(true)
  })

  it('a newer format is ignored by this version, and says so; no format is refused', () => {
    expect(reasonOf(file((f) => { f.formatVersion = MODEL_DATA_FORMAT + 1 }))).toBe(`format ${MODEL_DATA_FORMAT + 1} is newer than this version reads (${MODEL_DATA_FORMAT})`)
    expect(reasonOf(file((f) => { delete f.formatVersion }))).toMatch(/format/)
    expect(reasonOf(file((f) => { f.formatVersion = '1' }))).toMatch(/format/)
    expect(reasonOf(file((f) => { f.formatVersion = 0 }))).toMatch(/format/)
    expect(reasonOf(file((f) => { f.formatVersion = 1.5 }))).toMatch(/format/)
  })

  it.each([
    ['at the top', (f: Loose) => { f.extra = 1 }],
    ['on a model', (f: Loose) => { f.models[0].color = '#ffffff' }],
    ['on a model (provenance)', (f: Loose) => { f.models[0].provenance = { addedBy: 'user', date: '2026-01-01' } }],
    ['in a price', (f: Loose) => { f.models[0].fallbackPricing.batch = 1 }],
    ['on a family', (f: Loose) => { f.families.fable.icon = 'x' }],
    ['in a family\'s colour overrides', (f: Loose) => { f.families.haiku.colorOverrides.chart = '#ffffff' }],
    ['on an effort level', (f: Loose) => { f.effortLevels[0].order = 1 }],
    ['for another provider\'s efforts', (f: Loose) => { f.providerEffortLevels.other = f.providerEffortLevels.codex }],
    ['on a picker row', (f: Loose) => { f.dropdown[0].icon = 'x' }],
  ])('an unknown field %s is refused', (_where, change) => {
    reasonOf(file(change))
  })

  it('a __proto__ key is refused, wherever it is', () => {
    const text = JSON.stringify(file()).replace('"families":{', '"families":{"__proto__":{"label":"x","color":"#ffffff"},')
    expect(text).toContain('__proto__')
    expect(parseModelData(text, bundled).ok).toBe(false)
    const onModel = JSON.stringify(file()).replace('{"id":"claude-opus-5-5",', '{"__proto__":{"pickable":false},"id":"claude-opus-5-5",')
    expect(onModel).toContain('__proto__')
    expect(parseModelData(onModel, bundled).ok).toBe(false)
  })

  it.each([
    ['upper case', 'Claude-Fable-6'],
    ['a space', 'claude fable'],
    ['a leading hyphen (reads as a flag)', '-rf'],
    ['a newline', 'claude-fable-6\n/exit'],
    ['a slash', 'claude/fable'],
    ['a bracket', 'claude[1m]'],
    ['65 characters', 'c'.repeat(65)],
    ['nothing', ''],
  ])('a model id with %s is refused', (_what, id) => {
    reasonOf(file((f) => { f.models.unshift({ ...NEW_MODEL, id }) }))
  })

  it('a model id that is not text, or is listed twice, is refused', () => {
    reasonOf(file((f) => { f.models.unshift({ ...NEW_MODEL, id: 7 }) }))
    expect(reasonOf(file((f) => { f.models.unshift({ ...f.models[0] }) }))).toMatch(/more than once/)
  })

  it.each([
    ['a regular expression', '(a+)+$'],
    ['an end anchor', 'fable$'],
    ['a class', '[a-z]+'],
    ['an alternative', 'opus|sonnet'],
    ['a wildcard', '.*'],
    ['upper case', 'Fable'],
    ['a caret that is not first', 'fa^ble'],
    ['a caret alone', '^'],
    ['65 characters', 'f'.repeat(65)],
    ['nothing', ''],
  ])('a pattern that is %s is refused', (_what, pattern) => {
    reasonOf(file((f) => { f.models.unshift({ ...NEW_MODEL, patterns: [pattern] }) }))
  })

  it('too many of anything is refused', () => {
    reasonOf(file((f) => { f.models.unshift({ ...NEW_MODEL, patterns: Array.from({ length: 9 }, (_, i) => `p${i}`) }) }))
    reasonOf(file((f) => { f.models.unshift({ ...NEW_MODEL, aliases: Array.from({ length: 9 }, (_, i) => `a${i}`) }) }))
    reasonOf(file((f) => { f.models = Array.from({ length: 257 }, (_, i) => ({ ...NEW_MODEL, id: `claude-x-${i}` })) }))
    reasonOf(file((f) => { f.models = [] }))
    reasonOf(file((f) => { f.dropdown = Array.from({ length: 33 }, (_, i) => ({ value: `v${i}`, label: 'x' })) }))
  })

  it.each([
    ['a label too long', (f: Loose) => { f.models[0].label = 'x'.repeat(65) }],
    ['an empty label', (f: Loose) => { f.models[0].label = '' }],
    ['a label with a control character', (f: Loose) => { f.models[0].label = 'Fable\u001b[31m' }],
    ['a label with a newline', (f: Loose) => { f.models[0].label = 'Fable\n6' }],
    ['a label with a hidden direction mark', (f: Loose) => { f.models[0].label = 'Fable‮6' }],
    ['a label with a zero-width space', (f: Loose) => { f.models[0].label = 'Fa​ble' }],
    ['a label that is not text', (f: Loose) => { f.models[0].label = 6 }],
    ['a hint too long', (f: Loose) => { f.dropdown[0].hint = 'x'.repeat(161) }],
    ['an alias with a space', (f: Loose) => { f.models[0].aliases = ['fable now'] }],
    ['an alias that reads as a flag', (f: Loose) => { f.models[0].aliases = ['--help'] }],
    ['a Codex model with an alias its launch does not take', (f: Loose) => { f.models.unshift({ id: 'gpt-7', patterns: [], family: 'codex', label: 'GPT-7', aliases: ['gpt-7[1m]'] }) }],
    ['a picker value with a newline', (f: Loose) => { f.dropdown[0].value = 'opus\n/exit' }],
    ['an effort that is not a plain word', (f: Loose) => { f.effortLevels[0].value = 'low; rm' }],
    ['a family name with upper case', (f: Loose) => { f.families.Fable = f.families.fable }],
  ])('%s is refused', (_what, change) => {
    reasonOf(file(change))
  })

  it.each([
    ['an address', 'url(https://example.com/x.png)'],
    ['a second declaration', 'red; background: url(x)'],
    ['a name', 'red'],
    ['a short hex', '#fff'],
    ['a variable with a fallback', 'var(--x, url(y))'],
    ['an expression', 'expression(alert(1))'],
  ])('a colour that is %s is refused: only a theme variable or a six-digit hex', (_what, color) => {
    reasonOf(file((f) => { f.families.fable.color = color }))
    reasonOf(file((f) => { f.families.haiku.colorOverrides.agentPill = color }))
  })

  it.each([
    ['negative', -1],
    ['beyond the range', 100001],
    ['text', '8'],
    ['nothing', null],
  ])('a price that is %s is refused', (_what, price) => {
    reasonOf(file((f) => { f.models[0].fallbackPricing.input = price }))
  })

  it('a price that is not a finite number is refused', () => {
    // JSON has no way to write these, so they are given as values.
    for (const price of [Number.NaN, Number.POSITIVE_INFINITY]) reasonOf(file((f) => { f.models[0].fallbackPricing.output = price }))
    expect(parseModelData(JSON.stringify(file()).replace('"input":8,', '"input":1e999,'), bundled).ok).toBe(false)
  })

  it('a reason names where the fault is by the file\'s own field names, never by a name the file made up', () => {
    const reason = reasonOf(file((f) => { f.families['made-up-name'] = { label: 'x', color: 'not a colour' } }))
    expect(reason).toBe('families.(a name).color: invalid_format')
    expect(reasonOf(file((f) => { f.models[2].fallbackPricing.input = -1 }))).toBe('models.2.fallbackPricing.input: too_small')
  })

  it('a model in a family the file does not define is refused', () => {
    expect(reasonOf(file((f) => { f.models.unshift({ ...NEW_MODEL, family: 'mythos' }) }))).toMatch(/family/)
  })

  it('an effort a model lists must be one of its provider\'s effort levels', () => {
    expect(reasonOf(file((f) => { f.models.unshift({ ...NEW_MODEL, efforts: ['ludicrous'] }) }))).toMatch(/effort/)
    // Codex's own level is not one of Claude Code's.
    expect(reasonOf(file((f) => { f.models.unshift({ ...NEW_MODEL, efforts: ['ultra'] }) }))).toMatch(/effort/)
    expect(validateModelData(file((f) => { f.models.unshift({ id: 'gpt-7', patterns: [], family: 'codex', label: 'GPT-7', efforts: ['ultra'] }) }), bundled).ok).toBe(true)
  })

  it('a model the bundled file carries cannot be moved to the other assistant', () => {
    expect(reasonOf(file((f) => { f.models.find((m: Loose) => m.id === 'gpt-5.5').family = 'opus' }))).toMatch(/assistant/)
    expect(reasonOf(file((f) => { const m = f.models.find((x: Loose) => x.id === 'claude-opus-5-5'); m.family = 'codex'; delete m.aliases }))).toMatch(/assistant/)
  })
})

describe('how a fetched file joins the bundled one', () => {
  const fetched = (change: (f: Loose) => void): ModelRegistry => {
    const r = validateModelData(file(change), bundled)
    if (!r.ok) throw new Error(r.reason)
    return r.data
  }

  it('no fetched file: the bundled file as it is', () => {
    expect(mergeModelData(bundled, null, '2026-11-14')).toBe(bundled)
  })

  it('a new model is in the list, in the file\'s order, and both pickers get it', () => {
    const merged = mergeModelData(bundled, fetched((f) => { f.models.unshift(NEW_MODEL) }), '2026-11-14')
    expect(merged.models[0].id).toBe('claude-fable-6')
    expect(buildModelPickerRows(merged).some((r) => r.value === 'claude-fable-6')).toBe(true)
    expect(resolveModelInfo(merged, 'claude-fable-6-20270101')).toMatchObject({ known: true, label: 'Fable 6' })
    expect(resolveModelInfo(merged, 'claude-fable-6').fallbackPricing).toEqual(NEW_MODEL.fallbackPricing)
  })

  it('a model this build does not carry is marked as added from the model data, so it is never called possibly retired', () => {
    const merged = mergeModelData(bundled, fetched((f) => { f.models.unshift(NEW_MODEL) }), '2026-11-14')
    expect(merged.models[0]).toMatchObject({ provenance: { addedBy: 'model-data', date: '2026-11-14' } })
    expect(merged.models.filter((m) => 'provenance' in m).map((m) => m.id)).toEqual(['claude-fable-6'])
    const coverage = evaluateModelCoverage(merged, snapshotJson as never)
    expect(coverage.extra).toEqual([])
    // And once the article lists it, it is covered.
    expect(evaluateModelCoverage(merged, { models: [{ id: 'claude-fable-6' }] }).missing).toEqual([])
  })

  it('the fetched entry wins for a model both carry', () => {
    const merged = mergeModelData(bundled, fetched((f) => { f.models.find((m: Loose) => m.id === 'claude-opus-5-5').fallbackPricing.input = 3 }), '2026-11-14')
    expect(resolveModelInfo(merged, 'claude-opus-5-5').fallbackPricing?.input).toBe(3)
    expect(merged.models.filter((m) => m.id === 'claude-opus-5-5')).toHaveLength(1)
  })

  it('a model the fetched file leaves out stays, after the file\'s own, so the file cannot take a model away', () => {
    const merged = mergeModelData(bundled, fetched((f) => { f.models = f.models.filter((m: Loose) => m.id !== 'claude-opus-4-6') }), '2026-11-14')
    expect(merged.models.map((m) => m.id)).toContain('claude-opus-4-6')
    expect(merged.models[merged.models.length - 1].id).toBe('claude-opus-4-6')
    expect(merged.models).toHaveLength(bundled.models.length)
  })

  it('a family the fetched file leaves out stays too, and the file\'s levels and picker rows are used', () => {
    const merged = mergeModelData(bundled, fetched((f) => {
      f.models = f.models.filter((m: Loose) => m.family !== 'haiku')
      delete f.families.haiku
      f.dropdown = f.dropdown.filter((d: Loose) => d.value !== 'haiku')
      f.effortLevels[0].label = 'Lowest'
    }), '2026-11-14')
    expect(merged.families.haiku).toEqual(bundled.families.haiku)
    expect(resolveModelInfo(merged, 'claude-haiku-5-5').known).toBe(true)
    expect(merged.dropdown.some((d) => d.value === 'haiku')).toBe(false)
    expect(merged.effortLevels[0].label).toBe('Lowest')
    expect(merged.providerEffortLevels?.codex).toEqual(bundled.providerEffortLevels?.codex)
  })

  it('the bundled file is not changed by a merge', () => {
    const before = JSON.stringify(bundled)
    mergeModelData(bundled, fetched((f) => { f.models.unshift(NEW_MODEL); f.families.fable.label = 'fbl' }), '2026-11-14')
    expect(JSON.stringify(bundled)).toBe(before)
  })

  it('the user\'s own overlay still wins over the fetched file', () => {
    const merged = mergeModelData(bundled, fetched((f) => { f.models.unshift(NEW_MODEL) }), '2026-11-14')
    const withOverlay = mergeRegistry(merged, { models: [{ ...NEW_MODEL, label: 'My Fable', provenance: { addedBy: 'user', date: '2026-11-14' } }] })
    expect(resolveModelInfo(withOverlay, 'claude-fable-6').label).toBe('My Fable')
  })
})

describe('a pattern is plain text, never compiled', () => {
  it('the plain forms: text, or text that must start the name', () => {
    expect(literalPattern('fable-5')).toEqual({ text: 'fable-5', atStart: false })
    expect(literalPattern('^gpt-')).toEqual({ text: 'gpt-', atStart: true })
    for (const p of ['(a+)+$', 'fable$', '^', '', 'Fable', '^^gpt', '.*', 'a b']) expect(literalPattern(p), p).toBeNull()
  })

  it('resolving a name against the bundled and fetched patterns never builds a regular expression', () => {
    const merged = mergeModelData(bundled, (() => {
      const r = validateModelData(file((f) => { f.models.unshift({ ...NEW_MODEL, patterns: ['^fable-six', 'six.fable'] }) }), bundled)
      if (!r.ok) throw new Error(r.reason)
      return r.data
    })(), '2026-11-14')
    const built = vi.spyOn(globalThis, 'RegExp')
    // Reached by a start-anchored pattern, by a plain one, and not at all.
    expect(resolveModelInfo(merged, 'fable-six-preview').id).toBe('claude-fable-6')
    expect(resolveModelInfo(merged, 'my-fable-six').id).not.toBe('claude-fable-6')
    expect(resolveModelInfo(merged, 'a-six.fable-b').id).toBe('claude-fable-6')
    // A dot is a dot, not "any character".
    expect(resolveModelInfo(merged, 'a-sixxfable-b').id).not.toBe('claude-fable-6')
    expect(resolveModelInfo(merged, 'gpt-9-nova')).toMatchObject({ known: true, id: 'codex-family', matchKind: 'pattern' })
    expect(resolveModelInfo(merged, 'o9-mini').id).toBe('codex-family')
    expect(resolveModelInfo(merged, 'no-such-model').known).toBe(false)
    expect(built).not.toHaveBeenCalled()
  })

  it('a hand-written overlay pattern that is a real expression still works as before', () => {
    const withOverlay = mergeRegistry(bundled, { models: [{ id: 'x-1', patterns: ['^zeta-(one|two)$'], family: 'opus', label: 'X', provenance: { addedBy: 'user', date: '2026-11-14' } }] })
    expect(resolveModelInfo(withOverlay, 'zeta-two').id).toBe('x-1')
    expect(resolveModelInfo(withOverlay, 'zeta-three').known).toBe(false)
  })
})
