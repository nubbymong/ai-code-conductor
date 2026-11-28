// The clipboard image paste's one IPC channel (ADR-032; plan 2.1.3-beta.21
// phase 2, 2.1.4), and the facts the paste module reads from main's own
// records.
//
// paste:imageKey carries "the image paste key, or the text paste chord with
// no text on the clipboard, was pressed in session S, focused or not". It
// carries no clipboard content and no path: main reads the clipboard itself
// (src/main/paste), and decides from its own records where the session runs.
// The app window's main frame only. A press for a partner terminal's id is
// refused: the renderer sends Alt+V to a partner shell as a key.
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { isPartnerPtyId } from '../../shared/multi-spawn-rule'
import { notPasted, type PasteKeyResult } from '../../shared/clipboard-paste'
import { appWindowSender } from './trusted-sender'
import { pasteImageKey, setPasteDeps, type PasteSessionWhere } from '../paste'
import { saveClipboardImage } from './clipboard-handlers'
import { getSshFlow, isSessionLiveOrStarting } from '../pty-manager'
import { isRemoteHelperTab } from '../remote-helper'

/** Where a session's CLI runs, from the remote helper's record of the tabs
 *  it started and the PTY manager's record of SSH flows; null when the
 *  session has no terminal. */
export function sessionWhere(sessionId: string): PasteSessionWhere | null {
  if (!isSessionLiveOrStarting(sessionId)) return null
  if (isRemoteHelperTab(sessionId)) return 'helper'
  if (getSshFlow(sessionId)) return 'ssh'
  return 'local'
}

export function registerPasteHandlers(getWindow: () => BrowserWindow | null): void {
  setPasteDeps({ where: sessionWhere, savePicture: saveClipboardImage })
  const fromApp = appWindowSender(getWindow)
  ipcMain.handle(IPC.PASTE_IMAGE_KEY, async (e, press: unknown): Promise<PasteKeyResult> => {
    if (!fromApp(e)) return notPasted('session-gone')
    const id = (press as { sessionId?: unknown } | null)?.sessionId
    if (typeof id === 'string' && isPartnerPtyId(id)) return notPasted('not-available')
    return pasteImageKey(press as never)
  })
}
