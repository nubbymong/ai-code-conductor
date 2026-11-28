// The Claude Code package's clipboard image paste (ADR-032, row 14; plan
// 2.1.3-beta.21 phase 2, 2.1.2): the key the app sends for Claude Code's own
// image paste, per OS, the formats its clipboard read takes, and whether it
// reads a copied file itself.
//
// THE KEY. Claude Code binds `chat:imagePaste` in its Chat context: Alt+V on
// Windows (and WSL), Ctrl+V elsewhere (2.1.332). An account can rebind it in
// `keybindings.json` in its own config folder (CLAUDE_CONFIG_DIR, else
// ~/.claude): `{ "bindings": [{ "context": "Chat", "bindings": { "<chord>":
// "chat:imagePaste" | null } }] }`. User bindings are added after the
// defaults; a chord set to null, or to another action, takes the default
// away. The app reads the file and never pins the binding, because that would
// override the user's choice (ADR-032, plan Q6). A chord goes through a fixed
// chord-to-bytes table (CHORD_BYTES below), so a file picks at most a chord
// from that table, never raw bytes. A binding the table cannot express (a
// chord of two keystrokes, cmd or super, a key that is not a letter) gets no
// key, and the hint asks the user to press Claude Code's own key. Probe PK1
// (the test VM, a test account) has not run yet: until it does, the file is
// read as above and anything else falls back to the default key.
//
// WHAT IT READS. On Windows `powershell -NoProfile -NonInteractive -Sta` and
// WinForms Clipboard.GetImage(), saved as PNG: a bitmap (CF_DIB) only, never
// a copied file list, so the app writes a copied image file as a picture for
// it. macOS: osascript, `«class PNGf»`. Linux: wl-paste or xclip; a copied
// image file is not read on Linux (src/main/clipboard-file.ts), as before.
// With neither program installed on Linux, Claude Code's own paste cannot
// read the picture, so the app sends no key and the hint names the two
// (plan 2.1.3-beta.21 phase 3, 3.1; claudeClipboardToolMissing below).
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import * as os from 'os'
import type { ClipboardPasteRule, PasteKey } from '../types'
import { findOnPosixPath } from '../../login-shell'

/** The programs Claude Code reads the clipboard with on Linux. */
export const CLAUDE_LINUX_CLIPBOARD_TOOLS = ['xclip', 'wl-paste'] as const
/** The system's own program folders, searched after PATH's: a session's
 *  login shell names them even when the app's own PATH does not. */
const SYSTEM_PROGRAM_FOLDERS = ['/usr/local/bin', '/usr/bin', '/bin']

/**
 * Whether neither program Claude Code reads the clipboard with on Linux is
 * installed: neither `xclip` nor `wl-paste` in PATH's absolute folders or the
 * system's, as a file this user may run. Never on Windows or macOS, where
 * Claude Code reads the clipboard with a program the system ships
 * (PowerShell, osascript).
 */
export function claudeClipboardToolMissing(platform: NodeJS.Platform, pathValue: string, runnable?: (p: string) => boolean): boolean {
  if (platform !== 'linux') return false
  const folders = [pathValue, ...SYSTEM_PROGRAM_FOLDERS].join(':')
  return CLAUDE_LINUX_CLIPBOARD_TOOLS.every((name) => findOnPosixPath(name, folders, runnable) === null)
}

/** Claude Code's action name for its image paste. */
export const CLAUDE_IMAGE_PASTE_ACTION = 'chat:imagePaste'
/** Its default chord on each OS (2.1.332). */
export function claudeDefaultImagePasteChord(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'alt+v' : 'ctrl+v'
}

/** The largest keybindings file read; a bigger one is not the user's few
 *  bindings, and the default key is sent. */
const MAX_KEYBINDINGS_BYTES = 256 * 1024

const MODIFIER_ALIASES: Readonly<Record<string, 'ctrl' | 'alt' | 'shift' | 'cmd'>> = {
  ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', opt: 'alt', option: 'alt', meta: 'alt',
  shift: 'shift',
  cmd: 'cmd', command: 'cmd', super: 'cmd', win: 'cmd',
}

/**
 * The bytes a terminal sends for `chord`, from a fixed table: a letter with
 * Ctrl (its control byte), with Alt or Meta (ESC and the letter; with Shift
 * too, ESC and the capital), or with Ctrl and Alt (ESC and the control byte).
 * Null for anything else: two keystrokes, cmd or super (most terminals never
 * send it), Shift alone, a key that is not a letter, Ctrl+C and Ctrl+D (they
 * end Claude Code, which never lets them be rebound), or Ctrl+M, Ctrl+J,
 * Ctrl+I and Ctrl+H (Enter, a new line, Tab and Backspace in a terminal).
 */
export function claudeChordBytes(chord: string): string | null {
  if (typeof chord !== 'string') return null
  const text = chord.trim().toLowerCase()
  if (text === '' || /\s/.test(text)) return null
  const parts = text.split('+')
  const key = parts.pop() ?? ''
  if (!/^[a-z]$/.test(key)) return null
  const mods = new Set<string>()
  for (const p of parts) {
    const m = MODIFIER_ALIASES[p]
    if (!m || mods.has(m)) return null
    mods.add(m)
  }
  if (mods.has('cmd')) return null
  const ctrl = mods.has('ctrl')
  const alt = mods.has('alt')
  const shift = mods.has('shift')
  if (!ctrl && !alt) return null
  if (ctrl) {
    if (shift) return null
    if ('cdmjih'.includes(key)) return null
    const control = String.fromCharCode(key.charCodeAt(0) - 96)
    return alt ? `\u001b${control}` : control
  }
  return `\u001b${shift ? key.toUpperCase() : key}`
}

/** One keystroke as Claude Code's keybindings name it, for comparing two
 *  spellings of the same chord (`opt+v` and `alt+v`). */
function normalChord(chord: string): string {
  const parts = chord.trim().toLowerCase().split('+')
  const key = parts.pop() ?? ''
  const mods = parts.map((p) => MODIFIER_ALIASES[p] ?? p).sort()
  return [...mods, key].join('+')
}

/**
 * What `keybindings.json`'s text says about the image paste, given the
 * default chord: the chords bound to it in the Chat context (in the file's
 * order), and whether the default chord was taken away there. Null when the
 * text is not a keybindings file (not JSON, no bindings array): then the
 * default key is sent, as Claude Code itself ignores such a file.
 */
export function readImagePasteBindings(text: string, defaultChord: string): { bound: string[]; defaultRemoved: boolean } | null {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { bindings?: unknown }).bindings)) return null
  const bound: string[] = []
  let defaultRemoved = false
  const wantDefault = normalChord(defaultChord)
  for (const block of (parsed as { bindings: unknown[] }).bindings) {
    if (!block || typeof block !== 'object') continue
    const { context, bindings } = block as { context?: unknown; bindings?: unknown }
    if (context !== 'Chat' || !bindings || typeof bindings !== 'object' || Array.isArray(bindings)) continue
    for (const [chord, action] of Object.entries(bindings as Record<string, unknown>)) {
      if (action === CLAUDE_IMAGE_PASTE_ACTION) {
        bound.push(chord)
        if (normalChord(chord) === wantDefault) defaultRemoved = false
      } else if (normalChord(chord) === wantDefault) {
        defaultRemoved = true
      }
    }
  }
  return { bound, defaultRemoved }
}

/**
 * The key for Claude Code's image paste on `platform`, from the text of the
 * account's keybindings file (null when there is none, or it could not be
 * read). A chord bound to the image paste in the file comes first (the first
 * one the table can express); else the default, unless the file took it away.
 */
export function claudeImagePasteKey(platform: NodeJS.Platform, keybindingsText: string | null): PasteKey {
  const defaultChord = claudeDefaultImagePasteChord(platform)
  const fromDefault = (): PasteKey => ({ bytes: claudeChordBytes(defaultChord) as string, chord: defaultChord, from: 'default' })
  if (keybindingsText === null) return fromDefault()
  const read = readImagePasteBindings(keybindingsText, defaultChord)
  if (!read) return fromDefault()
  for (const chord of read.bound) {
    const bytes = claudeChordBytes(chord)
    if (bytes) return { bytes, chord, from: 'keybindings' }
  }
  if (read.bound.length > 0) return { bytes: null, chord: read.bound[0], why: 'unexpressible' }
  if (read.defaultRemoved) return { bytes: null, chord: null, why: 'unbound' }
  return fromDefault()
}

/** The config folder a local Claude Code session reads: its account's own
 *  folder (`accountDir`, the CLAUDE_CONFIG_DIR its launch set), or, on this
 *  computer's own sign-in, the folder Claude Code reads by itself:
 *  CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeConfigDirOf(accountDir: string | null): string {
  if (accountDir) return accountDir
  const env = process.env.CLAUDE_CONFIG_DIR
  return env && env.trim() !== '' ? env : join(os.homedir(), '.claude')
}

/** The text of `keybindings.json` in `configDir`, or null: none, not a plain
 *  file, too big, or unreadable. */
export function readClaudeKeybindingsText(configDir: string): string | null {
  const file = join(configDir, 'keybindings.json')
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size > MAX_KEYBINDINGS_BYTES) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** The Claude Code package's clipboard paste rule (SessionProvider.clipboardPaste). */
export const CLAUDE_CLIPBOARD_PASTE: ClipboardPasteRule = {
  key: ({ platform, accountDir }) => claudeImagePasteKey(platform, readClaudeKeybindingsText(claudeConfigDirOf(accountDir))),
  // WinForms GetImage reads a bitmap only; osascript reads PNGf only; a
  // copied file is not read on Linux by anyone.
  readsCopiedFile: () => false,
  formats: (platform) => (platform === 'win32' ? ['CF_DIB', 'PNG'] : platform === 'darwin' ? ['public.png'] : ['image/png']),
  // The app's own PATH and the system folders: a local session's login
  // shell (login-shell.ts) builds its PATH from the user's profile, which
  // names the system folders too.
  clipboardToolMissing: (platform) => claudeClipboardToolMissing(platform, process.env.PATH ?? ''),
  // The path route behind the test switch only (plan Q5; deleted in
  // 2.1.3-beta.22): what the renderer types when main did not paste the path.
  pathRouteLine: 'enter',
}
