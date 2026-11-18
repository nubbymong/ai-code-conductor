import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { HooksGatewayLike } from '../hooks'
import type { HooksToggleRequest, HooksGetBufferRequest, HooksGatewayStatus } from '../../shared/hook-types'
import { getActivePtySessionIds } from '../pty-manager'
import { removeHooks } from '../hooks/session-hooks-writer'
import { getLocalSessionSettingsPath } from '../hooks/per-session-settings'
import { dropHelperRings, hookFeedBuffer } from '../session-signals'
import { HooksGateway } from '../hooks/hooks-gateway'
import { HooksGatewayProxy } from '../services/hooks-gateway-proxy'

/** Whether a stop of this gateway clears its per-session rings: the
 *  in-process HooksGateway does (hooks-gateway.ts stop), and so does the proxy
 *  while it runs one (fail-open); the proxy with its child out of process does
 *  not. Any other gateway has none to clear. */
function gatewayClearsRingsAtStop(gateway: HooksGatewayLike): boolean {
  if (gateway instanceof HooksGateway) return true
  return gateway instanceof HooksGatewayProxy && gateway.isInProcessFallback()
}

function broadcastStatus(status: HooksGatewayStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try { w.webContents.send(IPC.HOOKS_STATUS, status) } catch { /* destroyed */ }
    }
  }
}

export function registerHooksHandlers(gateway: HooksGatewayLike): void {
  ipcMain.handle(IPC.HOOKS_TOGGLE, async (_e, req: HooksToggleRequest) => {
    let status: HooksGatewayStatus
    if (req.enabled) {
      status = await gateway.start()
    } else {
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
      // The gateway cleared its own per-session rings at its stop (the
      // in-process HooksGateway always does, and so does the proxy running
      // one after its fail-open): the helper's go with them, so the history
      // read does not return a held session's helper events without the
      // PreToolUse entries that went. The proxy with its child out of
      // process keeps its rings at a stop, so the helper's stay with them.
      // Read after the stop: it is the state the history read will see.
      if (gatewayClearsRingsAtStop(gateway)) dropHelperRings()
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
