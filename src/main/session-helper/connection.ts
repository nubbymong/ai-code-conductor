/**
 * One connection from the app to a holder (docs/remote/helper-protocol.md,
 * sections 6, 7 and 15).
 *
 * The app writes nothing until the holder's hello line has been read and
 * checked: its nonce must be the one in the holder's record and its session
 * the one asked for, so a process that took the endpoint's name first learns
 * nothing from the app. Then the app acks `core` and `local` (and `hooks`, for
 * a connection that takes hook events, and `mcp`, for one that carries tool
 * streams, each when the holder offers it) and the connection carries
 * requests (even ids, one reply each), terminal output and the holder's
 * events. No connection the app makes asks for `mcp` yet (2.1.3-beta.10):
 * the manager does only when the app gives it the tool functions, and
 * app-wiring.ts gives none yet (2.1.3-beta.11, plan section B1).
 *
 * On a connection that acked `mcp`, the app sends a tool stream's messages
 * (sendMcp) only when the holder would read them, and ends its side of a
 * stream (closeMcp) without a word to the holder, which takes no `mcp.close`
 * from the attached connection (section 15: its streams end with its attach).
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
  CONTROL_CHANNEL,
  FrameReader,
  HELLO_LINE_MAX,
  HOOKS_CAP,
  JSON_DEPTH_MAX,
  LOCAL_CAPS,
  MCP_CAP,
  PROTO_VERSION,
  TERMINAL_CHANNEL,
  chooseProto,
  RAW_MAX,
  encodeJsonFrame,
  encodeRawFrame,
  endpointUid,
  helloAck,
  nestsDeeperThan,
  parseHelloLine,
  readEventFrame,
  readMcp,
  readMcpClose,
  readMcpOpen,
  type Hello,
  type HookEventFrame,
  type McpMessage,
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
  /** This connection takes hook events (a Claude Code session whose hooks may
   *  go through its holder): `hooks` is acked when the holder offers it. */
  hooks?: boolean
  /** This connection carries the session's tool streams: `mcp` is acked when
   *  the holder offers it. The manager sets it only when the app gives it the
   *  tool functions, and app-wiring.ts gives none yet. */
  mcp?: boolean
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

/** A tool message's `message`, as compact JSON, at most, on its way to the
 *  holder: 16 MiB less the room the `mcp` around it needs (section 15). */
export const MCP_MESSAGE_TO_HELPER_MAX = 16_776_960

/** What answers a call the app cannot pass on, and each call on a stream the
 *  app has ended: the JSON-RPC error for an internal error. */
const TOOL_ERROR_CODE = -32603
export const TOOL_STREAM_SENTENCES = {
  notPassed: 'This answer could not be passed through the session helper, so this tool connection has ended.',
  ended: 'This tool connection has ended.',
} as const

/** The UTF-16 unit a JSON `\u` escape at `at` (just after its `u`) gives, or -1. */
function escapedUnit(text: string, at: number): number {
  const hex = text.slice(at, at + 4)
  return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : -1
}

/** True when JSON text holds a `\u` escape of a surrogate that is not half of
 *  an escaped pair: what JSON.stringify writes for a lone surrogate, and what
 *  the holder's reader refuses. A backslash is only ever inside a string, so
 *  every one is an escape. */
function escapesLoneSurrogate(text: string): boolean {
  for (let i = text.indexOf('\\'); i >= 0; i = text.indexOf('\\', i)) {
    if (text[i + 1] !== 'u') {
      i += 2
      continue
    }
    const unit = escapedUnit(text, i + 2)
    if (unit >= 0xdc00 && unit <= 0xdfff) return true
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.slice(i + 6, i + 8) === '\\u' ? escapedUnit(text, i + 8) : -1
      if (low < 0xdc00 || low > 0xdfff) return true
      i += 12
      continue
    }
    i += 6
  }
  return false
}

/**
 * Why the holder would not read this as an `mcp` message's `message`, or null
 * when it would: it must be a JSON object or array, at most
 * MCP_MESSAGE_TO_HELPER_MAX bytes as compact JSON, at most 31 levels deep
 * (the `mcp` around it is the 32nd), with no escaped lone surrogate. A frame
 * the holder cannot read closes the app's whole connection (`bad-frame`), so
 * none is sent.
 */
export function mcpMessageUnreadable(message: unknown): string | null {
  if (message === null || typeof message !== 'object') return 'it is not a JSON object or array'
  let text: string
  try {
    text = JSON.stringify(message)
  } catch {
    return 'it is not JSON'
  }
  if (typeof text !== 'string') return 'it is not JSON'
  if (Buffer.byteLength(text, 'utf8') > MCP_MESSAGE_TO_HELPER_MAX) return `it is over ${MCP_MESSAGE_TO_HELPER_MAX} bytes as JSON`
  if (nestsDeeperThan(Buffer.from(text, 'utf8'), JSON_DEPTH_MAX - 1)) return `it nests deeper than ${JSON_DEPTH_MAX - 1} levels`
  if (escapesLoneSurrogate(text)) return 'it holds a lone surrogate'
  return null
}

/** The ids of the calls a JSON-RPC message (or batch) asks (`calls`: each
 *  request) or answers (each response), as JSON-RPC ids are: a string or a
 *  number. */
function jsonRpcIds(message: unknown, calls: boolean): Array<string | number> {
  const one = (m: unknown): Array<string | number> => {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return []
    const r = m as Json
    const id = r.id
    if (typeof id !== 'string' && typeof id !== 'number') return []
    const isCall = typeof r.method === 'string'
    const isAnswer = 'result' in r || 'error' in r
    return (calls ? isCall : isAnswer && !isCall) ? [id] : []
  }
  return Array.isArray(message) ? message.flatMap(one) : one(message)
}

/** JSON-RPC errors for these ids: a batch when what they answer was one,
 *  else one message. Null when there is no id to answer. */
function toolErrors(ids: Array<string | number>, text: string, batch: boolean): Json | Json[] | null {
  const errors = ids.map((id) => ({ jsonrpc: '2.0', id, error: { code: TOOL_ERROR_CODE, message: text } }))
  if (errors.length === 0) return null
  return batch ? errors : errors[0]
}

/** What became of a tool message the app had for its holder (sendMcp). */
export type McpSendResult = 'sent' | 'refused' | 'not-open'

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
  /** A hook event the holder passed on; only on a connection that acked `hooks`. */
  event: [e: HookEventFrame]
  /** A relay opened a tool stream (the holder's number for it); only on a
   *  connection that acked `mcp`, as are the next two. */
  mcpOpen: [stream: number]
  /** One JSON-RPC message on a tool stream. Untrusted. */
  mcp: [stream: number, message: McpMessage]
  /** A tool stream ended. */
  mcpClose: [stream: number]
  close: []
}

export class HolderConnection extends EventEmitter<HolderConnectionEvents> {
  readonly hello: Hello
  /** True when this connection acked `hooks`: the holder offered it and the
   *  connection wanted it. Only then are hook events reported. */
  readonly hooks: boolean
  /** True when this connection acked `mcp`: the holder offered it and the
   *  connection wanted it. Only then are tool stream messages reported. */
  readonly mcp: boolean
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
  /** Tool streams the holder opened on this connection and has not ended,
   *  that the app has not ended either. */
  private readonly mcpStreams = new Set<number>()
  /** Tool streams the app ended (closeMcp) and the holder has not: each call
   *  on one is answered with an error here, and nothing on it is reported. */
  private readonly mcpEnded = new Set<number>()

  private constructor(stream: Duplex, hello: Hello, rest: Buffer, opts: ConnectionOptions) {
    super()
    this.stream = stream
    this.hello = hello
    this.hooks = opts.hooks === true && hello.caps.includes(HOOKS_CAP)
    this.mcp = opts.mcp === true && hello.caps.includes(MCP_CAP)
    this.replyTimeoutMs = opts.replyTimeoutMs ?? REPLY_TIMEOUT_MS
    stream.on('data', (chunk: Buffer) => this.onBytes(chunk))
    stream.on('close', () => this.shut())
    stream.on('end', () => this.shut())
    stream.on('error', () => this.shut())
    stream.write(encodeJsonFrame(helloAck(this.hooks, this.mcp)))
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

  /**
   * One JSON-RPC message (or a batch) on tool stream `stream`, as one `mcp`
   * frame: only on a connection that acked `mcp`, on a stream the holder
   * opened here and neither side has ended ('not-open' otherwise, and nothing
   * is sent). A message the holder would not read (mcpMessageUnreadable) is
   * not sent ('refused'): the calls it answered are answered with an error in
   * its place, the app's side of the stream ends (closeMcp), and the
   * connection stays up.
   */
  sendMcp(stream: number, message: McpMessage): McpSendResult {
    if (this.closed || !this.mcp || !this.mcpStreams.has(stream)) return 'not-open'
    const why = mcpMessageUnreadable(message)
    if (why === null && this.writeMcp(stream, message)) return 'sent'
    if (this.closed) return 'not-open'
    const answer = toolErrors(jsonRpcIds(message, false), TOOL_STREAM_SENTENCES.notPassed, Array.isArray(message))
    if (answer && mcpMessageUnreadable(answer) === null) this.writeMcp(stream, answer)
    this.closeMcp(stream)
    return 'refused'
  }

  /**
   * The app's side of tool stream `stream` ends: nothing more is sent on it
   * or reported from it, and each call the relay sends on it is answered with
   * an error, until the holder ends it too. No `mcp.close` goes: the holder
   * takes none from the attached connection (section 15).
   */
  closeMcp(stream: number): void {
    if (!this.mcpStreams.delete(stream)) return
    this.mcpEnded.add(stream)
  }

  /** One `mcp` frame. False when it was not written (the connection then
   *  closes when the stream itself failed). */
  private writeMcp(stream: number, message: McpMessage): boolean {
    let frame: Buffer
    try {
      frame = encodeJsonFrame({ t: 'mcp', stream, message })
    } catch {
      return false
    }
    try {
      this.stream.write(frame)
      return true
    } catch {
      this.close()
      return false
    }
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
    this.mcpStreams.clear()
    this.mcpEnded.clear()
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
      // Every control message travels on channel 0 (section 6; a holder sends
      // all its JSON there): one on another channel is dropped, whatever it
      // carries, and answers no request.
      if (f.channel !== CONTROL_CHANNEL) continue
      const m = f.json as Json
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') continue
      if (m.t === 'event') {
        // A hook event, read as one before any reply lookup (an `event` that
        // carries a `re` is refused by its exact fields, and answers no
        // request): strictly, and reported only on a connection that acked
        // hooks. One that does not read is dropped (a holder sends none).
        const e = this.hooks ? readEventFrame(m, f.size) : null
        if (e) this.emit('event', e)
        continue
      }
      if (m.t === 'mcp.open' || m.t === 'mcp' || m.t === 'mcp.close') {
        // A tool stream message, read as one before any reply lookup (they
        // carry no `re`), strictly, and reported only on a connection that
        // acked `mcp`. One that does not read is dropped (a holder sends none).
        if (this.mcp) this.onMcp(m, f.size)
        continue
      }
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

  /** A tool stream message, on a connection that acked `mcp`. One on a stream
   *  the holder did not open here is dropped (a holder sends none). */
  private onMcp(m: Json, size: number): void {
    if (m.t === 'mcp') {
      const r = readMcp(m, size)
      if (!r) return
      if (this.mcpStreams.has(r.stream)) {
        this.emit('mcp', r.stream, r.message)
      } else if (this.mcpEnded.has(r.stream)) {
        const answer = toolErrors(jsonRpcIds(r.message, true), TOOL_STREAM_SENTENCES.ended, Array.isArray(r.message))
        if (answer && mcpMessageUnreadable(answer) === null) this.writeMcp(r.stream, answer)
      }
    } else if (m.t === 'mcp.open') {
      const r = readMcpOpen(m)
      if (!r || this.mcpStreams.has(r.stream) || this.mcpEnded.has(r.stream)) return
      this.mcpStreams.add(r.stream)
      this.emit('mcpOpen', r.stream)
    } else {
      const r = readMcpClose(m)
      if (!r) return
      this.mcpEnded.delete(r.stream)
      if (this.mcpStreams.delete(r.stream)) this.emit('mcpClose', r.stream)
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
