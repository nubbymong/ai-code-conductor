// @vitest-environment jsdom
/**
 * Settings, Accounts: a steady order, and the All / Active / Inactive filter
 * (aicc_planning#381). Rendered through AccountsSurface from a fixture
 * snapshot and profile list, with window.electronAPI mocked. Menus portal to
 * document.body, so every query here is on the document.
 *
 * Verifies:
 *   - a flip to inactive and back keeps every row's place: in the Claude list
 *     (up to 2.1.3-beta.12 main wrote a changed profile back at the end of
 *     profiles.json; the list hydrated here comes back in that order, and the
 *     rows do not follow it) and in Codex's (the pushed snapshot carries the
 *     new lifecycle);
 *   - the Claude list is in the order the accounts were added, not the file's;
 *   - the control is a labelled group of plain buttons with aria-pressed and
 *     the strong focus ring, first on the page;
 *   - each filter value shows the right rows in every list, and the counts;
 *   - the empty line, and none under All;
 *   - archived accounts are not counted and keep "Archived (N)" under every
 *     filter; unfinished setups show under every filter;
 *   - the filter is kept when the page is left and opened again;
 *   - the pure selectors behind it, and that selectProviderAccounts keeps
 *     active first for the choosers that use it.
 *
 * Not checked: how the control looks (colours, spacing; the aggregate's
 * smoke takes a screenshot), Settings pages other than Accounts, and the
 * other surfaces that list accounts (they keep selectProviderAccounts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot, AccountView, ProviderInstallationView, PendingSetupView } from '../../../src/shared/providers'
import type { AccountProfile } from '../../../src/shared/account-types'
import { useProviderAccountsStore, selectAccountsInAddedOrder, selectProviderAccounts, managedListProviders } from '../../../src/renderer/stores/providerAccountsStore'
import { useAccountProfilesStore, profilesInAddedOrder } from '../../../src/renderer/stores/accountProfilesStore'
import { useAccountsFilterStore, accountsFilterCounts, filterShows, filterEmptyText } from '../../../src/renderer/stores/accountsFilterStore'
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Electron API mock

const ok = () => Promise.resolve({ ok: true })
const pa = {
  snapshot: vi.fn(),
  onChanged: vi.fn(() => () => {}),
  discover: vi.fn(ok),
  installRecipes: vi.fn(),
  setEnabled: vi.fn(ok),
  refreshStatus: vi.fn(ok),
  logout: vi.fn(ok),
  setLifecycle: vi.fn(ok),
  setDefault: vi.fn(ok),
  abandonSetup: vi.fn(ok),
  setReviewerDefault: vi.fn(ok),
}
const profilesApi = {
  list: vi.fn<() => Promise<AccountProfile[]>>(),
  delete: vi.fn().mockResolvedValue({ ok: true }),
  rename: vi.fn().mockResolvedValue({ ok: true }),
  setActive: vi.fn().mockResolvedValue({ ok: true }),
  globalEmail: vi.fn().mockResolvedValue(null),
  create: vi.fn(),
  refreshIdentity: vi.fn().mockResolvedValue(null),
  managedLaunchReports: vi.fn().mockResolvedValue([]),
}

;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  providerAccounts: pa,
  accountProfiles: profilesApi,
  config: { save: vi.fn().mockResolvedValue(undefined) },
  // AccountsPanel renders AccountWebSession per Claude account; not under test.
  accountWeb: {
    status: vi.fn().mockResolvedValue({ ok: false, error: 'not under test' }),
    signIn: vi.fn().mockResolvedValue({ ok: false, error: 'not under test' }),
    signInState: vi.fn().mockResolvedValue({ ok: true, state: { phase: 'idle' } }),
    cancel: vi.fn().mockResolvedValue({ ok: true }),
    signOut: vi.fn().mockResolvedValue({ ok: true }),
    openArtifacts: vi.fn().mockResolvedValue({ ok: true }),
    setAuthMethod: vi.fn().mockResolvedValue({ ok: true }),
    setAuthBrowser: vi.fn().mockResolvedValue({ ok: true }),
  },
}

const { AccountsSurface } = await import('../../../src/renderer/components/settings/accounts/AccountsSurface')

// ---------------------------------------------------------------------------
// Fixture

function provider(over: Partial<ProviderInstallationView> & Pick<ProviderInstallationView, 'providerId' | 'displayName'>): ProviderInstallationView {
  const cap = { enabled: true, labelExperimental: false }
  return {
    enabled: true, preference: 'on', discoveryState: 'found', version: '1.0.0', compatibility: 'supported', managedAccounts: over.providerId === 'codex',
    signInMethods: { browser: cap, device: cap, apiKey: cap }, status: cap, logout: cap, inUse: 0,
    ...over,
  }
}

function account(over: Partial<AccountView> & Pick<AccountView, 'id' | 'providerId' | 'identityId'>): AccountView {
  return {
    lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false, authMethod: 'browser',
    lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted', realmLifecycle: 'active',
    external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0,
    ...over,
  }
}

// Codex, in the order the registry holds them (the order they were added):
// an inactive account first, so "active first" would move it.
const parked = account({ id: 'acc-parked', providerId: 'codex', identityId: 'id-parked', lifecycle: 'inactive' })
const work = account({ id: 'acc-work', providerId: 'codex', identityId: 'id-work', isProviderDefault: true })
const personal = account({ id: 'acc-personal', providerId: 'codex', identityId: 'id-personal' })
const gone = account({ id: 'acc-gone', providerId: 'codex', identityId: 'id-gone', lifecycle: 'archived', archivedAt: Date.UTC(2026, 8, 12) })
const claudeMain = account({ id: 'acc-claude-main', providerId: 'claude', identityId: 'id-me', legacyId: 'profile-primary', legacyLinked: true, isProviderDefault: true })

function snapshot(over: Partial<AccountsSnapshot> = {}): AccountsSnapshot {
  return {
    revision: 1,
    registry: { mode: 'ready' },
    providers: [
      provider({ providerId: 'claude', displayName: 'Claude Code' }),
      provider({ providerId: 'codex', displayName: 'Codex' }),
    ],
    identities: [
      { id: 'id-parked', friendlyName: 'Parked', colourKey: 'plum' },
      { id: 'id-work', friendlyName: 'Work', colourKey: 'indigo' },
      { id: 'id-personal', friendlyName: 'Personal', colourKey: 'pink' },
      { id: 'id-gone', friendlyName: 'Gone', colourKey: 'rose' },
      { id: 'id-me', friendlyName: 'Me', colourKey: 'mauve' },
    ],
    groups: [],
    accounts: [parked, work, personal, gone, claudeMain],
    pendingSetups: [],
    externalDefaults: [],
    conflicts: [],
    reviewerNotices: [],
    ...over,
  }
}

/** The snapshot main pushes once one Codex account's lifecycle changed: the
 *  registry changes it in place. */
function withLifecycle(s: AccountsSnapshot, id: string, lifecycle: AccountView['lifecycle'], revision: number): AccountsSnapshot {
  return { ...s, revision, accounts: s.accounts.map((a) => (a.id === id ? { ...a, lifecycle } : a)) }
}

const primary: AccountProfile = { id: 'profile-primary', name: 'Me', accountEmail: 'me@example.com', isPrimary: true, createdAt: 1 }
const home: AccountProfile = { id: 'profile-home', name: 'Home', accountEmail: 'home@example.com', createdAt: 2 }
const spare: AccountProfile = { id: 'profile-spare', name: 'Spare', accountEmail: 'spare@example.com', createdAt: 3 }

const pendingSetup: PendingSetupView = { accountId: 'acc-pending', providerId: 'codex', method: 'browser', state: 'pending', external: false, createdAt: 5, signingIn: false }

// ---------------------------------------------------------------------------
// Helpers

let container: HTMLElement
let root: Root
let mounted = false

function render(s: AccountsSnapshot) {
  useProviderAccountsStore.setState({ snapshot: s, loaded: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(React.createElement(AccountsSurface, { onAddClaudeAccount: vi.fn() })) })
  mounted = true
}
function unmountNow() {
  if (!mounted) return
  act(() => { root.unmount() })
  container.remove()
  mounted = false
}

const flush = () => act(async () => { for (let i = 0; i < 16; i++) await Promise.resolve() })
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
async function click(id: string) {
  const el = q(id)
  expect(el, `no element ${id}`).toBeTruthy()
  await act(async () => { el!.click() })
  await flush()
}
/** The account rows of one provider's card, top to bottom. */
function claudeRows(): string[] {
  return [...q('provider-accounts-claude')!.querySelectorAll('[data-testid^="profile-row-"]')].map((el) => el.getAttribute('data-testid')!.slice('profile-row-'.length))
}
function codexRows(): string[] {
  return [...q('provider-accounts-codex')!.querySelectorAll('[data-testid^="provider-account-row-"]')].map((el) => el.getAttribute('data-testid')!.slice('provider-account-row-'.length))
}
function pressed(): Record<string, string | null> {
  return Object.fromEntries(['all', 'active', 'inactive'].map((f) => [f, q(`accounts-filter-${f}`)?.getAttribute('aria-pressed') ?? null]))
}
/** Push a snapshot, as main's onChanged does. */
async function push(s: AccountsSnapshot) {
  await act(async () => { useProviderAccountsStore.getState().receive(s) })
  await flush()
}

beforeEach(() => {
  ;(window as any).electronPlatform = 'win32'
  useAccountsFilterStore.setState({ filter: 'all' })
  useAccountProfilesStore.setState({ profiles: [primary, home, spare] })
  for (const fn of Object.values(pa)) fn.mockClear()
  pa.setLifecycle.mockImplementation(ok)
  profilesApi.setActive.mockReset().mockResolvedValue({ ok: true })
  profilesApi.list.mockReset().mockResolvedValue([primary, home, spare])
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, updateSettings: vi.fn(() => Promise.resolve()) } as never)
})

afterEach(() => { unmountNow() })

// ---------------------------------------------------------------------------
// A steady order

describe('a flip never moves a row', () => {
  it('Claude: making an account inactive and active again keeps every row where it was', async () => {
    render(snapshot())
    expect(claudeRows()).toEqual(['profile-primary', 'profile-home', 'profile-spare'])

    // The list comes back with the changed profile at the end, as main wrote
    // it up to 2.1.3-beta.12 (an edit keeps its place since aicc_planning#383),
    // and the row hydrates the list from it.
    profilesApi.list.mockResolvedValue([primary, spare, { ...home, active: false }])
    await click('profile-menu-btn-profile-home')
    await click('profile-menu-make-inactive-profile-home')
    expect(profilesApi.setActive).toHaveBeenCalledWith('profile-home', false)
    expect(useAccountProfilesStore.getState().profiles.map((p) => p.id)).toEqual(['profile-primary', 'profile-spare', 'profile-home'])
    expect(q('inactive-badge-profile-home')).toBeTruthy()
    expect(claudeRows()).toEqual(['profile-primary', 'profile-home', 'profile-spare'])

    profilesApi.list.mockResolvedValue([primary, spare, { ...home, active: true }])
    await click('profile-menu-btn-profile-home')
    await click('profile-menu-make-active-profile-home')
    expect(profilesApi.setActive).toHaveBeenLastCalledWith('profile-home', true)
    expect(q('inactive-badge-profile-home')).toBeNull()
    expect(claudeRows()).toEqual(['profile-primary', 'profile-home', 'profile-spare'])
  })

  it('Claude: the rows are in the order the accounts were added, whatever order the file has them in', () => {
    // A rename or flip in an earlier build moved Home to the end of the file.
    useAccountProfilesStore.setState({ profiles: [spare, primary, home] })
    render(snapshot())
    expect(claudeRows()).toEqual(['profile-primary', 'profile-home', 'profile-spare'])
  })

  it('Codex: making an account inactive and active again keeps every row where it was', async () => {
    const s = snapshot()
    render(s)
    // The order they were added: the inactive one is not moved below the others.
    expect(codexRows()).toEqual(['acc-parked', 'acc-work', 'acc-personal'])

    await click('account-menu-btn-acc-personal')
    await click('account-menu-make-inactive-acc-personal')
    expect(pa.setLifecycle).toHaveBeenCalledWith({ accountId: 'acc-personal', lifecycle: 'inactive' })
    const s2 = withLifecycle(s, 'acc-personal', 'inactive', 2)
    await push(s2)
    expect(q('account-badge-inactive-acc-personal')).toBeTruthy()
    expect(codexRows()).toEqual(['acc-parked', 'acc-work', 'acc-personal'])

    await click('account-menu-btn-acc-personal')
    await click('account-menu-make-active-acc-personal')
    expect(pa.setLifecycle).toHaveBeenLastCalledWith({ accountId: 'acc-personal', lifecycle: 'active' })
    await push(withLifecycle(s2, 'acc-personal', 'active', 3))
    expect(q('account-badge-inactive-acc-personal')).toBeNull()
    expect(codexRows()).toEqual(['acc-parked', 'acc-work', 'acc-personal'])
  })
})

// ---------------------------------------------------------------------------
// The filter

describe('the All / Active / Inactive filter', () => {
  const mixed = () => useAccountProfilesStore.setState({ profiles: [primary, { ...home, active: false }, spare] })

  it('sits at the top of the page, defaults to All, and counts every list, archived accounts left out', () => {
    mixed()
    render(snapshot())
    const bar = q('accounts-filter')!
    expect(bar.getAttribute('role')).toBe('group')
    expect(document.getElementById(bar.getAttribute('aria-labelledby')!)?.textContent).toBe('Show accounts')
    // First on the page, above the Providers card and every list.
    expect(container.firstElementChild).toBe(bar)
    // Claude: Me and Spare active, Home inactive. Codex: Work and Personal
    // active, Parked inactive; Gone is archived and not counted.
    expect(q('accounts-filter-all')?.textContent).toBe('All (6)')
    expect(q('accounts-filter-active')?.textContent).toBe('Active (4)')
    expect(q('accounts-filter-inactive')?.textContent).toBe('Inactive (2)')
    expect(pressed()).toEqual({ all: 'true', active: 'false', inactive: 'false' })
    // Plain buttons: Tab reaches them, Enter and Space press them, and focus
    // draws the strong ring every Settings control uses.
    for (const f of ['all', 'active', 'inactive']) {
      const b = q(`accounts-filter-${f}`)!
      expect(b.tagName).toBe('BUTTON')
      expect(b.getAttribute('type')).toBe('button')
      expect(b.hasAttribute('disabled')).toBe(false)
      expect(b.classList.contains('focus-ring-strong')).toBe(true)
      expect(b.classList.contains('focus-ring')).toBe(false)
    }
    expect(claudeRows()).toEqual(['profile-primary', 'profile-home', 'profile-spare'])
    expect(codexRows()).toEqual(['acc-parked', 'acc-work', 'acc-personal'])
  })

  it('Active and Inactive filter every list on the page, in its steady order, and All shows them all again', async () => {
    mixed()
    render(snapshot())
    await click('accounts-filter-active')
    expect(pressed()).toEqual({ all: 'false', active: 'true', inactive: 'false' })
    expect(claudeRows()).toEqual(['profile-primary', 'profile-spare'])
    expect(codexRows()).toEqual(['acc-work', 'acc-personal'])

    await click('accounts-filter-inactive')
    expect(pressed()).toEqual({ all: 'false', active: 'false', inactive: 'true' })
    expect(claudeRows()).toEqual(['profile-home'])
    expect(codexRows()).toEqual(['acc-parked'])
    // The counts do not change with the choice.
    expect(q('accounts-filter-all')?.textContent).toBe('All (6)')

    await click('accounts-filter-all')
    expect(claudeRows()).toEqual(['profile-primary', 'profile-home', 'profile-spare'])
    expect(codexRows()).toEqual(['acc-parked', 'acc-work', 'acc-personal'])
  })

  it('a list with no row left says so in one plain line; under All it says nothing', async () => {
    // Every Claude account active; Codex has only an inactive and an archived one.
    render(snapshot({ accounts: [parked, gone, claudeMain] }))
    expect(q('accounts-filter-empty-claude')).toBeNull()
    expect(q('accounts-filter-empty-codex')).toBeNull()

    await click('accounts-filter-inactive')
    expect(q('accounts-filter-empty-claude')?.textContent).toBe('No inactive accounts.')
    expect(q('accounts-filter-empty-codex')).toBeNull()

    await click('accounts-filter-active')
    expect(q('accounts-filter-empty-codex')?.textContent).toBe('No active accounts.')
    expect(q('accounts-filter-empty-claude')).toBeNull()
    expect(claudeRows()).toEqual(['profile-primary', 'profile-home', 'profile-spare'])

    // A provider with no account at all says nothing under All either.
    await click('accounts-filter-all')
    await push(snapshot({ revision: 2, accounts: [claudeMain] }))
    expect(codexRows()).toEqual([])
    expect(q('accounts-filter-empty-codex')).toBeNull()
  })

  it('archived accounts keep "Archived (N)" and unfinished setups stay listed under every filter', async () => {
    render(snapshot({ pendingSetups: [pendingSetup] }))
    for (const f of ['all', 'active', 'inactive']) {
      await click(`accounts-filter-${f}`)
      expect(q('archived-accounts-codex')?.textContent, f).toContain('Archived (1)')
      expect(q('archived-account-acc-gone'), f).toBeTruthy()
      expect(q('pending-setup-acc-pending'), f).toBeTruthy()
    }
  })

  it('is kept when the page is left and opened again', async () => {
    mixed()
    render(snapshot())
    await click('accounts-filter-inactive')
    unmountNow()
    render(snapshot())
    expect(pressed()).toEqual({ all: 'false', active: 'false', inactive: 'true' })
    expect(claudeRows()).toEqual(['profile-home'])
    expect(codexRows()).toEqual(['acc-parked'])
  })

  it('a row made inactive under Active leaves the list, and comes back under Inactive in its place', async () => {
    const s = snapshot()
    render(s)
    await click('accounts-filter-active')
    await click('account-menu-btn-acc-personal')
    await click('account-menu-make-inactive-acc-personal')
    await push(withLifecycle(s, 'acc-personal', 'inactive', 2))
    expect(codexRows()).toEqual(['acc-work'])
    await click('accounts-filter-inactive')
    expect(codexRows()).toEqual(['acc-parked', 'acc-personal'])
  })
})

// ---------------------------------------------------------------------------
// Pure selectors

describe('selectors', () => {
  it('selectAccountsInAddedOrder keeps the snapshot order and hides archived and other providers\' accounts; selectProviderAccounts keeps active first for the choosers', () => {
    const s = snapshot()
    expect(selectAccountsInAddedOrder(s, 'codex').map((a) => a.id)).toEqual(['acc-parked', 'acc-work', 'acc-personal'])
    expect(selectProviderAccounts(s, 'codex').map((a) => a.id)).toEqual(['acc-work', 'acc-personal', 'acc-parked'])
    expect(selectAccountsInAddedOrder(null, 'codex')).toEqual([])
  })

  it('profilesInAddedOrder sorts by createdAt, puts undated profiles last by id, and never reads the input order', () => {
    const undatedB = { id: 'profile-b', createdAt: undefined as unknown as number }
    const undatedA = { id: 'profile-a', createdAt: Number.NaN }
    const input = [undatedB, spare, undatedA, home, primary]
    const out = profilesInAddedOrder(input).map((p) => p.id)
    expect(out).toEqual(['profile-primary', 'profile-home', 'profile-spare', 'profile-a', 'profile-b'])
    expect(profilesInAddedOrder([...input].reverse()).map((p) => p.id)).toEqual(out)
    // The store's array is not sorted in place.
    expect(input[0]).toBe(undatedB)
  })

  it('accountsFilterCounts counts Claude profiles and each managed provider, archived left out; Claude alone while the registry is not ready', () => {
    const profiles = [primary, { ...home, active: false }, spare, { ...spare, id: 'profile-old-primary', isPrimary: true, active: false }]
    // A primary is always active, even when the file says otherwise.
    expect(accountsFilterCounts(profiles, snapshot())).toEqual({ all: 7, active: 5, inactive: 2 })
    expect(accountsFilterCounts(profiles, snapshot({ registry: { mode: 'unavailable' } as AccountsSnapshot['registry'] }))).toEqual({ all: 4, active: 3, inactive: 1 })
    expect(accountsFilterCounts([], null)).toEqual({ all: 0, active: 0, inactive: 0 })
    expect(managedListProviders(snapshot()).map((p) => p.providerId)).toEqual(['codex'])
  })

  it('filterShows and filterEmptyText', () => {
    expect([filterShows('all', true), filterShows('all', false)]).toEqual([true, true])
    expect([filterShows('active', true), filterShows('active', false)]).toEqual([true, false])
    expect([filterShows('inactive', true), filterShows('inactive', false)]).toEqual([false, true])
    expect(filterEmptyText('all')).toBeNull()
    expect(filterEmptyText('active')).toBe('No active accounts.')
    expect(filterEmptyText('inactive')).toBe('No inactive accounts.')
  })
})
