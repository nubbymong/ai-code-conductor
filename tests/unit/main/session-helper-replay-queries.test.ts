/**
 * A take-over's replay does not make the tab or main answer the terminal
 * queries in it again (2.1.3-beta.13, plan section A3, aicc_planning#360;
 * src/main/session-helper/replay-queries.ts and helper-pty.ts).
 *
 * The screen corpus (helper/fixtures/screens/) holds the agent CLIs' and the
 * shells' real output; 51 of its 61 recordings hold terminal queries. Each is
 * taken over from offset 0, through the fake holder and the real HelperPty,
 * into a terminal that answers as the tab's does: @xterm/headless 6.0.0's own
 * answers go back to the holder as the tab's do, and the colour and
 * pixel-size reports that only xterm.js's browser build sends are noted when
 * it would send them. No answer reaches the holder and none is noted; the tab
 * is shown the recording with each query, and nothing else, in its
 * stand-in's place; its rows (colours and attributes too), cursor, title and
 * modes are those of the whole recording; and main's colour answer
 * (createColorQueryResponder, fed what the tab is shown, as main feeds it the
 * terminal's output) answers nothing. A query after the replay is answered
 * once, and so is one the replay's end cuts in two. A launch's first output
 * and an attach again's replay keep their queries. Each request the plan
 * names is taken out at every split point, alone, and inside a replay cut
 * into one-byte frames.
 *
 * What the tab answers (xterm.js 6.0.0, read in its source): DA1, DA2, DSR
 * 5n, 6n and ?6n, DECRQM, DECRQSS and, when its window options allow it,
 * CSI 18 t (the core, so headless too); the OSC 4, 10, 11 and 12 colour
 * reports and CSI 14 and 16 t (its browser build only). It answers neither
 * XTVERSION, CSI ? u, DSR ?5n nor ENQ: those are taken out all the same, and
 * their rows show it by what the tab is shown, not by an answer. Of the
 * corpus's queries the tab answers DA1, DSR 6n and the colour queries.
 *
 * Not checked here:
 *  - DA3, XTGETTCAP and the other CSI t and DSR reports, which xterm.js 6.0.0
 *    does not answer: they are left in place (one row shows DA3 is);
 *  - a take-over whose filter is still on when its terminal starts the usual
 *    way or is let go of for an update (a sequence it holds goes then, as the
 *    decoder's half character does);
 *  - a replay through main's own stream (pty-manager.ts): the colour answer
 *    is fed what HelperPty gives, as main feeds it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Terminal } from '@xterm/headless'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { HolderConnection, HolderError } from '../../../src/main/session-helper/connection'
import { HelperPty, type HelperPtyDriver } from '../../../src/main/session-helper/helper-pty'
import { ReplayQueryFilter } from '../../../src/main/session-helper/replay-queries'
import { heldSessionId } from '../../../src/main/session-helper/protocol'
import { createColorQueryResponder } from '../../../src/main/terminal-query-responder'
import { TERMINAL_SCROLLBACK_LINES } from '../../../src/shared/terminal-scrollback'
import { FakeHolder } from './session-helper-fake-holder'

vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not used in this file') } }))

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(2)
  }
}

/** ST alone: what takes the place of a query that started with ESC. */
const ST = '\x1b\\'
/** Live output after a replay that the tab does nothing with (an OSC no terminal knows): once it is shown, the replay is in. */
const AFTER = '\x1b]9999;after the replay\x07'

// ── the requests the plan names, and what goes in each one's place ──────────

/** [what, the request, what the tab is shown in its place, whether xterm.js 6.0.0 answers it]. */
const REQUESTS: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ['DA1', '\x1b[c', ST, true],
  ['DA1 with 0', '\x1b[0c', ST, true],
  ['DA2', '\x1b[>c', ST, true],
  ['DA2 with 0', '\x1b[>0c', ST, true],
  ['DSR 5n', '\x1b[5n', ST, true],
  ['DSR 6n', '\x1b[6n', ST, true],
  ['DSR ?5n', '\x1b[?5n', ST, false],
  ['DSR ?6n', '\x1b[?6n', ST, true],
  ['XTVERSION', '\x1b[>q', ST, false],
  ['XTVERSION with 0', '\x1b[>0q', ST, false],
  ['DECRQM, ANSI', '\x1b[4$p', ST, true],
  ['DECRQM, DEC', '\x1b[?2026$p', ST, true],
  ['the kitty keyboard query', '\x1b[?u', ST, false],
  ['OSC 4 ?, BEL', '\x1b]4;1;?\x07', ST, true],
  ['OSC 10 ?, ST', '\x1b]10;?\x1b\\', ST + ST, true],
  ['OSC 11 ?, BEL', '\x1b]11;?\x07', ST, true],
  ['OSC 12 ?, ST', '\x1b]12;?\x1b\\', ST + ST, true],
  ['OSC 010 ? (a leading zero)', '\x1b]010;?\x07', ST, true],
  ['OSC 10 ? ? (10 and 11)', '\x1b]10;?;?\x07', ST, true],
  ['DECRQSS m', '\x1bP$qm\x1b\\', ST + ST, true],
  ['DECRQSS r, with a parameter', '\x1bP1$qr\x1b\\', ST + ST, true],
  ['CSI 14 t', '\x1b[14t', ST, true],
  ['CSI 16 t', '\x1b[16t', ST, true],
  ['CSI 18 t', '\x1b[18t', ST, true],
  ['ENQ', '\x05', '\x00', false],
  ['8-bit DA1', '\x9bc', '\x18', true],
  ['8-bit OSC 11, 8-bit ST', '\x9d11;?\x9c', '\x18', true],
  ['8-bit DECRQSS, 8-bit ST', '\x90$qm\x9c', '\x18', true],
]

/** Sequences that are not queries (or are ones xterm.js 6.0.0 does not answer, and the plan does not name): untouched. */
const NOT_QUERIES: ReadonlyArray<readonly [string, string]> = [
  ['SGR', '\x1b[1;38;5;208m'],
  ['DA1 with a parameter', '\x1b[1c'],
  ['DA3', '\x1b[=c'],
  ['a mode set', '\x1b[?2004h'],
  ['the kitty keyboard push', '\x1b[>7u'],
  ['a cursor style (an intermediate)', '\x1b[2 q'],
  ['a cursor restore (CSI u)', '\x1b[u'],
  ['a title', '\x1b]0;a title\x07'],
  ['a link, ST', '\x1b]8;;https://example.com/a\x1b\\'],
  ['a colour set', '\x1b]10;#ffffff\x07'],
  ['a colour reset', '\x1b]110\x07'],
  ['OSC 13 ?', '\x1b]13;?\x07'],
  ['OSC 10 with no data', '\x1b]10\x07'],
  ['OSC 4 with an index past 255', '\x1b]4;256;?\x07'],
  ['XTGETTCAP', '\x1bP+q544e\x1b\\'],
  ['DECRQSS cancelled by CAN', '\x1bP$qm\x18'],
  ['a DCS image', '\x1bPq#0;2;0;0;0#0~~~\x1b\\'],
  ['an APC string', '\x1b_Gf=24;AAAA\x1b\\'],
  ['a title report request', '\x1b[21t'],
  ['a cursor save', '\x1b7'],
  ['a character set', '\x1b(B'],
  ['text', 'plain text, a wide 字, and \u00e9'],
]

/** Feeds `text` to a new filter cut at `cuts` (each a place to cut, in order), then flushes it. */
function filtered(text: string, cuts: number[] = []): { out: string; dropped: number } {
  const f = new ReplayQueryFilter()
  let out = ''
  let at = 0
  for (const c of [...cuts, text.length]) {
    out += f.write(text.slice(at, c))
    at = c
  }
  out += f.flush()
  return { out, dropped: f.dropped }
}

/** Every one-cut split of `text`, and every character on its own. */
function splits(text: string): number[][] {
  const out: number[][] = [[]]
  for (let k = 1; k < text.length; k++) out.push([k])
  out.push(Array.from({ length: Math.max(0, text.length - 1) }, (_, k) => k + 1))
  return out
}

// ── a terminal that answers as the tab's does ───────────────────────────────

interface Tab {
  term: Terminal
  /** Answers the tab's terminal sent (its onData), in order. */
  answers: string[]
  /** Answers only xterm.js's browser build sends (colour and pixel-size reports): noted, as headless has none to send. */
  notes: string[]
  title: string
  /** Every write so far is parsed. */
  settled: () => Promise<void>
}

function tab(cols: number, rows: number): Tab {
  // Window options on: CSI 18 t is then answered here; the tab leaves them off, which answers less.
  const term = new Terminal({
    cols, rows, scrollback: TERMINAL_SCROLLBACK_LINES, allowProposedApi: true, logLevel: 'off',
    windowOptions: { getWinSizePixels: true, getCellSizePixels: true, getWinSizeChars: true },
  })
  const t: Tab = { term, answers: [], notes: [], title: '', settled: () => new Promise((done) => term.write('', done)) }
  term.onData((d) => t.answers.push(d))
  term.onTitleChange((s) => { t.title = s })
  // The browser build answers a part that is `?` (CoreBrowserTerminal, a REPORT colour event): noted for any `?` part,
  // which notes more than it answers. Each returns false, so xterm.js's own handler still runs.
  for (const id of [4, 10, 11, 12]) term.parser.registerOscHandler(id, (data) => { if (data.split(';').includes('?')) t.notes.push(`OSC ${id};${data}`); return false })
  term.parser.registerCsiHandler({ final: 't' }, (params) => { if (params[0] === 14 || params[0] === 16) t.notes.push(`CSI ${params.join(';')} t`); return false })
  return t
}

/** What a terminal shows, all of it: each line's text with its colours and attributes, and its cursor, title and modes. */
function screenOf(t: Tab): string[] {
  const { term } = t
  const buf = term.buffer.active
  const out = [`${buf.type} cursor ${buf.cursorX},${buf.cursorY} base ${buf.baseY} title ${JSON.stringify(t.title)} modes ${JSON.stringify(term.modes)}`]
  const cell = buf.getNullCell()
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    let row = `${line.isWrapped ? '+' : ' '}${line.translateToString(true)}`
    let attrs = ''
    for (let x = 0; x < term.cols; x++) {
      line.getCell(x, cell)
      const a = `${cell.getFgColorMode()}.${cell.getFgColor()}.${cell.getBgColorMode()}.${cell.getBgColor()}.${+cell.isBold()}${+cell.isDim()}${+cell.isItalic()}${+cell.isUnderline()}${+cell.isInverse()}${+cell.isInvisible()}${+cell.isStrikethrough()}`
      if (a !== attrs) { row += ` @${x}:${a}`; attrs = a }
    }
    out.push(row)
  }
  return out
}

async function shownOn(text: string, cols: number, rows: number): Promise<Tab> {
  const t = tab(cols, rows)
  t.term.write(text)
  await t.settled()
  return t
}

// ── a take-over through the fake holder ─────────────────────────────────────

interface Take {
  h: FakeHolder
  p: HelperPty
  t: Tab
  logs: string[]
  /** What the tab was shown. */
  shown: () => string
  /** What reached the holder's program as input. */
  typed: () => string
}

const folders: string[] = []
const takes: Array<{ h: FakeHolder; conns: HolderConnection[]; t: Tab }> = []
let n = 0

afterEach(async () => {
  for (const r of takes.splice(0)) {
    r.h.vanish()
    for (const c of r.conns) c.close()
    r.t.term.dispose()
  }
  await tick(10)
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/**
 * A terminal shown through one fake holder whose program wrote `ring` (a take-over from offset 0), or, with
 * `launch`, one launched now whose program writes `ring` before the attach. Its output goes to a tab, whose answers
 * go back to the holder as the tab's do.
 */
function through(ring: string, o: { cols?: number; rows?: number; frameBytes?: number; launch?: boolean; before?: (h: FakeHolder) => void } = {}): Take {
  const cols = o.cols ?? 80
  const rows = o.rows ?? 24
  const store = mkdtempSync(join(tmpdir(), 'aicc-replay-queries-'))
  folders.push(store)
  const app = `0123456789abcdef0123456789ab${String(n++ % 100).padStart(2, '0')}`
  const h = new FakeHolder(heldSessionId(app), app, store)
  if (o.frameBytes) h.frameBytes = o.frameBytes
  if (o.launch) h.onLaunch = () => h.output(ring)
  else {
    h.launch = { t: 'term.launch' }
    h.child = 'running'
    h.ring = Buffer.from(ring, 'utf8')
  }
  o.before?.(h)
  const conns: HolderConnection[] = []
  const logs: string[] = []
  const driver: HelperPtyDriver = {
    hold: async () => { h.writeRecord(); return h.record() },
    connect: async (record) => {
      const c = await HolderConnection.open({
        record,
        os: 'windows',
        openStream: async () => {
          if (h.gone || h.ended) throw new HolderError('io', 'no holder at that endpoint')
          return h.connect()
        },
        replyTimeoutMs: 2000,
        pingEveryMs: 0,
      })
      conns.push(c)
      return c
    },
    direct: () => { throw new Error('nothing starts the usual way here') },
    ending: () => {},
    attachedChanged: () => {},
    log: (m) => logs.push(m),
  }
  const p = new HelperPty({
    sid: h.sid,
    label: app,
    spec: { argv: ['/bin/sh'], cwd: '/home/someone', env: {}, cols, rows },
    ...(o.launch ? {} : { adopt: h.record() }),
    driver,
  })
  const t = tab(cols, rows)
  const seen: string[] = []
  p.onData((d) => { seen.push(d); t.term.write(d) })
  // The tab's answers go into the terminal, as TerminalView sends term.onData to the PTY.
  t.term.onData((d) => p.write(d))
  takes.push({ h, conns, t })
  return { h, p, t, logs, shown: () => seen.join(''), typed: () => Buffer.concat(h.input).toString('utf8') }
}

/** The replay is in and parsed: live output written after it is shown. */
async function replayed(r: Take): Promise<void> {
  await until(() => r.p.isAttached, 'the attach')
  r.h.output(AFTER)
  await until(() => r.shown().endsWith(AFTER), 'the replay and what follows it')
  await r.t.settled()
  // An answer the tab sent reaches the holder over the connection.
  await tick(10)
}

// ── the corpus ──────────────────────────────────────────────────────────────

const CORPUS = resolve(__dirname, '../../../helper/fixtures/screens')
interface Recording { cols: number; rows: number; events: Array<{ text?: string }> }
const RECORDINGS = readdirSync(CORPUS).filter((f) => f.endsWith('.json') && !f.endsWith('.rows.json')).sort()
const outputOf = (rec: Recording) => rec.events.map((e) => (typeof e.text === 'string' ? e.text : '')).join('')
/**
 * The queries the corpus holds, found by their exact shapes (apart from the filter's parser), each put in its
 * stand-in's place: an OSC ended by ESC keeps that ESC and its `\`.
 */
const CORPUS_QUERY = /\x1b\[(?:0?c|>0?c|\??[56]n|>0?q|\?u)|\x1b\](?:0*1[012]|0*4;\d+);\?(?:\x07|(?=\x1b))/g
const withStandIns = (s: string) => s.replace(CORPUS_QUERY, ST)

describe('the screen corpus, taken over from offset 0 (2.1.3-beta.13, plan section A3)', () => {
  it('holds the queries the plan found: 51 of its 61 recordings', () => {
    const holding = RECORDINGS.filter((f) => {
      const out = outputOf(JSON.parse(readFileSync(join(CORPUS, f), 'utf8')) as Recording)
      return withStandIns(out) !== out
    })
    expect(RECORDINGS).toHaveLength(61)
    expect(holding).toHaveLength(51)
  })

  for (const file of RECORDINGS) {
    it(`${file.replace(/\.json$/, '')}: no answer reaches the holder, the tab is shown the recording with each query in its stand-in's place, its screen is the whole recording's, and main's colour answer answers nothing`, async () => {
      const rec = JSON.parse(readFileSync(join(CORPUS, file), 'utf8')) as Recording
      const ring = outputOf(rec)
      const r = through(ring, { cols: rec.cols, rows: rec.rows })
      await replayed(r)
      // Soft: each property fails on its own, so a run against the old code shows which the recording breaks.
      expect.soft(r.typed(), 'answers that reached the holder').toBe('')
      expect.soft(r.t.answers, "the tab's answers").toEqual([])
      expect.soft(r.t.notes, "the browser build's colour and size answers").toEqual([])
      expect.soft(r.shown(), 'what the tab is shown').toBe(withStandIns(ring) + AFTER)
      const whole = await shownOn(ring + AFTER, rec.cols, rec.rows)
      try {
        expect.soft(screenOf(r.t), "the tab's screen").toEqual(screenOf(whole))
      } finally {
        whole.term.dispose()
      }
      const replies: string[] = []
      const colours = createColorQueryResponder({ colors: () => ({ foreground: [205, 214, 244], background: [30, 30, 46] }), reply: (b) => replies.push(b) })
      for (let k = 0; k < r.shown().length; k += 4096) colours.filter(r.shown().slice(k, k + 4096))
      expect.soft(replies, "main's colour answers").toEqual([])
    })
  }
})

describe('around the replay', () => {
  it('a query in the replay is not answered, and the same query written after it is answered once', async () => {
    const r = through('prompt> \x1b[c\x1b[6n')
    await replayed(r)
    expect(r.typed()).toBe('')
    r.h.output('\x1b[c')
    await until(() => r.typed() !== '', 'the answer')
    await r.t.settled()
    await tick(10)
    expect(r.typed()).toBe('\x1b[?1;2c')
  })

  for (const [what, head, tail, answer] of [
    ['a CSI', '\x1b[', 'c', '\x1b[?1;2c'],
    ['an ESC alone', '\x1b', '[6n', '\x1b[1;9R'],
    ['a DECRQSS', '\x1bP$', 'qm\x1b\\', '\x1bP1$r0m\x1b\\'],
  ] as const) {
    it(`a query the replay's end cuts in two (${what}): the program finished it after the take-over, so it is answered once`, async () => {
      const r = through(`prompt> ${head}`)
      await until(() => r.p.isAttached, 'the attach')
      r.h.output(`${tail}${AFTER}`)
      await until(() => r.shown().endsWith(AFTER), 'the rest')
      await r.t.settled()
      await until(() => r.typed() !== '', 'the answer')
      await tick(10)
      expect(r.typed()).toBe(answer)
      expect(r.shown()).toBe(`prompt> ${head}${tail}${AFTER}`)
      expect(r.logs.filter((l) => l.includes('terminal quer'))).toEqual([])
    })
  }

  it('a replay cut into one-byte frames: each request the plan names is taken out, none is answered, nothing else changes, and one log line counts them', async () => {
    const ring = `start ${REQUESTS.map(([, q]) => `${q}|`).join('')} end\r\n`
    const r = through(ring, { frameBytes: 1 })
    await replayed(r)
    expect(r.typed()).toBe('')
    expect(r.t.answers).toEqual([])
    expect(r.t.notes).toEqual([])
    expect(r.shown()).toBe(`start ${REQUESTS.map(([, , put]) => `${put}|`).join('')} end\r\n${AFTER}`)
    expect(r.logs.filter((l) => l.includes('terminal quer'))).toEqual([
      `[session-helper] ${r.h.sid}: ${REQUESTS.length} terminal queries in its replay were not passed on, so they are not answered a second time`,
    ])
  })

  it('the same replay given whole to the tab, as before: every request xterm.js 6.0.0 answers is answered or noted, so the test above can fail', async () => {
    const ring = `start ${REQUESTS.map(([, q]) => `${q}|`).join('')} end\r\n`
    const t = await shownOn(ring, 80, 24)
    try {
      expect(t.answers.length + t.notes.length).toBe(REQUESTS.filter(([, , , answered]) => answered).length)
    } finally {
      t.term.dispose()
    }
  })

  it('the connection closes inside a query in the middle of the replay: the attach again brings the rest, still filtered to the take-over\'s ring_end, and output after it is answered', async () => {
    const ring = `one\r\n\x1b[6n two\r\n\x1b]11;?\x1b\\three\r\n`
    const inside = Buffer.byteLength('one\r\n\x1b[6')
    const r = through(ring, { before: (h) => { h.cutReplay = { at: inside } } })
    await until(() => r.h.attaches === 2, 'the attach again')
    await replayed(r)
    expect(r.typed()).toBe('')
    expect(r.shown()).toBe(`one\r\n${ST} two\r\n${ST}${ST}three\r\n${AFTER}`)
    r.h.output('\x1b[5n')
    await until(() => r.typed() !== '', 'the answer')
    expect(r.typed()).toBe('\x1b[0n')
  })

  it('the start of its output gone (a gap): the notice and the replay\'s last lines, and still no answer', async () => {
    const lines = Array.from({ length: 50 }, (_, k) => `line ${k}\x1b[c\x1b[6n\r\n`).join('')
    const r = through(lines, { before: (h) => h.forget(Math.floor(Buffer.byteLength(lines) / 2)) })
    await replayed(r)
    expect(r.shown()).toContain('[Earlier output of this terminal is no longer held, so it is not shown.]')
    expect(r.shown()).not.toContain('\x1b[c')
    expect(r.shown()).not.toContain('\x1b[6n')
    expect(r.typed()).toBe('')
    expect(r.t.answers).toEqual([])
  })

  it('a launch, not a take-over: its first output was never shown, and the program waits for its answers, so they are answered once', async () => {
    const r = through('\x1b[c\x1b[6n', { launch: true })
    await replayed(r)
    expect(r.shown()).toBe(`\x1b[c\x1b[6n${AFTER}`)
    expect(r.typed()).toBe('\x1b[?1;2c\x1b[1;1R')
    expect(r.logs.filter((l) => l.includes('terminal quer'))).toEqual([])
  })

  it('an attach again of a launched terminal: what came while no connection was attached was never shown, so its query is answered once', async () => {
    const r = through('', { launch: true })
    await replayed(r)
    r.h.dropAll()
    r.h.output('\x1b[c')
    await until(() => r.h.attaches === 2, 'the attach again')
    await until(() => r.typed() !== '', 'the answer')
    await r.t.settled()
    await tick(10)
    expect(r.typed()).toBe('\x1b[?1;2c')
  })
})

// ── the filter on its own ───────────────────────────────────────────────────

describe('the query filter (replay-queries.ts)', () => {
  for (const [what, q, put] of REQUESTS) {
    it(`${what}: taken out, at every split point, with its stand-in in its place and what is around it untouched`, () => {
      const text = `a${q}b`
      for (const cuts of splits(text)) expect(filtered(text, cuts), `cut at ${cuts.join(',')}`).toEqual({ out: `a${put}b`, dropped: 1 })
    })
  }

  for (const [what, s] of NOT_QUERIES) {
    it(`${what}: untouched, at every split point`, () => {
      const text = `a${s}b`
      for (const cuts of splits(text)) expect(filtered(text, cuts), `cut at ${cuts.join(',')}`).toEqual({ out: text, dropped: 0 })
    })
  }

  it('an OSC that asks for a colour and sets others: the sets go on, each as an OSC (OSC 4\'s in one), the query does not', () => {
    expect(filtered('\x1b]4;1;?;2;#ff0000;3;?\x07').out).toBe(`${ST}\x1b]4;2;#ff0000${ST}`)
    expect(filtered('\x1b]10;?;#000000;?\x07').out).toBe(`${ST}\x1b]11;#000000${ST}`)
    expect(filtered('\x1b]10;#ffffff;?\x1b\\').out).toBe(`${ST}\x1b]10;#ffffff${ST}`)
    expect(filtered('\x1b]10;#000000;?;#123456\x1b\\').out).toBe(`${ST}\x1b]10;#000000${ST}\x1b]12;#123456${ST}`)
    // A part past 12 is read as nothing, and goes with the query.
    expect(filtered('\x1b]11;#000000;?;#123456\x1b\\').out).toBe(`${ST}\x1b]11;#000000${ST}`)
  })

  it('a C0 control the tab carries out inside a query stays, after the stand-in; one it drops inside a string goes with it', () => {
    expect(filtered('\x1b[6\nn').out).toBe(`${ST}\n`)
    expect(filtered('\x1b\r]11;?\x07').out).toBe(`${ST}\r`)
    expect(filtered('\x1b]11\x01;?\x07').out).toBe(ST)
  })

  it('held while it may still be a query, and only then: an OSC 8 link and a DCS image go on as they come', () => {
    const f = new ReplayQueryFilter()
    expect(f.write('x\x1b]1')).toBe('x')
    expect(f.write('3;?')).toBe('\x1b]13;?')
    expect(f.write('\x07\x1b]8;;https://example.com/')).toBe('\x07\x1b]8;;https://example.com/')
    expect(f.write('page\x1b\\\x1bPq#0')).toBe('page\x1b\\\x1bPq#0')
    expect(f.write('~~\x1b\\\x1b[')).toBe('~~\x1b\\')
    expect(f.write('?2004')).toBe('')
    expect(f.write('h')).toBe('\x1b[?2004h')
    expect(f.write('\x1bP$q')).toBe('')
    expect(f.write('m\x1b')).toBe(ST)
    expect(f.write('\\')).toBe('\x1b\\')
    expect(f.dropped).toBe(1)
  })

  it('flush gives back what is held as it is, and reading starts again from nothing', () => {
    const f = new ReplayQueryFilter()
    expect(f.write('a\x1b[')).toBe('a')
    expect(f.flush()).toBe('\x1b[')
    expect(f.write('c')).toBe('c')
    expect(f.write('\x1b[c')).toBe(ST)
    expect(f.dropped).toBe(1)
  })

  for (const [what, text] of [
    ['a repeat (CSI b) right after a query repeats nothing, as before', 'ab\x1b[c\x1b[3b|'],
    ['a repeat right after ENQ', 'ab\x05\x1b[3b|'],
    ['a repeat right after an 8-bit query', 'ab\x9bc\x1b[3b|'],
    ['a query\'s ESC ends a title not yet ended: the title is set, and what follows is text', '\x1b]0;a title\x1b[cnext'],
    ['an 8-bit query cuts a title short: no title, and what follows is text', '\x1b]0;a title\x9bcnext'],
    ['a query\'s ESC ends a DECRQSS not yet ended (both taken out)', 'x\x1bP$qm\x1b[6ny'],
    ['a line feed inside a query', 'top\x1b[6\nnbottom'],
    ['a colour query that sets another colour', '\x1b]10;?;#102030\x07x\x1b[41m y'],
    ['a query inside a full-screen program\'s screen', '\x1b[?1049h\x1b[5;5Hin\x1b[6n\x1b[?u\x1b[?1049lout'],
  ] as const) {
    it(`nothing else changes on the tab's screen: ${what}`, async () => {
      const before = await shownOn(text, 40, 8)
      const out = filtered(text).out
      const after = await shownOn(out, 40, 8)
      try {
        expect(screenOf(after)).toEqual(screenOf(before))
        expect(after.answers).toEqual([])
        expect(after.notes).toEqual([])
      } finally {
        before.term.dispose()
        after.term.dispose()
      }
    })
  }
})
