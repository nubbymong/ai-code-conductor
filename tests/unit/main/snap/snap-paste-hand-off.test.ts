import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Snap's picture goes to the paste module in main, never as a path to the
 * renderer (ADR-032; plan 2.1.3-beta.21 phase 2, 2.1.5). Both of Snap's
 * items, Rectangle and Window, answer what the paste did (`snapped`) and no
 * path; the saved file is still saved (the capture's own), and only the path
 * route behind the test switch answers it, with the session's image line.
 * A capture that names no session is not made.
 *
 * Red on 0c54a1c6: both items answered the saved file's path to the
 * renderer, and named no session. Mutant this must catch: Window still sends
 * its path.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const FILE = 'C:\\res\\screenshots\\screenshot-2026-11-28-101500.jpg'
const captureRectangle = vi.fn(async (..._args: unknown[]): Promise<unknown> => FILE)
const captureWindow = vi.fn(async (..._args: unknown[]): Promise<unknown> => FILE)

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) } },
  BrowserWindow: class {},
}))
vi.mock('../../../../src/main/screenshot-capture', () => ({
  captureRectangle: (...args: unknown[]) => captureRectangle(...args),
  captureWindow: (...args: unknown[]) => captureWindow(...args),
  listWindows: vi.fn(),
  cleanupOldScreenshots: vi.fn(),
  saveSnapPicture: vi.fn(),
}))
vi.mock('../../../../src/main/config-manager', () => ({ readConfig: () => ({ snapEngineWindows: 'new' }) }))
vi.mock('../../../../src/main/snap/windows-engine', () => ({ snapOnWindows: vi.fn(async () => ({ kind: 'cancelled' as const })) }))

const { registerScreenshotHandlers } = await import('../../../../src/main/ipc/screenshot-handlers')

const win = { isDestroyed: () => false }
let pathRoute = false
const snapPaste = {
  pathRoute: () => pathRoute,
  pathRouteAnswer: vi.fn(async (_sessionId: string, file: string) => ({ pathRoute: { file, line: 'composer' as const } })),
  paste: vi.fn(async (_sessionId: string, _file: string, _item: string) => ({ snapped: { outcome: 'sent' as const } })),
}

beforeEach(() => {
  handlers.clear()
  pathRoute = false
  captureRectangle.mockClear()
  captureWindow.mockClear()
  captureRectangle.mockImplementation(async () => FILE)
  captureWindow.mockImplementation(async () => FILE)
  snapPaste.paste.mockClear()
  snapPaste.pathRouteAnswer.mockClear()
  registerScreenshotHandlers(() => win as never, 'win32', snapPaste)
})

const rectangle = (sessionId?: unknown) => handlers.get('screenshot:captureRectangle')!({}, sessionId)
const windowItem = (sessionId?: unknown) => handlers.get('screenshot:captureWindow')!({}, 'window:42:0', sessionId)

describe('Snap hands its picture to the paste module: no path reaches the renderer', () => {
  it('Rectangle: the saved picture goes to the paste for its session, and the answer is the paste\'s, with no path', async () => {
    const answer = await rectangle('tab-1')
    expect(snapPaste.paste).toHaveBeenCalledWith('tab-1', FILE, 'rectangle')
    expect(answer).toEqual({ snapped: { outcome: 'sent' } })
    expect(JSON.stringify(answer)).not.toContain('screenshot-2026')
  })

  it('Window: the same, by its own item, with no path', async () => {
    const answer = await windowItem('tab-1')
    expect(captureWindow).toHaveBeenCalledWith('window:42:0')
    expect(snapPaste.paste).toHaveBeenCalledWith('tab-1', FILE, 'window')
    expect(answer).toEqual({ snapped: { outcome: 'sent' } })
    expect(JSON.stringify(answer)).not.toContain('screenshot-2026')
  })

  it('a capture that names no session (or a bad one) is not made', async () => {
    for (const bad of [undefined, '', 42, 'x'.repeat(201)]) {
      expect(await rectangle(bad)).toBeNull()
    }
    expect(captureRectangle).not.toHaveBeenCalled()
    await expect(windowItem(undefined)).rejects.toThrow(/Invalid parameters/)
    expect(captureWindow).not.toHaveBeenCalled()
    expect(snapPaste.paste).not.toHaveBeenCalled()
  })

  it('a press that captured nothing pastes nothing, and a press with no desktop says so', async () => {
    captureRectangle.mockImplementation(async () => null)
    expect(await rectangle('tab-1')).toBeNull()
    captureRectangle.mockImplementation(async () => ({ notCaptured: 'no-desktop' }))
    expect(await rectangle('tab-1')).toEqual({ notCaptured: 'no-desktop' })
    captureWindow.mockImplementation(async () => null)
    expect(await windowItem('tab-1')).toBeNull()
    expect(snapPaste.paste).not.toHaveBeenCalled()
  })

  it('the path route behind the test switch only: the file and the session\'s line, for the beta.20 flow, and no paste', async () => {
    pathRoute = true
    expect(await rectangle('tab-1')).toEqual({ pathRoute: { file: FILE, line: 'composer' } })
    expect(await windowItem('tab-1')).toEqual({ pathRoute: { file: FILE, line: 'composer' } })
    expect(snapPaste.paste).not.toHaveBeenCalled()
  })
})
