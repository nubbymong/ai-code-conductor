// HOST QUARANTINE: starts real processes (Windows PowerShell 5.1, PowerShell 7 when present, node). [CI] [VM] only -- never run on the owner's machine.
// A Windows Claude session's resume list runs on the node.exe the app found,
// whatever the session's PowerShell profile does (2.1.1-beta.3). The app's
// own launch line (buildClaudeLaunchCommand), with node.exe answered as the
// node running this test, is run by Windows PowerShell 5.1, the session
// shell, and by PowerShell 7 when it is installed (or named by
// CCC_TEST_PWSH), after statements a profile may run: a function or an alias
// named node.exe, and folders put first on PATH. The picker is a stand-in
// script that writes which node ran it; any other stand-in writes OTHER, or
// is an empty node.exe that cannot start at all. The session also inherits a
// CCC_CLAUDE_BIN naming another Claude Code, and the picker gets this
// session's, as the line names it. A control runs the line naming node by
// its file name, so the harness can tell the two apart. A node.exe found
// under a folder whose name holds brackets (v[1]) is never started; its
// control starts the bracketed path. No Claude Code, no app, no network;
// every process gets a fresh environment (isolatedProbeEnv). Windows only.
// The line's own shape: spawn-claude-no-node.test.ts.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { spawnSync } from 'node:child_process'

// node.exe is found where the session's PowerShell looks: answered with the
// node that runs this test, or with __pickerNodeExe when a test sets it.
// Every other lookup is the real one.
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  const nodeOnly = (names: readonly string[]): boolean => names.length === 1 && names[0] === 'node.exe'
  const found = (): string => ((globalThis as any).__pickerNodeExe as string | undefined) ?? process.execPath
  return {
    ...actual,
    findOnWindowsPath: ((names, ...rest) => (nodeOnly(names) ? found() : actual.findOnWindowsPath(names, ...rest))) as typeof actual.findOnWindowsPath,
    findOnWindowsPathAsync: (async (names, ...rest) => (nodeOnly(names) ? found() : actual.findOnWindowsPathAsync(names, ...rest))) as typeof actual.findOnWindowsPathAsync,
  }
})
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildClaudeLaunchCommand, quoteArgForShell, _resetPickerNodeFoundForTest } from '../../../src/main/spawn-claude-command'
import { isolatedProbeEnv } from '../../helpers/home-guard-core.mjs'

const BS = String.fromCharCode(92)
const SYSROOT = process.env.SystemRoot || process.env.SYSTEMROOT || `C:${BS}Windows`
const POWERSHELL = path.join(SYSROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const PWSH = [process.env.CCC_TEST_PWSH, path.join(process.env.ProgramFiles || `C:${BS}Program Files`, 'PowerShell', '7', 'pwsh.exe')]
  .find((p): p is string => typeof p === 'string' && p !== '' && fs.existsSync(p))
const onWindows = process.platform === 'win32' && fs.existsSync(POWERSHELL)
const SHELLS: Array<[string, string]> = [['Windows PowerShell 5.1', POWERSHELL], ...(PWSH ? [['PowerShell 7', PWSH] as [string, string]] : [])]
const NODE = process.execPath

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-picker-node-'))
// Every program this file starts has ended by then (run); the retries only
// wait out a short lock, such as an antivirus scan of the node.exe copy.
afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })

/** What a profile may run before the line, each in a session of its own.
 *  `early` is a folder outside the session folder holding node.exe.cmd. */
const PROFILES: Array<[string, (early: string) => string]> = [
  ['a function named node.exe', () => 'function node.exe { Set-Content -LiteralPath $env:CCC_TEST_MARK -Value OTHER }'],
  ['an alias named node.exe', () => 'function Write-CccOther { Set-Content -LiteralPath $env:CCC_TEST_MARK -Value OTHER }; Set-Alias -Name node.exe -Value Write-CccOther'],
  ['a node.exe.cmd in a folder put first on PATH', (early) => `$env:PATH = ${quoteArgForShell(early, true)} + ';' + $env:PATH`],
  ['`.` put first on PATH', () => "$env:PATH = '.;' + $env:PATH"],
  ['`node_modules\\.bin` put first on PATH', () => "$env:PATH = 'node_modules\\.bin;' + $env:PATH"],
]

let seq = 0
/** Runs `line` (or the line `edit` makes of it) after `profile` in `shell`;
 *  what the picker stand-in wrote, or null when nothing was written. */
async function run(shell: string, profile: (early: string) => string, edit: (line: string) => string = (l) => l): Promise<{ line: string; out: string; mark: string | null; claudeBin: string }> {
  const dir = path.join(ROOT, `run-${++seq}`)
  const proj = path.join(dir, 'proj')
  const early = path.join(dir, 'early')
  for (const d of [path.join(proj, 'node_modules', '.bin'), early]) fs.mkdirSync(d, { recursive: true })
  // Empty files named node.exe in the session folder: Windows cannot start one.
  fs.writeFileSync(path.join(proj, 'node.exe'), '')
  fs.writeFileSync(path.join(proj, 'node_modules', '.bin', 'node.exe'), '')
  fs.writeFileSync(path.join(early, 'node.exe.cmd'), '@echo OTHER> "%CCC_TEST_MARK%"\r\n')
  const picker = path.join(dir, 'picker.cjs')
  fs.writeFileSync(picker, "require('fs').writeFileSync(process.env.CCC_TEST_MARK, JSON.stringify({ node: process.execPath, bin: process.env.CCC_CLAUDE_BIN, argv: process.argv.slice(2) }))\n")
  const mark = path.join(dir, 'mark.txt')
  const claudeBin = path.join(dir, 'nowhere', 'claude.exe')
  const line = edit(buildClaudeLaunchCommand({
    platform: 'win32', cwd: proj, claudeBin, extraFlags: ' --model opus', agentsFlag: '',
    useResumePicker: true, pickerScript: picker,
  }))
  const env = isolatedProbeEnv(path.join(dir, 'home')) as Record<string, string>
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH' || k.toUpperCase() === 'PATHEXT') delete env[k]
  // The PATH a Claude session gets: fully qualified folders only.
  env.Path = [path.dirname(NODE), path.join(SYSROOT, 'System32'), SYSROOT, path.dirname(POWERSHELL)].join(';')
  env.PATHEXT = '.COM;.EXE;.BAT;.CMD'
  env.CCC_TEST_MARK = mark
  // A value the app itself inherited: the line names this session's Claude Code over it.
  env.CCC_CLAUDE_BIN = path.join(dir, 'inherited', 'claude.exe')
  const command = `${profile(early)}; ${line}`
  const r = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { cwd: proj, env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
  // The shell waits for every program the line starts, so its end is theirs.
  // A shell stopped at the time limit is not: a program it started may still
  // be running from this folder.
  if (r.error || r.signal) throw new Error(`${shell} did not finish (${r.error?.message ?? r.signal}); a program it started may still be running in ${dir}\n${r.stdout ?? ''}${r.stderr ?? ''}`)
  for (let i = 0; i < 50 && !fs.existsSync(mark); i++) await new Promise((res) => setTimeout(res, 100))
  return { line, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, mark: fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8').trim() : null, claudeBin }
}

describe.runIf(onWindows)('Windows: the resume list runs on the node.exe the app found, whatever the session\'s PowerShell profile does', () => {
  for (const [name, shell] of SHELLS) {
    for (const [what, profile] of PROFILES) {
      it(`${name}, ${what}: the line starts the app's node.exe, which runs the picker`, async () => {
        const res = await run(shell, profile)
        expect(res.mark, `${res.line}\n${res.out}`).not.toBeNull()
        const got = JSON.parse(res.mark!) as { node: string; bin: string; argv: string[] }
        expect(got.node.toLowerCase()).toBe(NODE.toLowerCase())
        expect(got.bin).toBe(res.claudeBin)
        expect(got.argv).toEqual(['--model', 'opus'])
      }, 180_000)

      // The harness can fail: the line naming node by its file name.
      it(`${name}, ${what}: control, a line that names node.exe by its file name`, async () => {
        const named = (l: string): string => l.replace(`& ${quoteArgForShell(NODE, true)} `, 'node.exe ')
        const res = await run(shell, profile, named)
        expect(res.line).toContain('; node.exe ')
        const ranApp = res.mark !== null && res.mark !== 'OTHER' && (JSON.parse(res.mark) as { node: string }).node.toLowerCase() === NODE.toLowerCase()
        expect(ranApp, `${res.line}\n${res.out}`).toBe(false)
      }, 180_000)
    }
  }
})

describe.runIf(onWindows)('Windows: a node.exe found under a folder whose name holds brackets is never started', () => {
  /** node.exe at br\v[1] (the one found): a copy of the node running this
   *  test; at br\v1 beside it: a hard link to that copy, or a second copy
   *  when the link cannot be made. Never a link to the node running this
   *  test: it runs until the whole run ends, and the classic Windows delete
   *  (Node 20's fs.rmSync, as on CI) refuses to remove any name of a program
   *  that is running, so ROOT could not be removed. */
  let found = ''
  let beside = ''
  const setUp = (): void => {
    if (found) return
    const br = path.join(ROOT, 'br')
    found = path.join(br, 'v[1]', 'node.exe')
    beside = path.join(br, 'v1', 'node.exe')
    for (const p of [found, beside]) fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.copyFileSync(NODE, found)
    try { fs.linkSync(found, beside) } catch { fs.copyFileSync(found, beside) }
  }
  const nothing = (): string => '$null = 0'
  afterAll(() => { delete (globalThis as any).__pickerNodeExe; _resetPickerNodeFoundForTest() })

  for (const [name, shell] of SHELLS) {
    it(`${name}: the line starts no node at all, so neither runs the picker`, async () => {
      setUp()
      ;(globalThis as any).__pickerNodeExe = found
      _resetPickerNodeFoundForTest()
      try {
        const res = await run(shell, nothing)
        // The folders here are under ROOT (ccc-picker-node-...), so the line
        // is checked for node.exe and the found path, not the word node.
        expect(res.line).not.toContain('v[1]')
        expect(res.line).not.toMatch(/node\.exe/i)
        expect(res.mark, `${res.line}\n${res.out}`).toBeNull()
      } finally {
        delete (globalThis as any).__pickerNodeExe
        _resetPickerNodeFoundForTest()
      }
    }, 180_000)
  }

  // The harness can fail: the bracketed path put on the line by hand.
  it('control: Windows PowerShell 5.1 told to start the bracketed path', async () => {
    setUp()
    _resetPickerNodeFoundForTest()
    const bracketed = (l: string): string => l.replace(`& ${quoteArgForShell(NODE, true)} `, `& ${quoteArgForShell(found, true)} `)
    const res = await run(POWERSHELL, nothing, bracketed)
    expect(res.line).toContain('v[1]')
    expect(res.mark, `${res.line}\n${res.out}`).not.toBeNull()
    expect((JSON.parse(res.mark!) as { node: string }).node.toLowerCase()).toBe(beside.toLowerCase())
  }, 180_000)
})
