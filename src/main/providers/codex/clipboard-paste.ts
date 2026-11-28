// The Codex package's clipboard image paste (ADR-032, row 14; plan
// 2.1.3-beta.21 phase 2, 2.1.2): the key the app sends for Codex's own image
// paste, per OS, the formats its clipboard read takes, and whether it reads a
// copied file itself.
//
// Codex 0.157.1 binds both Ctrl+V and Alt+V to paste_image_to_temp_png
// (chatwidget/interaction.rs): its clipboard read is arboard 3.6.1. On
// Windows the app sends ESC v (Alt+V), the key probe P3.15 proved there
// (c11fb360): Ctrl+V under ConPTY reaches Codex as a control byte its
// composer may take as text. Elsewhere Ctrl+V. Codex has no keybindings file
// of its own to read.
//
// WHAT IT READS. arboard reads a copied file list first, then the registered
// PNG format, then CF_DIBV5 (synthesised from CF_DIB) on Windows; TIFF and
// file URLs on macOS; Wayland data-control, else X11 image/png, on Linux. So
// a copied image file needs no write for Codex on Windows and macOS.
import type { ClipboardPasteRule, PasteKey } from '../types'

const ESC_V = '\u001bv'
const CTRL_V = '\u0016'

/** Codex's image paste key on `platform`. */
export function codexImagePasteKey(platform: NodeJS.Platform): PasteKey {
  return platform === 'win32'
    ? { bytes: ESC_V, chord: 'alt+v', from: 'default' }
    : { bytes: CTRL_V, chord: 'ctrl+v', from: 'default' }
}

/** The Codex package's clipboard paste rule (SessionProvider.clipboardPaste). */
export const CODEX_CLIPBOARD_PASTE: ClipboardPasteRule = {
  key: ({ platform }) => codexImagePasteKey(platform),
  readsCopiedFile: (platform) => platform === 'win32' || platform === 'darwin',
  formats: (platform) => (platform === 'win32' ? ['PNG', 'CF_DIB'] : platform === 'darwin' ? ['public.tiff', 'public.png'] : ['image/png']),
  // The path route behind the test switch only (plan Q5; deleted in
  // 2.1.3-beta.22): the renderer's Codex composer rule.
  pathRouteLine: 'composer',
}
