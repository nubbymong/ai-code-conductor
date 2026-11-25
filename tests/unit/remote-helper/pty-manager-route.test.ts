/**
 * Remote step 1's one entry in the PTY manager (plan 2.1.3-beta.17, section
 * A2; aicc_planning#411): the real spawnPty SSH branch, with node-pty's spawn
 * captured (it throws once it has the argv, as ssh-spawn-callsite.test.ts
 * does). Every SSH tab that does not go through the session helper (the
 * switch off, SSH Persistent, a container, a post-connect command, a password
 * sign-in, a machine not added or not checked) reaches node-pty with exactly
 * the file, argv and options it gets with no remote helper at all, and one
 * log line says why; a tab that does go through it starts no node-pty and
 * asks its machine for a holder. The switch is off unless saved exactly true,
 * and while it is off nothing else of the feature is asked; records that do
 * not read send a tab the usual way and are not written over. A tab through
 * the helper tells its SSH flow overlay at once, keeps no SSH flow after a
 * start that failed, and what it is sent reaches the PTY integrity count. The
 * launch carries the app's light or dark scheme. pty-manager.ts stays at or
 * under its cap (PTY_MANAGER_LINE_CAP, read from pr-numbers.mjs).
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

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SessionProvider } from '../../../src/main/providers/types'
import { spawnPty, killPty, writePty, getSshFlow } from '../../../src/main/pty-manager'
import { submitPrompt } from '../../../src/main/session-input'
import { registerProvider } from '../../../src/main/providers'
import { setRemoteHelperDeps, isRemoteHelperTab, forgetRemoteHelperTab, remoteTabsOn, remoteTerminalEnv, type RemoteSignalDeps } from '../../../src/main/remote-helper'
import { claudeRemoteLaunch } from '../../../src/main/providers/claude/remote-launch'
import { remoteHelperCommands, remoteSessionId } from '../../../src/main/remote-helper/session'
import { result } from './fake-ssh'
import { SSH_THROUGH_HELPER } from '../../../src/shared/remote-machines'
import { FakeHolder } from '../main/session-helper-fake-holder'
import { ROUTE_WHY } from '../../../src/main/remote-helper/route'
import { RemoteMachines, type RemoteMachineRecord } from '../../../src/main/remote-helper/machines'
import type { SSHOptions } from '../../../src/main/ssh-options'
import { FakeSsh } from './fake-ssh'
// Plain ESM with main() behind an argv[1] check: importing it runs nothing.
import { PTY_MANAGER_LINE_CAP, countLines } from '../../../scripts/ci/pr-numbers.mjs'

const fakeProvider = {
  id: 'claude', displayName: 'Claude', resolveBinary: () => null, buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
  detectUiRunning: () => false, ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {}, getSshSettingsPath: () => '', getSshMcpConfigPath: () => '', configureRemoteSettings: () => '',
  // The Claude package's own remote launch (2.1.3-beta.18 section 2).
  remoteLaunch: claudeRemoteLaunch,
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
/** Each call the app's side of a helper tab got (2.1.3-beta.18 section 3.2):
 *  none on the usual path, whatever the tab. */
let signalCalls: string[] = []
const recordingSignals: RemoteSignalDeps = {
  toolsServed: () => { signalCalls.push('toolsServed'); return true },
  status: (id) => { signalCalls.push(`status ${id}`) },
  event: (id) => { signalCalls.push(`event ${id}`) },
  serve: (id) => { signalCalls.push(`serve ${id}`); return false },
}
/** What a test hands in place of the usual deps. */
interface DepsOver {
  settings?: () => Record<string, unknown> | null
  findByTarget?: () => RemoteMachineRecord | undefined
  bundledSha256?: () => string | null
  systemPrefersDark?: () => boolean
  /** The machine list itself, in place of the stub built from findByTarget. */
  machines?: RemoteMachines
  onOutput?: (sessionId: string, length: number) => void
}
function plugIn(switchOn: boolean, machine: RemoteMachineRecord | null = MACHINE, over: DepsOver = {}): void {
  ssh = new FakeSsh({ answer: () => ({ code: 255, stderr: 'Connection refused' }) })
  setRemoteHelperDeps({
    platform: 'win32',
    settings: over.settings ?? (() => ({ remoteSessionsThroughHelper: switchOn })),
    machines: over.machines ?? ({ findByTarget: over.findByTarget ?? (() => machine ?? undefined), installId: () => 'f'.repeat(32) } as unknown as RemoteMachines),
    runner: ssh,
    bundledSha256: over.bundledSha256 ?? (() => SHA),
    systemPrefersDark: over.systemPrefersDark ?? (() => true),
    onOutput: over.onOutput ?? (() => {}),
    log: (m) => logs.push(m),
    signals: recordingSignals,
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
  signalCalls = []
  registerProvider(fakeProvider)
})

async function until(ok: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
afterEach(() => setRemoteHelperDeps(null))

describe('pty-manager SSH branch: the usual path is unchanged for every tab that does not go through the session helper', () => {
  // The app's side of a helper tab is plugged in for every case (2.1.3-beta.18
  // section 3.2) and nothing of it is asked: no status line, hook event, tool
  // stream or tools question for a tab on the usual path.
  afterEach(() => { expect(signalCalls).toEqual([]) })

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

  it('a tab whose provider has no remote launch (2.1.3-beta.18 section 2): node-pty gets the same file, argv and options, and the log says why', () => {
    setRemoteHelperDeps(null)
    const before = spawnSsh('route-no-launch', SSH_TAB)
    expect(before, 'the usual path reached node-pty').not.toBeNull()
    registerProvider({ ...fakeProvider, remoteLaunch: undefined } as SessionProvider)
    plugIn(true)
    expect(spawnSsh('route-no-launch', SSH_TAB)).toEqual(before)
    expect(ssh.calls).toHaveLength(0)
    expect(logs).toContain('[remote-helper] route-no-launch: the usual SSH path, because its provider (Claude) has no launch through the session helper')
    expect(isRemoteHelperTab('route-no-launch')).toBe(false)
  })

  it('a Terminal only tab takes the usual path too', () => {
    plugIn(true)
    expect(spawnSsh('route-shell', SSH_TAB, { shellOnly: true })).not.toBeNull()
    expect(logs).toContain(`[remote-helper] route-shell: the usual SSH path, because ${ROUTE_WHY.shellOnly}`)
  })

  // Off by default: only a switch saved exactly true turns it on.
  const offBy: Array<[string, Record<string, unknown> | null]> = [
    ['settings with no value for the switch (never touched)', {}],
    ['settings that do not read', null],
  ]
  for (const [name, saved] of offBy) {
    it(`${name}: the switch is off, so node-pty gets the same file, argv and options, and no ssh starts`, () => {
      setRemoteHelperDeps(null)
      const before = spawnSsh('route-default', SSH_TAB)
      plugIn(true, MACHINE, { settings: () => saved })
      expect(spawnSsh('route-default', SSH_TAB)).toEqual(before)
      expect(ssh.calls).toHaveLength(0)
      expect(logs).toContain(`[remote-helper] route-default: the usual SSH path, because ${ROUTE_WHY.off}`)
      expect(isRemoteHelperTab('route-default')).toBe(false)
    })
  }

  it('the switch off: the machine records and the manifest are not asked for, so records that cannot be read or written fail no spawn', () => {
    setRemoteHelperDeps(null)
    const before = spawnSsh('route-off-records', SSH_TAB)
    // A records file the first read would write (no install id yet), with the file busy.
    const findByTarget = vi.fn((): RemoteMachineRecord | undefined => { throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }) })
    const bundledSha256 = vi.fn((): string | null => { throw new Error('the manifest could not be read') })
    plugIn(false, MACHINE, { findByTarget, bundledSha256 })
    expect(spawnSsh('route-off-records', SSH_TAB)).toEqual(before)
    expect(findByTarget).not.toHaveBeenCalled()
    expect(bundledSha256).not.toHaveBeenCalled()
    expect(logs).toContain(`[remote-helper] route-off-records: the usual SSH path, because ${ROUTE_WHY.off}`)
  })

  it('the switch on and records that cannot be read: the usual path, the log says why, and the records are not written over', () => {
    setRemoteHelperDeps(null)
    const before = spawnSsh('route-on-records', SSH_TAB)
    // The real machine list, on a records file whose read fails (a busy file).
    const write = vi.fn()
    const store = { read: () => { throw Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' }) }, write }
    const machines = new RemoteMachines({ runner: new FakeSsh({ answer: () => ({ code: 1 }) }), store, bundled: async () => ({ ok: false, why: 'none' }), inUse: () => 0, log: () => {} })
    plugIn(true, MACHINE, { machines })
    expect(spawnSsh('route-on-records', SSH_TAB)).toEqual(before)
    expect(ssh.calls).toHaveLength(0)
    expect(write).not.toHaveBeenCalled()
    expect(logs).toContain("[remote-helper] route-on-records: the usual SSH path, because the session helper's records could not be read (EBUSY: resource busy or locked, open)")
    expect(isRemoteHelperTab('route-on-records')).toBe(false)
  })
})

describe('the launch carries the app\'s light or dark scheme, as the usual SSH launch line does (COLORFGBG)', () => {
  const dark = () => true
  const light = () => false
  it('light gives 0;15; dark and no theme give 15;0; system follows the system and is asked only then', () => {
    expect(remoteTerminalEnv({ theme: 'light' }, dark)).toEqual({ COLORFGBG: '0;15' })
    expect(remoteTerminalEnv({ theme: 'dark' }, light)).toEqual({ COLORFGBG: '15;0' })
    expect(remoteTerminalEnv({}, light)).toEqual({ COLORFGBG: '15;0' })
    expect(remoteTerminalEnv(null, light)).toEqual({ COLORFGBG: '15;0' })
    expect(remoteTerminalEnv({ theme: 'system' }, dark)).toEqual({ COLORFGBG: '15;0' })
    expect(remoteTerminalEnv({ theme: 'system' }, light)).toEqual({ COLORFGBG: '0;15' })
    const asked = vi.fn(() => false)
    remoteTerminalEnv({ theme: 'light' }, asked)
    expect(asked).not.toHaveBeenCalled()
  })
})

describe('pty-manager SSH branch: a tab that goes through the session helper', () => {
  it('starts no node-pty, asks its machine first for the settings files its session keeps (2.1.3-beta.18 section 3.2), and ends with its tab', async () => {
    plugIn(true)
    const got = spawnSsh('route-helper', SSH_TAB)
    expect(got).toBeNull()
    expect(isRemoteHelperTab('route-helper')).toBe(true)
    expect(logs.some((l) => l.startsWith('[remote-helper] route-helper: through the session helper on nick@rocky.lan:22'))).toBe(true)
    await until(() => ssh.calls.length > 0)
    // The fake host refuses every connection: the start stops at its first exec.
    expect(ssh.scripts()).toEqual(['reads'])
    // Started again and closed while it starts: killPty reaches it, and it is forgotten.
    expect(spawnSsh('route-helper', SSH_TAB)).toBeNull()
    expect(isRemoteHelperTab('route-helper')).toBe(true)
    killPty('route-helper')
    expect(isRemoteHelperTab('route-helper')).toBe(false)
  })

  it('tells the tab\'s SSH flow overlay at once, and a start that fails at once still has no SSH flow until the tab is closed or started again', async () => {
    // The fake ssh refuses every connection: the hold fails, the tab shows why and its terminal ends.
    const counted: Array<[string, number]> = []
    plugIn(true, MACHINE, { onOutput: (sid, n) => { counted.push([sid, n]) } })
    const id = 'route-fails'
    const sent: Array<[string, unknown]> = []
    const tabWin = { webContents: { send: (ch: string, d: unknown) => { sent.push([ch, d]) } }, isDestroyed: () => false } as never
    captured = null
    spawnPty(tabWin, id, { ssh: SSH_TAB, cols: 100, rows: 30 })
    expect(captured).toBeNull()
    // One push, so a card the usual path left on the tab is not kept over it.
    expect(sent.filter(([ch]) => ch === `ssh:flowState:${id}`)).toEqual([[`ssh:flowState:${id}`, { state: SSH_THROUGH_HELPER }]])
    await until(() => sent.some(([ch]) => ch === `pty:exit:${id}`))
    expect(sent.some(([ch, d]) => ch === `pty:data:${id}` && String(d).includes('could not start through the session helper on rocky.lan'))).toBe(true)
    // The log says nothing starts: the tab only shows why (A2 x B1, the aggregate's final-head review).
    expect(logs.some((l) => l.includes('nothing is started for this terminal, because'))).toBe(true)
    expect(logs.some((l) => l.includes('starting it the usual way'))).toBe(false)
    // What the tab was sent reaches the PTY integrity count, as the usual paths' output does.
    const shown = sent.filter(([ch]) => ch === `pty:data:${id}`).reduce((n, [, d]) => n + String(d).length, 0)
    expect(shown).toBeGreaterThan(0)
    expect(counted.every(([sid]) => sid === id)).toBe(true)
    expect(counted.reduce((n, [, len]) => n + len, 0)).toBe(shown)
    expect(remoteTabsOn(MACHINE.did)).toBe(0)
    // Over, and still no SSH flow: the overlay's catch-up reads 'through-helper', not 'connecting'.
    expect(getSshFlow(id)).toBeUndefined()
    expect(isRemoteHelperTab(id)).toBe(true)
    // Started again on the usual path (the switch off): forgotten.
    plugIn(false)
    expect(spawnSsh(id, SSH_TAB)).not.toBeNull()
    expect(isRemoteHelperTab(id)).toBe(false)
    // Closed (the kill door forgets it; killPty does not reach a terminal that is over).
    plugIn(true)
    spawnPty(tabWin, id, { ssh: SSH_TAB, cols: 100, rows: 30 })
    await until(() => sent.filter(([ch]) => ch === `pty:exit:${id}`).length === 2)
    expect(isRemoteHelperTab(id)).toBe(true)
    killPty(id)
    forgetRemoteHelperTab(id)
    expect(isRemoteHelperTab(id)).toBe(false)
  })
})

describe('a tab through the session helper: what goes to its host, and what it types (plan finding 6; 2.1.3-beta.18 section 3.2)', () => {
  let store = ''
  afterEach(() => { if (store) rmSync(store, { recursive: true, force: true }); store = '' })

  it('only its own files go to the host, named on its launch, with no secret; a prompt button, a typed line and an image request of any length reach the CLI whole; no SSH flow', async () => {
    store = mkdtempSync(join(tmpdir(), 'rh-route-'))
    const id = 'route-what'
    const holder = new FakeHolder(remoteSessionId(id), id, store)
    plugIn(true, MACHINE, { settings: () => ({ remoteSessionsThroughHelper: true, theme: 'light' }) })
    ssh.host = {
      answer: (c) => {
        if (c.script === 'hold') return { stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\n${JSON.stringify({ ...holder.record(), endpoint: `/tmp/aicc-1000/${holder.sid}-0123456789abcdef.sock` })}\n` }
        if (c.script === 'reads' || c.script === 'files') return { stdout: result(c.values[0], {}) }
        return { code: 1 }
      },
      bridge: () => holder.connect(),
    }
    const shown: string[] = []
    const tabWin = { webContents: { send: (ch: string, d: unknown) => { if (ch === `pty:data:${id}`) shown.push(String(d)) } }, isDestroyed: () => false } as never
    captured = null
    spawnPty(tabWin, id, { ssh: SSH_TAB, cols: 100, rows: 30, model: 'opus' })
    expect(captured).toBeNull()
    await until(() => holder.attached !== null && holder.launch !== null)
    // Its own files, in its own folder on the host, and nothing else of the app: no secret goes with the launch.
    const launch = holder.launch as { argv?: string[]; env?: Record<string, string> }
    const folder = remoteHelperCommands(MACHINE, remoteSessionId(id)).folder
    expect(launch.argv?.slice(4, 9)).toEqual([MACHINE.claudePath, '--settings', `${folder}/settings.json`, '--mcp-config', `${folder}/mcp.json`])
    expect((launch.argv ?? []).join(' ')).not.toMatch(/--append-system-prompt|statusline|localhost|127\.0\.0\.1|token/i)
    expect(Object.keys(launch.env ?? {}).filter((k) => /TOKEN|SECRET|KEY|^CCC_|^ANTHROPIC/i.test(k))).toEqual([])
    expect(ssh.scripts()).toEqual(['reads', 'hold', 'files', 'bridge'])
    // The app's light theme reaches the CLI, as on the usual SSH launch line.
    expect(launch.env?.COLORFGBG).toBe('0;15')
    // A prompt button (Send) types by the usual rule for a Claude Code tab: its text, then Enter.
    const r = await submitPrompt(id, 'run the tests', 'send')
    expect(r).toEqual({ outcome: 'sent' })
    await until(() => Buffer.concat(holder.input).toString() === 'run the tests\r')
    // A typed line goes as it is.
    writePty(id, 'ls\r')
    await until(() => Buffer.concat(holder.input).toString() === 'run the tests\rls\r')
    // The app's own image request, longer than one 256-byte slice: the tab has
    // the image fetch tool, so the request reaches the CLI whole, in order.
    const image = `${'I just pasted an image and I would like you to look at it carefully, '.repeat(3)}(use mcp__conductor__fetch_host_screenshot with filename="screenshot-2026-11-24T05-55-12-123Z.png" to load the image from the Conductor host)\r`
    expect(image.length).toBeGreaterThan(256)
    writePty(id, image)
    await until(() => Buffer.concat(holder.input).toString() === `run the tests\rls\r${image}`)
    expect(shown.join('')).not.toMatch(/nothing was typed/)
    // No SSH flow: the overlay reads none for this tab (pty-handlers answers 'through-helper').
    expect(getSshFlow(id)).toBeUndefined()
    killPty(id)
    await until(() => holder.ended)
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

  it('is at or under its cap (PTY_MANAGER_LINE_CAP in scripts/ci/pr-numbers.mjs, the one source of the number)', () => {
    expect(countLines(src)).toBeLessThanOrEqual(PTY_MANAGER_LINE_CAP)
  })
})
