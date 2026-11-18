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
 * terminal) comes here: SSH sessions and the app's own shell tabs (a sign-in,
 * an install or update command, the first-run install terminal) never do.
 *
 * 2.1.3-beta.7 (plan section A3): a second setting, "... sessions through the
 * session helper" (agentSessionsThroughHelper), off by default, carries the
 * local agent sessions too (each provider's CLI in a tab): spawnAgentPty. The
 * launch is the one the PTY manager builds, unchanged: the same program,
 * arguments, folder and environment, and a typed launch line is still typed.
 * A program that reads one exact Windows command line goes as the launch's
 * `line`, and one on node-pty's bundled ConPTY asks for the helper's copy of
 * it (`conpty`). An agent session is never shown again after a crash: the
 * next start ends it, and its tab resumes the conversation the usual way
 * (plan s11, Q1). Either setting brings the helper up; after a crash, or
 * with an agent session a quit could not end in time, it comes up with both
 * off too, to end what was left held.
 *
 * 2.1.3-beta.8 (plan section B2): an app update on Windows lets go of each
 * held plain or partner terminal whose tab was saved, instead of ending it
 * (releaseForUpdate). Its holder's away clock starts, the running mark stays
 * (saying "update"), and the new version's start takes the crash path: the
 * restored tab shows the terminal again. Agent sessions still end at an
 * update, and macOS and Linux keep ending every one.
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
import { PROVIDER_IDS, type ProviderId } from '../../shared/providers/ids'
import { bundledConptyFailed } from '../bundled-conpty'
import { processGone } from '../process-alive'
import { HolderConnection, type ConnectionOptions } from './connection'
import { HelperPty, NothingStartedError, type HelperPtyDriver } from './helper-pty'
import {
  APP_PTY_ID_RE,
  SID_RE,
  checkLaunch,
  heldAgentSessionId,
  heldIdKind,
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
import { InstallError, bundledConptySource, checkedConpty, copyMatches, installHelperCopy, removeOldVersionFolders, sha256File, type InstalledHelper } from './install'

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

/** What the PTY manager says of an agent session it starts: the tab's app PTY
 *  id, and which provider's CLI runs in it. */
export interface AgentSpawnContext {
  sessionId: string
  kind: ProviderId
}

/** Which terminals the helper carries: the two settings. */
export interface HelperRouting {
  /** "Plain terminals through the session helper". */
  plain: boolean
  /** The agent sessions' setting (agentSessionsThroughHelper). */
  agents: boolean
}

export interface SessionHelperDeps {
  platform?: NodeJS.Platform
  /** The per-user folder (install.ts helperRootDir). */
  root: string
  /** The helper the installer put beside the app. */
  bundled: string
  /** node-pty's `conpty` folder, copied beside the helper (install.ts
   *  bundledConptySource; null: none). Asked once, when the copy is made. */
  conptySource?: () => string | null
  exec?: (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>
  spawnDirect?: (file: string, args: SpawnArgs, opts: SpawnOptions) => IPty
  openStream?: ConnectionOptions['openStream']
  checkEndpointFolder?: ConnectionOptions['checkEndpointFolder']
  /** How long a holder may take to answer a request (tests shorten it). */
  replyTimeoutMs?: number
  newTabId?: () => string
  log?: (message: string) => void
  now?: () => number
  /** The wait between tries to end an agent session's earlier holder (tests shorten it). */
  sleep?: (ms: number) => Promise<void>
  /** Whether no process has this id (process-alive.ts; tests answer for a fake holder). */
  processGone?: (pid: number) => boolean
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
  agentNotReattached: 'An agent session cannot be re-attached. Its own tab resumes the conversation.',
  agentNotCleared: '[The session helper still runs the session this tab had before, and could not end it, so a second one was not started. Restart this tab in a few minutes.]',
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
/** An agent session's earlier holder that did not end when asked is asked
 *  again this often, while the helper still lists it. */
const AGENT_CLEAR_RETRY_MS = 2_000
/** The longest an agent session's start waits for an earlier holder that does
 *  not answer: its away clock (it ends itself that long after the app let go
 *  of it), at most this much, and AGENT_CLEAR_GRACE_MS more. */
const AGENT_CLEAR_AWAY_CAP_MS = 5 * 60_000
const AGENT_CLEAR_GRACE_MS = 10_000
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
  private readonly deps: Required<Pick<SessionHelperDeps, 'exec' | 'spawnDirect' | 'newTabId' | 'log' | 'now' | 'conptySource' | 'sleep' | 'processGone'>> & SessionHelperDeps

  /** Plain terminals go through the helper (the first setting). */
  private plainOn = false
  /** Agent sessions go through the helper (the second setting). */
  private agentsOn = false
  private started = false
  /** This run began after a crash: what the store holds is kept, not ended. */
  private afterCrash = false
  /** A normal quit has begun: nothing new is held or kept. */
  private quitting = false
  /** An app update let go of the held terminals (releaseForUpdate): nothing
   *  new is held until reclaim() says the update did not go ahead. */
  private updating = false
  /** The terminals releaseForUpdate let go of, by session id. */
  private readonly released = new Map<string, { record: HolderRecord; pty: HelperPty }>()
  /** What reclaim() kept after an update that did not start, while no tab
   *  has taken it over again: its tab's terminal read as ended. */
  private readonly reclaimed = new Map<string, HolderRecord>()
  /** Settles once the ends the last releaseForUpdate sent were answered. */
  private updateEnds: Promise<void> = Promise.resolve()
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
  /** Agent session ids whose earlier holder is being ended (clearAgent): true
   *  once it is gone. `after` is the end of this run's own terminal of that id
   *  the clear waited for, if any. */
  private readonly agentClears = new Map<string, { done: Promise<boolean>; after: Promise<void> | undefined }>()
  /** Agent session ids whose earlier holder could not be ended: the next start asks again. */
  private readonly agentsNotCleared = new Set<string>()
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
      conptySource: () => bundledConptySource({ platform: deps.platform }),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      processGone,
      ...deps,
    }
  }

  /** On: either setting is. */
  private get enabled(): boolean {
    return this.plainOn || this.agentsOn
  }

  onChange(listener: (() => void) | null): void {
    this.changeListener = listener
  }

  private changed(): void {
    try { this.changeListener?.() } catch { /* the listener's own */ }
  }

  /** True while either setting is on. */
  isEnabled(): boolean {
    return this.enabled
  }

  /** True while a new plain terminal goes through the helper. */
  routesPlain(): boolean {
    return this.plainOn && !this.quitting && !this.updating
  }

  /** True while a new agent session goes through the helper. */
  routesAgents(): boolean {
    return this.agentsOn && !this.quitting && !this.updating
  }

  /** True when a held terminal waits for the tab with this app id. */
  holdsFor(appPtyId: string): boolean {
    return this.adoptable.has(this.sidFor(appPtyId))
  }

  /** True while a holder this agent session had may still run (one a crash
   *  left, or this run's own, being ended or not ended): its next start waits
   *  for that end, and starts nothing while it is not confirmed. */
  endingFor(ctx: AgentSpawnContext): boolean {
    if (!APP_PTY_ID_RE.test(ctx.sessionId)) return false
    const sid = heldAgentSessionId(ctx.sessionId, ctx.kind)
    return this.endings.has(sid) || this.agentClears.has(sid) || this.agentsNotCleared.has(sid)
  }

  /**
   * Switch on (at start-up, or when a setting is turned on), with which
   * terminals the helper carries: plain terminals unless `plain` is false,
   * agent sessions only when `agents` is true. Both false is a start with
   * both settings off that still has something to deal with: a crash's held
   * terminals, or agent sessions a quit could not end in time. Nothing new
   * is carried then. What runs synchronously decides, before any tab can
   * ask, which held terminals a restored tab takes over and which agent
   * sessions are ended, so a tab restored at once already waits for that
   * end; the copy, the listing and the self-test follow.
   *
   * With both settings off after a crash, a plain terminal the crash left
   * held is still kept for its tab, as one is when its setting is switched
   * off during a run: only agent sessions are ended (plan s11, Q1).
   */
  start(opts: { atStartup: boolean; plain?: boolean; agents?: boolean }): Promise<void> {
    this.plainOn = opts.plain ?? true
    this.agentsOn = opts.agents ?? false
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
    let updated = false
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
      const marker = path.join(this.root, MARKER)
      crashed = opts.atStartup && fs.existsSync(marker)
      // An update's mark takes the same path; only the log line differs.
      if (crashed) updated = markReason(marker) === 'update'
      this.writeMarker()
    } catch (err) {
      this.deps.log(`[session-helper] the helper folder could not be prepared: ${message(err)}`)
    }
    this.afterCrash = crashed
    if (crashed) {
      this.loadBindings()
      // Kept at once, before the copy and the listing: each record's own hello
      // proves its holder, and a slow listing cannot use up the two minutes.
      // An agent session is ended at once instead (plan s11, Q1): its hooks
      // and tools were this run's alone, so its tab resumes the conversation.
      let agents = 0
      for (const r of this.readStoreRecords()) {
        if (heldIdKind(r.session) === 'agent') { agents++; void this.clearAgent(r.session, r); continue }
        this.adoptable.set(r.session, r)
        this.keep(r)
      }
      this.deps.log(`[session-helper] ${updated ? 'the app was updated' : 'the app did not quit normally'}; ${this.adoptable.size} held terminal(s) may be shown again, and ${agents} agent session(s) it held are ended`)
    } else {
      this.saveBindings()
      // An agent session a normal quit could not end in time (its end was
      // sent, its answer not waited for): ended now, before its tab, restored
      // at once, starts its CLI again. Plain ones wait for the listing.
      const agents = this.readStoreRecords().filter((r) => heldIdKind(r.session) === 'agent')
      for (const r of agents) void this.clearAgent(r.session, r)
      if (agents.length > 0) this.deps.log(`[session-helper] ${agents.length} agent session(s) the last quit left held are ended`)
    }
    this.changed()
    return this.bringUp(crashed)
  }

  /** A setting changed while the helper is on: which terminals it carries from now on. */
  setRouting(routing: HelperRouting): void {
    this.plainOn = routing.plain
    this.agentsOn = routing.agents
    this.changed()
  }

  /** Switch off: new terminals start the usual way. Terminals already through
   *  the helper keep running until their tabs close, and a held terminal a
   *  restored tab comes back to is still shown again. */
  stopRouting(): void {
    this.setRouting({ plain: false, agents: false })
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
      // whose holder is gone drops out when its keeper cannot reach it. An
      // agent session the store read missed is ended, as at the start; one a
      // tab of this run holds by now is that tab's.
      for (const r of records) {
        // One an update let go of meanwhile is the next version's to keep.
        if (this.live.has(r.session) || this.keepers.has(r.session) || this.endings.has(r.session) || this.agentClears.has(r.session) || this.released.has(r.session)) continue
        if (heldIdKind(r.session) === 'agent') { void this.clearAgent(r.session, r); continue }
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
      // An agent session's goes through clearAgent, not waited for here, so
      // its tab's next start waits for it: start() began that for each one
      // the store read found, and the listing adds any it missed. One an
      // update let go of while the listing ran is not one of those either.
      const left = records.filter((r) => !this.live.has(r.session) && !this.keepers.has(r.session) && !this.adoptable.has(r.session) && !this.released.has(r.session))
      for (const r of left) if (heldIdKind(r.session) === 'agent' && !this.agentClears.has(r.session)) void this.clearAgent(r.session, r)
      await Promise.allSettled(left.filter((r) => heldIdKind(r.session) !== 'agent').map((r) => this.endRecord(r)))
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
      // node-pty's bundled ConPTY goes beside the copy too (Windows), for an
      // agent session that runs on it; missing, only that is unavailable.
      this.info = await installHelperCopy({ bundled, root: this.root, version, sha256, platform: this.deps.platform, conptySource: this.deps.conptySource() })
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
   * A plain or partner terminal: through a holder when the plain terminals'
   * setting is on and the helper can carry it, else node-pty's spawn with
   * these same arguments.
   * A held terminal waiting for this tab is shown again whatever the state:
   * taking it over runs no copy of the helper and launches nothing.
   */
  spawn(ctx: PlainSpawnContext, file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
    const direct = () => this.deps.spawnDirect(file, args, opts)
    if (ctx.plain !== true || typeof args === 'string' || !APP_PTY_ID_RE.test(ctx.sessionId)) return direct()
    const sid = this.sidFor(ctx.sessionId)
    // While an update goes on nothing is taken over either: the kill that
    // follows would end it, and the next version shows it again.
    const adopt = this.quitting || this.updating || this.live.has(sid) ? undefined : this.adoptable.get(sid)
    if (adopt) {
      this.adoptable.delete(sid)
      this.reclaimed.delete(sid)
      this.pinOwnId(ctx.sessionId, sid)
      return this.track(new HelperPty({ sid, label: ctx.sessionId, spec: this.launchSpec(file, args, opts), adopt, driver: this.driver(direct, false) }), ctx.sessionId)
    }
    if (!this.routesPlain()) return direct()
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
    this.pinOwnId(ctx.sessionId, sid)
    return this.track(new HelperPty({ sid, label: ctx.sessionId, spec, driver: this.driver(direct, true) }), ctx.sessionId)
  }

  /**
   * A tab whose first terminal Re-attach moved to another tab runs under an
   * id of its own, derived from that other tab (sidFor). It is kept as this
   * tab's binding once a terminal runs under it, so moving that first
   * terminal again later does not change it, and the tab still finds its
   * own held terminal. The binding goes when the terminal ends (track).
   */
  private pinOwnId(appPtyId: string, sid: string): void {
    if (sid === heldSessionId(appPtyId) || this.bindings.get(appPtyId) === sid) return
    this.bindings.set(appPtyId, sid)
    this.saveBindings()
  }

  /**
   * An agent session (a provider's CLI in a local tab): through a holder when
   * its setting is on and the helper can carry this launch, else node-pty's
   * spawn with these same arguments. Never a take-over: a held agent session
   * a crash left is ended, not shown again (plan s11, Q1). Either way, while
   * a holder this tab had may still run its CLI (a crash's, a Restart's, one
   * that did not end when asked), it starts only once that holder is gone
   * (clearAgent), so two CLIs never run on one conversation. When that cannot
   * be confirmed, it starts nothing, and the tab says why.
   */
  spawnAgent(ctx: AgentSpawnContext, file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
    if (!APP_PTY_ID_RE.test(ctx.sessionId)) return this.deps.spawnDirect(file, args, opts)
    const sid = heldAgentSessionId(ctx.sessionId, ctx.kind)
    const spec = this.agentSpec(file, args, opts)
    const usual = this.usualStart(file, args, opts, ctx.sessionId)
    // Set when the earlier holder could not be ended: then the usual way
    // starts nothing either, and the tab reads why.
    let notCleared = false
    const direct = (): IPty => (notCleared ? notStartedPty(HELPER_SENTENCES.agentNotCleared, opts) : usual())
    const cleared = async (): Promise<void> => {
      if (await this.clearAgent(sid)) return
      notCleared = true
      throw new NothingStartedError('the holder this tab had before is still running and could not be ended')
    }
    const usualWay = (why: string, said: boolean): IPty => {
      if (!this.endingFor(ctx)) {
        if (said) this.deps.log(`[session-helper] ${ctx.sessionId}: started the usual way, because ${why}`)
        return this.deps.spawnDirect(file, args, opts)
      }
      // Not through the helper, but only once that holder is gone: a terminal
      // whose hold waits for it and then hands over to the usual start (none
      // when the tab ended it meanwhile).
      const driver: HelperPtyDriver = {
        ...this.driver(direct, false, false),
        hold: async (_sid, _label, abandoned) => {
          await cleared()
          if (abandoned()) throw new NothingStartedError('it was ended before it started')
          throw new Error(`${why}; it waited for the end of this tab's earlier holder first`)
        },
      }
      return new HelperPty({ sid, label: ctx.sessionId, spec, driver })
    }
    if (!this.routesAgents()) return usualWay('agent sessions do not go through the session helper now', false)
    this.retryInstallIfDue()
    if (this.state !== 'starting' && this.state !== 'ready') return usualWay(`the session helper is ${this.state}`, false)
    const refused = checkLaunch(spec, this.os)
    if (refused) return usualWay(`the helper would refuse ${refused.why}`, true)
    const driver = this.driver(direct, true, spec.conpty === 'bundled', cleared)
    return this.track(new HelperPty({ sid, label: ctx.sessionId, spec, driver }), ctx.sessionId)
  }

  /**
   * An agent session's launch: the very program, folder, environment and size
   * the spawn was given. An argument line given as one string (an npm
   * launcher run through cmd.exe, which node-pty passes verbatim) goes as the
   * exact command line node-pty would have made of it, with the program alone
   * in argv; node-pty's bundled ConPTY becomes the helper's (`conpty`).
   * checkLaunch refuses either off Windows.
   */
  private agentSpec(file: string, args: SpawnArgs, opts: SpawnOptions): LaunchSpec {
    const spec = this.launchSpec(file, typeof args === 'string' ? [] : args, opts)
    if (typeof args === 'string') spec.line = nodePtyCommandLine(file, args)
    if ((opts as pty.IWindowsPtyForkOptions).useConptyDll === true) spec.conpty = 'bundled'
    return spec
  }

  /**
   * The usual way for an agent session the helper did not carry after all:
   * node-pty with the spawn's own arguments. One on node-pty's bundled ConPTY
   * that node-pty cannot start there starts on the system ConPTY instead, and
   * the rest of the run uses that one (bundledConptyFailed). That is what the
   * PTY manager's own spawn does when node-pty throws, but by the time a
   * holder has failed that spawn has long returned, so it is done here.
   */
  private usualStart(file: string, args: SpawnArgs, opts: SpawnOptions, label: string): () => IPty {
    return () => {
      try {
        return this.deps.spawnDirect(file, args, opts)
      } catch (err) {
        const { useConptyDll, ...system } = opts as pty.IWindowsPtyForkOptions
        if (useConptyDll !== true) throw err
        let started: IPty
        try { started = this.deps.spawnDirect(file, args, system) } catch { throw err }
        bundledConptyFailed(String((err as Error)?.message ?? err))
        this.deps.log(`[session-helper] ${label}: node-pty's bundled ConPTY failed to start it; started on the system ConPTY`)
        return started
      }
    }
  }

  private track(wrapper: HelperPty, appId: string): HelperPty {
    const sid = wrapper.sid
    this.live.set(sid, wrapper)
    void wrapper.ended.then(() => {
      if (this.live.get(sid) === wrapper) this.live.delete(sid)
      // One let go of for an update keeps its binding: the tab Re-attach
      // opened for it shows it again at the next start.
      if (!wrapper.isReleased) for (const [bound, s] of [...this.bindings]) if (s === sid && bound === appId) this.bindings.delete(bound)
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

  /** `bundled`: the launch asks for the bundled ConPTY, whose copy beside the
   *  helper is checked before the holder starts. `cleared` (an agent
   *  session): what must settle before a holder starts, in place of the plain
   *  terminal's wait for an earlier holder's end; it throws to start none. */
  private driver(direct: () => IPty, checkHash: boolean, bundled = false, cleared?: () => Promise<void>): HelperPtyDriver {
    return {
      hold: (sid, label, abandoned) => this.hold(sid, label, abandoned, bundled, cleared),
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

  private async hold(sid: string, label: string, abandoned: () => boolean, bundled = false, cleared?: () => Promise<void>): Promise<HolderRecord> {
    if (cleared) {
      // An agent session: no earlier holder of its id may still run (clearAgent).
      await cleared()
    } else {
      const previous = this.endings.get(sid)
      if (previous) await waitAtMost(previous, ENDING_WAIT_MS)
    }
    const exe = await this.checkedExe()
    if (bundled) {
      // Checked against node-pty's files before every launch on it, as the
      // helper's own copy is. Unavailable: the session starts the usual way,
      // on node-pty's own bundled ConPTY, and no holder is started for it.
      const copy = this.info ? await checkedConpty(this.info) : null
      if (!copy || !copy.available) throw new Error(`the bundled ConPTY beside the helper is not available (${copy && !copy.available ? copy.reason : 'no helper copy'})`)
    }
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
    // Nothing is started for a terminal no longer wanted: one its tab ended
    // (a Restart, a close) while it waited above, which would otherwise start
    // a holder beside the next start's, or one a quit ended. Checked after
    // the last wait, so nothing can end it between this and the start.
    if (abandoned()) throw new NothingStartedError('it was ended before its holder started')
    if (this.quitting) throw new Error('the app is quitting')
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

  /**
   * Make sure no earlier holder of this agent session id still runs: one a
   * crash left (ended now, never kept or shown again, plan s11 Q1), one this
   * run is ending (a Restart), or one that did not end when asked. Answers
   * true once none runs, so the tab may start its CLI; false when that could
   * not be confirmed, and then nothing may start for it. One at a time for an
   * id: every start that asks shares the answer. `record` is the crash's or
   * the listing's; without one the store is read for it.
   */
  private clearAgent(sid: string, record?: HolderRecord): Promise<boolean> {
    const earlier = this.endings.get(sid)
    const pending = this.agentClears.get(sid)
    if (pending) {
      if (!earlier || earlier === pending.after) return pending.done
      // A terminal of this id began ending after that clear started: its end
      // is waited for too. A backstop: a start the tab ends while it waits
      // here starts no holder (hold() checks `abandoned`), so today that end
      // is over at once.
      return pending.done.then((ok) => ok && this.clearAgent(sid))
    }
    const p = (async () => {
      // This run's own end first: it settles once its holder answered, or
      // after helper-pty.ts END_WAIT_MS when it did not (then the store still
      // has its record).
      if (earlier) await earlier.catch(() => { /* settled */ })
      const left = record ?? this.readStoreRecords().find((r) => r.session === sid)
      if (!left) return true
      return this.endUntilGone(left)
    })()
    const entry = { done: p, after: earlier }
    this.agentClears.set(sid, entry)
    void p.then((ok) => {
      if (this.agentClears.get(sid) === entry) this.agentClears.delete(sid)
      if (ok) this.agentsNotCleared.delete(sid)
      else this.agentsNotCleared.add(sid)
      this.changed()
    })
    return p
  }

  /**
   * End an agent session's earlier holder, and keep asking while the helper
   * still lists it: a holder that cannot be reached ends itself by its away
   * clock once the app let go of it, so this waits that long at most
   * (AGENT_CLEAR_AWAY_CAP_MS at the most, and AGENT_CLEAR_GRACE_MS more).
   * True once it ended or is gone.
   */
  private async endUntilGone(record: HolderRecord): Promise<boolean> {
    const sid = record.session
    const until = this.deps.now() + Math.min(record.away * 1000, AGENT_CLEAR_AWAY_CAP_MS) + AGENT_CLEAR_GRACE_MS
    let said = false
    for (;;) {
      try {
        await this.endRecord(record)
        this.deps.log(`[session-helper] ${sid}: ended the agent session's earlier holder`)
        return true
      } catch (err) {
        if (!said) this.deps.log(`[session-helper] ${sid}: the agent session's earlier holder did not answer its end (${message(err)}); waiting until it is gone`)
        said = true
      }
      if (await this.holderGone(record)) {
        this.deps.log(`[session-helper] ${sid}: the agent session's earlier holder is gone`)
        return true
      }
      if (this.quitting || this.deps.now() >= until) {
        this.deps.log(`[session-helper] ${sid}: the agent session's earlier holder is still running and could not be ended; nothing is started for its tab`)
        return false
      }
      await this.deps.sleep(AGENT_CLEAR_RETRY_MS)
    }
  }

  /** True when this holder no longer runs: the helper's own listing (which
   *  checks its process and its endpoint) no longer has it, or, when the
   *  helper cannot list now, no process has its id. */
  private async holderGone(record: HolderRecord): Promise<boolean> {
    try {
      return !(await this.list()).some((r) => r.session === record.session && r.pid === record.pid)
    } catch {
      return this.deps.processGone(record.pid)
    }
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
      this.reclaimed.delete(record.session)
    }
  }

  /** The records in the store as written, read strictly; no holder is asked. */
  private readStoreRecords(): HolderRecord[] {
    return readStore(this.store, this.os)
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
   * An app update on Windows (update-handlers.ts, just before every PTY is
   * killed and the installer starts): each plain or partner terminal through
   * a holder is let go of instead of ended, when its tab (a partner's is its
   * session's) is saved twice over: in the app's last save (noteSavedTabs)
   * and in `restorable`, the tabs in the saved file the next start restores
   * from. "Close without saving" clears that file, so then none is. Its
   * holder's away clock starts (two minutes) and the next start, finding the
   * running mark, shows it again in its tab. An agent session, a terminal
   * still starting and one whose tab was not saved are left to the kill that
   * follows, which ends them as before. What an earlier reclaim() kept, and
   * no tab took over since, is ended now unless its tab is saved the same
   * way (a retry with "Close sessions" after an update that did not start).
   * The mark is written again saying "update" and stays. Nothing new goes
   * through the helper until reclaim(). Off Windows nothing is let go of.
   * Answers how many were.
   */
  releaseForUpdate(restorable: ReadonlySet<string>): number {
    if (this.os !== 'windows' || this.quitting) return 0
    this.updating = true
    const saved = (tab: string) => this.savedTabs.has(tab) && restorable.has(tab)
    let n = 0
    for (const [sid, w] of this.live) {
      if (heldIdKind(sid) !== 'plain' || !w.throughHelper) continue
      const record = w.heldRecord
      const tab = parentOfPartnerPtyId(w.label) ?? w.label
      if (!record || !saved(tab)) continue
      if (!w.release()) continue
      this.released.set(sid, { record, pty: w })
      n++
    }
    const ends: Promise<unknown>[] = []
    for (const [sid, r] of [...this.reclaimed]) {
      if (this.live.has(sid)) continue
      const appId = this.appIdOf(r)
      if (saved(parentOfPartnerPtyId(appId) ?? appId)) continue
      this.reclaimed.delete(sid)
      ends.push(this.endRecord(r).catch((err) => this.deps.log(`[session-helper] ${sid}: could not be ended at the update: ${message(err)}`)))
    }
    this.updateEnds = Promise.allSettled(ends).then(() => undefined)
    try {
      this.writeMarker('update')
    } catch (err) {
      this.deps.log(`[session-helper] the running mark could not be written for the update: ${message(err)}`)
    }
    this.deps.log(`[session-helper] an app update: ${n} held terminal(s) are let go of, for the new version to show again`)
    this.changed()
    return n
  }

  /** Settles once every end the last releaseForUpdate sent was answered (or
   *  failed): what an earlier reclaim() kept for a tab no longer saved. The
   *  caller bounds the wait; the app exits next. */
  endsForUpdate(): Promise<void> {
    return this.updateEnds
  }

  /**
   * The update did not go ahead (its installer could not be started): what
   * releaseForUpdate let go of is kept for its tab, as after a crash, and
   * listed on the Machines page, where Re-attach opens a new Terminal only
   * tab on it (its own tab's terminal read as ended); its tab started again
   * takes it over too. A terminal of it not yet killed is ended here in this
   * app alone; its holder runs on. The running mark is the usual one again,
   * and new terminals go through the helper again. Answers how many are kept.
   */
  reclaim(): number {
    if (!this.updating) return 0
    this.updating = false
    const kept = [...this.released.values()]
    this.released.clear()
    for (const { record, pty: w } of kept) {
      try { w.kill() } catch { /* over already */ }
      if (this.quitting) continue
      this.adoptable.set(record.session, record)
      this.reclaimed.set(record.session, record)
      this.keep(record)
    }
    try {
      if (!this.quitting) this.writeMarker()
    } catch (err) {
      this.deps.log(`[session-helper] the running mark could not be written again: ${message(err)}`)
    }
    this.deps.log(`[session-helper] the update did not start; ${kept.length} held terminal(s) are kept for their tabs`)
    this.changed()
    return kept.length
  }

  /** The app's running mark: there while the app runs, gone after a normal quit. */
  private writeMarker(reason?: 'update'): void {
    fs.writeFileSync(path.join(this.root, MARKER), JSON.stringify({ v: 1, pid: process.pid, at: this.deps.now(), ...(reason ? { reason } : {}) }))
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
    this.plainOn = false
    this.agentsOn = false
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
    // Let go of for an update that this quit overtook: ended too (one that
    // does not answer ends by its away clock, and the next start ends it).
    for (const { record } of this.released.values()) waits.push(this.endRecord(record).catch(() => { /* above */ }))
    this.released.clear()
    this.reclaimed.clear()
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

  /**
   * The provider of an agent session's record: the one whose id, with the
   * record's label (the tab's app id), makes the record's session id. Null for
   * a plain terminal, and for an agent id this app did not make for that label.
   */
  private providerOf(r: HolderRecord): ProviderId | null {
    if (heldIdKind(r.session) !== 'agent' || !APP_PTY_ID_RE.test(r.label)) return null
    return PROVIDER_IDS.find((p) => heldAgentSessionId(r.label, p) === r.session) ?? null
  }

  /** A held terminal as the page shows it; null for an agent id no provider makes. */
  private toHeld(r: HolderRecord): HeldSession | null {
    if (heldIdKind(r.session) === 'agent') {
      const provider = this.providerOf(r)
      if (!provider) return null
      // A tab of this run shows it only through the terminal that holder was
      // started for. A holder a crash or a quit left is being ended, never
      // shown again, even while its tab waits for that end under the same id
      // to start a new one: no tab shows it.
      const w = this.live.get(r.session)
      const own = w && w.heldRecord?.pid === r.pid ? w : undefined
      // Its kind names the provider; End only, never Re-attach (the page).
      return {
        id: r.session,
        kind: provider,
        label: this.savedTabs.get(r.label) || 'Session',
        startedAt: r.started,
        attached: !!own && own.isAttached,
        tabOpen: !!own,
      }
    }
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
    const sessions = (await this.heldListing()).map((r) => this.toHeld(r)).filter((s): s is HeldSession => s !== null)
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
    // An agent session is never taken over by another tab: its hooks and
    // tools belong to its own (plan s11). End is what the page offers.
    if (heldIdKind(record.session) === 'agent') return { ok: false, message: HELPER_SENTENCES.agentNotReattached }
    const held = this.toHeld(record)
    if (!held) return { ok: false, message: HELPER_SENTENCES.notHeld }
    if (held.attached) return { ok: false, message: HELPER_SENTENCES.alreadyShowing }
    const appId = this.appIdOf(record)
    const partner = isPartnerPtyId(appId)
    const base = parentOfPartnerPtyId(appId) ?? appId
    // Kept by reclaim() after an update that did not start: its tab's
    // terminal read as ended, so bringing that tab forward shows nothing. It
    // goes to a new tab, as one no tab shows does.
    if (held.tabOpen && !(this.reclaimed.has(id) && !this.live.has(id))) {
      // Its tab is open: brought forward, and showing it attaches it.
      return { ok: true, tab: { id: base, label: held.label, open: false, partner } }
    }
    // No tab shows it: a new Terminal only tab, bound to it. The binding
    // moves: a tab an earlier Re-attach bound to it (one whose terminal read
    // as ended after an update that did not start) gets a terminal of its
    // own if it starts again, and never claims or ends this one.
    const tabId = this.deps.newTabId()
    for (const [bound, sid] of [...this.bindings]) if (sid === id) this.bindings.delete(bound)
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
 * plain terminals' setting is on, or the helper holds a terminal this tab
 * comes back to.
 */
export function spawnPlainPty(ctx: PlainSpawnContext, file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
  const m = current
  if (!m || ctx.plain !== true || (!m.routesPlain() && !m.holdsFor(ctx.sessionId))) return pty.spawn(file, args, opts)
  return m.spawn(ctx, file, args, opts)
}

/**
 * The PTY manager's spawn for a local agent session (2.1.3-beta.7). Exactly
 * node-pty's spawn with these arguments unless the agent sessions' setting is
 * on, or this tab's earlier holder is still being ended (then it starts after
 * that end).
 */
export function spawnAgentPty(ctx: AgentSpawnContext, file: string, args: SpawnArgs, opts: SpawnOptions): IPty {
  const m = current
  if (!m || (!m.routesAgents() && !m.endingFor(ctx))) return pty.spawn(file, args, opts)
  return m.spawnAgent(ctx, file, args, opts)
}

/** True when the app's running mark is in the helper's folder: the last run
 *  that had the helper on did not quit normally. */
export function crashMarkIn(root: string): boolean {
  try {
    return fs.existsSync(path.join(root, MARKER))
  } catch {
    return false
  }
}

/** Why the running mark was left: "update" when an app update let go of the
 *  held terminals (releaseForUpdate); null for a crash, or a mark that does
 *  not read. */
function markReason(marker: string): 'update' | null {
  try {
    const v = JSON.parse(fs.readFileSync(marker, 'utf8')) as { reason?: unknown } | null
    return v && typeof v === 'object' && v.reason === 'update' ? 'update' : null
  } catch {
    return null
  }
}

/**
 * True when the helper's store has a record of an agent session: a holder a
 * run left, because its quit could not wait for the end it sent (or it
 * crashed). The next start makes the manager for it whatever the settings
 * say, so the tab, restored, waits for that holder's end before it starts its
 * CLI again. Read strictly, as the manager reads its store; no holder is asked.
 */
export function agentRecordsIn(root: string, platform?: NodeJS.Platform): boolean {
  return readStore(path.join(root, 'store'), helperOs(platform)).some((r) => heldIdKind(r.session) === 'agent')
}

/** The records in a store folder as written, read strictly; no holder is asked. */
function readStore(store: string, os: HelperOs): HolderRecord[] {
  let names: string[]
  try {
    names = fs.readdirSync(store)
  } catch {
    return []
  }
  const out: HolderRecord[] = []
  for (const name of names) {
    const m = /^(.+)\.json$/.exec(name)
    if (!m || !SID_RE.test(m[1])) continue
    try {
      const r = readRecord(JSON.parse(fs.readFileSync(path.join(store, name), 'utf8')), os)
      if (r && r.session === m[1]) out.push(r)
    } catch { /* being written, or not a record */ }
  }
  return out
}

/**
 * The command line node-pty gives Windows for a program and an argument line
 * passed as one string (node-pty windowsPtyAgent.js argsToCommandLine): the
 * program, quoted the way node-pty quotes one argument, a space, then the
 * line exactly; the program alone, as it is, for an empty line.
 */
export function nodePtyCommandLine(file: string, line: string): string {
  return line.length === 0 ? file : `${quoteLikeNodePty(file)} ${line}`
}

/** One argument as node-pty's argsToCommandLine writes it. */
function quoteLikeNodePty(arg: string): string {
  const first = arg[0]
  const last = arg[arg.length - 1]
  const lopsided = (first !== '"') !== (last !== '"')
  const unquoted = first !== '"' && last !== '"'
  const quote = arg === '' || ((arg.includes(' ') || arg.includes('\t')) && arg.length > 1 && (lopsided || unquoted))
  let out = quote ? '"' : ''
  let backslashes = 0
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i]
    if (c === '\\') {
      backslashes++
    } else if (c === '"') {
      out += `${'\\'.repeat(backslashes * 2 + 1)}"`
      backslashes = 0
    } else {
      out += `${'\\'.repeat(backslashes)}${c}`
      backslashes = 0
    }
  }
  return quote ? `${out}${'\\'.repeat(backslashes * 2)}"` : `${out}${'\\'.repeat(backslashes)}`
}

/**
 * A terminal in which nothing started: it shows `text` once and ends at once
 * (exit code 1), as a session whose program failed does. For an agent
 * session that may not start while its tab's earlier holder still runs.
 */
function notStartedPty(text: string, opts: SpawnOptions): IPty {
  const onData = new Set<(d: string) => void>()
  const onExit = new Set<(e: { exitCode: number; signal?: number }) => void>()
  let over = false
  const end = () => {
    if (over) return
    over = true
    for (const l of [...onExit]) { try { l({ exitCode: 1 }) } catch { /* the listener's own */ } }
  }
  const p = {
    pid: 0,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    process: '',
    handleFlowControl: false,
    onData: (l: (d: string) => void) => { onData.add(l); return { dispose: () => { onData.delete(l) } } },
    onExit: (l: (e: { exitCode: number; signal?: number }) => void) => { onExit.add(l); return { dispose: () => { onExit.delete(l) } } },
    write: () => { /* nothing runs */ },
    resize: () => { /* nothing runs */ },
    clear: () => { /* nothing runs */ },
    pause: () => { /* nothing runs */ },
    resume: () => { /* nothing runs */ },
    kill: () => end(),
  }
  // After the caller's listeners are on, as node-pty's own events come.
  setTimeout(() => {
    if (over) return
    for (const l of [...onData]) { try { l(`\r\n${text}\r\n`) } catch { /* the listener's own */ } }
    end()
  }, 0)
  return p as unknown as IPty
}

/** Waits for `p`, or `ms`, whichever is first; never throws. */
function waitAtMost(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([p.then(() => undefined, () => undefined), new Promise<void>((r) => { timer = setTimeout(r, ms) })]).finally(() => clearTimeout(timer))
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
