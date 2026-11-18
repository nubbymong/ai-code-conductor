// The update install call's bridge (2.1.3-beta.8, plan section B3): the
// choice made at the update dialog reaches main as { discarded }, with only a
// literal true kept. "Close sessions" is then the only discard; every other
// call (Save, the Update pill with no tab open, the Settings fallback) is Save,
// so main leaves running the held terminals kept after a crash.
import { describe, it, expect, vi } from 'vitest'
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

describe('update.installAndRestart bridge (section B3)', () => {
  it('sends { discarded: true } only for a discard; no choice, or anything else, goes as { discarded: false }', async () => {
    const cases: Array<[unknown[], boolean]> = [
      [[{ discarded: true }], true],
      [[], false],
      [[{}], false],
      [[{ discarded: false }], false],
      [[{ discarded: 'true' }], false],
      [[null], false],
    ]
    for (const [args, discarded] of cases) {
      el.ipcRenderer.invoke.mockClear()
      await api.update.installAndRestart(...args)
      expect(el.ipcRenderer.invoke).toHaveBeenCalledTimes(1)
      expect(el.ipcRenderer.invoke, JSON.stringify(args)).toHaveBeenCalledWith(IPC.UPDATE_INSTALL_RESTART, { discarded })
    }
  })

  it('hands back what main answers', async () => {
    el.ipcRenderer.invoke.mockResolvedValueOnce(true)
    await expect(api.update.installAndRestart()).resolves.toBe(true)
  })
})
