/**
 * Remote step 1's Add, Check and Remove (plan 2.1.3-beta.17, section A2;
 * aicc_planning#411), against a fake ssh (fake-ssh.ts): nothing is uploaded
 * without the user's yes; the host's hash is compared with the installer's
 * manifest, and a mismatch stops the Add and removes the upload (and what the
 * Add made); a failed self-test leaves the machine added but not checked;
 * Remove is refused while a tab or a held session runs there. The records
 * file: only a missing one is made (with a new install id); one that does not
 * read, or does not hold this install's records, is left as it is and every
 * use of it throws, so no added machine or install id is lost.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RemoteMachines, MACHINE_TEXT, RECORDS_UNREAD, fileStore, type MachineStore } from '../../../src/main/remote-helper/machines'
import type { BundledLinuxHelper } from '../../../src/main/remote-helper/manifest'
import { routeSshTab, ROUTE_WHY } from '../../../src/main/remote-helper/route'
import { REMOTE_OTHER_HELPER } from '../../../src/shared/remote-machines'
import { FakeSsh, result, type ExecCall, type FakeAnswer } from './fake-ssh'

const SHA = 'a'.repeat(64)
const HELPER: BundledLinuxHelper = { arch: 'x86_64', path: 'linux-x64/aicc-helper', file: '/x/linux-x64/aicc-helper', version: '0.1.0', sha256: SHA, size: 4096, folder: `0.1.0-${SHA.slice(0, 12)}` }
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

let inUse = 0
let logs: string[] = []
function machines(ssh: FakeSsh, store: MachineStore = memoryStore(), bundled: () => BundledLinuxHelper = () => HELPER) {
  return new RemoteMachines({
    runner: ssh,
    store,
    bundled: async () => ({ ok: true, helpers: [bundled()] }),
    readFile: async () => BYTES,
    inUse: () => inUse,
    log: (line) => { logs.push(line) },
  })
}

beforeEach(() => { inUse = 0; logs = [] })

describe('remote machines: the records file', () => {
  const ID = 'e'.repeat(32)
  /** A store holding `value`, its writes watched. */
  function holding(value: unknown) {
    const write = vi.fn()
    return { store: { read: () => value, write }, write }
  }

  it('a store whose read fails (a busy file): every use throws, and nothing is written', () => {
    const write = vi.fn()
    const busy = Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' })
    const m = machines(new FakeSsh(linuxHost()), { read: () => { throw busy }, write })
    expect(() => m.list()).toThrow('EBUSY')
    expect(() => m.installId()).toThrow('EBUSY')
    expect(write).not.toHaveBeenCalled()
  })

  const unread: Array<[string, unknown]> = [
    ['an empty object', {}],
    ['no install id', { v: 1, machines: [] }],
    ['an install id that is not one', { v: 1, installId: 'not-an-id', machines: [] }],
    ['no list of machines', { v: 1, installId: ID }],
    ['a list that is not one', { v: 1, installId: ID, machines: 'x' }],
    ['not an object', 'remote machines'],
  ]
  for (const [name, value] of unread) {
    it(`a records file holding ${name}: every use throws, and it is not written over`, () => {
      const { store, write } = holding(value)
      const m = machines(new FakeSsh(linuxHost()), store)
      expect(() => m.list()).toThrow(RECORDS_UNREAD)
      expect(() => m.installId()).toThrow(RECORDS_UNREAD)
      expect(() => m.findByTarget({ host: 'rocky.lan', port: 22, username: 'nick' })).toThrow(RECORDS_UNREAD)
      expect(write).not.toHaveBeenCalled()
    })
  }

  it('no records yet (null): the first use makes this install\'s id, once', () => {
    const store = memoryStore()
    const m = machines(new FakeSsh(linuxHost()), store)
    expect(m.list()).toEqual([])
    const id = m.installId()
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(store.value).toEqual({ v: 1, installId: id, machines: [] })
    expect(m.installId()).toBe(id)
  })

  describe('fileStore, on a real file', () => {
    let dir = ''
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rh-records-')) })
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })
    /** fileStore on `file`, its writes watched (they still run). */
    function onFile(file: string) {
      const real = fileStore(file)
      const write = vi.fn((v: Parameters<MachineStore['write']>[0]) => real.write(v))
      return { store: { read: real.read, write }, write }
    }

    it('a missing file reads as no records: the first use makes the file, with an install id', () => {
      const file = join(dir, 'data', 'remote-machines.json')
      expect(fileStore(file).read()).toBeNull()
      const m = machines(new FakeSsh(linuxHost()), onFile(file).store)
      const id = m.installId()
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, installId: id, machines: [] })
    })

    it('a file that does not parse throws, and its bytes are unchanged', () => {
      const file = join(dir, 'remote-machines.json')
      writeFileSync(file, 'not json')
      const { store, write } = onFile(file)
      expect(() => store.read()).toThrow()
      const m = machines(new FakeSsh(linuxHost()), store)
      expect(() => m.list()).toThrow()
      expect(write).not.toHaveBeenCalled()
      expect(readFileSync(file, 'utf8')).toBe('not json')
    })

    it('a path that cannot be read (a folder) throws, and nothing is written', () => {
      const file = join(dir, 'remote-machines.json')
      mkdirSync(file)
      const { store, write } = onFile(file)
      const m = machines(new FakeSsh(linuxHost()), store)
      expect(() => m.list()).toThrow()
      expect(write).not.toHaveBeenCalled()
      expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false)
    })

    it('a write then a read gives back the same records', () => {
      const file = join(dir, 'remote-machines.json')
      const value = { v: 1 as const, installId: ID, machines: [] }
      fileStore(file).write(value)
      expect(fileStore(file).read()).toEqual(value)
      expect(machines(new FakeSsh(linuxHost()), fileStore(file)).installId()).toBe(ID)
    })
  })
})

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
    // It names the account, host and port, as Remove does: two saved configs
    // for one host differ by account (the beta.17 release smoke).
    if (q.ok) expect(q.text.startsWith('Install the session helper on nick@rocky.lan:22? One file, ')).toBe(true)
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
    const route = routeSshTab({ platform: 'win32', switchOn: true, ssh: { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~', detachable: false }, shellOnly: false, machine: m.findByTarget({ host: 'rocky.lan', port: 22, username: 'nick' }), bundledSha256: () => SHA })
    expect(route).toEqual({ via: 'today', why: ROUTE_WHY.notChecked })
  })

  it('a machine that is not Linux on x86-64 or arm64 is not used, and nothing is uploaded to it', async () => {
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

  // 2.1.3-beta.19 section 1.2: closing the tab lets go of a session kept until
  // it is ended, and no clock ends it, so the refusal names End on the card.
  it('is refused while the helper there lists a session kept until it is ended, naming End on the card', async () => {
    const { ssh, m, did } = await added()
    ssh.host = linuxHost({ list: (c) => ({ stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\n{"v":1,"sessions":[{"v":1,"session":"rm0123456789abcdef0123456789abcd","label":"tab","pid":4242,"endpoint":"/tmp/aicc-1000/rm0123456789abcdef0123456789abcd-0123456789abcdef.sock","nonce":"${'c'.repeat(32)}","helper":"0.1.0","started":1,"away":null,"lifetime":"until-ended","attached":false,"child":"running","code":null}],"removed":0,"skipped":0}\n` }) })
    expect(await m.remove(did)).toEqual({
      ok: false,
      message: 'The session helper on this machine still holds a session. End it first: a session kept until it is ended is listed on this machine\'s card, with End; a plain SSH tab\'s ends when you close the tab, or two minutes after a lost connection.',
    })
    expect(ssh.scripts()).toEqual(['list'])
    expect(m.list()).toHaveLength(1)
    expect(MACHINE_TEXT.holds(2)).toBe('The session helper on this machine still holds 2 sessions. End them first: a session kept until it is ended is listed on this machine\'s card, with End; a plain SSH tab\'s ends when you close the tab, or two minutes after a lost connection.')
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
    // 2.1.3-beta.18 (plan section 3.2): last, the session folders whose holder is gone.
    expect(ssh.scripts()).toEqual(['probe', 'version', 'selftest', 'sweep'])
    expect(ssh.calls[3].values.slice(1)).toEqual([m.list()[0].did, m.installId(), HELPER.folder, SHA])
  })

  it('removes the session folders whose holder is gone (one log line with how many); a sweep that fails, or a count that does not read, changes nothing of its answer', async () => {
    const ssh = new FakeSsh(linuxHost())
    const m = machines(ssh)
    const q = await m.prepare(CONFIGS, 'cfg-key')
    if (!q.ok) throw new Error(q.message)
    await m.add(q.token)
    // Add sweeps nothing: a machine just added has no session.
    expect(ssh.scripts()).not.toContain('sweep')
    const did = m.list()[0].did
    const swept = (count: string) => (c: ExecCall): FakeAnswer => ({ stdout: `AICC-HASH ${c.values[0]} ok ${SHA}\n${result(c.values[0], { swept: count })}` })
    const cases: Array<[(c: ExecCall) => FakeAnswer, string[]]> = [
      [swept('2'), ['[remote-helper] rocky.lan: removed 2 session folder(s) whose holder is gone']],
      [swept('0'), []],
      [swept('2;x'), []],
      [(c) => ({ stdout: result(c.values[0], {}, 'refused sessions-folder-not-private') }), ['[remote-helper] rocky.lan: its session folders were not checked (the sessions folder there is not a private folder of yours)']],
      [() => ({ code: 255, stderr: 'Connection reset' }), ['[remote-helper] rocky.lan: its session folders were not checked (ssh could not connect to it)']],
      [() => ({ code: 0, stdout: 'nothing marked' }), ['[remote-helper] rocky.lan: its session folders were not checked (no answer)']],
    ]
    for (const [sweep, said] of cases) {
      ssh.host = linuxHost({ sweep })
      logs = []
      expect((await m.check(did)).ok).toBe(true)
      expect(logs.filter((l) => l.includes('session folder'))).toEqual(said)
    }
  })

  it('a machine holding another helper than this build\'s (after an update) reads not checked on its card, with the line that Check updates it', async () => {
    const ssh = new FakeSsh(linuxHost())
    const m = machines(ssh)
    const q = await m.prepare(CONFIGS, 'cfg-key')
    if (!q.ok) throw new Error(q.message)
    await m.add(q.token)
    const at = m.list()[0].check.at
    expect(m.views(() => SHA)[0]).toMatchObject({ checked: true, lastCheck: { at, ok: true } })
    expect(m.views(() => 'b'.repeat(64))[0]).toMatchObject({ checked: false, lastCheck: { at, ok: false, detail: REMOTE_OTHER_HELPER } })
    // A build with no Linux helper: nothing to compare with (the page says the build has none).
    expect(m.views(() => null)[0]).toMatchObject({ checked: true })
    // The routing agrees: its tabs take the usual path until Check.
    expect(routeSshTab({ platform: 'win32', switchOn: true, ssh: { host: 'rocky.lan', port: 22, username: 'nick', remotePath: '~', detachable: false }, shellOnly: false, machine: m.list()[0], bundledSha256: () => 'b'.repeat(64) })).toEqual({ via: 'today', why: ROUTE_WHY.oldHelper })
  })

  it('Check on a machine holding another helper installs this build\'s first (probe, install, commit, version, self-test), and the record takes its version, hash and folder', async () => {
    const NEW_SHA = 'c'.repeat(64)
    const NEW: BundledLinuxHelper = { arch: 'x86_64', path: 'linux-x64/aicc-helper', file: '/x/linux-x64/aicc-helper', version: '0.2.0', sha256: NEW_SHA, size: 4096, folder: `0.2.0-${NEW_SHA.slice(0, 12)}` }
    let bundled = HELPER
    const ssh = new FakeSsh(linuxHost())
    const m = machines(ssh, memoryStore(), () => bundled)
    const q = await m.prepare(CONFIGS, 'cfg-key')
    if (!q.ok) throw new Error(q.message)
    await m.add(q.token)
    // An update: the app now carries 0.2.0.
    bundled = NEW
    ssh.calls.length = 0
    ssh.host = linuxHost({
      install: (c) => ({ stdout: result(c.values[0], { hash: NEW_SHA }) }),
      version: (c) => ({ stdout: `AICC-HASH ${c.values[0]} ok ${NEW_SHA}\naicc-helper 0.2.0\n` }),
    })
    const r = await m.check(m.list()[0].did)
    expect(r.ok).toBe(true)
    // Then the sweep (2.1.3-beta.18 section 3.2), through the helper just put in place.
    expect(ssh.scripts()).toEqual(['probe', 'install', 'commit', 'version', 'selftest', 'sweep'])
    expect(ssh.calls[2].values.slice(3)).toEqual([NEW.folder, ssh.calls[1].values[0]])
    expect(ssh.calls[3].values.slice(3)).toEqual([NEW.folder, NEW_SHA])
    expect(ssh.calls[5].values.slice(3)).toEqual([NEW.folder, NEW_SHA])
    expect(m.list()[0].helper).toEqual({ path: 'linux-x64/aicc-helper', version: '0.2.0', sha256: NEW_SHA, folder: NEW.folder })
    expect(m.views(() => NEW_SHA)[0]).toMatchObject({ checked: true, helperVersion: '0.2.0' })
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

// Found by the beta.17 final-head review: with no ssh on this computer, Add
// and Check said the host did not answer its questions ("is /bin/sh there?")
// and Remove that it did not say whether the folder went: the real cause was
// in no answer and no log line.
describe('remote machines: no ssh on this computer', () => {
  const noSsh = () => { throw new Error('ssh was not found in a folder PATH names (ssh.exe).') }
  const named = /^rocky\.lan could not be reached: ssh could not be started on this computer/
  // The error ssh's start got goes to the log, so a blocked ssh.exe is told
  // from a missing one.
  const logged = (): string[] => logs.filter((l) => l === '[remote-helper] rocky.lan: ssh could not be started on this computer: ssh was not found in a folder PATH names (ssh.exe).')

  it('Add says ssh could not be started here, not that the host did not answer, logs why, and starts nothing', async () => {
    const ssh = new FakeSsh(linuxHost())
    const m = machines(ssh)
    const q = await m.prepare(CONFIGS, 'cfg-key')
    if (!q.ok) throw new Error(q.message)
    ssh.sshPath = noSsh
    const r = await m.add(q.token)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(named)
    expect(r.message).toMatch(/is its folder on PATH as a full path\? Restart the app after a change to PATH\)\.$/)
    expect(r.message).not.toMatch(/bin\/sh/)
    expect(logged()).toHaveLength(1)
    expect(ssh.calls).toHaveLength(0)
    expect(m.list()).toHaveLength(0)
  })

  it('Check and Remove of a machine added while ssh was there say the same, and the machine is kept', async () => {
    const ssh = new FakeSsh(linuxHost())
    const m = machines(ssh)
    const q = await m.prepare(CONFIGS, 'cfg-key')
    if (!q.ok) throw new Error(q.message)
    expect((await m.add(q.token)).ok).toBe(true)
    ssh.calls.length = 0
    ssh.sshPath = noSsh
    const did = m.list()[0].did
    const c = await m.check(did)
    expect(c.ok).toBe(false)
    expect(c.message).toMatch(/did not pass its check: rocky\.lan could not be reached: ssh could not be started on this computer/)
    expect(c.message).not.toMatch(/bin\/sh/)
    expect(logged()).toHaveLength(1)
    const r = await m.remove(did)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(named)
    expect(logged()).toHaveLength(2)
    expect(ssh.calls).toHaveLength(0)
    expect(m.list()).toHaveLength(1)
  })
})
