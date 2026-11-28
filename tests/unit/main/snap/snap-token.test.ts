// Snap's token for its kept picture (ADR-032; plan 2.1.3-beta.21 phase 2,
// 2.1.5; src/main/screenshot-capture.ts keepSnapForPaste and
// takeSnapForPaste). The capture answers the renderer a token, never the
// picture's path; the renderer hands it back on the paste channel. The token
// is random and names no path; it names its picture once; an unknown or used
// token, or one past its time, names nothing; the picture is the bitmap the
// capture kept, else the file read back. The token is bound to the session
// its capture named (review round 1, R1-2): taken for another session it
// names nothing, and it is used up.
// Red on 0c54a1c6: no such token (the capture answered the path). Red on
// 0fce95b6 (R1-2): a token taken for another session named its picture.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ fromPath: [] as string[], empty: false }))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  desktopCapturer: { getSources: async () => [] },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  ipcMain: { removeAllListeners: () => {} },
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => true }),
    createFromPath: (p: string) => { h.fromPath.push(p); return { isEmpty: () => h.empty, from: p } },
  },
  shell: { openExternal: async () => {} },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
}))
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => 'C:/res' }))

const { keepSnapForPaste, takeSnapForPaste, SNAP_TOKEN_MS } = await import('../../../../src/main/screenshot-capture')
const FILE = 'C:\\res\\screenshots\\screenshot-2026-11-28-101500.jpg'
const SESSION = 'tab-1'

beforeEach(() => { h.fromPath = []; h.empty = false })
afterEach(() => { vi.useRealTimers() })

describe('Snap\'s token for its kept picture', () => {
  it('is random, names no path, and names its picture once', () => {
    const a = keepSnapForPaste(FILE, SESSION)
    const b = keepSnapForPaste(FILE, SESSION)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
    expect(a).not.toContain('screenshot')
    const got = takeSnapForPaste(a, SESSION)
    expect(got?.file).toBe(FILE)
    expect(takeSnapForPaste(a, SESSION)).toBeNull()
    expect(takeSnapForPaste(b, SESSION)?.file).toBe(FILE)
  })

  it('an unknown token, or one that is not a string, names nothing', () => {
    expect(takeSnapForPaste('0'.repeat(32), SESSION)).toBeNull()
    expect(takeSnapForPaste(42 as never, SESSION)).toBeNull()
    expect(h.fromPath).toEqual([])
  })

  it('a token taken for another session names nothing, and is used up', () => {
    const t = keepSnapForPaste(FILE, SESSION)
    expect(takeSnapForPaste(t, 'tab-2')).toBeNull()
    expect(takeSnapForPaste(t, SESSION)).toBeNull()
    expect(takeSnapForPaste(keepSnapForPaste(FILE, SESSION), 42 as never)).toBeNull()
    expect(h.fromPath).toEqual([])
  })

  it('a token past its time names nothing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const t = keepSnapForPaste(FILE, SESSION)
    vi.setSystemTime(1_000_000 + SNAP_TOKEN_MS + 1)
    expect(takeSnapForPaste(t, SESSION)).toBeNull()
  })

  it('with no kept bitmap the file is read back; an empty read names nothing', () => {
    const t = keepSnapForPaste(FILE, SESSION)
    expect(takeSnapForPaste(t, SESSION)?.picture).toMatchObject({ from: FILE })
    h.empty = true
    expect(takeSnapForPaste(keepSnapForPaste(FILE, SESSION), SESSION)).toBeNull()
  })
})
