import React, { useCallback, useEffect, useRef, useState } from 'react'
import { DialogButton } from './ui/Dialog'
import { REMOTE_ROUTE_NOTE, type RemoteActionResult, type RemoteMachineSessions, type RemoteMachineView, type RemoteMachinesState } from '../../shared/remote-machines'
import { useDetachedRemotesStore } from '../stores/detachedRemotesStore'
import { useConfigStore } from '../stores/configStore'
import { useSessionStore } from '../stores/sessionStore'
import { useLaunchSessionAction } from '../hooks/useLaunchConfig'
import { keptRows, type KeptRow } from '../utils/keptRows'
import { persistSessionState } from '../session-persistence'

// The Machines page's Linux machines (2.1.3-beta.17, plan section A2): Add a
// Linux machine on a saved SSH config, after a question that says what goes
// there; each added machine's card with Check and Remove. It reads on open,
// each time its tab comes back to the front, and after each action. Shown
// only where the app can run remote sessions through the session helper
// (Windows); nothing is shown elsewhere, or by an app without the doors.

interface Notice { ok: boolean; text: string }

function KeptSessions({ rows, switchOn, busy, onReattach, onEnd }: {
  rows: KeptRow[]
  switchOn: boolean
  busy: boolean
  onReattach: (row: KeptRow) => void
  onEnd: (row: KeptRow) => void
}) {
  if (rows.length === 0) return null
  return (
    <ul className="space-y-1" aria-label="Sessions kept here" data-testid="remote-kept-sessions">
      {rows.map((r) => (
        <li key={r.session.sid} className="flex items-center gap-2 flex-wrap text-[11px]" data-testid="remote-kept-session" data-sid={r.session.sid}>
          <span className="flex-1 min-w-[10rem] truncate" style={{ color: 'var(--text-primary)' }} title={r.label}>{r.label}</span>
          <span style={{ color: 'var(--text-secondary)' }}>
            {r.open ? (r.session.attached ? 'open in a tab' : 'open in a tab that is not attached to it') : r.session.untilEnded ? 'kept until you end it' : 'ends two minutes after its tab went'}
            {r.session.running ? '' : ', its program has ended'}
          </span>
          {!r.open && r.session.untilEnded && r.config && (
            <DialogButton
              variant="secondary"
              disabled={busy}
              onClick={() => onReattach(r)}
              title={switchOn ? 'Open it in a tab again' : 'Remote sessions through the session helper are off'}
              data-testid="remote-kept-reattach"
            >
              Re-attach
            </DialogButton>
          )}
          {(!r.open || !r.session.attached) && (
            <DialogButton variant="danger" disabled={busy} onClick={() => onEnd(r)} data-testid="remote-kept-end">End</DialogButton>
          )}
        </li>
      ))}
    </ul>
  )
}

function when(ms: number): string {
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return 'an unknown time'
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

function MachineCard({ m, switchOn, busy, onCheck, onRemove, onAsk, kept, keptWhy, onReattach, onEnd }: {
  m: RemoteMachineView
  switchOn: boolean
  busy: boolean
  onCheck: () => void
  onRemove: () => void
  /** The Remove question opens: the page clears the last action's notice,
   *  so an old answer does not sit under a new question (2.1.3-beta.18
   *  release smoke). */
  onAsk: () => void
  /** 2.1.3-beta.19: the sessions its helper keeps, by list mode, or why they were not read. */
  kept: KeptRow[]
  keptWhy?: string
  onReattach: (row: KeptRow) => void
  onEnd: (row: KeptRow) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const color = m.checked ? 'var(--status-success)' : 'var(--status-warning)'
  return (
    <li className="rounded-lg px-3 py-2.5 flex flex-col gap-2" style={{ background: 'var(--surface-base)', border: '1px solid var(--border-subtle)' }} data-testid="remote-machine" data-did={m.did}>
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-text truncate" title={m.target}>{m.label}</div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{m.target} · {m.system} · helper {m.helperVersion}</div>
          <div className="text-[11px] mt-0.5" style={{ color }} data-testid="remote-machine-state">
            {m.checked ? `Checked at ${when(m.lastCheck.at)}` : `Not checked: ${m.lastCheck.detail ?? 'its last check failed'}`}
            {m.inUse > 0 ? ` · ${m.inUse === 1 ? 'a tab runs' : `${m.inUse} tabs run`} through the helper here` : ''}
          </div>
          {switchOn && <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }} data-testid="remote-machine-route">{REMOTE_ROUTE_NOTE}</div>}
          {switchOn && m.persistentNote && <div className="text-[11px] mt-1" style={{ color: 'var(--status-warning)' }} data-testid="remote-machine-persistent">{m.persistentNote}</div>}
          {keptWhy && <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }} data-testid="remote-kept-unread">Its sessions were not listed: {keptWhy}</div>}
        </div>
        {!confirming && (
          <div className="flex items-center gap-1.5 shrink-0">
            <DialogButton variant="secondary" onClick={onCheck} disabled={busy} aria-label={`Check ${m.label}`}>Check</DialogButton>
            <DialogButton
              variant="danger"
              onClick={() => { onAsk(); setConfirming(true) }}
              disabled={busy || m.inUse > 0}
              title={m.inUse > 0 ? 'Close the tabs that run through the helper here first' : 'Remove the session helper from this machine'}
              aria-label={`Remove ${m.label}`}
            >
              Remove
            </DialogButton>
          </div>
        )}
      </div>
      <KeptSessions rows={kept} switchOn={switchOn} busy={busy} onReattach={onReattach} onEnd={onEnd} />
      {confirming && (
        <div role="group" aria-label={`Confirm removing ${m.label}`} className="flex items-center gap-2 flex-wrap rounded-md px-2.5 py-2" style={{ background: 'color-mix(in srgb, var(--status-danger) 9%, transparent)', border: '1px solid color-mix(in srgb, var(--status-danger) 40%, transparent)' }}>
          <span className="text-xs flex-1 min-w-[12rem]" style={{ color: 'var(--text-primary)' }}>Remove the session helper from {m.target}? Its folder in ~/.aicc there is deleted.</span>
          <DialogButton variant="danger-solid" onClick={() => { setConfirming(false); onRemove() }} disabled={busy}>Remove</DialogButton>
          <DialogButton variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Keep it</DialogButton>
        </div>
      )}
    </li>
  )
}

export default function RemoteMachinesSection({ active = true }: { active?: boolean }) {
  const [state, setState] = useState<RemoteMachinesState | null>(null)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState('')
  const [consent, setConsent] = useState<{ token: string; text: string; target: string } | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [sessions, setSessions] = useState<RemoteMachineSessions[]>([])
  const mounted = useRef(true)
  const seq = useRef(0)
  const remote = window.electronAPI?.machines?.remote
  const entries = useDetachedRemotesStore((s) => s.entries)
  const removeEntry = useDetachedRemotesStore((s) => s.remove)
  const configs = useConfigStore((s) => s.configs)
  const openSessions = useSessionStore((s) => s.sessions)
  const reattach = useLaunchSessionAction()

  const refresh = useCallback(async () => {
    if (!remote) return
    const n = ++seq.current
    try {
      const next = await remote.state()
      if (mounted.current && n === seq.current) setState(next)
    } catch {
      if (mounted.current && n === seq.current) setState(null)
    }
    // 2.1.3-beta.19: the sessions each helper keeps (one list exec per machine).
    try {
      const listed = typeof remote.sessions === 'function' ? await remote.sessions() : { machines: [] }
      if (mounted.current && n === seq.current) setSessions(listed.machines)
    } catch {
      if (mounted.current && n === seq.current) setSessions([])
    }
  }, [remote])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { if (active) void refresh() }, [active, refresh])

  const act = async (work: () => Promise<RemoteActionResult>) => {
    setBusy(true)
    setNotice(null)
    try {
      const r = await work()
      if (mounted.current) setNotice({ ok: r.ok, text: r.message })
    } catch {
      if (mounted.current) setNotice({ ok: false, text: 'The app did not answer. Try again.' })
    } finally {
      await refresh()
      if (mounted.current) setBusy(false)
    }
  }

  if (!remote || !state || !state.available) return null
  const addable = state.candidates.filter((c) => c.addable)
  const openIds = new Set(openSessions.map((s) => s.id))
  const openLabels = new Map(openSessions.map((s) => [s.id, s.customName?.trim() || s.label] as [string, string]))
  const rowsOf = (did: string): { rows: KeptRow[]; why?: string } => {
    const listed = sessions.find((x) => x.did === did)
    if (!listed) return { rows: [] }
    if (!listed.ok) return { rows: [], why: listed.why }
    return { rows: keptRows(listed.sessions, entries, configs, openIds, openLabels) }
  }
  const reattachRow = (did: string, row: KeptRow) => {
    setNotice(null)
    if (!state.switchOn) { setNotice({ ok: false, text: 'Remote sessions through the session helper are off. Turn them on in Settings, General, under Terminal, to re-attach it, or End it here.' }); return }
    const id = row.session.appSessionId
    if (!id || !row.config) return
    if (!reattach(row.config, { sessionId: id, reconnect: true, keptOn: did })) return
    removeEntry(id)
    void persistSessionState()
    setNotice({ ok: true, text: `Opened ${row.label} in a tab again.` })
  }
  const endRow = (did: string, row: KeptRow) => {
    void act(async () => {
      const r = await remote.endSession(did, row.session.sid)
      if (r.ok && row.session.appSessionId) { removeEntry(row.session.appSessionId); void persistSessionState() }
      return r
    })
  }
  const choice = addable.some((c) => c.configId === picked) ? picked : (addable[0]?.configId ?? '')

  const ask = async () => {
    if (!choice) return
    setBusy(true)
    setNotice(null)
    try {
      const r = await remote.prepare(choice)
      if (!mounted.current) return
      if (r.ok) setConsent({ token: r.token, text: r.text, target: r.target })
      else setNotice({ ok: false, text: r.message })
    } catch {
      if (mounted.current) setNotice({ ok: false, text: 'The app did not answer. Try again.' })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <section aria-label="Linux machines" className="rounded-xl p-4 space-y-3" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }} data-testid="remote-machines">
      <h2 className="text-sm font-semibold text-text">Linux machines <span className="text-[11px] font-normal" style={{ color: 'var(--text-muted)' }}>(preview)</span></h2>
      {!state.switchOn && (
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }} data-testid="remote-switch-off">
          Remote sessions through the session helper are off. Switch them on in Settings, General, under Terminal. A machine you add here is used once it is on.
        </p>
      )}
      {!state.bundled.ok && <p className="text-xs" style={{ color: 'var(--status-warning)' }} data-testid="remote-no-helper">{state.bundled.why}</p>}
      {state.machines.length > 0 && (
        <ul className="space-y-2">
          {state.machines.map((m) => (
            <MachineCard
              key={m.did}
              m={m}
              switchOn={state.switchOn}
              busy={busy}
              onCheck={() => { void act(() => remote.check(m.did)) }}
              onRemove={() => { void act(() => remote.remove(m.did)) }}
              onAsk={() => setNotice(null)}
              kept={rowsOf(m.did).rows}
              keptWhy={rowsOf(m.did).why}
              onReattach={(row) => reattachRow(m.did, row)}
              onEnd={(row) => endRow(m.did, row)}
            />
          ))}
        </ul>
      )}
      {consent ? (
        <div role="group" aria-label="Install the session helper" className="rounded-md px-3 py-2.5 space-y-2" style={{ background: 'var(--surface-base)', border: '1px solid var(--border-strong)' }} data-testid="remote-consent">
          <p className="text-xs" style={{ color: 'var(--text-primary)' }}>{consent.text}</p>
          <div className="flex items-center gap-2">
            <DialogButton variant="primary" disabled={busy} onClick={() => { const t = consent.token; setConsent(null); void act(() => remote.add(t)) }}>Install</DialogButton>
            <DialogButton variant="ghost" disabled={busy} onClick={() => setConsent(null)}>Cancel</DialogButton>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <select
            aria-label="Saved SSH config to add"
            className="text-xs rounded-md px-2 py-1 bg-[var(--surface-base)] border border-[var(--border-strong)] text-[var(--text-primary)]"
            value={choice}
            disabled={busy || addable.length === 0}
            onChange={(e) => setPicked(e.target.value)}
          >
            {state.candidates.length === 0 && <option value="">No SSH config to add</option>}
            {state.candidates.map((c) => (
              <option key={c.configId} value={c.configId} disabled={!c.addable} title={c.why}>
                {c.label} ({c.target}){c.addable ? '' : ` - ${c.why}`}
              </option>
            ))}
          </select>
          <DialogButton variant="secondary" disabled={busy || !choice || !state.bundled.ok} onClick={() => { void ask() }} data-testid="remote-add">
            {busy ? 'Working...' : 'Add a Linux machine'}
          </DialogButton>
        </div>
      )}
      <div role="status" aria-live="polite" data-testid="remote-notice">
        {notice && <p className="text-xs" style={{ color: notice.ok ? 'var(--status-success)' : 'var(--status-danger)' }}>{notice.text}</p>}
      </div>
    </section>
  )
}
