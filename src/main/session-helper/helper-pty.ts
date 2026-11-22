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
 *
 * The holder keeps the last 2 MiB of output. An attach that asks for an
 * offset older than that is answered from the oldest byte it still holds
 * (`truncated`). The replay is then held until it is all in, over a dropped
 * connection too, and shown in one piece: first a line of the app's own
 * saying earlier output is not shown, then only the last of the replay that
 * the tab's scrollback keeps (TERMINAL_SCROLLBACK_LINES less a screen and that
 * line's own rows, replay-tail.ts), so that line stays within reach: 2 MiB of
 * plain text is some 28,000 lines, and a tab keeps 10,000. What the left-out
 * part changed in the terminal (the alternate screen left, the input modes) is
 * carried across the cut. Once the replay is shown, a program still running is
 * asked to redraw by a resize one row shorter and back (2.1.3-beta.12, plan
 * section A1; probe P19). The view is not cleared and the terminal not reset:
 * shown again, the tab's terminal keeps the modes its program set.
 *
 * A Windows console's output is right only at the size it was made for, and a
 * restored tab's first size can differ for a moment from the one it settles
 * at (2.1.3-beta.13, plan section A1, aicc_planning#374). So a take-over
 * whose holder offers the screen reads asks the holder's size first
 * (`screen.read`), and while the program runs its replay, cut or whole, is
 * held until it is all in and the tab is at that size, or until the size
 * wait's own cap (SIZE_WAIT_MAX_MS); meanwhile the tab's size is not sent,
 * so the holder never redraws for a size the tab only passes through. A
 * whole replay is shown as it is, with no notice. A holder without the
 * screen reads, a read that fails and a program that is over are shown as
 * before, with no wait for the size. A replay after a gap shown with the tab
 * at its holder's size (that of a program that is over too, when the tab
 * started at that size), and nothing shown before it, has its rows counted
 * with the cursor's row followed (2.1.3-beta.13, plan section A2): a
 * console's wrapped line counts the 3 rows the tab gives it, not 5, so the
 * tab is shown about as much of it as it keeps, and what is shown starts on
 * the tab's last row, where the count has the console's cursor.
 *
 * A take-over's replay was shown already, by the app that ran before, up to
 * where that app stopped, and its tab answered the terminal queries in it
 * then (a program asking the terminal where its cursor is, what it is, or its
 * colours); a query written after that app stopped had no terminal to answer
 * it, and its program's wait for one is long over. So the replay, up to the
 * attach's ring_end, loses each of them (replay-queries.ts), and neither the
 * tab nor main's colour answer answers them into a program that no longer
 * waits (2.1.3-beta.13, plan section A3, aicc_planning#360). A query cut by
 * ring_end is finished by the live output after it, and answered once. A
 * launch's output and an attach again's replay were never shown, and a
 * program may still wait for those answers: they go to the tab untouched.
 */
import type { IDisposable, IEvent, IPty } from 'node-pty'
import { StringDecoder } from 'string_decoder'
import type { HolderConnection } from './connection'
import { LAUNCH_LIMITS, type HolderRecord, type LaunchSpec } from './protocol'
import { stripSpoofableText } from '../../shared/safe-text'
import { TERMINAL_SCROLLBACK_LINES } from '../../shared/terminal-scrollback'
import { replayTail, rowsOf } from './replay-tail'
import { ReplayQueryFilter } from './replay-queries'
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
  /** The holder launched the program, on `conn`, and nothing typed has
   *  reached it yet (the tab's input waits for the attach that follows): the
   *  last moment what the launch line starts reads may change. */
  launched?(conn: HolderConnection): void
  /** What the launch on `conn` starts, its hello read, when it is not the
   *  spec's own: the same program with other arguments (2.1.3-beta.11, plan
   *  section B2: an agent session whose launch names its tool server, which
   *  then goes through its holder). Undefined: the spec's. Only for this
   *  launch: the usual way keeps the spawn's own arguments. */
  launchArgs?(conn: HolderConnection): Pick<LaunchSpec, 'argv' | 'line'> | undefined
  log(message: string): void
  /** The clock for the attach-again budget, and for the time a take-over's
   *  tab took to reach its holder's size (logged). */
  now?: () => number
  /** False: a failed input or output of the usual-way terminal (fallBack) is
   *  logged and nothing more, and the terminal is not ended PTY_IO_FAILED_GRACE_MS
   *  later. For a terminal whose owner settles it its own way and was never
   *  ended for such a failure (a run of the app's own: Insights' report ends
   *  when report.html is written or at its time limit, and an output failure
   *  alone did not stop it on node-pty). Absent or true: ended, as a tab's is. */
  endsOnIoFailure?: boolean
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
/** The line a terminal shown again from the middle of its output starts
 *  with, in the shape of the app's other words in a terminal
 *  (PTY_IO_FAILED_TEXT). */
const EARLIER_OUTPUT_NOT_SHOWN = '[Earlier output of this terminal is no longer held, so it is not shown.]'
/** Before that line: the cancel character ends a sequence the old stream left
 *  half read, and the attribute reset drops a colour it left set. */
const CANCEL = '\x18'
const ATTRIBUTE_RESET = '\x1b[0m'
/** The redraw: the size one row shorter goes back to the tab's after this
 *  long (probe P19's 300 ms). */
const REDRAW_BACK_MS = 300
/** At most this many bytes at the replay's start continue a character cut in half. */
const CUT_CHARACTER_MAX = 3
/** A replay after a gap is held at most this long from the hold's start, an
 *  attach again included, then what came of it is shown and the rest follows
 *  as it comes. A fixed cap, not a wait reset by each chunk: a replay of at
 *  most 2 MiB from a holder on this computer is in well within it, and a cap
 *  bounds how long a tab can stay blank whatever pace the bytes come at. It is
 *  the one way the notice can still go out of reach: a rest that comes after
 *  the cap and is longer than the tab keeps is not trimmed. */
export const HOLD_MAX_MS = 2_000
/** A take-over's replay waits at most this long for the tab to reach the
 *  holder's size, from when that size is known; then it is shown at the
 *  tab's size, as before, and the log says both sizes. Each restore logs
 *  how long its tab took (from the spawn), so the VM's restores can set it
 *  from the longest with a margin. */
export const SIZE_WAIT_MAX_MS = 2_000

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

/** A replay held after a gap (fromTheMiddle), or a take-over's whole replay
 *  held for the holder's size (holdWhole): its text so far, the offset it
 *  ends at (moved on by an attach again with no new gap), and the HOLD_MAX_MS
 *  timer. `due` once it is all in or that cap passed: it is shown then,
 *  unless the size wait still holds it. */
interface Hold {
  end: number
  parts: string[]
  timer: ReturnType<typeof setTimeout> | undefined
  /** From the holder's first byte: nothing was left out, so no notice and no cut. */
  whole: boolean
  due: boolean
}

/** A take-over waiting for its tab to reach the holder's size, and its cap. */
interface SizeWait {
  cols: number
  rows: number
  timer: ReturnType<typeof setTimeout>
}

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
  /** Let go of for an app update (release): the holder runs on, and this
   *  object asks nothing of it again. */
  private released = false
  /** Ring offset of the next output byte, for an attach again. */
  private offset = 0
  /** Shown from the middle of its output (`truncated`): the redraw that waits
   *  for the replay's end on `conn`, and how many bytes were no longer held. */
  private redraw: { conn: HolderConnection; end: number; lost: number } | undefined
  /** The terminal detached before that replay was shown: the bytes no longer
   *  held, for the attach again, whose replay the redraw then waits for. */
  private redrawOwed: number | undefined
  /** The redraw's second half (the tab's size again), while it waits. */
  private redrawTimer: ReturnType<typeof setTimeout> | undefined
  /** Shown from the middle of its output: the replay's text, held until the
   *  offset reaches `end` (the reply's ring_end), then shown by showHeld. */
  private held: Hold | undefined
  /** A take-over whose tab is not at its holder's size yet (startSizeWait). */
  private sizeWait: SizeWait | undefined
  /** The size wait saw the tab reach its holder's size, and the tab's size
   *  has not changed since: a replay shown before anything else is then
   *  counted with the cursor's row followed (showHeld). A wait its cap ended,
   *  or none, leaves it false. */
  private atHolderSize = false
  /** When this terminal was spawned, and when the tab last gave its size
   *  (the spawn's, until a resize), on the driver's clock: the log says how
   *  long a take-over's tab took to reach its holder's size. */
  private readonly bornAt: number
  private sizeAt: number
  /** Bytes at the replay's very start that continue a character cut in half
   *  are dropped: at most this many more. */
  private cutBytes = 0
  /** A take-over's replay goes through this until the offset reaches `end`,
   *  the attach's ring_end: its terminal queries are taken out. An attach
   *  again goes on with it, to that end; after a gap of its own it first
   *  gives back what it held (flushDecoder), and a gap that starts past
   *  that end ends it. */
  private queries: { filter: ReplayQueryFilter; end: number } | undefined
  /** Some of this terminal's output was shown to the tab already. */
  private shownAny = false
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
    this.bornAt = this.now()
    this.sizeAt = this.bornAt
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
  /** True once release() let go of the holder for an app update. */
  get isReleased(): boolean { return this.released }

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
    if (c !== this.size.cols || r !== this.size.rows) this.atHolderSize = false
    this.size = { cols: c, rows: r }
    this.sizeAt = this.now()
    // A take-over waiting for its holder's size: a size on the way there is
    // not sent, and the holder's own ends the wait.
    const w = this.sizeWait
    if (w) {
      this.sizeChanged = true
      if (c === w.cols && r === w.rows) this.endSizeWait(true)
      return
    }
    if (this.attached && this.conn) this.sendResize()
    else this.sizeChanged = true
  }

  clear(): void { this.inner?.clear() }
  pause(): void { this.inner?.pause() }
  resume(): void { this.inner?.resume() }

  /** Ends the terminal: the holder ends the program's whole tree and exits.
   *  Once released, nothing goes to the holder: the exit is this object's
   *  alone, so the PTY manager drops it as it drops any ended terminal. */
  kill(signal?: string): void {
    if (this.inner) { this.inner.kill(signal); return }
    if (this.released) {
      if (this.exited) return
      this.conn?.close()
      this.conn = undefined
      this.finish(0)
      this.resolveEnded()
      return
    }
    if (this.ending || this.exited) return
    this.markEnding()
    // Up: ended now. Still starting, or attaching again: the step that brings
    // the holder up sees `ending` and ends it.
    if (this.conn && !this.conn.isClosed) void this.endHolder(null)
  }

  /**
   * An app update (Windows, plan section B2): let go of the holder without
   * ending it. The connection closes with no term.end, so the holder's away
   * clock starts (two minutes), and the new version's start shows the
   * terminal again, as it does after a crash. Only a terminal through a
   * holder that has been attached is let go of; any other (still starting,
   * ending, over, or the usual way) answers false and is left to kill() as
   * before.
   */
  release(): boolean {
    if (this.inner || this.exited || this.ending || this.released || !this.record || !this.everAttached) return false
    this.released = true
    const conn = this.conn
    // Cleared first, so the connection's own close finds nothing to do here.
    this.conn = undefined
    // A replay still held is shown before the holder is let go of.
    this.stopSizeWait()
    this.showHeld()
    this.setDetached()
    this.stopRedraw()
    conn?.close()
    return true
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
    let start: Pick<LaunchSpec, 'argv' | 'line'> = this.spec
    try {
      start = this.driver.launchArgs?.(conn) ?? this.spec
    } catch (err) {
      this.driver.log(`[session-helper] ${this.sid}: before the launch: ${(err as Error).message}`)
    }
    try {
      const launched = await conn.request({
        t: 'term.launch',
        argv: start.argv,
        cwd: this.spec.cwd,
        env: this.spec.env,
        cols: sent.cols,
        rows: sent.rows,
        // The Windows fields, only when the spec gives them: a launch without
        // them is the same frame as before they existed.
        ...(start.line !== undefined ? { line: start.line } : {}),
        ...(this.spec.conpty !== undefined ? { conpty: this.spec.conpty } : {}),
      })
      if (typeof launched.pid === 'number') this.childPid = launched.pid
    } catch (err) {
      this.fallBack(`the holder refused the launch: ${(err as Error).message}`, record, conn)
      return
    }
    // A kill meanwhile sent the end already.
    if (this.ending || this.exited) return
    // Before the attach, which sends what the tab typed (its launch line).
    try {
      this.driver.launched?.(conn)
    } catch (err) {
      this.driver.log(`[session-helper] ${this.sid}: after the launch: ${(err as Error).message}`)
    }
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
    // The holder's size, before the attach, so its replay can wait for the
    // tab to be at it. A kill meanwhile sent the end already.
    const holder = await this.holderSizeOf(conn)
    if (this.ending || this.exited) return
    if (holder) this.startSizeWait(holder)
    // Typed before the terminal came back: meant for a new shell, not this one.
    this.queued = []
    this.queuedBytes = 0
    this.sizeChanged = true
    await this.attach(conn, 0, 'adopt')
  }

  /** The holder's size, by `screen.read` on `conn`. None when the holder
   *  offers no screen reads or the read fails: the replay is then shown as it
   *  comes, at the tab's size, as before. */
  private async holderSizeOf(conn: HolderConnection): Promise<{ cols: number; rows: number } | undefined> {
    if (!conn.screen) return undefined
    try {
      const { cols, rows } = await conn.readScreen()
      return { cols, rows }
    } catch (err) {
      // Ended meanwhile (its connection closed under the read): nothing to say.
      if (!this.ending && !this.exited) this.driver.log(`[session-helper] ${this.sid}: its holder's size could not be read (${stripSpoofableText((err as Error).message, 120)}), so its replay is shown at the tab's size`)
      return undefined
    }
  }

  /** The take-over waits for its tab to reach the holder's size, at most
   *  SIZE_WAIT_MAX_MS: none when the tab is at it already. */
  private startSizeWait(holder: { cols: number; rows: number }): void {
    const timer = setTimeout(() => this.endSizeWait(false), SIZE_WAIT_MAX_MS)
    this.sizeWait = { ...holder, timer }
    if (this.size.cols === holder.cols && this.size.rows === holder.rows) this.endSizeWait(true)
  }

  /**
   * The size wait ends: the tab reached the holder's size (`reached`), or the
   * cap passed. One log line either way. A held replay that is all in is
   * shown now, then what the wait put off goes out: the redraw after a gap,
   * else the tab's size.
   */
  private endSizeWait(reached: boolean): void {
    const w = this.sizeWait
    if (!w) return
    this.stopSizeWait()
    const { cols, rows } = this.size
    this.atHolderSize = reached
    this.driver.log(reached
      ? `[session-helper] ${this.sid}: the tab is at its holder's size ${cols}x${rows}, ${Math.max(0, this.sizeAt - this.bornAt)} ms after it started`
      : `[session-helper] ${this.sid}: the tab did not reach its holder's size ${w.cols}x${w.rows} within ${SIZE_WAIT_MAX_MS} ms (it is ${cols}x${rows}), so its replay is shown at the tab's size`)
    if (this.held?.due) this.showHeld()
    const conn = this.conn
    if (!conn || !this.attached || this.ending || this.exited) return
    if (this.redraw) this.redrawOnce(conn)
    else if (this.sizeChanged) this.sendResize()
  }

  /** No size wait from here on, and nothing it put off is sent from it. */
  private stopSizeWait(): void {
    if (!this.sizeWait) return
    clearTimeout(this.sizeWait.timer)
    this.sizeWait = undefined
  }

  private async attach(conn: HolderConnection, from: number, mode: AttachMode): Promise<void> {
    this.attaching = true
    let reply: Record<string, unknown>
    try {
      reply = await conn.request({ t: 'term.attach', from }, (m) => {
        // Before the replay that follows the reply: the offset starts where
        // the holder starts, and a cut (the ring no longer holds `from`) ends
        // a character split there. With no new gap, a cut character still
        // waiting for its bytes (cutBytes) still has them dropped, and a
        // replay still held from before the drop goes on being held, to this
        // reply's end.
        const start = typeof m.from === 'number' ? m.from : from
        const gap = m.truncated === true || start > from
        if (start !== from || gap) this.flushDecoder()
        this.offset = start
        // A take-over's replay loses its queries, to this reply's ring_end; a
        // gap that starts past that end ends the filter.
        if (mode === 'adopt') this.startQueries(m)
        else if (this.queries && start >= this.queries.end) this.endQueries()
        // A program that is over: its replay is shown with no wait for the
        // size (counted with the cursor's row followed only when the tab
        // started at its holder's size, showHeld), and its tab reads it as
        // ended next.
        if (m.running === false) this.stopSizeWait()
        if (gap) {
          this.fromTheMiddle(conn, Math.max(0, start - from), m)
          return
        }
        if (this.held) this.holdOn(m)
        else if (this.sizeWait) this.holdWhole(m)
        if (this.redrawOwed !== undefined) this.redrawStillOwed(conn, m)
      })
    } catch (err) {
      this.attaching = false
      const why = (err as Error).message
      if (this.exited || this.released) return
      if (this.ending) { if (!this.endStarted) void this.endHolder(null); return }
      if (mode === 'adopt') { this.fallBack(`the held terminal could not be attached: ${why}`, undefined, conn); return }
      // The connection dropped under the attach: tried again (within the budget).
      if (conn.isClosed && !this.replaced) { void this.reconnect('the connection closed while it attached'); return }
      this.giveUp(`the terminal could not be attached${mode === 'again' ? ' again' : ''}: ${why}`)
      return
    }
    this.attaching = false
    if (this.exited) return
    if (this.released) { conn.close(); return }
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
    // After a gap the redraw ends at the tab's size, so this one is not sent
    // as well; while the size wait is on, the wait's end sends it.
    if (this.sizeChanged && !this.redraw && !this.sizeWait) this.sendResize()
    const queued = this.queued
    this.queued = []
    this.queuedBytes = 0
    for (const b of queued) conn.sendInput(b)
    // The replay may have been shown already, before this attach was settled.
    // One held to its end that nothing else shows now (it is empty, and no
    // redraw or size wait follows) goes here.
    if (this.held?.due && !this.sizeWait) this.showHeld()
    this.redrawOnce(conn)
  }

  /**
   * The holder no longer held the start this attach asked for, so the replay
   * starts `lost` bytes later. Nothing of it is shown yet: its text is held
   * until the offset reaches the reply's ring_end, then shown in one piece
   * (showHeld): the cancel character, the attribute reset, one line saying
   * earlier output is not shown, then only the last of the replay that the
   * tab keeps, so that line is not pushed out of the scrollback by the
   * replay after it. A connection that closes in the middle of a hold (the
   * holder closes one that fell behind) leaves it held: the attach again goes
   * on from the last byte seen and, with no new gap, holds its replay too, to
   * that reply's ring_end (holdOn); with a new gap of its own the old hold is
   * shown first and a new one starts. A hold ends at the replay's end, when
   * the connection is replaced, when the terminal ends, starts the usual way
   * or is let go of for an update, or HOLD_MAX_MS after it started; whichever
   * way, what was held is shown, the same way, once. A take-over still
   * waiting for its tab to reach the holder's size (startSizeWait) keeps a
   * hold that is all in, or past HOLD_MAX_MS, until that wait ends, and sends
   * no size meanwhile. Bytes at the replay's very start that continue a
   * character cut in half are still dropped before decoding. Typed input goes
   * out during a hold as at any time, and so do resizes outside that wait. A
   * program still running is asked to redraw once the replay is shown
   * (redrawOnce), after the held text. Nothing clears the view or resets the
   * terminal, and no mode is set but those the left-out part of the replay
   * set: on an attach again the tab's terminal still has the modes its
   * program set, and a reset would throw them away.
   */
  private fromTheMiddle(conn: HolderConnection, lost: number, reply: Record<string, unknown>): void {
    // A replay still held from before this gap goes first, with its own notice.
    this.showHeld()
    // A redraw still owed for an earlier gap: one redraw, and the log counts both.
    const all = lost + (this.redrawOwed ?? 0)
    this.redrawOwed = undefined
    this.cutBytes = CUT_CHARACTER_MAX
    // An empty replay needs nothing more here: what follows the attach shows
    // it at once (redrawOnce for a program still running, exitAfterReplay for
    // one that is over), or the size wait's end does.
    this.held = this.newHold(reply, false)
    this.awaitReplayEnd(conn, all, reply)
  }

  /** A take-over's whole replay (no gap), held while the tab is not at its
   *  holder's size: shown as it is once it is all in and the tab is at that
   *  size, or at either cap, with no notice. */
  private holdWhole(reply: Record<string, unknown>): void {
    this.held = this.newHold(reply, true)
  }

  /** A hold of the replay that follows `reply`, to its ring_end, with its
   *  HOLD_MAX_MS cap: due at once when that replay is empty. */
  private newHold(reply: Record<string, unknown>, whole: boolean): Hold {
    const start = this.offset
    const end = typeof reply.ring_end === 'number' && reply.ring_end >= start ? reply.ring_end : start
    const held: Hold = { end, parts: [], timer: undefined, whole, due: end <= start }
    held.timer = setTimeout(() => {
      // All in already and held only for the holder's size: that wait's cap governs.
      if (this.held !== held || held.due) return
      held.due = true
      this.driver.log(`[session-helper] ${this.sid}: its replay did not end within ${HOLD_MAX_MS} ms, so what came of it is shown ${this.sizeWait ? "once the tab is at its holder's size" : 'now'}`)
      if (!this.sizeWait) this.showHeld()
    }, HOLD_MAX_MS)
    return held
  }

  /** An attach again with no new gap while a replay is held: the hold goes on,
   *  to this reply's ring_end. An empty replay is shown by what follows the
   *  attach, as in fromTheMiddle. */
  private holdOn(reply: Record<string, unknown>): void {
    const held = this.held
    if (!held) return
    held.end = typeof reply.ring_end === 'number' && reply.ring_end >= this.offset ? reply.ring_end : this.offset
    if (held.end <= this.offset) held.due = true
  }

  /**
   * The end of a hold (fromTheMiddle), whichever way it ends, in one piece:
   * the cancel character (it ends a sequence the old stream left half read),
   * the alternate screen left whenever the left-out part switched it (so the
   * notice is on the normal screen), the attribute reset (it drops a colour
   * the old stream left set; after the leave, which can restore the colours
   * saved when a program entered that screen), the notice on a line of its
   * own (after output already shown, from the start of the next one), the
   * input modes the left-out part set
   * or reset, then the last of the held text that the tab keeps:
   * TERMINAL_SCROLLBACK_LINES less a screen's rows and the notice's own, at
   * least a screen, so the notice stays in the scrollback through the redraw
   * and a screen more of output (replay-tail.ts says how rows are counted and
   * where the cut can land). Held text that is the start of live output (a
   * frame that carries the replay's end and more) is part of the piece. A tab
   * the size wait saw reach its holder's size, still at it and shown nothing
   * yet, has the held text's rows counted with the cursor's row followed
   * (2.1.3-beta.13, plan section A2); what is shown then starts on the tab's
   * last row, and the rows less one come off the budget for the empty rows
   * that leaves under the notice.
   */
  private showHeld(): void {
    const held = this.held
    if (!held) return
    this.held = undefined
    clearTimeout(held.timer)
    const text = held.parts.join('')
    // A whole replay left nothing out: shown as it is.
    if (held.whole) {
      if (text) this.show(text)
      return
    }
    const { cols, rows } = this.size
    // At the size its holder's output was made for, and shown nothing yet: the
    // cursor's row is followed, so a console's wrapped line counts the rows
    // the tab gives it. The count has the console's cursor on the last row
    // wherever it can cut, so what is shown starts there: a console's jump to
    // the row above then lands where it did in the console, not on the
    // notice's row or an empty one. The rows less one come off the budget for
    // the empty rows between the notice and that start.
    const exact = this.atHolderSize && !this.shownAny
    const budget = Math.max(rows, TERMINAL_SCROLLBACK_LINES - rows - rowsOf(EARLIER_OUTPUT_NOT_SHOWN, cols) - (exact ? rows - 1 : 0))
    const { from, left, part, before, after } = replayTail(text, cols, budget, exact ? rows : undefined)
    if (from > 0) this.driver.log(`[session-helper] ${this.sid}: the oldest ${left} lines of its replay${part ? ', and the start of the line after them,' : ''} are not shown either, so the line saying so stays within the ${TERMINAL_SCROLLBACK_LINES} lines the tab keeps (rows counted at ${cols}x${rows}${exact ? ", the cursor's row followed" : ''})`)
    this.show(`${CANCEL}${before}${ATTRIBUTE_RESET}${this.shownAny ? '\r\n' : ''}${EARLIER_OUTPUT_NOT_SHOWN}\r\n${exact ? `\x1b[${rows};1H` : ''}${after}${from > 0 ? text.slice(from) : text}`)
  }

  /**
   * An attach again with no new gap, after the terminal detached before the
   * replay of a gap was shown (a connection that fell behind is closed in the
   * middle of one too): the redraw now waits for this replay's end, as the
   * replay still held does (holdOn), so the redraw goes after it.
   */
  private redrawStillOwed(conn: HolderConnection, reply: Record<string, unknown>): void {
    const lost = this.redrawOwed ?? 0
    this.redrawOwed = undefined
    this.awaitReplayEnd(conn, lost, reply)
  }

  /** The redraw waits for the end of the replay that follows `reply`; none for a program that is over. */
  private awaitReplayEnd(conn: HolderConnection, lost: number, reply: Record<string, unknown>): void {
    if (reply.running === false) {
      this.driver.log(`[session-helper] ${this.sid}: ${lost} bytes of earlier output are no longer held, so they are not shown; its program is over, so no redraw is asked for`)
      return
    }
    const start = this.offset
    const end = typeof reply.ring_end === 'number' && reply.ring_end >= start ? reply.ring_end : start
    this.redraw = { conn, end, lost }
  }

  /**
   * Once the replay after a gap is shown and the program still runs: one
   * resize one row shorter than the tab (one taller for a tab one row high),
   * then, REDRAW_BACK_MS later, one at the tab's size as it is then. Probe
   * P19: a resize to the size the terminal already has makes a program redraw
   * only on the ConPTY built into Windows. To the holder only: no pane is
   * resized, and a resize the tab asks for meanwhile goes out as usual.
   */
  private redrawOnce(conn: HolderConnection): void {
    const r = this.redraw
    if (!r || r.conn !== conn || this.conn !== conn || !this.attached || this.ending || this.exited || this.offset < r.end) return
    // Not while the tab is on its way to the holder's size: the wait's end
    // runs this.
    if (this.sizeWait) return
    // The held replay ends where this redraw waits, so it is shown already;
    // were it not, it goes first all the same.
    this.showHeld()
    this.redraw = undefined
    this.redrawOwed = undefined
    const { cols, rows } = this.size
    // The holder's size differs from the tab's until the second half: an
    // attach again before it sends the tab's.
    this.sizeChanged = true
    conn.request({ t: 'term.resize', cols, rows: rows > 1 ? rows - 1 : rows + 1 }).catch(() => { /* gone or refused: the second half still sends the tab's size */ })
    this.driver.log(`[session-helper] ${this.sid}: ${r.lost} bytes of earlier output are no longer held, so they are not shown; asked its program to redraw`)
    this.redrawTimer = setTimeout(() => {
      this.redrawTimer = undefined
      if (this.conn !== conn || conn.isClosed || !this.attached || this.ending || this.exited || this.replaced) return
      // As sendResize, but a connection that closes with this frame unread
      // leaves the holder at the shorter size, so the attach again sends the
      // tab's (the request fails before the close attaches again).
      this.sizeChanged = false
      conn.request({ t: 'term.resize', cols: this.size.cols, rows: this.size.rows }).catch(() => { if (conn.isClosed) this.sizeChanged = true })
    }, REDRAW_BACK_MS)
  }

  /** No redraw goes out now: one still waiting for its replay's end is owed
   *  to the attach again (setDetached), or dropped (stopRedraw). */
  private pauseRedraw(): void {
    this.redraw = undefined
    if (this.redrawTimer !== undefined) clearTimeout(this.redrawTimer)
    this.redrawTimer = undefined
  }

  /** The terminal ended, was let go of or was replaced: no redraw is sent after this. */
  private stopRedraw(): void {
    this.redrawOwed = undefined
    this.pauseRedraw()
  }

  // ── the connection ─────────────────────────────────────────────────────────

  private useConnection(conn: HolderConnection): void {
    this.conn = conn
    conn.on('output', (bytes: Buffer) => {
      if (this.conn !== conn || this.exited) return
      const at = this.offset
      this.offset += bytes.length
      // A take-over's replay, to its ring_end, goes through the query filter;
      // the live output after it does not.
      const q = this.queries
      const cut = q ? Math.max(0, Math.min(bytes.length, q.end - at)) : 0
      let text = q && cut > 0 ? q.filter.write(this.decode(bytes.subarray(0, cut))) : ''
      if (q && this.offset >= q.end) text += this.endQueries()
      text += this.decode(cut > 0 ? bytes.subarray(cut) : bytes)
      const held = this.held
      if (held) {
        // A frame that carries the replay's end and live output after it is
        // held whole, and so is output while the size wait goes on.
        if (text) held.parts.push(text)
        if (this.offset >= held.end) {
          held.due = true
          if (!this.sizeWait) this.showHeld()
        }
      } else if (text) this.show(text)
      // After the held text, never before it.
      if (this.redraw) this.redrawOnce(conn)
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
        this.stopSizeWait()
        this.showHeld()
        this.stopRedraw()
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
    const now = this.now()
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
    if (this.exited || this.released) { conn.close(); return }
    this.useConnection(conn)
    if (this.ending) { void this.endHolder(null); return }
    await this.attach(conn, this.offset, 'again')
  }

  /** The driver's clock. */
  private now(): number {
    return this.driver.now?.() ?? Date.now()
  }

  private sendResize(): void {
    this.sizeChanged = false
    const conn = this.conn
    if (!conn) return
    conn.request({ t: 'term.resize', cols: this.size.cols, rows: this.size.rows }).catch(() => { /* the next resize tries again */ })
  }

  private setDetached(): void {
    // A replay still held stays held: the attach again goes on from the last
    // byte seen and holds its replay too (holdOn). Each way the terminal ends
    // or is let go of shows it first, and so does HOLD_MAX_MS.
    // A redraw that still waits for its replay's end is owed to the attach again.
    if (this.redraw) this.redrawOwed = this.redraw.lost
    this.pauseRedraw()
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
      // endHolder shows a replay still held first (markEnding).
      void this.endHolder(code)
    }
    const timer = setTimeout(over, 500)
    const check = () => { if (this.offset >= end) over() }
    conn.on('output', check)
    check()
  }

  private markEnding(): void {
    // Ending (closed, given up, or its program over): a replay still held is
    // shown first, whatever the tab's size.
    this.stopSizeWait()
    this.showHeld()
    this.stopRedraw()
    if (this.ending) return
    this.ending = true
    this.driver.ending(this.sid, this.ended)
  }

  /** End the holder (its program's whole tree), then report the exit. */
  private async endHolder(code: number | null): Promise<void> {
    // Let go of for an update: its holder is not ended from here.
    if (this.released) return
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
    if (this.exited || this.released) return
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
      ? `[session-helper] ${this.sid}: nothing is started for this terminal, because ${why}`
      : `[session-helper] ${this.sid}: starting it the usual way, because ${why}`)
    if (conn) {
      conn.request({ t: 'term.end' }).catch(() => { /* gone */ }).finally(() => conn.close())
    } else if (record) {
      this.driver.connect(record).then((c) => c.request({ t: 'term.end' }).finally(() => c.close())).catch(() => { /* gone */ })
    }
    this.conn = undefined
    // A replay still held goes to the tab before the new shell's output.
    this.stopSizeWait()
    this.showHeld()
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
   * why, as the PTY manager ends its own (unless the driver says its owner
   * ends it its own way: endsOnIoFailure).
   */
  private guardInner(inner: IPty): void {
    let ending = false
    guardPtyIo(inner, (side, err) => {
      const what = stripSpoofableText(String(err?.code ?? err?.message ?? err), 120)
      this.driver.log(side === 'input'
        ? `[session-helper] ${this.sid}: input to the usual-way terminal failed (${what}); it takes no more input`
        : `[session-helper] ${this.sid}: output of the usual-way terminal failed (${what})`)
      if (ending || this.driver.endsOnIoFailure === false) return
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

  /** The decoder's last half character, as its stream's own text: held with a
   *  replay still held. Before it, a sequence the query filter holds, as it
   *  is: the stream goes on after a gap, or not at all. */
  private flushDecoder(): void {
    const rest = (this.queries?.filter.flush() ?? '') + this.decoder.end()
    if (!rest) return
    if (this.held) this.held.parts.push(rest)
    else this.show(rest)
  }

  /** A take-over's replay is in up to `reply`'s ring_end: its queries are taken out to there. */
  private startQueries(reply: Record<string, unknown>): void {
    const end = typeof reply.ring_end === 'number' ? reply.ring_end : this.offset
    this.queries = end > this.offset ? { filter: new ReplayQueryFilter(), end } : undefined
  }

  /** The query filter's end: what it holds goes on as it is, and one log
   *  line counts what it took out. */
  private endQueries(): string {
    const q = this.queries
    if (!q) return ''
    this.queries = undefined
    const rest = q.filter.flush()
    const n = q.filter.dropped
    if (n > 0) this.driver.log(`[session-helper] ${this.sid}: ${n} terminal ${n === 1 ? 'query' : 'queries'} in its replay ${n === 1 ? 'was' : 'were'} not passed on, so ${n === 1 ? 'it is' : 'they are'} not answered again or late`)
    return rest
  }

  /** Output bytes to text, the bytes of a cut character at the replay's very start dropped first. */
  private decode(bytes: Buffer): string {
    return this.decoder.write(this.cutBytes > 0 ? this.dropCut(bytes) : bytes)
  }

  /** Output of the holder's terminal, or a line of the app's own, to the tab. */
  private show(text: string): void {
    this.shownAny = true
    this.dataEmitter.fire(text)
  }

  /** The replay's very start after a gap: the bytes that continue a character
   *  cut in half (at most CUT_CHARACTER_MAX) are dropped, so the decoder,
   *  ended at the cut, starts on a whole one. */
  private dropCut(bytes: Buffer): Buffer {
    let i = 0
    while (i < bytes.length && this.cutBytes > 0 && (bytes[i] & 0xc0) === 0x80) {
      i++
      this.cutBytes--
    }
    if (i < bytes.length) this.cutBytes = 0
    return i === 0 ? bytes : bytes.subarray(i)
  }

  private finish(exitCode: number, signal?: number): void {
    if (this.exited) return
    this.exited = true
    this.resolveAdoption(true)
    // A replay still held goes to the tab before the exit.
    this.stopSizeWait()
    this.showHeld()
    this.setDetached()
    this.stopRedraw()
    this.flushDecoder()
    this.endQueries()
    this.exitEmitter.fire(signal === undefined ? { exitCode } : { exitCode, signal })
  }
}
