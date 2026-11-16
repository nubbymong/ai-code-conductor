/**
 * The helper's own copy on this computer (2.1.3-beta.6, plan section B):
 * where it lives for an installed app and for a dev run, how a file another
 * program still has open is waited for, and which old version folders go.
 *
 * PURE: path rules over fixed inputs, a fake sleep, and a temp folder of
 * empty folders.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import {
  BUSY_WAIT_MS, CONPTY_FILES, CONPTY_FOLDER, bundledConptySource, checkedConpty, copyMatches, helperRootDir, installHelperCopy, removeOldVersionFolders, retryWhileBusy,
} from '../../../src/main/session-helper/install'

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

// Protocol change 2 (plan 2.1.3-beta.7 section A2): a holder that runs a
// terminal on the bundled ConPTY loads conpty.dll only from a `conpty` folder
// beside its own program file. So node-pty's conpty.dll and OpenConsole.exe
// are copied there, beside the helper's copy, and checked against node-pty's
// installed files before every use, as the helper's copy is. Missing or
// unusable files make only the bundled ConPTY unavailable, never the helper.
describe('the bundled ConPTY beside the helper copy', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  const sha = (text: string) => createHash('sha256').update(text).digest('hex')

  /** An install folder with the helper and node-pty's two files, and an empty per-user root. */
  function setUp() {
    dir = mkdtempSync(join(tmpdir(), 'aicc-helper-conpty-'))
    const install = join(dir, 'install')
    const source = join(install, 'node-pty', 'prebuilds', 'win32-x64', 'conpty')
    mkdirSync(source, { recursive: true })
    const bundled = join(install, 'aicc-helper.exe')
    writeFileSync(bundled, 'MZ the installed helper')
    writeFileSync(join(source, 'conpty.dll'), 'MZ node-pty conpty.dll')
    writeFileSync(join(source, 'OpenConsole.exe'), 'MZ node-pty OpenConsole.exe')
    const root = join(dir, 'helper')
    const opts = { bundled, root, version: '0.1.0', sha256: sha('MZ the installed helper'), platform: 'win32' as const }
    return { source, root, opts }
  }

  const leftovers = (root: string) => readdirSync(root).filter((n) => n.startsWith('.new-'))

  it('copies conpty.dll and OpenConsole.exe into a conpty folder beside the helper, and a check before use keeps a copy that matches', async () => {
    const { source, root, opts } = setUp()
    const info = await installHelperCopy({ ...opts, conptySource: source })
    expect(CONPTY_FILES).toEqual(['conpty.dll', 'OpenConsole.exe'])
    expect(info.conpty).toEqual({
      available: true,
      dir: join(info.folder, 'conpty'),
      source,
      sha256: { 'conpty.dll': sha('MZ node-pty conpty.dll'), 'OpenConsole.exe': sha('MZ node-pty OpenConsole.exe') },
    })
    expect(readdirSync(info.folder).sort()).toEqual(['aicc-helper.exe', 'conpty'])
    expect(readdirSync(join(info.folder, 'conpty')).sort()).toEqual(['OpenConsole.exe', 'conpty.dll'])
    for (const f of CONPTY_FILES) expect(readFileSync(join(info.folder, 'conpty', f), 'utf8')).toBe(readFileSync(join(source, f), 'utf8'))
    expect(leftovers(root)).toEqual([])
    expect(await checkedConpty(info)).toEqual(info.conpty)
    // A second start finds the copy in place and keeps it.
    const again = await installHelperCopy({ ...opts, conptySource: source })
    expect(again.conpty).toEqual(info.conpty)
  })

  it('a copy that no longer matches, or is gone, is copied again before it is used', async () => {
    const { source, root, opts } = setUp()
    const info = await installHelperCopy({ ...opts, conptySource: source })
    const copied = join(info.folder, 'conpty', 'conpty.dll')
    writeFileSync(copied, 'MZ changed after the copy')
    expect(await checkedConpty(info)).toEqual(info.conpty)
    expect(readFileSync(copied, 'utf8')).toBe('MZ node-pty conpty.dll')
    rmSync(join(info.folder, 'conpty'), { recursive: true, force: true })
    expect(await checkedConpty(info)).toEqual(info.conpty)
    expect(readFileSync(join(info.folder, 'conpty', 'OpenConsole.exe'), 'utf8')).toBe('MZ node-pty OpenConsole.exe')
    // Two checks at once that both find a mismatch share one copy.
    writeFileSync(copied, 'MZ changed again')
    const both = await Promise.all([checkedConpty(info), checkedConpty(info)])
    expect(both).toEqual([info.conpty, info.conpty])
    expect(readFileSync(copied, 'utf8')).toBe('MZ node-pty conpty.dll')
    expect(leftovers(root)).toEqual([])
    // A start that finds a copy that does not match makes it again.
    writeFileSync(copied, 'MZ changed before a start')
    expect((await installHelperCopy({ ...opts, conptySource: source })).conpty).toEqual(info.conpty)
    expect(readFileSync(copied, 'utf8')).toBe('MZ node-pty conpty.dll')
  })

  it('a copy that still does not match once made again leaves only the bundled ConPTY unavailable', async () => {
    const { source, opts } = setUp()
    const info = await installHelperCopy({ ...opts, conptySource: source })
    // node-pty's own file changed after it was hashed at start: the copy
    // made from it cannot match what was taken then.
    writeFileSync(join(source, 'OpenConsole.exe'), 'MZ changed in the install folder')
    writeFileSync(join(info.folder, 'conpty', 'OpenConsole.exe'), 'MZ changed after the copy')
    const checked = await checkedConpty(info)
    expect(checked.available).toBe(false)
    expect(checked.available ? '' : checked.reason).toMatch(/does not match/)
    expect(await copyMatches(info.exe, info.sha256)).toBe(true)
  })

  it('when node-pty\'s files are missing, only the bundled ConPTY is unavailable, not the helper', async () => {
    const { source, opts } = setUp()
    rmSync(join(source, 'OpenConsole.exe'))
    const info = await installHelperCopy({ ...opts, conptySource: source })
    expect(info.conpty.available).toBe(false)
    expect(info.conpty.available ? '' : info.conpty.reason).toContain('OpenConsole.exe')
    expect(await copyMatches(info.exe, info.sha256)).toBe(true)
    expect(readdirSync(info.folder)).toEqual(['aicc-helper.exe'])
    expect(await checkedConpty(info)).toEqual(info.conpty)
    // node-pty's conpty folder not found at all.
    const none = await installHelperCopy({ ...opts, conptySource: null })
    expect(none.conpty.available).toBe(false)
    expect(await copyMatches(none.exe, none.sha256)).toBe(true)
  })

  it('the folder and the files are the ones the holder loads from (helper/src/pty/windows.rs)', () => {
    const holder = readFileSync(join(__dirname, '../../../helper/src/pty/windows.rs'), 'utf8')
    expect(holder).toContain(`pub const BUNDLED_FOLDER: &str = "${CONPTY_FOLDER}";`)
    expect(holder).toContain('let dll = folder.join("conpty.dll");')
    expect(holder).toContain('plain_file(&folder.join("OpenConsole.exe"))?;')
    expect([...CONPTY_FILES]).toEqual(['conpty.dll', 'OpenConsole.exe'])
  })

  it('without a source nothing is copied, and macOS and Linux have no bundled ConPTY', async () => {
    const { source, opts } = setUp()
    const plain = await installHelperCopy(opts)
    expect(plain.conpty.available).toBe(false)
    expect(readdirSync(plain.folder)).toEqual(['aicc-helper.exe'])
    for (const platform of ['linux', 'darwin'] as const) {
      const info = await installHelperCopy({ ...opts, platform, conptySource: source })
      expect(info.conpty.available, platform).toBe(false)
      expect(existsSync(join(info.folder, 'conpty')), platform).toBe(false)
    }
  })
})

describe('bundledConptySource', () => {
  const lib = join(sep, 'app', 'node_modules', 'node-pty', 'lib')
  const prebuild = join(sep, 'app', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64')
  const release = join(sep, 'app', 'node_modules', 'node-pty', 'build', 'Release')
  const has = (...files: string[]) => (p: string) => files.includes(p)

  it('is node-pty\'s conpty folder beside the native module its loader finds first, as bundled-conpty.ts finds it', () => {
    expect(bundledConptySource({ platform: 'win32', arch: 'x64', nodePtyLibDir: lib, exists: has(join(prebuild, 'conpty.node')) })).toBe(join(prebuild, 'conpty'))
    expect(bundledConptySource({ platform: 'win32', arch: 'x64', nodePtyLibDir: lib, exists: has(join(prebuild, 'conpty.node'), join(release, 'conpty.node')) })).toBe(join(release, 'conpty'))
    // In a packaged app the native module is under app.asar.unpacked.
    const packed = join(sep, 'res', 'app.asar', 'node_modules', 'node-pty', 'lib')
    const unpacked = join(sep, 'res', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', 'win32-arm64')
    expect(bundledConptySource({ platform: 'win32', arch: 'arm64', nodePtyLibDir: packed, exists: has(join(unpacked, 'conpty.node')) })).toBe(join(unpacked, 'conpty'))
  })

  it('is null off Windows, without node-pty, or without its native module', () => {
    expect(bundledConptySource({ platform: 'linux', arch: 'x64', nodePtyLibDir: lib, exists: () => true })).toBeNull()
    expect(bundledConptySource({ platform: 'darwin', arch: 'arm64', nodePtyLibDir: lib, exists: () => true })).toBeNull()
    expect(bundledConptySource({ platform: 'win32', arch: 'x64', nodePtyLibDir: null, exists: () => true })).toBeNull()
    expect(bundledConptySource({ platform: 'win32', arch: 'x64', nodePtyLibDir: lib, exists: () => false })).toBeNull()
  })
})
