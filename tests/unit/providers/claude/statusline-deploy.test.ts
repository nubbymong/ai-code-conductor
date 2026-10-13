import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, statSync, utimesSync, chmodSync } from 'fs'
import nodeFs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock getResourcesDirectory so configureClaudeSettings does not touch the real path
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: vi.fn(() => _mockResources),
}))
let _mockResources = ''
// The app's log, kept so a case can read what the deploy said.
const warned = vi.hoisted(() => [] as string[])
vi.mock('../../../../src/main/debug-logger', () => ({
  logInfo: () => {},
  logError: () => {},
  logWarn: (...a: unknown[]) => { warned.push(a.map(String).join(' ')) },
}))

import { deployClaudeStatuslineScript, deployClaudeResumePickerScript } from '../../../../src/main/providers/claude/statusline'

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

describe('Claude script deployment', () => {
  let resDir: string
  let sandboxHome: string
  let homeBackup: string | undefined

  beforeEach(() => {
    resDir = mkdtempSync(join(tmpdir(), 'ccc-claude-deploy-'))
    _mockResources = resDir
    // Sandbox HOME so settings.json writes do not touch the real ~/.claude
    homeBackup = process.env.USERPROFILE ?? process.env.HOME
    sandboxHome = mkdtempSync(join(tmpdir(), 'ccc-home-'))
    if (process.platform === 'win32') process.env.USERPROFILE = sandboxHome
    else process.env.HOME = sandboxHome
  })

  afterEach(() => {
    try { rmSync(resDir, { recursive: true, force: true }) } catch {}
    try { rmSync(sandboxHome, { recursive: true, force: true }) } catch {}
    if (process.platform === 'win32') {
      if (homeBackup) process.env.USERPROFILE = homeBackup
      else delete process.env.USERPROFILE
    } else {
      if (homeBackup) process.env.HOME = homeBackup
      else delete process.env.HOME
    }
    vi.clearAllMocks()
  })

  it('deployClaudeStatuslineScript writes the statusline bridge to resourcesDir/scripts', async () => {
    await deployClaudeStatuslineScript(resDir)
    expect(existsSync(join(resDir, 'scripts', 'claude-multi-statusline.js'))).toBe(true)
  })

  it('deployClaudeStatuslineScript no longer plants a script in ~/.claude (footprint: resources copy only)', async () => {
    // U2: the statusline is delivered per-session pointing at the resources-dir
    // copy; the unreferenced ~/.claude/claude-multi-statusline.js is no longer
    // planted, and boot-heal removes any legacy one.
    await deployClaudeStatuslineScript(resDir)
    expect(existsSync(join(sandboxHome, '.claude', 'claude-multi-statusline.js'))).toBe(false)
  })

  it('deployClaudeResumePickerScript copies the source resume-picker.js to resourcesDir/scripts', async () => {
    // Per-test temp source root avoids races on the shared <repo>/src/main/scripts/
    // path that the deploy default resolves to under vitest. P4.11 added the
    // sourceRoot override exactly for this reason -- vitest runs files in parallel
    // and the Codex resume-picker test seeds the same default location.
    const tempSrcRoot = mkdtempSync(join(tmpdir(), 'ccc-claude-src-'))
    try {
      mkdirSync(join(tempSrcRoot, 'scripts'), { recursive: true })
      writeFileSync(join(tempSrcRoot, 'scripts', 'resume-picker.js'), '// test stub')
      await deployClaudeResumePickerScript(resDir, tempSrcRoot)
      expect(existsSync(join(resDir, 'scripts', 'resume-picker.js'))).toBe(true)
    } finally {
      try { rmSync(tempSrcRoot, { recursive: true, force: true }) } catch {}
    }
  })

  it('deployClaudeStatuslineScript no longer copies resume-picker.js', async () => {
    // After the split, statusline deploy is statusline-only.
    await deployClaudeStatuslineScript(resDir)
    expect(existsSync(join(resDir, 'scripts', 'resume-picker.js'))).toBe(false)
  })

  // The status line script is deployed by the rules every deployed script
  // follows (script-deploy.ts deployScriptBytes): what is at its path is read
  // without following a link first; a directory there is removed only when
  // empty, never what it holds; a copy whose bytes differ, the read-only
  // attribute included, is replaced; an unchanged one is not written again;
  // a failure is said in the log, by the file's name, and never stops the
  // start. A launch then names it only while it passes the launch check
  // (statusline-launch-gate.test.ts). Mutation to prove this can fail: write
  // it with writeFileSync under a catch that says nothing.
  describe('by the rules every deployed script follows', () => {
    const script = (): string => join(resDir, 'scripts', 'claude-multi-statusline.js')
    beforeEach(() => { warned.length = 0 })

    it('a directory holding index.js at its path: what it holds is kept, the start goes on, and one warning names the file, never its folder', async () => {
      mkdirSync(script(), { recursive: true })
      writeFileSync(join(script(), 'index.js'), '// not the app\'s\n')
      await expect(deployClaudeStatuslineScript(resDir)).resolves.toBeUndefined()
      expect(readFileSync(join(script(), 'index.js'), 'utf8')).toBe('// not the app\'s\n')
      expect(warned).toHaveLength(1)
      expect(warned[0]).toContain('claude-multi-statusline.js')
      expect(warned[0]).not.toContain(resDir)
    })

    it('an empty directory at its path is replaced by the script', async () => {
      mkdirSync(script(), { recursive: true })
      await deployClaudeStatuslineScript(resDir)
      expect(statSync(script()).isFile()).toBe(true)
      expect(readFileSync(script(), 'utf8')).toContain('AI Code Conductor - Statusline bridge script')
      expect(warned).toEqual([])
    })

    it('a changed copy with the read-only attribute (a mode with no write bit) is replaced by the app\'s', async () => {
      mkdirSync(join(resDir, 'scripts'), { recursive: true })
      writeFileSync(script(), '// changed\n')
      chmodSync(script(), 0o444)
      try {
        await deployClaudeStatuslineScript(resDir)
        expect(readFileSync(script(), 'utf8')).toContain('AI Code Conductor - Statusline bridge script')
      } finally {
        try { chmodSync(script(), 0o666) } catch { /* gone */ }
      }
    })

    it('an unchanged copy is not written again; a changed one is put back', async () => {
      await deployClaudeStatuslineScript(resDir)
      const old = new Date('2001-02-03T04:05:06Z')
      utimesSync(script(), old, old)
      await deployClaudeStatuslineScript(resDir)
      expect(statSync(script()).mtimeMs).toBe(old.getTime())
      writeFileSync(script(), '// changed\n')
      await deployClaudeStatuslineScript(resDir)
      expect(readFileSync(script(), 'utf8')).toContain('AI Code Conductor - Statusline bridge script')
    })

    it('a scripts folder that is a file: the start goes on, and one warning', async () => {
      writeFileSync(join(resDir, 'scripts'), 'a file')
      await expect(deployClaudeStatuslineScript(resDir)).resolves.toBeUndefined()
      expect(warned).toHaveLength(1)
      expect(warned[0]).toContain('claude-multi-statusline.js')
    })

    it.skipIf(process.platform === 'win32')('POSIX: the copy is this user\'s only (0600), and a scripts folder the deploy makes is 0700', async () => {
      await deployClaudeStatuslineScript(resDir)
      expect(statSync(script()).mode & 0o777).toBe(0o600)
      expect(statSync(join(resDir, 'scripts')).mode & 0o777).toBe(0o700)
    })
  })
})

// F14: in a packaged build the picker ships inside app.asar, and Electron
// serves fs.copyFileSync from there by copying the file out to a temporary
// file it does not remove before the process ends (one left in TEMP per
// script, every start). The deploy reads the bytes instead (no temporary
// file), compares them with the deployed copy, and writes only when they
// differ.
describe('F14: the resume picker is read and compared, never copied out of the archive', () => {
  let res: string
  let srcRoot: string
  const dest = (): string => join(res, 'scripts', 'resume-picker.js')

  beforeEach(() => {
    res = mkdtempSync(join(tmpdir(), 'ccc-claude-f14-res-'))
    srcRoot = mkdtempSync(join(tmpdir(), 'ccc-claude-f14-src-'))
    mkdirSync(join(srcRoot, 'scripts'), { recursive: true })
    writeFileSync(join(srcRoot, 'scripts', 'resume-picker.js'), '// picker v2\n')
  })

  afterEach(() => {
    restoreFs()
    try { rmSync(res, { recursive: true, force: true }) } catch {}
    try { rmSync(srcRoot, { recursive: true, force: true }) } catch {}
  })

  it('never calls copyFileSync on the deploy path', async () => {
    const copy = spyOnFs('copyFileSync')
    await deployClaudeResumePickerScript(res, srcRoot)
    expect(copy).not.toHaveBeenCalled()
    expect(readFileSync(dest(), 'utf8')).toBe('// picker v2\n')
  })

  it('identical bytes, this user\'s only: the deployed copy is not written again', async () => {
    mkdirSync(join(res, 'scripts'))
    writeFileSync(dest(), '// picker v2\n')
    // A copy a start leaves is this user's only (0600). On macOS and Linux a
    // copy with any group or other bit is replaced even when its bytes match
    // (script-deploy-mode.test.ts), and a plain write here gets the umask's
    // mode (0644 on CI), so the mode is set after the write, where the umask
    // cannot change it. Windows keeps only the read-only bit, which 0600 clears.
    chmodSync(dest(), 0o600)
    const old = new Date('2001-02-03T04:05:06Z')
    utimesSync(dest(), old, old)
    const copy = spyOnFs('copyFileSync')
    const write = spyOnFs('writeFileSync')
    await deployClaudeResumePickerScript(res, srcRoot)
    expect(copy).not.toHaveBeenCalled()
    expect(write.mock.calls.map((c) => String(c[0]))).not.toContain(dest())
    expect(statSync(dest()).mtimeMs).toBe(old.getTime())
  })

  it('changed bytes: the deployed copy is rewritten with the source bytes', async () => {
    mkdirSync(join(res, 'scripts'))
    writeFileSync(dest(), '// picker v1, or a changed copy\n')
    await deployClaudeResumePickerScript(res, srcRoot)
    expect(readFileSync(dest(), 'utf8')).toBe('// picker v2\n')
  })

  it('no source beside the app: nothing is written', async () => {
    rmSync(join(srcRoot, 'scripts', 'resume-picker.js'))
    await deployClaudeResumePickerScript(res, srcRoot)
    expect(existsSync(dest())).toBe(false)
  })

  // POSIX file modes (Windows keeps only a read-only bit): runs on CI (Linux, macOS).
  // A new copy, a rewritten one and an unchanged one all end this user's only
  // (as copyFileSync used to, by re-applying that mode).
  it.skipIf(process.platform === 'win32')('POSIX: every copy is this user\'s only after a start, new, rewritten or unchanged', async () => {
    chmodSync(join(srcRoot, 'scripts', 'resume-picker.js'), 0o644)
    await deployClaudeResumePickerScript(res, srcRoot)
    expect(statSync(dest()).mode & 0o777).toBe(0o600)
    writeFileSync(dest(), '// picker v1\n')
    chmodSync(dest(), 0o640)
    await deployClaudeResumePickerScript(res, srcRoot)
    expect(readFileSync(dest(), 'utf8')).toBe('// picker v2\n')
    expect(statSync(dest()).mode & 0o777).toBe(0o600)
    chmodSync(dest(), 0o666)
    await deployClaudeResumePickerScript(res, srcRoot)
    expect(readFileSync(dest(), 'utf8')).toBe('// picker v2\n')
    expect(statSync(dest()).mode & 0o777).toBe(0o600)
  })
})
