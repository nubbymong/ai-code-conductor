// @vitest-environment jsdom
/**
 * Snap's Rectangle: the capture is asked only once the menu is closed and two
 * frames have passed, so the menu is off the screen before the new Snap
 * pictures it (plan 2.1.3-beta.17 C3, aicc_planning#406). A hidden page makes
 * no frames and shows nothing: it asks at once, or as soon as it hides.
 * Frames are this file's own (requestAnimationFrame stubbed): each runFrame()
 * is one frame. The real-screen reading is snap-e2e's D12
 * (tests/e2e/snap-windows.spec.ts).
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/magicButtonStore', () => ({
  useMagicButtonStore: (sel: any) => sel({ settings: { screenshotColor: '#00FFFF' } }),
}))
vi.mock('../../../src/renderer/components/WindowPickerModal', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/command-bar/chips', () => ({
  ReservedLabel: ({ current }: { current: string }) => React.createElement('span', null, current),
}))
const sendImageToSession = vi.fn()
vi.mock('../../../src/renderer/utils/imageTransfer', () => ({ sendImageToSession: (...a: unknown[]) => sendImageToSession(...a) }))

const { default: ScreenshotButton } = await import('../../../src/renderer/components/ScreenshotButton')

let container: HTMLDivElement
let root: Root
let frames: FrameRequestCallback[] = []
let visibility: DocumentVisibilityState = 'visible'
const captureRectangle = vi.fn()

/** One frame: every callback asked for before it runs. */
const runFrame = () => {
  const due = frames
  frames = []
  for (const cb of due) cb(performance.now())
}
const snapButton = () => container.querySelector('[data-testid="snap-button"]') as HTMLButtonElement
const rectangleItem = () => Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === 'Rectangle') as HTMLButtonElement | undefined
const menuShown = () => rectangleItem() !== undefined
const hide = () => {
  visibility = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
}

async function openMenuAndPressRectangle(): Promise<void> {
  await act(async () => { snapButton().click() })
  expect(menuShown()).toBe(true)
  await act(async () => { rectangleItem()!.click() })
}

beforeEach(() => {
  frames = []
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
  captureRectangle.mockReset()
  sendImageToSession.mockReset()
  ;(window as any).electronAPI = { screenshot: { captureRectangle, captureWindow: vi.fn() } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(<ScreenshotButton sessionId="s1" sessionType="local" />) })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
  delete (document as any).visibilityState
  delete (window as any).electronAPI
})

describe('Snap, Rectangle: the menu closes before the capture is asked (aicc_planning#406)', () => {
  it('asks for the capture only once the menu is gone and two frames have passed', async () => {
    const menuAtCapture: boolean[] = []
    captureRectangle.mockImplementation(async () => { menuAtCapture.push(menuShown()); return null })
    await openMenuAndPressRectangle()
    expect(menuShown()).toBe(false)
    expect(captureRectangle).not.toHaveBeenCalled()
    await act(async () => { runFrame() })
    expect(captureRectangle).not.toHaveBeenCalled()
    await act(async () => { runFrame() })
    expect(captureRectangle).toHaveBeenCalledTimes(1)
    expect(menuAtCapture).toEqual([false])
  })

  it('a hidden page asks at once: it makes no frames', async () => {
    captureRectangle.mockResolvedValue(null)
    await act(async () => { snapButton().click() })
    visibility = 'hidden'
    await act(async () => { rectangleItem()!.click() })
    expect(captureRectangle).toHaveBeenCalledTimes(1)
    expect(frames).toEqual([])
  })

  it('a page that hides while it waits asks then, once', async () => {
    captureRectangle.mockResolvedValue(null)
    await openMenuAndPressRectangle()
    await act(async () => { runFrame() })
    expect(captureRectangle).not.toHaveBeenCalled()
    await act(async () => { hide() })
    expect(captureRectangle).toHaveBeenCalledTimes(1)
    // The second frame, if it still comes, asks nothing more.
    await act(async () => { runFrame() })
    expect(captureRectangle).toHaveBeenCalledTimes(1)
  })

  it('the picture still goes to the session, and the button is usable again', async () => {
    captureRectangle.mockResolvedValue('C:\\shots\\a.jpg')
    await openMenuAndPressRectangle()
    expect(snapButton().disabled).toBe(true)
    await act(async () => { runFrame() })
    await act(async () => { runFrame() })
    expect(sendImageToSession).toHaveBeenCalledTimes(1)
    expect(sendImageToSession.mock.calls[0][0]).toBe('s1')
    expect(sendImageToSession.mock.calls[0][1]).toBe('C:\\shots\\a.jpg')
    expect(sendImageToSession.mock.calls[0][3]).toBe('local')
    expect(snapButton().disabled).toBe(false)
  })
})

// 2.1.3-beta.19 fix round, item SNAPNODESK (Rocky line, outside finding 4):
// a press with no desktop to capture ('[snap] new engine: no desktop to
// capture (exit 3) ... nothing captured') opened nothing and told nobody. It
// now says so in one plain line where Snap was pressed: the hint above the
// command bar (PasteHint); a cancelled press still says nothing.
describe('Snap, Rectangle: a press with no desktop to capture says so', () => {
  it('shows one plain line for this session, sends nothing; a cancelled press shows none', async () => {
    const { usePasteHintStore } = await import('../../../src/renderer/stores/pasteHintStore')
    usePasteHintStore.getState().clear('s1')
    captureRectangle.mockResolvedValue({ notCaptured: 'no-desktop' })
    await openMenuAndPressRectangle()
    await act(async () => { runFrame() })
    await act(async () => { runFrame() })
    expect(sendImageToSession).not.toHaveBeenCalled()
    expect(usePasteHintStore.getState().hints.s1).toBe('Snap could not capture: there is no desktop to capture in this Windows session.')
    expect(snapButton().disabled).toBe(false)
    usePasteHintStore.getState().clear('s1')
    captureRectangle.mockResolvedValue(null)
    await openMenuAndPressRectangle()
    await act(async () => { runFrame() })
    await act(async () => { runFrame() })
    expect(usePasteHintStore.getState().hints.s1).toBeUndefined()
  })
})
