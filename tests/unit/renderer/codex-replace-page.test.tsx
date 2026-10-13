// @vitest-environment jsdom
/**
 * O5 (owner-agreed 2026-10-11): "Replace this sign-in with a Codex account",
 * the one-time page for someone who chose the Codex sign-in already on this
 * computer in 2.1.1-beta.2. The REAL page, gate and stores; only the
 * add-account dialog (its own tests are accounts-surface) and the config save
 * are stand-ins.
 *
 * Verifies:
 *   - the gate (decideCodexReplace): armed only with Codex on as answered,
 *     an account for that sign-in still listed (not archived), and no stamp;
 *     any stamp at all means never again;
 *   - the page says what it is for, naming the folder main reports;
 *   - Not now and Escape stamp codexReplaceSeenVersion and close it; a dialog
 *     above the page keeps its own Escape;
 *   - Add a Codex account opens the usual add-account dialog over the page;
 *     an account added there stamps and closes the page, whichever lands
 *     first (the dialog closing or the snapshot that lists it); a dialog
 *     closed with nothing added leaves the page up, unstamped;
 *   - it signs nothing out, archives nothing, changes no lifecycle;
 *   - App: armed from the first accounts snapshot of a start, rendered on its
 *     own turn ('codexReplace'), covering the app.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { account, local, provider, snapshot, work } from './accounts-snapshot-harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: vi.fn(() => Promise.resolve(true)),
  saveConfigDebounced: vi.fn(),
  flushPendingConfigSaves: vi.fn(() => Promise.resolve()),
  retryFailedConfigSaves: vi.fn(() => Promise.resolve()),
}))

// The add-account dialog, as a stand-in that says what it was given and can
// be closed (an account added there arrives as a snapshot, as from main).
const dialog = vi.hoisted(() => ({ props: null as null | { provider: { providerId: string }; overlayZ?: string; onClose: () => void } }))
vi.mock('../../../src/renderer/components/settings/accounts/AddProviderAccountDialog', async () => {
  const R = await import('react')
  return {
    AddProviderAccountDialog: (props: { provider: { providerId: string }; overlayZ?: string; onClose: () => void }) => {
      dialog.props = props
      return R.createElement('div', { 'data-testid': 'add-dialog', 'data-dialog-overlay': '' })
    },
  }
})

const pa = {
  logout: vi.fn(),
  setLifecycle: vi.fn(),
  signInAgain: vi.fn(),
  snapshot: vi.fn(async () => null),
  onChanged: vi.fn(() => () => {}),
}
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, providerAccounts: pa }
;(globalThis as any).window.electronPlatform = 'win32'

const { CodexReplacePage, codexReplaceCopy } = await import('../../../src/renderer/onboarding/CodexReplacePage')
const { decideCodexReplace } = await import('../../../src/renderer/onboarding/codex-replace-gate')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { useAppMetaStore } = await import('../../../src/renderer/stores/appMetaStore')
const { pickBootGate } = await import('../../../src/renderer/utils/bootGates')
const { default: APP_SOURCE } = await import('../../../src/renderer/App.tsx?raw')

const adopter = (over = {}) => snapshot({ accounts: [local, work], externalDefaults: [{ providerId: 'codex', home: '~/.codex' }], ...over })
const seen = () => useAppMetaStore.getState().meta.codexReplaceSeenVersion

let container: HTMLDivElement
let root: Root
const onDone = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  ;(window as any).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  onDone.mockReset()
  for (const f of Object.values(pa)) f.mockClear()
  dialog.props = null
  useAppMetaStore.setState({ meta: {} })
  useProviderAccountsStore.setState({ snapshot: adopter(), loaded: true })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const mount = () => act(() => { root.render(React.createElement(CodexReplacePage, { onDone })) })
const press = (key: string) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })

describe('the gate', () => {
  it('arms for a beta.2 adopter with Codex on, and never once the page was left', () => {
    expect(decideCodexReplace({ snapshot: adopter() })).toBe(true)
    // Inactive still counts: it is listed until it is archived.
    expect(decideCodexReplace({ snapshot: adopter({ accounts: [{ ...local, lifecycle: 'inactive' }, work] }) })).toBe(true)
    // Any stamp at all is "left": presence is what counts.
    for (const stamp of ['2.1.1-beta.3', 'seen', '0.0.0']) expect(decideCodexReplace({ snapshot: adopter(), seenVersion: stamp }), stamp).toBe(false)
  })

  it('does not arm without that account listed, with Codex off or not set up, or with no account list', () => {
    expect(decideCodexReplace({ snapshot: snapshot({ accounts: [work] }) })).toBe(false)
    expect(decideCodexReplace({ snapshot: adopter({ accounts: [{ ...local, lifecycle: 'archived' }, work] }) })).toBe(false)
    const codexOff = provider({ providerId: 'codex', displayName: 'Codex', enabled: false, preference: 'off' })
    const codexUndecided = provider({ providerId: 'codex', displayName: 'Codex', enabled: false, preference: 'undecided' })
    for (const p of [codexOff, codexUndecided]) {
      expect(decideCodexReplace({ snapshot: adopter({ providers: [snapshot().providers[0], p] }) }), p.preference).toBe(false)
    }
    expect(decideCodexReplace({ snapshot: null })).toBe(false)
    // A managed account that is merely unverified is not that sign-in.
    const unv = account({ id: 'acc-unv', providerId: 'codex', identityId: 'id-work', unverified: true, identityAssurance: 'realm-only' })
    expect(decideCodexReplace({ snapshot: snapshot({ accounts: [unv, work] }) })).toBe(false)
  })

  it('has its own turn in the boot chain: after the Multi Spawn page, before the Codex introduction', () => {
    const base = { configLoaded: true, logsWipeBytes: 0, showTraining: false, showTrainingAll: false, showGitHubOnboarding: false, loggingConsentSeen: true, whatsNewDue: false, githubOnboardingDue: false }
    expect(pickBootGate({ ...base, codexReplaceDue: true })).toBe('codexReplace')
    expect(pickBootGate({ ...base, codexReplaceDue: true, helloCodexOpen: true })).toBe('codexReplace')
    expect(pickBootGate({ ...base, codexReplaceDue: true, multiSpawnIntroDue: true })).toBe('multiSpawnIntro')
    expect(pickBootGate({ ...base, codexReplaceDue: true, resumePending: true })).toBe('resume')
    expect(pickBootGate({ ...base, codexReplaceDue: true, codexReconfirmDue: true })).toBe('codexReconfirm')
    expect(pickBootGate({ ...base, codexReplaceDue: true, whatsNewDue: true })).toBeNull()
    expect(pickBootGate({ ...base, codexReplaceDue: true, onboardingDue: true })).toBe('onboarding')
  })
})

describe('the page', () => {
  it('says what it is for, naming the folder main reports', () => {
    mount()
    expect(q('codex-replace')!.querySelector('h2')!.textContent).toBe('Replace this sign-in with a Codex account')
    expect(q('codex-replace-line-0')!.textContent).toBe('In 2.1.1-beta.2 you chose to use the Codex sign-in already on this computer (~/.codex). This app no longer uses that sign-in: Codex accounts are always added in the app now, each with its own sign-in.')
    expect(q('codex-replace-line-1')!.textContent).toBe('It keeps working for now, but every launch on it must be confirmed, and it cannot run code reviews. Add a Codex account to replace it.')
    // O5: what moves is said as it is: a saved config only
    // when it used this sign-in, and never a restored tab's conversation,
    // with the way that keeps it.
    expect(q('codex-replace-line-2')!.textContent).toBe('Then, when a session that used it starts, its confirmation lets you start it on the new account instead. A saved config that used this sign-in moves to it too.')
    expect(q('codex-replace-line-3')!.textContent).toBe("A restored tab's conversation does not move that way. To keep it, choose Launch in that confirmation, then use Switch account on the running session, which carries the conversation over.")
    expect(q('codex-replace-line-4')).toBeNull()
    expect(q('codex-replace-note')!.textContent).toBe('Nothing is signed out here: the Codex CLI keeps its own sign-in. Its row in Settings, Accounts says how to retire it.')
    expect(q('codex-replace-add')!.textContent).toBe('Add a Codex account')
    expect(q('codex-replace-not-now')!.textContent).toBe('Not now')
    // A folder main did not name is not guessed.
    expect(codexReplaceCopy(null).lines[0]).toBe('In 2.1.1-beta.2 you chose to use the Codex sign-in already on this computer. This app no longer uses that sign-in: Codex accounts are always added in the app now, each with its own sign-in.')
    // ASCII only, no em dashes.
    const all = [codexReplaceCopy('~/.codex').heading, ...codexReplaceCopy('~/.codex').lines, codexReplaceCopy('~/.codex').note].join(' ')
    expect(/^[\x20-\x7e]*$/.test(all)).toBe(true)
  })

  // An inactive account still arms the page (it is
  // listed until archived), but nothing launches on it, so the page does not
  // promise launch confirmations or a move at launch.
  it('an inactive account: says it is inactive and nothing starts on it, with nothing about launches on it', () => {
    useProviderAccountsStore.setState({ snapshot: adopter({ accounts: [{ ...local, lifecycle: 'inactive' }, work] }), loaded: true })
    mount()
    expect(q('codex-replace-line-0')!.textContent).toBe('In 2.1.1-beta.2 you chose to use the Codex sign-in already on this computer (~/.codex). This app no longer uses that sign-in: Codex accounts are always added in the app now, each with its own sign-in.')
    expect(q('codex-replace-line-1')!.textContent).toBe('It is inactive, so nothing starts on it. Add a Codex account to use Codex in this app.')
    expect(q('codex-replace-line-2')).toBeNull()
    expect(q('codex-replace-note')!.textContent).toBe('Nothing is signed out here: the Codex CLI keeps its own sign-in. Its row in Settings, Accounts says how to retire it.')
    const text = q('codex-replace')!.textContent!
    for (const promise of ['must be confirmed', 'confirmation', 'moves to it']) expect(text, promise).not.toContain(promise)
    const all = [codexReplaceCopy('~/.codex', { inactive: true }).heading, ...codexReplaceCopy('~/.codex', { inactive: true }).lines, codexReplaceCopy('~/.codex', { inactive: true }).note].join(' ')
    expect(/^[\x20-\x7e]*$/.test(all)).toBe(true)
  })

  it('Not now stamps it and closes it; nothing is signed out or archived', () => {
    mount()
    expect(seen()).toBeUndefined()
    act(() => { q('codex-replace-not-now')!.click() })
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(seen()).toBeTruthy()
    expect(decideCodexReplace({ snapshot: adopter(), seenVersion: seen() })).toBe(false)
    expect(pa.logout).not.toHaveBeenCalled()
    expect(pa.setLifecycle).not.toHaveBeenCalled()
    expect(pa.signInAgain).not.toHaveBeenCalled()
  })

  it('Escape is Not now, but not while the add-account dialog is open above it', () => {
    mount()
    act(() => { q('codex-replace-add')!.click() })
    expect(q('add-dialog')).not.toBeNull()
    press('Escape')
    expect(onDone).not.toHaveBeenCalled()
    expect(seen()).toBeUndefined()
    act(() => { dialog.props!.onClose() })
    press('Escape')
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(seen()).toBeTruthy()
  })

  it('Add a Codex account opens the add-account dialog over the page, for Codex', () => {
    mount()
    expect(q('add-dialog')).toBeNull()
    act(() => { q('codex-replace-add')!.click() })
    expect(q('add-dialog')).not.toBeNull()
    expect(dialog.props!.provider.providerId).toBe('codex')
    // Above the onboarding root (z-index 100).
    expect(dialog.props!.overlayZ).toBe('z-[110]')
  })

  it('a dialog closed with nothing added leaves the page up, unstamped', () => {
    mount()
    act(() => { q('codex-replace-add')!.click() })
    act(() => { dialog.props!.onClose() })
    expect(q('add-dialog')).toBeNull()
    expect(q('codex-replace')).not.toBeNull()
    expect(onDone).not.toHaveBeenCalled()
    expect(seen()).toBeUndefined()
  })

  it('an account added there stamps it and closes it, the snapshot landing before the dialog closes', () => {
    mount()
    act(() => { q('codex-replace-add')!.click() })
    const added = account({ id: 'acc-new', providerId: 'codex', identityId: 'id-work' })
    act(() => { useProviderAccountsStore.setState({ snapshot: adopter({ accounts: [local, work, added] }) }) })
    // Still open: the dialog is the user's until it closes.
    expect(onDone).not.toHaveBeenCalled()
    act(() => { dialog.props!.onClose() })
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(seen()).toBeTruthy()
    expect(pa.logout).not.toHaveBeenCalled()
    expect(pa.setLifecycle).not.toHaveBeenCalled()
  })

  it('...or after it closes', () => {
    mount()
    act(() => { q('codex-replace-add')!.click() })
    act(() => { dialog.props!.onClose() })
    expect(onDone).not.toHaveBeenCalled()
    const added = account({ id: 'acc-new', providerId: 'codex', identityId: 'id-work' })
    act(() => { useProviderAccountsStore.setState({ snapshot: adopter({ accounts: [local, work, added] }) }) })
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(seen()).toBeTruthy()
  })
})

describe('App', () => {
  const APP = (APP_SOURCE as string).replace(/\r\n/g, '\n')

  it('arms it once, from the first accounts snapshot of a start and the stamp', () => {
    const at = APP.indexOf('if (decideCodexReplace({')
    expect(at).toBeGreaterThan(-1)
    const block = APP.slice(APP.lastIndexOf('useEffect(() => {', at), APP.indexOf('setCodexReplaceArmed(true)', at))
    expect(block).toContain('codexReplaceDecided.current')
    expect(block).toContain('snapshot: useProviderAccountsStore.getState().snapshot')
    expect(block).toContain('seenVersion: useAppMetaStore.getState().meta.codexReplaceSeenVersion')
    expect(block).toContain('!providerAccountsLoaded')
  })

  it('renders it on its own turn, covering the app, and clears it when left', () => {
    expect(APP).toContain('codexReplaceDue: codexReplaceArmed,')
    expect(APP).toContain("{bootGate === 'codexReplace' && (")
    expect(APP).toContain('<CodexReplacePage onDone={() => setCodexReplaceArmed(false)} />')
    expect(APP).toMatch(/const appCovered = [^\n]*bootGate === 'codexReplace'/)
    expect((APP.match(/<CodexReplacePage\b/g) ?? []).length).toBe(1)
  })
})
