// @vitest-environment jsdom
// aicc_planning#304 (beta.7 B2): the four per-session broadcast channels
// (statusline, effort, watchdog, account identity) are listened to once for
// all sessions. Each TerminalView used to add its own preload listener, so
// with N sessions open every message crossed the context bridge N times.
//
// The bridge mock below models ipcRenderer.on: every live listener on a
// channel is called for every message on it, and `emit` returns how many
// listeners that was (one context-bridge crossing each).
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useStatuslineSubscription } from '../../../src/renderer/hooks/useStatuslineSubscription'
import { useEffortSubscription } from '../../../src/renderer/hooks/useEffortSubscription'
import { useWatchdogSubscription } from '../../../src/renderer/hooks/useWatchdogSubscription'
import { useAccountIdentitySubscription } from '../../../src/renderer/hooks/useAccountIdentitySubscription'
import { useSessionStore, type Session } from '../../../src/renderer/stores/sessionStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CHANNELS = ['statusline', 'effort', 'watchdog', 'accountIdentity'] as const
type Channel = typeof CHANNELS[number]
type Cb = (data: unknown) => void

function fakeBridge() {
  const live: Record<Channel, Set<Cb>> = {
    statusline: new Set(), effort: new Set(), watchdog: new Set(), accountIdentity: new Set(),
  }
  /** Every onUpdate call ever made, live or since released. */
  const added: Record<Channel, number> = { statusline: 0, effort: 0, watchdog: 0, accountIdentity: 0 }
  // Like preload's onChannel: each call registers its own wrapper, so the same
  // callback subscribed twice is two listeners, not one.
  const ns = (name: Channel) => ({
    onUpdate: (cb: Cb) => {
      added[name]++
      const listener: Cb = (d) => cb(d)
      live[name].add(listener)
      return () => { live[name].delete(listener) }
    },
  })
  const api = {
    statusline: ns('statusline'),
    effort: ns('effort'),
    watchdog: { ...ns('watchdog'), getStates: async () => [] },
    accountIdentity: { ...ns('accountIdentity'), get: async () => null },
  }
  const emit = (name: Channel, payload: unknown): number => {
    const listeners = [...live[name]]
    act(() => { for (const cb of listeners) cb(payload) })
    return listeners.length
  }
  const counts = () => Object.fromEntries(CHANNELS.map((c) => [c, live[c].size]))
  return { api, live, added, emit, counts }
}

function Host({ id }: { id: string }) {
  useStatuslineSubscription(id)
  useEffortSubscription(id)
  useWatchdogSubscription(id)
  useAccountIdentitySubscription(id)
  return null
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)
const hosts = (list: string[]) => React.createElement(React.Fragment, null, list.map((id) => React.createElement(Host, { id, key: id })))
const session = (id: string) => useSessionStore.getState().sessions.find((s) => s.id === id)!
const one = { statusline: 1, effort: 1, watchdog: 1, accountIdentity: 1 }
const none = { statusline: 0, effort: 0, watchdog: 0, accountIdentity: 0 }

let bridge: ReturnType<typeof fakeBridge>
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  bridge = fakeBridge()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = bridge.api
  useSessionStore.setState({
    sessions: ids(25).map((id) => ({ id, label: id, workingDirectory: '/', model: 'opus', color: '#fff', status: 'working', createdAt: 0, sessionType: 'local' }) as Session),
    activeSessionId: 's0',
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('session broadcast router: one listener per channel for all sessions', () => {
  it('mounting 25 sessions registers exactly one preload listener per channel', () => {
    act(() => { root.render(hosts(ids(25))) })
    expect(bridge.counts()).toEqual(one)
    // One message, one crossing (it was 25).
    expect(bridge.emit('statusline', { sessionId: 's7', contextUsedPercent: 33 })).toBe(1)
  })

  it('a tick for one session reaches only that session', () => {
    act(() => { root.render(hosts(ids(25))) })
    bridge.emit('statusline', { sessionId: 's7', contextUsedPercent: 33 })
    bridge.emit('effort', { sessionId: 's3', effortLevel: 'high' })
    bridge.emit('watchdog', { sessionId: 's5', armed: true, status: 'monitoring', waitUntil: null, gaveUp: false, checks: { rateLimit: true, overload: true, safeguard: true } })
    bridge.emit('accountIdentity', { sessionId: 's9', email: 'a@x.com', colourKey: 'mauve' })
    for (const id of ids(25)) {
      const s = session(id)
      expect(s.contextPercent, id).toBe(id === 's7' ? 33 : undefined)
      expect(s.effortLevel, id).toBe(id === 's3' ? 'high' : undefined)
      expect(s.watchdog?.status, id).toBe(id === 's5' ? 'monitoring' : undefined)
      expect(s.accountEmail, id).toBe(id === 's9' ? 'a@x.com' : undefined)
    }
  })

  it('the last unmount removes the listener, and a later mount adds one back', () => {
    act(() => { root.render(hosts(['s0', 's1', 's2'])) })
    act(() => { root.render(hosts(['s0'])) })
    expect(bridge.counts()).toEqual(one)
    act(() => { root.render(hosts([])) })
    expect(bridge.counts()).toEqual(none)
    act(() => { root.render(hosts(['s4'])) })
    expect(bridge.counts()).toEqual(one)
    bridge.emit('statusline', { sessionId: 's4', contextUsedPercent: 12 })
    expect(session('s4').contextPercent).toBe(12)
  })

  it('StrictMode double mount leaves one listener per channel', () => {
    // One session first: its StrictMode unmount is the last one, so the
    // channel is released and bound again.
    act(() => { root.render(React.createElement(React.StrictMode, null, hosts(['s2']))) })
    // The double mount really happened: bound, released, bound again.
    expect(bridge.added.statusline).toBe(2)
    expect(bridge.counts()).toEqual(one)
    bridge.emit('statusline', { sessionId: 's2', contextUsedPercent: 70 })
    expect(session('s2').contextPercent).toBe(70)
    act(() => { root.render(React.createElement(React.StrictMode, null, hosts(ids(5)))) })
    expect(bridge.counts()).toEqual(one)
  })

  it('a payload with an unknown session id is dropped', () => {
    act(() => { root.render(hosts(ids(3))) })
    const before = useSessionStore.getState().sessions
    bridge.emit('statusline', { sessionId: 'ghost', contextUsedPercent: 50 })
    bridge.emit('statusline', { contextUsedPercent: 50 })
    bridge.emit('effort', { sessionId: 'ghost', effortLevel: 'max' })
    bridge.emit('accountIdentity', { sessionId: 's24', email: 'late@x.com', colourKey: 'red' }) // s24 is not mounted
    expect(useSessionStore.getState().sessions).toBe(before)
  })
})

describe('createSessionRouter', () => {
  const routerModule = () => import('../../../src/renderer/lib/sessionBroadcastRouter')

  function source() {
    const live = new Set<Cb>()
    const onUpdate = (cb: Cb) => {
      const listener: Cb = (d) => cb(d)
      live.add(listener)
      return () => { live.delete(listener) }
    }
    return { live, ns: { onUpdate } }
  }

  it('delivers to the handlers of the message\'s own session only, over one bridge listener', async () => {
    const { createSessionRouter } = await routerModule()
    const src = source()
    const router = createSessionRouter<{ sessionId: string; n: number }>(() => src.ns)
    const got: string[] = []
    const offA = router.subscribe('a', (d) => got.push(`a:${d.n}`))
    const offA2 = router.subscribe('a', (d) => got.push(`a2:${d.n}`))
    const offB = router.subscribe('b', (d) => got.push(`b:${d.n}`))
    expect(src.live.size).toBe(1)
    for (const cb of src.live) cb({ sessionId: 'a', n: 1 })
    for (const cb of src.live) cb({ sessionId: 'zzz', n: 2 })
    for (const cb of src.live) cb(null)
    expect(got).toEqual(['a:1', 'a2:1'])
    offA(); offA() // a second call is harmless
    offA2()
    expect(src.live.size).toBe(1)
    offB()
    expect(src.live.size).toBe(0)
  })

  it('a replaced bridge (a hot reload, or a test\'s fresh mock) is bound instead of the old one, never beside it', async () => {
    const { createSessionRouter } = await routerModule()
    const first = source()
    const second = source()
    let current = first
    const router = createSessionRouter<{ sessionId: string }>(() => current.ns)
    const got: string[] = []
    router.subscribe('a', () => got.push('a'))
    current = second
    const offB = router.subscribe('b', () => got.push('b'))
    expect(first.live.size).toBe(0)
    expect(second.live.size).toBe(1)
    for (const cb of second.live) cb({ sessionId: 'a' })
    expect(got).toEqual(['a'])
    offB()
  })
})
