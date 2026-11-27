// @vitest-environment node
//
// nubbymong/aicc_planning#445 (review F1): the Account usage page draws every
// card at once "from the saved profile list and each account's last reading".
// lastKnownUsage() is main's read-only answer: each active profile's newest
// figure (the one its sessions last delivered, or the last one fetched, from
// usage-snapshots.json), marked stale, with its own time. It reads no
// credential file, refreshes no token and makes no request; with Claude Code
// switched off (D5) it reads nothing at all and answers none.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AccountProfile } from '../../src/shared/account-types'
import type { UsageBucket, CreditsInfo } from '../../src/shared/usage-types'

const h = vi.hoisted(() => ({
  profiles: [] as AccountProfile[],
  snapshots: {} as Record<string, { buckets: unknown[]; credits?: unknown; fetchedAt: number }>,
  loadSnapshots: vi.fn(),
  getProfileConfigDir: vi.fn((_id: string) => '/nowhere'),
  readProfileAccountEmail: vi.fn((_id: string) => null),
  request: vi.fn(),
}))

vi.mock('../../src/main/account-profiles', () => ({
  listProfiles: () => h.profiles,
  getProfileConfigDir: (id: string) => h.getProfileConfigDir(id),
  readProfileAccountEmail: (id: string) => h.readProfileAccountEmail(id),
  atomicWriteSecure: vi.fn(),
  hardenCredentialFile: vi.fn(),
  credentialFoldersVerdict: () => ({ ok: true }),
}))
vi.mock('../../src/main/claude-account-identity', () => ({
  isProfileInUseByLiveSession: () => false,
  sessionsOnProfile: () => [],
  getClaudeProfileId: () => undefined,
}))
vi.mock('../../src/main/usage/usage-snapshots', () => ({
  loadSnapshots: () => { h.loadSnapshots(); return new Map(Object.entries(h.snapshots)) },
  saveSnapshots: () => true,
}))
vi.mock('../../src/main/debug-logger', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('https', () => ({ default: { request: h.request }, request: h.request }))

const { lastKnownUsage, setClaudeAccountDataAllowed, _resetSnapshotsForTest, _resetLiveUsageForTest } = await import('../../src/main/usage/account-usage')

const bucket = (percent: number): UsageBucket => ({ key: 'session:', label: '5h', group: 'session', percent, resetsAt: '', severity: 'normal' })
const CREDITS: CreditsInfo = { currency: 'USD', used: 2, limit: null, remaining: 8, enabled: true }
const profile = (id: string, over: Partial<AccountProfile> = {}): AccountProfile => ({ id, name: `Name ${id}`, accountEmail: `${id}@example.com`, createdAt: 0, ...over })

beforeEach(() => {
  _resetSnapshotsForTest()
  _resetLiveUsageForTest()
  setClaudeAccountDataAllowed(() => true)
  h.profiles = []
  h.snapshots = {}
  h.loadSnapshots.mockClear(); h.getProfileConfigDir.mockClear(); h.readProfileAccountEmail.mockClear(); h.request.mockClear()
})

describe('lastKnownUsage (aicc_planning#445, review F1)', () => {
  it('gives each profile\'s last fetched figure, marked stale, with its own time and credits', () => {
    h.profiles = [profile('a', { isPrimary: true }), profile('b')]
    h.snapshots = { a: { buckets: [bucket(30)], credits: CREDITS, fetchedAt: 1_000 }, b: { buckets: [bucket(70)], fetchedAt: 2_000 } }
    expect(lastKnownUsage()).toEqual([
      { profileId: 'a', email: 'a@example.com', name: 'Name a', isPrimary: true, active: true, status: 'ok', stale: true, buckets: [bucket(30)], credits: CREDITS, fetchedAt: 1_000 },
      { profileId: 'b', email: 'b@example.com', name: 'Name b', isPrimary: false, active: true, status: 'ok', stale: true, buckets: [bucket(70)], fetchedAt: 2_000 },
    ])
  })

  it('leaves out a parked profile (never read) and one with no figure yet', () => {
    h.profiles = [profile('parked', { active: false }), profile('none'), profile('c')]
    h.snapshots = { parked: { buckets: [bucket(10)], fetchedAt: 1 }, c: { buckets: [bucket(5)], fetchedAt: 3 } }
    expect(lastKnownUsage().map((u) => u.profileId)).toEqual(['c'])
  })

  it('reads no credential file, refreshes nothing and makes no request', () => {
    h.profiles = [profile('a'), profile('b')]
    h.snapshots = { a: { buckets: [bucket(30)], fetchedAt: 1 } }
    lastKnownUsage()
    expect(h.getProfileConfigDir).not.toHaveBeenCalled()
    expect(h.readProfileAccountEmail).not.toHaveBeenCalled()
    expect(h.request).not.toHaveBeenCalled()
  })

  it('with Claude Code off (D5) reads nothing at all and answers none; a rule that throws is off', () => {
    h.profiles = [profile('a')]
    h.snapshots = { a: { buckets: [bucket(30)], fetchedAt: 1 } }
    setClaudeAccountDataAllowed(() => false)
    expect(lastKnownUsage()).toEqual([])
    setClaudeAccountDataAllowed(() => { throw new Error('unreadable') })
    expect(lastKnownUsage()).toEqual([])
    expect(h.loadSnapshots).not.toHaveBeenCalled()
  })
})
