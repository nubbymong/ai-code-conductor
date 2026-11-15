// A model entry proposed to the registry: the proposed id and aliases are
// held to the fetched-file name rule (idHeldBy in
// src/main/model-registry-data.ts), asked of every entry the registry has.
// The id and each alias are refused when they are a known id or alias, a
// dated or bracketed form of a known id (claude-opus-4-8-20260301,
// claude-opus-4-8[1m]), or one of those read with each dot between two
// digits as a hyphen (claude-opus-5.5). A new version the registry only
// reaches by a shorter id or by a pattern (claude-opus-5-7, claude-opus-6)
// is free, which is how a model is added. Beside
// tests/unit/sentinel-apply.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { validateProposal } from '../../../src/main/sentinel/sentinel-apply'
import { _initRegistryForTest, applyOverlayEntry, getRegistry } from '../../../src/main/model-registry-service'
import { resolveModelInfo, type ModelRegistry, type OverlayModelEntry } from '../../../src/shared/model-registry'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-known-names-')); _initRegistryForTest(dir) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** Stands for the family of the other assistant's models, which is read
 *  from the registry: the family of the shipped gpt-5.5. */
const OTHER_ASSISTANT = 'the other assistant'
const familyNamed = (family: string): string =>
  family === OTHER_ASSISTANT ? getRegistry().models.find((m) => m.id === 'gpt-5.5')!.family : family

const proposal = (id: string, family = 'opus', more: Partial<OverlayModelEntry> = {}): OverlayModelEntry => ({
  // A pattern no known id holds, so only the name under test can refuse it.
  id, patterns: ['zz-new-only'], family: familyNamed(family), label: 'New',
  provenance: { addedBy: 'sentinel', date: '2026-11-15' },
  ...more,
})
const check = (e: OverlayModelEntry, registry: ModelRegistry = getRegistry()) => validateProposal(registry, e)

describe('a proposed id that is a known model\'s own name is refused', () => {
  it.each([
    ['a known id with a date after it', 'claude-opus-4-8-20260301', 'opus', 'claude-opus-4-8'],
    ['the dated id of Fable 5, which starts with claude-fable-5-2 as text', 'claude-fable-5-20260101', 'fable', 'claude-fable-5'],
    ['a known id with a context size after it', 'claude-opus-4-8[1m]', 'opus', 'claude-opus-4-8'],
    ['a known id with its version written with a dot', 'claude-opus-5.5', 'opus', 'claude-opus-5-5'],
    ['an older known id written with a dot, dated', 'claude-opus-4.7-20260101', 'opus', 'claude-opus-4-7'],
    ['a known alias', 'opus[1m]', 'opus', 'claude-opus-5-5'],
    ['a known id of the other assistant with a date after it', 'gpt-5.5-20260101', OTHER_ASSISTANT, 'gpt-5.5'],
  ])('%s (%s)', (_what, id, family, holder) => {
    // Before the entry: the registry gives the name to the model it has.
    expect(resolveModelInfo(getRegistry(), id)).toMatchObject({ known: true, id: holder })
    const r = check(proposal(id, family))
    expect(r.ok).toBe(false)
    expect(r.error).toBe(`"${id}" is a name the registry already gives to ${holder}`)
  })

  it('a dated form of a model the user added earlier is that model\'s too', () => {
    applyOverlayEntry({ id: 'claude-opus-7', patterns: ['opus-7'], family: 'opus', label: 'My Opus 7', provenance: { addedBy: 'user', date: '2026-11-15' } })
    const r = check(proposal('claude-opus-7-20270101'))
    expect(r).toEqual({ ok: false, error: '"claude-opus-7-20270101" is a name the registry already gives to claude-opus-7' })
  })

  it('and of a model only the fetched model file has', () => {
    const fetched: OverlayModelEntry = { id: 'claude-opus-6', patterns: ['opus-6'], family: 'opus', label: 'Opus 6', provenance: { addedBy: 'model-data', date: '2026-11-15' } }
    const registry: ModelRegistry = { ...getRegistry(), models: [fetched, ...getRegistry().models] }
    for (const id of ['claude-opus-6-20270101', 'claude-opus-6[1m]']) {
      expect(check(proposal(id), registry), id).toEqual({ ok: false, error: `"${id}" is a name the registry already gives to claude-opus-6` })
    }
  })
})

describe('a proposed alias that is a known model\'s own name is refused', () => {
  it.each([
    ['a known id with a date after it', 'claude-opus-4-8-20260301', 'claude-opus-4-8'],
    ['a known id with a context size after it', 'claude-sonnet-4-6[1m]', 'claude-sonnet-4-6'],
    ['a known id with its version written with a dot', 'claude-opus-5.5', 'claude-opus-5-5'],
  ])('%s (%s)', (_what, alias, holder) => {
    const r = check(proposal('claude-opus-9', 'opus', { aliases: ['fresh-alias', alias] }))
    expect(r).toEqual({ ok: false, error: `"${alias}" is a name the registry already gives to ${holder}` })
  })
})

describe('a new model keeps the names that are its own', () => {
  it.each([
    ['a new version the registry reaches by a shorter id', 'claude-opus-5-7', 'opus'],
    ['a new version of Fable 5', 'claude-fable-5-3', 'fable'],
    ['a longer form of a known id that is not a dated one', 'claude-opus-5-5-2', 'opus'],
    ['a new version the registry reaches by its family\'s pattern', 'claude-opus-6', 'opus'],
    ['the dated id of a model the registry does not have', 'claude-opus-6-20270101', 'opus'],
    ['a new version written with a dot', 'claude-opus-6.1', 'opus'],
    ['an id of the other assistant written with a hyphen where a known one has a dot', 'gpt-5-5', OTHER_ASSISTANT],
  ])('%s (%s)', (_what, id, family) => {
    expect(check(proposal(id, family))).toEqual({ ok: true })
  })

  it('and its own id with a date or a context size after it as an alias', () => {
    expect(check(proposal('claude-opus-6', 'opus', { aliases: ['claude-opus-6-20270101', 'claude-opus-6[1m]', 'opus6'] }))).toEqual({ ok: true })
  })
})

describe('a refused proposal changes nothing', () => {
  it('Apply answers the refusal, and the dated name is still the model it belongs to', async () => {
    const { initSentinel, sentinelApply } = await import('../../../src/main/sentinel/index')
    const st = initSentinel(dir)
    const before = resolveModelInfo(getRegistry(), 'claude-opus-4-8-20260301')
    expect(before).toMatchObject({ id: 'claude-opus-4-8', matchKind: 'prefix', label: 'Opus 4.8' })
    st.upsertFinding({
      id: 'hand:model:dated', kind: 'registry-proposal', severity: 'warn',
      title: 't', evidence: 'e', status: 'open', createdAt: 1,
      proposedPatch: proposal('claude-opus-4-8-20260301'),
    })
    expect(sentinelApply('hand:model:dated')).toEqual({ ok: false, error: '"claude-opus-4-8-20260301" is a name the registry already gives to claude-opus-4-8' })
    expect(getRegistry().models.some((m) => m.id === 'claude-opus-4-8-20260301')).toBe(false)
    expect(resolveModelInfo(getRegistry(), 'claude-opus-4-8-20260301')).toEqual(before)
    expect(st.snapshot().findings[0].status).toBe('open')
  })
})

// The user's own registry file is merged in as it is written, so the
// registry may hold something that is no entry, or an entry with no id. The
// matcher passes such a one over (usableEntries), and so does the check.
describe('a registry that holds an entry with no id, or something that is no entry', () => {
  const withOddEntries = (): ModelRegistry => ({
    ...getRegistry(),
    models: [
      null,
      { label: 'No id', patterns: ['zz-none'], family: 'opus' },
      { id: '', label: 'Empty id', patterns: ['zz-empty'], family: 'opus' },
      { id: 7, label: 'A number', patterns: ['zz-number'], family: 'opus' },
      ...getRegistry().models,
    ] as unknown as ModelRegistry['models'],
  })

  // Mutation to prove this can fail: read the registry's entries as they are.
  it('the check answers, and every other entry still holds its names', () => {
    const registry = withOddEntries()
    let dated: unknown
    expect(() => { dated = check(proposal('claude-opus-4-8-20260301'), registry) }).not.toThrow()
    expect(dated).toEqual({ ok: false, error: '"claude-opus-4-8-20260301" is a name the registry already gives to claude-opus-4-8' })
    expect(check(proposal('claude-opus-4-8'), registry)).toMatchObject({ ok: false })
    expect(check(proposal('claude-opus-9', 'opus', { aliases: ['claude-sonnet-4-6[1m]'] }), registry))
      .toEqual({ ok: false, error: '"claude-sonnet-4-6[1m]" is a name the registry already gives to claude-sonnet-4-6' })
    expect(check(proposal('claude-opus-9', 'opus', { patterns: ['opus-4-8'] }), registry)).toMatchObject({ ok: false })
  })

  it('a new model is still taken beside them', () => {
    const registry = withOddEntries()
    expect(check(proposal('claude-opus-5-7'), registry)).toEqual({ ok: true })
    expect(check(proposal('claude-opus-6', 'opus', { aliases: ['opus6'] }), registry)).toEqual({ ok: true })
  })
})
