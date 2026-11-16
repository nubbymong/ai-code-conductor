/**
 * The session helper on This computer (2.1.3-beta.6, plan section B).
 *
 * With Settings, General, "Plain terminals through the session helper" on, a
 * Terminal only tab and a partner terminal start inside a holder of the
 * helper instead of straight under the app, so the terminal outlives an app
 * crash: at the next start the app finds every held terminal, keeps each one
 * alive at once (a holder nobody attaches to ends itself after two minutes),
 * and a restored tab with the same id shows its terminal again, scrollback
 * first. A held terminal no tab shows is listed on the Machines page, where
 * Re-attach opens a tab on it and End ends it. A normal quit ends every one.
 *
 * Off (the default), nothing here runs and every terminal starts exactly as
 * before: spawnPlainPty is then node-pty's own spawn with the same arguments.
 * Agent sessions (every provider CLI) and SSH sessions never come here.
 */
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { HeldSession, HelperState, MachineActionResult, MachineStatus, MachinesSource, SelfTestResult } from '../../shared/machines'
import { isPartnerPtyId, parentOfPartnerPtyId } from '../../shared/multi-spawn-rule'
import { randomId } from '../../shared/id'
import { HolderConnection, type ConnectionOptions } from './connection'
import { HelperPty, type HelperPtyDriver } from './helper-pty'
import {
  APP_PTY_ID_RE,
  SID_RE,
  checkLaunch,
  heldSessionId,
  helperOs,
  parseSelfTestResult,
  parseVersionLine,
  readListing,
  readRecord,
  type HelperOs,
  type HolderRecord,
  type LaunchSpec,
} from './protocol'
import { InstallError, copyMatches, installHelperCopy, removeOldVersionFolders, sha256File, type InstalledHelper } from './install'

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

type SpawnArgs = string[] | string
type SpawnOptions = pty.IPtyForkOptions | pty.IWindowsPtyForkOptions

export interface SessionHelperDeps {
  platform?: NodeJS.Platform
  /** The per-user folder (install.ts helperRootDir). */
  root: string
  /** The helper the installer put beside the app. */
  bundled: string
  exec?: (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>
  spawnDirect?: (file: string, args: SpawnArgs, opts: SpawnOptions) => IPty
  openStream?: ConnectionOptions['openStream']
  checkEndpointFolder?: ConnectionOptions['checkEndpointFolder']
  newTabId?: () => string
  log?: (message: string) => void
  now?: () => number
}

/** What the Services row shows. */
export interface SessionHelperServiceState {
  state: HelperState
  held: number
  lastError: { message: string; ts: number } | null
}

/** The Machines page's tab target for a Re-attach. */
export type ReattachTab = NonNullable<MachineActionResult['tab']>

export const HELPER_SENTENCES = {
  notInstalled: 'The session helper is not part of this installation.',
  noVersion: 'The installed session helper did not say which version it is.',
  notHeld: 'That terminal is no longer held.',
  alreadyShowing: 'That terminal is already showing in a tab.',
  noAnswer: 'The session helper did not answer.',
  selfTestOff: 'The session helper is off, so there is nothing to test.',
  selfTestUnavailable: 'The session helper cannot run its self-test now.',
} as const

const VERSION_TIMEOUT_MS = 10_000
const HOLD_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 15_000
const SELF_TEST_TIMEOUT_MS = 25_000
const ENDING_WAIT_MS = 5_000
const MARKER = 'app-running.json'
const BINDINGS = 'bindings.json'

/** The variables a helper command gets: what the system itself needs to run
 *  a program, nothing of the app's own. A launched terminal gets its full
 *  environment in the launch frame, never from here. No home folder either:
 *  every folder the helper uses is named on its command line. */
const HELPER_ENV_NAMES = ['SystemRoot', 'SYSTEMROOT', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'TMPDIR', 'LOCALAPPDATA', 'PATH', 'Path', 'LANG', 'LC_ALL', 'USER', 'LOGNAME']

function helperEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of HELPER_ENV_NAMES) {
    const v = process.env[name]
    if (typeof v === 'string' && !Object.keys(env).some((k) => k.toLowerCase() === name.toLowerCase())) env[name] = v
  }
  return env
}

function execHelper(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: helperEnv(), encoding: 'utf8' }, (err, stdout, stderr) => {
      const raw = (err as { code?: unknown } | null)?.code
      resolve({ code: err ? (typeof raw === 'number' ? raw : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

function spawnWithNodePty(file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
  return pty.spawn(file, args, opts)
}

const lastLine = (s: string): string => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? ''
const firstLine = (s: string): string => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class SessionHelperManager implements MachinesSource {
  private readonly os: HelperOs
  private readonly root: string
  private readonly store: string
  private readonly deps: Required<Pick<SessionHelperDeps, 'exec' | 'spawnDirect' | 'newTabId' | 'log' | 'now'>> & SessionHelperDeps

  private enabled = false
  private started = false
  /** A normal quit has begun: nothing new is held or kept. */
  private quitting = false
  private state: HelperState = 'off'
  private detail: string | undefined
  private version: string | undefined
  private selfTest: SelfTestResult | undefined
  private lastError: { message: string; ts: number } | null = null
  private info: InstalledHelper | null = null
  private installing: Promise<InstalledHelper | null> | null = null
  /** One copy made again at a time: every caller that found a mismatch waits for it. */
  private recopying: Promise<InstalledHelper> | null = null
  /** Held terminals a tab may take over: left by a crash, or named by Re-attach. */
  private readonly adoptable = new Map<string, HolderRecord>()
  /** Connections that keep a crash's held terminals alive until a tab takes them. */
  private readonly keepers = new Map<string, { conn?: HolderConnection; ready: Promise<void> }>()
  /** The app's terminals through the helper, by session id. */
  private readonly live = new Map<string, HelperPty>()
  private readonly endings = new Map<string, Promise<void>>()
  /** A tab Re-attach opened, by its app id, and the held terminal it shows. */
  private readonly bindings = new Map<string, string>()
  /** The tabs the app last saved, by id, with their names. */
  private readonly savedTabs = new Map<string, string>()
  private listing: HolderRecord[] = []
  private changeListener: (() => void) | null = null

  constructor(deps: SessionHelperDeps) {
    this.os = helperOs(deps.platform)
    this.root = deps.root
    this.store = path.join(deps.root, 'store')
    this.deps = {
      exec: execHelper,
      spawnDirect: spawnWithNodePty,
      newTabId: () => randomId(),
      log: () => { /* silent */ },
      now: () => Date.now(),
      ...deps,
    }
  }

  onChange(listener: (() => void) | null): void {
    this.changeListener = listener
  }

  private changed(): void {
    try { this.changeListener?.() } catch { /* the listener's own */ }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Switch on (at start-up, or when the setting is turned on). What runs
   * synchronously decides, before any tab can ask, which held terminals a
   * restored tab takes over; the copy, the listing and the self-test follow.
   */
  start(opts: { atStartup: boolean }): Promise<void> {
    this.enabled = true
    if (this.started) {
      // Switched on again. A helper that could not be set up is tried again.
      if (this.info || this.state === 'starting') {
        this.changed()
        return Promise.resolve()
      }
      this.installing = null
      this.state = 'starting'
      this.detail = undefined
      this.changed()
      return this.bringUp(false)
    }
    this.started = true
    this.state = 'starting'
    let crashed = false
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
      const marker = path.join(this.root, MARKER)
      crashed = opts.atStartup && fs.existsSync(marker)
      fs.writeFileSync(marker, JSON.stringify({ v: 1, pid: process.pid, at: this.deps.now() }))
    } catch (err) {
      this.deps.log(`[session-helper] the helper folder could not be prepared: ${message(err)}`)
    }
    if (crashed) {
      this.loadBindings()
      // Kept at once, before the copy and the listing: each record's own hello
      // proves its holder, and a slow listing cannot use up the two minutes.
      for (const r of this.readStoreRecords()) {
        this.adoptable.set(r.session, r)
        this.keep(r)
      }
      this.deps.log(`[session-helper] the app did not quit normally; ${this.adoptable.size} held terminal(s) may be shown again`)
    } else {
      this.saveBindings()
    }
    this.changed()
    return this.bringUp(crashed)
  }

  /** Switch off: new terminals start the usual way. Terminals already through
   *  the helper keep running until their tabs close. */
  stopRouting(): void {
    this.enabled = false
    this.changed()
  }

  private async bringUp(crashed: boolean): Promise<void> {
    const info = await this.installed()
    if (!info) return
    let records: HolderRecord[] = []
    let listed = false
    try {
      records = await this.list()
      listed = true
    } catch (err) {
      this.deps.log(`[session-helper] the held terminals could not be listed: ${message(err)}`)
    }
    if (crashed) {
      // Every held terminal at once: a holder nobody attaches to ends itself
      // two minutes after the app went. The keepers started from the store's
      // records stand; the listing adds any the store read missed. A record
      // whose holder is gone drops out when its keeper cannot reach it.
      for (const r of records) {
        if (this.live.has(r.session) || this.keepers.has(r.session)) continue
        this.adoptable.set(r.session, r)
        this.keep(r)
      }
      if (listed) {
        const held = new Set([...records.map((r) => r.session), ...this.adoptable.keys(), ...this.live.keys()])
        for (const [appId, sid] of [...this.bindings]) if (!held.has(sid)) this.bindings.delete(appId)
        this.saveBindings()
      }
    } else {
      // Left by a normal quit that could not end them: ended now.
      await Promise.allSettled(records.filter((r) => !this.live.has(r.session)).map((r) => this.endRecord(r)))
    }
    if (!this.info) return
    this.state = 'ready'
    this.changed()
    void this.runSelfTest().catch(() => { /* recorded in runSelfTest */ })
    const inUse = new Set(this.listing.map((r) => r.helper))
    inUse.add(info.version)
    const removed = await removeOldVersionFolders(this.root, info.folder, inUse)
    if (removed.length > 0) this.deps.log(`[session-helper] removed old helper folder(s): ${removed.join(', ')}`)
  }

  /** The helper's copy, put in place once. Null when it cannot be used. */
  private installed(): Promise<InstalledHelper | null> {
    if (!this.installing) this.installing = this.install()
    return this.installing
  }

  private async install(): Promise<InstalledHelper | null> {
    const { bundled } = this.deps
    try {
      if (!fs.statSync(bundled).isFile()) throw new Error('not a file')
    } catch {
      this.fail(HELPER_SENTENCES.notInstalled, 'not-installed')
      return null
    }
    try {
      const sha256 = await sha256File(bundled)
      const v = await this.deps.exec(bundled, ['version'], VERSION_TIMEOUT_MS)
      const version = v.code === 0 ? parseVersionLine(v.stdout) : null
      if (!version) throw new InstallError(HELPER_SENTENCES.noVersion)
      this.version = version
      this.info = await installHelperCopy({ bundled, root: this.root, version, sha256, platform: this.deps.platform })
      this.deps.log(`[session-helper] helper ${version} ready in ${this.info.folder}`)
      return this.info
    } catch (err) {
      this.fail(err instanceof InstallError ? err.message : `The session helper could not be set up: ${message(err)}`)
      return null
    }
  }

  private fail(detail: string, state: HelperState = 'failed'): void {
    this.state = state
    this.detail = detail
    this.info = null
    this.lastError = { message: detail, ts: this.deps.now() }
    this.deps.log(`[session-helper] ${detail}`)
    this.changed()
  }

  /**
   * The copy holders run from, checked against the installed helper before
   * every use. A copy that no longer matches is made again once; a second
   * mismatch, or a copy that fails, leaves the helper failed and nothing is
   * started through it.
   */
  private async checkedExe(): Promise<string> {
    const info = await this.installed()
    const now = this.info
    if (!info || !now) throw new Error(this.detail ?? HELPER_SENTENCES.notInstalled)
    if (await copyMatches(now.exe, now.sha256)) return now.exe
    if (!this.recopying) {
      this.deps.log('[session-helper] the helper copy does not match the installed helper; copying it again')
      const again = installHelperCopy({ bundled: this.deps.bundled, root: this.root, version: now.version, sha256: now.sha256, platform: this.deps.platform })
      this.recopying = again
      void again.catch(() => { /* answered below */ }).finally(() => { if (this.recopying === again) this.recopying = null })
    }
    try {
      this.info = await this.recopying
      return this.info.exe
    } catch (err) {
      if (this.info) this.fail(err instanceof InstallError ? err.message : message(err))
      throw err
    }
  }

  // ── terminals ──────────────────────────────────────────────────────────────

  /** The held session id for an app PTY id. A terminal Re-attach moved to a
   *  new tab stays with that tab: its first tab then gets a session of its own. */
  sidFor(appPtyId: string): string {
    const bound = this.bindings.get(appPtyId)
    if (bound) return bound
    const own = heldSessionId(appPtyId)
    for (const [other, sid] of this.bindings) if (sid === own && other !== appPtyId) return heldSessionId(`${appPtyId}/after/${other}`)
    return own
  }

  /**
   * A plain or partner terminal: through a holder when the setting is on and
   * the helper can carry it, else node-pty's spawn with these same arguments.
   */
  spawn(ctx: { sessionId: string; elevated?: boolean }, file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
    const direct = () => this.deps.spawnDirect(file, args, opts)
    if (!this.enabled || (this.state !== 'starting' && this.state !== 'ready')) return direct()
    // An elevated tab runs its shell under gsudo or sudo, which ask for a
    // password at their own console: left the usual way, also when only the
    // program says so.
    if (ctx.elevated || /^g?sudo(\.exe)?$/i.test(file.split(/[\\/]/).pop() ?? '')) return direct()
    if (typeof args === 'string' || !APP_PTY_ID_RE.test(ctx.sessionId)) return direct()
    const spec = this.launchSpec(file, args, opts)
    const refused = checkLaunch(spec, this.os)
    if (refused) {
      this.deps.log(`[session-helper] ${ctx.sessionId}: started the usual way, because the helper would refuse ${refused.why}`)
      return direct()
    }
    const sid = this.sidFor(ctx.sessionId)
    const adopt = this.live.has(sid) ? undefined : this.adoptable.get(sid)
    if (adopt) this.adoptable.delete(sid)
    const wrapper = new HelperPty({ sid, label: ctx.sessionId, spec, adopt, driver: this.driver(direct, !adopt) })
    this.live.set(sid, wrapper)
    void wrapper.ended.then(() => {
      if (this.live.get(sid) === wrapper) this.live.delete(sid)
      for (const [appId, bound] of [...this.bindings]) if (bound === sid && appId === ctx.sessionId) this.bindings.delete(appId)
      this.saveBindings()
      this.changed()
    })
    this.changed()
    return wrapper
  }

  private launchSpec(file: string, args: string[], opts: SpawnOptions): LaunchSpec {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.env ?? process.env)) if (typeof v === 'string') env[k] = v
    const cwd = opts.cwd ?? process.cwd()
    if (this.os === 'unix') {
      // What node-pty sets on a Unix terminal, so the shell sees the same.
      env.PWD = cwd
      env.TERM = opts.name || env.TERM || 'xterm-256color'
    }
    return { argv: [file, ...args], cwd, env, cols: opts.cols ?? 80, rows: opts.rows ?? 24 }
  }

  private driver(direct: () => IPty, checkHash: boolean): HelperPtyDriver {
    return {
      hold: (sid, label) => this.hold(sid, label),
      connect: (record) => this.connectFor(record, checkHash),
      direct,
      ending: (sid, done) => {
        this.endings.set(sid, done)
        void done.finally(() => { if (this.endings.get(sid) === done) this.endings.delete(sid) })
      },
      attachedChanged: () => this.changed(),
      log: (m) => this.deps.log(m),
    }
  }

  private async hold(sid: string, label: string): Promise<HolderRecord> {
    const previous = this.endings.get(sid)
    if (previous) await Promise.race([previous, new Promise((r) => setTimeout(r, ENDING_WAIT_MS))])
    const exe = await this.checkedExe()
    // A holder of this session nobody is taking over (a terminal this run
    // could not end): ended first, so the new one can start.
    const left = this.readStoreRecords().find((r) => r.session === sid)
    if (left) await this.endRecord(left)
    const r = await this.deps.exec(exe, ['hold', '--store', this.store, '--session', sid, '--label', label, '--detach'], HOLD_TIMEOUT_MS)
    if (r.code !== 0) throw new Error(firstLine(r.stderr) || `the helper exited with ${r.code}`)
    let record: HolderRecord | null = null
    try {
      record = readRecord(JSON.parse(lastLine(r.stdout)), this.os)
    } catch { /* below */ }
    if (!record || record.session !== sid) throw new Error('the helper answered no record for this terminal')
    return record
  }

  private async connectFor(record: HolderRecord, checkHash: boolean): Promise<HolderConnection> {
    // A keeper attaches first; the tab's attach then replaces it, never the other way.
    const keeper = this.keepers.get(record.session)
    if (keeper) await keeper.ready
    return HolderConnection.open({
      record,
      os: this.os,
      sha256: checkHash ? this.info?.sha256 : undefined,
      openStream: this.deps.openStream,
      checkEndpointFolder: this.deps.checkEndpointFolder,
    })
  }

  /** Keep a held terminal alive (attached, output dropped) until a tab takes it. */
  private keep(record: HolderRecord): void {
    const sid = record.session
    if (this.quitting || this.keepers.has(sid)) return
    const entry: { conn?: HolderConnection; ready: Promise<void> } = { ready: Promise.resolve() }
    entry.ready = (async () => {
      try {
        const conn = await HolderConnection.open({ record, os: this.os, openStream: this.deps.openStream, checkEndpointFolder: this.deps.checkEndpointFolder })
        entry.conn = conn
        conn.on('close', () => {
          if (this.keepers.get(sid) === entry) this.keepers.delete(sid)
          this.changed()
        })
        conn.on('notice', (code: string) => { if (code === 'replaced') conn.close() })
        await conn.request({ t: 'term.attach', from: 0 })
      } catch (err) {
        this.deps.log(`[session-helper] ${sid}: the held terminal could not be kept: ${message(err)}`)
        if (this.keepers.get(sid) === entry) {
          this.keepers.delete(sid)
          // Not reachable now, so not taken over: its tab starts a new terminal.
          if (this.adoptable.get(sid) === record) this.adoptable.delete(sid)
        }
        entry.conn?.close()
        this.changed()
      }
    })()
    this.keepers.set(sid, entry)
  }

  /** End a held terminal no tab of this run started. */
  private async endRecord(record: HolderRecord): Promise<void> {
    const keeper = this.keepers.get(record.session)
    let conn: HolderConnection | undefined
    try {
      if (keeper) await keeper.ready
      conn = keeper?.conn && !keeper.conn.isClosed ? keeper.conn : await HolderConnection.open({ record, os: this.os, openStream: this.deps.openStream, checkEndpointFolder: this.deps.checkEndpointFolder })
      await conn.request({ t: 'term.end' })
    } finally {
      conn?.close()
      this.keepers.delete(record.session)
      this.adoptable.delete(record.session)
    }
  }

  /** The records in the store as written, read strictly; no holder is asked. */
  private readStoreRecords(): HolderRecord[] {
    let names: string[]
    try {
      names = fs.readdirSync(this.store)
    } catch {
      return []
    }
    const out: HolderRecord[] = []
    for (const name of names) {
      const m = /^(.+)\.json$/.exec(name)
      if (!m || !SID_RE.test(m[1])) continue
      try {
        const r = readRecord(JSON.parse(fs.readFileSync(path.join(this.store, name), 'utf8')), this.os)
        if (r && r.session === m[1]) out.push(r)
      } catch { /* being written, or not a record */ }
    }
    return out
  }

  /** List mode: the live holders, oldest first (stale records are removed by the helper). */
  async list(): Promise<HolderRecord[]> {
    const exe = await this.checkedExe()
    const r = await this.deps.exec(exe, ['list', '--store', this.store], LIST_TIMEOUT_MS)
    if (r.code !== 0) throw new Error(firstLine(r.stderr) || `the helper exited with ${r.code}`)
    const listing = readListing(lastLine(r.stdout), this.os)
    if (!listing) throw new Error('the helper answered a listing that does not read')
    this.listing = listing.sessions
    return this.listing
  }

  /**
   * At a normal quit: every terminal through the helper is ended. The end
   * messages go now; the answer settles once each holder said it ended (a
   * terminal still starting, or a keeper still connecting, is ended as soon
   * as it is up). The caller bounds the wait. The running mark goes at once:
   * this was a normal quit, so the next start ends anything left instead of
   * taking it over. Null when there was nothing to end.
   */
  shutdown(): Promise<void> | null {
    this.quitting = true
    this.enabled = false
    const waits: Promise<unknown>[] = []
    for (const w of this.live.values()) {
      try { w.kill() } catch { /* already gone */ }
      waits.push(w.ended)
    }
    for (const [sid, k] of this.keepers) {
      waits.push(k.ready.then(async () => {
        const conn = k.conn
        if (!conn || conn.isClosed) return
        try { await conn.request({ t: 'term.end' }) } finally { conn.close() }
      }))
      this.keepers.delete(sid)
    }
    this.adoptable.clear()
    try { fs.rmSync(path.join(this.root, MARKER), { force: true }) } catch { /* the next start ends what is left */ }
    return waits.length === 0 ? null : Promise.allSettled(waits).then(() => undefined)
  }

  /** The app saved its tabs: which ones are open, and what they are called. */
  noteSavedTabs(tabs: ReadonlyArray<{ id: string; label?: string; customName?: string }>): void {
    this.savedTabs.clear()
    for (const t of tabs) if (typeof t.id === 'string') this.savedTabs.set(t.id, t.customName || t.label || '')
  }

  serviceState(): SessionHelperServiceState {
    const held = new Set<string>([...this.adoptable.keys(), ...this.keepers.keys()])
    for (const [sid, w] of this.live) if (w.throughHelper) held.add(sid)
    return { state: this.enabled ? this.state : 'off', held: held.size, lastError: this.lastError }
  }

  // ── the Machines page ──────────────────────────────────────────────────────

  private appIdOf(r: HolderRecord): string {
    for (const [appId, sid] of this.bindings) if (sid === r.session) return appId
    return r.label
  }

  private toHeld(r: HolderRecord): HeldSession {
    const appId = this.appIdOf(r)
    const partner = isPartnerPtyId(r.label)
    const base = parentOfPartnerPtyId(appId) ?? appId
    const name = this.savedTabs.get(base) || this.savedTabs.get(parentOfPartnerPtyId(r.label) ?? r.label) || ''
    const label = partner ? (name ? `${name}, partner terminal` : 'Partner terminal') : (name || 'Terminal')
    const w = this.live.get(r.session)
    return {
      id: r.session,
      kind: partner ? 'partner' : 'plain',
      label,
      startedAt: r.started,
      attached: !!w && w.isAttached,
      tabOpen: !!w || this.savedTabs.has(base),
    }
  }

  async status(): Promise<MachineStatus> {
    const base = { id: 'this-computer' as const, name: 'This computer' }
    if (!this.enabled) return { ...base, helper: { state: 'off' }, sessions: [] }
    let sessions: HeldSession[] = []
    if (this.info) {
      try {
        sessions = (await this.list()).map((r) => this.toHeld(r))
      } catch (err) {
        this.deps.log(`[session-helper] list failed: ${message(err)}`)
      }
    }
    return {
      ...base,
      helper: {
        state: this.state,
        ...(this.version ? { version: this.version } : {}),
        ...(this.selfTest ? { selfTest: this.selfTest } : {}),
        ...(this.detail ? { detail: this.detail } : {}),
      },
      sessions,
    }
  }

  async runSelfTest(): Promise<SelfTestResult> {
    if (!this.enabled) return { ok: false, at: this.deps.now(), detail: HELPER_SENTENCES.selfTestOff }
    let exe: string
    try {
      exe = await this.checkedExe()
    } catch {
      return { ok: false, at: this.deps.now(), detail: this.detail ?? HELPER_SENTENCES.selfTestUnavailable }
    }
    const nonce = randomBytes(16).toString('hex')
    const r = await this.deps.exec(exe, ['selftest', '--nonce', nonce], SELF_TEST_TIMEOUT_MS)
    const report = parseSelfTestResult(r.stdout, nonce)
    let result: SelfTestResult
    if (!report) {
      result = { ok: false, at: this.deps.now(), detail: 'The self-test gave no answer the app could read.' }
    } else if (report.ok && report.checks.every((c) => c.ok)) {
      result = { ok: true, at: this.deps.now(), detail: `All ${report.checks.length} checks passed.` }
    } else {
      const failed = report.checks.filter((c) => !c.ok).map((c) => (c.detail ? `${c.name} (${c.detail})` : c.name))
      result = { ok: false, at: this.deps.now(), detail: `These checks failed: ${failed.join(', ') || 'unknown'}.` }
    }
    this.selfTest = result
    // A helper that fails its own test carries no terminal until a test passes.
    if (this.info) {
      this.state = result.ok ? 'ready' : 'failed'
      this.detail = result.ok ? undefined : result.detail
    }
    this.deps.log(`[session-helper] self-test: ${result.ok ? 'passed' : 'failed'}: ${result.detail}`)
    if (!result.ok) this.lastError = { message: result.detail ?? 'The self-test failed.', ts: result.at }
    this.changed()
    return result
  }

  async endSession(id: string): Promise<MachineActionResult> {
    if (!this.enabled) return { ok: false, message: 'The session helper is off, so it holds no terminal to end.' }
    const w = this.live.get(id)
    if (w && w.throughHelper) {
      w.kill()
      await Promise.race([w.ended, new Promise((r) => setTimeout(r, ENDING_WAIT_MS))])
      return { ok: true }
    }
    let record = this.listing.find((r) => r.session === id) ?? this.adoptable.get(id)
    if (!record) {
      try { record = (await this.list()).find((r) => r.session === id) } catch { /* below */ }
    }
    if (!record) return { ok: false, message: HELPER_SENTENCES.notHeld }
    try {
      await this.endRecord(record)
    } catch (err) {
      this.deps.log(`[session-helper] ${id}: end failed: ${message(err)}`)
      return { ok: false, message: HELPER_SENTENCES.noAnswer }
    }
    for (const [appId, sid] of [...this.bindings]) if (sid === id) this.bindings.delete(appId)
    this.saveBindings()
    this.changed()
    return { ok: true }
  }

  async reattach(id: string): Promise<MachineActionResult> {
    if (!this.enabled) return { ok: false, message: 'The session helper is off, so it holds no terminal to re-attach.' }
    let record: HolderRecord | undefined
    try {
      record = (await this.list()).find((r) => r.session === id)
    } catch { /* below */ }
    if (!record) return { ok: false, message: HELPER_SENTENCES.notHeld }
    const held = this.toHeld(record)
    if (held.attached) return { ok: false, message: HELPER_SENTENCES.alreadyShowing }
    const appId = this.appIdOf(record)
    const partner = isPartnerPtyId(appId)
    const base = parentOfPartnerPtyId(appId) ?? appId
    if (held.tabOpen) {
      // Its tab is open: brought forward, and showing it attaches it.
      return { ok: true, tab: { id: base, label: held.label, open: false, partner } }
    }
    // No tab shows it: a new Terminal only tab, bound to it.
    const tabId = this.deps.newTabId()
    this.bindings.set(tabId, id)
    this.adoptable.set(id, record)
    this.saveBindings()
    const tab: ReattachTab = { id: tabId, label: held.label, open: true, partner: false }
    return { ok: true, tab }
  }

  // ── bindings ───────────────────────────────────────────────────────────────

  private loadBindings(): void {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.root, BINDINGS), 'utf8')) as { v?: unknown; bindings?: unknown }
      if (v.v !== 1 || !v.bindings || typeof v.bindings !== 'object') return
      for (const [appId, sid] of Object.entries(v.bindings as Record<string, unknown>)) {
        if (APP_PTY_ID_RE.test(appId) && typeof sid === 'string' && SID_RE.test(sid)) this.bindings.set(appId, sid)
      }
    } catch { /* none yet */ }
  }

  private saveBindings(): void {
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(this.root, BINDINGS), JSON.stringify({ v: 1, bindings: Object.fromEntries(this.bindings) }))
    } catch { /* kept in memory for this run */ }
  }
}

// ── the one manager of this run ─────────────────────────────────────────────

let current: SessionHelperManager | null = null

export function setSessionHelper(manager: SessionHelperManager | null): void {
  current = manager
}

export function getSessionHelper(): SessionHelperManager | null {
  return current
}

/**
 * The PTY manager's spawn for a plain or partner terminal. With the setting
 * off (or no helper this run), exactly node-pty's spawn with these arguments.
 */
export function spawnPlainPty(ctx: { sessionId: string; elevated?: boolean }, file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
  const m = current
  if (!m || !m.isEnabled()) return pty.spawn(file, args, opts)
  return m.spawn(ctx, file, args, opts)
}

/**
 * Calls `then` with whether this PTY shows a held terminal, once that is known:
 * true when a take-over attached (nothing is typed into it at launch), false for
 * any other terminal and for a take-over that failed and started a new shell the
 * usual way. Synchronously when it is known already (every terminal not through
 * the helper), so the usual launch keeps its timing.
 */
export function whenHeldKnown(p: unknown, then: (held: boolean) => void): void {
  if (!(p instanceof HelperPty)) { then(false); return }
  if (p.adoptionKnown !== undefined) { then(p.adoptionKnown); return }
  void p.adoption.then(then)
}
