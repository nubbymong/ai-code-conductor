// The Machines page's bridge (2.1.3-beta.6, plan section C.1; the remote
// machines' five, 2.1.3-beta.17 A2): the channel names are pinned (a rename
// breaks the preload, the typings and the handlers together), and each preload
// method invokes exactly its own channel with the caller's argument unchanged
// and hands back what main answers. (That every IPC value is unique is pinned
// once, for all channels, in ipc-channels-channels.test.ts.)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC } from '../../src/shared/ipc-channels'

const el = vi.hoisted(() => {
  const exposed: Record<string, any> = {}
  const ipcRenderer = {
    on: vi.fn(),
    removeListener: vi.fn(),
    invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
    send: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    sendSync: vi.fn(),
  }
  return { exposed, ipcRenderer }
})
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { el.exposed[name] = api } },
  ipcRenderer: el.ipcRenderer,
}))

await import('../../src/preload/index')
const api = el.exposed.electronAPI as any

beforeEach(() => { el.ipcRenderer.invoke.mockClear() })

describe('Machines channel names', () => {
  it('pins each channel string', () => {
    const ipc = IPC as unknown as Record<string, string>
    expect(ipc.MACHINES_STATUS).toBe('machines:status')
    expect(ipc.MACHINES_SELF_TEST).toBe('machines:selfTest')
    expect(ipc.MACHINES_END_SESSION).toBe('machines:endSession')
    expect(ipc.MACHINES_REATTACH).toBe('machines:reattach')
    // 2.1.3-beta.17 (plan section A2): the remote machines' doors.
    expect(ipc.MACHINES_REMOTE_STATE).toBe('machines:remote:state')
    expect(ipc.MACHINES_REMOTE_PREPARE).toBe('machines:remote:prepare')
    expect(ipc.MACHINES_REMOTE_ADD).toBe('machines:remote:add')
    expect(ipc.MACHINES_REMOTE_CHECK).toBe('machines:remote:check')
    expect(ipc.MACHINES_REMOTE_REMOVE).toBe('machines:remote:remove')
  })
})

describe('Machines preload bridge', () => {
  it('each method invokes exactly its own channel with the argument unchanged', async () => {
    const cases: Array<[() => Promise<unknown>, string, unknown[]]> = [
      [() => api.machines.status(), IPC.MACHINES_STATUS, []],
      [() => api.machines.runSelfTest(), IPC.MACHINES_SELF_TEST, []],
      [() => api.machines.endSession('held-1'), IPC.MACHINES_END_SESSION, ['held-1']],
      [() => api.machines.reattach('held-1'), IPC.MACHINES_REATTACH, ['held-1']],
      [() => api.machines.remote.state(), IPC.MACHINES_REMOTE_STATE, []],
      [() => api.machines.remote.prepare('cfg-1'), IPC.MACHINES_REMOTE_PREPARE, ['cfg-1']],
      [() => api.machines.remote.add('a'.repeat(32)), IPC.MACHINES_REMOTE_ADD, ['a'.repeat(32)]],
      [() => api.machines.remote.check('b'.repeat(32)), IPC.MACHINES_REMOTE_CHECK, ['b'.repeat(32)]],
      [() => api.machines.remote.remove('b'.repeat(32)), IPC.MACHINES_REMOTE_REMOVE, ['b'.repeat(32)]],
    ]
    for (const [run, channel, args] of cases) {
      el.ipcRenderer.invoke.mockClear()
      await run()
      expect(el.ipcRenderer.invoke).toHaveBeenCalledTimes(1)
      expect(el.ipcRenderer.invoke).toHaveBeenCalledWith(channel, ...args)
    }
  })

  it('hands back what main answers', async () => {
    const answer = { ok: false, message: 'The session helper is off, so it holds no terminal to end.' }
    el.ipcRenderer.invoke.mockResolvedValueOnce(answer)
    expect(await api.machines.endSession('x')).toBe(answer)
  })

  it('offers no push: the page reads on open, on Refresh and after each action', () => {
    expect(Object.keys(api.machines).sort()).toEqual(['endSession', 'reattach', 'remote', 'runSelfTest', 'status'])
    // 2.1.3-beta.19 section 1.2: the kept sessions (asked, never pushed), End of one, End of a tab's own.
    expect(Object.keys(api.machines.remote).sort()).toEqual(['add', 'check', 'endSession', 'endTab', 'prepare', 'remove', 'sessions', 'state'])
  })

  it('2.1.3-beta.19: the kept sessions and both Ends go to their own channels, with what they are given', async () => {
    el.ipcRenderer.invoke.mockResolvedValue({ machines: [] })
    await api.machines.remote.sessions()
    expect(el.ipcRenderer.invoke).toHaveBeenLastCalledWith(IPC.MACHINES_REMOTE_SESSIONS)
    await api.machines.remote.endSession('d'.repeat(32), 'rm' + 'c'.repeat(30))
    expect(el.ipcRenderer.invoke).toHaveBeenLastCalledWith(IPC.MACHINES_REMOTE_END_SESSION, 'd'.repeat(32), 'rm' + 'c'.repeat(30))
    await api.machines.remote.endTab('kept-1', 'd'.repeat(32))
    expect(el.ipcRenderer.invoke).toHaveBeenLastCalledWith(IPC.MACHINES_REMOTE_END_TAB, 'kept-1', 'd'.repeat(32))
  })
})
