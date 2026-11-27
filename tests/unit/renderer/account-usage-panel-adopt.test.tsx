// @vitest-environment jsdom
//
// 2.1.3-beta.20 phase 5 review round 4 (R4-5, R4-7): the account-usage page's
// own wiring of a Claude Code card's Adopt button. The card's test
// (account-usage-machines.test.tsx) hands the card its hover text; this one
// mounts the real page on a machine whose last read names folders that may be
// this computer's own from an earlier install, and reads what the card's
// Adopt button says: every folder Adopt takes there, named as Adopt's confirm
// names them (the profile's name, else its alias, else its email), never by
// the card's own title.
//
// PURE: the real page and stores; window.electronAPI is a fake whose usage
// stream is held open, so nothing is read and nothing settles.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountProfile } from '../../../src/shared/account-types'
import type { HostMachineAccounts } from '../../../src/shared/host-accounts'
import type { RemoteMachinesState } from '../../../src/shared/remote-machines'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useReauthAccount', () => ({ useReauthAccount: () => vi.fn() }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark', useThemeController: () => {} }))
vi.mock('../../../src/renderer/components/PageFrame', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="page-frame">{children}</div>,
}))

const DID = 'a'.repeat(32)
const ROCKY = { did: DID, label: 'Rocky', name: 'Rocky (nick@rocky.lan:22)', target: 'nick@rocky.lan:22', checked: true, lastCheck: { at: 1, ok: true }, helperVersion: '0.1.0', system: 'Linux x86-64', inUse: 0 }
const STATE: RemoteMachinesState = { available: true, switchOn: true, bundled: { ok: true, version: '0.1.0', files: [] }, machines: [ROCKY], candidates: [] } as unknown as RemoteMachinesState
/** Rocky's last read: Personal's and Spare's folders there carry another
 *  install's mark, and every such folder is for one of this computer's accounts. */
const READ: HostMachineAccounts = {
  did: DID, readAt: 1, ok: true, own: null, others: [],
  accounts: [
    { profileId: 'p2', state: 'not-signed-in', facts: null, folder: false },
    { profileId: 'p3', state: 'not-signed-in', facts: null, folder: false },
  ],
  elsewhere: ['p2', 'p3'], mayBeEarlierInstall: true, oldMarker: [],
}
const profile = (id: string, name: string, accountEmail: string): AccountProfile => ({ id, name, accountEmail, createdAt: 0 })
// Spare's profile has no name of its own: the confirm names it by its alias;
// a card's title is its email.
const PROFILES = [profile('p2', 'Personal', 'p@x.io'), profile('p3', '', 's@x.io')]

Object.defineProperty(window, 'electronAPI', {
  writable: true, configurable: true,
  value: {
    accountProfiles: { list: vi.fn(async () => PROFILES), authInfo: vi.fn(async () => []) },
    accountUsage: { fetchAllStream: vi.fn(() => new Promise<void>(() => {})), fetchOne: vi.fn(async () => null), lastKnown: vi.fn(async () => []) },
    providerAccounts: { usageStream: vi.fn(() => new Promise(() => {})), usageOne: vi.fn(async () => ({ ok: false, code: 'not-found' })), usageStreamStop: vi.fn(async () => ({ ok: true })) },
    config: { save: vi.fn(async () => true) },
    machines: { remote: { state: vi.fn(async () => STATE), accounts: vi.fn(async () => ({ machines: [READ] })) } },
  },
})

const { default: AccountUsagePanel, forgetAccountUsagePage } = await import('../../../src/renderer/components/AccountUsagePanel')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useHostAccountsStore, resetHostAccountsStore } = await import('../../../src/renderer/stores/hostAccountsStore')

let container: HTMLDivElement
let root: Root
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() }) }

beforeEach(() => {
  forgetAccountUsagePage()
  resetHostAccountsStore()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, accountAliases: { 's@x.io': 'Spare' } }, isLoaded: true })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount()); container.remove()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
  resetHostAccountsStore()
})

describe('a Claude Code card\'s Adopt, as the page wires it', () => {
  it('its hover text names every folder Adopt takes on that machine, as the confirm names them', async () => {
    await act(async () => { root.render(<AccountUsagePanel onClose={() => {}} onReauthNavigate={() => {}} />) })
    await flush()
    expect(useHostAccountsStore.getState().byDid[DID]).toBeDefined()
    const adopts = [...container.querySelectorAll('[data-testid="account-usage-machine-adopt"]')] as HTMLElement[]
    // One Adopt per card (Personal's, Spare's), each on Rocky's line.
    expect(adopts).toHaveLength(2)
    for (const b of adopts) {
      expect(b.title).toBe("Asks first, then makes the folders for Personal and Spare on Rocky this computer's again. They carry another install's mark and may be this computer's own from an earlier install.")
    }
  })
})
