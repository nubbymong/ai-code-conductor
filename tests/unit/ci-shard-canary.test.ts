import { describe, it, expect } from 'vitest'

// A canary that fails on purpose, on Windows only: it lands in one of the four
// Windows CI parts, and that part failing must fail the required check
// `Test (windows-2025)` (2.1.3-beta.6, section D). Removed in the next commit.
describe.runIf(process.platform === 'win32')('ci shard canary', () => {
  it('fails on purpose', () => {
    expect(1).toBe(2)
  })
})
