/**
 * The helper's own copy on this computer (2.1.3-beta.6, plan section B):
 * where it lives for an installed app and for a dev run, how a file another
 * program still has open is waited for, and which old version folders go.
 *
 * PURE: path rules over fixed inputs, a fake sleep, and a temp folder of
 * empty folders.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BUSY_WAIT_MS, helperRootDir, removeOldVersionFolders, retryWhileBusy } from '../../../src/main/session-helper/install'

const failure = (code: string) => Object.assign(new Error(`${code}: the file is in use`), { code })

describe('retryWhileBusy', () => {
  it('a file another program has open is waited for, a little longer each time, then the step runs', async () => {
    const sleeps: number[] = []
    const codes = ['EPERM', 'EBUSY', 'EACCES']
    let calls = 0
    const value = await retryWhileBusy(async () => {
      const code = codes[calls++]
      if (code) throw failure(code)
      return 'done'
    }, { sleep: async (ms) => { sleeps.push(ms) } })
    expect(value).toBe('done')
    expect(calls).toBe(4)
    expect(sleeps).toEqual([50, 100, 200])
  })

  it('any other failure is thrown at once', async () => {
    const sleeps: number[] = []
    await expect(retryWhileBusy(async () => { throw failure('ENOENT') }, { sleep: async (ms) => { sleeps.push(ms) } })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(sleeps).toEqual([])
  })

  it('a file still busy at the end is thrown as it is, after waits that add up to no more than the limit', async () => {
    const sleeps: number[] = []
    await expect(retryWhileBusy(async () => { throw failure('EBUSY') }, { forMs: 1000, sleep: async (ms) => { sleeps.push(ms) } })).rejects.toMatchObject({ code: 'EBUSY' })
    expect(sleeps).toEqual([50, 100, 200, 400])
    const all: number[] = []
    await expect(retryWhileBusy(async () => { throw failure('EPERM') }, { sleep: async (ms) => { all.push(ms) } })).rejects.toMatchObject({ code: 'EPERM' })
    const waited = all.reduce((a, b) => a + b, 0)
    expect(waited).toBeLessThanOrEqual(BUSY_WAIT_MS)
    expect(waited).toBeGreaterThan(BUSY_WAIT_MS - 1000)
    expect(Math.max(...all)).toBe(1000)
  })
})

describe('helperRootDir', () => {
  const win = { platform: 'win32' as const, home: 'C:\\Users\\someone' }

  it('an installed app: the per-user folder that does not roam', () => {
    expect(helperRootDir({ ...win, env: { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' }, isPackaged: true })).toBe('C:\\Users\\someone\\AppData\\Local\\AI Code Conductor\\helper')
    expect(helperRootDir({ ...win, env: {}, isPackaged: true })).toBe('C:\\Users\\someone\\AppData\\Local\\AI Code Conductor\\helper')
    expect(helperRootDir({ platform: 'darwin', home: '/Users/someone', env: {}, isPackaged: true })).toBe('/Users/someone/Library/Application Support/AI Code Conductor/helper')
    expect(helperRootDir({ platform: 'linux', home: '/home/someone', env: {}, isPackaged: true })).toBe('/home/someone/.ai-code-conductor/helper')
  })

  it('a dev run never uses the installed app\'s folder: its own data folder, or a dev folder of its own', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' }
    expect(helperRootDir({ ...win, env, isPackaged: false })).toBe('C:\\Users\\someone\\AppData\\Local\\AI Code Conductor\\helper\\dev')
    expect(helperRootDir({ ...win, env: { ...env, CCC_DEV_DATA_DIR: 'D:\\dev-data' }, isPackaged: false })).toBe('D:\\dev-data\\helper')
    expect(helperRootDir({ platform: 'darwin', home: '/Users/someone', env: {}, isPackaged: false })).toBe('/Users/someone/Library/Application Support/AI Code Conductor/helper/dev')
  })

  it('an installed app ignores a dev data folder; an end-to-end run uses its own', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local', CCC_DEV_DATA_DIR: 'D:\\dev-data' }
    expect(helperRootDir({ ...win, env, isPackaged: true })).toBe('C:\\Users\\someone\\AppData\\Local\\AI Code Conductor\\helper')
    expect(helperRootDir({ ...win, env: { ...env, CCC_E2E_DATA_DIR: 'E:\\e2e' }, isPackaged: true })).toBe('E:\\e2e\\helper')
  })
})

describe('removeOldVersionFolders', () => {
  let root: string | undefined
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  it('removes every version folder but the current one and the versions listed holders run, and leaves everything else alone', async () => {
    root = mkdtempSync(join(tmpdir(), 'aicc-helper-folders-'))
    const current = join(root, `0.1.0-${'f'.repeat(12)}`)
    const folders = [
      `0.1.0-${'f'.repeat(12)}`, // current
      '0.1.0-aaaaaaaaaaaa', // the same version with another hash
      '0.0.9-bbbbbbbbbbbb', // a listed holder runs 0.0.9
      '0.0.8-cccccccccccc',
      '0.2.0-beta.1-dddddddddddd',
      '0.3.0-rc.2-999999999999', // a listed holder runs 0.3.0-rc.2
      '.new-0123456789ab', // a staging folder a failed copy left
      'store',
      'dev',
      '0.1.0-not-a-hash',
    ]
    for (const f of folders) mkdirSync(join(root, f))
    writeFileSync(join(root, '0.0.7-eeeeeeeeeeee'), 'a file, not a folder')
    const removed = await removeOldVersionFolders(root, current, new Set(['0.0.9', '0.3.0-rc.2']))
    expect([...removed].sort()).toEqual(['.new-0123456789ab', '0.0.8-cccccccccccc', '0.1.0-aaaaaaaaaaaa', '0.2.0-beta.1-dddddddddddd'])
    expect(readdirSync(root).sort()).toEqual(['0.0.7-eeeeeeeeeeee', '0.0.9-bbbbbbbbbbbb', '0.1.0-ffffffffffff', '0.1.0-not-a-hash', '0.3.0-rc.2-999999999999', 'dev', 'store'])
  })

  it('a root that is not there yet removes nothing', async () => {
    const missing = join(tmpdir(), `aicc-helper-missing-${process.pid}-${Date.now()}`)
    expect(existsSync(missing)).toBe(false)
    expect(await removeOldVersionFolders(missing, join(missing, '0.1.0-ffffffffffff'), new Set())).toEqual([])
  })
})
