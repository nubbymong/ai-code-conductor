// [host] What the account handlers answer while the saved accounts list
// (profiles.json) cannot be read. An edit the user made (rename, make active
// or inactive, remove) is answered { ok: false, error } with one fixed
// sentence, which the Accounts row shows, and nothing is touched: remove asks
// before it closes or clears anything. Add rejects with the same sentence,
// which Settings shows. The identity refresh, which a poll asks every few
// seconds while a sign-in is open, answers no email while the list cannot be
// read (at its own read, or at the save), so the poll asks again. A removal
// whose list stops reading during the awaited clear says what did happen: the
// claude.ai sign-in was cleared and the account kept. Everything below the
// handlers is a fake: nothing is read or written, and nothing is started.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'
import type { AccountProfile } from '../../../src/shared/account-types'

const handlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}))

const h = vi.hoisted(() => ({
  store: [] as AccountProfile[],
  /** The list does not read: the strict read answers null. */
  unreadable: false,
  /** What the writers throw, when set. */
  refuse: null as Error | null,
  upserts: [] as AccountProfile[],
  backups: [] as string[],
  warn: [] as string[],
  /** What a removal did, in order. */
  removal: [] as string[],
}))

vi.mock('../../../src/main/account-profiles', async () => {
  // The real error class and sentence, so a change to either is seen here.
  const real = await vi.importActual<typeof import('../../../src/main/account-profiles')>('../../../src/main/account-profiles')
  return {
    ProfilesUnreadableError: real.ProfilesUnreadableError,
    PROFILES_UNREADABLE: real.PROFILES_UNREADABLE,
    listProfiles: () => (h.unreadable ? [] : h.store.map((p) => ({ ...p }))),
    readProfilesStrict: () => (h.unreadable ? null : h.store.map((p) => ({ ...p }))),
    upsertProfile: (p: AccountProfile) => { if (h.refuse) throw h.refuse; h.upserts.push(p) },
    createProfile: () => { if (h.refuse) throw h.refuse; return { id: 'profile-new', name: '', accountEmail: '', createdAt: 1 } },
    isValidProfileId: (id: unknown) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id),
    readProfileAccountEmail: () => 'me@example.com',
    getProfileConfigDir: (id: string) => `/profiles/${id}`,
    backupProfileHomeToCanonical: (id: string) => { h.backups.push(id) },
    safeTeardownProfile: (id: string) => { if (h.refuse) throw h.refuse; h.removal.push(`teardown:${id}`) },
    captureDetectedAccount: vi.fn(),
    restoreProfileIdentityFromCanonical: vi.fn(),
    readProfileCredentialStamp: vi.fn(),
    startProfileStepsSettled: vi.fn(async () => {}),
  }
})
vi.mock('../../../src/main/claude-account-identity', () => ({
  getAccountIdentity: vi.fn(), getDefaultAccountEmail: vi.fn(),
  getWatchedProfileId: vi.fn(), isProfileInUseByLiveSession: vi.fn(() => false), sessionsOnProfile: vi.fn(() => [] as string[]),
  detectedNewAccountEmail: vi.fn(),
}))
vi.mock('../../../src/main/usage/account-usage', () => ({ fetchAllAccountsUsage: vi.fn(), fetchAllAccountsUsageStreaming: vi.fn(), fetchAccountUsage: vi.fn() }))
vi.mock('../../../src/main/account-auth-info', () => ({ readAllProfileAuthInfo: vi.fn(() => []) }))
vi.mock('../../../src/main/account-web/artifacts', () => ({ closeArtifacts: (id: string) => { h.removal.push(`artifacts:${id}`) } }))
vi.mock('../../../src/main/account-web/account-pane', () => ({ closeAccountPanesForProfile: (id: string) => { h.removal.push(`panes:${id}`) } }))
vi.mock('../../../src/main/account-web/sign-in', () => ({ clearWebSession: async (id: string) => { h.removal.push(`clear:${id}`) } }))
vi.mock('../../../src/main/account-web/session-store', () => ({ removeWebSession: (id: string) => { h.removal.push(`record:${id}`) } }))
vi.mock('../../../src/main/debug-logger', () => ({
  logError: vi.fn(), logInfo: vi.fn(), logWarn: (...a: unknown[]) => { h.warn.push(a.map(String).join(' ')) },
}))

import { registerAccountProfilesHandlers } from '../../../src/main/ipc/account-profiles-handlers'
import { ProfilesUnreadableError, PROFILES_UNREADABLE } from '../../../src/main/account-profiles'

// The app's own window, and an event from its top frame: the handlers answer
// nothing else (trusted-sender.ts).
const appFrame = { frame: 'app' }
const appWindow: any = { isDestroyed: () => false, webContents: { mainFrame: appFrame } }
const invoke = (ch: string, ...args: any[]) => handlers.get(ch)!({ sender: appWindow.webContents, senderFrame: appFrame }, ...args)

const REFUSED = { ok: false, error: PROFILES_UNREADABLE }

beforeEach(() => {
  handlers.clear()
  h.store = [{ id: 'work', name: 'Work', accountEmail: '', createdAt: 1 }, { id: 'home', name: 'Home', accountEmail: 'h@example.com', createdAt: 2, isPrimary: true }]
  h.unreadable = false
  h.refuse = null
  h.upserts.length = 0
  h.backups.length = 0
  h.warn.length = 0
  h.removal.length = 0
  registerAccountProfilesHandlers(() => appWindow)
})

describe('the identity refresh (asked by a poll) with a list that cannot be read', () => {
  it('a save that was refused answers no email, so the poll asks again; it is logged and the backup is still made', () => {
    h.refuse = new ProfilesUnreadableError()
    expect(invoke(IPC.ACCOUNT_PROFILES_REFRESH_IDENTITY, { id: 'work' })).toEqual({ ok: true, email: null, configDir: '/profiles/work' })
    expect(h.upserts).toEqual([])
    expect(h.backups).toEqual(['work'])
    expect(h.warn).toHaveLength(1)
    expect(h.warn[0]).toMatch(/^\[account-profiles\] refreshIdentity for work: .*could not be read/)
  })

  it('the list does not read at the read the handler makes: no email either, nothing saved, logged once, the backup still made', () => {
    h.unreadable = true
    expect(invoke(IPC.ACCOUNT_PROFILES_REFRESH_IDENTITY, { id: 'work' })).toEqual({ ok: true, email: null, configDir: '/profiles/work' })
    expect(h.upserts).toEqual([])
    expect(h.backups).toEqual(['work'])
    expect(h.warn).toHaveLength(1)
    expect(h.warn[0]).toMatch(/^\[account-profiles\] refreshIdentity for work: .*could not be read/)
  })

  it('saves the email and answers it when the list reads, and logs nothing', () => {
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

describe('an edit the user made, with a list that cannot be read', () => {
  const EDITS: Array<[string, () => unknown]> = [
    ['rename', () => invoke(IPC.ACCOUNT_PROFILES_RENAME, { id: 'work', name: 'Office' })],
    ['make inactive', () => invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'work', active: false })],
    ['make active', () => invoke(IPC.ACCOUNT_PROFILES_SET_ACTIVE, { id: 'work', active: true })],
  ]

  it.each(EDITS)('%s, the list does not read: the fixed sentence is answered and nothing is written', (_name, edit) => {
    h.unreadable = true
    expect(edit()).toEqual(REFUSED)
    expect(h.upserts).toEqual([])
    expect(h.warn).toHaveLength(1)
  })

  it.each(EDITS)('%s, the list stops reading at the write: the same answer, not a rejected call', (_name, edit) => {
    h.refuse = new ProfilesUnreadableError()
    expect(edit()).toEqual(REFUSED)
    expect(h.upserts).toEqual([])
  })

  it.each(EDITS)('%s still works when the list reads, and any other error of the write is still thrown', (_name, edit) => {
    expect(edit()).toEqual({ ok: true })
    expect(h.upserts).toHaveLength(1)
    expect(h.warn).toEqual([])
    h.refuse = Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' })
    expect(edit).toThrow(/ENOSPC/)
  })

  it('remove refuses before anything of the account is closed, cleared or removed', async () => {
    h.unreadable = true
    expect(await invoke(IPC.ACCOUNT_PROFILES_DELETE, { id: 'work' })).toEqual(REFUSED)
    expect(h.removal).toEqual([])
  })

  it('remove still goes through, in its order, when the list reads', async () => {
    expect(await invoke(IPC.ACCOUNT_PROFILES_DELETE, { id: 'work' })).toEqual({ ok: true })
    expect(h.removal).toEqual(['artifacts:work', 'panes:work', 'clear:work', 'record:work', 'teardown:work'])
  })

  it('remove, the list stops reading during the awaited clear: the answer says the sign-in was cleared and the account kept', async () => {
    // The check before anything is closed passes; the removal's own read does not.
    h.refuse = new ProfilesUnreadableError()
    const res = await invoke(IPC.ACCOUNT_PROFILES_DELETE, { id: 'work' })
    expect(res).toEqual({ ok: false, error: 'The accounts list (profiles.json) could not be read, so the account was kept. Its claude.ai sign-in was cleared; try again.' })
    expect(res.error).not.toMatch(/nothing was changed/)
    expect(res.error).not.toMatch(/[\\/]/)
    expect(h.removal).toEqual(['artifacts:work', 'panes:work', 'clear:work', 'record:work'])
  })

  it('remove, any other failure of the removal: its own words, as before', async () => {
    h.refuse = new Error('EBUSY: resource busy or locked')
    expect(await invoke(IPC.ACCOUNT_PROFILES_DELETE, { id: 'work' })).toEqual({ ok: false, error: 'EBUSY: resource busy or locked' })
  })

  it('add rejects with the sentence, which Settings shows', () => {
    h.refuse = new ProfilesUnreadableError()
    expect(() => invoke(IPC.ACCOUNT_PROFILES_CREATE, { name: 'Another' })).toThrow(PROFILES_UNREADABLE)
    expect(() => invoke(IPC.ACCOUNT_PROFILES_CREATE, { name: 'Another' })).toThrow(ProfilesUnreadableError)
  })

  it('the sentence names the file and not where it is', () => {
    expect(PROFILES_UNREADABLE).toBe('The accounts list (profiles.json) could not be read, so nothing was changed.')
    expect(PROFILES_UNREADABLE).not.toMatch(/[\\/]/)
  })
})
