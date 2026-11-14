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
import { describe, it, expect } from 'vitest'
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
