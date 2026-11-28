// This computer's clipboard writers on macOS and Linux app machines (ADR-032
// decision 2; plan 2.1.3-beta.21 phase 3, 3.1). Each writes the picture's
// formats for its OS (./picture-formats.ts) as ONE Electron 44
// clipboard.write() of one item, so every format on the clipboard is the
// same picture and the write is committed atomically. As on Windows, the
// picture is an ordinary clipboard item (plan Q4) and the clipboard's earlier
// content is not saved or restored (plan Q1). The paste module
// (./index.ts) decides when to write; probes PM1 (macOS) and PL1 (Linux)
// measure what the write leaves and whether both CLIs read it.
import { clipboard, ClipboardItem } from 'electron'
import type { ClipboardWriteResult, PlatformClipboardWriter } from './clipboard-writer'
import { linuxPictureFormats, macPictureFormats, type PictureFormat } from './picture-formats'

async function writeFormats(formats: PictureFormat[]): Promise<ClipboardWriteResult> {
  try {
    const entries: Record<string, Blob> = {}
    for (const f of formats) entries[f.type] = new Blob([new Uint8Array(f.bytes)])
    await clipboard.write([new ClipboardItem(entries)])
    return 'written'
  } catch {
    return 'failed'
  }
}

/** macOS: public.png and public.tiff in one item. */
export const writeMacClipboardPicture: PlatformClipboardWriter = async (png) => {
  let formats: PictureFormat[]
  try { formats = macPictureFormats(png) } catch { return 'failed' }
  return writeFormats(formats)
}

/** Linux: image/png in one item. */
export const writeLinuxClipboardPicture: PlatformClipboardWriter = async (png) => writeFormats(linuxPictureFormats(png))
