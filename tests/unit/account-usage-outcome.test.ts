import { describe, it, expect } from 'vitest'
import { resolveUsageOutcome, parseRefreshResponse, classifyTokenAnswer, type RawResult } from '../../src/main/usage/account-usage'
import type { AccountUsage, UsageBucket } from '../../src/shared/usage-types'

const base: AccountUsage = {
  profileId: 'p1', email: 'a@b.c', name: 'A', isPrimary: false,
  status: 'error', buckets: [], fetchedAt: 1000,
}
const cachedBucket: UsageBucket = { key: 'session:', label: '5h', group: 'session', percent: 10, resetsAt: '', severity: 'normal' }
const cached = { buckets: [cachedBucket], credits: undefined, fetchedAt: 500 }

const ok = (data: unknown): RawResult => ({ ok: true, data })
const fail = (httpStatus: number | null): RawResult => ({ ok: false, httpStatus, retryAfterMs: null })

describe('resolveUsageOutcome — account panel state matrix', () => {
  it('signed OUT -> needs-login (the ONLY Sign in case)', () => {
    const r = resolveUsageOutcome(base, { signedIn: false, tokenUsable: false }, undefined)
    expect(r.status).toBe('needs-login')
    expect(r.detail).toBe('not signed in')
  })

  it('signed in + unusable token + no cache -> soft refresh hint, NOT Sign in', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: false }, undefined)
    expect(r.status).toBe('error')
    expect(r.detail).toMatch(/^signed in/)
  })

  it('signed in + unusable token + cache -> stale ok with cached figures', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: false }, cached)
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(true)
    expect(r.buckets).toEqual(cached.buckets)
    expect(r.fetchedAt).toBe(500) // shows the real age of the cached data
  })

  it('signed in + 401 + no cache -> soft refresh hint (never needs-login)', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: true, fetch: fail(401) }, undefined)
    expect(r.status).toBe('error')
    expect(r.detail).toMatch(/^signed in/)
  })

  it('signed in + 401 + cache -> stale ok', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: true, fetch: fail(401) }, cached)
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(true)
  })

  it('signed in + 429-after-retries + no cache -> error HTTP 429', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: true, fetch: fail(429) }, undefined)
    expect(r.status).toBe('error')
    expect(r.detail).toBe('HTTP 429')
  })

  it('signed in + 429 + cache -> stale ok (never blank a working account)', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: true, fetch: fail(429) }, cached)
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(true)
  })

  it('signed in + network error + no cache -> error network', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: true, fetch: fail(null) }, undefined)
    expect(r.status).toBe('error')
    expect(r.detail).toBe('network error')
  })

  it('signed in + success -> fresh ok (not stale), parsed buckets', () => {
    const data = { limits: [{ group: 'session', kind: 'session', percent: 42, resets_at: '', severity: 'normal' }] }
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: true, fetch: ok(data) }, cached)
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(false)
    expect(r.buckets.length).toBe(1)
    expect(r.buckets[0].label).toBe('5h')
    expect(r.buckets[0].percent).toBe(42)
  })
})

describe('parseRefreshResponse — token-refresh response parsing', () => {
  const NOW = 1_000_000

  it('parses a full response and computes expiresAt from expires_in', () => {
    const r = parseRefreshResponse({ access_token: 'sk-ant-oat01-new', refresh_token: 'rt-new', expires_in: 3600 }, NOW)
    expect(r).toEqual({ accessToken: 'sk-ant-oat01-new', refreshToken: 'rt-new', expiresAt: NOW + 3600 * 1000 })
  })

  it('returns null when the refresh_token is missing (never persist a dropped rotation)', () => {
    expect(parseRefreshResponse({ access_token: 'a', expires_in: 3600 }, NOW)).toBeNull()
  })

  it('returns null when the access_token is missing', () => {
    expect(parseRefreshResponse({ refresh_token: 'r', expires_in: 3600 }, NOW)).toBeNull()
  })

  it('returns null for a non-object / empty payload', () => {
    expect(parseRefreshResponse(null, NOW)).toBeNull()
    expect(parseRefreshResponse('nope', NOW)).toBeNull()
  })

  it('tolerates a missing expires_in (expiresAt 0)', () => {
    const r = parseRefreshResponse({ access_token: 'a', refresh_token: 'r' }, NOW)
    expect(r).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 0 })
  })
})

// nubbymong/aicc_planning#444: the refresh token's own expiry is saved, so the
// "Forced sign-in in N days" countdown is the new token's, not the spent one's.
describe('parseRefreshResponse: the new refresh token expiry', () => {
  const NOW = 1_000_000

  it('computes refreshTokenExpiresAt from refresh_token_expires_in', () => {
    const r = parseRefreshResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600, refresh_token_expires_in: 2_592_000 }, NOW)
    expect(r).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3600 * 1000, refreshTokenExpiresAt: NOW + 2_592_000 * 1000 })
  })

  it('leaves it out when the answer names none, or names one that is not a positive number', () => {
    for (const v of [undefined, 0, -5, '2592000', Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = parseRefreshResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600, refresh_token_expires_in: v }, NOW)
      expect(r).not.toBeNull()
      expect(r!.refreshTokenExpiresAt).toBeUndefined()
    }
  })
})

// nubbymong/aicc_planning#444: the token address's answer, by its status alone
// (for a 400 or 401, the OAuth error code alone). Only invalid_grant is an
// expired sign-in; everything else is tried again on the next read.
describe('classifyTokenAnswer: status-only classification', () => {
  const grant = JSON.stringify({ error: 'invalid_grant', error_description: 'expired' })

  it('a 2xx with a JSON body is renewed, with the parsed data', () => {
    expect(classifyTokenAnswer(200, '{"access_token":"a"}')).toEqual({ kind: 'renewed', data: { access_token: 'a' } })
  })

  it('a 2xx with a malformed body is retried, never renewed or expired', () => {
    expect(classifyTokenAnswer(200, '{oops')).toEqual({ kind: 'retry', httpStatus: 200 })
  })

  it('400 or 401 with invalid_grant is expired', () => {
    expect(classifyTokenAnswer(400, grant)).toEqual({ kind: 'expired', httpStatus: 400 })
    expect(classifyTokenAnswer(401, grant)).toEqual({ kind: 'expired', httpStatus: 401 })
  })

  it('400, 401 or 403 with any other error, or a body that is not JSON, is retried', () => {
    expect(classifyTokenAnswer(400, JSON.stringify({ error: 'invalid_request' }))).toEqual({ kind: 'retry', httpStatus: 400 })
    expect(classifyTokenAnswer(401, JSON.stringify({ error: 'invalid_client' }))).toEqual({ kind: 'retry', httpStatus: 401 })
    expect(classifyTokenAnswer(403, grant)).toEqual({ kind: 'retry', httpStatus: 403 })
    expect(classifyTokenAnswer(400, 'null')).toEqual({ kind: 'retry', httpStatus: 400 })
    expect(classifyTokenAnswer(400, '<html>')).toEqual({ kind: 'retry', httpStatus: 400 })
  })

  it('a redirect or a server error is retried, whatever its body says', () => {
    for (const s of [301, 302, 303, 307, 308, 500, 502, 503, 504]) {
      expect(classifyTokenAnswer(s, grant)).toEqual({ kind: 'retry', httpStatus: s })
    }
  })

  it('no status (a network failure or a time-out) is retried', () => {
    expect(classifyTokenAnswer(null, '')).toEqual({ kind: 'retry', httpStatus: null })
  })
})

describe('resolveUsageOutcome: Sign in again only when the user must sign in', () => {
  it('an expired sign-in is needs-login (session expired), even with a cached figure', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: false, expired: true }, cached)
    expect(r.status).toBe('needs-login')
    expect(r.detail).toBe('session expired')
    expect(r.buckets).toEqual([])
  })

  it('a duplicate or wrong-account sign-in is needs-login, with its reason', () => {
    expect(resolveUsageOutcome(base, { signedIn: true, tokenUsable: true, signInProblem: 'duplicate' }, cached)).toMatchObject({ status: 'needs-login', detail: 'duplicate account' })
    expect(resolveUsageOutcome(base, { signedIn: true, tokenUsable: true, signInProblem: 'wrong-account' }, cached)).toMatchObject({ status: 'needs-login', detail: 'wrong account' })
  })

  it('no sign-in at all is still the not-signed-in reason first', () => {
    expect(resolveUsageOutcome(base, { signedIn: false, tokenUsable: false, expired: true, signInProblem: 'duplicate' }, cached).detail).toBe('not signed in')
  })

  it('a lapsed token that is to be renewed again says Refreshing (signed in), never "open a session"', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: false }, undefined)
    expect(r.detail).toMatch(/^signed in/)
    expect(r.detail).not.toMatch(/open a session/)
  })
})
