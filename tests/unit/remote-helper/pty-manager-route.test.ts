/**
 * Remote step 1's one entry in the PTY manager (plan 2.1.3-beta.17, section
 * A2; aicc_planning#411): the real spawnPty SSH branch, with node-pty's spawn
 * captured (it throws once it has the argv, as ssh-spawn-callsite.test.ts
 * does). Every SSH tab that does not go through the session helper (the
 * switch off, SSH Persistent, a container, a post-connect command, a password
 * sign-in, a machine not added or not checked) reaches node-pty with exactly
 * the file, argv and options it gets with no remote helper at all, and one
 * log line says why; a tab that does go through it starts no node-pty and
 * asks its machine for a holder. pty-manager.ts stays at or under its cap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, platform: vi.fn(() => 'win32') }
})

let captured: { file: string; args: string[]; opts: Record<string, unknown> } | null = null
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
    captured = { file, args, opts }
    throw new Error('__spawn_captured__')
  },
}))
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  return {
    ...real,
    findOnWindowsPath: (...a: Parameters<typeof real.findOnWindowsPath>) => (a[0][0] === 'ssh.exe' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : real.findOnWindowsPath(...a)),
  }
})

import type { SessionProvider } from '../../../src/main/providers/types'
import { spawnPty, killPty } from '../../../src/main/pty-manager'
import { registerProvider } from '../../../src/main/providers'
import { setRemoteHelperDeps, isRemoteHelperTab } from '../../../src/main/remote-helper'
import { ROUTE_WHY } from '../../../src/main/remote-helper/route'
import type { RemoteMachineRecord, RemoteMachines } from '../../../src/main/remote-helper/machines'
import type { SSHOptions } from '../../../src/main/ssh-options'
import { FakeSsh } from './fake-ssh'

const fakeProvider = {
  id: 'claude', displayName: 'Claude', resolveBinary: () => null, buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
  detectUiRunning: () => false, ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {}, getSshSettingsPath: () => '', getSshMcpConfigPath: () => '', configureRemoteSettings: () => '',
} as unknown as SessionProvider
const win = { webContents: { send() {} }, isDestroyed: () => false } as never

const SHA = 'a'.repeat(64)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/usr/local/bin/claude',
  path: '/usr/local/bin:/usr/bin:/bin', lang: null, helper: { version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
}
const SSH_TAB: SSHOptions = { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~', detachable: false }

let logs: string[] = []
let ssh: FakeSsh
function plugIn(switchOn: boolean, machine: RemoteMachineRecord | null = MACHINE): void {
  ssh = new FakeSsh({ answer: () => ({ code: 255, stderr: 'Connection refused' }) })
  setRemoteHelperDeps({
    platform: 'win32',
    settings: () => ({ remoteSessionsThroughHelper: switchOn }),
    machines: { findByTarget: () => machine ?? undefined, installId: () => 'f'.repeat(32) } as unknown as RemoteMachines,
    runner: ssh,
    bundledSha256: () => SHA,
    log: (m) => logs.push(m),
  })
}

/** What node-pty got for this spawn: its file, argv and options. */
function spawnSsh(id: string, ssh: SSHOptions, extra: Record<string, unknown> = {}) {
  captured = null
  try {
    spawnPty(win, id, { ssh, cols: 100, rows: 30, ...extra })
  } catch (err) {
    if ((err as Error).message !== '__spawn_captured__') throw err
  }
  return captured
}

beforeEach(() => {
  logs = []
  registerProvider(fakeProvider)
})
afterEach(() => setRemoteHelperDeps(null))

describe('pty-manager SSH branch: the usual path is unchanged for every tab that does not go through the session helper', () => {
  const cases: Array<[string, SSHOptions, boolean, RemoteMachineRecord | null, string]> = [
    ['the switch off', SSH_TAB, false, MACHINE, ROUTE_WHY.off],
    ['SSH Persistent (no detachable value)', { ...SSH_TAB, detachable: undefined }, true, MACHINE, ROUTE_WHY.persistent],
    ['SSH Persistent (detachable true)', { ...SSH_TAB, detachable: true }, true, MACHINE, ROUTE_WHY.persistent],
    ['a container', { ...SSH_TAB, runtime: { type: 'container', container: 'dev' } }, true, MACHINE, ROUTE_WHY.container],
    ['a legacy docker post-command', { ...SSH_TAB, postCommand: 'sudo docker exec -it dev bash' }, true, MACHINE, ROUTE_WHY.container],
    ['a post-connect command', { ...SSH_TAB, postCommand: 'cd /srv && source env' }, true, MACHINE, ROUTE_WHY.postCommand],
    ['a password sign-in', { ...SSH_TAB, password: 'pw' }, true, MACHINE, ROUTE_WHY.password],
    ['a Windows host', { ...SSH_TAB, remoteOs: 'windows' }, true, MACHINE, ROUTE_WHY.windowsHost],
    ['a machine not added', SSH_TAB, true, null, ROUTE_WHY.notAdded],
    ['a machine not checked', SSH_TAB, true, { ...MACHINE, check: { at: 1, ok: false, detail: 'x' } }, ROUTE_WHY.notChecked],
    ['a machine with another helper', SSH_TAB, true, { ...MACHINE, helper: { ...MACHINE.helper, sha256: 'b'.repeat(64) } }, ROUTE_WHY.oldHelper],
  ]

  for (const [name, tab, switchOn, machine, why] of cases) {
    it(`${name}: node-pty gets the same file, argv and options as with no remote helper, and the log says why`, () => {
      setRemoteHelperDeps(null)
      const before = spawnSsh('route-plain', tab)
      expect(before, 'the usual path reached node-pty').not.toBeNull()
      plugIn(switchOn, machine)
      const after = spawnSsh('route-plain', tab)
      expect(after).toEqual(before)
      expect(ssh.calls).toHaveLength(0)
      expect(logs).toContain(`[remote-helper] route-plain: the usual SSH path, because ${why}`)
      expect(isRemoteHelperTab('route-plain')).toBe(false)
    })
  }

  it('a Terminal only tab takes the usual path too', () => {
    plugIn(true)
    expect(spawnSsh('route-shell', SSH_TAB, { shellOnly: true })).not.toBeNull()
    expect(logs).toContain(`[remote-helper] route-shell: the usual SSH path, because ${ROUTE_WHY.shellOnly}`)
  })
})

describe('pty-manager SSH branch: a tab that goes through the session helper', () => {
  it('starts no node-pty, asks its machine for a holder by one exec, and ends with its tab', async () => {
    plugIn(true)
    const got = spawnSsh('route-helper', SSH_TAB)
    expect(got).toBeNull()
    expect(isRemoteHelperTab('route-helper')).toBe(true)
    expect(logs.some((l) => l.startsWith('[remote-helper] route-helper: through the session helper on nick@rocky.lan:22'))).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(ssh.scripts()[0]).toBe('hold')
    killPty('route-helper')
    expect(isRemoteHelperTab('route-helper')).toBe(false)
  })
})

describe('pty-manager.ts: one entry, at the top of the SSH branch, and the cap', () => {
  const src = readFileSync(resolve(__dirname, '../../../src/main/pty-manager.ts'), 'utf8').replace(/\r\n/g, '\n')

  it('asks remoteHelperPty once, after the branch refuses a provider SSH does not run, and before anything of the usual path', () => {
    expect(src.match(/remoteHelperPty\(/g)).toHaveLength(1)
    const branch = src.indexOf('  sshBranch: if (options?.ssh) {\n')
    const refusal = src.indexOf("it is not available in SSH sessions. Switch the session to local or pick the Claude provider.", branch)
    const ask = src.indexOf('    const viaHelper = remoteHelperPty(win, sessionId, options, cols, rows)\n    if (viaHelper) { ptyProcess = viaHelper; break sshBranch }\n', branch)
    const usual = src.indexOf('    const sshBin = sshProgram()', branch)
    expect(branch).toBeGreaterThan(0)
    expect(refusal).toBeGreaterThan(branch)
    expect(ask).toBeGreaterThan(refusal)
    expect(usual).toBeGreaterThan(ask)
    expect(src.match(/break sshBranch/g)).toHaveLength(1)
  })

  it('is at or under its cap of 7,773 lines (scripts/ci/pr-numbers.mjs)', () => {
    const lines = readFileSync(resolve(__dirname, '../../../src/main/pty-manager.ts'), 'utf8').split('\n').length - 1
    expect(lines).toBeLessThanOrEqual(7773)
    expect(readFileSync(resolve(__dirname, '../../../scripts/ci/pr-numbers.mjs'), 'utf8')).toContain('7773')
  })
})
