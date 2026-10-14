// @vitest-environment jsdom
/**
 * aicc_planning #211, follow-up: the first setup screens (SetupDialog:
 * choose the app's folders, install and set up Claude Code) replace the
 * whole app, and App draws no title bar while they show. The main window has
 * no frame on Windows and Linux, so those screens had Exit only: no
 * minimize, no maximize, nothing to drag the window by.
 *
 * Verifies, on every setup screen (loading, folders, not installed,
 * installing, Claude Code setup):
 *   - on Windows and Linux a top bar carries the window's own minimize,
 *     maximize and close, each wired to window.electronAPI.window; Exit is
 *     still there;
 *   - Close does what Exit does: it stops a command still running on the
 *     screen and the Claude Code setup terminal (also one still starting in
 *     main), then closes the window (a Close that called only window.close
 *     would skip that cleanup);
 *   - on macOS (native traffic lights) no window buttons, and nothing is
 *     asked of the window; the bar still drags;
 *   - the bar is a drag region, the controls a no-drag group inside it, and
 *     the screen's content is not in it: the overlay keeps the bar's height
 *     clear at its top; nothing else on the screen declares a region
 *     (styles.css's own rules, applied as in
 *     onboarding-shell-window-controls.test.tsx). Nothing is behind these
 *     screens (App returns early), so there is no appCovered gate to add.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { InstallRecipeView } from '../../../src/shared/providers'
import { claudeInstallRecipes } from '../../../src/main/providers/claude/install-recipes'
import { installRecipeView } from '../../../src/main/providers/core/recipe-run-line'
import { regionRules, declaredRegions } from './drag-regions'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const RECIPES: InstallRecipeView[] = claudeInstallRecipes('win32').map((r) => installRecipeView(r, 'win32'))
const NPM = RECIPES[1]

const setup = {
  getDefaultDataDir: vi.fn(async () => 'C:\\data'),
  getResourcesDir: vi.fn(async () => 'C:\\resources'),
  selectDataDir: vi.fn(async () => null),
  selectResourcesDir: vi.fn(async () => null),
  setDataDir: vi.fn(async () => true),
  setResourcesDir: vi.fn(async () => true),
  probeCli: vi.fn(async (): Promise<{ installed: boolean; path?: string; probe: string }> => ({ installed: false, probe: 'PATH walk' })),
  spawnCliSetup: vi.fn(async () => '__cli_setup__'),
  killCliSetup: vi.fn(async () => true),
}
const pty = {
  onData: vi.fn(() => () => {}),
  onExit: vi.fn(() => () => {}),
  write: vi.fn(),
  spawn: vi.fn(async () => ({ started: true })),
  kill: vi.fn(),
}
const providerAccounts = { installRecipes: vi.fn(async () => RECIPES), addToPath: vi.fn() }
const win = {
  isMaximized: vi.fn(() => Promise.resolve(false)),
  onMaximizedChanged: vi.fn((_cb: (m: boolean) => void) => () => {}),
  minimize: vi.fn(),
  maximize: vi.fn(),
  close: vi.fn(),
}
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, setup, pty, providerAccounts, window: win }

vi.mock('@xterm/xterm', () => ({ Terminal: class { cols = 80; rows = 24; loadAddon() {} open() {} write() {} writeln() {} onData() {} dispose() {} focus() {} } }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

// The terminals open once their container has a size, which jsdom never gives.
const sized = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
const sizedH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 })
afterAll(() => {
  if (sized) Object.defineProperty(HTMLElement.prototype, 'clientWidth', sized)
  if (sizedH) Object.defineProperty(HTMLElement.prototype, 'clientHeight', sizedH)
})

const h = React.createElement
const { default: SetupDialog } = await import('../../../src/renderer/components/SetupDialog')
const { WINDOW_DRAG_STRIP_CLEARANCE } = await import('../../../src/renderer/components/WindowControls')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  for (const f of [...Object.values(setup), ...Object.values(pty), ...Object.values(win), providerAccounts.installRecipes]) f.mockClear()
  setup.getDefaultDataDir.mockImplementation(async () => 'C:\\data')
  setup.probeCli.mockResolvedValue({ installed: false, probe: 'PATH walk' })
  providerAccounts.installRecipes.mockResolvedValue(RECIPES)
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} }
  ;(globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(0), 0)
  ;(window as any).electronPlatform = 'win32'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
})

const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const LABELS = ['Minimize window', 'Maximize window', 'Close window']
const control = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null
const strip = () => byTest('window-drag-strip')
/** The screen's own fixed overlay: the bar's parent. */
const overlay = () => strip()!.parentElement as HTMLElement

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
async function click(id: string) {
  await act(async () => { byTest(id)!.click() })
  await settle()
}

/** Each setup screen, opened as a user meets it; `marker` is on that screen
 *  only, and `own` is one of its own controls (or text holder). */
const SCREENS: { name: string; marker: string; own: string; open: () => Promise<void> }[] = [
  {
    name: 'loading',
    marker: '',
    own: '',
    open: async () => {
      setup.getDefaultDataDir.mockImplementation(() => new Promise<string>(() => { /* still reading */ }))
      await act(async () => { root.render(h(SetupDialog, { onComplete: vi.fn() })) })
      await settle()
      expect(document.body.textContent).toContain('Loading...')
    },
  },
  {
    name: 'folders',
    marker: 'setup-continue',
    own: 'setup-continue',
    open: async () => {
      await act(async () => { root.render(h(SetupDialog, { onComplete: vi.fn() })) })
      await settle()
    },
  },
  {
    name: 'not installed',
    marker: 'setup-cli-missing',
    own: 'setup-cli-retry',
    open: async () => {
      await act(async () => { root.render(h(SetupDialog, { onComplete: vi.fn(), initialStep: 2 })) })
      await settle()
    },
  },
  {
    name: 'installing',
    marker: 'setup-cli-install',
    own: 'setup-cli-install-retry',
    open: async () => {
      await act(async () => { root.render(h(SetupDialog, { onComplete: vi.fn(), initialStep: 2 })) })
      await settle()
      await click(`setup-recipe-run-${NPM.id}`)
      await click(`setup-recipe-confirm-run-${NPM.id}`)
    },
  },
  {
    name: 'Claude Code setup',
    marker: 'setup-cli-finish',
    own: 'setup-cli-finish',
    open: async () => {
      setup.probeCli.mockResolvedValue({ installed: true, path: 'x', probe: 'PATH walk' })
      await act(async () => { root.render(h(SetupDialog, { onComplete: vi.fn(), initialStep: 2 })) })
      await settle()
    },
  },
]

describe('the first setup screens have the window controls and a drag bar (aicc_planning #211)', () => {
  for (const screen of SCREENS) {
    describe(`the ${screen.name} screen`, () => {
      for (const platform of ['win32', 'linux']) {
        it(`${platform}: minimize, maximize and close are in its top bar, each wired to the window${screen.marker ? '; Exit stays' : ''}`, async () => {
          ;(window as any).electronPlatform = platform
          await screen.open()
          if (screen.marker) expect(byTest(screen.marker), screen.marker).not.toBeNull()
          expect(strip(), 'the top bar').not.toBeNull()
          expect(document.querySelectorAll('[data-testid="window-drag-strip"]'), 'one bar').toHaveLength(1)
          for (const label of LABELS) {
            const btn = control(label)
            expect(btn, label).not.toBeNull()
            expect(strip()!.contains(btn), `${label} is in the top bar`).toBe(true)
          }
          if (screen.marker) expect(byTest('setup-exit'), 'Exit').not.toBeNull()
          await act(async () => { control('Minimize window')!.click() })
          await act(async () => { control('Maximize window')!.click() })
          expect(win.minimize).toHaveBeenCalledTimes(1)
          expect(win.maximize).toHaveBeenCalledTimes(1)
          await act(async () => { control('Close window')!.click() })
          expect(win.close).toHaveBeenCalledTimes(1)
        })
      }

      it('Close does what Exit does: a running command and the Claude Code setup terminal are stopped, then the window closes', async () => {
        ;(window as any).electronPlatform = 'win32'
        await screen.open()
        // The command this screen runs, when it runs one (installing): its
        // terminal has not ended (onExit never fires here).
        const running = screen.name === 'installing' ? (pty.spawn.mock.calls.at(-1) as unknown[] | undefined)?.[0] : undefined
        if (screen.name === 'installing') expect(running, 'the install command started').toBeTruthy()
        for (const f of [setup.killCliSetup, pty.kill, win.close]) f.mockClear()
        await act(async () => { control('Close window')!.click() })
        expect(setup.killCliSetup, 'the Claude Code setup terminal is stopped').toHaveBeenCalledTimes(1)
        if (running) expect(pty.kill).toHaveBeenCalledWith(running)
        else expect(pty.kill).not.toHaveBeenCalled()
        expect(win.close).toHaveBeenCalledTimes(1)
        expect(setup.killCliSetup.mock.invocationCallOrder[0], 'stopped before the window closes').toBeLessThan(win.close.mock.invocationCallOrder[0])
      })

      it('darwin: no window buttons, nothing is asked of the window; the bar still drags', async () => {
        ;(window as any).electronPlatform = 'darwin'
        await screen.open()
        for (const label of LABELS) expect(control(label), label).toBeNull()
        expect(byTest('window-controls')).toBeNull()
        expect(win.isMaximized).not.toHaveBeenCalled()
        expect(strip()!.classList.contains('titlebar-drag')).toBe(true)
      })

      it('the bar (drag) and its buttons (no-drag) are the only regions; the screen\'s content is below the bar, not in it', async () => {
        const rules = regionRules()
        await screen.open()
        const bar = strip()!
        expect(bar.classList.contains('h-10'), 'the title bar\'s 40px').toBe(true)
        // A bar across the top of the window, not a box in the screen's row.
        for (const c of ['absolute', 'top-0', 'inset-x-0']) expect(bar.classList.contains(c), c).toBe(true)
        const regions = declaredRegions(rules)
        expect(regions.map((r) => r.region)).toEqual(['drag', 'no-drag'])
        expect(regions[0].el).toBe(bar)
        expect(regions[1].el).toBe(bar.querySelector('[data-testid="window-controls"]'))
        for (const label of LABELS) {
          for (let n: HTMLElement | null = control(label); n && n !== regions[1].el; n = n.parentElement) {
            expect(n.classList.contains('titlebar-drag'), label).toBe(false)
          }
        }
        if (screen.own) {
          expect(byTest(screen.own), screen.own).not.toBeNull()
          expect(bar.contains(byTest(screen.own)), `${screen.own} is not in the bar`).toBe(false)
        }
        if (screen.marker) expect(bar.contains(byTest('setup-exit')), 'Exit is not in the bar').toBe(false)
        // The bar sits on the screen's own window-covering overlay, which
        // keeps its height clear at the top.
        expect(overlay().className).toContain('fixed')
        expect(overlay().className).toContain('inset-0')
        expect(WINDOW_DRAG_STRIP_CLEARANCE).toBeGreaterThanOrEqual(40)
        expect(overlay().style.paddingTop).toBe(`${WINDOW_DRAG_STRIP_CLEARANCE}px`)
      })
    })
  }
})
