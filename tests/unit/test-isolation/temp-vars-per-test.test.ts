// The per-test check on the temp variables (tests/helpers/home-isolation.ts), #332.
//
// home-isolation (setupFiles[0]) points TEMP, TMP and TMPDIR back at the worker's temp
// folder before every test, and fails a test that leaves one of them unset or pointing
// outside it. Each case here is a fake test that moves a variable and does not put it
// back. It is declared `it.fails`, so it passes only when the setup file's afterEach
// fails it, and it records the failure's message. The tests after it check that the
// message names the variable and that the variable is back on the worker's folder.
// vitest runs a file's tests in the order written, which these cases rely on.
//
// A moved value is a path string only: nothing is made there, and nothing here reads
// or writes outside this worker's temp folder.
import { afterAll, describe, expect, it } from 'vitest'
import * as path from 'path'
import { TEMP_VARS, TEST_TMP_ROOT } from '../../helpers/test-tmp'

const ELSEWHERE = path.join(path.dirname(TEST_TMP_ROOT), 'ccc-not-the-worker-temp-folder')
const saved: Record<string, string | undefined> = Object.fromEntries(TEMP_VARS.map((n) => [n, process.env[n]]))

afterAll(() => {
  // Without the check (a red run), a moved value would carry into the next file in this worker.
  for (const name of TEMP_VARS) process.env[name] = saved[name]
})

type Ctx = { onTestFailed: (fn: (ctx: { task: { result?: { errors?: Array<{ message?: string }> } } }) => void) => void }

/** Record the message of the failure the afterEach check raises for this test. */
function recordFailure(ctx: Ctx, into: { text: string }): void {
  ctx.onTestFailed(({ task }) => {
    into.text = (task.result?.errors ?? []).map((e) => String(e.message)).join('\n')
  })
}

for (const name of TEMP_VARS) {
  describe(`a test that leaves ${name} pointing outside the worker's temp folder`, () => {
    const failure = { text: '' }
    it.fails(`is failed (it points ${name} elsewhere and does not put it back)`, (ctx) => {
      recordFailure(ctx as unknown as Ctx, failure)
      process.env[name] = ELSEWHERE
    })
    it(`is failed with a sentence that names ${name} and where it pointed`, () => {
      expect(failure.text).toContain(`left ${name} at ${ELSEWHERE}`)
    })
    it(`and the next test starts with ${name} back on the worker's temp folder`, () => {
      expect(process.env[name]).toBe(TEST_TMP_ROOT)
    })
  })
}

describe('a test that leaves TEMP unset', () => {
  const failure = { text: '' }
  it.fails('is failed', (ctx) => {
    recordFailure(ctx as unknown as Ctx, failure)
    delete process.env.TEMP
  })
  it('is failed with a sentence that names TEMP', () => {
    expect(failure.text).toContain('left TEMP unset')
  })
  it('and the next test starts with TEMP back on the worker\'s temp folder', () => {
    expect(process.env.TEMP).toBe(TEST_TMP_ROOT)
  })
})

describe('a test that points TEMP at a folder inside the worker\'s temp folder', () => {
  const own = path.join(TEST_TMP_ROOT, 'own-temp')
  it('is not failed', () => {
    process.env.TEMP = own
  })
  it('and the value is kept, as a home variable inside the isolated folder is', () => {
    expect(process.env.TEMP).toBe(own)
  })
})
