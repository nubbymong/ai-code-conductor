/**
 * The new Snap's ports in the running app (plan 2.1.3-beta.16 A1,
 * aicc_planning#401): Electron's displays and images, the helper beside the
 * app, a press folder under the user data folder, and the bound.
 * engine.ts holds what a press does; this file only connects it.
 */
import { app, nativeImage, screen, type NativeImage } from 'electron'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { bundledHelperPath } from '../session-helper/install'
import { logInfo } from '../debug-logger'
import { snapWithHelper, type OpenOverlays, type SnapOutcome } from './engine'
import { runHelperCapture, HELPER_CAPTURE_BOUND_MS, type CaptureChild } from './helper-capture'
import { CAPTURE_PARENT, makePressFolder, removePressFolder } from './capture-folder'
import { snapHelperPath } from './helper-path'
import type { Picture } from './bmp'

/** One press of the new Snap. `openOverlays` is the overlay (ADR-030 D4);
 *  `save` is today's cap and JPEG into the screenshots folder. */
export function snapOnWindows(openOverlays: OpenOverlays<NativeImage>, save: (picture: Picture) => string): Promise<SnapOutcome> {
  const parent = () => path.join(app.getPath('userData'), CAPTURE_PARENT)
  return snapWithHelper<NativeImage>({
    helperPath: () => snapHelperPath({
      isPackaged: app.isPackaged,
      env: process.env,
      bundled: bundledHelperPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), platform: 'win32' }),
      exists: (p) => fs.existsSync(p),
    }),
    makeFolder: () => makePressFolder(parent()),
    removeFolder: (folder) => removePressFolder(parent(), folder),
    runHelper: (helper, folder) => runHelperCapture(helper, folder, {
      spawn: (file, args) => spawn(file, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as CaptureChild,
      startTimer: (fn, ms) => {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      },
      now: () => performance.now(),
      boundMs: HELPER_CAPTURE_BOUND_MS,
    }),
    readFile: (file) => fs.readFileSync(file),
    displays: () => screen.getAllDisplays().map((d) => ({
      id: d.id,
      dipBounds: { ...d.bounds },
      scale: d.scaleFactor,
      physical: screen.dipToScreenRect(null, d.bounds),
    })),
    toImage: (picture, scale) => nativeImage.createFromBitmap(picture.bgra, { width: picture.width, height: picture.height, scaleFactor: scale }),
    openOverlays,
    save,
    log: (line) => logInfo(line),
  })
}

/** Until the overlay (src/main/snap/overlay.ts, section A2) is merged: an
 *  overlay that fails, so a press with the new engine captures, logs its
 *  reading, and the previous Snap takes it. */
export const overlayNotInThisBuild: OpenOverlays<NativeImage> = async () => {
  throw new Error('the overlay is not in this build')
}
