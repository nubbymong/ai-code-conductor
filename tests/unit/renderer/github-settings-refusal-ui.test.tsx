// @vitest-environment jsdom
/**
 * The GitHub settings page, the set-up page and the dialogs that add an
 * account, when github-config.json did not read or a change was refused.
 *
 *   - A page opened while the file did not read shows the defaults. A change
 *     made from it is sent as that one change: a sync interval names its own
 *     key, and the set-up page's Next saves the GitHub master only when the
 *     user set it there or the shown value was read from the file.
 *   - The set-up page's Next waits for its save. A refused save is said on
 *     the page and the page stays; "Skip for now", offered then, moves on
 *     with nothing saved, and is held while a save is on its way.
 *   - A control that starts a save does not leave a refused save as an
 *     unhandled rejection: the reason is already on the page.
 *   - The add-account dialog and the device sign-in show main's sentence for
 *     an `{ ok: false, error }` answer, the device sign-in stops saying it is
 *     waiting once it has an error, and a token submit clears the error left
 *     by an earlier sign-in attempt.
 *
 * The real store and the real components, on a bridge of inert fakes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import GitHubConfigTab from '../../../src/renderer/components/github/config/GitHubConfigTab'
import SyncSettings from '../../../src/renderer/components/github/config/SyncSettings'
import AddProfileModal from '../../../src/renderer/components/github/config/AddProfileModal'
import OAuthDeviceFlow from '../../../src/renderer/components/github/config/OAuthDeviceFlow'
import { GitHubStep } from '../../../src/renderer/onboarding/GitHubStep'
import { useGitHubStore } from '../../../src/renderer/stores/githubStore'
import { GITHUB_CONFIG_UNREADABLE, GITHUB_CONFIG_NOT_SAVED } from '../../../src/shared/github-constants'
import type { GitHubConfig } from '../../../src/shared/github-types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const APP_VERSION = '9.9.9-test'
;(globalThis as any).__APP_VERSION__ = APP_VERSION

/** A saved config with every setting away from its default. */
function savedConfig(): GitHubConfig {
  return {
    schemaVersion: 1,
    authProfiles: {},
    featureToggles: {
      activePR: true, ci: true, reviews: true, linkedIssues: true,
      notifications: false, localGit: true, sessionContext: true,
    },
    featureDefaults: {
      activePR: true, ci: false, reviews: true, linkedIssues: true,
      notifications: false, aiCredits: true,
    },
    appWideToggles: { localGit: true, sessionContext: false },
    syncIntervals: { activeSessionSec: 30, backgroundSec: 900, notificationsSec: 600 },
    enabledByDefault: true,
    transcriptScanningOptIn: true,
  }
}

const read = (config: GitHubConfig | null) => ({ config, readFailed: false })
const DID_NOT_READ = { config: null, readFailed: true }

const github = {
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  ghcliDetect: vi.fn(),
  adoptGhCli: vi.fn(),
  addPat: vi.fn(),
  oauthStart: vi.fn(),
  oauthPoll: vi.fn(),
  oauthCancel: vi.fn(),
  removeProfile: vi.fn(),
}

let apiBefore: unknown
let mounted: Array<{ root: Root; container: HTMLElement }> = []
const actions = { ...useGitHubStore.getState() }

function render(ui: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(ui)
  })
  mounted.push({ root, container })
  return container
}

/** Lets every promise a click started run to its end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found as HTMLButtonElement
}

function buttonContaining(root: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(text))
  if (!found) throw new Error(`no button containing "${text}"`)
  return found as HTMLButtonElement
}

function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const alerts = (): string[] =>
  Array.from(document.body.querySelectorAll('[role="alert"]')).map((a) => (a.textContent ?? '').trim())

/** Runs `step`, lets the process report any rejection nobody handled, and returns them. */
async function unhandledDuring(step: () => void): Promise<unknown[]> {
  const seen: unknown[] = []
  const note = (reason: unknown) => { seen.push(reason) }
  process.on('unhandledRejection', note)
  try {
    step()
    await settle()
  } finally {
    process.off('unhandledRejection', note)
  }
  return seen
}

beforeEach(() => {
  for (const fn of Object.values(github)) fn.mockReset()
  github.getConfig.mockResolvedValue(read(savedConfig()))
  github.updateConfig.mockImplementation(async (patch: Record<string, unknown>) => ({ ...savedConfig(), ...patch }))
  github.ghcliDetect.mockResolvedValue({ ok: true, users: [] })
  github.oauthCancel.mockResolvedValue({ ok: true })
  const w = window as unknown as { electronAPI: Record<string, unknown> }
  apiBefore = w.electronAPI
  w.electronAPI = { ...w.electronAPI, github, shell: { openExternal: vi.fn() } }
  // The real actions, and nothing read yet.
  useGitHubStore.setState({ ...actions, config: null, profiles: [], saveError: null, configUnread: false } as never)
})

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount())
    container.remove()
  }
  mounted = []
  ;(window as unknown as { electronAPI: unknown }).electronAPI = apiBefore
  vi.restoreAllMocks()
})

describe('a page opened while github-config.json did not read', () => {
  /** The store as a page finds it: the read failed, the defaults are shown. */
  async function openedUnread(): Promise<void> {
    github.getConfig.mockResolvedValue(DID_NOT_READ)
    await act(async () => {
      await useGitHubStore.getState().loadConfig()
    })
    expect((useGitHubStore.getState() as unknown as { configUnread: boolean }).configUnread).toBe(true)
  }

  it('the settings page says so as it opens, and shows the defaults', async () => {
    github.getConfig.mockResolvedValue(DID_NOT_READ)
    const page = render(<GitHubConfigTab />)
    await settle()
    expect(alerts()).toEqual([GITHUB_CONFIG_UNREADABLE])
    // The page rendered (the defaults), it is not stuck on "Loading".
    expect(page.textContent).toContain('GitHub integration')
    expect(page.textContent).not.toContain('Loading GitHub config')
  })

  it('the settings page opened on a file that reads says nothing', async () => {
    const page = render(<GitHubConfigTab />)
    await settle()
    expect(alerts()).toEqual([])
    expect(page.textContent).toContain('GitHub integration')
  })

  it('the sync section sends the one interval that was changed, never the others it was showing', async () => {
    await openedUnread()
    const page = render(<SyncSettings />)
    // The file reads again before the user picks a value.
    github.getConfig.mockResolvedValue(read(savedConfig()))

    choose(page.querySelectorAll('select')[0], '120')
    await settle()

    expect(github.updateConfig).toHaveBeenCalledTimes(1)
    expect(github.updateConfig).toHaveBeenCalledWith({ syncIntervals: { activeSessionSec: 120 } })
  })

  it('the sync section does the same on a config that read', async () => {
    await act(async () => {
      await useGitHubStore.getState().loadConfig()
    })
    const page = render(<SyncSettings />)
    choose(page.querySelectorAll('select')[1], '300')
    await settle()
    expect(github.updateConfig).toHaveBeenCalledWith({ syncIntervals: { backgroundSec: 300 } })
  })

  describe('the set-up page (GitHub step), on Next', () => {
    it('saves its version stamp only: the GitHub master it shows is a default, not the saved one', async () => {
      github.getConfig.mockResolvedValue(DID_NOT_READ)
      const onNext = vi.fn()
      const page = render(<GitHubStep onNext={onNext} onBack={() => {}} />)
      await settle()
      // The file reads again before the user presses Next; it has the master ON.
      github.getConfig.mockResolvedValue(read(savedConfig()))

      click(buttonContaining(page, 'Next'))
      await settle()

      expect(onNext).toHaveBeenCalledTimes(1)
      expect(github.updateConfig).toHaveBeenCalledTimes(1)
      expect(github.updateConfig).toHaveBeenCalledWith({ seenOnboardingVersion: APP_VERSION })
    })

    it('saves the master too when the user set it on this page', async () => {
      github.getConfig.mockResolvedValue(DID_NOT_READ)
      const page = render(<GitHubStep onNext={() => {}} onBack={() => {}} />)
      await settle()
      github.getConfig.mockResolvedValue(read(savedConfig()))

      click(buttonByText(page, 'Off'))
      click(buttonContaining(page, 'Next'))
      await settle()

      expect(github.updateConfig).toHaveBeenCalledWith({ seenOnboardingVersion: APP_VERSION, enabledByDefault: false })
    })

    const skipButton = (page: ParentNode): HTMLButtonElement | undefined =>
      Array.from(page.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Skip for now'))

    it('while the file still does not read, Next saves nothing, says so in the sentence, and the page stays', async () => {
      github.getConfig.mockResolvedValue(DID_NOT_READ)
      const onNext = vi.fn()
      const page = render(<GitHubStep onNext={onNext} onBack={() => {}} />)
      await settle()
      // Nothing was refused yet: no line, and no way round a save.
      expect(alerts()).toEqual([])
      expect(skipButton(page)).toBeUndefined()

      const unhandled = await unhandledDuring(() => click(buttonContaining(page, 'Next')))

      expect(onNext).not.toHaveBeenCalled()
      expect(github.updateConfig).not.toHaveBeenCalled()
      expect(alerts()).toEqual([GITHUB_CONFIG_UNREADABLE])
      expect(unhandled).toEqual([])
    })

    it('a master the user set while the file does not read is not dropped: Next is refused, then saves it once the file reads', async () => {
      github.getConfig.mockResolvedValue(DID_NOT_READ)
      const onNext = vi.fn()
      const page = render(<GitHubStep onNext={onNext} onBack={() => {}} />)
      await settle()

      click(buttonByText(page, 'Off'))
      click(buttonContaining(page, 'Next'))
      await settle()
      expect(onNext).not.toHaveBeenCalled()
      expect(github.updateConfig).not.toHaveBeenCalled()
      expect(alerts()).toEqual([GITHUB_CONFIG_UNREADABLE])

      github.getConfig.mockResolvedValue(read(savedConfig()))
      click(buttonContaining(page, 'Next'))
      await settle()
      expect(github.updateConfig).toHaveBeenCalledTimes(1)
      expect(github.updateConfig).toHaveBeenCalledWith({ seenOnboardingVersion: APP_VERSION, enabledByDefault: false })
      expect(onNext).toHaveBeenCalledTimes(1)
      expect(alerts()).toEqual([])
    })

    it('"Skip for now", offered once Next was refused, moves on with nothing read, sent or saved', async () => {
      github.getConfig.mockResolvedValue(DID_NOT_READ)
      const onNext = vi.fn()
      const page = render(<GitHubStep onNext={onNext} onBack={() => {}} />)
      await settle()
      click(buttonByText(page, 'Off'))
      click(buttonContaining(page, 'Next'))
      await settle()
      expect(onNext).not.toHaveBeenCalled()

      github.getConfig.mockClear()
      click(skipButton(page)!)
      await settle()

      expect(onNext).toHaveBeenCalledTimes(1)
      expect(github.getConfig).not.toHaveBeenCalled()
      expect(github.updateConfig).not.toHaveBeenCalled()
    })

    it('a save that main refused is shown the same way, without the wrapper of the call', async () => {
      github.updateConfig.mockRejectedValue(
        new Error(`Error invoking remote method 'github:config:update': Error: ${GITHUB_CONFIG_NOT_SAVED}`),
      )
      const onNext = vi.fn()
      const page = render(<GitHubStep onNext={onNext} onBack={() => {}} />)
      await settle()

      const unhandled = await unhandledDuring(() => click(buttonContaining(page, 'Next')))

      expect(github.updateConfig).toHaveBeenCalledTimes(1)
      expect(onNext).not.toHaveBeenCalled()
      expect(alerts()).toEqual([GITHUB_CONFIG_NOT_SAVED])
      expect(skipButton(page)).toBeDefined()
      expect(unhandled).toEqual([])
    })

    it('the line goes when the next action starts, and "Skip for now" stays on offer', async () => {
      github.getConfig.mockResolvedValue(DID_NOT_READ)
      github.ghcliDetect.mockResolvedValue({ ok: true, users: ['octo-user'] })
      github.adoptGhCli.mockImplementation(() => new Promise(() => {}))
      const page = render(<GitHubStep onNext={() => {}} onBack={() => {}} />)
      await settle()
      click(buttonContaining(page, 'Next'))
      await settle()
      expect(alerts()).toEqual([GITHUB_CONFIG_UNREADABLE])

      click(buttonByText(page, 'On'))
      click(buttonContaining(page, 'Use octo-user'))
      await settle()
      expect(alerts()).toEqual([])
      expect(skipButton(page)).toBeDefined()
    })

    it('Next clears the line a connect attempt left: the page says one thing at a time', async () => {
      github.ghcliDetect.mockResolvedValue({ ok: true, users: ['octo-user'] })
      github.adoptGhCli.mockResolvedValue({ ok: false, error: 'gh auth token failed' })
      github.updateConfig.mockRejectedValue(new Error(GITHUB_CONFIG_NOT_SAVED))
      const page = render(<GitHubStep onNext={() => {}} onBack={() => {}} />)
      await settle()
      click(buttonContaining(page, 'Use octo-user'))
      await settle()
      expect(alerts()).toEqual(['gh auth token failed'])

      click(buttonContaining(page, 'Next'))
      await settle()
      expect(alerts()).toEqual([GITHUB_CONFIG_NOT_SAVED])
    })

    it('Next waits for the save: the page moves on once it went through, and a second press saves nothing more', async () => {
      let finishSave: (config: GitHubConfig) => void = () => {}
      github.updateConfig.mockImplementation(() => new Promise<GitHubConfig>((done) => { finishSave = done }))
      const onNext = vi.fn()
      const page = render(<GitHubStep onNext={onNext} onBack={() => {}} />)
      await settle()

      click(buttonContaining(page, 'Next'))
      await settle()
      expect(github.updateConfig).toHaveBeenCalledTimes(1)
      expect(onNext).not.toHaveBeenCalled()
      expect(buttonContaining(page, 'Next').disabled).toBe(true)
      click(buttonContaining(page, 'Next'))
      await settle()
      expect(github.updateConfig).toHaveBeenCalledTimes(1)

      await act(async () => { finishSave(savedConfig()) })
      await settle()
      expect(onNext).toHaveBeenCalledTimes(1)
      expect(alerts()).toEqual([])
    })

    /** The page after a first Next was refused, so "Skip for now" is on offer,
     *  with the second Next's save left for the test to end. */
    async function refusedOnceThenSaving() {
      const save: { finish: (config: GitHubConfig) => void; refuse: (reason: Error) => void } = {
        finish: () => {},
        refuse: () => {},
      }
      github.updateConfig.mockRejectedValueOnce(new Error(GITHUB_CONFIG_NOT_SAVED))
      github.updateConfig.mockImplementationOnce(
        () => new Promise<GitHubConfig>((finish, refuse) => Object.assign(save, { finish, refuse })),
      )
      const onNext = vi.fn()
      const page = render(<GitHubStep onNext={onNext} onBack={() => {}} />)
      await settle()
      click(buttonContaining(page, 'Next'))
      await settle()
      expect(alerts()).toEqual([GITHUB_CONFIG_NOT_SAVED])
      expect(skipButton(page)!.disabled).toBe(false)
      expect(onNext).not.toHaveBeenCalled()
      return { page, onNext, save }
    }

    it('"Skip for now" is held while a second Next is saving, and once that save has ended it moves on with nothing saved', async () => {
      const { page, onNext, save } = await refusedOnceThenSaving()

      click(buttonContaining(page, 'Next'))
      await settle()
      expect(github.updateConfig).toHaveBeenCalledTimes(2)
      expect(skipButton(page)!.disabled).toBe(true)
      click(skipButton(page)!)
      await settle()
      expect(onNext).not.toHaveBeenCalled()

      // That save is refused as well: the page stays, and Skip is the way on again.
      await act(async () => { save.refuse(new Error(GITHUB_CONFIG_NOT_SAVED)) })
      await settle()
      expect(alerts()).toEqual([GITHUB_CONFIG_NOT_SAVED])
      expect(skipButton(page)!.disabled).toBe(false)

      github.getConfig.mockClear()
      click(skipButton(page)!)
      await settle()
      expect(onNext).toHaveBeenCalledTimes(1)
      expect(github.updateConfig).toHaveBeenCalledTimes(2)
      expect(github.getConfig).not.toHaveBeenCalled()
    })

    it('"Skip for now" pressed with Next, before the page has drawn it held, does not move on: the save does, once', async () => {
      const { page, onNext, save } = await refusedOnceThenSaving()

      // Both presses arrive before the page is drawn again.
      const next = buttonContaining(page, 'Next')
      const skip = skipButton(page)!
      let heldWhenPressed: boolean | undefined
      act(() => {
        next.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        heldWhenPressed = skip.disabled
        skip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await settle()
      // The press did reach a Skip that was not yet drawn as held.
      expect(heldWhenPressed).toBe(false)
      expect(github.updateConfig).toHaveBeenCalledTimes(2)
      expect(onNext).not.toHaveBeenCalled()

      await act(async () => { save.finish(savedConfig()) })
      await settle()
      expect(onNext).toHaveBeenCalledTimes(1)
      expect(alerts()).toEqual([])
    })

    it('Back pressed while the save is on its way: the flow is not moved on from under the user', async () => {
      let finishSave: (config: GitHubConfig) => void = () => {}
      github.updateConfig.mockImplementation(() => new Promise<GitHubConfig>((done) => { finishSave = done }))
      const onNext = vi.fn()
      const page = render(<GitHubStep onNext={onNext} onBack={() => {}} />)
      await settle()
      click(buttonContaining(page, 'Next'))
      await settle()

      // Back takes the page away.
      const shown = mounted.pop()!
      act(() => shown.root.unmount())
      shown.container.remove()
      await act(async () => { finishSave(savedConfig()) })
      await settle()

      expect(onNext).not.toHaveBeenCalled()
    })

    it('shows the sentence main refused a gh account with', async () => {
      github.ghcliDetect.mockResolvedValue({ ok: true, users: ['octo-user'] })
      github.adoptGhCli.mockResolvedValue({ ok: false, error: GITHUB_CONFIG_UNREADABLE })
      const page = render(<GitHubStep onNext={() => {}} onBack={() => {}} />)
      await settle()

      click(buttonContaining(page, 'Use octo-user'))
      await settle()

      expect(github.adoptGhCli).toHaveBeenCalledWith('octo-user')
      expect(alerts()).toEqual([GITHUB_CONFIG_UNREADABLE])
    })

    it('on a config that read, saves the master exactly as shown (unchanged for an untouched page)', async () => {
      const page = render(<GitHubStep onNext={() => {}} onBack={() => {}} />)
      await settle()
      click(buttonContaining(page, 'Next'))
      await settle()
      expect(github.updateConfig).toHaveBeenCalledWith({ seenOnboardingVersion: APP_VERSION, enabledByDefault: true })
    })
  })
})

describe('a refused save is not left as an unhandled rejection', () => {
  /** A store action that is refused, and what it was called with. A plain
   *  function, not vi.fn: a mock function watches the promise it returns,
   *  which would count as handling the rejection this is here to catch. */
  function refused() {
    const calls: unknown[][] = []
    const action = (...args: unknown[]): Promise<void> => {
      calls.push(args)
      return Promise.reject(new Error('the change was refused'))
    }
    return Object.assign(action, { calls })
  }


  function settingsPage(overrides: Record<string, unknown>): HTMLElement {
    useGitHubStore.setState({
      config: savedConfig(),
      profiles: [],
      loadConfig: async () => {},
      ...overrides,
    } as never)
    return render(<GitHubConfigTab />)
  }

  it('the Enable GitHub checkbox', async () => {
    const updateConfig = refused()
    const page = settingsPage({ updateConfig })
    const box = Array.from(page.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .find((c) => (c.closest('label')?.textContent ?? '').includes('Enable GitHub'))!
    expect(await unhandledDuring(() => click(box))).toEqual([])
    expect(updateConfig.calls).toEqual([[{ enabledByDefault: false }]])
  })

  it('the privacy checkbox', async () => {
    const updateConfig = refused()
    const page = settingsPage({ updateConfig })
    const box = Array.from(page.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .find((c) => (c.closest('label')?.textContent ?? '').includes('Scan this session'))!
    expect(await unhandledDuring(() => click(box))).toEqual([])
    expect(updateConfig.calls).toEqual([[{ transcriptScanningOptIn: false }]])
  })

  it('a sync interval', async () => {
    const updateConfig = refused()
    const page = settingsPage({ updateConfig })
    const select = page.querySelectorAll('select')[2]
    expect(await unhandledDuring(() => choose(select, '60'))).toEqual([])
    expect(updateConfig.calls).toEqual([[{ syncIntervals: { notificationsSec: 60 } }]])
  })

  it('an app-wide toggle', async () => {
    const setAppWideToggle = refused()
    const page = settingsPage({ setAppWideToggle })
    const toggle = page.querySelector('[role="switch"][aria-label="Session context"]')!
    expect(await unhandledDuring(() => click(toggle))).toEqual([])
    expect(setAppWideToggle.calls).toEqual([['sessionContext', true]])
  })
})

describe('the device sign-in dialog', () => {
  const flow = { flowId: 'flow-1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900 }
  const WAITING = 'Waiting for you to complete auth in the browser'

  it('says it is waiting while the sign-in is open', async () => {
    github.oauthPoll.mockImplementation(() => new Promise(() => {}))
    render(<OAuthDeviceFlow flow={flow} onDone={() => {}} onCancel={() => {}} />)
    await settle()
    expect(document.body.textContent).toContain(WAITING)
    expect(alerts()).toEqual([])
  })

  it('shows the sentence main refused with, and no longer says it is waiting', async () => {
    github.oauthPoll.mockResolvedValue({ ok: false, error: GITHUB_CONFIG_UNREADABLE })
    const onDone = vi.fn()
    render(<OAuthDeviceFlow flow={flow} onDone={onDone} onCancel={() => {}} />)
    await settle()
    expect(alerts()).toEqual([`Error: ${GITHUB_CONFIG_UNREADABLE}`])
    expect(document.body.textContent).not.toContain(WAITING)
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('the add-account dialog', () => {
  async function openAdvanced(): Promise<void> {
    github.ghcliDetect.mockResolvedValue({ ok: true, users: ['octo-user'] })
    render(<AddProfileModal onClose={() => {}} />)
    await settle()
    click(buttonContaining(document.body, 'advanced auth options'))
  }

  it('shows the sentence main refused a gh account with', async () => {
    github.adoptGhCli.mockResolvedValue({ ok: false, error: GITHUB_CONFIG_UNREADABLE })
    await openAdvanced()
    click(buttonContaining(document.body, 'octo-user'))
    await settle()
    expect(alerts()).toEqual([GITHUB_CONFIG_UNREADABLE])
  })

  it('shows the sentence main refused a token with', async () => {
    github.addPat.mockResolvedValue({ ok: false, error: GITHUB_CONFIG_UNREADABLE })
    await openAdvanced()
    typeInto(document.body.querySelector<HTMLInputElement>('input[type="password"]')!, 'not-a-real-token-value')
    click(buttonByText(document.body, 'Save PAT'))
    await settle()
    expect(alerts()).toEqual([GITHUB_CONFIG_UNREADABLE])
  })

  it('a token submit clears the error an earlier sign-in attempt left', async () => {
    github.adoptGhCli.mockResolvedValue({ ok: false, error: 'gh auth token failed' })
    github.addPat.mockResolvedValue({ ok: false, error: 'Invalid token' })
    await openAdvanced()
    click(buttonContaining(document.body, 'octo-user'))
    await settle()
    expect(alerts()).toEqual(['gh auth token failed'])

    typeInto(document.body.querySelector<HTMLInputElement>('input[type="password"]')!, 'not-a-real-token-value')
    click(buttonByText(document.body, 'Save PAT'))
    await settle()
    expect(alerts()).toEqual(['Invalid token'])
  })
})
