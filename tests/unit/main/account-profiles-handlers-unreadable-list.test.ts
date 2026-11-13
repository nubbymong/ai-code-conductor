// [host] aicc_planning B1 (from #307): what the account handlers do when a
// writer of the saved accounts list refuses (ProfilesUnreadableError). A call
// the user made (rename, make active or inactive, add) fails, so the window
// shows it; the identity refresh, which a poll asks every few seconds while a
// sign-in is open, logs it, still answers the email it found and still makes
// the backup. Everything below the handlers is a fake: nothing is read or
// written, and nothing is started.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'
import type { AccountProfile } from '../../../src/shared/account-types'

const handlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}))

const h = vi.hoisted(() => {
  class ProfilesUnreadableError extends Error {
    readonly code = 'PROFILES_UNREADABLE'
    constructor() { super('The saved accounts list (profiles.json) could not be read, so it was left as it is and this change was not saved.'); this.name = 'ProfilesUnreadableError' }
  }
  return {
    ProfilesUnreadableError,
    store: [] as AccountProfile[],
    /** What the writers throw, when set. */
    refuse: null as Error | null,
    upserts: [] as AccountProfile[],
    backups: [] as string[],
    warn: [] as string[],
  }
})

vi.mock('../../../src/main/account-profiles', () => ({
  ProfilesUnreadableError: h.ProfilesUnreadableError,
  listProfiles: () => h.store.map((p) => ({ ...p })),
  upsertProfile: (p: AccountProfile) => { if (h.refuse) throw h.refuse; h.upserts.push(p) },
  createProfile: () => { if (h.refuse) throw h.refuse; return { id: 'profile-new', name: '', accountEmail: '', createdAt: 1 } },
  isValidProfileId: (id: unknown) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id),
  readProfileAccountEmail: () => 'me@example.com',
  getProfileConfigDir: (id: string) => `/profiles/${id}`,
  backupProfileHomeToCanonical: (id: string) => { h.backups.push(id) },
  safeTeardownProfile: vi.fn(),
  captureDetectedAccount: vi.fn(),
  restoreProfileIdentityFromCanonical: vi.fn(),
  readProfileCredentialStamp: vi.fn(),
  startProfileStepsSettled: vi.fn(async () => {}),
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  getAccountIdentity: vi.fn(), getDefaultAccountEmail: vi.fn(),
  getWatchedProfileId: vi.fn(), isProfileInUseByLiveSession: vi.fn(() => false), sessionsOnProfile: vi.fn(() => [] as string[]),
  detectedNewAccountEmail: vi.fn(),
}))
vi.mock('../../../src/main/usage/account-usage', () => ({ fetchAllAccountsUsage: vi.fn(), fetchAllAccountsUsageStreaming: vi.fn(), fetchAccountUsage: vi.fn() }))
vi.mock('../../../src/main/account-auth-info', () => ({ readAllProfileAuthInfo: vi.fn(() => []) }))
vi.mock('../../../src/main/debug-logger', () => ({
  logError: vi.fn(), logInfo: vi.fn(), logWarn: (...a: unknown[]) => { h.warn.push(a.map(String).join(' ')) },
}))

import { registerAccountProfilesHandlers } from '../../../src/main/ipc/account-profiles-handlers'

// The app's own window, and an event from its top frame: the handlers answer
// nothing else (trusted-sender.ts).
const appFrame = { frame: 'app' }
const appWindow: any = { isDestroyed: () => false, webContents: { mainFrame: appFrame } }
const invoke = (ch: string, ...args: any[]) => handlers.get(ch)!({ sender: appWindow.webContents, senderFrame: appFrame }, ...args)

beforeEach(() => {
  handlers.clear()
  h.store = [{ id: 'work', name: 'Work', accountEmail: '', createdAt: 1 }, { id: 'home', name: 'Home', accountEmail: 'h@example.com', createdAt: 2, isPrimary: true }]
  h.refuse = null
  h.upserts.length = 0
  h.backups.length = 0
  h.warn.length = 0
  registerAccountProfilesHandlers(() => appWindow)
})

describe('the identity refresh (asked by a poll) with a list that cannot be read (B1)', () => {
  it('logs it, still answers the email it found and still makes the backup', () => {
    h.refuse = new h.ProfilesUnreadableError()
    expect(invoke(IPC.ACCOUNT_PROFILES_REFRESH_IDENTITY, { id: 'work' })).toEqual({ ok: true, email: 'me@example.com', configDir: '/profiles/work' })
    expect(h.upserts).toEqual([])
    expect(h.backups).toEqual(['work'])
    expect(h.warn).toHaveLength(1)
    expect(h.warn[0]).toMatch(/^\[account-profiles\] refreshIdentity for work: .*could not be read/)
  })

  it('saves the email when the list reads, and logs nothing', () => {
    expect(invoke(IPC.ACCOUNT_PROFILES_REFRESH_IDENTITY, { id: 'work' })).toEqual({ ok: true, email: 'me@example.com', configDir: '/profiles/work' })
    expect(h.upserts).toEqual([{ id: 'work', name: 'Work', accountEmail: 'me@example.com', createdAt: 1 }])
    expect(h.backups).toEqual(['work'])
    expect(h.warn).toEqual([])
  })

  it('any other error of the write is still the caller\'s', () => {
    h.refuse = Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' })
    expect(() => invoke(IPC.ACCOUNT_PROFILES_REFRESH_IDENTITY, { id: 'work' })).toThrow(/ENOSPC/)
    expect(h.warn).toEqual([])
  })
})

describe('calls the user made, with a list that cannot be read (B1)', () => {
  it('rename, make inactive and add fail with the named error, so the window shows it', () => {
    h.refuse = new h.ProfilesUnreadableError()
    expect(() => invoke(IPC.ACCOUNT_PROFILES_RENAME, { id: 'work', name: 'Office' })).toThrow(h.ProfilesUnreadableError)
    expect(() => invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'work', active: false })).toThrow(h.ProfilesUnreadableError)
    expect(() => invoke(IPC.ACCOUNT_PROFILES_CREATE, { name: 'Another' })).toThrow(h.ProfilesUnreadableError)
    expect(h.upserts).toEqual([])
    expect(h.warn).toEqual([])
  })
})
