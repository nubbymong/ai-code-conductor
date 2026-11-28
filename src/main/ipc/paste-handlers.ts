// The clipboard image paste's one IPC channel (ADR-032; plan 2.1.3-beta.21
// phase 2, 2.1.4), and the facts the paste module reads from main's own
// records.
//
// paste:imageKey carries "the image paste key, or the text paste chord with
// no text on the clipboard, was pressed in session S, focused or not", or
// "Snap's capture answered this token for session S" (the token names the
// picture main kept; plan 2.1.5). It carries no clipboard content and no
// path: main reads the clipboard itself
// (src/main/paste), and decides from its own records where the session runs.
// The app window's main frame only. A press for a partner terminal's id is
// refused: the renderer sends Alt+V to a partner shell as a key.
//
// Since plan 2.1.3-beta.21 phase 5 (block 5.1) it also registers the paste
// module's route for a tab through the session helper on its machine
// (src/main/paste/helper-route.ts): the picture by file.put, then the tab's
// key through the session input module's door.
import { ipcMain, nativeImage, type BrowserWindow } from 'electron'
import { statSync } from 'fs'
import { IPC } from '../../shared/ipc-channels'
import { isPartnerPtyId } from '../../shared/multi-spawn-rule'
import { notPasted, type PasteKeyResult } from '../../shared/clipboard-paste'
import { appWindowSender } from './trusted-sender'
import { pasteImageKey, setPasteDeps, setRemotePasteRoute, type PasteSessionWhere } from '../paste'
import { helperPasteRoute, type HelperRouteDeps } from '../paste/helper-route'
import { writeClipboardPicture } from '../paste/clipboard-writer'
import { pasteFromClipboard } from '../session-input'
import { readClipboardImageWithRetry } from '../clipboard-image'
import { pickPasteableImage, readClipboardFilePaths } from '../clipboard-file'
import { logInfo } from '../debug-logger'
import { saveClipboardImage } from './clipboard-handlers'
import { getSshFlow, isSessionLiveOrStarting } from '../pty-manager'
import { isRemoteHelperTab, remoteTabPaste } from '../remote-helper'
import { getClaudeProfileId } from '../claude-account-identity'
import { getProfileConfigDir } from '../account-profiles'
import { takeSnapForPaste } from '../screenshot-capture'

/** Where a session's CLI runs, from the remote helper's record of the tabs
 *  it started and the PTY manager's record of SSH flows; null when the
 *  session has no terminal. */
export function sessionWhere(sessionId: string): PasteSessionWhere | null {
  if (!isSessionLiveOrStarting(sessionId)) return null
  if (isRemoteHelperTab(sessionId)) return 'helper'
  if (getSshFlow(sessionId)) return 'ssh'
  return 'local'
}

/** The config folder a local session's launch gave Claude Code: its
 *  account's own (the profile it spawned under, claude-account-identity's
 *  record), or null on this computer's own sign-in. */
export function sessionAccountDir(sessionId: string): string | null {
  const profileId = getClaudeProfileId(sessionId)
  return profileId ? getProfileConfigDir(profileId) : null
}

/** A copied file's size, or null when it is gone or not a plain file. */
function fileSize(path: string): number | null {
  try {
    const st = statSync(path)
    return st.isFile() ? st.size : null
  } catch { return null }
}

/** 2.1.3-beta.21 (plan block 5.1): what a helper tab's paste route reads,
 *  writes and asks (src/main/paste/helper-route.ts): the app's own platform
 *  (the route serves the Windows app only in this beta, plan s4), the remote
 *  helper's open tab, this computer's clipboard (a picture, else a copied
 *  image file's, read as the paste module reads them), its writer (Snap's
 *  picture stays there, plan Q1) and the session input module's one door. */
export function helperRouteDeps(): HelperRouteDeps {
  return {
    platform: process.platform,
    tab: (sessionId) => remoteTabPaste(sessionId),
    readPicture: () => readClipboardImageWithRetry(),
    readCopiedImage: async () => {
      const picked = pickPasteableImage(await readClipboardFilePaths(), fileSize)
      if (!('path' in picked)) return { error: picked.error === 'too-large' ? 'too-large' : 'no-image' }
      try {
        const picture = nativeImage.createFromPath(picked.path)
        return picture.isEmpty() ? { error: 'no-image' } : { picture }
      } catch { return { error: 'no-image' } }
    },
    write: (picture) => writeClipboardPicture(picture),
    door: (sessionId, key, sentence) => pasteFromClipboard(sessionId, key, sentence),
    log: (line) => logInfo(line),
  }
}

export function registerPasteHandlers(getWindow: () => BrowserWindow | null): void {
  setPasteDeps({ where: sessionWhere, savePicture: saveClipboardImage, accountDir: sessionAccountDir, takeSnap: takeSnapForPaste })
  // 2.1.3-beta.21 (plan block 5.1): a helper tab's press and Snap go by file.put, then its key.
  setRemotePasteRoute(helperPasteRoute(helperRouteDeps()))
  const fromApp = appWindowSender(getWindow)
  ipcMain.handle(IPC.PASTE_IMAGE_KEY, async (e, press: unknown): Promise<PasteKeyResult> => {
    if (!fromApp(e)) return notPasted('session-gone')
    const id = (press as { sessionId?: unknown } | null)?.sessionId
    if (typeof id === 'string' && isPartnerPtyId(id)) return notPasted('not-available')
    return pasteImageKey(press as never)
  })
}
