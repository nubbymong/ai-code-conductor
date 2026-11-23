// @vitest-environment jsdom
/**
 * Focus hand-off after a command chip runs (owner bug report 2026-08-27):
 * clicking a chip used to leave focus ON the button, so the user's follow-up
 * Enter re-pressed it and injected the command a second time. Pinned here:
 *  - a mouse click BLURS the chip, whatever kind of command it runs;
 *  - a pty-typing command additionally dispatches `ccc:focus-terminal` with
 *    the target pty's session id, so the terminal takes the keyboard;
 *  - a page command dispatches nothing (no pty was written).
 * Since 2.1.3-beta.10 (#333) a prompt button for the agent is typed by main:
 * the bar calls pty.submitPrompt with the text and no Enter, after dropping
 * the wheel's tmux scrollback belief (main leaves copy-mode itself); it says
 * why in its note when the answer is not sent; and it writes the old line and
 * Enter through pty.write only when the preload has no such bridge.
 * Since 2.1.3-beta.16 (aicc_planning#399) a broadcast press sends through that
 * same path to every open agent tab, a Codex tab as well as a Claude Code tab
 * (the rest of the broadcast wiring: commandbar-broadcast.test.tsx).
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let COMMANDS: Array<Record<string, unknown>> = []
const ONE_SESSION = [{ id: 's-1', label: 't', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', provider: 'claude', model: 'sonnet' }]
let SESSIONS: Array<Record<string, unknown>> = ONE_SESSION

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
vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: vi.fn() }))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))
vi.mock('../../../src/renderer/components/ScreenshotButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/AgentCanvasButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/LogsButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/ToolbarPopup', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/PasteHint', () => ({ default: () => null }))

const ptyWrite = vi.fn()
let SUBMIT_ANSWER: unknown = { outcome: 'sent' }
let SUBMIT_FAILS = false
const submitPrompt = vi.fn(async () => {
  if (SUBMIT_FAILS) throw new Error('no handler')
  return SUBMIT_ANSWER
})
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, pty: { write: ptyWrite, submitPrompt } }

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')
const { registerTmuxWheelScroll } = await import('../../../src/renderer/components/terminal/tmuxWheelScroll')
const { usePasteHintStore } = await import('../../../src/renderer/stores/pasteHintStore')

let container: HTMLDivElement
let root: Root
let focusEvents: Array<{ sessionId?: string }>
const captureFocusEvent = (ev: Event) => {
  focusEvents.push((ev as CustomEvent<{ sessionId?: string }>).detail ?? {})
}

beforeEach(() => {
  COMMANDS = []
  SESSIONS = ONE_SESSION
  ptyWrite.mockClear()
  submitPrompt.mockClear()
  SUBMIT_ANSWER = { outcome: 'sent' }
  SUBMIT_FAILS = false
  ;(globalThis as any).window.electronAPI.pty = { write: ptyWrite, submitPrompt }
  usePasteHintStore.setState({ hints: {} })
  focusEvents = []
  window.addEventListener('ccc:focus-terminal', captureFocusEvent)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  window.removeEventListener('ccc:focus-terminal', captureFocusEvent)
  act(() => { root.unmount() })
  container.remove()
})
const render = () => {
  act(() => { root.render(React.createElement(CommandBar, { sessionId: 'pty-1', parentSessionId: 's-1', configId: 'cfg' } as never)) })
}
const buttonNamed = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined

describe('focus hand-off after a chip runs', () => {
  it('a typing command blurs the chip and asks the target terminal to take focus', () => {
    COMMANDS = [{ id: 'c1', label: 'Resume Prompt', prompt: 'resume from the handoff', scope: 'global' }]
    render()
    const chip = buttonNamed('Resume Prompt')!
    chip.focus()
    expect(document.activeElement).toBe(chip)
    act(() => { chip.click() })
    // #333: main types a prompt button; the bar passes the text and no Enter.
    expect(submitPrompt).toHaveBeenCalledTimes(1)
    expect(submitPrompt).toHaveBeenCalledWith({ sessionId: 'pty-1', text: 'resume from the handoff' })
    expect(ptyWrite).not.toHaveBeenCalled()
    // The whole bug: Enter must not find the chip focused any more.
    expect(document.activeElement).not.toBe(chip)
    expect(focusEvents).toEqual([{ sessionId: 'pty-1' }])
  })

  it('a page command blurs the chip but requests no terminal focus (nothing was typed)', () => {
    COMMANDS = [{ id: 'p1', label: 'Docs', prompt: '', scope: 'global', kind: 'page', pageUrl: 'https://docs.example.com/' }]
    render()
    const chip = buttonNamed('Docs')!
    chip.focus()
    expect(document.activeElement).toBe(chip)
    act(() => { chip.click() })
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(chip)
    expect(focusEvents).toEqual([])
  })
})

describe('a prompt button is typed by main (#333)', () => {
  const PROMPT = { id: 'c1', label: 'Resume Prompt', prompt: 'resume from the handoff', scope: 'global' }
  const press = async () => {
    render()
    await act(async () => { buttonNamed('Resume Prompt')!.click(); await Promise.resolve(); await Promise.resolve() })
  }
  const note = () => usePasteHintStore.getState().hints['pty-1']

  it('drops the wheel\'s tmux scrollback belief first: main sends the leave key itself', async () => {
    const reset = vi.fn()
    const off = registerTmuxWheelScroll('pty-1', { handleWheel: () => false, exitPrefixForInput: () => '', setEnabled: () => {}, reset })
    COMMANDS = [PROMPT]
    await press()
    off()
    expect(reset).toHaveBeenCalledTimes(1)
    expect(submitPrompt).toHaveBeenCalledTimes(1)
    expect(ptyWrite).not.toHaveBeenCalled()
  })

  it.each([
    ['sent', { outcome: 'sent' }],
    ['typed only, as the setting says', { outcome: 'typed' }],
    ['dropped as a repeat', { outcome: 'dropped' }],
  ])('%s: no note', async (_name, answer) => {
    SUBMIT_ANSWER = answer
    COMMANDS = [PROMPT]
    await press()
    expect(note()).toBeUndefined()
  })

  it.each([
    ['busy-timeout', 'The prompt was not sent: Codex was still working, and its prompt did not come free in time.'],
    ['prompt-on-screen', 'The prompt was not sent: Codex was showing a question of its own (folder trust, sandbox setup or an approval). Answer it in the session first.'],
    ['session-gone', 'The prompt was not sent: the session was not running, or it ended or restarted before it could be sent.'],
    ['refused-text', 'The prompt was not sent: it is empty, or too long for the app to type in one press.'],
  ])('not sent (%s): the bar\'s note says why', async (reason, words) => {
    SUBMIT_ANSWER = { outcome: 'not-sent', reason }
    COMMANDS = [PROMPT]
    await press()
    expect(note()).toBe(words)
  })

  it('typed but not sent on Codex: the note says it was left in the prompt', async () => {
    SUBMIT_ANSWER = { outcome: 'typed', reason: 'refused-text' }
    COMMANDS = [PROMPT]
    await press()
    expect(note()).toBe('The prompt was typed but not sent: it holds characters Codex\'s prompt cannot take, so it was left in the prompt. Check it, then press Enter.')
  })

  it('a bridge that fails: the note says not sent, and nothing is written raw', async () => {
    SUBMIT_FAILS = true
    COMMANDS = [PROMPT]
    await press()
    expect(note()).toBe('The prompt was not sent: the session was not running, or it ended or restarted before it could be sent.')
    expect(ptyWrite).not.toHaveBeenCalled()
  })

  it('a preload with no bridge (an older one, a test harness): the line and its Enter through pty.write, as before', async () => {
    ;(globalThis as any).window.electronAPI.pty = { write: ptyWrite }
    COMMANDS = [PROMPT]
    await press()
    expect(ptyWrite).toHaveBeenCalledWith('pty-1', 'resume from the handoff\r')
    expect(submitPrompt).not.toHaveBeenCalled()
    expect(focusEvents).toEqual([{ sessionId: 'pty-1' }])
  })
})

describe('#399: a broadcast press goes through the same prompt path to every open agent tab', () => {
  const tab = (id: string, over: Record<string, unknown> = {}) => ({ id, label: id, workingDirectory: '/', color: '#89b4fa', sessionType: 'local', model: '', ...over })

  it('a Claude Code tab and a Codex tab get the text once each, a terminal-only tab nothing', async () => {
    SESSIONS = [tab('s-1', { provider: 'claude' }), tab('cx', { provider: 'codex' }), tab('sh', { provider: 'claude', shellOnly: true })]
    COMMANDS = [{ id: 'b1', label: 'Review all', prompt: 'review the open diff', scope: 'global', kind: 'prompt', target: 'claude', broadcast: true }]
    act(() => { root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1', configId: 'cfg' } as never)) })
    await act(async () => { buttonNamed('Review all')!.click(); await new Promise((r) => setTimeout(r, 0)) })
    expect(submitPrompt.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { sessionId: 's-1', text: 'review the open diff' },
      { sessionId: 'cx', text: 'review the open diff' },
    ])
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(usePasteHintStore.getState().hints['s-1']).toBe('Sent to 2 of 2 sessions.')
  })
})
