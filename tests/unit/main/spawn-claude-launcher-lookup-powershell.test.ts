// HOST QUARANTINE: starts real processes (Windows PowerShell 5.1, PowerShell 7 when present, cmd.exe). [CI] [VM] only -- never run on the owner's machine.
// A Windows Claude session's own launch line, run by Windows PowerShell 5.1
// (the session shell) and by PowerShell 7 when it is installed (or named by
// CCC_TEST_PWSH), after statements a profile may run (2.1.1-beta.3):
//  - npm's claude.cmd, a launcher written as npm's cmd-shim writes it with
//    no node.exe beside it, starts `node` through cmd.exe. Whatever the
//    profile does to PATH or to the program lookup setting, on every route
//    that starts Claude Code itself the line sets the session's lookup again
//    first (LAUNCHER_PROGRAM_LOOKUP), and the node found in a fully qualified
//    PATH folder is the one that runs. Stand-ins elsewhere mark which one
//    ran. A control runs the same line without those statements, so the
//    harness can tell the two apart.
//  - The session folder's name holds [ ]: proj[1] with proj1 beside it, and
//    solo[2] alone. The line names it by -LiteralPath, and the program runs
//    in it. A control runs the bare `Set-Location '<folder>'` form, so the
//    harness can tell the two apart.
// Every program is a stand-in (.cmd files that write a marker); no node, no
// Claude Code, no app, no network; every process gets a fresh environment
// (isolatedProbeEnv). Windows only. The line's shape, host-safe:
// spawn-claude-launcher-lookup.test.ts and spawn-claude-literal-paths.test.ts.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { spawnSync } from 'node:child_process'

// node.exe is never found, so a route that would start the resume list
// starts Claude Code itself; every other lookup is the real one.
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  const nodeOnly = (names: readonly string[]): boolean => names.length === 1 && names[0] === 'node.exe'
  return {
    ...actual,
    findOnWindowsPath: ((names, ...rest) => (nodeOnly(names) ? null : actual.findOnWindowsPath(names, ...rest))) as typeof actual.findOnWindowsPath,
    findOnWindowsPathAsync: (async (names, ...rest) => (nodeOnly(names) ? null : actual.findOnWindowsPathAsync(names, ...rest))) as typeof actual.findOnWindowsPathAsync,
  }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildClaudeLaunchCommand, LAUNCHER_PROGRAM_LOOKUP, _resetPickerNodeFoundForTest } from '../../../src/main/spawn-claude-command'
import { isolatedProbeEnv } from '../../helpers/home-guard-core.mjs'

const BS = String.fromCharCode(92)
const SYSROOT = process.env.SystemRoot || process.env.SYSTEMROOT || `C:${BS}Windows`
const POWERSHELL = path.join(SYSROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const PWSH = [process.env.CCC_TEST_PWSH, path.join(process.env.ProgramFiles || `C:${BS}Program Files`, 'PowerShell', '7', 'pwsh.exe')]
  .find((p): p is string => typeof p === 'string' && p !== '' && fs.existsSync(p))
const onWindows = process.platform === 'win32' && fs.existsSync(POWERSHELL)
const SHELLS: Array<[string, string]> = [['Windows PowerShell 5.1', POWERSHELL], ...(PWSH ? [['PowerShell 7', PWSH] as [string, string]] : [])]
const UUID = '0b7d2f3e-1c4a-4e8b-9f6d-2a5c8e1b3d7f'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-launcher-lookup-'))
afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }) })

const CRLF = '\r\n'
/** A node.cmd stand-in in `dir` that writes `mark` to CCC_TEST_MARK. */
function standIn(dir: string, mark: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'node.cmd'), `@echo ${mark}> "%CCC_TEST_MARK%"${CRLF}`)
}
/** npm's cmd-shim launcher for a global claude install, with no node.exe beside it. */
function npmShim(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'claude.cmd')
  fs.writeFileSync(file, [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    `IF EXIST "%dp0%${BS}node.exe" (`, `  SET "_prog=%dp0%${BS}node.exe"`, ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%${BS}node_modules${BS}@anthropic-ai${BS}claude-code${BS}cli.js" %*`, ''].join(CRLF))
  return file
}

/** The environment a Claude session's PowerShell starts with: fully qualified
 *  PATH folders only (`first` before the system ones), and the lookup setting. */
function sessionEnv(dir: string, first: string, mark: string): Record<string, string> {
  const env = isolatedProbeEnv(path.join(dir, 'home')) as Record<string, string>
  for (const k of Object.keys(env)) if (['PATH', 'PATHEXT', 'NODEFAULTCURRENTDIRECTORYINEXEPATH'].includes(k.toUpperCase())) delete env[k]
  env.Path = [first, path.join(SYSROOT, 'System32'), SYSROOT, path.dirname(POWERSHELL)].join(';')
  env.PATHEXT = '.COM;.EXE;.BAT;.CMD'
  env.NoDefaultCurrentDirectoryInExePath = '1'
  env.CCC_TEST_MARK = mark
  return env
}

let seq = 0
/** Runs `profile` then `line` in `shell` from `cwd`; what the stand-in wrote, or null. */
async function runLine(shell: string, cwd: string, env: Record<string, string>, profile: string, line: string): Promise<{ out: string; mark: string | null }> {
  const r = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`${profile}${line}`, 'utf16le').toString('base64')],
    { cwd, env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
  const mark = env.CCC_TEST_MARK
  for (let i = 0; i < 30 && !fs.existsSync(mark); i++) await new Promise((res) => setTimeout(res, 100))
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, mark: fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8').trim() : null }
}

/** What a profile may run before the line, and whether its control (the
 *  line without the statements) tells the two apart: the quoted folder
 *  padded with spaces only shows the statements keep a working PATH. */
const PROFILES: Array<[string, string, boolean]> = [
  ['`node_modules\\.bin` put first on PATH', "$env:Path = 'node_modules\\.bin;' + $env:Path; ", true],
  ['`.` put first on PATH', "$env:Path = '.;' + $env:Path; ", true],
  ['a quoted, padded relative folder put first on PATH', "$env:Path = ' \".\\node_modules\\.bin\" ;' + $env:Path; ", false],
  ['the lookup setting removed', 'Remove-Item Env:NoDefaultCurrentDirectoryInExePath; ', true],
  ['the lookup setting removed and `.` put first on PATH', "Remove-Item Env:NoDefaultCurrentDirectoryInExePath; $env:Path = '.;' + $env:Path; ", true],
]
/** Every route on which the line starts Claude Code itself. */
const ROUTES: Array<[string, Partial<Parameters<typeof buildClaudeLaunchCommand>[0]>]> = [
  ['a fresh session without the resume list', { useResumePicker: false, pickerScript: null }],
  ['an exact resume', { useResumePicker: true, pickerScript: `C:${BS}ccc${BS}resume-picker.js`, resumeUuid: UUID }],
  ['the resume list with no node.exe found', { useResumePicker: true, pickerScript: `C:${BS}ccc${BS}resume-picker.js` }],
  ['Ask Conductor', { useResumePicker: false, pickerScript: null, askPrompt: true }],
]

describe.runIf(onWindows)('Windows: npm\'s claude.cmd starts the node in a fully qualified PATH folder, whatever the profile did', () => {
  for (const [name, shell] of SHELLS) {
    for (const [route, ropts] of ROUTES) {
      for (const [what, profile, discriminates] of PROFILES) {
        const setUp = (): { dir: string; repo: string; sysnode: string; claudeBin: string } => {
          const dir = path.join(ROOT, `npm-${++seq}`)
          const repo = path.join(dir, 'repo')
          const sysnode = path.join(dir, 'sysnode')
          standIn(repo, 'REPO_ROOT')
          standIn(path.join(repo, 'node_modules', '.bin'), 'REPO_NODE_MODULES_BIN')
          standIn(sysnode, 'SYSTEM_NODE')
          return { dir, repo, sysnode, claudeBin: npmShim(path.join(dir, 'npm')) }
        }
        const lineFor = (repo: string, claudeBin: string): string => {
          _resetPickerNodeFoundForTest()
          return buildClaudeLaunchCommand({ platform: 'win32', cwd: repo, claudeBin, extraFlags: ' --model opus', agentsFlag: '', ...ropts })
        }

        it(`${name}, ${route}, ${what}: the system node runs`, async () => {
          const s = setUp()
          const line = lineFor(s.repo, s.claudeBin)
          expect(line).toContain(`${LAUNCHER_PROGRAM_LOOKUP}& '`)
          const res = await runLine(shell, s.repo, sessionEnv(s.dir, s.sysnode, path.join(s.dir, 'mark.txt')), profile, line)
          expect(res.mark, `${line}\n${res.out}`).toBe('SYSTEM_NODE')
        }, 180_000)

        // The harness can fail: the same line without the statements.
        it.runIf(discriminates)(`${name}, ${route}, ${what}: control, the line without the statements`, async () => {
          const s = setUp()
          const line = lineFor(s.repo, s.claudeBin).replace(LAUNCHER_PROGRAM_LOOKUP, '')
          const res = await runLine(shell, s.repo, sessionEnv(s.dir, s.sysnode, path.join(s.dir, 'mark.txt')), profile, line)
          expect(['REPO_ROOT', 'REPO_NODE_MODULES_BIN'], `${line}\n${res.out}`).toContain(res.mark)
        }, 180_000)
      }
    }
  }
})

describe.runIf(onWindows)('Windows: the program runs in the session folder as written, [ ] included', () => {
  /** One spelling of a folder, so two can be compared: the long name of every
   *  part, lower-cased. The folders here are under os.tmpdir(), which on a
   *  runner whose TEMP is written with a short 8.3 name (RUNNER~1) keeps that
   *  name, while the program reports the long one (runneradmin);
   *  fs.realpathSync.native expands it. A value that names no folder (or is
   *  missing) is compared as given. */
  const folder = (p: string | null | undefined): string | undefined => {
    if (p === null || p === undefined) return undefined
    try { return fs.realpathSync.native(p).toLowerCase() } catch { return p.toLowerCase() }
  }
  /** A claude.cmd stand-in that writes the folder it runs in. */
  const whereBin = (dir: string): string => {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'claude.cmd')
    fs.writeFileSync(file, `@echo %CD%> "%CCC_TEST_MARK%"${CRLF}`)
    return file
  }
  const CASES: Array<[string, string, string[]]> = [['pair', 'proj[1]', ['proj[1]', 'proj1']], ['solo', 'solo[2]', ['solo[2]']]]
  for (const [name, shell] of SHELLS) {
    for (const [kind, target, dirs] of CASES) {
      const setUp = (): { dir: string; cwd: string; claudeBin: string; line: string } => {
        const dir = path.join(ROOT, `cwd-${++seq}`)
        for (const d of dirs) fs.mkdirSync(path.join(dir, kind, d), { recursive: true })
        const cwd = path.join(dir, kind, target)
        const claudeBin = whereBin(path.join(dir, 'bin'))
        _resetPickerNodeFoundForTest()
        const line = buildClaudeLaunchCommand({ platform: 'win32', cwd, claudeBin, extraFlags: '', agentsFlag: '', useResumePicker: false, pickerScript: null })
        return { dir, cwd, claudeBin, line }
      }

      it(`${name}, ${kind} (${target}): the line runs the program in that folder`, async () => {
        const s = setUp()
        const res = await runLine(shell, s.cwd, sessionEnv(s.dir, path.join(s.dir, 'bin'), path.join(s.dir, 'mark.txt')), '', s.line)
        expect(folder(res.mark), `${s.line}\n${res.out}`).toBe(folder(s.cwd))
      }, 180_000)

      // The harness can fail: the bare Set-Location form.
      it(`${name}, ${kind} (${target}): control, the bare Set-Location form`, async () => {
        const s = setUp()
        const bare = s.line.replace('Set-Location -LiteralPath ', 'Set-Location ')
        const res = await runLine(shell, s.cwd, sessionEnv(s.dir, path.join(s.dir, 'bin'), path.join(s.dir, 'mark.txt')), '', bare)
        if (kind === 'pair') expect(folder(res.mark), `${bare}\n${res.out}`).toBe(folder(path.join(s.dir, kind, 'proj1')))
        else if (shell === POWERSHELL) expect(folder(res.mark), `${bare}\n${res.out}`).not.toBe(folder(s.cwd))
        else expect(folder(res.mark), `${bare}\n${res.out}`).toBe(folder(s.cwd))
      }, 180_000)
    }
  }
})
