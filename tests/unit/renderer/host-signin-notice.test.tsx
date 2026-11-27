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
const { useHostAccountsStore, resetHostAccountsStore, pruneHostWaits, noteStartCarried, startCarried, SIGN_IN_WAIT_MS, SIGN_IN_END_GRACE_MS } = await import('../../../src/renderer/stores/hostAccountsStore')

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
      accountsAdopt: vi.fn(async () => ({ ok: true, message: 'Adopted Personal: its folder there is this computer\'s now.', adopted: ['p2'] })),
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

  // MINOR-3 (round 1): a tab main says runs through the helper, with a plain
  // SSH Connection (not kept): no End, and the restart carries the conversation.
  it('a tab main says runs through the helper but does not keep: no End, and it starts on the account carrying its conversation', async () => {
    ;(window as any).electronAPI.ssh = {
      onFlowState: (_id: string, cb: (m: { state: string }) => void) => { cb({ state: 'through-helper' }); return () => {} },
      getState: async () => ({ state: 'through-helper' }),
    }
    useHostAccountsStore.getState().setAccounts({ machines: [read('signed-in-here', 'signed-in-here')] })
    await switchTo(tab({ id: 'tab-4', profileId: 'p1', sshConfig: { ...SSH, detachable: false } }), 'p2')
    expect(endTab).not.toHaveBeenCalled()
    expect(restartSpy).toHaveBeenCalledWith({ profileId: 'p2', carryConversation: true })
  })

  // NIT-8 (round 1): with the account not read there, ending the kept session
  // first could leave the tab with nothing running; it says to Check instead.
  it('a kept tab, to an account not read there yet: nothing is ended or restarted, and it says to Check first', async () => {
    useHostAccountsStore.getState().setAccounts({ machines: [read('signed-in-here', 'not-read')] })
    await switchTo(kept, 'p2')
    expect(endTab).not.toHaveBeenCalled()
    expect(restartSpy).not.toHaveBeenCalled()
    expect(byTest('host-signin-message')?.textContent).toContain('Press Check on Rocky\'s card on the Machines page, then switch again.')
    resetHostAccountsStore()
    useHostAccountsStore.getState().setMachines(STATE)
    act(() => root.unmount())
    container.remove()
    await switchTo(kept, 'p2')
    expect(endTab).not.toHaveBeenCalled()
    expect(restartSpy).not.toHaveBeenCalled()
  })
})

// MAJOR-1 (round 1): the tab that waits for a sign-in goes on only when THAT
// sign-in tab ends signed in as that account, once. Any other way out drops
// the wait: Cancel or the other account, a later notice, a Restart or Switch
// of the tab, either tab closing, a sign-in tab that ends without signing in
// or never starts, and a time limit.
describe('the wait for a sign-in is the sign-in tab\'s own, and is dropped on every other way out', () => {
  async function signInFromNotice(): Promise<string> {
    await mount(<HostSignInNotice />)
    await push(refused('tab-1', 'not-signed-in'))
    await click(byTest('host-signin-here'))
    const id = useSessionStore.getState().sessions.find((s) => s.remoteAccountSignIn)!.id
    expect(useHostAccountsStore.getState().waiting).toHaveLength(1)
    return id
  }
  const ended = (sessionId: string, state: 'signed-in-here' | 'not-signed-in' = 'signed-in-here'): HostAccountNotice =>
    ({ kind: 'sign-in-ended', sessionId, did: DID, profileId: 'p2', state })

  it('its own sign-in tab ending signed in: the tab starts, once', async () => {
    const signIn = await signInFromNotice()
    await push(ended(signIn))
    await push(ended(signIn))
    expect(restartSpy).toHaveBeenCalledTimes(1)
    expect(restartSpy).toHaveBeenCalledWith({ profileId: 'p2' })
  })

  it('another sign-in tab of that account on that machine ending: nothing starts', async () => {
    await signInFromNotice()
    await push(ended('another-sign-in-tab'))
    expect(restartSpy).not.toHaveBeenCalled()
    expect(useHostAccountsStore.getState().waiting).toHaveLength(1)
  })

  it('a later notice for the tab, then Use this account: it starts once, on that account, and the sign-in\'s end starts nothing', async () => {
    const signIn = await signInFromNotice()
    await push(refused('tab-1', 'not-signed-in'))
    expect(useHostAccountsStore.getState().waiting).toEqual([])
    await click(byTest('host-signin-use-other'))
    await push(ended(signIn))
    expect(restartSpy).toHaveBeenCalledTimes(1)
    expect(restartSpy).toHaveBeenCalledWith({ profileId: 'p1' })
  })

  it('a later notice for the tab, then Cancel: the sign-in\'s end starts nothing', async () => {
    const signIn = await signInFromNotice()
    await push(refused('tab-1', 'not-signed-in'))
    await click(byTest('host-signin-cancel'))
    await push(ended(signIn))
    expect(restartSpy).not.toHaveBeenCalled()
  })

  it('a Restart or a Switch of the tab meanwhile (it starts again): the sign-in\'s end starts nothing', async () => {
    const signIn = await signInFromNotice()
    await act(async () => { useSessionStore.getState().updateSession('tab-1', { createdAt: 2 }) })
    await settle()
    expect(useHostAccountsStore.getState().waiting).toEqual([])
    await push(ended(signIn))
    expect(restartSpy).not.toHaveBeenCalled()
  })

  it('the sign-in tab closed, or the waiting tab closed: the wait goes', async () => {
    const signIn = await signInFromNotice()
    await act(async () => { useSessionStore.getState().removeSession(signIn) })
    await settle()
    expect(useHostAccountsStore.getState().waiting).toEqual([])
    await push(ended(signIn))
    expect(restartSpy).not.toHaveBeenCalled()
    act(() => root.unmount())
    container.remove()
    resetHostAccountsStore()
    useHostAccountsStore.getState().setMachines(STATE)
    useHostAccountsStore.getState().setAccounts({ machines: [read('signed-in-here', 'not-signed-in')] })
    useSessionStore.setState({ sessions: [tab({})] })
    const second = await signInFromNotice()
    await act(async () => { useSessionStore.getState().removeSession('tab-1') })
    await settle()
    expect(useHostAccountsStore.getState().waiting).toEqual([])
    await push(ended(second))
    expect(restartSpy).not.toHaveBeenCalled()
  })

  it('a sign-in tab that ends with no sign-in end (it started nothing): the wait goes after a short grace', async () => {
    const signIn = await signInFromNotice()
    await act(async () => { useSessionStore.getState().updateSession(signIn, { ptyExited: true }) })
    await settle()
    expect(useHostAccountsStore.getState().waiting).toHaveLength(1)
    pruneHostWaits(Date.now() + SIGN_IN_END_GRACE_MS + 1_000)
    expect(useHostAccountsStore.getState().waiting).toEqual([])
    await push(ended(signIn))
    expect(restartSpy).not.toHaveBeenCalled()
  })

  it('a sign-in never finished: the wait goes at its time limit', async () => {
    const signIn = await signInFromNotice()
    pruneHostWaits(Date.now() + SIGN_IN_END_GRACE_MS + 1_000)
    expect(useHostAccountsStore.getState().waiting).toHaveLength(1)
    pruneHostWaits(Date.now() + SIGN_IN_WAIT_MS + 1_000)
    expect(useHostAccountsStore.getState().waiting).toEqual([])
    await push(ended(signIn))
    expect(restartSpy).not.toHaveBeenCalled()
  })

  // R1-N1 (round 2): `claude auth login` exits on success and main reads the
  // machine before it sends the sign-in's end; a finished sign-in tab closed
  // in those seconds keeps the wait until the grace ends.
  it('a finished sign-in tab closed before its end arrives: the tab still goes on, once', async () => {
    const signIn = await signInFromNotice()
    await act(async () => { useSessionStore.getState().updateSession(signIn, { ptyExited: true }) })
    await settle()
    await act(async () => { useSessionStore.getState().removeSession(signIn) })
    await settle()
    expect(useHostAccountsStore.getState().waiting).toHaveLength(1)
    await push(ended(signIn))
    await push(ended(signIn))
    expect(restartSpy).toHaveBeenCalledTimes(1)
    expect(restartSpy).toHaveBeenCalledWith({ profileId: 'p2' })
  })

  it('a finished sign-in tab closed, and no end within the grace: the wait goes', async () => {
    const signIn = await signInFromNotice()
    await act(async () => { useSessionStore.getState().updateSession(signIn, { ptyExited: true }) })
    await settle()
    await act(async () => { useSessionStore.getState().removeSession(signIn) })
    await settle()
    pruneHostWaits(Date.now() + SIGN_IN_END_GRACE_MS + 1_000)
    expect(useHostAccountsStore.getState().waiting).toEqual([])
  })
})

// R2-1 (round 2): main's refusal says the account's folder there carries
// another install's mark and may be this computer's own (`adoptable`): the
// notice says so in main's words and offers Adopt, which asks first.
describe('a folder that may be this computer\'s own from an earlier install', () => {
  const adoptable = (): HostAccountNotice => ({
    kind: 'launch-refused', sessionId: 'tab-1',
    refusal: { did: DID, machineName: 'Rocky (nick@rocky.lan:22)', profileId: 'p2', state: 'not-signed-in', adoptable: true, signedInThere: ['p1'], text: '' },
  })
  it('the notice says so and offers Adopt (no Sign in); another account and Cancel stay', async () => {
    await mount(<HostSignInNotice />)
    await push(adoptable())
    expect(byTest('host-signin-question')?.textContent).toBe('Personal\'s folder on Rocky carries another install\'s mark.')
    expect(byTest('host-signin-why')?.textContent).toBe('It may be this computer\'s own from an earlier install of the app: if so, Adopt makes it this computer\'s again. If it is the app\'s on another computer, start this session on an account signed in there.')
    expect(byTest('host-signin-here')).toBeNull()
    expect(byTest('host-signin-use-other')).not.toBeNull()
    await click(byTest('host-signin-adopt'))
    expect(useHostAccountsStore.getState().adoptAsk).toEqual({ did: DID, machineName: 'Rocky', profileIds: ['p2'] })
    expect(byTest('host-signin-question')).toBeNull()
  })

  it('Adopt asks first, naming the accounts; Cancel runs nothing; Adopt runs it, says what it did, and reads the machines again', async () => {
    const remote = (window as any).electronAPI.machines.remote
    await mount(<HostSignInNotice />)
    await act(async () => { useHostAccountsStore.getState().askAdopt({ did: DID, machineName: 'Rocky', profileIds: ['p2'] }) })
    await settle()
    const dlg = byTest('host-adopt-confirm')
    expect(dlg?.textContent).toContain('Adopt Personal on Rocky? Its folder there carries another install\'s mark.')
    expect(document.activeElement?.textContent).toBe('Cancel')
    await click(byTest('host-adopt-cancel'))
    expect(remote.accountsAdopt).not.toHaveBeenCalled()
    expect(byTest('host-adopt-confirm')).toBeNull()
    await act(async () => { useHostAccountsStore.getState().askAdopt({ did: DID, machineName: 'Rocky', profileIds: ['p2'] }) })
    await settle()
    const before = remote.accounts.mock.calls.length
    await click(byTest('host-adopt-run'))
    expect(remote.accountsAdopt).toHaveBeenCalledWith({ did: DID, profileIds: ['p2'] })
    expect(byTest('host-signin-message')?.textContent).toContain('Adopted Personal: its folder there is this computer\'s now.')
    expect(remote.accounts.mock.calls.length).toBeGreaterThan(before)
  })
})

// MINOR-3 (round 1): a refused start that carried the tab's conversation (a
// Switch Account's) carries it again on the notice's two ways on.
describe('a refused start that carried the conversation carries it again', () => {
  it('Use this account, and the start after the sign-in, both continue the conversation', async () => {
    await mount(<HostSignInNotice />)
    noteStartCarried('tab-1', true)
    await push(refused('tab-1', 'not-signed-in'))
    await click(byTest('host-signin-use-other'))
    expect(restartSpy).toHaveBeenLastCalledWith({ profileId: 'p1', carryConversation: true })
    useSessionStore.getState().updateSession('tab-1', { profileId: 'p2' })
    noteStartCarried('tab-1', true)
    await push(refused('tab-1', 'not-signed-in'))
    await click(byTest('host-signin-here'))
    const signIn = useSessionStore.getState().sessions.find((s) => s.remoteAccountSignIn)!.id
    await push({ kind: 'sign-in-ended', sessionId: signIn, did: DID, profileId: 'p2', state: 'signed-in-here' })
    expect(restartSpy).toHaveBeenLastCalledWith({ profileId: 'p2', carryConversation: true })
    // A start that did not carry (a new tab's) does not.
    noteStartCarried('tab-1', false)
    expect(startCarried('tab-1')).toBe(false)
  })
})

// MINOR-4 (round 1): the notice and its message take the keyboard focus, and give it back.
describe('focus', () => {
  it('the notice starts on Cancel and gives focus back on close; the message starts on OK', async () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    await mount(<HostSignInNotice />)
    await push(refused('tab-1', 'not-signed-in'))
    expect(document.activeElement).toBe(byTest('host-signin-cancel'))
    await click(byTest('host-signin-cancel'))
    expect(document.activeElement).toBe(outside)
    await act(async () => { useHostAccountsStore.getState().showMessage({ title: 'Switch account', text: 'x' }) })
    await settle()
    expect(document.activeElement?.textContent).toBe('OK')
    outside.remove()
  })
})

// MINOR-2 (round 1): the account's folder there is the app on another computer's.
describe('an account whose folder there is another computer\'s', () => {
  it('the notice says so and offers no Sign in there; another account and Cancel stay', async () => {
    useHostAccountsStore.getState().setAccounts({ machines: [{ ...read('signed-in-here', 'not-signed-in'), elsewhere: ['p2'] }] })
    await mount(<HostSignInNotice />)
    await push(refused('tab-1', 'not-signed-in'))
    expect(byTest('host-signin-question')?.textContent).toBe('Personal\'s folder on Rocky is used by the app on another computer.')
    expect(byTest('host-signin-why')?.textContent).toBe('That computer signs it in and out there, so it cannot be signed in from here.')
    expect(byTest('host-signin-here')).toBeNull()
    expect(byTest('host-signin-use-other')).not.toBeNull()
    expect(byTest('host-signin-cancel')).not.toBeNull()
  })
})
