// The Account usage page renews a still-valid Claude sign-in itself, and asks
// the user to sign in again only when the sign-in has truly expired
// (nubbymong/aicc_planning#444).
//
//  - The app's own renewal posts to the address Claude Code itself uses,
//    platform.claude.com/v1/oauth/token, and saves the new refresh token's
//    expiry (refresh_token_expires_in), so the countdown matches the CLI's.
//  - Each answer is read by its status alone (for a 400 or 401, the OAuth
//    error code alone): invalid_grant is an expired sign-in ("Sign in
//    again", needs-login); a redirect, a server error, a network failure, an
//    answer that cannot be read, or any other refusal is tried again on the
//    next read (the card says Refreshing).
//  - The primary account, and an account whose sign-in folder has no
//    owner-only verdict yet in this run, renew through Claude Code's own
//    `claude auth status` (the injected renewal), never through the app's POST
//    and never through `claude -p`.
//  - A profile signed in to the same account as another, or to a different
//    account than its label, is asked to sign in again, and nothing is renewed.
//
// No process starts and nothing goes on the network: the CLI renewal is a
// stand-in, https is faked, the account folders are a temp dir, and every
// token is synthetic.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as nodeOs from 'node:os'
import * as path from 'node:path'
import type { AccountProfile } from '../../src/shared/account-types'
import { USAGE_DETAIL_DUPLICATE, USAGE_DETAIL_EXPIRED, USAGE_DETAIL_NOT_SIGNED_IN, USAGE_DETAIL_WRONG_ACCOUNT } from '../../src/shared/usage-types'

const h = vi.hoisted(() => ({
  root: '',
  profiles: [] as AccountProfile[],
  folder: { ok: true } as { ok: true } | { ok: false; message: string },
  inUse: new Set<string>(),
  /** Every https request, as "<host><path>". */
  requests: [] as string[],
  /** The token address's answer: a status and body, or a network failure. */
  tokenAnswer: { status: 200, body: '' } as { status: number; body: string } | 'network',
  /** Runs while the token answer is on its way (a test may rotate the file then). */
  duringToken: () => {},
  /** Order of the primary's sign-in syncs and the CLI renewal. */
  calls: [] as string[],
  logs: [] as string[],
}))

const REFUSED = 'refused for this test'
vi.mock('../../src/main/account-profiles', () => ({
  listProfiles: () => h.profiles,
  getProfileConfigDir: (id: string) => path.join(h.root, id),
  readProfileAccountEmail: () => null,
  atomicWriteSecure: (p: string, data: string) => { fs.writeFileSync(p, data) },
  hardenCredentialFile: () => {},
  credentialFoldersVerdict: () => h.folder,
  CREDENTIAL_FOLDER_REFUSAL: REFUSED,
  syncPrimaryCredentialsWithGlobal: () => { h.calls.push('sync'); return 'none' },
}))
// The primary's fallback to the global ~/.claude must never reach the real home.
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>()
  const homedir = () => path.join(h.root, 'not-the-real-home')
  return { ...real, homedir, default: { ...real, homedir } }
})
vi.mock('../../src/main/claude-account-identity', () => ({
  isProfileInUseByLiveSession: (id: string) => h.inUse.has(id),
  sessionsOnProfile: () => [],
  getClaudeProfileId: () => undefined,
}))
vi.mock('../../src/main/usage/usage-snapshots', () => ({ loadSnapshots: () => new Map(), saveSnapshots: () => true }))
vi.mock('../../src/main/debug-logger', () => ({
  logWarn: (m: string) => { h.logs.push(m) },
  logInfo: (m: string) => { h.logs.push(m) },
}))

const USAGE_BODY = JSON.stringify({ five_hour: { utilization: 7, resets_at: null } })
vi.mock('https', () => {
  const request = (opts: { hostname?: string; path?: string }, cb: (res: unknown) => void) => {
    const at = `${opts?.hostname}${opts?.path}`
    h.requests.push(at)
    const isUsage = opts?.hostname === 'api.anthropic.com'
    const handlers: Record<string, (() => void) | undefined> = {}
    const answer = isUsage ? { status: 200, body: USAGE_BODY } : h.tokenAnswer
    const req = {
      on: (ev: string, fn: () => void) => { handlers[ev] = fn; return req },
      write: () => {},
      destroy: () => {},
      setTimeout: () => {},
      end: () => {
        queueMicrotask(() => {
          if (!isUsage) h.duringToken()
          if (answer === 'network') { handlers.error?.(); return }
          const res = {
            statusCode: answer.status,
            headers: {},
            on: (ev: string, fn: (arg?: unknown) => void) => { if (ev === 'data') fn(answer.body); if (ev === 'end') fn(); return res },
          }
          cb(res)
        })
      },
    }
    return req
  }
  return { default: { request }, request }
})

const usage = await import('../../src/main/usage/account-usage')
const { fetchAccountUsage, setClaudeCliRenewal, setClaudeSignInProblem, _resetSnapshotsForTest } = usage

const P = 'profile-mren01-a1b2c3'
const PRIMARY = 'profile-mren02-d4e5f6'
const TOKEN_AT = 'platform.claude.com/v1/oauth/token'
const OLD_TOKEN_AT = 'console.anthropic.com/v1/oauth/token'
const USAGE_AT = 'api.anthropic.com/api/oauth/usage'
const SPENT = ['rt', 'test', 'OLD'].join('-')
const NEW_RT = ['rt', 'test', 'NEW'].join('-')
const OLD_REFRESH_EXPIRY = 1_700_000_000_000
const DAY_S = 86_400

const credsPath = (id: string) => path.join(h.root, id, '.claude', '.credentials.json')
function writeCreds(id: string, over: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(credsPath(id)), { recursive: true })
  fs.writeFileSync(credsPath(id), JSON.stringify({
    claudeAiOauth: { accessToken: 'at-test-OLD', refreshToken: SPENT, expiresAt: 1, refreshTokenExpiresAt: OLD_REFRESH_EXPIRY, subscriptionType: 'max', ...over },
  }))
}
const oauthOf = (id: string) => (JSON.parse(fs.readFileSync(credsPath(id), 'utf8')) as { claudeAiOauth: Record<string, unknown> }).claudeAiOauth
const profile = (over: Partial<AccountProfile>): AccountProfile => ({ id: P, name: 'B', accountEmail: 'b@example.test', createdAt: 1, ...over })
const renewed = (extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: JSON.stringify({ access_token: 'at-test-NEW', refresh_token: NEW_RT, expires_in: 3600, ...extra }),
})
/** The "Refreshing" answer: signed in, no fresh figure, never needs-login. */
const expectRefreshing = (r: { status: string; detail?: string }) => {
  expect(r.status).toBe('error')
  expect(r.detail).toMatch(/^signed in/)
}

const PREFIX = 'ccc-usage-renewal-'
beforeEach(() => {
  h.root = fs.realpathSync.native(fs.mkdtempSync(path.join(nodeOs.tmpdir(), PREFIX)))
  h.profiles = [profile({})]
  h.folder = { ok: true }
  h.inUse.clear()
  h.requests.length = 0
  h.tokenAnswer = renewed()
  h.duringToken = () => {}
  h.calls.length = 0
  h.logs.length = 0
  setClaudeCliRenewal(null)
  setClaudeSignInProblem(null)
  _resetSnapshotsForTest()
  writeCreds(P)
})

afterEach(() => {
  setClaudeCliRenewal(null)
  setClaudeSignInProblem(null)
  // TEST CLEANUP GUARD: this suite's own temp folder only.
  if (h.root && path.basename(h.root).startsWith(PREFIX)) fs.rmSync(h.root, { recursive: true, force: true })
})

describe('the app renews a lapsed sign-in at the address Claude Code itself uses', () => {
  it('posts to platform.claude.com/v1/oauth/token, never console.anthropic.com, then reads usage fresh', async () => {
    const r = await fetchAccountUsage(P)
    expect(h.requests).toEqual([TOKEN_AT, USAGE_AT])
    expect(h.requests).not.toContain(OLD_TOKEN_AT)
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(false)
  })

  it('saves the new refresh token expiry from refresh_token_expires_in, so the countdown is the new token\'s', async () => {
    h.tokenAnswer = renewed({ refresh_token_expires_in: 30 * DAY_S })
    const before = Date.now()
    await fetchAccountUsage(P)
    const after = Date.now()
    const o = oauthOf(P)
    expect(o.refreshToken).toBe(NEW_RT)
    expect(o.refreshTokenExpiresAt).toBeGreaterThanOrEqual(before + 30 * DAY_S * 1000)
    expect(o.refreshTokenExpiresAt).toBeLessThanOrEqual(after + 30 * DAY_S * 1000)
    expect(o.subscriptionType).toBe('max') // every other field kept
  })

  it('an answer that returns the SAME refresh token with no expiry keeps the expiry still in force', async () => {
    h.tokenAnswer = { status: 200, body: JSON.stringify({ access_token: 'at-test-NEW', refresh_token: SPENT, expires_in: 3600 }) }
    await fetchAccountUsage(P)
    expect(oauthOf(P).accessToken).toBe('at-test-NEW')
    expect(oauthOf(P).refreshToken).toBe(SPENT)
    expect(oauthOf(P).refreshTokenExpiresAt).toBe(OLD_REFRESH_EXPIRY)
  })

  it('an answer with no refresh_token_expires_in drops the spent token\'s expiry rather than keep counting it down', async () => {
    await fetchAccountUsage(P)
    expect(oauthOf(P).refreshToken).toBe(NEW_RT)
    expect(oauthOf(P).refreshTokenExpiresAt).toBeUndefined()
  })
})

describe('each answer of the token address, by its status, to the card\'s state', () => {
  const lapsedStays = () => {
    expect(oauthOf(P).refreshToken).toBe(SPENT)
    expect(oauthOf(P).refreshTokenExpiresAt).toBe(OLD_REFRESH_EXPIRY)
  }

  it('400 invalid_grant: the sign-in has expired, Sign in again (needs-login), nothing written, no usage read', async () => {
    h.tokenAnswer = { status: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token expired' }) }
    const r = await fetchAccountUsage(P)
    expect(r.status).toBe('needs-login')
    expect(r.detail).toBe(USAGE_DETAIL_EXPIRED)
    expect(h.requests).toEqual([TOKEN_AT])
    lapsedStays()
  })

  it('401 invalid_grant: expired too', async () => {
    h.tokenAnswer = { status: 401, body: JSON.stringify({ error: 'invalid_grant' }) }
    expect((await fetchAccountUsage(P)).status).toBe('needs-login')
  })

  it('401 and 403 without invalid_grant: not proof the sign-in expired, Refreshing', async () => {
    for (const answer of [
      { status: 401, body: JSON.stringify({ error: 'invalid_client' }) },
      { status: 403, body: '<html>blocked</html>' },
      { status: 403, body: JSON.stringify({ error: 'access_denied' }) },
    ]) {
      h.tokenAnswer = answer
      expectRefreshing(await fetchAccountUsage(P))
      lapsedStays()
    }
  })

  it('a redirect (3xx): Refreshing, never expired', async () => {
    for (const status of [301, 302, 307, 308]) {
      h.tokenAnswer = { status, body: JSON.stringify({ error: 'invalid_grant' }) }
      expectRefreshing(await fetchAccountUsage(P))
      lapsedStays()
    }
  })

  it('a server error (5xx): Refreshing, never expired, even with invalid_grant in the body', async () => {
    for (const status of [500, 502, 503, 504]) {
      h.tokenAnswer = { status, body: JSON.stringify({ error: 'invalid_grant' }) }
      const r = await fetchAccountUsage(P)
      expect(r.status).not.toBe('needs-login')
      expectRefreshing(r)
      lapsedStays()
    }
  })

  it('a network failure: Refreshing, never expired', async () => {
    h.tokenAnswer = 'network'
    expectRefreshing(await fetchAccountUsage(P))
    lapsedStays()
  })

  it('an answer that cannot be read (a 2xx with a malformed body, or one missing a token): Refreshing', async () => {
    for (const answer of [
      { status: 200, body: '{not json' },
      { status: 200, body: JSON.stringify({ access_token: 'at-test-NEW', expires_in: 3600 }) },
      { status: 400, body: 'not json either' },
    ]) {
      h.tokenAnswer = answer
      expectRefreshing(await fetchAccountUsage(P))
      lapsedStays()
    }
  })

  it('invalid_grant after another writer rotated the sign-in meanwhile: theirs is live, Refreshing, their file kept', async () => {
    h.tokenAnswer = { status: 400, body: JSON.stringify({ error: 'invalid_grant' }) }
    h.duringToken = () => writeCreds(P, { refreshToken: NEW_RT, expiresAt: Date.now() + 3_600_000 })
    expectRefreshing(await fetchAccountUsage(P))
    expect(oauthOf(P).refreshToken).toBe(NEW_RT)
  })

  it('a cached figure is shown stale (not Sign in again) when the renewal is to be tried again', async () => {
    h.tokenAnswer = { status: 503, body: '' }
    // A first, successful read leaves a figure behind.
    writeCreds(P, { expiresAt: Date.now() + 3_600_000 })
    expect((await fetchAccountUsage(P)).status).toBe('ok')
    writeCreds(P)
    const r = await fetchAccountUsage(P)
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(true)
  })

  it('never logs the token address\'s body or a token', async () => {
    h.tokenAnswer = { status: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: 'secret-ish words' }) }
    await fetchAccountUsage(P)
    h.tokenAnswer = { status: 500, body: 'server words' }
    await fetchAccountUsage(P)
    const all = h.logs.join('\n')
    expect(all).not.toContain('secret-ish words')
    expect(all).not.toContain('server words')
    expect(all).not.toContain(SPENT)
  })
})

describe('the primary account renews through `claude auth status`, never through the app\'s POST', () => {
  beforeEach(() => {
    h.profiles = [profile({ id: PRIMARY, isPrimary: true, accountEmail: 'p@example.test' })]
    writeCreds(PRIMARY)
  })

  it('takes the status route: the CLI renewal runs for it, no POST, and the renewed token reads usage fresh', async () => {
    const renew = vi.fn(async (id: string) => {
      h.calls.push(`cli:${id}`)
      writeCreds(id, { accessToken: 'at-test-CLI', refreshToken: NEW_RT, expiresAt: Date.now() + 3_600_000 })
    })
    setClaudeCliRenewal(renew)
    const r = await fetchAccountUsage(PRIMARY)
    expect(renew).toHaveBeenCalledTimes(1)
    expect(renew).toHaveBeenCalledWith(PRIMARY)
    expect(h.requests).toEqual([USAGE_AT])
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(false)
  })

  it('keeps the global sign-in in step: synced before (a fresher one is used) and after (the renewed one goes back)', async () => {
    setClaudeCliRenewal(async (id: string) => {
      h.calls.push(`cli:${id}`)
      writeCreds(id, { expiresAt: Date.now() + 3_600_000 })
    })
    await fetchAccountUsage(PRIMARY)
    expect(h.calls).toEqual(['sync', `cli:${PRIMARY}`, 'sync'])
  })

  it('a status route that does not renew (Q6): Refreshing, never Sign in again; the terminal route stays the way', async () => {
    const renew = vi.fn(async () => ({ authenticated: true }))
    setClaudeCliRenewal(renew)
    const r = await fetchAccountUsage(PRIMARY)
    expect(renew).toHaveBeenCalledTimes(1)
    expect(h.requests).toEqual([])
    expectRefreshing(r)
  })

  it('`claude auth status` says the primary is NOT signed in and its token stays lapsed: Sign in again (expired)', async () => {
    setClaudeCliRenewal(async () => ({ authenticated: false, source: 'cli-status' }))
    const r = await fetchAccountUsage(PRIMARY)
    expect(r.status).toBe('needs-login')
    expect(r.detail).toBe(USAGE_DETAIL_EXPIRED)
    expect(h.requests).toEqual([])
  })

  // Review P4-8: with no credentials file in the primary's own home, the app
  // reads ~/.claude's sign-in, but `auth status` ran in the empty profile home:
  // its "not signed in" says nothing about ~/.claude's sign-in.
  it('the CLI says signed out but the sign-in read is ~/.claude\'s (the profile home has none): Refreshing, not expired', async () => {
    fs.rmSync(credsPath(PRIMARY))
    const globalCreds = path.join(h.root, 'not-the-real-home', '.claude', '.credentials.json')
    fs.mkdirSync(path.dirname(globalCreds), { recursive: true })
    fs.writeFileSync(globalCreds, JSON.stringify({ claudeAiOauth: { accessToken: 'at-test-GLOBAL', refreshToken: SPENT, expiresAt: 1 } }))
    const renew = vi.fn(async () => ({ authenticated: false, source: 'cli-status' }))
    setClaudeCliRenewal(renew)
    const r = await fetchAccountUsage(PRIMARY)
    expect(renew).toHaveBeenCalledTimes(1)
    expect(r.status).not.toBe('needs-login')
    expectRefreshing(r)
  })

  it('a signed-out answer that is not the CLI\'s own (not checked, or the file fallback) is not an expiry', async () => {
    for (const answer of [{ authenticated: false, notChecked: 'Claude Code is off' }, { authenticated: false, source: 'credential-file' }, null, 'no']) {
      setClaudeCliRenewal(async () => answer)
      expectRefreshing(await fetchAccountUsage(PRIMARY))
    }
  })

  it('the CLI says signed out but the token is usable after it: read as renewed', async () => {
    setClaudeCliRenewal(async (id: string) => {
      writeCreds(id, { expiresAt: Date.now() + 3_600_000 })
      return { authenticated: false, source: 'cli-status' }
    })
    expect((await fetchAccountUsage(PRIMARY)).status).toBe('ok')
  })

  it('a status route that throws: Refreshing, nothing sent', async () => {
    setClaudeCliRenewal(async () => { throw new Error('the CLI did not answer') })
    expectRefreshing(await fetchAccountUsage(PRIMARY))
    expect(h.requests).toEqual([])
  })

  it('no route set: the primary is not renewed and nothing is sent (today\'s behaviour)', async () => {
    expectRefreshing(await fetchAccountUsage(PRIMARY))
    expect(h.requests).toEqual([])
  })

  it('a primary in use by a session or a probe is not renewed', async () => {
    const renew = vi.fn(async () => undefined)
    setClaudeCliRenewal(renew)
    h.inUse.add(PRIMARY)
    await fetchAccountUsage(PRIMARY)
    expect(renew).not.toHaveBeenCalled()
  })

  it('with noRefresh (the account-switch snapshot) the status route does not run either', async () => {
    const renew = vi.fn(async () => undefined)
    setClaudeCliRenewal(renew)
    await fetchAccountUsage(PRIMARY, { noRefresh: true })
    expect(renew).not.toHaveBeenCalled()
  })

  it('a usable token is read directly: no renewal', async () => {
    const renew = vi.fn(async () => undefined)
    setClaudeCliRenewal(renew)
    writeCreds(PRIMARY, { expiresAt: Date.now() + 3_600_000 })
    expect((await fetchAccountUsage(PRIMARY)).status).toBe('ok')
    expect(renew).not.toHaveBeenCalled()
    expect(h.requests).toEqual([USAGE_AT])
  })
})

describe('an account whose sign-in folder has no owner-only verdict yet renews through the status route', () => {
  it('no verdict yet: the CLI renewal runs, the app sends no POST', async () => {
    h.folder = { ok: false, message: 'not checked yet' }
    const renew = vi.fn(async (id: string) => { writeCreds(id, { expiresAt: Date.now() + 3_600_000 }) })
    setClaudeCliRenewal(renew)
    const r = await fetchAccountUsage(P)
    expect(renew).toHaveBeenCalledWith(P)
    expect(h.requests).toEqual([USAGE_AT])
    expect(r.status).toBe('ok')
    // Not the primary: its sign-in is not synced with the global one.
    expect(h.calls).toEqual([])
  })

  it('a not-yet-checked folder\'s CLI saying signed out is not taken as expired (the next read renews it through the app)', async () => {
    h.folder = { ok: false, message: 'not checked yet' }
    setClaudeCliRenewal(async () => ({ authenticated: false, source: 'cli-status' }))
    expectRefreshing(await fetchAccountUsage(P))
  })

  it('the CLI found no sign-in left: Sign in again (missing)', async () => {
    h.folder = { ok: false, message: 'not checked yet' }
    setClaudeCliRenewal(async (id: string) => { fs.rmSync(credsPath(id)) })
    const r = await fetchAccountUsage(P)
    expect(r.status).toBe('needs-login')
    expect(r.detail).toBe(USAGE_DETAIL_NOT_SIGNED_IN)
  })

  it('a refused folder: neither route runs and nothing is written', async () => {
    h.folder = { ok: false, message: REFUSED }
    const renew = vi.fn(async () => undefined)
    setClaudeCliRenewal(renew)
    await fetchAccountUsage(P)
    expect(renew).not.toHaveBeenCalled()
    expect(h.requests).toEqual([])
    expect(oauthOf(P).refreshToken).toBe(SPENT)
  })

  it('a folder that passed takes the app\'s own POST, not the status route', async () => {
    const renew = vi.fn(async () => undefined)
    setClaudeCliRenewal(renew)
    await fetchAccountUsage(P)
    expect(renew).not.toHaveBeenCalled()
    expect(h.requests[0]).toBe(TOKEN_AT)
  })
})

const DUP = { kind: 'duplicate' as const, account: 'b@example.test', profileIds: ['profile-mren09-000009'] }
const WRONG = { kind: 'wrong-account' as const, signedInAs: 'c@example.test', labelledAs: 'b@example.test' }

describe('a duplicate or wrong-account sign-in is asked to sign in again, and is not renewed', () => {
  it('signed in to the same account as another profile: needs-login, no POST, no usage read', async () => {
    setClaudeSignInProblem((id) => (id === P ? DUP : null))
    const r = await fetchAccountUsage(P)
    expect(r.status).toBe('needs-login')
    expect(r.detail).toBe(USAGE_DETAIL_DUPLICATE)
    // The card names the twin and the account from the reading itself.
    expect(r.signInProblem).toEqual(DUP)
    expect(h.requests).toEqual([])
    expect(oauthOf(P).refreshToken).toBe(SPENT)
  })

  it('signed in as a different account than its label: needs-login, nothing sent', async () => {
    setClaudeSignInProblem(() => WRONG)
    writeCreds(P, { expiresAt: Date.now() + 3_600_000 })
    const r = await fetchAccountUsage(P)
    expect(r.status).toBe('needs-login')
    expect(r.detail).toBe(USAGE_DETAIL_WRONG_ACCOUNT)
    expect(r.signInProblem).toEqual(WRONG)
    expect(h.requests).toEqual([])
  })

  it('a check that throws or answers nothing known is no problem: renewed as before', async () => {
    setClaudeSignInProblem(() => { throw new Error('unreadable') })
    expect((await fetchAccountUsage(P)).status).toBe('ok')
    for (const odd of ['duplicate', { kind: 'duplicate' }, { kind: 'duplicate', account: 'x', profileIds: [] }, { kind: 'wrong-account', signedInAs: 'a' }, { kind: 'other' }]) {
      setClaudeSignInProblem(() => odd as never)
      writeCreds(P)
      expect((await fetchAccountUsage(P)).status).toBe('ok')
    }
  })

  it('a profile with no sign-in at all says not signed in, before any identity check', async () => {
    setClaudeSignInProblem(() => DUP)
    fs.rmSync(credsPath(P))
    const r = await fetchAccountUsage(P)
    expect(r.status).toBe('needs-login')
    expect(r.detail).toBe(USAGE_DETAIL_NOT_SIGNED_IN)
  })
})
