// @vitest-environment jsdom
/**
 * aicc_planning#305: the session header shows Claude Code's own name for the
 * session (from the statusline) as a pill after the watchdog pill, read live
 * from the store; nothing when there is no name or when it repeats the
 * app's work name. A statusline update carries it into the store, and a
 * Restart clears it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/hooks/useTypography', () => ({ useRegionTypography: () => ({}) }))

let statuslineCb: ((d: unknown) => void) | null = null
;(globalThis as any).window.electronAPI = {
  accountWeb: { status: vi.fn(async () => ({ ok: true, cli: { authenticated: false }, web: { status: 'none' } })) },
  statusline: { onUpdate: (cb: (d: unknown) => void) => { statuslineCb = cb; return () => { statuslineCb = null } } },
}

const { default: SessionHeader } = await import('../../../src/renderer/components/SessionHeader')
const { useStatuslineSubscription } = await import('../../../src/renderer/hooks/useStatuslineSubscription')
import type { Session } from '../../../src/renderer/stores/sessionStore'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import { useAccountAuthStore, _resetAccountAuthForTest } from '../../../src/renderer/stores/accountAuthStore'

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', label: 'web', workingDirectory: 'C:/proj', model: 'sonnet', color: '#ff0000', status: 'idle',
    createdAt: 0, sessionType: 'local', provider: 'claude', configId: 'cfg-1', profileId: 'profile-x', ...over,
  } as Session
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  _resetAccountAuthForTest()
  useAccountAuthStore.setState({ byProfile: { 'profile-x': { cliAuthed: true, web: 'active', loading: false, fetchedAt: 1 } } })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})
function render(s: Session) {
  useSessionStore.setState({ sessions: [s], activeSessionId: s.id })
  act(() => { root.render(<SessionHeader session={s} />) })
}
const pill = () => container.querySelector('[data-testid="session-pill-claude-name"]')

describe("Claude Code's session name pill (#305)", () => {
  it('shows the name, with the full name in its tooltip', () => {
    render(makeSession({ claudeSessionName: 'fix the login bug' }))
    expect(pill()?.textContent).toBe('fix the login bug')
    expect(pill()?.getAttribute('title')).toContain('fix the login bug')
  })

  it('sits after the account pill, in the same row', () => {
    render(makeSession({ claudeSessionName: 'n1' }))
    const account = container.querySelector('[data-testid="session-pill-account"]')!
    expect(account.compareDocumentPosition(pill()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows nothing without a name, or when the name is the work name', () => {
    render(makeSession())
    expect(pill()).toBeNull()
    act(() => { root.unmount() }); root = createRoot(container)
    render(makeSession({ claudeSessionName: 'IM-1 work', customName: 'IM-1 work' }))
    expect(pill()).toBeNull()
  })

  it('follows the store: a rename shows at once', () => {
    render(makeSession({ claudeSessionName: 'old' }))
    act(() => { useSessionStore.getState().updateSession('s1', { claudeSessionName: 'new name' }) })
    expect(pill()?.textContent).toBe('new name')
  })

  it('renders the name as text, never as markup', () => {
    render(makeSession({ claudeSessionName: '<img src=x onerror=alert(1)>' }))
    expect(pill()?.querySelector('img')).toBeNull()
    expect(pill()?.textContent).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('statusline update -> store', () => {
  it('a statusline sessionName lands on the session as claudeSessionName', () => {
    useSessionStore.setState({ sessions: [makeSession()], activeSessionId: 's1' })
    function Harness() { useStatuslineSubscription('s1'); return null }
    act(() => { root.render(<Harness />) })
    act(() => { statuslineCb?.({ sessionId: 's1', sessionName: 'from claude' }) })
    expect(useSessionStore.getState().getSession('s1')?.claudeSessionName).toBe('from claude')
    act(() => { statuslineCb?.({ sessionId: 'other', sessionName: 'not mine' }) })
    expect(useSessionStore.getState().getSession('s1')?.claudeSessionName).toBe('from claude')
  })
})
