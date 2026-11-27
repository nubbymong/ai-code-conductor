// @vitest-environment jsdom
//
// Plan P3: the account-usage page fills each card as its usage STREAMS in,
// instead of one all-or-nothing "Loading…" gate. nubbymong/aicc_planning#445
// (the approved mockup v1): every card is drawn at once from the account
// list (and the last readings the page saw), its meters animate until its
// fresh reading lands, and the cards are sorted and banded only once every
// reading has settled. These mount the real panel with the streaming IPC
// mocked and assert: cards render before any usage lands, each fills
// independently as its result arrives, a Refresh keeps each card in place
// and re-streams, the sort applies once the readings settle, and the sort
// and the provider filter are kept in the saved settings.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountUsage } from '../../../src/shared/usage-types'
import type { AccountProfile } from '../../../src/shared/account-types'
import type { AccountsSnapshot, AccountView, ProviderAccountUsageView, ProviderUsageStreamResult } from '../../../src/shared/providers'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { reauth } = vi.hoisted(() => ({ reauth: vi.fn() }))
vi.mock('../../../src/renderer/hooks/useReauthAccount', () => ({ useReauthAccount: () => reauth }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark', useThemeController: () => {} }))
vi.mock('../../../src/renderer/components/PageFrame', () => ({
  default: ({ children, actions, context }: { children: React.ReactNode; actions?: React.ReactNode; context?: React.ReactNode }) =>
    <div data-testid="page-frame"><div data-testid="pf-context">{context}</div><div data-testid="pf-actions">{actions}</div>{children}</div>,
}))

const list = vi.fn<() => Promise<AccountProfile[]>>()
const authInfo = vi.fn(async () => [] as unknown[])
/** Every stream call's controller, in order — emit a result, finish, or reject.
 *  Collected (not just the latest) so a superseded stream can be driven too. */
interface StreamCtl { emit: (u: AccountUsage) => void; done: () => void; reject: (e: unknown) => void }
const streams: StreamCtl[] = []
const latest = (): StreamCtl => streams[streams.length - 1]
const fetchAllStream = vi.fn((onResult: (u: AccountUsage) => void) => new Promise<void>((resolve, reject) => {
  streams.push({ emit: (u) => act(() => onResult(u)), done: () => resolve(), reject: (e) => reject(e) })
}))
const fetchOne = vi.fn(async (_id: string): Promise<AccountUsage | null> => null)
/** The provider-neutral usage stream (MP3), driven the same way. */
interface ProviderStreamCtl { emit: (v: ProviderAccountUsageView) => void; done: (r?: ProviderUsageStreamResult) => void; reject: (e: unknown) => void }
const providerStreams: ProviderStreamCtl[] = []
const usageStream = vi.fn((_providerId: string, onResult: (v: ProviderAccountUsageView) => void, _opts?: { read?: boolean }) => new Promise<ProviderUsageStreamResult>((resolve, reject) => {
  providerStreams.push({ emit: (v) => act(() => onResult(v)), done: (r) => resolve(r ?? { ok: true, provider: 'on', accounts: 0 }), reject: (e) => reject(e) })
}))
const usageOne = vi.fn(async (_accountId: string, _opts?: { read?: boolean }): Promise<unknown> => ({ ok: false, code: 'not-found' }))
const usageStreamStop = vi.fn(async (_providerId: string) => ({ ok: true }))
/** The saved settings (the sort and filter are kept there, per viewer). */
const configSave = vi.fn(async (_key: string, _data: unknown) => true)

Object.defineProperty(window, 'electronAPI', {
  writable: true, configurable: true,
  value: {
    accountProfiles: { list, authInfo },
    accountUsage: { fetchAllStream, fetchOne },
    providerAccounts: { usageStream, usageOne, usageStreamStop },
    config: { save: configSave },
  },
})

const { default: AccountUsagePanel, FOCUS_REFRESH_MS, forgetAccountUsagePage, RENEWAL_LINE } = await import('../../../src/renderer/components/AccountUsagePanel')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { choiceSettings } = await import('../../../src/renderer/onboarding/provider-choice')

const profile = (id: string, over: Partial<AccountProfile> = {}): AccountProfile => ({ id, name: id, accountEmail: `${id}@x.com`, createdAt: 0, ...over })
/** A reading: `percent` of the 5h window USED (the card shows what is left). */
const usage = (profileId: string, percent: number, weekly?: number): AccountUsage => ({
  profileId, email: `${profileId}@x.com`, name: profileId, isPrimary: false, active: true,
  status: 'ok',
  buckets: [
    { key: 'session:', label: '5h', group: 'session', percent, resetsAt: '', severity: 'normal' },
    ...(typeof weekly === 'number' ? [{ key: 'weekly_all:', label: 'Weekly', group: 'weekly', percent: weekly, resetsAt: '', severity: 'normal' }] : []),
  ],
  fetchedAt: Date.now(),
})

let container: HTMLDivElement
let root: Root
const all = (testId: string) => container.querySelectorAll(`[data-testid="${testId}"]`)
const one = (testId: string) => container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
const skeletons = () => all('account-usage-skeleton')
const loading = () => all('account-usage-loading')
const cards = () => Array.from(container.querySelectorAll('[data-account-key]')) as HTMLElement[]
/** The cards' keys in the order the page draws them. */
const order = () => cards().map((c) => c.getAttribute('data-account-key'))
const bandIds = () => Array.from(container.querySelectorAll('[data-testid^="account-usage-band-"]')).filter((b) => b.tagName === 'SECTION').map((b) => b.getAttribute('data-testid'))
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }
const refresh = () => click(one('account-usage-refresh'))
/** Picks a card's menu item (the menu is portalled onto document.body). */
async function pickMenu(card: Element, key: string) {
  await click(card.querySelector('[data-testid="account-usage-menu"]'))
  await click(document.body.querySelector(`[data-testid="account-usage-menu-${key}"]`))
}

beforeEach(() => {
  list.mockReset(); authInfo.mockReset(); fetchAllStream.mockClear(); fetchOne.mockReset(); streams.length = 0
  usageStream.mockClear(); usageOne.mockClear(); usageStreamStop.mockClear(); providerStreams.length = 0
  configSave.mockClear(); reauth.mockClear()
  authInfo.mockResolvedValue([]); fetchOne.mockResolvedValue(null)
  forgetAccountUsagePage()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount()); container.remove()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
  useProviderAccountsStore.setState({ snapshot: null, loaded: false })
  vi.useRealTimers()
})

async function mount(props: { onClose?: () => void; onReauthNavigate?: () => void } = {}) {
  await act(async () => { root.render(<AccountUsagePanel onClose={props.onClose ?? (() => {})} onReauthNavigate={props.onReauthNavigate ?? (() => {})} />) })
  await flush()
}

describe('AccountUsagePanel — every card at once, meters animating until each reading lands', () => {
  it('draws a card per account before any usage lands, then fills each in place as it streams in', async () => {
    list.mockResolvedValue([profile('a'), profile('b'), profile('c')])
    await mount()

    // Before any result: every card, named, each with animating meters.
    expect(cards()).toHaveLength(3)
    expect(loading()).toHaveLength(3)
    expect(container.textContent).toContain('a@x.com')
    expect(container.textContent).toContain('c@x.com')
    expect(one('pf-context')?.textContent).toBe('3 accounts')

    // Stream the first account -> its meters fill, the other two keep animating.
    latest().emit(usage('a', 41))
    await flush()
    expect(loading()).toHaveLength(2)
    expect(container.textContent).toContain('59% left')

    // Stream the rest.
    latest().emit(usage('b', 12)); latest().emit(usage('c', 7))
    await flush()
    expect(loading()).toHaveLength(0)
    expect(container.textContent).toContain('88% left')
    expect(container.textContent).toContain('93% left')
    latest().done()
  })

  it('renders placeholder cards while the account list itself is still resolving', async () => {
    let resolveList!: (p: AccountProfile[]) => void
    list.mockReturnValue(new Promise<AccountProfile[]>((r) => { resolveList = r }))
    await act(async () => { root.render(<AccountUsagePanel onClose={() => {}} onReauthNavigate={() => {}} />) })
    // List not resolved yet: placeholders, no "No accounts found".
    expect(skeletons().length).toBeGreaterThan(0)
    expect(container.textContent).not.toMatch(/No accounts found/)
    resolveList([profile('a')])
    await flush()
    expect(skeletons()).toHaveLength(0)
    expect(cards()).toHaveLength(1) // now one per real account
    expect(loading()).toHaveLength(1)
    latest().done()
  })

  it('shows "No accounts found" only once the list resolves empty', async () => {
    list.mockResolvedValue([])
    await mount()
    latest().done(); await flush()
    expect(container.textContent).toMatch(/No accounts found/)
    expect(skeletons()).toHaveLength(0)
  })

  it('a parked account is drawn as parked at once, never as loading', async () => {
    list.mockResolvedValue([profile('a'), profile('p', { active: false })])
    await mount()
    expect(cards().map((c) => c.getAttribute('data-state'))).toEqual(['pending', 'parked'])
    expect(loading()).toHaveLength(1)
    latest().done()
  })

  it('a Refresh keeps each card in place with its last reading dimmed, and re-streams', async () => {
    list.mockResolvedValue([profile('a')])
    await mount()
    latest().emit(usage('a', 20)); latest().done(); await flush()
    expect(container.textContent).toContain('80% left')
    expect(loading()).toHaveLength(0)

    await refresh()
    await flush()
    // The card keeps its last figure, dimmed and animating, until the new one lands.
    expect(fetchAllStream).toHaveBeenCalledTimes(2)
    expect(loading()).toHaveLength(1)
    expect(loading()[0].className).toContain('opacity-50')
    expect(container.textContent).toContain('80% left')
    latest().emit(usage('a', 55)); await flush()
    expect(container.textContent).toContain('45% left')
    expect(loading()).toHaveLength(0)
    latest().done()
  })

  it('ignores a late result from a stream a Refresh superseded (generation guard)', async () => {
    list.mockResolvedValue([profile('a')])
    await mount()
    const old = latest() // stream #1

    // Refresh before #1 delivered anything -> stream #2.
    await refresh()
    await flush()
    expect(streams.length).toBe(2)

    // A late result from the SUPERSEDED stream must not fill the card.
    old.emit(usage('a', 99))
    await flush()
    expect(container.textContent).not.toContain('1% left')
    expect(loading()).toHaveLength(1) // still waiting on stream #2

    // The current stream fills it.
    latest().emit(usage('a', 7)); await flush()
    expect(container.textContent).toContain('93% left')
    latest().done()
  })

  it('a rejected account-list load shows an error, not "No accounts found" or an endless animation', async () => {
    list.mockRejectedValue(new Error('profiles read failed'))
    await mount()
    expect(container.textContent).toMatch(/Couldn.t load account usage/i)
    expect(container.textContent).not.toMatch(/No accounts found/)
    expect(skeletons()).toHaveLength(0)
    expect(loading()).toHaveLength(0)
  })

  it('a stream that fails mid-way turns the unread cards terminal, and "Read usage again" reads that one', async () => {
    list.mockResolvedValue([profile('a'), profile('b')])
    await mount()
    latest().emit(usage('a', 33)) // a resolves
    await flush()
    expect(loading()).toHaveLength(1) // b still streaming

    // The stream itself fails before b arrives.
    latest().reject(new Error('stream died'))
    await flush()
    expect(loading()).toHaveLength(0) // no endless animation
    expect(container.textContent).toContain('67% left') // a kept its reading
    expect(all('account-usage-unavailable')).toHaveLength(1) // b terminal

    // "Read usage again" in b's menu fetches just that account.
    fetchOne.mockResolvedValueOnce(usage('b', 44))
    await pickMenu(cards().find((c) => c.getAttribute('data-account-key') === 'claude:b')!, 'read-again')
    await flush()
    expect(fetchOne).toHaveBeenCalledWith('b')
    expect(container.textContent).toContain('56% left')
  })

  it('the card menu: "Sign in again now" opens the sign-in for that account and goes to the sessions', async () => {
    list.mockResolvedValue([profile('a')])
    const onClose = vi.fn()
    const onReauthNavigate = vi.fn()
    await mount({ onClose, onReauthNavigate })
    latest().emit(usage('a', 20)); latest().done(); await flush()
    await pickMenu(cards()[0], 'sign-in-now')
    expect(reauth).toHaveBeenCalledWith({ id: 'a', name: 'a' }, expect.any(Function))
    expect(onReauthNavigate).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a card\'s "Read usage again" animates that card alone while it reads', async () => {
    list.mockResolvedValue([profile('a'), profile('b')])
    await mount()
    latest().emit(usage('a', 20)); latest().emit(usage('b', 30)); latest().done(); await flush()
    let resolveOne!: (u: AccountUsage) => void
    fetchOne.mockReturnValueOnce(new Promise<AccountUsage>((r) => { resolveOne = r }))
    await pickMenu(cards().find((c) => c.getAttribute('data-account-key') === 'claude:b')!, 'read-again')
    expect(loading()).toHaveLength(1)
    expect(cards().find((c) => c.getAttribute('data-account-key') === 'claude:b')!.getAttribute('aria-busy')).toBe('true')
    await act(async () => { resolveOne(usage('b', 5)) })
    await flush()
    expect(loading()).toHaveLength(0)
    expect(container.textContent).toContain('95% left')
  })

  it('opening the page again draws every card from the last readings at once, in their last places', async () => {
    list.mockResolvedValue([profile('a'), profile('b')])
    await mount()
    latest().emit(usage('a', 80)); latest().emit(usage('b', 10)); latest().done(); await flush()
    expect(order()).toEqual(['claude:b', 'claude:a'])
    act(() => root.unmount())

    // Reopened: the list has not resolved yet, and nothing has streamed.
    let resolveList!: (p: AccountProfile[]) => void
    list.mockReturnValue(new Promise<AccountProfile[]>((r) => { resolveList = r }))
    root = createRoot(container)
    await act(async () => { root.render(<AccountUsagePanel onClose={() => {}} onReauthNavigate={() => {}} />) })
    expect(skeletons()).toHaveLength(0)
    expect(order()).toEqual(['claude:b', 'claude:a'])
    expect(container.textContent).toContain('90% left')
    expect(container.textContent).toContain('20% left')
    // Their meters animate until the fresh readings land.
    resolveList([profile('a'), profile('b')])
    await flush()
    expect(loading()).toHaveLength(2)
    latest().done()
  })
})

describe('settle, then sort (aicc_planning#445)', () => {
  it('nothing reorders while the readings arrive; once they settle the cards sort and band', async () => {
    list.mockResolvedValue([profile('a'), profile('b'), profile('c')])
    await mount()
    // a has the least room, c the most; they land in the list's order.
    latest().emit(usage('a', 80)); latest().emit(usage('b', 50)); latest().emit(usage('c', 10))
    await flush()
    expect(order()).toEqual(['claude:a', 'claude:b', 'claude:c'])
    expect(bandIds()).toEqual([])
    expect(one('account-usage-lead')?.textContent).toBe('Reading each account’s usage…')

    latest().done(); await flush()
    expect(order()).toEqual(['claude:c', 'claude:b', 'claude:a'])
    expect(bandIds()).toEqual(['account-usage-band-most', 'account-usage-band-some'])
    expect(one('account-usage-band-most')?.querySelector('[data-testid="account-usage-band-count"]')?.textContent).toBe('2')
    // The account with the most room: outlined, its pill, and the summary.
    expect(cards()[0].getAttribute('data-best')).toBe('true')
    expect(cards().filter((c) => c.getAttribute('data-best'))).toHaveLength(1)
    expect(one('account-usage-lead')?.textContent).toBe('Most room now: c@x.com, 90% of 5h left.')
    expect(one('account-usage-counts')?.textContent).toBe('3 ready')
  })

  it('a Refresh keeps the order while it reads, then sorts by the new readings once they settle', async () => {
    list.mockResolvedValue([profile('a'), profile('b'), profile('c')])
    await mount()
    latest().emit(usage('a', 80)); latest().emit(usage('b', 50)); latest().emit(usage('c', 10)); latest().done()
    await flush()
    expect(order()).toEqual(['claude:c', 'claude:b', 'claude:a'])

    await refresh(); await flush()
    latest().emit(usage('a', 0)); latest().emit(usage('b', 60)); latest().emit(usage('c', 100))
    await flush()
    // Every reading is in, but the stream has not finished: nothing moves.
    expect(order()).toEqual(['claude:c', 'claude:b', 'claude:a'])
    latest().done(); await flush()
    expect(order()).toEqual(['claude:a', 'claude:b', 'claude:c'])
    expect(bandIds()).toEqual(['account-usage-band-most', 'account-usage-band-some', 'account-usage-band-not'])
    expect(cards()[2].getAttribute('data-state')).toBe('out')
  })

  it('every state lands in its band: Most room, Some room, and Not usable now', async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString()
    list.mockResolvedValue([profile('ok'), profile('low'), profile('out'), profile('gone'), profile('parked', { active: false })])
    await mount()
    latest().emit(usage('ok', 10))
    latest().emit(usage('low', 70))
    latest().emit({ ...usage('out', 100), buckets: [{ key: 'session:', label: '5h', group: 'session', percent: 100, resetsAt: soon, severity: 'normal' }] })
    latest().emit({ ...usage('gone', 0), status: 'needs-login', buckets: [], detail: 'not signed in' })
    latest().emit({ ...usage('parked', 0), status: 'inactive', active: false, buckets: [] })
    latest().done(); await flush()
    const band = (id: string) => Array.from(one(`account-usage-band-${id}`)?.querySelectorAll('[data-account-key]') ?? []).map((c) => c.getAttribute('data-state'))
    expect(band('most')).toEqual(['ready'])
    expect(band('some')).toEqual(['ready'])
    expect(band('not')).toEqual(['out', 'sign-in', 'parked'])
    expect(one('account-usage-counts')?.textContent).toMatch(/^2 ready1 out until .+1 to sign in1 parked$/)
  })
})

describe('the sort and the provider filter, kept per viewer (aicc_planning#445)', () => {
  it('the sort applies at once and is saved; the page opens on the saved sort', async () => {
    list.mockResolvedValue([profile('a'), profile('b')])
    await mount()
    latest().emit(usage('a', 10, 90)); latest().emit(usage('b', 60, 20)); latest().done()
    await flush()
    expect(order()).toEqual(['claude:a', 'claude:b'])
    expect(one('account-usage-sort-5h')?.getAttribute('aria-pressed')).toBe('true')

    await click(one('account-usage-sort-weekly'))
    await flush()
    expect(order()).toEqual(['claude:b', 'claude:a'])
    expect(one('account-usage-sort-weekly')?.getAttribute('aria-pressed')).toBe('true')
    expect(useSettingsStore.getState().settings.accountUsageSort).toBe('weekly')
    expect(configSave).toHaveBeenCalledWith('settings', expect.objectContaining({ accountUsageSort: 'weekly' }))
    // The weekly meter is the bold one now.
    expect(cards()[0].querySelector('[data-bold="true"]')?.textContent).toContain('Weekly')

    await click(one('account-usage-sort-name'))
    await flush()
    expect(order()).toEqual(['claude:a', 'claude:b'])
    expect(bandIds()).toEqual(['account-usage-band-all'])
    expect(configSave).toHaveBeenLastCalledWith('settings', expect.objectContaining({ accountUsageSort: 'name' }))
  })

  it('a saved sort is read back when the page opens', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, accountUsageSort: 'weekly' }, isLoaded: true })
    list.mockResolvedValue([profile('a'), profile('b')])
    await mount()
    latest().emit(usage('a', 10, 90)); latest().emit(usage('b', 60, 20)); latest().done()
    await flush()
    expect(one('account-usage-sort-weekly')?.getAttribute('aria-pressed')).toBe('true')
    expect(order()).toEqual(['claude:b', 'claude:a'])
    expect(configSave).not.toHaveBeenCalled()
  })
})

// Usage track MP3 review (D5): with Claude Code switched off the page reads
// nothing of it: not the credential state (authInfo reads every account's
// credential file), not the usage stream. It shows the one D5 line; turning
// Claude Code back on loads the page as before.
describe('AccountUsagePanel with Claude Code off (D5)', () => {
  it('calls neither authInfo nor the usage stream, and shows only the D5 line', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false }, isLoaded: true })
    list.mockResolvedValue([profile('a')])
    await mount()
    expect(authInfo).not.toHaveBeenCalled()
    expect(fetchAllStream).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Claude Code is off. Turn it on in Settings, Accounts to see its accounts.')
    expect(skeletons()).toHaveLength(0)
    expect(cards()).toHaveLength(0)
    expect(container.textContent).not.toContain('a@x.com')
    expect(container.textContent).not.toMatch(/countdown/i)
    // Refresh while off reads nothing either.
    await refresh()
    await flush()
    expect(authInfo).not.toHaveBeenCalled()
    expect(fetchAllStream).not.toHaveBeenCalled()
  })

  it('a page opened again while Claude Code is off shows nothing of it from the last opening', async () => {
    list.mockResolvedValue([profile('a')])
    await mount()
    latest().emit(usage('a', 10)); latest().done(); await flush()
    act(() => root.unmount())
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false }, isLoaded: true })
    root = createRoot(container)
    await mount()
    expect(cards()).toHaveLength(0)
    expect(container.textContent).not.toContain('a@x.com')
  })

  // Usage track MP4: with Codex not on, nothing of Codex is asked for and
  // there is no provider filter (row 14).
  it('with Codex not on, nothing of Codex is asked for and there is no provider filter', async () => {
    list.mockResolvedValue([profile('a'), profile('b')])
    await mount()
    expect(usageStream).not.toHaveBeenCalled()
    expect(one('account-usage-provider')).toBeNull()
    expect(one('account-usage-sort')).not.toBeNull()
    latest().done()
  })

  it('loads as before once Claude Code is turned back on', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false }, isLoaded: true })
    list.mockResolvedValue([profile('a')])
    await mount()
    await act(async () => { useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: true }, isLoaded: true }) })
    await flush()
    expect(authInfo).toHaveBeenCalled()
    expect(fetchAllStream).toHaveBeenCalled()
    latest().emit(usage('a', 12))
    await flush()
    expect(container.textContent).toContain('88% left')
  })
})

// Usage track MP4, as one grid (aicc_planning#445): both providers' cards
// share the grid; the provider filter replaces the per-provider sections.
const cxAccount = (id: string, over: Partial<AccountView> = {}): AccountView => ({
  id, providerId: 'codex', identityId: `identity-${id}`, lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false,
  authMethod: 'browser', lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted',
  realmLifecycle: 'active', external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0,
  ...over,
})
const snapshotOf = (accounts: AccountView[]): AccountsSnapshot => ({
  revision: 1, registry: { mode: 'ready' } as AccountsSnapshot['registry'],
  providers: [{ providerId: 'claude', displayName: 'Claude Code' }, { providerId: 'codex', displayName: 'Codex' }] as AccountsSnapshot['providers'],
  identities: accounts.map((a) => ({ id: a.identityId, friendlyName: `Name ${a.id}`, colourKey: 'plum' })),
  groups: [], accounts, pendingSetups: [], externalDefaults: [], conflicts: [], reviewerNotices: [],
})
const cxView = (accountId: string, percent: number): ProviderAccountUsageView => ({
  accountId, providerId: 'codex', status: 'ok', source: 'live', readingAt: Date.now(),
  buckets: [{ key: 'codex/300:', label: '5h', group: 'session', percent, resetsAt: '', severity: 'normal' }],
})
const foot = () => one('account-usage-foot')?.textContent ?? ''
const latestCx = (): ProviderStreamCtl => providerStreams[providerStreams.length - 1]
const filterButtons = () => Array.from(one('account-usage-provider')?.querySelectorAll('button') ?? []).map((b) => b.textContent)

describe('AccountUsagePanel with both providers (usage track MP4, as one grid)', () => {
  const modes = (o: { claude: boolean; withCodex: boolean }, accounts: AccountView[], extra: Record<string, unknown> = {}) => {
    // The switches as Settings saves them (an answer, either way).
    const saved = { ...choiceSettings(o.withCodex ? 'both' : 'claude'), claudeEnabled: o.claude }
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...saved, codexAnswered: true, ...extra }, isLoaded: true })
    useProviderAccountsStore.setState({ snapshot: snapshotOf(accounts), loaded: true })
  }

  // Usage track MP8: a closed Codex account may be read afresh while the page
  // streams; the page closing stops that stream in main, and the read with it.
  it('the page closing stops its Codex stream in main (the fresh read under way with it), and only then', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    expect(usageStream).toHaveBeenCalledTimes(1)
    expect(usageStreamStop).not.toHaveBeenCalled()
    act(() => root.unmount())
    expect(usageStreamStop).toHaveBeenCalledTimes(1)
    expect(usageStreamStop).toHaveBeenCalledWith('codex')
    root = createRoot(container)
  })

  it('Claude-only: no filter, the foot says allowances only and how sign-ins renew', async () => {
    modes({ claude: true, withCodex: false }, [cxAccount('x')])
    list.mockResolvedValue([profile('a')])
    await mount()
    expect(one('account-usage-provider')).toBeNull()
    expect(usageStream).not.toHaveBeenCalled()
    expect(foot()).toContain('Allowances only. Token use and estimated cost are in Tokenomics.')
    expect(foot()).toContain(RENEWAL_LINE)
    latest().done()
  })

  it('Codex-only: the D5 line, then the Codex cards; nothing of Claude Code is read', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w'), cxAccount('r')])
    await mount()
    expect(list).not.toHaveBeenCalled()
    expect(authInfo).not.toHaveBeenCalled()
    expect(fetchAllStream).not.toHaveBeenCalled()
    // Opening the page reads afresh (MP8 round 2, ADR-022 bound 7).
    expect(usageStream).toHaveBeenCalledWith('codex', expect.any(Function), { read: true })
    expect(container.textContent).toContain('Claude Code is off. Turn it on in Settings, Accounts to see its accounts.')
    expect(one('account-usage-provider')).toBeNull()
    expect(one('pf-context')?.textContent).toBe('2 accounts')
    // Every card at once, animating until each view streams in.
    expect(order()).toEqual(['codex:w', 'codex:r'])
    expect(loading()).toHaveLength(2)
    latestCx().emit(cxView('w', 18))
    await flush()
    expect(loading()).toHaveLength(1)
    expect(container.textContent).toContain('Name w')
    expect(container.textContent).toContain('82% left')
    latestCx().emit(cxView('r', 6))
    latestCx().done({ ok: true, provider: 'on', accounts: 2 })
    await flush()
    expect(loading()).toHaveLength(0)
    expect(foot()).toContain('Allowances only.')
    expect(foot()).not.toContain(RENEWAL_LINE)
    // The D5 line comes first.
    const text = container.textContent ?? ''
    expect(text.indexOf('Claude Code is off')).toBeLessThan(text.indexOf('Name w'))
  })

  it('both: one grid, Claude Code\'s cards first in the list\'s order, and the filter offers each provider', async () => {
    modes({ claude: true, withCodex: true }, [cxAccount('w')])
    list.mockResolvedValue([profile('a'), profile('b')])
    await mount()
    expect(order()).toEqual(['claude:a', 'claude:b', 'codex:w'])
    expect(filterButtons()).toEqual(['All', 'Claude Code', 'Codex'])
    expect(one('account-usage-provider-all')?.getAttribute('aria-pressed')).toBe('true')
    latest().emit(usage('a', 30)); latest().emit(usage('b', 40)); latest().done()
    latestCx().emit(cxView('w', 18)); latestCx().done()
    await flush()
    expect(container.textContent).toContain('a@x.com')
    expect(container.textContent).toContain('82% left')
    // Settled: sorted across providers by 5h left.
    expect(order()).toEqual(['codex:w', 'claude:a', 'claude:b'])
    expect(cards()[0].querySelector('[data-testid="provider-mark-codex"]')).not.toBeNull()
  })

  it('the filter shows one provider\'s cards, is saved, and is read back when the page opens', async () => {
    modes({ claude: true, withCodex: true }, [cxAccount('w')])
    list.mockResolvedValue([profile('a')])
    await mount()
    latest().emit(usage('a', 30)); latest().done(); latestCx().emit(cxView('w', 18)); latestCx().done()
    await flush()
    await click(one('account-usage-provider-codex'))
    await flush()
    expect(order()).toEqual(['codex:w'])
    expect(one('pf-context')?.textContent).toBe('1 account')
    expect(useSettingsStore.getState().settings.accountUsageProvider).toBe('codex')
    expect(configSave).toHaveBeenCalledWith('settings', expect.objectContaining({ accountUsageProvider: 'codex' }))

    // Opened again: still Codex only.
    act(() => root.unmount())
    root = createRoot(container)
    await mount()
    expect(one('account-usage-provider-codex')?.getAttribute('aria-pressed')).toBe('true')
    expect(order()).toEqual(['codex:w'])

    await click(one('account-usage-provider-all'))
    await flush()
    expect(order()).toEqual(['codex:w', 'claude:a'])
  })

  it('a saved filter for a provider switched off shows every card and no filter, and is kept for when it is back', async () => {
    modes({ claude: true, withCodex: false }, [cxAccount('w')], { accountUsageProvider: 'codex' })
    list.mockResolvedValue([profile('a')])
    await mount()
    expect(one('account-usage-provider')).toBeNull()
    expect(order()).toEqual(['claude:a'])
    expect(useSettingsStore.getState().settings.accountUsageProvider).toBe('codex')
    latest().done()
  })

  it('a Codex stream that fails leaves its cards to read again, and "Read usage again" reads that one account', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    latestCx().reject(new Error('stream died'))
    await flush()
    expect(loading()).toHaveLength(0)
    expect(all('account-usage-unavailable')).toHaveLength(1)
    usageOne.mockResolvedValueOnce({ ok: true, usage: cxView('w', 44) })
    await pickMenu(cards()[0], 'read-again')
    await flush()
    // A card's "Read usage again" reads afresh (MP8 round 2).
    expect(usageOne).toHaveBeenCalledWith('w', { read: true })
    expect(container.textContent).toContain('56% left')
  })

  it('ignores a late Codex view from a stream a Refresh superseded', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    const old = latestCx()
    await refresh()
    await flush()
    expect(providerStreams.length).toBe(2)
    old.emit(cxView('w', 99))
    await flush()
    expect(container.textContent).not.toContain('1% left')
    expect(loading()).toHaveLength(1)
    latestCx().emit(cxView('w', 7)); latestCx().done()
    await flush()
    expect(container.textContent).toContain('93% left')
  })

  it('a Codex that main answers is off has no cards', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    expect(cards()).toHaveLength(1)
    latestCx().done({ ok: true, provider: 'off', accounts: 0 })
    await flush()
    expect(cards()).toHaveLength(0)
    expect(loading()).toHaveLength(0)
  })

  it('a parked Codex account shows as parked at once, never as loading', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('p', { lifecycle: 'inactive' })])
    await mount()
    expect(loading()).toHaveLength(0)
    expect(container.textContent).toMatch(/Parked/)
    latestCx().done()
  })

  // MP4 review F1: each provider loads on its own.
  it('switching Codex on or off re-streams Codex alone; Claude Code is not asked again, nor Codex by Claude Code\'s switch', async () => {
    modes({ claude: true, withCodex: false }, [cxAccount('w')])
    list.mockResolvedValue([profile('a')])
    await mount()
    expect(usageStream).not.toHaveBeenCalled()
    await act(async () => { modes({ claude: true, withCodex: true }, [cxAccount('w')]) })
    await flush()
    expect(usageStream).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(1)
    expect(authInfo).toHaveBeenCalledTimes(1)
    expect(fetchAllStream).toHaveBeenCalledTimes(1)
    await act(async () => { modes({ claude: false, withCodex: true }, [cxAccount('w')]) })
    await flush()
    expect(usageStream).toHaveBeenCalledTimes(1)
    latest().done(); latestCx().done()
  })

  it('Refresh reloads both providers', async () => {
    modes({ claude: true, withCodex: true }, [cxAccount('w')])
    list.mockResolvedValue([profile('a')])
    await mount()
    await refresh()
    await flush()
    expect(fetchAllStream).toHaveBeenCalledTimes(2)
    expect(usageStream).toHaveBeenCalledTimes(2)
    latest().done(); latestCx().done()
  })

  // MP4 review F2: a registry change reads the account it touched.
  it('an account added to the registry after the stream reads that account alone', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    latestCx().emit(cxView('w', 18)); latestCx().done()
    await flush()
    usageOne.mockResolvedValueOnce({ ok: true, usage: cxView('n', 33) })
    // A parked account added too reads nothing.
    await act(async () => { useProviderAccountsStore.setState({ snapshot: snapshotOf([cxAccount('w'), cxAccount('n'), cxAccount('q', { lifecycle: 'inactive' })]), loaded: true }) })
    await flush()
    expect(usageOne.mock.calls.map((c) => c[0])).toEqual(['n'])
    expect(container.textContent).toContain('67% left')
    expect(usageStream).toHaveBeenCalledTimes(1)
  })

  it('a registry change while the stream runs waits for it to end (no second read beside it)', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    usageOne.mockResolvedValueOnce({ ok: true, usage: cxView('n', 33) })
    await act(async () => { useProviderAccountsStore.setState({ snapshot: snapshotOf([cxAccount('w'), cxAccount('n')]), loaded: true }) })
    await flush()
    expect(usageOne).not.toHaveBeenCalled()
    latestCx().emit(cxView('w', 18)); latestCx().done()
    await flush()
    expect(usageOne.mock.calls.map((c) => c[0])).toEqual(['n'])
    expect(container.textContent).toContain('67% left')
  })

  it('an account signed back in reads again', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w', { lastKnownAuthState: 'signed-out' })])
    await mount()
    latestCx().emit({ ...cxView('w', 10), status: 'not-signed-in', source: 'last-seen' }); latestCx().done()
    await flush()
    expect(container.textContent).toContain('Sign in again')
    usageOne.mockResolvedValueOnce({ ok: true, usage: cxView('w', 44) })
    await act(async () => { useProviderAccountsStore.setState({ snapshot: snapshotOf([cxAccount('w', { lastKnownAuthState: 'signed-in' })]), loaded: true }) })
    await flush()
    // A registry change shows what is there; it does not read afresh.
    expect(usageOne).toHaveBeenCalledWith('w', { read: false })
    expect(container.textContent).toContain('56% left')
    expect(container.textContent).not.toContain('Sign in again')
  })

  // MP6 review N1: a focus reloads Codex alone; Claude Code's closed accounts
  // call a rate-limited endpoint and keep their own cadence.
  it('coming back to the window reloads Codex quietly, at most once a minute, and never re-asks Claude Code', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    modes({ claude: true, withCodex: true }, [cxAccount('w')])
    list.mockResolvedValue([profile('a')])
    await mount()
    latest().emit(usage('a', 20)); latest().done()
    latestCx().emit(cxView('w', 18)); latestCx().done()
    await flush()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(usageStream).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + FOCUS_REFRESH_MS + 1)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(usageStream).toHaveBeenCalledTimes(2)
    // The focus reload never reads afresh (MP8 round 2, ADR-022 bound 7).
    expect(usageStream.mock.calls.map((c) => c[2])).toEqual([{ read: true }, { read: false }])
    expect(fetchAllStream).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(1)
    expect(authInfo).toHaveBeenCalledTimes(1)
    // Quiet: the figures stay, and do not animate, while the new stream runs.
    expect(container.textContent).toContain('80% left')
    expect(container.textContent).toContain('82% left')
    expect(loading()).toHaveLength(0)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(usageStream).toHaveBeenCalledTimes(2)
    latestCx().done()
  })

  // MP6 review N2: the registry copy arriving after the stream started is
  // not a change to read every account again for.
  it('a registry copy arriving while the stream runs reads nothing again', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...choiceSettings('codex'), codexAnswered: true }, isLoaded: true })
    useProviderAccountsStore.setState({ snapshot: null, loaded: false })
    await mount()
    expect(usageStream).toHaveBeenCalledTimes(1)
    latestCx().emit(cxView('w', 18)); latestCx().emit(cxView('r', 6))
    await act(async () => { useProviderAccountsStore.setState({ snapshot: snapshotOf([cxAccount('w'), cxAccount('r')]), loaded: true }) })
    latestCx().done()
    await flush()
    expect(usageOne).not.toHaveBeenCalled()
    expect(container.textContent).toContain('82% left')
    expect(container.textContent).toContain('94% left')
  })

  // MP4 review F3: what a terminal card offers names its account.
  it('a card\'s menu says whose it is', async () => {
    modes({ claude: true, withCodex: true }, [cxAccount('w')])
    list.mockResolvedValue([profile('a')])
    await mount()
    latest().reject(new Error('stream died'))
    latestCx().reject(new Error('stream died'))
    await flush()
    expect(Array.from(all('account-usage-unavailable')).map((u) => u.closest('[data-account-key]')?.querySelector('[data-testid="account-usage-name"]')?.textContent)).toEqual(['a@x.com', 'Name w'])
    expect(Array.from(all('account-usage-menu')).map((m) => m.getAttribute('aria-label'))).toEqual(['More actions for a@x.com', 'More actions for Name w'])
  })

  // MP4 review F4.
  it('a failed Claude Code list: the error in its place, Codex still drawn', async () => {
    modes({ claude: true, withCodex: true }, [cxAccount('w')])
    list.mockRejectedValue(new Error('profiles read failed'))
    await mount()
    expect(container.textContent).toMatch(/Couldn.t load account usage/)
    expect(order()).toEqual(['codex:w'])
    latestCx().done()
  })

  // MP4 review F6.
  it('the foot\'s Tokenomics link opens Tokenomics', async () => {
    modes({ claude: true, withCodex: true }, [cxAccount('w')])
    list.mockResolvedValue([profile('a')])
    const onOpenTokenomics = vi.fn()
    await act(async () => { root.render(<AccountUsagePanel onClose={() => {}} onReauthNavigate={() => {}} onOpenTokenomics={onOpenTokenomics} />) })
    await flush()
    const link = Array.from(container.querySelectorAll('[data-testid="account-usage-foot"] button')).find((b) => b.textContent === 'Tokenomics') as HTMLElement
    await click(link)
    expect(onOpenTokenomics).toHaveBeenCalledTimes(1)
    latest().done(); latestCx().done()
  })

  it('a Codex account whose realm cannot be used says its usage could not be loaded', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    latestCx().emit({ accountId: 'w', providerId: 'codex', status: 'error', buckets: [] })
    latestCx().done()
    await flush()
    expect(all('account-usage-unavailable')).toHaveLength(1)
  })

  it('a window that resets while the page is open turns to "no reading since" (D2)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    const soon = new Date(Date.now() + 60_000).toISOString()
    latestCx().emit({ ...cxView('w', 18), buckets: [{ key: 'codex/300:', label: '5h', group: 'session', percent: 18, resetsAt: soon, severity: 'normal' }] })
    latestCx().done()
    await flush()
    expect(container.textContent).toContain('82% left')
    await act(async () => { vi.advanceTimersByTime(61_000) })
    expect(container.textContent).not.toContain('82% left')
    expect(container.textContent).toMatch(/no reading since/)
  })
})

// [host] P4.11 (owner queue, PR 3 gate 6 observation 2, pre-existing): an open
// page's "Updated <age>" ages while the page stays open, on Claude's cards and
// Codex's alike. The age was read once per render, and the page re-rendered
// only on new data or at the next reset, so it kept "Updated just now".
describe('AccountUsagePanel: the age line ages while the page stays open (P4.11)', () => {
  it('[host] a Claude card: "Updated just now", then "Updated 2 min ago" two minutes on, with no new data', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    list.mockResolvedValue([profile('a')])
    await mount()
    latest().emit(usage('a', 41))
    latest().done()
    await flush()
    expect(container.textContent).toContain('Updated just now')
    await act(async () => { vi.advanceTimersByTime(2 * 60_000 + 1_000) })
    expect(container.textContent).toContain('Updated 2 min ago')
    expect(container.textContent).not.toContain('Updated just now')
    expect(fetchAllStream).toHaveBeenCalledTimes(1)
  })

  it('[host] a Codex card: the same', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...choiceSettings('codex'), codexAnswered: true }, isLoaded: true })
    useProviderAccountsStore.setState({ snapshot: snapshotOf([cxAccount('w')]), loaded: true })
    await mount()
    latestCx().emit(cxView('w', 18))
    latestCx().done({ ok: true, provider: 'on', accounts: 1 })
    await flush()
    expect(container.textContent).toContain('Updated just now')
    await act(async () => { vi.advanceTimersByTime(2 * 60_000 + 1_000) })
    expect(container.textContent).toContain('Updated 2 min ago')
    expect(usageStream).toHaveBeenCalledTimes(1)
  })
})
