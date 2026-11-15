// The diagnostics IPC is answered by the one service registry. What the
// registry puts in a snapshot, and where it sends a restart, is covered in
// service-registry.test.ts; here only that the two channels hand over to it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain } from 'electron'
import { registerServiceHealthHandlers } from '../../../src/main/ipc/service-health-handlers'
import { IPC } from '../../../src/shared/ipc-channels'
import type { DiagnosticsSnapshot } from '../../../src/shared/service-health'

const handle = ipcMain.handle as unknown as ReturnType<typeof vi.fn>

/** The handlers registered since the last clear, by channel. */
function registered(): Map<string, (...args: unknown[]) => Promise<unknown>> {
  return new Map(handle.mock.calls.map(([channel, fn]) => [channel as string, fn as (...args: unknown[]) => Promise<unknown>]))
}

const SNAP: DiagnosticsSnapshot = { capturedAt: 1, services: [], log: [] }

beforeEach(() => { handle.mockClear() })

describe('service-health-handlers', () => {
  it('registers the GET and RESTART channels, and nothing else', () => {
    registerServiceHealthHandlers({ snapshot: () => SNAP, restart: () => ({ ok: true }) })
    expect([...registered().keys()].sort()).toEqual([IPC.SERVICE_HEALTH_GET, IPC.SERVICE_RESTART].sort())
  })

  it('GET answers with the registry snapshot, read at the time of the call', async () => {
    const snapshot = vi.fn(() => SNAP)
    registerServiceHealthHandlers({ snapshot, restart: () => ({ ok: true }) })
    expect(snapshot).not.toHaveBeenCalled()
    await expect(registered().get(IPC.SERVICE_HEALTH_GET)!({})).resolves.toBe(SNAP)
    expect(snapshot).toHaveBeenCalledTimes(1)
  })

  it('RESTART hands the service id to the registry and returns its answer', async () => {
    const restart = vi.fn((id: string) => ({ ok: id === 'logging', reason: `asked ${id}` }))
    registerServiceHealthHandlers({ snapshot: () => SNAP, restart })
    const call = registered().get(IPC.SERVICE_RESTART)!
    await expect(call({}, 'logging')).resolves.toEqual({ ok: true, reason: 'asked logging' })
    await expect(call({}, 'nope')).resolves.toEqual({ ok: false, reason: 'asked nope' })
    expect(restart.mock.calls).toEqual([['logging'], ['nope']])
  })
})
