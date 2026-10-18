// aicc_planning#304: a statusline tick whose values equal the stored ones
// leaves the sessions array (and the session object) as they were, even
// though usageBuckets and rateLimitExtra arrive as fresh objects every tick.
import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionStore, sameStatusValue } from '../../../src/renderer/stores/sessionStore'
import type { Session } from '../../../src/renderer/stores/sessionStore'

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
