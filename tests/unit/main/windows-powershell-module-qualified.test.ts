// The Windows PowerShell lines and scripts the app runs name every cmdlet
// with its module, so Windows PowerShell 5.1 loads that one module by name
// and never looks through every module on its module path for the command.
// That look, with no module analysis cache yet (a new user profile, the
// GitHub Windows runner), took 21.6 to 27.4 s in Snap e2e run 46040073797,
// and both the owner-only calls at start and a Claude Code tab's launch line
// waited for it (Snap e2e D1, CONTEXT.d/2026-11-27-b20-snap-d1.md).
//   - The Claude Code launch line, on every Windows route: each statement is
//     an assignment, a call by `&`, `exit`, or a cmdlet named Module\Verb-Noun,
//     and the folder change is Microsoft.PowerShell.Management\Set-Location
//     -LiteralPath. A terminal tab's line (pty-manager.ts) changes folder by
//     the same PS_SET_LOCATION.
//   - Every other script the app runs in Windows PowerShell: the owner-only
//     script (OWNER_ONLY_SCRIPT), the Claude CLI profile lookup (which also
//     loads a module only for a command named with its module, before its
//     first cmdlet: Get-Command makes the same look for a name it does not
//     find), the Codex process table query, the vision browser's three
//     scripts, the registry PATH script and the Windows SSH host's setup
//     lines: every Verb-Noun command outside quoted text, in any case, is
//     named with the module that cmdlet lives in.
//   - The two owner-only fallback scripts (Constrained Language Mode) name
//     their cmdlets bare, and import every module those cmdlets live in by
//     name first, so no bare name makes the look either.
// Mutations to prove each can fail: name Set-Location bare in windowsLine
// (spawn-claude-command.ts) or in pty-manager's cd line; drop the module from
// any one cmdlet in any script above, or write one bare in lower case
// (`new-object`); name one with another module; drop the profile lookup's
// ModuleQualified line or move it after its first cmdlet; drop a module from
// a fallback script's Import-Module line.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  const found = (): string | null => ((globalThis as any).__mqNodeExe as string | undefined) ?? null
  return { ...actual, findOnWindowsPath: vi.fn(() => found()), findOnWindowsPathAsync: vi.fn(async () => found()) }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 19333,
  mcpSessionToken: () => 'tok',
  issueMcpSessionToken: () => 'tok',
}))

const { buildClaudeLaunchCommand, _resetPickerNodeFoundForTest } = await import('../../../src/main/spawn-claude-command')
const { PS_SET_LOCATION } = await import('../../../src/main/terminal-launch-line')
const { OWNER_ONLY_SCRIPT, OWNER_ONLY_READ_SCRIPT, OWNER_ONLY_INSIDE_SCRIPT } = await import('../../../src/main/owner-only-folders')
const { powerShellProfileLookupCommand } = await import('../../../src/main/windows-programs')
const { WINDOWS_PROCESS_QUERY } = await import('../../../src/main/providers/codex/cli-runner')
const { WINDOWS_BROWSERS_SCRIPT, windowsFactsOfPidScript, windowsEndScript } = await import('../../../src/main/vision-browser-owner')
const { REGISTRY_PATH_SCRIPT } = await import('../../../src/main/windows-registry-path')
const { getWindowsRemoteSetupCommand } = await import('../../../src/main/providers/claude/ssh-shim')

const PICKER = 'C:\\ccc\\scripts\\resume-picker.js'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const EXE = 'C:\\Users\\u\\.local\\bin\\claude.exe'
const CMD = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'
const UUID = '0b7d2f3e-1c4a-4e8b-9f6d-2a5c8e1b3d7f'
const FOLDERS = ['C:\\work', 'C:\\work\\proj[1]', "F:\\o'brien [x]\\app", 'C:\\back`tick\\p']

type Opts = Parameters<typeof buildClaudeLaunchCommand>[0]
const ROUTES: Array<{ name: string; opts: Partial<Opts>; node: string | null }> = [
  { name: 'a fresh session', opts: { useResumePicker: false, pickerScript: null }, node: NODE },
  { name: 'Ask Conductor', opts: { useResumePicker: false, pickerScript: null, askPrompt: true }, node: NODE },
  { name: 'an exact resume', opts: { useResumePicker: true, pickerScript: PICKER, resumeUuid: UUID }, node: NODE },
  { name: 'the resume list', opts: { useResumePicker: true, pickerScript: PICKER }, node: NODE },
  { name: 'the resume list with no node.exe found', opts: { useResumePicker: true, pickerScript: PICKER }, node: null },
]

function build(route: (typeof ROUTES)[number], extra: Partial<Opts>): string {
  if (route.node === null) delete (globalThis as any).__mqNodeExe
  else (globalThis as any).__mqNodeExe = route.node
  _resetPickerNodeFoundForTest()
  return buildClaudeLaunchCommand({ platform: 'win32', cwd: 'C:\\work', claudeBin: CMD, extraFlags: ' --model opus', agentsFlag: '', useResumePicker: false, pickerScript: null, ...route.opts, ...extra })
}

/** A PowerShell line's statements: split at each `;` outside single quotes
 *  (a quote inside them is written twice, which toggles twice). */
function statements(line: string): string[] {
  const out: string[] = []
  let quoted = false
  let cur = ''
  for (const ch of line) {
    if (ch === "'") quoted = !quoted
    if (ch === ';' && !quoted) { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  expect(quoted, `an unterminated quote in ${line}`).toBe(false)
  out.push(cur.trim())
  return out.filter(Boolean)
}
/** The text with every single-quoted string taken out. */
const unquoted = (text: string): string => text.replace(/'(?:[^']|'')*'/g, "''")
/** A command's shape, Verb-Noun, in any case (PowerShell reads command names
 *  in any case: `new-object` runs New-Object), not after a module and a
 *  backslash. Letters come before the dash, so an operator (-split,
 *  -replace, -match) or a parameter (-LiteralPath) is never one. */
const BARE_CMDLET = /(?<![\\\w.$-])[A-Za-z]+-[A-Za-z]+\b/g
/** A command named with its module: Module\Verb-Noun. */
const QUALIFIED = /(?<![\w.])([A-Za-z][\w.]*)\\([A-Za-z]+-[A-Za-z]+)\b/g

/** Which module each cmdlet the app's scripts run lives in (Windows
 *  PowerShell 5.1; Microsoft.PowerShell.Core is the snap-in that is always
 *  loaded, named the same way). */
const MODULE_OF: Record<string, string> = {
  'New-Object': 'Microsoft.PowerShell.Utility',
  'ConvertTo-Json': 'Microsoft.PowerShell.Utility',
  'Select-Object': 'Microsoft.PowerShell.Utility',
  'Add-Type': 'Microsoft.PowerShell.Utility',
  'Set-Location': 'Microsoft.PowerShell.Management',
  'Join-Path': 'Microsoft.PowerShell.Management',
  'New-Item': 'Microsoft.PowerShell.Management',
  'Add-Content': 'Microsoft.PowerShell.Management',
  'Get-Content': 'Microsoft.PowerShell.Management',
  'Remove-Item': 'Microsoft.PowerShell.Management',
  'Test-Path': 'Microsoft.PowerShell.Management',
  'Get-Item': 'Microsoft.PowerShell.Management',
  'Get-ChildItem': 'Microsoft.PowerShell.Management',
  'Get-Acl': 'Microsoft.PowerShell.Security',
  'Get-CimInstance': 'CimCmdlets',
  'Where-Object': 'Microsoft.PowerShell.Core',
  'ForEach-Object': 'Microsoft.PowerShell.Core',
  'Get-Command': 'Microsoft.PowerShell.Core',
  'Out-Null': 'Microsoft.PowerShell.Core',
  'Import-Module': 'Microsoft.PowerShell.Core',
}

/** Every Verb-Noun command named with its module in `text`, outside quotes. */
const namedWithModule = (text: string): Array<readonly [string, string]> =>
  [...unquoted(text).matchAll(QUALIFIED)].map((m) => [m[1], m[2]] as const)

/** No command is named bare, and each one is named with the module it lives
 *  in, spelled as that cmdlet is. Answers the cmdlets it names. */
function expectEveryCmdletQualified(label: string, text: string): string[] {
  expect(unquoted(text).match(BARE_CMDLET) ?? [], `${label}: a cmdlet named bare\n${text}`).toEqual([])
  const named = namedWithModule(text)
  expect(named.length, `${label}: names no cmdlet`).toBeGreaterThan(0)
  for (const [module, cmdlet] of named) {
    expect(Object.keys(MODULE_OF), `${label}: ${cmdlet} is not spelled as a cmdlet the app runs`).toContain(cmdlet)
    expect(module, `${label}: ${cmdlet}`).toBe(MODULE_OF[cmdlet])
  }
  return named.map(([, c]) => c)
}

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }) })
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  delete (globalThis as any).__mqNodeExe
  _resetPickerNodeFoundForTest()
})

describe('the Claude Code launch line names every cmdlet with its module', () => {
  it('the folder change is Set-Location named with its module', () => {
    expect(PS_SET_LOCATION).toBe('Microsoft.PowerShell.Management\\Set-Location')
  })

  for (const route of ROUTES) {
    for (const agentsFromEnv of [false, true]) {
      for (const claudeBin of [EXE, CMD]) {
        it(`${route.name}, ${claudeBin === EXE ? 'claude.exe' : 'npm\'s launcher'}${agentsFromEnv ? ', templates in the environment' : ''}`, () => {
          for (const cwd of FOLDERS) {
            const line = build(route, { cwd, claudeBin, ...(agentsFromEnv ? { agentsFromEnv: true, agentsValueLength: 10 } : {}) })
            const kinds = statements(line).map((s) => {
              if (s.startsWith('$')) return 'assignment'
              if (s.startsWith('& ')) return 'call'
              if (s === 'exit') return 'exit'
              const word = s.split(/\s+/)[0]
              expect(word, `${s}\n  in ${line}`).toMatch(/^[A-Za-z][\w.]*\\[A-Za-z]+-[A-Za-z]+$/)
              return word
            })
            expect(kinds.filter((k) => k.endsWith('Set-Location')), line).toEqual(['Microsoft.PowerShell.Management\\Set-Location'])
            expect(line, line).toContain(`Microsoft.PowerShell.Management\\Set-Location -LiteralPath '`)
            expect(unquoted(line).match(BARE_CMDLET) ?? [], line).toEqual([])
            expect(kinds[kinds.length - 1], line).toBe('exit')
          }
        })
      }
    }
  }
})

describe("a terminal tab's line changes folder by the same module-qualified Set-Location", () => {
  // pty-manager cannot be imported in a unit test (node-pty + Electron): its
  // source is read, every comment taken out.
  const code = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main', 'pty-manager.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n')

  it('the cd line is PS_SET_LOCATION -LiteralPath, and the code names Set-Location nowhere else', () => {
    expect(code).toMatch(/\$\{PS_SET_LOCATION\} -LiteralPath \$\{quoteArgForShell\(resolvedCwd, true\)\}/)
    expect(code.match(/Set-Location/gi) ?? []).toEqual([])
  })
})

describe('every other script the app runs in Windows PowerShell names every cmdlet with its module', () => {
  const SCRIPTS: Array<[string, () => string]> = [
    ['the owner-only script', () => OWNER_ONLY_SCRIPT],
    ['the Claude CLI profile lookup', () => powerShellProfileLookupCommand(['claude.exe', 'claude.cmd', 'claude.bat'])],
    ['the Codex process table query', () => WINDOWS_PROCESS_QUERY],
    ["the vision browser's process list", () => WINDOWS_BROWSERS_SCRIPT],
    ["the vision browser's facts of one process", () => windowsFactsOfPidScript(4242)],
    ["the vision browser's end", () => windowsEndScript(4242, '134079480000000000')],
    ['the registry PATH script', () => REGISTRY_PATH_SCRIPT],
    ["the Windows SSH host's setup lines", () => getWindowsRemoteSetupCommand('winsid', { includeStatusLine: true, includeConductorMcp: true }, 'winnonce123')],
  ]
  for (const [label, script] of SCRIPTS) {
    it(label, () => { expectEveryCmdletQualified(label, script()) })
  }

  it('the owner-only script still runs New-Object and ConvertTo-Json, and writes its answer compressed, ten deep', () => {
    expect(new Set(expectEveryCmdletQualified('owner-only', OWNER_ONLY_SCRIPT))).toEqual(new Set(['New-Object', 'ConvertTo-Json']))
    expect(OWNER_ONLY_SCRIPT).toContain('| Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress -Depth 10')
  })

  it('the profile lookup loads a module only for a command named with its module, before its first cmdlet', () => {
    const command = powerShellProfileLookupCommand(['claude.exe', 'claude.cmd', 'claude.bat'])
    const at = command.indexOf("$PSModuleAutoLoadingPreference = 'ModuleQualified'; ")
    expect(at).toBeGreaterThan(0)
    const firstCmdlet = unquoted(command).search(QUALIFIED)
    expect(firstCmdlet).toBeGreaterThan(unquoted(command).indexOf("$PSModuleAutoLoadingPreference = ''"))
    expect(statements(command).filter((s) => /PSModuleAutoLoadingPreference/i.test(s))).toEqual(["$PSModuleAutoLoadingPreference = 'ModuleQualified'"])
    expect(new Set(expectEveryCmdletQualified('profile lookup', command))).toEqual(new Set(['Where-Object', 'Get-Command', 'Select-Object']))
  })

  it("the Windows SSH host's setup lines still create, append, read and remove the file", () => {
    const names = expectEveryCmdletQualified('ssh', getWindowsRemoteSetupCommand('winsid', { includeStatusLine: true, includeConductorMcp: true }, 'winnonce123'))
    expect(new Set(names)).toEqual(new Set(['New-Item', 'Out-Null', 'Add-Content', 'Get-Content', 'Remove-Item']))
  })
})

describe('the owner-only fallback scripts import every module their bare cmdlets live in, by name, first', () => {
  for (const [label, script] of [['the read', OWNER_ONLY_READ_SCRIPT], ['the inside read', OWNER_ONLY_INSIDE_SCRIPT]] as const) {
    it(label, () => {
      const text = unquoted(script)
      const lines = text.split('\n')
      const importAt = lines.findIndex((l) => /^Import-Module -Name /.test(l))
      expect(importAt, label).toBeGreaterThanOrEqual(0)
      const imported = lines[importAt].replace(/^Import-Module -Name /, '').split(',').map((m) => m.trim())
      const bare = [...text.matchAll(BARE_CMDLET)].map((m) => ({ cmdlet: m[0], at: m.index ?? 0 }))
      const importOffset = lines.slice(0, importAt).join('\n').length
      expect(bare.length).toBeGreaterThan(1)
      for (const { cmdlet, at } of bare) {
        expect(Object.keys(MODULE_OF), `${label}: ${cmdlet}`).toContain(cmdlet)
        if (cmdlet === 'Import-Module') continue
        const module = MODULE_OF[cmdlet]
        // Core is always loaded; any other module is imported before the cmdlet runs.
        if (module === 'Microsoft.PowerShell.Core') continue
        expect(imported, `${label}: ${cmdlet} lives in ${module}`).toContain(module)
        expect(at, `${label}: ${cmdlet} before the Import-Module line`).toBeGreaterThan(importOffset)
      }
    })
  }
})
