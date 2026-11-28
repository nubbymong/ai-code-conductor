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
 * events. A connection asks for `mcp` only when the manager was given the
 * tool functions for its session's CLI, which app-wiring.ts gives for the
 * agent sessions (2.1.3-beta.11, plan sections B1 and B2). A connection asks
 * for `screen` (the holder's screen reads, 2.1.3-beta.12, plan section A3)
 * only when it is given the `screen` option, which the manager gives a plain
 * terminal's connections: a take-over reads the holder's size with it
 * (readScreen; 2.1.3-beta.13, plan section A1). Beside `screen` it asks for
 * `title` (the screen's title in readScreen's answer, 2.1.3-beta.14, plan
 * section B1, aicc_planning#384) only when it is given the `title` option.
 * The manager gives both to a held agent session's connections when its
 * provider's composer rule reads the holder's screen (deps.screens;
 * 2.1.3-beta.14, plan section B2, aicc_planning#388). A connection asks for
 * `status` (the session's status line, 2.1.3-beta.18) only when it is given
 * the `status` option, which a tab through the session helper on another
 * machine is (remote-helper/session.ts); it then reports each `status` the
 * holder sends. A connection asks for `paste` (the session's pictures,
 * 2.1.3-beta.21, ADR-032) only when it is given the `paste` option, which
 * only a tab through the session helper on another machine is
 * (remote-helper/session.ts); it may then send a picture there (putFile).
 *
 * On a connection that acked `mcp`, the app sends a tool stream's messages
 * (sendMcp) only when the holder would read them, and ends its side of a
 * stream (closeMcp), answering each call still open on it with an error,
 * without a word to the holder, which takes no `mcp.close` from the attached
 * connection (section 15: its streams end with its attach).
 *
 * Typed input follows section 15 (Attach): a `ping` after every 16 frames or
 * 1 MiB, nothing more until its `pong`, and the frames the holder answered
 * `busy` (it takes no input while the program has stopped reading) sent
 * again, so the program never sees input with a gap in it. The keep-alive
 * ping is the same ping.
 */
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import { EventEmitter } from 'events'
import type { Duplex } from 'stream'
import {
  CONTROL_CHANNEL,
  FrameReader,
  HELLO_LINE_MAX,
  HELPER_HOOK_KINDS,
  HOOKS_CAP,
  JSON_DEPTH_MAX,
  LOCAL_CAPS,
  MCP_CAP,
  PASTE_CAP,
  PASTE_CHANNEL,
  PASTE_CHUNK_WAIT_MS,
  PASTE_NAME_RE,
  PASTE_PICTURE_MAX,
  PROTO_VERSION,
  SCREEN_CAP,
  STATUS_CAP,
  TERMINAL_CHANNEL,
  TITLE_CAP,
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
  readFileStored,
  readScreenRows,
  readStatusFrame,
  type Hello,
  type HookEventFrame,
  type McpMessage,
  type HelperOs,
  type HolderRecord,
  type ScreenRows,
  type StatusFrame,
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
  /** This connection takes hook events (an agent session whose hooks may go
   *  through its holder: Claude Code's by its settings file, and from
   *  2.1.3-beta.18 Codex's by its launch): `hooks` is acked when the holder
   *  offers it. */
  hooks?: boolean
  /** The hook kinds its session takes (2.1.3-beta.18: the kinds its package
   *  declares, SessionProvider.heldHookKinds; a session whose CLI runs the
   *  hook mode from its own environment declares them in its launch too, as
   *  `hookKinds`): only an event of one of these is reported. Absent: the
   *  nine (HELPER_HOOK_KINDS). */
  hookKinds?: readonly string[]
  /** This connection carries the session's tool streams: `mcp` is acked when
   *  the holder offers it. The manager sets it only when the app gives it the
   *  tool functions, which app-wiring.ts does for the agent sessions. */
  mcp?: boolean
  /** This connection reads the session's screen (`screen.read`,
   *  `screen.tail`): `screen` is acked when the holder offers it. The manager
   *  sets it for a plain terminal's connections, and (2.1.3-beta.14 B2) for a
   *  held agent session's of a provider in its deps.screens. */
  screen?: boolean
  /** This connection's screen reads take the screen's title too: `title` is
   *  acked, beside `screen`, when the holder offers both. The manager sets it
   *  beside `screen` for a held agent session's of a provider in its
   *  deps.screens (2.1.3-beta.14 B2). */
  title?: boolean
  /** This connection takes the session's status line: `status` is acked when
   *  the holder offers it (2.1.3-beta.18; a tab through the session helper on
   *  another machine). */
  status?: boolean
  /** This connection sends the session's pictures (`file.put`, putFile):
   *  `paste` is acked when the holder offers it (2.1.3-beta.21; a tab through
   *  the session helper on another machine only, ADR-032). */
  paste?: boolean
  helloTimeoutMs?: number
  replyTimeoutMs?: number
  pingEveryMs?: number
}

export const HELLO_TIMEOUT_MS = 10_000
export const REPLY_TIMEOUT_MS = 10_000
/** How long letGo() waits for its holder's answer: under the update's own
 *  bound (app-wiring.ts UPDATE_END_WAIT_MS), so an unanswered let-go closes
 *  its connection, and is logged, before the update kills the PTYs. */
export const LET_GO_WAIT_MS = 1_000
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
 * the holder cannot read closes the app's whole connection (`bad-frame`), and
 * one over the size draws `too-large`, 20 of which in a minute close it too
 * (section 12), so none is sent.
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

/** The id of the call one JSON-RPC message cancels (`notifications/cancelled`),
 *  or null. The tool host answers no call that is cancelled. */
function cancelledCall(m: unknown): string | number | null {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return null
  const r = m as Json
  if (r.method !== 'notifications/cancelled' || r.params === null || typeof r.params !== 'object') return null
  const id = (r.params as Json).requestId
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

/** The calls the relay has sent on one stream and the app has not answered,
 *  kept at most: a call past it is passed on as any other, but is not
 *  answered here when the app ends the stream. So a relay cannot grow the
 *  list without end. */
export const MCP_OPEN_CALLS_MAX = 1024

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
  /** The newest status line the holder passed on; only on a connection that acked `status`. */
  status: [s: StatusFrame]
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
  /** The hook kinds it reports (ConnectionOptions.hookKinds). */
  private readonly hookKinds: readonly string[]
  /** True when this connection acked `mcp`: the holder offered it and the
   *  connection wanted it. Only then are tool stream messages reported. */
  readonly mcp: boolean
  /** True when this connection acked `screen`: the holder offered it and the
   *  connection asked for it. Only then may it ask for screen reads. */
  readonly screen: boolean
  /** True when this connection acked `title` beside `screen`: the holder
   *  offered both and the connection asked for both. Only then does
   *  readScreen's answer carry the title. */
  readonly title: boolean
  /** True when this connection acked `status`: the holder offered it and the
   *  connection asked for it. Only then are status lines reported. */
  readonly status: boolean
  /** True when this connection acked `paste`: the holder offered it and the
   *  connection asked for it. Only then may it send a picture (putFile). */
  readonly paste: boolean
  /** A picture is being sent on this connection now (one at a time). */
  private putting = false
  private readonly stream: Duplex
  private readonly reader = new FrameReader('helper_to_app')
  private nextId = 2
  private readonly waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; onReply?: (m: Json, size: number) => void }>()
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
  /** The calls the relay sent on each open tool stream that the app has not
   *  answered (at most MCP_OPEN_CALLS_MAX a stream): when the app ends the
   *  stream, each is answered with an error (closeMcp). */
  private readonly mcpCalls = new Map<number, Set<string | number>>()
  /** Set by letGo() until the holder answers its `term.detach` (B1f). */
  private lettingGo: { id: number; done: (answered: boolean) => void } | null = null

  private constructor(stream: Duplex, hello: Hello, rest: Buffer, opts: ConnectionOptions) {
    super()
    this.stream = stream
    this.hello = hello
    this.hooks = opts.hooks === true && hello.caps.includes(HOOKS_CAP)
    this.hookKinds = opts.hookKinds ?? HELPER_HOOK_KINDS
    this.mcp = opts.mcp === true && hello.caps.includes(MCP_CAP)
    this.screen = opts.screen === true && hello.caps.includes(SCREEN_CAP)
    this.title = this.screen && opts.title === true && hello.caps.includes(TITLE_CAP)
    this.status = opts.status === true && hello.caps.includes(STATUS_CAP)
    this.paste = opts.paste === true && hello.caps.includes(PASTE_CAP)
    this.replyTimeoutMs = opts.replyTimeoutMs ?? REPLY_TIMEOUT_MS
    stream.on('data', (chunk: Buffer) => this.onBytes(chunk))
    stream.on('close', () => this.shut())
    stream.on('end', () => this.shut())
    stream.on('error', () => this.shut())
    stream.write(encodeJsonFrame(helloAck(this.hooks, this.mcp, this.screen, this.title, this.status, this.paste)))
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
   * that follows it (an attach's replay) is reported, with its size in bytes
   * as it came.
   */
  request(msg: Json & { t: string }, onReply?: (m: Json, size: number) => void): Promise<Json> {
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

  /**
   * The holder's screen now (`screen.read`), read strictly (readScreenRows):
   * only on a connection that acked `screen`, with its title on one that
   * acked `title` too (null on any other). Rejects when this one did not ack
   * `screen`, when the holder answers an error, and when its answer does not
   * read (a title on a connection that did not ack it included).
   */
  async readScreen(): Promise<ScreenRows> {
    if (!this.screen) throw new HolderError('unknown-type', 'this connection did not ack screen')
    // Set by the reply callback, which sees the frame's size.
    let screen = null as ScreenRows | null
    await this.request({ t: 'screen.read' }, (m, size) => { screen = readScreenRows(m, size, this.title) })
    if (!screen) throw new HolderError('bad-frame', 'the holder answered screen.read with a reply that does not read')
    return screen
  }

  /**
   * 2.1.3-beta.21 (ADR-032; section 15, capability `paste`): one picture into
   * the session's own `paste/` folder on the holder's machine, for its CLI's
   * own clipboard paste there. `file.put` {id, name, size, sha256} first, and
   * a ping after it: the holder answers a connection's messages in order and
   * refuses a `file.put` before it takes a byte, so a refusal comes before
   * that pong, and no byte goes for a refused picture (bytes on the paste
   * channel with no upload open close the connection). The ping is the
   * keep-alive's own (one already on its way is waited out first), so typed
   * input is paced as before. Then the bytes, as raw frames of at most 64 KiB
   * on the paste channel, never the terminal's; then the holder's
   * `file.stored` {re, sha256}, whose hash must be the picture's
   * (readFileStored; anything else is `bad-frame`). Resolves with that hash:
   * the reply carries no path, and nothing is typed from it.
   *
   * Refused here, with nothing sent: a connection that did not ack `paste`
   * (`unknown-type`), a name off PASTE_NAME_RE or no byte (`bad-field`), over
   * 20 MiB (`too-large`), and a second picture while one is being sent
   * (`busy`). The holder's refusal rejects with its code. Typed input goes on
   * meanwhile. The holder ends an upload with 30 s and no chunk itself; the
   * app's own wait is that and the reply timeout, from the last chunk written.
   */
  async putFile(name: string, bytes: Buffer): Promise<{ sha256: string }> {
    if (this.closed) throw new HolderError('io', 'the connection is closed')
    if (!this.paste) throw new HolderError('unknown-type', 'this connection did not ack paste')
    if (!PASTE_NAME_RE.test(name)) throw new HolderError('bad-field', 'a picture is named paste-<n>.png or paste-<n>.jpg, <n> 1 to 9 digits with no leading zero')
    if (bytes.length < 1) throw new HolderError('bad-field', 'a picture has at least one byte')
    if (bytes.length > PASTE_PICTURE_MAX) throw new HolderError('too-large', `a picture is at most ${PASTE_PICTURE_MAX} bytes`)
    if (this.putting) throw new HolderError('busy', 'a picture is being sent on this connection already')
    this.putting = true
    try {
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const id = this.takeId()
      const wait = PASTE_CHUNK_WAIT_MS + this.replyTimeoutMs
      const replied = new Promise<Json>((resolve, reject) => {
        this.waiting.set(id, { resolve, reject, timer: this.replyTimer(id, 'file.put', wait) })
      })
      // Read below; a refusal that comes while the bytes go is not left unhandled meanwhile.
      replied.catch(() => { /* read below */ })
      try {
        this.stream.write(encodeJsonFrame({ t: 'file.put', id, name, size: bytes.length, sha256 }))
      } catch (err) {
        this.dropWaiting(id)
        throw new HolderError('io', (err as Error).message)
      }
      await this.pongAfterNow()
      // Refused (or the connection went): no byte is sent, and the refusal is the answer.
      if (!this.waiting.has(id)) return this.stored(await replied, sha256)
      for (let at = 0; at < bytes.length; at += RAW_MAX) {
        if (this.closed || !this.waiting.has(id)) break
        let more: boolean
        try {
          more = this.stream.write(encodeRawFrame(bytes.subarray(at, at + RAW_MAX), PASTE_CHANNEL))
        } catch {
          this.close()
          break
        }
        if (!more) await this.drained()
        this.rearm(id, 'file.put', wait)
      }
      return this.stored(await replied, sha256)
    } finally {
      this.putting = false
    }
  }

  /** The reply to a `file.put` of the picture whose hash is `sha256`. */
  private stored(m: Json, sha256: string): { sha256: string } {
    const r = readFileStored(m)
    if (!r || r.sha256 !== sha256) throw new HolderError('bad-frame', 'the holder answered file.put with a reply that does not read, or that names another hash')
    return { sha256: r.sha256 }
  }

  /** A timer that, after `ms`, rejects request `id` if it still waits on this timer. */
  private replyTimer(id: number, what: string, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const w = this.waiting.get(id)
      if (!w || w.timer !== timer) return
      this.waiting.delete(id)
      w.reject(new HolderError('timeout', `the holder did not answer ${what}`))
    }, ms)
    timer.unref?.()
    return timer
  }

  /** Request `id`, still waiting, waits `ms` more from now. */
  private rearm(id: number, what: string, ms: number): void {
    const w = this.waiting.get(id)
    if (!w) return
    clearTimeout(w.timer)
    w.timer = this.replyTimer(id, what, ms)
  }

  private dropWaiting(id: number): void {
    const w = this.waiting.get(id)
    if (!w) return
    clearTimeout(w.timer)
    this.waiting.delete(id)
  }

  /** Who waits for the next pong (pongAfterNow); each is called at it, and at the close. */
  private pongWaiters: Array<() => void> = []

  private nextPong(): Promise<void> {
    if (this.closed) return Promise.resolve()
    return new Promise<void>((resolve) => { this.pongWaiters.push(resolve) })
  }

  /** The pong to a ping sent after everything written so far: the holder
   *  answers a connection's messages in order, so its answer to anything
   *  written before comes first. The keep-alive's ping is the one sent (its
   *  pong accounts for typed input as any other), after one already on its
   *  way has been answered. Returns at once once the connection is closed. */
  private async pongAfterNow(): Promise<void> {
    while (!this.closed && this.ping) await this.nextPong()
    if (this.closed) return
    this.sendPing()
    if (this.ping) await this.nextPong()
  }

  /** The stream takes more writes, or it closed. */
  private drained(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.closed) { resolve(); return }
      const done = (): void => {
        this.stream.off('drain', done)
        this.stream.off('close', done)
        resolve()
      }
      this.stream.on('drain', done)
      this.stream.on('close', done)
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
   * its place, the app's side of the stream ends (closeMcp, which answers each
   * other call still open on it), and the connection stays up.
   */
  sendMcp(stream: number, message: McpMessage): McpSendResult {
    if (this.closed || !this.mcp || !this.mcpStreams.has(stream)) return 'not-open'
    const answered = jsonRpcIds(message, false)
    const why = mcpMessageUnreadable(message)
    if (why === null && this.writeMcp(stream, message)) {
      this.settleCalls(stream, answered)
      return 'sent'
    }
    if (this.closed) return 'not-open'
    // Its calls are answered here, so closeMcp does not answer them again.
    this.settleCalls(stream, answered)
    const answer = toolErrors(answered, TOOL_STREAM_SENTENCES.notPassed, Array.isArray(message))
    if (answer && mcpMessageUnreadable(answer) === null) this.writeMcp(stream, answer)
    this.closeMcp(stream)
    return 'refused'
  }

  /**
   * The app's side of tool stream `stream` ends: each call the relay sent on
   * it that the app has not answered is answered with an error now, nothing
   * more is sent on it or reported from it, and each call the relay sends on
   * it later is answered with an error, until the holder ends it too. No
   * `mcp.close` goes: the holder takes none from the attached connection
   * (section 15).
   */
  closeMcp(stream: number): void {
    if (!this.mcpStreams.delete(stream)) return
    const open = this.mcpCalls.get(stream)
    this.mcpCalls.delete(stream)
    for (const id of open ?? []) {
      if (this.closed) return
      const answer = toolErrors([id], TOOL_STREAM_SENTENCES.ended, false)
      if (answer && mcpMessageUnreadable(answer) === null) this.writeMcp(stream, answer)
    }
    if (!this.closed) this.mcpEnded.add(stream)
  }

  /** Keep each call the relay sends on `stream`, in order, and drop each one
   *  it cancels: the tool host answers none of those. */
  private keepCalls(stream: number, message: McpMessage): void {
    let open = this.mcpCalls.get(stream)
    for (const item of Array.isArray(message) ? message : [message]) {
      const cancelled = cancelledCall(item)
      if (cancelled !== null) {
        open?.delete(cancelled)
        continue
      }
      for (const id of jsonRpcIds(item, true)) {
        if (!open) this.mcpCalls.set(stream, (open = new Set()))
        if (open.size < MCP_OPEN_CALLS_MAX) open.add(id)
      }
    }
  }

  /** The app answered these calls on `stream`. */
  private settleCalls(stream: number, ids: Array<string | number>): void {
    const open = this.mcpCalls.get(stream)
    if (open) for (const id of ids) open.delete(id)
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
    this.wakePongWaiters()
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

  /**
   * aicc_planning#423 (B1f): let go of the terminal with `term.detach`, in
   * place of close(), for an app update. A Windows named pipe has no
   * half-close: after close() the holder keeps this connection attached until
   * the app's handle closes, and each hook event it writes meanwhile leaves
   * its queue as sent while this side drops it unread. A holder answers
   * `term.detached`, sends nothing after it and closes (section 15), so a
   * later event waits in its queue for the next attach. From the call the
   * connection is closed as close() closes it, except that it still reads,
   * and reports, the hook events the holder sent before its answer; nothing
   * else it reads is reported. True once the holder answered; false when it
   * did not within LET_GO_WAIT_MS, or the connection went first. The stream
   * is closed either way.
   */
  letGo(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    const id = this.takeId()
    try {
      this.stream.write(encodeJsonFrame({ t: 'term.detach', id }))
    } catch {
      this.close()
      return Promise.resolve(false)
    }
    return new Promise<boolean>((resolve) => {
      const done = (answered: boolean): void => {
        if (this.lettingGo?.id !== id) return
        this.lettingGo = null
        clearTimeout(timer)
        try { this.stream.destroy() } catch { /* gone */ }
        resolve(answered)
      }
      const timer = setTimeout(() => done(false), Math.min(this.replyTimeoutMs, LET_GO_WAIT_MS))
      timer.unref?.()
      this.lettingGo = { id, done }
      this.stream.once('close', () => done(false))
      this.shut()
    })
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
    this.mcpCalls.clear()
    this.wakePongWaiters()
    this.emit('close')
  }

  /** A pong came, or the connection closed: each waiter for one goes on. */
  private wakePongWaiters(): void {
    const waiters = this.pongWaiters
    this.pongWaiters = []
    for (const w of waiters) w()
  }

  private onBytes(chunk: Buffer): void {
    if (this.closed && !this.lettingGo) return
    let frames
    try {
      frames = this.reader.push(chunk)
    } catch {
      this.close()
      this.lettingGo?.done(false)
      return
    }
    for (const f of frames) {
      if (this.closed) {
        // Letting go (letGo): the hook events before the holder's answer, then its answer; nothing else.
        const going = this.lettingGo
        if (!going) return
        if (f.kind === 1 || f.channel !== CONTROL_CHANNEL) continue
        const m = f.json as Json
        if (!m || typeof m !== 'object' || Array.isArray(m)) continue
        if (m.t === 'event') {
          const e = this.hooks ? readEventFrame(m, f.size, this.hookKinds) : null
          if (e) this.emit('event', e)
        } else if (m.re === going.id) going.done(m.t === 'term.detached')
        continue
      }
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
        const e = this.hooks ? readEventFrame(m, f.size, this.hookKinds) : null
        if (e) this.emit('event', e)
        continue
      }
      if (m.t === 'status') {
        // The newest status line, read the same way: before any reply lookup
        // (a `status` that carries a `re` is refused by its exact fields),
        // strictly, and reported only on a connection that acked `status`.
        const s = this.status ? readStatusFrame(m, f.size) : null
        if (s) this.emit('status', s)
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
          try { w.onReply?.(m, f.size) } catch { /* the caller's own */ }
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
        this.keepCalls(r.stream, r.message)
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
      this.mcpCalls.delete(r.stream)
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
