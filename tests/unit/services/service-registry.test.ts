// The one service registry (src/main/services/service-registry.ts): one row
// per service, each on the host it really runs on, and a restart routed to
// whatever owns the row. The supervisors themselves are faked here; their own
// suites cover what each puts on its row. The merged log tail, the PTY block
// and the stall stamp are in diagnostics-merge.test.ts.
import { describe, it, expect, vi } from 'vitest'
import { createServiceRegistry, mcpServerRow } from '../../../src/main/services/service-registry'
import type { ServiceRegistrySources, SupervisedService, WatchdogService } from '../../../src/main/services/service-registry'
import { createInitialHealth, SERVICE_ID } from '../../../src/shared/service-health'
import type {
  DiagnosticsSnapshot,
  ServiceHealth,
  ServiceHost,
  ServiceLogEntry,
  ServiceState,
  WatchdogMonitorSnapshot,
} from '../../../src/shared/service-health'

const ROW_ORDER = ['hooks', 'logging', 'tokenomics', 'watchdog', 'mcp']

function row(id: string, label: string, host: ServiceHost, state: ServiceState = 'listening'): ServiceHealth {
  return { ...createInitialHealth(id, label, host), state }
}

/** A supervisor as the registry sees one: its row, its log tail, its restart. */
function supervised(r: ServiceHealth, log: ServiceLogEntry[] = []) {
  const snap: DiagnosticsSnapshot = { capturedAt: 1, services: [r], log }
  const sup = {
    getDiagnosticsSnapshot: vi.fn(() => snap),
    manualRestart: vi.fn((id: string) => ({ ok: true, reason: `${r.id} restarted as ${id}` })),
  }
  return sup satisfies SupervisedService
}

const MON: WatchdogMonitorSnapshot = {
  activeSessions: 2, waitingSessions: 1, silentSessions: 1,
  throttle: { stallsLastMin: 0, tickMs: 5000 },
  sessions: [{ sessionId: 's1', status: 'monitoring', gaveUp: false, waitUntil: null, silent: true, idleMs: 130000 }],
}

function watchdog(r: ServiceHealth = row('watchdog', 'Watchdog', 'in-process')) {
  const wd = {
    getMonitorSnapshot: vi.fn(() => MON),
    getDiagnosticsSnapshot: vi.fn((_mon?: WatchdogMonitorSnapshot): DiagnosticsSnapshot => ({ capturedAt: 1, services: [r], log: [] })),
    manualRestart: vi.fn((id: string) => ({ ok: true, reason: `watchdog restarted as ${id}` })),
  }
  return wd satisfies WatchdogService
}

/** Nothing running at all, unless a test says otherwise. */
function sources(over: Partial<ServiceRegistrySources> = {}): ServiceRegistrySources {
  return {
    hooks: () => null,
    logging: () => null,
    tokenomics: () => null,
    watchdog: () => null,
    mcp: () => ({ running: false, port: 0 }),
    ...over,
  }
}

describe('service registry: the rows', () => {
  it('pins the row ids the supervisors and the panel match on', () => {
    expect(SERVICE_ID).toEqual({ hooks: 'hooks', logging: 'logging', tokenomics: 'tokenomics', watchdog: 'watchdog', mcp: 'mcp' })
  })

  it('lists one row per service in a fixed order, whatever is running', () => {
    const none = createServiceRegistry(sources())
    expect(none.snapshot().services.map((s) => s.id)).toEqual(ROW_ORDER)

    const all = createServiceRegistry(sources({
      hooks: () => supervised(row('hooks', 'Hooks gateway', 'utility-process')),
      logging: () => supervised(row('logging', 'Session logging', 'utility-process')),
      tokenomics: () => supervised(row('tokenomics', 'Tokenomics', 'utility-process')),
      watchdog: () => watchdog(),
      mcp: () => ({ running: true, port: 19333 }),
    }))
    expect(all.snapshot().services.map((s) => s.id)).toEqual(ROW_ORDER)
    expect(all.snapshot().services.map((s) => s.state)).toEqual(['listening', 'listening', 'listening', 'listening', 'listening'])
  })

  it('a service that is not there to ask still has its row, and it reads stopped', () => {
    const s = createServiceRegistry(sources()).snapshot()
    expect(s.services.map((x) => [x.id, x.label, x.state])).toEqual([
      ['hooks', 'Hooks gateway', 'stopped'],
      ['logging', 'Session logging', 'stopped'],
      ['tokenomics', 'Tokenomics', 'stopped'],
      ['watchdog', 'Watchdog', 'stopped'],
      ['mcp', 'MCP server', 'stopped'],
    ])
  })

  it('the Tokenomics row reads stopped while its supervisor does not exist, and is its own row once it does', () => {
    let sup: SupervisedService | null = null
    const reg = createServiceRegistry(sources({ tokenomics: () => sup }))
    const before = reg.snapshot().services.find((x) => x.id === 'tokenomics')
    expect(before?.state).toBe('stopped')
    expect(before?.host).toBe('utility-process')
    // Asked on every read: a supervisor created later is seen as it is.
    sup = supervised({ ...row('tokenomics', 'Tokenomics', 'utility-process'), eventsTotal: 4200 })
    const after = reg.snapshot().services.find((x) => x.id === 'tokenomics')
    expect(after?.state).toBe('listening')
    expect(after?.eventsTotal).toBe(4200)
  })

  it('a supervisor whose snapshot does not hold its own row reads stopped, and no stray row is added', () => {
    const reg = createServiceRegistry(sources({ hooks: () => supervised(row('something-else', 'Other', 'in-process')) }))
    const s = reg.snapshot()
    expect(s.services.map((x) => x.id)).toEqual(ROW_ORDER)
    expect(s.services[0].state).toBe('stopped')
  })

  it('carries a measured block through untouched, and adds none of its own', () => {
    const measured = { cpuPercent: 1.5, filesTouchedLastScan: 340, sampledAt: 99 }
    const reg = createServiceRegistry(sources({
      tokenomics: () => supervised({ ...row('tokenomics', 'Tokenomics', 'utility-process'), measured }),
      logging: () => supervised(row('logging', 'Session logging', 'utility-process')),
    }))
    const s = reg.snapshot()
    expect(s.services.find((x) => x.id === 'tokenomics')?.measured).toEqual(measured)
    expect(s.services.filter((x) => x.id !== 'tokenomics').every((x) => x.measured === undefined)).toBe(true)
  })

  it('stamps the snapshot with the registry clock', () => {
    expect(createServiceRegistry(sources({ now: () => 4321 })).snapshot().capturedAt).toBe(4321)
  })
})

describe('service registry: host kinds', () => {
  it('a row that is not running shows the host its service runs on when it is on', () => {
    const s = createServiceRegistry(sources()).snapshot()
    expect(s.services.map((x) => [x.id, x.host])).toEqual([
      ['hooks', 'utility-process'],
      ['logging', 'utility-process'],
      ['tokenomics', 'utility-process'],
      ['watchdog', 'in-process'],
      ['mcp', 'in-process'],
    ])
  })

  it('no row is called a fallback unless its own service says it fell back', () => {
    const off = createServiceRegistry(sources()).snapshot()
    expect(off.services.some((x) => x.host === 'in-process-fallback')).toBe(false)
    // The hooks gateway can still fall back to the main process; when its
    // supervisor says so, the row says so.
    const fellBack = createServiceRegistry(sources({
      hooks: () => supervised(row('hooks', 'Hooks gateway', 'in-process-fallback', 'degraded')),
      watchdog: () => watchdog(),
      mcp: () => ({ running: true, port: 19333 }),
    })).snapshot()
    expect(fellBack.services.filter((x) => x.host === 'in-process-fallback').map((x) => x.id)).toEqual(['hooks'])
  })

  it('no row uses the helper host yet', () => {
    const s = createServiceRegistry(sources({ watchdog: () => watchdog(), mcp: () => ({ running: true, port: 1 }) })).snapshot()
    expect(s.services.some((x) => x.host === 'helper')).toBe(false)
  })

  it('the Watchdog row is its manager\'s own, and its monitor snapshot is read once and rides along', () => {
    const wd = watchdog()
    const s = createServiceRegistry(sources({ watchdog: () => wd })).snapshot()
    const r = s.services.find((x) => x.id === 'watchdog')
    expect(r?.host).toBe('in-process')
    expect(r?.state).toBe('listening')
    expect(s.watchdog).toBe(MON)
    // One monitor snapshot per read, handed to the row so it is not taken twice.
    expect(wd.getMonitorSnapshot).toHaveBeenCalledTimes(1)
    expect(wd.getDiagnosticsSnapshot).toHaveBeenCalledWith(MON)
  })

  it('omits the watchdog block when the manager is absent', () => {
    expect(createServiceRegistry(sources()).snapshot().watchdog).toBeUndefined()
  })
})

describe('service registry: the MCP server row comes from the server\'s own state', () => {
  it('listening on its real port once the server is bound', () => {
    const r = mcpServerRow({ running: true, port: 19433 })
    expect([r.id, r.label, r.host, r.state, r.port]).toEqual(['mcp', 'MCP server', 'in-process', 'listening', 19433])
  })

  it('starting while the server exists but has no port yet', () => {
    const r = mcpServerRow({ running: true, port: 0 })
    expect([r.state, r.port]).toEqual(['starting', null])
  })

  it('stopped when it is not running and nothing went wrong', () => {
    const r = mcpServerRow({ running: false, port: 0 })
    expect([r.state, r.port, r.lastError]).toEqual(['stopped', null, null])
  })

  it('crashed, with the reason, when its start failed', () => {
    const r = mcpServerRow({ running: false, port: 0, startError: { message: 'listen EADDRINUSE', ts: 77 } })
    expect(r.state).toBe('crashed')
    expect(r.lastError).toEqual({ message: 'listen EADDRINUSE', ts: 77 })
  })

  it('an old start failure is not shown once the server is running', () => {
    const r = mcpServerRow({ running: true, port: 19333, startError: { message: 'listen EADDRINUSE', ts: 77 } })
    expect([r.state, r.lastError]).toEqual(['listening', null])
  })

  it('is read on every snapshot, so the row follows the server', () => {
    let state = { running: false, port: 0 }
    const reg = createServiceRegistry(sources({ mcp: () => state }))
    expect(reg.snapshot().services.at(-1)?.state).toBe('stopped')
    state = { running: true, port: 19333 }
    const r = reg.snapshot().services.at(-1)
    expect([r?.id, r?.state, r?.port]).toEqual(['mcp', 'listening', 19333])
  })
})

// One source that throws must not take the snapshot down with it: the pill,
// the panel and the sleep indicator all read the one snapshot.
describe('service registry: a source that cannot be read', () => {
  const boom = (): never => { throw new Error('boom') }
  const running = (over: Partial<ServiceRegistrySources>) => createServiceRegistry(sources({
    hooks: () => supervised(row('hooks', 'Hooks gateway', 'utility-process')),
    logging: () => supervised(row('logging', 'Session logging', 'utility-process')),
    tokenomics: () => supervised(row('tokenomics', 'Tokenomics', 'utility-process')),
    watchdog: () => watchdog(),
    mcp: () => ({ running: true, port: 19333 }),
    now: () => 4321,
    ...over,
  }))

  const cases: Array<[id: string, label: string, host: ServiceHost, over: Partial<ServiceRegistrySources>]> = [
    ['hooks', 'Hooks gateway', 'utility-process', { hooks: boom }],
    ['logging', 'Session logging', 'utility-process', { logging: () => ({ getDiagnosticsSnapshot: boom, manualRestart: () => ({ ok: true }) }) }],
    ['tokenomics', 'Tokenomics', 'utility-process', { tokenomics: boom }],
    ['watchdog', 'Watchdog', 'in-process', { watchdog: () => ({ ...watchdog(), getMonitorSnapshot: boom }) }],
    ['mcp', 'MCP server', 'in-process', { mcp: boom }],
  ]
  for (const [id, label, host, over] of cases) {
    it(`${id}: its row reads an error state with the reason, and the other four rows still arrive`, () => {
      const s = running(over).snapshot()
      expect(s.services.map((x) => x.id)).toEqual(ROW_ORDER)
      const failed = s.services.find((x) => x.id === id)
      expect([failed?.label, failed?.host, failed?.state]).toEqual([label, host, 'crashed'])
      expect(failed?.lastError).toEqual({ message: 'row could not be read: boom', ts: 4321 })
      const others = s.services.filter((x) => x.id !== id)
      expect(others).toHaveLength(4)
      expect(others.map((x) => [x.state, x.lastError])).toEqual(others.map(() => ['listening', null]))
      // The Watchdog block rides on the Watchdog row: it is left out only with that row.
      expect(s.watchdog).toBe(id === 'watchdog' ? undefined : MON)
    })
  }

  it('a thrown value that is not an Error is shown as it is', () => {
    const s = running({ hooks: () => { throw 'no gateway' } }).snapshot()
    expect(s.services[0].lastError?.message).toBe('row could not be read: no gateway')
  })

  it('a row is read again on the next snapshot, so one bad read is not kept', () => {
    let bad = true
    const hooks = supervised(row('hooks', 'Hooks gateway', 'utility-process'))
    const reg = running({ hooks: () => { if (bad) throw new Error('boom'); return hooks } })
    expect(reg.snapshot().services[0].state).toBe('crashed')
    bad = false
    const r = reg.snapshot().services[0]
    expect([r.state, r.lastError]).toEqual(['listening', null])
  })

  it('a PTY source that throws leaves the PTY block out and says so in the log; every row still arrives', () => {
    const s = running({ pty: boom }).snapshot()
    expect(s.services.map((x) => [x.id, x.state])).toEqual(ROW_ORDER.map((id) => [id, 'listening']))
    expect('pty' in s).toBe(false)
    expect(s.log).toEqual([{ ts: 4321, serviceId: 'pty', level: 'error', code: 'pty-read-failed', message: 'PTY integrity could not be read: boom' }])
  })
})

describe('service registry: restart goes to whatever owns the row', () => {
  function wired() {
    const hooks = supervised(row('hooks', 'Hooks gateway', 'utility-process'))
    const logging = supervised(row('logging', 'Session logging', 'utility-process'))
    const tokenomics = supervised(row('tokenomics', 'Tokenomics', 'utility-process'))
    const wd = watchdog()
    const reg = createServiceRegistry(sources({
      hooks: () => hooks, logging: () => logging, tokenomics: () => tokenomics, watchdog: () => wd,
      mcp: () => ({ running: true, port: 19333 }),
    }))
    const owners = { hooks, logging, tokenomics, watchdog: wd }
    return { reg, owners }
  }

  for (const id of ['hooks', 'logging', 'tokenomics', 'watchdog'] as const) {
    it(`${id}: its own owner is asked, with its own id, and nobody else`, () => {
      const { reg, owners } = wired()
      expect(reg.restart(id)).toEqual({ ok: true, reason: `${id} restarted as ${id}` })
      for (const [name, owner] of Object.entries(owners)) {
        if (name === id) {
          expect(owner.manualRestart).toHaveBeenCalledTimes(1)
          expect(owner.manualRestart).toHaveBeenCalledWith(id)
        } else {
          expect(owner.manualRestart).not.toHaveBeenCalled()
        }
      }
    })

    it(`${id}: answers no-supervisor when its owner does not exist`, () => {
      const others = wired().owners
      const reg = createServiceRegistry(sources({
        hooks: () => (id === 'hooks' ? null : others.hooks),
        logging: () => (id === 'logging' ? null : others.logging),
        tokenomics: () => (id === 'tokenomics' ? null : others.tokenomics),
        watchdog: () => (id === 'watchdog' ? null : others.watchdog),
      }))
      expect(reg.restart(id)).toEqual({ ok: false, reason: 'no-supervisor' })
      // An absent owner's restart is never handed to another service.
      for (const owner of Object.values(others)) expect(owner.manualRestart).not.toHaveBeenCalled()
    })
  }

  it('returns the owner\'s own refusal as it is', () => {
    const hooks = { ...supervised(row('hooks', 'Hooks gateway', 'in-process-fallback', 'degraded')), manualRestart: vi.fn(() => ({ ok: false, reason: 'fallback' })) }
    const reg = createServiceRegistry(sources({ hooks: () => hooks }))
    expect(reg.restart('hooks')).toEqual({ ok: false, reason: 'fallback' })
  })

  it('the MCP server has no restart of its own', () => {
    const { reg, owners } = wired()
    expect(reg.restart('mcp')).toEqual({ ok: false, reason: 'not-restartable' })
    for (const owner of Object.values(owners)) expect(owner.manualRestart).not.toHaveBeenCalled()
  })

  it('an id that is not a registered row reaches no owner', () => {
    const { reg, owners } = wired()
    for (const bad of ['pty', '', 'Hooks', 'hooks ', '__proto__', 'constructor', undefined, null, 7, {}, ['hooks']]) {
      expect(reg.restart(bad as never)).toEqual({ ok: false, reason: 'unknown-service' })
    }
    for (const owner of Object.values(owners)) expect(owner.manualRestart).not.toHaveBeenCalled()
  })
})
