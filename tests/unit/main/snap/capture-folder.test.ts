import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { makePressFolder, removePressFolder, isPressFolder, CAPTURE_PARENT } from '../../../../src/main/snap/capture-folder'
import { snapHelperPath, SNAP_TEST_HELPER_ENV } from '../../../../src/main/snap/helper-path'

/**
 * Where a Snap press's pictures go, and which helper it runs (plan
 * 2.1.3-beta.16 A1, aicc_planning#401). The folder tests use the real file
 * system inside a folder of the test's own, removed after each test.
 * Not checked here: the user data folder Electron names (snap-e2e reads it).
 */

let root: string
let parent: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-folder-test-'))
  parent = path.join(root, 'userData', CAPTURE_PARENT)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the press folder: made fresh under the app\'s own folder, removed with its pictures', () => {
  it('makes an empty press folder inside the parent, making the parent', () => {
    const folder = makePressFolder(parent)
    expect(path.dirname(folder)).toBe(parent)
    expect(path.basename(folder)).toMatch(/^press-/)
    expect(fs.readdirSync(folder)).toEqual([])
    expect(isPressFolder(parent, folder)).toBe(true)
  })

  it('removes the press folder with its pictures, and the parent when that leaves it empty', () => {
    const folder = makePressFolder(parent)
    fs.writeFileSync(path.join(folder, 'display-1.bmp'), 'x')
    removePressFolder(parent, folder)
    expect(fs.existsSync(folder)).toBe(false)
    expect(fs.existsSync(parent)).toBe(false)
    // Twice is harmless.
    removePressFolder(parent, folder)
  })

  it('removes a press folder an earlier run left, and only press folders', () => {
    fs.mkdirSync(path.join(parent, 'press-old'), { recursive: true })
    fs.writeFileSync(path.join(parent, 'press-old', 'display-1.bmp'), 'x')
    fs.mkdirSync(path.join(parent, 'keep-me'))
    const folder = makePressFolder(parent)
    expect(fs.readdirSync(parent).sort()).toEqual(['keep-me', path.basename(folder)].sort())
    removePressFolder(parent, folder)
    // The parent is not empty: it stays, and what is not a press folder stays.
    expect(fs.readdirSync(parent)).toEqual(['keep-me'])
  })

  it('never removes what is not a press folder directly inside the parent', () => {
    const outside = path.join(root, 'press-outside')
    fs.mkdirSync(outside)
    const nested = path.join(parent, 'press-a', 'press-b')
    fs.mkdirSync(nested, { recursive: true })
    for (const f of [outside, nested, parent, path.join(parent, '..', CAPTURE_PARENT), path.join(parent, 'other')]) {
      expect(isPressFolder(parent, f), f).toBe(false)
      removePressFolder(parent, f)
    }
    expect(fs.existsSync(outside)).toBe(true)
    expect(fs.existsSync(nested)).toBe(true)
  })
})

describe('snapHelperPath: the helper beside the app, or the test-only path in an app that is not packaged', () => {
  const bundled = 'C:\\Program Files\\AI Code Conductor\\resources\\helper\\aicc-helper.exe'
  const forced = 'D:\\a\\repo\\helper\\target\\release\\aicc-helper.exe'

  it('a packaged app ignores the test-only path and runs the helper beside it', () => {
    expect(snapHelperPath({ isPackaged: true, env: { [SNAP_TEST_HELPER_ENV]: forced }, bundled, exists: () => true })).toBe(bundled)
    expect(snapHelperPath({ isPackaged: true, env: { [SNAP_TEST_HELPER_ENV]: forced }, bundled, exists: () => false })).toBeNull()
  })

  it('an app that is not packaged runs the test-only path when it is set and absolute', () => {
    expect(SNAP_TEST_HELPER_ENV).toBe('CCC_E2E_SNAP_HELPER')
    expect(snapHelperPath({ isPackaged: false, env: { [SNAP_TEST_HELPER_ENV]: path.resolve(forced) }, bundled, exists: () => false })).toBe(path.resolve(forced))
    expect(snapHelperPath({ isPackaged: false, env: { [SNAP_TEST_HELPER_ENV]: 'aicc-helper.exe' }, bundled, exists: () => true })).toBeNull()
  })

  it('with no test-only path, the helper beside the app when it is there', () => {
    expect(snapHelperPath({ isPackaged: false, env: {}, bundled, exists: (p) => p === bundled })).toBe(bundled)
    expect(snapHelperPath({ isPackaged: false, env: {}, bundled, exists: () => false })).toBeNull()
  })
})
