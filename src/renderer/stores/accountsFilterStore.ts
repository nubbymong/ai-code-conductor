// Settings, Accounts: the All / Active / Inactive filter at the top of the
// page (aicc_planning#381). One choice for every provider's list on the page.
// It is kept while the app runs, so leaving the page and coming back keeps
// it. It is never saved: after a restart the page shows All again.
import { create } from 'zustand'
import type { AccountsSnapshot } from '../../shared/providers'
import { isAccountActive, type AccountProfile } from '../../shared/account-types'
import { selectAccountsInAddedOrder, managedListProviders } from './providerAccountsStore'

export type AccountsFilter = 'all' | 'active' | 'inactive'

/** The filter's choices, in the order the control shows them. */
export const ACCOUNTS_FILTERS: readonly AccountsFilter[] = ['all', 'active', 'inactive']

export const ACCOUNTS_FILTER_LABEL: Readonly<Record<AccountsFilter, string>> = {
  all: 'All',
  active: 'Active',
  inactive: 'Inactive',
}

interface AccountsFilterState {
  filter: AccountsFilter
  setFilter: (filter: AccountsFilter) => void
}

export const useAccountsFilterStore = create<AccountsFilterState>((set) => ({
  filter: 'all',
  setFilter: (filter) => set({ filter }),
}))

/** Whether a row shows under the filter, from whether its account is active. */
export function filterShows(filter: AccountsFilter, active: boolean): boolean {
  return filter === 'all' || (filter === 'active') === active
}

/** The line a list shows when the filter leaves none of its rows. None under
 *  All: an empty list then looks as it always did. */
export function filterEmptyText(filter: AccountsFilter): string | null {
  if (filter === 'active') return 'No active accounts.'
  if (filter === 'inactive') return 'No inactive accounts.'
  return null
}

export type AccountsFilterCounts = Record<AccountsFilter, number>

/** The count on each choice, over every account the page lists: Claude's
 *  profiles (AccountsPanel) and the accounts of each managed provider
 *  (managedListProviders). Archived accounts are not counted: they keep
 *  their own "Archived (N)" part. Unfinished setups are not accounts yet. */
export function accountsFilterCounts(
  profiles: readonly Pick<AccountProfile, 'active' | 'isPrimary'>[],
  snapshot: AccountsSnapshot | null,
): AccountsFilterCounts {
  const actives = [
    ...profiles.map((p) => isAccountActive(p)),
    ...managedListProviders(snapshot).flatMap((p) => selectAccountsInAddedOrder(snapshot, p.providerId).map((a) => a.lifecycle === 'active')),
  ]
  const active = actives.filter(Boolean).length
  return { all: actives.length, active, inactive: actives.length - active }
}
