// 2.1.3-beta.13 B2 (aicc_planning#370): main's Codex readers take the window
// title with the screen. While a reply streams Codex draws no busy row, only a
// braille spinner at the start of its title (probe P19's second run; the
// corpus, tests/unit/shared/screen-corpus.test.ts case 5). Before B2 the
// submit primitive read that screen as ready, typed the note into Codex's
// queue (its queue hint under the footer), could not confirm it, and took it
// back with Ctrl+U: the note was lost. Now it waits for the reply to end.
//
// Not checked here:
//  - the renderer's Codex commands and the Plan mode wait (tests/unit/renderer/codex-title-busy.test.ts);
//  - the reader's rule itself (tests/unit/shared/codex-screen-title.test.ts);
//  - the Watchdog pane keeping its title (tests/unit/main/watchdog/watchdog-manager.test.ts).
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../../src/main/config-manager', () => ({ readConfig: vi.fn(() => ({})) }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/hooks/index', () => ({ getGateway: () => null }))

const { submitToCodexComposer, TAKE_BACK_KEY } = await import('../../../src/main/providers/codex/composer-submit')
type ComposerSubmitDeps = import('../../../src/main/providers/codex/composer-submit').ComposerSubmitDeps
const screen = await import('../../../src/main/providers/codex/session-screen')
const { clampAnsiChunk } = await import('../../../src/main/watchdog/watchdog-manager')
const { codexCanSendNow, codexHasInputChrome } = await import('../../../src/main/watchdog/codex-patterns')
const { SessionWatchdog } = await import('../../../src/main/watchdog/session-watchdog')
const { CODEX_DETECTORS } = await import('../../../src/main/watchdog/detectors')
type ScreenLine = import('../../../src/shared/codex-screen').ScreenLine
type WatchdogAdapter = import('../../../src/main/watchdog/session-watchdog').WatchdogAdapter

const P = String.fromCharCode(0x203a)
const DOT = String.fromCharCode(0xb7)
const ENTER = '\r'
const plain = (text: string): ScreenLine => ({ text, typed: text })
const HEAD = [plain('  Tip: New Build faster with Codex.'), plain('')]
const FOOTER_TEXT = `  gpt-5.5 medium ${DOT} C:\\dev\\demo`
const EMPTY: ScreenLine = { text: `${P} Ask Codex to do anything`, typed: P }
/** A title with a frame of Codex's braille spinner. */
const SPIN = `${String.fromCharCode(0x280b)} work`
const NOTE = 'Review #3: 5 notes, canvas_review R3'

afterEach(() => { screen._resetCodexScreensForTest() })

/** A Codex whose reply streams until `replyUntil` (a fake clock): its title
 *  spins and it draws no busy row; a text typed meanwhile is queued, its
 *  queue hint under the footer, and Enter does not submit it. */
function replying(replyUntil: number) {
  let t = 0
  let composer = ''
  let pending: { text: string; at: number } | null = null
  const writes: Array<{ at: number; data: string }> = []
  const submitted: string[] = []
  const streaming = (): boolean => t < replyUntil
  const settle = (): void => { if (pending && t >= pending.at) { composer += pending.text; pending = null } }
  const deps: ComposerSubmitDeps = {
    readScreen: () => {
      settle()
      const hint = streaming() && composer !== '' ? [plain('  tab to queue message')] : []
      return [...HEAD, composer === '' ? EMPTY : plain(`${P} ${composer}`), plain(''), plain(FOOTER_TEXT), ...hint]
    },
    readTitle: () => (streaming() ? SPIN : 'work'),
    size: () => ({ cols: 100, rows: 30 }),
    write: (data) => {
      writes.push({ at: t, data })
      settle()
      if (data === ENTER) { if (!pending && composer !== '' && !streaming()) { submitted.push(composer); composer = '' } return }
      if (data === TAKE_BACK_KEY) { pending = null; composer = ''; return }
      pending = { text: data, at: t + 50 }
    },
    live: () => true,
    now: () => t,
    sleep: async (ms) => { t += Math.max(0, ms) },
  }
  return { deps, writes, submitted }
}

describe('the submit primitive while a reply streams (the title spins, no busy row)', () => {
  it('waits for the reply to end, then types and submits the note: nothing is taken back', async () => {
    const s = replying(8_000)
    const r = await submitToCodexComposer(NOTE, s.deps, { readyWaitMs: 20_000 })
    // Before B2: [NOTE, TAKE_BACK_KEY], typed into the queue mid-reply and
    // taken back, and not delivered.
    expect(s.writes.map((w) => w.data)).toEqual([NOTE, ENTER])
    expect(r).toEqual({ delivered: true })
    expect(s.writes[0].at).toBeGreaterThanOrEqual(8_000)
    expect(s.submitted).toEqual([NOTE])
  })

  it('a reply longer than the wait: busy-timeout, nothing typed, so nothing to take back', async () => {
    const s = replying(60_000)
    const r = await submitToCodexComposer(NOTE, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ delivered: false, reason: 'busy-timeout' })
    expect(s.writes).toEqual([])
  })
})

describe('main\'s Codex pane keeps the title its run sets', () => {
  const SID = 'ttlb1111ttlb1111ttlb1111'
  const CLEAR = '\x1b[2J\x1b[H'
  const DIM = (s: string): string => `\x1b[2m${s}\x1b[22m`
  const osc0 = (title: string): string => `\x1b]0;${title}\x07`
  const draw = (composer: string): string => CLEAR + ['  Tip: New Build faster with Codex.', '', composer, '', FOOTER_TEXT].join('\r\n')
  const READY = draw(`${P} ${DIM('Ask Codex to do anything')}`)

  /** A fake Codex run that echoes what it is sent into its composer. */
  function fakeCodex() {
    const sent: string[] = []
    const submitted: string[] = []
    let composer = ''
    const redraw = (): void => screen.feedCodexScreen(SID, composer ? draw(`${P} ${composer}`) : READY)
    screen.openCodexScreen(SID, {
      cols: 100, rows: 30, current: () => true, clamp: clampAnsiChunk,
      write: (data) => {
        sent.push(data)
        if (data === ENTER) { if (composer) submitted.push(composer); composer = '' }
        else if (data === TAKE_BACK_KEY) composer = ''
        else composer += data
        setTimeout(redraw, 20)
      },
    })
    redraw()
    return { sent, submitted }
  }

  it('reads the title with the screen: nothing is typed while it spins, the note once it stops; a new run starts with none', async () => {
    const c = fakeCodex()
    screen.feedCodexScreen(SID, osc0(SPIN))
    expect(await screen.settleCodexScreen(SID)).toBe(true)
    expect(screen.readCodexSessionTitle(SID)).toBe(SPIN)
    expect(await screen.submitCodexText(SID, NOTE, { readyWaitMs: 700 })).toEqual({ delivered: false, reason: 'busy-timeout' })
    expect(c.sent).toEqual([])

    screen.feedCodexScreen(SID, osc0('work'))
    expect(await screen.settleCodexScreen(SID)).toBe(true)
    expect(screen.readCodexSessionTitle(SID)).toBe('work')
    expect(await screen.submitCodexText(SID, NOTE, { readyWaitMs: 3_000 })).toEqual({ delivered: true })
    expect(c.submitted).toEqual([NOTE])

    fakeCodex()
    expect(screen.readCodexSessionTitle(SID)).toBeNull()
  }, 15_000)
})

describe('the Watchdog\'s send gate for a Codex pane reads the title too', () => {
  const ready = [...HEAD, EMPTY, plain(''), plain(FOOTER_TEXT)]
  const draft = [...HEAD, plain(`${P} my draft`), plain(''), plain(FOOTER_TEXT)]

  it('a spinner title defers it (a draft still reads as one); any other title or none leaves it as it was', () => {
    expect(codexCanSendNow('', undefined, ready, SPIN)).toEqual({ ok: false, reason: 'menu' })
    expect(codexCanSendNow('', undefined, draft, SPIN)).toEqual({ ok: false, reason: 'draft' })
    expect(codexHasInputChrome('', ready, SPIN)).toBe(false)
    for (const title of [undefined, null, 'work']) {
      expect(codexCanSendNow('', undefined, ready, title)).toEqual({ ok: true })
      expect(codexHasInputChrome('', ready, title)).toBe(true)
    }
    expect(CODEX_DETECTORS.canSendNow('', undefined, ready, SPIN)).toEqual({ ok: false, reason: 'menu' })
    expect(CODEX_DETECTORS.hasInputChrome('', ready, SPIN)).toBe(false)
  })

  it('a retry due while the title spins is deferred with no attempt spent, then typed once the reply ends', () => {
    const limit = [
      `${String.fromCharCode(0x25a0)} You've hit your usage limit. Upgrade to Pro, visit the usage page to`,
      '  purchase more credits or try again at 3:05 PM.',
    ]
    const rows = [...HEAD.map((l) => l.text), ...limit, '', EMPTY.text, '', FOOTER_TEXT]
    const lines = rows.map((text, i) => (i === HEAD.length + limit.length + 1 ? EMPTY : plain(text)))
    const clock = { now: new Date(2026, 8, 29, 14, 0, 0).getTime() }
    let title: string | null = SPIN
    const sent: string[] = []
    const adapter: WatchdogAdapter = {
      getTail: () => rows.join('\n'),
      getScreen: () => lines,
      getTitle: () => title,
      isSessionAlive: () => true,
      send: (t) => { sent.push(t) },
      now: () => clock.now,
      log: () => {},
      onStateChange: () => {},
      detectors: CODEX_DETECTORS,
    }
    const wd = new SessionWatchdog('cx', adapter, { rateLimitEnabled: true, retryMessage: 'continue', marginSeconds: 60 })
    wd.feed()
    expect(wd.getState().status).toBe('waiting')
    clock.now = wd.getState().waitUntil! + 1
    wd.tick()
    expect(sent).toEqual([])
    expect(wd.getState().attempts).toBe(0)
    title = 'work'
    clock.now = wd.getState().waitUntil! + 1
    wd.tick()
    expect(sent).toEqual(['continue'])
  })
})
