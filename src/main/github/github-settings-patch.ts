import type {
  GitHubAppWideFeatureKey,
  GitHubAuthFeatureKey,
  GitHubConfig,
  GitHubSettingsPatch,
  GitHubSyncIntervals,
} from '../../shared/github-types'
import {
  DEFAULT_APP_WIDE_TOGGLES,
  DEFAULT_AUTH_FEATURE_TOGGLES,
  DEFAULT_SYNC_INTERVALS,
} from '../../shared/github-constants'

/**
 * The settings a renderer may change through GITHUB_CONFIG_UPDATE, and
 * nothing else.
 *
 * A patch arrives over IPC, so it is untrusted: only the keys below are
 * taken, and each only when its value is of the right kind. `schemaVersion`,
 * `authProfiles` and `defaultAuthProfileId` are not settings and are never
 * taken from a patch. The accounts have their own channels, which keep each
 * token's ciphertext, and a schema version written from a patch would make
 * the file one this build refuses to read.
 */

const SYNC_KEYS = Object.keys(DEFAULT_SYNC_INTERVALS) as Array<keyof GitHubSyncIntervals>
const APP_WIDE_KEYS = Object.keys(DEFAULT_APP_WIDE_TOGGLES) as GitHubAppWideFeatureKey[]
const AUTH_FEATURE_KEYS = Object.keys(DEFAULT_AUTH_FEATURE_TOGGLES) as GitHubAuthFeatureKey[]

/** The longest version stamp taken; a real one is a dozen characters. */
const MAX_VERSION_STAMP = 64

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The `keys` of `raw` whose value passes `ok`, or undefined when there are none. */
function pickMap<K extends string, V>(
  raw: unknown,
  keys: readonly K[],
  ok: (v: unknown) => v is V,
): Partial<Record<K, V>> | undefined {
  if (!isRecord(raw)) return undefined
  const out: Partial<Record<K, V>> = {}
  let any = false
  for (const k of keys) {
    // Own keys only: nothing is read through the prototype of an object that
    // came over IPC.
    if (!Object.hasOwn(raw, k)) continue
    const v = raw[k]
    if (!ok(v)) continue
    out[k] = v
    any = true
  }
  return any ? out : undefined
}

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'
/** A sync interval is a whole number of seconds, at least one. */
const isSeconds = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1

/** The settings in `raw`, each key only when it is a setting and its value is
 *  of the right kind. Anything else is left out. */
export function pickSettingsPatch(raw: unknown): GitHubSettingsPatch {
  const out: GitHubSettingsPatch = {}
  if (!isRecord(raw)) return out
  const own = (k: string): unknown => (Object.hasOwn(raw, k) ? raw[k] : undefined)

  const enabledByDefault = own('enabledByDefault')
  if (isBoolean(enabledByDefault)) out.enabledByDefault = enabledByDefault

  const transcriptScanningOptIn = own('transcriptScanningOptIn')
  if (isBoolean(transcriptScanningOptIn)) out.transcriptScanningOptIn = transcriptScanningOptIn

  const seen = own('seenOnboardingVersion')
  if (typeof seen === 'string' && seen.length > 0 && seen.length <= MAX_VERSION_STAMP) {
    out.seenOnboardingVersion = seen
  }

  const syncIntervals = pickMap(own('syncIntervals'), SYNC_KEYS, isSeconds)
  if (syncIntervals) out.syncIntervals = syncIntervals

  const appWideToggles = pickMap(own('appWideToggles'), APP_WIDE_KEYS, isBoolean)
  if (appWideToggles) out.appWideToggles = appWideToggles

  const featureDefaults = pickMap(own('featureDefaults'), AUTH_FEATURE_KEYS, isBoolean)
  if (featureDefaults) out.featureDefaults = featureDefaults

  return out
}

/**
 * `current` with the settings of `raw` on top, or null when `raw` holds no
 * setting (nothing to save).
 *
 * A sub-map is merged key by key onto the map `current` has, so a patch that
 * names one sync interval or one toggle changes that one and keeps the others
 * as the file has them. featureDefaults is completed from the built-in
 * defaults when the file's own map is absent or partial, since a new account
 * is seeded from it whole.
 */
export function applySettingsPatch(current: GitHubConfig, raw: unknown): GitHubConfig | null {
  const patch = pickSettingsPatch(raw)
  if (Object.keys(patch).length === 0) return null
  const { syncIntervals, appWideToggles, featureDefaults, ...scalars } = patch
  const next: GitHubConfig = { ...current, ...scalars }
  if (syncIntervals) {
    next.syncIntervals = { ...DEFAULT_SYNC_INTERVALS, ...current.syncIntervals, ...syncIntervals }
  }
  if (appWideToggles) {
    next.appWideToggles = {
      ...(current.appWideToggles ?? {}),
      ...appWideToggles,
    } as Record<GitHubAppWideFeatureKey, boolean>
  }
  if (featureDefaults) {
    next.featureDefaults = {
      ...DEFAULT_AUTH_FEATURE_TOGGLES,
      ...(current.featureDefaults ?? {}),
      ...featureDefaults,
    }
  }
  return next
}
