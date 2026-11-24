// @vitest-environment jsdom
/**
 * Settings, Custom Commands, Snap: "Snap on Windows: New / Previous" (plan
 * 2.1.3-beta.16 A1, aicc_planning#401). Shown on Windows only; it shows the
 * saved choice, or the default when none is saved, and a pick saves only that
 * choice to the magicButton store (magic-buttons.json, which main reads at each
 * press). The page's other cards are custom-commands-tab.test.tsx's.
 * Stores the page mutates are REAL; the rest are mocked as that file mocks them.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({ commands: [], sections: [], removeCommand: vi.fn(), updateCommand: vi.fn() }),
}))
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({ sessions: [] }),
}))
vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({ configs: [] }),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => ({
  useSettingsStore: (sel: any) => sel({ settings: { loggingEnabled: true }, updateSettings: vi.fn() }),
}))
vi.mock('../../../src/renderer/components/SessionDialog', () => ({ COLOR_SWATCHES: ['#00FFFF'], default: () => null }))
vi.mock('../../../src/renderer/components/SettingsPage', () => ({
  Toggle: ({ on, onClick, label }: { on: boolean; onClick: () => void; label?: string }) =>
    React.createElement('button', { type: 'button', 'aria-pressed': on, 'aria-label': label, onClick }),
}))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({ default: () => null }))
const saveConfigNow = vi.fn()
vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: (...a: unknown[]) => saveConfigNow(...a), saveConfigDebounced: vi.fn() }))

const { CustomCommandsTab } = await import('../../../src/renderer/components/settings/CustomCommandsTab')
const { useMagicButtonStore } = await import('../../../src/renderer/stores/magicButtonStore')
const { useCommandBarStore, coerceCommandBarUi } = await import('../../../src/renderer/stores/commandBarStore')

let container: HTMLDivElement
let root: Root
const setPlatform = (p: string | undefined) => { (window as unknown as { electronPlatform?: string }).electronPlatform = p }
const render = () => { act(() => { root.render(React.createElement(CustomCommandsTab)) }) }
const q = (id: string) => container.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)

beforeEach(() => {
  saveConfigNow.mockClear()
  useCommandBarStore.setState({ state: coerceCommandBarUi({}), isLoaded: true })
  useMagicButtonStore.setState({ settings: { screenshotColor: '#00FFFF', autoDeleteDays: null }, isLoaded: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  setPlatform(undefined)
})

describe('Snap on Windows: New / Previous', () => {
  it('is in the Snap card on Windows, with nothing saved showing the default, New (S8 step 3)', () => {
    setPlatform('win32')
    render()
    const group = container.querySelector('[data-testid="settings-snap"] [role="radiogroup"][aria-label="Snap on Windows"]')
    expect(group).not.toBeNull()
    expect(q('settings-snap-engine-new')!.checked).toBe(true)
    expect(q('settings-snap-engine-previous')!.checked).toBe(false)
    expect(container.querySelector('[data-testid="settings-snap-engine"]')!.textContent).toContain('If the new one cannot take a picture, the previous one opens instead.')
  })

  it('a pick saves that choice, and only then, and the card shows it', () => {
    setPlatform('win32')
    render()
    expect(saveConfigNow).not.toHaveBeenCalled()
    act(() => { q('settings-snap-engine-previous')!.click() })
    expect(useMagicButtonStore.getState().settings.snapEngineWindows).toBe('previous')
    expect(saveConfigNow).toHaveBeenLastCalledWith('magicButtons', expect.objectContaining({ snapEngineWindows: 'previous', screenshotColor: '#00FFFF' }))
    expect(q('settings-snap-engine-previous')!.checked).toBe(true)
    act(() => { q('settings-snap-engine-new')!.click() })
    expect(useMagicButtonStore.getState().settings.snapEngineWindows).toBe('new')
  })

  it('a saved Previous is shown as saved, over the default', () => {
    setPlatform('win32')
    useMagicButtonStore.setState({ settings: { screenshotColor: '#00FFFF', autoDeleteDays: null, snapEngineWindows: 'previous' }, isLoaded: true })
    render()
    expect(q('settings-snap-engine-previous')!.checked).toBe(true)
    expect(q('settings-snap-engine-new')!.checked).toBe(false)
  })

  it('is not shown on macOS or Linux, where Snap is the previous one only', () => {
    for (const p of ['darwin', 'linux']) {
      setPlatform(p)
      render()
      expect(q('settings-snap-engine'), p).toBeNull()
      expect(container.querySelector('[data-testid="settings-snap"]'), p).not.toBeNull()
    }
  })
})
