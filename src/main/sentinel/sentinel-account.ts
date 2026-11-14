// Which account Sentinel's AI analysis ran on, and why, as its failure
// message says it (owner report, 2.1.3-beta.1). Pure: the service reads the
// settings and the account lists and asks here for the words.
//
// The rule both labels follow: a failure names the account that was actually
// used and how it came to be used, and "auto-picked" is said only with the
// reason that is true: an account the user can still see chosen in Settings
// could not be used, the primary account could not be used, or none is set. A
// saved choice whose account has since gone shows as the default in Settings
// (SettingsPage.tsx), so here it is the default too: before, it was reported
// as "auto-picked, your chosen analysis account is no longer available" to a
// user whose Settings showed the default account.

/** A Claude account as the label needs it (account-profiles' AccountProfile). */
export interface AnalysisProfile {
  id: string
  accountEmail?: string
  isPrimary?: boolean
}

/**
 * The label for a Claude Code analysis run. `chosen`: the saved Sentinel
 * analysis account (settings.sentinelAccountProfileId), or null; `used`: the
 * account the run's home belongs to (resolveHeadlessProfileHome).
 */
export function claudeAnalysisAccountLabel(input: { chosen: string | null; used: string; profiles: readonly AnalysisProfile[] }): string {
  const { chosen, used, profiles } = input
  const mine = profiles.find((p) => p.id === used)
  // `||`, not `??`: an account not signed in yet has an empty address, and
  // an empty name would leave the message with no account to point at.
  const name = mine?.accountEmail || used
  // A choice stands only while Settings still lists its account.
  const stands = !!chosen && profiles.some((p) => p.id === chosen)
  if (stands) {
    return chosen === used
      ? `${name}, the account chosen in Settings`
      : `${name}; auto-picked — your chosen analysis account is no longer available`
  }
  if (mine?.isPrimary === true) return `${name}, the primary account`
  // Auto-picked, with the reason that is true (review finding): a primary
  // account that is set but could not be used (its folder is missing, so
  // resolveHeadlessProfileHome passed over it) was said as "no primary
  // account is set".
  return profiles.some((p) => p.isPrimary === true)
    ? `${name}; auto-picked — the primary account could not be used`
    : `${name}; auto-picked — no primary account is set`
}

/** How a Codex analysis run came by its account: `chosen` in Settings and
 *  used; `default`, the one Codex reviews run on (nothing chosen, or a saved
 *  choice Settings no longer offers); `fell-back`, chosen and still offered
 *  but it could not start, so the review account ran instead. */
export type CodexAnalysisAccountWhy = 'chosen' | 'default' | 'fell-back'

/** The label for a Codex analysis run. `name` is already prose-safe. */
export function codexAnalysisAccountLabel(name: string, why: CodexAnalysisAccountWhy): string {
  if (why === 'chosen') return `${name}, the account chosen in Settings`
  if (why === 'fell-back') return `${name}; auto-picked, your chosen analysis account could not be used`
  return `${name}, the Codex review account`
}
