// The screen's title in a screen read (2.1.3-beta.14, plan section B1,
// aicc_planning#384; docs/remote/helper-protocol.md section 15, "Screen
// reads"). A holder offers `title` after `screen`; a connection acks it only
// beside `screen`, only when it is asked for it and only when the holder
// offers it, and its `screen.rows` then carry the window title the session's
// output last set. The cases:
//  1. the reader (readScreenRows): on a connection that acked `title`, a title
//     of text reads (one at the bound too, counted in characters), and an
//     answer with none reads null; a title that is not text, holds a control
//     character or is over the bound is refused. On any other connection a
//     title is refused, and the answer reads as before with a null title;
//  2. the ack (helloAck): `title` only beside `screen`, and last;
//  3. the connection: acks `title` only when asked for it beside `screen` and
//     the holder offers both; readScreen then gives the title, and null on a
//     connection that did not ack it; a title sent to a connection that did
//     not ack it does not read (the read rejects, the connection stays up).
// Not checked here: the holder's side (helper/src/screen.rs,
// helper/src/serve.rs, helper/tests/screen.rs and helper/tests/fixtures.rs,
// run by the Helper job), and a caller that asks for the title (a held agent
// session's connections, 2.1.3-beta.14 B2:
// tests/unit/main/session-helper-agent-screen.test.ts).
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { FrameReader, SCREEN_TITLE_MAX, TITLE_CAP, encodeJsonFrame, helloAck, readScreenRows, type HolderRecord } from '../../../src/main/session-helper/protocol'
import { HolderConnection } from '../../../src/main/session-helper/connection'
import { duplexPair } from './session-helper-fake-holder'

type Json = Record<string, unknown>

const S = JSON.parse(readFileSync(resolve(__dirname, '../../../helper/fixtures/local.json'), 'utf8')).screen
/** What a holder of now offers, and one from before the title. */
const NOW_CAPS: string[] = S.offered
const BEFORE_CAPS = NOW_CAPS.filter((c) => c !== TITLE_CAP)
/** The vector of a title the output set, as the holder sends it to a
 *  connection that acked `title`, and the same answer with no title. */
const TITLED: Json = JSON.parse((S.messages as Array<{ json: string; acked?: string[] }>).find((v) => v.acked?.includes(TITLE_CAP) && JSON.parse(v.json).title !== '')!.json)
const { title: TITLE, ...PLAIN } = TITLED
const size = (m: unknown): number => Buffer.byteLength(JSON.stringify(m), 'utf8')
const withTitle = (title: unknown): Json => ({ ...TITLED, title })

describe('1. the reader takes a title only on a connection that acked it', () => {
  it('holds a title vector to read (a vacuous pass is no pass)', () => {
    expect(typeof TITLE).toBe('string')
    expect((TITLE as string).length).toBeGreaterThan(0)
  })

  it('on a connection that acked title: a title of text reads, one at the bound too, and none reads null', () => {
    expect(readScreenRows(TITLED, size(TITLED), true)?.title).toBe(TITLE)
    expect(readScreenRows(withTitle(''), size(withTitle('')), true)?.title).toBe('')
    expect(readScreenRows(PLAIN, size(PLAIN), true)?.title).toBeNull()
    const at = withTitle('x'.repeat(SCREEN_TITLE_MAX))
    expect(readScreenRows(at, size(at), true)?.title).toHaveLength(SCREEN_TITLE_MAX)
    // Counted in characters, as the holder counts them: a character outside
    // the first plane is two UTF-16 units and one character.
    const astral = withTitle(String.fromCodePoint(0x1f600).repeat(SCREEN_TITLE_MAX))
    expect(readScreenRows(astral, size(astral), true)).not.toBeNull()
  })

  it('on a connection that acked title: a title that is not text, holds a control character or is over the bound is refused', () => {
    const refused = [5, null, true, ['x'], { text: 'x' }, `a${String.fromCharCode(7)}b`, `a${String.fromCharCode(0x7f)}b`, `a${String.fromCharCode(0x9b)}b`, 'x'.repeat(SCREEN_TITLE_MAX + 1)]
    for (const title of refused) expect(readScreenRows(withTitle(title), size(withTitle(title)), true), JSON.stringify(title)?.slice(0, 40)).toBeNull()
  })

  it('on any other connection: a title is refused, and an answer with none reads as before, its title null', () => {
    expect(readScreenRows(TITLED, size(TITLED), false)).toBeNull()
    expect(readScreenRows(TITLED, size(TITLED))).toBeNull()
    const plain = readScreenRows(PLAIN, size(PLAIN))
    expect(plain?.title).toBeNull()
    // The rest of the answer reads the same whether the title was acked or not.
    expect(readScreenRows(PLAIN, size(PLAIN), true)).toEqual(plain)
    expect(readScreenRows(TITLED, size(TITLED), true)).toEqual({ ...plain, title: TITLE })
  })
})

describe('2. the ack names title only beside screen, and last', () => {
  it('title after screen; without screen, no title', () => {
    expect(helloAck(false, false, true, true).caps).toEqual(['core', 'local', 'screen', TITLE_CAP])
    expect(helloAck(true, true, true, true).caps).toEqual(['core', 'local', 'hooks', 'mcp', 'screen', TITLE_CAP])
    expect(helloAck(true, true, false, true).caps).toEqual(['core', 'local', 'hooks', 'mcp'])
    expect(helloAck(true, true, true)).toEqual(helloAck(true, true, true, false))
  })
})

// ── the connection, on an in-memory stream with a stand-in holder ───────────
const SID = 'ag0123456789abcdef0123456789abcd'
const NONCE = '0123456789abcdef0123456789abcdef'
const RECORD: HolderRecord = {
  v: 1, session: SID, label: 'tab', pid: 4242, endpoint: `\\\\.\\pipe\\aicc-helper-${SID}-${'b'.repeat(32)}`, nonce: NONCE,
  helper: '0.1.0', started: 1, away: 120, attached: false, child: 'running', code: null,
}

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

/** A holder that says hello offering `caps`, and the app's connection to it,
 *  asked for `screen` and `title` as given. */
async function connected(caps: string[], screen: boolean, title: boolean) {
  const [app, holder] = duplexPair()
  const fromApp: Json[] = []
  const reader = new FrameReader('app_to_helper')
  holder.on('data', (chunk: Buffer) => { for (const f of reader.push(chunk)) if (f.kind === 0) fromApp.push(f.json as Json) })
  const hello = { proto: [1], helper: { version: '0.1.0' }, os: 'windows', arch: 'x86_64', caps, session: { sid: SID, state: 'live' } }
  holder.write(`AICC-HELLO ${NONCE} ${JSON.stringify(hello)}\n`)
  const conn = await HolderConnection.open({ record: RECORD, os: 'windows', openStream: async () => app, screen, title, pingEveryMs: 600_000 })
  open.push(conn)
  await until(() => fromApp.length >= 1, 'the hello.ack')
  /** readScreen, answered with `answer` (its `re` set to the read's id). */
  const readAnswered = async (answer: Json) => {
    const before = fromApp.filter((m) => m.t === 'screen.read').length
    const asked = conn.readScreen()
    await until(() => fromApp.filter((m) => m.t === 'screen.read').length > before, 'the read')
    const id = fromApp.filter((m) => m.t === 'screen.read')[before].id
    holder.write(encodeJsonFrame({ ...answer, re: id }))
    return asked
  }
  return { conn, fromApp, readAnswered }
}

describe('3. the connection acks title only when asked beside screen, and readScreen gives it then', () => {
  it('acked only when asked for it beside screen and the holder offers both', async () => {
    const cases: Array<[string[], boolean, boolean, string[]]> = [
      [NOW_CAPS, true, true, ['core', 'local', 'screen', TITLE_CAP]],
      [NOW_CAPS, true, false, ['core', 'local', 'screen']],
      [NOW_CAPS, false, true, ['core', 'local']],
      [BEFORE_CAPS, true, true, ['core', 'local', 'screen']],
    ]
    for (const [caps, screen, title, ack] of cases) {
      const c = await connected(caps, screen, title)
      const what = `offered ${caps.join(',')}, screen ${screen}, title ${title}`
      expect(c.fromApp[0], what).toEqual({ t: 'hello.ack', proto: 1, caps: ack })
      expect(c.conn.title, what).toBe(ack.includes(TITLE_CAP))
    }
  })

  it('readScreen gives the title on a connection that acked it, null with none; on one that did not, a title rejects and the connection stays up', async () => {
    const c = await connected(NOW_CAPS, true, true)
    expect((await c.readAnswered(TITLED)).title).toBe(TITLE)
    expect((await c.readAnswered(PLAIN)).title).toBeNull()

    const not = await connected(NOW_CAPS, true, false)
    expect(await not.readAnswered(PLAIN)).toMatchObject({ cols: PLAIN.cols, rows: PLAIN.rows, title: null })
    await expect(not.readAnswered(TITLED)).rejects.toMatchObject({ code: 'bad-frame' })
    expect(not.conn.isClosed).toBe(false)

    // A holder from before the title, asked for it: not acked, and its answer reads.
    const older = await connected(BEFORE_CAPS, true, true)
    expect((await older.readAnswered(PLAIN)).title).toBeNull()
    await expect(older.readAnswered(TITLED)).rejects.toMatchObject({ code: 'bad-frame' })
  })
})
