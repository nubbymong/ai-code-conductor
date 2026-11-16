/**
 * A terminal carried by a session helper holder, shaped as node-pty's IPty so
 * the PTY manager uses it exactly as it uses a terminal of its own.
 *
 * pty.spawn answers at once, so this does too: the holder is started, the
 * program launched in it and the terminal attached in the background, and
 * what the tab types or a resize asks for meanwhile waits. When the helper
 * cannot carry this terminal (it is not installed, its copy fails the hash
 * check, the holder refuses the launch), the terminal starts the usual way
 * instead, through the same object, so the tab never notices.
 *
 * Two ways in:
 *  - launch: a new holder for a new terminal;
 *  - adopt: a holder that outlived the app (a crash), whose terminal the
 *    restored tab shows again, its scrollback first.
 */
import type { IDisposable, IEvent, IPty } from 'node-pty'
import { StringDecoder } from 'string_decoder'
import type { HolderConnection } from './connection'
import { LAUNCH_LIMITS, type HolderRecord, type LaunchSpec } from './protocol'

export interface HelperPtyDriver {
  /** Start a holder for `sid` and answer its record. Throws when the helper
   *  cannot be used for it now (nothing was started through it then). */
  hold(sid: string, label: string): Promise<HolderRecord>
  /** Open a checked connection to a holder. */
  connect(record: HolderRecord): Promise<HolderConnection>
  /** The terminal the usual way: node-pty with the spawn's own arguments. */
  direct(): IPty
  /** This terminal is ending; the next holder for the same session waits for it. */
  ending(sid: string, done: Promise<void>): void
  /** This terminal is attached to its tab, or no longer is. */
  attachedChanged(sid: string, attached: boolean): void
  log(message: string): void
}

export interface HelperPtyOptions {
  sid: string
  label: string
  spec: LaunchSpec
  /** Set to adopt this holder instead of starting one. */
  adopt?: HolderRecord
  driver: HelperPtyDriver
}

/** An exit code for a terminal whose holder could no longer be reached. */
export const LOST_EXIT_CODE = -1
/** Input kept while the terminal is still being attached. */
const QUEUE_MAX_BYTES = 1024 * 1024
/** Attaches again after the holder said this connection fell behind. */
const REATTACH_TRIES = 3

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

export class HelperPty implements IPty {
  readonly sid: string
  readonly label: string
  /** True when this terminal took over a holder that outlived the app. */
  readonly adopted: boolean
  handleFlowControl = false

  private readonly spec: LaunchSpec
  private readonly driver: HelperPtyDriver
  private readonly dataEmitter = new Emitter<string>()
  private readonly exitEmitter = new Emitter<{ exitCode: number; signal?: number }>()
  private decoder = new StringDecoder('utf8')
  private record: HolderRecord | undefined
  private conn: HolderConnection | undefined
  private inner: IPty | undefined
  private childPid = 0
  private size: { cols: number; rows: number }
  private queued: Buffer[] = []
  private queuedBytes = 0
  private sizeChanged = false
  private attached = false
  private everAttached = false
  private exited = false
  private ending = false
  /** Ring offset of the next output byte, for an attach again. */
  private offset = 0
  private reattaches = 0
  private resolveEnded!: () => void
  /** Settles once this terminal is over and its holder ended. */
  readonly ended: Promise<void>
  private resolveAdoption!: (held: boolean) => void
  /** What `adoption` settled to, once it has (read synchronously). */
  adoptionKnown: boolean | undefined
  /**
   * Whether this terminal shows a held one: true once the take-over attached
   * (or the terminal is over, so there is nothing to type into), false when
   * it was never one or the take-over failed and a new shell started the usual
   * way. The tab's launch lines wait for it, so a failed take-over still gets
   * its folder and first-run command.
   */
  readonly adoption: Promise<boolean>

  constructor(opts: HelperPtyOptions) {
    this.sid = opts.sid
    this.label = opts.label
    this.spec = opts.spec
    this.driver = opts.driver
    this.adopted = !!opts.adopt
    this.record = opts.adopt
    this.size = { cols: opts.spec.cols, rows: opts.spec.rows }
    this.ended = new Promise<void>((r) => { this.resolveEnded = r })
    this.adoption = new Promise<boolean>((r) => {
      this.resolveAdoption = (held) => {
        if (this.adoptionKnown !== undefined) return
        this.adoptionKnown = held
        r(held)
      }
    })
    if (!opts.adopt) this.resolveAdoption(false)
    void (opts.adopt ? this.runAdopt(opts.adopt) : this.runLaunch())
  }

  // ── IPty ───────────────────────────────────────────────────────────────────

  get pid(): number {
    if (this.inner) return this.inner.pid
    return this.childPid || this.record?.pid || 0
  }
  get cols(): number { return this.inner ? this.inner.cols : this.size.cols }
  get rows(): number { return this.inner ? this.inner.rows : this.size.rows }
  get process(): string { return this.inner ? this.inner.process : (this.spec.argv[0] ?? '') }
  get onData(): IEvent<string> { return this.dataEmitter.event }
  get onExit(): IEvent<{ exitCode: number; signal?: number }> { return this.exitEmitter.event }

  /** True while the terminal goes through a holder (not the usual way). */
  get throughHelper(): boolean { return !this.inner }
  get isAttached(): boolean { return this.attached && !this.exited }

  write(data: string | Buffer): void {
    if (this.exited) return
    if (this.inner) { this.inner.write(data); return }
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    if (this.attached && this.conn && !this.conn.isClosed) { this.conn.sendInput(bytes); return }
    if (this.queuedBytes + bytes.length > QUEUE_MAX_BYTES) return
    this.queued.push(bytes)
    this.queuedBytes += bytes.length
  }

  resize(cols: number, rows: number): void {
    if (this.inner) { this.inner.resize(cols, rows); return }
    const c = Math.max(1, Math.min(LAUNCH_LIMITS.termCells, Math.floor(cols)))
    const r = Math.max(1, Math.min(LAUNCH_LIMITS.termCells, Math.floor(rows)))
    if (!Number.isFinite(c) || !Number.isFinite(r)) return
    this.size = { cols: c, rows: r }
    if (this.attached && this.conn) this.sendResize()
    else this.sizeChanged = true
  }

  clear(): void { this.inner?.clear() }
  pause(): void { this.inner?.pause() }
  resume(): void { this.inner?.resume() }

  /** Ends the terminal: the holder ends the program's whole tree and exits. */
  kill(signal?: string): void {
    if (this.inner) { this.inner.kill(signal); return }
    if (this.ending) return
    this.ending = true
    this.driver.ending(this.sid, this.ended)
    // Before the holder is up, the start-up below sees `ending` and ends it.
    if (this.conn && !this.conn.isClosed) void this.endHolder(null)
  }

  // ── the ways in ────────────────────────────────────────────────────────────

  private async runLaunch(): Promise<void> {
    let record: HolderRecord
    try {
      record = await this.driver.hold(this.sid, this.label)
    } catch (err) {
      this.fallBack(`the helper could not hold it: ${(err as Error).message}`)
      return
    }
    this.record = record
    let conn: HolderConnection
    try {
      conn = await this.driver.connect(record)
    } catch (err) {
      this.fallBack(`the holder could not be reached: ${(err as Error).message}`, record)
      return
    }
    this.useConnection(conn)
    if (this.ending) { void this.endHolder(null); return }
    try {
      const launched = await conn.request({
        t: 'term.launch',
        argv: this.spec.argv,
        cwd: this.spec.cwd,
        env: this.spec.env,
        cols: this.size.cols,
        rows: this.size.rows,
      })
      if (typeof launched.pid === 'number') this.childPid = launched.pid
    } catch (err) {
      this.fallBack(`the holder refused the launch: ${(err as Error).message}`, record, conn)
      return
    }
    if (this.ending) return
    this.sizeChanged = false
    await this.attach(conn, 0, false)
  }

  private async runAdopt(record: HolderRecord): Promise<void> {
    let conn: HolderConnection
    try {
      conn = await this.driver.connect(record)
    } catch (err) {
      this.fallBack(`the held terminal could not be reached: ${(err as Error).message}`)
      return
    }
    this.useConnection(conn)
    if (this.ending) { void this.endHolder(null); return }
    // Typed before the terminal came back: meant for a new shell, not this one.
    this.queued = []
    this.queuedBytes = 0
    this.sizeChanged = true
    await this.attach(conn, 0, true)
  }

  private async attach(conn: HolderConnection, from: number, fallBackOnFail: boolean): Promise<void> {
    let received = 0
    const counter = (b: Buffer) => { received += b.length }
    conn.on('output', counter)
    let reply: Record<string, unknown>
    try {
      reply = await conn.request({ t: 'term.attach', from })
    } catch (err) {
      conn.off('output', counter)
      if (fallBackOnFail) this.fallBack(`the held terminal could not be attached: ${(err as Error).message}`, undefined, conn)
      else this.lost(`the terminal could not be attached: ${(err as Error).message}`)
      return
    }
    conn.off('output', counter)
    if (this.ending || this.exited) return
    const start = typeof reply.from === 'number' ? reply.from : from
    this.offset = start + received
    this.attached = true
    this.everAttached = true
    this.resolveAdoption(true)
    this.driver.attachedChanged(this.sid, true)
    if (reply.running === false) {
      // Over before this attach: the replay follows the reply, then nothing.
      const end = typeof reply.ring_end === 'number' ? reply.ring_end : this.offset
      const code = typeof reply.code === 'number' ? reply.code : 0
      this.exitAfterReplay(end, code)
      return
    }
    if (this.sizeChanged) this.sendResize()
    const queued = this.queued
    this.queued = []
    this.queuedBytes = 0
    for (const b of queued) conn.sendInput(b)
  }

  // ── the connection ─────────────────────────────────────────────────────────

  private useConnection(conn: HolderConnection): void {
    this.conn = conn
    conn.on('output', (bytes: Buffer) => {
      if (this.conn !== conn) return
      this.offset += bytes.length
      const text = this.decoder.write(bytes)
      if (text) this.dataEmitter.fire(text)
    })
    conn.on('exit', (code: number | null) => {
      if (this.conn !== conn) return
      this.finish(code ?? 0)
      void this.endHolder(code)
    })
    conn.on('notice', (code: string, text: string) => {
      if (this.conn !== conn) return
      if (code === 'busy' && !this.ending && this.reattaches < REATTACH_TRIES) {
        this.reattaches++
        this.driver.log(`[session-helper] ${this.sid}: ${text}; attaching again from ${this.offset}`)
        void this.reconnect()
        return
      }
      this.driver.log(`[session-helper] ${this.sid}: the holder said ${code}: ${text}`)
    })
    conn.on('close', () => {
      if (this.conn !== conn) return
      this.setDetached()
      if (this.ending || this.exited) { this.resolveEnded(); return }
      // Before the first attach a request is always waiting, and its
      // failure decides what happens (the usual way, or an end).
      if (this.reconnecting || !this.everAttached) return
      this.lost('the holder closed the connection')
    })
  }

  private reconnecting = false

  private async reconnect(): Promise<void> {
    const record = this.record
    if (!record) return
    this.reconnecting = true
    this.setDetached()
    try {
      const conn = await this.driver.connect(record)
      this.reconnecting = false
      this.useConnection(conn)
      this.decoder = new StringDecoder('utf8')
      await this.attach(conn, this.offset, false)
    } catch (err) {
      this.reconnecting = false
      this.lost(`the terminal could not be attached again: ${(err as Error).message}`)
    }
  }

  private sendResize(): void {
    this.sizeChanged = false
    const conn = this.conn
    if (!conn) return
    conn.request({ t: 'term.resize', cols: this.size.cols, rows: this.size.rows }).catch(() => { /* the next resize tries again */ })
  }

  private setDetached(): void {
    if (!this.attached) return
    this.attached = false
    this.driver.attachedChanged(this.sid, false)
  }

  /** The program ended while no tab showed it: show what it wrote, then end its holder. */
  private exitAfterReplay(end: number, code: number): void {
    let done = false
    const over = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      void this.endHolder(code)
    }
    const timer = setTimeout(over, 500)
    const check = () => { if (this.offset >= end) over() }
    this.conn?.on('output', check)
    check()
  }

  private async endHolder(code: number | null): Promise<void> {
    const conn = this.conn
    if (!this.ending) {
      this.ending = true
      this.driver.ending(this.sid, this.ended)
    }
    let ended = code
    if (conn && !conn.isClosed) {
      try {
        const reply = await conn.request({ t: 'term.end' })
        if (typeof reply.code === 'number') ended = reply.code
      } catch { /* the holder is gone already */ }
      conn.close()
    }
    this.finish(ended ?? 0)
    this.resolveEnded()
  }

  /** The usual way after all: node-pty, with what was queued for the holder. */
  private fallBack(why: string, record?: HolderRecord, conn?: HolderConnection): void {
    if (this.exited) return
    this.driver.log(`[session-helper] ${this.sid}: starting it the usual way, because ${why}`)
    if (conn) {
      conn.request({ t: 'term.end' }).catch(() => { /* gone */ }).finally(() => conn.close())
    } else if (record) {
      this.driver.connect(record).then((c) => c.request({ t: 'term.end' }).finally(() => c.close())).catch(() => { /* gone */ })
    }
    this.conn = undefined
    this.setDetached()
    // A new shell from here on: the tab's launch lines are for it.
    this.resolveAdoption(false)
    if (this.ending) { this.finish(0); this.resolveEnded(); return }
    let inner: IPty
    try {
      inner = this.driver.direct()
    } catch (err) {
      this.driver.log(`[session-helper] ${this.sid}: the usual start failed too: ${(err as Error).message}`)
      this.finish(LOST_EXIT_CODE)
      this.resolveEnded()
      return
    }
    this.inner = inner
    inner.onData((d) => this.dataEmitter.fire(d))
    inner.onExit((e) => { this.finish(e.exitCode, e.signal); this.resolveEnded() })
    if (this.sizeChanged) inner.resize(this.size.cols, this.size.rows)
    const queued = this.queued
    this.queued = []
    this.queuedBytes = 0
    for (const b of queued) inner.write(b.toString('utf8'))
  }

  private lost(why: string): void {
    if (this.exited) return
    this.driver.log(`[session-helper] ${this.sid}: ${why}`)
    this.finish(LOST_EXIT_CODE)
    this.resolveEnded()
  }

  private finish(exitCode: number, signal?: number): void {
    if (this.exited) return
    this.exited = true
    this.resolveAdoption(true)
    this.setDetached()
    const rest = this.decoder.end()
    if (rest) this.dataEmitter.fire(rest)
    this.exitEmitter.fire(signal === undefined ? { exitCode } : { exitCode, signal })
  }
}
