// 2.1.3-beta.18 fix round, second pass (aicc_planning#431, PR #762 review):
// the Watchdog's retry into a Claude Code tab that runs through the session
// helper on its machine sends its Enter as its own write.
//
// The measured cause (first pass, image-transfer-helper.test.ts): Claude Code
// (2.1.332, its input tokenizer) makes a control character a key of its own
// only when the whole read it arrives in is shorter than 64 characters. A
// helper tab hands each write to the holder as one frame, and the holder
// writes each frame whole, so a retry line and its Enter in one write (63
// characters or more with the Enter's) reached Claude Code as one read: typed
// and not sent, and each later retry added to the same line. The retry
// message is the user's own, up to 200 characters (watchdog/config.ts).
//
// The fix: for a helper tab (remote-helper isRemoteHelperTab, handed to the
// member as RunScreenTyping.wholeWrites), the line, then Enter as its own
// write PROMPT_ENTER_DELAY_MS after the line's last slice, and only while the
// run is still the one the line went to, as a prompt button's Send goes. A
// tab on this computer, today's SSH tab and an SSH Persistent tab keep the
// one write, byte for byte (session-input.test.ts and
// session-input-ssh.test.ts hold those through the real PTY manager too).
//
// Over fake ports, the Claude Code package's own run screen behind the
// registry, and a stand-in for the remote helper's record of its tabs.
// Red on 7a2b8c8c: the helper tab got the line and its Enter in one write.
// Mutants this must catch: the Enter put back in the line's write for a
// helper tab; the Enter typed into a run started meanwhile; the split given
// to a tab that is not through the helper.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  /** The tabs the remote helper says it started. */
  helperTabs: new Set<string>(),
  /** The sessions wrapped in tmux on their host (SSH Persistent). */
  wrapped: new Set<string>(),
}))

vi.mock('../../../src/main/providers', async () => {
  const { CLAUDE_RUN_SCREEN } = await import('../../../src/main/providers/claude/run-screen')
  return { getProvider: () => ({ runScreen: CLAUDE_RUN_SCREEN }) }
})
vi.mock('../../../src/main/remote-helper', () => ({ isRemoteHelperTab: (sessionId: string) => h.helperTabs.has(sessionId) }))
vi.mock('../../../src/main/canvas/claude-marker-typing', () => ({ queueClaudeMarkerLine: () => {} }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }))

const input = await import('../../../src/main/session-input')
const { TMUX_WHEEL_EXIT_KEY } = await import('../../../src/shared/tmux-wheel')

class FakeRun {
  readonly writes: string[] = []
  write(data: string): void { this.writes.push(data) }
}
const runs = new Map<string, FakeRun>()

let n = 0
const fresh = (): string => `helperretry${++n}`
const startRun = (sessionId: string): FakeRun => { const r = new FakeRun(); runs.set(sessionId, r); return r }
/** A 100-character retry message: the user sets it, up to 200 characters. */
const LINE = 'Please carry on with the task you were working on before the error, from where you stopped. Thanks!!'

beforeAll(() => {
  input.setSessionInputPorts({
    write: (sessionId, data) => { runs.get(sessionId)?.write(data) },
    run: (sessionId) => runs.get(sessionId) as never,
    tmuxWrapped: (sessionId) => h.wrapped.has(sessionId),
    providerOf: () => 'claude',
    isAskSession: () => false,
  })
})
beforeEach(() => {
  h.helperTabs.clear()
  h.wrapped.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the Watchdog\'s retry into a Claude Code tab through the session helper: the Enter as its own write', () => {
  it('the line, then Enter as its own write PROMPT_ENTER_DELAY_MS later, and no answer', async () => {
    expect(LINE).toHaveLength(100)
    const id = fresh()
    h.helperTabs.add(id)
    const run = startRun(id)
    expect(input.submitRetry(id, LINE)).toBeUndefined()
    expect(run.writes).toEqual([LINE])
    await vi.advanceTimersByTimeAsync(input.PROMPT_ENTER_DELAY_MS - 1)
    expect(run.writes).toEqual([LINE])
    await vi.advanceTimersByTimeAsync(1)
    expect(run.writes).toEqual([LINE, '\r'])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.writes).toEqual([LINE, '\r'])
  })

  it('a short line too: nothing in a helper tab rides with its Enter', async () => {
    const id = fresh()
    h.helperTabs.add(id)
    const run = startRun(id)
    input.submitRetry(id, 'continue')
    await vi.advanceTimersByTimeAsync(input.PROMPT_ENTER_DELAY_MS)
    expect(run.writes).toEqual(['continue', '\r'])
  })

  it('no Enter when the tab started again while it waited, neither into the old run nor the new one', async () => {
    const id = fresh()
    h.helperTabs.add(id)
    const before = startRun(id)
    input.submitRetry(id, LINE)
    await vi.advanceTimersByTimeAsync(100)
    const after = startRun(id)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(before.writes).toEqual([LINE])
    expect(after.writes).toEqual([])
  })

  it('no Enter when the tab was closed while it waited', async () => {
    const id = fresh()
    h.helperTabs.add(id)
    const run = startRun(id)
    input.submitRetry(id, LINE)
    runs.delete(id)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.writes).toEqual([LINE])
  })
})

describe('every other Claude Code tab keeps the line and its Enter in one write, byte for byte', () => {
  it('a tab on this computer, or today\'s SSH tab (neither through the helper nor wrapped)', async () => {
    const id = fresh()
    const run = startRun(id)
    expect(input.submitRetry(id, LINE)).toBeUndefined()
    expect(run.writes).toEqual([`${LINE}\r`])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.writes).toEqual([`${LINE}\r`])
  })

  it('an SSH Persistent tab: the leave key, the line and Enter, in one write', async () => {
    const id = fresh()
    h.wrapped.add(id)
    const run = startRun(id)
    input.submitRetry(id, LINE)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.writes).toEqual([`${TMUX_WHEEL_EXIT_KEY}${LINE}\r`])
  })

  it('a tab the helper started for another session id does not split this one', async () => {
    const id = fresh()
    h.helperTabs.add(`${id}-other`)
    const run = startRun(id)
    input.submitRetry(id, LINE)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.writes).toEqual([`${LINE}\r`])
  })
})
