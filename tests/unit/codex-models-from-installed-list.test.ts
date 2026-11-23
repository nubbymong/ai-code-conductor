// aicc_planning#362: the Codex model picker and its effort list come from the
// installed Codex's own list (`codex debug models --bundled`, read in main),
// not from hand-kept registry rows. A registry row only adds a price or
// corrects a label; the registry is used alone when there is no list. The
// release gate and Sentinel no longer ask for a registry row per listed model.
// Pure: no process, no folder, no network.
import { describe, it, expect } from 'vitest'
import {
  withInstalledCodexModels, buildModelPickerRows, buildEffortRows, codexEffortRuns, resolveModelInfo,
  evaluateCodexModelCoverage, type ModelRegistry, type InstalledCodexModels,
} from '../../src/shared/model-registry'
import { codexModelOptions, codexEffortOptions, codexNewConfigModel, CODEX_DEFAULT } from '../../src/renderer/codex-models'
import { evaluateCodexModels } from '../../scripts/release-gate.mjs'
import baselineJson from '../../resources/model-registry.json'

const reg = baselineJson as unknown as ModelRegistry
const REGISTRY_CODEX = buildModelPickerRows(reg, 'codex').map((r) => r.value)

/** A list as the installed Codex gives it: ids, labels, levels. */
const list = (version: string, models: Array<[string, string, string[]?]>): InstalledCodexModels => ({
  version,
  models: models.map(([id, label, efforts]) => ({ id, label, ...(efforts ? { efforts } : {}) })),
})
const ALL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const NEWER = list('0.180.0', [
  ['gpt-7-nova', 'GPT-7-Nova', ['low', 'medium', 'high']],
  ['gpt-6.2-sol', 'GPT-6.2-Sol (as Codex spells it)', ALL],
  ['gpt-5.5', 'GPT-5.5', ['low', 'medium', 'high', 'xhigh', 'max']],
])

describe('the Codex picker offers the installed Codex\'s own list (aicc_planning#362)', () => {
  it('a listed model the registry lacks is offered, with its own levels', () => {
    const r = withInstalledCodexModels(reg, NEWER)
    expect(codexModelOptions(r).map((o) => o.value)).toEqual([CODEX_DEFAULT, 'gpt-7-nova', 'gpt-6.2-sol', 'gpt-5.5'])
    expect(codexModelOptions(r).find((o) => o.value === 'gpt-7-nova')!.label).toBe('GPT-7-Nova')
    const efforts = codexEffortOptions(r, 'gpt-7-nova')
    expect(efforts.filter((o) => !o.disabled).map((o) => o.value)).toEqual([CODEX_DEFAULT, 'low', 'medium', 'high'])
    expect(efforts.filter((o) => o.disabled).map((o) => o.value)).toEqual(['xhigh', 'max', 'ultra'])
    // Main's launch asks the same question (pty-handlers.ts): the list's levels decide.
    expect(codexEffortRuns(r, 'gpt-7-nova', 'high')).toBe(true)
    expect(codexEffortRuns(r, 'gpt-7-nova', 'max')).toBe(false)
    expect(resolveModelInfo(r, 'gpt-7-nova')).toMatchObject({ known: true, matchKind: 'exact', family: 'codex', label: 'GPT-7-Nova' })
  })

  it('without the list the same model is not offered: the registry alone, as before', () => {
    expect(codexModelOptions(reg).map((o) => o.value)).not.toContain('gpt-7-nova')
    expect(codexModelOptions(reg).map((o) => o.value)).toEqual([CODEX_DEFAULT, ...REGISTRY_CODEX])
  })

  it('no list, an empty one, one with no version or none the picker can offer: the registry alone, unchanged', () => {
    for (const l of [null, undefined, list('0.180.0', []), { version: undefined as unknown as string, models: NEWER.models }, list('0.180.0', [['-rm', 'x'], ['a b', 'y']])]) {
      const r = withInstalledCodexModels(reg, l)
      expect(buildModelPickerRows(r, 'codex').map((x) => x.value), JSON.stringify(l)).toEqual(REGISTRY_CODEX)
      expect(r.installedCodex).toBeUndefined()
      expect(r.models).toEqual(reg.models)
    }
  })

  it('a registry row only adds a price or corrects a label; the levels are the list\'s', () => {
    const priced: ModelRegistry = { ...reg, models: reg.models.map((m) => m.id === 'gpt-5.5' ? { ...m, fallbackPricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } } : m) }
    const r = withInstalledCodexModels(priced, NEWER)
    const row = r.models.find((m) => m.id === 'gpt-5.5')!
    expect(row.fallbackPricing).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 })
    expect(row.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(buildEffortRows(r, 'gpt-5.5', 'codex').filter((e) => e.supported).map((e) => e.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // The registry's label is the correction; a list-only model keeps Codex's.
    expect(buildModelPickerRows(r, 'codex').find((x) => x.value === 'gpt-6.2-sol')!.label).toBe('GPT-6.2-Sol')
    // A listed model with no levels keeps the registry row's.
    const noLevels = withInstalledCodexModels(reg, list('0.180.0', [['gpt-5.5', 'GPT-5.5']]))
    expect(noLevels.models.find((m) => m.id === 'gpt-5.5')!.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('a registry Codex row the list does not name is not offered, but still places a running session', () => {
    const r = withInstalledCodexModels(reg, NEWER)
    expect(buildModelPickerRows(r, 'codex').map((x) => x.value)).not.toContain('gpt-6-astra')
    expect(codexModelOptions(r, 'gpt-6-astra').at(-1)).toEqual({ value: 'gpt-6-astra', label: 'gpt-6-astra (not in the list)' })
    expect(resolveModelInfo(r, 'gpt-6-astra')).toMatchObject({ known: true, matchKind: 'exact', label: 'GPT-6-Astra' })
    // Claude's picker and Claude's rows are untouched.
    expect(buildModelPickerRows(r).map((x) => x.value)).toEqual(buildModelPickerRows(reg).map((x) => x.value))
  })

  it('never offers a listed id that a Claude model has as its id or an alias, nor one a launch would refuse', () => {
    const r = withInstalledCodexModels(reg, list('0.180.0', [['opus', 'Opus'], ['claude-opus-5', 'x'], ['gpt 7', 'y'], ['gpt-7', 'GPT-7', ['low']], ['gpt-7', 'again']]))
    expect(buildModelPickerRows(r, 'codex').map((x) => x.value)).toEqual(['gpt-7'])
    expect(buildModelPickerRows(r).map((x) => x.value)).toEqual(buildModelPickerRows(reg).map((x) => x.value))
    expect(resolveModelInfo(r, 'opus').family).toBe('opus')
  })

  it('the same list applied twice gives the same registry', () => {
    const once = withInstalledCodexModels(reg, NEWER)
    expect(withInstalledCodexModels(once, NEWER)).toEqual(once)
    expect(once.installedCodex).toEqual({ version: '0.180.0' })
    // And no list takes the mark off again.
    expect(withInstalledCodexModels(once, null).installedCodex).toBeUndefined()
  })

  it('a new config starts on the first model the installed Codex lists; without a list, as before', () => {
    expect(codexNewConfigModel(withInstalledCodexModels(reg, NEWER))).toBe('gpt-7-nova')
    expect(codexNewConfigModel(reg)).toBe('gpt-6-astra')
  })
})

describe('the release gate and Sentinel\'s rule no longer ask for a registry row per listed model', () => {
  const codexList = { cliVersions: ['0.180.0'], fetchedAt: '2026-11-22', models: [{ id: 'gpt-7-nova', label: 'GPT-7-Nova' }, ...REGISTRY_CODEX.map((id) => ({ id }))] }

  it('the gate passes a Codex whose new ids are not in the bundled registry', () => {
    const gate = evaluateCodexModels({ registry: reg, expected: codexList })
    expect(gate.ok).toBe(true)
    expect(gate.reason).toBeNull()
    expect(gate.missing.map((m: { id: string }) => m.id)).toEqual(['gpt-7-nova'])
    const shared = evaluateCodexModelCoverage(reg, codexList)
    expect(shared.ok).toBe(true)
    expect(shared.missing.map((m) => m.id)).toEqual(['gpt-7-nova'])
  })

  it('a listed id that a Claude model holds still fails both (the Codex picker never offers it)', () => {
    const taken = { ...codexList, models: [...codexList.models, { id: 'opus' }] }
    const gate = evaluateCodexModels({ registry: reg, expected: taken })
    expect(gate.ok).toBe(false)
    expect(gate.taken).toEqual(['opus'])
    expect(gate.reason).toBe('1 model(s) the Codex CLI lists have the id or alias of a Claude model in the registry')
    expect(evaluateCodexModelCoverage(reg, taken)).toMatchObject({ ok: false, taken: ['opus'], reason: gate.reason })
  })
})
