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

  // The naming rule for a model the build does not ship: its ID is refused only
  // when the bundled file places it by an exact id or an alias; each ALIAS is
  // refused when the bundled file places it by an exact id or an alias, or by
  // an id-prefix or a pattern when it does not start with the model's own id.
  const HIGH_PRICE = { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 }
  it.each([
    ['Fable 5.3 with its [1m] and dated names', { id: 'claude-fable-5-3', patterns: ['fable-5-3'], aliases: ['claude-fable-5-3[1m]', 'claude-fable-5-3-20270101'], family: 'fable', label: 'Fable 5.3', fallbackPricing: HIGH_PRICE }],
    ['Opus 5.6', { id: 'claude-opus-5-6', patterns: ['opus-5-6'], family: 'opus', label: 'Opus 5.6', fallbackPricing: HIGH_PRICE }],
    ['a Codex model after the shipped gpt-5.5', { id: 'gpt-5.5-pro', patterns: [], family: 'codex', label: 'GPT-5.5 Pro' }],
    ['Opus 6 with an alias that starts with its id', { id: 'claude-opus-6', patterns: ['opus-6'], aliases: ['claude-opus-6[1m]'], family: 'opus', label: 'Opus 6', fallbackPricing: HIGH_PRICE }],
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
  ])('a new model with an alias that is not its own (%s) refuses the file, and the reason names the shipped entry', (_what, model, holder) => {
    expect(reasonOf(file((f) => { f.models.unshift(model) }))).toBe(`models: ${model.id} has a name the build already places on ${holder}`)
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
