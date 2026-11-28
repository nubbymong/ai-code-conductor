// The clipboard paste door (ADR-032; plan 2.1.3-beta.21 phase 2, 2.1.3):
// session-input pasteFromClipboard and the Claude Code package's clipboard
// member, against fake ports, a fake clock and a fake reading of Claude
// Code's prompt (the renderer's 'read' answer: how many image placeholders it
// shows).
//  - The key goes as ONE write, never inside a bracketed paste, then the
//    placeholder: for a press from outside the terminal (and Snap) a space
//    and the sentence, then Enter as its own write; for a press in the
//    terminal nothing more.
//  - No placeholder within the wait: nothing typed after the key, nothing
//    taken back (no Ctrl+U), and the answer says so.
//  - No path in any write.
//  - A key that is not a paste key's shape (a bracketed paste, two keys,
//    Enter, Ctrl+C), or a sentence with a control character: refused,
//    nothing written. An SSH Persistent session, a provider with no member:
//    not taken, nothing written. No terminal: session-gone.
//  - Only into the run the press was taken for: one replaced meanwhile gets
//    nothing more.
//  - One at a time with the prompt buttons and images (the session's chain).
// Red on 0c54a1c6: no such door. Mutants this must catch: the key split over
// two writes; the key sent inside a bracketed paste; the sentence typed with
// no placeholder.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ infos: [] as string[], placeholders: new Map<string, number[]>(), asks: [] as Array<{ sessionId: string; mode: string }> }))

vi.mock('../../../src/main/canvas/claude-marker-typing', () => ({
  queueClaudeMarkerLine: vi.fn(),
  // The renderer's 'read': the next count queued for the session, else the last.
  askClaudePrompt: vi.fn(async (sessionId: string, mode: string) => {
    h.asks.push({ sessionId, mode })
    const q = h.placeholders.get(sessionId) ?? []
    const images = q.length > 1 ? q.shift()! : q[0]
    return images === undefined ? null : images < 0 ? { requestId: 'r', ok: false } : { requestId: 'r', ok: true, images }
  }),
}))
vi.mock('../../../src/main/providers', async () => {
  const { CLAUDE_RUN_SCREEN } = await import('../../../src/main/providers/claude/run-screen')
  return {
    getProvider: (id: string) => {
      if (id === 'claude') return { runScreen: CLAUDE_RUN_SCREEN }
      if (id === 'codex') return { runScreen: { open() {}, feed() {}, resize() {}, close() {}, has: () => false } }
      throw new Error('no such provider in this test')
    },
  }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: (msg: string) => { h.infos.push(msg) }, logWarn: () => {}, logError: () => {} }))

const input = await import('../../../src/main/session-input')
const { CLAUDE_PLACEHOLDER_POLL_MS } = await import('../../../src/main/providers/claude/run-screen')

class FakeRun {
  readonly writes: Array<{ at: number; data: string }> = []
  write(data: string): void { this.writes.push({ at: Date.now(), data }) }
}
const runs = new Map<string, FakeRun>()
const tmux = new Set<string>()
const codex = new Set<string>()
const ports = {
  write: (sessionId: string, data: string): void => { runs.get(sessionId)?.write(data) },
  run: (sessionId: string) => runs.get(sessionId) as never,
  tmuxWrapped: (sessionId: string) => tmux.has(sessionId),
  providerOf: (sessionId: string) => (codex.has(sessionId) ? 'codex' as const : 'claude' as const),
  isAskSession: () => false,
}
let n = 0
const fresh = (): string => `cl${++n}`
const startRun = (sessionId: string): FakeRun => { const r = new FakeRun(); runs.set(sessionId, r); return r }
const datas = (run: FakeRun): string[] => run.writes.map((w) => w.data)
const ESC_V = '\u001bv'
const SENTENCE = 'I just snapped a region of my screen, please view it.'

beforeAll(() => { input.setSessionInputPorts(ports) })
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  h.infos = []
  h.asks = []
  h.placeholders.clear()
})
afterEach(() => { vi.useRealTimers() })

/** Settle every timer the door and the member set. */
async function settle(result: Promise<unknown>): Promise<unknown> {
  let done = false
  let value: unknown
  void result.then((v) => { done = true; value = v })
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(50)
  expect(done, 'the paste settled').toBe(true)
  return value
}

describe('a Claude Code session on this computer', () => {
  it('a press from outside the terminal: the key in one write, the placeholder read, then the sentence, then Enter as its own write', async () => {
    const id = fresh()
    const run = startRun(id)
    h.placeholders.set(id, [0, 0, 1])
    const result = await settle(input.pasteFromClipboard(id, ESC_V, SENTENCE))
    expect(result).toEqual({ outcome: 'sent' })
    expect(datas(run)).toEqual([ESC_V, ` ${SENTENCE}`, '\r'])
    // The sentence only after the placeholder showed (two polls), the Enter after the sentence.
    expect(run.writes[1].at - run.writes[0].at).toBeGreaterThanOrEqual(2 * CLAUDE_PLACEHOLDER_POLL_MS)
    expect(run.writes[2].at - run.writes[1].at).toBeGreaterThanOrEqual(input.CLIPBOARD_ENTER_DELAY_MS)
    expect(h.asks.every((a) => a.mode === 'read')).toBe(true)
  })

  it('a press in the terminal: the key alone, once the placeholder shows; nothing more typed', async () => {
    const id = fresh()
    const run = startRun(id)
    h.placeholders.set(id, [2, 2, 3])
    expect(await settle(input.pasteFromClipboard(id, ESC_V, null))).toEqual({ outcome: 'placeholder' })
    expect(datas(run)).toEqual([ESC_V])
  })

  it('no placeholder within the wait: nothing typed after the key, nothing taken back', async () => {
    const id = fresh()
    const run = startRun(id)
    h.placeholders.set(id, [0])
    const started = Date.now()
    expect(await settle(input.pasteFromClipboard(id, ESC_V, SENTENCE))).toEqual({ outcome: 'no-placeholder' })
    expect(datas(run)).toEqual([ESC_V])
    expect(Date.now() - started).toBeGreaterThanOrEqual(input.CLIPBOARD_PLACEHOLDER_WAIT_MS)
    // A prompt that cannot be read counts as no placeholder too.
    const id2 = fresh()
    const run2 = startRun(id2)
    h.placeholders.set(id2, [-1])
    expect(await settle(input.pasteFromClipboard(id2, ESC_V, SENTENCE))).toEqual({ outcome: 'no-placeholder' })
    expect(datas(run2)).toEqual([ESC_V])
  })

  it('no path, no bracketed paste and no take-back in any write', async () => {
    const id = fresh()
    const run = startRun(id)
    h.placeholders.set(id, [0, 1])
    await settle(input.pasteFromClipboard(id, '\u0016', SENTENCE))
    for (const d of datas(run)) {
      expect(d).not.toContain('\u001b[200~')
      expect(d).not.toMatch(/[\\/]/)
      expect(d).not.toContain('\u0015')
    }
  })

  it('a run replaced after the key gets nothing more, and neither does the new one', async () => {
    const id = fresh()
    const run = startRun(id)
    h.placeholders.set(id, [0, 0, 0, 1])
    const p = input.pasteFromClipboard(id, ESC_V, SENTENCE)
    await vi.advanceTimersByTimeAsync(CLAUDE_PLACEHOLDER_POLL_MS + 10)
    const next = startRun(id)
    expect(await settle(p)).toEqual({ outcome: 'session-gone' })
    expect(datas(run)).toEqual([ESC_V])
    expect(datas(next)).toEqual([])
  })
})

describe('what the door refuses or does not take', () => {
  it.each([
    ['a bracketed paste of the key', '\u001b[200~\u001bv\u001b[201~'],
    ['two keys in one', '\u001bv\u001bv'],
    ['ESC alone', '\u001b'],
    ['the key split (its first half)', '\u001b'],
    ['Enter', '\r'],
    ['Ctrl+C', '\u0003'],
    ['Ctrl+D', '\u0004'],
    ['a new line', '\n'],
    ['plain text', 'v'],
    ['nothing', ''],
  ])('%s: refused, nothing written', async (_name, key) => {
    const id = fresh()
    const run = startRun(id)
    expect(await settle(input.pasteFromClipboard(id, key, SENTENCE))).toEqual({ outcome: 'refused-key' })
    expect(run.writes).toEqual([])
  })

  it('a sentence with a control character, or over its cap: refused', async () => {
    const id = fresh()
    const run = startRun(id)
    expect(await settle(input.pasteFromClipboard(id, ESC_V, 'look\r'))).toEqual({ outcome: 'refused-key' })
    expect(await settle(input.pasteFromClipboard(id, ESC_V, 'x'.repeat(input.IMAGE_SENTENCE_MAX_CHARS + 1)))).toEqual({ outcome: 'refused-key' })
    expect(run.writes).toEqual([])
  })

  it('the paste keys the tables make are taken: Ctrl and a letter, Alt and a letter, Ctrl and Alt and a letter', () => {
    for (const key of ['\u0016', '\u001bv', '\u001bV', '\u001b\u0016', '\u0019']) expect(input.isPasteKeyBytes(key), JSON.stringify(key)).toBe(true)
  })

  it('an SSH Persistent session, and a provider with no clipboard member: not taken, nothing written; no terminal: session-gone', async () => {
    const t = fresh()
    const tr = startRun(t)
    tmux.add(t)
    expect(await settle(input.pasteFromClipboard(t, ESC_V, SENTENCE))).toEqual({ outcome: 'not-taken' })
    expect(tr.writes).toEqual([])
    const c = fresh()
    const cr = startRun(c)
    codex.add(c)
    expect(await settle(input.pasteFromClipboard(c, ESC_V, SENTENCE))).toEqual({ outcome: 'not-taken' })
    expect(cr.writes).toEqual([])
    expect(await settle(input.pasteFromClipboard(fresh(), ESC_V, SENTENCE))).toEqual({ outcome: 'session-gone' })
  })

  it('one at a time with a prompt press: a paste asked while a press is in hand waits for its Enter', async () => {
    const id = fresh()
    const run = startRun(id)
    h.placeholders.set(id, [0, 1])
    const press = input.submitPrompt(id, 'explain this', 'send')
    const paste = input.pasteFromClipboard(id, ESC_V, null)
    await settle(Promise.all([press, paste]))
    expect(datas(run)).toEqual(['explain this', '\r', ESC_V])
  })

  it('the log names no key and no sentence', async () => {
    const id = fresh()
    startRun(id)
    h.placeholders.set(id, [0, 1])
    await settle(input.pasteFromClipboard(id, ESC_V, SENTENCE))
    const lines = h.infos.filter((l) => l.startsWith('[clipboard-paste]'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(`[clipboard-paste] ${id}: a press from outside the terminal: sent`)
  })
})
