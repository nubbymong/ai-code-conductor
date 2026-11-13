// Windows, at start (regression since #638): a launch names Claude Code by its
// full path or starts nothing, and it cannot wait. A tab restored at start was
// launched before this process's PATH was brought up to date and before the
// PowerShell profile had answered, so it said "not found" until Check again.
//
// At start main walks PATH for Claude Code once, as a launch does
// (claude-start-lookup.ts). Found: nothing is held and nothing refreshed, and
// the version probe starts at once, as before the fix. Not found: main brings
// PATH up to date from the registry, looks for Claude Code, then runs the
// version probe; a launch asked for meanwhile waits for all three, bounded,
// then resolves as any launch does. Off Windows nothing is walked, refreshed
// or waited for.
//
// Host-safe: the registry read, the PATH walks' file test, the PowerShell
// profile question and the version probe are stand-ins answered here. Nothing
// is started, no file of this computer is read, and PATH is put back after
// each case. A read, a question or a probe a case left held is answered after
// it, so one failing case never leaves the next one joined to one that does
// not end.
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
  /** The walks of PATH the lookup made (off the event loop), and the ones
   *  made in place (the walk at start, and a launch's). */
  walks: 0,
  walksInPlace: 0,
  /** The version probe: held until released when `holdProbe`. */
  holdProbe: false,
  probeRelease: [] as Array<() => void>,
  /** What was logged. */
  log: [] as string[],
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
    findOnWindowsPath: (names: readonly string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') => {
      h.walksInPlace += 1
      return real.findOnWindowsPath(names, env, (p) => h.present.has(p.toLowerCase()), order)
    },
    findOnWindowsPathAsync: (names: readonly string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') => {
      h.walks += 1
      return real.findOnWindowsPathAsync(names, env, async (p) => h.present.has(p.toLowerCase()), order)
    },
    findWithPowerShellProfile: () => {
      h.profileCalls += 1
      return new Promise<Lookup>((resolve) => {
        h.profileRelease.push(() => resolve(h.profileAnswer ? { outcome: 'found', path: h.profileAnswer } : { outcome: 'none' }))
      })
    },
  }
})
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (line: string) => { h.log.push(`info: ${line}`) },
  logWarn: (line: string) => { h.log.push(`warn: ${line}`) },
  logError: () => {},
}))

const { startClaudeLookup, claudeStartLookupPending, awaitClaudeStartLookup, claudeStartLookupSettled, CLAUDE_START_LOOKUP_WAIT_MS, _resetClaudeStartLookupForTest } =
  await import('../../../src/main/claude-start-lookup')
const { claudeCliProbeAllowed, setClaudeCliProbeAllowed, _resetClaudeCliVersionForTest } = await import('../../../src/main/claude-cli-version')
const { refreshWindowsPath } = await import('../../../src/main/windows-path-refresh')
const { POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS } = await import('../../../src/main/windows-programs')
const { findClaudeOnWindowsAsync, claudeOnWindowsPathNow, setClaudeProfileLookupAllowed, CLAUDE_NOT_ON_PATH, _resetClaudeCliProbeForTest, _resetClaudeWindowsLookupForTest, _resetClaudeLoginShellLookupForTest } =
  await import('../../../src/main/claude-cli-probe')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')

const SYSTEM = 'C:\\Windows\\System32'
const LOCAL_BIN = 'C:\\Users\\me\\.local\\bin'
const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm'
const FNM = 'C:\\Users\\me\\AppData\\Local\\fnm_multishells\\1234_1700000000\\claude.cmd'
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const saved = { path: process.env.PATH, shell: process.env.SHELL }
function restore(name: 'PATH' | 'SHELL', value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
/** The same, while the timers are stand-ins (setImmediate is one then). */
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0) }

/** What main hands the start (index.ts, pinned below), the version probe a stand-in. */
const order: string[] = []
const versionProbe = vi.fn((): Promise<void> => {
  order.push(`version probe on ${process.env.PATH}`)
  if (!h.holdProbe) return Promise.resolve()
  return new Promise<void>((resolve) => { h.probeRelease.push(() => { order.push('version probe answered'); resolve() }) })
})
const steps = () => ({
  onPathNow: () => claudeCliProbeAllowed() && claudeOnWindowsPathNow(process.env) !== null,
  refreshPath: refreshWindowsPath,
  lookup: () => {
    order.push(`lookup on ${process.env.PATH}`)
    return claudeCliProbeAllowed() ? findClaudeOnWindowsAsync(process.env) : Promise.resolve(null)
  },
  versionProbe,
})
/** The start's own log lines (the PATH refresh and the lookups log theirs). */
const startLog = (): string[] => h.log.filter((l) => l.includes('[start]'))
const LAUNCH_GAVE_UP = `info: [start] Still looking for Claude Code after ${CLAUDE_START_LOOKUP_WAIT_MS / 1000} s (PATH from the registry, the first lookup, the version probe); a launch waits no longer and resolves on what is known`
const DISCOVERY_GAVE_UP = `info: [start] PATH from the registry and the first Claude Code lookup still running after ${CLAUDE_START_LOOKUP_WAIT_MS / 1000} s; each provider's CLI is looked for on the PATH there is`
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
  h.walks = 0
  h.walksInPlace = 0
  h.holdProbe = false
  h.probeRelease = []
  h.log = []
  order.length = 0
  versionProbe.mockClear()
  _resetClaudeStartLookupForTest()
  _resetClaudeCliVersionForTest()
  _resetClaudeCliProbeForTest()
  _resetClaudeWindowsLookupForTest()
  _resetClaudeLoginShellLookupForTest()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})
afterEach(async () => {
  vi.useRealTimers()
  // Whatever a case left held is answered, so the next case starts its own.
  for (const r of h.registryRelease.splice(0)) r()
  for (const r of h.profileRelease.splice(0)) r()
  for (const r of h.probeRelease.splice(0)) r()
  await settle()
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  restore('PATH', saved.path)
  restore('SHELL', saved.shell)
})

describe('on Windows, at start, with Claude Code in a folder PATH already names: as before the fix', () => {
  // Mutation to prove this can fail: hold and refresh whatever the walk finds.
  it('nothing is held and PATH is not refreshed; the version probe starts in the same tick, and no launch waits for its answer', async () => {
    process.env.PATH = `${SYSTEM};${NPM}`
    h.registryUser = LOCAL_BIN
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase()])
    h.holdProbe = true
    setClaudeProfileLookupAllowed(() => true)
    startClaudeLookup(steps())
    expect(claudeStartLookupPending(), 'no launch is held').toBe(false)
    // In the same tick, as `void probeClaudeCliVersion()` ran before the fix.
    expect(versionProbe).toHaveBeenCalledTimes(1)
    vi.useFakeTimers()
    const done: string[] = []
    void awaitClaudeStartLookup().then(() => { done.push('launch') })
    void claudeStartLookupSettled().then(() => { done.push('look for each CLI') })
    await flush()
    expect(done, 'while the version probe has not answered').toEqual(['launch', 'look for each CLI'])
    expect(vi.getTimerCount()).toBe(0)
    expect(h.registryReads, 'the registry is not read').toBe(0)
    expect(process.env.PATH).toBe(`${SYSTEM};${NPM}`)
    expect(order, 'no lookup beside the walk').toEqual([`version probe on ${SYSTEM};${NPM}`])
    expect(h.walks).toBe(0)
    expect(h.profileCalls).toBe(0)
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace, 'the launch reads the answer of the walk at start').toBe(1)
    expect(startLog()).toEqual([])
  })

  // Mutation to prove this can fail: let a rejected probe go unhandled.
  it('a version probe that fails then is logged, thrown or rejected, and nothing else follows', async () => {
    process.env.PATH = `${SYSTEM};${NPM}`
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase()])
    startClaudeLookup({ ...steps(), versionProbe: () => { throw new Error('no probe') } })
    startClaudeLookup({ ...steps(), versionProbe: () => Promise.reject(new Error('no answer')) })
    await settle()
    expect(claudeStartLookupPending()).toBe(false)
    expect(h.registryReads).toBe(0)
    expect(startLog()).toEqual([
      'warn: [start] The Claude Code version probe failed (no probe); the version stays unknown',
      'warn: [start] The Claude Code version probe failed (no answer); the version stays unknown',
    ])
  })

  // Mutation to prove this can fail: take a walk that throws for "found".
  it('a walk that throws counts as not found: the start refreshes PATH and looks, and it is logged', async () => {
    process.env.PATH = SYSTEM
    startClaudeLookup({ ...steps(), onPathNow: () => { throw new Error('no walk') } })
    expect(claudeStartLookupPending()).toBe(true)
    await awaitClaudeStartLookup()
    expect(h.registryReads).toBe(1)
    expect(startLog()).toEqual(['warn: [start] The walk of PATH for Claude Code failed (no walk); PATH is brought up to date and Claude Code looked for'])
  })
})

describe('on Windows, at start, with Claude Code in no folder PATH names: PATH from the registry, then the first lookup, then the version probe', () => {
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

  // Mutation to prove this can fail: walk at start as a launch does, profile included.
  it('the walk at start asks the PowerShell profile nothing: that question waits for the PATH the refresh leaves', async () => {
    process.env.PATH = SYSTEM
    h.holdRegistry = true
    setClaudeProfileLookupAllowed(() => true)
    startClaudeLookup(steps())
    await settle()
    expect(h.walksInPlace).toBe(1)
    expect(h.profileCalls, 'not while the registry is read').toBe(0)
    for (const r of h.registryRelease.splice(0)) r()
    await settle()
    expect(h.profileCalls).toBe(1)
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

  // Mutation to prove this can fail: release the launches when the lookup
  // ends, before the version probe has answered.
  it('a launch is released only once the version probe has answered, so it never reports the version as not yet verified because it was held', async () => {
    process.env.PATH = SYSTEM
    h.registryUser = LOCAL_BIN
    h.present = new Set([`${LOCAL_BIN}\\claude.exe`.toLowerCase()])
    h.holdProbe = true
    startClaudeLookup(steps())
    void awaitClaudeStartLookup().then(() => { order.push('launch released') })
    await settle()
    expect(order, 'the probe runs, the launch still waits').toEqual([`lookup on ${SYSTEM};${LOCAL_BIN}`, `version probe on ${SYSTEM};${LOCAL_BIN}`])
    expect(claudeStartLookupPending()).toBe(true)
    for (const r of h.probeRelease.splice(0)) r()
    await settle()
    expect(order).toEqual([`lookup on ${SYSTEM};${LOCAL_BIN}`, `version probe on ${SYSTEM};${LOCAL_BIN}`, 'version probe answered', 'launch released'])
    expect(claudeStartLookupPending()).toBe(false)
  })

  // Mutation to prove this can fail: wait without a bound.
  it('the wait is bounded, by more than the profile question may take; past it the launch is refused exactly as before, never by a bare name', async () => {
    // A registry read, a profile question (POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS
    // at most) and the version probe have to fit.
    expect(CLAUDE_START_LOOKUP_WAIT_MS).toBeGreaterThanOrEqual(POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS + 2000)
    expect(CLAUDE_START_LOOKUP_WAIT_MS).toBeLessThanOrEqual(20_000)
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

  // Mutation to prove this can fail: release only the first launch waiting.
  it('every launch waiting is released together (several tabs restored at start), and one asked for after that does not wait', async () => {
    process.env.PATH = SYSTEM
    h.registryUser = LOCAL_BIN
    h.present = new Set([`${LOCAL_BIN}\\claude.exe`.toLowerCase()])
    h.holdRegistry = true
    startClaudeLookup(steps())
    await settle()
    const released: number[] = []
    const tabs = [1, 2, 3].map((n) => awaitClaudeStartLookup().then(() => { released.push(n) }))
    await settle()
    expect(released, 'none before the start has answered').toEqual([])
    for (const r of h.registryRelease.splice(0)) r()
    await settle()
    expect(released).toEqual([1, 2, 3])
    await Promise.all(tabs)
    expect(launch()).toEqual({ cmd: `${LOCAL_BIN}\\claude.exe`, args: [] })
    vi.useFakeTimers()
    let later = false
    void awaitClaudeStartLookup().then(() => { later = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(later).toBe(true)
    expect(vi.getTimerCount(), 'and it set no timer').toBe(0)
  })

  // Mutation to prove this can fail: leave the bound's timer running after the release.
  it('a launch released by the start leaves no timer behind, and nothing is logged about a wait that ended in time', async () => {
    process.env.PATH = SYSTEM
    h.holdRegistry = true
    startClaudeLookup(steps())
    await settle()
    vi.useFakeTimers()
    const waited = awaitClaudeStartLookup()
    expect(vi.getTimerCount()).toBe(1)
    for (const r of h.registryRelease.splice(0)) r()
    await waited
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(CLAUDE_START_LOOKUP_WAIT_MS * 2)
    expect(startLog()).toEqual([])
  })

  // Mutations to prove this can fail: let the launches after one that waited
  // out the bound go at once; log each wait the bound ends.
  it('every launch during a slow start waits, each by its own bound, a retry of a refused tab too; the bound is logged once', async () => {
    process.env.PATH = SYSTEM
    setClaudeProfileLookupAllowed(() => true)
    startClaudeLookup(steps())
    await settle()
    vi.useFakeTimers()
    const done: string[] = []
    void awaitClaudeStartLookup().then(() => { done.push('first') })
    void awaitClaudeStartLookup().then(() => { done.push('second') })
    await vi.advanceTimersByTimeAsync(CLAUDE_START_LOOKUP_WAIT_MS)
    expect(done).toEqual(['first', 'second'])
    expect(claudeStartLookupPending(), 'the profile has still not answered').toBe(true)
    // A retry of the refused tab waits again, its own bound.
    void awaitClaudeStartLookup().then(() => { done.push('retry') })
    await vi.advanceTimersByTimeAsync(CLAUDE_START_LOOKUP_WAIT_MS - 1)
    expect(done, 'not at once, and not before its bound').toEqual(['first', 'second'])
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toEqual(['first', 'second', 'retry'])
    expect(startLog(), 'three waits ended by the bound, one line').toEqual([LAUNCH_GAVE_UP])
    // One more, and the answer comes while it waits: it starts on that answer.
    void awaitClaudeStartLookup().then(() => { done.push('in time') })
    await vi.advanceTimersByTimeAsync(1000)
    expect(done).toEqual(['first', 'second', 'retry'])
    h.profileAnswer = FNM
    for (const r of h.profileRelease.splice(0)) r()
    await flush()
    expect(done).toEqual(['first', 'second', 'retry', 'in time'])
    expect(claudeStartLookupPending()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(launch()).toEqual({ cmd: FNM, args: [] })
    expect(startLog()).toEqual([LAUNCH_GAVE_UP])
  })

  // Mutation to prove this can fail: let a failed refresh skip the lookup (drop the catch after it).
  it('a refresh that fails does not stop the lookup, and is logged', async () => {
    const lookup = vi.fn(() => Promise.resolve(null))
    startClaudeLookup({ onPathNow: () => false, refreshPath: () => Promise.reject(new Error('no registry')), lookup, versionProbe })
    expect(claudeStartLookupPending()).toBe(true)
    await awaitClaudeStartLookup()
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(claudeStartLookupPending()).toBe(false)
    expect(versionProbe).toHaveBeenCalledTimes(1)
    expect(startLog()).toEqual(['warn: [start] PATH was not brought up to date from the registry (no registry); Claude Code is looked for on the PATH there is'])
  })

  // Mutation to prove this can fail: log nothing in the catches.
  it('a refresh, a lookup and a version probe that all fail still let launches go; each is logged', async () => {
    const lookup = vi.fn(() => Promise.reject(new Error('no walk')))
    const throwing = vi.fn((): Promise<void> => { throw new Error('no probe') })
    startClaudeLookup({ onPathNow: () => false, refreshPath: () => Promise.reject(new Error('no registry')), lookup, versionProbe: throwing })
    expect(claudeStartLookupPending()).toBe(true)
    await awaitClaudeStartLookup()
    await settle()
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(claudeStartLookupPending()).toBe(false)
    expect(throwing).toHaveBeenCalledTimes(1)
    expect(startLog()).toEqual([
      'warn: [start] PATH was not brought up to date from the registry (no registry); Claude Code is looked for on the PATH there is',
      'warn: [start] The first Claude Code lookup failed (no walk); a launch looks for itself',
      'warn: [start] The Claude Code version probe failed (no probe); the version stays unknown',
    ])
  })

  // Mutation to prove this can fail: walk PATH whatever the launch rule says.
  it('while Claude Code is switched off PATH is still brought up to date, but nothing looks for Claude Code', async () => {
    process.env.PATH = `${SYSTEM};${NPM}`
    h.registryUser = LOCAL_BIN
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase()])
    setClaudeCliProbeAllowed(() => false)
    startClaudeLookup(steps())
    await awaitClaudeStartLookup()
    expect(process.env.PATH).toBe(`${SYSTEM};${NPM};${LOCAL_BIN}`)
    expect(h.walksInPlace, 'not the walk at start').toBe(0)
    expect(h.walks, 'nor the lookup').toBe(0)
    expect(h.profileCalls).toBe(0)
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

describe('what at start reads PATH and nothing waits for (the look for each provider\'s CLI)', () => {
  // Mutations to prove this can fail: answer at once; answer at once when a
  // launch has already waited out its bound.
  it('runs after the start\'s PATH refresh and first lookup, on the PATH they leave, also when a launch gave up before it asked', async () => {
    process.env.PATH = SYSTEM
    h.registryUser = LOCAL_BIN
    h.holdRegistry = true
    startClaudeLookup(steps())
    await settle()
    vi.useFakeTimers()
    let launchGaveUp = false
    void awaitClaudeStartLookup().then(() => { launchGaveUp = true })
    await vi.advanceTimersByTimeAsync(CLAUDE_START_LOOKUP_WAIT_MS)
    expect(launchGaveUp).toBe(true)
    let discoveredOn: string | undefined
    void claudeStartLookupSettled().then(() => { discoveredOn = process.env.PATH })
    await vi.advanceTimersByTimeAsync(CLAUDE_START_LOOKUP_WAIT_MS - 1)
    expect(discoveredOn, 'not while the registry is read: a launch that gave up does not end its wait').toBeUndefined()
    for (const r of h.registryRelease.splice(0)) r()
    await flush()
    expect(discoveredOn).toBe(`${SYSTEM};${LOCAL_BIN}`)
    expect(vi.getTimerCount(), 'its own timer is cleared').toBe(0)
    expect(startLog(), 'only the launch gave up').toEqual([LAUNCH_GAVE_UP])
  })

  // Mutation to prove this can fail: wait without a bound.
  it('its wait has the same bound as a launch\'s: past it the look runs on the PATH there is, so no provider stays "not checked yet" for longer, and it is logged', async () => {
    process.env.PATH = SYSTEM
    h.registryUser = LOCAL_BIN
    h.holdRegistry = true
    startClaudeLookup(steps())
    await settle()
    vi.useFakeTimers()
    let discoveredOn: string | undefined
    void claudeStartLookupSettled().then(() => { discoveredOn = process.env.PATH })
    await vi.advanceTimersByTimeAsync(CLAUDE_START_LOOKUP_WAIT_MS - 1)
    expect(discoveredOn).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(discoveredOn, 'the registry is still being read').toBe(SYSTEM)
    expect(claudeStartLookupPending()).toBe(true)
    expect(startLog()).toEqual([DISCOVERY_GAVE_UP])
  })

  // Mutation to prove this can fail: release it with the launches, after the version probe.
  it('it does not wait for the version probe, which only a launch waits for', async () => {
    process.env.PATH = SYSTEM
    h.registryUser = LOCAL_BIN
    h.holdProbe = true
    startClaudeLookup(steps())
    let discoveredOn: string | undefined
    void claudeStartLookupSettled().then(() => { discoveredOn = process.env.PATH })
    await settle()
    expect(discoveredOn).toBe(`${SYSTEM};${LOCAL_BIN}`)
    expect(order).toEqual([`lookup on ${SYSTEM};${LOCAL_BIN}`, `version probe on ${SYSTEM};${LOCAL_BIN}`])
    expect(claudeStartLookupPending(), 'the probe has not answered: launches are still held').toBe(true)
  })

  it('at once when the start has answered, when nothing started it, and off Windows', async () => {
    let n = 0
    void claudeStartLookupSettled().then(() => { n += 1 })
    await Promise.resolve()
    expect(n, 'nothing started it').toBe(1)
    process.env.PATH = SYSTEM
    startClaudeLookup(steps())
    await settle()
    void claudeStartLookupSettled().then(() => { n += 1 })
    await Promise.resolve()
    expect(n, 'the start has answered').toBe(2)
    _resetClaudeStartLookupForTest()
    startClaudeLookup(steps(), 'linux')
    void claudeStartLookupSettled().then(() => { n += 1 })
    await Promise.resolve()
    expect(n, 'off Windows').toBe(3)
  })
})

describe('off Windows nothing changes', () => {
  it('no walk at start, no registry read, no lookup, nothing to wait for; the version probe runs at once and a launch names "claude"', async () => {
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
    expect(h.walksInPlace).toBe(0)
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

  // Mutations to prove this can fail: put `void probeClaudeCliVersion()` back
  // in its place; hand it a version probe that returns nothing to wait for;
  // walk at start while Claude Code is switched off.
  it('with the walk of PATH, the registry PATH refresh, the PATH walk and profile lookup, and the version probe it can wait for; once, after the launch rule is set and before a window exists', () => {
    expect(code).toMatch(/startClaudeLookup\(\{\s*onPathNow: \(\) => claudeCliProbeAllowed\(\) && claudeOnWindowsPathNow\(process\.env\) !== null,\s*refreshPath: refreshWindowsPath,\s*lookup: \(\) => \(claudeCliProbeAllowed\(\) \? findClaudeOnWindowsAsync\(process\.env\) : Promise\.resolve\(null\)\),\s*versionProbe: \(\) => probeClaudeCliVersion\(\),\s*\}\)/)
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

  // Mutation to prove this can fail: call discoverProvidersAtStart straight after the accounts start-up work.
  it('and the look for each provider\'s CLI at start comes after it, by the module\'s own bound, in the same turn that starts it', () => {
    expect(code).toMatch(/\.then\(\(\) => claudeStartLookupSettled\(\)\)\s*\.then\(\(\) => discoverProvidersAtStart\(\)\)/)
    expect(code.split('discoverProvidersAtStart()').length, 'nothing else starts it').toBe(2)
    // Nothing between the chain and the start waits, so the start is under
    // way before the chain's first step can answer.
    const ready = code.indexOf('app.whenReady().then(() => {')
    const chained = code.indexOf('claudeStartLookupSettled()')
    const started = code.indexOf('startClaudeLookup(')
    expect(ready).toBeGreaterThan(-1)
    expect(chained).toBeGreaterThan(ready)
    expect(started).toBeGreaterThan(chained)
    expect(code.slice(chained, started)).not.toMatch(/\bawait\b/)
  })
})

describe('the walk of PATH at start (claude-cli-probe.ts claudeOnWindowsPathNow)', () => {
  // Mutation to prove this can fail: walk folder by folder (a claude.cmd in an earlier folder wins).
  it('names what a launch names (claude.exe in any folder before claude.cmd), keeps its answer for the launch, and asks the profile nothing', () => {
    process.env.PATH = `${NPM};${LOCAL_BIN}`
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase(), `${LOCAL_BIN}\\claude.exe`.toLowerCase()])
    setClaudeProfileLookupAllowed(() => true)
    expect(claudeOnWindowsPathNow(process.env)).toBe(`${LOCAL_BIN}\\claude.exe`)
    expect(launch()).toEqual({ cmd: `${LOCAL_BIN}\\claude.exe`, args: [] })
    expect(h.walksInPlace, 'the launch did not walk again').toBe(1)
    process.env.PATH = SYSTEM
    expect(claudeOnWindowsPathNow(process.env)).toBeNull()
    expect(h.profileCalls).toBe(0)
  })
})
