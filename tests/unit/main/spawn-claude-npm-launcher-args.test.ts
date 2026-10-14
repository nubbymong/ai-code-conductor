// On Windows, a launch line that starts Claude Code through a program cmd.exe
// may read hands it only text cmd.exe reads as text (2.1.1-beta.3).
// PowerShell runs the line and hands its program one command line; npm's
// claude.cmd (or a claude.bat) runs through cmd.exe, which reads that line
// again. PowerShell wraps an argument in double quotes only when it holds a
// space. So on such a line a batch launcher's own path, and every argument
// written as text, is checked, and a launch that would hand cmd.exe more than
// text is refused with the reason before anything starts. A claude.exe
// started directly gets its arguments without cmd.exe, and so does the
// resume list's node.exe, which the line starts by the full path the app
// found: their arguments are as in beta.2 (the picker quotes for cmd.exe
// itself when it starts a batch launcher). Pure: the builder only, the
// node.exe lookup answered by a mock, nothing started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  const nodeOnly = (names: readonly string[]): boolean => names.length === 1 && names[0] === 'node.exe'
  return {
    ...actual,
    findOnWindowsPath: vi.fn((names: readonly string[], ...rest: unknown[]) => (nodeOnly(names) ? ((globalThis as any).__nodeExe ?? null) : (actual.findOnWindowsPath as any)(names, ...rest))),
  }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const mod = await import('../../../src/main/spawn-claude-command')
const { buildClaudeLaunchCommand, quoteArgForShell, LAUNCHER_PROGRAM_LOOKUP } = mod
const { logInfo } = await import('../../../src/main/debug-logger')

const CMD = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'
const BAT = 'C:\\tools\\claude.bat'
const PS1 = 'C:\\res\\legacy-versions\\2.0.0\\node_modules\\.bin\\claude.ps1'
const EXE = 'C:\\Users\\u\\.local\\bin\\claude.exe'
const PICKER = 'C:\\res\\scripts\\resume-picker.js'
const q = (v: string): string => quoteArgForShell(v, true)
const BASE = { platform: 'win32', cwd: 'C:\\work', claudeBin: CMD, extraFlags: '', agentsFlag: '', useResumePicker: false, pickerScript: null as string | null }
const settings = (p: string): string => ` --settings ${q(p)}`
const REFUSED = /^Cannot start Claude Code through its npm launcher: /

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  ;(mod as any)._resetPickerNodeFoundForTest()
  ;(globalThis as any).__nodeExe = 'C:\\Program Files\\nodejs\\node.exe'
  vi.mocked(logInfo).mockClear()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  delete (globalThis as any).__nodeExe
  ;(mod as any)._resetPickerNodeFoundForTest()
})

describe('npm\'s claude.cmd started by the line: every argument stays text to cmd.exe', () => {
  it('ordinary values are built as before: a space, parentheses, an apostrophe, a launcher under Program Files (x86)', () => {
    const value = 'C:\\Users\\Tom & Jerry (x)\\it\'s\\settings.json'
    expect(buildClaudeLaunchCommand({ ...BASE, extraFlags: ` --model 'opus'${settings(value)}`, userArgs: '--verbose' }))
      .toBe(`Set-Location -LiteralPath 'C:\\work'; ${LAUNCHER_PROGRAM_LOOKUP}& '${CMD}' --model 'opus' --settings 'C:\\Users\\Tom & Jerry (x)\\it''s\\settings.json' '--verbose'; exit`)
    const x86 = 'C:\\Program Files (x86)\\nodejs\\claude.cmd'
    expect(buildClaudeLaunchCommand({ ...BASE, claudeBin: x86, extraFlags: settings('C:\\cfg\\s.json') }))
      .toBe(`Set-Location -LiteralPath 'C:\\work'; ${LAUNCHER_PROGRAM_LOOKUP}& '${x86}' --settings 'C:\\cfg\\s.json'; exit`)
  })

  // Mutation to prove this can fail: drop the check (the line is built and cmd.exe reads the character as syntax).
  it('a value without a space holding & | < > ^ ( ) is refused, naming the option it is the value of', () => {
    for (const c of ['&', '|', '<', '>', '^', '(', ')']) {
      const opts = { ...BASE, extraFlags: settings(`C:\\R${c}D\\s.json`) }
      expect(() => buildClaudeLaunchCommand(opts), c).toThrow(REFUSED)
      expect(() => buildClaudeLaunchCommand(opts), c).toThrow(/the value of --settings holds a character cmd\.exe would read as more than text/)
    }
  })

  it('the same characters in a value with a space are inside the quotes PowerShell adds: built', () => {
    for (const c of ['&', '|', '<', '>', '^', '(', ')']) {
      const value = `C:\\R ${c} D\\s.json`
      expect(buildClaudeLaunchCommand({ ...BASE, extraFlags: settings(value) }), c).toBe(`Set-Location -LiteralPath 'C:\\work'; ${LAUNCHER_PROGRAM_LOOKUP}& '${CMD}' --settings ${q(value)}; exit`)
    }
  })

  it('a double quote, % or a control character is refused with or without a space', () => {
    for (const value of ['C:\\a"b\\s.json', 'C:\\a "b\\s.json', 'C:\\100%\\s.json', 'C:\\a %PATH% b\\s.json', 'C:\\a\tb\\s.json', 'C:\\a\u0007b\\s.json', 'C:\\a\u0085b\\s.json']) {
      expect(() => buildClaudeLaunchCommand({ ...BASE, extraFlags: settings(value) }), JSON.stringify(value)).toThrow(REFUSED)
    }
  })

  it('agent templates written on the line itself are refused; through the session environment they are built as before', () => {
    const agentsFlag = ` --agents ${q(JSON.stringify({ r: { description: 'd', prompt: 'p' } }))}`
    expect(() => buildClaudeLaunchCommand({ ...BASE, agentsFlag })).toThrow(/the value of --agents holds a character/)
    expect(buildClaudeLaunchCommand({ ...BASE, agentsFromEnv: true, agentsValueLength: 40 }))
      .toBe(`$PSNativeCommandArgumentPassing = 'Legacy'; Set-Location -LiteralPath 'C:\\work'; ${LAUNCHER_PROGRAM_LOOKUP}& '${CMD}' --agents \${env:CCC_AGENTS}; exit`)
  })

  it('a word PowerShell would read (a variable or an escape outside quotes) is refused', () => {
    expect(() => buildClaudeLaunchCommand({ ...BASE, extraFlags: ' --effort $high' })).toThrow(/the value of --effort holds a character/)
    expect(() => buildClaudeLaunchCommand({ ...BASE, extraFlags: ' --effort hi`gh' })).toThrow(REFUSED)
    // Inside single quotes `$` is text, and text cmd.exe reads as text.
    expect(buildClaudeLaunchCommand({ ...BASE, extraFlags: settings('C:\\$x\\s.json') })).toBe(`Set-Location -LiteralPath 'C:\\work'; ${LAUNCHER_PROGRAM_LOOKUP}& '${CMD}' --settings 'C:\\$x\\s.json'; exit`)
  })

  it('the user\'s own words are checked as well, by the option they belong to', () => {
    expect(() => buildClaudeLaunchCommand({ ...BASE, userArgs: '--add-dir=C:\\R&D' })).toThrow(/the value of --add-dir holds a character/)
    expect(() => buildClaudeLaunchCommand({ ...BASE, userArgs: 'a|b' })).toThrow(/an argument holds a character/)
  })

  it('a launcher path cmd.exe or the launcher would re-read is refused: " % & ^ or a control character', () => {
    for (const bin of ['C:\\R&D\\npm\\claude.cmd', 'C:\\100%\\claude.cmd', 'C:\\a^b\\claude.bat', 'C:\\a\u0001b\\claude.cmd']) {
      expect(() => buildClaudeLaunchCommand({ ...BASE, claudeBin: bin }), bin).toThrow(/cmd\.exe would read a character in the launcher's own path as more than text/)
    }
  })

  it('an exact resume and a claude.bat are checked alike; a claude.ps1 launcher has its arguments checked', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000'
    expect(() => buildClaudeLaunchCommand({ ...BASE, resumeUuid: uuid, extraFlags: settings('C:\\R&D\\s.json') })).toThrow(REFUSED)
    expect(buildClaudeLaunchCommand({ ...BASE, resumeUuid: uuid, extraFlags: settings('C:\\cfg\\s.json') })).toBe(`Set-Location -LiteralPath 'C:\\work'; ${LAUNCHER_PROGRAM_LOOKUP}& '${CMD}' --resume ${uuid} --settings 'C:\\cfg\\s.json'; exit`)
    expect(() => buildClaudeLaunchCommand({ ...BASE, claudeBin: BAT, extraFlags: settings('C:\\R&D\\s.json') })).toThrow(REFUSED)
    expect(() => buildClaudeLaunchCommand({ ...BASE, claudeBin: PS1, extraFlags: settings('C:\\R&D\\s.json') })).toThrow(REFUSED)
  })

  it('a refused launch writes nothing about the resume list and starts nothing', () => {
    ;(globalThis as any).__nodeExe = undefined
    expect(() => buildClaudeLaunchCommand({ ...BASE, useResumePicker: true, pickerScript: PICKER, extraFlags: settings('C:\\R&D\\s.json') })).toThrow(REFUSED)
    expect(vi.mocked(logInfo)).not.toHaveBeenCalled()
  })
})

// PowerShell takes five characters as a single quote: the apostrophe and the
// curly U+2018, U+2019, U+201A and U+201B. The builder doubles each of them
// inside a quoted value (escapeForCwdQuote), and the check reads the line as
// PowerShell does, all five as quote marks, so it judges every argument as
// PowerShell hands it on to the launcher.
describe('a curly single quote in a value or in the launcher\'s path, on a line cmd.exe reads', () => {
  const QUOTES = [0x27, 0x2018, 0x2019, 0x201a, 0x201b].map((c) => String.fromCharCode(c))
  /** A curly double quote pair, which PowerShell takes as double quotes. */
  const [LDQ, RDQ] = [0x201c, 0x201d].map((c) => String.fromCharCode(c))
  const name = (cq: string): string => `U+${cq.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  const built = (flags: string, bin = CMD): string => `Set-Location -LiteralPath 'C:\\work'; ${LAUNCHER_PROGRAM_LOOKUP}& '${bin}'${flags}; exit`

  it('a value holding one, quoted by the builder: refused or built exactly as with an apostrophe', () => {
    for (const cq of QUOTES) {
      // No space: PowerShell hands it on as it is, and cmd.exe reads the &.
      expect(() => buildClaudeLaunchCommand({ ...BASE, extraFlags: settings(`C:\\a${cq}b&c\\s.json`) }), name(cq)).toThrow(REFUSED)
      // A space: PowerShell wraps it in double quotes, inside which & is text.
      const spaced = `C:\\a${cq} b&c\\s.json`
      expect(buildClaudeLaunchCommand({ ...BASE, extraFlags: settings(spaced) }), name(cq)).toBe(built(settings(spaced)))
      expect(() => buildClaudeLaunchCommand({ ...BASE, extraFlags: settings(`C:\\(x${cq}`) }), name(cq)).toThrow(REFUSED)
    }
  })

  // Mutation to prove this can fail: read only the apostrophe as a quote mark in the check (PS_SINGLE_QUOTES).
  it('written by the line as the quote marks of a value: judged by the value PowerShell hands on', () => {
    for (const cq of QUOTES) {
      // Between two of them, a value with a space: PowerShell wraps it in double quotes.
      const spaced = ` --settings ${cq}C:\\a b&c\\s.json${cq}`
      expect(buildClaudeLaunchCommand({ ...BASE, extraFlags: spaced }), name(cq)).toBe(built(spaced))
      // Between two of them $ is text to PowerShell, and text to cmd.exe.
      const dollar = ` --settings ${cq}C:\\$x\\s.json${cq}`
      expect(buildClaudeLaunchCommand({ ...BASE, extraFlags: dollar }), name(cq)).toBe(built(dollar))
      // Opened by one and closed by an apostrophe: one quoted value still.
      const mixed = ` --settings ${cq}C:\\$x\\s.json'`
      expect(buildClaudeLaunchCommand({ ...BASE, extraFlags: mixed }), name(cq)).toBe(built(mixed))
      // After the closing one, $ is a variable to PowerShell: refused.
      expect(() => buildClaudeLaunchCommand({ ...BASE, extraFlags: ` --settings ${cq}C:\\x${cq}$y` }), name(cq)).toThrow(/the value of --settings holds a character/)
    }
  })

  it('a curly double quote opens a string PowerShell expands: a $ in it is refused', () => {
    expect(() => buildClaudeLaunchCommand({ ...BASE, extraFlags: ` --effort ${LDQ}$x${RDQ}` })).toThrow(/the value of --effort holds a character/)
    expect(() => buildClaudeLaunchCommand({ ...BASE, extraFlags: ` --effort ${LDQ}$x` })).toThrow(REFUSED)
  })

  // Mutation to prove this can fail: double only the apostrophe in escapeForCwdQuote.
  it('a launcher path holding one: doubled on the line, so PowerShell starts that path; with & as well, refused', () => {
    for (const cq of QUOTES) {
      const bin = `C:\\Users\\it${cq}s npm\\claude.cmd`
      expect(buildClaudeLaunchCommand({ ...BASE, claudeBin: bin, extraFlags: settings('C:\\cfg\\s.json') }), name(cq))
        .toBe(`Set-Location -LiteralPath 'C:\\work'; ${LAUNCHER_PROGRAM_LOOKUP}& 'C:\\Users\\it${cq}${cq}s npm\\claude.cmd' --settings 'C:\\cfg\\s.json'; exit`)
      expect(() => buildClaudeLaunchCommand({ ...BASE, claudeBin: `C:\\R${cq}&D\\claude.cmd` }), name(cq)).toThrow(/cmd\.exe would read a character in the launcher's own path as more than text/)
    }
  })
})

describe('the resume list is started by node.exe, which cmd.exe never reads: its arguments are as in beta.2', () => {
  const RD = { pickerScript: 'C:\\R&D\\res\\scripts\\resume-picker.js', extraFlags: `${settings('C:\\R&D\\res\\s.json')} --mcp-config ${q('C:\\R(D)\\res\\mcp.json')}` }
  const line = (bin: string): string => `Set-Location -LiteralPath 'C:\\work'; $env:CCC_CLAUDE_BIN = '${bin}'; & 'C:\\Program Files\\nodejs\\node.exe' '${RD.pickerScript}' --settings 'C:\\R&D\\res\\s.json' --mcp-config 'C:\\R(D)\\res\\mcp.json'; exit`

  // Mutation to prove this can fail: check the picker's line as one cmd.exe reads (refused with "Cannot start the resume list").
  it('a native claude.exe with the app\'s folders at a path cmd.exe would read: the resume list starts, as in beta.2', () => {
    expect(buildClaudeLaunchCommand({ ...BASE, claudeBin: EXE, useResumePicker: true, ...RD })).toBe(line(EXE))
    expect(vi.mocked(logInfo)).not.toHaveBeenCalled()
  })

  it('npm\'s claude.cmd through the resume list: the line is built, and the picker quotes for cmd.exe itself', () => {
    expect(buildClaudeLaunchCommand({ ...BASE, claudeBin: CMD, useResumePicker: true, ...RD })).toBe(line(CMD))
  })

  it('the same launches without the resume list start Claude Code itself: npm\'s claude.cmd is refused with the reason, a claude.exe starts', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000'
    for (const route of [{ resumeUuid: uuid }, { useResumePicker: false }]) {
      expect(() => buildClaudeLaunchCommand({ ...BASE, claudeBin: CMD, useResumePicker: true, ...RD, ...route })).toThrow(REFUSED)
      expect(buildClaudeLaunchCommand({ ...BASE, claudeBin: EXE, useResumePicker: true, ...RD, ...route })).toContain(`& '${EXE}' `)
    }
    // No node.exe: Claude Code directly, so npm's claude.cmd is checked.
    ;(globalThis as any).__nodeExe = undefined
    ;(mod as any)._resetPickerNodeFoundForTest()
    expect(() => buildClaudeLaunchCommand({ ...BASE, claudeBin: CMD, useResumePicker: true, ...RD })).toThrow(REFUSED)
    expect(buildClaudeLaunchCommand({ ...BASE, claudeBin: EXE, useResumePicker: true, ...RD })).toBe(`Set-Location -LiteralPath 'C:\\work'; & '${EXE}' --settings 'C:\\R&D\\res\\s.json' --mcp-config 'C:\\R(D)\\res\\mcp.json'; exit`)
  })
})

describe('a claude.exe started directly gets its arguments without cmd.exe: nothing changes', () => {
  it('a value without a space holding & is built as before', () => {
    expect(buildClaudeLaunchCommand({ ...BASE, claudeBin: EXE, extraFlags: settings('C:\\R&D\\s.json') })).toBe(`Set-Location -LiteralPath 'C:\\work'; & '${EXE}' --settings 'C:\\R&D\\s.json'; exit`)
  })

  it('off Windows nothing here applies', () => {
    expect(buildClaudeLaunchCommand({ ...BASE, platform: 'posix', cwd: '/w', claudeBin: '/x/claude.cmd', extraFlags: " --settings '/R&D/s.json'" })).toBe(`cd '/w' && '/x/claude.cmd' --settings '/R&D/s.json'; exit`)
  })
})
