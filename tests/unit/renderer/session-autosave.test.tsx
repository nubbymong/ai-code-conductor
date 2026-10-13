// @vitest-environment jsdom
// Local renderHook shim (this repo doesn't depend on @testing-library/react —
// see use-effort-subscription.test.tsx for the same pattern).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useSessionAutosave } from '../../../src/renderer/hooks/useSessionAutosave'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import type { Session } from '../../../src/renderer/stores/sessionStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function renderHook<T>(hook: () => T): { unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const HookHost: React.FC = () => {
    hook()
    return null
  }
  act(() => {
    root.render(<HookHost />)
  })
  return {
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

function makeSession(id: string): Session {
  // Minimal shape; buildSessionState only reads a subset and tolerates undefined.
  return { id, label: id, sessionType: 'local' } as unknown as Session
}

describe('useSessionAutosave', () => {
  let save: ReturnType<typeof vi.fn>
  let handle: { unmount: () => void } | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    save = vi.fn().mockResolvedValue(true)
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { session: { save } }
    // Reset BEFORE mounting so the reset doesn't trip the (not-yet-active) subscription.
    useSessionStore.setState({ sessions: [], activeSessionId: null })
    handle = renderHook(() => useSessionAutosave())
  })

  afterEach(() => {
    handle?.unmount()
    handle = null
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('debounce-flushes the live session set when sessions are opened', () => {
    useSessionStore.getState().addSession(makeSession('a'))
    useSessionStore.getState().addSession(makeSession('b'))
    expect(save).not.toHaveBeenCalled() // coalesced by the debounce
    vi.advanceTimersByTime(1000)

    expect(save).toHaveBeenCalledTimes(1)
    const state = save.mock.calls.at(-1)![0]
    expect(state.sessions.map((s: { id: string }) => s.id)).toEqual(['a', 'b'])
  })

  it('persists an EMPTY set when all sessions are closed (the resume-phantom fix)', () => {
    useSessionStore.getState().addSession(makeSession('a'))
    useSessionStore.getState().addSession(makeSession('b'))
    vi.advanceTimersByTime(1000)
    save.mockClear()

    useSessionStore.getState().removeSession('a')
    useSessionStore.getState().removeSession('b')
    vi.advanceTimersByTime(1000)

    expect(save).toHaveBeenCalledTimes(1)
    const state = save.mock.calls.at(-1)![0]
    expect(state.sessions).toEqual([]) // -> next launch offers nothing to resume
  })

  it('does not flush on session metadata churn (same sessions array)', () => {
    useSessionStore.getState().addSession(makeSession('a'))
    vi.advanceTimersByTime(1000)
    save.mockClear()

    useSessionStore.getState().setActiveSession('a') // replaces activeSessionId only
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()
  })

  it('does NOT flush on a per-session telemetry tick (structural key unchanged)', () => {
    useSessionStore.getState().addSession(makeSession('a'))
    vi.advanceTimersByTime(1000)
    save.mockClear()

    // A statusline tick replaces the sessions array but not the session SET.
    // The hook keys on session ids, so this must not (re)arm the autosave timer.
    useSessionStore.getState().updateSession('a', { contextPercent: 77 })
    useSessionStore.getState().updateSession('a', { contextPercent: 78 })
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()
  })

  it('does not let sustained telemetry ticks starve a real add/remove flush', () => {
    useSessionStore.getState().addSession(makeSession('a'))
    vi.advanceTimersByTime(1000)
    save.mockClear()

    // A real structural change arms the timer...
    useSessionStore.getState().addSession(makeSession('b'))
    // ...and telemetry churn that follows must NOT keep resetting it.
    for (let i = 0; i < 5; i++) {
      useSessionStore.getState().updateSession('a', { contextPercent: i })
      vi.advanceTimersByTime(300)
    }
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)
    const state = save.mock.calls.at(-1)![0]
    expect(state.sessions.map((s: { id: string }) => s.id)).toEqual(['a', 'b'])
  })

  // The in-session /login "Add" (App's NewAccountPrompt) pins the new
  // account with a bare updateSession, which changes no session id. It used to
  // live only in memory until some later add/remove, so a crash resumed the
  // session on its OLD account. An account pin is now saved at once.
  it('saves at once, and once, when a session is pinned to another account (profileId)', () => {
    useSessionStore.getState().addSession(makeSession('a'))
    vi.advanceTimersByTime(1000)
    save.mockClear()

    useSessionStore.getState().updateSession('a', { profileId: 'profile-new' })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls.at(-1)![0].sessions[0].profileId).toBe('profile-new')
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  // buildSessionState writes the registry account id for a Codex session only,
  // so the case is a Codex tab: the pin has to reach the written state.
  it('saves at once when a Codex session is pinned to another registry account (providerAccountId)', () => {
    useSessionStore.getState().addSession({ ...makeSession('r'), provider: 'codex', providerAccountId: 'acc-1' } as Session)
    vi.advanceTimersByTime(1000)
    save.mockClear()

    useSessionStore.getState().updateSession('r', { providerAccountId: 'acc-2' })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls.at(-1)![0].sessions[0].providerAccountId).toBe('acc-2')
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  // The pin save runs inside the store's listener, during the caller's
  // updateSession. A throw there would escape the listener loop (skipping the
  // listeners after it) and reach the caller (App's /login Add would then skip
  // clearing its prompt); a rejected save would go unhandled.
  it('an account pin save that throws or rejects never reaches the caller', async () => {
    useSessionStore.getState().addSession(makeSession('a'))
    vi.advanceTimersByTime(1000)
    save.mockClear()
    save.mockImplementationOnce(() => { throw new Error('preload gone') })
    expect(() => useSessionStore.getState().updateSession('a', { profileId: 'profile-x' })).not.toThrow()
    expect(useSessionStore.getState().sessions[0].profileId).toBe('profile-x')
    // Real timers from here: an unhandled rejection is reported after a macrotask.
    vi.useRealTimers()
    const unhandled = vi.fn()
    // Node's process, typed here only as far as the case uses it (the web tsconfig has no Node types).
    const proc = (globalThis as unknown as { process: { on(e: string, f: () => void): void; off(e: string, f: () => void): void } }).process
    proc.on('unhandledRejection', unhandled)
    try {
      save.mockRejectedValueOnce(new Error('ipc closed'))
      expect(() => useSessionStore.getState().updateSession('a', { profileId: 'profile-y' })).not.toThrow()
      expect(save).toHaveBeenCalledTimes(2)
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      proc.off('unhandledRejection', unhandled)
    }
  })

  it('an account pin while an add is still waiting saves now, and the waiting save does not run again', () => {
    useSessionStore.getState().addSession(makeSession('a'))
    useSessionStore.getState().updateSession('a', { profileId: 'profile-new' })
    expect(save).toHaveBeenCalledTimes(1)
    const state = save.mock.calls.at(-1)![0]
    expect(state.sessions.map((s: { id: string; profileId?: string }) => [s.id, s.profileId])).toEqual([['a', 'profile-new']])
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('telemetry after an account pin does not save again', () => {
    useSessionStore.getState().addSession(makeSession('a'))
    vi.advanceTimersByTime(1000)
    useSessionStore.getState().updateSession('a', { profileId: 'profile-new' })
    save.mockClear()

    useSessionStore.getState().updateSession('a', { contextPercent: 12 })
    useSessionStore.getState().updateSession('a', { accountEmail: 'someone@example.com' })
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()
  })
})
