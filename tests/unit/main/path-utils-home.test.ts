import { describe, it, expect } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { isHomeOrAncestor, isHomeOrAncestorAsync } from '../../../src/main/path-utils'

/**
 * SECURITY (adversarial review, #188): isHomeOrAncestor is the guard that keeps
 * codex_review off the home directory and its ancestors — a `===` string compare
 * was bypassable on Windows by a case-variant or junction form of home.
 */
describe('isHomeOrAncestor', () => {
  const home = os.homedir()

  it('is true for the exact home directory', () => {
    expect(isHomeOrAncestor(home)).toBe(true)
  })

  it('is true for an ancestor of home (parent dir)', () => {
    const parent = path.dirname(home)
    // Only assert when home genuinely has a parent (not a drive root).
    if (parent !== home) expect(isHomeOrAncestor(parent)).toBe(true)
  })

  it('is false for a subdirectory of home (a real project dir)', () => {
    expect(isHomeOrAncestor(path.join(home, 'some-project'))).toBe(false)
  })

  it('is false for an unrelated temp directory', () => {
    const tmp = os.tmpdir()
    // tmp is only a valid negative if it isn't itself an ancestor of home.
    if (!home.toLowerCase().startsWith(tmp.toLowerCase())) {
      expect(isHomeOrAncestor(tmp)).toBe(false)
    }
  })

  it('catches a case-variant of home on case-insensitive platforms (Windows)', () => {
    if (process.platform !== 'win32') return
    const variant = home.toLowerCase()
    if (variant !== home) expect(isHomeOrAncestor(variant)).toBe(true)
  })

  it('catches the trailing-separator form of home', () => {
    expect(isHomeOrAncestor(home + path.sep)).toBe(true)
  })

  it('catches the UNC admin-share form of home on Windows (identity, not string)', () => {
    if (process.platform !== 'win32') return
    const m = /^([A-Za-z]):\\(.*)$/.exec(home)
    if (!m) return
    const unc = `\\\\localhost\\${m[1]}$\\${m[2]}`  // \\localhost\C$\Users\me
    // Only assert when the admin share is actually reachable in this environment;
    // its dev:ino must match the drive-letter form, which the string compare missed.
    let reachable = false
    try { reachable = fs.statSync(unc).isDirectory() } catch { reachable = false }
    if (reachable) expect(isHomeOrAncestor(unc)).toBe(true)
  })
})

/**
 * 2.1.3-beta.6: the Codex resume look asks the same question off the main
 * thread. It must give the answer the synchronous guard gives, for every
 * spelling the guard is tested with above.
 */
describe('isHomeOrAncestorAsync answers as isHomeOrAncestor does', () => {
  const home = os.homedir()
  const spellings: Array<[string, string]> = [
    ['the home folder', home],
    ['home with a trailing separator', home + path.sep],
    ['the parent of home', path.dirname(home)],
    ['a project under home', path.join(home, 'some-project')],
    ['the temp folder', os.tmpdir()],
    ['a folder that does not exist', path.join(os.tmpdir(), 'ccc-no-such-folder-' + process.pid, 'x')],
    ['a case variant of home', home.toLowerCase()],
  ]
  for (const [name, spelling] of spellings) {
    it(`${name}`, async () => {
      expect(await isHomeOrAncestorAsync(spelling)).toBe(isHomeOrAncestor(spelling))
    })
  }

  it('is true for home itself and false for a project under it (so the parity above is not two falses)', async () => {
    expect(await isHomeOrAncestorAsync(home)).toBe(true)
    expect(await isHomeOrAncestorAsync(path.join(home, 'some-project'))).toBe(false)
  })
})
