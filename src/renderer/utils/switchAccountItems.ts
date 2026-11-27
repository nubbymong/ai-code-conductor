// src/renderer/utils/switchAccountItems.ts
//
// P3.6 (row 22): what the Switch account lists show -- the strip's account
// pill (SessionStatusStrip) and the sidebar's right-click Switch Account
// (SessionContextMenu) -- for every provider, from one rule, so the two can
// never disagree. Claude's reads exactly as it always has (its profiles:
// the current one marked, inactive ones greyed). A provider whose sessions
// run under a registry account (Codex) lists that provider's accounts the
// same way, archived ones left out, plus the two states its launch picker
// already names: an account that needs attention (blocked) is greyed like
// an inactive one, and one launched only with that launch's confirmation
// (this computer's own sign-in, any unverified sign-in) is marked
// "confirm at launch" (utils/launchAccount.ts sessionAccountOptions).
import type { AccountsSnapshot, ProviderId } from '../../shared/providers'
import type { AccountProfile } from '../../shared/account-types'
import { isAccountActive } from '../../shared/account-types'
import { resolveAccountName, middleTruncateEmail } from '../../shared/account-chip-color'
import { accountDisplayName, selectProviderAccounts } from '../stores/providerAccountsStore'
import { launchNeedsAcknowledgement } from './launchAccount'
import { sessionProviderAccount } from './accountChip'
import type { HostMachineAccounts } from '../../shared/host-accounts'
import { hostElsewhere, switchMachineMark, type HostSwitchMark } from './hostAccounts'

const MIDDOT = String.fromCharCode(0xb7)

export type SwitchAccountState = 'inactive' | 'needs attention' | 'confirm at launch'

export interface SwitchAccountItem {
  /** What a pick switches to: a Claude profile id, or a registry account id. */
  value: string
  label: string
  /** The account's address, middle-truncated ('' when it has none). */
  detail: string
  /** The full address (else the name), for a tooltip. */
  title: string
  /** Why the row reads differently: greyed (inactive, needs attention) or
   *  asked about at launch (confirm at launch). */
  state?: SwitchAccountState
  /** The session's current account (a pick of it changes nothing). */
  active: boolean
  /** Listed but not offered. Never the current account. */
  disabled: boolean
  /** 2.1.3-beta.20 section 5 (frame 3): on a tab through the session helper,
   *  the account's sign-in on that machine (utils/hostAccounts
   *  switchMachineMark). `needsSignIn`: picking it opens the not-signed-in
   *  notice instead of switching. */
  machine?: HostSwitchMark
}

/** One line for a row that has room for one (the strip's popup): the
 *  address, and the state after a middle dot, and the account's sign-in on
 *  a helper tab's machine after another. */
export function switchItemHint(item: Pick<SwitchAccountItem, 'detail' | 'state' | 'machine'>): string {
  const parts = [item.detail, item.state, item.machine?.text].filter((p): p is string => !!p)
  return parts.join(` ${MIDDOT} `)
}

/** The tab's machine and its accounts' last read, for a tab through the
 *  session helper (2.1.3-beta.20 section 5). */
export interface SwitchHostSource {
  machineName: string
  accounts: HostMachineAccounts | undefined
}

/** The accounts a session's Switch account offers, in its provider's own
 *  order. None for a session of no provider. `host`: a helper tab's machine,
 *  whose last read marks each account's sign-in there. */
export function switchAccountItems(
  session: { provider?: ProviderId; profileId?: string; providerAccountId?: string } | null | undefined,
  sources: {
    profiles: ReadonlyArray<Pick<AccountProfile, 'id' | 'name' | 'accountEmail' | 'active' | 'isPrimary'>>
    aliases: Record<string, string> | undefined
    snapshot: AccountsSnapshot | null
  },
  host?: SwitchHostSource,
): SwitchAccountItem[] {
  if (!session) return []
  const provider = session.provider ?? 'claude'
  if (provider === 'claude') {
    return sources.profiles.map((p) => {
      const current = p.id === session.profileId
      const inactive = !isAccountActive(p as AccountProfile)
      const machine = host ? switchMachineMark(host.accounts?.accounts.find((a) => a.profileId === p.id), host.machineName, { elsewhere: hostElsewhere(host.accounts, p.id) }) : undefined
      return {
        value: p.id,
        label: resolveAccountName(p.accountEmail, p.name, sources.aliases),
        detail: middleTruncateEmail(p.accountEmail),
        title: machine?.title ?? p.accountEmail,
        ...(inactive ? { state: 'inactive' as const } : {}),
        active: current,
        disabled: inactive && !current,
        ...(machine ? { machine } : {}),
      }
    })
  }
  const snapshot = sources.snapshot
  const currentId = sessionProviderAccount({ provider, providerAccountId: session.providerAccountId }, snapshot)?.id
  return selectProviderAccounts(snapshot, provider).map((a) => {
    const current = a.id === currentId
    const inactive = a.lifecycle !== 'active'
    const blocked = a.operationalState === 'blocked'
    const state: SwitchAccountState | undefined = inactive ? 'inactive' : blocked ? 'needs attention' : launchNeedsAcknowledgement(a) ? 'confirm at launch' : undefined
    const label = a.providerLabel?.trim()
    const name = accountDisplayName(snapshot, a)
    return {
      value: a.id,
      label: name,
      detail: label ? middleTruncateEmail(label) : '',
      title: label || name,
      ...(state ? { state } : {}),
      active: current,
      disabled: (inactive || blocked) && !current,
    }
  })
}
