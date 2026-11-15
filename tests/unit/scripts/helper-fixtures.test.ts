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
