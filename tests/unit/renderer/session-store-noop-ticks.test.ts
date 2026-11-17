// @vitest-environment jsdom
// aicc_planning#304: a statusline tick whose values equal the stored ones
// leaves the sessions array (and the session object) as they were, even
// though usageBuckets and rateLimitExtra arrive as fresh objects every tick.
// And a usage bar whose figures did not change does not render again.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const formatResetTime = vi.hoisted(() => vi.fn((_iso: string) => '3:00 pm'))
vi.mock('../../../src/renderer/utils/terminalFormatting', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  formatResetTime,
}))

import { useSessionStore, sameStatusValue } from '../../../src/renderer/stores/sessionStore'
import type { Session } from '../../../src/renderer/stores/sessionStore'
import RateLimitBar from '../../../src/renderer/components/terminal/RateLimitBar'

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

describe('updateSession no-op guard (#304)', () => {
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
})

describe('RateLimitBar (#304)', () => {
  it('a bar whose figures did not change does not render again', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const props = { label: '5h', pct: 41, resets: '2026-11-17T05:00:00Z' }
    const tree = (tick: number, p: typeof props) =>
      React.createElement('div', { 'data-tick': tick }, React.createElement(RateLimitBar, p))
    act(() => { root.render(tree(1, props)) })
    const first = formatResetTime.mock.calls.length
    expect(first).toBeGreaterThan(0)
    // The parent re-renders (another session ticked): same figures, new props object.
    act(() => { root.render(tree(2, { ...props })) })
    expect(formatResetTime.mock.calls.length).toBe(first)
    // A real change still paints.
    act(() => { root.render(tree(3, { ...props, pct: 42 })) })
    expect(formatResetTime.mock.calls.length).toBeGreaterThan(first)
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42')
    act(() => { root.unmount() })
    container.remove()
  })
})
