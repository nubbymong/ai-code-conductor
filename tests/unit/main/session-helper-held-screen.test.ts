/**
 * A restored held terminal lines up with its console (2.1.3-beta.13, plan
 * section A4, aicc_planning#382), on recorded console streams
 * (tests/fixtures/replay/) read by @xterm/headless, the tab's terminal.
 *
 * Part 1 pins the record. A Windows console (the one built into Windows) at
 * 103 by 27 with its prompt on the last row, made one row shorter and back
 * (beta.12's redraw), drops its top row and moves the rest up: its two
 * repaints, addressed from the top-left, paint over the tab's top row, which
 * is lost, and leave the prompt a row up. Its line editor still holds the
 * prompt's old row, so a typed command is drawn a row under the prompt.
 *
 * Part 2, end to end: HelperPty taking over a fake holder whose console
 * answers each resize as the recorded console did (one row shorter: the
 * recorded repaints, byte for byte; the same size: a repaint of its screen
 * in the same form, nothing moved) and whose shell writes a typed command on
 * the row it holds. With the redraw at the same size (the manager's choice on
 * that console) every kept line is whole, no row is missing, the notice is
 * the first row and the first kept line the second, and the command is on
 * the prompt's row. With the nudge the same model loses the row and draws the
 * command a row low, as recorded.
 *
 * Not checked here: that the real console draws its whole screen again for a
 * resize to the size it has while a shell waits at its prompt (probe P19
 * measured the two agent CLIs; A4's VM line checks a shell); node-pty's
 * bundled ConPTY, macOS and Linux (they keep the nudge); a full-screen
 * program (the VM line); any size but 103 by 27; why the line editor keeps
 * its row (the bytes show that it does).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Terminal } from '@xterm/headless'
import fs from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { HolderConnection } from '../../../src/main/session-helper/connection'
import { HelperPty, type HelperPtyDriver, type RedrawWay } from '../../../src/main/session-helper/helper-pty'
import { TERMINAL_SCROLLBACK_LINES } from '../../../src/shared/terminal-scrollback'
import { heldSessionId, type HolderRecord } from '../../../src/main/session-helper/protocol'
import { FakeHolder } from './session-helper-fake-holder'

vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not used in this file') } }))

const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'replay')
interface Recorded { what: string; recorded: string; cols: number; rows: number; before: string; repaints: string[]; typed?: string }
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Recorded
const REDRAW = load('conpty-redraw-103x27.json')
const TYPED = load('conpty-typed-after-redraw.json')

const NOTICE = '[Earlier output of this terminal is no longer held, so it is not shown.]'
/** The prompt of the recorded redraw's console (A1's VM line). */
const PROMPT = 'PS C:\\Users\\user\\Downloads\\b13a1\\work>'
/** One line as that console writes it at 103 by 27, 2.5 rows long: each row, a line break, a jump to the last column of the row above, its last character again, the next row. */
const consoleLine = (n: number) => {
  const text = `long ${n} ${'y'.repeat(250)}`
  const [a, b, c] = [text.slice(0, 103), text.slice(103, 206), text.slice(206)]
  return `${a}\r\n\x1b[26;103H${a.slice(-1)}${b}\r\n\x1b[26;103H${b.slice(-1)}${c}\r\n`
}
const consoleLines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => consoleLine(from + i)).join('')
/** The cursor on a new terminal's last row, where the console's had it. */
const atLastRow = (rows: number) => '\n'.repeat(rows - 1)

interface Row { text: string; wrapped: boolean }
/** Every row of the normal screen's buffer after `stream`, in a terminal 103 by 27 that keeps what a tab keeps. */
async function rowsAfter(stream: string): Promise<Row[]> {
  const term = new Terminal({ cols: 103, rows: 27, scrollback: TERMINAL_SCROLLBACK_LINES, allowProposedApi: true })
  try {
    await new Promise<void>((res) => term.write(stream, res))
    const b = term.buffer.normal
    return Array.from({ length: b.length }, (_, i) => ({ text: b.getLine(i)?.translateToString(true) ?? '', wrapped: b.getLine(i)?.isWrapped ?? false }))
  } finally {
    term.dispose()
  }
}
/** The buffer's lines: each row with the rows that continue it; and how many rows each took. */
function linesOf(rows: Row[]): Array<{ text: string; rows: number }> {
  const out: Array<{ text: string; rows: number }> = []
  for (const r of rows) {
    if (r.wrapped && out.length > 0) {
      out[out.length - 1].text += r.text
      out[out.length - 1].rows++
    } else out.push({ text: r.text, rows: 1 })
  }
  while (out.length > 0 && out[out.length - 1].text === '') out.pop()
  return out
}
const lineOf = (lines: Array<{ text: string; rows: number }>, n: number) => lines.find((l) => l.text.startsWith(`long ${n} `))

describe('the record (tests/fixtures/replay/)', () => {
  it('the recorded fixtures hold console output and generic paths only, checked as the screen corpus is (tests/unit/shared/screen-corpus.test.ts, case 4)', () => {
    for (const name of ['conpty-redraw-103x27.json', 'conpty-typed-after-redraw.json']) {
      const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8')
      for (const m of raw.matchAll(/(?:\b[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)([^\\/\s"'<>|:*?\x00-\x1f]+)/gi)) expect(['user', 'runneradmin', 'runner'], name).toContain(m[1].toLowerCase())
      expect(raw, name).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/)
      for (const re of [/\bsk-[A-Za-z0-9_-]{16,}/, /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/]) {
        expect(raw, name).not.toMatch(re)
      }
    }
  })

  it('the recorded lines are the shape consoleLine writes, and the redraw is two repaints from the top-left', () => {
    expect(REDRAW).toMatchObject({ cols: 103, rows: 27 })
    expect(REDRAW.before).toBe(`${consoleLines(9989, 10000)}${PROMPT}\x1b[1C`)
    expect(REDRAW.repaints).toHaveLength(2)
    for (const p of REDRAW.repaints) expect(p.startsWith('\x1b[?25l\x1b[H')).toBe(true)
  })

  it('the console made one row shorter and back loses the tab\'s top row: line 9992 keeps 157 of its 260 characters, and the prompt goes a row up', async () => {
    const before = linesOf(await rowsAfter(`${atLastRow(27)}${REDRAW.before}`))
    expect(lineOf(before, 9992)).toEqual({ text: `long 9992 ${'y'.repeat(250)}`, rows: 3 })
    const beforeRows = await rowsAfter(`${atLastRow(27)}${REDRAW.before}`)
    const afterRows = await rowsAfter(`${atLastRow(27)}${REDRAW.before}${REDRAW.repaints.join('')}`)
    expect(afterRows).toHaveLength(beforeRows.length)
    const after = linesOf(afterRows)
    expect(lineOf(after, 9992)).toEqual({ text: `long 9992 ${'y'.repeat(147)}`, rows: 2 })
    // The prompt's row: the last before the redraw, the one above it after.
    const promptRow = (rows: Row[]) => rows.map((r) => r.text).lastIndexOf(PROMPT) - (rows.length - 27)
    expect(promptRow(beforeRows)).toBe(26)
    expect(promptRow(afterRows)).toBe(25)
  })

  it('after that redraw the line editor draws a typed command on the row under the prompt, after 40 spaces and a second "> ", and the top row is lost (line 39975)', async () => {
    const rows = (await rowsAfter(`${atLastRow(27)}${TYPED.before}${TYPED.repaints.join('')}${TYPED.typed}`)).map((r) => r.text)
    const at = rows.findIndex((r) => r.includes('"ok "'))
    expect(rows.slice(at - 1, at + 3)).toEqual(['PS C:\\Users\\user\\Downloads\\b12smoke\\work>', `${' '.repeat(40)}> "ok " + (6*7)`, 'ok 42', 'PS C:\\Users\\user\\Downloads\\b12smoke\\work>'])
    expect(rows.some((r) => r.startsWith('line 39974 '))).toBe(true)
    expect(rows.some((r) => r.startsWith('line 39975 '))).toBe(false)
    expect(rows.some((r) => r.startsWith('line 39976 '))).toBe(true)
  })
})

describe('end to end: a take-over after a gap, its console and its shell modelled on the record', () => {
  const folders: string[] = []
  afterEach(() => {
    for (const f of folders.splice(0)) fs.rmSync(f, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** Runs `body` on vitest's clock (setTimeout and clearTimeout only). */
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
    for (let i = 0; i < 800; i++) {
      if (cond()) return
      await new Promise<void>((res) => setImmediate(res))
      await vi.advanceTimersByTimeAsync(0)
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  /** The console's screen after the replay, drawn again at the size it has, in the form of its recorded repaints (MODEL, not recorded). */
  const sameSizeRepaint = `\x1b[?25l\x1b[H${'y'.repeat(157)}\x1b[K\r\n${Array.from({ length: 8 }, (_, i) => `long ${9993 + i} ${'y'.repeat(250)}\x1b[K\r\n`).join('')}${PROMPT}\x1b[K\x1b[1C\x1b[?25h`
  /** The line editor drawing a typed command on the row it holds for the prompt (MODEL, in the form of the recorded one). */
  const typedAt = (row: number) => `\x1b[?25l\x1b[91m\x1b[${row};38H> \x1b[36m"w " \x1b[90m+ \x1b[m(\x1b[97m1\x1b[90m*\x1b[97m7\x1b[m)\x1b[?25h\r\nw 7\r\n${PROMPT}\x1b[1C`

  /**
   * A holder at 103 by 27 whose ring no longer holds its first 5000 bytes and
   * ends with that console's lines 6000 to 10000 and its prompt; a tab whose
   * first size is 93 by 27 (the DOM renderer's cell) takes it over.
   */
  function takeOver(redraw?: RedrawWay) {
    const store = fs.mkdtempSync(path.join(tmpdir(), 'aicc-held-screen-'))
    folders.push(store)
    const app = 'abcdef0123456789abcdef71'
    const h = new FakeHolder(heldSessionId(app), app, store)
    h.launch = { t: 'term.launch' }
    h.child = 'running'
    h.caps = [...h.caps, 'screen']
    h.size = { cols: 103, rows: 27 }
    h.ring = Buffer.from(`${consoleLines(6000, 10000)}${PROMPT}\x1b[1C`, 'utf8')
    h.ringStart = 5000
    const sizes: Array<{ cols: unknown; rows: unknown }> = []
    const unexpected: string[] = []
    let rows = 27
    // The console's answer to a resize: one row shorter, the recorded repaint; back, the recorded one; the same size, its screen again.
    const answer = (c: number, r: number) => {
      if (c !== 103) unexpected.push(`${c}x${r}`)
      else if (r === 26 && rows === 27) h.output(REDRAW.repaints[0])
      else if (r === 27 && rows === 26) h.output(REDRAW.repaints[1])
      else if (r === 27 && rows === 27) h.output(sameSizeRepaint)
      else unexpected.push(`${c}x${r}`)
      rows = r
    }
    const conns: HolderConnection[] = []
    const driver: HelperPtyDriver = {
      hold: async () => h.record(),
      connect: async (record: HolderRecord) => {
        const c = await HolderConnection.open({ record, os: 'windows', openStream: async () => h.connect(), replyTimeoutMs: 2000, pingEveryMs: 0, screen: true })
        const request = c.request.bind(c)
        c.request = (msg, onReply) => {
          const asked = request(msg, onReply)
          if (msg.t !== 'term.resize') return asked
          return asked.then((reply) => {
            sizes.push({ cols: msg.cols, rows: msg.rows })
            answer(Number(msg.cols), Number(msg.rows))
            return reply
          })
        }
        conns.push(c)
        return c
      },
      direct: () => { throw new Error('not the usual way here') },
      ending: () => {},
      attachedChanged: () => {},
      log: () => {},
      now: () => 0,
    }
    const p = new HelperPty({
      sid: h.sid,
      label: app,
      spec: { argv: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'], cwd: 'C:\\Users\\user', env: { Path: 'C:\\Windows' }, cols: 93, rows: 27 },
      adopt: h.record(),
      driver,
      ...(redraw ? { redraw } : {}),
    })
    const seen: string[] = []
    p.onData((d) => seen.push(d))
    const done = () => { h.vanish(); for (const c of conns) c.close() }
    return { h, p, seen, sizes, unexpected, done }
  }

  /** The take-over to its end: the tab reaches 103 by 27, the redraw goes and is answered, then a command is typed; what the tab was shown. */
  async function restoreAndType(redraw: RedrawWay | undefined, resizes: number): Promise<{ text: string; sizes: Array<{ cols: unknown; rows: unknown }>; unexpected: string[] }> {
    const t = takeOver(redraw)
    try {
      await settle(() => t.p.isAttached, 'the attach')
      for (let i = 0; i < 100; i++) await new Promise<void>((res) => setImmediate(res))
      t.p.resize(103, 27)
      await settle(() => t.sizes.length >= 1 && t.seen.length >= 2, 'the piece and the first repaint')
      await vi.advanceTimersByTimeAsync(1000)
      await settle(() => t.sizes.length >= resizes, 'the redraw')
      for (let i = 0; i < 100; i++) await new Promise<void>((res) => setImmediate(res))
      const shown = t.seen.length
      t.p.write('"w " + (1*7)\r')
      await settle(() => Buffer.concat(t.h.input).toString('utf8') === '"w " + (1*7)\r', 'the command at the shell')
      // The shell holds the row the prompt was on when it was drawn: 27.
      t.h.output(typedAt(27))
      await settle(() => t.seen.slice(shown).join('').endsWith(`${PROMPT}\x1b[1C`), 'the command drawn')
      return { text: t.seen.join(''), sizes: t.sizes, unexpected: t.unexpected }
    } finally {
      t.done()
    }
  }

  const kept = Array.from({ length: 10000 - 6678 + 1 }, (_, i) => ({ text: `long ${6678 + i} ${'y'.repeat(250)}`, rows: 3 }))

  it("with the redraw at the same size (the console built into Windows): one resize, at 103x27; the notice is the first row and line 6678 the second, every kept line whole on its 3 rows with none missing, and the typed command on the prompt's row", onFakeClock(async () => {
    const r = await restoreAndType('same-size', 1)
    expect(r.unexpected).toEqual([])
    expect(r.sizes).toEqual([{ cols: 103, rows: 27 }])
    vi.useRealTimers()
    const rows = await rowsAfter(r.text)
    expect(rows[0].text).toBe(NOTICE)
    expect(rows[1].text).toBe(`long 6678 ${'y'.repeat(93)}`)
    expect(linesOf(rows)).toEqual([
      { text: NOTICE, rows: 1 },
      ...kept,
      { text: `${PROMPT} "w " + (1*7)`, rows: 1 },
      { text: 'w 7', rows: 1 },
      { text: PROMPT, rows: 1 },
    ])
  }))

  it('with the nudge (one row shorter and back, the default), the same model loses the row and draws the command a row low, as recorded: the model can fail', onFakeClock(async () => {
    const r = await restoreAndType(undefined, 2)
    expect(r.unexpected).toEqual([])
    expect(r.sizes).toEqual([{ cols: 103, rows: 26 }, { cols: 103, rows: 27 }])
    vi.useRealTimers()
    const lines = linesOf(await rowsAfter(r.text))
    expect(lineOf(lines, 9992)).toEqual({ text: `long 9992 ${'y'.repeat(147)}`, rows: 2 })
    expect(lines.slice(-4).map((l) => l.text)).toEqual([PROMPT, `${' '.repeat(37)}> "w " + (1*7)`, 'w 7', PROMPT])
  }))
})
