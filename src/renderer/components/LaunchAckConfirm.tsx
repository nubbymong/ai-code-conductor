// src/renderer/components/LaunchAckConfirm.tsx
// WP2 commit 6: the small confirm asked before a launch on an unverified
// sign-in -- the provider's own home shared with other apps on this
// computer, or any account nobody has vouched for. Asked on EVERY launch of
// such a session that the New session dialog did not start itself (a
// restart, a reopen, a multi-spawn copy): main refuses the launch without
// that launch's own acknowledgement, and nothing stores one. Driven by
// launchAckStore; renders the head of its queue. Cancel starts nothing.
//
// Consent is never given by accident:
//  - each answer names the question it answers (its request id), so a click
//    meant for one launch cannot land on the next one in the queue, and a
//    question withdrawn under the pointer answers nothing;
//  - for a moment after a question appears, clicks and keys on it are
//    ignored, so a double activation (or a key held from the last answer)
//    never answers a question the user has not read;
//  - focus starts on Cancel, never on the consent button.
//
// O5 (2.1.1-beta.3, owner decision 2026-10-11): the Codex sign-in already on
// this computer is no longer offered. An account 2.1.1-beta.2 registered for
// it still launches after this confirm, which then says the sign-in is being
// retired, with Open Accounts instead: that answers only this question No
// (the launch starts nothing, as after Cancel) and opens Settings, Accounts,
// as the New session dialog's Settings, Accounts link does. Any other launch
// waiting in the queue is still asked, one at a time, as before.
//
// O5, for those beta.2 users (owner-agreed 2026-10-11): where the launch
// offers it (`offerSwitch`: a session launch, not an agent retry), the
// confirm also lists the other Codex accounts, by the New session dialog's
// picker rule (utils/launchAccount.ts switchAccountOptions), with "Use this
// account". That answers the question with the account picked (once armed,
// like every answer): the launch moves the session, and a saved config that
// used this sign-in, to it and starts there (TerminalView). A restored tab
// launched that way starts without its conversation (an exact resume looks
// only in the picked account's own; nothing is carried at a launch), so the
// confirm says so and names the way that keeps it: Launch here, then Switch
// account on the running session, which carries it (P3.6).
import React, { useLayoutEffect, useRef, useState } from 'react'
import { useLaunchAckStore, type LaunchAckAnswer } from '../stores/launchAckStore'
import { externalSignInRetiring, useProviderAccountsStore } from '../stores/providerAccountsStore'
import { switchAccountOptions } from '../utils/launchAccount'
import { DialogOverlay, DialogPanel, DialogHeader, DialogBody, DialogFooter, DialogButton, useDialogEscape, DIALOG_INPUT_CLASS, DIALOG_INPUT_STYLE } from './ui/Dialog'

/** How long a new question ignores activations. */
export const LAUNCH_ACK_ARM_MS = 300

/** O5: under the other-account picker, what moves. A config that names
 *  another account, or no saved config at all, has nothing to move. */
export const LAUNCH_ACK_SWITCH_NOTE = 'The session starts on that account. A saved config that used this sign-in moves to it too.'
/** O5: added when the launch resumes one exact conversation (a restored
 *  tab): the move does not bring it, and the way that does. */
export const LAUNCH_ACK_SWITCH_CONVERSATION_NOTE = "This tab's conversation does not come along: it stays with this computer's sign-in. To keep it, choose Launch, then use Switch account on the running session, which carries the conversation over."

/** `suppressed`: a boot gate owns the screen. The queue is untouched; the
 *  awaiting launch keeps waiting and the confirm shows once the gates clear
 *  (the same rule as AccountLaunchGate). */
export default function LaunchAckConfirm({ suppressed = false }: { suppressed?: boolean }) {
  const pending = useLaunchAckStore((s) => s.queue[0] ?? null)
  const answer = useLaunchAckStore((s) => s.answer)
  const switchAccount = useLaunchAckStore((s) => s.switchAccount)
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const shown = !!pending && !suppressed
  const requestId = pending?.requestId
  // The account picked to launch on instead, per question: a new question
  // starts on the first one offered.
  const [picked, setPicked] = useState<{ requestId: number; accountId: string } | null>(null)
  // When the question on screen was shown, on the MONOTONIC clock: a wall
  // clock stepped backward (NTP after sleep, a VM resume) would otherwise
  // strand this question, and everything queued behind it, for as long as
  // the step. A reading earlier than `shownAt` cannot happen on a monotonic
  // clock; if it ever does, the question is armed rather than stranded.
  const shownAt = useRef<number | null>(null)
  // Layout effect: armed before the browser can deliver the next input.
  useLayoutEffect(() => {
    if (shown) shownAt.current = performance.now()
  }, [shown, requestId])
  /** False when the question is not armed yet, so nothing was answered. */
  const reply = (id: number, a: LaunchAckAnswer): boolean => {
    const at = shownAt.current
    if (at !== null) {
      const since = performance.now() - at
      if (since >= 0 && since < LAUNCH_ACK_ARM_MS) return false
    }
    if (typeof a === 'object') switchAccount(id, a.switchTo)
    else answer(id, a)
    return true
  }
  useDialogEscape(() => { if (requestId !== undefined) reply(requestId, false) }, shown)
  if (!pending || suppressed) return null

  const id = pending.requestId
  const sessionName = pending.sessionLabel || 'this session'
  const who = pending.email ? ` (${pending.email})` : ''
  // A Cloud Agent's Retry asks the same question about a run, not a session
  // (P4.11): its title, verb and buttons say so.
  const agent = pending.retryAgent === true
  const verb = agent ? `Retry ${sessionName}` : 'Launch'
  const question = pending.unknown
    ? <>{agent ? verb : `Launch ${sessionName}`} on its saved Codex account?</>
    : pending.external
      ? <>{verb} with the Codex sign-in already on this computer{who}?</>
      : <>{verb} with {pending.accountName}{who}? Its sign-in is not verified.</>
  const why = pending.unknown
    ? 'This app could not read your accounts, so it cannot tell whether this sign-in needs confirming. Launching confirms it for this launch only.'
    : pending.external
      ? 'This app did not create that sign-in and cannot check who it belongs to, so every launch asks.'
      : 'This app cannot check who this account belongs to, so every launch asks.'
  // Only for the sign-in already on this computer, as main knows it.
  const retiring = pending.external && !pending.unknown
  /** Open Accounts instead: this question is answered No (only once armed,
   *  like Cancel), then Settings, Accounts opens. Nothing else is answered. */
  const openAccountsInstead = () => {
    if (!reply(id, false)) return
    window.dispatchEvent(new CustomEvent('app:openSettings', { detail: { tab: 'accounts' } }))
  }
  // O5: another Codex account instead, where this launch offers it.
  const others = retiring && pending.offerSwitch === true ? switchAccountOptions(snapshot, 'codex', pending.accountId) : []
  const choosable = others.filter((o) => !o.disabled)
  const chosen = picked?.requestId === id && choosable.some((o) => o.id === picked.accountId) ? picked.accountId : choosable[0]?.id ?? ''
  const useOther = () => { if (chosen) reply(id, { switchTo: chosen }) }
  return (
    <DialogOverlay z="z-[60]" dim={0.5} testId="launch-ack-overlay">
      <DialogPanel key={id} width="w-[440px]" labelledBy="launch-ack-title" describedBy="launch-ack-question" testId="launch-ack-confirm">
        <DialogHeader titleId="launch-ack-title" title={agent ? 'Retry agent' : 'Start session'} subtitle={<>Confirm the sign-in for <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{sessionName}</span></>} />
        <DialogBody>
          <p id="launch-ack-question" className="text-[12.5px] leading-snug" style={{ color: 'var(--text-primary)' }} data-testid="launch-ack-question">
            {question}
          </p>
          <p className="text-[11.5px] leading-snug mt-2" style={{ color: 'var(--text-muted)' }}>{why}</p>
          {retiring && (
            <p className="text-[11.5px] leading-snug mt-2" style={{ color: 'var(--text-muted)' }} data-testid="launch-ack-retiring">
              {externalSignInRetiring({ displayName: 'Codex' })}{' '}
              <button
                type="button"
                className="underline"
                style={{ color: 'var(--brand)' }}
                onClick={openAccountsInstead}
                title={agent ? 'Do not retry this agent, and open Settings, Accounts' : 'Do not start this session, and open Settings, Accounts'}
                data-testid="launch-ack-open-accounts"
              >
                Open Accounts instead
              </button>
            </p>
          )}
          {choosable.length > 0 && (
            <div className="mt-3" data-testid="launch-ack-switch">
              <label htmlFor="launch-ack-account" className="block text-[11.5px] mb-1" style={{ color: 'var(--text-secondary)' }}>
                Or start it on another Codex account
              </label>
              <div className="flex items-center gap-2">
                <select
                  id="launch-ack-account"
                  value={chosen}
                  onChange={(e) => setPicked({ requestId: id, accountId: e.target.value })}
                  className={DIALOG_INPUT_CLASS.replace('w-full', 'flex-1 min-w-0')}
                  style={DIALOG_INPUT_STYLE}
                  data-testid="launch-ack-account-select"
                >
                  {others.map((o) => <option key={o.id} value={o.id} disabled={o.disabled}>{o.label}</option>)}
                </select>
                {/* What moves, and for a restored tab what does not, is said
                    to a keyboard and screen reader user on the button too:
                    the notes below are plain text the dialog's description
                    does not name. */}
                <DialogButton
                  variant="secondary"
                  onClick={useOther}
                  testId="launch-ack-use-other"
                  title="Start this session on the account picked; a saved config that used this sign-in moves to it too"
                  aria-describedby={pending.resumesConversation === true ? 'launch-ack-switch-note launch-ack-switch-conversation' : 'launch-ack-switch-note'}
                >
                  Use this account
                </DialogButton>
              </div>
              <p id="launch-ack-switch-note" className="text-[11.5px] leading-snug mt-1.5" style={{ color: 'var(--text-muted)' }} data-testid="launch-ack-switch-note">
                {LAUNCH_ACK_SWITCH_NOTE}
              </p>
              {pending.resumesConversation === true && (
                <p id="launch-ack-switch-conversation" className="text-[11.5px] leading-snug mt-1.5" style={{ color: 'var(--text-secondary)' }} data-testid="launch-ack-switch-conversation">
                  {LAUNCH_ACK_SWITCH_CONVERSATION_NOTE}
                </p>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogButton variant="secondary" onClick={() => reply(id, false)} testId="launch-ack-cancel" title={agent ? 'Do not retry this agent' : 'Do not start this session'} autoFocus>
            Cancel
          </DialogButton>
          <DialogButton variant="primary" onClick={() => reply(id, true)} testId="launch-ack-launch">
            {agent ? 'Retry' : 'Launch'}
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
