import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { HooksGatewayLike } from '../hooks'
import type { HooksToggleRequest, HooksGetBufferRequest, HooksGatewayStatus } from '../../shared/hook-types'
import { getActivePtySessionIds } from '../pty-manager'
import { removeHooks } from '../hooks/session-hooks-writer'
import { getLocalSessionSettingsPath } from '../hooks/per-session-settings'
import { hookFeedBuffer, setHelperHooksTaken } from '../session-signals'

function broadcastStatus(status: HooksGatewayStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try { w.webContents.send(IPC.HOOKS_STATUS, status) } catch { /* destroyed */ }
    }
  }
}

export function registerHooksHandlers(gateway: HooksGatewayLike): void {
  // The hook events a session's holder passes on (2.1.3-beta.8, A4) follow the
  // switch too, as the gateway does: none is taken from an off at once, and
  // they are taken again only once a start has the gateway listening. A later
  // toggle wins over an earlier start that finishes after it.
  let toggles = 0
  ipcMain.handle(IPC.HOOKS_TOGGLE, async (_e, req: HooksToggleRequest) => {
    let status: HooksGatewayStatus
    const toggle = ++toggles
    if (req.enabled) {
      status = await gateway.start()
      if (toggle === toggles) setHelperHooksTaken(status.enabled === true && status.listening === true)
    } else {
      setHelperHooksTaken(false)
      // Master-toggle off: strip hook entries from every active session's
      // per-session settings file before stopping the gateway, so live
      // Claude processes stop POSTing to a dying endpoint on their next
      // /reload. SSH sessions never POST here: their remote files carry
      // the attention command hooks, which report over the session's own
      // terminal, and are rewritten on the next connect (without the
      // attention hooks while this is off). Until then pty-manager drops
      // their raises while the setting reads off (remoteAttentionTaken)
      // and still lets their clears through.
      for (const sid of getActivePtySessionIds()) {
        try {
          removeHooks({ settingsPath: getLocalSessionSettingsPath(sid) })
        } catch { /* file may not exist; next call handles missing path */ }
      }
      await gateway.stop()
      status = gateway.status()
    }
    broadcastStatus(status)
    return status
  })

  ipcMain.handle(IPC.HOOKS_GET_BUFFER, async (_e, req: HooksGetBufferRequest) => {
    // A session whose hook events come through the session helper (2.1.3-beta.8,
    // A4) has a ring in the signals module too: both, in the order they came.
    return hookFeedBuffer(req.sessionId, gateway.getBuffer(req.sessionId))
  })

  ipcMain.handle(IPC.HOOKS_GET_STATUS, async () => gateway.status())
}
