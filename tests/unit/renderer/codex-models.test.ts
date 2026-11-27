// P3.8 (rows 39, 40): the Codex pickers read the model registry, as Claude's do.
// Replaces the hand-kept six-model list (gpt-5.4, gpt-5.4-mini, gpt-5.3-codex and
// gpt-5.3-codex-spark are not offered by the supported Codex CLI's own catalogue).
import { describe, it, expect } from 'vitest'
import { codexModelOptions, codexEffortOptions, codexEffortSupported, codexNewConfigModel, CODEX_DEFAULT } from '../../../src/renderer/codex-models'
import { mergeRegistry, type ModelRegistry } from '../../../src/shared/model-registry'
import baselineJson from '../../../resources/model-registry.json'
import catalogueJson from '../../../resources/codex-model-catalogue.json'

const reg = baselineJson as unknown as ModelRegistry

// A new config starts on the first model of the list that every supported
// Codex lists (P3.8 round 1, J1, as a new Claude config starts on the first
// row of Claude's). GPT-6.2-Sol heads the list but only Codex 0.170.0, 0.171.0
// and 0.172.0 list it, so a new config on an older supported Codex would start on
// a model that CLI does not offer.
describe('codexNewConfigModel', () => {
  it('starts on the first model every supported Codex lists, not one only the newest versions list', () => {
    expect(codexModelOptions(reg)[1].value).toBe('gpt-6.2-sol')
    expect(codexNewConfigModel(reg)).toBe('gpt-6-astra')
  })

  it('follows the catalogue: once every supported version lists the head of the list, a new config starts on it', () => {
    const everyVersion = {
      ...catalogueJson,
      models: catalogueJson.models.map((m) => (m.id === 'gpt-6.2-sol' ? { label: m.label, id: m.id } : m)),
    }
    expect(codexNewConfigModel(reg, everyVersion)).toBe('gpt-6.2-sol')
  })

  it('counts a model whose own versions name every supported version: with only 0.170.0 and 0.171.0 supported, a new config starts on the head of the list', () => {
    const newestOnly = { ...catalogueJson, cliVersions: ['0.170.0', '0.171.0'] }
    expect(codexNewConfigModel(reg, newestOnly)).toBe('gpt-6.2-sol')
  })

  it('starts on Default (Codex chooses) when no Codex model in the list is one every supported version lists', () => {
    const onlyOld = { ...reg, models: (reg.models ?? []).filter((m) => !m.id.startsWith('gpt-') || m.id === 'gpt-5.2') }
    expect(codexModelOptions(onlyOld).map((o) => o.value)).toEqual([CODEX_DEFAULT, 'gpt-5.2'])
    expect(codexNewConfigModel(onlyOld)).toBe(CODEX_DEFAULT)
  })
})

describe('codexModelOptions', () => {
  it("offers Default, then the registry's Codex models in the Codex CLI's order", () => {
    expect(codexModelOptions(reg).map((o) => o.value)).toEqual([
      CODEX_DEFAULT, 'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2',
    ])
    expect(codexModelOptions(reg)[0].label).toBe('Default: follows Codex')
    expect(codexModelOptions(reg).find((o) => o.value === 'gpt-6-astra')!.label).toBe('GPT-6-Astra')
  })

  it('keeps a saved model the list no longer offers, marked, so the picker shows what is saved', () => {
    const opts = codexModelOptions(reg, 'gpt-5.3-codex')
    expect(opts[opts.length - 1]).toEqual({ value: 'gpt-5.3-codex', label: 'gpt-5.3-codex (not in the list)' })
    expect(codexModelOptions(reg, 'gpt-5.5').filter((o) => o.value === 'gpt-5.5')).toHaveLength(1)
    expect(codexModelOptions(reg, '').map((o) => o.value)).not.toContain(undefined)
  })

  it('follows the registry: a Codex model an overlay adds is offered with no code change', () => {
    const merged = mergeRegistry(reg, { models: [{ id: 'gpt-6-nova', patterns: [], family: 'codex', label: 'GPT-6-Nova', provenance: { addedBy: 'user', date: '2026-09-29' } }] })
    expect(codexModelOptions(merged).map((o) => o.value)).toContain('gpt-6-nova')
  })
})

describe('codexEffortOptions and codexEffortSupported', () => {
  it("offers Default and Codex's levels, the ones the model lacks disabled", () => {
    const opts = codexEffortOptions(reg, 'gpt-5.5')
    expect(opts.map((o) => o.value)).toEqual([CODEX_DEFAULT, 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(opts.filter((o) => o.disabled).map((o) => o.value)).toEqual(['max', 'ultra'])
    expect(codexEffortOptions(reg, 'gpt-6-astra').some((o) => o.disabled)).toBe(false)
    expect(codexEffortOptions(reg, CODEX_DEFAULT).some((o) => o.disabled)).toBe(false)
  })

  it('says whether a model runs an effort: Default always, an unsupported or legacy level never', () => {
    expect(codexEffortSupported(reg, 'gpt-5.5', '')).toBe(true)
    expect(codexEffortSupported(reg, 'gpt-5.5', undefined)).toBe(true)
    expect(codexEffortSupported(reg, 'gpt-5.5', 'xhigh')).toBe(true)
    expect(codexEffortSupported(reg, 'gpt-5.5', 'ultra')).toBe(false)
    expect(codexEffortSupported(reg, 'gpt-6-astra', 'ultra')).toBe(true)
    expect(codexEffortSupported(reg, 'gpt-6-astra', 'minimal')).toBe(false)
    expect(codexEffortSupported(reg, 'gpt-6-astra', 'none')).toBe(false)
  })
})
