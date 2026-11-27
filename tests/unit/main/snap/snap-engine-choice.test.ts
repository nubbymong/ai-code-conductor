import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Which Snap a press uses (plan 2.1.3-beta.16 A1, aicc_planning#401): on
 * Windows the choice saved in Settings, Custom Commands, Snap, else the
 * default; on macOS and Linux always the previous Snap (the capture mode exits
 * 4 there). The IPC handler reads the saved choice at each press and hands
 * captureRectangle the new engine on Windows unless Previous is saved.
 * Not checked here: the press itself (engine.test.ts, capture-rectangle-engine.test.ts).
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()
let SAVED: unknown = undefined
const captureRectangle = vi.fn(async (..._args: unknown[]) => 'C:\\res\\screenshots\\x.jpg')
const snapOnWindows = vi.fn(async () => ({ kind: 'cancelled' as const }))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) } },
  BrowserWindow: class {},
}))
vi.mock('../../../../src/main/screenshot-capture', () => ({
  captureRectangle: (...args: unknown[]) => captureRectangle(...args),
  captureWindow: vi.fn(),
  listWindows: vi.fn(),
  cleanupOldScreenshots: vi.fn(),
  saveSnapPicture: vi.fn(),
}))
vi.mock('../../../../src/main/config-manager', () => ({
  readConfig: (key: string) => (key === 'magicButtons' ? (SAVED === undefined ? { screenshotColor: '#00FFFF' } : { screenshotColor: '#00FFFF', snapEngineWindows: SAVED }) : null),
}))
vi.mock('../../../../src/main/snap/windows-engine', () => ({
  snapOnWindows: (...args: unknown[]) => snapOnWindows(...(args as [])),
}))

const { registerScreenshotHandlers } = await import('../../../../src/main/ipc/screenshot-handlers')
const { snapEngineFor, savedSnapEngine, SNAP_ENGINE_DEFAULT_WINDOWS } = await import('../../../../src/shared/snap-engine')

const win = { isDestroyed: () => false }

/** Press Snap, Rectangle once on `platform`, and say whether the new engine was handed over. */
async function press(platform: string): Promise<boolean> {
  handlers.clear()
  registerScreenshotHandlers(() => win as never, platform)
  captureRectangle.mockClear()
  snapOnWindows.mockClear()
  await handlers.get('screenshot:captureRectangle')!({})
  expect(captureRectangle).toHaveBeenCalledTimes(1)
  const engine = captureRectangle.mock.calls[0][2] as undefined | (() => Promise<unknown>)
  if (engine === undefined) return false
  await engine()
  expect(snapOnWindows).toHaveBeenCalledTimes(1)
  return true
}

beforeEach(() => { SAVED = undefined })

describe('snapEngineFor: Windows takes the saved choice or the default; macOS and Linux the previous Snap', () => {
  it('on Windows: a saved choice is kept, and nothing saved is the default', () => {
    expect(snapEngineFor('win32', 'new')).toBe('new')
    expect(snapEngineFor('win32', 'previous')).toBe('previous')
    expect(snapEngineFor('win32', undefined)).toBe(SNAP_ENGINE_DEFAULT_WINDOWS)
    expect(snapEngineFor('win32', 'something else')).toBe(SNAP_ENGINE_DEFAULT_WINDOWS)
  })

  it('the default on Windows is the new Snap (S8 step 3), and a saved Previous is kept', () => {
    expect(SNAP_ENGINE_DEFAULT_WINDOWS).toBe('new')
    expect(snapEngineFor('win32', undefined)).toBe('new')
    expect(snapEngineFor('win32', 'previous')).toBe('previous')
  })

  it('on macOS and Linux: the previous Snap, whatever is saved', () => {
    for (const platform of ['darwin', 'linux']) for (const saved of ['new', 'previous', undefined]) expect(snapEngineFor(platform, saved), `${platform} ${String(saved)}`).toBe('previous')
  })

  it('reads only the two choices as a saved one', () => {
    expect(savedSnapEngine('new')).toBe('new')
    expect(savedSnapEngine('previous')).toBe('previous')
    for (const v of [undefined, null, '', 'New', 1, {}]) expect(savedSnapEngine(v)).toBeNull()
  })
})

describe('the Snap handler: the new engine reaches captureRectangle on Windows unless Previous is saved, and never on macOS or Linux', () => {
  it('Windows, New saved: the press runs the new engine first', async () => {
    SAVED = 'new'
    expect(await press('win32')).toBe(true)
  })

  it('Windows, nothing saved (or something that is not a choice): the new engine, the default', async () => {
    SAVED = undefined
    expect(await press('win32')).toBe(true)
    SAVED = 'New'
    expect(await press('win32')).toBe(true)
  })

  it('Windows, Previous saved: the package, and the saved choice is kept over the default', async () => {
    SAVED = 'previous'
    expect(await press('win32')).toBe(false)
  })

  it('macOS and Linux with New saved: the package', async () => {
    SAVED = 'new'
    expect(await press('darwin')).toBe(false)
    expect(await press('linux')).toBe(false)
  })

  it('no window: no press at all', async () => {
    handlers.clear()
    registerScreenshotHandlers(() => null, 'win32')
    captureRectangle.mockClear()
    expect(await handlers.get('screenshot:captureRectangle')!({})).toBeNull()
    expect(captureRectangle).not.toHaveBeenCalled()
  })
})
