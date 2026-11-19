// The connection's own reading of hook events (2.1.3-beta.8, plan section A4;
// docs/remote/helper-protocol.md section 15), on an in-memory stream with a
// stand-in holder, so no manager guard can hide a gap in it:
//  - `hooks` is acked only when the connection wants hook events AND the hello
//    offers them, and an `event` is reported only on a connection that acked;
//  - every JSON control message travels on channel 0: one off channel 0 is
//    dropped, whatever it carries, and never answers a waiting request;
//  - an `event` is read as an event before any reply lookup, so one carrying
//    a `re` is refused (its fields are exact) and answers no request;
//  - `mcp` the same way (2.1.3-beta.10, plan section B2): acked only when the
//    connection is asked for it AND the hello offers it, and `mcp.open`, `mcp`
//    and `mcp.close` reported only on a connection that acked it;
//  - the app's own sends on a tool stream (2.1.3-beta.11, plan section B1):
//    one `mcp` frame, only on a stream the holder opened on a connection that
//    acked `mcp`; a message the holder would not read is never sent (its call
//    is answered with an error and the app's side of the stream ends), and
//    the connection stays up; the app's end of a stream sends no `mcp.close`
//    (the holder takes none from the attached connection).
import { describe, it, expect, afterEach } from 'vitest'
import { FrameReader, encodeJsonFrame, type HolderRecord } from '../../../src/main/session-helper/protocol'
import { HolderConnection, MCP_MESSAGE_TO_HELPER_MAX, TOOL_STREAM_SENTENCES } from '../../../src/main/session-helper/connection'
import { duplexPair } from './session-helper-fake-holder'

type Json = Record<string, unknown>

const SID = 'ag0123456789abcdef0123456789abcd'
const NONCE = '0123456789abcdef0123456789abcdef'
const RECORD: HolderRecord = {
  v: 1, session: SID, label: 'tab', pid: 4242, endpoint: `\\\\.\\pipe\\aicc-helper-${SID}-${'b'.repeat(32)}`, nonce: NONCE,
  helper: '0.1.0', started: 1, away: 120, attached: false, child: 'running', code: null,
}
const STOP = { t: 'event', seq: 1, kind: 'Stop', payload: { hook_event_name: 'Stop', session_id: 'c1' } }
/** What a holder of 2.1.3-beta.10 offers, and the three tool stream messages it sends the app. */
const ALL_CAPS = ['core', 'local', 'hooks', 'mcp']
const OPEN = { t: 'mcp.open', stream: 1 }
const CALL = { t: 'mcp', stream: 1, message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }
const CLOSE = { t: 'mcp.close', stream: 1 }

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(5)
  }
}

const open: HolderConnection[] = []
afterEach(() => { for (const c of open.splice(0)) c.close() })

/** A holder that says hello offering `caps`, and the app's connection to it
 *  (`hooks`: the connection wants hook events; `mcp`: it carries tool streams). */
async function connected(caps: string[], hooks: boolean, mcp = false) {
  const [app, holder] = duplexPair()
  const fromApp: Json[] = []
  const reader = new FrameReader('app_to_helper')
  holder.on('data', (chunk: Buffer) => { for (const f of reader.push(chunk)) if (f.kind === 0) fromApp.push(f.json as Json) })
  const hello = { proto: [1], helper: { version: '0.1.0' }, os: 'windows', arch: 'x86_64', caps, session: { sid: SID, state: 'live' } }
  holder.write(`AICC-HELLO ${NONCE} ${JSON.stringify(hello)}\n`)
  const conn = await HolderConnection.open({ record: RECORD, os: 'windows', openStream: async () => app, hooks, mcp, pingEveryMs: 600_000 })
  open.push(conn)
  const events: unknown[] = []
  conn.on('event', (e) => { events.push(e) })
  const tools: unknown[] = []
  conn.on('mcpOpen', (stream) => { tools.push(['open', stream]) })
  conn.on('mcp', (stream, message) => { tools.push(['mcp', stream, message]) })
  conn.on('mcpClose', (stream) => { tools.push(['close', stream]) })
  await until(() => fromApp.length >= 1, 'the hello.ack')
  return { conn, fromApp, events, tools, send: (m: unknown, channel = 0) => { holder.write(encodeJsonFrame(m, channel)) } }
}

describe('the connection acks hooks only when it wants them and the holder offers them', () => {
  it('a hello that offers hooks, to a connection that does not want them: core and local, and an event is not reported', async () => {
    const c = await connected(['core', 'local', 'hooks'], false)
    expect(c.fromApp[0]).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local'] })
    expect(c.conn.hooks).toBe(false)
    c.send(STOP)
    await tick(30)
    expect(c.events).toEqual([])
    expect(c.conn.isClosed).toBe(false)
  })

  it('a connection that wants hooks, to a hello that does not offer them: core and local, and an event is not reported', async () => {
    const c = await connected(['core', 'local'], true)
    expect(c.fromApp[0]).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local'] })
    expect(c.conn.hooks).toBe(false)
    c.send(STOP)
    await tick(30)
    expect(c.events).toEqual([])
  })

  it('both: hooks is acked and an event on channel 0 is reported, read strictly', async () => {
    const c = await connected(['core', 'local', 'hooks'], true)
    expect(c.fromApp[0]).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local', 'hooks'] })
    expect(c.conn.hooks).toBe(true)
    c.send(STOP)
    await until(() => c.events.length === 1, 'the event')
    expect(c.events).toEqual([{ seq: 1, kind: 'Stop', payload: STOP.payload }])
  })
})

describe('the connection acks mcp only when asked for it and the holder offers it', () => {
  it('a hello that offers mcp, to a connection not asked for it (as every connection the app makes today): never acked, and tool messages are dropped', async () => {
    for (const hooks of [false, true]) {
      const c = await connected(ALL_CAPS, hooks)
      expect(c.fromApp[0]).toEqual({ t: 'hello.ack', proto: 1, caps: hooks ? ['core', 'local', 'hooks'] : ['core', 'local'] })
      expect(c.conn.mcp).toBe(false)
      for (const m of [OPEN, CALL, CLOSE]) c.send(m)
      await tick(30)
      expect(c.tools).toEqual([])
      expect(c.conn.isClosed).toBe(false)
    }
  })

  it('a connection asked for mcp, to a hello that does not offer it: not acked, and tool messages are dropped', async () => {
    const c = await connected(['core', 'local', 'hooks'], true, true)
    expect(c.fromApp[0]).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local', 'hooks'] })
    expect(c.conn.mcp).toBe(false)
    for (const m of [OPEN, CALL, CLOSE]) c.send(m)
    await tick(30)
    expect(c.tools).toEqual([])
  })

  it('both: mcp is acked and the three messages are reported in order, read strictly', async () => {
    for (const hooks of [false, true]) {
      const c = await connected(ALL_CAPS, hooks, true)
      expect(c.fromApp[0]).toEqual({ t: 'hello.ack', proto: 1, caps: hooks ? ALL_CAPS : ['core', 'local', 'mcp'] })
      expect(c.conn.mcp).toBe(true)
      c.send(OPEN)
      c.send(CALL)
      // Each refused: a field it does not have, a message that is text, stream 0.
      c.send({ ...CALL, seq: 1 })
      c.send({ ...CALL, message: 'tools/list' })
      c.send({ ...OPEN, stream: 0 })
      c.send(CLOSE)
      await until(() => c.tools.length >= 3, 'the tool messages')
      await tick(20)
      expect(c.tools).toEqual([['open', 1], ['mcp', 1, CALL.message], ['close', 1]])
      expect(c.conn.isClosed).toBe(false)
    }
  })
})

describe("the app's sends on a tool stream (2.1.3-beta.11, plan section B1)", () => {
  /** The tool host's answer to the relay's tools/list. */
  const ANSWER = { jsonrpc: '2.0', id: 7, result: { tools: [{ name: 'vision_status' }] } }
  /** An answer `levels` deep in all: the message is the first level, its
   *  `result` the second, and the rest is arrays round an empty object. */
  const nested = (levels: number) => {
    let v: unknown = {}
    for (let i = 3; i < levels; i++) v = [v]
    return { jsonrpc: '2.0', id: 7, result: { content: v } }
  }
  const text = (t: string) => ({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: t }] } })
  const mcpFrames = (fromApp: Json[]) => fromApp.filter((m) => m.t === 'mcp' || m.t === 'mcp.close')
  const errorFor = (id: number, message: string) => ({ jsonrpc: '2.0', id, error: { code: -32603, message } })

  it('a send writes one `mcp` frame on the stream the holder opened, and nothing on any other', async () => {
    const c = await connected(ALL_CAPS, false, true)
    c.send(OPEN)
    await until(() => c.tools.length === 1, 'the open')
    // Readable at the edges: 31 levels, and a pair of surrogates (one character).
    const edge = [ANSWER, nested(31), text(`a ${String.fromCodePoint(0x1f600)} b`)]
    for (const m of edge) expect(c.conn.sendMcp(1, m)).toBe('sent')
    // A stream the holder never opened here.
    expect(c.conn.sendMcp(2, ANSWER)).toBe('not-open')
    await until(() => mcpFrames(c.fromApp).length === 3, 'the three frames')
    // The holder ends the stream: nothing more goes on it.
    c.send(CLOSE)
    await until(() => c.tools.length === 2, 'the close')
    expect(c.conn.sendMcp(1, ANSWER)).toBe('not-open')
    await tick(30)
    expect(mcpFrames(c.fromApp)).toEqual(edge.map((message) => ({ t: 'mcp', stream: 1, message })))
    expect(c.conn.isClosed).toBe(false)
  })

  it('a message the holder would not read is not sent: its call is answered with an error, the stream ends on the app\'s side, and the connection stays up', async () => {
    const unreadable: Array<[string, Record<string, unknown>]> = [
      ['a lone high surrogate', text(`a ${String.fromCharCode(0xd800)} b`)],
      ['a lone low surrogate', text(`a ${String.fromCharCode(0xdc00)} b`)],
      ['32 levels', nested(32)],
      ['over the size limit', text('x'.repeat(MCP_MESSAGE_TO_HELPER_MAX))],
    ]
    for (const [what, m] of unreadable) {
      const c = await connected(ALL_CAPS, false, true)
      c.send(OPEN)
      await until(() => c.tools.length === 1, `the open (${what})`)
      expect(c.conn.sendMcp(1, m), what).toBe('refused')
      await until(() => mcpFrames(c.fromApp).length === 1, `the error answer (${what})`)
      expect(mcpFrames(c.fromApp), what).toEqual([{ t: 'mcp', stream: 1, message: errorFor(7, TOOL_STREAM_SENTENCES.notPassed) }])
      // Ended on the app's side: the next call on it is answered here, not reported.
      c.send({ t: 'mcp', stream: 1, message: { jsonrpc: '2.0', id: 8, method: 'tools/list' } })
      await until(() => mcpFrames(c.fromApp).length === 2, `the answer to the next call (${what})`)
      expect(mcpFrames(c.fromApp)[1], what).toEqual({ t: 'mcp', stream: 1, message: errorFor(8, TOOL_STREAM_SENTENCES.ended) })
      expect(c.conn.sendMcp(1, ANSWER), what).toBe('not-open')
      expect(c.tools, what).toEqual([['open', 1]])
      expect(c.conn.isClosed, what).toBe(false)
    }
  })

  it('a send on a connection that did not ack `mcp` does nothing', async () => {
    // Not asked for it, and asked for it of a holder that does not offer it.
    for (const [caps, asked] of [[ALL_CAPS, false], [['core', 'local', 'hooks'], true]] as const) {
      const c = await connected([...caps], false, asked)
      c.send(OPEN)
      await tick(20)
      expect(c.conn.sendMcp(1, ANSWER)).toBe('not-open')
      c.conn.closeMcp(1)
      await tick(30)
      expect(c.fromApp.map((m) => m.t)).toEqual(['hello.ack'])
    }
  })

  it('the app\'s end of a stream sends no `mcp.close`: each call on it is answered with an error, nothing on it is reported, and neither is the holder\'s end of it', async () => {
    const c = await connected(ALL_CAPS, false, true)
    c.send(OPEN)
    c.send({ ...OPEN, stream: 2 })
    await until(() => c.tools.length === 2, 'the two opens')
    c.conn.closeMcp(1)
    c.send({ t: 'mcp', stream: 1, message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
    c.send({ t: 'mcp', stream: 1, message: { jsonrpc: '2.0', method: 'notifications/initialized' } })
    c.send({ t: 'mcp', stream: 1, message: [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 'three', method: 'ping' }] })
    // The other stream goes on.
    c.send({ ...CALL, stream: 2 })
    await until(() => mcpFrames(c.fromApp).length === 2 && c.tools.length === 3, 'the answers and the other stream\'s call')
    c.send(CLOSE)
    await tick(30)
    expect(mcpFrames(c.fromApp)).toEqual([
      { t: 'mcp', stream: 1, message: errorFor(1, TOOL_STREAM_SENTENCES.ended) },
      { t: 'mcp', stream: 1, message: [errorFor(2, TOOL_STREAM_SENTENCES.ended), { jsonrpc: '2.0', id: 'three', error: { code: -32603, message: TOOL_STREAM_SENTENCES.ended } }] },
    ])
    expect(c.tools).toEqual([['open', 1], ['open', 2], ['mcp', 2, CALL.message]])
    expect(c.conn.isClosed).toBe(false)
  })
})

describe('control messages travel on channel 0 only', () => {
  it('an event on channel 1 is dropped; the same event on channel 0 is not', async () => {
    const c = await connected(['core', 'local', 'hooks'], true)
    c.send(STOP, 1)
    c.send({ ...STOP, seq: 2 }, 0)
    await until(() => c.events.length >= 1, 'the channel 0 event')
    await tick(20)
    expect(c.events).toEqual([{ seq: 2, kind: 'Stop', payload: STOP.payload }])
  })

  it("an event carrying a waiting request's `re` answers no request, and is refused", async () => {
    const c = await connected(['core', 'local', 'hooks'], true)
    const reply = c.conn.request({ t: 'term.resize', cols: 100, rows: 40 })
    await until(() => c.fromApp.some((m) => m.t === 'term.resize'), 'the request')
    const id = c.fromApp.find((m) => m.t === 'term.resize')!.id as number
    c.send({ ...STOP, re: id })
    await tick(30)
    expect(c.events).toEqual([])
    // The request still waits for its own reply.
    c.send({ t: 'term.resized', re: id })
    expect(await reply).toEqual({ t: 'term.resized', re: id })
  })

  it("a tool message on channel 1 is dropped, and one carrying a waiting request's `re` answers no request", async () => {
    const c = await connected(ALL_CAPS, false, true)
    c.send(OPEN, 1)
    const reply = c.conn.request({ t: 'term.resize', cols: 100, rows: 40 })
    await until(() => c.fromApp.some((m) => m.t === 'term.resize'), 'the request')
    const id = c.fromApp.find((m) => m.t === 'term.resize')!.id as number
    c.send({ ...CLOSE, re: id })
    await tick(30)
    expect(c.tools).toEqual([])
    c.send({ t: 'term.resized', re: id })
    expect(await reply).toEqual({ t: 'term.resized', re: id })
  })

  it('a reply on channel 1 answers no request; the one on channel 0 does', async () => {
    const c = await connected(['core', 'local'], false)
    const reply = c.conn.request({ t: 'term.resize', cols: 100, rows: 40 })
    await until(() => c.fromApp.some((m) => m.t === 'term.resize'), 'the request')
    const id = c.fromApp.find((m) => m.t === 'term.resize')!.id as number
    c.send({ t: 'term.resized', re: id, from: 'channel 1' }, 1)
    await tick(30)
    c.send({ t: 'term.resized', re: id })
    expect(await reply).toEqual({ t: 'term.resized', re: id })
  })
})
