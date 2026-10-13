// @vitest-environment jsdom
/**
 * WP2 commit 6 (canvas F6 / F9): the New session dialog's "Codex account"
 * field, driven through the REAL dialog.
 *
 *  - the list: the default first and preselected "(Default)", this computer's
 *    ~/.codex labelled "confirm at launch", blocked accounts disabled with
 *    "Needs attention", inactive and archived ones absent, and no account at
 *    all -> "Sign in to Codex first" pointing at Accounts;
 *  - choosing the external account shows the per-launch checkbox, which must
 *    be ticked before Create/Save enables, and the tick is handed to the
 *    caller for the one launch -- never written into the config;
 *  - the chosen account is saved as the config's providerAccountId (an edit
 *    the user did not re-point keeps what is stored);
 *  - an edit asks for no tick (nothing launches on an edit), and a tick is
 *    bound to the account it was ticked for;
 *  - F9: no account, a blocked default and a too-old Codex hold a new config
 *    back;
 *  - the per-launch confirm asked before a later launch: one answer per
 *    question, never early, focus on Cancel.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({ groups: [], addGroup: vi.fn(), sections: [], addSection: vi.fn() }),
}))

;(window as any).electronAPI = {
  debug: { isEnabled: vi.fn().mockResolvedValue(false) },
  dialog: { openFolder: vi.fn().mockResolvedValue(null) },
  credentials: { save: vi.fn(), delete: vi.fn() },
}
;(window as any).electronPlatform = 'win32'

import SessionDialog from '../../../src/renderer/components/SessionDialog'
import { useProviderAccountsStore } from '../../../src/renderer/stores/providerAccountsStore'
import { snapshot, provider, work, old, local } from './accounts-snapshot-harness'
import LaunchAckConfirm, { LAUNCH_ACK_ARM_MS } from '../../../src/renderer/components/LaunchAckConfirm'
import { useLaunchAckStore } from '../../../src/renderer/stores/launchAckStore'
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'
import { CODEX_OFF_LAUNCH_REASON, CODEX_NOT_SET_UP_LAUNCH_REASON } from '../../../src/renderer/hooks/useLaunchConfig'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Main names the folder of this computer's own sign-in (no CODEX_HOME set).
  useProviderAccountsStore.setState({ snapshot: snapshot({ externalDefaults: [{ providerId: 'codex', home: '~/.codex' }] }), loaded: true })
  // The user said they use Codex: its configs can launch.
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, codexEnabled: true, codexAnswered: true } })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function render(props: Record<string, unknown> = {}) {
  const onConfirm = vi.fn()
  act(() => { root.render(React.createElement(SessionDialog, { onConfirm, onCancel: vi.fn(), ...props } as any)) })
  return onConfirm
}

function card(group: string, title: string): HTMLInputElement {
  const g = container.querySelector(`[role="radiogroup"][aria-label="${group}"]`)!
  const lab = Array.from(g.querySelectorAll('label')).find((l) => l.querySelector('span')?.textContent === title)!
  return lab.querySelector('input[type="radio"]') as HTMLInputElement
}

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}

function choose(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  act(() => { setter.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })) })
}

/** A new Codex config, local, with everything else filled in. */
function newCodexConfig(): ReturnType<typeof vi.fn> {
  const onConfirm = render()
  act(() => { card('Provider', 'Codex').click() })
  act(() => { card('Connection', 'Local').click() })
  const wd = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).placeholder === 'C:\\path\\to\\project') as HTMLInputElement
  setInput(wd, 'C:\\proj')
  const label = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).placeholder === 'e.g. App Dev') as HTMLInputElement
  setInput(label, 'api-server')
  return onConfirm
}

const select = () => container.querySelector('[data-testid="codex-account-select"]') as HTMLSelectElement | null
const submitBtn = () => container.querySelector('[data-testid="session-dialog-submit"]') as HTMLButtonElement
const ackBox = () => container.querySelector('[data-testid="codex-account-ack-checkbox"]') as HTMLInputElement | null
const submit = () => act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
// O5 (owner decision 2026-10-11): the line every confirmation of a launch on
// the sign-in already on this computer says, as its Accounts row does.
const RETIRING = 'This sign-in is being retired: in Settings, Accounts, add a Codex account, make it the default, then make this one inactive and archive it.'

describe('the Codex account picker', () => {
  it('preselects the default and lists the accounts a new session may use', () => {
    newCodexConfig()
    const sel = select()!
    expect(sel.value).toBe('acc-work')
    const opts = Array.from(sel.options).map((o) => ({ id: o.value, text: o.textContent, disabled: o.disabled }))
    expect(opts).toEqual([
      { id: 'acc-work', text: 'Work (Default)', disabled: false },
      { id: 'acc-personal', text: 'Personal', disabled: false },
      { id: 'acc-local', text: "This computer's Codex (~/.codex) - confirm at launch", disabled: false },
      { id: 'acc-old', text: 'Old (Needs attention)', disabled: true },
    ])
    // Inactive and archived accounts are not offered.
    expect(opts.map((o) => o.id)).not.toContain('acc-parked')
    expect(opts.map((o) => o.id)).not.toContain('acc-gone')
  })

  it('with no Codex account says "Sign in to Codex first", points at Accounts, and holds Create back (F9)', () => {
    useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [] }), loaded: true })
    newCodexConfig()
    expect(select()).toBeNull()
    const warn = container.querySelector('[data-testid="codex-no-account"]')!
    expect(warn.textContent).toBe('Sign in to Codex first. Open Accounts.')
    expect(submitBtn().disabled).toBe(true)
    const opened = vi.fn()
    window.addEventListener('app:openSettings', opened as EventListener)
    act(() => { (warn.querySelector('button') as HTMLButtonElement).click() })
    window.removeEventListener('app:openSettings', opened as EventListener)
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'accounts' })
  })

  it('no Codex account does not hold back saving an edit (an edit launches nothing)', () => {
    useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [] }), loaded: true })
    render({ initial: { id: 'c1', provider: 'codex', sessionType: 'local', label: 'x', workingDirectory: 'C:\\proj', color: '', codexOptions: { permissionsPreset: 'standard' } } })
    expect(submitBtn().disabled).toBe(false)
  })

  it("saves the chosen account as the config's providerAccountId", () => {
    const onConfirm = newCodexConfig()
    choose(select()!, 'acc-personal')
    expect(submitBtn().disabled).toBe(false)
    submit()
    const [config, , , , launchAck] = onConfirm.mock.calls[0]
    expect(config.providerAccountId).toBe('acc-personal')
    expect(launchAck).toBeUndefined()
  })

  it('a new config left on the default saves the default', () => {
    const onConfirm = newCodexConfig()
    submit()
    expect(onConfirm.mock.calls[0][0].providerAccountId).toBe('acc-work')
  })
})

describe("this computer's own sign-in: the per-launch checkbox", () => {
  it('appears for the external account, names its email, and holds Create back until ticked', () => {
    const onConfirm = newCodexConfig()
    expect(ackBox()).toBeNull()
    choose(select()!, 'acc-local')
    expect(container.querySelector('[data-testid="codex-account-ack"]')!.textContent)
      .toBe('Launch with the Codex sign-in already on this computer (alex@example.com)')
    expect(ackBox()!.checked).toBe(false)
    expect(submitBtn().disabled).toBe(true)
    submit()
    expect(onConfirm).not.toHaveBeenCalled()
    act(() => { ackBox()!.click() })
    expect(submitBtn().disabled).toBe(false)
  })

  it('hands the tick to the caller for the one launch, and never writes it into the config', () => {
    const onConfirm = newCodexConfig()
    choose(select()!, 'acc-local')
    act(() => { ackBox()!.click() })
    submit()
    const [config, , , , launchAck] = onConfirm.mock.calls[0]
    expect(config.providerAccountId).toBe('acc-local')
    expect(launchAck).toEqual({ accountId: 'acc-local' })
    expect(JSON.stringify(config)).not.toMatch(/acknowledge/i)
  })

  it('the tick belongs to the account it was ticked for: choosing another account and back does not carry it', () => {
    newCodexConfig()
    choose(select()!, 'acc-local')
    act(() => { ackBox()!.click() })
    choose(select()!, 'acc-work')
    expect(submitBtn().disabled).toBe(false)
    // A different external account would not be covered either; back on the
    // same one, the tick it was given for that account stands.
    choose(select()!, 'acc-local')
    expect(ackBox()!.checked).toBe(true)
  })

  it('a snapshot push that moves the default never carries the tick to the new default', () => {
    // The default is this computer's own sign-in, ticked while untouched.
    const other = { ...local, id: 'acc-local-2', identityId: 'id-ext' }
    useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [{ ...work, isProviderDefault: false }, { ...local, isProviderDefault: true }, other] }), loaded: true })
    const onConfirm = newCodexConfig()
    expect(select()!.value).toBe('acc-local')
    act(() => { ackBox()!.click() })
    expect(submitBtn().disabled).toBe(false)
    // Main publishes a snapshot with another unverified default.
    act(() => { useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [{ ...work, isProviderDefault: false }, { ...local, isProviderDefault: false }, { ...other, isProviderDefault: true }] }), loaded: true }) })
    expect(select()!.value).toBe('acc-local-2')
    expect(ackBox()!.checked).toBe(false)
    expect(submitBtn().disabled).toBe(true)
    submit()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('O5: says under the checkbox that this sign-in is being retired; an account added in the app says nothing of it', () => {
    newCodexConfig()
    expect(container.querySelector('[data-testid="codex-account-ack-retiring"]')).toBeNull()
    choose(select()!, 'acc-local')
    expect(container.querySelector('[data-testid="codex-account-ack-retiring"]')!.textContent).toBe(RETIRING)
    // It still launches once ticked: the note holds nothing back.
    act(() => { ackBox()!.click() })
    expect(submitBtn().disabled).toBe(false)
    choose(select()!, 'acc-work')
    expect(container.querySelector('[data-testid="codex-account-ack-retiring"]')).toBeNull()
  })

  it('an edit asks for no tick and shows no checkbox: nothing launches on an edit', () => {
    const onConfirm = render({ initial: { id: 'c1', provider: 'codex', sessionType: 'local', label: 'x', workingDirectory: 'C:\\proj', color: '', codexOptions: { permissionsPreset: 'standard' }, providerAccountId: 'acc-local' } })
    expect(select()!.value).toBe('acc-local')
    expect(ackBox()).toBeNull()
    expect(submitBtn().disabled).toBe(false)
    submit()
    const [config, , , , launchAck] = onConfirm.mock.calls[0]
    expect(config.providerAccountId).toBe('acc-local')
    expect(launchAck).toBeUndefined()
  })
})

describe('an edit keeps what is stored unless the user re-points it', () => {
  const unbound = { id: 'c1', provider: 'codex', sessionType: 'local', label: 'x', workingDirectory: 'C:\\proj', color: '', codexOptions: { permissionsPreset: 'standard' } }

  it('an unbound config stays unbound (it follows the provider default)', () => {
    const onConfirm = render({ initial: unbound })
    expect(select()!.value).toBe('acc-work')
    submit()
    expect(onConfirm.mock.calls[0][0].providerAccountId).toBeUndefined()
  })

  it('re-pointing it binds it', () => {
    const onConfirm = render({ initial: unbound })
    choose(select()!, 'acc-personal')
    submit()
    expect(onConfirm.mock.calls[0][0].providerAccountId).toBe('acc-personal')
  })
})

describe('F9: what holds a new Codex config back', () => {
  it('a blocked default: the account signed in as someone else, "Open Accounts" read once as the link', () => {
    useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [{ ...old, isProviderDefault: true }, { ...work, isProviderDefault: false }, local] }), loaded: true })
    newCodexConfig()
    expect(select()!.value).toBe('acc-old')
    const notice = container.querySelector('[data-testid="codex-account-notice"]')!
    expect(notice.textContent).toBe('This account signed in as someone else. Open Accounts and confirm it is still yours.')
    expect(notice.querySelector('button')!.textContent).toBe('Open Accounts')
    expect(submitBtn().disabled).toBe(true)
    choose(select()!, 'acc-work')
    expect(submitBtn().disabled).toBe(false)
  })

  it('a Codex that is too old, with no update action pointed at Accounts', () => {
    useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [provider({ providerId: 'codex', displayName: 'Codex', version: '0.150.2', compatibility: 'too-old' })] }), loaded: true })
    newCodexConfig()
    const box = container.querySelector('[data-testid="codex-too-old"]')!
    expect(box.textContent).toBe('Codex 0.150.2 is too old for this app. Update Codex, then Check again in Settings, Accounts.')
    expect(box.querySelector('button')).toBeNull()
    expect(submitBtn().disabled).toBe(true)
  })

  it("the provider cards carry the app's own provider glyphs", () => {
    render()
    expect(card('Provider', 'Codex').closest('label')!.querySelector('[data-testid="provider-glyph-codex"] svg')).not.toBeNull()
    expect(card('Provider', 'Claude Code').closest('label')!.querySelector('[data-testid="provider-glyph-claude"] svg')).not.toBeNull()
  })

  it('SSH says one thing: Codex runs on this computer only', () => {
    render()
    act(() => { card('Provider', 'Codex').click() })
    expect(card('Connection', 'SSH').disabled).toBe(true)
    expect(container.querySelector('[data-testid="codex-local-note"]')!.textContent).toBe('Codex runs on this computer only in this release.')
    expect(container.textContent!.match(/this computer only/g)).toHaveLength(1)
  })
})

describe('WP2 commit 6g: the Codex settings tab is gone; the dialog points at Settings, Accounts', () => {
  const openedTabs = (click: () => void): unknown[] => {
    const opened = vi.fn()
    window.addEventListener('app:openSettings', opened as EventListener)
    try { click() } finally { window.removeEventListener('app:openSettings', opened as EventListener) }
    return opened.mock.calls.map((c) => (c[0] as CustomEvent).detail)
  }

  it('a Codex CLI main did not find says so in its own words, and its link opens Settings, Accounts', () => {
    useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [provider({ providerId: 'codex', displayName: 'Codex', discoveryState: 'missing', version: undefined })] }), loaded: true })
    newCodexConfig()
    const box = container.querySelector('[data-testid="codex-cli-missing"]')!
    expect(box.textContent).toBe('Codex was not found on this computer. Open Settings, Accounts to install it or check again.')
    const link = container.querySelector('[data-testid="codex-cli-missing-open-accounts"]') as HTMLButtonElement
    expect(openedTabs(() => act(() => { link.click() }))).toEqual([{ tab: 'accounts' }])
  })

  it('a CLI that did not run, or could not be checked, gets the same pointer; a found one, or no answer yet, gets none', () => {
    for (const [state, text] of [['invalid', 'Codex was found but did not run as expected'], ['error', 'Codex could not be checked']] as const) {
      useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [provider({ providerId: 'codex', displayName: 'Codex', discoveryState: state })] }), loaded: true })
      newCodexConfig()
      expect(container.querySelector('[data-testid="codex-cli-missing"]')!.textContent).toBe(`${text}. Open Settings, Accounts to install it or check again.`)
      act(() => { root.unmount() })
      root = createRoot(container)
    }
    // A found CLI says nothing. So does no answer yet: an unchecked CLI may
    // well be installed (main looks at start only for a Codex switched on;
    // an undecided one waits for Check now or an operation, 6g).
    useProviderAccountsStore.setState({ snapshot: snapshot(), loaded: true })
    newCodexConfig()
    expect(container.querySelector('[data-testid="codex-cli-missing"]')).toBeNull()
  })

  it('WP2 commit 6g: the banner appears in the open dialog as soon as main\'s start-up discovery says the CLI is missing', () => {
    useProviderAccountsStore.setState({ snapshot: null, loaded: false })
    newCodexConfig()
    expect(container.querySelector('[data-testid="codex-cli-missing"]')).toBeNull()
    act(() => { useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [provider({ providerId: 'codex', displayName: 'Codex', discoveryState: 'unchecked', version: undefined })] }), loaded: true }) })
    expect(container.querySelector('[data-testid="codex-cli-missing"]')).toBeNull()
    act(() => { useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [provider({ providerId: 'codex', displayName: 'Codex', discoveryState: 'missing', version: undefined })] }), loaded: true }) })
    expect(container.querySelector('[data-testid="codex-cli-missing"]')!.textContent).toBe('Codex was not found on this computer. Open Settings, Accounts to install it or check again.')
  })

  it('Codex switched off: the card is disabled and the note is the launch reason, pointing at Settings, Accounts', () => {
    const saved = useSettingsStore.getState().settings
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, codexEnabled: false } })
    try {
      render()
      expect(card('Provider', 'Codex').disabled).toBe(true)
      expect(CODEX_OFF_LAUNCH_REASON).toBe('Codex is off. Turn it on in Settings, Accounts to launch this config.')
      expect(container.querySelector('[data-testid="codex-off-note"]')!.textContent).toBe(CODEX_OFF_LAUNCH_REASON)
    } finally {
      useSettingsStore.setState({ settings: saved })
    }
  })

  it('Codex not set up (never answered): the card is disabled the same way, and the note says to set it up', () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
    render()
    expect(card('Provider', 'Codex').disabled).toBe(true)
    expect(CODEX_NOT_SET_UP_LAUNCH_REASON).toBe('Codex is not set up yet. Set it up in Settings, Accounts to launch this config.')
    expect(container.querySelector('[data-testid="codex-not-set-up-note"]')!.textContent).toBe(CODEX_NOT_SET_UP_LAUNCH_REASON)
    expect(container.querySelector('[data-testid="codex-off-note"]')).toBeNull()
  })
})

describe('the per-launch confirm asked before a later launch', () => {
  const ask = (sessionId: string, over: Record<string, unknown> = {}) =>
    useLaunchAckStore.getState().request({ sessionId, sessionLabel: sessionId, accountName: "This computer's Codex (~/.codex)", email: 'alex@example.com', external: true, unknown: false, ...over } as never)
  const click = (testId: string) => act(() => { (document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click() })
  // Two clocks: the monotonic one the confirm arms on, and the wall clock,
  // which may step (NTP after sleep, a VM resume) and must not matter.
  let mono = 5_000
  let wall = 1_700_000_000_000
  beforeEach(() => {
    useLaunchAckStore.setState({ queue: [] })
    mono = 5_000
    wall = 1_700_000_000_000
    vi.spyOn(performance, 'now').mockImplementation(() => mono)
    vi.spyOn(Date, 'now').mockImplementation(() => wall)
  })
  afterEach(() => { vi.restoreAllMocks() })
  /** Let the question on screen arm. */
  const wait = () => { mono += LAUNCH_ACK_ARM_MS + 1; wall += LAUNCH_ACK_ARM_MS + 1 }

  it('a wall clock stepped backward never strands the question: it arms 300 ms after it was shown', async () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => { first = ask('s-1'); second = ask('s-2') })
    // An hour's step backward on the wall clock while the question is up.
    wall -= 3_600_000
    mono += LAUNCH_ACK_ARM_MS + 1
    click('launch-ack-launch')
    await expect(first).resolves.toBe(true)
    // ...and the question queued behind it is not stranded either.
    mono += LAUNCH_ACK_ARM_MS + 1
    click('launch-ack-cancel')
    await expect(second).resolves.toBe(false)
  })

  it('asks about the Codex sign-in on this computer, described by its question, with focus on Cancel', () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    expect(document.querySelector('[data-testid="launch-ack-confirm"]')).toBeNull()
    act(() => { void ask('s-1') })
    const panel = document.querySelector('[data-testid="launch-ack-confirm"]')!
    expect(panel.getAttribute('aria-describedby')).toBe('launch-ack-question')
    expect(document.getElementById('launch-ack-question')!.textContent)
      .toBe('Launch with the Codex sign-in already on this computer (alex@example.com)?')
    expect(document.activeElement).toBe(document.querySelector('[data-testid="launch-ack-cancel"]'))
  })

  it('answers the waiting launch once armed', async () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    let answer!: Promise<boolean>
    act(() => { answer = ask('s-1') })
    wait()
    click('launch-ack-launch')
    await expect(answer).resolves.toBe(true)
    expect(document.querySelector('[data-testid="launch-ack-confirm"]')).toBeNull()
  })

  it('each new question starts with focus on Cancel, never where the last answer left it', () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    act(() => { void ask('s-1'); void ask('s-2') })
    wait()
    const launch = document.querySelector('[data-testid="launch-ack-launch"]') as HTMLButtonElement
    act(() => { launch.focus() })
    act(() => { launch.click() })
    expect(document.getElementById('launch-ack-question')).not.toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-testid="launch-ack-cancel"]'))
  })

  it('ignores a click that lands before the question has been on screen long enough', async () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    act(() => { void ask('s-1') })
    click('launch-ack-launch')
    expect(useLaunchAckStore.getState().isPending('s-1')).toBe(true)
  })

  it('two quick activations never approve the next session', async () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => { first = ask('s-1'); second = ask('s-2') })
    wait()
    click('launch-ack-launch')
    // The second click of a double activation lands on s-2's question.
    click('launch-ack-launch')
    await expect(first).resolves.toBe(true)
    expect(useLaunchAckStore.getState().isPending('s-2')).toBe(true)
    expect(document.getElementById('launch-ack-question')!.textContent).toContain('?')
    void second
  })

  it('a question withdrawn between render and click never lets the click land on the next one', async () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    let second!: Promise<boolean>
    act(() => { void ask('s-1'); second = ask('s-2') })
    wait()
    const launchForS1 = document.querySelector('[data-testid="launch-ack-launch"]') as HTMLButtonElement
    // s-1's view goes away (a restart) while its question is on screen...
    act(() => { useLaunchAckStore.getState().withdraw('s-1') })
    // ...and a click aimed at s-1's button arrives afterwards.
    act(() => { launchForS1.click() })
    expect(useLaunchAckStore.getState().isPending('s-2')).toBe(true)
    // Nor does a click on the new question count before it has armed.
    click('launch-ack-launch')
    expect(useLaunchAckStore.getState().isPending('s-2')).toBe(true)
    wait()
    click('launch-ack-cancel')
    await expect(second).resolves.toBe(false)
  })

  it('stays hidden while a boot gate owns the screen, keeping the question queued', () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm, { suppressed: true })) })
    act(() => { void ask('s-2') })
    expect(document.querySelector('[data-testid="launch-ack-confirm"]')).toBeNull()
    expect(useLaunchAckStore.getState().isPending('s-2')).toBe(true)
    useLaunchAckStore.getState().withdraw('s-2')
  })

  it('asks plainly when the account list could not be read', () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    act(() => { void ask('api-server', { unknown: true, external: false, email: undefined, accountName: 'this Codex account' }) })
    expect(document.getElementById('launch-ack-question')!.textContent).toBe('Launch api-server on its saved Codex account?')
    expect(document.querySelector('[data-testid="launch-ack-retiring"]')).toBeNull()
  })

  it('O5: on the sign-in already on this computer it says the sign-in is being retired; Open Accounts instead answers No (once armed) and opens Settings, Accounts', async () => {
    const opened = vi.fn()
    window.addEventListener('app:openSettings', opened)
    try {
      act(() => { root.render(React.createElement(LaunchAckConfirm)) })
      let answer!: Promise<boolean>
      act(() => { answer = ask('s-1') })
      expect(document.querySelector('[data-testid="launch-ack-retiring"]')!.textContent).toBe(`${RETIRING} Open Accounts instead`)
      // Focus still starts on Cancel.
      expect(document.activeElement).toBe(document.querySelector('[data-testid="launch-ack-cancel"]'))
      // Too early: nothing is answered, nothing opens.
      click('launch-ack-open-accounts')
      expect(useLaunchAckStore.getState().isPending('s-1')).toBe(true)
      expect(opened).not.toHaveBeenCalled()
      wait()
      click('launch-ack-open-accounts')
      await expect(answer).resolves.toBe(false)
      expect(opened).toHaveBeenCalledTimes(1)
      expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'accounts' })
      // It still launches with a yes.
      let again!: Promise<boolean>
      act(() => { again = ask('s-2') })
      wait()
      click('launch-ack-launch')
      await expect(again).resolves.toBe(true)
      // An unverified account added in the app is not said to be retired.
      act(() => { void ask('s-3', { external: false, accountName: 'Work' }) })
      expect(document.getElementById('launch-ack-question')).not.toBeNull()
      expect(document.querySelector('[data-testid="launch-ack-retiring"]')).toBeNull()
      useLaunchAckStore.getState().withdraw('s-3')
    } finally {
      window.removeEventListener('app:openSettings', opened)
    }
  })

  it('O5: Open Accounts instead answers only the question on screen; every other queued launch, even on that sign-in, is still asked as before', async () => {
    const opened = vi.fn()
    window.addEventListener('app:openSettings', opened)
    try {
      act(() => { root.render(React.createElement(LaunchAckConfirm)) })
      // A restart that restored several tabs on that sign-in queues one each.
      let a!: Promise<boolean>, b!: Promise<boolean>, agentRetry!: Promise<boolean>
      act(() => {
        a = ask('tab-1')
        b = ask('tab-2')
        void ask('tab-work', { external: false, accountName: 'Work' })
        agentRetry = ask('agent-1', { retryAgent: true })
      })
      wait()
      click('launch-ack-open-accounts')
      await expect(a).resolves.toBe(false)
      expect(opened).toHaveBeenCalledTimes(1)
      // Nothing else was answered: the next launch on that sign-in is the
      // question on screen now, and it arms afresh.
      expect(useLaunchAckStore.getState().queue.map((p) => p.sessionId)).toEqual(['tab-2', 'tab-work', 'agent-1'])
      expect(document.getElementById('launch-ack-question')!.textContent)
        .toBe('Launch with the Codex sign-in already on this computer (alex@example.com)?')
      click('launch-ack-open-accounts')
      expect(useLaunchAckStore.getState().isPending('tab-2')).toBe(true)
      expect(opened).toHaveBeenCalledTimes(1)
      // It can still be launched, as before.
      wait()
      click('launch-ack-launch')
      await expect(b).resolves.toBe(true)
      wait()
      click('launch-ack-cancel')
      // A Cloud Agent Retry on that sign-in is asked as a retry, and Open
      // Accounts instead answers it alone.
      expect(useLaunchAckStore.getState().queue.map((p) => p.sessionId)).toEqual(['agent-1'])
      wait()
      click('launch-ack-open-accounts')
      await expect(agentRetry).resolves.toBe(false)
      expect(opened).toHaveBeenCalledTimes(2)
      expect(useLaunchAckStore.getState().queue).toEqual([])
    } finally {
      window.removeEventListener('app:openSettings', opened)
    }
  })
})

// O5 (owner-agreed 2026-10-11): a later launch of a session on the account
// 2.1.1-beta.2 registered for the sign-in already on this computer offers the
// other Codex accounts too, by the New session dialog's picker rule.
describe('the per-launch confirm: another Codex account instead (O5)', () => {
  const choice = (sessionId: string, over: Record<string, unknown> = {}) =>
    useLaunchAckStore.getState().requestChoice({ sessionId, sessionLabel: sessionId, accountName: "This computer's Codex (~/.codex)", email: 'alex@example.com', external: true, unknown: false, accountId: 'acc-local', offerSwitch: true, ...over } as never)
  const click = (testId: string) => act(() => { (document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click() })
  const picker = () => document.querySelector('[data-testid="launch-ack-account-select"]') as HTMLSelectElement | null
  let mono = 5_000
  beforeEach(() => {
    useLaunchAckStore.setState({ queue: [] })
    mono = 5_000
    vi.spyOn(performance, 'now').mockImplementation(() => mono)
  })
  afterEach(() => { vi.restoreAllMocks() })
  const wait = () => { mono += LAUNCH_ACK_ARM_MS + 1 }

  it('lists the other accounts a new session may use, default first, never the sign-in asked about; blocked ones shown but not offered', () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    act(() => { void choice('s-1') })
    const sel = picker()!
    const opts = Array.from(sel.options).map((o) => [o.value, o.textContent, o.disabled])
    expect(opts).toEqual([['acc-work', 'Work (Default)', false], ['acc-personal', 'Personal', false], ['acc-old', 'Old (Needs attention)', true]])
    expect(sel.value).toBe('acc-work')
    expect(document.querySelector('label[for="launch-ack-account"]')!.textContent).toBe('Or start it on another Codex account')
    // What moves, as it is: a saved config only when it used this sign-in.
    expect(document.querySelector('[data-testid="launch-ack-switch-note"]')!.textContent).toBe('The session starts on that account. A saved config that used this sign-in moves to it too.')
    expect((document.querySelector('[data-testid="launch-ack-use-other"]') as HTMLElement).title).toBe('Start this session on the account picked; a saved config that used this sign-in moves to it too')
    // Not a launch that resumes a conversation: nothing about one.
    expect(document.querySelector('[data-testid="launch-ack-switch-conversation"]')).toBeNull()
    // Focus still starts on Cancel, never on a way to launch.
    expect(document.activeElement).toBe(document.querySelector('[data-testid="launch-ack-cancel"]'))
  })

  // O5: a restored tab moved from here starts
  // without its conversation (an exact resume looks only in the picked
  // account's own; a launch carries none over). The confirm says so before
  // the pick, and names the way that keeps it (Launch, then Switch account).
  it('a launch that resumes a conversation says the move does not bring it, and how to keep it', () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    act(() => { void choice('s-1', { resumesConversation: true }) })
    expect(picker()).not.toBeNull()
    expect(document.querySelector('[data-testid="launch-ack-switch-conversation"]')!.textContent).toBe("This tab's conversation does not come along: it stays with this computer's sign-in. To keep it, choose Launch, then use Switch account on the running session, which carries the conversation over.")
    useLaunchAckStore.getState().withdraw('s-1')
    // With no other account to offer, there is no move to warn about.
    act(() => { useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [local, old] }) }) })
    act(() => { void choice('s-2', { resumesConversation: true }) })
    expect(document.querySelector('[data-testid="launch-ack-switch-conversation"]')).toBeNull()
    useLaunchAckStore.getState().withdraw('s-2')
  })

  // A keyboard and screen reader user tabbing from the
  // picker to Use this account hears what moves, and, for a restored tab,
  // that its conversation does not come along, before the pick.
  it('Use this account is described by what moves, and by the conversation note when there is one', () => {
    const useOther = () => document.querySelector('[data-testid="launch-ack-use-other"]') as HTMLElement
    const described = () => (useOther().getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((ref) => document.getElementById(ref)?.textContent)
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    act(() => { void choice('s-1') })
    expect(described()).toEqual(['The session starts on that account. A saved config that used this sign-in moves to it too.'])
    useLaunchAckStore.getState().withdraw('s-1')
    act(() => { void choice('s-2', { resumesConversation: true }) })
    expect(described()).toEqual([
      'The session starts on that account. A saved config that used this sign-in moves to it too.',
      "This tab's conversation does not come along: it stays with this computer's sign-in. To keep it, choose Launch, then use Switch account on the running session, which carries the conversation over.",
    ])
    useLaunchAckStore.getState().withdraw('s-2')
  })

  it('answers with the account picked, once armed; too early answers nothing', async () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    let answer!: Promise<unknown>
    act(() => { answer = choice('s-1') })
    choose(picker()!, 'acc-personal')
    click('launch-ack-use-other')
    expect(useLaunchAckStore.getState().isPending('s-1')).toBe(true)
    wait()
    click('launch-ack-use-other')
    await expect(answer).resolves.toEqual({ switchTo: 'acc-personal' })
    expect(document.querySelector('[data-testid="launch-ack-confirm"]')).toBeNull()
  })

  it('Launch and Cancel still answer yes and no', async () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    let a!: Promise<unknown>, b!: Promise<unknown>
    act(() => { a = choice('s-1'); b = choice('s-2') })
    wait()
    click('launch-ack-launch')
    await expect(a).resolves.toBe(true)
    wait()
    click('launch-ack-cancel')
    await expect(b).resolves.toBe(false)
  })

  it('is not offered where the launch did not ask for it (an agent retry, a plain request), nor on an account added in the app, nor with no other account to use', () => {
    act(() => { root.render(React.createElement(LaunchAckConfirm)) })
    act(() => { void useLaunchAckStore.getState().request({ sessionId: 'agent-1', sessionLabel: 'agent-1', accountName: 'x', external: true, unknown: false, retryAgent: true }) })
    expect(document.querySelector('[data-testid="launch-ack-retiring"]')).not.toBeNull()
    expect(picker()).toBeNull()
    useLaunchAckStore.getState().withdraw('agent-1')
    act(() => { void choice('s-unv', { external: false, accountName: 'Work', accountId: 'acc-unv' }) })
    expect(picker()).toBeNull()
    useLaunchAckStore.getState().withdraw('s-unv')
    act(() => { useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [local, old] }) }) })
    act(() => { void choice('s-alone') })
    expect(document.querySelector('[data-testid="launch-ack-retiring"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="launch-ack-switch"]')).toBeNull()
    useLaunchAckStore.getState().withdraw('s-alone')
  })

  it('the store: a plain request never resolves as a switch, and a switch to nothing or to the same account is ignored', async () => {
    let plain!: Promise<boolean>
    act(() => { plain = useLaunchAckStore.getState().request({ sessionId: 'p-1', sessionLabel: 'p', accountName: 'x', external: true, unknown: false, accountId: 'acc-local' }) })
    const id = useLaunchAckStore.getState().queue[0].requestId
    useLaunchAckStore.getState().switchAccount(id, 'acc-work')
    expect(useLaunchAckStore.getState().isPending('p-1')).toBe(true)
    useLaunchAckStore.getState().answer(id, true)
    await expect(plain).resolves.toBe(true)
    let offered!: Promise<unknown>
    act(() => { offered = choice('o-1') })
    const oid = useLaunchAckStore.getState().queue[0].requestId
    useLaunchAckStore.getState().switchAccount(oid, '')
    useLaunchAckStore.getState().switchAccount(oid, 'acc-local')
    expect(useLaunchAckStore.getState().isPending('o-1')).toBe(true)
    useLaunchAckStore.getState().switchAccount(oid, 'acc-work')
    await expect(offered).resolves.toEqual({ switchTo: 'acc-work' })
    // Withdrawn is a no, as before.
    let gone!: Promise<unknown>
    act(() => { gone = choice('w-1') })
    useLaunchAckStore.getState().withdraw('w-1')
    await expect(gone).resolves.toBe(false)
  })
})
