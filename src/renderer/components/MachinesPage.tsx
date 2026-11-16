import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import PageFrame from './PageFrame'
import { DialogButton } from './ui/Dialog'
import { MACHINES_NO_ANSWER, type HeldSession, type HelperState, type MachineStatus, type SelfTestResult } from '../../shared/machines'

// The Machines page (2.1.3-beta.6, plan section C): one card, This computer.
// It shows what the session helper is doing and the terminals it holds, and
// lets you run the helper's self-test, re-attach a terminal and end one. It
// reads on open, each time its tab comes back to the front, on Refresh and
// after each action; nothing is pushed to it.

const headerIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </svg>
)

const STATE_LABEL: Record<HelperState, string> = {
  off: 'Off',
  'not-installed': 'Not installed',
  starting: 'Starting',
  ready: 'Ready',
  failed: 'Failed',
}

const STATE_COLOR: Record<HelperState, string> = {
  off: 'var(--text-muted)',
  'not-installed': 'var(--status-warning)',
  starting: 'var(--status-info)',
  ready: 'var(--status-success)',
  failed: 'var(--status-danger)',
}

const STATE_SENTENCE: Record<HelperState, string> = {
  off: 'The session helper is off. Switch it on in Settings, General, Plain terminals through the session helper.',
  'not-installed': 'The session helper is not installed on this computer.',
  starting: 'The session helper is starting.',
  ready: 'The session helper is ready.',
  failed: 'The session helper failed.',
}

const EMPTY_LIST = 'The session helper holds no terminals right now.'
// An empty list from a helper that is starting, failed or unknown is not the same as
// "holds none": the helper may well hold terminals it cannot list yet.
const LIST_UNAVAILABLE = 'The list of held terminals is not available until the session helper is ready.'

/** The self-test needs a helper that is running (or one to retry after a failure). */
function canAct(state: HelperState): boolean {
  return state === 'ready' || state === 'failed'
}

/** States in which an empty list truly means "none held": the helper is ready, or it is off or not installed. */
function listIsKnown(state: HelperState | undefined): boolean {
  return state === 'ready' || state === 'off' || state === 'not-installed'
}

/** "10:32" for today, "Nov 15, 10:32" for another day, and a plain fallback for a bad number. */
function formatWhen(ms: number, now: number = Date.now()): string {
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return 'an unknown time'
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date(now).toDateString()) return time
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

/** What a held terminal is doing, in plain words. */
function sessionStateText(s: Pick<HeldSession, 'attached' | 'tabOpen'>): string {
  if (s.attached) return s.tabOpen ? 'Attached to the app' : 'Attached to the app. No tab shows it.'
  return s.tabOpen ? 'Waiting for the app' : 'Waiting for the app. No tab shows it.'
}

function kindText(kind: HeldSession['kind']): string {
  return kind === 'partner' ? 'Partner terminal' : 'Terminal'
}

function newer(a: SelfTestResult | undefined, b: SelfTestResult | undefined): SelfTestResult | undefined {
  if (!a) return b
  if (!b) return a
  return b.at > a.at ? b : a
}

function SelfTestLine({ result }: { result: SelfTestResult | undefined }) {
  if (!result) return <span data-testid="machines-self-test-result" style={{ color: 'var(--text-muted)' }}>Not run yet.</span>
  const color = result.ok ? 'var(--status-success)' : 'var(--status-danger)'
  return (
    <span data-testid="machines-self-test-result">
      <span style={{ color }}>{result.ok ? 'Passed' : 'Failed'}</span>
      <span style={{ color: 'var(--text-secondary)' }}> at {formatWhen(result.at)}</span>
      {result.detail && <span style={{ color: 'var(--text-secondary)' }}>. {result.detail}</span>}
    </span>
  )
}

interface Notice { ok: boolean; text: string }

function SessionRow({
  session, busy, confirming, onReattach, onAskEnd, onConfirmEnd, onCancelEnd,
}: {
  session: HeldSession
  busy: boolean
  confirming: boolean
  onReattach: () => void
  onAskEnd: () => void
  onConfirmEnd: () => void
  onCancelEnd: () => void
}) {
  const warnId = useId()
  const rowRef = useRef<HTMLLIElement>(null)
  const backedOut = useRef(false)
  // Keyboard and screen-reader users keep their place. The question opens on its
  // safe answer (Keep it). Backing out (and only that) puts focus back on this
  // row's End. The question closing for any other reason, such as another row's
  // End being pressed or End being confirmed, never takes focus: where focus goes
  // after a confirmed End is the page's business (it lands on the list heading).
  useEffect(() => {
    const row = rowRef.current
    if (confirming) {
      row?.querySelector<HTMLElement>('[data-machines-keep]')?.focus()
    } else if (backedOut.current) {
      backedOut.current = false
      row?.querySelector<HTMLElement>('[data-machines-end]')?.focus()
    }
  }, [confirming])
  const keepIt = () => {
    backedOut.current = true
    onCancelEnd()
  }
  return (
    <li
      ref={rowRef}
      className="rounded-lg px-3 py-2.5 flex flex-col gap-2"
      style={{ background: 'var(--surface-base)', border: '1px solid var(--border-subtle)' }}
      data-testid="machines-session"
      data-session-id={session.id}
    >
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-text truncate" title={session.label}>{session.label}</div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            {kindText(session.kind)} · Started at {formatWhen(session.startedAt)}
          </div>
          <div
            className="text-[11px] mt-0.5"
            data-testid="machines-session-state"
            style={{ color: session.attached ? 'var(--status-success)' : 'var(--status-warning)' }}
          >
            {sessionStateText(session)}
          </div>
        </div>
        {!confirming && (
          <div className="flex items-center gap-1.5 shrink-0">
            <DialogButton
              variant="secondary"
              onClick={onReattach}
              disabled={busy || session.attached}
              title={session.attached ? 'Already attached to the app' : 'Attach this terminal to the app again'}
              aria-label={`Re-attach ${session.label}`}
            >
              Re-attach
            </DialogButton>
            <DialogButton
              variant="danger"
              onClick={onAskEnd}
              disabled={busy}
              aria-label={`End ${session.label}`}
              data-machines-end=""
            >
              End
            </DialogButton>
          </div>
        )}
      </div>
      {confirming && (
        <div
          role="group"
          aria-label={`Confirm ending ${session.label}`}
          aria-describedby={warnId}
          className="flex items-center gap-2 flex-wrap rounded-md px-2.5 py-2"
          style={{ background: 'color-mix(in srgb, var(--status-danger) 9%, transparent)', border: '1px solid color-mix(in srgb, var(--status-danger) 40%, transparent)' }}
          data-testid="machines-end-confirm"
        >
          <span id={warnId} className="text-xs flex-1 min-w-[12rem]" style={{ color: 'var(--text-primary)' }}>
            End this terminal? Whatever is running in it stops, and its scrollback is lost.
          </span>
          {/* The name starts with the visible words, so "click End terminal" finds it (WCAG 2.5.3). */}
          <DialogButton variant="danger-solid" onClick={onConfirmEnd} disabled={busy} aria-label={`End terminal ${session.label}`} aria-describedby={warnId}>
            End terminal
          </DialogButton>
          <DialogButton variant="ghost" onClick={keepIt} disabled={busy} data-machines-keep="" aria-describedby={warnId}>
            Keep it
          </DialogButton>
        </div>
      )}
    </li>
  )
}

export default function MachinesPage({ active = true }: { active?: boolean }) {
  const [status, setStatus] = useState<MachineStatus | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmEndId, setConfirmEndId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [ranSelfTest, setRanSelfTest] = useState<SelfTestResult | undefined>(undefined)

  const mounted = useRef(true)
  // Newest read wins: an answer that arrives after a later read began is dropped.
  const readSeq = useRef(0)
  // After a confirmed End the row (and the button that had focus) is gone; focus then
  // goes to the list heading, once the action has finished and the controls are back.
  const listHeading = useRef<HTMLHeadingElement>(null)
  const focusListWhenDone = useRef(false)

  const refresh = useCallback(async () => {
    const seq = ++readSeq.current
    try {
      const next = await window.electronAPI.machines.status()
      if (!mounted.current || seq !== readSeq.current) return
      setStatus(next)
      setReadFailed(false)
      // A self-test this page ran says nothing about a helper that is no longer running
      // (switched off, not installed, starting again): drop it, so the card does not
      // show "Passed" next to a helper that is off. The helper's own report stays.
      const st = next?.helper?.state
      if (st !== 'ready' && st !== 'failed') setRanSelfTest(undefined)
    } catch {
      if (!mounted.current || seq !== readSeq.current) return
      setReadFailed(true)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Read on open, and again each time the tab comes back to the front: the app
  // keeps an open page mounted while another tab is showing, so mounting alone
  // would leave the list as old as the last visit.
  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  useEffect(() => {
    if (busy === null && focusListWhenDone.current) {
      focusListWhenDone.current = false
      listHeading.current?.focus()
    }
  }, [busy])

  const run = useCallback(async (key: string, work: () => Promise<void>) => {
    setBusy(key)
    setNotice(null)
    try {
      await work()
    } finally {
      await refresh()
      if (mounted.current) setBusy(null)
    }
  }, [refresh])

  const onSelfTest = () => run('self-test', async () => {
    let result: SelfTestResult
    try {
      result = await window.electronAPI.machines.runSelfTest()
    } catch {
      result = { ok: false, at: Date.now(), detail: MACHINES_NO_ANSWER }
    }
    if (mounted.current) setRanSelfTest(result)
  })

  const onReattach = (s: HeldSession) => run(`reattach:${s.id}`, async () => {
    let text: string
    let ok: boolean
    try {
      const r = await window.electronAPI.machines.reattach(s.id)
      ok = r.ok
      text = r.ok ? `Attached ${s.label} to the app.` : (r.message ?? `Could not attach ${s.label}.`)
    } catch {
      ok = false
      text = MACHINES_NO_ANSWER
    }
    if (mounted.current) setNotice({ ok, text })
  })

  const onEnd = (s: HeldSession) => {
    setConfirmEndId(null)
    focusListWhenDone.current = true
    return run(`end:${s.id}`, async () => {
      let text: string
      let ok: boolean
      try {
        const r = await window.electronAPI.machines.endSession(s.id)
        ok = r.ok
        text = r.ok ? `Ended ${s.label}.` : (r.message ?? `Could not end ${s.label}.`)
      } catch {
        ok = false
        text = MACHINES_NO_ANSWER
      }
      if (mounted.current) setNotice({ ok, text })
    })
  }

  const helper = status?.helper
  const state: HelperState | undefined = helper?.state
  const rawSessions: unknown = status?.sessions
  const sessions: HeldSession[] = Array.isArray(rawSessions) ? (rawSessions as HeldSession[]) : []
  const emptyListText = listIsKnown(state) ? EMPTY_LIST : LIST_UNAVAILABLE
  const selfTest = newer(helper?.selfTest, ranSelfTest)
  const stateText = state ? (STATE_SENTENCE[state] ?? 'The session helper is in a state this version does not know.') : ''
  const stateColor = state ? (STATE_COLOR[state] ?? 'var(--text-muted)') : 'var(--text-muted)'
  const working = busy !== null

  const refreshButton = (
    <button
      type="button"
      onClick={() => { void refresh() }}
      disabled={working}
      aria-label="Refresh"
      title="Read the session helper again"
      className="text-[11px] px-2 py-0.5 rounded-md text-[var(--text-muted)] hover:text-text hover:bg-surface0 transition-colors focus-ring disabled:opacity-40"
    >
      Refresh
    </button>
  )

  return (
    <PageFrame icon={headerIcon} iconAccent="sky" title="Machines" context="This computer" actions={refreshButton}>
      <div className="max-w-3xl mx-auto p-5 space-y-4" data-testid="machines-page">
        <section
          aria-label="This computer"
          className="rounded-xl p-4 space-y-4"
          style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
        >
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-text">{status?.name || 'This computer'}</h2>
            {state && (
              <span
                className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full"
                data-testid="machines-state"
                style={{ color: stateColor, background: `color-mix(in srgb, ${stateColor} 14%, transparent)` }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: stateColor }} aria-hidden />
                {STATE_LABEL[state] ?? 'Unknown'}
              </span>
            )}
          </div>

          {!status && !readFailed && (
            <p role="status" className="text-xs" style={{ color: 'var(--text-muted)' }}>Reading the session helper...</p>
          )}
          {readFailed && (
            <p role="alert" className="text-xs" style={{ color: 'var(--status-danger)' }} data-testid="machines-read-failed">
              This page could not read the session helper. Press Refresh to try again.
            </p>
          )}

          {status && (
            <>
              <div>
                <p className="text-xs" style={{ color: 'var(--text-primary)' }} data-testid="machines-state-text">{stateText}</p>
                {helper?.detail && (
                  <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }} data-testid="machines-detail">{helper.detail}</p>
                )}
              </div>

              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-xs items-center">
                <dt style={{ color: 'var(--text-muted)' }}>Helper version</dt>
                <dd style={{ color: 'var(--text-primary)' }} data-testid="machines-version">{helper?.version ? helper.version : 'Not known'}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>Self-test</dt>
                <dd className="flex items-center gap-2 flex-wrap">
                  {/* A live region that is always there, so a finished (or failed) self-test is
                      announced without moving focus. */}
                  <span role="status" aria-live="polite">
                    <SelfTestLine result={selfTest} />
                  </span>
                  <DialogButton
                    variant="secondary"
                    onClick={() => { void onSelfTest() }}
                    disabled={working || !state || !canAct(state)}
                    title={state && canAct(state) ? 'Ask the session helper to test itself' : 'The self-test needs a running session helper'}
                  >
                    {busy === 'self-test' ? 'Running...' : 'Run self-test'}
                  </DialogButton>
                </dd>
              </dl>

              <div>
                <h3
                  ref={listHeading}
                  tabIndex={-1}
                  className="text-[10px] uppercase tracking-wider font-semibold mb-2 outline-none"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Held terminals
                </h3>
                {sessions.length === 0 ? (
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }} data-testid="machines-empty">{emptyListText}</p>
                ) : (
                  <ul className="space-y-2">
                    {sessions.map((s) => (
                      <SessionRow
                        key={s.id}
                        session={s}
                        busy={working}
                        confirming={confirmEndId === s.id}
                        onReattach={() => { void onReattach(s) }}
                        onAskEnd={() => setConfirmEndId(s.id)}
                        onConfirmEnd={() => { void onEnd(s) }}
                        onCancelEnd={() => setConfirmEndId(null)}
                      />
                    ))}
                  </ul>
                )}
                {/* A live region that stays mounted (so a screen reader announces what an
                    action reports) and in the accessibility tree. It sits in this block,
                    not as the card's last child, so the card's spacing gives an empty one
                    no room. */}
                <div role="status" aria-live="polite" data-testid="machines-notice">
                  {notice && (
                    <p className="text-xs mt-2" style={{ color: notice.ok ? 'var(--status-success)' : 'var(--status-danger)' }}>
                      {notice.text}
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </PageFrame>
  )
}
