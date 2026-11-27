// account-auth-info.ts — read what each profile's stored credentials say.
//
// Pure file reads: `<home>/.claude/.credentials.json` and `<home>/.claude.json`.
// No network, no `claude` spawn, so this is cheap enough to call whenever a panel
// opens and it serves three consumers:
//
//   * the accounts view -- days until a forced login, per account (#203)
//   * the duplicate/mismatch identity check (#202)
//   * layer 1 of the Insights pre-flight, "are there credentials at all" (#201)

import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { getProfileConfigDir, listProfiles } from './account-profiles'
import { canonicaliseEmail } from '../shared/account-chip-color'
import type { ProfileAuthInfo } from '../shared/account-auth'
import { isAccountActive, type AccountProfile } from '../shared/account-types'
import type { UsageSignInProblem } from '../shared/usage-types'
import { logWarn } from './debug-logger'

function readJson(file: string): any | null {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    // A profile mid-write, or a file the CLI wrote in a shape we don't expect.
    // Treated as "nothing readable" rather than throwing: one bad profile must
    // not take out the whole panel.
    return null
  }
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Read one profile's credential state. Never throws. */
export function readProfileAuthInfo(profileId: string, accountEmail?: string): ProfileAuthInfo {
  const home = getProfileConfigDir(profileId)
  const credentialsFile = join(home, '.claude', '.credentials.json')
  const creds = readJson(credentialsFile)?.claudeAiOauth
  const oauthEmail: string | undefined = readJson(join(home, '.claude.json'))?.oauthAccount?.emailAddress

  if (!creds) {
    return { profileId, accountEmail, oauthEmail, credentialsMissing: true }
  }
  // mtime, not a value inside the file: this is how "the user has signed in since
  // that failure" is established, and a fresh login rewrites the whole file.
  let credentialsUpdatedAt: number | undefined
  try {
    credentialsUpdatedAt = statSync(credentialsFile).mtimeMs
  } catch {
    credentialsUpdatedAt = undefined
  }
  return {
    profileId,
    accountEmail,
    oauthEmail,
    hasRefreshToken: typeof creds.refreshToken === 'string' && creds.refreshToken.length > 0,
    expiresAt: positiveNumber(creds.expiresAt),
    refreshTokenExpiresAt: positiveNumber(creds.refreshTokenExpiresAt),
    subscriptionType: typeof creds.subscriptionType === 'string' ? creds.subscriptionType : undefined,
    // The plan's usage tier ("Max 20x" on the Account usage page,
    // nubbymong/aicc_planning#445): display text, not a secret.
    ...(typeof creds.rateLimitTier === 'string' ? { rateLimitTier: creds.rateLimitTier } : {}),
    credentialsUpdatedAt
  }
}

/**
 * Read every profile's credential state and cross-check identities.
 *
 * `identityMismatch` is per-profile divergence (label vs home). `duplicateOfProfileIds`
 * is the cross-profile check, and it is the one that matters: two homes on one
 * account means each refresh rotates the token out from under the other.
 * Duplicates are matched on the HOME's identity, not the label, because the label
 * is the thing that gets silently rewritten.
 *
 * `quiet` leaves out the duplicate warning: the Account usage page asks once
 * per account it reads (readClaudeSignInProblem), and the panel's own read
 * already logs it.
 */
export function readAllProfileAuthInfo(opts: { quiet?: boolean } = {}): ProfileAuthInfo[] {
  return authInfoOf(listProfiles(), opts.quiet === true)
}

function authInfoOf(profiles: readonly AccountProfile[], quiet: boolean): ProfileAuthInfo[] {
  const infos = profiles.map((p) => readProfileAuthInfo(p.id, p.accountEmail))

  for (const info of infos) {
    if (info.oauthEmail && info.accountEmail) {
      info.identityMismatch = canonicaliseEmail(info.oauthEmail) !== canonicaliseEmail(info.accountEmail)
    }
  }

  const byIdentity = new Map<string, string[]>()
  for (const info of infos) {
    // Fall back to the label only when the home says nothing, so a profile with
    // no readable .claude.json isn't paired with everything else that lacks one.
    const identity = info.oauthEmail ?? info.accountEmail
    if (!identity) continue
    const key = canonicaliseEmail(identity)
    const list = byIdentity.get(key)
    if (list) list.push(info.profileId)
    else byIdentity.set(key, [info.profileId])
  }
  for (const [identity, ids] of byIdentity) {
    if (ids.length < 2) continue
    if (!quiet) logWarn(
      `[account-auth] ${ids.length} profiles resolve to ${identity} (${ids.join(', ')}) — ` +
      'each refresh will invalidate the others'
    )
    for (const id of ids) {
      const info = infos.find((i) => i.profileId === id)
      if (info) info.duplicateOfProfileIds = ids.filter((other) => other !== id)
    }
  }

  return infos
}

/**
 * Why a profile must be signed in again although it holds a sign-in, from the
 * cross-check above (nubbymong/aicc_planning#444). It stops the Account usage
 * page reading the account, so it is narrower than the panel's duplicate
 * warning (duplicateOfProfileIds, unchanged):
 * - `duplicate`: another profile is ACTIVE (in `activeIds`), holds a sign-in
 *   with a refresh token, and its own home is the same account as this one's
 *   home (the label is not proof). Only such a twin spends this profile's
 *   refresh token when it renews; a parked or signed-out one does not, and the
 *   working account keeps its reading. Named with the account and the twins.
 * - else `wrong-account`: this home is signed in to a different account than
 *   the profile's label. Named with both.
 * Null otherwise, or for a profile not in `infos`.
 */
export function signInProblemOf(infos: readonly ProfileAuthInfo[], profileId: string, activeIds: ReadonlySet<string>): UsageSignInProblem | null {
  const info = infos.find((i) => i.profileId === profileId)
  if (!info) return null
  if (info.oauthEmail) {
    const account = canonicaliseEmail(info.oauthEmail)
    const twins = infos
      .filter((o) => o.profileId !== profileId && activeIds.has(o.profileId)
        && !o.credentialsMissing && o.hasRefreshToken === true
        && !!o.oauthEmail && canonicaliseEmail(o.oauthEmail) === account)
      .map((o) => o.profileId)
    if (twins.length > 0) return { kind: 'duplicate', account: info.oauthEmail, profileIds: twins }
  }
  if (info.identityMismatch && info.oauthEmail && info.accountEmail) {
    return { kind: 'wrong-account', signedInAs: info.oauthEmail, labelledAs: info.accountEmail }
  }
  return null
}

/** signInProblemOf for one profile, read now (the profile list once, every
 *  profile's files, no warning logged): the check main hands the Account
 *  usage page (setClaudeSignInProblem). */
export function readClaudeSignInProblem(profileId: string): UsageSignInProblem | null {
  const profiles = listProfiles()
  const active = new Set(profiles.filter((p) => isAccountActive(p)).map((p) => p.id))
  return signInProblemOf(authInfoOf(profiles, true), profileId, active)
}
