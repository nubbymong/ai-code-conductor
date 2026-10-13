/**
 * O5 (owner decision 2026-10-11): the app no longer uses the Codex sign-in
 * already on this computer; a Codex account is always added in the app. Only
 * 2.1.1-beta.2 offered that sign-in ("Use this sign-in"), and the account it
 * registered keeps working. Someone who chose it sees ONE page, once: "Replace
 * this sign-in with a Codex account" (CodexReplacePage), with Add a Codex
 * account (the usual add-account dialog) and Not now.
 *
 * The page is a boot gate (utils/bootGates.ts, 'codexReplace'), like "Do you
 * use Codex?" (codex-reconfirm-gate.ts). App arms it once per start, from the
 * first accounts snapshot that start receives (decideCodexReplace), and keeps
 * it up until the user leaves it. Leaving it either way stamps
 * `codexReplaceSeenVersion` (markCodexReplaceSeen); presence of that stamp is
 * what counts, as with Hello Codex, so it never shows again, upgrades
 * included. An app closed while the page is up shows it again at the next
 * start.
 *
 * Moving each session and saved config off that sign-in is not this page's
 * job: when one of them launches, the confirm asked before that launch
 * (LaunchAckConfirm) offers another Codex account, and the config moves to
 * the one picked.
 */
import type { AccountsSnapshot, AccountView } from '../../shared/providers'
import { providerAnsweredOn, providerView, selectProviderAccounts } from '../stores/providerAccountsStore'
import { useAppMetaStore } from '../stores/appMetaStore'
import { runningVersion } from './whats-new-gate'

/** The account 2.1.1-beta.2 registered for the Codex sign-in already on this
 *  computer (external), while it is not archived; undefined otherwise. */
export function retiredCodexSignIn(snapshot: AccountsSnapshot | null): AccountView | undefined {
  return selectProviderAccounts(snapshot, 'codex').find((a) => a.external)
}

/**
 * Arm the page this start? Only when it was never left before (no stamp),
 * Codex is on as the user answered it (with Codex off or not set up the
 * sign-in is not used, so the page waits for a start where it is), and an
 * account for that sign-in is still listed (not archived; an inactive one
 * counts, and the page then says nothing starts on it). Decided once, on
 * the first snapshot: an account list that could not be read arms nothing.
 */
export function decideCodexReplace(input: { snapshot: AccountsSnapshot | null; seenVersion?: string }): boolean {
  if (input.seenVersion) return false
  if (!providerAnsweredOn(providerView(input.snapshot, 'codex'))) return false
  return retiredCodexSignIn(input.snapshot) !== undefined
}

/** Record that the page was left (Add a Codex account finished, or Not now).
 *  The running version is kept for the record; presence is what the gate
 *  reads, so a build with no version still stamps. */
export function markCodexReplaceSeen(): void {
  try {
    useAppMetaStore.getState().update({ codexReplaceSeenVersion: runningVersion() || 'seen' })
  } catch {
    // Ignore storage errors, like the other seen stamps.
  }
}

/** The Codex accounts added in this app that a launch could use now (active,
 *  not external), by id: the page compares them before and after its
 *  add-account dialog to tell that an account was added. */
export function addedCodexAccountIds(snapshot: AccountsSnapshot | null): Set<string> {
  return new Set(selectProviderAccounts(snapshot, 'codex').filter((a) => a.lifecycle === 'active' && !a.external).map((a) => a.id))
}
