/**
 * Snap's own overlay (ADR-030 D3 and D4; S8 step 2). One window per display,
 * each showing that display's picture; the user drags a rectangle and presses
 * Enter, picks Whole screen, or cancels. No drawing tools and no window capture.
 * The page is src/renderer/snap-overlay.html, its preload
 * src/preload/snap-overlay.ts; what they say is src/shared/snap-overlay.ts.
 *
 * The caller (Snap's engine) hands in each display with its picture and gets:
 *   { id, rect }      a rectangle in DIP within display `id`, clamped to it;
 *   { id, whole }     the whole of display `id`;
 *   null              the user cancelled: Escape, the Cancel button, or a
 *                     close request such as Alt+F4.
 * Anything else rejects with a SnapOverlayError naming its reason, so the
 * caller can tell a failed overlay (fall back, say why) from a cancel.
 *
 * Main owns the way out, so the promise always settles and every window
 * closes with it: Escape is taken here before the page sees it, and a page
 * that fails to load, a renderer that goes, a window destroyed without a close
 * request, or a page that does not ask for its picture within the bound each
 * close every overlay window and reject. The first answer from any display
 * closes them all; a second overlay is refused while one is open.
 */
import { BrowserWindow, ipcMain, screen } from 'electron'
import type { BrowserWindowConstructorOptions, IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron'
import { join } from 'path'
import { IPC } from '../../shared/ipc-channels'
import { clampRectToSize, type Rect, type SnapOverlayInit } from '../../shared/snap-overlay'
import { logInfo } from '../debug-logger'

export type { Rect }

export interface SnapOverlayDisplay {
  /** Electron's display id; the answer names it. */
  id: number
  /** The display's bounds in DIP, as Electron's screen module gives them. */
  dipBounds: Rect
  /** Physical pixels per DIP on this display. */
  scale: number
  /**
   * The display's picture, in its physical pixels, in any representation; a 1x
   * image takes the quick JPEG path (see `pictureDataUrl`).
   */
  picture: NativeImage
}

export type SnapOverlayAnswer = { id: number; rect: Rect } | { id: number; whole: true } | null

export type SnapOverlayFailReason =
  | 'busy' //          an overlay is already open
  | 'no-displays' //   nothing to show
  | 'bad-display' //   a display with no size, no picture, a picture that cannot be encoded, or an id given twice
  | 'window-failed' // a window could not be made
  | 'load-failed' //   a page failed to load
  | 'renderer-gone' // a page's renderer went away
  | 'window-closed' // a window was destroyed without a close request
  | 'no-ready' //      a page did not ask for its picture within the bound

export class SnapOverlayError extends Error {
  readonly reason: SnapOverlayFailReason
  constructor(reason: SnapOverlayFailReason) {
    super(`the Snap overlay failed: ${reason}`)
    this.name = 'SnapOverlayError'
    this.reason = reason
  }
}

/**
 * How long a page has to ask for its picture. Read from snap-e2e's first run
 * (CI run 45260050397, windows-2025, one 1024x768 display at 100%): the
 * previous Snap's overlay, a window and page of the same kind, was on screen
 * 783 ms after the press, its own capture included. 5 s is about six times
 * that, for a cold start on a slower PC. Each open logs the time its own pages
 * took (see `allReady`); the bound is set again from those readings, never
 * raised to answer a failure.
 */
export const SNAP_OVERLAY_READY_MS = 5000

export interface SnapOverlayOptions {
  /** The ready bound in ms; SNAP_OVERLAY_READY_MS when not given. */
  readyTimeoutMs?: number
}

/**
 * A picture with a 1x representation goes to the page as a JPEG: it is only
 * shown there (the answer is cut from the original picture by the caller), and
 * a JPEG of a 4K display is encoded in a fraction of a PNG's time on main's
 * thread. One without (made at another scale) goes as a PNG: see `pictureDataUrl`.
 */
const PICTURE_JPEG_QUALITY = 92

/** net::ERR_ABORTED: a load cut short, as by a refused navigation; the ready bound covers a page it leaves blank. */
const ERR_ABORTED = -3

/** The window one display gets, exactly as BrowserWindow is handed it. */
export function overlayWindowOptions(bounds: Rect): BrowserWindowConstructorOptions {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    title: 'Snap',
    show: false,
    frame: false,
    // Transparent until the page has painted the picture, so the moment before
    // it shows the screen itself rather than a dark flash.
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    // On Windows a tool window has no taskbar button and no Alt+Tab entry.
    ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/snap-overlay.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
      // The page measures the rectangle in CSS pixels, which are DIP only at zoom 1.
      zoomFactor: 1,
      backgroundThrottling: false,
    },
  }
}

function loadOverlayPage(win: BrowserWindow): Promise<void> {
  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) {
    return win.loadURL(new URL('snap-overlay.html', devServer.endsWith('/') ? devServer : `${devServer}/`).toString())
  }
  return win.loadFile(join(__dirname, '../renderer/snap-overlay.html'))
}

/**
 * The picture as a data URL for the page. Electron 44's toJPEG encodes only a
 * 1x representation and gives an empty buffer for an image that has none (one
 * made with a scaleFactor other than 1), so such a picture goes as a PNG of its
 * own representation. A picture that encodes to nothing throws: the open fails
 * as 'bad-display' instead of showing an overlay with no picture.
 */
function pictureDataUrl(display: SnapOverlayDisplay): string {
  const jpeg = display.picture.toJPEG(PICTURE_JPEG_QUALITY)
  if (jpeg.length > 0) return `data:image/jpeg;base64,${jpeg.toString('base64')}`
  const png = display.picture.toPNG({ scaleFactor: display.scale })
  if (png.length === 0) throw new Error('the picture cannot be encoded')
  return `data:image/png;base64,${png.toString('base64')}`
}

function usable(display: SnapOverlayDisplay): boolean {
  const b = display?.dipBounds
  return !!b
    && [b.x, b.y, b.width, b.height, display.scale].every(Number.isFinite)
    && b.width > 0 && b.height > 0 && display.scale > 0
    && !!display.picture && !display.picture.isEmpty()
}

function contains(b: Rect, p: { x: number; y: number }): boolean {
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
}

/** The pointer in DIP, or null when it cannot be read (the first display then takes focus). */
function pointerPoint(): { x: number; y: number } | null {
  try {
    return screen.getCursorScreenPoint()
  } catch {
    return null
  }
}

/** A page's message as an answer for `display`, or undefined when it is not one (ignored). */
function readAnswer(message: unknown, display: SnapOverlayDisplay): SnapOverlayAnswer | undefined {
  if (!message || typeof message !== 'object') return undefined
  const kind = (message as { kind?: unknown }).kind
  if (kind === 'cancel') return null
  if (kind === 'whole') return { id: display.id, whole: true }
  if (kind !== 'rect') return undefined
  const given = (message as { rect?: unknown }).rect
  if (!given || typeof given !== 'object') return undefined
  const { x, y, width, height } = given as Record<string, unknown>
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') return undefined
  const rect = clampRectToSize({ x, y, width, height }, display.dipBounds)
  return rect ? { id: display.id, rect } : undefined
}

interface Page {
  display: SnapOverlayDisplay
  win: BrowserWindow
  /** Kept apart from `win`: a destroyed window's webContents can no longer be read. */
  contentsId: number
  picture: string
  ready: boolean
}

let open = false

/**
 * Show the overlay on every display given and answer with the user's choice.
 * See the file header for the answers and the failures.
 */
export function openSnapOverlays(displays: SnapOverlayDisplay[], options: SnapOverlayOptions = {}): Promise<SnapOverlayAnswer> {
  return new Promise<SnapOverlayAnswer>((resolve, reject) => {
    if (open) { reject(new SnapOverlayError('busy')); return }
    if (!Array.isArray(displays) || displays.length === 0) { reject(new SnapOverlayError('no-displays')); return }
    if (!displays.every(usable) || new Set(displays.map((d) => d.id)).size !== displays.length) {
      reject(new SnapOverlayError('bad-display'))
      return
    }
    open = true

    const startedAt = Date.now()
    const readyMs = options.readyTimeoutMs ?? SNAP_OVERLAY_READY_MS
    const pages: Page[] = []
    let settled = false
    let readyTimer: ReturnType<typeof setTimeout> | null = null
    /** A window the user asked to close: it closes by itself, so it is not destroyed here. */
    let closing: Page | null = null

    const pageOf = (sender: { id: number }): Page | undefined => pages.find((p) => p.contentsId === sender.id)

    const finish = (outcome: { answer: SnapOverlayAnswer } | { failure: SnapOverlayFailReason }): void => {
      if (settled) return
      settled = true
      open = false
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null }
      ipcMain.removeHandler(IPC.SNAP_OVERLAY_READY)
      ipcMain.removeListener(IPC.SNAP_OVERLAY_ANSWER, onAnswer)
      for (const page of pages) {
        if (page === closing) continue
        try {
          if (!page.win.isDestroyed()) page.win.destroy()
        } catch { /* already gone */ }
      }
      if ('failure' in outcome) reject(new SnapOverlayError(outcome.failure))
      else resolve(outcome.answer)
    }

    const allReady = (): void => {
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null }
      // The reading the ready bound is set from (SNAP_OVERLAY_READY_MS).
      logInfo(`[snap] overlay pages ready on ${pages.length} display(s) in ${Date.now() - startedAt} ms`)
      const pointer = pointerPoint()
      const target = (pointer ? pages.find((p) => contains(p.display.dipBounds, pointer)) : undefined) ?? pages[0]
      try {
        target.win.moveTop()
        target.win.focus()
      } catch { /* a window that cannot take focus still answers a click */ }
    }

    const onReady = (event: IpcMainInvokeEvent): SnapOverlayInit => {
      const page = settled ? undefined : pageOf(event.sender)
      if (!page) throw new Error('not a Snap overlay page')
      if (!page.ready) {
        page.ready = true
        page.win.show()
        if (pages.every((p) => p.ready)) allReady()
      }
      const { width, height } = page.display.dipBounds
      return { picture: page.picture, width, height, scale: page.display.scale }
    }

    function onAnswer(event: IpcMainEvent, message: unknown): void {
      if (settled) return
      const page = pageOf(event.sender)
      if (!page) return
      const answer = readAnswer(message, page.display)
      if (answer !== undefined) finish({ answer })
    }

    const guard = (page: Page): void => {
      const { win } = page
      const contents = win.webContents
      contents.on('will-navigate', (event) => event.preventDefault())
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      contents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') {
          event.preventDefault()
          finish({ answer: null })
        }
      })
      contents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
        if (isMainFrame && errorCode !== ERR_ABORTED) finish({ failure: 'load-failed' })
      })
      contents.on('render-process-gone', () => finish({ failure: 'renderer-gone' }))
      // A close request is the user leaving, as Escape is. It is not prevented
      // (a prevented close would also cancel an app quit under way): this
      // window closes by itself and the others are closed in finish.
      win.on('close', () => {
        if (settled) return
        closing = page
        finish({ answer: null })
      })
      win.on('closed', () => finish({ failure: 'window-closed' }))
    }

    let stage: SnapOverlayFailReason = 'window-failed'
    try {
      ipcMain.handle(IPC.SNAP_OVERLAY_READY, onReady)
      ipcMain.on(IPC.SNAP_OVERLAY_ANSWER, onAnswer)
      for (const display of displays) {
        const win = new BrowserWindow(overlayWindowOptions(display.dipBounds))
        const page: Page = { display, win, contentsId: win.webContents.id, picture: '', ready: false }
        pages.push(page)
        guard(page)
        win.setAlwaysOnTop(true, 'screen-saver')
        // Again after creation: a window made on a display of another scale is
        // first sized at the scale of the display it was created from.
        win.setBounds(display.dipBounds)
        loadOverlayPage(win).catch(() => { /* did-fail-load names the failure; an aborted load is the ready bound's */ })
      }
      stage = 'bad-display'
      for (const page of pages) page.picture = pictureDataUrl(page.display)
      readyTimer = setTimeout(() => finish({ failure: 'no-ready' }), readyMs)
    } catch {
      finish({ failure: stage })
    }
  })
}
