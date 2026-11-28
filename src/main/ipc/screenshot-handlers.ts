import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import {
  captureRectangle,
  captureWindow,
  listWindows,
  cleanupOldScreenshots,
  saveSnapPicture,
} from '../screenshot-capture'
import { readConfig } from '../config-manager'
import { snapEngineFor } from '../../shared/snap-engine'
import { snapOnWindows } from '../snap/windows-engine'
import type { SnapPasteAnswer, SnapPathRouteAnswer } from '../../shared/clipboard-paste'
import { pathRouteOn } from '../paste/path-route'

const sourceIdSchema = z.string().min(1).max(500)
const maxAgeDaysSchema = z.number().int().positive().max(3650)
const sessionIdSchema = z.string().min(1).max(200)

/** The Snap choice the user saved (Settings, Custom Commands, Snap), read at
 *  each press so a change needs no restart. Undefined when none is saved. */
function savedSnapChoice(): unknown {
  try {
    return readConfig<{ snapEngineWindows?: unknown }>('magicButtons')?.snapEngineWindows
  } catch {
    return undefined
  }
}

/** Which of Snap's two items took the picture (its sentence). */
export type SnapItem = 'rectangle' | 'window'

/**
 * ADR-032 (plan 2.1.3-beta.21 phase 2, 2.1.5): what happens to a saved Snap
 * picture. The path route behind the test switch answers the saved file and
 * the session's image line, for 2.1.3-beta.20's path flow (`pathRoute`);
 * every other press hands the picture to
 * the paste module, which writes it to the clipboard and presses the CLI's
 * own paste key, and answers what it did (`snapped`), with no path.
 */
export interface SnapPaste {
  pathRoute(): boolean
  /** The path route's answer: the file and the session's image line. */
  pathRouteAnswer(sessionId: string, file: string): Promise<SnapPathRouteAnswer>
  paste(sessionId: string, file: string, item: SnapItem): Promise<SnapPasteAnswer>
}

/** The real hand-off, loaded at the first press (the paste module reaches
 *  the session input module and the provider registry). */
const realSnapPaste: SnapPaste = {
  pathRoute: () => pathRouteOn(),
  pathRouteAnswer: async (sessionId, file) => {
    const { pathRouteLineOf } = await import('../paste')
    return { pathRoute: { file, line: pathRouteLineOf(sessionId) } }
  },
  paste: async (sessionId, file, item) => {
    const [{ pasteSnapPicture }, { takeSnapPicture }, { nativeImage }, words] = await Promise.all([
      import('../paste'), import('../screenshot-capture'), import('electron'), import('../../shared/clipboard-paste'),
    ])
    const picture = takeSnapPicture(file) ?? nativeImage.createFromPath(file)
    const sentence = item === 'window' ? words.SNAP_WINDOW_SENTENCE : words.SNAP_RECTANGLE_SENTENCE
    return { snapped: await pasteSnapPicture(sessionId, picture, file, sentence) }
  },
}

/** `platform` and `snapPaste` are parameters for tests; the app passes none.
 *  Since 2.1.3-beta.21 (ADR-032) each capture names the session it is for;
 *  a capture that names none is not made. */
export function registerScreenshotHandlers(getWindow: () => BrowserWindow | null, platform: string = process.platform, snapPaste: SnapPaste = realSnapPaste): void {
  /** A saved picture's answer: its path on the path route only, else the paste's. */
  const handOff = async (file: string | null, sessionId: string, item: SnapItem): Promise<SnapPathRouteAnswer | SnapPasteAnswer | null> => {
    if (typeof file !== 'string' || !file) return null
    if (snapPaste.pathRoute()) return snapPaste.pathRouteAnswer(sessionId, file)
    return snapPaste.paste(sessionId, file, item)
  }

  ipcMain.handle('screenshot:captureRectangle', async (_event, sessionId: unknown) => {
    const win = getWindow()
    if (!win) return null
    if (!sessionIdSchema.safeParse(sessionId).success) return null
    // On Windows the new Snap, unless Previous is chosen: it runs first and
    // hands any press it cannot do to the previous one (ADR-030 S8 steps 2
    // and 3); elsewhere the previous.
    const useNew = snapEngineFor(platform, savedSnapChoice()) === 'new'
    const answer = await captureRectangle(win, undefined, useNew ? () => snapOnWindows(saveSnapPicture) : undefined)
    if (typeof answer !== 'string') return answer
    return handOff(answer, sessionId as string, 'rectangle')
  })

  ipcMain.handle('screenshot:captureWindow', async (_event, sourceId: string, sessionId: unknown) => {
    try {
      sourceIdSchema.parse(sourceId)
      sessionIdSchema.parse(sessionId)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    return handOff(await captureWindow(sourceId), sessionId as string, 'window')
  })

  ipcMain.handle('screenshot:listWindows', async () => {
    return listWindows(getWindow())
  })

  ipcMain.handle('screenshot:cleanup', async (_event, maxAgeDays: number) => {
    try {
      maxAgeDaysSchema.parse(maxAgeDays)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    return cleanupOldScreenshots(maxAgeDays)
  })
}
