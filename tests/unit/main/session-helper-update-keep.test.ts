/**
 * 2.1.3-beta.14, plan section A1 (S16 step 4, aicc_planning#387 with #359):
 * an app update on Windows, with the agent sessions' setting on, lets go of a
 * held agent session of a saved tab with its CLI running, when its tool calls
 * (and a Claude Code session's hook events) go through its holder, and
 * records it for the next start. With no take-over wired for its provider
 * (this file's managers wire none), the next start reads the record, logs
 * it, removes the record and what the session left on disk, and ends the
 * session before its tab starts a new CLI. An update that does not start
 * ends it at once.
 *
 * PURE: the real manager and HelperPty against the fake helper, in memory; the
 * launch's bindings (kept-launches.ts) are a stand-in that records what it is
 * asked. tests/unit/main/launch-bindings-kept.test.ts holds the launch
 * bindings to keeping the files at the kill and removing them on asking.
 *
 * Not checked here: off Windows (releaseForUpdate lets go of nothing there,
 * unchanged); the update path itself (update-handlers.ts, unchanged order:
 * the release, then killAllPty); a take-over (S16 step 5, 2.1.3-beta.17:
 * tests/unit/main/session-helper-take-over.test.ts).
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

import { SessionHelperManager, agentRecordsIn, keptHookFoldersIn, keptSessionIdsIn, setSessionHelper, spawnAgentPty, spawnRunPty, type HelperHookDeps, type HelperToolDeps } from '../../../src/main/session-helper/manager'
import { launchKeptForUpdate, setKeptLaunchBindings, type KeptLaunch, type KeptLaunchFacts } from '../../../src/main/sessions/kept-launches'
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

const CLAUDE_TAB = 'abcdef0123456789abcdee01'
const OTHER_TAB = 'abcdef0123456789abcdee02'
const CONV = '019dd000-0001-7000-8000-00000000000a'
const OTHER_CONV = '019dd000-0002-7000-8000-00000000000b'
/** Absolute on every system the tests run on (only its name reaches a log line). */
const HOOK_FOLDER = join(tmpdir(), 'aicc-data', 'codex-hooks', 'ccc-codex-hook-AbC123')
const claudeTab = (sessionId: string) => ({ sessionId, kind: 'claude' as const })
const otherTab = (sessionId: string) => ({ sessionId, kind: 'codex' as const })
const claudeSid = heldAgentSessionId(CLAUDE_TAB, 'claude')
const otherSid = heldAgentSessionId(OTHER_TAB, 'codex')
const ON_AGENTS = { atStartup: true, plain: false, agents: true }

let dir: string
let bundled: string
let root: string
let helper: FakeHelper
let logs: string[]
const managers: SessionHelperManager[] = []
const starts: Promise<unknown>[] = []
const gone = new WeakSet<SessionHelperManager>()

/** What the stand-in launch bindings answer, by tab, and what they were asked to remove. */
let facts: Record<string, KeptLaunchFacts>
let removed: KeptLaunch[]
/** Whether the stand-in tool host switches a session to its holder, and the hook switch. */
let toolsSwitch: boolean
let hooksSwitch: boolean

const tools: HelperToolDeps = { serve: () => true, serving: () => true, useRelayConfig: () => (toolsSwitch ? 'switched' : 'no-conductor') }
const otherTools: HelperToolDeps = { serve: () => true, serving: () => true, relayLaunch: (_id, launch) => (toolsSwitch ? { args: typeof launch.args === 'string' ? launch.args : [...launch.args] } : { refused: 'no-tools' }) }
const hooks: HelperHookDeps = { taking: () => true, useHelperHooks: () => (hooksSwitch ? 'switched' : 'no-gateway-hooks'), event: () => {}, ended: () => {} }

function makeManager(): SessionHelperManager {
  let self: SessionHelperManager | undefined
  const alive = () => { if (self && gone.has(self)) throw new Error('this app is gone') }
  const m = new SessionHelperManager({
    platform: 'win32', root, bundled,
    exec: async (file, args) => { alive(); return helper.exec(file, args) },
    openStream: async (endpoint) => { alive(); return helper.openStream(endpoint) },
    spawnDirect: (file, args, o) => ptySpawn(file, args, o),
    conptySource: () => null,
    log: (l) => logs.push(l),
    hooks: { claude: hooks },
    tools: { claude: tools, codex: otherTools },
  })
  self = m
  managers.push(m)
  const start = m.start.bind(m)
  m.start = (o) => { const p = start(o); starts.push(p); return p }
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
const keptFile = (sid: string) => join(keptDir(), `${sid}.json`)
const keptOnDisk = (): string[] => (existsSync(keptDir()) ? readdirSync(keptDir()).sort() : [])
const readKept = (sid: string) => JSON.parse(readFileSync(keptFile(sid), 'utf8')) as Record<string, unknown>

beforeEach(() => {
  ptySpawn.mockReset()
  ptySpawn.mockImplementation(() => fakeDirect())
  dir = mkdtempSync(join(tmpdir(), 'aicc-helper-keep-'))
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
  toolsSwitch = true
  hooksSwitch = true
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
  // The starts include the self-test each began (session-helper-manager.test.ts
  // says why that matters): a folder that cannot go here is a real failure.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
})

/** A Claude Code tab and another provider's tab through their holders, attached,
 *  their tools (and the Claude Code tab's hook events) switched to their holders,
 *  and both tabs saved. */
async function twoHeld(m: SessionHelperManager): Promise<{ claude: IPty; other: IPty; hc: FakeHolder; ho: FakeHolder }> {
  const [prevC, prevO] = [helper.holders.get(claudeSid), helper.holders.get(otherSid)]
  const claude = spawnAgentPty(claudeTab(CLAUDE_TAB), SHELL, [], agentOpts())
  const other = spawnAgentPty(otherTab(OTHER_TAB), SHELL, [], agentOpts())
  await until(() => freshAttached(claudeSid, prevC) && freshAttached(otherSid, prevO), 'both sessions to attach')
  m.noteSavedTabs([{ id: CLAUDE_TAB, label: 'Claude' }, { id: OTHER_TAB, label: 'Other' }])
  return { claude, other, hc: helper.holders.get(claudeSid)!, ho: helper.holders.get(otherSid)! }
}

/** A holder of this session that `hold` started after `prev`, attached. */
function freshAttached(sid: string, prev: FakeHolder | undefined): boolean {
  const h = helper.holders.get(sid)
  return !!h && h !== prev && !!h.attached
}

const SAVED = new Set([CLAUDE_TAB, OTHER_TAB])
/** The removals asked for, by tab id: the order does not matter. */
const bySession = (ks: KeptLaunch[]): KeptLaunch[] => [...ks].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))
const keptLine = (sid: string) => logs.find((l) => l.startsWith(`[session-helper] ${sid}: the last run's update kept this`))

describe('an app update keeps a held agent session running (S16 step 4)', () => {
  it('lets go of a saved tab\'s session whose tools (and Claude Code\'s hook events) go through its holder, records it, and the kill that follows ends neither CLI; its files stay while the update goes on', async () => {
    const m = await startedWith(makeManager())
    const { claude, other, hc, ho } = await twoHeld(m)
    expect(m.releaseForUpdate(SAVED)).toBe(2)
    expect(logs).toContain('[session-helper] an app update: 0 held terminal(s) are let go of, for the new version to show again, and 2 agent session(s) are let go of with their CLIs running, recorded for the next start; 0 kept terminal(s) are left running')
    // Recorded before the kill: provider, conversation, account and hook folder.
    expect(keptOnDisk()).toEqual([`${claudeSid}.json`, `${otherSid}.json`].sort())
    expect(readKept(claudeSid)).toEqual({ v: 1, session: claudeSid, label: CLAUDE_TAB, provider: 'claude', conversation: CONV, account: 'profile-mt4okz66-147e4a', hookFolder: null, folder: CWD, hooks: 'holder', at: expect.any(Number) })
    expect(readKept(otherSid)).toMatchObject({ session: otherSid, label: OTHER_TAB, provider: 'codex', conversation: OTHER_CONV, account: 'acct-7', hookFolder: HOOK_FOLDER })
    expect(logs).toContain(`[session-helper] ${claudeSid}: an app update lets go of this claude session of tab ${CLAUDE_TAB} with its CLI running, and records it for the next start (conversation ${CONV}, account profile-mt4okz66-147e4a, hook folder none)`)
    // The launch bindings keep each one's files at its kill while the update goes on.
    expect(launchKeptForUpdate(CLAUDE_TAB)).toBe(true)
    expect(launchKeptForUpdate(OTHER_TAB)).toBe(true)
    expect(launchKeptForUpdate('abcdef0123456789abcdee99')).toBe(false)
    // What update-handlers.ts does next: killAllPty.
    const exits: string[] = []
    claude.onExit(() => exits.push('claude'))
    other.onExit(() => exits.push('other'))
    claude.kill()
    other.kill()
    await until(() => exits.length === 2 && hc.conns.size === 0 && ho.conns.size === 0, 'both tabs to read their terminal as ended and let go')
    for (const h of [hc, ho]) {
      expect(h.endsAsked).toBe(0)
      expect(h.ended).toBe(false)
      expect(h.child).toBe('running')
    }
    expect(removed).toEqual([])
    expect(launchKeptForUpdate(CLAUDE_TAB)).toBe(true)
    exit(m)
  })

  it('a session with no conversation yet is let go of and recorded with none', async () => {
    facts[CLAUDE_TAB] = { conversation: null, account: null, hookFolder: null }
    const m = await startedWith(makeManager())
    await twoHeld(m)
    expect(m.releaseForUpdate(SAVED)).toBe(2)
    expect(readKept(claudeSid)).toMatchObject({ conversation: null, account: null, hookFolder: null })
    expect(logs).toContain(`[session-helper] ${claudeSid}: an app update lets go of this claude session of tab ${CLAUDE_TAB} with its CLI running, and records it for the next start (conversation none, account default, hook folder none)`)
    exit(m)
  })

  it('each other agent session ends at the update as before, and nothing is recorded: tools on the loopback route, Claude Code hooks on the gateway, a run of the app\'s own, an unsaved tab, and the setting switched off', async () => {
    // Tools that stay on the loopback route.
    toolsSwitch = false
    let m = await startedWith(makeManager())
    let held = await twoHeld(m)
    expect(m.releaseForUpdate(SAVED)).toBe(0)
    held.claude.kill()
    held.other.kill()
    await until(() => held.hc.ended && held.ho.ended, 'both to end')
    expect(keptOnDisk()).toEqual([])
    expect(launchKeptForUpdate(CLAUDE_TAB)).toBe(false)
    expect(m.reclaim()).toBe(0)
    m.shutdown()
    managers.splice(managers.indexOf(m), 1)

    // Claude Code's hook events on the gateway: that one ends; the other provider's
    // session, whose hooks never go through a holder, is kept.
    toolsSwitch = true
    hooksSwitch = false
    m = await startedWith(makeManager())
    held = await twoHeld(m)
    expect(m.releaseForUpdate(SAVED)).toBe(1)
    held.claude.kill()
    held.other.kill()
    await until(() => held.hc.ended, 'the Claude Code session to end')
    expect(held.ho.ended).toBe(false)
    expect(keptOnDisk()).toEqual([`${otherSid}.json`])
    expect(m.reclaim()).toBe(0)
    await until(() => held.ho.ended, 'the kept one to be ended by reclaim')
    m.shutdown()
    managers.splice(managers.indexOf(m), 1)

    // A run of the app's own and an unsaved tab.
    hooksSwitch = true
    m = await startedWith(makeManager())
    const runSid = heldAgentSessionId('insights-work', 'claude')
    const prevTab = helper.holders.get(claudeSid)
    const run = spawnRunPty({ runId: 'insights-work', kind: 'claude' }, SHELL, [], agentOpts())
    const unsaved = spawnAgentPty(claudeTab(CLAUDE_TAB), SHELL, [], agentOpts())
    await until(() => freshAttached(runSid, undefined) && freshAttached(claudeSid, prevTab), 'the run and the tab to attach')
    m.noteSavedTabs([{ id: 'insights-work', label: 'Run' }])
    expect(m.releaseForUpdate(new Set(['insights-work', CLAUDE_TAB]))).toBe(0)
    run.kill()
    unsaved.kill()
    await until(() => helper.holders.get(runSid)!.ended && helper.holders.get(claudeSid)!.ended, 'both to end')
    expect(keptOnDisk()).toEqual([])
    m.reclaim()
    m.shutdown()
    managers.splice(managers.indexOf(m), 1)

    // The agent sessions' setting switched off before the update.
    m = await startedWith(makeManager())
    held = await twoHeld(m)
    m.setRouting({ plain: false, agents: false })
    expect(m.releaseForUpdate(SAVED)).toBe(0)
    expect(keptOnDisk()).toEqual([])
  })

  it('the installer could not start: each agent session it let go of is ended at once, its record and what it left on disk go, and nothing is kept or listed for it; its tab started again waits for that end', async () => {
    const m = await startedWith(makeManager())
    const { claude, other, hc, ho } = await twoHeld(m)
    let openGate: () => void = () => {}
    hc.endGate = new Promise<void>((r) => { openGate = r })
    expect(m.releaseForUpdate(SAVED)).toBe(2)
    claude.kill()
    other.kill()
    expect(m.reclaim()).toBe(0)
    expect(logs).toContain('[session-helper] the update did not start; 0 held terminal(s) are kept for their tabs, and 2 agent session(s) it let go of are ended')
    expect(keptOnDisk()).toEqual([])
    expect(removed).toEqual([
      { sessionId: CLAUDE_TAB, provider: 'claude', hookFolder: null },
      { sessionId: OTHER_TAB, provider: 'codex', hookFolder: HOOK_FOLDER },
    ])
    expect(launchKeptForUpdate(CLAUDE_TAB)).toBe(false)
    expect(m.holdsFor(CLAUDE_TAB)).toBe(false)
    await until(() => ho.ended, 'the other session to be ended')
    // The Claude Code tab started again: it waits for its old CLI's end.
    const before = helper.holds()
    spawnAgentPty(claudeTab(CLAUDE_TAB), SHELL, [], agentOpts())
    await tick(40)
    expect(hc.endsAsked).toBe(1)
    expect(helper.holds()).toBe(before)
    openGate()
    await until(() => hc.ended && helper.holds() === before + 1, 'the old end, then the new hold')
    await until(() => helper.holders.get(claudeSid) !== hc && !!helper.holders.get(claudeSid)?.attached, 'the new session to attach')
    // Listed: only the new session, never the one the update let go of.
    const status = await m.status()
    expect(status.sessions.filter((s) => s.id === claudeSid)).toHaveLength(1)
    expect(status.sessions.find((s) => s.id === otherSid)).toBeUndefined()
  })

  it('a tab started again while the update keeps its session (after the update\'s own kill): that session is ended first, its record and files go, then the new CLI starts', async () => {
    const m = await startedWith(makeManager())
    const { claude, hc } = await twoHeld(m)
    expect(m.releaseForUpdate(SAVED)).toBe(2)
    claude.kill()
    await until(() => hc.conns.size === 0, 'the kept session to be let go of')
    const before = helper.holds()
    const again = spawnAgentPty(claudeTab(CLAUDE_TAB), SHELL, [], agentOpts())
    expect(keptOnDisk()).toEqual([`${otherSid}.json`])
    expect(removed).toEqual([{ sessionId: CLAUDE_TAB, provider: 'claude', hookFolder: null }])
    expect(launchKeptForUpdate(CLAUDE_TAB)).toBe(false)
    await until(() => hc.ended, 'the kept session to be ended')
    expect(hc.endsAsked).toBe(1)
    // While the update goes on nothing new goes through the helper: the usual start, after that end.
    await until(() => ptySpawn.mock.calls.length === 1, 'the usual start')
    expect(helper.holds()).toBe(before)
    expect(again).toBeDefined()
    expect(logs).toContain(`[session-helper] ${claudeSid}: its tab started again during the update, so the session the update kept running is ended first`)
    exit(m)
  })

  it('a quit that overtakes the update ends each kept session and removes its record and what it left', async () => {
    const m = await startedWith(makeManager())
    const { hc, ho } = await twoHeld(m)
    expect(m.releaseForUpdate(SAVED)).toBe(2)
    const done = m.shutdown()
    expect(done).not.toBeNull()
    await done
    expect(hc.ended && ho.ended).toBe(true)
    expect(keptOnDisk()).toEqual([])
    expect(removed.map((k) => k.sessionId)).toEqual([CLAUDE_TAB, OTHER_TAB])
  })
})

describe('the next start, with no take-over wired for the provider (S16 step 5 not wired)', () => {
  /** Run 1 lets both sessions go for the update, kills every PTY and exits. */
  async function updated(): Promise<{ hc: FakeHolder; ho: FakeHolder }> {
    const m1 = await startedWith(makeManager())
    const { claude, other, hc, ho } = await twoHeld(m1)
    expect(m1.releaseForUpdate(SAVED)).toBe(2)
    claude.kill()
    other.kill()
    exit(m1)
    await until(() => hc.conns.size === 0 && ho.conns.size === 0, 'run 1 to let go')
    return { hc, ho }
  }

  it('reads and logs each record, removes the record and what the session left on disk before any tab starts, and ends the session; the restored tab starts its CLI only after that end', async () => {
    const { hc, ho } = await updated()
    // The helper comes up for the records alone, too.
    expect(agentRecordsIn(root, 'win32')).toBe(true)
    expect(keptSessionIdsIn(root)).toEqual(new Set([CLAUDE_TAB, OTHER_TAB]))
    expect(keptHookFoldersIn(root)).toEqual([HOOK_FOLDER])
    let openGate: () => void = () => {}
    hc.endGate = new Promise<void>((r) => { openGate = r })
    logs.length = 0
    const m2 = makeManager()
    void m2.start(ON_AGENTS)
    setSessionHelper(m2)
    // Synchronous: read, logged, removed, before the copy, the listing or any tab.
    expect(keptLine(claudeSid)).toBe(`[session-helper] ${claudeSid}: the last run's update kept this claude session of tab ${CLAUDE_TAB} running (conversation ${CONV}, account profile-mt4okz66-147e4a, hook folder none); it is ended, and its tab resumes the conversation as before, because a take-over of this provider's sessions is not built`)
    expect(keptLine(otherSid)).toBe(`[session-helper] ${otherSid}: the last run's update kept this codex session of tab ${OTHER_TAB} running (conversation ${OTHER_CONV}, account acct-7, hook folder ccc-codex-hook-AbC123); it is ended, and its tab resumes the conversation as before, because a take-over of this provider's sessions is not built`)
    expect(bySession(removed)).toEqual([
      { sessionId: CLAUDE_TAB, provider: 'claude', hookFolder: null },
      { sessionId: OTHER_TAB, provider: 'codex', hookFolder: HOOK_FOLDER },
    ])
    expect(keptOnDisk()).toEqual([])
    expect(keptSessionIdsIn(root)).toEqual(new Set())
    expect(logs).toContain('[session-helper] the app was updated; 0 held terminal(s) may be shown again, and 2 agent session(s) it held are ended')
    // The Claude Code tab is restored at once: it waits for the old CLI's end.
    const before = helper.holds()
    spawnAgentPty(claudeTab(CLAUDE_TAB), SHELL, [], agentOpts())
    await until(() => hc.endsAsked === 1, 'the old session to be asked to end')
    await tick(40)
    expect(helper.holds()).toBe(before)
    openGate()
    await until(() => hc.ended && helper.holds() === before + 1, 'the old end, then the new hold')
    await until(() => helper.holders.get(claudeSid) !== hc && !!helper.holders.get(claudeSid)?.attached, 'the new session')
    // The other tab is not restored: its session is ended all the same, and nothing of it is left.
    await until(() => ho.ended, 'the other session to end')
    expect(ho.endsAsked).toBe(1)
    await until(() => m2.serviceState().state === 'ready', 'the helper to be ready')
    const status = await m2.status()
    expect(status.sessions.find((s) => s.id === otherSid)).toBeUndefined()
    expect(keptOnDisk()).toEqual([])
  })

  it('a session whose holder ended meanwhile (its away clock): its record is still read and logged, and it and what it left go', async () => {
    const { hc, ho } = await updated()
    for (const h of [hc, ho]) h.vanish()
    const m2 = makeManager()
    await m2.start({ atStartup: true, plain: false, agents: false })
    expect(keptLine(claudeSid)).toBeDefined()
    expect(bySession(removed).map((k) => k.sessionId)).toEqual([CLAUDE_TAB, OTHER_TAB])
    expect(keptOnDisk()).toEqual([])
  })

  it('a record that does not read is removed alone, and one whose tab and provider are not one session of this app\'s does not read', async () => {
    mkdirSync(keptDir(), { recursive: true })
    writeFileSync(keptFile(claudeSid), '{ not json')
    writeFileSync(keptFile(otherSid), JSON.stringify({ v: 1, session: otherSid, label: CLAUDE_TAB, provider: 'codex', conversation: null, account: null, hookFolder: null, at: 1 }))
    expect(keptSessionIdsIn(root)).toEqual(new Set())
    expect(agentRecordsIn(root, 'win32')).toBe(true)
    const m = makeManager()
    await m.start({ atStartup: true, plain: false, agents: false })
    expect(keptOnDisk()).toEqual([])
    expect(removed).toEqual([])
    expect(logs).toContain(`[session-helper] ${claudeSid}: a record of an agent session an update kept running did not read, and is removed`)
    expect(logs).toContain(`[session-helper] ${otherSid}: a record of an agent session an update kept running did not read, and is removed`)
  })
})
