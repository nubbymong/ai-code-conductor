// 2.1.3-beta.17, plan section C4 (aicc_planning#408): the previous Snap's own
// page (electron-screenshots' page, with no window of its own) is closed once
// its press has settled, and the package is made again, with a new page, at
// the next press. After an OK it closes when the package says its overlay
// closed (the package's own end of the capture still talks to the page);
// after a Cancel, or a capture that did not start, at once. A press that took
// the package up before the last one's overlay closed keeps it. What the
// package listened on in main goes with its page.
//
// The package is a stand-in with the real one's shape (an event emitter with
// `$view.webContents` and `$win`); no window, page or capture is real. The
// picture an OK saves is written into a folder of this file's own.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const lib = vi.hoisted(() => ({
  made: [] as Array<{
    emit: (event: string, ...args: unknown[]) => boolean
    $win: { isDestroyed: () => boolean; destroyed: boolean } | null
    $view: { webContents: { isDestroyed: () => boolean; close: () => void; closed: number } }
    startCalls: number
  }>,
  start: 'show' as 'show' | 'cancel-at-once' | 'reject',
  removed: [] as string[],
  resources: '',
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  desktopCapturer: { getSources: async () => [] },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  ipcMain: { removeAllListeners: (channel: string) => { lib.removed.push(channel) } },
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 4, height: 4 }), toJPEG: () => Buffer.from('jpeg') }),
  },
  shell: { openExternal: async () => {} },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
}))
vi.mock('electron-screenshots', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeScreenshots extends EventEmitter {
    $win: { isDestroyed: () => boolean; destroyed: boolean } | null = null
    $view = {
      webContents: {
        closed: 0,
        isDestroyed(): boolean { return this.closed > 0 },
        close(): void { this.closed++ },
      },
    }
    startCalls = 0
    constructor() {
      super()
      lib.made.push(this)
    }
    async startCapture(): Promise<void> {
      this.startCalls++
      if (lib.start === 'reject') throw new Error('capture rejected')
      if (lib.start === 'cancel-at-once') { this.emit('cancel', {}); return }
      // The overlay is up, waiting for the user.
      if (!this.$win || this.$win.isDestroyed()) {
        const win = { destroyed: false, isDestroyed: () => win.destroyed }
        this.$win = win
      }
    }
    /** What the package's own end of the capture does last: the overlay goes. */
    endOverlay(): void {
      if (!this.$win) return
      this.$win.destroyed = true
      this.emit('windowClosed', this.$win)
      this.$win = null
    }
  }
  return { default: FakeScreenshots }
})
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => lib.resources }))
vi.mock('../../../src/main/clipboard-file', () => ({ isReapableImageFile: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { captureRectangle } = await import('../../../src/main/screenshot-capture')

const TEST_PREFIX = 'c4-previous-snap-page-'
lib.resources = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), TEST_PREFIX)))
afterAll(() => {
  // TEST CLEANUP GUARD: only the folder this file made, by its own prefix, directly in the temp folder.
  const d = lib.resources
  if (path.basename(d).startsWith(TEST_PREFIX) && path.dirname(d) === fs.realpathSync.native(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true })
})

const win = { isDestroyed: () => false } as never
// Windows: no Screen Recording check; no new Snap given, so the previous Snap takes the press.
const windows = { platform: 'win32', status: () => 'granted', prompt: async () => {}, ask: async () => false, open: () => {} } as never
const CHANNELS = ['SCREENSHOTS:ready', 'SCREENSHOTS:reset', 'SCREENSHOTS:ok', 'SCREENSHOTS:cancel', 'SCREENSHOTS:save']

/** The package a press is using, once its overlay is up. */
async function overlayUp(n: number): Promise<(typeof lib.made)[number]> {
  await vi.waitFor(() => {
    const p = lib.made.at(-1)
    expect(p?.$win && !p.$win.isDestroyed() && lib.made.length === n).toBe(true)
  })
  return lib.made.at(-1)!
}

beforeEach(async () => {
  // Settle whatever an earlier test left up, so each test starts with no package kept.
  for (const p of lib.made) (p as unknown as { endOverlay(): void }).endOverlay()
  lib.made.length = 0
  lib.start = 'show'
  lib.removed = []
})

describe('the previous Snap\'s page after its press (aicc_planning#408)', () => {
  it('after an OK: kept while the overlay is up, closed once it closes, and made again at the next press', async () => {
    const press = captureRectangle(win, windows)
    const first = await overlayUp(1)
    first.emit('ok', {}, Buffer.from('png'), {})
    const saved = await press
    expect(saved).toMatch(/screenshot-.*\.jpg$/)
    expect(fs.existsSync(saved!)).toBe(true)
    // The package's own end still talks to the page until the overlay is gone.
    expect(first.$view.webContents.closed).toBe(0)
    expect(lib.removed).toEqual([])
    ;(first as unknown as { endOverlay(): void }).endOverlay()
    expect(first.$view.webContents.closed).toBe(1)
    expect(lib.removed).toEqual(CHANNELS)

    // The next press makes the package again, with a page of its own, and works.
    const again = captureRectangle(win, windows)
    const second = await overlayUp(2)
    expect(second).not.toBe(first)
    second.emit('cancel', {})
    expect(await again).toBeNull()
    expect(second.startCalls).toBe(1)
    ;(second as unknown as { endOverlay(): void }).endOverlay()
    expect(second.$view.webContents.closed).toBe(1)
    expect(first.$view.webContents.closed).toBe(1)
  })

  it('after a Cancel with no overlay left, closed at once', async () => {
    lib.start = 'cancel-at-once'
    expect(await captureRectangle(win, windows)).toBeNull()
    expect(lib.made).toHaveLength(1)
    expect(lib.made[0].$view.webContents.closed).toBe(1)
    expect(lib.removed).toEqual(CHANNELS)
    // And a second press works, on a new page.
    expect(await captureRectangle(win, windows)).toBeNull()
    expect(lib.made).toHaveLength(2)
    expect(lib.made[1].startCalls).toBe(1)
    expect(lib.made[1].$view.webContents.closed).toBe(1)
  })

  it('after a capture that did not start, closed at once', async () => {
    lib.start = 'reject'
    expect(await captureRectangle(win, windows)).toBeNull()
    expect(lib.made).toHaveLength(1)
    expect(lib.made[0].$view.webContents.closed).toBe(1)
  })

  it('a press that took the package up before the last overlay closed keeps it, and closes it when it settles', async () => {
    const press = captureRectangle(win, windows)
    const first = await overlayUp(1)
    first.emit('ok', {}, Buffer.from('png'), {})
    await press
    // The overlay is still up (a Save dialog closed with no file keeps it so)
    // when the next press comes: it takes up the same package and its overlay.
    const next = captureRectangle(win, windows)
    await vi.waitFor(() => expect(first.startCalls).toBe(2))
    ;(first as unknown as { endOverlay(): void }).endOverlay()
    expect(first.$view.webContents.closed).toBe(0)
    expect(lib.made).toHaveLength(1)
    first.emit('cancel', {})
    expect(await next).toBeNull()
    expect(first.$view.webContents.closed).toBe(1)
  })
})
