import { describe, it, expect, vi, beforeEach } from 'vitest'

// The session helper's place in the app (2.1.3-beta.6, plan section B): made
// from the saved setting, plugged into the Machines page, switched by a
// settings save, ended at a normal quit. The manager is a fake here, so
// nothing is copied or started.

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown> | null,
  made: [] as Array<{ deps: Record<string, unknown>; start: ReturnType<typeof vi.fn>; setRouting: ReturnType<typeof vi.fn>; stopRouting: ReturnType<typeof vi.fn>; shutdown: ReturnType<typeof vi.fn>; noteSavedTabs: ReturnType<typeof vi.fn>; releaseForUpdate: ReturnType<typeof vi.fn>; reclaim: ReturnType<typeof vi.fn>; enabled: boolean }>,
  /** The saved session file as peekSessionState reads it; an Error: it does not read. */
  savedState: null as { sessions: unknown[] } | null | Error,
  savedStateReads: 0,
  /** What the manager's endsForUpdate answers. */
  updateEnds: Promise.resolve() as Promise<void>,
  machinesSource: vi.fn(),
  current: null as unknown,
  quitAnswer: null as Promise<void> | null,
  /** The last run with the helper on did not quit normally (its running mark is there). */
  crashMark: false,
  crashMarkAsked: [] as string[],
  /** The store holds an agent session's record a quit left (a held CLI it could not wait to end). */
  agentRecords: false,
  agentRecordsAsked: [] as string[],
  /** 2.1.3-beta.8 (A4): what the hooks wiring calls. */
  switchHooks: vi.fn((_a: unknown) => 'switched'),
  helperEvent: vi.fn(),
  helperEnded: vi.fn(),
  helperTaking: vi.fn(() => true),
  /** 2.1.3-beta.11 (B2): what the tools wiring calls. */
  mcpPort: 19333,
  serveStream: vi.fn((_id: string, _link: unknown) => true),
  switchMcp: vi.fn((_a: unknown) => 'switched'),
  providers: {} as Record<string, unknown>,
  /** 2.1.3-beta.15 (B1): what readConfigChecked says of a settings file that gives nothing (settings null). */
  settingsOutcome: 'failed' as 'absent' | 'unparseable' | 'failed',
  /** Each start-up clean-up of old copies begun, with what it was given. */
  cleanUps: [] as Array<{ root: string; bundled: string; stop: () => boolean }>,
  /** Set: a clean-up ends only once this settles (a slow listing). */
  cleanUpGate: null as Promise<void> | null,
}))

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'C:\\app' } }))
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: () => { if (h.settings === null) throw new Error('unreadable'); return h.settings },
  readConfigChecked: () => (h.settings === null ? { value: null, outcome: h.settingsOutcome } : { value: h.settings, outcome: 'ok' }),
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {} }))
vi.mock('../../../src/main/ipc/machines-handlers', () => ({ setMachinesSource: h.machinesSource }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  getLocalSessionSettingsPath: (id: string) => `C:/Users/u/.claude/settings-${id}.json`,
  getLocalSessionMcpConfigPath: (id: string) => `C:/Users/u/.claude/mcp-${id}.json`,
  switchMcpConfigToHelper: h.switchMcp,
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => h.mcpPort, serveToolStream: h.serveStream }))
vi.mock('../../../src/main/providers', () => ({ tryGetProvider: (id: string) => h.providers[id] }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ switchHooksToHelper: h.switchHooks }))
vi.mock('../../../src/main/session-signals/hooks', () => ({ helperHookEvent: h.helperEvent, endHelperHooks: h.helperEnded, helperHooksTaken: h.helperTaking }))
vi.mock('../../../src/main/session-helper/install', () => ({ helperRootDir: () => 'C:\\user\\helper', bundledHelperPath: () => 'C:\\app\\helper\\aicc-helper.exe' }))
vi.mock('../../../src/main/session-state', () => ({
  peekSessionState: () => {
    h.savedStateReads++
    if (h.savedState instanceof Error) throw h.savedState
    return h.savedState
  },
}))
vi.mock('../../../src/main/session-helper/manager', () => {
  class SessionHelperManager {
    enabled = false
    start = vi.fn(async (o: { plain?: boolean; agents?: boolean }) => { this.enabled = (o.plain ?? true) || (o.agents ?? false) })
    setRouting = vi.fn((r: { plain: boolean; agents: boolean }) => { this.enabled = r.plain || r.agents })
    stopRouting = vi.fn(() => { this.enabled = false })
    shutdown = vi.fn((): Promise<void> | null => h.quitAnswer)
    noteSavedTabs = vi.fn()
    releaseForUpdate = vi.fn((tabs: ReadonlySet<string> | null) => tabs?.size ?? 0)
    endsForUpdate = vi.fn(() => h.updateEnds)
    reclaim = vi.fn(() => 0)
    serviceState = () => ({ state: this.enabled ? 'ready' : 'off', held: 0, lastError: null })
    constructor(readonly deps: Record<string, unknown>) { h.made.push(this as never) }
    onChange() {}
    isEnabled() { return this.enabled }
  }
  return {
    SessionHelperManager,
    getSessionHelper: () => h.current,
    crashMarkIn: (root: string) => { h.crashMarkAsked.push(root); return h.crashMark },
    agentRecordsIn: (root: string) => { h.agentRecordsAsked.push(root); return h.agentRecords },
    setSessionHelper: (m: unknown) => { h.current = m },
    removeOldCopiesWithHelperOff: async (opts: { root: string; bundled: string; stop: () => boolean }) => {
      h.cleanUps.push(opts)
      if (h.cleanUpGate) await h.cleanUpGate
      return []
    },
  }
})

import {
  QUIT_WAIT_MS, agentSessionsThroughHelperIn, applySessionHelperSettings, holdQuitForSessionHelper, initSessionHelper, noteSessionHelperTabs, plainTerminalsThroughHelperIn,
  UPDATE_END_WAIT_MS, reclaimReleasedTerminals, releaseHeldTerminalsForUpdate, sessionHelperServiceState, shutdownSessionHelper,
} from '../../../src/main/session-helper/app-wiring'

beforeEach(() => {
  h.settings = {}
  h.quitAnswer = null
  h.crashMark = false
  h.crashMarkAsked.length = 0
  h.agentRecords = false
  h.agentRecordsAsked.length = 0
  h.made.length = 0
  h.current = null
  h.machinesSource.mockReset()
  h.savedState = null
  h.savedStateReads = 0
  h.updateEnds = Promise.resolve()
  h.settingsOutcome = 'failed'
  h.cleanUps.length = 0
  h.cleanUpGate = null
})

describe('session helper wiring', () => {
  it('the setting is on only when saved as true', () => {
    expect(plainTerminalsThroughHelperIn({ plainTerminalsThroughHelper: true })).toBe(true)
    for (const v of [undefined, null, {}, { plainTerminalsThroughHelper: 'true' }, { plainTerminalsThroughHelper: 1 }]) expect(plainTerminalsThroughHelperIn(v)).toBe(false)
    // 2.1.3-beta.7: the agent sessions' setting, the same way, and each on its own.
    expect(agentSessionsThroughHelperIn({ agentSessionsThroughHelper: true })).toBe(true)
    for (const v of [undefined, null, {}, { agentSessionsThroughHelper: 'true' }, { agentSessionsThroughHelper: 1 }, { plainTerminalsThroughHelper: true }]) expect(agentSessionsThroughHelperIn(v)).toBe(false)
    expect(plainTerminalsThroughHelperIn({ agentSessionsThroughHelper: true })).toBe(false)
  })

  it('off at start-up (or an unreadable settings file), with no crash mark: nothing is made, the Machines page keeps its off source', () => {
    initSessionHelper(() => {})
    h.settings = null
    initSessionHelper(() => {})
    expect(h.made).toHaveLength(0)
    // The mark was looked for, in the helper's own folder, and so was an
    // agent session a quit left held.
    expect(h.crashMarkAsked).toEqual(['C:\\user\\helper', 'C:\\user\\helper'])
    expect(h.agentRecordsAsked).toEqual(['C:\\user\\helper', 'C:\\user\\helper'])
    expect(h.machinesSource).not.toHaveBeenCalled()
    expect(sessionHelperServiceState()).toBeNull()
    // And the quit and the tab note have nothing to do.
    shutdownSessionHelper()
    noteSessionHelperTabs({ sessions: [{ id: 'a' }] })
  })

  it('on at start-up: one manager, plugged into the Machines page, started as a start-up (crash re-attach)', () => {
    h.settings = { plainTerminalsThroughHelper: true }
    initSessionHelper(() => {})
    expect(h.made).toHaveLength(1)
    expect(h.made[0].deps).toMatchObject({ root: 'C:\\user\\helper', bundled: 'C:\\app\\helper\\aicc-helper.exe' })
    expect(h.made[0].start).toHaveBeenCalledWith({ atStartup: true, plain: true, agents: false })
    expect(h.machinesSource).toHaveBeenCalledWith(h.made[0])
  })

  it('the agent sessions\' setting alone at start-up: the helper comes up carrying agent sessions only', () => {
    h.settings = { agentSessionsThroughHelper: true }
    initSessionHelper(() => {})
    expect(h.made).toHaveLength(1)
    expect(h.made[0].start).toHaveBeenCalledWith({ atStartup: true, plain: false, agents: true })
  })

  it('both settings off with the crash mark there: the helper still comes up, carrying nothing new, to end what the crash left held', () => {
    h.crashMark = true
    initSessionHelper(() => {})
    expect(h.made).toHaveLength(1)
    expect(h.made[0].start).toHaveBeenCalledWith({ atStartup: true, plain: false, agents: false })
    expect(h.machinesSource).toHaveBeenCalledWith(h.made[0])
    // Not on: a settings save that turns one on starts it as a switch-on.
    h.settings = { agentSessionsThroughHelper: true }
    applySessionHelperSettings()
    expect(h.made).toHaveLength(1)
    expect(h.made[0].start).toHaveBeenLastCalledWith({ atStartup: false, plain: false, agents: true })
  })

  it('both settings off with no crash mark, but an agent session a quit left held: the helper still comes up, carrying nothing new, to end it before its tab starts again (PR review)', () => {
    h.agentRecords = true
    initSessionHelper(() => {})
    expect(h.made).toHaveLength(1)
    expect(h.made[0].start).toHaveBeenCalledWith({ atStartup: true, plain: false, agents: false })
    expect(h.machinesSource).toHaveBeenCalledWith(h.made[0])
  })

  it('a settings save switches it: on starts it (not as a start-up), off stops routing; terminals already through it keep running', () => {
    applySessionHelperSettings()
    expect(h.made).toHaveLength(0)
    h.settings = { plainTerminalsThroughHelper: true }
    applySessionHelperSettings()
    expect(h.made).toHaveLength(1)
    expect(h.made[0].start).toHaveBeenCalledWith({ atStartup: false, plain: true, agents: false })
    // Saved again while on: not started twice.
    applySessionHelperSettings()
    expect(h.made[0].start).toHaveBeenCalledTimes(1)
    // The agent sessions' setting turned on as well: the routing changes, no second start.
    h.settings = { plainTerminalsThroughHelper: true, agentSessionsThroughHelper: true }
    applySessionHelperSettings()
    expect(h.made[0].start).toHaveBeenCalledTimes(1)
    expect(h.made[0].setRouting).toHaveBeenLastCalledWith({ plain: true, agents: true })
    // The plain one off, the agent one still on: still on, carrying agent sessions only.
    h.settings = { agentSessionsThroughHelper: true }
    applySessionHelperSettings()
    expect(h.made[0].setRouting).toHaveBeenLastCalledWith({ plain: false, agents: true })
    expect(h.made[0].stopRouting).not.toHaveBeenCalled()
    h.settings = {}
    applySessionHelperSettings()
    expect(h.made[0].stopRouting).toHaveBeenCalledTimes(1)
    expect(h.made[0].shutdown).not.toHaveBeenCalled()
    // On again: the same manager, started again.
    h.settings = { plainTerminalsThroughHelper: true }
    applySessionHelperSettings()
    expect(h.made).toHaveLength(1)
    expect(h.made[0].start).toHaveBeenCalledTimes(2)
    expect(h.made[0].start).toHaveBeenLastCalledWith({ atStartup: false, plain: true, agents: false })
  })

  it('the saved tabs reach the manager, and a normal quit shuts it down', () => {
    h.settings = { plainTerminalsThroughHelper: true }
    initSessionHelper(() => {})
    noteSessionHelperTabs({ sessions: [{ id: 'a', label: 'A', customName: 'Mine' }] })
    expect(h.made[0].noteSavedTabs).toHaveBeenCalledWith([{ id: 'a', label: 'A', customName: 'Mine' }])
    noteSessionHelperTabs(null)
    expect(h.made[0].noteSavedTabs).toHaveBeenLastCalledWith([])
    shutdownSessionHelper()
    expect(h.made[0].shutdown).toHaveBeenCalledTimes(1)
  })
})

// 2.1.3-beta.15 (plan section B1, aicc_planning#397): a start with both
// switches off and nothing to end removes the old helper copies an earlier
// run left. The clean-up itself (manager.ts removeOldCopiesWithHelperOff) is
// a fake here; it is checked in session-helper-old-copies.test.ts.
describe('the start-up clean-up of old helper copies (B1)', () => {
  it('both off with nothing to end: one clean-up, in the helper\'s folder, with the installed helper, and no manager; a settings file that is not there counts as off', () => {
    initSessionHelper(() => {})
    expect(h.cleanUps).toHaveLength(1)
    expect(h.cleanUps[0]).toMatchObject({ root: 'C:\\user\\helper', bundled: 'C:\\app\\helper\\aicc-helper.exe' })
    expect(h.cleanUps[0].stop()).toBe(false)
    h.settings = null
    h.settingsOutcome = 'absent'
    initSessionHelper(() => {})
    expect(h.cleanUps).toHaveLength(2)
    expect(h.made).toHaveLength(0)
  })

  it('a settings file that is there and cannot be read, or does not parse (both off to routing()), begins no clean-up', () => {
    for (const outcome of ['failed', 'unparseable'] as const) {
      h.settings = null
      h.settingsOutcome = outcome
      initSessionHelper(() => {})
    }
    expect(h.cleanUps).toHaveLength(0)
    expect(h.made).toHaveLength(0)
  })

  it('a switch on, a crash mark or an agent record at start-up: no clean-up, and the manager comes up as before', () => {
    h.settings = { plainTerminalsThroughHelper: true }
    initSessionHelper(() => {})
    h.settings = {}
    h.crashMark = true
    initSessionHelper(() => {})
    h.crashMark = false
    h.agentRecords = true
    initSessionHelper(() => {})
    expect(h.cleanUps).toHaveLength(0)
    expect(h.made).toHaveLength(1)
    expect(h.made[0].start.mock.calls).toEqual([
      [{ atStartup: true, plain: true, agents: false }],
      [{ atStartup: true, plain: false, agents: false }],
      [{ atStartup: true, plain: false, agents: false }],
    ])
  })

  it('a switch turned on while the clean-up runs: the clean-up stops once the manager exists, and the manager copies only once the clean-up has ended', async () => {
    let release!: () => void
    h.cleanUpGate = new Promise<void>((r) => { release = r })
    initSessionHelper(() => {})
    const { stop } = h.cleanUps[0]
    expect(stop()).toBe(false)
    h.settings = { agentSessionsThroughHelper: true }
    applySessionHelperSettings()
    expect(h.made).toHaveLength(1)
    expect(stop()).toBe(true)
    const copyAfter = h.made[0].deps.copyAfter as Promise<void>
    expect(copyAfter).toBeInstanceOf(Promise)
    let ended = false
    void copyAfter.then(() => { ended = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(ended).toBe(false)
    release()
    await copyAfter
    expect(ended).toBe(true)
  })
})

describe('an app update on Windows (plan section B2)', () => {
  it('with no helper this run (both switches off, no crash mark): the release and the reclaim do nothing, and nothing is made or read', async () => {
    initSessionHelper(() => {})
    expect(h.made).toHaveLength(0)
    h.savedState = { sessions: [{ id: 'abcdef0123456789abcdef01' }] }
    expect(await releaseHeldTerminalsForUpdate()).toBe(0)
    expect(() => reclaimReleasedTerminals()).not.toThrow()
    expect(h.made).toHaveLength(0)
    expect(h.current).toBeNull()
    expect(h.savedStateReads).toBe(0)
  })

  it('with the helper on: the manager is told the tabs in the saved file, and the reclaim reaches it', async () => {
    h.settings = { plainTerminalsThroughHelper: true }
    initSessionHelper(() => {})
    const m = h.made[0]
    // Ids as the file holds them; anything that is not an id is no tab.
    h.savedState = { sessions: [{ id: 'abcdef0123456789abcdef01' }, { id: 'abcdef0123456789abcdef02' }, null, { id: 7 }, 'x'] }
    expect(await releaseHeldTerminalsForUpdate()).toBe(2)
    expect([...m.releaseForUpdate.mock.calls[0][0]]).toEqual(['abcdef0123456789abcdef01', 'abcdef0123456789abcdef02'])
    reclaimReleasedTerminals()
    expect(m.reclaim).toHaveBeenCalledTimes(1)
  })

  /** What the manager was told on each call: null (discarded) or the tab ids. */
  const toldOf = (m: (typeof h.made)[number]) => m.releaseForUpdate.mock.calls.map((c) => (c[0] === null ? null : [...(c[0] as ReadonlySet<string>)]))

  it('with no discard passed (Save, or an update with no tab open and so no dialog), the state of the saved file never reads as a discard: a cleared file, one that does not read and one with no tab in it are each an empty set (section B3, PR review)', async () => {
    h.settings = { plainTerminalsThroughHelper: true }
    initSessionHelper(() => {})
    const m = h.made[0]
    // "Don't open" on the resume prompt cleared the file, and no tab was opened since.
    h.savedState = null
    expect(await releaseHeldTerminalsForUpdate()).toBe(0)
    h.savedState = new Error('session-state.json did not parse')
    expect(await releaseHeldTerminalsForUpdate({ discarded: false })).toBe(0)
    h.savedState = { sessions: [] }
    expect(await releaseHeldTerminalsForUpdate({})).toBe(0)
    expect(toldOf(m)).toEqual([[], [], []])
  })

  it('"Close sessions" on the update dialog passes the discard: the manager is told no set at all, whatever the saved file holds, a remote left running in it too (section B3, PR review)', async () => {
    h.settings = { plainTerminalsThroughHelper: true }
    initSessionHelper(() => {})
    const m = h.made[0]
    // With a remote left running, "Close sessions" writes a file with no tab
    // and that remote in it, instead of clearing it.
    h.savedState = { sessions: [], detachedRemotes: [{ configId: 'a-remote' }] } as { sessions: unknown[] }
    expect(await releaseHeldTerminalsForUpdate({ discarded: true })).toBe(0)
    h.savedState = null
    expect(await releaseHeldTerminalsForUpdate({ discarded: true })).toBe(0)
    h.savedState = { sessions: [{ id: 'abcdef0123456789abcdef01' }] }
    expect(await releaseHeldTerminalsForUpdate({ discarded: true })).toBe(0)
    // An unreadable file: the user's explicit choice still wins.
    h.savedState = new Error('session-state.json did not parse')
    expect(await releaseHeldTerminalsForUpdate({ discarded: true })).toBe(0)
    expect(toldOf(m)).toEqual([null, null, null, null])
  })

  it('the ends the manager sent are waited for before the update goes on, UPDATE_END_WAIT_MS at most (PR review)', async () => {
    vi.useFakeTimers()
    try {
      h.settings = { plainTerminalsThroughHelper: true }
      initSessionHelper(() => {})
      h.savedState = { sessions: [] }
      let answered!: () => void
      h.updateEnds = new Promise<void>((r) => { answered = r })
      let done = false
      void releaseHeldTerminalsForUpdate().then(() => { done = true })
      await vi.advanceTimersByTimeAsync(UPDATE_END_WAIT_MS - 1)
      expect(done).toBe(false)
      answered()
      await vi.advanceTimersByTimeAsync(0)
      expect(done).toBe(true)
      // One that never answers holds it UPDATE_END_WAIT_MS at most.
      h.updateEnds = new Promise<void>(() => { /* never */ })
      done = false
      void releaseHeldTerminalsForUpdate().then(() => { done = true })
      await vi.advanceTimersByTimeAsync(UPDATE_END_WAIT_MS - 1)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(done).toBe(true)
      expect(UPDATE_END_WAIT_MS).toBeLessThanOrEqual(1500)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a normal quit waits briefly for the holders', () => {
  const quitEvent = () => ({ preventDefault: vi.fn() })

  it('nothing through the helper (or no helper this run): the quit is not held', () => {
    const e = quitEvent()
    holdQuitForSessionHelper(e, () => { throw new Error('no exit expected') })
    expect(e.preventDefault).not.toHaveBeenCalled()
    h.settings = { plainTerminalsThroughHelper: true }
    initSessionHelper(() => {})
    shutdownSessionHelper()
    holdQuitForSessionHelper(e, () => { throw new Error('no exit expected') })
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('held once until every holder answered, then the app exits; a second will-quit passes', async () => {
    h.settings = { plainTerminalsThroughHelper: true }
    initSessionHelper(() => {})
    let answer!: () => void
    h.quitAnswer = new Promise<void>((r) => { answer = r })
    shutdownSessionHelper()
    const e = quitEvent()
    const exit = vi.fn()
    holdQuitForSessionHelper(e, exit)
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(exit).not.toHaveBeenCalled()
    answer()
    await new Promise((r) => setTimeout(r, 0))
    expect(exit).toHaveBeenCalledTimes(1)
    const again = quitEvent()
    holdQuitForSessionHelper(again, exit)
    expect(again.preventDefault).not.toHaveBeenCalled()
  })

  it('a holder that never answers holds the quit for QUIT_WAIT_MS at most', async () => {
    vi.useFakeTimers()
    try {
      h.settings = { plainTerminalsThroughHelper: true }
      initSessionHelper(() => {})
      h.quitAnswer = new Promise<void>(() => { /* never */ })
      shutdownSessionHelper()
      const exit = vi.fn()
      holdQuitForSessionHelper(quitEvent(), exit)
      await vi.advanceTimersByTimeAsync(QUIT_WAIT_MS - 1)
      expect(exit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(exit).toHaveBeenCalledTimes(1)
      expect(QUIT_WAIT_MS).toBeLessThanOrEqual(1500)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('index.ts calls the wiring at the right moments', () => {
  it('the tab note on every save, the switch on every settings save, the start before any tab, the end after every PTY', async () => {
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs')
    const { resolve } = await vi.importActual<typeof import('path')>('path')
    const src = readFileSync(resolve(__dirname, '../../../src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const save = src.indexOf("ipcMain.handle('session:save'")
    expect(src.indexOf('noteSessionHelperTabs(state)', save) - save).toBeLessThan(300)
    expect(src).toContain("try { applySessionHelperSettings() } catch (err) { logError('[main] session helper settings apply failed:', err) }")
    expect(src).toContain('helper: () => sessionHelperServiceState(),')
    const monitor = src.indexOf('setPtyIntegrityMonitor(ptyMonitor)')
    const init = src.indexOf('initSessionHelper(pushDiagnostics)')
    expect(monitor).toBeGreaterThan(0)
    expect(init).toBeGreaterThan(monitor)
    const kill = src.indexOf('    killAllPty()\n')
    const end = src.indexOf('shutdownSessionHelper()', kill)
    expect(kill).toBeGreaterThan(0)
    expect(end - kill).toBeLessThan(200)
    expect(src.match(/shutdownSessionHelper\(\)/g)).toHaveLength(1)
    // The will-quit hold, beside the before-quit that runs the teardown.
    const beforeQuit = src.indexOf("app.on('before-quit', (e) => closeCoordinator.onBeforeQuit(() => e.preventDefault()))")
    const willQuit = src.indexOf("app.on('will-quit', (e) => holdQuitForSessionHelper(e))")
    expect(beforeQuit).toBeGreaterThan(0)
    expect(willQuit - beforeQuit).toBeLessThan(300)
    expect(willQuit).toBeGreaterThan(beforeQuit)
  })
})

describe("Claude Code sessions' hooks through the holder (2.1.3-beta.8, plan section A4)", () => {
  it('the manager gets hooks for Claude Code sessions by their settings file and (2.1.3-beta.18) Codex sessions by their launch, each with the kinds its own package declares and wired to the session signals module', () => {
    h.settings = { agentSessionsThroughHelper: true }
    initSessionHelper(() => {})
    const hooks = h.made[0].deps.hooks as Record<string, { taking: () => boolean; useHelperHooks?: (id: string, t: unknown) => unknown; kinds?: () => readonly string[] | undefined; byLaunch?: true; keptOnGateway?: true; event: (id: string, e: unknown) => void; ended: (id: string) => void }>
    expect(Object.keys(hooks).sort()).toEqual(['claude', 'codex'])
    // Whether hook events are taken now is the session signals module's live answer.
    h.helperTaking.mockReturnValueOnce(false)
    expect(hooks.claude.taking()).toBe(false)
    expect(hooks.claude.taking()).toBe(true)
    expect(h.helperTaking).toHaveBeenCalledTimes(2)
    const target = { helperPath: 'C:/h/aicc-helper.exe', store: 'C:/h/store', sid: 'ag0123456789abcdef0123456789abcd', launcher: 'git-bash' }
    expect(hooks.claude.useHelperHooks!('abcdef0123456789abcdef01', target)).toBe('switched')
    expect(h.switchHooks).toHaveBeenCalledWith({ settingsPath: 'C:/Users/u/.claude/settings-abcdef0123456789abcdef01.json', sessionId: 'abcdef0123456789abcdef01', target })
    const e = { seq: 1, kind: 'Stop', payload: { hook_event_name: 'Stop' } }
    hooks.claude.event('abcdef0123456789abcdef01', e)
    expect(h.helperEvent).toHaveBeenCalledWith('abcdef0123456789abcdef01', e)
    hooks.claude.ended('abcdef0123456789abcdef01')
    expect(h.helperEnded).toHaveBeenCalledWith('abcdef0123456789abcdef01')
    // By its settings file, not its launch; kept at an update only with its
    // hook events through its holder.
    expect(hooks.claude.byLaunch).toBeUndefined()
    expect(hooks.claude.keptOnGateway).toBeUndefined()
    // Its kinds are the ones the Claude Code package declares, read from the
    // registered package at each call (none registered: none).
    h.providers = {}
    expect(hooks.claude.kinds!()).toBeUndefined()
    h.providers = { claude: { heldHookKinds: ['Stop', 'PreToolUse'] }, codex: { heldHookKinds: ['SessionStart'] } }
    expect(hooks.claude.kinds!()).toEqual(['Stop', 'PreToolUse'])
    h.providers = {}

    // Codex: no settings file to switch; the kinds its package declares go in
    // its launch, and one kept with its hooks on the gateway is still kept.
    expect(hooks.codex.useHelperHooks).toBeUndefined()
    expect(hooks.codex.byLaunch).toBe(true)
    expect(hooks.codex.keptOnGateway).toBe(true)
    h.providers = {}
    expect(hooks.codex.kinds!()).toBeUndefined()
    h.providers = { codex: {} }
    expect(hooks.codex.kinds!()).toBeUndefined()
    h.providers = { claude: { heldHookKinds: ['Stop'] }, codex: { heldHookKinds: ['SessionStart', 'PermissionRequest'] } }
    expect(hooks.codex.kinds!()).toEqual(['SessionStart', 'PermissionRequest'])
    h.providers = {}
    h.helperTaking.mockReturnValueOnce(false)
    expect(hooks.codex.taking()).toBe(false)
    const ce = { seq: 2, kind: 'PermissionRequest', payload: { hook_event_name: 'PermissionRequest' } }
    hooks.codex.event('abcdef0123456789abcdef02', ce)
    expect(h.helperEvent).toHaveBeenCalledWith('abcdef0123456789abcdef02', ce)
    hooks.codex.ended('abcdef0123456789abcdef02')
    expect(h.helperEnded).toHaveBeenCalledWith('abcdef0123456789abcdef02')
  })
})

describe('the Conductor tools through the holder (2.1.3-beta.11, plan section B2)', () => {
  type Tools = { serve: (id: string, link: unknown) => boolean; serving: () => boolean; useRelayConfig?: (id: string, r: unknown) => unknown; relayLaunch?: (id: string, l: unknown, r: unknown) => unknown }
  const relay = { helperPath: 'C:/h/aicc-helper.exe', store: 'C:/h/store', sid: 'ag0123456789abcdef0123456789abcd' }

  it('the manager gets the tool functions for Claude Code and Codex: the tool host serves the streams while it is started; Claude Code switches its MCP config file, Codex its launch, through its package', () => {
    h.settings = { agentSessionsThroughHelper: true }
    initSessionHelper(() => {})
    const tools = h.made[0].deps.tools as Record<string, Tools>
    expect(Object.keys(tools).sort()).toEqual(['claude', 'codex'])
    for (const t of Object.values(tools)) {
      // Serving is the tool host's live state: its port.
      h.mcpPort = 0
      expect(t.serving()).toBe(false)
      h.mcpPort = 19333
      expect(t.serving()).toBe(true)
      const link = { send() {}, take() {}, close() {} }
      h.serveStream.mockReturnValueOnce(false)
      expect(t.serve('abcdef0123456789abcdef01', link)).toBe(false)
      expect(h.serveStream).toHaveBeenLastCalledWith('abcdef0123456789abcdef01', link)
    }
    // Claude Code: its own file, through the writer; no launch form.
    expect(tools.claude.relayLaunch).toBeUndefined()
    expect(tools.claude.useRelayConfig!('abcdef0123456789abcdef01', relay)).toBe('switched')
    expect(h.switchMcp).toHaveBeenCalledWith({ configPath: 'C:/Users/u/.claude/mcp-abcdef0123456789abcdef01.json', sessionId: 'abcdef0123456789abcdef01', relay })
    // Codex: its package's relay form; no package, or none offered, keeps the loopback route.
    expect(tools.codex.useRelayConfig).toBeUndefined()
    const launch = { file: 'C:/c/codex.exe', args: ['-m', 'x'], env: {} }
    h.providers = {}
    expect(tools.codex.relayLaunch!('abcdef0123456789abcdef02', launch, relay)).toEqual({ refused: 'no-tools' })
    h.providers = { codex: {} }
    expect(tools.codex.relayLaunch!('abcdef0123456789abcdef02', launch, relay)).toEqual({ refused: 'no-tools' })
    const heldToolLaunch = vi.fn(() => ({ args: ['-m', 'x', '--relay'] }))
    h.providers = { codex: { heldToolLaunch } }
    expect(tools.codex.relayLaunch!('abcdef0123456789abcdef02', launch, relay)).toEqual({ args: ['-m', 'x', '--relay'] })
    expect(heldToolLaunch).toHaveBeenCalledWith('abcdef0123456789abcdef02', launch, relay)
    h.providers = {}
  })
})

describe("a held Codex session's screen reads (2.1.3-beta.14, plan section B2)", () => {
  it('the manager gets the screen reads, with the title, for Codex sessions only', () => {
    h.settings = { agentSessionsThroughHelper: true }
    initSessionHelper(() => {})
    expect(h.made[0].deps.screens).toEqual({ codex: true })
  })
})

describe('the take-over of a session an update kept running (2.1.3-beta.17, plan section B1)', () => {
  it('the manager is told to take over Claude Code\'s and Codex\'s kept sessions, reads the saved tabs from the saved file when asked, and only Claude Code\'s tool streams given back say the tool list changed', () => {
    h.settings = { agentSessionsThroughHelper: true }
    initSessionHelper(() => {})
    const deps = h.made[0].deps as { takeOver?: unknown; savedTabs?: () => ReadonlySet<string>; tools: Record<string, { listsAgain?: boolean; serve: (id: string, link: unknown, opts?: { toolsChanged?: boolean }) => boolean }> }
    expect(deps.takeOver).toEqual({ claude: true, codex: true })
    // The saved file is read only when the manager asks.
    expect(h.savedStateReads).toBe(0)
    h.savedState = { sessions: [{ id: 'abcdef0123456789abcdef01' }, { id: 'abcdef0123456789abcdef02' }] }
    expect(deps.savedTabs!()).toEqual(new Set(['abcdef0123456789abcdef01', 'abcdef0123456789abcdef02']))
    h.savedState = new Error('does not read')
    expect(deps.savedTabs!()).toEqual(new Set())
    // P20 (c): Claude Code lists its tools again on being told; Codex does not.
    expect(deps.tools.claude.listsAgain).toBe(true)
    expect(deps.tools.codex.listsAgain).toBeUndefined()
    const link = { send() {}, take() {}, close() {} }
    deps.tools.claude.serve('abcdef0123456789abcdef01', link, { toolsChanged: true })
    expect(h.serveStream).toHaveBeenLastCalledWith('abcdef0123456789abcdef01', link, { toolsChanged: true })
    deps.tools.claude.serve('abcdef0123456789abcdef01', link)
    expect(h.serveStream).toHaveBeenLastCalledWith('abcdef0123456789abcdef01', link)
  })
})
