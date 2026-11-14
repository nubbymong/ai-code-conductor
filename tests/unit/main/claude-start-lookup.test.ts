// Windows, at start (regression since #638): a launch names Claude Code by its
// full path or starts nothing, and it cannot wait. A tab restored at start was
// launched before this process's PATH was brought up to date and before the
// PowerShell profile had answered, so it said "not found" until Check again.
//
// At start, with Claude Code switched on, main marks the start pending and
// walks PATH for Claude Code once, in a launch's order but off its own thread
// (claude-start-lookup.ts). Found: nothing more is held and nothing refreshed,
// and the version probe starts at once. Not found: main brings PATH up to
// date from the registry, looks for Claude Code, then runs the version probe;
// a launch asked for meanwhile waits for all three, bounded, then resolves as
// any launch does. One deadline ends the whole start. While Claude Code is
// switched off, and off Windows, nothing is walked, refreshed or waited for.
//
// Host-safe: the registry read, the PATH walks' file test, the PowerShell
// profile question and the version probe are stand-ins answered here. Nothing
// is started, no file of this computer is read, and PATH is put back after
// each case. A walk, a read, a question or a probe a case left held is
// answered after it, so one failing case never leaves the next one joined to
// one that does not end.
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
  /** The walks of PATH made off the event loop (the walk at start, and the
   *  lookup's), and the ones made in place (a launch's). */
  walks: 0,
  walksInPlace: 0,
  /** A file test of a walk off the event loop waits for this (a PATH folder
   *  on a share that does not answer), until `openWalk`. */
  walkGate: null as Promise<void> | null,
  openWalk: (): void => {},
  /** The version probe: held until released when `holdProbe`. */
  holdProbe: false,
  probeRelease: [] as Array<() => void>,
  /** What was logged; `logThrows` makes the logger throw instead. */
  log: [] as string[],
  logThrows: false,
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
      return real.findOnWindowsPathAsync(names, env, async (p) => {
        if (h.walkGate) await h.walkGate
        return h.present.has(p.toLowerCase())
      }, order)
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
  logInfo: (line: string) => { if (h.logThrows) throw new Error('log boom'); h.log.push(`info: ${line}`) },
  logWarn: (line: string) => { if (h.logThrows) throw new Error('log boom'); h.log.push(`warn: ${line}`) },
  logError: () => {},
}))

const { startClaudeLookup, startClaudeAtBoot, claudeStartLookupPending, awaitClaudeStartLookup, claudeStartLookupSettled, CLAUDE_START_LOOKUP_WAIT_MS, CLAUDE_START_DEADLINE_MS, _resetClaudeStartLookupForTest } =
  await import('../../../src/main/claude-start-lookup')
type Boot = import('../../../src/main/claude-start-lookup').ClaudeStartAtBoot
type Steps = import('../../../src/main/claude-start-lookup').ClaudeStartLookupSteps
const { claudeCliProbeAllowed, setClaudeCliProbeAllowed, _resetClaudeCliVersionForTest } = await import('../../../src/main/claude-cli-version')
const { refreshWindowsPath } = await import('../../../src/main/windows-path-refresh')
const { POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS } = await import('../../../src/main/windows-programs')
const { findClaudeOnWindowsAsync, claudeOnWindowsPathAsync, setClaudeProfileLookupAllowed, CLAUDE_NOT_ON_PATH, _resetClaudeCliProbeForTest, _resetClaudeWindowsLookupForTest, _resetClaudeLoginShellLookupForTest } =
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

/** What main hands the start (index.ts, pinned below): the real walk, refresh
 *  and lookup; the version probe and the look for each provider's CLI are
 *  stand-ins. */
const order: string[] = []
const versionProbe = vi.fn((): Promise<void> => {
  order.push(`version probe on ${process.env.PATH}`)
  if (!h.holdProbe) return Promise.resolve()
  return new Promise<void>((resolve) => { h.probeRelease.push(() => { order.push('version probe answered'); resolve() }) })
})
const discover = vi.fn((): void => { order.push(`look for each CLI on ${process.env.PATH}`) })
const boot = (over: Partial<Boot> = {}): Boot => ({
  claudeOn: claudeCliProbeAllowed,
  env: process.env,
  walkPath: claudeOnWindowsPathAsync,
  refreshPath: refreshWindowsPath,
  findClaude: (env) => {
    order.push(`lookup on ${env.PATH}`)
    return findClaudeOnWindowsAsync(env)
  },
  versionProbe,
  accountsWork: null,
  discover,
  ...over,
})
/** The start's steps by hand: Claude Code switched on and in no folder PATH names. */
const stepsNotFound = (over: Partial<Steps> = {}): Steps => ({
  claudeOn: () => true,
  onPath: () => Promise.resolve(false),
  refreshPath: () => Promise.resolve(),
  lookup: () => Promise.resolve(null),
  versionProbe,
  ...over,
})
/** Hold the file tests of the walks off the event loop until `h.openWalk()`. */
function holdTheWalk(): void {
  h.walkGate = new Promise<void>((resolve) => { h.openWalk = () => { h.walkGate = null; resolve() } })
}
/** The start's own log lines (the PATH refresh and the lookups log theirs). */
const startLog = (): string[] => h.log.filter((l) => l.includes('[start]'))
const LAUNCH_GAVE_UP = `info: [start] Still looking for Claude Code after ${CLAUDE_START_LOOKUP_WAIT_MS / 1000} s (PATH from the registry, the first lookup, the version probe); a launch waits no longer and resolves on what is known`
const DISCOVERY_GAVE_UP = `info: [start] PATH from the registry and the first Claude Code lookup still running after ${CLAUDE_START_LOOKUP_WAIT_MS / 1000} s; each provider's CLI is looked for on the PATH there is`
const START_GAVE_UP = `info: [start] The look for Claude Code at start has not ended after ${CLAUDE_START_DEADLINE_MS / 1000} s; no launch is held for it any longer, and each resolves on what is known`
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
  h.logThrows = false
  h.walkGate = null
  h.openWalk = () => {}
  order.length = 0
  versionProbe.mockClear()
  discover.mockClear()
  _resetClaudeStartLookupForTest()
  _resetClaudeCliVersionForTest()
  _resetClaudeCliProbeForTest()
  _resetClaudeWindowsLookupForTest()
  _resetClaudeLoginShellLookupForTest()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})
afterEach(async () => {
  vi.useRealTimers()
  h.logThrows = false
  // The start a case left running changes nothing from here on, and its
  // deadline is cleared.
  _resetClaudeStartLookupForTest()
  // Whatever a case left held is answered, so the next case starts its own.
  h.openWalk()
  for (const r of h.registryRelease.splice(0)) r()
  for (const r of h.profileRelease.splice(0)) r()
  for (const r of h.probeRelease.splice(0)) r()
  await settle()
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  restore('PATH', saved.path)
  restore('SHELL', saved.shell)
})

describe('on Windows, at start, with Claude Code in a folder PATH already names', () => {
  // Mutations to prove this can fail: walk in place, on the caller's turn;
  // hold and refresh whatever the walk finds; start the version probe a turn
  // after the launches are let go; let the walk at start keep no answer.
  it('the start is pending only while PATH is walked, off main\'s own turn; then nothing is held, PATH is not refreshed, and the version probe starts at once with no launch waiting for its answer', async () => {
    process.env.PATH = `${SYSTEM};${NPM}`
    h.registryUser = LOCAL_BIN
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase()])
    h.holdProbe = true
    holdTheWalk()
    setClaudeProfileLookupAllowed(() => true)
    vi.useFakeTimers()
    startClaudeAtBoot(boot())
    // Before the call returns: pending, and no folder read on the caller's turn.
    expect(claudeStartLookupPending(), 'pending first').toBe(true)
    expect(h.walksInPlace, 'no walk in place').toBe(0)
    expect(h.walks, 'the walk off the event loop has begun').toBe(1)
    expect(versionProbe).not.toHaveBeenCalled()
    const done: string[] = []
    let probesWhenReleased = -1
    void awaitClaudeStartLookup().then(() => { probesWhenReleased = versionProbe.mock.calls.length; done.push('launch') })
    void claudeStartLookupSettled().then(() => { done.push('look for each CLI') })
    await flush()
    expect(done, 'both wait while PATH is walked').toEqual([])
    expect(vi.getTimerCount(), 'the deadline and the two waits').toBe(3)
    h.openWalk()
    await flush()
    expect(claudeStartLookupPending(), 'found: no launch is held').toBe(false)
    expect(done, 'while the version probe has not answered').toEqual(['launch', 'look for each CLI'])
    expect(versionProbe).toHaveBeenCalledTimes(1)
    expect(probesWhenReleased, 'the probe had started when the launch was let go').toBe(1)
    expect(vi.getTimerCount(), 'the deadline is cleared with the waits').toBe(0)
    expect(h.registryReads, 'the registry is not read').toBe(0)
    expect(process.env.PATH).toBe(`${SYSTEM};${NPM}`)
    expect(order, 'no lookup beside the walk').toEqual([`version probe on ${SYSTEM};${NPM}`])
    expect(h.walks).toBe(1)
    expect(h.profileCalls).toBe(0)
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace, 'the launch reads the answer the walk at start kept: it walks nothing in place').toBe(0)
    expect(startLog()).toEqual([])
  })

  // Mutation to prove this can fail: let a rejected probe go unhandled.
  it('a version probe that fails then is logged, thrown or rejected, and nothing else follows', async () => {
    const found = (probe: () => Promise<unknown>): Steps => stepsNotFound({ onPath: () => Promise.resolve(true), refreshPath: refreshWindowsPath, versionProbe: probe })
    startClaudeLookup(found(() => { throw new Error('no probe') }))
    await settle()
    expect(claudeStartLookupPending()).toBe(false)
    startClaudeLookup(found(() => Promise.reject(new Error('no answer'))))
    await settle()
    expect(claudeStartLookupPending()).toBe(false)
    expect(h.registryReads).toBe(0)
    expect(startLog()).toEqual([
      'warn: [start] The Claude Code version probe failed (no probe); the version stays unknown',
      'warn: [start] The Claude Code version probe failed (no answer); the version stays unknown',
    ])
  })

  // Mutation to prove this can fail: take a walk that fails for "found".
  it.each([
    ['throws', (): Promise<boolean> => { throw new Error('no walk') }],
    ['rejects', (): Promise<boolean> => Promise.reject(new Error('no walk'))],
  ])('a walk that %s counts as not found: the start refreshes PATH and looks, and it is logged', async (_how, onPath) => {
    process.env.PATH = SYSTEM
    startClaudeLookup(stepsNotFound({ onPath, refreshPath: refreshWindowsPath }))
    expect(claudeStartLookupPending()).toBe(true)
    await awaitClaudeStartLookup()
    expect(h.registryReads).toBe(1)
    expect(versionProbe).toHaveBeenCalledTimes(1)
    expect(startLog()).toEqual(['warn: [start] The walk of PATH for Claude Code failed (no walk); PATH is brought up to date and Claude Code looked for'])
  })

  // The MAJOR of the ADR-009 pass on a31b84ff: the walk at start was made in
  // place, before any window, and a PATH folder on a share that is down holds
  // such a file test for tens of seconds.
  // Mutation to prove this can fail: walk in place at start.
  it('a walk that does not answer (a PATH folder on a share that is down) does not hold main: the call returns at once, and a launch waits its bound, then looks for itself as before the fix', async () => {
    process.env.PATH = `${SYSTEM};${NPM}`
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase()])
    holdTheWalk()
    vi.useFakeTimers()
    startClaudeAtBoot(boot())
    expect(claudeStartLookupPending()).toBe(true)
    expect(h.walksInPlace, 'no file test on the caller\'s turn').toBe(0)
    let waited = false
    void awaitClaudeStartLookup().then(() => { waited = true })
    await vi.advanceTimersByTimeAsync(CLAUDE_START_LOOKUP_WAIT_MS - 1)
    expect(waited).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(waited).toBe(true)
    expect(claudeStartLookupPending(), 'the walk still has not answered').toBe(true)
    expect(versionProbe).not.toHaveBeenCalled()
    // Past the bound the launch resolves on what is known: no answer was
    // kept, so it walks for itself, in place, as every launch did before.
    expect(launch()).toEqual({ cmd: `${NPM}\\claude.cmd`, args: [] })
    expect(h.walksInPlace).toBe(1)
    expect(startLog()).toEqual([LAUNCH_GAVE_UP])
  })
})

describe('on Windows, at start, with Claude Code in no folder PATH names: PATH from the registry, then the first lookup, then the version probe', () => {
  // Mutation to prove this can fail: start the lookup without the refresh.
  it('brings PATH up to date once, before the lookup; a launch that waited names the claude.exe in the folder it added', async () => {
    process.env.PATH = SYSTEM
    h.registryUser = LOCAL_BIN
    h.present = new Set([`${LOCAL_BIN}\\claude.exe`.toLowerCase()])
    h.holdRegistry = true
    startClaudeAtBoot(boot())
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
    expect(h.walksInPlace, 'the launch read the lookup\'s answer').toBe(0)
    expect(h.profileCalls, 'found on PATH: the profile is not asked').toBe(0)
  })

  // Mutation to prove this can fail: walk at start as a check does, profile included.
  it('the walk at start asks the PowerShell profile nothing: that question waits for the PATH the refresh leaves', async () => {
    process.env.PATH = SYSTEM
    h.holdRegistry = true
    setClaudeProfileLookupAllowed(() => true)
    startClaudeAtBoot(boot())
    await settle()
    expect(h.walks, 'the walk at start').toBe(1)
    expect(h.walksInPlace).toBe(0)
    expect(h.profileCalls, 'not while the registry is read').toBe(0)
    for (const r of h.registryRelease.splice(0)) r()
    await settle()
    expect(h.walks, 'and the lookup\'s').toBe(2)
    expect(h.profileCalls).toBe(1)
  })

  // Mutation to prove this can fail: end the wait when the PATH refresh ends.
  it('a launch waits for the PowerShell profile\'s first answer too, and names the path it gave', async () => {
    process.env.PATH = SYSTEM
    setClaudeProfileLookupAllowed(() => true)
    startClaudeAtBoot(boot())
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
    startClaudeAtBoot(boot())
    void awaitClaudeStartLookup().then(() => { order.push('launch released') })
    await settle()
    expect(order, 'the probe runs, the launch still waits').toEqual([`lookup on ${SYSTEM};${LOCAL_BIN}`, `version probe on ${SYSTEM};${LOCAL_BIN}`])
    expect(claudeStartLookupPending()).toBe(true)
    for (const r of h.probeRelease.splice(0)) r()
    await settle()
    expect(order).toEqual([`lookup on ${SYSTEM};${LOCAL_BIN}`, `version probe on ${SYSTEM};${LOCAL_BIN}`, 'version probe answered', 'launch released'])
    expect(claudeStartLookupPending()).toBe(false)
  })

  // Mutations to prove this can fail: wait without a bound; another bound
  // than the 15 s decided.
  it('the wait is bounded: 15 s, more than the profile question may take; past it the launch is refused exactly as before, never by a bare name', async () => {
    // The bound is a cap, not a sum of limits. In the usual case a registry
    // read, a profile question (POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS at most)
    // and the version probe end within it; each has a longer limit of its
    // own, and past the bound a launch resolves on what is known.
    expect(CLAUDE_START_LOOKUP_WAIT_MS).toBeGreaterThanOrEqual(POWERSHELL_PROFILE_LOOKUP_TIMEOUT_MS + 2000)
    expect(CLAUDE_START_LOOKUP_WAIT_MS).toBeLessThanOrEqual(20_000)
    expect(CLAUDE_START_LOOKUP_WAIT_MS).toBe(15_000)
    process.env.PATH = SYSTEM
    setClaudeProfileLookupAllowed(() => true)
    vi.useFakeTimers()
    startClaudeAtBoot(boot())
    await flush()
    expect(h.profileCalls, 'the profile is being asked').toBe(1)
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
    startClaudeAtBoot(boot())
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

  // Mutations to prove this can fail: leave the bound's timer running after
  // the release; leave the deadline's timer running after the start ended.
  it('a start that ends in time leaves no timer behind, the deadline\'s and a released launch\'s, and nothing is logged about either', async () => {
    process.env.PATH = SYSTEM
    h.holdRegistry = true
    vi.useFakeTimers()
    startClaudeAtBoot(boot())
    await flush()
    expect(vi.getTimerCount(), 'the deadline').toBe(1)
    const waited = awaitClaudeStartLookup()
    expect(vi.getTimerCount(), 'and the launch\'s bound').toBe(2)
    for (const r of h.registryRelease.splice(0)) r()
    await flush()
    await waited
    expect(claudeStartLookupPending()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(CLAUDE_START_DEADLINE_MS * 2)
    expect(startLog()).toEqual([])
  })

  // Mutations to prove this can fail: let the launches after one that waited
  // out the bound go at once; log each wait the bound ends.
  it('every launch during a slow start waits, each by its own bound, a retry of a refused tab too; the bound is logged once', async () => {
    process.env.PATH = SYSTEM
    setClaudeProfileLookupAllowed(() => true)
    vi.useFakeTimers()
    startClaudeAtBoot(boot())
    await flush()
    expect(h.profileCalls, 'the profile is being asked, and does not answer').toBe(1)
    const done: string[] = []
    void awaitClaudeStartLookup().then(() => { done.push('first') })
    void awaitClaudeStartLookup().then(() => { done.push('second') })
    await vi.advanceTimersByTimeAsync(5000)
    // A retry of a tab, 5 s in: its own bound, not the first one's.
    void awaitClaudeStartLookup().then(() => { done.push('retry') })
    await vi.advanceTimersByTimeAsync(CLAUDE_START_LOOKUP_WAIT_MS - 5000)
    expect(done).toEqual(['first', 'second'])
    expect(claudeStartLookupPending(), 'the profile has still not answered').toBe(true)
    await vi.advanceTimersByTimeAsync(5000 - 1)
    expect(done, 'not with the first two, and not before its bound').toEqual(['first', 'second'])
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
    startClaudeLookup(stepsNotFound({ refreshPath: () => Promise.reject(new Error('no registry')), lookup }))
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
    startClaudeLookup(stepsNotFound({ refreshPath: () => Promise.reject(new Error('no registry')), lookup, versionProbe: throwing }))
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

  // Mutation to prove this can fail: look for Claude Code whatever the launch rule says by then.
  it('Claude Code switched off while the registry is read is not looked for after it; the launches are still let go', async () => {
    process.env.PATH = SYSTEM
    h.registryUser = LOCAL_BIN
    h.present = new Set([`${LOCAL_BIN}\\claude.exe`.toLowerCase()])
    h.holdRegistry = true
    setClaudeProfileLookupAllowed(() => true)
    startClaudeAtBoot(boot())
    await settle()
    expect(h.walks, 'the walk at start').toBe(1)
    setClaudeCliProbeAllowed(() => false)
    for (const r of h.registryRelease.splice(0)) r()
    await awaitClaudeStartLookup()
    expect(order.filter((o) => o.startsWith('lookup'))).toEqual([])
    expect(h.walks, 'no second walk').toBe(1)
    expect(h.profileCalls).toBe(0)
    expect(versionProbe, 'the probe decides for itself by the same rule').toHaveBeenCalledTimes(1)
    expect(claudeStartLookupPending()).toBe(false)
  })

  it('once the start has answered, nothing waits', async () => {
    process.env.PATH = SYSTEM
    startClaudeAtBoot(boot())
    await settle()
    expect(claudeStartLookupPending()).toBe(false)
    vi.useFakeTimers()
    let waited = false
    void awaitClaudeStartLookup().then(() => { waited = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(waited).toBe(true)
  })
})

describe('one deadline for the whole start', () => {
  // Mutations to prove this can fail: no deadline; a deadline that leaves the
  // start pending; one that releases the launches only; another length.
  it('when it passes nothing is held any longer: every wait ends, it is logged once, and a launch after it does not wait, though a step still runs', async () => {
    expect(CLAUDE_START_DEADLINE_MS).toBe(2 * CLAUDE_START_LOOKUP_WAIT_MS)
    process.env.PATH = SYSTEM
    h.registryUser = LOCAL_BIN
    h.holdRegistry = true
    vi.useFakeTimers()
    startClaudeAtBoot(boot())
    await flush()
    // Asked for 20 s in: by their own bound these would wait until 35 s.
    await vi.advanceTimersByTimeAsync(20_000)
    const done: string[] = []
    void awaitClaudeStartLookup().then(() => { done.push('launch') })
    void claudeStartLookupSettled().then(() => { done.push('look for each CLI') })
    await vi.advanceTimersByTimeAsync(CLAUDE_START_DEADLINE_MS - 20_000 - 1)
    expect(done).toEqual([])
    expect(claudeStartLookupPending()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toEqual(['launch', 'look for each CLI'])
    expect(claudeStartLookupPending(), 'no longer pending').toBe(false)
    expect(startLog()).toEqual([START_GAVE_UP])
    expect(vi.getTimerCount(), 'the two waits\' own timers are cleared').toBe(0)
    // Later ones do not wait again, and set no timer.
    void awaitClaudeStartLookup().then(() => { done.push('later launch') })
    void claudeStartLookupSettled().then(() => { done.push('later look') })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toEqual(['launch', 'look for each CLI', 'later launch', 'later look'])
    expect(vi.getTimerCount()).toBe(0)
    expect(order, 'nothing was skipped ahead: the registry is still being read').toEqual([])
    // The step that was slow answers at last: the rest still runs, nothing
    // is held again and nothing more is said.
    for (const r of h.registryRelease.splice(0)) r()
    await flush()
    expect(order).toEqual([`lookup on ${SYSTEM};${LOCAL_BIN}`, `version probe on ${SYSTEM};${LOCAL_BIN}`])
    expect(claudeStartLookupPending()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(startLog()).toEqual([START_GAVE_UP])
  })

  // Mutation to prove this can fail: keep the app running for a timer.
  it('neither the deadline nor a launch\'s bound keeps the app from quitting', () => {
    const set = vi.spyOn(globalThis, 'setTimeout')
    try {
      startClaudeLookup(stepsNotFound({ onPath: () => new Promise<boolean>(() => {}) }))
      void awaitClaudeStartLookup()
      const timerFor = (ms: number): { hasRef: () => boolean } | undefined => {
        const i = set.mock.calls.findIndex((c) => c[1] === ms)
        return i < 0 ? undefined : set.mock.results[i].value as { hasRef: () => boolean }
      }
      expect(timerFor(CLAUDE_START_DEADLINE_MS)?.hasRef(), 'the deadline').toBe(false)
      expect(timerFor(CLAUDE_START_LOOKUP_WAIT_MS)?.hasRef(), 'a launch\'s bound').toBe(false)
    } finally {
      set.mockRestore()
    }
  })
})

describe('started again', () => {
  // Main starts once. A test starts again, and what the earlier start still
  // had running must not end the later one's holds.
  // Mutation to prove this can fail: let any start's end clear what is held.
  it('a start begun again is not ended by a step of the earlier one that answers late; the earlier one\'s waits are let go', async () => {
    let earlierAnswers = (): void => {}
    startClaudeLookup(stepsNotFound({ refreshPath: () => new Promise<void>((resolve) => { earlierAnswers = resolve }) }))
    await settle()
    let earlierWait = false
    void awaitClaudeStartLookup().then(() => { earlierWait = true })
    startClaudeLookup(stepsNotFound({ onPath: () => new Promise<boolean>(() => {}) }))
    await settle()
    expect(earlierWait, 'a wait on the earlier start').toBe(true)
    expect(claudeStartLookupPending()).toBe(true)
    let discovered = false
    void claudeStartLookupSettled().then(() => { discovered = true })
    earlierAnswers()
    await settle()
    expect(claudeStartLookupPending(), 'the later start still holds').toBe(true)
    expect(discovered, 'and its walk is still waited for').toBe(false)
  })
})

describe('a logger that throws holds nothing', () => {
  // Mutation to prove this can fail: run the bound as `onBound(); finish()`.
  it('a launch and the look for each CLI still end at their bound', async () => {
    process.env.PATH = SYSTEM
    h.holdRegistry = true
    vi.useFakeTimers()
    startClaudeAtBoot(boot())
    await flush()
    const done: string[] = []
    void awaitClaudeStartLookup().then(() => { done.push('launch') })
    void claudeStartLookupSettled().then(() => { done.push('look for each CLI') })
    h.logThrows = true
    await vi.advanceTimersByTimeAsync(CLAUDE_START_LOOKUP_WAIT_MS)
    expect(done).toEqual(['launch', 'look for each CLI'])
    expect(vi.getTimerCount(), 'only the deadline is left').toBe(1)
  })

  // Mutation to prove this can fail: log at the deadline before ending the start, unguarded.
  it('the deadline still ends the start', async () => {
    process.env.PATH = SYSTEM
    h.holdRegistry = true
    vi.useFakeTimers()
    startClaudeAtBoot(boot())
    await flush()
    h.logThrows = true
    await vi.advanceTimersByTimeAsync(CLAUDE_START_DEADLINE_MS)
    expect(claudeStartLookupPending()).toBe(false)
    let waited = false
    void awaitClaudeStartLookup().then(() => { waited = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(waited).toBe(true)
  })

  // Mutation to prove this can fail: log a failed step unguarded (the throw skips the steps after it).
  it('a walk, a refresh, a lookup and a version probe that all fail still run one after another and let launches go', async () => {
    const lookup = vi.fn(() => Promise.reject(new Error('no walk')))
    const probe = vi.fn((): Promise<void> => Promise.reject(new Error('no probe')))
    h.logThrows = true
    startClaudeLookup(stepsNotFound({
      onPath: () => Promise.reject(new Error('no walk')),
      refreshPath: () => Promise.reject(new Error('no registry')),
      lookup,
      versionProbe: probe,
    }))
    expect(claudeStartLookupPending()).toBe(true)
    await awaitClaudeStartLookup()
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(claudeStartLookupPending()).toBe(false)
  })
})

describe('while Claude Code is switched off, or its settings cannot be read: as before the fix', () => {
  // Mutations to prove this can fail: hold and refresh whatever the launch
  // rule says; walk PATH whatever it says.
  it('nothing is held, walked or refreshed; the version probe is handed over in the same tick, and the look for each CLI does not wait', async () => {
    process.env.PATH = SYSTEM
    h.registryUser = LOCAL_BIN
    h.present = new Set([`${LOCAL_BIN}\\claude.exe`.toLowerCase()])
    setClaudeCliProbeAllowed(() => false)
    vi.useFakeTimers()
    startClaudeAtBoot(boot({ accountsWork: Promise.resolve() }))
    expect(claudeStartLookupPending(), 'no launch is held').toBe(false)
    // In the same tick, as `void probeClaudeCliVersion()` ran before the fix
    // (the probe itself does nothing while Claude Code is off).
    expect(versionProbe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount(), 'no deadline').toBe(0)
    await flush()
    expect(discover).toHaveBeenCalledTimes(1)
    expect(h.registryReads, 'the registry is not read').toBe(0)
    expect(process.env.PATH).toBe(SYSTEM)
    expect(h.walks).toBe(0)
    expect(h.walksInPlace).toBe(0)
    expect(h.profileCalls).toBe(0)
    expect(order).toEqual([`version probe on ${SYSTEM}`, `look for each CLI on ${SYSTEM}`])
    expect(startLog()).toEqual([])
  })

  // Mutation to prove this can fail: take a launch rule that throws for "on".
  it('a launch rule that throws is "off": nothing is held, and the start does not throw', () => {
    const onPath = vi.fn(() => Promise.resolve(false))
    const refreshPath = vi.fn(() => Promise.resolve())
    expect(() => startClaudeLookup(stepsNotFound({ claudeOn: () => { throw new Error('no settings') }, onPath, refreshPath }))).not.toThrow()
    expect(claudeStartLookupPending()).toBe(false)
    expect(versionProbe).toHaveBeenCalledTimes(1)
    expect(onPath).not.toHaveBeenCalled()
    expect(refreshPath).not.toHaveBeenCalled()
  })
})

describe('what at start reads PATH and nothing waits for (the look for each provider\'s CLI)', () => {
  // Mutations to prove this can fail: answer at once; answer at once when a
  // launch has already waited out its bound.
  it('runs after the start\'s PATH refresh and first lookup, on the PATH they leave, also when a launch gave up before it asked', async () => {
    process.env.PATH = SYSTEM
    h.registryUser = LOCAL_BIN
    h.holdRegistry = true
    vi.useFakeTimers()
    startClaudeAtBoot(boot())
    await flush()
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
    expect(vi.getTimerCount(), 'its own timer is cleared, and the deadline\'s').toBe(0)
    expect(startLog(), 'only the launch gave up').toEqual([LAUNCH_GAVE_UP])
  })

  // Mutation to prove this can fail: wait without a bound.
  it('its wait has the same bound as a launch\'s: past it the look runs on the PATH there is, so no provider stays "not checked yet" for longer, and it is logged', async () => {
    process.env.PATH = SYSTEM
    h.registryUser = LOCAL_BIN
    h.holdRegistry = true
    startClaudeAtBoot(boot())
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
    startClaudeAtBoot(boot())
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
    startClaudeAtBoot(boot())
    await settle()
    void claudeStartLookupSettled().then(() => { n += 1 })
    await Promise.resolve()
    expect(n, 'the start has answered').toBe(2)
    _resetClaudeStartLookupForTest()
    startClaudeAtBoot(boot(), 'linux')
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
    startClaudeAtBoot(boot())
    // In the same tick, as `void probeClaudeCliVersion()` ran before.
    expect(versionProbe).toHaveBeenCalledTimes(1)
    expect(claudeStartLookupPending()).toBe(false)
    await awaitClaudeStartLookup()
    await settle()
    expect(h.walks).toBe(0)
    expect(h.walksInPlace).toBe(0)
    expect(h.registryReads).toBe(0)
    expect(order.filter((o) => o.startsWith('lookup'))).toEqual([])
    expect(versionProbe).toHaveBeenCalledTimes(1)
    expect(process.env.PATH).toBe(pathBefore)
    expect(launch()).toEqual({ cmd: 'claude', args: [] })
  })
})

// The start's wiring, by running it: what main hands over is the functions
// themselves (index.ts, pinned by its text in the last case below), and what
// is done with them is here.
describe('main runs it at start (startClaudeAtBoot)', () => {
  // Mutations to prove this can fail: mark the start pending a turn later;
  // walk another environment than the one handed over.
  it('the start is pending before the call returns, so before a window exists to ask for a launch; the walk and the lookup read the environment main handed over, and nothing else', async () => {
    process.env.PATH = SYSTEM
    const walkPath = vi.fn(claudeOnWindowsPathAsync)
    const findClaude = vi.fn(findClaudeOnWindowsAsync)
    // What index.ts does next in the same turn stands in for the window.
    const seenByTheNextStatement: boolean[] = []
    startClaudeAtBoot(boot({ walkPath, findClaude }))
    seenByTheNextStatement.push(claudeStartLookupPending())
    expect(seenByTheNextStatement).toEqual([true])
    expect(walkPath.mock.calls.length).toBe(1)
    expect(walkPath.mock.calls[0].length, 'the environment only: the real file test, the real clock').toBe(1)
    expect(walkPath.mock.calls[0][0]).toBe(process.env)
    await awaitClaudeStartLookup()
    expect(findClaude.mock.calls.length).toBe(1)
    expect(findClaude.mock.calls[0].length).toBe(1)
    expect(findClaude.mock.calls[0][0]).toBe(process.env)
    expect(h.registryReads, 'the refresh handed over ran once').toBe(1)
    expect(versionProbe).toHaveBeenCalledTimes(1)
  })

  // Mutations to prove this can fail: look for each CLI straight after the
  // accounts work; ask whether the start has settled before starting it.
  it('the look for each provider\'s CLI waits for the accounts work and for the start\'s refresh and first lookup, though the accounts work had ended before main called it', async () => {
    process.env.PATH = SYSTEM
    h.registryUser = LOCAL_BIN
    h.holdRegistry = true
    vi.useFakeTimers()
    // Ended already: its next step can answer in the very next microtask.
    startClaudeAtBoot(boot({ accountsWork: Promise.resolve() }))
    await flush()
    expect(discover, 'not on the PATH from before').not.toHaveBeenCalled()
    for (const r of h.registryRelease.splice(0)) r()
    await flush()
    expect(discover).toHaveBeenCalledTimes(1)
    expect(order).toEqual([`lookup on ${SYSTEM};${LOCAL_BIN}`, `version probe on ${SYSTEM};${LOCAL_BIN}`, `look for each CLI on ${SYSTEM};${LOCAL_BIN}`])
  })

  // Mutation to prove this can fail: look for each CLI when the start has settled, whatever the accounts work.
  it('and for the accounts work when that is the slower one', async () => {
    process.env.PATH = SYSTEM
    let accountsDone = (): void => {}
    const accountsWork = new Promise<void>((resolve) => { accountsDone = resolve })
    startClaudeAtBoot(boot({ accountsWork }))
    await awaitClaudeStartLookup()
    await settle()
    expect(claudeStartLookupPending()).toBe(false)
    expect(discover).not.toHaveBeenCalled()
    accountsDone()
    await settle()
    expect(discover).toHaveBeenCalledTimes(1)
  })

  // Mutation to prove this can fail: wait for the start with no bound of its own.
  it('past the settled bound it looks on the PATH there is, and that is logged', async () => {
    process.env.PATH = SYSTEM
    h.registryUser = LOCAL_BIN
    h.holdRegistry = true
    vi.useFakeTimers()
    startClaudeAtBoot(boot({ accountsWork: Promise.resolve() }))
    await flush()
    await vi.advanceTimersByTimeAsync(CLAUDE_START_LOOKUP_WAIT_MS - 1)
    expect(discover).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(discover).toHaveBeenCalledTimes(1)
    expect(order).toEqual([`look for each CLI on ${SYSTEM}`])
    expect(startLog()).toEqual([DISCOVERY_GAVE_UP])
  })

  // Mutation to prove this can fail: look for each CLI whether or not the accounts service started.
  it('without the accounts work (the accounts service did not start) nothing is looked for, as before', async () => {
    process.env.PATH = SYSTEM
    startClaudeAtBoot(boot({ accountsWork: null }))
    await awaitClaudeStartLookup()
    await settle()
    expect(discover).not.toHaveBeenCalled()
  })

  // What is left to the text of index.ts: that main calls it, once, with the
  // real functions, after the launch rule is set and before the first window.
  // Mutations to prove this can fail: put `void probeClaudeCliVersion()` back
  // in its place; hand it a walk made in place; call it after createWindow().
  it('index.ts calls it once with the functions themselves, after the launch rule is set and before a window exists, and starts nothing of it by another way', () => {
    /** The source with its comments removed, so a commented-out line fails. */
    const code = fs.readFileSync(path.join(__dirname, '../../../src/main/index.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n')
    expect(code).toMatch(/startClaudeAtBoot\(\{\s*claudeOn: claudeCliProbeAllowed,\s*env: process\.env,\s*walkPath: claudeOnWindowsPathAsync,\s*refreshPath: refreshWindowsPath,\s*findClaude: findClaudeOnWindowsAsync,\s*versionProbe: \(\) => probeClaudeCliVersion\(\),\s*accountsWork,\s*discover: discoverProvidersAtStart,\s*\}\)/)
    expect(code.split('startClaudeAtBoot(').length).toBe(2)
    expect(code.split('probeClaudeCliVersion()').length, 'the version probe runs only through it').toBe(2)
    expect(code.split('discoverProvidersAtStart').length, 'imported, and handed over: nothing else starts it').toBe(3)
    expect(code, 'the start is not run piecemeal').not.toMatch(/startClaudeLookup\(|claudeStartLookupSettled\(|findOnWindowsPath\(/)
    // The accounts work it is handed: the legacy reconcile, then the
    // provider migrations, a failure logged; null when the service did not start.
    expect(code).toMatch(/let accountsWork: Promise<unknown> \| null = null/)
    expect(code).toMatch(/accountsWork = reconcileLegacyAccountStores\(\)\s*\.then\(\(\) => runStartupProviderMigrations\(\)\)\s*\.catch\(\(err\) => logError\('\[main\] account start-up work failed:', err\)\)/)
    expect(code.split('accountsWork').length, 'declared, set once, handed over').toBe(4)
    const ruleSet = code.indexOf("setClaudeCliProbeAllowed(() => providerProbeRefusal('claude') === null)")
    const started = code.indexOf('startClaudeAtBoot(')
    // The turn that starts it cannot wait: its function is not an async one.
    const ready = code.indexOf('app.whenReady().then(() => {')
    const firstWindow = code.indexOf('createWindow()', ready)
    expect(ready).toBeGreaterThan(-1)
    expect(ruleSet).toBeGreaterThan(ready)
    expect(firstWindow).toBeGreaterThan(-1)
    expect(started).toBeGreaterThan(ruleSet)
    expect(started).toBeLessThan(firstWindow)
  })
})

describe('the walk of PATH at start (claude-cli-probe.ts claudeOnWindowsPathAsync)', () => {
  // Mutations to prove this can fail: walk folder by folder (a claude.cmd in
  // an earlier folder wins); keep no answer for the launch.
  it('names what a launch names (claude.exe in any folder before claude.cmd), off the event loop, keeps its answer for the launch, and asks the profile nothing', async () => {
    process.env.PATH = `${NPM};${LOCAL_BIN}`
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase(), `${LOCAL_BIN}\\claude.exe`.toLowerCase()])
    setClaudeProfileLookupAllowed(() => true)
    expect(await claudeOnWindowsPathAsync(process.env)).toBe(`${LOCAL_BIN}\\claude.exe`)
    expect(h.walks).toBe(1)
    expect(launch()).toEqual({ cmd: `${LOCAL_BIN}\\claude.exe`, args: [] })
    expect(h.walksInPlace, 'the launch did not walk').toBe(0)
    process.env.PATH = SYSTEM
    expect(await claudeOnWindowsPathAsync(process.env)).toBeNull()
    expect(h.profileCalls).toBe(0)
  })

  // Mutation to prove this can fail: keep the answer under the PATH read after the walk.
  it('keeps its answer for the PATH it walked, not for one PATH became while it walked', async () => {
    process.env.PATH = `${SYSTEM};${NPM}`
    h.present = new Set([`${NPM}\\claude.cmd`.toLowerCase(), `${LOCAL_BIN}\\claude.exe`.toLowerCase()])
    holdTheWalk()
    const walked = claudeOnWindowsPathAsync(process.env)
    process.env.PATH = `${SYSTEM};${NPM};${LOCAL_BIN}`
    h.openWalk()
    expect(await walked).toBe(`${NPM}\\claude.cmd`)
    // A launch on the PATH of now walks for itself: the kept answer is not for it.
    expect(launch()).toEqual({ cmd: `${LOCAL_BIN}\\claude.exe`, args: [] })
    expect(h.walksInPlace).toBe(1)
  })
})
