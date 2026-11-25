/**
 * Remote step 1's device check (plan 2.1.3-beta.17, section A2, rule 35;
 * aicc_planning#411): the app's own remote-helper code, under Node, against a
 * real Linux host over real ssh, with key sign-in only.
 *
 * Where it runs: the dispatch-only `remote-helper-e2e` job of ci.yml (a
 * localhost sshd on GitHub's Linux runner: no host and no secret), and, for a
 * host line, from a test PC that has only ssh and scp, with that job's
 * artifact as its helper and fake CLI. It is not part of any other suite:
 * vitest.config.ts does not include tests/live, so it runs only as
 *   npx vitest run --config vitest.live.config.ts tests/live/remote-helper-device.live.ts --retry=0
 * and it fails, never skips, when what it needs is not given.
 *
 * What it takes, from the environment (no secret anywhere):
 *   REMOTE_HELPER_HOSTS     a JSON file: { "host": ..., "user": ..., "port": ... }
 *   REMOTE_HELPER_BIN       the static Linux helper (the job's build, or its artifact)
 *   REMOTE_HELPER_MANIFEST  its manifest, written by scripts/write-helper-manifest.mjs
 *                           as for the installer (the job's, or its artifact's)
 *   REMOTE_HELPER_FAKE_CLI  aicc-fake-cli for Linux; it is copied to a temporary
 *                           folder on the host for the session steps and removed after
 *   REMOTE_HELPER_EXPECT_RC '1' where the account's rc files were set up by the job:
 *                           a line printed by ~/.bashrc, and AICC_RC_MARK and a
 *                           `claude` on PATH that only an interactive login shell sees
 *   REMOTE_HELPER_OUT       a folder for the readings (optional)
 *
 * In order: Add (the question, then probe, upload by standard input, the hash
 * against the manifest, version, self-test); a second install's Remove
 * refused by the owner marker; a session holding the fake CLI through the
 * login shell (bytes in, output out, what the rc file exported), its link's
 * ssh killed at rest and the tab back on a new link; a shell session: a
 * resize read back by `stty`, then 20,000 lines printed while its bridge on
 * the host is stopped, its link's ssh killed, and the tab back with the
 * holder's replay, each line once; each closed tab's holder ended
 * (term.end); Remove; nothing left under ~/.aicc and no helper process of the
 * run left. The test's own execs read only what their command prints (an rc
 * file prints first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RemoteMachines, type MachineStore, type RemoteMachineRecord } from '../../src/main/remote-helper/machines'
import { nodeSshRunner, execArgv, sshEnv, type SshTarget } from '../../src/main/remote-helper/ssh-exec'
import { RemoteHelperPty, remoteLaunchSpec } from '../../src/main/remote-helper/session'
import { readBundledLinuxHelper, type BundledLinuxHelper } from '../../src/main/remote-helper/manifest'

const need = (name: string): string => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set: this check needs it (see the file's header)`)
  return v
}

const OUT = process.env.REMOTE_HELPER_OUT
const readings: Record<string, unknown> = {}
const note = (k: string, v: unknown) => { readings[k] = v }

let target: SshTarget
let helper: BundledLinuxHelper
let fakeCli: string
let remoteFakeDir = ''
/** A bridge the replay step stopped on the host, until it is let go. */
let stoppedBridge = ''
const runner = nodeSshRunner(() => 'ssh')
const expectRc = process.env.REMOTE_HELPER_EXPECT_RC === '1'

function memoryStore(): MachineStore {
  let v: unknown = null
  return { read: () => v, write: (x) => { v = JSON.parse(JSON.stringify(x)) } }
}

/** The line the test's own execs print before their command: what an rc file
 *  prints comes before it, and only what comes after it is read. */
const OWN = 'AICC-E2E-OWN'

/** One plain ssh exec for the test's own steps (not the app's): the same
 *  fixed options. `out` is the command's own output, after OWN. */
function sshRun(command: string, input?: Buffer): { code: number | null; out: string; err: string } {
  const args = execArgv(target, { version: null }, `echo ${OWN}; ${command}`)
  const r = spawnSync('ssh', args, { input: input ?? Buffer.alloc(0), env: sshEnv(process.env), timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
  const raw = String(r.stdout ?? '').replace(/\r\n/g, '\n')
  const at = raw.indexOf(`${OWN}\n`)
  return { code: r.status, out: at >= 0 ? raw.slice(at + OWN.length + 1) : '', err: String(r.stderr ?? '') }
}

/** The tab's logs, kept for the readings and read by the re-attach checks. */
const sessionLogs: string[] = []
const sessionLog = (line: string) => { sessionLogs.push(line); note(`session-log-${sessionLogs.length}`, line) }

async function until(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

let installs = 0
let inUse = 0
function machinesWith(store: MachineStore): RemoteMachines {
  installs++
  return new RemoteMachines({ runner, store, bundled: async () => ({ ok: true, helper }), inUse: () => inUse, log: (m) => { note(`log-${installs}-${Object.keys(readings).length}`, m) } })
}

let machines: RemoteMachines
let machine: RemoteMachineRecord
/** How many entries ~/.aicc held before the run (another install's folders stay). */
let aiccBefore = '0'
/** Whether the holders' run folder, /tmp/aicc-<uid>, was there before the run. */
let runDirBefore = ''

/** Poll a host command until it prints `want`. */
async function untilHost(what: string, command: string, want: string, ms = 10_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    const got = sshRun(command).out.trim()
    if (got === want) return
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what} (last: ${got})`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

beforeAll(async () => {
  const hosts = JSON.parse(fs.readFileSync(need('REMOTE_HELPER_HOSTS'), 'utf8')) as { host?: unknown; user?: unknown; port?: unknown }
  target = { host: String(hosts.host), user: String(hosts.user), port: Number(hosts.port ?? 22) }
  fakeCli = need('REMOTE_HELPER_FAKE_CLI')
  // The helper and its manifest as A1's scripts make them for the installer
  // (scripts/write-helper-manifest.mjs), read by the app's own reader: the
  // file's hash against the manifest's, its version and folder from it.
  const bundled = await readBundledLinuxHelper({ manifest: need('REMOTE_HELPER_MANIFEST'), file: need('REMOTE_HELPER_BIN') })
  if (!bundled.ok) throw new Error(`the helper and its manifest do not read: ${bundled.why}`)
  helper = bundled.helper
  const cargoVersion = /^version = "([^"]+)"/m.exec(fs.readFileSync(path.join(__dirname, '../../helper/Cargo.toml'), 'utf8'))![1]
  expect(helper.version).toBe(cargoVersion)
  const { version, sha256, size } = helper
  note('helper', { version, sha256, size })
  note('target', `${target.user}@${target.host}:${target.port}`)
  aiccBefore = sshRun('ls -A "$HOME/.aicc" 2>/dev/null | wc -l').out.trim() || '0'
  note('aicc-before', aiccBefore)
  runDirBefore = sshRun('test -e "/tmp/aicc-$(id -u)" && echo there || echo absent').out.trim()
  note('run-dir-before', runDirBefore)
  machines = machinesWith(memoryStore())
})

afterAll(() => {
  if (remoteFakeDir && /^\/[A-Za-z0-9._/-]+\/aicc-e2e\.[A-Za-z0-9]+$/.test(remoteFakeDir)) {
    // A bridge the replay step stopped is let go first, whatever failed.
    if (stoppedBridge) sshRun(`kill -CONT ${stoppedBridge} 2>/dev/null; true`)
    sshRun(`rm -f -- ${remoteFakeDir}/aicc-fake-cli ${remoteFakeDir}/ready ${remoteFakeDir}/go ${remoteFakeDir}/printed; rmdir -- ${remoteFakeDir}`)
  }
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, 'remote-helper-device.json'), `${JSON.stringify({ at: new Date().toISOString(), host: os.hostname(), readings }, null, 2)}\n`)
  }
})

describe('remote helper on a real Linux host', () => {
  it('adds the machine: the question first, then probe, upload, hash equal to the manifest, version and self-test', async () => {
    const configs = [{ id: 'e2e', label: 'e2e host', sessionType: 'ssh', sshConfig: { host: target.host, port: target.port, username: target.user } }]
    const q = await machines.prepare(configs, 'e2e')
    expect(q.ok, JSON.stringify(q)).toBe(true)
    if (!q.ok) return
    note('consent', q.text)
    const r = await machines.add(q.token)
    note('add', r)
    expect(r.ok, r.message).toBe(true)
    ;[machine] = machines.list()
    note('record', machine)
    expect(machine.os).toBe('Linux')
    expect(machine.helper.sha256).toBe(helper.sha256)
    if (expectRc) {
      // P6's fallback: claude is on the PATH an interactive login shell sets, not the exec's.
      expect(machine.claudePath).toMatch(/\/aicc-e2e-bin\/claude$/)
      expect(machine.check.ok, machine.check.detail).toBe(true)
    } else {
      expect(machine.check.ok || /Claude Code was not found/.test(machine.check.detail ?? '')).toBe(true)
    }
    // The file there is the installer's, by its hash, in its folder, owner-only.
    const there = sshRun(`sha256sum "$HOME/.aicc/${machine.did}/helper/${helper.folder}/aicc-helper"; stat -c %a "$HOME/.aicc" "$HOME/.aicc/${machine.did}" "$HOME/.aicc/${machine.did}/helper/${helper.folder}/aicc-helper"`)
    note('host-file', there.out)
    // The account's rc file prints a line first: only the command's own lines are read.
    const lines = there.out.split(/\r?\n/)
    expect(lines.find((l) => /^[0-9a-f]{64}\s/.test(l))?.slice(0, 64)).toBe(helper.sha256)
    expect(lines.filter((l) => /^[0-7]{3}$/.test(l))).toEqual(['700', '700', '700'])
  })

  it('a Check passes again with nothing uploaded', async () => {
    const r = await machines.check(machine.did)
    note('check', r)
    expect(r.ok, r.message).toBe(expectRc || r.ok)
  })

  it('another install\'s Remove of the same device stops at the owner marker, and the folder stays', async () => {
    // The same device id, recorded under another install's id.
    const store = memoryStore()
    store.write({ v: 1, installId: 'e'.repeat(32), machines: [machine] })
    const other = machinesWith(store)
    const r = await other.remove(machine.did)
    note('remove-other-install', r)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/another install/)
    expect(sshRun(`test -d "$HOME/.aicc/${machine.did}" && echo there`).out).toContain('there')
  })

  it('a session holds the fake CLI through the login shell: bytes in, output out, and what the rc file exported reaches it', async () => {
    const up = sshRun('umask 077; d=$(mktemp -d "${TMPDIR:-/tmp}/aicc-e2e.XXXXXXXX") && cat > "$d/aicc-fake-cli" && chmod 700 "$d/aicc-fake-cli" && echo "$d"', fs.readFileSync(fakeCli))
    remoteFakeDir = up.out.trim().split('\n').pop() ?? ''
    expect(remoteFakeDir, up.err).toMatch(/aicc-e2e\./)
    const m: RemoteMachineRecord = { ...machine, claudePath: `${remoteFakeDir}/aicc-fake-cli`, check: { at: Date.now(), ok: true } }
    inUse = 1
    const pty = new RemoteHelperPty({ appPtyId: 'e2e-tab-1', machine: m, installId: machines.installId(), runner, spec: remoteLaunchSpec(m, [], {}, '~', 100, 30), log: sessionLog })
    let out = ''
    pty.onData((d) => { out += d })
    try {
      await until('the fake CLI\'s banner', () => out.includes('FAKE-CLI READY'))
      pty.write('hello\r')
      await until('the echo', () => out.includes('echo: hello'))
      pty.write('pwd\r')
      await until('its folder', () => out.includes(`cwd: ${machine.home}`))
      if (expectRc) {
        pty.write('env AICC_RC_MARK\r')
        await until('the rc variable', () => out.includes('env AICC_RC_MARK=from-rc'))
      }
      // The link's ssh is killed at rest: the tab comes back on a new link by
      // itself, and what is typed after reaches the same program.
      const link = pty.linkPid
      expect(link).toBeGreaterThan(0)
      process.kill(link!)
      await until('a new link', () => pty.linkPid !== undefined && pty.linkPid !== link)
      pty.write('after\r')
      await until('input after the re-attach', () => out.includes('echo: after'))
      expect(sessionLogs.some((l) => /attaching again from [1-9][0-9]*$/.test(l))).toBe(true)
    } finally {
      pty.kill()
      await pty.ended
      inUse = 0
      if (OUT) fs.writeFileSync(path.join(OUT, 'session-1.txt'), out)
    }
    // A closed tab ends its holder (term.end): nothing of the session is left.
    await untilHost('the holder to end', `pgrep -f -- "--store $HOME/[.]aicc/${machine.did}/store" | wc -l`, '0')
  })

  it('a shell session: a resize reaches the program (stty), and a link dropped while output waits comes back with the replay, each line once', async () => {
    const m: RemoteMachineRecord = { ...machine, claudePath: '/bin/sh', check: { at: Date.now(), ok: true } }
    inUse = 1
    const pty = new RemoteHelperPty({ appPtyId: 'e2e-tab-2', machine: m, installId: machines.installId(), runner, spec: remoteLaunchSpec(m, [], {}, '~', 100, 30), log: sessionLog })
    let out = ''
    pty.onData((d) => { out += d })
    const d = remoteFakeDir
    expect(d).toMatch(/aicc-e2e\./)
    try {
      await new Promise((r) => setTimeout(r, 1500))
      pty.write('stty size\r')
      await until('the first size', () => /\b30 100\b/.test(out))
      pty.resize(120, 40)
      await new Promise((r) => setTimeout(r, 500))
      pty.write('stty size\r')
      await until('the new size', () => /\b40 120\b/.test(out))

      // The replay, made certain: the shell is told to wait for a file, the
      // link's bridge on the host is stopped (so nothing more reaches the
      // app), the shell prints 20,000 lines into the holder's ring, then the
      // link's ssh here is killed. The tab attaches again from the last byte
      // it saw, and the holder's replay brings every line, each once.
      pty.write(`touch ${d}/ready; while [ ! -e ${d}/go ]; do sleep 0.1; done; seq -f 'line %06g' 1 20000; echo flood' 'done; touch ${d}/printed\r`)
      await untilHost('the shell to wait', `test -e ${d}/ready && echo yes`, 'yes')
      const link = pty.linkPid
      expect(link).toBeGreaterThan(0)
      const pids = sshRun(`pgrep -f -- "bridge --store $HOME/[.]aicc/${machine.did}/store --session ${pty.sid}"`).out.trim().split(/\s+/).filter(Boolean)
      note('bridge-pids', pids)
      expect(pids).toHaveLength(1)
      stoppedBridge = pids[0]
      expect(sshRun(`kill -STOP ${stoppedBridge} && ps -o stat= -p ${stoppedBridge}`).out.trim()).toMatch(/^T/)
      sshRun(`touch ${d}/go`)
      await untilHost('the lines to be printed', `test -e ${d}/printed && echo yes`, 'yes', 30_000)
      expect(out).not.toContain('flood done')
      const seenBefore = (out.match(/line \d{6}/g) ?? []).length
      process.kill(link!)
      sshRun(`kill -CONT ${stoppedBridge} 2>/dev/null; true`)
      stoppedBridge = ''
      await until('the lines after the re-attach', () => out.includes('flood done'), 60_000)
      expect(pty.linkPid).not.toBe(link)
      const lines = out.match(/line \d{6}/g) ?? []
      note('replay', { seenBefore, lines: lines.length, distinct: new Set(lines).size })
      expect(new Set(lines).size).toBe(20000)
      expect(lines.length).toBe(20000)
      pty.write('echo typed after\r')
      await until('input after the replay', () => /\ntyped after/.test(out.replace(/\r/g, '')))
    } finally {
      pty.kill()
      await pty.ended
      inUse = 0
      if (OUT) fs.writeFileSync(path.join(OUT, 'session-2.txt'), out)
    }
    await untilHost('the holder to end', `pgrep -f -- "--store $HOME/[.]aicc/${machine.did}/store" | wc -l`, '0')
  })

  it('Remove takes it away: nothing of the run is left under ~/.aicc, and no helper process', async () => {
    const r = await machines.remove(machine.did)
    note('remove', r)
    expect(r.ok, r.message).toBe(true)
    // pgrep -f reads every process's command line: with the device folder's
    // path written out in the command, the shell running it on the host
    // matched, and so did this test's own ssh client when the host is this
    // machine (the CI job's localhost sshd; run 45336427954's reading lists
    // both). Kept as a reading, not a check, so the record shows such a match.
    note('self-match', sshRun(`pgrep -a -f -- "[.]aicc/${machine.did}"; test -e "$HOME/.aicc/${machine.did}" || true`).out)
    // So the device id is given as $D: this check's own command line never
    // holds ".aicc/<did>", and the processes it lists are the run's own.
    const left = sshRun(`D=${machine.did}; ls -A "$HOME/.aicc" 2>/dev/null | wc -l; test -e "$HOME/.aicc/$D" && echo there || echo gone; pgrep -a -f -- "[.]aicc/$D" || true`)
    note('left', left.out)
    // As many entries in ~/.aicc as before the run (none on a fresh account), the device folder gone, no process of the run.
    const [count, gone, ...procs] = left.out.trim().split('\n').map((l) => l.trim())
    expect([count, gone, procs]).toEqual([aiccBefore, 'gone', []])
    // The holders' run folder (/tmp/aicc-<uid>, made by Add's self-test): Remove
    // takes it away when it is empty, so a run that made it leaves none (vm:A2's
    // reading: it stayed, empty, after Remove). One that was there before the
    // run may hold another session's socket and is not checked.
    const runDirAfter = sshRun('test -e "/tmp/aicc-$(id -u)" && echo there || echo gone').out.trim()
    note('run-dir-after', runDirAfter)
    if (runDirBefore === 'absent') expect(runDirAfter).toBe('gone')
  })
})
