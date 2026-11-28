/**
 * A tab through the session helper on another machine names the account its
 * CLI is signed in as (plan 2.1.3-beta.19, section 3; aicc_planning#434),
 * read on its host at every start, launch or attach, against section 1.1's
 * contract with a FAKE field mode: `aicc-helper field --file <path under
 * home> --key <dotted key>` prints the one string at that key (at most 1 KiB,
 * no control character) or nothing, and exits 0. File and key are named by
 * the provider package (Claude Code: `oauthAccount.emailAddress` of
 * `~/.claude.json`, the field the usual SSH status line reads), never
 * compiled into the script.
 *
 * - the `field` script runs that mode through the launcher (the helper's hash
 *   checked first), on the file's path relative to the home folder, as the
 *   field mode takes it (section 1.1's helper/src/field.rs path_under joins
 *   it to `$HOME`), and takes only plain names and a dotted key;
 * - readHostForStart, the one function every start runs: the host reads and
 *   the account field side by side; the account goes to the tab; a read that
 *   does not answer is "not read" and never fails the start; a host read
 *   that fails still does; a second start (a fake attach) reads the account
 *   again and the tab gets the new one.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { scriptCommand, scriptText, FIELD_VALUE_MAX } from '../../../src/main/remote-helper/scripts'
import { readHostForStart, fieldAnswerOf, hostFieldProblem, type HostAccountRead } from '../../../src/main/remote-helper/host-reads'
import { remoteLaunchOf } from '../../../src/main/remote-helper'
import { remoteSessionId } from '../../../src/main/remote-helper/session'
import { CLAUDE_ACCOUNT_FIELD, claudeRemoteLaunch } from '../../../src/main/providers/claude/remote-launch'
import type { ProviderRemoteLaunch } from '../../../src/main/providers/types'
import type { RemoteMachineRecord } from '../../../src/main/remote-helper/machines'
import type { SSHOptions } from '../../../src/main/ssh-options'
import { FakeSsh, result, type ExecCall, type FakeAnswer } from './fake-ssh'

const SHA = 'a'.repeat(64)
const FOLDER = `0.1.0-${SHA.slice(0, 12)}`
const MACHINE: RemoteMachineRecord = {
  did: '0123456789abcdef0123456789abcdef', host: 'rocky.lan', port: 22, user: 'nick', label: 'Rocky', addedAt: 1,
  os: 'Linux', arch: 'x86_64', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.local/bin/claude',
  path: '/home/nick/.local/bin:/usr/bin:/bin', lang: null, helper: { version: '0.1.0', sha256: SHA, folder: FOLDER }, check: { at: 1, ok: true },
}
const SSH_TAB: SSHOptions = { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~/work', detachable: false }
const INSTALL = 'f'.repeat(32)
const N = '0'.repeat(32)
const D = MACHINE.did
const I = INSTALL

/** The host's files the fake field mode reads, by their path under the home folder. */
let hostFiles: Record<string, unknown>
let logs: string[]
let told: HostAccountRead[]
let fieldAnswer: ((c: ExecCall) => FakeAnswer) | null

/** The fake field mode, as section 1.1's contract says: the one string at the key, or nothing; exit 0. */
function fakeFieldMode(c: ExecCall): FakeAnswer {
  const [nonce, , , , , file, key] = c.values
  let v: unknown = hostFiles[file]
  for (const part of key.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined
  const printed = typeof v === 'string' && Buffer.byteLength(v, 'utf8') <= 1024 && !/[\u0000-\u001f\u007f]/.test(v) ? `${v}\n` : ''
  return { stdout: `AICC-HASH ${nonce} ok ${SHA}\n${printed}`, code: 0 }
}

function host(reads: (c: ExecCall) => FakeAnswer = (c) => ({ stdout: result(c.values[0], {}) })): FakeSsh {
  return new FakeSsh({
    answer: (c) => {
      if (c.script === 'reads') return reads(c)
      if (c.script === 'field') return (fieldAnswer ?? fakeFieldMode)(c)
      return { code: 1 }
    },
  })
}

function planFor(via: ProviderRemoteLaunch = claudeRemoteLaunch) {
  return remoteLaunchOf(via, MACHINE, { ssh: SSH_TAB }, null, () => true, remoteSessionId('acct-tab'), 100, 30)
}

function ctx(ssh: FakeSsh) {
  return { runner: ssh, machine: MACHINE, installId: INSTALL, log: (m: string) => { logs.push(m) }, signals: { account: (r: HostAccountRead) => { told.push(r) } } }
}

beforeEach(() => {
  hostFiles = { '.claude.json': { oauthAccount: { emailAddress: 'nick@example.com' }, projects: { '/home/nick': {} } } }
  logs = []
  told = []
  fieldAnswer = null
})

describe('the field script (the helper\'s field mode, through the launcher)', () => {
  it('runs the field mode on the file\'s path relative to the home folder, after the helper\'s hash check, and writes nothing', () => {
    const t = scriptText('field')
    expect(t).not.toMatch(/['\\\r\n]/)
    expect(t).toContain('exec "$P" field --file "$Y" --key "$Z" </dev/null')
    // Never the home folder's real path ($h): where a folder above the home is
    // a link it is not $HOME as written, and the field mode takes an absolute
    // path only inside $HOME, so it would print nothing (field.rs path_under).
    expect(t).not.toContain('--file "$h/')
    expect(t.indexOf('echo "AICC-HASH $N ok $x"')).toBeLessThan(t.indexOf('exec "$P" field'))
    expect(t).toContain('[ "$x" = "$H" ] || { echo "AICC-HASH $N mismatch $x"; exit 97; }')
    expect(t).toContain('mk || no not-this-install')
    expect(t).not.toMatch(/\brm\b|mkdir|chmod|mv /)
    const cmd = scriptCommand('field', [N, D, I, FOLDER, SHA, '.claude.json', 'oauthAccount.emailAddress'])
    expect(cmd).toBe(`/bin/sh -c '${t}' aicc ${N} ${D} ${I} ${FOLDER} ${SHA} .claude.json oauthAccount.emailAddress`)
  })

  it('takes only plain names under the home folder and a dotted key: anything else is refused before ssh starts', () => {
    const bad: Array<[string, string]> = [
      ['../etc/passwd', 'a'], ['/etc/passwd', 'a'], ['a/../b', 'a'], ['.', 'a'], ['..', 'a'], ['a//b', 'a'], ['a b', 'a'], ['', 'a'], ['a/', 'a'],
      ['.claude.json', 'a..b'], ['.claude.json', 'a b'], ['.claude.json', '$(id)'], ['.claude.json', ''], ['.claude.json', '.a'], ['$HOME/x', 'a'],
    ]
    for (const [file, key] of bad) {
      expect(() => scriptCommand('field', [N, D, I, FOLDER, SHA, file, key]), `${file} ${key}`).toThrow()
      expect(hostFieldProblem({ file, key }), `${file} ${key}`).not.toBeNull()
    }
    expect(hostFieldProblem(CLAUDE_ACCOUNT_FIELD)).toBeNull()
    expect(hostFieldProblem({ file: '.config/x/settings.json', key: 'a.b_c-d' })).toBeNull()
    expect(hostFieldProblem(null)).not.toBeNull()
  })

  it('Claude Code\'s field is the one the usual SSH status line reads: ~/.claude.json, oauthAccount.emailAddress', () => {
    expect(claudeRemoteLaunch.accountField?.({ reconnect: false, cwd: '/home/nick', settings: null, tools: false }, MACHINE)).toEqual({ file: '.claude.json', key: 'oauthAccount.emailAddress' })
  })

  it('reads what the helper printed after the hash line: one string, nothing, or an answer that does not read', () => {
    expect(fieldAnswerOf(`rc text\nAICC-HASH ${N} ok ${SHA}\nnick@example.com\n`, N)).toEqual({ value: 'nick@example.com' })
    expect(fieldAnswerOf(`AICC-HASH ${N} ok ${SHA}\n`, N)).toEqual({ none: true })
    expect(fieldAnswerOf(`AICC-HASH ${N} ok ${SHA}\na\nb\n`, N)).toEqual({ bad: true })
    expect(fieldAnswerOf(`AICC-HASH ${N} ok ${SHA}\na\u001b[31mb\n`, N)).toEqual({ bad: true })
    expect(fieldAnswerOf(`AICC-HASH ${N} ok ${SHA}\n${'x'.repeat(FIELD_VALUE_MAX + 1)}\n`, N)).toEqual({ bad: true })
    expect(fieldAnswerOf(`AICC-HASH ${N} ok ${SHA}\n${'x'.repeat(FIELD_VALUE_MAX)}\n`, N)).toEqual({ value: 'x'.repeat(FIELD_VALUE_MAX) })
  })
})

describe('readHostForStart: every start reads the host files and the account side by side', () => {
  it('the label from the read: both execs run, the field exec names the provider\'s file and key, and the account goes to the tab once', async () => {
    const ssh = host()
    const got = await readHostForStart(ctx(ssh), planFor(), remoteSessionId('acct-tab'))
    expect(ssh.scripts()).toEqual(['reads', 'field'])
    const field = ssh.calls[1]
    expect(field.values.slice(1)).toEqual([D, I, FOLDER, SHA, '.claude.json', 'oauthAccount.emailAddress'])
    // Nothing of the file but the one field comes back; nothing goes on standard input.
    expect(field.stdin.length).toBe(0)
    expect(got.account).toEqual({ account: 'nick@example.com' })
    expect(told).toEqual([{ account: 'nick@example.com' }])
    // 2.1.3-beta.21: then the keybindings file of the folder the CLI uses (its paste key).
    expect(got.files.map((f) => f.path)).toEqual(['.claude/settings.json', '.claude/settings.json', '.claude/settings.local.json', '.claude/settings.local.json', '.claude/keybindings.json'])
  })

  it('a missing key or a missing file is no account; each exits 0 and prints nothing but the value', async () => {
    for (const files of [{ '.claude.json': { projects: {} } }, {}, { '.claude.json': { oauthAccount: { emailAddress: 42 } } }]) {
      hostFiles = files
      told = []
      const got = await readHostForStart(ctx(host()), planFor(), remoteSessionId('acct-tab'))
      expect(got.account).toEqual({ notShown: 'no-account' })
      expect(told).toEqual([{ notShown: 'no-account' }])
    }
  })

  it('a read that does not answer is not read, with one log line, and never fails the start', async () => {
    const cases: Array<[string, (c: ExecCall) => FakeAnswer]> = [
      ['a helper with no field mode (usage error, exit 2)', (c) => ({ stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\n`, stderr: 'unknown mode', code: 2 })],
      ['a hash mismatch', (c) => ({ stdout: `AICC-HASH ${c.values[0]} mismatch ${'b'.repeat(64)}\n`, code: 97 })],
      ['no hash line', () => ({ stdout: 'nick@example.com\n', code: 0 })],
      ['the host not reachable', () => ({ code: 255, stderr: 'ssh: connect to host rocky.lan port 22: Connection refused' })],
      ['two lines', (c) => ({ stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\nnick@example.com\nmore\n`, code: 0 })],
      ['a control character', (c) => ({ stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\nnick\u0007@example.com\n`, code: 0 })],
      ['over 1 KiB', (c) => ({ stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\n${'n'.repeat(1025)}\n`, code: 0 })],
    ]
    for (const [name, answer] of cases) {
      fieldAnswer = answer
      told = []
      logs = []
      const got = await readHostForStart(ctx(host()), planFor(), remoteSessionId('acct-tab'))
      expect(got.account, name).toEqual({ notShown: 'not-read' })
      expect(told, name).toEqual([{ notShown: 'not-read' }])
      expect(logs.filter((l) => l.includes('the account on rocky.lan was not read')), name).toHaveLength(1)
      expect(got.files, name).toHaveLength(5)
    }
  })

  it('a host read that fails still fails the start, as before, and no account goes to the tab', async () => {
    const ssh = host((c) => ({ stdout: result(c.values[0], {}, 'refused home-open-to-others') }))
    await expect(readHostForStart(ctx(ssh), planFor(), remoteSessionId('acct-tab'))).rejects.toThrow(/were not read/)
    expect(told).toEqual([])
  })

  it('set again at each start (a fake attach): a second start reads the account again, and the tab gets the new one', async () => {
    const sid = remoteSessionId('acct-tab')
    await readHostForStart(ctx(host()), planFor(), sid)
    // The host's Claude Code signed in as another account while the tab was away.
    hostFiles = { '.claude.json': { oauthAccount: { emailAddress: 'other@example.com' } } }
    const again = host()
    await readHostForStart(ctx(again), planFor(), sid)
    expect(again.scripts()).toEqual(['reads', 'field'])
    // Then it signed out.
    hostFiles = {}
    await readHostForStart(ctx(host()), planFor(), sid)
    expect(told).toEqual([{ account: 'nick@example.com' }, { account: 'other@example.com' }, { notShown: 'no-account' }])
  })

  it('a provider that names no account field reads none: the host reads alone, and the tab is told nothing', async () => {
    const { accountField: _none, ...noField } = claudeRemoteLaunch
    const ssh = host()
    const got = await readHostForStart(ctx(ssh), planFor(noField as ProviderRemoteLaunch), remoteSessionId('acct-tab'))
    expect(ssh.scripts()).toEqual(['reads'])
    expect(got.account).toBeUndefined()
    expect(told).toEqual([])
  })

  it('a field its provider names that cannot be asked for is not read, and no exec runs for it', async () => {
    const odd: ProviderRemoteLaunch = { ...claudeRemoteLaunch, accountField: () => ({ file: '../../etc/shadow', key: 'x' }) }
    const ssh = host()
    const got = await readHostForStart(ctx(ssh), planFor(odd), remoteSessionId('acct-tab'))
    expect(ssh.scripts()).toEqual(['reads'])
    expect(got.account).toEqual({ notShown: 'not-read' })
  })
})
