// 2.1.3-beta.4: the summary's token totals. The headline figures and the
// daily series carry the tokens beside the costs: input, output, cache
// read, cache write and their total, for life to date and the last seven
// days, and for each day with its total split by provider as the cost is.
// Tokens count every model, priced or not. Pure: the rows the summary
// queries return, turned into the shape the page reads (tk-summary.ts); the
// queries themselves run on the real database in
// tests/unit/native/tk-db-summary.native.test.ts.
import { describe, it, expect } from 'vitest'
import { tkDailySeriesOf, tkKpisOf, tkTokenSumsSql, tkTokenTotals } from '../../../src/main/tokenomics/tk-summary'

const tok = (inTok: number, outTok: number, cacheReadTok: number, cacheCreateTok: number) => ({ inTok, outTok, cacheReadTok, cacheCreateTok })

describe('token totals (2.1.3-beta.4)', () => {
  it('sums each kind and gives their total', () => {
    expect(tkTokenTotals([tok(1, 2, 3, 4), tok(10, 20, 30, 40)])).toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 })
  })

  it('reads a missing or empty sum as none, never as NaN', () => {
    expect(tkTokenTotals([])).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })
    expect(tkTokenTotals([{ inTok: null, outTok: undefined }])).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })
  })

  it('the SQL sums every kind under the names the rows are read by', () => {
    const sql = tkTokenSumsSql('d')
    for (const col of ['inTok', 'outTok', 'cacheReadTok', 'cacheCreateTok']) {
      expect(sql).toContain(`COALESCE(SUM(d.${col}),0) AS ${col}`)
    }
  })
})

describe('the headline figures carry their tokens (2.1.3-beta.4)', () => {
  const rows = {
    life: [
      { provider: 'claude', cost: 10, savings: 1, ...tok(100, 20, 300, 4) },
      { provider: 'codex', cost: 2, savings: 0.5, ...tok(50, 5, 0, 0) },
    ],
    last7: [
      { provider: 'claude', cost: 3, ...tok(30, 2, 60, 1) },
      { provider: 'codex', cost: 1, ...tok(7, 1, 0, 0) },
    ],
    prev7: [{ provider: 'claude', cost: 4 }],
  }

  it('in all: life to date and the last seven days, each kind and the total', () => {
    const k = tkKpisOf(rows, () => true)
    expect(k.lifeToDateTokens).toEqual({ input: 150, output: 25, cacheRead: 300, cacheWrite: 4, total: 479 })
    expect(k.last7dTokens).toEqual({ input: 37, output: 3, cacheRead: 60, cacheWrite: 1, total: 101 })
  })

  it('per provider, and the parts make the whole', () => {
    const all = tkKpisOf(rows, () => true)
    const claude = tkKpisOf(rows, (p) => p === 'claude')
    const codex = tkKpisOf(rows, (p) => p === 'codex')
    expect(claude.lifeToDateTokens.total).toBe(424)
    expect(codex.lifeToDateTokens.total).toBe(55)
    for (const w of ['lifeToDateTokens', 'last7dTokens'] as const) {
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
        expect(claude[w][k] + codex[w][k], `${w}.${k}`).toBe(all[w][k])
      }
    }
  })

  it('the cost figures are as they were', () => {
    const k = tkKpisOf(rows, () => true)
    expect(k.lifeToDateCostUsd).toBe(12)
    expect(k.last7dCostUsd).toBe(4)
    expect(k.prev7dCostUsd).toBe(4)
    expect(k.cacheSavingsUsd).toBe(1.5)
    // Cache read over cache read and input, all time.
    expect(k.cacheEfficiencyPct).toBeCloseTo((300 / (300 + 150)) * 100, 9)
    expect(tkKpisOf({ life: [], last7: [], prev7: [] }, () => true)).toEqual({
      lifeToDateCostUsd: 0, last7dCostUsd: 0, prev7dCostUsd: 0, cacheEfficiencyPct: 0, cacheSavingsUsd: 0,
      lifeToDateTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      last7dTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    })
  })
})

describe('the daily series carries each day\'s tokens (2.1.3-beta.4)', () => {
  it('one point a day: its tokens in all, and their total per provider beside the cost', () => {
    const series = tkDailySeriesOf([
      { day: '2026-06-01', provider: 'claude', costUsd: 5, ...tok(1_000, 10, 200, 3) },
      { day: '2026-06-01', provider: 'codex', costUsd: 2, ...tok(400, 4, 0, 0) },
      // A day whose only usage has no price: no cost, and its tokens.
      { day: '2026-06-02', provider: 'codex', costUsd: null, ...tok(50, 0, 0, 0) },
    ])
    expect(series).toEqual([
      {
        day: '2026-06-01', costUsd: 7, byProvider: { claude: 5, codex: 2 },
        tokens: { input: 1_400, output: 14, cacheRead: 200, cacheWrite: 3, total: 1_617 },
        tokensByProvider: { claude: 1_213, codex: 404 },
      },
      {
        day: '2026-06-02', costUsd: 0, byProvider: { claude: 0, codex: 0 },
        tokens: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, total: 50 },
        tokensByProvider: { claude: 0, codex: 50 },
      },
    ])
  })

  it('a provider it does not know counts in the day\'s totals and in no split, as its cost always has', () => {
    const [day] = tkDailySeriesOf([{ day: '2026-06-01', provider: 'other', costUsd: 1, ...tok(9, 0, 0, 0) }])
    expect(day.costUsd).toBe(1)
    expect(day.tokens.total).toBe(9)
    expect(day.byProvider).toEqual({ claude: 0, codex: 0 })
    expect(day.tokensByProvider).toEqual({ claude: 0, codex: 0 })
  })

  it('no rows, no points', () => {
    expect(tkDailySeriesOf([])).toEqual([])
  })
})
