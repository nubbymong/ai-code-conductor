// The Windows PowerShell lines the start depends on name every cmdlet they run
// with its module, so Windows PowerShell 5.1 loads that one module by name and
// never looks through every module on its module path for the command. That
// look, with no module analysis cache yet (a new user profile, the GitHub
// Windows runner), took 21.6 to 27.4 s in Snap e2e run 46040073797, and both
// the owner-only calls at start and a Claude Code tab's launch line waited for
// it (Snap e2e D1, CONTEXT.d/2026-11-27-b20-snap-d1.md).
//   - The Claude Code launch line, on every Windows route: each statement is
//     an assignment, a call by `&`, `exit`, or a cmdlet named Module\Verb-Noun,
//     and the folder change is Microsoft.PowerShell.Management\Set-Location
//     -LiteralPath.
//   - The owner-only script (OWNER_ONLY_SCRIPT): every Verb-Noun command in it
//     is named with the module that cmdlet lives in.
// Mutations to prove each can fail: name Set-Location bare in windowsLine
// (spawn-claude-command.ts); drop the module from any one New-Object or
// ConvertTo-Json in OWNER_ONLY_SCRIPT; name either with another module.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  const found = (): string | null => ((globalThis as any).__mqNodeExe as string | undefined) ?? null
  return { ...actual, findOnWindowsPath: vi.fn(() => found()), findOnWindowsPathAsync: vi.fn(async () => found()) }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { buildClaudeLaunchCommand, _resetPickerNodeFoundForTest } = await import('../../../src/main/spawn-claude-command')
const { PS_SET_LOCATION } = await import('../../../src/main/terminal-launch-line')
const { OWNER_ONLY_SCRIPT } = await import('../../../src/main/owner-only-folders')

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
/** The line with every single-quoted string taken out. */
const unquoted = (line: string): string => line.replace(/'(?:[^']|'')*'/g, "''")
/** A cmdlet's shape, Verb-Noun (ConvertTo-Json's verb has a capital inside
 *  it), not already after a module and a backslash. */
const BARE_CMDLET = /(?<![\\\w.-])[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\b/g

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

describe('the owner-only script names every cmdlet with its module', () => {
  /** Which module each cmdlet the script runs lives in (Windows PowerShell 5.1). */
  const MODULE_OF: Record<string, string> = { 'New-Object': 'Microsoft.PowerShell.Utility', 'ConvertTo-Json': 'Microsoft.PowerShell.Utility' }

  it('no cmdlet is named bare', () => {
    expect(unquoted(OWNER_ONLY_SCRIPT).match(BARE_CMDLET) ?? []).toEqual([])
  })

  it('each cmdlet is named with the module it lives in, and the script still runs both', () => {
    const named = [...unquoted(OWNER_ONLY_SCRIPT).matchAll(/([A-Za-z][\w.]*)\\([A-Z][A-Za-z]+-[A-Z][A-Za-z]+)\b/g)].map((m) => [m[1], m[2]] as const)
    expect(named.length).toBeGreaterThan(0)
    for (const [module, cmdlet] of named) expect(module, cmdlet).toBe(MODULE_OF[cmdlet])
    expect(new Set(named.map(([, c]) => c))).toEqual(new Set(Object.keys(MODULE_OF)))
    // The answer is still written by ConvertTo-Json, compressed, ten deep.
    expect(OWNER_ONLY_SCRIPT).toContain('| Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress -Depth 10')
  })
})
