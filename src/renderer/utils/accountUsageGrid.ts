// The Account usage page as a grid (nubbymong/aicc_planning#445, the approved
// mockup v1): each card's state and the figures it is sorted by, which band it
// falls in, which account has the most room, the summary's counts, and the
// rule that the order only changes once the readings have settled. Pure: no
// React, no IPC, no store. The page (AccountUsagePanel.tsx) builds an entry
// per card with `usageRowEntry` (a Claude Code profile's reading) or
// `accountViewEntry` (a registry account's provider-neutral view) and draws
// what `arrangeCards` gives back.
import type { AccountUsage, UsageBucket } from '../../shared/usage-types'
import type { ProfileAuthInfo } from '../../shared/account-auth'
import type { AccountView, ProviderAccountUsageView, ProviderId } from '../../shared/providers'
import { isProviderId } from '../../shared/providers/ids'
import { bucketPastReset, isModelBucket } from '../../shared/usage-labels'

// --- Sort and filter, kept per viewer in the saved settings ---

/** What the cards are sorted by: the 5h window left, the week left, or name. */
export type UsageSortKey = '5h' | 'weekly' | 'name'
export const USAGE_SORT_KEYS: readonly UsageSortKey[] = ['5h', 'weekly', 'name']
export const USAGE_SORT_LABEL: Readonly<Record<UsageSortKey, string>> = Object.freeze({
  '5h': '5h left',
  weekly: 'Weekly left',
  name: 'Name',
})
export const DEFAULT_USAGE_SORT: UsageSortKey = '5h'

/** A saved sort, read: anything that is not one of the keys is the default. */
export function resolveUsageSort(value: unknown): UsageSortKey {
  return (USAGE_SORT_KEYS as readonly unknown[]).includes(value) ? (value as UsageSortKey) : DEFAULT_USAGE_SORT
}

/** Which provider's cards show: every one, or one provider's. */
export type UsageProviderFilter = 'all' | ProviderId

/** A saved filter, read against the providers the page shows. A provider the
 *  page does not show now (switched off), or a page that shows one provider
 *  only (it draws no filter then), is All. The saved value itself is left as
 *  it is, so turning the provider back on brings the choice back. */
export function resolveUsageProviderFilter(value: unknown, shown: readonly ProviderId[]): UsageProviderFilter {
  return shown.length > 1 && isProviderId(value) && shown.includes(value) ? value : 'all'
}

/** Whether a filter shows a provider's cards. */
export function filterShows(filter: UsageProviderFilter, providerId: ProviderId): boolean {
  return filter === 'all' || filter === providerId
}

/** The entries a filter keeps, in their order. */
export function filterEntries<T extends { providerId: ProviderId }>(entries: readonly T[], filter: UsageProviderFilter): T[] {
  return entries.filter((e) => filterShows(filter, e.providerId))
}

// --- A card's state ---

export type UsageCardState =
  /** Usable, with a current reading. */
  | 'ready'
  /** Live from its open session. */
  | 'in-use'
  /** Renewing its sign-in by itself; its last reading is shown, dimmed. */
  | 'refreshing'
  /** Usable as far as the page knows, with no figure to show: no session yet,
   *  billed per token, no limits reported, or a read that failed. */
  | 'unread'
  /** No reading yet, and one is on its way (the first load only). */
  | 'pending'
  /** An account-wide window is used up until its reset. */
  | 'out'
  /** Its sign-in has run out: Sign in again. */
  | 'sign-in'
  /** Parked (inactive): never polled. */
  | 'parked'
  /** Its provider is off: nothing of it was read. */
  | 'off'

const USABLE: ReadonlySet<UsageCardState> = new Set<UsageCardState>(['ready', 'in-use', 'refreshing', 'unread', 'pending'])

/** Whether a card in this state can be used now (the Most room and Some room bands). */
export function isUsableState(state: UsageCardState): boolean {
  return USABLE.has(state)
}

/** The order of the states in a sort by room: the usable ones, then out
 *  until a reset, then to sign in, then parked (the mockup's order). */
export function stateRank(state: UsageCardState): number {
  if (isUsableState(state)) return 0
  if (state === 'out') return 1
  if (state === 'sign-in') return 2
  return 3
}

/** The account-wide window of a group (`session` is the 5h window, `weekly`
 *  the week): the first bucket of that group that is not a per-model one.
 *  Buckets are discovered from each reading, never a fixed list. */
export function mainWindow(buckets: readonly UsageBucket[], group: 'session' | 'weekly'): UsageBucket | null {
  return buckets.find((b) => b.group === group && !isModelBucket(b)) ?? null
}

/** The share of a bucket left, 0-100, whole. */
export function percentLeft(bucket: Pick<UsageBucket, 'percent'>): number {
  return Math.round(100 - Math.min(100, Math.max(0, bucket.percent)))
}

/** The share of a group's account-wide window left, or null with no current
 *  figure: no such window, an unreadable figure, or a window past its reset
 *  (D2: it has no current figure). */
export function windowLeft(buckets: readonly UsageBucket[], group: 'session' | 'weekly', now: number): number | null {
  const b = mainWindow(buckets, group)
  if (!b || !Number.isFinite(b.percent) || bucketPastReset(b, now)) return null
  return percentLeft(b)
}

/** The account-wide window that is used up with its reset still ahead, 5h
 *  first: the card is out until it comes back. Null when none is. A per-model
 *  bucket used up leaves the account's other models, so it is not one. */
export function usedUpWindow(buckets: readonly UsageBucket[], now: number): UsageBucket | null {
  for (const group of ['session', 'weekly'] as const) {
    const b = mainWindow(buckets, group)
    if (b && Number.isFinite(b.percent) && b.percent >= 100 && !bucketPastReset(b, now)) return b
  }
  return null
}

/** The short-lived token behind the account's sessions has lapsed while its
 *  long-lived sign-in still holds: the app renews it by itself. From the
 *  stored credentials the page already reads (no network). */
function accessTokenLapsed(auth: ProfileAuthInfo | undefined, now: number): boolean {
  if (!auth || auth.credentialsMissing || auth.hasRefreshToken === false) return false
  if (typeof auth.expiresAt !== 'number' || !Number.isFinite(auth.expiresAt) || auth.expiresAt > now) return false
  const refreshExpiry = auth.refreshTokenExpiresAt
  return !(typeof refreshExpiry === 'number' && Number.isFinite(refreshExpiry) && refreshExpiry > 0 && refreshExpiry <= now)
}

/**
 * A Claude Code profile's card state, from the verdicts the app already has:
 * the profile's active flag, its reading (`status`, `stale`, `inSession`) and
 * its stored credentials. "Sign in again" is the reading's own `needs-login`
 * verdict and nothing else: when that verdict is set is decided in main
 * (usage/account-usage.ts), not here.
 *
 * Refreshing: signed in, but the reading could not be taken fresh because
 * the sign-in is being renewed: the refresh hint (signed in, no usable token),
 * or a kept figure while the short-lived token has lapsed. A kept figure for
 * any other reason (a rate limit, the network) stays an ordinary card that
 * says it could not refresh.
 */
export function usageRowState(
  row: AccountUsage | undefined,
  opts: { active: boolean; auth?: ProfileAuthInfo; now: number; loading: boolean },
): UsageCardState {
  if (!opts.active || row?.status === 'inactive' || row?.active === false) return 'parked'
  if (!row) return opts.loading ? 'pending' : 'unread'
  if (row.status === 'off') return 'off'
  if (row.status === 'needs-login') return 'sign-in'
  if (row.status === 'ok' && usedUpWindow(row.buckets, opts.now)) return 'out'
  if (row.inSession) return 'in-use'
  if (row.status === 'error' && typeof row.detail === 'string' && row.detail.startsWith('signed in')) return 'refreshing'
  if (row.status === 'ok' && row.stale && accessTokenLapsed(opts.auth, opts.now)) return 'refreshing'
  if (row.status === 'ok' && row.buckets.length > 0) return 'ready'
  return 'unread'
}

/** A registry account's card state, from its lifecycle and its usage view. */
export function accountViewState(
  account: Pick<AccountView, 'lifecycle'>,
  view: ProviderAccountUsageView | undefined,
  opts: { now: number; loading: boolean },
): UsageCardState {
  if (account.lifecycle === 'inactive' || view?.status === 'inactive') return 'parked'
  if (!view) return opts.loading ? 'pending' : 'unread'
  if (view.status === 'not-signed-in') return 'sign-in'
  if (view.status !== 'ok') return 'unread'
  if (usedUpWindow(view.buckets, opts.now)) return 'out'
  if (view.source === 'live') return 'in-use'
  return view.buckets.length > 0 ? 'ready' : 'unread'
}

// --- Entries ---

/** One card as the grid places it. */
export interface UsageGridEntry {
  /** Unique across providers: `<provider>:<id>`. */
  key: string
  providerId: ProviderId
  /** The name the card leads with (sorting by name reads it). */
  name: string
  state: UsageCardState
  /** The share of the 5h window left, 0-100; null with no current figure. */
  fiveHourLeft: number | null
  /** The share of the week left; null with no current figure. */
  weeklyLeft: number | null
  /** When an `out` card's window comes back (ISO); null otherwise or unknown. */
  backAt: string | null
}

function entryOf(providerId: ProviderId, id: string, name: string, state: UsageCardState, buckets: readonly UsageBucket[] | null, now: number): UsageGridEntry {
  const used = state === 'out' && buckets ? usedUpWindow(buckets, now) : null
  return {
    key: `${providerId}:${id}`,
    providerId,
    name,
    state,
    fiveHourLeft: buckets ? windowLeft(buckets, 'session', now) : null,
    weeklyLeft: buckets ? windowLeft(buckets, 'weekly', now) : null,
    backAt: used && used.resetsAt ? used.resetsAt : null,
  }
}

/** A Claude Code profile's entry. Its figures are those of an `ok` reading. */
export function usageRowEntry(
  providerId: ProviderId,
  profileId: string,
  name: string,
  row: AccountUsage | undefined,
  opts: { active: boolean; auth?: ProfileAuthInfo; now: number; loading: boolean },
): UsageGridEntry {
  const state = usageRowState(row, opts)
  return entryOf(providerId, profileId, name, state, row && row.status === 'ok' ? row.buckets : null, opts.now)
}

/** A registry account's entry. A signed-out view's last-seen bars count too. */
export function accountViewEntry(
  account: Pick<AccountView, 'id' | 'providerId' | 'lifecycle'>,
  name: string,
  view: ProviderAccountUsageView | undefined,
  opts: { now: number; loading: boolean },
): UsageGridEntry {
  const state = accountViewState(account, view, opts)
  const shown = view && (view.status === 'ok' || view.status === 'not-signed-in') ? view.buckets : null
  return entryOf(account.providerId, account.id, name, state, shown, opts.now)
}

// --- Sorting, bands and the most room ---

/** The window a sort measures room by: the week for Weekly left, else 5h
 *  (a sort by name keeps 5h for the summary, the outline and the bold meter). */
export function roomWindow(sort: UsageSortKey): '5h' | 'weekly' {
  return sort === 'weekly' ? 'weekly' : '5h'
}

function figure(e: UsageGridEntry, room: '5h' | 'weekly'): number | null {
  return room === '5h' ? e.fiveHourLeft : e.weeklyLeft
}

/** More left first; no figure after every figure. */
function byRoom(a: number | null, b: number | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return b - a
}

const NAMES = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/**
 * The entries in a sort's order. By room: the usable first, then out, to sign
 * in and parked; within a rank, the most of the sorted window left, then the
 * most of the other window left. By name: A to Z, ignoring case. Ties keep the
 * order the entries came in (the list's own order), always.
 */
export function sortEntries(entries: readonly UsageGridEntry[], sort: UsageSortKey): UsageGridEntry[] {
  const indexed = entries.map((e, i) => ({ e, i }))
  if (sort === 'name') {
    indexed.sort((x, y) => NAMES.compare(x.e.name, y.e.name) || x.i - y.i)
  } else {
    const room = roomWindow(sort)
    const other = room === '5h' ? 'weekly' : '5h'
    indexed.sort((x, y) =>
      stateRank(x.e.state) - stateRank(y.e.state)
      || byRoom(figure(x.e, room), figure(y.e, room))
      || byRoom(figure(x.e, other), figure(y.e, other))
      || x.i - y.i)
  }
  return indexed.map((x) => x.e)
}

/** At or above this share of the sorted window left, a usable card has the most room. */
export const MOST_ROOM_AT = 50

export type UsageBandId = 'most' | 'some' | 'not' | 'all'

export interface UsageBand {
  id: UsageBandId
  title: string
  /** The line beside the title. */
  note: string
  entries: UsageGridEntry[]
}

/** Which band a card falls in, for a sort by room. */
export function bandOf(e: UsageGridEntry, room: '5h' | 'weekly'): 'most' | 'some' | 'not' {
  if (!isUsableState(e.state)) return 'not'
  const v = figure(e, room)
  return v !== null && v >= MOST_ROOM_AT ? 'most' : 'some'
}

/**
 * Sorted entries in their bands. By room: Most room (50% or more of the
 * window left), Some room (under 50%; a usable card with no figure for the
 * window sits here too, and the note says so), Not usable now. An empty band
 * is left out. By name: one band, A to Z.
 */
export function bandEntries(sorted: readonly UsageGridEntry[], sort: UsageSortKey): UsageBand[] {
  if (sorted.length === 0) return []
  if (sort === 'name') return [{ id: 'all', title: 'All accounts', note: 'A to Z', entries: [...sorted] }]
  const room = roomWindow(sort)
  const word = room === '5h' ? '5h' : 'weekly'
  const groups: Record<'most' | 'some' | 'not', UsageGridEntry[]> = { most: [], some: [], not: [] }
  for (const e of sorted) groups[bandOf(e, room)].push(e)
  const unread = groups.some.some((e) => figure(e, room) === null)
  const bands: UsageBand[] = []
  if (groups.most.length) bands.push({ id: 'most', title: 'Most room', note: `${MOST_ROOM_AT}% or more of ${word} left`, entries: groups.most })
  if (groups.some.length) bands.push({ id: 'some', title: 'Some room', note: `under ${MOST_ROOM_AT}% of ${word} left${unread ? ', or no reading' : ''}`, entries: groups.some })
  if (groups.not.length) bands.push({ id: 'not', title: 'Not usable now', note: 'out until a reset, signed out or parked', entries: groups.not })
  return bands
}

/** The account with the most room for a window: the first, in a sort by it,
 *  that is ready or in use and has a figure for it. A card renewing its
 *  sign-in is not offered: its figure is the last one, not a current one. */
export function mostRoom(entries: readonly UsageGridEntry[], room: '5h' | 'weekly'): UsageGridEntry | null {
  return sortEntries(entries, room).find((e) => (e.state === 'ready' || e.state === 'in-use') && figure(e, room) !== null) ?? null
}

/** The summary line's details after the name: ", 91% of 5h and 64% of the
 *  week left." (the sorted window first). */
export function mostRoomDetail(best: UsageGridEntry, room: '5h' | 'weekly'): string {
  const h = best.fiveHourLeft !== null ? `${best.fiveHourLeft}% of 5h` : null
  const w = best.weeklyLeft !== null ? `${best.weeklyLeft}% of the week` : null
  const parts = (room === '5h' ? [h, w] : [w, h]).filter((p): p is string => p !== null)
  return `, ${parts.join(' and ')} left.`
}

export interface UsageCounts {
  /** Ready or in use. */
  ready: number
  refreshing: number
  out: number
  /** The soonest an `out` card comes back (ISO); null with none known. */
  firstBack: string | null
  signIn: number
  parked: number
}

/** The summary's counts. */
export function countStates(entries: readonly UsageGridEntry[]): UsageCounts {
  const c: UsageCounts = { ready: 0, refreshing: 0, out: 0, firstBack: null, signIn: 0, parked: 0 }
  for (const e of entries) {
    if (e.state === 'ready' || e.state === 'in-use') c.ready++
    else if (e.state === 'refreshing') c.refreshing++
    else if (e.state === 'sign-in') c.signIn++
    else if (e.state === 'parked') c.parked++
    else if (e.state === 'out') {
      c.out++
      const t = e.backAt ? Date.parse(e.backAt) : NaN
      if (Number.isFinite(t) && (c.firstBack === null || t < Date.parse(c.firstBack))) c.firstBack = e.backAt
    }
  }
  return c
}

// --- Settle, then sort ---

export interface UsageArrangement {
  /** The bands in order, each with its cards in order. Empty before the
   *  first settle. */
  bands: UsageBand[]
  /** Cards with no place yet, after the bands in the list's own order: every
   *  card before the first settle, and one that appeared during a load. */
  unplaced: UsageGridEntry[]
  /** The card with the most room; null before the first settle or with none. */
  best: UsageGridEntry | null
}

/**
 * Where each card goes. The cards are placed by `basis`, the entries as they
 * stood when the readings last settled, never by the readings arriving now:
 * while a load runs every card keeps its place (its meters fill in where it
 * is), and the sort is applied once the load has settled and the page passes
 * the settled entries as the new basis. With no basis yet (the first load),
 * every card is drawn at once in the list's own order. A sort or filter
 * chosen during a load applies at once, to the basis's figures. The page
 * filters both lists the same way before it calls this.
 */
export function arrangeCards(live: readonly UsageGridEntry[], basis: readonly UsageGridEntry[] | null, sort: UsageSortKey): UsageArrangement {
  if (!basis) return { bands: [], unplaced: [...live], best: null }
  const liveKeys = new Set(live.map((e) => e.key))
  const placed = basis.filter((e) => liveKeys.has(e.key))
  const placedKeys = new Set(placed.map((e) => e.key))
  return {
    bands: bandEntries(sortEntries(placed, sort), sort),
    unplaced: live.filter((e) => !placedKeys.has(e.key)),
    best: mostRoom(placed, roomWindow(sort)),
  }
}
