// @vitest-environment jsdom
/**
 * #399 (2.1.3-beta.16, plan section B4): a Shift+click on a button folded into
 * its band's overflow list asks first, as it does on the bar. The overflow row
 * hands the Shift key on to the CommandBar's press (CommandBar.tsx, BandOverflow
 * onRun); without it, a Shift+click on a folded simple Global prompt would send
 * to its own tab only, with no question asked.
 *
 * The harness is commandbar-broadcast.test.tsx's, with the band folding forced:
 * useBandFolding reports the Global band's one button as folded, so it sits in
 * the overflow list and not on the row.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let COMMANDS: Array<Record<string, unknown>> = []
let SESSIONS: Array<Record<string, unknown>> = []
/** The ids the folding hook reports as folded, per band. */
let FOLDED: Record<string, Set<string>> = {}

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
vi.mock('../../../src/renderer/components/command-bar/useBandFolding', () => ({
  useBandFolding: () => ({ folded: FOLDED, settled: true }),
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
vi.mock('../../../src/renderer/components/PasteHint', () => ({ default: () => null }))

const ptyWrite = vi.fn()
const submitPrompt = vi.fn(async (_req: { sessionId: string; text: string }) => ({ outcome: 'sent' }))
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, pty: { write: ptyWrite, submitPrompt } }

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')

/** The pressed tab (local, shown), an SSH tab in the background, and a
 *  terminal-only tab a broadcast never reaches. */
const OPEN = [
  { id: 's-1', label: 'here', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', model: 'sonnet' },
  { id: 's-2', label: 'remote', workingDirectory: '/', color: '#89b4fa', sessionType: 'ssh', model: 'sonnet', sshConfig: { host: 'build-box', port: 22, username: 'u', remotePath: '/' } },
  { id: 'sh', label: 'shell', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', model: '', shellOnly: true },
]
/** A simple Global prompt without the option: a Shift+click asks first. */
const PLAIN = { id: 'p1', label: 'Resume', prompt: 'resume from the handoff', scope: 'global', kind: 'prompt', target: 'claude' }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  COMMANDS = [PLAIN]
  SESSIONS = OPEN
  FOLDED = { global: new Set(['p1']) }
  ptyWrite.mockClear()
  submitPrompt.mockClear()
  ;(globalThis as any).window.electronAPI.pty = { write: ptyWrite, submitPrompt }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const settle = () => new Promise((r) => setTimeout(r, 0))
const byTest = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const card = () => byTest('confirm-broadcast')
const sentTo = () => submitPrompt.mock.calls.map((c) => c[0])

/** Render the bar, open the Global band's overflow list and click the folded button's row. */
const clickFolded = async (init: MouseEventInit) => {
  act(() => { root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1', partnerSessionId: 's-1-partner', configId: 'cfg' } as never)) })
  // Folded: not on the row, only behind "1 more".
  expect(Array.from(container.querySelectorAll('[data-testid="command-chip"]')).some((b) => b.textContent?.includes('Resume'))).toBe(false)
  await act(async () => { byTest('command-more-global')!.click(); await settle() })
  const row = container.querySelector<HTMLElement>('[data-testid="command-overflow-item"][data-command-id="p1"]')!
  expect(row).not.toBeNull()
  await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })); await settle() })
}

describe('a button folded into its band\'s overflow list (#399)', () => {
  it('Shift+click on its row asks first, and Send reaches every open agent tab once', async () => {
    await clickFolded({ shiftKey: true })
    expect(card()).not.toBeNull()
    expect(byTest('confirm-broadcast-title')!.textContent).toBe('Send to 2 open sessions?')
    expect(submitPrompt).not.toHaveBeenCalled()
    expect(ptyWrite).not.toHaveBeenCalled()
    await act(async () => { byTest('confirm-broadcast-ok')!.click(); await settle() })
    expect(card()).toBeNull()
    expect(sentTo()).toEqual([
      { sessionId: 's-1', text: 'resume from the handoff' },
      { sessionId: 's-2', text: 'resume from the handoff' },
    ])
    expect(ptyWrite).not.toHaveBeenCalled()
  })

  it('a plain click on its row still reaches only its own tab, without asking', async () => {
    await clickFolded({})
    expect(card()).toBeNull()
    expect(sentTo()).toEqual([{ sessionId: 's-1', text: 'resume from the handoff' }])
  })
})
