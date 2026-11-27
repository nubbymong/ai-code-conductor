import React, { useCallback, useEffect, useRef, useState } from 'react'
import { DialogButton } from './ui/Dialog'
import { REMOTE_ROUTE_NOTE, type RemoteActionResult, type RemoteMachineSessions, type RemoteMachineView, type RemoteMachinesState } from '../../shared/remote-machines'
import { useDetachedRemotesStore } from '../stores/detachedRemotesStore'
import { useConfigStore } from '../stores/configStore'
import { useSessionStore } from '../stores/sessionStore'
import { useLaunchSessionAction } from '../hooks/useLaunchConfig'
import { keptRows, type KeptRow } from '../utils/keptRows'
import { persistSessionState } from '../session-persistence'
import { useHostAccountsStore } from '../stores/hostAccountsStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { resolveAccountName } from '../../shared/account-chip-color'
import type { HostAccountSignIn, HostMachineAccounts } from '../../shared/host-accounts'
import type { ProviderId } from '../../shared/providers'
import { ProviderMark } from './sidebar/Badges'
import { PROVIDER_NAMES } from '../provider-names'
import {
  elsewhereStayText, hostElsewhere, machineAccountLine, machineLabel, machineOwnSignOutText, removeListing, removeNotAnsweringText, sessionMachine, signInOnTitle,
  type HostLineTone,
} from '../utils/hostAccounts'
import { openHostSignInTab } from '../utils/hostSignIn'

// The Machines page's Linux machines (2.1.3-beta.17, plan section A2): Add a
// Linux machine on a saved SSH config, after a question that says what goes
// there; each added machine's card with Check and Remove. It reads on open,
// each time its tab comes back to the front, and after each action. Shown
// only where the app can run remote sessions through the session helper
// (Windows); nothing is shown elsewhere, or by an app without the doors.
//
// 2.1.3-beta.20 section 5 (frame 4 of the approved mockup "Accounts across
// machines", Claude Code rows only): each card says how accounts sign in
// there (Sign in on this machine: each account signs in once there, by
// Claude Code's own sign-in, and stays signed in; Lend from this computer is
// not built yet, so it is not offered), lists this computer's accounts with
// their sign-in there (Sign in on <machine>, Sign out; the machine's own
// sign-in asks first, Q5), and Remove lists the accounts it signs out first,
// or, when the machine does not answer, what stays signed in there.

/** The only provider whose accounts sign in on machines in this release. */
const HOST_PROVIDER: ProviderId = 'claude'

interface Notice { ok: boolean; text: string }

const DOT_STYLE: Record<HostLineTone, React.CSSProperties> = {
  ok: { background: 'var(--status-success)' },
  warn: { background: 'var(--status-warning)' },
  none: { background: 'transparent', border: '1.5px solid var(--text-muted)' },
}

/** "How accounts sign in here" (frame 4): one way in this release, drawn as
 *  the mockup's chosen option but as static text (round 1, NIT-5: a radio
 *  group of one that the keyboard cannot reach is announced as a control). */
function HowAccountsSignIn({ label }: { label: string }) {
  return (
    <div data-testid="remote-machine-how">
      <p className="text-[10px] uppercase tracking-wider font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>How accounts sign in here</p>
      <div className="grid sm:grid-cols-2 gap-2">
        <div
          className="text-left rounded-lg px-2.5 py-2 flex gap-2.5 items-start border"
          style={{ borderColor: 'color-mix(in srgb, var(--brand) 50%, transparent)', background: 'color-mix(in srgb, var(--brand) 10%, transparent)' }}
          data-testid="remote-machine-how-signin"
        >
          <span className="w-[13px] h-[13px] rounded-full shrink-0 mt-0.5 flex items-center justify-center" style={{ border: '1.5px solid var(--brand)' }} aria-hidden="true">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--brand)' }} />
          </span>
          <span className="block min-w-0">
            <b className="block text-xs font-semibold" style={{ color: 'var(--brand)' }}>Sign in on this machine</b>
            <span className="block text-[11px] leading-snug mt-0.5" style={{ color: 'var(--text-muted)' }}>Each account signs in once on {label} and stays signed in there. Remote Control works.</span>
          </span>
        </div>
      </div>
    </div>
  )
}

/** One account's row in "Accounts here": the provider mark, the account and
 *  its provider, its sign-in there, and Sign in on that machine or Sign out. */
function AccountHereRow({ who, line, label, busy, switchOn, tabOpen, onSignIn, onSignOut }: {
  who: string
  line: ReturnType<typeof machineAccountLine>
  label: string
  busy: boolean
  switchOn: boolean
  tabOpen: boolean
  onSignIn: () => void
  onSignOut: () => void
}) {
  return (
    <div className="grid grid-cols-[16px_minmax(0,150px)_minmax(0,1fr)_auto] gap-2 items-baseline py-1.5 text-xs border-t first:border-t-0" style={{ borderColor: 'var(--border-subtle)' }} data-testid="remote-account-row" data-who={who}>
      <span className="self-center"><ProviderMark providerId={HOST_PROVIDER} size={14} /></span>
      <span className="truncate font-medium" style={{ color: 'var(--text-primary)' }} title={who}>
        {who}<span className="font-normal ml-1.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{PROVIDER_NAMES[HOST_PROVIDER]}</span>
      </span>
      <span className="inline-flex items-start gap-1.5 min-w-0" style={{ color: line.muted ? 'var(--text-muted)' : 'var(--text-secondary)' }} data-testid="remote-account-state">
        <span className="w-[7px] h-[7px] rounded-full shrink-0 mt-1 box-border" style={DOT_STYLE[line.tone]} aria-hidden="true" />
        <span className="min-w-0 break-words">
          {line.text}
          {line.sub && <small className="block text-[11px]" style={{ color: 'var(--text-muted)' }} data-testid="remote-account-sub">{line.sub}</small>}
        </span>
      </span>
      {line.action === 'sign-in' && (
        <button
          type="button"
          className="inline-flex items-center rounded-md border px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
          disabled={busy || !switchOn}
          title={switchOn ? signInOnTitle(label) : 'Remote sessions through the session helper are off. Turn them on in Settings, General, under Terminal.'}
          onClick={onSignIn}
          data-testid="remote-account-signin"
        >
          Sign in on {label}
        </button>
      )}
      {line.action === 'sign-out' && (
        <button
          type="button"
          className="inline-flex items-center rounded-md border px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
          disabled={busy || tabOpen}
          title={tabOpen ? 'A tab runs on this account here' : `Sign ${who} out on ${label}`}
          onClick={onSignOut}
          data-testid="remote-account-signout"
        >
          Sign out
        </button>
      )}
      {!line.action && <span />}
    </div>
  )
}

/** "Accounts here" (frame 4): each of this computer's accounts as the
 *  machine's last read found it. */
function AccountsHere({ rows }: { rows: React.ReactNode }) {
  return (
    <div data-testid="remote-machine-accounts">
      <p className="text-[10px] uppercase tracking-wider font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>Accounts here</p>
      <div className="flex flex-col">{rows}</div>
    </div>
  )
}

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

/** 2.1.3-beta.20 section 5: what a machine's card shows of its accounts, and
 *  what its rows do. Absent: an app without the accounts doors. */
interface CardAccounts {
  /** The machine's last read (undefined: never read this run). */
  read: HostMachineAccounts | undefined
  /** This computer's Claude Code accounts, in their order: id and name. */
  profiles: Array<{ id: string; name: string }>
  /** A tab on that account runs on this machine now (Sign out waits for it). */
  tabOn: (profileId: string) => boolean
  onSignIn: (profileId: string) => void
  /** `confirmMachineOwn`: the user confirmed signing out the machine's own sign-in. */
  onSignOut: (profileId: string, confirmMachineOwn: boolean) => Promise<'done' | 'confirm'>
}

function MachineCard({ m, switchOn, busy, onCheck, onRemove, onAsk, kept, keptWhy, onReattach, onEnd, accounts }: {
  m: RemoteMachineView
  switchOn: boolean
  busy: boolean
  onCheck: () => void
  /** Remove (`forget`: the machine did not answer, and the user chose to
   *  remove it anyway); what it answered, or null when the app did not. */
  onRemove: (forget: boolean) => Promise<RemoteActionResult | null>
  /** The Remove question opens: the page clears the last action's notice,
   *  so an old answer does not sit under a new question (2.1.3-beta.18
   *  release smoke). */
  onAsk: () => void
  /** 2.1.3-beta.19: the sessions its helper keeps, by list mode, or why they were not read. */
  kept: KeptRow[]
  keptWhy?: string
  onReattach: (row: KeptRow) => void
  onEnd: (row: KeptRow) => void
  /** 2.1.3-beta.20 section 5 (frame 4): its accounts. */
  accounts?: CardAccounts
}) {
  // The Remove question: as asked, or again in the not-answering words
  // after a Remove that could not reach the machine (frame 4's variant).
  const [confirming, setConfirming] = useState<false | 'ask' | 'not-answering'>(false)
  // Q5: the machine's own sign-in is signed out only after this confirm.
  const [ownConfirm, setOwnConfirm] = useState<string | null>(null)
  const color = m.checked ? 'var(--status-success)' : 'var(--status-warning)'
  const label = machineLabel(m)
  const nameOf = (id: string) => accounts?.profiles.find((p) => p.id === id)?.name ?? 'an account of this computer'
  const listing = removeListing(accounts?.read, nameOf)
  const remove = async (forget: boolean) => {
    setConfirming(false)
    const r = await onRemove(forget)
    if (r && !r.ok && r.notAnswering && !forget) { onAsk(); setConfirming('not-answering') }
  }
  const signOut = async (profileId: string, confirmed: boolean) => {
    if (!accounts) return
    setOwnConfirm(null)
    const a = accounts.read?.accounts.find((x) => x.profileId === profileId)
    // The last read says it is the machine's own sign-in: ask before anything runs.
    if (!confirmed && a?.state === 'machine-own' && !a.folder) { onAsk(); setOwnConfirm(profileId); return }
    if ((await accounts.onSignOut(profileId, confirmed)) === 'confirm') { onAsk(); setOwnConfirm(profileId) }
  }
  const rowOf = (p: { id: string; name: string }) => {
    const a: HostAccountSignIn | undefined = accounts?.read?.accounts.find((x) => x.profileId === p.id)
    const why = accounts?.read && !accounts.read.ok ? accounts.read.why : undefined
    return (
      <AccountHereRow
        key={p.id}
        who={p.name}
        line={machineAccountLine(a, label, p.name, { why, elsewhere: hostElsewhere(accounts?.read, p.id) })}
        label={label}
        busy={busy}
        switchOn={switchOn}
        tabOpen={accounts?.tabOn(p.id) ?? false}
        onSignIn={() => accounts?.onSignIn(p.id)}
        onSignOut={() => { void signOut(p.id, false) }}
      />
    )
  }
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
          {/* Only a checked machine's tabs go through the helper: until Check, the usual SSH path (text smoke #32). */}
          {switchOn && m.checked && <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }} data-testid="remote-machine-route">{REMOTE_ROUTE_NOTE}</div>}
          {switchOn && m.persistentNote && <div className="text-[11px] mt-1" style={{ color: 'var(--status-warning)' }} data-testid="remote-machine-persistent">{m.persistentNote}</div>}
          {keptWhy && <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }} data-testid="remote-kept-unread">Its sessions were not listed: {keptWhy}</div>}
        </div>
        {!confirming && (
          <div className="flex items-center gap-1.5 shrink-0">
            <DialogButton variant="secondary" onClick={onCheck} disabled={busy} aria-label={`Check ${m.label}`}>Check</DialogButton>
            <DialogButton
              variant="danger"
              onClick={() => { onAsk(); setOwnConfirm(null); setConfirming('ask') }}
              disabled={busy || m.inUse > 0}
              title={m.inUse > 0 ? 'Close the tabs that run through the helper here first' : 'Remove the session helper from this machine'}
              aria-label={`Remove ${m.label}`}
            >
              Remove
            </DialogButton>
          </div>
        )}
      </div>
      {accounts && accounts.profiles.length > 0 && (
        <>
          <HowAccountsSignIn label={label} />
          <AccountsHere rows={accounts.profiles.map(rowOf)} />
        </>
      )}
      {ownConfirm && (
        <div role="group" aria-label={`Confirm signing out ${label}'s own sign-in`} className={CONFIRM_CLASS} style={CONFIRM_STYLE} data-testid="remote-own-signout-confirm">
          <span className="text-xs flex-1 min-w-[12rem] leading-[1.45]" style={{ color: 'var(--text-primary)' }}>{machineOwnSignOutText(label, nameOf(ownConfirm))}</span>
          <DialogButton variant="danger-solid" onClick={() => { void signOut(ownConfirm, true) }} disabled={busy}>Sign out {label}&apos;s own sign-in</DialogButton>
          <DialogButton variant="ghost" onClick={() => setOwnConfirm(null)} disabled={busy}>Keep it</DialogButton>
        </div>
      )}
      <KeptSessions rows={kept} switchOn={switchOn} busy={busy} onReattach={onReattach} onEnd={onEnd} />
      {confirming === 'ask' && (
        <div role="group" aria-label={`Confirm removing ${m.label}`} className={CONFIRM_CLASS} style={CONFIRM_STYLE}>
          {listing.signedIn.length > 0 ? (
            <div className="text-xs flex-1 min-w-[12rem] leading-[1.45]" style={{ color: 'var(--text-primary)' }} data-testid="remote-remove-listing">
              Remove {m.name}? {listing.signedIn.length === 1 ? 'This account is' : 'These accounts are'} signed in there and {listing.signedIn.length === 1 ? 'is' : 'are'} signed out first:
              <ul className="list-disc my-1 ml-4">{listing.signedIn.map((x) => <li key={x.key}>{x.name}</li>)}</ul>
              {listing.own && <>{listing.own} is signed in there by {label}&apos;s own sign-in, which Remove leaves as it is. </>}
              Then the session helper and its folder in ~/.aicc are deleted.
              {/* Round 1 (MINOR-2): folders the app on another computer made there stay. */}
              {listing.elsewhere > 0 && <> {elsewhereStayText(listing.elsewhere)}</>}
            </div>
          ) : (
            <span className="text-xs flex-1 min-w-[12rem]" style={{ color: 'var(--text-primary)' }}>
              Remove the session helper from {m.name}? Its folder in ~/.aicc there is deleted.{listing.own ? ` ${listing.own} is signed in there by ${label}'s own sign-in, which Remove leaves as it is.` : ''}{listing.elsewhere > 0 ? ` ${elsewhereStayText(listing.elsewhere)}` : ''}
            </span>
          )}
          <DialogButton variant="danger-solid" onClick={() => { void remove(false) }} disabled={busy}>{listing.signedIn.length > 0 ? 'Sign out and remove' : 'Remove'}</DialogButton>
          <DialogButton variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Keep it</DialogButton>
        </div>
      )}
      {confirming === 'not-answering' && (
        <div role="group" aria-label={`Confirm removing ${m.label}, not reachable`} className={CONFIRM_CLASS} style={CONFIRM_STYLE} data-testid="remote-remove-not-answering">
          <span className="text-xs flex-1 min-w-[12rem] leading-[1.45]" style={{ color: 'var(--text-primary)' }}>{removeNotAnsweringText(m.name, listing)}</span>
          <DialogButton variant="danger-solid" onClick={() => { void remove(true) }} disabled={busy}>Remove anyway</DialogButton>
          <DialogButton variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Keep it</DialogButton>
        </div>
      )}
    </li>
  )
}

const CONFIRM_CLASS = 'flex items-center gap-2 flex-wrap rounded-md px-2.5 py-2'
const CONFIRM_STYLE: React.CSSProperties = { background: 'color-mix(in srgb, var(--status-danger) 9%, transparent)', border: '1px solid color-mix(in srgb, var(--status-danger) 40%, transparent)' }

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
  // 2.1.3-beta.20 section 5: each machine's accounts (its last read, kept
  // with the account cards' in the store), and this computer's accounts.
  const hostByDid = useHostAccountsStore((s) => s.byDid)
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const aliases = useSettingsStore((s) => s.settings.accountAliases)
  const accountsDoor = typeof remote?.accounts === 'function'

  const refresh = useCallback(async () => {
    if (!remote) return
    const n = ++seq.current
    try {
      const next = await remote.state()
      if (mounted.current && n === seq.current) setState(next)
      // The account cards and the Switch Account list name machines from it too.
      useHostAccountsStore.getState().setMachines(next)
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
    // 2.1.3-beta.20 section 5: each machine's accounts as its last read found them (no exec).
    try {
      if (typeof remote.accounts === 'function') useHostAccountsStore.getState().setAccounts(await remote.accounts())
    } catch { /* the rows keep what they had */ }
  }, [remote])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { if (active) void refresh() }, [active, refresh])
  // Leaving the page clears the last action's notice (2.1.3-beta.19 release
  // smoke: an Add's notice still sat under the card 7 minutes and other pages
  // later). The page stays mounted while another tab is in front.
  useEffect(() => { if (!active) setNotice(null) }, [active])

  const act = async (work: () => Promise<RemoteActionResult>): Promise<RemoteActionResult | null> => {
    setBusy(true)
    setNotice(null)
    try {
      const r = await work()
      if (mounted.current) setNotice({ ok: r.ok, text: r.message })
      return r
    } catch {
      if (mounted.current) setNotice({ ok: false, text: 'The app did not answer. Try again.' })
      return null
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

  // 2.1.3-beta.20 section 5 (frame 4): this computer's accounts on each card.
  const accountList = profiles.map((p) => ({ id: p.id, name: resolveAccountName(p.accountEmail, p.name, aliases) || p.accountEmail || p.name || 'Account' }))
  const accountsOf = (m: RemoteMachineView): CardAccounts | undefined => accountsDoor
    ? {
        read: hostByDid[m.did],
        profiles: accountList,
        // A tab on that account runs on this machine (Sign out waits for it; main refuses it too).
        tabOn: (profileId) => openSessions.some((s) => s.sessionType === 'ssh' && !s.shellOnly && !s.ptyExited && s.profileId === profileId && sessionMachine(s, [m]) !== undefined),
        onSignIn: (profileId) => {
          setNotice(null)
          const r = openHostSignInTab(m, profileId)
          if (!r.ok) setNotice({ ok: false, text: r.why })
        },
        onSignOut: async (profileId, confirmMachineOwn) => {
          let asked = false
          await act(async () => {
            const r = await remote.accountSignOut({ did: m.did, profileId, ...(confirmMachineOwn ? { confirmMachineOwn: true } : {}) })
            // Q5: the machine's own sign-in: nothing ran, and the card asks first.
            if (r.needsConfirm === 'machine-own') { asked = true; return { ok: true, message: '' } }
            return { ok: r.ok, message: r.message }
          })
          if (asked) setNotice(null)
          return asked ? 'confirm' : 'done'
        },
      }
    : undefined

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
              onRemove={(forget) => act(() => (forget ? remote.remove(m.did, { forget: true }) : remote.remove(m.did)))}
              onAsk={() => setNotice(null)}
              kept={rowsOf(m.did).rows}
              keptWhy={rowsOf(m.did).why}
              onReattach={(row) => reattachRow(m.did, row)}
              onEnd={(row) => endRow(m.did, row)}
              accounts={accountsOf(m)}
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
            {/* None left to add (each added already, or not addable in this preview): say so, not an empty box (text smoke #34). */}
            {state.candidates.length > 0 && addable.length === 0 && <option value="">No saved SSH config left to add: each one is added already, or cannot be added in this preview</option>}
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
