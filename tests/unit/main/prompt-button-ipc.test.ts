// [host] 2.1.3-beta.10 section A1 (#333), the IPC side of a command bar prompt
// button (src/main/ipc/pty-handlers.ts, `pty:submitPrompt`):
//  - answered only to the app's own window (its top frame), with a strict
//    payload ({ sessionId, text }, both strings, the text capped), and handed
//    to main's door (session-input submitPrompt), never written raw;
//  - a partner terminal's id is refused (its buttons are shell lines);
//  - main reads the mode itself, at each press, from the saved settings:
//    `type` only when `commandPromptButtons` is exactly 'type'; anything else,
//    an unreadable settings file included, sends;
//  - the preload bridge (pty.submitPrompt) invokes exactly this channel with
//    the payload unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  prompts: [] as Array<{ sessionId: string; text: string; mode: string }>,
  settings: null as unknown,
  readThrows: false,
  exposed: {} as Record<string, any>,
  invoke: vi.fn(async () => undefined),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { h.handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: class {},
  app: { getVersion: () => '9.9.9-test' },
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { h.exposed[name] = api } },
  ipcRenderer: { invoke: h.invoke, send: vi.fn(), on: vi.fn(), removeListener: vi.fn(), once: vi.fn(), off: vi.fn(), sendSync: vi.fn() },
}))
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: vi.fn(), writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(), endSshRemote: vi.fn(),
  beginSpawnPreparation: vi.fn(), holdsCodexLaunchLease: () => false, codexLaunchLeaseTaken: () => false,
  isSessionLiveOrStarting: () => false, getKeptCodexConversationSource: () => undefined, getKeptCodexConversation: () => undefined,
  codexRunEnded: async () => true, endAgentRunsInFolder: vi.fn(async () => true),
}))
vi.mock('../../../src/main/session-input', () => ({
  handOffAskQuestion: vi.fn(async () => ({ delivered: true })),
  submitPrompt: vi.fn(async (sessionId: string, text: string, mode: string) => { h.prompts.push({ sessionId, text, mode }); return { outcome: 'sent' } }),
}))
vi.mock('../../../src/main/help-workspace', () => ({ ensureHelpWorkspace: vi.fn(), helpWorkspaceDir: (dir: string) => `${dir}/help` }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => 'C:/res' }))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => true }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn() }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: (key: string) => {
    if (h.readThrows) throw new Error('EACCES')
    return key === 'settings' ? h.settings : null
  },
}))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null }))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({ prepareLaunch: async () => ({ ok: false }), snapshot: () => ({ providers: [], accounts: [] }), remoteLaunchRefusal: () => null }),
}))
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))

const { IPC } = await import('../../../src/shared/ipc-channels')
const { registerPtyHandlers, promptButtonModeIn, PROMPT_BUTTON_MAX_CHARS } = await import('../../../src/main/ipc/pty-handlers')
const sessionInput = await import('../../../src/main/session-input')
const debugCapture = await import('../../../src/main/debug-capture')
const ptyManager = await import('../../../src/main/pty-manager')

const mainFrame = { id: 'top' }
const webContents = { mainFrame }
const win = { isDestroyed: () => false, webContents }
registerPtyHandlers(() => win as never)
const submit = h.handlers.get(IPC.PTY_SUBMIT_PROMPT)!
const fromApp = { sender: webContents, senderFrame: mainFrame }
const SID = 'sess1111sess1111sess1111'

beforeEach(() => {
  h.prompts = []
  h.settings = null
  h.readThrows = false
  vi.mocked(sessionInput.submitPrompt).mockClear()
  vi.mocked(debugCapture.logUserInput).mockClear()
  vi.mocked(ptyManager.writePty).mockClear()
})

describe('pty:submitPrompt', () => {
  it('[host] is registered under its own channel', () => {
    expect(IPC.PTY_SUBMIT_PROMPT).toBe('pty:submitPrompt')
    expect(typeof submit).toBe('function')
  })

  it('[host] the app\'s window: the text goes to main\'s door, whole, and its answer comes back; nothing is written raw or logged', async () => {
    expect(await submit(fromApp, { sessionId: SID, text: 'explain this\nfile' })).toEqual({ outcome: 'sent' })
    expect(h.prompts).toEqual([{ sessionId: SID, text: 'explain this\nfile', mode: 'send' }])
    expect(ptyManager.writePty).not.toHaveBeenCalled()
    // Debug capture is on in this file, and still the prompt's text is not captured.
    expect(debugCapture.logUserInput).not.toHaveBeenCalled()
  })

  it('[host] another sender, or a frame inside the window: nothing handed over', async () => {
    expect(await submit({ sender: {}, senderFrame: mainFrame }, { sessionId: SID, text: 'x' })).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
    expect(await submit({ sender: webContents, senderFrame: { id: 'child' } }, { sessionId: SID, text: 'x' })).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
    expect(h.prompts).toEqual([])
  })

  it.each([
    ['no payload', undefined],
    ['a payload that is not an object', 'explain this'],
    ['an unknown key', { sessionId: SID, text: 'x', mode: 'send' }],
    ['the Enter asked for by the renderer', { sessionId: SID, text: 'x', enter: true }],
    ['a session id that is not one', { sessionId: '../../etc', text: 'x' }],
    ['no session id', { text: 'x' }],
    ['no text', { sessionId: SID }],
    ['an empty text', { sessionId: SID, text: '' }],
    ['a text of the wrong type', { sessionId: SID, text: 42 }],
    ['a text past the cap', { sessionId: SID, text: 'q'.repeat(PROMPT_BUTTON_MAX_CHARS + 1) }],
  ])('[host] refuses %s', async (_name, payload) => {
    expect(await submit(fromApp, payload)).toEqual({ outcome: 'not-sent', reason: 'refused-text' })
    expect(h.prompts).toEqual([])
  })

  it('[host] takes a text exactly at the cap', async () => {
    expect(await submit(fromApp, { sessionId: SID, text: 'q'.repeat(PROMPT_BUTTON_MAX_CHARS) })).toEqual({ outcome: 'sent' })
    expect(h.prompts).toHaveLength(1)
  })

  it('[host] refuses a partner terminal\'s id: its buttons are shell lines, which keep pty:write', async () => {
    expect(await submit(fromApp, { sessionId: `${SID}-partner`, text: 'make dist' })).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
    expect(h.prompts).toEqual([])
  })
})

describe('the mode is main\'s, read from the saved settings at each press', () => {
  it('[host] type only when the setting is exactly \'type\'', async () => {
    h.settings = { commandPromptButtons: 'type' }
    await submit(fromApp, { sessionId: SID, text: 'draft' })
    expect(h.prompts.map((p) => p.mode)).toEqual(['type'])
  })

  it.each([
    ['no settings file', null],
    ['the setting absent', { loggingEnabled: true }],
    ['the setting saved as send', { commandPromptButtons: 'send' }],
    ['another spelling', { commandPromptButtons: 'Type' }],
    ['a value of another type', { commandPromptButtons: true }],
    ['settings that are not an object', 'type'],
    ['settings saved as a list', ['type']],
  ])('[host] %s: send', async (_name, saved) => {
    h.settings = saved
    await submit(fromApp, { sessionId: SID, text: 'draft' })
    expect(h.prompts.map((p) => p.mode)).toEqual(['send'])
  })

  it('[host] an unreadable settings file: send', async () => {
    h.settings = { commandPromptButtons: 'type' }
    h.readThrows = true
    await submit(fromApp, { sessionId: SID, text: 'draft' })
    expect(h.prompts.map((p) => p.mode)).toEqual(['send'])
  })

  it('[host] read again at each press: a change applies to the next press', async () => {
    await submit(fromApp, { sessionId: SID, text: 'one' })
    h.settings = { commandPromptButtons: 'type' }
    await submit(fromApp, { sessionId: SID, text: 'two' })
    h.settings = {}
    await submit(fromApp, { sessionId: SID, text: 'three' })
    expect(h.prompts.map((p) => p.mode)).toEqual(['send', 'type', 'send'])
  })

  it('[host] the reading on its own', () => {
    expect(promptButtonModeIn({ commandPromptButtons: 'type' })).toBe('type')
    for (const v of [undefined, null, {}, 'type', 1, { commandPromptButtons: 'send' }, { commandPromptButtons: ' type' }]) expect(promptButtonModeIn(v)).toBe('send')
  })
})

describe('the preload bridge', () => {
  it('[host] pty.submitPrompt invokes exactly pty:submitPrompt with the payload unchanged', async () => {
    await import('../../../src/preload/index')
    const api = h.exposed.electronAPI as { pty: { submitPrompt: (a: { sessionId: string; text: string }) => Promise<unknown> } }
    h.invoke.mockClear()
    await api.pty.submitPrompt({ sessionId: SID, text: 'explain this' })
    expect(h.invoke).toHaveBeenCalledTimes(1)
    expect(h.invoke).toHaveBeenCalledWith(IPC.PTY_SUBMIT_PROMPT, { sessionId: SID, text: 'explain this' })
  })
})
