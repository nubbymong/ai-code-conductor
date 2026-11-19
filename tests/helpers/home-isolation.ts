// Tests never act on a real home.
//
// The FIRST setup file of every vitest run (setupFiles[0] in vitest.config.ts and
// vitest.native.config.ts). It is a setupFiles entry rather than an import at the
// top of tests/unit/setup.ts because vitest hoists the vi.mock() calls in that file
// above its imports, and an import-sorting edit could move it; the setupFiles order
// is the one ordering vitest guarantees.
//
// It points the home variables (HOME_VARS in home-guard-core.mjs; HOMEDRIVE/HOMEPATH
// on Windows, the XDG folders elsewhere) at a fresh folder per worker, re-asserts
// them before every test, and installs the guard in home-guard-core.mjs. It does the
// same for TEMP, TMP and TMPDIR with the worker's temp folder (tests/helpers/test-tmp.ts,
// #332), and a test that leaves one of them unset or pointing outside that folder fails
// in afterEach, with the variable named; the next test starts with it put back. A value
// inside the worker's temp folder is kept. That file
// lists what the guard covers and what it does not. A refusal the code under test
// catches still fails the test in afterEach. Installing fails loudly if os.homedir()
// is not inside the isolated folder afterwards (a worker THREAD keeps its own copy
// of the environment: vitest.config.ts pins pool 'forks', and the native config
// already runs in forks).
//
// Not checked by the temp check (#332; add a line when a review finds one):
//   - a value put back after afterEach (a cleanup returned from beforeEach, an
//     onTestFinished callback, a test.extend fixture's teardown): the test is failed
//     although it restores the value; restore it in the test or in an afterEach
//   - a value set at module level or in beforeAll: beforeEach puts it back without a
//     failure, so the tests run on the worker's folder, not on that value
//   - folders made while a temp variable pointed elsewhere and was put back in time:
//     they stay where they were made (the CI teardown line lists them)
//   - TMUX_TMPDIR and other programs' own temp variables, a child process given its
//     own env, and concurrent tests in one file that move a temp variable
//
// Not loaded by vitest.live.config.ts (the live SSH pack runs real ssh with the
// user's real keys) or by Playwright.
import * as fs from 'fs'
import * as path from 'path'
import { afterAll, afterEach, beforeEach } from 'vitest'
// Redirects TEMP/TMP/TMPDIR to the per-worker root; its parent is the original temp folder.
import { TEMP_VARS, TEST_TMP_ROOT } from './test-tmp'
import { assertNoViolations, installHomeGuard, pinDataDirectory, reassertHomeEnv } from './home-guard-core.mjs'

installHomeGuard({ entry: 'vitest', isolate: true, extraTmpRoots: [path.dirname(TEST_TMP_ROOT)] })

// The app's data folder (src/main/data-paths.ts) is the installed app's, under the real
// LOCALAPPDATA, unless CCC_E2E_DATA_DIR names one: pin it, per test file, to a fresh
// folder under the worker's temp root (an inherited value is kept only if it is already
// inside the isolated or temp area), so a test that keeps the real logger writes there.
// A test of data-paths itself deletes it locally (tests/unit/main/data-paths-dev.test.ts).
export const TEST_DATA_DIR_ENV = 'CCC_E2E_DATA_DIR'
const TEST_DATA_DIR = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'app-data-'))
const PINNED = Symbol.for('ccc.test-home-guard.data-dir')
const proc = process as unknown as Record<symbol, string | undefined>
// A folder an earlier test file in this worker was given is not kept for this one.
if (process.env[TEST_DATA_DIR_ENV] === proc[PINNED]) delete process.env[TEST_DATA_DIR_ENV]
proc[PINNED] = pinDataDirectory(TEST_DATA_DIR_ENV, TEST_DATA_DIR)

// TEMP, TMP and TMPDIR stay on the worker's temp folder (#332): os.tmpdir() reads them,
// so a test that moved one and never put it back would send every later fixture in this
// worker outside the folder that is removed at exit. Compared lexically (case folded on
// Windows and macOS) and, failing that, by real path, so another spelling of the same
// folder passes.
const FOLDS_CASE = process.platform === 'win32' || process.platform === 'darwin'
const pathKey = (p: string): string => (FOLDS_CASE ? path.resolve(p).toLowerCase() : path.resolve(p))
const realPath = (p: string): string | null => {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return null
  }
}
const within = (p: string, root: string): boolean => {
  const k = pathKey(p)
  const r = pathKey(root)
  return k === r || k.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}
function inWorkerTemp(value: string | undefined): boolean {
  if (!value) return false
  if (within(value, TEST_TMP_ROOT)) return true
  const real = realPath(value)
  const root = realPath(TEST_TMP_ROOT)
  return real !== null && root !== null && within(real, root)
}

/** Put each temp variable that is unset or outside the worker's temp folder back on it; returns one phrase per variable found. */
function putTempVarsBack(): string[] {
  const found: string[] = []
  for (const name of TEMP_VARS) {
    const value = process.env[name]
    if (inWorkerTemp(value)) continue
    found.push(value ? `left ${name} at ${value}` : `left ${name} unset`)
    process.env[name] = TEST_TMP_ROOT
  }
  return found
}

beforeEach(() => {
  reassertHomeEnv()
  putTempVarsBack()
  if (!process.env[TEST_DATA_DIR_ENV]) process.env[TEST_DATA_DIR_ENV] = TEST_DATA_DIR
})

afterEach(() => {
  const moved = putTempVarsBack()
  assertNoViolations('the test')
  if (moved.length > 0) {
    throw new Error(
      `The test ${moved.join(' and ')}, outside this worker's temp folder ${TEST_TMP_ROOT}. ` +
        'A test that changes TEMP, TMP or TMPDIR puts it back in the test itself or in an afterEach hook (a beforeEach cleanup or onTestFinished runs after this check); it has been put back for the next test.',
    )
  }
})

afterAll(() => {
  assertNoViolations('a suite hook')
})

export {
  VIOLATION_CODE,
  isolatedRoot,
  isRealHomePath,
  originalHomeEnv,
  realHomeRoots,
} from './home-guard-core.mjs'
