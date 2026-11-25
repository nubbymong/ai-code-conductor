/**
 * A Claude Code SSH tab through the session helper on its machine
 * (2.1.3-beta.17, plan section A2; ADR-030 S25's first session kind; plan
 * v3's R9 holder and R10's launch with no typed line).
 *
 * The tab's terminal is the same HelperPty a local held session uses
 * (../session-helper/helper-pty.ts): a holder started by one exec
 * (`hold --detach`, which prints its record), then a connection whose stream
 * is a long `ssh -T` exec of the helper's `bridge` mode, so the holder's
 * frames (protocol section 15) ride ssh's pipes: no typed setup or launch
 * line, no sentinel parsing, no ConPTY between the app and the host. The
 * launch starts the CLI through the host user's login shell
 * (`<shell> -il -c 'exec "$0" "$@"' <program> <args>`, ADR-030 D8), values as
 * arguments, so what the user's rc files set reaches the CLI as on the usual
 * path; the `-il` PATH is the one the machine's record keeps. The program, its
 * arguments and the CLI's own variables come from the tab's provider package
 * (its remote launch, providers/types.ts ProviderRemoteLaunch; 2.1.3-beta.18
 * section 2); this file names no flag or variable of a CLI.
 *
 * Its own files (2.1.3-beta.18 section 3.2): before the hold, one exec reads
 * the host files the provider names (its hostReads: for Claude Code, the
 * settings files whose hooks the session keeps), as data; after the hold and
 * before the launch, one exec writes the files the provider's launch gives
 * into the session's own folder there (`~/.aicc/<did>/sessions/<sid>/`,
 * 0700), contents on standard input. They name the helper's path, its store
 * and the session id on the host: never an address, a port or a credential of
 * this computer. The folder goes at the session's end (`unsession`), and the
 * next Check removes any whose holder is gone (`sweep`).
 *
 * A dropped link (the ssh child ended, or a pong that never came) attaches
 * again from the last byte seen, with the holder's replay: HelperPty asks for
 * a new connection, and this driver tries a new bridge exec after 1, 2, 4, 8,
 * 16, 32 and 32 s (section 11's 1 to 16 s, then two tries more: 95 s of
 * waiting in all, inside the holder's two-minute away clock), never after a
 * sign-in or host key failure, a hash mismatch, or a
 * bridge that finds no holder. A closed tab or a quit ends the session
 * (`term.end`), as a plain SSH session ends then (D13); a tab closed just as
 * its link drops sends its end once more, over a link of its own.
 *
 * Its status line, hook events and tools (2.1.3-beta.18 section 3.2): the
 * tab's connections ack `status`, `hooks` and `mcp`, and ./signals.ts routes
 * what comes on them: the status line to the tab's strip, the hook events to
 * the session signals module (attention, the canvas turn boundary, the
 * Watchdog), each tool stream to the tool host as the tab's session, with no
 * credential, the tool set an SSH tab has (the image fetch tool an image
 * paste, Snap and the screenshot storyboard use included). What such a tab
 * does not have in this preview: the account label, the per-model weekly
 * buckets and extra usage on its status line (the helper reads no credential
 * and calls no network). Prompt buttons and broadcast type into it by the
 * usual rule for a Claude Code tab.
 *
 * This file imports nothing of Electron.
 */
import { createHash } from 'crypto'
import type { IDisposable, IEvent, IPty } from 'node-pty'
import { HolderConnection, HolderError } from '../session-helper/connection'
import { HelperPty, NothingStartedError, type HelperPtyDriver } from '../session-helper/helper-pty'
import { checkLaunch, readListing, readRecord, type HolderRecord, type LaunchSpec } from '../session-helper/protocol'
import { stripSpoofableText } from '../../shared/safe-text'
import type { ProviderId } from '../../shared/providers/ids'
import type { ProviderRemoteLaunch, RemoteHelperCommands, RemoteHostFile, RemoteHostRead, RemoteLaunch, RemoteLaunchOptions } from '../providers/types'
import { HOST_READ_MAX, holderLabel } from './scripts'
import { EXEC_STDOUT_MAX, afterHashLine, newNonce, notStartedLogLine, openScriptStream, readHashLine, readScriptResult, runScript, sshFailure, type SshRunner, type SshTarget } from './ssh-exec'
import { hostReadsInput, hostReadsOf, sessionFilesInput } from './session-files'
import { RemoteSignals, type RemoteSignalDeps } from './signals'
import { refusalText, type RemoteMachineRecord } from './machines'

/** The helper's session id for a remote tab: always the same for the same app
 *  id, never one a local terminal or agent session gets (`rm` and 30 hex). */
export function remoteSessionId(appPtyId: string): string {
  return `rm${createHash('sha256').update(`aicc-remote-session\0${appPtyId}`, 'utf8').digest('hex').slice(0, 30)}`
}

/** The waits between tries for a dropped link: section 11's 1, 2, 4, 8, 16 s, then 32 s twice; 95 s in all, inside the two-minute away clock. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 32000, 32000]
/** How long a bridge exec may take to pass its hash line, and the hello after it. */
export const BRIDGE_OPEN_MS = 30_000
export const BRIDGE_HELLO_MS = 20_000

/** The folder a session starts in: the config's remote path made absolute
 *  against the host's home (`~`, `~/x`, a relative path), else the home. */
export function remoteCwd(remotePath: string | undefined, home: string): string {
  const p = (remotePath ?? '').trim()
  if (!p || p === '~') return home
  if (p.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${p.slice(2)}`
  if (p.startsWith('/')) return p
  return `${home.replace(/\/+$/, '')}/${p}`
}

/** The host account's own variables for a remote launch: what the probe read
 *  on the host (its home folder, user, login shell and PATH). Never a profile
 *  folder of this computer, so not the managed-launch choke point's; the
 *  profile-home guard in tests/wp1/managed-launch.test.ts names this one line. */
const hostAccountEnv = (m: RemoteMachineRecord): Record<string, string> => ({
  HOME: m.home, USER: m.user, LOGNAME: m.user, SHELL: m.shell, PATH: m.path,
})

/** The session helper's commands for session `sid` on machine `m`, by the
 *  layout the scripts keep there (scripts.ts: `~/.aicc/<did>/helper/<folder>/aicc-helper`,
 *  `~/.aicc/<did>/store` and, for the session's own files,
 *  `~/.aicc/<did>/sessions/<sid>`), from the home folder the machine's check read. */
export function remoteHelperCommands(m: RemoteMachineRecord, sid: string): RemoteHelperCommands {
  const device = `${m.home.replace(/\/+$/, '')}/.aicc/${m.did}`
  return { helperPath: `${device}/helper/${m.helper.folder}/aicc-helper`, store: `${device}/store`, sid, folder: `${device}/sessions/${sid}` }
}

/** A tab's launch through the helper, as its provider gave it before anything
 *  was read on the host (./index.ts remoteLaunchOf). The driver reads the
 *  host files it names, asks the launch again with them, and writes its files. */
export interface RemoteLaunchPlan {
  /** The tab's provider, whose session the tool host serves. */
  readonly provider: ProviderId
  readonly via: ProviderRemoteLaunch
  readonly options: RemoteLaunchOptions
  readonly helper: RemoteHelperCommands
  /** The host files to read first (the provider's hostReads), in order. */
  readonly reads: readonly RemoteHostRead[]
  /** The launch asked with every read not made: its program, arguments and
   *  variables are the spec's, and the launch asked with the reads must give
   *  the same. */
  readonly first: RemoteLaunch
  readonly spec: LaunchSpec
}

/** The most standard output a host read's exec keeps: every file at its
 *  bound as hex, and room for its lines. */
const hostReadsStdoutMax = (reads: number): number => Math.max(EXEC_STDOUT_MAX, reads * HOST_READ_MAX * 2 + 64 * 1024)

/**
 * What the CLI is started with on the host: the provider's program,
 * arguments and variables (`cli`, its remote launch), through the host
 * user's login shell when that is of the sh family, with the host account's
 * variables, LANG and TERM first and the terminal's own (`terminalEnv`: its
 * light or dark scheme) last. Throws when `cli.env` names a variable this
 * sets itself: the provider's launch never replaces one.
 */
export function remoteLaunchSpec(m: RemoteMachineRecord, cli: Pick<RemoteLaunch, 'program' | 'args' | 'env'>, terminalEnv: Readonly<Record<string, string>>, remotePath: string | undefined, cols: number, rows: number): LaunchSpec {
  const argv = m.shellIsSh ? [m.shell, '-il', '-c', 'exec "$0" "$@"', cli.program, ...cli.args] : [cli.program, ...cli.args]
  const own: Record<string, string> = {
    ...hostAccountEnv(m),
    LANG: m.lang ?? 'C.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor',
  }
  const taken = new Set([...Object.keys(own), ...Object.keys(terminalEnv)].map((k) => k.toUpperCase()))
  for (const k of Object.keys(cli.env)) {
    if (taken.has(k.toUpperCase())) throw new Error(`the provider's launch sets ${k}, which the session helper's launch sets itself`)
  }
  const env: Record<string, string> = { ...own, ...cli.env, ...terminalEnv }
  return { argv, cwd: remoteCwd(remotePath, m.home), env, cols, rows }
}

class Emitter<T> {
  private listeners: Array<(e: T) => void> = []
  readonly event: IEvent<T> = (listener: (e: T) => unknown): IDisposable => {
    const fn = (e: T) => { listener(e) }
    this.listeners.push(fn)
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== fn) } }
  }
  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try { l(e) } catch { /* a listener's throw is its own */ }
    }
  }
}

/** A terminal that only says why it could not start, then ends. */
export class NoticePty implements IPty {
  readonly pid = 0
  readonly process = 'ssh'
  handleFlowControl = false
  private readonly data = new Emitter<string>()
  private readonly exit = new Emitter<{ exitCode: number; signal?: number }>()
  private over = false
  constructor(text: string, readonly cols: number, readonly rows: number) {
    setTimeout(() => {
      if (this.over) return
      this.data.fire(`\r\n[${text}]\r\n`)
      this.end()
    }, 0)
  }
  get onData(): IEvent<string> { return this.data.event }
  get onExit(): IEvent<{ exitCode: number; signal?: number }> { return this.exit.event }
  private end(): void { if (!this.over) { this.over = true; this.exit.fire({ exitCode: 1 }) } }
  write(): void { /* nothing runs */ }
  resize(): void { /* nothing to size */ }
  clear(): void { /* nothing shown but the note */ }
  pause(): void { /* nothing flows */ }
  resume(): void { /* nothing flows */ }
  kill(): void { this.end() }
}

/** Sessions of a remote tab still ending, by helper session id: a new holder
 *  for the same id waits for its end (a Restart reuses the id). */
const endings = new Map<string, Promise<void>>()
const ENDING_WAIT_MS = 10_000

async function afterEnding(sid: string): Promise<void> {
  const done = endings.get(sid)
  if (!done) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([done, new Promise<void>((r) => { timer = setTimeout(r, ENDING_WAIT_MS) })]).catch(() => { /* ended either way */ })
  if (timer) clearTimeout(timer)
}

/** An error that no new try will mend: no reconnect after it (section 11). */
class FinalError extends Error {}

export interface RemoteSessionOptions {
  appPtyId: string
  machine: RemoteMachineRecord
  installId: string
  runner: SshRunner
  spec: LaunchSpec
  log: (message: string) => void
  /** The launch its provider gave (2.1.3-beta.18 section 3.2): the host files
   *  read first, the session's files written before the launch and removed at
   *  its end, and the keep-lists. Absent: none of that, the spec alone. */
  plan?: RemoteLaunchPlan
  /** Where the tab's status line, hook events and tool streams go. Absent:
   *  its connections ask for none of them. */
  signals?: RemoteSignalDeps
  /** The back-off for a dropped link; tests shorten it. */
  reconnectDelaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
}

/** HelperPty's driver for a remote tab: every step is an exec over ssh. */
export class RemoteDriver implements HelperPtyDriver {
  /** Set once the tab is closed: no new try starts. */
  closed = false
  /** The bridge exec's ssh process now (for the host line and the e2e job). */
  linkPid: number | undefined
  /** `direct` starts no program: it only says why (a NoticePty). */
  readonly startsNothing = true as const
  private why = ''
  private readonly connected = new Set<string>()
  private readonly target: SshTarget
  private readonly sleep: (ms: number) => Promise<void>
  /** The tab's status line, hook events and tool streams; none without a plan and the app's side. */
  private readonly signals: RemoteSignals | undefined
  /** Set once the session's files were sent to the host: its end removes the folder. */
  private filesSent = false

  constructor(private readonly o: RemoteSessionOptions) {
    this.target = { host: o.machine.host, port: o.machine.port, user: o.machine.user }
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    const plan = o.plan
    if (plan && o.signals) {
      this.signals = new RemoteSignals({ appPtyId: o.appPtyId, provider: plan.provider, via: plan.via, launch: plan.first, tools: plan.options.tools, deps: o.signals, log: o.log })
    }
  }

  private values(nonce: string, ...rest: string[]): string[] {
    const m = this.o.machine
    return [nonce, m.did, this.o.installId, m.helper.folder, m.helper.sha256, ...rest]
  }

  private failWith(why: string): never {
    this.why = why
    throw new Error(why)
  }

  /**
   * The host files the launch needs are read first (when its provider names
   * any), then the holder is started, then the session's own files are
   * written (when the launch gives any), all before HelperPty sends the
   * launch. A start that fails after its holder started ends that holder.
   */
  async hold(sid: string, label: string, abandoned: () => boolean): Promise<HolderRecord> {
    await afterEnding(sid)
    const plan = this.o.plan
    const launch = plan ? await this.launchWithReads(plan, sid) : undefined
    if (abandoned()) throw new NothingStartedError('the tab was closed while it started')
    const record = await this.startHolder(sid, label, abandoned)
    if (launch) {
      this.signals?.launched(launch)
      if (launch.files.length > 0) await this.writeFiles(sid, record, launch)
    }
    return record
  }

  /**
   * The launch asked with what the `reads` exec read on the host (each read
   * null when the provider names none, or the exec did not take it: one log
   * line each). Throws, saying why, when the host could not be reached, the
   * exec refused, or the launch's program, arguments or variables are not the
   * ones its spec was built from.
   */
  private async launchWithReads(plan: RemoteLaunchPlan, sid: string): Promise<RemoteLaunch> {
    const host = this.o.machine.host
    let files: RemoteHostFile[] = plan.reads.map((r) => ({ from: r.from, path: r.path, content: null }))
    if (plan.reads.length > 0) {
      let stdin: Buffer
      try {
        stdin = hostReadsInput(plan.options.cwd, plan.reads)
      } catch (err) {
        this.failWith(`the session's settings files on ${host} cannot be read: ${(err as Error).message}`)
      }
      const nonce = newNonce()
      const r = await runScript(this.o.runner, this.target, 'reads', [nonce, this.o.machine.did, this.o.installId], { stdin, stdoutMax: hostReadsStdoutMax(plan.reads.length) })
      if (r.notStarted) this.o.log(notStartedLogLine(host, r.stderr))
      const failed = sshFailure(r)
      if (failed) this.failWith(`${host} could not be reached: ${failed}`)
      const result = readScriptResult(r.stdout, nonce)
      if (!result) this.failWith(`${host} did not answer the session helper's read of the session's settings files`)
      if (!result.ok) this.failWith(`the session's settings files on ${host} were not read: ${refusalText(result.refused)}; press Check on the Machines page`)
      const answer = hostReadsOf(result, plan.reads)
      for (const s of answer.skipped) this.o.log(`[remote-helper] ${sid}: ${s.read.from} ${s.read.path} on ${host} was not read (${s.why}), so nothing it sets is in the session's settings`)
      files = answer.files
    }
    let launch: RemoteLaunch
    try {
      launch = plan.via.launch(plan.options, this.o.machine, plan.helper, files)
    } catch (err) {
      this.failWith(`its provider's launch could not be made: ${(err as Error).message}`)
    }
    const same = launch.program === plan.first.program && JSON.stringify(launch.args) === JSON.stringify(plan.first.args) && JSON.stringify(launch.env) === JSON.stringify(plan.first.env)
    if (!same) this.failWith('its provider\'s launch changed its program, arguments or variables with what was read on the host')
    return launch
  }

  /** The session's own files into its folder on the host (the `files` exec).
   *  On any failure its holder is ended first, then the start fails saying why. */
  private async writeFiles(sid: string, record: HolderRecord, launch: RemoteLaunch): Promise<void> {
    const host = this.o.machine.host
    let why: string | null = null
    try {
      const { layout, stdin } = sessionFilesInput(launch.files)
      const nonce = newNonce()
      this.filesSent = true
      const r = await runScript(this.o.runner, this.target, 'files', [nonce, this.o.machine.did, this.o.installId, sid, layout], { stdin })
      if (r.notStarted) this.o.log(notStartedLogLine(host, r.stderr))
      const failed = sshFailure(r)
      const result = failed ? null : readScriptResult(r.stdout, nonce)
      if (failed) why = `${host} could not be reached: ${failed}`
      else if (!result) why = `${host} did not answer the session helper's write of the session's files`
      else if (!result.ok) why = `the session's files could not be written on ${host}: ${refusalText(result.refused)}`
    } catch (err) {
      why = (err as Error).message
    }
    if (why === null) return
    await this.endHolder(record)
    this.failWith(why)
  }

  /** A holder this start made and cannot use: ended over a link of its own. */
  private async endHolder(record: HolderRecord): Promise<void> {
    let conn: HolderConnection | undefined
    try {
      conn = await this.connectOnce(record, false)
      await conn.request({ t: 'term.end' })
    } catch (err) {
      this.o.log(`[remote-helper] ${record.session}: the holder started for this tab could not be ended (${(err as Error).message}); its away clock ends it`)
    } finally {
      conn?.close()
    }
  }

  /** The session's own folder goes (the `unsession` exec), once its holder
   *  ended. Never throws; one that is not removed is the next Check's. */
  private async removeFolder(sid: string): Promise<void> {
    const host = this.o.machine.host
    try {
      const nonce = newNonce()
      const r = await runScript(this.o.runner, this.target, 'unsession', [nonce, this.o.machine.did, this.o.installId, sid])
      const failed = sshFailure(r)
      const result = failed ? null : readScriptResult(r.stdout, nonce)
      if (!result?.ok) this.o.log(`[remote-helper] ${sid}: the session's folder on ${host} was not removed (${failed ?? (result ? refusalText(result.refused) : 'no answer')}); the next Check removes it`)
    } catch (err) {
      this.o.log(`[remote-helper] ${sid}: the session's folder on ${host} was not removed (${(err as Error).message}); the next Check removes it`)
    }
  }

  private async startHolder(sid: string, label: string, abandoned: () => boolean): Promise<HolderRecord> {
    const host = this.o.machine.host
    for (let attempt = 0; attempt < 2; attempt++) {
      if (abandoned()) throw new NothingStartedError('the tab was closed while it started')
      const nonce = newNonce()
      const r = await runScript(this.o.runner, this.target, 'hold', this.values(nonce, sid, holderLabel(label)))
      const failed = sshFailure(r)
      if (r.notStarted) this.o.log(notStartedLogLine(host, r.stderr))
      if (failed) this.failWith(`${host} could not be reached: ${failed}`)
      const hash = readHashLine(r.stdout, nonce)
      if (!hash) this.failWith(`${host} did not answer the session helper (is it still added? press Check on the Machines page)`)
      if (hash.state !== 'ok') this.failWith(`the session helper file on ${host} did not pass its hash check (${hash.state}); press Check on the Machines page`)
      if (r.code === 3) {
        // A holder left for this tab's session (an app crash or update within
        // its away clock): ended first, so two CLIs never run on one conversation.
        if (attempt === 0 && !abandoned()) { await this.endLeftover(sid); continue }
        this.failWith(`a session the app could not end still runs for this tab on ${host}`)
      }
      if (r.code !== 0) this.failWith(`the session helper on ${host} could not start a holder (exit ${r.code ?? 'unknown'}: ${r.stderr.trim().slice(0, 200)})`)
      const line = afterHashLine(r.stdout, nonce).split(/\r?\n/).find((l) => l.startsWith('{'))
      let record: HolderRecord | null = null
      try { record = line ? readRecord(JSON.parse(line), 'unix') : null } catch { record = null }
      if (!record || record.session !== sid) this.failWith(`the session helper on ${host} started a holder whose record does not read`)
      return record
    }
    this.failWith(`a holder for this tab could not be started on ${host}`)
  }

  /** The holder a crash or an update left for `sid`: found by list mode, then ended. */
  private async endLeftover(sid: string): Promise<void> {
    const nonce = newNonce()
    const r = await runScript(this.o.runner, this.target, 'list', this.values(nonce))
    const line = readHashLine(r.stdout, nonce)?.state === 'ok' ? afterHashLine(r.stdout, nonce).split(/\r?\n/).find((l) => l.startsWith('{')) : undefined
    const listing = line ? readListing(line, 'unix') : null
    const rec = listing?.sessions.find((s) => s.session === sid)
    if (!rec) { this.o.log(`[remote-helper] ${sid}: a holder runs for it, and list mode does not show it`); return }
    this.o.log(`[remote-helper] ${sid}: a holder an earlier run left for this tab is ended first`)
    let conn: HolderConnection | undefined
    try {
      conn = await this.connectOnce(rec)
      await conn.request({ t: 'term.end' })
    } catch (err) {
      this.o.log(`[remote-helper] ${sid}: the earlier holder could not be ended: ${(err as Error).message}`)
    } finally {
      conn?.close()
    }
  }

  async connect(record: HolderRecord): Promise<HolderConnection> {
    const again = this.connected.has(record.nonce)
    // A closed tab gets one try (its end, term.end); only a tab still open
    // waits out a dropped link.
    const delays = again && !this.closed ? [0, ...(this.o.reconnectDelaysMs ?? RECONNECT_DELAYS_MS)] : [0]
    let last: Error = new Error('no try was made')
    for (const d of delays) {
      if (d > 0) await this.sleep(d)
      if (d > 0 && this.closed) break
      try {
        const conn = await this.connectOnce(record, true, true)
        this.connected.add(record.nonce)
        return conn
      } catch (err) {
        last = err as Error
        if (err instanceof FinalError) break
        if (again) this.o.log(`[remote-helper] ${record.session}: the link to ${this.o.machine.host} is not back yet (${last.message})`)
      }
    }
    this.why = last.message
    throw last
  }

  /**
   * Two requests on a connection get more than a plain failure.
   *
   * A launch the holder refuses (the config's remote folder is not there, so
   * the CLI cannot start in it): the tab's note names the folder and the
   * holder's words, not "it did not answer" (HelperPty then ends the holder
   * and shows direct()).
   *
   * A tab closed just as its link dropped: HelperPty sends the end over the
   * connection it still has, and the link takes it down with it (the
   * connection closes before the holder answers, so the holder never got it,
   * or ended and could not say so). Such an end goes once more, over a link of
   * its own; a holder already gone answers that with a bridge exit 3, and the
   * end is done. Any other request fails as it did.
   */
  private wrapRequests(conn: HolderConnection, record: HolderRecord): void {
    const request = conn.request.bind(conn)
    conn.request = async (msg, onReply) => {
      try {
        return await request(msg, onReply)
      } catch (err) {
        if (msg.t === 'term.launch') {
          this.why = `Claude Code could not be started in ${this.o.spec.cwd} on ${this.o.machine.host}: ${stripSpoofableText((err as Error).message, 200)}`
        }
        if (msg.t !== 'term.end' || !this.closed || !(err instanceof HolderError) || err.code !== 'io') throw err
        this.o.log(`[remote-helper] ${record.session}: the link dropped as the tab closed; its end goes once more on a new link`)
        const again = await this.connectOnce(record, false)
        try {
          return await again.request(msg, onReply)
        } finally {
          again.close()
        }
      }
    }
  }

  /** One bridge exec, and the holder's hello over it. `tabs`: a connection of
   *  the tab's own (connect), which asks for its status line, hook events and
   *  tool streams and is routed by ./signals.ts; an end's own link asks for
   *  none of them. */
  private async connectOnce(record: HolderRecord, endAgain = true, tabs = false): Promise<HolderConnection> {
    const nonce = newNonce()
    let opened: Awaited<ReturnType<typeof openScriptStream>>
    try {
      opened = await openScriptStream(this.o.runner, this.target, 'bridge', this.values(nonce, record.session), nonce, BRIDGE_OPEN_MS)
    } catch (err) {
      const e = err as Error & { final?: boolean; startError?: string }
      if (typeof e.startError === 'string') this.o.log(notStartedLogLine(this.o.machine.host, e.startError))
      throw e.final ? new FinalError(e.message) : e
    }
    this.linkPid = opened.pid
    const asks = tabs ? this.signals?.asks : undefined
    try {
      const conn = await HolderConnection.open({
        record,
        os: 'unix',
        // The endpoint is on the host: the bridge, as this user there, connects to it.
        checkEndpointFolder: () => null,
        openStream: async () => opened.stream,
        helloTimeoutMs: BRIDGE_HELLO_MS,
        ...(asks?.hooks ? { hooks: true } : {}),
        ...(asks?.mcp ? { mcp: true } : {}),
        ...(asks?.status ? { status: true } : {}),
      })
      if (endAgain) this.wrapRequests(conn, record)
      if (asks) this.signals?.connected(conn)
      return conn
    } catch (err) {
      // ssh's exit status first (a bridge that found no holder exits 3, often
      // just after its output ends), then ssh is ended if it still runs.
      let timer: ReturnType<typeof setTimeout> | undefined
      const r = await Promise.race([opened.result, new Promise<null>((res) => { timer = setTimeout(() => res(null), 2000) })])
      if (timer) clearTimeout(timer)
      opened.stream.destroy()
      if (r?.code === 3) throw new FinalError(`no holder runs for this tab on ${this.o.machine.host} any more`)
      // Any other exit of the bridge before its hello is named, so the tab's
      // note says it; a usage error (2: a helper without the mode) is not
      // tried again, and exit 1 may be.
      if (typeof r?.code === 'number') {
        const why = `${(err as Error).message} (the session helper's bridge on ${this.o.machine.host} exited ${r.code})`
        throw r.code === 2 ? new FinalError(why) : new Error(why)
      }
      throw err
    }
  }

  direct(): IPty {
    const m = this.o.machine
    return new NoticePty(`This tab could not start through the session helper on ${m.host}: ${this.why || 'it did not answer'}. Press Check on the Machines page, or turn the remote sessions switch off in Settings for the usual SSH path.`, this.o.spec.cols, this.o.spec.rows)
  }

  ending(sid: string, done: Promise<void>): void {
    // Once the holder ended, the session's own folder goes, when its files
    // were sent; a new holder for the same id (a Restart) waits for both.
    const whole = done.catch(() => { /* ended either way */ }).then(() => (this.filesSent ? this.removeFolder(sid) : undefined))
    endings.set(sid, whole)
    void whole.finally(() => { if (endings.get(sid) === whole) endings.delete(sid) })
  }

  attachedChanged(): void { /* the Machines page reads tabs, not attaches, in this preview */ }

  log(message: string): void { this.o.log(message) }
}

/**
 * The tab's terminal: a HelperPty over the remote driver, shaped as node-pty's
 * IPty. Its pid is 0: the holder's and the CLI's are the host's, and must
 * never be taken for a process on this computer.
 */
export class RemoteHelperPty implements IPty {
  readonly pid = 0
  readonly sid: string
  readonly machineDid: string
  private readonly inner: HelperPty
  private readonly driver: RemoteDriver
  private readonly data = new Emitter<string>()

  constructor(o: RemoteSessionOptions) {
    this.sid = remoteSessionId(o.appPtyId)
    this.machineDid = o.machine.did
    this.driver = new RemoteDriver(o)
    const problem = checkLaunch(o.spec, 'unix')
    if (problem) throw new Error(`the launch cannot go through the session helper: ${problem.why}`)
    this.inner = new HelperPty({ sid: this.sid, label: o.appPtyId, spec: o.spec, driver: this.driver, redraw: 'nudge' })
    this.inner.onData((d) => this.data.fire(d))
  }

  get cols(): number { return this.inner.cols }
  get rows(): number { return this.inner.rows }
  get process(): string { return 'ssh' }
  get handleFlowControl(): boolean { return false }
  set handleFlowControl(_v: boolean) { /* not used */ }
  get onData(): IEvent<string> { return this.data.event }
  get onExit(): IEvent<{ exitCode: number; signal?: number }> { return this.inner.onExit }
  /** The bridge exec's ssh process now, when there is one. */
  get linkPid(): number | undefined { return this.driver.linkPid }
  /** Settles once the session is over and its holder ended. */
  get ended(): Promise<void> { return this.inner.ended }
  get throughHelper(): boolean { return this.inner.throughHelper }

  write(data: string | Buffer): void {
    this.inner.write(data)
  }

  resize(cols: number, rows: number): void { this.inner.resize(cols, rows) }
  clear(): void { this.inner.clear() }
  pause(): void { this.inner.pause() }
  resume(): void { this.inner.resume() }

  kill(signal?: string): void {
    this.driver.closed = true
    this.inner.kill(signal)
  }
}
