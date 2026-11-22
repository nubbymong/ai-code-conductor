import { create } from 'zustand'
import type { AccountProfile } from '../../shared/account-types'

interface AccountProfilesState {
  /** All known account profiles, hydrated from the main process on boot. */
  profiles: AccountProfile[]
  /** Pull the profile list from main and replace local state. Idempotent;
   *  swallows IPC failures so a boot-time hydrate never crashes the app. */
  hydrate: () => Promise<void>
  /** Resolve a profileId to its display name (used by the status strip /
   *  session row chips). Returns undefined for a missing/unknown id so callers
   *  can fall back to the alias map / raw email via resolveAccountName. */
  profileName: (profileId?: string) => string | undefined
  /** Create a new empty account profile via IPC, re-hydrate, and return it. */
  create: (name?: string) => Promise<AccountProfile>
}

/** The Claude profiles in the order they were added, as Settings, Accounts
 *  lists them (aicc_planning#381). Not the file's order: main writes a changed
 *  profile back at the end of profiles.json (withProfile in
 *  account-profiles.ts), so in that order an account moves each time it is
 *  made active or inactive, or renamed. createdAt is set once, when the
 *  profile is made, and every later write keeps it. A profile without a
 *  usable createdAt (a hand-edited file) comes after the dated ones; the id
 *  settles ties, so the order never depends on the file's. */
export function profilesInAddedOrder<T extends Pick<AccountProfile, 'id' | 'createdAt'>>(profiles: readonly T[]): T[] {
  const added = (p: T) => (typeof p.createdAt === 'number' && Number.isFinite(p.createdAt) ? p.createdAt : Number.POSITIVE_INFINITY)
  return [...profiles].sort((a, b) => {
    const x = added(a)
    const y = added(b)
    if (x !== y) return x < y ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export const useAccountProfilesStore = create<AccountProfilesState>((set, get) => ({
  profiles: [],

  hydrate: async () => {
    try {
      const profiles = await window.electronAPI.accountProfiles.list()
      set({ profiles })
    } catch (err) {
      console.error('[accountProfilesStore] hydrate failed:', err)
    }
  },

  profileName: (profileId) => {
    if (!profileId) return undefined
    return get().profiles.find((p) => p.id === profileId)?.name
  },

  create: async (name) => {
    const profile = await window.electronAPI.accountProfiles.create(name)
    await get().hydrate()
    return profile
  },
}))
