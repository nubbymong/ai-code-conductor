// @vitest-environment jsdom
// Snap, Window with nothing to list. On a Mac an empty list is most often the
// Screen Recording permission (main has just shown its sentence), so the
// picker says how to give it instead of a bare "No windows found"; elsewhere
// it says what it always said.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

const { default: WindowPickerModal } = await import('../../../src/renderer/components/WindowPickerModal')

let container: HTMLDivElement
let root: Root
const w = window as unknown as { electronAPI: unknown; electronPlatform: string }

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  w.electronAPI = { screenshot: { listWindows: vi.fn(async () => []) } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function renderEmpty(platform: string): Promise<string> {
  w.electronPlatform = platform
  await act(async () => {
    root.render(<WindowPickerModal onCapture={() => {}} onCancel={() => {}} />)
  })
  await act(async () => { await Promise.resolve() })
  return document.querySelector('[data-testid="window-picker-empty"]')?.textContent ?? ''
}

describe('the window picker with no windows to list', () => {
  it('on a Mac, says the Screen Recording permission lists them and where to switch it on', async () => {
    const text = await renderEmpty('darwin')
    expect(text).toContain('Screen Recording permission')
    expect(text).toContain('System Settings, Privacy and Security, Screen Recording')
    expect(text).toContain('quit and reopen the app')
  })

  it('elsewhere, says no windows were found, as before', async () => {
    expect(await renderEmpty('win32')).toBe('No windows found')
  })
})
