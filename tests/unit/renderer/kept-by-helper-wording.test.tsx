// @vitest-environment jsdom
/**
 * The words a tab kept by the session helper gets (plan 2.1.3-beta.19 section
 * 1.2): the close question and the persistence chip name the helper, not
 * tmux; a tmux tab's keep their words.
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

const { default: SshCloseDialog } = await import('../../../src/renderer/components/SshCloseDialog')
const { TransportBadge } = await import('../../../src/renderer/components/sidebar/Badges')

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
    act(() => { root.render(<><TransportBadge kind="persistent" helper /><TransportBadge kind="persistent" /></>) })
    const titles = [...container.querySelectorAll('[data-testid="ssh-persistent-badge"]')].map((b) => b.getAttribute('title'))
    expect(titles[0]).toContain('kept by the session helper on its machine until you end it')
    expect(titles[1]).toContain('tmux')
  })
})
