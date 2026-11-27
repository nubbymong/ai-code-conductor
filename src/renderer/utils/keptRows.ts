import type { DetachedRemote } from '../../shared/types'
import type { RemoteKeptSession } from '../../shared/remote-machines'
import type { TerminalConfig } from '../stores/configStore'
import { pairDetachedEntry } from './detachedRemotes'

/** One kept session's row on its machine's card (2.1.3-beta.19 section 1.2):
 *  its name, whether a tab is open on it, and the saved config Re-attach opens
 *  it through (none: End only). */
export interface KeptRow {
  session: RemoteKeptSession
  label: string
  /** A tab of this app is open on it now: never Re-attach here; End here only
   *  while that tab is not attached to it (one attached is ended from its tab). */
  open: boolean
  config: TerminalConfig | undefined
}

/** The rows for a machine's listed sessions: a left-running entry names the
 *  session and pairs it with its config; a tab of this app open on it marks it open. */
export function keptRows(sessions: readonly RemoteKeptSession[], entries: readonly DetachedRemote[], configs: TerminalConfig[], openIds: ReadonlySet<string>, openLabels: ReadonlyMap<string, string>): KeptRow[] {
  return sessions.map((s) => {
    const id = s.appSessionId
    const entry = id ? entries.find((e) => e.sessionId === id) : undefined
    const pairing = entry ? pairDetachedEntry(entry, configs) : undefined
    const open = !!id && openIds.has(id)
    const label = (id && openLabels.get(id)) || entry?.label || (id ? `Session ${id.slice(0, 8)}` : 'A session')
    return { session: s, label, open, config: pairing?.kind === 'paired' ? pairing.config : undefined }
  })
}
