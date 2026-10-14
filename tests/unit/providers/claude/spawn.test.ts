// ClaudeProvider.resolveBinary: the Claude Code a launch names. The platform is
// forced per case and the Windows PATH walk answers from a set this test owns
// (no file of this computer is read), so the result never depends on what the
// host has installed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  platform: 'win32' as NodeJS.Platform,
  present: new Set<string>(),
  /** The Windows PowerShell profile question (windows-programs.ts, its own suite): its calls, and its answer once released. */
  profileCalls: 0,
  profileAnswer: null as string | null,
  profileRelease: [] as Array<() => void>,
}))
vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => h.platform }))
vi.mock('../../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/main/windows-programs')>()
  return {
    ...real,
    findOnWindowsPath: (names: readonly string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
      real.findOnWindowsPath(names, env, (p) => h.present.has(p.toLowerCase()), order),
    findWithPowerShellProfile: () => {
      h.profileCalls += 1
      type Lookup = import('../../../../src/main/windows-programs').PowerShellProfileLookup
      return new Promise<Lookup>((resolve) => {
        h.profileRelease.push(() => resolve(h.profileAnswer ? { outcome: 'found', path: h.profileAnswer } : { outcome: 'none' }))
      })
    },
  }
})

const { ClaudeProvider } = await import('../../../../src/main/providers/claude')
const { CLAUDE_NOT_ON_PATH, _resetClaudeWindowsLookupForTest, _resetClaudeLoginShellLookupForTest, setClaudeProfileLookupAllowed, claudeFromPowerShellProfile } = await import('../../../../src/main/claude-cli-probe')
const { noteWindowsPathRefresh } = await import('../../../../src/main/windows-programs')

// The provider reads this process's own environment: PATH and SHELL are set
// per case and put back after.
const saved = { path: process.env.PATH, shell: process.env.SHELL }
function restore(name: 'PATH' | 'SHELL', value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  h.present = new Set()
  h.profileCalls = 0
  h.profileAnswer = null
  h.profileRelease = []
  _resetClaudeWindowsLookupForTest()
  _resetClaudeLoginShellLookupForTest()
})
afterEach(() => {
  restore('PATH', saved.path)
  restore('SHELL', saved.shell)
})

describe('ClaudeProvider.resolveBinary', () => {
  it('off Windows, for a sh-family login shell: "claude", which the session\'s login shell finds', () => {
    h.platform = 'linux'
    process.env.SHELL = '/bin/bash'
    expect(new ClaudeProvider().resolveBinary()).toEqual({ cmd: 'claude', args: [] })
  })

  it('on Windows: the full path found in PATH\'s folders, or a refusal that names them -- never a bare name', () => {
    h.platform = 'win32'
    process.env.PATH = '.;rel\\bin;C:\\Tools'
    h.present = new Set(['.\\claude.exe', 'rel\\bin\\claude.exe', 'claude.exe', 'c:\\tools\\claude.exe'])
    expect(new ClaudeProvider().resolveBinary()).toEqual({ cmd: 'C:\\Tools\\claude.exe', args: [] })
    _resetClaudeWindowsLookupForTest()
    h.present = new Set(['.\\claude.exe', 'rel\\bin\\claude.exe', 'claude.exe'])
    expect(() => new ClaudeProvider().resolveBinary()).toThrow(CLAUDE_NOT_ON_PATH)
  })
})

// 2.1.1-beta.3 (F26): Claude Code on PATH only through the user's PowerShell
// profile, which a session's PowerShell runs too. beta.2 refused every
// launch (CLAUDE_NOT_ON_PATH) because the app's own PATH names no Claude Code.
describe('ClaudeProvider.resolveBinary on Windows, with Claude Code only in the PowerShell profile\'s PATH', () => {
  const FNM = 'C:\\Users\\me\\AppData\\Local\\fnm_multishells\\1234_1700000000\\claude.cmd'
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  /** The profile's answer, kept the way a check keeps it (the boot probe, the CLI check). */
  async function profileAnswered(answer: string | null): Promise<void> {
    h.profileAnswer = answer
    const asked = claudeFromPowerShellProfile(async () => true)
    await settle()
    for (const r of h.profileRelease.splice(0)) r()
    await asked
  }
  beforeEach(() => {
    h.platform = 'win32'
    process.env.PATH = 'C:\\Windows\\System32;C:\\Tools'
    setClaudeProfileLookupAllowed(() => true)
  })

  // Mutation to prove this can fail: drop the keptClaudeFromPowerShellProfile
  // fallback from findClaudeOnWindows (beta.2's behaviour).
  it('a walk that finds none, with the profile\'s answer kept: the launch names that full path, asking nothing', async () => {
    await profileAnswered(FNM)
    expect(h.profileCalls).toBe(1)
    expect(new ClaudeProvider().resolveBinary()).toEqual({ cmd: FNM, args: [] })
    expect(new ClaudeProvider().resumeCommand('abc')).toEqual({ cmd: FNM, args: ['--resume', 'abc'] })
    expect(h.profileCalls).toBe(1)
  })

  // Mutation to prove this can fail: drop startClaudeProfileLookup from
  // findClaudeOnWindows.
  it('with no answer yet the launch still refuses, and starts the question for the next launch, once', async () => {
    h.profileAnswer = FNM
    expect(() => new ClaudeProvider().resolveBinary()).toThrow(CLAUDE_NOT_ON_PATH)
    expect(h.profileCalls).toBe(1)
    expect(() => new ClaudeProvider().resolveBinary()).toThrow(CLAUDE_NOT_ON_PATH)
    expect(h.profileCalls).toBe(1)
    for (const r of h.profileRelease.splice(0)) r()
    await settle()
    expect(new ClaudeProvider().resolveBinary()).toEqual({ cmd: FNM, args: [] })
    expect(h.profileCalls).toBe(1)
  })

  // Any provider's check the user asks for (another
  // provider's Check again or setup page) brings PATH up to date and moves
  // the count.
  // Mutation to prove this can fail: read only the current answer on the
  // launch path, which refused here with CLAUDE_NOT_ON_PATH.
  it('a check the user asked for makes the kept answer stale, not wrong: the launch still names it, and exactly one new question starts', async () => {
    const FNM2 = 'C:\\Users\\me\\AppData\\Local\\fnm_multishells\\5678_1700000999\\claude.cmd'
    await profileAnswered(FNM)
    expect(h.profileCalls).toBe(1)
    noteWindowsPathRefresh()
    expect(new ClaudeProvider().resolveBinary()).toEqual({ cmd: FNM, args: [] })
    expect(h.profileCalls).toBe(2)
    expect(new ClaudeProvider().resumeCommand('abc')).toEqual({ cmd: FNM, args: ['--resume', 'abc'] })
    expect(h.profileCalls).toBe(2)
    // Its answer is what the next launch names.
    h.profileAnswer = FNM2
    for (const r of h.profileRelease.splice(0)) r()
    await settle()
    expect(new ClaudeProvider().resolveBinary()).toEqual({ cmd: FNM2, args: [] })
    expect(h.profileCalls).toBe(2)
  })

  it('a profile that found none either: the launch refuses and asks nothing again', async () => {
    await profileAnswered(null)
    expect(() => new ClaudeProvider().resolveBinary()).toThrow(CLAUDE_NOT_ON_PATH)
    expect(() => new ClaudeProvider().resolveBinary()).toThrow(CLAUDE_NOT_ON_PATH)
    expect(h.profileCalls).toBe(1)
  })

  it('a Claude Code in the launch\'s own PATH comes before the profile\'s', async () => {
    await profileAnswered(FNM)
    h.present = new Set(['c:\\tools\\claude.exe'])
    expect(new ClaudeProvider().resolveBinary()).toEqual({ cmd: 'C:\\Tools\\claude.exe', args: [] })
  })
})
