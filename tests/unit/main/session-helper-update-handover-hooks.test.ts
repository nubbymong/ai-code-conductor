/**
 * aicc_planning#423, B1f (vm:B1e's note 2): at an app update with the agent
 * sessions' switch on, the hook events a kept Claude Code session makes after
 * the old app lets go of it reach the next start, once.
 *
 * Measured on the VM (pass 2, B1CC2): the two hook events of one tool call,
 * made 0.2 s and 0.28 s after the old app's let-go line and before its exit,
 * were not in the next run's hook record; every later one was. The cause is
 * in the app: the let-go closed its connection with a half-close
 * (connection.ts close: `end()`, a destroy 1 s later) and dropped every frame
 * from then on unread, while on Windows a named pipe has no half-close, so
 * the holder still had that connection attached and wrote each new event to
 * it, which is the holder's "sent" (helper/src/serve.rs send_waiting). Now
 * the let-go of a connection that takes hook events is a `term.detach`: the
 * holder sends no event after `term.detached` (protocol section 15), so a
 * later one waits for the next attach, and the old app still reads the ones
 * sent before that answer.
 *
 * PURE: the real manager, HelperPty and HolderConnection against the fake
 * helper on Windows named pipes (`noHalfClose`: the app's `end()` is not seen,
 * only the close of its handle, as the VM's run showed). Each run has its own
 * stand-in signals module, so a case shows which run took each event. The
 * update is driven as update-handlers.ts drives it: releaseForUpdate, the wait
 * for what it sent (endsForUpdate, which app-wiring bounds), the kill of every
 * PTY, then the exit. Where the bound matters, app-wiring's own race runs
 * (releaseHeldTerminalsForUpdate; of its imports only the saved file is read
 * on that path, so the rest are stand-ins).
 *
 * Not checked here: the real pipe and the real holder (the VM line); the other
 * provider's sessions (their hook events go to the Hooks gateway, not through
 * a holder: CONTEXT.d/2026-11-24-takeover-update-handover-hooks.md says why
 * that gap is not closed here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'node-pty'

const ptySpawn = vi.hoisted(() => vi.fn())
vi.mock('node-pty', () => ({ spawn: ptySpawn }))
/** The tab ids in the saved file app-wiring's update race reads. */
const savedFile = vi.hoisted(() => ({ ids: [] as string[] }))
vi.mock('../../../src/main/session-state', () => ({ peekSessionState: () => ({ sessions: savedFile.ids.map((id) => ({ id })) }) }))
// app-wiring.ts's other imports: not read on its update race.
vi.mock('../../../src/main/config-manager', () => ({}))
vi.mock('../../../src/main/ipc/machines-handlers', () => ({}))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({}))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({}))
vi.mock('../../../src/main/session-signals/hooks', () => ({}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({}))
vi.mock('../../../src/main/providers', () => ({}))

import { SessionHelperManager, setSessionHelper, spawnAgentPty, spawnPlainPty, type HelperHookDeps, type HelperToolDeps } from '../../../src/main/session-helper/manager'
import { UPDATE_END_WAIT_MS, releaseHeldTerminalsForUpdate } from '../../../src/main/session-helper/app-wiring'
import { LET_GO_WAIT_MS } from '../../../src/main/session-helper/connection'
import { setKeptLaunchBindings, takeKeptSession, type KeptLaunch, type KeptLaunchBindings, type KeptLaunchFacts } from '../../../src/main/sessions/kept-launches'
import { heldAgentSessionId } from '../../../src/main/session-helper/protocol'
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

const CLAUDE_TAB = 'abcdef0123456789abcdee31'
const PLAIN_TAB = 'abcdef0123456789abcdee32'
const CONV = '019dd000-0001-7000-8000-00000000003a'
const claudeSid = heldAgentSessionId(CLAUDE_TAB, 'claude')
const ON_AGENTS = { atStartup: true, plain: false, agents: true }
const SAVED = new Set([CLAUDE_TAB])
const SIZE = { cols: 120, rows: 30 }
const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_b1f_1' }
const readDone = { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'toolu_b1f_1' }
const stop = { hook_event_name: 'Stop', session_id: CONV }

let dir: string
let bundled: string
let root: string
let helper: FakeHelper
let logs: string[]
const managers: SessionHelperManager[] = []
const starts: Promise<unknown>[] = []
const gone = new WeakSet<SessionHelperManager>()
let facts: Record<string, KeptLaunchFacts>
/** Each hook event a run's stand-in signals module took: the run, the tab, its seq. */
let events: Array<{ run: number; id: string; seq: number }>
/** Each tool stream a run's stand-in tool host was asked to serve. */
let served: Array<{ run: number; id: string }>

const takenBy = (run: number): number[] => events.filter((x) => x.run === run).map((x) => x.seq)

function makeManager(run: number, o: { serveMs?: number } = {}): SessionHelperManager {
  let self: SessionHelperManager | undefined
  const alive = () => { if (self && gone.has(self)) throw new Error('this app is gone') }
  const hooks: HelperHookDeps = { taking: () => true, useHelperHooks: () => 'switched', event: (id, e) => { events.push({ run, id, seq: e.seq }) }, ended: () => {} }
  const tools: HelperToolDeps = { serve: (id) => { served.push({ run, id }); return true }, serving: () => true, useRelayConfig: () => 'switched', listsAgain: true }
  const m = new SessionHelperManager({
    platform: 'win32', root, bundled,
    exec: async (file, args) => { alive(); return helper.exec(file, args) },
    openStream: async (endpoint) => { alive(); return helper.openStream(endpoint) },
    spawnDirect: (file, args, opts) => ptySpawn(file, args, opts),
    conptySource: () => null,
    log: (l) => logs.push(l),
    hooks: { claude: hooks },
    tools: { claude: tools },
    takeOver: { claude: true },
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

/** The app exits for the installer: its handles close, so every connection it had drops. */
function exit(m: SessionHelperManager): void {
  managers.splice(managers.indexOf(m), 1)
  gone.add(m)
  setSessionHelper(null)
  for (const h of helper.holders.values()) h.dropAll()
}

/** The update as update-handlers.ts runs it, up to the exit: the let-go, its wait, then every PTY killed. */
async function update(m: SessionHelperManager, ptys: IPty[]): Promise<number> {
  const n = m.releaseForUpdate(SAVED)
  await m.endsForUpdate()
  for (const p of ptys) p.kill()
  return n
}

/** Run 1: a Claude Code tab through its holder, its hook events and tool calls switched to it, its tab saved. */
async function runOne(): Promise<{ m1: SessionHelperManager; claude: IPty; hc: FakeHolder }> {
  const m1 = await startedWith(makeManager(1))
  const claude = spawnAgentPty({ sessionId: CLAUDE_TAB, kind: 'claude' }, SHELL, [], agentOpts())
  await until(() => logs.includes(`[session-helper] ${CLAUDE_TAB}: its hook events go through its holder, PreToolUse included`) && logs.includes(`[session-helper] ${CLAUDE_TAB}: its Conductor tools go through its holder`), 'its hooks and tools to go through its holder')
  const hc = helper.holders.get(claudeSid)!
  await until(() => !!hc.attached?.ackedCaps.includes('hooks'), 'the session to attach')
  m1.noteSavedTabs([{ id: CLAUDE_TAB, label: 'Claude' }])
  return { m1, claude, hc }
}

/** The next start takes the kept session over in its restored tab, attached with hook events. */
async function takenOver(run: number, hc: FakeHolder): Promise<SessionHelperManager> {
  const m = await startedWith(makeManager(run))
  await until(() => !!hc.attached, 'the keeper to attach')
  const keeper = hc.attached
  expect(takeKeptSession(CLAUDE_TAB, 'claude', SIZE)).not.toBeNull()
  await until(() => !!hc.attached && hc.attached !== keeper && hc.attached.ackedCaps.includes('hooks'), 'the take-over to attach')
  return m
}

const detaches = (h: FakeHolder): number => h.requests.filter((r) => r.t === 'term.detach').length

beforeEach(() => {
  ptySpawn.mockReset()
  ptySpawn.mockImplementation(() => fakeDirect())
  dir = mkdtempSync(join(tmpdir(), 'aicc-helper-b1f-'))
  mkdirSync(join(dir, 'install', 'helper'), { recursive: true })
  bundled = join(dir, 'install', 'helper', 'aicc-helper.exe')
  writeFileSync(bundled, 'MZ the installed helper')
  root = join(dir, 'user', 'helper')
  helper = new FakeHelper()
  helper.noHalfClose = true
  logs = []
  events = []
  served = []
  savedFile.ids = []
  facts = { [CLAUDE_TAB]: { conversation: CONV, account: 'acct-1', hookFolder: null } }
  setKeptLaunchBindings({
    describe: (id: string) => facts[id] ?? { conversation: null, account: null, hookFolder: null },
    remove: (_k: KeptLaunch) => {},
    hold: () => {},
    serve: () => true,
    unserve: () => {},
  } as KeptLaunchBindings)
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
  // The starts include the self-test each began (session-helper-manager.test.ts
  // says why that matters): a folder that cannot go here is a real failure.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
})

describe('B1f: the hook events made after an update lets go of a kept Claude Code session reach the next start once (aicc_planning#423)', () => {
  it('measured (vm:B1e note 2): the two events of one tool call its holder sends after the let-go and before the old app exits reach the next start\'s take-over, once each, and the old run takes none', async () => {
    const { m1, claude, hc } = await runOne()
    expect(await update(m1, [claude])).toBe(1)
    // After the let-go and before the exit, as on the VM.
    hc.hookEvent('PreToolUse', read)
    hc.hookEvent('PostToolUse', readDone)
    await tick(30)
    exit(m1)
    await takenOver(2, hc)
    await until(() => takenBy(2).length === 2, 'the two events at the take-over')
    await tick(50)
    expect(takenBy(2)).toEqual([1, 2])
    expect(takenBy(1)).toEqual([])
    expect(events.every((x) => x.id === CLAUDE_TAB)).toBe(true)
    // The holder was let go of by a detach, which it answered.
    expect(detaches(hc)).toBe(1)
    expect(logs).toContain(`[session-helper] ${claudeSid}: its holder let go of it for the update, so a hook event it makes from now on waits there for the next start`)
  })

  it('an event its holder sent just before the let-go, not yet read, is taken by the old run once; one after the let-go by the next start once; none twice', async () => {
    const { m1, claude, hc } = await runOne()
    // Written to the old app's connection in the same moment as its let-go: read after it.
    hc.hookEvent('PreToolUse', read)
    m1.releaseForUpdate(SAVED)
    await m1.endsForUpdate()
    await until(() => takenBy(1).length === 1, 'the event sent just before the let-go, at the old run')
    claude.kill()
    hc.hookEvent('PostToolUse', readDone)
    exit(m1)
    await takenOver(2, hc)
    await until(() => takenBy(2).length === 1, 'the event after the let-go at the take-over')
    await tick(50)
    expect(takenBy(1)).toEqual([1])
    expect(takenBy(2)).toEqual([2])
  })

  it('a session still kept for its restored tab not shown at the next update (its keeper takes hook events, B1e): its keeper lets go the same way, an event after that reaches the start after it, once, and the session is kept for its tab again', async () => {
    const { m1, claude, hc } = await runOne()
    await update(m1, [claude])
    exit(m1)
    const m2 = await startedWith(makeManager(2, { serveMs: 20 }))
    m2.restoredTabs([{ id: CLAUDE_TAB, cwd: CWD }])
    await until(() => !!hc.attached?.ackedCaps.includes('hooks'), 'its keeper to take hook events while its tab is not shown')
    hc.hookEvent('Stop', stop)
    await until(() => takenBy(2).length === 1, 'the event while its tab is not shown')
    m2.noteSavedTabs([{ id: CLAUDE_TAB, label: 'Claude' }])
    await update(m2, [])
    hc.hookEvent('Notification', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    await tick(30)
    exit(m2)
    await takenOver(3, hc)
    await until(() => takenBy(3).length === 1, 'the event after the second let-go at the take-over')
    await tick(50)
    expect(takenBy(2)).toEqual([1])
    expect(takenBy(3)).toEqual([2])
    expect(hc.ended).toBe(false)
  })

  it('the update does not start (its installer could not be launched): a keeper the update let go of is kept again, and takes what its holder kept meanwhile and what comes after, once each', async () => {
    const { m1, claude, hc } = await runOne()
    await update(m1, [claude])
    exit(m1)
    const m2 = await startedWith(makeManager(2, { serveMs: 20 }))
    m2.restoredTabs([{ id: CLAUDE_TAB, cwd: CWD }])
    await until(() => !!hc.attached?.ackedCaps.includes('hooks') && hc.attached.ackedCaps.includes('mcp'), 'its keeper to take hook events and tool streams while its tab is not shown')
    m2.noteSavedTabs([{ id: CLAUDE_TAB, label: 'Claude' }])
    await update(m2, [])
    hc.hookEvent('Stop', stop)
    m2.reclaim()
    await until(() => takenBy(2).length === 1, 'the event its holder kept, at the keeper kept again')
    hc.hookEvent('Notification', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    await until(() => takenBy(2).length === 2, 'the next event at that keeper')
    await tick(50)
    expect(takenBy(2)).toEqual([1, 2])
    expect(hc.attached!.ackedCaps).toEqual(expect.arrayContaining(['hooks', 'mcp']))
    expect(hc.ended).toBe(false)
  })

  it('while the let-go waits for its answer, the old run serves no tool stream its holder opens; the holder keeps it for the next start', async () => {
    const { m1, claude, hc } = await runOne()
    hc.answerDetach = false
    m1.releaseForUpdate(SAVED)
    const stream = hc.openToolStream({ away: true })
    await tick(50)
    expect(served.filter((s) => s.run === 1)).toEqual([])
    claude.kill()
    exit(m1)
    expect(hc.keptStreams.has(stream!)).toBe(true)
  })

  it('a holder that does not answer the let-go, with the app\'s own waits: the let-go gives up within LET_GO_WAIT_MS, under the update\'s UPDATE_END_WAIT_MS, so before the kill its connection is closed and the log says so', async () => {
    expect(LET_GO_WAIT_MS).toBeLessThan(UPDATE_END_WAIT_MS)
    // The default reply wait (10 s): the let-go's own wait is what bounds it.
    const { claude, hc } = await runOne()
    hc.answerDetach = false
    savedFile.ids = [CLAUDE_TAB]
    // The update's own race (app-wiring.ts): the let-go, then its wait, UPDATE_END_WAIT_MS at most.
    expect(await releaseHeldTerminalsForUpdate()).toBe(1)
    expect(detaches(hc)).toBe(1)
    // What update-handlers.ts runs next is the kill of every PTY: the let-go gave up before it, and said so.
    expect(logs).toContain(`[session-helper] ${claudeSid}: its holder did not answer the update's let-go, so its connection is closed; a hook event it makes before the app exits may not reach the next start`)
    await until(() => hc.conns.size === 0, 'its holder to see the connection closed', 200)
    claude.kill()
  })

  it('a quit that overtakes an update, with a session kept for its restored tab not shown whose keeper the update let go of: the quit ends it, once', async () => {
    const { m1, claude, hc } = await runOne()
    await update(m1, [claude])
    exit(m1)
    const m2 = await startedWith(makeManager(2, { serveMs: 20 }))
    m2.restoredTabs([{ id: CLAUDE_TAB, cwd: CWD }])
    await until(() => !!hc.attached?.ackedCaps.includes('hooks'), 'its keeper to take hook events while its tab is not shown')
    m2.noteSavedTabs([{ id: CLAUDE_TAB, label: 'Claude' }])
    m2.releaseForUpdate(SAVED)
    await m2.endsForUpdate()
    // Its keeper was let go of, so it has no keeper left to end it through.
    expect(detaches(hc)).toBe(2)
    await m2.shutdown()
    expect(hc.requests.filter((r) => r.t === 'term.end')).toHaveLength(1)
    expect(hc.ended).toBe(true)
  })

  it('pin: a plain terminal (no hook events) is let go of as before: closed with no term.detach, its holder kept for the next start', async () => {
    const m1 = await startedWith(makeManager(1), { atStartup: true, plain: true, agents: false })
    const plain = spawnPlainPty({ sessionId: PLAIN_TAB, plain: true }, SHELL, [], agentOpts())
    await until(() => [...helper.holders.values()].some((h) => !!h.attached), 'the plain terminal to attach')
    const hp = [...helper.holders.values()][0]
    m1.noteSavedTabs([{ id: PLAIN_TAB, label: 'Shell' }])
    expect(m1.releaseForUpdate(new Set([PLAIN_TAB]))).toBe(1)
    await m1.endsForUpdate()
    plain.kill()
    exit(m1)
    expect(detaches(hp)).toBe(0)
    expect(hp.ended).toBe(false)
  })

  it('pin: the agent sessions\' switch off: a Claude Code tab starts the usual way and an update lets go of nothing and sends no detach', async () => {
    // Both switches off: the helper is not started, so it never reads ready.
    const m1 = makeManager(1)
    await m1.start({ atStartup: true, plain: false, agents: false })
    setSessionHelper(m1)
    const claude = spawnAgentPty({ sessionId: CLAUDE_TAB, kind: 'claude' }, SHELL, [], agentOpts())
    await tick(50)
    expect(ptySpawn).toHaveBeenCalledTimes(1)
    m1.noteSavedTabs([{ id: CLAUDE_TAB, label: 'Claude' }])
    expect(m1.releaseForUpdate(SAVED)).toBe(0)
    await m1.endsForUpdate()
    claude.kill()
    expect(helper.holders.size).toBe(0)
  })

  it('pin: a normal quit (no update) ends every held agent session with term.end: nothing is let go of, detached or kept', async () => {
    const { m1, hc } = await runOne()
    const quit = m1.shutdown()
    expect(quit).not.toBeNull()
    await quit
    expect(hc.ended).toBe(true)
    expect(hc.requests.filter((r) => r.t === 'term.end')).toHaveLength(1)
    expect(detaches(hc)).toBe(0)
    expect(existsSync(join(root, 'kept')) ? readdirSync(join(root, 'kept')) : []).toEqual([])
  })
})
