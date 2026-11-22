import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  FRAME_MIN_REST,
  HELPER_HOOK_KINDS,
  HOOKS_CAP,
  HOOK_EVENT_JSON_MAX,
  HOOK_PAYLOAD_MAX,
  JSON_DEPTH_MAX,
  JSON_FROM_HELPER_MAX,
  JSON_TO_HELPER_MAX,
  LAUNCH_LIMITS,
  MCP_CAP,
  MCP_MESSAGE_TO_APP_MAX,
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
  readEventFrame,
  readListing,
  readMcp,
  readMcpClose,
  readMcpOpen,
  readRecord,
  readScreenLines,
  readScreenRows,
  MOUSE_ENCODING_WORDS,
  MOUSE_WORDS,
  SCREEN_CAP,
  SCREEN_TAIL_MAX,
  SCREEN_TITLE_MAX,
  SCREEN_WORDS,
  TITLE_CAP,
  validEndpoint,
  type HelperOs,
} from '../../../src/main/session-helper/protocol'
import { MVP_EVENTS } from '../../../src/main/hooks/session-hooks-writer'

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
      envNameChars: L.env_name_chars, envValueChars: L.env_value_chars, lineUnits: L.line_units, termCells: L.term_cells,
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
    let windowsFields = 0
    for (const os of OSES) {
      for (const v of [...local.requests.valid, ...local.requests.invalid]) {
        if (!appliesOn(v, os)) continue
        let m: Record<string, unknown>
        try { m = JSON.parse(v.json) } catch { continue }
        if (!m || m.t !== 'term.launch' || typeof m.id !== 'number') continue
        // The launch's own fields, and the two Windows ones (`line` and
        // `conpty`); a vector with any other key is about the frame, not the launch.
        const base = ['argv', 'cols', 'cwd', 'env', 'id', 'rows', 't']
        const keys = Object.keys(m)
        if (!base.every((k) => keys.includes(k)) || !keys.every((k) => base.includes(k) || k === 'line' || k === 'conpty')) continue
        const want = v.error ?? null
        const got = checkLaunch(m as never, os)
        expect(got ? got.code : null, `${os} ${v.name}`).toBe(want)
        checked++
        if ('line' in m || 'conpty' in m) windowsFields++
      }
    }
    expect(checked).toBeGreaterThan(4)
    // Each vector with a Windows field is checked on the OS it is tagged for
    // (on both when it names none): none is skipped by the key filter above.
    const tagged = [...local.requests.valid, ...local.requests.invalid].filter((v: { json: string }) => /"(line|conpty)":/.test(v.json))
    const expected = tagged.reduce((n: number, v: { os?: HelperOs }) => n + OSES.filter((os) => appliesOn(v, os)).length, 0)
    expect(tagged.length).toBeGreaterThan(0)
    expect(windowsFields).toBe(expected)
  })

  it('an exact command line (`line`) is for Windows only, 1 to 32766 UTF-16 units, with no NUL, the program alone in argv and never a batch file', () => {
    const cmd = 'C:\\Windows\\System32\\cmd.exe'
    const spec = { argv: [cmd], cwd: 'C:\\Users\\u', env: { SystemRoot: 'C:\\Windows' }, cols: 80, rows: 24 }
    const line = `${cmd} /d /v:off /s /c ""C:\\Users\\u\\AppData\\Roaming\\npm\\tool.cmd" resume"`
    expect(checkLaunch({ ...spec, line }, 'windows')).toBeNull()
    expect(checkLaunch({ ...spec, argv: ['/bin/sh'], cwd: '/home/u', line: '/bin/sh -c true' }, 'unix')?.code).toBe('bad-field')
    // The longest CreateProcessW takes (32767 units with the NUL that ends
    // it) and one past it, counted in UTF-16 units as Windows counts them:
    // a character outside the Basic Multilingual Plane is two.
    expect(LAUNCH_LIMITS.lineUnits).toBe(32766)
    expect(checkLaunch({ ...spec, line: 'a'.repeat(32766) }, 'windows')).toBeNull()
    expect(checkLaunch({ ...spec, line: '\u00e9'.repeat(32766) }, 'windows')).toBeNull()
    expect(checkLaunch({ ...spec, line: String.fromCodePoint(0x1f600).repeat(16383) }, 'windows')).toBeNull()
    expect(checkLaunch({ ...spec, line: 'a'.repeat(32767) }, 'windows')?.code).toBe('too-large')
    expect(checkLaunch({ ...spec, line: `${String.fromCodePoint(0x1f600).repeat(16383)}a` }, 'windows')?.code).toBe('too-large')
    expect(checkLaunch({ ...spec, line: String.fromCodePoint(0x1f600).repeat(16384) }, 'windows')?.code).toBe('too-large')
    expect(checkLaunch({ ...spec, line: `${cmd} /c a\0b` }, 'windows')?.code).toBe('bad-field')
    expect(checkLaunch({ ...spec, line: '' }, 'windows')?.code).toBe('bad-field')
    expect(checkLaunch({ ...spec, line: 7 } as never, 'windows')?.code).toBe('bad-field')
    expect(checkLaunch({ ...spec, line: null } as never, 'windows')?.code).toBe('bad-field')
    expect(checkLaunch({ ...spec, argv: [cmd, '/c'], line }, 'windows')?.code).toBe('bad-field')
    // Never a batch file: Windows starts one through cmd.exe, which would read
    // the line as commands. Any case, trailing dots and spaces dropped.
    for (const batch of ['C:\\x\\tool.cmd', 'C:\\x\\tool.BAT', 'C:\\x\\tool.cmd. ', 'C:\\x\\tool.Cmd..']) {
      expect(checkLaunch({ ...spec, argv: [batch], line: 'tool resume' }, 'windows')?.code, batch).toBe('bad-field')
      expect(checkLaunch({ ...spec, argv: [batch, 'resume'] }, 'windows'), `${batch} with an argument list`).toBeNull()
    }
    for (const program of ['C:\\x\\tool.bat.exe', 'C:\\x.cmd\\tool.exe', 'C:\\x\\cmd']) {
      expect(checkLaunch({ ...spec, argv: [program], line: 'tool resume' }, 'windows'), program).toBeNull()
    }
    // The name checked is the name Windows opens. Windows resolves a part of
    // dots alone (`.`, `..`, and with trailing spaces) and reads `/` as `\`
    // before it opens the file, so tool.cmd\. and tool.cmd\sub\.. are
    // tool.cmd: with a line, such a name is refused, and so is one that ends
    // in a separator; a part that only starts or ends with a dot is a plain
    // name. Both lists are shared vectors (helper/fixtures/local.json, read
    // above), so every reader is held to them. With an argument list, as
    // before, the name is not read.
    for (const renamed of [
      'C:\\x\\tool.cmd\\.',
      'C:\\x\\tool.cmd\\sub\\..',
      'C:/x/tool.cmd/sub/..',
      'C:\\x\\tool.cmd\\. ',
      'C:\\x\\tool.cmd\\.. \\.',
      'C:\\x\\tool.cmd\\',
      'C:\\x\\tool.cmd/',
      'C:\\x\\sub\\..\\tool.exe',
      '\\\\.\\C:\\x\\tool.exe',
    ]) {
      expect(checkLaunch({ ...spec, argv: [renamed, 'resume'] }, 'windows'), `${renamed} with an argument list`).toBeNull()
    }
  })

  it('the bundled ConPTY (`conpty: "bundled"`) is for Windows only, and no other value is', () => {
    const spec = { argv: ['C:\\Windows\\System32\\cmd.exe'], cwd: 'C:\\Users\\u', env: {}, cols: 80, rows: 24 }
    expect(checkLaunch({ ...spec, conpty: 'bundled' }, 'windows')).toBeNull()
    expect(checkLaunch({ ...spec, argv: ['/bin/sh'], cwd: '/home/u', conpty: 'bundled' }, 'unix')?.code).toBe('bad-field')
    for (const other of ['system', 'BUNDLED', '', true, null, 1]) {
      expect(checkLaunch({ ...spec, conpty: other } as never, 'windows')?.code, String(other)).toBe('bad-field')
    }
    // Left out, the system ConPTY: the launch is as before.
    expect(checkLaunch(spec, 'windows')).toBeNull()
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

// 2.1.3-beta.8, plan section A4: the `hooks` part of helper/fixtures/local.json
// (section A3's vectors), read from the app's side. The app sends no
// `hook.event` (the hook mode does); it acks `hooks` and reads `event`.
describe('session helper protocol: hook events (capability hooks, section 15)', () => {
  const H = local.hooks
  /** An `event` frame from a holder, as the app's reader gets it. */
  const asRead = (msg: unknown): ReturnType<typeof readEventFrame> => {
    const f = decodeOneFrame(encodeJsonFrame(msg), 'helper_to_app')
    if ('error' in f || f.kind !== 0) throw new Error('not one JSON frame')
    return readEventFrame(f.json, f.size)
  }

  it('the kinds a holder passes on are the kinds the app injects: HELPER_HOOK_KINDS and MVP_EVENTS are the same set', () => {
    // Direct, not through the fixture: a kind injected into the settings that the
    // reader refuses is a hook event dropped silently, and one the reader takes
    // that is never injected is dead.
    expect(new Set<string>(HELPER_HOOK_KINDS)).toEqual(new Set<string>(MVP_EVENTS))
    expect(HELPER_HOOK_KINDS).toHaveLength(MVP_EVENTS.length)
  })

  it("the caps, the nine kinds and the payload limit are the helper's", () => {
    expect(HOOKS_CAP).toBe('hooks')
    expect(H.caps).toEqual(['core', 'local', HOOKS_CAP])
    expect([...HELPER_HOOK_KINDS]).toEqual(H.kinds)
    // The kinds the app injects into a session's settings are the same nine.
    expect(MVP_EVENTS).toEqual(H.kinds)
    expect(HOOK_PAYLOAD_MAX).toBe(H.limits.payload_bytes)
    expect(HOOK_EVENT_JSON_MAX).toBe(64 * 1024)
  })

  it('the ack names hooks only when asked to', () => {
    expect(helloAck(true)).toEqual({ t: 'hello.ack', proto: 1, caps: H.caps })
    expect(helloAck(false)).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local'] })
    expect(helloAck()).toEqual(helloAck(false))
  })

  it('every event message vector reads as its fields say, exactly as the holder sends it', () => {
    for (const v of H.messages) {
      const f = decodeOneFrame(encodeJsonFrame(JSON.parse(v.json)), 'helper_to_app')
      if ('error' in f || f.kind !== 0) throw new Error(v.name)
      expect(f.size, v.name).toBe(Buffer.byteLength(v.json, 'utf8'))
      // No `lost` when nothing was dropped before it.
      expect(readEventFrame(f.json, f.size), v.name).toEqual({ seq: v.seq, kind: v.kind, payload: v.payload, ...(v.lost > 0 ? { lost: v.lost } : {}) })
    }
  })

  it('the largest event there can be is read; a payload one byte larger is not', () => {
    const L = H.largest
    const build = (payloadBytes: number) => {
      const head = JSON.stringify({ hook_event_name: L.kind, prompt: '' })
      const payload = { hook_event_name: L.kind, prompt: 'x'.repeat(payloadBytes - Buffer.byteLength(head, 'utf8')) }
      return { t: 'event', seq: L.seq, kind: L.kind, payload, lost: L.lost }
    }
    const largest = build(H.limits.payload_bytes)
    expect(Buffer.byteLength(JSON.stringify(largest.payload), 'utf8')).toBe(H.limits.payload_bytes)
    expect(Buffer.byteLength(JSON.stringify(largest), 'utf8')).toBe(L.event_bytes)
    expect(asRead(largest)).toEqual({ seq: L.seq, kind: L.kind, payload: largest.payload, lost: L.lost })
    expect(asRead(build(H.limits.payload_bytes + 1))).toBeNull()
    // A message over 64 KiB as it came is refused whatever it holds.
    expect(readEventFrame(largest, HOOK_EVENT_JSON_MAX + 1)).toBeNull()
  })

  it('what a holder takes in a hook.event, it may pass on: each valid request vector, as an event, reads', () => {
    for (const v of H.requests.valid) {
      const req = JSON.parse(v.json)
      expect(asRead({ t: 'event', seq: 1, kind: req.kind, payload: req.payload }), v.name).toEqual({ seq: 1, kind: req.kind, payload: req.payload })
    }
  })

  it('what a holder refuses for its kind or payload, the app refuses in an event too', () => {
    // The vectors about the request's own envelope (its id, an extra or doubled
    // field, the ack) have no counterpart in an event. A payload naming a
    // member twice is the holder's to refuse: JSON.parse keeps the last.
    const ABOUT_KIND_OR_PAYLOAD = [
      'an unknown kind', 'a kind in another case', 'a kind that is not a string', 'a payload over 64 KiB as JSON',
      'a payload that is not an object', 'a payload without hook_event_name', 'a payload whose hook_event_name is another kind',
      'a missing payload', 'a missing kind',
    ]
    const named = H.requests.invalid.filter((v: { name: string }) => ABOUT_KIND_OR_PAYLOAD.includes(v.name))
    expect(named.map((v: { name: string }) => v.name).sort()).toEqual([...ABOUT_KIND_OR_PAYLOAD].sort())
    for (const v of named) {
      const req = JSON.parse(v.json)
      const msg: Record<string, unknown> = { t: 'event', seq: 1 }
      if ('kind' in req) msg.kind = req.kind
      if ('payload' in req) msg.payload = req.payload
      expect(asRead(msg), v.name).toBeNull()
    }
  })

  it('an event message is read strictly: its fields only, seq from 1, lost a whole number', () => {
    const ok = { t: 'event', seq: 3, kind: 'Stop', payload: { hook_event_name: 'Stop' } }
    expect(asRead(ok)).toEqual({ seq: 3, kind: 'Stop', payload: { hook_event_name: 'Stop' } })
    const bad: Array<[string, unknown]> = [
      ['seq 0', { ...ok, seq: 0 }],
      ['a negative seq', { ...ok, seq: -1 }],
      ['a seq that is not whole', { ...ok, seq: 1.5 }],
      ['a seq past 2^53 - 1', { ...ok, seq: Number.MAX_SAFE_INTEGER + 1 }],
      ['a seq as text', { ...ok, seq: '3' }],
      ['no seq', { t: 'event', kind: 'Stop', payload: { hook_event_name: 'Stop' } }],
      ['a negative lost', { ...ok, lost: -1 }],
      ['a lost that is not whole', { ...ok, lost: 0.5 }],
      ['an extra field', { ...ok, re: 2 }],
      ['another type', { ...ok, t: 'status' }],
      ['not an object', ['event', 3]],
    ]
    for (const [what, msg] of bad) expect(asRead(msg), what).toBeNull()
  })
})

// 2.1.3-beta.10, plan section B2: the `mcp` part of helper/fixtures/local.json,
// read from the app's side. No connection the app makes acks `mcp` yet; these
// are the readers the step that wires a session's tools will use.
describe('session helper protocol: tool streams (capability mcp, section 15)', () => {
  const M = local.mcp
  /** A tool message as the app's reader gets it from a holder's frame. */
  const read = (msg: unknown) => {
    const f = decodeOneFrame(encodeJsonFrame(msg), 'helper_to_app')
    if ('error' in f || f.kind !== 0) throw new Error('not one JSON frame')
    const t = (f.json as { t?: unknown }).t
    return t === 'mcp' ? readMcp(f.json, f.size) : t === 'mcp.open' ? readMcpOpen(f.json) : readMcpClose(f.json)
  }
  const fields = (v: { t?: string; type?: string; stream: number; message?: unknown }) =>
    (v.t ?? v.type) === 'mcp' ? { stream: v.stream, message: v.message } : { stream: v.stream }

  it("the cap, the caps a holder offers and the message limit are the helper's", () => {
    expect(MCP_CAP).toBe('mcp')
    expect(M.offered).toEqual(['core', 'local', HOOKS_CAP, MCP_CAP])
    expect(M.relay_caps).toEqual(['core', 'local', MCP_CAP])
    expect(MCP_MESSAGE_TO_APP_MAX).toBe(M.limits.message_to_app_bytes)
    // It leaves the 256 bytes the `mcp` around a message needs.
    expect(MCP_MESSAGE_TO_APP_MAX + 256).toBe(JSON_FROM_HELPER_MAX)
  })

  it('the ack names mcp only when asked to, after hooks when both are', () => {
    expect(helloAck(false, true)).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local', MCP_CAP] })
    expect(helloAck(true, true)).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local', HOOKS_CAP, MCP_CAP] })
    expect(helloAck(true)).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local', HOOKS_CAP] })
    expect(helloAck(false, false)).toEqual(helloAck())
  })

  it('every message vector reads as its fields say, exactly as the holder sends it', () => {
    expect(M.messages.map((v: { type: string }) => v.type)).toEqual(expect.arrayContaining(['mcp.open', 'mcp', 'mcp.close']))
    for (const v of M.messages) {
      const f = decodeOneFrame(encodeJsonFrame(JSON.parse(v.json)), 'helper_to_app')
      if ('error' in f || f.kind !== 0) throw new Error(v.name)
      expect(f.size, v.name).toBe(Buffer.byteLength(v.json, 'utf8'))
      expect(read(JSON.parse(v.json)), v.name).toEqual(fields(v))
    }
  })

  it('what a holder takes from a relay, the app reads when the holder passes it on', () => {
    for (const v of M.requests.valid) {
      const req = JSON.parse(v.json)
      expect(read(req), v.name).toEqual(fields(req))
    }
  })

  it('a message that breaks its schema is refused', () => {
    expect(M.invalid_messages.length).toBeGreaterThanOrEqual(8)
    for (const v of M.invalid_messages) expect(read(JSON.parse(v.json)), v.name).toBeNull()
    // Each reader reads its own type only, and an object only.
    expect(readMcpOpen({ t: 'mcp.close', stream: 1 })).toBeNull()
    expect(readMcpClose({ t: 'mcp.open', stream: 1 })).toBeNull()
    expect(readMcp({ t: 'mcp.open', stream: 1, message: {} }, 40)).toBeNull()
    expect(readMcpOpen(['mcp.open', 1])).toBeNull()
    expect(readMcp(null, 4)).toBeNull()
  })

  it('the largest message to the app is read; one byte larger is not, nor a message over a frame', () => {
    const ofSize = (bytes: number) => ['x'.repeat(bytes - 4)]
    const largest = { t: 'mcp', stream: Number.MAX_SAFE_INTEGER, message: ofSize(MCP_MESSAGE_TO_APP_MAX) }
    expect(Buffer.byteLength(JSON.stringify(largest.message), 'utf8')).toBe(MCP_MESSAGE_TO_APP_MAX)
    expect(read(largest)).toEqual({ stream: Number.MAX_SAFE_INTEGER, message: largest.message })
    expect(read({ ...largest, message: ofSize(MCP_MESSAGE_TO_APP_MAX + 1) })).toBeNull()
    expect(readMcp(largest, JSON_FROM_HELPER_MAX + 1)).toBeNull()
  })
})

// 2.1.3-beta.12, plan section A3: the `screen` part of helper/fixtures/local.json,
// read from the app's side. From 2.1.3-beta.13 a plain terminal's connections
// ack `screen` (a take-over reads the holder's size); the title vectors
// (2.1.3-beta.14, plan section B1) are read as a connection that acked
// `title` reads them when the vector's `acked` names it.
describe('session helper protocol: screen reads (capability screen, section 15)', () => {
  const S = local.screen
  /** True when a vector is read as a connection that acked `screen` and `title`. */
  const titled = (v: { acked?: string[] }) => !!v.acked?.includes(SCREEN_CAP) && v.acked.includes(TITLE_CAP)
  /** An answer as the app's reader gets it from a holder's frame. */
  const read = (msg: unknown, title = false) => {
    const f = decodeOneFrame(encodeJsonFrame(msg), 'helper_to_app')
    if ('error' in f || f.kind !== 0) throw new Error('not one JSON frame')
    return (f.json as { t?: unknown }).t === 'screen.lines' ? readScreenLines(f.json, f.size) : readScreenRows(f.json, f.size, title)
  }
  /** What a reader gives for a holder's answer: its fields but `t` and `re`,
   *  and for `screen.rows` its title (null when the answer carries none). */
  const fields = (v: Record<string, unknown>) => {
    const { t: _t, re: _re, ...rest } = v
    return v.t === 'screen.rows' ? { ...rest, title: rest.title ?? null } : rest
  }

  it("the cap, the caps a holder offers, the words and the limits are the helper's", () => {
    expect(SCREEN_CAP).toBe('screen')
    expect(TITLE_CAP).toBe('title')
    expect(S.offered).toEqual(['core', 'local', HOOKS_CAP, MCP_CAP, 'away', SCREEN_CAP, TITLE_CAP])
    expect(SCREEN_TITLE_MAX).toBe(S.limits.title_chars)
    expect(S.offered.slice(0, 5)).toEqual(local.away.offered)
    expect(SCREEN_TAIL_MAX).toBe(S.limits.tail_lines)
    expect(JSON_FROM_HELPER_MAX).toBe(S.limits.answer_bytes)
    expect([SCREEN_WORDS, MOUSE_WORDS, MOUSE_ENCODING_WORDS]).toEqual([
      ['normal', 'alternate'],
      ['none', 'press', 'press-release', 'button-motion', 'any-motion'],
      ['default', 'utf8', 'sgr'],
    ])
  })

  it('the ack names screen only when asked to, after hooks and mcp', () => {
    expect(helloAck(false, false, true)).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local', SCREEN_CAP] })
    expect(helloAck(true, true, true)).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local', HOOKS_CAP, MCP_CAP, SCREEN_CAP] })
    expect(helloAck(true, true)).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local', HOOKS_CAP, MCP_CAP] })
    expect(helloAck(false, false, false)).toEqual(helloAck())
  })

  it('every answer vector reads as its fields say, exactly as the holder sends it', () => {
    expect(S.messages.map((v: { type: string }) => v.type)).toEqual(expect.arrayContaining(['screen.rows', 'screen.lines']))
    for (const v of S.messages) {
      const sent = JSON.parse(v.json)
      expect(sent.t, v.name).toBe(v.type)
      expect(read(sent, titled(v)), v.name).toEqual(fields(sent))
    }
    // A row the reader gives has every field a row of the app's readers has.
    const rows = read(JSON.parse(S.messages[0].json))
    if (!rows || !('rows' in rows)) throw new Error('not a screen.rows')
    expect(rows.lines[1]).toEqual({ text: 'dim cur', typed: '    cur', inverse: '    cur', width: 12, end: 7 })
    expect(rows.modes).toEqual({ screen: 'alternate', bracketed_paste: true, application_cursor: true, application_keypad: true, mouse: 'press-release', mouse_encoding: 'sgr', cursor_hidden: true })
  })

  it('an answer that breaks its schema, names an unknown mode word or is over a frame is refused', () => {
    expect(S.invalid_messages.length).toBeGreaterThanOrEqual(15)
    for (const v of S.invalid_messages) expect(read(JSON.parse(v.json), titled(v)), v.name).toBeNull()
    const rows = JSON.parse(S.messages[0].json)
    const lines = JSON.parse(S.messages.find((v: { type: string }) => v.type === 'screen.lines').json)
    // Each reader reads its own type only, and an object only.
    expect(readScreenRows(lines, 100)).toBeNull()
    expect(readScreenLines(rows, 100)).toBeNull()
    expect(readScreenRows(['screen.rows'], 20)).toBeNull()
    expect(readScreenLines(null, 4)).toBeNull()
    // Over what a frame from the holder holds.
    expect(readScreenRows(rows, JSON_FROM_HELPER_MAX)).not.toBeNull()
    expect(readScreenRows(rows, JSON_FROM_HELPER_MAX + 1)).toBeNull()
    expect(readScreenLines(lines, JSON_FROM_HELPER_MAX + 1)).toBeNull()
    // Cut: fewer rows than the screen has, never more nor as many.
    expect(readScreenRows({ ...rows, cut: true, lines: rows.lines.slice(1) }, 100)).not.toBeNull()
    expect(readScreenRows({ ...rows, cut: true }, 100)).toBeNull()
    // The cursor's column may be the screen's width (a wrap is pending), not past it.
    expect(readScreenRows({ ...rows, cursor: { row: 2, col: 12 } }, 100)).not.toBeNull()
    // The most lines a tail holds, and one more.
    const tail = (n: number) => ({ ...lines, lines: Array.from({ length: n }, () => ({ text: 'x', typed: 'x' })) })
    expect(readScreenLines(tail(SCREEN_TAIL_MAX), 100)).not.toBeNull()
    expect(readScreenLines(tail(SCREEN_TAIL_MAX + 1), 100)).toBeNull()
  })
})
