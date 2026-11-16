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
/** Terminal bytes travel on this channel both ways; control messages on 0. */
export const TERMINAL_CHANNEL = 1

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
  | { kind: 0; channel: number; json: unknown }
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
      out.push({ kind: 0, channel, json })
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

/** The app's answer to a holder's hello. */
export function helloAck(): { t: 'hello.ack'; proto: number; caps: string[] } {
  return { t: 'hello.ack', proto: PROTO_VERSION, caps: [...LOCAL_CAPS] }
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
}

export function isAbsoluteFor(p: string, os: HelperOs): boolean {
  if (os === 'unix') return p.startsWith('/')
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p)
}

const isCells = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= LAUNCH_LIMITS.termCells

/**
 * Would the holder take this launch (section 15)? Null when it would, else the
 * protocol code it would answer and why. The app checks first, so a launch the
 * holder would refuse starts the usual way instead of failing.
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
