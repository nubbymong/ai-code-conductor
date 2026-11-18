// 2.1.3-beta.9, plan section B1: Insights' report terminal starts through
// spawnRunPty (session-helper/manager.ts) instead of node-pty's spawn, under
// the run's own id ('insights-' and the account's profile id, or
// 'insights-default'). With the agent sessions' switch off, and with no
// session helper this run (these cases), spawnRunPty is node-pty's spawn with
// the very same arguments, so everything the report does with its terminal is
// as before: the same command, arguments and options, the Enter on the
// folder-trust prompt, /insights once a prompt shows, /exit once report.html
// changes, each at the same delay, and the kill at quit. The run's terminal
// through a holder is session-helper-manager.test.ts's.
//
// The PTY, the Claude Code resolution, the KPI step and the first-start
// warm-up are faked, as in insights-quit.test.ts. Nothing is started.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const RESOLVED = 'C:\\Users\\A\\.local\\bin\\claude.exe'
type FakePty = {
  file: string
  args: unknown
  opts: Record<string, unknown>
  /** The fake clock when it was started. */
  at: number
  data: ((d: string) => void) | null
  exit: ((e: { exitCode: number }) => void) | null
  /** Each write, with the fake clock when it came. */
  writes: Array<{ at: number; data: string }>
  kills: number[]
  onData: (cb: (d: string) => void) => { dispose(): void }
  onExit: (cb: (e: { exitCode: number }) => void) => { dispose(): void }
  write: (d: string) => void
  kill: () => void
}
const h = vi.hoisted(() => ({
  resourcesDir: '',
  installPath: '',
  profileDir: {} as Record<string, string>,
  profiles: [] as Array<{ id: string; name?: string; accountEmail: string; isPrimary?: boolean }>,
  ptys: [] as FakePty[],
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
// A terminal that runs until it is killed; what it shows is the test's to say.
vi.mock('node-pty', () => ({
  spawn: (file: string, args: unknown, opts: Record<string, unknown>) => {
    const p: FakePty = {
      file, args, opts, at: Date.now(), data: null, exit: null, writes: [], kills: [],
      onData: (cb) => { p.data = cb; return { dispose() {} } },
      onExit: (cb) => { p.exit = cb; return { dispose() {} } },
      write: (d) => { p.writes.push({ at: Date.now(), data: d }) },
      kill: () => { p.kills.push(Date.now()) },
    }
    h.ptys.push(p)
    return p
  },
}))
// The real spawnRunPty, watched: with no session helper this run it is
// node-pty's spawn with the same arguments.
vi.mock('../../../src/main/session-helper/manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/session-helper/manager')>()
  return { ...actual, spawnRunPty: vi.fn(actual.spawnRunPty) }
})
vi.mock('../../../src/main/claude-headless', () => ({
  spawnClaudeHeadless: async () => ({ code: 0, stdout: '{}', stderr: '' }),
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/first-start-warmup', () => ({
  warmFirstStart: async () => ({ outcome: 'ran', exitCode: 0, timedOut: false }),
}))

import * as insights from '../../../src/main/insights-runner'
import { spawnRunPty, setSessionHelper } from '../../../src/main/session-helper/manager'
import { _resetQuitHoldForTest } from '../../../src/main/quit-hold'
import { composeProviders } from '../../../src/main/providers/compose'
import { _resetProfileConsumersForTest } from '../../../src/main/profile-consumers'
import { _resetProjectScanStateForTest } from '../../../src/main/managed-launch-diagnostics'

let tmpRoot = ''
let next = 0
/** A fresh account with a report.html already there, as after an earlier report. */
function account(primary = false): string {
  const id = `acct${++next}`
  const dir = join(tmpRoot, 'profiles', id)
  mkdirSync(join(dir, '.claude', 'usage-data'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'usage-data', 'report.html'), '<html><body>r</body></html>')
  h.profileDir[id] = dir
  h.profiles.push({ id, name: id, accountEmail: `${id}@example.com`, isPrimary: primary })
  return id
}
const reportOf = (profileId: string) => join(h.profileDir[profileId], '.claude', 'usage-data', 'report.html')

/** Starts a report and waits for its terminal. */
async function reportRunning(): Promise<{ run: Promise<unknown>; pty: FakePty; profileId: string }> {
  const before = h.ptys.length
  const profileId = account()
  const run = insights.runInsights(() => null, { profileId })
  await vi.waitFor(() => expect(h.ptys.length).toBe(before + 1))
  return { run, pty: h.ptys[before], profileId }
}

/** The terminal shows `chunks`, one output event each, as node-pty reports them. */
function shows(p: FakePty, ...chunks: string[]): void {
  for (const c of chunks) p.data?.(c)
}

beforeAll(() => { composeProviders() })
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'insights-run-terminal-'))
  h.resourcesDir = join(tmpRoot, 'resources')
  mkdirSync(h.resourcesDir, { recursive: true })
  h.installPath = join(tmpRoot, 'install')
  mkdirSync(h.installPath, { recursive: true })
  h.profileDir = {}
  h.profiles = []
  h.ptys.length = 0
  vi.mocked(spawnRunPty).mockClear()
  setSessionHelper(null)
  _resetQuitHoldForTest()
  _resetProfileConsumersForTest()
  _resetProjectScanStateForTest()
  account(true)
})
afterEach(async () => {
  vi.useRealTimers()
  insights.killInsightsPty()
  await new Promise((r) => setTimeout(r, 5))
  _resetQuitHoldForTest()
  _resetProjectScanStateForTest()
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('the report terminal starts as before', () => {
  it('characterisation: node-pty gets the resolved Claude Code, no arguments, and the same five options', async () => {
    const { pty } = await reportRunning()
    expect(pty.file).toBe(RESOLVED)
    expect(pty.args).toEqual([])
    expect(Object.keys(pty.opts)).toEqual(['name', 'cols', 'rows', 'cwd', 'env'])
    expect(pty.opts).toMatchObject({ name: 'xterm-256color', cols: 120, rows: 30, cwd: h.installPath })
    expect(typeof pty.opts.env).toBe('object')
  })

  it('through spawnRunPty, under the run\'s own id for the account, with that very command, arguments and options', async () => {
    const { pty, profileId } = await reportRunning()
    expect(spawnRunPty).toHaveBeenCalledTimes(1)
    const [ctx, file, args, opts] = vi.mocked(spawnRunPty).mock.calls[0]
    expect(ctx).toEqual({ runId: `insights-${profileId}`, kind: 'claude' })
    expect(file).toBe(RESOLVED)
    expect(args).toBe(pty.args)
    expect(opts).toBe(pty.opts)
  })

  it('the run id: the account\'s profile id, or default for the global sign-in', () => {
    expect(insights.insightsRunId('work-1')).toBe('insights-work-1')
    expect(insights.insightsRunId(undefined)).toBe('insights-default')
  })
})

describe('what the report types into its terminal, and when (fake clock)', () => {
  it('Enter on the trust prompt, /insights once a prompt shows, and /exit once report.html changes, at the same delays, with each prompt split across chunks of different sizes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const { run, pty, profileId } = await reportRunning()
    const S = pty.at
    // The trust prompt in three chunks of different sizes: only the third
    // completes "folder".
    shows(pty, '\x1b[2JDo you tr', 'ust the files in this fol', 'der?\r\n 1. Yes, proceed\r\n')
    const T = Date.now()
    await vi.advanceTimersByTimeAsync(1200)
    // Claude Code's prompt, split: a line, then ">" alone, then the rest of it.
    shows(pty, '\x1b[1mWelcome to Claude Code\x1b[0m\r\n\r\n', '>', ' \x1b[2mTry "help"\x1b[0m')
    const P = Date.now()
    expect(P).toBe(T + 1200)
    await vi.advanceTimersByTimeAsync(3000)
    // Enter 1 s after the trust prompt, and again every 1.5 s while /insights
    // is not sent (three at most); /insights 3 s after the prompt, since the
    // trust prompt was seen first.
    expect(pty.writes).toEqual([
      { at: T + 1000, data: '\r' },
      { at: T + 2500, data: '\r' },
      { at: T + 4000, data: '\r' },
      { at: P + 3000, data: '/insights\r' },
    ])
    const sentAt = P + 3000
    // The report is written: the poll (every 3 s from the start, never within
    // 5 s of /insights) sees it, /exit goes 2 s later, and the kill 10 s after that.
    const later = new Date(statSync(reportOf(profileId)).mtimeMs + 60_000)
    utimesSync(reportOf(profileId), later, later)
    const tick = S + 3000 * Math.ceil((sentAt + 5000 - S) / 3000)
    await vi.advanceTimersByTimeAsync(tick + 2000 - Date.now())
    expect(pty.writes).toHaveLength(5)
    expect(pty.writes[4]).toEqual({ at: tick + 2000, data: '/exit\r' })
    expect(pty.kills).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pty.kills).toEqual([tick + 12_000])
    // The run goes on as before: archived, then the KPI step (faked).
    vi.useRealTimers()
    await run
    expect(insights.getCatalogue().runs.find((r) => r.profileId === profileId)?.status).toBe('complete')
  })

  it('a normal quit: killInsightsPty ends the report\'s terminal through its kill()', async () => {
    const { pty } = await reportRunning()
    insights.killInsightsPty()
    expect(pty.kills).toHaveLength(1)
    insights.killInsightsPty()
    expect(pty.kills).toHaveLength(1)
  })
})
