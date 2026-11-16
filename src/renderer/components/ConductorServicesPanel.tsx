import React, { useEffect, useRef, useState } from 'react'
import { SERVICE_ID } from '../../shared/service-health'
import type {
  DiagnosticsSnapshot,
  ServiceHealth,
  ServiceId,
  ServiceMeasured,
  ServiceLogEntry,
  PtyIntegritySnapshot,
  WatchdogMonitorSnapshot,
} from '../../shared/service-health'
import { DialogButton } from './ui/Dialog'

// No \u{...} escapes in JSX (esbuild). U+21BB CLOCKWISE OPEN CIRCLE ARROW,
// U+29C9 TWO JOINED SQUARES.
const RESTART_GLYPH = String.fromCodePoint(0x21bb)
const COPY_GLYPH = String.fromCodePoint(0x29c9)

// #360: the panel is anchored chrome, not a modal, so it keeps its own
// positioning and its `role="dialog"` host element — only the colours move onto
// the semantic tokens. State dots and log levels are now token COLOURS applied
// through `style`, not palette utility classes.
const STATE_DOT: Record<string, string> = {
  listening: 'var(--status-success)',
  starting: 'var(--status-warning)',
  restarting: 'var(--status-warning)',
  degraded: 'var(--status-warning)',
  crashed: 'var(--status-danger)',
  stopped: 'var(--text-muted)',
}
const LOG_TXT: Record<string, string> = {
  info: 'var(--text-secondary)',
  warn: 'var(--status-warning)',
  error: 'var(--status-danger)',
}

/** A sunken well inside the raised panel (a service card, the log tail...). */
const CARD_CLASS = 'rounded border p-2.5'
const CARD_STYLE: React.CSSProperties = {
  borderColor: 'var(--border-subtle)',
  background: 'var(--surface-sunken)',
}

function uptime(startedAt: number | null): string {
  if (!startedAt) return '-'
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-px">
      <span className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-primary)' }}>
        {value}
      </span>
    </div>
  )
}

// dropsTotal counts RING-BUFFER EVICTIONS: a busy session's activity-feed
// history holds the last 200 events, and each new event past that trims the
// oldest scroll-back entry. No live event is lost (all are counted, fanned
// out, and pushed to the UI) — so the panel says "Trimmed", not "Drops",
// which read as lost ingest and alarmed users.

// Per-card restart gating. Preserves the original hooks rule (a supervised
// gateway that fell back to in-process cannot be restarted in place — relaunch),
// while letting other services (watchdog, logging) restart when running. A
// stopped service is never restartable. The MCP server has no restart of its
// own (the service registry answers 'not-restartable' for it): it lives inside
// the app and the open sessions hold connections to it.
function restartInfoFor(s: ServiceHealth): { disabled: boolean; title: string } {
  if (s.state === 'stopped') {
    return { disabled: true, title: s.id === SERVICE_ID.hooks ? 'Hooks are disabled in Settings' : `${s.label} is stopped` }
  }
  if (s.id === SERVICE_ID.hooks && s.host === 'in-process-fallback') {
    return { disabled: true, title: 'Relaunch the app to retry the supervised gateway' }
  }
  if (s.id === SERVICE_ID.mcp) {
    return { disabled: true, title: 'The MCP server runs inside the app. Relaunch the app to restart it' }
  }
  if (s.id === SERVICE_ID.watchdog) return { disabled: false, title: 'Restart the watchdog (re-arms watchers on the next session)' }
  if (s.id === SERVICE_ID.helper) {
    return { disabled: true, title: 'Each held terminal runs in a holder of its own, so the session helper has no restart' }
  }
  return { disabled: false, title: `Restart ${s.label}` }
}

// The counters a card can show. A row carries a slot for every one of them,
// but not every service keeps every one: a card shows only what its row keeps,
// so a figure nobody counts is never shown as a real zero. The main loop's own
// stalls are stamped on every row, so they are not in this list: they show
// whenever a card has counters at all.
type Counter = 'pid' | 'uptime' | 'inFlight' | 'restarts' | 'events' | 'trimmed' | 'throughput' | 'childStalls' | 'held'
const EVERY_COUNTER: readonly Counter[] = ['pid', 'uptime', 'inFlight', 'restarts', 'events', 'trimmed', 'throughput', 'childStalls']
// One entry per registered row (the type makes a new row state its own).
const COUNTERS_KEPT: Record<ServiceId, readonly Counter[]> = {
  // The gateway's child reports all of them, its own event-loop stalls included.
  hooks: EVERY_COUNTER,
  // The logging worker reports no event-loop stalls of its own.
  logging: ['pid', 'uptime', 'inFlight', 'restarts', 'events', 'trimmed', 'throughput'],
  // The usage index: its worker's process id (2.1.3-beta.4: the supervisor
  // now knows it, while there is a worker), how long the current worker has
  // been ready, the queries not answered yet, its restarts and its event
  // count. Nothing counts a trim, a rate or the worker's stalls.
  tokenomics: ['pid', 'uptime', 'inFlight', 'restarts', 'events'],
  // The Watchdog runs inside the app: no process of its own, and a restart of
  // it is not counted. In-flight is the sessions waiting out a retry.
  watchdog: ['uptime', 'inFlight', 'events'],
  // The MCP server row says only whether it is listening and on which port.
  mcp: [],
  // The session helper (2.1.3-beta.6): how many terminals it holds now.
  helper: ['held'],
}
function countersKept(s: ServiceHealth): readonly Counter[] {
  // A row this panel does not know is shown in full, as a supervised child is.
  const kept = Object.prototype.hasOwnProperty.call(COUNTERS_KEPT, s.id) ? COUNTERS_KEPT[s.id as ServiceId] : EVERY_COUNTER
  // A row that runs inside the app has no child of its own, whatever its id: no
  // process id, and no child stalls. The hooks gateway is the one row that can
  // move there (it falls back to the main process).
  if (s.host === 'in-process' || s.host === 'in-process-fallback') return kept.filter((c) => c !== 'pid' && c !== 'childStalls')
  return kept
}

// The measured cost of a service, when something measured it: only the figures
// the row was given, then how long ago they were taken. Nothing is shown for a
// row with no figures.
function measuredCells(m: ServiceMeasured | undefined): Array<{ label: string; value: string }> {
  if (!m) return []
  const cells: Array<{ label: string; value: string }> = []
  if (typeof m.cpuPercent === 'number' && Number.isFinite(m.cpuPercent)) {
    cells.push({ label: 'CPU', value: `${m.cpuPercent.toFixed(1)}%` })
  }
  if (typeof m.filesTouchedLastScan === 'number' && Number.isFinite(m.filesTouchedLastScan)) {
    cells.push({ label: 'Files/scan', value: String(m.filesTouchedLastScan) })
  }
  if (cells.length === 0) return []
  if (typeof m.sampledAt === 'number' && Number.isFinite(m.sampledAt) && m.sampledAt > 0) {
    cells.push({ label: 'Measured', value: `${uptime(m.sampledAt)} ago` })
  }
  return cells
}

function ServiceCard({ s, onRestart }: { s: ServiceHealth; onRestart: (id: string) => void }) {
  const r = restartInfoFor(s)
  // Only the counters this row keeps (none at all for the MCP server).
  const kept = countersKept(s)
  const keeps = (c: Counter) => kept.includes(c)
  const showCounters = kept.length > 0
  const measured = measuredCells(s.measured)
  return (
    <div className={CARD_CLASS} style={CARD_STYLE} data-service-id={s.id}>
      <div className={`flex items-center gap-1.5${showCounters || measured.length > 0 ? ' mb-2' : ''}`}>
        <span
          className="w-2 h-2 rounded-full"
          style={{ background: STATE_DOT[s.state] ?? 'var(--text-muted)' }}
        />
        <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {s.label}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
          {/* Hooks stop only when switched off in Settings; any other row
              that is not running says just that. */}
          {s.state === 'stopped'
            ? (s.id === SERVICE_ID.hooks ? 'disabled' : 'stopped')
            : `${s.host}${s.port ? ` :${s.port}` : ''}${s.state !== 'listening' ? ` (${s.state})` : ''}`}
        </span>
        <button
          onClick={() => onRestart(s.id)}
          disabled={r.disabled}
          title={r.title}
          className="ml-auto px-1.5 py-0.5 rounded border text-[10px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
          style={{
            color: 'var(--status-danger)',
            borderColor: 'color-mix(in srgb, var(--status-danger) 40%, transparent)',
            background: 'color-mix(in srgb, var(--status-danger) 10%, transparent)',
          }}
        >
          {RESTART_GLYPH} Restart
        </button>
      </div>
      {showCounters && (
        <div className="grid grid-cols-4 gap-x-2 gap-y-1.5" data-counters>
          {keeps('pid') && <Metric label="PID" value={s.pid ?? '-'} />}
          {keeps('held') && <Metric label="Held" value={s.heldSessions ?? 0} />}
          {keeps('uptime') && <Metric label="Uptime" value={uptime(s.startedAt)} />}
          {keeps('inFlight') && <Metric label="In-flight" value={s.inFlight} />}
          {keeps('restarts') && <Metric label="Restarts" value={s.restartCount} />}
          {keeps('events') && <Metric label="Events" value={s.eventsTotal} />}
          {keeps('trimmed') && <Metric label="Trimmed" value={s.dropsTotal} />}
          {/* throughputPerSec is events/sec computed from successive health beats
              (0 when idle: honest, not '-'). */}
          {keeps('throughput') && <Metric label="Thrput/s" value={s.throughputPerSec.toFixed(1)} />}
          {/* Jank = event-loop stall samples in the last 60s: the main loop's
              (m), and the child's own (c) for a row whose child reports them. */}
          {keeps('childStalls')
            ? <Metric label="Jank m/c" value={`${s.mainLoopStallsLastMin}/${s.childLoopStallsLastMin}`} />
            : <Metric label="Jank m" value={s.mainLoopStallsLastMin} />}
        </div>
      )}
      {measured.length > 0 && (
        <div
          className={`grid grid-cols-4 gap-x-2 gap-y-1.5${showCounters ? ' mt-1.5' : ''}`}
          data-measured
          title="Measured cost of this service"
        >
          {measured.map((m) => (
            <Metric key={m.label} label={m.label} value={m.value} />
          ))}
        </div>
      )}
      {s.lastError && (
        <div className="mt-2 text-[10px] break-words" style={{ color: 'var(--status-danger)' }}>
          last error: {s.lastError.message}
        </div>
      )}
    </div>
  )
}

function LogTail({ log }: { log: ServiceLogEntry[] }) {
  return (
    <div
      // shrink-0: a scrolling box may otherwise be squeezed to nothing before
      // the panel itself starts to scroll.
      className="rounded border max-h-32 shrink-0 overflow-y-auto p-1.5 font-mono text-[10px] leading-snug"
      style={CARD_STYLE}
    >
      {log.length === 0 ? (
        <div style={{ color: 'var(--text-muted)' }}>no log entries</div>
      ) : (
        log.map((e, i) => (
          <div
            key={i}
            className="whitespace-pre-wrap break-words"
            style={{ color: LOG_TXT[e.level] ?? 'var(--text-secondary)' }}
          >
            <span style={{ color: 'var(--text-muted)' }}>{e.code} </span>
            {e.message}
          </div>
        ))
      )}
    </div>
  )
}

function PtySection({ pty }: { pty: PtyIntegritySnapshot }) {
  return (
    <div className={CARD_CLASS} style={CARD_STYLE}>
      <div
        className="flex items-center gap-1.5 mb-2"
        title="Per-session terminal health. Bytes in = bytes read from the shell; Resizes = terminal size changes; Desyncs = times the app and the shell disagreed on the terminal width (a display-corruption signal)."
      >
        <span className="w-2 h-2 rounded-full" style={{ background: 'var(--text-muted)' }} />
        <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          PTY integrity
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
          {pty.totals.activeSessions} active
        </span>
      </div>
      <div className="grid grid-cols-4 gap-x-2 gap-y-1.5 mb-2">
        <Metric label="Sessions" value={pty.totals.activeSessions} />
        <Metric label="Bytes in" value={pty.totals.bytesFromPty} />
        <Metric label="Resizes" value={pty.totals.resizes} />
        <Metric label="Desyncs" value={pty.totals.desyncs} />
      </div>
      {pty.sessions.length > 0 && (
        <div
          className="font-mono text-[10px] leading-snug max-h-24 overflow-y-auto"
          style={{ color: 'var(--text-secondary)' }}
        >
          {pty.sessions.map((s) => (
            <div key={s.sessionId} className="whitespace-pre-wrap break-words">
              <span style={{ color: 'var(--text-muted)' }}>{s.sessionId.slice(0, 8)} </span>
              in:{s.bytesFromPty} gap:{s.byteGap} cols:{s.appliedCols ?? '-'}/{s.rendererCols ?? '-'} dsy:{s.widthDesyncCount}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function WatchdogSection({ watchdog }: { watchdog: WatchdogMonitorSnapshot }) {
  const tickSec = Math.round(watchdog.throttle.tickMs / 1000)
  return (
    <div className={CARD_CLASS} style={CARD_STYLE}>
      <div
        className="flex items-center gap-1.5 mb-2"
        title="Session Watchdog. Waiting = sessions in a retry backoff; Silent = sessions whose provider stopped streaming; Tick = current scan cadence (widens when the main loop is under load); Stalls = main-loop stalls in the last minute."
      >
        <span className="w-2 h-2 rounded-full" style={{ background: 'var(--text-muted)' }} />
        <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>Session Watchdog</span>
        <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>{watchdog.activeSessions} watched</span>
      </div>
      <div className="grid grid-cols-4 gap-x-2 gap-y-1.5 mb-2">
        <Metric label="Watched" value={watchdog.activeSessions} />
        <Metric label="Waiting" value={watchdog.waitingSessions} />
        <Metric label="Silent" value={watchdog.silentSessions} />
        <Metric label="Tick" value={`${tickSec}s`} />
      </div>
      {watchdog.sessions.length > 0 && (
        <div className="font-mono text-[10px] leading-snug max-h-24 overflow-y-auto" style={{ color: 'var(--text-secondary)' }}>
          {watchdog.sessions.map((s) => (
            <div key={s.sessionId} className="whitespace-pre-wrap break-words">
              <span style={{ color: 'var(--text-muted)' }}>{s.sessionId.slice(0, 8)} </span>
              {s.gaveUp ? 'gave-up' : s.status}{s.silent ? ' · silent' : ''} idle:{Math.round(s.idleMs / 1000)}s
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ConductorServicesPanel({ open = true, onClose }: { open?: boolean; onClose: () => void }) {
  const [snap, setSnap] = useState<DiagnosticsSnapshot | null>(null)
  const [entered, setEntered] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const copyTimerRef = useRef<number | null>(null)

  useEffect(() => {
    let active = true
    window.electronAPI.serviceHealth.get().then((s) => { if (active) setSnap(s) })
    const unsub = window.electronAPI.serviceHealth.onUpdate((s) => setSnap(s))
    return () => { active = false; unsub() }
  }, [])

  // Drive BOTH the enter and leave transitions off `open`. TitleBar keeps us
  // mounted for ~200ms after open flips false so the closing animation plays
  // (feedback_animations: all panel changes animated), then unmounts.
  useEffect(() => {
    if (open) { const t = setTimeout(() => setEntered(true), 0); return () => clearTimeout(t) }
    setEntered(false)
  }, [open])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      // The pill button owns its own open/close toggle; ignore clicks on it so
      // the toggle isn't fought by this close-on-outside handler.
      if (target.closest?.('[data-conductor-pill]')) return
      if (ref.current && !ref.current.contains(target)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  const services = snap?.services ?? []
  // Per-card restart: each ServiceCard passes its own s.id (routing lives in
  // main's service registry, disable gating in restartInfoFor), so every
  // service that has a restart is individually restartable.
  const handleRestart = (id: string) => { void window.electronAPI.serviceHealth.restart(id) }
  // BUG-2: the copy gave no feedback, so it read as a no-op even on success.
  // Flip to a brief "Copied" state and surface real failures.
  const handleCopy = async () => {
    if (!snap) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(snap, null, 2))
      setCopied(true)
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('[services] copy diagnostics failed', err)
    }
  }

  // Clear the copy-feedback timer on unmount so it can't setState after teardown.
  useEffect(() => () => {
    if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current)
  }, [])

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Services diagnostics"
      // One card per registered service: with every section present the panel
      // can be taller than a small window, so it scrolls inside the window
      // instead of running off its bottom edge.
      className={`absolute right-0 top-full mt-1.5 z-50 w-80 max-h-[calc(100vh-4rem)] overflow-y-auto rounded-lg border shadow-xl p-3 flex flex-col gap-2.5 transition-all duration-200 ease-out ${
        entered ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1'
      }`}
      style={{
        background: 'var(--surface-raised)',
        borderColor: 'var(--border-subtle)',
        color: 'var(--text-primary)',
      }}
    >
      {services.map((s) => (
        <ServiceCard key={s.id} s={s} onRestart={handleRestart} />
      ))}
      <LogTail log={snap?.log ?? []} />
      {snap?.pty && <PtySection pty={snap.pty} />}
      {snap?.watchdog && snap.watchdog.activeSessions > 0 && <WatchdogSection watchdog={snap.watchdog} />}
      <div className="flex items-center gap-2 pt-0.5">
        {/* Restart moved onto each card (the watchdog needs its own), keeping
            its destructive read through --status-danger — BUG-3's regression
            test asserts on that token rather than on a palette class name. */}
        <DialogButton
          variant="secondary"
          onClick={handleCopy}
          title="Copy the full diagnostics snapshot as JSON"
          className="flex-1"
        >
          {copied ? 'Copied' : `${COPY_GLYPH} Copy diagnostics`}
        </DialogButton>
      </div>
    </div>
  )
}
