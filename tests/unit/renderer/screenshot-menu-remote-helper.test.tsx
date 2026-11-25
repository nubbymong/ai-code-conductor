// @vitest-environment jsdom
//
// The screenshot menu's "Insert Selected" on a tab through the session helper
// (plan 2.1.3-beta.17, section A2, plan-review finding 6; aicc_planning#411).
// From 2.1.3-beta.18 (plan section 3.2) such a tab has the image fetch tool,
// so it gets the storyboard as every other tab does, and no tab's state is
// asked for it.
//
// PURE: the real menu, a fake window.electronAPI, no IPC.
import React from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { SSH_THROUGH_HELPER } from '../../../src/shared/remote-machines'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: ScreenshotContextMenu } = await import('../../../src/renderer/components/ScreenshotContextMenu')

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const TOOL = 'mcp__conductor__fetch_host_screenshot'

function fakeApi(state: string | Error) {
  const writes: Array<[string, string]> = []
  const getState = vi.fn(async () => {
    if (state instanceof Error) throw state
    return { state }
  })
  ;(window as any).electronAPI = {
    screenshot: {
      listRecent: async () => [
        { filename: 'a.png', path: '/shots/a.png', timestamp: 1, thumbnail: '' },
        { filename: 'b.png', path: '/shots/b.png', timestamp: 2, thumbnail: '' },
      ],
    },
    ssh: { getState },
    pty: { write: (id: string, d: string) => { writes.push([id, d]) } },
  }
  return { writes, getState }
}

/** Opens the menu, ticks both pictures, presses Insert Selected, and waits
 *  long enough for a whole storyboard (one line every 80 ms). */
async function insertBoth() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const onClose = vi.fn()
  await act(async () => {
    root!.render(<ScreenshotContextMenu x={10} y={500} sessionId="tab-1" onClose={onClose} />)
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  const boxes = [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
  expect(boxes).toHaveLength(2)
  for (const box of boxes) await act(async () => { box.click() })
  const button = [...host.querySelectorAll('button')].find((b) => /Insert Selected/.test(b.textContent ?? ''))
  expect(button).toBeDefined()
  await act(async () => { button!.click() })
  await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
  return onClose
}

describe('the screenshot menu on a tab through the session helper', () => {
  const storyboard = (writes: Array<[string, string]>) => {
    const text = writes.map(([, d]) => d)
    expect(writes.every(([id]) => id === 'tab-1')).toBe(true)
    expect(text[0]).toBe('Please look at the following screenshots from my host machine.\n')
    expect(text).toContain(`Frames (use ${TOOL} for each):\n`)
    expect(text).toContain('1. a.png\n')
    expect(text).toContain('2. b.png\n')
    expect(text[text.length - 1]).toBe('\r')
  }

  it('gets the storyboard, as every other tab does, and no state is asked', async () => {
    const { writes, getState } = fakeApi(SSH_THROUGH_HELPER)
    const onClose = await insertBoth()
    storyboard(writes)
    expect(getState).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('an SSH tab on the usual path gets the same storyboard', async () => {
    const { writes, getState } = fakeApi('claude-running')
    await insertBoth()
    storyboard(writes)
    expect(getState).not.toHaveBeenCalled()
  })
})
