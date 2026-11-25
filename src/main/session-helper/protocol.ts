/**
 * The session helper's local protocol, as the app speaks it
 * (docs/remote/helper-protocol.md: section 6 frames, section 7 the hello,
 * section 15 the local transport).
 *
 * Pure: no sockets, no files, no Electron. The connection
 * (connection.ts) and the manager (manager.ts) build on it. The
 * helper's own Rust code and the shared vectors in helper/fixtures/*.json fix
 * every rule here; tests/unit/main/session-helper-protocol.test.ts runs this
 * file against those vectors, so a change on the helper's side shows up here
 * as a failing vector.
 */
import { createHash } from 'crypto'

/** Which family of rules applies: the Windows pipe, or the Unix socket. */
export type HelperOs = 'windows' | 'unix'
export const helperOs = (platform: NodeJS.Platform = process.platform): HelperOs => (platform === 'win32' ? 'windows' : 'unix')

export const PROTO_VERSION = 1
/** What the app acks: the frozen core and the local terminal messages. */
export const LOCAL_CAPS: readonly string[] = ['core', 'local']
/** Hook events through the holder (section 15, from 2.1.3-beta.8): acked only
 *  by a connection that wants them, and only when the holder offers it. */
export const HOOKS_CAP = 'hooks'
/** Tool streams through the holder (section 15, from 2.1.3-beta.10): acked
 *  only by a connection that carries a session's tools, and only when the
 *  holder offers it. From 2.1.3-beta.11 a held agent session's connections
 *  ask for it. */
export const MCP_CAP = 'mcp'
/** Screen reads through the holder (section 15, from 2.1.3-beta.12): acked
 *  only by a connection that reads the session's screen, and only when the
 *  holder offers it. From 2.1.3-beta.13 a plain terminal's connections ask
 *  for it (a take-over reads its holder's size), and from 2.1.3-beta.14
 *  (plan section B2) a held agent session's do too, when its provider's
 *  composer rule reads the holder's screen. */
export const SCREEN_CAP = 'screen'
/** The screen's title in a screen read (section 15, from 2.1.3-beta.14): acked
 *  only beside `screen`, by a connection asked for it, and only when the
 *  holder offers it. A holder that does not know it does not offer it, and
 *  answers `screen.read` as before. From 2.1.3-beta.14 (plan section B2) a
 *  held agent session's connections ask for it beside `screen` when its
 *  provider's composer rule reads the holder's screen. */
export const TITLE_CAP = 'title'
/** The status line through the holder (section 15, from 2.1.3-beta.18): acked
 *  beside `local` only by a connection that takes the session's status line,
 *  and only when the holder offers it. Such a connection is sent `status`, the
 *  newest status the CLI's status line command (the helper's status mode)
 *  posted. From 2.1.3-beta.18 (plan section 3.2) a tab through the session
 *  helper on another machine asks for it. */
export const STATUS_CAP = 'status'
/** Terminal bytes travel on this channel both ways; control messages on 0. */
export const TERMINAL_CHANNEL = 1
/** Control messages (JSON) travel on this channel, both ways. */
export const CONTROL_CHANNEL = 0

// Section 6: a frame is 4 bytes of length (of the rest), 1 kind byte, 4 bytes
// of channel id, then the payload.
export const FRAME_MIN_REST = 5
export const JSON_FROM_HELPER_MAX = 1024 * 1024
export const JSON_TO_HELPER_MAX = 16 * 1024 * 1024
export const RAW_MAX = 64 * 1024
export const JSON_DEPTH_MAX = 32

export const HELLO_PREFIX = 'AICC-HELLO'
export const RESULT_PREFIX = 'AICC-RESULT'
/** A hello line is at most 4 KiB, without its line end. */
export const HELLO_LINE_MAX = 4096
export const HELLO_STATES: readonly string[] = ['new', 'live', 'unmanaged', 'stale', 'orphaned', 'elsewhere', 'unknown']

export const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,31}$/
export const NONCE_RE = /^[0-9a-f]{32}$/
export const SHA256_RE = /^[0-9a-f]{64}$/
/** A helper folder on any machine: `<version>-<first 12 hex of its SHA-256>`
 *  (section 4). The first group is the version. */
export const HELPER_FOLDER_RE = /^([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?)-[0-9a-f]{12}$/

/** Section 15's launch limits. */
export const LAUNCH_LIMITS = {
  argvItems: 256,
  argChars: 8192,
  cwdChars: 4096,
  envEntries: 1024,
  envNameChars: 255,
  envValueChars: 32767,
  /** An exact Windows command line (`line`), in UTF-16 units: CreateProcessW
   *  takes 32767 with the NUL that ends it. */
  lineUnits: 32766,
  termCells: 1000,
} as const
export const LABEL_MAX_CHARS = 128
export const AWAY_MAX_SECS = 86400
export const ENDPOINT_RANDOM_HEX: Record<HelperOs, number> = { windows: 32, unix: 16 }

export const RECORD_FIELDS = ['v', 'session', 'label', 'pid', 'endpoint', 'nonce', 'helper', 'started', 'away', 'attached', 'child', 'code'] as const
export const CHILD_STATES = ['waiting', 'running', 'exited'] as const
export type ChildState = (typeof CHILD_STATES)[number]

const CONTROL = /\p{Cc}/u
const chars = (s: string): number => [...s].length

// ── frames ────────────────────────────────────────────────────────────────────

export type Flow = 'app_to_helper' | 'helper_to_app'

export type Frame =
  /** `size`: the JSON's length in bytes, as it came. */
  | { kind: 0; channel: number; json: unknown; size: number }
  | { kind: 1; channel: number; bytes: Buffer }

/** A frame the reader refuses: the connection is closed (`bad-frame`). */
export class FrameError extends Error {
  readonly code = 'bad-frame'
}

function frameBytes(kind: 0 | 1, channel: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(9)
  head.writeUInt32BE(FRAME_MIN_REST + payload.length, 0)
  head[4] = kind
  head.writeUInt32BE(channel >>> 0, 5)
  return Buffer.concat([head, payload])
}

/** A control message as one frame on channel 0 (or `channel`). */
export function encodeJsonFrame(value: unknown, channel = 0): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  if (payload.length > JSON_TO_HELPER_MAX) throw new FrameError('a control message is over 16 MiB')
  return frameBytes(0, channel, payload)
}

/** Raw bytes as one frame; at most 64 KiB (callers split longer input). */
export function encodeRawFrame(bytes: Buffer, channel = TERMINAL_CHANNEL): Buffer {
  if (bytes.length > RAW_MAX) throw new FrameError('a raw frame is over 64 KiB')
  return frameBytes(1, channel, bytes)
}

/** Terminal input as raw frames of at most 64 KiB each. */
export function encodeInput(bytes: Buffer): Buffer[] {
  const out: Buffer[] = []
  for (let i = 0; i < bytes.length; i += RAW_MAX) out.push(encodeRawFrame(bytes.subarray(i, i + RAW_MAX)))
  return out
}

/** True when JSON text nests deeper than `max`, read from the bytes before
 *  any parse (so a deep payload never reaches the parser). */
export function nestsDeeperThan(payload: Buffer, max: number): boolean {
  let depth = 0
  let inString = false
  let escaped = false
  for (const b of payload) {
    if (inString) {
      if (escaped) escaped = false
      else if (b === 0x5c) escaped = true
      else if (b === 0x22) inString = false
      continue
    }
    if (b === 0x22) inString = true
    else if (b === 0x7b || b === 0x5b) {
      depth++
      if (depth > max) return true
    } else if (b === 0x7d || b === 0x5d) depth--
  }
  return false
}

/**
 * Reads frames from a stream as they arrive. Each length is checked against
 * the limit for its direction before anything is kept for it, so an
 * oversize frame is refused on its first four bytes.
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0)

  constructor(private readonly flow: Flow) {}

  /** Bytes held that do not make a whole frame yet. */
  pending(): number {
    return this.buf.length
  }

  /** Add bytes; return every whole frame they complete. Throws FrameError. */
  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const out: Frame[] = []
    const jsonMax = this.flow === 'helper_to_app' ? JSON_FROM_HELPER_MAX : JSON_TO_HELPER_MAX
    for (;;) {
      if (this.buf.length < 4) break
      const rest = this.buf.readUInt32BE(0)
      if (rest < FRAME_MIN_REST || rest > FRAME_MIN_REST + jsonMax) throw new FrameError(`a frame length of ${rest} is out of range`)
      if (this.buf.length < 9) break
      const kind = this.buf[4]
      if (kind !== 0 && kind !== 1) throw new FrameError(`unknown frame kind ${kind}`)
      const n = rest - FRAME_MIN_REST
      if (kind === 1 && n > RAW_MAX) throw new FrameError('a raw frame is over 64 KiB')
      if (this.buf.length < 9 + n) break
      const channel = this.buf.readUInt32BE(5)
      const payload = Buffer.from(this.buf.subarray(9, 9 + n))
      this.buf = this.buf.subarray(9 + n)
      if (kind === 1) {
        out.push({ kind: 1, channel, bytes: payload })
        continue
      }
      if (nestsDeeperThan(payload, JSON_DEPTH_MAX)) throw new FrameError('JSON nested over 32 levels')
      let json: unknown
      try {
        json = JSON.parse(payload.toString('utf8'))
      } catch {
        throw new FrameError('JSON that does not read')
      }
      out.push({ kind: 0, channel, json, size: n })
    }
    return out
  }
}

/** One frame from exactly these bytes, as the fixtures state it: `io` when
 *  the bytes end before the frame does, `bad-frame` for a refused frame or
 *  bytes after it. */
export function decodeOneFrame(bytes: Buffer, flow: Flow): { error: 'bad-frame' | 'io' } | Frame {
  const r = new FrameReader(flow)
  let frames: Frame[]
  try {
    frames = r.push(bytes)
  } catch {
    return { error: 'bad-frame' }
  }
  if (frames.length === 0) return { error: 'io' }
  if (frames.length > 1 || r.pending() > 0) return { error: 'bad-frame' }
  return frames[0]
}

// ── the hello ─────────────────────────────────────────────────────────────────

export interface Hello {
  proto: number[]
  helperVersion: string
  sha256: string | null
  os: string
  arch: string
  caps: string[]
  sid: string
  state: string
}

/** A hello that cannot be used (`no-hello`), with why. */
export class HelloError extends Error {
  readonly code = 'no-hello'
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

function shortText(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length === 0 || chars(v) > max) return null
  return v
}

/**
 * Read a hello line as section 7 says: the nonce must be the one expected,
 * the session the one asked for, the schema exact; fields it does not know
 * are ignored. Throws HelloError.
 */
export function parseHelloLine(line: string, expectedNonce: string, expectedSid: string): Hello {
  const fail = (why: string): never => {
    throw new HelloError(why)
  }
  if (Buffer.byteLength(line, 'utf8') > HELLO_LINE_MAX) fail('the hello line is over 4 KiB')
  if (!line.startsWith(`${HELLO_PREFIX} `)) fail('not a hello line')
  const rest = line.slice(HELLO_PREFIX.length + 1)
  const space = rest.indexOf(' ')
  if (space < 0) fail('no JSON after the nonce')
  const nonce = rest.slice(0, space)
  if (nonce !== expectedNonce) fail('another nonce')
  let value: unknown
  try {
    value = JSON.parse(rest.slice(space + 1))
  } catch {
    return fail('the hello JSON does not read')
  }
  if (!isObject(value)) return fail('the hello is not an object')
  const proto = value.proto
  if (!Array.isArray(proto) || proto.length === 0 || proto.length > 16 || !proto.every(isWhole)) fail('proto is missing, empty or not version numbers')
  const helper = value.helper
  if (!isObject(helper)) return fail('helper is missing')
  const helperVersion = shortText(helper.version, 64)
  if (helperVersion === null) fail('helper.version is missing or too long')
  let sha256: string | null = null
  if (helper.sha256 !== undefined) {
    if (typeof helper.sha256 !== 'string' || !SHA256_RE.test(helper.sha256)) fail('helper.sha256 is not 64 lower-case hex characters')
    sha256 = helper.sha256 as string
  }
  const os = shortText(value.os, 32)
  if (os === null) fail('os is missing')
  const arch = shortText(value.arch, 32)
  if (arch === null) fail('arch is missing')
  const caps = value.caps
  if (!Array.isArray(caps) || caps.length > 32 || !caps.every((c) => shortText(c, 32) !== null)) fail('caps is missing or not short strings')
  const session = value.session
  if (!isObject(session)) return fail('session is missing')
  if (typeof session.sid !== 'string' || !SID_RE.test(session.sid)) fail('session.sid is missing or breaks its pattern')
  if (session.sid !== expectedSid) fail('another session id')
  if (typeof session.state !== 'string' || !HELLO_STATES.includes(session.state)) fail('session.state is missing or unknown')
  return {
    proto: proto as number[],
    helperVersion: helperVersion as string,
    sha256,
    os: os as string,
    arch: arch as string,
    caps: caps as string[],
    sid: session.sid as string,
    state: session.state as string,
  }
}

/** The highest version both sides speak, or null (`proto-mismatch`). */
export function chooseProto(app: readonly number[], helper: readonly number[]): number | null {
  const both = app.filter((v) => helper.includes(v))
  return both.length === 0 ? null : Math.max(...both)
}

/** The app's answer to a holder's hello: `core` and `local`, `hooks` when this
 *  connection takes hook events, `mcp` when it carries tool streams,
 *  `screen` when it reads the screen and `title`, beside `screen` only, when
 *  its screen reads take the title, `status` when it takes the status line
 *  (each only ever when the hello offered it). */
export function helloAck(hooks = false, mcp = false, screen = false, title = false, status = false): { t: 'hello.ack'; proto: number; caps: string[] } {
  return {
    t: 'hello.ack',
    proto: PROTO_VERSION,
    caps: [...LOCAL_CAPS, ...(hooks ? [HOOKS_CAP] : []), ...(mcp ? [MCP_CAP] : []), ...(screen ? [SCREEN_CAP] : []), ...(screen && title ? [TITLE_CAP] : []), ...(status ? [STATUS_CAP] : [])],
  }
}

// ── the status line (section 15, capability `status`) ────────────────────────

/** A status's payload as compact JSON, at most: what the status mode posts
 *  (helper/src/request.rs MAX_STATUS_PAYLOAD), the hook payload's bound. */
export const STATUS_PAYLOAD_MAX = 65_280
/** A `status` message's JSON, at most: the frame limit once a session is launched. */
export const STATUS_JSON_MAX = 64 * 1024

/** The newest status line a holder passed on. */
export interface StatusFrame {
  /** The session's number for it, from 1; a newer status has a higher one. */
  seq: number
  /** The status as the CLI wrote it on its status line command's standard
   *  input. Untrusted: read only through its provider's keep-list. */
  payload: Record<string, unknown>
}

const STATUS_FIELDS = new Set(['t', 'seq', 'payload'])

/**
 * A `status` message from a holder, read strictly: exactly `t`, `seq` and
 * `payload`, `seq` a whole number from 1, `payload` an object of at most
 * STATUS_PAYLOAD_MAX bytes as compact JSON, and the message (`size` bytes as
 * it came) within STATUS_JSON_MAX. Null otherwise.
 */
export function readStatusFrame(m: unknown, size: number): StatusFrame | null {
  if (!isObject(m) || m.t !== 'status' || !isWhole(size) || size > STATUS_JSON_MAX) return null
  if (Object.keys(m).length !== STATUS_FIELDS.size || !Object.keys(m).every((k) => STATUS_FIELDS.has(k))) return null
  if (!isWhole(m.seq) || m.seq < 1) return null
  const payload = m.payload
  if (!isObject(payload)) return null
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > STATUS_PAYLOAD_MAX) return null
  return { seq: m.seq, payload }
}

// ── hook events (section 15, capability `hooks`) ──────────────────────────────

/** The nine hook events the app injects into a Claude Code session
 *  (src/main/hooks/session-hooks-writer.ts MVP_EVENTS): the kinds a holder
 *  passes on for a launch that declares none (`hookKinds`, from 2.1.3-beta.18). */
export const HELPER_HOOK_KINDS = [
  'PreToolUse', 'PostToolUse', 'Notification', 'SessionStart', 'Stop', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'StopFailure',
] as const
/** The most hook kinds a launch declares (`hookKinds`, from 2.1.3-beta.18;
 *  helper/src/request.rs MAX_HOOK_KINDS). */
export const HOOK_KINDS_MAX = 16
/** The capability whose offer says a holder takes `hookKinds` in a launch: a
 *  holder that offers `status` does (2.1.3-beta.18, helper/src/serve.rs). */
export const HOOK_KINDS_OFFERED_WITH = STATUS_CAP
/** The variables a held session's launch names its hook mode by when its CLI
 *  runs that mode from its own environment (2.1.3-beta.18, ADR-030 S12: its
 *  provider's hook forwarder reads the same three): the helper copy, its
 *  store and the holder's session. The hook mode reads the store and the
 *  session from the last two itself (helper/src/hook.rs STORE_ENV,
 *  SESSION_ENV). */
export const HOOK_MODE_ENV = { helper: 'AICC_HELPER_PATH', store: 'AICC_HELPER_STORE', session: 'AICC_HELPER_SESSION' } as const
/** A hook kind's shape, as the helper reads one (helper/src/request.rs
 *  plain_word): 1 to 64 ASCII letters or digits. */
export const HOOK_KIND_RE = /^[A-Za-z0-9]{1,64}$/

/** A launch's `hookKinds` the holder takes: at most HOOK_KINDS_MAX words of
 *  HOOK_KIND_RE's shape, none twice. */
export function validHookKinds(kinds: unknown): kinds is readonly string[] {
  if (!Array.isArray(kinds) || kinds.length > HOOK_KINDS_MAX) return false
  return kinds.every((k) => typeof k === 'string' && HOOK_KIND_RE.test(k)) && new Set(kinds).size === kinds.length
}

/** A hook event's payload as compact JSON, at most: 64 KiB less the room the
 *  `event` around it needs. */
export const HOOK_PAYLOAD_MAX = 65_280
/** An `event` message's JSON, at most: the frame limit once a session is launched. */
export const HOOK_EVENT_JSON_MAX = 64 * 1024

/** One hook event a holder passed on. */
export interface HookEventFrame {
  /** The session's number for it, from 1. */
  seq: number
  /** Its kind: one of the kinds its session takes (readEventFrame's `kinds`). */
  kind: string
  /** The event as the CLI wrote it, cut by the hook mode when it was large
   *  (a top-level `"cut": true` says so). Untrusted text. */
  payload: Record<string, unknown>
  /** How many events the holder dropped just before this one. */
  lost?: number
}

const EVENT_FIELDS = new Set(['t', 'seq', 'kind', 'payload', 'lost'])

/**
 * An `event` message from a holder, read strictly: exactly its fields, `seq`
 * a whole number from 1, `kind` one of `kinds`, `payload` an object of at
 * most HOOK_PAYLOAD_MAX bytes whose `hook_event_name` is `kind`, `lost` a
 * whole number when given, and the message (`size` bytes as it came) within
 * HOOK_EVENT_JSON_MAX. Null otherwise. `kinds` (2.1.3-beta.18): the kinds the
 * session takes, the `hookKinds` its launch declared, as its holder takes
 * them; the nine (HELPER_HOOK_KINDS) for a session whose launch declared none.
 */
export function readEventFrame(m: unknown, size: number, kinds: readonly string[] = HELPER_HOOK_KINDS): HookEventFrame | null {
  if (!isObject(m) || m.t !== 'event' || !isWhole(size) || size > HOOK_EVENT_JSON_MAX) return null
  for (const k of Object.keys(m)) if (!EVENT_FIELDS.has(k)) return null
  if (!isWhole(m.seq) || m.seq < 1) return null
  if (typeof m.kind !== 'string' || !kinds.includes(m.kind)) return null
  const payload = m.payload
  if (!isObject(payload) || payload.hook_event_name !== m.kind) return null
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > HOOK_PAYLOAD_MAX) return null
  if (m.lost !== undefined && !isWhole(m.lost)) return null
  return { seq: m.seq, kind: m.kind, payload, ...(m.lost !== undefined ? { lost: m.lost } : {}) }
}

// ── tool streams (section 15, capability `mcp`) ───────────────────────────────

/** A tool message's `message`, as compact JSON, at most, on its way to the
 *  app: 1 MiB less the room the `mcp` around it needs. */
export const MCP_MESSAGE_TO_APP_MAX = 1_048_320

/** One JSON-RPC message, or a batch of them. Untrusted: the holder passes it
 *  on without reading it. */
export type McpMessage = Record<string, unknown> | unknown[]

const MCP_STREAM_FIELDS = new Set(['t', 'stream'])
const MCP_MESSAGE_FIELDS = new Set(['t', 'stream', 'message'])
const isStream = (v: unknown): v is number => isWhole(v) && v >= 1
const exactly = (m: Record<string, unknown>, fields: Set<string>): boolean => {
  const keys = Object.keys(m)
  return keys.length === fields.size && keys.every((k) => fields.has(k))
}

/** An `mcp.open` from a holder, read strictly: exactly `t` and `stream`, a
 *  whole number from 1 (the holder's number for the stream). Null otherwise. */
export function readMcpOpen(m: unknown): { stream: number } | null {
  if (!isObject(m) || m.t !== 'mcp.open' || !exactly(m, MCP_STREAM_FIELDS) || !isStream(m.stream)) return null
  return { stream: m.stream }
}

/** An `mcp.close` from a holder, read as `mcp.open` is. */
export function readMcpClose(m: unknown): { stream: number } | null {
  if (!isObject(m) || m.t !== 'mcp.close' || !exactly(m, MCP_STREAM_FIELDS) || !isStream(m.stream)) return null
  return { stream: m.stream }
}

/** An `mcp` from a holder, read strictly: exactly `t`, `stream` and `message`,
 *  the message a JSON object or array of at most MCP_MESSAGE_TO_APP_MAX bytes
 *  as compact JSON, and the whole message (`size` bytes as it came) within
 *  what a frame from the holder holds. Null otherwise. */
export function readMcp(m: unknown, size: number): { stream: number; message: McpMessage } | null {
  if (!isObject(m) || m.t !== 'mcp' || !isWhole(size) || size > JSON_FROM_HELPER_MAX) return null
  if (!exactly(m, MCP_MESSAGE_FIELDS) || !isStream(m.stream)) return null
  const message = m.message
  if (!isObject(message) && !Array.isArray(message)) return null
  if (Buffer.byteLength(JSON.stringify(message), 'utf8') > MCP_MESSAGE_TO_APP_MAX) return null
  return { stream: m.stream, message }
}

// ── screen reads (section 15, capability `screen`) ────────────────────────────

/** The most lines a `screen.tail` asks for, and gets: the holder's scrollback. */
export const SCREEN_TAIL_MAX = 200
/** The most characters a screen's title holds (helper/src/screen.rs TITLE_MAX). */
export const SCREEN_TITLE_MAX = 1024
/** The words a holder names the screen in use and the mouse modes with. */
export const SCREEN_WORDS = ['normal', 'alternate'] as const
export const MOUSE_WORDS = ['none', 'press', 'press-release', 'button-motion', 'any-motion'] as const
export const MOUSE_ENCODING_WORDS = ['default', 'utf8', 'sgr'] as const

/** One row of the holder's screen, as the app's readers take a row
 *  (`ScreenLine` in src/shared, every field given). Untrusted
 *  text. */
export interface ScreenRow {
  text: string
  typed: string
  inverse: string
  width: number
  end: number
}

/** The program's terminal modes as the holder's screen keeps them: fixed
 *  words and yes or no values, never bytes to pass on. */
export interface ScreenModes {
  screen: (typeof SCREEN_WORDS)[number]
  bracketed_paste: boolean
  application_cursor: boolean
  application_keypad: boolean
  mouse: (typeof MOUSE_WORDS)[number]
  mouse_encoding: (typeof MOUSE_ENCODING_WORDS)[number]
  cursor_hidden: boolean
}

/** A `screen.rows`: the holder's screen now. `lines` are the rows from the
 *  top, all of them unless `cut`, then the bottom ones that fit one message
 *  (the first of them is row `rows - lines.length`). The cursor's column is
 *  `cols` while a wrap is pending. `title`: the window title the session's
 *  output last set (empty when it set none), on a connection that acked
 *  `title`; null on any other, and when the answer carries none. Untrusted
 *  text. */
export interface ScreenRows {
  cols: number
  rows: number
  cursor: { row: number; col: number }
  modes: ScreenModes
  title: string | null
  cut: boolean
  lines: ScreenRow[]
}

/** A `screen.lines`: the screen's last lines, oldest first, scrollback
 *  included; all of those asked for that the screen holds, unless `cut`,
 *  then the newest that fit one message. */
export interface ScreenTail {
  cut: boolean
  lines: Array<{ text: string; typed: string }>
}

const SCREEN_ROWS_FIELDS = new Set(['t', 're', 'cols', 'rows', 'cursor', 'modes', 'cut', 'lines'])
const SCREEN_ROWS_TITLED_FIELDS = new Set([...SCREEN_ROWS_FIELDS, 'title'])
const SCREEN_ROW_FIELDS = new Set(['text', 'typed', 'inverse', 'width', 'end'])
const SCREEN_CURSOR_FIELDS = new Set(['row', 'col'])
const SCREEN_MODE_FIELDS = new Set(['screen', 'bracketed_paste', 'application_cursor', 'application_keypad', 'mouse', 'mouse_encoding', 'cursor_hidden'])
const SCREEN_LINES_FIELDS = new Set(['t', 're', 'cut', 'lines'])
const SCREEN_TAIL_LINE_FIELDS = new Set(['text', 'typed'])
const isScreenSize = (v: unknown): v is number => isWhole(v) && v >= 1 && v <= LAUNCH_LIMITS.termCells
const oneOf = <T extends string>(words: readonly T[], v: unknown): v is T => typeof v === 'string' && (words as readonly string[]).includes(v)

function readScreenModes(m: unknown): ScreenModes | null {
  if (!isObject(m) || !exactly(m, SCREEN_MODE_FIELDS)) return null
  if (!oneOf(SCREEN_WORDS, m.screen) || !oneOf(MOUSE_WORDS, m.mouse) || !oneOf(MOUSE_ENCODING_WORDS, m.mouse_encoding)) return null
  const flags = [m.bracketed_paste, m.application_cursor, m.application_keypad, m.cursor_hidden]
  if (!flags.every((f) => typeof f === 'boolean')) return null
  return {
    screen: m.screen,
    bracketed_paste: m.bracketed_paste as boolean,
    application_cursor: m.application_cursor as boolean,
    application_keypad: m.application_keypad as boolean,
    mouse: m.mouse,
    mouse_encoding: m.mouse_encoding,
    cursor_hidden: m.cursor_hidden as boolean,
  }
}

/**
 * A `screen.rows` from a holder (the answer to `screen.read`), read strictly:
 * exactly its fields, a size of 1 to 1000 each way, the cursor on the screen
 * (its column at most `cols`), a known word for each mode and a yes or no for
 * the rest, and the rows: each exactly its five fields, `width` the screen's
 * columns and `end` at most that; all of the screen's rows, or fewer with
 * `cut`. On a connection that acked `title` (`title` true) it may carry
 * `title` too: text of at most SCREEN_TITLE_MAX characters with no control
 * character (absent, it reads null); on any other it may not. The whole
 * message (`size` bytes as it came) within what a frame from the holder
 * holds. Null otherwise.
 */
export function readScreenRows(m: unknown, size: number, title = false): ScreenRows | null {
  if (!isObject(m) || m.t !== 'screen.rows' || !isWhole(size) || size > JSON_FROM_HELPER_MAX) return null
  const fields = title && m.title !== undefined ? SCREEN_ROWS_TITLED_FIELDS : SCREEN_ROWS_FIELDS
  if (!exactly(m, fields) || !isWhole(m.re) || !isScreenSize(m.cols) || !isScreenSize(m.rows) || typeof m.cut !== 'boolean') return null
  if (m.title !== undefined && (typeof m.title !== 'string' || chars(m.title) > SCREEN_TITLE_MAX || CONTROL.test(m.title))) return null
  const cols: number = m.cols
  const rows: number = m.rows
  const cut: boolean = m.cut
  const cursor = m.cursor
  if (!isObject(cursor) || !exactly(cursor, SCREEN_CURSOR_FIELDS) || !isWhole(cursor.row) || !isWhole(cursor.col) || cursor.row >= rows || cursor.col > cols) return null
  const modes = readScreenModes(m.modes)
  if (!modes || !Array.isArray(m.lines)) return null
  if (cut ? m.lines.length >= rows : m.lines.length !== rows) return null
  const lines: ScreenRow[] = []
  for (const l of m.lines) {
    if (!isObject(l) || !exactly(l, SCREEN_ROW_FIELDS)) return null
    if (typeof l.text !== 'string' || typeof l.typed !== 'string' || typeof l.inverse !== 'string') return null
    if (l.width !== cols || !isWhole(l.end) || l.end > cols) return null
    lines.push({ text: l.text, typed: l.typed, inverse: l.inverse, width: cols, end: l.end })
  }
  return { cols, rows, cursor: { row: cursor.row, col: cursor.col }, modes, title: typeof m.title === 'string' ? m.title : null, cut, lines }
}

/**
 * A `screen.lines` from a holder (the answer to `screen.tail`), read strictly:
 * exactly its fields, at most SCREEN_TAIL_MAX lines, each exactly its text and
 * its typed copy, and the whole message (`size` bytes as it came) within what
 * a frame from the holder holds. Null otherwise.
 */
export function readScreenLines(m: unknown, size: number): ScreenTail | null {
  if (!isObject(m) || m.t !== 'screen.lines' || !isWhole(size) || size > JSON_FROM_HELPER_MAX) return null
  if (!exactly(m, SCREEN_LINES_FIELDS) || !isWhole(m.re) || typeof m.cut !== 'boolean' || !Array.isArray(m.lines) || m.lines.length > SCREEN_TAIL_MAX) return null
  const lines: ScreenTail['lines'] = []
  for (const l of m.lines) {
    if (!isObject(l) || !exactly(l, SCREEN_TAIL_LINE_FIELDS) || typeof l.text !== 'string' || typeof l.typed !== 'string') return null
    lines.push({ text: l.text, typed: l.typed })
  }
  return { cut: m.cut, lines }
}

// ── endpoints, records and the listing ────────────────────────────────────────

/** Is `endpoint` the shape section 15 gives this session's pipe or socket? */
export function validEndpoint(endpoint: string, sid: string, os: HelperOs): boolean {
  if (typeof endpoint !== 'string' || !SID_RE.test(sid)) return false
  const random = new RegExp(`^[0-9a-f]{${ENDPOINT_RANDOM_HEX[os]}}$`)
  if (os === 'windows') {
    const prefix = `\\\\.\\pipe\\aicc-helper-${sid}-`
    return endpoint.startsWith(prefix) && random.test(endpoint.slice(prefix.length))
  }
  const m = /^\/tmp\/aicc-([0-9]{1,10})\/([^/]*)\.sock$/.exec(endpoint)
  return !!m && m[2].startsWith(`${sid}-`) && random.test(m[2].slice(sid.length + 1))
}

/** The user id a Unix endpoint's folder names, or null. */
export function endpointUid(endpoint: string): number | null {
  const m = /^\/tmp\/aicc-([0-9]{1,10})\//.exec(endpoint)
  return m ? Number(m[1]) : null
}

export interface HolderRecord {
  v: 1
  session: string
  label: string
  pid: number
  endpoint: string
  nonce: string
  helper: string
  started: number
  away: number
  attached: boolean
  child: ChildState
  code: number | null
}

/** A holder's record, read strictly (section 15): exactly its fields, each of
 *  its type and in range, and an endpoint of its own session. Null otherwise. */
export function readRecord(value: unknown, os: HelperOs): HolderRecord | null {
  if (!isObject(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== RECORD_FIELDS.length || !RECORD_FIELDS.every((k) => keys.includes(k))) return null
  const r = value
  if (r.v !== 1) return null
  if (typeof r.session !== 'string' || !SID_RE.test(r.session)) return null
  if (typeof r.label !== 'string' || chars(r.label) > LABEL_MAX_CHARS || CONTROL.test(r.label)) return null
  if (!Number.isInteger(r.pid) || (r.pid as number) < 1 || (r.pid as number) > 2 ** 32 - 1) return null
  if (typeof r.endpoint !== 'string' || !validEndpoint(r.endpoint, r.session, os)) return null
  if (typeof r.nonce !== 'string' || !NONCE_RE.test(r.nonce)) return null
  if (typeof r.helper !== 'string' || r.helper.length === 0 || chars(r.helper) > 64 || CONTROL.test(r.helper)) return null
  if (!isWhole(r.started)) return null
  if (!Number.isInteger(r.away) || (r.away as number) < 1 || (r.away as number) > AWAY_MAX_SECS) return null
  if (typeof r.attached !== 'boolean') return null
  if (typeof r.child !== 'string' || !(CHILD_STATES as readonly string[]).includes(r.child)) return null
  if (r.child === 'exited') {
    // An exit code is the OS's: signed on Unix, either reading of 32 bits on Windows.
    if (!Number.isInteger(r.code) || (r.code as number) < -(2 ** 31) || (r.code as number) > 2 ** 32 - 1) return null
  } else if (r.code !== null) return null
  return value as unknown as HolderRecord
}

export interface Listing {
  sessions: HolderRecord[]
  removed: number
  skipped: number
}

/** List mode's one line, read strictly: its fields in order, every record valid. */
export function readListing(line: string, os: HelperOs): Listing | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(v) || JSON.stringify(Object.keys(v)) !== JSON.stringify(['v', 'sessions', 'removed', 'skipped'])) return null
  if (v.v !== 1 || !Array.isArray(v.sessions) || !isWhole(v.removed) || !isWhole(v.skipped)) return null
  const sessions: HolderRecord[] = []
  for (const s of v.sessions) {
    const r = readRecord(s, os)
    if (!r) return null
    sessions.push(r)
  }
  return { sessions, removed: v.removed, skipped: v.skipped }
}

// ── the launch ────────────────────────────────────────────────────────────────

export interface LaunchSpec {
  argv: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  /**
   * Windows only: the exact command line the program reads, for one that
   * reads its line in a way no argument list can say (cmd.exe running an npm
   * .cmd file). The program started is `argv[0]`, by that exact path, which
   * then holds it alone and is never a batch file, nor a name Windows opens
   * as another (one ending in `\` or `/`, or with a part made only of dots
   * and spaces, such as `.` or `..`).
   */
  line?: string
  /** Windows only: run on the bundled ConPTY beside the helper. */
  conpty?: 'bundled'
}

export function isAbsoluteFor(p: string, os: HelperOs): boolean {
  if (os === 'unix') return p.startsWith('/')
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p)
}

const isCells = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= LAUNCH_LIMITS.termCells

/**
 * A batch file, as the helper reads a name (helper/src/pty/mod.rs
 * is_batch_file): ending in `.bat` or `.cmd`, in any case, once the trailing
 * dots and spaces Windows drops from a name are dropped.
 */
const isBatchFile = (program: string): boolean => /\.(bat|cmd)$/i.test(program.replace(/[. ]+$/, ''))

/**
 * A name Windows opens as another, as the helper reads it
 * (helper/src/pty/mod.rs is_renamed_by_windows): ending in `\` or `/`, or
 * with a part made only of dots and spaces, such as `.` or `..`. Windows
 * resolves those parts before it opens the file, so `C:\x\tool.cmd\.` opens
 * `C:\x\tool.cmd`; with a line, such a name is refused before the batch-file
 * rule reads it.
 */
const isRenamedByWindows = (program: string): boolean =>
  /[\\/]$/.test(program) || program.split(/[\\/]/).some((part) => part.length > 0 && /^[. ]+$/.test(part))

/**
 * Would the holder take this launch (section 15, with the Windows fields
 * `line` and `conpty`)? Null when it would, else the protocol code it would
 * answer and why. The app checks first, so a launch the holder would refuse
 * starts the usual way instead of failing.
 */
export function checkLaunch(spec: LaunchSpec, os: HelperOs): { code: 'bad-field' | 'too-large'; why: string } | null {
  const bad = (why: string) => ({ code: 'bad-field' as const, why })
  const big = (why: string) => ({ code: 'too-large' as const, why })
  const { argv, cwd, env } = spec
  if (!Array.isArray(argv) || argv.length === 0) return bad('no program to start')
  if (argv.length > LAUNCH_LIMITS.argvItems) return big('more than 256 arguments')
  for (const a of argv) {
    if (typeof a !== 'string') return bad('an argument that is not text')
    if (chars(a) > LAUNCH_LIMITS.argChars) return big('an argument over 8192 characters')
    if (a.includes('\0')) return bad('an argument with a NUL character')
  }
  if (!isAbsoluteFor(argv[0], os)) return bad('the program is not named by an absolute path')
  if (typeof cwd !== 'string') return bad('no folder')
  if (chars(cwd) > LAUNCH_LIMITS.cwdChars) return big('a folder over 4096 characters')
  if (cwd.includes('\0') || !isAbsoluteFor(cwd, os)) return bad('the folder is not an absolute path')
  if (!isObject(env)) return bad('the environment is not an object')
  const entries = Object.entries(env)
  if (entries.length > LAUNCH_LIMITS.envEntries) return big('more than 1024 environment variables')
  const folded = new Set<string>()
  for (const [name, value] of entries) {
    if (name.length === 0) return bad('an empty variable name')
    if (chars(name) > LAUNCH_LIMITS.envNameChars) return big('a variable name over 255 characters')
    if (name.includes('=') || name.includes('\0')) return bad('a variable name with = or a NUL character')
    if (typeof value !== 'string') return bad('a variable value that is not text')
    if (chars(value) > LAUNCH_LIMITS.envValueChars) return big('a variable value over 32767 characters')
    if (value.includes('\0')) return bad('a variable value with a NUL character')
    const upper = name.toUpperCase()
    if (folded.has(upper)) return bad(`two variable names that differ only in case (${name})`)
    folded.add(upper)
  }
  if (!isCells(spec.cols) || !isCells(spec.rows)) return bad('a terminal size out of range')
  // The Windows fields `line` and `conpty`, in the helper's order. A line is
  // counted in UTF-16 units, a JavaScript string's length, as Windows counts it.
  if (spec.line !== undefined) {
    const line: unknown = spec.line
    if (typeof line !== 'string') return bad('a command line that is not text')
    if (os !== 'windows') return bad('an exact command line, which is for Windows only')
    if (line.length > LAUNCH_LIMITS.lineUnits) return big('a command line over 32766 UTF-16 units')
    if (line.includes('\0')) return bad('a command line with a NUL character')
    if (line.length === 0) return bad('an empty command line')
    if (argv.length !== 1) return bad('a command line with arguments besides it')
    if (isRenamedByWindows(argv[0])) return bad('a command line for a program named with a part of dots alone or a trailing separator, which Windows opens by another name')
    if (isBatchFile(argv[0])) return bad('a command line for a batch file, which Windows runs through cmd.exe')
  }
  if (spec.conpty !== undefined) {
    const conpty: unknown = spec.conpty
    if (conpty !== 'bundled') return bad('a ConPTY other than the bundled one')
    if (os !== 'windows') return bad('the bundled ConPTY, which is for Windows only')
  }
  return null
}

// ── ids ───────────────────────────────────────────────────────────────────────

/**
 * The helper's session id for an app PTY id: always the same for the same
 * app id, so a restored tab finds its held terminal again after a crash, and
 * always of the protocol's shape (`pt` and 30 hex characters).
 */
export function heldSessionId(appPtyId: string): string {
  return `pt${createHash('sha256').update(`aicc-plain-terminal\0${appPtyId}`, 'utf8').digest('hex').slice(0, 30)}`
}

/**
 * The helper's session id for an agent session (a provider's CLI in a local
 * tab, 2.1.3-beta.7): always the same for the same app id and provider, never
 * one a plain terminal gets (`ag` and 30 hex characters, where a plain one is
 * `pt`), so a start after a crash tells the two apart by the id alone.
 */
export function heldAgentSessionId(appPtyId: string, provider: string): string {
  return `ag${createHash('sha256').update(`aicc-agent-session\0${provider}\0${appPtyId}`, 'utf8').digest('hex').slice(0, 30)}`
}

/** What a held session id says it is, by its prefix: a plain terminal, an
 *  agent session, or neither (an id the app did not make). */
export function heldIdKind(sid: string): 'plain' | 'agent' | null {
  if (!SID_RE.test(sid)) return null
  return /^pt[0-9a-f]{30}$/.test(sid) ? 'plain' : /^ag[0-9a-f]{30}$/.test(sid) ? 'agent' : null
}

/** An app PTY id the helper can carry as a holder's label. */
export const APP_PTY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

// ── one-shot command output ───────────────────────────────────────────────────

/** `aicc-helper version` prints `aicc-helper <version>`. */
export function parseVersionLine(stdout: string): string | null {
  const m = /^aicc-helper ([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?)\s*$/.exec(stdout.trim())
  return m ? m[1] : null
}

export interface SelfTestCheck {
  name: string
  ok: boolean
  detail?: string
}

export interface SelfTestReport {
  ok: boolean
  helper: string
  checks: SelfTestCheck[]
}

/** The self-test's `AICC-RESULT <nonce> <json>` line (section 6). Null when
 *  there is none for this nonce, or it does not read. */
export function parseSelfTestResult(stdout: string, nonce: string): SelfTestReport | null {
  const prefix = `${RESULT_PREFIX} ${nonce} `
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith(prefix))
  if (!line) return null
  let v: unknown
  try {
    v = JSON.parse(line.slice(prefix.length))
  } catch {
    return null
  }
  if (!isObject(v) || typeof v.ok !== 'boolean' || !Array.isArray(v.checks)) return null
  const checks: SelfTestCheck[] = []
  for (const c of v.checks) {
    if (!isObject(c) || typeof c.name !== 'string' || typeof c.ok !== 'boolean') return null
    checks.push({ name: c.name.slice(0, 64), ok: c.ok, ...(typeof c.detail === 'string' ? { detail: c.detail.slice(0, 300) } : {}) })
  }
  return { ok: v.ok, helper: typeof v.helper === 'string' ? v.helper.slice(0, 64) : '', checks }
}
