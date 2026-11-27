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
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join, sep } from 'path'
import { chooseConpty } from '../../../src/main/bundled-conpty'
import {
  BUSY_WAIT_MS, CONPTY_FILES, CONPTY_FOLDER, bundledConptySource, checkedConpty, checkedHelperCopySync, copyMatches, helperRootDir, installHelperCopy, removeOldVersionFolders, retryWhileBusy,
  _forgetCheckedHelperCopyForTest,
} from '../../../src/main/session-helper/install'
import { HELPER_FOLDER_RE } from '../../../src/main/session-helper/protocol'

const failure = (code: string) => Object.assign(new Error(`${code}: the file is in use`), { code })
/** libuv's UV_FS_O_EXLOCK on Windows: open a file with no sharing at all. */
const EXCLUSIVE_OPEN = (constants as unknown as Record<string, number>).UV_FS_O_EXLOCK ?? 0x10000000

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

  it('a data root that is not a full path is ignored: the folder used with no override, never one under the working folder (aicc_planning#335)', () => {
    // Before aicc_planning#335 a relative root was joined as it was, so the helper went under
    // whatever folder the run started in (the config-dot-cwd failure class).
    const env = { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' }
    const installed = 'C:\\Users\\someone\\AppData\\Local\\AI Code Conductor\\helper'
    expect(helperRootDir({ ...win, env: { ...env, CCC_DEV_DATA_DIR: 'rel\\dev' }, isPackaged: false })).toBe(`${installed}\\dev`)
    expect(helperRootDir({ ...win, env: { ...env, CCC_E2E_DATA_DIR: 'e2e' }, isPackaged: true })).toBe(installed)
    expect(helperRootDir({ ...win, env: { ...env, CCC_E2E_DATA_DIR: 'e2e' }, isPackaged: false })).toBe(`${installed}\\dev`)
    // The end-to-end root is the one chosen when set; when it is not a full
    // path, the dev root is not used in its place.
    expect(helperRootDir({ ...win, env: { ...env, CCC_E2E_DATA_DIR: 'e2e', CCC_DEV_DATA_DIR: 'D:\\dev-data' }, isPackaged: false })).toBe(`${installed}\\dev`)
    // Full by the rules of the platform named: a drive-letter root is one on
    // Windows and is not one on macOS or Linux.
    expect(helperRootDir({ platform: 'linux', home: '/home/someone', env: { CCC_DEV_DATA_DIR: 'C:\\dev-data' }, isPackaged: false })).toBe('/home/someone/.ai-code-conductor/helper/dev')
    expect(helperRootDir({ platform: 'linux', home: '/home/someone', env: { CCC_DEV_DATA_DIR: '/srv/dev-data' }, isPackaged: false })).toBe('/srv/dev-data/helper')
    expect(helperRootDir({ platform: 'darwin', home: '/Users/someone', env: { CCC_E2E_DATA_DIR: 'rel/e2e' }, isPackaged: true })).toBe('/Users/someone/Library/Application Support/AI Code Conductor/helper')
  })

  it('a LOCALAPPDATA that is not a full path is ignored: the folder under the home folder, never one under the working folder (aicc_planning#335)', () => {
    // Before, a relative LOCALAPPDATA was joined as it was. With a relative dev
    // root set from the same LOCALAPPDATA (index.ts), the root was ignored and
    // the fallback put the helper under the working folder all the same.
    const installed = 'C:\\Users\\someone\\AppData\\Local\\AI Code Conductor\\helper'
    expect(helperRootDir({ ...win, env: { LOCALAPPDATA: 'loc' }, isPackaged: true })).toBe(installed)
    expect(helperRootDir({ ...win, env: { LOCALAPPDATA: 'loc', CCC_DEV_DATA_DIR: 'rel' }, isPackaged: false })).toBe(`${installed}\\dev`)
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

  // #322: a holder's record names its version, not its folder. An update that
  // keeps a held terminal can leave it running from another build of the
  // version the new app runs (the helper version is not bumped with every
  // change), so every folder of a version a holder reports is kept.
  // A guard: removeOldVersionFolders already kept a version it was given, so this passes on beta; the red test is in session-helper-manager.test.ts.
  it('keeps every folder of a version a holder reports, the current version\'s other builds included; with none of that version they go; staging folders always go', async () => {
    root = mkdtempSync(join(tmpdir(), 'aicc-helper-folders-'))
    const current = join(root, `0.1.0-${'f'.repeat(12)}`)
    for (const f of [`0.1.0-${'f'.repeat(12)}`, '0.1.0-aaaaaaaaaaaa', '0.0.9-bbbbbbbbbbbb', '.new-0123456789ab']) mkdirSync(join(root, f))
    // A holder of 0.1.0 is listed: the other build of 0.1.0 stays.
    expect((await removeOldVersionFolders(root, current, new Set(['0.1.0']))).sort()).toEqual(['.new-0123456789ab', '0.0.9-bbbbbbbbbbbb'])
    expect(readdirSync(root).sort()).toEqual(['0.1.0-aaaaaaaaaaaa', '0.1.0-ffffffffffff'])
    // At a later start no holder reports 0.1.0: that build goes, the current folder stays.
    mkdirSync(join(root, '.new-ba9876543210'))
    expect((await removeOldVersionFolders(root, current, new Set())).sort()).toEqual(['.new-ba9876543210', '0.1.0-aaaaaaaaaaaa'])
    expect(readdirSync(root)).toEqual(['0.1.0-ffffffffffff'])
  })

  it('a root that is not there yet removes nothing', async () => {
    const missing = join(tmpdir(), `aicc-helper-missing-${process.pid}-${Date.now()}`)
    expect(existsSync(missing)).toBe(false)
    expect(await removeOldVersionFolders(missing, join(missing, '0.1.0-ffffffffffff'), new Set())).toEqual([])
  })
})

// The launch field `conpty` (plan 2.1.3-beta.7 section A2): a holder that runs a
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
    expect(leftovers(info.folder)).toEqual([])
    expect(await checkedConpty(info)).toEqual(info.conpty)
    // A second start finds the copy in place and keeps it.
    const again = await installHelperCopy({ ...opts, conptySource: source })
    expect(again.conpty).toEqual(info.conpty)
  })

  it('a helper copy made again keeps the bundled ConPTY: the result carries the source it was asked for', async () => {
    const { source, opts } = setUp()
    const info = await installHelperCopy({ ...opts, conptySource: source })
    expect(info.conptySource).toBe(source)
    // The helper's copy no longer matches, so it is made again (the
    // manager's checkedExe), which replaces the whole version folder. Given
    // the source the first copy was asked for, the ConPTY's files are back.
    writeFileSync(info.exe, 'MZ changed after the copy')
    const again = await installHelperCopy({ ...opts, conptySource: info.conptySource })
    expect(again.conpty).toEqual(info.conpty)
    expect(again.conptySource).toBe(source)
    for (const f of CONPTY_FILES) expect(readFileSync(join(again.folder, 'conpty', f), 'utf8')).toBe(readFileSync(join(source, f), 'utf8'))
    // What a copy was not asked for, or could not find, it says so too.
    expect((await installHelperCopy(opts)).conptySource).toBeUndefined()
    expect((await installHelperCopy({ ...opts, conptySource: null })).conptySource).toBeNull()
  })

  it('the manager makes a helper copy again with the ConPTY source it has', () => {
    const manager = readFileSync(join(__dirname, '../../../src/main/session-helper/manager.ts'), 'utf8')
    const recopy = manager.slice(manager.indexOf('private async checkedExe'), manager.indexOf('// ── terminals'))
    expect(recopy).toContain('installHelperCopy({')
    expect(recopy).toContain('conptySource: now.conptySource')
  })

  it('a copy that fails part way leaves no staging folder behind, in the version folder or the root', async () => {
    const { source, root, opts } = setUp()
    const info = await installHelperCopy({ ...opts, conptySource: source })
    // node-pty's OpenConsole.exe is gone since start: the copy made again
    // stops part way, after conpty.dll.
    rmSync(join(source, 'OpenConsole.exe'))
    rmSync(join(info.folder, 'conpty'), { recursive: true, force: true })
    const checked = await checkedConpty(info)
    expect(checked.available).toBe(false)
    expect(leftovers(root)).toEqual([])
    expect(leftovers(info.folder)).toEqual([])
    expect(readdirSync(info.folder)).toEqual(['aicc-helper.exe'])
  })

  // A running session holds the conpty.dll it loaded and the OpenConsole.exe
  // it runs: Windows removes neither. That does not change while the app
  // waits, so the copy is not waited for: the bundled ConPTY is unavailable
  // at once, and a later check makes the copy again.
  it.skipIf(process.platform !== 'win32')('a copy a running session holds cannot be replaced: the bundled ConPTY is unavailable at once, not after a long wait', async () => {
    const { source, opts } = setUp()
    const info = await installHelperCopy({ ...opts, conptySource: source })
    const copied = join(info.folder, 'conpty', 'conpty.dll')
    // libuv's exclusive open (UV_FS_O_EXLOCK): no sharing, so the file can be
    // neither read nor removed while it is open.
    const fd = openSync(copied, constants.O_RDONLY | EXCLUSIVE_OPEN)
    try {
      writeFileSync(join(info.folder, 'conpty', 'OpenConsole.exe'), 'MZ changed after the copy')
      const began = Date.now()
      const checked = await checkedConpty(info)
      expect(checked.available ? '' : checked.reason).toContain('in use by a running session')
      // A start is not held up either: it does not wait for the held copy, and
      // (2.1.3-beta.19 fix round) puts this build's ConPTY with the helper in a
      // version folder of its own beside it, so the bundled ConPTY is available there.
      const start = await installHelperCopy({ ...opts, conptySource: source })
      expect(start.conpty.available).toBe(true)
      expect(start.folder).not.toBe(info.folder)
      expect(Date.now() - began).toBeLessThan(BUSY_WAIT_MS / 2)
      expect(await copyMatches(start.exe, start.sha256)).toBe(true)
    } finally {
      closeSync(fd)
    }
    // Once the session that held it is gone, the next check makes it again.
    expect(await checkedConpty(info)).toEqual(info.conpty)
    expect(readFileSync(join(info.folder, 'conpty', 'OpenConsole.exe'), 'utf8')).toBe('MZ node-pty OpenConsole.exe')
    expect(leftovers(info.folder)).toEqual([])
  }, 30_000)

  // 2.1.3-beta.19 fix round, item CONPTY (published beta.18 control): after an
  // update that kept sessions, with a held Claude Code tab running, a NEW Codex
  // tab was not held: the earlier build's OpenConsole.exe beside the helper
  // differs from the new app's (two signed releases differ the same way), and a
  // running session holds that copy, so it could not be replaced ('EPERM ...
  // unlink ...\conpty\conpty.dll'). This build's ConPTY now goes with the helper
  // into a version folder of its own, named by the ConPTY's bytes too.
  it.skipIf(process.platform !== 'win32')('an update whose ConPTY differs while a running session holds the earlier copy: the new copy goes in a version folder of its own, so a new terminal is held; once nothing holds the old copy, the usual folder again', async () => {
    const { source, root, opts } = setUp()
    // The earlier build's copy, which a held session of that build has loaded.
    const earlier = await installHelperCopy({ ...opts, conptySource: source })
    const fd = openSync(join(earlier.folder, 'conpty', 'conpty.dll'), constants.O_RDONLY | EXCLUSIVE_OPEN)
    let beside = ''
    try {
      // The new build: node-pty's OpenConsole.exe is another build's.
      writeFileSync(join(source, 'OpenConsole.exe'), 'MZ the new build of OpenConsole.exe')
      const start = await installHelperCopy({ ...opts, conptySource: source })
      expect(start.conpty.available).toBe(true)
      beside = start.folder
      expect(beside).not.toBe(earlier.folder)
      // A version folder of the same version, as every other: the clean-up of old folders knows it.
      expect(HELPER_FOLDER_RE.exec(basename(beside))?.[1]).toBe('0.1.0')
      expect(dirname(beside)).toBe(root)
      expect(await copyMatches(start.exe, start.sha256)).toBe(true)
      for (const f of CONPTY_FILES) expect(readFileSync(join(beside, 'conpty', f), 'utf8')).toBe(readFileSync(join(source, f), 'utf8'))
      expect(await checkedConpty(start)).toEqual(start.conpty)
      // The held copy is not replaced.
      expect(existsSync(join(earlier.folder, 'conpty', 'conpty.dll'))).toBe(true)
      // A second start while it is still held finds the same folder of its own.
      expect((await installHelperCopy({ ...opts, conptySource: source })).folder).toBe(beside)
      expect(leftovers(root)).toEqual([])
    } finally {
      closeSync(fd)
    }
    // Nothing holds the earlier copy any more: a start replaces it in the usual folder.
    const later = await installHelperCopy({ ...opts, conptySource: source })
    expect(later.folder).toBe(earlier.folder)
    expect(later.conpty.available).toBe(true)
    expect(readFileSync(join(later.folder, 'conpty', 'OpenConsole.exe'), 'utf8')).toBe('MZ the new build of OpenConsole.exe')
    // The clean-up of old version folders (2.1.3-beta.19 section 6.5's too): the
    // folder of its own is kept while a holder of its version runs, and goes once none does.
    expect(await removeOldVersionFolders(root, later.folder, new Set(['0.1.0']))).toEqual([])
    expect(await removeOldVersionFolders(root, later.folder, new Set())).toEqual([basename(beside)])
  }, 30_000)

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
    expect(info.conpty.available ? '' : info.conpty.reason).toContain('OpenConsole.exe is missing or not a plain file')
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
    expect(holder).toContain(`const BUNDLED_DLL: &str = "${CONPTY_FILES[0]}";`)
    expect(holder).toContain(`const BUNDLED_HOST: &str = "${CONPTY_FILES[1]}";`)
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

// #329: vision ends a browser the helper started with the helper beside the
// app; when an uninstall for all users removed that one while the app ran, it
// uses the copy the session helper put in place this run, checked again first.
describe('checkedHelperCopySync: this run\'s checked copy of the helper', () => {
  let dir: string | undefined
  afterEach(() => {
    _forgetCheckedHelperCopyForTest()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('answers the copy installHelperCopy put in place while it still has that SHA-256, read again each time; null when none was made, or it changed or went', async () => {
    _forgetCheckedHelperCopyForTest()
    expect(checkedHelperCopySync()).toBeNull()
    dir = mkdtempSync(join(tmpdir(), 'aicc-helper-checked-'))
    const bundled = join(dir, 'aicc-helper.exe')
    writeFileSync(bundled, 'MZ the installed helper')
    const sha256 = createHash('sha256').update('MZ the installed helper').digest('hex')
    const info = await installHelperCopy({ bundled, root: join(dir, 'helper'), version: '0.1.0', sha256, platform: 'win32' })
    expect(checkedHelperCopySync()).toBe(info.exe)
    // Gone from beside the app: the copy is still answered.
    rmSync(bundled)
    expect(checkedHelperCopySync()).toBe(info.exe)
    writeFileSync(info.exe, 'MZ something else')
    expect(checkedHelperCopySync()).toBeNull()
    writeFileSync(info.exe, 'MZ the installed helper')
    expect(checkedHelperCopySync()).toBe(info.exe)
    rmSync(info.exe)
    expect(checkedHelperCopySync()).toBeNull()
    mkdirSync(info.exe)
    expect(checkedHelperCopySync(), 'a folder in its place').toBeNull()
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

  it('is the folder the app\'s own bundled node-pty spawn uses (chooseConpty): one lookup for both', () => {
    const packed = join(sep, 'res', 'app.asar', 'node_modules', 'node-pty', 'lib')
    const unpacked = join(sep, 'res', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', 'win32-arm64')
    const withFiles = (dir: string) => [join(dir, 'conpty.node'), join(dir, 'conpty', 'conpty.dll'), join(dir, 'conpty', 'OpenConsole.exe')]
    const cases = [
      { platform: 'win32' as const, arch: 'x64', nodePtyLibDir: lib, exists: has(...withFiles(prebuild)) },
      { platform: 'win32' as const, arch: 'x64', nodePtyLibDir: lib, exists: has(...withFiles(prebuild), ...withFiles(release)) },
      { platform: 'win32' as const, arch: 'arm64', nodePtyLibDir: packed, exists: has(...withFiles(unpacked)) },
    ]
    for (const deps of cases) {
      const choice = chooseConpty(deps)
      expect(choice.kind).toBe('bundled')
      expect(bundledConptySource(deps)).toBe(choice.kind === 'bundled' ? join(choice.dir, 'conpty') : null)
    }
  })

  it('is null off Windows, without node-pty, or without its native module', () => {
    expect(bundledConptySource({ platform: 'linux', arch: 'x64', nodePtyLibDir: lib, exists: () => true })).toBeNull()
    expect(bundledConptySource({ platform: 'darwin', arch: 'arm64', nodePtyLibDir: lib, exists: () => true })).toBeNull()
    expect(bundledConptySource({ platform: 'win32', arch: 'x64', nodePtyLibDir: null, exists: () => true })).toBeNull()
    expect(bundledConptySource({ platform: 'win32', arch: 'x64', nodePtyLibDir: lib, exists: () => false })).toBeNull()
  })
})
