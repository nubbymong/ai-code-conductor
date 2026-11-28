// The connection's side of the session's pictures (plan 2.1.3-beta.21, phase
// 4; ADR-032; docs/remote/helper-protocol.md section 15, capability `paste`),
// on an in-memory stream with a stand-in holder, as
// session-helper-connection-status.test.ts reads the status line:
//  - `paste` is acked only when the connection asks for it AND the hello
//    offers it, after the caps it acked before;
//  - putFile sends `file.put` {id, name, size, sha256}, then the picture's
//    bytes as raw frames of at most 64 KiB on the paste channel (2), never on
//    the terminal's channel, and resolves with the hash once `file.stored`
//    {re, sha256} names it; the reply carries no path;
//  - refused here, with nothing sent: a connection that did not ack `paste`,
//    a name off the pattern, a size of 0 or over 20 MiB, a second picture
//    while one is being sent;
//  - the holder's refusal rejects with its code; a stored hash that is not
//    the picture's rejects;
//  - typed input is not held up while a picture is being sent;
//  - a picture is paced by the pings as typed input is (section 15): a ping
//    after every 16 raw frames or 1 MiB, typed input and the picture's chunks
//    counted together, and nothing more until its pong;
//  - the limits and the name rule are the shared vectors'
//    (helper/fixtures/local.json `paste`), which the helper's tests read too.
import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  FrameReader, PASTE_CAP, PASTE_CHANNEL, PASTE_CHUNK_WAIT_MS, PASTE_NAME_RE, PASTE_PICTURE_MAX, PASTE_REPLY_MS, PASTE_SESSION_MAX, RAW_MAX,
  encodeJsonFrame, helloAck, readFileStored, type HolderRecord,
} from '../../../src/main/session-helper/protocol'
import { HolderConnection, INPUT_FRAMES_PER_PING } from '../../../src/main/session-helper/connection'
import { duplexPair } from './session-helper-fake-holder'

type Json = Record<string, unknown>

const SID = 'rm0123456789abcdef0123456789abc'
const NONCE = '0123456789abcdef0123456789abcdef'
const RECORD: HolderRecord = {
  v: 1, session: SID, label: 'tab', pid: 4242, endpoint: `/tmp/aicc-1000/${SID}-0123456789abcdef.sock`, nonce: NONCE,
  helper: '0.1.0', started: 1, away: 120, attached: false, child: 'running', code: null,
}
const OFFERS = ['core', 'local', 'hooks', 'mcp', 'away', 'screen', 'title', 'status', 'paste']

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(5)
  }
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

const open: HolderConnection[] = []
afterEach(() => { for (const c of open.splice(0)) c.close() })

/** A frame from the app, as the holder reads it. */
type FromApp = { kind: 0; channel: number; json: Json } | { kind: 1; channel: number; bytes: Buffer }

/** The stand-in answers each ping with its pong, in order, as a holder does;
 *  with `refuse.next` set it refuses the next file.put at once, before the
 *  pong to the ping after it, as a holder refuses before it takes a byte.
 *  With `pongs.hold` set to n it keeps back the pong to its n-th ping
 *  (counted from 1) until `release()`. */
async function connected(caps: string[], paste: boolean, status = false) {
  const [app, holder] = duplexPair()
  const frames: FromApp[] = []
  const refuse: { next: { code: string; text: string } | null } = { next: null }
  const pongs: { seen: number; hold: number; held: unknown } = { seen: 0, hold: 0, held: undefined }
  const reader = new FrameReader('app_to_helper')
  holder.on('data', (chunk: Buffer) => {
    for (const f of reader.push(chunk)) {
      frames.push(f.kind === 0 ? { kind: 0, channel: f.channel, json: f.json as Json } : { kind: 1, channel: f.channel, bytes: f.bytes })
      if (f.kind !== 0) continue
      const m = f.json as Json
      if (m.t === 'file.put' && refuse.next) {
        holder.write(encodeJsonFrame({ t: 'error', re: m.id, ...refuse.next }))
        refuse.next = null
      }
      if (m.t === 'ping') {
        pongs.seen += 1
        if (pongs.seen === pongs.hold) pongs.held = m.id
        else holder.write(encodeJsonFrame({ t: 'pong', re: m.id }))
      }
    }
  })
  const hello = { proto: [1], helper: { version: '0.1.0' }, os: 'linux', arch: 'x86_64', caps, session: { sid: SID, state: 'live' } }
  holder.write(`AICC-HELLO ${NONCE} ${JSON.stringify(hello)}\n`)
  const conn = await HolderConnection.open({ record: RECORD, os: 'unix', checkEndpointFolder: () => null, openStream: async () => app, status, paste, pingEveryMs: 600_000 })
  open.push(conn)
  await until(() => frames.length >= 1, 'the hello.ack')
  const json = () => frames.filter((f): f is Extract<FromApp, { kind: 0 }> => f.kind === 0).map((f) => f.json)
  const raw = (channel: number) => frames.filter((f): f is Extract<FromApp, { kind: 1 }> => f.kind === 1 && f.channel === channel).map((f) => f.bytes)
  const puts = () => json().filter((m) => m.t === 'file.put')
  /** What the app sent after its hello.ack, in order: a control message by its type, a raw frame as `raw<channel>`. */
  const kinds = () => frames.slice(1).map((f) => (f.kind === 0 ? String(f.json.t) : `raw${f.channel}`))
  const release = () => { holder.write(encodeJsonFrame({ t: 'pong', re: pongs.held })) }
  return { conn, frames, json, raw, puts, refuse, pongs, kinds, release, send: (m: unknown, channel = 0) => { holder.write(encodeJsonFrame(m, channel)) } }
}

/** A picture's bytes: `n` of them, not all alike. */
const picture = (n: number) => {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff
  return b
}
const MiB = 1024 * 1024
const times = (n: number, kind: string) => Array.from({ length: n }, () => kind)

describe('the connection acks paste only when it asks for it and the holder offers it', () => {
  it('asked and offered: acked last, after the caps before it', async () => {
    const c = await connected(OFFERS, true, true)
    expect(c.json()[0]).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local', 'status', 'paste'] })
    expect(c.conn.paste).toBe(true)
    expect(helloAck(true, true, true, true, true, true).caps).toEqual(['core', 'local', 'hooks', 'mcp', 'screen', 'title', 'status', PASTE_CAP])
  })

  it('offered, not asked (a session on this computer, whose pictures go through its own clipboard): not acked, and putFile sends nothing', async () => {
    const c = await connected(OFFERS, false)
    expect(c.json()[0]).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local'] })
    expect(c.conn.paste).toBe(false)
    await expect(c.conn.putFile('paste-1.png', picture(10))).rejects.toMatchObject({ code: 'unknown-type' })
    await tick(20)
    expect(c.frames).toHaveLength(1)
  })

  it('asked, not offered (a holder from before 2.1.3-beta.21): not acked, and putFile sends nothing', async () => {
    const c = await connected(OFFERS.slice(0, 8), true)
    expect(c.json()[0]).toEqual({ t: 'hello.ack', proto: 1, caps: ['core', 'local'] })
    await expect(c.conn.putFile('paste-1.png', picture(10))).rejects.toMatchObject({ code: 'unknown-type' })
    await tick(20)
    expect(c.frames).toHaveLength(1)
  })
})

describe('putFile: one picture into the session\'s folder on the holder\'s machine', () => {
  it('sends file.put, then the bytes in chunks of at most 64 KiB on the paste channel only, and resolves with the hash file.stored names', async () => {
    const c = await connected(OFFERS, true)
    const bytes = picture(RAW_MAX * 2 + 123)
    const put = c.conn.putFile('paste-7.png', bytes)
    await until(() => c.raw(PASTE_CHANNEL).reduce((n, b) => n + b.length, 0) === bytes.length, 'every byte')
    const header = c.puts()[0]
    expect(header).toEqual({ t: 'file.put', id: header.id, name: 'paste-7.png', size: bytes.length, sha256: sha(bytes) })
    expect(typeof header.id === 'number' && header.id % 2 === 0).toBe(true)
    const chunks = c.raw(PASTE_CHANNEL)
    expect(chunks.map((b) => b.length)).toEqual([RAW_MAX, RAW_MAX, 123])
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true)
    // Nothing of the picture on the terminal's channel. Its first byte goes
    // only after a ping sent after the header: its pong says the header was
    // taken (a refusal comes first).
    expect(c.raw(1)).toEqual([])
    const at = (pred: (f: FromApp) => boolean) => c.frames.findIndex(pred)
    const putAt = at((f) => f.kind === 0 && f.json.t === 'file.put')
    const pingAt = at((f) => f.kind === 0 && f.json.t === 'ping')
    expect(putAt).toBe(1)
    expect(pingAt).toBeGreaterThan(putAt)
    expect(at((f) => f.kind === 1)).toBeGreaterThan(pingAt)
    c.send({ t: 'file.stored', re: header.id, sha256: sha(bytes) })
    await expect(put).resolves.toEqual({ sha256: sha(bytes) })
  })

  it('a jpg the same way; ids stay even and grow', async () => {
    const c = await connected(OFFERS, true)
    const a = picture(5)
    const p1 = c.conn.putFile('paste-1.jpg', a)
    await until(() => c.raw(PASTE_CHANNEL).length === 1, 'the bytes')
    const h1 = c.puts()[0]
    c.send({ t: 'file.stored', re: h1.id, sha256: sha(a) })
    await p1
    const p2 = c.conn.putFile('paste-2.jpg', a)
    await until(() => c.raw(PASTE_CHANNEL).length === 2, 'the second picture\'s bytes')
    const h2 = c.puts()[1]
    expect(h2.name).toBe('paste-2.jpg')
    expect(Number(h2.id)).toBeGreaterThan(Number(h1.id))
    c.send({ t: 'file.stored', re: h2.id, sha256: sha(a) })
    await expect(p2).resolves.toEqual({ sha256: sha(a) })
  })

  it('refuses here, with nothing sent: a name off the pattern, a size of 0 or over 20 MiB', async () => {
    const c = await connected(OFFERS, true)
    for (const name of ['paste-0.png', 'paste-01.png', 'paste-1234567890.png', 'paste-1.gif', 'paste-1.PNG', 'paste-.png', '../paste-1.png', 'paste-1.png/', 'x/paste-1.png', '.part-1', 'paste-1.jpeg']) {
      await expect(c.conn.putFile(name, picture(3)), name).rejects.toMatchObject({ code: 'bad-field' })
    }
    await expect(c.conn.putFile('paste-1.png', Buffer.alloc(0))).rejects.toMatchObject({ code: 'bad-field' })
    await expect(c.conn.putFile('paste-1.png', Buffer.alloc(PASTE_PICTURE_MAX + 1))).rejects.toMatchObject({ code: 'too-large' })
    await tick(20)
    expect(c.frames).toHaveLength(1)
  })

  it('one picture at a time: a second while one is being sent is busy, with nothing sent; after the reply the next goes', async () => {
    const c = await connected(OFFERS, true)
    const a = picture(10)
    const first = c.conn.putFile('paste-1.png', a)
    await until(() => c.raw(PASTE_CHANNEL).length === 1, 'the first picture\'s bytes')
    await expect(c.conn.putFile('paste-2.png', a)).rejects.toMatchObject({ code: 'busy' })
    await tick(20)
    expect(c.json().filter((m) => m.t === 'file.put')).toHaveLength(1)
    c.send({ t: 'file.stored', re: c.puts()[0].id, sha256: sha(a) })
    await first
    const second = c.conn.putFile('paste-2.png', a)
    await until(() => c.json().filter((m) => m.t === 'file.put').length === 2, 'the second file.put')
    c.send({ t: 'file.stored', re: c.puts()[1].id, sha256: sha(a) })
    await expect(second).resolves.toEqual({ sha256: sha(a) })
  })

  it('a refusal of the request (which a holder sends before it takes a byte) rejects with its code, and no byte is sent', async () => {
    const c = await connected(OFFERS, true)
    for (const code of ['not-connected', 'busy', 'not-found', 'too-large', 'bad-field', 'io']) {
      c.refuse.next = { code, text: `refused: ${code}` }
      await expect(c.conn.putFile('paste-1.png', picture(10)), code).rejects.toMatchObject({ code })
    }
    await tick(20)
    expect(c.puts()).toHaveLength(6)
    expect(c.raw(PASTE_CHANNEL)).toEqual([])
    expect(c.conn.isClosed).toBe(false)
  })

  it('a refusal after the bytes (a bad hash on the holder\'s side) rejects with its code, and the next picture may go', async () => {
    const c = await connected(OFFERS, true)
    const a = picture(10)
    const put = c.conn.putFile('paste-1.png', a)
    await until(() => c.raw(PASTE_CHANNEL).length === 1, 'the bytes')
    c.send({ t: 'error', re: c.puts()[0].id, code: 'bad-field', text: 'the SHA-256 of the bytes is not the one file.put named' })
    await expect(put).rejects.toMatchObject({ code: 'bad-field' })
    const next = c.conn.putFile('paste-2.png', a)
    await until(() => c.raw(PASTE_CHANNEL).length === 2, 'the next bytes')
    c.send({ t: 'file.stored', re: c.puts()[1].id, sha256: sha(a) })
    await expect(next).resolves.toEqual({ sha256: sha(a) })
  })

  it('a reply whose hash is not the picture\'s, or that carries more than re and sha256, rejects', async () => {
    const c = await connected(OFFERS, true)
    const a = picture(10)
    const put = c.conn.putFile('paste-1.png', a)
    await until(() => c.raw(PASTE_CHANNEL).length === 1, 'the bytes')
    c.send({ t: 'file.stored', re: c.puts()[0].id, sha256: 'b'.repeat(64) })
    await expect(put).rejects.toMatchObject({ code: 'bad-frame' })
    const next = c.conn.putFile('paste-2.png', a)
    await until(() => c.raw(PASTE_CHANNEL).length === 2, 'the next bytes')
    c.send({ t: 'file.stored', re: c.puts()[1].id, sha256: sha(a), path: '/home/u/.aicc/x/sessions/y/paste/paste-2.png' })
    await expect(next).rejects.toMatchObject({ code: 'bad-frame' })
  })

  it('typed input is not held up while a picture is being sent', async () => {
    const c = await connected(OFFERS, true)
    const bytes = picture(RAW_MAX * 3)
    const put = c.conn.putFile('paste-1.png', bytes)
    c.conn.sendInput(Buffer.from('typed meanwhile'))
    await until(() => c.raw(1).length === 1 && c.raw(PASTE_CHANNEL).length === 3, 'the typed input and the picture')
    expect(c.raw(1)[0].toString()).toBe('typed meanwhile')
    c.send({ t: 'file.stored', re: c.puts()[0].id, sha256: sha(bytes) })
    await put
  })

  it('a picture over 1 MiB is paced by the pings, as typed input is: 16 chunks, a ping, nothing more until its pong; then the rest, a ping after every 16, and file.stored resolves', async () => {
    const c = await connected(OFFERS, true)
    // The first ping is the one after file.put; the second, the one after
    // the first 16 chunks: its pong is kept back. A ping written behind
    // everything the link has not delivered yet would come back late on a
    // slow link and close the connection, so no more than 1 MiB is ever
    // ahead of one.
    c.pongs.hold = 2
    const bytes = picture(3 * MiB)
    const put = c.conn.putFile('paste-1.png', bytes)
    await until(() => c.raw(PASTE_CHANNEL).length >= INPUT_FRAMES_PER_PING, 'the first 16 chunks')
    await tick(50)
    expect(c.raw(PASTE_CHANNEL)).toHaveLength(INPUT_FRAMES_PER_PING)
    expect(c.kinds()).toEqual(['file.put', 'ping', ...times(16, 'raw2'), 'ping'])
    c.release()
    await until(() => c.pongs.seen === 4, 'a ping after the 32nd chunk and after the 48th')
    expect(c.kinds()).toEqual(['file.put', 'ping', ...times(16, 'raw2'), 'ping', ...times(16, 'raw2'), 'ping', ...times(16, 'raw2'), 'ping'])
    expect(Buffer.concat(c.raw(PASTE_CHANNEL)).equals(bytes)).toBe(true)
    c.send({ t: 'file.stored', re: c.puts()[0].id, sha256: sha(bytes) })
    await expect(put).resolves.toEqual({ sha256: sha(bytes) })
  })

  it('typed input and a picture\'s chunks count together toward the 16 raw frames between two pings', async () => {
    const c = await connected(OFFERS, true)
    c.pongs.hold = 2
    const bytes = picture(2 * MiB)
    const typed = Buffer.alloc(RAW_MAX * 10, 0x61)
    const put = c.conn.putFile('paste-1.png', bytes)
    // Typed meanwhile, 10 frames of it: it waits for the pong to the ping
    // after file.put, as the picture does, and goes first.
    c.conn.sendInput(typed)
    await until(() => c.raw(1).length + c.raw(PASTE_CHANNEL).length >= INPUT_FRAMES_PER_PING, '16 raw frames')
    await tick(50)
    const k = c.kinds()
    expect(k.slice(0, 2)).toEqual(['file.put', 'ping'])
    expect(k[k.length - 1]).toBe('ping')
    const between = k.slice(2, -1)
    expect(between).toEqual([...times(10, 'raw1'), ...times(6, 'raw2')])
    c.release()
    await until(() => c.raw(PASTE_CHANNEL).length === 32, 'the rest of the picture')
    c.send({ t: 'file.stored', re: c.puts()[0].id, sha256: sha(bytes) })
    await expect(put).resolves.toEqual({ sha256: sha(bytes) })
    expect(Buffer.concat(c.raw(1)).equals(typed)).toBe(true)
    expect(Buffer.concat(c.raw(PASTE_CHANNEL)).equals(bytes)).toBe(true)
  })

  it('a connection that closes while the picture waits for its reply rejects it', async () => {
    const c = await connected(OFFERS, true)
    const put = c.conn.putFile('paste-1.png', picture(10))
    await until(() => c.raw(PASTE_CHANNEL).length === 1, 'the bytes')
    c.conn.close()
    await expect(put).rejects.toMatchObject({ code: 'io' })
  })
})

describe('readFileStored reads the reply strictly', () => {
  it('exactly t, re and sha256 (64 lower-case hex)', () => {
    const h = 'a'.repeat(64)
    expect(readFileStored({ t: 'file.stored', re: 2, sha256: h })).toEqual({ re: 2, sha256: h })
    expect(readFileStored({ t: 'file.stored', re: 2, sha256: h.toUpperCase() })).toBeNull()
    expect(readFileStored({ t: 'file.stored', re: 2, sha256: h, name: 'paste-1.png' })).toBeNull()
    expect(readFileStored({ t: 'file.stored', re: 2 })).toBeNull()
    expect(readFileStored({ t: 'file.stored', re: 1.5, sha256: h })).toBeNull()
    expect(readFileStored({ t: 'term.resized', re: 2, sha256: h })).toBeNull()
  })
})

describe('the shared vectors (helper/fixtures/local.json, paste)', () => {
  const local = JSON.parse(readFileSync(resolve(__dirname, '../../../helper/fixtures/local.json'), 'utf8')) as { paste: Record<string, unknown> }
  const part = local.paste as { offered: string[]; ack: string[]; limits: Record<string, number>; names: { valid: string[]; invalid: string[] } }

  it('the app\'s limits and channel are the holder\'s', () => {
    expect(part.offered).toEqual(OFFERS)
    // The least ack that allows file.put: a helper tab's acks the rest beside it.
    expect(part.ack).toEqual(helloAck(false, false, false, false, false, true).caps)
    expect(part.limits).toEqual({ channel: PASTE_CHANNEL, chunk_bytes: RAW_MAX, picture_bytes: PASTE_PICTURE_MAX, session_bytes: PASTE_SESSION_MAX, chunk_wait_ms: PASTE_CHUNK_WAIT_MS, reply_ms: PASTE_REPLY_MS, number_digits: 9 })
  })

  it('each name the holder takes, the app takes, and each it refuses, the app refuses', () => {
    expect(part.names.valid.length).toBeGreaterThanOrEqual(4)
    expect(part.names.invalid.length).toBeGreaterThanOrEqual(10)
    for (const n of part.names.valid) expect(PASTE_NAME_RE.test(n), n).toBe(true)
    for (const n of part.names.invalid) expect(PASTE_NAME_RE.test(n), n).toBe(false)
  })
})
