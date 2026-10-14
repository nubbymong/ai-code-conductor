// @vitest-environment jsdom
/**
 * First-run setup when Claude Code is not installed (owner decisions D1 to D4,
 * 2026-10-10; ADR-024): the screen lists main's install commands for Claude
 * Code, Anthropic's native installer first and npm second, each with Run it
 * for me and Copy. Run it for me asks first (for the installer, naming the
 * host it downloads its script from), then runs main's line in a terminal on
 * this screen, started exactly as the install tab is (shell only, never
 * elevated, no command secrets). The line ends its shell when the command
 * ends, and setup then checks again: found, it goes on to the Claude Code
 * setup terminal; not found, it says so with the exit code and what to do.
 * It never advises a restart unless main says a restart would help.
 *
 * Review fixes (2026-10-10): Check again works while the command runs; when
 * Anthropic's installer left Claude Code in its own folder, off PATH, the
 * screen says so and offers Add it to PATH for me (main computes the folder;
 * this sends only the provider id) and Not now; every Setup screen has Exit;
 * and the screens' buttons follow one rule (BUTTON_RULE).
 *
 * The 2.1.1 closeout (F4): a Check again that finds Claude Code
 * while the install still runs leaves it running and says it is finishing
 * (macOS and Linux also offer Stop it and continue); only the latest of two
 * overlapping checks may change the screen; the Windows words never say to
 * press Back at a prompt; and with a PATH hint showing, Check again says it
 * checked again.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { InstallRecipeView } from '../../../src/shared/providers'
import { claudeInstallRecipes } from '../../../src/main/providers/claude/install-recipes'
import { installRecipeView } from '../../../src/main/providers/core/recipe-run-line'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const RECIPES: InstallRecipeView[] = claudeInstallRecipes('win32').map((r) => installRecipeView(r, 'win32'))
const NATIVE = RECIPES[0]
const NPM = RECIPES[1]

const setup = {
  getDefaultDataDir: vi.fn(async () => 'C:\\data'),
  getResourcesDir: vi.fn(async () => 'C:\\resources'),
  selectDataDir: vi.fn(async () => null),
  selectResourcesDir: vi.fn(async () => null),
  setDataDir: vi.fn(async () => true),
  setResourcesDir: vi.fn(async () => true),
  probeCli: vi.fn(async (): Promise<{ installed: boolean; path?: string; probe: string; pathHint?: unknown }> => ({ installed: false, probe: 'PATH walk' })),
  spawnCliSetup: vi.fn(async () => '__cli_setup__'),
  killCliSetup: vi.fn(async () => true),
}
const exits = new Map<string, (code: number) => void>()
const order: string[] = []
const pty = {
  onData: vi.fn(() => () => {}),
  onExit: vi.fn((id: string, cb: (code: number) => void) => { order.push(`onExit ${id}`); exits.set(id, cb); return () => { exits.delete(id) } }),
  write: vi.fn(),
  spawn: vi.fn(async (id: string) => { order.push(`spawn ${id}`); return { started: true } }),
  kill: vi.fn(),
}
const providerAccounts = {
  installRecipes: vi.fn(async () => RECIPES),
  addToPath: vi.fn(async (_id: string) => ({ ok: true, added: 'added', installation: {} }) as Record<string, unknown>),
}
// The whole window API: every setup screen draws the window's own buttons
// (WindowDragStrip), which read the maximized state on mount.
const windowApi = { close: vi.fn(), minimize: vi.fn(), maximize: vi.fn(), isMaximized: vi.fn(async () => false), onMaximizedChanged: vi.fn(() => () => {}) }
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, setup, pty, providerAccounts, window: windowApi }
const writeText = vi.fn(async () => undefined)
Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true })

vi.mock('@xterm/xterm', () => ({ Terminal: class { cols = 80; rows = 24; loadAddon() {} open() {} write() {} writeln() {} onData() {} dispose() {} focus() {} } }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

// The terminal opens once its container has a size, which jsdom never gives.
const sized = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
const sizedH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 })
afterAll(() => {
  if (sized) Object.defineProperty(HTMLElement.prototype, 'clientWidth', sized)
  if (sizedH) Object.defineProperty(HTMLElement.prototype, 'clientHeight', sizedH)
})

const { default: SetupDialog } = await import('../../../src/renderer/components/SetupDialog')
const { BUTTON_RULE } = await import('../../../src/renderer/onboarding/InstallRecipeList')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  for (const f of [...Object.values(setup), ...Object.values(pty), providerAccounts.installRecipes, providerAccounts.addToPath, windowApi.close, writeText]) f.mockClear()
  providerAccounts.addToPath.mockResolvedValue({ ok: true, added: 'added', installation: {} })
  setup.probeCli.mockResolvedValue({ installed: false, probe: 'PATH walk' })
  providerAccounts.installRecipes.mockResolvedValue(RECIPES)
  exits.clear()
  order.length = 0
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} }
  ;(globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(0), 0)
  ;(window as unknown as { electronPlatform?: string }).electronPlatform = 'win32'
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
/** A probe answer the test releases when it chooses. */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
/** Windows (F4): the line ends its terminal when the command ends, also
 *  on Ctrl+C, and setup then checks again by itself; Back stops the install. */
const WIN_SUBTITLE = 'The command runs in the terminal below; it may show nothing for a minute while it downloads. Answer any question it asks there. Setup checks again by itself when it ends. If the terminal says the install finished or failed and setup has not moved on, press Check again. Back stops the install.'
const WIN_NOT_YET = 'Claude Code was not found yet. The install may still be running: setup checks again by itself when it ends. If the terminal says the install finished or failed and setup has not moved on, press Check again. Back stops the install.'
async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
async function renderMissing() {
  await act(async () => { root.render(React.createElement(SetupDialog, { onComplete: vi.fn(), initialStep: 2 })) })
  await settle()
}
async function click(id: string) {
  await act(async () => { byTest(id)!.click() })
  await settle()
}
async function startInstall(r: InstallRecipeView) {
  await click(`setup-recipe-run-${r.id}`)
  await click(`setup-recipe-confirm-run-${r.id}`)
  const id = pty.spawn.mock.calls[0]?.[0] as string
  return id
}

describe('first-run setup: installing Claude Code from the setup screen', () => {
  it("lists Anthropic's native installer first, then npm, each with Run it for me and Copy", async () => {
    await renderMissing()
    expect(providerAccounts.installRecipes).toHaveBeenCalledWith('claude')
    const shown = [...byTest('setup-recipes-install')!.querySelectorAll('[data-testid^="setup-recipe-command-"]')].map((c) => c.textContent)
    expect(shown).toEqual(['irm https://claude.ai/install.ps1 | iex', 'npm.cmd install -g @anthropic-ai/claude-code'])
    for (const r of RECIPES) {
      expect(byTest(`setup-recipe-run-${r.id}`)!.textContent, r.id).toBe('Run it for me')
      expect(byTest(`setup-recipe-copy-${r.id}`)!.textContent, r.id).toBe('Copy')
    }
    expect(byTest('setup-recipes-install')!.textContent).toContain('From Anthropic')
    // The screen's own ways out stay.
    expect(byTest('setup-cli-retry')).not.toBeNull()
    expect(byTest('setup-cli-back')).not.toBeNull()
  })

  it('Copy copies the command as shown and starts nothing', async () => {
    await renderMissing()
    await click(`setup-recipe-copy-${NPM.id}`)
    expect(writeText).toHaveBeenCalledWith('npm.cmd install -g @anthropic-ai/claude-code')
    expect(pty.spawn).not.toHaveBeenCalled()
  })

  it('Run it for me on the native installer asks first: it names claude.ai, says it downloads and runs a script, and shows the line; Cancel starts nothing', async () => {
    await renderMissing()
    await click(`setup-recipe-run-${NATIVE.id}`)
    expect(byTest(`setup-recipe-confirm-text-${NATIVE.id}`)!.textContent).toBe(
      'This downloads a script from claude.ai and runs it. Run this in a terminal on this screen? It types the line below, and setup checks again when the command ends.',
    )
    expect(byTest(`setup-recipe-run-line-${NATIVE.id}`)!.textContent).toBe('$failed = $true; try { irm https://claude.ai/install.ps1 | iex; $failed = $false } catch { $_ } finally { if ($failed) { exit 1 } }; exit $LASTEXITCODE')
    await click(`setup-recipe-cancel-${NATIVE.id}`)
    expect(byTest(`setup-recipe-confirm-${NATIVE.id}`)).toBeNull()
    expect(pty.spawn).not.toHaveBeenCalled()
  })

  it("Run it starts one terminal on this screen with the install tab's options, listening before it starts; never the setup terminal", async () => {
    await renderMissing()
    const id = await startInstall(NATIVE)
    expect(byTest('setup-cli-install')).not.toBeNull()
    expect(pty.spawn).toHaveBeenCalledTimes(1)
    expect(pty.spawn).toHaveBeenCalledWith(id, {
      cols: 80, rows: 24, shellOnly: true, provider: 'claude',
      terminalOptions: { command: NATIVE.runLine, elevated: false, noCommandSecrets: true },
    })
    expect(order.indexOf(`onExit ${id}`)).toBeGreaterThanOrEqual(0)
    expect(order.indexOf(`onExit ${id}`)).toBeLessThan(order.indexOf(`spawn ${id}`))
    expect(setup.spawnCliSetup).not.toHaveBeenCalled()
  })

  it('when the command ends and Claude Code is found, setup goes on to the Claude Code setup terminal', async () => {
    await renderMissing()
    const id = await startInstall(NATIVE)
    const probes = setup.probeCli.mock.calls.length
    setup.probeCli.mockResolvedValue({ installed: true, path: 'C:\\Users\\u\\.local\\bin\\claude.exe', probe: 'PATH walk' })
    await act(async () => { exits.get(id)!(0) })
    await settle()
    expect(setup.probeCli.mock.calls.length).toBe(probes + 1)
    expect(byTest('setup-cli-install')).toBeNull()
    expect(byTest('setup-cli-missing')).toBeNull()
    expect(container.textContent).toContain('Claude CLI Setup')
    expect(setup.spawnCliSetup).toHaveBeenCalledTimes(1)
  })

  it('when it ends and Claude Code is still not found, the screen says so with the exit code and what to do; Check again and Back stay', async () => {
    await renderMissing()
    const id = await startInstall(NPM)
    const reads = providerAccounts.installRecipes.mock.calls.length
    await act(async () => { exits.get(id)!(1) })
    await settle()
    expect(byTest('setup-cli-install')).not.toBeNull()
    expect(byTest('setup-cli-install-ended')!.textContent).toBe(
      'The command ended with exit code 1, but Claude Code was still not found. The terminal shows what happened: fix what it reports and run it again, or try another command. Back lists the other install commands.',
    )
    expect(providerAccounts.installRecipes.mock.calls.length).toBeGreaterThan(reads)
    expect((byTest('setup-cli-install-retry') as HTMLButtonElement).disabled).toBe(false)
    const probes = setup.probeCli.mock.calls.length
    await click('setup-cli-install-retry')
    expect(setup.probeCli.mock.calls.length).toBe(probes + 1)
    // An ended command is not killed on the way out.
    await click('setup-cli-install-back')
    expect(pty.kill).not.toHaveBeenCalled()
    expect(byTest('setup-cli-missing')).not.toBeNull()
  })

  it('a command that ends with code 0 is not said to have failed', async () => {
    await renderMissing()
    const id = await startInstall(NATIVE)
    await act(async () => { exits.get(id)!(0) })
    await settle()
    expect(byTest('setup-cli-install-ended')!.textContent).toMatch(/^The command ended, but Claude Code was still not found\./)
  })

  // ux MAJOR 2 (2026-10-10): a command whose shell never ends (an error
  // that abandons the typed line, Ctrl+C) must not leave the screen without a
  // way on. Check again works while it runs: it checks without stopping it.
  // F4 (aicc_planning#194): when that check finds Claude Code, the
  // install is NOT stopped (Anthropic's installer can still be finishing);
  // the page says so and setup goes on when the terminal ends.
  it('Check again works while the command runs: it checks and leaves it running; found, it still leaves it running and says the install is finishing', async () => {
    await renderMissing()
    const id = await startInstall(NATIVE)
    const retry = byTest('setup-cli-install-retry') as HTMLButtonElement
    expect(retry.disabled).toBe(false)
    expect(retry.textContent).toBe('Check again')
    const probes = setup.probeCli.mock.calls.length
    await click('setup-cli-install-retry')
    expect(setup.probeCli.mock.calls.length).toBe(probes + 1)
    expect(pty.kill).not.toHaveBeenCalled()
    expect(byTest('setup-cli-install')).not.toBeNull()
    expect(byTest('setup-cli-install-not-yet')!.textContent).toBe(WIN_NOT_YET)
    setup.probeCli.mockResolvedValue({ installed: true, path: 'C:\\Users\\u\\.local\\bin\\claude.exe', probe: 'PATH walk' })
    await click('setup-cli-install-retry')
    expect(pty.kill).not.toHaveBeenCalled()
    expect(byTest('setup-cli-install')).not.toBeNull()
    expect(byTest('setup-cli-install-found')!.textContent).toBe(
      'Claude Code was found. The install is still finishing in the terminal above; setup goes on by itself when it ends. Back stops the install.',
    )
    expect(byTest('setup-cli-install-not-yet')).toBeNull()
    // Continue waits for the terminal; Windows offers no way to stop it and go on.
    const go = byTest('setup-cli-install-continue') as HTMLButtonElement
    expect(go.textContent).toBe('Continue')
    expect(go.disabled).toBe(true)
    expect(byTest('setup-cli-install-retry')).toBeNull()
    expect(byTest('setup-cli-install-stop')).toBeNull()
    expect(setup.spawnCliSetup).not.toHaveBeenCalled()
    // The install ends: setup checks again by itself and goes on, nothing stopped.
    await act(async () => { exits.get(id)!(0) })
    await settle()
    expect(byTest('setup-cli-install')).toBeNull()
    expect(setup.spawnCliSetup).toHaveBeenCalledTimes(1)
    expect(pty.kill).not.toHaveBeenCalled()
  })

  it('Windows: the screen says the installer can be quiet, that setup checks again by itself when it ends, when to press Check again, and that Back stops the install; never "press Back" at a prompt', async () => {
    await renderMissing()
    await startInstall(NATIVE)
    const text = byTest('setup-cli-install')!.textContent!
    expect(text).toContain(WIN_SUBTITLE)
    expect(text).not.toMatch(/at a prompt/)
    await click('setup-cli-install-retry')
    const notYet = byTest('setup-cli-install-not-yet')!.textContent!
    expect(notYet).not.toMatch(/back at a prompt/)
    expect(notYet).not.toMatch(/press Back/)
    expect(notYet).toContain('Back stops the install.')
  })

  it('macOS and Linux: the screen keeps the prompt wording, since a shell left at a prompt never ends by itself', async () => {
    ;(window as unknown as { electronPlatform?: string }).electronPlatform = 'darwin'
    await renderMissing()
    await startInstall(NATIVE)
    expect(byTest('setup-cli-install')!.textContent).toContain(
      'The command runs in the terminal below; it may show nothing for a minute while it downloads. Answer any question it asks there. Setup checks again when it ends; if it stops at a prompt, press Check again.',
    )
    await click('setup-cli-install-retry')
    expect(byTest('setup-cli-install-not-yet')!.textContent).toBe(
      'Claude Code was not found yet. If the terminal above is back at a prompt, the command has ended: press Back to try another command.',
    )
  })

  it('macOS and Linux: found while the command runs offers Stop it and continue, which stops the terminal and goes on', async () => {
    ;(window as unknown as { electronPlatform?: string }).electronPlatform = 'linux'
    await renderMissing()
    const id = await startInstall(NATIVE)
    setup.probeCli.mockResolvedValue({ installed: true, path: '/home/u/.local/bin/claude', probe: "/bin/bash -lc 'command -v claude'" })
    await click('setup-cli-install-retry')
    expect(pty.kill).not.toHaveBeenCalled()
    expect(byTest('setup-cli-install-found')!.textContent).toBe(
      'Claude Code was found. The install is still finishing in the terminal above; setup goes on by itself when it ends. If the terminal is back at a prompt, the command has ended: press Stop it and continue.',
    )
    // Exit, then the alternative, then the commit last (BUTTON_RULE).
    const stop = byTest('setup-cli-install-stop') as HTMLButtonElement
    expect(stop.textContent).toBe('Stop it and continue')
    expect(stop.getAttribute('style')).toContain('var(--surface-overlay)')
    const right = [...stop.parentElement!.children].map((b) => b.getAttribute('data-testid')).filter(Boolean)
    expect(right.slice(-3)).toEqual(['setup-exit', 'setup-cli-install-stop', 'setup-cli-install-continue'])
    await click('setup-cli-install-stop')
    expect(pty.kill).toHaveBeenCalledWith(id)
    expect(byTest('setup-cli-install')).toBeNull()
    expect(setup.spawnCliSetup).toHaveBeenCalledTimes(1)
  })

  // F4 (aicc_planning#198 n3): two checks can overlap (a Check again still
  // out when the command ends and setup checks by itself; Back during a
  // check). Only the latest may change the button or the found state. This
  // test pins the install screen's side (the check the command's end started
  // decides, and the button stays Checking); the sequence guard in probeCli
  // itself is pinned by the Back-during-a-check test below, the one place an
  // older answer could otherwise repaint the screen.
  it('a Check again still out when the command ends leaves the button to the check the end started: it cannot re-enable it or show its own answer', async () => {
    await renderMissing()
    const id = await startInstall(NPM)
    const first = deferred<{ installed: boolean; probe: string }>()
    setup.probeCli.mockImplementationOnce(() => first.promise)
    await click('setup-cli-install-retry')
    expect((byTest('setup-cli-install-retry') as HTMLButtonElement).disabled).toBe(true)
    const second = deferred<{ installed: boolean; probe: string }>()
    setup.probeCli.mockImplementationOnce(() => second.promise)
    await act(async () => { exits.get(id)!(1) })
    await settle()
    // The older check answers first: it changes nothing.
    await act(async () => { first.resolve({ installed: false, probe: 'PATH walk' }) })
    await settle()
    const button = byTest('setup-cli-install-retry') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('Checking…')
    expect(byTest('setup-cli-install-not-yet')).toBeNull()
    expect(byTest('setup-cli-install-ended')).toBeNull()
    // The newer one decides.
    await act(async () => { second.resolve({ installed: false, probe: 'PATH walk' }) })
    await settle()
    expect((byTest('setup-cli-install-retry') as HTMLButtonElement).disabled).toBe(false)
    expect(byTest('setup-cli-install-ended')!.textContent).toContain('The command ended with exit code 1')
  })

  it('Back during a check: the check that was out cannot repaint the not-installed screen after the newer one started', async () => {
    await renderMissing()
    const id = await startInstall(NPM)
    const old = deferred<{ installed: boolean; probe: string; pathHint?: unknown }>()
    setup.probeCli.mockImplementationOnce(() => old.promise)
    await click('setup-cli-install-retry')
    const fresh = deferred<{ installed: boolean; probe: string }>()
    setup.probeCli.mockImplementationOnce(() => fresh.promise)
    await click('setup-cli-install-back')
    expect(pty.kill).toHaveBeenCalledWith(id)
    expect((byTest('setup-cli-retry') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { old.resolve({ installed: false, probe: 'old check', pathHint: { kind: 'restart' } }) })
    await settle()
    expect(byTest('setup-path-restart')).toBeNull()
    expect((byTest('setup-cli-retry') as HTMLButtonElement).disabled).toBe(true)
    expect(byTest('setup-cli-probe-detail')!.textContent).not.toContain('old check')
    await act(async () => { fresh.resolve({ installed: false, probe: 'fresh check' }) })
    await settle()
    expect((byTest('setup-cli-retry') as HTMLButtonElement).disabled).toBe(false)
    expect(byTest('setup-cli-probe-detail')!.textContent).toContain('fresh check')
    expect(byTest('setup-path-restart')).toBeNull()
  })

  it('Back stops a running command and checks again', async () => {
    await renderMissing()
    const id = await startInstall(NPM)
    const probes = setup.probeCli.mock.calls.length
    await click('setup-cli-install-back')
    expect(pty.kill).toHaveBeenCalledWith(id)
    expect(setup.probeCli.mock.calls.length).toBe(probes + 1)
    expect(byTest('setup-cli-install')).toBeNull()
    expect(byTest('setup-cli-missing')).not.toBeNull()
  })

  it('leaving setup while the command runs stops it', async () => {
    await renderMissing()
    const id = await startInstall(NPM)
    act(() => { root.unmount() })
    expect(pty.kill).toHaveBeenCalledWith(id)
    root = createRoot(container)
  })

  it('a Check again that still finds nothing says what to check, and never advises a restart main did not ask for', async () => {
    await renderMissing()
    await click('setup-cli-retry')
    expect(byTest('setup-cli-retry')!.textContent).toBe('Check again')
    expect(byTest('setup-cli-still-missing')!.textContent).toBe(
      'Claude Code was still not found. If you installed it another way, check that its folder is on your PATH, then press Check again.',
    )
    expect(container.textContent).not.toContain('quit AI Code Conductor')
  })

  it('npm needs Node.js: its Run it for me is off and says so; Copy still works; the native installer still runs', async () => {
    providerAccounts.installRecipes.mockResolvedValue([NATIVE, { ...NPM, needsNode: true }])
    await renderMissing()
    const run = byTest(`setup-recipe-run-${NPM.id}`) as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(byTest(`setup-recipe-needs-node-${NPM.id}`)!.textContent).toBe('Needs Node.js, which this app did not find on your PATH.')
    await click(`setup-recipe-copy-${NPM.id}`)
    expect(writeText).toHaveBeenCalledWith(NPM.displayCommand)
    expect((byTest(`setup-recipe-run-${NATIVE.id}`) as HTMLButtonElement).disabled).toBe(false)
  })

  it('when main cannot give the commands, the screen still shows the npm command to copy, with the Node.js version npm needs', async () => {
    providerAccounts.installRecipes.mockRejectedValue(new Error('ipc down'))
    await renderMissing()
    expect(byTest('setup-recipes-install')).toBeNull()
    expect(byTest('setup-cli-install-command')!.textContent).toBe('npm.cmd install -g @anthropic-ai/claude-code')
    expect(container.textContent).toContain('Install it with Node.js 22 or later, in a terminal:')
    expect(container.textContent).not.toContain('Node.js 18')
  })
})

const BSL = String.fromCharCode(92)
const ADD_HINT = { kind: 'add-to-path', folder: '%USERPROFILE%' + BSL + '.local' + BSL + 'bin' }
const ADD_TEXT = 'Claude Code is installed in %USERPROFILE%' + BSL + '.local' + BSL + 'bin, but that folder is not on your PATH yet, so this app and your terminals cannot find it. Add it to PATH for me adds that one folder to the end of your PATH for your Windows account; nothing else in it changes.'

// The PATH finding of the first-run test (2026-10-10; ADR-024): Anthropic's
// installer puts claude.exe in %USERPROFILE%\.local\bin and never adds that
// folder to PATH. Setup says so, offers Add it to PATH for me and Not now,
// and never advises a restart that cannot help.
describe("first-run setup: Claude Code installed in Anthropic's folder, off PATH", () => {
  it('after the install ends: the folder is named, Add it to PATH for me sends only the provider id, and setup goes on', async () => {
    await renderMissing()
    const id = await startInstall(NATIVE)
    setup.probeCli.mockResolvedValue({ installed: false, probe: 'PATH walk', pathHint: ADD_HINT })
    await act(async () => { exits.get(id)!(0) })
    await settle()
    expect(byTest('setup-path-hint-text')!.textContent).toBe(ADD_TEXT)
    expect(byTest('setup-cli-install-ended')).toBeNull()
    expect(container.textContent).not.toContain('quit AI Code Conductor')
    setup.probeCli.mockResolvedValue({ installed: true, path: 'x', probe: 'PATH walk' })
    await click('setup-path-add')
    expect(providerAccounts.addToPath).toHaveBeenCalledTimes(1)
    expect(providerAccounts.addToPath.mock.calls[0]).toEqual(['claude'])
    expect(byTest('setup-cli-install')).toBeNull()
    expect(setup.spawnCliSetup).toHaveBeenCalledTimes(1)
  })

  it('on the not-installed screen too, under its own title; Not now says what it means and keeps every way on', async () => {
    setup.probeCli.mockResolvedValue({ installed: false, probe: 'PATH walk', pathHint: ADD_HINT })
    await renderMissing()
    expect(container.textContent).toContain('Claude Code cannot be found yet')
    expect(byTest('setup-path-hint-text')!.textContent).toBe(ADD_TEXT)
    await click('setup-path-not-now')
    expect(byTest('setup-path-hint-text')!.textContent).toBe(
      'Your PATH was not changed, so Claude Code cannot be used from this app yet. To use it, add %USERPROFILE%' + BSL + '.local' + BSL + 'bin to your PATH yourself (in Windows, search for "Edit environment variables for your account", open Path and add it with New), then press Check again. Or add it here.',
    )
    expect(providerAccounts.addToPath).not.toHaveBeenCalled()
    for (const way of ['setup-cli-retry', 'setup-cli-back', 'setup-codex-only-button', 'setup-exit', 'setup-path-add']) expect(byTest(way), way).not.toBeNull()
    expect(byTest('setup-path-not-now')).toBeNull()
  })

  it('a PATH change main refused says why and how to do it by hand; nothing moves on', async () => {
    setup.probeCli.mockResolvedValue({ installed: false, probe: 'PATH walk', pathHint: ADD_HINT })
    providerAccounts.addToPath.mockResolvedValue({ ok: false, code: 'internal', message: 'Windows PowerShell could not change your PATH. The app log has the detail.' })
    await renderMissing()
    await click('setup-path-add')
    expect(byTest('setup-path-error')!.textContent).toContain('Windows PowerShell could not change your PATH.')
    expect(byTest('setup-path-error')!.textContent).toContain('then press Check again.')
    expect(setup.spawnCliSetup).not.toHaveBeenCalled()
  })

  // F4 (aicc_planning#194): with a PATH hint showing, a Check again that still
  // finds nothing used to change nothing on screen.
  it('with a PATH hint showing, Check again says it checked again just now', async () => {
    setup.probeCli.mockResolvedValue({ installed: false, probe: 'PATH walk', pathHint: ADD_HINT })
    await renderMissing()
    expect(byTest('setup-cli-checked-again')).toBeNull()
    const probes = setup.probeCli.mock.calls.length
    await click('setup-cli-retry')
    expect(setup.probeCli.mock.calls.length).toBe(probes + 1)
    expect(byTest('setup-path-hint-text')!.textContent).toBe(ADD_TEXT)
    expect(byTest('setup-cli-checked-again')!.textContent).toBe('Checked again just now: Claude Code was still not found.')
    expect(byTest('setup-cli-still-missing')).toBeNull()
  })

  it('a restart is advised only when main says it would help', async () => {
    setup.probeCli.mockResolvedValue({ installed: false, probe: 'PATH walk', pathHint: { kind: 'restart' } })
    await renderMissing()
    expect(byTest('setup-path-restart')!.textContent).toBe(
      'Claude Code is in a folder that your PATH in Windows names, but this app could not pick that folder up while it runs. Quit AI Code Conductor and start it again so it starts with that PATH.',
    )
    expect(byTest('setup-path-add')).toBeNull()
  })

  // aicc_planning#190: a restart main
  // says MAY help, though it did not see Claude Code (a Windows PATH entry
  // added since the app started names a variable it does not have), is a
  // note. It used to replace the not-installed title and words, and after a
  // failed install the exit-code callout, so a user whose PATH named such a
  // variable lost the real news.
  const NOTE_HINT = { kind: 'restart', unresolved: true }
  const NOTE_TEXT = "Your PATH in Windows also names a folder through a variable set after this app started (such as nvm-windows' NVM_SYMLINK), which the app cannot look in until it starts again. If you installed Claude Code there, quit AI Code Conductor and start it again."
  it('a restart that may help, Claude Code not seen: the not-installed title and words stay, the note shows beside them, and Check again still says what to check', async () => {
    setup.probeCli.mockResolvedValue({ installed: false, probe: 'PATH walk', pathHint: NOTE_HINT })
    await renderMissing()
    expect(container.textContent).toContain('Claude Code is not installed')
    expect(container.textContent).not.toContain('cannot be found yet')
    expect(byTest('setup-cli-missing')).not.toBeNull()
    expect(byTest('setup-path-restart')!.textContent).toBe(NOTE_TEXT)
    await click('setup-cli-retry')
    expect(byTest('setup-cli-still-missing')!.textContent).toBe(
      'Claude Code was still not found. If you installed it another way, check that its folder is on your PATH, then press Check again.',
    )
    expect(byTest('setup-cli-checked-again')).toBeNull()
    expect(byTest('setup-cli-missing')).not.toBeNull()
    expect(byTest('setup-path-restart')!.textContent).toBe(NOTE_TEXT)
  })

  it('after a failed install, that note keeps the exit-code callout and shows after it', async () => {
    await renderMissing()
    const id = await startInstall(NPM)
    setup.probeCli.mockResolvedValue({ installed: false, probe: 'PATH walk', pathHint: NOTE_HINT })
    await act(async () => { exits.get(id)!(1) })
    await settle()
    const ended = byTest('setup-cli-install-ended')!
    expect(ended.textContent).toBe(
      'The command ended with exit code 1, but Claude Code was still not found. The terminal shows what happened: fix what it reports and run it again, or try another command. Back lists the other install commands.',
    )
    const note = byTest('setup-path-restart')!
    expect(note.textContent).toBe(NOTE_TEXT)
    expect(ended.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect((byTest('setup-cli-install-retry') as HTMLButtonElement).disabled).toBe(false)
  })

  it('macOS and Linux: the shell file and the command to run once, with Copy; nothing is added for the user', async () => {
    const line = "printf '" + BSL + 'nexport PATH="$HOME/.local/bin:$PATH"' + BSL + "n' >> \"" + '$' + '{ZDOTDIR:-$HOME}/.zprofile"'
    setup.probeCli.mockResolvedValue({ installed: false, probe: 'command -v claude', pathHint: { kind: 'shell-profile', folder: '~/.local/bin', file: '~/.zprofile', line } })
    await renderMissing()
    expect(byTest('setup-path-hint-text')!.textContent).toBe(
      'Claude Code is installed in ~/.local/bin, but the PATH your login shell builds does not include that folder, so this app cannot find it. Run this once in a terminal. It adds the folder to ~/.zprofile, which the app reads through your login shell; then press Check again. An installer may name ~/.zshrc or ~/.bashrc instead, which the app does not read.',
    )
    expect(byTest('setup-path-line')!.textContent).toBe(line)
    await click('setup-path-copy')
    expect(writeText).toHaveBeenCalledWith(line)
    expect(byTest('setup-path-add')).toBeNull()
    expect(providerAccounts.addToPath).not.toHaveBeenCalled()
  })
})

// Owner finding 2 (2026-10-10): the first setup screen had no way out, and
// the buttons' size, order and style changed from screen to screen. Every
// Setup screen now has Exit, and every setup and install button follows one
// rule (BUTTON_RULE in InstallRecipeList.tsx).
describe('first-run setup: Exit on every screen, and one button rule', () => {
  /** The footer's right-hand buttons, left to right: those after its spacer. */
  const rightButtons = () => {
    const kids = [...byTest('setup-exit')!.parentElement!.children]
    const spacer = kids.findIndex((k) => k.tagName === 'DIV' && k.className === 'flex-1')
    expect(spacer).toBeGreaterThanOrEqual(0)
    return kids.slice(spacer + 1) as HTMLButtonElement[]
  }
  const footerOk = (primaryTestId: string) => {
    const right = rightButtons()
    expect(right[0].getAttribute('data-testid')).toBe('setup-exit')
    expect(right[right.length - 1].getAttribute('data-testid')).toBe(primaryTestId)
    for (const b of right) {
      expect(b.className, b.textContent ?? '').toContain('h-7')
      expect(b.className, b.textContent ?? '').not.toContain('h-9')
    }
    // One primary per group, the commit, last: every other button is secondary.
    const brand = right.filter((b) => (b.getAttribute('style') ?? '').includes('var(--brand)'))
    expect(brand.map((b) => b.getAttribute('data-testid'))).toEqual([primaryTestId])
    expect(byTest('setup-exit')!.getAttribute('style')).toContain('var(--surface-overlay)')
  }

  it('the rule is written down once', () => {
    expect(BUTTON_RULE).toBe('Every button is a DialogButton, size sm. Back alone sits at the left of a footer; every other button is right-aligned, in its footer or on the row of the item it acts on. Within a group, left to right: the way out first (Exit, Cancel, Not now), then the alternatives, then the commit last. At most one primary per group, the commit; every other button is secondary. 8px between buttons.')
  })

  it('the first screen (folders): Exit, then Continue; Exit closes the window, which quits the app', async () => {
    await act(async () => { root.render(React.createElement(SetupDialog, { onComplete: vi.fn() })) })
    await settle()
    expect(container.textContent).toContain('Welcome to AI Code Conductor')
    expect(byTest('setup-exit')!.textContent).toBe('Exit')
    footerOk('setup-continue')
    await click('setup-exit')
    expect(windowApi.close).toHaveBeenCalledTimes(1)
  })

  it('the not-installed screen: Back at the left; Exit, then Check again', async () => {
    await renderMissing()
    footerOk('setup-cli-retry')
    expect(byTest('setup-cli-back')!.className).toContain('h-7')
    await click('setup-exit')
    expect(windowApi.close).toHaveBeenCalledTimes(1)
  })

  it('the install screen: Exit stops the running command first, then closes the window', async () => {
    await renderMissing()
    const id = await startInstall(NPM)
    footerOk('setup-cli-install-retry')
    await click('setup-exit')
    expect(pty.kill).toHaveBeenCalledWith(id)
    expect(windowApi.close).toHaveBeenCalledTimes(1)
  })

  it('the Claude Code setup screen: Exit, Skip for now, then the commit; no green fill, no text link', async () => {
    setup.probeCli.mockResolvedValue({ installed: true, path: 'x', probe: 'PATH walk' })
    await renderMissing()
    expect(container.textContent).toContain('Claude CLI Setup')
    footerOk('setup-cli-finish')
    expect(byTest('setup-cli-skip')!.className).toContain('h-7')
    expect(byTest('setup-cli-finish')!.getAttribute('style') ?? '').not.toContain('status-success')
    await click('setup-exit')
    expect(setup.killCliSetup).toHaveBeenCalled()
    expect(windowApi.close).toHaveBeenCalledTimes(1)
  })

  it('Exit before the Claude Code setup terminal has started still asks main to stop it, so a start main is still preparing starts nothing', async () => {
    setup.probeCli.mockResolvedValue({ installed: true, path: 'x', probe: 'PATH walk' })
    // Main is still preparing the terminal's first start: no answer yet.
    setup.spawnCliSetup.mockImplementation(() => new Promise<string>(() => { /* never answers in this case */ }))
    try {
      await renderMissing()
      expect(container.textContent).toContain('Claude CLI Setup')
      await click('setup-exit')
      expect(setup.killCliSetup).toHaveBeenCalled()
      expect(windowApi.close).toHaveBeenCalledTimes(1)
    } finally {
      setup.spawnCliSetup.mockImplementation(async () => '__cli_setup__')
    }
  })

  it('an install option: Copy, then Run it for me, both secondary and small; its confirmation: Cancel, then Run it, the one primary', async () => {
    await renderMissing()
    const row = byTest(`setup-recipe-${NATIVE.id}`)!
    const buttons = [...row.querySelectorAll('button')]
    expect(buttons.map((b) => b.getAttribute('data-testid'))).toEqual([`setup-recipe-copy-${NATIVE.id}`, `setup-recipe-run-${NATIVE.id}`])
    for (const b of buttons) {
      expect(b.className).toContain('h-7')
      expect(b.getAttribute('style')).toContain('var(--surface-overlay)')
    }
    await click(`setup-recipe-run-${NATIVE.id}`)
    const confirm = byTest(`setup-recipe-confirm-${NATIVE.id}`)!
    const answers = [...confirm.querySelectorAll('button')]
    expect(answers.map((b) => b.getAttribute('data-testid'))).toEqual([`setup-recipe-cancel-${NATIVE.id}`, `setup-recipe-confirm-run-${NATIVE.id}`])
    expect(answers[0].getAttribute('style')).toContain('var(--surface-overlay)')
    expect(answers[1].getAttribute('style')).toContain('var(--brand)')
    for (const b of answers) expect(b.className).toContain('h-7')
  })

  it('the PATH prompt: Not now, then Add it to PATH for me, the one primary, small', async () => {
    setup.probeCli.mockResolvedValue({ installed: false, probe: 'PATH walk', pathHint: ADD_HINT })
    await renderMissing()
    const group = byTest('setup-path-add')!.parentElement!
    const buttons = [...group.querySelectorAll('button')]
    expect(buttons.map((b) => b.getAttribute('data-testid'))).toEqual(['setup-path-not-now', 'setup-path-add'])
    expect(buttons[0].getAttribute('style')).toContain('var(--surface-overlay)')
    expect(buttons[1].getAttribute('style')).toContain('var(--brand)')
    for (const b of buttons) expect(b.className).toContain('h-7')
  })
})
