// @vitest-environment jsdom
// aicc_planning #314: the HTTP Hooks Gateway card describes only what exists.
// It used to carry a permanently disabled "Desktop notifications (coming soon)"
// checkbox and say the gateway was the foundation for "upcoming" desktop
// notifications. Nothing behind either was ever built, so both are gone and
// the card's only checkbox is the gateway's own Enabled toggle.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const SETTINGS_STATE: any = { settings: { hooksEnabled: true, hooksPort: 19333 }, updateSettings: async () => {} }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(SETTINGS_STATE)
  useSettingsStore.getState = () => SETTINGS_STATE
  return { useSettingsStore }
})

const { default: HooksGatewaySection } = await import('../../../src/renderer/components/github/config/HooksGatewaySection')

describe('HooksGatewaySection (#314: no placeholder for a feature that does not exist)', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    ;(window as any).electronAPI = {
      hooks: {
        getStatus: () => Promise.resolve({ enabled: true, listening: true, port: 19333 }),
        onStatus: () => () => {},
        toggle: () => Promise.resolve({ enabled: true, listening: true, port: 19333 }),
      },
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = async () => {
    await act(async () => {
      root.render(React.createElement(HooksGatewaySection))
    })
  }

  it('says nothing about desktop notifications, "coming soon" or "upcoming"', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('HTTP Hooks Gateway')
    expect(text).not.toMatch(/coming soon/i)
    expect(text).not.toMatch(/desktop notifications/i)
    expect(text).not.toMatch(/upcoming/i)
  })

  it('has exactly one checkbox: the gateway Enabled toggle, and it is not disabled', async () => {
    await render()
    const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]
    expect(boxes).toHaveLength(1)
    expect(boxes[0].disabled).toBe(false)
    expect(boxes[0].checked).toBe(true)
    expect(boxes[0].closest('label')?.textContent).toBe('Enabled')
  })

  it('still shows the live listener line', async () => {
    await render()
    expect(container.textContent).toContain('Listening on 127.0.0.1:19333')
  })
})
