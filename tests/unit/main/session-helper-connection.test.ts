// The connection's own reading of hook events (2.1.3-beta.8, plan section A4;
// docs/remote/helper-protocol.md section 15), on an in-memory stream with a
// stand-in holder, so no manager guard can hide a gap in it:
//  - `hooks` is acked only when the connection wants hook events AND the hello
//    offers them, and an `event` is reported only on a connection that acked;
//  - every JSON control message travels on channel 0: one off channel 0 is
//    dropped, whatever it carries, and never answers a waiting request;
//  - an `event` is read as an event before any reply lookup, so one carrying
//    a `re` is refused (its fields are exact) and answers no request.
import { describe, it, expect, afterEach } from 'vitest'
import { FrameReader, encodeJsonFrame, type HolderRecord } from '../../../src/main/session-helper/protocol'
import { HolderConnection } from '../../../src/main/session-helper/connection'
import { duplexPair } from './session-helper-fake-holder'

type Json = Record<string, unknown>

const SID = 'ag0123456789abcdef0123456789abcd'
const NONCE = '0123456789abcdef0123456789abcdef'
const RECORD: HolderRecord = {
  v: 1, session: SID, label: 'tab', pid: 4242, endpoint: `\\\\.\\pipe\\aicc-helper-${SID}-${'b'.repeat(32)}`, nonce: NONCE,
  helper: '0.1.0', started: 1, away: 120, attached: false, child: 'running', code: null,
}
const STOP = { t: 'event', seq: 1, kind: 'Stop', payload: { hook_event_name: 'Stop', session_id: 'c1' } }

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
 *  (`hooks`: the connection wants hook events). */
async function connected(caps: string[], hooks: boolean) {
  const [app, holder] = duplexPair()
  const fromApp: Json[] = []
  const reader = new FrameReader('app_to_helper')
  holder.on('data', (chunk: Buffer) => { for (const f of reader.push(chunk)) if (f.kind === 0) fromApp.push(f.json as Json) })
  const hello = { proto: [1], helper: { version: '0.1.0' }, os: 'windows', arch: 'x86_64', caps, session: { sid: SID, state: 'live' } }
  holder.write(`AICC-HELLO ${NONCE} ${JSON.stringify(hello)}\n`)
  const conn = await HolderConnection.open({ record: RECORD, os: 'windows', openStream: async () => app, hooks, pingEveryMs: 600_000 })
  open.push(conn)
  const events: unknown[] = []
  conn.on('event', (e) => { events.push(e) })
  await until(() => fromApp.length >= 1, 'the hello.ack')
  return { conn, fromApp, events, send: (m: unknown, channel = 0) => { holder.write(encodeJsonFrame(m, channel)) } }
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
