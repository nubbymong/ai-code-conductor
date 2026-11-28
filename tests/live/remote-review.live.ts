/**
 * A review on the machine a remote session runs on (2.1.3-beta.21 plan,
 * phase 6; aicc_planning#446): probes PV1 and PV2, the gate they decide, and
 * one codex_review from a Claude Code tab through the session helper, run on
 * that machine. The app's own code under Node, over real ssh with key sign-in
 * only, as tests/live/remote-helper-device.live.ts runs it.
 *
 * Where it runs:
 *   - the dispatch-only `remote-helper-e2e` job of ci.yml, after the device
 *     check, against the runner's localhost sshd, with the stand-in Codex the
 *     job puts on the account's login PATH (helper/probes/pv-codex-stand-in.cjs,
 *     REMOTE_REVIEW_CODEX=stand-in): its header says why not the real Codex;
 *   - a host line (Rocky, the Pi), from a test PC with ssh and that job's
 *     artifact, with the real Codex installed and signed in in the tester
 *     login (REMOTE_REVIEW_CODEX=real). helper/probes/README.md ("Probes PV1
 *     and PV2") says how. Never 192.168.50.185.
 * Run as
 *   npx vitest run --config vitest.live.config.ts tests/live/remote-review.live.ts --retry=0
 * It fails, never skips, when what it needs is not given.
 *
 * What it takes, from the environment (no secret anywhere):
 *   REMOTE_HELPER_HOSTS, REMOTE_HELPER_BIN, REMOTE_HELPER_MANIFEST,
 *   REMOTE_HELPER_FAKE_CLI   as the device check takes them
 *   REMOTE_REVIEW_CODEX      `stand-in` (CI) or `real` (a host line)
 *   REMOTE_HELPER_OUT        a folder for the readings (optional)
 *
 * In order:
 *   1. Add the machine: its Check reads where Codex is (the `-il` lookup), its
 *      version, the models its own picker lists there (PV1's last clause) and
 *      the exec's git.
 *   2. The gate shut: with no PASS recorded for the machine's architecture
 *      (the app build's REMOTE_REVIEW_PROVEN entry null), a review there is
 *      refused with the reason, and nothing is read or run there or on this
 *      computer.
 *   3. PV1: the run mode starts a program with no terminal; the review's argv
 *      (ADR-031's, the Codex package's) runs from one `ssh -T` exec with the
 *      prompt on standard input and JSON events out, read by the Codex
 *      package's reader. With the stand-in its record also shows the exact
 *      argv, the folder, the variables' names, no terminal, its own session
 *      and the helper's run mode as its parent.
 *   4. PV2: the host read gives byte for byte the same material as this
 *      computer's review-diff.ts for one fixture repository made the same on
 *      both (modes working, range and paths), and its bound holds (a change
 *      and files over 512 KB refused, never cut).
 *   5. Both passed: on a host line (REMOTE_REVIEW_CODEX=real) it prints the
 *      REMOTE_REVIEW_PROVEN entry to set for the machine's architecture (the
 *      Codex and git versions they passed with), for the commit that records
 *      the PASS in helper/probes/README.md; with the stand-in it prints none
 *      (a stand-in run proves no Codex). Nothing is written on the host.
 *   6. One codex_review from a Claude Code tab (the fake CLI as the tab's
 *      program, its tool server the session's mcp.json relay on the host),
 *      through the relay, the holder and the bridge to a tool host here that
 *      runs the app's remote review, given this run's PASS as its proof: the
 *      review ran there, on that machine's own sign-in; its footer names the
 *      machine; every process this computer started for it was ssh.
 * Then: the tab ends, the fixture folders and the machine's device folder go;
 * a ~/.codex it did not make stays.
 *
 * Not yet here (plan 6.3's CI line as written): the tab's program is the
 * fake CLI, not real Claude Code 2.1.332 answering P11's stand-in model with
 * a scripted tool_use turn; that swap is owed once plan phase 5 installs
 * Claude Code 2.1.332 in the remote-helper-e2e job (helper/probes/README.md,
 * "Status").
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RemoteMachines, type MachineStore, type RemoteMachineRecord } from '../../src/main/remote-helper/machines'
import { nodeSshRunner, execArgv, sshEnv, type SshRunner, type SshTarget } from '../../src/main/remote-helper/ssh-exec'
import { RemoteHelperPty, hostRunEnv, remoteCwd, remoteSessionId } from '../../src/main/remote-helper/session'
import { remoteLaunchOf, type RemoteSignalDeps } from '../../src/main/remote-helper'
import { claudeRemoteLaunch } from '../../src/main/providers/claude/remote-launch'
import { readBundledLinuxHelper, type BundledLinuxHelper } from '../../src/main/remote-helper/manifest'
import { readHostReviewMaterial, runOnHost, type HostReviewCtx } from '../../src/main/remote-helper/review'
import { forgetRemoteReviewSession, registerRemoteReviewSession, remoteReviewTarget } from '../../src/main/remote-helper/review-sessions'
import { REMOTE_REVIEW_PROVEN, runRemoteCodexReview, type RemoteReviewDeps, type RemoteReviewProofEntry } from '../../src/main/codex-review-remote'
import { codexRemoteReview } from '../../src/main/providers/codex/remote-review'
import { REVIEW_DIFF_MAX_BYTES, produceReviewDiff, produceReviewFiles } from '../../src/main/review-diff'
import { mergeRegistry, type ModelRegistry } from '../../src/shared/model-registry'
import registryJson from '../../resources/model-registry.json'

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
let codexKind: 'stand-in' | 'real'
/** Every program this computer started for the run's execs: ssh only. */
const spawned: string[] = []
const realRunner = nodeSshRunner(() => 'ssh')
const runner: SshRunner = {
  ...realRunner,
  spawn: ((file: string, args: readonly string[], opts: unknown) => {
    spawned.push(path.basename(file))
    return (realRunner.spawn as (f: string, a: readonly string[], o: unknown) => ChildProcess)(file, args, opts)
  }) as SshRunner['spawn'],
}

function memoryStore(): MachineStore {
  let v: unknown = null
  return { read: () => v, write: (x) => { v = JSON.parse(JSON.stringify(x)) } }
}

/** The line the test's own execs print before their command (an rc file prints first). */
const OWN = 'AICC-E2E-OWN'

/** One plain ssh exec for the test's own steps (not the app's). */
function sshRun(command: string, input?: Buffer): { code: number | null; out: string; err: string } {
  const args = execArgv(target, { version: null }, `echo ${OWN}; ${command}`)
  const r = spawnSync('ssh', args, { input: input ?? Buffer.alloc(0), env: sshEnv(process.env), timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
  const raw = String(r.stdout ?? '').replace(/\r\n/g, '\n')
  const at = raw.indexOf(`${OWN}\n`)
  return { code: r.status, out: at >= 0 ? raw.slice(at + OWN.length + 1) : '', err: String(r.stderr ?? '') }
}

async function until(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  const start = Date.now()
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const logs: string[] = []
let machines: RemoteMachines
let machine: RemoteMachineRecord
let inUse = 0
/** The run's own folder on the host, inside the home folder (a review there
 *  refuses the home folder itself): the fixtures, the fake CLI. */
let hostDir = ''
/** The run's own folder here, under the system's temporary folder, for the
 *  fixture made the same: made when the file loads, so afterAll (which runs
 *  even when beforeAll fails) removes it on every run in which a test of this
 *  file runs (a run that filters out all of its tests runs no hooks). */
const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-pv-'))
/** Which probes passed. */
const passed = { pv1: false, pv2: false }
/** This run's PASS of both, once step 5 has it: the proof step 6's review is
 *  given (the app build's own entry decides every other review). */
let proof: RemoteReviewProofEntry | null = null

const ctx = (): HostReviewCtx => ({ runner, installId: machines.installId(), log: (l) => { logs.push(l) } })
const registry = (): ModelRegistry => mergeRegistry(registryJson as unknown as ModelRegistry, null)
const name = () => `review host (${target.user}@${target.host}:${target.port})`

/** The app's remote review with the real host side, as the running app wires it. */
function deps(over: Partial<RemoteReviewDeps> = {}): RemoteReviewDeps {
  return {
    machine: (did) => machines.list().find((m) => m.did === did) ?? null,
    read: (m, input) => readHostReviewMaterial(ctx(), m, input),
    run: (m, spec, input, timeoutMs, signal) => runOnHost(ctx(), m, spec, input, timeoutMs, signal),
    env: hostRunEnv,
    registry,
    launchRefusal: () => null,
    reviewer: () => codexRemoteReview,
    ...(proof && machine ? { proven: { ...REMOTE_REVIEW_PROVEN, [machine.arch]: proof } } : {}),
    ...over,
  }
}

// ── the fixture repository, made the same on the host and here ──

/** Fixed names, dates and contents, so both sides hold the same objects. */
const FIXTURE_ENV = {
  GIT_AUTHOR_NAME: 'PV Fixture', GIT_AUTHOR_EMAIL: 'pv@example.invalid', GIT_AUTHOR_DATE: '2026-11-28T00:00:00Z',
  GIT_COMMITTER_NAME: 'PV Fixture', GIT_COMMITTER_EMAIL: 'pv@example.invalid', GIT_COMMITTER_DATE: '2026-11-28T00:00:00Z',
}
const FILES_1: Record<string, string> = {
  'a.ts': 'export const a = 1\nexport const b = 2\n',
  'sub/b.txt': 'line one\nline two\nline three\n',
  'keep.md': '# kept\n',
}
const FILES_2: Record<string, string> = {
  'a.ts': 'export const a = 1\nexport const b = 3\nexport const c = 4\n',
  'sub/b.txt': 'line one\nline 2\nline three\n',
}
const WORKING: Record<string, string> = {
  'a.ts': 'export const a = 10\nexport const b = 3\nexport const c = 4\n',
  'staged.ts': 'export const staged = true\n',
}
/** A file with a NUL byte: binary to git and to the paths mode. */
const BINARY = Buffer.from([0x50, 0x56, 0x00, 0x01, 0x02, 0x0a])

/** The fixture as one sh script, run in an empty folder: two commits, then
 *  an unstaged change and a staged new file. The same steps as `localFixture`. */
function hostFixtureScript(): string {
  const put = (files: Record<string, string>) => Object.entries(files).map(([f, text]) => `mkdir -p "$(dirname '${f}')" && printf '%s' '${Buffer.from(text).toString('base64')}' | base64 -d > '${f}'`).join('\n')
  const env = Object.entries(FIXTURE_ENV).map(([k, v]) => `${k}='${v}'; export ${k}`).join('\n')
  return [
    'set -e',
    env,
    'GIT_CONFIG_NOSYSTEM=1; export GIT_CONFIG_NOSYSTEM',
    'git init -q -b main .',
    'git config core.autocrlf false',
    'git config core.filemode true',
    put(FILES_1),
    `printf '%s' '${BINARY.toString('base64')}' | base64 -d > 'bin.dat'`,
    'git add -A && git commit -q -m one',
    put(FILES_2),
    'git add -A && git commit -q -m two',
    put(WORKING),
    'git add staged.ts',
    'echo FIXTURE-READY',
  ].join('\n')
}

/** The same fixture here, with git as this computer finds it, in an
 *  environment of its own (never this process's whole one). */
function localFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const pathName = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const env: Record<string, string> = { PATH: process.env[pathName] ?? '', HOME: path.join(localDir, 'home'), GIT_CONFIG_NOSYSTEM: '1', ...FIXTURE_ENV }
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k] as string
  fs.mkdirSync(env.HOME, { recursive: true })
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed here: ${r.stderr}`)
  }
  const put = (files: Record<string, string>) => {
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
      fs.writeFileSync(path.join(dir, f), text)
    }
  }
  git('init', '-q', '-b', 'main', '.')
  git('config', 'core.autocrlf', 'false')
  if (process.platform !== 'win32') git('config', 'core.filemode', 'true')
  put(FILES_1)
  fs.writeFileSync(path.join(dir, 'bin.dat'), BINARY)
  git('add', '-A')
  git('commit', '-q', '-m', 'one')
  put(FILES_2)
  git('add', '-A')
  git('commit', '-q', '-m', 'two')
  put(WORKING)
  git('add', 'staged.ts')
}

// ── the app's side of the tab: a tool host that runs the remote review ──

const served: Array<{ id: string; provider: string }> = []
const signals: RemoteSignalDeps = {
  toolsServed: () => true,
  status: () => {},
  event: () => {},
  serve: (id, provider, link) => {
    served.push({ id, provider })
    link.take((m) => {
      if (Array.isArray(m) || m.method !== 'tools/call' || m.id === undefined) return
      const params = (m.params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> }
      if (params.name !== 'codex_review') {
        link.send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `no tool ${String(params.name)}` }], isError: true } })
        return
      }
      // As the tool host does: the session is the tab the stream was served for.
      void runRemoteCodexReview({ ...(params.arguments ?? {}), cccSessionId: id }, remoteReviewTarget(id), deps()).then((r) => {
        link.send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) } })
      })
    }, () => { /* the stream ended */ })
    return true
  },
  ended: () => {},
}

/** The session's tool server as Claude Code starts it: its mcp.json command, on the host. */
class Relay {
  readonly answers: Array<{ id?: unknown; result?: { content: Array<{ text: string }>; isError?: boolean } }> = []
  code: number | null | undefined
  private readonly child: ChildProcess
  private buf = ''
  private own = false
  constructor(conductor: { command: string; args: string[] }) {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
    const line = [conductor.command, ...conductor.args].map(q).join(' ')
    this.child = spawn('ssh', execArgv(target, { version: null }, `echo ${OWN}; exec ${line}`), { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnv(process.env) })
    this.child.stdout!.on('data', (c: Buffer) => this.take(c.toString('utf8')))
    this.child.on('close', (code) => { this.code = code })
  }
  private take(text: string): void {
    this.buf += text
    for (let at = this.buf.indexOf('\n'); at >= 0; at = this.buf.indexOf('\n')) {
      const line = this.buf.slice(0, at).replace(/\r$/, '')
      this.buf = this.buf.slice(at + 1)
      if (!this.own) { this.own = line === OWN; continue }
      try { this.answers.push(JSON.parse(line)) } catch { /* not a message */ }
    }
  }
  send(message: unknown): void { this.child.stdin!.write(`${JSON.stringify(message)}\n`) }
  async end(): Promise<void> {
    this.child.stdin!.end()
    await until('the relay to exit', () => this.code !== undefined, 15_000).catch(() => { this.child.kill() })
  }
}

beforeAll(async () => {
  const hosts = JSON.parse(fs.readFileSync(need('REMOTE_HELPER_HOSTS'), 'utf8')) as { host?: unknown; user?: unknown; port?: unknown }
  target = { host: String(hosts.host), user: String(hosts.user), port: Number(hosts.port ?? 22) }
  if (target.host === '192.168.50.185') throw new Error('never this host (owner rule)')
  fakeCli = need('REMOTE_HELPER_FAKE_CLI')
  const kind = need('REMOTE_REVIEW_CODEX')
  if (kind !== 'stand-in' && kind !== 'real') throw new Error('REMOTE_REVIEW_CODEX is `stand-in` or `real`')
  codexKind = kind
  const bundled = await readBundledLinuxHelper({ manifest: need('REMOTE_HELPER_MANIFEST'), file: need('REMOTE_HELPER_BIN') })
  if (!bundled.ok) throw new Error(`the helper and its manifest do not read: ${bundled.why}`)
  helper = bundled.helper
  note('target', `${target.user}@${target.host}:${target.port}`)
  note('codex', codexKind)
  machines = new RemoteMachines({ runner, store: memoryStore(), bundled: async () => ({ ok: true, helpers: [helper] }), inUse: () => inUse, log: (l) => { logs.push(l) }, reviewer: () => codexRemoteReview })
  // The run's own folder on the host, inside the home folder (this computer's is localDir).
  const up = sshRun('umask 077; d=$(mktemp -d "$HOME/aicc-pv.XXXXXXXX") && mkdir "$d/repo" "$d/big" && cat > "$d/aicc-fake-cli" && chmod 700 "$d/aicc-fake-cli" && echo "$d"', fs.readFileSync(fakeCli))
  hostDir = up.out.trim().split('\n').pop() ?? ''
  if (!/^\/[A-Za-z0-9._/-]+\/aicc-pv\.[A-Za-z0-9]+$/.test(hostDir)) throw new Error(`the host folder was not made: ${up.err}`)
})

afterAll(async () => {
  if (machine) {
    try { await machines.remove(machine.did) } catch { /* the readings say what is left */ }
  }
  if (/^\/[A-Za-z0-9._/-]+\/aicc-pv\.[A-Za-z0-9]+$/.test(hostDir)) sshRun(`rm -rf -- '${hostDir}'`)
  if (path.basename(localDir).startsWith('aicc-pv-')) fs.rmSync(localDir, { recursive: true, force: true })
  note('logs', logs)
  note('spawned', [...new Set(spawned)])
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, 'remote-review.json'), `${JSON.stringify({ at: new Date().toISOString(), host: os.hostname(), passed, readings }, null, 2)}\n`)
  }
  // One line each, for a host line's operator.
  console.log(`PV1 RESULT: ${passed.pv1 ? 'PASS' : 'FAIL'}`)
  console.log(`PV2 RESULT: ${passed.pv2 ? 'PASS' : 'FAIL'}`)
  if (codexKind === 'real' && proof && machine) {
    console.log(`REMOTE_REVIEW_PROVEN entry to set (src/main/codex-review-remote.ts), in the commit that records this PASS: ${machine.arch}: Object.freeze({ codex: '${proof.codex}', git: '${proof.git}' }),`)
  }
})

/** The stand-in's newest record (CI only). */
function standInRecord(): Record<string, unknown> {
  const r = sshRun('f=$(ls -1 "$HOME/aicc-e2e-bin/codex-runs" 2>/dev/null | sort | tail -n 1); [ -n "$f" ] && cat "$HOME/aicc-e2e-bin/codex-runs/$f"')
  return JSON.parse(r.out.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
}

describe('a review on the machine a remote session runs on', () => {
  it('1. Add: its Check reads where Codex is, its version, its own model list there, and the git', async () => {
    const q = await machines.prepare([{ id: 'pv', label: 'review host', sessionType: 'ssh', sshConfig: { host: target.host, port: target.port, username: target.user } }], 'pv')
    expect(q.ok, JSON.stringify(q)).toBe(true)
    if (!q.ok) return
    const r = await machines.add(q.token)
    expect(r.ok, r.message).toBe(true)
    ;[machine] = machines.list()
    note('record', machine)
    expect(machine.codex, 'Codex was not found there by the login shell\'s lookup').toBeDefined()
    expect(machine.codex!.path).toMatch(/^\//)
    expect(machine.codex!.version, 'its version did not read').not.toBeNull()
    expect(codexRemoteReview.tooOld(machine.codex!.version!)).toBe(false)
    // PV1's last clause: Codex's model list reads there.
    expect(machine.codex!.models?.models.length ?? 0, 'Codex\'s model list did not read there').toBeGreaterThan(0)
    if (codexKind === 'stand-in') expect(machine.codex!.models!.models.map((m) => m.id)).toEqual(['gpt-pv-1', 'gpt-pv-2'])
    expect(machine.git, 'the git version did not read').toMatch(/^\d+\.\d+/)
  })

  it('2. the gate shut: with no PASS recorded for its architecture, a review there is refused with the reason, and nothing runs there or here', async () => {
    expect(machine).toBeDefined()
    note('build-entry', { arch: machine.arch, entry: Object.prototype.hasOwnProperty.call(REMOTE_REVIEW_PROVEN, machine.arch) ? REMOTE_REVIEW_PROVEN[machine.arch] : 'no entry' })
    const calls: string[] = []
    const d = deps({
      proven: { ...REMOTE_REVIEW_PROVEN, [machine.arch]: null },
      read: async (m, i) => { calls.push('read'); return readHostReviewMaterial(ctx(), m, i) },
      run: async (m, s, i, t, sig) => { calls.push('run'); return runOnHost(ctx(), m, s, i, t, sig) },
    })
    const r = await runRemoteCodexReview({ cccSessionId: 'pv-gate', mode: 'working' }, { did: machine.did, cwd: `${hostDir}/repo` }, d)
    note('gate-shut', r)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/machines have not been proven yet \(probes PV1 and PV2, helper\/probes\/README\.md\)\./)
    expect(r.text).toMatch(/Nothing ran there or on this computer\.$/)
    expect(calls).toEqual([])
  })

  it('3. PV1: the run mode starts its program with no terminal; the review\'s argv runs there with the prompt on standard input, and its JSON events read', async () => {
    expect(machine?.codex).toBeDefined()
    const fixture = sshRun(`cd '${hostDir}/repo' && sh -s`, Buffer.from(hostFixtureScript()))
    expect(fixture.out, fixture.err).toContain('FIXTURE-READY')
    // No terminal: tty says so and exits 1 (no shell between: argv alone).
    const tty = await runOnHost(ctx(), machine, { argv: ['/usr/bin/tty'], cwd: `${hostDir}/repo`, env: hostRunEnv(machine) }, '', 60_000)
    note('pv1-tty', tty)
    expect(tty.outcome, tty.failure).not.toBeNull()
    expect(tty.outcome!.code).toBe(1)
    expect(tty.stdout).toMatch(/not a tty/)
    // The review's argv, as the Codex package makes it, the prompt on standard input.
    const choice = { effort: 'low' }
    const args = codexRemoteReview.args(choice)
    if (!Array.isArray(args)) throw new Error((args as { refused: string }).refused)
    const prompt = 'PV1 probe: this request carries no change. Reply with one short sentence that says so.\n'
    const run = await runOnHost(ctx(), machine, { argv: [machine.codex!.path, ...args], cwd: `${hostDir}/repo`, env: hostRunEnv(machine) }, prompt, 300_000)
    note('pv1-run', { outcome: run.outcome, failure: run.failure, stderr: run.stderr.slice(-2000), stdoutBytes: run.stdout.length })
    expect(run.failure).toBeUndefined()
    expect(run.outcome).toEqual({ code: 0, signal: null, timeout: false, cut: false })
    const out = codexRemoteReview.readOutput(run.stdout)
    note('pv1-output', { text: out.text, usage: out.usage, error: out.error })
    expect(out.error).toBeUndefined()
    expect((out.text ?? '').trim().length).toBeGreaterThan(0)
    if (codexKind === 'stand-in') {
      const rec = standInRecord()
      note('pv1-stand-in', rec)
      expect(rec.argv).toEqual([...args])
      expect(rec.cwd).toBe(sshRun(`cd '${hostDir}/repo' && pwd -P`).out.trim())
      expect(rec.envNames).toEqual(Object.keys(hostRunEnv(machine)).sort())
      expect(rec.tty).toEqual({ stdin: false, stdout: false, stderr: false })
      expect(rec.promptBytes).toBe(Buffer.byteLength(prompt))
      // Its own session and group (the run mode's setsid), and the helper's run mode its parent.
      const ids = rec.ids as { pgrp: number; session: number }
      expect([ids.pgrp, ids.session]).toEqual([rec.pid, rec.pid])
      expect((rec.parent as string[]).slice(1, 2)).toEqual(['run'])
      expect(String((rec.parent as string[])[0])).toMatch(/\/aicc-helper$/)
    }
    passed.pv1 = true
  }, 420_000)

  it('4. PV2: the host read gives byte for byte what this computer\'s review-diff.ts gives for the same fixture, and its bound holds', async () => {
    expect(machine).toBeDefined()
    localFixture(path.join(localDir, 'repo'))
    const here = path.join(localDir, 'repo')
    const there = `${hostDir}/repo`
    const compared: Record<string, unknown> = {}
    for (const input of [{ mode: 'working' as const }, { mode: 'range' as const, range: 'HEAD~1..HEAD' }, { mode: 'range' as const, range: 'HEAD~1...HEAD' }]) {
      const local = await produceReviewDiff({ cwd: here, ...input })
      const host = await readHostReviewMaterial(ctx(), machine, { cwd: there, ...input })
      compared[`${input.mode} ${'range' in input ? input.range : ''}`] = { local: local.ok ? local.diff.length : local.message, host: host.ok ? (host.kind === 'diff' ? host.diff.length : 'files') : host.message }
      expect(local.ok, JSON.stringify(local)).toBe(true)
      expect(host.ok, JSON.stringify(host)).toBe(true)
      if (!local.ok || !host.ok || host.kind !== 'diff') throw new Error('no diff')
      expect(local.diff.length).toBeGreaterThan(0)
      expect(host.diff).toBe(local.diff)
    }
    const paths = ['a.ts', 'sub/b.txt', 'bin.dat', 'staged.ts']
    const localFiles = await produceReviewFiles({ cwd: here, paths })
    const hostFiles = await readHostReviewMaterial(ctx(), machine, { cwd: there, mode: 'paths', paths })
    expect(localFiles.ok, JSON.stringify(localFiles)).toBe(true)
    expect(hostFiles.ok, JSON.stringify(hostFiles)).toBe(true)
    if (!localFiles.ok || !hostFiles.ok || hostFiles.kind !== 'files') throw new Error('no files')
    expect(hostFiles.files).toEqual(localFiles.files)
    note('pv2-compared', compared)
    // The bound: a change over 512 KB, and files over it together, are refused there, never cut.
    const big = [
      'set -e', 'GIT_CONFIG_NOSYSTEM=1; export GIT_CONFIG_NOSYSTEM',
      ...Object.entries(FIXTURE_ENV).map(([k, v]) => `${k}='${v}'; export ${k}`),
      'git init -q -b main . && git config core.autocrlf false',
      'echo base > base.txt && git add -A && git commit -q -m base',
      `head -c ${REVIEW_DIFF_MAX_BYTES + 4096} /dev/zero | tr '\\0' 'a' | fold -w 100 > big.txt`,
      `head -c ${300 * 1024} /dev/zero | tr '\\0' 'b' | fold -w 100 > half1.txt`,
      `head -c ${300 * 1024} /dev/zero | tr '\\0' 'c' | fold -w 100 > half2.txt`,
      'git add big.txt', 'echo BIG-READY',
    ].join('\n')
    const made = sshRun(`cd '${hostDir}/big' && sh -s`, Buffer.from(big))
    expect(made.out, made.err).toContain('BIG-READY')
    const over = await readHostReviewMaterial(ctx(), machine, { cwd: `${hostDir}/big`, mode: 'working' })
    expect(over).toEqual({ ok: false, message: `the change is larger than ${REVIEW_DIFF_MAX_BYTES / 1024} KB; review a narrower range, or name files with mode "paths"` })
    const files = await readHostReviewMaterial(ctx(), machine, { cwd: `${hostDir}/big`, mode: 'paths', paths: ['half1.txt', 'half2.txt'] })
    expect(files).toEqual({ ok: false, message: `the files are larger than ${REVIEW_DIFF_MAX_BYTES / 1024} KB together; name fewer or smaller files` })
    const one = await readHostReviewMaterial(ctx(), machine, { cwd: `${hostDir}/big`, mode: 'paths', paths: ['half1.txt'] })
    expect(one.ok, JSON.stringify(one).slice(0, 300)).toBe(true)
    passed.pv2 = true
  }, 300_000)

  it('5. both passed: the entry to record for its architecture (a host line), and nothing written on the host', async () => {
    expect(passed, 'PV1 and PV2 must both pass first').toEqual({ pv1: true, pv2: true })
    const version = machine.codex!.version!
    const git = machine.git!
    expect(version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
    expect(git).toMatch(/^\d+\.\d+(\.\d+){0,2}$/)
    proof = { codex: version, git }
    // Only the real Codex proves a host kind: a stand-in run prints no entry.
    const entry = codexKind === 'real' ? `${machine.arch}: Object.freeze({ codex: '${version}', git: '${git}' }),` : null
    note('proven-entry', entry ?? 'none: a stand-in run proves no Codex')
    // The host holds nothing of it: no file of the probes beside the device folders.
    const left = sshRun('ls -A "$HOME/.aicc" 2>/dev/null')
    note('aicc-folder', left.out.split('\n').filter(Boolean))
    expect(left.out.split('\n').map((n) => n.trim())).not.toContain('review-probes')
  })

  it('6. a codex_review from a Claude Code tab through the session helper runs on the machine: its footer names it, and this computer started only ssh', async () => {
    expect(proof, 'PV1 and PV2 did not both pass in this run').not.toBeNull()
    const id = 'pv-review-tab'
    const remotePath = `${hostDir}/repo`
    const m: RemoteMachineRecord = { ...machine, claudePath: `${hostDir}/aicc-fake-cli`, check: { at: Date.now(), ok: true } }
    inUse = 1
    // As the app's start of the tab: registered for a review in its folder there.
    expect(registerRemoteReviewSession(id, { did: m.did, cwd: remoteCwd(remotePath, m.home) }, m.home)).toBe(true)
    const plan = remoteLaunchOf(claudeRemoteLaunch, m, { model: 'e2e-model', ssh: { host: target.host, port: target.port, username: target.user, remotePath } }, null, () => true, remoteSessionId(id), 100, 30, true)
    const pty = new RemoteHelperPty({ appPtyId: id, machine: m, installId: machines.installId(), runner, spec: plan.spec, plan, signals, log: (l) => { logs.push(l) } })
    let out = ''
    pty.onData((x) => { out += x })
    let relay: Relay | null = null
    try {
      await until('the fake CLI\'s banner', () => out.includes('FAKE-CLI READY'))
      const mcp = JSON.parse(sshRun(`cat "${plan.helper.folder}/mcp.json"`).out) as { mcpServers: { conductor: { command: string; args: string[] } } }
      relay = new Relay(mcp.mcpServers.conductor)
      const before = spawned.length
      relay.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'codex_review', arguments: { mode: 'working', effort: 'low', timeoutSeconds: 300 } } })
      await until('the review\'s answer', () => relay!.answers.some((a) => a.id === 7), 360_000)
      const answer = relay.answers.find((a) => a.id === 7)!
      const text = answer.result?.content[0].text ?? ''
      note('review', { text, isError: answer.result?.isError ?? false, served })
      expect(answer.result?.isError ?? false, text).toBe(false)
      // The footer: the machine and its own sign-in, the effort the caller chose.
      expect(text).toContain(`\n\n---\nCodex review on ${name()}, with ${name()}'s own Codex sign-in, on `)
      expect(text).toContain('effort low (caller')
      if (codexKind === 'stand-in') {
        // The material was the host's change: the stand-in names its first diff line.
        expect(text.startsWith('PV stand-in review of ')).toBe(true)
        expect(text).toContain('First change line: diff --git a/a.ts b/a.ts')
        const rec = standInRecord()
        expect(rec.argv).toEqual([...(codexRemoteReview.args({ effort: 'low' }) as readonly string[])])
      }
      // This computer started nothing for the review but ssh (the host read and the run).
      expect(spawned.slice(before).every((p) => /^ssh(\.exe)?$/i.test(p)), spawned.slice(before).join(', ')).toBe(true)
      expect(spawned.length - before).toBeGreaterThanOrEqual(2)
      expect(served).toEqual([{ id, provider: 'claude' }])
    } finally {
      await relay?.end()
      pty.kill()
      await pty.ended
      inUse = 0
      forgetRemoteReviewSession(id)
    }
  }, 600_000)
})
