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
 *
 * A connection that drops while the terminal runs (the holder closes one that
 * fell behind its output, section 15) is attached again from the last byte
 * seen, a few times a minute at most. A terminal that cannot be shown any more
 * reads as ended in its tab, and its holder is ended too, so no shell outlives
 * its tab, unless another connection took it over.
 */
import type { IDisposable, IEvent, IPty } from 'node-pty'
import { StringDecoder } from 'string_decoder'
import type { HolderConnection } from './connection'
import { LAUNCH_LIMITS, type HolderRecord, type LaunchSpec } from './protocol'
import { stripSpoofableText } from '../../shared/safe-text'
import { PTY_IO_FAILED_GRACE_MS, PTY_IO_FAILED_TEXT, guardPtyIo } from '../pty-input-guard'

export interface HelperPtyDriver {
  /** Start a holder for `sid` and answer its record. Throws when the helper
   *  cannot be used for it now (nothing was started through it then).
   *  `abandoned` is true once this terminal no longer wants starting (it was
   *  ended meanwhile): then no holder may be started for it. */
  hold(sid: string, label: string, abandoned: () => boolean): Promise<HolderRecord>
  /** Open a checked connection to a holder. */
  connect(record: HolderRecord): Promise<HolderConnection>
  /** The terminal the usual way: node-pty with the spawn's own arguments. */
  direct(): IPty
  /** This terminal is ending; the next holder for the same session waits for it. */
  ending(sid: string, done: Promise<void>): void
  /** This terminal is attached to its tab, or no longer is. */
  attachedChanged(sid: string, attached: boolean): void
  log(message: string): void
  /** The clock for the attach-again budget. */
  now?: () => number
}

/**
 * What a driver's hold throws when nothing may start for this terminal, not
 * through a holder and not the usual way either: it was ended while it
 * waited, or a holder its session had before still runs and could not be
 * ended. The terminal then logs that nothing was started, never that it
 * starts the usual way.
 */
export class NothingStartedError extends Error {
  constructor(why: string) {
    super(why)
    this.name = 'NothingStartedError'
  }
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
/** Input kept while the terminal is first being attached. */
const QUEUE_MAX_BYTES = 1024 * 1024
/** Attaches again after a connection dropped: at most this many in REATTACH_WINDOW_MS. */
export const REATTACH_TRIES = 3
export const REATTACH_WINDOW_MS = 60_000
/** How long an end the app sends of its own accord may take. */
const END_WAIT_MS = 3_000

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

type AttachMode = 'launch' | 'adopt' | 'again'

export class HelperPty implements IPty {
  readonly sid: string
  readonly label: string
  handleFlowControl = false

  private readonly spec: LaunchSpec
  private readonly driver: HelperPtyDriver
  private readonly dataEmitter = new Emitter<string>()
  private readonly exitEmitter = new Emitter<{ exitCode: number; signal?: number }>()
  /** One decoder for the whole output, across attaches again, so a character
   *  split at the cut is still whole. */
  private readonly decoder = new StringDecoder('utf8')
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
  /** A term.attach waits for its reply: its failure decides what happens. */
  private attaching = false
  private reconnecting = false
  private exited = false
  private ending = false
  /** The holder's end was sent (or tried) once already. */
  private endStarted = false
  /** Another connection took this terminal (`replaced`): it is theirs now. */
  private replaced = false
  /** Ring offset of the next output byte, for an attach again. */
  private offset = 0
  private reattachTimes: number[] = []
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
  /** The holder's record, once there is one. */
  get heldRecord(): HolderRecord | undefined { return this.inner ? undefined : this.record }

  write(data: string | Buffer): void {
    if (this.exited) return
    if (this.inner) { this.inner.write(data); return }
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    if (this.attached && this.conn && !this.conn.isClosed) { this.conn.sendInput(bytes); return }
    // Before the first attach the shell is not even there yet, so a runaway
    // paste is cut short. Once attached, nothing typed is dropped: a gap in
    // the input would reach the program.
    if (!this.everAttached && this.queuedBytes + bytes.length > QUEUE_MAX_BYTES) return
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
    if (this.ending || this.exited) return
    this.markEnding()
    // Up: ended now. Still starting, or attaching again: the step that brings
    // the holder up sees `ending` and ends it.
    if (this.conn && !this.conn.isClosed) void this.endHolder(null)
  }

  // ── the ways in ────────────────────────────────────────────────────────────

  private async runLaunch(): Promise<void> {
    let record: HolderRecord
    try {
      record = await this.driver.hold(this.sid, this.label, () => this.ending || this.exited)
    } catch (err) {
      if (err instanceof NothingStartedError) this.fallBack(err.message, undefined, undefined, true)
      else this.fallBack(`the helper could not hold it: ${(err as Error).message}`)
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
    const sent = { ...this.size }
    try {
      const launched = await conn.request({
        t: 'term.launch',
        argv: this.spec.argv,
        cwd: this.spec.cwd,
        env: this.spec.env,
        cols: sent.cols,
        rows: sent.rows,
        // The Windows fields, only when the spec gives them: a launch without
        // them is the same frame as before they existed.
        ...(this.spec.line !== undefined ? { line: this.spec.line } : {}),
        ...(this.spec.conpty !== undefined ? { conpty: this.spec.conpty } : {}),
      })
      if (typeof launched.pid === 'number') this.childPid = launched.pid
    } catch (err) {
      this.fallBack(`the holder refused the launch: ${(err as Error).message}`, record, conn)
      return
    }
    // A kill meanwhile sent the end already.
    if (this.ending || this.exited) return
    // A resize while the launch was on its way is sent once attached.
    this.sizeChanged = this.size.cols !== sent.cols || this.size.rows !== sent.rows
    await this.attach(conn, 0, 'launch')
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
    await this.attach(conn, 0, 'adopt')
  }

  private async attach(conn: HolderConnection, from: number, mode: AttachMode): Promise<void> {
    this.attaching = true
    let reply: Record<string, unknown>
    try {
      reply = await conn.request({ t: 'term.attach', from }, (m) => {
        // Before the replay that follows the reply: the offset starts where
        // the holder starts, and a cut (the ring no longer holds `from`) ends
        // a character split there.
        const start = typeof m.from === 'number' ? m.from : from
        if (start !== from) this.flushDecoder()
        this.offset = start
      })
    } catch (err) {
      this.attaching = false
      const why = (err as Error).message
      if (this.exited) return
      if (this.ending) { if (!this.endStarted) void this.endHolder(null); return }
      if (mode === 'adopt') { this.fallBack(`the held terminal could not be attached: ${why}`, undefined, conn); return }
      // The connection dropped under the attach: tried again (within the budget).
      if (conn.isClosed && !this.replaced) { void this.reconnect('the connection closed while it attached'); return }
      this.giveUp(`the terminal could not be attached${mode === 'again' ? ' again' : ''}: ${why}`)
      return
    }
    this.attaching = false
    if (this.exited) return
    if (this.ending) { if (!this.endStarted) void this.endHolder(null); return }
    if (conn.isClosed) {
      // It closed right after its reply: what the close found waiting is decided here.
      if (this.replaced) this.giveUp('another connection took this terminal', false)
      else void this.reconnect('the connection closed')
      return
    }
    this.attached = true
    this.everAttached = true
    this.resolveAdoption(true)
    this.driver.attachedChanged(this.sid, true)
    if (reply.running === false) {
      // Over before this attach: the replay follows the reply, then nothing.
      const end = typeof reply.ring_end === 'number' ? reply.ring_end : this.offset
      const code = typeof reply.code === 'number' ? reply.code : 0
      this.exitAfterReplay(conn, end, code)
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
      if (this.conn !== conn || this.exited) return
      this.offset += bytes.length
      const text = this.decoder.write(bytes)
      if (text) this.dataEmitter.fire(text)
    })
    conn.on('exit', (code: number | null) => {
      if (this.conn !== conn || this.exited) return
      this.finish(code ?? 0)
      void this.endHolder(code)
    })
    conn.on('notice', (code: string, text: string) => {
      if (this.conn !== conn) return
      if (code === 'replaced') {
        this.replaced = true
        this.driver.log(`[session-helper] ${this.sid}: another connection took this terminal`)
        return
      }
      // Typed input the program did not take: the connection sends it again.
      // Or this connection fell behind its output: the close comes next.
      if (code === 'busy') return
      this.driver.log(`[session-helper] ${this.sid}: the holder said ${code}: ${text}`)
    })
    conn.on('close', () => {
      if (this.conn !== conn) return
      this.setDetached()
      if (this.exited) return
      if (this.ending) { if (!this.endStarted) void this.endHolder(null); return }
      // A request waiting on this connection decides what happens (the usual
      // way, an attach again, or an end).
      if (this.attaching || !this.everAttached) return
      if (this.replaced) { this.giveUp('another connection took this terminal', false); return }
      void this.reconnect(conn.closedAfterBusy ? 'the connection fell behind its output' : 'the connection closed')
    })
  }

  /** Attach again on a new connection, from the last byte seen. */
  private async reconnect(why: string): Promise<void> {
    const record = this.record
    const old = this.conn
    const now = this.driver.now?.() ?? Date.now()
    this.reattachTimes = this.reattachTimes.filter((t) => now - t < REATTACH_WINDOW_MS)
    if (!record || this.reattachTimes.length >= REATTACH_TRIES) {
      this.giveUp(`${why}, and it was attached again ${REATTACH_TRIES} times within a minute`)
      return
    }
    this.reattachTimes.push(now)
    this.driver.log(`[session-helper] ${this.sid}: ${why}; attaching again from ${this.offset}`)
    this.reconnecting = true
    this.setDetached()
    // Typed and never sent goes first on the new connection; sent and not yet
    // answered for is not sent twice (section 15: the replay shows what the
    // program got).
    const carried = old ? old.takeUnsent() : []
    if (carried.length > 0) {
      this.queued = [...carried, ...this.queued]
      this.queuedBytes += carried.reduce((n, b) => n + b.length, 0)
    }
    let conn: HolderConnection
    try {
      conn = await this.driver.connect(record)
    } catch (err) {
      this.reconnecting = false
      this.giveUp(`the terminal could not be attached again: ${(err as Error).message}`)
      return
    }
    this.reconnecting = false
    if (this.exited) { conn.close(); return }
    this.useConnection(conn)
    if (this.ending) { void this.endHolder(null); return }
    await this.attach(conn, this.offset, 'again')
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
  private exitAfterReplay(conn: HolderConnection, end: number, code: number): void {
    let done = false
    const over = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      conn.off('output', check)
      void this.endHolder(code)
    }
    const timer = setTimeout(over, 500)
    const check = () => { if (this.offset >= end) over() }
    conn.on('output', check)
    check()
  }

  private markEnding(): void {
    if (this.ending) return
    this.ending = true
    this.driver.ending(this.sid, this.ended)
  }

  /** End the holder (its program's whole tree), then report the exit. */
  private async endHolder(code: number | null): Promise<void> {
    this.markEnding()
    if (this.endStarted) return
    this.endStarted = true
    const conn = this.conn
    const said = await this.sendEnd(conn)
    conn?.close()
    this.finish(said ?? code ?? 0)
    this.resolveEnded()
  }

  /**
   * Send the holder its end over `conn`, or over a connection of its own when
   * that one is gone. Answers the code the holder reported; null when it did
   * not answer within END_WAIT_MS (it is gone, or it ends by its away clock).
   */
  private async sendEnd(conn: HolderConnection | undefined): Promise<number | null> {
    const record = this.record
    const ask = async (): Promise<number | null> => {
      let c = conn && !conn.isClosed ? conn : undefined
      const own = !c
      if (!c) {
        if (!record) return null
        c = await this.driver.connect(record)
      }
      try {
        const reply = await c.request({ t: 'term.end' })
        return typeof reply.code === 'number' ? reply.code : null
      } finally {
        if (own) c.close()
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([ask(), new Promise<null>((r) => { timer = setTimeout(() => r(null), END_WAIT_MS) })])
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The terminal cannot be shown any more. The tab reads it as ended at once;
   * its holder is ended too (unless another connection took it), so no shell
   * outlives its tab, and `ended` settles once that is done.
   */
  private giveUp(why: string, endIt = true): void {
    if (this.exited) return
    this.driver.log(`[session-helper] ${this.sid}: ${why}`)
    this.markEnding()
    this.endStarted = true
    const conn = this.conn
    this.finish(LOST_EXIT_CODE)
    const done: Promise<unknown> = endIt ? this.sendEnd(conn) : Promise.resolve()
    void done.finally(() => {
      conn?.close()
      this.resolveEnded()
    })
  }

  /**
   * The usual way after all: node-pty, with what was queued for the holder.
   * `nothing` (a NothingStartedError): no program starts for this terminal;
   * `direct` then answers one that only says why (the driver's own), or, for
   * a terminal ended meanwhile, nothing is asked of it at all.
   */
  private fallBack(why: string, record?: HolderRecord, conn?: HolderConnection, nothing = false): void {
    if (this.exited) return
    this.driver.log(nothing || this.ending
      ? `[session-helper] ${this.sid}: nothing is started for this tab, because ${why}`
      : `[session-helper] ${this.sid}: starting it the usual way, because ${why}`)
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
    this.guardInner(inner)
    inner.onData((d) => this.dataEmitter.fire(d))
    inner.onExit((e) => { this.finish(e.exitCode, e.signal); this.resolveEnded() })
    if (this.sizeChanged) inner.resize(this.size.cols, this.size.rows)
    const queued = this.queued
    this.queued = []
    this.queuedBytes = 0
    for (const b of queued) inner.write(b.toString('utf8'))
  }

  /**
   * P3.15 for the usual-way terminal: a failed write to its input, or an
   * error on its output, never takes the app down (pty-input-guard.ts says
   * why each can happen, under node-pty's bundled ConPTY above all). The PTY
   * manager guards the terminal its spawn answered, which is this object, so
   * node-pty's own sockets, under the one made here, are guarded here. The
   * first failure of each side goes in the log; a terminal that has not
   * ended by itself PTY_IO_FAILED_GRACE_MS later is ended, with a line saying
   * why, as the PTY manager ends its own.
   */
  private guardInner(inner: IPty): void {
    let ending = false
    guardPtyIo(inner, (side, err) => {
      const what = stripSpoofableText(String(err?.code ?? err?.message ?? err), 120)
      this.driver.log(side === 'input'
        ? `[session-helper] ${this.sid}: input to the usual-way terminal failed (${what}); it takes no more input`
        : `[session-helper] ${this.sid}: output of the usual-way terminal failed (${what})`)
      if (ending) return
      ending = true
      const timer = setTimeout(() => {
        if (this.exited || this.inner !== inner) return
        this.driver.log(`[session-helper] ${this.sid}: it did not end within ${PTY_IO_FAILED_GRACE_MS} ms of its ${side} failing: ending it`)
        this.dataEmitter.fire(PTY_IO_FAILED_TEXT)
        try { inner.kill() } catch { /* already gone */ }
      }, PTY_IO_FAILED_GRACE_MS)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
  }

  private flushDecoder(): void {
    const rest = this.decoder.end()
    if (rest) this.dataEmitter.fire(rest)
  }

  private finish(exitCode: number, signal?: number): void {
    if (this.exited) return
    this.exited = true
    this.resolveAdoption(true)
    this.setDetached()
    this.flushDecoder()
    this.exitEmitter.fire(signal === undefined ? { exitCode } : { exitCode, signal })
  }
}
