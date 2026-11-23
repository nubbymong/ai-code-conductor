import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * captureRectangle with the new Snap (plan 2.1.3-beta.16 A1,
 * aicc_planning#401): the new engine runs first; a picture it saved is the
 * answer; Escape and exit 3 answer nothing; anything it hands on (or a throw)
 * starts the previous Snap, electron-screenshots, for that same press. The
 * package is a stand-in that counts its starts and answers Cancel.
 * Not checked here: the engine's own steps (engine.test.ts).
 */

const lib = vi.hoisted(() => ({ constructed: 0, startCalls: 0, warns: [] as string[] }))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  desktopCapturer: { getSources: async () => [] },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }), createFromBitmap: () => ({ isEmpty: () => true }) },
  shell: { openExternal: async () => {} },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
}))
vi.mock('electron-screenshots', () => ({
  default: class FakeScreenshots {
    private handlers = new Map<string, () => void>()
    constructor() { lib.constructed++ }
    on(event: string, fn: () => void) { this.handlers.set(event, fn); return this }
    removeAllListeners() { this.handlers.clear(); return this }
    startCapture(): Promise<void> {
      lib.startCalls++
      return (async () => { this.handlers.get('cancel')?.() })()
    }
  },
}))
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/mock/resources' }))
vi.mock('../../../../src/main/clipboard-file', () => ({ isReapableImageFile: () => false }))
vi.mock('../../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: (l: string) => { lib.warns.push(l) }, logError: vi.fn() }))

const { captureRectangle } = await import('../../../../src/main/screenshot-capture')
type Outcome = import('../../../../src/main/screenshot-capture').NewSnapOutcome

const win = { isDestroyed: () => false } as never
// Windows: no Screen Recording check.
const windows = { platform: 'win32', status: () => 'granted', prompt: async () => {}, ask: async () => false, open: () => {} } as never

const engine = (outcome: Outcome | Error) => vi.fn(async () => {
  if (outcome instanceof Error) throw outcome
  return outcome
})

beforeEach(() => {
  lib.startCalls = 0
  lib.warns = []
})

describe('captureRectangle with the new Snap', () => {
  it('a picture the new Snap saved is the answer, and the package never starts', async () => {
    const e = engine({ kind: 'saved', file: '/mock/resources/screenshots/screenshot-1.jpg' })
    expect(await captureRectangle(win, windows, e)).toBe('/mock/resources/screenshots/screenshot-1.jpg')
    expect(e).toHaveBeenCalledTimes(1)
    expect(lib.startCalls).toBe(0)
  })

  it('Escape answers nothing, and the package never starts', async () => {
    expect(await captureRectangle(win, windows, engine({ kind: 'cancelled' }))).toBeNull()
    expect(lib.startCalls).toBe(0)
  })

  it('exit 3 (no desktop to capture) answers nothing, and the package never starts', async () => {
    expect(await captureRectangle(win, windows, engine({ kind: 'no-desktop' }))).toBeNull()
    expect(lib.startCalls).toBe(0)
  })

  it('a press the new Snap hands on starts the previous Snap for that same press', async () => {
    expect(await captureRectangle(win, windows, engine({ kind: 'previous', why: 'the overlay failed' }))).toBeNull()
    expect(lib.startCalls).toBe(1)
  })

  it('a throw from the new Snap starts the previous Snap too, with one line saying so', async () => {
    expect(await captureRectangle(win, windows, engine(new TypeError('x')))).toBeNull()
    expect(lib.startCalls).toBe(1)
    expect(lib.warns).toEqual(['[snap] new engine: an error (TypeError); the previous Snap takes this press'])
  })

  it('with no new engine given (Previous, macOS, Linux), the package as today', async () => {
    expect(await captureRectangle(win, windows)).toBeNull()
    expect(lib.startCalls).toBe(1)
  })

  it('a second press while one runs does nothing: the new Snap is not run twice', async () => {
    let release!: (o: Outcome) => void
    const slow = vi.fn(() => new Promise<Outcome>((r) => { release = r }))
    const first = captureRectangle(win, windows, slow)
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1))
    expect(await captureRectangle(win, windows, slow)).toBeNull()
    expect(slow).toHaveBeenCalledTimes(1)
    release({ kind: 'cancelled' })
    expect(await first).toBeNull()
  })
})
