import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The previous Snap's package (electron-screenshots) is loaded by the first
 * press that uses it, never at main's start (ADR-030 S8 step 3; plan
 * 2.1.3-beta.16 A1, aicc_planning#401): on Windows, where the new Snap is the
 * default, only a press with Previous chosen or one the new Snap hands on; on
 * macOS and Linux, the first press. The package is made again at each press
 * (its page is closed once a press settles, aicc_planning#408); its files are
 * loaded once. A package that fails to load fails that press only. Each
 * press the previous Snap takes writes one line to app.log:
 * that its package loaded and takes the press, or that it could not be loaded
 * (the error's name and code only, never its message, which can hold a path).
 * Each test imports screenshot-capture.ts afresh, with a stand-in package that
 * counts its loads, and a stand-in logger that keeps every line.
 * Not checked here: which Snap a press uses (snap-engine-choice.test.ts), the
 * new Snap's steps (engine.test.ts), what main loads in the built app
 * (snap-e2e's readings R1 and R2, tests/e2e/snap-windows.spec.ts), the line in
 * the built app (snap-e2e's D8).
 */

const lib = vi.hoisted(() => ({ loads: 0, constructed: 0, startCalls: 0, lines: [] as string[], startError: null as Error | null }))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  desktopCapturer: { getSources: async () => [] },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  ipcMain: { removeAllListeners: () => {} },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }), createFromBitmap: () => ({ isEmpty: () => true }) },
  shell: { openExternal: async () => {} },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
}))
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/mock/resources' }))
vi.mock('../../../../src/main/clipboard-file', () => ({ isReapableImageFile: () => false }))
// The logger as a stand-in that keeps each line app.log would get.
vi.mock('../../../../src/main/debug-logger', () => {
  const keep = (...args: unknown[]) => { lib.lines.push(args.map(String).join(' ')) }
  return { logInfo: keep, logWarn: keep, logError: keep }
})

/** The package as a stand-in: each start answers Cancel; with `startError`
 *  set, making one throws it (the package loaded but could not start). */
class FakeScreenshots {
  private handlers = new Map<string, () => void>()
  constructor() {
    if (lib.startError) throw lib.startError
    lib.constructed++
  }
  on(event: string, fn: () => void) { this.handlers.set(event, fn); return this }
  removeAllListeners() { this.handlers.clear(); return this }
  startCapture(): Promise<void> {
    lib.startCalls++
    return (async () => { this.handlers.get('cancel')?.() })()
  }
}

/** screenshot-capture.ts imported afresh, the package a stand-in that counts
 *  each time it is loaded (or fails to load, with `failLoad`). */
async function fresh(opts: { failLoad?: boolean } = {}) {
  vi.resetModules()
  vi.doMock('electron-screenshots', () => {
    lib.loads++
    // A message that holds a path, as a real failed load's does. vitest hands
    // the import its own Error in place of this one, so the test that gives
    // the code a message with a path is the start failure (`startError`).
    if (opts.failLoad) throw new Error('Cannot find module C:\\app\\resources\\app.asar\\node_modules\\electron-screenshots\\lib\\index.js')
    return { default: FakeScreenshots }
  })
  return import('../../../../src/main/screenshot-capture')
}

const win = { isDestroyed: () => false } as never
// Windows: no Screen Recording check.
const windows = { platform: 'win32', status: () => 'granted', prompt: async () => {}, ask: async () => false, open: () => {} } as never

beforeEach(() => {
  lib.loads = 0
  lib.constructed = 0
  lib.startCalls = 0
  lib.lines = []
  lib.startError = null
})

const LOADED = '[snap] previous engine: loaded; it takes this press'
/** The lines app.log got about the previous Snap. */
const previousLines = () => lib.lines.filter((l) => l.startsWith('[snap] previous engine'))
/** A Windows path or the package folder in a line. */
const PATH_IN_LINE = /[A-Z]:\\|node_modules/

describe('the previous Snap\'s package is loaded by the first press that uses it', () => {
  it('main\'s import of screenshot-capture loads nothing of it', async () => {
    await fresh()
    expect(lib.loads).toBe(0)
  })

  it('a press with no new Snap (Previous chosen, macOS, Linux) loads it then, once; a second press makes the package again (its page was closed once the first press settled) and does not load it again', async () => {
    const { captureRectangle } = await fresh()
    expect(lib.loads).toBe(0)
    expect(await captureRectangle(win, windows)).toBeNull()
    expect(lib.loads).toBe(1)
    expect(await captureRectangle(win, windows)).toBeNull()
    expect({ loads: lib.loads, constructed: lib.constructed, startCalls: lib.startCalls }).toEqual({ loads: 1, constructed: 2, startCalls: 2 })
  })

  it('a press the new Snap answers (saved, cancelled, no desktop) never loads it', async () => {
    const { captureRectangle } = await fresh()
    expect(await captureRectangle(win, windows, async () => ({ kind: 'saved', file: '/mock/resources/screenshots/s.jpg' }))).toBe('/mock/resources/screenshots/s.jpg')
    expect(await captureRectangle(win, windows, async () => ({ kind: 'cancelled' }))).toBeNull()
    expect(await captureRectangle(win, windows, async () => ({ kind: 'no-desktop' }))).toBeNull()
    expect(lib.loads).toBe(0)
  })

  it('a press the new Snap hands on loads it for that press', async () => {
    const { captureRectangle } = await fresh()
    expect(lib.loads).toBe(0)
    expect(await captureRectangle(win, windows, async () => ({ kind: 'previous', why: 'the overlay failed' }))).toBeNull()
    expect({ loads: lib.loads, startCalls: lib.startCalls }).toEqual({ loads: 1, startCalls: 1 })
  })

  it('a package that fails to load fails only the press that needed it: main imports the file, the press answers nothing', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { captureRectangle } = await fresh({ failLoad: true })
      expect(lib.loads).toBe(0)
      await expect(captureRectangle(win, windows)).resolves.toBeNull()
      expect(lib.loads).toBe(1)
      expect(lib.startCalls).toBe(0)
    } finally {
      quiet.mockRestore()
    }
  })
})

describe('each press the previous Snap takes writes one line to app.log', () => {
  it('each press with no new Snap (Previous chosen, macOS, Linux) logs that the previous engine loaded and takes it: two presses, two lines', async () => {
    const { captureRectangle } = await fresh()
    expect(await captureRectangle(win, windows)).toBeNull()
    expect(previousLines()).toEqual([LOADED])
    expect(await captureRectangle(win, windows)).toBeNull()
    expect(previousLines()).toEqual([LOADED, LOADED])
  })

  it('a press the new Snap answers (saved, cancelled, no desktop) logs no previous-engine line; one it hands on logs exactly one', async () => {
    const { captureRectangle } = await fresh()
    await captureRectangle(win, windows, async () => ({ kind: 'saved', file: '/mock/resources/screenshots/s.jpg' }))
    await captureRectangle(win, windows, async () => ({ kind: 'cancelled' }))
    await captureRectangle(win, windows, async () => ({ kind: 'no-desktop' }))
    expect(previousLines()).toEqual([])
    await captureRectangle(win, windows, async () => ({ kind: 'previous', why: 'the overlay failed' }))
    expect(previousLines()).toEqual([LOADED])
  })

  it('a package that fails to load logs one line with the error\'s name, no path, and no loaded line', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { captureRectangle } = await fresh({ failLoad: true })
      await expect(captureRectangle(win, windows)).resolves.toBeNull()
      expect(previousLines()).toEqual(['[snap] previous engine: its package could not be loaded (Error); nothing captured'])
      expect(lib.lines.filter((l) => PATH_IN_LINE.test(l))).toEqual([])
    } finally {
      quiet.mockRestore()
    }
  })

  it('a package that loads but cannot start logs the error\'s name and code, never its message', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { captureRectangle } = await fresh()
      lib.startError = Object.assign(new TypeError('C:\\Users\\someone\\AppData\\Local\\app\\node_modules\\node-screenshots\\index.node'), { code: 'ERR_DLOPEN_FAILED' })
      await expect(captureRectangle(win, windows)).resolves.toBeNull()
      expect(previousLines()).toEqual(['[snap] previous engine: its package could not be loaded (TypeError ERR_DLOPEN_FAILED); nothing captured'])
      expect(lib.lines.filter((l) => PATH_IN_LINE.test(l))).toEqual([])
      expect(lib.startCalls).toBe(0)
    } finally {
      quiet.mockRestore()
    }
  })
})
