// [host] 2.1.3-beta.19 section 6.1 (aicc_planning#440): an Agent Canvas
// marker line into a Claude Code tab that runs through the session helper on
// its machine goes as the line, then its Enter as its own write.
//
// The cause (measured for the Watchdog's retry in beta.18's fix round,
// session-input-helper-tab-retry.test.ts): Claude Code (2.1.332) makes a
// control character a key of its own only when the whole read it arrives in
// is shorter than 64 characters, and a helper tab's holder hands Claude Code
// each write as one read. The renderer typed a marker's line and its Enter in
// one write (answerClaudeMarkerAsk, src/renderer/lib/claudePrompt.ts), and the
// Claude Code package's marker member did not read RunScreenTyping.wholeWrites,
// so a marker of 63 characters or more was typed and not sent there (none has
// reached that yet: an approval line is 59 to 61 characters, v1 to v999).
//
// The fix: for a helper tab the marker's requests say enterApart, the renderer
// types the line alone, and the package types Enter as its own write
// PROMPT_ENTER_DELAY_MS after the line's last slice went, only while the run
// is still the one the line went to. Every other tab keeps cc36c7f3's bytes:
// the line and its Enter in one write.
//
// Driven end to end over fake ports: the REAL session input module's
// submitMarker, the REAL Claude Code run screen behind the registry, the REAL
// chain that holds the marker (canvas/claude-marker-typing.ts) and the REAL
// renderer half (answerClaudeMarkerAsk reading src/shared/claude-screen.ts)
// over a fake IPC hop; a stand-in for the remote helper's record of its tabs.
// Red at cc36c7f3: the helper tab got the line and its Enter in one write.
// Mutants this must catch: the marker member ignoring wholeWrites; the
// renderer ignoring enterApart; the Enter typed into a run started meanwhile;
// the split given to a tab that is not through the helper.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type { ClaudeMarkerAsk } from '../../../src/shared/types'

const h = vi.hoisted(() => ({
  /** The tabs the remote helper says it started. */
  helperTabs: new Set<string>(),
  /** The sessions wrapped in tmux on their host (SSH Persistent). */
  wrapped: new Set<string>(),
  warns: [] as string[],
}))

vi.mock('../../../src/main/providers', async () => {
  const { CLAUDE_RUN_SCREEN } = await import('../../../src/main/providers/claude/run-screen')
  return { getProvider: () => ({ runScreen: CLAUDE_RUN_SCREEN }) }
})
vi.mock('../../../src/main/remote-helper', () => ({ isRemoteHelperTab: (sessionId: string) => h.helperTabs.has(sessionId) }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: (m: string) => { h.warns.push(m) }, logError: () => {}, logDebug: () => {} }))
// The renderer half's own reader and write path are the app's; here the
// screen is a fixture and the write is the port's (the pty:write handler's
// own call is writePty, the port's write).
vi.mock('../../../src/renderer/components/terminal/screenRegistry', () => ({ readSessionScreen: () => null }))
vi.mock('../../../src/renderer/components/terminal/tmuxWheelScroll', () => ({ writeSessionInput: () => {} }))

const input = await import('../../../src/main/session-input')
const typing = await import('../../../src/main/canvas/claude-marker-typing')
const { answerClaudeMarkerAsk } = await import('../../../src/renderer/lib/claudePrompt')
const { WRITE_CHUNK_DELAY } = await import('../../../src/main/pty-chunked-write')
const { CANVAS_MARKER_MAX_LINE } = await import('../../../src/shared/canvas-marker-line')
const S = await import('../shared/claude-screens')

class FakeRun {
  readonly writes: string[] = []
  write(data: string): void { this.writes.push(data) }
}
const runs = new Map<string, FakeRun>()
/** What the write port was handed for a session with no run. The app's port (writePty) holds such a write and replays it into the tab's next start. */
let orphanWrites: Array<[string, string]> = []

let n = 0
const fresh = (): string => `helpermarker${++n}`
const startRun = (sessionId: string): FakeRun => { const r = new FakeRun(); runs.set(sessionId, r); return r }

/** A 70-character marker line: an approval line is 59 to 61 characters
 *  today (versions v1 to v999; 60 to 62 with its Enter), and anything of 63
 *  or more reached Claude Code with its Enter as one read of 64 or more. */
const LINE = 'Approved v2 on the canvas · canvas_version_verdict recorded · round 2!'
const SHORT = 'Review #3 — 5 notes · canvas_review R3'
const CANVAS = 'c1c2c3c4c5c6c7c8c9c0d1d2'

/** Every request main sent the renderer, in order. */
let asks: ClaudeMarkerAsk[] = []
/** How many 'type' answers still to send late, after main stopped waiting. */
let lateTypeAnswers = 0

beforeAll(() => {
  input.setSessionInputPorts({
    write: (sessionId, data) => { const r = runs.get(sessionId); if (r) r.write(data); else orphanWrites.push([sessionId, data]) },
    run: (sessionId) => runs.get(sessionId) as never,
    tmuxWrapped: (sessionId) => h.wrapped.has(sessionId),
    providerOf: () => 'claude',
    isAskSession: () => false,
  })
})

beforeEach(() => {
  h.helperTabs.clear()
  h.wrapped.clear()
  h.warns = []
  orphanWrites = []
  asks = []
  lateTypeAnswers = 0
  typing._resetClaudeMarkerTypingForTest()
  vi.useFakeTimers()
  // The renderer: answers from the session's screen (the ready, empty
  // prompt), one IPC hop later, and types through the port's write.
  const settling = new Set<string>()
  const typedMarkers = new Set<string>()
  typing.setClaudeMarkerSender((ask) => {
    asks.push(ask)
    queueMicrotask(() => {
      const answer = answerClaudeMarkerAsk(ask, {
        readScreen: () => S.READY,
        write: (sessionId, data) => { runs.get(sessionId)?.write(data) },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        settling,
        typedMarkers,
      })
      if (!answer) return
      if (ask.mode === 'type' && lateTypeAnswers > 0) {
        lateTypeAnswers--
        setTimeout(() => typing.resolveClaudeMarkerAnswer(answer), typing.CLAUDE_MARKER_ANSWER_MS + 1_000)
        return
      }
      typing.resolveClaudeMarkerAnswer(answer)
    })
    return true
  })
})

afterEach(() => {
  typing._resetClaudeMarkerTypingForTest()
  vi.useRealTimers()
})

/** The probe, the second-read wait, then the type: the line is typed this
 *  long after the marker is handed in. */
const TYPED_AFTER_MS = typing.CLAUDE_MARKER_SECOND_READ_MS

describe('a canvas marker into a Claude Code tab through the session helper: the Enter as its own write', () => {
  it('a 70-character line: two writes, the line, then Enter PROMPT_ENTER_DELAY_MS later, and nothing more', async () => {
    expect(LINE).toHaveLength(70)
    const id = fresh()
    h.helperTabs.add(id)
    const run = startRun(id)
    expect(input.submitMarker(id, LINE, CANVAS)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(TYPED_AFTER_MS)
    expect(run.writes).toEqual([LINE])
    await vi.advanceTimersByTimeAsync(input.PROMPT_ENTER_DELAY_MS - 1)
    expect(run.writes).toEqual([LINE])
    await vi.advanceTimersByTimeAsync(1)
    expect(run.writes).toEqual([LINE, '\r'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.writes).toEqual([LINE, '\r'])
    // Every request for the marker said so, and the renderer typed no Enter.
    expect(asks.map((a) => a.mode)).toEqual(['probe', 'type'])
    expect(asks.every((a) => a.enterApart === true)).toBe(true)
    expect(h.warns).toEqual([])
  })

  it('a short line too: nothing in a helper tab rides with its Enter', async () => {
    const id = fresh()
    h.helperTabs.add(id)
    const run = startRun(id)
    input.submitMarker(id, SHORT, CANVAS)
    await vi.advanceTimersByTimeAsync(TYPED_AFTER_MS + input.PROMPT_ENTER_DELAY_MS)
    expect(run.writes).toEqual([SHORT, '\r'])
  })

  it('the longest line a marker may be: its Enter waits for the line\'s last slice too', async () => {
    const long = 'x'.repeat(CANVAS_MARKER_MAX_LINE)
    const id = fresh()
    h.helperTabs.add(id)
    const run = startRun(id)
    input.submitMarker(id, long, CANVAS)
    await vi.advanceTimersByTimeAsync(TYPED_AFTER_MS + input.PROMPT_ENTER_DELAY_MS)
    // Two slices of the write port's 256: one more slice's delay to go.
    expect(run.writes).toEqual([long])
    await vi.advanceTimersByTimeAsync(WRITE_CHUNK_DELAY)
    expect(run.writes).toEqual([long, '\r'])
  })

  it('no Enter when the tab started again while it waited, neither into the old run nor the new one', async () => {
    const id = fresh()
    h.helperTabs.add(id)
    const before = startRun(id)
    input.submitMarker(id, LINE, CANVAS)
    await vi.advanceTimersByTimeAsync(TYPED_AFTER_MS + 100)
    expect(before.writes).toEqual([LINE])
    const after = startRun(id)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(before.writes).toEqual([LINE])
    expect(after.writes).toEqual([])
    expect(h.warns.some((w) => w.includes('its Enter was not'))).toBe(true)
  })

  it('no Enter when the tab was closed while it waited', async () => {
    const id = fresh()
    h.helperTabs.add(id)
    const run = startRun(id)
    input.submitMarker(id, LINE, CANVAS)
    await vi.advanceTimersByTimeAsync(TYPED_AFTER_MS + 100)
    runs.delete(id)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.writes).toEqual([LINE])
    // Nothing was handed to the write port for the closed tab either: the app's port would hold it and replay it into the tab's next start.
    expect(orphanWrites).toEqual([])
    expect(h.warns.some((w) => w.includes('its Enter was not'))).toBe(true)
  })

  it('a type answer that came late: the line once, and one Enter once main reads it typed', async () => {
    const id = fresh()
    h.helperTabs.add(id)
    const run = startRun(id)
    lateTypeAnswers = 1
    input.submitMarker(id, LINE, CANVAS)
    await vi.advanceTimersByTimeAsync(TYPED_AFTER_MS)
    expect(run.writes).toEqual([LINE])
    // Main stops waiting for the answer, reads the marker typed on its next
    // probe and type, and only then types its Enter.
    await vi.advanceTimersByTimeAsync(typing.CLAUDE_MARKER_ANSWER_MS + typing.CLAUDE_MARKER_POLL_MS + typing.CLAUDE_MARKER_SECOND_READ_MS + input.PROMPT_ENTER_DELAY_MS + 10_000)
    expect(run.writes).toEqual([LINE, '\r'])
  })

  it('two markers: each line, then its Enter, in the order handed in', async () => {
    const id = fresh()
    h.helperTabs.add(id)
    const run = startRun(id)
    input.submitMarker(id, LINE, CANVAS)
    input.submitMarker(id, SHORT, CANVAS)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(run.writes).toEqual([LINE, '\r', SHORT, '\r'])
  })
})

describe('every other Claude Code tab keeps the marker\'s line and its Enter in one write, byte for byte', () => {
  it('a tab on this computer, or today\'s SSH tab (neither through the helper nor wrapped)', async () => {
    const id = fresh()
    const run = startRun(id)
    expect(input.submitMarker(id, LINE, CANVAS)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(TYPED_AFTER_MS)
    expect(run.writes).toEqual([`${LINE}\r`])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.writes).toEqual([`${LINE}\r`])
    // The requests are cc36c7f3's, field for field.
    expect(asks.map((a) => Object.keys(a).sort())).toEqual([
      ['line', 'markerId', 'mode', 'requestId', 'sessionId'],
      ['line', 'markerId', 'mode', 'requestId', 'sessionId'],
    ])
  })

  it('an SSH Persistent tab: the line and Enter, in one write (the renderer leaves copy-mode itself)', async () => {
    const id = fresh()
    h.wrapped.add(id)
    const run = startRun(id)
    input.submitMarker(id, LINE, CANVAS)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.writes).toEqual([`${LINE}\r`])
    expect(asks.some((a) => 'enterApart' in a)).toBe(false)
  })

  it('a tab the helper started for another session id does not split this one', async () => {
    const id = fresh()
    h.helperTabs.add(`${id}-other`)
    const run = startRun(id)
    input.submitMarker(id, LINE, CANVAS)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.writes).toEqual([`${LINE}\r`])
  })
})
