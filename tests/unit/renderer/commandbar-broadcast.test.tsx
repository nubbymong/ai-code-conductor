// @vitest-environment jsdom
/**
 * #399 (2.1.3-beta.16, plan section B4): a Global prompt button can send to
 * every open agent session. The CommandBar's wiring; the rules themselves are
 * in command-broadcast.test.ts.
 *
 *  - a button with "Send to every open session" on goes, on a plain press and
 *    with no confirmation, to every open agent tab once each (SSH and
 *    background tabs included), each through main's prompt path
 *    (pty.submitPrompt), and never to a terminal-only tab, Ask Conductor or
 *    an ended session; the pressed tab shows one note with the count;
 *  - a button without it still reaches only its own tab;
 *  - a record that has the option but is not a simple prompt (it has
 *    arguments) presses as a single button.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let COMMANDS: Array<Record<string, unknown>> = []
let SESSIONS: Array<Record<string, unknown>> = []

vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const state = () => ({ sessions: SESSIONS, activeSessionId: 's-1', updateSession: () => {} })
  return { useSessionStore: Object.assign((sel: any) => sel(state()), { getState: state }) }
})
vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({
    commands: COMMANDS, sections: [],
    addCommand: vi.fn(), updateCommand: vi.fn(), removeCommand: vi.fn(), reorderCommands: vi.fn(),
    updateSection: vi.fn(), removeSection: vi.fn(), reorderSections: vi.fn(),
  }),
}))
vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) => sel({ state: { collapsedSectionIds: [] }, toggleSection: vi.fn() }),
}))
const webviewState = { startActivation: vi.fn(() => 0), markAvailable: vi.fn(), markFailed: vi.fn(), navigate: vi.fn(), bySessionId: {} }
vi.mock('../../../src/renderer/stores/webviewStore', () => ({
  useWebviewStore: Object.assign((sel: any) => sel(webviewState), { getState: () => webviewState }),
  pollUrlForContent: vi.fn(() => Promise.resolve(false)),
  probeWebviewUrls: vi.fn(() => Promise.resolve(false)),
}))
const trackUsage = vi.fn()
vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: (id: string) => trackUsage(id) }))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))
vi.mock('../../../src/renderer/components/ScreenshotButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/AgentCanvasButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/LogsButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/PasteHint', () => ({ default: () => null }))

const ptyWrite = vi.fn()
/** Each session's answer, by id; anything not listed is sent. */
let ANSWERS: Record<string, unknown> = {}
const submitPrompt = vi.fn(async ({ sessionId }: { sessionId: string; text: string }) => ANSWERS[sessionId] ?? { outcome: 'sent' })
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, pty: { write: ptyWrite, submitPrompt } }

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')
const { usePasteHintStore } = await import('../../../src/renderer/stores/pasteHintStore')

/** The pressed tab (local, shown), an SSH tab in the background, and the
 *  tabs a broadcast never reaches. */
const OPEN = [
  { id: 's-1', label: 'here', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', model: 'sonnet' },
  { id: 's-2', label: 'remote', workingDirectory: '/', color: '#89b4fa', sessionType: 'ssh', model: 'sonnet', sshConfig: { host: 'build-box', port: 22, username: 'u', remotePath: '/' } },
  { id: 'sh', label: 'shell', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', model: '', shellOnly: true },
  { id: 'ask', label: 'Ask', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', model: '', kind: 'ask' },
  { id: 'gone', label: 'ended', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', model: '', ptyExited: true },
]
const BROADCAST = { id: 'b1', label: 'Review all', prompt: 'review the open diff', scope: 'global', kind: 'prompt', target: 'claude', broadcast: true }
const PLAIN = { id: 'p1', label: 'Resume', prompt: 'resume from the handoff', scope: 'global', kind: 'prompt', target: 'claude' }

let container: HTMLDivElement
let root: Root
let focusEvents: Array<{ sessionId?: string }>
const captureFocus = (ev: Event) => { focusEvents.push((ev as CustomEvent<{ sessionId?: string }>).detail ?? {}) }

beforeEach(() => {
  COMMANDS = []
  SESSIONS = OPEN
  ANSWERS = {}
  ptyWrite.mockClear()
  submitPrompt.mockClear()
  trackUsage.mockClear()
  ;(globalThis as any).window.electronAPI.pty = { write: ptyWrite, submitPrompt }
  usePasteHintStore.setState({ hints: {} })
  focusEvents = []
  window.addEventListener('ccc:focus-terminal', captureFocus)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  window.removeEventListener('ccc:focus-terminal', captureFocus)
  act(() => { root.unmount() })
  container.remove()
})

const render = () => {
  act(() => { root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1', configId: 'cfg' } as never)) })
}
const chip = (label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="command-chip"]')).find((b) => b.textContent?.includes(label))!
const settle = () => new Promise((r) => setTimeout(r, 0))
const press = async (label: string, init: MouseEventInit = {}) => {
  await act(async () => { chip(label).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })); await settle() })
}
const sentTo = () => submitPrompt.mock.calls.map((c) => c[0])
const note = () => usePasteHintStore.getState().hints['s-1']

describe('a button set to "Send to every open session" (#399)', () => {
  it('one plain press reaches every open agent tab once, SSH and background included, and nothing else', async () => {
    COMMANDS = [BROADCAST]
    render()
    await press('Review all')
    expect(sentTo()).toEqual([
      { sessionId: 's-1', text: 'review the open diff' },
      { sessionId: 's-2', text: 'review the open diff' },
    ])
    // The shell tab, Ask Conductor and the ended session get nothing at all.
    expect(ptyWrite).not.toHaveBeenCalled()
    // No confirmation: the option is the user's standing choice.
    expect(container.querySelector('[data-testid="confirm-broadcast"]')).toBeNull()
    expect(note()).toBe('Sent to 2 of 2 sessions.')
    expect(focusEvents).toEqual([{ sessionId: 's-1' }])
    expect(trackUsage).toHaveBeenCalledWith('commands.broadcast')
  })

  it('each tab\'s own path decides, and the pressed tab\'s one note counts the outcomes', async () => {
    COMMANDS = [BROADCAST]
    ANSWERS = { 's-2': { outcome: 'not-sent', reason: 'busy-timeout' } }
    render()
    await press('Review all')
    expect(submitPrompt).toHaveBeenCalledTimes(2)
    expect(note()).toBe('Sent to 1 of 2 sessions (1 busy or ended).')
  })

  it('a record with the option that is not a simple prompt (it has arguments) presses as a single button', async () => {
    COMMANDS = [{ ...BROADCAST, defaultArgs: ['--strict'] }]
    render()
    await press('Review all')
    expect(sentTo()).toEqual([{ sessionId: 's-1', text: 'review the open diff --strict' }])
  })

  it('a preload with no prompt path presses as a single button (the line and its Enter, as before)', async () => {
    ;(globalThis as any).window.electronAPI.pty = { write: ptyWrite }
    COMMANDS = [BROADCAST]
    render()
    await press('Review all')
    expect(ptyWrite).toHaveBeenCalledTimes(1)
    expect(ptyWrite).toHaveBeenCalledWith('s-1', 'review the open diff\r')
  })
})

describe('a Global button without the option (#399)', () => {
  it('still reaches only its own tab', async () => {
    COMMANDS = [PLAIN]
    render()
    await press('Resume')
    expect(sentTo()).toEqual([{ sessionId: 's-1', text: 'resume from the handoff' }])
    expect(note()).toBeUndefined()
  })
})
