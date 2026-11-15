// The merged diagnostics snapshot: every source's log lines in one tail, the
// PTY block beside the service rows, and the main-loop stall stamp. The merge
// is the service registry's (src/main/services/service-registry.ts); its rows
// and its restart routing are covered in service-registry.test.ts.
import { describe, it, expect } from 'vitest'
import { createServiceRegistry } from '../../../src/main/services/service-registry'
import type { ServiceRegistrySources, SupervisedService } from '../../../src/main/services/service-registry'
import type { DiagnosticsSnapshot, PtyIntegritySnapshot, ServiceLogEntry } from '../../../src/shared/service-health'

const supSnap: DiagnosticsSnapshot = {
  capturedAt: 10,
  services: [{ id: 'hooks', label: 'Hooks gateway', host: 'utility-process', state: 'listening',
    port: 1, pid: 2, startedAt: 0, inFlight: 0, eventsTotal: 0, dropsTotal: 0, throughputPerSec: 0,
    restartCount: 0, lastError: null, mainLoopStallsLastMin: 0, childLoopStallsLastMin: 0, lastHeartbeatAt: 0 }],
  log: [{ ts: 5, serviceId: 'hooks', level: 'info', code: 'bound', message: 'bound' }],
}
const ptySnap: PtyIntegritySnapshot = { sessions: [], totals: { activeSessions: 0, bytesFromPty: 0, resizes: 0, desyncs: 0 }, recentEvents: [] }
const ptyLogs: ServiceLogEntry[] = [{ ts: 7, serviceId: 'pty', level: 'warn', code: 'pty-width-desync', message: 'x' }]

const supervisor = (snap: DiagnosticsSnapshot): SupervisedService => ({ getDiagnosticsSnapshot: () => snap, manualRestart: () => ({ ok: true }) })

/** The merged snapshot with the hooks supervisor given (null: hooks are off),
 *  nothing else running, and whatever else the test passes. */
function merged(hooks: SupervisedService | null, over: Partial<ServiceRegistrySources> = {}): DiagnosticsSnapshot {
  return createServiceRegistry({
    hooks: () => hooks,
    logging: () => null,
    tokenomics: () => null,
    watchdog: () => null,
    mcp: () => ({ running: false, port: 0 }),
    ...over,
  }).snapshot()
}

describe('merged diagnostics', () => {
  it('attaches the pty block and merges logs sorted by ts', () => {
    const out = merged(supervisor(supSnap), { pty: () => ({ snapshot: ptySnap, logs: ptyLogs }) })
    expect(out.pty).toBe(ptySnap)
    expect(out.log.map(l => l.serviceId)).toEqual(['hooks', 'pty']) // ts 5 then 7
    expect(out.services[0].id).toBe('hooks')
  })

  it('merges every source\'s lines by time, not source by source', () => {
    const line = (serviceId: string, ts: number): ServiceLogEntry => ({ ts, serviceId, level: 'info', code: 'x', message: `${serviceId}@${ts}` })
    const logging: DiagnosticsSnapshot = {
      capturedAt: 1,
      services: [{ ...supSnap.services[0], id: 'logging', label: 'Session logging' }],
      log: [line('logging', 10)],
    }
    const out = merged(supervisor({ ...supSnap, log: [line('hooks', 5), line('hooks', 30)] }), {
      logging: () => supervisor(logging),
      pty: () => ({ snapshot: ptySnap, logs: [line('pty', 7)] }),
    })
    expect(out.log.map((l) => l.message)).toEqual(['hooks@5', 'pty@7', 'logging@10', 'hooks@30'])
  })

  it('the PTY block and the logging row arrive in the same snapshot', () => {
    const logging: DiagnosticsSnapshot = {
      capturedAt: 1,
      services: [{ ...supSnap.services[0], id: 'logging', label: 'Session logging', port: null }],
      log: [],
    }
    const out = merged(supervisor(supSnap), {
      logging: () => supervisor(logging),
      pty: () => ({ snapshot: ptySnap, logs: [] }),
    })
    // Both supervised rows are their own, and the block sits beside them.
    expect(out.services.filter((s) => s.state === 'listening').map((s) => s.id)).toEqual(['hooks', 'logging'])
    expect(out.pty).toBe(ptySnap)
  })

  it('serves a stopped hooks row when hooks are off but still attaches pty', () => {
    const out = merged(null, { pty: () => ({ snapshot: ptySnap, logs: [] }) })
    expect(out.services[0].id).toBe('hooks')
    expect(out.services[0].state).toBe('stopped')
    expect(out.pty).toBe(ptySnap)
  })

  it('has no pty block when there is no pty provider data', () => {
    const out = merged(supervisor(supSnap), { pty: () => null })
    expect(out.pty).toBeUndefined()
    expect('pty' in out).toBe(false)
    expect(out.log).toHaveLength(1)
    // No pty source at all reads the same.
    expect(merged(supervisor(supSnap)).pty).toBeUndefined()
  })

  it('stamps the main-loop stall count onto every service (both delivery paths funnel here)', () => {
    // The loop-stall monitor singleton is never started in unit tests, so it
    // reports 0. What matters is that the stamp is the registry's: a row that
    // arrives carrying another figure leaves with the main loop's own, and so
    // does every row the registry writes itself. That is the "Jank m/c" main half.
    const stale: DiagnosticsSnapshot = { ...supSnap, services: [{ ...supSnap.services[0], mainLoopStallsLastMin: 7 }] }
    const out = merged(supervisor(stale), { pty: () => ({ snapshot: ptySnap, logs: [] }) })
    expect(out.services.length).toBeGreaterThan(1)
    for (const s of out.services) {
      expect(s.mainLoopStallsLastMin).toBe(0)
    }
    expect(out.pty).toBe(ptySnap)
  })

  it('caps the merged log at 200, keeping the newest by ts', () => {
    // 150 hooks logs (ts 0..149) + 150 pty logs (ts 1000..1149) = 300 -> capped to 200.
    const hooksLog: ServiceLogEntry[] = Array.from({ length: 150 }, (_, i) => ({ ts: i, serviceId: 'hooks', level: 'info', code: 'h', message: `h${i}` }))
    const ptyLog: ServiceLogEntry[] = Array.from({ length: 150 }, (_, i) => ({ ts: 1000 + i, serviceId: 'pty', level: 'info', code: 'p', message: `p${i}` }))
    const bigSup: DiagnosticsSnapshot = { ...supSnap, log: hooksLog }
    const out = merged(supervisor(bigSup), { pty: () => ({ snapshot: ptySnap, logs: ptyLog }) })
    expect(out.log).toHaveLength(200)
    // Newest 200 kept (oldest 100 hooks entries dropped): first survivor is hooks ts=100, last is pty ts=1149.
    expect(out.log[0].ts).toBe(100)
    expect(out.log[out.log.length - 1].ts).toBe(1149)
  })

  it('leaves a supervisor\'s own log array as it was', () => {
    const own: ServiceLogEntry[] = [
      { ts: 9, serviceId: 'hooks', level: 'info', code: 'h', message: 'late' },
      { ts: 3, serviceId: 'hooks', level: 'info', code: 'h', message: 'early' },
    ]
    const out = merged(supervisor({ ...supSnap, log: own }))
    expect(out.log.map((l) => l.ts)).toEqual([3, 9])
    expect(own.map((l) => l.ts)).toEqual([9, 3])
  })
})
