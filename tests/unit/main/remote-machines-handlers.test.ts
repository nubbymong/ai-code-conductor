// The Machines page's doors for remote machines (plan 2.1.3-beta.17, section
// A2; aicc_planning#411), as machines-handlers.test.ts pins This computer's:
// exactly the five machines:remote:* channels; each answers only the app
// window's main frame (a stranger's state shows nothing, and a stranger's
// Add, Check or Remove starts no ssh); a config id, token or device id that
// breaks its pattern is refused before the machine list is asked; off
// Windows every action says it is not available and the PTY manager is not
// plugged in; on Windows the PTY manager is plugged in with the saved
// settings, and the state's switch follows them; the cards read this build's
// helper hash.
//
// PURE: ipcMain is the shared mock; handlers are captured and called
// directly. The records file is in memory and ssh is a fake one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-channels'
import { REMOTE_OTHER_HELPER, type RemoteMachinesState } from '../../../src/shared/remote-machines'
import { FakeSsh } from '../remote-helper/fake-ssh'

const h = vi.hoisted(() => {
  const SHA = 'a'.repeat(64)
  return {
    SHA,
    HELPER: { file: '/x/linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, size: 4096, folder: `0.1.0-${SHA.slice(0, 12)}` },
    settings: null as Record<string, unknown> | null,
    configs: [] as unknown[],
    stored: null as unknown,
    ssh: null as unknown,
    setDeps: (() => {}) as (d: unknown) => void,
  }
})

vi.mock('../../../src/main/config-manager', () => ({
  readConfig: (name: string) => (name === 'settings' ? h.settings : name === 'configs' ? h.configs : null),
}))
vi.mock('../../../src/main/remote-helper', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/remote-helper')>()),
  setRemoteHelperDeps: (d: unknown) => h.setDeps(d),
}))
vi.mock('../../../src/main/remote-helper/machines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/remote-helper/machines')>()),
  fileStore: () => ({ read: () => h.stored, write: (v: unknown) => { h.stored = JSON.parse(JSON.stringify(v)) } }),
}))
vi.mock('../../../src/main/remote-helper/ssh-exec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/remote-helper/ssh-exec')>()),
  nodeSshRunner: () => h.ssh,
}))
vi.mock('../../../src/main/remote-helper/manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/remote-helper/manifest')>()),
  readBundledLinuxHelper: async () => ({ ok: true, helper: h.HELPER }),
}))

const { registerRemoteMachinesHandlers, REMOTE_NOT_AVAILABLE, REMOTE_STATE_UNREAD } = await import('../../../src/main/ipc/remote-machines-handlers')
const { setPtyIntegrityMonitor } = await import('../../../src/main/services/pty-integrity-monitor')
const { MACHINES_NOT_APP } = await import('../../../src/main/ipc/machines-handlers')
const { RemoteMachines } = await import('../../../src/main/remote-helper/machines')

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>
const handlers = new Map<string, Handler>()

// The app's own window: its web contents and that web contents' main frame.
const frame = { id: 'main-frame' }
const webContents = { mainFrame: frame }
const win = { isDestroyed: () => false, webContents } as any
const appEvent = { sender: webContents, senderFrame: frame }
const strangers = [
  { sender: { mainFrame: frame }, senderFrame: frame },      // another web contents
  { sender: webContents, senderFrame: { id: 'sub-frame' } }, // a frame inside the window
  { sender: webContents, senderFrame: null },
  { sender: 'anyone' },                                      // not a web contents at all
]

const DID = '0123456789abcdef0123456789abcdef'
const TOKEN = 'c'.repeat(32)
const record = (sha256 = h.SHA) => ({
  did: DID, host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1, os: 'Linux', arch: 'x86_64',
  home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/usr/local/bin/claude', path: '/usr/bin:/bin', lang: null,
  helper: { version: '0.1.0', sha256, folder: `0.1.0-${sha256.slice(0, 12)}` }, check: { at: 1, ok: true },
})
const CONFIGS = [{ id: 'cfg-key', label: 'Pi', sessionType: 'ssh', sshConfig: { host: 'pi.lan', port: 22, username: 'pi' } }]

let ssh: FakeSsh
let deps: Array<Record<string, any>>

function register(platform: NodeJS.Platform = 'win32'): void {
  registerRemoteMachinesHandlers(() => win, platform)
}
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(appEvent, ...args)

/** Each of the machine list's own methods, watched (they still run). */
function watch() {
  const p = RemoteMachines.prototype
  return {
    views: vi.spyOn(p, 'views'), candidates: vi.spyOn(p, 'candidates'), prepare: vi.spyOn(p, 'prepare'),
    add: vi.spyOn(p, 'add'), check: vi.spyOn(p, 'check'), remove: vi.spyOn(p, 'remove'),
  }
}

beforeEach(() => {
  handlers.clear()
  vi.mocked(ipcMain.handle).mockReset()
  vi.mocked(ipcMain.handle).mockImplementation(((channel: string, fn: Handler) => { handlers.set(channel, fn) }) as any)
  h.settings = { remoteSessionsThroughHelper: true }
  h.configs = CONFIGS
  h.stored = { v: 1, installId: 'f'.repeat(32), machines: [record()] }
  ssh = new FakeSsh({ answer: () => ({ code: 255, stderr: 'Connection refused' }) })
  h.ssh = ssh
  deps = []
  h.setDeps = (d) => { deps.push(d as Record<string, any>) }
})
afterEach(() => vi.restoreAllMocks())

describe('registerRemoteMachinesHandlers', () => {
  it('registers exactly the eight machines:remote:* channels (2.1.3-beta.19 section 1.2: the kept sessions, End of one, End of a tab\'s own)', () => {
    register()
    expect([...handlers.keys()].sort()).toEqual([
      IPC.MACHINES_REMOTE_STATE, IPC.MACHINES_REMOTE_PREPARE, IPC.MACHINES_REMOTE_ADD, IPC.MACHINES_REMOTE_CHECK, IPC.MACHINES_REMOTE_REMOVE,
      IPC.MACHINES_REMOTE_SESSIONS, IPC.MACHINES_REMOTE_END_SESSION, IPC.MACHINES_REMOTE_END_TAB,
    ].sort())
    expect([...handlers.keys()].every((c) => c.startsWith('machines:remote:'))).toBe(true)
  })
})

describe('who may ask', () => {
  it('the state, asked by anything but the app window\'s main frame, is not available and shows no machine or candidate', async () => {
    register()
    const w = watch()
    for (const stranger of strangers) {
      const s = (await handlers.get(IPC.MACHINES_REMOTE_STATE)!(stranger)) as RemoteMachinesState
      expect(s.available).toBe(false)
      expect(s.machines).toEqual([])
      expect(s.candidates).toEqual([])
    }
    expect(w.views).not.toHaveBeenCalled()
    expect(w.candidates).not.toHaveBeenCalled()
    // The app's own window is shown both.
    const own = (await call(IPC.MACHINES_REMOTE_STATE)) as RemoteMachinesState
    expect(own.available).toBe(true)
    expect(own.machines.map((m) => m.did)).toEqual([DID])
    expect(own.candidates.map((c) => c.configId)).toEqual(['cfg-key'])
  })

  it('prepare, add, check and remove, asked by anything else, answer that only the app window can ask, and start no ssh', async () => {
    register()
    const w = watch()
    for (const stranger of strangers) {
      expect(await handlers.get(IPC.MACHINES_REMOTE_PREPARE)!(stranger, 'cfg-key')).toEqual({ ok: false, message: MACHINES_NOT_APP })
      expect(await handlers.get(IPC.MACHINES_REMOTE_ADD)!(stranger, TOKEN)).toEqual({ ok: false, message: MACHINES_NOT_APP })
      expect(await handlers.get(IPC.MACHINES_REMOTE_CHECK)!(stranger, DID)).toEqual({ ok: false, message: MACHINES_NOT_APP })
      expect(await handlers.get(IPC.MACHINES_REMOTE_REMOVE)!(stranger, DID)).toEqual({ ok: false, message: MACHINES_NOT_APP })
    }
    expect(w.prepare).not.toHaveBeenCalled()
    expect(w.add).not.toHaveBeenCalled()
    expect(w.check).not.toHaveBeenCalled()
    expect(w.remove).not.toHaveBeenCalled()
    expect(ssh.calls).toHaveLength(0)
  })

  it('refuses every action while there is no window', async () => {
    registerRemoteMachinesHandlers(() => null, 'win32')
    const w = watch()
    expect(await call(IPC.MACHINES_REMOTE_CHECK, DID)).toEqual({ ok: false, message: MACHINES_NOT_APP })
    expect(await call(IPC.MACHINES_REMOTE_REMOVE, DID)).toEqual({ ok: false, message: MACHINES_NOT_APP })
    expect(((await call(IPC.MACHINES_REMOTE_STATE)) as RemoteMachinesState).machines).toEqual([])
    expect(w.check).not.toHaveBeenCalled()
    expect(w.remove).not.toHaveBeenCalled()
    expect(ssh.calls).toHaveLength(0)
  })
})

describe('what each door takes', () => {
  it('a config id, token or device id that breaks its pattern is refused before the machine list is asked', async () => {
    register()
    const w = watch()
    for (const id of [undefined, null, 42, {}, '', 'a b', '../x', 'cfg;rm', 'cfg\n', 'x'.repeat(129)]) {
      expect(await call(IPC.MACHINES_REMOTE_PREPARE, id), `prepare ${JSON.stringify(id)}`).toEqual({ ok: false, message: 'That is not a saved config this computer has.' })
    }
    for (const token of [undefined, 7, '', 'c'.repeat(31), 'c'.repeat(33), 'C'.repeat(32), 'g'.repeat(32), `${'c'.repeat(31)}\n`]) {
      expect(await call(IPC.MACHINES_REMOTE_ADD, token), `add ${JSON.stringify(token)}`).toEqual({ ok: false, message: 'Nothing was sent: the question was not answered.' })
    }
    for (const did of [undefined, 7, '', 'ABC', DID.toUpperCase(), `${DID}0`, DID.slice(1), '../x', `${DID.slice(1)}\n`]) {
      expect(await call(IPC.MACHINES_REMOTE_CHECK, did), `check ${JSON.stringify(did)}`).toEqual({ ok: false, message: 'That machine is not on this computer\'s list.' })
      expect(await call(IPC.MACHINES_REMOTE_REMOVE, did), `remove ${JSON.stringify(did)}`).toEqual({ ok: false, message: 'That machine is not on this computer\'s list.' })
    }
    expect(w.prepare).not.toHaveBeenCalled()
    expect(w.add).not.toHaveBeenCalled()
    expect(w.check).not.toHaveBeenCalled()
    expect(w.remove).not.toHaveBeenCalled()
    expect(ssh.calls).toHaveLength(0)
  })

  it('well-formed values reach the machine list', async () => {
    register()
    const w = watch()
    expect((await call(IPC.MACHINES_REMOTE_PREPARE, 'cfg-key')).ok).toBe(true)
    await call(IPC.MACHINES_REMOTE_ADD, TOKEN)
    await call(IPC.MACHINES_REMOTE_CHECK, DID)
    expect(w.prepare).toHaveBeenCalledWith(CONFIGS, 'cfg-key')
    expect(w.add).toHaveBeenCalledWith(TOKEN)
    expect(w.check).toHaveBeenCalledWith(DID)
  })
})

describe('Windows only', () => {
  it('elsewhere every action says it is not available, the state shows nothing, and the PTY manager is not plugged in', async () => {
    register('darwin')
    const w = watch()
    expect(await call(IPC.MACHINES_REMOTE_PREPARE, 'cfg-key')).toEqual({ ok: false, message: REMOTE_NOT_AVAILABLE })
    expect(await call(IPC.MACHINES_REMOTE_ADD, TOKEN)).toEqual({ ok: false, message: REMOTE_NOT_AVAILABLE })
    expect(await call(IPC.MACHINES_REMOTE_CHECK, DID)).toEqual({ ok: false, message: REMOTE_NOT_AVAILABLE })
    expect(await call(IPC.MACHINES_REMOTE_REMOVE, DID)).toEqual({ ok: false, message: REMOTE_NOT_AVAILABLE })
    const s = (await call(IPC.MACHINES_REMOTE_STATE)) as RemoteMachinesState
    expect(s).toMatchObject({ available: false, machines: [], candidates: [], bundled: { ok: false, why: REMOTE_NOT_AVAILABLE } })
    expect(deps).toEqual([])
    expect(Object.values(w).every((s) => s.mock.calls.length === 0)).toBe(true)
    expect(ssh.calls).toHaveLength(0)
  })

  it('on Windows the PTY manager is plugged in once; its settings() reads the saved settings at each spawn, and the state\'s switch follows them', async () => {
    register('win32')
    expect(deps).toHaveLength(1)
    const d = deps[0]
    expect(d.platform).toBe('win32')
    expect(d.runner).toBe(ssh)
    expect(d.machines).toBeInstanceOf(RemoteMachines)
    expect(typeof d.systemPrefersDark).toBe('function')
    // What a tab through the helper was sent reaches the PTY integrity count, as every other tab's output does.
    expect(typeof d.onOutput).toBe('function')
    const recordPtyData = vi.fn()
    setPtyIntegrityMonitor({ recordPtyData } as never)
    try {
      d.onOutput('tab-remote', 12)
    } finally {
      setPtyIntegrityMonitor(null)
    }
    expect(recordPtyData).toHaveBeenCalledWith('tab-remote', 12)
    // With no monitor, nothing throws.
    expect(() => d.onOutput('tab-remote', 3)).not.toThrow()
    h.settings = { remoteSessionsThroughHelper: true, theme: 'light' }
    expect(d.settings()).toEqual({ remoteSessionsThroughHelper: true, theme: 'light' })
    expect(((await call(IPC.MACHINES_REMOTE_STATE)) as RemoteMachinesState).switchOn).toBe(true)
    h.settings = {}
    expect(d.settings()).toEqual({})
    expect(((await call(IPC.MACHINES_REMOTE_STATE)) as RemoteMachinesState).switchOn).toBe(false)
    h.settings = { remoteSessionsThroughHelper: 'yes' }
    expect(((await call(IPC.MACHINES_REMOTE_STATE)) as RemoteMachinesState).switchOn).toBe(false)
  })
})

describe('the cards', () => {
  it('read this build\'s helper hash: a machine holding another reads not checked, with the line that Check updates it', async () => {
    h.stored = { v: 1, installId: 'f'.repeat(32), machines: [record('b'.repeat(64))] }
    register()
    const s = (await call(IPC.MACHINES_REMOTE_STATE)) as RemoteMachinesState
    expect(s.machines[0]).toMatchObject({ did: DID, checked: false, lastCheck: { ok: false, detail: REMOTE_OTHER_HELPER } })
    h.stored = { v: 1, installId: 'f'.repeat(32), machines: [record()] }
    expect(((await call(IPC.MACHINES_REMOTE_STATE)) as RemoteMachinesState).machines[0]).toMatchObject({ checked: true })
  })

  it('a records file that does not read: the section stays and says so, Add is off, and the file is not written', async () => {
    const kept = { installId: 'not an install id', machines: 'not a list' }
    h.stored = kept
    register()
    const s = (await call(IPC.MACHINES_REMOTE_STATE)) as RemoteMachinesState
    expect(s).toEqual({ available: true, switchOn: true, bundled: { ok: false, why: REMOTE_STATE_UNREAD }, machines: [], candidates: [] })
    expect(h.stored).toBe(kept)
    // Each action refuses, and none writes the file or starts an ssh.
    expect((await call(IPC.MACHINES_REMOTE_PREPARE, 'cfg-key')).ok).toBe(false)
    expect((await call(IPC.MACHINES_REMOTE_CHECK, DID)).ok).toBe(false)
    expect((await call(IPC.MACHINES_REMOTE_REMOVE, DID)).ok).toBe(false)
    expect(h.stored).toBe(kept)
    expect(ssh.calls).toHaveLength(0)
  })
})
