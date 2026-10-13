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
  setDataDir: vi.fn(async (_dir: string): Promise<boolean> => true),
  setResourcesDir: vi.fn(async (_dir: string): Promise<boolean> => true),
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

  it('both saved the first time: no message, straight on to the Claude Code step', async () => {
    await renderFolderStep()
    expect(byTest('setup-folder-error')).toBeNull()
    await pressContinue()
    expect(byTest('setup-continue')).toBeNull()
    expect(byTest('setup-folder-error')).toBeNull()
    expect(setup.probeCli).toHaveBeenCalled()
  })
})
