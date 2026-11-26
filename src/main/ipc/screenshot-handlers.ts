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

const sourceIdSchema = z.string().min(1).max(500)
const maxAgeDaysSchema = z.number().int().positive().max(3650)

/** The Snap choice the user saved (Settings, Custom Commands, Snap), read at
 *  each press so a change needs no restart. Undefined when none is saved. */
function savedSnapChoice(): unknown {
  try {
    return readConfig<{ snapEngineWindows?: unknown }>('magicButtons')?.snapEngineWindows
  } catch {
    return undefined
  }
}

/** `platform` is a parameter for tests; the app passes none. */
export function registerScreenshotHandlers(getWindow: () => BrowserWindow | null, platform: string = process.platform): void {
  ipcMain.handle('screenshot:captureRectangle', async () => {
    const win = getWindow()
    if (!win) return null
    // On Windows the new Snap, unless Previous is chosen: it runs first and
    // hands any press it cannot do to the previous one (ADR-030 S8 steps 2
    // and 3); elsewhere the previous.
    const useNew = snapEngineFor(platform, savedSnapChoice()) === 'new'
    return captureRectangle(win, undefined, useNew ? () => snapOnWindows(saveSnapPicture) : undefined)
  })

  ipcMain.handle('screenshot:captureWindow', async (_event, sourceId: string) => {
    try {
      sourceIdSchema.parse(sourceId)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    return captureWindow(sourceId)
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
