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
import { REMOTE_ROUTE_NOTE, type RemoteMachinesState } from '../../../src/shared/remote-machines'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: RemoteMachinesSection } = await import('../../../src/renderer/components/RemoteMachinesSection')

const TOKEN = 'c'.repeat(32)
const DID = 'd'.repeat(32)
const state = (over: Partial<RemoteMachinesState> = {}): RemoteMachinesState => ({
  available: true,
  switchOn: true,
  bundled: { ok: true, version: '0.1.0', size: 3_000_000, sha12: 'abcdef012345' },
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
    prepare: vi.fn(async () => ({ ok: true, token: TOKEN, target: 'nick@rocky.lan:22', text: 'Install the session helper on rocky.lan? One file, 2.9 MB, SHA-256 abcdef012345, into ~/.aicc in your account there.' })),
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
    expect(container.querySelector('[data-testid="remote-machine-route"]')?.textContent).toBe(REMOTE_ROUTE_NOTE)
    await click(button('Check'))
    expect(remote.check).toHaveBeenCalledWith(DID)
    await click(button('Remove'))
    expect(remote.remove).not.toHaveBeenCalled()
    await click(button('Remove'))
    expect(remote.remove).toHaveBeenCalledWith(DID)
  })

  it('Remove is not offered while a tab runs through the helper there', async () => {
    install(state({ machines: [{ did: DID, label: 'Rocky', target: 'nick@rocky.lan:22', checked: true, lastCheck: { at: Date.now(), ok: true }, helperVersion: '0.1.0', system: 'Linux x86_64', inUse: 1 }] }))
    await mount()
    expect(button('Remove')?.disabled).toBe(true)
    expect(container.querySelector('[data-testid="remote-machine-state"]')?.textContent).toContain('a tab runs through the helper here')
  })
})
