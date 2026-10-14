// windows-programs.ts: helper tools start from the system folder, and programs
// are found only in PATH's absolute folders, by their full path. Every file
// test is injected and child_process is mocked: no process is started and no
// real file is read.
import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** Every start the PowerShell profile lookup makes, with its child under the test's control. */
const cp = vi.hoisted(() => ({
  spawn: [] as Array<{ file: string; args: string[]; opts: Record<string, unknown>; child: unknown }>,
  execFile: [] as Array<{ file: string; args: string[]; opts: Record<string, unknown>; cb: () => void }>,
  spawnThrows: null as Error | null,
}))
vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
    if (cp.spawnThrows) throw cp.spawnThrows
    const child = fakeChild()
    cp.spawn.push({ file, args, opts, child })
    return child
  },
  execFile: (file: string, args: string[], opts: Record<string, unknown>, cb: () => void) => {
    cp.execFile.push({ file, args, opts, cb })
    return {}
  },
}))

import {
  systemTool,
  findOnWindowsPath,
  findOnWindowsPathAsync,
  windowsPathFolders,
  windowsEnvValue,
  windowsBatchFileCommand,
  windowsStartCommand,
  withoutCurrentFolderLookup,
  withFullyQualifiedProgramLookup,
  findWithPowerShellProfile,
  powerShellProfileAnswer,
  powerShellProfileLookupCommand,
  POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS,
  POWERSHELL_PROFILE_EXIT_DRAIN_MS,
} from '../../../src/main/windows-programs'
import { windowsPathFolderIsFullyQualified } from '../../../src/main/providers/windows-path-names'

/** A file test that answers from a set, recording every path it was asked. */
function files(present: string[], unreachable: string[] = []) {
  const asked: string[] = []
  const set = new Set(present.map((p) => p.toLowerCase()))
  const dead = unreachable.map((d) => d.toLowerCase())
  const stat = (p: string): boolean => {
    asked.push(p)
    if (dead.some((d) => p.toLowerCase().startsWith(d + '\\'))) throw Object.assign(new Error('unreachable'), { code: 'EACCES' })
    return set.has(p.toLowerCase())
  }
  const statAsync = async (p: string): Promise<boolean> => stat(p)
  return { asked, stat, statAsync }
}

describe('helper tools start from the system folder', () => {
  it('names the tool below <SystemRoot>\\System32 by its full path', () => {
    expect(systemTool('taskkill.exe', { SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(systemTool('WindowsPowerShell\\v1.0\\powershell.exe', { SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(systemTool('reg.exe', { SystemRoot: 'C:/Windows/' })).toBe('C:\\Windows\\System32\\reg.exe')
  })

  it('reads SystemRoot in any case, as Windows does', () => {
    expect(systemTool('cmd.exe', { SYSTEMROOT: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(systemTool('cmd.exe', { systemroot: 'E:\\W' })).toBe('E:\\W\\System32\\cmd.exe')
  })

  it('throws when SystemRoot is not a plain drive-absolute folder', () => {
    for (const root of [
      undefined, '', ' ', 'Windows', '.\\Windows', '\\Windows', 'C:Windows',
      '\\\\server\\share\\Windows', '//server/share/Windows', '\\\\?\\C:\\Windows', '\\\\.\\C:\\Windows',
      'C:\\Windows\\..\\Temp', 'C:\\.\\Windows', 'C:\\%WINDIR%', 'C:\\Win"dows', 'C:\\Windows.', 'C:\\Windows \\x',
      'C:\\Win\u0001dows', 'C:\\a\\\\b',
    ]) {
      const env = root === undefined ? {} : { SystemRoot: root }
      expect(() => systemTool('taskkill.exe', env), JSON.stringify(root)).toThrow(/SystemRoot/)
    }
  })

  it('throws for a tool path that is not a plain path below the system folder', () => {
    for (const rel of ['', 'C:\\x.exe', '\\x.exe', '..\\x.exe', 'a\\..\\x.exe', '.\\x.exe', 'x%y.exe', 'x.exe.', 'x:y.exe', 'a\\\\x.exe']) {
      expect(() => systemTool(rel, { SystemRoot: 'C:\\Windows' }), rel).toThrow(/plain path/)
    }
  })
})

describe('programs are found only in PATH\'s absolute folders', () => {
  const PATH = ['.', 'rel\\bin', '..\\up', '%LOCALAPPDATA%\\x', 'C:\\%PF%\\bin', '\\rooted', 'C:relative', '', '  ', '"C:\\Quoted Dir"', 'C:\\A', 'D:/B', '\\\\srv\\share\\tools'].join(';')

  it('reads only fully qualified folders, in PATH order, quotes dropped', () => {
    expect(windowsPathFolders({ PATH })).toEqual(['C:\\Quoted Dir', 'C:\\A', 'D:/B', '\\\\srv\\share\\tools'])
  })

  it('never asks a relative, rooted, drive-relative or %-entry for a file', () => {
    const f = files([])
    expect(findOnWindowsPath(['git.exe'], { PATH }, f.stat)).toBeNull()
    expect(f.asked).toEqual(['C:\\Quoted Dir\\git.exe', 'C:\\A\\git.exe', 'D:\\B\\git.exe', '\\\\srv\\share\\tools\\git.exe'])
  })

  it('answers the full path of the first folder in PATH order that holds the file', () => {
    const f = files(['C:\\A\\gh.exe', 'D:\\B\\gh.exe'])
    expect(findOnWindowsPath(['gh.exe'], { PATH: 'C:\\A;D:\\B' }, f.stat)).toBe('C:\\A\\gh.exe')
    expect(findOnWindowsPath(['gh.exe'], { PATH: 'D:\\B;C:\\A' }, f.stat)).toBe('D:\\B\\gh.exe')
  })

  it('a file in a relative entry is never found', () => {
    const f = files(['rel\\bin\\gh.exe', '.\\gh.exe', 'gh.exe'])
    expect(findOnWindowsPath(['gh.exe'], { PATH: '.;rel\\bin' }, f.stat)).toBeNull()
    expect(f.asked).toEqual([])
  })

  it('folder order: in each folder the names in the order given', () => {
    const f = files(['C:\\A\\npm.cmd', 'D:\\B\\npm.exe'])
    expect(findOnWindowsPath(['npm.exe', 'npm.cmd'], { PATH: 'C:\\A;D:\\B' }, f.stat)).toBe('C:\\A\\npm.cmd')
    const g = files(['C:\\A\\npm.cmd', 'C:\\A\\npm.exe'])
    expect(findOnWindowsPath(['npm.exe', 'npm.cmd'], { PATH: 'C:\\A' }, g.stat)).toBe('C:\\A\\npm.exe')
  })

  it('name order: the first name in every folder before the next name', () => {
    const f = files(['C:\\A\\claude.cmd', 'D:\\B\\claude.exe'])
    expect(findOnWindowsPath(['claude.exe', 'claude.cmd'], { PATH: 'C:\\A;D:\\B' }, f.stat, 'name')).toBe('D:\\B\\claude.exe')
    expect(f.asked).toEqual(['C:\\A\\claude.exe', 'D:\\B\\claude.exe'])
  })

  it('an unreachable folder is not asked again for the next name', () => {
    const f = files(['D:\\B\\claude.cmd'], ['\\\\dead\\share'])
    expect(findOnWindowsPath(['claude.exe', 'claude.cmd'], { PATH: '\\\\dead\\share;D:\\B' }, f.stat, 'name')).toBe('D:\\B\\claude.cmd')
    expect(f.asked.filter((p) => p.startsWith('\\\\dead'))).toEqual(['\\\\dead\\share\\claude.exe'])
    const g = files(['D:\\B\\x.cmd'], ['C:\\dead'])
    expect(findOnWindowsPath(['x.exe', 'x.cmd'], { PATH: 'C:\\dead;D:\\B' }, g.stat)).toBe('D:\\B\\x.cmd')
    expect(g.asked.filter((p) => p.startsWith('C:\\dead'))).toEqual(['C:\\dead\\x.exe'])
  })

  it('reads PATH in any case and names a folder as Windows runs from it', () => {
    const f = files(['C:\\tools\\gh.exe'])
    expect(findOnWindowsPath(['gh.exe'], { Path: 'C:\\tools.' }, f.stat)).toBe('C:\\tools\\gh.exe')
    expect(windowsEnvValue({ path: 'x' }, 'PATH')).toBe('x')
    expect(windowsEnvValue({ PATH: 'exact', Path: 'other' }, 'PATH')).toBe('exact')
  })

  it('no PATH, or nothing found: null, never a bare name', () => {
    expect(findOnWindowsPath(['gh.exe'], {}, files([]).stat)).toBeNull()
    expect(findOnWindowsPath(['gh.exe'], { PATH: 'C:\\A' }, files([]).stat)).toBeNull()
  })

  it('throws for a name that is not a plain file name', () => {
    for (const bad of [[], ['a\\gh.exe'], ['..'], ['C:gh.exe'], ['gh.exe.'], ['%x%.exe']]) {
      expect(() => findOnWindowsPath(bad as string[], { PATH: 'C:\\A' }, files([]).stat), JSON.stringify(bad)).toThrow()
    }
  })

  it('the async walk keeps every rule: absolute folders, both orders, the unreachable memo', async () => {
    const f = files(['C:\\A\\claude.cmd', 'D:\\B\\claude.exe'], ['\\\\dead\\share'])
    const env = { PATH: `.;rel;%X%;C:\\%Y%;\\\\dead\\share;C:\\A;D:\\B` }
    expect(await findOnWindowsPathAsync(['claude.exe', 'claude.cmd'], env, f.statAsync, 'name')).toBe('D:\\B\\claude.exe')
    expect(f.asked.every((p) => /^([A-Za-z]:\\|\\\\)/.test(p) && !p.includes('%'))).toBe(true)
    expect(await findOnWindowsPathAsync(['claude.exe', 'claude.cmd'], env, f.statAsync)).toBe('C:\\A\\claude.cmd')
    expect(await findOnWindowsPathAsync(['x.exe'], { PATH: '.;rel' }, f.statAsync)).toBeNull()
    const g = files(['D:\\B\\claude.cmd'], ['\\\\dead\\share'])
    expect(await findOnWindowsPathAsync(['claude.exe', 'claude.cmd'], env, g.statAsync, 'name')).toBe('D:\\B\\claude.cmd')
    expect(g.asked.filter((p) => p.startsWith('\\\\dead'))).toEqual(['\\\\dead\\share\\claude.exe'])
  })
})

describe('a batch file runs through the system cmd.exe, never through a shell option', () => {
  const env = { SystemRoot: 'C:\\Windows' }

  it('quotes the batch file and passes plain arguments, verbatim', () => {
    expect(windowsBatchFileCommand('C:\\Program Files\\nodejs\\npm.cmd', ['install', '--prefix', 'C:/v/2.1.3', '@scope/pkg@2.1.3'], env)).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" install --prefix C:/v/2.1.3 @scope/pkg@2.1.3"'],
      windowsVerbatimArguments: true,
    })
  })

  it('refuses a path cmd.exe or the batch file would re-read', () => {
    for (const p of ['C:\\a%b%\\x.cmd', 'C:\\a&b\\x.cmd', 'C:\\a^b\\x.cmd', 'C:\\a"b\\x.cmd', 'C:\\a\nb\\x.cmd']) {
      expect(windowsBatchFileCommand(p, [], env), p).toHaveProperty('refused')
    }
  })

  it('refuses a relative path, a non-batch file and an argument that is not plain', () => {
    expect(windowsBatchFileCommand('x.cmd', [], env)).toHaveProperty('refused')
    expect(windowsBatchFileCommand('.\\x.cmd', [], env)).toHaveProperty('refused')
    expect(windowsBatchFileCommand('C:\\x.exe', [], env)).toHaveProperty('refused')
    for (const a of ['a b', 'a&b', '%x%', 'a"b', 'a^b', 'a|b', 'a<b', 'a>b', '(a)', '!a!', '', 'a\tb']) {
      expect(windowsBatchFileCommand('C:\\x.cmd', [a], env), JSON.stringify(a)).toHaveProperty('refused')
    }
  })

  it('refuses when the system cmd.exe cannot be named', () => {
    expect(windowsBatchFileCommand('C:\\x.cmd', [], { SystemRoot: 'Windows' })).toHaveProperty('refused')
    expect(windowsBatchFileCommand('C:\\x.cmd', [], {})).toHaveProperty('refused')
  })

  it('a comma-joined list and an empty value after = are one plain argument each', () => {
    const r = windowsBatchFileCommand('C:\\npm\\claude.cmd', ['--tools=', '--disallowedTools', 'Bash,Read,Write'], env)
    expect(r).toHaveProperty('args')
    expect((r as { args: string[] }).args[4]).toBe('""C:\\npm\\claude.cmd" --tools= --disallowedTools Bash,Read,Write"')
  })
})

describe('a program found by its full path starts without a shell', () => {
  const env = { SystemRoot: 'C:\\Windows' }

  // What every start command's environment adds: the programs the child
  // starts by name are looked for only in PATH's folders.
  const startEnv = { ...env, NoDefaultCurrentDirectoryInExePath: '1' }

  it('an executable starts directly, its arguments as given', () => {
    expect(windowsStartCommand('C:\\Tools\\claude.exe', ['-p', 'a b'], env)).toEqual({ file: 'C:\\Tools\\claude.exe', args: ['-p', 'a b'], windowsVerbatimArguments: false, env: startEnv })
    expect(windowsStartCommand('\\\\srv\\share\\gh.exe', ['auth'], env)).toEqual({ file: '\\\\srv\\share\\gh.exe', args: ['auth'], windowsVerbatimArguments: false, env: startEnv })
  })

  it('a batch file starts through the system cmd.exe', () => {
    expect(windowsStartCommand('C:\\npm\\claude.cmd', ['-p'], env)).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/v:off', '/s', '/c', '""C:\\npm\\claude.cmd" -p"'], windowsVerbatimArguments: true, env: startEnv,
    })
  })

  it('the start command carries its environment, in which the child finds programs only in PATH\'s folders; the env passed in is left as it was', () => {
    for (const program of ['C:\\Tools\\claude.exe', 'C:\\npm\\claude.cmd']) {
      const given = { SystemRoot: 'C:\\Windows', Path: 'C:\\Tools', nodefaultcurrentdirectoryinexepath: '' }
      const before = { ...given }
      const how = windowsStartCommand(program, ['-p'], given)
      expect(how, program).toHaveProperty('env', { SystemRoot: 'C:\\Windows', Path: 'C:\\Tools', NoDefaultCurrentDirectoryInExePath: '1' })
      expect(given, program).toEqual(before)
    }
  })

  it('the child finds the programs it starts by name only in the folders PATH names in full, as a Claude session does: a relative, rooted or drive-relative entry is dropped', () => {
    for (const program of ['C:\\Tools\\claude.exe', 'C:\\npm\\claude.cmd']) {
      const given = { SystemRoot: 'C:\\Windows', Path: 'C:\\npm;.;tools;.\\bin;C:rel;\\rooted;"E:\\Node Dir"', PATH: 'node_modules\\.bin' }
      const before = { ...given }
      const how = windowsStartCommand(program, ['-p'], given)
      expect(how, program).toHaveProperty('env', { SystemRoot: 'C:\\Windows', Path: 'C:\\npm;E:\\Node Dir', NoDefaultCurrentDirectoryInExePath: '1' })
      expect(how, program).toHaveProperty('env', withFullyQualifiedProgramLookup(given))
      expect(given, program).toEqual(before)
    }
  })

  it('a bare or relative name, a script or a refused batch file is refused', () => {
    for (const p of ['claude', 'claude.exe', '.\\claude.exe', 'bin\\claude.exe', 'C:\\x\\claude.ps1', 'C:\\x\\claude', 'C:\\a%b\\claude.cmd']) {
      expect(windowsStartCommand(p, [], env), p).toHaveProperty('refused')
    }
  })

  it('the child looks for programs it starts by name only in PATH\'s folders', () => {
    expect(withoutCurrentFolderLookup({ A: '1' })).toEqual({ A: '1', NoDefaultCurrentDirectoryInExePath: '1' })
  })

  it('the setting is one spelling: an inherited one in another case is replaced, and the env passed in is left as it was', () => {
    for (const inherited of ['NODEFAULTCURRENTDIRECTORYINEXEPATH', 'nodefaultcurrentdirectoryinexepath', 'NoDefaultCurrentDirectoryInExePath']) {
      const given = { A: '1', [inherited]: '' }
      expect(withoutCurrentFolderLookup(given), inherited).toEqual({ A: '1', NoDefaultCurrentDirectoryInExePath: '1' })
      expect(given, inherited).toEqual({ A: '1', [inherited]: '' })
    }
  })
})

describe('a child that starts Claude Code finds programs only in fully qualified PATH folders', () => {
  const MIXED = ['.', 'tools', '.\\bin', 'C:rel', '\\rooted', '', '%LOCALAPPDATA%\\bin', '\\\\?\\C:\\dev', '\\\\server',
    'C:\\Tools', ' D:\\Padded ', '"E:\\Quoted Dir"', '\\\\server\\share\\bin', '//srv/share/git'].join(';')

  it('every spelling of PATH keeps only its fully qualified folders; one left with none is dropped; the setting is on in one spelling', () => {
    const given = { Path: MIXED, PATH: 'relative', A: '1', nodefaultcurrentdirectoryinexepath: '0' }
    expect(withFullyQualifiedProgramLookup(given)).toEqual({
      Path: 'C:\\Tools;D:\\Padded;E:\\Quoted Dir;\\\\server\\share\\bin;//srv/share/git', A: '1', NoDefaultCurrentDirectoryInExePath: '1',
    })
    expect(given.PATH).toBe('relative')
  })

  it('entry by entry: kept, trimmed and unquoted, exactly when the shared folder rule takes it', () => {
    for (const entry of MIXED.split(';')) {
      let dir = entry.trim()
      if (dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1).trim()
      expect(withFullyQualifiedProgramLookup({ Path: entry }).Path, JSON.stringify(entry)).toBe(windowsPathFolderIsFullyQualified(dir) ? dir : undefined)
    }
  })
})

// -- 2.1.1-beta.3 (F26): a program only the user's PowerShell profile puts on PATH --

type FakeChild = EventEmitter & {
  stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> }
  pid: number
  exitCode: number | null
  signalCode: string | null
  kill: ReturnType<typeof vi.fn>
}

/** A PowerShell that answers only when the test says so. */
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() })
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  child.kill = vi.fn()
  return child
}

/** PowerShell prints `text` and exits. */
function finishWith(child: FakeChild, ...chunks: string[]): void {
  for (const c of chunks) child.stdout.emit('data', Buffer.from(c, 'utf8'))
  child.exitCode = 0
  child.emit('exit', 0)
  child.emit('close', 0)
}

const BEGIN = '__CCC_PROGRAM_BEGIN__'
const END = '__CCC_PROGRAM_END__'
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
/** What the fixed command prints for `answer`, after a profile's own output. */
const printed = (answer: string): string => `Loading personal and system profiles took 912ms.\r\n${BEGIN}${b64(answer)}${END}`

/** The PATH filter the fixed command applies after the profile, before Get-Command. */
const PATH_FILTER = "$env:PATH = (@($env:PATH -split ';') | Where-Object { $_.Trim() -match '^\\x22?[A-Za-z]:[\\\\/]' -and $_ -notmatch '%' }) -join ';'"

/** The fixed command, exactly: nothing in it comes from outside the app. */
const EXPECTED_COMMAND = "$ErrorActionPreference = 'SilentlyContinue'; "
  + `${PATH_FILTER}; `
  + "$found = ''; "
  + "foreach ($name in @('claude.exe','claude.cmd','claude.bat')) { $c = Get-Command -Name $name -CommandType Application | Select-Object -First 1; if ($c) { $found = [string]$c.Source; break } }; "
  + "[Console]::Out.Write('__CCC_PROGRAM_BEGIN__' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($found)) + '__CCC_PROGRAM_END__')"

describe('a program only the PowerShell profile puts on PATH (findWithPowerShellProfile)', () => {
  const NAMES = ['claude.exe', 'claude.cmd', 'claude.bat']
  const HOME = 'C:\\Users\\me'
  const ENV = { SystemRoot: 'C:\\Windows', PATH: '.;rel\\bin;C:\\Tools;%APPDATA%\\npm', USERPROFILE: HOME }
  const FNM = 'C:\\Users\\me\\AppData\\Local\\fnm_multishells\\1234_1700000000\\claude.cmd'
  const FOUND = { outcome: 'found', path: FNM }
  const NONE = { outcome: 'none' }
  const FAILED = { outcome: 'failed' }
  const isFile = async (): Promise<boolean> => true
  const child = (i = 0): FakeChild => cp.spawn[i].child as FakeChild

  beforeEach(() => {
    cp.spawn.length = 0
    cp.execFile.length = 0
    cp.spawnThrows = null
  })
  afterEach(() => { vi.useRealTimers() })

  // Mutation to prove this can fail: add '-NoProfile' to the arguments, or
  // start 'powershell.exe' by name.
  it('asks the system Windows PowerShell WITH the profile, with the fixed command, in the home folder, and no shell', async () => {
    const asked = findWithPowerShellProfile(NAMES, { env: ENV, cwd: HOME, stat: isFile })
    expect(cp.spawn).toHaveLength(1)
    const s = cp.spawn[0]
    expect(s.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(s.args).toEqual(['-NoLogo', '-NonInteractive', '-Command', EXPECTED_COMMAND])
    expect(s.args).not.toContain('-NoProfile')
    expect(s.opts).toMatchObject({ cwd: HOME, windowsHide: true, windowsVerbatimArguments: false })
    expect(s.opts).not.toHaveProperty('shell')
    expect((s.opts.stdio as unknown[])[0]).toBe('ignore')
    // PATH kept to its fully qualified folders; no program from the working folder.
    expect(s.opts.env).toMatchObject({ PATH: 'C:\\Tools', NoDefaultCurrentDirectoryInExePath: '1' })
    finishWith(child(), printed(FNM))
    expect(await asked).toEqual(FOUND)
  })

  it('the command is fixed: only a plain program file name is ever put in it', async () => {
    expect(powerShellProfileLookupCommand(NAMES)).toBe(EXPECTED_COMMAND)
    for (const bad of ["claude'.exe", 'claude.ps1', 'claude', '', '.exe', 'a b.exe', 'claude.exe;calc.exe', '$(calc).exe', '..\\claude.exe', 'C:\\claude.exe', 'claude.exe\n']) {
      expect(() => powerShellProfileLookupCommand([bad]), JSON.stringify(bad)).toThrow(/plain program file name/)
    }
    expect(() => powerShellProfileLookupCommand([])).toThrow(/no program names/)
    await expect(findWithPowerShellProfile(["claude'.exe"], { env: ENV, cwd: HOME })).rejects.toThrow(/plain program file name/)
    expect(cp.spawn).toEqual([])
  })

  // Profile-added relative PATH entries. Mutation to
  // prove this can fail: drop the PATH filter from the command, or put it
  // after the Get-Command loop.
  it('after the profile, Get-Command searches only the PATH folders named from a drive letter: never a relative entry the profile added', () => {
    const command = powerShellProfileLookupCommand(NAMES)
    const filterAt = command.indexOf(PATH_FILTER)
    expect(filterAt).toBeGreaterThan(0)
    expect(filterAt).toBeLessThan(command.indexOf('Get-Command'))
    // No double quote: Windows PowerShell's command line cannot split the command.
    expect(command).not.toContain('"')
    // The filter's pattern, read the way .NET reads it (the same syntax in a
    // JavaScript regular expression for these constructs; -match ignores case).
    const pattern = /-match '([^']+)'/.exec(PATH_FILTER)![1]
    const kept = (entry: string): boolean => new RegExp(pattern, 'i').test(entry.trim()) && !entry.includes('%')
    for (const entry of ['C:\\Tools', 'd:/node', '"C:\\Program Files\\nodejs"', ' C:\\Users\\me\\AppData\\Local\\fnm_multishells\\1_2 ']) {
      expect(kept(entry), entry).toBe(true)
    }
    for (const entry of ['.', '..', 'bin', '.\\node_modules\\.bin', 'node_modules\\.bin', 'C:rel', '\\Tools', '\\\\server\\share\\bin', '//server/share', '%APPDATA%\\npm', 'C:\\%X%\\bin', '']) {
      expect(kept(entry), entry).toBe(false)
    }
  })

  // Mutation to prove this can fail: accept a share (drop the drive-letter
  // rule), or drop the working-folder comparison.
  it('takes one plain drive-absolute path to an allowed file name, never a share, a relative name or the folder it ran in', () => {
    const take = (answer: string): string | null => powerShellProfileAnswer(printed(answer), NAMES, HOME)
    expect(take(FNM)).toBe(FNM)
    expect(take('D:/tools/node/claude.exe')).toBe('D:\\tools\\node\\claude.exe')
    expect(take('C:\\Users\\Jos\u00e9\\AppData\\Roaming\\npm\\claude.cmd')).toBe('C:\\Users\\Jos\u00e9\\AppData\\Roaming\\npm\\claude.cmd')
    expect(take('C:\\Tools\\CLAUDE.BAT')).toBe('C:\\Tools\\CLAUDE.BAT')
    expect(take(`  ${FNM}  `)).toBe(FNM)
    for (const refused of [
      '', 'claude.exe', '.\\claude.exe', 'bin\\claude.exe', 'C:claude.exe', '\\claude.exe',
      '\\\\server\\share\\claude.exe', '//server/share/claude.exe', '\\\\?\\C:\\Tools\\claude.exe', '\\\\.\\C:\\Tools\\claude.exe',
      'C:\\Tools\\..\\claude.exe', 'C:\\Tools\\.\\claude.exe', 'C:\\%APPDATA%\\npm\\claude.cmd', 'C:\\Tools.\\claude.exe', 'C:\\Too"ls\\claude.exe',
      'C:\\Tools\\claude.ps1', 'C:\\Tools\\notclaude.exe', 'C:\\Tools\\claude.exe.lnk', 'C:\\Tools\\node.exe',
      'C:\\Tools\\claude.exe\r\nC:\\Other\\claude.exe', 'C:\\Tools\\claude.exe\u0000',
      'C:\\Users\\me\\claude.exe', 'c:\\USERS\\me\\Claude.exe', 'C:/Users/me/claude.cmd',
    ]) {
      expect(take(refused), JSON.stringify(refused)).toBeNull()
    }
  })

  it('reads only the text between the last opening marker and the closing one after it, as Base64 of whole UTF-8', () => {
    const answer = (out: string): string | null => powerShellProfileAnswer(out, NAMES, HOME)
    // A profile printing an earlier pair: the last one is the command's.
    expect(answer(`${BEGIN}${b64('C:\\Elsewhere\\claude.exe')}${END}\r\n${printed(FNM)}`)).toBe(FNM)
    expect(answer(`${printed(FNM)}\r\nprofile output after it`)).toBe(FNM)
    expect(answer('')).toBeNull()
    expect(answer('C:\\Tools\\claude.exe')).toBeNull()
    expect(answer(`${BEGIN}${b64(FNM)}`)).toBeNull()
    expect(answer(`${BEGIN}${FNM}${END}`)).toBeNull()
    expect(answer(`${BEGIN}${END}`)).toBeNull()
    expect(answer(`${BEGIN}${Buffer.from([0x43, 0x3a, 0x5c, 0xff, 0xfe]).toString('base64')}${END}`)).toBeNull()
  })

  // A question with no answer to go by is told
  // apart from "PowerShell named none". Mutation to prove this can fail:
  // report `none` for output with no answer in it.
  it('tells "named none" (an answer, kept) apart from "no answer to go by" (failed, asked once more later)', async () => {
    const outcome = async (...chunks: string[]): Promise<unknown> => {
      const asked = findWithPowerShellProfile(NAMES, { env: ENV, cwd: HOME, stat: isFile })
      finishWith(child(cp.spawn.length - 1), ...chunks)
      return asked
    }
    // The command ran and found none of the names: an empty answer.
    expect(await outcome(`profile banner\r\n${BEGIN}${END}`)).toEqual(NONE)
    // It named one the app does not take.
    expect(await outcome(printed('\\\\server\\share\\claude.exe'))).toEqual(NONE)
    expect(await outcome(printed('C:\\Users\\me\\claude.exe'))).toEqual(NONE)
    // It never printed its answer (the profile ended the session first, say).
    expect(await outcome('profile banner only\r\n')).toEqual(FAILED)
    expect(await outcome()).toEqual(FAILED)
    expect(await outcome(`${BEGIN}${b64(FNM)}`)).toEqual(FAILED)
  })

  it('an answer that is not a regular file is not taken; one that cannot be checked is no answer to go by', async () => {
    const notThere = findWithPowerShellProfile(NAMES, { env: ENV, cwd: HOME, stat: async () => false })
    finishWith(child(), printed(FNM))
    expect(await notThere).toEqual(NONE)
    const unreadable = findWithPowerShellProfile(NAMES, { env: ENV, cwd: HOME, stat: async () => { throw new Error('EACCES') } })
    finishWith(child(1), printed(FNM))
    expect(await unreadable).toEqual(FAILED)
  })

  it('with no plain system folder or working folder, nothing is started', async () => {
    for (const env of [{}, { SystemRoot: '\\\\server\\Windows' }, { SystemRoot: 'Windows' }]) {
      expect(await findWithPowerShellProfile(NAMES, { env, cwd: HOME, stat: isFile }), JSON.stringify(env)).toEqual(FAILED)
    }
    for (const cwd of ['\\\\server\\home\\me', 'rel', '', 'C:\\Users\\..\\me']) {
      expect(await findWithPowerShellProfile(NAMES, { env: ENV, cwd, stat: isFile }), cwd).toEqual(FAILED)
    }
    expect(cp.spawn).toEqual([])
  })

  it('a start that fails is no answer to go by', async () => {
    cp.spawnThrows = new Error('spawn EPERM')
    expect(await findWithPowerShellProfile(NAMES, { env: ENV, cwd: HOME, stat: isFile })).toEqual(FAILED)
    cp.spawnThrows = null
    const failed = findWithPowerShellProfile(NAMES, { env: ENV, cwd: HOME, stat: isFile })
    child().emit('error', new Error('spawn ENOENT'))
    expect(await failed).toEqual(FAILED)
  })

  // Mutation to prove this can fail: drop the timer, or start taskkill by name.
  it('a profile that never answers is stopped after the timeout, with what it started, by taskkill from the system folder', async () => {
    vi.useFakeTimers()
    let settled = false
    const asked = findWithPowerShellProfile(NAMES, { env: ENV, cwd: HOME, stat: isFile })
    void asked.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    expect(cp.execFile).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(await asked).toEqual(FAILED)
    expect(cp.execFile).toHaveLength(1)
    expect(cp.execFile[0].file).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(cp.execFile[0].args).toEqual(['/PID', '4242', '/T', '/F'])
    expect(cp.execFile[0].opts).not.toHaveProperty('shell')
    expect(child().stdout.destroy).toHaveBeenCalled()
    expect(child().kill).not.toHaveBeenCalled()
    cp.execFile[0].cb()
    expect(child().kill).toHaveBeenCalledTimes(1)
    // An answer after the timeout changes nothing.
    finishWith(child(), printed(FNM))
    expect(await asked).toEqual(FAILED)
  })

  // Mutation to prove this can fail: drop the
  // 'exit' handler (read only on 'close'): the question then waits out the
  // whole timeout and reports no answer.
  it('PowerShell printed its answer and exited, but something the profile started holds the output open: the answer is read shortly after the exit', async () => {
    vi.useFakeTimers()
    let settled = false
    const asked = findWithPowerShellProfile(NAMES, { env: ENV, cwd: HOME, stat: isFile })
    void asked.then(() => { settled = true })
    child().stdout.emit('data', Buffer.from(printed(FNM), 'utf8'))
    child().exitCode = 0
    child().emit('exit', 0)
    // No 'close': gpg-agent (say) still holds the pipe.
    await vi.advanceTimersByTimeAsync(POWERSHELL_PROFILE_EXIT_DRAIN_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await asked).toEqual(FOUND)
    expect(POWERSHELL_PROFILE_EXIT_DRAIN_MS).toBeLessThan(POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS / 10)
    // Nothing is killed: PowerShell has exited, its process id is Windows's to reuse.
    await vi.advanceTimersByTimeAsync(POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS)
    expect(cp.execFile).toEqual([])
    expect(child().kill).not.toHaveBeenCalled()
    expect(child().stdout.destroy).toHaveBeenCalled()
  })

  it('exited without printing an answer and the output never closes: no answer to go by, without waiting out the timeout, and nothing is killed', async () => {
    vi.useFakeTimers()
    const asked = findWithPowerShellProfile(NAMES, { env: ENV, cwd: HOME, stat: isFile })
    child().stdout.emit('data', Buffer.from('profile banner\r\n', 'utf8'))
    child().exitCode = 0
    child().emit('exit', 0)
    await vi.advanceTimersByTimeAsync(POWERSHELL_PROFILE_EXIT_DRAIN_MS)
    expect(await asked).toEqual(FAILED)
    await vi.advanceTimersByTimeAsync(POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS)
    expect(cp.execFile).toEqual([])
    expect(child().kill).not.toHaveBeenCalled()
  })

  it('after the timeout nothing is killed once PowerShell has exited (its process id is Windows\'s to reuse)', async () => {
    vi.useFakeTimers()
    const asked = findWithPowerShellProfile(NAMES, { env: ENV, cwd: HOME, stat: isFile, timeoutMs: POWERSHELL_PROFILE_EXIT_DRAIN_MS - 100 })
    // Exited just before the timeout, with what it started holding the output open.
    child().exitCode = 0
    child().emit('exit', 0)
    await vi.advanceTimersByTimeAsync(POWERSHELL_PROFILE_EXIT_DRAIN_MS)
    expect(await asked).toEqual(FAILED)
    expect(cp.execFile).toEqual([])
    expect(child().kill).not.toHaveBeenCalled()
    expect(child().stdout.destroy).toHaveBeenCalled()
  })

  it('keeps the end of a long output, where the answer is', async () => {
    const asked = findWithPowerShellProfile(NAMES, { env: ENV, cwd: HOME, stat: isFile })
    const noise = 'x'.repeat(64 * 1024)
    finishWith(child(), noise, noise, noise, noise, noise, printed(FNM))
    expect(await asked).toEqual(FOUND)
  })
})
