// aicc_planning#303: a terminal that is not on screen takes its output in
// batches; the one on screen writes every chunk at once. The queue is pinned
// directly; its wiring into TerminalView is read from the source, as the view
// is not mounted here.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createHiddenOutputQueue, HIDDEN_OUTPUT_FLUSH_MS } from '../../../src/renderer/components/terminal/hiddenOutputQueue'

function harness(visible = false) {
  const writes: string[] = []
  const timers: Array<{ cb: () => void; ms: number; cleared: boolean }> = []
  const state = { visible }
  const q = createHiddenOutputQueue({
    write: (c) => writes.push(c),
    isVisible: () => state.visible,
    setTimer: (cb, ms) => { const t = { cb, ms, cleared: false }; timers.push(t); return t as never },
    clearTimer: (t) => { (t as unknown as { cleared: boolean }).cleared = true },
  })
  const fire = () => { for (const t of timers.splice(0)) if (!t.cleared) t.cb() }
  return { q, writes, timers, state, fire }
}

describe('hiddenOutputQueue (#303)', () => {
  it('the visible terminal writes every chunk at once', () => {
    const h = harness(true)
    h.q.push('a'); h.q.push('b')
    expect(h.writes).toEqual(['a', 'b'])
    expect(h.timers).toEqual([])
  })

  it('a hidden terminal writes nothing until the flush interval, then one batch in order', () => {
    const h = harness(false)
    h.q.push('a'); h.q.push('b'); h.q.push('c')
    expect(h.writes).toEqual([])
    expect(h.timers).toHaveLength(1)
    expect(h.timers[0].ms).toBe(HIDDEN_OUTPUT_FLUSH_MS)
    h.fire()
    expect(h.writes).toEqual(['abc'])
  })

  it('shown again: flush writes what was queued at once', () => {
    const h = harness(false)
    h.q.push('x'); h.q.push('y')
    h.state.visible = true
    h.q.flush()
    expect(h.writes).toEqual(['xy'])
    expect(h.timers[0].cleared).toBe(true)
  })

  it('a chunk arriving once visible comes after what was queued', () => {
    const h = harness(false)
    h.q.push('old')
    h.state.visible = true
    h.q.push('new')
    expect(h.writes).toEqual(['old', 'new'])
  })

  it('a flush with nothing queued writes nothing', () => {
    const h = harness(false)
    h.q.flush()
    expect(h.writes).toEqual([])
  })

  it('after dispose nothing is written and the timer is cleared', () => {
    const h = harness(false)
    h.q.push('a')
    h.q.dispose()
    h.fire()
    h.q.push('b'); h.q.flush()
    expect(h.writes).toEqual([])
    expect(h.timers.every((t) => t.cleared) || h.timers.length === 0).toBe(true)
  })

  it('works with real timers', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const q = createHiddenOutputQueue({ write: (c) => writes.push(c), isVisible: () => false })
      q.push('1'); q.push('2')
      vi.advanceTimersByTime(HIDDEN_OUTPUT_FLUSH_MS - 1)
      expect(writes).toEqual([])
      vi.advanceTimersByTime(1)
      expect(writes).toEqual(['12'])
    } finally { vi.useRealTimers() }
  })
})

describe('TerminalView wiring (read from the source)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'renderer', 'components', 'TerminalView.tsx'), 'utf8')
    .replace(/\r\n/g, '\n').replace(/^[ \t]*\/\/.*$/gm, '')

  it('PTY output goes through the queue, and the only direct output write is inside writeOutput', () => {
    expect(src).toContain('createHiddenOutputQueue({ write: writeOutput, isVisible: () => isActiveRef.current })')
    expect(src).toContain('hiddenOutput.push(filtered)')
    expect(src.match(/term\?\.write\(filtered\)/g)).toHaveLength(1)
    const wo = src.indexOf('function writeOutput(filtered: string)')
    expect(wo).toBeGreaterThan(-1)
    expect(src.indexOf('term?.write(filtered)')).toBeGreaterThan(wo)
  })

  it('queued output is written before every line the app writes itself, and when shown', () => {
    expect(src).toMatch(/const markExited = \(line: string \| null\) => \{\s*hiddenOutputRef\.current\?\.flush\(\)/)
    expect(src).toMatch(/hiddenOutputRef\.current\?\.flush\(\)\s*term\?\.writeln\(line\)/)
    expect(src).toMatch(/adoptedStartEnded = true\s*hiddenOutputRef\.current\?\.flush\(\)\s*if \(line\) term\?\.writeln\(line\)/)
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(isActive\) hiddenOutputRef\.current\?\.flush\(\)\s*\}, \[isActive\]\)/)
    expect(src.match(/term\?\.writeln\(/g)).toHaveLength(3)
  })

  it('the queue is disposed with the terminal', () => {
    expect(src).toMatch(/hiddenOutputRef\.current\?\.dispose\(\)\s*hiddenOutputRef\.current = null/)
  })
})
