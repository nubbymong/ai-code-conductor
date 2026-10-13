// 2.1.1-beta.3 (F26): the Claude Code version probe (claude-cli-version.ts)
// on Windows, for Claude Code that only the user's PowerShell profile puts on
// PATH (fnm plus an npm-installed claude.cmd). The probe walks the app's PATH
// itself; when that finds none it takes the PowerShell profile's answer
// (claude-cli-probe.ts claudeFromPowerShellProfile, which every other check
// and start shares), so setup passing and the managed-launch preflight's
// version agree. Without it such a user's version stays unknown and every
// managed launch carries the "not yet verified" finding.
//
// Host-safe: the profile question and child_process are mocked; the PATH this
// test sets names a folder that does not exist, so the walk reads no file of
// this computer's.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type ExecCb = (err: Error | null, stdout?: string) => void
const h = vi.hoisted(() => ({
  profile: vi.fn(async (): Promise<string | null> => null),
  posix: vi.fn(async () => ({ installed: false, probe: 'login shell' })),
  exec: [] as Array<{ file: string; args: string[] }>,
}))
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], _opts: unknown, cb: ExecCb) => {
    h.exec.push({ file, args })
    cb(null, '2.1.300 (Claude Code)\n')
    return { exitCode: 0, signalCode: null }
  },
}))
vi.mock('../../../src/main/claude-cli-probe', () => ({
  probeClaudeCli: () => h.posix(),
  claudeFromPowerShellProfile: () => h.profile(),
  setClaudeProfileLookupAllowed: () => {},
  CLAUDE_PROFILE_PROBE: 'Windows PowerShell profile',
}))

const { resolveClaudeExecutable, probeClaudeCliVersion, peekClaudeCliVersion, _resetClaudeCliVersionForTest } = await import('../../../src/main/claude-cli-version')

const FNM = 'C:\\Users\\me\\AppData\\Local\\fnm_multishells\\1234_1700000000\\claude.cmd'
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedPath = process.env.PATH

beforeEach(() => {
  _resetClaudeCliVersionForTest()
  h.profile.mockReset()
  h.profile.mockImplementation(async () => null)
  h.posix.mockClear()
  h.exec.length = 0
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.PATH = 'C:\\ccc-test-no-such-folder-6f1d'
})
afterEach(() => {
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
})

describe('the Claude Code version probe on Windows, with Claude Code only in the PowerShell profile\'s PATH', () => {
  // Mutation to prove this can fail: drop the claudeFromPowerShellProfile
  // fallback from resolveForVersionProbe (beta.2's behaviour).
  it('the walk finds none: the probe resolves the Claude Code the profile found', async () => {
    h.profile.mockImplementation(async () => FNM)
    expect(await resolveClaudeExecutable()).toBe(FNM)
    expect(h.profile).toHaveBeenCalledTimes(1)
    expect(h.posix).not.toHaveBeenCalled()
  })

  it('and its version is read from that claude.cmd, through cmd.exe with the path quoted', async () => {
    h.profile.mockImplementation(async () => FNM)
    expect(await probeClaudeCliVersion()).toBe('2.1.300')
    expect(peekClaudeCliVersion()).toBe('2.1.300')
    expect(h.exec).toHaveLength(1)
    expect(h.exec[0].args).toEqual(['/d', '/v:off', '/s', '/c', `""${FNM}" --version"`])
  })

  it('the profile finds none either: nothing is resolved and nothing runs', async () => {
    expect(await resolveClaudeExecutable()).toBeNull()
    expect(await probeClaudeCliVersion()).toBeNull()
    expect(h.exec).toEqual([])
  })

  it('off Windows the profile is never asked', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    await resolveClaudeExecutable()
    expect(h.profile).not.toHaveBeenCalled()
    expect(h.posix).toHaveBeenCalledTimes(1)
  })
})
