import { create } from 'zustand'
import type { LedgerRecord } from '../../shared/channel-types'
import { useSessionStore } from './sessionStore'
import { usePaneOcclusionStore } from './paneOcclusionStore'

interface ChannelState {
  ledger: LedgerRecord[]
  pushLedger: (r: LedgerRecord) => void
}
export const useChannelStore = create<ChannelState>((set) => ({
  ledger: [],
  pushLedger: (r) => set((s) => ({ ledger: [r, ...s.ledger].slice(0, 100) })),
}))

// P2.3: module-local unsub so setupChannelListeners is idempotent — a repeated
// call (StrictMode double-invoke / remount) returns the existing teardown
// instead of installing duplicate ledger/attention listeners.
let channelUnsub: (() => void) | null = null

// Wire IPC subscriptions once at app start (called from App.tsx postConfigInit).
export function setupChannelListeners(): () => void {
  if (channelUnsub) return channelUnsub
  const offL = window.electronAPI.channels.onLedgerEvent((r) => useChannelStore.getState().pushLedger(r as LedgerRecord))
  const offA = window.electronAPI.channels.onAttention(({ sessionId, needsAttention }) => {
    const ss = useSessionStore.getState()
    // Don't raise on the session you're already looking at; clears always apply.
    // 2.1.3-beta.19 text smoke (#41): the last session looked at is not looked
    // at while a page tab (Machines, Settings, ...) is in front of it.
    if (needsAttention && ss.activeSessionId === sessionId && usePaneOcclusionStore.getState().activeView === 'sessions') return
    ss.updateSession(sessionId, { needsAttention })
  })
  // Handshake so main knows the renderer's channel listeners are mounted.
  void window.electronAPI.channels.rendererReady()
  channelUnsub = () => { offL(); offA() }
  return channelUnsub
}
