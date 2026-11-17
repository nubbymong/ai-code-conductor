import { describe, it, expect, vi, afterEach } from 'vitest'

// The one process-liveness check of the main process (PR #705 review): the PTY
// manager's help-folder runs and the session helper's agent clear both ask it.
// PURE: process.kill is a spy; no process is signalled.
import { processGone } from '../../../src/main/process-alive'

afterEach(() => {
  vi.restoreAllMocks()
})

const failsWith = (code: string) => vi.spyOn(process, 'kill').mockImplementation(() => {
  throw Object.assign(new Error(code), { code })
})

describe('processGone', () => {
  it('gone only when signal 0 says no such process (ESRCH)', () => {
    const kill = failsWith('ESRCH')
    expect(processGone(4321)).toBe(true)
    expect(kill).toHaveBeenCalledWith(4321, 0)
  })

  it('a process that answers, or one that cannot be asked about, is not gone', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(processGone(4321)).toBe(false)
    vi.restoreAllMocks()
    failsWith('EPERM')
    expect(processGone(4321)).toBe(false)
  })

  it('an id that is not a whole positive number is never asked about, and is not gone', () => {
    const kill = vi.spyOn(process, 'kill')
    for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '4321', undefined, null]) expect(processGone(pid), String(pid)).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })
})
