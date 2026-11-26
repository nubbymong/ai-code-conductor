// @vitest-environment jsdom
/**
 * 2.1.3-beta.19 text smoke (#41), an outside finding: with the Machines page
 * in front, the helper tab asked a tool question; main sent needsAttention for
 * it at 11:22:48.716Z, and for the 25 s watched its tab button's
 * data-attention stayed null and its session card showed nothing. The raise
 * was dropped because the session was the last one looked at
 * (channelStore.ts: `ss.activeSessionId === sessionId`), also while a page tab
 * hid it. A session is looked at only while the sessions view is in front:
 * the raise for it now marks its tab and its card while a page is in front
 * (TabBar.tsx already read the view), and going back to its tab clears it
 * (useActiveTabEffect, as before).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { useSessionStore, type Session } from '../../../src/renderer/stores/sessionStore'
import { usePaneOcclusionStore } from '../../../src/renderer/stores/paneOcclusionStore'
import { useActiveTabEffect } from '../../../src/renderer/hooks/useActiveTabEffect'

let raise: ((p: { sessionId: string; needsAttention: boolean }) => void) | null = null
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  channels: {
    onLedgerEvent: () => () => {},
    rendererReady: async () => undefined,
    onAttention: (cb: (p: { sessionId: string; needsAttention: boolean }) => void) => { raise = cb; return () => {} },
  },
}
const { setupChannelListeners } = await import('../../../src/renderer/stores/channelStore')

const session = (id: string): Session => ({ id, label: id, workingDirectory: '/w', color: '#ff0000', status: 'idle', createdAt: 0, sessionType: 'ssh', configId: 'c' } as Session)
const attention = (id: string) => useSessionStore.getState().sessions.find((s) => s.id === id)?.needsAttention === true

// Set up once: setupChannelListeners is idempotent for the renderer's life.
beforeEach(() => {
  useSessionStore.setState({ sessions: [session('s1'), session('s2')], activeSessionId: 's1' } as never)
  usePaneOcclusionStore.getState().setActiveView('sessions')
  setupChannelListeners()
})
afterEach(() => {
  usePaneOcclusionStore.getState().setActiveView('sessions')
})

describe('a raise for the session last looked at, while a page tab is in front (text smoke #41)', () => {
  it('marks it while the Machines page is in front; it is not raised while its own tab is in front', () => {
    usePaneOcclusionStore.getState().setActiveView('machines')
    act(() => { raise!({ sessionId: 's1', needsAttention: true }) })
    expect(attention('s1')).toBe(true)
    // A clear always applies.
    act(() => { raise!({ sessionId: 's1', needsAttention: false }) })
    expect(attention('s1')).toBe(false)
    // Its own tab in front: the user is looking at it, so it is not raised.
    usePaneOcclusionStore.getState().setActiveView('sessions')
    act(() => { raise!({ sessionId: 's1', needsAttention: true }) })
    expect(attention('s1')).toBe(false)
    // Another session is raised either way.
    act(() => { raise!({ sessionId: 's2', needsAttention: true }) })
    expect(attention('s2')).toBe(true)
  })

  it('going back to its tab clears it (the terminal view\'s activation, as before)', () => {
    usePaneOcclusionStore.getState().setActiveView('settings')
    act(() => { raise!({ sessionId: 's1', needsAttention: true }) })
    expect(attention('s1')).toBe(true)
    function View({ active }: { active: boolean }) {
      const term = React.useRef(null)
      const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
      const acked = React.useRef(false)
      useActiveTabEffect('s1', active, term, timer, acked)
      return null
    }
    const host = document.createElement('div')
    const root: Root = createRoot(host)
    act(() => { root.render(<View active={false} />) })
    expect(attention('s1')).toBe(true)
    usePaneOcclusionStore.getState().setActiveView('sessions')
    act(() => { root.render(<View active />) })
    expect(attention('s1')).toBe(false)
    act(() => { root.unmount() })
  })

  it('its tab and its card read the same rule: marked unless it is the active session with the sessions view in front', () => {
    const src = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
    expect(src('src/renderer/components/TabBar.tsx')).toContain("const needsAttention = session.needsAttention && !(activeSessionId === session.id && activeView === 'sessions')")
    expect(src('src/renderer/components/Sidebar.tsx')).toContain("needsAttention={!!session.needsAttention && !(activeSessionId === session.id && currentView === 'sessions')}")
  })
})
