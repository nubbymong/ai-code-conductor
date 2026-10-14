// @vitest-environment jsdom
/**
 * WP2 commit 6e (canvas F2): the onboarding "Set up Codex" page, driven by
 * the Accounts snapshot's Codex installation and the providerAccounts IPC
 * (mocked here), with main's real Codex install recipes.
 *
 * Verifies:
 *   - entry checks again (discover) and reads the recipes; each return from
 *     the terminal checks again;
 *   - not found: the install recipes verbatim; the package-manager one runs
 *     in a terminal, the script is Copy only with its note; Check again;
 *   - Run in a terminal asks first, then opens a VISIBLE shell-only terminal
 *     tab (the active session) with the exact command, never elevated, and
 *     the harness steps aside; Cancel runs nothing;
 *   - too old: the version found (no minimum: the snapshot has none), the
 *     update recipe, Check again;
 *   - ready: the version rows and the three sign-in methods, which open the
 *     Accounts surface's own add-account dialog at that method, above the
 *     onboarding page;
 *   - this computer's own Codex sign-in is never offered, checked or taken
 *     in (O5, owner decision 2026-10-11), whatever main names or recorded
 *     about it: the only way in is a new Codex account, and an account
 *     2.1.1-beta.2 registered for it never counts as set up;
 *   - signed in: done, and Next continues (no Skip);
 *   - the no-registry state says so once; the update list says "update".
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot, InstallRecipeView, ProviderInstallationView } from '../../../src/shared/providers'
import { codexInstallRecipes } from '../../../src/main/providers/codex/install-recipes'
import { installRecipeView } from '../../../src/main/providers/core/recipe-run-line'
import { provider, account, snapshot, claudeMain } from './accounts-snapshot-harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Main's own recipes for Windows, as the IPC returns them (no argv): the line
// to type (`runLine`) only where main allows the recipe to run, built by main.
const RECIPES: InstallRecipeView[] = codexInstallRecipes('win32').map((r) => installRecipeView(r, 'win32'))
const NPM_INSTALL = RECIPES.find((r) => r.id === 'codex-npm-install')!
const PS1 = RECIPES.find((r) => r.id === 'codex-script-install-ps1')!
const NPM_UPDATE = RECIPES.find((r) => r.id === 'codex-npm-update')!
// What Windows types: npm.cmd, not the npm.ps1 PowerShell's execution policy
// refuses to load, and the line ends its shell however the command ends
// (ADR-024). Not the command the user is shown.
const WIN = (cmd: string) => `$failed = $true; try { ${cmd}; $failed = $false } catch { $_ } finally { if ($failed) { exit 1 } }; exit $LASTEXITCODE`
const NPM_INSTALL_LINE = WIN("npm.cmd 'install' '-g' '@openai/codex'")
const NPM_UPDATE_LINE = WIN("npm.cmd 'install' '-g' '@openai/codex@latest'")
// OpenAI's own installer, typed as its README writes it.
const PS1_LINE = WIN('powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"')

const ok = () => Promise.resolve({ ok: true })
const pa = {
  snapshot: vi.fn(),
  onChanged: vi.fn(() => () => {}),
  discover: vi.fn(),
  installRecipes: vi.fn(async () => RECIPES),
  // Retired (O5): never called. Mocked so a call would be seen.
  probeExternal: vi.fn(async () => ({ ok: false, code: 'unsupported' })),
  setEnabled: vi.fn(ok),
  adoptExternal: vi.fn(async () => ({ ok: false, code: 'unsupported' })),
  beginSetup: vi.fn(async () => ({ ok: true, accountId: 'acc-new' })),
  signIn: vi.fn(() => new Promise(() => {})),
  onSignInOutput: vi.fn(() => () => {}),
  cancelSignIn: vi.fn(ok),
  abandonSetup: vi.fn(ok),
  completeSetup: vi.fn(),
  issueSecretHandle: vi.fn(),
  sendSecret: vi.fn(),
}
const writeText = vi.fn(async () => undefined)
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, providerAccounts: pa }
// The durable yes the check may need first saves the setting; nothing reaches disk here.
vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn() }))
Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true })

const { CodexSetupStep } = await import('../../../src/renderer/onboarding/CodexSetupStep')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

let container: HTMLDivElement
let root: Root
const onNext = vi.fn()
const onBack = vi.fn()
const stepAside = vi.fn()

function codex(over: Partial<ProviderInstallationView> = {}): ProviderInstallationView {
  return provider({ providerId: 'codex', displayName: 'Codex', lastCheckedAt: 1, ...over })
}

function snap(codexOver: Partial<ProviderInstallationView>, over: Partial<AccountsSnapshot> = {}): AccountsSnapshot {
  return snapshot({
    providers: [provider({ providerId: 'claude', displayName: 'Claude Code', version: '2.1.281' }), codex(codexOver)],
    accounts: [claudeMain],
    ...over,
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  for (const f of Object.values(pa)) f.mockClear()
  pa.discover.mockReset()
  // By default the check agrees with the snapshot it was given.
  pa.discover.mockImplementation(async () => ({ ok: true, installation: useProviderAccountsStore.getState().snapshot!.providers[1] }))
  pa.installRecipes.mockResolvedValue(RECIPES)
  // The snapshot fetched after a check: by default nothing newer than what the page has.
  pa.snapshot.mockReset()
  pa.snapshot.mockResolvedValue(null)
  writeText.mockClear()
  onNext.mockReset()
  onBack.mockReset()
  stepAside.mockReset()
  useSessionStore.setState({ sessions: [], activeSessionId: null })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
})

const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
}

async function render(s: AccountsSnapshot | null, returns = 0) {
  useProviderAccountsStore.setState({ snapshot: s, loaded: true })
  await act(async () => {
    root.render(<CodexSetupStep onNext={onNext} onBack={onBack} stepAside={stepAside} returns={returns} />)
  })
  await flush()
}

async function click(id: string) {
  await act(async () => { byTest(id)!.click() })
  await flush()
}

describe('entry', () => {
  it('checks the CLI again and reads the install recipes', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(pa.discover).toHaveBeenCalledWith('codex')
    expect(pa.installRecipes).toHaveBeenCalledWith('codex')
  })

  it('shows "checking" while main has not looked yet', async () => {
    pa.discover.mockImplementation(() => new Promise(() => {}))
    await render(snap({ discoveryState: 'unchecked', version: undefined }))
    expect(byTest('codex-setup-checking')!.textContent).toContain('Checking for the Codex CLI')
  })

  it('each return from the terminal checks again', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(pa.discover).toHaveBeenCalledTimes(1)
    await act(async () => {
      root.render(<CodexSetupStep onNext={onNext} onBack={onBack} stepAside={stepAside} returns={1} />)
    })
    await flush()
    expect(pa.discover).toHaveBeenCalledTimes(2)
  })
})

describe('Codex CLI not found', () => {
  it('says so and lists the install recipes verbatim, never the update ones', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(byTest('codex-setup-check')!.textContent).toBe('!Codex CLI not found')
    expect(byTest('codex-recipes-install')!.textContent).toContain("From OpenAI's README")
    expect(byTest(`codex-recipe-command-${NPM_INSTALL.id}`)!.textContent).toBe(NPM_INSTALL.displayCommand)
    expect(byTest(`codex-recipe-command-${PS1.id}`)!.textContent).toBe(PS1.displayCommand)
    expect(byTest(`codex-recipe-${NPM_UPDATE.id}`)).toBeNull()
    expect(byTest('codex-recipes-update')).toBeNull()
  })

  it("every command offers Run it for me and Copy, OpenAI's installer first, each with main's note", async () => {
    expect(NPM_INSTALL.runLine).toBe(NPM_INSTALL_LINE)
    expect(PS1.runLine).toBe(PS1_LINE)
    await render(snap({ discoveryState: 'missing', version: undefined }))
    const rows = [...byTest('codex-recipes-install')!.querySelectorAll('[data-testid^="codex-recipe-command-"]')].map((c) => c.textContent)
    expect(rows).toEqual([PS1.displayCommand, NPM_INSTALL.displayCommand])
    for (const r of [PS1, NPM_INSTALL]) {
      expect(byTest(`codex-recipe-run-${r.id}`)!.textContent, r.id).toBe('Run it for me')
      expect((byTest(`codex-recipe-run-${r.id}`) as HTMLButtonElement).disabled, r.id).toBe(false)
      expect(byTest(`codex-recipe-copy-${r.id}`)!.textContent, r.id).toBe('Copy')
      expect(byTest(`codex-recipe-note-${r.id}`)!.textContent, r.id).toBe(r.note)
    }
  })

  it("whether a recipe runs is main's call: one main sent no line for has Run it for me off, saying why; Copy still works", async () => {
    const { runLine: _dropped, ...noLine } = NPM_INSTALL
    pa.installRecipes.mockResolvedValue([noLine, PS1])
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(noLine.method).toBe('package-manager')
    expect(noLine.autoRunAllowed).toBe(true)
    const run = byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(byTest(`codex-recipe-not-run-${NPM_INSTALL.id}`)!.textContent).toBe('The app does not run this command: copy it and run it in a terminal.')
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    expect(byTest(`codex-recipe-confirm-${NPM_INSTALL.id}`)).toBeNull()
    expect(byTest(`codex-recipe-copy-${NPM_INSTALL.id}`)!.textContent).toBe('Copy')
    await click(`codex-recipe-copy-${NPM_INSTALL.id}`)
    // Copy is the shown command, verbatim.
    expect(writeText).toHaveBeenCalledWith(NPM_INSTALL.displayCommand)
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('a script that arrives without the host it downloads from is not run: the confirmation could not name it', async () => {
    const { downloadsFrom: _dropped, ...noHost } = PS1
    pa.installRecipes.mockResolvedValue([noHost, NPM_INSTALL])
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect((byTest(`codex-recipe-run-${PS1.id}`) as HTMLButtonElement).disabled).toBe(true)
    expect((byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement).disabled).toBe(false)
  })

  it("Run it for me on OpenAI's installer asks first, naming chatgpt.com and saying it downloads and runs a script; only Run it types its line", async () => {
    expect(PS1.downloadsFrom).toBe('chatgpt.com')
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${PS1.id}`)
    expect(byTest(`codex-recipe-confirm-text-${PS1.id}`)!.textContent).toBe(
      'This downloads a script from chatgpt.com and runs it. Run this in a new terminal tab? It types the line below. Setup steps aside so you can watch it, and you come back to it when you are done.',
    )
    expect(byTest(`codex-recipe-run-line-${PS1.id}`)!.textContent).toBe(PS1_LINE)
    expect(useSessionStore.getState().sessions).toEqual([])
    await click(`codex-recipe-cancel-${PS1.id}`)
    expect(useSessionStore.getState().sessions).toEqual([])
    await click(`codex-recipe-run-${PS1.id}`)
    await click(`codex-recipe-confirm-run-${PS1.id}`)
    const s = useSessionStore.getState().sessions
    expect(s).toHaveLength(1)
    expect(s[0].terminalOptions).toEqual({ command: PS1_LINE, elevated: false, noCommandSecrets: true })
    expect(s[0].label).toBe('Install Codex')
  })

  it('a package-manager command asks first too, without the script sentence', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    expect(byTest(`codex-recipe-confirm-text-${NPM_INSTALL.id}`)!.textContent).toBe(
      'Run this in a new terminal tab? It types the line below. Setup steps aside so you can watch it, and you come back to it when you are done.',
    )
  })

  it('Node.js not found: the npm command says so and its Run it for me is off; Copy still works; the installer still runs', async () => {
    pa.installRecipes.mockResolvedValue([PS1, { ...NPM_INSTALL, needsNode: true }])
    await render(snap({ discoveryState: 'missing', version: undefined }))
    const run = byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(run.title).toBe('Needs Node.js, which this app did not find on your PATH.')
    expect(byTest(`codex-recipe-needs-node-${NPM_INSTALL.id}`)!.textContent).toBe('Needs Node.js, which this app did not find on your PATH.')
    await click(`codex-recipe-copy-${NPM_INSTALL.id}`)
    expect(writeText).toHaveBeenCalledWith(NPM_INSTALL.displayCommand)
    expect((byTest(`codex-recipe-run-${PS1.id}`) as HTMLButtonElement).disabled).toBe(false)
    expect(byTest(`codex-recipe-needs-node-${PS1.id}`)).toBeNull()
  })

  it('Copy puts the exact script command on the clipboard and runs nothing', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-copy-${PS1.id}`)
    expect(writeText).toHaveBeenCalledWith(PS1.displayCommand)
    expect(byTest(`codex-recipe-copy-${PS1.id}`)!.textContent).toBe('Copied')
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(stepAside).not.toHaveBeenCalled()
  })

  it('Run it for me asks first, showing the line it will type; Cancel runs nothing', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    expect(byTest(`codex-recipe-confirm-${NPM_INSTALL.id}`)).not.toBeNull()
    expect(byTest(`codex-recipe-run-line-${NPM_INSTALL.id}`)!.textContent).toBe(NPM_INSTALL_LINE)
    // The page still shows the documented command, verbatim.
    expect(byTest(`codex-recipe-command-${NPM_INSTALL.id}`)!.textContent).toBe(NPM_INSTALL.displayCommand)
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(stepAside).not.toHaveBeenCalled()
    await click(`codex-recipe-cancel-${NPM_INSTALL.id}`)
    expect(byTest(`codex-recipe-confirm-${NPM_INSTALL.id}`)).toBeNull()
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it("confirmed, it opens a visible shell-only terminal typing main's line exactly, and the setup steps aside", async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    await click(`codex-recipe-confirm-run-${NPM_INSTALL.id}`)
    const { sessions, activeSessionId } = useSessionStore.getState()
    expect(sessions).toHaveLength(1)
    const s = sessions[0]
    expect(s.shellOnly).toBe(true)
    expect(s.sessionType).toBe('local')
    // Transient: never saved or resumed, and its command runs once (transient-terminal.test.tsx).
    expect(s.transient).toBe(true)
    // The line main built (npm.cmd on Windows), never the shown command.
    // No command-button secrets in its shell: the install script is a third party's.
    expect(s.terminalOptions).toEqual({ command: NPM_INSTALL_LINE, elevated: false, noCommandSecrets: true })
    expect(s.terminalOptions!.command).not.toBe(NPM_INSTALL.displayCommand)
    expect(s.label).toBe('Install Codex')
    expect(activeSessionId).toBe(s.id)
    expect(stepAside).toHaveBeenCalledTimes(1)
  })

  it('while the tab it opened is open, Run is off for the page and says where it is running', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    await click(`codex-recipe-confirm-run-${NPM_INSTALL.id}`)
    const tab = useSessionStore.getState().sessions[0]
    // Back from the terminal: the page checks again, and cannot start a second install.
    await act(async () => {
      root.render(<CodexSetupStep onNext={onNext} onBack={onBack} stepAside={stepAside} returns={1} />)
    })
    await flush()
    const run = byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(run.title).toBe('Already running in the Install Codex tab')
    expect(byTest(`codex-recipe-busy-${NPM_INSTALL.id}`)!.textContent).toBe('Already running in the Install Codex tab')
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    expect(byTest(`codex-recipe-confirm-${NPM_INSTALL.id}`)).toBeNull()
    expect(useSessionStore.getState().sessions).toHaveLength(1)

    // Shown again later (Back, then Next): the page still knows.
    act(() => { root.unmount() })
    root = createRoot(container)
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect((byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement).disabled).toBe(true)

    // The tab closed: Run is back.
    act(() => { useSessionStore.getState().removeSession(tab.id) })
    await flush()
    const again = byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement
    expect(again.disabled).toBe(false)
    expect(again.title).toBe('')
    expect(byTest(`codex-recipe-busy-${NPM_INSTALL.id}`)).toBeNull()
  })

  it("once the tab's shell exits (the line ends it), Run is back and the page checks again, once", async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    await click(`codex-recipe-confirm-run-${NPM_INSTALL.id}`)
    const tab = useSessionStore.getState().sessions[0]
    expect((byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement).disabled).toBe(true)
    const before = pa.discover.mock.calls.length
    act(() => { useSessionStore.getState().updateSession(tab.id, { ptyExited: true }) })
    await flush()
    expect(pa.discover.mock.calls.length).toBe(before + 1)
    expect((byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement).disabled).toBe(false)
    expect(byTest(`codex-recipe-busy-${NPM_INSTALL.id}`)).toBeNull()
    // Still not found after it ended: the page says so, with what to do.
    expect(byTest('codex-setup-after-install')!.textContent).toBe(
      'The command ended, but Codex was still not found. The terminal shows what happened: fix what it reports and run it again, or try another command.',
    )
    // The same end is not checked twice.
    act(() => { useSessionStore.getState().updateSession(tab.id, { label: 'Install Codex (ended)' }) })
    await flush()
    expect(pa.discover.mock.calls.length).toBe(before + 1)
  })

  it('the tab closed while its command ran: the page checks again, and a Codex found then moves it on', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    await click(`codex-recipe-confirm-run-${NPM_INSTALL.id}`)
    const tab = useSessionStore.getState().sessions[0]
    pa.discover.mockResolvedValueOnce({ ok: true, installation: codex({ discoveryState: 'found', version: '0.155.1', compatibility: 'supported', lastCheckedAt: 5 }) })
    const before = pa.discover.mock.calls.length
    act(() => { useSessionStore.getState().removeSession(tab.id) })
    await flush()
    expect(pa.discover.mock.calls.length).toBe(before + 1)
    expect(byTest('codex-setup-missing')).toBeNull()
    expect(byTest('codex-setup-after-install')).toBeNull()
  })

  it('nothing is said before anything was tried; Check again that still finds nothing says what to check, never a restart', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(byTest('codex-setup-after-install')).toBeNull()
    await click('codex-setup-check-again')
    expect(byTest('codex-setup-after-install')!.textContent).toBe(
      'Codex was still not found. If you installed it another way, check that its folder is on your PATH, then press Check again.',
    )
    expect(document.body.textContent).not.toContain('quit AI Code Conductor')
  })

  // The PATH finding of the first-run test (2026-10-10; ADR-024): on Linux
  // OpenAI's installer writes its PATH line to a file a login shell does not
  // read, so ~/.local/bin/codex can be missed. The page says which file the
  // login shell reads and a command to run once that adds the folder to it
  // (F5), with Copy; it never edits it.
  it('Codex in ~/.local/bin, which the login shell misses: the page names the file and the command, with Copy', async () => {
    const line = "printf '" + String.fromCharCode(92) + 'nexport PATH="$HOME/.local/bin:$PATH"' + String.fromCharCode(92) + "n' >> \"$HOME/.profile\""
    pa.discover.mockResolvedValue({ ok: true, installation: codex({ discoveryState: 'missing', version: undefined }), pathHint: { kind: 'shell-profile', folder: '~/.local/bin', file: '~/.profile', line } })
    try {
      await render(snap({ discoveryState: 'missing', version: undefined }))
      await click('codex-setup-check-again')
      expect(byTest('codex-path-hint-text')!.textContent).toBe(
        'Codex is installed in ~/.local/bin, but the PATH your login shell builds does not include that folder, so this app cannot find it. Run this once in a terminal. It adds the folder to ~/.profile, which the app reads through your login shell; then press Check again. An installer may name ~/.zshrc or ~/.bashrc instead, which the app does not read.',
      )
      expect(byTest('codex-path-line')!.textContent).toBe(line)
      expect(byTest('codex-setup-after-install')).toBeNull()
      await click('codex-path-copy')
      expect(writeText).toHaveBeenCalledWith(line)
    } finally {
      pa.discover.mockReset()
    }
  })

  // A restart that only MAY help (Codex was not seen; pathHintIsNote) is a
  // note: the page keeps its own still-not-found line and shows the note
  // after it, as the setup screen does. A hint
  // that says what helps (the shell-profile one above, a plain restart)
  // still replaces it.
  it('a restart note keeps the page\'s still-not-found line and follows it; a plain restart still replaces it', async () => {
    let hint: Record<string, unknown> = { kind: 'restart', unresolved: true }
    pa.discover.mockImplementation(async () => ({ ok: true, installation: codex({ discoveryState: 'missing', version: undefined }), pathHint: hint }))
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click('codex-setup-check-again')
    const line = byTest('codex-setup-after-install')
    expect(line, 'the still-not-found line stays').not.toBeNull()
    expect(line!.textContent).toBe(
      'Codex was still not found. If you installed it another way, check that its folder is on your PATH, then press Check again.',
    )
    const note = byTest('codex-path-restart')
    expect(note, 'the note shows too').not.toBeNull()
    expect(note!.textContent).toContain('If you installed Codex there, quit AI Code Conductor and start it again.')
    expect(line!.compareDocumentPosition(note!) & Node.DOCUMENT_POSITION_FOLLOWING, 'the note comes after the line').toBeTruthy()
    hint = { kind: 'restart' }
    await click('codex-setup-check-again')
    expect(byTest('codex-path-restart')!.textContent).toContain('Quit AI Code Conductor and start it again')
    expect(byTest('codex-setup-after-install')).toBeNull()
  })

  it('a second Run it before the page re-renders opens no second tab', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    const confirm = byTest(`codex-recipe-confirm-run-${NPM_INSTALL.id}`)!
    // Two clicks inside one act: the second lands on the same, not yet re-rendered, button.
    await act(async () => { confirm.click(); confirm.click() })
    await flush()
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(stepAside).toHaveBeenCalledTimes(1)
  })

  it('with no page before it there is no Back button', async () => {
    useProviderAccountsStore.setState({ snapshot: snap({ discoveryState: 'missing', version: undefined }), loaded: true })
    await act(async () => {
      root.render(<CodexSetupStep onNext={onNext} stepAside={stepAside} returns={0} />)
    })
    await flush()
    expect(byTest('codex-setup-back')).toBeNull()
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(byTest('codex-setup-back')).not.toBeNull()
  })

  it('Check again looks again, and a CLI found since moves the page on', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    pa.discover.mockResolvedValueOnce({ ok: true, installation: codex({ discoveryState: 'found', version: '0.155.1', compatibility: 'supported', lastCheckedAt: 2 }) })
    await click('codex-setup-check-again')
    expect(pa.discover).toHaveBeenCalledTimes(2)
    expect(byTest('codex-setup-missing')).toBeNull()
    expect(byTest('codex-setup-sign-in')).not.toBeNull()
  })

  it('the page can be skipped', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click('codex-setup-skip')
    expect(onNext).toHaveBeenCalledTimes(1)
  })
})

describe('the commands follow the install each check found', () => {
  it('reads the commands again after every check, so an update offered is the one for the install found then', async () => {
    await render(snap({ discoveryState: 'found', version: '0.142.4', compatibility: 'too-old', lastCheckedAt: 1 }))
    expect(pa.installRecipes).toHaveBeenCalledTimes(1)
    pa.discover.mockResolvedValueOnce({ ok: true, installation: codex({ discoveryState: 'found', version: '0.142.4', compatibility: 'too-old', lastCheckedAt: 2 }) })
    pa.installRecipes.mockResolvedValueOnce(RECIPES.filter((r) => r.id !== NPM_UPDATE.id))
    await click('codex-setup-check-again')
    expect(pa.installRecipes).toHaveBeenCalledTimes(2)
    expect(byTest(`codex-recipe-${NPM_UPDATE.id}`)).toBeNull()
    expect(byTest('codex-recipe-codex-script-update-ps1')).not.toBeNull()
  })
})

describe('Codex too old', () => {
  it('names the version found (no minimum: the snapshot has none) and offers the update recipe', async () => {
    await render(snap({ discoveryState: 'found', version: '0.150.2', compatibility: 'too-old' }))
    expect(byTest('codex-setup-check')!.textContent).toBe('!Codex 0.150.2 found; it is too old for this app')
    expect(byTest(`codex-recipe-command-${NPM_UPDATE.id}`)!.textContent).toBe(NPM_UPDATE.displayCommand)
    expect(byTest(`codex-recipe-run-${NPM_UPDATE.id}`)).not.toBeNull()
    expect(byTest('codex-recipes-install')).toBeNull()
    expect(byTest('codex-setup-check-again')).not.toBeNull()
  })

  it('the update runs in a terminal labelled for it, after confirming', async () => {
    await render(snap({ discoveryState: 'found', version: '0.150.2', compatibility: 'too-old' }))
    await click(`codex-recipe-run-${NPM_UPDATE.id}`)
    expect(byTest(`codex-recipe-run-line-${NPM_UPDATE.id}`)!.textContent).toBe(NPM_UPDATE_LINE)
    await click(`codex-recipe-confirm-run-${NPM_UPDATE.id}`)
    const s = useSessionStore.getState().sessions[0]
    expect(s.terminalOptions).toEqual({ command: NPM_UPDATE_LINE, elevated: false, noCommandSecrets: true })
    expect(s.label).toBe('Update Codex')
  })
})

describe('ready to sign in', () => {
  it('the version rows and the three methods, ChatGPT first; Skip for now continues', async () => {
    await render(snap({}))
    expect(byTest('codex-setup-found')!.textContent).toBe(`${CHECK}Codex 0.155.1 found`)
    expect(byTest('codex-setup-version')!.textContent).toBe(`${CHECK}Version supported`)
    expect(byTest('codex-setup-sign-in')!.textContent).toContain('Sign in to a new Codex account')
    expect(byTest('codex-setup-method-browser')!.textContent).toBe('Sign in with ChatGPTopens your browser')
    expect(byTest('codex-setup-method-device')!.textContent).toBe('Use a device codefor a browser on another device')
    expect(byTest('codex-setup-method-apiKey')!.textContent).toBe('Use an API keythe key goes to Codex; this app never stores it')
    expect(byTest('codex-setup-check-again')).toBeNull()
    await click('codex-setup-skip')
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('a CLI newer than tested is usable, with a warning', async () => {
    await render(snap({ version: '0.157.0', compatibility: 'too-new' }))
    expect(byTest('codex-setup-version')!.textContent).toContain('Newer than the versions this app was tested with; it will still be used')
    // A caution, in the amber Settings, Accounts shows for the same state; never the blue "wait" badge.
    expect(byTest('codex-setup-version')!.querySelector('.badge')!.className).toBe('badge warn')
    expect(byTest('codex-setup-sign-in')).not.toBeNull()
  })

  it('a method opens the add-account dialog, above the page, and starts that method there', async () => {
    await render(snap({}))
    await click('codex-setup-method-device')
    expect(byTest('add-account-dialog')).not.toBeNull()
    expect(byTest('add-account-overlay')!.className).toContain('z-[110]')
    expect(pa.beginSetup).toHaveBeenCalledWith({ providerId: 'codex', method: 'device' })
    expect(pa.signIn).toHaveBeenCalledWith({ accountId: 'acc-new', method: 'device' })
    expect(byTest('add-account-step-signing-in')).not.toBeNull()
  })

  it('the API key method opens the dialog at the key step', async () => {
    await render(snap({}))
    await click('codex-setup-method-apiKey')
    expect(pa.beginSetup).toHaveBeenCalledWith({ providerId: 'codex', method: 'apiKey' })
    expect(byTest('add-account-step-key')).not.toBeNull()
    expect(pa.signIn).not.toHaveBeenCalled()
  })
})

describe("this computer's Codex sign-in is never offered (O5, owner decision 2026-10-11)", () => {
  // Main names the folder (~/.codex, with no CODEX_HOME set). 2.1.1-beta.2
  // asked Codex about it here and offered "Use this sign-in"; Codex is on.
  const named = { externalDefaults: [{ providerId: 'codex' as const, home: '~/.codex' }] }
  const marked = (marker: Record<string, unknown>) => ({ externalDefaults: [{ providerId: 'codex' as const, home: '~/.codex', marker: { at: 1, ...marker } as any }] })
  // The account 2.1.1-beta.2 registered for it: realm-only and unverified,
  // with no provider label (main never sets one for a Codex account).
  const localAccount = account({ id: 'acc-local', providerId: 'codex', identityId: 'id-ext', external: true, unverified: true, authMethod: 'external', identityAssurance: 'realm-only' })

  /** Nothing of beta.2's offer is on the page, and nothing asked main about it. */
  const offerGone = (what = '') => {
    for (const id of ['codex-setup-adopt', 'codex-setup-adopt-callout', 'codex-setup-use-existing', 'codex-setup-add-new', 'codex-setup-checking-this-computer', 'codex-setup-this-computer-check', 'codex-setup-adoption-note', 'codex-setup-check-this-computer']) {
      expect(byTest(id), `${what} ${id}`).toBeNull()
    }
    const text = container.textContent ?? ''
    for (const said of ['Use this sign-in', 'Recommended', 'already signed in on this computer', "this computer's Codex sign-in", '~/.codex']) {
      expect(text, `${what} ${said}`).not.toContain(said)
    }
    expect(pa.probeExternal, what).not.toHaveBeenCalled()
    expect(pa.adoptExternal, what).not.toHaveBeenCalled()
  }

  it('ready, with the folder main names: only the new-account sign-in; nothing is checked, taken in or answered for the user', async () => {
    await render(snap({}, named))
    expect(byTest('codex-setup-sign-in')!.textContent).toContain('Sign in to a new Codex account')
    expect(byTest('codex-setup-method-browser')).not.toBeNull()
    expect(byTest('codex-setup-skip')).not.toBeNull()
    offerGone()
    expect(pa.setEnabled).not.toHaveBeenCalled()
  })

  it('under StrictMode (development) too', async () => {
    useProviderAccountsStore.setState({ snapshot: snap({}, named), loaded: true })
    await act(async () => {
      root.render(<React.StrictMode><CodexSetupStep onNext={onNext} onBack={onBack} stepAside={stepAside} returns={0} /></React.StrictMode>)
    })
    await flush()
    expect(byTest('codex-setup-sign-in')).not.toBeNull()
    offerGone()
  })

  it('whatever an earlier answer recorded (a beta.2 adoption archived since, or a development build\'s check): nothing is offered or asked', async () => {
    for (const marker of [{ outcome: 'registered' }, { outcome: 'none' }, { outcome: 'skipped', reason: 'home-missing' }, { outcome: 'skipped', reason: 'unavailable' }, { outcome: 'skipped', reason: 'overlap' }]) {
      const what = Object.values(marker).join(', ')
      await render(snap({}, marked(marker)))
      expect(byTest('codex-setup-sign-in'), what).not.toBeNull()
      offerGone(what)
      act(() => { root.unmount() })
      root = createRoot(container)
    }
  })

  it('a CLI found later still asks nothing about it', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }, named))
    pa.discover.mockResolvedValue({ ok: true, installation: codex({ discoveryState: 'found', version: '0.155.1', compatibility: 'supported', lastCheckedAt: 2 }) })
    await act(async () => { root.render(<CodexSetupStep onNext={onNext} onBack={onBack} stepAside={stepAside} returns={1} />) })
    await flush()
    expect(byTest('codex-setup-sign-in')).not.toBeNull()
    offerGone()
  })

  it("an account 2.1.1-beta.2 registered for it is not set up: the page offers a new Codex account, with Skip, never Next", async () => {
    await render(snap({}, { ...named, accounts: [claudeMain, localAccount] }))
    expect(byTest('codex-setup-done')).toBeNull()
    expect(byTest('codex-setup-signed-in-acc-local')).toBeNull()
    expect(byTest('codex-setup-sign-in')!.textContent).toContain('Sign in to a new Codex account')
    expect(byTest('codex-setup-next')).toBeNull()
    expect(byTest('codex-setup-skip')).not.toBeNull()
    offerGone()
  })

  it('beside an account added in the app, only that one is listed as signed in', async () => {
    const work = account({ id: 'acc-work', providerId: 'codex', identityId: 'id-work', isProviderDefault: true })
    await render(snap({}, { ...named, accounts: [claudeMain, work, localAccount] }))
    expect(byTest('codex-setup-done')).not.toBeNull()
    expect(byTest('codex-setup-signed-in-acc-work')).not.toBeNull()
    expect(byTest('codex-setup-signed-in-acc-local')).toBeNull()
    offerGone()
  })
})

describe('signed in', () => {
  it('shows it done, and Next continues', async () => {
    const work = account({ id: 'acc-work', providerId: 'codex', identityId: 'id-work', providerLabel: 'alex@work.example', isProviderDefault: true })
    await render(snap({}, { accounts: [claudeMain, work] }))
    expect(byTest('codex-setup-done')).not.toBeNull()
    expect(byTest('codex-setup-signed-in-acc-work')!.textContent).toBe(`${CHECK}Signed in: Work`)
    expect(byTest('codex-setup-skip')).toBeNull()
    expect(byTest('codex-setup-add-new')).toBeNull()
    await click('codex-setup-next')
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('a signed-out account is not done', async () => {
    const gone = account({ id: 'acc-out', providerId: 'codex', identityId: 'id-work', lastKnownAuthState: 'signed-out' })
    await render(snap({}, { accounts: [claudeMain, gone] }))
    expect(byTest('codex-setup-done')).toBeNull()
    expect(byTest('codex-setup-skip')).not.toBeNull()
  })
})

describe('no account list', () => {
  it('says so, once, and can be skipped', async () => {
    pa.discover.mockResolvedValue({ ok: false, code: 'registry-unavailable', message: 'The account list is not available right now.' })
    await render(null)
    expect(byTest('codex-setup-unavailable')).not.toBeNull()
    expect(byTest('codex-setup-error')).toBeNull()
    expect(container.textContent!.split('The account list is not available right now.').length - 1).toBe(1)
    await click('codex-setup-skip')
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('any other failure of the check is still shown', async () => {
    pa.discover.mockResolvedValue({ ok: false, code: 'internal', message: 'That did not work; try again.' })
    await render(null)
    expect(byTest('codex-setup-error')!.textContent).toBe('That did not work; try again.')
  })
})

describe('no command known', () => {
  it('names the list it is about: install, or update', async () => {
    pa.installRecipes.mockResolvedValue([])
    await render(snap({ discoveryState: 'found', version: '0.150.2', compatibility: 'too-old' }))
    expect(byTest('codex-recipes-none')!.textContent).toBe('No update command is known for this computer.')
    act(() => { root.unmount() })
    root = createRoot(container)
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(byTest('codex-recipes-none')!.textContent).toBe('No install command is known for this computer.')
  })

  it('and when the commands could not be read', async () => {
    pa.installRecipes.mockResolvedValue(null as any)
    await render(snap({ discoveryState: 'found', version: '0.150.2', compatibility: 'too-old' }))
    expect(byTest('codex-recipes-none')!.textContent).toBe('The update commands could not be read.')
  })
})

const CHECK = String.fromCodePoint(0x2713)
