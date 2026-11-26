/**
 * What a machine's Check reads of logind (plan 2.1.3-beta.19 section 1.2): the
 * probe reads logind's KillUserProcesses and KillExcludeUsers and the user's
 * Linger, as helper/probes/p3-p6-linux.cjs reads them, and the record keeps
 * them, read strictly; a value that does not read is kept as not read, so an
 * SSH Persistent tab there keeps the usual path, and the card says why. A
 * record no Check of this build wrote (beta.18's) has none, and reads the same.
 */
import { describe, it, expect } from 'vitest'
import { RemoteMachines, type MachineStore } from '../../../src/main/remote-helper/machines'
import type { BundledLinuxHelper } from '../../../src/main/remote-helper/manifest'
import { scriptText } from '../../../src/main/remote-helper/scripts'
import { FakeSsh, result, type ExecCall, type FakeAnswer } from './fake-ssh'

const SHA = 'a'.repeat(64)
const HELPER: BundledLinuxHelper = { arch: 'x86_64', path: 'linux-x64/aicc-helper', file: '/x/linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, size: 4096, folder: `0.1.0-${SHA.slice(0, 12)}` }
const CONFIGS = [{ id: 'cfg-key', label: 'Ubuntu', sessionType: 'ssh', sshConfig: { host: 'ubuntu.lan', port: 22, username: 'nick' } }]

function host(logind: Record<string, string>) {
  return {
    answer: (c: ExecCall): FakeAnswer => {
      const n = c.values[0]
      switch (c.script) {
        case 'probe': return { stdout: result(n, { os: 'Linux', arch: 'x86_64', home: '/home/nick', user: 'nick', shell: '/bin/bash', path: '/usr/bin:/bin', lang: 'C.UTF-8', claude: '/usr/bin/claude', ...logind }) }
        case 'install': return { stdout: result(n, { hash: SHA }) }
        case 'commit': case 'remove': return { stdout: result(n, {}) }
        case 'version': return { stdout: `AICC-HASH ${n} ok ${SHA}\naicc-helper 0.1.0\n` }
        case 'selftest': return { stdout: `AICC-HASH ${n} ok ${SHA}\nAICC-RESULT ${n} {"ok":true,"helper":"0.1.0","checks":[{"name":"frames","ok":true}]}\n` }
        case 'sweep': return { stdout: `AICC-HASH ${n} ok ${SHA}\n${result(n, { swept: '0' })}` }
        default: return { code: 1 }
      }
    },
  }
}

function memoryStore(): MachineStore & { value: unknown } {
  const s = { value: null as unknown, read: () => s.value, write: (v: unknown) => { s.value = JSON.parse(JSON.stringify(v)) } }
  return s as MachineStore & { value: unknown }
}

async function added(logind: Record<string, string>, store = memoryStore()) {
  const m = new RemoteMachines({ runner: new FakeSsh(host(logind)), store, bundled: async () => ({ ok: true, helpers: [HELPER] }), readFile: async () => Buffer.alloc(4096, 7), inUse: () => 0, log: () => {} })
  const q = await m.prepare(CONFIGS, 'cfg-key')
  if (!q.ok) throw new Error(q.message)
  const r = await m.add(q.token)
  expect(r.ok, r.message).toBe(true)
  return { m, store, record: m.list()[0] }
}

describe('the probe reads logind as the P3 probe does', () => {
  it('its script asks loginctl for the manager\'s KillUserProcesses and KillExcludeUsers and the user\'s Linger, writing nothing', () => {
    const t = scriptText('probe')
    expect(t).toContain('loginctl show-session -p KillUserProcesses --value')
    expect(t).toContain('loginctl show-session -p KillExcludeUsers --value')
    expect(t).toContain('loginctl show-user "$(id -un)" -p Linger --value')
  })
})

describe('the record keeps what it read', () => {
  it('KillUserProcesses no, Linger no (the owner\'s Raspberry Pi 5\'s defaults): kept, and the card has no note', async () => {
    const { m, record } = await added({ 'logind-kill': 'no', 'logind-exclude': 'root', linger: 'no' })
    expect(record.logind).toEqual({ kill: 'no', exclude: 'root', linger: 'no' })
    expect(m.views(() => SHA)[0].persistentNote).toBeUndefined()
  })

  it('KillUserProcesses yes: kept, and the card says SSH Persistent keeps the usual path, and why', async () => {
    const { m, record } = await added({ 'logind-kill': 'yes', 'logind-exclude': 'root', linger: 'yes' })
    expect(record.logind).toEqual({ kill: 'yes', exclude: 'root', linger: 'yes' })
    expect(m.views(() => SHA)[0].persistentNote).toContain('KillUserProcesses yes, Linger yes')
  })

  // 2.1.3-beta.19 section 1.2: this build's Check read nothing, and no Check
  // will read more there, so the card says why and asks for no Check.
  it('nothing read (no loginctl): kept as not read, and the card says logind gave no answer, with no Check asked for', async () => {
    const { m, record } = await added({ 'logind-kill': '', 'logind-exclude': '', linger: '' })
    expect(record.logind).toEqual({ kill: '', exclude: '', linger: '' })
    expect(m.views(() => SHA)[0].persistentNote).toBe('SSH Persistent tabs keep the usual SSH path here: its last check got no answer from logind (no loginctl there, or no logind).')
  })

  it('a value that is not one logind gives is kept as not read', async () => {
    const { record } = await added({ 'logind-kill': 'maybe; rm -rf', 'logind-exclude': 'root\u0007', linger: 'YES' })
    expect(record.logind).toEqual({ kill: '', exclude: '', linger: '' })
  })

  it('a saved record keeps it across a read, and one from beta.18 (none) reads with none', async () => {
    const { store } = await added({ 'logind-kill': 'no', 'logind-exclude': 'root', linger: 'no' })
    const again = new RemoteMachines({ runner: new FakeSsh(host({})), store, bundled: async () => ({ ok: true, helpers: [HELPER] }), inUse: () => 0, log: () => {} })
    expect(again.list()[0].logind).toEqual({ kill: 'no', exclude: 'root', linger: 'no' })
    const old = store.value as { machines: Array<Record<string, unknown>> }
    delete old.machines[0].logind
    expect(again.list()[0].logind).toBeUndefined()
    expect(again.views(() => SHA)[0].persistentNote).toContain('Press Check')
  })
})
