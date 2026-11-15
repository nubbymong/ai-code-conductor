/**
 * 2.1.3-beta.4: Tokenomics as an optional service.
 *
 * Settings holds its switch (`tokenomicsEnabled`, on unless it is exactly
 * false) and the accounts its figures leave out. Off, at start-up or while
 * the app runs, there is no supervisor: no worker is forked and nothing that
 * exists only for it runs (the pricing refresh, the registry reload listener,
 * the account folder following). On again, a new worker is opened on the same
 * database, where each file's progress is kept, and whoever asked to be told
 * of a start is told, so its pushes are forwarded like the first one's.
 *
 * The worker is handed the two transcript folders and nothing wider. Saved
 * settings that cannot be read are no answer: the last values read stand,
 * and with none read yet nothing starts. A session attribution made while
 * no supervisor runs is kept for the next one.
 *
 * Host-safe: the service itself with every edge faked. No process is forked,
 * no file is read and no setting is saved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'

const world = vi.hoisted(() => ({
  /** What the saved settings hold: null is no settings file yet (a fresh
   *  install), anything else is what the file parses to. */
  settings: null as unknown,
  /** The settings file is there but the read gives nothing: it could not be
   *  read ('failed') or parsed ('unparseable'). */
  broken: null as null | 'failed' | 'unparseable',
  /** The reader itself throws. */
  throws: false,
  /** Whether a forked worker says it is ready when it is opened. */
  ready: true,
  unsubReload: vi.fn(),
  unsubAccounts: vi.fn(),
}))
const forks: FakeTkWorkerTransport[] = []
vi.mock('../../../src/main/tokenomics/fork-tokenomics-worker', () => ({
  forkTokenomicsWorker: () => {
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => { if (m.type === 'open' && world.ready) t.emitToMain({ type: 'ready', firstIndexComplete: true, eventsTotal: 7 }) })
    forks.push(t)
    return { transport: t, kill: () => t.kill(), onExit: () => {} }
  },
}))
vi.mock('../../../src/main/config-manager', () => ({
  // The saved configs, and the settings as an unchecked read gives them
  // (nothing, whatever the reason).
  readConfig: vi.fn((key: string) => (key === 'settings' ? (world.broken || world.throws ? null : world.settings) : [])),
  // The checked read the service uses for the settings: why it got nothing.
  readConfigChecked: vi.fn((key: string) => {
    if (key !== 'settings') return { outcome: 'ok', value: [] }
    if (world.throws) throw new Error('simulated read failure')
    if (world.broken) return { outcome: world.broken, value: null }
    return world.settings === null ? { outcome: 'absent', value: null } : { outcome: 'ok', value: world.settings }
  }),
}))
vi.mock('../../../src/main/data-paths', () => ({ getDataDirectory: () => 'F:\\data', getResourcesDirectory: () => 'F:\\resources' }))
const pricing = vi.hoisted(() => ({ fetchModelPricing: vi.fn(() => Promise.resolve()) }))
vi.mock('../../../src/main/tokenomics/tk-pricing', () => ({ getAllPricing: () => ({}), fetchModelPricing: pricing.fetchModelPricing }))
const registry = vi.hoisted(() => ({ onRegistryReload: vi.fn() }))
vi.mock('../../../src/main/model-registry-service', () => ({ onRegistryReload: registry.onRegistryReload }))
const accounts = vi.hoisted(() => ({ subscribe: vi.fn(), sessionsRoots: vi.fn(async () => []) }))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => accounts }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import {
  initTokenomics, applyTokenomicsSettings, shutdownTokenomics, getTokenomicsSupervisor, refreshTokenomicsConfigs,
  isTokenomicsOff, tokenomicsExcludedAccounts, onTokenomicsStart, tokenomicsEnabledIn, noteTokenomicsSessionAccount,
} from '../../../src/main/tokenomics/tokenomics-service'

const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
/** A session id of the shape a transcript file names, one per number. */
const sessionNo = (i: number): string => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
const sent = (fork: FakeTkWorkerTransport, type: string) => fork.workerMessages.filter((m) => m.type === type)

describe('Tokenomics as an optional service (2.1.3-beta.4)', () => {
  beforeEach(() => {
    shutdownTokenomics()
    forks.length = 0
    world.settings = null
    world.broken = null
    world.throws = false
    world.ready = true
    world.unsubReload.mockClear()
    world.unsubAccounts.mockClear()
    pricing.fetchModelPricing.mockClear()
    registry.onRegistryReload.mockReset().mockReturnValue(world.unsubReload)
    accounts.subscribe.mockReset().mockReturnValue(world.unsubAccounts)
    accounts.sessionsRoots.mockClear()
  })

  it('the switch is on unless the saved setting is exactly false', () => {
    for (const on of [null, undefined, {}, [], 'x', { tokenomicsEnabled: true }, { tokenomicsEnabled: 'no' }, { tokenomicsEnabled: 0 }, { tokenomicsEnabled: null }]) {
      expect(tokenomicsEnabledIn(on), JSON.stringify(on)).toBe(true)
    }
    expect(tokenomicsEnabledIn({ tokenomicsEnabled: false })).toBe(false)
  })

  it('off at start-up: no worker is forked and nothing that exists only for it runs', () => {
    world.settings = { tokenomicsEnabled: false }
    initTokenomics({ emit: () => {} })
    expect(forks).toHaveLength(0)
    expect(getTokenomicsSupervisor()).toBeNull()
    expect(isTokenomicsOff()).toBe(true)
    // The pricing refresh, the registry reload listener, the account folders.
    expect(pricing.fetchModelPricing).not.toHaveBeenCalled()
    expect(registry.onRegistryReload).not.toHaveBeenCalled()
    expect(accounts.subscribe).not.toHaveBeenCalled()
    expect(accounts.sessionsRoots).not.toHaveBeenCalled()
  })

  it('off, every caller of the service copes with no supervisor', () => {
    world.settings = { tokenomicsEnabled: false }
    initTokenomics({ emit: () => {} })
    const told = vi.fn()
    expect(() => refreshTokenomicsConfigs()).not.toThrow()
    expect(() => onTokenomicsStart(told)).not.toThrow()
    expect(told).not.toHaveBeenCalled()
    expect(() => applyTokenomicsSettings()).not.toThrow()
    expect(() => shutdownTokenomics()).not.toThrow()
    expect(forks).toHaveLength(0)
  })

  it('on at start-up, the default: one worker, opened on the usage database, with what runs beside it', () => {
    for (const settings of [null, {}, { tokenomicsEnabled: true }]) {
      shutdownTokenomics()
      forks.length = 0
      world.settings = settings
      initTokenomics({ emit: () => {} })
      expect(forks, JSON.stringify(settings)).toHaveLength(1)
      expect(String((sent(forks[0], 'open')[0] as { dbPath: string }).dbPath)).toContain('tokenomics.db')
      expect(getTokenomicsSupervisor()).not.toBeNull()
      expect(isTokenomicsOff()).toBe(false)
    }
    expect(pricing.fetchModelPricing).toHaveBeenCalled()
    expect(registry.onRegistryReload).toHaveBeenCalledTimes(3)
    expect(accounts.subscribe).toHaveBeenCalledTimes(3)
  })

  it('switched off while it runs: the worker is told to stop and killed, its listeners are dropped, and no supervisor is left', () => {
    initTokenomics({ emit: () => {} })
    expect(forks).toHaveLength(1)
    world.settings = { tokenomicsEnabled: false }
    applyTokenomicsSettings()
    expect(sent(forks[0], 'shutdown')).toHaveLength(1)
    expect(forks[0].killed).toBe(true)
    expect(world.unsubReload).toHaveBeenCalledTimes(1)
    expect(world.unsubAccounts).toHaveBeenCalledTimes(1)
    expect(getTokenomicsSupervisor()).toBeNull()
    expect(isTokenomicsOff()).toBe(true)
    // Saved again while off: still nothing.
    applyTokenomicsSettings()
    expect(forks).toHaveLength(1)
  })

  it('switched on while the app runs: a new worker is opened on the same database, and whoever asked is told of it', () => {
    world.settings = { tokenomicsEnabled: false }
    initTokenomics({ emit: () => {} })
    const started: unknown[] = []
    onTokenomicsStart((sup) => { started.push(sup) })
    expect(started).toHaveLength(0)

    world.settings = { tokenomicsEnabled: true }
    applyTokenomicsSettings()
    expect(forks).toHaveLength(1)
    expect(started).toEqual([getTokenomicsSupervisor()])
    const firstDb = (sent(forks[0], 'open')[0] as { dbPath: string }).dbPath
    // Saved again while on: the same worker, no second one.
    applyTokenomicsSettings()
    expect(forks).toHaveLength(1)

    // Off and on again: another worker, the same database (where each
    // file's progress is kept, so it reads on from there).
    world.settings = { tokenomicsEnabled: false }
    applyTokenomicsSettings()
    world.settings = {}
    applyTokenomicsSettings()
    expect(forks).toHaveLength(2)
    expect((sent(forks[1], 'open')[0] as { dbPath: string }).dbPath).toBe(firstDb)
    expect(started).toHaveLength(2)
    expect(started[1]).toBe(getTokenomicsSupervisor())
    expect(started[1]).not.toBe(started[0])
  })

  it('a start listener is attached before the worker says anything, so the first status is not missed', () => {
    world.settings = { tokenomicsEnabled: false }
    initTokenomics({ emit: () => {} })
    const statuses: Array<{ firstIndexComplete: boolean }> = []
    onTokenomicsStart((sup) => { sup.onIndexReady((s) => statuses.push(s)) })
    world.settings = { tokenomicsEnabled: true }
    applyTokenomicsSettings()
    // The fake worker is ready as it is opened, inside the start.
    expect(statuses).toHaveLength(1)
    expect(statuses[0].firstIndexComplete).toBe(true)
  })

  it('a listener told of the running supervisor at once is told of the next one too', () => {
    initTokenomics({ emit: () => {} })
    const started: unknown[] = []
    const off = onTokenomicsStart((sup) => { started.push(sup) })
    expect(started).toEqual([getTokenomicsSupervisor()])
    off()
    world.settings = { tokenomicsEnabled: false }
    applyTokenomicsSettings()
    world.settings = {}
    applyTokenomicsSettings()
    // Unsubscribed: not told of the second.
    expect(started).toHaveLength(1)
  })

  it('settings saved before the app started the service, or after it quit, start nothing', () => {
    applyTokenomicsSettings()
    expect(forks).toHaveLength(0)
    initTokenomics({ emit: () => {} })
    expect(forks).toHaveLength(1)
    shutdownTokenomics()
    applyTokenomicsSettings()
    expect(forks).toHaveLength(1)
    expect(getTokenomicsSupervisor()).toBeNull()
  })

  it('the accounts left out are read from the settings each time they are saved: account keys only, each once', () => {
    world.settings = { tokenomicsExcludedAccounts: ['claude:acct-a', 'claude:acct-a', '', 'bogus', 5, null, 'claude:acct-b', 'claude:a b'] }
    initTokenomics({ emit: () => {} })
    expect(tokenomicsExcludedAccounts()).toEqual(['claude:acct-a', 'claude:acct-b'])
    world.settings = { tokenomicsExcludedAccounts: 'claude:acct-a' }
    applyTokenomicsSettings()
    expect(tokenomicsExcludedAccounts()).toEqual([])
    // Read while switched off too, so they apply the moment it is on.
    world.settings = { tokenomicsEnabled: false, tokenomicsExcludedAccounts: ['claude:acct-b'] }
    applyTokenomicsSettings()
    expect(tokenomicsExcludedAccounts()).toEqual(['claude:acct-b'])
    // The caller's copy is its own.
    tokenomicsExcludedAccounts().push('claude:acct-c')
    expect(tokenomicsExcludedAccounts()).toEqual(['claude:acct-b'])
  })

  // The guard on the roots (with the worker's own in
  // tokenomics-worker-changed-files.test.ts): the worker walks what it is
  // handed, so a wider folder handed here would be a wider walk.
  it('the worker is handed the two transcript folders, each exactly, and nothing above them', () => {
    initTokenomics({ emit: () => {} })
    const open = sent(forks[0], 'open')[0] as { claudeProjectsDir: string; codexSessionsDir: string; codexRealmSessionsDirs?: unknown[] }
    expect(open.claudeProjectsDir).toBe(join(homedir(), '.claude', 'projects'))
    expect(open.codexSessionsDir).toBe(join(homedir(), '.codex', 'sessions'))
    // No account folder is handed at the start: each is named later, by its account.
    expect(open.codexRealmSessionsDirs).toEqual([])
    // Neither is the home folder or an assistant's whole folder.
    for (const wider of [homedir(), join(homedir(), '.claude'), join(homedir(), '.codex')]) {
      expect(open.claudeProjectsDir).not.toBe(wider)
      expect(open.codexSessionsDir).not.toBe(wider)
    }
  })

  // Saved settings that cannot be read are no answer, as for the provider
  // switches (provider-accounts.ts readSettings, accounts-service
  // savedPreference): never a yes, and the last value read stands.
  it('settings that cannot be read as the app comes up start nothing; the first save that can be read starts it', () => {
    for (const how of ['failed', 'unparseable', 'throws', 'not an object'] as const) {
      shutdownTokenomics()
      forks.length = 0
      world.broken = how === 'failed' || how === 'unparseable' ? how : null
      world.throws = how === 'throws'
      world.settings = how === 'not an object' ? 'on' : { tokenomicsEnabled: true, tokenomicsExcludedAccounts: ['claude:acct-a'] }
      initTokenomics({ emit: () => {} })
      expect(forks, how).toHaveLength(0)
      expect(getTokenomicsSupervisor(), how).toBeNull()
      expect(isTokenomicsOff(), how).toBe(true)
      expect(tokenomicsExcludedAccounts(), how).toEqual([])
      // Saved again, still unreadable: still nothing.
      applyTokenomicsSettings()
      expect(forks, how).toHaveLength(0)
      // Readable now.
      world.broken = null
      world.throws = false
      world.settings = { tokenomicsExcludedAccounts: ['claude:acct-a'] }
      applyTokenomicsSettings()
      expect(forks, how).toHaveLength(1)
      expect(isTokenomicsOff(), how).toBe(false)
      expect(tokenomicsExcludedAccounts(), how).toEqual(['claude:acct-a'])
    }
  })

  it('no settings file yet (a fresh install) is not an unreadable one: it starts, with nothing left out', () => {
    world.settings = null
    initTokenomics({ emit: () => {} })
    expect(forks).toHaveLength(1)
    expect(isTokenomicsOff()).toBe(false)
    expect(tokenomicsExcludedAccounts()).toEqual([])
  })

  it('settings that cannot be read while it runs change nothing: the worker is not stopped and the accounts left out stay', () => {
    world.settings = { tokenomicsExcludedAccounts: ['claude:acct-a'] }
    initTokenomics({ emit: () => {} })
    expect(forks).toHaveLength(1)
    for (const how of ['failed', 'unparseable', 'throws'] as const) {
      world.broken = how === 'throws' ? null : how
      world.throws = how === 'throws'
      applyTokenomicsSettings()
      expect(forks, how).toHaveLength(1)
      expect(sent(forks[0], 'shutdown'), how).toHaveLength(0)
      expect(getTokenomicsSupervisor(), how).not.toBeNull()
      expect(isTokenomicsOff(), how).toBe(false)
      expect(tokenomicsExcludedAccounts(), how).toEqual(['claude:acct-a'])
    }
  })

  it('settings that cannot be read after it was switched off do not start it, and do not drop the accounts left out', () => {
    world.settings = { tokenomicsEnabled: false, tokenomicsExcludedAccounts: ['claude:acct-b'] }
    initTokenomics({ emit: () => {} })
    expect(forks).toHaveLength(0)
    world.broken = 'failed'
    applyTokenomicsSettings()
    expect(forks).toHaveLength(0)
    expect(isTokenomicsOff()).toBe(true)
    expect(tokenomicsExcludedAccounts()).toEqual(['claude:acct-b'])
    // Readable again, and on: it starts with the list as saved.
    world.broken = null
    world.settings = { tokenomicsExcludedAccounts: ['claude:acct-b'] }
    applyTokenomicsSettings()
    expect(forks).toHaveLength(1)
    expect(tokenomicsExcludedAccounts()).toEqual(['claude:acct-b'])
  })

  // A Claude session that runs and ends while Tokenomics is off is read by
  // the catch-up; its account has to be there for it.
  it('an attribution made while Tokenomics is off is kept, and the worker started when it is switched on receives it', () => {
    world.settings = { tokenomicsEnabled: false }
    initTokenomics({ emit: () => {} })
    expect(noteTokenomicsSessionAccount(SESSION, 'claude:acct-a')).toBe(true)
    // The latest per session.
    expect(noteTokenomicsSessionAccount(sessionNo(1), 'claude:acct-a')).toBe(true)
    expect(noteTokenomicsSessionAccount(sessionNo(1), 'claude:acct-b')).toBe(true)
    // Not well formed: not kept, and said so.
    expect(noteTokenomicsSessionAccount('not-a-session', 'claude:acct-a')).toBe(false)
    expect(noteTokenomicsSessionAccount(sessionNo(2), '')).toBe(false)
    expect(noteTokenomicsSessionAccount(sessionNo(2), 'codex:acct-a')).toBe(false)
    expect(forks).toHaveLength(0)

    world.settings = {}
    applyTokenomicsSettings()
    expect(forks).toHaveLength(1)
    expect(sent(forks[0], 'set-session-account')).toEqual([
      { type: 'set-session-account', sessionId: SESSION, accountKey: 'claude:acct-a' },
      { type: 'set-session-account', sessionId: sessionNo(1), accountKey: 'claude:acct-b' },
    ])
    // With a supervisor it goes straight to the worker.
    expect(noteTokenomicsSessionAccount(sessionNo(3), 'claude:acct-a')).toBe(true)
    expect(sent(forks[0], 'set-session-account').at(-1)).toEqual({ type: 'set-session-account', sessionId: sessionNo(3), accountKey: 'claude:acct-a' })
    // Off and on again: everything is handed on once more, nothing twice.
    world.settings = { tokenomicsEnabled: false }
    applyTokenomicsSettings()
    world.settings = {}
    applyTokenomicsSettings()
    expect(sent(forks[1], 'set-session-account').map((m) => (m as { sessionId: string }).sessionId)).toEqual([SESSION, sessionNo(1), sessionNo(3)])
  })

  it('an attribution made before the app has started the service is kept for the first worker', () => {
    expect(noteTokenomicsSessionAccount(SESSION, 'claude:acct-a')).toBe(true)
    initTokenomics({ emit: () => {} })
    expect(sent(forks[0], 'set-session-account')).toEqual([{ type: 'set-session-account', sessionId: SESSION, accountKey: 'claude:acct-a' }])
  })

  it('the attributions kept while off are bounded: past 4096 the oldest is dropped', () => {
    world.settings = { tokenomicsEnabled: false }
    initTokenomics({ emit: () => {} })
    for (let i = 0; i <= 4096; i++) expect(noteTokenomicsSessionAccount(sessionNo(i), 'claude:acct-a')).toBe(true)
    world.settings = {}
    applyTokenomicsSettings()
    const got = sent(forks[0], 'set-session-account').map((m) => (m as { sessionId: string }).sessionId)
    expect(got).toHaveLength(4096)
    expect(got[0]).toBe(sessionNo(1))
    expect(got.at(-1)).toBe(sessionNo(4096))
  })

  it('a session attribution made while no worker was listening is not lost when the service is switched off and on', () => {
    // A worker that never says it is ready: the attribution is only kept.
    world.ready = false
    initTokenomics({ emit: () => {} })
    getTokenomicsSupervisor()!.setSessionAccount(SESSION, 'claude:acct-a')
    expect(sent(forks[0], 'set-session-account')).toHaveLength(0)

    world.settings = { tokenomicsEnabled: false }
    applyTokenomicsSettings()
    world.ready = true
    world.settings = {}
    applyTokenomicsSettings()
    expect(forks).toHaveLength(2)
    expect(sent(forks[1], 'set-session-account')).toEqual([{ type: 'set-session-account', sessionId: SESSION, accountKey: 'claude:acct-a' }])
  })
})
