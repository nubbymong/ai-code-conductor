/**
 * Sign in on this machine (plan 2.1.3-beta.20, section 3): a helper tab whose
 * config names an account, end to end against a FAKE host and a FakeHolder,
 * through remoteHelperPty (the PTY manager's one door to the helper).
 *
 * - 3.1.7: the config's account decides. Signed in in its own folder there:
 *   the CLI starts with that folder as its config folder (CLAUDE_CONFIG_DIR),
 *   and the folder is brought up to date first. Signed in as the machine's
 *   own sign-in: the CLI starts on the machine's own folder (no
 *   CLAUDE_CONFIG_DIR). Not signed in, signed in as another account (never
 *   used), or not read: no holder, no CLI; the tab says why and the renderer
 *   gets the typed reason. A config with no account: as before.
 * - 3.1.4: a sign-in tab makes the account's folder and runs the CLI's own
 *   sign-in in it, never on the usual path; its end reads the machine again
 *   and the renderer hears the account's state there.
 * - 3.1.8: Sign out at the app's door: its own folder only; the machine's own
 *   sign-in only once confirmed (Q5).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'node-pty'
import type { RemoteAccounts, SessionProvider } from '../../../src/main/providers/types'
import { registerProvider } from '../../../src/main/providers'
import { forgetRemoteHelperTab, remoteAccountsState, remoteHelperPty, setRemoteHelperDeps, signOutRemoteAccount } from '../../../src/main/remote-helper'
import { CLAUDE_REMOTE_ACCOUNTS, claudeRemoteLaunch } from '../../../src/main/providers/claude/remote-launch'
import { CLAUDE_RUN_SCREEN } from '../../../src/main/providers/claude/run-screen'
import { remoteSessionId } from '../../../src/main/remote-helper/session'
import { _resetHostAccountsForTest, type HostProfile } from '../../../src/main/remote-helper/host-accounts'
import type { RemoteMachineRecord, RemoteMachines } from '../../../src/main/remote-helper/machines'
import type { SSHOptions } from '../../../src/main/ssh-options'
import { IPC } from '../../../src/shared/ipc-channels'
import type { HostAccountNotice } from '../../../src/shared/host-accounts'
import { FakeHolder } from '../main/session-helper-fake-holder'
import { FakeSsh, result, type ExecCall, type FakeAnswer } from './fake-ssh'

const SHA = 'a'.repeat(64)
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/usr/local/bin/claude',
  path: '/usr/local/bin:/usr/bin:/bin', lang: null, helper: { path: 'linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, folder: `0.1.0-${SHA.slice(0, 12)}` }, check: { at: 1, ok: true },
}
const SSH_TAB: SSHOptions = { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~', detachable: false }
const PROFILES: HostProfile[] = [
  { id: 'profile-work', accountEmail: 'work@example.com', name: 'Work' },
  { id: 'profile-personal', accountEmail: 'personal@example.com', name: 'Personal' },
  { id: 'profile-side', accountEmail: 'side@example.com', name: 'Side' },
]
const VIA: RemoteAccounts = { ...CLAUDE_REMOTE_ACCOUNTS, profiles: async () => PROFILES }
const K = CLAUDE_REMOTE_ACCOUNTS.keys
const provider = {
  id: 'claude', displayName: 'Claude', resolveBinary: () => null, buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
  detectUiRunning: () => false, ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {}, getSshSettingsPath: () => '', getSshMcpConfigPath: () => '', configureRemoteSettings: () => '',
  // The Claude package's remote launch, its accounts listing this test's profiles.
  remoteLaunch: { ...claudeRemoteLaunch, accounts: () => VIA },
  runScreen: CLAUDE_RUN_SCREEN,
} as unknown as SessionProvider

type SignIn = { id?: Record<string, unknown>; cr?: Record<string, unknown> }
const signedIn = (email: string): SignIn => ({ id: { [K.identity]: email }, cr: { [K.plan]: 'max', [K.expiresAt]: 1_764_000_000_000 } })

let own: SignIn
let folders: Map<string, SignIn>
let ssh: FakeSsh
let holder: FakeHolder
let store = ''
let sent: Array<[string, unknown]>
let logs: string[]
let switchOn: boolean
const win = { webContents: { send: (ch: string, d: unknown) => { sent.push([ch, d]) } }, isDestroyed: () => false }

function accountsOut(n: string): string {
  const lines = [`AICC-HASH ${n} ok ${SHA}`]
  const field = (slot: string, part: string, obj?: Record<string, unknown>) => { lines.push(`AICC-FIELD ${n} ${slot} ${part}`); if (obj) lines.push(JSON.stringify(obj)) }
  field('own', 'id', own.id)
  field('own', 'cr', own.cr)
  for (const [id, f] of folders) { field(id, 'id', f.id); field(id, 'cr', f.cr) }
  return `${lines.join('\n')}\nAICC-RESULT ${n} end ok\n`
}

/** The fake host: the account scripts change `folders` as the real ones do; the rest as a host with one holder. */
function answer(c: ExecCall): FakeAnswer {
  const n = c.values[0]
  switch (c.script) {
    case 'accounts': return { stdout: accountsOut(n) }
    case 'account': {
      const [, , , id, mode] = c.values
      if (!folders.has(id)) {
        if (mode !== 'make') return { stdout: result(n, { gone: 'yes' }) }
        folders.set(id, {})
      }
      return { stdout: result(n, {}) }
    }
    case 'signout': {
      const [, , , kind, id] = c.values
      if (kind === 'own') { own = {}; return { stdout: result(n, { logout: '0' }) } }
      if (!folders.has(id)) return { stdout: result(n, { gone: 'yes' }) }
      folders.delete(id)
      return { stdout: `AICC-RESULT ${n} out ${id} 0\nAICC-RESULT ${n} removed ${id}\nAICC-RESULT ${n} end ok\n` }
    }
    case 'hold': return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify({ ...holder.record(), endpoint: `/tmp/aicc-1000/${holder.sid}-0123456789abcdef.sock` })}\n` }
    case 'field': return { stdout: `AICC-HASH ${n} ok ${SHA}\n`, code: 0 }
    case 'reads': return { stdout: result(n, { f0: `ok ${Buffer.from(JSON.stringify({ apiKeyHelper: '/bin/key', theme: 'dark' })).toString('hex')}` }) }
    case 'files': case 'unsession': return { stdout: result(n, {}) }
    default: return { code: 1 }
  }
}

function plugIn(): void {
  ssh = new FakeSsh({ answer, bridge: () => holder.connect() })
  setRemoteHelperDeps({
    platform: 'win32',
    settings: () => ({ remoteSessionsThroughHelper: switchOn }),
    machines: { findByTarget: () => MACHINE, get: () => MACHINE, list: () => [MACHINE], installId: () => 'f'.repeat(32) } as unknown as RemoteMachines,
    runner: ssh,
    bundledSha256: () => SHA,
    systemPrefersDark: () => true,
    onOutput: () => {},
    log: (m) => logs.push(m),
    profileEmail: (id) => PROFILES.find((p) => p.id === id)?.accountEmail,
  })
}

async function until(ok: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const launchOf = () => holder.launch as { argv?: string[]; env?: Record<string, string> } | null
const shown = (id: string) => sent.filter(([ch]) => ch === `pty:data:${id}`).map(([, d]) => String(d)).join('')
const notices = () => sent.filter(([ch]) => ch === IPC.REMOTE_ACCOUNT_NOTICE).map(([, d]) => d as HostAccountNotice)

function start(id: string, extra: Record<string, unknown> = {}): IPty {
  holder = new FakeHolder(remoteSessionId(id), id, store)
  const pty = remoteHelperPty(win, id, { ssh: SSH_TAB, ...extra }, 100, 30)
  expect(pty, 'a tab through the helper, never the usual path').not.toBeNull()
  return pty as IPty
}

beforeEach(() => {
  registerProvider(provider)
  _resetHostAccountsForTest()
  store = mkdtempSync(join(tmpdir(), 'rh-acct-'))
  own = signedIn('work@example.com')
  folders = new Map([['profile-personal', signedIn('personal@example.com')], ['profile-side', signedIn('someone@example.org')]])
  sent = []
  logs = []
  switchOn = true
  plugIn()
})
afterEach(() => {
  setRemoteHelperDeps(null)
  if (store) rmSync(store, { recursive: true, force: true })
  store = ''
})

describe('a launch on an account (3.1.7): the config\'s account decides', () => {
  it('signed in in its own folder: the folder is brought up to date, then the CLI starts with it as its config folder', async () => {
    const id = 'acct-folder'
    const pty = start(id, { profileId: 'profile-personal' })
    await until(() => launchOf() !== null)
    expect(ssh.scripts()).toEqual(['accounts', 'reads', 'field', 'account', 'hold', 'files', 'bridge'])
    expect(launchOf()?.env?.CLAUDE_CONFIG_DIR).toBe('/home/nick/.aicc/accounts/profile-personal')
    // The refresh: no folder made, its links and its settings copy, sanitised (no apiKeyHelper).
    const refresh = ssh.calls.find((c) => c.script === 'account') as ExecCall
    expect(refresh.values.slice(3, 5)).toEqual(['profile-personal', 'refresh'])
    expect(JSON.parse(refresh.stdin.toString())).toEqual({ theme: 'dark' })
    // Its label is read from the folder's own .claude.json.
    expect(ssh.calls.find((c) => c.script === 'field')?.values.slice(5)).toEqual(['.aicc/accounts/profile-personal/.claude.json', 'oauthAccount.emailAddress'])
    // The session's own settings file carries the sanitised copy too.
    const files = (ssh.calls.find((c) => c.script === 'files') as ExecCall).stdin.toString()
    expect(files).toContain('"theme": "dark"')
    expect(files).not.toContain('apiKeyHelper')
    pty.kill()
    forgetRemoteHelperTab(id)
  })

  it('signed in as the machine\'s own sign-in: the CLI starts on the machine\'s own folder, and no account folder is touched', async () => {
    const id = 'acct-own'
    const pty = start(id, { profileId: 'profile-work' })
    await until(() => launchOf() !== null)
    expect(ssh.scripts()).toEqual(['accounts', 'reads', 'field', 'hold', 'files', 'bridge'])
    expect(launchOf()?.env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(ssh.calls.find((c) => c.script === 'field')?.values.slice(5)).toEqual(['.claude.json', 'oauthAccount.emailAddress'])
    pty.kill()
    forgetRemoteHelperTab(id)
  })

  it('a config with no account: as before, the machine\'s own sign-in, nothing read for accounts', async () => {
    const id = 'acct-none'
    const pty = start(id)
    await until(() => launchOf() !== null)
    expect(ssh.scripts()).toEqual(['reads', 'field', 'hold', 'files', 'bridge'])
    expect(launchOf()?.env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    pty.kill()
    forgetRemoteHelperTab(id)
  })

  for (const [what, profileId, state] of [
    ['not signed in there', 'profile-unsigned', 'not-signed-in'],
    ['its folder signed in as another account (never used)', 'profile-side', 'someone-else'],
  ] as const) {
    it(`${what}: no holder, no CLI; the tab says why and the renderer gets the typed reason`, async () => {
      const id = `acct-${state}`
      start(id, { profileId })
      await until(() => notices().length === 1 && shown(id).includes('started nothing'))
      await new Promise((r) => setTimeout(r, 50))
      expect(ssh.scripts()).toEqual(['accounts'])
      expect(launchOf()).toBeNull()
      const n = notices()[0]
      expect(n.kind).toBe('launch-refused')
      if (n.kind !== 'launch-refused') return
      expect(n.sessionId).toBe(id)
      expect(n.refusal).toMatchObject({ did: MACHINE.did, profileId, state, signedInThere: ['profile-work', 'profile-personal'] })
      if (state === 'someone-else') expect(n.refusal.identity).toBe('someone@example.org')
      expect(shown(id)).toContain(n.refusal.text)
      forgetRemoteHelperTab(id)
    })
  }

  it('a machine whose accounts do not read: nothing starts, and the reason says so', async () => {
    ssh.host = { answer: (c) => (c.script === 'accounts' ? { code: 255, stderr: 'ssh: connect to host rocky.lan port 22: Connection timed out' } : answer(c)), bridge: () => holder.connect() }
    const id = 'acct-not-read'
    start(id, { profileId: 'profile-personal' })
    await until(() => notices().length === 1)
    expect(ssh.scripts()).toEqual(['accounts'])
    expect(notices()[0]).toMatchObject({ kind: 'launch-refused', refusal: { state: 'not-read' } })
    forgetRemoteHelperTab(id)
  })
})

describe('a sign-in tab (3.1.4)', () => {
  it('makes the account\'s folder, runs the CLI\'s own sign-in in it, and its end reads the machine and tells the renderer', async () => {
    folders.delete('profile-personal')
    const id = 'signin-tab'
    start(id, { profileId: 'profile-personal', remoteAccountSignIn: true })
    await until(() => launchOf() !== null)
    expect(ssh.scripts()).toEqual(['account', 'hold', 'bridge'])
    expect((ssh.calls[0]).values.slice(3)).toEqual(['profile-personal', 'make', '.claude', 'projects,memory,agents,skills,commands,plugins', 'CLAUDE.md', 'settings.json', 'keep'])
    expect(launchOf()?.argv?.slice(4)).toEqual(['/usr/local/bin/claude', 'auth', 'login', '--claudeai', '--email', 'personal@example.com'])
    expect(launchOf()?.env?.CLAUDE_CONFIG_DIR).toBe('/home/nick/.aicc/accounts/profile-personal')
    // As a plain SSH tab: the away clock, not kept.
    expect(ssh.calls.find((c) => c.script === 'hold')?.values[7]).toBe('away')
    // The sign-in signs in as someone else: the read after it marks it.
    folders.set('profile-personal', signedIn('someone@example.org'))
    holder.exitChild(0)
    await until(() => notices().length === 1)
    expect(notices()[0]).toEqual({ kind: 'sign-in-ended', sessionId: id, did: MACHINE.did, profileId: 'profile-personal', state: 'someone-else', identity: 'someone@example.org' })
    expect(ssh.scripts().slice(-1)).toEqual(['accounts'])
    forgetRemoteHelperTab(id)
  })

  it('never takes the usual path: with the switch off, or no account named, it starts nothing and says why', async () => {
    switchOn = false
    const off = start('signin-off', { profileId: 'profile-personal', remoteAccountSignIn: true })
    await until(() => shown('signin-off').includes('Sign in on this machine did not start'))
    expect(shown('signin-off')).toMatch(/switch is off/)
    switchOn = true
    start('signin-noacct', { remoteAccountSignIn: true })
    await until(() => shown('signin-noacct').includes('no account of this computer was named'))
    setRemoteHelperDeps(null)
    expect(remoteHelperPty(win, 'signin-nodeps', { ssh: SSH_TAB, profileId: 'profile-personal', remoteAccountSignIn: true }, 80, 24)).not.toBeNull()
    expect(ssh.scripts()).toEqual([])
    off.kill()
  })
})

describe('Sign out at the app\'s door (3.1.8, Q5)', () => {
  it('its own folder only; the machine\'s own sign-in only once confirmed, naming it so; the state after it', async () => {
    const r = await signOutRemoteAccount({ did: MACHINE.did, profileId: 'profile-personal' })
    expect(r).toMatchObject({ ok: true, signedOutWithService: true, state: 'not-signed-in' })
    expect([...folders.keys()]).toEqual(['profile-side'])
    expect(ssh.scripts()).toEqual(['accounts', 'signout', 'accounts'])
    // Work is the machine's own sign-in: nothing runs until the user confirms.
    const ask = await signOutRemoteAccount({ did: MACHINE.did, profileId: 'profile-work' })
    expect(ask).toMatchObject({ ok: false, needsConfirm: 'machine-own', state: 'machine-own' })
    expect(ask.message).toMatch(/machine's own sign-in/)
    expect(ssh.scripts().filter((s) => s === 'signout')).toHaveLength(1)
    const done = await signOutRemoteAccount({ did: MACHINE.did, profileId: 'profile-work', confirmMachineOwn: true })
    expect(done).toMatchObject({ ok: true, signedOutWithService: true, state: 'not-signed-in' })
    expect(ssh.calls.filter((c) => c.script === 'signout').map((c) => c.values.slice(3, 5))).toEqual([['folder', 'profile-personal'], ['own', '-']])
    // A folder signed in as another account is signed out by its own folder, no question asked.
    expect(await signOutRemoteAccount({ did: MACHINE.did, profileId: 'profile-side' })).toMatchObject({ ok: true, state: 'not-signed-in' })
    expect(folders.size).toBe(0)
    // The page's list: the last read, no exec.
    const before = ssh.calls.length
    const state = await remoteAccountsState()
    expect(ssh.calls.length).toBe(before)
    expect(state.machines[0].accounts.map((a) => a.state)).toEqual(['not-signed-in', 'not-signed-in', 'not-signed-in'])
  })

  it('refused while a tab on that account runs there', async () => {
    const id = 'acct-busy'
    const pty = start(id, { profileId: 'profile-personal' })
    await until(() => launchOf() !== null)
    const r = await signOutRemoteAccount({ did: MACHINE.did, profileId: 'profile-personal' })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Close it, then sign out/)
    expect(folders.has('profile-personal')).toBe(true)
    pty.kill()
    forgetRemoteHelperTab(id)
  })
})
