// Fetches Anthropic usage for EVERY account profile without opening a session.
//
// Each account profile has its own OAuth credentials file (its isolated home),
// so we can read that account's access token and call the same usage endpoint
// the live statusline uses — no PTY, no fake session.
//
// Accounts stay signed in (the refresh token is long-lived); only the short-lived
// access token lapses between sessions. When it lapses we mint a fresh one from
// the refresh token ourselves (see refreshProfileToken) so an idle-but-signed-in
// account still shows live usage without opening a session. That refresh is
// heavily guarded (below) because refresh tokens ROTATE — a careless refresh that
// raced Claude Code's own refresh, or failed to persist, would log the account out.
// We surface a "Sign in" prompt ONLY when an account has no credentials at all.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { listProfiles, getProfileConfigDir, readProfileAccountEmail, atomicWriteSecure, hardenCredentialFile, credentialFoldersVerdict } from '../account-profiles'
import { isAccountActive } from '../../shared/account-types'
import type { AccountProfile } from '../../shared/account-types'
import { isProfileInUseByLiveSession, getClaudeProfileId, sessionsOnProfile } from '../claude-account-identity'
import { noteProfileRefreshInFlight } from '../profile-consumers'
import { parseUsage } from './usage-buckets'
import { loadSnapshots, saveSnapshots, type UsageSnapshot } from './usage-snapshots'
import type { AccountUsage, UsageBucket, CreditsInfo } from '../../shared/usage-types'
import { logWarn, logInfo } from '../debug-logger'

export type { AccountUsage } from '../../shared/usage-types'

interface StoredCreds {
  token: string | null
  expiresAt: number
  refreshToken: string | null
  /** The credentials file we actually read/parsed — where a refresh writes back. */
  credsPath: string | null
  /** True when the account has credential material (a refresh/access token) or a
   *  credentials file we just couldn't parse this instant. Only when this is FALSE
   *  do we treat the account as genuinely signed out (and show a "Sign in" prompt). */
  signedIn: boolean
}

/** Space consecutive account fetches out so a batch doesn't burst the usage
 *  endpoint's per-IP rate limit (the old Promise.all drew 429s on valid tokens). */
const STAGGER_MS = 300
/** Max 429 retries per account before giving up and reporting the error. */
const MAX_429_RETRIES = 3
/** Claude Code's public OAuth client id — used for the refresh_token grant. If it
 *  ever changes, refresh just gets rejected (no rotation, no harm) and we fall back
 *  to showing last-known usage / the "open a session" hint. */
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Parse a Retry-After header (delta-seconds form; capped at 10s). Null when
 *  absent or not a plain number (HTTP-date form is not sent by this endpoint). */
function parseRetryAfterMs(header: string | string[] | undefined): number | null {
  const v = Array.isArray(header) ? header[0] : header
  if (!v) return null
  const secs = Number(v)
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs * 1000, 10_000) : null
}

/** Read a profile's OAuth tokens + expiry + signed-in state from its isolated
 *  credentials file (falling back to global ~/.claude for the primary account).
 *  Retries a couple of times on a read/parse failure: Claude Code rewrites this
 *  file on its own token refresh, and a single read can catch it mid-write — a
 *  transient parse failure would otherwise masquerade as "not signed in". Async
 *  only for the retry backoff. Never throws. */
async function readProfileToken(profileId: string, isPrimary: boolean): Promise<StoredCreds> {
  const candidates = [path.join(getProfileConfigDir(profileId), '.claude', '.credentials.json')]
  if (isPrimary) candidates.push(path.join(os.homedir(), '.claude', '.credentials.json'))
  let fileSeen = false
  for (const p of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let raw: string
      try {
        raw = fs.readFileSync(p, 'utf8')
      } catch (e) {
        // Missing at this path -> try the next candidate. Any other read error
        // (e.g. a rename gap during Claude's refresh) gets one brief retry.
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT' || attempt >= 2) break
        await sleep(60)
        continue
      }
      fileSeen = true
      try {
        const c = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown } }
        const oauth = c.claudeAiOauth
        const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken : null
        const refreshToken = typeof oauth?.refreshToken === 'string' && oauth.refreshToken.length > 0 ? oauth.refreshToken : null
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : 0
        return { token, expiresAt, refreshToken, credsPath: p, signedIn: !!token || !!refreshToken }
      } catch {
        // Parsed nothing — likely caught the file mid-rewrite. Brief retry.
        if (attempt < 2) await sleep(60)
      }
    }
  }
  // Never parsed a token. A credentials file that EXISTS but wouldn't parse is a
  // transient read, not a sign-out, so keep signedIn true to avoid a false "Sign
  // in"; only a genuinely absent file is treated as signed out.
  return { token: null, expiresAt: 0, refreshToken: null, credsPath: null, signedIn: fileSeen }
}

export type RawResult =
  | { ok: true; data: unknown }
  | { ok: false; httpStatus: number | null; retryAfterMs: number | null }

/** GET api.anthropic.com/api/oauth/usage with a bearer token. Resolves the
 *  parsed JSON, or an { httpStatus, retryAfterMs } marker on a non-2xx (so
 *  401 -> token lapsed, 429 -> caller backs off and retries). */
async function fetchUsageRaw(token: string): Promise<RawResult> {
  const https = await import('https')
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + token,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/2.1.34',
        },
        timeout: 8000,
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          const status = res.statusCode ?? null
          if (status && status >= 200 && status < 300) {
            try { resolve({ ok: true, data: JSON.parse(body) }) }
            catch { resolve({ ok: false, httpStatus: status, retryAfterMs: null }) }
          } else {
            resolve({ ok: false, httpStatus: status, retryAfterMs: parseRetryAfterMs(res.headers['retry-after']) })
          }
        })
      },
    )
    req.on('error', () => resolve({ ok: false, httpStatus: null, retryAfterMs: null }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, httpStatus: null, retryAfterMs: null }) })
    req.end()
  })
}

/** Run `fetch` and retry on HTTP 429 with backoff, honouring Retry-After when
 *  present. The usage endpoint burst-rate-limits by IP, so a batch of accounts
 *  can 429 even with a valid token. Exported for testing; `sleepFn` is injectable
 *  so tests exercise the retry logic without waiting real time. */
export async function fetchWithRetry(
  fetch: () => Promise<RawResult>,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<RawResult> {
  let res = await fetch()
  for (let attempt = 1; attempt <= MAX_429_RETRIES && !res.ok && res.httpStatus === 429; attempt++) {
    await sleepFn(res.retryAfterMs ?? attempt * 600)
    res = await fetch()
  }
  return res
}

// ── Token refresh ─────────────────────────────────────────────────────────
//
// Minting a fresh access token from the refresh token. This is the ONLY way to
// read usage for an account that's been idle long enough for its access token to
// lapse, without opening a session. It is guarded at the call site (fetchAccountUsage):
// only for signed-in accounts, only when the token is actually lapsed, and only when
// NO live session exists for the profile (so it can't race Claude Code's own refresh
// and rotate the token out from under a running session).

/** POST console.anthropic.com/v1/oauth/token with a refresh_token grant. */
async function postTokenRefresh(refreshToken: string): Promise<{ ok: true; data: unknown } | { ok: false }> {
  const https = await import('https')
  const payload = JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID })
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'console.anthropic.com',
        path: '/v1/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'claude-code/2.1.34',
        },
        timeout: 10_000,
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          const s = res.statusCode ?? 0
          if (s >= 200 && s < 300) {
            try { resolve({ ok: true, data: JSON.parse(body) }) } catch { resolve({ ok: false }) }
          } else {
            resolve({ ok: false })
          }
        })
      },
    )
    req.on('error', () => resolve({ ok: false }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }) })
    req.write(payload)
    req.end()
  })
}

/** Pure parse of a token-refresh response into the fields we persist. Exported +
 *  `now` injectable for testing. Returns null unless BOTH new tokens are present
 *  (a rotation that dropped the refresh token would be unsafe to persist). */
export function parseRefreshResponse(
  data: unknown,
  now: number = Date.now(),
): { accessToken: string; refreshToken: string; expiresAt: number } | null {
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  const accessToken = typeof o.access_token === 'string' && o.access_token.length > 0 ? o.access_token : null
  const refreshToken = typeof o.refresh_token === 'string' && o.refresh_token.length > 0 ? o.refresh_token : null
  const expiresIn = typeof o.expires_in === 'number' ? o.expires_in : null
  if (!accessToken || !refreshToken) return null
  return { accessToken, refreshToken, expiresAt: expiresIn ? now + expiresIn * 1000 : 0 }
}

/** Atomically write refreshed tokens back into the credentials file, preserving
 *  every other field in `claudeAiOauth`. temp-file + rename so the file is never
 *  observed half-written by a concurrently-starting Claude.
 *
 *  Rotation safety: re-reads the file and ABORTS (returning false, file untouched)
 *  when its refresh token is no longer the one we spent on the grant — another
 *  writer (a /login completing in a login shell, or Claude's own refresh) rotated
 *  the lineage mid-flight, and theirs is NEWER; overwriting would destroy a live
 *  sign-in. Transient write errors are retried: the server-side rotation already
 *  happened, so giving up too easily would strand the account on a dead token.
 *
 *  Written only while the folder that holds the file still has a passing
 *  owner-only verdict in this run (the one checked before the refresh began):
 *  a folder replaced meanwhile is not written into. */
async function writeRefreshedCreds(
  credsPath: string,
  spentRefreshToken: string,
  t: { accessToken: string; refreshToken: string; expiresAt: number },
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!credentialFoldersVerdict([path.dirname(credsPath)]).ok) {
      logWarn('[account-usage] the sign-in folder no longer has a passing owner-only check; the refreshed token was not written')
      return false
    }
    try {
      const raw = fs.readFileSync(credsPath, 'utf8')
      const c = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }
      const current = c.claudeAiOauth?.refreshToken
      if (typeof current === 'string' && current.length > 0 && current !== spentRefreshToken) {
        logWarn('[account-usage] credentials rotated by another writer during refresh — keeping theirs, discarding ours')
        return false
      }
      c.claudeAiOauth = { ...(c.claudeAiOauth ?? {}), accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt }
      atomicWriteSecure(credsPath, JSON.stringify(c, null, 2), 0o600)
      // This path had no re-assert, unlike account-profiles' writeCredentialFile.
      // Keep the two credential writers symmetric so neither is a lone weak point.
      hardenCredentialFile(credsPath)
      return true
    } catch (e) {
      if (attempt < 2) { await sleep(100); continue }
      logWarn(`[account-usage] failed to persist refreshed token after retries: ${(e as Error)?.message ?? e}`)
    }
  }
  return false
}

/** Per-profile in-flight guard so two concurrent fetches (fetchAll + a manual
 *  refreshOne) never double-refresh the same account and rotate twice. */
const refreshInFlight = new Map<string, Promise<{ accessToken: string; expiresAt: number } | null>>()

/** Mint + persist a fresh access token for a profile. Returns the new access
 *  token/expiry, or null on any failure (in which case credentials are untouched
 *  — a failed refresh NEVER logs the account out). */
async function refreshProfileToken(profileId: string, refreshToken: string, credsPath: string): Promise<{ accessToken: string; expiresAt: number } | null> {
  const existing = refreshInFlight.get(profileId)
  if (existing) return existing
  const run = (async () => {
    const res = await postTokenRefresh(refreshToken)
    if (!res.ok) { logWarn(`[account-usage] token refresh rejected for profile=${profileId}`); return null }
    const parsed = parseRefreshResponse(res.data)
    if (!parsed) { logWarn(`[account-usage] token refresh response unparseable for profile=${profileId}`); return null }
    // Persist the ROTATED tokens immediately (a Claude spawning right now re-reads
    // this file for its own refresh, so landing the new lineage fast is what keeps
    // it signed in). writeRefreshedCreds aborts instead when ANOTHER writer rotated
    // mid-flight — their sign-in is newer than our rotation, keep theirs.
    if (!(await writeRefreshedCreds(credsPath, refreshToken, parsed))) return null
    logInfo(`[account-usage] refreshed access token for profile=${profileId}`)
    return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt }
  })()
  refreshInFlight.set(profileId, run)
  // #49: publish the rotation so a consumer that starts NOW (a session, a
  // headless run, a cloud agent) waits for the new lineage to land instead of
  // reading a credential file whose refresh token this POST is about to spend.
  // Registered synchronously with the guard check that let us get here, so no
  // consumer can slip between "not in use" and "rotating".
  noteProfileRefreshInFlight(profileId, run)
  try { return await run } finally { refreshInFlight.delete(profileId) }
}

/** Last successful usage per profile. When a later fetch can't complete but the
 *  account is still signed in (lapsed token, 429 burst, network blip), we show
 *  these last-known figures flagged stale instead of blanking the card.
 *
 *  This used to be memory-only and was cleared on restart, which meant the one
 *  case it was most wanted in -- reopening the app and picking an account before
 *  any session has run -- was the one case it could not serve. It is now backed
 *  by usage-snapshots.json (see usage-snapshots.ts): the same map, rehydrated
 *  once per process and written through on every success. Nothing about the
 *  DECISION changes -- `resolveUsageOutcome` already models "stale figures with
 *  an age" and the UI already renders `stale` + `fetchedAt`. */
const lastGoodUsage = new Map<string, UsageSnapshot>()

let snapshotsLoaded = false

/** Rehydrate from disk once per process, on first use. */
function hydrateSnapshots(): void {
  if (snapshotsLoaded) return
  snapshotsLoaded = true
  for (const [id, snap] of loadSnapshots()) lastGoodUsage.set(id, snap)
}

// -- An account a running session uses is never fetched (plan P2; aicc_planning#378) --
//
// An account with a running Claude Code session already has its usage on
// screen: that session's status line read it seconds ago and the watcher
// fanned the buckets out (`recordLiveUsageForSession`, wired to the status
// line's fan-out through setStatuslineUsageSink in main/index). The page uses
// that and makes no request of its own for the account: no GET and no token
// refresh, for the primary account as for any other (the owner, 2026-11-21:
// asking again is where the page's problems came from). The page shows the
// newest figure it has for the account, the session's or the last one fetched
// while the account had no session, with its time (inSessionUsage):
//  - a figure older than LIVE_USAGE_MAX_AGE_MS is shown as not updated since
//    then (`stale`, with `inSession`, so the card does not call it a refresh
//    that failed);
//  - the status line carries no credits figure (its `rateLimitExtra` has no
//    currency), so the credits row shows the last fetched credits with the
//    time of that fetch, or no row;
//  - with no figure yet, the card waits for the session (`waiting`), or says
//    Not signed in when the account has no sign-in at all (read from its
//    credentials file; nothing goes on the network).
// Accounts with no running session are fetched as before, one at a time.
//
// "A running session" is a Claude Code session on the profile now
// (sessionsOnProfile). The other things that hold a profile (the sign-in
// probe, headless and Insights runs, cloud agents, a plain shell under the
// account) report no status line, so an account only they hold is fetched as
// before; the token refresh still waits for every one of them
// (isProfileInUseByLiveSession, at the refresh in fetchAccountUsage).

/** How old a figure may be and still be shown as current. A session's status
 *  line updates while it works; past this (a session idle for a while) its
 *  figure is shown as not updated since then. It is never fetched instead. */
export const LIVE_USAGE_MAX_AGE_MS = 90_000

interface LiveUsageEntry {
  buckets: UsageBucket[]
  fetchedAt: number
}

/** Latest session-delivered usage per profile: one entry per open account,
 *  overwritten on each statusline tick and read only for an in-use account. */
const liveUsageByProfile = new Map<string, LiveUsageEntry>()

/** A delivered bucket, defensively -- the local bridge file is trusted, but a
 *  malformed record must not paint wrong numbers on the account page. */
function isLiveBucket(v: unknown): v is UsageBucket {
  if (!v || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  return typeof b.key === 'string' && typeof b.label === 'string' && typeof b.group === 'string'
    && typeof b.percent === 'number' && Number.isFinite(b.percent) && typeof b.resetsAt === 'string'
}

/** Which profile's folder a transcript lies in (the Tokenomics folder rule,
 *  profileOfTranscript), set by main; unset, nothing is recorded. */
let transcriptProfileOf: ((transcriptPath: string) => string | undefined) | null = null
export function setLiveUsageTranscriptProfile(resolve: ((transcriptPath: string) => string | undefined) | null): void {
  transcriptProfileOf = resolve
}

/**
 * Record the usage a live session just delivered, keyed by the PROFILE it runs
 * under (the primary's as any other's), and only when the session's
 * transcript lies in that profile's folder (profileOfTranscript). An empty or
 * all-malformed set is ignored (nothing to show), and an SSH or default-home
 * session has no local profile id so it stores nothing. `hasCredits` is not
 * kept: the status line has no credits figure to show, so the credits row
 * comes from the last fetch (see newestFigure).
 */
export function recordLiveUsageForSession(sessionId: string, buckets: unknown, hasCredits: boolean, transcriptPath?: unknown, now: number = Date.now()): void {
  const profileId = getClaudeProfileId(sessionId)
  if (!profileId) return
  // The figure is this profile's only when the session that wrote it keeps its
  // transcript in this profile's folder: a write from the session's previous
  // run under another profile (Switch account keeps the session id) is not
  // filed here. With no transcript path nothing is recorded, as for a
  // default-home session.
  let owner: string | undefined
  try { owner = typeof transcriptPath === 'string' && transcriptProfileOf ? transcriptProfileOf(transcriptPath) : undefined } catch { owner = undefined }
  if (owner !== profileId) return
  if (!Array.isArray(buckets)) return
  const clean = buckets.filter(isLiveBucket)
  if (clean.length === 0) return
  liveUsageByProfile.set(profileId, { buckets: clean, fetchedAt: now })
}

/** Whether a Claude Code session runs on the profile now: the page then
 *  shows the account without a request (inSessionUsage). */
function hasRunningSession(profileId: string): boolean {
  return sessionsOnProfile(profileId).length > 0
}

interface ShownFigure {
  buckets: UsageBucket[]
  fetchedAt: number
  credits?: CreditsInfo
  /** When the credits were fetched, set only when that is not `fetchedAt`. */
  creditsFetchedAt?: number
}

/** The newest figure the page has for a profile: the one its sessions last
 *  delivered, or the last one fetched (usage-snapshots.json), whichever is
 *  newer, or undefined for none. A delivered figure has no credits, so it
 *  takes the last fetched credits, with the time of that fetch. */
function newestFigure(profileId: string): ShownFigure | undefined {
  const live = liveUsageByProfile.get(profileId)
  const last = lastGoodUsage.get(profileId)
  if (live && (!last || live.fetchedAt >= last.fetchedAt)) {
    const shown: ShownFigure = { buckets: live.buckets, fetchedAt: live.fetchedAt }
    if (last?.credits) { shown.credits = last.credits; shown.creditsFetchedAt = last.fetchedAt }
    return shown
  }
  if (!last) return undefined
  const shown: ShownFigure = { buckets: last.buckets, fetchedAt: last.fetchedAt }
  if (last.credits) shown.credits = last.credits
  return shown
}

/**
 * What the page shows for an account a running session uses, with no request
 * of any kind (see the block comment above): the newest figure, current when
 * it is at most LIVE_USAGE_MAX_AGE_MS old and otherwise not updated since
 * then; with no current figure, Not signed in when the account has no sign-in
 * at all (its credentials file is read, nothing is refreshed), else the older
 * figure, else `waiting`.
 */
async function inSessionUsage(base: AccountUsage, profileId: string, isPrimary: boolean, now: number = Date.now()): Promise<AccountUsage> {
  const figure = newestFigure(profileId)
  const show = (f: ShownFigure, stale: boolean): AccountUsage => {
    const out: AccountUsage = { ...base, status: 'ok', inSession: true, stale, buckets: f.buckets, fetchedAt: f.fetchedAt }
    if (f.credits) out.credits = f.credits
    if (f.creditsFetchedAt !== undefined) out.creditsFetchedAt = f.creditsFetchedAt
    return out
  }
  if (figure && now - figure.fetchedAt <= LIVE_USAGE_MAX_AGE_MS) return show(figure, false)
  const creds = await readProfileToken(profileId, isPrimary)
  if (!creds.signedIn) return { ...base, status: 'needs-login', detail: 'not signed in' }
  if (figure) return show(figure, true)
  return { ...base, status: 'waiting', inSession: true, detail: "waiting for this account's session" }
}

/** Whether fetchAllAccountsUsageStreaming should count a profile toward the
 *  network stagger: active, with no running session (fetchAccountUsage's own
 *  rule: an account a session uses is shown without a request). */
function accountUsageWillNetwork(profile: AccountProfile): boolean {
  return isAccountActive(profile) && !hasRunningSession(profile.id)
}

/** Test seam: the live cache is module state and outlives a test file otherwise. */
export function _resetLiveUsageForTest(): void { liveUsageByProfile.clear() }

/** Test seam: reset the hydrate latch + last-good map so a test can seed fresh
 *  snapshots. Without it the once-per-process hydrate keeps the first test's view. */
export function _resetSnapshotsForTest(): void { lastGoodUsage.clear(); snapshotsLoaded = false }

/** Pure decision: given the account's signed-in state, whether its token was
 *  usable, the fetch result (if we made one), and any cached usage, produce the
 *  AccountUsage to show. Exported + pure so the whole state matrix is unit-tested. */
export function resolveUsageOutcome(
  base: AccountUsage,
  input: { signedIn: boolean; tokenUsable: boolean; fetch?: RawResult },
  cached: { buckets: UsageBucket[]; credits?: CreditsInfo; fetchedAt: number } | undefined,
): AccountUsage {
  // Genuinely signed out (no credentials at all) is the ONLY "Sign in" case.
  if (!input.signedIn) return { ...base, status: 'needs-login', detail: 'not signed in' }

  const staleOr = (fallback: AccountUsage): AccountUsage =>
    cached
      ? { ...base, status: 'ok', stale: true, buckets: cached.buckets, credits: cached.credits, fetchedAt: cached.fetchedAt }
      : fallback

  const refreshHint: AccountUsage = { ...base, status: 'error', detail: 'signed in — open a session to refresh' }

  // Signed in but no usable token, or we never fetched -> can't fetch live; show
  // last-known usage, else a soft refresh hint. Never "Sign in".
  if (!input.tokenUsable || !input.fetch) return staleOr(refreshHint)

  const res = input.fetch
  if (!res.ok) {
    // A 401/403 on a signed-in account means the token lapsed just now -> soft refresh.
    if (res.httpStatus === 401 || res.httpStatus === 403) return staleOr(refreshHint)
    // 429-after-retries / network error -> last-known if we have it, else the error.
    return staleOr({ ...base, status: 'error', detail: res.httpStatus ? `HTTP ${res.httpStatus}` : 'network error' })
  }
  const parsed = parseUsage(res.data)
  return { ...base, status: 'ok', stale: false, buckets: parsed.buckets, credits: parsed.credits }
}

/** Usage track MP3, D5: whether Claude Code's usage may be read now. Set at
 *  start from main's launch rule (provider-launch-gate.ts,
 *  providerProbeRefusal), injected rather than imported for the same reason
 *  as setClaudeCliProbeAllowed: that rule's accounts graph must not load
 *  here. Set before the usage handlers are registered; until then usage is
 *  read as it always was. An answer that throws is a no (fail closed). */
let usageAllowed: () => boolean = () => true

export function setClaudeAccountDataAllowed(allowed: () => boolean): void {
  usageAllowed = allowed
}

/** Whether anything of Claude Code may be read for the usage surfaces now
 *  (the Account usage page and the credential state it and Insights show). */
export function claudeAccountDataAllowed(): boolean {
  try { return usageAllowed() === true } catch { return false }
}

/** An account's `off` result: names from the profile list only, nothing read. */
function offUsage(profile: AccountProfile | undefined, profileId: string): AccountUsage {
  return {
    profileId,
    email: profile?.accountEmail || null,
    name: profile?.name || 'Account',
    isPrimary: !!profile?.isPrimary,
    active: profile ? isAccountActive(profile) : true,
    status: 'off',
    buckets: [],
    fetchedAt: Date.now(),
  }
}

const KNOWN_LABELS_MAX = 64
const KNOWN_LABEL_MAX_LENGTH = 64

/**
 * The bucket labels of the saved figures (usage-snapshots.json) and the live
 * ones sessions delivered, once each, in first-seen order: what the Settings
 * toggles list, with no network call and no credential read (usage track MP3).
 * Bounded: at most 64 labels of at most 64 characters.
 */
export function knownUsageLabels(): string[] {
  hydrateSnapshots()
  const out: string[] = []
  const add = (buckets: UsageBucket[]) => {
    for (const b of buckets) {
      const l = typeof b?.label === 'string' ? b.label : ''
      if (!l || l.length > KNOWN_LABEL_MAX_LENGTH || out.includes(l)) continue
      if (out.length >= KNOWN_LABELS_MAX) return
      out.push(l)
    }
  }
  for (const snap of lastGoodUsage.values()) add(snap.buckets)
  for (const live of liveUsageByProfile.values()) add(live.buckets)
  return out
}

/**
 * Fetch usage for one profile. Signed-out -> needs-login; signed-in but not
 * fetchable -> last-known (stale) or a soft refresh hint; success -> fresh.
 * Auto-refreshes a lapsed token (guarded) so idle accounts still show live usage.
 * An account a running session uses is not fetched at all: it shows that
 * session's figure (inSessionUsage).
 *
 * `noRefresh` suppresses the single-use refresh-token rotation entirely (#447):
 * the account-switch snapshot fires this the instant BEFORE the session
 * respawns onto the same profile, and the live-session guard cannot see that
 * imminent consumer yet — so a rotation here would spend the very token the
 * child is about to use and log the account out. With `noRefresh` a lapsed
 * token simply falls back to the last-known snapshot; a valid token still
 * fetches live. Never rotates, so it is always safe next to a spawn.
 */
export async function fetchAccountUsage(profileId: string, opts?: { noRefresh?: boolean }): Promise<AccountUsage> {
  const profiles = listProfiles()
  const profile = profiles.find((p) => p.id === profileId)
  // D5: Claude Code switched off (or its setting unreadable) reads nothing:
  // before the credential file is located, before any refresh, before any GET.
  if (!claudeAccountDataAllowed()) return offUsage(profile, profileId)
  hydrateSnapshots()
  const isPrimary = !!profile?.isPrimary
  const active = profile ? isAccountActive(profile) : true
  const base: AccountUsage = {
    profileId,
    email: profile?.accountEmail || readProfileAccountEmail(profileId),
    name: profile?.name || 'Account',
    isPrimary,
    active,
    status: 'error',
    buckets: [],
    fetchedAt: Date.now(),
  }
  if (!profile) return { ...base, detail: 'unknown profile' }

  // Parked account: list it, but do NO network poll and NO token refresh. A
  // refresh rotates the single-use token — doing that to an account the user
  // deliberately parked is the opposite of parked, and burns a request against
  // the IP burst limit for a card that only needs to say "inactive". Return
  // before readProfileToken/refresh/fetch so none of that runs.
  if (!active) return { ...base, status: 'inactive' }

  // An account a running session uses (plan P2; aicc_planning#378): its usage
  // is that session's own status line figure, so it is never fetched, the
  // primary as any other: no GET and no refresh, whatever the figure's age,
  // its credits or whether one has arrived yet (inSessionUsage).
  if (hasRunningSession(profileId)) return inSessionUsage(base, profileId, isPrimary)

  const creds = await readProfileToken(profileId, isPrimary)
  let token = creds.token
  let expiresAt = creds.expiresAt
  // 60s skew guard: a token within 60s of expiry is treated as unusable so we
  // don't burn a request that will 401.
  let tokenUsable = !!token && !(expiresAt > 0 && expiresAt < Date.now() + 60_000)

  // Auto-refresh a lapsed token so an idle-but-signed-in account still shows live
  // usage without opening a session. GUARDS (all must hold): signed in, we have a
  // refresh token + the creds path to write back, the token is actually lapsed,
  // NOT the primary profile, and no live session is using this profile. Refresh
  // tokens rotate (single-use), so a careless refresh here logs the account out:
  //  - PRIMARY is excluded outright: its credentials are shared with the global
  //    ~/.claude (credsPath can literally BE the global file), which `claude` runs
  //    OUTSIDE CCC read — rotating under them strands every external terminal.
  //    Non-primary profiles live in CCC-managed isolated homes, so their only
  //    consumers are things CCC knows about, and the live-session guard below
  //    covers them.
  //  - isProfileInUseByLiveSession covers interactive sessions (the identity
  //    maps) AND every registered consumer in profile-consumers.ts: the
  //    `claude auth status` probe (#258), and since #48 the headless spawner,
  //    Insights runs, cloud agents and the profile-pinned shell-only shells
  //    (plain shells + the add-account /login shell) -- each of which reads,
  //    and can rotate, the profile's token for as long as it runs.
  //  - The other ordering (#49) is closed by the refresh itself: it publishes
  //    its in-flight promise (noteProfileRefreshInFlight) and a consumer that
  //    starts mid-rotation waits for it (waitForProfileRefresh) before reading
  //    the credential file.
  //  - The refresh rewrites the account's sign-in, so it runs only when the
  //    folder that holds it has passed the app's owner-only check in this run
  //    (credentialFoldersVerdict, which only reads the verdict; with none yet it
  //    starts the check, so a later fetch may refresh). Refused or not yet
  //    checked: no token is spent and nothing is written; the card falls back
  //    as with noRefresh.
  if (!opts?.noRefresh && !tokenUsable && creds.signedIn && creds.refreshToken && creds.credsPath && !isPrimary && !isProfileInUseByLiveSession(profileId) && credentialFoldersVerdict([path.dirname(creds.credsPath)]).ok) {
    const refreshed = await refreshProfileToken(profileId, creds.refreshToken, creds.credsPath)
    if (refreshed) {
      token = refreshed.accessToken
      expiresAt = refreshed.expiresAt
      tokenUsable = true
    }
  }

  let fetched: RawResult | undefined
  if (creds.signedIn && tokenUsable && token) {
    fetched = await fetchWithRetry(() => fetchUsageRaw(token))
    if (!fetched.ok && fetched.httpStatus && fetched.httpStatus !== 401 && fetched.httpStatus !== 403) {
      logWarn(`[account-usage] fetch failed profile=${profileId} http=${fetched.httpStatus}`)
    }
  }

  const result = resolveUsageOutcome(base, { signedIn: creds.signedIn, tokenUsable, fetch: fetched }, lastGoodUsage.get(profileId))
  if (result.status === 'ok' && !result.stale) {
    lastGoodUsage.set(profileId, { buckets: result.buckets, credits: result.credits, fetchedAt: result.fetchedAt })
    saveSnapshots(lastGoodUsage)
  }
  return result
}

/** Fetch usage for every account, sequentially with a small stagger between
 *  accounts. The usage endpoint burst-rate-limits by IP, so firing every account
 *  at once (the old Promise.all) drew 429s on otherwise-valid tokens. Order
 *  matches listProfiles (primary first is the store's responsibility). */
export async function fetchAllAccountsUsage(): Promise<AccountUsage[]> {
  // The batch shape, for callers that want the whole set at once (SettingsPage).
  // The streaming variant owns the ordering, pacing and the hydrate-before-stagger
  // fix; this collects its results in order.
  const out: AccountUsage[] = []
  await fetchAllAccountsUsageStreaming((usage) => out.push(usage))
  return out
}

/**
 * Fetch every account's usage in the same order and pacing as fetchAllAccountsUsage,
 * but deliver each result to `onResult` AS IT RESOLVES rather than collecting them
 * into one array (plan P3): the usage page shows a skeleton per account up front and
 * fills each row when its result lands -- open accounts resolve instantly (no call),
 * closed ones as their staggered calls arrive. `onResult` is called once per account,
 * in listProfiles order; a throw in it is the caller's problem, not this loop's.
 * `shouldContinue`, when given, is asked before each account's stagger and
 * again before its call: a caller that no longer wants the rest (its window
 * closed, or it opened a newer stream) stops the loop there rather than after a
 * fan-out nobody will read (adversarial pass on #598). Accounts already
 * delivered are not affected; the promise still resolves.
 */
export async function fetchAllAccountsUsageStreaming(
  onResult: (usage: AccountUsage) => void,
  opts: { shouldContinue?: () => boolean } = {},
): Promise<void> {
  // Hydrate once, before the first account (fetchAccountUsage would on its
  // first call): an account a running session uses shows the last fetched
  // figure and credits from it.
  hydrateSnapshots()
  const profiles = listProfiles()
  const wanted = () => !opts.shouldContinue || opts.shouldContinue()
  let networkedCount = 0
  for (const p of profiles) {
    if (!wanted()) return
    // An account a running session uses (plan P2) makes no request, so --
    // like a parked account -- it must not consume a stagger slot, or N open
    // accounts would add N*STAGGER_MS of dead wait before a closed one loads.
    // D5: with Claude Code switched off an account makes none either (it
    // comes back `off` from fetchAccountUsage, which asks the rule itself, so
    // a switch-off during the stream holds for the rest of it).
    const willNetwork = claudeAccountDataAllowed() && accountUsageWillNetwork(p)
    if (willNetwork && networkedCount > 0) await sleep(STAGGER_MS)
    if (!wanted()) return
    onResult(await fetchAccountUsage(p.id))
    if (willNetwork) networkedCount++
  }
}
