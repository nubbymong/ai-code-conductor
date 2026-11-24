// 2.1.3-beta.17 C6 (aicc_planning#415): the Codex image rule's driver
// (src/main/providers/codex/session-screen.ts, submitCodexImage) through
// main's own headless pane: a real @xterm/headless pane fed a fake Codex that
// draws "[Image #1]" for a bracketed paste of a path, as probe P11 saw Codex
// 0.157.1 do, echoes typed text after it, sends on Enter and clears on Ctrl+U.
//
//  - An image through the pane: the paste, the sentence, Enter, each once and
//    in that order; the turn carries the picture.
//  - One submission at a time per run: an image and a text submission
//    (submitCodexText) asked together go one after the other, never
//    interleaved.
//  - A session with no pane, or a run that ends: session gone, nothing typed.
//  - One log line, naming the image by its path's length only and where the
//    rule read the screen.
//
// Red on beta: session-screen.ts exports no submitCodexImage. Mutant this
// must catch: the image not chained with the run's other submissions.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../../src/main/config-manager', () => ({ readConfig: vi.fn(() => ({})) }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/hooks/index', () => ({ getGateway: () => null }))

const screen = await import('../../../src/main/providers/codex/session-screen')
const { TAKE_BACK_KEY } = await import('../../../src/main/providers/codex/composer-submit')
const { clampAnsiChunk } = await import('../../../src/main/watchdog/watchdog-manager')
const { logInfo } = await import('../../../src/main/debug-logger')

const P = '\u203a'
const DOT = '\u00b7'
const CLEAR = '\x1b[2J\x1b[H'
const DIM = (s: string): string => `\x1b[2m${s}\x1b[22m`
const FOOTER = `  gpt-5.5 medium ${DOT} C:\\dev\\demo`
const draw = (composer: string): string => CLEAR + ['  Tip: New Build faster with Codex.', '', composer, '', FOOTER].join('\r\n')
const READY = draw(`${P} ${DIM('Ask Codex to do anything')}`)
const SID = 'imgs1111imgs1111imgs1111'
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
const PATH = 'C:\\Users\\me\\AppData\\Local\\AI Code Conductor\\resources\\screenshots\\screenshot-2026-11-24-061500.jpg'
const SENTENCE = 'I just pasted an image - please view it.'

/** A fake Codex run: a bracketed paste of a path attaches it ("[Image #1]"),
 *  typed text follows it, Enter sends both, Ctrl+U clears both. */
function fakeCodex(sessionId: string) {
  const sent: string[] = []
  const turns: Array<{ text: string; images: string[] }> = []
  let current = true
  let image: string | null = null
  let text = ''
  const redraw = (): void => {
    const shown = `${image ? '[Image #1] ' : ''}${text}`
    screen.feedCodexScreen(sessionId, shown ? draw(`${P} ${shown}`) : READY)
  }
  screen.openCodexScreen(sessionId, {
    cols: 120,
    rows: 40,
    current: () => current,
    clamp: clampAnsiChunk,
    write: (data) => {
      sent.push(data)
      if (data === '\r') { if (image || text) turns.push({ text: `${image ? '[Image #1] ' : ''}${text}`, images: image ? [image] : [] }); image = null; text = '' }
      else if (data === TAKE_BACK_KEY) { image = null; text = '' }
      else if (data.startsWith(PASTE_START)) image = data.slice(PASTE_START.length, data.length - PASTE_END.length)
      else text += data
      setTimeout(redraw, 20)
    },
  })
  redraw()
  return { sent, turns, end: () => { current = false } }
}

afterEach(() => {
  screen._resetCodexScreensForTest()
  vi.mocked(logInfo).mockClear()
})

describe('an image through main\'s own pane', () => {
  it('the paste, the sentence, Enter, once each and in order; the turn carries the picture', async () => {
    const codex = fakeCodex(SID)
    await new Promise((r) => setTimeout(r, 30))
    expect(await screen.submitCodexImage(SID, PATH, SENTENCE, { readyWaitMs: 5_000 })).toEqual({ pasted: true })
    expect(codex.sent).toEqual([`${PASTE_START}${PATH}${PASTE_END}`, ` ${SENTENCE}`, '\r'])
    expect(codex.turns).toEqual([{ text: `[Image #1]  ${SENTENCE}`, images: [PATH] }])
  })

  it('one submission at a time per run: an image and a text asked together never interleave, in either order', async () => {
    const codex = fakeCodex(SID)
    await new Promise((r) => setTimeout(r, 30))
    const image = screen.submitCodexImage(SID, PATH, SENTENCE, { readyWaitMs: 5_000 })
    const text = screen.submitCodexText(SID, 'and this one', { readyWaitMs: 5_000 })
    expect(await image).toEqual({ pasted: true })
    expect(await text).toEqual({ delivered: true })
    expect(codex.sent).toEqual([`${PASTE_START}${PATH}${PASTE_END}`, ` ${SENTENCE}`, '\r', 'and this one', '\r'])
    expect(codex.turns.map((t) => t.images.length)).toEqual([1, 0])

    const other = 'imgs2222imgs2222imgs2222'
    const second = fakeCodex(other)
    await new Promise((r) => setTimeout(r, 30))
    const first = screen.submitCodexText(other, 'a note first', { readyWaitMs: 5_000 })
    const then = screen.submitCodexImage(other, PATH, SENTENCE, { readyWaitMs: 5_000 })
    expect(await first).toEqual({ delivered: true })
    expect(await then).toEqual({ pasted: true })
    expect(second.sent).toEqual(['a note first', '\r', `${PASTE_START}${PATH}${PASTE_END}`, ` ${SENTENCE}`, '\r'])
  })

  it('a session with no pane: session gone, nothing typed', async () => {
    expect(await screen.submitCodexImage('none00000000none0000', PATH, SENTENCE, { readyWaitMs: 1_000 })).toEqual({ pasted: false, reason: 'session-gone', left: false })
  })

  it('a run that has ended: session gone, nothing typed', async () => {
    const codex = fakeCodex(SID)
    codex.end()
    expect(await screen.submitCodexImage(SID, PATH, SENTENCE, { readyWaitMs: 5_000 })).toMatchObject({ pasted: false, reason: 'session-gone' })
    expect(codex.sent).toEqual([])
  })

  it('one log line, naming the image by its path\'s length only, and where the rule read the screen', async () => {
    fakeCodex(SID)
    await new Promise((r) => setTimeout(r, 30))
    await screen.submitCodexImage(SID, PATH, SENTENCE, { readyWaitMs: 5_000 })
    const lines = vi.mocked(logInfo).mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(`[codex-image] ${SID}:`))
    expect(lines).toEqual([`[codex-image] ${SID}: an image path of ${[...PATH].length} characters pasted and sent; the rule read main's own pane`])
    expect(vi.mocked(logInfo).mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('screenshot-')
  })
})
