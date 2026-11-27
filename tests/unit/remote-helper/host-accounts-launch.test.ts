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
import { accountsLeftText, forgetRemoteHelperTab, remoteAccountsState, remoteHelperPty, setRemoteHelperDeps, signOutForRemove, signOutRemoteAccount } from '../../../src/main/remote-helper'
import { CLAUDE_REMOTE_ACCOUNTS, claudeRemoteLaunch } from '../../../src/main/providers/claude/remote-launch'
import { CLAUDE_RUN_SCREEN } from '../../../src/main/providers/claude/run-screen'
import { remoteSessionId } from '../../../src/main/remote-helper/session'
import { _resetHostAccountsForTest, forgetHostAccounts, type HostProfile } from '../../../src/main/remote-helper/host-accounts'
import { RemoteMachines, type RemoteMachineRecord } from '../../../src/main/remote-helper/machines'
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
/** The install each folder's marker names; this test's own unless set. */
let owners: Map<string, string>
/** The records list mode prints: the sessions the helper keeps there. */
let kept: Array<Record<string, unknown>>
/** The device folder is gone there (an earlier Remove from elsewhere, or deleted by hand). */
let deviceGone: boolean
let ssh: FakeSsh
let holder: FakeHolder
let store = ''
let sent: Array<[string, unknown]>
let logs: string[]
let switchOn: boolean
let methods: Record<string, string>
const INSTALL = 'f'.repeat(32)
const OTHER_INSTALL = 'e'.repeat(32)
const win = { webContents: { send: (ch: string, d: unknown) => { sent.push([ch, d]) } }, isDestroyed: () => false }
const ownerOf = (id: string): string => owners.get(id) ?? INSTALL

function accountsOut(n: string, install: string): string {
  const lines = [`AICC-HASH ${n} ok ${SHA}`]
  const field = (slot: string, part: string, obj?: Record<string, unknown>) => { lines.push(`AICC-FIELD ${n} ${slot} ${part}`); if (obj) lines.push(JSON.stringify(obj)) }
  field('own', 'id', own.id)
  field('own', 'cr', own.cr)
  for (const [id, f] of folders) {
    if (ownerOf(id) !== install) { lines.push(`AICC-FIELD ${n} ${id} elsewhere`); continue }
    field(id, 'id', f.id)
    field(id, 'cr', f.cr)
  }
  return `${lines.join('\n')}\nAICC-RESULT ${n} end ok\n`
}

/** A holder record as list mode prints it on Linux, kept until it is ended. */
function keptRecord(h: FakeHolder): Record<string, unknown> {
  return { ...h.record(), endpoint: `/tmp/aicc-1000/${h.sid}-0123456789abcdef.sock`, away: null, lifetime: 'until-ended' }
}

/** The fake host: the account scripts change `folders` as the real ones do (each folder this install's or another's, by its marker); the rest as a host with one holder. */
function answer(c: ExecCall): FakeAnswer {
  const n = c.values[0]
  const install = c.values[2]
  switch (c.script) {
    case 'accounts': return { stdout: accountsOut(n, install) }
    case 'account': {
      const [, , , id, mode] = c.values
      if (folders.has(id) && ownerOf(id) !== install) return { stdout: result(n, {}, 'refused account-folder-elsewhere') }
      if (!folders.has(id)) {
        if (mode !== 'make') return { stdout: result(n, { gone: 'yes' }) }
        folders.set(id, {})
        owners.set(id, install)
      }
      return { stdout: result(n, {}) }
    }
    case 'signout': {
      const [, , , kind, id] = c.values
      if (kind === 'list' && deviceGone) return { stdout: result(n, { device: 'gone' }) }
      if (kind === 'own') { own = {}; return { stdout: result(n, { logout: '0' }) } }
      if (kind === 'folder') {
        if (!folders.has(id)) return { stdout: result(n, { gone: 'yes' }) }
        if (ownerOf(id) !== install) return { stdout: result(n, {}, 'refused account-folder-elsewhere') }
      }
      const named = kind === 'list' ? (id === '-' ? [] : id.split(',')) : [id]
      const lines: string[] = []
      for (const x of named) {
        if (!folders.has(x) || ownerOf(x) !== install) continue
        folders.delete(x)
        lines.push(`AICC-RESULT ${n} out ${x} 0`, `AICC-RESULT ${n} removed ${x}`)
      }
      if (kind === 'list') for (const x of folders.keys()) lines.push(`AICC-RESULT ${n} ${ownerOf(x) === install ? 'left' : 'elsewhere'} ${x}`)
      return { stdout: `${lines.join('\n')}${lines.length ? '\n' : ''}AICC-RESULT ${n} end ok\n` }
    }
    case 'list': case 'sessions': {
      if (deviceGone) return { stdout: result(n, {}, 'refused device-folder-not-private') }
      const line = `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify({ v: 1, sessions: kept, removed: 0, skipped: 0 })}\n`
      return { stdout: c.script === 'sessions' ? `${line}${result(n, { swept: '0' })}` : line }
    }
    case 'remove': return { stdout: deviceGone ? result(n, { gone: 'yes' }) : result(n, {}) }
    case 'hold': return { stdout: `AICC-HASH ${n} ok ${SHA}\n${JSON.stringify({ ...holder.record(), endpoint: `/tmp/aicc-1000/${holder.sid}-0123456789abcdef.sock` })}\n` }
    case 'field': return { stdout: `AICC-HASH ${n} ok ${SHA}\n`, code: 0 }
    case 'reads': return { stdout: result(n, { f0: `ok ${Buffer.from(JSON.stringify({ apiKeyHelper: '/bin/key', theme: 'dark' })).toString('hex')}` }) }
    case 'files': case 'unsession': return { stdout: result(n, {}) }
    default: return { code: 1 }
  }
}

function plugIn(machines?: RemoteMachines): void {
  ssh = new FakeSsh({ answer, bridge: () => holder.connect() })
  setRemoteHelperDeps({
    platform: 'win32',
    settings: () => ({ remoteSessionsThroughHelper: switchOn }),
    machines: machines ?? ({ findByTarget: () => MACHINE, get: () => MACHINE, list: () => [MACHINE], installId: () => INSTALL } as unknown as RemoteMachines),
    runner: ssh,
    bundledSha256: () => SHA,
    systemPrefersDark: () => true,
    onOutput: () => {},
    log: (m) => logs.push(m),
    profileSignIn: (id) => ({ email: PROFILES.find((p) => p.id === id)?.accountEmail, ...(methods[id] ? { method: methods[id] } : {}) }),
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
  owners = new Map()
  kept = []
  deviceGone = false
  methods = {}
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
    expect(ssh.scripts()).toEqual(['sessions', 'accounts', 'signout', 'accounts'])
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

  it('MINOR-3: refused while the helper keeps a session there that no open tab shows; an open tab on another account does not stop it', async () => {
    const away = new FakeHolder(remoteSessionId('left-running'), 'left-running', store)
    kept = [keptRecord(away)]
    const r = await signOutRemoteAccount({ did: MACHINE.did, profileId: 'profile-personal' })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/no open tab shows/)
    expect(ssh.scripts()).toEqual(['sessions'])
    expect(folders.has('profile-personal')).toBe(true)
    // A tab on Work (the machine's own sign-in) is open there: its holder is listed, and is known not to use Personal's folder.
    kept = []
    const id = 'acct-work-open'
    const pty = start(id, { profileId: 'profile-work' })
    await until(() => launchOf() !== null)
    kept = [keptRecord(holder)]
    const ok = await signOutRemoteAccount({ did: MACHINE.did, profileId: 'profile-personal' })
    expect(ok).toMatchObject({ ok: true, state: 'not-signed-in' })
    expect(folders.has('profile-personal')).toBe(false)
    pty.kill()
    forgetRemoteHelperTab(id)
  })

  it('MINOR-4: the machine\'s own sign-in with a folder of the account left there asks first, then signs the machine\'s own out and removes that folder too', async () => {
    folders.set('profile-work', { id: { [K.identity]: 'work@example.com' } })
    const ask = await signOutRemoteAccount({ did: MACHINE.did, profileId: 'profile-work' })
    expect(ask).toMatchObject({ ok: false, needsConfirm: 'machine-own', state: 'machine-own' })
    expect(ssh.scripts().filter((s) => s === 'signout')).toEqual([])
    expect(folders.has('profile-work')).toBe(true)
    const done = await signOutRemoteAccount({ did: MACHINE.did, profileId: 'profile-work', confirmMachineOwn: true })
    expect(done).toMatchObject({ ok: true, signedOutWithService: true, state: 'not-signed-in' })
    expect(done.message).toMatch(/own sign-in \(Work\)\. A folder of Work left there was removed too/)
    expect(ssh.calls.filter((c) => c.script === 'signout').map((c) => c.values.slice(3, 5))).toEqual([['own', '-'], ['folder', 'profile-work']])
    expect(folders.has('profile-work')).toBe(false)
    expect(own).toEqual({})
  })
})

/** The machine list itself, its records in memory, with Remove's account steps wired as main wires them. */
function realMachines(): RemoteMachines {
  let stored: unknown = { v: 1, installId: INSTALL, machines: [MACHINE] }
  // The fake ssh plugIn makes below, whichever it is when an exec runs.
  const runner = {
    spawn: ((...a: Parameters<FakeSsh['spawn']>) => ssh.spawn(...a)) as FakeSsh['spawn'],
    version: () => ssh.version(),
    sshPath: () => ssh.sshPath(),
    env: () => ssh.env(),
  }
  const list = new RemoteMachines({
    runner,
    store: { read: () => stored, write: (v: unknown) => { stored = JSON.parse(JSON.stringify(v)) } },
    bundled: async () => ({ ok: false, why: 'none in this test' }),
    inUse: () => 0,
    log: (m) => logs.push(m),
    signOutAccounts: signOutForRemove,
    accountsLeft: accountsLeftText,
    forgotten: forgetHostAccounts,
  })
  plugIn(list)
  return list
}

describe('Remove, with its account steps (3.1.8; fix round MAJOR-1 and MAJOR-2)', () => {
  it('MAJOR-1: signs out only this computer\'s folders, each named; another computer\'s folder on the same login stays, and the answer says so', async () => {
    plugIn()
    const list = realMachines()
    folders.set('profile-theirs', signedIn('theirs@example.com'))
    owners.set('profile-theirs', OTHER_INSTALL)
    const r = await list.remove(MACHINE.did)
    expect(r.ok, r.message).toBe(true)
    expect(ssh.scripts()).toEqual(['list', 'signout', 'remove'])
    expect(ssh.calls[1].values.slice(3, 5)).toEqual(['list', 'profile-work,profile-personal,profile-side'])
    expect([...folders.keys()]).toEqual(['profile-theirs'])
    expect(r.message).toMatch(/Signed out Personal, Side there first\./)
    expect(r.message).toMatch(/One account folder there is used by the app on another computer, and was left as it is\./)
    expect(list.list()).toEqual([])
  })

  it('MAJOR-2: a machine whose device folder is already gone is removed as beta.19 removed it, naming what stays signed in there', async () => {
    plugIn()
    const list = realMachines()
    deviceGone = true
    const r = await list.remove(MACHINE.did)
    expect(r.ok, r.message).toBe(true)
    expect(ssh.scripts()).toEqual(['list', 'signout', 'remove'])
    expect(r.message).toMatch(/^Removed the session helper from Rocky/)
    expect(r.message).toMatch(/has not read which accounts are signed in/)
    expect(list.list()).toEqual([])
    expect([...folders.keys()]).toEqual(['profile-personal', 'profile-side'])
  })
})

describe('fix round: the sign-in method, a kept session\'s attach, and the notes (MINOR-5, NIT-8, NIT-11)', () => {
  it('MINOR-5: a sign-in tab signs in by the account\'s own method', async () => {
    methods['profile-personal'] = 'sso'
    folders.delete('profile-personal')
    const id = 'signin-sso'
    start(id, { profileId: 'profile-personal', remoteAccountSignIn: true })
    await until(() => launchOf() !== null)
    expect(launchOf()?.argv?.slice(4)).toEqual(['/usr/local/bin/claude', 'auth', 'login', '--sso', '--email', 'personal@example.com'])
    holder.exitChild(0)
    await until(() => notices().length === 1)
    forgetRemoteHelperTab(id)
  })

  it('NIT-8: an attach to a session kept for the tab is never stopped by its account\'s read: it attaches and launches nothing, with no notice', async () => {
    const persistent: RemoteMachineRecord = { ...MACHINE, logind: { kill: 'no', exclude: '', linger: 'no' } }
    plugIn({ findByTarget: () => persistent, get: () => persistent, list: () => [persistent], installId: () => INSTALL } as unknown as RemoteMachines)
    const id = 'kept-unsigned'
    holder = new FakeHolder(remoteSessionId(id), id, store)
    holder.launch = { t: 'term.launch' }
    holder.child = 'running'
    kept = [keptRecord(holder)]
    const pty = remoteHelperPty(win, id, { ssh: { ...SSH_TAB, detachable: true }, profileId: 'profile-unsigned' }, 100, 30) as IPty
    expect(pty).not.toBeNull()
    await until(() => holder.attaches > 0)
    expect(ssh.scripts()).toEqual(['accounts', 'list', 'bridge'])
    expect(notices()).toEqual([])
    expect(holder.launch).toEqual({ t: 'term.launch' })
    pty.kill()
    forgetRemoteHelperTab(id)
  })

  it('NIT-8: with no kept session to attach to, the same read still starts nothing', async () => {
    const persistent: RemoteMachineRecord = { ...MACHINE, logind: { kill: 'no', exclude: '', linger: 'no' } }
    plugIn({ findByTarget: () => persistent, get: () => persistent, list: () => [persistent], installId: () => INSTALL } as unknown as RemoteMachines)
    const id = 'kept-none'
    holder = new FakeHolder(remoteSessionId(id), id, store)
    remoteHelperPty(win, id, { ssh: { ...SSH_TAB, detachable: true }, profileId: 'profile-unsigned' }, 100, 30)
    await until(() => notices().length === 1)
    expect(ssh.scripts()).toEqual(['accounts', 'list'])
    expect(notices()[0]).toMatchObject({ kind: 'launch-refused', refusal: { state: 'not-signed-in' } })
    forgetRemoteHelperTab(id)
  })

  it('NIT-11: a sign-in tab that could not start names its own next step, never the usual SSH path', async () => {
    owners.set('profile-personal', OTHER_INSTALL)
    const id = 'signin-elsewhere'
    start(id, { profileId: 'profile-personal', remoteAccountSignIn: true })
    await until(() => shown(id).includes('could not start'))
    expect(shown(id)).toMatch(/made by the app on another computer/)
    expect(shown(id)).toMatch(/choose Sign in on this machine again/)
    expect(shown(id)).not.toMatch(/usual SSH path/)
    expect(launchOf()).toBeNull()
    forgetRemoteHelperTab(id)
  })
})
