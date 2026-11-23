import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The previous Snap's package (electron-screenshots) is loaded by the first
 * press that uses it, never at main's start (ADR-030 S8 step 3; plan
 * 2.1.3-beta.16 A1, aicc_planning#401): on Windows, where the new Snap is the
 * default, only a press with Previous chosen or one the new Snap hands on; on
 * macOS and Linux, the first press. A package that fails to load fails that
 * press only. Each test imports screenshot-capture.ts afresh, with a stand-in
 * package that counts its loads.
 * Not checked here: which Snap a press uses (snap-engine-choice.test.ts), the
 * new Snap's steps (engine.test.ts), what main loads in the built app
 * (snap-e2e's readings R1 and R2, tests/e2e/snap-windows.spec.ts).
 */

const lib = vi.hoisted(() => ({ loads: 0, constructed: 0, startCalls: 0 }))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  desktopCapturer: { getSources: async () => [] },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }), createFromBitmap: () => ({ isEmpty: () => true }) },
  shell: { openExternal: async () => {} },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
}))
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/mock/resources' }))
vi.mock('../../../../src/main/clipboard-file', () => ({ isReapableImageFile: () => false }))
vi.mock('../../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

/** The package as a stand-in: each start answers Cancel. */
class FakeScreenshots {
  private handlers = new Map<string, () => void>()
  constructor() { lib.constructed++ }
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
    if (opts.failLoad) throw new Error('the package failed to load')
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
})

describe('the previous Snap\'s package is loaded by the first press that uses it', () => {
  it('main\'s import of screenshot-capture loads nothing of it', async () => {
    await fresh()
    expect(lib.loads).toBe(0)
  })

  it('a press with no new Snap (Previous chosen, macOS, Linux) loads it then, once; a second press reuses it', async () => {
    const { captureRectangle } = await fresh()
    expect(lib.loads).toBe(0)
    expect(await captureRectangle(win, windows)).toBeNull()
    expect(lib.loads).toBe(1)
    expect(await captureRectangle(win, windows)).toBeNull()
    expect({ loads: lib.loads, constructed: lib.constructed, startCalls: lib.startCalls }).toEqual({ loads: 1, constructed: 1, startCalls: 2 })
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
