// @vitest-environment jsdom
/**
 * The words a tab kept by the session helper gets (plan 2.1.3-beta.19 section
 * 1.2): the close question, the persistence chip and the header's connection
 * pill name the helper, not tmux; a tmux tab's keep their words.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ssh = vi.hoisted(() => ({
  pending: null as null | { sessionId: string; label: string; host?: string; helper?: boolean },
  clear: () => {},
}))
vi.mock('../../../src/renderer/stores/sshCloseStore', () => ({
  useSshCloseStore: (sel: (s: { pending: typeof ssh.pending; clear: () => void }) => unknown) => sel({ pending: ssh.pending, clear: ssh.clear }),
  endRemoteAndClose: async () => {},
  leaveRunningAndClose: () => {},
}))

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/hooks/useTypography', () => ({ useRegionTypography: () => ({}) }))

const { default: SshCloseDialog } = await import('../../../src/renderer/components/SshCloseDialog')
const { TransportBadge, PERSISTENT_TITLE } = await import('../../../src/renderer/components/sidebar/Badges')
const { default: SessionHeader } = await import('../../../src/renderer/components/SessionHeader')
import type { Session } from '../../../src/renderer/stores/sessionStore'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the close question', () => {
  it('for a kept tab names the helper and the Machines page, not tmux', () => {
    ssh.pending = { sessionId: 'kept-1', label: 'Pi', host: 'nick@pi.lan', helper: true }
    act(() => { root.render(<SshCloseDialog />) })
    const text = container.textContent ?? ''
    expect(text).toContain('kept by the session helper there')
    expect(container.querySelector('[data-testid="ssh-close-body"]')?.textContent).toContain('the Machines page lists it')
    expect(text).not.toContain('tmux')
  })
  it('for a tmux tab keeps its words', () => {
    ssh.pending = { sessionId: 'tmux-1', label: 'Pi', host: 'nick@pi.lan' }
    act(() => { root.render(<SshCloseDialog />) })
    expect(container.textContent).toContain('stop the remote tmux session')
    expect(container.textContent).not.toContain('session helper')
  })
})

describe('the persistence chip', () => {
  it('names the helper for a kept tab, and tmux for any other persistent one', () => {
    act(() => { root.render(<><TransportBadge kind="persistent" keeper="helper" /><TransportBadge kind="persistent" /></>) })
    const titles = [...container.querySelectorAll('[data-testid="ssh-persistent-badge"]')].map((b) => b.getAttribute('title'))
    expect(titles[0]).toContain('kept by the session helper on its machine until you end it')
    expect(titles[1]).toContain('tmux')
  })
})

describe("the header's connection pill", () => {
  const sshTab = (over: Partial<Session>): Session => ({
    id: 'kept-h', label: 'Pi', workingDirectory: '~/work', model: 'sonnet', color: '#ff0000', status: 'idle',
    createdAt: 0, sessionType: 'ssh', configId: 'cfg-pi', provider: 'claude',
    sshConfig: { host: 'pi.lan', port: 22, username: 'nick', remotePath: '~/work' },
    ...over,
  }) as Session
  const pill = () => container.querySelector('[data-testid="ssh-connection-pill"]')
  beforeEach(() => {
    // The header's auth pills read this on mount; answer it so it never errors.
    ;(globalThis as any).window.electronAPI = {
      accountWeb: { status: vi.fn(async () => ({ ok: true, cli: { authenticated: false }, web: { status: 'none' } })) },
    }
  })

  it("for a kept tab reads SSH-Persistent and carries the Saved badge's helper title, not tmux", () => {
    act(() => { root.render(<SessionHeader session={sshTab({ remoteVia: 'helper' })} />) })
    expect(pill()?.textContent).toContain('SSH-Persistent')
    expect(pill()?.textContent).toContain('nick@pi.lan')
    const title = pill()?.getAttribute('title') ?? ''
    expect(title).toContain('kept by the session helper on its machine until you end it')
    expect(title).toContain('a dropped connection or a quit reattaches')
    expect(title).toBe(PERSISTENT_TITLE.helper)
    expect(title).not.toContain('tmux')
    expect(title).not.toContain('ends it and')
    expect(container.querySelector('[data-testid="ssh-persistent-pill"]')).not.toBeNull()
  })

  it('for a tmux tab keeps the tmux title, and a plain SSH tab keeps SSH', () => {
    act(() => { root.render(<SessionHeader session={sshTab({ sshTmuxPersistent: true })} />) })
    expect(pill()?.textContent).toContain('SSH-Persistent')
    expect(pill()?.getAttribute('title')).toContain('runs inside tmux')
    expect(pill()?.getAttribute('title')).not.toContain('session helper')
    act(() => { root.render(<SessionHeader session={sshTab({})} />) })
    expect(pill()?.textContent).not.toContain('SSH-Persistent')
    expect(pill()?.getAttribute('title')).toContain('a dropped connection ends it')
  })
})
