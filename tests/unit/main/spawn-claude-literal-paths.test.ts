// A Windows Claude session's launch line names its folder and its program
// as written (2.1.1-beta.3).
//  - The session folder is given to Set-Location by -LiteralPath on every
//    route (fresh, Ask Conductor, exact resume, the resume list, and each
//    way the line falls back to starting Claude Code itself), so a name
//    holding `[ ]` is taken as written.
//  - A line that starts Claude Code itself (`& '<path>'`, which has no
//    literal form) is refused, with the reason, when Claude Code's path
//    holds `[` or `]`. A line that starts the resume list only names that
//    path in a variable (CCC_CLAUDE_BIN), and is not refused.
// The node.exe lookup is mocked: no PATH is walked and no process starts.
// The same lines in real shells: spawn-claude-launcher-lookup-powershell.test.ts
// (quarantined to CI and the test VM).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  const found = (): string | null => ((globalThis as any).__literalNodeExe as string | undefined) ?? null
  return {
    ...actual,
    findOnWindowsPath: vi.fn(() => found()),
    findOnWindowsPathAsync: vi.fn(async () => found()),
  }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const mod = await import('../../../src/main/spawn-claude-command')
const { buildClaudeLaunchCommand, CLAUDE_BIN_BRACKETS_REFUSAL, _resetPickerNodeFoundForTest } = mod
const { logInfo } = await import('../../../src/main/debug-logger')

const PICKER = 'C:\\ccc\\scripts\\resume-picker.js'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const EXE = 'C:\\Users\\u\\.local\\bin\\claude.exe'
const CMD = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'
const UUID = '0b7d2f3e-1c4a-4e8b-9f6d-2a5c8e1b3d7f'
const LEAD = "$PSNativeCommandArgumentPassing = 'Legacy'; "
const Q = String.fromCharCode(0x27, 0x2018, 0x2019, 0x201a, 0x201b)

type Opts = Parameters<typeof buildClaudeLaunchCommand>[0]
/** Every Windows route, and the node.exe the lookup answers for it. */
const ROUTES: Array<{ name: string; opts: Partial<Opts>; node: string | null; startsPicker: boolean }> = [
  { name: 'a fresh session without the resume list', opts: { useResumePicker: false, pickerScript: null }, node: NODE, startsPicker: false },
  { name: 'Ask Conductor', opts: { useResumePicker: false, pickerScript: null, askPrompt: true }, node: NODE, startsPicker: false },
  { name: 'an exact resume', opts: { useResumePicker: true, pickerScript: PICKER, resumeUuid: UUID }, node: NODE, startsPicker: false },
  { name: 'the resume list', opts: { useResumePicker: true, pickerScript: PICKER }, node: NODE, startsPicker: true },
  { name: 'the resume list with no node.exe found', opts: { useResumePicker: true, pickerScript: PICKER }, node: null, startsPicker: false },
  { name: 'the resume list with node.exe under a bracketed folder', opts: { useResumePicker: true, pickerScript: PICKER }, node: 'C:\\nvm\\v[1]\\node.exe', startsPicker: false },
  { name: 'the resume list not deployed', opts: { useResumePicker: true, pickerScript: null }, node: NODE, startsPicker: false },
]

function build(route: (typeof ROUTES)[number], extra: Partial<Opts>): string {
  ;(globalThis as any).__literalNodeExe = route.node ?? undefined
  if (route.node === null) delete (globalThis as any).__literalNodeExe
  _resetPickerNodeFoundForTest()
  return buildClaudeLaunchCommand({ platform: 'win32', cwd: 'C:\\work', claudeBin: EXE, extraFlags: ' --model opus', agentsFlag: '', useResumePicker: false, pickerScript: null, ...route.opts, ...extra })
}

/** The single-quoted PowerShell word at the start of `s` (any of the five
 *  single-quote characters; a doubled one inside is one literal). */
function psSingleQuoted(s: string): { value: string; length: number } {
  if (!Q.includes(s[0])) throw new Error(`not single-quoted: ${s}`)
  let value = ''
  for (let i = 1; i < s.length; i++) {
    if (Q.includes(s[i])) {
      if (i + 1 < s.length && Q.includes(s[i + 1])) { value += s[i + 1]; i++; continue }
      return { value, length: i + 1 }
    }
    value += s[i]
  }
  throw new Error(`unterminated: ${s}`)
}

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  vi.mocked(logInfo).mockClear()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  delete (globalThis as any).__literalNodeExe
  _resetPickerNodeFoundForTest()
})

describe('Windows: the session folder is given to Set-Location by -LiteralPath on every route', () => {
  const FOLDERS = ['C:\\work\\proj[1]', 'C:\\solo[2]', "F:\\o'brien [x]\\app]v2[", 'C:\\work', '\\\\srv\\share\\p[1]', 'z:/proj', 'C:\\back`tick\\p']
  // Mutation to prove this can fail: emit the bare `Set-Location '<cwd>'` form.
  for (const route of ROUTES) {
    for (const agentsFromEnv of [false, true]) {
      it(`${route.name}${agentsFromEnv ? ', templates in the environment' : ''}`, () => {
        for (const cwd of FOLDERS) {
          for (const claudeBin of [EXE, CMD]) {
            // A share folder is refused for npm's launcher on a line that starts Claude Code itself.
            if (claudeBin === CMD && cwd.startsWith('\\\\') && !route.startsPicker) continue
            const line = build(route, { cwd, claudeBin, ...(agentsFromEnv ? { agentsFromEnv: true, agentsValueLength: 10 } : {}) })
            const head = `${agentsFromEnv ? LEAD : ''}Set-Location -LiteralPath `
            expect(line.startsWith(head), line).toBe(true)
            const word = psSingleQuoted(line.slice(head.length))
            expect(word.value, line).toBe(cwd)
            expect(line.slice(head.length + word.length).startsWith('; '), line).toBe(true)
            // Never the bare form, which reads the folder as a pattern.
            expect(line, line).not.toMatch(new RegExp(`Set-Location\\s+[${Q}]`))
          }
        }
      })
    }
  }

  it('macOS and Linux are unchanged: the folder is single-quoted after cd, where no shell reads a pattern', () => {
    const line = buildClaudeLaunchCommand({ platform: 'posix', cwd: '/w/proj[1]', claudeBin: '/opt/c[1]/claude', extraFlags: '', agentsFlag: '', useResumePicker: false, pickerScript: null })
    expect(line).toBe("cd '/w/proj[1]' && '/opt/c[1]/claude'; exit")
  })
})

describe('Windows: a line that starts Claude Code itself refuses a Claude Code path holding [ or ]', () => {
  const BRACKETED = ['C:\\tools[1]\\claude.exe', 'C:\\npm]x\\claude.cmd', 'C:\\a[b]\\claude.bat', 'D:\\res\\legacy-versions\\[2.0.0]\\node_modules\\.bin\\claude.cmd']
  // Mutation to prove this can fail: drop the check (the path goes on the line after `&`).
  for (const route of ROUTES.filter((r) => !r.startsPicker)) {
    it(`${route.name}: refused with the reason, which never names the path, and nothing is logged`, () => {
      for (const claudeBin of BRACKETED) {
        vi.mocked(logInfo).mockClear()
        let said = ''
        try { build(route, { claudeBin }) } catch (e) { said = (e as Error).message }
        expect(said, claudeBin).toBe(CLAUDE_BIN_BRACKETS_REFUSAL)
        expect(said).not.toContain('tools[1]')
        expect(vi.mocked(logInfo), claudeBin).not.toHaveBeenCalled()
      }
    })
  }

  it('the resume list is not refused: the path is only named in CCC_CLAUDE_BIN, and node.exe is what the line starts', () => {
    const route = ROUTES.find((r) => r.startsPicker)!
    for (const claudeBin of BRACKETED) {
      const line = build(route, { claudeBin })
      expect(line).toBe(`Set-Location -LiteralPath 'C:\\work'; $env:CCC_CLAUDE_BIN = '${claudeBin}'; & '${NODE}' '${PICKER}' --model opus; exit`)
    }
  })

  it('control: a path without brackets is started after the call operator on every such route', () => {
    for (const route of ROUTES.filter((r) => !r.startsPicker)) {
      expect(build(route, { claudeBin: EXE }), route.name).toContain(`; & '${EXE}'`)
    }
  })

  it('the reason says what to do, in plain ASCII', () => {
    expect(CLAUDE_BIN_BRACKETS_REFUSAL).toMatch(/^Cannot start Claude Code: its path holds \[ or \]/)
    expect(CLAUDE_BIN_BRACKETS_REFUSAL).toMatch(/Install Claude Code in a folder without \[ or \]/)
    expect(/^[\x20-\x7e]+$/.test(CLAUDE_BIN_BRACKETS_REFUSAL)).toBe(true)
    // A launch starts only the installed Claude Code (a version pinned in an
    // older release is not used, 2.1.1-beta.3), so the advice names no other.
    expect(CLAUDE_BIN_BRACKETS_REFUSAL).not.toMatch(/older Claude Code version|resources folder/)
  })
})
