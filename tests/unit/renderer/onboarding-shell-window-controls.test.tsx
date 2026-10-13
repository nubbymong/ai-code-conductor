// @vitest-environment jsdom
/**
 * aicc_planning #211: the onboarding pages cover the whole window, title bar
 * included, and the main window has no frame on Windows and Linux. So a page
 * drawn in the onboarding shell (setup, release notes, and the one-time pages
 * shown in it after an upgrade) had no way to move, minimize, maximize or
 * close the window.
 *
 * Verifies:
 *   - on Windows and Linux the onboarding shell's top bar carries the window's
 *     own minimize, maximize and close, each wired to
 *     window.electronAPI.window; on macOS (native traffic lights) none;
 *   - the top bar is a drag region on every platform, and the controls are a
 *     no-drag region inside it (styles.css defines both classes);
 *   - the controls are tab stops inside the shell's focus trap: Tab from the
 *     page's last control goes round to them, Shift+Tab from them goes back
 *     to the page, and a Tab from outside comes in;
 *   - they sit at the right end of the bar, after the breadcrumb when there is
 *     one; the maximize button follows the window's maximized state;
 *   - the title bar shows the same controls (the cluster moved into
 *     WindowControls, with names added for screen readers);
 *   - while the app behind the page is inert (App's appCovered), it declares
 *     no drag or no-drag region, so the page's bar and buttons are the last
 *     regions declared. Electron folds regions in the order the page lists
 *     them (DOM order), and the covering pages come BEFORE the app in the DOM
 *     (pinned in onboarding-focus-trap.test.tsx), so without this the hidden
 *     title bar's drag strip (the top 40px) would land on the middle of the
 *     buttons. Checked by applying styles.css's own region rules (cascade:
 *     specificity, then source order) to a rendered page and the real title
 *     bar, since jsdom has no regions of its own; and every region in the
 *     renderer goes through the two classes, so the rule covers them all.
 * The introduction takeover, drawn in the same shell, is covered by
 * onboarding-focus-trap.test.tsx (Tab goes round to the window controls).
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { regionRules, regionOf, declaredRegions } from './drag-regions'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// TitleBar's own neighbours, stubbed as titlebar-provider-status.test.tsx does.
vi.mock('../../../src/renderer/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: any) => any) => selector({ settings: { updateChannel: 'stable' } }),
}))
vi.mock('../../../src/renderer/components/ThemeToggle', () => ({ default: () => React.createElement('div') }))
vi.mock('../../../src/renderer/components/ConductorHealthPill', () => ({ default: () => React.createElement('div') }))
vi.mock('../../../src/renderer/components/sentinel/SentinelDot', () => ({ default: () => React.createElement('div') }))

const h = React.createElement
const { OnboardingShell } = await import('../../../src/renderer/onboarding/OnboardingShell')
const { tabStops } = await import('../../../src/renderer/onboarding/contain-focus')
const { default: TitleBar } = await import('../../../src/renderer/components/TitleBar')

const src = (rel: string) => readFileSync(resolve(__dirname, '../../../', rel), 'utf8').replace(/\r\n/g, '\n')

let container: HTMLDivElement
let root: Root
let maximizedListener: ((m: boolean) => void) | null
const win = {
  isMaximized: vi.fn(() => Promise.resolve(false)),
  onMaximizedChanged: vi.fn((cb: (m: boolean) => void) => { maximizedListener = cb; return () => { maximizedListener = null } }),
  minimize: vi.fn(),
  maximize: vi.fn(),
  close: vi.fn(),
}

beforeEach(() => {
  maximizedListener = null
  win.isMaximized.mockClear().mockImplementation(() => Promise.resolve(false))
  win.onMaximizedChanged.mockClear()
  win.minimize.mockClear()
  win.maximize.mockClear()
  win.close.mockClear()
  ;(globalThis as any).window.electronAPI = {
    ...(globalThis as any).window.electronAPI,
    window: win,
    serviceStatus: { get: vi.fn(() => Promise.resolve(null)), onUpdate: vi.fn(() => () => {}) },
    serviceHealth: { get: vi.fn(() => Promise.resolve(null)), restart: vi.fn(), onUpdate: vi.fn(() => () => {}) },
  }
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

async function render(el: React.ReactElement) {
  await act(async () => { root.render(el) })
}

const LABELS = ['Minimize window', 'Maximize window', 'Close window']
const control = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null
const topBar = () => document.querySelector('.ob-root .top') as HTMLElement

function Page({ showPhases = true }: { showPhases?: boolean }) {
  return h(OnboardingShell, { phase: 1, showPhases },
    h('button', { type: 'button', 'data-testid': 'p-back' }, 'Back'),
    h('button', { type: 'button', 'data-testid': 'p-next' }, 'Next'))
}

/** Tab (or Shift+Tab) as the browser delivers it: a keydown on the focused
 *  element that bubbles to window. jsdom moves no focus itself, so only the
 *  trap moves it. Returns whether the key was taken. */
async function tab(shift = false): Promise<boolean> {
  const target = (document.activeElement as HTMLElement | null) ?? document.body
  const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true })
  await act(async () => { target.dispatchEvent(ev) })
  return ev.defaultPrevented
}
const active = () => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.getAttribute('aria-label') ?? null

describe('the onboarding shell has the window controls (aicc_planning #211)', () => {
  for (const platform of ['win32', 'linux']) {
    it(`${platform}: minimize, maximize and close are in the top bar, each wired to the window`, async () => {
      ;(window as any).electronPlatform = platform
      await render(h(Page))
      const bar = topBar()
      for (const label of LABELS) {
        const btn = control(label)
        expect(btn, label).not.toBeNull()
        expect(bar.contains(btn), `${label} is in the top bar`).toBe(true)
        expect(btn!.getAttribute('type')).toBe('button')
      }
      await act(async () => { control('Minimize window')!.click() })
      expect(win.minimize).toHaveBeenCalledTimes(1)
      await act(async () => { control('Maximize window')!.click() })
      expect(win.maximize).toHaveBeenCalledTimes(1)
      await act(async () => { control('Close window')!.click() })
      expect(win.close).toHaveBeenCalledTimes(1)
      expect(win.minimize).toHaveBeenCalledTimes(1)
      expect(win.maximize).toHaveBeenCalledTimes(1)
    })
  }

  it('darwin: none (the native traffic lights stay), and nothing is asked of the window', async () => {
    ;(window as any).electronPlatform = 'darwin'
    await render(h(Page))
    for (const label of LABELS) expect(control(label), label).toBeNull()
    expect(control('Restore window')).toBeNull()
    expect(document.querySelector('[data-testid="window-controls"]')).toBeNull()
    expect(win.isMaximized).not.toHaveBeenCalled()
    expect(win.onMaximizedChanged).not.toHaveBeenCalled()
  })

  it('the top bar drags the window on every platform; the controls are no-drag inside it', async () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      ;(window as any).electronPlatform = platform
      await render(h(Page))
      expect(topBar().classList.contains('titlebar-drag'), `${platform}: top bar is a drag region`).toBe(true)
      await act(async () => { root.unmount() })
      root = createRoot(container)
    }
    ;(window as any).electronPlatform = 'win32'
    await render(h(Page))
    const group = document.querySelector('[data-testid="window-controls"]') as HTMLElement
    expect(group.classList.contains('titlebar-no-drag')).toBe(true)
    // Nothing between a button and the no-drag group turns drag back on.
    for (const label of LABELS) {
      for (let n: HTMLElement | null = control(label); n && n !== group; n = n.parentElement) {
        expect(n.classList.contains('titlebar-drag'), label).toBe(false)
      }
    }
    // The two classes are the app's drag mechanism (styles.css, loaded app-wide).
    const css = src('src/renderer/styles.css')
    expect(css).toMatch(/\.titlebar-drag\s*\{\s*-webkit-app-region:\s*drag;/)
    expect(css).toMatch(/\.titlebar-no-drag\s*\{\s*-webkit-app-region:\s*no-drag;/)
  })

  it('the controls are tab stops inside the trap, in order, before the page', async () => {
    await render(h(Page))
    const shell = document.querySelector('.ob-root')!
    expect(tabStops(shell).map((el) => el.getAttribute('data-testid') ?? el.getAttribute('aria-label')))
      .toEqual([...LABELS, 'p-back', 'p-next'])
  })

  it('Tab from the page\'s last control goes round to them; Shift+Tab from them goes back to the page', async () => {
    await render(h(Page))
    ;(document.querySelector('[data-testid="p-next"]') as HTMLElement).focus()
    expect(await tab()).toBe(true)
    expect(active()).toBe('Minimize window')
    expect(await tab(true)).toBe(true)
    expect(active()).toBe('p-next')
  })

  it('a Tab from outside the shell comes in to them', async () => {
    await render(h(React.Fragment, null, h('button', { type: 'button', 'data-testid': 'behind' }, 'Behind'), h(Page)))
    ;(document.querySelector('[data-testid="behind"]') as HTMLElement).focus()
    expect(await tab()).toBe(true)
    expect(active()).toBe('Minimize window')
  })

  it('they sit at the right end: after the breadcrumb, or pushed right when there is none', async () => {
    await render(h(Page))
    const group = document.querySelector('[data-testid="window-controls"]') as HTMLElement
    expect(topBar().lastElementChild).toBe(group)
    expect(group.previousElementSibling?.classList.contains('crumbs')).toBe(true)
    expect(group.classList.contains('ml-auto')).toBe(false)
    await act(async () => { root.unmount() })
    root = createRoot(container)
    await render(h(Page, { showPhases: false }))
    const alone = document.querySelector('[data-testid="window-controls"]') as HTMLElement
    expect(topBar().lastElementChild).toBe(alone)
    expect(document.querySelector('.ob-root .crumbs')).toBeNull()
    expect(alone.classList.contains('ml-auto')).toBe(true)
  })

  it('maximize follows the window: Restore while maximized, Maximize again when it is not', async () => {
    win.isMaximized.mockImplementation(() => Promise.resolve(true))
    await render(h(Page))
    expect(control('Restore window')).not.toBeNull()
    expect(control('Maximize window')).toBeNull()
    await act(async () => { maximizedListener!(false) })
    expect(control('Maximize window')).not.toBeNull()
    await act(async () => { control('Maximize window')!.click() })
    expect(win.maximize).toHaveBeenCalledTimes(1)
  })
})

describe('the title bar shows the same controls (moved into WindowControls)', () => {
  it('win32: minimize, maximize and close, wired to the window', async () => {
    await render(h(TitleBar, { sidebarOpen: true, onToggleSidebar: () => {} }))
    for (const label of LABELS) expect(control(label), label).not.toBeNull()
    await act(async () => { control('Close window')!.click() })
    expect(win.close).toHaveBeenCalledTimes(1)
    await act(async () => { control('Minimize window')!.click() })
    expect(win.minimize).toHaveBeenCalledTimes(1)
  })

  it('darwin: none', async () => {
    ;(window as any).electronPlatform = 'darwin'
    await render(h(TitleBar, { sidebarOpen: true, onToggleSidebar: () => {} }))
    for (const label of LABELS) expect(control(label), label).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The app behind a covering page declares no regions. jsdom has no app
// regions, so these apply styles.css's own region rules (the cascade:
// specificity, then source order) to what React rendered, and list the
// regions in DOM order, the order Electron folds them in (drag-regions.ts).

/** App.tsx's wrapper for the app behind the covering pages (inert while one
 *  shows, appCovered), with the real title bar and the same no-drag sidebar,
 *  main column and bottom bar App renders inside it. That the covering pages
 *  come before this wrapper in App, and that these sit inside it, is pinned
 *  in onboarding-focus-trap.test.tsx. */
function AppBehind({ covered }: { covered: boolean }) {
  return h('div', { className: 'contents', inert: covered, 'data-testid': 'app-behind' },
    h(TitleBar, { sidebarOpen: true, onToggleSidebar: () => {} }),
    h('div', { className: 'flex flex-1 overflow-hidden' },
      h('div', { className: 'titlebar-no-drag', 'data-testid': 'sidebar-stand-in' }),
      h('main', { className: 'flex-1 titlebar-no-drag' })),
    h('div', { className: 'titlebar-no-drag shrink-0', 'data-testid': 'bottom-bar-stand-in' }))
}

describe('the covered app declares no drag regions, so the page\'s bar and buttons stand alone (aicc_planning #211)', () => {
  it('covered: the page\'s bar (drag) and its window buttons (no-drag) are the only regions, and the last declared', async () => {
    const rules = regionRules()
    await render(h(React.Fragment, null, h(Page), h(AppBehind, { covered: true })))
    const behind = document.querySelector('[data-testid="app-behind"]')!
    expect(behind.hasAttribute('inert')).toBe(true)
    // The app behind is laid out and still carries the classes...
    const marked = Array.from(behind.querySelectorAll('.titlebar-drag, .titlebar-no-drag'))
    expect(marked.length).toBeGreaterThanOrEqual(6)
    // ...but declares no region at all.
    for (const el of marked) expect(regionOf(el, rules), el.className).toBeNull()
    const regions = declaredRegions(rules)
    expect(regions.map((r) => r.region)).toEqual(['drag', 'no-drag'])
    expect(regions[0].el).toBe(topBar())
    expect(regions[1].el).toBe(document.querySelector('.ob-root [data-testid="window-controls"]'))
  })

  it('not covered: the title bar declares its regions as before (its drag strip, then the no-drag parts)', async () => {
    const rules = regionRules()
    await render(h(AppBehind, { covered: false }))
    expect(document.querySelector('[data-testid="app-behind"]')!.hasAttribute('inert')).toBe(false)
    const regions = declaredRegions(rules)
    const bar = document.querySelector('[data-testid="app-behind"] > .titlebar-drag')
    expect(bar).not.toBeNull()
    expect(regions[0]).toEqual({ el: bar, region: 'drag' })
    expect(regions.slice(1).map((r) => r.region).every((r) => r === 'no-drag')).toBe(true)
    expect(regions.some((r) => r.el.getAttribute('data-testid') === 'window-controls'), 'the title bar\'s window buttons').toBe(true)
    expect(regions.some((r) => r.el.tagName === 'MAIN'), 'the main column').toBe(true)
  })

  it('every region in the renderer goes through the two classes, so the inert rule covers them all', () => {
    const rules = regionRules()
    // In styles.css, only the two classes declare a region; the inert rule
    // names both and declares none.
    expect(rules.filter((r) => r.value === 'drag' || r.value === 'no-drag').map((r) => r.selector))
      .toEqual(['.titlebar-drag', '.titlebar-no-drag'])
    for (const cls of ['.titlebar-drag', '.titlebar-no-drag']) {
      const neutral = rules.find((r) => r.selector === `[inert] ${cls}`)
      expect(neutral, `[inert] ${cls}`).toBeDefined()
      expect(['initial', 'none']).toContain(neutral!.value)
    }
    // No other renderer file declares one inline or in its own stylesheet.
    const dir = resolve(__dirname, '../../../src/renderer')
    const offenders: string[] = []
    const walk = (d: string) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (/\.(tsx?|css)$/.test(ent.name) && p !== join(dir, 'styles.css')
          && /app-region|AppRegion|appRegion/.test(readFileSync(p, 'utf8'))) offenders.push(p)
      }
    }
    walk(dir)
    expect(offenders).toEqual([])
  })
})
