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
 * (`<shell> -il -c 'exec "$0" "$@"' <claude> <args>`, ADR-030 D8), values as
 * arguments, so what the user's rc files set reaches the CLI as on the usual
 * path; the `-il` PATH is the one the machine's record keeps. Nothing goes to
 * the host for it: no Claude token, MCP config, hooks file or status shim.
 *
 * A dropped link (the ssh child ended, or a pong that never came) attaches
 * again from the last byte seen, with the holder's replay: HelperPty asks for
 * a new connection, and this driver tries a new bridge exec with section 11's
 * back-off (1, 2, 4, 8, 16, 32, 32 s) within the holder's two-minute away
 * clock, never after a sign-in or host key failure, a hash mismatch, or a
 * bridge that finds no holder. A closed tab or a quit ends the session
 * (`term.end`), as a plain SSH session ends then (D13); a tab closed just as
 * its link drops sends its end once more, over a link of its own.
 *
 * What such a tab does not have in this preview: the status line and usage,
 * the app's tools (canvas, vision, the image fetch tool an SSH tab uses for
 * Snap and paste), hook events (attention, Watchdog). An image paste, Snap or
 * screenshot storyboard types nothing: the app's own request for the image
 * fetch tool is held back whole at the write door, before it is sliced
 * (holdBackRemoteImage, ./index.ts; the screenshot menu sends one such request
 * in place of its storyboard), and the tab shows a note instead
 * (heldBackImage). Prompt buttons and broadcast type into it by the usual rule
 * for a Claude Code tab.
 *
 * This file imports nothing of Electron.
 */
import { createHash } from 'crypto'
import type { IDisposable, IEvent, IPty } from 'node-pty'
import { HolderConnection, HolderError } from '../session-helper/connection'
import { HelperPty, NothingStartedError, type HelperPtyDriver } from '../session-helper/helper-pty'
import { checkLaunch, readListing, readRecord, type HolderRecord, type LaunchSpec } from '../session-helper/protocol'
import { holderLabel } from './scripts'
import { afterHashLine, newNonce, openScriptStream, readHashLine, runScript, sshFailure, type SshRunner, type SshTarget } from './ssh-exec'
import type { RemoteMachineRecord } from './machines'

/** The helper's session id for a remote tab: always the same for the same app
 *  id, never one a local terminal or agent session gets (`rm` and 30 hex). */
export function remoteSessionId(appPtyId: string): string {
  return `rm${createHash('sha256').update(`aicc-remote-session\0${appPtyId}`, 'utf8').digest('hex').slice(0, 30)}`
}

/** Section 11's back-off for a dropped link, within the two-minute away clock. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 32000, 32000]
/** How long a bridge exec may take to pass its hash line, and the hello after it. */
export const BRIDGE_OPEN_MS = 30_000
export const BRIDGE_HELLO_MS = 20_000

/** The tool name the app's own image route asks an SSH tab's CLI to call
 *  (renderer/utils/imageTransfer.ts): a tab through the helper has no such
 *  tool in this preview. */
export const HOST_IMAGE_TOOL = 'mcp__conductor__fetch_host_screenshot'
export const IMAGE_HELD_BACK_NOTE = '\r\n[Images do not reach a session through the session helper yet (remote preview), so nothing was typed. Turn the remote sessions switch off in Settings to paste images over SSH.]\r\n'

/** The folder a session starts in: the config's remote path made absolute
 *  against the host's home (`~`, `~/x`, a relative path), else the home. */
export function remoteCwd(remotePath: string | undefined, home: string): string {
  const p = (remotePath ?? '').trim()
  if (!p || p === '~') return home
  if (p.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${p.slice(2)}`
  if (p.startsWith('/')) return p
  return `${home.replace(/\/+$/, '')}/${p}`
}

/** What the CLI is started with on the host. */
export function remoteLaunchSpec(m: RemoteMachineRecord, cliArgs: readonly string[], cliEnv: Record<string, string>, remotePath: string | undefined, cols: number, rows: number): LaunchSpec {
  const claude = m.claudePath ?? '/usr/local/bin/claude'
  const argv = m.shellIsSh ? [m.shell, '-il', '-c', 'exec "$0" "$@"', claude, ...cliArgs] : [claude, ...cliArgs]
  const env: Record<string, string> = {
    HOME: m.home, USER: m.user, LOGNAME: m.user, SHELL: m.shell, PATH: m.path,
    LANG: m.lang ?? 'C.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor',
    ...cliEnv,
  }
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
  private why = ''
  private readonly connected = new Set<string>()
  private readonly target: SshTarget
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly o: RemoteSessionOptions) {
    this.target = { host: o.machine.host, port: o.machine.port, user: o.machine.user }
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  private values(nonce: string, ...rest: string[]): string[] {
    const m = this.o.machine
    return [nonce, m.did, this.o.installId, m.helper.folder, m.helper.sha256, ...rest]
  }

  private failWith(why: string): never {
    this.why = why
    throw new Error(why)
  }

  async hold(sid: string, label: string, abandoned: () => boolean): Promise<HolderRecord> {
    await afterEnding(sid)
    const host = this.o.machine.host
    for (let attempt = 0; attempt < 2; attempt++) {
      if (abandoned()) throw new NothingStartedError('the tab was closed while it started')
      const nonce = newNonce()
      const r = await runScript(this.o.runner, this.target, 'hold', this.values(nonce, sid, holderLabel(label)))
      const failed = sshFailure(r)
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
        const conn = await this.connectOnce(record)
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
   * A tab closed just as its link dropped: HelperPty sends the end over the
   * connection it still has, and the link takes it down with it (the
   * connection closes before the holder answers, so the holder never got it,
   * or ended and could not say so). Such an end goes once more, over a link of
   * its own; a holder already gone answers that with a bridge exit 3, and the
   * end is done. Any other request fails as it did.
   */
  private endOnceMore(conn: HolderConnection, record: HolderRecord): void {
    const request = conn.request.bind(conn)
    conn.request = async (msg, onReply) => {
      try {
        return await request(msg, onReply)
      } catch (err) {
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

  /** One bridge exec, and the holder's hello over it. */
  private async connectOnce(record: HolderRecord, endAgain = true): Promise<HolderConnection> {
    const nonce = newNonce()
    let opened: Awaited<ReturnType<typeof openScriptStream>>
    try {
      opened = await openScriptStream(this.o.runner, this.target, 'bridge', this.values(nonce, record.session), nonce, BRIDGE_OPEN_MS)
    } catch (err) {
      const e = err as Error & { final?: boolean }
      throw e.final ? new FinalError(e.message) : e
    }
    this.linkPid = opened.pid
    try {
      const conn = await HolderConnection.open({
        record,
        os: 'unix',
        // The endpoint is on the host: the bridge, as this user there, connects to it.
        checkEndpointFolder: () => null,
        openStream: async () => opened.stream,
        helloTimeoutMs: BRIDGE_HELLO_MS,
      })
      if (endAgain) this.endOnceMore(conn, record)
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
    endings.set(sid, done)
    void done.finally(() => { if (endings.get(sid) === done) endings.delete(sid) })
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
    if (heldBackImage(data)) { this.holdBackImage(); return }
    this.inner.write(data)
  }

  /** The app's own image request was held back: nothing typed, and the tab
   *  says why. The write door holds a whole request back before it is sliced
   *  (holdBackRemoteImage, ./index.ts); write() above catches one that comes
   *  another way. */
  holdBackImage(): void {
    this.driver.log(`[remote-helper] ${this.sid}: an image was not typed (the tab has no image fetch tool in this preview)`)
    this.data.fire(IMAGE_HELD_BACK_NOTE)
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

/** The app's own request for the host image tool, which a tab through the
 *  helper does not have: held back (RemoteHelperPty.write). */
export function heldBackImage(data: string | Buffer): boolean {
  const text = typeof data === 'string' ? data : data.toString('utf8')
  return text.includes(HOST_IMAGE_TOOL)
}
