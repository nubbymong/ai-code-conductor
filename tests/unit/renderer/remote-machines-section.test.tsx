// @vitest-environment jsdom
//
// The Machines page's Linux machines (plan 2.1.3-beta.17, section A2;
// aicc_planning#411), over a fake bridge: nothing is shown where remote
// sessions are not available; Add asks first, shows what goes to the machine,
// and sends the add only on Install, with the question's token; Cancel sends
// nothing; each machine's card says whether it is checked and, with the switch
// on, which kind of config runs through the helper there; Remove asks first and
// is not offered while a tab runs there.
//
// PURE: the real section, a fake window.electronAPI.machines.remote, no IPC.
import React from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { REMOTE_OTHER_HELPER, REMOTE_ROUTE_NOTE, REMOTE_SESSIONS_SETTING, type RemoteMachinesState } from '../../../src/shared/remote-machines'
import { DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: RemoteMachinesSection } = await import('../../../src/renderer/components/RemoteMachinesSection')

const TOKEN = 'c'.repeat(32)
const DID = 'd'.repeat(32)
const state = (over: Partial<RemoteMachinesState> = {}): RemoteMachinesState => ({
  available: true,
  switchOn: true,
  bundled: { ok: true, version: '0.1.0', files: [{ arch: 'x86_64', size: 3_000_000, sha12: 'abcdef012345' }, { arch: 'aarch64', size: 2_800_000, sha12: '0123456789ab' }] },
  machines: [],
  candidates: [
    { configId: 'cfg-key', label: 'Rocky', target: 'nick@rocky.lan:22', addable: true },
    { configId: 'cfg-pass', label: 'Pi', target: 'pi@pi.lan:22', addable: false, why: 'It signs in with a password.' },
  ],
  ...over,
})

let container: HTMLDivElement
let root: Root
function install(s: RemoteMachinesState) {
  const remote = {
    state: vi.fn(async () => s),
    prepare: vi.fn(async () => ({ ok: true, token: TOKEN, target: 'nick@rocky.lan:22', text: 'Install the session helper on nick@rocky.lan:22? One file, 2.9 MB, SHA-256 abcdef012345, into ~/.aicc in your account there.' })),
    add: vi.fn(async () => ({ ok: true, message: 'Added rocky.lan. Its self-test passed.' })),
    check: vi.fn(async () => ({ ok: true, message: 'rocky.lan passed its check.' })),
    remove: vi.fn(async () => ({ ok: true, message: 'Removed the session helper from rocky.lan.' })),
  }
  ;(window as any).electronAPI = { machines: { remote } }
  return remote
}
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}
async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<RemoteMachinesSection active />) })
  await settle()
}
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined
async function click(b: HTMLButtonElement | undefined) {
  expect(b, 'the button is there').toBeDefined()
  await act(async () => { b!.click() })
  await settle()
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  delete (window as any).electronAPI
})

describe('Linux machines on the Machines page', () => {
  it('shows nothing where remote sessions are not available, or with no bridge', async () => {
    install(state({ available: false }))
    await mount()
    expect(container.querySelector('[data-testid="remote-machines"]')).toBeNull()
    act(() => root.unmount())
    container.remove()
    ;(window as any).electronAPI = { machines: {} }
    await mount()
    expect(container.querySelector('[data-testid="remote-machines"]')).toBeNull()
  })

  it('asks before anything is sent, and adds only on Install, with the question\'s token', async () => {
    const remote = install(state())
    await mount()
    await click(button('Add a Linux machine'))
    expect(remote.prepare).toHaveBeenCalledWith('cfg-key')
    expect(remote.add).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="remote-consent"]')?.textContent).toContain('SHA-256 abcdef012345')
    await click(button('Install'))
    expect(remote.add).toHaveBeenCalledWith(TOKEN)
    expect(container.querySelector('[data-testid="remote-notice"]')?.textContent).toContain('Added rocky.lan')
  })

  it('Cancel sends nothing', async () => {
    const remote = install(state())
    await mount()
    await click(button('Add a Linux machine'))
    await click(button('Cancel'))
    expect(remote.add).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="remote-consent"]')).toBeNull()
  })

  it('says when the switch is off, and offers no Add without a Linux helper in the build', async () => {
    install(state({ switchOn: false, bundled: { ok: false, why: 'This build of the app carries no Linux session helper, so no machine can be added from it.' } }))
    await mount()
    expect(container.querySelector('[data-testid="remote-switch-off"]')?.textContent).toContain('Settings, General, under Terminal')
    expect(container.querySelector('[data-testid="remote-no-helper"]')?.textContent).toContain('no Linux session helper')
    expect(button('Add a Linux machine')?.disabled).toBe(true)
  })

  it('a card says whether the machine is checked and which configs run through the helper, Check checks it, Remove asks first', async () => {
    const m = { did: DID, label: 'Rocky', target: 'nick@rocky.lan:22', checked: false, lastCheck: { at: Date.now(), ok: false, detail: 'its self-test failed (pty)' }, helperVersion: '0.1.0', system: 'Linux x86_64', inUse: 0 }
    const remote = install(state({ machines: [m] }))
    await mount()
    expect(container.querySelector('[data-testid="remote-machine-state"]')?.textContent).toContain('Not checked: its self-test failed (pty)')
    // Not checked: its tabs take the usual SSH path, so the line that they go through the helper is not shown (text smoke #32).
    expect(container.querySelector('[data-testid="remote-machine-route"]')).toBeNull()
    await click(button('Check'))
    expect(remote.check).toHaveBeenCalledWith(DID)
    await click(button('Remove'))
    expect(remote.remove).not.toHaveBeenCalled()
    await click(button('Remove'))
    expect(remote.remove).toHaveBeenCalledWith(DID)
  })

  // The Raspberry Pi line of 2.1.3-beta.19 (the owner's Raspberry Pi 5 (arm64)
  // and Ubuntu 24.04 (x86-64)): after the update the card said "another
  // version" beside 0.1.0, the version both builds' helpers carry; the file is
  // compared by its SHA-256, so the line names the file, never a version.
  it('a machine holding another helper file than this build\'s says Check installs this one, and never claims another version', async () => {
    install(state({ machines: [{ did: DID, label: 'Rocky', target: 'nick@rocky.lan:22', checked: false, lastCheck: { at: Date.now(), ok: false, detail: REMOTE_OTHER_HELPER }, helperVersion: '0.1.0', system: 'Linux x86_64', inUse: 0 }] }))
    await mount()
    const line = container.querySelector('[data-testid="remote-machine-state"]')?.textContent
    expect(line).toBe('Not checked: this build of the app carries a different session helper file; press Check to install it; until then its tabs take the usual SSH path')
    expect(line).not.toMatch(/version/i)
    expect(container.querySelector('[data-testid="remote-machine-route"]')).toBeNull()
    expect(button('Check')?.disabled).toBe(false)
  })

  // 2.1.3-beta.18 release smoke (u-remove-confirm.png): the Remove question
  // opened under the green notice of the machine's Add five minutes before,
  // so the page showed an old answer beside a new question.
  it('opening the Remove question clears the last action\'s notice', async () => {
    const m = { did: DID, label: 'Rocky', target: 'nick@rocky.lan:22', checked: true, lastCheck: { at: Date.now(), ok: true }, helperVersion: '0.1.0', system: 'Linux x86_64', inUse: 0 }
    const remote = install(state({ machines: [m] }))
    await mount()
    const notice = () => container.querySelector('[data-testid="remote-notice"]')?.textContent
    // A checked machine with the switch on says its tabs go through the helper (text smoke #32).
    expect(container.querySelector('[data-testid="remote-machine-route"]')?.textContent).toBe(REMOTE_ROUTE_NOTE)
    await click(button('Check'))
    expect(notice()).toBe('rocky.lan passed its check.')
    await click(button('Remove'))
    expect(container.querySelector('[aria-label="Confirm removing Rocky"]')).not.toBeNull()
    expect(remote.remove).not.toHaveBeenCalled()
    expect(notice()).toBe('')
    // Keep it sends nothing and brings no old notice back.
    await click(button('Keep it'))
    expect(remote.remove).not.toHaveBeenCalled()
    expect(notice()).toBe('')
  })

  it('Remove is not offered while a tab runs through the helper there', async () => {
    install(state({ machines: [{ did: DID, label: 'Rocky', target: 'nick@rocky.lan:22', checked: true, lastCheck: { at: Date.now(), ok: true }, helperVersion: '0.1.0', system: 'Linux x86_64', inUse: 1 }] }))
    await mount()
    expect(button('Remove')?.disabled).toBe(true)
    expect(container.querySelector('[data-testid="remote-machine-state"]')?.textContent).toContain('a tab runs through the helper here')
  })
})

// The switch (Settings, General, under Terminal), as held-terminal-tab.test.ts
// pins its two siblings: off by default, Windows only, after the agent
// sessions' switch, and it saves the key main reads.
describe('the remote sessions switch in Settings', () => {
  it('is off by default', () => {
    expect(DEFAULT_SETTINGS.remoteSessionsThroughHelper).toBe(false)
    expect(REMOTE_SESSIONS_SETTING).toBe('remoteSessionsThroughHelper')
  })

  it('is shown on Windows only, after the agent sessions\' switch, and saves remoteSessionsThroughHelper', () => {
    const page = readFileSync(resolve(__dirname, '../../../src/renderer/components/SettingsPage.tsx'), 'utf8').replace(/\r\n/g, '\n')
    const agents = page.indexOf('data-testid="setting-agent-sessions-helper"')
    const remote = page.indexOf('data-testid="setting-remote-sessions-helper"')
    expect(agents).toBeGreaterThan(0)
    expect(remote).toBeGreaterThan(agents)
    expect(page.match(/data-testid="setting-remote-sessions-helper"/g)).toHaveLength(1)
    // The Windows gate opens right before it, after the agent sessions' label closes.
    const gate = page.lastIndexOf("{window.electronPlatform === 'win32' && (", remote)
    expect(gate).toBeGreaterThan(page.indexOf('</label>', agents))
    expect(page.slice(gate, remote)).toMatch(/^\{window\.electronPlatform === 'win32' && \(\n\s*<label [^>]*$/)
    const block = page.slice(remote, page.indexOf('</label>', remote))
    expect(block).toContain('checked={settings.remoteSessionsThroughHelper === true}')
    expect(block).toContain('onChange={(e) => save({ remoteSessionsThroughHelper: e.target.checked })}')
    expect(block).toContain('{REMOTE_SWITCH_TEXT}')
  })
})

// 2.1.3-beta.19 text smoke (#34): with every saved SSH config added, the list
// was an empty greyed box beside a greyed Add (select value '', selectedIndex
// -1, all three options disabled '... - Added already.'). It says so now.
describe('the Add list when every saved SSH config is added already', () => {
  it('shows one line that says so, not an empty box; Add stays off', async () => {
    install(state({ candidates: [
      { configId: 'cfg-a', label: 'Rocky', target: 'nick@rocky.lan:22', addable: false, why: 'Added already.' },
      { configId: 'cfg-b', label: 'Ubuntu', target: 'nick@ubuntu.lan:22', addable: false, why: 'Added already.' },
    ] }))
    await mount()
    const select = container.querySelector('select[aria-label="Saved SSH config to add"]') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(select.selectedOptions[0]?.textContent).toBe('Every saved SSH config with key sign-in is added already')
    expect(button('Add a Linux machine')?.disabled).toBe(true)
  })

  it('a list with one config still to add does not show that line', async () => {
    install(state())
    await mount()
    expect(container.textContent).not.toContain('is added already')
  })
})
