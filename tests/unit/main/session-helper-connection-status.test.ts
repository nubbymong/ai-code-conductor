// The connection's own reading of the status line (plan 2.1.3-beta.18,
// section 3.2, on section 3.1's frame: `status` {seq, payload} to a
// connection that acked `status` beside `local`), on an in-memory stream with
// a stand-in holder, as session-helper-connection.test.ts reads hook events:
//  - `status` is acked only when the connection asks for it AND the hello
//    offers it, after the caps it acked before;
//  - a `status` is reported only on a connection that acked it, read strictly
//    (exactly t, seq and payload; seq a whole number from 1; payload an
//    object within its bound; the frame within its own), before any reply
//    lookup, so one carrying a `re` answers no request;
//  - one off channel 0 is dropped.
import { describe, it, expect, afterEach } from 'vitest'
import { FrameReader, STATUS_JSON_MAX, STATUS_PAYLOAD_MAX, encodeJsonFrame, readStatusFrame, type HolderRecord, type StatusFrame } from '../../../src/main/session-helper/protocol'
import { HolderConnection } from '../../../src/main/session-helper/connection'
import { duplexPair } from './session-helper-fake-holder'

type Json = Record<string, unknown>

const SID = 'rm0123456789abcdef0123456789abc'
const NONCE = '0123456789abcdef0123456789abcdef'
const RECORD: HolderRecord = {
  v: 1, session: SID, label: 'tab', pid: 4242, endpoint: `/tmp/aicc-1000/${SID}-0123456789abcdef.sock`, nonce: NONCE,
  helper: '0.1.0', started: 1, away: 120, attached: false, child: 'running', code: null,
}
const STATUS = { t: 'status', seq: 1, payload: { model: { id: 'claude-opus-4-1', display_name: 'Opus' }, cost: { total_cost_usd: 0.5 } } }

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

async function connected(caps: string[], status: boolean, hooks = false, mcp = false) {
  const [app, holder] = duplexPair()
  const fromApp: Json[] = []
  const reader = new FrameReader('app_to_helper')
  holder.on('data', (chunk: Buffer) => { for (const f of reader.push(chunk)) if (f.kind === 0) fromApp.push(f.json as Json) })
  const hello = { proto: [1], helper: { version: '0.1.0' }, os: 'linux', arch: 'x86_64', caps, session: { sid: SID, state: 'live' } }
  holder.write(`AICC-HELLO ${NONCE} ${JSON.stringify(hello)}\n`)
  const conn = await HolderConnection.open({ record: RECORD, os: 'unix', checkEndpointFolder: () => null, openStream: async () => app, status, hooks, mcp, pingEveryMs: 600_000 })
  open.push(conn)
  const got: StatusFrame[] = []
  conn.on('status', (s) => { got.push(s) })
  await until(() => fromApp.length >= 1, 'the hello.ack')
  return { conn, fromApp, got, send: (m: unknown, channel = 0) => { holder.write(encodeJsonFrame(m, channel)) } }
}

const OFFERS = ['core', 'local', 'hooks', 'mcp', 'away', 'screen', 'title', 'status']

describe('the connection acks status only when it asks for it and the holder offers it', () => {
  it('asked and offered: acked after the caps before it, and a status is reported once as it came', async () => {
    const c = await connected(OFFERS, true, true, true)
    expect(c.fromApp[0]).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local', 'hooks', 'mcp', 'status'] })
    expect(c.conn.status).toBe(true)
    c.send(STATUS)
    await until(() => c.got.length === 1, 'the status')
    expect(c.got).toEqual([{ seq: 1, payload: STATUS.payload }])
  })

  it('offered, not asked: not acked, and a status the holder sends anyway is not reported', async () => {
    const c = await connected(OFFERS, false, true)
    expect(c.fromApp[0]).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local', 'hooks'] })
    expect(c.conn.status).toBe(false)
    c.send(STATUS)
    await tick(30)
    expect(c.got).toEqual([])
    expect(c.conn.isClosed).toBe(false)
  })

  it('asked, not offered (a holder from before 2.1.3-beta.18): not acked, and nothing reported', async () => {
    const c = await connected(['core', 'local', 'hooks', 'mcp'], true)
    expect(c.fromApp[0]).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local'] })
    c.send(STATUS)
    await tick(30)
    expect(c.got).toEqual([])
  })
})

describe('a status is read strictly', () => {
  it('one that breaks its shape, or arrives off channel 0, is dropped and the connection stays up', async () => {
    const c = await connected(OFFERS, true)
    c.send({ ...STATUS, extra: 1 })
    c.send({ ...STATUS, seq: 0 })
    c.send({ ...STATUS, seq: 1.5 })
    c.send({ ...STATUS, payload: [1, 2] })
    c.send({ ...STATUS, payload: 'text' })
    c.send({ ...STATUS, payload: { big: 'x'.repeat(STATUS_PAYLOAD_MAX) } })
    c.send(STATUS, 1)
    c.send({ ...STATUS, seq: 2 })
    await until(() => c.got.length === 1, 'the one good status')
    await tick(30)
    expect(c.got.map((s) => s.seq)).toEqual([2])
    expect(c.conn.isClosed).toBe(false)
  })

  it('one carrying a `re` answers no request (its fields are exact)', async () => {
    const c = await connected(OFFERS, true)
    const asked = c.conn.request({ t: 'term.resize', cols: 80, rows: 24 })
    const id = (await (async () => { await until(() => c.fromApp.length >= 2, 'the request'); return c.fromApp[1].id })()) as number
    c.send({ ...STATUS, re: id })
    c.send({ t: 'term.resized', re: id })
    await expect(asked).resolves.toMatchObject({ t: 'term.resized' })
    expect(c.got).toEqual([])
  })

  it('readStatusFrame: the bounds, to the byte', () => {
    const at = (payloadBytes: number) => ({ t: 'status', seq: 3, payload: { p: 'x'.repeat(payloadBytes - '{"p":""}'.length) } })
    expect(readStatusFrame(at(STATUS_PAYLOAD_MAX), 1000)).not.toBeNull()
    expect(readStatusFrame(at(STATUS_PAYLOAD_MAX + 1), 1000)).toBeNull()
    expect(readStatusFrame(STATUS, STATUS_JSON_MAX)).not.toBeNull()
    expect(readStatusFrame(STATUS, STATUS_JSON_MAX + 1)).toBeNull()
    expect(readStatusFrame({ t: 'event', seq: 1, payload: {} }, 10)).toBeNull()
  })
})
