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
 * A session id holds a set of handlers, not one: during a remount handover
 * the old and the new view of the same session can both be subscribed for a
 * moment, and each must get its own unsubscribe.
 */
import type { ElectronAPI } from '../types/electron'

type Handler<T> = (data: T) => void
type Unsubscribe = () => void

/** The bridge namespace of one channel, e.g. window.electronAPI.statusline. */
interface BridgeChannel<T> {
  onUpdate: (callback: (data: T) => void) => Unsubscribe | void
}

export interface SessionRouter<T> {
  /** Calls `handler` for every message tagged with `sessionId`. */
  subscribe(sessionId: string, handler: Handler<T>): Unsubscribe
}

export function createSessionRouter<T extends { sessionId: string }>(bridge: () => BridgeChannel<T>): SessionRouter<T> {
  const handlers = new Map<string, Set<Handler<T>>>()
  let bound: { onUpdate: BridgeChannel<T>['onUpdate']; release: Unsubscribe | void } | null = null

  const dispatch = (data: T): void => {
    const id = data !== null && typeof data === 'object' ? (data as { sessionId?: unknown }).sessionId : undefined
    if (typeof id !== 'string') return
    const mine = handlers.get(id)
    if (!mine) return
    // A copy: a handler may unsubscribe (or a remount subscribe) mid-delivery.
    for (const handler of [...mine]) handler(data)
  }

  const unbind = (): void => {
    const was = bound
    bound = null
    if (was && typeof was.release === 'function') was.release()
  }

  const ensureBound = (): void => {
    const channel = bridge()
    if (bound && bound.onUpdate === channel.onUpdate) return
    // In the app the bridge never changes, so this binds once. A test that
    // installs a fresh mock, or a dev hot reload, does change it: release the
    // old listener first, so there is never more than one.
    unbind()
    bound = { onUpdate: channel.onUpdate, release: channel.onUpdate(dispatch) }
  }

  return {
    subscribe(sessionId, handler) {
      ensureBound()
      let mine = handlers.get(sessionId)
      if (!mine) {
        mine = new Set()
        handlers.set(sessionId, mine)
      }
      mine.add(handler)
      let done = false
      return () => {
        if (done) return
        done = true
        const set = handlers.get(sessionId)
        if (!set) return
        set.delete(handler)
        if (set.size === 0) handlers.delete(sessionId)
        if (handlers.size === 0) unbind()
      }
    },
  }
}

type PayloadOf<C> = C extends { onUpdate: (callback: (data: infer D) => void) => unknown } ? D : never

export const statuslineRouter = createSessionRouter<PayloadOf<ElectronAPI['statusline']>>(() => window.electronAPI.statusline)
export const effortRouter = createSessionRouter<PayloadOf<ElectronAPI['effort']>>(() => window.electronAPI.effort)
export const watchdogRouter = createSessionRouter<PayloadOf<ElectronAPI['watchdog']>>(() => window.electronAPI.watchdog)
export const accountIdentityRouter = createSessionRouter<PayloadOf<ElectronAPI['accountIdentity']>>(() => window.electronAPI.accountIdentity)
