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
import { createHash } from 'crypto'
import bundledJson from '../../resources/model-registry.json'
import snapshotJson from '../../resources/claude-code-model-configuration.json'
import { parseModelData, validateModelData, mergeModelData, MODEL_DATA_FORMAT } from '../../src/main/model-registry-data'
import { resolveModelInfo, evaluateModelCoverage, mergeRegistry, buildModelPickerRows, effortLevelsFor, literalPattern, type ModelRegistry } from '../../src/shared/model-registry'

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

  it('carries a revision, the date of its last edit as a whole number, so an older copy can be told from a newer one', () => {
    const revision = (bundledJson as Loose).revision
    expect(Number.isInteger(revision)).toBe(true)
    expect(revision).toBeGreaterThanOrEqual(20261114)
    const r = validateModelData(file(), bundled)
    expect(r.ok && r.revision).toBe(revision)
  })

  // The revision only orders the files if it is raised with every edit, and
  // nothing else can check that: an install uses a fetched file or a kept
  // copy whenever its revision is not lower than the bundled one. So the
  // file's content is pinned here beside its revision. An edit to
  // resources/model-registry.json fails this test until BOTH are updated:
  // set "revision" in the file to today's date (YYYYMMDD, higher than the
  // one pinned), then pin the new revision and the digest the failure prints.
  it('its revision is raised with every edit (the content is pinned beside the revision)', () => {
    const PINNED = { revision: 20261114, digest: '8bb8ca0eb493501f0f6c45b6ac77ed7f44693efa23f0cec7a1243092810bb1b1' }
    const { revision, ...content } = bundledJson as Loose
    const digest = createHash('sha256').update(JSON.stringify(content)).digest('hex')
    expect({ revision, digest }, 'resources/model-registry.json changed: raise its "revision" to today\'s date, then pin the new revision and digest here').toEqual(PINNED)
  })

  it('carries Fable 5.2 as the latest Fable, with its own prices', () => {
    const info = resolveModelInfo(bundled, 'claude-fable-5-2')
    expect(info).toMatchObject({ known: true, id: 'claude-fable-5-2', label: 'Fable 5.2', family: 'fable', matchKind: 'exact' })
    expect(info.fallbackPricing).toEqual({ input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 })
    // The family alias and a bare family name now mean 5.2; 5.1 and 5 keep their own ids.
    expect(resolveModelInfo(bundled, 'fable').id).toBe('claude-fable-5-2')
    expect(resolveModelInfo(bundled, 'fable[1m]')).toMatchObject({ id: 'claude-fable-5-2', matchKind: 'alias' })
    expect(resolveModelInfo(bundled, 'claude-fable-5-1').label).toBe('Fable 5.1')
    expect(resolveModelInfo(bundled, 'claude-fable-5-1-20260801').id).toBe('claude-fable-5-1')
    expect(resolveModelInfo(bundled, 'claude-fable-5').label).toBe('Fable 5')
    expect(bundled.models.filter((m) => m.aliases?.includes('fable')).map((m) => m.id)).toEqual(['claude-fable-5-2'])
    expect(buildModelPickerRows(bundled).some((r) => r.value === 'claude-fable-5-2' && r.kind === 'pinned')).toBe(true)
  })

  // Review finding: Fable 5.2 held the plain pattern 'fable', so a partner
  // platform's id for an OLDER Fable (which starts with the platform's own
  // prefix, so no id or id-prefix match helps) was read, and priced, as 5.2.
  it.each([
    ['anthropic.claude-fable-5-2-v1:0', 'claude-fable-5-2', 8],
    ['anthropic.claude-fable-5-1-v1:0', 'claude-fable-5-1', 10],
    ['vertex/claude-fable-5-1@20261001', 'claude-fable-5-1', 10],
    ['us.anthropic.claude-fable-5-v1:0', 'claude-fable-5', 10],
    ['vertex/claude-fable-5@20260801', 'claude-fable-5', 10],
  ])('a partner platform\'s id %s is its own Fable version, with its own price', (id, entry, input) => {
    const info = resolveModelInfo(bundled, id)
    expect(info).toMatchObject({ known: true, id: entry, matchKind: 'pattern' })
    expect(info.fallbackPricing?.input).toBe(input)
  })

  it('a Fable name no entry names (a display name, a version not listed yet) is still in the Fable family', () => {
    for (const name of ['Fable 5.2', 'Fable 5.1 (1M context)', 'some-fable-build', 'claude-fable-9']) {
      expect(resolveModelInfo(bundled, name), name).toMatchObject({ known: true, family: 'fable', matchKind: 'pattern' })
    }
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
    ['beyond the range', 1000.01],
    ['far beyond any real price', 100000],
    ['text', '8'],
    ['nothing', null],
  ])('a price that is %s is refused', (_what, price) => {
    reasonOf(file((f) => { f.models[0].fallbackPricing.input = price }))
  })

  it('a price up to 1000 per million tokens is taken', () => {
    expect(validateModelData(file((f) => { f.models[0].fallbackPricing.input = 1000 }), bundled).ok).toBe(true)
  })

  it.each([
    ['missing', (f: Loose) => { delete f.revision }],
    ['zero', (f: Loose) => { f.revision = 0 }],
    ['not a whole number', (f: Loose) => { f.revision = 20261114.5 }],
    ['text', (f: Loose) => { f.revision = '20261114' }],
    ['beyond eight digits', (f: Loose) => { f.revision = 100000000 }],
  ])('a revision that is %s is refused', (_what, change) => {
    expect(reasonOf(file(change))).toMatch(/^revision: /)
  })

  // Review finding: a model whose id is only the start of a name ("claude")
  // matched every later name that starts with it, so one entry could take
  // the label and the price of every model the registry does not list yet.
  it.each([
    ['only the start of every Claude name', { ...NEW_MODEL, id: 'claude', patterns: [] }],
    ['a family with no version', { ...NEW_MODEL, id: 'claude-fable', patterns: [] }],
    ['a family and a hyphen', { ...NEW_MODEL, id: 'claude-fable-', patterns: [] }],
    // The same length as `claude-fable-` and a digit after it: only the family in the name tells them apart.
    ['another family\'s name', { ...NEW_MODEL, id: 'claude-opus-10', patterns: [] }],
    ['only the start of every GPT name', { id: 'gpt', patterns: [], family: 'codex', label: 'GPT' }],
    ['one letter', { id: 'o', patterns: [], family: 'codex', label: 'O' }],
  ])('a new model whose id is %s is refused', (_what, model) => {
    expect(reasonOf(file((f) => { f.models.unshift(model) }))).toMatch(/not a full model name/)
  })

  it('a new model with a full name is taken, and a shipped id is never held to the rule', () => {
    for (const model of [NEW_MODEL, { ...NEW_MODEL, id: 'claude-fable-6-1-fast' }, { id: 'gpt-7', patterns: [], family: 'codex', label: 'GPT-7' }, { id: 'o5', patterns: [], family: 'codex', label: 'o5' }]) {
      const r = validateModelData(file((f) => { f.models.unshift(model) }), bundled)
      expect(r.ok ? 'ok' : r.reason, model.id).toBe('ok')
    }
    // codex-family has no digit in it: it is the bundled file's own entry.
    expect(bundled.models.some((m) => m.id === 'codex-family')).toBe(true)
    expect(validateModelData(file(), bundled).ok).toBe(true)
  })

  it('a new pattern shorter than four characters is refused: it would match almost any name', () => {
    for (const pattern of ['a', '-', 'gpt', '^o', '^cl']) {
      expect(reasonOf(file((f) => { f.models.unshift({ ...NEW_MODEL, patterns: [pattern] }) })), pattern).toMatch(/pattern/)
      // On a shipped model too, when the bundled entry does not have it.
      expect(reasonOf(file((f) => { f.models[0].patterns = [...f.models[0].patterns, pattern] })), pattern).toMatch(/pattern/)
    }
    // The bundled file's own short pattern (^o, on its Codex catch-all) stays.
    expect(bundled.models.find((m) => m.id === 'codex-family')?.patterns).toContain('^o')
    expect(validateModelData(file(), bundled).ok).toBe(true)
    expect(validateModelData(file((f) => { f.models.unshift({ ...NEW_MODEL, patterns: ['fabl'] }) }), bundled).ok).toBe(true)
  })

  // Review finding: a model the build does not ship could carry a pattern
  // the bundled file has on one of its own entries ('opus', which Opus 5.5
  // holds for every Opus name not listed). The file's models come first in
  // the joined list, so every such name was read, and priced, as the new one.
  const NEW_OPUS = { id: 'claude-opus-6', patterns: ['opus-6'], family: 'opus', label: 'Opus 6', fallbackPricing: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 } }
  it.each([
    ['its family\'s own', { ...NEW_OPUS, patterns: ['opus-6', 'opus'] }, 'claude-opus-5-5'],
    ['the same text, held to the start of the name', { ...NEW_OPUS, patterns: ['^opus'] }, 'claude-opus-5-5'],
    ['another family\'s', { ...NEW_MODEL, patterns: ['fable-6', 'sonnet'] }, 'claude-sonnet-5-5'],
    ['a listed version\'s', { ...NEW_MODEL, patterns: ['fable-5-1'] }, 'claude-fable-5-1'],
    ['the other assistant\'s, without its hold on the start', { id: 'gpt-7', patterns: ['gpt-'], family: 'codex', label: 'GPT-7' }, 'codex-family'],
  ])('a new model with a pattern the build already has on another entry (%s) is refused, and the reason names that entry', (_what, model, keeper) => {
    expect(reasonOf(file((f) => { f.models.unshift(model) }))).toBe(`models: ${model.id} has a pattern the build already has on ${keeper}`)
  })

  it('when the build has the pattern on two entries, the reason names the first: the one a name reaches', () => {
    const twice = file((f) => { f.models.find((m: Loose) => m.id === 'claude-opus-4-5').patterns.push('opus') }) as unknown as ModelRegistry
    const r = validateModelData(file((f) => { f.models.unshift({ ...NEW_OPUS, patterns: ['opus'] }) }), twice)
    expect(r).toEqual({ ok: false, reason: 'models: claude-opus-6 has a pattern the build already has on claude-opus-5-5' })
  })

  it('a new model with a pattern of its own is taken, and a name no entry lists stays with the build\'s entry and its price', () => {
    const r = validateModelData(file((f) => { f.models.unshift(NEW_OPUS) }), bundled)
    expect(r.ok ? 'ok' : r.reason).toBe('ok')
    const merged = mergeModelData(bundled, r.ok ? r.data : null, '2026-11-14')
    expect(resolveModelInfo(merged, 'claude-opus-6')).toMatchObject({ id: 'claude-opus-6', matchKind: 'exact', label: 'Opus 6' })
    // The new model is its exact id (and its aliases). A name the build
    // already places, a dated or a partner platform's form of the new id
    // among them, stays where the build has it: the file never moves one
    // (tests/unit/model-data-resolution-rule.test.ts).
    const shippedPrice = bundled.models.find((m) => m.id === 'claude-opus-5-5')?.fallbackPricing
    for (const name of ['claude-opus-6-20270101', 'anthropic.claude-opus-6-v1:0', 'anthropic.claude-opus-9-v1:0', 'Opus 9 (1M context)']) {
      const info = resolveModelInfo(merged, name)
      expect(info, name).toMatchObject({ id: 'claude-opus-5-5', matchKind: 'pattern' })
      expect(info.fallbackPricing, name).toEqual(shippedPrice)
    }
    // A shipped model keeps every pattern the bundled file gives it.
    expect(validateModelData(file(), bundled).ok).toBe(true)
  })

  // The naming rule for a model the build does not ship: its ID is refused when
  // the bundled file places it by an exact id or an alias, or when it is a dated
  // (-YYYYMMDD) or [1m] form of a shipped id; each ALIAS is refused when the
  // bundled file places it by an exact id or an alias, by an id-prefix or a
  // pattern when it does not start with the model's own id (or when the shipped
  // id starts with it too), or when it is a dated or [1m] form of a shipped id.
  const HIGH_PRICE = { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 }
  it.each([
    ['Fable 5.3 with its [1m] and dated names', { id: 'claude-fable-5-3', patterns: ['fable-5-3'], aliases: ['claude-fable-5-3[1m]', 'claude-fable-5-3-20270101'], family: 'fable', label: 'Fable 5.3', fallbackPricing: HIGH_PRICE }],
    ['Opus 5.6', { id: 'claude-opus-5-6', patterns: ['opus-5-6'], family: 'opus', label: 'Opus 5.6', fallbackPricing: HIGH_PRICE }],
    ['a Codex model after the shipped gpt-5.5', { id: 'gpt-5.5-pro', patterns: [], family: 'codex', label: 'GPT-5.5 Pro' }],
    ['Opus 6 with an alias that starts with its id', { id: 'claude-opus-6', patterns: ['opus-6'], aliases: ['claude-opus-6[1m]'], family: 'opus', label: 'Opus 6', fallbackPricing: HIGH_PRICE }],
    ['Opus 6 with an alias that starts with its id and has a date-like tail only by length, not after a shipped id', { id: 'claude-opus-6', patterns: ['opus-6'], aliases: ['claude-opus-6-x-20260101'], family: 'opus', label: 'Opus 6', fallbackPricing: HIGH_PRICE }],
    ['Opus 5.5.2: a longer form of a shipped id that is not a dated or [1m] one', { id: 'claude-opus-5-5-2', patterns: [], family: 'opus', label: 'Opus 5.5.2', fallbackPricing: HIGH_PRICE }],
    // Written with a dot, as the same names written with a hyphen: no shipped
    // id is one of these read either way, nor a dated or [1m] form of one.
    ['Fable 5.3 written with a dot, with its [1m] and dated names', { id: 'claude-fable-5.3', patterns: [], aliases: ['claude-fable-5.3[1m]', 'claude-fable-5.3-20270101'], family: 'fable', label: 'Fable 5.3', fallbackPricing: HIGH_PRICE }],
    ['Opus 5.5.2 written with dots', { id: 'claude-opus-5.5.2', patterns: [], family: 'opus', label: 'Opus 5.5.2', fallbackPricing: HIGH_PRICE }],
    ['Opus 4.7 with more text after it, written with a dot, and its own dated name', { id: 'claude-opus-4.7-x', patterns: [], aliases: ['claude-opus-4.7-x-20270101'], family: 'opus', label: 'Opus 4.7 X', fallbackPricing: HIGH_PRICE }],
    // A new model's own id written the other way, a dot for a hyphen or a
    // hyphen for a dot, is its own name too: the alias starts with the id
    // when the two are read the same way. The build reaches these names by
    // the id of an older model, which is shorter, or by a pattern.
    ['Opus 5.7 with its id written with a dot', { id: 'claude-opus-5-7', patterns: [], aliases: ['claude-opus-5.7'], family: 'opus', label: 'Opus 5.7', fallbackPricing: HIGH_PRICE }],
    ['Opus 5.7 with its dated id written with a dot', { id: 'claude-opus-5-7', patterns: [], aliases: ['claude-opus-5.7-20270101'], family: 'opus', label: 'Opus 5.7', fallbackPricing: HIGH_PRICE }],
    ['Opus 5.7 written with a dot, with its id written with a hyphen', { id: 'claude-opus-5.7', patterns: [], aliases: ['claude-opus-5-7'], family: 'opus', label: 'Opus 5.7', fallbackPricing: HIGH_PRICE }],
    ['Opus 5.7 written with a dot, with its dated and [1m] names written with a hyphen', { id: 'claude-opus-5.7', patterns: [], aliases: ['claude-opus-5-7-20270101', 'claude-opus-5-7[1m]'], family: 'opus', label: 'Opus 5.7', fallbackPricing: HIGH_PRICE }],
    ['Opus 6.1, which only a pattern places, with its plain, dated and [1m] names written with a dot', { id: 'claude-opus-6-1', patterns: ['opus-6-1'], aliases: ['claude-opus-6.1', 'claude-opus-6.1-20270101', 'claude-opus-6.1[1m]'], family: 'opus', label: 'Opus 6.1', fallbackPricing: HIGH_PRICE }],
    ['a longer form of a shipped id, with the same name written with a dot', { id: 'claude-opus-4-7-x', patterns: [], aliases: ['claude-opus-4.7-x'], family: 'opus', label: 'Opus 4.7 X', fallbackPricing: HIGH_PRICE }],
    ['a Codex model written with a dot, with its id written with a hyphen', { id: 'gpt-7.1', patterns: [], aliases: ['gpt-7-1'], family: 'codex', label: 'GPT-7.1' }],
    // Beside the Codex ids the build ships, which are written with a dot
    // (gpt-5.5, gpt-5.6-sol): a new model still has its own id written with a
    // hyphen, and the names that carry on from it, when no shipped id read
    // the same way starts the name as well, or when its own id is the longer
    // start of it.
    ['a new Codex version beside the shipped ones, with its id written with a hyphen and the names that carry on from that', { id: 'gpt-5.6', patterns: [], aliases: ['gpt-5-6', 'gpt-5-6-mini', 'gpt-5-6-20270101'], family: 'codex', label: 'GPT-5.6' }],
    ['a new Codex version written with a hyphen, with its id written with a dot', { id: 'gpt-5-7', patterns: [], aliases: ['gpt-5.7', 'gpt-5-7-20270101'], family: 'codex', label: 'GPT-5.7' }],
    ['a Codex model after the shipped gpt-5.5, with its id written with hyphens: its own id is the longer start of those names', { id: 'gpt-5.5-pro', patterns: [], aliases: ['gpt-5-5-pro', 'gpt-5-5-pro-20270101'], family: 'codex', label: 'GPT-5.5 Pro' }],
    // Taken before that as well: the alias starts with the id as the two are
    // written, and not once the dot that ends the id is read as a hyphen.
    ['an id that ends in a dot, with a name that carries on from it', { id: 'claude-opus-9.', patterns: [], aliases: ['claude-opus-9.5'], family: 'opus', label: 'Opus 9', fallbackPricing: HIGH_PRICE }],
  ])('a new model whose id the build reaches only by an id-prefix or a pattern is taken (%s)', (_what, model) => {
    const r = validateModelData(file((f) => { f.models.unshift(model) }), bundled)
    expect(r.ok ? 'ok' : r.reason).toBe('ok')
    const merged = mergeModelData(bundled, r.ok ? r.data : null, '2026-11-14')
    expect(resolveModelInfo(merged, model.id)).toMatchObject({ id: model.id, matchKind: 'exact' })
    for (const a of model.aliases ?? []) expect(resolveModelInfo(merged, a)).toMatchObject({ id: model.id, matchKind: 'alias' })
  })

  it.each([
    ['the family alias', { id: 'claude-opus-6', patterns: ['opus-6'], aliases: ['opus'], family: 'opus', label: 'Opus 6' }, 'claude-opus-5-5'],
    ['a shipped [1m] alias', { id: 'claude-fable-5-3', patterns: ['fable-5-3'], aliases: ['fable[1m]'], family: 'fable', label: 'Fable 5.3' }, 'claude-fable-5-2'],
    ['a shipped id', { id: 'claude-opus-6', patterns: ['opus-6'], aliases: ['claude-opus-4-8'], family: 'opus', label: 'Opus 6' }, 'claude-opus-4-8'],
    ['a shipped dated id', { id: 'claude-opus-6', patterns: ['opus-6'], aliases: ['claude-opus-4-8-20260101'], family: 'opus', label: 'Opus 6' }, 'claude-opus-4-8'],
    ['a name the build reaches by a pattern that does not start with the new id', { id: 'claude-opus-6', patterns: ['opus-6'], aliases: ['claude-opus-latest-x'], family: 'opus', label: 'Opus 6' }, 'claude-opus-5-5'],
    ['a name that only contains the new id, not starts with it', { id: 'claude-opus-6', patterns: ['opus-6'], aliases: ['x-claude-opus-6'], family: 'opus', label: 'Opus 6' }, 'claude-opus-5-5'],
    ['a shipped dated id that starts with the new id', { id: 'claude-opus-4', patterns: ['opus-4'], aliases: ['claude-opus-4-7-20260101'], family: 'opus', label: 'Opus 4' }, 'claude-opus-4-7'],
    ['a shipped [1m] name that starts with the new id', { id: 'claude-opus-4', patterns: ['opus-4'], aliases: ['claude-opus-4-7[1m]'], family: 'opus', label: 'Opus 4' }, 'claude-opus-4-7'],
    ['another shipped dated id that starts with the new id', { id: 'claude-haiku-4', patterns: ['haiku-4'], aliases: ['claude-haiku-4-5-20251001'], family: 'haiku', label: 'Haiku 4' }, 'claude-haiku-4-5'],
    ['a shipped dated id, though the new id is longer than the shipped one and the alias starts with it', { id: 'claude-opus-5-5-2', patterns: [], aliases: ['claude-opus-5-5-20260101'], family: 'opus', label: 'Opus 5.5.2' }, 'claude-opus-5-5'],
    ['a dated form of a shipped id that starts with another shipped id too, though the alias starts with the new id', { id: 'claude-fable-5-20', patterns: [], aliases: ['claude-fable-5-20260101'], family: 'fable', label: 'Fable 5.20' }, 'claude-fable-5'],
    ['a name the build reaches by an id-prefix that starts with the new id and the shipped id', { id: 'claude-opus-4', patterns: ['opus-4'], aliases: ['claude-opus-4-7-latest'], family: 'opus', label: 'Opus 4' }, 'claude-opus-4-7'],
    // An alias may be its model's own id written the other way (the table
    // above). The shipped id is then held against the new id the same way,
    // each as written and with a dot as a hyphen: a shipped id that is as
    // long a start of the name keeps it.
    ['the same name, the alias written with a dot', { id: 'claude-opus-4', patterns: ['opus-4'], aliases: ['claude-opus-4.7-latest'], family: 'opus', label: 'Opus 4' }, 'claude-opus-4-7'],
    ['a name written with a dot that starts with the new id and the shipped id, both written with hyphens', { id: 'claude-opus-4-8-f', patterns: [], aliases: ['claude-opus-4.8-fast-x'], family: 'opus', label: 'Opus 4.8 F' }, 'claude-opus-4-8-fast'],
    ['a name written with hyphens that starts with the shipped id, and with the new id once its dot is read as a hyphen', { id: 'claude-opus-4.8-f', patterns: [], aliases: ['claude-opus-4-8-fast-x'], family: 'opus', label: 'Opus 4.8 F' }, 'claude-opus-4-8-fast'],
    ['a name that carries on from a shipped id written with a dot, on a new id that is that id written with a hyphen', { id: 'gpt-5-5', patterns: [], aliases: ['gpt-5.5-x'], family: 'codex', label: 'GPT-5-5' }, 'gpt-5.5'],
    ['the same on a new id that is only the start of that shipped id written with a hyphen', { id: 'gpt-5-6', patterns: [], aliases: ['gpt-5.6-sol-x'], family: 'codex', label: 'GPT-5-6' }, 'gpt-5.6-sol'],
    ['another model\'s name written with a dot, which the new id does not start either way', { id: 'claude-opus-5-7', patterns: [], aliases: ['claude-opus-5.6'], family: 'opus', label: 'Opus 5.7' }, 'claude-opus-5'],
    // An alias that does not start with its model's id is refused for the
    // entry the build has the name on, as before: here the catch-all one,
    // though the name spells a shipped model with a hyphen for its dot.
    ['a shipped model\'s name written with a hyphen for its dot, which the new id does not start', { id: 'gpt-9', patterns: [], aliases: ['gpt-5-6-sol'], family: 'codex', label: 'GPT-9' }, 'codex-family'],
  ])('a new model with an alias that is not its own (%s) refuses the file, and the reason names the shipped entry', (_what, model, holder) => {
    expect(reasonOf(file((f) => { f.models.unshift(model) }))).toBe(`models: ${model.id} has a name the build already places on ${holder}`)
  })

  it.each([
    ['a Claude model whose id is a shipped id with a date', { id: 'claude-opus-4-5-20260101', patterns: [], family: 'opus', label: 'Opus 4.5 (dated)' }, 'claude-opus-4-5'],
    ['a Codex model whose id is a shipped id with a date', { id: 'gpt-5.5-20260101', patterns: [], family: 'codex', label: 'GPT-5.5 (dated)' }, 'gpt-5.5'],
    // These start with 'claude-fable-5-2' as text (until 2.1.3-beta.3 the
    // matcher put them there by id-prefix), and each is the dated form of the
    // shipped claude-fable-5, which is where the matcher puts them now.
    ['a dated form of claude-fable-5 that starts with claude-fable-5-2', { id: 'claude-fable-5-20260101', patterns: [], family: 'fable', label: 'Fable 5 (dated)' }, 'claude-fable-5'],
    ['another dated form of claude-fable-5 that starts with claude-fable-5-2', { id: 'claude-fable-5-20251001', patterns: [], family: 'fable', label: 'Fable 5 (dated)' }, 'claude-fable-5'],
  ])('a new model whose id is a dated form of a shipped id (%s) refuses the file, and the reason names the shipped entry', (_what, model, holder) => {
    expect(reasonOf(file((f) => { f.models.unshift(model) }))).toBe(`models: ${model.id} has a name the build already places on ${holder}`)
  })

  // 2.1.3-beta.3: the matcher reads a name with each dot between two digits as
  // a hyphen too, so a shipped id written with a dot (claude-opus-5.5) is that
  // shipped model's name, by an id match the app trusts for a label, a price
  // and an effort list. A new model takes it no more than it takes the same
  // name written with a hyphen: its id and its aliases are read both ways. (An
  // alias that does not start with its model's own id was refused already, as
  // a name the build places. So the alias rows that matter start with the new
  // id, which makes for odd ids: one that ends in the dot, one that ends
  // inside the date. The rules take such an id.)
  it.each([
    ['its id is a shipped id written with a dot', { id: 'claude-opus-4.7', patterns: [], family: 'opus', label: 'Opus 4.7' }, 'claude-opus-4-7'],
    ['its id is the newest shipped id of its family written with a dot', { id: 'claude-opus-5.5', patterns: [], family: 'opus', label: 'Opus 5.5' }, 'claude-opus-5-5'],
    ['its id is a shipped dated id written with a dot', { id: 'claude-opus-4.7-20260101', patterns: [], family: 'opus', label: 'Opus 4.7 (dated)' }, 'claude-opus-4-7'],
    ['its id is a shipped id written with a dot, one that starts with another shipped id', { id: 'claude-fable-5.2', patterns: [], family: 'fable', label: 'Fable 5.2' }, 'claude-fable-5-2'],
    ['its id is that shipped id\'s dated id written with a dot', { id: 'claude-fable-5.2-20260101', patterns: [], family: 'fable', label: 'Fable 5.2 (dated)' }, 'claude-fable-5-2'],
    ['an alias is a shipped id written with a dot, on a model whose id is not its start', { id: 'claude-opus-6', patterns: ['opus-6'], aliases: ['claude-opus-4.7'], family: 'opus', label: 'Opus 6' }, 'claude-opus-4-7'],
    ['an alias is a shipped id written with a dot, and starts with the new id', { id: 'claude-opus-4.', patterns: [], aliases: ['claude-opus-4.7'], family: 'opus', label: 'Opus 4' }, 'claude-opus-4-7'],
    ['an alias is the newest shipped id of its family written with a dot, and starts with the new id', { id: 'claude-opus-5.', patterns: [], aliases: ['claude-opus-5.5'], family: 'opus', label: 'Opus 5' }, 'claude-opus-5-5'],
    ['an alias is a shipped dated id written with a dot, and starts with the new id', { id: 'claude-opus-4.7-2026', patterns: [], aliases: ['claude-opus-4.7-20260101'], family: 'opus', label: 'Opus 4.7 2026' }, 'claude-opus-4-7'],
    ['an alias is a shipped [1m] name written with a dot, and starts with the new id', { id: 'claude-opus-4.', patterns: [], aliases: ['claude-opus-4.7[1m]'], family: 'opus', label: 'Opus 4' }, 'claude-opus-4-7'],
    // The alias starts with the new id, and so does the shipped id once both
    // are read as the alias is: as claude-opus-4-8-f with claude-opus-4-8-fast-x.
    ['an alias the build reaches by an id-prefix, read with its dot as a hyphen, that starts with the new id and the shipped id', { id: 'claude-opus-4.8-f', patterns: [], aliases: ['claude-opus-4.8-fast-x'], family: 'opus', label: 'Opus 4.8 F' }, 'claude-opus-4-8-fast'],
    ['the same, on a new id that ends in the dot', { id: 'claude-opus-4.', patterns: [], aliases: ['claude-opus-4.7-latest'], family: 'opus', label: 'Opus 4' }, 'claude-opus-4-7'],
  ])('a new model with a shipped name written with a dot (%s) refuses the file, and the reason names the shipped entry', (_what, model, holder) => {
    // The name the row is about (the alias when there is one, else the id):
    // the bundled file alone puts it on that shipped entry, by its id.
    for (const name of model.aliases ?? [model.id]) {
      expect(resolveModelInfo(bundled, name), name).toMatchObject({ id: holder, matchKind: 'prefix' })
    }
    expect(reasonOf(file((f) => { f.models.unshift(model) }))).toBe(`models: ${model.id} has a name the build already places on ${holder}`)
    // The same file with each dot between two digits written as a hyphen (the
    // matcher's own second reading) is refused too. (Where that makes the new
    // id a shipped id itself, as a model listed twice.)
    const hyphens = (s: string) => s.replace(/(\d)\.(?=\d)/g, '$1-')
    const twin = { ...model, id: hyphens(model.id), ...(model.aliases ? { aliases: model.aliases.map(hyphens) } : {}) }
    expect(validateModelData(file((f) => { f.models.unshift(twin) }), bundled).ok, `the same file written with hyphens (${twin.id})`).toBe(false)
  })

  it('every shipped model with a two-part version, written with a dot, is refused as a new model\'s id and as an alias, dated or not', () => {
    const twoPart = bundled.models.filter((m) => m.id.startsWith('claude-') && /\d-\d/.test(m.id))
    expect(twoPart.length).toBe(13)
    for (const m of twoPart) {
      const dotted = m.id.replace(/(\d)-(\d)/, '$1.$2')
      for (const id of [dotted, `${dotted}-20260101`]) {
        expect(reasonOf(file((f) => { f.models.unshift({ id, patterns: [], family: m.family, label: 'New' }) })), id)
          .toBe(`models: ${id} has a name the build already places on ${m.id}`)
      }
      for (const alias of [dotted, `${dotted}-20260101`, `${dotted}[1m]`]) {
        expect(reasonOf(file((f) => { f.models.unshift({ ...NEW_MODEL, aliases: [alias] }) })), alias)
          .toBe(`models: ${NEW_MODEL.id} has a name the build already places on ${m.id}`)
      }
    }
  })

  // A new model in a shipped family is tried after every shipped entry, so a
  // gateway's spelling of it (claude-opus-5.7) goes to the older model whose
  // id it starts with, by a match the app trusts for a label, a price and an
  // effort list. The file's one way to say otherwise is an alias, and the
  // alias was refused: it did not start with the id as the two are written.
  it('a new model may have its own id written with a dot as an alias, and the name is then that model, not the older one whose id it starts with', () => {
    const names = ['claude-opus-5.7', 'claude-opus-5.7-20270101']
    for (const name of names) expect(resolveModelInfo(bundled, name), name).toMatchObject({ id: 'claude-opus-5', matchKind: 'prefix' })
    const model = { id: 'claude-opus-5-7', patterns: [], aliases: names, family: 'opus', label: 'Opus 5.7', fallbackPricing: HIGH_PRICE }
    const r = validateModelData(file((f) => { f.models.unshift(model) }), bundled)
    expect(r.ok ? 'ok' : r.reason).toBe('ok')
    const merged = mergeModelData(bundled, r.ok ? r.data : null, '2026-11-14')
    for (const name of names) {
      expect(resolveModelInfo(merged, name), name).toMatchObject({ id: 'claude-opus-5-7', matchKind: 'alias', label: 'Opus 5.7', fallbackPricing: HIGH_PRICE })
    }
    // Without the aliases the names stay where the build alone puts them.
    const { aliases: _aliases, ...alone } = model
    void _aliases
    const plain = validateModelData(file((f) => { f.models.unshift(alone) }), bundled)
    const unlisted = mergeModelData(bundled, plain.ok ? plain.data : null, '2026-11-14')
    for (const name of names) expect(resolveModelInfo(unlisted, name), name).toEqual(resolveModelInfo(bundled, name))
    // Every shipped model keeps its own names, written either way.
    for (const m of bundled.models) {
      for (const name of [m.id, `${m.id}-20260101`, m.id.replace(/(\d)-(\d)/, '$1.$2'), ...(m.aliases ?? [])]) {
        expect(resolveModelInfo(merged, name), name).toEqual(resolveModelInfo(bundled, name))
      }
    }
  })

  it('every shipped id written with a dot: a new model with that id written with hyphens takes no name that carries on from the shipped one', () => {
    const dotted = bundled.models.filter((m) => /\d\.\d/.test(m.id))
    expect(dotted.length).toBeGreaterThan(0)
    for (const m of dotted) {
      // The id itself is free: a hyphen is never read as a dot, so only the
      // catch-all pattern places it.
      const id = m.id.replace(/(\d)\.(?=\d)/g, '$1-')
      const model = { id, patterns: [], family: m.family, label: 'New' }
      expect(resolveModelInfo(bundled, id), id).toMatchObject({ matchKind: 'pattern' })
      expect(validateModelData(file((f) => { f.models.unshift(model) }), bundled).ok, id).toBe(true)
      // A name that carries on from the shipped id is the shipped model's by
      // its id, and read with its dot as a hyphen it starts with the new id
      // as well. The shipped id read the same way is as long, so it keeps it.
      for (const alias of [`${m.id}-x`, `${m.id}-latest`, `${m.id}x`]) {
        expect(resolveModelInfo(bundled, alias), alias).toMatchObject({ id: m.id, matchKind: 'prefix' })
        expect(reasonOf(file((f) => { f.models.unshift({ ...model, aliases: [alias] }) })), alias)
          .toBe(`models: ${id} has a name the build already places on ${m.id}`)
      }
      // The same names written as the new id is written are held for the
      // shipped model too: read with its dot as a hyphen, the shipped id is
      // as long a start of them. Only the catch-all pattern places them.
      for (const alias of [`${id}-x`, `${id}-latest`, `${id}-20260101`]) {
        expect(resolveModelInfo(bundled, alias), alias).toMatchObject({ id: 'codex-family', matchKind: 'pattern' })
        expect(reasonOf(file((f) => { f.models.unshift({ ...model, aliases: [alias] }) })), alias)
          .toBe(`models: ${id} has a name the build already places on ${m.id}`)
      }
      // A longer id of the file's own has the names that carry on from it,
      // in either spelling: it is the longer start of them.
      const longer = { id: `${id}-x`, patterns: [], family: m.family, label: 'New' }
      expect(validateModelData(file((f) => { f.models.unshift({ ...longer, aliases: [`${id}-x-latest`, `${m.id}-x`, `${m.id}-x-latest`] }) }), bundled).ok, longer.id).toBe(true)
    }
  })

  // The third review round (2.1.3-beta.3). The matcher finds an id in a name
  // as the id is written: it never reads a hyphen as a dot. The Codex ids the
  // build ships are written with a dot (gpt-5.6-sol), so the same name
  // written with a hyphen (gpt-5-6-sol) starts with no shipped id, and only
  // the catch-all pattern places it. An alias that starts with its model's
  // own id is let past a pattern, so a new gpt-5.6 or gpt-5-6 could list
  // gpt-5-6-sol: the longer shipped model's name in the other spelling. For
  // an alias the shipped ids are now read with a dot as a hyphen as well, and
  // the two rules that hold where the matcher does find an id hold in that
  // reading: a dated form of a shipped id is that model's, and of two ids
  // that both start the name the shipped one keeps it unless the new one is
  // longer.
  it.each([
    ['a longer shipped model, on a new id written with a dot', { id: 'gpt-5.6', aliases: ['gpt-5-6-sol'] }, 'gpt-5.6-sol'],
    ['a longer shipped model, on a new id written with a hyphen', { id: 'gpt-5-6', aliases: ['gpt-5-6-terra'] }, 'gpt-5.6-terra'],
    ['a longer shipped model\'s dated id', { id: 'gpt-5.6', aliases: ['gpt-5-6-luna-20260101'] }, 'gpt-5.6-luna'],
    ['a name that carries on from a longer shipped model', { id: 'gpt-5-6', aliases: ['gpt-5-6-sol-x'] }, 'gpt-5.6-sol'],
    ['a shipped model, on a new id that stops before its version ends', { id: 'gpt-5', aliases: ['gpt-5-5'] }, 'gpt-5.5'],
    ['a name that carries on from a shipped model, on a new id that is the shipped id written with a hyphen', { id: 'gpt-5-2', aliases: ['gpt-5-2-mini'] }, 'gpt-5.2'],
    // A dated form is the shipped model's however long the new id is.
    ['a shipped model\'s dated id, on a new id that is longer than the shipped one', { id: 'gpt-5.5-', aliases: ['gpt-5-5-20260101'] }, 'gpt-5.5'],
    ['a shipped model\'s dated id, on a new id written with hyphens that ends inside the date', { id: 'gpt-5-5-2026', aliases: ['gpt-5-5-20260101'] }, 'gpt-5.5'],
    ['a longer shipped model\'s dated id, on a new id that is longer than that one', { id: 'gpt-5.6-sol-', aliases: ['gpt-5-6-sol-20260101'] }, 'gpt-5.6-sol'],
  ])('a new model with a shipped model\'s name written with a hyphen for its dot (%s) refuses the file, and the reason names the shipped entry', (_what, names, holder) => {
    const model = { ...names, patterns: [], family: 'codex', label: 'New' }
    const [alias] = model.aliases
    // The build alone places the name by its catch-all pattern, not by an id.
    expect(resolveModelInfo(bundled, alias), alias).toMatchObject({ id: 'codex-family', matchKind: 'pattern' })
    expect(reasonOf(file((f) => { f.models.unshift(model) }))).toBe(`models: ${model.id} has a name the build already places on ${holder}`)
    // The same name written as the shipped id is written was refused already,
    // for the same entry.
    const asShipped = `${holder}${alias.slice(holder.length)}`
    expect(asShipped.replace(/(\d)\.(?=\d)/g, '$1-'), asShipped).toBe(alias)
    expect(reasonOf(file((f) => { f.models.unshift({ ...model, aliases: [asShipped] }) })), asShipped).toBe(`models: ${model.id} has a name the build already places on ${holder}`)
    // Without the alias the model is taken: its id is its own.
    const { aliases: _aliases, ...alone } = model
    void _aliases
    expect(validateModelData(file((f) => { f.models.unshift(alone) }), bundled).ok, model.id).toBe(true)
  })

  it('a name whose number carries on past a shipped id written with a hyphen is not that model\'s: the id stops inside the number', () => {
    // gpt-5-55 read as the shipped ids are read starts with gpt-5-5 only as
    // text, as gpt-5.55 starts with gpt-5.5: another number, not GPT-5.5.
    for (const alias of ['gpt-5-55', 'gpt-5-25', 'gpt-5-2025-08-07']) {
      const r = validateModelData(file((f) => { f.models.unshift({ id: 'gpt-5', patterns: [], aliases: [alias], family: 'codex', label: 'GPT-5' }) }), bundled)
      expect(r.ok ? 'ok' : r.reason, alias).toBe('ok')
    }
  })

  it('the shipped id is held against the alias in that reading where the build reaches the name by a shorter id of its own, not only by a pattern', () => {
    // This build ships no gpt-5. One that did would place gpt-5-6-sol on it,
    // by its id, and the longer gpt-5.6-sol would still be the model the name
    // spells.
    const withShorter = file((f) => { f.models.unshift({ id: 'gpt-5', patterns: [], family: 'codex', label: 'GPT-5' }) }) as unknown as ModelRegistry
    expect(resolveModelInfo(withShorter, 'gpt-5-6-sol')).toMatchObject({ id: 'gpt-5', matchKind: 'prefix' })
    const model = { id: 'gpt-5.6', patterns: [], family: 'codex', label: 'GPT-5.6' }
    expect(validateModelData(file((f) => { f.models.unshift({ ...model, aliases: ['gpt-5-6-sol'] }) }), withShorter))
      .toEqual({ ok: false, reason: 'models: gpt-5.6 has a name the build already places on gpt-5.6-sol' })
    // Its own names are still its own there: it is the longer start of them.
    const own = validateModelData(file((f) => { f.models.unshift({ ...model, aliases: ['gpt-5-6', 'gpt-5-6-mini'] }) }), withShorter)
    expect(own.ok ? 'ok' : own.reason).toBe('ok')
  })

  // Validation asks the matcher where the build places a name (placedBy), so
  // its answers follow the matcher's two new rules (2.1.3-beta.3). Two files
  // change sides, and both are meant.
  it('a file the earlier matcher refused is taken now: gpt-5.55 is not gpt-5.5, so a new gpt-5 may have it as an alias', () => {
    // An id that ends in a digit is not the start of a name whose next
    // character is a digit, so the build no longer puts gpt-5.55 on gpt-5.5
    // by its id: only its catch-all pattern places it, and an alias that
    // starts with its model's own id is that model's name.
    expect(resolveModelInfo(bundled, 'gpt-5.55')).toMatchObject({ id: 'codex-family', matchKind: 'pattern' })
    const model = { id: 'gpt-5', patterns: [], aliases: ['gpt-5.55'], family: 'codex', label: 'GPT-5' }
    const r = validateModelData(file((f) => { f.models.unshift(model) }), bundled)
    expect(r.ok ? 'ok' : r.reason).toBe('ok')
    const merged = mergeModelData(bundled, r.ok ? r.data : null, '2026-11-14')
    expect(resolveModelInfo(merged, 'gpt-5.55')).toMatchObject({ id: 'gpt-5', matchKind: 'alias' })
    // The shipped model keeps its own names.
    expect(resolveModelInfo(merged, 'gpt-5.5')).toMatchObject({ id: 'gpt-5.5', matchKind: 'exact' })
    expect(resolveModelInfo(merged, 'gpt-5.5-20260101')).toMatchObject({ id: 'gpt-5.5', matchKind: 'prefix' })
    // And a name that carries on from it with other text is still refused.
    expect(reasonOf(file((f) => { f.models.unshift({ ...model, aliases: ['gpt-5.5-x'] }) }))).toBe('models: gpt-5 has a name the build already places on gpt-5.5')
  })

  it('a file the earlier matcher took is refused now: claude-opus-4.7 is Opus 4.7, so a new claude-opus-4 does not have it as an alias', () => {
    // Read with its dot as a hyphen the name is a shipped id. (Before, the
    // name started with no shipped id: only the family's plain pattern placed
    // it, on Opus 5.5, and an alias that starts with its model's own id is let
    // past a pattern.)
    expect(resolveModelInfo(bundled, 'claude-opus-4.7')).toMatchObject({ id: 'claude-opus-4-7', matchKind: 'prefix' })
    const model = { id: 'claude-opus-4', patterns: ['opus-4'], aliases: ['claude-opus-4.7'], family: 'opus', label: 'Opus 4' }
    expect(reasonOf(file((f) => { f.models.unshift(model) }))).toBe('models: claude-opus-4 has a name the build already places on claude-opus-4-7')
    // Without the alias the model is taken, as before.
    const { aliases: _aliases, ...alone } = model
    void _aliases
    expect(validateModelData(file((f) => { f.models.unshift(alone) }), bundled).ok).toBe(true)
  })

  // A bundled file that has a name of its own as an alias (this build's does not
  // for a full model name, so the file is built here): the id and the alias
  // rules both refuse it, even for an alias that starts with the new id.
  it('the id or alias of a new model that a shipped entry has as an alias is refused, and the reason names that entry', () => {
    const withAliases = (extra: string[]) => file((f) => { f.models.find((m: Loose) => m.id === 'claude-opus-5-5').aliases.push(...extra) }) as unknown as ModelRegistry
    const add = (model: Loose) => file((f) => { f.models.unshift(model) })
    const own = { id: 'claude-opus-7', patterns: ['opus-7'], family: 'opus', label: 'Opus 7' }
    // Its id is a shipped alias.
    expect(validateModelData(add(own), withAliases(['claude-opus-7']))).toEqual({ ok: false, reason: 'models: claude-opus-7 has a name the build already places on claude-opus-5-5' })
    // One of its aliases is a shipped alias that starts with its own id.
    expect(validateModelData(add({ ...own, aliases: ['claude-opus-7[1m]'] }), withAliases(['claude-opus-7[1m]']))).toEqual({ ok: false, reason: 'models: claude-opus-7 has a name the build already places on claude-opus-5-5' })
    // Without those aliases in the build, both are taken.
    expect(validateModelData(add({ ...own, aliases: ['claude-opus-7[1m]'] }), bundled).ok).toBe(true)
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
    expect(resolveModelInfo(merged, 'claude-fable-6')).toMatchObject({ known: true, label: 'Fable 6', matchKind: 'exact' })
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

  it('a family, a picker row and an effort level the fetched file leaves out stay too; what it does carry is corrected', () => {
    const merged = mergeModelData(bundled, fetched((f) => {
      f.models = f.models.filter((m: Loose) => m.family !== 'haiku')
      delete f.families.haiku
      f.dropdown = f.dropdown.filter((d: Loose) => d.value !== 'haiku')
      f.effortLevels[0].label = 'Lowest'
    }), '2026-11-14')
    expect(merged.families.haiku).toEqual(bundled.families.haiku)
    expect(resolveModelInfo(merged, 'claude-haiku-5-5').known).toBe(true)
    expect(merged.dropdown.map((d) => d.value).sort()).toEqual(bundled.dropdown.map((d) => d.value).sort())
    expect(merged.dropdown[merged.dropdown.length - 1].value).toBe('haiku')
    expect(merged.effortLevels[0].label).toBe('Lowest')
    expect(merged.effortLevels.map((l) => l.value)).toEqual(bundled.effortLevels.map((l) => l.value))
    expect(merged.providerEffortLevels?.codex).toEqual(bundled.providerEffortLevels?.codex)
  })

  // Review finding: a file that passed every check could still empty both
  // pickers (pickable false on every model, no picker rows) and cut the
  // effort levels down to one, on every install, until the branch was fixed.
  it('a fetched file cannot empty either picker: a shipped model stays pickable and the shipped picker rows stay', () => {
    const merged = mergeModelData(bundled, fetched((f) => {
      for (const m of f.models) m.pickable = false
      f.dropdown = []
    }), '2026-11-14')
    expect(buildModelPickerRows(merged, 'claude')).toEqual(buildModelPickerRows(bundled, 'claude'))
    expect(buildModelPickerRows(merged, 'codex')).toEqual(buildModelPickerRows(bundled, 'codex'))
    expect(buildModelPickerRows(bundled, 'claude').length).toBeGreaterThan(10)
    expect(buildModelPickerRows(bundled, 'codex').length).toBeGreaterThan(3)
  })

  it('nor can it offer an entry the bundled file keeps out of the pickers, and a model it adds may be kept out', () => {
    const merged = mergeModelData(bundled, fetched((f) => {
      delete f.models.find((m: Loose) => m.id === 'codex-family').pickable
      f.models.unshift({ ...NEW_MODEL, pickable: false })
    }), '2026-11-14')
    expect(merged.models.find((m) => m.id === 'codex-family')?.pickable).toBe(false)
    expect(buildModelPickerRows(merged, 'codex').some((r) => r.value === 'codex-family')).toBe(false)
    expect(buildModelPickerRows(merged, 'claude').some((r) => r.value === 'claude-fable-6')).toBe(false)
    // A shipped model the file does not mark at all stays as the bundled file has it.
    expect(merged.models.find((m) => m.id === 'claude-opus-5-5')).not.toHaveProperty('pickable')
  })

  it('a fetched file cannot take an effort level away, for either assistant; it can add one and correct one', () => {
    const merged = mergeModelData(bundled, fetched((f) => {
      f.effortLevels = [{ value: 'low', label: 'Low' }, { value: 'turbo', label: 'Turbo' }]
      f.providerEffortLevels.codex = [{ value: 'ultra', label: 'Ultra!' }]
      // Each model keeps only the one level the file still has for its assistant.
      const kept: Record<string, string> = { codex: 'ultra' }
      for (const m of f.models) if (m.efforts) m.efforts = m.efforts.filter((e: string) => e === (kept[m.family] ?? 'low'))
    }), '2026-11-14')
    const values = (levels: { value: string }[]) => levels.map((l) => l.value)
    expect(values(effortLevelsFor(merged, 'claude'))).toEqual(['low', 'turbo', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(values(effortLevelsFor(merged, 'codex'))).toEqual(['ultra', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortLevelsFor(merged, 'codex')[0].label).toBe('Ultra!')
    expect(values(effortLevelsFor(bundled, 'claude'))).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
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
      const r = validateModelData(file((f) => { f.models.unshift({ ...NEW_MODEL, patterns: ['^zeta-six', 'six.zeta'] }) }), bundled)
      if (!r.ok) throw new Error(r.reason)
      return r.data
    })(), '2026-11-14')
    const built = vi.spyOn(globalThis, 'RegExp')
    // Reached by a start-anchored pattern, by a plain one, and not at all.
    // (Names no shipped entry places: a fetched model takes only those.)
    expect(resolveModelInfo(merged, 'zeta-six-preview').id).toBe('claude-fable-6')
    expect(resolveModelInfo(merged, 'my-zeta-six').id).not.toBe('claude-fable-6')
    expect(resolveModelInfo(merged, 'a-six.zeta-b').id).toBe('claude-fable-6')
    // A dot is a dot, not "any character".
    expect(resolveModelInfo(merged, 'a-sixxzeta-b').id).not.toBe('claude-fable-6')
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
