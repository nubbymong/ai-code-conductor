// @vitest-environment jsdom
//
// 2.1.3-beta.20 section 5, frame 4 of the approved mockup "Accounts across
// machines" (Claude Code rows only): each Linux machine's card says how
// accounts sign in there (Sign in on this machine; Lend from this computer is
// left out, not greyed: Q7), lists this computer's accounts with their sign-in
// there (Sign in on <machine>, Sign out; the machine's own sign-in asks first,
// naming it so: Q5), and Remove lists the accounts it signs out first, or,
// when the machine does not answer, what stays signed in there, with Remove
// anyway.
//
// PURE: the real section over a fake window.electronAPI.machines.remote, no IPC.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { HostMachineAccounts, HostSignOutResult } from '../../../src/shared/host-accounts'
import type { RemoteActionResult, RemoteMachinesState } from '../../../src/shared/remote-machines'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: RemoteMachinesSection } = await import('../../../src/renderer/components/RemoteMachinesSection')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useConfigStore } = await import('../../../src/renderer/stores/configStore')
const { useAccountProfilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')
const { resetHostAccountsStore, useHostAccountsStore } = await import('../../../src/renderer/stores/hostAccountsStore')

const DID = 'd'.repeat(32)
const ROCKY = { did: DID, label: 'Rocky', name: 'Rocky (nick@rocky.lan:22)', target: 'nick@rocky.lan:22', checked: true, lastCheck: { at: Date.now(), ok: true }, helperVersion: '0.1.0', system: 'Linux x86-64', inUse: 0 }
const STATE: RemoteMachinesState = { available: true, switchOn: true, bundled: { ok: true, version: '0.1.0', files: [] }, machines: [ROCKY], candidates: [] }
const SSH = { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~' }
const facts = (identity: string) => ({ identity, plan: 'max', tier: null, expiresAt: 1, credentials: true })
const READ: HostMachineAccounts = {
  did: DID, readAt: 1, ok: true, own: facts('s@x.io'), others: [],
  accounts: [
    { profileId: 'p1', state: 'signed-in-here', facts: facts('w@x.io'), folder: true },
    { profileId: 'p2', state: 'not-signed-in', facts: null, folder: false },
    { profileId: 'p3', state: 'machine-own', facts: facts('s@x.io'), folder: false },
  ],
}

let container: HTMLDivElement
let root: Root
let remote: Record<string, ReturnType<typeof vi.fn>>

function install(opts: { read?: HostMachineAccounts; remove?: RemoteActionResult; signOut?: HostSignOutResult } = {}) {
  remote = {
    state: vi.fn(async () => STATE),
    sessions: vi.fn(async () => ({ machines: [] })),
    accounts: vi.fn(async () => ({ machines: [opts.read ?? READ] })),
    accountSignOut: vi.fn(async () => opts.signOut ?? { ok: true, message: 'Signed Work out on Rocky (nick@rocky.lan:22), and removed its folder there.', signedOutWithService: true, state: 'not-signed-in' }),
    remove: vi.fn(async () => opts.remove ?? { ok: true, message: 'Removed the session helper from Rocky (nick@rocky.lan:22).' }),
    check: vi.fn(async () => ({ ok: true, message: 'ok' })),
    endSession: vi.fn(),
  }
  ;(window as any).electronAPI = { machines: { remote } }
}
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
}
async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<RemoteMachinesSection active />) })
  await settle()
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
const rows = () => [...container.querySelectorAll('[data-testid="remote-account-row"]')] as HTMLElement[]
const row = (who: string) => rows().find((r) => r.dataset.who === who) ?? null
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined
async function click(b: Element | null | undefined) {
  expect(b, 'the button is there').toBeTruthy()
  await act(async () => { (b as HTMLElement).click() })
  await settle()
}

beforeEach(() => {
  resetHostAccountsStore()
  useAccountProfilesStore.setState({ profiles: [
    { id: 'p1', name: 'Work', accountEmail: 'w@x.io', active: true } as never,
    { id: 'p2', name: 'Personal', accountEmail: 'p@x.io', active: true } as never,
    { id: 'p3', name: 'Shared', accountEmail: 's@x.io', active: true } as never,
  ] })
  useConfigStore.setState({ configs: [{ id: 'cfg-rocky', label: 'Rocky', workingDirectory: '', color: '#fff', sessionType: 'ssh', sshConfig: { ...SSH } } as never] })
  useSessionStore.setState({ sessions: [], activeSessionId: null })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  delete (window as any).electronAPI
})

describe('a machine card says how accounts sign in there (frame 4)', () => {
  it('one way, Sign in on this machine, checked; Lend from this computer is left out, not greyed', async () => {
    install()
    await mount()
    const how = q('[data-testid="remote-machine-how"]')
    expect(how?.textContent).toContain('How accounts sign in here')
    expect(q('[data-testid="remote-machine-how-signin"]')?.textContent).toBe('Sign in on this machineEach account signs in once on Rocky and stays signed in there. Remote Control works.')
    // NIT-5 (round 1): one way is static text, not a radio group the keyboard cannot reach.
    expect(how?.querySelectorAll('[role="radio"], [role="radiogroup"]')).toHaveLength(0)
    expect(container.textContent).not.toMatch(/lend/i)
  })
})

// MINOR-2 (round 1): an account whose folder there the app on another computer made.
describe('an account whose folder there is another computer\'s', () => {
  it('its row says so and offers no Sign in; Remove says such folders stay', async () => {
    install({ read: { ...READ, elsewhere: ['p2', 'zz9'] } })
    await mount()
    expect(row('Personal')?.querySelector('[data-testid="remote-account-state"]')?.textContent).toBe('Used by the app on another computerIts folder on Rocky was made by the app on another computer, which signs it in and out there.')
    expect(row('Personal')?.querySelector('[data-testid="remote-account-signin"]')).toBeNull()
    expect(row('Personal')?.querySelector('[data-testid="remote-account-signout"]')).toBeNull()
    await click(button('Remove'))
    expect(q('[data-testid="remote-remove-listing"]')?.textContent).toContain('2 account folders there are used by the app on another computer and stay.')
    expect(q('[data-testid="remote-account-adopt"]')).toBeNull()
  })
})

// R2-1 (round 2): every folder there with another install's mark is named by
// one of this computer's accounts (main's mayBeEarlierInstall): the row says
// it may be this computer's own and offers Adopt, which asks first.
describe('a folder that may be this computer\'s own from an earlier install', () => {
  it('its row says so and offers Adopt, which asks (naming the accounts) before anything runs', async () => {
    install({ read: { ...READ, elsewhere: ['p2'], mayBeEarlierInstall: true } })
    await mount()
    expect(row('Personal')?.querySelector('[data-testid="remote-account-state"]')?.textContent).toBe('May be this computer\'s own from an earlier installIts folder on Rocky carries another install\'s mark. If it is this computer\'s own, Adopt makes it so again; if it is the app\'s on another computer, leave it.')
    expect(row('Personal')?.querySelector('[data-testid="remote-account-signin"]')).toBeNull()
    // R3-3 (round 3): its hover text names what it adopts there.
    expect((row('Personal')?.querySelector('[data-testid="remote-account-adopt"]') as HTMLElement).title).toBe("Asks first, then adopts Personal on Rocky: its folder there carries another install's mark.")
    await click(row('Personal')?.querySelector('[data-testid="remote-account-adopt"]'))
    expect(useHostAccountsStore.getState().adoptAsk).toEqual({ did: DID, machineName: 'Rocky', profileIds: ['p2'] })
  })

  it('Remove names those folders as main does, and the old-marker folders it leaves', async () => {
    install({ read: { ...READ, elsewhere: ['p2'], mayBeEarlierInstall: true, oldMarker: ['zz9'] } })
    await mount()
    await click(button('Remove'))
    const text = q('[data-testid="remote-remove-listing"]')?.textContent ?? ''
    expect(text).toContain('Personal: its folder there carries another install\'s mark, and may be this computer\'s own from an earlier install of the app; Remove leaves it as it is. To sign it out from here, choose Adopt on this card first.')
    expect(text).toContain('zz9 (a folder an earlier build of the app made there, for an account this computer does not hold) stays signed in there as it is.')
    expect(text).not.toContain('used by the app on another computer')
  })
})

describe('"Accounts here" lists this computer\'s accounts with their sign-in there', () => {
  it('signed in: Sign out; not signed in: Sign in on <machine>; the machine\'s own sign-in says so', async () => {
    install()
    await mount()
    expect(q('[data-testid="remote-machine-accounts"]')?.textContent).toContain('Accounts here')
    expect(rows().map((r) => r.dataset.who)).toEqual(['Work', 'Personal', 'Shared'])
    expect(row('Work')?.querySelector('[data-testid="remote-account-state"]')?.textContent).toBe('Signed in on Rocky')
    expect(row('Work')?.querySelector('[data-testid="remote-account-signout"]')).not.toBeNull()
    expect(row('Personal')?.querySelector('[data-testid="remote-account-state"]')?.textContent).toBe('Not signed in')
    expect(row('Personal')?.querySelector('[data-testid="remote-account-signin"]')?.textContent).toBe('Sign in on Rocky')
    expect(row('Shared')?.querySelector('[data-testid="remote-account-sub"]')?.textContent).toBe('Rocky was already signed in as Shared, so that sign-in is used.')
    // Each row names its provider; no other provider's rows are drawn.
    for (const r of rows()) expect(r.textContent).toContain('Claude Code')
  })

  it('Sign in on <machine> opens a sign-in tab on the saved config that reaches it', async () => {
    install()
    await mount()
    await click(row('Personal')?.querySelector('[data-testid="remote-account-signin"]'))
    const signIn = useSessionStore.getState().sessions.find((s) => s.remoteAccountSignIn)
    expect(signIn).toMatchObject({ label: 'Sign in on Rocky: Personal', profileId: 'p2', sessionType: 'ssh', transient: true, shellOnly: true })
  })

  it('Sign out signs that account out there; it waits while a tab on that account runs there', async () => {
    install()
    useSessionStore.setState({ sessions: [{ id: 't1', label: 'api', workingDirectory: '', model: '', color: '#fff', status: 'idle', createdAt: 1, sessionType: 'ssh', provider: 'claude', sshConfig: { ...SSH }, profileId: 'p1' } as never] })
    await mount()
    const out = row('Work')?.querySelector('[data-testid="remote-account-signout"]') as HTMLButtonElement
    expect(out.disabled).toBe(true)
    expect(out.title).toBe('A tab runs on this account here')
    await act(async () => { useSessionStore.setState({ sessions: [] }) })
    await settle()
    await click(row('Work')?.querySelector('[data-testid="remote-account-signout"]'))
    expect(remote.accountSignOut).toHaveBeenCalledWith({ did: DID, profileId: 'p1' })
    expect(q('[data-testid="remote-notice"]')?.textContent).toContain('Signed Work out on Rocky')
  })

  it('the machine\'s own sign-in: Sign out asks first, naming it so, and only the confirm sends confirmMachineOwn (Q5)', async () => {
    install()
    await mount()
    await click(row('Shared')?.querySelector('[data-testid="remote-account-signout"]'))
    expect(remote.accountSignOut).not.toHaveBeenCalled()
    const confirm = q('[data-testid="remote-own-signout-confirm"]')
    expect(confirm?.textContent).toContain('Shared is signed in on Rocky by that machine\'s own sign-in (its ~/.claude), not one the app made.')
    await click(button('Keep it'))
    expect(remote.accountSignOut).not.toHaveBeenCalled()
    await click(row('Shared')?.querySelector('[data-testid="remote-account-signout"]'))
    await click(button('Sign out Rocky\'s own sign-in'))
    expect(remote.accountSignOut).toHaveBeenCalledWith({ did: DID, profileId: 'p3', confirmMachineOwn: true })
  })

  it('main answers that it is the machine\'s own sign-in (the read was older): the card asks then', async () => {
    install({ signOut: { ok: false, needsConfirm: 'machine-own', state: 'machine-own', message: 'Work is signed in on Rocky by that machine\'s own sign-in' } })
    await mount()
    await click(row('Work')?.querySelector('[data-testid="remote-account-signout"]'))
    expect(remote.accountSignOut).toHaveBeenCalledTimes(1)
    expect(q('[data-testid="remote-own-signout-confirm"]')).not.toBeNull()
    expect(q('[data-testid="remote-notice"]')?.textContent).toBe('')
  })
})

describe('Remove lists the accounts signed in there (frame 4)', () => {
  it('names the accounts it signs out first, and the machine\'s own sign-in it leaves', async () => {
    install()
    await mount()
    await click(button('Remove'))
    const listing = q('[data-testid="remote-remove-listing"]')
    expect([...(listing?.querySelectorAll('li') ?? [])].map((li) => li.textContent)).toEqual(['Work'])
    expect(listing?.textContent).toContain('Remove Rocky (nick@rocky.lan:22)? This account is signed in there and is signed out first:')
    expect(listing?.textContent).toContain('Shared is signed in there by Rocky\'s own sign-in, which Remove leaves as it is.')
    expect(listing?.textContent).toContain('Then the session helper and its folder in ~/.aicc are deleted.')
    await click(button('Sign out and remove'))
    expect(remote.remove).toHaveBeenCalledWith(DID)
  })

  it('the machine does not answer: asks again in those words, and Remove anyway forgets it', async () => {
    install({ remove: { ok: false, notAnswering: true, message: 'rocky.lan could not be reached: it did not answer.' } })
    await mount()
    await click(button('Remove'))
    await click(button('Sign out and remove'))
    const again = q('[data-testid="remote-remove-not-answering"]')
    expect(again?.textContent).toContain('Rocky (nick@rocky.lan:22) did not answer, so nothing can be signed out there now. Work stays signed in on Rocky (nick@rocky.lan:22) until you sign it out there, or end that sign-in in your Claude account settings on claude.ai. The app forgets Rocky (nick@rocky.lan:22); its folder in ~/.aicc stays.')
    expect(q('[data-testid="remote-notice"]')?.textContent).toBe('')
    await click(button('Remove anyway'))
    expect(remote.remove).toHaveBeenLastCalledWith(DID, { forget: true })
  })

  it('a Remove that failed for another reason does not ask the not-answering question', async () => {
    install({ remove: { ok: false, message: 'The session helper on rocky.lan did not list its sessions, so nothing was removed.' } })
    await mount()
    await click(button('Remove'))
    await click(button('Sign out and remove'))
    expect(q('[data-testid="remote-remove-not-answering"]')).toBeNull()
    expect(q('[data-testid="remote-notice"]')?.textContent).toContain('did not list its sessions')
  })

  it('no account signed in there: today\'s question and button', async () => {
    install({ read: { ...READ, own: null, accounts: READ.accounts.map((a) => ({ ...a, state: 'not-signed-in' as const, facts: null, folder: false })) } })
    await mount()
    await click(button('Remove'))
    expect(q('[aria-label="Confirm removing Rocky"]')?.querySelector('span')?.textContent).toBe('Remove the session helper from Rocky (nick@rocky.lan:22)? Its folder in ~/.aicc there is deleted.')
    expect(button('Sign out and remove')).toBeUndefined()
  })
})
