import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useGitHubStore } from '../../../src/renderer/stores/githubStore'

// Patch `window.electronAPI.github` onto the existing window rather than
// replacing `globalThis.window` wholesale. The Vitest global setup installs a
// shared window.electronAPI mock that other renderer tests rely on; clobbering
// it here leaked across files and broke unrelated suites when this test ran
// first.
let originalElectronAPI: unknown
let windowCreatedByTest = false

/** The config the bridge answers with: one account, and every sub-map set. */
function savedConfig() {
  return {
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
  }
}

/** What the bridge answers a read: the config (or null) and whether the file
 *  is there but did not read. */
const read = (config: unknown) => ({ config, readFailed: false })
const DID_NOT_READ = { config: null, readFailed: true }

function buildGithubMock() {
  return {
    getConfig: vi.fn().mockResolvedValue(read(savedConfig())),
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

/** What main says when github-config.json is there but did not read. */
const UNREADABLE =
  'The GitHub settings file (github-config.json) could not be read, so nothing was changed. '
  + 'Close other programs that may be using it, or move github-config.json out of the CONFIG folder '
  + 'in the AI Code Conductor resources folder and sign in to GitHub again.'

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
      saveError: null,
      configUnread: false,
    } as never)
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
    const SENTENCE = UNREADABLE
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

    // A feature toggle on the only account is two saves: the account, then
    // the defaults new accounts start from. When the second is refused the
    // first has already changed the file, so the page reads it again.
    it('a feature toggle whose second save is refused still reads the config again', async () => {
      const afterFirstSave = savedConfig()
      ;(afterFirstSave.authProfiles.p1 as Record<string, unknown>).featureToggles = { ci: false }
      api().updateProfile = vi.fn().mockImplementation(async () => {
        api().getConfig.mockResolvedValue(read(afterFirstSave))
        return { ok: true }
      })
      api().updateConfig.mockRejectedValueOnce(rejected('github:config:update'))
      api().getConfig.mockClear()

      await expect(useGitHubStore.getState().setProfileFeature('p1', 'ci', false)).rejects.toThrow(SENTENCE)

      expect(api().updateProfile).toHaveBeenCalledTimes(1)
      expect(api().updateConfig).toHaveBeenCalledTimes(1)
      expect(api().getConfig).toHaveBeenCalledTimes(1)
      expect(useGitHubStore.getState().config).toEqual(afterFirstSave)
      expect(useGitHubStore.getState().saveError).toBe(SENTENCE)
    })

    it('a feature toggle whose first save is refused reads the config again too, and keeps the reason', async () => {
      api().updateProfile = vi.fn().mockResolvedValue({ ok: false, error: SENTENCE })
      api().getConfig.mockClear()
      await expect(useGitHubStore.getState().setProfileFeature('p1', 'ci', false)).rejects.toThrow(SENTENCE)
      expect(api().getConfig).toHaveBeenCalledTimes(1)
      expect(useGitHubStore.getState().saveError).toBe(SENTENCE)
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

  // The bridge answers a read with the config AND whether the file is there
  // but did not read. A file that did not read is not "no file": what the
  // store then shows is marked unread, and no save is built from it.
  describe('a read of github-config.json that failed', () => {
    const api = () =>
      (globalThis as unknown as { window: { electronAPI: { github: Record<string, ReturnType<typeof vi.fn>> } } })
        .window.electronAPI.github
    const state = () => useGitHubStore.getState() as unknown as {
      config: Record<string, any> | null
      profiles: unknown[]
      saveError: string | null
      configUnread: boolean
    }

    it('no file yet: the defaults, and nothing is marked or said', async () => {
      api().getConfig.mockResolvedValue(read(null))
      await useGitHubStore.getState().loadConfig()
      expect(state().config!.authProfiles).toEqual({})
      expect(state().profiles).toEqual([])
      expect(state().configUnread).toBe(false)
      expect(state().saveError).toBeNull()
    })

    it('with nothing read before: the defaults are shown, marked unread, and the page says why', async () => {
      api().getConfig.mockResolvedValue(DID_NOT_READ)
      await useGitHubStore.getState().loadConfig()
      expect(state().config!.authProfiles).toEqual({})
      expect(state().profiles).toEqual([])
      expect(state().configUnread).toBe(true)
      expect(state().saveError).toBe(UNREADABLE)
    })

    it('no answer at all is taken the same way, never as "no file"', async () => {
      api().getConfig.mockResolvedValue(null)
      await useGitHubStore.getState().loadConfig()
      expect(state().configUnread).toBe(true)
      expect(state().saveError).toBe(UNREADABLE)
    })

    it('after a read that worked: what that read gave stays on show, marked unread', async () => {
      await useGitHubStore.getState().loadConfig()
      const shown = state().config
      api().getConfig.mockResolvedValue(DID_NOT_READ)
      await useGitHubStore.getState().loadConfig()
      await useGitHubStore.getState().loadConfig()
      expect(state().config).toBe(shown)
      expect(state().profiles).toHaveLength(1)
      expect(state().configUnread).toBe(true)
      expect(state().saveError).toBeNull()
    })

    it('a read that works again clears the mark', async () => {
      api().getConfig.mockResolvedValue(DID_NOT_READ)
      await useGitHubStore.getState().loadConfig()
      api().getConfig.mockResolvedValue(read(savedConfig()))
      await useGitHubStore.getState().loadConfig()
      expect(state().configUnread).toBe(false)
      expect(state().profiles).toHaveLength(1)
    })

    describe('a save while the config is marked unread', () => {
      beforeEach(async () => {
        api().updateProfile = vi.fn().mockResolvedValue({ ok: true })
        api().getConfig.mockResolvedValue(DID_NOT_READ)
        await useGitHubStore.getState().loadConfig()
        api().getConfig.mockClear()
      })

      const saves: Array<[string, () => Promise<void>]> = [
        ['a settings change', () => useGitHubStore.getState().updateConfig({ transcriptScanningOptIn: true })],
        ['an app-wide toggle', () => useGitHubStore.getState().setAppWideToggle('localGit', false)],
        ['a feature toggle', () => useGitHubStore.getState().setProfileFeature('p1', 'ci', false)],
        ['apply to all accounts', () => useGitHubStore.getState().applyProfileToAll('p1')],
        ['removing an account', () => useGitHubStore.getState().removeProfile('p1')],
        ['renaming an account', () => useGitHubStore.getState().renameProfile('p1', 'new')],
      ]

      it.each(saves)('%s reads again first, and is refused without a save when the file still does not read', async (_what, save) => {
        await expect(save()).rejects.toThrow(UNREADABLE)
        expect(api().getConfig).toHaveBeenCalledTimes(1)
        expect(api().updateConfig).not.toHaveBeenCalled()
        expect(api().updateProfile).not.toHaveBeenCalled()
        expect(api().removeProfile).not.toHaveBeenCalled()
        expect(api().renameProfile).not.toHaveBeenCalled()
        expect(state().saveError).toBe(UNREADABLE)
        expect(state().configUnread).toBe(true)
      })

      it('goes through once the file reads again, built from what that read gave', async () => {
        const real = savedConfig() as Record<string, any>
        real.appWideToggles = { localGit: true, sessionContext: false }
        api().getConfig.mockResolvedValue(read(real))

        await useGitHubStore.getState().setAppWideToggle('localGit', false)

        // Read again BEFORE the save, and the save names the one key that changed.
        expect(api().getConfig.mock.invocationCallOrder[0]).toBeLessThan(api().updateConfig.mock.invocationCallOrder[0])
        expect(api().updateConfig).toHaveBeenCalledWith({ appWideToggles: { localGit: false } })
        expect(state().configUnread).toBe(false)
        expect(state().saveError).toBeNull()
      })

      it('a read that itself fails is kept as saveError, and nothing is saved', async () => {
        api().getConfig.mockRejectedValue(new Error('the bridge is gone'))
        await expect(useGitHubStore.getState().updateConfig({ transcriptScanningOptIn: true })).rejects.toThrow('the bridge is gone')
        expect(api().updateConfig).not.toHaveBeenCalled()
        expect(state().saveError).toBe('the bridge is gone')
      })
    })
  })

  // A change to one key of a sub-map names that key only; main puts it on top
  // of the map in the file. The store never sends a whole map it rebuilt from
  // what it happened to hold.
  describe('a change to one key of a sub-map names that key only', () => {
    const api = () =>
      (globalThis as unknown as { window: { electronAPI: { github: Record<string, ReturnType<typeof vi.fn>> } } })
        .window.electronAPI.github

    beforeEach(async () => {
      api().updateProfile = vi.fn().mockResolvedValue({ ok: true })
      await useGitHubStore.getState().loadConfig()
    })

    it('an app-wide toggle', async () => {
      await useGitHubStore.getState().setAppWideToggle('sessionContext', false)
      expect(api().updateConfig).toHaveBeenCalledTimes(1)
      expect(api().updateConfig).toHaveBeenCalledWith({ appWideToggles: { sessionContext: false } })
    })

    it('the feature default that follows a toggle on the only account', async () => {
      await useGitHubStore.getState().setProfileFeature('p1', 'ci', false)
      expect(api().updateConfig).toHaveBeenCalledTimes(1)
      expect(api().updateConfig).toHaveBeenCalledWith({ featureDefaults: { ci: false } })
    })
  })
})
