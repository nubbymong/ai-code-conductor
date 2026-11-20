// One disposable temp root per test worker (#559).
//
// Redirecting TEMP/TMP/TMPDIR here means every `fs.mkdtempSync(os.tmpdir(),
// 'ccc-...')` fixture across the suite lands *inside* this root instead of
// littering the real %TEMP% (a full run was leaking ~88 GB of `ccc-*` dirs that
// nothing ever cleaned up). MOCK_RESOURCES / MOCK_USERDATA give the electron
// mocks a real, writable path under the same root instead of the drive-relative
// literal '/mock/resources' — which on Windows resolved to `<drive>:\mock` and
// wrote real files (a conductor-secret.json) to the drive root.
//
// The root is created once per worker (keyed through the environment so every
// test file in the worker shares it) and removed on process exit;
// tests/global-setup.ts removes any orphan of THIS run left by a killed worker.
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { runTempPrefix } from './vitest-run-tag.mjs'

const KEY = 'CCC_TEST_TMP_ROOT'
/** The variables os.tmpdir() reads, all pointed at the root. */
export const TEMP_VARS = Object.freeze(['TMPDIR', 'TEMP', 'TMP'] as const)

export interface TestTmpRootDeps {
  /** The environment to read the marker from and redirect (process.env in a run). */
  env: Record<string, string | undefined>
  /** The folder a new root is made in (os.tmpdir() in a run). */
  tmpdir: () => string
  /** Registers a call for when the process exits (process.once('exit') in a run). */
  onExit: (fn: () => void) => void
}

/**
 * The worker's temp root. A root the marker names that still exists is reused: an
 * earlier file in this worker made it and set it up (no duplicate 'exit' listeners, so
 * no MaxListeners warning). Otherwise this call owns setup: it makes a root, pins it in
 * the environment, points the temp variables at it and registers one exit-time
 * removal. That includes a marker naming a folder that is gone (#332), whose new root
 * goes beside the gone one when the temp variables still name it.
 */
export function claimTestTmpRoot({ env, tmpdir, onExit }: TestTmpRootDeps): string {
  const existing = env[KEY]
  if (existing && fs.existsSync(existing)) return existing
  let parent = tmpdir()
  if (existing && !fs.existsSync(parent) && fs.existsSync(path.dirname(existing))) parent = path.dirname(existing)
  // Named `ccc-vitest-<run tag>-...`: the teardown removes only this run's roots.
  const root = fs.mkdtempSync(path.join(parent, runTempPrefix('', env)))
  env[KEY] = root
  for (const name of TEMP_VARS) env[name] = root
  // tmux keeps its socket folder (tmux-<uid>) in TMUX_TMPDIR, else in /tmp, and never
  // reads TMPDIR: a test that reaches a real tmux client (ssh-liveness-r8 runs the
  // production probe, which tries /usr/bin/tmux) left /tmp/tmux-1001 on the Ubuntu
  // runner (#332, measured in CI).
  env.TMUX_TMPDIR = root
  onExit(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* best-effort; global-setup teardown is the backstop */
    }
  })
  return root
}

export const TEST_TMP_ROOT = claimTestTmpRoot({
  env: process.env,
  tmpdir: os.tmpdir,
  onExit: (fn) => {
    process.once('exit', fn)
  },
})

export const MOCK_RESOURCES = path.join(TEST_TMP_ROOT, 'resources')
export const MOCK_USERDATA = path.join(TEST_TMP_ROOT, 'userData')
