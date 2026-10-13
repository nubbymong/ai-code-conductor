// [host] The rule that holds a canvas marker for a Claude
// Code session until its prompt reads ready and empty
// (src/main/canvas/claude-marker-typing.ts), and the id-correlated request to
// the renderer it reads the prompt through. Pure: the renderer, the clock and
// the run's liveness are fakes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ClaudeMarkerAnswer, ClaudeMarkerAsk, ClaudeMarkerMode } from '../../../src/shared/types'
import { CLAUDE_MARKER_REFUSED } from '../../../src/shared/canvas-marker-line'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))

const T = await import('../../../src/main/canvas/claude-marker-typing')

beforeEach(() => {
  T._resetClaudeMarkerTypingForTest()
})
afterEach(() => {
  vi.useRealTimers()
  T._resetClaudeMarkerTypingForTest()
})

/** A renderer that answers each mode from a script, recording what it was asked. */
function scripted(answers: Array<[ClaudeMarkerMode, boolean]>) {
  const asked: ClaudeMarkerMode[] = []
  const ask = async (mode: ClaudeMarkerMode): Promise<ClaudeMarkerAnswer | null> => {
    asked.push(mode)
    const next = answers.shift()
    if (!next) return { requestId: 'r', ok: false, reason: 'script ended' }
    expect(next[0]).toBe(mode)
    return { requestId: 'r', ok: next[1], ...(next[1] ? {} : { reason: 'not ready' }) }
  }
  return { asked, ask }
}

describe('typeClaudeMarkerWhenReady', () => {
  it('asks to type only after a probe reads ready and the second-read wait, and stops once typed', async () => {
    const r = scripted([['probe', false], ['probe', false], ['probe', true], ['type', true]])
    const slept: number[] = []
    const result = await T.typeClaudeMarkerWhenReady({ ask: r.ask, live: () => true, sleep: async (ms) => { slept.push(ms) } })
    expect(result).toBe('typed')
    expect(r.asked).toEqual(['probe', 'probe', 'probe', 'type'])
    expect(slept).toEqual([T.CLAUDE_MARKER_POLL_MS, T.CLAUDE_MARKER_POLL_MS, T.CLAUDE_MARKER_SECOND_READ_MS])
  })

  it('a type the renderer refuses (the screen changed) goes back to reading, typing nothing more', async () => {
    const r = scripted([['probe', true], ['type', false], ['probe', false], ['probe', true], ['type', true]])
    const result = await T.typeClaudeMarkerWhenReady({ ask: r.ask, live: () => true, sleep: async () => {} })
    expect(result).toBe('typed')
    expect(r.asked).toEqual(['probe', 'type', 'probe', 'probe', 'type'])
  })

  it('no answer (no window, a timeout, a throw) is not ready', async () => {
    const asked: ClaudeMarkerMode[] = []
    let n = 0
    const result = await T.typeClaudeMarkerWhenReady({
      ask: async (mode) => {
        asked.push(mode)
        n++
        if (n === 1) return null
        if (n === 2) throw new Error('window gone')
        if (n === 3) return { requestId: 'r', ok: 'true' as unknown as boolean }
        return { requestId: 'r', ok: true }
      },
      live: () => true,
      sleep: async () => {},
    })
    expect(result).toBe('typed')
    expect(asked).toEqual(['probe', 'probe', 'probe', 'probe', 'type'])
  })

  it('a run that ends while held: gone, and no type is asked after it ended', async () => {
    let alive = true
    const asked: ClaudeMarkerMode[] = []
    const result = await T.typeClaudeMarkerWhenReady({
      ask: async (mode) => { asked.push(mode); return { requestId: 'r', ok: true } },
      live: () => alive,
      sleep: async (ms) => { if (ms === T.CLAUDE_MARKER_SECOND_READ_MS) alive = false },
    })
    expect(result).toBe('gone')
    expect(asked).toEqual(['probe'])
  })

  it('a request the renderer refuses as not well formed is dropped, not asked again', async () => {
    for (const refusedAt of ['probe', 'type'] as const) {
      const asked: ClaudeMarkerMode[] = []
      let checks = 0
      const result = await T.typeClaudeMarkerWhenReady({
        ask: async (mode) => {
          asked.push(mode)
          if (mode === refusedAt) return { requestId: 'r', ok: false, reason: CLAUDE_MARKER_REFUSED }
          return { requestId: 'r', ok: true }
        },
        // Bounded, so a loop that keeps asking ends as 'gone' and fails.
        live: () => ++checks < 40,
        sleep: async () => {},
      })
      expect(result).toBe('refused')
      expect(asked).toEqual(refusedAt === 'probe' ? ['probe'] : ['probe', 'type'])
    }
  })

  /** A clock that each sleep moves on by what it slept. */
  function clock(start = 1_000_000) {
    const c = { t: start, now: () => c.t, sleep: async (ms: number) => { c.t += ms } }
    return c
  }

  it('a prompt that never reads ready and empty: timeout once the hold bound has passed, and no type is ever asked', async () => {
    const c = clock()
    const asked: ClaudeMarkerMode[] = []
    let checks = 0
    const result = await T.typeClaudeMarkerWhenReady({
      ask: async (mode) => { asked.push(mode); return { requestId: 'r', ok: false, reason: 'a question is on screen' } },
      // Bounded far past the bound's polls, so a hold with no bound ends as 'gone' and fails.
      live: () => ++checks < 2_000,
      sleep: c.sleep,
      now: c.now,
    })
    expect(result).toBe('timeout')
    expect(asked.every((m) => m === 'probe')).toBe(true)
    // Held for the whole bound, and not a poll longer.
    expect(c.t - 1_000_000).toBeGreaterThanOrEqual(T.CLAUDE_MARKER_HOLD_MS)
    expect(c.t - 1_000_000).toBeLessThan(T.CLAUDE_MARKER_HOLD_MS + T.CLAUDE_MARKER_POLL_MS)
  })

  it('the hold bound is the marker queue\'s own fallback bound, two minutes', async () => {
    const Q = await import('../../../src/main/canvas/canvas-marker-queue')
    expect(T.CLAUDE_MARKER_HOLD_MS).toBe(Q.MARKER_FALLBACK_FLUSH_MS)
    expect(T.CLAUDE_MARKER_HOLD_MS).toBe(120_000)
  })

  it('a prompt that reads ready inside the bound: typed, however close to it', async () => {
    const c = clock()
    let checks = 0
    const result = await T.typeClaudeMarkerWhenReady({
      ask: async (mode) => (c.t - 1_000_000 >= T.CLAUDE_MARKER_HOLD_MS - 2 * T.CLAUDE_MARKER_POLL_MS
        ? { requestId: 'r', ok: true }
        : { requestId: 'r', ok: false, reason: `not ready (${mode})` }),
      live: () => ++checks < 2_000,
      sleep: c.sleep,
      now: c.now,
    })
    expect(result).toBe('typed')
  })

  it('a type with no answer is never followed by a timeout before a probe answers: a line the renderer typed late is typed, not reported unsent', async () => {
    const c = clock()
    const asked: ClaudeMarkerMode[] = []
    let typedLate = false
    let checks = 0
    const result = await T.typeClaudeMarkerWhenReady({
      ask: async (mode) => {
        asked.push(mode)
        if (typedLate) return { requestId: 'r', ok: true } // the renderer remembers a marker it typed
        const late = c.t - 1_000_000 >= T.CLAUDE_MARKER_HOLD_MS - 500
        if (!late) return { requestId: 'r', ok: false, reason: 'busy' }
        if (mode === 'probe' && asked.filter((m) => m === 'type').length === 0) return { requestId: 'r', ok: true }
        // The type is written, but its answer never reaches main; the bound passes meanwhile.
        typedLate = true
        c.t += T.CLAUDE_MARKER_ANSWER_MS
        return null
      },
      live: () => ++checks < 2_000,
      sleep: c.sleep,
      now: c.now,
    })
    expect(result).toBe('typed')
    expect(asked.slice(-4)).toEqual(['probe', 'type', 'probe', 'type'])
  })

  it('a type with no answer, then a probe that answers not ready (so nothing was typed): timeout', async () => {
    const c = clock()
    let typeAsked = false
    let checks = 0
    const result = await T.typeClaudeMarkerWhenReady({
      ask: async (mode) => {
        if (mode === 'type') {
          typeAsked = true
          c.t += T.CLAUDE_MARKER_HOLD_MS // the bound passes while main waits
          return null
        }
        return typeAsked ? { requestId: 'r', ok: false, reason: 'a question is on screen' } : { requestId: 'r', ok: true }
      },
      live: () => ++checks < 2_000,
      sleep: c.sleep,
      now: c.now,
    })
    expect(result).toBe('timeout')
  })

  it('a type with no answer and no later answer at all is held past the bound until its run ends: gone, never timeout', async () => {
    const c = clock()
    let checks = 0
    let typeAsked = false
    const result = await T.typeClaudeMarkerWhenReady({
      ask: async (mode) => {
        if (mode === 'type') typeAsked = true
        if (typeAsked) return null
        return { requestId: 'r', ok: true }
      },
      // The run ends well past the bound.
      live: () => ++checks < 2_000,
      sleep: c.sleep,
      now: c.now,
    })
    expect(c.t - 1_000_000).toBeGreaterThan(T.CLAUDE_MARKER_HOLD_MS)
    expect(result).toBe('gone')
  })

  it('given back before a read: nothing asked, nothing typed', async () => {
    const r = scripted([])
    const result = await T.typeClaudeMarkerWhenReady({ ask: r.ask, live: () => true, sleep: async () => {}, giveBack: () => true })
    expect(result).toBe('given-back')
    expect(r.asked).toEqual([])
  })

  it('a give-back that declines or throws keeps it held here', async () => {
    let offered = 0
    const r = scripted([['probe', false], ['probe', true], ['type', true]])
    const result = await T.typeClaudeMarkerWhenReady({
      ask: r.ask,
      live: () => true,
      sleep: async () => {},
      giveBack: () => { offered++; if (offered === 1) return false; throw new Error('queue gone') },
    })
    expect(result).toBe('typed')
    expect(offered).toBe(2)
  })

  it('never offered back while a type request is unanswered: a probe that reads it typed ends it typed', async () => {
    let offered = 0
    const answers: Array<ClaudeMarkerAnswer | null> = [
      { requestId: 'r', ok: true }, null, { requestId: 'r', ok: true }, { requestId: 'r', ok: true },
    ]
    const asked: ClaudeMarkerMode[] = []
    const result = await T.typeClaudeMarkerWhenReady({
      ask: async (mode) => { asked.push(mode); return answers.shift() ?? null },
      live: () => true,
      sleep: async () => {},
      giveBack: () => { offered++; return offered > 1 },
    })
    expect(result).toBe('typed')
    expect(asked).toEqual(['probe', 'type', 'probe', 'type'])
    expect(offered).toBe(1)
  })

  it('a type with no answer, then a probe that answers not ready (so nothing was typed): offered back at the next read', async () => {
    let offered = 0
    const answers: Array<ClaudeMarkerAnswer | null> = [
      { requestId: 'r', ok: true }, null, { requestId: 'r', ok: false, reason: 'busy' },
    ]
    const asked: ClaudeMarkerMode[] = []
    const result = await T.typeClaudeMarkerWhenReady({
      ask: async (mode) => { asked.push(mode); return answers.shift() ?? null },
      live: () => true,
      sleep: async () => {},
      giveBack: () => { offered++; return offered > 1 },
    })
    expect(result).toBe('given-back')
    expect(asked).toEqual(['probe', 'type', 'probe'])
    expect(offered).toBe(2)
  })
})

describe('the request to the renderer', () => {
  it('correlates the answer by its id, and drops an unknown, malformed or late one', async () => {
    vi.useFakeTimers()
    const sent: ClaudeMarkerAsk[] = []
    T.setClaudeMarkerSender((ask) => { sent.push(ask); return true })
    const first = T.askClaudePrompt('s1', 'probe', 'Approved v2 on the canvas', 'm1')
    const second = T.askClaudePrompt('s1', 'type', 'Approved v2 on the canvas', 'm1')
    expect(sent.map((a) => [a.sessionId, a.markerId, a.mode, a.line])).toEqual([['s1', 'm1', 'probe', 'Approved v2 on the canvas'], ['s1', 'm1', 'type', 'Approved v2 on the canvas']])
    expect(sent[0].requestId).not.toBe(sent[1].requestId)
    T.resolveClaudeMarkerAnswer({ requestId: 'nobody', ok: true })
    T.resolveClaudeMarkerAnswer(null)
    T.resolveClaudeMarkerAnswer('ok')
    T.resolveClaudeMarkerAnswer({ ok: true })
    T.resolveClaudeMarkerAnswer({ requestId: sent[1].requestId, ok: 'yes', reason: 'x'.repeat(500) })
    expect(await second).toEqual({ requestId: sent[1].requestId, ok: false, reason: 'x'.repeat(200) })
    await vi.advanceTimersByTimeAsync(T.CLAUDE_MARKER_ANSWER_MS)
    expect(await first).toBeNull()
    // Late: the request already timed out.
    T.resolveClaudeMarkerAnswer({ requestId: sent[0].requestId, ok: true })
    expect(await first).toBeNull()
  })

  it('no sender, a sender with no window, or a sender that throws: null, at once', async () => {
    expect(await T.askClaudePrompt('s1', 'probe', 'x', 'm1')).toBeNull()
    T.setClaudeMarkerSender(() => false)
    expect(await T.askClaudePrompt('s1', 'probe', 'x', 'm1')).toBeNull()
    T.setClaudeMarkerSender(() => { throw new Error('gone') })
    expect(await T.askClaudePrompt('s1', 'probe', 'x', 'm1')).toBeNull()
  })
})

describe('queueClaudeMarkerLine', () => {
  /** A renderer whose screen reads ready when `ready` is true; records types. */
  function renderer() {
    const state = { ready: false, typed: [] as string[], asks: [] as ClaudeMarkerAsk[], refuse: new Set<string>() }
    T.setClaudeMarkerSender((ask) => {
      state.asks.push(ask)
      queueMicrotask(() => {
        if (state.refuse.has(ask.line)) {
          T.resolveClaudeMarkerAnswer({ requestId: ask.requestId, ok: false, reason: CLAUDE_MARKER_REFUSED })
          return
        }
        const ok = state.ready
        if (ok && ask.mode === 'type') state.typed.push(`${ask.sessionId}:${ask.line}`)
        T.resolveClaudeMarkerAnswer({ requestId: ask.requestId, ok })
      })
      return true
    })
    return state
  }

  it('holds markers until the prompt reads ready, then types them in the order handed in', async () => {
    vi.useFakeTimers()
    const r = renderer()
    T.queueClaudeMarkerLine('s1', 'one', () => true)
    T.queueClaudeMarkerLine('s1', 'two', () => true)
    T.queueClaudeMarkerLine('s2', 'other', () => true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(r.typed).toEqual([])
    r.ready = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(r.typed.filter((t) => t.startsWith('s1:'))).toEqual(['s1:one', 's1:two'])
    expect(r.typed).toContain('s2:other')
  })

  it('a marker whose run ended, or whose session was forgotten, is never typed', async () => {
    vi.useFakeTimers()
    const r = renderer()
    let runAlive = true
    T.queueClaudeMarkerLine('s1', 'old run', () => runAlive)
    T.queueClaudeMarkerLine('s2', 'forgotten', () => true)
    await vi.advanceTimersByTimeAsync(5_000)
    runAlive = false
    T.forgetClaudeMarkers('s2')
    T.forgetClaudeMarkers('s2') // idempotent
    r.ready = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.typed).toEqual([])
    // A marker handed in after the forget is the new run's, and is typed.
    T.queueClaudeMarkerLine('s2', 'new run', () => true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(r.typed).toEqual(['s2:new run'])
  })

  it('asks for each marker under one id of its own, the same on every request for it', async () => {
    vi.useFakeTimers()
    const r = renderer()
    T.queueClaudeMarkerLine('s1', 'one', () => true)
    T.queueClaudeMarkerLine('s1', 'two', () => true)
    await vi.advanceTimersByTimeAsync(3_000)
    r.ready = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(r.typed).toEqual(['s1:one', 's1:two'])
    const idsOf = (line: string) => new Set(r.asks.filter((a) => a.line === line).map((a) => a.markerId))
    expect(idsOf('one').size).toBe(1)
    expect(idsOf('two').size).toBe(1)
    expect([...idsOf('one')][0]).not.toBe([...idsOf('two')][0])
    expect(r.asks.filter((a) => a.line === 'one').length).toBeGreaterThan(2)
  })

  it('collapses a line the same as one still held for the session, and types a later one again', async () => {
    vi.useFakeTimers()
    const r = renderer()
    T.queueClaudeMarkerLine('s1', 'Approved v2', () => true)
    T.queueClaudeMarkerLine('s1', 'Approved v2', () => true)
    T.queueClaudeMarkerLine('s2', 'Approved v2', () => true)
    await vi.advanceTimersByTimeAsync(3_000)
    r.ready = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect([...r.typed].sort()).toEqual(['s1:Approved v2', 's2:Approved v2'])
    // Typed, so no longer held: the same line filed again is typed again.
    T.queueClaudeMarkerLine('s1', 'Approved v2', () => true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(r.typed.filter((t) => t === 's1:Approved v2')).toHaveLength(2)
    expect(r.typed).toHaveLength(3)
  })

  it('collapses only a line held for the same canvas: the same words about another canvas are typed too, in order', async () => {
    vi.useFakeTimers()
    const r = renderer()
    T.queueClaudeMarkerLine('s1', 'Approved v1', () => true, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'Review #1', () => true, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'Approved v1', () => true, 'canvasB')
    // The same canvas again, while its marker is held: folded into it.
    T.queueClaudeMarkerLine('s1', 'Approved v1', () => true, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'Approved v1', () => true, 'canvasB')
    // No canvas named is a key of its own, folded only into another unnamed one.
    T.queueClaudeMarkerLine('s1', 'Approved v1', () => true)
    T.queueClaudeMarkerLine('s1', 'Approved v1', () => true)
    await vi.advanceTimersByTimeAsync(3_000)
    r.ready = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.typed).toEqual(['s1:Approved v1', 's1:Review #1', 's1:Approved v1', 's1:Approved v1'])
    expect(new Set(r.asks.filter((a) => a.line === 'Approved v1').map((a) => a.markerId)).size).toBe(3)
  })

  it('a marker the renderer refuses is dropped, and the markers after it are still typed', async () => {
    vi.useFakeTimers()
    const r = renderer()
    r.refuse.add('bad')
    T.queueClaudeMarkerLine('s1', 'bad', () => true)
    T.queueClaudeMarkerLine('s1', 'good', () => true)
    r.ready = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.typed).toEqual(['s1:good'])
    expect(r.asks.filter((a) => a.line === 'bad')).toHaveLength(1)
  })
})

describe('a marker dropped untyped is told to its canvas, once', () => {
  function renderer() {
    const state = { ready: false, typed: [] as string[], refuse: new Set<string>() }
    T.setClaudeMarkerSender((ask) => {
      queueMicrotask(() => {
        if (state.refuse.has(ask.line)) {
          T.resolveClaudeMarkerAnswer({ requestId: ask.requestId, ok: false, reason: CLAUDE_MARKER_REFUSED })
          return
        }
        const ok = state.ready
        if (ok && ask.mode === 'type') state.typed.push(`${ask.sessionId}:${ask.line}`)
        T.resolveClaudeMarkerAnswer({ requestId: ask.requestId, ok, ...(ok ? {} : { reason: 'a question is on screen' }) })
      })
      return true
    })
    return state
  }
  function told() {
    const list: Array<Record<string, unknown>> = []
    T.setClaudeMarkerUndelivered((u) => { list.push({ ...u }) })
    return list
  }

  it('held past the bound: told once (stayed busy), and never typed later', async () => {
    vi.useFakeTimers()
    const r = renderer()
    const t = told()
    T.queueClaudeMarkerLine('s1', 'Approved v2', () => true, 'canvasA')
    await vi.advanceTimersByTimeAsync(T.CLAUDE_MARKER_HOLD_MS - 5_000)
    expect(t).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t).toEqual([{ sessionId: 's1', canvasId: 'canvasA', line: 'Approved v2', reason: 'busy-timeout' }])
    r.ready = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(r.typed).toEqual([])
    expect(t).toHaveLength(1)
  })

  it('ready in time: typed, and nothing told', async () => {
    vi.useFakeTimers()
    const r = renderer()
    const t = told()
    T.queueClaudeMarkerLine('s1', 'Approved v2', () => true, 'canvasA')
    await vi.advanceTimersByTimeAsync(T.CLAUDE_MARKER_HOLD_MS - 10_000)
    r.ready = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(r.typed).toEqual(['s1:Approved v2'])
    await vi.advanceTimersByTimeAsync(10 * T.CLAUDE_MARKER_HOLD_MS)
    expect(t).toEqual([])
  })

  it('dropped when its run ends or its session is forgotten: each told once (the session gone), never typed', async () => {
    vi.useFakeTimers()
    const r = renderer()
    const t = told()
    let runAlive = true
    T.queueClaudeMarkerLine('s1', 'old run', () => runAlive, 'canvasA')
    T.queueClaudeMarkerLine('s2', 'forgotten', () => true, 'canvasB')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t).toEqual([])
    runAlive = false
    T.forgetClaudeMarkers('s2')
    T.forgetClaudeMarkers('s2')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(t).toEqual(expect.arrayContaining([
      { sessionId: 's1', canvasId: 'canvasA', line: 'old run', reason: 'session-gone' },
      { sessionId: 's2', canvasId: 'canvasB', line: 'forgotten', reason: 'session-gone' },
    ]))
    expect(t).toHaveLength(2)
    r.ready = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.typed).toEqual([])
    expect(t).toHaveLength(2)
  })

  it('every marker still held behind it is told too, each once', async () => {
    vi.useFakeTimers()
    renderer()
    const t = told()
    let runAlive = true
    T.queueClaudeMarkerLine('s1', 'first', () => runAlive, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'second', () => runAlive, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'first', () => runAlive, 'canvasA') // collapsed into the held one
    await vi.advanceTimersByTimeAsync(5_000)
    runAlive = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.map((u) => u.line)).toEqual(['first', 'second'])
  })

  it('a type that goes unanswered (it may have been typed) is never told as stayed busy; when its run ends it is told once, the session gone', async () => {
    vi.useFakeTimers()
    const t = told()
    let silent = false
    T.setClaudeMarkerSender((ask) => {
      if (ask.mode === 'type') silent = true
      if (silent) return true // sent, but no answer ever comes back
      queueMicrotask(() => T.resolveClaudeMarkerAnswer({ requestId: ask.requestId, ok: true }))
      return true
    })
    let runAlive = true
    T.queueClaudeMarkerLine('s1', 'Approved v2', () => runAlive, 'canvasA')
    await vi.advanceTimersByTimeAsync(3 * T.CLAUDE_MARKER_HOLD_MS)
    expect(silent).toBe(true)
    expect(t).toEqual([])
    runAlive = false
    await vi.advanceTimersByTimeAsync(T.CLAUDE_MARKER_ANSWER_MS + T.CLAUDE_MARKER_POLL_MS + 1_000)
    expect(t).toEqual([{ sessionId: 's1', canvasId: 'canvasA', line: 'Approved v2', reason: 'session-gone' }])
  })

  it('when its session\'s markers are cleared, every marker still held is told at once, in the order handed in, and never again by its own run', async () => {
    vi.useFakeTimers()
    const r = renderer()
    const t = told()
    T.queueClaudeMarkerLine('s1', 'first', () => true, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'second', () => true, 'canvasB')
    T.queueClaudeMarkerLine('s1', 'third', () => true, 'canvasA')
    T.queueClaudeMarkerLine('s2', 'other session', () => true, 'canvasA')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t).toEqual([])
    T.forgetClaudeMarkers('s1')
    // At once, before any of their runs reads again.
    const gone = [
      { sessionId: 's1', canvasId: 'canvasA', line: 'first', reason: 'session-gone' },
      { sessionId: 's1', canvasId: 'canvasB', line: 'second', reason: 'session-gone' },
      { sessionId: 's1', canvasId: 'canvasA', line: 'third', reason: 'session-gone' },
    ]
    expect(t).toEqual(gone)
    T.forgetClaudeMarkers('s1')
    expect(t).toEqual(gone)
    r.ready = true
    await vi.advanceTimersByTimeAsync(10 * T.CLAUDE_MARKER_HOLD_MS)
    expect(t).toEqual(gone)
    // Another session's marker is left as it was.
    expect(r.typed).toEqual(['s2:other session'])
  })

  it('told once whichever comes first, its run ending or its session\'s markers being cleared', async () => {
    vi.useFakeTimers()
    renderer()
    const t = told()
    let aAlive = true
    let bAlive = true
    T.queueClaudeMarkerLine('a', 'ended, then cleared', () => aAlive, 'canvasA')
    T.queueClaudeMarkerLine('b', 'cleared as it ended', () => bAlive, 'canvasA')
    await vi.advanceTimersByTimeAsync(5_000)
    aAlive = false
    // Its run's own next check tells it.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(t.map((u) => u.line)).toEqual(['ended, then cleared'])
    T.forgetClaudeMarkers('a')
    bAlive = false
    T.forgetClaudeMarkers('b')
    expect(t.map((u) => u.line)).toEqual(['ended, then cleared', 'cleared as it ended'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t).toHaveLength(2)
  })

  it.each([
    ['typed', { ok: true }],
    ['not typed', { ok: false, reason: 'busy' }],
    ['refused', { ok: false, reason: CLAUDE_MARKER_REFUSED }],
  ] as const)('a type request answered after its session\'s markers were cleared (%s): told once, at the clear, with the marker behind it, and nothing more', async (_how, late) => {
    vi.useFakeTimers()
    const t = told()
    const typeAsks: ClaudeMarkerAsk[] = []
    T.setClaudeMarkerSender((ask) => {
      // Every probe reads ready; a type request is answered below, late.
      if (ask.mode === 'type') { typeAsks.push(ask); return true }
      queueMicrotask(() => T.resolveClaudeMarkerAnswer({ requestId: ask.requestId, ok: true }))
      return true
    })
    T.queueClaudeMarkerLine('s1', 'first', () => true, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'second', () => true, 'canvasA')
    await vi.advanceTimersByTimeAsync(T.CLAUDE_MARKER_SECOND_READ_MS + 50)
    expect(typeAsks.map((a) => a.line)).toEqual(['first'])
    T.forgetClaudeMarkers('s1')
    expect(t.map((u) => [u.line, u.reason])).toEqual([['first', 'session-gone'], ['second', 'session-gone']])
    T.resolveClaudeMarkerAnswer({ requestId: typeAsks[0].requestId, ...late })
    await vi.advanceTimersByTimeAsync(10 * T.CLAUDE_MARKER_HOLD_MS)
    expect(t).toHaveLength(2)
    expect(typeAsks).toHaveLength(1)
  })

  it('a refused marker is told as a line the prompt cannot take', async () => {
    vi.useFakeTimers()
    const r = renderer()
    const t = told()
    r.refuse.add('bad')
    r.ready = true
    T.queueClaudeMarkerLine('s1', 'bad', () => true, 'canvasA')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t).toEqual([{ sessionId: 's1', canvasId: 'canvasA', line: 'bad', reason: 'refused-text' }])
  })

  it('the bound starts when a marker\'s own turn in the chain begins', async () => {
    vi.useFakeTimers()
    renderer()
    const t = told()
    T.queueClaudeMarkerLine('s1', 'first', () => true, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'second', () => true, 'canvasA')
    await vi.advanceTimersByTimeAsync(T.CLAUDE_MARKER_HOLD_MS + 5_000)
    expect(t.map((u) => u.line)).toEqual(['first'])
    await vi.advanceTimersByTimeAsync(T.CLAUDE_MARKER_HOLD_MS)
    expect(t.map((u) => u.line)).toEqual(['first', 'second'])
  })

  it('no canvas named: nothing told (only a log line); no report installed: nothing told', async () => {
    vi.useFakeTimers()
    renderer()
    const t = told()
    let alive = true
    T.queueClaudeMarkerLine('s1', 'no canvas', () => alive)
    await vi.advanceTimersByTimeAsync(2_000)
    alive = false
    await vi.advanceTimersByTimeAsync(3_000)
    expect(t).toEqual([])
    T.setClaudeMarkerUndelivered(null)
    alive = true
    T.queueClaudeMarkerLine('s2', 'unwired', () => alive, 'canvasA')
    await vi.advanceTimersByTimeAsync(2_000)
    alive = false
    await vi.advanceTimersByTimeAsync(3_000)
    expect(t).toEqual([])
  })

  it('a report that throws breaks nothing: the next marker is still typed', async () => {
    vi.useFakeTimers()
    const r = renderer()
    T.setClaudeMarkerUndelivered(() => { throw new Error('window gone') })
    r.refuse.add('bad')
    r.ready = true
    T.queueClaudeMarkerLine('s1', 'bad', () => true, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'good', () => true, 'canvasA')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.typed).toEqual(['s1:good'])
  })
})

describe('a marker behind a line typed since it was handed in is offered back to the queue', () => {
  function renderer() {
    const state = { ready: true, typed: [] as string[] }
    T.setClaudeMarkerSender((ask) => {
      queueMicrotask(() => {
        const ok = state.ready
        if (ok && ask.mode === 'type') state.typed.push(`${ask.sessionId}:${ask.line}`)
        T.resolveClaudeMarkerAnswer({ requestId: ask.requestId, ok, ...(ok ? {} : { reason: 'busy' }) })
      })
      return true
    })
    return state
  }
  /** The queue's holdAgain: records each offer, and takes it while `open`. */
  function queueSide() {
    const side = { open: true, offered: [] as string[], taken: [] as Array<[string, string, string | undefined]> }
    T.setClaudeMarkerHoldAgain((sessionId, line, canvasId) => {
      side.offered.push(line)
      if (!side.open) return false
      side.taken.push([sessionId, line, canvasId])
      return true
    })
    return side
  }
  function told() {
    const list: Array<Record<string, unknown>> = []
    T.setClaudeMarkerUndelivered((u) => { list.push({ ...u }) })
    return list
  }

  it('the markers behind the one typed are taken, in order: neither typed nor told; the first is never offered', async () => {
    vi.useFakeTimers()
    const r = renderer()
    const q = queueSide()
    const t = told()
    T.queueClaudeMarkerLine('s1', 'one', () => true, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'two', () => true, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'three', () => true, 'canvasB')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(r.typed).toEqual(['s1:one'])
    expect(q.taken).toEqual([['s1', 'two', 'canvasA'], ['s1', 'three', 'canvasB']])
    expect(q.offered).not.toContain('one')
    expect(t).toEqual([])
  })

  it('a queue that does not take it (no turn reads open) leaves it held here: typed at the ready prompt', async () => {
    vi.useFakeTimers()
    const r = renderer()
    const q = queueSide()
    q.open = false
    T.queueClaudeMarkerLine('s1', 'one', () => true, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'two', () => true, 'canvasA')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.typed).toEqual(['s1:one', 's1:two'])
    expect(q.offered).toEqual(['two'])
    expect(q.taken).toEqual([])
  })

  it('a marker handed in after the line was typed is not offered', async () => {
    vi.useFakeTimers()
    const r = renderer()
    const q = queueSide()
    T.queueClaudeMarkerLine('s1', 'one', () => true, 'canvasA')
    await vi.advanceTimersByTimeAsync(5_000)
    T.queueClaudeMarkerLine('s1', 'two', () => true, 'canvasA')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(r.typed).toEqual(['s1:one', 's1:two'])
    expect(q.offered).toEqual([])
  })

  it('a marker handed in after the line was typed, behind one still held here, follows that one to the queue: taken after it, never typed', async () => {
    vi.useFakeTimers()
    const r = renderer()
    const q = queueSide()
    const t = told()
    q.open = false
    // The prompt is busy once a line is typed.
    T.setClaudeMarkerSender((ask) => {
      queueMicrotask(() => {
        const ok = r.ready
        if (ok && ask.mode === 'type') { r.typed.push(`${ask.sessionId}:${ask.line}`); r.ready = false }
        T.resolveClaudeMarkerAnswer({ requestId: ask.requestId, ok, ...(ok ? {} : { reason: 'busy' }) })
      })
      return true
    })
    T.queueClaudeMarkerLine('s1', 'one', () => true, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'two', () => true, 'canvasA')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(r.typed).toEqual(['s1:one'])
    expect(q.offered).toContain('two')
    expect(q.taken).toEqual([])
    // Handed in after 'one' was typed, while no turn reads open yet.
    T.queueClaudeMarkerLine('s1', 'three', () => true, 'canvasB')
    q.open = true
    await vi.advanceTimersByTimeAsync(2_000)
    expect(q.taken).toEqual([['s1', 'two', 'canvasA'], ['s1', 'three', 'canvasB']])
    r.ready = true
    await vi.advanceTimersByTimeAsync(600_000)
    expect(r.typed).toEqual(['s1:one'])
    expect(t).toEqual([])
  })

  it('a marker whose run ended is not offered: told once, the session gone', async () => {
    vi.useFakeTimers()
    const r = renderer()
    const q = queueSide()
    const t = told()
    let alive = true
    T.queueClaudeMarkerLine('s1', 'one', () => alive, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'two', () => alive, 'canvasA')
    // The first is typed in its first read; the run ends before the second's.
    T.setClaudeMarkerSender((ask) => {
      queueMicrotask(() => {
        if (ask.mode === 'type') { r.typed.push(`${ask.sessionId}:${ask.line}`); alive = false }
        T.resolveClaudeMarkerAnswer({ requestId: ask.requestId, ok: true })
      })
      return true
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.typed).toEqual(['s1:one'])
    expect(q.offered).toEqual([])
    expect(t).toEqual([{ sessionId: 's1', canvasId: 'canvasA', line: 'two', reason: 'session-gone' }])
  })
})

describe('a marker held at the prompt when a turn begins is offered back to the queue', () => {
  /** A renderer whose screen reads ready only while `ready` (text at the
   *  prompt until then); records what it typed. */
  function renderer() {
    const state = { ready: false, typed: [] as string[] }
    T.setClaudeMarkerSender((ask) => {
      queueMicrotask(() => {
        const ok = state.ready
        if (ok && ask.mode === 'type') state.typed.push(`${ask.sessionId}:${ask.line}`)
        T.resolveClaudeMarkerAnswer({ requestId: ask.requestId, ok, ...(ok ? {} : { reason: 'text at the prompt' }) })
      })
      return true
    })
    return state
  }
  /** The queue's holdAgain: records each offer, and takes it while `open`. */
  function queueSide() {
    const side = { open: true, offered: [] as string[], taken: [] as Array<[string, string, string | undefined]> }
    T.setClaudeMarkerHoldAgain((sessionId, line, canvasId) => {
      side.offered.push(line)
      if (!side.open) return false
      side.taken.push([sessionId, line, canvasId])
      return true
    })
    return side
  }
  function told() {
    const list: Array<Record<string, unknown>> = []
    T.setClaudeMarkerUndelivered((u) => { list.push({ ...u }) })
    return list
  }

  it('a turn begun after it was handed in: it and the markers behind it are taken, in order, and neither typed nor told', async () => {
    vi.useFakeTimers()
    const r = renderer()
    const q = queueSide()
    const t = told()
    T.queueClaudeMarkerLine('s1', 'one', () => true, 'canvasA')
    T.queueClaudeMarkerLine('s1', 'two', () => true, 'canvasB')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(q.offered).toEqual([])
    T.noteClaudeMarkerTurnBegun('s1')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(q.taken).toEqual([['s1', 'one', 'canvasA'], ['s1', 'two', 'canvasB']])
    r.ready = true
    await vi.advanceTimersByTimeAsync(10 * T.CLAUDE_MARKER_HOLD_MS)
    expect(r.typed).toEqual([])
    expect(t).toEqual([])
  })

  it('a turn begun before it was handed in, or in another session, does not offer it: typed at the ready prompt', async () => {
    vi.useFakeTimers()
    const r = renderer()
    const q = queueSide()
    r.ready = true
    T.queueClaudeMarkerLine('s1', 'zero', () => true, 'canvasA')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(r.typed).toEqual(['s1:zero'])
    r.ready = false
    T.noteClaudeMarkerTurnBegun('s1')
    T.queueClaudeMarkerLine('s1', 'one', () => true, 'canvasA')
    await vi.advanceTimersByTimeAsync(3_000)
    T.noteClaudeMarkerTurnBegun('s2')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(q.offered).toEqual([])
    r.ready = true
    await vi.advanceTimersByTimeAsync(3_000)
    expect(r.typed).toEqual(['s1:zero', 's1:one'])
  })

  it('a queue that does not take it (the turn already reads closed) leaves it held here: typed once at the ready prompt', async () => {
    vi.useFakeTimers()
    const r = renderer()
    const q = queueSide()
    const t = told()
    q.open = false
    T.queueClaudeMarkerLine('s1', 'one', () => true, 'canvasA')
    await vi.advanceTimersByTimeAsync(2_000)
    T.noteClaudeMarkerTurnBegun('s1')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(q.offered).toContain('one')
    expect(q.taken).toEqual([])
    r.ready = true
    await vi.advanceTimersByTimeAsync(3_000)
    expect(r.typed).toEqual(['s1:one'])
    await vi.advanceTimersByTimeAsync(10 * T.CLAUDE_MARKER_HOLD_MS)
    expect(r.typed).toEqual(['s1:one'])
    expect(t).toEqual([])
  })

  it('a marker whose run ended is not offered: told once, the session gone', async () => {
    vi.useFakeTimers()
    renderer()
    const q = queueSide()
    const t = told()
    let alive = true
    T.queueClaudeMarkerLine('s1', 'one', () => alive, 'canvasA')
    await vi.advanceTimersByTimeAsync(2_000)
    alive = false
    T.noteClaudeMarkerTurnBegun('s1')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(q.offered).toEqual([])
    expect(t).toEqual([{ sessionId: 's1', canvasId: 'canvasA', line: 'one', reason: 'session-gone' }])
  })
})
