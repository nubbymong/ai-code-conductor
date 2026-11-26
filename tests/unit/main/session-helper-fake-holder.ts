/**
 * A fake session helper for the app's client tests: holders that speak the
 * protocol (docs/remote/helper-protocol.md, sections 6, 7 and 15) over an
 * in-memory stream, and the helper's one-shot commands (version, hold, list,
 * selftest) as an exec. Records are written to the real store folder the
 * manager reads, as the helper writes them.
 *
 * Typed input follows section 15's rule when `inputCapacity` is set: while
 * the program is not reading, at most that many frames wait, and once one is
 * refused (`busy`) every later frame on that connection is refused too, until
 * the app's next ping.
 *
 * Hook events (section 15, capability `hooks`, 2.1.3-beta.8): a holder offers
 * `hooks` unless its `caps` say otherwise; `hookEvent` posts one as the hook
 * mode would, and the holder sends it as an `event` to the attached connection
 * when that connection acked `hooks`, else keeps it for the next such attach.
 *
 * Tool streams (section 15, capability `mcp`, 2.1.3-beta.10): a holder offers
 * `mcp` too, as a real one of this version does, so the manager's tests that
 * check what a connection acked also show that no connection the app makes
 * acks it. From 2.1.3-beta.11 (plan section B1) it stands in for a relay as
 * well: `openToolStream` sends `mcp.open` to the attached connection when that
 * one acked `mcp` (else nothing: `not-connected`), `relay` and
 * `endToolStream` send that stream's `mcp` and `mcp.close`, and each `mcp`
 * the app sends on a stream it was given is kept in `toolSent`. As a real
 * holder does, it answers an `mcp.close` from the app `not-found`, and the
 * streams the attached connection carried end when it lets go, the app not
 * told.
 *
 * The ring (2.1.3-beta.12, plan section A1) may no longer hold the start of
 * the output (`ringStart`, `forget`): an attach that asks for an offset older
 * than it holds is answered from the ring's start with `truncated` true, as a
 * real holder answers one once 2 MiB have gone past. A replay can be cut
 * short by a close (`cutReplay`), as a holder closes a connection that fell
 * behind in the middle of one, or stop with its connection left open
 * (`stallReplay`), a replay whose end never comes.
 *
 * The away clock (section 15) runs only when a test gives the helper one
 * (`awayClock`): then a holder with no connection attached ends itself `away`
 * seconds after its start or after the last attached connection let go,
 * checked at each list, each connection and each tick(), as the holder's own
 * timer would. Without one, no holder ends by itself.
 *
 * Kept tool streams (2.1.3-beta.12, plan sections B1 and B2): a stream opened
 * with `openToolStream({ away: true })` stands for a relay that acked `away`.
 * When the attached connection lets go, that stream is kept with no app side
 * (`keptStreams`) and its relay is told `mcp.away`; one opened while no
 * connection takes tool streams is kept the same way. While a stream is kept,
 * what `relay` is given is held, as that relay holds a call. When a
 * connection that acked `mcp` attaches and the program runs, each kept
 * stream is given to it with `mcp.open` on its own number, its relay is told
 * `mcp.back`, and the held messages go in the order they came. A session
 * that ended keeps nothing; one whose program has exited gives nothing back
 * (its kept streams end at the next attach here, at the exit in a real
 * holder). Each thing a relay was told is in `relayTold`. Not modelled: the
 * relay's 30 s hold, its bounds and its fixed answer, the notifications it
 * drops while away (here every message `relay` is given while a stream is
 * kept is held and sent after `mcp.back`), and the 8 streams a session may
 * have (B1's Rust tests own those).
 *
 * Screen reads (2.1.3-beta.13, plan section A1): a holder whose `caps` name
 * `screen` answers `screen.read` from a connection that acked it with its
 * size (its last resize, else its launch's) and blank rows; `screenAnswer`
 * makes it answer an error, a reply that does not read, or nothing. Each read is
 * counted in `screenReads`. Not modelled: what the rows hold, and
 * `screen.tail`.
 *
 * Output frames (2.1.3-beta.13, plan section A3): `frameBytes` sets the most
 * bytes one raw frame carries, so a replay can be cut anywhere, inside an
 * escape sequence too.
 *
 * A Windows named pipe (aicc_planning#423, B1f): `noHalfClose` makes a holder
 * take no notice of the app's `end()` (a pipe has no half-close, so the app's
 * handle stays open and the holder's writes still succeed); only the close of
 * the app's handle lets go of the connection (its destroy, or the app's exit:
 * `dropAll`). `term.detach` is answered as a real holder answers it: from the
 * attached connection only, nothing more is sent to it after `term.detached`
 * (a hook event waits for the next attach), and the connection is closed.
 */
import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { Duplex, PassThrough, finished } from 'stream'
import { FrameReader, encodeJsonFrame, encodeRawFrame, type HolderRecord } from '../../../src/main/session-helper/protocol'
import type { ExecResult } from '../../../src/main/session-helper/manager'

const hex = (bytes: number) => randomBytes(bytes).toString('hex')

/** Node's own AbortError, which it does not export: an end destroyed with no
 *  error destroys both its streams with one, as Node's does. */
function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
}

/**
 * One end of a connection: it reads what `r` carries and writes into `w`.
 * These are Node's own steps for Duplex.from({ readable, writable }) of two
 * Node streams (Node 24, lib/internal/streams/duplexify.js, _duplexify),
 * written out because @types/node declares that form for web streams only,
 * so the call did not type-check (TS2345). Same steps, same events: end()
 * ends `w`; an error on either stream destroys the other and this end; this
 * end's destroy destroys both, with an AbortError when it was given none.
 */
function joined(r: PassThrough, w: PassThrough): Duplex {
  let ondrain: ((error?: Error | null) => void) | null = null
  let onfinish: ((error?: Error | null) => void) | null = null
  let onreadable: (() => void) | null = null
  // undefined until the first stream ends, then null; a pending destroy's
  // callback while one is under way.
  let onclose: ((error?: Error | null) => void) | null | undefined
  const onfinished = (err?: Error | null): void => {
    const cb = onclose
    onclose = null
    if (cb) cb(err)
    else if (err) d.destroy(err)
  }
  const read = (): void => {
    for (;;) {
      const buf: unknown = r.read()
      if (buf === null) {
        onreadable = read
        return
      }
      if (!d.push(buf)) return
    }
  }
  const d = new Duplex({
    write(chunk, encoding, callback) {
      if (w.write(chunk, encoding)) callback()
      else ondrain = callback
    },
    final(callback) {
      w.end()
      onfinish = callback
    },
    read,
    destroy(err, callback) {
      const why = !err && onclose !== null ? abortError() : err
      onreadable = null
      ondrain = null
      onfinish = null
      if (onclose === null) {
        callback(why)
      } else {
        onclose = callback
        if (why && !w.destroyed) w.destroy(why)
        if (why && !r.destroyed) r.destroy(why)
      }
    },
  })
  finished(w, (err) => {
    if (err && !r.destroyed) r.destroy(err)
    onfinished(err)
  })
  w.on('drain', () => {
    if (!ondrain) return
    const cb = ondrain
    ondrain = null
    cb()
  })
  w.on('finish', () => {
    if (!onfinish) return
    const cb = onfinish
    onfinish = null
    cb()
  })
  finished(r, (err) => {
    if (err && !w.destroyed) w.destroy(err)
    onfinished(err)
  })
  r.on('readable', () => {
    if (!onreadable) return
    const cb = onreadable
    onreadable = null
    cb()
  })
  r.on('end', () => { d.push(null) })
  return d
}

/**
 * Two ends of one in-memory connection: the app's, then the holder's. The app
 * destroying its end destroys the holder's too, with an AbortError the holder
 * side (a stand-in) takes no notice of; the app's end gets no such listener,
 * so an error the app leaves unhandled still fails the test.
 */
export function duplexPair(): [Duplex, Duplex] {
  const toB = new PassThrough()
  const toA = new PassThrough()
  const holderEnd = joined(toB, toA)
  holderEnd.on('error', () => { /* the app let go */ })
  return [joined(toA, toB), holderEnd]
}

type Json = Record<string, unknown>

/** What one connection carried from the app, in order: raw frames (their size),
 *  control messages (their type), and the pongs the holder sent. */
export type ConnEvent = { raw: number } | { t: string } | { pong: true }

export class FakeConn {
  acked = false
  /** The caps its hello.ack named. */
  ackedCaps: string[] = []
  closed = false
  /** Typed input is refused on this connection until the app's next ping. */
  refusing = false
  readonly frames: Json[] = []
  readonly log: ConnEvent[] = []
  constructor(readonly holder: FakeHolder, readonly end: Duplex) {}
  sendJson(v: Json): void { if (!this.closed) this.end.write(encodeJsonFrame(v)) }
  sendRaw(b: Buffer): void {
    if (this.closed) return
    const size = this.holder.frameBytes
    for (let i = 0; i < b.length; i += size) this.end.write(encodeRawFrame(b.subarray(i, i + size)))
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.end.end()
    this.holder.conns.delete(this)
    if (this.holder.attached === this) this.holder.detached()
  }
}

export class FakeHolder {
  readonly nonce = hex(16)
  readonly endpoint: string
  readonly pid = 30000 + Math.floor(Math.random() * 10000)
  readonly started = Date.now()
  /** The helper version its record reports. */
  helperVersion = '0.1.0'
  /** Its away clock in seconds, as its record reports it. */
  away = 120
  launch: Json | null = null
  child: 'waiting' | 'running' | 'exited' = 'waiting'
  code: number | null = null
  ring = Buffer.alloc(0)
  /** The most bytes one raw frame of output carries (a real holder's chunks
   *  are at most 64 KiB); smaller cuts a replay at every this many bytes. */
  frameBytes = 65536
  /** The output offset of the ring's first byte: what came before it is no
   *  longer held (a real ring keeps the last 2 MiB). Raised by forget(). */
  ringStart = 0
  attached: FakeConn | null = null
  attaches = 0
  ended = false
  /** The holder process is gone: nothing answers at its endpoint. */
  gone = false
  /** The holder runs (list mode still lists it), but its endpoint cannot be reached. */
  unreachable = false
  readonly conns = new Set<FakeConn>()
  readonly requests: Json[] = []
  /** What the program read, in order. */
  readonly input: Buffer[] = []
  size: { cols: number; rows: number } | null = null
  /** Frames of typed input that may wait while the program is not reading; null: no limit. */
  inputCapacity: number | null = null
  /** Whether the program reads its input (with `inputCapacity` set). */
  reading = true
  private waitingInput: Buffer[] = []
  /** `busy` answers to typed input, in all. */
  busies = 0
  /** Answers term.attach; false leaves it unanswered. */
  answerAttach = true
  /** Set: the next attach's replay stops after `at` bytes and its connection
   *  is closed there (`busy`), as one that fell behind is; `then` runs after
   *  the close. Once. */
  cutReplay: { at: number; then?: () => void } | null = null
  /** Set: the next attach's replay stops after `at` bytes and the rest never
   *  comes, while its connection stays open (a replay whose end never comes).
   *  Once. */
  stallReplay: { at: number } | null = null
  /** Answers ping; false leaves it unanswered. */
  answerPing = true
  /** How long a pong waits. */
  pongDelayMs = 0
  /** Runs when a launch arrives, before its answer. */
  onLaunch: (() => void) | null = null
  /** Set: a term.end is carried out (and answered) only once this settles. */
  endGate: Promise<void> | null = null
  /** term.end requests that arrived, carried out or not yet. */
  endsAsked = 0
  /** The away clock's time in ms; null: this holder never ends by itself. */
  awayClock: (() => number) | null = null
  /** When the away clock started (no connection attached since); null while one is. */
  awaySince: number | null = null
  /** It ended by its away clock. */
  endedAway = false
  /** What its hello offers. */
  caps: string[] = ['core', 'local', 'hooks', 'mcp']
  /** The last `seq` a hook event took. */
  seq = 0
  /** Hook events waiting for an attach that acked `hooks`. */
  readonly waitingEvents: Json[] = []
  /** A holder that breaks section 15: it sends hook events to the attached
   *  connection even when that connection did not ack `hooks`. */
  forceEvents = false
  /** Each frame of typed input, as it reaches the program. */
  onTyped: ((bytes: Buffer) => void) | null = null
  /** Tool streams open now, by the holder's number, with the connection that carries each. */
  readonly toolStreams = new Map<number, FakeConn>()
  /** The last number a tool stream took. */
  private lastStream = 0
  /** Each `mcp` the app sent on a stream it was given, in order. */
  readonly toolSent: Array<{ stream: number; message: unknown }> = []
  /** Tool streams whose relay acked `away`. */
  private readonly awayStreams = new Set<number>()
  /** Tool streams kept with no app side, by number, each with what its relay holds meanwhile, in order. */
  readonly keptStreams = new Map<number, unknown[]>()
  /** What each relay was told, in order. */
  readonly relayTold: Array<{ stream: number; t: 'mcp.away' | 'mcp.back' | 'mcp.close' }> = []
  /** How it answers screen.read: its rows, an error, a reply that does not read, or not at all. */
  screenAnswer: 'rows' | 'error' | 'bad' | 'none' = 'rows'
  /** The screen reads it was asked for, once launched, by a connection that acked `screen`, one it leaves unanswered (`screenAnswer` 'none') included. */
  screenReads = 0
  /** B1f: a Windows named pipe; the app's `end()` is not seen, only its handle's close. */
  noHalfClose = false
  /** B1f: answers term.detach; false leaves it unanswered. */
  answerDetach = true

  constructor(readonly sid: string, readonly label: string, readonly store: string) {
    this.endpoint = `\\\\.\\pipe\\aicc-helper-${sid}-${hex(16)}`
  }

  /** The attached connection let go: the away clock starts, and the tool
   *  streams it carried end (each relay is told `mcp.close`; the app is not),
   *  except one whose relay acked `away` while the program runs, which is
   *  kept. */
  detached(): void {
    for (const [n, c] of [...this.toolStreams]) {
      if (c !== this.attached) continue
      this.toolStreams.delete(n)
      if (this.awayStreams.has(n) && this.child !== 'exited') this.keep(n)
      else { this.awayStreams.delete(n); this.relayTold.push({ stream: n, t: 'mcp.close' }) }
    }
    this.attached = null
    this.awaySince = this.awayClock ? this.awayClock() : null
  }

  /** A relay opens a tool stream: the holder numbers it and tells the attached
   *  connection, if that one acked `mcp`. Its number, or null (`not-connected`).
   *  `away`: the relay acked `away`, so with no such connection the stream is
   *  kept (its relay told `mcp.away`) in place of `not-connected`. */
  openToolStream(opts: { away?: boolean } = {}): number | null {
    const to = this.attached
    const taking = !!to && to.ackedCaps.includes('mcp')
    if (!taking && !opts.away) return null
    const n = ++this.lastStream
    if (opts.away) this.awayStreams.add(n)
    if (!taking) {
      this.keep(n)
      return n
    }
    this.toolStreams.set(n, to!)
    to!.sendJson({ t: 'mcp.open', stream: n })
    return n
  }

  /** The relay sends one message on stream `n`; on a kept stream it holds it. */
  relay(n: number, message: unknown): void {
    const held = this.keptStreams.get(n)
    if (held) {
      held.push(message)
      return
    }
    this.toolStreams.get(n)?.sendJson({ t: 'mcp', stream: n, message })
  }

  /** The relay ends stream `n`: the app is told, if a connection carries it. */
  endToolStream(n: number): void {
    this.awayStreams.delete(n)
    if (this.keptStreams.delete(n)) return
    const to = this.toolStreams.get(n)
    if (!to) return
    this.toolStreams.delete(n)
    to.sendJson({ t: 'mcp.close', stream: n })
  }

  /** Stream `n` is kept with no app side, and its relay told `mcp.away`. */
  private keep(n: number): void {
    this.keptStreams.set(n, [])
    this.relayTold.push({ stream: n, t: 'mcp.away' })
  }

  /** The kept streams end (the program exited, or the session ended): each relay is told. */
  private endKept(): void {
    for (const n of [...this.keptStreams.keys()]) {
      this.keptStreams.delete(n)
      this.awayStreams.delete(n)
      this.relayTold.push({ stream: n, t: 'mcp.close' })
    }
  }

  /** `conn` attached: when it acked `mcp` and the program runs, each kept
   *  stream is given to it with `mcp.open`, its relay is told `mcp.back`,
   *  and what that relay held goes, in the order it came. */
  private giveBack(conn: FakeConn): void {
    if (this.keptStreams.size === 0) return
    if (this.child === 'exited') return this.endKept()
    if (!conn.ackedCaps.includes('mcp')) return
    for (const [n, held] of [...this.keptStreams]) {
      this.keptStreams.delete(n)
      this.toolStreams.set(n, conn)
      conn.sendJson({ t: 'mcp.open', stream: n })
      this.relayTold.push({ stream: n, t: 'mcp.back' })
      for (const message of held) this.relay(n, message)
    }
  }

  /** The away clock ran out with nothing attached: the holder ends its session, as term.end does. */
  checkAway(): void {
    if (!this.awayClock || this.awaySince === null || this.attached || this.ended || this.gone) return
    if (this.awayClock() - this.awaySince < this.away * 1000) return
    this.endedAway = true
    this.endSelf()
  }

  private endSelf(): void {
    this.ended = true
    this.child = 'exited'
    this.endKept()
    try { fs.rmSync(path.join(this.store, `${this.sid}.json`), { force: true }) } catch { /* gone */ }
  }

  record(): HolderRecord {
    return {
      v: 1, session: this.sid, label: this.label, pid: this.pid, endpoint: this.endpoint, nonce: this.nonce,
      helper: this.helperVersion, started: this.started, away: this.away, attached: !!this.attached, child: this.child, code: this.code,
    }
  }

  writeRecord(): void {
    fs.mkdirSync(this.store, { recursive: true })
    fs.writeFileSync(path.join(this.store, `${this.sid}.json`), JSON.stringify(this.record()))
  }

  /** The app connects: the holder speaks first. */
  connect(): Duplex {
    const [app, mine] = duplexPair()
    const conn = new FakeConn(this, mine)
    this.conns.add(conn)
    const hello = { proto: [1], helper: { version: this.helperVersion }, os: 'windows', arch: 'x86_64', caps: this.caps, session: { sid: this.sid, state: this.launch ? 'live' : 'new' } }
    mine.write(`AICC-HELLO ${this.nonce} ${JSON.stringify(hello)}\n`)
    const reader = new FrameReader('app_to_helper')
    mine.on('data', (chunk: Buffer) => {
      for (const f of reader.push(chunk)) {
        if (f.kind === 1) {
          conn.log.push({ raw: f.bytes.length })
          if (conn === this.attached) this.typed(conn, f.bytes)
          continue
        }
        const m = f.json as Json
        conn.frames.push(m)
        conn.log.push({ t: String(m.t) })
        if (!conn.acked) {
          if (m.t !== 'hello.ack') { conn.close(); return }
          conn.acked = true
          conn.ackedCaps = Array.isArray(m.caps) ? (m.caps as string[]) : []
          continue
        }
        this.requests.push(m)
        const attaches = this.attaches
        this.answer(conn, m)
        // The kept tool streams go to a connection that attached (after its reply and replay).
        if (this.attaches > attaches && this.attached === conn) this.giveBack(conn)
      }
    })
    if (this.noHalfClose) mine.on('close', () => conn.close())
    else mine.on('end', () => conn.close())
    return app
  }

  /** One frame of typed input, offered to the program as the holder does. */
  private typed(conn: FakeConn, bytes: Buffer): void {
    this.onTyped?.(bytes)
    if (this.inputCapacity === null) { this.input.push(bytes); return }
    if (!conn.refusing && this.reading) { this.input.push(bytes); return }
    if (!conn.refusing && this.waitingInput.length < this.inputCapacity) { this.waitingInput.push(bytes); return }
    conn.refusing = true
    this.busies++
    conn.sendJson({ t: 'error', code: 'busy', text: 'the program is not reading its input; this frame and the ones after it until your next ping were not taken' })
  }

  /** The program starts reading again: what waited reaches it. */
  startReading(): void {
    this.reading = true
    this.input.push(...this.waitingInput)
    this.waitingInput = []
  }

  private answer(conn: FakeConn, m: Json): void {
    const re = m.id
    const err = (code: string, text: string) => conn.sendJson({ t: 'error', re, code, text })
    switch (m.t) {
      case 'ping': {
        conn.refusing = false
        if (!this.answerPing) return
        const pong = () => { conn.log.push({ pong: true }); conn.sendJson({ t: 'pong', re }) }
        if (this.pongDelayMs > 0) setTimeout(pong, this.pongDelayMs)
        else pong()
        return
      }
      case 'term.launch':
        if (this.launch) return err('busy', 'this holder has launched its session already')
        this.launch = m
        this.child = 'running'
        this.writeRecord()
        this.onLaunch?.()
        conn.sendJson({ t: 'term.launched', re, pid: 4242 })
        return
      case 'term.attach': {
        if (!this.launch) return err('not-found', 'nothing launched')
        if (!this.answerAttach) return
        const from = Number(m.from)
        const ringEnd = this.ringStart + this.ring.length
        if (from > ringEnd) return err('bad-field', 'from is past the ring')
        // Older than the ring holds: answered from the ring's start, `truncated` true.
        const start = Math.max(from, this.ringStart)
        if (this.attached && this.attached !== conn) {
          const old = this.attached
          old.sendJson({ t: 'error', code: 'replaced', text: 'a newer connection attached to this terminal' })
          old.close()
        }
        this.attached = conn
        this.awaySince = null
        this.attaches++
        conn.sendJson({ t: 'term.attached', re, from: start, ring_start: this.ringStart, ring_end: ringEnd, truncated: start > from, running: this.child !== 'exited', ...(this.child === 'exited' ? { code: this.code } : {}) })
        const replay = this.ring.subarray(start - this.ringStart)
        const cut = this.cutReplay
        if (cut && cut.at < replay.length) {
          this.cutReplay = null
          conn.sendRaw(replay.subarray(0, cut.at))
          conn.sendJson({ t: 'error', code: 'busy', text: 'this connection fell 256 chunks behind the output' })
          conn.close()
          cut.then?.()
          return
        }
        const stall = this.stallReplay
        if (stall && stall.at < replay.length) {
          this.stallReplay = null
          conn.sendRaw(replay.subarray(0, stall.at))
          return
        }
        conn.sendRaw(replay)
        // Waiting hook events go after the reply and its replay.
        if (conn.ackedCaps.includes('hooks')) for (const e of this.waitingEvents.splice(0)) conn.sendJson(e)
        return
      }
      case 'term.detach':
        if (!this.answerDetach) return
        if (conn !== this.attached) return err('not-connected', 'this connection is not attached')
        // The away clock starts, and nothing follows the answer: a later hook event waits.
        this.detached()
        conn.sendJson({ t: 'term.detached', re })
        conn.close()
        return
      case 'term.resize':
        if (conn !== this.attached) return err('not-connected', 'not attached')
        this.size = { cols: Number(m.cols), rows: Number(m.rows) }
        conn.sendJson({ t: 'term.resized', re })
        return
      case 'term.end': {
        this.endsAsked++
        const end = () => {
          conn.sendJson({ t: 'term.ended', re })
          this.endSelf()
          setTimeout(() => { for (const c of [...this.conns]) c.close() }, 5)
        }
        if (this.endGate) void this.endGate.then(end)
        else end()
        return
      }
      case 'screen.read': {
        if (!conn.ackedCaps.includes('screen')) return err('unknown-type', 'screen.read')
        if (!this.launch) return err('not-found', 'nothing launched')
        this.screenReads++
        if (this.screenAnswer === 'none') return
        if (this.screenAnswer === 'error') return err('io', 'the screen is no longer kept')
        const { cols, rows } = this.screenSize()
        const row = { text: '', typed: '', inverse: '', width: cols, end: 0 }
        const modes = { screen: 'normal', bracketed_paste: false, application_cursor: false, application_keypad: false, mouse: 'none', mouse_encoding: 'default', cursor_hidden: false }
        // 'bad': one row short of the screen with `cut` false, which no reader takes.
        const lines = Array.from({ length: this.screenAnswer === 'bad' ? rows - 1 : rows }, () => ({ ...row }))
        conn.sendJson({ t: 'screen.rows', re, cols, rows, cursor: { row: 0, col: 0 }, modes, cut: false, lines })
        return
      }
      case 'mcp':
        if (!conn.ackedCaps.includes('mcp')) return err('unknown-type', 'mcp')
        if (this.toolStreams.get(Number(m.stream)) !== conn) return conn.sendJson({ t: 'error', code: 'not-found', text: 'no such tool stream' })
        this.toolSent.push({ stream: Number(m.stream), message: m.message })
        return
      case 'mcp.close':
        // Only a relay ends a stream: the attached connection's end with its attach.
        if (!conn.ackedCaps.includes('mcp')) return err('unknown-type', 'mcp.close')
        return conn.sendJson({ t: 'error', code: 'not-found', text: 'no such tool stream' })
      default:
        err('unknown-type', String(m.t))
    }
  }

  /**
   * The hook mode posts one event: it takes the next `seq` and goes to the
   * attached connection if that one acked `hooks`, else it waits. Answers
   * the event as sent.
   */
  hookEvent(kind: string, payload: Json): Json {
    const e = { t: 'event', seq: ++this.seq, kind, payload }
    this.sendEvent(e)
    return e
  }

  /** An `event` message exactly as given (the same rule for where it goes). */
  sendEvent(e: Json): void {
    const to = this.attached
    if (to && (this.forceEvents || to.ackedCaps.includes('hooks'))) to.sendJson(e)
    else this.waitingEvents.push(e)
  }

  /** Its terminal's size: its last resize, else its launch's, else 80x24. */
  screenSize(): { cols: number; rows: number } {
    if (this.size) return this.size
    const l = this.launch
    if (l && typeof l.cols === 'number' && typeof l.rows === 'number') return { cols: l.cols, rows: l.rows }
    return { cols: 80, rows: 24 }
  }

  /** The program writes. */
  output(text: string): void {
    this.outputBytes(Buffer.from(text, 'utf8'))
  }

  outputBytes(b: Buffer): void {
    this.ring = Buffer.concat([this.ring, b])
    this.attached?.sendRaw(b)
  }

  /** The ring forgets its first `n` bytes, as a full one does. */
  forget(n: number): void {
    const k = Math.min(n, this.ring.length)
    this.ring = this.ring.subarray(k)
    this.ringStart += k
  }

  /** The program ends by itself. */
  exitChild(code: number): void {
    this.child = 'exited'
    this.code = code
    this.writeRecord()
    this.attached?.sendJson({ t: 'term.exit', code })
  }

  /** The attached connection fell 256 chunks behind: `busy`, then a close. */
  fallBehind(): void {
    const c = this.attached
    if (!c) return
    c.sendJson({ t: 'error', code: 'busy', text: 'this connection fell 256 chunks behind the output' })
    c.close()
  }

  /** The app is gone (a crash): every connection drops, the holder stays. */
  dropAll(): void {
    for (const c of [...this.conns]) c.close()
  }

  /** The holder process is killed: its connections drop and nothing answers again. */
  vanish(): void {
    this.gone = true
    this.dropAll()
  }
}

/** The helper's commands and its holders, as one fake. */
export class FakeHelper {
  readonly holders = new Map<string, FakeHolder>()
  readonly calls: Array<{ file: string; args: string[] }> = []
  version = 'aicc-helper 0.1.0'
  selfTestOk = true
  /** A holder that has launched already, so it answers a launch with busy. */
  holdBusy = false
  /** List mode fails (a slow holder ran it past its time). */
  listFails = false
  /** `hold --detach` notes that the holder stays inside the app's job. */
  insideJob = false
  /** Set: a `hold` that arrives waits for it before its holder starts (a slow start). */
  holdGate: Promise<void> | null = null
  /** Set: a `list` that arrives waits for it, then lists the holders as they are then (a slow listing). */
  listGate: Promise<void> | null = null
  /** Every holder `hold` started, in order (the map keeps only the last of a session). */
  readonly made: FakeHolder[] = []
  /** The holders' away clock in ms, for the holders `hold` starts from now on; null: none. */
  awayClock: (() => number) | null = null
  /** What the hello of each holder `hold` starts from now on offers. */
  holderCaps: string[] = ['core', 'local', 'hooks', 'mcp']
  /** Each frame of typed input any holder's program gets, with its holder. */
  onTyped: ((h: FakeHolder, bytes: Buffer) => void) | null = null
  /** B1f: the holders `hold` starts from now on are on Windows named pipes (FakeHolder.noHalfClose). */
  noHalfClose = false

  /** Every holder whose away clock ran out ends, as its own timer would end it. */
  tick(): void {
    for (const h of this.holders.values()) h.checkAway()
  }

  exec = async (file: string, args: string[]): Promise<ExecResult> => {
    this.calls.push({ file, args })
    this.tick()
    const [cmd] = args
    const opt = (name: string) => args[args.indexOf(name) + 1]
    if (cmd === 'version') return { code: 0, stdout: `${this.version}\n`, stderr: '' }
    if (cmd === 'hold') {
      const sid = opt('--session')
      if (this.holdGate) await this.holdGate
      const existing = this.holders.get(sid)
      if (existing && !existing.ended && !existing.gone) return { code: 3, stdout: '', stderr: 'aicc-helper: a holder for this session is already running\n' }
      const h = new FakeHolder(sid, opt('--label'), opt('--store'))
      if (this.awayClock) {
        h.awayClock = this.awayClock
        h.awaySince = this.awayClock()
      }
      if (this.holdBusy) h.launch = { t: 'term.launch' }
      h.caps = [...this.holderCaps]
      h.noHalfClose = this.noHalfClose
      h.onTyped = (b) => this.onTyped?.(h, b)
      h.writeRecord()
      this.holders.set(sid, h)
      this.made.push(h)
      const note = this.insideJob ? "aicc-helper: note: this process's job does not let a process leave it, so the holder runs inside the job and ends when the job does\n" : ''
      return { code: 0, stdout: `${JSON.stringify(h.record())}\n`, stderr: note }
    }
    if (cmd === 'list') {
      if (this.listGate) await this.listGate
      if (this.listFails) return { code: null, stdout: '', stderr: 'timed out' }
      const sessions = [...this.holders.values()].filter((h) => !h.ended && !h.gone).map((h) => h.record())
      return { code: 0, stdout: `${JSON.stringify({ v: 1, sessions, removed: 0, skipped: 0 })}\n`, stderr: '' }
    }
    if (cmd === 'selftest') {
      const nonce = opt('--nonce')
      const checks = [
        { name: 'frame-codec', ok: true },
        { name: 'local-transport', ok: this.selfTestOk, ...(this.selfTestOk ? {} : { detail: 'the pipe did not open' }) },
      ]
      return { code: this.selfTestOk ? 0 : 1, stdout: `AICC-RESULT ${nonce} ${JSON.stringify({ ok: this.selfTestOk, helper: '0.1.0', os: 'windows', arch: 'x86_64', checks })}\n`, stderr: '' }
    }
    return { code: 2, stdout: '', stderr: 'unknown command' }
  }

  openStream = async (endpoint: string): Promise<Duplex> => {
    this.tick()
    const h = [...this.holders.values()].find((x) => x.endpoint === endpoint && !x.ended && !x.gone && !x.unreachable)
    if (!h) throw new Error('no holder at that endpoint')
    return h.connect()
  }

  holds(): number {
    return this.calls.filter((c) => c.args[0] === 'hold').length
  }
}
