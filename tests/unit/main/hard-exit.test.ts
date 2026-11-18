/**
 * What every app.exit path runs first (src/main/hard-exit.ts, plan
 * 2.1.3-beta.8 section C2). app.exit skips before-quit, so the quit teardown
 * does not run on an update install or on SIGTERM: the vision browser the app
 * started is ended here instead, and the SIGTERM handler flushes the sessions,
 * flushes the indexing gaps, ends the browser and exits, in that order.
 * Nothing here starts a program: the browser's end is a fake step.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const steps = vi.hoisted(() => ({ order: [] as string[], endThrows: false }))

vi.mock('../../../src/main/vision-manager', () => ({
  killSpawnedBrowser: vi.fn(() => {
    steps.order.push('end the vision browser')
    if (steps.endThrows) throw new Error('the end failed')
  }),
}))

const { hardExitTeardown, exitOnSigterm } = await import('../../../src/main/hard-exit')

function deps(throwing: string[] = []) {
  const step = (name: string) => () => {
    steps.order.push(name)
    if (throwing.includes(name)) throw new Error(`${name} failed`)
  }
  return {
    flushSessions: step('flush the sessions'),
    flushIndexingGaps: step('flush the indexing gaps'),
    exit: (code: number) => { steps.order.push(`exit ${code}`) },
  }
}

beforeEach(() => {
  steps.order.length = 0
  steps.endThrows = false
})

describe('hardExitTeardown', () => {
  it('ends the vision browser the app started', () => {
    hardExitTeardown()
    expect(steps.order).toEqual(['end the vision browser'])
  })

  it('never throws, so it cannot stop the exit after it', () => {
    steps.endThrows = true
    expect(() => hardExitTeardown()).not.toThrow()
    expect(steps.order).toEqual(['end the vision browser'])
  })
})

describe('the SIGTERM exit', () => {
  it('flushes the sessions, flushes the indexing gaps, ends the browser, then exits with 0, in that order', () => {
    exitOnSigterm(deps())
    expect(steps.order).toEqual(['flush the sessions', 'flush the indexing gaps', 'end the vision browser', 'exit 0'])
  })

  it('a step that throws skips none of the ones after it: the exit always comes', () => {
    exitOnSigterm(deps(['flush the sessions', 'flush the indexing gaps']))
    expect(steps.order).toEqual(['flush the sessions', 'flush the indexing gaps', 'end the vision browser', 'exit 0'])
    steps.order.length = 0
    steps.endThrows = true
    exitOnSigterm(deps())
    expect(steps.order).toEqual(['flush the sessions', 'flush the indexing gaps', 'end the vision browser', 'exit 0'])
  })

  it("is the app's SIGTERM handler, with the session flush, the indexing gaps and app.exit passed in", () => {
    const src = readFileSync(resolve(__dirname, '../../../src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const at = src.indexOf("process.on('SIGTERM'")
    expect(at).toBeGreaterThan(-1)
    expect(src.indexOf("process.on('SIGTERM'", at + 1), 'one SIGTERM handler').toBe(-1)
    const handler = src.slice(at, src.indexOf('}))', at) + 3)
    expect(handler).toMatch(/^process\.on\('SIGTERM', \(\) => exitOnSigterm\(\{/)
    expect(handler).toContain("flushSessions: () => sessionDurability.flushOnExit('SIGTERM')")
    expect(handler).toContain('flushIndexingGaps: () => flushIndexingGaps()')
    expect(handler).toContain('exit: (code) => app.exit(code)')
    expect(src).toMatch(/^import \{ exitOnSigterm \} from '\.\/hard-exit'$/m)
  })
})
