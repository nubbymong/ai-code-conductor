/**
 * An arm64 Linux helper, so a Raspberry Pi can be added (2.1.3-beta.19,
 * section 1.3; aicc_planning#438), against the fake ssh (fake-ssh.ts):
 * Add and Check take a machine whose `uname -m` is x86_64 or aarch64 through
 * the fixed table (manifest.ts LINUX_HELPER_ROWS). The host's answer only
 * selects a row and never forms a path; the row's file is the one uploaded,
 * checked against its own manifest entry, and the launcher's hash check and
 * the record use that entry. Any other architecture (armv7l, armhf, ...), or a
 * build without that row's file, is refused with its plain sentence and
 * nothing is uploaded. The question names both files with their sizes and
 * hashes, its token holds both hashes, and a file the question did not name is
 * never sent. The cards and the routing compare each machine with the entry
 * of its own architecture.
 *
 * Also the Pi's setup notes 1, 3, 6, 7 and 8 that name this code (Add, Check,
 * Remove and their fixed scripts): each is pinned here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHash } from 'crypto'
import { RemoteMachines, MACHINE_TEXT, consentText, type MachineStore, type RemoteMachineRecord } from '../../../src/main/remote-helper/machines'
import { LINUX_ARM64_HELPER_PATH, LINUX_HELPER_PATH, LINUX_HELPER_ROWS, linuxHelperRow, type BundledLinuxHelper } from '../../../src/main/remote-helper/manifest'
import { routeSshTab, ROUTE_WHY } from '../../../src/main/remote-helper/route'
import { scriptText, type ScriptName } from '../../../src/main/remote-helper/scripts'
import { REMOTE_OTHER_HELPER } from '../../../src/shared/remote-machines'
import { FakeSsh, result, type ExecCall, type FakeAnswer } from './fake-ssh'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const X64_BYTES = Buffer.alloc(3 * 1024 * 1024, 7)
const ARM_BYTES = Buffer.alloc(2_936_013, 9)
const X64_SHA = sha(X64_BYTES)
const ARM_SHA = sha(ARM_BYTES)
const helperOf = (arch: 'x86_64' | 'aarch64', bytes: Buffer, version = '0.1.0'): BundledLinuxHelper => {
  const s = sha(bytes)
  const path = arch === 'x86_64' ? LINUX_HELPER_PATH : LINUX_ARM64_HELPER_PATH
  return { arch, path, file: `/app/resources/helper/${path}`, version, sha256: s, size: bytes.length, folder: `${version}-${s.slice(0, 12)}` }
}
const X64 = helperOf('x86_64', X64_BYTES)
const ARM = helperOf('aarch64', ARM_BYTES)

const CONFIGS = [{ id: 'cfg-arm', label: 'Arm board', sessionType: 'ssh', sshConfig: { host: 'arm.lan', port: 22, username: 'dev' } }]

/** A Linux host of architecture `arch` that answers each fixed script as a real
 *  one would: the install reports the hash of the bytes that arrived. */
function host(arch: string, over: Partial<Record<ScriptName, (c: ExecCall) => FakeAnswer>> = {}) {
  return {
    answer: (c: ExecCall): FakeAnswer => {
      const custom = over[c.script]
      if (custom) return custom(c)
      const n = c.values[0]
      switch (c.script) {
        case 'probe': return { stdout: result(n, { os: 'Linux', arch, home: '/home/dev', user: 'dev', shell: '/bin/bash', path: '/usr/bin:/bin', lang: 'C.UTF-8', claude: '/usr/bin/claude' }) }
        case 'install': return { stdout: result(n, { hash: sha(c.stdin) }) }
        case 'commit': case 'discard': case 'remove': return { stdout: result(n, {}) }
        case 'version': return { stdout: `AICC-HASH ${n} ok ${c.values[4]}\naicc-helper 0.1.0\n` }
        case 'selftest': return { stdout: `AICC-HASH ${n} ok ${c.values[4]}\nAICC-RESULT ${n} {"ok":true,"helper":"0.1.0","checks":[{"name":"frames","ok":true}]}\n` }
        case 'list': return { stdout: `AICC-HASH ${n} ok ${c.values[4]}\n{"v":1,"sessions":[],"removed":0,"skipped":0}\n` }
        case 'sweep': return { stdout: `AICC-HASH ${n} ok ${c.values[4]}\n${result(n, { swept: '0' })}` }
        default: return { code: 1 }
      }
    },
  }
}

function memoryStore(): MachineStore & { value: unknown } {
  const s = { value: null as unknown, read: () => s.value, write: (v: unknown) => { s.value = JSON.parse(JSON.stringify(v)) } }
  return s as MachineStore & { value: unknown }
}

let logs: string[] = []
beforeEach(() => { logs = [] })

/** The machine list with this build's helpers (`helpers()`, asked at each use)
 *  and the file reader watched: it hands out only the two files there are. */
function machines(ssh: FakeSsh, helpers: () => BundledLinuxHelper[] = () => [X64, ARM], store: MachineStore = memoryStore()) {
  const files: Record<string, Buffer> = { [X64.file]: X64_BYTES, [ARM.file]: ARM_BYTES }
  const readFile = vi.fn(async (file: string) => {
    const b = files[file]
    if (!b) throw new Error(`ENOENT: ${file}`)
    return b
  })
  const m = new RemoteMachines({ runner: ssh, store, bundled: async () => ({ ok: true, helpers: helpers() }), readFile, inUse: () => 0, log: (l) => { logs.push(l) } })
  return { m, readFile, store }
}

async function addOn(m: RemoteMachines) {
  const q = await m.prepare(CONFIGS, 'cfg-arm')
  if (!q.ok) throw new Error(q.message)
  return m.add(q.token)
}

/** This build's SHA-256 for an architecture, as the handlers hand it to the
 *  cards and the routing (null: none for it). */
const bundledFor = (helpers: BundledLinuxHelper[]) => (arch: string) => helpers.find((h) => h.arch === arch)?.sha256 ?? null

describe('the fixed table', () => {
  it('has exactly two rows: x86_64 takes linux-x64/aicc-helper and aarch64 takes linux-arm64/aicc-helper', () => {
    expect(LINUX_HELPER_ROWS.map((r) => [r.arch, r.path, r.name, r.machine])).toEqual([
      ['x86_64', 'linux-x64/aicc-helper', 'x86-64', 62],
      ['aarch64', 'linux-arm64/aicc-helper', 'arm64', 183],
    ])
    expect(linuxHelperRow('aarch64')?.path).toBe('linux-arm64/aicc-helper')
    expect(linuxHelperRow('x86_64')?.path).toBe('linux-x64/aicc-helper')
    // Equality only: nothing near a row's name selects it.
    for (const other of ['arm64', 'AARCH64', ' aarch64', 'aarch64 ', 'aarch64_be', 'armv7l', 'armhf', 'x86_64/../linux-arm64', 'linux-arm64', '', null, undefined, 62]) expect(linuxHelperRow(other), String(other)).toBeNull()
  })
})

describe('Add takes the helper of the machine\'s own architecture', () => {
  it('a machine answering aarch64 gets linux-arm64/aicc-helper: its bytes on standard input, its folder and hash through the launcher, and the record names it', async () => {
    const ssh = new FakeSsh(host('aarch64'))
    const { m, readFile } = machines(ssh)
    const r = await addOn(m)
    expect(r).toEqual({ ok: true, message: 'Added arm.lan. Its self-test passed.' })
    expect(ssh.scripts()).toEqual(['probe', 'install', 'commit', 'version', 'selftest'])
    // Only the arm64 file is read and sent, exactly its bytes, with its size.
    expect(readFile.mock.calls.map((c) => c[0])).toEqual([ARM.file])
    const install = ssh.calls[1]
    expect(install.stdin.equals(ARM_BYTES)).toBe(true)
    expect(install.values[3]).toBe(String(ARM_BYTES.length))
    // It goes into the arm64 file's own folder, and the launcher checks it against the arm64 entry's hash.
    expect(ssh.calls[2].values[3]).toBe(ARM.folder)
    for (const c of ssh.calls.slice(3)) expect(c.values.slice(3), c.script).toEqual([ARM.folder, ARM_SHA])
    const [rec] = m.list()
    expect(rec).toMatchObject({ os: 'Linux', arch: 'aarch64', helper: { path: 'linux-arm64/aicc-helper', version: '0.1.0', sha256: ARM_SHA, folder: ARM.folder }, check: { ok: true } })
    // Its card reads this build's helper, and says the system it is.
    expect(m.views(bundledFor([X64, ARM]))[0]).toMatchObject({ checked: true, system: 'Linux aarch64' })
  })

  it('a machine answering x86_64 gets linux-x64/aicc-helper, as before', async () => {
    const ssh = new FakeSsh(host('x86_64'))
    const { m, readFile } = machines(ssh)
    expect((await addOn(m)).ok).toBe(true)
    expect(readFile.mock.calls.map((c) => c[0])).toEqual([X64.file])
    expect(ssh.calls[1].stdin.equals(X64_BYTES)).toBe(true)
    expect(ssh.calls[2].values[3]).toBe(X64.folder)
    expect(m.list()[0]).toMatchObject({ arch: 'x86_64', helper: { path: 'linux-x64/aicc-helper', sha256: X64_SHA, folder: X64.folder } })
  })

  // Pi note 1: older boards run 32-bit armhf; only x86_64 and aarch64 are taken.
  for (const arch of ['armv7l', 'armv6l', 'armhf', 'aarch64_be', 'arm64', 'i686', 'riscv64', 'x86_64/../linux-arm64', 'linux-arm64', 'AARCH64']) {
    it(`a machine answering ${JSON.stringify(arch)} is refused with its sentence after the probe, and nothing is read, uploaded or kept`, async () => {
      const ssh = new FakeSsh(host(arch))
      const { m, readFile } = machines(ssh)
      expect(await addOn(m)).toEqual({ ok: false, message: MACHINE_TEXT.notLinux('Linux', arch) })
      expect(MACHINE_TEXT.notLinux('Linux', arch)).toBe(`It is Linux on ${arch}. This preview adds Linux x86-64 or arm64 machines only.`)
      expect(ssh.scripts()).toEqual(['probe'])
      expect(readFile).not.toHaveBeenCalled()
      expect(m.list()).toEqual([])
    })
  }

  it('a build that carries no helper for the machine\'s architecture refuses it with its sentence, and uploads nothing', async () => {
    const ssh = new FakeSsh(host('aarch64'))
    const { m, readFile } = machines(ssh, () => [X64])
    expect(await addOn(m)).toEqual({ ok: false, message: MACHINE_TEXT.noArchHelper('arm64') })
    expect(MACHINE_TEXT.noArchHelper('arm64')).toBe('This build of the app carries no session helper for Linux arm64 machines, so nothing was installed on it.')
    expect(ssh.scripts()).toEqual(['probe'])
    expect(readFile).not.toHaveBeenCalled()
    expect(m.list()).toEqual([])
  })

  it('a helper handed out under the arm64 architecture but the x86-64 path is never taken for the arm64 row', async () => {
    const ssh = new FakeSsh(host('aarch64'))
    const wrong: BundledLinuxHelper = { ...X64, arch: 'aarch64' }
    const { m, readFile } = machines(ssh, () => [X64, wrong])
    expect(await addOn(m)).toEqual({ ok: false, message: MACHINE_TEXT.noArchHelper('arm64') })
    expect(readFile).not.toHaveBeenCalled()
    expect(ssh.scripts()).toEqual(['probe'])
  })
})

describe('the question names both files, and its token holds both hashes', () => {
  it('each file with its size and the first 12 of its SHA-256, and that the machine\'s own answer picks one; nothing reaches the machine', async () => {
    const ssh = new FakeSsh(host('aarch64'))
    const { m } = machines(ssh)
    const q = await m.prepare(CONFIGS, 'cfg-arm')
    expect(q).toEqual({ ok: true, token: expect.stringMatching(/^[0-9a-f]{32}$/), target: 'dev@arm.lan:22', text: consentText('dev@arm.lan:22', [X64, ARM]) })
    if (!q.ok) return
    expect(q.text).toBe(`Install the session helper on dev@arm.lan:22? One file, x86-64 (3.0 MB, SHA-256 ${X64_SHA.slice(0, 12)}) or arm64 (2.8 MB, SHA-256 ${ARM_SHA.slice(0, 12)}), whichever the machine says it is, into ~/.aicc in your account there. No root, no service: nothing runs when no session uses it. Remove takes it away.`)
    expect(ssh.calls).toHaveLength(0)
  })

  it('a build with one file names that one, and says only that kind of machine can be added', () => {
    expect(consentText('dev@arm.lan:22', [X64])).toBe(`Install the session helper on dev@arm.lan:22? One file, x86-64 (3.0 MB, SHA-256 ${X64_SHA.slice(0, 12)}) (this build carries no other, so only a Linux x86-64 machine can be added), into ~/.aicc in your account there. No root, no service: nothing runs when no session uses it. Remove takes it away.`)
  })

  it('an arm64 file that changed after the question is refused before the machine is reached', async () => {
    const ssh = new FakeSsh(host('aarch64'))
    let now = [X64, ARM]
    const { m, readFile } = machines(ssh, () => now)
    const q = await m.prepare(CONFIGS, 'cfg-arm')
    if (!q.ok) throw new Error(q.message)
    now = [X64, helperOf('aarch64', Buffer.alloc(2_936_013, 8))]
    expect(await m.add(q.token)).toEqual({ ok: false, message: MACHINE_TEXT.changed })
    expect(ssh.calls).toHaveLength(0)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('a file the question did not name is never sent: asked with the x86-64 file only, an arm64 machine gets nothing even once this build has the arm64 file', async () => {
    const ssh = new FakeSsh(host('aarch64'))
    let now = [X64]
    const { m, readFile } = machines(ssh, () => now)
    const q = await m.prepare(CONFIGS, 'cfg-arm')
    if (!q.ok) throw new Error(q.message)
    expect(q.text).not.toContain(ARM_SHA.slice(0, 12))
    now = [X64, ARM]
    expect(await m.add(q.token)).toEqual({ ok: false, message: MACHINE_TEXT.changed })
    expect(ssh.scripts()).toEqual(['probe'])
    expect(readFile).not.toHaveBeenCalled()
    expect(m.list()).toEqual([])
  })
})

describe('Check, the cards and the routing use the entry of the machine\'s own architecture', () => {
  const tab = { host: 'arm.lan', port: 22, username: 'dev', remotePath: '~', detachable: false }
  const route = (machine: RemoteMachineRecord, bundledSha256: (arch: string) => string | null) =>
    routeSshTab({ platform: 'win32', switchOn: true, ssh: tab, shellOnly: false, machine, bundledSha256 })

  it('an aarch64 machine holding the arm64 entry\'s hash routes through the helper and its card reads this build\'s helper; holding the x86-64 entry\'s it reads another helper', async () => {
    const ssh = new FakeSsh(host('aarch64'))
    const { m, store } = machines(ssh)
    expect((await addOn(m)).ok).toBe(true)
    const asked: string[] = []
    const both = (arch: string) => { asked.push(arch); return bundledFor([X64, ARM])(arch) }
    const [rec] = m.list()
    expect(route(rec, both)).toEqual({ via: 'helper', machine: rec })
    expect(asked).toEqual(['aarch64'])
    expect(m.views(both)[0]).toMatchObject({ checked: true })
    // The same machine holding the x86-64 file's hash (as a wrong install would).
    const f = store.value as { machines: RemoteMachineRecord[] }
    f.machines[0].helper = { ...f.machines[0].helper, sha256: X64_SHA }
    const [held] = m.list()
    expect(route(held, both)).toEqual({ via: 'today', why: ROUTE_WHY.oldHelper })
    expect(m.views(both)[0]).toMatchObject({ checked: false, lastCheck: { ok: false, detail: REMOTE_OTHER_HELPER } })
  })

  it('an x86_64 machine is compared with the x86-64 entry only', () => {
    const rec = { did: 'a'.repeat(32), host: 'arm.lan', port: 22, user: 'dev', label: 'x', addedAt: 1, os: 'Linux', arch: 'x86_64', home: '/home/dev', shell: '/bin/bash', shellIsSh: true, claudePath: '/usr/bin/claude', path: '/usr/bin', lang: null, helper: { path: LINUX_HELPER_PATH, version: '0.1.0', sha256: X64_SHA, folder: X64.folder }, check: { at: 1, ok: true } }
    expect(route(rec, bundledFor([X64, ARM]))).toEqual({ via: 'helper', machine: rec })
    expect(route({ ...rec, helper: { ...rec.helper, sha256: ARM_SHA } }, bundledFor([X64, ARM]))).toEqual({ via: 'today', why: ROUTE_WHY.oldHelper })
    // A build with no helper for that architecture sends the tab the usual way.
    expect(route(rec, bundledFor([ARM]))).toEqual({ via: 'today', why: ROUTE_WHY.noHelper })
  })

  it('Check of an aarch64 machine holding another helper installs the arm64 file first; holding this build\'s, it uploads nothing', async () => {
    const ssh = new FakeSsh(host('aarch64'))
    const { m, store, readFile } = machines(ssh)
    expect((await addOn(m)).ok).toBe(true)
    const did = m.list()[0].did
    ssh.calls.length = 0
    readFile.mockClear()
    expect(await m.check(did)).toEqual({ ok: true, message: 'arm.lan passed its check.' })
    expect(ssh.scripts()).toEqual(['probe', 'version', 'selftest', 'sweep'])
    expect(readFile).not.toHaveBeenCalled()
    // After an update that changed the arm64 helper: Check installs this build's.
    const f = store.value as { machines: RemoteMachineRecord[] }
    f.machines[0].helper = { ...f.machines[0].helper, sha256: 'c'.repeat(64), folder: `0.0.9-${'c'.repeat(12)}` }
    ssh.calls.length = 0
    expect((await m.check(did)).ok).toBe(true)
    expect(ssh.scripts()).toEqual(['probe', 'install', 'commit', 'version', 'selftest', 'sweep'])
    expect(readFile.mock.calls.map((c) => c[0])).toEqual([ARM.file])
    expect(ssh.calls[1].stdin.equals(ARM_BYTES)).toBe(true)
    expect(m.list()[0].helper).toEqual({ path: 'linux-arm64/aicc-helper', version: '0.1.0', sha256: ARM_SHA, folder: ARM.folder })
  })

  it('a record saved before 2.1.3-beta.19 (no architecture, no file named) reads x86_64 and linux-x64/aicc-helper, and is compared with the x86-64 entry', () => {
    const store = memoryStore()
    store.value = {
      v: 1, installId: 'f'.repeat(32),
      machines: [{ did: 'a'.repeat(32), host: 'old.lan', port: 22, user: 'dev', label: 'Old', addedAt: 1, os: 'Linux', home: '/home/dev', shell: '/bin/bash', shellIsSh: true, claudePath: null, path: '/usr/bin', lang: null, helper: { version: '0.1.0', sha256: X64_SHA, folder: X64.folder }, check: { at: 1, ok: true } }],
    }
    const { m } = machines(new FakeSsh(host('x86_64')), () => [X64, ARM], store)
    const [rec] = m.list()
    expect(rec).toMatchObject({ arch: 'x86_64', helper: { path: 'linux-x64/aicc-helper', sha256: X64_SHA } })
    expect(m.views(bundledFor([X64, ARM]))[0]).toMatchObject({ checked: true, system: 'Linux x86_64' })
  })
})

/**
 * The Pi's setup notes that name Add, Check and Remove (the fixed scripts they
 * run on the host and the ssh they run them with). Notes 2, 4, 5 and 9 are
 * the helper's own (helper/src, section 1.1).
 */
describe('the Pi\'s setup notes 3, 6, 7 and 8, as Add, Check and Remove run them', () => {
  const USED: ScriptName[] = ['probe', 'install', 'commit', 'discard', 'remove', 'version', 'selftest', 'list', 'sweep']

  it('they run exactly these fixed scripts, and the arm64 Add, Check and Remove run no other', async () => {
    const ssh = new FakeSsh(host('aarch64'))
    const { m } = machines(ssh)
    expect((await addOn(m)).ok).toBe(true)
    const did = m.list()[0].did
    await m.check(did)
    expect((await m.remove(did)).ok).toBe(true)
    for (const s of ssh.scripts()) expect(USED, s).toContain(s)
  })

  it('note 6: no privilege; everything they make or remove is under ~/.aicc/<device id>, but the holders\' own run folder, which only an empty private one is removed from', () => {
    for (const name of USED) {
      const text = scriptText(name)
      expect(text, name).not.toMatch(/\b(sudo|doas|pkexec|su|runuser|chown|chgrp|setcap)\b/)
      // A recursive delete names only the device folder or one of its session folders.
      for (const rm of text.match(/rm -rf -- "[^"]*"/g) ?? []) expect(['rm -rf -- "${HOME:?}/.aicc/${D:?}"', 'rm -rf -- "${A:?}/sessions/${X:?}"'], `${name}: ${rm}`).toContain(rm)
      for (const mk of text.match(/mkdir "[^"]*"/g) ?? []) expect(mk, name).toMatch(/^mkdir "\$(HOME\/\.aicc|A|A\/helper|T)"$/)
      for (const rd of text.match(/rmdir -- "[^"]*"/g) ?? []) expect(rd, name).toMatch(/^rmdir -- "(\$T|\$Q|\$HOME\/\.aicc|\/tmp\/aicc-\$u)"$/)
      // Every delete and every folder made is one of those: none is spelled another way.
      expect((text.match(/\brm -rf\b/g) ?? []).length, name).toBe((text.match(/rm -rf -- "[^"]*"/g) ?? []).length)
      expect((text.match(/\bmkdir\b/g) ?? []).length, name).toBe((text.match(/mkdir "[^"]*"/g) ?? []).length)
      expect((text.match(/\brmdir\b/g) ?? []).length, name).toBe((text.match(/rmdir -- "[^"]*"/g) ?? []).length)
    }
    // The device folder is the home's own: A is $HOME/.aicc/$D in every script.
    for (const name of USED) expect(scriptText(name), name).toContain('A=$HOME/.aicc/$D')
    // The run folder is removed only once it is the user's, 0700 (pv), and only by rmdir.
    expect(scriptText('remove')).toContain('pv "/tmp/aicc-$u" && rmdir -- "/tmp/aicc-$u" 2>/dev/null')
  })

  it('note 3: nothing relies on lingering: no systemd unit, no user runtime folder, no scheduler', () => {
    for (const name of USED) expect(scriptText(name), name).not.toMatch(/systemctl|systemd-run|loginctl|XDG_RUNTIME_DIR|\/run\/user|crontab|\bnohup\b|\bat\b -|\bdisown\b/)
  })

  it('note 7: no tmux and no other process is touched: nothing is ended, listed or adopted by name', () => {
    for (const name of USED) expect(scriptText(name), name).not.toMatch(/\b(tmux|screen|kill|pkill|killall|pgrep|pidof|ps|fuser)\b/)
  })

  it('note 8: no listener and no forwarding: every exec is one ssh with every forwarding cleared, and no script opens a port', async () => {
    const ssh = new FakeSsh(host('aarch64'))
    const { m } = machines(ssh)
    expect((await addOn(m)).ok).toBe(true)
    await m.check(m.list()[0].did)
    expect(ssh.calls.length).toBeGreaterThan(5)
    for (const c of ssh.calls) {
      expect(c.args, c.script).toContain('ClearAllForwardings=yes')
      expect(c.args, c.script).toContain('-T')
      for (const flag of ['-L', '-R', '-D', '-W', '-w', '-M', '-f', '-N']) expect(c.args, `${c.script} ${flag}`).not.toContain(flag)
    }
    for (const name of USED) expect(scriptText(name), name).not.toMatch(/\b(nc|ncat|socat|netcat|listen|bind)\b|\/dev\/tcp/)
  })
})
