// @vitest-environment jsdom
/**
 * FIX (owner request, 2026-09-01): while an SSH Claude session's identity is
 * still in flight -- no reported remote email AND no mapped local profile yet --
 * the top bar showed nothing where the account · claude.ai · Claude Code pills
 * land. SessionAuthPills now renders a loading shimmer there (SshAuthPending),
 * resolved the instant identity arrives and self-limiting after a bound so it
 * never shimmers forever ("a shimmer that never resolves is worse than blank").
 *
 * SessionAuthPills is not exported, so these drive the whole SessionHeader.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/hooks/useTypography', () => ({ useRegionTypography: () => ({}) }))

const { default: SessionHeader } = await import('../../../src/renderer/components/SessionHeader')
import { useSessionStore, type Session } from '../../../src/renderer/stores/sessionStore'
import { useAccountAuthStore, _resetAccountAuthForTest } from '../../../src/renderer/stores/accountAuthStore'
import { useAccountProfilesStore } from '../../../src/renderer/stores/accountProfilesStore'
import { sshAuthGiveUpMemory, _resetSshAuthGiveUpForTest } from '../../../src/renderer/stores/sshAuthGiveUp'

const SSH_CFG = { host: 'h', port: 22, username: 'u', remotePath: '~' } as any

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', label: 'web', workingDirectory: '/home/me/web', model: 'sonnet',
    color: '#ff0000', status: 'idle', createdAt: 0, sessionType: 'local', configId: 'cfg-1', ...over,
  } as Session
}
/** A standard SSH Claude session with NO identity known yet (no live tick, no
 *  setup-sentinel, no mapped profile) -- the pending case. */
function sshNoIdentity(over: Partial<Session> = {}): Session {
  return makeSession({
    provider: 'claude', sessionType: 'ssh', sshConfig: SSH_CFG,
    accountEmail: undefined, sshRemoteAccount: undefined, profileId: undefined, ...over,
  })
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  _resetAccountAuthForTest()
  _resetSshAuthGiveUpForTest()
  useAccountProfilesStore.setState({ profiles: [] })
  ;(globalThis as any).window.electronAPI = {
    accountWeb: { status: vi.fn(async () => ({ ok: true, cli: { authenticated: false }, web: { status: 'none' } })) },
  }
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  useAccountProfilesStore.setState({ profiles: [] })
  vi.useRealTimers()
})
const render = (s: Session) => act(() => { root.render(<SessionHeader session={s} />) })
const q = (sel: string) => container.querySelector(sel)

describe('SSH account pending shimmer (SshAuthPending)', () => {
  it('renders the shimmer -- account · claude.ai · Claude Code skeletons -- for an SSH Claude session with no identity', () => {
    render(sshNoIdentity())
    const pending = q('[data-testid="session-auth-pending"]')
    expect(pending).not.toBeNull()
    expect(pending?.getAttribute('aria-label')).toBe('Loading account')
    // Three skeleton pills, sized like the resolved trio.
    expect(container.querySelectorAll('[data-testid="session-auth-skeleton"]').length).toBe(3)
    // The shimmer track the bottom bar uses, so the two read as one signal.
    expect(container.querySelector('.statusline-pending-track')).not.toBeNull()
    // ...and the REAL pills are (correctly) still absent.
    expect(q('[data-testid="session-pill-account"]')).toBeNull()
    expect(q('[data-testid="session-pill-claudecode"]')).toBeNull()
    expect(q('[data-testid="session-pill-claudeai"]')).toBeNull()
  })

  it('replaces the shimmer with the real pills the instant the account arrives, and clears its give-up timer', () => {
    vi.useFakeTimers()
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-ssh', name: 'Work', accountEmail: 'remote@x.com' } as any] })
    useAccountAuthStore.setState({ byProfile: { 'profile-ssh': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    // First frame: identity unknown -> shimmer (its give-up timer is now armed).
    render(sshNoIdentity())
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    // The live tunnel /status delivers the account -> the parent switches branch.
    render(sshNoIdentity({ accountEmail: 'remote@x.com' }))
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
    expect(q('[data-testid="session-pill-account"]')).not.toBeNull()
    expect(q('[data-testid="session-pill-claudecode"]')).not.toBeNull()
    // The shimmer unmounted, so its give-up timer must have been cleared. React 19
    // does not warn on a setState after unmount, so assert the cleanup explicitly:
    // the shimmer's timeout is the only timer this header arms, and a leak
    // (mutation: drop the effect's clearTimeout) would leave the count above 0.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a switch to a DIFFERENT still-pending session gets its OWN give-up clock (keyed per session)', () => {
    vi.useFakeTimers()
    // Session A pending; let its 20s give-up clock run almost to the bound.
    render(sshNoIdentity({ id: 'sA' }))
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(19_000) })
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    // Switch to a DIFFERENT still-pending session B. Without key={session.id} the
    // shimmer stays mounted and B inherits A's 19s-elapsed clock; with the key it
    // remounts with a fresh clock.
    render(sshNoIdentity({ id: 'sB' }))
    // 2s later is 21s into A (past its bound) but only 2s into B -- B must still
    // shimmer. Fails without the per-session key (A's timer fires and blanks it).
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
  })

  it('gives up after the timeout and falls back to blank -- never shimmers forever', () => {
    vi.useFakeTimers()
    render(sshNoIdentity())
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    // Just before the bound: still shimmering.
    act(() => { vi.advanceTimersByTime(19_000) })
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    // Past the bound: gone, and (no repo slug) the cluster is blank as before.
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
    expect(q('[data-testid="session-pill-github"]')).toBeNull()
  })

  it('a given-up session STAYS blank on re-activation -- the shimmer must not re-arm on remount (rc.13)', () => {
    vi.useFakeTimers()
    // Session gives up (20s elapses while it is the active tab).
    render(sshNoIdentity({ id: 'sA' }))
    act(() => { vi.advanceTimersByTime(21_000) })
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
    // Switch away (different session) and back: keyed remount of the pending
    // branch. Pre-fix this re-armed a fresh 20s shimmer; now the recorded
    // give-up renders blank immediately and arms NO new timer.
    render(sshNoIdentity({ id: 'sB' }))
    render(sshNoIdentity({ id: 'sA' }))
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
    // sB's pending timer was cleared on ITS unmount, and given-up sA armed no
    // new one -- zero timers proves the remount is inert.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('identity arriving clears the give-up memory, so a later identity LOSS may shimmer afresh', () => {
    vi.useFakeTimers()
    render(sshNoIdentity())
    act(() => { vi.advanceTimersByTime(21_000) })
    expect(sshAuthGiveUpMemory.has('s1')).toBe(true)
    // The remote reports its account -> real pill, and the memory is cleared.
    render(sshNoIdentity({ accountEmail: 'remote@x.com' }))
    expect(q('[data-testid="session-pill-account"]')).not.toBeNull()
    expect(sshAuthGiveUpMemory.has('s1')).toBe(false)
    // Identity gone again (e.g. reconnect from scratch) -> fresh shimmer.
    render(sshNoIdentity())
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
  })

  it('removing the session clears its give-up memory (no stale blank for a reused id)', () => {
    vi.useFakeTimers()
    render(sshNoIdentity())
    act(() => { vi.advanceTimersByTime(21_000) })
    expect(sshAuthGiveUpMemory.has('s1')).toBe(true)
    useSessionStore.getState().removeSession('s1')
    expect(sshAuthGiveUpMemory.has('s1')).toBe(false)
  })

  it('the GitHub pill rides the pending set only when a repo slug is set', () => {
    // No slug -> shimmer alone.
    render(sshNoIdentity())
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    expect(q('[data-testid="session-pill-github"]')).toBeNull()
    // Slug -> shimmer AND the real GitHub pill.
    render(sshNoIdentity({ githubIntegration: { enabled: true, repoSlug: 'nubbymong/web', autoDetected: true } as any }))
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    expect(q('[data-testid="session-pill-github"]')).not.toBeNull()
  })

  it('never renders the shimmer for a LOCAL Claude session (identity comes from the profile)', () => {
    render(makeSession({ provider: 'claude', sessionType: 'local', profileId: undefined }))
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
  })

  it('never renders the shimmer for a shell-only SSH session or a Codex SSH session', () => {
    render(makeSession({ provider: 'claude', sessionType: 'ssh', shellOnly: true, sshConfig: SSH_CFG }))
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
    render(makeSession({ provider: 'codex', sessionType: 'ssh', sshConfig: SSH_CFG }))
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
  })

  it('does NOT render the shimmer once a mapped local profile exists (real pills instead)', () => {
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-ssh', name: 'Work' } as any] })
    useAccountAuthStore.setState({ byProfile: { 'profile-ssh': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    // A launch profileId that maps (sshMappedProfileId falls back to it pre-identity).
    render(sshNoIdentity({ profileId: 'profile-ssh' }))
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
    expect(q('[data-testid="session-pill-account"]')).not.toBeNull()
  })
})

// 2.1.3-beta.18 release smoke (crop-helper-header-pills.png, k-question-a2.png
// against d-today-ccshow.png): a Claude Code tab through the session helper on
// a Linux machine never reported its account, so its header showed the three
// loading pills for 20 s and then nothing. 2.1.3-beta.19 section 3
// (aicc_planning#434): every start of such a tab reads the account on its
// machine, so the header names it as today's SSH tab does; when the start
// named none, main says why and the header says so at once.
describe('a tab through the session helper: its account from its start\'s read', () => {
  const HELPER = 'through-helper'
  let pushes: Array<(msg: { state: string; info?: string }) => void>
  const ssh = (state: string | null) => {
    pushes = []
    ;(globalThis as any).window.electronAPI.ssh = {
      getState: vi.fn(async () => (state ? { state } : null)),
      onFlowState: vi.fn((_id: string, cb: (msg: { state: string; info?: string }) => void) => { pushes.push(cb); return () => {} }),
    }
  }
  const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() }) }

  it('a start that named no account: one plain pill that says so and why, never the loading pills', async () => {
    ssh(HELPER)
    render(sshNoIdentity({ remoteAccountNotShown: 'no-account' }))
    await settle()
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="session-auth-skeleton"]').length).toBe(0)
    const pill = q('[data-testid="session-pill-account-not-available"]') as HTMLElement | null
    expect(pill?.textContent).toBe('Account not available')
    expect(pill?.getAttribute('title')).toContain('names no account')
    // No sign-in pills: nothing about this tab's sign-in is known here.
    expect(q('[data-testid="session-pill-claudeai"]')).toBeNull()
    expect(q('[data-testid="session-pill-claudecode"]')).toBeNull()
  })

  it('a read that did not answer says to press Check', async () => {
    ssh(HELPER)
    render(sshNoIdentity({ remoteAccountNotShown: 'not-read' }))
    await settle()
    const pill = q('[data-testid="session-pill-account-not-available"]') as HTMLElement | null
    expect(pill?.textContent).toBe('Account not available')
    expect(pill?.getAttribute('title')).toContain('Press Check on the Machines page')
  })

  it('before its start\'s read lands, the loading pills: the read comes before the session starts', async () => {
    ssh(HELPER)
    render(sshNoIdentity())
    await settle()
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    expect(q('[data-testid="session-pill-account-not-available"]')).toBeNull()
  })

  it('follows main\'s push: a tab started through the helper after the header mounted', async () => {
    ssh('connecting')
    render(sshNoIdentity({ remoteAccountNotShown: 'no-account' }))
    await settle()
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    act(() => { for (const p of pushes) p({ state: HELPER }) })
    expect(q('[data-testid="session-auth-pending"]')).toBeNull()
    expect(q('[data-testid="session-pill-account-not-available"]')).not.toBeNull()
  })

  it('today\'s SSH tab with no identity yet still shows the loading pills, whatever a reason says', async () => {
    ssh('claude-running')
    render(sshNoIdentity({ remoteAccountNotShown: 'no-account' }))
    await settle()
    expect(q('[data-testid="session-auth-pending"]')).not.toBeNull()
    expect(q('[data-testid="session-pill-account-not-available"]')).toBeNull()
  })

  it('the account its start read: the usual pills, as today\'s SSH tab (mapped to a local profile: the full set)', async () => {
    ssh(HELPER)
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-ssh', name: 'Work', accountEmail: 'remote@x.com' } as any] })
    useAccountAuthStore.setState({ byProfile: { 'profile-ssh': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    render(sshNoIdentity({ accountEmail: 'remote@x.com' }))
    await settle()
    expect(q('[data-testid="session-pill-account-not-available"]')).toBeNull()
    expect(q('[data-testid="session-pill-account"]')).not.toBeNull()
    expect(q('[data-testid="session-pill-claudecode"]')).not.toBeNull()
  })

  it('an account this computer does not hold: the account pill alone, named from the read', async () => {
    ssh(HELPER)
    render(sshNoIdentity({ accountEmail: 'stranger@example.com' }))
    await settle()
    const pill = q('[data-testid="session-pill-account"]') as HTMLElement | null
    expect(pill).not.toBeNull()
    expect(pill?.getAttribute('title')).toContain('stranger@example.com')
    expect(q('[data-testid="session-pill-claudecode"]')).toBeNull()
  })
})

// 2.1.3-beta.19 text smoke (#38, #39, #40), on a tab through the session
// helper: its account pill said "(signed in on the remote host)" though the
// label is read from one field of Claude Code's config file there (the Rocky
// line saw it while the host said 'Not logged in'); its SSH pill said a
// dropped connection ends it (Settings says it comes back within two
// minutes); and its claude.ai and Claude Code pills, which are this
// computer's sign-in for that account, did not say so.
describe('a tab through the session helper: its pills say what they read (text smoke #38, #39, #40)', () => {
  const HELPER = 'through-helper'
  const ssh = (state: string) => {
    ;(globalThis as any).window.electronAPI.ssh = {
      getState: vi.fn(async () => ({ state })),
      onFlowState: vi.fn(() => () => {}),
    }
  }
  const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() }) }
  const mapped = () => {
    useAccountProfilesStore.setState({ profiles: [{ id: 'profile-ssh', name: 'Work', accountEmail: 'remote@x.com' } as any] })
    useAccountAuthStore.setState({ byProfile: { 'profile-ssh': { cliAuthed: false, web: 'expired', loading: false, fetchedAt: 1 } } })
  }
  const title = (id: string) => (q(`[data-testid="${id}"]`) as HTMLElement | null)?.getAttribute('title')

  it('the helper tab: the connection pill says a dropped link comes back; the account pill names the config field; the sign-in pills are this computer\'s', async () => {
    ssh(HELPER)
    mapped()
    render(sshNoIdentity({ accountEmail: 'remote@x.com' }))
    await settle()
    expect(title('ssh-connection-pill')).toBe('Remote session over SSH through the session helper on its machine: a dropped connection comes back within two minutes with what you missed; closing the tab ends it.')
    expect(title('session-pill-account')).toBe("Remote Claude account: remote@x.com (the account Claude Code's config names on the remote host)")
    expect(title('session-pill-claudeai')).toBe('claude.ai web session for this account on this computer')
    expect(title('session-pill-claudecode')).toBe('Claude Code sign-in for this account on this computer; the remote machine signs in by itself')
  })

  it('today\'s SSH tab keeps its connection words; a local tab keeps its sign-in words', async () => {
    ssh('claude-running')
    mapped()
    render(sshNoIdentity({ accountEmail: 'remote@x.com' }))
    await settle()
    expect(title('ssh-connection-pill')).toBe('Remote session over SSH; a dropped connection ends it and reconnecting resumes via --continue.')
    act(() => { root.unmount() })
    root = createRoot(container)
    useAccountAuthStore.setState({ byProfile: { 'profile-ssh': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
    render(makeSession({ provider: 'claude', profileId: 'profile-ssh' }))
    await settle()
    expect(title('session-pill-claudeai')).toBe("claude.ai web session for this session's account")
    expect(title('session-pill-claudecode')).toBe("Claude Code sign-in for this session's account")
  })
})
