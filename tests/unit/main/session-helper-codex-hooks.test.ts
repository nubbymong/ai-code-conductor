/**
 * 2.1.3-beta.18, plan section 5 (ADR-030 S12, aicc_planning#433): a held
 * Codex session's hook events go through its holder, so an app update loses
 * none.
 *
 * Codex's hook command is the same for every session of this install (Codex
 * keys the trust it records on the command's text), so a held session's
 * launch is what changes: the launch its holder runs gets the hook mode's
 * three variables in its environment (the helper copy, its store and the
 * holder's session) and Codex's six kinds (`hookKinds`), declared by the
 * Codex package; its forwarder then runs the hook mode named there, and the
 * holder takes those six kinds only. Each event reaches the session signals
 * module under the tab's id, once; while no app is attached it waits in the
 * holder, and the next start's take-over gets it, in order. The release
 * marks the kept record (`hooks: 'holder'`); a kept Codex session with no
 * mark (its hooks were on the Hooks gateway, or 2.1.3-beta.17 or earlier
 * kept it) is still kept, and its take-over takes no hook event through its
 * holder: its hook file is written again (launch-bindings.ts, tested in
 * tests/unit/main/launch-bindings-take-over.test.ts).
 *
 * PURE: the real manager, HelperPty and HolderConnection against the fake
 * helper (tests/unit/main/session-helper-fake-holder.ts), in memory. The
 * holder's own rule (it takes the kinds its launch declared) is the helper's,
 * tested in helper/tests/hooks.rs; the fake passes on what it is given, so
 * these cases show the app's side: what the launch declares, and which kinds
 * the app takes.
 *
 * Not checked here: the forwarder (tests/unit/scripts/codex-hook-forwarder-helper.test.ts),
 * the real holder and the real update (section 5's VM line).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IPty } from 'node-pty'

const ptySpawn = vi.hoisted(() => vi.fn())
vi.mock('node-pty', () => ({ spawn: ptySpawn }))

import { SessionHelperManager, setSessionHelper, spawnAgentPty, type HelperHookDeps, type HelperToolDeps } from '../../../src/main/session-helper/manager'
import { HelperPty } from '../../../src/main/session-helper/helper-pty'
import { setKeptLaunchBindings, takeKeptSession, type KeptLaunchBindings, type KeptLaunchFacts } from '../../../src/main/sessions/kept-launches'
import { HOOK_MODE_ENV, heldAgentSessionId } from '../../../src/main/session-helper/protocol'
import { CODEX_HOOK_EVENTS } from '../../../src/main/providers/codex/hooks'
import { FakeHelper, type FakeHolder } from './session-helper-fake-holder'

const SHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CWD = 'C:\\Users\\someone\\project'
const HOOK_FILE = 'C:\\Users\\someone\\AppData\\Roaming\\ai-code-conductor\\codex-hooks\\ccc-codex-hook-AbC123\\hook.json'
/** The spawn's environment: its own hook file, and a spelling of one of the
 *  hook mode's variables this process inherited, which the launch must not keep. */
const agentOpts = () => ({ name: 'xterm-256color', cols: 120, rows: 30, cwd: CWD, env: { Path: 'C:\\Windows', CCC_CODEX_HOOK_FILE: HOOK_FILE, aicc_helper_store: 'C:\\elsewhere\\store' }, useConpty: true })
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

const TAB = 'abcdef0123456789abcdee51'
const CLAUDE_TAB = 'abcdef0123456789abcdee52'
const sid = heldAgentSessionId(TAB, 'codex')
const CONV = '019dd000-0005-7000-8000-00000000005a'
const ACCOUNT = 'acct-s5'
const ON_AGENTS = { atStartup: true, plain: false, agents: true }
const SIZE = { cols: 120, rows: 30 }
/** What a beta.18 holder offers: `status` with it says it takes a launch's hook kinds. */
const CAPS_18 = ['core', 'local', 'hooks', 'mcp', 'status']
/** A holder from before 2.1.3-beta.18: no `status`, so no hook kinds in a launch. */
const CAPS_17 = ['core', 'local', 'hooks', 'mcp']
const SIX = [...CODEX_HOOK_EVENTS]

let dir: string
let bundled: string
let root: string
let helper: FakeHelper
let logs: string[]
const managers: SessionHelperManager[] = []
const starts: Promise<unknown>[] = []
const gone = new WeakSet<SessionHelperManager>()
/** Each hook event a run's stand-in signals module took: the run, the tab, its seq and kind. */
let events: Array<{ run: number; id: string; seq: number; kind: string }>
/** Whether the Hooks gateway takes hook events now. */
let taking: boolean
/** What the Codex package declares (SessionProvider.heldHookKinds). */
let declared: readonly string[] | undefined

const takenBy = (run: number): Array<[number, string]> => events.filter((x) => x.run === run).map((x) => [x.seq, x.kind])

function makeManager(run: number): SessionHelperManager {
  let self: SessionHelperManager | undefined
  const alive = () => { if (self && gone.has(self)) throw new Error('this app is gone') }
  const event = (id: string, e: { seq: number; kind: string }) => { events.push({ run, id, seq: e.seq, kind: e.kind }) }
  // As app-wiring.ts gives them: Codex by its launch, Claude Code by its settings file.
  const codexHooks: HelperHookDeps = { taking: () => taking, launchKinds: () => declared, keptOnGateway: true, event, ended: () => {} }
  const claudeHooks: HelperHookDeps = { taking: () => taking, useHelperHooks: () => 'switched', event, ended: () => {} }
  const tools: HelperToolDeps = { serve: () => true, serving: () => true, relayLaunch: (_id, launch) => ({ args: typeof launch.args === 'string' ? launch.args : [...launch.args] }) }
  const claudeTools: HelperToolDeps = { serve: () => true, serving: () => true, useRelayConfig: () => 'switched' }
  const m = new SessionHelperManager({
    platform: 'win32', root, bundled,
    exec: async (file, args) => { alive(); return helper.exec(file, args) },
    openStream: async (endpoint) => { alive(); return helper.openStream(endpoint) },
    spawnDirect: (file, args, opts) => ptySpawn(file, args, opts),
    conptySource: () => null,
    log: (l) => logs.push(l),
    hooks: { codex: codexHooks, claude: claudeHooks },
    tools: { codex: tools, claude: claudeTools },
    takeOver: { codex: true, claude: true },
  })
  self = m
  managers.push(m)
  const start = m.start.bind(m)
  m.start = (opts) => { const p = start(opts); starts.push(p); return p }
  return m
}

async function startedWith(m: SessionHelperManager): Promise<SessionHelperManager> {
  await m.start(ON_AGENTS)
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

/** The per-user copy the holders run from. */
const helperCopy = () => join(root, readdirSync(root).find((n) => /^0\.1\.0-/.test(n))!, 'aicc-helper.exe')
const keptRecord = () => JSON.parse(readFileSync(join(root, 'kept', `${sid}.json`), 'utf8')) as Record<string, unknown>
const launchOf = (h: FakeHolder) => h.launch as { env: Record<string, string>; hookKinds?: string[] }
const VIA_LAUNCH = `[session-helper] ${TAB}: its hook events go through its holder, from its launch's environment`

/** Run 1: a Codex tab through its holder, its tools and (when its holder takes them) its hook events switched to it, its tab saved. */
async function runOne(): Promise<{ m1: SessionHelperManager; codex: IPty; h: FakeHolder }> {
  const m1 = await startedWith(makeManager(1))
  const codex = spawnAgentPty({ sessionId: TAB, kind: 'codex' }, SHELL, [], agentOpts())
  await until(() => !!helper.holders.get(sid)?.attached && logs.includes(`[session-helper] ${TAB}: its Conductor tools go through its holder`), 'the session to attach')
  m1.noteSavedTabs([{ id: TAB, label: 'Codex' }])
  return { m1, codex, h: helper.holders.get(sid)! }
}

beforeEach(() => {
  ptySpawn.mockReset()
  ptySpawn.mockImplementation(() => fakeDirect())
  dir = mkdtempSync(join(tmpdir(), 'aicc-helper-s5-'))
  mkdirSync(join(dir, 'install', 'helper'), { recursive: true })
  bundled = join(dir, 'install', 'helper', 'aicc-helper.exe')
  writeFileSync(bundled, 'MZ the installed helper')
  root = join(dir, 'user', 'helper')
  helper = new FakeHelper()
  helper.holderCaps = [...CAPS_18]
  helper.noHalfClose = true
  logs = []
  events = []
  taking = true
  declared = SIX
  const facts: Record<string, KeptLaunchFacts> = { [TAB]: { conversation: CONV, account: ACCOUNT, hookFolder: null } }
  setKeptLaunchBindings({
    describe: (id: string) => facts[id] ?? { conversation: null, account: null, hookFolder: null },
    remove: () => {},
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

describe('a held Codex session\'s launch: the hook mode\'s variables and Codex\'s six kinds', () => {
  it('its holder takes a launch\'s hook kinds: the launch carries the three variables (an inherited spelling dropped, the rest of its environment as spawned) and the six kinds; its connection acks hooks', async () => {
    const { h } = await runOne()
    await until(() => logs.includes(VIA_LAUNCH), 'its hooks to go through its holder')
    const launch = launchOf(h)
    expect(launch.hookKinds).toEqual(SIX)
    expect(launch.env[HOOK_MODE_ENV.helper]).toBe(helperCopy())
    expect(launch.env[HOOK_MODE_ENV.store]).toBe(join(root, 'store'))
    expect(launch.env[HOOK_MODE_ENV.session]).toBe(sid)
    // The inherited spelling is gone, and nothing else of the spawn's environment changed.
    expect(Object.keys(launch.env).filter((k) => k.toUpperCase().startsWith('AICC_HELPER_')).sort()).toEqual(Object.values(HOOK_MODE_ENV).sort())
    expect(launch.env.Path).toBe('C:\\Windows')
    expect(launch.env.CCC_CODEX_HOOK_FILE).toBe(HOOK_FILE)
    expect(h.attached!.ackedCaps).toContain('hooks')
  })

  it('each of Codex\'s six kinds reaches the signals module once, under the tab\'s id; a kind outside them is not taken, nor a seq seen already', async () => {
    const { h } = await runOne()
    await until(() => logs.includes(VIA_LAUNCH), 'its hooks to go through its holder')
    for (const kind of SIX) h.hookEvent(kind, { hook_event_name: kind, session_id: CONV })
    await until(() => events.length === SIX.length, 'the six events')
    // Not one of the six (a holder that broke its launch's list): not taken.
    h.hookEvent('Notification', { hook_event_name: 'Notification' })
    h.sendEvent({ t: 'event', seq: 1, kind: 'SessionStart', payload: { hook_event_name: 'SessionStart' } })
    h.hookEvent('PermissionRequest', { hook_event_name: 'PermissionRequest', tool_name: 'Bash' })
    await until(() => events.length === SIX.length + 1, 'the next PermissionRequest')
    await tick(30)
    expect(takenBy(1)).toEqual([...SIX.map((k, i): [number, string] => [i + 1, k]), [8, 'PermissionRequest']])
    expect(events.every((e) => e.id === TAB)).toBe(true)
  })

  it('a Claude Code session\'s connection still takes the nine only: a PermissionRequest its holder sends is not taken', async () => {
    const m = await startedWith(makeManager(1))
    spawnAgentPty({ sessionId: CLAUDE_TAB, kind: 'claude' }, SHELL, [], agentOpts())
    const csid = heldAgentSessionId(CLAUDE_TAB, 'claude')
    await until(() => logs.includes(`[session-helper] ${CLAUDE_TAB}: its hook events go through its holder, PreToolUse included`), 'its hooks to go through its holder')
    const h = helper.holders.get(csid)!
    // Its launch is the frame it was: no hook kinds, none of the hook mode's variables.
    expect(launchOf(h).hookKinds).toBeUndefined()
    expect(Object.keys(launchOf(h).env).filter((k) => k.startsWith('AICC_HELPER_'))).toEqual([])
    h.hookEvent('PermissionRequest', { hook_event_name: 'PermissionRequest' })
    h.hookEvent('Stop', { hook_event_name: 'Stop' })
    await until(() => events.length === 1, 'the Stop')
    await tick(30)
    expect(takenBy(1)).toEqual([[2, 'Stop']])
    expect(m.serviceState().state).toBe('ready')
  })

  it('a holder from before 2.1.3-beta.18 (no `status`), the gateway not taking hook events, or no kinds declared: the launch is the frame it was, and its hooks stay on the gateway, with one line saying why', async () => {
    const cases: Array<{ name: string; set: () => void; why: string }> = [
      { name: 'an older holder', set: () => { helper.holderCaps = [...CAPS_17] }, why: 'its holder does not take the hook kinds a launch declares (a session helper from before 2.1.3-beta.18)' },
      { name: 'the gateway off', set: () => { taking = false }, why: 'the hooks gateway is off or not listening, so no hook event would be taken' },
      { name: 'none declared', set: () => { declared = undefined }, why: 'its provider declares no hook kinds a holder takes' },
      { name: 'more than a holder takes', set: () => { declared = Array.from({ length: 17 }, (_, i) => `Kind${i}`) }, why: 'its provider declares no hook kinds a holder takes' },
    ]
    const m = await startedWith(makeManager(1))
    for (const [i, c] of cases.entries()) {
      helper.holderCaps = [...CAPS_18]
      taking = true
      declared = SIX
      c.set()
      const tab = `abcdef0123456789abcdee6${i}`
      const csid = heldAgentSessionId(tab, 'codex')
      spawnAgentPty({ sessionId: tab, kind: 'codex' }, SHELL, [], agentOpts())
      await until(() => !!helper.holders.get(csid)?.attached, `${c.name}: the session to attach`)
      const h = helper.holders.get(csid)!
      expect(launchOf(h).hookKinds, c.name).toBeUndefined()
      expect(launchOf(h).env, c.name).toEqual(agentOpts().env)
      expect(logs, c.name).toContain(`[session-helper] ${tab}: its hooks stay on the hooks gateway, because ${c.why}`)
      taking = true
      h.hookEvent('Stop', { hook_event_name: 'Stop' })
    }
    await tick(30)
    expect(events).toEqual([])
    expect(m.serviceState().state).toBe('ready')
  })

  it('a launch its holder refuses starts the usual way with the spawn\'s own environment: no hook mode variable reaches it', async () => {
    helper.holdBusy = true
    await startedWith(makeManager(1))
    const p = spawnAgentPty({ sessionId: TAB, kind: 'codex' }, SHELL, [], agentOpts())
    await until(() => ptySpawn.mock.calls.length === 1, 'the usual start')
    expect((p as HelperPty).throughHelper).toBe(false)
    expect(ptySpawn.mock.calls[0][2].env).toEqual(agentOpts().env)
    expect(logs).not.toContain(VIA_LAUNCH)
  })
})

describe('an app update: a held Codex session\'s hook events wait in its holder and reach the take-over, in order, once', () => {
  it('the release marks its record; events made after the let-go and before the next start arrive at the take-over once each, in order, and the old run takes none of them', async () => {
    const { m1, codex, h } = await runOne()
    await until(() => logs.includes(VIA_LAUNCH), 'its hooks to go through its holder')
    h.hookEvent('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await until(() => takenBy(1).length === 1, 'the event before the update')
    expect(m1.releaseForUpdate(new Set([TAB]))).toBe(1)
    await m1.endsForUpdate()
    expect(keptRecord()).toMatchObject({ provider: 'codex', label: TAB, hooks: 'holder' })
    codex.kill()
    // In the update gap: no app is attached, so each waits in the holder.
    h.hookEvent('PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Bash' })
    h.hookEvent('PermissionRequest', { hook_event_name: 'PermissionRequest', tool_name: 'Bash' })
    h.hookEvent('PostToolUse', { hook_event_name: 'PostToolUse', tool_name: 'Bash' })
    exit(m1)
    h.hookEvent('Stop', { hook_event_name: 'Stop' })
    const m2 = await startedWith(makeManager(2))
    await until(() => !!h.attached, 'the keeper to attach')
    const keeper = h.attached
    expect(takeKeptSession(TAB, 'codex', SIZE, ACCOUNT)).not.toBeNull()
    await until(() => !!h.attached && h.attached !== keeper && h.attached.ackedCaps.includes('hooks'), 'the take-over to attach')
    await until(() => takenBy(2).length === 4, 'the four events at the take-over')
    await tick(50)
    expect(takenBy(1)).toEqual([[1, 'UserPromptSubmit']])
    expect(takenBy(2)).toEqual([[2, 'PreToolUse'], [3, 'PermissionRequest'], [4, 'PostToolUse'], [5, 'Stop']])
    // After the take-over: on, the six still its kinds.
    h.hookEvent('Notification', { hook_event_name: 'Notification' })
    h.hookEvent('SessionStart', { hook_event_name: 'SessionStart', source: 'resume' })
    await until(() => takenBy(2).length === 5, 'the next event')
    await tick(30)
    expect(takenBy(2).at(-1)).toEqual([7, 'SessionStart'])
    expect(m2.serviceState().state).toBe('ready')
  })

  it('a Codex session whose hooks stayed on the gateway (an older holder) is still kept, with no mark; its take-over takes no hook event through its holder (its hook file is written again instead)', async () => {
    helper.holderCaps = [...CAPS_17]
    const { m1, codex, h } = await runOne()
    expect(logs).not.toContain(VIA_LAUNCH)
    expect(m1.releaseForUpdate(new Set([TAB]))).toBe(1)
    await m1.endsForUpdate()
    expect(keptRecord()).toMatchObject({ provider: 'codex', label: TAB })
    expect(keptRecord()).not.toHaveProperty('hooks')
    codex.kill()
    exit(m1)
    h.hookEvent('Stop', { hook_event_name: 'Stop' })
    await startedWith(makeManager(2))
    await until(() => !!h.attached, 'the keeper to attach')
    const keeper = h.attached
    expect(takeKeptSession(TAB, 'codex', SIZE, ACCOUNT)).not.toBeNull()
    await until(() => !!h.attached && h.attached !== keeper, 'the take-over to attach')
    expect(h.attached!.ackedCaps).not.toContain('hooks')
    await tick(50)
    expect(events).toEqual([])
    expect(logs).not.toContain(`[session-helper] ${TAB}: its hook events go through its holder from the take-over, PreToolUse included`)
  })

  it('a record a 2.1.3-beta.17 start wrote (no mark) of a session whose launch did send them through its holder: taken over with no hook route, so its hook file is written again (the plan keeps that branch one more beta)', async () => {
    const { m1, codex, h } = await runOne()
    await until(() => logs.includes(VIA_LAUNCH), 'its hooks to go through its holder')
    expect(m1.releaseForUpdate(new Set([TAB]))).toBe(1)
    await m1.endsForUpdate()
    codex.kill()
    exit(m1)
    // As the earlier version wrote it: the same record without the mark.
    const rec = keptRecord()
    delete rec.hooks
    writeFileSync(join(root, 'kept', `${sid}.json`), JSON.stringify(rec))
    await startedWith(makeManager(2))
    await until(() => !!h.attached, 'the keeper to attach')
    const keeper = h.attached
    expect(takeKeptSession(TAB, 'codex', SIZE, ACCOUNT)).not.toBeNull()
    await until(() => !!h.attached && h.attached !== keeper, 'the take-over to attach')
    expect(h.attached!.ackedCaps).not.toContain('hooks')
    expect(existsSync(join(root, 'kept', `${sid}.json`))).toBe(false)
  })
})
