import { describe, it, expect, vi } from 'vitest'

/**
 * The new Snap's ports in the app (src/main/snap/windows-engine.ts; plan
 * 2.1.3-beta.16 A1, aicc_planning#401): a press shows the app's own overlay
 * (src/main/snap/overlay.ts, section A2), not a stand-in, and saves through the
 * save it is given. The engine is a stand-in that opens the overlay once and
 * saves once; the overlay is a stand-in that records what it was shown.
 * Not checked here: the engine's steps (engine.test.ts) and the overlay's
 * windows (snap-overlay.test.ts).
 */

const calls = vi.hoisted(() => ({ shown: [] as unknown[], saved: [] as unknown[] }))

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\data', isPackaged: false, getAppPath: () => 'C:\\app' },
  nativeImage: { createFromBitmap: () => ({}) },
  screen: { getAllDisplays: () => [], dipToScreenRect: (_w: unknown, r: unknown) => r },
}))
vi.mock('../../../../src/main/session-helper/install', () => ({ bundledHelperPath: () => 'C:\\app\\aicc-helper.exe' }))
vi.mock('../../../../src/main/debug-logger', () => ({ logInfo: vi.fn() }))
vi.mock('../../../../src/main/snap/overlay', () => ({
  openSnapOverlays: vi.fn(async (displays: unknown[]) => {
    calls.shown.push(displays)
    return { id: 7, whole: true }
  }),
}))
vi.mock('../../../../src/main/snap/engine', () => ({
  snapWithHelper: async (p: { openOverlays: (d: unknown[]) => Promise<unknown>; save: (pic: unknown) => string }) => {
    const answer = await p.openOverlays([{ id: 7, dipBounds: { x: 0, y: 0, width: 800, height: 600 }, scale: 1, picture: 'picture of display 7' }])
    return { kind: 'saved', file: p.save({ answer }) }
  },
}))

const { snapOnWindows } = await import('../../../../src/main/snap/windows-engine')
const { openSnapOverlays } = await import('../../../../src/main/snap/overlay')

describe('snapOnWindows: a press shows the app\'s own overlay', () => {
  it('opens openSnapOverlays with each display and its picture, and saves through the save it is given', async () => {
    const save = vi.fn((pic: unknown) => { calls.saved.push(pic); return 'C:\\res\\screenshots\\screenshot-1.jpg' })
    const outcome = await snapOnWindows(save)
    expect(openSnapOverlays).toHaveBeenCalledTimes(1)
    expect(calls.shown).toEqual([[{ id: 7, dipBounds: { x: 0, y: 0, width: 800, height: 600 }, scale: 1, picture: 'picture of display 7' }]])
    expect(save).toHaveBeenCalledTimes(1)
    expect(calls.saved).toEqual([{ answer: { id: 7, whole: true } }])
    expect(outcome).toEqual({ kind: 'saved', file: 'C:\\res\\screenshots\\screenshot-1.jpg' })
  })
})
