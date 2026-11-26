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
 *   REMOTE_HELPER_OTHER_BIN, REMOTE_HELPER_OTHER_MANIFEST
 *                           another build of the helper (the same source at
 *                           another version) and its manifest, for the attach
 *                           from a bridge of another build (2.1.3-beta.19)
 *
 * In order: Add (the question, then probe, upload by standard input, the hash
 * against the manifest, version, self-test); a second install's Remove
 * refused by the owner marker; (2.1.3-beta.19 section 3) a tab's start
 * reading its account through the helper's field mode beside its host reads,
 * from a file of the run's own in the device folder: the string at the key,
 * also with a $HOME reached through a link above it, a link followed,
 * nothing for a missing key or file; a session holding the fake CLI through the
 * login shell on the launch a Claude Code tab gets from its provider package
 * (bytes in, output out, what the rc file exported, the package's CLI
 * variable and the terminal's light or dark scheme; from 2.1.3-beta.18, its
 * own settings.json and mcp.json in its own folder on the host, 0700 and
 * 0600, naming the helper's modes and nothing of the app's computer, and the
 * folder gone once its holder ended), its link's
 * ssh killed at rest and the tab back on a new link; a shell session: a
 * resize read back by `stty`, then 20,000 lines printed while its bridge on
 * the host is stopped, its link's ssh killed, and the tab back with the
 * holder's replay, each line once; a tab in a project folder of a git
 * checkout (2.1.3-beta.18): the project's and the checkout root's hooks in its
 * settings before the app's, and a settings file that is a link not read;
 * project files that are open to others, over the bound or (where sudo runs
 * with no password, as on the CI runner) another user's, each not read with
 * one log line; a tab in the home folder: no project or checkout file read
 * there, and (on the CI runner only) the user's own settings file read as
 * Claude Code reads it when it is a link, then put back as it was;
 * a tab's status line, hook events and tool calls (2.1.3-beta.18 section 3.2,
 * with the helper of section 3.1): the commands its settings.json and
 * mcp.json name, run on the host as Claude Code runs them, reach the app's
 * side of the tab (a status strip, a hook sink and a tool host that answers
 * each call with the tab it was served for), each once; its link's ssh then
 * killed and its new link held back until the holder let the old one go:
 * the statuses, the hook events and a tool call made meanwhile arrive once
 * the tab is back (the newest status only, the events in order, the call
 * answered by the app), and all three cross again after; two tabs on the
 * same machine at once, each one's status line, hook event and tool call on
 * its own tab only; each closed tab's hook state ended once, for its own id;
 * a running tab's folder kept by its end's removal while its holder has a
 * record (`held`), and a Check that removes a session folder whose holder is
 * gone and keeps the running tab's; (2.1.3-beta.19 section 6.3) the list the
 * app takes at start-up doing the same;
 * each closed tab's holder ended (term.end);
 * (2.1.3-beta.19 section 1.2, with section 1.1's helper) a 3 s clock session
 * ended by its clock, and an until-ended one that outlives it with no
 * connection, stays listed as until-ended, attaches again with its replay
 * and launches nothing, takes a status, a hook event and a tool call, and is
 * ended by End (term.end over a link of its own, then its folder); a list and
 * an attach to an until-ended holder from a bridge of another build (an app
 * update that changed the helper: REMOTE_HELPER_OTHER_BIN and
 * REMOTE_HELPER_OTHER_MANIFEST, a second build of the same source at another
 * version, installed by a Check as an update's would);
 * Remove; nothing left under ~/.aicc and no helper process of the
 * run left. The test's own execs read only what their command prints (an rc
 * file prints first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RemoteMachines, type MachineStore, type RemoteMachineRecord } from '../../src/main/remote-helper/machines'
import { nodeSshRunner, execArgv, sshEnv, newNonce, readScriptResult, runScript, type SshRunner, type SshTarget } from '../../src/main/remote-helper/ssh-exec'
import { RemoteHelperPty, remoteLaunchSpec, remoteSessionId } from '../../src/main/remote-helper/session'
import { remoteLaunchOf, type RemoteSignalDeps } from '../../src/main/remote-helper'
import { claudeRemoteLaunch } from '../../src/main/providers/claude/remote-launch'
import { readBundledLinuxHelper, type BundledLinuxHelper } from '../../src/main/remote-helper/manifest'
import { listKept, untilEnded } from '../../src/main/remote-helper/kept'
import { readRecord } from '../../src/main/session-helper/protocol'
import { fieldAnswerOf, readHostForStart, type HostAccountRead } from '../../src/main/remote-helper/host-reads'
import { scriptCommand } from '../../src/main/remote-helper/scripts'

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
/** What the machine list logged (a Check's sweep line is read). */
const machineLogs: string[] = []
function machinesWith(store: MachineStore): RemoteMachines {
  installs++
  return new RemoteMachines({ runner, store, bundled: async () => ({ ok: true, helpers: [helper] }), inUse: () => inUse, log: (m) => { machineLogs.push(m); note(`log-${installs}-${Object.keys(readings).length}`, m) } })
}

/** The CI job's own runner (a localhost sshd on GitHub's Linux runner): the
 *  only place this file changes the account's own ~/.claude, and where sudo
 *  must run with no password. A host line from a test PC never does either. */
const onRunner = (): boolean => process.env.GITHUB_ACTIONS === 'true' && (target.host === '127.0.0.1' || target.host === 'localhost')

/** A settings file's text whose one hook, on Stop, runs `echo <word>`. */
const hookText = (word: string): string => JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `echo ${word}` }] }] } })

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

// ── a tab's status line, hook events and tool calls (2.1.3-beta.18 section 3.2) ──

type StatusLine = Parameters<RemoteSignalDeps['status']>[1]
type HookEvent = Parameters<RemoteSignalDeps['event']>[1]
/** What reached the app's side, by tab: one set for every tab, as the app has
 *  one (ipc/remote-machines-handlers.ts). */
const got = {
  status: [] as Array<{ id: string; line: StatusLine }>,
  events: [] as Array<{ id: string; e: HookEvent }>,
  served: [] as Array<{ id: string; provider: string }>,
  /** Each tab whose run ended (its hook state goes), by id. */
  ended: [] as string[],
}
/** The app's side of a tab, with no Electron: a status strip and a hook sink
 *  that keep what they are given, and a tool host that answers each call with
 *  the tab and provider its stream was served for and the word it was sent. */
const signals: RemoteSignalDeps = {
  toolsServed: () => true,
  status: (id, line) => { got.status.push({ id, line }) },
  event: (id, e) => { got.events.push({ id, e }) },
  serve: (id, provider, link) => {
    got.served.push({ id, provider })
    link.take((m) => {
      if (Array.isArray(m) || typeof m.method !== 'string' || m.id === undefined) return
      const word = (m.params as { arguments?: { word?: unknown } } | undefined)?.arguments?.word
      link.send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `served for ${id} as ${provider}: ${String(word)}` }] } })
    }, () => { /* the stream ended */ })
    return true
  },
  ended: (id) => { got.ended.push(id) },
}
const statusOf = (id: string) => got.status.filter((s) => s.id === id).map((s) => s.line)
const eventsOf = (id: string) => got.events.filter((x) => x.id === id).map((x) => x.e)
const servedFor = (id: string) => got.served.filter((s) => s.id === id)

/** A status as Claude Code writes it on its status line command's standard
 *  input: another session's id and paths on the host, and a field outside the
 *  keep-list, beside what the strip shows. */
const statusPayload = (name: string, n: number) => ({
  session_id: 'not-this-tab', transcript_path: '/home/someone/.claude/projects/x/t.jsonl', cwd: '/home/someone',
  model: { id: `e2e-model-${n}`, display_name: `${name} ${n}` },
  context_window: { used_percentage: 10 + n, context_window_size: 200000, current_usage: { input_tokens: 1000 * n, output_tokens: 10 * n } },
  cost: { total_cost_usd: n / 100 },
  rate_limits: { five_hour: { used_percentage: 20 + n, resets_at: 1_900_000_000 } },
  not_kept: { secret: 'never kept' },
})

/** A runner whose execs wait while it is held: a tab's new link is held back,
 *  so a cut lasts until the test ends it. */
function gatedRunner(): { runner: SshRunner; hold(): void; release(): void } {
  let gate: Promise<void> = Promise.resolve()
  let open = () => {}
  return {
    runner: { ...runner, version: async () => { await gate; return runner.version() } },
    hold: () => { gate = new Promise<void>((r) => { open = r }) },
    release: () => open(),
  }
}

/** A tool server as Claude Code starts one: the command and arguments of the
 *  session's mcp.json, run on the host with pipes, one JSON-RPC message a
 *  line each way. Only what comes after the test's own line is read. */
class Relay {
  readonly answers: unknown[] = []
  readonly noise: string[] = []
  code: number | null | undefined
  private readonly child: ChildProcess
  private buf = ''
  private own = false
  constructor(conductor: { command: string; args: string[] }) {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
    const line = [conductor.command, ...conductor.args].map(q).join(' ')
    this.child = spawn('ssh', execArgv(target, { version: null }, `echo ${OWN}; exec ${line}`), { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnv(process.env) })
    this.child.stdout!.on('data', (c: Buffer) => this.take(c.toString('utf8')))
    this.child.stderr!.on('data', (c: Buffer) => { this.noise.push(`stderr: ${c.toString('utf8')}`) })
    this.child.on('close', (code) => { this.code = code })
  }
  private take(text: string): void {
    this.buf += text
    for (let at = this.buf.indexOf('\n'); at >= 0; at = this.buf.indexOf('\n')) {
      const line = this.buf.slice(0, at).replace(/\r$/, '')
      this.buf = this.buf.slice(at + 1)
      if (!this.own) { this.own = line === OWN; continue }
      try { this.answers.push(JSON.parse(line)) } catch { this.noise.push(line) }
    }
  }
  send(message: unknown): void { this.child.stdin!.write(`${JSON.stringify(message)}\n`) }
  call(id: number, word: string): void { this.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'e2e_echo', arguments: { word } } }) }
  /** The text of each answer to `id`. */
  answerTo(id: number): string[] {
    return this.answers
      .filter((a): a is { id: unknown; result: { content: Array<{ text: string }> } } => !Array.isArray(a) && (a as { id?: unknown }).id === id)
      .map((a) => a.result.content[0].text)
  }
  async end(): Promise<number | null | undefined> {
    this.child.stdin!.end()
    await until('the relay to exit', () => this.code !== undefined, 15_000)
    return this.code
  }
  kill(): void { if (this.code === undefined) this.child.kill() }
}
const relaysLeft: Relay[] = []

/** The commands a tab's own files on the host name: its status line command,
 *  the app's hook command (the last of each kind) and its tool server. */
function tabCommands(folder: string): { status: string; hook: (kind: string) => string; conductor: { command: string; args: string[] } } {
  const settings = JSON.parse(sshRun(`cat "${folder}/settings.json"`).out) as { statusLine: { command: string }; hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
  const mcp = JSON.parse(sshRun(`cat "${folder}/mcp.json"`).out) as { mcpServers: { conductor: { command: string; args: string[] } } }
  return { status: settings.statusLine.command, hook: (kind) => settings.hooks[kind].at(-1)!.hooks[0].command, conductor: mcp.mcpServers.conductor }
}

/** Run one of them on the host as Claude Code does, the JSON on its standard
 *  input. The status and hook modes exit 0 and print nothing, whatever happens. */
function post(command: string, payload: object): void {
  const r = sshRun(command, Buffer.from(JSON.stringify(payload)))
  expect([r.code, r.out], r.err).toEqual([0, ''])
}

// ── which host files a tab's settings take (2.1.3-beta.18 section 3.2) ──

/** A tab on the fake CLI that starts in `remotePath`: the commands of its
 *  session's Stop hooks in order, the app's own, and the lines it logged for
 *  a host file that was not read. The tab is closed and its folder gone when
 *  this returns. */
async function tabSettings(id: string, remotePath: string): Promise<{ stop: string[]; own: string; skipped: string[]; sid: string }> {
  const m: RemoteMachineRecord = { ...machine, claudePath: `${remoteFakeDir}/aicc-fake-cli`, check: { at: Date.now(), ok: true } }
  inUse = 1
  const plan = remoteLaunchOf(claudeRemoteLaunch, m, { model: 'e2e-model', ssh: { host: target.host, port: target.port, username: target.user, remotePath } }, null, () => true, remoteSessionId(id), 100, 30)
  const before = sessionLogs.length
  const pty = new RemoteHelperPty({ appPtyId: id, machine: m, installId: machines.installId(), runner, spec: plan.spec, plan, log: sessionLog })
  let out = ''
  pty.onData((x) => { out += x })
  try {
    await until(`${id}'s banner`, () => out.includes('FAKE-CLI READY'))
    const settings = JSON.parse(sshRun(`cat "${plan.helper.folder}/settings.json"`).out) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    const stop = settings.hooks.Stop.map((e) => e.hooks[0].command)
    const skipped = sessionLogs.slice(before).filter((l) => l.includes('was not read'))
    note(`settings-${id}`, { stop, skipped })
    return { stop, own: `'${plan.helper.helperPath}' hook --store '${plan.helper.store}' --session ${plan.helper.sid}`, skipped, sid: plan.helper.sid }
  } finally {
    pty.kill()
    await pty.ended
    inUse = 0
    await untilHost(`${id}'s folder to go`, `test -e "${plan.helper.folder}" && echo there || echo gone`, 'gone')
  }
}

/** The line a tab logs for a host file it did not read. */
const notReadLine = (sid: string, from: string, file: string, why: string): string => `[remote-helper] ${sid}: ${from} ${file} on ${target.host} was not read (${why}), so nothing it sets is in the session's settings`

/** On the CI runner, the home folder step's undo: the account's own
 *  ~/.claude as it was (only what the step made is removed, then what it
 *  moved aside comes back). Set once the step changed it; afterAll runs it
 *  again when the step did not get to. */
let homeUndo = ''

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
  for (const r of relaysLeft) r.kill()
  if (remoteFakeDir && /^\/[A-Za-z0-9._/-]+\/aicc-e2e\.[A-Za-z0-9]+$/.test(remoteFakeDir)) {
    // A bridge the replay step stopped is let go first, whatever failed.
    if (stoppedBridge) sshRun(`kill -CONT ${stoppedBridge} 2>/dev/null; true`)
    // The home folder step's undo, when it did not get to run it: the account's ~/.claude as it was.
    if (homeUndo) sshRun(homeUndo)
    // The project step's checkout (its .git folder holds what git init made), inside this run's own folder.
    sshRun(`rm -rf -- '${remoteFakeDir}/repo'`)
    // The project files not read: the one made another user's goes by sudo
    // first (where sudo ran), then the rest. The home step's files by name
    // after its undo: a folder still holding what it moved aside stays.
    sshRun(`sudo -n rm -f -- '${remoteFakeDir}/proj/other/.claude/settings.json' 2>/dev/null; rm -rf -- '${remoteFakeDir}/proj'`)
    sshRun(`rm -f -- '${remoteFakeDir}/home/hooks.json' '${remoteFakeDir}/home/local.json'; rmdir -- '${remoteFakeDir}/home/saved' '${remoteFakeDir}/home' 2>/dev/null; true`)
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

  it('a tab\'s start reads its account through the helper\'s field mode, beside its host reads: the string at the key, a link followed, or nothing (2.1.3-beta.19 section 3)', async () => {
    // A file of the run's own inside the device folder (never the account's
    // own ~/.claude.json; Remove takes it with the folder), named to the read
    // as a provider package names its file: a path relative to the home folder.
    const file = `.aicc/${machine.did}/e2e-account.json`
    const link = `.aicc/${machine.did}/e2e-account-link.json`
    const sid = remoteSessionId('e2e-account')
    const logs: string[] = []
    const told: HostAccountRead[] = []
    const readAs = async (f: string): Promise<HostAccountRead | undefined> => {
      const via: typeof claudeRemoteLaunch = { ...claudeRemoteLaunch, accountField: () => ({ file: f, key: 'oauthAccount.emailAddress' }) }
      const plan = remoteLaunchOf(via, machine, { model: 'e2e-model' }, null, () => true, sid, 100, 30)
      const got = await readHostForStart({ runner, machine, installId: machines.installId(), log: (x) => { logs.push(x) }, signals: { account: (r) => { told.push(r) } } }, plan, sid)
      return got.account
    }
    const write = (text: string): string => sshRun(`umask 077 && printf '%s' '${text}' > "$HOME/${file}" && echo made`).out.trim()
    // A folder of the run's own in /tmp holding one link, to the folder above
    // the home folder: a home reached through a link (/home a link to
    // /data/home, say), so $HOME as written is not the home's real path.
    let linkDir = ''
    try {
      expect(write('{"projects":{},"oauthAccount":{"emailAddress":"e2e@example.com","organizationName":"e2e"}}')).toBe('made')
      expect(await readAs(file)).toEqual({ account: 'e2e@example.com' })
      // The app's own field script with such a $HOME: the file goes to the
      // field mode relative to $HOME, which it joins to $HOME as written, so
      // the one string still comes back (the home's real path would not be
      // inside that $HOME, and the field mode would print nothing).
      linkDir = sshRun('umask 077; d=$(mktemp -d /tmp/aicc-e2e-home.XXXXXXXX) && ln -s "$(dirname "$HOME")" "$d/homes" && echo "$d"').out.trim().split('\n').pop() ?? ''
      expect(linkDir).toMatch(/^\/tmp\/aicc-e2e-home\.[A-Za-z0-9]+$/)
      const nonce = newNonce()
      const cmd = scriptCommand('field', [nonce, machine.did, machines.installId(), machine.helper.folder, machine.helper.sha256, file, 'oauthAccount.emailAddress'])
      const linked = sshRun(`HOME="${linkDir}/homes/$(basename "$HOME")"; export HOME; [ "$(cd "$HOME" && pwd -P)" != "$HOME" ] && echo linked; ${cmd}`)
      note('account-field-linked-home', { out: linked.out, err: linked.err, code: linked.code })
      expect(linked.out.split('\n')[0], linked.err).toBe('linked')
      expect(linked.code, linked.err).toBe(0)
      expect(fieldAnswerOf(linked.out, nonce)).toEqual({ value: 'e2e@example.com' })
      // Followed as Claude Code follows it.
      expect(sshRun(`ln -s "$HOME/${file}" "$HOME/${link}" && echo made`).out.trim()).toBe('made')
      expect(await readAs(link)).toEqual({ account: 'e2e@example.com' })
      // No such key, then no such file: nothing printed, so no account; neither is a read that did not answer.
      expect(write('{"oauthAccount":{}}')).toBe('made')
      expect(await readAs(file)).toEqual({ notShown: 'no-account' })
      expect(sshRun(`rm -f -- "$HOME/${link}" "$HOME/${file}" && echo gone`).out.trim()).toBe('gone')
      expect(await readAs(file)).toEqual({ notShown: 'no-account' })
      note('account-field', { told, logs })
      expect(told).toEqual([{ account: 'e2e@example.com' }, { account: 'e2e@example.com' }, { notShown: 'no-account' }, { notShown: 'no-account' }])
      expect(logs.filter((l) => l.includes(`the account on ${target.host} was not read`))).toEqual([])
    } finally {
      sshRun(`rm -f -- "$HOME/${link}" "$HOME/${file}"`)
      if (/^\/tmp\/aicc-e2e-home\.[A-Za-z0-9]+$/.test(linkDir)) sshRun(`rm -f -- '${linkDir}/homes'; rmdir -- '${linkDir}'`)
    }
  })

  it('a session holds the fake CLI through the login shell: bytes in, output out, and what the rc file exported reaches it', async () => {
    const up = sshRun('umask 077; d=$(mktemp -d "${TMPDIR:-/tmp}/aicc-e2e.XXXXXXXX") && cat > "$d/aicc-fake-cli" && chmod 700 "$d/aicc-fake-cli" && echo "$d"', fs.readFileSync(fakeCli))
    remoteFakeDir = up.out.trim().split('\n').pop() ?? ''
    expect(remoteFakeDir, up.err).toMatch(/aicc-e2e\./)
    const m: RemoteMachineRecord = { ...machine, claudePath: `${remoteFakeDir}/aicc-fake-cli`, check: { at: Date.now(), ok: true } }
    inUse = 1
    // The launch a Claude Code tab gets (2.1.3-beta.18 section 2): the Claude
    // package's remote launch through core, the program from the machine's
    // record; with its own files (section 3.2): the host's settings files are
    // read first, and its settings.json and mcp.json written into its folder.
    const plan = remoteLaunchOf(claudeRemoteLaunch, m, { model: 'e2e-model' }, null, () => true, remoteSessionId('e2e-tab-1'), 100, 30, true)
    const spec = plan.spec
    note('session-1-argv', spec.argv)
    const pty = new RemoteHelperPty({ appPtyId: 'e2e-tab-1', machine: m, installId: machines.installId(), runner, spec, plan, log: sessionLog })
    const folder = plan.helper.folder
    let out = ''
    pty.onData((d) => { out += d })
    try {
      await until('the fake CLI\'s banner', () => out.includes('FAKE-CLI READY'))
      // Its own files, in its own folder on the host: the user's, 0700 and
      // 0600, naming the helper's status, hook and relay modes and nothing of
      // the app's computer.
      const modes = sshRun(`stat -c '%a %u' "${folder}" "${folder}/settings.json" "${folder}/mcp.json"; id -u`).out.trim().split('\n')
      note('session-1-files', modes)
      const uid = modes.pop()
      expect(modes).toEqual([`700 ${uid}`, `600 ${uid}`, `600 ${uid}`])
      const settings = JSON.parse(sshRun(`cat "${folder}/settings.json"`).out) as { statusLine: { command: string }; hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
      expect(settings.statusLine.command).toBe(`'${plan.helper.helperPath}' status --store '${plan.helper.store}' --session ${plan.helper.sid}`)
      expect(settings.hooks.Stop.at(-1)!.hooks[0].command).toBe(`'${plan.helper.helperPath}' hook --store '${plan.helper.store}' --session ${plan.helper.sid}`)
      const mcp = sshRun(`cat "${folder}/mcp.json"`).out
      expect(JSON.parse(mcp)).toEqual({ mcpServers: { conductor: { type: 'stdio', command: plan.helper.helperPath, args: ['mcp', '--store', plan.helper.store, '--session', plan.helper.sid] } } })
      expect(`${JSON.stringify(settings)}${mcp}`).not.toMatch(/localhost|127\.0\.0\.1|https?:|token/i)
      pty.write('hello\r')
      await until('the echo', () => out.includes('echo: hello'))
      pty.write('pwd\r')
      await until('its folder', () => out.includes(`cwd: ${machine.home}`))
      // The package's CLI variable and core's terminal variable reach the program on the host.
      pty.write('env CLAUDE_CODE_DISABLE_MOUSE\r')
      await until('the package\'s variable', () => out.includes('env CLAUDE_CODE_DISABLE_MOUSE=1'))
      pty.write('env COLORFGBG\r')
      await until('the terminal\'s variable', () => out.includes('env COLORFGBG=15;0'))
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
    // A closed tab ends its holder (term.end): nothing of the session is left,
    // its own folder included (section 3.2: removed once its holder ended).
    await untilHost('the holder to end', `pgrep -f -- "--store $HOME/[.]aicc/${machine.did}/store" | wc -l`, '0')
    await untilHost('its folder to go', `test -e "${folder}" && echo there || echo gone`, 'gone')
  })

  it('a shell session: a resize reaches the program (stty), and a link dropped while output waits comes back with the replay, each line once', async () => {
    const m: RemoteMachineRecord = { ...machine, claudePath: '/bin/sh', check: { at: Date.now(), ok: true } }
    inUse = 1
    const pty = new RemoteHelperPty({ appPtyId: 'e2e-tab-2', machine: m, installId: machines.installId(), runner, spec: remoteLaunchSpec(m, { program: '/bin/sh', args: [], env: {} }, {}, '~', 100, 30), log: sessionLog })
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

  it('a tab in a project folder (2.1.3-beta.18 section 3.2): the host\'s project and checkout root hooks are in its settings before the app\'s; a link is not read, with one log line', async () => {
    const d = remoteFakeDir
    expect(d).toMatch(/aicc-e2e\./)
    // A git checkout whose root has a local settings file, and the session in
    // a subfolder whose project settings name a hook, beside a local settings
    // file that is a link. Made 0700 and 0600, as the user's own.
    const hook = (word: string) => JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `echo ${word}` }] }] } })
    const hasGit = sshRun('command -v git >/dev/null 2>&1 && echo yes || echo no').out.trim() === 'yes'
    note('project-git', hasGit)
    const made = sshRun(`umask 077 && cd ${d} && mkdir -p repo/.claude repo/sub/.claude && { ${hasGit ? 'git -C repo init -q' : 'true'}; } && printf '%s' '${hook('project')}' > repo/sub/.claude/settings.json && printf '%s' '${hook('root')}' > repo/.claude/settings.local.json && ln -s /etc/hostname repo/sub/.claude/settings.local.json && echo made`)
    expect(made.out.trim(), made.err).toBe('made')
    const m: RemoteMachineRecord = { ...machine, claudePath: `${d}/aicc-fake-cli`, check: { at: Date.now(), ok: true } }
    inUse = 1
    const plan = remoteLaunchOf(claudeRemoteLaunch, m, { model: 'e2e-model', ssh: { host: target.host, port: target.port, username: target.user, remotePath: `${d}/repo/sub` } }, null, () => true, remoteSessionId('e2e-tab-3'), 100, 30)
    const before = sessionLogs.length
    const pty = new RemoteHelperPty({ appPtyId: 'e2e-tab-3', machine: m, installId: machines.installId(), runner, spec: plan.spec, plan, log: sessionLog })
    let out = ''
    pty.onData((x) => { out += x })
    try {
      await until('the fake CLI\'s banner', () => out.includes('FAKE-CLI READY'))
      const settings = JSON.parse(sshRun(`cat "${plan.helper.folder}/settings.json"`).out) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
      const stop = settings.hooks.Stop.map((e) => e.hooks[0].command)
      note('project-stop-hooks', stop)
      // The user's own come first (a host line's account may have some), then the project's, the checkout root's, the app's last.
      const own = `'${plan.helper.helperPath}' hook --store '${plan.helper.store}' --session ${plan.helper.sid}`
      // With no git on the host, no checkout root is found, so its file is not read.
      if (hasGit) expect(stop.slice(-3)).toEqual(['echo project', 'echo root', own])
      else expect(stop.slice(-2)).toEqual(['echo project', own])
      const skipped = sessionLogs.slice(before).filter((l) => l.includes('was not read'))
      expect(skipped).toEqual([`[remote-helper] ${plan.helper.sid}: cwd .claude/settings.local.json on ${target.host} was not read (link), so nothing it sets is in the session's settings`])
    } finally {
      pty.kill()
      await pty.ended
      inUse = 0
    }
    await untilHost('its folder to go', `test -e "${plan.helper.folder}" && echo there || echo gone`, 'gone')
  })

  // The reads script's owner, mode and size answers, run by a real shell
  // (3.2's fix round: only fake answers fed the app before). Each file is a
  // regular one of the user's in its own private folder, but for what is
  // named; none of their hooks may reach the session's settings.
  it('project files open to others or over the bound are not read, with one log line each (2.1.3-beta.18 section 3.2)', async () => {
    const d = remoteFakeDir
    expect(d).toMatch(/aicc-e2e\./)
    // `open`: its settings.json is 300 KiB of valid JSON (over the 256 KiB
    // bound), and its settings.local.json can be written by anyone (0666).
    const big = JSON.stringify({ ...JSON.parse(hookText('big')), pad: 'x'.repeat(300 * 1024) })
    const made = sshRun(`umask 077 && mkdir -p ${d}/proj/open/.claude && cat > ${d}/proj/open/.claude/settings.json && printf '%s' '${hookText('open')}' > ${d}/proj/open/.claude/settings.local.json && chmod 666 ${d}/proj/open/.claude/settings.local.json && stat -c '%a %s' ${d}/proj/open/.claude/settings.local.json ${d}/proj/open/.claude/settings.json`, Buffer.from(big))
    note('proj-open-files', made.out)
    expect(made.out.trim().split('\n'), made.err).toEqual([`666 ${hookText('open').length}`, `600 ${Buffer.byteLength(big)}`])
    const open = await tabSettings('e2e-tab-open', `${d}/proj/open`)
    // One comparison, so a failure shows every part that differs.
    expect({
      appLast: open.stop.at(-1) === open.own,
      big: open.stop.includes('echo big'),
      open: open.stop.includes('echo open'),
      skipped: open.skipped.filter((l) => !l.includes(`${open.sid}: home `)),
    }).toEqual({
      appLast: true,
      big: false,
      open: false,
      skipped: [notReadLine(open.sid, 'cwd', '.claude/settings.json', 'size'), notReadLine(open.sid, 'cwd', '.claude/settings.local.json', 'mode')],
    })
  })

  it('a project file of another user\'s (made so by sudo, where it runs with no password: always on the CI runner) is not read, with one log line (2.1.3-beta.18 section 3.2)', async () => {
    const d = remoteFakeDir
    expect(d).toMatch(/aicc-e2e\./)
    const sudo = sshRun('sudo -n true >/dev/null 2>&1 && echo yes || echo no').out.trim() === 'yes'
    note('proj-sudo', sudo)
    // On the CI runner it must run: the owner answer is not left unexercised there.
    if (onRunner()) expect(sudo, 'sudo with no password on the CI runner').toBe(true)
    if (!sudo) return
    // `other`: its settings.json is made another user's (nobody); still 0600.
    const other = sshRun(`umask 077 && mkdir -p ${d}/proj/other/.claude && printf '%s' '${hookText('other')}' > ${d}/proj/other/.claude/settings.json && sudo -n chown nobody ${d}/proj/other/.claude/settings.json && stat -c '%U %a' ${d}/proj/other/.claude/settings.json`)
    note('proj-other-file', other.out)
    expect(other.out.trim(), other.err).toBe('nobody 600')
    const theirs = await tabSettings('e2e-tab-other', `${d}/proj/other`)
    expect({
      appLast: theirs.stop.at(-1) === theirs.own,
      other: theirs.stop.includes('echo other'),
      skipped: theirs.skipped.filter((l) => !l.includes(`${theirs.sid}: home `)),
    }).toEqual({ appLast: true, other: false, skipped: [notReadLine(theirs.sid, 'cwd', '.claude/settings.json', 'owner')] })
  })

  // A tab that starts in the home folder: that folder is the user's own
  // source, so no project or checkout file is read there. And the user's own
  // settings file is read as Claude Code reads it (3.2's fix round): a
  // dotfiles link (stow, chezmoi, Home Manager) is followed, so its hooks stay
  // in the session's settings. Only on the CI runner is ~/.claude changed for
  // that: settings.json becomes a link to a file holding a Stop hook, and a
  // settings.local.json holding another one shows no project file is read;
  // both are put back as they were.
  it('a tab in the home folder: the user\'s own settings file read as Claude Code reads it, a link followed, and no project or checkout file (2.1.3-beta.18 section 3.2)', async () => {
    const d = remoteFakeDir
    expect(d).toMatch(/aicc-e2e\./)
    const runnerCase = onRunner()
    let set: ReturnType<typeof sshRun> | undefined
    if (runnerCase) {
      const h = `${d}/home`
      const c = '"${HOME:?}/.claude"'
      // The undo removes only what the step made (the link to this run's
      // file, a local file equal to this run's), moves back what it saved,
      // removes ~/.claude when the step made it, and says whether all of
      // that is done. Set before the step changes anything.
      homeUndo = [
        `if [ -L ${c}/settings.json ] && [ "$(readlink ${c}/settings.json)" = ${h}/hooks.json ]; then rm -f -- ${c}/settings.json; fi`,
        `if [ -f ${c}/settings.local.json ] && [ ! -L ${c}/settings.local.json ] && cmp -s ${c}/settings.local.json ${h}/local.json; then rm -f -- ${c}/settings.local.json; fi`,
        `for f in settings.json settings.local.json; do if [ -e ${h}/saved/$f ] || [ -L ${h}/saved/$f ]; then [ -e ${c}/$f ] || [ -L ${c}/$f ] || mv -- ${h}/saved/$f ${c}/$f; fi; done`,
        `if [ -e ${h}/made-dir ]; then rmdir -- ${c} && rm -f -- ${h}/made-dir; fi`,
        `n=0; for f in saved/settings.json saved/settings.local.json made-dir; do if [ -e ${h}/$f ] || [ -L ${h}/$f ]; then n=1; fi; done; [ $n = 0 ] && echo undone || echo not-undone`,
      ].join('; ')
      // Each file there now saved aside first, then the link and the local file made.
      set = sshRun([
        `umask 077; mkdir -p ${h}/saved || exit 1`,
        `printf '%s' '${hookText('home-link')}' > ${h}/hooks.json && printf '%s' '${hookText('home-local')}' > ${h}/local.json || exit 1`,
        `if [ -e ${c} ] || [ -L ${c} ]; then echo dir-there; else mkdir ${c} && touch ${h}/made-dir && echo dir-made; fi`,
        `for f in settings.json settings.local.json; do if [ -e ${c}/$f ] || [ -L ${c}/$f ]; then mv -- ${c}/$f ${h}/saved/$f || exit 1; echo saved-$f; fi; done`,
        `ln -s ${h}/hooks.json ${c}/settings.json && cp ${h}/local.json ${c}/settings.local.json && echo made`,
      ].join('; '))
      note('home-set', set.out)
    }
    try {
      if (set) expect(set.out.trim().split('\n').pop(), set.err).toBe('made')
      const home = await tabSettings('e2e-tab-home', '~')
      if (runnerCase) {
        // The user's file, a link, is read: its hook first, the app's last,
        // and no settings.local.json of the home folder between them. No
        // project or checkout file is read in the home folder: none is even
        // tried, so nothing is logged.
        expect({ stop: home.stop, skipped: home.skipped }).toEqual({ stop: ['echo home-link', home.own], skipped: [] })
      } else {
        // A host line leaves the account's own files as they are: no project
        // or checkout line, and the app's hooks last.
        expect({ appLast: home.stop.at(-1) === home.own, project: home.skipped.filter((l) => / (cwd|checkout) /.test(l)) }).toEqual({ appLast: true, project: [] })
      }
    } finally {
      if (homeUndo) {
        const undo = sshRun(homeUndo)
        note('home-undo', undo.out)
        expect(undo.out.trim(), undo.err).toBe('undone')
        homeUndo = ''
      }
    }
  })

  it('a tab\'s status line, hook events and tool calls cross the bridge to the app\'s side, each once, and again after its link\'s ssh is killed (2.1.3-beta.18 section 3.2)', async () => {
    const d = remoteFakeDir
    expect(d).toMatch(/aicc-e2e\./)
    const m: RemoteMachineRecord = { ...machine, claudePath: `${d}/aicc-fake-cli`, check: { at: Date.now(), ok: true } }
    const id = 'e2e-tab-4'
    const gate = gatedRunner()
    inUse = 1
    const plan = remoteLaunchOf(claudeRemoteLaunch, m, { model: 'e2e-model' }, null, () => true, remoteSessionId(id), 100, 30, true)
    const pty = new RemoteHelperPty({ appPtyId: id, machine: m, installId: machines.installId(), runner: gate.runner, spec: plan.spec, plan, signals, log: sessionLog })
    const relays: Relay[] = []
    let out = ''
    pty.onData((x) => { out += x })
    try {
      await until('the fake CLI\'s banner', () => out.includes('FAKE-CLI READY'))
      const cmd = tabCommands(plan.helper.folder)
      const relay = () => { const r = new Relay(cmd.conductor); relays.push(r); relaysLeft.push(r); return r }

      // The status line: cut to the keep-list and mapped by the Claude
      // package, as the tab's own (no session id, no transcript path, nothing
      // outside the keep-list).
      post(cmd.status, statusPayload('E2E Model', 1))
      await until('the first status line', () => statusOf(id).length === 1)
      expect(statusOf(id)[0]).toEqual({
        model: 'E2E Model 1', modelId: 'e2e-model-1', contextUsedPercent: 11, contextWindowSize: 200000, inputTokens: 1000, outputTokens: 10,
        costUsd: 0.01, rateLimitCurrent: 21, rateLimitCurrentResets: '2030-03-17T17:46:40.000Z',
      })
      // A hook event: cut to the keep-list (no prompt), for the tab.
      post(cmd.hook('Stop'), { hook_event_name: 'Stop', session_id: 'not-this-tab', transcript_path: '/home/someone/t.jsonl', prompt: 'never kept', stop_hook_active: false })
      await until('the first hook event', () => eventsOf(id).length === 1)
      expect([eventsOf(id)[0].kind, eventsOf(id)[0].payload]).toEqual(['Stop', { hook_event_name: 'Stop', session_id: 'not-this-tab', transcript_path: '/home/someone/t.jsonl' }])
      // A tool call: served as the tab's session, its provider's, both ways.
      const a = relay()
      a.call(1, 'first')
      await until('the first tool answer', () => a.answerTo(1).length === 1)
      expect(a.answerTo(1)).toEqual([`served for ${id} as claude: first`])
      expect(servedFor(id)).toEqual([{ id, provider: 'claude' }])

      // The link's ssh is killed, and its new link held back until the holder
      // has let the old one go (its record says it is not attached).
      const link = pty.linkPid
      expect(link).toBeGreaterThan(0)
      gate.hold()
      process.kill(link!)
      const record = `${plan.helper.store}/${plan.helper.sid}.json`
      const start = Date.now()
      for (;;) {
        let attached: unknown
        try { attached = (JSON.parse(sshRun(`cat "${record}"`).out) as { attached?: unknown }).attached } catch { attached = undefined }
        if (attached === false) break
        if (Date.now() - start > 15_000) throw new Error(`the holder did not let the link go (attached: ${String(attached)})`)
        await new Promise((r) => setTimeout(r, 250))
      }
      // Meanwhile: two statuses (the holder keeps the newest only), two hook
      // events (queued), and a tool call from a tool server started in the
      // cut: its stream is kept and the call held. A batch is answered at once
      // while the app is away (relay.rs): its answer shows the relay is away
      // and has read the call before it.
      post(cmd.status, statusPayload('E2E Model', 2))
      post(cmd.status, statusPayload('E2E Model', 3))
      post(cmd.hook('Notification'), { hook_event_name: 'Notification', session_id: 'not-this-tab', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt', tool_input: { command: 'never kept' } })
      post(cmd.hook('Stop'), { hook_event_name: 'Stop', session_id: 'not-this-tab' })
      const b = relay()
      b.call(2, 'during')
      b.send([{ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'e2e_echo', arguments: { word: 'probe' } } }])
      await until('the relay to answer the batch as away', () => b.answers.length === 1)
      expect(b.answers).toEqual([[{ jsonrpc: '2.0', id: 99, result: { content: [{ type: 'text', text: 'AI Code Conductor is updating, try again shortly' }], isError: true } }]])
      expect([statusOf(id).length, eventsOf(id).length, pty.linkPid]).toEqual([1, 1, link])

      // The new link: the tab attaches again, and gets the newest status once,
      // the queued events once each in order, and the held call answered.
      gate.release()
      await until('a new link', () => pty.linkPid !== undefined && pty.linkPid !== link)
      await until('the call made in the cut to be answered', () => b.answerTo(2).length === 1)
      expect(b.answerTo(2)).toEqual([`served for ${id} as claude: during`])
      await until('the newest status', () => statusOf(id).length === 2)
      await until('the queued hook events', () => eventsOf(id).length === 3)
      expect(statusOf(id)[1].model).toBe('E2E Model 3')
      expect(eventsOf(id).slice(1).map((e) => [e.kind, e.payload])).toEqual([
        ['Notification', { hook_event_name: 'Notification', session_id: 'not-this-tab', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }],
        ['Stop', { hook_event_name: 'Stop', session_id: 'not-this-tab' }],
      ])
      expect(sessionLogs.some((l) => l.includes(`${pty.sid}: the connection closed; attaching again from`))).toBe(true)

      // And all three cross again on the new link: the tool server started
      // before the cut keeps its stream.
      a.call(3, 'after')
      await until('a tool answer after the re-attach', () => a.answerTo(3).length === 1)
      expect(a.answerTo(3)).toEqual([`served for ${id} as claude: after`])
      post(cmd.status, statusPayload('E2E Model', 4))
      post(cmd.hook('SessionStart'), { hook_event_name: 'SessionStart', session_id: 'not-this-tab', source: 'resume' })
      await until('a status and a hook event after the re-attach', () => statusOf(id).length === 3 && eventsOf(id).length === 4)

      // Each once: the whole record of what reached the app's side for the tab.
      note('signals-tab-4', { status: statusOf(id), events: eventsOf(id), served: servedFor(id), a: a.answers, b: b.answers })
      expect(statusOf(id).map((s) => s.model)).toEqual(['E2E Model 1', 'E2E Model 3', 'E2E Model 4'])
      expect(eventsOf(id).map((e) => e.kind)).toEqual(['Stop', 'Notification', 'Stop', 'SessionStart'])
      const seqs = eventsOf(id).map((e) => e.seq)
      expect(seqs.every((s, i) => i === 0 || s > seqs[i - 1])).toBe(true)
      expect(a.answers.map((x) => (x as { id?: unknown }).id)).toEqual([1, 3])
      expect(b.answers.slice(1).map((x) => (x as { id?: unknown }).id)).toEqual([2])
      // Served three times, each as the tab's: the first stream, then both kept streams on the new link.
      expect(servedFor(id)).toEqual([{ id, provider: 'claude' }, { id, provider: 'claude' }, { id, provider: 'claude' }])
      expect(got.status.length + got.events.length).toBe(statusOf(id).length + eventsOf(id).length)
      // A tool server whose input ends exits 0, and printed nothing but its messages.
      for (const r of relays) expect(await r.end()).toBe(0)
      expect(relays.flatMap((r) => r.noise)).toEqual([])
    } finally {
      gate.release()
      for (const r of relays) r.kill()
      pty.kill()
      await pty.ended
      inUse = 0
      if (OUT) fs.writeFileSync(path.join(OUT, 'session-4.txt'), out)
    }
    await untilHost('the holder to end', `pgrep -f -- "--store $HOME/[.]aicc/${machine.did}/store" | wc -l`, '0')
    await untilHost('its folder to go', `test -e "${plan.helper.folder}" && echo there || echo gone`, 'gone')
    // Its hook state was ended once, for its id, before its folder went.
    expect(got.ended).toEqual([id])
  })

  it('two tabs on the same machine at once: each one\'s status line, hook event and tool call reach its own tab only (2.1.3-beta.18 section 3.2)', async () => {
    const d = remoteFakeDir
    expect(d).toMatch(/aicc-e2e\./)
    const m: RemoteMachineRecord = { ...machine, claudePath: `${d}/aicc-fake-cli`, check: { at: Date.now(), ok: true } }
    const ids = ['e2e-tab-5', 'e2e-tab-6']
    const before = { status: got.status.length, events: got.events.length, served: got.served.length }
    inUse = 2
    const tabs = ids.map((id) => {
      const plan = remoteLaunchOf(claudeRemoteLaunch, m, { model: 'e2e-model' }, null, () => true, remoteSessionId(id), 100, 30, true)
      const pty = new RemoteHelperPty({ appPtyId: id, machine: m, installId: machines.installId(), runner, spec: plan.spec, plan, signals, log: sessionLog })
      const tab = { id, plan, pty, out: '', relay: undefined as Relay | undefined }
      pty.onData((x) => { tab.out += x })
      return tab
    })
    try {
      for (const t of tabs) await until(`${t.id}'s banner`, () => t.out.includes('FAKE-CLI READY'))
      expect(tabs[0].plan.helper.folder).not.toBe(tabs[1].plan.helper.folder)
      for (const t of tabs) {
        const cmd = tabCommands(t.plan.helper.folder)
        post(cmd.status, statusPayload(`Model of ${t.id}`, 7))
        post(cmd.hook('Notification'), { hook_event_name: 'Notification', session_id: `cli-of-${t.id}`, message: `${t.id} needs you`, notification_type: 'permission_prompt' })
        t.relay = new Relay(cmd.conductor)
        relaysLeft.push(t.relay)
        t.relay.call(1, t.id)
      }
      for (const t of tabs) {
        await until(`${t.id}'s status, hook event and tool answer`, () => statusOf(t.id).length === 1 && eventsOf(t.id).length === 1 && t.relay!.answerTo(1).length === 1)
      }
      note('signals-two-tabs', tabs.map((t) => ({ id: t.id, status: statusOf(t.id), events: eventsOf(t.id), served: servedFor(t.id), answers: t.relay!.answers })))
      for (const t of tabs) {
        expect(statusOf(t.id).map((s) => s.model)).toEqual([`Model of ${t.id} 7`])
        expect(eventsOf(t.id).map((e) => e.payload)).toEqual([{ hook_event_name: 'Notification', session_id: `cli-of-${t.id}`, message: `${t.id} needs you`, notification_type: 'permission_prompt' }])
        expect(t.relay!.answerTo(1)).toEqual([`served for ${t.id} as claude: ${t.id}`])
        expect(servedFor(t.id)).toEqual([{ id: t.id, provider: 'claude' }])
      }
      // Nothing for any other tab.
      expect([got.status.length - before.status, got.events.length - before.events, got.served.length - before.served]).toEqual([2, 2, 2])
      for (const t of tabs) expect(await t.relay!.end()).toBe(0)
    } finally {
      for (const t of tabs) { t.relay?.kill(); t.pty.kill() }
      for (const t of tabs) await t.pty.ended
      inUse = 0
    }
    await untilHost('both holders to end', `pgrep -f -- "--store $HOME/[.]aicc/${machine.did}/store" | wc -l`, '0')
    for (const t of tabs) await untilHost(`${t.id}'s folder to go`, `test -e "${t.plan.helper.folder}" && echo there || echo gone`, 'gone')
    // Each tab's hook state ended once, for its own id.
    expect(got.ended.filter((x) => ids.includes(x)).sort()).toEqual([...ids].sort())
  })

  // The end's removal and Check's sweep, run by a real shell (3.2's fix
  // round: only fake answers fed the app before). A tab's end does not remove
  // its folder while its holder still has a record (`held`): the folder is
  // the next Check's then. A Check removes each session folder whose holder
  // is gone, and keeps a running tab's.
  it('a running tab keeps its folder: its end\'s removal says held, and a Check removes only a folder whose holder is gone (2.1.3-beta.18 section 3.2)', async () => {
    const d = remoteFakeDir
    expect(d).toMatch(/aicc-e2e\./)
    const m: RemoteMachineRecord = { ...machine, claudePath: `${d}/aicc-fake-cli`, check: { at: Date.now(), ok: true } }
    const id = 'e2e-tab-7'
    inUse = 1
    const plan = remoteLaunchOf(claudeRemoteLaunch, m, { model: 'e2e-model' }, null, () => true, remoteSessionId(id), 100, 30, true)
    const pty = new RemoteHelperPty({ appPtyId: id, machine: m, installId: machines.installId(), runner, spec: plan.spec, plan, signals, log: sessionLog })
    const live = plan.helper.folder
    // A folder a dropped connection could have left: a session id no tab of
    // this run has, private, with a file in it, and no holder's record.
    const stray = `${path.posix.dirname(live)}/${remoteSessionId('e2e-stray')}`
    let out = ''
    pty.onData((x) => { out += x })
    try {
      await until('the fake CLI\'s banner', () => out.includes('FAKE-CLI READY'))
      const made = sshRun(`umask 077 && mkdir -m 700 "${stray}" && printf x > "${stray}/settings.json" && test ! -e "${plan.helper.store}/${remoteSessionId('e2e-stray')}.json" && echo made`)
      expect(made.out.trim(), made.err).toBe('made')
      // The end's removal for the running tab: refused, its folder kept.
      const nonce = newNonce()
      const un = await runScript(runner, target, 'unsession', [nonce, machine.did, machines.installId(), plan.helper.sid])
      const res = readScriptResult(un.stdout, nonce)
      note('unsession-held', { code: un.code, values: res ? [...res.values] : null, ok: res?.ok, refused: res?.refused })
      expect([res?.ok, res?.refused], un.stderr).toEqual([false, 'held'])
      expect(sshRun(`test -f "${live}/settings.json" && echo there || echo gone`).out.trim()).toBe('there')
      // A Check: the stray folder goes, the running tab's stays.
      const logsBefore = machineLogs.length
      const r = await machines.check(machine.did)
      note('check-sweep', { r, logs: machineLogs.slice(logsBefore) })
      expect(r.ok, r.message).toBe(expectRc || r.ok)
      expect(machineLogs.slice(logsBefore)).toContain(`[remote-helper] ${target.host}: removed 1 session folder(s) whose holder is gone`)
      expect(sshRun(`test -e "${stray}" && echo there || echo gone; test -f "${live}/settings.json" && echo there || echo gone`).out.trim().split('\n')).toEqual(['gone', 'there'])
      // The running tab is still served after the Check.
      pty.write('still\r')
      await until('input after the Check', () => out.includes('echo: still'))
    } finally {
      pty.kill()
      await pty.ended
      inUse = 0
    }
    await untilHost('the holder to end', `pgrep -f -- "--store $HOME/[.]aicc/${machine.did}/store" | wc -l`, '0')
    await untilHost('its folder to go', `test -e "${live}" && echo there || echo gone`, 'gone')
    expect(got.ended.filter((x) => x === id)).toEqual([id])
  })

  // 6.3 (2.1.3-beta.19, aicc_planning#437): the folder a quit leaves goes at
  // the next start. The list the app takes at start-up (one exec per machine)
  // removes a session folder whose holder is gone and keeps a running tab's.
  it('6.3: the start-up list removes a session folder whose holder is gone, and keeps a running tab\'s (2.1.3-beta.19 section 6.3)', async () => {
    const d = remoteFakeDir
    expect(d).toMatch(/aicc-e2e\./)
    const m: RemoteMachineRecord = { ...machine, claudePath: `${d}/aicc-fake-cli`, check: { at: Date.now(), ok: true } }
    const id = 'e2e-tab-63'
    inUse = 1
    const plan = remoteLaunchOf(claudeRemoteLaunch, m, { model: 'e2e-model' }, null, () => true, remoteSessionId(id), 100, 30, true)
    const pty = new RemoteHelperPty({ appPtyId: id, machine: m, installId: machines.installId(), runner, spec: plan.spec, plan, signals, log: sessionLog })
    const live = plan.helper.folder
    // A folder a quit left: a session id no tab of this run has, private, with
    // a file in it, and no holder's record.
    const stray = `${path.posix.dirname(live)}/${remoteSessionId('e2e-quit-left')}`
    let out = ''
    pty.onData((x) => { out += x })
    try {
      await until('the fake CLI\'s banner', () => out.includes('FAKE-CLI READY'))
      const made = sshRun(`umask 077 && mkdir -m 700 "${stray}" && printf x > "${stray}/settings.json" && test ! -e "${plan.helper.store}/${remoteSessionId('e2e-quit-left')}.json" && echo made`)
      expect(made.out.trim(), made.err).toBe('made')
      const logs: string[] = []
      const listed = await listKept({ runner, installId: machines.installId(), log: (x) => logs.push(x) }, machine)
      note('start-up-list-63', { ok: listed.ok, logs })
      expect(listed.ok, listed.ok ? '' : listed.why).toBe(true)
      expect(logs).toContain(`[remote-helper] ${target.host}: removed 1 session folder(s) whose holder is gone`)
      expect(sshRun(`test -e "${stray}" && echo there || echo gone; test -f "${live}/settings.json" && echo there || echo gone`).out.trim().split('\n')).toEqual(['gone', 'there'])
      // The running tab is still served after the list.
      pty.write('still\r')
      await until('input after the list', () => out.includes('echo: still'))
    } finally {
      pty.kill()
      await pty.ended
      inUse = 0
    }
    await untilHost('its folder to go', `test -e "${live}" && echo there || echo gone`, 'gone')
  })

  // 2.1.3-beta.19 section 1.2 (aicc_planning#437): a session kept until it is
  // ended, by section 1.1's helper (`hold --until-ended`), as an SSH
  // Persistent tab's is.
  it('a 3 s clock session ends by its clock; an until-ended one outlives it with no connection, stays listed, attaches again with its replay and launches nothing, takes a status, a hook event and a tool call, and End ends it (2.1.3-beta.19 section 1.2)', async () => {
    const d = remoteFakeDir
    expect(d).toMatch(/aicc-e2e\./)
    note('logind', machine.logind)
    const dev = `$HOME/.aicc/${machine.did}`
    const bin = `${dev}/helper/${machine.helper.folder}/aicc-helper`
    // The clock kind, beta.18's: a holder with a 3 s away clock and no connection.
    const clockSid = remoteSessionId('e2e-clock-3s')
    const held = sshRun(`"${bin}" hold --store "${dev}/store" --session ${clockSid} --label e2e-clock-3s --away 3 --detach`)
    expect(held.code, held.err).toBe(0)
    const clockLine = held.out.split('\n').find((l) => l.startsWith('{'))
    const clockRecord = readRecord(JSON.parse(clockLine ?? 'null'), 'unix')
    // The record its detached start printed: the holder runs, of the clock kind.
    expect(clockRecord && [clockRecord.session, untilEnded(clockRecord), clockRecord.away]).toEqual([clockSid, false, 3])
    // The until-ended kind, an SSH Persistent tab's, on the fake CLI.
    const m: RemoteMachineRecord = { ...machine, claudePath: `${d}/aicc-fake-cli`, check: { at: Date.now(), ok: true } }
    const id = 'e2e-kept-1'
    inUse = 1
    const plan = remoteLaunchOf(claudeRemoteLaunch, m, { model: 'e2e-model' }, null, () => true, remoteSessionId(id), 100, 30, true)
    const first = new RemoteHelperPty({ appPtyId: id, machine: m, installId: machines.installId(), runner, spec: plan.spec, plan, signals, log: sessionLog, kind: 'until-ended' })
    let out = ''
    first.onData((x) => { out += x })
    let second: RemoteHelperPty | undefined
    const relays: Relay[] = []
    try {
      await until('the fake CLI\'s banner', () => out.includes('FAKE-CLI READY'))
      first.write('before\r')
      await until('the echo', () => out.includes('echo: before'))
      // Let go, as Leave running and a quit do: no term.end.
      first.kill()
      await first.ended
      inUse = 0
      // Past the clock holder's 3 s with no connection: it has ended; the kept
      // one runs on, listed as until-ended, with nothing attached.
      await new Promise((r) => setTimeout(r, 6000))
      const listed = await listKept({ runner, installId: machines.installId(), log: sessionLog }, machine)
      expect(listed.ok, listed.ok ? '' : listed.why).toBe(true)
      if (!listed.ok) return
      note('kept-listing', listed.sessions.map((s) => ({ sid: s.session, lifetime: s.lifetime ?? null, away: s.away, attached: s.attached, child: s.child })))
      expect(listed.sessions.some((s) => s.session === clockSid)).toBe(false)
      const kept = listed.sessions.find((s) => s.session === plan.helper.sid)
      expect([kept?.lifetime, kept?.away, kept?.attached, kept?.child]).toEqual(['until-ended', null, false, 'running'])
      // While nothing is attached: a status and a hook event (kept, and queued).
      const cmd = tabCommands(plan.helper.folder)
      const statusBefore = statusOf(id).length
      const eventsBefore = eventsOf(id).length
      post(cmd.status, statusPayload('Kept', 1))
      post(cmd.hook('Stop'), { hook_event_name: 'Stop', session_id: 'not-this-tab' })
      // A re-open: the start's hold exits 3, list mode names it until-ended,
      // and the tab attaches over a new bridge, launching nothing.
      inUse = 1
      second = new RemoteHelperPty({ appPtyId: id, machine: m, installId: machines.installId(), runner, spec: plan.spec, plan, signals, log: sessionLog, kind: 'until-ended' })
      let again = ''
      second.onData((x) => { again += x })
      await until('the replay', () => again.includes('echo: before'))
      expect(second.attachedToKept).toBe(true)
      expect(sessionLogs).toContain(`[remote-helper] ${plan.helper.sid}: a session kept for this tab runs on ${target.host}; attaching to it, nothing is launched`)
      await until('the newest status', () => statusOf(id).length > statusBefore)
      expect(statusOf(id).at(-1)!.model).toBe('Kept 1')
      await until('the queued hook event', () => eventsOf(id).length === eventsBefore + 1)
      // A tool call after the re-attach, served as the tab's.
      const r = new Relay(cmd.conductor)
      relays.push(r)
      relaysLeft.push(r)
      r.call(1, 'kept')
      await until('the tool answer', () => r.answerTo(1).length === 1)
      expect(r.answerTo(1)).toEqual([`served for ${id} as claude: kept`])
      // One CLI: input reaches the one that was kept.
      second.write('after\r')
      await until('input after the re-attach', () => again.includes('echo: after'))
      expect(await r.end()).toBe(0)
      // End: term.end over a link of its own, then its folder.
      expect(await second.end()).toEqual({ ok: true })
    } finally {
      for (const r of relays) r.kill()
      first.kill()
      if (second) await second.end().catch(() => undefined)
      inUse = 0
    }
    // The bracket keeps this check's own command line from matching itself.
    await untilHost('the kept holder to end', `pgrep -f -- "--session [r]${plan.helper.sid.slice(1)}" | wc -l`, '0')
    await untilHost('its folder to go', `test -e "${plan.helper.folder}" && echo there || echo gone`, 'gone')
  })

  it('a list and an attach to an until-ended holder from a bridge of another build: an app update that changed the helper, after its Check (2.1.3-beta.19 section 1.2)', async () => {
    const other = await readBundledLinuxHelper({ manifest: need('REMOTE_HELPER_OTHER_MANIFEST'), file: need('REMOTE_HELPER_OTHER_BIN') })
    if (!other.ok) throw new Error(`the other build and its manifest do not read: ${other.why}`)
    expect(other.helper.sha256).not.toBe(helper.sha256)
    note('other-helper', { version: other.helper.version, sha256: other.helper.sha256 })
    const d = remoteFakeDir
    const m: RemoteMachineRecord = { ...machine, claudePath: `${d}/aicc-fake-cli`, check: { at: Date.now(), ok: true } }
    const id = 'e2e-kept-2'
    inUse = 1
    const plan = remoteLaunchOf(claudeRemoteLaunch, m, { model: 'e2e-model' }, null, () => true, remoteSessionId(id), 100, 30, true)
    const first = new RemoteHelperPty({ appPtyId: id, machine: m, installId: machines.installId(), runner, spec: plan.spec, plan, signals, log: sessionLog, kind: 'until-ended' })
    let out = ''
    first.onData((x) => { out += x })
    let later: RemoteHelperPty | undefined
    try {
      await until('the fake CLI\'s banner', () => out.includes('FAKE-CLI READY'))
      first.write('kept by the first build\r')
      await until('the echo', () => out.includes('echo: kept by the first build'))
      first.kill()
      await first.ended
      // The update's Check: the other build installed beside the first, which
      // the kept holder still runs from; nothing is ended.
      const store = memoryStore()
      store.write({ v: 1, installId: machines.installId(), machines: machines.list() })
      const updated = new RemoteMachines({ runner, store, bundled: async () => ({ ok: true, helpers: [other.helper] }), inUse: () => 0, log: (x) => { machineLogs.push(x) } })
      const checked = await updated.check(machine.did)
      note('other-check', checked)
      expect(checked.ok, checked.message).toBe(true)
      const after = updated.get(machine.did)!
      expect(after.helper.sha256).toBe(other.helper.sha256)
      // The other build's list names the first build's until-ended holder.
      const listed = await listKept({ runner, installId: machines.installId(), log: sessionLog }, after)
      expect(listed.ok, listed.ok ? '' : listed.why).toBe(true)
      if (!listed.ok) return
      const kept = listed.sessions.find((s) => s.session === plan.helper.sid)
      expect(kept?.lifetime).toBe('until-ended')
      expect(kept?.helper).toBe(helper.version)
      // And its bridge attaches to it: the replay, and input to the same CLI.
      const m2: RemoteMachineRecord = { ...after, claudePath: `${d}/aicc-fake-cli`, check: { at: Date.now(), ok: true } }
      const plan2 = remoteLaunchOf(claudeRemoteLaunch, m2, { model: 'e2e-model' }, null, () => true, remoteSessionId(id), 100, 30, true)
      later = new RemoteHelperPty({ appPtyId: id, machine: m2, installId: machines.installId(), runner, spec: plan2.spec, plan: plan2, signals, log: sessionLog, kind: 'until-ended' })
      let again = ''
      later.onData((x) => { again += x })
      await until('the replay through the other build', () => again.includes('echo: kept by the first build'))
      expect(later.attachedToKept).toBe(true)
      later.write('through the other build\r')
      await until('input through the other build', () => again.includes('echo: through the other build'))
      expect(await later.end()).toEqual({ ok: true })
    } finally {
      first.kill()
      if (later) await later.end().catch(() => undefined)
      inUse = 0
    }
    await untilHost('the kept holder to end', `pgrep -f -- "--session [r]${plan.helper.sid.slice(1)}" | wc -l`, '0')
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
