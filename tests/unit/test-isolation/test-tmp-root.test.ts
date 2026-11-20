// The worker's temp root (tests/helpers/test-tmp.ts), aicc_planning #332.
//
// A worker that inherits the marker (CCC_TEST_TMP_ROOT) reuses the root it names. When
// that folder is gone, the worker makes a new root, and must then also point TEMP, TMP
// and TMPDIR at it and remove it at exit: before #332 it made the new root and did
// neither, so the run wrote into the machine temp folder and the root stayed there.
//
// Every case runs claimTestTmpRoot on a fake environment, a scratch folder inside this
// worker's own root and a recorded exit hook: nothing here changes this process's
// environment or registers a real exit listener.
import { afterAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { TEMP_VARS, TEST_TMP_ROOT, claimTestTmpRoot } from '../../helpers/test-tmp'

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-tmp-root-'))

afterAll(() => {
  // TEST CLEANUP GUARD: this file's own scratch folder only.
  if (path.basename(SCRATCH).startsWith('ccc-tmp-root-')) fs.rmSync(SCRATCH, { recursive: true, force: true })
})

type Env = Record<string, string | undefined>

/** Run the claim on `env`, making any new root in `tmp`; returns the root and the recorded exit calls. */
function claim(env: Env, tmp: string): { root: string; exits: Array<() => void> } {
  const exits: Array<() => void> = []
  const root = claimTestTmpRoot({ env, tmpdir: () => tmp, onExit: (fn) => exits.push(fn) })
  return { root, exits }
}

const inside = (p: string, dir: string): boolean => path.resolve(p).startsWith(path.resolve(dir) + path.sep)

describe('this worker', () => {
  it('runs with TEMP, TMP and TMPDIR on its own root', () => {
    for (const name of TEMP_VARS) expect(process.env[name], name).toBe(TEST_TMP_ROOT)
    expect(process.env.TMUX_TMPDIR).toBe(TEST_TMP_ROOT)
    expect(os.tmpdir()).toBe(TEST_TMP_ROOT)
  })
})

describe('claimTestTmpRoot', () => {
  it('with no marker: makes a root, points the marker and the three variables at it, and removes it at exit', () => {
    const env: Env = { TEMP: SCRATCH, TMP: SCRATCH, TMPDIR: SCRATCH }
    const { root, exits } = claim(env, SCRATCH)
    expect(inside(root, SCRATCH)).toBe(true)
    expect(path.basename(root).startsWith('ccc-vitest-')).toBe(true)
    expect(env.CCC_TEST_TMP_ROOT).toBe(root)
    for (const name of TEMP_VARS) expect(env[name], name).toBe(root)
    // tmux's own temp variable (it never reads TMPDIR).
    expect(env.TMUX_TMPDIR).toBe(root)
    expect(exits).toHaveLength(1)
    exits[0]()
    expect(fs.existsSync(root)).toBe(false)
  })

  it('with a marker that names a folder that exists: reuses it and changes nothing', () => {
    const own = fs.mkdtempSync(path.join(SCRATCH, 'own-'))
    const env: Env = { CCC_TEST_TMP_ROOT: own, TEMP: own, TMP: own, TMPDIR: own }
    const before = { ...env }
    const { root, exits } = claim(env, own)
    expect(root).toBe(own)
    expect(env).toEqual(before)
    expect(exits).toHaveLength(0)
  })

  it('with a marker that names a folder that is gone: the three variables end inside a new root that is removed at exit', () => {
    const gone = path.join(SCRATCH, 'gone-root')
    const env: Env = { CCC_TEST_TMP_ROOT: gone, TEMP: SCRATCH, TMP: SCRATCH, TMPDIR: SCRATCH }
    const { root, exits } = claim(env, SCRATCH)
    expect(root).not.toBe(gone)
    expect(fs.existsSync(root)).toBe(true)
    expect(inside(root, SCRATCH)).toBe(true)
    expect(env.CCC_TEST_TMP_ROOT).toBe(root)
    for (const name of TEMP_VARS) expect(env[name], name).toBe(root)
    expect(exits).toHaveLength(1)
    exits[0]()
    expect(fs.existsSync(root)).toBe(false)
  })

  it('with a marker that names a folder that is gone and the variables still naming it: the new root is made beside it', () => {
    // The usual way to get here: the marker and the variables were set together, so
    // os.tmpdir() is the gone folder too. A root made inside it could not be made at all.
    const gone = path.join(SCRATCH, 'gone-and-current')
    const env: Env = { CCC_TEST_TMP_ROOT: gone, TEMP: gone, TMP: gone, TMPDIR: gone }
    const { root, exits } = claim(env, gone)
    expect(path.dirname(root)).toBe(SCRATCH)
    for (const name of TEMP_VARS) expect(env[name], name).toBe(root)
    expect(exits).toHaveLength(1)
    exits[0]()
    expect(fs.existsSync(root)).toBe(false)
  })
})
