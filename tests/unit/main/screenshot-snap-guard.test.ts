// Snap on macOS: the Screen Recording permission is checked before a capture
// starts, and a capture that throws answers nothing instead of reaching the
// uncaught-exception handler. The permission state is a fake and the capture
// library is a stand-in that can throw, so this runs on any OS and captures
// nothing. (What makes Snap close the app on a Mac is not known; these tests
// pin the guard, not a cause.)
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lib = vi.hoisted(() => ({
  constructed: 0,
  startCalls: 0,
  mode: 'cancel' as 'cancel' | 'construct-throws' | 'start-throws' | 'start-rejects',
  windowLists: 0,
  windows: [] as Array<{ id: string; name: string; thumbnail: unknown }>,
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  desktopCapturer: {
    getSources: async (opts: { types?: string[] }) => {
      if (!opts?.types?.includes('window')) return []
      lib.windowLists++
      return lib.windows
    },
  },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  shell: { openExternal: async () => {} },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
}))
vi.mock('electron-screenshots', () => ({
  default: class FakeScreenshots {
    private handlers = new Map<string, () => void>()
    constructor() {
      lib.constructed++
      if (lib.mode === 'construct-throws') throw new Error('native add-on failed to load')
    }
    on(event: string, fn: () => void) { this.handlers.set(event, fn); return this }
    removeAllListeners() { this.handlers.clear(); return this }
    startCapture(): Promise<void> {
      lib.startCalls++
      // A throw before any promise exists, as a native add-on can do.
      if (lib.mode === 'start-throws') throw new Error('capture could not start')
      return (async () => {
        if (lib.mode === 'start-rejects') throw new Error('capture rejected')
        this.handlers.get('cancel')?.()
      })()
    }
  },
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/mock/resources' }))
vi.mock('../../../src/main/clipboard-file', () => ({ isReapableImageFile: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { captureRectangle, listWindows } = await import('../../../src/main/screenshot-capture')
const { screenCaptureAllowed, SCREEN_RECORDING_SETTINGS_URL, SCREEN_RECORDING_NEEDED_MESSAGE, SCREEN_RECORDING_RESTRICTED_MESSAGE, PROMPT_SETTLE_MS } = await import('../../../src/main/screenshot-permission')
type Deps = import('../../../src/main/screenshot-permission').ScreenPermissionDeps

const win = { isDestroyed: () => false } as never

/** A stand-in window thumbnail; its PNG is the bytes of "png". */
const thumb = (empty: boolean) => ({ isEmpty: () => empty, toPNG: () => Buffer.from('png') })

/** A permission state to test with, and what was asked of it. */
function fake(status: string, over: Partial<Deps> = {}, answer = false, statusAfterPrompt?: string) {
  const calls = { status: 0, prompted: 0, settled: [] as number[], statusAtSettle: 0, asked: [] as Array<{ message: string; canOpen: boolean }>, opened: [] as string[] }
  const deps: Deps = {
    platform: 'darwin',
    status: () => { calls.status++; return calls.prompted > 0 && statusAfterPrompt !== undefined ? statusAfterPrompt : status },
    prompt: async () => { calls.prompted++ },
    settle: async (ms) => { calls.settled.push(ms); calls.statusAtSettle = calls.status },
    ask: async (message, canOpen) => { calls.asked.push({ message, canOpen }); return answer },
    open: (url) => { calls.opened.push(url) },
    ...over,
  }
  return { deps, calls }
}

beforeEach(() => {
  lib.constructed = 0
  lib.startCalls = 0
  lib.mode = 'cancel'
  lib.windowLists = 0
  lib.windows = []
})

describe('screenCaptureAllowed: the Screen Recording permission on macOS', () => {
  it('lets a capture start when the system says it is granted, and asks the user nothing', async () => {
    const { deps, calls } = fake('granted')
    expect(await screenCaptureAllowed(deps)).toBe(true)
    expect(calls.asked).toEqual([])
  })

  it('lets the capture start, with no message, when the app has not been asked yet, so macOS shows its own prompt', async () => {
    for (const status of ['not-determined', 'unknown']) {
      const { deps, calls } = fake(status)
      expect(await screenCaptureAllowed(deps), status).toBe(true)
      expect(calls.asked, status).toEqual([])
      expect(calls.prompted, status).toBe(0)
    }
  })

  it('makes one capture request, then says so and does not capture, when the denial still stands', async () => {
    const { deps, calls } = fake('denied')
    expect(await screenCaptureAllowed(deps)).toBe(false)
    expect(calls.prompted).toBe(1)
    expect(calls.asked).toEqual([{ message: SCREEN_RECORDING_NEEDED_MESSAGE, canOpen: true }])
    expect(SCREEN_RECORDING_NEEDED_MESSAGE).toMatch(/Screen Recording/)
    expect(SCREEN_RECORDING_NEEDED_MESSAGE).toMatch(/System Settings, Privacy and Security/)
  })

  it('waits briefly after the request before it reads the permission again, so macOS can show its own prompt first', async () => {
    const { deps, calls } = fake('denied')
    await screenCaptureAllowed(deps)
    expect(calls.settled).toEqual([PROMPT_SETTLE_MS])
    expect(PROMPT_SETTLE_MS).toBeGreaterThan(0)
    // One read before the request; the second read comes only after the wait.
    expect(calls.statusAtSettle).toBe(1)
    expect(calls.status).toBe(2)
  })

  it('does not wait when no request was made', async () => {
    for (const status of ['granted', 'not-determined', 'unknown', 'restricted']) {
      const { deps, calls } = fake(status)
      await screenCaptureAllowed(deps)
      expect(calls.settled, status).toEqual([])
    }
  })

  it('shows no message when the request leaves the permission granted or still to be decided', async () => {
    for (const after of ['granted', 'not-determined']) {
      const { deps, calls } = fake('denied', {}, false, after)
      expect(await screenCaptureAllowed(deps), after).toBe(true)
      expect(calls.prompted, after).toBe(1)
      expect(calls.asked, after).toEqual([])
    }
  })

  it('still shows the message when the capture request itself fails', async () => {
    const { deps, calls } = fake('denied', { prompt: async () => { throw new Error('no capture') } })
    expect(await screenCaptureAllowed(deps)).toBe(false)
    expect(calls.asked).toHaveLength(1)
  })

  it('makes no capture request for a policy block', async () => {
    const { deps, calls } = fake('restricted')
    expect(await screenCaptureAllowed(deps)).toBe(false)
    expect(calls.prompted).toBe(0)
  })

  it('opens System Settings at the Screen Recording pane when the user chooses to', async () => {
    const { deps, calls } = fake('denied', {}, true)
    expect(await screenCaptureAllowed(deps)).toBe(false)
    expect(calls.opened).toEqual([SCREEN_RECORDING_SETTINGS_URL])
    expect(SCREEN_RECORDING_SETTINGS_URL).toContain('Privacy_ScreenCapture')
  })

  it('opens nothing when the user declines', async () => {
    const { deps, calls } = fake('denied', {}, false)
    expect(await screenCaptureAllowed(deps)).toBe(false)
    expect(calls.opened).toEqual([])
  })

  it('tells a policy-blocked Mac so, with nothing to open', async () => {
    const { deps, calls } = fake('restricted', {}, true)
    expect(await screenCaptureAllowed(deps)).toBe(false)
    expect(calls.asked).toEqual([{ message: SCREEN_RECORDING_RESTRICTED_MESSAGE, canOpen: false }])
    expect(calls.opened).toEqual([])
  })

  it('does not look at the permission off macOS', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const { deps, calls } = fake('denied', { platform })
      expect(await screenCaptureAllowed(deps), platform).toBe(true)
      expect(calls.status, platform).toBe(0)
      expect(calls.asked, platform).toEqual([])
    }
  })

  it('lets the capture try when the system cannot answer, and never throws', async () => {
    expect(await screenCaptureAllowed(fake('denied', { status: () => { throw new Error('no answer') } }).deps)).toBe(true)
  })

  it('answers false, and does not throw, when the message cannot be shown', async () => {
    const { deps } = fake('denied', { ask: async () => { throw new Error('no window') } })
    expect(await screenCaptureAllowed(deps)).toBe(false)
  })
})

describe('captureRectangle with the permission check and a throwing capture', () => {
  it('starts no capture and answers nothing while the permission is off', async () => {
    const { deps, calls } = fake('denied')
    expect(await captureRectangle(win, deps)).toBeNull()
    expect(calls.asked).toHaveLength(1)
    expect(lib.constructed).toBe(0)
    expect(lib.startCalls).toBe(0)
  })

  it('starts the capture when the permission is granted', async () => {
    const { deps } = fake('granted')
    expect(await captureRectangle(win, deps)).toBeNull() // the stand-in answers cancel
    expect(lib.startCalls).toBe(1)
  })

  it('starts the capture, with no message, when the app has never asked for the permission', async () => {
    const { deps, calls } = fake('not-determined')
    expect(await captureRectangle(win, deps)).toBeNull() // the stand-in answers cancel
    expect(lib.startCalls).toBe(1)
    expect(calls.asked).toEqual([])
  })

  it('answers nothing, not an error, when the capture library cannot be started', async () => {
    // The library is made once and kept, so this needs the module as it is before the first Snap.
    vi.resetModules()
    const fresh = await import('../../../src/main/screenshot-capture')
    lib.mode = 'construct-throws'
    await expect(fresh.captureRectangle(win, fake('granted').deps)).resolves.toBeNull()
    expect(lib.constructed).toBe(1)
    lib.mode = 'cancel'
    await expect(fresh.captureRectangle(win, fake('granted').deps)).resolves.toBeNull()
    expect(lib.startCalls).toBe(1)
  })

  it('answers nothing, not an error, when starting the capture throws', async () => {
    lib.mode = 'start-throws'
    await expect(captureRectangle(win, fake('granted').deps)).resolves.toBeNull()
    lib.mode = 'start-rejects'
    await expect(captureRectangle(win, fake('granted').deps)).resolves.toBeNull()
  })

  it('lets the next Snap run after one that failed', async () => {
    lib.mode = 'start-throws'
    await expect(captureRectangle(win, fake('granted').deps)).resolves.toBeNull()
    lib.mode = 'cancel'
    const before = lib.startCalls
    await expect(captureRectangle(win, fake('granted').deps)).resolves.toBeNull()
    expect(lib.startCalls).toBe(before + 1)
  })

  it('lets the next Snap run after a refused one', async () => {
    await expect(captureRectangle(win, fake('denied').deps)).resolves.toBeNull()
    await expect(captureRectangle(win, fake('granted').deps)).resolves.toBeNull()
    expect(lib.startCalls).toBe(1)
  })
})

describe('listWindows (Snap, Window) with the permission check', () => {
  it('lists nothing and asks for no windows while the permission is off, after saying so', async () => {
    lib.windows = [{ id: 'window:1', name: 'Editor', thumbnail: thumb(false) }]
    const { deps, calls } = fake('denied')
    expect(await listWindows(win, deps)).toEqual([])
    expect(calls.asked).toEqual([{ message: SCREEN_RECORDING_NEEDED_MESSAGE, canOpen: true }])
    expect(lib.windowLists).toBe(0)
  })

  it('lists the windows when the permission is granted, and asks the user nothing', async () => {
    lib.windows = [{ id: 'window:1', name: 'Editor', thumbnail: thumb(false) }]
    const { deps, calls } = fake('granted')
    expect(await listWindows(win, deps)).toEqual([{ id: 'window:1', name: 'Editor', thumbnail: 'cG5n' }])
    expect(calls.asked).toEqual([])
    expect(lib.windowLists).toBe(1)
  })

  it('lists the windows, with no message, when the app has never asked, so macOS shows its own prompt', async () => {
    const { deps, calls } = fake('not-determined')
    expect(await listWindows(win, deps)).toEqual([])
    expect(calls.asked).toEqual([])
    expect(lib.windowLists).toBe(1)
  })

  it('does not look at the permission off macOS', async () => {
    const { deps, calls } = fake('denied', { platform: 'win32' })
    await listWindows(win, deps)
    expect(calls.status).toBe(0)
    expect(lib.windowLists).toBe(1)
  })
})
