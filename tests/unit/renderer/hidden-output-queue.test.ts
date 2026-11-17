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

function harness(visible = false) {
  const writes: string[] = []
  const state = { visible }
  const q = createHiddenOutputQueue({ write: (c) => writes.push(c), isVisible: () => state.visible })
  return { q, writes, state }
}

beforeEach(() => { vi.useFakeTimers() })
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

  it('a line the app writes itself comes after the queued output when the caller flushes first (exit line, resume nudge)', () => {
    const writes: string[] = []
    const q = createHiddenOutputQueue({ write: (c) => writes.push(`out:${c}`), isVisible: () => false })
    q.push('last output')
    q.flush()
    writes.push('line:[Process exited with code 0]')
    expect(writes).toEqual(['out:last output', 'line:[Process exited with code 0]'])
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
    expect(h.q.beforeScreenRead()).toBe(false)
  })
})

describe('a read of a hidden terminal screen (aicc_planning#303)', () => {
  it('writes what is queued and says so: the screen read now does not show it yet', () => {
    const h = harness(false)
    h.q.push('a'); h.q.push('b')
    expect(h.q.beforeScreenRead()).toBe(true)
    expect(h.writes).toEqual(['ab'])
    expect(h.q.beforeScreenRead()).toBe(false)
  })

  it('with nothing queued the screen is current', () => {
    const h = harness(false)
    expect(h.q.beforeScreenRead()).toBe(false)
    expect(h.writes).toEqual([])
  })

  it('after a read the terminal writes each chunk at once for a while, so the reads that follow are current', () => {
    const h = harness(false)
    h.q.beforeScreenRead()
    h.q.push('a')
    expect(h.writes).toEqual(['a'])
    vi.advanceTimersByTime(SCREEN_READ_LIVE_MS - 1)
    h.q.push('b')
    expect(h.writes).toEqual(['a', 'b'])
    // Each read keeps it live from that read.
    expect(h.q.beforeScreenRead()).toBe(false)
    vi.advanceTimersByTime(SCREEN_READ_LIVE_MS - 1)
    h.q.push('c')
    expect(h.writes).toEqual(['a', 'b', 'c'])
    vi.advanceTimersByTime(1)
    // Nobody has read it for SCREEN_READ_LIVE_MS: batched again.
    h.q.push('d')
    expect(h.writes).toEqual(['a', 'b', 'c'])
    vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS)
    expect(h.writes).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a read of the visible terminal finds nothing queued', () => {
    const h = harness(true)
    h.q.push('a')
    expect(h.q.beforeScreenRead()).toBe(false)
    expect(h.writes).toEqual(['a'])
  })
})
