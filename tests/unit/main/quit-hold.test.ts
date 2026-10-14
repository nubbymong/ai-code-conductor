// The before-quit teardown's hold (quit-hold.ts): null
// while the app runs; from the teardown on, an answer that never comes, with
// one line logged the first time. The teardown sets it through the same call
// that latches the first-start warm-up (flushFirstStartWarmups), so the two
// begin together. Which starts read it is pinned beside each of them
// (first-start-setup-terminal, setup-terminal-quit-teardown, first-start-
// headless, first-start-cloud-agent, first-start-auth-status).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const logged = vi.hoisted(() => [] as string[])
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (...a: unknown[]) => { logged.push(a.map(String).join(' ')) },
  logWarn: () => {},
  logError: () => {},
}))

const { quitHold, beginQuitHold, _resetQuitHoldForTest } = await import('../../../src/main/quit-hold')

/** 'pending' when `p` has not settled once every step it could take has run. */
async function stateOf(p: Promise<unknown>): Promise<'pending' | 'settled'> {
  return Promise.race([p.then(() => 'settled' as const, () => 'settled' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), 20))])
}

beforeEach(() => {
  _resetQuitHoldForTest()
  logged.length = 0
})

describe('the quit hold', () => {
  it('is nothing while the app runs: the caller goes on to its own start', () => {
    expect(quitHold('a start')).toBeNull()
    expect(logged).toEqual([])
  })

  it('from the teardown on, every caller gets an answer that never comes, and the first one is logged once', async () => {
    beginQuitHold()
    const first = quitHold<string>('the Claude Code setup terminal')
    const second = quitHold<string>('a cloud agent')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(await stateOf(first!)).toBe('pending')
    expect(await stateOf(second!)).toBe('pending')
    expect(logged).toEqual(['[quit] the app is quitting: the Claude Code setup terminal is held and starts nothing'])
  })

  it('is set by the teardown\'s flush of the first-start warm-ups, the same call that latches the warm-up', async () => {
    const { flushFirstStartWarmups } = await vi.importActual<typeof import('../../../src/main/first-start-warmup')>('../../../src/main/first-start-warmup')
    expect(quitHold('a start')).toBeNull()
    flushFirstStartWarmups()
    const held = quitHold('a start')
    expect(held).not.toBeNull()
    expect(await stateOf(held!)).toBe('pending')
  })
})
