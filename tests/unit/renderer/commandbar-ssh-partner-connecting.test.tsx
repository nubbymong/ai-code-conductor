// @vitest-environment jsdom
/**
 * #86: a partner button on an SSH tab.
 *
 * An SSH session's partner is its own connection to the host, and pressing a
 * partner button with the partner closed is what OPENS that connection. The
 * bar used to type the line 100 ms later regardless, into an ssh process still
 * connecting or authenticating: with key auth it ran in the home folder before
 * main's `cd` line; at a password prompt it was sent AS the password. Pinned:
 *
 *   SSH partner, not at its shell -> type NOTHING; open the partner; say so
 *   a second press while connecting -> still nothing
 *   main reports the shell ('shell-only', pushed or caught up) -> typed
 *   the connection could not be made ('failed') -> nothing, and says so
 *   a Restart (new session record) -> not at its shell again until main says so
 *   a partner on this PC -> typed as before (open, then the line 100 ms later)
 *
 * Main's idle fallback also reports
 * 'shell-only' over a sign-in prompt it does not recognise (a verification
 * code, a key passphrase) or over a password prompt once its auth hold ends,
 * and the bar cannot tell that from a shell. So the note must not read as
 * "press again at any prompt": it says to sign in first and to press again at
 * the SHELL prompt, and stays up long enough to read. Pinned:
 *
 *   the connecting note says to sign in first, then press at the shell prompt
 *   it stays up 6 s, not the 3 s of a paste hint
 *   'failed' and 'skipped' say to press Restart in the partner view
 *   a 'shell-only' from main's idle fallback is typed into (accepted: the bar
 *   trusts main's state, and the note before it said to sign in first)
 *
 * Main's claude UI latch is not gated on a
 * shell-only PTY. Anything the partner prints with a rounded box rule (an
 * assistant CLI run there, a lazygit or btop border, a pnpm update box) moves its
 * flow from 'shell-only' to 'claude-running' for good, and the bar used to
 * refuse every press after that until a Restart, with the 'connecting' note.
 * The bar now latches "reached its shell" once per connection (a Restart or
 * Retry is a new connection), and keeps it when it is remounted on a tab
 * switch. Pinned:
 *
 *   'shell-only' then 'claude-running' -> typed, no note
 *   the same after the bar is remounted (caught up as 'claude-running') -> typed
 *   'claude-running' before any 'shell-only' (a banner, MOTD or rc output with
 *   a rounded box) -> nothing typed, and a note of its own (fail closed)
 *   a Restart after that -> not at its shell again until main says so
 *   a push that is neither the shell nor the box latch drops the latch
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let COMMANDS: any[] = []
const SSH_SESSION = { sessionType: 'ssh', sshConfig: { host: 'box', port: 22, username: 'u', remotePath: '/srv/app' } }
let SESSION: Record<string, unknown> = {}
/** The session record's createdAt: each test is its own connection, as a Restart makes one. */
let GEN = 100

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) =>
    sel({ sessions: [{ id: 's-1', label: 't', workingDirectory: 'C:\\work', color: '#89b4fa', sessionType: 'local', provider: 'claude', model: 'sonnet', createdAt: 1, ...SESSION }],
      activeSessionId: 's-1', updateSession: vi.fn() }),
}))
vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({
    commands: COMMANDS, sections: [], addCommand: vi.fn(), updateCommand: vi.fn(), removeCommand: vi.fn(),
    reorderCommands: vi.fn(), updateSection: vi.fn(), removeSection: vi.fn(), reorderSections: vi.fn(),
  }),
}))
vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) => sel({ state: { collapsedSectionIds: [] }, toggleSection: vi.fn() }),
}))
vi.mock('../../../src/renderer/stores/webviewStore', () => ({
  useWebviewStore: (sel: any) => sel({ startActivation: vi.fn(() => 0), markAvailable: vi.fn(), markFailed: vi.fn(), bySessionId: {} }),
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

const ptyWrite = vi.fn()
/** main's flow state per PTY id, as `ssh.getState` answers it. */
let FLOW: Record<string, string> = {}
const listeners = new Map<string, Set<(msg: { state: string; info?: string }) => void>>()
const sshApi = {
  onFlowState: vi.fn((id: string, cb: (msg: { state: string; info?: string }) => void) => {
    const set = listeners.get(id) ?? new Set()
    set.add(cb)
    listeners.set(id, set)
    return () => { set.delete(cb) }
  }),
  getState: vi.fn(async (id: string) => ({ state: FLOW[id] ?? 'connecting' })),
}
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: { write: ptyWrite },
  ssh: sshApi,
}

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')
const { usePasteHintStore } = await import('../../../src/renderer/stores/pasteHintStore')

let container: HTMLDivElement
let root: Root
const onTogglePartner = vi.fn()

const partnerCmd = { id: 'abc123', label: 'Build', prompt: 'make', scope: 'global', target: 'partner', kind: 'shell', defaultArgs: ['dist'] }

function render(isPartnerActive: boolean) {
  act(() => {
    root.render(React.createElement(CommandBar, {
      sessionId: 's-1', parentSessionId: 's-1', partnerEnabled: true, partnerSessionId: 's-1-partner',
      isPartnerActive, onTogglePartner,
    } as never))
  })
}

const press = () => {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Build')) as HTMLButtonElement
  act(() => { btn.click() })
}
/** Let the catch-up read resolve. */
const settle = async () => { await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }) }
/** Past the bar's 100 ms open-then-type delay, with room to spare. */
const pastTheDelay = () => { act(() => { vi.advanceTimersByTime(500) }) }
const push = (state: string, info?: string) => { act(() => { listeners.get('s-1-partner')?.forEach((cb) => cb({ state, info })) }) }
const partnerWrites = () => ptyWrite.mock.calls.filter((c) => c[0] === 's-1-partner')
const noteText = () => usePasteHintStore.getState().hints['s-1'] ?? ''

beforeEach(() => {
  vi.useFakeTimers()
  ptyWrite.mockClear(); onTogglePartner.mockClear(); sshApi.onFlowState.mockClear(); sshApi.getState.mockClear()
  listeners.clear()
  FLOW = {}
  SESSION = { ...SSH_SESSION, createdAt: ++GEN }
  COMMANDS = [partnerCmd]
  usePasteHintStore.getState().clear('s-1')
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() }); container.remove()
  vi.useRealTimers()
})

describe('a partner button on an SSH tab whose partner is not at its shell', () => {
  it('opens the partner, types NOTHING, and says to press again once its prompt shows', async () => {
    render(false)
    await settle()
    press()
    pastTheDelay()
    expect(onTogglePartner).toHaveBeenCalledTimes(1)
    expect(partnerWrites()).toEqual([])
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(noteText()).toBe('The partner shell is connecting to box. Sign in there if it asks, then press the button again once its shell prompt shows.')
    // Shown above the bar, where the bar's other notes are.
    expect(container.querySelector('[role="status"]')?.textContent).toContain('connecting to box')
  })

  it('the note never says to press at just any prompt: it says to sign in first and press at the shell prompt', async () => {
    render(false)
    await settle()
    press()
    // A sign-in prompt reads as "its prompt"; pressing there would type the
    // line as the password or code.
    expect(noteText()).not.toMatch(/once its prompt shows/)
    expect(noteText()).toMatch(/Sign in there if it asks/)
    expect(noteText()).toMatch(/once its shell prompt shows/)
  })

  it('the note stays up long enough to read (6 s, not the 3 s of a paste hint)', async () => {
    render(false)
    await settle()
    press()
    act(() => { vi.advanceTimersByTime(4000) })
    expect(noteText()).toContain('connecting to box')
    act(() => { vi.advanceTimersByTime(2100) })
    expect(noteText()).toBe('')
  })

  it('a second press while it is still connecting also types nothing', async () => {
    render(false)
    await settle()
    press()
    pastTheDelay()
    render(true) // App now shows the partner
    push('connecting')
    press()
    pastTheDelay()
    expect(ptyWrite).not.toHaveBeenCalled()
    // Already showing: not toggled back to the agent.
    expect(onTogglePartner).toHaveBeenCalledTimes(1)
    expect(noteText()).toContain('connecting to box')
  })

  it('once main reports the shell, the press types the line into the partner', async () => {
    render(false)
    await settle()
    press()
    pastTheDelay()
    expect(ptyWrite).not.toHaveBeenCalled()
    render(true)
    push('shell-only')
    press()
    expect(partnerWrites()).toEqual([['s-1-partner', 'make dist\r']])
  })

  it('a partner already at its shell when the bar mounts (caught up from main) is typed into', async () => {
    FLOW = { 's-1-partner': 'shell-only' }
    render(false)
    await settle()
    press()
    expect(onTogglePartner).toHaveBeenCalledTimes(1)
    pastTheDelay()
    expect(partnerWrites()).toEqual([['s-1-partner', 'make dist\r']])
    expect(noteText()).toBe('')
  })

  it('a partner that could not connect types nothing and says it could not reach the host', async () => {
    render(true)
    await settle()
    push('failed', 'connection')
    press()
    pastTheDelay()
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(noteText()).toBe('The partner shell could not reach box, so nothing was typed. Press Restart in the partner view to try again.')
  })

  it('a partner whose setup was skipped types nothing and says to press Restart, not that it is connecting', async () => {
    render(true)
    await settle()
    push('skipped')
    press()
    pastTheDelay()
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(noteText()).toBe('The partner shell on box skipped its setup, so nothing was typed. Press Restart in the partner view to open it again.')
  })

  it('accepted: a shell-only from the idle fallback in main is typed into (the bar cannot tell a sign-in prompt from a shell)', async () => {
    render(true)
    await settle()
    press()
    expect(noteText()).toMatch(/Sign in there if it asks/)
    push('shell-only', 'idle-fallback')
    press()
    expect(partnerWrites()).toEqual([['s-1-partner', 'make dist\r']])
  })

  it('a Restart (a new session record) is not at its shell again until main says so', async () => {
    render(true)
    await settle()
    push('shell-only')
    press()
    expect(partnerWrites()).toHaveLength(1)
    // The Restart re-creates the partner's connection; main does not announce
    // 'connecting' for the new one, so the old 'shell-only' must not carry over.
    SESSION = { ...SSH_SESSION, createdAt: ++GEN }
    render(true)
    await settle()
    press()
    pastTheDelay()
    expect(partnerWrites()).toHaveLength(1)
    expect(noteText()).toContain('connecting to box')
    push('shell-only')
    press()
    expect(partnerWrites()).toHaveLength(2)
  })
})

const NOT_REPORTED = 'The partner shell on box has not reported its shell prompt, so nothing was typed. Type the command in the partner view, or press Restart there and try again.'
/** The bar is remounted on every tab switch (App keys it per active session). */
const remount = () => {
  act(() => { root.unmount() })
  root = createRoot(container)
}

describe("main's claude UI latch on an SSH partner (anything printing a rounded box rule)", () => {
  it('a partner that reached its shell and then drew a rounded box is still typed into, with no note', async () => {
    render(true)
    await settle()
    push('shell-only')
    // e.g. claude, lazygit or a pnpm update box run in the partner: main
    // latches 'claude-running' for good, and nothing moves it back.
    push('claude-running')
    press()
    expect(partnerWrites()).toEqual([['s-1-partner', 'make dist\r']])
    expect(noteText()).toBe('')
  })

  it('the same partner is still typed into after the bar is remounted (a tab switch) and catches up as claude-running', async () => {
    render(true)
    await settle()
    push('shell-only')
    push('claude-running')
    remount()
    FLOW = { 's-1-partner': 'claude-running' }
    render(true)
    await settle()
    press()
    expect(partnerWrites()).toEqual([['s-1-partner', 'make dist\r']])
    expect(noteText()).toBe('')
  })

  it('claude-running before the partner ever reported its shell (a banner, MOTD or rc output with a rounded box) types nothing, with a note of its own', async () => {
    render(true)
    await settle()
    push('connecting')
    push('claude-running')
    press()
    pastTheDelay()
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(noteText()).toBe(NOT_REPORTED)
  })

  it('caught up as claude-running on a first mount (never seen at its shell) also types nothing', async () => {
    FLOW = { 's-1-partner': 'claude-running' }
    render(true)
    await settle()
    press()
    pastTheDelay()
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(noteText()).toBe(NOT_REPORTED)
  })

  it('a Restart after that is a new connection: not at its shell until main says so, whatever the old one reached', async () => {
    render(true)
    await settle()
    push('shell-only')
    push('claude-running')
    press()
    expect(partnerWrites()).toHaveLength(1)
    SESSION = { ...SSH_SESSION, createdAt: ++GEN }
    render(true)
    await settle()
    press()
    pastTheDelay()
    expect(partnerWrites()).toHaveLength(1)
    expect(noteText()).toContain('connecting to box')
    // The new connection's banner draws a rounded box before its prompt.
    push('claude-running')
    press()
    pastTheDelay()
    expect(partnerWrites()).toHaveLength(1)
    expect(noteText()).toBe(NOT_REPORTED)
  })

  it('a push that is neither the shell nor the box latch drops the latch (fail closed)', async () => {
    render(true)
    await settle()
    push('shell-only')
    // Main does not do this for a partner today; if it ever reports a new
    // connection on the same id, its banner must not reopen the bar.
    push('connecting')
    push('claude-running')
    press()
    pastTheDelay()
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(noteText()).toBe(NOT_REPORTED)
  })
})

describe('a partner on this PC', () => {
  it('is typed into as before: opened, then the line 100 ms later, with no flow state read', async () => {
    SESSION = {}
    render(false)
    await settle()
    press()
    expect(onTogglePartner).toHaveBeenCalledTimes(1)
    pastTheDelay()
    expect(partnerWrites()).toEqual([['s-1-partner', 'make dist\r']])
    expect(noteText()).toBe('')
    expect(sshApi.onFlowState).not.toHaveBeenCalled()
  })
})
