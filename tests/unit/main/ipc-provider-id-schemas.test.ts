// The IPC schemas that take a provider id take exactly the app's own list.
//
// Three requests from the renderer name a provider: a session spawn
// (pty:spawn), a Cloud Agent dispatch, and a usage filter. Each holds that
// field to one shared schema built from PROVIDER_IDS, the list the provider
// registry is keyed by, so a provider added to (or taken off) that list is
// accepted (or refused) by all three at once and none restates the names.
//
// The shipped schemas are imported, not mirrored: each one's `provider` field
// is read out of it and asked directly.
import { describe, it, expect, vi } from 'vitest'
import { PROVIDER_IDS } from '../../../src/shared/providers'
import { providerIdSchema } from '../../../src/main/ipc/provider-id-schema'
import { spawnOptionsSchema } from '../../../src/main/ipc/pty-handlers'
import { dispatchSchema } from '../../../src/main/ipc/cloud-agent-handlers'
import { filterSchema } from '../../../src/main/ipc/tokenomics2-handlers'

/** A `provider` field as each schema declares it: optional, over one inner schema. */
type ProviderField = { safeParse: (v: unknown) => { success: boolean }; unwrap: () => unknown }
const fields: Array<[string, ProviderField]> = [
  // (pty:spawn's options are themselves optional: the object is one level in.)
  ['pty:spawn options', spawnOptionsSchema.unwrap().shape.provider as unknown as ProviderField],
  ['a Cloud Agent dispatch', dispatchSchema.shape.provider as unknown as ProviderField],
  ['a usage filter', filterSchema.shape.provider as unknown as ProviderField],
]
/** Values that are not a provider id, spellings near one included. */
const NOT_IDS: unknown[] = ['elsewhere', '', ' ', PROVIDER_IDS[0].toUpperCase(), `${PROVIDER_IDS[0]} `, PROVIDER_IDS.join(','), 0, 1, true, null, {}, [PROVIDER_IDS[0]]]

describe('the shared provider id schema', () => {
  it('lists exactly the app\'s provider ids, in the app\'s order', () => {
    expect(providerIdSchema.options).toEqual([...PROVIDER_IDS])
  })

  it('accepts each of them and nothing else', () => {
    for (const id of PROVIDER_IDS) expect(providerIdSchema.safeParse(id).success, id).toBe(true)
    for (const v of [...NOT_IDS, undefined]) expect(providerIdSchema.safeParse(v).success, JSON.stringify(v)).toBe(false)
  })
})

// Mutation to prove this can fail: write the names out again in one of the
// three schemas (the same two names: every value is still answered the same,
// and the schema no longer follows the list).
describe.each(fields)('the provider named in %s', (_what, field) => {
  it('is the shared schema, not a list of its own', () => {
    expect(field.unwrap()).toBe(providerIdSchema)
  })

  it('accepts every provider id the app knows, and a request that names none', () => {
    for (const id of PROVIDER_IDS) expect(field.safeParse(id).success, id).toBe(true)
    expect(field.safeParse(undefined).success).toBe(true)
  })

  it('refuses anything that is not one of them', () => {
    for (const v of NOT_IDS) expect(field.safeParse(v).success, JSON.stringify(v)).toBe(false)
  })
})

// The cases above hold the schemas to the list as it stands, which a schema
// that wrote the same names out again would pass too. This one changes the
// list: the module the app's provider ids live in is stood in for by itself
// plus one more id, and everything else is the app's own, imported afresh
// over it. The shared schema and each of the three requests then accept the
// added id, which only a schema built from the list does.
// Mutation to prove this can fail: write the two names out in the shared
// schema (it lists the same two, so every case above still passes).
describe('with one more id on the app\'s list of providers', () => {
  const THIRD = 'third'
  const IDS = '../../../src/shared/providers/ids'

  it('the shared schema and all three requests accept it, and still refuse anything that is not on the list', async () => {
    vi.resetModules()
    vi.doMock(IDS, async (importOriginal) => {
      const real = await importOriginal<typeof import('../../../src/shared/providers/ids')>()
      const widened: readonly string[] = [...real.PROVIDER_IDS, THIRD]
      return { ...real, PROVIDER_IDS: widened, isProviderId: (v: unknown): boolean => typeof v === 'string' && widened.includes(v) }
    })
    try {
      const listed = (await import('../../../src/shared/providers')).PROVIDER_IDS as readonly string[]
      expect(listed, 'the list the schemas are built from holds the added id').toEqual([...PROVIDER_IDS, THIRD])
      const shared = (await import('../../../src/main/ipc/provider-id-schema')).providerIdSchema
      const spawn = (await import('../../../src/main/ipc/pty-handlers')).spawnOptionsSchema
      const dispatch = (await import('../../../src/main/ipc/cloud-agent-handlers')).dispatchSchema
      const filter = (await import('../../../src/main/ipc/tokenomics2-handlers')).filterSchema
      expect(shared, 'the schema was built again, over the widened list').not.toBe(providerIdSchema)
      expect(shared.options).toEqual(listed)
      expect(shared.safeParse(THIRD).success).toBe(true)

      const widenedFields: Array<[string, ProviderField]> = [
        ['pty:spawn options', spawn.unwrap().shape.provider as unknown as ProviderField],
        ['a Cloud Agent dispatch', dispatch.shape.provider as unknown as ProviderField],
        ['a usage filter', filter.shape.provider as unknown as ProviderField],
      ]
      for (const [what, field] of widenedFields) {
        expect(field.unwrap(), what).toBe(shared)
        for (const id of listed) expect(field.safeParse(id).success, `${what}: ${id}`).toBe(true)
        for (const v of NOT_IDS) expect(field.safeParse(v).success, `${what}: ${JSON.stringify(v)}`).toBe(false)
      }
      // And as whole requests.
      expect(spawn.safeParse({ provider: THIRD }).success).toBe(true)
      expect(dispatch.safeParse({ name: 'n', description: 'd', projectPath: '/p', provider: THIRD }).success).toBe(true)
      expect(filter.safeParse({ provider: THIRD }).success).toBe(true)
      expect(spawn.safeParse({ provider: 'elsewhere' }).success).toBe(false)
      expect(dispatch.safeParse({ name: 'n', description: 'd', projectPath: '/p', provider: 'elsewhere' }).success).toBe(false)
      expect(filter.safeParse({ provider: 'elsewhere' }).success).toBe(false)
    } finally {
      vi.doUnmock(IDS)
      vi.resetModules()
    }
  })

  it('the schemas as the app has them do not know that id', () => {
    expect(PROVIDER_IDS as readonly string[]).not.toContain(THIRD)
    expect(providerIdSchema.safeParse(THIRD).success).toBe(false)
    for (const [what, field] of fields) expect(field.safeParse(THIRD).success, what).toBe(false)
  })
})

describe('a whole request that names a provider the app does not know', () => {
  it('is refused by each schema', () => {
    expect(spawnOptionsSchema.safeParse({ provider: 'elsewhere' }).success).toBe(false)
    expect(dispatchSchema.safeParse({ name: 'n', description: 'd', projectPath: '/p', provider: 'elsewhere' }).success).toBe(false)
    expect(filterSchema.safeParse({ provider: 'elsewhere' }).success).toBe(false)
  })

  it('and accepted when it names the first provider on the list, or none', () => {
    const [first] = PROVIDER_IDS
    expect(spawnOptionsSchema.safeParse({ provider: first }).success).toBe(true)
    expect(spawnOptionsSchema.safeParse({}).success).toBe(true)
    expect(dispatchSchema.safeParse({ name: 'n', description: 'd', projectPath: '/p', provider: first }).success).toBe(true)
    expect(dispatchSchema.safeParse({ name: 'n', description: 'd', projectPath: '/p' }).success).toBe(true)
    expect(filterSchema.safeParse({ provider: first }).success).toBe(true)
    expect(filterSchema.safeParse({}).success).toBe(true)
  })
})
