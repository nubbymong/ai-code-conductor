// [host] #317: an Insights report starts Claude Code in a node-pty terminal of
// main's own (insights-runner.ts, spawnClaudeInsights), outside pty-manager,
// so killAllPty never reached it. A normal quit while a report ran left
// Claude Code and its console host running after the app had gone (seen on
// the beta.6 VM smoke: a 120x30 headless conhost). The quit teardown now calls
// killInsightsPty beside killCliSetupPty, and the terminal's start reads the
// quit hold (quit-hold.ts) in the same step as its spawn.
//
// index.ts cannot be imported in a unit test (it boots the app), so the quit
// teardown is cut out of its source and run against fakes, as
// setup-terminal-quit-teardown.test.ts does (tests/helpers/main-index-cut.ts).
// The kill it calls is the REAL one, on the real insights-runner module. Its
// PTY, the Claude Code resolution, the KPI extraction and the first-start
// warm-up are faked, as in insights-first-start.test.ts. Nothing is started.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MAIN_INDEX, runCut, quitTeardownSource } from '../../helpers/main-index-cut'

const RESOLVED = 'C:\\Users\\A\\.local\\bin\\claude.exe'
type FakePty = {
  exit: ((e: { exitCode: number }) => void) | null
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
}
const h = vi.hoisted(() => ({
  resourcesDir: '',
  installPath: '',
  profileDir: {} as Record<string, string>,
  profiles: [] as Array<{ id: string; name?: string; accountEmail: string; isPrimary?: boolean }>,
  ptys: [] as FakePty[],
  killThrows: false,
  warm: 0,
  gate: null as null | Promise<void>,
}))

vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {},
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  getProfileConfigDir: (id: string) => h.profileDir[id] ?? '',
  getPrimaryProfileId: () => h.profiles.find((p) => p.isPrimary)?.id ?? h.profiles[0]?.id ?? null,
  setupProfileLinks: () => {},
  listProfiles: () => h.profiles,
}))
vi.mock('../../../src/main/update-watcher', () => ({ getInstallPath: () => h.installPath, getProjectRootPath: () => '' }))
vi.mock('../../../src/main/claude-launch-walk', () => ({ awaitClaudeLaunchWalk: async () => {} }))
vi.mock('../../../src/main/pty-manager', async () => ({
  resolveClaudeForPty: () => ({ cmd: RESOLVED, args: [] }),
  withProfileHome: (await vi.importActual<typeof import('../../../src/main/account-profiles')>('../../../src/main/account-profiles')).withProfileHome,
}))
// A terminal that runs until it is killed; a kill reports its exit a moment
// later, as node-pty does.
vi.mock('node-pty', () => ({
  spawn: () => {
    const p: FakePty = {
      exit: null,
      onData: vi.fn(),
      onExit: vi.fn((cb: (e: { exitCode: number }) => void) => { p.exit = cb }),
      write: vi.fn(),
      kill: vi.fn(() => {
        if (h.killThrows) throw new Error('the terminal has already gone')
        setTimeout(() => p.exit?.({ exitCode: 1 }), 0)
      }),
    }
    h.ptys.push(p)
    return p
  },
}))
vi.mock('../../../src/main/claude-headless', () => ({
  spawnClaudeHeadless: async () => ({ code: 0, stdout: '{}', stderr: '' }),
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
// The warm-up answers (once its gate opens), whatever the quit: so these
// cases see the terminal's own read of the quit hold. The real warm-up's
// latch holds a caller after the quit as well (first-start-warmup.ts).
vi.mock('../../../src/main/first-start-warmup', () => ({
  warmFirstStart: async () => {
    h.warm++
    if (h.gate) await h.gate
    return { outcome: 'ran', exitCode: 0, timedOut: false }
  },
}))

import * as insights from '../../../src/main/insights-runner'
import { beginQuitHold, _resetQuitHoldForTest } from '../../../src/main/quit-hold'
import { composeProviders } from '../../../src/main/providers/compose'
import { _resetProfileConsumersForTest } from '../../../src/main/profile-consumers'
import { _resetProjectScanStateForTest } from '../../../src/main/managed-launch-diagnostics'

const TEARDOWN = quitTeardownSource()

/** Runs the quit teardown once; returns the steps it took that these cases
 *  watch, in order. killInsightsPty is the real one. With `withFlush`, the
 *  provider CLI flush sets the real quit hold, as its flush of the
 *  first-start warm-ups does. With `killAllThrows`, killAllPty throws. */
function quitTeardown(opts: { withFlush?: boolean; killAllThrows?: boolean } = {}): string[] {
  const order: string[] = []
  runCut<() => void>(TEARDOWN, {
    killCliSetupPty: () => { order.push('killCliSetupPty') },
    killInsightsPty: () => { order.push('killInsightsPty'); insights.killInsightsPty() },
    killAllPty: () => { order.push('killAllPty'); if (opts.killAllThrows) throw new Error('a session would not end') },
    closeDebugLogger: () => { order.push('closeDebugLogger') },
    ...(opts.withFlush ? { flushPendingProviderCliKills: () => { order.push('flushPendingProviderCliKills'); beginQuitHold() } } : {}),
  })()
  return order
}

/** 'pending' when `p` has not settled once every step it could take has run. */
async function stateOf(p: unknown): Promise<'pending' | 'settled'> {
  return Promise.race([Promise.resolve(p).then(() => 'settled' as const, () => 'settled' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), 30))])
}

let tmpRoot = ''
let next = 0
/** A fresh account for each run: a run the hold keeps waiting keeps its
 *  account's lock for the rest of the file. */
function account(primary = false): string {
  const id = `acct${++next}`
  const dir = join(tmpRoot, 'profiles', id)
  mkdirSync(join(dir, '.claude', 'usage-data'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'usage-data', 'report.html'), '<html><body>r</body></html>')
  h.profileDir[id] = dir
  h.profiles.push({ id, name: id, accountEmail: `${id}@example.com`, isPrimary: primary })
  return id
}

/** Starts a report and waits for its terminal. */
async function reportRunning(): Promise<{ run: Promise<unknown>; pty: FakePty }> {
  const before = h.ptys.length
  const run = insights.runInsights(() => null, { profileId: account() })
  await vi.waitFor(() => expect(h.ptys.length).toBe(before + 1))
  return { run, pty: h.ptys[before] }
}

beforeAll(() => { composeProviders() })
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'insights-quit-'))
  h.resourcesDir = join(tmpRoot, 'resources')
  mkdirSync(h.resourcesDir, { recursive: true })
  h.installPath = join(tmpRoot, 'install')
  mkdirSync(h.installPath, { recursive: true })
  h.profileDir = {}
  h.profiles = []
  h.ptys.length = 0
  h.killThrows = false
  h.warm = 0
  h.gate = null
  _resetQuitHoldForTest()
  _resetProfileConsumersForTest()
  _resetProjectScanStateForTest()
  account(true)
})
afterEach(async () => {
  // Nothing an earlier case started is left for the next one.
  h.killThrows = false
  insights.killInsightsPty?.()
  await new Promise((r) => setTimeout(r, 5))
  _resetQuitHoldForTest()
  _resetProjectScanStateForTest()
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('a normal quit ends the Insights report terminal that is running', () => {
  it('the quit teardown kills it exactly once, before killAllPty and before the debug logger closes', async () => {
    const { run, pty } = await reportRunning()
    const order = quitTeardown()
    expect(pty.kill).toHaveBeenCalledTimes(1) // beta.6: 0, Claude Code and its conhost left running
    expect(order.filter((o) => o === 'killInsightsPty')).toHaveLength(1)
    // Before killAllPty, so a throw there cannot skip it; its line is logged
    // while the log is still open.
    expect(order.indexOf('killInsightsPty')).toBeLessThan(order.indexOf('killAllPty'))
    expect(order.indexOf('killInsightsPty')).toBeLessThan(order.indexOf('closeDebugLogger'))
    // The killed terminal's exit settles the run: nothing is left waiting on it.
    const id = await run as string
    expect(insights.getCatalogue().runs.find((r) => r.id === id)?.status).toBe('failed')
  })

  it('reports running for two accounts at once: both terminals are killed', async () => {
    const first = await reportRunning()
    const second = await reportRunning()
    quitTeardown()
    expect(first.pty.kill).toHaveBeenCalledTimes(1)
    expect(second.pty.kill).toHaveBeenCalledTimes(1)
  })

  it('with no report running, the teardown kills nothing and does not throw', () => {
    expect(() => quitTeardown()).not.toThrow()
    expect(h.ptys).toHaveLength(0)
  })

  it('a terminal that already ended on its own is not killed at quit', async () => {
    const { run, pty } = await reportRunning()
    pty.exit?.({ exitCode: 0 })
    await run
    quitTeardown()
    expect(pty.kill).not.toHaveBeenCalled()
  })

  it('the kill is safe twice: a second call does not kill again', async () => {
    const { pty } = await reportRunning()
    quitTeardown()
    expect(() => insights.killInsightsPty()).not.toThrow()
    expect(pty.kill).toHaveBeenCalledTimes(1)
  })

  it('a terminal whose kill throws (already gone) does not stop the rest of the teardown', async () => {
    h.killThrows = true
    const { pty } = await reportRunning()
    let order: string[] = []
    expect(() => { order = quitTeardown() }).not.toThrow()
    expect(pty.kill).toHaveBeenCalledTimes(1)
    expect(order.at(-1)).toBe('closeDebugLogger')
  })

  it('a killAllPty that throws does not skip it: the report terminal is ended first', async () => {
    const { pty } = await reportRunning()
    expect(() => quitTeardown({ killAllThrows: true })).toThrow('a session would not end')
    expect(pty.kill).toHaveBeenCalledTimes(1)
  })

  it('the teardown takes the kill from insights-runner (the function these cases run)', () => {
    expect(MAIN_INDEX).toMatch(/import \{[^}]*\bkillInsightsPty\b[^}]*\} from '\.\/insights-runner'/)
  })
})

describe('no Insights report terminal starts once the quit teardown has run', () => {
  it('a report asked for after the teardown starts no terminal, and its start is never answered', async () => {
    expect(quitTeardown({ withFlush: true })).toContain('flushPendingProviderCliKills')
    const run = insights.runInsights(() => null, { profileId: account() })
    await vi.waitFor(() => expect(h.warm).toBe(1))
    expect(await stateOf(run)).toBe('pending')
    expect(h.ptys).toHaveLength(0) // beta.6, with the warm-up answering: a terminal nothing would end
  })

  it('a quit while a report waits for its first start: the start makes no terminal after the teardown', async () => {
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const run = insights.runInsights(() => null, { profileId: account() })
    await vi.waitFor(() => expect(h.warm).toBe(1))
    quitTeardown({ withFlush: true })
    release()
    expect(await stateOf(run)).toBe('pending')
    expect(h.ptys).toHaveLength(0) // beta.6, with the warm-up answering: a terminal started after the teardown
  })

  it('before the teardown, the same report makes its terminal (the control)', async () => {
    await reportRunning()
    expect(h.ptys).toHaveLength(1)
  })
})
