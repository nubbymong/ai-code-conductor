// @vitest-environment jsdom
/**
 * Alt+V with the focus outside the terminal (ADR-032; plan 2.1.3-beta.21
 * phase 2, 2.1.4 and Q3, Q9). Since 2.1.3-beta.21 no path is typed anywhere:
 *  - a Claude Code or Codex session (on this computer, or any SSH tab) is
 *    reported to main as one press (paste:imageKey, focused false), and the
 *    renderer sends no clipboard content and no path; main reads the
 *    clipboard and sends the CLI's own paste key;
 *  - a plain terminal, and the partner view's partner shell, get Alt+V as a
 *    key (ESC v) for the program there, and main is not asked; a terminal
 *    that is not running gets nothing and the hint says so;
 *  - a tab on the old SSH path: main answers today's fetch request, which
 *    the renderer types naming the saved file, never its path (Q9);
 *  - main's note for what was not pasted goes to the session's paste hint;
 *  - only main's path-route answer (the test switch, an unpackaged run) runs
 *    the beta.20 path flow.
 * Red on 0c54a1c6: Alt+V saved the picture and typed its path (or pasted it
 * through pty.submitImage), into a plain terminal and a partner shell too,
 * and main was never told of the press. Mutant this must catch: the path
 * fallback restored (the beta.20 route taken without main's path-route
 * answer).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({
  writes: [] as Array<[string, string]>,
  sendImageToSession: vi.fn(),
  sendImageToCodexSession: vi.fn(),
  sendFetchRequestFor: vi.fn(),
}))
vi.mock('../../../src/renderer/onboarding/gate', () => ({ deriveOnboarding: () => ({ due: false, steps: [] }) }))
vi.mock('../../../src/renderer/components/terminal/tmuxWheelScroll', () => ({ writeSessionInput: (id: string, data: string) => { h.writes.push([id, data]) } }))
vi.mock('../../../src/renderer/utils/imageTransfer', () => ({
  sendImageToSession: h.sendImageToSession,
  sendImageToCodexSession: h.sendImageToCodexSession,
  sendFetchRequestFor: h.sendFetchRequestFor,
}))

const { useKeyboardShortcuts } = await import('../../../src/renderer/hooks/useKeyboardShortcuts')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useSettingsStore } = await import('../../../src/renderer/stores/settingsStore')
const { usePasteHintStore } = await import('../../../src/renderer/stores/pasteHintStore')
const { DEFAULT_SHORTCUTS } = await import('../../../src/renderer/utils/shortcuts')
const { markSpawned, clearSpawned } = await import('../../../src/renderer/ptyTracker')
const { PASTE_SENTENCE, PASTE_NOTES } = await import('../../../src/shared/clipboard-paste')
import type { Session } from '../../../src/renderer/stores/sessionStore'
import type { PasteKeyResult } from '../../../src/shared/clipboard-paste'

const IMG = 'C:\\res\\screenshots\\clipboard-1.jpg'
const ESC_V = '\u001bv'
function session(id: string, extra: Partial<Session> = {}): Session {
  return { id, label: id, workingDirectory: '/x', model: 'opus', color: '#89b4fa', status: 'idle', createdAt: 0, sessionType: 'local', ...extra } as Session
}

function Host() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  useKeyboardShortcuts(activeSessionId, () => {}, () => {}, 'sessions', [], () => {})
  return null
}

let container: HTMLDivElement
let root: Root
let saveImage: ReturnType<typeof vi.fn>
let imageKey: ReturnType<typeof vi.fn>
let answer: PasteKeyResult

beforeEach(() => {
  h.writes = []
  h.sendImageToSession.mockReset()
  h.sendImageToCodexSession.mockReset()
  h.sendFetchRequestFor.mockReset()
  answer = { outcome: 'sent' }
  saveImage = vi.fn(async () => ({ path: IMG }))
  imageKey = vi.fn(async () => answer)
  ;(window as any).electronAPI = { clipboard: { saveImage }, paste: { imageKey } }
  useSettingsStore.setState({ settings: { keyboardShortcuts: DEFAULT_SHORTCUTS } as any })
  usePasteHintStore.setState({ hints: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() }) }

async function altV(sessions: Session[], active: string) {
  useSessionStore.setState({ sessions, activeSessionId: active, renamingSessionId: null })
  act(() => { root.render(<Host />) })
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', altKey: true, bubbles: true })) })
  await flush()
}

/** No write the renderer made holds a path, or any part of the saved file's name. */
function expectNoPath(): void {
  for (const [, data] of h.writes) {
    expect(data).not.toMatch(/[\\/]/)
    expect(data).not.toContain('clipboard-1')
  }
}

describe('Alt+V with focus outside the terminal, a Claude Code or Codex session (ADR-032)', () => {
  it('a Claude Code session on this computer: one press reported to main, no picture saved by the renderer, nothing typed', async () => {
    await altV([session('cl1')], 'cl1')
    expect(imageKey).toHaveBeenCalledTimes(1)
    expect(imageKey).toHaveBeenCalledWith({ sessionId: 'cl1', chord: 'image', focused: false })
    expect(saveImage).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
    expect(h.sendImageToSession).not.toHaveBeenCalled()
    expect(h.sendImageToCodexSession).not.toHaveBeenCalled()
  })

  it('a Codex session on this computer: the same, one press, no path', async () => {
    await altV([session('cx1', { provider: 'codex' } as Partial<Session>)], 'cx1')
    expect(imageKey).toHaveBeenCalledWith({ sessionId: 'cx1', chord: 'image', focused: false })
    expect(saveImage).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
  })

  it('what main did not paste is its note in the session\'s paste hint, never a typed line', async () => {
    for (const reason of ['no-picture', 'no-placeholder', 'busy', 'no-key', 'not-available'] as const) {
      answer = { outcome: 'not-pasted', reason, note: PASTE_NOTES[reason] }
      usePasteHintStore.setState({ hints: {} })
      await altV([session('cl1')], 'cl1')
      expect(usePasteHintStore.getState().hints.cl1, reason).toBe(PASTE_NOTES[reason])
      expect(h.writes, reason).toEqual([])
    }
    // Never the beta.20 fallback: no picture saved for a path, no path line.
    await flush()
    expect(saveImage).not.toHaveBeenCalled()
    expect(h.sendImageToSession).not.toHaveBeenCalled()
    expect(h.sendImageToCodexSession).not.toHaveBeenCalled()
  })

  it('a tab on the old SSH path: main answers the fetch request, typed naming the saved file, never its path (Q9)', async () => {
    answer = { outcome: 'fetch', filename: 'clipboard-1.jpg' }
    await altV([session('ss1', { sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u' } } as Partial<Session>)], 'ss1')
    expect(imageKey).toHaveBeenCalledWith({ sessionId: 'ss1', chord: 'image', focused: false })
    expect(h.sendFetchRequestFor).toHaveBeenCalledWith('ss1', 'clipboard-1.jpg', PASTE_SENTENCE)
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('only main\'s path-route answer (the test switch) runs the beta.20 path flow, by the line main named', async () => {
    answer = { outcome: 'path-route', line: 'composer' }
    await altV([session('cx1', { provider: 'codex' } as Partial<Session>)], 'cx1')
    await vi.waitFor(() => expect(h.sendImageToCodexSession).toHaveBeenCalledTimes(1))
    expect(saveImage).toHaveBeenCalledTimes(1)
    answer = { outcome: 'path-route', line: 'enter' }
    await altV([session('cl1')], 'cl1')
    await vi.waitFor(() => expect(h.sendImageToSession).toHaveBeenCalledTimes(1))
    expect(h.sendImageToSession.mock.calls[0].slice(0, 2)).toEqual(['cl1', IMG])
    expect(h.sendImageToSession.mock.calls[0][3]).toBe('local')
    expect(h.sendImageToSession.mock.calls[0][4]).toBe('enter')
  })
})

describe('Alt+V into a plain terminal: a key for the program there, no path (Q3)', () => {
  it('a plain terminal, on this computer or over SSH, gets ESC v and main is not asked', async () => {
    for (const extra of [{}, { sessionType: 'ssh' as const }]) {
      h.writes = []
      imageKey.mockClear()
      await altV([session('sh1', { shellOnly: true, ...extra } as Partial<Session>)], 'sh1')
      expect(h.writes, JSON.stringify(extra)).toEqual([['sh1', ESC_V]])
      expect(imageKey).not.toHaveBeenCalled()
      expect(saveImage).not.toHaveBeenCalled()
      expectNoPath()
    }
  })

  it('a plain terminal that is not running gets nothing, and the hint says so', async () => {
    for (const dead of [{ ptyExited: true }, { neverStarted: true }]) {
      h.writes = []
      usePasteHintStore.setState({ hints: {} })
      await altV([session('sh3', { shellOnly: true, ...dead } as Partial<Session>)], 'sh3')
      expect(h.writes).toEqual([])
      expect(usePasteHintStore.getState().hints.sh3).toContain('not running')
      expect(imageKey).not.toHaveBeenCalled()
    }
  })
})

describe('Alt+V in the partner view: the partner shell gets the key, the CLI gets nothing', () => {
  let paneEls: HTMLElement[] = []
  function mountPanes(panes: Array<[string, boolean]>, opts: { partnerRunning?: boolean } = {}) {
    for (const [id, onScreen] of panes) {
      const el = document.createElement('div')
      el.setAttribute('data-terminal-session', id)
      if (onScreen) el.setAttribute('data-terminal-active', '')
      document.body.appendChild(el)
      paneEls.push(el)
      if (id.endsWith('-partner') && opts.partnerRunning !== false) markSpawned(id)
    }
  }
  afterEach(() => {
    for (const el of paneEls) { clearSpawned(el.getAttribute('data-terminal-session') ?? ''); el.remove() }
    paneEls = []
  })

  it('a Claude Code, Codex or SSH tab showing its partner shell: ESC v into the partner PTY, and main is not asked for the hidden CLI', async () => {
    for (const extra of [{}, { provider: 'codex' }, { sessionType: 'ssh', sshConfig: { host: 'h', port: 22, username: 'u' } }] as Array<Partial<Session>>) {
      h.writes = []
      imageKey.mockClear()
      mountPanes([['px1', false], ['px1-partner', true]])
      await altV([session('px1', extra)], 'px1')
      expect(h.writes, JSON.stringify(extra)).toEqual([['px1-partner', ESC_V]])
      expect(imageKey).not.toHaveBeenCalled()
      expectNoPath()
      for (const el of paneEls) { clearSpawned(el.getAttribute('data-terminal-session') ?? ''); el.remove() }
      paneEls = []
    }
  })

  it('a partner shell that is not running: nothing typed into either terminal, and the hint says so', async () => {
    mountPanes([['px2', false], ['px2-partner', true]], { partnerRunning: false })
    await altV([session('px2')], 'px2')
    expect(h.writes).toEqual([])
    expect(imageKey).not.toHaveBeenCalled()
    expect(usePasteHintStore.getState().hints.px2).toContain('not running')
  })

  it('the main view on screen (the partner mounted and hidden): the CLI\'s press goes to main', async () => {
    mountPanes([['px3', true], ['px3-partner', false]])
    await altV([session('px3')], 'px3')
    expect(imageKey).toHaveBeenCalledWith({ sessionId: 'px3', chord: 'image', focused: false })
    expect(h.writes).toEqual([])
  })

  it('only this tab\'s own partner counts: another tab\'s partner marked on screen leaves this tab\'s route as it is', async () => {
    mountPanes([['other-partner', true], ['px4', true]])
    await altV([session('px4')], 'px4')
    expect(imageKey).toHaveBeenCalledWith({ sessionId: 'px4', chord: 'image', focused: false })
    expect(h.writes).toEqual([])
  })
})
