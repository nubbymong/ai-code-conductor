/**
 * A picture into a Claude Code tab through the session helper on a Linux host
 * (plan 2.1.3-beta.21, block 5.3's CI line; ADR-032; aicc_planning#447): the
 * app's own paste route, its file.put, the clipboard stand-in and the Claude
 * package's key and placeholder read, under Node, against REAL Claude Code
 * 2.1.332 on a real host over real ssh with key sign-in only, pointed at
 * probe P11's model stand-in. The picture the model gets is compared by its
 * decoded pixels (helper/probes/png-rgba.cjs), as the Snap e2e compares
 * (plan 2.1.7): the CLI re-encodes what it reads.
 *
 * Where it runs: the dispatch-only `remote-helper-e2e` job of ci.yml, after
 * the device check and the review check, against the runner's localhost
 * sshd, with Claude Code 2.1.332 installed by the job into a prefix of its
 * own from its platform package with scripts off. Only there for now: the
 * model stand-in listens on this computer's loopback, which a host reaches
 * only when it is this computer. The host lines (Rocky, the Pi: probe PR1
 * first) run later in plan block 5.3, not in this file. Never 192.168.50.185.
 * Run as
 *   npx vitest run --config vitest.live.config.ts tests/live/remote-paste.live.ts --retry=0
 * It fails, never skips, when what it needs is not given.
 *
 * What it takes, from the environment (no secret anywhere):
 *   REMOTE_HELPER_HOSTS, REMOTE_HELPER_BIN, REMOTE_HELPER_MANIFEST
 *                        as the device check takes them
 *   REMOTE_PASTE_CLAUDE  the absolute path of the real Claude Code on the host
 *   REMOTE_HELPER_OUT    a folder for the readings (optional)
 *
 * In order:
 *   1. Add the machine (its Check installs the helper).
 *   2. A Claude Code tab on the machine, on a config folder of the run's own
 *      (its CLAUDE_CONFIG_DIR, as a tab on an account's own folder there
 *      gets: onboarding done, the made-up key approved, the project trusted,
 *      the model stand-in named), launched as the app launches it: its `files`
 *      exec wrote the stand-in (clip ok), the CLI's PATH has the session's
 *      bin/ first, the key is Ctrl+V (no keybindings file there), and Claude
 *      Code's prompt reads on the holder's screen.
 *   3. Alt+V from outside the terminal: the app's route sends picture A by
 *      file.put and types only the key, the sentence and Enter; the stand-in
 *      lists the picture's type to the session's own xclip; the model gets
 *      picture A, pixel for pixel.
 *   4. Snap: picture B the same way, with Snap's sentence; the model gets B.
 * Then: the tab ends, the run's folder on the host and the machine's device
 * folder go, the env file the rc step reads goes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { deflateSync } from 'zlib'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RemoteMachines, type MachineStore, type RemoteMachineRecord } from '../../src/main/remote-helper/machines'
import { nodeSshRunner, execArgv, sshEnv, type SshTarget } from '../../src/main/remote-helper/ssh-exec'
import { RemoteHelperPty, remoteSessionId } from '../../src/main/remote-helper/session'
import { remoteLaunchOf } from '../../src/main/remote-helper'
import { claudeRemoteLaunch } from '../../src/main/providers/claude/remote-launch'
import { CLAUDE_RUN_SCREEN } from '../../src/main/providers/claude/run-screen'
import { readBundledLinuxHelper, type BundledLinuxHelper } from '../../src/main/remote-helper/manifest'
import { helperPasteRoute, type RoutePicture } from '../../src/main/paste/helper-route'
import { claudePromptImages, readClaudeScreen } from '../../src/shared/claude-screen'
import { PASTE_SENTENCE, SNAP_RECTANGLE_SENTENCE } from '../../src/shared/clipboard-paste'
import type { RunScreenTyping } from '../../src/main/providers/types'

const need = (name: string): string => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set: this check needs it (see the file's header)`)
  return v
}

const req = createRequire(__filename)
const { pngPixelHashes } = req('../../helper/probes/png-rgba.cjs') as { pngPixelHashes: (b: Buffer) => { rgbaSha256?: string; unread?: string } }
interface StandInEvent { ev: string; t?: number; path?: string; kind?: string; images?: Array<{ rgbaSha256?: string; sha256?: string; kind?: string; width?: number | null; height?: number | null; way?: string }> }
const { createModelStandIn } = req('../../helper/probes/p11-model-stand-in.cjs') as { createModelStandIn: (o: { onEvent: (e: StandInEvent) => void }) => { listen(): Promise<number>; close(): Promise<void> } }

const OUT = process.env.REMOTE_HELPER_OUT
const readings: Record<string, unknown> = {}
const note = (k: string, v: unknown) => { readings[k] = v }
const logs: string[] = []
const events: StandInEvent[] = []

/** The Claude Code this check runs, and the made-up key its config approves (no secret: the stand-in takes any). */
const CLAUDE_VERSION = '2.1.332'
const FAKE_KEY = 'sk-ant-e2e-fake-key-not-real-0000000000'
/** The env file the job's rc step reads in an interactive login shell, for the CLI the tab starts. */
const ENV_FILE = '.aicc-e2e-paste-env'
/** The door's own waits (session-input: CLIPBOARD_READY_WAIT_MS, CLIPBOARD_PLACEHOLDER_WAIT_MS, CLIPBOARD_ENTER_DELAY_MS). */
const WAITS = { readyWaitMs: 5_000, placeholderWaitMs: 10_000, enterDelayMs: 700 }

let target: SshTarget
let helper: BundledLinuxHelper
let claude = ''
let machines: RemoteMachines
let machine: RemoteMachineRecord | undefined
let standIn: { listen(): Promise<number>; close(): Promise<void> } | undefined
let port = 0
/** The run's own folder on the host, inside the home folder. */
let hostDir = ''
let pty: RemoteHelperPty | undefined
let exited = false
let folder = ''
/** Every write the route's door typed into the tab. */
const typed: string[] = []
const runner = nodeSshRunner(() => 'ssh')

function memoryStore(): MachineStore {
  let v: unknown = null
  return { read: () => v, write: (x) => { v = JSON.parse(JSON.stringify(x)) } }
}

const OWN = 'AICC-E2E-OWN'
/** One plain ssh exec for the test's own steps (not the app's). */
function sshRun(command: string, input?: Buffer): { code: number | null; out: string; err: string } {
  const args = execArgv(target, { version: null }, `echo ${OWN}; ${command}`)
  const r = spawnSync('ssh', args, { input: input ?? Buffer.alloc(0), env: sshEnv(process.env), timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
  const raw = String(r.stdout ?? '').replace(/\r\n/g, '\n')
  const at = raw.indexOf(`${OWN}\n`)
  return { code: r.status, out: at >= 0 ? raw.slice(at + OWN.length + 1) : '', err: String(r.stderr ?? '') }
}
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

async function until(what: string, ok: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const start = Date.now()
  while (!(await ok())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(250)
  }
}

// ── the pictures: opaque PNGs made here, named by their decoded pixels ──

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
function crc32(b: Buffer): number { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** An 8-bit RGBA PNG, every pixel opaque, its colours from `px`. */
function png(width: number, height: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = px(x, y)
      raw.set([r, g, b, 255], y * (width * 4 + 1) + 1 + x * 4)
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const PICTURE_A = png(64, 48, (x, y) => [x * 4, y * 5, 200])
const PICTURE_B = png(48, 40, (x, y) => [(x * y) & 0xff, 30, 255 - x * 5])
/** What the route takes from this computer's clipboard: the few calls of a NativeImage it makes. */
const asPicture = (bytes: Buffer): RoutePicture => ({ isEmpty: () => false, toPNG: () => bytes, toJPEG: () => Buffer.alloc(0) }) as unknown as RoutePicture
const rgba = (b: Buffer): string => { const h = pngPixelHashes(b); if (!h.rgbaSha256) throw new Error(`the test's own picture does not read: ${h.unread}`); return h.rgbaSha256 }

/** The model requests that carried picture `ref` (by its pixels) since `from`. */
const carrying = (from: number, ref: string) => events.slice(from).filter((e) => e.ev === 'request' && e.path === '/v1/messages' && (e.images ?? []).some((i) => i.rgbaSha256 === ref))

/** The holder's screen now, as rows of text (for a cause). */
async function screenText(): Promise<string> {
  try { return (await pty!.screenRead!()).lines.map((l) => l.text).join('\n') } catch (err) { return `(no screen read: ${(err as Error).message})` }
}

/**
 * The app's paste route (src/main/paste/helper-route.ts) for this tab, with
 * this check's own stand-ins for what the IPC layer gives it
 * (src/main/ipc/paste-handlers.ts helperRouteDeps): the Windows app's
 * platform; the tab as the remote helper's remoteTabPaste gives it, built
 * here from the tab's own RemoteHelperPty (its pasteStandIn, imagePasteKey
 * and putPicture), since that record is filled only by the app's PTY door;
 * and, for the session input module's door (whose pasteFromClipboard needs
 * the PTY manager's ports), the Claude package's own clipboard member called
 * directly, with the door's waits and a typing whose heldScreen is the tab's
 * screenRead, as remoteTabScreen hands it. The chain through session-input,
 * remoteTabPaste and remoteTabScreen is covered by the unit tests
 * (tests/unit/main/session-input-clipboard-helper-tab.test.ts,
 * tests/unit/remote-helper/remote-paste-tab.test.ts).
 */
function route(onClipboard: Buffer) {
  const typing: RunScreenTyping = {
    leave: '',
    wholeWrites: true,
    live: () => !exited,
    write: (data) => { typed.push(data); pty!.write(data) },
    settled: (_data, delayMs) => sleep(delayMs),
    heldScreen: () => { const read = pty!.screenRead; return read ? read() : Promise.reject(new Error('the tab reads no screen now')) },
  }
  return helperPasteRoute({
    // The route serves the Windows app in this beta (plan s4); this check stands in for it.
    platform: 'win32',
    tab: () => ({ standIn: pty!.pasteStandIn, key: pty!.imagePasteKey, put: (bytes, kind) => pty!.putPicture(bytes, kind) }),
    readPicture: async () => asPicture(onClipboard),
    readCopiedImage: async () => ({ error: 'no-image' }),
    write: async () => 'written',
    door: (sessionId, key, sentence) => CLAUDE_RUN_SCREEN.clipboard!(sessionId, key, sentence, WAITS, typing),
    log: (l) => { logs.push(l) },
  })
}

beforeAll(async () => {
  const hosts = JSON.parse(fs.readFileSync(need('REMOTE_HELPER_HOSTS'), 'utf8')) as { host?: unknown; user?: unknown; port?: unknown }
  target = { host: String(hosts.host), user: String(hosts.user), port: Number(hosts.port ?? 22) }
  if (target.host === '192.168.50.185') throw new Error('never this host (owner rule)')
  if (target.host !== '127.0.0.1' && target.host !== 'localhost') throw new Error('this check runs against this computer\'s own sshd only: the model stand-in listens on its loopback (the host lines are plan block 5.3\'s, after probe PR1)')
  claude = need('REMOTE_PASTE_CLAUDE')
  if (!path.posix.isAbsolute(claude)) throw new Error('REMOTE_PASTE_CLAUDE is the absolute path of Claude Code on the host')
  const bundled = await readBundledLinuxHelper({ manifest: need('REMOTE_HELPER_MANIFEST'), file: need('REMOTE_HELPER_BIN') })
  if (!bundled.ok) throw new Error(`the helper and its manifest do not read: ${bundled.why}`)
  helper = bundled.helper
  note('target', `${target.user}@${target.host}:${target.port}`)
  machines = new RemoteMachines({ runner, store: memoryStore(), bundled: async () => ({ ok: true, helpers: [helper] }), inUse: () => (pty && !exited ? 1 : 0), log: (l) => { logs.push(l) } })
  standIn = createModelStandIn({ onEvent: (e) => { events.push(e) } })
  port = await standIn.listen()
  const up = sshRun('umask 077; d=$(mktemp -d "$HOME/aicc-paste.XXXXXXXX") && mkdir "$d/config" "$d/project" && cd "$d/project" && echo "$d $(pwd -P)"')
  const [dir, real] = up.out.trim().split('\n').pop()?.split(' ') ?? []
  if (!/^\/[A-Za-z0-9._/-]+\/aicc-paste\.[A-Za-z0-9]+$/.test(dir ?? '')) throw new Error(`the host folder was not made: ${up.err}`)
  hostDir = dir
  // Claude Code's config folder for the tab: onboarding done, the made-up key
  // approved, the project trusted (every spelling of it), as probe P11 seeds it.
  const project = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1, allowedTools: [] }
  const config = {
    hasCompletedOnboarding: true, lastOnboardingVersion: CLAUDE_VERSION, theme: 'dark', numStartups: 1, autoUpdates: false,
    hasAcknowledgedCostThreshold: true, customApiKeyResponses: { approved: [FAKE_KEY.slice(-20)], rejected: [] },
    projects: { [`${hostDir}/project`]: project, [real ?? `${hostDir}/project`]: project },
  }
  const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: FAKE_KEY, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  const put = (file: string, text: string) => {
    const r = sshRun(`umask 077; cat > ${q(file)} && echo PUT-OK`, Buffer.from(text))
    if (!r.out.includes('PUT-OK')) throw new Error(`${file} was not written on the host: ${r.err}`)
  }
  put(`${hostDir}/config/.claude.json`, `${JSON.stringify(config, null, 2)}\n`)
  // The model stand-in named twice: in the folder's settings (Claude Code's own `env`) and in the env file the rc step reads.
  put(`${hostDir}/config/settings.json`, `${JSON.stringify({ env }, null, 2)}\n`)
  const home = sshRun('printf %s "$HOME"').out.trim()
  if (!path.posix.isAbsolute(home)) throw new Error('the host\'s home folder did not read')
  put(`${home}/${ENV_FILE}`, `${Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`).join('\n')}\n`)
  const version = sshRun(`${q(claude)} --version`)
  note('claude-version', version.out.trim())
  if (!version.out.includes(CLAUDE_VERSION)) throw new Error(`REMOTE_PASTE_CLAUDE is not Claude Code ${CLAUDE_VERSION}: ${version.out} ${version.err}`)
}, 180_000)

afterAll(async () => {
  if (pty && !exited) {
    try { pty.kill(); await Promise.race([pty.ended, sleep(15_000)]) } catch { /* the readings say what is left */ }
  }
  if (machine) {
    try { await machines.remove(machine.did) } catch { /* the readings say what is left */ }
  }
  if (/^\/[A-Za-z0-9._/-]+\/aicc-paste\.[A-Za-z0-9]+$/.test(hostDir)) sshRun(`rm -rf -- ${q(hostDir)}`)
  if (target) sshRun(`rm -f -- "$HOME/${ENV_FILE}"`)
  await standIn?.close()
  note('logs', logs)
  note('typed', typed)
  note('model-requests', events.filter((e) => e.ev === 'request').map(({ t, path: p, kind, images }) => ({ t, path: p, kind, images })))
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, 'remote-paste.json'), `${JSON.stringify({ at: new Date().toISOString(), host: os.hostname(), readings }, null, 2)}\n`)
  }
})

describe('a picture into a Claude Code tab through the session helper, by the CLI\'s own clipboard paste', () => {
  it('1. Add: the machine is checked and its helper installed', async () => {
    const prepared = await machines.prepare([{ id: 'paste', label: 'paste host', sessionType: 'ssh', sshConfig: { host: target.host, port: target.port, username: target.user } }], 'paste')
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true)
    if (!prepared.ok) return
    const added = await machines.add(prepared.token)
    expect(added.ok, added.message).toBe(true)
    ;[machine] = machines.list()
    expect(machine.os).toBe('Linux')
    note('record', { os: machine.os, arch: machine.arch, shell: machine.shell, shellIsSh: machine.shellIsSh, claudePath: machine.claudePath })
  }, 180_000)

  it('2. a Claude Code 2.1.332 tab there: the stand-in written, bin/ first on its PATH, Ctrl+V its key, and its prompt read on the holder\'s screen', async () => {
    expect(machine).toBeDefined()
    const id = 'paste-tab'
    const m: RemoteMachineRecord = { ...machine!, claudePath: claude, check: { at: Date.now(), ok: true } }
    const plan = remoteLaunchOf(claudeRemoteLaunch, m, { ssh: { host: target.host, port: target.port, username: target.user, remotePath: `${hostDir}/project` } }, null, () => true, remoteSessionId(id), 120, 40, false, false, { configDir: `${hostDir}/config` })
    folder = plan.helper.folder
    expect(plan.first.clipStandIn).toBe(true)
    // The keybindings read of the tab's own config folder (none there: Ctrl+V), when the run's folder is under the home its Check read.
    note('reads', plan.reads)
    pty = new RemoteHelperPty({ appPtyId: id, machine: m, installId: machines.installId(), runner, spec: plan.spec, plan, log: (l) => { logs.push(l) } })
    let out = ''
    pty.onData((d) => { out += d })
    pty.onExit((e) => { exited = true; note('exit', e) })
    try {
      await until('the tab to read its holder\'s screen', () => !!pty!.screenRead, 60_000)
      await until('Claude Code\'s prompt on the holder\'s screen', async () => {
        const read = pty!.screenRead
        if (!read) return false
        try { return readClaudeScreen((await read()).lines).screen === 'ready' } catch { return false }
      }, 120_000)
    } catch (err) {
      note('start-screen', await screenText())
      note('start-output-tail', out.slice(-4000))
      throw err
    }
    note('start-screen', await screenText())
    expect(pty.clipStandInReady, logs.filter((l) => l.includes('stand-in')).join('\n')).toBe(true)
    expect(pty.pasteStandIn).toBe(true)
    expect(pty.imagePasteKey).toEqual({ bytes: '\u0016', chord: 'ctrl+v', from: 'default' })
    // The CLI's own PATH has the session's bin/ first, after the login shell's rc files.
    const env = sshRun('for p in $(pgrep -x claude); do tr "\\0" "\\n" < /proc/$p/environ 2>/dev/null | grep "^PATH="; done')
    note('cli-path', env.out.trim().split('\n'))
    expect(env.out.split('\n').some((l) => l.startsWith(`PATH=${folder}/bin:`)), env.out).toBe(true)
    // The session's own xclip is the stand-in: no picture yet, so its list is empty and it exits 1.
    const empty = sshRun(`${q(`${folder}/bin/xclip`)} -selection clipboard -o -t TARGETS; echo "exit=$?"`)
    expect(empty.out.trim()).toBe('exit=1')
  }, 300_000)

  it('3. Alt+V from outside the terminal: picture A by file.put, only the key, the sentence and Enter typed, and the model gets A pixel for pixel', async () => {
    expect(pty && !exited).toBe(true)
    const ref = rgba(PICTURE_A)
    const from = events.length
    typed.length = 0
    const result = await route(PICTURE_A).paste('paste-tab', { press: { sessionId: 'paste-tab', chord: 'image', focused: false } })
    note('press-result', result)
    if (result.outcome !== 'sent') note('press-screen', await screenText())
    expect(result).toEqual({ outcome: 'sent' })
    expect(typed).toEqual(['\u0016', ` ${PASTE_SENTENCE}`, '\r'])
    // The stand-in serves the session's own xclip the picture's type.
    const listed = sshRun(`${q(`${folder}/bin/xclip`)} -selection clipboard -o -t TARGETS; echo "exit=$?"`)
    note('stand-in-targets', listed.out.trim())
    expect(listed.out.trim()).toBe('image/png\nexit=0')
    try {
      await until('the model to get picture A', () => carrying(from, ref).length > 0, 90_000)
    } catch (err) {
      note('press-screen', await screenText())
      throw err
    }
    note('press-model', carrying(from, ref).map((e) => e.images))
  }, 180_000)

  it('4. Snap: picture B the same way, with Snap\'s sentence, and the model gets B pixel for pixel', async () => {
    expect(pty && !exited).toBe(true)
    await until('Claude Code at its prompt again', async () => {
      try { const lines = (await pty!.screenRead!()).lines; return readClaudeScreen(lines).screen === 'ready' && claudePromptImages(lines) === 0 } catch { return false }
    }, 120_000).catch(async (err) => { note('snap-wait-screen', await screenText()); throw err })
    const ref = rgba(PICTURE_B)
    const from = events.length
    typed.length = 0
    const result = await route(PICTURE_B).paste('paste-tab', { snap: { picture: asPicture(PICTURE_B) as never, sentence: SNAP_RECTANGLE_SENTENCE } })
    note('snap-result', result)
    if (result.outcome !== 'sent') note('snap-screen', await screenText())
    expect(result).toEqual({ outcome: 'sent' })
    expect(typed).toEqual(['\u0016', ` ${SNAP_RECTANGLE_SENTENCE}`, '\r'])
    try {
      await until('the model to get picture B', () => carrying(from, ref).length > 0, 90_000)
    } catch (err) {
      note('snap-screen', await screenText())
      throw err
    }
    note('snap-model', carrying(from, ref).map((e) => e.images))
  }, 300_000)
})
