/**
 * Sign in on this machine (plan 2.1.3-beta.20, section 3): the accounts of
 * this computer as they are signed in on a Linux machine, against a FAKE
 * host (tests/unit/remote-helper/fake-ssh.ts) and the fixed scripts' text.
 * The scripts' run on a real sh is the remote-helper e2e job's on CI and the
 * host lines'.
 *
 * - each account's state from one read (3.1.5, 3.1.6): its own folder signed
 *   in as it, the machine's own sign-in as it, not signed in, its folder
 *   signed in as another account (marked, never used), not read;
 * - the launch's binding (3.1.7): its folder, the machine's own folder, or
 *   nothing, with the reason;
 * - the read takes only the fields on the helper's list, never a secret
 *   (3.1.2), and a stray field the host prints never reaches a shape;
 * - the account folder's links only ever point into ~/.claude (3.1.3);
 * - Sign out removes only its own folder (3.1.8).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  _resetHostAccountsForTest, accountBinding, accountFolder, accountsValues, factsOf, folderSignOuts, machineAccounts, prepareAccountFolder,
  readMachineAccounts, readSignIns, setHostAccountsListener, signInStateOf, signOutAllOnMachine, signOutOnMachine, settingsInput, type HostProfile,
} from '../../../src/main/remote-helper/host-accounts'
import { ACCOUNT_PROFILE_RE, PLAIN_NAMES_RE, scriptCommand, scriptText } from '../../../src/main/remote-helper/scripts'
import { CLAUDE_REMOTE_ACCOUNTS, claudeAccountField, claudeAccountSettingsText, claudeRemoteEnv } from '../../../src/main/providers/claude/remote-launch'
import { SHARED_DIR_NAMES } from '../../../src/shared/account-folder'
import { SHARED_DIR_NAMES as PROFILE_SHARED_DIR_NAMES } from '../../../src/main/account-profiles'
import type { RemoteAccounts } from '../../../src/main/providers/types'
import type { HostMachineAccounts, HostSignInFacts } from '../../../src/shared/host-accounts'
import type { RemoteMachineRecord } from '../../../src/main/remote-helper/machines'
import { FakeSsh, result, type ExecCall, type FakeAnswer } from './fake-ssh'

const SHA = 'a'.repeat(64)
const FOLDER = `0.1.0-${SHA.slice(0, 12)}`
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/usr/local/bin/claude',
  path: '/usr/local/bin:/usr/bin:/bin', lang: null, helper: { path: 'linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, folder: FOLDER }, check: { at: 1, ok: true },
}
const INSTALL = 'f'.repeat(32)
const PROFILES: HostProfile[] = [
  { id: 'profile-work', accountEmail: 'work@example.com', name: 'Work' },
  { id: 'profile-personal', accountEmail: 'Personal@Example.com', name: 'Personal' },
  { id: 'profile-side', accountEmail: 'side@example.com', name: 'Side' },
  { id: 'profile-fresh', accountEmail: 'fresh@example.com', name: 'Fresh' },
]
const VIA: RemoteAccounts = { ...CLAUDE_REMOTE_ACCOUNTS, profiles: async () => PROFILES }
const K = CLAUDE_REMOTE_ACCOUNTS.keys

/** What the helper's field mode prints for one sign-in's two files. */
type SignIn = { id?: Record<string, unknown> | null; cr?: Record<string, unknown> | null }
const signedIn = (email: string, plan = 'max'): SignIn => ({
  id: { [K.identity]: email },
  cr: { [K.plan]: plan, [K.tier]: `default_claude_${plan}_20x`, [K.expiresAt]: 1_764_000_000_000 },
})

/** The `accounts` exec's output, as the script prints it after the launcher's hash line. */
function accountsOut(nonce: string, own: SignIn, folders: Record<string, SignIn>): string {
  const lines = ['rc text from the login', `AICC-HASH ${nonce} ok ${SHA}`]
  const field = (slot: string, part: 'id' | 'cr', obj: Record<string, unknown> | null | undefined) => {
    lines.push(`AICC-FIELD ${nonce} ${slot} ${part}`)
    if (obj) lines.push(JSON.stringify(obj))
  }
  field('own', 'id', own.id)
  field('own', 'cr', own.cr)
  for (const [id, f] of Object.entries(folders)) { field(id, 'id', f.id); field(id, 'cr', f.cr) }
  lines.push(`AICC-RESULT ${nonce} end ok`)
  return `${lines.join('\n')}\n`
}

/**
 * A fake host's account folders, as the scripts change them: `accounts`
 * prints every folder's and the machine's own sign-in; `account` makes a
 * folder (make) or answers gone (refresh, none there); `signout` signs out
 * the folder it is named (and removes only it), every folder (all), or the
 * machine's own sign-in (own). The scripts' own text is checked below.
 */
class AccountsHost {
  own: SignIn = {}
  folders = new Map<string, SignIn>()
  logout = 0
  answer(c: ExecCall): FakeAnswer | null {
    const n = c.values[0]
    if (c.script === 'accounts') return { stdout: accountsOut(n, this.own, Object.fromEntries(this.folders)) }
    if (c.script === 'account') {
      const [, , , id, mode] = c.values
      if (!this.folders.has(id)) {
        if (mode !== 'make') return { stdout: result(n, { gone: 'yes' }) }
        this.folders.set(id, {})
      }
      return { stdout: result(n, {}) }
    }
    if (c.script === 'signout') {
      const [, , , kind, id] = c.values
      if (kind === 'own') { this.own = {}; return { stdout: result(n, { logout: String(this.logout) }) } }
      const ids = kind === 'all' ? [...this.folders.keys()] : [id]
      if (kind === 'folder' && !this.folders.has(id)) return { stdout: result(n, { gone: 'yes' }) }
      const lines: string[] = []
      for (const x of ids) { this.folders.delete(x); lines.push(`AICC-RESULT ${n} out ${x} ${this.logout}`, `AICC-RESULT ${n} removed ${x}`) }
      return { stdout: `${lines.join('\n')}${lines.length ? '\n' : ''}AICC-RESULT ${n} end ok\n` }
    }
    return null
  }
}

let tree: AccountsHost
let ssh: FakeSsh
let logs: string[]
const ctx = () => ({ runner: ssh, installId: INSTALL, log: (m: string) => { logs.push(m) }, now: () => 1000 })

beforeEach(() => {
  _resetHostAccountsForTest()
  tree = new AccountsHost()
  ssh = new FakeSsh({ answer: (c) => tree.answer(c) ?? { code: 1 } })
  logs = []
})

describe('each account\'s state from one read of the machine (3.1.5, 3.1.6)', () => {
  it('its folder signed in as it, the machine\'s own sign-in as it, not signed in, its folder signed in as another, a folder with no sign-in left', async () => {
    tree.own = signedIn('work@example.com')
    tree.folders.set('profile-personal', signedIn('personal@example.com', 'pro'))
    tree.folders.set('profile-side', signedIn('someone@example.org'))
    tree.folders.set('profile-fresh', { id: { [K.identity]: 'fresh@example.com' }, cr: null })
    tree.folders.set('profile-gone-here', signedIn('old@example.com'))
    const got = await readMachineAccounts(ctx(), MACHINE, VIA)
    expect(ssh.scripts()).toEqual(['accounts'])
    expect(got.ok).toBe(true)
    expect(got.readAt).toBe(1000)
    const by = Object.fromEntries(got.accounts.map((a) => [a.profileId, a]))
    // The machine's own sign-in is Work's, so Work runs on the machine's own folder there.
    expect(by['profile-work']).toEqual({ profileId: 'profile-work', state: 'machine-own', facts: { identity: 'work@example.com', plan: 'max', tier: 'default_claude_max_20x', expiresAt: 1_764_000_000_000, credentials: true }, folder: false })
    // Emails compare as the account chips compare them (case).
    expect(by['profile-personal'].state).toBe('signed-in-here')
    expect(by['profile-personal'].facts?.plan).toBe('pro')
    expect(by['profile-personal'].folder).toBe(true)
    // Signed in as another account: marked, with who it is, never taken for Side.
    expect(by['profile-side']).toMatchObject({ state: 'someone-else', folder: true, facts: { identity: 'someone@example.org' } })
    // A folder naming the account but holding no sign-in.
    expect(by['profile-fresh']).toEqual({ profileId: 'profile-fresh', state: 'not-signed-in', facts: null, folder: true })
    // A folder of an account this computer no longer holds.
    expect(got.others).toEqual(['profile-gone-here'])
    expect(got.own?.identity).toBe('work@example.com')
    // The values the read went with: the provider's files and keys, the helper's folder and hash.
    expect(ssh.calls[0].values.slice(1)).toEqual([MACHINE.did, INSTALL, ...accountsValues(MACHINE, VIA)])
    expect(ssh.calls[0].values.slice(5)).toEqual(['.claude.json', '.claude/.credentials.json', '.claude.json', '.credentials.json', 'oauthAccount.emailAddress', 'claudeAiOauth.subscriptionType,claudeAiOauth.rateLimitTier,claudeAiOauth.expiresAt'])
  })

  it('a folder signed in as one it does not name, and an account this computer knows no email for, are never matched', () => {
    const facts = (identity: string | null): HostSignInFacts => ({ identity, plan: 'max', tier: null, expiresAt: 5, credentials: true })
    expect(signInStateOf('a@example.com', facts(null), null).state).toBe('someone-else')
    expect(signInStateOf(undefined, facts('a@example.com'), null).state).toBe('someone-else')
    expect(signInStateOf('', facts('a@example.com'), null).state).toBe('someone-else')
    expect(signInStateOf(undefined, undefined, facts('a@example.com')).state).toBe('not-signed-in')
    // The machine's own sign-in counts only with its credentials there.
    expect(signInStateOf('a@example.com', undefined, { ...facts('a@example.com'), credentials: false }).state).toBe('not-signed-in')
    expect(signInStateOf('a@example.com', undefined, facts('A@Example.COM ')).state).toBe('machine-own')
    // Its own folder comes first: signed in there as itself, the folder is used.
    expect(signInStateOf('a@example.com', facts('a@example.com'), facts('a@example.com'))).toMatchObject({ state: 'signed-in-here', folder: true })
  })

  it('never read: every account `not-read` with no time; a read that did not answer: `not-read`, why, and the folders the last answer found', async () => {
    expect(machineAccounts(MACHINE.did, PROFILES)).toMatchObject({ readAt: null, ok: false, own: null, others: [] })
    expect(machineAccounts(MACHINE.did, PROFILES).accounts.every((a) => a.state === 'not-read' && !a.folder)).toBe(true)
    tree.folders.set('profile-personal', signedIn('personal@example.com'))
    await readMachineAccounts(ctx(), MACHINE, VIA)
    ssh.host = { answer: () => ({ code: 255, stderr: 'ssh: connect to host rocky.lan port 22: Connection refused' }) }
    const down = await readMachineAccounts(ctx(), MACHINE, VIA)
    expect(down.ok).toBe(false)
    expect(down.why).toMatch(/could not be reached/)
    expect(down.accounts.every((a) => a.state === 'not-read')).toBe(true)
    expect(down.accounts.find((a) => a.profileId === 'profile-personal')?.folder).toBe(true)
    // A helper that does not pass its hash check, or a refusal, is no answer either.
    ssh.host = { answer: (c) => ({ stdout: `AICC-HASH ${c.values[0]} mismatch ${'b'.repeat(64)}\n`, code: 97 }) }
    expect((await readMachineAccounts(ctx(), MACHINE, VIA)).why).toMatch(/hash check/)
    ssh.host = { answer: (c) => ({ stdout: result(c.values[0], {}, 'refused accounts-folder-not-private') }) }
    expect((await readMachineAccounts(ctx(), MACHINE, VIA)).why).toMatch(/not a private folder of yours/)
  })

  it('each read goes to the listener as it lands', async () => {
    const heard: HostMachineAccounts[] = []
    setHostAccountsListener((m) => heard.push(m))
    await readMachineAccounts(ctx(), MACHINE, VIA)
    expect(heard).toHaveLength(1)
    expect(heard[0].did).toBe(MACHINE.did)
  })
})

describe('the read takes the fields on the helper\'s list, never a secret (3.1.2)', () => {
  const fieldRs = readFileSync(resolve(__dirname, '../../../helper/src/field.rs'), 'utf8')
  const list = (name: string) => [...(new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`).exec(fieldRs)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1])
  const allowed = list('ALLOWED_KEYS')
  const secrets = list('SECRET_PARTS')

  it('every key the Claude package names is on the helper\'s own list, and none names a secret', () => {
    expect(secrets).toEqual(['accessToken', 'refreshToken'])
    expect(allowed.length).toBeGreaterThan(0)
    for (const key of Object.values(CLAUDE_REMOTE_ACCOUNTS.keys)) {
      expect(allowed, key).toContain(key)
      for (const part of key.split('.')) for (const s of secrets) expect(part.toLowerCase(), key).not.toBe(s.toLowerCase())
    }
    // The beta.19 label read's key too.
    expect(allowed).toContain(claudeAccountField({ reconnect: false, cwd: '/home/nick', settings: null, tools: false }, MACHINE)?.key)
  })

  it('a field the host prints that was not asked for never reaches a shape; a value that does not read is dropped', () => {
    const facts = factsOf(
      { [K.identity]: 'a@example.com', 'claudeAiOauth.accessToken': 'sk-ant-oat01-secret' },
      { [K.plan]: 'max', 'claudeAiOauth.refreshToken': 'sk-ant-ort01-secret', [K.expiresAt]: 12 },
      K,
    )
    expect(facts).toEqual({ identity: 'a@example.com', plan: 'max', tier: null, expiresAt: 12, credentials: true })
    expect(JSON.stringify(facts)).not.toMatch(/secret/)
    // An identity with a control or format character, or not one address; a plan that is not a word; an expiry that is not a whole number in range.
    for (const bad of ['a@b.c\u001b[31m', 'a‮@b.c', 'a b@c.d', 'no-at-sign', 'a@b@c', `${'x'.repeat(250)}@b.c`, 7]) expect(factsOf({ [K.identity]: bad }, null, K).identity, String(bad)).toBeNull()
    expect(factsOf(null, { [K.plan]: 'max plan', [K.tier]: 'x;y', [K.expiresAt]: -1 }, K)).toEqual({ identity: null, plan: null, tier: null, expiresAt: null, credentials: false })
    expect(factsOf(null, { [K.expiresAt]: 1.5 }, K).expiresAt).toBeNull()
    expect(factsOf(null, { [K.expiresAt]: Number.MAX_SAFE_INTEGER + 1 }, K).expiresAt).toBeNull()
  })

  it('the read keeps only its own header lines: another nonce, a slot of another shape, a header twice, a line that is not one object', () => {
    const n = '1'.repeat(32)
    const text = [
      `AICC-HASH ${n} ok ${SHA}`,
      `AICC-FIELD ${n} own id`, JSON.stringify({ [K.identity]: 'own@example.com' }),
      `AICC-FIELD ${n} own id`, JSON.stringify({ [K.identity]: 'second@example.com' }),
      `AICC-FIELD ${'2'.repeat(32)} profile-x id`, JSON.stringify({ [K.identity]: 'x@example.com' }),
      `AICC-FIELD ${n} ../etc id`, JSON.stringify({ [K.identity]: 'y@example.com' }),
      `AICC-FIELD ${n} Profile-Upper id`, JSON.stringify({ [K.identity]: 'z@example.com' }),
      `AICC-FIELD ${n} profile-a id`, '[1,2]',
      `AICC-FIELD ${n} profile-a cr`, '{not json',
      `AICC-FIELD ${n} profile-b xx`, '{}',
      `AICC-RESULT ${n} end ok`,
    ].join('\n')
    const got = readSignIns(text, n, K)
    expect(got.own?.identity).toBe('own@example.com')
    expect([...got.folders.keys()]).toEqual(['profile-a'])
    expect(got.folders.get('profile-a')).toEqual({ identity: null, plan: null, tier: null, expiresAt: null, credentials: false })
  })

  it('the accounts script reads each file only through the helper\'s field mode, after its hash check, and only in folders holding the app\'s marker', () => {
    const t = scriptText('accounts')
    expect(t).not.toMatch(/['\\\r\n]/)
    expect(t).toContain('fr() { echo "AICC-FIELD $N $1 $2"; "$P" field --file "$3" --keys "$4" </dev/null 2>/dev/null; }')
    expect(t.indexOf('echo "AICC-HASH $N ok $x"')).toBeLessThan(t.indexOf('fr own id'))
    expect(t).toContain('am "$B/$X" "$X" || continue')
    expect(t).toContain('aicc-account 1 $2')
    // It reads: no file is written, moved, linked or removed, and no file's bytes are printed by the script itself.
    expect(t).not.toMatch(/\brm\b|mkdir|chmod|\bmv\b|\bln\b|>\s*"|\bod\b/)
    expect(t.match(/\bhead\b[^;)]*/g)).toEqual(['head -c 200 "$1/.aicc-account" 2>/dev/null'])
    // A key list with a space or a quote, or a file that leaves home, is refused before ssh starts.
    const ok = [FOLDER, SHA, '.claude.json', '.claude/.credentials.json', '.claude.json', '.credentials.json', 'oauthAccount.emailAddress', 'a.b,c.d']
    expect(() => scriptCommand('accounts', ['0'.repeat(32), MACHINE.did, INSTALL, ...ok])).not.toThrow()
    for (const [i, bad] of [[6, 'a b'], [6, 'a,b;c'], [7, '$(id)'], [2, '../x'], [4, 'a/b'], [5, '..']] as Array<[number, string]>) {
      const values = [...ok]
      values[i] = bad
      expect(() => scriptCommand('accounts', ['0'.repeat(32), MACHINE.did, INSTALL, ...values]), bad).toThrow()
    }
  })
})

describe('the launch\'s binding (3.1.7): the config\'s account decides', () => {
  const read = async (): Promise<HostMachineAccounts> => readMachineAccounts(ctx(), MACHINE, VIA)
  beforeEach(() => {
    tree.own = signedIn('work@example.com')
    tree.folders.set('profile-personal', signedIn('personal@example.com'))
    tree.folders.set('profile-side', signedIn('someone@example.org'))
  })

  it('signed in in its folder: that folder; the machine\'s own sign-in: the machine\'s own folder', async () => {
    const acc = await read()
    expect(accountBinding(acc, 'profile-personal', MACHINE, 'Rocky', PROFILES)).toEqual({ via: 'folder', configDir: '/home/nick/.aicc/accounts/profile-personal' })
    expect(accountBinding(acc, 'profile-work', MACHINE, 'Rocky', PROFILES)).toEqual({ via: 'own' })
  })

  it('not signed in, signed in as another, not read, or an account this computer does not hold: nothing, with why and who is signed in there', async () => {
    const acc = await read()
    const fresh = accountBinding(acc, 'profile-fresh', MACHINE, 'Rocky', PROFILES)
    expect(fresh).toMatchObject({ refused: { state: 'not-signed-in', did: MACHINE.did, machineName: 'Rocky', profileId: 'profile-fresh', signedInThere: ['profile-work', 'profile-personal'] } })
    expect('refused' in fresh && fresh.refused.text).toMatch(/^Fresh is not signed in on Rocky/)
    const side = accountBinding(acc, 'profile-side', MACHINE, 'Rocky', PROFILES)
    expect(side).toMatchObject({ refused: { state: 'someone-else', identity: 'someone@example.org' } })
    expect('refused' in side && side.refused.text).toMatch(/signed in as someone@example\.org, another account/)
    expect(accountBinding(acc, 'profile-unknown', MACHINE, 'Rocky', PROFILES)).toMatchObject({ refused: { state: 'not-signed-in' } })
    ssh.host = { answer: () => ({ code: 255, stderr: 'Connection timed out' }) }
    expect(accountBinding(await read(), 'profile-personal', MACHINE, 'Rocky', PROFILES)).toMatchObject({ refused: { state: 'not-read', signedInThere: [] } })
  })

  it('the account\'s folder is under the home folder the check read, by its profile id only', () => {
    expect(accountFolder({ home: '/home/nick/' }, 'profile-a1')).toBe('/home/nick/.aicc/accounts/profile-a1')
    for (const bad of ['../x', 'Profile', 'a/b', '', 'a b', '-x', 'x'.repeat(129)]) expect(() => accountFolder(MACHINE, bad), bad).toThrow()
    expect(ACCOUNT_PROFILE_RE.test('profile-mt4okz66-147e4a')).toBe(true)
  })

  it('the CLI runs with that folder as its config folder, and without one on the machine\'s own sign-in', () => {
    const o = { reconnect: false, cwd: '/home/nick', settings: null, tools: false }
    expect(claudeRemoteEnv({ ...o, configDir: '/home/nick/.aicc/accounts/profile-personal' }).CLAUDE_CONFIG_DIR).toBe('/home/nick/.aicc/accounts/profile-personal')
    expect(claudeRemoteEnv(o)).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    // Its label is read from that folder's own file, the host's own otherwise.
    expect(claudeAccountField({ ...o, configDir: '/home/nick/.aicc/accounts/profile-personal' }, MACHINE)).toEqual({ file: '.aicc/accounts/profile-personal/.claude.json', key: 'oauthAccount.emailAddress' })
    expect(claudeAccountField(o, MACHINE)).toEqual({ file: '.claude.json', key: 'oauthAccount.emailAddress' })
    expect(claudeAccountField({ ...o, configDir: '/elsewhere/x' }, MACHINE)).toBeNull()
    expect(claudeAccountField({ ...o, configDir: '/home/nick/.aicc/accounts/p', signIn: {} }, MACHINE)).toBeNull()
  })
})

describe('the account\'s folder (3.1.3): its links only ever point into ~/.claude', () => {
  it('one shared-folder list for this computer and for machines, and the Claude package links those and CLAUDE.md, into ~/.claude', () => {
    expect(PROFILE_SHARED_DIR_NAMES).toBe(SHARED_DIR_NAMES)
    expect(CLAUDE_REMOTE_ACCOUNTS.links).toEqual({ home: '.claude', folders: SHARED_DIR_NAMES, files: ['CLAUDE.md'] })
    for (const n of [...CLAUDE_REMOTE_ACCOUNTS.links.folders, ...CLAUDE_REMOTE_ACCOUNTS.links.files]) expect(n, n).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  })

  it('every link is `ln -s "$G/<name>"` with G = $HOME/<the home config folder>, a plain name, and a link name that leaves it is refused', () => {
    const t = scriptText('account')
    expect(t).not.toMatch(/['\\\r\n]/)
    expect(t).toContain('G=$HOME/$R')
    expect(t).toContain('case "$R" in */*|.|..|"") no bad-home-folder;; esac')
    expect(t).toContain('lk() { t=$G/$1; e=$Q/$1;')
    expect(t.match(/\bln\b[^;]*/g)).toEqual(['ln -s "$t" "$e" || no cannot-link'])
    expect((t.match(/case "\$n" in \*\/\*\|\.\|\.\.\|""\) no bad-link-name;; esac/g) ?? []).length).toBe(2)
    // A folder made outside the account's own folder is only a shared one in ~/<home config folder>.
    for (const mk of t.match(/mkdir "[^"]*"/g) ?? []) expect(['mkdir "$B"', 'mkdir "$Q"', 'mkdir "$G"', 'mkdir "$G/$n"'], mk).toContain(mk)
    // It deletes nothing recursively; it replaces a link only (rm -f), and an empty folder only (rmdir).
    expect(t).not.toMatch(/rm -rf/)
    // The values: the home config folder and each name are plain names; anything that leaves is refused before ssh starts.
    const ok = ['profile-work', 'make', '.claude', 'projects,memory', 'CLAUDE.md', 'settings.json', 'keep']
    expect(() => scriptCommand('account', ['0'.repeat(32), MACHINE.did, INSTALL, ...ok])).not.toThrow()
    for (const [i, bad] of [[2, '../x'], [2, '.'], [2, 'a/b'], [3, 'projects,../etc'], [3, 'a/b'], [3, '..'], [4, '.'], [5, '../settings.json'], [0, 'Profile'], [1, 'remove'], [6, '-1']] as Array<[number, string]>) {
      const values = [...ok]
      values[i] = bad
      expect(() => scriptCommand('account', ['0'.repeat(32), MACHINE.did, INSTALL, ...values]), `${i} ${bad}`).toThrow()
    }
    expect(PLAIN_NAMES_RE.test(SHARED_DIR_NAMES.join(','))).toBe(true)
  })

  it('a sign-in makes the folder and leaves its settings copy; a launch refreshes it with the sanitised copy, and a folder gone since answers gone', async () => {
    expect((await prepareAccountFolder(ctx(), MACHINE, VIA, 'profile-work', 'make', 'keep')).ok).toBe(true)
    expect(ssh.calls[0].values.slice(3)).toEqual(['profile-work', 'make', '.claude', SHARED_DIR_NAMES.join(','), 'CLAUDE.md', 'settings.json', 'keep'])
    expect(ssh.calls[0].stdin.length).toBe(0)
    const copy = claudeAccountSettingsText([{ from: 'home', path: '.claude/settings.json', content: JSON.stringify({ apiKeyHelper: '/bin/key', env: { ANTHROPIC_API_KEY: 'x', EDITOR: 'vim' }, theme: 'dark' }) }])
    expect(copy).not.toBeNull()
    expect(JSON.parse(copy as string)).toEqual({ env: { EDITOR: 'vim' }, theme: 'dark' })
    expect((await prepareAccountFolder(ctx(), MACHINE, VIA, 'profile-work', 'refresh', copy)).ok).toBe(true)
    expect(ssh.calls[1].values[9]).toBe(String(Buffer.byteLength(copy as string)))
    expect(ssh.calls[1].stdin.toString()).toBe(copy)
    expect(await prepareAccountFolder(ctx(), MACHINE, VIA, 'profile-other', 'refresh', null)).toMatchObject({ ok: false, gone: true })
    expect(ssh.calls[2].values[9]).toBe('0')
    expect(settingsInput('')).toEqual({ value: '0' })
    expect(() => settingsInput('x'.repeat(600 * 1024))).toThrow()
  })
})

describe('Sign out (3.1.8): the CLI\'s own sign-out in that folder, then only that folder goes', () => {
  it('the script\'s one recursive delete is the account\'s own folder, by the accounts folder and the profile id, after the marker check', () => {
    const t = scriptText('signout')
    expect(t).not.toMatch(/['\\\r\n]/)
    expect(t.match(/rm -rf[^;]*/g)).toEqual(['rm -rf -- "${B:?}/${P:?}" || no cannot-remove'])
    expect(t).toContain('B=$HOME/.aicc/accounts')
    const del = t.indexOf('rm -rf')
    const loop = t.lastIndexOf('for P in $L; do case "$P" in [!a-z0-9]*|*[!a-z0-9-]*|"") continue;; esac; Q=$B/$P; am "$Q" "$P" || continue;', del)
    expect(loop).toBeGreaterThan(-1)
    expect(loop).toBeLessThan(del)
    // The sign-out runs first, in that folder: its config variable set to it.
    expect(t.indexOf('export "$E=$Q"; lo "$@"; r out "$P" $?')).toBeLessThan(del)
    // The machine's own sign-in: the variable unset, nothing removed.
    expect(t).toContain('if [ "$O" = own ]; then unset "$E"; lo "$@"; r logout $?; r end ok; exit 0; fi')
    // Its words go as arguments of the login shell, never as text it parses.
    expect(t).toContain('"$S" -ilc "exec ${v}0 ${v}@" "$X" "$@"')
    for (const [i, bad] of [[0, 'every'], [1, '../x'], [2, 'lower_case'], [3, 'Claude'], [4, 'auth logout'], [4, 'auth,$(id)']] as Array<[number, string]>) {
      const values = ['folder', 'profile-work', 'CLAUDE_CONFIG_DIR', 'claude', 'auth,logout']
      values[i] = bad
      expect(() => scriptCommand('signout', ['0'.repeat(32), MACHINE.did, INSTALL, ...values]), `${i} ${bad}`).toThrow()
    }
  })

  it('a sign-out names only its own folder, and its neighbours stay', async () => {
    tree.folders.set('profile-work', signedIn('work@example.com'))
    tree.folders.set('profile-personal', signedIn('personal@example.com'))
    tree.folders.set('profile-side', signedIn('side@example.com'))
    const run = await signOutOnMachine(ctx(), MACHINE, VIA, { profileId: 'profile-personal' })
    expect(run).toEqual({ ok: true, logout: 0, removed: true, gone: false })
    expect(ssh.calls[0].values.slice(3)).toEqual(['folder', 'profile-personal', 'CLAUDE_CONFIG_DIR', 'claude', 'auth,logout'])
    expect([...tree.folders.keys()]).toEqual(['profile-work', 'profile-side'])
    expect(await signOutOnMachine(ctx(), MACHINE, VIA, { profileId: 'profile-personal' })).toEqual({ ok: true, logout: null, removed: false, gone: true })
    expect(await signOutOnMachine(ctx(), MACHINE, VIA, { profileId: '../profile-work' })).toMatchObject({ ok: false })
    expect(ssh.calls).toHaveLength(2)
    // The machine's own sign-in: `own`, no profile id.
    tree.own = signedIn('work@example.com')
    tree.logout = 1
    expect(await signOutOnMachine(ctx(), MACHINE, VIA, 'own')).toEqual({ ok: true, logout: 1, removed: false, gone: false })
    expect(ssh.calls[2].values.slice(3, 5)).toEqual(['own', '-'])
    expect([...tree.folders.keys()]).toEqual(['profile-work', 'profile-side'])
  })

  it('Remove\'s sign-out of every folder there reads each folder\'s line, and one that stops says so', async () => {
    tree.folders.set('profile-work', signedIn('work@example.com'))
    tree.folders.set('profile-old', signedIn('old@example.com'))
    const all = await signOutAllOnMachine(ctx(), MACHINE, VIA)
    expect(all).toEqual({ ok: true, folders: [{ profileId: 'profile-work', logout: 0, removed: true }, { profileId: 'profile-old', logout: 0, removed: true }] })
    expect(tree.folders.size).toBe(0)
    const n = '3'.repeat(32)
    expect(folderSignOuts([`AICC-RESULT ${n} out profile-a 0`, `AICC-RESULT ${n} removed profile-a`, `AICC-RESULT ${n} out profile-b 1`, `AICC-RESULT ${n} out ../x 0`, `AICC-RESULT ${n} end refused cannot-remove`].join('\n'), n))
      .toEqual([{ profileId: 'profile-a', logout: 0, removed: true }, { profileId: 'profile-b', logout: 1, removed: false }])
    ssh.host = { answer: (c) => ({ stdout: `AICC-RESULT ${c.values[0]} out profile-a 0\nAICC-RESULT ${c.values[0]} end refused cannot-remove\n` }) }
    const stopped = await signOutAllOnMachine(ctx(), MACHINE, VIA)
    expect(stopped).toMatchObject({ ok: false, folders: [{ profileId: 'profile-a', logout: 0, removed: false }] })
    expect(stopped.why).toMatch(/could not be removed/)
  })
})
