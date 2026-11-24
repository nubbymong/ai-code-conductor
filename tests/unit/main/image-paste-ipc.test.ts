// [host] 2.1.3-beta.16 section X1.2 (aicc_planning #405), the IPC side of an
// image pasted into a Claude Code session on this computer
// (src/main/ipc/pty-handlers.ts, `pty:submitPrompt` with an image's path):
//  - a payload with `image` goes to main's image door (session-input
//    submitImage) with the session, the path and the text as its sentence,
//    never to the prompt door and never written raw;
//  - the Type it only setting does not apply: the image door is asked the
//    same way whatever the prompt buttons' setting says, and the setting is
//    not even read;
//  - the payload's other checks hold for it: the app's window only, a strict
//    payload (an empty or non-string image refused), a partner terminal's id
//    refused;
//  - the preload bridge (pty.submitImage) invokes pty:submitPrompt with
//    { sessionId, text: sentence, image: path }.
// Red on beta: the strict payload refused `image`, and there was no
// pty.submitImage. Mutants this must catch: the image routed to the prompt
// door; the mode read for an image.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  prompts: [] as Array<{ sessionId: string; text: string; mode: string }>,
  images: [] as Array<{ sessionId: string; path: string; sentence: string }>,
  settings: null as unknown,
  settingsReads: 0,
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
  submitImage: vi.fn(async (sessionId: string, path: string, sentence: string) => { h.images.push({ sessionId, path, sentence }); return { outcome: 'sent' } }),
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
    if (key === 'settings') h.settingsReads += 1
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
const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
const ptyManager = await import('../../../src/main/pty-manager')

const mainFrame = { id: 'top' }
const webContents = { mainFrame }
const win = { isDestroyed: () => false, webContents }
registerPtyHandlers(() => win as never)
const submit = h.handlers.get(IPC.PTY_SUBMIT_PROMPT)!
const fromApp = { sender: webContents, senderFrame: mainFrame }
const SID = 'sess2222sess2222sess2222'
const PATH = 'C:\\Users\\me\\AppData\\Local\\AI Code Conductor\\resources\\screenshots\\screenshot-2026-11-23-221500.jpg'

beforeEach(() => {
  h.prompts = []
  h.images = []
  h.settings = null
  h.settingsReads = 0
  vi.mocked(ptyManager.writePty).mockClear()
})

describe('pty:submitPrompt with an image', () => {
  it('[host] goes to main\'s image door with the path and the text as its sentence, and its answer comes back', async () => {
    expect(await submit(fromApp, { sessionId: SID, text: 'please view it.', image: PATH })).toEqual({ outcome: 'sent' })
    expect(h.images).toEqual([{ sessionId: SID, path: PATH, sentence: 'please view it.' }])
    expect(h.prompts).toEqual([])
    expect(ptyManager.writePty).not.toHaveBeenCalled()
  })

  it('[host] Type it only does not apply: the image door is asked all the same, and the setting is not read', async () => {
    h.settings = { commandPromptButtons: 'type' }
    await submit(fromApp, { sessionId: SID, text: 'please view it.', image: PATH })
    expect(h.images).toHaveLength(1)
    expect(h.prompts).toEqual([])
    expect(h.settingsReads).toBe(0)
  })

  it('[host] without an image the prompt door is asked, as before', async () => {
    await submit(fromApp, { sessionId: SID, text: 'explain this' })
    expect(h.prompts).toEqual([{ sessionId: SID, text: 'explain this', mode: 'send' }])
    expect(h.images).toEqual([])
  })

  it.each([
    ['an empty image path', { sessionId: SID, text: 'x', image: '' }],
    ['an image that is not a string', { sessionId: SID, text: 'x', image: 42 }],
    ['an image with no text', { sessionId: SID, image: PATH }],
    ['an image with an unknown key beside it', { sessionId: SID, text: 'x', image: PATH, enter: true }],
  ])('[host] refuses %s', async (_name, payload) => {
    expect(await submit(fromApp, payload)).toEqual({ outcome: 'not-sent', reason: 'refused-text' })
    expect(h.images).toEqual([])
  })

  it('[host] another sender, or a partner terminal\'s id: nothing handed over', async () => {
    expect(await submit({ sender: {}, senderFrame: mainFrame }, { sessionId: SID, text: 'x', image: PATH })).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
    expect(await submit(fromApp, { sessionId: `${SID}-partner`, text: 'x', image: PATH })).toEqual({ outcome: 'not-sent', reason: 'session-gone' })
    expect(h.images).toEqual([])
  })
})

describe('the preload bridge', () => {
  it('[host] pty.submitImage invokes pty:submitPrompt with the sentence as the text and the path as the image', async () => {
    await import('../../../src/preload/index')
    const api = h.exposed.electronAPI as { pty: { submitImage: (a: { sessionId: string; path: string; sentence: string }) => Promise<unknown> } }
    h.invoke.mockClear()
    await api.pty.submitImage({ sessionId: SID, path: PATH, sentence: 'please view it.' })
    expect(h.invoke).toHaveBeenCalledTimes(1)
    expect(h.invoke).toHaveBeenCalledWith(IPC.PTY_SUBMIT_PROMPT, { sessionId: SID, text: 'please view it.', image: PATH })
  })
})
