// The clipboard paste door into a tab through the session helper on its
// machine (plan 2.1.3-beta.21, block 5.1, its App bullet; ADR-032 decision 3
// and its Consequences: "Claude Code's placeholder is read from the holder's
// screen for a held session"): session-input pasteFromClipboard and the
// Claude Code package's clipboard member, against fake ports, a fake clock
// and a fake holder screen read (the remote helper's remoteTabScreen).
//  - The key in one write; the placeholder counted on the holder's screen
//    (Claude Code's prompt box read by shared/claude-screen.ts, its "[Image
//    #N]" counted), never through the renderer's terminal view; then, for a
//    press from outside the terminal, a space and the sentence, and Enter as
//    its own write (the helper Enter rule: the holder writes each write
//    whole); for a press in the terminal, nothing more.
//  - A holder screen that shows no prompt box (a question up): no count, so
//    no placeholder within the wait; nothing more typed.
//  - A tab whose connection reads no screen now: its terminal view is read,
//    as on this computer.
// Red on e89996bb: the member read the renderer's terminal view for every
// tab. Mutant this must catch: the renderer's view read for a helper tab.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  helperTabs: new Set<string>(),
  /** Each tab's holder screens, the next one per read, else the last. */
  screens: new Map<string, unknown[]>(),
  screenReads: 0,
  asks: [] as Array<{ sessionId: string; mode: string }>,
}))

vi.mock('../../../src/main/remote-helper', () => ({
  isRemoteHelperTab: (sessionId: string) => h.helperTabs.has(sessionId),
  remoteTabScreen: (sessionId: string) => {
    const q = h.screens.get(sessionId)
    if (!q) return undefined
    return async () => { h.screenReads++; return q.length > 1 ? q.shift() : q[0] }
  },
}))
vi.mock('../../../src/main/canvas/claude-marker-typing', () => ({
  queueClaudeMarkerLine: vi.fn(),
  askClaudePrompt: vi.fn(async (sessionId: string, mode: string) => {
    h.asks.push({ sessionId, mode })
    return { requestId: 'r', ok: true, images: 0 }
  }),
}))
vi.mock('../../../src/main/providers', async () => {
  const { CLAUDE_RUN_SCREEN } = await import('../../../src/main/providers/claude/run-screen')
  return { getProvider: (id: string) => { if (id === 'claude') return { runScreen: CLAUDE_RUN_SCREEN }; throw new Error('no such provider in this test') } }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }))

const input = await import('../../../src/main/session-input')

const RULE = String.fromCharCode(0x2500).repeat(40)
const POINTER = String.fromCharCode(0x276f)
const row = (text: string) => ({ text, typed: text, inverse: '', width: text.length, end: text.length })
/** The holder's screen with Claude Code at its prompt holding `images` pictures. */
const prompt = (images: number) => ({
  cols: 100, rows: 6, cut: false, title: '',
  lines: [row('Claude Code'), row(RULE), row(`${POINTER} ${Array.from({ length: images }, (_, i) => `[Image #${i + 1}]`).join(' ')}`.trimEnd()), row(RULE), row('  ? for shortcuts'), row('')],
})
/** A question up: no prompt box. */
const question = { cols: 100, rows: 4, cut: false, title: '', lines: [row('Do you want to proceed?'), row(`${POINTER} 1. Yes`), row('  2. No'), row('Esc to cancel')] }

class FakeRun { readonly writes: Array<{ at: number; data: string }> = []; write(data: string): void { this.writes.push({ at: Date.now(), data }) } }
const runs = new Map<string, FakeRun>()
const ports = {
  write: (sessionId: string, data: string): void => { runs.get(sessionId)?.write(data) },
  run: (sessionId: string) => runs.get(sessionId) as never,
  tmuxWrapped: () => false,
  providerOf: () => 'claude' as const,
  isAskSession: () => false,
}
let n = 0
const helperTab = (): { id: string; run: FakeRun } => { const id = `ht${++n}`; const run = new FakeRun(); runs.set(id, run); h.helperTabs.add(id); return { id, run } }
const datas = (run: FakeRun): string[] => run.writes.map((w) => w.data)
const CTRL_V = '\u0016'
const SENTENCE = 'I just pasted an image, please view it.'

beforeAll(() => { input.setSessionInputPorts(ports) })
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  h.screens.clear()
  h.screenReads = 0
  h.asks = []
})
afterEach(() => { vi.useRealTimers() })

async function settle(result: Promise<unknown>): Promise<unknown> {
  let done = false
  let value: unknown
  void result.then((v) => { done = true; value = v })
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(50)
  expect(done, 'the paste settled').toBe(true)
  return value
}

describe('a tab through the session helper on its machine', () => {
  it('a press from outside the terminal: the key, the placeholder read on the holder\'s screen, then the sentence and Enter as its own write', async () => {
    const { id, run } = helperTab()
    h.screens.set(id, [prompt(0), prompt(0), prompt(1)])
    const result = await settle(input.pasteFromClipboard(id, CTRL_V, SENTENCE))
    expect(result).toEqual({ outcome: 'sent' })
    expect(datas(run)).toEqual([CTRL_V, ` ${SENTENCE}`, '\r'])
    expect(h.screenReads).toBeGreaterThanOrEqual(3)
    // Never the renderer's view of the tab.
    expect(h.asks).toEqual([])
    expect(run.writes[2].at - run.writes[1].at).toBeGreaterThanOrEqual(input.CLIPBOARD_ENTER_DELAY_MS)
  })

  it('a press in the terminal: the key, the placeholder on the holder\'s screen, and nothing more', async () => {
    const { id, run } = helperTab()
    h.screens.set(id, [prompt(1), prompt(2)])
    expect(await settle(input.pasteFromClipboard(id, CTRL_V, null))).toEqual({ outcome: 'placeholder' })
    expect(datas(run)).toEqual([CTRL_V])
    expect(h.asks).toEqual([])
  })

  it('a holder screen with no prompt box (a question up): no placeholder within the wait, and nothing typed after the key', async () => {
    const { id, run } = helperTab()
    h.screens.set(id, [question])
    expect(await settle(input.pasteFromClipboard(id, CTRL_V, SENTENCE))).toEqual({ outcome: 'no-placeholder' })
    expect(datas(run)).toEqual([CTRL_V])
    expect(h.asks).toEqual([])
  })

  it('a tab whose connection reads no screen now: its terminal view is read, as on this computer', async () => {
    const { id, run } = helperTab()
    const result = await settle(input.pasteFromClipboard(id, CTRL_V, null))
    expect(result).toEqual({ outcome: 'no-placeholder' })
    expect(datas(run)).toEqual([CTRL_V])
    expect(h.asks.length).toBeGreaterThan(0)
    expect(h.asks.every((a) => a.sessionId === id && a.mode === 'read')).toBe(true)
  })
})
