// A Claude Code version pinned in an older release is no longer used
// (2.1.1-beta.3): a launch whose saved config still carries one starts the
// installed Claude Code, exactly as a launch with none does, and the folder
// of pinned versions is never asked about it. One plain log line says so and
// names no path. The data is left alone: the pin stays in the config, it is
// only not used to launch.
//
// The Claude Code a launch names is resolveClaudeBinary's
// (src/main/providers/claude/spawn.ts), reached through the provider as
// pty-manager reaches it. The platform is forced per case, the Windows PATH
// walk answers from a set this test owns, and the folder of pinned versions
// is a stand-in that answers with a launcher for ANY version and records
// every question, so a launch that still consulted it would start that
// launcher. No file of this computer is read and nothing starts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  platform: 'win32' as NodeJS.Platform,
  present: new Set<string>(),
  /** Every question put to the folder of pinned versions. */
  asked: [] as string[],
  /** What that folder answers with, for any version. */
  pin: '',
}))
vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => h.platform }))
vi.mock('../../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/main/windows-programs')>()
  return {
    ...real,
    findOnWindowsPath: (names: readonly string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
      real.findOnWindowsPath(names, env, (p) => h.present.has(p.toLowerCase()), order),
    findWithPowerShellProfile: () => { throw new Error('the PowerShell profile is not asked in this test') },
  }
})
vi.mock('../../../../src/main/legacy-version-manager', () => ({
  resolveVersionBinary: (v: string) => { h.asked.push(`resolveVersionBinary ${v}`); return h.pin },
  isVersionInstalled: (v: string) => { h.asked.push(`isVersionInstalled ${v}`); return true },
  installVersion: async (v: string) => { h.asked.push(`installVersion ${v}`); return { ok: true } },
  legacyCliPin: (l?: { version: string }) => { h.asked.push(`legacyCliPin ${l?.version}`); return l ? { version: l.version, installed: true } : undefined },
}))

const { ClaudeProvider } = await import('../../../../src/main/providers/claude')
const { resolveClaudeBinary } = await import('../../../../src/main/providers/claude/spawn')
const { CLAUDE_NOT_ON_PATH, _resetClaudeWindowsLookupForTest, _resetClaudeLoginShellLookupForTest } = await import('../../../../src/main/claude-cli-probe')
const { logInfo } = await import('../../../../src/main/debug-logger')
const { LEGACY_PIN_NOT_USED } = await import('../../../../src/shared/legacy-version')

const PINNED = { enabled: true, version: '2.0.5' }
const WIN_ENV = { PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows' }
const WIN_PIN = 'C:\\Res\\claude-versions\\2.0.5\\node_modules\\.bin\\claude.cmd'
const POSIX_PIN = '/res/claude-versions/2.0.5/node_modules/.bin/claude'

/** The log lines written since the case began. */
const logged = (): string[] => (logInfo as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c.map(String).join(' '))

beforeEach(() => {
  h.platform = 'win32'
  h.present = new Set()
  h.asked = []
  h.pin = WIN_PIN
  _resetClaudeWindowsLookupForTest()
  _resetClaudeLoginShellLookupForTest()
  vi.mocked(logInfo).mockClear()
})

describe('a Claude Code version pinned in an older release is not used to launch', () => {
  it('Windows: the installed Claude Code found in PATH\'s folders, never the pinned launcher', () => {
    h.present = new Set(['c:\\tools\\claude.exe'])
    expect(resolveClaudeBinary(PINNED, WIN_ENV)).toEqual({ cmd: 'C:\\Tools\\claude.exe', args: [] })
    expect(h.asked).toEqual([])
  })

  it('through the provider, as pty-manager asks: the same installed Claude Code', () => {
    h.present = new Set(['c:\\tools\\claude.cmd'])
    const saved = process.env.PATH
    process.env.PATH = WIN_ENV.PATH
    try {
      expect(new ClaudeProvider().resolveBinary(PINNED)).toEqual({ cmd: 'C:\\Tools\\claude.cmd', args: [] })
    } finally {
      if (saved === undefined) delete process.env.PATH
      else process.env.PATH = saved
    }
    expect(h.asked).toEqual([])
  })

  it('Windows with no installed Claude Code: the launch is refused, it never falls back to the pin', () => {
    expect(() => resolveClaudeBinary(PINNED, WIN_ENV)).toThrow(CLAUDE_NOT_ON_PATH)
    expect(h.asked).toEqual([])
  })

  it('macOS and Linux: `claude`, which the session\'s login shell finds, never the pinned launcher', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      h.platform = platform
      h.pin = POSIX_PIN
      expect(resolveClaudeBinary(PINNED, { SHELL: '/bin/bash', PATH: '/usr/bin' }), platform).toEqual({ cmd: 'claude', args: [] })
    }
    expect(h.asked).toEqual([])
  })

  it('one plain log line says the pin is not used, naming no path and no folder', () => {
    h.present = new Set(['c:\\tools\\claude.exe'])
    resolveClaudeBinary(PINNED, WIN_ENV)
    const said = logged().filter((l) => l.includes(LEGACY_PIN_NOT_USED))
    expect(said).toHaveLength(1)
    for (const line of logged()) {
      expect(line).not.toContain(WIN_PIN)
      expect(line).not.toContain('claude-versions')
    }
  })

  it('a config with no pin, or one switched off, says nothing about it', () => {
    h.present = new Set(['c:\\tools\\claude.exe'])
    resolveClaudeBinary(undefined, WIN_ENV)
    resolveClaudeBinary({ enabled: false, version: '2.0.5' }, WIN_ENV)
    expect(logged().filter((l) => l.includes(LEGACY_PIN_NOT_USED))).toEqual([])
    expect(h.asked).toEqual([])
  })

  it('the message is plain ASCII and says what happens instead', () => {
    expect(LEGACY_PIN_NOT_USED).toMatch(/^[\x20-\x7e]+$/)
    expect(LEGACY_PIN_NOT_USED).toMatch(/installed Claude Code/)
  })
})
