import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  FRAME_MIN_REST,
  JSON_DEPTH_MAX,
  JSON_FROM_HELPER_MAX,
  JSON_TO_HELPER_MAX,
  LAUNCH_LIMITS,
  NONCE_RE,
  RAW_MAX,
  SID_RE,
  checkLaunch,
  chooseProto,
  decodeOneFrame,
  encodeInput,
  encodeJsonFrame,
  encodeRawFrame,
  heldSessionId,
  helloAck,
  parseHelloLine,
  parseSelfTestResult,
  parseVersionLine,
  readListing,
  readRecord,
  validEndpoint,
  type HelperOs,
} from '../../../src/main/session-helper/protocol'

// The app's own client against the helper's shared vectors (helper/fixtures):
// the same files the Rust helper and the reference readers in
// tests/unit/scripts/helper-fixtures.test.ts are checked against, so the app
// and the helper cannot drift apart without a vector failing here.

const FIX = resolve(__dirname, '../../../helper/fixtures')
const read = (name: string) => JSON.parse(readFileSync(resolve(FIX, name), 'utf8'))
const frames = read('frames.json')
const hello = read('hello.json')
const limits = read('limits.json')
const local = read('local.json')
const OSES: HelperOs[] = ['unix', 'windows']
const appliesOn = (v: { os?: HelperOs }, os: HelperOs) => v.os === undefined || v.os === os

describe('session helper protocol: the numbers are the helper\'s', () => {
  it('frame limits, patterns and launch limits match the fixtures', () => {
    expect(FRAME_MIN_REST).toBe(limits.frame.min_rest)
    expect(JSON_FROM_HELPER_MAX).toBe(limits.frame.json_helper_to_app)
    expect(JSON_TO_HELPER_MAX).toBe(limits.frame.json_app_to_helper)
    expect(RAW_MAX).toBe(limits.frame.raw)
    expect(JSON_DEPTH_MAX).toBe(limits.frame.json_depth)
    expect(SID_RE.source).toBe(limits.sid_pattern)
    expect(NONCE_RE.source).toBe(limits.nonce_pattern)
    const L = local.limits
    expect(LAUNCH_LIMITS).toEqual({
      argvItems: L.argv_items, argChars: L.arg_chars, cwdChars: L.cwd_chars, envEntries: L.env_entries,
      envNameChars: L.env_name_chars, envValueChars: L.env_value_chars, termCells: L.term_cells,
    })
  })
})

describe('session helper protocol: frames', () => {
  it('every valid vector decodes to its fields, in its own direction', () => {
    for (const v of frames.valid) {
      const got = decodeOneFrame(Buffer.from(v.hex, 'hex'), v.flow)
      expect('error' in got, v.name).toBe(false)
      if ('error' in got) continue
      expect(got.kind, v.name).toBe(v.kind === 'json' ? 0 : 1)
      expect(got.channel, v.name).toBe(v.channel)
      if (got.kind === 0) expect(got.json, v.name).toEqual(JSON.parse(v.payload_text))
      else expect(got.bytes.toString('hex'), v.name).toBe(v.payload_hex)
    }
  })

  it('every invalid vector is refused with the code it names', () => {
    for (const v of frames.invalid) {
      const got = decodeOneFrame(Buffer.from(v.hex, 'hex'), v.flow)
      expect(got, v.name).toEqual({ error: v.error })
    }
  })

  it('what the app writes is exactly the vector bytes: JSON and raw frames', () => {
    for (const v of frames.valid) {
      if (v.flow !== 'app_to_helper') continue
      const json = v.kind === 'json'
      // A vector whose text is not the compact form the app writes is read, not written.
      if (json && JSON.stringify(JSON.parse(v.payload_text)) !== v.payload_text) continue
      const bytes = json ? encodeJsonFrame(JSON.parse(v.payload_text), v.channel) : encodeRawFrame(Buffer.from(v.payload_hex, 'hex'), v.channel)
      expect(bytes.toString('hex'), v.name).toBe(v.hex)
    }
    const launch = JSON.parse(local.launch_frame.payload_text)
    expect(encodeJsonFrame(launch).toString('hex')).toBe(local.launch_frame.hex)
  })

  it('terminal input is split into raw frames of at most 64 KiB', () => {
    const parts = encodeInput(Buffer.alloc(RAW_MAX * 2 + 3, 0x61))
    expect(parts).toHaveLength(3)
    expect(parts.map((p) => p.readUInt32BE(0) - FRAME_MIN_REST)).toEqual([RAW_MAX, RAW_MAX, 3])
    expect(parts.every((p) => p[4] === 1 && p.readUInt32BE(5) === 1)).toBe(true)
  })
})

describe('session helper protocol: the hello', () => {
  it('every valid hello reads as its expectation says', () => {
    for (const v of hello.valid) {
      const h = parseHelloLine(v.line, hello.expected_nonce, hello.expected_sid)
      expect({ proto: h.proto, helper_version: h.helperVersion, sha256: h.sha256, os: h.os, arch: h.arch, caps: h.caps, sid: h.sid, state: h.state }, v.name).toEqual(v.expect)
    }
  })

  it('every invalid hello fails as no-hello, nothing read from it', () => {
    for (const v of hello.invalid) {
      expect(() => parseHelloLine(v.line, hello.expected_nonce, hello.expected_sid), v.name).toThrow()
      try { parseHelloLine(v.line, hello.expected_nonce, hello.expected_sid) } catch (e) { expect((e as { code?: string }).code, v.name).toBe('no-hello') }
    }
  })

  it('version choice, and the ack is the one valid shape with core and local', () => {
    for (const c of hello.proto_choice) expect(chooseProto(c.app, c.helper)).toBe(c.chosen)
    expect(helloAck()).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local'] })
    expect(local.caps).toEqual(expect.arrayContaining(['core', 'local']))
  })
})

describe('session helper protocol: records, listings and endpoints (section 15)', () => {
  it('endpoints: only this shape, on each OS', () => {
    for (const os of OSES) {
      for (const e of local.endpoint[os].valid) expect(validEndpoint(e, local.endpoint.sid, os), `${os} ${e}`).toBe(true)
      for (const e of local.endpoint[os].invalid) expect(validEndpoint(e, local.endpoint.sid, os), `${os} ${e}`).toBe(false)
    }
  })

  it('records: strict, as the helper writes them', () => {
    for (const os of OSES) {
      for (const v of local.records.valid.filter((x: { os?: HelperOs }) => appliesOn(x, os))) expect(readRecord(v.record, os), `${os} ${v.name}`).not.toBeNull()
      for (const v of local.records.invalid.filter((x: { os?: HelperOs }) => appliesOn(x, os))) expect(readRecord(v.record, os), `${os} ${v.name}`).toBeNull()
    }
  })

  it('listings: strict, every record valid', () => {
    for (const os of OSES) {
      for (const v of local.listing.valid.filter((x: { os?: HelperOs }) => appliesOn(x, os))) expect(readListing(v.line, os), `${os} ${v.name}`).not.toBeNull()
      for (const v of local.listing.invalid.filter((x: { os?: HelperOs }) => appliesOn(x, os))) expect(readListing(v.line, os), `${os} ${v.name}`).toBeNull()
    }
  })

  it('a launch the holder would refuse is refused here first, with the same code', () => {
    let checked = 0
    for (const os of OSES) {
      for (const v of [...local.requests.valid, ...local.requests.invalid]) {
        if (!appliesOn(v, os)) continue
        let m: Record<string, unknown>
        try { m = JSON.parse(v.json) } catch { continue }
        if (!m || m.t !== 'term.launch' || typeof m.id !== 'number') continue
        const keys = Object.keys(m).sort().join(',')
        if (keys !== 'argv,cols,cwd,env,id,rows,t') continue
        const want = v.error ?? null
        const got = checkLaunch(m as never, os)
        expect(got ? got.code : null, `${os} ${v.name}`).toBe(want)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(4)
  })

  it('names that differ only in case are refused on every OS (the app then starts the terminal the usual way)', () => {
    const spec = { argv: ['/bin/sh'], cwd: '/home/u', env: { http_proxy: 'a', HTTP_PROXY: 'b' }, cols: 80, rows: 24 }
    expect(checkLaunch(spec, 'unix')?.code).toBe('bad-field')
    expect(checkLaunch({ ...spec, argv: ['C:\\Windows\\System32\\cmd.exe'], cwd: 'C:\\Users\\u' }, 'windows')?.code).toBe('bad-field')
    expect(checkLaunch({ ...spec, env: { PATH: '/bin' } }, 'unix')).toBeNull()
  })
})

describe('session helper protocol: ids and one-shot output', () => {
  it('the held session id is stable for an app id and always of the protocol\'s shape', () => {
    for (const id of ['0123456789abcdef01234567', '0123456789abcdef01234567-partner', 'a', 'A_b-c']) {
      expect(heldSessionId(id)).toMatch(SID_RE)
      expect(heldSessionId(id)).toBe(heldSessionId(id))
    }
    expect(heldSessionId('x')).not.toBe(heldSessionId('x-partner'))
  })

  it('version and self-test lines', () => {
    expect(parseVersionLine('aicc-helper 0.1.0\n')).toBe('0.1.0')
    expect(parseVersionLine('aicc-helper 0.1.0-beta.1')).toBe('0.1.0-beta.1')
    expect(parseVersionLine('something else 0.1.0')).toBeNull()
    const nonce = '0123456789abcdef0123456789abcdef'
    const body = { ok: false, helper: '0.1.0', os: 'windows', arch: 'x86_64', checks: [{ name: 'hello', ok: true }, { name: 'local-transport', ok: false, detail: 'no pipe' }] }
    const r = parseSelfTestResult(`noise\nAICC-RESULT ${nonce} ${JSON.stringify(body)}\n`, nonce)
    expect(r).toEqual({ ok: false, helper: '0.1.0', checks: [{ name: 'hello', ok: true }, { name: 'local-transport', ok: false, detail: 'no pipe' }] })
    expect(parseSelfTestResult(`AICC-RESULT ${'f'.repeat(32)} ${JSON.stringify(body)}`, nonce)).toBeNull()
  })
})
