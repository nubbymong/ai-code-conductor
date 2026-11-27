// @vitest-environment node
//
// Plan P2 (rc.15), made whole by aicc_planning#378 (2.1.3-beta.13): an account
// a running Claude Code session uses already has its usage on screen (that
// session's status line delivered it), so the Account usage page shows that
// figure and makes NO request of its own for the account: no GET and no token
// refresh, ever. That holds for the primary account too, for a figure with
// credits, for a figure older than the 90 s the page shows as current, and
// before the session has delivered anything. The page shows the newest figure
// it has, the session's or the last one fetched before, with its time; the
// credits row shows the last fetched credits with their own time, or nothing;
// with nothing at all the card waits for the session. Accounts with no
// running session (closed, or held only by a plain shell, a probe or a
// background run, none of which report a status line) are fetched as before.
// So is an account whose sessions were all launched without the app's status
// line (the Status line switch off, or its script not set up): they report
// nothing either.
//
// The observable is the network: an account a session uses issues no request
// at all; a closed account issues a GET to api.anthropic.com and, with a
// lapsed token, a refresh POST to platform.claude.com.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AccountProfile } from '../../src/shared/account-types'
import type { UsageBucket, CreditsInfo } from '../../src/shared/usage-types'

let profiles: AccountProfile[] = []
let tmpHome = ''
/** sessionId -> profileId, as claude-account-identity would resolve it. */
const profileBySession = new Map<string, string | undefined>()
/** profileIds a running Claude Code session uses (sessionsOnProfile). */
const inUse = new Set<string>()
/** profileIds held only by something that reports no status line: a plain
 *  shell under the account, the sign-in probe, a background run. */
const heldOnly = new Set<string>()
/** The session ids on a profile, where a case needs more than the one an
 *  in-use profile has by default (`session-on-<id>`). */
const sessionsOf = new Map<string, string[]>()
/** Seeded last-good snapshots (a prior real fetch), by profileId. */
let seededSnapshots: Record<string, { buckets: UsageBucket[]; credits?: unknown; fetchedAt: number }> = {}

vi.mock('../../src/main/account-profiles', () => ({
  listProfiles: () => profiles,
  getProfileConfigDir: () => tmpHome,
  readProfileAccountEmail: () => null,
  atomicWriteSecure: vi.fn(),
  hardenCredentialFile: vi.fn(),
  // The sign-in folder has passed the owner-only check (the rule is off off Windows).
  credentialFoldersVerdict: () => ({ ok: true }),
}))
vi.mock('../../src/main/claude-account-identity', () => ({
  // As the real module: a session on the profile, or any other consumer.
  isProfileInUseByLiveSession: (id: string) => inUse.has(id) || heldOnly.has(id),
  sessionsOnProfile: (id: string) => (inUse.has(id) ? sessionsOf.get(id) ?? [`session-on-${id}`] : []),
  getClaudeProfileId: (sessionId: string) => profileBySession.get(sessionId),
}))
vi.mock('../../src/main/usage/usage-snapshots', () => ({
  loadSnapshots: () => new Map(Object.entries(seededSnapshots)),
  saveSnapshots: () => true,
}))
vi.mock('../../src/main/debug-logger', () => ({ logWarn: vi.fn(), logInfo: vi.fn() }))

const requestedHosts: string[] = []
vi.mock('https', () => {
  const request = (opts: any, cb: (res: any) => void) => {
    requestedHosts.push(opts?.hostname ?? '')
    // A GET to the usage endpoint returns a tiny valid payload; anything else 400s.
    const isUsageGet = opts?.hostname === 'api.anthropic.com'
    const res: any = {
      statusCode: isUsageGet ? 200 : 400,
      headers: {},
      on: (ev: string, fn: (arg?: unknown) => void) => {
        if (ev === 'data' && isUsageGet) fn(JSON.stringify({ limits: [{ group: 'session', percent: 3, resets_at: '' }] }))
        if (ev === 'end') fn()
        return res
      },
    }
    cb(res)
    return { on: () => ({}), write: () => {}, end: () => {}, destroy: () => {}, setTimeout: () => {} }
  }
  return { default: { request }, request }
})

const { fetchAccountUsage, fetchAllAccountsUsage, fetchAllAccountsUsageStreaming, recordLiveUsageForSession, setLiveUsageTranscriptProfile, setLiveUsageSessionReports, _resetLiveUsageForTest, _resetSnapshotsForTest, LIVE_USAGE_MAX_AGE_MS } =
  await import('../../src/main/usage/account-usage')

// P3.2: the recorder files a figure under a profile only when the session's
// transcript lies in that profile's folder (the Tokenomics folder rule, tested
// in tk-attribution). Here a stand-in for that rule: /profiles/<id>/projects/...
const transcriptOf = (sessionId: string, profileId = profileBySession.get(sessionId)) =>
  `/profiles/${profileId}/projects/p/00000000-0000-4000-8000-000000000000.jsonl`
const fakeFolderRule = (transcriptPath: string) => /^\/profiles\/([^/]+)\/projects\/[^/]+\/[^/]+\.jsonl$/.exec(transcriptPath)?.[1]

const USAGE_HOST = 'api.anthropic.com'
const REFRESH_HOST = 'platform.claude.com'

const profile = (over: Partial<AccountProfile>): AccountProfile => ({
  id: 'profile-x-1', name: 'Acct', accountEmail: 'x@example.com', createdAt: 0, ...over,
})
const bucket = (over: Partial<UsageBucket> = {}): UsageBucket =>
  ({ key: 'session:', label: '5h', group: 'session', percent: 12, resetsAt: '', severity: 'normal', ...over })
const CREDITS: CreditsInfo = { currency: 'USD', used: 1, limit: null, remaining: null, enabled: true }

/** A credentials file so a closed account's GET has a token: fresh (non-lapsed)
 *  by default; pass a past `expiresAt` for a token the closed path would refresh. */
function writeCreds(expiresAt = Date.now() + 3_600_000): void {
  const dir = path.join(tmpHome, '.claude')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'live-token', refreshToken: 'r', expiresAt },
  }))
}
const writeFreshCreds = (): void => writeCreds()

/** A session on the profile, and the figure it delivered `ageMs` ago. */
function sessionDelivered(profileId: string, buckets: unknown[], opts: { hasCredits?: boolean; ageMs?: number; sessionId?: string } = {}): void {
  const sessionId = opts.sessionId ?? `sess-${profileId}`
  inUse.add(profileId)
  profileBySession.set(sessionId, profileId)
  recordLiveUsageForSession(sessionId, buckets, !!opts.hasCredits, transcriptOf(sessionId), Date.now() - (opts.ageMs ?? 0))
}

beforeEach(() => {
  setLiveUsageTranscriptProfile(fakeFolderRule)
  setLiveUsageSessionReports(null) // every session reports, as main wires it for one launched with the status line
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-live-open-'))
  profiles = [profile({ id: 'profile-x-1' })]
  profileBySession.clear()
  inUse.clear()
  heldOnly.clear()
  sessionsOf.clear()
  seededSnapshots = {}
  requestedHosts.length = 0
  _resetLiveUsageForTest()
  _resetSnapshotsForTest() // so each test's seededSnapshots is hydrated fresh
  writeFreshCreds()
})
afterEach(() => { try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('fetchAccountUsage: an account a running session uses is never fetched (aicc_planning#378)', () => {
  it('serves the delivered buckets with status ok and NO network request', async () => {
    sessionDelivered('profile-x-1', [bucket({ percent: 41 })])

    const r = await fetchAccountUsage('profile-x-1')
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(false)
    expect(r.inSession).toBe(true)
    expect(r.buckets.map((b) => b.percent)).toEqual([41])
    expect(requestedHosts).toEqual([]) // reused the delivered figure, made no call
  })

  it('a CLOSED account still hits the usage endpoint', async () => {
    // not in use, fresh token -> the normal GET path.
    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toContain(USAGE_HOST)
    expect(r.status).toBe('ok')
    expect(r.inSession).toBeUndefined()
  })

  it('a delivered figure with credits makes no request; with no credits fetched before, there is no credits row', async () => {
    sessionDelivered('profile-x-1', [bucket({ percent: 22 })], { hasCredits: true })

    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([])
    expect(r.status).toBe('ok')
    expect(r.buckets.map((b) => b.percent)).toEqual([22])
    expect(r.credits).toBeUndefined()
    expect(r.creditsFetchedAt).toBeUndefined()
  })

  it('REGRESSION (adversarial pass on #598): with credits and a LAPSED token there is still neither a GET nor a refresh', async () => {
    // An expired token is the case in which the closed-account path WOULD refresh.
    writeCreds(Date.now() - 60_000)
    sessionDelivered('profile-x-1', [bucket()], { hasCredits: true })

    await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([])
  })

  it('control: the same lapsed token on a CLOSED account does go to the refresh endpoint', async () => {
    writeCreds(Date.now() - 60_000)
    await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toContain(REFRESH_HOST)
  })

  it('credits a prior fetch cached are shown with the time of that fetch, and nothing is requested', async () => {
    const fetchedAt = Date.now() - 3 * 3_600_000
    seededSnapshots = { 'profile-x-1': { buckets: [bucket({ percent: 5 })], credits: CREDITS, fetchedAt } }
    sessionDelivered('profile-x-1', [bucket({ percent: 30 })]) // delivered has no credits...

    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([]) // ...and the cached credits no longer force a GET
    expect(r.stale).toBe(false)
    expect(r.buckets.map((b) => b.percent)).toEqual([30]) // the session's bars
    expect(r.credits).toEqual(CREDITS)                    // the last fetched credits
    expect(r.creditsFetchedAt).toBe(fetchedAt)            // with their own time
  })

  it('a delivered figure older than the max age is shown as not updated since then, not fetched', async () => {
    const age = LIVE_USAGE_MAX_AGE_MS + 1
    const before = Date.now()
    sessionDelivered('profile-x-1', [bucket({ percent: 64 })], { ageMs: age })
    const after = Date.now()

    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([])
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(true)
    expect(r.inSession).toBe(true) // the card says "Last updated", not "couldn't refresh"
    expect(r.buckets.map((b) => b.percent)).toEqual([64])
    // The figure's own time, not the time of this read.
    expect(r.fetchedAt).toBeGreaterThanOrEqual(before - age)
    expect(r.fetchedAt).toBeLessThanOrEqual(after - age)
  })

  it('a figure exactly at the max age is still current', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['Date'] })
    try {
      sessionDelivered('profile-x-1', [bucket()], { ageMs: LIVE_USAGE_MAX_AGE_MS })
      const r = await fetchAccountUsage('profile-x-1')
      expect(r.stale).toBe(false)
      expect(requestedHosts).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('in use with nothing delivered yet: the last fetched figure, with its time and credits, and no request', async () => {
    const fetchedAt = Date.now() - 2 * 3_600_000
    seededSnapshots = { 'profile-x-1': { buckets: [bucket({ percent: 9 })], credits: CREDITS, fetchedAt } }
    inUse.add('profile-x-1') // session just spawned; nothing recorded

    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([])
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(true)
    expect(r.inSession).toBe(true)
    expect(r.fetchedAt).toBe(fetchedAt)
    expect(r.buckets.map((b) => b.percent)).toEqual([9])
    expect(r.credits).toEqual(CREDITS)
    expect(r.creditsFetchedAt).toBeUndefined() // the same reading as the bars: one time
  })

  it('in use with nothing delivered and nothing fetched before: it waits for the session, with no request', async () => {
    inUse.add('profile-x-1')

    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([])
    expect(r.status).toBe('waiting')
    expect(r.inSession).toBe(true)
    expect(r.buckets).toEqual([])
  })

  it('in use with nothing current and no sign-in at all: Not signed in, with no request', async () => {
    fs.rmSync(path.join(tmpHome, '.claude', '.credentials.json'))
    seededSnapshots = { 'profile-x-1': { buckets: [bucket()], fetchedAt: Date.now() - 3_600_000 } }
    inUse.add('profile-x-1')

    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([])
    expect(r.status).toBe('needs-login')
  })

  it('the newer of the delivered and the fetched figure is shown', async () => {
    seededSnapshots = { 'profile-x-1': { buckets: [bucket({ percent: 77 })], fetchedAt: Date.now() - 1_000 } }
    sessionDelivered('profile-x-1', [bucket({ percent: 11 })], { ageMs: 60_000 })

    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([])
    expect(r.buckets.map((b) => b.percent)).toEqual([77])
    expect(r.stale).toBe(false)
  })

  it('the PRIMARY account is served from its delivered figure the same way, with no request', async () => {
    profiles = [profile({ id: 'profile-x-1', isPrimary: true })]
    sessionDelivered('profile-x-1', [bucket({ percent: 51 })])

    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([])
    expect(r.status).toBe('ok')
    expect(r.isPrimary).toBe(true)
    expect(r.buckets.map((b) => b.percent)).toEqual([51])
  })

  it('the PRIMARY account with nothing delivered yet makes no request either', async () => {
    profiles = [profile({ id: 'profile-x-1', isPrimary: true })]
    inUse.add('profile-x-1')

    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([])
    expect(r.status).toBe('waiting')
  })

  it('an account held only by something with no status line (a plain shell, a probe) is fetched as before, never refreshed', async () => {
    writeCreds(Date.now() + 3_600_000)
    heldOnly.add('profile-x-1')
    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([USAGE_HOST])
    expect(r.inSession).toBeUndefined()

    requestedHosts.length = 0
    writeCreds(Date.now() - 60_000)
    await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).not.toContain(REFRESH_HOST) // the refresh guard still counts it
  })

  it('another account\'s delivered or fetched figure is never shown for this one', async () => {
    profiles = [profile({ id: 'profile-a-1' }), profile({ id: 'profile-b-2' })]
    seededSnapshots = { 'profile-a-1': { buckets: [bucket({ percent: 88 })], credits: CREDITS, fetchedAt: Date.now() - 1_000 } }
    sessionDelivered('profile-a-1', [bucket({ percent: 99 })])
    inUse.add('profile-b-2') // a session on B that has delivered nothing

    const r = await fetchAccountUsage('profile-b-2')
    expect(requestedHosts).toEqual([])
    expect(r.status).toBe('waiting')
    expect(r.buckets).toEqual([])
    expect(r.credits).toBeUndefined()
  })
})

describe('a session launched without the app\'s status line reports nothing, so its account is fetched (aicc_planning#378)', () => {
  // As main wires it: false for a session per-session-settings recorded as
  // launched without the app's status line (the Status line switch off, or
  // its script not set up). The default session id here is `session-on-<id>`.
  const quiet = (...ids: string[]) => setLiveUsageSessionReports((sid) => !ids.includes(sid))

  it('an account whose only session reports nothing is fetched with a GET, as one no session uses', async () => {
    inUse.add('profile-x-1')
    quiet('session-on-profile-x-1')

    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([USAGE_HOST])
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(false)
    expect(r.inSession).toBeUndefined()
  })

  it('with a lapsed token it is not refreshed while the session holds the account', async () => {
    writeCreds(Date.now() - 60_000)
    inUse.add('profile-x-1')
    quiet('session-on-profile-x-1')

    const r = await fetchAccountUsage('profile-x-1')
    // No refresh (the guard still counts the session), and no GET with a lapsed token.
    expect(requestedHosts).toEqual([])
    expect(r.inSession).toBeUndefined()
    expect(r.status).not.toBe('waiting')
  })

  it('it takes a stagger slot like any account that is fetched', async () => {
    profiles = [profile({ id: 'profile-quiet' }), profile({ id: 'profile-closed' })]
    inUse.add('profile-quiet')
    quiet('session-on-profile-quiet')
    const timeoutSpy = vi.spyOn(global, 'setTimeout')
    try {
      const rows = await fetchAllAccountsUsage()
      expect(requestedHosts).toEqual([USAGE_HOST, USAGE_HOST])
      expect(timeoutSpy.mock.calls.filter((c) => c[1] === 300)).toHaveLength(1)
      expect(rows.map((x) => x.inSession === true)).toEqual([false, false])
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('an account with one reporting and one non-reporting session makes no request', async () => {
    inUse.add('profile-x-1')
    sessionsOf.set('profile-x-1', ['sess-quiet', 'sess-reporting'])
    quiet('sess-quiet')

    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([])
    expect(r.inSession).toBe(true)
    expect(r.status).toBe('waiting')
  })

  it('a session the check cannot answer for counts as reporting', async () => {
    inUse.add('profile-x-1')
    setLiveUsageSessionReports(() => { throw new Error('boom') })

    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([])
    expect(r.inSession).toBe(true)
  })
})

describe('recordLiveUsageForSession: what it stores', () => {
  it('stores nothing for a session with no local profile (SSH / default home)', async () => {
    inUse.add('profile-x-1')
    profileBySession.set('sess-ssh', undefined) // getClaudeProfileId -> undefined
    recordLiveUsageForSession('sess-ssh', [bucket()], false, transcriptOf('sess-ssh'))

    const r = await fetchAccountUsage('profile-x-1') // in use, but nothing was stored for it
    expect(r.status).toBe('waiting')
    expect(requestedHosts).toEqual([])
  })

  it('ignores an empty or all-malformed bucket set', async () => {
    inUse.add('profile-x-1')
    profileBySession.set('sess-1', 'profile-x-1')
    recordLiveUsageForSession('sess-1', [], false, transcriptOf('sess-1'))
    recordLiveUsageForSession('sess-1', [{ nope: 1 }, 'bad', null], false, transcriptOf('sess-1'))

    const r = await fetchAccountUsage('profile-x-1')
    expect(r.status).toBe('waiting') // nothing to show
    expect(requestedHosts).toEqual([])
  })

  it('drops malformed buckets but keeps the valid ones', async () => {
    inUse.add('profile-x-1')
    profileBySession.set('sess-1', 'profile-x-1')
    recordLiveUsageForSession('sess-1', [bucket({ percent: 7 }), { key: 1 }, bucket({ key: 'weekly:', label: 'Weekly', group: 'weekly', percent: 20 })], false, transcriptOf('sess-1'))

    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([])
    expect(r.buckets.map((b) => b.percent)).toEqual([7, 20])
  })
})

describe('fetchAllAccountsUsage: accounts a session uses make no call and take no stagger slot', () => {
  it('only the closed account hits the network; both open accounts are served from their figures', async () => {
    profiles = [
      profile({ id: 'profile-open-1', accountEmail: 'a@x.com' }),
      profile({ id: 'profile-open-2', accountEmail: 'b@x.com' }),
      profile({ id: 'profile-closed-3', accountEmail: 'c@x.com' }),
    ]
    sessionDelivered('profile-open-1', [bucket({ percent: 10 })], { sessionId: 's1' })
    sessionDelivered('profile-open-2', [bucket({ percent: 20 })], { sessionId: 's2' })

    const rows = await fetchAllAccountsUsage()
    expect(rows.map((r) => r.profileId)).toEqual(['profile-open-1', 'profile-open-2', 'profile-closed-3'])
    // Exactly one network call: the closed account's GET. The two open accounts
    // were served from their delivered figures and made no request.
    expect(requestedHosts).toEqual([USAGE_HOST])
    expect(rows[0].buckets[0].percent).toBe(10)
    expect(rows[1].buckets[0].percent).toBe(20)
  })

  // The stagger exists to space out NETWORK calls; an open account makes none, so
  // it must not trigger one -- otherwise the page waits STAGGER_MS per open row
  // for calls that never happen, the opposite of the "instant open rows" goal.
  it('an all-open fetchAll issues ZERO stagger sleeps', async () => {
    profiles = [
      profile({ id: 'profile-open-1' }), profile({ id: 'profile-open-2' }), profile({ id: 'profile-open-3' }),
    ]
    for (let i = 1; i <= 3; i++) sessionDelivered(`profile-open-${i}`, [bucket()], { sessionId: `s${i}` })
    const timeoutSpy = vi.spyOn(global, 'setTimeout')
    await fetchAllAccountsUsage()
    // STAGGER_MS is 300; no networked account, so no stagger sleep is scheduled.
    expect(timeoutSpy.mock.calls.filter((c) => c[1] === 300)).toHaveLength(0)
    expect(requestedHosts).toEqual([])
    timeoutSpy.mockRestore()
  })

  it('two CLOSED accounts DO stagger once between them (the control for the zero above)', async () => {
    profiles = [profile({ id: 'profile-a' }), profile({ id: 'profile-b' })] // neither in use -> both network
    const timeoutSpy = vi.spyOn(global, 'setTimeout')
    await fetchAllAccountsUsage()
    expect(timeoutSpy.mock.calls.filter((c) => c[1] === 300)).toHaveLength(1)
    timeoutSpy.mockRestore()
  })

  it('an open account with cached credits, an open primary and one with a stale figure make no call and take no slot', async () => {
    seededSnapshots = { 'profile-cc': { buckets: [bucket()], credits: CREDITS, fetchedAt: Date.now() - 1000 } }
    profiles = [
      profile({ id: 'profile-cc' }),
      profile({ id: 'profile-primary', isPrimary: true }),
      profile({ id: 'profile-old' }),
      profile({ id: 'profile-closed' }),
    ]
    sessionDelivered('profile-cc', [bucket()], { sessionId: 'sc' })
    sessionDelivered('profile-primary', [bucket()], { sessionId: 'sp' })
    sessionDelivered('profile-old', [bucket()], { sessionId: 'so', ageMs: LIVE_USAGE_MAX_AGE_MS + 1 })
    const timeoutSpy = vi.spyOn(global, 'setTimeout')
    const rows = await fetchAllAccountsUsage()
    // Only the closed account calls, so there is nothing to space out.
    expect(requestedHosts).toEqual([USAGE_HOST])
    expect(timeoutSpy.mock.calls.filter((c) => c[1] === 300)).toHaveLength(0)
    expect(rows.map((r) => r.inSession === true)).toEqual([true, true, true, false])
    timeoutSpy.mockRestore()
  })
})

describe('fetchAllAccountsUsageStreaming: per-account delivery in load order (plan P3)', () => {
  it('calls onResult once per account, in listProfiles order, and the batch API collects the same set', async () => {
    profiles = [
      profile({ id: 'profile-open-1' }), profile({ id: 'profile-closed-2' }), profile({ id: 'profile-open-3' }),
    ]
    sessionDelivered('profile-open-1', [bucket({ percent: 10 })], { sessionId: 's1' })
    sessionDelivered('profile-open-3', [bucket({ percent: 30 })], { sessionId: 's3' })

    const streamed: string[] = []
    await fetchAllAccountsUsageStreaming((u) => streamed.push(u.profileId))
    expect(streamed).toEqual(['profile-open-1', 'profile-closed-2', 'profile-open-3'])

    // The batch shape returns the same rows (it is the streaming fn collected).
    const rows = await fetchAllAccountsUsage()
    expect(rows.map((r) => r.profileId)).toEqual(['profile-open-1', 'profile-closed-2', 'profile-open-3'])
  })

  it('delivers an OPEN account before a slower CLOSED one that precedes it in a stagger', async () => {
    // open-1 is served instantly; closed-2 waits a stagger only if it is not first.
    profiles = [profile({ id: 'profile-open-1' }), profile({ id: 'profile-closed-2' })]
    sessionDelivered('profile-open-1', [bucket({ percent: 5 })], { sessionId: 's1' })

    const order: Array<{ id: string; hadCall: boolean }> = []
    await fetchAllAccountsUsageStreaming((u) => order.push({ id: u.profileId, hadCall: u.buckets[0]?.percent !== 5 }))
    // open-1 lands first, from its delivered figure (percent 5, no call); closed-2 after.
    expect(order[0]).toEqual({ id: 'profile-open-1', hadCall: false })
    expect(order[1].id).toBe('profile-closed-2')
    expect(requestedHosts).toEqual([USAGE_HOST]) // only the closed account called
  })

  it('propagates a throw from onResult (the caller owns its handler)', async () => {
    profiles = [profile({ id: 'profile-open-1' })]
    sessionDelivered('profile-open-1', [bucket()], { sessionId: 's1' })
    await expect(fetchAllAccountsUsageStreaming(() => { throw new Error('handler boom') })).rejects.toThrow('handler boom')
  })
})

describe('the delivered figure belongs to the profile whose folder holds the transcript (P3.2, Switch account)', () => {
  it('a write from the session\'s previous run under another profile is not filed under its current one', async () => {
    inUse.add('profile-x-1')
    profileBySession.set('sess-1', 'profile-x-1')
    // The previous run's transcript lies in another profile's folder.
    recordLiveUsageForSession('sess-1', [bucket({ percent: 99 })], false, transcriptOf('sess-1', 'profile-old-1'))
    const r = await fetchAccountUsage('profile-x-1')
    // Nothing was delivered for profile-x-1: it waits for its session, and asks nothing.
    expect(requestedHosts).toEqual([])
    expect(r.status).toBe('waiting')
    expect(r.buckets?.some((b) => b.percent === 99) ?? false).toBe(false)
  })

  it('with no transcript path nothing is recorded, as for a default-home session', async () => {
    inUse.add('profile-x-1')
    profileBySession.set('sess-1', 'profile-x-1')
    recordLiveUsageForSession('sess-1', [bucket({ percent: 98 })], false)
    recordLiveUsageForSession('sess-1', [bucket({ percent: 97 })], false, 42)
    const r = await fetchAccountUsage('profile-x-1')
    expect(r.status).toBe('waiting')
    expect(requestedHosts).toEqual([])
  })

  it('its own transcript files it (the same write, the right folder)', async () => {
    inUse.add('profile-x-1')
    profileBySession.set('sess-1', 'profile-x-1')
    recordLiveUsageForSession('sess-1', [bucket({ percent: 41 })], false, transcriptOf('sess-1'))
    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([])
    expect(r.buckets?.[0]?.percent).toBe(41)
  })
})
