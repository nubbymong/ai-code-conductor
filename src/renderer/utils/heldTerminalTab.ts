// The Machines page's Re-attach (2.1.3-beta.6, plan section B): the session
// helper names the tab that shows a held terminal. An open tab is brought
// forward (its partner terminal, for a partner); a held terminal no tab shows
// gets a new Terminal only tab with the id the helper bound it to, and that
// tab's terminal, when it starts, shows the held one instead of a new shell.
import { REATTACH_TAB_ID, type MachineActionResult } from '../../shared/machines'
import { goToSession } from '../lib/goToSession'
import { useSessionStore } from '../stores/sessionStore'

/** Show the tab a Re-attach named. False when the answer names no usable tab. */
export function showHeldTerminalTab(tab: MachineActionResult['tab']): boolean {
  if (tab === undefined) return true
  if (!tab || typeof tab.id !== 'string' || !REATTACH_TAB_ID.test(tab.id)) return false
  const store = useSessionStore.getState()
  const exists = store.sessions.some((s) => s.id === tab.id)
  if (tab.open && !exists) {
    store.addSession({
      id: tab.id,
      label: typeof tab.label === 'string' && tab.label ? tab.label.slice(0, 120) : 'Terminal',
      workingDirectory: '',
      model: '',
      // The standard default colour for sessions the app makes itself.
      color: '#89B4FA',
      status: 'idle',
      createdAt: Date.now(),
      sessionType: 'local',
      shellOnly: true,
      // The stored shape of a terminal-only session (see SessionDialog).
      provider: 'claude',
    })
  } else if (!exists) {
    return false
  }
  goToSession(tab.id, { partner: tab.partner === true && !tab.open })
  return true
}
