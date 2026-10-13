// script-deploy.ts: the sub-folder a deployed script loads another script
// from (a resume picker's helper lib folder) must be a real folder.
//
// prepareScriptFolder runs before a deploy writes into that folder: a real
// folder is kept with what it holds; a link there (a symbolic link, and on
// Windows also a junction) is removed as a link, never what it names, by the
// rule a link at a script's destination is removed by (unlink, and on Windows
// a directory removal when unlink is refused, which takes the link only;
// never recursive), and a real folder is made in its place; a file there is
// left, and the call throws. isRealScriptFolder is the check a launch makes
// on that folder: a directory that is not a link and whose resolved path
// (fs.realpathSync.native) is its own name in its parent's resolved path.
//
// On macOS and Linux the folder must also be this user's, with no write for
// others: one of this user's that others may write to is made 0700 again; one
// another user owns is removed only when empty (never what it holds), and the
// folder made in its place is made 0700. No removal is ever recursive: every
// directory removal there is called with the path alone.
//
// The platform is passed in. The folder is read as a link, or its resolved
// path as another folder, or (for macOS and Linux) with another owner or
// mode, through a stub, and removing it is played by moving the folder it
// stands for out of the way (the folder it names keeps what it holds); no
// link is made and no permission is changed on this machine. The user id a
// POSIX process has is stood in for where a case needs one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import nodeFs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const warned = vi.hoisted(() => [] as string[])
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: () => {},
  logError: () => {},
  logWarn: (...a: unknown[]) => { warned.push(a.map(String).join(' ')) },
}))

import { prepareScriptFolder, isRealScriptFolder } from '../../../src/main/script-deploy'

let base = ''
let folder = ''
let named = ''
/** While set, the folder reads as a link (the stub). */
let linked = false
/** The stand-in link's stat: a link, or one read as a link and a directory at once. */
let linkReadsAsDirectory = false
/** When set, unlinking the stand-in link fails with this code. */
let unlinkRefuses: string | null = null
/** When set, removing the stand-in link as a directory fails with this code. */
let rmdirRefuses: string | null = null
/** While set, the folder reads as a plain directory whose resolved path is this
 *  one; removing it without recursion takes the stand-in only. */
let resolvesTo: string | null = null
/** While set, the folder's resolved path, and only its, is this one even after
 *  it is made again (never cleared by a removal). */
let alwaysResolvesTo: string | null = null
/** While set, the folder reads as a real directory with this owner and mode (macOS and Linux); a
 *  removal of it clears this, and a folder made in its place reads as this user's with the mode
 *  it was made with (the default 0777 when none is given). */
let folderStat: { uid: number; mode: number } | null = null
/** The user id this process stands in for (a POSIX one), restored after each case. */
const realGetuid = Object.getOwnPropertyDescriptor(process, 'getuid')
/** This user (the real id on macOS and Linux) and another one. */
const ME = typeof process.getuid === 'function' ? process.getuid() : 1000
const OTHER = ME + 4242
function standInUid(uid: number): void {
  Object.defineProperty(process, 'getuid', { value: () => uid, configurable: true, writable: true })
}
let chmods: ReturnType<typeof vi.spyOn>
let mkdirs: ReturnType<typeof vi.spyOn>
/** While set, the folder's resolved path cannot be read. */
let resolveFails = false
let unlinks: ReturnType<typeof vi.spyOn>
let rmdirs: ReturnType<typeof vi.spyOn>
let rms: ReturnType<typeof vi.spyOn>

const calledOn = (spy: ReturnType<typeof vi.spyOn>, p: string): boolean => spy.mock.calls.some((c) => String(c[0]) === p)

beforeEach(() => {
  base = nodeFs.mkdtempSync(join(tmpdir(), 'ccc-script-deploy-folder-'))
  folder = join(base, 'lib')
  named = join(base, 'the-folder-it-named')
  linked = false
  linkReadsAsDirectory = false
  unlinkRefuses = null
  rmdirRefuses = null
  resolvesTo = null
  alwaysResolvesTo = null
  resolveFails = false
  folderStat = null
  warned.length = 0
  const realLstat = nodeFs.lstatSync.bind(nodeFs)
  vi.spyOn(nodeFs, 'lstatSync').mockImplementation(((p: nodeFs.PathLike, o?: nodeFs.StatSyncOptions) => {
    if (linked && String(p) === folder) {
      return { isFile: () => false, isDirectory: () => linkReadsAsDirectory, isSymbolicLink: () => true, nlink: 1, mode: 0o120777 } as unknown as nodeFs.Stats
    }
    const real = realLstat(p, o as never)
    if (folderStat && String(p) === folder && !(o as { bigint?: boolean } | undefined)?.bigint) {
      return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { uid: folderStat.uid, mode: 0o040000 | folderStat.mode })
    }
    return real
  }) as typeof nodeFs.lstatSync)
  const realChmod = nodeFs.chmodSync.bind(nodeFs)
  chmods = vi.spyOn(nodeFs, 'chmodSync').mockImplementation(((p: nodeFs.PathLike, m: nodeFs.Mode) => {
    if (folderStat && String(p) === folder) { folderStat.mode = Number(m); return }
    realChmod(p, m)
  }) as typeof nodeFs.chmodSync)
  const realMkdir = nodeFs.mkdirSync.bind(nodeFs)
  mkdirs = vi.spyOn(nodeFs, 'mkdirSync').mockImplementation(((p: nodeFs.PathLike, o?: nodeFs.MakeDirectoryOptions) => {
    const made = realMkdir(p, o as never)
    if (String(p) === folder && typeof process.getuid === 'function' && process.platform === 'win32') {
      folderStat = { uid: process.getuid(), mode: typeof o?.mode === 'number' ? o.mode : 0o777 }
    }
    return made
  }) as typeof nodeFs.mkdirSync)
  const removeLink = (): void => {
    nodeFs.renameSync(folder, named)
    linked = false
  }
  const realUnlink = nodeFs.unlinkSync.bind(nodeFs)
  unlinks = vi.spyOn(nodeFs, 'unlinkSync').mockImplementation((p: nodeFs.PathLike) => {
    if (!linked || String(p) !== folder) return realUnlink(p)
    if (unlinkRefuses) throw Object.assign(new Error(`${unlinkRefuses}: unlink refused`), { code: unlinkRefuses })
    removeLink()
  })
  const realRmdir = nodeFs.rmdirSync.bind(nodeFs)
  rmdirs = vi.spyOn(nodeFs, 'rmdirSync').mockImplementation(((p: nodeFs.PathLike, o?: nodeFs.RmDirOptions) => {
    if (resolvesTo && String(p) === folder) {
      nodeFs.renameSync(folder, named)
      resolvesTo = null
      return
    }
    if (!linked || String(p) !== folder) {
      // Its options passed on as given, so a recursive removal would be one.
      realRmdir(p, o)
      if (String(p) === folder) folderStat = null
      return
    }
    if (rmdirRefuses) throw Object.assign(new Error(`${rmdirRefuses}: rmdir refused`), { code: rmdirRefuses })
    removeLink()
  }) as typeof nodeFs.rmdirSync)
  const realNative = nodeFs.realpathSync.native.bind(nodeFs.realpathSync)
  vi.spyOn(nodeFs.realpathSync, 'native').mockImplementation(((p: nodeFs.PathLike, o?: unknown) => {
    if (String(p) === folder) {
      if (resolveFails) throw Object.assign(new Error('EPERM: cannot resolve'), { code: 'EPERM' })
      if (alwaysResolvesTo) return alwaysResolvesTo
      if (resolvesTo) return resolvesTo
    }
    return realNative(p, o as never)
  }) as typeof nodeFs.realpathSync.native)
  rms = vi.spyOn(nodeFs, 'rmSync')
  syncBuiltinESMExports()
})

afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  if (realGetuid) Object.defineProperty(process, 'getuid', realGetuid)
  else delete (process as { getuid?: unknown }).getuid
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent.
  if (base.startsWith(join(tmpdir(), 'ccc-script-deploy-folder-'))) nodeFs.rmSync(base, { recursive: true, force: true })
})

/** The folder the stand-in link names: another folder, holding a file of its own. */
function plantStandIn(): void {
  nodeFs.mkdirSync(folder)
  nodeFs.writeFileSync(join(folder, 'theirs.js'), '// theirs')
  linked = true
}

/** Whether a directory removal at the folder was given anything beside the path (its options are
 *  where recursion is asked for), or the folder was removed with rmSync. */
const removedRecursively = (): boolean => calledOn(rms, folder) || rmdirs.mock.calls.some((c) => String(c[0]) === folder && c.length !== 1)

const isRealFolderOnDisk = (p: string): boolean => {
  const st = nodeFs.lstatSync(p)
  return st.isDirectory() && !st.isSymbolicLink()
}

describe.each(['linux', 'darwin', 'win32'] as const)('prepareScriptFolder on %s', (platform) => {
  it('nothing there: a real folder is made', () => {
    prepareScriptFolder(folder, platform)
    expect(isRealFolderOnDisk(folder)).toBe(true)
    expect(warned).toEqual([])
  })

  // Mutation to prove this can fail: remove whatever is there before making the folder.
  it('a real folder there is kept, with what it holds: nothing is removed', () => {
    nodeFs.mkdirSync(folder)
    nodeFs.writeFileSync(join(folder, 'kept.js'), '// kept')
    prepareScriptFolder(folder, platform)
    expect(nodeFs.readFileSync(join(folder, 'kept.js'), 'utf8')).toBe('// kept')
    expect(calledOn(unlinks, folder) || calledOn(rmdirs, folder) || calledOn(rms, folder)).toBe(false)
  })

  // Mutation to prove this can fail: keep a link as if it were a real folder.
  it.each([false, true])('a link there (read as a directory too: %s) is removed as a link, and a real empty folder made in its place; the folder it named keeps what it holds', (readsAsDirectory) => {
    plantStandIn()
    linkReadsAsDirectory = readsAsDirectory
    prepareScriptFolder(folder, platform)
    expect(calledOn(unlinks, folder)).toBe(true)
    expect(removedRecursively()).toBe(false)
    expect(isRealFolderOnDisk(folder)).toBe(true)
    expect(nodeFs.readdirSync(folder)).toEqual([])
    expect(nodeFs.readFileSync(join(named, 'theirs.js'), 'utf8')).toBe('// theirs')
    expect(warned).toEqual([])
  })

  it('a file there is left, and the call throws, logged by the folder\'s name', () => {
    nodeFs.writeFileSync(folder, '// a file')
    expect(() => prepareScriptFolder(folder, platform)).toThrow()
    expect(nodeFs.readFileSync(folder, 'utf8')).toBe('// a file')
    expect(calledOn(unlinks, folder) || calledOn(rmdirs, folder) || calledOn(rms, folder)).toBe(false)
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('the lib folder could not be made a real folder')
    expect(warned[0]).not.toContain(base)
  })
})

describe('prepareScriptFolder on Windows: a directory link or junction it will not unlink', () => {
  // Mutation to prove this can fail: drop the directory removal fallback.
  it('is removed as a directory, which takes the link only, and a real folder made in its place', () => {
    plantStandIn()
    unlinkRefuses = 'EPERM'
    prepareScriptFolder(folder, 'win32')
    expect(calledOn(unlinks, folder)).toBe(true)
    expect(calledOn(rmdirs, folder)).toBe(true)
    expect(removedRecursively()).toBe(false)
    expect(isRealFolderOnDisk(folder)).toBe(true)
    expect(nodeFs.readFileSync(join(named, 'theirs.js'), 'utf8')).toBe('// theirs')
  })

  it('when it cannot be removed either way, the unlink\'s error throws and is logged, and the link stays', () => {
    plantStandIn()
    unlinkRefuses = 'EBUSY'
    rmdirRefuses = 'EACCES'
    expect(() => prepareScriptFolder(folder, 'win32')).toThrow(/EBUSY/)
    expect(linked).toBe(true)
    expect(nodeFs.readFileSync(join(folder, 'theirs.js'), 'utf8')).toBe('// theirs')
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('EBUSY')
  })
})

describe.each(['linux', 'darwin'] as const)('prepareScriptFolder on %s: a link that cannot be unlinked', (platform) => {
  // Mutation to prove this can fail: try the directory removal on every platform.
  it('throws, is logged, and is never removed as a directory', () => {
    plantStandIn()
    unlinkRefuses = 'EACCES'
    expect(() => prepareScriptFolder(folder, platform)).toThrow(/EACCES/)
    expect(calledOn(rmdirs, folder)).toBe(false)
    expect(linked).toBe(true)
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('EACCES')
  })
})

describe('isRealScriptFolder', () => {
  it('a real folder is one', () => {
    nodeFs.mkdirSync(folder)
    expect(isRealScriptFolder(folder)).toBe(true)
  })

  it('nothing there is not one', () => {
    expect(isRealScriptFolder(folder)).toBe(false)
  })

  it('a file is not one', () => {
    nodeFs.writeFileSync(folder, '// a file')
    expect(isRealScriptFolder(folder)).toBe(false)
  })

  // Mutation to prove this can fail: check isDirectory() alone.
  it.each([false, true])('a link (read as a directory too: %s) is not one', (readsAsDirectory) => {
    plantStandIn()
    linkReadsAsDirectory = readsAsDirectory
    expect(isRealScriptFolder(folder)).toBe(false)
  })
})

// The resolved-path half of the rule. A directory can read as a plain
// directory without following a link and still resolve to another folder;
// such a folder is not a real one, and the deploy replaces it.
describe('isRealScriptFolder: the resolved path', () => {
  // Mutation to prove this can fail: check lstat alone.
  it('a plain directory whose resolved path is another folder is not one', () => {
    plantStandIn()
    linked = false
    resolvesTo = named
    expect(isRealScriptFolder(folder)).toBe(false)
  })

  // Mutation to prove this can fail: treat a resolve error as a match.
  it('a directory whose resolved path cannot be read is not one', () => {
    nodeFs.mkdirSync(folder)
    resolveFails = true
    expect(isRealScriptFolder(folder)).toBe(false)
  })

  // Mutation to prove this can fail: compare with case on every platform.
  it.each([['win32', true], ['darwin', true], ['linux', false]] as const)('on %s, a resolved name that differs only in case is one: %s', (platform, expected) => {
    nodeFs.mkdirSync(folder)
    resolvesTo = join(nodeFs.realpathSync.native(base), 'LIB')
    expect(isRealScriptFolder(folder, platform)).toBe(expected)
  })
})

describe.each(['linux', 'darwin', 'win32'] as const)('prepareScriptFolder on %s: the resolved path', (platform) => {
  // Mutation to prove this can fail: keep any directory lstat reads as plain.
  it('a directory that resolves to another folder is removed without recursion, and a real empty folder made in its place; the folder it resolved to keeps what it holds', () => {
    plantStandIn()
    linked = false
    resolvesTo = named
    prepareScriptFolder(folder, platform)
    expect(calledOn(rmdirs, folder)).toBe(true)
    expect(removedRecursively()).toBe(false)
    expect(isRealFolderOnDisk(folder)).toBe(true)
    expect(nodeFs.readdirSync(folder)).toEqual([])
    expect(nodeFs.readFileSync(join(named, 'theirs.js'), 'utf8')).toBe('// theirs')
    expect(warned).toEqual([])
  })

  // Mutation to prove this can fail: remove the folder recursively.
  it('a directory that cannot be resolved and holds files: nothing in it is removed, and the call throws, logged', () => {
    nodeFs.mkdirSync(folder)
    nodeFs.writeFileSync(join(folder, 'kept.js'), '// kept')
    resolveFails = true
    expect(() => prepareScriptFolder(folder, platform)).toThrow()
    expect(removedRecursively()).toBe(false)
    expect(nodeFs.readFileSync(join(folder, 'kept.js'), 'utf8')).toBe('// kept')
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('the lib folder could not be made a real folder')
    expect(warned[0]).not.toContain(base)
  })

  // Mutation to prove this can fail: drop the check on the folder made.
  it('the folder made is checked again: one that does not resolve to its own place throws, logged', () => {
    alwaysResolvesTo = named
    expect(() => prepareScriptFolder(folder, platform)).toThrow()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('ENOTREALDIR')
  })

  // Mutation to prove this can fail: make the folder without mode 0700.
  it('the folder made is made with mode 0700', () => {
    prepareScriptFolder(folder, platform)
    const made = mkdirs.mock.calls.filter((c) => String(c[0]) === folder)
    expect(made).toHaveLength(1)
    expect((made[0][1] as { mode?: number } | undefined)?.mode).toBe(0o700)
  })

  // Mutation to prove this can fail: make the folder with recursive: true.
  it('no folder above it is made: a missing parent throws, logged', () => {
    const deeper = join(base, 'missing', 'lib')
    expect(() => prepareScriptFolder(deeper, platform)).toThrow(/ENOENT/)
    expect(nodeFs.existsSync(join(base, 'missing'))).toBe(false)
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('ENOENT')
  })
})

// macOS and Linux: the folder a launch takes scripts from is this user's, and
// no one else may write to it. The owner and mode are stood in for through the
// stub, and the process's user id too. Mutations to prove this can fail: drop
// the owner test, or the write-bit test, from isRealScriptFolder; remove this
// user's own folder instead of making it 0700 again.
describe.each(['linux', 'darwin'] as const)('on %s: the folder\'s owner and who may write to it', (platform) => {
  beforeEach(() => {
    standInUid(ME)
    nodeFs.mkdirSync(folder)
    nodeFs.writeFileSync(join(folder, 'kept.js'), '// kept')
  })

  it('a real folder of this user\'s with no write for others is one', () => {
    folderStat = { uid: ME, mode: 0o755 }
    expect(isRealScriptFolder(folder, platform)).toBe(true)
  })

  it.each([['another user owns it', OTHER, 0o700], ['group may write to it', ME, 0o775], ['others may write to it', ME, 0o757]] as Array<[string, number, number]>)('one that %s is not', (_label, uid, mode) => {
    folderStat = { uid, mode }
    expect(isRealScriptFolder(folder, platform)).toBe(false)
  })

  it('this user\'s own folder that others may write to is made 0700 again, and nothing in it is removed', () => {
    folderStat = { uid: ME, mode: 0o777 }
    prepareScriptFolder(folder, platform)
    expect(chmods.mock.calls.filter((c) => String(c[0]) === folder).map((c) => c[1])).toEqual([0o700])
    expect(calledOn(unlinks, folder) || calledOn(rmdirs, folder) || calledOn(rms, folder)).toBe(false)
    expect(nodeFs.readFileSync(join(folder, 'kept.js'), 'utf8')).toBe('// kept')
    expect(isRealScriptFolder(folder, platform)).toBe(true)
    expect(warned).toEqual([])
  })

  it('a folder another user owns, holding files, is not kept: nothing in it is removed, and the call throws, logged', () => {
    folderStat = { uid: OTHER, mode: 0o755 }
    expect(() => prepareScriptFolder(folder, platform)).toThrow()
    expect(chmods.mock.calls.filter((c) => String(c[0]) === folder)).toEqual([])
    expect(removedRecursively()).toBe(false)
    expect(nodeFs.readFileSync(join(folder, 'kept.js'), 'utf8')).toBe('// kept')
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('the lib folder could not be made a real folder')
  })

  it('an empty folder another user owns is removed (the path alone), and one of this user\'s, 0700, made in its place', () => {
    nodeFs.rmSync(join(folder, 'kept.js'))
    rms.mockClear()
    folderStat = { uid: OTHER, mode: 0o755 }
    prepareScriptFolder(folder, platform)
    expect(calledOn(rmdirs, folder)).toBe(true)
    expect(removedRecursively()).toBe(false)
    expect(isRealFolderOnDisk(folder)).toBe(true)
    expect(isRealScriptFolder(folder, platform)).toBe(true)
    expect(warned).toEqual([])
  })
})
