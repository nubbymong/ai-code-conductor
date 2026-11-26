// The Machines page's remote doors with two Linux helpers (2.1.3-beta.19,
// section 1.3; aicc_planning#438): the routing's hash and the cards each read
// the manifest entry of the machine's own architecture, from the real files a
// dev run reads (a temporary folder as the app's folder), with the writer's own
// manifest. An aarch64 machine holding the arm64 entry's hash reads this
// build's helper and its tabs are compared with that entry; one holding the
// x86-64 entry's reads another helper. The state lists both files.
//
// PURE: ipcMain is the shared mock; the records file is in memory and ssh is
// a fake one. The helper files and the manifest are real, in a temp folder.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { app, ipcMain } from 'electron'
import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { IPC } from '../../../src/shared/ipc-channels'
import { REMOTE_OTHER_HELPER, type RemoteMachinesState } from '../../../src/shared/remote-machines'
import { helperManifest } from '../../../scripts/write-helper-manifest.mjs'
import { LINUX_ARM64_HELPER_SOURCE, LINUX_HELPER_SOURCE, MANIFEST_SOURCE } from '../../../scripts/verify-bundled-helper.mjs'
import { buildElf } from '../scripts/elf-image'
import { FakeSsh } from '../remote-helper/fake-ssh'

const h = vi.hoisted(() => ({
  configs: [] as unknown[],
  stored: null as unknown,
  ssh: null as unknown,
  setDeps: (() => {}) as (d: unknown) => void,
}))

vi.mock('../../../src/main/config-manager', () => ({
  readConfig: (name: string) => (name === 'settings' ? { remoteSessionsThroughHelper: true } : name === 'configs' ? h.configs : null),
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

const { registerRemoteMachinesHandlers } = await import('../../../src/main/ipc/remote-machines-handlers')

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>
const handlers = new Map<string, Handler>()
const frame = { id: 'main-frame' }
const webContents = { mainFrame: frame }
const win = { isDestroyed: () => false, webContents } as any
const appEvent = { sender: webContents, senderFrame: frame }
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(appEvent, ...args)

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const X64 = buildElf({ body: [1, 2, 3, 4] })
const ARM = buildElf({ machine: 183, body: [5, 6, 7, 8] })
const VERSION = '0.1.0'
const CARGO = `[package]\nname = "aicc-helper"\nversion = "${VERSION}"\n`

const record = (did: string, arch: string, sha256: string) => ({
  did, host: `${did.slice(0, 4)}.lan`, port: 22, user: 'dev', label: arch, addedAt: 1, os: 'Linux', arch,
  home: '/home/dev', shell: '/bin/bash', shellIsSh: true, claudePath: '/usr/bin/claude', path: '/usr/bin:/bin', lang: null,
  helper: { version: VERSION, sha256, folder: `${VERSION}-${sha256.slice(0, 12)}` }, check: { at: 1, ok: true },
})
const ARM_DID = 'a'.repeat(32)
const X64_DID = 'b'.repeat(32)

let root = ''
let deps: Array<Record<string, any>> = []

function put(file: string, bytes: Buffer | string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, bytes)
}

beforeEach(() => {
  handlers.clear()
  vi.mocked(ipcMain.handle).mockReset()
  vi.mocked(ipcMain.handle).mockImplementation(((channel: string, fn: Handler) => { handlers.set(channel, fn) }) as any)
  root = mkdtempSync(join(tmpdir(), 'aicc-remote-arch-'))
  // A dev run reads the helpers and the manifest under the app's folder.
  vi.mocked(app.getAppPath).mockReturnValue(root)
  put(join(root, ...LINUX_HELPER_SOURCE.split('/')), X64)
  put(join(root, ...LINUX_ARM64_HELPER_SOURCE.split('/')), ARM)
  const made = helperManifest({ [LINUX_HELPER_SOURCE]: X64, [LINUX_ARM64_HELPER_SOURCE]: ARM }, CARGO)
  expect(made.problems).toEqual([])
  put(join(root, ...MANIFEST_SOURCE.split('/')), made.text!)
  h.configs = []
  h.stored = { v: 1, installId: 'f'.repeat(32), machines: [record(ARM_DID, 'aarch64', sha(ARM)), record(X64_DID, 'x86_64', sha(X64))] }
  h.ssh = new FakeSsh({ answer: () => ({ code: 255, stderr: 'Connection refused' }) })
  deps = []
  h.setDeps = (d) => { deps.push(d as Record<string, any>) }
})
afterEach(() => {
  vi.restoreAllMocks()
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

describe('two Linux helpers: each machine is compared with its own architecture\'s entry', () => {
  it('the routing\'s hash: aarch64 reads the arm64 entry, x86_64 the x86-64 one, any other none', () => {
    registerRemoteMachinesHandlers(() => win, 'win32')
    expect(deps).toHaveLength(1)
    const bundledSha256 = deps[0].bundledSha256 as (arch: string) => string | null
    expect(bundledSha256('aarch64')).toBe(sha(ARM))
    expect(bundledSha256('x86_64')).toBe(sha(X64))
    for (const arch of ['armv7l', 'arm64', 'linux-arm64/aicc-helper', '']) expect(bundledSha256(arch), arch).toBeNull()
  })

  it('the cards: an aarch64 machine holding the arm64 entry\'s hash reads this build\'s helper; holding the x86-64 entry\'s it reads another', async () => {
    registerRemoteMachinesHandlers(() => win, 'win32')
    const s = (await call(IPC.MACHINES_REMOTE_STATE)) as RemoteMachinesState
    expect(s.machines.map((m) => [m.did, m.checked, m.system])).toEqual([[ARM_DID, true, 'Linux aarch64'], [X64_DID, true, 'Linux x86_64']])
    expect(s.bundled).toEqual({ ok: true, version: VERSION, files: [{ arch: 'x86_64', size: X64.length, sha12: sha(X64).slice(0, 12) }, { arch: 'aarch64', size: ARM.length, sha12: sha(ARM).slice(0, 12) }] })
    h.stored = { v: 1, installId: 'f'.repeat(32), machines: [record(ARM_DID, 'aarch64', sha(X64)), record(X64_DID, 'x86_64', sha(ARM))] }
    const t = (await call(IPC.MACHINES_REMOTE_STATE)) as RemoteMachinesState
    for (const m of t.machines) expect(m, m.did).toMatchObject({ checked: false, lastCheck: { ok: false, detail: REMOTE_OTHER_HELPER } })
  })
})
