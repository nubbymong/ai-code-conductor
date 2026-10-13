/**
 * "Has this user ever been offered Multi Spawn?" This is the Allow Multi Spawn
 * startup page's gate. It sits beside `whats-new-gate.ts` and reads the same
 * boot-time meta, but its marker means something different.
 *
 * The page is shown ONCE EVER, on the upgrade into Multi Spawn. It is a
 * one-time migration page: it lists the saved configs so an upgrader can opt
 * them in or out before the one-copy limit bites. Once any build has offered
 * it there is nothing new to ask, so the marker counts by PRESENCE: once
 * `multiSpawnIntroVersion` holds any version, the page is never shown again,
 * not even after a later upgrade (2.1.1-beta.1 to beta.2, 2.1.0 to 2.1.1,
 * 2.1.x to 2.2). That is the same rule as the introduction-seen stamp next to
 * it in appMetaStore.ts.
 *
 * It used to count as seen only when the stamp EQUALLED the running version,
 * so every update put the page back up, with "New in this update" copy that was
 * no longer true. Nothing needs migrating: the gate runs in the new build and
 * only asks whether a stamp exists.
 *
 * The stamp still records `__APP_VERSION__`, the version RUNNING, never
 * `changelog[0].version` (#369), so the meta file says which build made the
 * offer. Only its presence is read.
 *
 * A missing stamp means "never offered". Every start of a build with this page
 * either stamps (fresh install, no configs, Skip, Continue) or shows the page
 * again until it is answered. So a 2.0.x upgrader still gets the page once,
 * where Multi Spawn really is new, and a user who closed the app with the page
 * still up sees it again on the next start.
 *
 * What this page does NOT do: announce a LATER automatic enable. The migration
 * in App.tsx (`configsToEnableMultiSpawn`) runs on every start, so a config
 * that is found running two copies on some later start is enabled silently.
 * That was already true of any restart on the same build, so it is not new.
 *
 * It is a SEPARATE stamp from `lastSeenVersion` rather than a second reader of
 * it. The two surfaces are dismissed independently — the release notes close,
 * then this page opens — so one stamp could not describe both, and a shared one
 * would mark this page seen the moment the notes were.
 *
 * Two launches never get the page:
 *   - a FRESH INSTALL. There is nothing to migrate (no configs, no sessions
 *     running from a build that had no such limit), and the feature is off by
 *     default, so the page would be a settings screen for a user who has not
 *     made a single config yet. `first-install` is asked of `decideUpgradeFlow`
 *     rather than re-derived here, so this and What's New can never disagree
 *     about which launch is somebody's first.
 *   - NO SAVED CONFIGS. An empty list is an empty page. It stamps anyway, so a
 *     user who creates their first config an hour later is not ambushed by a
 *     migration page on the next start, or after any later upgrade.
 *
 * Both of those are decided from meta read at BOOT, before anything stamps —
 * by the time the harness has closed, `lastSeenVersion` says the current
 * version and a first install is indistinguishable from an upgrade.
 */

import { useAppMetaStore } from '../stores/appMetaStore'
import { decideUpgradeFlow } from './upgrade-flow'
import { runningVersion } from './whats-new-gate'

export type MultiSpawnIntroReason =
  | 'no-version'
  | 'already-seen'
  | 'fresh-install'
  | 'no-configs'
  | 'due'

export interface MultiSpawnIntroDecision {
  /** Render the page this launch. */
  show: boolean
  /** Stamp the marker WITHOUT showing anything — the silent skips. */
  markSeen: boolean
  /** Why, in a word, so a test can assert the reason and not just the outcome. */
  reason: MultiSpawnIntroReason
}

export interface MultiSpawnIntroInput {
  /** `lastSeenVersion` from app meta, read before this launch stamps anything. */
  lastSeenVersion?: string
  /** `lastRunVersionOf(meta)` — see upgrade-flow. */
  lastRunVersion?: string
  /** The build that last showed this page. Absent = never shown. */
  multiSpawnIntroVersion?: string
  /** The version now running (`__APP_VERSION__`). */
  currentVersion: string
  /** How many saved configs there are to offer. */
  configCount: number
  /** Passed through to `decideUpgradeFlow`; only its first-install arm is used. */
  channel?: string
}

export function decideMultiSpawnIntro(input: MultiSpawnIntroInput): MultiSpawnIntroDecision {
  const { lastSeenVersion, lastRunVersion, multiSpawnIntroVersion, currentVersion, channel } = input

  // No version to compare against (a test without the esbuild define, a broken
  // build): show nothing and stamp nothing rather than guess.
  if (!currentVersion) return { show: false, markSeen: false, reason: 'no-version' }

  // Presence, not comparison: any stamp means some build has already offered
  // the page, so no build offers it again. Comparing it to the running version
  // re-showed the page on every update.
  if (multiSpawnIntroVersion) {
    return { show: false, markSeen: false, reason: 'already-seen' }
  }

  const flow = decideUpgradeFlow({ lastSeenVersion, lastRunVersion, currentVersion, channel })
  if (flow.kind === 'first-install') return { show: false, markSeen: true, reason: 'fresh-install' }

  if (input.configCount <= 0) return { show: false, markSeen: true, reason: 'no-configs' }

  return { show: true, markSeen: false, reason: 'due' }
}

/** Record that the RUNNING build has offered the page — shown, skipped, or
 *  silently stamped. Mirrors `markWhatsNewSeen`, storage errors included. */
export function markMultiSpawnIntroSeen(): void {
  try {
    const currentVersion = runningVersion()
    if (currentVersion) {
      useAppMetaStore.getState().update({ multiSpawnIntroVersion: currentVersion })
    }
  } catch {
    // Ignore storage errors
  }
}
