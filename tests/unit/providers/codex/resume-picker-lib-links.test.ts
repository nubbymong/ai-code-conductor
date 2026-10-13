// HOST QUARANTINE: plants a junction (Windows, by fs.symlinkSync and by running mountvol and mklink /J) or a directory symbolic link (macOS, Linux) at the resources folder's scripts/lib, in its own temp folder. [CI] [VM] only -- never run on the owner's machine.
// The real-link cases of the Codex resume picker's helper lib folder. The
// host-safe cases read that folder as a link, or its resolved path as another
// folder, through a stub (resume-picker-deploy.test.ts, spawn.test.ts,
// script-deploy-folder.test.ts).
//
// The picker loads its lib from <resources>/scripts/lib. A launch takes the
// picker only when that folder is a real folder (getCodexResumePickerPath:
// otherwise null, one warning, Codex starts directly), and the deploy makes
// it one before it writes the lib, removing a link there as a link, never
// what it names; a launch after that deploy takes the picker again.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import nodeFs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const warned = vi.hoisted(() => [] as string[])
vi.mock('../../../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/debug-logger')>()),
  logWarn: (...a: unknown[]) => { warned.push(a.map(String).join(' ')) },
}))
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => (globalThis as any).__libLinksResDir ?? '',
  getDataDirectory: () => '',
}))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))

import { getCodexResumePickerPath } from '../../../../src/main/providers/codex/spawn'
import { deployCodexResumePickerScript } from '../../../../src/main/providers/codex/resume-picker'
import { __markScriptFoldersCheckedForTests, __resetScriptFoldersForTests } from '../../../../src/main/script-folders'

const PREFIX = join(tmpdir(), 'ccc-codex-lib-links-')
let base = ''
let resDir = ''
let srcRoot = ''
let elsewhere = ''
const scripts = (): string => join(resDir, 'scripts')
const libDir = (): string => join(scripts(), 'lib')
const picker = (): string => join(scripts(), 'codex-resume-picker.js')
const LIB = 'codex-resume-picker-lib.js'

/** A junction on Windows (no privilege needed), a directory link elsewhere. */
function linkFolder(target: string, at: string): void {
  nodeFs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
}

/** Windows: a junction whose target names the folder by its volume
 *  (\\?\Volume{...}\<path>), made with mklink /J. The test home guard does not map
 *  a volume path in a command-line argument and fails closed on one, so the target
 *  reaches mklink through its environment, where the guard does not expand %VAR%;
 *  the junction's own place stays on the command line, where the guard checks it.
 *  The target must be inside this test's own temp folder. */
function linkFolderByVolume(target: string, at: string): void {
  if (!/^[A-Za-z]:\\/.test(target)) throw new Error('this case needs the temp folder on a drive letter')
  if (!target.startsWith(PREFIX)) throw new Error(`only this test's own temp folder is linked this way, not ${target}`)
  const volume = execFileSync('mountvol', [`${target.slice(0, 2)}\\`, '/L'], { encoding: 'utf8' }).trim()
  if (!/^\\\\\?\\Volume\{[0-9a-fA-F-]+\}\\$/.test(volume)) throw new Error(`mountvol gave no volume path: ${volume}`)
  execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', at, '%CCC_VOLUME_TARGET%'], {
    env: { ...process.env, CCC_VOLUME_TARGET: volume + target.slice(3) },
    stdio: 'ignore',
  })
}

const isRealFolder = (p: string): boolean => {
  const st = nodeFs.lstatSync(p)
  return st.isDirectory() && !st.isSymbolicLink()
}

/** Whether the folder at `p` resolves to its own place. */
const resolvesToItself = (p: string): boolean =>
  nodeFs.realpathSync.native(p).toLowerCase() === join(nodeFs.realpathSync.native(join(p, '..')), 'lib').toLowerCase()

beforeEach(() => {
  base = nodeFs.mkdtempSync(PREFIX)
  resDir = join(base, 'resources')
  srcRoot = join(base, 'source')
  elsewhere = join(base, 'elsewhere')
  nodeFs.mkdirSync(join(srcRoot, 'scripts', 'lib'), { recursive: true })
  nodeFs.writeFileSync(join(srcRoot, 'scripts', 'codex-resume-picker.js'), '// shipped picker')
  nodeFs.writeFileSync(join(srcRoot, 'scripts', 'lib', LIB), '// shipped lib')
  // The folder a link at scripts/lib names: another folder, with a lib of its own.
  nodeFs.mkdirSync(elsewhere)
  nodeFs.writeFileSync(join(elsewhere, LIB), '// not the app\'s lib')
  nodeFs.writeFileSync(join(elsewhere, 'theirs.txt'), 'kept')
  nodeFs.mkdirSync(scripts(), { recursive: true })
  ;(globalThis as any).__libLinksResDir = resDir
  // As the start does before a launch: the scripts folder made the user's alone.
  __markScriptFoldersCheckedForTests(resDir)
  warned.length = 0
})

afterEach(() => {
  __resetScriptFoldersForTests()
  delete (globalThis as any).__libLinksResDir
  // A link is removed as a link first, so the cleanup never walks into it.
  try {
    if (nodeFs.lstatSync(libDir()).isSymbolicLink()) {
      try { nodeFs.unlinkSync(libDir()) } catch { nodeFs.rmdirSync(libDir()) }
    } else if (!resolvesToItself(libDir())) {
      // A junction that names its folder by volume: removed without recursion.
      nodeFs.rmdirSync(libDir())
    }
  } catch { /* nothing there */ }
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent.
  if (base.startsWith(PREFIX)) nodeFs.rmSync(base, { recursive: true, force: true })
})

describe('a real link at the Codex picker\'s helper lib folder', () => {
  it('a launch refuses the picker, with one warning, and never takes the lib the link leads to', () => {
    nodeFs.writeFileSync(picker(), '// shipped picker')
    linkFolder(elsewhere, libDir())
    // The lib reads as a plain file with one name through the link: the
    // folder check is what refuses it.
    const libThroughLink = nodeFs.lstatSync(join(libDir(), LIB))
    expect(libThroughLink.isFile() && libThroughLink.nlink === 1).toBe(true)
    expect(getCodexResumePickerPath()).toBeNull()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('the scripts/lib folder in the resources folder is not a real folder')
    expect(warned[0]).not.toContain(base)
  })

  it('the deploy removes the link as a link, makes a real folder with the shipped lib, and leaves the folder it named as it was', async () => {
    linkFolder(elsewhere, libDir())
    await deployCodexResumePickerScript(resDir, srcRoot)
    expect(isRealFolder(libDir())).toBe(true)
    expect(nodeFs.readdirSync(libDir())).toEqual([LIB])
    expect(nodeFs.readFileSync(join(libDir(), LIB), 'utf8')).toBe('// shipped lib')
    expect(nodeFs.readFileSync(join(elsewhere, LIB), 'utf8')).toBe('// not the app\'s lib')
    expect(nodeFs.readFileSync(join(elsewhere, 'theirs.txt'), 'utf8')).toBe('kept')
    expect(nodeFs.readdirSync(elsewhere).sort()).toEqual([LIB, 'theirs.txt'].sort())
    // A launch after the next start's check (the lib folder the deploy made,
    // made the user's alone) takes the picker again.
    __markScriptFoldersCheckedForTests(resDir)
    expect(getCodexResumePickerPath()).toBe(picker())
    expect(warned).toEqual([])
  })

  it('a link whose folder is gone is removed too, and a real folder made in its place', async () => {
    linkFolder(elsewhere, libDir())
    if (elsewhere.startsWith(PREFIX)) nodeFs.rmSync(elsewhere, { recursive: true, force: true })
    await deployCodexResumePickerScript(resDir, srcRoot)
    expect(isRealFolder(libDir())).toBe(true)
    expect(nodeFs.readFileSync(join(libDir(), LIB), 'utf8')).toBe('// shipped lib')
    expect(nodeFs.existsSync(elsewhere)).toBe(false)
    __markScriptFoldersCheckedForTests(resDir)
    expect(getCodexResumePickerPath()).toBe(picker())
  })
})

// A junction whose target names its folder by volume. The first check pins
// the shape this case is about (it reads as a plain directory without
// following a link); if a VM run fails there, the junction's setup is to be
// fixed, not the rule.
describe.runIf(process.platform === 'win32')('a junction at the helper lib folder that names its folder by volume', () => {
  it('a launch refuses the picker, with one warning', () => {
    nodeFs.writeFileSync(picker(), '// shipped picker')
    linkFolderByVolume(elsewhere, libDir())
    const st = nodeFs.lstatSync(libDir())
    expect(st.isDirectory() && !st.isSymbolicLink(), 'the junction reads as a plain directory').toBe(true)
    expect(resolvesToItself(libDir())).toBe(false)
    expect(getCodexResumePickerPath()).toBeNull()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('the scripts/lib folder in the resources folder is not a real folder')
    expect(warned[0]).not.toContain(base)
  })

  it('the deploy removes it without recursion, makes a real folder with the shipped lib, and leaves the folder it named as it was', async () => {
    linkFolderByVolume(elsewhere, libDir())
    await deployCodexResumePickerScript(resDir, srcRoot)
    expect(isRealFolder(libDir())).toBe(true)
    expect(resolvesToItself(libDir())).toBe(true)
    expect(nodeFs.readdirSync(libDir())).toEqual([LIB])
    expect(nodeFs.readFileSync(join(libDir(), LIB), 'utf8')).toBe('// shipped lib')
    expect(nodeFs.readFileSync(join(elsewhere, LIB), 'utf8')).toBe('// not the app\'s lib')
    expect(nodeFs.readdirSync(elsewhere).sort()).toEqual([LIB, 'theirs.txt'].sort())
    __markScriptFoldersCheckedForTests(resDir)
    expect(getCodexResumePickerPath()).toBe(picker())
    expect(warned).toEqual([])
  })
})
