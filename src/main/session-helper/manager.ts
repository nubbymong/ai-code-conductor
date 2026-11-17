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
 * Only a terminal the renderer marks plain (a Terminal only tab, a partner
 * terminal) comes here: agent sessions (every provider CLI), SSH sessions and
 * the app's own shell tabs (a sign-in, an install or update command, the
 * first-run install terminal) never do.
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

/** What the PTY manager says of a terminal it starts. `plain`: a Terminal only
 *  tab or a partner terminal, the only ones the helper may carry. */
export interface PlainSpawnContext {
  sessionId: string
  elevated?: boolean
  plain?: boolean
}

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
  /** How long a holder may take to answer a request (tests shorten it). */
  replyTimeoutMs?: number
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
  insideJob: 'Windows keeps the session helper inside the app\'s own job here, so a held terminal ends when the app does and does not survive a crash.',
  offNothingToEnd: 'The session helper is off, so it holds no terminal to end.',
  offNothingToReattach: 'The session helper is off, so it holds no terminal to re-attach.',
} as const

/** The Machines page's line while the switch is off and terminals are still held. */
export function offStillHoldingSentence(n: number): string {
  return `Switched off. It still holds ${n === 1 ? '1 terminal' : `${n} terminals`} until ${n === 1 ? 'its tab closes' : 'their tabs close'} or you end ${n === 1 ? 'it' : 'them'} here.`
}

const VERSION_TIMEOUT_MS = 10_000
const HOLD_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 15_000
const SELF_TEST_TIMEOUT_MS = 25_000
/** How much of the self-test's standard-error note goes in the log line. */
const SELF_TEST_NOTE_CHARS = 200
const ENDING_WAIT_MS = 5_000
/** A copy that could not be put in place is tried again by a terminal started this long after. */
const INSTALL_RETRY_AFTER_MS = 60_000
/** `hold`'s exit status when a holder for the session runs already (protocol 15). */
const EXIT_ALREADY_RUNNING = 3
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
  /** This run began after a crash: what the store holds is kept, not ended. */
  private afterCrash = false
  /** A normal quit has begun: nothing new is held or kept. */
  private quitting = false
  private state: HelperState = 'off'
  private detail: string | undefined
  private version: string | undefined
  private selfTest: SelfTestResult | undefined
  private lastError: { message: string; ts: number } | null = null
  private info: InstalledHelper | null = null
  private installing: Promise<InstalledHelper | null> | null = null
  /** When a copy that could not be put in place may be tried again; null: not that failure. */
  private installRetryAt: number | null = null
  /** One copy made again at a time: every caller that found a mismatch waits for it. */
  private recopying: Promise<InstalledHelper> | null = null
  /** `hold` said Windows keeps its holders inside the app's job (no crash survival). */
  private insideJob = false
  /** Held terminals a tab may take over: left by a crash, or named by Re-attach. */
  private readonly adoptable = new Map<string, HolderRecord>()
  /** Connections that keep a crash's held terminals alive until a tab takes them. */
  private readonly keepers = new Map<string, { record: HolderRecord; conn?: HolderConnection; ready: Promise<void> }>()
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

  /** True when a held terminal waits for the tab with this app id. */
  holdsFor(appPtyId: string): boolean {
    return this.adoptable.has(this.sidFor(appPtyId))
  }

  /**
   * Switch on (at start-up, or when the setting is turned on). What runs
   * synchronously decides, before any tab can ask, which held terminals a
   * restored tab takes over; the copy, the listing and the self-test follow.
   */
  start(opts: { atStartup: boolean }): Promise<void> {
    this.enabled = true
    if (this.started) {
      if (this.state === 'starting') {
        this.changed()
        return Promise.resolve()
      }
      if (this.info) {
        // Set up already. One that failed its own self-test is tested again.
        if (this.state === 'failed') void this.runSelfTest().catch(() => { /* recorded in runSelfTest */ })
        this.changed()
        return Promise.resolve()
      }
      // A helper that could not be set up is tried again.
      this.installing = null
      this.installRetryAt = null
      this.state = 'starting'
      this.detail = undefined
      this.changed()
      return this.bringUp(this.afterCrash)
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
    this.afterCrash = crashed
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
   *  the helper keep running until their tabs close, and a held terminal a
   *  restored tab comes back to is still shown again. */
  stopRouting(): void {
    this.enabled = false
    this.changed()
  }

  private async bringUp(crashed: boolean): Promise<void> {
    const info = await this.installed()
    // A quit that began meanwhile has ended everything: nothing more to bring up.
    if (!info || this.quitting) return
    let records: HolderRecord[] = []
    let listed = false
    try {
      records = await this.list()
      listed = true
    } catch (err) {
      this.deps.log(`[session-helper] the held terminals could not be listed: ${message(err)}`)
    }
    if (this.quitting) return
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
      // Left by a normal quit that could not end them: ended now. A terminal
      // this run holds or keeps for a tab is not one of those.
      const left = records.filter((r) => !this.live.has(r.session) && !this.keepers.has(r.session) && !this.adoptable.has(r.session))
      await Promise.allSettled(left.map((r) => this.endRecord(r)))
    }
    if (!this.info) return
    this.state = 'ready'
    this.changed()
    void this.runSelfTest().catch(() => { /* recorded in runSelfTest */ })
    // A folder of another version a listed holder runs is kept; every other
    // old folder goes (see removeOldVersionFolders).
    const otherVersions = new Set([...this.listing, ...this.heldRecords()].map((r) => r.helper).filter((v) => v !== info.version))
    const removed = await removeOldVersionFolders(this.root, info.folder, otherVersions)
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
      // No copy is made once a quit began.
      if (this.quitting) return null
      this.info = await installHelperCopy({ bundled, root: this.root, version, sha256, platform: this.deps.platform })
      this.installRetryAt = null
      this.deps.log(`[session-helper] helper ${version} ready in ${this.info.folder}`)
      return this.info
    } catch (err) {
      this.fail(err instanceof InstallError ? err.message : `The session helper could not be set up: ${message(err)}`, 'failed', err)
      return null
    }
  }

  private fail(detail: string, state: HelperState = 'failed', cause?: unknown): void {
    this.state = state
    this.detail = detail
    this.info = null
    // A copy that could not be put in place (a file another program still
    // had open) is tried again by a later terminal.
    this.installRetryAt = cause instanceof InstallError && cause.kind === 'copy' ? this.deps.now() + INSTALL_RETRY_AFTER_MS : null
    this.lastError = { message: detail, ts: this.deps.now() }
    this.deps.log(`[session-helper] ${detail}`)
    this.changed()
  }

  /** A later terminal tries again a copy that could not be put in place. */
  private retryInstallIfDue(): void {
    if (this.state !== 'failed' || this.info || this.installRetryAt === null || this.quitting) return
    if (this.deps.now() < this.installRetryAt) return
    this.deps.log('[session-helper] trying the helper copy again')
    this.installRetryAt = null
    this.installing = null
    this.state = 'starting'
    this.detail = undefined
    this.changed()
    void this.bringUp(this.afterCrash)
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
    if (this.quitting) throw new Error('The app is quitting.')
    if (!this.recopying) {
      this.deps.log('[session-helper] the helper copy does not match the installed helper; copying it again')
      // The whole version folder is made again, the bundled ConPTY's copy in
      // it too: from the same node-pty folder the first copy was asked for.
      const again = installHelperCopy({ bundled: this.deps.bundled, root: this.root, version: now.version, sha256: now.sha256, platform: this.deps.platform, conptySource: now.conptySource })
      this.recopying = again
      void again.catch(() => { /* answered below */ }).finally(() => { if (this.recopying === again) this.recopying = null })
    }
    try {
      this.info = await this.recopying
      return this.info.exe
    } catch (err) {
      if (this.info) this.fail(err instanceof InstallError ? err.message : message(err), 'failed', err)
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
   * A held terminal waiting for this tab is shown again whatever the state:
   * taking it over runs no copy of the helper and launches nothing.
   */
  spawn(ctx: PlainSpawnContext, file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
    const direct = () => this.deps.spawnDirect(file, args, opts)
    if (ctx.plain !== true || typeof args === 'string' || !APP_PTY_ID_RE.test(ctx.sessionId)) return direct()
    const sid = this.sidFor(ctx.sessionId)
    const adopt = this.quitting || this.live.has(sid) ? undefined : this.adoptable.get(sid)
    if (adopt) {
      this.adoptable.delete(sid)
      return this.track(new HelperPty({ sid, label: ctx.sessionId, spec: this.launchSpec(file, args, opts), adopt, driver: this.driver(direct, false) }), ctx.sessionId)
    }
    if (!this.enabled || this.quitting) return direct()
    this.retryInstallIfDue()
    if (this.state !== 'starting' && this.state !== 'ready') return direct()
    // An elevated tab runs its shell under gsudo or sudo, which ask for a
    // password at their own console: left the usual way, also when only the
    // program says so.
    if (ctx.elevated || /^g?sudo(\.exe)?$/i.test(file.split(/[\\/]/).pop() ?? '')) return direct()
    const spec = this.launchSpec(file, args, opts)
    const refused = checkLaunch(spec, this.os)
    if (refused) {
      this.deps.log(`[session-helper] ${ctx.sessionId}: started the usual way, because the helper would refuse ${refused.why}`)
      return direct()
    }
    return this.track(new HelperPty({ sid, label: ctx.sessionId, spec, driver: this.driver(direct, true) }), ctx.sessionId)
  }

  private track(wrapper: HelperPty, appId: string): HelperPty {
    const sid = wrapper.sid
    this.live.set(sid, wrapper)
    void wrapper.ended.then(() => {
      if (this.live.get(sid) === wrapper) this.live.delete(sid)
      for (const [bound, s] of [...this.bindings]) if (s === sid && bound === appId) this.bindings.delete(bound)
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
      now: () => this.deps.now(),
    }
  }

  private open(record: HolderRecord, sha256?: string): Promise<HolderConnection> {
    return HolderConnection.open({
      record,
      os: this.os,
      sha256,
      openStream: this.deps.openStream,
      checkEndpointFolder: this.deps.checkEndpointFolder,
      replyTimeoutMs: this.deps.replyTimeoutMs,
    })
  }

  private async hold(sid: string, label: string): Promise<HolderRecord> {
    const previous = this.endings.get(sid)
    if (previous) await Promise.race([previous, new Promise((r) => setTimeout(r, ENDING_WAIT_MS))])
    const exe = await this.checkedExe()
    // A holder of this session nobody is taking over (a terminal this run
    // could not end): ended first, so the new one can start. One that does not
    // answer is gone, and `hold` replaces its record.
    const left = this.readStoreRecords().find((r) => r.session === sid)
    if (left) {
      try {
        await this.endRecord(left)
      } catch (err) {
        this.deps.log(`[session-helper] ${sid}: the holder left for this terminal did not answer (${message(err)}); starting a new one`)
      }
    }
    const r = await this.deps.exec(exe, ['hold', '--store', this.store, '--session', sid, '--label', label, '--detach'], HOLD_TIMEOUT_MS)
    if (r.code === EXIT_ALREADY_RUNNING) {
      // A holder of this session runs already: the app connects to it (section 15).
      const running = this.readStoreRecords().find((x) => x.session === sid)
      if (running) return running
      throw new Error('a holder for this terminal runs already, and its record cannot be read')
    }
    if (r.code !== 0) throw new Error(firstLine(r.stderr) || `the helper exited with ${r.code}`)
    if (/does not let a process leave/.test(r.stderr) && !this.insideJob) {
      // The holder runs, but inside the app's job: it ends with the app.
      this.insideJob = true
      this.deps.log(`[session-helper] ${firstLine(r.stderr)}`)
      this.changed()
    }
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
    return this.open(record, checkHash ? this.info?.sha256 : undefined)
  }

  /** Keep a held terminal alive (attached, output dropped) until a tab takes it. */
  private keep(record: HolderRecord): void {
    const sid = record.session
    if (this.quitting || this.keepers.has(sid)) return
    const entry: { record: HolderRecord; conn?: HolderConnection; ready: Promise<void> } = { record, ready: Promise.resolve() }
    entry.ready = (async () => {
      try {
        const conn = await this.open(record)
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
      conn = keeper?.conn && !keeper.conn.isClosed ? keeper.conn : await this.open(record)
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

  /** The held terminals this run knows without asking the helper: taken over
   *  by a tab, through it now, or kept for a tab. Oldest first. */
  private heldRecords(): HolderRecord[] {
    const by = new Map<string, HolderRecord>()
    for (const [sid, w] of this.live) if (w.throughHelper && w.heldRecord) by.set(sid, w.heldRecord)
    for (const [sid, k] of this.keepers) if (!by.has(sid)) by.set(sid, k.record)
    for (const [sid, r] of this.adoptable) if (!by.has(sid)) by.set(sid, r)
    return [...by.values()].sort((a, b) => a.started - b.started || (a.session < b.session ? -1 : 1))
  }

  /** The ids of the terminals the helper holds for this run now. */
  private heldIds(): Set<string> {
    const held = new Set<string>([...this.adoptable.keys(), ...this.keepers.keys()])
    for (const [sid, w] of this.live) if (w.throughHelper) held.add(sid)
    return held
  }

  /**
   * At a normal quit: every terminal through the helper is ended. The end
   * messages go now; the answer settles once each holder said it ended (a
   * terminal still starting, or a keeper still connecting, is ended as soon
   * as it is up). The caller bounds the wait. The running mark goes at once:
   * this was a normal quit, so the next start ends anything left instead of
   * taking it over. Null when nothing went through the helper.
   */
  shutdown(): Promise<void> | null {
    this.quitting = true
    this.enabled = false
    const waits: Promise<unknown>[] = []
    for (const w of this.live.values()) {
      // Every one is ended; only one through a holder is waited for (one that
      // fell back to the usual way ends with the app, as any terminal does).
      const through = w.throughHelper
      try { w.kill() } catch { /* already gone */ }
      if (through) waits.push(w.ended)
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
    const held = this.heldIds().size
    // Switched off with terminals still held: the helper is still at work for them.
    return { state: this.enabled || held > 0 ? this.state : 'off', held, lastError: this.lastError }
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

  /** The held terminals: the helper's listing, or (when it cannot be read) what this run knows. */
  private async heldListing(): Promise<HolderRecord[]> {
    if (this.info) {
      try {
        return await this.list()
      } catch (err) {
        this.deps.log(`[session-helper] list failed: ${message(err)}`)
      }
    }
    return this.heldRecords()
  }

  private knownRecord(id: string): HolderRecord | undefined {
    return this.listing.find((r) => r.session === id) ?? this.heldRecords().find((r) => r.session === id)
  }

  async status(): Promise<MachineStatus> {
    const base = { id: 'this-computer' as const, name: 'This computer' }
    const heldNow = this.heldIds().size
    if (!this.enabled && heldNow === 0) return { ...base, helper: { state: 'off' }, sessions: [] }
    const sessions = (await this.heldListing()).map((r) => this.toHeld(r))
    const detail = [
      this.detail,
      this.insideJob ? HELPER_SENTENCES.insideJob : undefined,
      !this.enabled ? offStillHoldingSentence(Math.max(heldNow, sessions.length)) : undefined,
    ].filter(Boolean).join(' ')
    return {
      ...base,
      helper: {
        state: this.enabled ? this.state : 'off',
        ...(this.version ? { version: this.version } : {}),
        ...(this.selfTest ? { selfTest: this.selfTest } : {}),
        ...(detail ? { detail } : {}),
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
    // Standard error is never the result, but a note there is kept in the log:
    // on Windows the self-test writes one there when it ran without its job,
    // so its terminal's host could outlive it (aicc_planning#317).
    const note = firstLine(r.stderr).slice(0, SELF_TEST_NOTE_CHARS)
    this.deps.log(`[session-helper] self-test: ${result.ok ? 'passed' : 'failed'}: ${result.detail}${note ? ` Its note: ${note}` : ''}`)
    if (!result.ok) this.lastError = { message: result.detail ?? 'The self-test failed.', ts: result.at }
    this.changed()
    return result
  }

  async endSession(id: string): Promise<MachineActionResult> {
    if (!this.enabled && !this.heldIds().has(id)) return { ok: false, message: HELPER_SENTENCES.offNothingToEnd }
    const w = this.live.get(id)
    if (w && w.throughHelper) {
      w.kill()
      await Promise.race([w.ended, new Promise((r) => setTimeout(r, ENDING_WAIT_MS))])
      return { ok: true }
    }
    let record = this.knownRecord(id)
    if (!record && this.enabled) {
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
    if (!this.enabled && !this.heldIds().has(id)) return { ok: false, message: HELPER_SENTENCES.offNothingToReattach }
    const record = (await this.heldListing()).find((r) => r.session === id)
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
 * The PTY manager's spawn for a shell-only terminal. Exactly node-pty's spawn
 * with these arguments unless it is a plain terminal (`ctx.plain`) and the
 * helper is on, or holds a terminal this tab comes back to.
 */
export function spawnPlainPty(ctx: PlainSpawnContext, file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
  const m = current
  if (!m || ctx.plain !== true || (!m.isEnabled() && !m.holdsFor(ctx.sessionId))) return pty.spawn(file, args, opts)
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
