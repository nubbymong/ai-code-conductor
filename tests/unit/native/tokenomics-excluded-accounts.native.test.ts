/**
 * 2.1.3-beta.4: the accounts Settings leaves out of the Tokenomics figures,
 * and the progress reset behind the page's Rescan, on the real database.
 *
 * Leaving an account out is a filter on what a query answers: the totals,
 * the charts, the sessions list, one session's detail and the list of
 * accounts. The rows stay stored, so an account put back is whole. Usage
 * recorded to no account is never left out. A session resumed under another
 * account has turns of both: the list and its detail go by its turns, as the
 * totals do, so they agree.
 *
 * Rescan puts every file's stored progress back to its start and deletes
 * nothing.
 */
import { describe, it, expect } from 'vitest'
import { openTkDb } from '../../../src/main/tokenomics/tk-db'

const PRICING = { 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }
const A = 'claude:acct-a'
const B = 'claude:acct-b'
const C = 'claude:acct-c'
const TS =Date.parse('2026-06-01T10:00:00Z')

/** One turn costing 5 dollars (a million input tokens). */
function turn(n: number, sessionId: string, accountKey: string | undefined, configId: string): Record<string, unknown> {
  return {
    dedupKey: `c:m${n}:r${n}`, sessionId, provider: 'claude', model: 'claude-opus-4-8', priceModel: 'claude-opus-4-8',
    ts: TS + n * 60_000, cwd: 'F:\\proj', inTok: 1_000_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, configId,
    ...(accountKey === undefined ? {} : { accountKey }),
  }
}
/** Account A: one turn. Account B: two turns in one session. No account: one turn. */
function seeded() {
  const db = openTkDb(':memory:')
  db.upsertConfigs([{ configId: 'app', label: 'App', workingDirectory: 'F:\\proj' }, { configId: 'site', label: 'Site', workingDirectory: 'F:\\site' }])
  db.insertEvents([
    turn(1, 'sess-a', A, 'app'),
    turn(2, 'sess-b', B, 'site'),
    turn(3, 'sess-b', B, 'site'),
    turn(4, 'sess-none', undefined, 'app'),
  ] as never)
  return db
}
const sum = (rows: Array<{ costUsd: number | null }>): number => rows.reduce((a, r) => a + (r.costUsd ?? 0), 0)
const tokens = (rows: Array<{ tokens: number }>): number => rows.reduce((a, r) => a + r.tokens, 0)

describe('accounts left out of the Tokenomics figures (2.1.3-beta.4)', () => {
  it('with none left out, every figure holds all four turns', () => {
    const db = seeded()
    const s = db.querySummary(PRICING, {})
    expect(s.kpis.lifeToDateCostUsd).toBeCloseTo(20, 5)
    expect(db.querySessions(PRICING, {}).rows.map((r) => r.sessionId).sort()).toEqual(['sess-a', 'sess-b', 'sess-none'])
    expect(db.queryAccounts().map((a) => a.accountKey)).toEqual(['', A, B])
    db.close()
  })

  it('an account left out is gone from the totals, the charts and the breakdowns', () => {
    const db = seeded()
    const s = db.querySummary(PRICING, { excludeAccountKeys: [B] })
    expect(s.kpis.lifeToDateCostUsd).toBeCloseTo(10, 5)
    expect(s.kpisByProvider.claude.lifeToDateCostUsd).toBeCloseTo(10, 5)
    expect(sum(s.dailySeries)).toBeCloseTo(10, 5)
    expect(sum(s.modelSplit)).toBeCloseTo(10, 5)
    expect(tokens(s.modelSplit)).toBe(2_000_000)
    expect(s.cacheSplit.inputUsd).toBeCloseTo(10, 5)
    expect(tokens(s.heatmap)).toBe(2_000_000)
    // The config only that account used has no cost left and no session.
    expect(s.costByConfig).toEqual([{ configId: 'app', label: 'App', costUsd: 10, sessions: 2 }])
    db.close()
  })

  it('it is gone from the sessions list, its session has no detail, and it is not a choice in the Account filter', () => {
    const db = seeded()
    expect(db.querySessions(PRICING, { excludeAccountKeys: [B] }).rows.map((r) => r.sessionId).sort()).toEqual(['sess-a', 'sess-none'])
    expect(db.querySessionDetail(PRICING, 'sess-b', [B])).toBeNull()
    expect(db.querySessionDetail(PRICING, 'sess-a', [B])?.sessionId).toBe('sess-a')
    expect(db.querySessionDetail(PRICING, 'sess-none', [A, B])?.sessionId).toBe('sess-none')
    expect(db.queryAccounts([B]).map((a) => a.accountKey)).toEqual(['', A])
    db.close()
  })

  it('several can be left out; usage recorded to no account never is', () => {
    const db = seeded()
    const both = db.querySummary(PRICING, { excludeAccountKeys: [A, B] })
    expect(both.kpis.lifeToDateCostUsd).toBeCloseTo(5, 5)
    expect(db.querySessions(PRICING, { excludeAccountKeys: [A, B] }).rows.map((r) => r.sessionId)).toEqual(['sess-none'])
    expect(db.queryAccounts([A, B]).map((a) => a.accountKey)).toEqual([''])
    // "Not recorded" is not an account: naming it leaves nothing out.
    expect(db.querySummary(PRICING, { excludeAccountKeys: [''] }).kpis.lifeToDateCostUsd).toBeCloseTo(20, 5)
    expect(db.queryAccounts(['']).map((a) => a.accountKey)).toEqual(['', A, B])
    db.close()
  })

  it('it combines with the page\'s own filters', () => {
    const db = seeded()
    // The account chosen in the filter is the one left out: nothing.
    expect(db.querySummary(PRICING, { accountKey: B, excludeAccountKeys: [B] }).kpis.lifeToDateCostUsd).toBe(0)
    expect(db.querySessions(PRICING, { accountKey: B, excludeAccountKeys: [B] }).rows).toEqual([])
    // Another account chosen: its own figures, untouched.
    expect(db.querySummary(PRICING, { accountKey: A, excludeAccountKeys: [B] }).kpis.lifeToDateCostUsd).toBeCloseTo(5, 5)
    // A config and a range with an account left out.
    expect(db.querySummary(PRICING, { configId: 'app', from: TS - 86_400_000, excludeAccountKeys: [A] }).kpis.lifeToDateCostUsd).toBeCloseTo(5, 5)
    db.close()
  })

  it('a list that is not well formed leaves nothing out, and no value in it reaches the query as text', () => {
    const db = seeded()
    const bad: unknown[] = ['claude:acct-b', { 0: B }, ['bogus'], ["claude:x' OR 1=1 --"], [5, null, undefined], [`${B} `], ['claude:']]
    for (const list of bad) {
      expect(db.querySummary(PRICING, { excludeAccountKeys: list as never }).kpis.lifeToDateCostUsd, JSON.stringify(list)).toBeCloseTo(20, 5)
      expect(db.querySessions(PRICING, { excludeAccountKeys: list as never }).rows, JSON.stringify(list)).toHaveLength(3)
    }
    db.close()
  })

  it('nothing is removed: an account put back is whole', () => {
    const db = seeded()
    expect(db.querySummary(PRICING, { excludeAccountKeys: [A, B] }).kpis.lifeToDateCostUsd).toBeCloseTo(5, 5)
    expect(db.eventCount()).toBe(4)
    expect(db.querySummary(PRICING, {}).kpis.lifeToDateCostUsd).toBeCloseTo(20, 5)
    expect(db.querySessionDetail(PRICING, 'sess-b')?.msgCount).toBe(2)
    db.close()
  })
})

// A Claude session takes its account from the one it is attributed to when
// its turns are stored, and a session resumed under another account is
// attributed to that one from then on. Its session row keeps its first
// account. The totals go by each turn's account, and so do the list, the
// detail and the session counts, and the Account filter goes by the account
// the row is shown under.
describe('a session resumed under another account, with an account left out (2.1.3-beta.4)', () => {
  const MOVED = 'sess-moved'
  /** One session with two turns under account A and then three under
   *  account B; beside it, a session of A alone and one of B alone. */
  function moved() {
    const db = openTkDb(':memory:')
    db.upsertConfigs([{ configId: 'app', label: 'App', workingDirectory: 'F:\\proj' }])
    db.setSessionAccount(MOVED, A, TS)
    db.insertEvents([turn(11, MOVED, undefined, 'app'), turn(12, MOVED, undefined, 'app')] as never)
    db.setSessionAccount(MOVED, B, TS + 1)
    db.insertEvents([turn(13, MOVED, undefined, 'app'), turn(14, MOVED, undefined, 'app'), turn(15, MOVED, undefined, 'app')] as never)
    db.insertEvents([turn(16, 'sess-only-a', A, 'app'), turn(17, 'sess-only-b', B, 'app')] as never)
    return db
  }
  type Row = { sessionId: string; costUsd: number | null; msgCount: number; inTok: number; accountKey: string }
  const listed = (rows: Row[]): Array<[string, number | null, number, number, string]> =>
    rows.map((r): [string, number | null, number, number, string] => [r.sessionId, r.costUsd, r.msgCount, r.inTok, r.accountKey]).sort((a, b) => a[0].localeCompare(b[0]))

  it('with none left out it is one session under its first account, with all five turns', () => {
    const db = moved()
    expect(db.querySummary(PRICING, {}).kpis.lifeToDateCostUsd).toBeCloseTo(35, 5)
    expect(listed(db.querySessions(PRICING, {}).rows as Row[])).toEqual([
      [MOVED, 25, 5, 5_000_000, A],
      ['sess-only-a', 5, 1, 1_000_000, A],
      ['sess-only-b', 5, 1, 1_000_000, B],
    ])
    expect(db.querySessionDetail(PRICING, MOVED)).toMatchObject({ costUsd: 25, msgCount: 5, accountKey: A })
    db.close()
  })

  it('its first account left out: it stays in the list with the turns of the other account, under that account, and the list adds up to the totals', () => {
    const db = moved()
    const s = db.querySummary(PRICING, { excludeAccountKeys: [A] })
    expect(s.kpis.lifeToDateCostUsd).toBeCloseTo(20, 5)
    const rows = db.querySessions(PRICING, { excludeAccountKeys: [A] }).rows as Row[]
    expect(listed(rows)).toEqual([
      [MOVED, 15, 3, 3_000_000, B],
      ['sess-only-b', 5, 1, 1_000_000, B],
    ])
    expect(sum(rows)).toBeCloseTo(s.kpis.lifeToDateCostUsd, 5)
    // Counted as a session of its config, as it is listed.
    expect(s.costByConfig).toEqual([{ configId: 'app', label: 'App', costUsd: 20, sessions: 2 }])
    const detail = db.querySessionDetail(PRICING, MOVED, [A])
    expect(detail).toMatchObject({ sessionId: MOVED, costUsd: 15, msgCount: 3, inTok: 3_000_000, unpricedTokens: 0, accountKey: B })
    expect(detail!.byModel).toEqual([{ model: 'claude-opus-4-8', costUsd: 15, inTok: 3_000_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, msgCount: 3 }])
    db.close()
  })

  it('the account it moved to left out: it stays under its first account with that account\'s turns only', () => {
    const db = moved()
    const s = db.querySummary(PRICING, { excludeAccountKeys: [B] })
    expect(s.kpis.lifeToDateCostUsd).toBeCloseTo(15, 5)
    const rows = db.querySessions(PRICING, { excludeAccountKeys: [B] }).rows as Row[]
    expect(listed(rows)).toEqual([
      [MOVED, 10, 2, 2_000_000, A],
      ['sess-only-a', 5, 1, 1_000_000, A],
    ])
    expect(sum(rows)).toBeCloseTo(s.kpis.lifeToDateCostUsd, 5)
    expect(s.costByConfig).toEqual([{ configId: 'app', label: 'App', costUsd: 15, sessions: 2 }])
    expect(db.querySessionDetail(PRICING, MOVED, [B])).toMatchObject({ costUsd: 10, msgCount: 2, inTok: 2_000_000, accountKey: A })
    db.close()
  })

  it('both left out: it is gone from the list, the counts and the totals, and has no detail', () => {
    const db = moved()
    const s = db.querySummary(PRICING, { excludeAccountKeys: [A, B] })
    expect(s.kpis.lifeToDateCostUsd).toBe(0)
    expect(s.costByConfig).toEqual([])
    expect(db.querySessions(PRICING, { excludeAccountKeys: [A, B] }).rows).toEqual([])
    expect(db.querySessionDetail(PRICING, MOVED, [A, B])).toBeNull()
    // Nothing was removed.
    expect(db.eventCount()).toBe(7)
    expect(db.querySessionDetail(PRICING, MOVED)?.msgCount).toBe(5)
    db.close()
  })

  // A session shows under its own account while that is kept, not under the
  // account of its latest turn: with both of its accounts kept and some
  // other account left out, it reads exactly as it does with none left out.
  it('both of its accounts kept and an unrelated account left out: the same row as with none left out, under its first account', () => {
    const db = moved()
    db.insertEvents([turn(18, 'sess-only-c', C, 'app')] as never)
    const before = listed(db.querySessions(PRICING, {}).rows as Row[])
    expect(before).toEqual([
      [MOVED, 25, 5, 5_000_000, A],
      ['sess-only-a', 5, 1, 1_000_000, A],
      ['sess-only-b', 5, 1, 1_000_000, B],
      ['sess-only-c', 5, 1, 1_000_000, C],
    ])
    const rows = db.querySessions(PRICING, { excludeAccountKeys: [C] }).rows as Row[]
    // Only the unrelated account's session is gone; the moved one is untouched.
    expect(listed(rows)).toEqual(before.filter((r) => r[0] !== 'sess-only-c'))
    expect(listed(rows)[0]).toEqual([MOVED, 25, 5, 5_000_000, A])
    expect(db.querySessionDetail(PRICING, MOVED, [C])).toMatchObject({ costUsd: 25, msgCount: 5, inTok: 5_000_000, accountKey: A })
    expect(db.querySummary(PRICING, { excludeAccountKeys: [C] }).kpis.lifeToDateCostUsd).toBeCloseTo(35, 5)
    expect(sum(rows)).toBeCloseTo(35, 5)
    db.close()
  })

  // The Account filter and the session counts go by the account a row shows
  // under: its own while that is kept, else the account of its latest kept
  // turn. A session row keeps its first account, so a filter on that column
  // alone left the moved session out of the list and the counts of the
  // account it is shown under, while its turns stayed in that account's
  // totals, and kept it listed under an account that is left out.
  it('its first account left out and the other chosen in the Account filter: it is listed and counted under that account, and the counts agree with the list', () => {
    const db = moved()
    const s = db.querySummary(PRICING, { accountKey: B, excludeAccountKeys: [A] })
    expect(s.kpis.lifeToDateCostUsd).toBeCloseTo(20, 5)
    const rows = db.querySessions(PRICING, { accountKey: B, excludeAccountKeys: [A] }).rows as Row[]
    expect(listed(rows)).toEqual([
      [MOVED, 15, 3, 3_000_000, B],
      ['sess-only-b', 5, 1, 1_000_000, B],
    ])
    expect(sum(rows)).toBeCloseTo(s.kpis.lifeToDateCostUsd, 5)
    expect(s.costByConfig).toEqual([{ configId: 'app', label: 'App', costUsd: 20, sessions: 2 }])
    expect(s.costByConfig.reduce((n, c) => n + c.sessions, 0)).toBe(rows.length)
    db.close()
  })

  it('its first account left out and chosen in the Account filter: nothing is listed or counted', () => {
    const db = moved()
    const s = db.querySummary(PRICING, { accountKey: A, excludeAccountKeys: [A] })
    expect(s.kpis.lifeToDateCostUsd).toBe(0)
    expect(s.costByConfig).toEqual([])
    expect(db.querySessions(PRICING, { accountKey: A, excludeAccountKeys: [A] }).rows).toEqual([])
    db.close()
  })

  it('the account it moved to left out and its first chosen: it is listed and counted under its first account, as before', () => {
    const db = moved()
    const s = db.querySummary(PRICING, { accountKey: A, excludeAccountKeys: [B] })
    expect(s.kpis.lifeToDateCostUsd).toBeCloseTo(15, 5)
    const rows = db.querySessions(PRICING, { accountKey: A, excludeAccountKeys: [B] }).rows as Row[]
    expect(listed(rows)).toEqual([
      [MOVED, 10, 2, 2_000_000, A],
      ['sess-only-a', 5, 1, 1_000_000, A],
    ])
    expect(s.costByConfig).toEqual([{ configId: 'app', label: 'App', costUsd: 15, sessions: 2 }])
    expect(db.querySessions(PRICING, { accountKey: B, excludeAccountKeys: [B] }).rows).toEqual([])
    db.close()
  })

  it('chosen in the Account filter, the moved session is picked before the page is cut: a page of one, then the next, with no gap', () => {
    const db = moved()
    // Newest first: the session of B alone (minute 17), then the moved one (minute 15).
    const p1 = db.querySessions(PRICING, { accountKey: B, excludeAccountKeys: [A], limit: 1 })
    expect(p1.rows.map((r) => r.sessionId)).toEqual(['sess-only-b'])
    expect(p1.nextCursor).toEqual({ lastTs: p1.rows[0].lastTs, sessionId: 'sess-only-b' })
    const p2 = db.querySessions(PRICING, { accountKey: B, excludeAccountKeys: [A], limit: 1, cursor: p1.nextCursor! })
    expect(p2.rows.map((r) => [r.sessionId, r.accountKey])).toEqual([[MOVED, B]])
    expect(p2.nextCursor).toBeNull()
    db.close()
  })

  it('attributed to its second account before any turn of that account is stored: its first account left out, it is not listed with nothing in it', () => {
    const db = openTkDb(':memory:')
    db.setSessionAccount(MOVED, A, TS)
    db.insertEvents([turn(11, MOVED, undefined, 'app')] as never)
    db.setSessionAccount(MOVED, B, TS + 1)
    expect(db.querySessions(PRICING, { excludeAccountKeys: [A] }).rows).toEqual([])
    expect(db.querySessionDetail(PRICING, MOVED, [A])).toBeNull()
    expect(db.querySummary(PRICING, { excludeAccountKeys: [A] }).kpis.lifeToDateCostUsd).toBe(0)
    db.close()
  })

  // What the index keeps of a session is its first and its latest account,
  // not each change. One that went to another account and came back is
  // read turn by turn for its detail; the list treats it as its first
  // account's as a whole (tk-db leftOutAccounts says so).
  it('a session that went to another account and came back: its detail goes by its turns', () => {
    const db = openTkDb(':memory:')
    db.setSessionAccount(MOVED, A, TS)
    db.insertEvents([turn(11, MOVED, undefined, 'app')] as never)
    db.setSessionAccount(MOVED, B, TS + 1)
    db.insertEvents([turn(12, MOVED, undefined, 'app')] as never)
    db.setSessionAccount(MOVED, A, TS + 2)
    db.insertEvents([turn(13, MOVED, undefined, 'app')] as never)
    expect(db.querySessionDetail(PRICING, MOVED, [B])).toMatchObject({ costUsd: 10, msgCount: 2, accountKey: A })
    expect(db.querySessionDetail(PRICING, MOVED, [A])).toMatchObject({ costUsd: 5, msgCount: 1, accountKey: B })
    expect(db.querySummary(PRICING, { excludeAccountKeys: [B] }).kpis.lifeToDateCostUsd).toBeCloseTo(10, 5)
    db.close()
  })

  // The same session with its first account left out: the list and the
  // counts treat it as A's as a whole (tk-db leftOutAccounts says so), so it
  // is neither listed nor counted, while the totals go by each turn and keep
  // the turn it spent under B. The list is short by that turn, and this
  // pins it so a change to it is a choice, not an accident.
  it('a session that went to another account and came back, its first account left out: not listed or counted, its other-account turn stays in the totals', () => {
    const db = openTkDb(':memory:')
    db.upsertConfigs([{ configId: 'app', label: 'App', workingDirectory: 'F:\\proj' }])
    db.setSessionAccount(MOVED, A, TS)
    db.insertEvents([turn(11, MOVED, undefined, 'app')] as never)
    db.setSessionAccount(MOVED, B, TS + 1)
    db.insertEvents([turn(12, MOVED, undefined, 'app')] as never)
    db.setSessionAccount(MOVED, A, TS + 2)
    db.insertEvents([turn(13, MOVED, undefined, 'app')] as never)
    db.insertEvents([turn(14, 'sess-only-b', B, 'app')] as never)
    const s = db.querySummary(PRICING, { excludeAccountKeys: [A] })
    // Two turns of B: one of the moved session and one of the session beside it.
    expect(s.kpis.lifeToDateCostUsd).toBeCloseTo(10, 5)
    const rows = db.querySessions(PRICING, { excludeAccountKeys: [A] }).rows as Row[]
    expect(rows.map((r) => r.sessionId)).toEqual(['sess-only-b'])
    expect(sum(rows)).toBeCloseTo(5, 5)
    expect(s.costByConfig).toEqual([{ configId: 'app', label: 'App', costUsd: 10, sessions: 1 }])
    // Its detail still goes by its turns: the one it spent under B.
    expect(db.querySessionDetail(PRICING, MOVED, [A])).toMatchObject({ costUsd: 5, msgCount: 1, accountKey: B })
    // Nothing is removed: with nothing left out it is one session of three turns.
    expect(db.querySessions(PRICING, {}).rows.map((r) => r.sessionId).sort()).toEqual([MOVED, 'sess-only-b'])
    expect(db.querySessionDetail(PRICING, MOVED)).toMatchObject({ costUsd: 15, msgCount: 3, accountKey: A })
    db.close()
  })

  // A moved session shown with its kept turns only keeps the session's last
  // time and last model, even when its last turn is one of an account left
  // out: the list is ordered, filtered and paged by them, so the row's place
  // and the cursor after it stay one key (tk-db leftOutAccounts says so).
  describe('its last turn in an account left out', () => {
    const SONNET = 'claude-sonnet-4-6'
    const OPUS = 'claude-opus-4-8'
    const PRICING_2 = { ...PRICING, [SONNET]: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }
    const turnOn = (n: number, sessionId: string, model: string): Record<string, unknown> => ({ ...turn(n, sessionId, undefined, 'app'), model, priceModel: model })
    /** 'sess-late': a Sonnet turn under A at minute 41, then an Opus turn
     *  under B at minute 44. 'sess-mid': one Opus turn under A at minute 43. */
    function late() {
      const db = openTkDb(':memory:')
      db.upsertConfigs([{ configId: 'app', label: 'App', workingDirectory: 'F:\\proj' }])
      db.setSessionAccount('sess-late', A, TS)
      db.insertEvents([turnOn(41, 'sess-late', SONNET)] as never)
      db.setSessionAccount('sess-late', B, TS + 1)
      db.insertEvents([turnOn(44, 'sess-late', OPUS)] as never)
      db.insertEvents([turn(43, 'sess-mid', A, 'app')] as never)
      return db
    }
    const LATE_TS = TS + 44 * 60_000

    it('with B left out: the figures are of the kept Sonnet turn; its time and model are the session\'s, so its place is unchanged', () => {
      const db = late()
      const rows = db.querySessions(PRICING_2, { excludeAccountKeys: [B] }).rows
      expect(rows.map((r) => r.sessionId)).toEqual(['sess-late', 'sess-mid'])
      expect(rows[0]).toMatchObject({ sessionId: 'sess-late', model: OPUS, lastTs: LATE_TS, msgCount: 1, inTok: 1_000_000, accountKey: A })
      expect(rows[0].costUsd).toBeCloseTo(3, 5)
      expect(db.querySessionDetail(PRICING_2, 'sess-late', [B])).toMatchObject({ model: OPUS, lastTs: LATE_TS, msgCount: 1, accountKey: A })
      expect(db.querySessionDetail(PRICING_2, 'sess-late', [B])!.byModel.map((m) => m.model)).toEqual([SONNET])
      db.close()
    })

    it('a page of one: the cursor is the row\'s own key, and the next page continues after it without a repeat', () => {
      const db = late()
      const p1 = db.querySessions(PRICING_2, { excludeAccountKeys: [B], limit: 1 })
      expect(p1.rows.map((r) => r.sessionId)).toEqual(['sess-late'])
      expect(p1.nextCursor).toEqual({ lastTs: p1.rows[0].lastTs, sessionId: 'sess-late' })
      const p2 = db.querySessions(PRICING_2, { excludeAccountKeys: [B], limit: 1, cursor: p1.nextCursor! })
      expect(p2.rows.map((r) => r.sessionId)).toEqual(['sess-mid'])
      expect(p2.nextCursor).toBeNull()
      db.close()
    })
  })
})

// The figures of the last seven days and the seven before, and the models
// with no price, are read with the same condition as the rest.
describe('the seven-day figures and the unpriced models, with an account left out (2.1.3-beta.4)', () => {
  const DAY = 86_400_000
  /** Two days after the recent turns; the older ones are nine days before them. */
  const NOW = TS + 2 * DAY
  const at = (n: number, sessionId: string, accountKey: string, ts: number, model = 'claude-opus-4-8'): Record<string, unknown> => ({
    dedupKey: `c:w${n}:r${n}`, sessionId, provider: 'claude', model, priceModel: model,
    ts, cwd: 'F:\\proj', inTok: model === 'claude-opus-4-8' ? 1_000_000 : 1_000, outTok: 0, cacheReadTok: 0, cacheCreateTok: 0, configId: 'app', accountKey,
  })
  /** Account A: 5 dollars this week and 5 the week before. Account B: 10
   *  and 5, and a thousand tokens of a model with no price this week. */
  function weeks() {
    const db = openTkDb(':memory:')
    db.insertEvents([
      at(1, 'wa', A, TS), at(2, 'wa-old', A, TS - 9 * DAY),
      at(3, 'wb', B, TS), at(4, 'wb', B, TS + 60_000), at(5, 'wb-old', B, TS - 9 * DAY),
      at(6, 'wb', B, TS + 120_000, 'mystery-1'),
    ] as never)
    return db
  }

  it('with none left out', () => {
    const db = weeks()
    const s = db.querySummary(PRICING, {}, NOW)
    expect([s.kpis.lifeToDateCostUsd, s.kpis.last7dCostUsd, s.kpis.prev7dCostUsd]).toEqual([25, 15, 10])
    expect(s.unpriced).toEqual([{ model: 'mystery-1', provider: 'claude', tokens: 1_000 }])
    db.close()
  })

  it('an account left out is gone from this week, from the week before, and from the models with no price', () => {
    const db = weeks()
    const lessB = db.querySummary(PRICING, { excludeAccountKeys: [B] }, NOW)
    expect([lessB.kpis.lifeToDateCostUsd, lessB.kpis.last7dCostUsd, lessB.kpis.prev7dCostUsd]).toEqual([10, 5, 5])
    expect(lessB.kpisByProvider.claude.last7dCostUsd).toBe(5)
    expect(lessB.unpriced).toEqual([])
    const lessA = db.querySummary(PRICING, { excludeAccountKeys: [A] }, NOW)
    expect([lessA.kpis.lifeToDateCostUsd, lessA.kpis.last7dCostUsd, lessA.kpis.prev7dCostUsd]).toEqual([15, 10, 5])
    expect(lessA.unpriced).toEqual([{ model: 'mystery-1', provider: 'claude', tokens: 1_000 }])
    // The session with the unpriced turns keeps them apart from its cost.
    expect(db.querySessionDetail(PRICING, 'wb', [A])).toMatchObject({ costUsd: 10, unpricedTokens: 1_000, msgCount: 3 })
    db.close()
  })
})

describe('the progress reset behind Rescan (2.1.3-beta.4)', () => {
  it('puts every file back to its start, keeps whose file it is, and deletes no row', () => {
    const db = seeded()
    const mark = `100:100:100:${'a'.repeat(32)}`
    db.setFileCursor({ path: 'F:\\t\\one.jsonl', size: 100, mtime: 11, lastOffset: 100, lastIngestedAt: 5, scannedTo: 100, readMark: mark, accountKey: A })
    db.setFileCursor({ path: 'F:\\t\\two.jsonl', size: 300, mtime: 22, lastOffset: 250, lastIngestedAt: 6, scannedTo: 300, readMark: mark })
    expect(db.resetFileProgress()).toBe(2)
    expect(db.getFileCursor('F:\\t\\one.jsonl')).toMatchObject({ size: 100, mtime: 11, lastOffset: 0, scannedTo: 0, readMark: '', accountKey: A })
    expect(db.getFileCursor('F:\\t\\two.jsonl')).toMatchObject({ size: 300, mtime: 22, lastOffset: 0, scannedTo: 0, readMark: '', accountKey: '' })
    expect(db.eventCount()).toBe(4)
    expect(db.querySummary(PRICING, {}).kpis.lifeToDateCostUsd).toBeCloseTo(20, 5)
    // With nothing left to reset, it resets the same rows again and harms nothing.
    expect(db.resetFileProgress()).toBe(2)
    db.close()
  })

  it('a turn read again after the reset is stored once: the totals do not move', () => {
    const db = seeded()
    db.resetFileProgress()
    // What the worker hands the database when it reads the same files again.
    const inserted = db.insertEvents([turn(1, 'sess-a', A, 'app'), turn(2, 'sess-b', B, 'site'), turn(3, 'sess-b', B, 'site'), turn(4, 'sess-none', undefined, 'app')] as never)
    expect(inserted).toBe(0)
    expect(db.eventCount()).toBe(4)
    expect(db.querySummary(PRICING, {}).kpis.lifeToDateCostUsd).toBeCloseTo(20, 5)
    expect(db.querySessionDetail(PRICING, 'sess-b')?.msgCount).toBe(2)
    db.close()
  })
})
