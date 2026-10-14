// @vitest-environment jsdom
/**
 * aicc_planning #211, follow-up 2: App's own "Loading..." early return (shown
 * while it checks the setup state and loads the config) replaces the whole
 * app, title bar included, and the main window has no frame on Windows and
 * Linux. Unlike the setup screens and the Multi Spawn page, it had no
 * minimize, maximize or close, and nothing to drag the window by.
 *
 * Verifies:
 *   - on Windows and Linux the screen's top bar (WindowDragStrip) carries the
 *     window's own minimize, maximize and close, each wired to
 *     window.electronAPI.window (Close is the plain window close: nothing
 *     runs yet);
 *   - on macOS (native traffic lights) no window buttons, and nothing is
 *     asked of the window; the bar still drags;
 *   - the bar is a drag region across the top of the screen, the controls a
 *     no-drag group inside it, the "Loading..." text below it (the screen
 *     keeps the bar's height clear at its top), and nothing else on the
 *     screen declares a region (styles.css's own rules, drag-regions.ts);
 *   - App's loading early return renders this screen (App is too large to
 *     render here, so its source is read).
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { regionRules, declaredRegions } from './drag-regions'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const h = React.createElement
const { AppLoadingScreen } = await import('../../../src/renderer/components/AppLoadingScreen')
const { WINDOW_DRAG_STRIP_CLEARANCE } = await import('../../../src/renderer/components/WindowControls')

const win = {
  isMaximized: vi.fn(() => Promise.resolve(false)),
  onMaximizedChanged: vi.fn((_cb: (m: boolean) => void) => () => {}),
  minimize: vi.fn(),
  maximize: vi.fn(),
  close: vi.fn(),
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  for (const f of Object.values(win)) f.mockClear()
  ;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, window: win }
  ;(globalThis as any).window.electronPlatform = 'win32'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
})

const LABELS = ['Minimize window', 'Maximize window', 'Close window']
const control = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null
const screen = () => document.querySelector('[data-testid="app-loading"]') as HTMLElement
const strip = () => screen().querySelector('[data-testid="window-drag-strip"]') as HTMLElement | null

async function render() {
  await act(async () => { root.render(h(AppLoadingScreen)) })
}

describe('App\'s loading screen has the window controls and a drag bar (aicc_planning #211, follow-up 2)', () => {
  for (const platform of ['win32', 'linux']) {
    it(`${platform}: minimize, maximize and close are in its top bar, each wired to the window`, async () => {
      ;(window as any).electronPlatform = platform
      await render()
      expect(screen().textContent).toContain('Loading...')
      expect(strip(), 'the top bar').not.toBeNull()
      expect(document.querySelectorAll('[data-testid="window-drag-strip"]'), 'one bar').toHaveLength(1)
      for (const label of LABELS) {
        const btn = control(label)
        expect(btn, label).not.toBeNull()
        expect(strip()!.contains(btn), `${label} is in the top bar`).toBe(true)
      }
      await act(async () => { control('Minimize window')!.click() })
      await act(async () => { control('Maximize window')!.click() })
      await act(async () => { control('Close window')!.click() })
      expect(win.minimize).toHaveBeenCalledTimes(1)
      expect(win.maximize).toHaveBeenCalledTimes(1)
      expect(win.close).toHaveBeenCalledTimes(1)
    })
  }

  it('darwin: no window buttons (the native traffic lights stay), and nothing is asked of the window; the bar still drags', async () => {
    ;(window as any).electronPlatform = 'darwin'
    await render()
    expect(screen().textContent).toContain('Loading...')
    for (const label of LABELS) expect(control(label), label).toBeNull()
    expect(document.querySelector('[data-testid="window-controls"]')).toBeNull()
    expect(win.isMaximized).not.toHaveBeenCalled()
    expect(strip(), 'the top bar').not.toBeNull()
    expect(strip()!.classList.contains('titlebar-drag')).toBe(true)
  })

  it('the bar drags the window across the top of the screen; the controls are no-drag inside it; the text is below it', async () => {
    await render()
    const bar = strip()!
    expect(bar.classList.contains('titlebar-drag')).toBe(true)
    expect(bar.classList.contains('h-10'), 'the title bar\'s 40px').toBe(true)
    for (const c of ['absolute', 'top-0', 'inset-x-0']) expect(bar.classList.contains(c), c).toBe(true)
    // Positioned against the screen itself, which fills the window.
    expect(screen().classList.contains('relative')).toBe(true)
    expect(screen().classList.contains('h-screen')).toBe(true)
    const group = bar.querySelector('[data-testid="window-controls"]') as HTMLElement
    expect(group.classList.contains('titlebar-no-drag')).toBe(true)
    const text = Array.from(screen().querySelectorAll('div')).find((d) => d.textContent === 'Loading...')!
    expect(text, 'the Loading... text').toBeDefined()
    expect(bar.contains(text), 'the text is not in the bar').toBe(false)
    expect(WINDOW_DRAG_STRIP_CLEARANCE).toBeGreaterThanOrEqual(40)
    expect(screen().style.paddingTop).toBe(`${WINDOW_DRAG_STRIP_CLEARANCE}px`)
  })

  it('the bar and its buttons are the only regions the screen declares', async () => {
    const rules = regionRules()
    await render()
    const regions = declaredRegions(rules)
    expect(regions.map((r) => r.region)).toEqual(['drag', 'no-drag'])
    expect(regions[0].el).toBe(strip())
    expect(regions[1].el).toBe(strip()!.querySelector('[data-testid="window-controls"]'))
  })

  describe('App wiring (source: App is too large to render here)', () => {
    const APP = readFileSync(resolve(__dirname, '../../../src/renderer/App.tsx'), 'utf8').replace(/\r\n/g, '\n')

    it('the loading early return renders this screen, and the old bare markup is gone', () => {
      const gate = APP.indexOf('if (setupComplete === null || (setupComplete && (!configLoaded || logsWipeBytes === null))) {')
      expect(gate, 'the loading early return').toBeGreaterThan(0)
      const body = APP.slice(gate, APP.indexOf('\n  }\n', gate))
      expect(body).toContain('return <AppLoadingScreen />')
      expect(APP).toMatch(/import \{ AppLoadingScreen \} from '\.\/components\/AppLoadingScreen'/)
      // The one other "Loading..." App drew itself had no bar.
      expect(APP).not.toContain('<div className="text-overlay1">Loading...</div>')
    })
  })
})
