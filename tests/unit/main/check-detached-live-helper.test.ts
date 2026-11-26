/**
 * ssh:checkDetachedLive for a session the session helper keeps (plan
 * 2.1.3-beta.19 section 1.2; aicc_planning#437): a left-running 'helper'
 * entry's liveness is list mode's answer on its machine (one exec), never a
 * tmux probe; a query that mixes both kinds is verified only when both halves
 * answer (fail-open: nothing is pruned on a half that did not).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: class {},
}))
const probeTmuxLive = vi.fn(async (_target: unknown, ids: string[]) => ({ outcome: 'verified' as const, liveSessionIds: ids }))
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: vi.fn(), writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(),
  endSshRemote: vi.fn(), probeTmuxLive: (...a: unknown[]) => probeTmuxLive(...(a as [unknown, string[]])),
}))
const remoteHelperLiveness = vi.fn(async (_t: unknown, ids: readonly string[]) => ({ outcome: 'verified' as 'verified' | 'unverified', liveSessionIds: [...ids] }))
vi.mock('../../../src/main/remote-helper', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/remote-helper')>()),
  remoteHelperLiveness: (t: unknown, ids: readonly string[]) => remoteHelperLiveness(t, ids),
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn() }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: (key: string) => (key === 'configs' ? [{ id: 'cfgA', sessionType: 'ssh', sshConfig: { host: 'pi.lan', port: 22, username: 'nick', remotePath: '~/work' } }] : null),
}))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => undefined }))
let registryOnDisk: unknown[] = []
vi.mock('../../../src/main/session-state', () => ({ readDetachedRemotesRegistry: () => registryOnDisk }))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
const { IPC } = await import('../../../src/shared/ipc-channels')
registerPtyHandlers(() => ({} as never))
const check = handlers.get(IPC.SSH_CHECK_DETACHED_LIVE)!

const DID = '0123456789abcdef0123456789abcdef'
const entry = (sessionId: string, over: Record<string, unknown> = {}) => ({
  sessionId, configId: 'cfgA', host: 'pi.lan', username: 'nick', remotePath: '~/work', port: 22, runtime: { type: 'host' }, mux: 'tmux', label: 'Pi', detachedAt: 1, ...over,
})

beforeEach(() => {
  probeTmuxLive.mockClear()
  remoteHelperLiveness.mockClear()
  remoteHelperLiveness.mockImplementation(async (_t, ids) => ({ outcome: 'verified', liveSessionIds: [...ids] }))
  registryOnDisk = []
})

describe('ssh:checkDetachedLive: a helper entry\'s liveness is list mode\'s', () => {
  it('helper entries only: one list on their machine, no tmux probe', async () => {
    registryOnDisk = [entry('kept-1', { mux: 'helper', did: DID }), entry('kept-2', { mux: 'helper', did: DID })]
    remoteHelperLiveness.mockImplementation(async () => ({ outcome: 'verified', liveSessionIds: ['kept-1'] }))
    const res = await check({}, { configId: 'cfgA', sessionIds: ['kept-1', 'kept-2'] })
    expect(remoteHelperLiveness).toHaveBeenCalledTimes(1)
    expect(remoteHelperLiveness.mock.calls[0][0]).toMatchObject({ host: 'pi.lan', port: 22, username: 'nick' })
    expect(remoteHelperLiveness.mock.calls[0][1]).toEqual(['kept-1', 'kept-2'])
    expect(probeTmuxLive).not.toHaveBeenCalled()
    expect(res).toEqual({ outcome: 'verified', liveSessionIds: ['kept-1'] })
  })

  it('tmux entries only: the tmux probe, as before, and no list', async () => {
    registryOnDisk = [entry('tmux-1')]
    const res = await check({}, { configId: 'cfgA', sessionIds: ['tmux-1'] })
    expect(remoteHelperLiveness).not.toHaveBeenCalled()
    expect(probeTmuxLive).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ outcome: 'verified', liveSessionIds: ['tmux-1'] })
  })

  it('both kinds: each asked its own way, the answers joined', async () => {
    registryOnDisk = [entry('kept-1', { mux: 'helper', did: DID }), entry('tmux-1')]
    const res = await check({}, { configId: 'cfgA', sessionIds: ['kept-1', 'tmux-1'] })
    expect(remoteHelperLiveness.mock.calls[0][1]).toEqual(['kept-1'])
    expect(probeTmuxLive.mock.calls[0][1]).toEqual(['tmux-1'])
    expect(res).toEqual({ outcome: 'verified', liveSessionIds: ['kept-1', 'tmux-1'] })
  })

  it('a list that did not answer makes the whole answer unverified (nothing pruned)', async () => {
    registryOnDisk = [entry('kept-1', { mux: 'helper', did: DID }), entry('tmux-1')]
    remoteHelperLiveness.mockImplementation(async () => ({ outcome: 'unverified', liveSessionIds: [] }))
    const res = await check({}, { configId: 'cfgA', sessionIds: ['kept-1', 'tmux-1'] })
    expect(res).toEqual({ outcome: 'unverified', liveSessionIds: [] })
  })
})
