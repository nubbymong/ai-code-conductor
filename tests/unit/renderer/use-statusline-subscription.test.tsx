// @vitest-environment jsdom
// tests/unit/renderer/use-statusline-subscription.test.tsx
//
// Covers the graceful-fail effort gate (effortLive) and the live Fast Mode flag
// (fastMode) that the statusline subscription writes onto the session, and the
// "no reading" mark that a later reading clears (aicc_planning#292). Uses the
// same local renderHook shim as use-effort-subscription.test.tsx (this repo does
// not depend on @testing-library/react).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useStatuslineSubscription } from '../../../src/renderer/hooks/useStatuslineSubscription'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Every hook a test mounts is unmounted after it (aicc_planning#304): the
// hooks share one router per channel, which reads the bridge when it binds
// and releases it on the last unsubscribe. A hook left mounted would keep
// the previous test's mock bound.
const mounted = new Set<() => void>()
afterEach(() => { for (const unmount of [...mounted]) unmount() })

function renderHook<T>(hook: () => T) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const HookHost: React.FC = () => { hook(); return null }
  act(() => { root.render(<HookHost />) })
  const unmount = () => {
    if (!mounted.delete(unmount)) return
    act(() => { root.unmount() })
    container.remove()
  }
  mounted.add(unmount)
  return { unmount }
}

let cb: ((d: any) => void) | null = null
beforeEach(() => {
  cb = null
  ;(globalThis as any).window.electronAPI = { statusline: { onUpdate: (fn: any) => { cb = fn; return () => { cb = null } } } }
  useSessionStore.setState({
    sessions: [{ id: 's1', label: 'a', workingDirectory: '/', model: 'opus', color: '#fff', status: 'idle', createdAt: 0, sessionType: 'local' } as any],
    activeSessionId: 's1',
  })
})

describe('useStatuslineSubscription -- effort graceful-fail', () => {
  it('sets effortLevel AND effortLive on a live tick carrying effort', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', effortLevel: 'high' }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.effortLevel).toBe('high')
    expect(s.effortLive).toBe(true)
  })

  it('does not set effortLive when the tick carries no effort', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', contextUsedPercent: 20 }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.effortLive).toBeUndefined()
  })

  it('ignores ticks for other sessions', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's2', effortLevel: 'max' }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.effortLevel).toBeUndefined()
    expect(s.effortLive).toBeUndefined()
  })
})

describe('useStatuslineSubscription -- account identity (Phase 3 harmonise-remote)', () => {
  it('LOCAL sessions never take accountEmail/accountColour from a tick (v1.5.9 anti-clobber)', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', accountEmail: 'other@x.com', accountColour: 'mauve', contextUsedPercent: 10 }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.accountEmail).toBeUndefined()
    expect(s.accountColour).toBeUndefined()
    expect(s.contextPercent).toBe(10) // the rest of the tick still lands
  })

  it('SSH sessions DO take accountEmail/accountColour from their tunnel tick', () => {
    useSessionStore.setState({
      sessions: [{ id: 's1', label: 'a', workingDirectory: '/', model: 'opus', color: '#fff', status: 'idle', createdAt: 0, sessionType: 'ssh' } as any],
      activeSessionId: 's1',
    })
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', accountEmail: 'remote@x.com', accountColour: 'mauve' }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.accountEmail).toBe('remote@x.com')
    expect(s.accountColour).toBe('mauve')
  })

  it('an SSH tick without accountEmail leaves the stored identity untouched', () => {
    useSessionStore.setState({
      sessions: [{ id: 's1', label: 'a', workingDirectory: '/', model: 'opus', color: '#fff', status: 'idle', createdAt: 0, sessionType: 'ssh', accountEmail: 'kept@x.com' } as any],
      activeSessionId: 's1',
    })
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', contextUsedPercent: 30 }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.accountEmail).toBe('kept@x.com')
  })
})

// aicc_planning#292: the "no reading" mark (D3) is sent once, and readings can
// still arrive after it. A reading is what the strip's placeholder rule reads:
// a non-empty bucket list or a current rate limit figure.
describe('useStatuslineSubscription -- the "no reading" mark', () => {
  const bucket = { key: 'k/300:', label: '5h', group: 'session', percent: 40, resetsAt: '', severity: 'normal' }
  const mark = () => useSessionStore.getState().sessions[0].usageUnavailable

  it('the mark first, then a late bucket list: the mark is cleared', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', usageUnavailable: 'no-reading' }) })
    expect(mark()).toBe('no-reading')
    act(() => { cb!({ sessionId: 's1', usageBuckets: [bucket] }) })
    expect(mark()).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].usageBuckets).toEqual([bucket])
  })

  it('the mark first, then a late current rate limit figure: the mark is cleared', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', usageUnavailable: 'no-reading' }) })
    act(() => { cb!({ sessionId: 's1', rateLimitCurrent: 0 }) })
    expect(mark()).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].rateLimitCurrent).toBe(0)
  })

  it('the mark and no readings: it stays (an empty bucket list, a weekly figure alone, other fields)', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', usageUnavailable: 'no-reading' }) })
    act(() => { cb!({ sessionId: 's1', usageBuckets: [] }) })
    act(() => { cb!({ sessionId: 's1', rateLimitWeekly: 12, contextUsedPercent: 30 }) })
    expect(mark()).toBe('no-reading')
  })

  it('one update carrying both the mark and a reading leaves no mark', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', usageUnavailable: 'no-reading', usageBuckets: [bucket] }) })
    expect(mark()).toBeUndefined()
  })
})

describe('useStatuslineSubscription -- fast mode', () => {
  it('sets fastMode:true when the live tick reports fast_mode on', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', fastMode: true }) })
    expect(useSessionStore.getState().sessions[0].fastMode).toBe(true)
  })

  it('clears fastMode to false when toggled off (copies false, not just true)', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', fastMode: true }) })
    act(() => { cb!({ sessionId: 's1', fastMode: false }) })
    expect(useSessionStore.getState().sessions[0].fastMode).toBe(false)
  })

  it('leaves fastMode untouched when the tick omits fast_mode', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', fastMode: true }) })
    act(() => { cb!({ sessionId: 's1', contextUsedPercent: 50 }) })
    expect(useSessionStore.getState().sessions[0].fastMode).toBe(true)
  })
})

// 2.1.3-beta.19 section 3 (aicc_planning#434): a tab through the session
// helper. Main says why it names no account, or shows no per-model bars; the
// store keeps exactly one of the label and the reason, each start setting it
// again, and bars that arrive clear the usage reason.
describe('useStatuslineSubscription -- a helper tab\'s account and usage reasons', () => {
  const helperTab = () => useSessionStore.setState({
    sessions: [{ id: 's1', label: 'a', workingDirectory: '/', model: 'opus', color: '#fff', status: 'idle', createdAt: 0, sessionType: 'ssh' } as any],
    activeSessionId: 's1',
  })
  const s1 = () => useSessionStore.getState().sessions[0]
  const fable = { key: 'weekly:Fable', label: 'Fable', group: 'weekly', percent: 63, resetsAt: '', severity: 'normal' }

  it('a start that named no account: the reason, and an earlier start\'s label goes', () => {
    helperTab()
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', accountEmail: 'me@example.com' }) })
    expect(s1().accountEmail).toBe('me@example.com')
    act(() => { cb!({ sessionId: 's1', remoteAccountNotShown: 'no-account' }) })
    expect(s1().remoteAccountNotShown).toBe('no-account')
    expect(s1().accountEmail).toBeUndefined()
    // The next start named one: the label, and the reason goes.
    act(() => { cb!({ sessionId: 's1', accountEmail: 'other@example.com' }) })
    expect(s1().accountEmail).toBe('other@example.com')
    expect(s1().remoteAccountNotShown).toBeUndefined()
  })

  it('the usage reason is kept until bars arrive, and a tick without either leaves it', () => {
    helperTab()
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', remoteUsageNotShown: 'own-sign-in', usageBuckets: [] }) })
    expect(s1().remoteUsageNotShown).toBe('own-sign-in')
    expect(s1().usageBuckets).toEqual([])
    act(() => { cb!({ sessionId: 's1', rateLimitCurrent: 30 }) })
    expect(s1().remoteUsageNotShown).toBe('own-sign-in')
    act(() => { cb!({ sessionId: 's1', usageBuckets: [fable] }) })
    expect(s1().remoteUsageNotShown).toBeUndefined()
    expect(s1().usageBuckets).toEqual([fable])
  })

  it('a local session takes no account reason', () => {
    renderHook(() => useStatuslineSubscription('s1'))
    act(() => { cb!({ sessionId: 's1', remoteAccountNotShown: 'not-read' }) })
    expect(s1().remoteAccountNotShown).toBeUndefined()
  })
})
