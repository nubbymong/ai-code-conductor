/**
 * Remote step 1's Add, Check and Remove (plan 2.1.3-beta.17, section A2;
 * aicc_planning#411), against a fake ssh (fake-ssh.ts): nothing is uploaded
 * without the user's yes; the host's hash is compared with the installer's
 * manifest, and a mismatch stops the Add and removes the upload (and what the
 * Add made); a failed self-test leaves the machine added but not checked;
 * Remove is refused while a tab or a held session runs there.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { RemoteMachines, MACHINE_TEXT, type MachineStore } from '../../../src/main/remote-helper/machines'
import type { BundledLinuxHelper } from '../../../src/main/remote-helper/manifest'
import { routeSshTab, ROUTE_WHY } from '../../../src/main/remote-helper/route'
import { FakeSsh, result, type ExecCall, type FakeAnswer } from './fake-ssh'

const SHA = 'a'.repeat(64)
const HELPER: BundledLinuxHelper = { file: '/x/linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, size: 4096, folder: `0.1.0-${SHA.slice(0, 12)}` }
const BYTES = Buffer.alloc(4096, 7)

const CONFIGS = [
  { id: 'cfg-key', label: 'Rocky', sessionType: 'ssh', sshConfig: { host: 'rocky.lan', port: 22, username: 'nick' } },
  { id: 'cfg-pass', label: 'Pi', sessionType: 'ssh', sshConfig: { host: 'pi.lan', port: 22, username: 'pi', hasPassword: true } },
  { id: 'cfg-win', label: 'Win', sessionType: 'ssh', sshConfig: { host: 'win.lan', port: 22, username: 'u', remoteOs: 'windows' } },
  { id: 'cfg-bad', label: 'Bad', sessionType: 'ssh', sshConfig: { host: 'bad host;rm', port: 22, username: 'u' } },
  { id: 'cfg-local', label: 'Local', sessionType: 'local' },
]

/** A Linux host that answers every script as asked; `over` changes one answer. */
function linuxHost(over: Partial<Record<ExecCall['script'], (c: ExecCall) => FakeAnswer>> = {}) {
  return {
    answer: (c: ExecCall): FakeAnswer => {
      const custom = over[c.script]
      if (custom) return custom(c)
      const n = c.values[0]
      switch (c.script) {
        case 'probe': return { stdout: `Welcome!\n${result(n, { os: 'Linux', arch: 'x86_64', home: '/home/nick', user: 'nick', shell: '/bin/bash', path: '/usr/bin:/bin', lang: 'C.UTF-8', claude: '', 'il-path': '/home/nick/.npm-global/bin:/usr/bin:/bin', 'il-claude': '/home/nick/.npm-global/bin/claude' })}` }
        case 'install': return { stdout: result(n, { hash: SHA }) }
        case 'commit': case 'discard': case 'remove': return { stdout: result(n, {}) }
        case 'version': return { stdout: `AICC-HASH ${n} ok ${SHA}\naicc-helper 0.1.0\n` }
        case 'selftest': return { stdout: `AICC-HASH ${n} ok ${SHA}\nAICC-RESULT ${n} {"ok":true,"helper":"0.1.0","checks":[{"name":"frames","ok":true}]}\n` }
        case 'list': return { stdout: `AICC-HASH ${n} ok ${SHA}\n{"v":1,"sessions":[],"removed":0,"skipped":0}\n` }
        default: return { code: 1 }
      }
    },
  }
}

function memoryStore(): MachineStore & { value: unknown } {
  const s = { value: null as unknown, read: () => s.value, write: (v: unknown) => { s.value = JSON.parse(JSON.stringify(v)) } }
  return s as MachineStore & { value: unknown }
}

let inUse = 0
function machines(ssh: FakeSsh, store = memoryStore()) {
  return new RemoteMachines({
    runner: ssh,
    store,
    bundled: async () => ({ ok: true, helper: HELPER }),
    readFile: async () => BYTES,
    inUse: () => inUse,
    log: () => {},
  })
}

beforeEach(() => { inUse = 0 })

describe('remote machines: the Add list', () => {
  it('offers each saved SSH config, and says why a password, Windows or broken one cannot be added', () => {
    const c = machines(new FakeSsh(linuxHost())).candidates(CONFIGS)
    expect(c.map((x) => [x.configId, x.addable])).toEqual([['cfg-key', true], ['cfg-pass', false], ['cfg-win', false], ['cfg-bad', false]])
    expect(c[1].why).toMatch(/password/)
    expect(c[2].why).toMatch(/Windows/)
    expect(c[3].why).toMatch(/host name/)
  })
})

describe('remote machines: nothing is uploaded without a yes', () => {
  it('Add with no token, a made-up token or a used token starts no ssh at all', async () => {
    const ssh = new FakeSsh(linuxHost())
    const m = machines(ssh)
    expect(await m.add(undefined)).toEqual({ ok: false, message: MACHINE_TEXT.noConsent })
    expect(await m.add('f'.repeat(32))).toEqual({ ok: false, message: MACHINE_TEXT.noConsent })
    const q = await m.prepare(CONFIGS, 'cfg-key')
    expect(q.ok).toBe(true)
    // The question names the file's size and hash and where it goes, and starts nothing.
    if (q.ok) expect(q.text).toContain(`SHA-256 ${SHA.slice(0, 12)}`)
    expect(ssh.calls).toHaveLength(0)
    if (!q.ok) return
    await m.add(q.token)
    const n = ssh.calls.length
    expect(n).toBeGreaterThan(0)
    expect(await m.add(q.token)).toEqual({ ok: false, message: MACHINE_TEXT.noConsent })
    expect(ssh.calls).toHaveLength(n)
  })

  it('a config that cannot be added gets no question', async () => {
    const m = machines(new FakeSsh(linuxHost()))
    expect((await m.prepare(CONFIGS, 'cfg-pass')).ok).toBe(false)
    expect((await m.prepare(CONFIGS, 'nope')).ok).toBe(false)
  })
})

describe('remote machines: Add', () => {
  it('probes, uploads by standard input, compares the hash with the manifest, commits, then version and self-test, and keeps a checked record', async () => {
    const ssh = new FakeSsh(linuxHost())
    const store = memoryStore()
    const m = machines(ssh, store)
    const q = await m.prepare(CONFIGS, 'cfg-key')
    if (!q.ok) throw new Error(q.message)
    const r = await m.add(q.token)
    expect(r.ok).toBe(true)
    expect(ssh.scripts()).toEqual(['probe', 'install', 'commit', 'version', 'selftest'])
    // The first connection takes a host key it does not know yet; later ones do not.
    expect(ssh.calls[0].args).toContain('StrictHostKeyChecking=accept-new')
    expect(ssh.calls[3].args).toContain('StrictHostKeyChecking=yes')
    // The file goes on standard input, exactly its bytes; its size is a value.
    const install = ssh.calls[1]
    expect(install.stdin.equals(BYTES)).toBe(true)
    expect(install.values[3]).toBe('4096')
    // commit names the install's nonce and the version-hash folder.
    expect(ssh.calls[2].values.slice(3)).toEqual([HELPER.folder, install.values[0]])
    const [rec] = m.list()
    expect(rec).toMatchObject({ host: 'rocky.lan', port: 22, user: 'nick', home: '/home/nick', shell: '/bin/bash', shellIsSh: true, claudePath: '/home/nick/.npm-global/bin/claude', path: '/home/nick/.npm-global/bin:/usr/bin:/bin', helper: { version: '0.1.0', sha256: SHA, folder: HELPER.folder }, check: { ok: true } })
    // Every exec of the machine names the same device id and this install's id.
    const did = rec.did
    expect(ssh.calls.every((c) => c.values[1] === did && c.values[2] === m.installId())).toBe(true)
    expect(m.candidates(CONFIGS)[0]).toMatchObject({ addable: false, why: 'Added already.' })
  })

  it('a hash that is not the manifest\'s stops the Add: the upload is removed, then the folder the Add made, and nothing is kept', async () => {
    const ssh = new FakeSsh(linuxHost({ install: (c) => ({ stdout: result(c.values[0], { hash: 'b'.repeat(64) }) }) }))
    const m = machines(ssh)
    const q = await m.prepare(CONFIGS, 'cfg-key')
    if (!q.ok) throw new Error(q.message)
    const r = await m.add(q.token)
    expect(r).toEqual({ ok: false, message: MACHINE_TEXT.hashMismatch('b'.repeat(64)) })
    expect(ssh.scripts()).toEqual(['probe', 'install', 'discard', 'remove'])
    // discard names the upload's own nonce.
    expect(ssh.calls[2].values[3]).toBe(ssh.calls[1].values[0])
    expect(m.list()).toEqual([])
  })

  it('a host with no hash tool gets nothing kept either', async () => {
    const ssh = new FakeSsh(linuxHost({ install: (c) => ({ stdout: result(c.values[0], { hash: 'none' }) }) }))
    const m = machines(ssh)
    const q = await m.prepare(CONFIGS, 'cfg-key')
    if (!q.ok) throw new Error(q.message)
    expect(await m.add(q.token)).toEqual({ ok: false, message: MACHINE_TEXT.noHashTool })
    expect(ssh.scripts()).toEqual(['probe', 'install', 'discard', 'remove'])
    expect(m.list()).toEqual([])
  })

  it('a failed self-test leaves the machine added but not checked, and its tabs take the usual path', async () => {
    const ssh = new FakeSsh(linuxHost({ selftest: (c) => ({ code: 1, stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\nAICC-RESULT ${c.values[0]} {"ok":false,"helper":"0.1.0","checks":[{"name":"pty","ok":false}]}\n` }) }))
    const m = machines(ssh)
    const q = await m.prepare(CONFIGS, 'cfg-key')
    if (!q.ok) throw new Error(q.message)
    const r = await m.add(q.token)
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/not checked/)
    const [rec] = m.list()
    expect(rec.check).toMatchObject({ ok: false, detail: 'its self-test failed (pty)' })
    const route = routeSshTab({ platform: 'win32', switchOn: true, ssh: { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~', detachable: false }, shellOnly: false, machine: m.findByTarget({ host: 'rocky.lan', port: 22, username: 'nick' }), bundledSha256: SHA })
    expect(route).toEqual({ via: 'today', why: ROUTE_WHY.notChecked })
  })

  it('a machine that is not Linux on x86-64 is not used, and nothing is uploaded to it', async () => {
    const ssh = new FakeSsh(linuxHost({ probe: (c) => ({ stdout: result(c.values[0], { os: 'Darwin', arch: 'arm64', home: '/Users/n', shell: '/bin/zsh', path: '/usr/bin' }) }) }))
    const m = machines(ssh)
    const q = await m.prepare(CONFIGS, 'cfg-key')
    if (!q.ok) throw new Error(q.message)
    expect(await m.add(q.token)).toEqual({ ok: false, message: MACHINE_TEXT.notLinux('Darwin', 'arm64') })
    expect(ssh.scripts()).toEqual(['probe'])
  })

  it('a refused key sign-in says so and uploads nothing', async () => {
    const ssh = new FakeSsh(linuxHost({ probe: () => ({ code: 255, stderr: 'nick@rocky.lan: Permission denied (publickey).' }) }))
    const m = machines(ssh)
    const q = await m.prepare(CONFIGS, 'cfg-key')
    if (!q.ok) throw new Error(q.message)
    const r = await m.add(q.token)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/key sign-in/)
    expect(ssh.scripts()).toEqual(['probe'])
  })
})

describe('remote machines: Remove', () => {
  async function added() {
    const ssh = new FakeSsh(linuxHost())
    const m = machines(ssh)
    const q = await m.prepare(CONFIGS, 'cfg-key')
    if (!q.ok) throw new Error(q.message)
    await m.add(q.token)
    ssh.calls.length = 0
    return { ssh, m, did: m.list()[0].did }
  }

  it('is refused while a tab runs through the helper there, with no ssh started', async () => {
    const { ssh, m, did } = await added()
    inUse = 2
    expect(await m.remove(did)).toEqual({ ok: false, message: MACHINE_TEXT.inUse(2) })
    expect(ssh.calls).toHaveLength(0)
    expect(m.list()).toHaveLength(1)
  })

  it('is refused while the helper there still lists a session', async () => {
    const { ssh, m, did } = await added()
    ssh.host = linuxHost({ list: (c) => ({ stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\n{"v":1,"sessions":[{"v":1,"session":"rm0123456789abcdef0123456789abcd","label":"tab","pid":4242,"endpoint":"/tmp/aicc-1000/rm0123456789abcdef0123456789abcd-0123456789abcdef.sock","nonce":"${'c'.repeat(32)}","helper":"0.1.0","started":1,"away":120,"attached":false,"child":"running","code":null}],"removed":0,"skipped":0}\n` }) })
    expect(await m.remove(did)).toEqual({ ok: false, message: MACHINE_TEXT.holds(1) })
    expect(ssh.scripts()).toEqual(['list'])
    expect(m.list()).toHaveLength(1)
  })

  it('lists, then runs the one removal script with this machine\'s device id and this install\'s id, and forgets it', async () => {
    const { ssh, m, did } = await added()
    const r = await m.remove(did)
    expect(r.ok).toBe(true)
    expect(ssh.scripts()).toEqual(['list', 'remove'])
    expect(ssh.calls[1].values.slice(1)).toEqual([did, m.installId()])
    expect(m.list()).toEqual([])
  })

  it('a removal the host refuses (another install\'s folder) keeps the record and says why', async () => {
    const { ssh, m, did } = await added()
    ssh.host = linuxHost({ remove: (c) => ({ stdout: result(c.values[0], {}, 'refused not-this-install') }) })
    const r = await m.remove(did)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/another install/)
    expect(m.list()).toHaveLength(1)
  })

  it('a device id that breaks its pattern starts nothing', async () => {
    const { ssh, m } = await added()
    expect((await m.remove('../x')).ok).toBe(false)
    expect((await m.remove('')).ok).toBe(false)
    expect((await m.check('ABC')).ok).toBe(false)
    expect(ssh.calls).toHaveLength(0)
  })
})

describe('remote machines: Check', () => {
  it('runs probe, version and self-test again, uploading nothing while the machine has this helper', async () => {
    const ssh = new FakeSsh(linuxHost())
    const m = machines(ssh)
    const q = await m.prepare(CONFIGS, 'cfg-key')
    if (!q.ok) throw new Error(q.message)
    await m.add(q.token)
    ssh.calls.length = 0
    const r = await m.check(m.list()[0].did)
    expect(r.ok).toBe(true)
    expect(ssh.scripts()).toEqual(['probe', 'version', 'selftest'])
  })

  it('a home folder that changed stops the machine until it is added again', async () => {
    const ssh = new FakeSsh(linuxHost())
    const m = machines(ssh)
    const q = await m.prepare(CONFIGS, 'cfg-key')
    if (!q.ok) throw new Error(q.message)
    await m.add(q.token)
    ssh.host = linuxHost({ probe: (c) => ({ stdout: result(c.values[0], { os: 'Linux', arch: 'x86_64', home: '/srv/other', shell: '/bin/bash', path: '/usr/bin' }) }) })
    const r = await m.check(m.list()[0].did)
    expect(r.ok).toBe(false)
    expect(m.list()[0].check.ok).toBe(false)
  })
})
