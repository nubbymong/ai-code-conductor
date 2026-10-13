import { create } from 'zustand'
import { saveConfigNow } from '../utils/config-saver'

export interface AppMeta {
  setupVersion?: string
  lastSeenVersion?: string
  /** The version that last RAN: stamped with __APP_VERSION__ at every boot, after the launch
   *  decision has read the previous value. The witness that a "seen" stamp was written by the
   *  build it names (#369); `lastRunVersionOf` falls back to setupVersion on metas older than it. */
  lastRunVersion?: string
  lastTrainingVersion?: string
  /** The build that first offered the Allow Multi Spawn startup page (shown
   *  and left with Skip or Continue, or silently stamped on a fresh install or
   *  with no configs). Presence is what counts: once written, it is never
   *  shown again, not even after an upgrade. See
   *  onboarding/multi-spawn-intro-gate.ts. */
  multiSpawnIntroVersion?: string
  /** The build running when the Codex introduction was first left (Done,
   *  Skip, Escape or "Start a Codex session"; WP2 commit 6f), or a replay of
   *  it left while it was still due. Presence is what counts: once written,
   *  it is never shown again, not even after an upgrade. A replay of an
   *  introduction already seen never writes it. See onboarding/hello-codex.ts. */
  helloCodexSeenVersion?: string
  /** The build running when the one-time "Replace this sign-in with a Codex
   *  account" page was left (Add a Codex account finished, or Not now), shown
   *  to someone who chose the Codex sign-in already on this computer in
   *  2.1.1-beta.2 (O5). Presence is what counts: once written, it is never
   *  shown again. See onboarding/codex-replace-gate.ts. */
  codexReplaceSeenVersion?: string
  commandsSeeded?: boolean
  colorMigrated?: boolean
  /** Set once the saved config the RETIRED "Ask the Conductor" path used to
   *  create has been removed from Saved Configs. See retireAskConfig. */
  askConfigRetired?: boolean
  hasCreatedFirstConfig?: boolean
  firstRunCardDismissed?: boolean
  accountWizardDismissed?: boolean
  accountGateDecided?: boolean      // user explicitly chose Enable or No in the gate
  lastSeenGlobalAccount?: string    // global ~/.claude.json oauth email at last launch
  completedSteps?: Record<string, string>   // onboarding: stepId -> app version at completion (presence = settled)
  onboardingCompletedVersion?: string       // onboarding: set once at the finish step; compared to ONBOARDING_VERSION
  onboardingAppVersion?: string             // app version at last onboarding finish; drives the per-beta-version tour retrigger
}

interface AppMetaState {
  meta: AppMeta
  isLoaded: boolean
  hydrate: (meta: AppMeta) => void
  update: (updates: Partial<AppMeta>) => void
}

export const useAppMetaStore = create<AppMetaState>((set, get) => ({
  meta: {},
  isLoaded: false,

  hydrate: (meta) => set({ meta, isLoaded: true }),

  update: (updates) =>
    set((state) => {
      const meta = { ...state.meta, ...updates }
      saveConfigNow('appMeta', meta)
      return { meta }
    })
}))
