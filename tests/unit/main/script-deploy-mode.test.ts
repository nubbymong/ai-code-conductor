// script-deploy.ts puts the app's own script files in place in the resources
// folder.
//
// Before a write the destination is read without following a link: a link
// there is removed as a link, and a directory only when it is empty (what a
// directory holds is never deleted; one that is not empty fails the deploy).
// The bytes go to a new file made with mode 0600, which is then renamed over
// the destination (atomicWriteFileSync); on macOS and Linux that is the only
// write, and it never opens the destination. On Windows, where that rename is
// refused while another process has the old copy open, a plain file with one
// name is written in place instead, through a handle opened on it and checked
// to be that same file.
//
// A copy that already has the shipped bytes is replaced the same way when it
// is not a plain file with one name (a link, or a hard link), and on macOS and
// Linux also when group or others have a permission bit on it (Windows keeps
// no such mode). That is best effort: a folder that refuses it must neither
// throw nor stop the deploys after it, and the refusal is logged once a run.
// A copy whose bytes differ and cannot be put in place is logged every time,
// and throws; that destination, like one whose source cannot be read, is
// recorded as failed for the run (deployFailedThisRun) until a later deploy
// finds or puts the shipped bytes there.
//
// The destination is read with lstat before anything else, and its bytes only
// when that shows a plain file, and only when it has the shipped bytes' size:
// anything else there (a FIFO, a socket, a device, a link, a directory) is
// never opened, and is replaced, and a plain file of another size is replaced
// unread. On Windows a
// plain file with one name that has the read-only attribute is made writable
// before it is replaced. On macOS and Linux a launch takes a script only when
// it is this user's with no write for others, and a copy another user owns is
// replaced. No removal at the destination is ever recursive: every directory
// removal there is called with the path alone.
//
// The platform is passed in, the destination is read through a stub where a
// case needs a link or a mode this machine cannot be asked for, and the files
// and directories are real ones in a fresh temp folder; no permission on this
// machine is changed and no link is made (the read-only attribute is a file
// attribute, set with chmod). The user id a POSIX process has is stood in for
// where a case needs one. The cases that plant a real link, hard link or FIFO
// are in script-deploy-links.test.ts (CI and the VM only).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import nodeFs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'

const warned = vi.hoisted(() => [] as string[])
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: () => {},
  logError: () => {},
  logWarn: (...a: unknown[]) => { warned.push(a.map(String).join(' ')) },
}))

import { deployScriptFile, deployScriptBytes, deployFailedThisRun, isPlainScriptFile, SCRIPT_DEPLOY_NEW_FILE_MODE, _resetScriptDeployWarningForTest } from '../../../src/main/script-deploy'

/** openSync as it is, before any case spies on it. */
const realOpenSync = nodeFs.openSync.bind(nodeFs)

let dir = ''
let src = ''
let dest = ''
/** What the stub reports for the destination, read without following a link. */
let destMode = 0o644
let destIsFile = true
let destNlink = 1
/** The owner the stub reports (null: the real file's). */
let destUid: number | null = null
/** When set, the stub reports neither a file, a directory nor a link (a FIFO, a socket or a device). */
let destOther = false
/** When set, the destination is read as it really is, not through the stub. */
let destReal = false
/** When set, the stub reports a file other than the one at the destination (no identity). */
let destForeign = false
let lstatOfDest = 0
let writes: ReturnType<typeof vi.spyOn>
let unlinks: ReturnType<typeof vi.spyOn>
let rmdirs: ReturnType<typeof vi.spyOn>
let rms: ReturnType<typeof vi.spyOn>
let opens: ReturnType<typeof vi.spyOn>
let reads: ReturnType<typeof vi.spyOn>
let chmods: ReturnType<typeof vi.spyOn>
/** The user id this process stands in for (a POSIX one), restored after each case. */
const realGetuid = Object.getOwnPropertyDescriptor(process, 'getuid')
function standInUid(uid: number): void {
  Object.defineProperty(process, 'getuid', { value: () => uid, configurable: true, writable: true })
}
/** When set, a rename onto the destination fails with this code. */
let renameFails: string | null = null
/** When set, writing the new file next to the destination fails with this code. */
let stagingFails: string | null = null
/** When set, unlinking the destination fails with this code (as Windows answers for some directory links). */
let unlinkRefuses: string | null = null

beforeEach(() => {
  dir = nodeFs.mkdtempSync(join(tmpdir(), 'ccc-script-deploy-'))
  src = join(dir, 'source.js')
  dest = join(dir, 'deployed.js')
  nodeFs.writeFileSync(src, '// shipped v2\n')
  destMode = 0o644
  destIsFile = true
  destNlink = 1
  destUid = null
  destOther = false
  destReal = false
  destForeign = false
  lstatOfDest = 0
  renameFails = null
  stagingFails = null
  unlinkRefuses = null
  const realLstat = nodeFs.lstatSync.bind(nodeFs)
  vi.spyOn(nodeFs, 'lstatSync').mockImplementation(((p: nodeFs.PathLike, o?: nodeFs.StatSyncOptions) => {
    if (String(p) !== dest) return realLstat(p, o as never)
    lstatOfDest++
    if (destReal) return realLstat(p, o as never)
    // The real file's identity, so a handle opened on it is taken for the
    // same file, unless a case puts another file there (destForeign).
    let real: { ino?: unknown; dev?: unknown; uid?: unknown } | undefined
    try { real = realLstat(p, o as never) as unknown as { ino?: unknown; dev?: unknown; uid?: unknown } } catch { real = undefined }
    const bigint = (o as { bigint?: boolean } | undefined)?.bigint === true
    return {
      mode: (destOther ? 0o010000 : destIsFile ? 0o100000 : 0o120000) | destMode,
      nlink: bigint ? BigInt(destNlink) : destNlink,
      ino: destForeign ? undefined : real?.ino,
      dev: destForeign ? undefined : real?.dev,
      uid: destUid ?? real?.uid,
      isFile: () => destIsFile && !destOther,
      isSymbolicLink: () => !destIsFile && !destOther,
      isDirectory: () => false,
    } as unknown as nodeFs.Stats
  }) as typeof nodeFs.lstatSync)
  const realRename = nodeFs.renameSync.bind(nodeFs)
  vi.spyOn(nodeFs, 'renameSync').mockImplementation((from: nodeFs.PathLike, to: nodeFs.PathLike) => {
    if (renameFails && String(to) === dest) throw Object.assign(new Error(`${renameFails}: rename refused`), { code: renameFails })
    realRename(from, to)
  })
  const realWrite = nodeFs.writeFileSync.bind(nodeFs)
  writes = vi.spyOn(nodeFs, 'writeFileSync').mockImplementation(((p: nodeFs.PathOrFileDescriptor, d: string | NodeJS.ArrayBufferView, o?: nodeFs.WriteFileOptions) => {
    if (stagingFails && typeof p === 'string' && p.startsWith(`${dest}.`) && p.endsWith('.tmp')) {
      throw Object.assign(new Error(`${stagingFails}: write refused`), { code: stagingFails })
    }
    realWrite(p, d, o)
  }) as typeof nodeFs.writeFileSync)
  const realUnlink = nodeFs.unlinkSync.bind(nodeFs)
  unlinks = vi.spyOn(nodeFs, 'unlinkSync').mockImplementation((p: nodeFs.PathLike) => {
    if (unlinkRefuses && String(p) === dest) throw Object.assign(new Error(`${unlinkRefuses}: unlink refused`), { code: unlinkRefuses })
    realUnlink(p)
  })
  rmdirs = vi.spyOn(nodeFs, 'rmdirSync')
  rms = vi.spyOn(nodeFs, 'rmSync')
  opens = vi.spyOn(nodeFs, 'openSync')
  reads = vi.spyOn(nodeFs, 'readFileSync')
  chmods = vi.spyOn(nodeFs, 'chmodSync')
  syncBuiltinESMExports()
  warned.length = 0
  _resetScriptDeployWarningForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  if (realGetuid) Object.defineProperty(process, 'getuid', realGetuid)
  else delete (process as { getuid?: unknown }).getuid
  // A read-only copy a case made stays removable.
  try { nodeFs.chmodSync(dest, 0o666) } catch { /* not there */ }
  try { nodeFs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp */ }
})

/** The paths writeFileSync was asked to write, with the options of each. */
const writeCalls = () => writes.mock.calls.map((c) => ({ path: String(c[0]), opts: c[2] as { flag?: string; mode?: number } | undefined }))
/** Writes made through a handle (an in-place write), not to a path. */
const handleWrites = () => writes.mock.calls.filter((c) => typeof c[0] === 'number')
/** What the deploy removed at the destination, and whether anything was removed with what it holds:
 *  a removal by rmSync, or a directory removal given anything beside the path (its options are
 *  where recursion is asked for), counts as one. */
const removedAtDest = () => ({
  unlink: unlinks.mock.calls.some((c) => String(c[0]) === dest),
  rmdir: rmdirs.mock.calls.some((c) => String(c[0]) === dest),
  recursive: rms.mock.calls.some((c) => String(c[0]) === dest) || rmdirs.mock.calls.some((c) => String(c[0]) === dest && c.length !== 1),
})
/** Whether the destination was opened or read by its path (a handle on it, or readFileSync of it). */
const destOpened = (): boolean => opens.mock.calls.some((c) => String(c[0]) === dest) || reads.mock.calls.some((c) => String(c[0]) === dest)
/** Every write the deploy made: one new file next to the destination, made exclusively, this user's only. */
function expectReplacedNotOpened(): void {
  const calls = writeCalls()
  expect(calls.map((c) => c.path)).not.toContain(dest)
  expect(calls).toHaveLength(1)
  expect(dirname(calls[0].path)).toBe(dir)
  expect(basename(calls[0].path).startsWith('deployed.js.')).toBe(true)
  expect(calls[0].opts).toMatchObject({ flag: 'wx', mode: SCRIPT_DEPLOY_NEW_FILE_MODE })
  expect(SCRIPT_DEPLOY_NEW_FILE_MODE).toBe(0o600)
  // The new file is the destination now: nothing staged is left behind.
  expect(nodeFs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
}

describe.each(['linux', 'darwin', 'win32'] as const)('deployScriptFile on %s: a write never opens the destination', (platform) => {
  it('a changed copy is replaced by a new file renamed over it, with the shipped bytes', () => {
    nodeFs.writeFileSync(dest, '// an older or changed copy\n')
    writes.mockClear()
    destMode = 0o600
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expectReplacedNotOpened()
    expect(warned).toEqual([])
  })

  it('a new copy is made the same way', () => {
    destMode = 0o600
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expectReplacedNotOpened()
  })

  // Mutation to prove this can fail: drop the logWarn before the throw.
  it('a copy that cannot be replaced, whose bytes differ, throws and is logged by the file\'s name: callers keep their contract', () => {
    nodeFs.writeFileSync(dest, '// an older copy\n')
    renameFails = 'EXDEV'
    expect(() => deployScriptFile(src, dest, platform)).toThrow(/EXDEV/)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// an older copy\n')
    // The new file made for it is removed again.
    expect(nodeFs.readdirSync(dir).sort()).toEqual(['deployed.js', 'source.js'])
    // Not a refusal Windows gives for a file held open: never written in place.
    expect(handleWrites()).toEqual([])
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('deployed.js')
    expect(warned[0]).toContain('EXDEV')
    expect(warned[0]).not.toContain(dir)
  })

  it('every such failure is logged, not only the first of a run', () => {
    nodeFs.writeFileSync(dest, '// an older copy\n')
    renameFails = 'EXDEV'
    for (let i = 0; i < 3; i++) expect(() => deployScriptFile(src, dest, platform)).toThrow(/EXDEV/)
    expect(warned).toHaveLength(3)
  })

  it('no source: nothing is read, written or changed', () => {
    nodeFs.rmSync(src)
    writes.mockClear()
    expect(deployScriptFile(src, dest, platform)).toBe('no-source')
    expect(nodeFs.existsSync(dest)).toBe(false)
    expect(lstatOfDest).toBe(0)
    expect(writeCalls()).toEqual([])
  })

  // A copy with the shipped bytes and another name (a hard link): that other
  // name can change the copy in use, so it is replaced by a file with one
  // name, on every platform. Mutation to prove this can fail: drop the nlink
  // test from needsReplacing.
  it('a copy with the shipped bytes and another name (a hard link) is replaced by a new file', () => {
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    writes.mockClear()
    destMode = 0o600
    destNlink = 2
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expectReplacedNotOpened()
  })
})

describe.each(['linux', 'darwin', 'win32'] as const)('deployScriptFile on %s: what sits at the destination is cleared first, never followed', (platform) => {
  // Mutation to prove this can fail: drop the isDirectory branch of clearForWrite.
  it('an empty directory is removed, and the copy put in its place', () => {
    destReal = true
    nodeFs.mkdirSync(dest)
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expect(nodeFs.lstatSync(dest).isFile()).toBe(true)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(removedAtDest()).toEqual({ unlink: false, rmdir: true, recursive: false })
    expect(warned).toEqual([])
  })

  // What a directory holds is never deleted: the deploy fails instead, and
  // says so in the app's log. Mutation to prove this can fail: remove the
  // directory with rmSync({ recursive: true }).
  it('a directory that is not empty fails the deploy, keeps what it holds, and is logged by the file\'s name', () => {
    destReal = true
    nodeFs.mkdirSync(dest)
    nodeFs.writeFileSync(join(dest, 'index.js'), '// not the app\'s\n')
    expect(() => deployScriptFile(src, dest, platform)).toThrow()
    expect(nodeFs.lstatSync(dest).isDirectory()).toBe(true)
    expect(nodeFs.readFileSync(join(dest, 'index.js'), 'utf8')).toBe('// not the app\'s\n')
    expect(removedAtDest().recursive).toBe(false)
    expect(nodeFs.readdirSync(dir).sort()).toEqual(['deployed.js', 'source.js'])
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('deployed.js')
    expect(warned[0]).toMatch(/ENOTEMPTY|EEXIST/)
    expect(warned[0]).not.toContain(dir)
  })

  // Mutation to prove this can fail: drop the isSymbolicLink branch of clearForWrite.
  it('a link is removed as a link before the copy is written', () => {
    nodeFs.writeFileSync(dest, '// an older copy\n')
    writes.mockClear()
    destIsFile = false
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(removedAtDest()).toEqual({ unlink: true, rmdir: false, recursive: false })
    expectReplacedNotOpened()
  })
})

describe('deployScriptFile on Windows: a directory link or junction it will not unlink', () => {
  // Mutation to prove this can fail: drop the rmdirSync fallback.
  it('is removed as a directory, which takes the link only, and the copy is put in its place', () => {
    destReal = true
    nodeFs.mkdirSync(dest)
    // Read as a link (the stub); Windows refuses to unlink it.
    destReal = false
    destIsFile = false
    unlinkRefuses = 'EPERM'
    expect(deployScriptFile(src, dest, 'win32')).toBe('written')
    destReal = true
    expect(nodeFs.lstatSync(dest).isFile()).toBe(true)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(removedAtDest()).toEqual({ unlink: true, rmdir: true, recursive: false })
  })

  // The app log names what stopped the deploy: the unlink's error, not the
  // error of the directory removal tried after it. Mutation to prove this can
  // fail: let the rmdirSync fallback's own error throw.
  it('when the link cannot be removed either way, the unlink\'s error is what throws and is logged, and what is there stays', () => {
    nodeFs.writeFileSync(dest, '// an older copy\n')
    destIsFile = false
    unlinkRefuses = 'EBUSY'
    expect(() => deployScriptFile(src, dest, 'win32')).toThrow(/EBUSY/)
    expect(removedAtDest()).toEqual({ unlink: true, rmdir: true, recursive: false })
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// an older copy\n')
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('EBUSY')
  })
})

describe.each(['linux', 'darwin'] as const)('deployScriptFile on %s: a link that cannot be unlinked', (platform) => {
  // Mutation to prove this can fail: try rmdirSync on every platform.
  it('fails the deploy and is never removed as a directory', () => {
    nodeFs.writeFileSync(dest, '// an older copy\n')
    destIsFile = false
    unlinkRefuses = 'EACCES'
    expect(() => deployScriptFile(src, dest, platform)).toThrow(/EACCES/)
    expect(removedAtDest()).toEqual({ unlink: true, rmdir: false, recursive: false })
    expect(warned).toHaveLength(1)
  })
})

describe('deployScriptFile on Windows: a rename refused as for a file another process has open', () => {
  beforeEach(() => {
    destReal = true
    nodeFs.writeFileSync(dest, '// an older copy\n')
    writes.mockClear()
  })

  // Mutation to prove this can fail: drop the in-place write.
  it.each(['EPERM', 'EACCES', 'EBUSY'])('(%s) writes the shipped bytes in place into the plain file with one name', (code) => {
    renameFails = code
    expect(deployScriptFile(src, dest, 'win32')).toBe('written')
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(handleWrites()).toHaveLength(1)
    expect(nodeFs.readdirSync(dir).sort()).toEqual(['deployed.js', 'source.js'])
    expect(warned).toEqual([])
  })

  it('a longer old copy is cut to the shipped bytes', () => {
    nodeFs.writeFileSync(dest, `// an older copy${'x'.repeat(4096)}\n`)
    renameFails = 'EPERM'
    expect(deployScriptFile(src, dest, 'win32')).toBe('written')
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
  })

  // The real thing on this machine: a read handle held open on the old copy,
  // as a sync, backup or antivirus client holds one. Windows refuses the
  // rename then; the shipped bytes still land. (macOS and Linux rename over
  // it, so there it passes through the rename.)
  it('with a real read handle open on the old copy, the shipped bytes land', () => {
    const fd = nodeFs.openSync(dest, 'r')
    try {
      expect(deployScriptFile(src, dest)).toBe('written')
    } finally {
      nodeFs.closeSync(fd)
    }
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(nodeFs.readdirSync(dir).sort()).toEqual(['deployed.js', 'source.js'])
    expect(warned).toEqual([])
  })

  // Mutation to prove this can fail: drop the platform test before the in-place write.
  it.each(['linux', 'darwin'] as const)('on %s the same refusal throws, is logged, and the old copy stays', (platform) => {
    renameFails = 'EPERM'
    expect(() => deployScriptFile(src, dest, platform)).toThrow(/EPERM/)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// an older copy\n')
    expect(handleWrites()).toEqual([])
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('EPERM')
  })

  // Mutation to prove this can fail: drop the nlink test in writeInPlace.
  it('a copy with another name (a hard link) is not written in place: it throws, and is logged', () => {
    destReal = false
    destMode = 0o600
    destNlink = 2
    renameFails = 'EPERM'
    expect(() => deployScriptFile(src, dest, 'win32')).toThrow(/EPERM/)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// an older copy\n')
    expect(handleWrites()).toEqual([])
    expect(warned).toHaveLength(1)
  })

  // Mutation to prove this can fail: drop the same-file test on the handle.
  it('nothing is written when the handle opened is not the file read a moment before', () => {
    // The stub reports a plain file with one name, but not the file at the
    // destination, as if another had been put there between the two reads.
    destReal = false
    destForeign = true
    destMode = 0o600
    renameFails = 'EPERM'
    expect(() => deployScriptFile(src, dest, 'win32')).toThrow(/EPERM/)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// an older copy\n')
    expect(handleWrites()).toEqual([])
  })

  // A failure to write the new file says nothing about the destination.
  // Mutation to prove this can fail: drop the isRenameStageFailure test.
  it('a failure to write the new file is never followed by an in-place write', () => {
    stagingFails = 'EACCES'
    expect(() => deployScriptFile(src, dest, 'win32')).toThrow(/EACCES/)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// an older copy\n')
    expect(handleWrites()).toEqual([])
    expect(warned).toHaveLength(1)
  })
})

describe.each(['linux', 'darwin'] as const)('deployScriptFile on %s: a copy that already has the shipped bytes', (platform) => {
  beforeEach(() => {
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    writes.mockClear()
  })

  it.each([['644', 0o644], ['666', 0o666], ['640', 0o640], ['604', 0o604], ['777', 0o777]] as Array<[string, number]>)('with mode %s is replaced by a new file this user\'s only, not changed in place', (_label, mode) => {
    destMode = mode
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expectReplacedNotOpened()
  })

  it('that is not a plain file (a link) is replaced too', () => {
    destMode = 0o600
    destIsFile = false
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expectReplacedNotOpened()
  })

  it.each([['600', 0o600], ['700', 0o700], ['400', 0o400], ['500', 0o500]] as Array<[string, number]>)('with mode %s, this user\'s only already, is left as it is: no write at all', (_label, mode) => {
    destMode = mode
    const old = new Date('2001-02-03T04:05:06Z')
    nodeFs.utimesSync(dest, old, old)
    expect(deployScriptFile(src, dest, platform)).toBe('unchanged')
    expect(lstatOfDest).toBe(1)
    expect(writeCalls()).toEqual([])
    expect(nodeFs.statSync(dest).mtimeMs).toBe(old.getTime())
  })

  it('that cannot be replaced (a folder that refuses it) is left as it is: no throw, and one warning by the file\'s name', () => {
    destMode = 0o777
    renameFails = 'EXDEV'
    expect(deployScriptFile(src, dest, platform)).toBe('unchanged')
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(nodeFs.readdirSync(dir).sort()).toEqual(['deployed.js', 'source.js'])
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('deployed.js')
    expect(warned[0]).toContain('EXDEV')
    // The file's name only, never the folder it is in.
    expect(warned[0]).not.toContain(dir)
  })

  it('a refusal at every file of a start is logged once that run', () => {
    destMode = 0o777
    renameFails = 'EXDEV'
    for (let i = 0; i < 5; i++) expect(deployScriptFile(src, dest, platform)).toBe('unchanged')
    expect(warned).toHaveLength(1)
  })
})

describe('deployScriptFile on Windows: a copy that already has the shipped bytes', () => {
  beforeEach(() => {
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    writes.mockClear()
  })

  it('that is a plain file with one name is left as it is, whatever its mode: Windows keeps no such mode', () => {
    destMode = 0o666
    const old = new Date('2001-02-03T04:05:06Z')
    nodeFs.utimesSync(dest, old, old)
    expect(deployScriptFile(src, dest, 'win32')).toBe('unchanged')
    expect(lstatOfDest).toBe(1)
    expect(writeCalls()).toEqual([])
    expect(nodeFs.statSync(dest).mtimeMs).toBe(old.getTime())
  })

  // A link at the destination whose target holds the shipped bytes is
  // replaced by a plain file, as on macOS and Linux, so the copy in use is the
  // app's own. Mutation to prove this can fail: return before the lstat on
  // Windows.
  it('that is not a plain file (a link) is removed as a link and replaced by a new file renamed over it', () => {
    destMode = 0o666
    destIsFile = false
    expect(deployScriptFile(src, dest, 'win32')).toBe('written')
    expect(lstatOfDest).toBe(1)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(removedAtDest()).toEqual({ unlink: true, rmdir: false, recursive: false })
    expectReplacedNotOpened()
  })

  // The link is removed before the write, so when the write then fails
  // nothing is left there: a launch finds no copy, rather than one whose
  // target can change under it. What a link names is never read, so its
  // bytes are never known: the failure is that of a copy whose bytes differ.
  it('that is not a plain file and whose replacement fails is gone: it throws, and one warning by the file\'s name', () => {
    destIsFile = false
    renameFails = 'EPERM'
    expect(() => deployScriptFile(src, dest, 'win32')).toThrow(/EPERM/)
    expect(nodeFs.existsSync(dest)).toBe(false)
    expect(nodeFs.readdirSync(dir).sort()).toEqual(['source.js'])
    expect(handleWrites()).toEqual([])
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('deployed.js')
    expect(warned[0]).toContain('EPERM')
    expect(warned[0]).not.toContain(dir)
    // Windows keeps no owner-only mode, so the warning claims none.
    expect(warned[0]).not.toContain('this user only')
  })

  it('that is a link that cannot be removed stays as it is: it throws, and one warning with the unlink\'s error', () => {
    destIsFile = false
    unlinkRefuses = 'EBUSY'
    expect(() => deployScriptFile(src, dest, 'win32')).toThrow(/EBUSY/)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(handleWrites()).toEqual([])
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('EBUSY')
  })

  it('that has another name (a hard link) and cannot be replaced is left as it is: no throw, and one warning', () => {
    destNlink = 2
    renameFails = 'EPERM'
    expect(deployScriptFile(src, dest, 'win32')).toBe('unchanged')
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(handleWrites()).toEqual([])
    expect(warned).toHaveLength(1)
  })
})

// What a launch runs from the scripts folder: a plain file with one name.
describe('isPlainScriptFile', () => {
  it('a plain file with one name is one', () => {
    destReal = true
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    expect(isPlainScriptFile(dest)).toBe(true)
  })

  it('nothing there is not one', () => {
    destReal = true
    expect(isPlainScriptFile(dest)).toBe(false)
  })

  it('a directory is not one', () => {
    destReal = true
    nodeFs.mkdirSync(dest)
    nodeFs.writeFileSync(join(dest, 'index.js'), '// not the app\'s\n')
    expect(isPlainScriptFile(dest)).toBe(false)
  })

  // Mutation to prove this can fail: drop the nlink test.
  it('a file with another name (a hard link) is not one', () => {
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    destNlink = 2
    expect(isPlainScriptFile(dest)).toBe(false)
  })

  it('a link is not one', () => {
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    destIsFile = false
    expect(isPlainScriptFile(dest)).toBe(false)
  })
})

// Nothing at the destination is opened or read before lstat shows a plain
// file (a FIFO there would block the start, a link to a device would read
// without end). Mutation to prove this can fail: read the destination with
// readFileSync before the lstat.
describe.each(['linux', 'darwin', 'win32'] as const)('deployScriptFile on %s: what is not a plain file is never opened', (platform) => {
  it('a FIFO, socket or device there (neither a file, a directory nor a link) is not opened, and is replaced by the shipped bytes', () => {
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    destOther = true
    destMode = 0o600
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expect(destOpened()).toBe(false)
    expect(lstatOfDest).toBe(1)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(removedAtDest().recursive).toBe(false)
  })

  it('a link there is not opened (what it names is never read), and is replaced', () => {
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    destIsFile = false
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expect(destOpened()).toBe(false)
  })

  it('a plain file there is read once lstat said so', () => {
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    destMode = 0o600
    expect(deployScriptFile(src, dest, platform)).toBe('unchanged')
    expect(opens.mock.calls.some((c) => String(c[0]) === dest)).toBe(true)
    expect(lstatOfDest).toBe(1)
  })

  // Between that lstat and the open, a link or a FIFO could be put there; the
  // open asks not to follow a link (O_NOFOLLOW) and not to wait (O_NONBLOCK).
  // Windows has neither flag, so where the system has none, stand-in values
  // are given for this case (read by the deploy when it opens) and taken off
  // again before the real open. Mutation to prove this can fail: open the
  // destination with O_RDONLY alone.
  it('the destination is opened without following a link and without waiting', () => {
    const c = nodeFs.constants as unknown as Record<string, number | undefined>
    const standIn: Record<string, number> = { O_NOFOLLOW: 0x20000000, O_NONBLOCK: 0x40000000 }
    const added = Object.keys(standIn).filter((k) => c[k] === undefined)
    try {
      for (const k of added) Object.defineProperty(c, k, { value: standIn[k], configurable: true, enumerable: true, writable: true })
      const strip = added.reduce((m, k) => m | standIn[k], 0)
      const want = (c.O_NOFOLLOW as number) | (c.O_NONBLOCK as number)
      opens.mockImplementation(((p: nodeFs.PathLike, flags?: nodeFs.OpenMode, mode?: nodeFs.Mode | null) => realOpenSync(p, (typeof flags === 'number' ? flags & ~strip : flags) as nodeFs.OpenMode, mode)) as typeof nodeFs.openSync)
      syncBuiltinESMExports()
      nodeFs.writeFileSync(dest, '// shipped v2\n')
      destMode = 0o600
      expect(deployScriptFile(src, dest, platform)).toBe('unchanged')
      const atDest = opens.mock.calls.filter((call: unknown[]) => String(call[0]) === dest)
      expect(atDest).toHaveLength(1)
      expect(typeof atDest[0][1]).toBe('number')
      expect((atDest[0][1] as number) & want).toBe(want)
    } finally {
      for (const k of added) delete c[k]
    }
  })

  it('a script whose bytes the app makes (the status line\'s) is put in place by the same rules', () => {
    destOther = true
    destMode = 0o600
    nodeFs.writeFileSync(dest, '// anything\n')
    expect(deployScriptBytes(Buffer.from('// made by the app\n'), dest, platform)).toBe('written')
    expect(destOpened()).toBe(false)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// made by the app\n')
  })

  // A plain file whose size is not the shipped bytes' has other bytes: it is
  // replaced without being read, so a large file put there is never read in
  // full. Mutation to prove this can fail: read a plain file whatever its
  // size.
  it('a plain file of another size there: its bytes are not read, and it is replaced by the shipped bytes', () => {
    nodeFs.writeFileSync(dest, '// a copy of another size, longer than the shipped bytes\n')
    destMode = 0o600
    reads.mockClear()
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expect(reads.mock.calls.filter((c) => typeof c[0] === 'number')).toEqual([])
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
  })
})

// A destination this run's deploy could not put the shipped bytes in place at
// is recorded (deployFailedThisRun), and a launch does not run what is there
// (script-folders.ts checkDeployedScript) until a later deploy this run puts
// them in place. Mutations to prove this can fail: drop the record when the
// put in place fails, or when the source cannot be read; never clear it.
describe.each(['linux', 'darwin', 'win32'] as const)('deployScriptFile on %s: a deploy that fails is recorded for this run', (platform) => {
  it('a changed copy that cannot be put in place is recorded; a later deploy that lands clears it', () => {
    nodeFs.writeFileSync(dest, '// an older copy\n')
    destMode = 0o600
    stagingFails = 'ENOSPC'
    expect(() => deployScriptFile(src, dest, platform)).toThrow(/ENOSPC/)
    expect(deployFailedThisRun(dest)).toBe(true)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// an older copy\n')
    stagingFails = null
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expect(deployFailedThisRun(dest)).toBe(false)
  })

  it('a source that cannot be read is recorded; a later deploy that finds the shipped bytes there clears it', () => {
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    destMode = 0o600
    const folderAsSource = join(dir, 'a-folder.js')
    nodeFs.mkdirSync(folderAsSource)
    expect(() => deployScriptFile(folderAsSource, dest, platform)).toThrow()
    expect(deployFailedThisRun(dest)).toBe(true)
    expect(deployScriptFile(src, dest, platform)).toBe('unchanged')
    expect(deployFailedThisRun(dest)).toBe(false)
  })

  it('a copy that lands is not recorded', () => {
    nodeFs.writeFileSync(dest, '// an older copy\n')
    destMode = 0o600
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expect(deployFailedThisRun(dest)).toBe(false)
  })

  // The suites' reset between cases clears the record too, so a later case
  // that reuses a destination does not start with another case's failure.
  it('the tests\' reset clears the record', () => {
    nodeFs.writeFileSync(dest, '// an older copy\n')
    destMode = 0o600
    stagingFails = 'ENOSPC'
    expect(() => deployScriptFile(src, dest, platform)).toThrow(/ENOSPC/)
    expect(deployFailedThisRun(dest)).toBe(true)
    _resetScriptDeployWarningForTest()
    expect(deployFailedThisRun(dest)).toBe(false)
  })
})

// Windows refuses a rename over a file with the read-only attribute, and a
// write into it: a copy with that attribute is made writable first, so the
// shipped bytes land. Mutation to prove this can fail: drop the chmod before
// the replace.
describe('deployScriptFile on Windows: a copy with the read-only attribute', () => {
  beforeEach(() => {
    destReal = true
    nodeFs.writeFileSync(dest, '// changed\n')
    nodeFs.chmodSync(dest, 0o444)
    writes.mockClear()
    chmods.mockClear()
  })

  it('is made writable, then replaced by the shipped bytes', () => {
    expect(deployScriptFile(src, dest, 'win32')).toBe('written')
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(chmods.mock.calls.filter((c) => String(c[0]) === dest).map((c) => c[1])).toEqual([0o666])
    expect(warned).toEqual([])
  })

  it('held open (the rename refused): made writable, then written in place', () => {
    renameFails = 'EPERM'
    expect(deployScriptFile(src, dest, 'win32')).toBe('written')
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(handleWrites()).toHaveLength(1)
  })

  it('one with another name (a hard link) is never made writable: the attribute is the file\'s, so its other name would lose it too', () => {
    destReal = false
    destMode = 0o444
    destNlink = 2
    renameFails = 'EPERM'
    expect(() => deployScriptFile(src, dest, 'win32')).toThrow(/EPERM/)
    expect(chmods.mock.calls.filter((c) => String(c[0]) === dest)).toEqual([])
  })
})

// macOS and Linux: a launch takes a script only when it is this user's and no
// one else may write to it; a copy with the shipped bytes that another user
// owns is replaced by one of this user's. The process's user id is stood in
// for. Mutations to prove this can fail: drop the owner test, or the write-bit
// test, from isPlainScriptFile; drop the owner test from needsReplacing.
describe.each(['linux', 'darwin'] as const)('on %s: the owner and who may write', (platform) => {
  beforeEach(() => {
    standInUid(1000)
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    writes.mockClear()
  })

  it('a plain file with one name of this user\'s, with no write for others, is one a launch takes', () => {
    destUid = 1000
    destMode = 0o644
    expect(isPlainScriptFile(dest, platform)).toBe(true)
  })

  it.each([['another user owns it', 4242, 0o600], ['group may write to it', 1000, 0o664], ['others may write to it', 1000, 0o646]] as Array<[string, number, number]>)('one that %s is not', (_label, uid, mode) => {
    destUid = uid
    destMode = mode
    expect(isPlainScriptFile(dest, platform)).toBe(false)
  })

  it('a copy with the shipped bytes that another user owns is replaced by a new file of this user\'s', () => {
    destUid = 4242
    destMode = 0o600
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expectReplacedNotOpened()
  })

  it('one of this user\'s, 0600, is left as it is', () => {
    destUid = 1000
    destMode = 0o600
    expect(deployScriptFile(src, dest, platform)).toBe('unchanged')
    expect(writeCalls()).toEqual([])
  })
})
