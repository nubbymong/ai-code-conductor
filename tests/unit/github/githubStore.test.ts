import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useGitHubStore } from '../../../src/renderer/stores/githubStore'

// Patch `window.electronAPI.github` onto the existing window rather than
// replacing `globalThis.window` wholesale. The Vitest global setup installs a
// shared window.electronAPI mock that other renderer tests rely on; clobbering
// it here leaked across files and broke unrelated suites when this test ran
// first.
let originalElectronAPI: unknown
let windowCreatedByTest = false

function buildGithubMock() {
  return {
    getConfig: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      authProfiles: {
        p1: {
          id: 'p1',
          kind: 'oauth',
          label: 'nub',
          username: 'nub',
          scopes: ['public_repo'],
          capabilities: ['pulls'],
          createdAt: 0,
          lastVerifiedAt: 0,
          expiryObservable: false,
        },
      },
      featureToggles: {
        activePR: true,
        ci: true,
        reviews: true,
        linkedIssues: true,
        notifications: false,
        localGit: true,
        sessionContext: true,
      },
      syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
      enabledByDefault: false,
      transcriptScanningOptIn: false,
    }),
    updateConfig: vi.fn().mockImplementation(async (patch: Record<string, unknown>) => ({
      schemaVersion: 1,
      authProfiles: {},
      featureToggles: {},
      syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
      enabledByDefault: false,
      transcriptScanningOptIn: false,
      ...patch,
    })),
    removeProfile: vi.fn().mockResolvedValue({ ok: true }),
    renameProfile: vi.fn().mockResolvedValue({ ok: true }),
    onDataUpdate: vi.fn().mockImplementation(() => () => {}),
    onSyncStateUpdate: vi.fn().mockImplementation(() => () => {}),
  }
}

function setupMockElectron() {
  const root = globalThis as unknown as { window?: Record<string, unknown> }
  if (root.window) {
    originalElectronAPI = root.window.electronAPI
    root.window.electronAPI = {
      ...((root.window.electronAPI as Record<string, unknown> | undefined) ?? {}),
      github: buildGithubMock(),
    }
  } else {
    windowCreatedByTest = true
    root.window = { electronAPI: { github: buildGithubMock() } }
  }
}

function restoreMockElectron() {
  const root = globalThis as unknown as { window?: Record<string, unknown> }
  if (!root.window) return
  if (windowCreatedByTest) {
    delete root.window
    windowCreatedByTest = false
    return
  }
  if (originalElectronAPI === undefined) {
    delete (root.window as Record<string, unknown>).electronAPI
  } else {
    root.window.electronAPI = originalElectronAPI as Record<string, unknown>
  }
  originalElectronAPI = undefined
}

describe('githubStore', () => {
  beforeEach(() => {
    setupMockElectron()
    useGitHubStore.setState({
      config: null,
      profiles: [],
      repoData: {},
      panelVisible: true,
      sessionStates: {},
      syncStatus: {},
    })
  })
  afterEach(() => {
    restoreMockElectron()
  })

  it('loadConfig populates config + profiles', async () => {
    await useGitHubStore.getState().loadConfig()
    expect(useGitHubStore.getState().profiles).toHaveLength(1)
    expect(useGitHubStore.getState().profiles[0].username).toBe('nub')
  })

  it('togglePanel flips visibility', () => {
    useGitHubStore.getState().togglePanel()
    expect(useGitHubStore.getState().panelVisible).toBe(false)
  })

  it('setSectionCollapsed persists per session', () => {
    useGitHubStore.getState().setSectionCollapsed('s1', 'localGit', true)
    expect(
      useGitHubStore.getState().sessionStates.s1.collapsedSections.localGit,
    ).toBe(true)
  })

  it('setPanelWidth persists per session', () => {
    useGitHubStore.getState().setPanelWidth('s1', 420)
    expect(useGitHubStore.getState().sessionStates.s1.panelWidth).toBe(420)
  })

  it('handleDataUpdate stores per slug', () => {
    useGitHubStore.getState().handleDataUpdate({
      slug: 'a/b',
      data: { etags: {}, lastSynced: 1, accessedAt: 1 },
    })
    expect(useGitHubStore.getState().repoData['a/b']).toBeDefined()
  })

  it('handleSyncStateUpdate stores per slug', () => {
    useGitHubStore.getState().handleSyncStateUpdate({
      slug: 'a/b',
      state: 'synced',
      at: 123,
    })
    expect(useGitHubStore.getState().syncStatus['a/b'].state).toBe('synced')
  })

  // Main refuses a save when github-config.json did not read, so the saved
  // accounts are never replaced. The settings page has to say so: the store
  // keeps the reason as `saveError`, and never reports the save as done.
  describe('a save main refused', () => {
    const SENTENCE = 'The GitHub settings file (github-config.json) could not be read, so nothing was changed.'
    /** A rejected `invoke`, as the renderer receives it. */
    const rejected = (channel: string) =>
      new Error(`Error invoking remote method '${channel}': Error: ${SENTENCE}`)
    const api = () =>
      (globalThis as unknown as { window: { electronAPI: { github: Record<string, ReturnType<typeof vi.fn>> } } })
        .window.electronAPI.github

    beforeEach(async () => {
      useGitHubStore.setState({ saveError: null } as never)
      await useGitHubStore.getState().loadConfig()
    })

    it('a rejected settings change is kept as saveError without the IPC wrapper, and the config is left as it was', async () => {
      const before = useGitHubStore.getState().config
      api().updateConfig.mockRejectedValueOnce(rejected('github:config:update'))
      await expect(
        useGitHubStore.getState().updateConfig({ transcriptScanningOptIn: true }),
      ).rejects.toThrow(SENTENCE)
      expect(useGitHubStore.getState().saveError).toBe(SENTENCE)
      expect(useGitHubStore.getState().config).toBe(before)
      expect(useGitHubStore.getState().profiles).toHaveLength(1)
    })

    it('an { ok: false } answer to removing an account is kept as saveError and raised, not taken as done', async () => {
      api().removeProfile.mockResolvedValueOnce({ ok: false, error: SENTENCE })
      await expect(useGitHubStore.getState().removeProfile('p1')).rejects.toThrow(SENTENCE)
      expect(useGitHubStore.getState().saveError).toBe(SENTENCE)
    })

    it('an { ok: false } answer to renaming an account is kept as saveError and raised', async () => {
      api().renameProfile.mockResolvedValueOnce({ ok: false, error: SENTENCE })
      await expect(useGitHubStore.getState().renameProfile('p1', 'new')).rejects.toThrow(SENTENCE)
      expect(useGitHubStore.getState().saveError).toBe(SENTENCE)
    })

    it('a refused feature toggle is kept as saveError and raised', async () => {
      api().updateProfile = vi.fn().mockResolvedValue({ ok: false, error: SENTENCE })
      await expect(useGitHubStore.getState().setProfileFeature('p1', 'ci', false)).rejects.toThrow(SENTENCE)
      expect(useGitHubStore.getState().saveError).toBe(SENTENCE)
      expect(api().updateConfig).not.toHaveBeenCalled()
    })

    it('a refused app-wide toggle is kept as saveError and raised', async () => {
      api().updateConfig.mockRejectedValueOnce(rejected('github:config:update'))
      await expect(useGitHubStore.getState().setAppWideToggle('localGit', false)).rejects.toThrow(SENTENCE)
      expect(useGitHubStore.getState().saveError).toBe(SENTENCE)
    })

    it('a refusal that gives no reason still reads as a failure', async () => {
      api().removeProfile.mockResolvedValueOnce({ ok: false })
      await expect(useGitHubStore.getState().removeProfile('p1')).rejects.toThrow()
      expect(useGitHubStore.getState().saveError).toBe('The change could not be saved.')
    })

    it('the next save clears it', async () => {
      api().updateConfig.mockRejectedValueOnce(rejected('github:config:update'))
      await expect(
        useGitHubStore.getState().updateConfig({ transcriptScanningOptIn: true }),
      ).rejects.toThrow()
      expect(useGitHubStore.getState().saveError).toBe(SENTENCE)
      await useGitHubStore.getState().updateConfig({ transcriptScanningOptIn: true })
      expect(useGitHubStore.getState().saveError).toBeNull()
      expect(useGitHubStore.getState().config!.transcriptScanningOptIn).toBe(true)
    })

    it('a save that goes through sets no error', async () => {
      await useGitHubStore.getState().removeProfile('p1')
      await useGitHubStore.getState().renameProfile('p1', 'new')
      expect(useGitHubStore.getState().saveError).toBeNull()
    })
  })
})
