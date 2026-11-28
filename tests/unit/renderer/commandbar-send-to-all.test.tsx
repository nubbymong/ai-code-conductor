// @vitest-environment jsdom
/**
 * aicc_planning#450 (2.1.3-beta.21, plan block 7): a send-a-prompt button that
 * is not set to "Send to every open session" can still go to all sessions
 * once, from its right-click menu. "Send to all sessions…" opens the same
 * chooser a broadcast press opens (All, or the sessions picked), through the
 * same send path and the same note; the button's own setting does not change.
 *
 *  - the item shows for a Global and a Session prompt button;
 *  - it shows disabled, with its reason under it, for a prompt with
 *    arguments, remembered Ctrl+click arguments or a secret, in Ask Conductor
 *    and in a terminal-only tab;
 *  - it does not show for a broadcast button (its own press already asks), a
 *    shell line, a page button, or with no prompt path in the preload;
 *  - choosing it opens the chooser and sends nothing yet; All or Send reaches
 *    the sessions picked, a Session prompt's too: the send's re-check reads
 *    the one-off rule (broadcastBlocker without its Global line);
 *  - the button's setting is unchanged afterwards;
 *  - the keyboard reaches it as the rest of the menu (Shift+F10, the
 *    ContextMenu key, the arrow keys).
 *
 * The chooser itself (its list, Enter, Escape, a session that ends while it
 * is up) is pinned in commandbar-broadcast.test.tsx; this file pins only the
 * new way in and the rule it reads.
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
// One stable spy per store write, so "the setting does not change" is an
// assertion on the calls the bar makes.
const store = {
  addCommand: vi.fn(), updateCommand: vi.fn(), removeCommand: vi.fn(), reorderCommands: vi.fn(),
  moveCommand: vi.fn(), setCommandSection: vi.fn(), togglePinned: vi.fn(),
  updateSection: vi.fn(), removeSection: vi.fn(), reorderSections: vi.fn(),
}
vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({ commands: COMMANDS, sections: [], ...store }),
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
const submitPrompt = vi.fn(async (_args: { sessionId: string; text: string }) => ({ outcome: 'sent' }))
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, pty: { write: ptyWrite, submitPrompt } }

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')
const { UserButtonMenu } = await import('../../../src/renderer/components/command-bar/menus')
const { sendToAllOffer } = await import('../../../src/renderer/components/command-bar/layout')
const { oneOffBroadcastBlocker, broadcastBlocker } = await import('../../../src/renderer/lib/commandBroadcast')
const { sessionCapabilities } = await import('../../../src/renderer/lib/session-capabilities')
const { usePasteHintStore } = await import('../../../src/renderer/stores/pasteHintStore')

/** The pressed tab (local, shown), an SSH tab in the background, a Codex tab,
 *  and the tabs a broadcast never reaches. */
const OPEN = [
  { id: 's-1', label: 'here', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', model: 'sonnet', configId: 'cfg' },
  { id: 's-2', label: 'remote', workingDirectory: '/', color: '#89b4fa', sessionType: 'ssh', model: 'sonnet', sshConfig: { host: 'build-box', port: 22, username: 'u', remotePath: '/' } },
  { id: 's-3', label: 'cx-config', customName: 'cx work', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', model: '', provider: 'codex' },
  { id: 'sh', label: 'shell', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', model: '', shellOnly: true },
  { id: 'ask', label: 'Ask', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', model: '', kind: 'ask' },
  { id: 'gone', label: 'ended', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', model: '', ptyExited: true },
]
const GLOBAL_PROMPT = { id: 'p1', label: 'Resume', prompt: 'resume from the handoff', scope: 'global', kind: 'prompt', target: 'claude' }
const SESSION_PROMPT = { id: 'c1', label: 'Standup', prompt: 'write the standup note', scope: 'config', configId: 'cfg', kind: 'prompt', target: 'claude' }
const BROADCAST = { id: 'b1', label: 'Review all', prompt: 'review the open diff', scope: 'global', kind: 'prompt', target: 'claude', broadcast: true }
const SHELL_LINE = { id: 'sh1', label: 'Run tests', prompt: 'npm test', scope: 'global', kind: 'shell', target: 'partner' }
const PAGE = { id: 'pg1', label: 'Docs', prompt: '', scope: 'global', kind: 'page', pageUrl: 'https://docs.example.com/' }

const ITEM_LABEL = 'Send to all sessions…'
const ARGS_REASON = 'Only a prompt with no arguments can go to every open session.'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  COMMANDS = []
  SESSIONS = OPEN
  ptyWrite.mockClear()
  submitPrompt.mockClear()
  trackUsage.mockClear()
  for (const f of Object.values(store)) f.mockClear()
  ;(globalThis as any).window.electronAPI.pty = { write: ptyWrite, submitPrompt }
  usePasteHintStore.setState({ hints: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const render = (props: Record<string, unknown> = {}) => {
  act(() => { root.render(React.createElement(CommandBar, { sessionId: 's-1', parentSessionId: 's-1', partnerSessionId: 's-1-partner', configId: 'cfg', ...props } as never)) })
}
const settle = () => new Promise((r) => setTimeout(r, 0))
const byTest = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const chip = (id: string) => container.querySelector<HTMLElement>(`[data-testid="command-chip"][data-command-id="${id}"]`)!
const rightClick = async (id: string) => {
  await act(async () => { chip(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 })); await settle() })
}
const click = async (id: string) => { await act(async () => { byTest(id)!.click(); await settle() }) }
const press = async (id: string) => { await act(async () => { chip(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); await settle() }) }
const key = async (el: Element | null, k: string, init: KeyboardEventInit = {}) => {
  await act(async () => { el!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); await settle() })
}
const item = () => byTest('menu-send-all')
const why = () => byTest('menu-send-all-why')?.textContent ?? null
/** The item's own words and its right-edge hint, read apart. */
const labelOf = (el: HTMLElement | null) => el?.querySelector<HTMLElement>('span.flex-1')?.textContent ?? null
const hintOf = (el: HTMLElement | null) => el?.querySelector<HTMLElement>('span.font-mono')?.textContent ?? null
const isDisabled = (el: HTMLElement | null) => !!el && (el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') === 'true'
const chooser = () => byTest('broadcast-chooser')
const sentTo = () => submitPrompt.mock.calls.map((c) => c[0])
const note = () => usePasteHintStore.getState().hints['s-1']
const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="broadcast-choice"]'))
const tickBox = (id: string) => container.querySelector<HTMLInputElement>(`[data-testid="broadcast-choice"][data-session-id="${id}"] [data-testid="broadcast-choice-tick"]`)!
const focusedTestId = () => (document.activeElement as HTMLElement | null)?.dataset.testid

describe('the right-click item shows for a send-a-prompt button that is not a broadcast button (#450)', () => {
  it.each([
    ['a Global prompt button', GLOBAL_PROMPT],
    ['a Session prompt button', SESSION_PROMPT],
  ])('%s: "Send to all sessions…", and it can be chosen', async (_name, cmd) => {
    COMMANDS = [cmd]
    render()
    await rightClick(cmd.id)
    expect(item()).not.toBeNull()
    expect(labelOf(item())).toBe(ITEM_LABEL)
    expect(isDisabled(item())).toBe(false)
    expect(hintOf(item())).toBeNull()
    expect(why()).toBeNull()
  })

  it.each([
    ['a broadcast button (its own press already asks)', BROADCAST],
    ['a shell line', SHELL_LINE],
    ['a page button', PAGE],
    ['an old record with no stored kind aimed at the partner shell', { id: 'o1', label: 'Old shell', prompt: 'ls', scope: 'global', target: 'partner' }],
  ])('not for %s', async (_name, cmd) => {
    COMMANDS = [cmd]
    render()
    await rightClick(cmd.id as string)
    expect(byTest('command-menu')).not.toBeNull()
    expect(item()).toBeNull()
  })

  it('not with a preload that has no prompt path (an older preload presses as a single button)', async () => {
    ;(globalThis as any).window.electronAPI.pty = { write: ptyWrite }
    COMMANDS = [GLOBAL_PROMPT]
    render()
    await rightClick('p1')
    expect(byTest('command-menu')).not.toBeNull()
    expect(item()).toBeNull()
  })

  it.each([
    ['a prompt with arguments', { ...GLOBAL_PROMPT, defaultArgs: ['--verbose'] }],
    ['a prompt with remembered Ctrl+click arguments', { ...GLOBAL_PROMPT, lastCustomArgs: ['--fast'] }],
    ['a Session prompt with arguments', { ...SESSION_PROMPT, defaultArgs: ['--short'] }],
  ])('shown disabled, with its reason under it, for %s; choosing it opens nothing', async (_name, cmd) => {
    COMMANDS = [cmd]
    render()
    await rightClick(cmd.id)
    expect(isDisabled(item())).toBe(true)
    expect(hintOf(item())).toBe("can't send")
    expect(why()).toBe(ARGS_REASON)
    await click('menu-send-all')
    expect(chooser()).toBeNull()
    expect(submitPrompt).not.toHaveBeenCalled()
  })
})

describe('choosing it opens the broadcast chooser, and Send reaches the sessions picked (#450)', () => {
  it('a Global prompt: the menu closes, the chooser opens and nothing is sent yet; All reaches every open agent tab once, with one note', async () => {
    COMMANDS = [GLOBAL_PROMPT]
    render()
    await rightClick('p1')
    await click('menu-send-all')
    expect(byTest('command-menu')).toBeNull()
    expect(chooser()).not.toBeNull()
    expect(byTest('broadcast-chooser-title')!.textContent).toBe('Send "Resume" to')
    expect(byTest('broadcast-chooser-all')!.textContent).toBe('All (3)')
    expect(submitPrompt).not.toHaveBeenCalled()
    expect(ptyWrite).not.toHaveBeenCalled()
    await click('broadcast-chooser-all')
    expect(chooser()).toBeNull()
    expect(sentTo()).toEqual([
      { sessionId: 's-1', text: 'resume from the handoff' },
      { sessionId: 's-2', text: 'resume from the handoff' },
      { sessionId: 's-3', text: 'resume from the handoff' },
    ])
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(note()).toBe('Sent to 3 of 3 sessions.')
    expect(trackUsage).toHaveBeenCalledWith('commands.broadcast')
  })

  it('a Session prompt: Send reaches only the sessions picked, once each (the send\'s re-check reads the one-off rule)', async () => {
    COMMANDS = [SESSION_PROMPT]
    render()
    await rightClick('c1')
    await click('menu-send-all')
    await click('broadcast-chooser-choose')
    expect(rows().map((r) => r.dataset.sessionId)).toEqual(['s-1', 's-2', 's-3'])
    // Untick the SSH tab: Send reaches this tab and the Codex tab only.
    await act(async () => { tickBox('s-2').click(); await settle() })
    await click('broadcast-chooser-send')
    expect(chooser()).toBeNull()
    expect(sentTo()).toEqual([
      { sessionId: 's-1', text: 'write the standup note' },
      { sessionId: 's-3', text: 'write the standup note' },
    ])
    expect(note()).toBe('Sent to 2 of 2 sessions.')
  })

  it('a Session prompt: All reaches every open agent tab, of any config', async () => {
    COMMANDS = [SESSION_PROMPT]
    render()
    await rightClick('c1')
    await click('menu-send-all')
    await click('broadcast-chooser-all')
    expect(sentTo().map((c) => c.sessionId)).toEqual(['s-1', 's-2', 's-3'])
  })

  it('Cancel sends nothing', async () => {
    COMMANDS = [SESSION_PROMPT]
    render()
    await rightClick('c1')
    await click('menu-send-all')
    await click('broadcast-chooser-cancel')
    expect(chooser()).toBeNull()
    expect(submitPrompt).not.toHaveBeenCalled()
    expect(ptyWrite).not.toHaveBeenCalled()
  })

  it('a button that gains arguments while the chooser is up sends nothing: the re-check still reads the one-off rule', async () => {
    COMMANDS = [SESSION_PROMPT]
    render()
    await rightClick('c1')
    await click('menu-send-all')
    COMMANDS = [{ ...SESSION_PROMPT, defaultArgs: ['--short'] }]
    render()
    await click('broadcast-chooser-all')
    expect(submitPrompt).not.toHaveBeenCalled()
  })

  it('a Shift+click broadcast keeps its own rule: a Global prompt made Session-only while the chooser is up sends nothing', async () => {
    COMMANDS = [GLOBAL_PROMPT]
    render()
    await act(async () => { chip('p1').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })); await settle() })
    expect(chooser()).not.toBeNull()
    COMMANDS = [{ ...GLOBAL_PROMPT, scope: 'config', configId: 'cfg' }]
    render()
    await click('broadcast-chooser-all')
    expect(submitPrompt).not.toHaveBeenCalled()
  })

  it('with no open agent session to send to, the tab says so and nothing asks', async () => {
    COMMANDS = [GLOBAL_PROMPT]
    SESSIONS = [{ ...OPEN[0], ptyExited: true }, OPEN[3], OPEN[4]]
    render()
    await rightClick('p1')
    await click('menu-send-all')
    expect(chooser()).toBeNull()
    expect(submitPrompt).not.toHaveBeenCalled()
    expect(note()).toBe('No open agent session to send to.')
  })
})

describe('the button\'s own setting does not change (#450)', () => {
  it.each([
    ['a Global prompt', GLOBAL_PROMPT, 'resume from the handoff'],
    ['a Session prompt', SESSION_PROMPT, 'write the standup note'],
  ])('%s: after a send to all, nothing is written, no pill shows, and its next plain press reaches only its own tab', async (_name, cmd, text) => {
    const before = JSON.stringify(cmd)
    COMMANDS = [cmd]
    render()
    await rightClick(cmd.id)
    await click('menu-send-all')
    await click('broadcast-chooser-all')
    expect(submitPrompt).toHaveBeenCalledTimes(3)
    for (const [name, f] of Object.entries(store)) expect(f, name).not.toHaveBeenCalled()
    expect(JSON.stringify(COMMANDS[0])).toBe(before)
    expect(chip(cmd.id).querySelector('[data-testid="command-broadcast-pill"]')).toBeNull()
    submitPrompt.mockClear()
    await press(cmd.id)
    expect(chooser()).toBeNull()
    expect(sentTo()).toEqual([{ sessionId: 's-1', text }])
  })
})

describe('the keyboard reaches it as the rest of the menu (#450)', () => {
  it.each([
    ['Shift+F10', 'F10', { shiftKey: true }],
    ['the ContextMenu key', 'ContextMenu', {}],
  ])('%s opens the menu on Run, ArrowDown moves to the item (Run with arguments is off), and choosing it opens the chooser', async (_name, k, init) => {
    COMMANDS = [GLOBAL_PROMPT]
    render()
    chip('p1').focus()
    await key(chip('p1'), k, init)
    expect(byTest('command-menu')).not.toBeNull()
    expect(focusedTestId()).toBe('menu-run')
    await key(document.activeElement, 'ArrowDown')
    expect(focusedTestId()).toBe('menu-send-all')
    await act(async () => { (document.activeElement as HTMLElement).click(); await settle() })
    expect(chooser()).not.toBeNull()
    expect(submitPrompt).not.toHaveBeenCalled()
  })

  it('a disabled item is skipped by the arrow keys, as every disabled item is', async () => {
    COMMANDS = [{ ...GLOBAL_PROMPT, lastCustomArgs: ['--fast'] }]
    render()
    chip('p1').focus()
    await key(chip('p1'), 'F10', { shiftKey: true })
    expect(focusedTestId()).toBe('menu-run')
    await key(document.activeElement, 'ArrowDown')
    // Run with arguments is live (remembered arguments); the next is Edit, past the disabled item.
    expect(focusedTestId()).toBe('menu-run-args')
    await key(document.activeElement, 'ArrowDown')
    expect(focusedTestId()).toBe('menu-edit')
  })
})

describe('the item in other sessions, read off the menu itself (#450)', () => {
  const noop = () => {}
  /** `onSendToAll` null: the bar gives no way to send, so the menu gets none. */
  const renderMenu = (cmd: Record<string, unknown>, session: Record<string, unknown>, onSendToAll: (() => void) | null = vi.fn()) => {
    act(() => {
      root.render(React.createElement(UserButtonMenu, {
        x: 0, y: 0, cmd: cmd as never, caps: sessionCapabilities(session as never), sections: [], hasConfig: true,
        onClose: noop, onRun: noop, onRunWithArgs: noop, onEdit: noop, onDuplicate: noop, onIcon: noop, onColor: noop,
        onTogglePin: noop, onShowIn: noop, onMoveToSection: noop, onMove: noop, onDelete: noop, onSendToAll: onSendToAll ?? undefined,
      }))
    })
  }
  const ASK = OPEN[4]
  const TERMINAL_ONLY = { ...OPEN[3], configId: 'cfg' }

  it.each([
    ['in Ask Conductor', GLOBAL_PROMPT, ASK, 'Ask Conductor cannot send to other sessions.'],
    ['in a terminal-only tab', GLOBAL_PROMPT, TERMINAL_ONLY, 'Only an agent session can send to other sessions.'],
    ['for a prompt carrying a secret', { ...GLOBAL_PROMPT, hasSecretArg: true }, OPEN[0], ARGS_REASON],
  ])('shown disabled with its reason %s', (_name, cmd, session, reason) => {
    const onSendToAll = vi.fn()
    renderMenu(cmd, session, onSendToAll)
    expect(labelOf(item())).toBe(ITEM_LABEL)
    expect(isDisabled(item())).toBe(true)
    expect(hintOf(item())).toBe("can't send")
    expect(why()).toBe(reason)
    act(() => { item()!.click() })
    expect(onSendToAll).not.toHaveBeenCalled()
  })

  it('not shown for an old Session record with no stored kind in a terminal-only tab: there it is that shell\'s own line', () => {
    renderMenu({ id: 'o2', label: 'Old line', prompt: 'make', scope: 'config', configId: 'cfg' }, TERMINAL_ONLY)
    expect(byTest('command-menu')).not.toBeNull()
    expect(item()).toBeNull()
  })

  it('not shown when the bar gives no way to send (no prompt path)', () => {
    renderMenu(GLOBAL_PROMPT, OPEN[0], null)
    expect(byTest('command-menu')).not.toBeNull()
    expect(item()).toBeNull()
  })

  it('choosing it calls the bar once', () => {
    const onSendToAll = vi.fn()
    renderMenu(SESSION_PROMPT, OPEN[0], onSendToAll)
    act(() => { item()!.click() })
    expect(onSendToAll).toHaveBeenCalledTimes(1)
  })
})

describe('the one-off rule: broadcastBlocker without its Global line (#450)', () => {
  const SIMPLE = { scope: 'global' as const, kind: 'prompt' as const, target: 'claude' as const }

  it.each([
    ['a Global prompt', SIMPLE],
    ['a Session prompt', { ...SIMPLE, scope: 'config' as const }],
    ['an old Global record with no stored kind', { scope: 'global' as const }],
    ['an old Session record with no stored kind', { scope: 'config' as const }],
  ])('%s can', (_name, cmd) => {
    expect(oneOffBroadcastBlocker(cmd)).toBeNull()
  })

  it.each([
    ['a shell line', { ...SIMPLE, kind: 'shell' as const, target: 'partner' as const }, 'Only a prompt can go to every open session.'],
    ['a page', { ...SIMPLE, kind: 'page' as const }, 'Only a prompt can go to every open session.'],
    ['an old record aimed at the partner shell', { scope: 'config' as const, target: 'partner' as const }, 'Only a prompt can go to every open session.'],
    ['an old record with a secret (a shell line)', { scope: 'config' as const, hasSecretArg: true }, 'Only a prompt can go to every open session.'],
    ['a prompt with arguments', { ...SIMPLE, scope: 'config' as const, defaultArgs: ['--verbose'] }, ARGS_REASON],
    ['a prompt with remembered Ctrl+click arguments', { ...SIMPLE, lastCustomArgs: ['--fast'] }, ARGS_REASON],
    ['a prompt marked as carrying a secret', { ...SIMPLE, scope: 'config' as const, hasSecretArg: true }, ARGS_REASON],
  ])('%s cannot, and the reason says why in one line', (_name, cmd, reason) => {
    expect(oneOffBroadcastBlocker(cmd)).toBe(reason)
  })

  it('the Global line is the only difference: a Session prompt is blocked for the option and free for the one-off', () => {
    const session = { ...SIMPLE, scope: 'config' as const }
    expect(broadcastBlocker(session)).toBe('Only a Global button can go to every open session.')
    expect(oneOffBroadcastBlocker(session)).toBeNull()
    // Where the option's rule says no for another reason, the one-off says the same.
    for (const cmd of [{ ...SIMPLE, kind: 'shell' as const }, { ...SIMPLE, defaultArgs: ['x'] }, { ...SIMPLE, hasSecretArg: true }]) {
      expect(oneOffBroadcastBlocker(cmd)).toBe(broadcastBlocker(cmd))
    }
  })

  it('the menu offers it on no broadcast button, and on a record with the option that is not a simple Global prompt (it presses as a single button)', () => {
    const caps = sessionCapabilities(OPEN[0] as never)
    expect(sendToAllOffer(BROADCAST as never, caps)).toBeNull()
    expect(sendToAllOffer({ ...BROADCAST, scope: 'config', configId: 'cfg' } as never, caps)).toEqual({ blockedBy: null })
    expect(sendToAllOffer({ ...BROADCAST, defaultArgs: ['--strict'] } as never, caps)).toEqual({ blockedBy: ARGS_REASON })
  })
})
