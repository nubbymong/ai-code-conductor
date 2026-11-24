// @vitest-environment jsdom
/**
 * #399 (2.1.3-beta.16, plan section B4) and aicc_planning#413 (2.1.3-beta.17,
 * plan section C2): a Global prompt button can send to every open agent
 * session, and every broadcast press asks first: All, or the sessions picked.
 * The CommandBar's wiring and the chooser (command-bar/BroadcastChooser); the
 * rules themselves are in command-broadcast.test.ts.
 *
 *  - a broadcast press (a plain press of a button with "Send to every open
 *    session" on, or a Shift+click on any simple Global prompt) opens the
 *    chooser and sends nothing yet: 'Send "<label>" to', All (N) and Choose
 *    sessions;
 *  - All (or Enter) reaches every open agent tab once each (SSH, Codex and
 *    background tabs included), each through main's prompt path
 *    (pty.submitPrompt), and never a terminal-only tab, Ask Conductor or an
 *    ended session; the pressed tab shows one note with the count;
 *  - Choose sessions lists those tabs (the tab's name, its agent, an SSH
 *    badge) with tick boxes, and Send (or Enter, once the list is open)
 *    reaches only the ticked ones, once each;
 *  - Cancel and Escape send nothing; a held Enter's repeat answers nothing; a
 *    second Enter sends nothing more; a session that ends while the chooser
 *    is up gets nothing;
 *  - a button without the option still reaches only its own tab on a plain
 *    press; a Shift+click on any other button (arguments, a shell line, a
 *    Session button) is a plain press of its own tab; a button folded into
 *    its band's overflow list asks the same way
 *    (commandbar-broadcast-overflow.test.tsx);
 *  - a broadcast button carries a subtle "all" pill, on the bar and in its
 *    band's overflow list, only while its option is on and it is a simple
 *    prompt.
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
const { default: BandOverflow } = await import('../../../src/renderer/components/command-bar/BandOverflow')
const { planBand } = await import('../../../src/renderer/components/command-bar/layout')
const { sessionCapabilities } = await import('../../../src/renderer/lib/session-capabilities')
const { usePasteHintStore } = await import('../../../src/renderer/stores/pasteHintStore')

/** The pressed tab (local, shown), an SSH tab in the background, a Codex tab
 *  with a work name, and the tabs a broadcast never reaches. */
const OPEN = [
  { id: 's-1', label: 'here', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', model: 'sonnet' },
  { id: 's-2', label: 'remote', workingDirectory: '/', color: '#89b4fa', sessionType: 'ssh', model: 'sonnet', sshConfig: { host: 'build-box', port: 22, username: 'u', remotePath: '/' } },
  { id: 's-3', label: 'cx-config', customName: 'cx work', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', model: '', provider: 'codex' },
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

const render = (props: Record<string, unknown> = {}) => {
  act(() => { root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1', partnerSessionId: 's-1-partner', configId: 'cfg', ...props } as never)) })
}
const chip = (label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="command-chip"]')).find((b) => b.textContent?.includes(label))!
const settle = () => new Promise((r) => setTimeout(r, 0))
const press = async (label: string, init: MouseEventInit = {}) => {
  await act(async () => { chip(label).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })); await settle() })
}
const sentTo = () => submitPrompt.mock.calls.map((c) => c[0])
const note = () => usePasteHintStore.getState().hints['s-1']
const byTest = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const chooser = () => byTest('broadcast-chooser')
const click = async (id: string) => { await act(async () => { byTest(id)!.click(); await settle() }) }
const key = async (k: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); await settle() })
}
const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="broadcast-choice"]'))
const listed = () => rows().map((r) => r.dataset.sessionId)
const tickBox = (id: string) => container.querySelector<HTMLInputElement>(`[data-testid="broadcast-choice"][data-session-id="${id}"] [data-testid="broadcast-choice-tick"]`)!
const ticked = () => rows().filter((r) => r.querySelector<HTMLInputElement>('[data-testid="broadcast-choice-tick"]')!.checked).map((r) => r.dataset.sessionId)
/** Leave exactly `ids` ticked, whatever the list started with. */
const tickOnly = async (ids: string[]) => {
  for (const r of rows()) {
    const box = r.querySelector<HTMLInputElement>('[data-testid="broadcast-choice-tick"]')!
    if (box.checked !== ids.includes(r.dataset.sessionId!)) await act(async () => { box.click(); await settle() })
  }
  expect(ticked()).toEqual(ids)
}
const EVERY = [
  { sessionId: 's-1', text: 'review the open diff' },
  { sessionId: 's-2', text: 'review the open diff' },
  { sessionId: 's-3', text: 'review the open diff' },
]

describe('a button set to "Send to every open session" asks first: All, or the sessions picked (#413)', () => {
  it('a plain press opens the chooser and sends nothing yet', async () => {
    COMMANDS = [BROADCAST]
    render()
    await press('Review all')
    expect(chooser()).not.toBeNull()
    expect(byTest('broadcast-chooser-title')!.textContent).toBe('Send "Review all" to')
    expect(byTest('broadcast-chooser-all')!.textContent).toBe('All (3)')
    expect(byTest('broadcast-chooser-choose')!.textContent).toBe('Choose sessions')
    expect(byTest('broadcast-chooser-body')!.textContent).toContain('each open Claude Code and Codex session')
    expect(submitPrompt).not.toHaveBeenCalled()
    expect(ptyWrite).not.toHaveBeenCalled()
  })

  it('All reaches every open agent tab once, SSH, Codex and background included, and nothing else', async () => {
    COMMANDS = [BROADCAST]
    render()
    await press('Review all')
    await click('broadcast-chooser-all')
    expect(chooser()).toBeNull()
    expect(sentTo()).toEqual(EVERY)
    // The shell tab, Ask Conductor and the ended session get nothing at all.
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(note()).toBe('Sent to 3 of 3 sessions.')
    expect(focusEvents).toEqual([{ sessionId: 's-1' }])
    expect(trackUsage).toHaveBeenCalledWith('commands.broadcast')
  })

  it('Choose sessions lists each open agent tab by its name, its agent and an SSH badge, and never a shell tab, Ask Conductor or an ended tab', async () => {
    COMMANDS = [BROADCAST]
    render()
    await press('Review all')
    await click('broadcast-chooser-choose')
    expect(listed()).toEqual(['s-1', 's-2', 's-3'])
    const cell = (id: string, what: string) => container.querySelector(`[data-testid="broadcast-choice"][data-session-id="${id}"] [data-testid="broadcast-choice-${what}"]`)?.textContent ?? null
    expect(['s-1', 's-2', 's-3'].map((id) => cell(id, 'name'))).toEqual(['here', 'remote', 'cx work'])
    expect(['s-1', 's-2', 's-3'].map((id) => cell(id, 'agent'))).toEqual(['Claude Code', 'Claude Code', 'Codex'])
    expect(['s-1', 's-2', 's-3'].map((id) => cell(id, 'machine'))).toEqual([null, 'build-box', null])
    expect(['s-1', 's-2', 's-3'].map((id) => cell(id, 'this-tab'))).toEqual(['this tab', null, null])
    // The list takes the keyboard: its first tick box is focused.
    expect(document.activeElement).toBe(tickBox('s-1'))
    expect(submitPrompt).not.toHaveBeenCalled()
  })

  it('Choose sessions starts with every listed tab ticked, so a pick is unticking the ones to skip (design point 1, its default)', async () => {
    COMMANDS = [BROADCAST]
    render()
    await press('Review all')
    await click('broadcast-chooser-choose')
    expect(ticked()).toEqual(['s-1', 's-2', 's-3'])
    expect(byTest('broadcast-chooser-send')!.textContent).toBe('Send (3)')
    // Codex unticked: Send reaches the two Claude Code tabs only.
    await act(async () => { tickBox('s-3').click(); await settle() })
    await click('broadcast-chooser-send')
    expect(sentTo()).toEqual([
      { sessionId: 's-1', text: 'review the open diff' },
      { sessionId: 's-2', text: 'review the open diff' },
    ])
  })

  it('the next press starts from the default again: the button does not remember the last pick (design point 2, its default)', async () => {
    COMMANDS = [BROADCAST]
    render()
    await press('Review all')
    await click('broadcast-chooser-choose')
    await tickOnly(['s-1'])
    await click('broadcast-chooser-send')
    expect(sentTo()).toEqual([{ sessionId: 's-1', text: 'review the open diff' }])
    await press('Review all')
    // The first view again (All and Choose sessions), and every tab ticked.
    expect(byTest('broadcast-chooser-all')!.textContent).toBe('All (3)')
    expect(rows()).toEqual([])
    await click('broadcast-chooser-choose')
    expect(ticked()).toEqual(['s-1', 's-2', 's-3'])
  })

  it('a pick reaches only the ticked tabs, once each', async () => {
    COMMANDS = [BROADCAST]
    render()
    await press('Review all')
    await click('broadcast-chooser-choose')
    await tickOnly(['s-1', 's-2'])
    expect(byTest('broadcast-chooser-send')!.textContent).toBe('Send (2)')
    await click('broadcast-chooser-send')
    expect(chooser()).toBeNull()
    expect(sentTo()).toEqual([
      { sessionId: 's-1', text: 'review the open diff' },
      { sessionId: 's-2', text: 'review the open diff' },
    ])
    expect(note()).toBe('Sent to 2 of 2 sessions.')
  })

  it('with nothing ticked, Send is off and neither it nor Enter sends', async () => {
    COMMANDS = [BROADCAST]
    render()
    await press('Review all')
    await click('broadcast-chooser-choose')
    await tickOnly([])
    const send = byTest('broadcast-chooser-send') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    await click('broadcast-chooser-send')
    await key('Enter')
    expect(chooser()).not.toBeNull()
    expect(submitPrompt).not.toHaveBeenCalled()
  })

  it('each tab\'s own path decides, and the pressed tab\'s one note counts the outcomes', async () => {
    COMMANDS = [BROADCAST]
    ANSWERS = { 's-2': { outcome: 'not-sent', reason: 'busy-timeout' } }
    render()
    await press('Review all')
    await click('broadcast-chooser-all')
    expect(submitPrompt).toHaveBeenCalledTimes(3)
    expect(note()).toBe('Sent to 2 of 3 sessions (1 busy or ended).')
  })

  it('a Shift+click asks the same way', async () => {
    COMMANDS = [BROADCAST]
    render()
    await press('Review all', { shiftKey: true })
    expect(chooser()).not.toBeNull()
    expect(submitPrompt).not.toHaveBeenCalled()
  })

  it('the pressed tab\'s agent pane is shown only when the pressed tab is one of those it goes to', async () => {
    COMMANDS = [BROADCAST]
    const onTogglePartner = vi.fn()
    render({ isPartnerActive: true, onTogglePartner })
    await press('Review all')
    await click('broadcast-chooser-choose')
    await tickOnly(['s-2'])
    await click('broadcast-chooser-send')
    expect(sentTo()).toEqual([{ sessionId: 's-2', text: 'review the open diff' }])
    expect(onTogglePartner).not.toHaveBeenCalled()
    await press('Review all')
    await click('broadcast-chooser-all')
    expect(onTogglePartner).toHaveBeenCalledTimes(1)
  })

  it('with no open agent session to send to, the pressed tab says so and nothing asks', async () => {
    COMMANDS = [BROADCAST]
    SESSIONS = [{ ...OPEN[0], ptyExited: true }, OPEN[3], OPEN[4]]
    render()
    await press('Review all')
    expect(chooser()).toBeNull()
    expect(submitPrompt).not.toHaveBeenCalled()
    expect(note()).toBe('No open agent session to send to.')
  })

  it('a record with the option that is not a simple prompt (it has arguments) presses as a single button', async () => {
    COMMANDS = [{ ...BROADCAST, defaultArgs: ['--strict'] }]
    render()
    await press('Review all')
    expect(chooser()).toBeNull()
    expect(sentTo()).toEqual([{ sessionId: 's-1', text: 'review the open diff --strict' }])
  })

  it('a preload with no prompt path presses as a single button (the line and its Enter, as before)', async () => {
    ;(globalThis as any).window.electronAPI.pty = { write: ptyWrite }
    COMMANDS = [BROADCAST]
    render()
    await press('Review all')
    expect(chooser()).toBeNull()
    expect(ptyWrite).toHaveBeenCalledTimes(1)
    expect(ptyWrite).toHaveBeenCalledWith('s-1', 'review the open diff\r')
  })
})

describe('answering the chooser (#413)', () => {
  const ask = async () => {
    COMMANDS = [BROADCAST]
    render()
    await press('Review all')
    expect(chooser()).not.toBeNull()
  }

  it('Cancel sends nothing', async () => {
    await ask()
    await click('broadcast-chooser-cancel')
    expect(chooser()).toBeNull()
    expect(submitPrompt).not.toHaveBeenCalled()
    expect(ptyWrite).not.toHaveBeenCalled()
  })

  it('Cancel with the list open sends nothing', async () => {
    await ask()
    await click('broadcast-chooser-choose')
    await tickOnly(['s-1'])
    await click('broadcast-chooser-cancel')
    expect(chooser()).toBeNull()
    expect(submitPrompt).not.toHaveBeenCalled()
  })

  it('Escape sends nothing, and an Enter after it sends nothing either', async () => {
    await ask()
    await key('Escape')
    expect(chooser()).toBeNull()
    expect(submitPrompt).not.toHaveBeenCalled()
    await key('Enter')
    expect(submitPrompt).not.toHaveBeenCalled()
  })

  it('Escape with the list open sends nothing', async () => {
    await ask()
    await click('broadcast-chooser-choose')
    await tickOnly(['s-1'])
    await key('Escape', tickBox('s-1'))
    expect(chooser()).toBeNull()
    expect(submitPrompt).not.toHaveBeenCalled()
  })

  it('Enter is All', async () => {
    await ask()
    await key('Enter')
    expect(chooser()).toBeNull()
    expect(sentTo()).toEqual(EVERY)
  })

  it('once the list is open, Enter is Send: it reaches only the ticked tabs', async () => {
    await ask()
    await click('broadcast-chooser-choose')
    await tickOnly(['s-1'])
    await key('Enter', tickBox('s-1'))
    expect(chooser()).toBeNull()
    expect(sentTo()).toEqual([{ sessionId: 's-1', text: 'review the open diff' }])
  })

  it('Enter sends once, even when a second Enter comes before the chooser has gone', async () => {
    await ask()
    await act(async () => {
      for (let i = 0; i < 2; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await settle()
    })
    await key('Enter')
    expect(sentTo()).toEqual(EVERY)
  })

  it('a held Enter\'s repeat answers nothing; the next fresh Enter sends once to each tab', async () => {
    // Holding Enter on a chip opens the chooser on the first keydown; the
    // key's auto-repeats reach it before the user has read it.
    await ask()
    await key('Enter', document.body, { repeat: true })
    expect(submitPrompt).not.toHaveBeenCalled()
    expect(chooser()).not.toBeNull()
    await key('Enter')
    expect(chooser()).toBeNull()
    expect(sentTo()).toEqual(EVERY)
  })

  it('a held Enter\'s repeat answers nothing with the list open either', async () => {
    await ask()
    await click('broadcast-chooser-choose')
    await tickOnly(['s-1'])
    await key('Enter', tickBox('s-1'), { repeat: true })
    expect(chooser()).not.toBeNull()
    expect(submitPrompt).not.toHaveBeenCalled()
  })

  it('an Enter on the chooser\'s own focused Cancel is left to that button: it does not send', async () => {
    await ask()
    const cancel = byTest('broadcast-chooser-cancel')!
    cancel.focus()
    await key('Enter', cancel)
    expect(submitPrompt).not.toHaveBeenCalled()
  })

  it('a session that ends while the chooser is up is not sent to, by All or by a pick', async () => {
    await ask()
    // s-2 ends while the chooser is up; the chooser has not redrawn yet.
    SESSIONS = OPEN.map((s) => (s.id === 's-2' ? { ...s, ptyExited: true } : s))
    await click('broadcast-chooser-all')
    expect(sentTo()).toEqual([
      { sessionId: 's-1', text: 'review the open diff' },
      { sessionId: 's-3', text: 'review the open diff' },
    ])

    submitPrompt.mockClear()
    SESSIONS = OPEN
    await press('Review all')
    await click('broadcast-chooser-choose')
    await tickOnly(['s-2', 's-3'])
    SESSIONS = OPEN.map((s) => (s.id === 's-3' ? { ...s, ptyExited: true } : s))
    await click('broadcast-chooser-send')
    expect(sentTo()).toEqual([{ sessionId: 's-2', text: 'review the open diff' }])
  })

  it('a session that ends while the chooser is up leaves its list when the chooser redraws, and All counts what is left', async () => {
    await ask()
    SESSIONS = OPEN.map((s) => (s.id === 's-2' ? { ...s, ptyExited: true } : s))
    render()
    expect(byTest('broadcast-chooser-all')!.textContent).toBe('All (2)')
    await click('broadcast-chooser-choose')
    expect(listed()).toEqual(['s-1', 's-3'])
  })
})

describe('a Global button without the option (#399)', () => {
  it('still reaches only its own tab on a plain press, without asking', async () => {
    COMMANDS = [PLAIN]
    render()
    await press('Resume')
    expect(chooser()).toBeNull()
    expect(sentTo()).toEqual([{ sessionId: 's-1', text: 'resume from the handoff' }])
    expect(note()).toBeUndefined()
  })

  it('a Shift+click on it is a broadcast press: the same chooser, and All reaches every open agent tab once', async () => {
    COMMANDS = [PLAIN]
    render()
    await press('Resume', { shiftKey: true })
    expect(byTest('broadcast-chooser-title')!.textContent).toBe('Send "Resume" to')
    expect(submitPrompt).not.toHaveBeenCalled()
    await click('broadcast-chooser-all')
    expect(sentTo()).toEqual([
      { sessionId: 's-1', text: 'resume from the handoff' },
      { sessionId: 's-2', text: 'resume from the handoff' },
      { sessionId: 's-3', text: 'resume from the handoff' },
    ])
    expect(note()).toBe('Sent to 3 of 3 sessions.')
  })

  it.each([
    ['a prompt with arguments', { ...PLAIN, defaultArgs: ['--verbose'] }, [{ sessionId: 's-1', text: 'resume from the handoff --verbose' }]],
    ['a Session prompt', { ...PLAIN, scope: 'config', configId: 'cfg' }, [{ sessionId: 's-1', text: 'resume from the handoff' }]],
  ])('Shift+click on %s is a plain press of its own tab', async (_name, cmd, sent) => {
    COMMANDS = [cmd]
    render()
    await press('Resume', { shiftKey: true })
    expect(chooser()).toBeNull()
    expect(sentTo()).toEqual(sent)
  })

  it('Shift+click on a shell-line button types into its own tab\'s shell only', async () => {
    COMMANDS = [{ id: 'sh1', label: 'Run tests', prompt: 'npm test', scope: 'global', kind: 'shell', target: 'partner' }]
    render()
    await press('Run tests', { shiftKey: true })
    expect(chooser()).toBeNull()
    expect(submitPrompt).not.toHaveBeenCalled()
    expect(ptyWrite.mock.calls).toEqual([['s-1-partner', 'npm test\r']])
  })
})

describe('the pill on a broadcast button (#399: "somehting subtle")', () => {
  const pillOn = (el: Element) => el.querySelector('[data-testid="command-broadcast-pill"]')

  it('shows on a button with the option on, saying what it means to a tooltip and a screen reader', () => {
    COMMANDS = [BROADCAST]
    render()
    const pill = pillOn(chip('Review all'))!
    expect(pill).not.toBeNull()
    expect(pill.getAttribute('aria-label')).toBe('Sends to every open session, or the ones you pick')
    expect(pill.getAttribute('title')).toBe('Sends to every open session, or the ones you pick')
    expect(pill.getAttribute('role')).toBe('img')
    // Drawn, not typed: an SVG mark and a tiny word.
    expect(pill.querySelector('svg')).not.toBeNull()
    expect(pill.textContent).toBe('all')
  })

  it.each([
    ['without the option', PLAIN, 'Resume'],
    ['with the option but not a simple prompt (it has arguments)', { ...BROADCAST, defaultArgs: ['--strict'] }, 'Review all'],
  ])('does not show %s', (_name, cmd, label) => {
    COMMANDS = [cmd]
    render()
    expect(pillOn(chip(label))).toBeNull()
  })

  it('shows on the button\'s row in its band\'s overflow list too, and only there', () => {
    const caps = sessionCapabilities(OPEN[0] as never)
    const cmds = [BROADCAST, PLAIN] as never[]
    act(() => {
      root.render(React.createElement(BandOverflow, {
        plan: planBand('global', cmds, [], caps), folded: cmds, caps, anchor: new DOMRect(0, 0, 1, 1),
        onRun: vi.fn(), onContextMenu: vi.fn(), onManage: vi.fn(), onClose: vi.fn(),
      }))
    })
    const row = (id: string) => container.querySelector(`[data-testid="command-overflow-item"][data-command-id="${id}"]`)!
    expect(pillOn(row('b1'))).not.toBeNull()
    expect(pillOn(row('p1'))).toBeNull()
  })
})

describe('making a broadcast button Session-only says the option ends (#399)', () => {
  it('the scope confirmation names it for a button with the option, and not for one without', async () => {
    for (const [cmd, says] of [[BROADCAST, true], [PLAIN, false]] as const) {
      COMMANDS = [cmd]
      render()
      // Alt+Shift+Arrow moves a chip to the other band, through the same confirmation as a drop.
      await act(async () => { chip(cmd.label).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, shiftKey: true, bubbles: true, cancelable: true })); await settle() })
      const body = container.querySelector('[data-testid="confirm-scope-body"]')!.textContent
      expect(body.includes('It also stops sending to every open session.')).toBe(says)
      await act(async () => { container.querySelector<HTMLElement>('[data-testid="confirm-scope-cancel"]')!.click(); await settle() })
    }
  })
})
