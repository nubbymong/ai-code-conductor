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
import { accountsLeftText, adoptRemoteAccounts, forgetRemoteHelperTab, readRemoteAccounts, remoteAccountsState, remoteHelperPty, setRemoteHelperDeps, signOutForRemove, signOutRemoteAccount } from '../../../src/main/remote-helper'
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
/** Final review, round 2 (F2-1): accounts a test adds to this computer's,
 *  and the account aliases the app's settings hold. */
let extraProfiles: HostProfile[] = []
let aliases: Record<string, string> | undefined
const VIA: RemoteAccounts = { ...CLAUDE_REMOTE_ACCOUNTS, profiles: async () => [...PROFILES, ...extraProfiles] }
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
/** Folders whose CLI sign-out there does not finish (it exits 1); the folder still goes. */
let untold: Set<string>
/** Final review round 3 (F3-1): Remove's list stops after this many folders (null: it does not). */
let stopListAfter: number | null
const INSTALL = 'f'.repeat(32)
const OTHER_INSTALL = 'e'.repeat(32)
/** The owner of a folder with the marker of the builds before the install id was in it. */
const OLD = 'old'
const win = { webContents: { send: (ch: string, d: unknown) => { sent.push([ch, d]) } }, isDestroyed: () => false }
const ownerOf = (id: string): string => owners.get(id) ?? INSTALL

function accountsOut(n: string, install: string): string {
  const lines = [`AICC-HASH ${n} ok ${SHA}`]
  const field = (slot: string, part: string, obj?: Record<string, unknown>) => { lines.push(`AICC-FIELD ${n} ${slot} ${part}`); if (obj) lines.push(JSON.stringify(obj)) }
  field('own', 'id', own.id)
  field('own', 'cr', own.cr)
  for (const [id, f] of folders) {
    if (ownerOf(id) === OLD) lines.push(`AICC-FIELD ${n} ${id} old`)
    else if (ownerOf(id) !== install) { lines.push(`AICC-FIELD ${n} ${id} elsewhere`); continue }
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
      let adopted: string | undefined
      if (folders.has(id) && ownerOf(id) === OLD) { owners.set(id, install); adopted = 'old' }
      if (folders.has(id) && ownerOf(id) !== install) {
        if (mode !== 'adopt') return { stdout: result(n, {}, 'refused account-folder-elsewhere') }
        owners.set(id, install)
        adopted = 'elsewhere'
      }
      if (!folders.has(id)) {
        if (mode !== 'make') return { stdout: result(n, { gone: 'yes' }) }
        folders.set(id, {})
        owners.set(id, install)
      }
      return { stdout: result(n, adopted ? { adopted } : {}) }
    }
    case 'signout': {
      const [, , , kind, id] = c.values
      if (kind === 'list' && deviceGone) return { stdout: result(n, { device: 'gone' }) }
      if (kind === 'own') { own = {}; return { stdout: result(n, { logout: '0' }) } }
      if (kind === 'folder') {
        if (!folders.has(id)) return { stdout: result(n, { gone: 'yes' }) }
        if (ownerOf(id) !== install && ownerOf(id) !== OLD) return { stdout: result(n, {}, 'refused account-folder-elsewhere') }
      }
      const named = kind === 'list' ? (id === '-' ? [] : id.split(',')) : [id]
      const lines: string[] = []
      let removed = 0
      for (const x of named) {
        if (!folders.has(x) || (ownerOf(x) !== install && ownerOf(x) !== OLD)) continue
        if (kind === 'list' && stopListAfter !== null && removed === stopListAfter) return { stdout: `${lines.join('\n')}\nAICC-RESULT ${n} end refused account-folder-busy\n` }
        folders.delete(x)
        removed++
        lines.push(`AICC-RESULT ${n} out ${x} ${untold.has(x) ? 1 : 0}`, `AICC-RESULT ${n} removed ${x}`)
      }
      if (kind === 'list') for (const x of folders.keys()) lines.push(`AICC-RESULT ${n} ${ownerOf(x) === install ? 'left' : ownerOf(x) === OLD ? 'old' : 'elsewhere'} ${x}`)
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
    settings: () => ({ remoteSessionsThroughHelper: switchOn, ...(aliases ? { accountAliases: aliases } : {}) }),
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
  untold = new Set()
  stopListAfter = null
  extraProfiles = []
  aliases = undefined
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
  // Final review round 4 (F4-1): an account this computer no longer holds is
  // never given a folder or a sign-in on the machine.
  it('for an account this computer no longer holds makes nothing there and says so', async () => {
    const id = 'signin-not-held'
    start(id, { profileId: 'profile-notheld', remoteAccountSignIn: true })
    await until(() => shown(id).includes('could not start'))
    expect(shown(id)).toContain(signInNote('its account is no longer on this computer, so nothing was made or signed in there. Start a tab on an account signed in there.'))
    expect(ssh.scripts()).not.toContain('account')
    expect(folders.has('profile-notheld')).toBe(false)
    expect(launchOf()).toBeNull()
    forgetRemoteHelperTab(id)
    // Its end reads the machine as any sign-in tab does; the renderer has no wait on an account it does not hold.
    await until(() => notices().some((x) => x.kind === 'sign-in-ended'))
    expect(folders.has('profile-notheld')).toBe(false)
  })

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
    expect(r.message).toMatch(/Signed out Personal and Side there first\./)
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

// Final review, round 2 (F2-1): the Machines page shows main's answers to a
// row's Sign out and to Remove word for word as its notice
// (RemoteMachinesSection.tsx), so main names each account of this computer
// as the card does: its name, else its alias (the app's settings), else its
// email, else "an account with no name", with a capital where that starts a
// sentence. A tab's note names it so too. Round 3 (F3-1): a folder of an
// account this computer does not hold is named "an account no longer on this
// computer" (the describe after this one), never by its profile id.
describe('final review round 2 (F2-1): main\'s answers name accounts as the Machines card does', () => {
  const ROCKY = 'Rocky (nick@rocky.lan:22)'
  const END = 'in your Claude account settings on claude.ai'
  beforeEach(() => {
    extraProfiles = [{ id: 'profile-blank' }, { id: 'profile-lab', accountEmail: 'Lab@Example.com' }]
    aliases = { 'lab@example.com': 'Lab' }
    folders.set('profile-blank', signedIn('blank@example.com'))
    folders.set('profile-lab', signedIn('lab@example.com'))
  })

  it('a row\'s Sign out: an account with no name, and one known by its alias', async () => {
    expect((await signOutRemoteAccount({ did: MACHINE.did, profileId: 'profile-blank' })).message).toBe(`Signed an account with no name out on ${ROCKY}, and removed its folder there.`)
    expect((await signOutRemoteAccount({ did: MACHINE.did, profileId: 'profile-blank' })).message).toBe(`An account with no name is not signed in on ${ROCKY}.`)
    untold.add('profile-lab')
    expect((await signOutRemoteAccount({ did: MACHINE.did, profileId: 'profile-lab' })).message).toBe(`Removed the sign-in of Lab from ${ROCKY}. Claude Code's sign-out there did not finish (it exited 1), so to end that sign-in everywhere, sign it out ${END}.`)
  })

  it('Remove: the accounts it signed out, and the one whose sign-out there did not finish', async () => {
    plugIn()
    const list = realMachines()
    untold.add('profile-lab')
    const r = await list.remove(MACHINE.did)
    expect(r.ok, r.message).toBe(true)
    expect(r.message).toBe(`Removed the session helper from ${ROCKY}. Signed out Personal, Side and an account with no name there first. Removed the sign-in of Lab from it; Claude Code's sign-out there did not finish for it, so end that sign-in ${END}.`)
  })

  it('Remove: a sentence that an account with no name starts takes a capital', async () => {
    plugIn()
    const list = realMachines()
    owners.set('profile-blank', OTHER_INSTALL)
    const r = await list.remove(MACHINE.did)
    expect(r.ok, r.message).toBe(true)
    expect(r.message).toContain(' An account with no name: its folder there carries another install\'s mark, and may be this computer\'s own from an earlier install of the app; it was left as it is.')
  })

  it('Remove, the device folder already gone: what stays signed in there, by the last read', async () => {
    plugIn()
    const list = realMachines()
    folders.delete('profile-personal')
    folders.delete('profile-side')
    await readRemoteAccounts([MACHINE.did])
    deviceGone = true
    const r = await list.remove(MACHINE.did)
    expect(r.ok, r.message).toBe(true)
    expect(r.message).toBe(`Removed the session helper from ${ROCKY}. An account with no name and Lab stay signed in on ${ROCKY} until you sign them out there, or end those sign-ins ${END}.`)
  })

  it('a tab on an account not signed in there: its note names it by its alias, and one with no name with a capital', async () => {
    folders.delete('profile-lab')
    folders.delete('profile-blank')
    start('f2-lab', { profileId: 'profile-lab' })
    await until(() => notices().length === 1 && shown('f2-lab').includes('started nothing'))
    const lab = notices()[0]
    expect(lab.kind === 'launch-refused' && lab.refusal.text).toMatch(/^Lab is not signed in on /)
    forgetRemoteHelperTab('f2-lab')
    start('f2-blank', { profileId: 'profile-blank' })
    await until(() => notices().length === 2 && shown('f2-blank').includes('started nothing'))
    const blank = notices()[1]
    expect(blank.kind === 'launch-refused' && blank.refusal.text).toMatch(/^An account with no name is not signed in on /)
    forgetRemoteHelperTab('f2-blank')
  })

  // F2-2: main's Adopt sentence reaches the app log only when some id was not adopted.
  it('Adopt: main\'s sentence, which the app log keeps when some id was not adopted, names them so too', async () => {
    owners.set('profile-lab', OTHER_INSTALL)
    owners.set('profile-blank', OTHER_INSTALL)
    await readRemoteAccounts([MACHINE.did])
    folders.delete('profile-blank')
    const r = await adoptRemoteAccounts({ did: MACHINE.did, profileIds: ['profile-lab', 'profile-blank'] })
    expect(r).toMatchObject({ ok: false, adopted: ['profile-lab'], notAdopted: [{ profileId: 'profile-blank' }] })
    expect(r.message).toBe('Adopted Lab: its folder there is this computer\'s now. Not adopted: an account with no name: the account\'s folder on rocky.lan is not there any more.')
    expect(logs).toContain(`[remote-helper] Adopt on rocky.lan: profile-lab (${r.message})`)
  })
})

// Final review, round 3 (F3-1): a folder on the machine of an account this
// computer no longer holds (a read's `others`, or a folder of this install
// Remove's list did not name) is named as the Machines card names it, "an
// account no longer on this computer", or counted ("2 accounts no longer on
// this computer"), never by its profile id; and every list main writes is
// joined as the card joins it ("A, B and C").
describe('final review round 3 (F3-1): folders of accounts this computer no longer holds, and how lists join', () => {
  const ROCKY = 'Rocky (nick@rocky.lan:22)'
  const END = 'in your Claude account settings on claude.ai'
  beforeEach(() => {
    extraProfiles = [{ id: 'profile-blank' }]
    folders.set('profile-blank', signedIn('blank@example.com'))
  })

  it('Remove: the one it signed out is named so, after the accounts it holds, joined by "and"', async () => {
    plugIn()
    const list = realMachines()
    folders.set('profile-gone', signedIn('gone@example.com'))
    const [read] = await readRemoteAccounts([MACHINE.did])
    expect(read.others).toEqual(['profile-gone'])
    const r = await list.remove(MACHINE.did)
    expect(r.ok, r.message).toBe(true)
    expect(r.message).toBe(`Removed the session helper from ${ROCKY}. Signed out Personal, Side, an account with no name and an account no longer on this computer there first.`)
    expect([...folders.keys()]).toEqual([])
  })

  it('Remove: several are counted, in what it signed out and in what did not finish', async () => {
    plugIn()
    const list = realMachines()
    for (const id of ['profile-gone', 'profile-gone2', 'profile-gone3']) folders.set(id, signedIn(`${id}@example.com`))
    await readRemoteAccounts([MACHINE.did])
    untold.add('profile-blank')
    untold.add('profile-gone3')
    const r = await list.remove(MACHINE.did)
    expect(r.ok, r.message).toBe(true)
    expect(r.message).toBe(`Removed the session helper from ${ROCKY}. Signed out Personal, Side and 2 accounts no longer on this computer there first. Removed the sign-ins of an account with no name and an account no longer on this computer from it; Claude Code's sign-out there did not finish for them, so end those sign-ins ${END}.`)
    expect(r.message).not.toMatch(/profile-/)
  })

  it('Remove, the device folder already gone: what stays signed in there names it so, and counts several', async () => {
    plugIn()
    const list = realMachines()
    folders.set('profile-gone', signedIn('gone@example.com'))
    await readRemoteAccounts([MACHINE.did])
    deviceGone = true
    const r = await list.remove(MACHINE.did)
    expect(r.ok, r.message).toBe(true)
    expect(r.message).toBe(`Removed the session helper from ${ROCKY}. Personal, Side, an account with no name and an account no longer on this computer stay signed in on ${ROCKY} until you sign them out there, or end those sign-ins ${END}.`)
  })

  it('Remove, the device folder already gone, only such folders there: counted, with "stay"', async () => {
    plugIn()
    const list = realMachines()
    folders.clear()
    folders.set('profile-gone', signedIn('gone@example.com'))
    folders.set('profile-gone2', signedIn('gone2@example.com'))
    await readRemoteAccounts([MACHINE.did])
    deviceGone = true
    const r = await list.remove(MACHINE.did)
    expect(r.ok, r.message).toBe(true)
    expect(r.message).toBe(`Removed the session helper from ${ROCKY}. 2 accounts no longer on this computer stay signed in on ${ROCKY} until you sign them out there, or end those sign-ins ${END}.`)
  })

  it('Remove that stops: what it signed out first is named and counted as the rest', async () => {
    plugIn()
    const list = realMachines()
    folders.clear()
    for (const id of ['profile-personal', 'profile-blank', 'profile-gone', 'profile-gone2']) folders.set(id, signedIn(`${id}@example.com`))
    await readRemoteAccounts([MACHINE.did])
    stopListAfter = 3
    const r = await list.remove(MACHINE.did)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/^Nothing more was removed: the accounts signed in on Rocky \(nick@rocky\.lan:22\) could not all be signed out \(.+\)\. Signed out first: Personal, an account with no name and an account no longer on this computer\.$/)
    expect([...folders.keys()]).toEqual(['profile-gone2'])
  })

  it('Remove: folders of another install all for this computer\'s accounts are named and joined by "and"', async () => {
    plugIn()
    const list = realMachines()
    owners.set('profile-personal', OTHER_INSTALL)
    owners.set('profile-blank', OTHER_INSTALL)
    const r = await list.remove(MACHINE.did)
    expect(r.ok, r.message).toBe(true)
    expect(r.message).toContain(' Personal and an account with no name: their folders there carry another install\'s mark, and may be this computer\'s own from an earlier install of the app; they were left as they are.')
  })

  it('Remove: a folder of this install that no read found is named so, and left', async () => {
    plugIn()
    const list = realMachines()
    folders.set('profile-gone', signedIn('gone@example.com'))
    const r = await list.remove(MACHINE.did)
    expect(r.ok, r.message).toBe(true)
    expect(r.message).toContain(` An account no longer on this computer stays signed in there: sign it out there, or end that sign-in ${END}.`)
    expect(r.message).not.toContain('profile-gone')
    expect([...folders.keys()]).toEqual(['profile-gone'])
  })

  it('a row\'s Sign out of such a folder names it so', async () => {
    folders.set('profile-gone', signedIn('gone@example.com'))
    const r = await signOutRemoteAccount({ did: MACHINE.did, profileId: 'profile-gone' })
    expect(r.message).toBe(`Signed an account no longer on this computer out on ${ROCKY}, and removed its folder there.`)
    expect(folders.has('profile-gone')).toBe(false)
  })

  it('a tab on an account this computer does not hold: its note names it so, and offers the accounts signed in there', async () => {
    start('f3-gone', { profileId: 'profile-gone' })
    await until(() => notices().length === 1 && shown('f3-gone').includes('started nothing'))
    const n = notices()[0]
    expect(n.kind === 'launch-refused' && n.refusal.text).toBe(`This tab is on an account no longer on this computer, so it started nothing. Start it on an account that is signed in on ${ROCKY}.`)
    expect(n.kind === 'launch-refused' && n.refusal.signedInThere).toEqual(['profile-work', 'profile-personal'])
    expect(launchOf()).toBeNull()
    forgetRemoteHelperTab('f3-gone')
  })

  // Final review round 3 (F3-3): a full Adopt's log line names the ids it
  // adopted and nothing more; main's sentence goes there only when some id
  // was not adopted (the F2-2 test above).
  it('Adopt: its names joined by "and"; a full Adopt logs only the ids', async () => {
    extraProfiles = [{ id: 'profile-blank' }, { id: 'profile-lab', accountEmail: 'Lab@Example.com' }]
    aliases = { 'lab@example.com': 'Lab' }
    folders.set('profile-lab', signedIn('lab@example.com'))
    owners.set('profile-lab', OTHER_INSTALL)
    owners.set('profile-blank', OTHER_INSTALL)
    await readRemoteAccounts([MACHINE.did])
    const r = await adoptRemoteAccounts({ did: MACHINE.did, profileIds: ['profile-lab', 'profile-blank'] })
    expect(r).toMatchObject({ ok: true, adopted: ['profile-lab', 'profile-blank'] })
    expect(r.message).toBe('Adopted Lab and an account with no name: their folders there are this computer\'s now.')
    expect(logs.filter((l) => l.startsWith('[remote-helper] Adopt on '))).toEqual(['[remote-helper] Adopt on rocky.lan: profile-lab, profile-blank'])
  })
})

// A sign-in tab's whole note, as its terminal shows it.
const signInNote = (text: string) => `[This tab could not start through the session helper on rocky.lan: ${text}]`
// Phase 5 round 5 (R5-1): a sign-in tab on a folder with another install's
// mark, the machine not read yet: its own steps only, so it names Check once
// and adds no second "Press Check ... Sign in on this machine again".
const NOT_READ_NOTE = signInNote('the account\'s folder on rocky.lan carries another install\'s mark, and nothing of it was changed. Press Check on the Machines page: if the machine\'s card then says it may be this computer\'s own from an earlier install, choose Adopt on the machine\'s card, then Sign in on this machine again; if it is the app\'s on another computer, sign it in there from that computer.')
const checks = (text: string) => text.split('Press Check on the Machines page').length - 1

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
    // R5-1 (round 5): the whole note, its own next steps only.
    expect(shown(id)).toContain(NOT_READ_NOTE)
    expect(checks(shown(id))).toBe(1)
    expect(shown(id)).not.toMatch(/usual SSH path/)
    expect(launchOf()).toBeNull()
    forgetRemoteHelperTab(id)
  })
})

// Round 2 (R1): an old-marker folder of an account this computer does not
// hold, and this computer's own folders after its install id changed.
describe('round 2 (R1): Remove and a launch name folders of an earlier build or install', () => {
  it('Remove names an old-marker folder of an account this computer does not hold, and says folders of another install all named by this computer\'s accounts may be its own', async () => {
    plugIn()
    const list = realMachines()
    folders.set('profile-gone', signedIn('gone@example.com'))
    owners.set('profile-gone', OLD)
    owners.set('profile-personal', OTHER_INSTALL)
    const r = await list.remove(MACHINE.did)
    expect(r.ok, r.message).toBe(true)
    expect(r.message).toMatch(/Signed out Side there first\./)
    // Final review round 3 (F3-1): named as every surface names an account this computer does not hold.
    expect(r.message).toContain(' The folder an earlier build of the app made there for an account no longer on this computer stays signed in there as it is: sign it out there, or end that sign-in in your Claude account settings on claude.ai.')
    expect(r.message).not.toContain('profile-gone')
    expect(r.message).toMatch(/Personal: its folder there carries another install's mark, and may be this computer's own from an earlier install of the app; it was left as it is\./)
    expect([...folders.keys()]).toEqual(['profile-personal', 'profile-gone'])
  })

  it('a launch on an account whose folder there carries another install\'s mark starts nothing, and the refusal offers Adopt; Adopt then makes it this computer\'s and the tab starts', async () => {
    owners.set('profile-personal', OTHER_INSTALL)
    const id = 'acct-adoptable'
    start(id, { profileId: 'profile-personal' })
    await until(() => notices().length === 1)
    const n = notices()[0]
    expect(n).toMatchObject({ kind: 'launch-refused', refusal: { state: 'not-signed-in', adoptable: true } })
    expect(n.kind === 'launch-refused' && n.refusal.text).toMatch(/choose Adopt on the machine's card/)
    expect(ownerOf('profile-personal')).toBe(OTHER_INSTALL)
    forgetRemoteHelperTab(id)
    const adopted = await adoptRemoteAccounts({ did: MACHINE.did, profileIds: ['profile-personal'] })
    expect(adopted).toMatchObject({ ok: true, adopted: ['profile-personal'] })
    expect(ownerOf('profile-personal')).toBe(INSTALL)
    const id2 = 'acct-adopted'
    const pty = start(id2, { profileId: 'profile-personal' })
    await until(() => launchOf() !== null)
    expect(launchOf()?.env?.CLAUDE_CONFIG_DIR).toBe('/home/nick/.aicc/accounts/profile-personal')
    pty.kill()
    forgetRemoteHelperTab(id2)
  })

  it('a sign-in tab never makes over a folder with another install\'s mark: it says Adopt is the way', async () => {
    owners.set('profile-personal', OTHER_INSTALL)
    const id = 'signin-adoptable'
    start(id, { profileId: 'profile-personal', remoteAccountSignIn: true })
    await until(() => shown(id).includes('could not start'))
    // R5-1 (round 5): pinned whole; Check is named once.
    expect(shown(id)).toContain(NOT_READ_NOTE)
    expect(checks(shown(id))).toBe(1)
    expect(ownerOf('profile-personal')).toBe(OTHER_INSTALL)
    expect(launchOf()).toBeNull()
    forgetRemoteHelperTab(id)
  })
})

// Phase 5 round 4 (R4-2): a sign-in tab's note on a folder with another
// install's mark follows the one Adopt rule, from the machine's last read:
// read the machine first (as a Check does), then start the sign-in tab.
describe('round 4 (R4-2): a sign-in tab\'s note follows the machine\'s last read', () => {
  const note = signInNote

  // R5-1 (round 5): its own steps only. The Adopt dialog reads the machine
  // again, so the note asks for no Check after Adopt.
  it('every such folder there is for this computer\'s accounts: the note offers Adopt', async () => {
    owners.set('profile-personal', OTHER_INSTALL)
    const [read] = await readRemoteAccounts([MACHINE.did])
    expect(read).toMatchObject({ elsewhere: ['profile-personal'], mayBeEarlierInstall: true })
    const id = 'signin-earlier'
    start(id, { profileId: 'profile-personal', remoteAccountSignIn: true })
    await until(() => shown(id).includes('could not start'))
    expect(shown(id)).toContain(note('the account\'s folder on rocky.lan carries another install\'s mark, and nothing of it was changed. It may be this computer\'s own from an earlier install of the app: if so, choose Adopt on the machine\'s card on the Machines page, then choose Sign in on this machine again.'))
    expect(checks(shown(id))).toBe(0)
    expect(ownerOf('profile-personal')).toBe(OTHER_INSTALL)
    expect(launchOf()).toBeNull()
    forgetRemoteHelperTab(id)
  })

  it('another such folder there is for an account this computer does not hold: the note says another computer\'s, and offers no Adopt', async () => {
    owners.set('profile-personal', OTHER_INSTALL)
    folders.set('profile-theirs', signedIn('theirs@example.com'))
    owners.set('profile-theirs', OTHER_INSTALL)
    const [read] = await readRemoteAccounts([MACHINE.did])
    expect(read).toMatchObject({ elsewhere: ['profile-personal', 'profile-theirs'], mayBeEarlierInstall: false })
    const id = 'signin-theirs'
    start(id, { profileId: 'profile-personal', remoteAccountSignIn: true })
    await until(() => shown(id).includes('could not start'))
    // Its own steps only: a sign-in from here cannot help, so the note adds no Sign in on this machine.
    expect(shown(id)).toContain(note('the account\'s folder on rocky.lan is used by the app on another computer, and nothing of it was changed. Sign it in there from that computer, or start a tab on an account signed in there.'))
    expect(shown(id)).not.toMatch(/Adopt/)
    expect(shown(id)).not.toMatch(/Sign in on this machine/)
    expect(ownerOf('profile-personal')).toBe(OTHER_INSTALL)
    expect(launchOf()).toBeNull()
    forgetRemoteHelperTab(id)
  })
})
