// @vitest-environment jsdom
/**
 * Option+V on macOS as the image paste key (ADR-032 decision 4; plan
 * 2.1.3-beta.21 phase 3, 3.1). On a Mac, Option with a letter types a
 * character: Option+V's keydown carries key '√', code 'KeyV' and altKey
 * (US layout). The shortcut matcher compared e.key only
 * (src/renderer/utils/shortcuts.ts), so the paste key never matched there
 * and xterm typed '√' (the app sets no macOptionIsMeta). On macOS a
 * shortcut with Alt now matches its letter or digit by the physical key
 * (e.code); every other OS still matches by e.key, as before.
 *  - matchesShortcut: Option+V is Alt+V on macOS, by e.code; Ctrl+Option+G
 *    is Ctrl+Alt+G; the plain key, another physical key, or a missing Alt
 *    is not. On Windows and Linux, e.key as before (an AltGr '√' is never
 *    Alt+V there). The platform defaults to window.electronPlatform.
 *  - The REAL capture-phase installer (terminalKeybindings.ts) with
 *    TerminalView's own matcher: a focused Option+V in a session whose CLI
 *    takes the paste is claimed before xterm (no '√' typed) and reported as
 *    one focused press.
 * Red on e89996bb: matchesShortcut read e.key, '√', on every OS. Mutant this
 * must catch: matching by e.key on macOS.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { matchesShortcut, DEFAULT_SHORTCUTS } from '../../../src/renderer/utils/shortcuts'
import { installTerminalKeybindings } from '../../../src/renderer/components/terminal/terminalKeybindings'

type Key = Partial<KeyboardEventInit> & { key: string; code?: string }
const ev = (init: Key) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
/** Option+V on a Mac, US layout. */
const OPTION_V: Key = { key: '√', code: 'KeyV', altKey: true }

beforeEach(() => {
  document.body.innerHTML = ''
  ;(window as unknown as { electronPlatform?: string }).electronPlatform = undefined
})

describe('matchesShortcut on macOS: a shortcut with Alt matches by the physical key', () => {
  it('Option+V is the image paste key (Alt+V), by e.code', () => {
    expect(DEFAULT_SHORTCUTS.pasteImage).toBe('Alt+V')
    expect(matchesShortcut(ev(OPTION_V), 'Alt+V', 'darwin')).toBe(true)
    expect(matchesShortcut(ev({ ...OPTION_V, key: '◊', shiftKey: true }), 'Alt+Shift+V', 'darwin')).toBe(true)
    expect(matchesShortcut(ev({ key: '©', code: 'KeyG', altKey: true, ctrlKey: true }), 'Ctrl+Alt+G', 'darwin')).toBe(true)
    expect(matchesShortcut(ev({ key: '¡', code: 'Digit1', altKey: true }), 'Alt+1', 'darwin')).toBe(true)
  })

  it('not another physical key, not without Alt, not with a modifier the shortcut lacks', () => {
    expect(matchesShortcut(ev({ key: '∫', code: 'KeyB', altKey: true }), 'Alt+V', 'darwin')).toBe(false)
    expect(matchesShortcut(ev({ key: 'v', code: 'KeyV' }), 'Alt+V', 'darwin')).toBe(false)
    expect(matchesShortcut(ev({ ...OPTION_V, shiftKey: true }), 'Alt+V', 'darwin')).toBe(false)
    expect(matchesShortcut(ev({ ...OPTION_V, metaKey: true }), 'Alt+V', 'darwin')).toBe(false)
  })

  it('a shortcut with no Alt still matches by e.key (Cmd+T is Ctrl+T)', () => {
    expect(matchesShortcut(ev({ key: 't', code: 'KeyT', metaKey: true }), 'Ctrl+T', 'darwin')).toBe(true)
    expect(matchesShortcut(ev({ key: 'F2', code: 'F2' }), 'F2', 'darwin')).toBe(true)
  })

  it('Windows and Linux: e.key as before, so a typed √ with Alt is never Alt+V', () => {
    for (const os of ['win32', 'linux'] as const) {
      expect(matchesShortcut(ev({ key: 'v', code: 'KeyV', altKey: true }), 'Alt+V', os), os).toBe(true)
      expect(matchesShortcut(ev(OPTION_V), 'Alt+V', os), os).toBe(false)
    }
  })

  it('the platform is window.electronPlatform when not given', () => {
    ;(window as unknown as { electronPlatform?: string }).electronPlatform = 'darwin'
    expect(matchesShortcut(ev(OPTION_V), 'Alt+V')).toBe(true)
    ;(window as unknown as { electronPlatform?: string }).electronPlatform = 'win32'
    expect(matchesShortcut(ev(OPTION_V), 'Alt+V')).toBe(false)
  })
})

describe('a focused Option+V in a Claude Code or Codex session on macOS', () => {
  it('is claimed before xterm (no √ typed) and reported to main as one focused press', async () => {
    ;(window as unknown as { electronPlatform?: string }).electronPlatform = 'darwin'
    const textarea = document.createElement('textarea')
    textarea.className = 'xterm-helper-textarea'
    document.body.appendChild(textarea)
    const xtermSaw: string[] = []
    textarea.addEventListener('keydown', (e) => { xtermSaw.push((e as KeyboardEvent).key) })
    const presses: Array<[string, boolean]> = []
    const dispose = installTerminalKeybindings({
      term: { getSelection: () => '', paste: vi.fn(), clearSelection: vi.fn() },
      isActive: () => true,
      readText: async () => '',
      writeText: async () => {},
      hasModalOpen: () => false,
      getActiveElement: () => textarea,
      imagePaste: {
        // TerminalView's own matcher (TerminalView.tsx, imagePaste.isImageChord).
        isImageChord: (e) => matchesShortcut(e, DEFAULT_SHORTCUTS.pasteImage),
        takes: () => true,
        terminalFocused: () => true,
        press: async (c, f) => { presses.push([c, f]); return false },
      },
    })
    const e = ev(OPTION_V)
    textarea.dispatchEvent(e)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(xtermSaw).toEqual([])
    expect(e.defaultPrevented, 'no √ reaches the terminal').toBe(true)
    expect(presses).toEqual([['image', true]])
    dispose()
  })
})
