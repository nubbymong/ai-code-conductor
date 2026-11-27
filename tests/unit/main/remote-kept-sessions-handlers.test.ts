/**
 * The Machines page's doors for kept sessions (plan 2.1.3-beta.19 section 1.2;
 * aicc_planning#437): the list (one list exec per machine listed: every added
 * machine while the switch is on; with it off, only those a left-running
 * 'helper' entry or a saved tab's mark names, so kept sessions are still
 * listed and can be ended), End of one on its card, End of a tab's own; each
 * answers only the app's window and checks what it is given; and the one list
 * at start-up (no daemon, no polling).
 *
 * PURE: ipcMain is the shared mock; the remote helper's list and end are
 * watched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-channels'

const h = vi.hoisted(() => ({
  settings: null as Record<string, unknown> | null,
  registry: [] as unknown[],
  saved: null as unknown,
  listed: [] as Array<readonly string[] | undefined>,
  ended: [] as unknown[][],
}))

vi.mock('../../../src/main/config-manager', () => ({
  readConfig: (name: string) => (name === 'settings' ? h.settings : name === 'configs' ? [] : null),
}))
vi.mock('../../../src/main/session-state', () => ({
  readDetachedRemotesRegistry: () => h.registry,
  peekSessionState: () => h.saved,
}))
vi.mock('../../../src/main/remote-helper', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/remote-helper')>()),
  setRemoteHelperDeps: () => {},
  listRemoteSessions: async (dids?: readonly string[]) => { h.listed.push(dids); return (dids ?? ['f'.repeat(32)]).map((did) => ({ did, ok: true, sessions: [] })) },
  endRemoteSession: async (...a: unknown[]) => { h.ended.push(['session', ...a]); return { ok: true, message: 'Ended.' } },
  endRemoteTab: async (...a: unknown[]) => { h.ended.push(['tab', ...a]); return { ok: true, message: 'Ended.' } },
}))
vi.mock('../../../src/main/remote-helper/machines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/remote-helper/machines')>()),
  fileStore: () => ({ read: () => ({ v: 1, installId: 'f'.repeat(32), machines: [] }), write: () => {} }),
}))
vi.mock('../../../src/main/remote-helper/ssh-exec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/remote-helper/ssh-exec')>()),
  nodeSshRunner: () => ({}),
}))

const { registerRemoteMachinesHandlers, keptMachineDids, STARTUP_SESSIONS_DELAY_MS } = await import('../../../src/main/ipc/remote-machines-handlers')
const { MACHINES_NOT_APP } = await import('../../../src/main/ipc/machines-handlers')

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>
const handlers = new Map<string, Handler>()
const frame = { id: 'main-frame' }
const webContents = { mainFrame: frame }
const win = { isDestroyed: () => false, webContents } as any
const appEvent = { sender: webContents, senderFrame: frame }
const stranger = { sender: webContents, senderFrame: { id: 'sub-frame' } }
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(appEvent, ...args)

const DID_A = 'a'.repeat(32)
const DID_B = 'b'.repeat(32)
const SID = `rm${'c'.repeat(30)}`

beforeEach(() => {
  handlers.clear()
  vi.mocked(ipcMain.handle).mockReset()
  vi.mocked(ipcMain.handle).mockImplementation(((channel: string, fn: Handler) => { handlers.set(channel, fn) }) as any)
  h.settings = { remoteSessionsThroughHelper: true }
  h.registry = []
  h.saved = null
  h.listed = []
  h.ended = []
})
afterEach(() => { vi.useRealTimers() })

describe('the kept sessions\' list', () => {
  it('switch on: every added machine is listed', async () => {
    registerRemoteMachinesHandlers(() => win, 'win32')
    await call(IPC.MACHINES_REMOTE_SESSIONS)
    expect(h.listed).toEqual([undefined])
  })

  it('switch off: only the machines a helper entry or a saved tab\'s mark names, so their kept sessions are still listed (with End)', async () => {
    h.settings = { remoteSessionsThroughHelper: false }
    h.registry = [{ sessionId: 'left-1', host: 'x', username: 'u', remotePath: '~', mux: 'helper', did: DID_A, label: 'x', detachedAt: 1 }, { sessionId: 'tmux-1', host: 'x', username: 'u', remotePath: '~', mux: 'tmux', label: 'x', detachedAt: 1 }]
    h.saved = { sessions: [{ id: 's1', remoteVia: 'helper', remoteDid: DID_B }, { id: 's2', remoteDid: DID_A }] }
    registerRemoteMachinesHandlers(() => win, 'win32')
    const r = await call(IPC.MACHINES_REMOTE_SESSIONS)
    expect(h.listed).toHaveLength(1)
    expect([...(h.listed[0] ?? [])].sort()).toEqual([DID_A, DID_B])
    expect(r.machines.map((m: { did: string }) => m.did).sort()).toEqual([DID_A, DID_B])
    expect(keptMachineDids().sort()).toEqual([DID_A, DID_B])
  })

  it('switch off and nothing kept: no machine is asked', async () => {
    h.settings = { remoteSessionsThroughHelper: false }
    registerRemoteMachinesHandlers(() => win, 'win32')
    expect(await call(IPC.MACHINES_REMOTE_SESSIONS)).toEqual({ machines: [] })
    expect(h.listed).toEqual([])
  })

  it('a stranger gets none, and nothing is asked', async () => {
    registerRemoteMachinesHandlers(() => win, 'win32')
    expect(await handlers.get(IPC.MACHINES_REMOTE_SESSIONS)!(stranger)).toEqual({ machines: [] })
    expect(h.listed).toEqual([])
  })

  it('at start-up, once, after its delay: the same list (no daemon, no polling)', async () => {
    vi.useFakeTimers()
    registerRemoteMachinesHandlers(() => win, 'win32')
    expect(h.listed).toEqual([])
    await vi.advanceTimersByTimeAsync(STARTUP_SESSIONS_DELAY_MS)
    expect(h.listed).toEqual([undefined])
    await vi.advanceTimersByTimeAsync(STARTUP_SESSIONS_DELAY_MS * 10)
    expect(h.listed).toHaveLength(1)
  })

  it('at start-up with the switch off and nothing kept: nothing of the feature is asked', async () => {
    vi.useFakeTimers()
    h.settings = { remoteSessionsThroughHelper: false }
    registerRemoteMachinesHandlers(() => win, 'win32')
    await vi.advanceTimersByTimeAsync(STARTUP_SESSIONS_DELAY_MS)
    expect(h.listed).toEqual([])
  })
})

describe('End', () => {
  it('on a card: the machine and the helper session id, each checked first', async () => {
    registerRemoteMachinesHandlers(() => win, 'win32')
    expect((await call(IPC.MACHINES_REMOTE_END_SESSION, DID_A, SID)).ok).toBe(true)
    expect(h.ended).toEqual([['session', DID_A, SID]])
    expect((await call(IPC.MACHINES_REMOTE_END_SESSION, 'nope', SID)).ok).toBe(false)
    expect((await call(IPC.MACHINES_REMOTE_END_SESSION, DID_A, 'rm-not-one')).ok).toBe(false)
    expect(h.ended).toHaveLength(1)
  })

  it('a tab\'s own: its app session id, and the machine of a session left running', async () => {
    registerRemoteMachinesHandlers(() => win, 'win32')
    expect((await call(IPC.MACHINES_REMOTE_END_TAB, 'kept-1', DID_A)).ok).toBe(true)
    expect((await call(IPC.MACHINES_REMOTE_END_TAB, 'kept-2')).ok).toBe(true)
    expect(h.ended).toEqual([['tab', 'kept-1', DID_A], ['tab', 'kept-2', undefined]])
    expect((await call(IPC.MACHINES_REMOTE_END_TAB, 'bad id!', DID_A)).ok).toBe(false)
    expect((await call(IPC.MACHINES_REMOTE_END_TAB, 'kept-3', 'nope')).ok).toBe(false)
    expect(h.ended).toHaveLength(2)
  })

  it('a stranger ends nothing', async () => {
    registerRemoteMachinesHandlers(() => win, 'win32')
    expect(await handlers.get(IPC.MACHINES_REMOTE_END_SESSION)!(stranger, DID_A, SID)).toEqual({ ok: false, message: MACHINES_NOT_APP })
    expect(await handlers.get(IPC.MACHINES_REMOTE_END_TAB)!(stranger, 'kept-1')).toEqual({ ok: false, message: MACHINES_NOT_APP })
    expect(h.ended).toEqual([])
  })
})
