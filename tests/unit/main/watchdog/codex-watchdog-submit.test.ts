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
//
// Mutants this must catch: a Codex retry written raw with Enter; a retry that
// was not delivered and is not logged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  submits: [] as Array<{ sessionId: string; text: string; readyWaitMs: number }>,
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
vi.mock('../../../../src/main/providers', () => ({
  getProvider: (id: string) => {
    if (id !== 'codex') throw new Error(`no provider ${id}`)
    return { runScreen: h.runScreen }
  },
}))

const { WatchdogManager } = await import('../../../../src/main/watchdog/watchdog-manager')
const input = await import('../../../../src/main/session-input')
const screen = await import('../../../../src/main/providers/codex/session-screen')

/** The recording run screen: its submit answers h.submitAnswer. */
const recordingScreen = {
  open: () => {}, feed: () => {}, resize: () => {}, close: () => {},
  has: () => true,
  submit: async (sessionId: string, text: string, opts: { readyWaitMs: number }) => {
    h.submits.push({ sessionId, text, readyWaitMs: opts.readyWaitMs })
    return h.submitAnswer
  },
}
/** The real one, with no pane opened for any session. */
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
  isCodexSession: (sessionId) => sessionId === 'cx',
  isCodexAskSession: () => false,
})

const SQ = '\u25a0'
const P = '\u203a'
const DOT = '\u00b7'
const CLEAR = '\x1b[2J\x1b[H'
const FOOTER = `  gpt-6-astra low ${DOT} C:\\Users\\alex\\projects\\demo`
const render = (rows: string[]): string => CLEAR + rows.join('\r\n')
const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`
/** A limit cell whose reset has passed (a later day's format, in the past). */
const LIMIT = [`${SQ} You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try`, '  again at Jan 1st, 2026 3:05 PM.']
const limitScreen = (composer: string) => render(['', ...LIMIT, '', composer, '', FOOTER])
const EMPTY_COMPOSER = `${P} ${DIM('Ask Codex to do anything')}`

describe('WatchdogManager: a Codex session\'s retry, by the Codex composer rule', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-09-29T12:00:00Z'))
    h.submits = []
    h.submitAnswer = { delivered: true }
    h.runScreen = recordingScreen
    h.writes = []
    h.infos = []
    h.warns = []
  })
  afterEach(() => { vi.useRealTimers() })

  /** A Watchdog on the Codex session 'cx', its send wired as main/index.ts wires it. */
  function setup() {
    const mgr = new WatchdogManager({
      getWindow: () => null,
      isSessionAlive: () => true,
      send: (sessionId, text) => input.submitRetry(sessionId, text),
      now: () => Date.now(),
      getStalls: () => 0,
    })
    mgr.startWatchdog('cx', { provider: 'codex', ssh: false, shellOnly: false, cols: 140, rows: 20 })
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
})
