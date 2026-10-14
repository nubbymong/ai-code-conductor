import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, utimesSync, chmodSync } from 'fs'
import nodeFs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'path'
import { tmpdir } from 'os'
// The warnings the deploy logs, for the cases that check them.
const warned = vi.hoisted(() => [] as string[])
vi.mock('../../../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/debug-logger')>()),
  logWarn: (...a: unknown[]) => { warned.push(a.map(String).join(' ')) },
}))

import { CodexProvider } from '../../../../src/main/providers/codex'
import { deployCodexResumePickerScript } from '../../../../src/main/providers/codex/resume-picker'

/** A spy on one fs function that the code under test sees: it imports fs as a
 *  module namespace, whose bindings follow the fs object only once synced. */
function spyOnFs(name: 'copyFileSync' | 'writeFileSync') {
  const spy = vi.spyOn(nodeFs, name)
  syncBuiltinESMExports()
  return spy
}
/** Undo the spies, and sync the bindings back to the real functions. */
function restoreFs(): void {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
}

describe('Codex resume picker deploy', () => {
  let resDir: string
  let tempSrcRoot: string

  beforeEach(() => {
    resDir = mkdtempSync(join(tmpdir(), 'ccc-codex-deploy-'))
    // Per-test temp source root replaces the shared <repo>/src/main/scripts/
    // stub. P4.11 added the sourceRoot override on deployCodexResumePickerScript
    // to avoid races on that shared on-disk path under vitest's parallel runner.
    tempSrcRoot = mkdtempSync(join(tmpdir(), 'ccc-codex-src-'))
    mkdirSync(join(tempSrcRoot, 'scripts', 'lib'), { recursive: true })
    writeFileSync(join(tempSrcRoot, 'scripts', 'codex-resume-picker.js'), '// test stub picker')
    writeFileSync(join(tempSrcRoot, 'scripts', 'lib', 'codex-resume-picker-lib.js'), '// test stub lib')
  })

  afterEach(() => {
    try { rmSync(resDir, { recursive: true, force: true }) } catch {}
    try { rmSync(tempSrcRoot, { recursive: true, force: true }) } catch {}
  })

  it('CodexProvider has a deployResumePickerScript method', () => {
    const p = new CodexProvider()
    expect(typeof p.deployResumePickerScript).toBe('function')
  })

  it('copies scripts/codex-resume-picker.js into resourcesDir/scripts/', async () => {
    await deployCodexResumePickerScript(resDir, tempSrcRoot)
    expect(existsSync(join(resDir, 'scripts', 'codex-resume-picker.js'))).toBe(true)
  })

  it('also copies the helper lib so the picker can require it', async () => {
    await deployCodexResumePickerScript(resDir, tempSrcRoot)
    expect(existsSync(join(resDir, 'scripts', 'lib', 'codex-resume-picker-lib.js'))).toBe(true)
  })

  it('creates the scripts dir if missing', async () => {
    expect(existsSync(join(resDir, 'scripts'))).toBe(false)
    await deployCodexResumePickerScript(resDir, tempSrcRoot)
    expect(existsSync(join(resDir, 'scripts'))).toBe(true)
  })

  it('does not throw when called twice', async () => {
    await deployCodexResumePickerScript(resDir, tempSrcRoot)
    await expect(deployCodexResumePickerScript(resDir, tempSrcRoot)).resolves.not.toThrow()
  })

  // F14: in a packaged build both files ship inside app.asar, and Electron
  // serves fs.copyFileSync from there by copying each out to a temporary file
  // it does not remove before the process ends. The deploy reads the bytes
  // instead, compares them with the deployed copy, and writes only when they
  // differ.
  describe('F14: read and compared, never copied out of the archive', () => {
    const picker = (): string => join(resDir, 'scripts', 'codex-resume-picker.js')
    const lib = (): string => join(resDir, 'scripts', 'lib', 'codex-resume-picker-lib.js')

    afterEach(() => { restoreFs() })

    it('never calls copyFileSync on the deploy path', async () => {
      const copy = spyOnFs('copyFileSync')
      await deployCodexResumePickerScript(resDir, tempSrcRoot)
      expect(copy).not.toHaveBeenCalled()
      expect(readFileSync(picker(), 'utf8')).toBe('// test stub picker')
      expect(readFileSync(lib(), 'utf8')).toBe('// test stub lib')
    })

    it('identical bytes: neither deployed copy is written again', async () => {
      await deployCodexResumePickerScript(resDir, tempSrcRoot)
      const old = new Date('2001-02-03T04:05:06Z')
      utimesSync(picker(), old, old)
      utimesSync(lib(), old, old)
      const copy = spyOnFs('copyFileSync')
      const write = spyOnFs('writeFileSync')
      await deployCodexResumePickerScript(resDir, tempSrcRoot)
      expect(copy).not.toHaveBeenCalled()
      const written = write.mock.calls.map((c) => String(c[0]))
      expect(written).not.toContain(picker())
      expect(written).not.toContain(lib())
      expect(statSync(picker()).mtimeMs).toBe(old.getTime())
      expect(statSync(lib()).mtimeMs).toBe(old.getTime())
    })

    it('changed bytes: only the changed copy is rewritten, with the source bytes', async () => {
      await deployCodexResumePickerScript(resDir, tempSrcRoot)
      const old = new Date('2001-02-03T04:05:06Z')
      utimesSync(picker(), old, old)
      writeFileSync(lib(), '// an older lib, or a changed copy')
      await deployCodexResumePickerScript(resDir, tempSrcRoot)
      expect(readFileSync(lib(), 'utf8')).toBe('// test stub lib')
      expect(statSync(picker()).mtimeMs).toBe(old.getTime())
    })

    // POSIX file modes (Windows keeps only a read-only bit): runs on CI (Linux, macOS).
    // A new copy, a rewritten one and an unchanged one all end this user's
    // only (as copyFileSync used to, by re-applying that mode).
    it.skipIf(process.platform === 'win32')('POSIX: every copy is this user\'s only after a start, new, rewritten or unchanged', async () => {
      chmodSync(join(tempSrcRoot, 'scripts', 'codex-resume-picker.js'), 0o644)
      await deployCodexResumePickerScript(resDir, tempSrcRoot)
      expect(statSync(picker()).mode & 0o777).toBe(0o600)
      writeFileSync(picker(), '// older picker')
      chmodSync(picker(), 0o640)
      await deployCodexResumePickerScript(resDir, tempSrcRoot)
      expect(readFileSync(picker(), 'utf8')).toBe('// test stub picker')
      expect(statSync(picker()).mode & 0o777).toBe(0o600)
      chmodSync(picker(), 0o666)
      await deployCodexResumePickerScript(resDir, tempSrcRoot)
      expect(readFileSync(picker(), 'utf8')).toBe('// test stub picker')
      expect(statSync(picker()).mode & 0o777).toBe(0o600)
    })
  })

  // The folder the picker loads its lib from. The lib is written only into a
  // real folder there: a link (a junction on Windows, a directory link on
  // macOS and Linux) is removed as a link, never what it names, and a
  // directory that resolves to another folder is removed without recursion,
  // and a real folder made in its place before the lib is written. No link is
  // made here: the folder is read as a link, or its resolved path as another
  // folder, through a stub, and removing it is played by moving the folder it
  // stands for out of the way (the folder it names keeps what it holds). The
  // real-link cases are in resume-picker-lib-links.test.ts (CI and the VM
  // only).
  describe('the helper lib folder', () => {
    const libDir = (): string => join(resDir, 'scripts', 'lib')
    const lib = (): string => join(libDir(), 'codex-resume-picker-lib.js')
    /** Where the folder the stand-in link names ends up once the link is removed. */
    const named = (): string => join(resDir, 'the-folder-it-named')
    let linked = false
    /** While set, the folder reads as a plain directory that resolves to another folder. */
    let resolvesElsewhere = false
    /** When set, removing the stand-in link fails with this code, both ways. */
    let removalRefused: string | null = null
    let unlinks: ReturnType<typeof vi.spyOn>
    let rmdirs: ReturnType<typeof vi.spyOn>
    let rms: ReturnType<typeof vi.spyOn>
    const calledOn = (spy: ReturnType<typeof vi.spyOn>, p: string): boolean => spy.mock.calls.some((c) => String(c[0]) === p)

    beforeEach(() => {
      // The folder the link stands for: another folder, with a lib of its own.
      mkdirSync(libDir(), { recursive: true })
      writeFileSync(lib(), '// their own lib')
      writeFileSync(join(libDir(), 'theirs.txt'), 'kept')
      linked = true
      resolvesElsewhere = false
      removalRefused = null
      warned.length = 0
      const realLstat = nodeFs.lstatSync.bind(nodeFs)
      vi.spyOn(nodeFs, 'lstatSync').mockImplementation(((p: nodeFs.PathLike, o?: nodeFs.StatSyncOptions) => {
        if (linked && String(p) === libDir()) {
          return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true, nlink: 1, mode: 0o120777 } as unknown as nodeFs.Stats
        }
        return realLstat(p, o as never)
      }) as typeof nodeFs.lstatSync)
      const removeLink = (): void => {
        if (removalRefused) throw Object.assign(new Error(`${removalRefused}: refused`), { code: removalRefused })
        nodeFs.renameSync(libDir(), named())
        linked = false
      }
      const realUnlink = nodeFs.unlinkSync.bind(nodeFs)
      unlinks = vi.spyOn(nodeFs, 'unlinkSync').mockImplementation((p: nodeFs.PathLike) => {
        if (linked && String(p) === libDir()) return removeLink()
        realUnlink(p)
      })
      const realRmdir = nodeFs.rmdirSync.bind(nodeFs)
      rmdirs = vi.spyOn(nodeFs, 'rmdirSync').mockImplementation(((p: nodeFs.PathLike, o?: nodeFs.RmDirOptions) => {
        if (resolvesElsewhere && String(p) === libDir()) {
          nodeFs.renameSync(libDir(), named())
          resolvesElsewhere = false
          return
        }
        if (linked && String(p) === libDir()) return removeLink()
        // Its options passed on as given, so a recursive removal would be one.
        realRmdir(p, o)
      }) as typeof nodeFs.rmdirSync)
      const realNative = nodeFs.realpathSync.native.bind(nodeFs.realpathSync)
      vi.spyOn(nodeFs.realpathSync, 'native').mockImplementation(((p: nodeFs.PathLike, o?: unknown) => {
        if (resolvesElsewhere && String(p) === libDir()) return named()
        return realNative(p, o as never)
      }) as typeof nodeFs.realpathSync.native)
      rms = vi.spyOn(nodeFs, 'rmSync')
      syncBuiltinESMExports()
    })

    afterEach(() => { restoreFs() })

    it('a link there is removed as a link and a real folder made in its place, with the lib in it; the folder it named keeps what it holds', async () => {
      await deployCodexResumePickerScript(resDir, tempSrcRoot)
      expect(calledOn(unlinks, libDir())).toBe(true)
      expect(calledOn(rms, libDir())).toBe(false)
      const st = nodeFs.lstatSync(libDir())
      expect(st.isDirectory() && !st.isSymbolicLink()).toBe(true)
      expect(nodeFs.readdirSync(libDir())).toEqual(['codex-resume-picker-lib.js'])
      expect(readFileSync(lib(), 'utf8')).toBe('// test stub lib')
      expect(readFileSync(join(named(), 'codex-resume-picker-lib.js'), 'utf8')).toBe('// their own lib')
      expect(readFileSync(join(named(), 'theirs.txt'), 'utf8')).toBe('kept')
      expect(readFileSync(join(resDir, 'scripts', 'codex-resume-picker.js'), 'utf8')).toBe('// test stub picker')
      expect(warned).toEqual([])
    })

    it('a link there that cannot be removed: the deploy throws, logged by the folder name, and nothing is written through it', async () => {
      removalRefused = 'EACCES'
      await expect(deployCodexResumePickerScript(resDir, tempSrcRoot)).rejects.toThrow(/EACCES/)
      expect(calledOn(unlinks, libDir())).toBe(true)
      expect(calledOn(rms, libDir())).toBe(false)
      expect(readFileSync(lib(), 'utf8')).toBe('// their own lib')
      expect(readFileSync(join(libDir(), 'theirs.txt'), 'utf8')).toBe('kept')
      expect(warned).toHaveLength(1)
      expect(warned[0]).toContain('lib folder')
      expect(warned[0]).toContain('EACCES')
      expect(warned[0]).not.toContain(resDir)
    })

    it('a real folder there is kept, with what it holds: nothing removed', async () => {
      linked = false
      await deployCodexResumePickerScript(resDir, tempSrcRoot)
      expect(calledOn(unlinks, libDir())).toBe(false)
      expect(calledOn(rmdirs, libDir())).toBe(false)
      expect(readFileSync(lib(), 'utf8')).toBe('// test stub lib')
      expect(readFileSync(join(libDir(), 'theirs.txt'), 'utf8')).toBe('kept')
    })

    // Mutation to prove this can fail: keep any directory lstat reads as plain.
    it('a directory there that resolves to another folder is removed without recursion and a real folder made in its place, with the lib in it; the folder it resolved to keeps what it holds', async () => {
      linked = false
      resolvesElsewhere = true
      await deployCodexResumePickerScript(resDir, tempSrcRoot)
      expect(calledOn(rmdirs, libDir())).toBe(true)
      expect(calledOn(rms, libDir())).toBe(false)
      const st = nodeFs.lstatSync(libDir())
      expect(st.isDirectory() && !st.isSymbolicLink()).toBe(true)
      expect(nodeFs.readdirSync(libDir())).toEqual(['codex-resume-picker-lib.js'])
      expect(readFileSync(lib(), 'utf8')).toBe('// test stub lib')
      expect(readFileSync(join(named(), 'codex-resume-picker-lib.js'), 'utf8')).toBe('// their own lib')
      expect(readFileSync(join(named(), 'theirs.txt'), 'utf8')).toBe('kept')
      expect(warned).toEqual([])
    })
  })
})
