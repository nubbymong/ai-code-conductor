// First-run setup's folder step (setup:setDataDir, setup:setResourcesDir).
// A folder that was saved answers true and one that was not answers false.
// On macOS and Linux the folders are saved in a settings file under the home
// folder (platform-config.json). When a folder was not saved and that file is
// there but does not read, the handler answers null in place of false
// (SETTINGS_FILE_UNREADABLE), so the step can say to repair or remove the
// file: choosing another folder would not help. Never on Windows, where the
// folders are in the registry. A save that was refused is never answered
// with a value that reads as true: only true is "saved".
//
// The REAL handlers. The folder saves and the settings file's state are
// stand-ins, so nothing is read and nothing is written.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The real module (tests/unit/setup.ts stands it in for every other file).
vi.unmock('../../../src/main/ipc/setup-handlers')

const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>())
const state = vi.hoisted(() => ({
  dataSaved: true,
  resourcesSaved: true,
  /** The settings file is there and does not read. */
  unreadable: false,
  /** The look at the settings file fails outright. */
  lookThrows: false,
  looks: 0,
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: () => '' },
}))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
vi.mock('../../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: 'claude', args: [] }) }))
vi.mock('../../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../../src/main/login-shell', () => ({ defaultLoginShell: () => '/bin/zsh' }))
vi.mock('../../../src/main/pty-input-guard', () => ({ guardPtyIo: vi.fn() }))
vi.mock('../../../src/main/data-paths', () => ({
  getDataDirectory: () => '', getResourcesDirectory: () => '', isDataDirFromRegistry: () => false,
  setDataDirectory: vi.fn(() => state.dataSaved),
  setResourcesDirectory: vi.fn(() => state.resourcesSaved),
}))
vi.mock('../../../src/main/platform-config-store', () => ({
  platformConfigUnreadable: () => {
    state.looks++
    if (state.lookThrows) throw new Error('the look failed')
    return state.unreadable
  },
}))
vi.mock('../../../src/main/claude-cli-probe', () => ({ probeClaudeCli: vi.fn(async () => ({ installed: false, probe: 'PATH walk' })) }))
vi.mock('../../../src/main/windows-path-refresh', () => ({ afterPathRefresh: vi.fn(async (check: () => Promise<unknown>) => check()) }))
vi.mock('../../../src/main/install-folder-path', () => ({ pathHintFor: vi.fn(async () => undefined) }))

import { registerSetupHandlers } from '../../../src/main/ipc/setup-handlers'
import { SETTINGS_FILE_UNREADABLE, SETTINGS_FILE_UNREADABLE_TEXT } from '../../../src/shared/setup-folder-save'

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const on = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true })
const setData = (dir = '/ccc-test/data') => handlers.get('setup:setDataDir')!({ sender: {} }, dir)
const setResources = (dir = '/ccc-test/res') => handlers.get('setup:setResourcesDir')!({ sender: {} }, dir)

beforeEach(() => {
  handlers.clear()
  state.dataSaved = true
  state.resourcesSaved = true
  state.unreadable = false
  state.lookThrows = false
  state.looks = 0
  registerSetupHandlers()
})
afterEach(() => { Object.defineProperty(process, 'platform', hostPlatform) })

describe('first-run setup: what a folder save answers', () => {
  it.each(['linux', 'darwin', 'win32'] as const)('%s: a folder that was saved answers true, and the settings file is not looked at', async (platform) => {
    on(platform)
    state.unreadable = true
    expect(await setData()).toBe(true)
    expect(await setResources()).toBe(true)
    expect(state.looks).toBe(0)
  })

  // Mutation to prove this can fail: answer the save's own false.
  it.each(['linux', 'darwin'] as const)('%s: not saved, and the settings file is there but does not read: the answer that says so', async (platform) => {
    on(platform)
    state.dataSaved = false
    state.resourcesSaved = false
    state.unreadable = true
    expect(await setData()).toBe(SETTINGS_FILE_UNREADABLE)
    expect(await setResources()).toBe(SETTINGS_FILE_UNREADABLE)
    expect(await setData()).not.toBe(false)
  })

  // Mutation to prove this can fail: answer a word (any text reads as true).
  it.each([
    ['linux', true], ['linux', false], ['darwin', true], ['darwin', false], ['win32', true], ['win32', false],
  ] as const)('%s, settings file unreadable %s: a save that was refused never answers a value that reads as true', async (platform, unreadable) => {
    on(platform)
    state.dataSaved = false
    state.resourcesSaved = false
    state.unreadable = unreadable
    for (const answer of [await setData(), await setResources()]) {
      // What a caller that only asks "was it saved?" reads.
      expect(answer ? 'saved' : 'not saved').toBe('not saved')
      expect(answer === false || answer === null).toBe(true)
    }
  })

  it.each(['linux', 'darwin'] as const)('%s: not saved for another reason (the settings file reads, or there is none): false', async (platform) => {
    on(platform)
    state.dataSaved = false
    state.resourcesSaved = false
    expect(await setData()).toBe(false)
    expect(await setResources()).toBe(false)
  })

  it('Windows saves its folders in the registry: never that word, and the settings file is not looked at', async () => {
    on('win32')
    state.dataSaved = false
    state.resourcesSaved = false
    state.unreadable = true
    expect(await setData()).toBe(false)
    expect(await setResources()).toBe(false)
    expect(state.looks).toBe(0)
  })

  it('a look at the settings file that fails outright is the plain answer', async () => {
    on('linux')
    state.dataSaved = false
    state.lookThrows = true
    expect(await setData()).toBe(false)
  })

  it('the answer and its sentence: the answer is null, and the sentence names the file and what to do, and no folder of this computer', () => {
    expect(SETTINGS_FILE_UNREADABLE).toBeNull()
    expect(SETTINGS_FILE_UNREADABLE_TEXT).toContain('.ai-code-conductor/platform-config.json')
    expect(SETTINGS_FILE_UNREADABLE_TEXT).toContain('.claude-conductor')
    expect(SETTINGS_FILE_UNREADABLE_TEXT).toContain('Repair that file or remove it, then press Continue again.')
    expect(SETTINGS_FILE_UNREADABLE_TEXT).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//)
  })
})
