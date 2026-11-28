/**
 * Keyboard shortcut utilities for customizable keybindings.
 */

/** Convert a KeyboardEvent to a normalized shortcut string like "Ctrl+Shift+T" */
export function eventToShortcutString(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  // Normalize key name
  let key = e.key
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  // Skip modifier-only keys
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return ''

  parts.push(key)
  return parts.join('+')
}

/** The physical key (KeyboardEvent.code) of a shortcut's letter or digit:
 *  'V' is KeyV, '1' is Digit1; null for any other key. */
function physicalCodeOf(key: string): string | null {
  if (/^[A-Z]$/.test(key)) return `Key${key}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  return null
}

/** The OS the renderer runs on (the preload's electronPlatform). */
function rendererPlatform(): string | undefined {
  return typeof window !== 'undefined' ? (window as { electronPlatform?: string }).electronPlatform : undefined
}

/**
 * Check whether a KeyboardEvent matches a shortcut string.
 *
 * On macOS a shortcut with Alt matches its letter or digit by the physical
 * key (e.code) as well (ADR-032; plan 2.1.3-beta.21 phase 3, 3.1): Option
 * with a letter types a character there, so Option+V's e.key is '√' (US
 * layout) and an e.key match never saw the image paste key. Every other OS
 * matches by e.key, as before. `platform` defaults to the renderer's own.
 */
export function matchesShortcut(e: KeyboardEvent, shortcut: string, platform: string | undefined = rendererPlatform()): boolean {
  if (!shortcut) return false
  const parts = shortcut.split('+')
  const key = parts[parts.length - 1]
  const needsCtrl = parts.includes('Ctrl')
  const needsAlt = parts.includes('Alt')
  const needsShift = parts.includes('Shift')

  if (needsCtrl !== (e.ctrlKey || e.metaKey)) return false
  if (needsAlt !== e.altKey) return false
  if (needsShift !== e.shiftKey) return false

  // Normalize comparison
  let eventKey = e.key
  if (eventKey === ' ') eventKey = 'Space'
  else if (eventKey.length === 1) eventKey = eventKey.toUpperCase()

  if (eventKey === key) return true
  if (platform === 'darwin' && needsAlt) {
    const code = physicalCodeOf(key)
    return code !== null && e.code === code
  }
  return false
}

/** Default keyboard shortcuts */
export const DEFAULT_SHORTCUTS: Record<string, string> = {
  newConfig: 'Ctrl+T',
  closeSession: 'Ctrl+W',
  nextSession: 'Ctrl+Tab',
  prevSession: 'Ctrl+Shift+Tab',
  toggleSidebar: 'Ctrl+B',
  pasteImage: 'Alt+V',
  renameSession: 'F2',
  captureGlyphDiagnostic: 'Ctrl+Alt+G',
  repaintTerminal: 'Ctrl+Alt+R',
}

/** Human-readable labels for shortcut actions */
export const SHORTCUT_LABELS: Record<string, string> = {
  newConfig: 'New config',
  closeSession: 'Close session',
  nextSession: 'Next session',
  prevSession: 'Previous session',
  toggleSidebar: 'Toggle sidebar',
  pasteImage: 'Paste clipboard image',
  renameSession: 'Rename session',
  captureGlyphDiagnostic: 'Capture glyph diagnostic',
  repaintTerminal: 'Repaint terminal',
}
