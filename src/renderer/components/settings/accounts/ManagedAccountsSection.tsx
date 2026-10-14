// WP2 commit 6 (F4, Codex card): a provider whose accounts this app manages
// itself. One row per account, the reviewer line, setups an interruption
// left behind, and Add account. The provider's own sign-in on this computer
// is never offered (O5, owner decision 2026-10-11): an account 2.1.1-beta.2
// registered for it keeps its row, which says it is being retired. While the
// provider is off, the accounts are listed but not managed. P3.2: each row
// is the shared AccountRow (the chip
// opens the identity editor; "N running"; a refused inactivate or archive
// names the sessions holding the account, with Go to), and archived accounts
// are listed under "Archived (N)" with Restore (design 5.3), all but the
// one for this computer's own sign-in, which is retired.
import React, { useEffect, useRef, useState } from 'react'
import type { AccountView, AccountsResult, AccountsSnapshot, KnownAuthState, PendingSetupView, ProviderId, ProviderInstallationView, SignInMethod } from '../../../../shared/providers'
import type { IdentityColorKey } from '../../../../shared/identity-colors'
import { resolveIdentityColor } from '../../../../shared/identity-colors'
import {
  useProviderAccountsStore, providerAccountActions, providerView, selectProviderAccounts, accountDisplayName, canOfferMakeReviewer,
  showsReviewerBadge, accountFailureText, accountState, signInMethodLabel, externalHomeFolder, canOfferSignInAgain,
  externalHomeLabelInSentence, accountNameInSentence,
  canOfferMakeInactive, canOfferMakeActive, canOfferArchive, canOfferCheckSignIn, signInCheckText, externalSignInHint, externalSignInRetiring,
  externalSignInRetired, selectArchivedAccounts, canOfferRestore, linkedAccounts, linkedAccountLabel, blockerSessions, sessionTitle, unnamedHolders, oldSignInText,
  confirmEachLaunchWhy,
} from '../../../stores/providerAccountsStore'
import { useSessionStore } from '../../../stores/sessionStore'
import { useResolvedTheme } from '../../../hooks/useThemeController'
import { ProviderMark } from '../../sidebar/Badges'
import { Section } from '../../SettingsPage'
import { DialogHeader, DialogBody, DialogFooter, DialogButton, useDialogEscape } from '../../ui/Dialog'
import { Pill, StatusText, MutedLine, ErrorLine, RowButton, ReviewerLineBlock, AccountsModal, RunningPill, noBreakHyphens } from './accounts-ui'
import { AccountRow, AccountChip, LinkedLine, BlockerLine } from './AccountRow'
import { IdentityEditor } from './IdentityEditor'
import { RowMenu, type MenuItem } from '../../ui/RowMenu'
import { AddProviderAccountDialog, SignInAgainDialog } from './AddProviderAccountDialog'
import { useCodexWebStore } from '../../../stores/codexWebStore'
import { isWebSessionAccountId } from '../../../../shared/account-web-session'

type ExternalAck = 'logout' | 'archive'

/** Signing out of, or archiving, the provider's own shared home reaches
 *  beyond this app: the user says yes to that first. Archiving it is final
 *  (O5): the app no longer uses that sign-in, so its archived row has no
 *  Restore and main refuses one; the confirmation says so. Sign in again is
 *  not offered on it any more (O5, #196). */
function ExternalAckDialog({ kind, provider, onConfirm, onCancel }: {
  kind: ExternalAck
  provider: ProviderInstallationView
  onConfirm: () => void
  onCancel: () => void
}) {
  useDialogEscape(onCancel)
  const folder = useProviderAccountsStore((s) => externalHomeFolder(s.snapshot, provider.providerId))
  const home = externalHomeLabelInSentence(provider, folder)
  const title = kind === 'logout' ? `Sign out of ${home}?` : `Archive ${home}?`
  return (
    <AccountsModal labelledBy="external-ack-title" role="alertdialog" testId="external-ack-dialog" overlayTestId="external-ack-overlay">
      <DialogHeader title={title} titleId="external-ack-title" onClose={onCancel} />
      <DialogBody>
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }} data-testid="external-ack-text">
          {kind === 'logout'
            ? `This sign-in is shared with other apps on this computer, including the ${provider.displayName} CLI itself. Signing out here signs them out too.`
            : `Archiving is final: this account cannot be restored, because this app no longer uses the ${provider.displayName} sign-in already on this computer. Archiving only forgets that sign-in in this app: it is shared with other apps on this computer, including the ${provider.displayName} CLI, and it stays signed in for them.`}
        </p>
      </DialogBody>
      <DialogFooter>
        <DialogButton variant="ghost" onClick={onCancel} testId="external-ack-cancel" data-autofocus="">Cancel</DialogButton>
        <DialogButton variant={kind === 'archive' ? 'primary' : 'danger'} onClick={onConfirm} testId="external-ack-confirm">
          {kind === 'logout' ? 'Sign out' : 'Archive'}
        </DialogButton>
      </DialogFooter>
    </AccountsModal>
  )
}

function ManagedAccountRow({ account, provider, snapshot, onAddAccount }: {
  account: AccountView
  provider: ProviderInstallationView
  snapshot: AccountsSnapshot
  /** Sign in again handing over to Add account (the section owns that
   *  dialog, so it can leave the setup being named out of Unfinished setups). */
  onAddAccount: (d: AddAccountDialogState) => void
}) {
  const theme = useResolvedTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ack, setAck] = useState<ExternalAck | null>(null)
  const [signingInAgain, setSigningInAgain] = useState(false)
  const [checked, setChecked] = useState<KnownAuthState | null>(null)
  const [editing, setEditing] = useState(false)
  const [blocker, setBlocker] = useState<{ verb: string; sessions: { id: string; title: string }[]; more: number } | null>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const id = account.id
  const manageable = provider.enabled
  const name = accountDisplayName(snapshot, account)
  // The same name inside a sentence (this computer's own sign-in in lower case).
  const inSentence = accountNameInSentence(snapshot, account)
  const email = account.providerLabel && account.providerLabel !== name ? account.providerLabel : null
  const method = signInMethodLabel(account, provider)
  const state = accountState(account)
  const blocked = account.operationalState === 'blocked'
  // This computer's own sign-in is the provider CLI's to make: the app never
  // signs in to it, so a signed-out or expired one says how to fix it.
  const externalHint = manageable ? externalSignInHint(account, provider) : null
  // WP2 PR 4, P4.6 (row 58): a Codex account's own chatgpt.com web session,
  // offered while the provider is on and the account is not archived. The
  // CLI's Sign out leaves it alone (as Claude's CLI sign-out leaves claude.ai);
  // Archive clears it first. Only a registry account id (the one id class the
  // codexWeb channels take) ever has one.
  const webApplies = manageable && account.providerId === 'codex' && account.lifecycle !== 'archived' && isWebSessionAccountId(id)
  const web = useCodexWebStore((s) => s.byAccount[id])
  const webSigningIn = useCodexWebStore((s) => s.signingIn === id)
  const webError = useCodexWebStore((s) => s.errors[id] ?? null)
  useEffect(() => {
    if (webApplies) void useCodexWebStore.getState().refresh(id)
  }, [webApplies, id])
  const cannotReview = account.external || account.unverified
  const identity = snapshot.identities.find((i) => i.id === account.identityId)
  const tint = identity ? resolveIdentityColor(identity.colourKey as IdentityColorKey, theme) : 'var(--text-secondary)'

  // `verb` names a lifecycle change: refused for the sessions holding the
  // account, the row names them with Go to rather than a count.
  const run = async (op: () => Promise<AccountsResult>, verb?: string) => {
    setBusy(true)
    setError(null)
    setBlocker(null)
    setChecked(null)
    let r: AccountsResult
    try {
      r = await op()
    } catch {
      setBusy(false)
      setError('That did not work; try again.')
      if (verb === 'archived' && webApplies) void useCodexWebStore.getState().refresh(id)
      return
    }
    setBusy(false)
    // An archive clears the chatgpt.com sign-in before it changes anything, and
    // may still be refused after that: the row reads the web status afresh.
    if (verb === 'archived' && webApplies) void useCodexWebStore.getState().refresh(id)
    if (r.ok) return
    const holding = verb && r.code === 'consumers' ? blockerSessions(useSessionStore.getState().sessions, r.sessions) : []
    if (holding.length) {
      // Main counts what no named session accounts for (a session and its
      // own review are one name); the named sessions not open here add to it.
      const more = unnamedHolders(r.sessions, holding, r.unnamed)
      setBlocker({ verb: verb!, sessions: holding.map((x) => ({ id: x.id, title: sessionTitle(x) })), more })
    } else setError(accountFailureText(r, account))
  }

  // A check's answer stands only while the record agrees with it: once the
  // recorded sign-in state moves on (a Sign in again that worked, a sign-out)
  // or the account is blocked, it is stale; so is it once the account's
  // lifecycle changes. The answer can land before the snapshot that records
  // it, so it is dropped only on a change, never for merely being ahead.
  useEffect(() => {
    setChecked((c) => (c !== null && (c !== account.lastKnownAuthState || account.operationalState === 'blocked') ? null : c))
  }, [account.lastKnownAuthState, account.operationalState])
  const lifecycleSeen = useRef(account.lifecycle)
  useEffect(() => {
    if (lifecycleSeen.current === account.lifecycle) return
    lifecycleSeen.current = account.lifecycle
    setChecked(null)
  }, [account.lifecycle])

  // "Check sign-in" (6g: what Test connection did in the retired Codex
  // settings tab, per account): the provider's own status check in this
  // account's realm. Its answer is shown here; the row's state follows the
  // snapshot main pushes once it has recorded it.
  const checkSignIn = async () => {
    setBusy(true)
    setError(null)
    setChecked(null)
    const r = await providerAccountActions.checkSignIn(id)
    setBusy(false)
    if (r.ok) setChecked(r.state)
    else setError(accountFailureText(r, account))
  }

  const items: MenuItem[] = []
  if (manageable) {
    // The registry makes only an active, unblocked account the default.
    if (!account.isProviderDefault && account.lifecycle === 'active' && !blocked) {
      items.push({ key: 'make-default', label: 'Make default', onSelect: () => { void run(() => providerAccountActions.setDefault(id)) } })
    }
    if (canOfferMakeReviewer(snapshot, account)) {
      items.push({ key: 'make-reviewer', label: 'Make reviewer', onSelect: () => { void run(() => providerAccountActions.setReviewerDefault({ providerId: account.providerId, accountId: id })) } })
    }
    // Signed in too: main then signs in to a new folder and moves the
    // account there only once that sign-in is verified (design 9.2). Never
    // on this computer's own sign-in (retired, O5; canOfferSignInAgain).
    if (canOfferSignInAgain(account)) {
      items.push({ key: 'sign-in-again', label: 'Sign in again', onSelect: () => { setError(null); setChecked(null); setSigningInAgain(true) } })
    }
    if (canOfferCheckSignIn(account, provider)) {
      items.push({ key: 'check-sign-in', label: 'Check sign-in', onSelect: () => { void checkSignIn() } })
    }
    // Sign out. On this computer's own sign-in it signs the provider's CLI
    // out machine-wide, so there it is named for that and comes last, after
    // the app-only actions (Make inactive, then Archive), behind its warning
    // (#196: it used to be the first removal-like action on that row).
    const signOut: MenuItem | null = account.lastKnownAuthState !== 'signed-out' && provider.logout.enabled
      ? account.external
        ? { key: 'sign-out', label: `Sign ${provider.displayName} out on this computer...`, onSelect: () => { setAck('logout') } }
        : { key: 'sign-out', label: 'Sign out', onSelect: () => { void run(() => providerAccountActions.logout({ accountId: id })) } }
      : null
    if (signOut && !account.external) items.push(signOut)
    // P4.6: the account's chatgpt.com web session (the sign-in window).
    if (webApplies) {
      const webItems: MenuItem[] = []
      // While the records were written by a newer version of the app the
      // surface is inert: no Sign in (the row says why); Sign out stays.
      if (!web?.unavailable) {
        webItems.push({
          key: 'chatgpt-sign-in',
          label: web?.status === 'active' ? 'Sign in to chatgpt.com again' : 'Sign in to chatgpt.com',
          onSelect: () => { void useCodexWebStore.getState().signIn(id) },
        })
      }
      if (web?.status === 'active' || web?.status === 'expired' || web?.unavailable) {
        webItems.push({ key: 'chatgpt-sign-out', label: 'Sign out of chatgpt.com', onSelect: () => { void useCodexWebStore.getState().signOut(id) } })
      }
      if (items.length && webItems.length) webItems[0] = { ...webItems[0], separated: true }
      items.push(...webItems)
    }
    const lifecycle: MenuItem[] = []
    if (canOfferMakeInactive(snapshot, account)) {
      lifecycle.push({ key: 'make-inactive', label: 'Make inactive', onSelect: () => { void run(() => providerAccountActions.setLifecycle({ accountId: id, lifecycle: 'inactive' }), 'made inactive') } })
    }
    if (canOfferMakeActive(account)) {
      lifecycle.push({ key: 'make-active', label: 'Make active', onSelect: () => { void run(() => providerAccountActions.setLifecycle({ accountId: id, lifecycle: 'active' })) } })
    }
    if (canOfferArchive(account)) {
      lifecycle.push({
        key: 'archive',
        label: 'Archive',
        onSelect: () => { if (account.external) setAck('archive'); else void run(() => providerAccountActions.setLifecycle({ accountId: id, lifecycle: 'archived' }), 'archived') },
      })
    }
    if (lifecycle.length && items.length) lifecycle[0] = { ...lifecycle[0], separated: true }
    items.push(...lifecycle)
    if (signOut && account.external) items.push({ ...signOut, separated: items.length > 0 })
  }

  const confirmAck = () => {
    const kind = ack
    setAck(null)
    if (kind === 'logout') void run(() => providerAccountActions.logout({ accountId: id, acknowledgeExternal: true }))
    else if (kind === 'archive') void run(() => providerAccountActions.setLifecycle({ accountId: id, lifecycle: 'archived', acknowledgeExternal: true }), 'archived')
  }

  const links = linkedAccounts(snapshot, account)
  return (
    <AccountRow
      testId={`provider-account-row-${id}`}
      chip={(
        <AccountChip
          letter={account.external ? '~' : (name.charAt(0).toUpperCase() || '?')}
          tint={tint}
          onOpen={manageable ? () => setEditing((e) => !e) : undefined}
          open={editing}
          label={`Edit ${inSentence}: name, colour, group and linked accounts`}
          testId={`account-chip-${id}`}
          chipRef={chipRef}
        />
      )}
      name={name}
      nameMuted={account.lifecycle !== 'active'}
      nameTestId={`account-name-${id}`}
      secondary={email && <span className="font-mono text-[12px] truncate max-w-full" style={{ color: 'var(--text-secondary)' }} title={email}>{email}</span>}
      linked={links.map((a) => (
        <LinkedLine
          key={a.id}
          providerId={a.providerId}
          providerName={providerView(snapshot, a.providerId)?.displayName ?? a.providerId}
          label={linkedAccountLabel(snapshot, a)}
          testId={`account-linked-${id}-${a.id}`}
        />
      ))}
      // Neither a plan nor a method (this computer's own sign-in before a
      // usage read names its plan): no plan cell, so the name takes its track.
      planCell={account.planLabel || method ? (
        <div className="flex flex-col items-start gap-0.5 min-w-0" data-testid={`account-plan-cell-${id}`}>
          {account.planLabel && <span className="truncate max-w-full" style={{ color: 'var(--text-primary)' }} data-testid={`account-plan-${id}`}>{account.planLabel}</span>}
          {method && <MutedLine testId={`account-method-${id}`}>{noBreakHyphens(method)}</MutedLine>}
        </div>
      ) : null}
      badges={(
        <>
          {account.isProviderDefault && <Pill tone="default" testId={`account-badge-default-${id}`}>Default</Pill>}
          {showsReviewerBadge(account) && <Pill tone="reviewer" testId={`account-badge-reviewer-${id}`}>Reviewer</Pill>}
          {cannotReview && <Pill tone="warn" testId={`account-badge-confirm-${id}`} title={`Cannot run reviews: ${confirmEachLaunchWhy(account)}.`} describedBy={`account-confirm-why-${id}`}>Confirm each launch</Pill>}
          {cannotReview && <MutedLine testId={`account-no-reviews-${id}`}>Cannot run reviews</MutedLine>}
          {/* The pill's reason for screen reader users too: a pill takes no
              focus, so its title reaches only a mouse (#181). What reaches a
              reader in browse mode is this sr-only sentence, read after the
              visible Cannot run reviews line as its reason (the pill's
              aria-describedby names it as well, though a reader rarely
              announces a description on an element that takes no focus). A
              sighted keyboard user sees that visible line, not the reason. */}
          {cannotReview && <span id={`account-confirm-why-${id}`} className="sr-only" data-testid={`account-confirm-why-${id}`}>{`${confirmEachLaunchWhy(account).replace(/^./, (c) => c.toUpperCase())}.`}</span>}
          {account.lifecycle === 'inactive' && <Pill tone="muted" testId={`account-badge-inactive-${id}`}>Inactive</Pill>}
        </>
      )}
      stateCell={(
        <>
          <StatusText tone={state.tone} testId={`account-state-${id}`}>{state.text}</StatusText>
          {/* Never on a blocked row, whichever lands first: the answer or the
              snapshot that blocked the account. */}
          {checked && !blocked && <MutedLine testId={`account-checked-${id}`}>{signInCheckText(checked)}</MutedLine>}
          {account.signingIn && <MutedLine testId={`account-signing-in-${id}`}>Signing in now</MutedLine>}
          {webApplies && webSigningIn && (
            <MutedLine testId={`account-web-${id}`}>
              chatgpt.com: finish the sign-in in its window. It closes by itself once you are signed in.{' '}
              <RowButton onClick={() => { void useCodexWebStore.getState().cancel(id) }} testId={`account-web-cancel-${id}`}>Cancel</RowButton>
            </MutedLine>
          )}
          {webApplies && !webSigningIn && web?.status === 'active' && (
            <MutedLine testId={`account-web-${id}`}>{web.accountEmail ? `chatgpt.com: signed in as ${web.accountEmail}` : 'chatgpt.com: signed in'}</MutedLine>
          )}
          {webApplies && !webSigningIn && web?.unavailable && (
            <MutedLine testId={`account-web-${id}`}>{`chatgpt.com: ${web.unavailable}`}</MutedLine>
          )}
          {webApplies && !webSigningIn && web?.status === 'expired' && (
            <MutedLine testId={`account-web-${id}`}>chatgpt.com: the sign-in has expired. Sign in again.</MutedLine>
          )}
          {externalHint && <MutedLine testId={`account-external-hint-${id}`}>{externalHint}</MutedLine>}
          {/* O5: the account 2.1.1-beta.2 registered for this computer's own
              sign-in keeps working, and says how to move off it: Add
              account opens the section's own add-account dialog. */}
          {account.external && manageable && (
            <MutedLine testId={`account-external-retiring-${id}`}>
              {externalSignInRetiring(provider, account)}{' '}
              <RowButton onClick={() => onAddAccount({})} testId={`account-external-retiring-add-${id}`}>Add {provider.displayName} account</RowButton>
            </MutedLine>
          )}
          {account.oldSignInLeft && !blocked && manageable && <MutedLine testId={`account-old-sign-in-${id}`}>{oldSignInText(account.oldSignInLeft, provider.displayName)}</MutedLine>}
          <RunningPill count={account.runningSessions} testId={`account-running-${id}`} />
          {blocked && manageable && (
            <RowButton onClick={() => { void run(() => providerAccountActions.reconcileSignIn(id)) }} disabled={busy} testId={`account-reconcile-${id}`}>
              This is still my account
            </RowButton>
          )}
        </>
      )}
      menu={(
        <RowMenu
          items={items}
          label={`Actions for ${inSentence}`}
          disabled={busy}
          testId={`account-menu-btn-${id}`}
          itemTestId={(key) => `account-menu-${key}-${id}`}
        />
      )}
    >
      {error && <ErrorLine testId={`account-error-${id}`}>{error}</ErrorLine>}
      {webApplies && webError && <ErrorLine testId={`account-web-error-${id}`}>chatgpt.com: {webError}</ErrorLine>}
      {blocker && <BlockerLine name={name} verb={blocker.verb} sessions={blocker.sessions} more={blocker.more} testId={`account-blocker-${id}`} />}
      {ack && <ExternalAckDialog kind={ack} provider={provider} onConfirm={confirmAck} onCancel={() => setAck(null)} />}
      {signingInAgain && (
        <SignInAgainDialog
          provider={provider}
          account={account}
          name={name}
          nameInSentence={inSentence}
          onClose={() => setSigningInAgain(false)}
          onNewAccount={(initialMethod) => { setSigningInAgain(false); onAddAccount({ initialMethod }) }}
          onSeparate={(resume) => onAddAccount({ resume })}
        />
      )}
      {editing && manageable && <IdentityEditor anchor={chipRef} account={account} snapshot={snapshot} onClose={() => setEditing(false)} testId={`identity-editor-${id}`} />}
    </AccountRow>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "12 Sep": the day it was archived, in local time. */
export function archivedOn(at: number): string {
  const d = new Date(at)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** One archived account under "Archived (N)": its name, how it signed in,
 *  when it was archived, and Restore (it comes back inactive; Make active
 *  then checks it). The account 2.1.1-beta.2 registered for this computer's
 *  own sign-in has no Restore (O5): its row says why instead. */
function ArchivedAccountRow({ account, provider, snapshot }: { account: AccountView; provider: ProviderInstallationView; snapshot: AccountsSnapshot }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = accountDisplayName(snapshot, account)
  const method = signInMethodLabel(account, provider)
  const restore = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await providerAccountActions.restore(account.id)
      if (!r.ok) setError(accountFailureText(r))
    } catch {
      setError('That did not work; try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pl-[38px] pt-2" data-testid={`archived-account-${account.id}`}>
      <div className="flex items-center gap-3 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
        <span className="truncate" title={name}>{name}</span>
        {method && <span className="truncate">{noBreakHyphens(method)}</span>}
        {account.archivedAt !== undefined && <span className="truncate" data-testid={`archived-when-${account.id}`}>archived {archivedOn(account.archivedAt)}</span>}
        {provider.enabled && canOfferRestore(account) && (
          <span className="ml-auto"><RowButton onClick={() => { void restore() }} disabled={busy} testId={`archived-restore-${account.id}`}>Restore</RowButton></span>
        )}
      </div>
      {account.external && <MutedLine testId={`archived-retired-${account.id}`}>{externalSignInRetired(provider)}</MutedLine>}
      {error && <ErrorLine testId={`archived-error-${account.id}`}>{error}</ErrorLine>}
    </div>
  )
}

/** The section's Add account dialog: a new account (from Add account, or a
 *  sign in again answered "different or unsure", with its method), or a
 *  setup resumed (from Unfinished setups, or a sign in again main found to
 *  be someone else, at its name). */
interface AddAccountDialogState { resume?: PendingSetupView; initialMethod?: SignInMethod }

function methodWord(m: PendingSetupView['method']): string {
  switch (m) {
    case 'browser': return 'Browser sign-in'
    case 'device': return 'Device code sign-in'
    case 'apiKey': return 'API key sign-in'
    case 'external': return "This computer's own sign-in"
    default: return 'Sign-in'
  }
}

function PendingSetupRow({ setup, manageable, onResume, replacesName }: { setup: PendingSetupView; manageable: boolean; onResume: () => void; replacesName?: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const discard = async () => {
    setBusy(true)
    setError(null)
    const r = await providerAccountActions.abandonSetup(setup.accountId)
    setBusy(false)
    if (!r.ok) setError(accountFailureText(r))
  }
  // A sign in again of an existing account (design 9.2) is never finished as
  // a new account: Discard it, then sign in again.
  const again = setup.replacesAccountId !== undefined
  // One being discarded is finished only by Discard.
  const discarding = setup.state === 'discarding'
  // Its Discard is running now (a Cancel's, or this row's): shown as running
  // until it ends, never offered again meanwhile.
  const discardRunning = setup.discardRunning === true
  const resumable = manageable && !setup.external && !setup.signingIn && !again && !discarding && !discardRunning
  return (
    <div className="py-2" style={{ borderTop: '1px solid var(--border-subtle)' }} data-testid={`pending-setup-${setup.accountId}`}>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px]" style={{ color: 'var(--text-primary)' }}>{again ? `Sign in again${replacesName ? ` for ${replacesName}` : ''}, not finished` : `${methodWord(setup.method)}, not finished`}</div>
          <MutedLine>
            {setup.signingIn ? 'Signing in now'
              : discardRunning ? 'Discarding now'
              : discarding ? 'Discarding did not finish; Discard finishes it'
              : again ? 'Discard it, then sign in again'
                : setup.state === 'credentials-written' ? 'Signed in; it still needs a name' : 'Started ' + new Date(setup.createdAt).toLocaleString()}
          </MutedLine>
        </div>
        {resumable && <RowButton onClick={onResume} disabled={busy} testId={`pending-setup-resume-${setup.accountId}`}>Resume</RowButton>}
        {manageable && !discardRunning && <RowButton onClick={() => { void discard() }} disabled={busy || setup.signingIn} testId={`pending-setup-discard-${setup.accountId}`}>Discard</RowButton>}
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
    </div>
  )
}

export function ManagedAccountsSection({ providerId }: { providerId: ProviderId }) {
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const [dialog, setDialog] = useState<AddAccountDialogState | null>(null)
  // P4.6: a chatgpt.com sign-in main is running (this page reopened, or the
  // window reloaded) shows on its row again, with its Cancel.
  useEffect(() => {
    if (providerId === 'codex') void useCodexWebStore.getState().restore()
  }, [providerId])
  const provider = providerView(snapshot, providerId)
  if (!snapshot || !provider || !provider.managedAccounts) return null

  const accounts = selectProviderAccounts(snapshot, providerId)
  const archived = selectArchivedAccounts(snapshot, providerId)
  // A sign in again being run by its own dialog is that dialog's to show.
  // So is a setup its Add account dialog is naming or resuming now.
  const pending = snapshot.pendingSetups.filter((p) => p.providerId === providerId && !(p.replacesAccountId !== undefined && p.signingIn) && p.accountId !== dialog?.resume?.accountId)
  const manageable = provider.enabled

  return (
    <Section title={provider.displayName} mark={<ProviderMark providerId={providerId} size={16} />} testId={`provider-accounts-${providerId}`}>
      <ReviewerLineBlock providerId={providerId} />
      {!manageable && (
        <MutedLine testId={`provider-off-note-${providerId}`}>Turn {provider.displayName} on to manage its accounts.</MutedLine>
      )}
      <div>
        {accounts.map((a) => <ManagedAccountRow key={a.id} account={a} provider={provider} snapshot={snapshot} onAddAccount={setDialog} />)}
      </div>
      {archived.length > 0 && (
        <div className="pt-2.5" style={{ borderTop: '1px solid var(--border-subtle)' }} data-testid={`archived-accounts-${providerId}`}>
          <div className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>Archived ({archived.length})</div>
          {archived.map((a) => <ArchivedAccountRow key={a.id} account={a} provider={provider} snapshot={snapshot} />)}
        </div>
      )}
      {pending.length > 0 && (
        <div data-testid={`pending-setups-${providerId}`}>
          <div className="text-[11.5px] font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>Unfinished setups</div>
          {pending.map((p) => {
            const replaces = p.replacesAccountId !== undefined ? snapshot.accounts.find((a) => a.id === p.replacesAccountId) : undefined
            return <PendingSetupRow key={p.accountId} setup={p} manageable={manageable} onResume={() => setDialog({ resume: p })} {...(replaces ? { replacesName: accountDisplayName(snapshot, replaces) } : {})} />
          })}
        </div>
      )}
      {manageable && (
        <div className="pt-1">
          <DialogButton variant="secondary" onClick={() => setDialog({})} testId={`add-provider-account-${providerId}`}>
            Add {provider.displayName} account
          </DialogButton>
        </div>
      )}
      {dialog && <AddProviderAccountDialog provider={provider} {...(dialog.resume ? { resume: dialog.resume } : {})} {...(dialog.initialMethod ? { initialMethod: dialog.initialMethod } : {})} onClose={() => setDialog(null)} />}
    </Section>
  )
}
