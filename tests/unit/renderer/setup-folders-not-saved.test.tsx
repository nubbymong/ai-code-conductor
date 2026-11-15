// @vitest-environment jsdom
/**
 * First-run setup, the folder step: a folder main did not save is never
 * passed over as if it were set.
 *
 * setup.setDataDir and setup.setResourcesDir answer false when main could
 * not create the folder or the registry did not save it (data-paths.ts), and
 * a call can also fail outright. Continue then stays on the folder step and
 * says which folder was not saved; it goes on to the Claude Code step only
 * once both were saved.
 *
 * On macOS and Linux the folders are saved in a settings file under the home
 * folder. When that file is there but could not be read, main leaves it as
 * it is and answers null in place of false (shared/setup-folder-save.ts).
 * The step then says which file it is and to repair or remove it, not to
 * choose another folder, which would not be saved either. Only true is
 * "saved": no other answer, text included, is read as saved or as a reason.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const setup = {
  getDefaultDataDir: vi.fn(async () => 'C:\\data'),
  getResourcesDir: vi.fn(async () => 'C:\\resources'),
  selectDataDir: vi.fn(async () => null),
  selectResourcesDir: vi.fn(async () => null),
  setDataDir: vi.fn(async (_dir: string): Promise<boolean | null> => true),
  setResourcesDir: vi.fn(async (_dir: string): Promise<boolean | null> => true),
  probeCli: vi.fn(async () => ({ installed: false, probe: 'where claude' })),
  spawnCliSetup: vi.fn(async () => '__cli_setup__'),
  killCliSetup: vi.fn(async () => true),
}
const pty = {
  onData: vi.fn(() => () => {}),
  onExit: vi.fn(() => () => {}),
  write: vi.fn(),
}
const providerAccounts = { installRecipes: vi.fn(async () => []), addToPath: vi.fn() }
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, setup, pty, providerAccounts }

vi.mock('@xterm/xterm', () => ({ Terminal: class { cols = 80; rows = 24; loadAddon() {} open() {} write() {} writeln() {} onData() {} dispose() {} focus() {} } }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

const { default: SetupDialog } = await import('../../../src/renderer/components/SetupDialog')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  setup.setDataDir.mockReset().mockResolvedValue(true)
  setup.setResourcesDir.mockReset().mockResolvedValue(true)
  setup.probeCli.mockClear()
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} }
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() })
}

async function renderFolderStep(onComplete = vi.fn()) {
  await act(async () => { root.render(React.createElement(SetupDialog, { onComplete })) })
  await settle()
  expect(byTest('setup-continue')).not.toBeNull()
  return onComplete
}

async function pressContinue() {
  await act(async () => { byTest('setup-continue')!.click() })
  await settle()
}

const DATA_NOT_SAVED = 'The data directory could not be saved.'
const RESOURCES_NOT_SAVED = 'The resources directory could not be saved.'
/** What the step says only when the folder itself is the reason. */
const CHOOSE_ANOTHER = 'Choose another folder and press Continue again.'
/** What the step says when the settings file is the reason. */
const SETTINGS_FILE = '.ai-code-conductor/platform-config.json'
const REPAIR_OR_REMOVE = 'Repair that file or remove it, then press Continue again.'

describe('first-run setup: a folder main did not save', () => {
  // Mutation to prove this can fail: go on to step 2 without reading the answers.
  it('the data directory not saved: stays on the folder step, says so, and does not go on to the resources folder', async () => {
    setup.setDataDir.mockResolvedValue(false)
    const onComplete = await renderFolderStep()
    await pressContinue()

    expect(byTest('setup-continue')).not.toBeNull()
    const error = byTest('setup-folder-error')
    expect(error).not.toBeNull()
    expect(error!.getAttribute('role')).toBe('alert')
    expect(error!.textContent).toContain(DATA_NOT_SAVED)
    expect(setup.setResourcesDir).not.toHaveBeenCalled()
    expect(setup.probeCli).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  // Mutation to prove this can fail: read only the data directory's answer.
  it('the resources directory not saved: stays on the folder step and names the resources directory', async () => {
    setup.setResourcesDir.mockResolvedValue(false)
    await renderFolderStep()
    await pressContinue()

    expect(setup.setDataDir).toHaveBeenCalledWith('C:\\data')
    expect(setup.setResourcesDir).toHaveBeenCalledWith('C:\\resources')
    expect(byTest('setup-continue')).not.toBeNull()
    expect(byTest('setup-folder-error')!.textContent).toContain(RESOURCES_NOT_SAVED)
    expect(setup.probeCli).not.toHaveBeenCalled()
  })

  // Mutation to prove this can fail: let a call that fails outright escape the handler.
  it('a call that fails outright counts as not saved', async () => {
    setup.setDataDir.mockRejectedValue(new Error('ipc closed'))
    await renderFolderStep()
    await pressContinue()

    expect(byTest('setup-continue')).not.toBeNull()
    expect(byTest('setup-folder-error')!.textContent).toContain(DATA_NOT_SAVED)
    expect(setup.probeCli).not.toHaveBeenCalled()
  })

  // Mutation to prove this can fail: keep the last message when Continue is pressed again.
  it('once both are saved, Continue goes on to the Claude Code step and the message is gone, also after Back', async () => {
    setup.setDataDir.mockResolvedValueOnce(false)
    await renderFolderStep()
    await pressContinue()
    expect(byTest('setup-folder-error')).not.toBeNull()

    await pressContinue()
    expect(byTest('setup-continue')).toBeNull()
    expect(setup.probeCli).toHaveBeenCalled()

    // The folder step is unmounted on the Claude Code step, so the message
    // can be seen to be gone only back on the folder step.
    expect(byTest('setup-cli-back')).not.toBeNull()
    await act(async () => { byTest('setup-cli-back')!.click() })
    await settle()
    expect(byTest('setup-continue')).not.toBeNull()
    expect(byTest('setup-folder-error')).toBeNull()
  })

  // Mutation to prove this can fail: read the answer as true or not true only.
  it('the settings file could not be read: stays on the folder step, names the file and says to repair or remove it', async () => {
    setup.setDataDir.mockResolvedValue(null)
    const onComplete = await renderFolderStep()
    await pressContinue()

    expect(byTest('setup-continue')).not.toBeNull()
    const error = byTest('setup-folder-error')
    expect(error).not.toBeNull()
    expect(error!.getAttribute('role')).toBe('alert')
    expect(error!.textContent).toContain(DATA_NOT_SAVED)
    expect(error!.textContent).toContain(SETTINGS_FILE)
    expect(error!.textContent).toContain(REPAIR_OR_REMOVE)
    // Another folder would not be saved either, so the step does not say to choose one.
    expect(error!.textContent).not.toContain(CHOOSE_ANOTHER)
    expect(setup.setResourcesDir).not.toHaveBeenCalled()
    expect(setup.probeCli).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('the settings file could not be read at the resources folder: the same sentence, for the resources directory', async () => {
    setup.setResourcesDir.mockResolvedValue(null)
    await renderFolderStep()
    await pressContinue()

    expect(byTest('setup-continue')).not.toBeNull()
    const text = byTest('setup-folder-error')!.textContent
    expect(text).toContain(RESOURCES_NOT_SAVED)
    expect(text).toContain(SETTINGS_FILE)
    expect(text).toContain(REPAIR_OR_REMOVE)
    expect(setup.probeCli).not.toHaveBeenCalled()
  })

  it('a folder that was not saved for its own reason still says to choose another folder', async () => {
    setup.setDataDir.mockResolvedValue(false)
    await renderFolderStep()
    await pressContinue()
    const text = byTest('setup-folder-error')!.textContent
    expect(text).toContain(CHOOSE_ANOTHER)
    expect(text).not.toContain(SETTINGS_FILE)
  })

  // Mutation to prove this can fail: take any answer that is not false as saved.
  it('an answer that is neither true nor null counts as not saved for the folder\'s own reason, text included', async () => {
    for (const answer of ['saved', 'true', 'settings-file-unreadable', 1, undefined, {}]) {
      setup.setDataDir.mockReset().mockResolvedValue(answer as never)
      setup.setResourcesDir.mockClear()
      await renderFolderStep()
      await pressContinue()
      expect(byTest('setup-continue'), String(answer)).not.toBeNull()
      const text = byTest('setup-folder-error')!.textContent
      expect(text, String(answer)).toContain(DATA_NOT_SAVED)
      expect(text, String(answer)).toContain(CHOOSE_ANOTHER)
      expect(setup.setResourcesDir, String(answer)).not.toHaveBeenCalled()
      act(() => { root.unmount() })
      root = createRoot(container)
    }
  })

  it('both saved the first time: no message, straight on to the Claude Code step', async () => {
    await renderFolderStep()
    expect(byTest('setup-folder-error')).toBeNull()
    await pressContinue()
    expect(byTest('setup-continue')).toBeNull()
    expect(byTest('setup-folder-error')).toBeNull()
    expect(setup.probeCli).toHaveBeenCalled()
  })
})
