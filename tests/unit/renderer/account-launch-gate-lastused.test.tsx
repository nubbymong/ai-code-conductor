// @vitest-environment jsdom
// AccountLaunchGate shortcut row. On a NEW session it is the "Most recent"
// line (the global last-used account); it is a one-click shortcut that bypasses
// the account dropdown, so it must apply the SAME active-only gate the dropdown
// does. Adversarial review found it offered (and launched) a PARKED account.
// On a RESUME (O9) it names the session's OWN account instead, never the
// global one: in a multi-session resume the global value names whichever
// session was answered just before.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const gateState: any = { queue: [], restored: [], resolveChoice: vi.fn(), cancelChoice: vi.fn() }
const profilesState: any = { profiles: [] }
const settingsState: any = { settings: { accountAliases: {}, accountColourOverrides: {}, lastUsedAccountId: undefined } }

vi.mock('../../../src/renderer/stores/accountGateStore', () => ({ useAccountGateStore: (sel: any) => sel(gateState) }))
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({ useAccountProfilesStore: (sel: any) => sel(profilesState) }))
vi.mock('../../../src/renderer/stores/settingsStore', () => ({ useSettingsStore: (sel: any) => sel(settingsState) }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))

const { default: AccountLaunchGate } = await import('../../../src/renderer/components/AccountLaunchGate')

function profile(over: Partial<any> = {}): any {
  return { id: 'p1', name: 'Acct', accountEmail: 'a@b.co', isPrimary: false, active: true, ...over }
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  gateState.resolveChoice = vi.fn()
  gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: undefined, resolve: () => {} }]
  gateState.restored = []
  profilesState.profiles = []
  settingsState.settings = { accountAliases: {}, accountColourOverrides: {}, lastUsedAccountId: undefined }
})
afterEach(() => { act(() => root.unmount()); container.remove() })
const render = () => act(() => root.render(<AccountLaunchGate />))
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null

describe('AccountLaunchGate — suppressed while a boot gate owns the screen', () => {
  it('renders the picker when no boot gate is up', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true })]
    act(() => root.render(<AccountLaunchGate suppressed={false} />))
    expect(container.textContent, 'the queued request paints normally').toContain('Start session')
  })

  it('paints NOTHING while a boot gate is up, even with a request queued', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true })]
    act(() => root.render(<AccountLaunchGate suppressed />))
    expect(container.textContent, 'a picker must not paint over the Multi Spawn startup page').toBe('')
  })

  it('does not consume or answer the queued request while suppressed', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true })]
    const resolve = vi.fn()
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: undefined, resolve }]
    act(() => root.render(<AccountLaunchGate suppressed />))
    // The awaiting spawn has no timeout anywhere in this path, so suppression
    // must PARK it, never answer it on the user's behalf.
    expect(resolve, 'the spawn must keep waiting, not be launched blind').not.toHaveBeenCalled()
    expect(gateState.resolveChoice).not.toHaveBeenCalled()
    expect(gateState.queue.length, 'the queue survives suppression intact').toBe(1)
  })

  it('surfaces the same unanswered request once the gate chain clears', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true })]
    act(() => root.render(<AccountLaunchGate suppressed />))
    expect(container.textContent).toBe('')
    act(() => root.render(<AccountLaunchGate suppressed={false} />))
    expect(container.textContent, 'the picker returns for the SAME session').toContain('web')
  })

  it('defaults to not suppressed, so an ordinary launch is unaffected', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true })]
    act(() => root.render(<AccountLaunchGate />))
    expect(container.textContent).toContain('Start session')
  })
})

describe('AccountLaunchGate: Most recent line (new session)', () => {
  it('shows the Most recent line for an ACTIVE last-used account', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true }), profile({ id: 'p-active', accountEmail: 'used@b.co' })]
    settingsState.settings.lastUsedAccountId = 'p-active'
    render()
    expect(q('[data-testid="account-launch-lastused"]')).not.toBeNull()
    expect(container.textContent).toContain('Most recent')
  })

  it('O9 (e): a new session tags the global row "Most recent" (data-kind recent), never "Last used", and keeps the "Start session" title', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true }), profile({ id: 'p-active', name: 'Used acct', accountEmail: 'used@b.co' })]
    settingsState.settings.lastUsedAccountId = 'p-active'
    render()
    const row = q('[data-testid="account-launch-lastused"]')!
    expect(row.textContent).toContain('Used acct')
    expect(row.textContent).toContain('Most recent')
    expect(row.getAttribute('data-kind')).toBe('recent')
    expect(container.textContent).not.toContain('Last used')
    expect(container.textContent).not.toContain("This session's account")
    expect(container.textContent).toContain('Start session')
    // No option is marked as the session's own on a new session.
    expect(container.textContent).not.toContain('(this session)')
  })

  it('does NOT show the Last used line when the last-used account has been PARKED (inactive)', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true }), profile({ id: 'p-parked', accountEmail: 'parked@b.co', active: false })]
    settingsState.settings.lastUsedAccountId = 'p-parked'
    render()
    // The parked account must not be offered as a one-click launch shortcut.
    expect(q('[data-testid="account-launch-lastused"]')).toBeNull()
    expect(q('[data-testid="account-launch-lastused-use"]')).toBeNull()
  })

  it('still shows a parked last-used account IF it is the session’s own pinned account (relaunch stays possible)', () => {
    // isSelectable keeps the session's currently pinned account selectable even
    // when parked, so a session already on it can relaunch — the Last used line
    // must follow the same rule, not a blanket active-only one.
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true }), profile({ id: 'p-pinned', accountEmail: 'pinned@b.co', active: false })]
    settingsState.settings.lastUsedAccountId = 'p-pinned'
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: 'p-pinned', resolve: () => {} }]
    render()
    expect(q('[data-testid="account-launch-lastused"]')).not.toBeNull()
  })

  it('does not show the line when there is no last-used account, or it was deleted', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true })]
    settingsState.settings.lastUsedAccountId = undefined
    render()
    expect(q('[data-testid="account-launch-lastused"]')).toBeNull()
    act(() => root.unmount()); root = createRoot(container)
    settingsState.settings.lastUsedAccountId = 'gone'
    render()
    expect(q('[data-testid="account-launch-lastused"]')).toBeNull()
  })

  it('#446: a session pinned to a DELETED account pre-selects a real account, not blank', () => {
    // The 'ask' resume path routes an already-pinned profileId through this
    // gate; if that account was deleted, the pre-select must fall through to
    // primary rather than pointing at a non-existent <option> (a blank picker
    // that then launches a dead id).
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true }), profile({ id: 'p-other', accountEmail: 'o@b.co' })]
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: 'deleted-acct', resolve: () => {} }]
    render()
    const select = q('[data-testid="account-launch-select"]') as HTMLSelectElement | null
    expect(select).not.toBeNull()
    expect(select!.value).toBe('primary') // fell through to primary, not '' or the dead id
    // Launch resolves a REAL account.
    const launchBtn = Array.from(container.querySelectorAll('button')).find((b) => /launch|start/i.test(b.textContent || '')) as HTMLButtonElement
    act(() => launchBtn.click())
    expect(gateState.resolveChoice).toHaveBeenCalledWith('primary')
  })

  it('#446: the secondary button reads "Keep this session\'s account" on a RESTORED session, "Cancel" otherwise', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true }), profile({ id: 'p2', accountEmail: 'p2@b.co' })]
    // Fresh session (not restored): Cancel/discard wording.
    render()
    expect(q('[data-testid="account-launch-cancel"]')!.textContent).toContain('Cancel')
    act(() => root.unmount()); root = createRoot(container)
    // Restored session: keep-and-continue wording.
    gateState.restored = ['s1']
    render()
    expect(q('[data-testid="account-launch-cancel"]')!.textContent).toContain("Keep this session's account")
    expect(q('[data-testid="account-launch-cancel"]')!.getAttribute('title')).toBe('Start it on the account it last ran on')
  })

  it('Use → then Launch resolves the gate with an ACTIVE last-used account', () => {
    profilesState.profiles = [profile({ id: 'primary', isPrimary: true }), profile({ id: 'p-active', accountEmail: 'used@b.co' })]
    settingsState.settings.lastUsedAccountId = 'p-active'
    render()
    act(() => q('[data-testid="account-launch-lastused-use"]')!.click())
    // Launch is the primary button; find it by text.
    const launchBtn = Array.from(container.querySelectorAll('button')).find((b) => /launch|start/i.test(b.textContent || '')) as HTMLButtonElement
    expect(launchBtn, 'a launch button').toBeTruthy()
    act(() => launchBtn.click())
    expect(gateState.resolveChoice).toHaveBeenCalledWith('p-active')
  })
})

describe("AccountLaunchGate: a RESUMED session shows its own account (O9)", () => {
  const P = () => [
    profile({ id: 'primary', name: 'Primary acct', accountEmail: 'primary@b.co', isPrimary: true }),
    profile({ id: 'p2', name: 'Second acct', accountEmail: 'two@b.co' }),
    profile({ id: 'p3', name: 'Third acct', accountEmail: 'three@b.co' }),
  ]
  const row = () => q('[data-testid="account-launch-lastused"]')
  const select = () => q('[data-testid="account-launch-select"]') as HTMLSelectElement
  const optionText = (id: string) => (Array.from(select().options).find((o) => o.value === id)?.textContent ?? '')

  it('(a) pinned p2 while the global last-used is p3: the row names p2 as this session\'s account, selected; nothing offers p3', () => {
    profilesState.profiles = P()
    settingsState.settings.lastUsedAccountId = 'p3'
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: 'p2', resolve: () => {} }]
    gateState.restored = ['s1']
    render()
    expect(container.querySelectorAll('[data-testid="account-launch-lastused"]')).toHaveLength(1)
    expect(row()!.textContent).toContain('Second acct')
    expect(row()!.textContent).toContain("This session's account")
    expect(row()!.getAttribute('data-kind')).toBe('own')
    expect(row()!.textContent).toContain('selected')
    expect(row()!.textContent).not.toContain('Third acct')
    expect(container.textContent).not.toContain('Most recent')
    expect(container.textContent).not.toContain('Last used')
    expect(q('[data-testid="account-launch-lastused-use"]')).toBeNull()
    expect(select().value).toBe('p2')
    expect(container.textContent).toContain('Resume session')
  })

  it('(b) a multi-session resume: after s1 is answered on p2, s2 (pinned p3) shows p3, selected, and no shortcut to p2', () => {
    profilesState.profiles = P()
    settingsState.settings.lastUsedAccountId = undefined
    gateState.queue = [
      { sessionId: 's1', sessionLabel: 'first', currentProfileId: 'p2', resolve: () => {} },
      { sessionId: 's2', sessionLabel: 'second', currentProfileId: 'p3', resolve: () => {} },
    ]
    gateState.restored = ['s1', 's2']
    render()
    expect(select().value).toBe('p2')
    act(() => q('[data-testid="account-launch-confirm"]')!.click())
    expect(gateState.resolveChoice).toHaveBeenCalledWith('p2')
    // What answering s1 does in the app: the queue moves on and the global
    // last-used becomes s1's account.
    gateState.queue = gateState.queue.slice(1)
    settingsState.settings.lastUsedAccountId = 'p2'
    render()
    expect(container.textContent).toContain('second')
    expect(container.querySelectorAll('[data-testid="account-launch-lastused"]')).toHaveLength(1)
    expect(row()!.textContent).toContain('Third acct')
    expect(row()!.textContent).not.toContain('Second acct')
    expect(row()!.getAttribute('data-kind')).toBe('own')
    expect(select().value).toBe('p3')
    expect(q('[data-testid="account-launch-lastused-use"]')).toBeNull()
  })

  it('(c) no pin saved: the row is the primary, with a tooltip saying why', () => {
    profilesState.profiles = P()
    settingsState.settings.lastUsedAccountId = 'p3'
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: undefined, resolve: () => {} }]
    gateState.restored = ['s1']
    render()
    expect(row()!.textContent).toContain('Primary acct')
    expect(row()!.getAttribute('data-kind')).toBe('own')
    expect(row()!.getAttribute('title')).toBe('No account was saved with this session, so it ran on your primary account.')
    expect(row()!.textContent).not.toContain('Third acct')
    expect(select().value).toBe('primary')
    expect(q('[data-testid="account-launch-own-notice"]')).toBeNull()
  })

  it('(c2) no pin and no primary: no row, a notice, and the picker still offers a choice', () => {
    profilesState.profiles = [profile({ id: 'p2', name: 'Second acct', accountEmail: 'two@b.co' }), profile({ id: 'p3', name: 'Third acct', accountEmail: 'three@b.co' })]
    settingsState.settings.lastUsedAccountId = 'p3'
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: undefined, resolve: () => {} }]
    gateState.restored = ['s1']
    render()
    expect(row()).toBeNull()
    expect(q('[data-testid="account-launch-own-notice"]')!.textContent).toBe('No account was saved with this session. Choose one to start it.')
    expect(select().value).toBe('p2')
  })

  it('(d) pinned to a DELETED account: no row, a notice, the picker falls back to primary, and the secondary button reads "Not now"', () => {
    profilesState.profiles = P()
    settingsState.settings.lastUsedAccountId = 'p3'
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: 'deleted-acct', resolve: () => {} }]
    gateState.restored = ['s1']
    render()
    expect(row()).toBeNull()
    expect(q('[data-testid="account-launch-own-notice"]')!.textContent).toBe('The account this session last ran on is no longer set up here. Choose one to start it.')
    expect(select().value).toBe('primary')
    const cancel = q('[data-testid="account-launch-cancel"]')!
    expect(cancel.textContent).toBe('Not now')
    expect(cancel.getAttribute('title')).toBe('Keep the tab without starting it. Its account is no longer set up here.')
    expect(container.textContent).not.toContain('(this session)')
  })

  it('(g) a PARKED pin on a resume still shows as the session\'s own account', () => {
    profilesState.profiles = [profile({ id: 'primary', name: 'Primary acct', accountEmail: 'primary@b.co', isPrimary: true }), profile({ id: 'p-parked', name: 'Parked acct', accountEmail: 'parked@b.co', active: false }), profile({ id: 'p3', name: 'Third acct', accountEmail: 'three@b.co' })]
    settingsState.settings.lastUsedAccountId = 'p3'
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: 'p-parked', resolve: () => {} }]
    gateState.restored = ['s1']
    render()
    expect(row()!.textContent).toContain('Parked acct')
    expect(row()!.getAttribute('data-kind')).toBe('own')
    expect(row()!.textContent).not.toContain('Third acct')
    expect(select().value).toBe('p-parked')
  })

  it('(h) the session\'s own option carries "(this session)" in the dropdown, and only that one', () => {
    profilesState.profiles = P()
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: 'p2', resolve: () => {} }]
    gateState.restored = ['s1']
    render()
    expect(optionText('p2')).toBe('Second acct (this session)')
    expect(optionText('p3')).toBe('Third acct')
    expect(optionText('primary')).toBe('Primary acct')
    // With no pin, the primary is the session's own account.
    act(() => root.unmount()); root = createRoot(container)
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: undefined, resolve: () => {} }]
    render()
    expect(optionText('primary')).toBe('Primary acct (this session)')
    expect(optionText('p2')).toBe('Second acct')
  })

  it('choosing another account and then the row\'s Use puts it back on the session\'s own account', () => {
    profilesState.profiles = P()
    settingsState.settings.lastUsedAccountId = 'p3'
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: 'p2', resolve: () => {} }]
    gateState.restored = ['s1']
    render()
    act(() => { const s = select(); s.value = 'p3'; s.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(select().value).toBe('p3')
    act(() => q('[data-testid="account-launch-lastused-use"]')!.click())
    expect(select().value).toBe('p2')
    act(() => q('[data-testid="account-launch-confirm"]')!.click())
    expect(gateState.resolveChoice).toHaveBeenCalledWith('p2')
  })
})
