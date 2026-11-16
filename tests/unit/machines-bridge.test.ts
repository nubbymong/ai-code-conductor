// The Machines page's bridge (2.1.3-beta.6, plan section C.1): the four channel
// names are pinned (a rename breaks the preload, the typings and the handlers
// together), and each preload method invokes exactly its own channel with the
// caller's argument unchanged and hands back what main answers. (That every IPC
// value is unique is pinned once, for all channels, in ipc-channels-channels.test.ts.)
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
  })
})

describe('Machines preload bridge', () => {
  it('each method invokes exactly its own channel with the argument unchanged', async () => {
    const cases: Array<[() => Promise<unknown>, string, unknown[]]> = [
      [() => api.machines.status(), IPC.MACHINES_STATUS, []],
      [() => api.machines.runSelfTest(), IPC.MACHINES_SELF_TEST, []],
      [() => api.machines.endSession('held-1'), IPC.MACHINES_END_SESSION, ['held-1']],
      [() => api.machines.reattach('held-1'), IPC.MACHINES_REATTACH, ['held-1']],
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
    expect(Object.keys(api.machines).sort()).toEqual(['endSession', 'reattach', 'runSelfTest', 'status'])
  })
})
