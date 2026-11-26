import { useSessionStore } from '../stores/sessionStore'
import { persistSessionState } from '../session-persistence'

/**
 * 2.1.3-beta.19 section 1.2: main said this SSH tab's session is kept by the
 * session helper on machine `did` until it is ended (its flow state's `kept`,
 * at the start that went through the helper). The tab is marked at once, and
 * the saved set written now, so a crash keeps the mark: a marked tab never
 * starts on the usual SSH path. A tab that is not SSH, or is marked so
 * already, is left as it is.
 */
export function markKeptByHelper(sessionId: string, did: string): void {
  if (!/^[0-9a-f]{32}$/.test(did)) return
  const store = useSessionStore.getState()
  const s = store.sessions.find((x) => x.id === sessionId)
  if (!s || s.sessionType !== 'ssh') return
  if (s.remoteVia === 'helper' && s.remoteDid === did) return
  store.updateSession(sessionId, { remoteVia: 'helper', remoteDid: did })
  void persistSessionState()
}
