/**
 * aicc_planning#304 (beta.7 B2): one preload listener per session broadcast
 * channel, shared by every session.
 *
 * Main pushes statusline, effort, watchdog and account-identity updates on
 * one channel each, tagged with the session id. Each TerminalView used to add
 * its own listener, so with N sessions open every message crossed the context
 * bridge N times and N-1 of those handlers threw it away. Here the first
 * subscriber binds the channel once and each message goes only to the
 * handlers of its own session; a message whose session has no handler is
 * dropped. The last unsubscribe releases the channel, so a StrictMode mount,
 * unmount and mount, or any remount, ends with exactly one listener.
 *
 * Every subscription is its own entry, even for the same handler function:
 * during a remount handover the old and the new view of a session can both be
 * subscribed for a moment, and each unsubscribe removes only its own entry.
 */
import type { ElectronAPI } from '../types/electron'

type Handler<T> = (data: T) => void
type Unsubscribe = () => void

/** The release of a channel that is not bound: there is nothing to release. */
const NOT_BOUND: Unsubscribe = () => {}

/** The bridge namespace of one channel, e.g. window.electronAPI.statusline. */
interface BridgeChannel<T> {
  onUpdate: (callback: (data: T) => void) => Unsubscribe
}

export interface SessionRouter<T> {
  /** Calls `handler` for every message tagged with `sessionId`. */
  subscribe(sessionId: string, handler: Handler<T>): Unsubscribe
}

export function createSessionRouter<T extends { sessionId: string }>(bridge: () => BridgeChannel<T>): SessionRouter<T> {
  const handlers = new Map<string, Set<Handler<T>>>()
  /** Releases the bridge listener; NOT_BOUND while the channel is not bound. */
  let release: Unsubscribe = NOT_BOUND

  const dispatch = (data: T): void => {
    const id = data !== null && typeof data === 'object' ? (data as { sessionId?: unknown }).sessionId : undefined
    if (typeof id !== 'string') return
    const mine = handlers.get(id)
    if (!mine) return
    // A copy: a handler may unsubscribe (or a remount subscribe) mid-delivery.
    for (const entry of [...mine]) entry(data)
  }

  return {
    subscribe(sessionId, handler) {
      // The bridge is read when the channel is bound: on the first subscribe,
      // and on the first one after the channel was released. In the app
      // window.electronAPI never changes; a test that installs a fresh mock
      // gets it bound once its earlier hooks have unmounted.
      if (release === NOT_BOUND) release = bridge().onUpdate(dispatch)
      let mine = handlers.get(sessionId)
      if (!mine) {
        mine = new Set()
        handlers.set(sessionId, mine)
      }
      const entry: Handler<T> = (data) => handler(data)
      mine.add(entry)
      return () => {
        const set = handlers.get(sessionId)
        // Already unsubscribed, and the session has no entries left.
        if (!set) return
        // A no-op when already unsubscribed: the entry is this call's own.
        set.delete(entry)
        if (set.size > 0) return
        handlers.delete(sessionId)
        if (handlers.size > 0) return
        const was = release
        release = NOT_BOUND
        was()
      }
    },
  }
}

type PayloadOf<C> = C extends { onUpdate: (callback: (data: infer D) => void) => unknown } ? D : never

export const statuslineRouter = createSessionRouter<PayloadOf<ElectronAPI['statusline']>>(() => window.electronAPI.statusline)
export const effortRouter = createSessionRouter<PayloadOf<ElectronAPI['effort']>>(() => window.electronAPI.effort)
export const watchdogRouter = createSessionRouter<PayloadOf<ElectronAPI['watchdog']>>(() => window.electronAPI.watchdog)
export const accountIdentityRouter = createSessionRouter<PayloadOf<ElectronAPI['accountIdentity']>>(() => window.electronAPI.accountIdentity)
