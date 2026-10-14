// HOST QUARANTINE: changes rights on temp folders (icacls, and the app's owner-only rule through Windows PowerShell) and, on macOS and Linux, their modes. [CI] [VM] only -- never run on the owner's machine.
//
// The scripts folders' rule for real (owner-only-folders.ts
// secureScriptFoldersRule, run at start by script-folders.ts), and what a
// launch then takes (checkDeployedScript).
//
// Windows: a resources folder inside a temp folder that lets Everyone in:
// the rule makes the scripts folder and its lib folder this user's alone, the
// read-only check (readOwnerOnlyFoldersWindows) reads both as owner-only, a
// script already inside that let Everyone in is put right, and a script
// deployed there afterwards is one a launch takes. Without the rule (nothing
// checked this run) the same script is refused.
//
// macOS and Linux: a scripts folder and lib folder that others may write to
// are made 0700; a script others may write to is refused at launch until the
// deploy replaces it with a copy of this user's only (0600).
//
// Owed as manual VM rows (two accounts): a script inside the scripts folder
// that another account owns is refused by a standard account's run (the
// folder is refused, the session starts without the scripts) and taken over
// by an elevated run; a resources folder on a FAT drive or a network share is
// refused, with one warning, and the sessions still start.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const warned = vi.hoisted(() => [] as string[])
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: () => {},
  logError: () => {},
  logWarn: (...a: unknown[]) => { warned.push(a.map(String).join(' ')) },
}))

import { secureScriptFoldersRule, readOwnerOnlyFoldersWindows, runWindowsPowerShell } from '../../../src/main/owner-only-folders'
import { secureScriptFolders, scriptFoldersDeployed, checkDeployedScript, __resetScriptFoldersForTests } from '../../../src/main/script-folders'
import { deployScriptFile, isPlainScriptFile } from '../../../src/main/script-deploy'

const IS_WIN = process.platform === 'win32'
const PREFIX = 'ccc-script-folders-real-'
const SYSROOT = process.env.SystemRoot || 'C:\\Windows'
const ICACLS = path.join(SYSROOT, 'System32', 'icacls.exe')
let top = ''
let res = ''
let src = ''

beforeEach(() => {
  top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  res = path.join(top, 'res')
  fs.mkdirSync(res)
  src = path.join(top, 'source.js')
  fs.writeFileSync(src, '// shipped\n')
  warned.length = 0
  __resetScriptFoldersForTests()
})

afterEach(() => {
  __resetScriptFoldersForTests()
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and parent.
  if (path.basename(top).startsWith(PREFIX) && path.dirname(top) === fs.realpathSync.native(os.tmpdir())) {
    fs.rmSync(top, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
})

describe.runIf(IS_WIN)('Windows, for real: the scripts folders made this user\'s alone at start', () => {
  beforeEach(() => {
    execFileSync(ICACLS, [top, '/grant', '*S-1-1-0:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
  })

  it('both folders are made and pass, read back as owner-only; a script deployed then is one a launch takes', async () => {
    const scripts = path.join(res, 'scripts')
    const lib = path.join(scripts, 'lib')
    await secureScriptFolders(res, secureScriptFoldersRule)
    const picker = path.join(scripts, 'resume-picker.js')
    expect(deployScriptFile(src, picker)).toBe('written')
    scriptFoldersDeployed()
    expect(warned).toEqual([])
    const read = await readOwnerOnlyFoldersWindows([scripts, lib])
    expect(read.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only'], [true, 'owner-only']])
    expect(checkDeployedScript(picker)).toEqual({ ok: true })
  }, 120_000)

  it('a script already inside that let Everyone in is put right, and the folder passes', async () => {
    const scripts = path.join(res, 'scripts')
    fs.mkdirSync(scripts)
    const picker = path.join(scripts, 'resume-picker.js')
    fs.writeFileSync(picker, '// shipped\n')
    execFileSync(ICACLS, [picker, '/grant', '*S-1-1-0:(M)'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
    const out = await secureScriptFoldersRule([scripts, path.join(scripts, 'lib')])
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only'], [true, 'owner-only']])
    const sddl = (await runWindowsPowerShell('(Get-Acl -LiteralPath $env:CCC_T_FILE).Sddl', { CCC_T_FILE: picker })).trim()
    expect(sddl).not.toMatch(/S-1-1-0|;WD\)/)
  }, 120_000)

  it('nothing checked this run: the same deployed script is refused', () => {
    const scripts = path.join(res, 'scripts')
    fs.mkdirSync(scripts)
    const picker = path.join(scripts, 'resume-picker.js')
    expect(deployScriptFile(src, picker)).toBe('written')
    expect(checkDeployedScript(picker)).toMatchObject({ ok: false, absent: false })
  })
})

describe.skipIf(IS_WIN)('macOS and Linux, for real: the folders\' and the scripts\' modes', () => {
  it('folders others may write to are made 0700 by the rule; a script others may write to is refused until the deploy replaces it with one of this user\'s only', async () => {
    const scripts = path.join(res, 'scripts')
    const lib = path.join(scripts, 'lib')
    fs.mkdirSync(lib, { recursive: true })
    fs.chmodSync(scripts, 0o777)
    fs.chmodSync(lib, 0o777)
    const picker = path.join(scripts, 'resume-picker.js')
    fs.writeFileSync(picker, '// shipped\n')
    fs.chmodSync(picker, 0o666)
    expect(isPlainScriptFile(picker)).toBe(false)
    await secureScriptFolders(res, secureScriptFoldersRule)
    expect(fs.statSync(scripts).mode & 0o777).toBe(0o700)
    expect(fs.statSync(lib).mode & 0o777).toBe(0o700)
    expect(deployScriptFile(src, picker)).toBe('written')
    scriptFoldersDeployed()
    expect(fs.statSync(picker).mode & 0o777).toBe(0o600)
    expect(checkDeployedScript(picker)).toEqual({ ok: true })
    expect(warned).toEqual([])
  })
})
