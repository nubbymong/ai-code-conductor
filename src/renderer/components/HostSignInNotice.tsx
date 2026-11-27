// src/renderer/components/HostSignInNotice.tsx
//
// 2.1.3-beta.20 section 5, frame 2 of the approved mockup ("Before a session
// starts on a machine without that sign-in"), beside AccountLaunchGate: a
// helper tab whose account is not signed in on its machine starts nothing
// there (main's launch-refused notice, phase 3), and a Switch Account to such
// an account switches nothing (utils/helperSwitch); either way this asks how
// the tab signs in there:
//  - Sign in on <machine>: a sign-in tab runs Claude Code's own sign-in there
//    (utils/hostSignIn), and once it ends signed in the tab goes on (it
//    starts, or switches) on that account;
//  - another account signed in there, when there is one;
//  - Cancel: nothing starts, or the tab stays on its account.
// Every machine signs in on itself (Q7): Lend from this computer is not built
// yet, so it is not offered here, not even greyed.
//
// Mounted once at the app root: it also listens for each machine's reads and
// account notices (stores/hostAccountsStore), and runs the tabs whose wait
// for a sign-in is over.
import React, { useEffect, useRef, useState } from 'react'
import { useHostAccountsStore, listenHostAccounts, type HostAdoptAsk, type HostNotice, type HostRun } from '../stores/hostAccountsStore'
import { adoptableIds, adoptConfirmText, adoptNextText, hostAccountName } from '../utils/hostAccounts'
import { useSessionStore } from '../stores/sessionStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useRestartSession } from '../hooks/useRestartSession'
import { isAccountActive } from '../../shared/account-types'
import { openHostSignInTab } from '../utils/hostSignIn'
import { switchHelperTabAccount } from '../utils/helperSwitch'
import {
  DialogOverlay, DialogPanel, DialogHeader, DialogBody, DialogFooter, DialogButton,
  DIALOG_INPUT_CLASS, DIALOG_INPUT_STYLE, useDialogEscape,
} from './ui/Dialog'

const MIDDOT = String.fromCharCode(0xb7)

/** The words of the notice, by why it asks (frame 2). Exported for its test. */
export function hostNoticeText(n: Pick<HostNotice, 'kind' | 'state' | 'identity' | 'machineName' | 'elsewhere' | 'adoptable'>, who: string): {
  title: string
  question: string
  why: string
  signInHint: string
  otherLabel: string
  otherAfter: string
  cancelTitle: string
} {
  const m = n.machineName
  const launch = n.kind === 'launch'
  return {
    title: launch ? 'Start session' : 'Switch account',
    // Round 2 (R2-1): main's refusal names the folder as another install's
    // that may be this computer's own (its tab says it in these words): Adopt.
    // Round 1 (MINOR-2): otherwise its folder there is the app on another
    // computer's, which main never signs in from here: nothing is offered.
    question: n.adoptable
      ? `${who}'s folder on ${m} carries another install's mark.`
      : n.elsewhere
        ? `${who}'s folder on ${m} is used by the app on another computer.`
        : n.state === 'someone-else'
          ? `${who} on ${m} is signed in as ${n.identity || 'another account'}, so that sign-in is not used.`
          : `${who} is not signed in on ${m}.`,
    why: n.adoptable
      ? 'It may be this computer\'s own from an earlier install of the app: if so, Adopt makes it this computer\'s again. If it is the app\'s on another computer, start this session on an account signed in there.'
      : n.elsewhere
        ? 'That computer signs it in and out there, so it cannot be signed in from here.'
        : n.state === 'someone-else'
          ? `${m} keeps its own sign-ins. Signing ${who} in again there replaces that one.`
          : `${m} keeps its own sign-ins.`,
    signInHint: `Runs Claude Code's own sign-in in a session on ${m}. It stays signed in there, so Remote Control works on ${m}. ${launch ? 'This session starts once it is signed in.' : 'The session moves to it once it is signed in.'}`,
    otherLabel: launch ? 'Or start it on another account' : 'Or switch to another account',
    otherAfter: launch ? 'The session starts on that account.' : 'The session moves to that account, with its conversation.',
    cancelTitle: launch ? 'Do not start this session' : 'Keep the current account',
  }
}

/** Round 4 (R4-5): the one naming the cards' Adopt hover text uses too. */
function useAccountName(): (profileId: string) => string {
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const aliases = useSettingsStore((s) => s.settings.accountAliases)
  return hostAccountName(profiles, aliases)
}

/** Round 1 (MINOR-4): a dialog gives the keyboard focus back to where it
 *  was when it opened (read before its own autoFocus moves it). */
function useReturnFocus(): void {
  const before = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement)
  useEffect(() => () => {
    const el = before.current as HTMLElement | null
    if (el && el.isConnected && typeof el.focus === 'function') el.focus()
  }, [])
}

function NoticeDialog({ notice }: { notice: HostNotice }) {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === notice.sessionId) ?? null)
  const { restart } = useRestartSession(session, false)
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const machines = useHostAccountsStore((s) => s.machines)
  const nameOf = useAccountName()
  useReturnFocus()
  const close = () => useHostAccountsStore.getState().closeNotice(notice.sessionId)
  // Cancel: nothing starts, or the tab stays on its account; it waits for nothing.
  const cancel = () => { useHostAccountsStore.getState().dropWaits(notice.sessionId); close() }
  useDialogEscape(cancel)
  // The machine's card (its saved SSH config is found from it).
  useEffect(() => { void useHostAccountsStore.getState().load() }, [])
  // A tab closed meanwhile: nothing to ask about.
  useEffect(() => { if (!session) close() })
  const others = notice.signedInThere.filter((id) => profiles.some((p) => p.id === id && isAccountActive(p)))
  const [other, setOther] = useState(others[0] ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  if (!session) return null

  const who = nameOf(notice.profileId)
  const text = hostNoticeText(notice, who)
  const tabName = session.customName?.trim() || session.label || 'this session'

  const signIn = () => {
    const machine = machines.find((m) => m.did === notice.did)
    if (!machine) { setProblem(`${notice.machineName} is not on the Machines page's list any more.`); return }
    const r = openHostSignInTab(machine, notice.profileId)
    if (!r.ok) { setProblem(r.why); return }
    // Round 1 (MAJOR-1): the tab waits for THIS sign-in tab, while it is the
    // run it is now (a Restart or a Switch meanwhile drops the wait).
    useHostAccountsStore.getState().waitForSignIn({
      sessionId: notice.sessionId,
      createdAt: session.createdAt,
      signInTabId: r.sessionId,
      did: notice.did,
      profileId: notice.profileId,
      mode: notice.kind === 'launch' ? 'restart' : 'switch',
      carry: notice.carry === true,
    })
    close()
  }
  const useOther = () => {
    if (!other) return
    close()
    // Round 1 (MINOR-3): it carries the conversation when the notice does (a
    // switch, a refused start that carried it, a kept tab); a new tab starts
    // a new one. The switch drops any wait the tab had.
    switchHelperTabAccount(session, other, restart, { carry: notice.carry === true })
  }
  // Round 2 (R2-1): Adopt the account's folder there (and, when the machine
  // says every such folder may be this computer's own, all of them): the
  // notice host asks first, naming them.
  const adopt = () => {
    const store = useHostAccountsStore.getState()
    const held = new Set(profiles.map((p) => p.id))
    const acc = store.byDid[notice.did]
    const more = acc?.mayBeEarlierInstall === true ? adoptableIds(acc, held) : []
    store.dropWaits(notice.sessionId)
    close()
    // Round 4 (R4-1, R4-3): the tab's next step depends on why it asked (a
    // refused start: Restart it; a Switch Account that did not happen: switch
    // it again), and holds only once its own account was adopted.
    store.askAdopt({
      did: notice.did, machineName: notice.machineName, profileIds: [...new Set([notice.profileId, ...more])],
      tab: { label: tabName, profileId: notice.profileId, kind: notice.kind },
    })
  }

  return (
    <DialogOverlay z="z-[60]" dim={0.5} testId="host-signin-notice">
      <DialogPanel width="w-[440px]" ariaLabel={notice.kind === 'launch' ? 'Choose how this session signs in' : 'Choose how this session switches account'}>
        <DialogHeader
          title={text.title}
          subtitle={<>
            Choose how{' '}
            <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{tabName}</span>
            {' '}signs in on {notice.machineName}
          </>}
        />
        <DialogBody>
          <p className="text-[12.5px] leading-snug" style={{ color: 'var(--text-primary)' }} data-testid="host-signin-question">{text.question}</p>
          <p className="text-[11.5px] leading-snug mt-1.5" style={{ color: 'var(--text-muted)' }} data-testid="host-signin-why">{text.why}</p>
          {!notice.elsewhere && (
            <div className="flex flex-col gap-1 mt-3">
              <DialogButton variant="primary" size="md" block onClick={signIn} testId="host-signin-here">Sign in on {notice.machineName}</DialogButton>
              <p className="text-[11.5px] leading-snug mx-0.5 mt-0.5 mb-2" style={{ color: 'var(--text-muted)' }}>{text.signInHint}</p>
            </div>
          )}
          {notice.adoptable && (
            <div className="flex flex-col gap-1 mt-3">
              <DialogButton variant="secondary" size="md" block onClick={adopt} testId="host-signin-adopt">Adopt on {notice.machineName}</DialogButton>
              <p className="text-[11.5px] leading-snug mx-0.5 mt-0.5 mb-2" style={{ color: 'var(--text-muted)' }}>Asks first, naming the folders. Only their marks change: nothing is signed in, out or removed.</p>
            </div>
          )}
          {problem && <p className="text-xs mb-2" role="alert" style={{ color: 'var(--status-danger)' }} data-testid="host-signin-problem">{problem}</p>}
          {others.length > 0 && (
            <div className="mt-1.5 pt-3 border-t" style={{ borderColor: 'var(--border-subtle)' }} data-testid="host-signin-other">
              <label className="block text-[11.5px] mb-1" style={{ color: 'var(--text-secondary)' }} htmlFor="host-signin-other-select">{text.otherLabel}</label>
              <div className="flex items-center gap-2">
                <select
                  id="host-signin-other-select"
                  value={other}
                  onChange={(e) => setOther(e.target.value)}
                  className={DIALOG_INPUT_CLASS.replace('w-full', 'flex-1 min-w-0')}
                  style={DIALOG_INPUT_STYLE}
                  data-testid="host-signin-other-select"
                >
                  {others.map((id) => <option key={id} value={id}>{`${nameOf(id)} ${MIDDOT} signed in on ${notice.machineName}`}</option>)}
                </select>
                <DialogButton variant="secondary" onClick={useOther} disabled={!other} testId="host-signin-use-other">Use this account</DialogButton>
              </div>
              <p className="text-[11.5px] leading-snug mt-1.5" style={{ color: 'var(--text-muted)' }}>{text.otherAfter}</p>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {/* Round 1 (MINOR-4): focus starts on Cancel, as LaunchAckConfirm's. */}
          <DialogButton variant="secondary" onClick={cancel} title={text.cancelTitle} testId="host-signin-cancel" autoFocus>Cancel</DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}

/** A tab whose wait for a sign-in is over: it starts again, or switches, on
 *  that account, once, and only while it is still the run that waited (and,
 *  to start again, still on that account). */
function HostRunner({ run }: { run: HostRun }) {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === run.sessionId) ?? null)
  const { restart } = useRestartSession(session, false)
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    useHostAccountsStore.getState().takeRun(run.id)
    if (!session || session.createdAt !== run.createdAt) return
    if (run.mode === 'restart') {
      if (session.profileId !== run.profileId) return
      restart(run.carry ? { profileId: run.profileId, carryConversation: true } : { profileId: run.profileId })
    } else {
      switchHelperTabAccount(session, run.profileId, restart, { carry: run.carry })
    }
  })
  return null
}

/**
 * Round 2 (R2-1): Adopt, asked first (from a machine's card, an account's
 * card or the notice): it names the accounts and what Adopt does and does
 * not do. Adopt runs phase 3's MACHINES_REMOTE_ACCOUNTS_ADOPT, says what it
 * did, and reads the machines' accounts again (main read the machine after it).
 */
function AdoptDialog({ ask }: { ask: HostAdoptAsk }) {
  useReturnFocus()
  const nameOf = useAccountName()
  const [busy, setBusy] = useState(false)
  const store = () => useHostAccountsStore.getState()
  const cancel = () => store().askAdopt(null)
  useDialogEscape(cancel, !busy)
  const run = async () => {
    const remote = window.electronAPI?.machines?.remote
    setBusy(true)
    let text = 'The app did not answer, so nothing was adopted.'
    try {
      if (typeof remote?.accountsAdopt === 'function') {
        const r = await remote.accountsAdopt({ did: ask.did, profileIds: ask.profileIds })
        text = r.message || (r.ok ? 'Adopted.' : 'Nothing was adopted.')
        // Round 3 (R3-2), round 4 (R4-1, R4-3, R4-4): what to do next.
        const next = adoptNextText(r.adopted, nameOf, ask.tab)
        if (next) text += ` ${next}`
      }
    } catch { /* text says the app did not answer */ }
    store().askAdopt(null)
    store().showMessage({ title: `Adopt on ${ask.machineName}`, text })
    await store().load()
  }
  return (
    <DialogOverlay z="z-[60]" dim={0.5} testId="host-adopt-confirm">
      <DialogPanel width="w-[440px]" ariaLabel={`Adopt on ${ask.machineName}`}>
        <DialogHeader title={`Adopt on ${ask.machineName}`} />
        <DialogBody><p className="text-[12.5px] leading-snug" style={{ color: 'var(--text-primary)' }}>{adoptConfirmText(ask.machineName, ask.profileIds.map(nameOf))}</p></DialogBody>
        <DialogFooter>
          <DialogButton variant="secondary" onClick={cancel} disabled={busy} testId="host-adopt-cancel" autoFocus>Cancel</DialogButton>
          <DialogButton variant="primary" onClick={() => { void run() }} disabled={busy} testId="host-adopt-run">{busy ? 'Adopting...' : 'Adopt'}</DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}

function MessageDialog({ title, text }: { title: string; text: string }) {
  useReturnFocus()
  const close = () => useHostAccountsStore.getState().showMessage(null)
  useDialogEscape(close)
  return (
    <DialogOverlay z="z-[60]" dim={0.5} testId="host-signin-message">
      <DialogPanel width="w-[420px]" ariaLabel={title}>
        <DialogHeader title={title} />
        <DialogBody><p className="text-[12.5px] leading-snug" style={{ color: 'var(--text-primary)' }}>{text}</p></DialogBody>
        <DialogFooter><DialogButton variant="primary" onClick={close} autoFocus>OK</DialogButton></DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}

/**
 * The app root's host: the listeners, the runners, and the head notice
 * (`suppressed` while a boot gate owns the screen, as AccountLaunchGate: the
 * queue waits, unanswered).
 */
export default function HostSignInNotice({ suppressed = false }: { suppressed?: boolean }) {
  useEffect(() => listenHostAccounts(), [])
  const notice = useHostAccountsStore((s) => s.notices[0] ?? null)
  const runs = useHostAccountsStore((s) => s.runs)
  const message = useHostAccountsStore((s) => s.message)
  const adoptAsk = useHostAccountsStore((s) => s.adoptAsk)
  return (
    <>
      {runs.map((r) => <HostRunner key={r.id} run={r} />)}
      {!suppressed && notice && <NoticeDialog key={`${notice.sessionId}:${notice.kind}:${notice.profileId}`} notice={notice} />}
      {!suppressed && !notice && adoptAsk && <AdoptDialog ask={adoptAsk} />}
      {!suppressed && !notice && !adoptAsk && message && <MessageDialog title={message.title} text={message.text} />}
    </>
  )
}
