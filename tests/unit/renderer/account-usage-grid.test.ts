// nubbymong/aicc_planning#445 (the approved mockup v1): the Account usage
// page's grid rules, pure. Each card's state from the verdicts the app already
// has; the sort by 5h left, weekly left or name (ties keep the list's order);
// the three bands; the account with the most room; the summary's counts; the
// provider filter and the saved choices read back; and settle-then-sort: the
// cards are placed by the entries as they stood when the readings last
// settled, never by readings still arriving.
import { describe, it, expect } from 'vitest'
import {
  resolveUsageSort, resolveUsageProviderFilter, filterEntries, filterShows,
  windowLeft, usedUpWindow, usageRowState, accountViewState, usageRowEntry, accountViewEntry,
  sortEntries, bandEntries, bandOf, mostRoom, mostRoomDetail, countStates, arrangeCards, roomWindow,
  type UsageGridEntry, type UsageCardState,
} from '../../../src/renderer/utils/accountUsageGrid'
import type { AccountUsage, UsageBucket } from '../../../src/shared/usage-types'
import type { ProfileAuthInfo } from '../../../src/shared/account-auth'
import type { ProviderAccountUsageView, ProviderId } from '../../../src/shared/providers'

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0)
const HOUR = 3_600_000
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
const bucket = (key: string, label: string, group: string, percent: number, resetsAt = at(2)): UsageBucket =>
  ({ key, label, group, percent, resetsAt, severity: 'normal' })
const five = (used: number, resetsAt = at(2)) => bucket('session:', '5h', 'session', used, resetsAt)
const week = (used: number, resetsAt = at(48)) => bucket('weekly_all:', 'Weekly', 'weekly', used, resetsAt)
const fable = (used: number) => bucket('weekly:Fable', 'Fable', 'weekly', used, at(48))

const row = (over: Partial<AccountUsage> = {}): AccountUsage => ({
  profileId: 'p1', email: 'a@example.com', name: 'A', isPrimary: false, active: true,
  status: 'ok', buckets: [five(20), week(40)], fetchedAt: NOW - 60_000, ...over,
})
const view = (over: Partial<ProviderAccountUsageView> = {}): ProviderAccountUsageView => ({
  accountId: 'acct-1', providerId: 'codex', status: 'ok', source: 'read', readingAt: NOW - 60_000,
  buckets: [five(20), week(40)], ...over,
})
const rowOpts = (over: { active?: boolean; auth?: ProfileAuthInfo; loading?: boolean } = {}) =>
  ({ active: true, now: NOW, loading: false, ...over })

const e = (name: string, state: UsageCardState, h: number | null, w: number | null, providerId: ProviderId = 'claude', backAt: string | null = null): UsageGridEntry =>
  ({ key: `${providerId}:${name}`, providerId, name, state, fiveHourLeft: h, weeklyLeft: w, backAt })
const names = (list: readonly UsageGridEntry[]) => list.map((x) => x.name)

describe('the saved sort and filter, read back', () => {
  it('a sort is one of its three keys, anything else the 5h default', () => {
    for (const k of ['5h', 'weekly', 'name'] as const) expect(resolveUsageSort(k)).toBe(k)
    for (const bad of [undefined, null, '', 'Weekly', 'h', 5, {}]) expect(resolveUsageSort(bad), String(bad)).toBe('5h')
  })

  it('a filter names a provider the page shows, and only when it shows more than one', () => {
    expect(resolveUsageProviderFilter('codex', ['claude', 'codex'])).toBe('codex')
    expect(resolveUsageProviderFilter('claude', ['claude', 'codex'])).toBe('claude')
    expect(resolveUsageProviderFilter('all', ['claude', 'codex'])).toBe('all')
    // A provider that is off now, or a page with one provider (no filter drawn): All.
    expect(resolveUsageProviderFilter('codex', ['claude'])).toBe('all')
    expect(resolveUsageProviderFilter('claude', ['claude'])).toBe('all')
    for (const bad of [undefined, 'gemini', 7, '']) expect(resolveUsageProviderFilter(bad, ['claude', 'codex'])).toBe('all')
  })

  it('a filter keeps one provider\'s entries in their order; All keeps every one', () => {
    const list = [e('a', 'ready', 50, 50), e('w', 'ready', 50, 50, 'codex'), e('b', 'ready', 50, 50), e('r', 'ready', 50, 50, 'codex')]
    expect(names(filterEntries(list, 'codex'))).toEqual(['w', 'r'])
    expect(names(filterEntries(list, 'claude'))).toEqual(['a', 'b'])
    expect(names(filterEntries(list, 'all'))).toEqual(['a', 'w', 'b', 'r'])
    expect(filterShows('all', 'codex')).toBe(true)
    expect(filterShows('claude', 'codex')).toBe(false)
  })
})

describe('the figures a card is sorted by: what is LEFT of each window', () => {
  it('5h and the week left, from the account-wide windows; a per-model bucket is not one', () => {
    const list = [five(9), fable(70), week(36)]
    expect(windowLeft(list, 'session', NOW)).toBe(91)
    expect(windowLeft(list, 'weekly', NOW)).toBe(64)
  })

  it('no figure for a missing window, or one past its reset (D2); a figure over 100 is 0 left', () => {
    expect(windowLeft([week(10)], 'session', NOW)).toBeNull()
    expect(windowLeft([five(10, at(-1))], 'session', NOW)).toBeNull()
    expect(windowLeft([five(130)], 'session', NOW)).toBe(0)
  })

  it('a used-up 5h or week is out until its reset; a used-up model bucket, or one past its reset, is not', () => {
    expect(usedUpWindow([five(100), week(10)], NOW)?.key).toBe('session:')
    expect(usedUpWindow([five(10), week(100)], NOW)?.key).toBe('weekly_all:')
    expect(usedUpWindow([five(10), week(10), fable(100)], NOW)).toBeNull()
    expect(usedUpWindow([five(100, at(-1))], NOW)).toBeNull()
  })
})

describe('a Claude Code card\'s state, from the verdicts the app already has', () => {
  const auth = (over: Partial<ProfileAuthInfo> = {}): ProfileAuthInfo =>
    ({ profileId: 'p1', hasRefreshToken: true, expiresAt: NOW - HOUR, refreshTokenExpiresAt: NOW + 10 * 24 * HOUR, ...over })

  it('Parked: the profile is inactive, or the reading says so', () => {
    expect(usageRowState(row(), rowOpts({ active: false }))).toBe('parked')
    expect(usageRowState(row({ status: 'inactive' }), rowOpts())).toBe('parked')
    expect(usageRowState(row({ active: false }), rowOpts())).toBe('parked')
    // Parked before any reading: never shown as loading.
    expect(usageRowState(undefined, rowOpts({ active: false, loading: true }))).toBe('parked')
  })

  it('no reading: pending while one is on its way, else unread (a read that failed)', () => {
    expect(usageRowState(undefined, rowOpts({ loading: true }))).toBe('pending')
    expect(usageRowState(undefined, rowOpts())).toBe('unread')
  })

  it('Sign in again is the reading\'s own needs-login verdict, before anything else it says', () => {
    expect(usageRowState(row({ status: 'needs-login', buckets: [] }), rowOpts())).toBe('sign-in')
    expect(usageRowState(row({ status: 'needs-login', inSession: true, buckets: [] }), rowOpts())).toBe('sign-in')
    // An expired countdown alone is not the verdict: the reading decides.
    expect(usageRowState(row(), rowOpts({ auth: auth({ refreshTokenExpiresAt: NOW - HOUR }) }))).toBe('ready')
  })

  it('Out of 5h until a reset, even with an open session', () => {
    expect(usageRowState(row({ buckets: [five(100), week(30)] }), rowOpts())).toBe('out')
    expect(usageRowState(row({ buckets: [five(100), week(30)], inSession: true }), rowOpts())).toBe('out')
  })

  it('In use: live from its open session, with or without a figure yet', () => {
    expect(usageRowState(row({ inSession: true }), rowOpts())).toBe('in-use')
    expect(usageRowState(row({ status: 'waiting', inSession: true, buckets: [] }), rowOpts())).toBe('in-use')
  })

  it('Refreshing: signed in with no usable token, or a kept figure while its short-lived token has lapsed', () => {
    expect(usageRowState(row({ status: 'error', detail: 'signed in — open a session to refresh', buckets: [] }), rowOpts())).toBe('refreshing')
    expect(usageRowState(row({ stale: true }), rowOpts({ auth: auth() }))).toBe('refreshing')
  })

  it('a kept figure for any other reason is an ordinary card, not Refreshing', () => {
    // The access token is still good (a rate limit, the network): couldn't refresh.
    expect(usageRowState(row({ stale: true }), rowOpts({ auth: auth({ expiresAt: NOW + HOUR }) }))).toBe('ready')
    // The long-lived sign-in itself has run out: nothing renews it.
    expect(usageRowState(row({ stale: true }), rowOpts({ auth: auth({ refreshTokenExpiresAt: NOW - HOUR }) }))).toBe('ready')
    expect(usageRowState(row({ stale: true }), rowOpts({ auth: auth({ hasRefreshToken: false }) }))).toBe('ready')
    expect(usageRowState(row({ stale: true }), rowOpts())).toBe('ready')
  })

  it('Ready with figures; unread with none (no limits reported, a failed read), and Off for a provider switched off', () => {
    expect(usageRowState(row(), rowOpts())).toBe('ready')
    expect(usageRowState(row({ buckets: [] }), rowOpts())).toBe('unread')
    expect(usageRowState(row({ status: 'error', detail: 'HTTP 429', buckets: [] }), rowOpts())).toBe('unread')
    expect(usageRowState(row({ status: 'off', buckets: [] }), rowOpts())).toBe('off')
  })

  it('an entry carries the figures of an ok reading only', () => {
    const ok = usageRowEntry('claude', 'p1', 'A', row({ buckets: [five(9), week(36)] }), rowOpts())
    expect(ok).toEqual({ key: 'claude:p1', providerId: 'claude', name: 'A', state: 'ready', fiveHourLeft: 91, weeklyLeft: 64, backAt: null })
    const out = usageRowEntry('claude', 'p1', 'A', row({ buckets: [five(100, at(3)), week(36)] }), rowOpts())
    expect(out.state).toBe('out')
    expect(out.backAt).toBe(at(3))
    expect(usageRowEntry('claude', 'p1', 'A', row({ status: 'needs-login' }), rowOpts()).fiveHourLeft).toBeNull()
  })
})

describe('a registry account\'s card state, from its lifecycle and its view', () => {
  const acct = (lifecycle: 'active' | 'inactive' = 'active') => ({ id: 'acct-1', providerId: 'codex' as ProviderId, lifecycle })
  const o = (loading = false) => ({ now: NOW, loading })

  it('every state', () => {
    expect(accountViewState(acct('inactive'), view(), o())).toBe('parked')
    expect(accountViewState(acct(), view({ status: 'inactive' }), o())).toBe('parked')
    expect(accountViewState(acct(), undefined, o(true))).toBe('pending')
    expect(accountViewState(acct(), undefined, o())).toBe('unread')
    expect(accountViewState(acct(), view({ status: 'not-signed-in', source: 'last-seen' }), o())).toBe('sign-in')
    expect(accountViewState(acct(), view({ buckets: [five(100), week(20)] }), o())).toBe('out')
    expect(accountViewState(acct(), view({ source: 'live' }), o())).toBe('in-use')
    expect(accountViewState(acct(), view({ source: 'last-seen' }), o())).toBe('ready')
    for (const status of ['no-session-yet', 'per-token', 'error', 'off'] as const) {
      expect(accountViewState(acct(), view({ status, buckets: [] }), o()), status).toBe('unread')
    }
  })

  it('an entry: its key names its provider and id', () => {
    const entry = accountViewEntry(acct(), 'Work', view({ buckets: [five(33), week(30)] }), o())
    expect(entry).toMatchObject({ key: 'codex:acct-1', providerId: 'codex', name: 'Work', state: 'ready', fiveHourLeft: 67, weeklyLeft: 70 })
  })
})

describe('the sort', () => {
  it('by 5h left: usable first, then out, to sign in and parked; most 5h left first, then most of the week', () => {
    const list = [
      e('parked', 'parked', null, null),
      e('low', 'ready', 22, 12),
      e('signin', 'sign-in', null, null),
      e('out', 'out', 0, 30),
      e('high', 'ready', 91, 64),
      e('tieLowWeek', 'ready', 67, 10),
      e('tieHighWeek', 'in-use', 67, 70),
      e('refreshing', 'refreshing', 44, 35),
    ]
    expect(names(sortEntries(list, '5h'))).toEqual(['high', 'tieHighWeek', 'tieLowWeek', 'refreshing', 'low', 'out', 'signin', 'parked'])
  })

  it('by weekly left: most of the week first, then most 5h', () => {
    const list = [e('a', 'ready', 91, 64), e('b', 'ready', 48, 80), e('c', 'ready', 90, 64), e('d', 'ready', 10, 64)]
    expect(names(sortEntries(list, 'weekly'))).toEqual(['b', 'a', 'c', 'd'])
  })

  it('by name: A to Z, ignoring case, numbers in order', () => {
    const list = [e('work 10', 'ready', 1, 1), e('Bravo', 'parked', null, null), e('alpha', 'out', 0, 0), e('Work 2', 'ready', 99, 99)]
    expect(names(sortEntries(list, 'name'))).toEqual(['alpha', 'Bravo', 'Work 2', 'work 10'])
  })

  it('a card with no figure goes after every card with one, in its rank', () => {
    const list = [e('none', 'unread', null, null), e('some', 'ready', 5, 5), e('pending', 'pending', null, 80)]
    expect(names(sortEntries(list, '5h'))).toEqual(['some', 'pending', 'none'])
  })

  it('ties keep the list\'s own order, for every key, whichever way round the list comes', () => {
    const tied = [e('x', 'ready', 50, 50), e('y', 'ready', 50, 50), e('z', 'ready', 50, 50)]
    for (const key of ['5h', 'weekly'] as const) {
      expect(names(sortEntries(tied, key)), key).toEqual(['x', 'y', 'z'])
      expect(names(sortEntries([...tied].reverse(), key)), key).toEqual(['z', 'y', 'x'])
    }
    const sameName = [{ ...e('Same', 'ready', 1, 1), key: 'claude:1' }, { ...e('same', 'ready', 9, 9), key: 'claude:2' }]
    expect(sortEntries(sameName, 'name').map((x) => x.key)).toEqual(['claude:1', 'claude:2'])
    expect(sortEntries([...sameName].reverse(), 'name').map((x) => x.key)).toEqual(['claude:2', 'claude:1'])
  })
})

describe('the bands', () => {
  it('Most room at 50% or more of the sorted window left, Some room under it, Not usable for the rest', () => {
    const list = sortEntries([e('fifty', 'ready', 50, 10), e('fortyNine', 'ready', 49, 90), e('out', 'out', 0, 90), e('parked', 'parked', null, null), e('signin', 'sign-in', null, null)], '5h')
    const bands = bandEntries(list, '5h')
    expect(bands.map((b) => [b.id, b.title, names(b.entries)])).toEqual([
      ['most', 'Most room', ['fifty']],
      ['some', 'Some room', ['fortyNine']],
      ['not', 'Not usable now', ['out', 'signin', 'parked']],
    ])
    expect(bands.map((b) => b.note)).toEqual(['50% or more of 5h left', 'under 50% of 5h left', 'out until a reset, signed out or parked'])
  })

  it('by weekly left the bands measure the week', () => {
    const bands = bandEntries(sortEntries([e('a', 'ready', 10, 90), e('b', 'ready', 90, 10)], 'weekly'), 'weekly')
    expect(bands.map((b) => [b.id, names(b.entries)])).toEqual([['most', ['a']], ['some', ['b']]])
    expect(bands[0].note).toBe('50% or more of weekly left')
    expect(bandOf(e('a', 'ready', 10, 90), roomWindow('weekly'))).toBe('most')
  })

  it('a usable card with no figure sits in Some room, and its note says so; an empty band is left out', () => {
    const bands = bandEntries([e('none', 'unread', null, null)], '5h')
    expect(bands).toHaveLength(1)
    expect(bands[0]).toMatchObject({ id: 'some', note: 'under 50% of 5h left, or no reading' })
    expect(bandEntries([], '5h')).toEqual([])
  })

  it('by name: one band, A to Z', () => {
    const bands = bandEntries(sortEntries([e('b', 'parked', null, null), e('a', 'ready', 1, 1)], 'name'), 'name')
    expect(bands.map((b) => [b.id, b.title, b.note, names(b.entries)])).toEqual([['all', 'All accounts', 'A to Z', ['a', 'b']]])
  })
})

describe('the most room, and the summary', () => {
  it('the first ready or in-use card with a figure; a card renewing its sign-in is not offered', () => {
    const list = [e('refreshing', 'refreshing', 99, 99), e('unread', 'unread', null, null), e('live', 'in-use', 76, 41), e('ok', 'ready', 60, 90)]
    expect(mostRoom(list, '5h')?.name).toBe('live')
    expect(mostRoom(list, 'weekly')?.name).toBe('ok')
    expect(mostRoom([e('out', 'out', 0, 99), e('parked', 'parked', null, null)], '5h')).toBeNull()
  })

  it('the summary names the sorted window first, and leaves out a window with no figure', () => {
    expect(mostRoomDetail(e('A', 'ready', 91, 64), '5h')).toBe(', 91% of 5h and 64% of the week left.')
    expect(mostRoomDetail(e('A', 'ready', 91, 64), 'weekly')).toBe(', 64% of the week and 91% of 5h left.')
    expect(mostRoomDetail(e('A', 'ready', 91, null), '5h')).toBe(', 91% of 5h left.')
  })

  it('the counts: ready (with in use), refreshing, out with the soonest back, to sign in, parked', () => {
    const c = countStates([
      e('a', 'ready', 1, 1), e('b', 'in-use', 1, 1), e('c', 'refreshing', 1, 1),
      e('d', 'out', 0, 1, 'claude', at(5)), e('f', 'out', 0, 1, 'claude', at(2)), e('g', 'sign-in', null, null),
      e('h', 'parked', null, null), e('i', 'unread', null, null),
    ])
    expect(c).toEqual({ ready: 2, refreshing: 1, out: 2, firstBack: at(2), signIn: 1, parked: 1 })
  })
})

describe('settle, then sort', () => {
  const basis = [e('a', 'ready', 20, 20), e('b', 'ready', 50, 50), e('c', 'ready', 90, 90)]

  it('before the first settle, every card is drawn at once in the list\'s own order, in no band', () => {
    const live = [e('a', 'pending', null, null), e('b', 'ready', 50, 50), e('c', 'ready', 90, 90)]
    const r = arrangeCards(live, null, '5h')
    expect(r.bands).toEqual([])
    expect(names(r.unplaced)).toEqual(['a', 'b', 'c'])
    expect(r.best).toBeNull()
  })

  it('once settled, the cards are sorted and banded by the settled figures', () => {
    const r = arrangeCards(basis, basis, '5h')
    expect(r.bands.map((b) => [b.id, names(b.entries)])).toEqual([['most', ['c', 'b']], ['some', ['a']]])
    expect(r.unplaced).toEqual([])
    expect(r.best?.name).toBe('c')
  })

  it('while a load runs, a reading that would reorder the cards moves nothing', () => {
    // a now has the most room, c the least, but the load has not settled.
    const live = [e('a', 'ready', 100, 100), e('b', 'ready', 50, 50), e('c', 'out', 0, 90)]
    const r = arrangeCards(live, basis, '5h')
    expect(r.bands.map((b) => [b.id, names(b.entries)])).toEqual([['most', ['c', 'b']], ['some', ['a']]])
    expect(r.best?.name).toBe('c')
    // Settled with those readings: now they move.
    const settled = arrangeCards(live, live, '5h')
    expect(settled.bands.map((b) => [b.id, names(b.entries)])).toEqual([['most', ['a', 'b']], ['not', ['c']]])
  })

  it('a card that appears during a load waits after the bands; one that went is dropped', () => {
    const live = [e('b', 'ready', 50, 50), e('c', 'ready', 90, 90), e('new', 'pending', null, null)]
    const r = arrangeCards(live, basis, '5h')
    expect(r.bands.flatMap((b) => names(b.entries))).toEqual(['c', 'b'])
    expect(names(r.unplaced)).toEqual(['new'])
  })

  it('a sort chosen during a load applies at once, to the settled figures', () => {
    const settledBasis = [e('a', 'ready', 90, 10), e('b', 'ready', 10, 90)]
    const live = [e('a', 'ready', 0, 0), e('b', 'ready', 0, 0)]
    expect(arrangeCards(live, settledBasis, '5h').bands.flatMap((b) => names(b.entries))).toEqual(['a', 'b'])
    expect(arrangeCards(live, settledBasis, 'weekly').bands.flatMap((b) => names(b.entries))).toEqual(['b', 'a'])
    expect(arrangeCards(live, settledBasis, 'weekly').best?.name).toBe('b')
  })
})
