/**
 * The Linux machines added on the Machines page (2.1.3-beta.17, plan section
 * A2; ADR-030 S24 and S25, plan v3's R3 in part and R6's provisioning half).
 *
 * Add, on a saved SSH config with key sign-in, in this order, each step only
 * once the one before it passed:
 *   1. prepare: nothing reaches the machine. The app checks its own Linux
 *      helper against the installer's manifest and hands the renderer the
 *      question to ask (file, size, SHA-256, where it goes) with a one-time
 *      token. No token, no upload: Add takes only a token prepare made, once,
 *      within ten minutes.
 *   2. probe: what the host is (Linux x86-64 only), its home and login shell,
 *      and where `claude` is, through one `-il` lookup (P6's fallback).
 *   3. install: the file goes on standard input into a new temporary folder,
 *      is set 0700 and hashed there; the app compares that hash with the
 *      manifest's. Equal: commit moves it into its folder. Not equal (or no
 *      hash tool on the host): discard removes it, and the device folder this
 *      Add made is removed too, so a failed Add leaves nothing.
 *   4. `version` and `selftest --nonce`, through the launcher, which hashes
 *      the file again before each start.
 *   5. the record: OS, architecture, home, login shell, the CLI's path and
 *      the PATH from the `-il` lookup, the helper's version, hash and folder,
 *      and the check. A failed self-test leaves the machine added but not
 *      checked: no tab goes through the helper there until a Check passes.
 *
 * Check runs the probe, version and self-test again (and installs this
 * build's helper first when the machine has another). Remove is refused while
 * a tab runs through the helper there or the helper lists a session; then one
 * fixed script deletes `~/.aicc/<did>` after reading its owner marker
 * (scripts.ts).
 *
 * The records live in one JSON file in this install's own data folder (not
 * the shared resources folder), with this install's id; a dev or test run
 * keeps its own.
 *
 * This file imports nothing of Electron.
 */
import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { parseSelfTestResult, parseVersionLine, readListing } from '../session-helper/protocol'
import { DID_RE, INSTALL_ID_RE } from './scripts'
import {
  afterHashLine, newNonce, readHashLine, readScriptResult, runScript, sshFailure, targetProblem,
  type ExecResult, type SshRunner, type SshTarget,
} from './ssh-exec'
import type { BundledLinuxHelper } from './manifest'
import type { RemoteActionResult, RemoteAddCandidate, RemoteConsent, RemoteMachineView } from '../../shared/remote-machines'
import { REMOTE_TOKEN_RE } from '../../shared/remote-machines'

/** What the app keeps of one added machine. */
export interface RemoteMachineRecord {
  did: string
  host: string
  port: number
  user: string
  label: string
  addedAt: number
  os: string
  arch: string
  home: string
  shell: string
  /** The login shell is of the sh family: the CLI starts through it (`-il`). */
  shellIsSh: boolean
  /** Where `claude` is: from the `-il` lookup, else the exec's PATH; null: not found. */
  claudePath: string | null
  /** The PATH a session's CLI starts with: the `-il` lookup's, else the exec's. */
  path: string
  lang: string | null
  helper: { version: string; sha256: string; folder: string }
  check: { at: number; ok: boolean; detail?: string }
}

interface RecordsFile {
  v: 1
  installId: string
  machines: RemoteMachineRecord[]
}

/** Where the records are kept. Tests hand one in memory. */
export interface MachineStore {
  read(): unknown
  write(value: RecordsFile): void
}

/** The records file: written whole (a temporary file, then a rename), owner-only. */
export function fileStore(file: string): MachineStore {
  return {
    read: () => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        return null
      }
    },
    write: (value) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(tmp, file)
    },
  }
}

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
/** Host text: at most `max` characters, no control or format character. */
function hostText(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL.test(v) ? v : null
}
/** A host path: absolute, at most `max` bytes, no control or format character. */
function hostPath(v: unknown, max = 1024): string | null {
  const s = hostText(v, max)
  return s && s.startsWith('/') && Buffer.byteLength(s, 'utf8') <= max ? s : null
}
const LANG_RE = /^[A-Za-z0-9_.@-]{1,64}$/

/** One record, read strictly; null when any field is off. */
function readRecord(v: unknown): RemoteMachineRecord | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const helper = r.helper as Record<string, unknown> | undefined
  const check = r.check as Record<string, unknown> | undefined
  if (typeof r.did !== 'string' || !DID_RE.test(r.did)) return null
  if (targetProblem({ host: r.host, port: r.port, user: r.user })) return null
  if (!helper || typeof helper.version !== 'string' || typeof helper.sha256 !== 'string' || typeof helper.folder !== 'string') return null
  if (!/^[0-9a-f]{64}$/.test(helper.sha256) || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?-[0-9a-f]{12}$/.test(helper.folder)) return null
  if (!check || typeof check.at !== 'number' || typeof check.ok !== 'boolean') return null
  const home = hostPath(r.home)
  const shell = hostPath(r.shell, 4096)
  const p = hostText(r.path, 32767)
  if (!home || !shell || !p) return null
  return {
    did: r.did, host: r.host as string, port: r.port as number, user: r.user as string,
    label: hostText(r.label, 200) ?? `${r.user}@${r.host}`,
    addedAt: typeof r.addedAt === 'number' ? r.addedAt : 0,
    os: hostText(r.os, 64) ?? 'Linux', arch: hostText(r.arch, 64) ?? 'x86_64',
    home, shell, shellIsSh: r.shellIsSh === true,
    claudePath: r.claudePath === null ? null : hostPath(r.claudePath, 4096),
    path: p, lang: typeof r.lang === 'string' && LANG_RE.test(r.lang) ? r.lang : null,
    helper: { version: helper.version, sha256: helper.sha256, folder: helper.folder },
    check: { at: check.at, ok: check.ok, ...(typeof check.detail === 'string' ? { detail: check.detail.slice(0, 300) } : {}) },
  }
}

/** A saved session config, as much of it as Add reads. */
export interface SavedConfigLike {
  id?: unknown
  label?: unknown
  sessionType?: unknown
  sshConfig?: {
    host?: unknown
    port?: unknown
    username?: unknown
    hasPassword?: unknown
    remoteOs?: unknown
  }
}

/** Plain sentences of the flow. */
export const MACHINE_TEXT = {
  noConsent: 'Nothing was sent: the question was not answered, or it was asked more than ten minutes ago. Press Add again.',
  notFound: 'That machine is not on this computer\'s list.',
  notLinux: (os: string, arch: string) => `It is ${os} on ${arch}. This preview adds Linux x86-64 machines only.`,
  noHashTool: 'The machine has no sha256sum, shasum or openssl, so the helper file cannot be checked there. Nothing was left on it.',
  hashMismatch: (hex: string) => `The file on the machine did not match the installer's (SHA-256 ${hex.slice(0, 12)}), so it was removed and nothing was left on it.`,
  inUse: (n: number) => `${n === 1 ? 'A tab runs' : `${n} tabs run`} through the session helper on this machine. Close ${n === 1 ? 'it' : 'them'} first.`,
  holds: (n: number) => `The session helper on this machine still holds ${n === 1 ? 'a session' : `${n} sessions`}. End ${n === 1 ? 'it' : 'them'} first (close the tab, or wait two minutes after a lost connection).`,
}

/** The refusal words a script prints, as sentences. */
const REFUSED: Record<string, string> = {
  'home-not-absolute': 'its home folder is not an absolute path',
  'home-is-root': 'its home folder is /',
  'home-not-a-folder': 'its home folder is not a real folder',
  'home-not-yours': 'its home folder belongs to another user',
  'home-open-to-others': 'its home folder, or a folder above it, can be written by other users',
  'home-folder-owner': 'a folder above its home belongs to another user',
  'aicc-folder-not-private': '~/.aicc there is not a private folder of yours',
  'device-folder-not-private': 'the helper\'s folder there is not a private folder of yours',
  'not-this-install': 'the helper\'s folder there belongs to another install of the app',
  'cannot-make-aicc-folder': '~/.aicc could not be made there',
  'cannot-make-device-folder': 'the helper\'s folder could not be made there',
  'cannot-write-owner': 'the helper\'s folder could not be marked as this install\'s',
  'cannot-make-helper-folder': 'the helper\'s folder could not be made there',
  'helper-folder-not-private': 'the helper\'s folder there is not private',
  busy: 'another upload to it is under way',
  'short-upload': 'the upload did not arrive whole',
  'cannot-set-mode': 'the helper file\'s mode could not be set',
  'nothing-staged': 'the uploaded file was not there to put in place',
  'cannot-replace': 'an older copy could not be replaced',
  'cannot-place': 'the file could not be put in place',
  'cannot-remove': 'its folder could not be removed',
  'still-there': 'its folder is still there',
}

function refusalText(word: string | null): string {
  return (word && REFUSED[word]) || `it refused (${word ?? 'no reason given'})`
}

export interface MachinesDeps {
  runner: SshRunner
  store: MachineStore
  /** This build's Linux helper, checked against its manifest. */
  bundled: () => Promise<{ ok: true; helper: BundledLinuxHelper } | { ok: false; why: string }>
  /** The helper file's bytes, for the upload. */
  readFile?: (file: string) => Promise<Buffer>
  /** How many open tabs go through the helper on this machine. */
  inUse: (did: string) => number
  log: (message: string) => void
  now?: () => number
  random?: () => string
}

/** A prepared Add: what the user was asked about, until its token is used. */
interface Pending {
  target: SshTarget
  label: string
  sha256: string
  expires: number
}

export const CONSENT_TTL_MS = 10 * 60_000

export class RemoteMachines {
  private readonly pending = new Map<string, Pending>()
  private busy = new Set<string>()

  constructor(private readonly deps: MachinesDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private rand(): string { return this.deps.random?.() ?? randomBytes(16).toString('hex') }

  private load(): RecordsFile {
    const raw = this.deps.store.read() as Partial<RecordsFile> | null
    const installId = raw && typeof raw.installId === 'string' && INSTALL_ID_RE.test(raw.installId) ? raw.installId : null
    const machines = raw && Array.isArray(raw.machines) ? raw.machines.map(readRecord).filter((m): m is RemoteMachineRecord => m !== null) : []
    if (installId) return { v: 1, installId, machines }
    const made: RecordsFile = { v: 1, installId: this.rand(), machines }
    this.deps.store.write(made)
    return made
  }

  private save(f: RecordsFile): void { this.deps.store.write(f) }

  /** This install's id (section 1's marker holds it), made once. */
  installId(): string { return this.load().installId }

  list(): RemoteMachineRecord[] { return this.load().machines }

  get(did: string): RemoteMachineRecord | undefined { return this.list().find((m) => m.did === did) }

  /** The machine added for this host, port and user. */
  findByTarget(t: { host: string; port: number; username: string }): RemoteMachineRecord | undefined {
    return this.list().find((m) => m.host === t.host && m.port === t.port && m.user === t.username)
  }

  views(): RemoteMachineView[] {
    return this.list().map((m) => ({
      did: m.did, label: m.label, target: `${m.user}@${m.host}:${m.port}`, checked: m.check.ok, lastCheck: m.check,
      helperVersion: m.helper.version, system: `${m.os} ${m.arch}`, inUse: this.deps.inUse(m.did),
    }))
  }

  /** The saved SSH configs Add offers, each with whether it can be added. */
  candidates(configs: unknown): RemoteAddCandidate[] {
    if (!Array.isArray(configs)) return []
    const added = this.list()
    const out: RemoteAddCandidate[] = []
    for (const c of configs as SavedConfigLike[]) {
      if (!c || c.sessionType !== 'ssh' || !c.sshConfig || typeof c.id !== 'string') continue
      const s = c.sshConfig
      const target = { host: s.host, port: s.port, user: s.username }
      const label = typeof c.label === 'string' && c.label ? c.label.slice(0, 200) : `${String(s.username)}@${String(s.host)}`
      const shown = `${String(s.username)}@${String(s.host)}:${String(s.port)}`
      const problem = targetProblem(target)
      const why = problem ? `It cannot be added: ${problem}.`
        : s.hasPassword === true ? 'It signs in with a password. The session helper uses key sign-in only in this preview.'
          : s.remoteOs === 'windows' ? 'Its remote OS is set to Windows. This preview adds Linux machines only.'
            : added.some((m) => m.host === s.host && m.port === s.port && m.user === s.username) ? 'Added already.'
              : undefined
      out.push({ configId: c.id, label, target: shown, addable: !why, ...(why ? { why } : {}) })
    }
    return out
  }

  /** Step 1: the question, with a one-time token. Nothing reaches the machine. */
  async prepare(configs: unknown, configId: string): Promise<RemoteConsent> {
    const cand = this.candidates(configs).find((c) => c.configId === configId)
    if (!cand) return { ok: false, message: 'That saved config is not an SSH config this computer has.' }
    if (!cand.addable) return { ok: false, message: cand.why ?? 'It cannot be added.' }
    const b = await this.deps.bundled()
    if (!b.ok) return { ok: false, message: b.why }
    const s = (configs as SavedConfigLike[]).find((c) => c && c.id === configId)!.sshConfig!
    const target: SshTarget = { host: s.host as string, port: s.port as number, user: s.username as string }
    for (const [k, p] of this.pending) if (p.expires <= this.now()) this.pending.delete(k)
    const token = this.rand()
    this.pending.set(token, { target, label: cand.label, sha256: b.helper.sha256, expires: this.now() + CONSENT_TTL_MS })
    const mb = (b.helper.size / (1024 * 1024)).toFixed(1)
    return {
      ok: true, token, target: cand.target,
      text: `Install the session helper on ${target.host}? One file, ${mb} MB, SHA-256 ${b.helper.sha256.slice(0, 12)}, into ~/.aicc in your account there. No root, no service: nothing runs when no session uses it. Remove takes it away.`,
    }
  }

  /** Steps 2 to 5, on the token prepare made (the user's yes). */
  async add(token: unknown): Promise<RemoteActionResult> {
    const p = typeof token === 'string' && REMOTE_TOKEN_RE.test(token) ? this.pending.get(token) : undefined
    if (typeof token === 'string') this.pending.delete(token)
    if (!p || p.expires <= this.now()) return { ok: false, message: MACHINE_TEXT.noConsent }
    const key = `${p.target.user}@${p.target.host}:${p.target.port}`
    if (this.busy.has(key)) return { ok: false, message: 'That machine is being added already.' }
    if (this.findByTarget({ host: p.target.host, port: p.target.port, username: p.target.user })) return { ok: false, message: 'That machine is added already. Use Check.' }
    this.busy.add(key)
    try {
      const b = await this.deps.bundled()
      if (!b.ok) return { ok: false, message: b.why }
      if (b.helper.sha256 !== p.sha256) return { ok: false, message: 'The app\'s Linux helper changed after the question was asked. Press Add again.' }
      const did = this.rand()
      const made = await this.provision({ did, target: p.target, label: p.label, helper: b.helper, first: true, addedAt: this.now() })
      if (!made.ok) return made
      const f = this.load()
      f.machines = [...f.machines.filter((m) => m.did !== did), made.record]
      this.save(f)
      this.deps.log(`[remote-helper] added ${key} (${did.slice(0, 8)}): ${made.record.check.ok ? 'checked' : `not checked: ${made.record.check.detail ?? ''}`}`)
      return { ok: true, message: made.record.check.ok ? `Added ${p.target.host}. Its self-test passed.` : `Added ${p.target.host}, but it is not checked: ${made.record.check.detail}. Press Check to try again, or Remove.` }
    } finally {
      this.busy.delete(key)
    }
  }

  /** Check: probe, version and self-test again (and this build's helper first, when the machine has another). */
  async check(did: unknown): Promise<RemoteActionResult> {
    const m = typeof did === 'string' && DID_RE.test(did) ? this.get(did) : undefined
    if (!m) return { ok: false, message: MACHINE_TEXT.notFound }
    const key = `${m.user}@${m.host}:${m.port}`
    if (this.busy.has(key)) return { ok: false, message: 'That machine is busy with another action.' }
    this.busy.add(key)
    try {
      const b = await this.deps.bundled()
      if (!b.ok) return { ok: false, message: b.why }
      const made = await this.provision({ did: m.did, target: { host: m.host, port: m.port, user: m.user }, label: m.label, helper: b.helper, first: false, addedAt: m.addedAt, known: m })
      const f = this.load()
      const record = made.ok ? made.record : { ...m, check: { at: this.now(), ok: false, detail: made.message } }
      f.machines = f.machines.map((x) => (x.did === m.did ? record : x))
      this.save(f)
      this.deps.log(`[remote-helper] checked ${key} (${m.did.slice(0, 8)}): ${record.check.ok ? 'passed' : `failed: ${record.check.detail ?? ''}`}`)
      return record.check.ok ? { ok: true, message: `${m.host} passed its check.` } : { ok: false, message: `${m.host} did not pass its check: ${record.check.detail}` }
    } finally {
      this.busy.delete(key)
    }
  }

  /** Remove: refused while a tab or a held session runs there; then the one fixed removal script. */
  async remove(did: unknown): Promise<RemoteActionResult> {
    const m = typeof did === 'string' && DID_RE.test(did) ? this.get(did) : undefined
    if (!m) return { ok: false, message: MACHINE_TEXT.notFound }
    const n = this.deps.inUse(m.did)
    if (n > 0) return { ok: false, message: MACHINE_TEXT.inUse(n) }
    const target = { host: m.host, port: m.port, user: m.user }
    const install = this.installId()
    // The holders first: a session still held there keeps the folder.
    const nonce = newNonce()
    const listed = await runScript(this.deps.runner, target, 'list', [nonce, m.did, install, m.helper.folder, m.helper.sha256])
    const failed = sshFailure(listed)
    if (failed) return { ok: false, message: `${m.host} could not be reached: ${failed}.` }
    const hash = readHashLine(listed.stdout, nonce)
    if (hash?.state === 'ok') {
      const line = afterHashLine(listed.stdout, nonce).split(/\r?\n/).find((l) => l.startsWith('{'))
      const listing = line ? readListing(line, 'unix') : null
      if (!listing) return { ok: false, message: `The session helper on ${m.host} did not list its sessions, so nothing was removed.` }
      if (listing.sessions.length > 0) return { ok: false, message: MACHINE_TEXT.holds(listing.sessions.length) }
    }
    const removed = await this.runRemove(target, m.did, install)
    if (!removed.ok) return removed
    const f = this.load()
    f.machines = f.machines.filter((x) => x.did !== m.did)
    this.save(f)
    this.deps.log(`[remote-helper] removed ${m.user}@${m.host}:${m.port} (${m.did.slice(0, 8)})`)
    return { ok: true, message: `Removed the session helper from ${m.host}.` }
  }

  private async runRemove(target: SshTarget, did: string, install: string): Promise<RemoteActionResult> {
    const nonce = newNonce()
    const r = await runScript(this.deps.runner, target, 'remove', [nonce, did, install])
    const failed = sshFailure(r)
    if (failed) return { ok: false, message: `${target.host} could not be reached: ${failed}.` }
    const res = readScriptResult(r.stdout, nonce)
    if (!res) return { ok: false, message: `${target.host} did not say whether the helper's folder was removed.` }
    if (!res.ok) return { ok: false, message: `Nothing was removed: ${refusalText(res.refused)}.` }
    return { ok: true, message: 'removed' }
  }

  /**
   * Probe, install when the machine lacks this helper, version and self-test.
   * `first`: the machine's first connection (a host key not known yet is
   * kept); a failure then removes what this Add made.
   */
  private async provision(a: { did: string; target: SshTarget; label: string; helper: BundledLinuxHelper; first: boolean; addedAt: number; known?: RemoteMachineRecord }): Promise<{ ok: true; record: RemoteMachineRecord } | { ok: false; message: string }> {
    const { did, target, helper } = a
    const install = this.installId()
    const fail = async (message: string, cleanUp: boolean): Promise<{ ok: false; message: string }> => {
      if (cleanUp) {
        const gone = await this.runRemove(target, did, install).catch(() => ({ ok: false, message: '' }))
        if (!gone.ok) this.deps.log(`[remote-helper] ${target.host}: what the failed Add made could not be removed (${gone.message})`)
      }
      return { ok: false, message }
    }
    // 2. probe
    let nonce = newNonce()
    const probed = await runScript(this.deps.runner, target, 'probe', [nonce, did, install], { firstConnection: a.first })
    const pf = sshFailure(probed)
    if (pf) return { ok: false, message: `${target.host} could not be reached: ${pf}.` }
    const probe = readScriptResult(probed.stdout, nonce)
    if (!probe) return { ok: false, message: `${target.host} did not answer the session helper's questions (is /bin/sh there?).` }
    if (!probe.ok) return { ok: false, message: `${target.host} was not used: ${refusalText(probe.refused)}.` }
    const os = hostText(probe.values.get('os'), 64) ?? 'unknown'
    const arch = hostText(probe.values.get('arch'), 64) ?? 'unknown'
    if (os !== 'Linux' || arch !== 'x86_64') return { ok: false, message: MACHINE_TEXT.notLinux(os, arch) }
    const home = hostPath(probe.values.get('home'))
    const shell = hostPath(probe.values.get('shell'), 4096)
    if (!home || !shell) return { ok: false, message: `${target.host} gave a home folder or login shell the session helper does not take.` }
    if (a.known && a.known.home !== home) return { ok: false, message: `Its home folder is not the one it had when it was added (${a.known.home}). Remove it and add it again.` }
    const shellIsSh = /\/(bash|zsh|sh|dash|ksh|mksh|ash|yash)$/.test(shell)
    const ilPath = hostText(probe.values.get('il-path'), 32767)
    const execPath = hostText(probe.values.get('path'), 32767) ?? '/usr/local/bin:/usr/bin:/bin'
    const claudePath = hostPath(probe.values.get('il-claude'), 4096) ?? hostPath(probe.values.get('claude'), 4096)
    const lang = probe.values.get('lang')
    // 3. install, unless the machine has this helper already in place
    const inPlace = a.known && a.known.helper.sha256 === helper.sha256 && a.known.check.ok
    if (!inPlace) {
      nonce = newNonce()
      const bytes = await (this.deps.readFile ?? fs.promises.readFile)(helper.file)
      if (bytes.length !== helper.size) return { ok: false, message: 'The app\'s Linux helper changed while it was being read. Try again.' }
      const up = await runScript(this.deps.runner, target, 'install', [nonce, did, install, String(helper.size)], { stdin: bytes, timeoutMs: 180_000 })
      const uf = sshFailure(up)
      if (uf) return fail(`${target.host} could not be reached: ${uf}.`, a.first)
      const res = readScriptResult(up.stdout, nonce)
      if (!res) return fail(`${target.host} did not say whether the upload arrived.`, a.first)
      if (!res.ok) return fail(`Nothing was installed: ${refusalText(res.refused)}.`, a.first)
      const staged = nonce
      const reported = res.values.get('hash') ?? 'none'
      // The host's hash against the installer's manifest: never against host data.
      if (reported !== helper.sha256) {
        await this.discard(target, did, install, staged)
        this.deps.log(`[remote-helper] ${target.host}: the uploaded file's hash was ${reported === 'none' ? 'not read (no hash tool)' : reported.slice(0, 12)}, not the manifest's ${helper.sha256.slice(0, 12)}; removed`)
        return fail(reported === 'none' ? MACHINE_TEXT.noHashTool : MACHINE_TEXT.hashMismatch(reported), a.first)
      }
      nonce = newNonce()
      const put = await runScript(this.deps.runner, target, 'commit', [nonce, did, install, helper.folder, staged])
      const cf = sshFailure(put)
      if (cf) return fail(`${target.host} could not be reached: ${cf}.`, a.first)
      const cr = readScriptResult(put.stdout, nonce)
      if (!cr?.ok) return fail(`The file could not be put in place: ${refusalText(cr?.refused ?? null)}.`, a.first)
    }
    // 4. version and self-test, through the launcher
    const checked = await this.selfCheck(target, did, install, helper)
    const record: RemoteMachineRecord = {
      did, host: target.host, port: target.port, user: target.user, label: a.label, addedAt: a.addedAt,
      os, arch, home, shell, shellIsSh, claudePath,
      path: shellIsSh && ilPath ? ilPath : execPath,
      lang: typeof lang === 'string' && LANG_RE.test(lang) ? lang : null,
      helper: { version: helper.version, sha256: helper.sha256, folder: helper.folder },
      check: { at: this.now(), ok: checked.ok, ...(checked.ok ? {} : { detail: checked.why }) },
    }
    if (checked.ok && !claudePath) record.check = { at: record.check.at, ok: false, detail: 'Claude Code was not found on it (not on the PATH of its login shell)' }
    return { ok: true, record }
  }

  private async discard(target: SshTarget, did: string, install: string, staged: string): Promise<void> {
    const nonce = newNonce()
    const r = await runScript(this.deps.runner, target, 'discard', [nonce, did, install, staged]).catch((): ExecResult => ({ code: null, stdout: '', stderr: '', timedOut: false }))
    const res = readScriptResult(r.stdout, nonce)
    if (!res?.ok) this.deps.log(`[remote-helper] ${target.host}: the upload that did not match could not be removed (${refusalText(res?.refused ?? null)})`)
  }

  /** `version` then `selftest`, both through the launcher's hash check. */
  private async selfCheck(target: SshTarget, did: string, install: string, helper: BundledLinuxHelper): Promise<{ ok: true } | { ok: false; why: string }> {
    let nonce = newNonce()
    const v = await runScript(this.deps.runner, target, 'version', [nonce, did, install, helper.folder, helper.sha256])
    const vf = sshFailure(v)
    if (vf) return { ok: false, why: `it could not be reached (${vf})` }
    const vh = readHashLine(v.stdout, nonce)
    if (vh?.state !== 'ok') return { ok: false, why: `the helper file there did not pass its hash check (${vh?.state ?? 'no answer'})` }
    const version = parseVersionLine(afterHashLine(v.stdout, nonce).split(/\r?\n/)[0] ?? '')
    if (version !== helper.version) return { ok: false, why: `the helper there reports version ${version ?? 'nothing'}, not ${helper.version}` }
    nonce = newNonce()
    const s = await runScript(this.deps.runner, target, 'selftest', [nonce, did, install, helper.folder, helper.sha256])
    const sf = sshFailure(s)
    if (sf) return { ok: false, why: `it could not be reached (${sf})` }
    if (readHashLine(s.stdout, nonce)?.state !== 'ok') return { ok: false, why: 'the helper file there did not pass its hash check' }
    const report = parseSelfTestResult(afterHashLine(s.stdout, nonce), nonce)
    if (!report) return { ok: false, why: 'its self-test gave no result' }
    if (!report.ok) {
      const bad = report.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')
      return { ok: false, why: `its self-test failed (${bad || 'no check named'})` }
    }
    return { ok: true }
  }
}
