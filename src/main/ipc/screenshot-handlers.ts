import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import {
  captureRectangle,
  captureWindow,
  listWindows,
  cleanupOldScreenshots,
  saveSnapPicture,
  keepSnapForPaste,
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

/**
 * ADR-032 (plan 2.1.3-beta.21 phase 2, 2.1.5): what a saved Snap picture's
 * capture answers. The path route behind the test switch answers the saved
 * file and the session's image line, for 2.1.3-beta.20's path flow
 * (`pathRoute`). Every other press answers a one-shot token for the picture
 * main keeps, never its path (`snapToken`), bound to the session the capture
 * named: the renderer hands the token to the paste module on the paste
 * channel (paste:imageKey, chord 'snap'), which takes the picture by it for
 * that session only, writes the picture to the clipboard and presses the
 * CLI's own paste key. So the capture ends, and the Snap button is usable
 * again, while the paste runs.
 */
export interface SnapPaste {
  pathRoute(): boolean
  /** The path route's answer: the file and the session's image line. */
  pathRouteAnswer(sessionId: string, file: string): Promise<SnapPathRouteAnswer>
  /** A token for the saved picture, bound to the session the capture named
   *  (screenshot-capture keepSnapForPaste). */
  keep(file: string, sessionId: string): string
}

/** The real hand-off (the paste module is loaded at the first path-route
 *  press only: it reaches the session input module and the registry). */
const realSnapPaste: SnapPaste = {
  pathRoute: () => pathRouteOn(),
  pathRouteAnswer: async (sessionId, file) => {
    const { pathRouteLineOf } = await import('../paste')
    return { pathRoute: { file, line: pathRouteLineOf(sessionId) } }
  },
  keep: (file, sessionId) => keepSnapForPaste(file, sessionId),
}

/** `platform` and `snapPaste` are parameters for tests; the app passes none.
 *  Since 2.1.3-beta.21 (ADR-032) each capture names the session it is for;
 *  a capture that names none is not made. */
export function registerScreenshotHandlers(getWindow: () => BrowserWindow | null, platform: string = process.platform, snapPaste: SnapPaste = realSnapPaste): void {
  /** A saved picture's answer: its path on the path route only, else its
   *  token, bound to the capture's session. */
  const handOff = async (file: string | null, sessionId: string): Promise<SnapPathRouteAnswer | SnapPasteAnswer | null> => {
    if (typeof file !== 'string' || !file) return null
    if (snapPaste.pathRoute()) return snapPaste.pathRouteAnswer(sessionId, file)
    return { snapToken: snapPaste.keep(file, sessionId) }
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
    return handOff(answer, sessionId as string)
  })

  ipcMain.handle('screenshot:captureWindow', async (_event, sourceId: string, sessionId: unknown) => {
    try {
      sourceIdSchema.parse(sourceId)
      sessionIdSchema.parse(sessionId)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    return handOff(await captureWindow(sourceId), sessionId as string)
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
