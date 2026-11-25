// A Codex session's Watchdog retry is typed by the Codex composer rule
// (2.1.3-beta.10 section A2, aicc_planning #336): the one canvas notes and Ask
// Conductor use (providers/codex/composer-submit.ts), through the session
// input module's submitRetry, wired as main/index.ts wires it. The Watchdog
// still decides when to retry and what; only how the retry is typed moved.
// The real SessionWatchdog with its headless pane (it still reads the limit
// screen and gates the send), the real session input module over fake ports,
// and the Codex run screen's submit recorded: its rule is pinned by
// codex-composer-submit.test.ts and codex-session-screen.test.ts. The
// settings say the feature is on (it is off by default).
//
//  - The retry reaches the run screen's submit with the retry text and a 5 s
//    ready wait, and nothing is written raw. Red before A2: the Watchdog
//    typed the text through its own raw writer, then its own Enter or
//    Backspaces.
//  - An answer of not delivered is logged with its reason, and nothing more is
//    typed for it.
//  - A session with no pane (the real run screen, no pane opened) answers
//    session-gone, which is logged, and nothing is written.
//  - main/index.ts itself wires the Watchdog's send to submitRetry and hands
//    it no raw writer (read from its source: index.ts boots the app and
//    cannot be imported here).
//
// PR #746 review (each red on 8bbd33ad):
//  - The retry's 5 s ends 5 s after the Watchdog sends it (readyBy), and it
//    carries the Watchdog's incident check (stillWanted): yes while the
//    incident it was sent for is on; no, for good, once the limit clears, the
//    check is turned off, or the watcher is replaced.
//  - Through the REAL run screen's pane (session-screen.ts), with a fake Codex
//    behind it that both panes read, as the PTY manager feeds both:
//    the user typing beside the retry before it is confirmed keeps their
//    text (no Ctrl+U); an earlier submission for the run that recovers the
//    session while the retry waits behind it leaves the retry untyped, and
//    the Watchdog logs it as dropped; one that holds the run past the
//    retry's 5 s leaves it untyped though its incident is still on.
//
// Mutants this must catch: a Codex retry written raw with Enter, also at the
// real wiring in index.ts (send: a raw line and Enter, as the module's
// submitLine typed until 2.1.3-beta.18 section 4); a retry that was not delivered
// and is not logged; a take-back that clears the user's typing; a retry's
// wait counted from when its turn comes; an incident check dropped or not
// asked before typing.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  submits: [] as Array<{ sessionId: string; text: string; readyWaitMs: number }>,
  /** Each submit's options in full, and when it was asked for. */
  opts: [] as Array<{ at: number; readyBy?: number; stillWanted?: () => boolean }>,
  submitAnswer: { delivered: true } as Record<string, unknown>,
  /** The run screen getProvider('codex') hands out: the recording one by default. */
  runScreen: null as Record<string, unknown> | null,
  writes: [] as Array<[string, string]>,
  infos: [] as string[],
  warns: [] as string[],
}))

vi.mock('../../../../src/main/config-manager', () => ({
  readConfig: vi.fn(() => ({ watchdog: { enabled: true, retryMessage: 'continue', marginSeconds: 1 } })),
}))
vi.mock('../../../../src/main/debug-logger', () => ({
  logInfo: (m: string) => { h.infos.push(m) },
  logWarn: (m: string) => { h.warns.push(m) },
  logError: () => {},
}))
vi.mock('../../../../src/main/hooks/index', () => ({ getGateway: () => null }))
// Since 2.1.3-beta.18 section 4 the retry door types each session through its
// provider's run screen: Claude Code's own, and Codex's door members built
// here over whichever run screen a test hands out.
vi.mock('../../../../src/main/providers', async () => {
  const { CLAUDE_RUN_SCREEN } = await import('../../../../src/main/providers/claude/run-screen')
  const { codexDoorMembers } = await import('../../../../src/main/providers/codex/run-screen-doors')
  return {
    getProvider: (id: string) => {
      if (id === 'claude') return { runScreen: CLAUDE_RUN_SCREEN }
      if (id !== 'codex') throw new Error(`no provider ${id}`)
      return { runScreen: h.runScreen ? { ...h.runScreen, ...codexDoorMembers(h.runScreen as never) } : h.runScreen }
    },
  }
})

const { WatchdogManager, clampAnsiChunk } = await import('../../../../src/main/watchdog/watchdog-manager')
const input = await import('../../../../src/main/session-input')
const screen = await import('../../../../src/main/providers/codex/session-screen')
const { TAKE_BACK_KEY } = await import('../../../../src/main/providers/codex/composer-submit')

/** The recording run screen: its submit answers h.submitAnswer. */
const recordingScreen = {
  open: () => {}, feed: () => {}, resize: () => {}, close: () => {},
  has: () => true,
  submit: async (sessionId: string, text: string, opts: { readyWaitMs: number; readyBy?: number; stillWanted?: () => boolean }) => {
    h.submits.push({ sessionId, text, readyWaitMs: opts.readyWaitMs })
    h.opts.push({ at: Date.now(), readyBy: opts.readyBy, stillWanted: opts.stillWanted })
    return h.submitAnswer
  },
}
/** The real one, with no pane opened for any session (until a test opens one). */
const realScreen = {
  open: screen.openCodexScreen, feed: screen.feedCodexScreen, resize: screen.resizeCodexScreen,
  close: screen.closeCodexScreen, has: screen.hasCodexScreen, submit: screen.submitCodexText,
}

// The PTY manager's ports, faked: a raw write lands in h.writes, and 'cx' is
// a Codex session.
input.setSessionInputPorts({
  write: (sessionId, data) => { h.writes.push([sessionId, data]) },
  run: () => undefined,
  tmuxWrapped: () => false,
  providerOf: (sessionId) => (sessionId === 'cx' ? 'codex' : 'claude'),
  isAskSession: () => false,
})

const SQ = '\u25a0'
const P = '\u203a'
const DOT = '\u00b7'
const EM = '\u2014'
const CLEAR = '\x1b[2J\x1b[H'
const FOOTER = `  gpt-6-astra low ${DOT} C:\\Users\\alex\\projects\\demo`
const render = (rows: string[]): string => CLEAR + rows.join('\r\n')
const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`
/** A limit cell whose reset has passed (a later day's format, in the past). */
const LIMIT = [`${SQ} You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try`, '  again at Jan 1st, 2026 3:05 PM.']
const limitScreen = (composer: string) => render(['', ...LIMIT, '', composer, '', FOOTER])
const EMPTY_COMPOSER = `${P} ${DIM('Ask Codex to do anything')}`
const WORKING = '\u2022 Working (1s \u2022 esc to interrupt)'
const MARKER = `Review #3 ${EM} 5 notes ${DOT} canvas_review R3`
const SENT = '[watchdog:cx] Sending retry after rate limit reset (attempt 1).'

describe('WatchdogManager: a Codex session\'s retry, by the Codex composer rule', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-09-29T12:00:00Z'))
    h.submits = []
    h.opts = []
    h.submitAnswer = { delivered: true }
    h.runScreen = recordingScreen
    h.writes = []
    h.infos = []
    h.warns = []
  })
  afterEach(() => {
    screen._resetCodexScreensForTest()
    vi.useRealTimers()
  })

  /** A Watchdog on the Codex session 'cx', its send wired as main/index.ts wires it. */
  function manager() {
    const mgr = new WatchdogManager({
      getWindow: () => null,
      isSessionAlive: () => true,
      send: (sessionId, text, stillWanted) => input.submitRetry(sessionId, text, stillWanted),
      now: () => Date.now(),
      getStalls: () => 0,
    })
    mgr.startWatchdog('cx', { provider: 'codex', ssh: false, shellOnly: false, cols: 140, rows: 20 })
    return mgr
  }
  function setup() {
    const mgr = manager()
    mgr.feedData('cx', limitScreen(EMPTY_COMPOSER))
    return mgr
  }
  const run = (ms: number) => vi.advanceTimersByTimeAsync(ms)
  /** Until the shared tick (every 5 s) has sent the retry. */
  const untilSent = async () => { await run(300); await run(4_800) }

  it('reaches the run screen\'s submit with the retry text and a 5 s ready wait; nothing is written raw', async () => {
    const mgr = setup()
    await run(300)
    expect(mgr.getStates()[0].status).toBe('waiting')
    await run(4_800)
    expect(h.submits).toEqual([{ sessionId: 'cx', text: 'continue', readyWaitMs: 5_000 }])
    expect(h.writes).toEqual([])
    // The Watchdog's own decision to send is unchanged.
    expect(h.infos).toContain(SENT)
    // PR #746 review: the 5 s ends 5 s after the send, however long the run's
    // queue holds the retry.
    expect(h.opts[0].readyBy).toBe(h.opts[0].at + 5_000)
    // Nor later: no Enter, no Backspaces of the Watchdog's own.
    await run(10_000)
    expect(h.writes).toEqual([])
    expect(h.submits).toHaveLength(1)
    expect(h.warns).toEqual([])
  })

  it('a retry the rule did not deliver is logged with its reason, and nothing more is typed for it', async () => {
    h.submitAnswer = { delivered: false, reason: 'prompt-on-screen' }
    setup()
    await untilSent()
    expect(h.submits).toHaveLength(1)
    expect(h.warns).toContain('[watchdog:cx] the retry was not delivered (prompt-on-screen)')
    // Well inside the Watchdog's 30 s resend cooldown: nothing typed, nothing sent again.
    await run(20_000)
    expect(h.writes).toEqual([])
    expect(h.submits).toHaveLength(1)
  })

  it('a session with no pane: the run screen answers session-gone, it is logged, and nothing is written', async () => {
    h.runScreen = realScreen
    expect(screen.hasCodexScreen('cx')).toBe(false)
    setup()
    await untilSent()
    expect(h.warns).toContain('[watchdog:cx] the retry was not delivered (session-gone)')
    expect(h.writes).toEqual([])
  })

  it('main/index.ts wires the Watchdog\'s send to submitRetry and hands it no raw writer', () => {
    const index = readFileSync(resolve(__dirname, '../../../../src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const at = index.indexOf('initWatchdogManager({')
    expect(at).toBeGreaterThan(-1)
    const end = index.indexOf('\n    })', at)
    expect(end).toBeGreaterThan(at)
    const block = index.slice(at, end)
    expect(block).toContain('send: (sessionId, text, stillWanted) => submitRetry(sessionId, text, stillWanted)')
    expect(block).not.toMatch(/^\s*write\s*:/m)
    // Calls only (a comment in the block may name the removed submitLine).
    expect(block).not.toMatch(/\bsubmitLine\s*\(/)
  })

  describe('typed only while the incident it was sent for is on (PR #746 review)', () => {
    it('its check says yes while the limit is up, and no once the limit clears, for good: a new limit is a new incident', async () => {
      const mgr = setup()
      await untilSent()
      const wanted = h.opts[0].stillWanted
      expect(typeof wanted).toBe('function')
      expect(wanted!()).toBe(true)
      // The session recovered (a turn ran): the limit cell is gone.
      mgr.feedData('cx', render(['', '  Done.', '', EMPTY_COMPOSER, '', FOOTER]))
      await run(300)
      expect(mgr.getStates()[0].status).toBe('monitoring')
      expect(wanted!()).toBe(false)
      // A new limit: the Watchdog waits again, and the old retry stays unwanted.
      mgr.feedData('cx', limitScreen(EMPTY_COMPOSER))
      await run(300)
      expect(mgr.getStates()[0].status).toBe('waiting')
      expect(wanted!()).toBe(false)
    })

    it('no once the rate-limit check is turned off for the session', async () => {
      const mgr = setup()
      await untilSent()
      const wanted = h.opts[0].stillWanted
      expect(wanted!()).toBe(true)
      expect(mgr.setSessionChecks('cx', { rateLimit: false })).toBe(true)
      expect(wanted!()).toBe(false)
    })

    it('no once the watcher is replaced (a respawn reuses the session id)', async () => {
      const mgr = setup()
      await untilSent()
      const wanted = h.opts[0].stillWanted
      expect(wanted!()).toBe(true)
      mgr.startWatchdog('cx', { provider: 'codex', ssh: false, shellOnly: false, cols: 140, rows: 20 })
      expect(wanted!()).toBe(false)
    })
  })

  describe('through the real run screen\'s pane, a fake Codex behind it (PR #746 review)', () => {
    /** A fake Codex run behind the run screen's pane for 'cx', under the limit
     *  cell: it draws what it is typed into its composer `drawMs` later (null:
     *  never, PB9's held text; `drawn` says what lands, for the user typing
     *  beside it), submits on Enter and then runs a turn of `turnMs` (the
     *  limit cell gone from then on), clears on Ctrl+U. Every screen goes to
     *  the run screen's pane and to the Watchdog's. */
    function fakeCodex(mgr: InstanceType<typeof WatchdogManager>, opts: { drawMs?: (data: string) => number | null; drawn?: (data: string) => string; turnMs?: number } = {}) {
      const sent: string[] = []
      const submitted: string[] = []
      let composer = ''
      let limit = true
      let busy = false
      const draw = (): void => {
        const top = limit ? ['', ...LIMIT, ''] : ['', `  You asked: ${submitted[submitted.length - 1] ?? ''}`, '']
        const data = render([...top, ...(busy ? [WORKING] : []), composer ? `${P} ${composer}` : EMPTY_COMPOSER, '', FOOTER])
        screen.feedCodexScreen('cx', data)
        mgr.feedData('cx', data)
      }
      screen.openCodexScreen('cx', {
        cols: 140, rows: 20, current: () => true, clamp: clampAnsiChunk,
        write: (data) => {
          sent.push(data)
          if (data === '\r') {
            if (composer) {
              submitted.push(composer)
              composer = ''
              limit = false
              busy = true
              setTimeout(() => { busy = false; draw() }, opts.turnMs ?? 1_000)
            }
            setTimeout(draw, 20)
            return
          }
          if (data === TAKE_BACK_KEY) { composer = ''; setTimeout(draw, 20); return }
          const ms = opts.drawMs ? opts.drawMs(data) : 20
          if (ms === null) return
          setTimeout(() => { composer += opts.drawn ? opts.drawn(data) : data; draw() }, ms)
        },
      })
      draw()
      return { sent, submitted, get composer() { return composer } }
    }
    function setupReal(opts: Parameters<typeof fakeCodex>[1] = {}) {
      h.runScreen = realScreen
      const mgr = manager()
      return { mgr, codex: fakeCodex(mgr, opts) }
    }

    it('the user types beside the retry before it is confirmed: nothing taken back, their text stays (8bbd33ad cleared it with Ctrl+U)', async () => {
      const { codex } = setupReal({ drawn: (data) => (data === 'continue' ? 'continue and mine' : data) })
      await run(5_100)
      expect(h.infos).toContain(SENT)
      await run(15_000)
      expect(codex.sent).toEqual(['continue'])
      expect(codex.composer).toBe('continue and mine')
      expect(h.warns).toContain('[watchdog:cx] the retry was not delivered (not-drawn)')
      expect(h.writes).toEqual([])
    })

    it('an earlier submission for the run recovers the session while the retry waits behind it: the retry is dropped untyped (8bbd33ad typed it at the next empty composer)', async () => {
      const { mgr, codex } = setupReal({ drawMs: (data) => (data === MARKER ? 2_500 : 20), turnMs: 1_000 })
      await run(3_000)
      expect(h.infos).not.toContain(SENT)
      // A canvas marker for the run, as submitMarker sends it: typed at about
      // 3.3 s and drawn 2.5 s later (PB9: the composer looks empty meanwhile),
      // so the Watchdog's gate reads an empty composer at its 5 s tick.
      const marker = screen.submitCodexText('cx', MARKER, { readyWaitMs: 120_000 })
      await run(2_100)
      expect(h.infos).toContain(SENT)
      expect(codex.sent).toEqual([MARKER])
      // The marker is drawn and submitted; its turn clears the limit cell and
      // ends a second later at an empty composer.
      await run(15_000)
      await expect(marker).resolves.toEqual({ delivered: true })
      expect(codex.submitted).toEqual([MARKER])
      expect(codex.sent).toEqual([MARKER, '\r'])
      expect(mgr.getStates()[0].status).toBe('monitoring')
      expect(h.infos).toContain('[watchdog:cx] the retry was dropped untyped: the incident it was sent for is over')
      expect(h.writes).toEqual([])
    })

    it('an earlier submission holds the run past the retry\'s 5 s: the retry is not typed later, though its incident is still on (8bbd33ad began its 5 s only when its turn came)', async () => {
      const LONG = 'canvas review notes '.repeat(80).trim()
      const { mgr, codex } = setupReal({ drawMs: (data) => (data === LONG ? null : 20) })
      await run(4_000)
      expect(h.infos).not.toContain(SENT)
      // A folded marker Codex never draws (PB9's held text): typed at about
      // 4.3 s, it holds the run for its 6 s folded bound and its take-back,
      // past 10 s, the end of the retry's 5 s from its send at 5 s.
      const marker = screen.submitCodexText('cx', LONG, { readyWaitMs: 120_000 })
      await run(1_100)
      expect(h.infos).toContain(SENT)
      expect(codex.sent).toEqual([LONG])
      await run(15_000)
      await expect(marker).resolves.toEqual({ delivered: false, reason: 'not-drawn' })
      expect(codex.sent).toEqual([LONG, TAKE_BACK_KEY])
      expect(mgr.getStates()[0].status).toBe('waiting')
      expect(h.warns).toContain('[watchdog:cx] the retry was not delivered (busy-timeout)')
      expect(h.writes).toEqual([])
    })
  })
})
