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
  encodeInput,
  encodeJsonFrame,
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

export interface HolderConnectionEvents {
  output: (bytes: Buffer) => void
  exit: (code: number | null) => void
  /** An error frame with no `re`: `replaced`, `busy` and the like. */
  notice: (code: string, text: string) => void
  close: () => void
}

export class HolderConnection extends EventEmitter {
  readonly hello: Hello
  private readonly stream: Duplex
  private readonly reader = new FrameReader('helper_to_app')
  private nextId = 2
  private readonly waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private pinger: ReturnType<typeof setInterval> | undefined
  private closed = false
  private readonly replyTimeoutMs: number

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
      this.pinger = setInterval(() => {
        this.request({ t: 'ping' }).catch(() => this.close())
      }, every)
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
      stream.destroy()
      throw err
    })
    let hello: Hello
    try {
      hello = parseHelloLine(line, record.nonce, record.session)
      if (chooseProto([PROTO_VERSION], hello.proto) !== PROTO_VERSION) throw new HolderError('proto-mismatch', 'the holder speaks no protocol version the app does')
      for (const cap of LOCAL_CAPS) if (!hello.caps.includes(cap)) throw new HolderError('proto-mismatch', `the holder does not offer ${cap}`)
      if (opts.sha256 && hello.sha256 && hello.sha256 !== opts.sha256) throw new HolderError('hash-mismatch', 'the holder is not the helper the app installed')
    } catch (err) {
      stream.destroy()
      if (err instanceof HolderError) throw err
      throw new HolderError('no-hello', (err as Error).message)
    }
    return new HolderConnection(stream, hello, rest, opts)
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Send one request and wait for its reply. An `error` reply rejects. */
  request(msg: Json & { t: string }): Promise<Json> {
    if (this.closed) return Promise.reject(new HolderError('io', 'the connection is closed'))
    const id = this.nextId
    this.nextId += 2
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new HolderError('timeout', `the holder did not answer ${msg.t}`))
      }, this.replyTimeoutMs)
      timer.unref?.()
      this.waiting.set(id, { resolve, reject, timer })
      try {
        this.stream.write(encodeJsonFrame({ ...msg, id }))
      } catch (err) {
        clearTimeout(timer)
        this.waiting.delete(id)
        reject(new HolderError('io', (err as Error).message))
      }
    })
  }

  /** Terminal input, as raw frames on the terminal channel. */
  sendInput(bytes: Buffer): void {
    if (this.closed || bytes.length === 0) return
    for (const frame of encodeInput(bytes)) this.stream.write(frame)
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
      if (re !== undefined && this.waiting.has(re)) {
        const w = this.waiting.get(re)!
        this.waiting.delete(re)
        clearTimeout(w.timer)
        if (m.t === 'error') w.reject(new HolderError(String(m.code ?? 'internal'), String(m.text ?? '')))
        else w.resolve(m)
        continue
      }
      if (m.t === 'term.exit') this.emit('exit', typeof m.code === 'number' ? m.code : null)
      else if (m.t === 'error') this.emit('notice', String(m.code ?? 'internal'), String(m.text ?? ''))
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
