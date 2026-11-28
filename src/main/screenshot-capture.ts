import { BrowserWindow, desktopCapturer, dialog, ipcMain, nativeImage, shell, systemPreferences } from 'electron'
import { join } from 'path'
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
// A type only: the package itself is loaded by the first press that uses it
// (loadPreviousSnap below), never at main's start (ADR-030 S8 step 3).
import type Screenshots from 'electron-screenshots'

import { getResourcesDirectory } from './ipc/setup-handlers'
import { isReapableImageFile } from './clipboard-file'
import { logInfo, logWarn } from './debug-logger'
import { screenCaptureAllowed, type ScreenPermissionDeps } from './screenshot-permission'
import type { SnapNotCaptured } from '../shared/snap-engine'

function getScreenshotsDir(): string { return join(getResourcesDirectory(), 'screenshots') }

function ensureDir(): void {
  const dir = getScreenshotsDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function generateFilename(): string {
  const now = new Date()
  const ts = now.toISOString()
    .replace(/T/, '-')
    .replace(/:/g, '')
    .replace(/\.\d+Z/, '')
  return `screenshot-${ts}.jpg`
}

function uniquePath(filename: string): string {
  const dir = getScreenshotsDir()
  const fullPath = join(dir, filename)
  if (!existsSync(fullPath)) return fullPath
  const base = filename.replace('.jpg', '')
  return join(dir, `${base}-${randomBytes(3).toString('hex')}.jpg`)
}

/**
 * Resize a nativeImage so the longest edge is at most maxDim, preserving aspect ratio.
 * Returns the original image if it already fits.
 *
 * Important: passing both width and height to nativeImage.resize() will distort
 * non-square images. We compute one dimension from the ratio and pass only that.
 */
function constrainToMaxDim(img: ReturnType<typeof nativeImage.createFromBuffer>, maxDim: number) {
  const size = img.getSize()
  if (size.width <= maxDim && size.height <= maxDim) return img
  if (size.width >= size.height) {
    return img.resize({ width: maxDim, quality: 'good' as const })
  } else {
    return img.resize({ height: maxDim, quality: 'good' as const })
  }
}

const SCREENSHOT_MAX_DIM = 1920
const SCREENSHOT_JPEG_QUALITY = 85

/** ADR-032 (plan 2.1.3-beta.21 phase 2, 2.1.5): each saved Snap picture's
 *  bitmap (at the same 1920 cap as its JPEG), kept by its file until the
 *  paste module takes it, so the clipboard gets the picture itself, not its
 *  JPEG decoded again. The last few only. */
const keptPictures = new Map<string, Electron.NativeImage>()
const KEPT_PICTURES_MAX = 4

function keepPicture(file: string, picture: Electron.NativeImage): void {
  keptPictures.set(file, picture)
  while (keptPictures.size > KEPT_PICTURES_MAX) {
    const oldest = keptPictures.keys().next().value
    if (oldest === undefined) break
    keptPictures.delete(oldest)
  }
}

/** The picture saved as `file`, once (the paste module's), or null when it
 *  is not kept any more. */
export function takeSnapPicture(file: string): Electron.NativeImage | null {
  const picture = keptPictures.get(file) ?? null
  keptPictures.delete(file)
  return picture
}

/** ADR-032 (plan 2.1.5): a saved Snap picture's file, by the one-shot token
 *  the capture answers the renderer with (never the path). The renderer hands
 *  the token back on the paste channel, so the capture's answer does not wait
 *  for the paste. The last few only, each for SNAP_TOKEN_MS. */
const snapTokens = new Map<string, { file: string; at: number }>()
const SNAP_TOKENS_MAX = 8
export const SNAP_TOKEN_MS = 120_000

/** A token for the picture saved as `file`. */
export function keepSnapForPaste(file: string): string {
  const token = randomBytes(16).toString('hex')
  snapTokens.set(token, { file, at: Date.now() })
  while (snapTokens.size > SNAP_TOKENS_MAX) {
    const oldest = snapTokens.keys().next().value
    if (oldest === undefined) break
    snapTokens.delete(oldest)
  }
  return token
}

/** The picture a token names, once: its file and its bitmap (kept at the
 *  capture, else read back from the file); null for a token that is unknown,
 *  used or older than SNAP_TOKEN_MS. */
export function takeSnapForPaste(token: string): { file: string; picture: Electron.NativeImage } | null {
  const kept = typeof token === 'string' ? snapTokens.get(token) : undefined
  if (!kept) return null
  snapTokens.delete(token)
  if (Date.now() - kept.at > SNAP_TOKEN_MS) return null
  const picture = takeSnapPicture(kept.file) ?? nativeImage.createFromPath(kept.file)
  return picture.isEmpty() ? null : { file: kept.file, picture }
}

/**
 * The previous Snap's capture of a rectangle region of the screen: Snap on
 * macOS and Linux; on Windows a setting away (the new Snap is the default)
 * and the one that takes any press the new Snap cannot do.
 *
 * Backed by `electron-screenshots` — a maintained library that handles
 * the platform-specific stuff (multi-monitor, taskbar coverage, focus
 * routing, CSP-friendly preload) that our custom overlay kept tripping
 * on. We just hand it `startCapture()` and listen for the `ok` /
 * `cancel` / `save` events, then resize + JPG-encode the buffer it
 * gives us using the same constraints the rest of the app applies.
 *
 * The mainWindow arg is kept for API compatibility with the IPC
 * handler — the library ignores it and creates its own overlay.
 */
let captureInProgress = false
let screenshotsInstance: Screenshots | null = null
/** True from a press's start of the previous Snap to its answer. */
let previousSnapInUse = false

/** The channels the previous Snap's package listens on in main
 *  (electron-screenshots 0.6.2, lib/index.js: its constructor's, its
 *  capture's and its reset's). Nothing else in the app uses them. */
const PREVIOUS_SNAP_CHANNELS = ['SCREENSHOTS:ready', 'SCREENSHOTS:reset', 'SCREENSHOTS:ok', 'SCREENSHOTS:cancel', 'SCREENSHOTS:save'] as const

function removePreviousSnapListeners(): void {
  for (const channel of PREVIOUS_SNAP_CHANNELS) {
    try { ipcMain.removeAllListeners(channel) } catch { /* nothing to remove */ }
  }
}

/**
 * The previous Snap's page (the package's own page, with no window of its
 * own) closed once its press has settled (aicc_planning#408): at once when
 * its overlay window is gone, else when the package says the overlay closed
 * (its `windowClosed`, after its own end of the capture). The package is
 * made again, with a new page, at the next press. A press that took it up
 * meanwhile keeps it, and closes it when it settles. No log line: a press's
 * one previous-engine line stays its only one (snap-e2e D8 reads it).
 */
function closePreviousSnapWhenSettled(library: Screenshots): void {
  const close = (): void => {
    if (screenshotsInstance !== library || previousSnapInUse) return
    screenshotsInstance = null
    removePreviousSnapListeners()
    try {
      const page = library.$view?.webContents
      if (page && !page.isDestroyed()) page.close()
    } catch { /* already gone */ }
  }
  // Never throws: the press's answer (a saved file) is already decided.
  try {
    const win = library.$win
    if (win && !win.isDestroyed()) library.once('windowClosed', close)
    else close()
  } catch { /* left for the next press's settle */ }
}

/**
 * The previous Snap's package, loaded the first time a press uses it: on
 * Windows, where the new Snap is the default, only a press with Previous
 * chosen or one the new Snap hands on; on macOS and Linux, the first press.
 * So main does not load it, or what it loads, at start (ADR-030 S8 step 3).
 * A load that fails rejects: the press answers nothing and writes one line to
 * app.log, as a press it takes does (runRectangleCapture).
 */
async function loadPreviousSnap(): Promise<typeof Screenshots> {
  const loaded = await import('electron-screenshots')
  return ((loaded as { default?: typeof Screenshots }).default ?? loaded) as typeof Screenshots
}

/** The package as a press uses it: made, with its page, at a press when none
 *  is kept (the last press's page was closed once it settled,
 *  closePreviousSnapWhenSettled). */
async function getScreenshotsInstance(): Promise<Screenshots> {
  if (!screenshotsInstance) {
    const PreviousSnap = await loadPreviousSnap()
    screenshotsInstance = new PreviousSnap({
      // singleWindow=false (default) gives a separate overlay per
      // display, so a 3-monitor setup doesn't end up with the live
      // taskbars of monitors 2/3 showing under the overlay on
      // monitor 1.
      // English labels — the library is authored in Chinese and
      // defaults to 坐标 (Coordinates), 确定 (OK), etc., which leak
      // into the magnifier + toolbar. These are the user-visible
      // strings; the library's internal logs stay Chinese (fine).
      lang: {
        magnifier_position_label: 'Position',
        operation_ok_title: 'OK',
        operation_cancel_title: 'Cancel',
        operation_save_title: 'Save',
        operation_redo_title: 'Redo',
        operation_undo_title: 'Undo',
        operation_mosaic_title: 'Mosaic',
        operation_text_title: 'Text',
        operation_brush_title: 'Brush',
        operation_arrow_title: 'Arrow',
        operation_ellipse_title: 'Ellipse',
        operation_rectangle_title: 'Rectangle',
      },
    })
  }
  return screenshotsInstance
}

/** The real system behind the Screen Recording check: the permission state, the
 *  message dialog (on the app window when there is one) and System Settings. */
function systemScreenPermission(mainWindow: BrowserWindow | null): ScreenPermissionDeps {
  return {
    platform: process.platform,
    status: () => systemPreferences.getMediaAccessStatus('screen'),
    ask: async (message, canOpen) => {
      const options = {
        type: 'info' as const,
        message: 'Snap needs Screen Recording permission',
        detail: message,
        buttons: canOpen ? ['Open System Settings', 'Not now'] : ['OK'],
        defaultId: 0,
        cancelId: canOpen ? 1 : 0,
        noLink: true,
      }
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
      const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
      return canOpen && answer.response === 0
    },
    open: (url) => shell.openExternal(url),
    prompt: async () => {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    },
  }
}

/**
 * Save a picture the new Snap cut (src/main/snap/engine.ts): rows from the
 * top, four bytes a pixel, in physical pixels. The same 1920 cap and JPEG as
 * every other Snap, into the screenshots folder; returns the file.
 */
export function saveSnapPicture(picture: { width: number; height: number; bgra: Buffer }): string {
  ensureDir()
  const filePath = uniquePath(generateFilename())
  const img = nativeImage.createFromBitmap(picture.bgra, { width: picture.width, height: picture.height })
  if (img.isEmpty()) throw new Error('an empty picture')
  const constrained = constrainToMaxDim(img, SCREENSHOT_MAX_DIM)
  writeFileSync(filePath, constrained.toJPEG(SCREENSHOT_JPEG_QUALITY))
  keepPicture(filePath, constrained)
  return filePath
}

/** What a press of the new Snap came to (src/main/snap/engine.ts SnapOutcome). */
export type NewSnapOutcome =
  | { kind: 'saved'; file: string }
  | { kind: 'cancelled' }
  | { kind: 'no-desktop' }
  | { kind: 'previous'; why: string }

/**
 * Snap's capture of a region. On macOS the Screen Recording permission is
 * checked first (screenshot-permission.ts): when it is not granted the user is
 * told and offered System Settings, and nothing is captured. Whatever goes
 * wrong after that (the capture library failing to load or to start, a throw
 * in its start) answers null, so it never reaches the uncaught-exception
 * handler. `permission` is a parameter for tests; the app passes none.
 *
 * `newEngine` is the new Snap (ADR-030 S8 steps 2 and 3), given by the IPC
 * handler on Windows unless Previous is chosen (src/shared/snap-engine.ts: the
 * default is the new one): it runs first, and when it answers `previous`
 * (anything it could not do, or a throw) the previous Snap takes the press.
 * Cancelled: nothing. No desktop to capture (exit 3): nothing captured, and
 * the answer says so (2.1.3-beta.19 fix round), so the press tells the user.
 */
export async function captureRectangle(mainWindow: BrowserWindow, permission?: ScreenPermissionDeps, newEngine?: () => Promise<NewSnapOutcome>): Promise<string | SnapNotCaptured | null> {
  if (captureInProgress) return null
  captureInProgress = true
  try {
    if (!(await screenCaptureAllowed(permission ?? systemScreenPermission(mainWindow)))) return null
    if (newEngine) {
      let outcome: NewSnapOutcome
      try {
        outcome = await newEngine()
      } catch (err) {
        logWarn(`[snap] new engine: an error (${err instanceof Error ? err.name : 'error'}); the previous Snap takes this press`)
        outcome = { kind: 'previous', why: 'an error' }
      }
      if (outcome.kind === 'saved') return outcome.file
      if (outcome.kind === 'no-desktop') return { notCaptured: 'no-desktop' }
      if (outcome.kind !== 'previous') return null
    }
    return await runRectangleCapture()
  } catch (err) {
    logWarn(`[screenshot] capture failed (${err instanceof Error ? err.name : 'error'}); nothing captured`)
    return null
  } finally {
    captureInProgress = false
  }
}

async function runRectangleCapture(): Promise<string | null> {
  let library: Screenshots
  try {
    library = await getScreenshotsInstance()
  } catch (err) {
    // The package failed to load (its first press) or to start. The log line
    // holds the error's name and code only: its message can hold a path.
    // What a half-made package listened on goes with it.
    removePreviousSnapListeners()
    const code = (err as { code?: unknown } | null)?.code
    logWarn(`[snap] previous engine: its package could not be loaded (${err instanceof Error ? err.name : 'error'}${typeof code === 'string' ? ` ${code}` : ''}); nothing captured`)
    console.error('[screenshot] the capture library could not start:', err)
    return null
  }
  logInfo('[snap] previous engine: loaded; it takes this press')
  previousSnapInUse = true
  try {
    return await previousSnapPress(library)
  } finally {
    previousSnapInUse = false
    closePreviousSnapWhenSettled(library)
  }
}

/** One press of the previous Snap: its answer once the user confirms (ok or
 *  save, saved as every Snap is) or cancels, or the capture fails. */
function previousSnapPress(library: Screenshots): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false

    const finish = (result: string | null) => {
      if (settled) return
      settled = true
      try {
        library.removeAllListeners('ok')
        library.removeAllListeners('cancel')
        library.removeAllListeners('save')
      } catch { /* a listener that cannot be removed leaves nothing to answer */ }
      resolve(result)
    }

    const handleBuffer = (buffer: Buffer) => {
      try {
        ensureDir()
        const filename = generateFilename()
        const filePath = uniquePath(filename)
        const img = nativeImage.createFromBuffer(buffer)
        if (img.isEmpty()) {
          console.error('[screenshot] empty image from electron-screenshots')
          finish(null)
          return
        }
        // Same downscale + JPG encode the rest of the app uses, so
        // captures land under Claude's image-size budget every time.
        const constrained = constrainToMaxDim(img, SCREENSHOT_MAX_DIM)
        writeFileSync(filePath, constrained.toJPEG(SCREENSHOT_JPEG_QUALITY))
        keepPicture(filePath, constrained)
        finish(filePath)
      } catch (err) {
        console.error('[screenshot] save failed:', err)
        finish(null)
      }
    }

    // 'ok' fires when the user clicks the library's confirm button on
    // the overlay; 'save' fires when they pick "save" instead — same
    // buffer either way, so we treat both the same and drop our copy
    // into the screenshots dir.
    try {
      library.on('ok', (_e, buffer, _data) => handleBuffer(buffer))
      library.on('save', (_e, buffer, _data) => handleBuffer(buffer))
      library.on('cancel', () => finish(null))

      library.startCapture().catch((err: Error) => {
        console.error('[screenshot] startCapture failed:', err)
        finish(null)
      })
    } catch (err) {
      // A throw before the capture is under way (not a rejection of it).
      console.error('[screenshot] startCapture threw:', err)
      finish(null)
    }
  })
}


/**
 * Capture a specific window by its desktopCapturer source ID.
 */
export async function captureWindow(sourceId: string): Promise<string | null> {
  ensureDir()
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 3840, height: 2160 }
    })

    const source = sources.find(s => s.id === sourceId)
    if (!source || source.thumbnail.isEmpty()) return null

    const filename = generateFilename()
    const filePath = uniquePath(filename)
    // Cap longest edge, preserving aspect ratio
    const constrained = constrainToMaxDim(source.thumbnail, SCREENSHOT_MAX_DIM)
    writeFileSync(filePath, constrained.toJPEG(SCREENSHOT_JPEG_QUALITY))
    keepPicture(filePath, constrained)
    return filePath
  } catch (err) {
    console.error('[screenshot] captureWindow error:', err)
    return null
  }
}

/**
 * List available windows for capture. On macOS the Screen Recording permission
 * is checked first, as for a region (captureRectangle): without it the user is
 * told and offered System Settings, and the list is empty, instead of a picker
 * of blank or desktop-only thumbnails. `mainWindow` is the message's parent;
 * `permission` is a parameter for tests, and the app passes none.
 */
export async function listWindows(mainWindow: BrowserWindow | null = null, permission?: ScreenPermissionDeps): Promise<Array<{ id: string; name: string; thumbnail: string }>> {
  try {
    if (!(await screenCaptureAllowed(permission ?? systemScreenPermission(mainWindow)))) return []
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 200, height: 150 }
    })

    return sources
      // Self-exclusion: must match the renderer <title> (src/renderer/index.html)
      // and stay a substring of the dev title in src/main/index.ts — the three
      // literals live in different processes and must move in lockstep.
      .filter(s => !s.thumbnail.isEmpty() && !s.name.includes('AI Code Conductor'))
      .map(s => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toPNG().toString('base64')
      }))
  } catch (err) {
    console.error('[screenshot] listWindows error:', err)
    return []
  }
}

/**
 * Delete screenshots older than maxAgeDays.
 */
export async function cleanupOldScreenshots(maxAgeDays: number): Promise<number> {
  ensureDir()
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  let deleted = 0

  try {
    const dir = getScreenshotsDir()
    const files = readdirSync(dir)
      .filter(isReapableImageFile) // screenshot-* AND clipboard-* image files (Unit 5 W5)

    for (const f of files) {
      const fullPath = join(dir, f)
      try {
        const stat = statSync(fullPath)
        if (stat.mtimeMs < cutoff) {
          unlinkSync(fullPath)
          deleted++
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    console.error('[screenshot] cleanup error:', err)
  }

  return deleted
}
