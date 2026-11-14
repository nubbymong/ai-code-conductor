import { describe, it, expect } from 'vitest'
import { getAllPricing, normalizeModelForPricing, registryFallbackPricing } from '../../../src/main/tokenomics/tk-pricing'
import { computeCodexCostUsd, priceForModel, codexCachedInputPer1M, codexPricingKeys } from '../../../src/main/providers/codex/pricing'
import { parseClaudeUsageLine } from '../../../src/main/tokenomics/tk-parse'
import { registerProviderPackage } from '../../../src/main/providers/core'
import { createCodexPackage } from '../../../src/main/providers/codex'

// Tokenomics reads Codex's prices through the registered package (WP2 PR 4).
registerProviderPackage(createCodexPackage())

describe('getAllPricing', () => {
  it('includes claude-fable-5 and opus-4-8 with per-1M rates', () => {
    const map = getAllPricing()
    expect(map['claude-fable-5']).toEqual({ input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 })
    expect(map['claude-opus-4-8']).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
  })
  it('maps a codex model into the TkPricing shape with cacheWrite 0', () => {
    const map = getAllPricing()
    const codexKey = Object.keys(map).find((k) => k.startsWith('gpt-'))
    expect(codexKey).toBeTruthy()
    expect(map[codexKey!].cacheWrite).toBe(0)
  })
})

// Usage track MP11: one rule for a missing cached tier, in the session strip
// and in Tokenomics: it costs the full input rate.
describe('the Codex cached-input rate (MP11)', () => {
  it('a model with no cached tier charges cached input at its input rate; one with a tier, at the tier', () => {
    expect(codexCachedInputPer1M({ inputPer1M: 30, cachedInputPer1M: null })).toBe(30)
    expect(codexCachedInputPer1M({ inputPer1M: 5, cachedInputPer1M: 1.25 })).toBe(1.25)
    const map = getAllPricing()
    const noTier = codexPricingKeys().find((k) => priceForModel(k)!.cachedInputPer1M === null)
    expect(noTier).toBeTruthy()
    expect(map[noTier!].cacheRead).toBe(priceForModel(noTier!)!.inputPer1M)
    const tier = codexPricingKeys().find((k) => priceForModel(k)!.cachedInputPer1M !== null)!
    expect(map[tier].cacheRead).toBe(priceForModel(tier)!.cachedInputPer1M)
  })

  it('Tokenomics prices a Codex turn exactly as the session strip does, for every Codex model', () => {
    const map = getAllPricing()
    // A turn: 1000 input of which 400 cached, 50 output. Tokenomics stores
    // the non-cached input and the cached input apart.
    for (const k of codexPricingKeys()) {
      const p = map[k]
      const tokenomics = (600 * p.input + 400 * p.cacheRead + 50 * p.output) / 1e6
      expect(tokenomics, k).toBeCloseTo(computeCodexCostUsd(k, { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50 })!, 12)
    }
  })
})

// [host] P4.11 (review P411-1): the path Tokenomics prices a Claude turn on.
// The worker gets getAllPricing()'s keys and maps each turn's model with
// parseClaudeUsageLine (toPriceModel: its own key, else the longest key it
// starts with). Offline (no live list in a unit test) Opus 5.5 and Sonnet 5.5
// are priced as themselves, dated or not, and an older dated id keeps its own
// version's price beside the cheaper 5.5 entries.
describe('Tokenomics prices Opus 5.5 and Sonnet 5.5 as themselves', () => {
  const map = getAllPricing()
  const keys = Object.keys(map)
  const priced = (model: string) => {
    const line = JSON.stringify({ type: 'assistant', timestamp: '2026-10-03T10:00:00Z', sessionId: 's', requestId: 'r',
      message: { id: 'm', model, usage: { input_tokens: 1, output_tokens: 1 } } })
    const key = parseClaudeUsageLine(line, keys)!.priceModel
    return { key, price: map[key] }
  }
  it('[host] exact and dated 5.5 ids take the 5.5 entries; a dated Opus 4.5 and Sonnet 4.5 keep theirs', () => {
    const opus55 = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
    const sonnet55 = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
    expect(priced('claude-opus-5-5')).toEqual({ key: 'claude-opus-5-5', price: opus55 })
    expect(priced('claude-opus-5-5-20261001')).toEqual({ key: 'claude-opus-5-5', price: opus55 })
    expect(priced('claude-sonnet-5-5')).toEqual({ key: 'claude-sonnet-5-5', price: sonnet55 })
    expect(priced('claude-sonnet-5-5-20261001')).toEqual({ key: 'claude-sonnet-5-5', price: sonnet55 })
    expect(priced('claude-opus-4-5-20251101')).toEqual({ key: 'claude-opus-4-5', price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } })
    expect(priced('claude-sonnet-4-5-20250929')).toEqual({ key: 'claude-sonnet-4-5', price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } })
    expect(priced('claude-opus-5')).toEqual({ key: 'claude-opus-5', price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } })
  })
})

// planning #310: a price key that ends in a digit is not the start of a model
// name whose next character is a digit too. The dated id of Fable 5
// (claude-fable-5-20260101) starts with `claude-fable-5-2`, the longest key it
// starts with, so each such turn was priced as Fable 5.2 (8 and 40 per million
// tokens, not 10 and 50). The same rule as the model matcher's (nameStartsWithId).
describe('a dated Fable 5 turn is priced as Fable 5, not as Fable 5.2', () => {
  const map = getAllPricing()
  const keys = Object.keys(map)
  const priced = (model: string) => {
    const line = JSON.stringify({ type: 'assistant', timestamp: '2026-11-14T10:00:00Z', sessionId: 's', requestId: 'r',
      message: { id: 'm', model, usage: { input_tokens: 1, output_tokens: 1 } } })
    const key = parseClaudeUsageLine(line, keys)!.priceModel
    return { key, price: map[key] }
  }
  const fable5 = { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 }
  const fable52 = { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }

  it('on the path Tokenomics prices a turn on (parseClaudeUsageLine)', () => {
    expect(priced('claude-fable-5-20260101')).toEqual({ key: 'claude-fable-5', price: fable5 })
    expect(priced('claude-fable-5-20251001')).toEqual({ key: 'claude-fable-5', price: fable5 })
    expect(priced('claude-fable-5')).toEqual({ key: 'claude-fable-5', price: fable5 })
    // Fable 5.2 keeps its own turns, dated or not; Fable 5.1 too.
    expect(priced('claude-fable-5-2')).toEqual({ key: 'claude-fable-5-2', price: fable52 })
    expect(priced('claude-fable-5-2-20261101')).toEqual({ key: 'claude-fable-5-2', price: fable52 })
    expect(priced('claude-fable-5-1-20260801')).toEqual({ key: 'claude-fable-5-1', price: fable5 })
  })

  it('a dated id of every priced Claude model takes that model\'s own key', () => {
    for (const id of Object.keys(registryFallbackPricing())) {
      expect(priced(`${id}-20260101`).key, id).toBe(id)
      expect(normalizeModelForPricing(`${id}-20260101`, keys), id).toBe(id)
    }
  })

  it('with no shorter key to take, the model keeps its own name (no price), never the key of another number', () => {
    const line = (model: string) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-14T10:00:00Z', sessionId: 's',
      message: { id: 'm', model, usage: { input_tokens: 1, output_tokens: 1 } } })
    const only = ['claude-fable-5-2']
    expect(parseClaudeUsageLine(line('claude-fable-5-20260101'), only)?.priceModel).toBe('claude-fable-5-20260101')
    expect(parseClaudeUsageLine(line('claude-fable-5-2-20261101'), only)?.priceModel).toBe('claude-fable-5-2')
    expect(normalizeModelForPricing('claude-fable-5-20260101', only)).toBe('claude-fable-5-20260101')
    expect(normalizeModelForPricing('claude-fable-5-2-20261101', only)).toBe('claude-fable-5-2')
  })
})

// planning #310: a model written with a dot is read with the dot as a hyphen
// too, and takes the longest key of either reading. As written,
// claude-opus-5.5 starts with the key claude-opus-5 alone (a dot follows, not
// a digit), so each such turn was priced as Opus 5 (5 and 25 per million
// tokens, not 4 and 20), and claude-fable-5.2 as Fable 5 (10 and 50, not 8 and
// 40). An older model written that way (claude-opus-4.7) started with no key
// and had no price. The same rule as the model matcher's
// (longestIdNameStartsWith).
describe('a Claude model written with a dot is priced as itself', () => {
  const map = getAllPricing()
  const keys = Object.keys(map)
  const line = (model: string) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-14T10:00:00Z', sessionId: 's', requestId: 'r',
    message: { id: 'm', model, usage: { input_tokens: 1, output_tokens: 1 } } })
  const keyOf = (model: string, list: string[] = keys) => parseClaudeUsageLine(line(model), list)!.priceModel
  const priced = (model: string) => ({ key: keyOf(model), price: map[keyOf(model)] })
  const opus55 = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
  const sonnet55 = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
  const fable52 = { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }
  const fable51 = { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 }

  it('the 5.x models take their own key and price, on the path Tokenomics prices a turn on', () => {
    for (const [name, key, price] of [['claude-opus-5.5', 'claude-opus-5-5', opus55], ['claude-sonnet-5.5', 'claude-sonnet-5-5', sonnet55],
      ['claude-fable-5.2', 'claude-fable-5-2', fable52], ['claude-fable-5.1', 'claude-fable-5-1', fable51]] as const) {
      for (const written of [name, `${name}-20260101`, `${name}[1m]`]) {
        expect(priced(written), written).toEqual({ key, price })
        expect(normalizeModelForPricing(written, keys), written).toBe(key)
      }
    }
    // The base models keep their own turns.
    expect(priced('claude-opus-5-20260101').key).toBe('claude-opus-5')
    expect(priced('claude-fable-5-20260101').key).toBe('claude-fable-5')
  })

  it('every priced Claude model with a two-part version, written with a dot, takes its own key', () => {
    const twoPart = Object.keys(registryFallbackPricing()).filter((id) => /\d-\d/.test(id))
    expect(twoPart.length).toBe(13)
    for (const id of twoPart) {
      const dotted = id.replace(/(\d)-(\d)/, '$1.$2')
      for (const written of [dotted, `${dotted}-20260101`]) {
        expect(priced(written), written).toEqual({ key: id, price: map[id] })
        expect(normalizeModelForPricing(written, keys), written).toBe(id)
      }
    }
  })

  it('the longest key of either reading, as the same name written with a hyphen; a key is compared as it is written', () => {
    for (const list of [['claude-x-5', 'claude-x-5-5'], ['claude-x-5-5', 'claude-x-5']]) {
      for (const [dotted, hyphenated] of [['claude-x-5.5', 'claude-x-5-5'], ['claude-x-5.5-20260101', 'claude-x-5-5-20260101'], ['claude-x-5.7', 'claude-x-5-7'],
        ['claude-x-5.55', 'claude-x-5-55'], ['claude-x-5.5.1', 'claude-x-5-5-1']]) {
        expect(keyOf(dotted, list), dotted).toBe(keyOf(hyphenated, list))
        expect(normalizeModelForPricing(dotted, list), dotted).toBe(normalizeModelForPricing(hyphenated, list))
      }
      expect(keyOf('claude-x-5.5-20260101', list)).toBe('claude-x-5-5')
      expect(keyOf('claude-x-5.7', list)).toBe('claude-x-5')
    }
    // With no longer key to take, the base model's key, as the hyphenated name takes it.
    expect(keyOf('claude-x-5.5', ['claude-x-5'])).toBe('claude-x-5')
    expect(normalizeModelForPricing('claude-x-5.5', ['claude-x-5'])).toBe('claude-x-5')
    // The digit rule holds for the second reading: 5.20 is not 5.2.
    expect(keyOf('claude-x-5.20', ['claude-x-5-2'])).toBe('claude-x-5.20')
    expect(normalizeModelForPricing('claude-x-5.20', ['claude-x-5-2', 'claude-x-5'])).toBe('claude-x-5')
    // A key written with a dot is found in the name as written, its own key
    // first; of two keys as long, the one in the name as written.
    for (const list of [['claude-3-5-sonnet', 'claude-3.5-sonnet'], ['claude-3.5-sonnet', 'claude-3-5-sonnet']]) {
      expect(keyOf('claude-3.5-sonnet', list)).toBe('claude-3.5-sonnet')
      expect(keyOf('claude-3.5-sonnet-20241022', list)).toBe('claude-3.5-sonnet')
      expect(keyOf('claude-3-5-sonnet-20241022', list)).toBe('claude-3-5-sonnet')
      expect(normalizeModelForPricing('claude-3.5-sonnet-20241022', list)).toBe('claude-3.5-sonnet')
    }
    expect(keyOf('claude-3.5-sonnet-20241022', ['claude-3-5-sonnet'])).toBe('claude-3-5-sonnet')
    // A hyphen is never read as a dot.
    expect(keyOf('claude-3-5-sonnet-20241022', ['claude-3.5-sonnet'])).toBe('claude-3-5-sonnet-20241022')
  })

  it('names the change leaves alone: a dot not between two digits, a gateway\'s name, a model no key is the start of', () => {
    for (const name of ['claude-opus-5.x', 'claude-opus-5.', 'claude-opus-5.-5']) {
      expect(keyOf(name), name).toBe('claude-opus-5')
      expect(normalizeModelForPricing(name, keys), name).toBe('claude-opus-5')
    }
    // Tokenomics has no pattern step: a name that starts with no key has no price.
    for (const name of ['anthropic/claude-opus-5.5', 'us.anthropic.claude-opus-5-5-v1:0', 'claude-3.5-sonnet', 'claude-3-5-sonnet-20241022', 'claude-opus-4.75', 'mystery-1.5']) {
      expect(keyOf(name), name).toBe(name)
      expect(normalizeModelForPricing(name, keys), name).toBe(name)
    }
  })
})

describe('normalizeModelForPricing', () => {
  it('a dated Fable 5 id is Fable 5\'s key, and a dated Fable 5.2 id is Fable 5.2\'s (planning #310)', () => {
    const keys = Object.keys(registryFallbackPricing())
    expect(normalizeModelForPricing('claude-fable-5-20260101', keys)).toBe('claude-fable-5')
    expect(normalizeModelForPricing('claude-fable-5-2-20261101', keys)).toBe('claude-fable-5-2')
  })
  it('exact match wins', () => {
    expect(normalizeModelForPricing('claude-opus-4-8', Object.keys(registryFallbackPricing()))).toBe('claude-opus-4-8')
  })
  it('longest prefix match for dated models', () => {
    expect(normalizeModelForPricing('claude-opus-4-8-20260101', Object.keys(registryFallbackPricing()))).toBe('claude-opus-4-8')
  })
  it('returns raw model when nothing matches', () => {
    expect(normalizeModelForPricing('mystery-model', Object.keys(registryFallbackPricing()))).toBe('mystery-model')
  })
})
