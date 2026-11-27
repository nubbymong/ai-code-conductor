// @vitest-environment jsdom
//
// The sessions a machine's helper keeps, on its Machines card (plan
// 2.1.3-beta.19 section 1.2; aicc_planning#437), over a fake bridge: each
// listed session is a row; one with a config the app holds offers Re-attach
// and End, one with none End only, one an attached tab shows neither, one an
// open tab is not attached to End only; with the switch
// off a kept session is still listed and can be ended, and Re-attach says the
// switch is off and opens nothing; End sends the machine and the helper's
// session id, and drops a left-running entry once it is ended; a machine
// whose list did not read says so; SSH Persistent's logind note shows.
//
// PURE: the real section, a fake window.electronAPI.machines.remote, no IPC.
import React from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { RemoteMachinesState, RemoteSessionsState } from '../../../src/shared/remote-machines'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: RemoteMachinesSection } = await import('../../../src/renderer/components/RemoteMachinesSection')
const { useDetachedRemotesStore } = await import('../../../src/renderer/stores/detachedRemotesStore')
const { useConfigStore } = await import('../../../src/renderer/stores/configStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

const DID = 'd'.repeat(32)
const SID_A = `rm${'a'.repeat(30)}`
const SID_B = `rm${'b'.repeat(30)}`
const SID_C = `rm${'c'.repeat(30)}`
const machine = { did: DID, label: 'Pi', name: 'Pi (nick@pi.lan:22)', target: 'nick@pi.lan:22', checked: true, lastCheck: { at: 1, ok: true }, helperVersion: '0.1.0', system: 'Linux arm64', inUse: 0 }
const state = (over: Partial<RemoteMachinesState> = {}): RemoteMachinesState => ({
  available: true, switchOn: true, bundled: { ok: true, version: '0.1.0', files: [{ arch: 'aarch64', size: 3_000_000, sha12: 'abcdef012345' }] }, machines: [machine], candidates: [], ...over,
})
const rows = [
  { sid: SID_A, appSessionId: 'left-1', untilEnded: true, attached: false, running: true },
  { sid: SID_B, appSessionId: 'orphan-1', untilEnded: true, attached: false, running: true },
  { sid: SID_C, appSessionId: 'open-1', untilEnded: true, attached: true, running: true },
]
const listed: RemoteSessionsState = { machines: [{ did: DID, ok: true, sessions: rows }] }

let container: HTMLDivElement
let root: Root
function install(s: RemoteMachinesState, sessions: RemoteSessionsState = listed) {
  const remote = {
    state: vi.fn(async () => s),
    sessions: vi.fn(async () => sessions),
    endSession: vi.fn(async () => ({ ok: true, message: 'Ended the session on pi.lan.' })),
    prepare: vi.fn(), add: vi.fn(), check: vi.fn(), remove: vi.fn(),
  }
  ;(window as any).electronAPI = { machines: { remote }, session: { save: vi.fn(async () => true) } }
  return remote
}
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
}
async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<RemoteMachinesSection active />) })
  await settle()
}
const rowOf = (sid: string) => container.querySelector(`[data-testid="remote-kept-session"][data-sid="${sid}"]`) as HTMLElement | null
const buttonIn = (el: HTMLElement | null, label: string) => [...(el?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label) as HTMLButtonElement | undefined

beforeEach(() => {
  useDetachedRemotesStore.setState({ entries: [{ sessionId: 'left-1', configId: 'cfg-pi', host: 'pi.lan', username: 'nick', remotePath: '~/work', port: 22, mux: 'helper', did: DID, label: 'Pi work', detachedAt: 1 }] })
  useConfigStore.setState({ configs: [{ id: 'cfg-pi', label: 'Pi', sessionType: 'ssh', sshConfig: { host: 'pi.lan', port: 22, username: 'nick', remotePath: '~/work' } }] as never })
  useSessionStore.setState({ sessions: [{ id: 'open-1', label: 'Open tab', sessionType: 'ssh' }] as never, activeSessionId: null })
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

describe('a machine card\'s kept sessions', () => {
  it('lists each one: Re-attach and End with a config, End only without, neither for one a tab shows', async () => {
    install(state())
    await mount()
    expect(rowOf(SID_A)?.textContent).toContain('Pi work')
    expect(buttonIn(rowOf(SID_A), 'Re-attach')).toBeDefined()
    expect(buttonIn(rowOf(SID_A), 'End')).toBeDefined()
    expect(buttonIn(rowOf(SID_B), 'Re-attach')).toBeUndefined()
    expect(buttonIn(rowOf(SID_B), 'End')).toBeDefined()
    expect(rowOf(SID_C)?.textContent).toContain('open in a tab')
    expect(buttonIn(rowOf(SID_C), 'End')).toBeUndefined()
  })

  // Fix round 2: a tab open on a kept session it is not attached to (a
  // restored marked tab with the switch off, a start that failed, a link that
  // stayed down) is told to End it on this page, so its row offers End.
  it('a row whose open tab is not attached to it offers End and no Re-attach; one an attached tab shows still offers neither', async () => {
    const SID_D = `rm${'e'.repeat(30)}`
    useSessionStore.setState({ sessions: [{ id: 'open-1', label: 'Open tab', sessionType: 'ssh' }, { id: 'open-2', label: 'Unattached tab', sessionType: 'ssh' }] as never, activeSessionId: null })
    const remote = install(state(), { machines: [{ did: DID, ok: true, sessions: [
      ...rows,
      { sid: SID_D, appSessionId: 'open-2', untilEnded: true, attached: false, running: true },
    ] }] })
    await mount()
    expect(rowOf(SID_D)?.textContent).toContain('open in a tab that is not attached to it')
    expect(buttonIn(rowOf(SID_D), 'Re-attach')).toBeUndefined()
    expect(buttonIn(rowOf(SID_D), 'End')).toBeDefined()
    expect(buttonIn(rowOf(SID_C), 'End')).toBeUndefined()
    expect(buttonIn(rowOf(SID_C), 'Re-attach')).toBeUndefined()
    await act(async () => { buttonIn(rowOf(SID_D), 'End')!.click() })
    await settle()
    expect(remote.endSession).toHaveBeenCalledWith(DID, SID_D)
  })

  it('with the switch off: still listed and ended from here; Re-attach says the switch is off and opens nothing', async () => {
    const remote = install(state({ switchOn: false }))
    await mount()
    expect(rowOf(SID_A)).not.toBeNull()
    await act(async () => { buttonIn(rowOf(SID_A), 'Re-attach')!.click() })
    await settle()
    expect(container.querySelector('[data-testid="remote-notice"]')?.textContent).toContain('Remote sessions through the session helper are off')
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['open-1'])
    await act(async () => { buttonIn(rowOf(SID_A), 'End')!.click() })
    await settle()
    expect(remote.endSession).toHaveBeenCalledWith(DID, SID_A)
    // Ended: its left-running entry goes, so it is not offered again.
    expect(useDetachedRemotesStore.getState().entries).toEqual([])
  })

  it('Re-attach with the switch on opens it in a tab, marked as kept on its machine, with its own session id', async () => {
    install(state())
    await mount()
    await act(async () => { buttonIn(rowOf(SID_A), 'Re-attach')!.click() })
    await settle()
    const opened = useSessionStore.getState().sessions.find((s) => s.id === 'left-1') as { remoteVia?: string; remoteDid?: string } | undefined
    expect(opened).toMatchObject({ remoteVia: 'helper', remoteDid: DID })
    expect(useDetachedRemotesStore.getState().entries).toEqual([])
  })

  it('a machine whose sessions did not list says so', async () => {
    install(state(), { machines: [{ did: DID, ok: false, why: 'pi.lan could not be reached' }] })
    await mount()
    expect(container.querySelector('[data-testid="remote-kept-unread"]')?.textContent).toContain('pi.lan could not be reached')
  })

  it('SSH Persistent\'s logind note shows on the card while the switch is on', async () => {
    install(state({ machines: [{ ...machine, persistentNote: 'SSH Persistent tabs keep the usual SSH path here: its logind ends your processes when you log out (KillUserProcesses yes, Linger no).' }] }))
    await mount()
    expect(container.querySelector('[data-testid="remote-machine-persistent"]')?.textContent).toContain('KillUserProcesses yes')
  })
})
