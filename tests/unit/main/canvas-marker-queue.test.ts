/**
 * #580 — a canvas verdict must reach the agent even when it is filed mid-turn.
 *
 * The live failure: a clean APPROVAL on the Agent Canvas delivered NOTHING to
 * the session when it fired while the agent was working. It arrived fine when
 * the agent was idle. A clean approval creates no review record either (the
 * store refuses a round with no notes), so the marker line IS the delivery —
 * lose it and the approval never happened as far as the agent is concerned.
 *
 * The rule under test: hold a marker while the turn is open, flush it at the
 * boundary, in order, and never hold one for ever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }))

const { CanvasMarkerQueue, MARKER_FALLBACK_FLUSH_MS, MARKER_QUEUE_MAX } =
  await import('../../../src/main/canvas/canvas-marker-queue')

const SID = 'session-1'
const APPROVAL = 'Approved v7 on the canvas · canvas_version_verdict recorded'
const REVIEW = 'Review #3 — 5 notes · canvas_review R3'

let written: Array<{ sessionId: string; line: string }>
let timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>

function makeQueue() {
  return new CanvasMarkerQueue({
    write: (sessionId, line) => { written.push({ sessionId, line }) },
    setTimer: (fn, ms) => {
      const entry = { fn, ms, cancelled: false }
      timers.push(entry)
      return () => { entry.cancelled = true }
    },
  })
}

/** Run the newest live timer, the way the real clock eventually would. */
function fireFallback() {
  const live = timers.filter((t) => !t.cancelled)
  expect(live.length).toBeGreaterThan(0)
  live[live.length - 1].fn()
}

beforeEach(() => {
  written = []
  timers = []
})

describe('idle: the marker goes straight out', () => {
  it('writes immediately when no turn has ever opened', () => {
    const q = makeQueue()
    expect(q.deliver(SID, APPROVAL)).toBe('sent')
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
    expect(q.pendingCount(SID)).toBe(0)
  })

  it('writes immediately again once the turn has ended', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.noteHookEvent(SID, 'Stop')
    expect(q.deliver(SID, APPROVAL)).toBe('sent')
    expect(written).toHaveLength(1)
  })

  it('arms no fallback timer for a marker that went straight out', () => {
    const q = makeQueue()
    q.deliver(SID, APPROVAL)
    expect(timers).toHaveLength(0)
  })
})

describe('busy: nothing is lost', () => {
  it('holds the marker while the agent turn is open, then flushes it on Stop', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    expect(q.deliver(SID, APPROVAL)).toBe('queued')
    expect(written).toHaveLength(0)
    expect(q.pendingCount(SID)).toBe(1)

    q.noteHookEvent(SID, 'Stop')
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
    expect(q.pendingCount(SID)).toBe(0)
  })

  it('a tool call opens the turn too — not only a user prompt', () => {
    for (const opener of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart']) {
      written = []
      timers = []
      const q = makeQueue()
      q.noteHookEvent(SID, opener)
      expect(q.deliver(SID, APPROVAL)).toBe('queued')
      expect(written).toHaveLength(0)
    }
  })

  it('a Notification does NOT open a turn — Claude fires it when it WANTS input', () => {
    // A false "open" here would park every marker until some later turn ended,
    // which is the same bug wearing the opposite sign.
    const q = makeQueue()
    q.noteHookEvent(SID, 'Notification')
    expect(q.isTurnOpen(SID)).toBe(false)
    expect(q.deliver(SID, APPROVAL)).toBe('sent')
  })

  it('a SubagentStop does not close the MAIN turn', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.noteHookEvent(SID, 'SubagentStop')
    expect(q.isTurnOpen(SID)).toBe(true)
    expect(q.deliver(SID, APPROVAL)).toBe('queued')
    expect(written).toHaveLength(0)
  })

  it('ORDER IS PRESERVED — two rounds filed in one turn arrive as they were filed', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, 'Review #3 — 2 notes · canvas_review R3')
    q.deliver(SID, 'Review #4 — 1 notes · canvas_review R4')
    q.deliver(SID, APPROVAL)
    q.noteHookEvent(SID, 'Stop')
    expect(written.map((w) => w.line)).toEqual([
      'Review #3 — 2 notes · canvas_review R3',
      'Review #4 — 1 notes · canvas_review R4',
      APPROVAL,
    ])
  })

  it('holds across a whole turn of tool calls, not just the prompt', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, REVIEW)
    q.noteHookEvent(SID, 'PreToolUse')
    q.noteHookEvent(SID, 'PostToolUse')
    q.noteHookEvent(SID, 'PreToolUse')
    expect(written).toHaveLength(0)
    q.noteHookEvent(SID, 'Stop')
    expect(written.map((w) => w.line)).toEqual([REVIEW])
  })

  it('keeps sessions apart: one session`s turn never gates another`s marker', () => {
    const q = makeQueue()
    q.noteHookEvent('busy', 'UserPromptSubmit')
    expect(q.deliver('busy', APPROVAL)).toBe('queued')
    expect(q.deliver('idle', APPROVAL)).toBe('sent')
    expect(written).toEqual([{ sessionId: 'idle', line: APPROVAL }])
    q.noteHookEvent('busy', 'Stop')
    expect(written).toHaveLength(2)
    expect(written[1].sessionId).toBe('busy')
  })

  it('a Stop for a session that queued nothing writes nothing', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.noteHookEvent(SID, 'Stop')
    expect(written).toHaveLength(0)
  })
})

describe('a turn that never ends', () => {
  it('flushes anyway on the fallback — late beats lost', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    expect(timers[0].ms).toBe(MARKER_FALLBACK_FLUSH_MS)
    expect(written).toHaveLength(0)

    fireFallback()
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
    // ...and the turn is presumed over, so the next marker is immediate.
    expect(q.deliver(SID, REVIEW)).toBe('sent')
  })

  it('arms ONE fallback for a burst, not one per marker', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, 'a')
    q.deliver(SID, 'b')
    q.deliver(SID, 'c')
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(1)
  })

  it('cancels the fallback once a real Stop flushed the queue', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    q.noteHookEvent(SID, 'Stop')
    expect(timers.every((t) => t.cancelled)).toBe(true)
  })

  it('a fallback that fires after the queue already drained writes nothing twice', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    const armed = timers[0]
    q.noteHookEvent(SID, 'Stop')
    armed.fn() // a stale timer that the runtime fired anyway
    expect(written).toHaveLength(1)
  })
})

// -- The fallback measures hook SILENCE, not the marker's age ---------------
// (aicc_planning#81)
//
// The live failure: a verdict filed early in a long turn was typed into the
// session 120 s later while the agent was still working, its tool hooks still
// arriving, and the TUI swallowed it -- the exact loss the queue exists to
// prevent. The fallback was armed once, when the marker was queued, so it
// measured how old the marker was rather than how long the hook stream had been
// quiet, which is what its own comment says it measures.
//
// Driven on a fake clock through the queue's REAL timer (no injected setTimer),
// so the 120 s is the shipped constant and not a test's restatement of it.
//
// Mutation to prove these can fail: drop the re-arm from noteHookEvent
// (canvas-marker-queue.ts), or let armFallback keep its early return there.
describe('a long turn whose hooks keep firing (aicc_planning#81)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function realClockQueue() {
    return new CanvasMarkerQueue({ write: (sessionId, line) => { written.push({ sessionId, line }) } })
  }

  it('tool hooks every 60 s for five minutes cause no mid-turn flush', () => {
    const q = realClockQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    expect(q.deliver(SID, APPROVAL)).toBe('queued')
    for (let minute = 1; minute <= 5; minute++) {
      vi.advanceTimersByTime(60_000)
      q.noteHookEvent(SID, minute % 2 ? 'PreToolUse' : 'PostToolUse')
      expect(written, `nothing typed into the turn at minute ${minute}`).toEqual([])
    }
    expect(q.pendingCount(SID)).toBe(1)
    expect(q.isTurnOpen(SID)).toBe(true)
  })

  it('Stop still flushes at the end of that long turn, exactly once', () => {
    const q = realClockQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    for (let minute = 1; minute <= 5; minute++) {
      vi.advanceTimersByTime(60_000)
      q.noteHookEvent(SID, 'PostToolUse')
    }
    q.noteHookEvent(SID, 'Stop')
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
    // No stale fallback left to type it a second time.
    vi.advanceTimersByTime(10 * MARKER_FALLBACK_FLUSH_MS)
    expect(written).toHaveLength(1)
  })

  it('120 s of hook silence flushes, counted from the LAST hook', () => {
    const q = realClockQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    vi.advanceTimersByTime(90_000)
    q.noteHookEvent(SID, 'PreToolUse')
    vi.advanceTimersByTime(MARKER_FALLBACK_FLUSH_MS - 1)
    expect(written, 'one millisecond short of 120 s of silence').toEqual([])
    vi.advanceTimersByTime(1)
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
    // ...and the turn is presumed over, as before.
    expect(q.isTurnOpen(SID)).toBe(false)
  })

  it('a turn that goes silent with no further hook still flushes 120 s after the marker', () => {
    const q = realClockQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    vi.advanceTimersByTime(MARKER_FALLBACK_FLUSH_MS)
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
  })

  // The limit the user is told about. One tool call fires PreToolUse at its
  // start and PostToolUse at its end and nothing between, so a call that runs
  // longer than 120 s is silence to the queue and the marker goes out during
  // it. The known-issues entry for canvas verdicts (app-knowledge.ts) says so
  // in these terms; if this ever stops being true, change that copy with it.
  it('one tool call running longer than 120 s is silence too, and flushes during it (the stated limit)', () => {
    const q = realClockQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    vi.advanceTimersByTime(30_000)
    q.noteHookEvent(SID, 'PreToolUse')
    vi.advanceTimersByTime(MARKER_FALLBACK_FLUSH_MS - 1)
    expect(written, 'the tool call is still running, one millisecond short').toEqual([])
    vi.advanceTimersByTime(1)
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
    // The call's own PostToolUse, arriving later, sends nothing again.
    vi.advanceTimersByTime(60_000)
    q.noteHookEvent(SID, 'PostToolUse')
    vi.advanceTimersByTime(10 * MARKER_FALLBACK_FLUSH_MS)
    expect(written).toHaveLength(1)
  })

  it('every turn-opening hook re-arms it: UserPromptSubmit and SubagentStart as well as the tool hooks', () => {
    for (const opener of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart']) {
      written = []
      const q = realClockQueue()
      q.noteHookEvent(SID, 'UserPromptSubmit')
      q.deliver(SID, APPROVAL)
      vi.advanceTimersByTime(100_000)
      q.noteHookEvent(SID, opener)
      vi.advanceTimersByTime(100_000)
      expect(written, opener).toEqual([])
      q.forget(SID)
    }
  })

  it('a Notification or a SubagentStop is not turn activity and buys no extra time', () => {
    for (const event of ['Notification', 'SubagentStop']) {
      written = []
      const q = realClockQueue()
      q.noteHookEvent(SID, 'UserPromptSubmit')
      q.deliver(SID, APPROVAL)
      vi.advanceTimersByTime(100_000)
      q.noteHookEvent(SID, event)
      vi.advanceTimersByTime(MARKER_FALLBACK_FLUSH_MS - 100_000)
      expect(written, event).toEqual([{ sessionId: SID, line: APPROVAL }])
    }
  })
})

describe('re-arming keeps the timer bookkeeping exact (aicc_planning#81)', () => {
  it('leaves exactly one live timer however many hooks arrive', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    for (let i = 0; i < 20; i++) q.noteHookEvent(SID, i % 2 ? 'PreToolUse' : 'PostToolUse')
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(1)
  })

  it('arms nothing for hooks while nothing is held', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    for (let i = 0; i < 5; i++) q.noteHookEvent(SID, 'PreToolUse')
    expect(timers).toHaveLength(0)
  })

  it('a superseded timer that the runtime fires anyway writes nothing', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    const first = timers[0]
    q.noteHookEvent(SID, 'PreToolUse')
    expect(first.cancelled).toBe(true)
    first.fn()
    expect(written).toEqual([])
    expect(q.pendingCount(SID)).toBe(1)
  })
})

describe('restart and teardown', () => {
  it('SessionStart clears a stale turn and releases what was held', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    // The session restarts: the Stop for that turn is never coming.
    q.noteHookEvent(SID, 'SessionStart')
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
    expect(q.isTurnOpen(SID)).toBe(false)
  })

  it('forget drops a dead session`s queue and its timer', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    q.forget(SID)
    expect(timers.every((t) => t.cancelled)).toBe(true)
    fireFallbackIsGone()
    expect(written).toHaveLength(0)
    // A forgotten session starts clean — no stale "turn open".
    expect(q.deliver(SID, REVIEW)).toBe('sent')
  })

  it('forget tells each marker it still holds, held again or not, once, in order, with its canvas, and writes none of them', () => {
    const forgotten: Array<[string, string, string | undefined]> = []
    const q = new CanvasMarkerQueue({
      write: (sessionId, line) => { written.push({ sessionId, line }) },
      setTimer: (fn, ms) => {
        const entry = { fn, ms, cancelled: false }
        timers.push(entry)
        return () => { entry.cancelled = true }
      },
      forgotten: (sessionId, line, canvasId) => { forgotten.push([sessionId, line, canvasId]) },
    })
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.noteHookEvent('other', 'UserPromptSubmit')
    expect(q.deliver(SID, REVIEW, 'c2')).toBe('queued')
    expect(q.holdAgain(SID, APPROVAL, 'c1')).toBe(true)
    expect(q.deliver(SID, 'Review #4')).toBe('queued')
    expect(q.deliver('other', APPROVAL, 'c3')).toBe('queued')
    q.forget(SID)
    q.forget(SID)
    expect(forgotten).toEqual([[SID, APPROVAL, 'c1'], [SID, REVIEW, 'c2'], [SID, 'Review #4', undefined]])
    // Another session's markers are its own: still held, and not told.
    expect(q.pendingCount('other')).toBe(1)
    fireFallbackIsGone()
    q.noteHookEvent(SID, 'SessionStart')
    q.noteHookEvent(SID, 'Stop')
    expect(written.filter((w) => w.sessionId === SID)).toEqual([])
    expect(forgotten).toHaveLength(3)
  })

  it('a forgotten report that throws breaks nothing: the rest are still told, and the session is gone', () => {
    const forgotten: string[] = []
    const q = new CanvasMarkerQueue({
      write: (sessionId, line) => { written.push({ sessionId, line }) },
      setTimer: () => () => {},
      forgotten: (_s, line) => {
        forgotten.push(line)
        if (line === APPROVAL) throw new Error('window gone')
      },
    })
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL, 'c1')
    q.deliver(SID, REVIEW, 'c1')
    expect(() => q.forget(SID)).not.toThrow()
    expect(forgotten).toEqual([APPROVAL, REVIEW])
    expect(q.pendingCount(SID)).toBe(0)
    expect(q.isTurnOpen(SID)).toBe(false)
  })

  function fireFallbackIsGone() {
    for (const t of timers) if (!t.cancelled) t.fn()
  }
})

describe('the cap', () => {
  it('bounds a wedged session, keeping the NEWEST markers', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    for (let i = 0; i < MARKER_QUEUE_MAX + 3; i++) q.deliver(SID, `m${i}`)
    expect(q.pendingCount(SID)).toBe(MARKER_QUEUE_MAX)
    q.noteHookEvent(SID, 'Stop')
    expect(written).toHaveLength(MARKER_QUEUE_MAX)
    expect(written[0].line).toBe('m3')
    expect(written[written.length - 1].line).toBe(`m${MARKER_QUEUE_MAX + 2}`)
  })
})

// ── Repetition must not evict the thing this module exists to save ──────────
//
// Drop-oldest is right for a queue of DISTINCT verdicts, and it made the queue
// EVICTABLE BY REPETITION: a re-render loop, a double-click, or a panel effect
// that re-fires puts 32 copies of one line in front of the approval, and the
// approval is dropped — silently, into a warn line the user never sees. The
// markers are idempotent NOTIFICATIONS, so a repeat carries nothing the first
// copy did not.
//
// Mutation to prove these can fail: remove the `s.pending.includes(line)`
// collapse from CanvasMarkerQueue.deliver (canvas-marker-queue.ts).
describe('duplicate collapse', () => {
  it('collapses a repeated pending line instead of stacking copies', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    for (let i = 0; i < 100; i++) expect(q.deliver(SID, APPROVAL)).toBe('queued')
    expect(q.pendingCount(SID)).toBe(1)
    q.noteHookEvent(SID, 'Stop')
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
  })

  it('a FLOOD of one line can no longer evict the approval behind it', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    for (let i = 0; i < MARKER_QUEUE_MAX * 4; i++) q.deliver(SID, REVIEW)
    q.noteHookEvent(SID, 'Stop')
    // Both survive, in the order they were filed. Pre-fix the approval was
    // pushed out by copy 33 of the review.
    expect(written.map((w) => w.line)).toEqual([APPROVAL, REVIEW])
  })

  it('collapses only against PENDING — a genuinely distinct line still queues', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    q.deliver(SID, REVIEW)
    q.deliver(SID, APPROVAL)
    expect(q.pendingCount(SID)).toBe(2)
    q.noteHookEvent(SID, 'Stop')
    expect(written.map((w) => w.line)).toEqual([APPROVAL, REVIEW])
  })

  it('is a COLLAPSE, not a memory: the same verdict filed in a LATER turn goes out again', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    q.noteHookEvent(SID, 'Stop')
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    q.noteHookEvent(SID, 'Stop')
    expect(written.map((w) => w.line)).toEqual([APPROVAL, APPROVAL])
  })

  it('keeps the fallback armed, so a collapsed-only queue is still flushed if Stop never comes', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    q.deliver(SID, APPROVAL)
    expect(written).toHaveLength(0)
    fireFallback()
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
  })

  it('keeps sessions apart — one session`s pending line does not collapse another`s', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.noteHookEvent('session-2', 'UserPromptSubmit')
    q.deliver(SID, APPROVAL)
    q.deliver('session-2', APPROVAL)
    expect(q.pendingCount(SID)).toBe(1)
    expect(q.pendingCount('session-2')).toBe(1)
  })
})

describe('holdAgain: a marker handed on comes back while a turn reads open', () => {
  it('takes nothing while no turn reads open, and keeps nothing for it', () => {
    const q = makeQueue()
    expect(q.holdAgain(SID, APPROVAL)).toBe(false)
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.noteHookEvent(SID, 'Stop')
    expect(q.holdAgain(SID, APPROVAL)).toBe(false)
    expect(written).toEqual([])
    expect(q.pendingCount(SID)).toBe(0)
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(0)
  })

  it('held ahead of markers queued since, after any held again before it, and written in that order at Stop, each with its canvas', () => {
    const out: Array<[string, string | undefined]> = []
    const q = new CanvasMarkerQueue({ write: (_s, line, canvasId) => { out.push([line, canvasId]) }, setTimer: () => () => {} })
    q.noteHookEvent(SID, 'UserPromptSubmit')
    expect(q.deliver(SID, REVIEW, 'c2')).toBe('queued')
    expect(q.holdAgain(SID, APPROVAL, 'c1')).toBe(true)
    expect(q.holdAgain(SID, 'Approved v8 on the canvas', 'c1')).toBe(true)
    expect(q.deliver(SID, 'Review #4', 'c2')).toBe('queued')
    expect(out).toEqual([])
    q.noteHookEvent(SID, 'Stop')
    expect(out).toEqual([[APPROVAL, 'c1'], ['Approved v8 on the canvas', 'c1'], [REVIEW, 'c2'], ['Review #4', 'c2']])
  })

  it('waits under the same fallback bound: written when the hook stream goes silent', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    expect(q.holdAgain(SID, APPROVAL)).toBe(true)
    expect(timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([MARKER_FALLBACK_FLUSH_MS])
    fireFallback()
    expect(written).toEqual([{ sessionId: SID, line: APPROVAL }])
    expect(q.isTurnOpen(SID)).toBe(false)
  })

  it('a forgotten session takes nothing', () => {
    const q = makeQueue()
    q.noteHookEvent(SID, 'UserPromptSubmit')
    q.forget(SID)
    expect(q.holdAgain(SID, APPROVAL)).toBe(false)
    expect(q.pendingCount(SID)).toBe(0)
  })

  it('counts toward the cap: on a full queue it is still taken, the oldest held is dropped, and the rest keep their order', () => {
    const out: string[] = []
    const q = new CanvasMarkerQueue({ write: (_s, line) => { out.push(line) }, setTimer: () => () => {} })
    q.noteHookEvent(SID, 'UserPromptSubmit')
    expect(q.holdAgain(SID, APPROVAL)).toBe(true)
    for (let i = 0; i < MARKER_QUEUE_MAX - 1; i++) expect(q.deliver(SID, `Review #${i}`)).toBe('queued')
    expect(q.pendingCount(SID)).toBe(MARKER_QUEUE_MAX)
    expect(q.holdAgain(SID, 'Approved v8 on the canvas')).toBe(true)
    expect(q.pendingCount(SID)).toBe(MARKER_QUEUE_MAX)
    q.noteHookEvent(SID, 'Stop')
    expect(out).toEqual(['Approved v8 on the canvas', ...Array.from({ length: MARKER_QUEUE_MAX - 1 }, (_, i) => `Review #${i}`)])
  })
})

// ── The singleton around it ─────────────────────────────────────────────────
describe('canvas-marker-delivery', () => {
  it('is honest before boot wires it, and routes through the queue after', async () => {
    const mod = await import('../../../src/main/canvas/canvas-marker-delivery')
    mod._resetCanvasMarkerQueueForTest()

    // Nothing wired: say "unwired" rather than claiming a delivery.
    expect(mod.deliverCanvasMarker(SID, APPROVAL)).toBe('unwired')

    const out: string[] = []
    let emit: ((sessionId: string, event: string) => void) | null = null
    mod.startCanvasMarkerQueue({
      write: (_s, line) => { out.push(line) },
      subscribe: (cb) => { emit = cb },
    })

    expect(mod.deliverCanvasMarker(SID, APPROVAL)).toBe('sent')
    expect(out).toEqual([APPROVAL])

    emit!(SID, 'UserPromptSubmit')
    expect(mod.deliverCanvasMarker(SID, REVIEW)).toBe('queued')
    expect(out).toHaveLength(1)
    emit!(SID, 'Stop')
    expect(out).toEqual([APPROVAL, REVIEW])

    mod._resetCanvasMarkerQueueForTest()
  })

  it('a session that ends tells the canvas of each marker the queue still held, once (the session gone), whatever its write would answer', async () => {
    const mod = await import('../../../src/main/canvas/canvas-marker-delivery')
    mod._resetCanvasMarkerQueueForTest()
    const CLAUDE_SID = 'session-sync-write'
    const PROMPT_SID = 'session-answered-write'
    const out: string[] = []
    const told: Array<Record<string, unknown>> = []
    let emit: ((sessionId: string, event: string) => void) | null = null
    mod.startCanvasMarkerQueue({
      // One session's write answers nothing, the other's answers later (the
      // submit primitive's shape): the queue holds both alike.
      write: (sessionId, line) => {
        out.push(line)
        return sessionId === PROMPT_SID ? Promise.resolve({ delivered: true }) : undefined
      },
      subscribe: (cb) => { emit = cb },
      onUndelivered: (u) => { told.push({ ...u }) },
    })
    emit!(CLAUDE_SID, 'UserPromptSubmit')
    emit!(PROMPT_SID, 'UserPromptSubmit')
    expect(mod.deliverCanvasMarker(CLAUDE_SID, APPROVAL, 'c1')).toBe('queued')
    expect(mod.deliverCanvasMarker(CLAUDE_SID, REVIEW)).toBe('queued') // no canvas: a log line only
    expect(mod.deliverCanvasMarker(PROMPT_SID, REVIEW, 'c2')).toBe('queued')
    mod.forgetCanvasMarkers(CLAUDE_SID)
    mod.forgetCanvasMarkers(CLAUDE_SID)
    mod.forgetCanvasMarkers(PROMPT_SID)
    await Promise.resolve()
    expect(told).toEqual([
      { sessionId: CLAUDE_SID, canvasId: 'c1', line: APPROVAL, reason: 'session-gone' },
      { sessionId: PROMPT_SID, canvasId: 'c2', line: REVIEW, reason: 'session-gone' },
    ])
    emit!(CLAUDE_SID, 'SessionStart')
    emit!(PROMPT_SID, 'Stop')
    expect(out).toEqual([])
    expect(told).toHaveLength(2)
    mod._resetCanvasMarkerQueueForTest()
  })

  it('with NO hook stream every marker goes out immediately — the pre-#580 behaviour', async () => {
    const mod = await import('../../../src/main/canvas/canvas-marker-delivery')
    mod._resetCanvasMarkerQueueForTest()
    const out: string[] = []
    mod.startCanvasMarkerQueue({ write: (_s, line) => { out.push(line) } })
    expect(mod.deliverCanvasMarker(SID, APPROVAL)).toBe('sent')
    expect(mod.deliverCanvasMarker(SID, REVIEW)).toBe('sent')
    expect(out).toEqual([APPROVAL, REVIEW])
    mod._resetCanvasMarkerQueueForTest()
  })
})
