/**
 * An SSH Persistent tab in the PTY manager's SSH branch (plan 2.1.3-beta.19
 * section 1.2; aicc_planning#437; D13), with node-pty's spawn captured as
 * pty-manager-route.test.ts captures it:
 *
 * - switch on, a new SSH Persistent tab on a machine whose logind does not
 *   end processes at logout goes through the helper, kept until it is ended;
 * - switch on, the usual path (node-pty with exactly the arguments it gets
 *   with no remote helper) for: a restored SSH Persistent tab with no mark, a
 *   Restart of a tab on the usual path, a new tab of a config with an open
 *   tab on the usual path, and a config with a left-running tmux entry;
 * - a marked tab with another helper, a failed Check or the switch off starts
 *   nothing: no node-pty (no tmux), no hold, and its note says the step;
 * - switch off: for every unmarked config, plain and persistent, node-pty
 *   gets cc36c7f3's file, argv and options (those it gets with no remote
 *   helper), and no ssh exec runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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
import { spawnPty } from '../../../src/main/pty-manager'
import { registerProvider } from '../../../src/main/providers'
import { setRemoteHelperDeps, forgetRemoteHelperTab, noteRestoredRemoteTabs, isRemoteHelperTab } from '../../../src/main/remote-helper'
import { claudeRemoteLaunch } from '../../../src/main/providers/claude/remote-launch'
import { ROUTE_WHY, MARKED_STEP } from '../../../src/main/remote-helper/route'
import type { RemoteMachineRecord, RemoteMachines } from '../../../src/main/remote-helper/machines'
import type { SSHOptions } from '../../../src/main/ssh-options'
import type { DetachedRemote } from '../../../src/shared/types'
import { CLAUDE_RUN_SCREEN } from '../../../src/main/providers/claude/run-screen'
import { FakeSsh } from './fake-ssh'

const fakeProvider = {
  id: 'claude', displayName: 'Claude', resolveBinary: () => null, buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
  detectUiRunning: () => false, ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {}, getSshSettingsPath: () => '', getSshMcpConfigPath: () => '', configureRemoteSettings: () => '',
  remoteLaunch: claudeRemoteLaunch,
  runScreen: CLAUDE_RUN_SCREEN,
} as unknown as SessionProvider

let shown = new Map<string, string>()
const win = { webContents: { send(ch: string, d: unknown) { const m = /^pty:data:(.+)$/.exec(ch); if (m) shown.set(m[1], (shown.get(m[1]) ?? '') + String(d)) } }, isDestroyed: () => false } as never

const SHA = 'a'.repeat(64)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'ubuntu.lan', port: 22, user: 'nick', label: 'Ubuntu', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/usr/local/bin/claude',
  path: '/usr/local/bin:/usr/bin:/bin', lang: null, helper: { version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
  logind: { kill: 'no', exclude: 'root', linger: 'no' },
}
const PERSISTENT: SSHOptions = { host: 'ubuntu.lan', port: 22, username: 'nick', remotePath: '~' }
const PLAIN: SSHOptions = { ...PERSISTENT, detachable: false }

let logs: string[] = []
let ssh: FakeSsh
let registry: DetachedRemote[] = []

function plugIn(switchOn: boolean, machine: RemoteMachineRecord = MACHINE): void {
  ssh = new FakeSsh({ answer: () => ({ code: 255, stderr: 'Connection refused' }) })
  setRemoteHelperDeps({
    platform: 'win32',
    settings: () => ({ remoteSessionsThroughHelper: switchOn }),
    machines: { findByTarget: () => machine, installId: () => 'f'.repeat(32) } as unknown as RemoteMachines,
    runner: ssh,
    bundledSha256: () => SHA,
    systemPrefersDark: () => true,
    onOutput: () => {},
    log: (m) => logs.push(m),
    registry: () => registry,
  })
}

function spawnSsh(id: string, s: SSHOptions, extra: Record<string, unknown> = {}) {
  captured = null
  try {
    spawnPty(win, id, { ssh: s, cols: 100, rows: 30, ...extra })
  } catch (err) {
    if ((err as Error).message !== '__spawn_captured__') throw err
  }
  return captured
}

/** What node-pty gets for this tab with no remote helper at all. */
function usualOf(id: string, s: SSHOptions, extra: Record<string, unknown> = {}) {
  setRemoteHelperDeps(null)
  const before = spawnSsh(id, s, extra)
  expect(before, 'the usual path reached node-pty').not.toBeNull()
  return before
}

async function until(ok: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const tmuxEntry = (o: Partial<DetachedRemote>): DetachedRemote => ({ sessionId: 'left-1', configId: 'cfg-ubuntu', host: 'ubuntu.lan', username: 'nick', remotePath: '~', port: 22, mux: 'tmux', label: 'Ubuntu', detachedAt: 1, ...o })

beforeEach(() => {
  logs = []
  shown = new Map()
  registry = []
  registerProvider(fakeProvider)
})
afterEach(() => setRemoteHelperDeps(null))

describe('switch on: an SSH Persistent tab', () => {
  it('a new one goes through the helper, kept until it is ended: no node-pty, a hold of the until-ended kind', async () => {
    forgetRemoteHelperTab('psr-new')
    plugIn(true)
    ssh.host = { answer: (c) => (c.script === 'reads' ? { stdout: `AICC-RESULT ${c.values[0]} end ok\n` } : { code: 255, stderr: 'Connection refused' }) }
    expect(spawnSsh('psr-new', PERSISTENT, { configId: 'cfg-ubuntu' })).toBeNull()
    await until(() => ssh.calls.some((c) => c.script === 'hold'))
    expect(ssh.calls.find((c) => c.script === 'hold')!.values.at(-1)).toBe('until-ended')
    expect(isRemoteHelperTab('psr-new')).toBe(true)
    forgetRemoteHelperTab('psr-new')
  })

  it('a restored one with no mark takes the usual path (every tab saved before beta.19 reads as tmux)', () => {
    forgetRemoteHelperTab('psr-restored')
    const before = usualOf('psr-restored', PERSISTENT, { configId: 'cfg-ubuntu' })
    plugIn(true)
    noteRestoredRemoteTabs(['psr-restored'])
    expect(spawnSsh('psr-restored', PERSISTENT, { configId: 'cfg-ubuntu' })).toEqual(before)
    expect(ssh.calls).toHaveLength(0)
    expect(logs).toContain(`[remote-helper] psr-restored: the usual SSH path, because ${ROUTE_WHY.sessionUnderTmux}`)
    forgetRemoteHelperTab('psr-restored')
  })

  it('a Restart of a tab on the usual path stays on the usual path, also once its config has nothing else under tmux', () => {
    forgetRemoteHelperTab('psr-restart')
    const before = usualOf('psr-restart', PERSISTENT, { configId: 'cfg-ubuntu' })
    plugIn(true)
    registry = [tmuxEntry({})]
    expect(spawnSsh('psr-restart', PERSISTENT, { configId: 'cfg-ubuntu' })).toEqual(before)
    // The Restart: the kill door keeps its path; the entry is gone meanwhile.
    forgetRemoteHelperTab('psr-restart', true)
    registry = []
    logs = []
    expect(spawnSsh('psr-restart', PERSISTENT, { configId: 'cfg-ubuntu' })).toEqual(before)
    expect(ssh.calls).toHaveLength(0)
    expect(logs).toContain(`[remote-helper] psr-restart: the usual SSH path, because ${ROUTE_WHY.sessionUnderTmux}`)
    forgetRemoteHelperTab('psr-restart')
  })

  it('a new tab of a config with an open tab on the usual path takes the usual path too (one config, one path)', () => {
    forgetRemoteHelperTab('psr-open-a')
    forgetRemoteHelperTab('psr-open-b')
    const before = usualOf('psr-open-b', PERSISTENT, { configId: 'cfg-ubuntu' })
    plugIn(true)
    noteRestoredRemoteTabs(['psr-open-a'])
    expect(spawnSsh('psr-open-a', PERSISTENT, { configId: 'cfg-ubuntu' })).not.toBeNull()
    logs = []
    expect(spawnSsh('psr-open-b', PERSISTENT, { configId: 'cfg-ubuntu' })).toEqual(before)
    expect(logs).toContain(`[remote-helper] psr-open-b: the usual SSH path, because ${ROUTE_WHY.configUnderTmux}`)
    // Once that tab is closed, a new tab of the config goes through the helper.
    forgetRemoteHelperTab('psr-open-a')
    forgetRemoteHelperTab('psr-open-b')
    expect(spawnSsh('psr-open-c', PERSISTENT, { configId: 'cfg-ubuntu' })).toBeNull()
    forgetRemoteHelperTab('psr-open-c')
  })

  const entries: Array<[string, DetachedRemote]> = [
    ['by its config id', tmuxEntry({})],
    ['by its host, user and port (an entry with no config id)', tmuxEntry({ configId: undefined })],
    ['from before the mux field had another value (psmux counts as not the helper\'s)', tmuxEntry({ mux: 'psmux' })],
  ]
  for (const [name, entry] of entries) {
    it(`a config with a left-running tmux entry, ${name}, takes the usual path`, () => {
      forgetRemoteHelperTab('psr-entry')
      const before = usualOf('psr-entry', PERSISTENT, { configId: 'cfg-ubuntu' })
      plugIn(true)
      registry = [entry]
      expect(spawnSsh('psr-entry', PERSISTENT, { configId: 'cfg-ubuntu' })).toEqual(before)
      expect(logs).toContain(`[remote-helper] psr-entry: the usual SSH path, because ${ROUTE_WHY.configUnderTmux}`)
      forgetRemoteHelperTab('psr-entry')
    })
  }

  it('a helper entry for the config does not count as tmux', () => {
    forgetRemoteHelperTab('psr-helper-entry')
    plugIn(true)
    registry = [tmuxEntry({ mux: 'helper', did: MACHINE.did })]
    expect(spawnSsh('psr-helper-entry', PERSISTENT, { configId: 'cfg-ubuntu' })).toBeNull()
    forgetRemoteHelperTab('psr-helper-entry')
  })
})

describe('a marked tab never starts on the usual path', () => {
  const cases: Array<[string, boolean, RemoteMachineRecord, string, string]> = [
    ['another helper hash on its machine', true, { ...MACHINE, helper: { ...MACHINE.helper, sha256: 'b'.repeat(64) } }, ROUTE_WHY.oldHelper, MARKED_STEP.check],
    ['a failed Check', true, { ...MACHINE, check: { at: 1, ok: false, detail: 'x' } }, ROUTE_WHY.notChecked, MARKED_STEP.check],
    ['the switch off', false, MACHINE, ROUTE_WHY.off, MARKED_STEP.switchOff],
  ]
  for (const [name, switchOn, machine, why, step] of cases) {
    it(`${name}: nothing starts (no node-pty, so no tmux; no hold), and the tab says the step`, async () => {
      forgetRemoteHelperTab('psr-marked')
      plugIn(switchOn, machine)
      expect(spawnSsh('psr-marked', PERSISTENT, { configId: 'cfg-ubuntu', remoteVia: 'helper' })).toBeNull()
      expect(ssh.calls).toHaveLength(0)
      expect(logs).toContain(`[remote-helper] psr-marked: nothing started, because its session is kept by the session helper and ${why}`)
      expect(logs.some((l) => l.includes('the usual SSH path'))).toBe(false)
      await until(() => (shown.get('psr-marked') ?? '').includes(step))
      expect(shown.get('psr-marked')).toContain(why)
      forgetRemoteHelperTab('psr-marked')
    })
  }
})

describe('switch off: unmarked configs, plain and persistent, take cc36c7f3\'s spawn exactly', () => {
  const table: Array<[string, SSHOptions, Record<string, unknown>]> = [
    ['plain SSH', PLAIN, {}],
    ['SSH Persistent, never chose', PERSISTENT, { configId: 'cfg-ubuntu' }],
    ['SSH Persistent, chose it', { ...PERSISTENT, detachable: true }, { configId: 'cfg-ubuntu' }],
    ['SSH Persistent with a post-connect command', { ...PERSISTENT, postCommand: 'cd /srv' }, {}],
    ['SSH Persistent, a reconnect', { ...PERSISTENT, reconnect: true }, { configId: 'cfg-ubuntu' }],
    ['a container', { ...PERSISTENT, runtime: { type: 'container', container: 'dev' } }, {}],
  ]
  for (const [name, s, extra] of table) {
    it(`${name}: node-pty gets the same file, argv and options as with no remote helper, and no ssh exec runs`, () => {
      forgetRemoteHelperTab('psr-off')
      const before = usualOf('psr-off', s, extra)
      plugIn(false)
      registry = [tmuxEntry({})]
      expect(spawnSsh('psr-off', s, extra)).toEqual(before)
      expect(ssh.calls).toHaveLength(0)
      expect(logs).toContain(`[remote-helper] psr-off: the usual SSH path, because ${ROUTE_WHY.off}`)
      forgetRemoteHelperTab('psr-off')
    })
  }
})
