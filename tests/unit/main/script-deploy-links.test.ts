// HOST QUARANTINE: plants hard links, symbolic links, junctions and a FIFO (mkfifo), and holds a write handle on a deployed copy, in its own temp folder. [CI] [VM] only -- never run on the owner's machine.
// The link cases of script-deploy-mode.test.ts, kept here so the host-safe
// file plants no link.
//
// A write of a deployed script puts the bytes in a new file made with mode
// 0600, which is then renamed over the destination (atomicWriteFileSync); on
// macOS and Linux that is the only write, and it never opens the destination
// (Windows writes a plain file with one name in place only when it refuses
// that rename, which no case here asks of it). Before it, a link at the
// destination (a symbolic link to a file or a directory, a junction) is
// removed as a link, never followed, so what it named keeps what it holds. A
// symbolic link or a hard link whose bytes are the shipped ones is replaced
// too, on every platform, and on macOS and Linux a copy whose mode was
// loosened is replaced by a new file, so what still holds the old one (the
// other name of a hard link, a write handle opened while the mode was loose
// on POSIX) no longer reaches the copy in use. isPlainScriptFile, the check a
// launch makes before it runs a deployed script, refuses each of these
// objects.
//
// The platform is passed in, and the destination's mode is read through a
// stub where a case needs a loose mode on Windows; the POSIX block uses the
// real modes and runs on CI on Linux and macOS (Windows refuses to rename over
// a file another handle holds open).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import nodeFs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logError: () => {}, logWarn: () => {} }))

import { deployScriptFile, isPlainScriptFile } from '../../../src/main/script-deploy'

let dir = ''
let src = ''
let dest = ''
/** When set, the mode the stub reports for the destination (read without following a link). */
let stubMode: number | null = null

beforeEach(() => {
  dir = nodeFs.mkdtempSync(join(tmpdir(), 'ccc-script-deploy-links-'))
  src = join(dir, 'source.js')
  dest = join(dir, 'deployed.js')
  nodeFs.writeFileSync(src, '// shipped v2\n')
  stubMode = null
  const realLstat = nodeFs.lstatSync.bind(nodeFs)
  vi.spyOn(nodeFs, 'lstatSync').mockImplementation(((p: nodeFs.PathLike, o?: nodeFs.StatSyncOptions) => {
    if (stubMode === null || String(p) !== dest) return realLstat(p, o as never)
    return { mode: 0o100000 | stubMode, nlink: 1, isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false } as unknown as nodeFs.Stats
  }) as typeof nodeFs.lstatSync)
  syncBuiltinESMExports()
})

afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent.
  if (dir.startsWith(join(tmpdir(), 'ccc-script-deploy-links-'))) nodeFs.rmSync(dir, { recursive: true, force: true })
})

describe.each(['linux', 'darwin', 'win32'] as const)('deployScriptFile on %s', (platform) => {
  it('a hard link at the destination is replaced, not written through: the file it named keeps its bytes', () => {
    const linked = join(dir, 'other-file.js')
    nodeFs.writeFileSync(linked, '// another file\n')
    nodeFs.linkSync(linked, dest)
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(nodeFs.readFileSync(linked, 'utf8')).toBe('// another file\n')
    expect(nodeFs.statSync(linked).nlink).toBe(1)
  })

  // Mutation to prove this can fail: drop the nlink test from needsReplacing.
  it('a hard link with the shipped bytes is replaced by a file with one name: the other name no longer reaches the copy in use', () => {
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    const other = join(dir, 'other-name.js')
    nodeFs.linkSync(dest, other)
    expect(nodeFs.lstatSync(dest).nlink).toBe(2)
    expect(isPlainScriptFile(dest)).toBe(false)
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expect(nodeFs.lstatSync(dest).nlink).toBe(1)
    expect(isPlainScriptFile(dest)).toBe(true)
    expect(nodeFs.statSync(other).nlink).toBe(1)
    nodeFs.writeFileSync(other, '// rewritten through the other name\n')
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
  })
})

describe.each(['linux', 'darwin'] as const)('deployScriptFile on %s, a copy with the shipped bytes and a loose mode', (platform) => {
  it('is replaced by a new file: what still holds the old copy no longer reaches the copy in use', () => {
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    // The hard link is the old copy itself, as a handle opened on it while its mode was loose is.
    const old = join(dir, 'old-copy.js')
    nodeFs.linkSync(dest, old)
    stubMode = 0o666
    expect(deployScriptFile(src, dest, platform)).toBe('written')
    expect(nodeFs.statSync(old).nlink).toBe(1)
    nodeFs.writeFileSync(old, '// rewritten through the old copy\n')
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
  })
})

// A real symbolic link at the destination whose target holds the shipped
// bytes, on this machine's own platform: replaced by a plain file, and the
// file it named is left alone. A Windows account that may not make a symbolic
// link (no Developer Mode, not elevated) reports this case skipped, never
// passed. Mutation to prove this can fail on Windows: return before the lstat
// there.
describe('deployScriptFile on this machine, for real: a symbolic link with the shipped bytes', () => {
  it('is replaced by a plain file, and the file it named keeps its bytes', (ctx) => {
    const target = join(dir, 'other-file.js')
    nodeFs.writeFileSync(target, '// shipped v2\n')
    try {
      nodeFs.symlinkSync(target, dest, 'file')
    } catch (err) {
      if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw err
    }
    expect(deployScriptFile(src, dest)).toBe('written')
    expect(nodeFs.lstatSync(dest).isSymbolicLink()).toBe(false)
    expect(nodeFs.lstatSync(dest).isFile()).toBe(true)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    // Two files now: the copy in use is not the file the link named.
    expect(nodeFs.statSync(dest, { bigint: true }).ino).not.toBe(nodeFs.statSync(target, { bigint: true }).ino)
    expect(nodeFs.lstatSync(target).isFile()).toBe(true)
    expect(nodeFs.readFileSync(target, 'utf8')).toBe('// shipped v2\n')
  })
})

// A real directory link at the destination, on this machine's own platform
// (a junction on Windows, which any account may make; a symbolic link to a
// directory elsewhere): removed as a link, never followed, so the directory
// it named keeps what it holds, and the copy is put in its place. Mutation to
// prove this can fail: drop the isSymbolicLink branch of clearForWrite.
describe('deployScriptFile on this machine, for real: a directory link at the destination', () => {
  it('is removed as a link; the directory it named keeps what it holds', () => {
    const target = join(dir, 'other-folder')
    nodeFs.mkdirSync(target)
    nodeFs.writeFileSync(join(target, 'index.js'), '// another folder\'s file\n')
    nodeFs.symlinkSync(target, dest, process.platform === 'win32' ? 'junction' : 'dir')
    expect(isPlainScriptFile(dest)).toBe(false)
    expect(deployScriptFile(src, dest)).toBe('written')
    expect(nodeFs.lstatSync(dest).isFile()).toBe(true)
    expect(isPlainScriptFile(dest)).toBe(true)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(nodeFs.lstatSync(target).isDirectory()).toBe(true)
    expect(nodeFs.readFileSync(join(target, 'index.js'), 'utf8')).toBe('// another folder\'s file\n')
  })

  it('a directory symbolic link on Windows too (skipped where the account may not make one)', (ctx) => {
    if (process.platform !== 'win32') return ctx.skip()
    const target = join(dir, 'other-folder')
    nodeFs.mkdirSync(target)
    nodeFs.writeFileSync(join(target, 'index.js'), '// another folder\'s file\n')
    try {
      nodeFs.symlinkSync(target, dest, 'dir')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw err
    }
    expect(deployScriptFile(src, dest)).toBe('written')
    expect(nodeFs.lstatSync(dest).isFile()).toBe(true)
    expect(nodeFs.readFileSync(join(target, 'index.js'), 'utf8')).toBe('// another folder\'s file\n')
  })
})

// The real thing, where file modes and open handles behave as POSIX says:
// CI on Linux and macOS.
describe.skipIf(process.platform === 'win32')('deployScriptFile on this POSIX machine, for real', () => {
  it('a write handle opened on the copy while its mode was loose no longer reaches the copy in use once the start has run', () => {
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    nodeFs.chmodSync(dest, 0o666)
    const fd = nodeFs.openSync(dest, 'r+')
    try {
      expect(deployScriptFile(src, dest)).toBe('written')
      expect(nodeFs.statSync(dest).mode & 0o777).toBe(0o600)
      nodeFs.writeSync(fd, '// rewritten through the old handle\n', 0)
    } finally {
      nodeFs.closeSync(fd)
    }
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
  })

  it('a symbolic link at the destination is replaced, and the file it named keeps its bytes', () => {
    const target = join(dir, 'other-file.js')
    nodeFs.writeFileSync(target, '// another file\n')
    nodeFs.symlinkSync(target, dest)
    expect(deployScriptFile(src, dest)).toBe('written')
    expect(nodeFs.lstatSync(dest).isSymbolicLink()).toBe(false)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(nodeFs.readFileSync(target, 'utf8')).toBe('// another file\n')
  })

  it('an unchanged copy already this user\'s only is left as it is', () => {
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    nodeFs.chmodSync(dest, 0o600)
    const ino = nodeFs.statSync(dest, { bigint: true }).ino
    expect(deployScriptFile(src, dest)).toBe('unchanged')
    expect(nodeFs.statSync(dest, { bigint: true }).ino).toBe(ino)
  })

  // Nothing at the destination is opened before lstat shows a plain file: a
  // FIFO there would block the start (no writer ever comes), and a link to a
  // device reads without end. Both are replaced at once. Mutation to prove
  // this can fail (it hangs the worker: run it with a hard time limit): read
  // the destination with readFileSync before the lstat.
  it('a FIFO at the destination is never waited on: it is replaced by the shipped bytes', () => {
    execFileSync('mkfifo', [dest], { stdio: 'ignore', timeout: 10_000 })
    expect(nodeFs.lstatSync(dest).isFIFO()).toBe(true)
    expect(deployScriptFile(src, dest)).toBe('written')
    expect(nodeFs.lstatSync(dest).isFile()).toBe(true)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
    expect(isPlainScriptFile(dest)).toBe(true)
  })

  it('a link to a device that reads without end is never read: it is replaced', () => {
    nodeFs.symlinkSync('/dev/zero', dest)
    expect(deployScriptFile(src, dest)).toBe('written')
    expect(nodeFs.lstatSync(dest).isSymbolicLink()).toBe(false)
    expect(nodeFs.readFileSync(dest, 'utf8')).toBe('// shipped v2\n')
  })

  it('a copy with the shipped bytes another user may write to is not one a launch takes, and the deploy replaces it with one of this user\'s only', () => {
    nodeFs.writeFileSync(dest, '// shipped v2\n')
    nodeFs.chmodSync(dest, 0o646)
    expect(isPlainScriptFile(dest)).toBe(false)
    expect(deployScriptFile(src, dest)).toBe('written')
    expect(nodeFs.statSync(dest).mode & 0o777).toBe(0o600)
    expect(isPlainScriptFile(dest)).toBe(true)
  })
})
