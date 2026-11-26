// src/main/usage/remote-tab-usage.ts
/**
 * The per-model weekly bars and extra usage of a tab through the session
 * helper on another machine (2.1.3-beta.19 section 3, aicc_planning#434), from
 * this computer, never the host. Such a tab runs on its machine's own sign-in;
 * the helper there reads no credential and calls no network, so the only
 * reading of that account's usage is this computer's own, and only for an
 * account this computer holds: an account profile whose email is the one the
 * tab's start read on the host. Its figure is the Account usage page's
 * (account-usage.ts fetchAccountUsage: a running session's own status line
 * figure when one reports it, else its own read), asked at most once per
 * REMOTE_TAB_USAGE_MAX_AGE_MS for each account, however many tabs and
 * status ticks ask, and never twice at once. For an account it does not
 * hold, nothing is read: the strip says "not available" with the reason.
 *
 * Pure but for what its deps do: the caller (statusline-watcher.ts) hands the
 * account list and the usage read.
 */
import { canonicaliseEmail } from '../../shared/account-chip-color'
import type { RateLimitExtra, RemoteUsageNotShown } from '../../shared/types'
import type { AccountUsage, UsageBucket } from '../../shared/usage-types'

/** How long one usage read of an account serves every helper tab on it: the
 *  60 s the usual SSH status line keeps its own read for (statusline-gather.ts). */
export const REMOTE_TAB_USAGE_MAX_AGE_MS = 60_000

/** What a helper tab's strip shows of its account's usage: the bars and the
 *  extra usage block (switched off when the account has none), or why not. */
export type RemoteTabUsage =
  | { shown: true; buckets: UsageBucket[]; extra: RateLimitExtra }
  | { shown: false; why: RemoteUsageNotShown }

/** Extra usage the strip does not draw: the account has none switched on. */
export const EXTRA_USAGE_OFF: RateLimitExtra = Object.freeze({ enabled: false, utilization: 0, usedUsd: 0, limitUsd: 0 })

/** The account profile on this computer whose email is `email`, by the
 *  canonical form (case and spaces aside), or undefined when it holds none. */
export function heldProfileFor(email: string, profiles: ReadonlyArray<{ id: string; accountEmail?: string }>): string | undefined {
  const want = typeof email === 'string' ? canonicaliseEmail(email) : ''
  if (!want) return undefined
  return profiles.find((p) => typeof p.accountEmail === 'string' && p.accountEmail !== '' && canonicaliseEmail(p.accountEmail) === want)?.id
}

/** A bucket the strip can draw: its label and a percent from 0 to 100. */
function drawable(b: UsageBucket | null | undefined): b is UsageBucket {
  return !!b && typeof b.label === 'string' && b.label !== '' && typeof b.percent === 'number' && Number.isFinite(b.percent) && b.percent >= 0 && b.percent <= 100
}

/**
 * What the strip shows from one usage read of a held account: its buckets
 * (session, weekly and per-model weekly, as the Account usage page has them)
 * and its extra usage, as the usual SSH status line builds that block
 * (statusline-gather.ts applyUsage: used and the monthly limit, its share of
 * it); a read that is not `ok`, or has no bucket to draw, is `no-reading`:
 * never an empty or zero bar.
 */
export function usageViewOf(u: AccountUsage | null | undefined): RemoteTabUsage {
  if (!u || u.status !== 'ok') return { shown: false, why: 'no-reading' }
  const buckets = (Array.isArray(u.buckets) ? u.buckets : []).filter(drawable)
  if (buckets.length === 0) return { shown: false, why: 'no-reading' }
  const c = u.credits
  if (!c || c.enabled !== true || typeof c.used !== 'number' || !Number.isFinite(c.used)) return { shown: true, buckets, extra: EXTRA_USAGE_OFF }
  const limit = typeof c.limit === 'number' && Number.isFinite(c.limit) && c.limit > 0 ? c.limit : 0
  return { shown: true, buckets, extra: { enabled: true, utilization: limit > 0 ? Math.round((c.used / limit) * 100) : 0, usedUsd: c.used, limitUsd: limit } }
}

export interface RemoteTabUsageDeps {
  /** One usage read of an account profile (account-usage.ts fetchAccountUsage). */
  usage(profileId: string): Promise<AccountUsage>
  now?: () => number
  maxAgeMs?: number
}

/** The newest usage view of each held account, read at most once per max age and never twice at once. */
export class RemoteTabUsageReader {
  private readonly last = new Map<string, { view: RemoteTabUsage; at: number }>()
  private readonly flying = new Map<string, Promise<RemoteTabUsage>>()
  constructor(private readonly deps: RemoteTabUsageDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** The newest view read for the profile, or undefined before its first read lands. */
  newest(profileId: string): RemoteTabUsage | undefined {
    return this.last.get(profileId)?.view
  }

  /** Whether a read of the profile is due: none in flight, and none yet or the last older than the max age. */
  due(profileId: string): boolean {
    if (this.flying.has(profileId)) return false
    const last = this.last.get(profileId)
    return !last || this.now() - last.at >= (this.deps.maxAgeMs ?? REMOTE_TAB_USAGE_MAX_AGE_MS)
  }

  /** The profile's view: the newest when no read is due, the one in flight
   *  when one runs, else one new read. A read that throws is `no-reading`. */
  read(profileId: string): Promise<RemoteTabUsage> {
    const flying = this.flying.get(profileId)
    if (flying) return flying
    const last = this.last.get(profileId)
    if (last && !this.due(profileId)) return Promise.resolve(last.view)
    const p = (async (): Promise<RemoteTabUsage> => {
      let view: RemoteTabUsage
      try {
        view = usageViewOf(await this.deps.usage(profileId))
      } catch {
        view = { shown: false, why: 'no-reading' }
      }
      this.last.set(profileId, { view, at: this.now() })
      return view
    })()
    this.flying.set(profileId, p)
    void p.finally(() => { if (this.flying.get(profileId) === p) this.flying.delete(profileId) })
    return p
  }
}
