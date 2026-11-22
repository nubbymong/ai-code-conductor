// 2.1.3-beta.14 B2 (aicc_planning#388): a held Codex session's composer rule
// reads the holder's screen (src/main/providers/codex/session-screen.ts).
// A run opened with `held` is decided at its first byte: a read of the
// holder's screen and no pane, or (no read: the terminal started the usual
// way, or its holder reads no screen) main's own pane, opened before that
// byte is fed. The rule (src/shared/codex-screen.ts, composer-submit.ts) is
// the same for both; only where its rows and title come from differs.
//
// The cases:
//  1. every Codex recording in helper/fixtures/screens, as the holder answers
//     it (the last screen and title committed in its .rows.json, which
//     helper/tests/screen.rs holds the holder's screen to; no title is ''),
//     gives the composer rule the same state as main's pane fed the
//     recording; and the title matters (a recording read without it moves);
//  2. a held run opens no pane: it reads nothing before its first byte, `has`
//     is true, its reads are the holder's, and the log says so;
//  3. no read at the first byte: the pane opens then, and holds that byte;
//  4. a read that fails, or a screen cut to its bottom rows, is no reading:
//     nothing is typed, and a text already typed is not taken back;
//  5. a submission through the holder: typed, confirmed on the holder's
//     screen, then Enter; a spinner title in the holder's answer holds it
//     back; each submission's log line names where the rule read the screen.
//
// Not checked here: whether a session's terminal is held and asks for the
// screen (tests/unit/main/session-helper-agent-screen.test.ts), the binding
// that hands `held` in (tests/unit/main/launch-bindings-held-screen.test.ts),
// the holder's own screen (helper/tests/screen.rs, run by the Helper job),
// and the rule itself (codex-composer-submit.test.ts, codex-title-busy.test.ts).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { Terminal } from '@xterm/headless'

vi.mock('../../../src/main/config-manager', () => ({ readConfig: vi.fn(() => ({})) }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/hooks/index', () => ({ getGateway: () => null }))

const screen = await import('../../../src/main/providers/codex/session-screen')
const { TAKE_BACK_KEY } = await import('../../../src/main/providers/codex/composer-submit')
const { clampAnsiChunk } = await import('../../../src/main/watchdog/watchdog-manager')
const { readCodexScreen, readXtermScreen, codexTitleBusy } = await import('../../../src/shared/codex-screen')
const { logInfo } = await import('../../../src/main/debug-logger')
type HeldScreenRows = import('../../../src/main/providers/types').HeldScreenRows
type ScreenLine = import('../../../src/shared/codex-screen').ScreenLine

const SID = 'held1111held1111held1111'
const PANE = 'pane2222pane2222pane2222'
const P = String.fromCharCode(0x203a)
const DOT = String.fromCharCode(0xb7)
const SPIN = `${String.fromCharCode(0x280b)} work`
const CLEAR = '\x1b[2J\x1b[H'
const DIM = (s: string): string => `\x1b[2m${s}\x1b[22m`
const FOOTER = `  gpt-5.5 medium ${DOT} C:\\dev\\demo`
const draw = (composer: string): string => CLEAR + ['  Tip: New Build faster with Codex.', '', composer, '', FOOTER].join('\r\n')
const READY = draw(`${P} ${DIM('Ask Codex to do anything')}`)
const NOTE = 'Review #3: 5 notes, canvas_review R3'

const infos = (): string[] => vi.mocked(logInfo).mock.calls.map((c) => String(c[0]))
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  screen._resetCodexScreensForTest()
  vi.mocked(logInfo).mockClear()
})

// ── 1. the corpus ───────────────────────────────────────────────────────────
const DIR = resolve(__dirname, '../../../helper/fixtures/screens')
const CODEX = readdirSync(DIR).filter((f) => /^codex(170)?-.+\.json$/.test(f) && !f.endsWith('.rows.json')).map((f) => f.slice(0, -'.json'.length)).sort()

interface RecEvent { text?: string; ev?: string; cols?: number; rows?: number }
interface Recording { cols: number; rows: number; events: RecEvent[] }
interface RowsFile { title: string | null; screens: Array<{ cols: number; rows: number; lines: ScreenLine[] }> }

/** A recording's holder answer: its committed last screen and title, as
 *  `screen.read` gives them on a connection that acked `title` ('' for none). */
function holderAnswer(name: string): HeldScreenRows {
  const r = JSON.parse(readFileSync(resolve(DIR, `${name}.rows.json`), 'utf-8')) as RowsFile
  const last = r.screens[r.screens.length - 1]
  return {
    cols: last.cols, rows: last.rows, cut: false, title: r.title ?? '',
    lines: last.lines.map((l) => ({ text: l.text, typed: l.typed, inverse: l.inverse ?? '', width: l.width ?? last.cols, end: l.end ?? 0 })),
  }
}

/** The state the composer rule reads, as composer-submit.ts reads it. */
const stateOf = (shot: { lines: ScreenLine[]; title: string | null } | null) => readCodexScreen(shot?.lines ?? null, null, { title: shot?.title ?? null })

describe('1. every Codex recording: the holder\'s answer gives the composer rule the pane\'s state', () => {
  it('holds Codex recordings, some ending with a spinner title (a vacuous pass is no pass)', () => {
    expect(CODEX.length).toBeGreaterThan(30)
    expect(CODEX.filter((n) => codexTitleBusy(holderAnswer(n).title)).length).toBeGreaterThan(0)
  })

  it.each(CODEX)('%s', async (name) => {
    const rec = JSON.parse(readFileSync(resolve(DIR, `${name}.json`), 'utf-8')) as Recording
    // Main's own pane, fed the recording as the PTY manager feeds it.
    screen.openCodexScreen(PANE, { cols: rec.cols, rows: rec.rows, write: () => {}, current: () => true, clamp: clampAnsiChunk })
    // The held run: its first chunk decides, and its reads are the holder's.
    const answer = holderAnswer(name)
    screen.openCodexScreen(SID, { cols: rec.cols, rows: rec.rows, write: () => {}, current: () => true, clamp: clampAnsiChunk, held: () => async () => answer })
    for (const e of rec.events) {
      if (typeof e.text === 'string') { screen.feedCodexScreen(PANE, e.text); screen.feedCodexScreen(SID, e.text) }
      else if (e.ev === 'resize') { screen.resizeCodexScreen(PANE, e.cols as number, e.rows as number); screen.resizeCodexScreen(SID, e.cols as number, e.rows as number) }
    }
    const pane = await screen.readCodexScreenOnce(PANE)
    const held = await screen.readCodexScreenOnce(SID)
    expect(pane).not.toBeNull()
    expect(held).not.toBeNull()
    expect(screen.readCodexSessionScreen(SID)).toBeNull()
    expect(held!.title).toBe(answer.title)
    expect(stateOf(held)).toEqual(stateOf(pane))
  }, 30_000)

  it('the title moves the state: a spinner recording read from its holder without the title reads otherwise', async () => {
    const name = CODEX.find((n) => codexTitleBusy(holderAnswer(n).title)) as string
    const answer = holderAnswer(name)
    screen.openCodexScreen(SID, { cols: answer.cols, rows: answer.rows, write: () => {}, current: () => true, clamp: clampAnsiChunk, held: () => async () => answer })
    screen.feedCodexScreen(SID, 'x')
    const held = await screen.readCodexScreenOnce(SID)
    expect(stateOf(held).screen).toBe('busy')
    expect(stateOf({ lines: held!.lines, title: null }).screen).not.toBe('busy')
  })
})

// ── 2 and 3. the first byte decides ─────────────────────────────────────────
/** A holder's answer for a screen drawn into a headless terminal. */
async function answerOf(term: Terminal, title = ''): Promise<HeldScreenRows> {
  await new Promise<void>((r) => term.write('', r))
  return { cols: term.cols, rows: term.rows, cut: false, title, lines: readXtermScreen(term) }
}

describe('2. a held run opens no pane', () => {
  it('reads nothing before its first byte, `has` is true, and from that byte its reads are the holder\'s; the log says so', async () => {
    const holder = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
    holder.write(READY)
    let reads = 0
    screen.openCodexScreen(SID, { cols: 100, rows: 30, write: () => {}, current: () => true, clamp: clampAnsiChunk, held: () => async () => { reads++; return answerOf(holder) } })
    expect(screen.hasCodexScreen(SID)).toBe(true)
    expect(await screen.readCodexScreenOnce(SID)).toBeNull()
    expect(reads).toBe(0)
    screen.feedCodexScreen(SID, READY)
    expect(screen.readCodexSessionScreen(SID)).toBeNull()
    expect(await screen.settleCodexScreen(SID)).toBe(false)
    const shot = await screen.readCodexScreenOnce(SID)
    expect(reads).toBe(1)
    expect(stateOf(shot)).toEqual({ screen: 'ready', text: '' })
    expect(shot!.title).toBe('')
    expect(infos()).toContain(`[codex-screen] ${SID}: held by the session helper, so its composer rule reads the holder's screen and no pane is opened`)
    expect(screen.hasCodexScreen(SID)).toBe(true)
    holder.dispose()
  })

  it('the decision is made once: a later byte does not ask again, and a resize opens no pane', async () => {
    let asked = 0
    screen.openCodexScreen(SID, { cols: 100, rows: 30, write: () => {}, current: () => true, clamp: clampAnsiChunk, held: () => { asked++; return async () => ({ cols: 100, rows: 30, cut: false, title: '', lines: Array.from({ length: 30 }, () => ({ text: '', typed: '' })) }) } })
    screen.feedCodexScreen(SID, 'one')
    screen.feedCodexScreen(SID, 'two')
    screen.resizeCodexScreen(SID, 80, 24)
    expect(asked).toBe(1)
    expect(screen.readCodexSessionScreen(SID)).toBeNull()
  })
})

describe('3. no holder read at the first byte: the pane, opened before that byte is fed', () => {
  it.each([
    ['the terminal started the usual way, or its holder reads no screen', () => undefined],
    ['asking threw', () => { throw new Error('gone') }],
  ])('%s', async (_why, held) => {
    screen.openCodexScreen(SID, { cols: 90, rows: 26, write: () => {}, current: () => true, clamp: clampAnsiChunk, held: held as () => undefined })
    screen.resizeCodexScreen(SID, 100, 30)
    screen.feedCodexScreen(SID, READY)
    expect(await screen.settleCodexScreen(SID)).toBe(true)
    const lines = screen.readCodexSessionScreen(SID)!
    // At the size the PTY manager gave last, with the first byte on it.
    expect(lines).toHaveLength(30)
    expect(lines[0].text).toBe('  Tip: New Build faster with Codex.')
    expect(stateOf(await screen.readCodexScreenOnce(SID))).toEqual({ screen: 'ready', text: '' })
    expect(infos()).toContain(`[codex-screen] ${SID}: not on a holder that reads its screen (started the usual way, or its holder reads none), so main's own pane is opened before its first byte`)
  })

  it('a run opened with no `held` has its pane at once, as before', () => {
    screen.openCodexScreen(PANE, { cols: 100, rows: 30, write: () => {}, current: () => true, clamp: clampAnsiChunk })
    expect(screen.readCodexSessionScreen(PANE)).toHaveLength(30)
    expect(infos()).toEqual([])
  })
})

// ── 4. no reading is never a ready one ──────────────────────────────────────
describe('4. a read that fails, or a cut screen, is no reading', () => {
  it.each([
    ['every read fails', (): Promise<HeldScreenRows> => Promise.reject(new Error('the connection closed'))],
    ['every screen comes back cut', async (): Promise<HeldScreenRows> => ({ ...(await readyAnswer()), cut: true })],
    ['the rows do not fill the screen', async (): Promise<HeldScreenRows> => { const a = await readyAnswer(); return { ...a, lines: a.lines.slice(1) } }],
  ])('%s: nothing is typed, and the answer is not delivered', async (_why, read) => {
    const sent: string[] = []
    screen.openCodexScreen(SID, { cols: 100, rows: 30, write: (d) => { sent.push(d) }, current: () => true, clamp: clampAnsiChunk, held: () => read })
    screen.feedCodexScreen(SID, READY)
    expect(await screen.readCodexScreenOnce(SID)).toBeNull()
    expect(await screen.submitCodexText(SID, NOTE, { readyWaitMs: 900 })).toEqual({ delivered: false, reason: 'busy-timeout' })
    expect(sent).toEqual([])
    expect(infos().some((l) => l.startsWith(`[codex-submit] ${SID}: not delivered (busy-timeout), ${NOTE.length} code points; the rule read the holder's screen, and `) && l.endsWith(' of its reads gave no screen'))).toBe(true)
  })

  it('a ready read, then reads that fail: never typed on the strength of the earlier one', async () => {
    const sent: string[] = []
    let n = 0
    const ready = await readyAnswer()
    screen.openCodexScreen(SID, { cols: 100, rows: 30, write: (d) => { sent.push(d) }, current: () => true, clamp: clampAnsiChunk, held: () => async () => { n++; if (n === 1) return ready; throw new Error('the connection closed') } })
    screen.feedCodexScreen(SID, READY)
    expect(await screen.submitCodexText(SID, NOTE, { readyWaitMs: 1_200 })).toEqual({ delivered: false, reason: 'busy-timeout' })
    expect(n).toBeGreaterThan(2)
    expect(sent).toEqual([])
  })

  it('reads that fail once the text is typed: no Enter, and nothing taken back', async () => {
    const sent: string[] = []
    let typed = false
    const ready = await readyAnswer()
    screen.openCodexScreen(SID, { cols: 100, rows: 30, write: (d) => { sent.push(d); typed = true }, current: () => true, clamp: clampAnsiChunk, held: () => async () => { if (typed) throw new Error('the connection closed'); return ready } })
    screen.feedCodexScreen(SID, READY)
    expect(await screen.submitCodexText(SID, NOTE, { readyWaitMs: 2_000 })).toEqual({ delivered: false, reason: 'not-drawn' })
    expect(sent).toEqual([NOTE])
  }, 15_000)
})

async function readyAnswer(): Promise<HeldScreenRows> {
  const t = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
  t.write(READY)
  const a = await answerOf(t)
  t.dispose()
  return a
}

// ── 5. a submission through the holder ──────────────────────────────────────
/** A fake held Codex: its holder's screen is a headless terminal it draws
 *  into; it echoes typed text into its composer, submits on Enter and clears
 *  on Ctrl+U. `title` is the title the holder answers with. */
function heldCodex(sessionId: string) {
  const sent: string[] = []
  const submitted: string[] = []
  let composer = ''
  const state = { title: '' }
  const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
  const redraw = (): void => { term.write(composer ? draw(`${P} ${composer}`) : READY) }
  screen.openCodexScreen(sessionId, {
    cols: 100, rows: 30, current: () => true, clamp: clampAnsiChunk,
    held: () => () => answerOf(term, state.title),
    write: (data) => {
      sent.push(data)
      if (data === '\r') { if (composer) submitted.push(composer); composer = '' }
      else if (data === TAKE_BACK_KEY) composer = ''
      else composer += data
      setTimeout(redraw, 20)
    },
  })
  redraw()
  // The run's first byte, as the PTY manager feeds it.
  screen.feedCodexScreen(sessionId, READY)
  return { sent, submitted, state, dispose: () => term.dispose() }
}

describe('5. a submission through the holder', () => {
  it('is typed, confirmed on the holder\'s screen, then Enter; the log line says the holder\'s screen', async () => {
    const codex = heldCodex(SID)
    expect(await screen.submitCodexText(SID, NOTE, { readyWaitMs: 5_000 })).toEqual({ delivered: true })
    expect(codex.sent).toEqual([NOTE, '\r'])
    expect(codex.submitted).toEqual([NOTE])
    expect(screen.readCodexSessionScreen(SID)).toBeNull()
    expect(infos()).toContain(`[codex-submit] ${SID}: delivered, ${NOTE.length} code points; the rule read the holder's screen`)
    codex.dispose()
  })

  it('a spinner title in the holder\'s answer holds it back; once it stops, the note goes', async () => {
    const codex = heldCodex(SID)
    codex.state.title = SPIN
    expect(await screen.submitCodexText(SID, NOTE, { readyWaitMs: 900 })).toEqual({ delivered: false, reason: 'busy-timeout' })
    expect(codex.sent).toEqual([])
    codex.state.title = 'work'
    expect(await screen.submitCodexText(SID, NOTE, { readyWaitMs: 5_000 })).toEqual({ delivered: true })
    expect(codex.submitted).toEqual([NOTE])
    codex.dispose()
  }, 15_000)

  it('a run that closes while its submission waits types nothing, and answers the session gone', async () => {
    const codex = heldCodex(SID)
    codex.state.title = SPIN
    const waiting = screen.submitCodexText(SID, NOTE, { readyWaitMs: 5_000 })
    await wait(300)
    screen.closeCodexScreen(SID)
    expect(await waiting).toEqual({ delivered: false, reason: 'session-gone' })
    expect(codex.sent).toEqual([])
    codex.dispose()
  })

  it('the pane\'s submission says the pane in its log line', async () => {
    const sent: string[] = []
    let composer = ''
    screen.openCodexScreen(PANE, {
      cols: 100, rows: 30, current: () => true, clamp: clampAnsiChunk,
      write: (d) => { sent.push(d); if (d === '\r') composer = ''; else composer += d; setTimeout(() => screen.feedCodexScreen(PANE, composer ? draw(`${P} ${composer}`) : READY), 20) },
    })
    screen.feedCodexScreen(PANE, READY)
    expect(await screen.submitCodexText(PANE, NOTE, { readyWaitMs: 5_000 })).toEqual({ delivered: true })
    expect(sent).toEqual([NOTE, '\r'])
    expect(infos()).toContain(`[codex-submit] ${PANE}: delivered, ${NOTE.length} code points; the rule read main's own pane`)
  })
})
