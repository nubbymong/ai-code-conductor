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
  machinesSource: vi.fn(),
  current: null as unknown,
  quitAnswer: null as Promise<void> | null,
  /** The last run with the helper on did not quit normally (its running mark is there). */
  crashMark: false,
  crashMarkAsked: [] as string[],
  /** The store holds an agent session's record a quit left (a held CLI it could not wait to end). */
  agentRecords: false,
  agentRecordsAsked: [] as string[],
}))

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'C:\\app' } }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => { if (h.settings === null) throw new Error('unreadable'); return h.settings } }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {} }))
vi.mock('../../../src/main/ipc/machines-handlers', () => ({ setMachinesSource: h.machinesSource }))
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
    releaseForUpdate = vi.fn((tabs: ReadonlySet<string>) => tabs.size)
    reclaim = vi.fn(() => 0)
    serviceState =() => ({ state: this.enabled ? 'ready' : 'off', held: 0, lastError: null })
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
  }
})

import {
  QUIT_WAIT_MS, agentSessionsThroughHelperIn, applySessionHelperSettings, holdQuitForSessionHelper, initSessionHelper, noteSessionHelperTabs, plainTerminalsThroughHelperIn,
  reclaimReleasedTerminals, releaseHeldTerminalsForUpdate, sessionHelperServiceState, shutdownSessionHelper,
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

describe('an app update on Windows (plan section B2)', () => {
  it('with no helper this run (both switches off, no crash mark): the release and the reclaim do nothing, and nothing is made or read', () => {
    initSessionHelper(() => {})
    expect(h.made).toHaveLength(0)
    h.savedState = { sessions: [{ id: 'abcdef0123456789abcdef01' }] }
    expect(releaseHeldTerminalsForUpdate()).toBe(0)
    expect(() => reclaimReleasedTerminals()).not.toThrow()
    expect(h.made).toHaveLength(0)
    expect(h.current).toBeNull()
    expect(h.savedStateReads).toBe(0)
  })

  it('with the helper on: the manager is told the tabs in the saved file, and the reclaim reaches it', () => {
    h.settings = { plainTerminalsThroughHelper: true }
    initSessionHelper(() => {})
    const m = h.made[0]
    // Ids as the file holds them; anything that is not an id is no tab.
    h.savedState = { sessions: [{ id: 'abcdef0123456789abcdef01' }, { id: 'abcdef0123456789abcdef02' }, null, { id: 7 }, 'x'] }
    expect(releaseHeldTerminalsForUpdate()).toBe(2)
    expect([...m.releaseForUpdate.mock.calls[0][0]]).toEqual(['abcdef0123456789abcdef01', 'abcdef0123456789abcdef02'])
    reclaimReleasedTerminals()
    expect(m.reclaim).toHaveBeenCalledTimes(1)
  })

  it('a saved file "Close without saving" cleared, or one that does not read: the manager is told no tab, so it lets go of none', () => {
    h.settings = { plainTerminalsThroughHelper: true }
    initSessionHelper(() => {})
    const m = h.made[0]
    h.savedState = null
    expect(releaseHeldTerminalsForUpdate()).toBe(0)
    h.savedState = new Error('session-state.json did not parse')
    expect(releaseHeldTerminalsForUpdate()).toBe(0)
    expect(m.releaseForUpdate.mock.calls.map((c) => [...c[0]])).toEqual([[], []])
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
