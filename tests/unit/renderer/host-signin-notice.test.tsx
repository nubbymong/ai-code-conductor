// @vitest-environment jsdom
//
// 2.1.3-beta.20 section 5 (the approved mockup "Accounts across machines",
// frames 2 and 3, Claude Code rows only): the not-signed-in notice beside
// AccountLaunchGate, and Switch Account on a tab through the session helper.
//  - A helper tab whose launch started nothing for its account (main's
//    launch-refused push) asks how it signs in there: Sign in on <machine>,
//    another account signed in there, Cancel. Lend from this computer is not
//    offered (not built yet; Q7).
//  - Sign in on <machine> opens a sign-in tab on that machine's saved config;
//    once it ends signed in, the waiting tab starts on that account.
//  - Switch Account on a helper tab to an account not signed in there opens
//    the notice and switches nothing; to one signed in there, a kept session
//    is ended first and the tab starts on it with its conversation. Today's
//    plain SSH tab never switches.
//
// PURE: the real notice, stores and hook; a fake window.electronAPI; the
// tab's Restart is a spy (useRestartSession is mocked), so nothing spawns.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { HostAccountNotice, HostMachineAccounts } from '../../../src/shared/host-accounts'
import type { RemoteMachinesState } from '../../../src/shared/remote-machines'
import type { Session } from '../../../src/renderer/stores/sessionStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const restartSpy = vi.fn((_overrides?: Partial<Session>) => true)
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({
  useRestartSession: () => ({ restart: restartSpy, recover: vi.fn() }),
}))
vi.mock('../../../src/renderer/session-persistence', async () => {
  const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
  return {
    persistLastUsedAccount: vi.fn(async (id: string, profileId: string | undefined) => { useSessionStore.getState().updateSession(id, { profileId }) }),
    persistSessionProviderAccount: vi.fn(async () => {}),
    persistSessionState: vi.fn(async () => {}),
  }
})

const { default: HostSignInNotice } = await import('../../../src/renderer/components/HostSignInNotice')
const { useSwitchAccount } = await import('../../../src/renderer/hooks/useSwitchAccount')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useConfigStore } = await import('../../../src/renderer/stores/configStore')
const { useAccountProfilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')
const { useHostAccountsStore, resetHostAccountsStore } = await import('../../../src/renderer/stores/hostAccountsStore')

const DID = 'a'.repeat(32)
const ROCKY = { did: DID, label: 'Rocky', name: 'Rocky (nick@rocky.lan:22)', target: 'nick@rocky.lan:22', checked: true, lastCheck: { at: 1, ok: true }, helperVersion: '0.1.0', system: 'Linux x86-64', inUse: 0 }
const STATE: RemoteMachinesState = { available: true, switchOn: true, bundled: { ok: true, version: '0.1.0', files: [] }, machines: [ROCKY], candidates: [] }
const SSH = { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~/src/web-app' }
const read = (p1: string, p2: string): HostMachineAccounts => ({
  did: DID, readAt: 1, ok: true, own: null, others: [],
  accounts: [
    { profileId: 'p1', state: p1 as never, facts: null, folder: p1 === 'signed-in-here' },
    { profileId: 'p2', state: p2 as never, facts: null, folder: p2 === 'signed-in-here' },
  ],
})

let notify: ((n: HostAccountNotice) => void) | null = null
let endTab: ReturnType<typeof vi.fn>
let container: HTMLDivElement
let root: Root

const tab = (over: Partial<Session>): Session => ({
  id: 'tab-1', label: 'web-app', workingDirectory: '', model: '', color: '#fff', status: 'idle', createdAt: 1,
  sessionType: 'ssh', provider: 'claude', sshConfig: { ...SSH }, profileId: 'p2', ...over,
})

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
}
async function mount(node: React.ReactNode): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<>{node}</>) })
  await settle()
}
const dialog = () => document.querySelector('[data-testid="host-signin-notice"]')
const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
async function click(el: Element | null) {
  expect(el, 'the control is there').not.toBeNull()
  await act(async () => { (el as HTMLElement).click() })
  await settle()
}
async function push(n: HostAccountNotice) {
  await act(async () => { notify?.(n) })
  await settle()
}
const refused = (sessionId: string, state: 'not-signed-in' | 'someone-else' | 'not-read', signedInThere = ['p1']): HostAccountNotice => ({
  kind: 'launch-refused', sessionId,
  refusal: { did: DID, machineName: 'Rocky (nick@rocky.lan:22)', profileId: 'p2', state, signedInThere, text: 'Personal is not signed in on Rocky, so this tab started nothing.' },
})

beforeEach(() => {
  restartSpy.mockClear()
  resetHostAccountsStore()
  notify = null
  endTab = vi.fn(async () => ({ ok: true, message: 'Ended.' }))
  ;(window as any).electronAPI = {
    machines: { remote: {
      state: vi.fn(async () => STATE),
      accounts: vi.fn(async () => ({ machines: [read('signed-in-here', 'not-signed-in')] })),
      onAccountsChanged: vi.fn(() => () => {}),
      onAccountNotice: vi.fn((cb: (n: HostAccountNotice) => void) => { notify = cb; return () => { notify = null } }),
      endTab,
    } },
    pty: { kill: vi.fn() },
  }
  useAccountProfilesStore.setState({ profiles: [
    { id: 'p1', name: 'Work', accountEmail: 'w@x.io', active: true } as never,
    { id: 'p2', name: 'Personal', accountEmail: 'p@x.io', active: true } as never,
  ] })
  useConfigStore.setState({ configs: [{ id: 'cfg-rocky', label: 'Rocky', workingDirectory: '', color: '#fff', sessionType: 'ssh', sshConfig: { ...SSH } } as never] })
  useSessionStore.setState({ sessions: [tab({})], activeSessionId: 'tab-1' })
  useHostAccountsStore.getState().setMachines(STATE)
  useHostAccountsStore.getState().setAccounts({ machines: [read('signed-in-here', 'not-signed-in')] })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  delete (window as any).electronAPI
})

describe('the not-signed-in notice before a helper launch (frame 2)', () => {
  it('a launch that started nothing asks: Sign in on <machine>, another account signed in there, Cancel; no Lend', async () => {
    await mount(<HostSignInNotice />)
    expect(dialog()).toBeNull()
    await push(refused('tab-1', 'not-signed-in'))
    expect(dialog()).not.toBeNull()
    const text = dialog()!.textContent ?? ''
    expect(text).toContain('Start session')
    expect(text).toContain('Choose how web-app signs in on Rocky')
    expect(byTest('host-signin-question')?.textContent).toBe('Personal is not signed in on Rocky.')
    expect(byTest('host-signin-why')?.textContent).toBe('Rocky keeps its own sign-ins.')
    expect(byTest('host-signin-here')?.textContent).toBe('Sign in on Rocky')
    const options = [...(byTest('host-signin-other-select') as HTMLSelectElement).options].map((o) => o.textContent)
    expect(options).toEqual([`Work ${String.fromCharCode(0xb7)} signed in on Rocky`])
    expect(byTest('host-signin-use-other')?.textContent).toBe('Use this account')
    expect(byTest('host-signin-cancel')?.textContent).toBe('Cancel')
    // Lend from this computer is left out, not greyed (Q7).
    expect(document.body.textContent).not.toMatch(/lend/i)
  })

  it('signed in there as another account: says so; with no other account signed in there, no list', async () => {
    await mount(<HostSignInNotice />)
    await push({ kind: 'launch-refused', sessionId: 'tab-1', refusal: { did: DID, machineName: 'Rocky (nick@rocky.lan:22)', profileId: 'p2', state: 'someone-else', identity: 'other@x.io', signedInThere: [], text: '' } })
    expect(byTest('host-signin-question')?.textContent).toBe('Personal on Rocky is signed in as other@x.io, so that sign-in is not used.')
    expect(byTest('host-signin-other')).toBeNull()
    expect(byTest('host-signin-here')).not.toBeNull()
  })

  it('asks nothing for a machine whose accounts could not be read, a sign-in tab, or a tab closed since', async () => {
    useSessionStore.setState({ sessions: [tab({}), tab({ id: 'signin-1', shellOnly: true, transient: true, remoteAccountSignIn: true })] })
    await mount(<HostSignInNotice />)
    await push(refused('tab-1', 'not-read', []))
    await push(refused('signin-1', 'not-signed-in'))
    await push(refused('gone-tab', 'not-signed-in'))
    expect(dialog()).toBeNull()
  })

  it('Sign in on <machine> opens a sign-in tab on its saved config; once it ends signed in, the tab starts on that account', async () => {
    await mount(<HostSignInNotice />)
    await push(refused('tab-1', 'not-signed-in'))
    await click(byTest('host-signin-here'))
    expect(dialog()).toBeNull()
    const signIn = useSessionStore.getState().sessions.find((s) => s.remoteAccountSignIn)
    expect(signIn).toMatchObject({ label: 'Sign in on Rocky: Personal', sessionType: 'ssh', shellOnly: true, transient: true, provider: 'claude', profileId: 'p2' })
    expect(signIn?.sshConfig).toMatchObject({ host: 'rocky.lan', port: 22, username: 'nick', detachable: false })
    expect(useSessionStore.getState().activeSessionId).toBe(signIn?.id)
    expect(restartSpy).not.toHaveBeenCalled()
    // A sign-in of another account there lets nothing go on.
    await push({ kind: 'sign-in-ended', sessionId: signIn!.id, did: DID, profileId: 'p1', state: 'signed-in-here' })
    expect(restartSpy).not.toHaveBeenCalled()
    await push({ kind: 'sign-in-ended', sessionId: signIn!.id, did: DID, profileId: 'p2', state: 'signed-in-here' })
    expect(restartSpy).toHaveBeenCalledTimes(1)
    expect(restartSpy).toHaveBeenCalledWith({ profileId: 'p2' })
  })

  it('a sign-in that ended not signed in (or as another account) starts nothing', async () => {
    await mount(<HostSignInNotice />)
    await push(refused('tab-1', 'not-signed-in'))
    await click(byTest('host-signin-here'))
    const signIn = useSessionStore.getState().sessions.find((s) => s.remoteAccountSignIn)!
    await push({ kind: 'sign-in-ended', sessionId: signIn.id, did: DID, profileId: 'p2', state: 'someone-else', identity: 'other@x.io' })
    expect(restartSpy).not.toHaveBeenCalled()
    expect(useHostAccountsStore.getState().waiting).toEqual([])
  })

  it('no saved SSH config reaches the machine: says why, opens no tab', async () => {
    useConfigStore.setState({ configs: [] })
    await mount(<HostSignInNotice />)
    await push(refused('tab-1', 'not-signed-in'))
    await click(byTest('host-signin-here'))
    expect(byTest('host-signin-problem')?.textContent).toMatch(/^No saved SSH config with key sign-in reaches Rocky/)
    expect(useSessionStore.getState().sessions.some((s) => s.remoteAccountSignIn)).toBe(false)
  })

  it('Use this account starts the tab on the other account (a new tab: a new conversation); Cancel starts nothing', async () => {
    await mount(<HostSignInNotice />)
    await push(refused('tab-1', 'not-signed-in'))
    await click(byTest('host-signin-cancel'))
    expect(dialog()).toBeNull()
    expect(restartSpy).not.toHaveBeenCalled()
    await push(refused('tab-1', 'not-signed-in'))
    await click(byTest('host-signin-use-other'))
    expect(dialog()).toBeNull()
    expect(restartSpy).toHaveBeenCalledWith({ profileId: 'p1' })
    expect(useSessionStore.getState().sessions.find((s) => s.id === 'tab-1')?.profileId).toBe('p1')
  })
})

function SwitchHarness({ session, onReady }: { session: Session; onReady: (fn: (id: string, p: string | undefined) => void) => void }) {
  const fn = useSwitchAccount(session)
  React.useEffect(() => { onReady(fn) }, [fn, onReady])
  return null
}

describe('Switch Account on a tab through the session helper (frame 3)', () => {
  async function switchTo(session: Session, profileId: string) {
    useSessionStore.setState({ sessions: [session] })
    let fn: ((id: string, p: string | undefined) => void) | null = null
    await mount(<><HostSignInNotice /><SwitchHarness session={session} onReady={(f) => { fn = f }} /></>)
    await act(async () => { fn!(session.id, profileId) })
    await settle()
  }
  const kept = tab({ id: 'tab-2', profileId: 'p1', remoteVia: 'helper', remoteDid: DID })

  it('an account not signed in on that machine: the notice opens and nothing switches', async () => {
    await switchTo(kept, 'p2')
    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain('Switch account')
    expect(byTest('host-signin-question')?.textContent).toBe('Personal is not signed in on Rocky.')
    // The other account offered is neither the one asked for nor the tab's own.
    expect(byTest('host-signin-other')).toBeNull()
    expect(restartSpy).not.toHaveBeenCalled()
    expect(endTab).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0].profileId).toBe('p1')
  })

  it('an account signed in there: the kept session is ended first, then the tab starts on it with its conversation', async () => {
    useHostAccountsStore.getState().setAccounts({ machines: [read('signed-in-here', 'signed-in-here')] })
    await switchTo(kept, 'p2')
    expect(dialog()).toBeNull()
    expect(endTab).toHaveBeenCalledWith('tab-2', DID)
    expect(restartSpy).toHaveBeenCalledWith({ profileId: 'p2', carryConversation: true })
    expect(useSessionStore.getState().sessions[0].profileId).toBe('p2')
  })

  it('a kept session that could not be ended: no switch; the tab starts again on its account, and the app says why', async () => {
    useHostAccountsStore.getState().setAccounts({ machines: [read('signed-in-here', 'signed-in-here')] })
    endTab.mockResolvedValueOnce({ ok: false, message: 'rocky.lan could not be reached.' })
    await switchTo(kept, 'p2')
    expect(restartSpy).toHaveBeenCalledTimes(1)
    expect(restartSpy).toHaveBeenCalledWith()
    expect(useSessionStore.getState().sessions[0].profileId).toBe('p1')
    expect(byTest('host-signin-message')?.textContent).toContain('The switch did not happen')
  })

  it('today\'s plain SSH tab never switches, whatever is signed in there', async () => {
    useHostAccountsStore.getState().setAccounts({ machines: [read('signed-in-here', 'signed-in-here')] })
    await switchTo(tab({ id: 'tab-3', profileId: 'p1' }), 'p2')
    expect(restartSpy).not.toHaveBeenCalled()
    expect(endTab).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
    expect(useSessionStore.getState().sessions[0].profileId).toBe('p1')
  })
})
