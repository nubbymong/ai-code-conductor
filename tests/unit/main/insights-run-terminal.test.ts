// 2.1.3-beta.9, plan section B1: Insights' report terminal starts through
// spawnRunPty (session-helper/manager.ts) instead of node-pty's spawn, under
// the run's own id ('insights-' and the account's profile id, or
// 'insights--default' for the global sign-in). With the agent sessions' switch off, and with no
// session helper this run, spawnRunPty is node-pty's spawn with the very same
// arguments, so everything the report does with its terminal is as before:
// the same command, arguments and options, the Enter on the folder-trust
// prompt, /insights once a prompt shows, /exit once report.html changes, each
// at the same delay, and the kill at quit. The same holds with a session
// helper running for plain terminals only (the agent sessions' switch off).
//
// With the switch on (review), the report runs through a holder of the fake
// session helper (session-helper-fake-holder.ts): the same writes at the same
// delays reach Claude Code through it, a normal quit's kill ends the holder,
// a start held past 20 s types nothing before Claude Code's first output (the
// 20 s fallback counts from that output there), and a holder that vanishes
// fails the run with a sentence saying so. Those cases run on Windows only:
// the fake helper's records are Windows ones, so its manager is a Windows
// one, and its launch check takes the report's folder (a temp folder here)
// as a Windows path. Windows CI runs them (the unit suite's Windows parts).
// The rest of the holder's path is session-helper-manager.test.ts's.
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

import type { IPty } from 'node-pty'
import * as insights from '../../../src/main/insights-runner'
import { HELPER_SENTENCES, SessionHelperManager, spawnRunPty, setSessionHelper } from '../../../src/main/session-helper/manager'
import { HelperPty } from '../../../src/main/session-helper/helper-pty'
import { APP_PTY_ID_RE, heldAgentSessionId } from '../../../src/main/session-helper/protocol'
import { FakeHelper, type FakeHolder } from './session-helper-fake-holder'
import { isValidProfileId } from '../../../src/shared/profile-id'
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

// ── through the session helper (review) ──────────────────────────────────────

const onWindows = process.platform === 'win32'
/** The real spawnRunPty the watched one calls. */
const realSpawnRunPty = vi.mocked(spawnRunPty).getMockImplementation()!
// Real time, kept from before any faking: the in-memory streams to a fake
// holder move on in it while the test's fake clock stands still.
const realSetTimeout = globalThis.setTimeout
const realWait = (ms: number) => new Promise<void>((r) => { realSetTimeout(r, ms) })
async function realUntil(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = performance.now() + ms
  while (!cond()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`)
    await realWait(5)
  }
}
/** The fake clock moves on `ms`, in steps, with real time between them. */
async function stepFor(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 50) {
    await vi.advanceTimersByTimeAsync(50)
    await realWait(2)
  }
}

const helpers: Array<{ m: SessionHelperManager; helper: FakeHelper }> = []
const helperLogs: string[] = []

/** A session helper (the fake one) set up and ready for this run: agent
 *  sessions through it when `agents` is true, else plain terminals only. */
async function helperOn(agents: boolean): Promise<FakeHelper> {
  const dir = join(tmpRoot, 'helper')
  mkdirSync(join(dir, 'install'), { recursive: true })
  const bundled = join(dir, 'install', 'aicc-helper.exe')
  writeFileSync(bundled, 'MZ the installed helper')
  const helper = new FakeHelper()
  const m = new SessionHelperManager({
    platform: 'win32', root: join(dir, 'user'), bundled,
    exec: helper.exec, openStream: helper.openStream, conptySource: () => null,
    log: (l) => { helperLogs.push(l) },
  })
  helpers.push({ m, helper })
  await m.start({ atStartup: true, plain: !agents, agents })
  await realUntil(() => m.serviceState().state === 'ready', 'the helper to be ready')
  setSessionHelper(m)
  return helper
}

/** The report's terminal as the runner got it, with each write it made (and
 *  the fake clock then) and what it showed. */
interface Watched { term: IPty; at: number; writes: Array<{ at: number; data: string }>; seen: string[] }

/** Watches the next start: the real spawnRunPty, its terminal's writes recorded. */
function watchTheStart(): () => Watched | undefined {
  let w: Watched | undefined
  vi.mocked(spawnRunPty).mockImplementationOnce((ctx, file, args, o) => {
    const term = realSpawnRunPty(ctx, file, args, o)
    const writes: Watched['writes'] = []
    const seen: string[] = []
    const write = term.write.bind(term)
    term.write = (d: string | Buffer) => { writes.push({ at: Date.now(), data: String(d) }); write(d) }
    // Before the runner's own listener, in the same output event.
    term.onData((d) => seen.push(d))
    w = { term, at: Date.now(), writes, seen }
    return term
  })
  return () => w
}

/** Starts a report through the watched start and waits for its terminal. */
async function reportThroughHelper(): Promise<{ run: Promise<unknown>; w: Watched; profileId: string; sid: string }> {
  const watched = watchTheStart()
  const profileId = account()
  const run = insights.runInsights(() => null, { profileId })
  await vi.waitFor(() => expect(watched()).toBeDefined())
  const w = watched()!
  expect(w.term).toBeInstanceOf(HelperPty)
  return { run, w, profileId, sid: heldAgentSessionId(insights.insightsRunId(profileId), 'claude') }
}

/** The holder shows `chunks` (one output frame each); answers once the runner has seen them all. */
async function holderShows(holder: FakeHolder, w: Watched, ...chunks: string[]): Promise<void> {
  const before = w.seen.join('')
  for (const c of chunks) holder.output(c)
  await realUntil(() => w.seen.join('') === before + chunks.join(''), 'the runner to see the output')
}

async function endHelpers(): Promise<void> {
  setSessionHelper(null)
  const quits = helpers.map(({ m }) => { try { return m.shutdown() } catch { return null } })
  for (const { helper } of helpers) for (const holder of helper.holders.values()) holder.dropAll()
  helpers.length = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled(quits),
    new Promise<void>((r) => { timer = realSetTimeout(r, 3000) }),
  ]).finally(() => clearTimeout(timer))
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
  helperLogs.length = 0
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
  await endHelpers()
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

  it('the run id: the account\'s profile id, or one no profile id makes for the global sign-in (PR review)', () => {
    expect(insights.insightsRunId('work-1')).toBe('insights-work-1')
    expect(insights.insightsRunId(undefined)).toBe('insights--default')
    // A profile may be called `default` (a valid profile id), and its report
    // may run beside the global sign-in's (each account has its own lock): the
    // two never share a run id, so neither start ends the other's holder.
    expect(isValidProfileId('default')).toBe(true)
    expect(insights.insightsRunId('default')).not.toBe(insights.insightsRunId(undefined))
    expect(heldAgentSessionId(insights.insightsRunId('default'), 'claude')).not.toBe(heldAgentSessionId(insights.insightsRunId(undefined), 'claude'))
    // No valid profile id makes the global one: each starts with a letter or digit.
    expect(isValidProfileId('-default')).toBe(false)
    // Each is an id a holder can carry as its label.
    for (const id of [insights.insightsRunId(undefined), insights.insightsRunId('default'), insights.insightsRunId('a'.repeat(119))]) expect(APP_PTY_ID_RE.test(id)).toBe(true)
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

describe('with a session helper running for plain terminals only (the agent sessions\' switch off)', () => {
  it('node-pty\'s spawn with that very command, arguments and options, and the report completes as before (review)', async () => {
    const helper = await helperOn(false)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const { run, pty, profileId } = await reportRunning()
    expect(spawnRunPty).toHaveBeenCalledTimes(1)
    const [ctx, file, args, opts] = vi.mocked(spawnRunPty).mock.calls[0]
    expect(ctx).toEqual({ runId: `insights-${profileId}`, kind: 'claude' })
    expect(pty.file).toBe(file)
    expect(pty.args).toBe(args)
    expect(pty.opts).toBe(opts)
    expect(helper.holds()).toBe(0)
    // The prompt: /insights 1 s later; the report written: /exit; then Claude Code exits.
    shows(pty, '\x1b[1mWelcome to Claude Code\x1b[0m\r\n\r\n> ')
    const P = Date.now()
    await vi.advanceTimersByTimeAsync(1000)
    expect(pty.writes).toEqual([{ at: P + 1000, data: '/insights\r' }])
    const later = new Date(statSync(reportOf(profileId)).mtimeMs + 60_000)
    utimesSync(reportOf(profileId), later, later)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pty.writes.map((x) => x.data)).toEqual(['/insights\r', '/exit\r'])
    pty.exit?.({ exitCode: 0 })
    vi.useRealTimers()
    await run
    expect(insights.getCatalogue().runs.find((r) => r.profileId === profileId)?.status).toBe('complete')
    expect(helper.holds()).toBe(0)
  })
})

describe.runIf(onWindows)('with the agent sessions\' switch on: the report\'s terminal runs through a holder (review)', () => {
  /** The trust prompt, then Claude Code's prompt, each split across chunks of
   *  different sizes, as in the node-pty case above: Enter 1 s after the trust
   *  prompt and every 1.5 s after (three at most), /insights 3 s after the prompt. */
  async function trustThenPrompt(holder: FakeHolder, w: Watched): Promise<{ T: number; P: number }> {
    await holderShows(holder, w, '\x1b[2JDo you tr', 'ust the files in this fol', 'der?\r\n 1. Yes, proceed\r\n')
    const T = Date.now()
    await stepFor(1200)
    await holderShows(holder, w, '\x1b[1mWelcome to Claude Code\x1b[0m\r\n\r\n', '>', ' \x1b[2mTry "help"\x1b[0m')
    const P = Date.now()
    expect(P).toBe(T + 1200)
    await stepFor(3000)
    return { T, P }
  }
  const usualWrites = (T: number, P: number) => [
    { at: T + 1000, data: '\r' },
    { at: T + 2500, data: '\r' },
    { at: T + 4000, data: '\r' },
    { at: P + 3000, data: '/insights\r' },
  ]

  /** A hold that waits until `open` is called: the start held as long as the test likes. */
  function heldHold(helper: FakeHelper): () => void {
    let open!: () => void
    helper.holdGate = new Promise<void>((r) => { open = r })
    return () => open()
  }

  it('the same start under the run\'s id, the same writes at the same delays reaching Claude Code through the holder, and a normal quit\'s kill ending the holder', async () => {
    const helper = await helperOn(true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const { w, sid, profileId } = await reportThroughHelper()
    await realUntil(() => !!helper.holders.get(sid)?.attached, 'the report to attach')
    const holder = helper.holders.get(sid)!
    const [ctx, , , opts] = vi.mocked(spawnRunPty).mock.calls[0]
    expect(ctx).toEqual({ runId: insights.insightsRunId(profileId), kind: 'claude' })
    expect(holder.label).toBe(ctx.runId)
    expect(holder.launch).toEqual({ t: 'term.launch', id: expect.anything(), argv: [RESOLVED], cwd: h.installPath, env: opts.env, cols: 120, rows: 30 })
    expect(h.ptys).toEqual([])
    const { T, P } = await trustThenPrompt(holder, w)
    expect(w.writes).toEqual(usualWrites(T, P))
    await realUntil(() => Buffer.concat(holder.input).toString() === '\r\r\r/insights\r', 'the writes to reach Claude Code')
    insights.killInsightsPty()
    await realUntil(() => holder.ended, 'the holder\'s end')
    expect(holder.requests.map((r) => r.t)).toContain('term.end')
  })

  it('a start held past 20 s: nothing is typed before Claude Code\'s first output, then Enter and /insights come at their usual delays', async () => {
    const helper = await helperOn(true)
    const open = heldHold(helper)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const { w, sid } = await reportThroughHelper()
    await vi.waitFor(() => expect(helper.holds()).toBe(1))
    // Past node-pty's 20 s fallback, with Claude Code not started yet.
    await vi.advanceTimersByTimeAsync(25_000)
    expect(w.writes).toEqual([])
    open()
    await realUntil(() => !!helper.holders.get(sid)?.attached, 'the report to attach')
    const holder = helper.holders.get(sid)!
    await realWait(20)
    expect(holder.input).toEqual([])
    const { T, P } = await trustThenPrompt(holder, w)
    expect(w.writes).toEqual(usualWrites(T, P))
    await realUntil(() => Buffer.concat(holder.input).toString() === '\r\r\r/insights\r', 'the writes to reach Claude Code')
  })

  it('a start held past 20 s with no prompt seen: /insights 20 s after Claude Code\'s first output, not 20 s after the start call', async () => {
    const helper = await helperOn(true)
    const open = heldHold(helper)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const { w, sid } = await reportThroughHelper()
    await vi.waitFor(() => expect(helper.holds()).toBe(1))
    await vi.advanceTimersByTimeAsync(25_000)
    expect(w.writes).toEqual([])
    open()
    await realUntil(() => !!helper.holders.get(sid)?.attached, 'the report to attach')
    const holder = helper.holders.get(sid)!
    // A banner, with no trust prompt and no ">" prompt in it.
    await holderShows(holder, w, '\x1b[1mClaude Code\x1b[0m v2.1.0\r\n')
    const F = Date.now()
    await stepFor(19_950)
    expect(w.writes).toEqual([])
    await stepFor(50)
    expect(w.writes).toEqual([{ at: F + 20_000, data: '/insights\r' }])
    await realUntil(() => Buffer.concat(holder.input).toString() === '/insights\r', 'the write to reach Claude Code')
  })

  it('its holder vanishes during the report: the run fails, and its error says the session helper lost the report\'s terminal', async () => {
    const helper = await helperOn(true)
    const { run, sid, profileId } = await reportThroughHelper()
    await realUntil(() => !!helper.holders.get(sid)?.attached, 'the report to attach')
    helper.holders.get(sid)!.vanish()
    await run
    const r = insights.getCatalogue().runs.find((x) => x.profileId === profileId)
    expect(r?.status).toBe('failed')
    expect(r?.error).toContain('The session helper lost this report\'s terminal. Run the report again.')
    expect(r?.error).toContain(HELPER_SENTENCES.runLost)
    expect(helperLogs.some((l) => l.includes(sid) && l.includes('could not be attached again'))).toBe(true)
  })
})
