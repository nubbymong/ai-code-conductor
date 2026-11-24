/**
 * 2.1.3-beta.17, plan section B1 (S16 steps 5 and 6, aicc_planning#412): the
 * next start after an app update keeps a Claude Code session the update kept
 * running for its restored tab, and the tab takes it over with no launch:
 * the same holder and CLI, attached, its replay shown, the hook events its
 * holder queued in the gap delivered from the attach, and the tool stream its
 * holder kept given back and served with `toolsChanged` (the CLI is told its
 * tool list may have changed) for a provider whose CLI lists its tools again.
 * A kept session of a provider with no take-over wired, one whose tab is not
 * among the saved sessions, a start that does not follow an update, the
 * agent sessions' setting off, a tab that starts a new CLI instead, a tab
 * that does not take it over in time, a holder the start cannot reach, and a
 * quit: each ended, its record and what it left on disk removed. A tab asking
 * on another account (a Codex lease's, or the account a Claude Code launch
 * names) takes nothing over, and its launch ends the kept session first. A
 * take-over that cannot attach says so in the tab, exits 1 and starts nothing.
 * A Codex session kept on its resume list carries its pick through the record
 * to the take-over, or to the removal when it is ended (aicc_planning#419).
 *
 * PURE: the real manager and HelperPty against the fake helper, in memory; the
 * launch's bindings (kept-launches.ts) are a stand-in that records what it is
 * asked. The take-over is asked through the seam, as launch-bindings.ts asks
 * it (takeKeptSession). tests/unit/main/launch-bindings-take-over.test.ts
 * holds pty-manager.ts and the launch bindings to the launch it replaces.
 *
 * Not checked here: off Windows (nothing is let go of there); a holder whose
 * screen read gives a size (session-helper-held-screen.test.ts owns the plain
 * take-over's size wait, which this one shares).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'node-pty'

// node-pty is the usual way: the spy shows every terminal that did NOT go
// through the helper.
const ptySpawn = vi.hoisted(() => vi.fn())
vi.mock('node-pty', () => ({ spawn: ptySpawn }))

import { HELPER_SENTENCES, SessionHelperManager, keptSessionIdsIn, setSessionHelper, spawnAgentPty, type HelperHookDeps, type HelperToolDeps, type HelperToolLink } from '../../../src/main/session-helper/manager'
import { setKeptLaunchBindings, takeKeptSession, type KeptLaunch, type KeptLaunchBindings, type KeptLaunchFacts, type KeptUnseen } from '../../../src/main/sessions/kept-launches'
// aicc_planning#423: the seam the pty handlers tell (keptTabsRestored,
// keptTabShown, keptTabClosed), read off the module so a case still loads on
// the code before it.
import * as keptSeam from '../../../src/main/sessions/kept-launches'
import { heldAgentSessionId } from '../../../src/main/session-helper/protocol'
import type { HookEventFrame } from '../../../src/main/session-helper/protocol'
import { FakeHelper, type FakeHolder } from './session-helper-fake-holder'

const SHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CWD = 'C:\\Users\\someone\\project'
const agentOpts = () => ({ name: 'xterm-256color', cols: 120, rows: 30, cwd: CWD, env: { Path: 'C:\\Windows' }, useConpty: true })
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await tick(5)
  }
}
function fakeDirect(): IPty {
  return { pid: 1, cols: 80, rows: 24, process: 'x', handleFlowControl: false, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), resize() {}, clear() {}, write() {}, kill() {}, pause() {}, resume() {} } as unknown as IPty
}

const CLAUDE_TAB = 'abcdef0123456789abcdee11'
const OTHER_TAB = 'abcdef0123456789abcdee12'
const CONV = '019dd000-0001-7000-8000-00000000001a'
const OTHER_CONV = '019dd000-0002-7000-8000-00000000001b'
const HOOK_FOLDER = join(tmpdir(), 'aicc-data', 'codex-hooks', 'ccc-codex-hook-XyZ789')
const claudeTab = (sessionId: string) => ({ sessionId, kind: 'claude' as const })
const otherTab = (sessionId: string) => ({ sessionId, kind: 'codex' as const })
const claudeSid = heldAgentSessionId(CLAUDE_TAB, 'claude')
const otherSid = heldAgentSessionId(OTHER_TAB, 'codex')
const ON_AGENTS = { atStartup: true, plain: false, agents: true }
const SAVED = new Set([CLAUDE_TAB, OTHER_TAB])
const SIZE = { cols: 120, rows: 30 }

let dir: string
let bundled: string
let root: string
let helper: FakeHelper
let logs: string[]
const managers: SessionHelperManager[] = []
const starts: Promise<unknown>[] = []
const gone = new WeakSet<SessionHelperManager>()

let facts: Record<string, KeptLaunchFacts>
let removed: KeptLaunch[]
/** Every stream the stand-in tool host was asked to serve, with what it was told. */
let served: Array<{ id: string; link: HelperToolLink; opts: { toolsChanged?: boolean } | undefined }>
/** The same, for the other provider's (Codex's) tool functions. */
let servedOther: Array<{ id: string; opts: { toolsChanged?: boolean } | undefined }>
/** Every hook event the stand-in signals module was handed. */
let events: Array<{ id: string; e: HookEventFrame }>
/** B1e: each tab whose hook record the stand-in signals module was told is over (endHelperHooks). */
let endedHooks: string[]
/** The saved tabs the stand-in app-wiring answers; null: none given. */
let savedTabs: ReadonlySet<string> | null
/** Whether Claude Code's tool functions say its CLI lists its tools again. */
let listsAgain: boolean | undefined

function claudeTools(): HelperToolDeps {
  return {
    serve: (id, link, opts) => { served.push({ id, link, opts }); return true },
    serving: () => true,
    useRelayConfig: () => 'switched',
    ...(listsAgain === undefined ? {} : { listsAgain }),
  }
}
const otherTools: HelperToolDeps = { serve: (id, _link, opts) => { servedOther.push({ id, opts }); return true }, serving: () => true, relayLaunch: (_id, launch) => ({ args: typeof launch.args === 'string' ? launch.args : [...launch.args] }) }
const hooks: HelperHookDeps = { taking: () => true, useHelperHooks: () => 'switched', event: (id, e) => { events.push({ id, e }) }, ended: (id) => { endedHooks.push(id) } }

function makeManager(o: { takeOver?: false | 'claude' | 'both'; waitMs?: number; serveMs?: number } = {}): SessionHelperManager {
  let self: SessionHelperManager | undefined
  const alive = () => { if (self && gone.has(self)) throw new Error('this app is gone') }
  const m = new SessionHelperManager({
    platform: 'win32', root, bundled,
    exec: async (file, args) => { alive(); return helper.exec(file, args) },
    openStream: async (endpoint) => { alive(); return helper.openStream(endpoint) },
    spawnDirect: (file, args, opts) => ptySpawn(file, args, opts),
    conptySource: () => null,
    log: (l) => logs.push(l),
    hooks: { claude: hooks },
    tools: { claude: claudeTools(), codex: otherTools },
    ...(o.takeOver === false ? {} : { takeOver: o.takeOver === 'both' ? { claude: true as const, codex: true as const } : { claude: true as const } }),
    ...(savedTabs ? { savedTabs: () => savedTabs! } : {}),
    ...(o.waitMs !== undefined ? { keptTakeOverWaitMs: o.waitMs } : {}),
    ...(o.serveMs !== undefined ? { unseenServeAfterMs: o.serveMs } : {}),
  })
  self = m
  managers.push(m)
  const start = m.start.bind(m)
  m.start = (opts) => { const p = start(opts); starts.push(p); return p }
  return m
}

async function startedWith(m: SessionHelperManager, o = ON_AGENTS): Promise<SessionHelperManager> {
  await m.start(o)
  await until(() => m.serviceState().state === 'ready', 'the helper to be ready')
  setSessionHelper(m)
  return m
}

/** The app exits for the installer: no quit, so nothing more reaches a holder from it. */
function exit(m: SessionHelperManager): void {
  managers.splice(managers.indexOf(m), 1)
  gone.add(m)
  setSessionHelper(null)
  for (const h of helper.holders.values()) h.dropAll()
}

const keptDir = () => join(root, 'kept')
const keptOnDisk = (): string[] => (existsSync(keptDir()) ? readdirSync(keptDir()).sort() : [])
const markerFile = () => join(root, 'app-running.json')

beforeEach(() => {
  ptySpawn.mockReset()
  ptySpawn.mockImplementation(() => fakeDirect())
  dir = mkdtempSync(join(tmpdir(), 'aicc-helper-takeover-'))
  mkdirSync(join(dir, 'install', 'helper'), { recursive: true })
  bundled = join(dir, 'install', 'helper', 'aicc-helper.exe')
  writeFileSync(bundled, 'MZ the installed helper')
  root = join(dir, 'user', 'helper')
  helper = new FakeHelper()
  logs = []
  facts = {
    [CLAUDE_TAB]: { conversation: CONV, account: 'profile-mt4okz66-147e4a', hookFolder: null },
    [OTHER_TAB]: { conversation: OTHER_CONV, account: 'acct-7', hookFolder: HOOK_FOLDER },
  }
  removed = []
  served = []
  servedOther = []
  events = []
  endedHooks = []
  savedTabs = null
  listsAgain = true
  setKeptLaunchBindings({ describe: (id) => facts[id] ?? { conversation: null, account: null, hookFolder: null }, remove: (k) => { removed.push(k) } })
})

afterEach(async () => {
  const quits = managers.splice(0).map((m) => { try { return m.shutdown() } catch { return null } })
  setSessionHelper(null)
  setKeptLaunchBindings(null)
  for (const h of helper.holders.values()) h.dropAll()
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.allSettled([...quits, ...starts.splice(0)]),
    new Promise<void>((r) => { timer = setTimeout(r, 3000) }),
  ]).finally(() => clearTimeout(timer))
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
  } catch (err) {
    process.stderr.write(`session-helper-take-over: left ${dir} behind (${(err as NodeJS.ErrnoException).code ?? String(err)})\n`)
  }
})

/** A holder of this session that `hold` started after `prev`, attached. */
function freshAttached(sid: string, prev: FakeHolder | undefined): boolean {
  const h = helper.holders.get(sid)
  return !!h && h !== prev && !!h.attached
}

/**
 * Run 1: a Claude Code tab and a Codex tab through their holders, both saved,
 * the Claude Code tab with a tool stream its relay kept when the link goes;
 * the update lets both go, kills every PTY and exits. Then, in the gap, the
 * CLI writes and its hook mode posts an event, which its holder queues.
 */
async function updated(): Promise<{ hc: FakeHolder; ho: FakeHolder; stream: number }> {
  const m1 = await startedWith(makeManager())
  const claude = spawnAgentPty(claudeTab(CLAUDE_TAB), SHELL, [], agentOpts())
  const other = spawnAgentPty(otherTab(OTHER_TAB), SHELL, [], agentOpts())
  await until(() => freshAttached(claudeSid, undefined) && freshAttached(otherSid, undefined), 'both sessions to attach')
  const hc = helper.holders.get(claudeSid)!
  const ho = helper.holders.get(otherSid)!
  hc.output('claude says hello\r\n')
  const stream = hc.openToolStream({ away: true })!
  ho.openToolStream({ away: true })
  await until(() => served.length === 1 && servedOther.length === 1, 'run 1 to serve both tool streams')
  m1.noteSavedTabs([{ id: CLAUDE_TAB, label: 'Claude' }, { id: OTHER_TAB, label: 'Other' }])
  expect(m1.releaseForUpdate(SAVED)).toBe(2)
  claude.kill()
  other.kill()
  exit(m1)
  await until(() => hc.conns.size === 0 && ho.conns.size === 0, 'run 1 to let go')
  expect(hc.keptStreams.has(stream)).toBe(true)
  hc.output('written while no app was there\r\n')
  hc.hookEvent('Stop', { hook_event_name: 'Stop', session_id: CONV })
  served = []
  servedOther = []
  return { hc, ho, stream }
}

describe('the next start after an update: a restored tab takes its kept session over (S16 steps 5 and 6)', () => {
  it('keeps the Claude Code session for its tab and ends the other provider\'s; the tab takes it over with no launch: the same holder attached, its replay shown, the queued hook event delivered, the kept tool stream given back and served with toolsChanged; the record goes, the files stay', async () => {
    const beforeRelease = Date.now()
    const { hc, ho, stream } = await updated()
    const afterRelease = Date.now()
    const holdsBefore = helper.holds()
    logs.length = 0
    const m2 = makeManager()
    void m2.start(ON_AGENTS)
    setSessionHelper(m2)
    // Synchronous: decided before any tab can start.
    expect(logs).toContain(`[session-helper] ${claudeSid}: the last run's update kept this claude session of tab ${CLAUDE_TAB} running (conversation ${CONV}, account profile-mt4okz66-147e4a, hook folder none); it is kept for its tab to take over`)
    expect(logs).toContain(`[session-helper] ${otherSid}: the last run's update kept this codex session of tab ${OTHER_TAB} running (conversation ${OTHER_CONV}, account acct-7, hook folder ccc-codex-hook-XyZ789); it is ended, and its tab resumes the conversation as before, because a take-over of this provider's sessions is not built`)
    expect(logs).toContain('[session-helper] the app was updated; 0 held terminal(s) may be shown again, 1 agent session(s) are kept for their tabs to take over, and 1 agent session(s) it held are ended')
    // The kept one's record and files stay for its tab (and the start-up sweeps pass them by); the other's go.
    expect(keptOnDisk()).toEqual([`${claudeSid}.json`])
    expect(keptSessionIdsIn(root)).toEqual(new Set([CLAUDE_TAB]))
    expect(removed).toEqual([{ sessionId: OTHER_TAB, provider: 'codex', hookFolder: HOOK_FOLDER }])
    await until(() => ho.ended, 'the other provider\'s session to be ended')
    // A keeper holds the kept one: it takes neither the queued event nor the kept stream.
    await until(() => !!hc.attached, 'the keeper to attach')
    expect(hc.attached!.ackedCaps).not.toContain('hooks')
    expect(hc.attached!.ackedCaps).not.toContain('mcp')
    expect(hc.waitingEvents).toHaveLength(1)
    expect(hc.keptStreams.has(stream)).toBe(true)

    // The restored tab's launch asks for it, as launch-bindings.ts does.
    const taken = takeKeptSession(CLAUDE_TAB, 'claude', SIZE)
    expect(taken).not.toBeNull()
    // `at`: when the update let go of it, read back from its record (the take-over's not-indexed windows open from it).
    expect(taken!.kept).toMatchObject({ conversation: CONV, account: 'profile-mt4okz66-147e4a', hookFolder: null, folder: CWD, at: expect.any(Number) })
    expect(taken!.kept.at).toBeGreaterThanOrEqual(beforeRelease)
    expect(taken!.kept.at).toBeLessThanOrEqual(afterRelease)
    const shown: string[] = []
    taken!.pty.onData((d) => shown.push(d))
    await until(() => !!hc.attached && hc.attached.ackedCaps.includes('hooks') && hc.attached.ackedCaps.includes('mcp'), 'the tab to attach with hooks and tools')
    // No launch: no second holder, no second launch, no usual start.
    expect(helper.holds()).toBe(holdsBefore)
    expect(hc.requests.filter((r) => r.t === 'term.launch')).toHaveLength(1)
    expect(ptySpawn).not.toHaveBeenCalled()
    expect(hc.ended).toBe(false)
    // The replay, the gap's output included.
    await until(() => shown.join('').includes('written while no app was there'), 'the replay')
    expect(shown.join('')).toContain('claude says hello')
    // The hook event posted in the gap reaches the signals module under the tab's id.
    await until(() => events.length === 1, 'the queued hook event')
    expect(events[0].id).toBe(CLAUDE_TAB)
    expect(events[0].e.kind).toBe('Stop')
    // The kept stream is given back on the take-over's connection and served, the CLI told its tool list may have changed.
    await until(() => served.length === 1, 'the kept stream to be served')
    expect(served[0]).toMatchObject({ id: CLAUDE_TAB, opts: { toolsChanged: true } })
    expect(hc.relayTold.filter((t) => t.stream === stream).map((t) => t.t)).toEqual(['mcp.away', 'mcp.back'])
    // What the tool host sends reaches the CLI on that stream.
    served[0].link.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    await until(() => hc.toolSent.length === 1, 'the message to reach the relay')
    // The record goes; the files are the session's again (removed at its end).
    expect(keptOnDisk()).toEqual([])
    expect(removed.map((k) => k.sessionId)).toEqual([OTHER_TAB])
    expect(logs).toContain(`[session-helper] ${claudeSid}: tab ${CLAUDE_TAB} takes over the claude session the last run's update kept running, with no launch (conversation ${CONV}, account profile-mt4okz66-147e4a, hook folder none)`)
    // Asked again: nothing more is kept for it.
    expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE)).toBeNull()
    // Typed input reaches the same CLI.
    taken!.pty.write('next prompt\r')
    await until(() => hc.input.some((b) => b.toString('utf8').includes('next prompt')), 'typed input to reach it')
    // Listed once, with its tab open.
    await until(() => m2.serviceState().state === 'ready', 'the helper to be ready')
    const status = await m2.status()
    expect(status.sessions.filter((s) => s.id === claudeSid)).toEqual([expect.objectContaining({ kind: 'claude', tabOpen: true, attached: true })])
  })

  it('the next update keeps a taken-over session again: its routes are on', async () => {
    const { hc } = await updated()
    const m2 = await startedWith(makeManager())
    const taken = takeKeptSession(CLAUDE_TAB, 'claude', SIZE)!
    await until(() => !!hc.attached?.ackedCaps.includes('mcp'), 'the take-over to attach')
    await until(() => served.length === 1, 'the kept stream to be served')
    m2.noteSavedTabs([{ id: CLAUDE_TAB, label: 'Claude' }])
    expect(m2.releaseForUpdate(new Set([CLAUDE_TAB]))).toBe(1)
    expect(keptOnDisk()).toEqual([`${claudeSid}.json`])
    taken.pty.kill()
    await until(() => hc.conns.size === 0, 'the session to be let go of')
    expect(hc.ended).toBe(false)
  })

  it('a provider whose CLI does not list its tools again: the kept stream is served with nothing more said', async () => {
    listsAgain = undefined
    const { hc } = await updated()
    await startedWith(makeManager())
    takeKeptSession(CLAUDE_TAB, 'claude', SIZE)
    await until(() => !!hc.attached?.ackedCaps.includes('mcp'), 'the take-over to attach')
    await until(() => served.length === 1, 'the kept stream to be served')
    expect(served[0].opts).toBeUndefined()
  })

  it('a stream on a later connection of the take-over (the link dropped and came back) is served with nothing more said', async () => {
    const { hc } = await updated()
    await startedWith(makeManager())
    takeKeptSession(CLAUDE_TAB, 'claude', SIZE)
    await until(() => !!hc.attached?.ackedCaps.includes('mcp'), 'the take-over to attach')
    await until(() => served.length === 1, 'the kept stream to be served')
    const first = hc.attached
    hc.fallBehind()
    await until(() => !!hc.attached && hc.attached !== first && hc.attached.ackedCaps.includes('mcp'), 'the attach again')
    await until(() => served.length === 2, 'the stream to be served again')
    expect(served[1].opts).toBeUndefined()
  })
})

describe('the next start after an update: a kept session no tab takes over is ended as before', () => {
  /** A start of a new run, made this run's manager. */
  async function nextStart(m: SessionHelperManager, o = ON_AGENTS): Promise<void> {
    await m.start(o)
    setSessionHelper(m)
  }

  /** The start ended the kept Claude Code session: no take-over, its record and files gone, its holder ended. */
  async function endedAtStart(hc: FakeHolder, why: string): Promise<void> {
    expect(logs.some((l) => l.startsWith(`[session-helper] ${claudeSid}: the last run's update kept this claude session`) && l.endsWith(`it is ended, and its tab resumes the conversation as before, because ${why}`))).toBe(true)
    expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE)).toBeNull()
    expect(keptOnDisk()).toEqual([])
    expect(removed.map((k) => k.sessionId).sort()).toEqual([CLAUDE_TAB, OTHER_TAB])
    await until(() => hc.ended, 'the kept session to be ended')
  }

  it('its tab is not among the saved sessions this start restores', async () => {
    const { hc } = await updated()
    savedTabs = new Set([OTHER_TAB])
    logs.length = 0
    await nextStart(makeManager())
    await endedAtStart(hc, 'its tab is not among the saved sessions')
  })

  it('the start does not follow an update (the running mark says a crash)', async () => {
    const { hc } = await updated()
    writeFileSync(markerFile(), JSON.stringify({ v: 1, pid: 1, at: 1 }))
    logs.length = 0
    await nextStart(makeManager())
    await endedAtStart(hc, 'this start does not follow an app update')
  })

  it('the agent sessions\' setting is off at the start', async () => {
    const { hc } = await updated()
    logs.length = 0
    await nextStart(makeManager(), { atStartup: true, plain: false, agents: false })
    await endedAtStart(hc, 'agent sessions do not go through the session helper now')
  })

  it('no take-over is wired for the provider (the end at start, as before)', async () => {
    const { hc } = await updated()
    logs.length = 0
    await nextStart(makeManager({ takeOver: false }))
    await endedAtStart(hc, 'a take-over of this provider\'s sessions is not built')
  })

  it('its holder ended in the gap (its record is no longer in the store)', async () => {
    const { hc, ho } = await updated()
    for (const h of [hc, ho]) {
      h.vanish()
      rmSync(join(root, 'store', `${h.sid}.json`), { force: true })
    }
    logs.length = 0
    await nextStart(makeManager())
    expect(logs.some((l) => l.includes(`${claudeSid}: the last run's update kept this claude session`) && l.endsWith("because its holder's record is not in the store (its holder ended)"))).toBe(true)
    expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE)).toBeNull()
    expect(keptOnDisk()).toEqual([])
  })

  it('its tab starts a new CLI instead: the kept session is ended first, its record and files go, then the new CLI starts', async () => {
    const { hc } = await updated()
    const m2 = makeManager()
    void m2.start(ON_AGENTS)
    setSessionHelper(m2)
    const holdsBefore = helper.holds()
    spawnAgentPty(claudeTab(CLAUDE_TAB), SHELL, [], agentOpts())
    expect(logs).toContain(`[session-helper] ${claudeSid}: the session kept for tab ${CLAUDE_TAB} to take over is ended, because its tab started a new CLI instead of taking it over`)
    expect(keptOnDisk()).toEqual([])
    expect(removed.map((k) => k.sessionId).sort()).toEqual([CLAUDE_TAB, OTHER_TAB])
    await until(() => hc.ended, 'the kept session to be ended')
    await until(() => helper.holds() === holdsBefore + 1 && freshAttached(claudeSid, hc), 'the new CLI after that end')
    expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE)).toBeNull()
  })

  it('its tab does not take it over in time: it is ended, its record and files go', async () => {
    const { hc } = await updated()
    await nextStart(makeManager({ waitMs: 60 }))
    await until(() => hc.ended, 'the kept session to be ended')
    expect(logs).toContain(`[session-helper] ${claudeSid}: the session kept for tab ${CLAUDE_TAB} to take over is ended, because its tab did not take it over within 60 ms`)
    expect(keptOnDisk()).toEqual([])
    expect(removed.map((k) => k.sessionId).sort()).toEqual([CLAUDE_TAB, OTHER_TAB])
    expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE)).toBeNull()
  })

  it('its holder cannot be reached at the start (gone, its store record left, as after a reboot during the update): ended, its record and files go, and its tab starts a new CLI', async () => {
    const { hc } = await updated()
    hc.vanish()
    logs.length = 0
    await startedWith(makeManager())
    await until(() => logs.includes(`[session-helper] ${claudeSid}: the session kept for tab ${CLAUDE_TAB} to take over is ended, because its holder could not be reached`), 'the keeper to give it up')
    expect(keptOnDisk()).toEqual([])
    expect(removed.map((k) => k.sessionId)).toContain(CLAUDE_TAB)
    expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE)).toBeNull()
    spawnAgentPty(claudeTab(CLAUDE_TAB), SHELL, [], agentOpts())
    await until(() => freshAttached(claudeSid, hc), 'a new holder for the new CLI')
  })

  it('a take-over that cannot attach (its holder went after the keeper attached): the tab says so and exits 1, and nothing starts in its place', async () => {
    const { hc } = await updated()
    await startedWith(makeManager())
    await until(() => !!hc.attached, 'the keeper to attach')
    const holdsBefore = helper.holds()
    hc.vanish()
    logs.length = 0
    const taken = takeKeptSession(CLAUDE_TAB, 'claude', SIZE)
    expect(taken).not.toBeNull()
    const shown: string[] = []
    let exitCode: number | undefined
    taken!.pty.onData((d) => shown.push(d))
    taken!.pty.onExit((e) => { exitCode = e.exitCode })
    await until(() => exitCode !== undefined, 'the take-over to end')
    expect(shown.join('')).toContain(HELPER_SENTENCES.agentNotTakenOver)
    expect(exitCode).toBe(1)
    expect(ptySpawn).not.toHaveBeenCalled()
    expect(helper.holds()).toBe(holdsBefore)
    expect(keptOnDisk()).toEqual([])
    expect(logs.some((l) => l.startsWith(`[session-helper] ${claudeSid}: nothing is started for this terminal, because the held terminal could not be reached`))).toBe(true)
    expect(logs.some((l) => l.includes('starting it the usual way'))).toBe(false)
  })

  it('a normal quit before its tab took it over ends it, and its record and files go', async () => {
    const { hc } = await updated()
    const m2 = await startedWith(makeManager())
    await until(() => !!hc.attached, 'the keeper to attach')
    const done = m2.shutdown()
    expect(done).not.toBeNull()
    await done
    managers.splice(managers.indexOf(m2), 1)
    expect(hc.ended).toBe(true)
    expect(keptOnDisk()).toEqual([])
    expect(removed.map((k) => k.sessionId).sort()).toEqual([CLAUDE_TAB, OTHER_TAB])
  })
})

describe('a Codex session an update kept running (B1.2)', () => {
  it('its restored tab, on the account the session runs on, takes it over with no launch: the kept tool stream is served with nothing more said (Codex does not list its tools again), and a colour query in the replay is not passed on', async () => {
    const beforeRelease = Date.now()
    const { ho } = await updated()
    const afterRelease = Date.now()
    // The CLI asked its terminal's colour in the gap: the replay must not carry it on.
    ho.output('\x1b]11;?\x07before the take-over\r\n')
    const holdsBefore = helper.holds()
    logs.length = 0
    await startedWith(makeManager({ takeOver: 'both' }))
    expect(logs).toContain(`[session-helper] ${otherSid}: the last run's update kept this codex session of tab ${OTHER_TAB} running (conversation ${OTHER_CONV}, account acct-7, hook folder ccc-codex-hook-XyZ789); it is kept for its tab to take over`)
    expect(keptOnDisk()).toEqual([`${claudeSid}.json`, `${otherSid}.json`].sort())
    const taken = takeKeptSession(OTHER_TAB, 'codex', SIZE, 'acct-7')
    expect(taken).not.toBeNull()
    expect(taken!.kept).toMatchObject({ conversation: OTHER_CONV, account: 'acct-7', hookFolder: HOOK_FOLDER, folder: CWD, at: expect.any(Number) })
    expect(taken!.kept.at).toBeGreaterThanOrEqual(beforeRelease)
    expect(taken!.kept.at).toBeLessThanOrEqual(afterRelease)
    const shown: string[] = []
    taken!.pty.onData((d) => shown.push(d))
    await until(() => !!ho.attached?.ackedCaps.includes('mcp'), 'the take-over to attach')
    await until(() => shown.join('').includes('before the take-over'), 'the replay')
    expect(shown.join('')).not.toContain('\x1b]11;?')
    await until(() => servedOther.length === 1, 'the kept stream to be served')
    expect(servedOther[0]).toEqual({ id: OTHER_TAB, opts: undefined })
    expect(helper.holds()).toBe(holdsBefore)
    expect(ho.requests.filter((r) => r.t === 'term.launch')).toHaveLength(1)
    expect(ptySpawn).not.toHaveBeenCalled()
    expect(keptOnDisk()).toEqual([`${claudeSid}.json`])
    expect(removed.map((k) => k.sessionId)).toEqual([])
  })

  it('its tab\'s launch prepared on another account: not taken over, and the launch that follows ends it first', async () => {
    const { ho } = await updated()
    const m2 = await startedWith(makeManager({ takeOver: 'both' }))
    expect(takeKeptSession(OTHER_TAB, 'codex', SIZE, 'acct-other')).toBeNull()
    expect(logs).toContain(`[session-helper] ${otherSid}: the kept session runs on another account than tab ${OTHER_TAB}'s launch, so the tab starts a new CLI`)
    expect(keptOnDisk()).toContain(`${otherSid}.json`)
    void m2
    spawnAgentPty(otherTab(OTHER_TAB), SHELL, [], agentOpts())
    expect(logs).toContain(`[session-helper] ${otherSid}: the session kept for tab ${OTHER_TAB} to take over is ended, because its tab started a new CLI instead of taking it over`)
    await until(() => ho.ended, 'the kept session to be ended')
    expect(removed).toEqual([{ sessionId: OTHER_TAB, provider: 'codex', hookFolder: HOOK_FOLDER }])
  })
})

describe('a Codex session an update kept running on its resume list (aicc_planning#419)', () => {
  const PICK_DIR = join(tmpdir(), 'ccc-codex-pick-Ab12Cd')
  const PICK = { file: join(PICK_DIR, 'pick.json'), folder: { id: '1234567:89012345', real: PICK_DIR }, decided: { fresh: 1_790_000_000_000 } }
  const recordFile = () => join(keptDir(), `${otherSid}.json`)

  it('the release records its pick (the file, the folder as made, the decision read last), and the next start hands it to the tab that takes it over', async () => {
    facts[OTHER_TAB] = { conversation: null, account: 'acct-7', hookFolder: HOOK_FOLDER, pick: PICK }
    await updated()
    expect(JSON.parse(readFileSync(recordFile(), 'utf8')).pick).toEqual(PICK)
    await startedWith(makeManager({ takeOver: 'both' }))
    const taken = takeKeptSession(OTHER_TAB, 'codex', SIZE, 'acct-7')
    expect(taken).not.toBeNull()
    expect(taken!.kept.pick).toEqual(PICK)
  })

  it('one no tab takes over is ended, its pick handed to the removal with its other files', async () => {
    facts[OTHER_TAB] = { conversation: null, account: 'acct-7', hookFolder: HOOK_FOLDER, pick: PICK }
    const { ho } = await updated()
    await startedWith(makeManager())
    await until(() => ho.ended, 'the Codex session to be ended')
    expect(removed).toEqual([{ sessionId: OTHER_TAB, provider: 'codex', hookFolder: HOOK_FOLDER, pick: PICK }])
  })

  it.each([
    ['a file not named pick.json', { ...PICK, file: join(PICK_DIR, 'notes.txt') }],
    ['a relative file', { ...PICK, file: join('ccc-codex-pick-Ab12Cd', 'pick.json') }],
    ['a folder id that is not a device and file id', { ...PICK, folder: { ...PICK.folder, id: '../x' } }],
    ['a relative real folder', { ...PICK, folder: { ...PICK.folder, real: 'ccc-codex-pick-Ab12Cd' } }],
    ['no folder', { file: PICK.file }],
  ])('a record whose pick is %s reads with no pick', async (_what, bad) => {
    facts[OTHER_TAB] = { conversation: null, account: 'acct-7', hookFolder: HOOK_FOLDER, pick: PICK }
    await updated()
    // Written over on disk, as a record the start acts on could be.
    writeFileSync(recordFile(), JSON.stringify({ ...JSON.parse(readFileSync(recordFile(), 'utf8')), pick: bad }))
    await startedWith(makeManager({ takeOver: 'both' }))
    const taken = takeKeptSession(OTHER_TAB, 'codex', SIZE, 'acct-7')
    expect(taken).not.toBeNull()
    expect(taken!.kept.pick).toBeUndefined()
    expect(taken!.kept.hookFolder).toBe(HOOK_FOLDER)
  })

  it('a decision that does not read is left out; the pick stays', async () => {
    facts[OTHER_TAB] = { conversation: null, account: 'acct-7', hookFolder: HOOK_FOLDER, pick: PICK }
    await updated()
    writeFileSync(recordFile(), JSON.stringify({ ...JSON.parse(readFileSync(recordFile(), 'utf8')), pick: { ...PICK, decided: { id: '--config=x' } } }))
    await startedWith(makeManager({ takeOver: 'both' }))
    expect(takeKeptSession(OTHER_TAB, 'codex', SIZE, 'acct-7')!.kept.pick).toEqual({ file: PICK.file, folder: PICK.folder })
  })
})

describe('a kept record\'s launch folder is read by the rule the helper checks a launch folder by, on the helper\'s system', () => {
  const recordFile = () => join(keptDir(), `${claudeSid}.json`)

  // These managers run the Windows helper (platform win32) on whatever system
  // runs the test, so the folder is read by the Windows rule on every one.
  it.each([
    ['a folder on a drive: read', CWD, CWD],
    ['a folder with no drive (rooted, as Unix writes one): none', '/home/someone/project', null],
    ['a folder relative to a drive: none', 'C:project', null],
  ])('%s', async (_what, folder, read) => {
    await updated()
    // Written over on disk, as a record the start acts on could be.
    writeFileSync(recordFile(), JSON.stringify({ ...JSON.parse(readFileSync(recordFile(), 'utf8')), folder }))
    await startedWith(makeManager())
    const taken = takeKeptSession(CLAUDE_TAB, 'claude', SIZE)
    expect(taken).not.toBeNull()
    expect(taken!.kept.folder).toBe(read)
  })
})

/**
 * aicc_planning#423 (beta.17 B1c): a restored tab that is not on screen
 * mounts its terminal only when it is shown (App.tsx renders it with
 * display: none, and TerminalView waits for a size before it starts), so its
 * take-over is asked for only then. The renderer says which tabs Resume
 * restored (restoredTabs), and which tab is shown and starts (tabShown); a
 * close says which tab went (tabClosed), each for that tab's session alone;
 * the Machines page reads the kept session as a tab's, not as being ended.
 * The default 5-minute limit runs under fake timers. The three are called
 * optionally (`?.`): on the code
 * before this fix they do not exist, and each case fails on what it checks.
 */
describe('a restored tab not on screen keeps the session an update kept for it until it is shown (aicc_planning#423)', () => {
  const FIVE_MIN = 5 * 60_000
  /** Every kept session the stand-in launch bindings were asked to hold. */
  let held: KeptLaunch[]
  beforeEach(() => {
    held = []
    setKeptLaunchBindings({ describe: (id) => facts[id] ?? { conversation: null, account: null, hookFolder: null }, remove: (k) => { removed.push(k) }, hold: (k) => { held.push(k) } })
  })
  /** Fake setTimeout and clearTimeout for `run`, the clock still moving with real time. */
  async function withFakeTimers(run: () => Promise<void>): Promise<void> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try { await run() } finally { vi.useRealTimers() }
  }
  /** The kept Claude Code session after a start that follows the update, its
   *  keeper attached and the other provider's session ended. */
  async function keptAtNextStart(o: { takeOver?: 'both' } = {}): Promise<{ m2: SessionHelperManager; hc: FakeHolder; ho: FakeHolder; stream: number }> {
    const run1 = await updated()
    logs.length = 0
    const m2 = await startedWith(makeManager(o))
    await until(() => !!run1.hc.attached, 'the keeper to attach')
    if (!o.takeOver) await until(() => run1.ho.ended, 'the other provider\'s session to be ended')
    return { m2, ...run1 }
  }
  const endedForTime = () => logs.some((l) => l.includes(`${claudeSid}: the session kept for tab ${CLAUDE_TAB} to take over is ended, because its tab did not take it over within`))

  it('its tab restored and not shown: past the 5-minute limit the session is still kept, its record and files with it; shown, the tab takes it over with the same CLI and no launch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      const { m2, hc, stream } = await keptAtNextStart()
      // Resume: the renderer restores the tab (session-persistence.ts) and
      // says so; the tab is not the one on screen, so nothing asks for it.
      m2.restoredTabs?.([{ id: CLAUDE_TAB }, { id: OTHER_TAB }])
      await vi.advanceTimersByTimeAsync(FIVE_MIN + 60_000)
      expect(endedForTime(), 'not ended by the time limit').toBe(false)
      expect(hc.ended).toBe(false)
      expect(keptOnDisk()).toEqual([`${claudeSid}.json`])
      expect(removed.map((k) => k.sessionId)).toEqual([OTHER_TAB])
      // B1e: the hook event its holder queued was taken while the tab was not shown (its keeper acks hooks).
      await until(() => events.length === 1, 'the queued hook event while the tab is not shown')
      expect(hc.waitingEvents).toEqual([])
      // Shown much later: its view starts, and its spawn asks for the take-over.
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(hc.ended).toBe(false)
      m2.tabShown?.(CLAUDE_TAB)
      const holdsBefore = helper.holds()
      const taken = takeKeptSession(CLAUDE_TAB, 'claude', SIZE)
      expect(taken).not.toBeNull()
      const shown: string[] = []
      taken!.pty.onData((d) => shown.push(d))
      await until(() => !!hc.attached && hc.attached.ackedCaps.includes('hooks') && hc.attached.ackedCaps.includes('mcp'), 'the tab to attach with hooks and tools')
      expect(helper.holds()).toBe(holdsBefore)
      expect(hc.requests.filter((r) => r.t === 'term.launch')).toHaveLength(1)
      expect(ptySpawn).not.toHaveBeenCalled()
      await until(() => shown.join('').includes('written while no app was there'), 'the replay')
      await until(() => events.length === 1, 'the hook event its holder queued meanwhile')
      await until(() => served.length === 1, 'the kept tool stream to be served')
      expect(hc.keptStreams.has(stream)).toBe(false)
      expect(keptOnDisk()).toEqual([])
      expect(hc.ended).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('its tab restored and closed before it was shown (told through the seam the pty handlers use): ended at once, its record and files go, and nothing is kept for it', async () => {
    await withFakeTimers(async () => {
      const { hc } = await keptAtNextStart()
      const seam = keptSeam as Partial<typeof keptSeam>
      seam.keptTabsRestored?.([{ id: CLAUDE_TAB }])
      await vi.advanceTimersByTimeAsync(FIVE_MIN + 60_000)
      expect(hc.ended).toBe(false)
      seam.keptTabClosed?.(CLAUDE_TAB)
      expect(logs).toContain(`[session-helper] ${claudeSid}: the session kept for tab ${CLAUDE_TAB} to take over is ended, because its tab was closed`)
      expect(keptOnDisk()).toEqual([])
      expect(removed.map((k) => k.sessionId).sort()).toEqual([CLAUDE_TAB, OTHER_TAB])
      await until(() => hc.ended, 'the kept session to be ended')
      expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE)).toBeNull()
    })
  })

  it('a tab Resume did not restore (the resume prompt answered with other tabs, or not at all): ended when its 5-minute limit runs out, as before', async () => {
    await withFakeTimers(async () => {
      const { m2, hc } = await keptAtNextStart()
      m2.restoredTabs?.([{ id: OTHER_TAB }])
      // Its limit began at the start, before keptAtNextStart's waits, and fake
      // time also moves with real time: 4 minutes leaves those waits room.
      await vi.advanceTimersByTimeAsync(FIVE_MIN - 60_000)
      expect(hc.ended).toBe(false)
      await vi.advanceTimersByTimeAsync(61_000)
      expect(logs).toContain(`[session-helper] ${claudeSid}: the session kept for tab ${CLAUDE_TAB} to take over is ended, because its tab did not take it over within ${FIVE_MIN} ms`)
      await until(() => hc.ended, 'the kept session to be ended')
      expect(keptOnDisk()).toEqual([])
      expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE)).toBeNull()
    })
  })

  it('its tab shown with no take-over asked (its launch waiting at its account picker; told through the seam): ended 5 minutes after it was shown, not before', async () => {
    await withFakeTimers(async () => {
      const { m2, hc } = await keptAtNextStart()
      m2.restoredTabs?.([{ id: CLAUDE_TAB }])
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      ;(keptSeam as Partial<typeof keptSeam>).keptTabShown?.(CLAUDE_TAB)
      expect(logs).toContain(`[session-helper] ${claudeSid}: tab ${CLAUDE_TAB} is shown, so the session kept for it waits for its take-over from now`)
      await vi.advanceTimersByTimeAsync(FIVE_MIN - 1_000)
      expect(hc.ended).toBe(false)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(logs).toContain(`[session-helper] ${claudeSid}: the session kept for tab ${CLAUDE_TAB} to take over is ended, because its tab did not take it over within ${FIVE_MIN} ms of being shown`)
      await until(() => hc.ended, 'the kept session to be ended')
      expect(keptOnDisk()).toEqual([])
    })
  })

  it('two tabs restored, only the other shown, and a tab with no kept session closed: the 5 minutes run for the shown tab\'s session alone, and a close ends only the session kept for that tab', async () => {
    await withFakeTimers(async () => {
      // Both providers kept; Resume restores both tabs and shows the other
      // one (the tab on screen), and a tab with nothing kept for it is closed.
      const { m2, hc, ho } = await keptAtNextStart({ takeOver: 'both' })
      m2.restoredTabs?.([{ id: CLAUDE_TAB }, { id: OTHER_TAB }])
      m2.tabShown?.(OTHER_TAB)
      m2.tabClosed?.('abcdef0123456789abcdee13')
      await vi.advanceTimersByTimeAsync(FIVE_MIN + 60_000)
      expect(endedForTime(), 'the hidden tab\'s session is not ended by the time limit').toBe(false)
      expect(hc.ended).toBe(false)
      expect(keptOnDisk()).toEqual([`${claudeSid}.json`])
      expect(logs).toContain(`[session-helper] ${otherSid}: the session kept for tab ${OTHER_TAB} to take over is ended, because its tab did not take it over within ${FIVE_MIN} ms of being shown`)
      await until(() => ho.ended, 'the shown tab\'s session to be ended')
      // Its tab closed afterwards: nothing is kept for it, and the hidden
      // tab's session stays kept for its own take-over.
      m2.tabClosed?.(OTHER_TAB)
      expect(hc.ended).toBe(false)
      expect(keptOnDisk()).toEqual([`${claudeSid}.json`])
      expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE)).not.toBeNull()
      await until(() => !!hc.attached && hc.attached.ackedCaps.includes('hooks') && hc.attached.ackedCaps.includes('mcp'), 'the hidden tab to take its session over')
      expect(hc.ended).toBe(false)
    })
  })

  it('on the Machines page, a session kept for its restored tab reads as a tab\'s (waiting for the app), not as one being ended', async () => {
    const { m2 } = await keptAtNextStart()
    m2.restoredTabs?.([{ id: CLAUDE_TAB }])
    expect((await m2.status()).sessions).toContainEqual(expect.objectContaining({ id: claudeSid, kind: 'claude', attached: false, tabOpen: true }))
  })

  it('its tab shown before main heard of the restore (the tab on screen at Resume): the restore does not stop its limit', async () => {
    await withFakeTimers(async () => {
      const { m2, hc } = await keptAtNextStart()
      m2.tabShown?.(CLAUDE_TAB)
      m2.restoredTabs?.([{ id: CLAUDE_TAB }])
      await vi.advanceTimersByTimeAsync(FIVE_MIN + 1_000)
      expect(endedForTime()).toBe(true)
      await until(() => hc.ended, 'the kept session to be ended')
    })
  })

  it('a normal quit with its tab restored and not shown: ended as a quit ends one kept for its tab, its record and files with it', async () => {
    const { m2, hc } = await keptAtNextStart()
    m2.restoredTabs?.([{ id: CLAUDE_TAB }])
    const done = m2.shutdown()
    expect(done).not.toBeNull()
    await done
    managers.splice(managers.indexOf(m2), 1)
    expect(hc.ended).toBe(true)
    expect(keptOnDisk()).toEqual([])
    expect(removed.map((k) => k.sessionId).sort()).toEqual([CLAUDE_TAB, OTHER_TAB])
  })

  it('the agent sessions\' switch off: the kept session is ended at the start as before, the restore and the show change nothing, and the shown tab starts the usual way', async () => {
    const { hc } = await updated()
    logs.length = 0
    const m2 = makeManager()
    await m2.start({ atStartup: true, plain: false, agents: false })
    setSessionHelper(m2)
    m2.restoredTabs?.([{ id: CLAUDE_TAB }])
    m2.tabShown?.(CLAUDE_TAB)
    await until(() => hc.ended, 'the kept session to be ended at the start')
    expect(held).toEqual([])
    expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE)).toBeNull()
    spawnAgentPty(claudeTab(CLAUDE_TAB), SHELL, [], agentOpts())
    await until(() => ptySpawn.mock.calls.length === 1, 'the usual start')
  })

  it('the start holds what each session kept for its tab left naming the last run (its status line\'s address file), and nothing of one it ends', async () => {
    await keptAtNextStart({ takeOver: 'both' })
    expect(held.slice().sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { sessionId: CLAUDE_TAB, provider: 'claude', hookFolder: null },
      { sessionId: OTHER_TAB, provider: 'codex', hookFolder: HOOK_FOLDER },
    ])
  })

  it('a session the start ends is not held', async () => {
    await keptAtNextStart()
    expect(held.map((k) => k.sessionId)).toEqual([CLAUDE_TAB])
    expect(removed.map((k) => k.sessionId)).toEqual([OTHER_TAB])
  })
})

describe('a Claude Code session an update kept running, asked for on another account', () => {
  it('its tab\'s launch names another account (Ask each time, another account picked): not taken over, and the launch that follows ends it first', async () => {
    const { hc } = await updated()
    await startedWith(makeManager())
    expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE, 'profile-other')).toBeNull()
    expect(logs).toContain(`[session-helper] ${claudeSid}: the kept session runs on another account than tab ${CLAUDE_TAB}'s launch, so the tab starts a new CLI`)
    expect(keptOnDisk()).toContain(`${claudeSid}.json`)
    const holdsBefore = helper.holds()
    spawnAgentPty(claudeTab(CLAUDE_TAB), SHELL, [], agentOpts())
    expect(logs).toContain(`[session-helper] ${claudeSid}: the session kept for tab ${CLAUDE_TAB} to take over is ended, because its tab started a new CLI instead of taking it over`)
    await until(() => hc.ended, 'the kept session to be ended')
    expect(removed.map((k) => k.sessionId)).toContain(CLAUDE_TAB)
    await until(() => helper.holds() === holdsBefore + 1 && freshAttached(claudeSid, hc), 'the new CLI after that end')
  })
})

/**
 * aicc_planning#423, B1d (review:B1c's three findings): while a restored tab
 * is not shown, the session kept for it has its Conductor tool calls served
 * (finding 1), and one whose CLI ends by itself is ended with its record, so
 * the tab, shown, resumes in a new CLI (finding 3). A short wait after Resume
 * first (unseenServeAfterMs; the app's is 3 s): a tab shown within it is
 * taken over without being served first. The launch bindings are a stand-in
 * that answers whether it served (serve) and records what it is told to
 * unbind (unserve); launch-bindings-take-over.test.ts holds the real ones.
 * Every case but one fails on the code before it (restoredTabs took ids
 * alone, and nothing was served or ended for these); 'its tab shown within
 * the wait' passes there by design, since nothing was served at all, and is
 * held by its two mutants (serve with no wait, serve when shown).
 */
describe('B1d: a session kept for a restored tab not shown is served its tool calls, and ended when its CLI ends (aicc_planning#423)', () => {
  /** What the stand-in bindings were asked to serve, and told to unserve. */
  let servedUnseen: Array<{ kept: KeptUnseen; cwd: string | undefined }>
  let unserved: string[]
  /** What the stand-in answers: served, or not (the tool host not serving). */
  let serveAnswer: boolean
  beforeEach(() => {
    servedUnseen = []
    unserved = []
    serveAnswer = true
    const bindings = {
      describe: (id: string) => facts[id] ?? { conversation: null, account: null, hookFolder: null },
      remove: (k: KeptLaunch) => { removed.push(k) },
      hold: () => {},
      serve: (kept: KeptUnseen, cwd: string | undefined) => { servedUnseen.push({ kept, cwd }); return serveAnswer },
      unserve: (id: string) => { unserved.push(id) },
    }
    setKeptLaunchBindings(bindings as KeptLaunchBindings)
  })
  /** The kept Claude Code session after a start that follows the update, its keeper attached. */
  async function keptAtNextStart(o: { serveMs?: number; takeOver?: 'both' } = {}): Promise<{ m2: SessionHelperManager; hc: FakeHolder; ho: FakeHolder; stream: number }> {
    const run1 = await updated()
    logs.length = 0
    const m2 = await startedWith(makeManager(o))
    await until(() => !!run1.hc.attached, 'the keeper to attach')
    return { m2, ...run1 }
  }
  const endedBecause = (why: string) => `[session-helper] ${claudeSid}: the session kept for tab ${CLAUDE_TAB} to take over is ended, because ${why}`

  it('finding 1: not shown past the wait, its kept tool stream is served under the tab\'s id (told its tool list may have changed); a call its turn makes reaches the tool host and the answer its CLI; shown, the tab takes it over and the stream is served there again', async () => {
    const { m2, hc, stream } = await keptAtNextStart({ serveMs: 30 })
    expect(hc.attached!.ackedCaps).not.toContain('mcp')
    m2.restoredTabs?.([{ id: CLAUDE_TAB, cwd: CWD }, { id: OTHER_TAB }])
    await until(() => served.length === 1, 'the kept stream to be served while the tab is not shown')
    expect(servedUnseen).toEqual([{ kept: { sessionId: CLAUDE_TAB, provider: 'claude', hookFolder: null, folder: CWD }, cwd: CWD }])
    expect(served[0]).toMatchObject({ id: CLAUDE_TAB, opts: { toolsChanged: true } })
    // A keeper that takes tool streams, and (B1e) hook events: the one its holder queued is taken now.
    expect(hc.attached!.ackedCaps).toContain('mcp')
    expect(hc.attached!.ackedCaps).toContain('hooks')
    await until(() => events.length === 1, 'the queued hook event while the tab is not shown')
    expect(hc.relayTold.filter((t) => t.stream === stream).map((t) => t.t)).toEqual(['mcp.away', 'mcp.back'])
    expect(logs).toContain(`[session-helper] ${CLAUDE_TAB}: its Conductor tools go through its holder while its tab is not shown`)
    expect(logs).toContain(`[session-helper] ${CLAUDE_TAB}: a tool stream is served on its keeper's connection while its tab is not shown, and its CLI is told its tool list may have changed`)
    expect(logs.some((l) => l.includes('served on the take-over\'s connection'))).toBe(false)
    const got: unknown[] = []
    served[0].link.take((m) => { got.push(m) }, () => {})
    hc.relay(stream, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'canvas_review' } })
    await until(() => got.length === 1, 'the call to reach the tool host')
    served[0].link.send({ jsonrpc: '2.0', id: 7, result: { content: [] } })
    await until(() => hc.toolSent.length === 1, 'the answer to reach its CLI')
    // Still kept, nothing ended, nothing unbound.
    expect(hc.ended).toBe(false)
    expect(keptOnDisk()).toEqual([`${claudeSid}.json`])
    expect(hc.waitingEvents).toEqual([])
    expect(unserved).toEqual([])
    // Shown: its take-over attaches in the keeper's place, with hooks and tools.
    const keeper = hc.attached
    m2.tabShown?.(CLAUDE_TAB)
    const taken = takeKeptSession(CLAUDE_TAB, 'claude', SIZE)
    expect(taken).not.toBeNull()
    await until(() => !!hc.attached && hc.attached !== keeper && hc.attached.ackedCaps.includes('hooks') && hc.attached.ackedCaps.includes('mcp'), 'the take-over to attach')
    await until(() => served.length === 2, 'the stream to be served on the take-over')
    expect(served[1]).toMatchObject({ id: CLAUDE_TAB, opts: { toolsChanged: true } })
    expect(logs).toContain(`[session-helper] ${CLAUDE_TAB}: a tool stream is served on the take-over's connection, and its CLI is told its tool list may have changed`)
    await until(() => events.length === 1, 'the hook event its holder queued')
    expect(hc.requests.filter((r) => r.t === 'term.launch')).toHaveLength(1)
    expect(ptySpawn).not.toHaveBeenCalled()
    // The take-over's own teardown (its spawn's killPty) clears what serving bound; the manager unbinds nothing more.
    expect(unserved).toEqual([])
    expect(keptOnDisk()).toEqual([])
  })

  it('both providers kept, each tab restored with its own folder: each is served under its own tab with that tab\'s folder, the Codex one with its kept hook folder and by its own tool functions, not told a tool list changed', async () => {
    const OTHER_CWD = 'D:\\repo'
    const { m2, hc, ho } = await keptAtNextStart({ serveMs: 30, takeOver: 'both' })
    await until(() => !!ho.attached, 'the other keeper to attach')
    // The other tab listed first: a folder taken from the first tab, not each tab's own, gives the Claude Code session the wrong one.
    m2.restoredTabs?.([{ id: OTHER_TAB, cwd: OTHER_CWD }, { id: CLAUDE_TAB, cwd: CWD }])
    await until(() => served.length === 1 && servedOther.length === 1, 'both kept streams to be served while their tabs are not shown')
    expect(servedUnseen).toHaveLength(2)
    expect(servedUnseen).toContainEqual({ kept: { sessionId: CLAUDE_TAB, provider: 'claude', hookFolder: null, folder: CWD }, cwd: CWD })
    expect(servedUnseen).toContainEqual({ kept: { sessionId: OTHER_TAB, provider: 'codex', hookFolder: HOOK_FOLDER, folder: CWD }, cwd: OTHER_CWD })
    expect(served[0]).toMatchObject({ id: CLAUDE_TAB, opts: { toolsChanged: true } })
    expect(servedOther).toEqual([{ id: OTHER_TAB, opts: undefined }])
    expect(ho.attached!.ackedCaps).toContain('mcp')
    expect(hc.ended || ho.ended).toBe(false)
  })

  it('its tab shown within the wait (the tab on screen at Resume): nothing is served before its take-over', async () => {
    const { m2, hc } = await keptAtNextStart({ serveMs: 150 })
    m2.restoredTabs?.([{ id: CLAUDE_TAB, cwd: CWD }])
    m2.tabShown?.(CLAUDE_TAB)
    await tick(400)
    expect(servedUnseen).toEqual([])
    expect(served).toEqual([])
    expect(hc.attached!.ackedCaps).not.toContain('mcp')
  })

  it('the bindings answer that it is not served (the tool host is not serving): no keeper takes the tool streams, and its calls wait for the take-over as before', async () => {
    serveAnswer = false
    const { m2, hc, stream } = await keptAtNextStart({ serveMs: 30 })
    m2.restoredTabs?.([{ id: CLAUDE_TAB, cwd: CWD }])
    await until(() => servedUnseen.length === 1, 'the bindings to be asked')
    await tick(150)
    expect(logs).toContain(`[session-helper] ${claudeSid}: tab ${CLAUDE_TAB} is not shown, and its Conductor tool calls wait for its take-over, because the tool host is not serving, or its bindings could not be made`)
    expect(served).toEqual([])
    expect(hc.attached!.ackedCaps).not.toContain('mcp')
    expect(hc.keptStreams.has(stream)).toBe(true)
    expect(hc.ended).toBe(false)
  })

  it('the keeper that takes the tool streams attaches only once the one holding the session is up, so it is the one left attached', async () => {
    const run1 = await updated()
    // The first connection this start makes to the kept holder (its keeper's) is slow.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const open = helper.openStream
    let first = true
    helper.openStream = async (endpoint) => {
      if (endpoint === run1.hc.endpoint && first) {
        first = false
        await gate
      }
      return open(endpoint)
    }
    const m2 = makeManager({ serveMs: 0 })
    void m2.start(ON_AGENTS)
    setSessionHelper(m2)
    m2.restoredTabs?.([{ id: CLAUDE_TAB, cwd: CWD }])
    await until(() => servedUnseen.length === 1, 'the bindings to be asked')
    await tick(100)
    release()
    await until(() => !!run1.hc.attached?.ackedCaps.includes('mcp'), 'the keeper that takes tool streams to attach')
    await until(() => served.length === 1, 'the kept stream to be served')
    await tick(150)
    expect(run1.hc.attached!.ackedCaps).toContain('mcp')
    expect(run1.hc.keptStreams.size).toBe(0)
  })

  it('served, then its tab closed: ended at once, and what serving bound is unbound', async () => {
    const { m2, hc } = await keptAtNextStart({ serveMs: 30 })
    m2.restoredTabs?.([{ id: CLAUDE_TAB, cwd: CWD }])
    await until(() => served.length === 1, 'the kept stream to be served')
    m2.tabClosed?.(CLAUDE_TAB)
    expect(logs).toContain(endedBecause('its tab was closed'))
    expect(unserved).toEqual([CLAUDE_TAB])
    await until(() => hc.ended, 'the kept session to be ended')
    expect(keptOnDisk()).toEqual([])
  })

  it('served, then a normal quit: ended through the keeper that serves it, and what serving bound is unbound', async () => {
    const { m2, hc } = await keptAtNextStart({ serveMs: 30 })
    m2.restoredTabs?.([{ id: CLAUDE_TAB, cwd: CWD }])
    await until(() => served.length === 1, 'the kept stream to be served')
    const done = m2.shutdown()
    expect(done).not.toBeNull()
    await done
    managers.splice(managers.indexOf(m2), 1)
    expect(hc.ended).toBe(true)
    expect(unserved).toEqual([CLAUDE_TAB])
    expect(keptOnDisk()).toEqual([])
  })

  it('finding 3: its CLI ends by itself while its tab is not shown: ended at once with its record and files, nothing is kept for the tab, and the tab, shown, starts a new CLI after that end', async () => {
    const { m2, hc } = await keptAtNextStart()
    m2.restoredTabs?.([{ id: CLAUDE_TAB, cwd: CWD }])
    hc.exitChild(0)
    await until(() => logs.includes(endedBecause('its CLI ended before its tab took it over')), 'the kept session to be ended')
    expect(keptOnDisk()).toEqual([])
    expect(removed.map((k) => k.sessionId)).toContain(CLAUDE_TAB)
    expect(unserved).toEqual([CLAUDE_TAB])
    expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE)).toBeNull()
    await until(() => hc.ended, 'its holder to be ended')
    spawnAgentPty(claudeTab(CLAUDE_TAB), SHELL, [], agentOpts())
    await until(() => freshAttached(claudeSid, hc), 'a new CLI for the tab')
  })

  it('finding 3: its CLI ended before this start (in the gap): the keeper\'s attach reads it over, and it is ended at once', async () => {
    const run1 = await updated()
    run1.hc.exitChild(0)
    logs.length = 0
    await startedWith(makeManager())
    await until(() => logs.includes(endedBecause('its CLI ended before its tab took it over')), 'the kept session to be ended')
    expect(keptOnDisk()).toEqual([])
    expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE)).toBeNull()
  })

  it('a kept session taken over and then ending: its tab\'s terminal reads the end, and nothing kept is ended again', async () => {
    const { m2, hc } = await keptAtNextStart({ serveMs: 30 })
    m2.restoredTabs?.([{ id: CLAUDE_TAB, cwd: CWD }])
    await until(() => served.length === 1, 'the kept stream to be served')
    // B1e: the keeper acks hooks too, so the take-over is the connection after it.
    const keeper = hc.attached
    m2.tabShown?.(CLAUDE_TAB)
    const taken = takeKeptSession(CLAUDE_TAB, 'claude', SIZE)!
    let exitCode: number | undefined
    taken.pty.onExit((e) => { exitCode = e.exitCode })
    await until(() => !!hc.attached && hc.attached !== keeper && hc.attached.ackedCaps.includes('hooks'), 'the take-over to attach')
    hc.exitChild(3)
    await until(() => exitCode !== undefined, 'the tab to read the end')
    expect(exitCode).toBe(3)
    expect(logs.some((l) => l.includes('its CLI ended before its tab took it over'))).toBe(false)
    expect(unserved).toEqual([])
  })
})

/**
 * aicc_planning#423, B1e (vm:B1d's notes 3 and 4): a restored tab may stay
 * unseen for a long time while its kept CLI works. From the same wait after
 * Resume as B1d's serving, a kept Claude Code session's hook events reach the
 * app at once (the keeper acks `hooks`, so its holder hands it the queue and
 * each new event): the tab's attention mark and its hook record, and none
 * lost to the holder's queue limit. The take-over goes on from the last event
 * the keeper took, so none is taken twice, and nothing ends that record at the
 * take-over; an end without one ends it, and takes nothing more. Whether a
 * session waits for its tab's take-over is answered through the seam
 * (keptForItsTab: no transcript is bound from what it says until then;
 * launch-bindings-take-over.test.ts holds that gate). The stand-in bindings
 * answer whether they served, as B1d's do.
 */
describe('B1e: a session kept for a restored tab not shown has its hook events taken at once (aicc_planning#423)', () => {
  let serveAnswer: boolean
  beforeEach(() => {
    serveAnswer = true
    setKeptLaunchBindings({
      describe: (id: string) => facts[id] ?? { conversation: null, account: null, hookFolder: null },
      remove: (k: KeptLaunch) => { removed.push(k) },
      hold: () => {},
      serve: () => serveAnswer,
      unserve: () => {},
    } as KeptLaunchBindings)
  })
  async function keptAtNextStart(o: { serveMs?: number } = {}): Promise<{ m2: SessionHelperManager; hc: FakeHolder }> {
    const run1 = await updated()
    logs.length = 0
    // Run 1's own terminal ended its hook record at the update's kill: only this start's count.
    endedHooks = []
    const m2 = await startedWith(makeManager(o))
    await until(() => !!run1.hc.attached, 'the keeper to attach')
    return { m2, hc: run1.hc }
  }
  /** The seam's answer, read off the module so a case still loads on the code before it. */
  const waitsForTakeOver = (id: string): unknown => (keptSeam as Partial<Record<string, unknown>> as { keptForItsTab?: (id: string) => boolean }).keptForItsTab?.(id)
  const permissionPrompt = { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }

  it('gap 1: not shown past the wait, the event its holder queued and each new one (Claude Code asking for approval) reach the app under the tab\'s id before any take-over; shown, the take-over takes only what came after, never one again, and the tab\'s hook record is not ended', async () => {
    const { m2, hc } = await keptAtNextStart({ serveMs: 30 })
    expect(waitsForTakeOver(CLAUDE_TAB)).toBe(true)
    // Per tab: the other tab's Codex session is ended at this start, so nothing waits for it.
    expect(waitsForTakeOver(OTHER_TAB)).toBe(false)
    m2.restoredTabs?.([{ id: CLAUDE_TAB, cwd: CWD }])
    // The turn's end its holder queued in the gap (seq 1).
    await until(() => events.length === 1, 'the queued hook event while the tab is not shown')
    expect(events[0]).toMatchObject({ id: CLAUDE_TAB, e: { seq: 1, kind: 'Stop' } })
    expect(hc.attached!.ackedCaps).toContain('hooks')
    expect(hc.waitingEvents).toEqual([])
    expect(logs).toContain(`[session-helper] ${CLAUDE_TAB}: its hook events go through its holder while its tab is not shown`)
    // Claude Code stops at its own approval question: at once, not at the take-over.
    hc.hookEvent('Notification', permissionPrompt)
    await until(() => events.length === 2, 'the approval question while the tab is not shown')
    expect(events[1]).toMatchObject({ id: CLAUDE_TAB, e: { seq: 2, kind: 'Notification' } })
    expect(waitsForTakeOver(CLAUDE_TAB)).toBe(true)
    expect(waitsForTakeOver(OTHER_TAB)).toBe(false)
    // Shown: the take-over attaches in the keeper's place.
    const keeper = hc.attached
    m2.tabShown?.(CLAUDE_TAB)
    expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE)).not.toBeNull()
    expect(waitsForTakeOver(CLAUDE_TAB)).toBe(false)
    await until(() => !!hc.attached && hc.attached !== keeper && hc.attached.ackedCaps.includes('hooks') && hc.attached.ackedCaps.includes('mcp'), 'the take-over to attach')
    // One the keeper took, sent again (section 15: the app drops a seq it has seen), then the next.
    hc.sendEvent({ t: 'event', seq: 2, kind: 'Notification', payload: permissionPrompt })
    hc.hookEvent('Stop', { hook_event_name: 'Stop', session_id: CONV })
    await until(() => events.length >= 3, 'the event after the take-over')
    await tick(50)
    expect(events.map((x) => [x.id, x.e.seq])).toEqual([[CLAUDE_TAB, 1], [CLAUDE_TAB, 2], [CLAUDE_TAB, 3]])
    expect(endedHooks).toEqual([])
  })

  it('the bindings answer that it is not served (the tool host is not serving): its hook events still reach the app while its tab is not shown; its tool streams wait for the take-over', async () => {
    serveAnswer = false
    const { m2, hc } = await keptAtNextStart({ serveMs: 30 })
    m2.restoredTabs?.([{ id: CLAUDE_TAB, cwd: CWD }])
    await until(() => events.length === 1, 'the queued hook event while the tab is not shown')
    expect(hc.attached!.ackedCaps).toContain('hooks')
    expect(hc.attached!.ackedCaps).not.toContain('mcp')
    expect(served).toEqual([])
    expect(hc.keptStreams.size).toBe(1)
  })

  it('served, then its tab closed: the tab\'s hook record is ended with it, and an event its keeper still reads is not taken', async () => {
    const { m2, hc } = await keptAtNextStart({ serveMs: 30 })
    m2.restoredTabs?.([{ id: CLAUDE_TAB, cwd: CWD }])
    await until(() => events.length === 1, 'the queued hook event while the tab is not shown')
    m2.tabClosed?.(CLAUDE_TAB)
    expect(endedHooks).toEqual([CLAUDE_TAB])
    expect(waitsForTakeOver(CLAUDE_TAB)).toBe(false)
    hc.hookEvent('Stop', { hook_event_name: 'Stop', session_id: CONV })
    await until(() => hc.ended, 'the kept session to be ended')
    await tick(50)
    expect(events).toHaveLength(1)
  })

  it('its tab shown within the wait (the tab on screen at Resume): its hook events wait in its holder for the take-over, as before', async () => {
    const { m2, hc } = await keptAtNextStart({ serveMs: 150 })
    m2.restoredTabs?.([{ id: CLAUDE_TAB, cwd: CWD }])
    m2.tabShown?.(CLAUDE_TAB)
    await tick(400)
    expect(events).toEqual([])
    expect(hc.attached!.ackedCaps).not.toContain('hooks')
    expect(hc.waitingEvents).toHaveLength(1)
    expect(waitsForTakeOver(CLAUDE_TAB)).toBe(true)
  })

  it('the agent sessions\' switch off: nothing is kept, so nothing waits for a take-over and no hook event is taken early', async () => {
    const { hc } = await updated()
    const m2 = makeManager({ serveMs: 30 })
    await m2.start({ atStartup: true, plain: false, agents: false })
    setSessionHelper(m2)
    m2.restoredTabs?.([{ id: CLAUDE_TAB, cwd: CWD }])
    await until(() => hc.ended, 'the kept session to be ended at the start')
    await tick(100)
    expect(waitsForTakeOver(CLAUDE_TAB) ?? false).toBe(false)
    expect(events).toEqual([])
  })
})
