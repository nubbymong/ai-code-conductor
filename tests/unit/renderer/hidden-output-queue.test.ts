// aicc_planning#303: a terminal that is not on screen takes its output in
// batches; the one on screen writes every chunk at once. This file pins the
// queue itself on fake timers. Its wiring into TerminalView (shown, exit
// line, resume nudge, screen reads, unmount) is pinned on the mounted view in
// terminalview-hidden-output.test.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createHiddenOutputQueue,
  HIDDEN_OUTPUT_FLUSH_MS,
  SCREEN_READ_LIVE_MS,
} from '../../../src/renderer/components/terminal/hiddenOutputQueue'

/** `parse()` stands for xterm finishing its parse of what was written: it runs
 *  the parsed callbacks handed over so far, as xterm does on a later task. */
function harness(visible = false) {
  const writes: string[] = []
  const tracked: string[] = []
  let pending: Array<() => void> = []
  const state = { visible }
  const q = createHiddenOutputQueue({
    write: (c, parsed) => {
      writes.push(c)
      if (parsed) { tracked.push(c); pending.push(parsed) }
    },
    isVisible: () => state.visible,
  })
  const parse = () => { const p = pending; pending = []; p.forEach((cb) => cb()) }
  return { q, writes, tracked, state, parse }
}

// Date and performance too: the live window after a read runs on
// performance.now(), and the clock-step cases move Date alone.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }) })
afterEach(() => { vi.useRealTimers() })

describe('hiddenOutputQueue (aicc_planning#303)', () => {
  it('flushes a hidden terminal once a second (terminalview-hidden-output.test.tsx uses the same figure)', () => {
    expect(HIDDEN_OUTPUT_FLUSH_MS).toBe(1000)
  })

  it('the visible terminal writes every chunk at once, with no timer', () => {
    const h = harness(true)
    h.q.push('a')
    h.q.push('b')
    expect(h.writes).toEqual(['a', 'b'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a hidden terminal writes nothing until the flush interval, then one batch in order', () => {
    const h = harness(false)
    h.q.push('a'); h.q.push('b'); h.q.push('c')
    expect(h.writes).toEqual([])
    vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS - 1)
    expect(h.writes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(h.writes).toEqual(['abc'])
    // The next chunk starts the next interval.
    h.q.push('d')
    vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS - 1)
    expect(h.writes).toEqual(['abc'])
    vi.advanceTimersByTime(1)
    expect(h.writes).toEqual(['abc', 'd'])
  })

  it('one write per interval however many chunks arrive in it (the follow decision is taken once per batch)', () => {
    const h = harness(false)
    for (let i = 0; i < 50; i++) h.q.push(String(i % 10))
    vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS)
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]).toBe('0123456789'.repeat(5))
  })

  it('the interval runs from the first queued chunk, not the last', () => {
    const h = harness(false)
    h.q.push('a')
    vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS / 2)
    h.q.push('b')
    vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS / 2)
    expect(h.writes).toEqual(['ab'])
  })

  it('shown again: flush writes what was queued at once, and drops the timer', () => {
    const h = harness(false)
    h.q.push('x'); h.q.push('y')
    h.state.visible = true
    h.q.flush()
    expect(h.writes).toEqual(['xy'])
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS)
    expect(h.writes).toEqual(['xy'])
  })

  it('a chunk arriving once visible comes after what was queued (no flush in between)', () => {
    const h = harness(false)
    h.q.push('old')
    h.state.visible = true
    h.q.push('new')
    expect(h.writes).toEqual(['old', 'new'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a flush with nothing queued writes nothing', () => {
    const h = harness(false)
    h.q.flush()
    expect(h.writes).toEqual([])
  })

  it('nothing is lost or reordered across hide, show, flush and timer', () => {
    const h = harness(false)
    const sent: string[] = []
    const send = (c: string) => { sent.push(c); h.q.push(c) }
    send('1'); send('2')
    vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS)
    send('3')
    h.state.visible = true
    send('4')
    h.state.visible = false
    send('5'); send('6')
    h.q.flush()
    send('7')
    vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS)
    expect(h.writes.join('')).toBe(sent.join(''))
    expect(h.writes).toEqual(['12', '3', '4', '56', '7'])
  })

  it('after dispose nothing is written, queued output is dropped and the timer is gone', () => {
    const h = harness(false)
    h.q.push('a')
    expect(vi.getTimerCount()).toBe(1)
    h.q.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS)
    h.q.push('b')
    h.q.flush()
    h.state.visible = true
    h.q.push('c')
    expect(h.writes).toEqual([])
    expect(h.q.prepareScreenRead().behind).toBe(false)
  })
})

describe('a read of a hidden terminal screen (aicc_planning#303)', () => {
  it('writes what is queued and says so: the screen read now does not show it yet', () => {
    const h = harness(false)
    h.q.push('a'); h.q.push('b')
    expect(h.q.prepareScreenRead().behind).toBe(true)
    expect(h.writes).toEqual(['ab'])
    // Read again before xterm has parsed the batch: still behind.
    expect(h.q.prepareScreenRead().behind).toBe(true)
    expect(h.writes).toEqual(['ab'])
    h.parse()
    expect(h.q.prepareScreenRead().behind).toBe(false)
  })

  it('a batch the timer wrote is behind until xterm has parsed it, though nothing is queued', () => {
    const h = harness(false)
    h.q.push('a')
    vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS)
    expect(h.writes).toEqual(['a'])
    expect(h.q.prepareScreenRead().behind).toBe(true)
    expect(h.q.prepareScreenRead().behind).toBe(true)
    h.parse()
    expect(h.q.prepareScreenRead().behind).toBe(false)
  })

  it('two batches in flight: behind until both are parsed', () => {
    const h = harness(false)
    h.q.push('a')
    h.q.flush()
    const first = h.tracked.length
    h.q.push('b')
    vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS)
    expect(h.tracked).toEqual(['a', 'b'])
    expect(first).toBe(1)
    expect(h.q.prepareScreenRead().behind).toBe(true)
    h.parse()
    expect(h.q.prepareScreenRead().behind).toBe(false)
  })

  it('a parsed report that arrives twice counts once', () => {
    let parsed: (() => void) | undefined
    const q = createHiddenOutputQueue({ write: (_c, p) => { if (p) parsed = p }, isVisible: () => false })
    q.push('a')
    q.flush()
    parsed!(); parsed!()
    q.push('b')
    q.flush()
    expect(q.prepareScreenRead().behind).toBe(true)
  })

  it('a batch xterm refuses (its write throws, over the parse limit) is dropped and logged once, never thrown, and not waited for', () => {
    // Every caller of flush is a cleanup or bookkeeping path (shown, exit,
    // spawn end, launch failure, the timer): a throw there would skip the
    // rest of it, and the batch is lost either way.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let fail = true
      const writes: string[] = []
      const q = createHiddenOutputQueue({
        write: (c) => { if (fail) throw new Error('write data discarded, use flow control to avoid losing data'); writes.push(c) },
        isVisible: () => false,
      })
      q.push('a')
      expect(() => q.flush()).not.toThrow()
      q.push('b')
      expect(() => vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS)).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toBe('[hiddenOutputQueue] xterm refused a batch')
      fail = false
      expect(q.prepareScreenRead().behind).toBe(false)
      q.push('c')
      expect(writes).toEqual(['c'])
    } finally {
      warn.mockRestore()
    }
  })

  it('only batches are waited for: a chunk written at once (visible, or live after a read) is not, as before this change', () => {
    const h = harness(false)
    h.q.push('queued')
    h.state.visible = true
    h.q.flush()
    h.q.push('visible')
    h.state.visible = false
    h.parse()
    h.q.prepareScreenRead()
    h.q.push('live')
    expect(h.writes).toEqual(['queued', 'visible', 'live'])
    expect(h.tracked).toEqual(['queued'])
    expect(h.q.prepareScreenRead().behind).toBe(false)
  })

  it('with nothing queued the screen is current', () => {
    const h = harness(false)
    expect(h.q.prepareScreenRead().behind).toBe(false)
    expect(h.writes).toEqual([])
  })

  it('after a read the terminal writes each chunk at once for a while, so the reads that follow are current', () => {
    const h = harness(false)
    h.q.prepareScreenRead()
    h.q.push('a')
    expect(h.writes).toEqual(['a'])
    vi.advanceTimersByTime(SCREEN_READ_LIVE_MS - 1)
    h.q.push('b')
    expect(h.writes).toEqual(['a', 'b'])
    // Each read keeps it live from that read.
    expect(h.q.prepareScreenRead().behind).toBe(false)
    vi.advanceTimersByTime(SCREEN_READ_LIVE_MS - 1)
    h.q.push('c')
    expect(h.writes).toEqual(['a', 'b', 'c'])
    vi.advanceTimersByTime(1)
    // Nobody has read it for SCREEN_READ_LIVE_MS: batched again.
    h.q.push('d')
    expect(h.writes).toEqual(['a', 'b', 'c'])
    vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS)
    expect(h.writes).toEqual(['a', 'b', 'c', 'd'])
    expect(h.tracked).toEqual(['d'])
  })

  it('the live window after a read runs on a steady clock: a wall clock set back does not keep it open', () => {
    const h = harness(false)
    h.q.prepareScreenRead()
    // Time sync or a manual change moves the wall clock back a minute.
    vi.setSystemTime(Date.now() - 60_000)
    vi.advanceTimersByTime(SCREEN_READ_LIVE_MS)
    h.q.push('a')
    expect(h.writes).toEqual([])
    vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS)
    expect(h.writes).toEqual(['a'])
  })

  it('the live window after a read runs on a steady clock: a wall clock set forward does not end it early', () => {
    const h = harness(false)
    h.q.prepareScreenRead()
    vi.setSystemTime(Date.now() + 60_000)
    h.q.push('a')
    expect(h.writes).toEqual(['a'])
  })

  it('a read of the visible terminal finds nothing queued', () => {
    const h = harness(true)
    h.q.push('a')
    expect(h.q.prepareScreenRead().behind).toBe(false)
    expect(h.writes).toEqual(['a'])
  })
})
