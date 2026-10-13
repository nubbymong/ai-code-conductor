// @vitest-environment jsdom
/**
 * First-run setup, the folder step: while a press of Continue is saving the
 * folders, the step is held. Continue, both folder fields and both Browse
 * buttons are disabled until main has answered, so a second press cannot
 * start a second save, and the folder that is saved is the one the fields
 * showed when Continue was pressed.
 *
 * Main's answers are held back here (deferred) and given in the order main
 * would give them, so the window in which a save is out can be acted in.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type Pending = { dir: string; answer: (saved: boolean) => void }
const pendingData: Pending[] = []
const pendingResources: Pending[] = []
function heldAnswer(list: Pending[]) {
  return (dir: string) => new Promise<boolean>((resolve) => { list.push({ dir, answer: resolve }) })
}

const setup = {
  getDefaultDataDir: vi.fn(async () => 'C:\\data'),
  getResourcesDir: vi.fn(async () => 'C:\\resources'),
  selectDataDir: vi.fn(async () => null),
  selectResourcesDir: vi.fn(async () => null),
  setDataDir: vi.fn(heldAnswer(pendingData)),
  setResourcesDir: vi.fn(heldAnswer(pendingResources)),
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
  pendingData.length = 0
  pendingResources.length = 0
  setup.setDataDir.mockClear()
  setup.setResourcesDir.mockClear()
  setup.probeCli.mockClear()
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} }
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const fields = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="text"]'))
const dataField = () => fields()[0]
const browseButtons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter((b) => b.textContent?.trim() === 'Browse')
const continueButton = () => byTest('setup-continue') as HTMLButtonElement

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() })
}

async function renderFolderStep() {
  await act(async () => { root.render(React.createElement(SetupDialog, { onComplete: vi.fn() })) })
  await settle()
  expect(continueButton()).not.toBeNull()
  expect(dataField().value).toBe('C:\\data')
}

/** A press of Continue, as a user makes it (a disabled button takes no press). */
async function pressContinue() {
  await act(async () => { continueButton().click() })
  await settle()
}

/** Typing into a field, as a user does it: a disabled field takes no typing. */
async function userTypes(input: HTMLInputElement, value: string) {
  if (input.disabled) return
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}

/** Main answers the save of `dir` that is out, if one is. */
async function answer(list: Pending[], dir: string, saved: boolean) {
  const at = list.findIndex((p) => p.dir === dir)
  if (at < 0) return
  const [p] = list.splice(at, 1)
  await act(async () => { p.answer(saved) })
  await settle()
}

async function pressBack() {
  expect(byTest('setup-cli-back')).not.toBeNull()
  await act(async () => { byTest('setup-cli-back')!.click() })
  await settle()
}

const focused = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null

/** A focused button that becomes disabled loses the focus in the browser
 *  (it falls to the page body). jsdom keeps it there, and ignores blur() on a
 *  disabled element, so the drop is made the way jsdom does honour: focus
 *  moves to an element that is then removed. */
function dropFocusToBody() {
  const tmp = document.createElement('input')
  document.body.appendChild(tmp)
  tmp.focus()
  tmp.remove()
  expect(document.activeElement).toBe(document.body)
}

/** The folder picker, held open until `pick` is called. */
function holdPicker(select: typeof setup.selectDataDir): { pick: (dir: string | null) => Promise<void> } {
  let resolve!: (dir: string | null) => void
  select.mockImplementationOnce(() => new Promise<string | null>((r) => { resolve = r }) as never)
  return {
    pick: async (dir) => {
      await act(async () => { resolve(dir) })
      await settle()
    },
  }
}

describe('first-run setup: the folder step is held while its save is out', () => {
  // Mutation to prove this can fail: drop the disabled state from Continue,
  // the folder fields and the Browse buttons.
  it('Continue, both folder fields and both Browse buttons are disabled until main answers, and enabled again after', async () => {
    await renderFolderStep()
    await pressContinue()
    expect(setup.setDataDir).toHaveBeenCalledTimes(1)

    expect(continueButton().disabled).toBe(true)
    expect(fields()).toHaveLength(2)
    for (const f of fields()) expect(f.disabled).toBe(true)
    expect(browseButtons()).toHaveLength(2)
    for (const b of browseButtons()) expect(b.disabled).toBe(true)

    // Main refuses the data directory: the step is the user's again.
    await answer(pendingData, 'C:\\data', false)
    expect(byTest('setup-folder-error')).not.toBeNull()
    expect(continueButton().disabled).toBe(false)
    for (const f of fields()) expect(f.disabled).toBe(false)
    for (const b of browseButtons()) expect(b.disabled).toBe(false)
  })

  // Case 1: an earlier press that saved must not move setup on past a later
  // press whose folder was refused, leaving the refusal unseen and the field
  // naming a folder that was not the one saved.
  // Mutation to prove this can fail: leave the folder fields enabled, or let
  // a second press start its own save.
  it('a folder typed and a second press while the first save is out: no second save, and the folder saved is the one shown', async () => {
    await renderFolderStep()
    await pressContinue()
    await userTypes(dataField(), 'C:\\other')
    await pressContinue()

    await answer(pendingData, 'C:\\data', true)
    await answer(pendingData, 'C:\\other', false)
    await answer(pendingResources, 'C:\\resources', true)

    expect(setup.setDataDir.mock.calls.map((c) => c[0])).toEqual(['C:\\data'])
    expect(setup.setResourcesDir.mock.calls.map((c) => c[0])).toEqual(['C:\\resources'])
    // On to the Claude Code step, and back: the field shows the folder that
    // was saved, and no message is left over.
    expect(byTest('setup-continue')).toBeNull()
    expect(setup.probeCli).toHaveBeenCalled()
    await pressBack()
    expect(dataField().value).toBe('C:\\data')
    expect(byTest('setup-folder-error')).toBeNull()
  })

  // Case 2: the refusal of an earlier press must not stay on screen for a
  // folder that a later press saved.
  // Mutation to prove this can fail: let a second press start its own save.
  it('a refusal of the first press stays on the folder step, and a later press after it goes on with no message left over', async () => {
    await renderFolderStep()
    await pressContinue()
    await userTypes(dataField(), 'C:\\other')
    await pressContinue()

    await answer(pendingData, 'C:\\data', false)
    await answer(pendingData, 'C:\\other', true)
    await answer(pendingResources, 'C:\\resources', true)

    // Only the first press saved anything, and main refused it.
    expect(setup.setDataDir.mock.calls.map((c) => c[0])).toEqual(['C:\\data'])
    expect(setup.setResourcesDir).not.toHaveBeenCalled()
    expect(continueButton()).not.toBeNull()
    expect(byTest('setup-folder-error')!.textContent).toContain('The data directory could not be saved.')

    // The user chooses another folder and presses again; main saves both.
    await userTypes(dataField(), 'C:\\other')
    expect(dataField().value).toBe('C:\\other')
    await pressContinue()
    await answer(pendingData, 'C:\\other', true)
    await answer(pendingResources, 'C:\\resources', true)
    expect(byTest('setup-continue')).toBeNull()
    await pressBack()
    expect(dataField().value).toBe('C:\\other')
    expect(byTest('setup-folder-error')).toBeNull()
  })

  // Two presses that land before the screen has drawn the disabled button
  // (a double click): the second one starts nothing.
  // Mutation to prove this can fail: drop the in-flight ref (keep only the
  // disabled state).
  it('two presses before the screen redraws start one save', async () => {
    await renderFolderStep()
    await act(async () => {
      continueButton().click()
      continueButton().click()
    })
    await settle()
    expect(setup.setDataDir).toHaveBeenCalledTimes(1)
    await answer(pendingData, 'C:\\data', true)
    await answer(pendingResources, 'C:\\resources', true)
    expect(setup.setResourcesDir).toHaveBeenCalledTimes(1)
    expect(byTest('setup-continue')).toBeNull()
  })
})

describe('first-run setup: the focus when a folder save fails', () => {
  // Continue is disabled while the save is out, so the browser drops the
  // focus it had to the page body; nothing else on the step gives it back.
  // Mutation to prove this can fail: drop the effect that focuses Continue.
  it('Continue has the focus again when a folder save fails', async () => {
    await renderFolderStep()
    expect(focused()).toBe('setup-continue')
    await pressContinue()
    expect(continueButton().disabled).toBe(true)
    dropFocusToBody()

    await answer(pendingData, 'C:\\data', false)

    expect(byTest('setup-folder-error')).not.toBeNull()
    expect(continueButton().disabled).toBe(false)
    expect(focused()).toBe('setup-continue')
  })

  it('the same when the resources directory is the one not saved', async () => {
    await renderFolderStep()
    await pressContinue()
    dropFocusToBody()
    await answer(pendingData, 'C:\\data', true)
    expect(continueButton().disabled).toBe(true)

    await answer(pendingResources, 'C:\\resources', false)

    expect(byTest('setup-folder-error')!.textContent).toContain('The resources directory could not be saved.')
    expect(focused()).toBe('setup-continue')
  })

  // Mutation to prove this can fail: focus Continue whatever has the focus.
  it('a control the user moved to while the save was out keeps the focus', async () => {
    await renderFolderStep()
    await pressContinue()
    byTest('setup-exit')!.focus()
    expect(focused()).toBe('setup-exit')

    await answer(pendingData, 'C:\\data', false)

    expect(byTest('setup-folder-error')).not.toBeNull()
    expect(focused()).toBe('setup-exit')
  })
})

describe('first-run setup: a folder picked while the save is out', () => {
  // The picker is not tied to the window, so it can be left open across a
  // press of Continue. A folder picked while the save is out would change the
  // field to a folder other than the one being saved (case 1 above, reached
  // through Browse instead of typing).
  // Mutation to prove this can fail: set the field from the picker whatever
  // the save is doing.
  it('the data directory: the pick is dropped, and the field keeps the folder that was saved', async () => {
    await renderFolderStep()
    const picker = holdPicker(setup.selectDataDir)
    await act(async () => { browseButtons()[0].click() })
    await pressContinue()
    expect(setup.setDataDir.mock.calls.map((c) => c[0])).toEqual(['C:\\data'])

    await picker.pick('C:\\other')
    expect(dataField().value).toBe('C:\\data')

    await answer(pendingData, 'C:\\data', true)
    await answer(pendingResources, 'C:\\resources', true)
    expect(byTest('setup-continue')).toBeNull()
    await pressBack()
    expect(dataField().value).toBe('C:\\data')
  })

  it('the resources directory: the same', async () => {
    await renderFolderStep()
    const picker = holdPicker(setup.selectResourcesDir)
    await act(async () => { browseButtons()[1].click() })
    await pressContinue()

    await picker.pick('C:\\other')
    expect(fields()[1].value).toBe('C:\\resources')

    await answer(pendingData, 'C:\\data', false)
    expect(byTest('setup-folder-error')).not.toBeNull()
    expect(fields()[1].value).toBe('C:\\resources')
  })

  // Mutation to prove this can fail: drop every pick that comes back after
  // Continue was pressed, not only one that comes back while the save is out.
  it('a folder picked once the save has ended is used', async () => {
    await renderFolderStep()
    const picker = holdPicker(setup.selectDataDir)
    await act(async () => { browseButtons()[0].click() })
    await pressContinue()
    await answer(pendingData, 'C:\\data', false)
    expect(byTest('setup-folder-error')).not.toBeNull()

    await picker.pick('C:\\other')
    expect(dataField().value).toBe('C:\\other')
  })
})
