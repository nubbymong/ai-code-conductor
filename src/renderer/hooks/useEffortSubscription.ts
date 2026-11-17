// src/renderer/hooks/useEffortSubscription.ts
import { useEffect } from 'react'
import { useSessionStore, type Session } from '../stores/sessionStore'
import { effortRouter } from '../lib/sessionBroadcastRouter'

const VALID: ReadonlyArray<NonNullable<Session['effortLevel']>> = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']

/**
 * Subscribe to live reasoning-effort updates pushed from the hooks gateway.
 * Updates session.effortLevel so the status strip shows the REAL effort even
 * when it was set globally in ~/.claude/settings.json (not through CCC).
 */
export function useEffortSubscription(sessionId: string) {
  const updateSession = useSessionStore((s) => s.updateSession)
  useEffect(() => {
    const unsub = effortRouter.subscribe(sessionId, ({ effortLevel }) => {
      if (!VALID.includes(effortLevel as NonNullable<Session['effortLevel']>)) return
      // effortLive: this is a live hooks tick, so the card may now show the pill.
      updateSession(sessionId, { effortLevel: effortLevel as Session['effortLevel'], effortLive: true })
    })
    return unsub
  }, [sessionId, updateSession])
}
