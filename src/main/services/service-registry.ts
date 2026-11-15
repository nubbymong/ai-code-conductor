/**
 * service-registry.ts: the one list of service rows.
 *
 * Every service the Services panel shows is one entry in `rows` below. An
 * entry says how its row is read and where a restart of it goes. It replaces
 * the hand merge of four sources the diagnostics handlers used to do, and the
 * restart special cases that sat beside it.
 *
 * The registry starts and forks nothing. The supervised services keep their
 * own supervisors (hooks gateway, session logging, usage index) over the one
 * Supervisor base (./supervisor.ts); the registry only asks each for its row
 * and hands it a restart. Each source is a getter asked on every read, so a
 * service that is created later, or never, is seen as it is at that moment.
 *
 * A registered service always has its row. One that is not there to ask (off
 * in Settings, not started) reads stopped, with the host it runs on when it is
 * on. One whose source throws reads crashed, with the reason, and the other
 * rows still arrive: the pill, the panel and the sleep indicator all read the
 * one snapshot, so a single bad read must not take it away from all three.
 *
 * No default export (project convention).
 */
import { createInitialHealth, SERVICE_ID, SERVICE_LABEL } from '../../shared/service-health'
import type {
  DiagnosticsSnapshot,
  PtyIntegritySnapshot,
  ServiceHealth,
  ServiceHost,
  ServiceId,
  ServiceLogEntry,
  WatchdogMonitorSnapshot,
} from '../../shared/service-health'
import { stallsLastMin as mainLoopStallsLastMin } from './loop-stall-monitor'

export type ServiceRestartResult = { ok: boolean; reason?: string }

/** What the registry asks of a supervised service: its row with its own log
 *  tail, and a restart. The hooks, logging and usage-index supervisors all
 *  answer this as they are. */
export interface SupervisedService {
  getDiagnosticsSnapshot: () => DiagnosticsSnapshot
  manualRestart: (serviceId: string) => ServiceRestartResult
}

/** The Watchdog has no supervisor and no child: it runs per session inside
 *  the main process. Its monitor snapshot also feeds the panel's own section. */
export interface WatchdogService {
  getMonitorSnapshot: () => WatchdogMonitorSnapshot
  getDiagnosticsSnapshot: (mon?: WatchdogMonitorSnapshot) => DiagnosticsSnapshot
  manualRestart: (serviceId: string) => ServiceRestartResult
}

/** The MCP server's own state, as its module reports it. */
export interface McpServerState {
  /** The HTTP server exists (it may not be listening yet). */
  running: boolean
  /** The port it listens on; 0 until it is listening. */
  port: number
  /** Why the start at launch failed, when it did. Shown only while the server
   *  is not running. */
  startError?: { message: string; ts: number } | null
}

export interface ServiceRegistrySources {
  hooks: () => SupervisedService | null
  logging: () => SupervisedService | null
  tokenomics: () => SupervisedService | null
  watchdog: () => WatchdogService | null
  mcp: () => McpServerState
  /** PTY integrity is not a service row: it is a block of its own in the
   *  snapshot, plus lines in the shared log. */
  pty?: () => { snapshot: PtyIntegritySnapshot; logs: ServiceLogEntry[] } | null
  /** Injectable clock for tests. */
  now?: () => number
}

export interface ServiceRegistry {
  /** Every row, in the order the panel shows them, with the merged log tail
   *  and the PTY and Watchdog blocks. */
  snapshot: () => DiagnosticsSnapshot
  /** Restart one service by its row id, through whatever owns it. */
  restart: (serviceId: string) => ServiceRestartResult
}

// Mirrors the supervisors' own LOG_CAP, so the merged tail is the size the
// panel already expects.
const LOG_CAP = 200

interface RowReading {
  row: ServiceHealth
  log: ServiceLogEntry[]
  watchdog?: WatchdogMonitorSnapshot
}

interface ServiceRow {
  id: string
  label: string
  /** Where the service runs when it is on. Used for its stopped row; a
   *  running service states its own host. */
  host: ServiceHost
  /** The row as it is now, or null when the service is not there to ask. */
  read: () => RowReading | null
  /** Absent when the row cannot be restarted on its own. */
  restart?: () => ServiceRestartResult
}

/** A supervisor's snapshot holds its one row and its log tail. */
function fromSnapshot(id: string, snap: DiagnosticsSnapshot): RowReading | null {
  const row = snap.services.find((s) => s.id === id)
  return row ? { row, log: snap.log } : null
}

function restartVia(id: string, get: () => { manualRestart: (serviceId: string) => ServiceRestartResult } | null): ServiceRestartResult {
  const owner = get()
  return owner ? owner.manualRestart(id) : { ok: false, reason: 'no-supervisor' }
}

/** Why a source could not be read, as one line. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The MCP server row, from the server's own state. It runs inside the main
 *  process and is started once at launch. */
export function mcpServerRow(m: McpServerState): ServiceHealth {
  const row = createInitialHealth(SERVICE_ID.mcp, SERVICE_LABEL.mcp, 'in-process')
  if (m.running) {
    // The server object exists from the moment it is created; its port is
    // set once it is listening.
    row.state = m.port > 0 ? 'listening' : 'starting'
    row.port = m.port > 0 ? m.port : null
  } else if (m.startError) {
    row.state = 'crashed'
    row.lastError = { message: m.startError.message, ts: m.startError.ts }
  } else {
    row.state = 'stopped'
  }
  return row
}

export function createServiceRegistry(sources: ServiceRegistrySources): ServiceRegistry {
  const now = sources.now ?? (() => Date.now())

  const supervised = (id: ServiceId, get: () => SupervisedService | null): ServiceRow => ({
    id,
    label: SERVICE_LABEL[id],
    host: 'utility-process',
    read: () => {
      const sup = get()
      return sup ? fromSnapshot(id, sup.getDiagnosticsSnapshot()) : null
    },
    restart: () => restartVia(id, get),
  })

  // The list. Its order is the order of the cards in the panel.
  const rows: ServiceRow[] = [
    // The hooks gateway is forked as its own utility process
    // (fork-hooks-child.ts). With hooks off in Settings no supervisor exists.
    supervised(SERVICE_ID.hooks, sources.hooks),
    // No supervisor when session logging is off in Settings.
    supervised(SERVICE_ID.logging, sources.logging),
    // The usage index. No supervisor when it was not started.
    supervised(SERVICE_ID.tokenomics, sources.tokenomics),
    {
      id: SERVICE_ID.watchdog,
      label: SERVICE_LABEL.watchdog,
      host: 'in-process',
      read: () => {
        const wd = sources.watchdog()
        if (!wd) return null
        // One monitor snapshot per read: the row is derived from it, and the
        // pane read it carries for a silent session should run once, not twice.
        const mon = wd.getMonitorSnapshot()
        const got = fromSnapshot(SERVICE_ID.watchdog, wd.getDiagnosticsSnapshot(mon))
        return got ? { ...got, watchdog: mon } : null
      },
      restart: () => restartVia(SERVICE_ID.watchdog, sources.watchdog),
    },
    {
      id: SERVICE_ID.mcp,
      label: SERVICE_LABEL.mcp,
      host: 'in-process',
      read: () => ({ row: mcpServerRow(sources.mcp()), log: [] }),
      // No restart: the server lives inside the main process and the open
      // sessions hold connections to it. Relaunching the app restarts it.
    },
  ]

  const stoppedRow = (r: ServiceRow): ServiceHealth => ({ ...createInitialHealth(r.id, r.label, r.host), state: 'stopped' })
  // A row whose source threw: it says so itself, and the snapshot carries on.
  const unreadableRow = (r: ServiceRow, err: unknown, ts: number): ServiceHealth => ({
    ...createInitialHealth(r.id, r.label, r.host),
    state: 'crashed',
    lastError: { message: `row could not be read: ${reasonOf(err)}`, ts },
  })

  return {
    snapshot: () => {
      const capturedAt = now()
      const services: ServiceHealth[] = []
      const log: ServiceLogEntry[] = []
      let watchdog: WatchdogMonitorSnapshot | undefined
      for (const r of rows) {
        let got: RowReading | null
        try {
          got = r.read()
        } catch (err) {
          services.push(unreadableRow(r, err, capturedAt))
          continue
        }
        services.push(got ? got.row : stoppedRow(r))
        if (!got) continue
        log.push(...got.log)
        if (got.watchdog) watchdog = got.watchdog
      }
      // The PTY block is read the same way: when it cannot be, it is left out
      // and the log says why, and the rows above still arrive.
      let pty: { snapshot: PtyIntegritySnapshot; logs: ServiceLogEntry[] } | null = null
      try {
        pty = sources.pty?.() ?? null
      } catch (err) {
        log.push({ ts: capturedAt, serviceId: 'pty', level: 'error', code: 'pty-read-failed', message: `PTY integrity could not be read: ${reasonOf(err)}` })
      }
      if (pty) log.push(...pty.logs)
      // One tail for every source: oldest first, the newest LOG_CAP kept.
      log.sort((a, b) => a.ts - b.ts)
      if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP)
      // The main process's own event-loop stalls go on EVERY row: both ways
      // the snapshot leaves (the push and the GET handler) come through here.
      // A child's own stalls arrive on its row over its heartbeat.
      const mainStalls = mainLoopStallsLastMin()
      return {
        capturedAt,
        services: services.map((s) => ({ ...s, mainLoopStallsLastMin: mainStalls })),
        log,
        ...(pty ? { pty: pty.snapshot } : {}),
        ...(watchdog ? { watchdog } : {}),
      }
    },

    restart: (serviceId) => {
      const r = rows.find((x) => x.id === serviceId)
      if (!r) return { ok: false, reason: 'unknown-service' }
      if (!r.restart) return { ok: false, reason: 'not-restartable' }
      return r.restart()
    },
  }
}
