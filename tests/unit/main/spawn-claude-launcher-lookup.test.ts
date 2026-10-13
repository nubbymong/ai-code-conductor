// A Windows line that starts Claude Code itself through a launcher (npm's
// claude.cmd, a claude.bat, a claude.ps1) sets the session's program lookup
// again just before it (2.1.1-beta.3). The user's PowerShell profile runs
// after the app kept PATH to its fully qualified folders, and npm's launcher
// starts `node` through cmd.exe. So on
// every route that starts Claude Code itself the line keeps PATH to its
// fully qualified folders again and sets NoDefaultCurrentDirectoryInExePath,
// as statements before the launcher (LAUNCHER_PROGRAM_LOOKUP):
//  - their text is pinned, and the folder rule in it is the app's own
//    (windowsPathFolderIsFullyQualified), applied as the app applies it
//    (withFullyQualifiedProgramLookup);
//  - they stand right before `& '<launcher>'` on each such route, and on no
//    line that starts an `.exe` or the resume list;
//  - they are not counted in the agent templates' length budget, and cmd.exe
//    still reads every argument as text.
// The node.exe lookup is mocked: no PATH is walked and no process starts.
// The same lines in real shells, with a launcher shaped like npm's:
// spawn-claude-launcher-lookup-powershell.test.ts (quarantined to CI and the
// test VM).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  const found = (): string | null => ((globalThis as any).__lookupNodeExe as string | undefined) ?? null
  return {
    ...actual,
    findOnWindowsPath: vi.fn(() => found()),
    findOnWindowsPathAsync: vi.fn(async () => found()),
  }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const mod = await import('../../../src/main/spawn-claude-command')
const { buildClaudeLaunchCommand, LAUNCHER_PROGRAM_LOOKUP, FULLY_QUALIFIED_FOLDER_PATTERN, AGENTS_LAUNCHER_ROOM, _resetPickerNodeFoundForTest } = mod
const { withFullyQualifiedProgramLookup } = await import('../../../src/main/windows-programs')
const { windowsPathFolderIsFullyQualified } = await import('../../../src/main/providers/windows-path-names')
const { CMD_EXE_LINE_LIMIT, agentsRef } = await import('../../../src/main/terminal-launch-line')

const PICKER = 'C:\\ccc\\scripts\\resume-picker.js'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const EXE = 'C:\\Users\\u\\.local\\bin\\claude.exe'
const CMD = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'
const BAT = 'C:\\tools\\claude.bat'
const PS1 = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.ps1'
const UUID = '0b7d2f3e-1c4a-4e8b-9f6d-2a5c8e1b3d7f'
const LEAD = "$PSNativeCommandArgumentPassing = 'Legacy'; "

type Opts = Parameters<typeof buildClaudeLaunchCommand>[0]
/** Every Windows route that starts Claude Code itself, and what follows its path. */
const DIRECT: Array<{ name: string; opts: Partial<Opts>; node: string | null; after: string }> = [
  { name: 'a fresh session without the resume list', opts: { useResumePicker: false, pickerScript: null }, node: NODE, after: ' --model opus' },
  { name: 'Ask Conductor', opts: { useResumePicker: false, pickerScript: null, askPrompt: true }, node: NODE, after: ' --model opus -- $env:CCC_ASK_PROMPT' },
  { name: 'an exact resume', opts: { useResumePicker: true, pickerScript: PICKER, resumeUuid: UUID }, node: NODE, after: ` --resume ${UUID} --model opus` },
  { name: 'the resume list with no node.exe found', opts: { useResumePicker: true, pickerScript: PICKER }, node: null, after: ' --model opus' },
  { name: 'the resume list with node.exe under a bracketed folder', opts: { useResumePicker: true, pickerScript: PICKER }, node: 'C:\\nvm\\v[1]\\node.exe', after: ' --model opus' },
  { name: 'the resume list not deployed', opts: { useResumePicker: true, pickerScript: null }, node: NODE, after: ' --model opus' },
]

function build(node: string | null, opts: Partial<Opts>): string {
  if (node === null) delete (globalThis as any).__lookupNodeExe
  else (globalThis as any).__lookupNodeExe = node
  _resetPickerNodeFoundForTest()
  return buildClaudeLaunchCommand({ platform: 'win32', cwd: 'C:\\work', claudeBin: CMD, extraFlags: ' --model opus', agentsFlag: '', useResumePicker: false, pickerScript: null, ...opts })
}

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }) })
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  delete (globalThis as any).__lookupNodeExe
  _resetPickerNodeFoundForTest()
})

describe('the statements, as written', () => {
  // Mutation to prove this can fail: change any character of them (drop the setting, the trim, the quote step, or the rule).
  it('their text is pinned', () => {
    expect(LAUNCHER_PROGRAM_LOOKUP).toBe(
      "$env:Path = @($env:Path -split ';' -replace '^\\s+|\\s+$' -replace '^\"(.*)\"$', '$1' -replace '^\\s+|\\s+$'"
      + " -match '^(?:[A-Za-z]:[\\\\/]|[\\\\/]{2}[^\\\\/?.][^\\\\/]*[\\\\/][^\\\\/]+)') -join ';';"
      + " $env:NoDefaultCurrentDirectoryInExePath = '1'; ")
  })

  it('they name no command and no variable of their own, so nothing a profile defines stands in for a step', () => {
    // Outside single quotes: only $env: names, operators, and punctuation.
    const outside = LAUNCHER_PROGRAM_LOOKUP.replace(/'[^']*'/g, "''")
    expect(outside).toBe("$env:Path = @($env:Path -split '' -replace '' -replace '', '' -replace '' -match '') -join ''; $env:NoDefaultCurrentDirectoryInExePath = ''; ")
  })

  // Mutation to prove this can fail: drop the share alternative from FULLY_QUALIFIED_FOLDER_PATTERN.
  it('the folder rule in them is the app\'s own (windowsPathFolderIsFullyQualified)', () => {
    const re = new RegExp(FULLY_QUALIFIED_FOLDER_PATTERN)
    const SAMPLES = ['C:\\Windows', 'c:/tools', 'C:\\', 'C:', 'C:foo', '\\foo', '/foo', '.', '..', '.\\bin', 'node_modules\\.bin', 'bin2',
      '\\\\server\\share', '\\\\server\\share\\bin', '//server/share', '\\/server/share', '\\\\server', '\\\\server\\', '\\\\?\\C:\\x', '\\\\.\\pipe\\x',
      '\\\\.server\\share', '%SystemRoot%\\x', 'C:\\%X%', '', ' C:\\x', '"C:\\x"', 'D:\\a[1]\\b', 'é:\\x', '1:\\x']
    for (const s of SAMPLES) expect(re.test(s), JSON.stringify(s)).toBe(windowsPathFolderIsFullyQualified(s))
    expect(LAUNCHER_PROGRAM_LOOKUP).toContain(`-match '${FULLY_QUALIFIED_FOLDER_PATTERN}'`)
    expect(FULLY_QUALIFIED_FOLDER_PATTERN).not.toContain("'")
  })

  /** What the statements leave in PATH, read from their own text: each
   *  `-replace` and the `-match` applied in order to every entry, as
   *  PowerShell applies an operator to each element of an array (.NET and
   *  JavaScript read these patterns alike), then joined. */
  function pathAfter(value: string): string | undefined {
    const ops = [...LAUNCHER_PROGRAM_LOOKUP.matchAll(/-(replace|match) '([^']*)'(?:, '([^']*)')?/g)]
    expect(ops.map((m) => m[1])).toEqual(['replace', 'replace', 'replace', 'match'])
    // Case-insensitive, every match replaced, and `$1` a group reference: as
    // PowerShell's -replace and -match read them.
    let entries = value.split(';')
    for (const [, op, pattern, by] of ops) {
      entries = op === 'match' ? entries.filter((e) => new RegExp(pattern, 'i').test(e)) : entries.map((e) => e.replace(new RegExp(pattern, 'gi'), by ?? ''))
    }
    const joined = entries.join(';')
    return joined === '' ? undefined : joined
  }

  // Mutation to prove this can fail: drop the quote step or a trim from the statements.
  it('they keep PATH as the app does when a Claude session starts (withFullyQualifiedProgramLookup)', () => {
    const PATHS = [
      'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      'node_modules\\.bin;C:\\Windows\\System32;C:\\nodejs',
      '.;C:\\nodejs',
      'C:\\nodejs;bin2',
      ' ".\\node_modules\\.bin" ;C:\\nodejs',
      ' "C:\\Program Files\\nodejs" ;C:\\Windows',
      '\\\\srv\\share\\bin;\\\\srv;C:\\x;;',
      'C:\\nodejs',
      '.;node_modules\\.bin',
      '',
      '"";" ";C:\\a',
    ]
    for (const p of PATHS) expect(pathAfter(p), JSON.stringify(p)).toBe(withFullyQualifiedProgramLookup({ Path: p }).Path)
  })
})

describe('Windows: right before a launcher on every route that starts Claude Code itself', () => {
  // Mutation to prove this can fail: build these lines without the statements.
  for (const route of DIRECT) {
    for (const agentsFromEnv of [false, true]) {
      it(`${route.name}${agentsFromEnv ? ', templates in the environment' : ''}`, () => {
        for (const claudeBin of [CMD, BAT, PS1, 'C:\\npm\\CLAUDE.CMD']) {
          const extra = agentsFromEnv ? { agentsFromEnv: true, agentsValueLength: 10 } : {}
          const line = build(route.node, { ...route.opts, claudeBin, ...extra })
          const agents = agentsFromEnv ? ' --agents ${env:CCC_AGENTS}' : ''
          const after = route.after.replace(' --model opus', `${agents} --model opus`)
          expect(line, claudeBin).toBe(`${agentsFromEnv ? LEAD : ''}Set-Location -LiteralPath 'C:\\work'; ${LAUNCHER_PROGRAM_LOOKUP}& '${claudeBin}'${after}; exit`)
        }
      })
    }
  }

  it('a line that starts claude.exe is as before', () => {
    for (const route of DIRECT) {
      const line = build(route.node, { ...route.opts, claudeBin: EXE })
      expect(line, route.name).toBe(`Set-Location -LiteralPath 'C:\\work'; & '${EXE}'${route.after}; exit`)
      expect(line).not.toContain('NoDefaultCurrentDirectoryInExePath')
    }
  })

  it('a line that starts the resume list does not carry them: the picker keeps its own children to the same rule', () => {
    const line = build(NODE, { useResumePicker: true, pickerScript: PICKER })
    expect(line).toBe(`Set-Location -LiteralPath 'C:\\work'; $env:CCC_CLAUDE_BIN = '${CMD}'; & '${NODE}' '${PICKER}' --model opus; exit`)
  })

  it('macOS and Linux lines are unchanged', () => {
    const line = buildClaudeLaunchCommand({ platform: 'posix', cwd: '/w', claudeBin: '/opt/claude.cmd', extraFlags: '', agentsFlag: '', useResumePicker: false, pickerScript: null })
    expect(line).toBe("cd '/w' && '/opt/claude.cmd'; exit")
  })
})

describe('Windows: the agent templates\' budget and cmd.exe\'s reading of the arguments are unchanged', () => {
  // Mutation to prove this can fail: count the statements in the length (pass them as part of `measured`).
  it('the longest templates value a launcher line takes is the one its program and arguments leave room for', () => {
    for (const route of DIRECT) {
      const run = `& '${CMD}'${route.after.replace(' --model opus', ` --agents ${agentsRef()} --model opus`)}`
      const most = CMD_EXE_LINE_LIMIT - AGENTS_LAUNCHER_ROOM - CMD.length - (run.length - agentsRef().length)
      expect(() => build(route.node, { ...route.opts, agentsFromEnv: true, agentsValueLength: most }), route.name).not.toThrow()
      expect(() => build(route.node, { ...route.opts, agentsFromEnv: true, agentsValueLength: most + 1 }), route.name).toThrow(/Windows allows 8191 there/)
    }
  })

  it('an argument cmd.exe would read as more than text is still refused on a launcher line', () => {
    for (const route of DIRECT) {
      expect(() => build(route.node, { ...route.opts, extraFlags: " --settings 'C:\\100%\\s.json'" }), route.name).toThrow(/holds a character cmd\.exe would read as more than text/)
    }
  })
})
