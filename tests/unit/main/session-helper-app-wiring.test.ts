import { describe, it, expect, vi, beforeEach } from 'vitest'

// The session helper's place in the app (2.1.3-beta.6, plan section B): made
// from the saved setting, plugged into the Machines page, switched by a
// settings save, ended at a normal quit. The manager is a fake here, so
// nothing is copied or started.

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown> | null,
  made: [] as Array<{ deps: Record<string, unknown>; start: ReturnType<typeof vi.fn>; stopRouting: ReturnType<typeof vi.fn>; shutdown: ReturnType<typeof vi.fn>; noteSavedTabs: ReturnType<typeof vi.fn>; enabled: boolean }>,
  machinesSource: vi.fn(),
  current: null as unknown,
  quitAnswer: null as Promise<void> | null,
}))

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'C:\\app' } }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => { if (h.settings === null) throw new Error('unreadable'); return h.settings } }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {} }))
vi.mock('../../../src/main/ipc/machines-handlers', () => ({ setMachinesSource: h.machinesSource }))
vi.mock('../../../src/main/session-helper/install', () => ({ helperRootDir: () => 'C:\\user\\helper', bundledHelperPath: () => 'C:\\app\\helper\\aicc-helper.exe' }))
vi.mock('../../../src/main/session-helper/manager', () => {
  class SessionHelperManager {
    enabled = false
    start = vi.fn(async () => { this.enabled = true })
    stopRouting = vi.fn(() => { this.enabled = false })
    shutdown = vi.fn((): Promise<void> | null => h.quitAnswer)
    noteSavedTabs = vi.fn()
    serviceState = () => ({ state: this.enabled ? 'ready' : 'off', held: 0, lastError: null })
    constructor(readonly deps: Record<string, unknown>) { h.made.push(this as never) }
    onChange() {}
    isEnabled() { return this.enabled }
  }
  return {
    SessionHelperManager,
    getSessionHelper: () => h.current,
    setSessionHelper: (m: unknown) => { h.current = m },
  }
})

import {
  QUIT_WAIT_MS, applySessionHelperSettings, holdQuitForSessionHelper, initSessionHelper, noteSessionHelperTabs, plainTerminalsThroughHelperIn,
  sessionHelperServiceState, shutdownSessionHelper,
} from '../../../src/main/session-helper/app-wiring'

beforeEach(() => {
  h.settings = {}
  h.quitAnswer = null
  h.made.length = 0
  h.current = null
  h.machinesSource.mockReset()
})

describe('session helper wiring', () => {
  it('the setting is on only when saved as true', () => {
    expect(plainTerminalsThroughHelperIn({ plainTerminalsThroughHelper: true })).toBe(true)
    for (const v of [undefined, null, {}, { plainTerminalsThroughHelper: 'true' }, { plainTerminalsThroughHelper: 1 }]) expect(plainTerminalsThroughHelperIn(v)).toBe(false)
  })

  it('off at start-up (or an unreadable settings file): nothing is made, the Machines page keeps its off source', () => {
    initSessionHelper(() => {})
    h.settings = null
    initSessionHelper(() => {})
    expect(h.made).toHaveLength(0)
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
    expect(h.made[0].start).toHaveBeenCalledWith({ atStartup: true })
    expect(h.machinesSource).toHaveBeenCalledWith(h.made[0])
  })

  it('a settings save switches it: on starts it (not as a start-up), off stops routing; terminals already through it keep running', () => {
    applySessionHelperSettings()
    expect(h.made).toHaveLength(0)
    h.settings = { plainTerminalsThroughHelper: true }
    applySessionHelperSettings()
    expect(h.made).toHaveLength(1)
    expect(h.made[0].start).toHaveBeenCalledWith({ atStartup: false })
    // Saved again while on: not started twice.
    applySessionHelperSettings()
    expect(h.made[0].start).toHaveBeenCalledTimes(1)
    h.settings = {}
    applySessionHelperSettings()
    expect(h.made[0].stopRouting).toHaveBeenCalledTimes(1)
    expect(h.made[0].shutdown).not.toHaveBeenCalled()
    // On again: the same manager, started again.
    h.settings = { plainTerminalsThroughHelper: true }
    applySessionHelperSettings()
    expect(h.made).toHaveLength(1)
    expect(h.made[0].start).toHaveBeenCalledTimes(2)
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
