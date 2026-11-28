// @vitest-environment jsdom
/**
 * Option+V on macOS as the image paste key (ADR-032 decision 4; plan
 * 2.1.3-beta.21 phase 3, 3.1). On a Mac, Option with a letter types a
 * character: Option+V's keydown carries key '√', code 'KeyV' and altKey
 * (US layout). The shortcut matcher compared e.key only
 * (src/renderer/utils/shortcuts.ts), so the paste key never matched there
 * and xterm typed '√' (the app sets no macOptionIsMeta). On macOS the image
 * paste shortcut with Alt now matches its letter or digit by the physical
 * key (e.code); every other OS still matches by e.key, as before.
 *  - matchesImagePasteShortcut: Option+V is Alt+V on macOS, by e.code; a
 *    rebound Alt+Shift+V or Alt+1 the same; the plain key, another physical
 *    key, or a missing Alt is not. On Windows and Linux, e.key as before (an
 *    AltGr '√' is never Alt+V there). The platform defaults to
 *    window.electronPlatform.
 *  - matchesShortcut, every other shortcut (review round 1, N1): e.key only,
 *    on macOS too, as in beta.20, so Ctrl or Cmd with Option and G (glyph
 *    capture) or R (repaint), or a user's own Alt shortcut, still does not
 *    fire from Option there.
 *  - The two paste call sites (useKeyboardShortcuts.ts, from outside the
 *    terminal; TerminalView.tsx, the capture handler's isImageChord) use
 *    matchesImagePasteShortcut, and only for pasteImage.
 *  - The REAL capture-phase installer (terminalKeybindings.ts) with
 *    TerminalView's own matcher: a focused Option+V in a session whose CLI
 *    takes the paste is claimed before xterm (no '√' typed) and reported as
 *    one focused press.
 * Red on e89996bb: matchesShortcut read e.key, '√', on every OS. Red on
 * ce65a7dc: every shortcut with Alt matched by e.code on macOS. Mutants this
 * must catch: matching the paste key by e.key on macOS; the physical-key
 * match given to every shortcut.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { matchesShortcut, matchesImagePasteShortcut, DEFAULT_SHORTCUTS } from '../../../src/renderer/utils/shortcuts'
import { installTerminalKeybindings } from '../../../src/renderer/components/terminal/terminalKeybindings'

type Key = Partial<KeyboardEventInit> & { key: string; code?: string }
const ev = (init: Key) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
/** Option+V on a Mac, US layout. */
const OPTION_V: Key = { key: '√', code: 'KeyV', altKey: true }

beforeEach(() => {
  document.body.innerHTML = ''
  ;(window as unknown as { electronPlatform?: string }).electronPlatform = undefined
})

describe('the image paste shortcut on macOS: with Alt it matches by the physical key', () => {
  it('Option+V is the image paste key (Alt+V), by e.code', () => {
    expect(DEFAULT_SHORTCUTS.pasteImage).toBe('Alt+V')
    expect(matchesImagePasteShortcut(ev(OPTION_V), 'Alt+V', 'darwin')).toBe(true)
    expect(matchesImagePasteShortcut(ev({ ...OPTION_V, key: '◊', shiftKey: true }), 'Alt+Shift+V', 'darwin')).toBe(true)
    expect(matchesImagePasteShortcut(ev({ key: '¡', code: 'Digit1', altKey: true }), 'Alt+1', 'darwin')).toBe(true)
  })

  it('not another physical key, not without Alt, not with a modifier the shortcut lacks', () => {
    expect(matchesImagePasteShortcut(ev({ key: '∫', code: 'KeyB', altKey: true }), 'Alt+V', 'darwin')).toBe(false)
    expect(matchesImagePasteShortcut(ev({ key: 'v', code: 'KeyV' }), 'Alt+V', 'darwin')).toBe(false)
    expect(matchesImagePasteShortcut(ev({ ...OPTION_V, shiftKey: true }), 'Alt+V', 'darwin')).toBe(false)
    expect(matchesImagePasteShortcut(ev({ ...OPTION_V, metaKey: true }), 'Alt+V', 'darwin')).toBe(false)
  })

  it('a paste shortcut with no Alt still matches by e.key (Cmd+V is Ctrl+V)', () => {
    expect(matchesImagePasteShortcut(ev({ key: 'v', code: 'KeyV', metaKey: true }), 'Ctrl+V', 'darwin')).toBe(true)
    expect(matchesImagePasteShortcut(ev({ key: 'F2', code: 'F2' }), 'F2', 'darwin')).toBe(true)
  })

  it('Windows and Linux: e.key as before, so a typed √ with Alt is never Alt+V', () => {
    for (const os of ['win32', 'linux'] as const) {
      expect(matchesImagePasteShortcut(ev({ key: 'v', code: 'KeyV', altKey: true }), 'Alt+V', os), os).toBe(true)
      expect(matchesImagePasteShortcut(ev(OPTION_V), 'Alt+V', os), os).toBe(false)
    }
  })

  it('the platform is window.electronPlatform when not given', () => {
    ;(window as unknown as { electronPlatform?: string }).electronPlatform = 'darwin'
    expect(matchesImagePasteShortcut(ev(OPTION_V), 'Alt+V')).toBe(true)
    ;(window as unknown as { electronPlatform?: string }).electronPlatform = 'win32'
    expect(matchesImagePasteShortcut(ev(OPTION_V), 'Alt+V')).toBe(false)
  })
})

describe('every other shortcut matches by e.key only, on macOS too (N1)', () => {
  it('Ctrl or Cmd with Option and G (glyph capture) or R (repaint) does not fire from Option on a Mac, as in beta.20', () => {
    ;(window as unknown as { electronPlatform?: string }).electronPlatform = 'darwin'
    expect(DEFAULT_SHORTCUTS.captureGlyphDiagnostic).toBe('Ctrl+Alt+G')
    expect(DEFAULT_SHORTCUTS.repaintTerminal).toBe('Ctrl+Alt+R')
    expect(matchesShortcut(ev({ key: '©', code: 'KeyG', altKey: true, ctrlKey: true }), 'Ctrl+Alt+G')).toBe(false)
    expect(matchesShortcut(ev({ key: '©', code: 'KeyG', altKey: true, metaKey: true }), 'Ctrl+Alt+G')).toBe(false)
    expect(matchesShortcut(ev({ key: '®', code: 'KeyR', altKey: true, ctrlKey: true }), 'Ctrl+Alt+R')).toBe(false)
    expect(matchesShortcut(ev(OPTION_V), 'Alt+V'), 'a user\'s own Alt shortcut, or pasteImage through the plain matcher').toBe(false)
  })

  it('by e.key they match as before', () => {
    ;(window as unknown as { electronPlatform?: string }).electronPlatform = 'darwin'
    expect(matchesShortcut(ev({ key: 'g', code: 'KeyG', altKey: true, ctrlKey: true }), 'Ctrl+Alt+G')).toBe(true)
    expect(matchesShortcut(ev({ key: 't', code: 'KeyT', metaKey: true }), 'Ctrl+T')).toBe(true)
  })
})

describe('the two paste call sites use the image paste matcher, for pasteImage only', () => {
  const src = (p: string) => readFileSync(join(__dirname, '../../../src/renderer', p), 'utf8')
  it('useKeyboardShortcuts.ts (from outside the terminal) and TerminalView.tsx (the capture handler\'s isImageChord)', () => {
    const hook = src('hooks/useKeyboardShortcuts.ts')
    expect(hook).toMatch(/matchesImagePasteShortcut\(e, shortcuts\.pasteImage\)/)
    expect(hook).not.toMatch(/matchesShortcut\(e, shortcuts\.pasteImage\)/)
    expect(hook.match(/matchesImagePasteShortcut\(/g)).toHaveLength(1)
    const view = src('components/TerminalView.tsx')
    expect(view).toContain('isImageChord: (e) => matchesImagePasteShortcut(e, { ...DEFAULT_SHORTCUTS, ...(useSettingsStore.getState().settings.keyboardShortcuts || {}) }.pasteImage)')
    expect(view.match(/matchesImagePasteShortcut\(/g)).toHaveLength(1)
  })
})

describe('a focused Option+V in an agent session on macOS', () => {
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
        isImageChord: (e) => matchesImagePasteShortcut(e, DEFAULT_SHORTCUTS.pasteImage),
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
