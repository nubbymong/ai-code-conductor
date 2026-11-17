// @vitest-environment jsdom
// aicc_planning#304: a statusline tick whose values equal the stored ones
// leaves the sessions array (and the session object) as they were, even
// though usageBuckets and rateLimitExtra arrive as fresh objects every tick.
// And a usage bar whose figures did not change does not render again, except
// when the local date changes under it.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The real formatResetTime, counted.
const formatResetTime = vi.hoisted(() => vi.fn<(iso: string) => string>())
vi.mock('../../../src/renderer/utils/terminalFormatting', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/renderer/utils/terminalFormatting')>()
  formatResetTime.mockImplementation(real.formatResetTime)
  return { ...real, formatResetTime }
})

import { useSessionStore, sameStatusValue } from '../../../src/renderer/stores/sessionStore'
import type { Session } from '../../../src/renderer/stores/sessionStore'
import { RateLimitBar } from '../../../src/renderer/components/terminal/RateLimitBar'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const buckets = () => [
  { key: 'five_hour', label: '5h', percent: 41, resetsAt: '2026-10-18T05:00:00Z' },
  { key: 'seven_day', label: 'Weekly', percent: 12, resetsAt: '2026-10-21T00:00:00Z' },
]
const extra = () => ({ opus: { percent: 3, resetsAt: null }, note: ['a', 'b'] })

beforeEach(() => {
  useSessionStore.setState({
    sessions: [{ id: 's1', label: 'one', workingDirectory: 'C:/p', model: '', color: '#fff', status: 'working', createdAt: 1, sessionType: 'local' } as Session],
    activeSessionId: 's1',
  })
})

describe('updateSession no-op guard (aicc_planning#304)', () => {
  it('a tick with equal bucket and extra values keeps the sessions array identity', () => {
    const { updateSession } = useSessionStore.getState()
    updateSession('s1', { usageBuckets: buckets(), rateLimitExtra: extra(), rateLimitCurrent: 41 } as never)
    const before = useSessionStore.getState().sessions
    updateSession('s1', { usageBuckets: buckets(), rateLimitExtra: extra(), rateLimitCurrent: 41 } as never)
    expect(useSessionStore.getState().sessions).toBe(before)
    expect(useSessionStore.getState().sessions[0]).toBe(before[0])
  })

  it('a changed bucket figure still updates', () => {
    const { updateSession } = useSessionStore.getState()
    updateSession('s1', { usageBuckets: buckets() } as never)
    const before = useSessionStore.getState().sessions
    const next = buckets(); next[0].percent = 42
    updateSession('s1', { usageBuckets: next } as never)
    const after = useSessionStore.getState().sessions
    expect(after).not.toBe(before)
    expect((after[0] as unknown as { usageBuckets: typeof next }).usageBuckets[0].percent).toBe(42)
  })

  it('a bucket that disappeared upstream clears', () => {
    const { updateSession } = useSessionStore.getState()
    updateSession('s1', { usageBuckets: buckets() } as never)
    updateSession('s1', { usageBuckets: [] } as never)
    expect((useSessionStore.getState().sessions[0] as unknown as { usageBuckets: unknown[] }).usageBuckets).toEqual([])
  })
})

describe('sameStatusValue', () => {
  it('compares plain arrays and objects by value', () => {
    expect(sameStatusValue(buckets(), buckets())).toBe(true)
    expect(sameStatusValue(extra(), extra())).toBe(true)
    expect(sameStatusValue({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(sameStatusValue([1, 2], [1, 2, 3])).toBe(false)
    expect(sameStatusValue({ a: [1] }, { a: [2] })).toBe(false)
    expect(sameStatusValue([], {})).toBe(false)
    expect(sameStatusValue(null, {})).toBe(false)
  })

  it('anything that is not a plain object is compared by identity only', () => {
    expect(sameStatusValue(new Date(1), new Date(1))).toBe(false)
    const f = () => 1
    expect(sameStatusValue(f, () => 1)).toBe(false)
    expect(sameStatusValue(f, f)).toBe(true)
  })

  it('a key that only one side has is a change, even when both read undefined', () => {
    // Same key count, so only the own-key check tells them apart.
    expect(sameStatusValue({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(false)
  })

  it('past depth 6 a value counts as changed, so a cyclic value ends', () => {
    const nest = (n: number): unknown => (n === 0 ? 1 : { x: nest(n - 1) })
    // Seven objects, at depths 0 to 6, are still compared by value.
    expect(sameStatusValue(nest(7), nest(7))).toBe(true)
    // An eighth, at depth 7, counts as changed.
    expect(sameStatusValue(nest(8), nest(8))).toBe(false)
    const a: Record<string, unknown> = { n: 1 }
    a.self = a
    const b: Record<string, unknown> = { n: 1 }
    b.self = b
    expect(sameStatusValue(a, b)).toBe(false)
  })
})

describe('RateLimitBar (aicc_planning#304)', () => {
  let container: HTMLDivElement
  let root: Root | null
  const unmount = () => { if (root) { const r = root; root = null; act(() => { r.unmount() }) } }
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  // Each case leaves nothing mounted, and so no date-check timer, for the next.
  afterEach(() => {
    unmount()
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** A fake clock at a local time; the date check's timer runs on it. */
  const clockAt = (d: Date) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(d)
  }
  const bar = (resets: string, label = '5h') =>
    React.createElement(RateLimitBar, { key: label, label, pct: 41, resets, showReset: true })

  it('a bar whose figures did not change does not render again', () => {
    const props = { label: '5h', pct: 41, resets: '2026-11-17T05:00:00Z' }
    const tree = (tick: number, p: typeof props) =>
      React.createElement('div', { 'data-tick': tick }, React.createElement(RateLimitBar, p))
    act(() => { root!.render(tree(1, props)) })
    const first = formatResetTime.mock.calls.length
    expect(first).toBeGreaterThan(0)
    // The parent re-renders (another session ticked): same figures, new props object.
    act(() => { root!.render(tree(2, { ...props })) })
    expect(formatResetTime.mock.calls.length).toBe(first)
    // A real change still paints.
    act(() => { root!.render(tree(3, { ...props, pct: 42 })) })
    expect(formatResetTime.mock.calls.length).toBeGreaterThan(first)
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42')
  })

  it('at local midnight, a bar whose reset was tomorrow drops the date, with no new props', () => {
    clockAt(new Date(2026, 10, 17, 23, 59, 0))
    const resets = new Date(2026, 10, 18, 3, 0, 0).toISOString()
    const dated = formatResetTime(resets)
    act(() => { root!.render(bar(resets)) })
    expect(container.textContent).toContain(`resets ${dated}`)
    act(() => { vi.advanceTimersByTime(2 * 60_000) }) // 00:01 on the 18th
    const timeOnly = formatResetTime(resets)
    expect(timeOnly).not.toBe(dated)
    expect(container.textContent).toContain(`resets ${timeOnly}`)
    // The last bar gone, its timer goes too.
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bars share one timer, and unmounting one keeps it for the others', () => {
    clockAt(new Date(2026, 10, 17, 23, 59, 0))
    const resets = new Date(2026, 10, 18, 3, 0, 0).toISOString()
    const dated = formatResetTime(resets)
    act(() => { root!.render(React.createElement('div', null, bar(resets, '5h'), bar(resets, 'Weekly'))) })
    expect(vi.getTimerCount()).toBe(1)
    act(() => { root!.render(React.createElement('div', null, bar(resets, '5h'))) })
    expect(vi.getTimerCount()).toBe(1)
    expect(container.textContent).toContain(`resets ${dated}`)
    act(() => { vi.advanceTimersByTime(2 * 60_000) }) // 00:01 on the 18th
    expect(container.textContent).toContain(`resets ${formatResetTime(resets)}`)
  })

  it('the check is armed again after it fires, so a second midnight is caught too', () => {
    clockAt(new Date(2026, 10, 17, 23, 59, 0))
    const resets = new Date(2026, 10, 19, 3, 0, 0).toISOString() // two days out
    const dated = formatResetTime(resets)
    act(() => { root!.render(bar(resets)) })
    act(() => { vi.advanceTimersByTime(2 * 60_000) }) // 00:01 on the 18th: still tomorrow
    expect(container.textContent).toContain(`resets ${dated}`)
    expect(vi.getTimerCount()).toBe(1)
    act(() => { vi.advanceTimersByTime(24 * 60 * 60_000) }) // 00:01 on the 19th
    const timeOnly = formatResetTime(resets)
    expect(timeOnly).not.toBe(dated)
    expect(container.textContent).toContain(`resets ${timeOnly}`)
  })

  it('a late timer, or a clock or time-zone change, still shows the new date within 15 minutes', () => {
    clockAt(new Date(2026, 10, 17, 12, 0, 0))
    const resets = new Date(2026, 10, 18, 3, 0, 0).toISOString()
    const dated = formatResetTime(resets)
    act(() => { root!.render(bar(resets)) })
    expect(container.textContent).toContain(`resets ${dated}`)
    // The wall clock jumps to 00:05 on the 18th while the pending timer keeps
    // its remaining wait, as after a sleep or a time-zone change.
    vi.setSystemTime(new Date(2026, 10, 18, 0, 5, 0))
    act(() => { vi.advanceTimersByTime(15 * 60_000) })
    expect(container.textContent).toContain(`resets ${formatResetTime(resets)}`)
  })

  it('showing the window again checks the date at once, and the last bar removes that listener', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    clockAt(new Date(2026, 10, 17, 12, 0, 0))
    const resets = new Date(2026, 10, 18, 3, 0, 0).toISOString()
    act(() => { root!.render(bar(resets)) })
    vi.setSystemTime(new Date(2026, 10, 18, 0, 5, 0))
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(container.textContent).toContain(`resets ${formatResetTime(resets)}`)
    const added = add.mock.calls.filter(([type]) => type === 'visibilitychange')
    expect(added).toHaveLength(1)
    unmount()
    expect(remove).toHaveBeenCalledWith('visibilitychange', added[0][1])
  })

  it('renders on a server render too (React needs a server snapshot for the date)', () => {
    const html = renderToStaticMarkup(React.createElement(RateLimitBar, { label: '5h', pct: 41 }))
    expect(html).toContain('aria-valuenow="41"')
  })
})
