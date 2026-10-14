// P3.8 (row 39): Sentinel's model coverage check covers Codex's catalogue too,
// as it covers Claude's (#385). Its reference is the list of models the
// supported Codex CLI itself offers (resources/codex-model-catalogue.json),
// shipped with the build: a model that list names and the registry lacks, a
// Codex model the registry still offers that the list dropped, an unreadable
// list and a stale one are each reported, and nothing else.
import { describe, it, expect } from 'vitest'
import {
  codexModelCoverageFindings,
  CODEX_EXPECTED_MODEL_SET,
  FIXTURE_STALE_DAYS,
  staleCodexModelFindingIds,
} from '../../src/main/sentinel/sentinel-models'
import type { FindingStatus } from '../../src/shared/sentinel-types'
import { mergeRegistry, type ModelRegistry, type ExpectedModelSet } from '../../src/shared/model-registry'
import baselineJson from '../../resources/model-registry.json'

const reg = baselineJson as unknown as ModelRegistry
const NOW = Date.parse('2026-10-01T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000

const listOf = (ids: string[], fetchedAt = '2026-09-29'): ExpectedModelSet & { cliVersions: string[] } => ({
  source: 'the model catalogue bundled with the Codex CLI', cliVersions: ['0.153.4'], fetchedAt,
  models: ids.map((id) => ({ id, label: id.toUpperCase() })),
})
const CODEX_IDS = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2']

describe('Sentinel Codex model coverage (row 39)', () => {
  it('is silent when the shipped registry covers the shipped Codex list', () => {
    expect(codexModelCoverageFindings(reg, CODEX_EXPECTED_MODEL_SET, NOW)).toEqual([])
    expect(CODEX_EXPECTED_MODEL_SET.models.map((m) => m.id)).toEqual(CODEX_IDS)
  })

  it('reports a model the Codex CLI lists that the picker does not offer', () => {
    const f = codexModelCoverageFindings(reg, listOf([...CODEX_IDS, 'gpt-6-nova']), NOW)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ id: 'models:codex-missing:gpt-6-nova', kind: 'compat', severity: 'warn', affectedFeature: 'sessions', status: 'open', createdAt: NOW })
    expect(f[0].title).toBe('Codex offers GPT-6-NOVA, but it is not in the model picker')
    expect(f[0].evidence).toContain('the Codex model list shipped with this build (Codex 0.153.4, 2026-09-29)')
  })

  it('reports a Codex model the picker still offers that the list no longer names', () => {
    const f = codexModelCoverageFindings(reg, listOf(CODEX_IDS.filter((id) => id !== 'gpt-5.2')), NOW)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ id: 'models:codex-retired:gpt-5.2', kind: 'compat', severity: 'warn', affectedFeature: 'sessions' })
    expect(f[0].title).toBe('GPT-5.2 is still selectable but Codex no longer lists it')
  })

  it('never reports a Codex model an overlay added, or any Claude model', () => {
    const merged = mergeRegistry(reg, { models: [{ id: 'gpt-6-nova', patterns: [], family: 'codex', label: 'GPT-6-Nova', provenance: { addedBy: 'user', date: '2026-09-29' } }] })
    expect(codexModelCoverageFindings(merged, CODEX_EXPECTED_MODEL_SET, NOW)).toEqual([])
    expect(codexModelCoverageFindings(reg, CODEX_EXPECTED_MODEL_SET, NOW).some((x) => x.id.includes('claude-'))).toBe(false)
  })

  // P3.8 round 2 (GS): an id the registry lists twice is reported as such
  // (the pickers would disagree about it), not as "could not be verified".
  it('reports a Codex id the registry lists more than once', () => {
    const dup = { ...reg, models: [{ id: 'gpt-5.5', patterns: [], family: 'opus', label: 'GPT-5.5 (Claude row)' }, ...reg.models] } as unknown as ModelRegistry
    const f = codexModelCoverageFindings(dup, CODEX_EXPECTED_MODEL_SET, NOW)
    expect(f.map((x) => x.id)).toContain('models:codex-duplicate:gpt-5.5')
    expect(f.map((x) => x.id)).not.toContain('models:codex-list-unreadable')
    expect(f.map((x) => x.id)).not.toContain('models:codex-missing:gpt-5.5')
    // A duplicated Codex id the list does not name: still its own finding, not "could not be verified".
    const unlisted = { ...reg, models: [...reg.models, { id: 'gpt-7', patterns: [], family: 'codex', label: 'GPT-7' }, { id: 'gpt-7', patterns: [], family: 'codex', label: 'GPT-7' }] } as unknown as ModelRegistry
    const g = codexModelCoverageFindings(unlisted, CODEX_EXPECTED_MODEL_SET, NOW).map((x) => x.id)
    expect(g).toContain('models:codex-duplicate:gpt-7')
    expect(g).not.toContain('models:codex-list-unreadable')
    expect(f.find((x) => x.id === 'models:codex-duplicate:gpt-5.5')!.title).toBe('gpt-5.5 is in the model registry more than once')
  })

  it('an empty or missing list is one "could not be verified" finding, not a wall of retired models (fail closed)', () => {
    for (const expected of [null, undefined, listOf([])]) {
      const f = codexModelCoverageFindings(reg, expected, NOW)
      expect(f).toHaveLength(1)
      expect(f[0]).toMatchObject({ id: 'models:codex-list-unreadable', kind: 'compat', severity: 'warn', title: 'The Codex model list could not be verified' })
    }
  })

  it('says when the shipped list is older than the stale limit, and only then', () => {
    const at = (days: number) => new Date(NOW - days * DAY).toISOString().slice(0, 10)
    expect(codexModelCoverageFindings(reg, listOf(CODEX_IDS, at(FIXTURE_STALE_DAYS)), NOW)).toEqual([])
    const f = codexModelCoverageFindings(reg, listOf(CODEX_IDS, at(FIXTURE_STALE_DAYS + 1)), NOW)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ id: `models:codex-list-stale:${at(FIXTURE_STALE_DAYS + 1)}`, kind: 'info', severity: 'info' })
    expect(f[0].title).toBe('The Codex model list has not been re-checked in a while')
  })
})

// P3.9 (row 39): the live read. The installed CLI's own list, read from it
// (`codex debug models --bundled`), is the reference when there is one, for
// both arms, so the check follows the version actually installed.
describe('Sentinel Codex model coverage against the installed CLI (row 39, P3.9)', () => {
  const live = (version: string, ids: string[]) => ({ version, models: ids.map((id) => ({ id, label: id.toUpperCase() })) })
  const V155 = CODEX_IDS.filter((id) => id !== 'gpt-5.2')

  it("0.155.1 installed: gpt-5.2, which it no longer lists, is said for that version (the owner's gpt-5.2 notice, resolved per version)", () => {
    const f = codexModelCoverageFindings(reg, CODEX_EXPECTED_MODEL_SET, NOW, live('0.155.1', V155))
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ id: 'models:codex-retired:gpt-5.2', kind: 'compat', severity: 'warn', provider: 'codex', affectedFeature: 'sessions' })
    expect(f[0].title).toBe('GPT-5.2 is still selectable but Codex 0.155.1 no longer lists it')
    expect(f[0].evidence).toContain('the model list read from the installed Codex 0.155.1 itself')
    expect(f[0].evidence).not.toContain('just now')
  })

  it('0.153.4 installed: the registry covers its list, so nothing is said', () => {
    expect(codexModelCoverageFindings(reg, CODEX_EXPECTED_MODEL_SET, NOW, live('0.153.4', CODEX_IDS))).toEqual([])
  })

  it('a model the installed CLI offers that the picker does not is said, from the live list, even when the shipped list lacks it too', () => {
    const f = codexModelCoverageFindings(reg, CODEX_EXPECTED_MODEL_SET, NOW, live('0.157.1', [...CODEX_IDS, 'gpt-6-nova']))
    expect(f.map((x) => x.id)).toEqual(['models:codex-missing:gpt-6-nova'])
    expect(f[0].evidence).toContain('the installed Codex 0.157.1')
    expect(f[0].provider).toBe('codex')
  })

  it('a live read has just answered first-hand: a stale shipped list is not said', () => {
    const stale = listOf(CODEX_IDS, new Date(NOW - (FIXTURE_STALE_DAYS + 30) * DAY).toISOString().slice(0, 10))
    expect(codexModelCoverageFindings(reg, stale, NOW).map((x) => x.id)).toEqual([`models:codex-list-stale:${stale.fetchedAt}`])
    expect(codexModelCoverageFindings(reg, stale, NOW, live('0.155.1', CODEX_IDS))).toEqual([])
  })

  it('no live list, or an empty one, falls back to the shipped list (fail closed, never "Codex lists nothing")', () => {
    for (const l of [null, undefined, { version: '0.155.1', models: [] }, { version: undefined as unknown as string, models: [{ id: 'gpt-5.5', label: 'x' }] }]) {
      const f = codexModelCoverageFindings(reg, listOf(CODEX_IDS.filter((id) => id !== 'gpt-5.2')), NOW, l)
      expect(f.map((x) => x.id), JSON.stringify(l)).toEqual(['models:codex-retired:gpt-5.2'])
      expect(f[0].title).toBe('GPT-5.2 is still selectable but Codex no longer lists it')
    }
  })

  it('an overlay-added Codex model is never "retired" by the live list either', () => {
    const merged = mergeRegistry(reg, { models: [{ id: 'gpt-6-nova', patterns: [], family: 'codex', label: 'GPT-6-Nova', provenance: { addedBy: 'user', date: '2026-09-29' } }] })
    expect(codexModelCoverageFindings(merged, CODEX_EXPECTED_MODEL_SET, NOW, live('0.153.4', CODEX_IDS))).toEqual([])
  })
})

// O8: the Codex half closes a model finding whose cause is gone, by the same
// rule as Claude's half (sentinel-models.test.ts): only on evidence that its
// claim is now false, never because one run did not repeat it, so a notice a
// live read raised does not come and go with each read.
describe('closing Codex model findings the check no longer stands behind (O8)', () => {
  const live = (version: string, ids: string[]) => ({ version, models: ids.map((id) => ({ id, label: id.toUpperCase() })) })
  const V155 = CODEX_IDS.filter((id) => id !== 'gpt-5.2')
  const open = (id: string, status: FindingStatus = 'open') => ({ id, status })
  const stale = staleCodexModelFindingIds

  it('codex-missing closes once the registry has one pickable Codex entry for it; one it does not cover stays offline', () => {
    const findings = [open('models:codex-missing:gpt-5.5'), open('models:codex-missing:gpt-6-nova')]
    expect(stale(findings, reg, [], CODEX_EXPECTED_MODEL_SET, null)).toEqual(['models:codex-missing:gpt-5.5'])
    const unpickable: ModelRegistry = { ...reg, models: reg.models.map((m) => m.id === 'gpt-5.5' ? { ...m, pickable: false } : m) }
    expect(stale([findings[0]], unpickable, [], CODEX_EXPECTED_MODEL_SET, null)).toEqual([])
  })

  it('codex-missing for a model the installed CLI no longer lists closes on a live read only', () => {
    const findings = [open('models:codex-missing:gpt-6-nova')]
    expect(stale(findings, reg, [], CODEX_EXPECTED_MODEL_SET, live('0.155.1', V155))).toEqual(['models:codex-missing:gpt-6-nova'])
    expect(stale(findings, reg, [], CODEX_EXPECTED_MODEL_SET, null)).toEqual([])
    // The live list still offers it: raised again, and stays.
    const l = live('0.157.1', [...CODEX_IDS, 'gpt-6-nova'])
    const current = codexModelCoverageFindings(reg, CODEX_EXPECTED_MODEL_SET, NOW, l)
    expect(current.map((f) => f.id)).toEqual(['models:codex-missing:gpt-6-nova'])
    expect(stale(findings, reg, current, CODEX_EXPECTED_MODEL_SET, l)).toEqual([])
    // Never closed by a live list that names it, even when the caller passes no findings for the run.
    expect(stale(findings, reg, [], CODEX_EXPECTED_MODEL_SET, l)).toEqual([])
    // A model the shipped list names is not closed by the live read alone.
    expect(stale(findings, reg, [], listOf([...CODEX_IDS, 'gpt-6-nova']), live('0.155.1', V155))).toEqual([])
  })

  it('codex-duplicate closes once the registry lists the id only once', () => {
    const findings = [open('models:codex-duplicate:gpt-5.5')]
    expect(stale(findings, reg, [], CODEX_EXPECTED_MODEL_SET, null)).toEqual(['models:codex-duplicate:gpt-5.5'])
    const twice: ModelRegistry = { ...reg, models: [...reg.models, reg.models.find((m) => m.id === 'gpt-5.5')!] }
    const current = codexModelCoverageFindings(twice, CODEX_EXPECTED_MODEL_SET, NOW)
    expect(current.map((f) => f.id)).toContain('models:codex-duplicate:gpt-5.5')
    expect(stale(findings, twice, current, CODEX_EXPECTED_MODEL_SET, null)).toEqual([])
    expect(stale(findings, twice, [], CODEX_EXPECTED_MODEL_SET, null)).toEqual([])
  })

  it("codex-retired: the gpt-5.2 notice stays while 0.155.1 or the shipped list answers, and closes when the installed CLI lists gpt-5.2 again or the registry drops it", () => {
    const findings = [open('models:codex-retired:gpt-5.2')]
    const l155 = live('0.155.1', V155)
    const raised155 = codexModelCoverageFindings(reg, CODEX_EXPECTED_MODEL_SET, NOW, l155)
    expect(raised155.map((f) => f.id)).toEqual(['models:codex-retired:gpt-5.2'])
    expect(stale(findings, reg, raised155, CODEX_EXPECTED_MODEL_SET, l155)).toEqual([])
    // Offline (the shipped list keeps gpt-5.2): not closed, so it does not flap.
    expect(stale(findings, reg, codexModelCoverageFindings(reg, CODEX_EXPECTED_MODEL_SET, NOW), CODEX_EXPECTED_MODEL_SET, null)).toEqual([])
    // 0.153.4 installed and read: it lists gpt-5.2, so the notice is false now.
    const l153 = live('0.153.4', CODEX_IDS)
    expect(stale(findings, reg, codexModelCoverageFindings(reg, CODEX_EXPECTED_MODEL_SET, NOW, l153), CODEX_EXPECTED_MODEL_SET, l153)).toEqual(['models:codex-retired:gpt-5.2'])
    // The registry no longer carries it as a Codex model: closed, offline too.
    const dropped: ModelRegistry = { ...reg, models: reg.models.filter((m) => m.id !== 'gpt-5.2') }
    expect(stale(findings, dropped, [], CODEX_EXPECTED_MODEL_SET, null)).toEqual(['models:codex-retired:gpt-5.2'])
  })

  it('a run that found the list unreadable closes nothing by comparison', () => {
    const findings = [open('models:codex-retired:gpt-5.2'), open('models:codex-missing:gpt-6-nova')]
    const unreadable = [open('models:codex-list-unreadable')]
    expect(stale(findings, reg, unreadable, CODEX_EXPECTED_MODEL_SET, live('0.153.4', CODEX_IDS))).toEqual([])
  })

  it('codex-list-unreadable and codex-check-failed close once a check completes without them', () => {
    const findings = [open('models:codex-list-unreadable'), open('models:codex-check-failed')]
    expect(stale(findings, reg, [], CODEX_EXPECTED_MODEL_SET, null).sort()).toEqual(['models:codex-check-failed', 'models:codex-list-unreadable'])
    const empty: ExpectedModelSet = { models: [] }
    const unreadable = codexModelCoverageFindings(reg, empty, NOW)
    expect(unreadable.map((f) => f.id)).toEqual(['models:codex-list-unreadable'])
    expect(stale(findings, reg, unreadable, empty, null)).toEqual(['models:codex-check-failed'])
  })

  it('codex-list-stale closes once the shipped list has another date, and not before', () => {
    const old = open('models:codex-list-stale:2026-05-01')
    const same = open(`models:codex-list-stale:${CODEX_EXPECTED_MODEL_SET.fetchedAt}`)
    expect(stale([old, same], reg, [], CODEX_EXPECTED_MODEL_SET, null)).toEqual([old.id])
  })

  it('names open Codex model findings only: Claude ones, muted and dismissed ones are never named', () => {
    const findings = [
      open('models:missing:claude-opus-5-5'), open('models:check-failed'), open('models:fixture-unreadable'),
      open('models:codex-missing:gpt-5.5', 'muted'), open('models:codex-missing:gpt-5.6-sol', 'dismissed'), open('models:codex-check-failed', 'muted'),
    ]
    expect(stale(findings, reg, [], CODEX_EXPECTED_MODEL_SET, live('0.153.4', CODEX_IDS))).toEqual([])
  })
})

// S18 review (2026-10-12): the shipped list is the union over the supported
// Codex versions, and a model's own cliVersions names the ones that list it.
// A live read of a Codex OLDER than every version that lists a model has not
// listed it yet: the model is new, not retired, so the retired arm says nothing
// about it, and a notice that said so closes on such a read. A model an equal
// or older version listed, that the installed one no longer lists, is still
// said (gpt-5.2 on 0.155.1). Before this, GPT-6-Sol and GPT-6-Luna (listed from
// 0.156.1) were called "possibly retired" on every supported Codex from 0.153.4
// to 0.156.0. Synthetic models, so this holds whatever the shipped list holds.
describe('a Codex model the shipped list names only from a later Codex is not called retired by an older one (S18)', () => {
  const live = (version: string, ids: string[]) => ({ version, models: ids.map((id) => ({ id, label: id.toUpperCase() })) })
  const codex = (id: string) => ({ id, patterns: [], family: 'codex', label: id.toUpperCase(), efforts: ['low', 'medium', 'high'] })
  const registry = { ...reg, models: [codex('gpt-x-base'), codex('gpt-x-new'), codex('gpt-x-gone')] } as unknown as ModelRegistry
  const shipped = {
    source: 'the model catalogue bundled with the Codex CLI', cliVersions: ['0.153.4', '0.155.1', '0.156.1'], fetchedAt: '2026-10-12',
    models: [
      { id: 'gpt-x-base', label: 'GPT-X-BASE' },
      { id: 'gpt-x-new', label: 'GPT-X-NEW', cliVersions: ['0.156.1'] },
      { id: 'gpt-x-gone', label: 'GPT-X-GONE', cliVersions: ['0.153.4'] },
    ],
  } as ExpectedModelSet
  const NEW = 'models:codex-retired:gpt-x-new'
  const GONE = 'models:codex-retired:gpt-x-gone'
  const ids = (expected: ExpectedModelSet, l: ReturnType<typeof live> | null) => codexModelCoverageFindings(registry, expected, NOW, l).map((f) => f.id)

  it('a Codex older than every version that lists a model does not call it retired; one that dropped a model it listed still does', () => {
    expect(ids(shipped, live('0.155.1', ['gpt-x-base']))).toEqual([GONE])
    expect(ids(shipped, live('0.156.0', ['gpt-x-base']))).toEqual([GONE])
    expect(ids(shipped, live('0.153.4', ['gpt-x-base', 'gpt-x-gone']))).toEqual([])
    // A prerelease of the first version that lists it is older than that version.
    expect(ids(shipped, live('0.156.1-alpha.2', ['gpt-x-base']))).toEqual([GONE])
    expect(ids(shipped, live('0.156.1', ['gpt-x-base', 'gpt-x-new']))).toEqual([GONE])
    // A later Codex that does not list it: said, for that version.
    const later = codexModelCoverageFindings(registry, shipped, NOW, live('0.157.0', ['gpt-x-base']))
    expect(later.map((f) => f.id)).toEqual([NEW, GONE])
    expect(later[0].title).toBe('GPT-X-NEW is still selectable but Codex 0.157.0 no longer lists it')
    // No live list: the shipped list answers, and it names all three.
    expect(ids(shipped, null)).toEqual([])
  })

  it('says it as before when it cannot tell: no versions of its own, a listing version not later than the installed one, or a version that does not parse', () => {
    const variant = (cliVersions: unknown) => ({ ...shipped, models: shipped.models.map((m) => m.id === 'gpt-x-new' ? { ...m, cliVersions } : m) }) as ExpectedModelSet
    for (const cv of [undefined, [], ['0.153.4', '0.156.1'], ['0.155.1'], ['not-a-version'], [156]]) {
      expect(ids(variant(cv), live('0.155.1', ['gpt-x-base'])), JSON.stringify(cv) ?? 'undefined').toContain(NEW)
    }
    expect(ids(shipped, live('dev-build', ['gpt-x-base']))).toContain(NEW)
  })

  it('a notice that called it retired closes on a live read of a Codex that has not listed it yet, and only then', () => {
    const findings = [NEW, GONE].map((id) => ({ id, status: 'open' as FindingStatus }))
    const l155 = live('0.155.1', ['gpt-x-base'])
    expect(staleCodexModelFindingIds(findings, registry, codexModelCoverageFindings(registry, shipped, NOW, l155), shipped, l155)).toEqual([NEW])
    // Offline (the shipped list answers): kept, so it does not come and go with the network.
    expect(staleCodexModelFindingIds(findings, registry, codexModelCoverageFindings(registry, shipped, NOW), shipped, null)).toEqual([])
    // A later Codex that dropped it: raised again, and kept.
    const l157 = live('0.157.0', ['gpt-x-base'])
    expect(staleCodexModelFindingIds(findings, registry, codexModelCoverageFindings(registry, shipped, NOW, l157), shipped, l157)).toEqual([])
  })
})
