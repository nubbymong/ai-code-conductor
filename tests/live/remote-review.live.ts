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
 *     REMOTE_REVIEW_CODEX=stand-in): its header says why not the real Codex
 *     (the one recorded change from plan 6.3's CI line). The review there is
 *     asked by REAL Claude Code 2.1.332, the job's one install (the paste
 *     check runs it too), answering probe P11's model stand-in on this
 *     runner's loopback (helper/probes/p11-model-stand-in.cjs, its scripted
 *     review turn);
 *   - a host line (Rocky, the Pi), from a test PC with ssh and that job's
 *     artifact, with the real Codex installed and signed in in the tester
 *     login (REMOTE_REVIEW_CODEX=real). There the review is asked by the
 *     fake CLI's tab and this file's own call: the model stand-in listens on
 *     the test PC's loopback, which the host cannot reach.
 *     helper/probes/README.md ("Probes PV1 and PV2") says how. Never
 *     192.168.50.185.
 * Run as
 *   npx vitest run --config vitest.live.config.ts tests/live/remote-review.live.ts --retry=0
 * It fails, never skips, when what it needs is not given.
 *
 * What it takes, from the environment (no secret anywhere):
 *   REMOTE_HELPER_HOSTS, REMOTE_HELPER_BIN, REMOTE_HELPER_MANIFEST
 *                            as the device check takes them
 *   REMOTE_REVIEW_CODEX      `stand-in` (CI) or `real` (a host line)
 *   REMOTE_REVIEW_CLAUDE     with `stand-in`: the absolute path of Claude Code
 *                            2.1.332 on the host, which must be this computer
 *   REMOTE_HELPER_FAKE_CLI   with `real`: the fake CLI, as the device check takes it
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
 *   6. One codex_review asked from a Claude Code tab through the session
 *      helper, given this run's PASS as its proof. In CI the tab's program is
 *      real Claude Code 2.1.332 on a config folder of the run's own (the
 *      paste check's: onboarding done, the made-up key approved, the project
 *      trusted, the model stand-in named, the review tool allowed), its tool
 *      server the session's mcp.json relay on the host. A marked prompt
 *      (P11's run `review-tool-1`) gets the stand-in's tool_use of
 *      mcp__conductor__codex_review (mode working); Claude Code calls it
 *      through the relay, the holder and the bridge to a tool host here
 *      (./review-tool-host.ts, the app's MCP SDK) that runs the app's remote
 *      review, and sends the result back to the stand-in, which answers with
 *      fixed text. Read from that result, what Claude Code received: the
 *      footer names the machine (this runner's sshd host) and the review
 *      process started under that sshd by the helper's run mode, never under
 *      this check's own process (this runner's app side); every process this
 *      computer started for it was ssh. On a host line the fake CLI is the
 *      tab's program and this file sends the call itself, as phase 6 shipped.
 * Then: the tab ends, the fixture folders, the config folder, the env file
 * and the machine's device folder go; a ~/.codex it did not make stays.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
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
import { readClaudeScreen } from '../../src/shared/claude-screen'
import registryJson from '../../resources/model-registry.json'
import { newToolHostSeen, serveReviewTool } from './review-tool-host'

const need = (name: string): string => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set: this check needs it (see the file's header)`)
  return v
}

const OUT = process.env.REMOTE_HELPER_OUT
const readings: Record<string, unknown> = {}
const note = (k: string, v: unknown) => { readings[k] = v }

/** Probe P11's model stand-in, with its one scripted review turn (CI only). */
interface ModelEvent {
  ev: string
  t?: number
  path?: string
  kind?: string
  run?: string | null
  tools?: number
  script?: {
    step: string
    run: string
    offered?: boolean
    tools?: string[]
    toolUse?: { id: string; name: string; input: Record<string, unknown> }
    toolResult?: { toolUseId: string; isError: boolean; text: string }
  }
}
const req = createRequire(__filename)
const { createModelStandIn, REVIEW_TOOL } = req('../../helper/probes/p11-model-stand-in.cjs') as {
  createModelStandIn: (o: { onEvent: (e: ModelEvent) => void }) => { listen(): Promise<number>; close(): Promise<void> }
  REVIEW_TOOL: string
}

/** The Claude Code the CI line runs (the job's one install), and the made-up
 *  key its config approves (no secret: the stand-in takes any). */
const CLAUDE_VERSION = '2.1.332'
const FAKE_KEY = 'sk-ant-e2e-fake-key-not-real-0000000000'
/** The env file the job's rc step reads in an interactive login shell, for
 *  the CLI the tab starts (named for the paste check, which reads it too). */
const ENV_FILE = '.aicc-e2e-paste-env'
/** The marked prompt: P11's stand-in answers its run with the review call. */
const REVIEW_RUN = 'review-tool-1'
const ASK = `p11 probe ${REVIEW_RUN}: ask for a Codex review of the working change.`

let target: SshTarget
let helper: BundledLinuxHelper
let fakeCli = ''
let claude = ''
let codexKind: 'stand-in' | 'real'
const modelEvents: ModelEvent[] = []
let standIn: { listen(): Promise<number>; close(): Promise<void> } | undefined
let envFileWritten = false
/** What the tool host here saw of the tab's tool stream (CI). */
const toolHost = newToolHostSeen()
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
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

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

/** As until, for a test that reads the holder's screen (each read a message on the tab's connection, no new exec). */
async function untilRead(what: string, ok: () => Promise<boolean>, ms: number): Promise<void> {
  const start = Date.now()
  while (!(await ok())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

/** A tab's holder screen now, as rows of text (for a cause). */
async function screenText(p: RemoteHelperPty): Promise<string> {
  try {
    const read = p.screenRead
    return read ? (await read()).lines.map((l) => l.text).join('\n') : '(the tab reads no screen now)'
  } catch (err) {
    return `(no screen read: ${(err as Error).message})`
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

/** The app's remote review for the tab the stream was served for, as the tool host runs it. */
const reviewFor = (id: string) => (args: Record<string, unknown>) => runRemoteCodexReview({ ...args, cccSessionId: id }, remoteReviewTarget(id), deps())

const served: Array<{ id: string; provider: string }> = []
const signals: RemoteSignalDeps = {
  toolsServed: () => true,
  status: () => {},
  event: () => {},
  serve: (id, provider, link) => {
    served.push({ id, provider })
    // CI: real Claude Code at the far end, served as the app's tool host serves it.
    if (codexKind === 'stand-in') {
      serveReviewTool(link, { name: 'codex_review', description: 'Get a Codex code review on a change. The review runs on the machine this session runs on, with that machine\'s own Codex sign-in.', run: reviewFor(id) }, toolHost)
      return true
    }
    // A host line: the fake CLI's tab, and this file's own call (Relay).
    link.take((m) => {
      if (Array.isArray(m) || m.method !== 'tools/call' || m.id === undefined) return
      const params = (m.params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> }
      if (params.name !== 'codex_review') {
        link.send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `no tool ${String(params.name)}` }], isError: true } })
        return
      }
      // As the tool host does: the session is the tab the stream was served for.
      void reviewFor(id)(params.arguments ?? {}).then((r) => {
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
  const kind = need('REMOTE_REVIEW_CODEX')
  if (kind !== 'stand-in' && kind !== 'real') throw new Error('REMOTE_REVIEW_CODEX is `stand-in` or `real`')
  codexKind = kind
  if (codexKind === 'stand-in') {
    // Real Claude Code asks for the review, against the model stand-in on this computer's loopback.
    if (target.host !== '127.0.0.1' && target.host !== 'localhost') throw new Error('with REMOTE_REVIEW_CODEX=stand-in this check runs against this computer\'s own sshd only: the model stand-in Claude Code asks listens on its loopback')
    claude = need('REMOTE_REVIEW_CLAUDE')
    if (!path.posix.isAbsolute(claude)) throw new Error('REMOTE_REVIEW_CLAUDE is the absolute path of Claude Code on the host')
  } else {
    fakeCli = need('REMOTE_HELPER_FAKE_CLI')
  }
  const bundled = await readBundledLinuxHelper({ manifest: need('REMOTE_HELPER_MANIFEST'), file: need('REMOTE_HELPER_BIN') })
  if (!bundled.ok) throw new Error(`the helper and its manifest do not read: ${bundled.why}`)
  helper = bundled.helper
  note('target', `${target.user}@${target.host}:${target.port}`)
  note('codex', codexKind)
  machines = new RemoteMachines({ runner, store: memoryStore(), bundled: async () => ({ ok: true, helpers: [helper] }), inUse: () => inUse, log: (l) => { logs.push(l) }, reviewer: () => codexRemoteReview })
  // The run's own folder on the host, inside the home folder (this computer's
  // is localDir): the fixtures, Claude Code's config folder in CI, the fake CLI on a host line.
  const up = sshRun('umask 077; d=$(mktemp -d "$HOME/aicc-pv.XXXXXXXX") && mkdir "$d/repo" "$d/big" "$d/config" && echo "$d"')
  hostDir = up.out.trim().split('\n').pop() ?? ''
  if (!/^\/[A-Za-z0-9._/-]+\/aicc-pv\.[A-Za-z0-9]+$/.test(hostDir)) throw new Error(`the host folder was not made: ${up.err}`)
  if (codexKind === 'real') {
    const put = sshRun(`umask 077; cat > ${q(`${hostDir}/aicc-fake-cli`)} && chmod 700 ${q(`${hostDir}/aicc-fake-cli`)} && echo PUT-OK`, fs.readFileSync(fakeCli))
    if (!put.out.includes('PUT-OK')) throw new Error(`the fake CLI was not written on the host: ${put.err}`)
  }
}, 120_000)

afterAll(async () => {
  if (machine) {
    try { await machines.remove(machine.did) } catch { /* the readings say what is left */ }
  }
  if (/^\/[A-Za-z0-9._/-]+\/aicc-pv\.[A-Za-z0-9]+$/.test(hostDir)) sshRun(`rm -rf -- '${hostDir}'`)
  if (envFileWritten) sshRun(`rm -f -- "$HOME/${ENV_FILE}"`)
  await standIn?.close()
  if (path.basename(localDir).startsWith('aicc-pv-')) fs.rmSync(localDir, { recursive: true, force: true })
  note('logs', logs)
  note('spawned', [...new Set(spawned)])
  note('tool-host', toolHost)
  note('model-requests', modelEvents.filter((e) => e.ev === 'request').map(({ t, path: p, kind, run, tools, script }) => ({ t, path: p, kind, run, tools, ...(script ? { script } : {}) })))
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

  it('6. a codex_review asked from a Claude Code tab through the session helper runs on the machine: the footer Claude Code got names it, and no review process started on this computer\'s app side', async () => {
    expect(proof, 'PV1 and PV2 did not both pass in this run').not.toBeNull()
    if (codexKind === 'stand-in') await reviewAskedByClaudeCode('pv-review-tab')
    else await reviewAskedByFakeCaller('pv-review-tab')
  }, 600_000)
})

/** One file on the host, written whole by the test's own exec. */
function putOnHost(file: string, text: string): void {
  const r = sshRun(`umask 077; cat > ${q(file)} && echo PUT-OK`, Buffer.from(text))
  if (!r.out.includes('PUT-OK')) throw new Error(`${file} was not written on the host: ${r.err}`)
}

/** The scripted turn's event of one step since `from`, as the model stand-in recorded it. */
const scripted = (from: number, step: string) => modelEvents.slice(from).find((e) => e.ev === 'request' && e.script?.step === step)?.script

/**
 * CI (REMOTE_REVIEW_CODEX=stand-in): real Claude Code 2.1.332 in the tab, on
 * a config folder of the run's own, answering P11's model stand-in, which
 * scripts the call; everything asserted is what Claude Code itself sent back
 * to the stand-in as the tool's result, and where the review ran.
 */
async function reviewAskedByClaudeCode(id: string): Promise<void> {
  const remotePath = `${hostDir}/repo`
  standIn = createModelStandIn({ onEvent: (e) => { modelEvents.push(e) } })
  const port = await standIn.listen()
  // The config folder, as the paste check seeds its own: onboarding done, the
  // made-up key approved, the project trusted under every spelling of its
  // path, the model stand-in named, and the one review tool allowed.
  const real = sshRun(`cd ${q(remotePath)} && pwd -P`).out.trim().split('\n').pop() || remotePath
  const realDir = sshRun(`cd ${q(hostDir)} && pwd -P`).out.trim().split('\n').pop() || hostDir
  const project = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1, allowedTools: [REVIEW_TOOL] }
  const config = {
    hasCompletedOnboarding: true, lastOnboardingVersion: CLAUDE_VERSION, theme: 'dark', numStartups: 1, autoUpdates: false,
    hasAcknowledgedCostThreshold: true, customApiKeyResponses: { approved: [FAKE_KEY.slice(-20)], rejected: [] },
    projects: Object.fromEntries([...new Set([remotePath, real, hostDir, realDir])].map((p) => [p, project])),
  }
  const env = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: FAKE_KEY, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // The review tool sent in the request itself, never deferred behind a tool search.
    ENABLE_TOOL_SEARCH: 'false',
  }
  putOnHost(`${hostDir}/config/.claude.json`, `${JSON.stringify(config, null, 2)}\n`)
  putOnHost(`${hostDir}/config/settings.json`, `${JSON.stringify({ env, permissions: { allow: [REVIEW_TOOL] } }, null, 2)}\n`)
  const home = sshRun('printf %s "$HOME"').out.trim()
  if (!path.posix.isAbsolute(home)) throw new Error('the host\'s home folder did not read')
  envFileWritten = true
  putOnHost(`${home}/${ENV_FILE}`, `${Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`).join('\n')}\n`)
  const version = sshRun(`${q(claude)} --version`).out.trim()
  note('claude-version', version)
  expect(version, `REMOTE_REVIEW_CLAUDE is not Claude Code ${CLAUDE_VERSION}`).toContain(CLAUDE_VERSION)

  const m: RemoteMachineRecord = { ...machine, claudePath: claude, check: { at: Date.now(), ok: true } }
  inUse = 1
  // As the app's start of the tab: registered for a review in its folder there.
  expect(registerRemoteReviewSession(id, { did: m.did, cwd: remoteCwd(remotePath, m.home) }, m.home)).toBe(true)
  // The tools served (its mcp.json relay), its own config folder, and the
  // permission mode that asks (2.1.332's own default is auto mode, which
  // would ask a model before a call): the allow rule above runs the tool.
  const plan = remoteLaunchOf(claudeRemoteLaunch, m, { extraArgs: '--permission-mode default', ssh: { host: target.host, port: target.port, username: target.user, remotePath } }, null, () => true, remoteSessionId(id), 120, 40, true, false, { configDir: `${hostDir}/config` })
  const pty = new RemoteHelperPty({ appPtyId: id, machine: m, installId: machines.installId(), runner, spec: plan.spec, plan, signals, log: (l) => { logs.push(l) } })
  let out = ''
  let exited = false
  pty.onData((x) => { out += x })
  pty.onExit((e) => { exited = true; note('review-tab-exit', e) })
  try {
    await until('the tab to read its holder\'s screen', () => !!pty.screenRead, 60_000)
    await untilRead('Claude Code\'s prompt on the holder\'s screen', async () => {
      if (exited) throw new Error('the tab ended before Claude Code\'s prompt showed')
      const read = pty.screenRead
      try { return !!read && readClaudeScreen((await read()).lines).screen === 'ready' } catch { return false }
    }, 120_000)
    // Its tool server connected: the relay's stream served here, and the tool
    // listed. Not a condition of its own: a request that does not offer the
    // tool fails below, with the tools it did offer.
    await until('Claude Code to list the tools of its conductor server', () => toolHost.methods.includes('tools/list'), 60_000)
      .catch(() => { note('tools-list-wait', 'no tools/list from Claude Code within 60 s of its prompt; the prompt was typed anyway') })
    note('start-screen', await screenText(pty))
    const before = spawned.length
    const from = modelEvents.length
    pty.write(ASK)
    await sleep(700)
    pty.write('\r')
    let promptAnswered = false
    let lastLook = 0
    await untilRead('Claude Code to send the review tool\'s result to the model', async () => {
      if (exited) throw new Error('the tab ended before Claude Code sent the tool\'s result')
      const call = scripted(from, 'call')
      if (call && call.offered === false) throw new Error(`Claude Code's request did not offer ${REVIEW_TOOL}; it offered: ${(call.tools ?? []).join(', ')}`)
      if (scripted(from, 'answer')) return true
      // The prompt's turn not read as the call (a request of the run before any
      // call): Claude Code has its text answer already, so fail now, with its shape.
      const unread = call ? undefined : modelEvents.slice(from).find((e) => e.ev === 'request' && e.script?.step === 'other')
      if (unread) throw new Error(`the model stand-in did not read Claude Code's turn as the review call: ${JSON.stringify(unread.script)}`)
      // Not expected (the allow rule runs the tool), but answered so the
      // check reads the review: Claude Code asking before the call.
      if (!promptAnswered && Date.now() - lastLook > 1000) {
        lastLook = Date.now()
        const read = pty.screenRead
        const lines = read ? await read().then((s) => s.lines, () => null) : null
        const screen = lines ? lines.map((l) => l.text).join('\n') : ''
        if (/codex_review/.test(screen) && (/Do you want to/.test(screen) || readClaudeScreen(lines).screen === 'blocked')) {
          promptAnswered = true
          note('permission-prompt', screen)
          pty.write('\r')
        }
      }
      return false
    }, 360_000)
    const call = scripted(from, 'call')!
    const answer = scripted(from, 'answer')!
    const got = answer.toolResult!
    const footer = got.text.includes('\n\n---\n') ? got.text.slice(got.text.lastIndexOf('\n\n---\n') + 6) : null
    note('review-call', call)
    note('review-result', got)
    note('review-footer', footer)
    note('permission-prompt-answered', promptAnswered)
    console.log(`REVIEW CHECK: ${version}; the model stand-in sent a tool_use of ${call.toolUse?.name ?? 'none'}; Claude Code sent back a result whose footer is: ${footer ?? '(none)'}`)
    // What the stand-in asked for, and what Claude Code called through the relay.
    expect(call.toolUse?.name).toBe(REVIEW_TOOL)
    expect(call.toolUse?.input).toMatchObject({ mode: 'working', effort: 'low' })
    expect(toolHost.calls.map((c) => c.name)).toEqual(['codex_review'])
    expect(toolHost.calls[0].args).toMatchObject({ mode: 'working', effort: 'low' })
    // What Claude Code received: the result of that call, as it sent it back.
    expect(got.toolUseId).toBe(call.toolUse!.id)
    expect(got.isError, got.text).toBe(false)
    // The footer names the machine, this runner's sshd host, and its own sign-in; the effort the caller chose.
    expect(got.text).toContain(`\n\n---\nCodex review on ${name()}, with ${name()}'s own Codex sign-in, on `)
    expect(got.text).toContain('effort low (caller')
    // No review process on this runner's app side: the review process (the
    // stand-in Codex's record of its own run) was started by the helper's run
    // mode under the machine's sshd, and this check's own process, where the
    // app's code runs, is none of its ancestors.
    const rec = standInRecord()
    const chain = Array.isArray(rec.ancestors) ? (rec.ancestors as Array<{ pid: number; comm: string }>) : []
    note('review-process', { pid: rec.pid, parent: rec.parent, ancestors: chain, appSide: process.pid })
    expect(chain.length, 'the review process\'s ancestors did not read').toBeGreaterThan(0)
    expect(chain.map((a) => a.pid), `the review process (pid ${String(rec.pid)}) descends from this check's own process (pid ${process.pid}): it started on this computer's app side, not on the machine`).not.toContain(process.pid)
    expect(chain[0].comm, 'the review process was not started by the helper\'s run mode').toBe('aicc-helper')
    expect(chain.some((a) => /^sshd/.test(a.comm)), `the review process did not come through the machine's sshd: ${chain.map((a) => a.comm).join(' < ')}`).toBe(true)
    // The material was the host's change: the stand-in names its first diff line, and ran the review's argv.
    expect(got.text).toContain('PV stand-in review of ')
    expect(got.text).toContain('First change line: diff --git a/a.ts b/a.ts')
    expect(rec.argv).toEqual([...(codexRemoteReview.args({ effort: 'low' }) as readonly string[])])
    // This computer started nothing for the review but ssh (the host read and the run).
    expect(spawned.slice(before).every((p) => /^ssh(\.exe)?$/i.test(p)), spawned.slice(before).join(', ')).toBe(true)
    expect(spawned.length - before).toBeGreaterThanOrEqual(2)
    // Every stream served was this tab's (Claude Code may open it again).
    expect(served.length).toBeGreaterThanOrEqual(1)
    for (const s of served) expect(s).toEqual({ id, provider: 'claude' })
  } catch (err) {
    note('review-screen', await screenText(pty))
    note('review-output-tail', out.slice(-4000))
    throw err
  } finally {
    pty.kill()
    await Promise.race([pty.ended, sleep(15_000)])
    inUse = 0
    forgetRemoteReviewSession(id)
  }
}

/**
 * A host line (REMOTE_REVIEW_CODEX=real), as phase 6 shipped it: the fake CLI
 * as the tab's program and this file's own call through the session's relay,
 * since the model stand-in real Claude Code would ask listens on the test
 * PC's loopback, which the host cannot reach.
 */
async function reviewAskedByFakeCaller(id: string): Promise<void> {
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
}
