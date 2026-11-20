/**
 * The data root of a dev or end-to-end run (aicc_planning#335): one function
 * holds the rule that devSessionDataDir, helperRootDir and instanceRecordPath
 * follow. `CCC_E2E_DATA_DIR` first, packaged or not; else `CCC_DEV_DATA_DIR`
 * when the app is not packaged; a full (absolute) path only, by the rules of
 * the platform named, or of this computer when none is.
 *
 * PURE: fixed inputs, no files, no Electron.
 */
import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { devDataRoot } from '../../../src/main/dev-data-root'

/** A full path on this computer, whichever it is. */
const hostAbs = path.join(process.platform === 'win32' ? 'C:\\' : '/', 'data', 'dev')

describe('devDataRoot', () => {
  it('no root at all: undefined, packaged or not', () => {
    expect(devDataRoot({}, true)).toBeUndefined()
    expect(devDataRoot({}, false)).toBeUndefined()
    expect(devDataRoot({}, false, 'win32')).toBeUndefined()
    expect(devDataRoot({}, false, 'linux')).toBeUndefined()
  })

  it('an empty variable is no root', () => {
    expect(devDataRoot({ CCC_E2E_DATA_DIR: '' }, false, 'win32')).toBeUndefined()
    expect(devDataRoot({ CCC_DEV_DATA_DIR: '' }, false, 'linux')).toBeUndefined()
    // An empty end-to-end root is passed over: the dev root then applies.
    expect(devDataRoot({ CCC_E2E_DATA_DIR: '', CCC_DEV_DATA_DIR: '/srv/dev' }, false, 'linux')).toBe('/srv/dev')
  })

  it('the end-to-end root is used packaged or not, and before the dev root', () => {
    expect(devDataRoot({ CCC_E2E_DATA_DIR: 'E:\\e2e' }, true, 'win32')).toBe('E:\\e2e')
    expect(devDataRoot({ CCC_E2E_DATA_DIR: 'E:\\e2e' }, false, 'win32')).toBe('E:\\e2e')
    expect(devDataRoot({ CCC_E2E_DATA_DIR: '/tmp/e2e', CCC_DEV_DATA_DIR: '/srv/dev' }, false, 'linux')).toBe('/tmp/e2e')
    expect(devDataRoot({ CCC_E2E_DATA_DIR: '/tmp/e2e', CCC_DEV_DATA_DIR: '/srv/dev' }, true, 'darwin')).toBe('/tmp/e2e')
  })

  it('the dev root is used only when the app is not packaged', () => {
    expect(devDataRoot({ CCC_DEV_DATA_DIR: 'D:\\dev-data' }, false, 'win32')).toBe('D:\\dev-data')
    expect(devDataRoot({ CCC_DEV_DATA_DIR: 'D:\\dev-data' }, true, 'win32')).toBeUndefined()
    expect(devDataRoot({ CCC_DEV_DATA_DIR: '/srv/dev' }, false, 'darwin')).toBe('/srv/dev')
    expect(devDataRoot({ CCC_DEV_DATA_DIR: '/srv/dev' }, true, 'darwin')).toBeUndefined()
  })

  it('a relative root is not full on any platform: null', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(devDataRoot({ CCC_DEV_DATA_DIR: 'rel/x' }, false, platform)).toBeNull()
      expect(devDataRoot({ CCC_DEV_DATA_DIR: './dev' }, false, platform)).toBeNull()
      expect(devDataRoot({ CCC_E2E_DATA_DIR: 'rel/x' }, true, platform)).toBeNull()
    }
    expect(devDataRoot({ CCC_DEV_DATA_DIR: 'rel\\x' }, false, 'win32')).toBeNull()
  })

  it('a drive-letter root is full on Windows and is not on macOS or Linux', () => {
    expect(devDataRoot({ CCC_DEV_DATA_DIR: 'C:\\x' }, false, 'win32')).toBe('C:\\x')
    expect(devDataRoot({ CCC_DEV_DATA_DIR: 'C:\\x' }, false, 'linux')).toBeNull()
    expect(devDataRoot({ CCC_DEV_DATA_DIR: 'C:\\x' }, false, 'darwin')).toBeNull()
    // A drive letter with no separator after it is relative to that drive's
    // current folder, so it is not full on Windows either.
    expect(devDataRoot({ CCC_DEV_DATA_DIR: 'C:x' }, false, 'win32')).toBeNull()
    // A POSIX full path is full on every platform.
    expect(devDataRoot({ CCC_DEV_DATA_DIR: '/srv/dev' }, false, 'linux')).toBe('/srv/dev')
    expect(devDataRoot({ CCC_DEV_DATA_DIR: '/srv/dev' }, false, 'win32')).toBe('/srv/dev')
  })

  it('a relative end-to-end root is never swapped for the dev root', () => {
    expect(devDataRoot({ CCC_E2E_DATA_DIR: 'rel/e2e', CCC_DEV_DATA_DIR: 'D:\\dev-data' }, false, 'win32')).toBeNull()
    expect(devDataRoot({ CCC_E2E_DATA_DIR: 'rel/e2e', CCC_DEV_DATA_DIR: '/srv/dev' }, false, 'linux')).toBeNull()
  })

  it('with no platform named, this computer\'s rules decide', () => {
    expect(devDataRoot({ CCC_DEV_DATA_DIR: hostAbs }, false)).toBe(hostAbs)
    expect(devDataRoot({ CCC_DEV_DATA_DIR: 'rel/x' }, false)).toBeNull()
    const driveLetter = devDataRoot({ CCC_DEV_DATA_DIR: 'C:\\x' }, false)
    expect(driveLetter).toBe(process.platform === 'win32' ? 'C:\\x' : null)
  })
})
