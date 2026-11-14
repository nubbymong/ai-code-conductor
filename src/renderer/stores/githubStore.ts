import { create } from 'zustand'
import type {
  GitHubConfig,
  AuthProfile,
  RepoCache,
  NotificationSummary,
  AiUsageReport,
  AiUsageStatus,
  AiUsagePayload,
  CycleCredits,
  GitHubAuthFeatureKey,
  GitHubAppWideFeatureKey,
  GitHubSettingsPatch,
} from '../../shared/github-types'
import {
  DEFAULT_AUTH_FEATURE_TOGGLES,
  emptyGitHubConfig,
  GITHUB_CONFIG_UNREADABLE,
} from '../../shared/github-constants'
import { effectiveToggleMap, resolveAiUsageTargetId } from '../../shared/github-features'
import { useSettingsStore } from './settingsStore'
import { trackUsage } from './tipsStore'

export interface SessionPanelState {
  panelWidth: number
  collapsedSections: Record<string, boolean>
}

export interface SyncStatus {
  state: 'syncing' | 'synced' | 'rate-limited' | 'error' | 'idle'
  at: number
  nextResetAt?: number
}

interface GitHubStoreState {
  config: GitHubConfig | null
  profiles: AuthProfile[]
  repoData: Record<string, RepoCache>
  panelVisible: boolean
  sessionStates: Record<string, SessionPanelState>
  syncStatus: Record<string, SyncStatus>
  notificationsByProfile: Record<string, NotificationSummary[]>
  // AI-credits (Copilot) usage meter. null until the first fetch resolves or
  // the meter is disabled. Consumed by the usage-meter UI (chip, popover,
  // Settings action row, Tokenomics card).
  aiUsage: AiUsageReport | null
  // Structured reason that travels alongside aiUsage so the UI can tell apart
  // "no data yet" from "token lacks the billing scope" from "no GitHub auth".
  // 'pending' until the first fetch resolves.
  aiUsageStatus: AiUsageStatus
  // Cycle-scoped included-credits figure (used since the plan-cycle start), or
  // null when no cycle start is configured. The chip prefers this over the
  // whole-month report so it matches GitHub's billing-card "X / allowance".
  aiUsageCycle: CycleCredits | null
  // Why the last save did not go through, in main's own words, or null. The
  // case it exists for: main refuses a save when github-config.json could not
  // be read, so the saved accounts are never replaced. The GitHub settings
  // page shows this line. It is also set when the page opens on a file that
  // did not read and has only the defaults to show. Cleared when the next
  // save starts.
  saveError: string | null
  // true when the last read of github-config.json failed: the file is there
  // and did not read. What `config` holds was then not confirmed by that
  // read. It is what an earlier read gave, or, with nothing read before, the
  // defaults, shown so the page renders. No save is built from it: while this
  // is set every save reads the file again first, and is refused if it still
  // does not read.
  configUnread: boolean

  loadConfig: () => Promise<void>
  // A settings change (GitHubSettingsPatch). A sub-map carries only the keys
  // that changed; main puts them on top of the map in the file.
  updateConfig: (patch: GitHubSettingsPatch) => Promise<void>
  removeProfile: (id: string) => Promise<void>
  renameProfile: (id: string, label: string) => Promise<void>
  // Per-account feature toggle writes. ROUTING RULE: these patch each profile
  // through the profile-update IPC (patch semantics), never through
  // updateConfig, which carries the settings only. Each write sends the FULL
  // toggle map of that one account (read-modify-write via effectiveToggle) so
  // partial maps inherit featureDefaults at write time.
  setProfileFeature: (
    profileId: string,
    key: GitHubAuthFeatureKey,
    on: boolean,
  ) => Promise<void>
  applyProfileToAll: (sourceId: string) => Promise<void>
  setAppWideToggle: (key: GitHubAppWideFeatureKey, on: boolean) => Promise<void>
  togglePanel: () => void
  setSectionCollapsed: (sessionId: string, section: string, collapsed: boolean) => void
  setPanelWidth: (sessionId: string, w: number) => void
  handleDataUpdate: (p: { slug: string; data: RepoCache }) => void
  handleSyncStateUpdate: (p: {
    slug: string
    state: SyncStatus['state']
    at: number
    nextResetAt?: number
  }) => void
  handleNotificationsUpdate: (p: {
    profileId: string
    items: NotificationSummary[]
  }) => void
  loadAiUsage: (force?: boolean) => Promise<void>
  handleAiUsageUpdate: (payload: AiUsagePayload) => void
}

const DEFAULT_PANEL_WIDTH = 340

// Serializes toggle writes: each action re-reads state AFTER the previous
// write's loadConfig() so rapid UI clicks cannot read-modify-write from the
// same stale snapshot and silently undo each other.
let toggleWriteQueue: Promise<void> = Promise.resolve()
function enqueueToggleWrite(work: () => Promise<void>): Promise<void> {
  const run = toggleWriteQueue.then(work, work)
  toggleWriteQueue = run.catch(() => {})
  return run
}

// featureDefaults can be sparse or absent on a pre-migration / hand-edited
// config; layer DEFAULT_AUTH_FEATURE_TOGGLES underneath so every feature-toggle
// write resolves a COMPLETE map for all auth keys — the same layering the
// settings UI uses to render rows. Passing bare featureDefaults into
// effectiveToggleMap would collapse omitted keys to false on the next write.
function layeredDefaults(cfg: GitHubConfig): Record<GitHubAuthFeatureKey, boolean> {
  return { ...DEFAULT_AUTH_FEATURE_TOGGLES, ...(cfg.featureDefaults ?? {}) }
}

const SAVE_FAILED = 'The change could not be saved.'

/** A refused save's reason as the sentence main gave it, without the wrapper
 *  a rejected `invoke` puts in front. */
function refusalText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  return (
    raw
      .replace(/^Error invoking remote method '[^']*':\s*/i, '')
      .replace(/^(Uncaught )?Error:\s*/i, '')
      .trim() || SAVE_FAILED
  )
}

/**
 * One save through the bridge. A save that did not go through, by a rejected
 * call or by an `{ ok: false }` answer, is kept as `saveError` and raised as
 * that sentence, so the caller stops there and never goes on to report the
 * change as made. An `{ ok: false }` answer is a refusal like any other.
 */
async function saved<T>(call: Promise<T>): Promise<T> {
  try {
    const answer = await call
    const refusal = answer as { ok?: unknown; error?: unknown } | null | undefined
    if (refusal && typeof refusal === 'object' && refusal.ok === false) {
      throw new Error(typeof refusal.error === 'string' && refusal.error ? refusal.error : SAVE_FAILED)
    }
    return answer
  } catch (err) {
    const text = refusalText(err)
    useGitHubStore.setState({ saveError: text })
    throw new Error(text)
  }
}

/**
 * The defaults shown in place of settings that could not be read, kept by
 * identity so a later failed read can tell them from settings that an earlier
 * read gave (which stay on show).
 */
let standIn: GitHubConfig | null = null

/**
 * Before a save: when the last read of github-config.json failed, read it
 * again, and stop here if it still does not read. The settings on show after
 * a failed read are not the saved ones, so a change is never built from them:
 * it is built from what this read gives, or not at all. Main refuses the save
 * of such a file too; stopping here means the page says so without sending a
 * change that was worked out from the defaults.
 */
async function readBeforeSave(): Promise<void> {
  if (!useGitHubStore.getState().configUnread) return
  try {
    await useGitHubStore.getState().loadConfig()
  } catch (err) {
    const text = refusalText(err)
    useGitHubStore.setState({ saveError: text })
    throw new Error(text)
  }
  if (useGitHubStore.getState().configUnread) {
    useGitHubStore.setState({ saveError: GITHUB_CONFIG_UNREADABLE })
    throw new Error(GITHUB_CONFIG_UNREADABLE)
  }
  // It reads again: the line that said it did not is out of date.
  useGitHubStore.setState({ saveError: null })
}

export const useGitHubStore = create<GitHubStoreState>((set, get) => ({
  config: null,
  profiles: [],
  repoData: {},
  panelVisible: true,
  sessionStates: {},
  syncStatus: {},
  notificationsByProfile: {},
  aiUsage: null,
  aiUsageStatus: 'pending',
  aiUsageCycle: null,
  saveError: null,
  configUnread: false,

  loadConfig: async () => {
    const answer = await window.electronAPI.github.getConfig()
    if (!answer || answer.readFailed) {
      // github-config.json is there and did not read. (No answer at all is
      // taken the same way: it is not "no file".) Settings an earlier read
      // gave stay on show. With none, the defaults are shown so the page
      // renders, and the page says why. Either way they are marked unread, and
      // every save reads again first (readBeforeSave).
      const shown = get().config
      if (shown && shown !== standIn) {
        set({ configUnread: true })
      } else {
        standIn = emptyGitHubConfig()
        set({ config: standIn, profiles: [], configUnread: true, saveError: GITHUB_CONFIG_UNREADABLE })
      }
      return
    }
    if (answer.config) {
      set({ config: answer.config, profiles: Object.values(answer.config.authProfiles), configUnread: false })
    } else {
      // No config file yet (first launch). Render UI with defaults; the first
      // updateConfig call will persist. Avoids a stuck "Loading…" state.
      set({ config: emptyGitHubConfig(), profiles: [], configUnread: false })
    }
  },

  updateConfig: async (patch) => {
    set({ saveError: null })
    await readBeforeSave()
    const updated = await saved(window.electronAPI.github.updateConfig(patch))
    set({ config: updated, profiles: Object.values(updated.authProfiles), configUnread: false })
  },

  removeProfile: async (id) => {
    set({ saveError: null })
    await readBeforeSave()
    await saved(window.electronAPI.github.removeProfile(id))
    await get().loadConfig()
  },

  renameProfile: async (id, label) => {
    set({ saveError: null })
    await readBeforeSave()
    await saved(window.electronAPI.github.renameProfile(id, label))
    await get().loadConfig()
  },

  // Toggle one feature on a single account. Reads the account's effective map
  // (own toggles, falling back to featureDefaults), flips the one key, and
  // writes the WHOLE map back through the profile-patch IPC — never updateConfig.
  // Serialized (enqueueToggleWrite) so the snapshot is re-read INSIDE the thunk,
  // after any prior write's loadConfig() — rapid clicks can't RMW a stale map.
  setProfileFeature: (profileId, key, on) =>
    enqueueToggleWrite(async () => {
      await readBeforeSave()
      const cfg = get().config
      const p = cfg?.authProfiles[profileId]
      if (!cfg || !p) return
      set({ saveError: null })
      // Layer DEFAULT under a sparse/absent featureDefaults so a map-less
      // profile inherits the same complete defaults the settings UI renders —
      // a bare featureDefaults would collapse omitted keys to false on write.
      const next = effectiveToggleMap(p, layeredDefaults(cfg))
      next[key] = on
      // Up to two saves follow (the account, then the defaults). The first can
      // go through and the second be refused, so the config is read again
      // whichever way this ends: the page shows what the file holds.
      try {
        await saved(window.electronAPI.github.updateProfile(profileId, { featureToggles: next }))
        // 3.2: with MasterFeaturesSection deleted, a SINGLE-account user's per-account
        // toggle is now the seed for future accounts — persist featureDefaults too.
        // Only the key that changed is sent; main puts it on top of the
        // defaults in the file (completed from the built-in ones).
        if (Object.keys(cfg.authProfiles).length === 1) {
          await saved(window.electronAPI.github.updateConfig({ featureDefaults: { [key]: on } }))
        }
        // 3.1: aiCredits on the AI-usage TARGET profile is the single user-facing
        // enable for the meter. settings.githubAiUsageEnabled stays the persisted
        // source of truth (it also gates the main scheduler, boot migration, and the
        // Tokenomics card), so write through to it.
        if (
          key === 'aiCredits' &&
          profileId === resolveAiUsageTargetId(Object.values(cfg.authProfiles))
        ) {
          await useSettingsStore.getState().updateSettings({ githubAiUsageEnabled: on })
          // Only on ENABLE: the tip this gates offers to show you the meter, and
          // someone who has turned it off has answered that offer just as clearly
          // as someone who turned it on.
          if (on) trackUsage('github.ai-usage-enabled')
          // Populate (or clear) the meter immediately, mirroring the old
          // AiUsageSettings enable — otherwise the relocated statusline chip would
          // sit on its placeholder until the ~60-min scheduler tick.
          await get().loadAiUsage().catch(() => {})
        }
      } finally {
        await get().loadConfig()
      }
    }),

  // Copy a source account's effective toggle map onto every OTHER account.
  // Each target is patched via the profile IPC; the source is left untouched.
  // Serialized + snapshot re-read inside the thunk (F2). A failed per-target
  // write is logged and skipped so one bad write doesn't abort the rest (F4);
  // loadConfig() always runs in the finally.
  applyProfileToAll: (sourceId) =>
    enqueueToggleWrite(async () => {
      await readBeforeSave()
      const cfg = get().config
      const src = cfg?.authProfiles[sourceId]
      if (!cfg || !src) return
      set({ saveError: null })
      const map = effectiveToggleMap(src, layeredDefaults(cfg))
      try {
        for (const p of Object.values(cfg.authProfiles)) {
          if (p.id === sourceId) continue
          try {
            await saved(window.electronAPI.github.updateProfile(p.id, { featureToggles: map }))
          } catch (err) {
            console.warn('[github] toggle write failed for profile', p.id, err)
          }
        }
        // 3.2: persist the applied map as the seed for future accounts (replaces the
        // deleted MasterFeaturesSection's featureDefaults-write responsibility).
        await saved(window.electronAPI.github.updateConfig({ featureDefaults: map }))
      } finally {
        await get().loadConfig()
      }
    }),

  // App-wide (no-auth) toggle. Root-level field → updateConfig, never a profile
  // patch. No account is touched. Only the toggle that changed is sent; main
  // puts it on top of the appWideToggles map in the file, so the other toggle
  // keeps whatever the file has. Serialized (F2) with the other toggle writes.
  setAppWideToggle: (key, on) =>
    enqueueToggleWrite(async () => {
      await readBeforeSave()
      if (!get().config) return
      set({ saveError: null })
      await saved(window.electronAPI.github.updateConfig({ appWideToggles: { [key]: on } }))
      await get().loadConfig()
    }),

  togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),

  setSectionCollapsed: (sessionId, section, collapsed) =>
    set((s) => {
      const cur = s.sessionStates[sessionId] ?? {
        panelWidth: DEFAULT_PANEL_WIDTH,
        collapsedSections: {},
      }
      return {
        sessionStates: {
          ...s.sessionStates,
          [sessionId]: {
            ...cur,
            collapsedSections: { ...cur.collapsedSections, [section]: collapsed },
          },
        },
      }
    }),

  setPanelWidth: (sessionId, w) =>
    set((s) => {
      const cur = s.sessionStates[sessionId] ?? {
        panelWidth: DEFAULT_PANEL_WIDTH,
        collapsedSections: {},
      }
      return {
        sessionStates: { ...s.sessionStates, [sessionId]: { ...cur, panelWidth: w } },
      }
    }),

  handleDataUpdate: ({ slug, data }) =>
    set((s) => ({ repoData: { ...s.repoData, [slug]: data } })),

  handleSyncStateUpdate: ({ slug, state, at, nextResetAt }) =>
    set((s) => ({
      syncStatus: { ...s.syncStatus, [slug]: { state, at, nextResetAt } },
    })),

  handleNotificationsUpdate: ({ profileId, items }) =>
    set((s) => ({
      notificationsByProfile: { ...s.notificationsByProfile, [profileId]: items },
    })),

  loadAiUsage: async (force) => {
    // Drives a main-side fetch (or returns the cached report + status). Returns
    // a null report when the meter is disabled / unauthed; we still set it so
    // the UI reflects the cleared state rather than a stale report. The status
    // tells the UI WHY the report is null (scope-missing / no-auth / pending).
    // `force` bypasses the main-process cache (popover Refresh, cycle-date change)
    // so the figure recomputes now rather than on the next hourly tick.
    const payload = await window.electronAPI.github.getAiUsage(force)
    set({
      aiUsage: payload?.report ?? null,
      aiUsageStatus: payload?.status ?? 'pending',
      aiUsageCycle: payload?.cycle ?? null,
    })
  },

  handleAiUsageUpdate: (payload) =>
    set({
      aiUsage: payload?.report ?? null,
      aiUsageStatus: payload?.status ?? 'pending',
      aiUsageCycle: payload?.cycle ?? null,
    }),
}))

// Module-local unsubscribes so setupGitHubListener is idempotent — calling it
// multiple times (e.g. in strict-mode dev) doesn't install duplicate listeners.
let unsubData: (() => void) | null = null
let unsubSync: (() => void) | null = null
let unsubNotif: (() => void) | null = null
let unsubAiUsage: (() => void) | null = null

export function setupGitHubListener(): void {
  if (unsubData) return
  unsubData = window.electronAPI.github.onDataUpdate((p) =>
    useGitHubStore.getState().handleDataUpdate(p),
  )
  unsubSync = window.electronAPI.github.onSyncStateUpdate((p) =>
    useGitHubStore.getState().handleSyncStateUpdate(p),
  )
  unsubNotif = window.electronAPI.github.onNotificationsUpdate((p) =>
    useGitHubStore.getState().handleNotificationsUpdate(p),
  )
  unsubAiUsage = window.electronAPI.github.onAiUsageUpdate((payload) =>
    useGitHubStore.getState().handleAiUsageUpdate(payload),
  )
}

export function teardownGitHubListener(): void {
  unsubData?.()
  unsubSync?.()
  unsubNotif?.()
  unsubAiUsage?.()
  unsubData = null
  unsubSync = null
  unsubNotif = null
  unsubAiUsage = null
}
