/**
 * tk-summary.ts: how the summary's headline figures and daily series are made
 * from the rows its queries return (tk-db.ts querySummary). Pure, with no
 * database, so the shape the page reads is tested on plain Node; the queries
 * themselves are tested on the real database in tests/unit/native.
 *
 * Costs cover the models with a price only (MP11). Tokens (2.1.3-beta.4)
 * cover every model, priced or not, and follow the same filters, windows
 * and split by provider as the costs beside them.
 */
import type { TkDailyPoint, TkKpis, TkProvider, TkTokenTotals } from './tk-types'
import { PROVIDER_IDS } from '../../shared/providers/ids'

/** The providers a summary splits its figures by (MP11): every provider id
 *  the registry lists. A provider added there that Tokenomics does not know
 *  is a compile error here, not a figure quietly left out. */
export const TK_SUMMARY_PROVIDERS: readonly TkProvider[] = PROVIDER_IDS

/** A query row's token sums, by the names the summary queries give them. */
export interface TkTokenSums {
  inTok?: number | null
  outTok?: number | null
  cacheReadTok?: number | null
  cacheCreateTok?: number | null
}

/** The SQL that sums a table's tokens into the names above. */
export function tkTokenSumsSql(alias: string): string {
  return [
    `COALESCE(SUM(${alias}.inTok),0) AS inTok`,
    `COALESCE(SUM(${alias}.outTok),0) AS outTok`,
    `COALESCE(SUM(${alias}.cacheReadTok),0) AS cacheReadTok`,
    `COALESCE(SUM(${alias}.cacheCreateTok),0) AS cacheCreateTok`,
  ].join(', ')
}

const num = (v: unknown): number => Number(v) || 0

/** The token totals of some rows: each kind summed, and all of them. */
export function tkTokenTotals(rows: readonly TkTokenSums[]): TkTokenTotals {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0
  for (const r of rows) {
    input += num(r.inTok)
    output += num(r.outTok)
    cacheRead += num(r.cacheReadTok)
    cacheWrite += num(r.cacheCreateTok)
  }
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

/** A row of the life-to-date query: one provider's all-time figures. */
export interface TkLifeRow extends TkTokenSums { provider: string; cost?: number | null; savings?: number | null }
/** A row of the last-7-days query: one provider's figures for the week. */
export interface TkWeekRow extends TkTokenSums { provider: string; cost?: number | null }
/** A row of the week-before query: one provider's cost for it. */
export interface TkPrevWeekRow { provider: string; cost?: number | null }

/** The headline figures of the providers `keep` keeps. */
export function tkKpisOf(
  rows: { life: readonly TkLifeRow[]; last7: readonly TkWeekRow[]; prev7: readonly TkPrevWeekRow[] },
  keep: (provider: string) => boolean,
): TkKpis {
  const life = rows.life.filter((r) => keep(String(r.provider)))
  const last7 = rows.last7.filter((r) => keep(String(r.provider)))
  const prev7 = rows.prev7.filter((r) => keep(String(r.provider)))
  const sum = <T>(list: readonly T[], value: (r: T) => unknown): number => list.reduce((a, r) => a + num(value(r)), 0)
  const lifeTokens = tkTokenTotals(life)
  const cr = lifeTokens.cacheRead, inp = lifeTokens.input
  return {
    lifeToDateCostUsd: sum(life, (r) => r.cost),
    last7dCostUsd: sum(last7, (r) => r.cost),
    prev7dCostUsd: sum(prev7, (r) => r.cost),
    cacheEfficiencyPct: (cr + inp) > 0 ? (cr / (cr + inp)) * 100 : 0,
    cacheSavingsUsd: sum(life, (r) => r.savings),
    lifeToDateTokens: lifeTokens,
    last7dTokens: tkTokenTotals(last7),
  }
}

/** A row of the daily query: one provider's figures for one day. */
export interface TkDailyRow extends TkTokenSums { day: string; provider: string; costUsd?: number | null }

/** The daily series from rows ordered by day: one point a day, its cost and
 *  tokens in all and split by provider. A provider the page does not know
 *  counts in the day's totals and in no split, as its cost always has. */
export function tkDailySeriesOf(rows: readonly TkDailyRow[]): TkDailyPoint[] {
  const out: TkDailyPoint[] = []
  for (const r of rows) {
    let day = out[out.length - 1]
    if (!day || day.day !== r.day) {
      day = {
        day: r.day,
        costUsd: 0,
        byProvider: { claude: 0, codex: 0 },
        tokens: tkTokenTotals([]),
        tokensByProvider: { claude: 0, codex: 0 },
      }
      out.push(day)
    }
    const cost = num(r.costUsd)
    const tokens = tkTokenTotals([r])
    day.costUsd += cost
    day.tokens = {
      input: day.tokens.input + tokens.input,
      output: day.tokens.output + tokens.output,
      cacheRead: day.tokens.cacheRead + tokens.cacheRead,
      cacheWrite: day.tokens.cacheWrite + tokens.cacheWrite,
      total: day.tokens.total + tokens.total,
    }
    if ((TK_SUMMARY_PROVIDERS as readonly string[]).includes(r.provider)) {
      day.byProvider[r.provider as TkProvider] += cost
      day.tokensByProvider[r.provider as TkProvider] += tokens.total
    }
  }
  return out
}
