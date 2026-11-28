// This computer's clipboard writer for a picture (ADR-032 decision 2; plan
// 2.1.3-beta.21 phase 2, 2.1.1). Electron main writes the picture, and only
// when the clipboard does not already hold what the CLI reads (the paste
// module, ./index.ts, decides that). The picture is an ordinary clipboard
// item: no transient markers, so Windows clipboard history and cloud sync
// follow the user's own settings (plan Q4), and the clipboard's earlier
// content is not saved or restored (plan Q1).
//
// Windows: one Electron 44 clipboard.write() call with one item holding
// image/png, the W3C-shaped API whose read the app already uses
// (src/main/clipboard-image.ts). Probe PW2 reads back which Win32 formats
// that call leaves (both CLIs read CF_DIB; one of them reads the registered
// PNG format first).
//
// macOS and Linux: not in this phase. Phase 3 (plan 3.1) fills each with the
// formats its CLIs read (macOS public.png and public.tiff, Linux image/png),
// measured by PM1 and PL1. Until then a write there answers `not-yet` and
// nothing is written.
import { clipboard, ClipboardItem, type NativeImage } from 'electron'

/** What one write did. */
export type ClipboardWriteResult = 'written' | 'failed' | 'not-yet'

/** The writer for one OS: the picture's PNG bytes onto the clipboard. */
export type PlatformClipboardWriter = (png: Buffer) => Promise<ClipboardWriteResult>

/** Windows: one write of one item holding image/png. */
export const writeWindowsClipboardPicture: PlatformClipboardWriter = async (png) => {
  try {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
    return 'written'
  } catch {
    return 'failed'
  }
}

/** macOS: filled by plan 3.1 (public.png and public.tiff). */
export const writeMacClipboardPicture: PlatformClipboardWriter = async () => 'not-yet'

/** Linux: filled by plan 3.1 (image/png). */
export const writeLinuxClipboardPicture: PlatformClipboardWriter = async () => 'not-yet'

/** The writer for `platform`. */
export function clipboardWriterFor(platform: NodeJS.Platform): PlatformClipboardWriter {
  if (platform === 'win32') return writeWindowsClipboardPicture
  if (platform === 'darwin') return writeMacClipboardPicture
  return writeLinuxClipboardPicture
}

/** Write `picture` onto this computer's clipboard by `platform`'s writer. An
 *  empty picture, or one whose PNG cannot be made, writes nothing. */
export async function writeClipboardPicture(picture: NativeImage, platform: NodeJS.Platform = process.platform): Promise<ClipboardWriteResult> {
  let png: Buffer
  try {
    if (picture.isEmpty()) return 'failed'
    png = picture.toPNG()
  } catch {
    return 'failed'
  }
  if (!png || png.length === 0) return 'failed'
  return clipboardWriterFor(platform)(png)
}
