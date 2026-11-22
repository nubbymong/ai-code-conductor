/**
 * 2.1.3-beta.14, plan section C8 (aicc_planning#392, from #374 P3.1): a
 * take-over whose tab did not reach its holder's size within the size wait's
 * cap (its window changed size between the two runs) has its replay written
 * at the holder's size. The tab is told that size and the replay's length
 * just before the replay, so its terminal takes that size for the write and
 * is fitted to the tab after it; the holder hears the tab's size only once
 * the tab gives it after that fit, or FIT_WAIT_MAX_MS later. The paths that
 * are not the cap's (the tab at the holder's size, a holder with no screen
 * reads, a read that fails) are as before, with nothing told.
 *
 * PURE: the real HelperPty and HolderConnection against the fake holder, in
 * memory, on vitest's clock (setTimeout and clearTimeout only). Where a test
 * checks what the tab shows, the tab's terminal is @xterm/headless, written
 * at the holder's size and then resized to the tab's, as the renderer does
 * (tests/unit/renderer/terminalview-replay-at-holder-size.test.tsx).
 * session-helper-flow.test.ts keeps the size wait's own tests, with no tab to
 * tell (the notice unset), which is the shape before this section.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { Terminal } from '@xterm/headless'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'node-pty'
import { HolderConnection, HolderError } from '../../../src/main/session-helper/connection'
import { FIT_WAIT_MAX_MS, HOLD_MAX_MS, HelperPty, SIZE_WAIT_MAX_MS, setReplayAtHolderSizeNotice, type HelperPtyDriver, type RedrawWay } from '../../../src/main/session-helper/helper-pty'
import { LAUNCH_LIMITS, heldSessionId } from '../../../src/main/session-helper/protocol'
import { REPLAY_SIZE_MAX, readReplayAtHolderSize, type ReplayAtHolderSize } from '../../../src/shared/replay-at-holder-size'
import { TERMINAL_SCROLLBACK_LINES } from '../../../src/shared/terminal-scrollback'
import { FakeHolder } from './session-helper-fake-holder'

vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not used in this file') } }))

const CANCEL = '\x18'
const ATTRIBUTE_RESET = '\x1b[0m'
const NOTICE = '[Earlier output of this terminal is no longer held, so it is not shown.]'

/** In order: what the tab was told, and each piece of output it was shown. */
type Event = { told: ReplayAtHolderSize } | { shown: string }

interface Rig {
  h: FakeHolder
  p: HelperPty
  events: Event[]
  exits: number[]
  logs: string[]
  /** Each term.resize the app sent the holder, with what the tab had been shown when it went. */
  sent: Array<{ cols: unknown; rows: unknown; shown: string }>
  conns: HolderConnection[]
  seen: () => string[]
  told: () => ReplayAtHolderSize[]
  text: () => string
}

const folders: string[] = []
const rigs: Rig[] = []
let n = 0
/** What the notice answers: true, the tab was told. */
let tells = true

beforeEach(() => {
  tells = true
  setReplayAtHolderSizeNotice((sessionId, notice) => {
    const r = rigs.find((x) => x.p.label === sessionId)
    r?.events.push({ told: notice })
    return tells
  })
})

afterEach(async () => {
  setReplayAtHolderSizeNotice(undefined)
  vi.useRealTimers()
  for (const r of rigs.splice(0)) {
    r.h.vanish()
    for (const c of r.conns) c.close()
  }
  await new Promise((res) => setTimeout(res, 10))
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function fakeDirect(): IPty {
  return { pid: 1, cols: 80, rows: 24, process: 'x', handleFlowControl: false, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), resize() {}, clear() {}, write() {}, kill() {}, pause() {}, resume() {} } as unknown as IPty
}

/**
 * A take-over of one fake holder (set it up in `before`), its connections
 * asking for the screen reads as the manager's do for a plain terminal; the
 * tab is `cols` by `rows` at its spawn. `attachGate`: the term.attach waits
 * for it before it goes.
 */
function rig(o: { cols: number; rows: number; redraw?: RedrawWay; before: (h: FakeHolder) => void; attachGate?: Promise<void> }): Rig {
  const store = mkdtempSync(join(tmpdir(), 'aicc-replay-at-size-'))
  folders.push(store)
  const app = `abcdef0123456789abcdef${String(n++ % 100).padStart(2, '0')}`
  const h = new FakeHolder(heldSessionId(app), app, store)
  o.before(h)
  const events: Event[] = []
  const sent: Rig['sent'] = []
  const conns: HolderConnection[] = []
  const logs: string[] = []
  const text = () => events.flatMap((e) => ('shown' in e ? [e.shown] : [])).join('')
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
        screen: true,
      })
      const request = c.request.bind(c)
      c.request = async (msg, onReply) => {
        if (msg.t === 'term.resize') sent.push({ cols: msg.cols, rows: msg.rows, shown: text() })
        if (msg.t === 'term.attach' && o.attachGate) await o.attachGate
        return request(msg, onReply)
      }
      conns.push(c)
      return c
    },
    direct: fakeDirect,
    ending: () => {},
    attachedChanged: () => {},
    log: (m) => logs.push(m),
    now: () => 1_000_000,
  }
  const p = new HelperPty({
    sid: h.sid,
    label: app,
    spec: { argv: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'], cwd: 'C:\\Users\\someone', env: { Path: 'C:\\Windows' }, cols: o.cols, rows: o.rows },
    adopt: h.record(),
    ...(o.redraw ? { redraw: o.redraw } : {}),
    driver,
  })
  const exits: number[] = []
  const r: Rig = {
    h, p, events, exits, logs, sent, conns, text,
    seen: () => events.flatMap((e) => ('shown' in e ? [e.shown] : [])),
    told: () => events.flatMap((e) => ('told' in e ? [e.told] : [])),
  }
  p.onData((d) => events.push({ shown: d }))
  p.onExit((e) => exits.push(e.exitCode))
  rigs.push(r)
  return r
}

/** Runs `body` on vitest's clock. */
const onFakeClock = (body: () => Promise<void>) => async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await body()
  } finally {
    vi.useRealTimers()
  }
}
/** A real turn of the event loop, then what is due now on the fake clock, until `cond`. */
async function settle(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await new Promise<void>((res) => setImmediate(res))
    await vi.advanceTimersByTimeAsync(0)
  }
  throw new Error(`timed out waiting for ${what}`)
}
/** Real turns of the event loop, so the in-memory streams deliver what was sent. */
const turns = async (k = 50) => { for (let i = 0; i < k; i++) await new Promise<void>((res) => setImmediate(res)) }
const sizes = (r: Rig) => r.sent.map(({ cols, rows }) => ({ cols, rows }))

/** A holder whose terminal runs, its ring `ring`, offering the screen reads, at `cols` by `rows`. */
const running = (ring: string, cols: number, rows: number) => (h: FakeHolder) => {
  h.launch = { t: 'term.launch' }
  h.child = 'running'
  h.ring = Buffer.from(ring, 'utf8')
  h.caps = [...h.caps, 'screen']
  h.size = { cols, rows }
}
/** The same, its ring no longer holding the first `lost` bytes of its output. */
const heldFrom = (lost: number, ring: string, cols: number, rows: number) => (h: FakeHolder) => {
  running(ring, cols, rows)(h)
  h.ringStart = lost
}
/** `k` numbered lines, from `line <from>`, each ending CRLF. */
const numbered = (k: number, from = 1) => Array.from({ length: k }, (_, i) => `line ${from + i}\r\n`).join('')
const noticeRows = (cols: number) => Math.ceil(NOTICE.length / cols)
/** What a hold shows at the holder's size, nothing shown before: the notice on the row above the last of a terminal
 *  `rows` high, then `tail`, the scrollback cleared `clear` characters into it when given (2.1.3-beta.13 A4). */
const pieceAbove = (tail: string, rows: number, cols: number, clear?: number) =>
  `${CANCEL}${ATTRIBUTE_RESET}\x1b[${rows - noticeRows(cols)};1H${NOTICE}\r\n${clear === undefined ? tail : `${tail.slice(0, clear)}\x1b[3J${tail.slice(clear)}`}`
/** `kept` one-row lines up to `total` after the notice above the last row, the scrollback cleared once the empty rows above the notice left the screen. */
const numberedAbove = (total: number, kept: number, rows: number, cols: number) => {
  const gap = rows - 1 - noticeRows(cols)
  const first = total - kept + 1
  return pieceAbove(numbered(kept, first), rows, cols, numbered(gap, first).length)
}
/** What a hold shows at the tab's size, as before: the notice, then `tail`. */
const piece = (tail: string) => `${CANCEL}${ATTRIBUTE_RESET}${NOTICE}\r\n${tail}`

/** One line as a Windows console writes it in a terminal `cols` by `rows`: each row after the first starts with a jump
 *  back to the row above's last column and that column's character again, so the terminal marks the row wrapped (the
 *  recorded shape, tests/fixtures/replay/). */
const consoleLine = (line: string, cols: number, rows: number) => {
  const parts: string[] = []
  for (let i = 0; i < line.length; i += cols) parts.push(line.slice(i, i + cols))
  let out = parts[0]
  for (let k = 1; k < parts.length; k++) out += `\r\n\x1b[${rows - 1};${cols}H${parts[k - 1].slice(-1)}${parts[k]}`
  return `${out}\r\n`
}
const longLine = (k: number) => `long ${k} ${'y'.repeat(250)}`

/**
 * What the tab shows once it has written `stream` with its terminal at `holder` and then been fitted to `tab`, as the
 * renderer does: its rows, scrollback first, and its lines, each wrapped row joined to the row before.
 */
async function shownAfterFit(stream: string, holder: { cols: number; rows: number }, tab: { cols: number; rows: number }, more = '') {
  const term = new Terminal({ cols: holder.cols, rows: holder.rows, scrollback: TERMINAL_SCROLLBACK_LINES, allowProposedApi: true })
  try {
    await new Promise<void>((res) => term.write(stream, res))
    term.resize(tab.cols, tab.rows)
    if (more) await new Promise<void>((res) => term.write(more, res))
    const b = term.buffer.active
    const rows: string[] = []
    const lines: string[] = []
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i)
      const s = line?.translateToString(true) ?? ''
      rows.push(s)
      if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += s
      else lines.push(s)
    }
    return { rows, lines }
  } finally {
    term.dispose()
  }
}

/** The cap's line, for a tab told the holder's size. */
const capLine = (r: Rig, holder: string, tab: string) => `[session-helper] ${r.h.sid} (tab ${r.h.label}): the tab did not reach its holder's size ${holder} within ${SIZE_WAIT_MAX_MS} ms (it is ${tab}, and started at ${tab}), so its replay is written at the holder's size, then the tab is fitted to its own`

describe("the size wait's cap passed: the replay is written at the holder's size and the tab fitted after it (2.1.3-beta.14, plan section C8)", () => {
  it("a tab at 93x27, its holder at 103x27, the start of its output gone: at the cap the tab is told 103x27 and the replay's length just before the replay, which is counted at 103x27 with the cursor's row followed and the notice above the last row; no size goes to the holder until the tab gives its own; then the redraw at the tab's size", onFakeClock(async () => {
    const total = 12_000
    const r = rig({ cols: 93, rows: 27, before: heldFrom(5000, numbered(total), 103, 27) })
    await settle(() => r.p.isAttached, 'the attach')
    await turns()
    await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS - 1)
    expect(r.events).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await settle(() => r.seen().length > 0, 'the replay')
    // 10,000 less a screen (27 rows) and the notice's row is 9,972 rows; fitted to 93 columns, a row of 103 may take 2,
    // so half of that: 4,986 rows, the cursor's own and 4,985 lines.
    const kept = 4985
    expect(r.events).toEqual([{ told: { cols: 103, rows: 27, length: r.seen()[0].length } }, { shown: numberedAbove(total, kept, 27, 103) }])
    expect(r.logs).toContain(capLine(r, '103x27', '93x27'))
    expect(r.logs).toContain(`[session-helper] ${r.h.sid}: the oldest ${total - kept} lines of its replay are not shown either, so the line saying so stays within the ${TERMINAL_SCROLLBACK_LINES} lines the tab keeps (rows counted at 103x27, the cursor's row followed)`)
    // The tab writes it and fits itself meanwhile: nothing goes to the holder, however long that takes within the cap.
    await vi.advanceTimersByTimeAsync(FIT_WAIT_MAX_MS - 1)
    await turns()
    expect(r.sent).toEqual([])
    expect(r.h.size).toEqual({ cols: 103, rows: 27 })
    // The tab's size after its fit: the redraw, one row shorter, then 300 ms later the tab's size.
    r.p.resize(93, 27)
    await settle(() => r.sent.length === 1, 'the redraw')
    expect(sizes(r)).toEqual([{ cols: 93, rows: 26 }])
    await vi.advanceTimersByTimeAsync(300)
    await settle(() => r.sent.length === 2, 'the redraw\'s second half')
    await turns()
    expect(sizes(r)).toEqual([{ cols: 93, rows: 26 }, { cols: 93, rows: 27 }])
    expect(r.h.size).toEqual({ cols: 93, rows: 27 })
    expect(r.logs.filter((l) => l.includes('gave no size'))).toEqual([])
    expect(r.exits).toEqual([])
    vi.useRealTimers()
    const { rows } = await shownAfterFit(r.text(), { cols: 103, rows: 27 }, { cols: 93, rows: 27 })
    expect(rows.slice(0, 3)).toEqual([NOTICE, `line ${total - kept + 1}`, `line ${total - kept + 2}`])
    expect(rows.filter((row) => row !== '').at(-1)).toBe(`line ${total}`)
  }))

  it("the redraw at the same size (the console built into Windows): one resize, at the tab's size, once the tab gives it", onFakeClock(async () => {
    const r = rig({ cols: 93, rows: 27, redraw: 'same-size', before: heldFrom(5000, numbered(12_000), 103, 27) })
    await settle(() => r.p.isAttached, 'the attach')
    await turns()
    await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS)
    await settle(() => r.seen().length > 0, 'the replay')
    expect(r.told()).toHaveLength(1)
    await turns()
    expect(r.sent).toEqual([])
    r.p.resize(93, 27)
    await settle(() => r.sent.length === 1, 'the redraw')
    await vi.advanceTimersByTimeAsync(1000)
    await turns()
    expect(sizes(r)).toEqual([{ cols: 93, rows: 27 }])
    expect(r.sent[0].shown).toBe(r.text())
  }))

  it("a whole replay (nothing lost): told and shown as it is, with no notice; the holder hears the tab's size once the tab gives it", onFakeClock(async () => {
    const r = rig({ cols: 93, rows: 27, before: running('kept\r\n', 103, 27) })
    await settle(() => r.p.isAttached, 'the attach')
    await turns()
    await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS)
    await settle(() => r.seen().length > 0, 'the replay')
    expect(r.events).toEqual([{ told: { cols: 103, rows: 27, length: 6 } }, { shown: 'kept\r\n' }])
    await turns()
    expect(r.sent).toEqual([])
    r.p.resize(95, 28)
    await settle(() => r.sent.length === 1, 'the tab\'s size')
    expect(sizes(r)).toEqual([{ cols: 95, rows: 28 }])
  }))

  it(`a tab that gives no size: ${FIT_WAIT_MAX_MS} ms after the replay, the redraw goes at its last size, and the log says so`, onFakeClock(async () => {
    const r = rig({ cols: 93, rows: 27, before: heldFrom(5000, numbered(100), 103, 27) })
    await settle(() => r.p.isAttached, 'the attach')
    await turns()
    await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS)
    await settle(() => r.seen().length > 0, 'the replay')
    await vi.advanceTimersByTimeAsync(FIT_WAIT_MAX_MS - 1)
    await turns()
    expect(r.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await settle(() => r.sent.length === 1, 'the redraw')
    expect(sizes(r)).toEqual([{ cols: 93, rows: 26 }])
    expect(r.logs).toContain(`[session-helper] ${r.h.sid} (tab ${r.h.label}): the tab gave no size within ${FIT_WAIT_MAX_MS} ms of its replay at its holder's size, so its last size 93x27 is used`)
    // The tab's size after all: sent as any resize is, and the wait is over.
    r.p.resize(94, 27)
    await settle(() => r.sent.length >= 2, 'the late size')
    expect(r.sent.at(-1)).toMatchObject({ cols: 94, rows: 27 })
  }))

  it("a size the tab gives after the cap, while its replay is still coming, is not sent: the replay, once in, is told and shown at the holder's size, and the first size after it goes", onFakeClock(async () => {
    // The attach goes 1.5 s after the size was read, and its replay stalls: at the size wait's cap the replay's own cap
    // (HOLD_MAX_MS from the attach) is still to come.
    let open!: () => void
    const gate = new Promise<void>((res) => { open = res })
    const r = rig({ cols: 93, rows: 27, before: (h) => { running('first half second half\r\n', 103, 27)(h); h.stallReplay = { at: 11 } }, attachGate: gate })
    await settle(() => r.h.screenReads === 1, 'the size read')
    await vi.advanceTimersByTimeAsync(1500)
    open()
    await settle(() => r.p.isAttached, 'the attach')
    await turns()
    await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS - 1500)
    expect(r.logs).toContain(capLine(r, '103x27', '93x27'))
    expect(r.events).toEqual([])
    r.p.resize(120, 30)
    await turns()
    expect(r.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(HOLD_MAX_MS)
    await settle(() => r.seen().length > 0, 'what came of the replay')
    expect(r.events).toEqual([{ told: { cols: 103, rows: 27, length: 11 } }, { shown: 'first half ' }])
    await turns()
    expect(r.sent).toEqual([])
    r.p.resize(93, 27)
    await settle(() => r.sent.length === 1, 'the tab\'s size')
    expect(sizes(r)).toEqual([{ cols: 93, rows: 27 }])
  }))

  it('a program that is over at the cap: told and shown at the holder\'s size, then its exit; no size goes to the holder, and nothing waits after the end', onFakeClock(async () => {
    const total = 12_000
    const r = rig({ cols: 93, rows: 27, before: (h) => { heldFrom(5000, numbered(total), 103, 27)(h); h.child = 'exited'; h.code = 7 } })
    await settle(() => r.p.isAttached || r.exits.length > 0, 'the attach')
    await turns()
    await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS)
    await settle(() => r.exits.length === 1, 'the exit')
    expect(r.told()).toEqual([{ cols: 103, rows: 27, length: r.seen()[0].length }])
    expect(r.seen()).toEqual([numberedAbove(total, 4985, 27, 103)])
    expect(r.exits).toEqual([7])
    await vi.advanceTimersByTimeAsync(FIT_WAIT_MAX_MS + 1000)
    r.p.resize(93, 27)
    await turns()
    expect(r.sent).toEqual([])
    expect(r.logs.filter((l) => l.includes('gave no size'))).toEqual([])
  }))

  it('ended while the tab writes it: nothing goes to the holder after, and the fit wait logs nothing', onFakeClock(async () => {
    const r = rig({ cols: 93, rows: 27, before: heldFrom(5000, numbered(100), 103, 27) })
    await settle(() => r.p.isAttached, 'the attach')
    await turns()
    await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS)
    await settle(() => r.seen().length > 0, 'the replay')
    r.p.kill()
    await settle(() => r.h.ended && r.exits.length === 1, 'the end')
    await vi.advanceTimersByTimeAsync(FIT_WAIT_MAX_MS + 1000)
    expect(r.sent).toEqual([])
    expect(r.logs.filter((l) => l.includes('gave no size'))).toEqual([])
  }))

  it('a tab that could not be told (no window): nothing waits for its fit, and the redraw goes at once, as before', onFakeClock(async () => {
    tells = false
    const r = rig({ cols: 93, rows: 27, before: heldFrom(5000, numbered(100), 103, 27) })
    await settle(() => r.p.isAttached, 'the attach')
    await turns()
    await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS)
    await settle(() => r.sent.length === 1, 'the redraw')
    expect(r.told()).toHaveLength(1)
    expect(sizes(r)).toEqual([{ cols: 93, rows: 26 }])
  }))
})

describe('what the tab shows after the fit: every kept line whole, the notice its first row', () => {
  /** About 2 MiB of a console's long lines, lines `from` to `to`, then its prompt. */
  const PROMPT = 'PS C:\\Users\\user\\work>\x1b[1C'
  const replayAt = (cols: number, rows: number, from: number, to: number) => `${Array.from({ length: to - from + 1 }, (_, i) => consoleLine(longLine(from + i), cols, rows)).join('')}${PROMPT}`

  /** The take-over through the cap, the tab's size given after the replay; answers what it was shown. */
  async function restore(holder: { cols: number; rows: number }, tab: { cols: number; rows: number }, ring: string): Promise<Rig> {
    const r = rig({ cols: tab.cols, rows: tab.rows, before: heldFrom(5000, ring, holder.cols, holder.rows) })
    await settle(() => r.p.isAttached, 'the attach')
    // All of the replay in before the cap.
    await turns(500)
    await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS)
    await settle(() => r.seen().length > 0, 'the replay')
    expect(r.told()).toEqual([{ ...holder, length: r.seen()[0].length }])
    expect(r.seen()).toHaveLength(1)
    return r
  }
  /** The kept lines after the notice: consecutive console lines up to the last, each whole, then the prompt. */
  function expectWholeLines(lines: string[], last: number): number {
    expect(lines[0]).toBe(NOTICE)
    const body = lines.slice(1).filter((l) => l !== '')
    expect(body.at(-1)).toBe('PS C:\\Users\\user\\work>')
    const kept = body.slice(0, -1)
    const first = last - kept.length + 1
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => longLine(first + i)))
    return kept.length
  }

  it("written at 103x27, the tab at 93x27 (the VM's 1024x768 tab a little narrower): every kept line whole, the notice the first row, and still the first after a screen of redraw and a screen more", onFakeClock(async () => {
    const ring = replayAt(103, 27, 2667, 9999)
    expect(Buffer.byteLength(ring)).toBeGreaterThan(2 * 1024 * 1024)
    const r = await restore({ cols: 103, rows: 27 }, { cols: 93, rows: 27 }, ring)
    vi.useRealTimers()
    const { lines } = await shownAfterFit(r.text(), { cols: 103, rows: 27 }, { cols: 93, rows: 27 })
    // 4,986 rows at 103 (half of 9,972: a row of 103 may take 2 of 93): the prompt's and 1,661 lines of 3.
    expect(expectWholeLines(lines, 9999)).toBe(1661)
    expect((await shownAfterFit(r.text(), { cols: 103, rows: 27 }, { cols: 93, rows: 27 }, 'more\r\n'.repeat(54))).rows[0]).toBe(NOTICE)
  }))

  it('written at 127x30 (a 1280x800 window), the tab at 103x27 (1024x768), lines of 120 that take 1 row there and 2 here: the notice still the first row after the fit, every kept line whole', onFakeClock(async () => {
    const line = (k: number) => `long ${k} ${'y'.repeat(120 - `long ${k} `.length)}`
    const ring = Array.from({ length: 17_000 }, (_, i) => `${line(i + 1)}\r\n`).join('')
    const r = await restore({ cols: 127, rows: 30 }, { cols: 103, rows: 27 }, ring)
    vi.useRealTimers()
    const { rows, lines } = await shownAfterFit(r.text(), { cols: 127, rows: 30 }, { cols: 103, rows: 27 })
    expect(rows[0]).toBe(NOTICE)
    const kept = lines.slice(1).filter((l) => l !== '')
    expect(kept.at(-1)).toBe(line(17_000))
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => line(17_000 - kept.length + 1 + i)))
    // Each takes 2 rows of 103: the tab's 10,000 less its screen and the notice's row, halved.
    expect(kept.length).toBe(4985)
    expect((await shownAfterFit(r.text(), { cols: 127, rows: 30 }, { cols: 103, rows: 27 }, 'more\r\n'.repeat(54))).rows[0]).toBe(NOTICE)
  }))

  it('written at 103x27, the tab at 127x30 (wider and taller): every kept line whole, the notice the first row', onFakeClock(async () => {
    const r = await restore({ cols: 103, rows: 27 }, { cols: 127, rows: 30 }, replayAt(103, 27, 2667, 9999))
    vi.useRealTimers()
    const { lines } = await shownAfterFit(r.text(), { cols: 103, rows: 27 }, { cols: 127, rows: 30 })
    // 10,000 less the tab's 30 rows and the notice's row is 9,969 rows at 103: the prompt's and 3,322 lines of 3.
    expect(expectWholeLines(lines, 9999)).toBe(3322)
  }))
})

describe('the other paths, with a tab that can be told: as before, nothing told', () => {
  it("a tab that reaches its holder's size before the cap: no notice, the piece at that size and the redraw, as before", onFakeClock(async () => {
    const total = 12_000
    const r = rig({ cols: 93, rows: 27, before: heldFrom(5000, numbered(total), 103, 27) })
    await settle(() => r.p.isAttached, 'the attach')
    await turns()
    r.p.resize(103, 27)
    await settle(() => r.sent.length > 0, 'the redraw')
    expect(r.told()).toEqual([])
    expect(r.seen()).toEqual([numberedAbove(total, TERMINAL_SCROLLBACK_LINES - 27 - 1 - 1, 27, 103)])
    expect(sizes(r)).toEqual([{ cols: 103, rows: 26 }])
  }))

  it("a tab at the holder's size from its start: no notice, the replay and the one resize, as before", onFakeClock(async () => {
    const r = rig({ cols: 103, rows: 27, before: running('kept\r\n', 103, 27) })
    await settle(() => r.sent.length > 0 && r.text() === 'kept\r\n', 'the replay and the resize')
    expect(r.told()).toEqual([])
    expect(sizes(r)).toEqual([{ cols: 103, rows: 27 }])
  }))

  for (const [what, setUp] of [
    ['a holder that offers no screen reads', (h: FakeHolder) => { h.caps = h.caps.filter((c) => c !== 'screen') }],
    ['a screen read the holder answers with an error', (h: FakeHolder) => { h.screenAnswer = 'error' }],
  ] as const) {
    it(`${what}: no notice, shown at once at the tab's size with the redraw, as before`, onFakeClock(async () => {
      const r = rig({ cols: 93, rows: 27, before: (h) => { heldFrom(5000, 'the last screen\r\n', 103, 27)(h); setUp(h) } })
      await settle(() => r.sent.length > 0, 'the redraw')
      expect(r.told()).toEqual([])
      expect(r.seen()).toEqual([piece('the last screen\r\n')])
      expect(sizes(r)).toEqual([{ cols: 93, rows: 26 }])
    }))
  }

  it("no tab to tell (the notice unset): the cap shows the replay at the tab's size and sends the redraw at once, as before", onFakeClock(async () => {
    setReplayAtHolderSizeNotice(undefined)
    const r = rig({ cols: 93, rows: 27, before: heldFrom(5000, 'the last screen\r\n', 103, 27) })
    await settle(() => r.p.isAttached, 'the attach')
    await turns()
    await vi.advanceTimersByTimeAsync(SIZE_WAIT_MAX_MS)
    await settle(() => r.sent.length > 0, 'the redraw')
    expect(r.seen()).toEqual([piece('the last screen\r\n')])
    expect(sizes(r)).toEqual([{ cols: 93, rows: 26 }])
    expect(r.logs).toContain(`[session-helper] ${r.h.sid} (tab ${r.h.label}): the tab did not reach its holder's size 103x27 within ${SIZE_WAIT_MAX_MS} ms (it is 93x27, and started at 93x27), so its replay is shown at the tab's size`)
  }))
})

describe('the notice as the tab reads it', () => {
  it("whole numbers only, the size within the helper protocol's bound, a length of at least 1", () => {
    expect(REPLAY_SIZE_MAX).toBe(LAUNCH_LIMITS.termCells)
    expect(readReplayAtHolderSize({ cols: 103, rows: 27, length: 6 })).toEqual({ cols: 103, rows: 27, length: 6 })
    expect(readReplayAtHolderSize({ cols: REPLAY_SIZE_MAX, rows: 1, length: 1, extra: 'x' })).toEqual({ cols: REPLAY_SIZE_MAX, rows: 1, length: 1 })
    for (const bad of [null, undefined, 'x', 7, [], { cols: 0, rows: 27, length: 6 }, { cols: 103, rows: REPLAY_SIZE_MAX + 1, length: 6 }, { cols: 103.5, rows: 27, length: 6 }, { cols: '103', rows: 27, length: 6 }, { cols: 103, rows: 27, length: 0 }, { cols: 103, rows: 27, length: 2.5 }, { cols: 103, rows: 27 }]) {
      expect(readReplayAtHolderSize(bad)).toBeNull()
    }
  })
})
