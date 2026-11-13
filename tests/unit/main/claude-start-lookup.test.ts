// Windows, at start (regression since #638): a launch names Claude Code by its
// full path or starts nothing, and it cannot wait. A tab restored at start was
// launched before this process's PATH was brought up to date and before the
// PowerShell profile had answered, so it said "not found" until Check again.
// At start main now brings PATH up to date from the registry once, then looks
// for Claude Code once (claude-start-lookup.ts); a launch asked for meanwhile
// waits for both, bounded, then resolves as any launch does. Off Windows
// nothing is refreshed and nothing waits.
//
// Host-safe: the registry read, the PATH walk's file test and the PowerShell
// profile question are stand-ins answered here. Nothing is started, no file of
// this computer is read, and PATH is put back after each case.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const h = vi.hoisted(() => ({
  platform: 'win32' as NodeJS.Platform,
  /** The files the PATH walk finds, lower-cased. */
  present: new Set<string>(),
  /** The user PATH the registry holds, or null for none. */
  registryUser: null as string | null,
  registryReads: 0,
  holdRegistry: false,
  registryRelease: [] as Array<() => void>,
  /** The PowerShell profile question: its calls, and its answer once released. */
  profileCalls: 0,
  profileAnswer: null as string | null,
  profileRelease: [] as Array<() => void>,
}))
vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => h.platform }))
vi.mock('../../../src/main/windows-registry-path', async (importOriginal) => {
  type Values = import('../../../src/main/windows-registry-path').RegistryPaths
  return {
    ...(await importOriginal<typeof import('../../../src/main/windows-registry-path')>()),
    readRegistryPaths: (): Promise<Values> => {
      h.registryReads += 1
      const values = (): Values => ({ machine: null, user: h.registryUser ? { kind: 'String', data: h.registryUser } : null })
      if (!h.holdRegistry) return Promise.resolve(values())
      return new Promise<Values>((resolve) => { h.registryRelease.push(() => resolve(values())) })
    },
  }
})
vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  type Lookup = import('../../../src/main/windows-programs').PowerShellProfileLookup
  return {
    ...real,
    findOnWindowsPath: (names: readonly string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
      real.findOnWindowsPath(names, env, (p) => h.present.has(p.toLowerCase()), order),
    findOnWindowsPathAsync: (names: readonly string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
      real.findOnWindowsPathAsync(names, env, async (p) => h.present.has(p.toLowerCase()), order),
    findWithPowerShellProfile: () => {
      h.profileCalls += 1
      return new Promise<Lookup>((resolve) => {
        h.profileRelease.push(() => resolve(h.profileAnswer ? { outcome: 'found', path: h.profileAnswer } : { outcome: 'none' }))
      })
    },
  }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {} }))

const { startClaudeLookup, claudeStartLookupPending, awaitClaudeStartLookup, CLAUDE_START_LOOKUP_WAIT_MS, _resetClaudeStartLookupForTest } =
  await import('../../../src/main/claude-start-lookup')
const { refreshWindowsPath } = await import('../../../src/main/windows-path-refresh')
const { findClaudeOnWindowsAsync, setClaudeProfileLookupAllowed, CLAUDE_NOT_ON_PATH, _resetClaudeCliProbeForTest, _resetClaudeWindowsLookupForTest, _resetClaudeLoginShellLookupForTest } =
  await import('../../../src/main/claude-cli-probe')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')

const SYSTEM = 'C:\\Windows\\System32'
const LOCAL_BIN = 'C:\\Users\\me\\.local\\bin'
const FNM = 'C:\\Users\\me\\AppData\\Local\\fnm_multishells\\1234_1700000000\\claude.cmd'
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const saved = { path: process.env.PATH, shell: process.env.SHELL }
function restore(name: 'PATH' | 'SHELL', value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }

/** What main hands the start (index.ts, pinned below), the version probe a stand-in. */
const order: string[] = []
const versionProbe = vi.fn(() => { order.push(`version probe on ${process.env.PATH}`) })
const steps = () => ({
  refreshPath: refreshWindowsPath,
  lookup: () => { order.push(`lookup on ${process.env.PATH}`); return findClaudeOnWindowsAsync(process.env) },
  versionProbe,
})
/** The launch: what a session's start names (providers/claude/spawn.ts resolveClaudeBinary). */
const launch = (): { cmd: string; args: string[] } | null => new ClaudeProvider().resolveBinary()

beforeEach(() => {
  h.platform = 'win32'
  h.present = new Set()
  h.registryUser = null
  h.registryReads = 0
  h.holdRegistry = false
  h.registryRelease = []
  h.profileCalls = 0
  h.profileAnswer = null
  h.profileRelease = []
  order.length = 0
  versionProbe.mockClear()
  _resetClaudeStartLookupForTest()
  _resetClaudeCliProbeForTest()
  _resetClaudeWindowsLookupForTest()
  _resetClaudeLoginShellLookupForTest()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})
afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  restore('PATH', saved.path)
  restore('SHELL', saved.shell)
})

describe('on Windows, at start: PATH from the registry, then the first Claude Code lookup', () => {
  // Mutation to prove this can fail: start the lookup without the refresh.
  it('brings PATH up to date once, before the lookup; a launch that waited names the claude.exe in the folder it added', async () => {
    process.env.PATH = SYSTEM
    h.registryUser = LOCAL_BIN
    h.present = new Set([`${LOCAL_BIN}\\claude.exe`.toLowerCase()])
    h.holdRegistry = true
    startClaudeLookup(steps())
    await settle()
    expect(claudeStartLookupPending()).toBe(true)
    expect(order, 'nothing looks for Claude Code while the registry is read').toEqual([])
    const waited = awaitClaudeStartLookup()
    for (const r of h.registryRelease.splice(0)) r()
    await waited
    expect(claudeStartLookupPending()).toBe(false)
    expect(h.registryReads).toBe(1)
    expect(process.env.PATH).toBe(`${SYSTEM};${LOCAL_BIN}`)
    expect(order).toEqual([`lookup on ${SYSTEM};${LOCAL_BIN}`, `version probe on ${SYSTEM};${LOCAL_BIN}`])
    expect(launch()).toEqual({ cmd: `${LOCAL_BIN}\\claude.exe`, args: [] })
    expect(h.profileCalls, 'found on PATH: the profile is not asked').toBe(0)
  })

  // Mutation to prove this can fail: end the wait when the PATH refresh ends.
  it('a launch waits for the PowerShell profile\'s first answer too, and names the path it gave', async () => {
    process.env.PATH = SYSTEM
    setClaudeProfileLookupAllowed(() => true)
    startClaudeLookup(steps())
    await settle()
    expect(h.profileCalls).toBe(1)
    expect(claudeStartLookupPending()).toBe(true)
    expect(versionProbe).not.toHaveBeenCalled()
    const waited = awaitClaudeStartLookup()
    h.profileAnswer = FNM
    for (const r of h.profileRelease.splice(0)) r()
    await waited
    expect(claudeStartLookupPending()).toBe(false)
    expect(launch()).toEqual({ cmd: FNM, args: [] })
    expect(h.profileCalls, 'the launch asked nothing more').toBe(1)
    expect(versionProbe).toHaveBeenCalledTimes(1)
  })

  // Mutation to prove this can fail: wait without a bound.
  it('the wait is bounded by a few seconds; past it the launch is refused exactly as before, never by a bare name', async () => {
    expect(CLAUDE_START_LOOKUP_WAIT_MS).toBeGreaterThanOrEqual(2000)
    expect(CLAUDE_START_LOOKUP_WAIT_MS).toBeLessThanOrEqual(10_000)
    process.env.PATH = SYSTEM
    setClaudeProfileLookupAllowed(() => true)
    startClaudeLookup(steps())
    await settle()
    vi.useFakeTimers()
    let waited = false
    void awaitClaudeStartLookup().then(() => { waited = true })
    await vi.advanceTimersByTimeAsync(CLAUDE_START_LOOKUP_WAIT_MS - 1)
    expect(waited).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(waited).toBe(true)
    // The profile never answered: the lookup is still running, and the launch says what it always said.
    expect(claudeStartLookupPending()).toBe(true)
    expect(() => launch()).toThrow(CLAUDE_NOT_ON_PATH)
  })

  it('a refresh or a lookup that fails still lets launches go, and the version probe run', async () => {
    startClaudeLookup({ refreshPath: () => Promise.reject(new Error('no registry')), lookup: () => Promise.reject(new Error('no walk')), versionProbe })
    expect(claudeStartLookupPending()).toBe(true)
    await awaitClaudeStartLookup()
    expect(claudeStartLookupPending()).toBe(false)
    expect(versionProbe).toHaveBeenCalledTimes(1)
  })

  it('once the start has answered, nothing waits', async () => {
    process.env.PATH = SYSTEM
    startClaudeLookup(steps())
    await settle()
    expect(claudeStartLookupPending()).toBe(false)
    vi.useFakeTimers()
    let waited = false
    void awaitClaudeStartLookup().then(() => { waited = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(waited).toBe(true)
  })
})

describe('off Windows nothing changes', () => {
  it('no registry read, no lookup, nothing to wait for; the version probe runs at once and a launch names "claude"', async () => {
    h.platform = 'linux'
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env.SHELL = '/bin/bash'
    const pathBefore = process.env.PATH
    const s = steps()
    startClaudeLookup(s)
    // In the same tick, as `void probeClaudeCliVersion()` ran before.
    expect(versionProbe).toHaveBeenCalledTimes(1)
    expect(claudeStartLookupPending()).toBe(false)
    await awaitClaudeStartLookup()
    await settle()
    expect(h.registryReads).toBe(0)
    expect(order.filter((o) => o.startsWith('lookup'))).toEqual([])
    expect(versionProbe).toHaveBeenCalledTimes(1)
    expect(process.env.PATH).toBe(pathBefore)
    expect(launch()).toEqual({ cmd: 'claude', args: [] })
  })
})

describe('main runs it at start (index.ts)', () => {
  /** The source with its comments removed, so a commented-out line fails. */
  const code = fs.readFileSync(path.join(__dirname, '../../../src/main/index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')

  // Mutation to prove this can fail: put `void probeClaudeCliVersion()` back in its place.
  it('with the registry PATH refresh, the PATH walk and profile lookup, and the version probe; once, after the launch rule is set and before a window exists', () => {
    expect(code).toMatch(/startClaudeLookup\(\{\s*refreshPath: refreshWindowsPath,\s*lookup: \(\) => findClaudeOnWindowsAsync\(process\.env\),\s*versionProbe: \(\) => \{ void probeClaudeCliVersion\(\) \},\s*\}\)/)
    expect(code.split('startClaudeLookup(').length).toBe(2)
    expect(code.split('probeClaudeCliVersion()').length, 'the version probe runs only through it').toBe(2)
    const ruleSet = code.indexOf("setClaudeCliProbeAllowed(() => providerProbeRefusal('claude') === null)")
    const started = code.indexOf('startClaudeLookup(')
    const ready = code.indexOf('app.whenReady()')
    const firstWindow = code.indexOf('createWindow()', ready)
    expect(ruleSet).toBeGreaterThan(-1)
    expect(firstWindow).toBeGreaterThan(-1)
    expect(started).toBeGreaterThan(ruleSet)
    expect(started).toBeLessThan(firstWindow)
  })
})
