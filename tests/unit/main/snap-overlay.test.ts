// Snap's own overlay, main's half (src/main/snap/overlay.ts; ADR-030 D4, S8 step 2).
// One window per display, sandboxed, navigation refused; the first answer from
// any display closes them all; and main owns the way out: its own Escape, a page
// that fails to load, a renderer that goes, a window destroyed, or no 'ready' in
// the bound each close every window and settle the promise.
// Electron is faked here: no window, no renderer, no real clock (the bound is a
// parameter and the timers are vitest's).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const h = vi.hoisted(() => {
  type Fn = (...args: any[]) => any
  class Emitter {
    private handlers = new Map<string, Fn[]>()
    on(event: string, fn: Fn) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn])
      return this
    }
    once(event: string, fn: Fn) { return this.on(event, fn) }
    emit(event: string, ...args: any[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args)
    }
    count(event: string) { return (this.handlers.get(event) ?? []).length }
  }
  let nextContentsId = 100
  class FakeContents extends Emitter {
    id = nextContentsId++
    openHandler: Fn | null = null
    setWindowOpenHandler(fn: Fn) { this.openHandler = fn }
  }
  class FakeWindow extends Emitter {
    static instances: FakeWindow[] = []
    /** The construction (1-based, counted from `made = 0`) that throws, as a window that cannot be made. */
    static failOn: number | null = null
    static made = 0
    options: any
    webContents = new FakeContents()
    destroyed = false
    loadFile = vi.fn(() => Promise.resolve())
    loadURL = vi.fn(() => Promise.resolve())
    setAlwaysOnTop = vi.fn()
    setBounds = vi.fn()
    show = vi.fn()
    focus = vi.fn()
    moveTop = vi.fn()
    constructor(options: any) {
      super()
      FakeWindow.made++
      if (FakeWindow.failOn === FakeWindow.made) throw new Error('no window')
      this.options = options
      FakeWindow.instances.push(this)
    }
    isDestroyed() { return this.destroyed }
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
    }
  }
  const handlers = new Map<string, Fn>()
  const listeners = new Map<string, Set<Fn>>()
  const ipcMain = {
    handle: vi.fn((channel: string, fn: Fn) => {
      if (handlers.has(channel)) throw new Error(`a second handler for ${channel}`)
      handlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => { handlers.delete(channel) }),
    on: vi.fn((channel: string, fn: Fn) => {
      listeners.set(channel, new Set([...(listeners.get(channel) ?? []), fn]))
    }),
    removeListener: vi.fn((channel: string, fn: Fn) => { listeners.get(channel)?.delete(fn) }),
  }
  const cursor = { x: 0, y: 0 }
  const screen = { getCursorScreenPoint: vi.fn(() => ({ ...cursor })) }
  return { FakeWindow, handlers, listeners, ipcMain, screen, cursor }
})

vi.mock('electron', () => ({
  BrowserWindow: h.FakeWindow,
  ipcMain: h.ipcMain,
  screen: h.screen,
  app: { isPackaged: true, getPath: vi.fn(() => '') },
}))

import { IPC } from '../../../src/shared/ipc-channels'
import {
  openSnapOverlays,
  overlayWindowOptions,
  SnapOverlayError,
  SNAP_OVERLAY_READY_MS,
  type SnapOverlayDisplay,
} from '../../../src/main/snap/overlay'

type FakeWindow = InstanceType<typeof h.FakeWindow>

const picture = (tag: string) => ({
  isEmpty: () => false,
  toJPEG: vi.fn(() => Buffer.from(`jpeg-${tag}`)),
}) as unknown as SnapOverlayDisplay['picture']

const PRIMARY: SnapOverlayDisplay = { id: 1, dipBounds: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1, picture: picture('primary') }
// A display left of the primary at 150%: negative x, its own DIP size.
const LEFT: SnapOverlayDisplay = { id: 2, dipBounds: { x: -1280, y: 0, width: 1280, height: 720 }, scale: 1.5, picture: picture('left') }

const windows = () => h.FakeWindow.instances
const ready = (win: FakeWindow) => {
  const handler = h.handlers.get(IPC.SNAP_OVERLAY_READY)
  if (!handler) throw new Error('no ready handler')
  return handler({ sender: win.webContents })
}
const answer = (win: FakeWindow, message: unknown) => {
  for (const fn of h.listeners.get(IPC.SNAP_OVERLAY_ANSWER) ?? []) fn({ sender: win.webContents }, message)
}
const allDestroyed = () => windows().every((w) => w.destroyed)
const failureOf = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(SnapOverlayError)
  return (err as SnapOverlayError).reason
}

beforeEach(() => {
  h.FakeWindow.instances.length = 0
  h.FakeWindow.failOn = null
  h.FakeWindow.made = 0
  h.handlers.clear()
  h.listeners.clear()
  h.cursor.x = 0
  h.cursor.y = 0
  vi.useFakeTimers()
})
afterEach(() => {
  // A test that failed before its overlay settled would leave it open, and every
  // later test would read 'busy'. Destroying its windows settles it (only a
  // failing test ever leaves one open), so each test stands on its own.
  for (const w of windows()) w.destroy()
  vi.useRealTimers()
})

describe('the window each display gets', () => {
  it('is sandboxed, isolated and has no Node, with its own preload', () => {
    const opts = overlayWindowOptions(PRIMARY.dipBounds)
    expect(opts.webPreferences?.sandbox).toBe(true)
    expect(opts.webPreferences?.contextIsolation).toBe(true)
    expect(opts.webPreferences?.nodeIntegration).toBe(false)
    expect(opts.webPreferences?.nodeIntegrationInSubFrames).toBe(false)
    expect(opts.webPreferences?.webviewTag).toBe(false)
    expect(String(opts.webPreferences?.preload)).toMatch(/[\\/]preload[\\/]snap-overlay\.js$/)
  })

  it('is frameless, on top, out of the taskbar, hidden until its page is ready, at the display bounds', async () => {
    const p = openSnapOverlays([PRIMARY, LEFT])
    expect(windows()).toHaveLength(2)
    for (const [i, display] of [PRIMARY, LEFT].entries()) {
      const win = windows()[i]
      // The options the factory actually handed BrowserWindow, not a copy.
      expect(win.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
      expect(win.options).toMatchObject({ frame: false, alwaysOnTop: true, skipTaskbar: true, show: false, resizable: false, movable: false })
      expect(win.options).toMatchObject(display.dipBounds)
      // Set again after creation: a window made on a display of another scale
      // is first sized at the scale it was created on.
      expect(win.setBounds).toHaveBeenCalledWith(display.dipBounds)
      expect(win.loadFile).toHaveBeenCalledWith(expect.stringMatching(/[\\/]renderer[\\/]snap-overlay\.html$/))
      expect(win.show).not.toHaveBeenCalled()
    }
    answer(windows()[0], { kind: 'cancel' })
    await expect(p).resolves.toBeNull()
  })

  it('refuses navigation and new windows', async () => {
    const p = openSnapOverlays([PRIMARY])
    const wc = windows()[0].webContents
    const nav = { preventDefault: vi.fn() }
    wc.emit('will-navigate', nav, 'https://example.com/')
    expect(nav.preventDefault).toHaveBeenCalled()
    expect(wc.openHandler).not.toBeNull()
    expect(wc.openHandler!({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    answer(windows()[0], { kind: 'cancel' })
    await p
  })
})

describe('ready', () => {
  it('hands each page its own display picture and DIP size, then shows its window', async () => {
    const p = openSnapOverlays([PRIMARY, LEFT])
    const init = ready(windows()[1])
    expect(init).toEqual({ picture: `data:image/jpeg;base64,${Buffer.from('jpeg-left').toString('base64')}`, width: 1280, height: 720, scale: 1.5 })
    expect(windows()[1].show).toHaveBeenCalled()
    expect(windows()[0].show).not.toHaveBeenCalled()
    answer(windows()[1], { kind: 'cancel' })
    await p
  })

  it('answers only an overlay page', async () => {
    const p = openSnapOverlays([PRIMARY])
    const handler = h.handlers.get(IPC.SNAP_OVERLAY_READY)!
    expect(() => handler({ sender: { id: 99999 } })).toThrow()
    answer(windows()[0], { kind: 'cancel' })
    await p
  })

  it('focuses the window under the pointer once every page is ready', async () => {
    h.cursor.x = -600
    h.cursor.y = 300
    const p = openSnapOverlays([PRIMARY, LEFT])
    ready(windows()[0])
    ready(windows()[1])
    expect(windows()[1].focus).toHaveBeenCalled()
    answer(windows()[0], { kind: 'cancel' })
    await p
  })
})

describe('the answer', () => {
  it('a rectangle names the display it was drawn on, in DIP within that display', async () => {
    const p = openSnapOverlays([PRIMARY, LEFT])
    ready(windows()[0]); ready(windows()[1])
    answer(windows()[1], { kind: 'rect', rect: { x: 100, y: 50, width: 200, height: 120 } })
    await expect(p).resolves.toEqual({ id: 2, rect: { x: 100, y: 50, width: 200, height: 120 } })
  })

  it('a rectangle past the display edge is clamped to the display', async () => {
    const p = openSnapOverlays([PRIMARY])
    ready(windows()[0])
    answer(windows()[0], { kind: 'rect', rect: { x: -50, y: 1000, width: 4000, height: 500 } })
    await expect(p).resolves.toEqual({ id: 1, rect: { x: 0, y: 1000, width: 1920, height: 80 } })
  })

  it('a rectangle with nothing on the display, or not a rectangle, is not an answer', async () => {
    const p = openSnapOverlays([PRIMARY])
    ready(windows()[0])
    answer(windows()[0], { kind: 'rect', rect: { x: 3000, y: 0, width: 100, height: 100 } })
    answer(windows()[0], { kind: 'rect', rect: { x: 10, y: 10, width: Number.NaN, height: 100 } })
    answer(windows()[0], { kind: 'rect', rect: { x: 10, y: 10, width: 1, height: 1 } })
    answer(windows()[0], { kind: 'rect' })
    answer(windows()[0], 'whole')
    answer(windows()[0], null)
    expect(windows()[0].destroyed).toBe(false)
    answer(windows()[0], { kind: 'whole' })
    await expect(p).resolves.toEqual({ id: 1, whole: true })
  })

  it('Whole screen names its display', async () => {
    const p = openSnapOverlays([PRIMARY, LEFT])
    answer(windows()[1], { kind: 'whole' })
    await expect(p).resolves.toEqual({ id: 2, whole: true })
  })

  it('the first answer from any display closes every window and ends the IPC', async () => {
    const p = openSnapOverlays([PRIMARY, LEFT])
    ready(windows()[0]); ready(windows()[1])
    answer(windows()[0], { kind: 'whole' })
    answer(windows()[1], { kind: 'rect', rect: { x: 0, y: 0, width: 50, height: 50 } })
    await expect(p).resolves.toEqual({ id: 1, whole: true })
    expect(allDestroyed()).toBe(true)
    expect(h.handlers.has(IPC.SNAP_OVERLAY_READY)).toBe(false)
    expect(h.listeners.get(IPC.SNAP_OVERLAY_ANSWER)?.size ?? 0).toBe(0)
  })

  it('an answer from anything but an overlay page is ignored', async () => {
    const p = openSnapOverlays([PRIMARY])
    for (const fn of h.listeners.get(IPC.SNAP_OVERLAY_ANSWER) ?? []) fn({ sender: { id: 99999 } }, { kind: 'whole' })
    expect(windows()[0].destroyed).toBe(false)
    answer(windows()[0], { kind: 'cancel' })
    await expect(p).resolves.toBeNull()
  })

  it('Cancel answers null and closes every window', async () => {
    const p = openSnapOverlays([PRIMARY, LEFT])
    answer(windows()[1], { kind: 'cancel' })
    await expect(p).resolves.toBeNull()
    expect(allDestroyed()).toBe(true)
  })
})

describe('main owns the way out', () => {
  it('Escape is taken in main, before the page: null, every window closed', async () => {
    const p = openSnapOverlays([PRIMARY, LEFT])
    ready(windows()[0]); ready(windows()[1])
    const other = { preventDefault: vi.fn() }
    windows()[0].webContents.emit('before-input-event', other, { type: 'keyDown', key: 'a' })
    windows()[0].webContents.emit('before-input-event', other, { type: 'keyUp', key: 'Escape' })
    expect(other.preventDefault).not.toHaveBeenCalled()
    expect(windows()[0].destroyed).toBe(false)
    const esc = { preventDefault: vi.fn() }
    windows()[0].webContents.emit('before-input-event', esc, { type: 'keyDown', key: 'Escape' })
    expect(esc.preventDefault).toHaveBeenCalled()
    expect(allDestroyed()).toBe(true)
    await expect(p).resolves.toBeNull()
  })

  it('Escape works on a page that never became ready', async () => {
    const p = openSnapOverlays([PRIMARY])
    windows()[0].webContents.emit('before-input-event', { preventDefault: vi.fn() }, { type: 'keyDown', key: 'Escape' })
    expect(windows()[0].destroyed).toBe(true)
    await expect(p).resolves.toBeNull()
  })

  it('a close request (Alt+F4) is the user leaving: null, every window closed, the close not held', async () => {
    const p = openSnapOverlays([PRIMARY, LEFT])
    // As Electron does: 'close', then, when nothing prevented it, the window goes.
    const close = { preventDefault: vi.fn() }
    windows()[1].emit('close', close)
    expect(close.preventDefault).not.toHaveBeenCalled()
    expect(windows()[0].destroyed).toBe(true)
    windows()[1].destroy()
    await expect(p).resolves.toBeNull()
    expect(allDestroyed()).toBe(true)
  })

  it('a page that fails to load: every window closed, failed with the reason', async () => {
    const p = openSnapOverlays([PRIMARY, LEFT])
    windows()[1].webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true)
    expect(allDestroyed()).toBe(true)
    expect(await failureOf(p)).toBe('load-failed')
  })

  it('an aborted load (the refused navigation) and a sub-frame failure are not a failed page', async () => {
    const p = openSnapOverlays([PRIMARY])
    windows()[0].webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///x', true)
    windows()[0].webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///y', false)
    expect(windows()[0].destroyed).toBe(false)
    answer(windows()[0], { kind: 'cancel' })
    await expect(p).resolves.toBeNull()
  })

  it('a renderer that goes: every window closed, failed with the reason', async () => {
    const p = openSnapOverlays([PRIMARY, LEFT])
    ready(windows()[0]); ready(windows()[1])
    windows()[0].webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(allDestroyed()).toBe(true)
    expect(await failureOf(p)).toBe('renderer-gone')
  })

  it('a window destroyed without a close request: every window closed, failed with the reason', async () => {
    const p = openSnapOverlays([PRIMARY, LEFT])
    windows()[0].destroy()
    expect(allDestroyed()).toBe(true)
    expect(await failureOf(p)).toBe('window-closed')
  })

  it('no ready from a page within the bound: every window closed, failed with the reason', async () => {
    const p = openSnapOverlays([PRIMARY, LEFT], { readyTimeoutMs: 1000 })
    ready(windows()[0])
    vi.advanceTimersByTime(999)
    expect(windows()[0].destroyed).toBe(false)
    vi.advanceTimersByTime(1)
    expect(allDestroyed()).toBe(true)
    expect(await failureOf(p)).toBe('no-ready')
  })

  it('the bound defaults to SNAP_OVERLAY_READY_MS and stops once every page is ready', async () => {
    const p = openSnapOverlays([PRIMARY])
    vi.advanceTimersByTime(SNAP_OVERLAY_READY_MS - 1)
    ready(windows()[0])
    vi.advanceTimersByTime(SNAP_OVERLAY_READY_MS * 10)
    expect(windows()[0].destroyed).toBe(false)
    answer(windows()[0], { kind: 'whole' })
    await expect(p).resolves.toEqual({ id: 1, whole: true })
  })

  it('a window that cannot be made: nothing left open, failed with the reason', async () => {
    h.FakeWindow.failOn = 1
    expect(await failureOf(openSnapOverlays([PRIMARY]))).toBe('window-failed')
    expect(windows()).toHaveLength(0)
    // The second display's window fails after the first was made: the first is closed.
    h.FakeWindow.made = 0
    h.FakeWindow.failOn = 2
    expect(await failureOf(openSnapOverlays([PRIMARY, LEFT]))).toBe('window-failed')
    expect(windows()).toHaveLength(1)
    expect(allDestroyed()).toBe(true)
    expect(h.handlers.has(IPC.SNAP_OVERLAY_READY)).toBe(false)
    expect(h.listeners.get(IPC.SNAP_OVERLAY_ANSWER)?.size ?? 0).toBe(0)
  })
})

describe('one overlay at a time, and bad input', () => {
  it('a second open while one is up is refused, and the first is untouched', async () => {
    const p = openSnapOverlays([PRIMARY])
    expect(await failureOf(openSnapOverlays([PRIMARY]))).toBe('busy')
    expect(windows()).toHaveLength(1)
    answer(windows()[0], { kind: 'cancel' })
    await expect(p).resolves.toBeNull()
    // ...and once it is settled the next open works.
    const q = openSnapOverlays([PRIMARY])
    answer(windows()[1], { kind: 'whole' })
    await expect(q).resolves.toEqual({ id: 1, whole: true })
  })

  it('no display, or a display with no size or no picture, opens nothing', async () => {
    expect(await failureOf(openSnapOverlays([]))).toBe('no-displays')
    expect(await failureOf(openSnapOverlays([{ ...PRIMARY, dipBounds: { x: 0, y: 0, width: 0, height: 1080 } }]))).toBe('bad-display')
    const empty = { isEmpty: () => true, toJPEG: () => Buffer.alloc(0) } as unknown as SnapOverlayDisplay['picture']
    expect(await failureOf(openSnapOverlays([{ ...PRIMARY, picture: empty }]))).toBe('bad-display')
    expect(windows()).toHaveLength(0)
  })
})

describe('the overlay preload', () => {
  const root = join(__dirname, '../../..')
  const source = readFileSync(join(root, 'src/preload/snap-overlay.ts'), 'utf-8')

  it('loads nothing but electron (a sandboxed preload is one file: no code shared with the main preload)', () => {
    const specifiers = [...source.matchAll(/^\s*import\s+(?!type\b)[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(specifiers).toEqual(['electron'])
    expect(source).not.toMatch(/\brequire\s*\(/)
  })

  it('names the two channels exactly as ipc-channels.ts does, and exposes two calls', () => {
    expect(source).toContain(`'${IPC.SNAP_OVERLAY_READY}'`)
    expect(source).toContain(`'${IPC.SNAP_OVERLAY_ANSWER}'`)
    const exposed = source.match(/exposeInMainWorld\(\s*'snapOverlay'\s*,\s*\{([\s\S]*?)\}\s*\)/)
    expect(exposed).not.toBeNull()
    const calls = [...exposed![1].matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1])
    expect(calls).toEqual(['ready', 'answer'])
  })
})
