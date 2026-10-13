// @vitest-environment jsdom
/**
 * aicc_planning #211, follow-up: the Multi Spawn page (shown once after an
 * upgrade, MultiSpawnStartupPage) covers the whole window with an opaque
 * backdrop, title bar included, and the main window has no frame on Windows
 * and Linux. It had no minimize, maximize or close, and App did not make the
 * app behind it inert, so the hidden title bar's drag strip and buttons
 * stayed live under it: an invisible drag area and buttons nobody could see.
 *
 * Verifies:
 *   - on Windows and Linux the page's top bar carries the window's own
 *     minimize, maximize and close, each wired to window.electronAPI.window;
 *     on macOS (native traffic lights) none, and nothing is asked of the
 *     window;
 *   - the bar is a drag region on every platform, the controls a no-drag
 *     group inside it, and the page's own content is not in it: the overlay
 *     keeps the bar's height clear at its top;
 *   - with the app behind it inert, the page's bar and buttons are the only
 *     regions declared (styles.css's own rules, applied as in
 *     onboarding-shell-window-controls.test.tsx);
 *   - App makes the app behind the page inert (appCovered names its gate),
 *     and the page renders outside the inert wrapper.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { regionRules, declaredRegions } from './drag-regions'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__APP_VERSION__ = '2.1.1'

// The page's stores, as multi-spawn-startup-page.test.tsx stubs them.
const CONFIG: any = { configs: [], groups: [], updateConfig: vi.fn() }
const APP_META: any = { meta: {}, update: vi.fn() }
const store = (state: any) => {
  const hook: any = (sel: any) => sel(state)
  hook.getState = () => state
  return hook
}
vi.mock('../../../src/renderer/stores/configStore', () => ({ useConfigStore: store(CONFIG) }))
vi.mock('../../../src/renderer/stores/sessionStore', () => ({ useSessionStore: store({ sessions: [] }) }))
vi.mock('../../../src/renderer/stores/detachedRemotesStore', () => ({ useDetachedRemotesStore: store({ entries: [] }) }))
vi.mock('../../../src/renderer/stores/livenessStore', () => ({ useDetachedLivenessStore: store({ bySession: {} }) }))
vi.mock('../../../src/renderer/stores/hostReachability', () => ({ useHostReachabilityStore: store({ byHost: {} }) }))
vi.mock('../../../src/renderer/stores/appMetaStore', () => ({ useAppMetaStore: store(APP_META) }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))

const h = React.createElement
const { MultiSpawnStartupPage } = await import('../../../src/renderer/components/MultiSpawnStartupPage')
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
  CONFIG.configs = [{ id: 'a', label: 'Alpha', workingDirectory: '/x', color: '', sessionType: 'local', provider: 'claude' }]
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
const overlay = () => document.querySelector('[data-testid="multi-spawn-startup"]') as HTMLElement
const strip = () => overlay().querySelector('[data-testid="window-drag-strip"]') as HTMLElement | null
const page = () => h(MultiSpawnStartupPage, { tally: null, onDone: () => {} })

async function render(el: React.ReactElement) {
  await act(async () => { root.render(el) })
}

describe('the Multi Spawn page has the window controls and a drag bar (aicc_planning #211)', () => {
  for (const platform of ['win32', 'linux']) {
    it(`${platform}: minimize, maximize and close are in the page's top bar, each wired to the window`, async () => {
      ;(window as any).electronPlatform = platform
      await render(page())
      expect(strip(), 'the top bar').not.toBeNull()
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
    await render(page())
    for (const label of LABELS) expect(control(label), label).toBeNull()
    expect(document.querySelector('[data-testid="window-controls"]')).toBeNull()
    expect(win.isMaximized).not.toHaveBeenCalled()
    expect(strip()!.classList.contains('titlebar-drag')).toBe(true)
  })

  it('the bar drags the window; the controls are no-drag inside it; the page\'s content is below it, not in it', async () => {
    await render(page())
    const bar = strip()!
    expect(bar.classList.contains('titlebar-drag')).toBe(true)
    expect(bar.classList.contains('h-10'), 'the title bar\'s 40px').toBe(true)
    // A bar across the top of the window, not a box in the page's row.
    for (const c of ['absolute', 'top-0', 'inset-x-0']) expect(bar.classList.contains(c), c).toBe(true)
    const group = bar.querySelector('[data-testid="window-controls"]') as HTMLElement
    expect(group.classList.contains('titlebar-no-drag')).toBe(true)
    for (const label of LABELS) {
      for (let n: HTMLElement | null = control(label); n && n !== group; n = n.parentElement) {
        expect(n.classList.contains('titlebar-drag'), label).toBe(false)
      }
    }
    // The page's own controls are not inside the bar...
    for (const id of ['multi-spawn-startup-skip', 'multi-spawn-startup-continue', 'multi-spawn-startup-toggle']) {
      const el = document.querySelector(`[data-testid="${id}"]`)
      expect(el, id).not.toBeNull()
      expect(bar.contains(el), `${id} is not in the bar`).toBe(false)
    }
    // ...and the overlay keeps the bar's height clear at its top, so none of
    // them can be laid out under it.
    expect(WINDOW_DRAG_STRIP_CLEARANCE).toBeGreaterThanOrEqual(40)
    expect(overlay().style.paddingTop).toBe(`${WINDOW_DRAG_STRIP_CLEARANCE}px`)
  })

  it('above the inert app (App\'s appCovered), the page\'s bar and buttons are the only regions declared', async () => {
    const rules = regionRules()
    // The app behind, as App renders it while the page shows: inert, with a
    // title bar (its drag strip, then its no-drag parts) and no-drag panels.
    const appBehind = h('div', { className: 'contents', inert: true, 'data-testid': 'app-behind' },
      h('div', { className: 'titlebar-drag h-10' }, h('div', { className: 'titlebar-no-drag' })),
      h('main', { className: 'titlebar-no-drag' }))
    await render(h(React.Fragment, null, page(), appBehind))
    const regions = declaredRegions(rules)
    expect(regions.map((r) => r.region)).toEqual(['drag', 'no-drag'])
    expect(regions[0].el).toBe(strip())
    expect(regions[1].el).toBe(strip()!.querySelector('[data-testid="window-controls"]'))
  })

  describe('App wiring (source: App is too large to render here)', () => {
    const APP = readFileSync(resolve(__dirname, '../../../src/renderer/App.tsx'), 'utf8').replace(/\r\n/g, '\n')

    it('appCovered names the Multi Spawn page\'s gate, so the app behind it is inert', () => {
      const line = APP.split('\n').find((l) => l.trim().startsWith('const appCovered = '))
      expect(line, 'the appCovered line').toBeDefined()
      expect(line).toContain("bootGate === 'multiSpawnIntro'")
    })

    it('the page renders outside the inert wrapper', () => {
      const open = APP.indexOf('<div className="contents" inert={appCovered} data-testid="app-behind">')
      const pageAt = APP.indexOf('<MultiSpawnStartupPage')
      expect(open).toBeGreaterThan(0)
      expect(pageAt).toBeGreaterThan(0)
      expect(pageAt).toBeLessThan(open)
    })
  })
})
