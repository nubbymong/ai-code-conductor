// A second launch while the app runs (the single-instance lock's
// 'second-instance' event) brings the main window forward, and never throws
// when that window is already gone: on Windows the app can outlive its window
// (a sign-in window finishing, the quit's teardown), and index.ts keeps the
// destroyed window's reference. Asking a destroyed window isMinimized() throws
// in the main process.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const logged: string[] = []
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (...a: unknown[]) => { logged.push(a.map(String).join(' ')) },
  logError: (...a: unknown[]) => { logged.push(a.map(String).join(' ')) },
  logWarn: (...a: unknown[]) => { logged.push(a.map(String).join(' ')) },
}))

const { focusExistingWindow } = await import('../../../src/main/second-instance')

/** A main window as Electron's behaves: once destroyed, any other call throws. */
function fakeWindow(opts: { destroyed?: boolean; minimized?: boolean } = {}) {
  const calls: string[] = []
  let destroyed = opts.destroyed === true
  const guard = (name: string) => {
    calls.push(name)
    if (destroyed) throw new TypeError('Object has been destroyed')
  }
  return {
    calls,
    destroy() { destroyed = true },
    isDestroyed() { calls.push('isDestroyed'); return destroyed },
    isMinimized() { guard('isMinimized'); return opts.minimized === true },
    restore() { guard('restore') },
    focus() { guard('focus') },
  }
}

beforeEach(() => { logged.length = 0 })

describe('a second launch with the main window gone', () => {
  it('a destroyed window: no throw, nothing asked of it but whether it is destroyed, one INFO line', () => {
    const win = fakeWindow({ destroyed: true })
    expect(() => focusExistingWindow(win)).not.toThrow()
    expect(win.calls).toEqual(['isDestroyed'])
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/launched again while its window is closed or closing/)
  })

  it('no window at all: no throw, one INFO line', () => {
    expect(() => focusExistingWindow(null)).not.toThrow()
    expect(() => focusExistingWindow(undefined)).not.toThrow()
    expect(logged).toHaveLength(2)
  })
})

describe('a second launch with the main window up', () => {
  it('a minimized window is restored, then focused', () => {
    const win = fakeWindow({ minimized: true })
    focusExistingWindow(win)
    expect(win.calls).toEqual(['isDestroyed', 'isMinimized', 'restore', 'focus'])
    expect(logged).toEqual([])
  })

  it('a window that is not minimized is only focused', () => {
    const win = fakeWindow()
    focusExistingWindow(win)
    expect(win.calls).toEqual(['isDestroyed', 'isMinimized', 'focus'])
  })
})

describe("index.ts hands its 'second-instance' event to focusExistingWindow", () => {
  // index.ts cannot be imported in a unit test (it boots the app): this pins
  // the listener's shape, as window-ipc-registered-once.test.ts does.
  const src = readFileSync(resolve(__dirname, '../../../src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')
  it('the listener calls focusExistingWindow(mainWindow) and asks the window nothing itself', () => {
    const at = src.indexOf("app.on('second-instance'")
    expect(at, "an app.on('second-instance') listener").toBeGreaterThan(0)
    const end = src.indexOf('\n    })', at)
    expect(end).toBeGreaterThan(at)
    const body = src.slice(at, end)
    expect(body).toContain('focusExistingWindow(mainWindow)')
    expect(body).not.toMatch(/mainWindow\.(isMinimized|restore|focus|show)\(/)
    expect(src).toMatch(/import \{ focusExistingWindow \} from '\.\/second-instance'/)
    // It never makes a window mid-teardown.
    expect(body).not.toMatch(/createWindow\(/)
  })
})
