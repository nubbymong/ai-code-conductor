import { useCallback } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useDetachedRemotesStore } from '../stores/detachedRemotesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { matchDetachedRemotes, type LaunchableConfig } from '../utils/detachedRemotes'
import { persistentKeeperOf, type PersistentKeeper } from '../components/sidebar/transportBadge'

/**
 * What keeps a saved config's persistent sessions, for its SSH-Persistent
 * chip's title (2.1.3-beta.19 section 1.2, the Rocky host line's finding 2):
 * one rule (transportBadge.ts persistentKeeperOf) for every surface that shows
 * a config's chip, the Saved rows, Quick Start and the Multi Spawn start-up
 * page, from the open tabs' marks, the left-running registry and the remote
 * sessions switch. Answers a lookup, so a list can ask it once per config.
 */
export function usePersistentKeeper(): (config: LaunchableConfig) => PersistentKeeper {
  const sessions = useSessionStore((s) => s.sessions)
  const entries = useDetachedRemotesStore((s) => s.entries)
  const switchOn = useSettingsStore((s) => s.settings?.remoteSessionsThroughHelper === true)
  return useCallback((config: LaunchableConfig): PersistentKeeper => persistentKeeperOf({
    switchOn,
    openTabs: (sessions ?? []).filter((x) => x.configId !== undefined && x.configId === config.id && x.sessionType === 'ssh').map((x) => x.remoteVia),
    leftRunning: matchDetachedRemotes(entries ?? [], config).map((e) => e.mux),
  }), [sessions, entries, switchOn])
}
