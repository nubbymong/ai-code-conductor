/**
 * One connection from the app to a holder (docs/remote/helper-protocol.md,
 * sections 6, 7 and 15).
 *
 * The app writes nothing until the holder's hello line has been read and
 * checked: its nonce must be the one in the holder's record and its session
 * the one asked for, so a process that took the endpoint's name first learns
 * nothing from the app. Then the app acks `core` and `local` and the
 * connection carries requests (even ids, one reply each), terminal output and
 * the holder's events.
 *
 * Typed input follows section 15 (Attach): a `ping` after every 16 frames or
 * 1 MiB, nothing more until its `pong`, and the frames the holder answered
 * `busy` (it takes no input while the program has stopped reading) sent
 * again, so the program never sees input with a gap in it. The keep-alive
 * ping is the same ping.
 */
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import { EventEmitter } from 'events'
import type { Duplex } from 'stream'
import {
  FrameReader,
  HELLO_LINE_MAX,
  LOCAL_CAPS,
  PROTO_VERSION,
  TERMINAL_CHANNEL,
  chooseProto,
  RAW_MAX,
  encodeJsonFrame,
  encodeRawFrame,
  endpointUid,
  helloAck,
  parseHelloLine,
  type Hello,
  type HelperOs,
  type HolderRecord,
} from './protocol'

/** A refusal or failure, with the protocol's code when the holder named one. */
export class HolderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export interface ConnectionOptions {
  record: HolderRecord
  os: HelperOs
  /** The helper's SHA-256: a hello that names another one is refused. */
  sha256?: string
  /** Opens the endpoint. Tests hand a stream of their own. */
  openStream?: (endpoint: string) => Promise<Duplex>
  /** Section 15's folder check on Unix. Tests skip it. */
  checkEndpointFolder?: (endpoint: string) => string | null
  helloTimeoutMs?: number
  replyTimeoutMs?: number
  pingEveryMs?: number
}

export const HELLO_TIMEOUT_MS = 10_000
export const REPLY_TIMEOUT_MS = 10_000
/** The holder closes a connection idle for 60 s; the app pings every 15 s. */
export const PING_EVERY_MS = 15_000
/** Typed input between two pings, at most (section 15). */
export const INPUT_FRAMES_PER_PING = 16
export const INPUT_BYTES_PER_PING = 1024 * 1024
/** How long input the program did not take waits before it is sent again:
 *  the first time, and at most (the wait doubles while the program reads
 *  nothing). */
export const RESEND_WAIT_MIN_MS = 25
export const RESEND_WAIT_MAX_MS = 400

type Json = Record<string, unknown>

/**
 * Before connecting on Unix: the endpoint's folder must be a real folder (not
 * a link), owned by this user, open to nobody else (section 15). Null when it
 * is; otherwise why not.
 */
export function unixEndpointFolderProblem(endpoint: string): string | null {
  const uid = endpointUid(endpoint)
  const mine = typeof process.getuid === 'function' ? process.getuid() : -1
  if (uid === null || uid !== mine) return 'the endpoint is not in this user\'s folder'
  try {
    const st = fs.lstatSync(path.posix.dirname(endpoint))
    if (!st.isDirectory() || st.isSymbolicLink()) return 'the endpoint folder is not a real folder'
    if (st.uid !== mine) return 'the endpoint folder belongs to another user'
    if ((st.mode & 0o077) !== 0) return 'the endpoint folder is open to other users'
  } catch {
    return 'the endpoint folder cannot be read'
  }
  return null
}

/** Let go of a stream the hello was refused on: what it reports after this is not news. */
function drop(stream: Duplex): void {
  stream.on('error', () => { /* already let go */ })
  stream.destroy()
}

function netStream(endpoint: string, timeoutMs: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(endpoint)
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new HolderError('timeout', 'the holder did not answer the connection'))
    }, timeoutMs)
    sock.once('connect', () => {
      clearTimeout(timer)
      resolve(sock)
    })
    sock.once('error', (err) => {
      clearTimeout(timer)
      reject(new HolderError('io', `the holder could not be reached: ${err.message}`))
    })
  })
}

/** What a connection reports. */
export type HolderConnectionEvents = {
  output: [bytes: Buffer]
  exit: [code: number | null]
  /** An error frame with no `re`: `replaced`, `busy` and the like. */
  notice: [code: string, text: string]
  close: []
}

export class HolderConnection extends EventEmitter<HolderConnectionEvents> {
  readonly hello: Hello
  private readonly stream: Duplex
  private readonly reader = new FrameReader('helper_to_app')
  private nextId = 2
  private readonly waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; onReply?: (m: Json) => void }>()
  private pinger: ReturnType<typeof setInterval> | undefined
  private closed = false
  private readonly replyTimeoutMs: number
  /** Typed input not sent yet: it waits for a pong, or to be sent again. */
  private unsent: Buffer[] = []
  /** Typed input sent since the last ping went. */
  private window: Buffer[] = []
  private windowBytes = 0
  /** The ping on its way: its id, the typed input sent before it, its timer. */
  private ping: { id: number; frames: Buffer[]; timer: ReturnType<typeof setTimeout> } | null = null
  /** `busy` notices since the last pong: frames of typed input not taken. */
  private busySincePong = 0
  private resendWait = 0
  private resendTimer: ReturnType<typeof setTimeout> | undefined

  private constructor(stream: Duplex, hello: Hello, rest: Buffer, opts: ConnectionOptions) {
    super()
    this.stream = stream
    this.hello = hello
    this.replyTimeoutMs = opts.replyTimeoutMs ?? REPLY_TIMEOUT_MS
    stream.on('data', (chunk: Buffer) => this.onBytes(chunk))
    stream.on('close', () => this.shut())
    stream.on('end', () => this.shut())
    stream.on('error', () => this.shut())
    stream.write(encodeJsonFrame(helloAck()))
    if (rest.length > 0) this.onBytes(rest)
    stream.resume()
    const every = opts.pingEveryMs ?? PING_EVERY_MS
    if (every > 0) {
      // The keep-alive. A ping already on its way keeps the connection alive too.
      this.pinger = setInterval(() => { if (!this.ping) this.sendPing() }, every)
      this.pinger.unref?.()
    }
  }

  /** Open a connection to the holder of `record` and complete the hello. */
  static async open(opts: ConnectionOptions): Promise<HolderConnection> {
    const { record } = opts
    if (opts.os === 'unix') {
      const problem = (opts.checkEndpointFolder ?? unixEndpointFolderProblem)(record.endpoint)
      if (problem) throw new HolderError('denied', problem)
    }
    const helloMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS
    const stream = await (opts.openStream ? opts.openStream(record.endpoint) : netStream(record.endpoint, helloMs))
    const { line, rest } = await readHelloLine(stream, helloMs).catch((err) => {
      drop(stream)
      throw err
    })
    let hello: Hello
    try {
      hello = parseHelloLine(line, record.nonce, record.session)
      if (chooseProto([PROTO_VERSION], hello.proto) !== PROTO_VERSION) throw new HolderError('proto-mismatch', 'the holder speaks no protocol version the app does')
      for (const cap of LOCAL_CAPS) if (!hello.caps.includes(cap)) throw new HolderError('proto-mismatch', `the holder does not offer ${cap}`)
      if (opts.sha256 && hello.sha256 && hello.sha256 !== opts.sha256) throw new HolderError('hash-mismatch', 'the holder is not the helper the app installed')
    } catch (err) {
      drop(stream)
      if (err instanceof HolderError) throw err
      throw new HolderError('no-hello', (err as Error).message)
    }
    return new HolderConnection(stream, hello, rest, opts)
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** True when a `busy` came since the last pong: a close after it may be the
   *  one a connection that fell behind its output gets (section 15). */
  get closedAfterBusy(): boolean {
    return this.busySincePong > 0
  }

  /**
   * Send one request and wait for its reply. An `error` reply rejects.
   * `onReply` sees a reply that is not an error at once, before any frame
   * that follows it (an attach's replay) is reported.
   */
  request(msg: Json & { t: string }, onReply?: (m: Json) => void): Promise<Json> {
    if (this.closed) return Promise.reject(new HolderError('io', 'the connection is closed'))
    const id = this.takeId()
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new HolderError('timeout', `the holder did not answer ${msg.t}`))
      }, this.replyTimeoutMs)
      timer.unref?.()
      this.waiting.set(id, { resolve, reject, timer, onReply })
      try {
        this.stream.write(encodeJsonFrame({ ...msg, id }))
      } catch (err) {
        clearTimeout(timer)
        this.waiting.delete(id)
        reject(new HolderError('io', (err as Error).message))
      }
    })
  }

  private takeId(): number {
    const id = this.nextId
    this.nextId += 2
    return id
  }

  /** Terminal input, as raw frames of at most 64 KiB on the terminal channel,
   *  paced by pings (section 15). */
  sendInput(bytes: Buffer): void {
    if (this.closed || bytes.length === 0) return
    for (let i = 0; i < bytes.length; i += RAW_MAX) this.unsent.push(Buffer.from(bytes.subarray(i, i + RAW_MAX)))
    this.pump()
  }

  /**
   * Typed input this connection has not sent, oldest first, taken off it: for
   * the next connection, once this one closed. What it sent and the holder had
   * not answered for by then is not in it, so nothing is ever typed twice.
   */
  takeUnsent(): Buffer[] {
    const out = this.unsent
    this.unsent = []
    return out
  }

  private pump(): void {
    while (!this.closed && !this.ping && this.resendTimer === undefined && this.unsent.length > 0) {
      const chunk = this.unsent.shift()!
      try {
        this.stream.write(encodeRawFrame(chunk))
      } catch {
        this.unsent.unshift(chunk)
        this.close()
        return
      }
      this.window.push(chunk)
      this.windowBytes += chunk.length
      if (this.window.length >= INPUT_FRAMES_PER_PING || this.windowBytes >= INPUT_BYTES_PER_PING) this.sendPing()
    }
  }

  /** A ping: the typed input sent before it is accounted for by its pong. A
   *  pong that does not come in time closes the connection. */
  private sendPing(): void {
    if (this.closed || this.ping) return
    const id = this.takeId()
    const timer = setTimeout(() => this.close(), this.replyTimeoutMs)
    timer.unref?.()
    this.ping = { id, frames: this.window, timer }
    this.window = []
    this.windowBytes = 0
    try {
      this.stream.write(encodeJsonFrame({ t: 'ping', id }))
    } catch {
      this.close()
    }
  }

  /**
   * The pong: each `busy` before it was a frame of typed input not taken, the
   * last ones before the ping. Those are sent again, after a short wait that
   * grows while the program reads nothing, and the rest of the input follows.
   */
  private onPong(): void {
    const ping = this.ping!
    clearTimeout(ping.timer)
    this.ping = null
    const refused = Math.min(this.busySincePong, ping.frames.length)
    this.busySincePong = 0
    if (refused === 0) {
      this.resendWait = 0
      this.pump()
      return
    }
    this.unsent.unshift(...ping.frames.slice(ping.frames.length - refused))
    this.resendWait = Math.min(RESEND_WAIT_MAX_MS, Math.max(RESEND_WAIT_MIN_MS, this.resendWait * 2))
    this.resendTimer = setTimeout(() => {
      this.resendTimer = undefined
      this.pump()
    }, this.resendWait)
    this.resendTimer.unref?.()
  }

  close(): void {
    if (this.closed) return
    try { this.stream.end() } catch { /* already gone */ }
    setTimeout(() => { try { this.stream.destroy() } catch { /* gone */ } }, 1000).unref?.()
    this.shut()
  }

  private shut(): void {
    if (this.closed) return
    this.closed = true
    if (this.pinger) clearInterval(this.pinger)
    if (this.ping) clearTimeout(this.ping.timer)
    if (this.resendTimer !== undefined) clearTimeout(this.resendTimer)
    this.resendTimer = undefined
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer)
      w.reject(new HolderError('io', 'the connection closed'))
    }
    this.waiting.clear()
    this.emit('close')
  }

  private onBytes(chunk: Buffer): void {
    if (this.closed) return
    let frames
    try {
      frames = this.reader.push(chunk)
    } catch {
      this.close()
      return
    }
    for (const f of frames) {
      if (f.kind === 1) {
        if (f.channel === TERMINAL_CHANNEL) this.emit('output', f.bytes)
        continue
      }
      const m = f.json as Json
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') continue
      const re = typeof m.re === 'number' ? m.re : undefined
      if (re !== undefined && this.ping && re === this.ping.id) {
        this.onPong()
        continue
      }
      if (re !== undefined && this.waiting.has(re)) {
        const w = this.waiting.get(re)!
        this.waiting.delete(re)
        clearTimeout(w.timer)
        if (m.t === 'error') {
          w.reject(new HolderError(String(m.code ?? 'internal'), String(m.text ?? '')))
        } else {
          try { w.onReply?.(m) } catch { /* the caller's own */ }
          w.resolve(m)
        }
        continue
      }
      if (m.t === 'term.exit') {
        this.emit('exit', typeof m.code === 'number' ? m.code : null)
      } else if (m.t === 'error') {
        const code = String(m.code ?? 'internal')
        if (code === 'busy' && re === undefined) {
          // Typed input not taken (or, when the stream ends next, a connection
          // that fell behind). The next pong counts it; a ping goes now, so
          // the input after it is not refused for longer than it must be.
          this.busySincePong++
          if (!this.ping && this.window.length > 0) this.sendPing()
        }
        this.emit('notice', code, String(m.text ?? ''))
      }
    }
  }
}

/** Read the hello line: bytes up to the first line end, at most 4 KiB. */
function readHelloLine(stream: Duplex, timeoutMs: number): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const done = (err: Error | null, value?: { line: string; rest: Buffer }) => {
      clearTimeout(timer)
      stream.off('data', onData)
      stream.off('close', onClose)
      stream.off('error', onClose)
      if (err) reject(err)
      else resolve(value!)
    }
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      const nl = buf.indexOf(0x0a)
      if (nl < 0) {
        if (buf.length > HELLO_LINE_MAX + 1) done(new HolderError('no-hello', 'the hello line is over 4 KiB'))
        return
      }
      // Paused until the connection takes the stream over: a chunk read
      // before its listener is on would be lost.
      stream.pause()
      let end = nl
      if (end > 0 && buf[end - 1] === 0x0d) end--
      done(null, { line: buf.subarray(0, end).toString('utf8'), rest: Buffer.from(buf.subarray(nl + 1)) })
    }
    const onClose = () => done(new HolderError('no-hello', 'the holder closed the connection before its hello'))
    const timer = setTimeout(() => done(new HolderError('timeout', 'the holder sent no hello in time')), timeoutMs)
    stream.on('data', onData)
    stream.once('close', onClose)
    stream.once('error', onClose)
  })
}
