/**
 * web-session-expiry.ts: keep an account's saved claude.ai session expiry in
 * step with its live session cookie.
 *
 * The record (session-store.ts) saves the sessionKey cookie's expiry once, at
 * sign-in, and statusOf compares that saved date with now. claude.ai renews the
 * cookie while the account is in use (the artifacts window, the pane), and
 * nothing rewrote the record, so the session chip read "expired" while the
 * account worked, and "Open artifacts" in the sidebar and Settings stayed
 * disabled with it (owner report, 2026-10-11). The status handlers call this
 * before they read the record, so every status read follows the live cookie.
 *
 * What is read is the cookie's METADATA only: its name and its expiry, mapped
 * straight to webSessionFromElectronCookies's { hasSessionCookie, expiresAt }.
 * The cookie's value is never kept, logged, saved or answered.
 *
 * What a status answer waits for:
 *   - a record whose saved expiry has passed waits for the live check, which
 *     is bounded (LIVE_EXPIRY_READ_BOUND_MS). That is the stale case this file
 *     exists for, a renewed cookie behind an "expired" record, so the answer
 *     carries the live state;
 *   - any other record answers from the file at once, as it always did, so
 *     the sidebar's read (accountWeb:webStatus) stays a local file read for an
 *     active account. Its check still runs, behind the answer, so the next
 *     read sees any change.
 *
 * Rules:
 *   - no record: nothing is read, so no partition is made for an account that
 *     never signed in (a status read must not mint one);
 *   - while the account's web session is being wiped: nothing is read or
 *     written;
 *   - only claude.ai's own cookie counts: the read is scoped to
 *     https://claude.ai, so a sessionKey another site set in the partition
 *     (a sign-in can pass through an identity provider's pages) is never read;
 *   - no session cookie in the partition (Chromium drops an expired one): the
 *     record is left exactly as it is, so a session that really expired still
 *     reads expired;
 *   - a live cookie with a different expiry: only expiresAt is rewritten, and
 *     only over the record this read saw (refreshWebSessionExpiry);
 *   - the cookie read is bounded, so a read that never lands cannot hold up
 *     the status answer.
 *
 * Never throws or rejects. No default export (project convention).
 */

import { session as electronSession } from 'electron'
import { CLAUDE_SESSION_COOKIE, webPartitionForProfile, type AccountWebSession } from '../../shared/account-web-session'
import { logError, logInfo } from '../debug-logger'
import { webSessionFromElectronCookies } from './cookie-harvest'
import { getWebSession, refreshWebSessionExpiry, statusOf } from './session-store'
import { isClaudeWebClearing } from './sign-in'

/** How long a status read on an expired record waits for the partition's
 *  cookie store. */
export const LIVE_EXPIRY_READ_BOUND_MS = 1_500

/** The origin whose cookies count. Electron's url filter returns only the
 *  cookies that would be sent to it. */
const CLAUDE_ORIGIN = 'https://claude.ai'

interface LiveSession {
  hasSessionCookie: boolean
  expiresAt: number | null
}

const DONE: Promise<void> = Promise.resolve()

/** The partition's session cookie, as metadata only; null when the read did
 *  not land within the bound or failed. */
function readLiveSession(profileId: string): Promise<LiveSession | null> {
  const ses = electronSession.fromPartition(webPartitionForProfile(profileId))
  // Mapped to metadata in the same step: the cookie objects (which carry the
  // value) go no further than this callback.
  const read = ses.cookies
    .get({ url: CLAUDE_ORIGIN, name: CLAUDE_SESSION_COOKIE })
    .then((cookies) => webSessionFromElectronCookies(cookies))
  return new Promise<LiveSession | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), LIVE_EXPIRY_READ_BOUND_MS)
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
    read.then(
      (live) => { clearTimeout(timer); resolve(live) },
      () => { clearTimeout(timer); resolve(null) },
    )
  })
}

/** Read the live cookie and, when its expiry differs from the record this
 *  call saw (`seen`), write it. Resolves once done. Never rejects. */
async function followLiveCookie(profileId: string, seen: AccountWebSession): Promise<void> {
  try {
    const live = await readLiveSession(profileId)
    if (!live || !live.hasSessionCookie) return
    if (live.expiresAt === seen.expiresAt) return
    // A wipe that started during the read: its record goes with it.
    if (isClaudeWebClearing(profileId)) return
    if (refreshWebSessionExpiry(profileId, seen, live.expiresAt)) {
      logInfo(`[account-web] ${profileId}: claude.ai session expiry updated from the live session`)
    }
  } catch (err) {
    logError(`[account-web] ${profileId}: could not check the live claude.ai session: ${(err as Error)?.message ?? err}`)
  }
}

/**
 * Bring the account's saved claude.ai expiry up to its live session cookie's,
 * when they differ. Resolves when the status answer may be read: once the
 * check is done for a record that reads expired, at once for any other (its
 * check runs on behind the answer). Never rejects.
 */
export function refreshClaudeWebExpiry(profileId: string): Promise<void> {
  try {
    const seen = getWebSession(profileId)
    if (!seen || isClaudeWebClearing(profileId)) return DONE
    const check = followLiveCookie(profileId, seen)
    return statusOf(seen, Date.now()) === 'expired' ? check : DONE
  } catch (err) {
    logError(`[account-web] ${profileId}: could not check the live claude.ai session: ${(err as Error)?.message ?? err}`)
    return DONE
  }
}
