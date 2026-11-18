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
 * The away clock (section 15) runs only when a test gives the helper one
 * (`awayClock`): then a holder with no connection attached ends itself `away`
 * seconds after its start or after the last attached connection let go,
 * checked at each list, each connection and each tick(), as the holder's own
 * timer would. Without one, no holder ends by itself.
 */
import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { Duplex, PassThrough } from 'stream'
import { FrameReader, encodeJsonFrame, encodeRawFrame, type HolderRecord } from '../../../src/main/session-helper/protocol'
import type { ExecResult } from '../../../src/main/session-helper/manager'

const hex = (bytes: number) => randomBytes(bytes).toString('hex')

/**
 * Two ends of one in-memory connection: the app's, then the holder's. The app
 * destroying its end destroys the holder's too, with an AbortError the holder
 * side (a stand-in) takes no notice of; the app's end gets no such listener,
 * so an error the app leaves unhandled still fails the test.
 */
export function duplexPair(): [Duplex, Duplex] {
  const toB = new PassThrough()
  const toA = new PassThrough()
  const holderEnd = Duplex.from({ readable: toB, writable: toA })
  holderEnd.on('error', () => { /* the app let go */ })
  return [Duplex.from({ readable: toA, writable: toB }), holderEnd]
}

type Json = Record<string, unknown>

/** What one connection carried from the app, in order: raw frames (their size),
 *  control messages (their type), and the pongs the holder sent. */
export type ConnEvent = { raw: number } | { t: string } | { pong: true }

export class FakeConn {
  acked = false
  closed = false
  /** Typed input is refused on this connection until the app's next ping. */
  refusing = false
  readonly frames: Json[] = []
  readonly log: ConnEvent[] = []
  constructor(readonly holder: FakeHolder, readonly end: Duplex) {}
  sendJson(v: Json): void { if (!this.closed) this.end.write(encodeJsonFrame(v)) }
  sendRaw(b: Buffer): void {
    if (this.closed) return
    for (let i = 0; i < b.length; i += 65536) this.end.write(encodeRawFrame(b.subarray(i, i + 65536)))
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

  constructor(readonly sid: string, readonly label: string, readonly store: string) {
    this.endpoint = `\\\\.\\pipe\\aicc-helper-${sid}-${hex(16)}`
  }

  /** The attached connection let go: the away clock starts. */
  detached(): void {
    this.attached = null
    this.awaySince = this.awayClock ? this.awayClock() : null
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
    const hello = { proto: [1], helper: { version: this.helperVersion }, os: 'windows', arch: 'x86_64', caps: ['core', 'local'], session: { sid: this.sid, state: this.launch ? 'live' : 'new' } }
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
          continue
        }
        this.requests.push(m)
        this.answer(conn, m)
      }
    })
    mine.on('end', () => conn.close())
    return app
  }

  /** One frame of typed input, offered to the program as the holder does. */
  private typed(conn: FakeConn, bytes: Buffer): void {
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
        if (from > this.ring.length) return err('bad-field', 'from is past the ring')
        if (this.attached && this.attached !== conn) {
          const old = this.attached
          old.sendJson({ t: 'error', code: 'replaced', text: 'a newer connection attached to this terminal' })
          old.close()
        }
        this.attached = conn
        this.awaySince = null
        this.attaches++
        conn.sendJson({ t: 'term.attached', re, from, ring_start: 0, ring_end: this.ring.length, truncated: false, running: this.child !== 'exited', ...(this.child === 'exited' ? { code: this.code } : {}) })
        conn.sendRaw(this.ring.subarray(from))
        return
      }
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
      default:
        err('unknown-type', String(m.t))
    }
  }

  /** The program writes. */
  output(text: string): void {
    this.outputBytes(Buffer.from(text, 'utf8'))
  }

  outputBytes(b: Buffer): void {
    this.ring = Buffer.concat([this.ring, b])
    this.attached?.sendRaw(b)
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
