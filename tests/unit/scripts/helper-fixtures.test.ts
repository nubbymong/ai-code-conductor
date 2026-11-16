import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * The shared message fixtures of the Rust session helper (helper/fixtures/*.json).
 * The helper's own Rust tests (helper/tests/fixtures.rs) read the same files, so
 * the app and the helper cannot drift apart: a vector that changes must change for
 * both, and the numbers in them must be the ones docs/remote/helper-protocol.md
 * and the helper's constants state.
 *
 * The decoder below is written from the document, independently of the Rust
 * one, so a vector is checked by a second implementation and not by the code it
 * was written to test.
 */

const ROOT = resolve(__dirname, '../../..')
const text = (p: string) => readFileSync(resolve(ROOT, p), 'utf-8').replace(/\r\n/g, '\n')
const json = (p: string) => JSON.parse(text(p))

type Flow = 'app_to_helper' | 'helper_to_app'
const frames = json('helper/fixtures/frames.json')
const hello = json('helper/fixtures/hello.json')
const limits = json('helper/fixtures/limits.json')
const local = json('helper/fixtures/local.json')

// ── a reference reader, from section 6 of the protocol ────────────────────────
type Decoded = { error: 'bad-frame' | 'io' } | { kind: 0 | 1; channel: number; payload: Buffer }

function depthOf(v: unknown): number {
  if (Array.isArray(v)) return 1 + Math.max(0, ...v.map(depthOf))
  if (v !== null && typeof v === 'object') return 1 + Math.max(0, ...Object.values(v as object).map(depthOf))
  return 0
}

function refDecode(hex: string, flow: Flow): Decoded {
  const b = Buffer.from(hex, 'hex')
  if (b.length < 4) return { error: 'io' }
  const rest = b.readUInt32BE(0)
  const maxJson = flow === 'helper_to_app' ? limits.frame.json_helper_to_app : limits.frame.json_app_to_helper
  // Both bounds are checked on the length alone, before any payload is read.
  if (rest < limits.frame.min_rest || rest > limits.frame.min_rest + maxJson) return { error: 'bad-frame' }
  if (b.length < 9) return { error: 'io' }
  const kind = b[4]
  const channel = b.readUInt32BE(5)
  const n = rest - limits.frame.min_rest
  if (kind !== 0 && kind !== 1) return { error: 'bad-frame' }
  if (kind === 1 && n > limits.frame.raw) return { error: 'bad-frame' }
  if (b.length < 9 + n) return { error: 'io' }
  if (b.length > 9 + n) return { error: 'bad-frame' }
  const payload = b.subarray(9, 9 + n)
  if (kind === 0) {
    let value: unknown
    try {
      value = JSON.parse(payload.toString('utf8'))
    } catch {
      return { error: 'bad-frame' }
    }
    if (depthOf(value) > limits.frame.json_depth) return { error: 'bad-frame' }
  }
  return { kind, channel, payload }
}

function refEncode(kind: 0 | 1, channel: number, payload: Buffer): string {
  const head = Buffer.alloc(9)
  head.writeUInt32BE(5 + payload.length, 0)
  head[4] = kind
  head.writeUInt32BE(channel, 5)
  return Buffer.concat([head, payload]).toString('hex')
}

describe('helper fixtures: frames', () => {
  it('has valid and invalid vectors, each with a name and a flow', () => {
    expect(frames.version).toBe(1)
    expect(frames.valid.length).toBeGreaterThanOrEqual(8)
    expect(frames.invalid.length).toBeGreaterThanOrEqual(10)
    for (const v of [...frames.valid, ...frames.invalid]) {
      expect(typeof v.name, 'name').toBe('string')
      expect(['app_to_helper', 'helper_to_app'], v.name).toContain(v.flow)
      expect(v.hex, v.name).toMatch(/^([0-9a-f]{2})+$/)
    }
    const names = [...frames.valid, ...frames.invalid].map((v: { name: string }) => v.name)
    expect(new Set(names).size, 'names are unique').toBe(names.length)
  })

  it('every valid vector reads as its fields say, and its bytes are exactly what an independent encoder writes', () => {
    for (const v of frames.valid) {
      const d = refDecode(v.hex, v.flow)
      expect('error' in d, `${v.name}: ${JSON.stringify(d)}`).toBe(false)
      if ('error' in d) continue
      expect(d.channel, `${v.name}: channel`).toBe(v.channel)
      expect(d.kind, `${v.name}: kind`).toBe(v.kind === 'json' ? 0 : 1)
      if (v.kind === 'json') {
        // Compact JSON in the order written: the helper's writer produces these bytes.
        expect(JSON.stringify(JSON.parse(v.payload_text)), `${v.name}: payload_text is compact`).toBe(v.payload_text)
        expect(d.payload.toString('utf8'), `${v.name}: payload`).toBe(v.payload_text)
        expect(refEncode(0, v.channel, Buffer.from(v.payload_text, 'utf8')), `${v.name}: encode`).toBe(v.hex)
      } else {
        expect(d.payload.toString('hex'), `${v.name}: payload`).toBe(v.payload_hex)
        expect(refEncode(1, v.channel, Buffer.from(v.payload_hex, 'hex')), `${v.name}: encode`).toBe(v.hex)
      }
    }
  })

  it('every invalid vector is refused by the independent reader with the code the vector names', () => {
    for (const v of frames.invalid) {
      expect(limits.error_codes, `${v.name}: the code is a protocol error code`).toContain(v.error)
      expect(refDecode(v.hex, v.flow), v.name).toEqual({ error: v.error })
    }
  })

  it('the vectors cover the cases the protocol spells out', () => {
    const names = frames.invalid.map((v: { name: string }) => v.name).join(' | ')
    for (const needle of ['length 4', 'unknown kind', 'does not read', '33 levels', 'over 1 MiB helper to app', 'over 16 MiB app to helper', 'raw over 64 KiB helper to app', 'raw over 64 KiB app to helper']) {
      expect(names, needle).toContain(needle)
    }
    expect(frames.valid.some((v: { payload_text?: string }) => v.payload_text === '['.repeat(32) + ']'.repeat(32))).toBe(true)
  })
})

// ── the reference hello reader ────────────────────────────────────────────────
type Parsed = { proto: number[]; helper_version: string; sha256: string | null; os: string; arch: string; caps: string[]; sid: string; state: string }
function refHello(line: string, nonce: string, sid: string): { error: 'no-hello' } | Parsed {
  const bad = { error: 'no-hello' as const }
  if (Buffer.byteLength(line, 'utf8') > limits.hello_line) return bad
  const m = /^AICC-HELLO ([^ ]+) (.*)$/s.exec(line)
  if (!m || m[1] !== nonce) return bad
  let v: any
  try {
    v = JSON.parse(m[2])
  } catch {
    return bad
  }
  const short = (s: unknown, max: number): s is string => typeof s === 'string' && s.length >= 1 && [...s].length <= max
  if (!Array.isArray(v?.proto) || v.proto.length < 1 || v.proto.length > 16 || !v.proto.every((n: unknown) => Number.isInteger(n) && (n as number) >= 0)) return bad
  if (!short(v?.helper?.version, 64)) return bad
  if (v.helper.sha256 !== undefined && !(typeof v.helper.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.helper.sha256))) return bad
  if (!short(v.os, 32) || !short(v.arch, 32)) return bad
  if (!Array.isArray(v.caps) || v.caps.length > 32 || !v.caps.every((c: unknown) => short(c, 32))) return bad
  if (typeof v.session?.sid !== 'string' || !new RegExp(limits.sid_pattern).test(v.session.sid) || v.session.sid !== sid) return bad
  if (!limits.states.includes(v.session.state)) return bad
  return { proto: v.proto, helper_version: v.helper.version, sha256: v.helper.sha256 ?? null, os: v.os, arch: v.arch, caps: v.caps, sid: v.session.sid, state: v.session.state }
}

describe('helper fixtures: hello', () => {
  it('every valid hello reads as its expectation says', () => {
    expect(hello.valid.length).toBeGreaterThanOrEqual(4)
    for (const v of hello.valid) expect(refHello(v.line, hello.expected_nonce, hello.expected_sid), v.name).toEqual(v.expect)
  })

  it('every invalid hello fails as no-hello, and the vector says why', () => {
    expect(hello.invalid.length).toBeGreaterThanOrEqual(10)
    for (const v of hello.invalid) {
      expect(v.error, v.name).toBe('no-hello')
      expect(typeof v.why, `${v.name}: why`).toBe('string')
      expect(refHello(v.line, hello.expected_nonce, hello.expected_sid), v.name).toEqual({ error: 'no-hello' })
    }
    // The 4 KiB vector really is over the limit, by a little.
    const big = hello.invalid.find((v: { name: string }) => v.name === 'over 4 KiB')
    expect(Buffer.byteLength(big.line, 'utf8')).toBeGreaterThan(limits.hello_line)
  })

  it('acks, version choice, session ids and nonces', () => {
    for (const v of hello.ack.valid) {
      const o = JSON.parse(v.json)
      expect(o.t).toBe('hello.ack')
      expect({ proto: o.proto, caps: o.caps }).toEqual(v.expect)
      expect(Number.isInteger(o.proto) && Array.isArray(o.caps)).toBe(true)
    }
    for (const v of hello.ack.invalid) {
      const o = JSON.parse(v.json)
      expect(o.t === 'hello.ack' && Number.isInteger(o.proto) && Array.isArray(o.caps), v.name).toBe(false)
    }
    for (const c of hello.proto_choice) {
      const common = c.app.filter((x: number) => c.helper.includes(x))
      expect(common.length ? Math.max(...common) : null, JSON.stringify(c)).toBe(c.chosen)
    }
    for (const s of hello.sid.valid) expect(new RegExp(limits.sid_pattern).test(s), s).toBe(true)
    for (const s of hello.sid.invalid) expect(new RegExp(limits.sid_pattern).test(s), s).toBe(false)
    for (const s of hello.nonce.valid) expect(new RegExp(limits.nonce_pattern).test(s), s).toBe(true)
    for (const s of hello.nonce.invalid) expect(new RegExp(limits.nonce_pattern).test(s), s).toBe(false)
  })
})

// ── the numbers: the document, the fixtures and the helper's constants agree ──
describe('helper fixtures: limits are the ones the protocol and the helper state', () => {
  const doc = text('docs/remote/helper-protocol.md').replace(/\s+/g, ' ')

  it('limits.json holds the numbers the protocol document states', () => {
    expect(doc).toContain('Hard limits: JSON 1 MiB helper to app and 16 MiB app to helper')
    expect(doc).toContain('raw 64 KiB both ways; JSON depth 32')
    expect(doc).toContain('A hello line is at most 4 KiB, a result line 1 MiB')
    expect(doc).toContain('text at most 512 characters')
    expect(doc).toContain('From a 2 MiB output ring')
    expect(doc).toMatch(/4 bytes length of the rest \(unsigned, big-endian\), 1 byte kind \(0 = JSON control, 1 = raw bytes\), 4 bytes channel id/)
    expect(doc).toContain(limits.sid_pattern)
    expect(limits.frame).toEqual({ length_prefix_bytes: 4, kind_bytes: 1, channel_bytes: 4, min_rest: 5, json_helper_to_app: 1024 * 1024, json_app_to_helper: 16 * 1024 * 1024, raw: 64 * 1024, json_depth: 32 })
    expect(limits.hello_line).toBe(4 * 1024)
    expect(limits.result_line).toBe(1024 * 1024)
    expect(limits.error_text_chars).toBe(512)
    expect(limits.ring_bytes).toBe(2 * 1024 * 1024)
  })

  it('every state and every error code in limits.json is one the document names', () => {
    for (const s of limits.states) expect(doc, s).toContain(`\`${s}\``)
    for (const c of limits.error_codes) expect(doc, c).toContain(`\`${c}\``)
  })

  it('the helper source holds the same numbers, so Rust and the app cannot drift', () => {
    const num = (file: string, name: string): number => {
      const m = new RegExp(`const ${name}: \\w+ = ([0-9_ *]+);`).exec(text(file))
      if (!m) throw new Error(`${name} not found in ${file}`)
      return m[1].split('*').reduce((acc, part) => acc * Number(part.trim().replace(/_/g, '')), 1)
    }
    expect(num('helper/src/frame.rs', 'MIN_REST')).toBe(limits.frame.min_rest)
    expect(num('helper/src/frame.rs', 'MAX_JSON_HELPER_TO_APP')).toBe(limits.frame.json_helper_to_app)
    expect(num('helper/src/frame.rs', 'MAX_JSON_APP_TO_HELPER')).toBe(limits.frame.json_app_to_helper)
    expect(num('helper/src/frame.rs', 'MAX_RAW')).toBe(limits.frame.raw)
    expect(num('helper/src/json.rs', 'MAX_DEPTH')).toBe(limits.frame.json_depth)
    expect(num('helper/src/hello.rs', 'MAX_HELLO_LINE')).toBe(limits.hello_line)
    expect(num('helper/src/hello.rs', 'MAX_RESULT_LINE')).toBe(limits.result_line)
    expect(num('helper/src/hello.rs', 'MAX_ERROR_TEXT_CHARS')).toBe(limits.error_text_chars)
    expect(num('helper/src/ring.rs', 'DEFAULT_RING_BYTES')).toBe(limits.ring_bytes)
    const states = /pub const STATES: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(text('helper/src/hello.rs'))
    expect(states, 'STATES in hello.rs').not.toBeNull()
    const listed = [...states![2].matchAll(/"([a-z]+)"/g)].map((m) => m[1])
    expect(listed).toEqual(limits.states)
    expect(Number(states![1])).toBe(limits.states.length)
  })
})

// ── the local transport: a reference reader from section 15 ──────────────────
// Written from the document, not from helper/src/request.rs or store.rs, so a
// vector is checked twice. The app's own client (next slice) must agree with it.
type Os = 'unix' | 'windows'
const OSES: Os[] = ['unix', 'windows']
const L = local.limits
const appliesOn = (v: { os?: Os }, os: Os) => v.os === undefined || v.os === os
const chars = (s: string) => [...s].length
const isId = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) % 2 === 0
const isOffset = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
const isCells = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= L.term_cells
const sameKeys = (keys: string[], want: string[]) => keys.length === want.length && want.every((k) => keys.includes(k))
const CONTROL = /\p{Cc}/u

function isAbsolute(p: string, os: Os): boolean {
  if (os === 'unix') return p.startsWith('/')
  // A drive and a separator, or a \\server\share path.
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p)
}

const LOCAL_FIELDS: Record<string, string[]> = {
  ping: ['t', 'id'],
  'term.launch': ['t', 'id', 'argv', 'cwd', 'env', 'cols', 'rows'],
  'term.attach': ['t', 'id', 'from'],
  'term.resize': ['t', 'id', 'cols', 'rows'],
  'term.detach': ['t', 'id'],
  'term.end': ['t', 'id'],
}

type Answer = { error: string } | Record<string, unknown>
function refLaunch(v: any, os: Os): Answer {
  const bad = { error: 'bad-field' }
  const big = { error: 'too-large' }
  if (!Array.isArray(v.argv) || v.argv.length === 0) return bad
  if (v.argv.length > L.argv_items) return big
  for (const a of v.argv) {
    if (typeof a !== 'string') return bad
    if (chars(a) > L.arg_chars) return big
    if (a.includes('\0')) return bad
  }
  if (!isAbsolute(v.argv[0], os)) return bad
  if (typeof v.cwd !== 'string') return bad
  if (chars(v.cwd) > L.cwd_chars) return big
  if (v.cwd.includes('\0') || !isAbsolute(v.cwd, os)) return bad
  if (v.env === null || typeof v.env !== 'object' || Array.isArray(v.env)) return bad
  const entries = Object.entries(v.env)
  if (entries.length > L.env_entries) return big
  const folded = new Set<string>()
  for (const [name, value] of entries) {
    if (name.length === 0) return bad
    if (chars(name) > L.env_name_chars) return big
    if (name.includes('=') || name.includes('\0')) return bad
    if (typeof value !== 'string') return bad
    if (chars(value) > L.env_value_chars) return big
    if (value.includes('\0')) return bad
    if (folded.has(name.toUpperCase())) return bad
    folded.add(name.toUpperCase())
  }
  if (!isCells(v.cols) || !isCells(v.rows)) return bad
  return { type: 'term.launch', id: v.id, argv: v.argv, cwd: v.cwd, env: entries, cols: v.cols, rows: v.rows }
}

/** A control message as a connection that acked `local` reads it. */
function refRequest(textIn: string, os: Os): Answer {
  const bad = { error: 'bad-field' }
  const v = JSON.parse(textIn)
  if (v === null || typeof v !== 'object' || Array.isArray(v) || typeof v.t !== 'string') return bad
  const keys = Object.keys(v)
  if (v.t === 'error') {
    const want = 're' in v ? ['t', 're', 'code', 'text'] : ['t', 'code', 'text']
    const ok = sameKeys(keys, want) && typeof v.code === 'string' && v.code.length >= 1 && v.code.length <= 32 && typeof v.text === 'string' && chars(v.text) <= limits.error_text_chars && (!('re' in v) || isOffset(v.re))
    return ok ? { type: 'error' } : bad
  }
  const fields = LOCAL_FIELDS[v.t]
  if (!fields) return { error: 'unknown-type' }
  if (!isId(v.id) || !sameKeys(keys, fields)) return bad
  switch (v.t) {
    case 'term.launch':
      return refLaunch(v, os)
    case 'term.attach':
      return isOffset(v.from) ? { type: v.t, id: v.id, from: v.from } : bad
    case 'term.resize':
      return isCells(v.cols) && isCells(v.rows) ? { type: v.t, id: v.id, cols: v.cols, rows: v.rows } : bad
    default:
      return { type: v.t, id: v.id }
  }
}

function refEndpoint(e: string, sid: string, os: Os): boolean {
  if (!new RegExp(limits.sid_pattern).test(sid)) return false
  const random = new RegExp(`^[0-9a-f]{${L.endpoint_random_hex[os]}}$`)
  if (os === 'windows') {
    const prefix = `\\\\.\\pipe\\aicc-helper-${sid}-`
    return e.startsWith(prefix) && random.test(e.slice(prefix.length))
  }
  const m = /^\/tmp\/aicc-([0-9]{1,10})\/(.*)\.sock$/.exec(e)
  return !!m && m[2].startsWith(`${sid}-`) && random.test(m[2].slice(sid.length + 1))
}

function refRecord(r: any, os: Os): boolean {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return false
  if (!sameKeys(Object.keys(r), local.record_fields)) return false
  if (r.v !== 1) return false
  if (typeof r.session !== 'string' || !new RegExp(limits.sid_pattern).test(r.session)) return false
  if (typeof r.label !== 'string' || chars(r.label) > L.label_chars || CONTROL.test(r.label)) return false
  if (!Number.isInteger(r.pid) || r.pid < 1 || r.pid > 2 ** 32 - 1) return false
  if (typeof r.endpoint !== 'string' || !refEndpoint(r.endpoint, r.session, os)) return false
  if (typeof r.nonce !== 'string' || !new RegExp(limits.nonce_pattern).test(r.nonce)) return false
  if (typeof r.helper !== 'string' || r.helper.length === 0 || chars(r.helper) > 64 || CONTROL.test(r.helper)) return false
  if (!isOffset(r.started)) return false
  if (!Number.isInteger(r.away) || r.away < 1 || r.away > L.away_max_secs) return false
  if (typeof r.attached !== 'boolean' || !local.child_states.includes(r.child)) return false
  // An exit code is the OS's: signed on Unix, either reading of 32 bits on Windows.
  if (r.child === 'exited') return Number.isInteger(r.code) && r.code >= -(2 ** 31) && r.code <= 2 ** 32 - 1
  return r.code === null
}

function refListing(line: string, os: Os): boolean {
  const v = JSON.parse(line)
  if (v === null || typeof v !== 'object' || JSON.stringify(Object.keys(v)) !== JSON.stringify(['v', 'sessions', 'removed', 'skipped'])) return false
  return v.v === 1 && Array.isArray(v.sessions) && isOffset(v.removed) && isOffset(v.skipped) && v.sessions.every((r: unknown) => refRecord(r, os))
}

describe('helper fixtures: the local transport (section 15)', () => {
  it('every request reads as its vector says, on each OS it applies to', () => {
    expect(local.version).toBe(1)
    expect(local.requests.valid.length).toBeGreaterThanOrEqual(12)
    expect(local.requests.invalid.length).toBeGreaterThanOrEqual(30)
    const names = [...local.requests.valid, ...local.requests.invalid].map((v: { name: string }) => v.name)
    expect(new Set(names).size, 'names are unique').toBe(names.length)
    for (const os of OSES) {
      for (const v of local.requests.valid.filter((x: { os?: Os }) => appliesOn(x, os))) expect(refRequest(v.json, os), `${os}: ${v.name}`).toEqual(v.expect)
      for (const v of local.requests.invalid.filter((x: { os?: Os }) => appliesOn(x, os))) {
        expect(limits.error_codes, `${v.name}: a protocol error code`).toContain(v.error)
        expect(refRequest(v.json, os), `${os}: ${v.name}`).toEqual({ error: v.error })
      }
    }
    // Every limit is met at its edge, and refused one past it.
    const all = local.requests.invalid.map((v: { name: string }) => v.name).join(' | ')
    for (const needle of ['257 arguments', 'over 8192 characters', 'over 4096 characters', 'over 255 characters', '1001 rows', '0 columns', '2^53', 'differ only in case', 'by name, not path']) expect(all, needle).toContain(needle)
    expect(local.requests.valid.some((v: { name: string }) => v.name.includes('256 arguments'))).toBe(true)
  })

  it('the launch frame is the bytes an independent encoder writes', () => {
    const f = local.launch_frame
    const d = refDecode(f.hex, f.flow)
    expect('error' in d).toBe(false)
    if ('error' in d) return
    expect([d.kind, d.channel]).toEqual([0, 0])
    expect(d.payload.toString('utf8')).toBe(f.payload_text)
    expect(refEncode(0, 0, Buffer.from(f.payload_text, 'utf8'))).toBe(f.hex)
    expect(refRequest(f.payload_text, 'unix')).toMatchObject({ type: 'term.launch' })
  })

  it('records and listings: strict, and valid ones are compact with their fields in order', () => {
    for (const os of OSES) {
      for (const v of local.records.valid.filter((x: { os?: Os }) => appliesOn(x, os))) {
        expect(refRecord(v.record, os), `${os}: ${v.name}`).toBe(true)
        expect(Object.keys(v.record), v.name).toEqual(local.record_fields)
      }
      for (const v of local.records.invalid.filter((x: { os?: Os }) => appliesOn(x, os))) expect(refRecord(v.record, os), `${os}: ${v.name}`).toBe(false)
      for (const v of local.listing.valid.filter((x: { os?: Os }) => appliesOn(x, os))) {
        expect(refListing(v.line, os), `${os}: ${v.name}`).toBe(true)
        expect(JSON.stringify(JSON.parse(v.line)), `${v.name} is compact`).toBe(v.line)
      }
      for (const v of local.listing.invalid.filter((x: { os?: Os }) => appliesOn(x, os))) expect(refListing(v.line, os), `${os}: ${v.name}`).toBe(false)
    }
    expect(local.records.valid.some((v: { os?: Os }) => v.os === 'windows')).toBe(true)
    expect(local.child_states).toEqual(['waiting', 'running', 'exited'])
  })

  it('endpoints: only this shape, on each OS', () => {
    for (const os of OSES) {
      for (const e of local.endpoint[os].valid) expect(refEndpoint(e, local.endpoint.sid, os), `${os}: ${e}`).toBe(true)
      for (const e of local.endpoint[os].invalid) expect(refEndpoint(e, local.endpoint.sid, os), `${os}: ${e}`).toBe(false)
    }
  })

  const doc = text('docs/remote/helper-protocol.md').replace(/\s+/g, ' ')
  const section = doc.slice(doc.indexOf('## 15 Local transport'))

  it('the numbers are the ones section 15 states', () => {
    expect(doc).toContain('## 15 Local transport (protocol change 1)')
    expect(section).toContain('`argv` holds 1 to 256 strings of at most 8192 characters')
    expect(section).toContain('`cwd` is an absolute path of at most 4096 characters')
    expect(section).toContain('It has at most 1024 entries; a name is 1 to 255 characters with no `=` or NUL character, a value at most 32767 characters')
    expect(section).toContain('`cols` and `rows` are whole numbers from 1 to 1000')
    expect(section).toContain('`--away` is 1 to 86400 seconds, default 120')
    expect(section).toContain('a label is at most 128 characters')
    expect(section).toContain('At most 16 connections at once')
    expect(section).toContain('With no `hello.ack` in 10 s')
    expect(section).toContain('with no frame from the app in 60 s')
    expect(section).toContain('A write that has not finished in 5 s closes the connection')
    expect(section).toContain('20 `bad-field` or `too-large` replies in 60 s are allowed')
    expect(section).toContain('`caps` is `["core","local"]`')
    expect(section).toContain('`\\\\.\\pipe\\aicc-helper-<sid>-<32 hex>`')
    expect(section).toContain('`/tmp/aicc-<uid>/<sid>-<16 hex>.sock`')
    expect(section).toContain('`O:<the user\'s SID>D:P(A;;GA;;;<the user\'s SID>)`')
    expect(section).toContain("joins a later instance only if the pipe's owner and its list are the user's")
    for (const f of local.record_fields) expect(section, f).toContain(`\`${f}\``)
    for (const s of local.child_states) expect(section, s).toContain(`\`${s}\``)
    for (const t of Object.keys(LOCAL_FIELDS).filter((t) => t !== 'ping')) expect(section, t).toContain(`\`${t}\``)
    expect(local.caps).toEqual(['core', 'local'])
    expect(L).toMatchObject({ argv_items: 256, arg_chars: 8192, cwd_chars: 4096, env_entries: 1024, env_name_chars: 255, env_value_chars: 32767, term_cells: 1000, label_chars: 128, away_default_secs: 120, away_max_secs: 86400, connections: 16, ack_timeout_secs: 10, idle_timeout_secs: 60, write_timeout_secs: 5, refusals_per_minute: 20, terminal_channel: 1 })
    expect(L.endpoint_random_hex).toEqual({ windows: 32, unix: 16 })
    expect(L.max_safe_integer).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('the helper source holds the same numbers', () => {
    const src = (file: string) => text(file)
    const num = (file: string, name: string): number => {
      const m = new RegExp(`const ${name}: \\w+ = ([0-9_]+);`).exec(src(file))
      if (!m) throw new Error(`${name} not found in ${file}`)
      return Number(m[1].replace(/_/g, ''))
    }
    const secs = (file: string, name: string): number => {
      const m = new RegExp(`const ${name}: Duration = Duration::from_secs\\((\\d+)\\);`).exec(src(file))
      if (!m) throw new Error(`${name} not found in ${file}`)
      return Number(m[1])
    }
    expect(num('helper/src/request.rs', 'MAX_ARGV_ITEMS')).toBe(L.argv_items)
    expect(num('helper/src/request.rs', 'MAX_ARG_CHARS')).toBe(L.arg_chars)
    expect(num('helper/src/request.rs', 'MAX_CWD_CHARS')).toBe(L.cwd_chars)
    expect(num('helper/src/request.rs', 'MAX_ENV_ENTRIES')).toBe(L.env_entries)
    expect(num('helper/src/request.rs', 'MAX_ENV_NAME_CHARS')).toBe(L.env_name_chars)
    expect(num('helper/src/request.rs', 'MAX_ENV_VALUE_CHARS')).toBe(L.env_value_chars)
    expect(num('helper/src/request.rs', 'MAX_TERM_CELLS')).toBe(L.term_cells)
    expect(num('helper/src/request.rs', 'MAX_SAFE_INTEGER')).toBe(L.max_safe_integer)
    expect(num('helper/src/store.rs', 'MAX_LABEL_CHARS')).toBe(L.label_chars)
    expect(num('helper/src/store.rs', 'DEFAULT_AWAY_SECS')).toBe(L.away_default_secs)
    expect(num('helper/src/store.rs', 'MAX_AWAY_SECS')).toBe(L.away_max_secs)
    expect(num('helper/src/serve.rs', 'MAX_CONNECTIONS')).toBe(L.connections)
    expect(num('helper/src/serve.rs', 'REFUSALS_PER_MINUTE')).toBe(L.refusals_per_minute)
    expect(num('helper/src/serve.rs', 'TERMINAL_CHANNEL')).toBe(L.terminal_channel)
    expect(num('helper/src/holder.rs', 'LIVE_QUEUE_CHUNKS')).toBe(256)
    expect(section).toContain('falls 256 chunks behind')
    expect(num('helper/src/holder.rs', 'INPUT_QUEUE_FRAMES')).toBe(64)
    expect(section).toContain('while at most 64 frames of typed input wait')
    expect(/pub const LOCK_FILE: &str = "\.lock";/.test(src('helper/src/store.rs'))).toBe(true)
    expect(section).toContain('The store\'s lock file, `<store>/.lock`, is never removed.')
    expect(section).toContain('Each limit is for the whole frame')
    expect(num('helper/src/serve.rs', 'MAX_JSON_BEFORE_ACK')).toBe(4096)
    expect(num('helper/src/serve.rs', 'MAX_JSON_AFTER_LAUNCH')).toBe(64 * 1024)
    expect(section).toContain("A frame's JSON is at most 4 KiB before the `hello.ack`, at most 64 KiB once the session is launched")
    expect(section).toContain('every later raw frame on that connection is refused too')
    expect(section).toContain('When the `pong` comes, the number of `busy` replies before it is the number of frames not taken')
    expect(section).toContain('When the stream ends before the `pong`, the app cannot tell which of those frames were taken')
    expect(section).toContain('It sends none of them again, so nothing is ever typed twice')
    expect(section).toContain('the 5 s are for the whole message')
    expect(src('helper/src/transport/windows.rs')).toContain('format!("O:{sid}D:P(A;;GA;;;{sid})")')
    expect(num('helper/src/pids.rs', 'START_SLACK_MS')).toBe(60_000)
    expect(section).toContain("started more than 60 s after the record's `started`")
    expect(num('helper/src/main.rs', 'EXIT_ALREADY_RUNNING')).toBe(3)
    expect(section).toContain('Exit 3 means a holder for that session is already running')
    expect(secs('helper/src/serve.rs', 'ACK_TIMEOUT')).toBe(L.ack_timeout_secs)
    expect(secs('helper/src/serve.rs', 'IDLE_TIMEOUT')).toBe(L.idle_timeout_secs)
    expect(secs('helper/src/transport/mod.rs', 'WRITE_TIMEOUT')).toBe(L.write_timeout_secs)
    const hex = [...src('helper/src/transport/mod.rs').matchAll(/#\[cfg\((windows|unix)\)\]\npub const ENDPOINT_RANDOM_HEX: usize = (\d+);/g)].map((m) => [m[1], Number(m[2])])
    expect(Object.fromEntries(hex)).toEqual(L.endpoint_random_hex)
    expect(/pub const LOCAL_CAPS: \[&str; 2\] = \["core", "local"\];/.test(src('helper/src/hello.rs'))).toBe(true)
    const fields = /const FIELDS: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(src('helper/src/store.rs'))
    expect(fields, 'FIELDS in store.rs').not.toBeNull()
    expect([...fields![2].matchAll(/"([a-z]+)"/g)].map((m) => m[1])).toEqual(local.record_fields)
  })
})
