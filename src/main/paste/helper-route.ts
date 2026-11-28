// The paste route of a tab through the session helper on its machine (plan
// 2.1.3-beta.21 phase 5, block 5.1, its App bullet; ADR-032 decisions 2, 3,
// 5 and 9; aicc_planning#447). The paste module (./index.ts) hands it a
// helper tab's press and Snap through its seam, setRemotePasteRoute; the IPC
// layer registers it (src/main/ipc/paste-handlers.ts).
//
// WHAT IT DOES. The picture this computer's clipboard holds (Alt+V, or
// Ctrl+V with only a picture: plan Q2), a copied image file's picture
// (Alt+V), or Snap's goes to the tab's session folder on its machine by
// file.put on the tab's own connection (phase 4; RemotePasteRoute's tab is
// the remote helper's remoteTabPaste); then the tab's key goes through the
// session input module's one door (pasteFromClipboard), which reads Claude
// Code's placeholder on the holder's screen and, for a press from outside
// the terminal and for Snap, types the sentence and then Enter as its own
// write (the helper Enter rule: the holder hands each write to the CLI
// whole). The key is the one the tab's launch read from the host's own
// keybindings file (the Claude package's table), so a host picks at most a
// chord from the package's fixed table, never raw bytes. On the host the
// CLI's own image paste runs `xclip` or `wl-paste`, finds the clipboard
// stand-in first on its PATH, and reads the picture from the session's
// `paste/` folder (docs/remote/helper-protocol.md section 15). After Snap
// the picture also stays on this computer's clipboard (plan Q1), whichever
// machine the session runs on; a press writes nothing there.
//
// WHAT IT NEVER DOES. No path, no file name and no host text is typed into
// the session: file.put's reply carries a name and a hash only, and neither
// reaches the door. What the CLI does not take is reported in the paste hint.
//
// NOT AVAILABLE YET. A tab whose CLI the stand-in does not serve (its launch
// did not ask, the host is not Linux, or the stand-in was not written there:
// the plan's s5 fallback until probe PR1 passes on a host) answers "not
// available yet", and so does a launch that gave no key; nothing is sent and
// nothing typed. That covers a Codex helper tab (plan Q7: Codex remote
// sessions come in 2.1.3-beta.24, after probe PR2): its launch asks for no
// stand-in. A tab on the old SSH path never reaches this route (plan Q9: the
// paste module keeps today's fetch request for it).
//
// Pure of Electron (its picture is the few calls of a NativeImage it uses),
// so the remote-helper-e2e job runs it under plain Node against a real host
// (tests/live/remote-paste.live.ts).
import type { NativeImage } from 'electron'
import { notPasted, PASTE_SENTENCE, type PasteKeyPress, type PasteKeyResult } from '../../shared/clipboard-paste'
import type { ClipboardPasteDoorResult } from '../session-input'
import type { PasteKey } from '../providers/types'
import { PASTE_PICTURE_MAX } from '../session-helper/protocol'
import type { ClipboardWriteResult } from './clipboard-writer'
import type { RemotePasteRoute } from './index'
import { fromDoor } from './door-result'

/** What the route needs of the tab (the remote helper's RemoteTabPaste). */
export interface HelperTabPaste {
  /** The clipboard stand-in serves the tab's CLI on its machine. */
  readonly standIn: boolean
  /** The key its launch gave for the CLI's image paste, or none. */
  readonly key: PasteKey | undefined
  /** The picture into the tab's session folder there (file.put). */
  put(bytes: Buffer, kind: 'png' | 'jpg'): Promise<{ name: string; sha256: string }>
}

/** The few calls of a picture the route makes. */
export type RoutePicture = Pick<NativeImage, 'isEmpty' | 'toPNG' | 'toJPEG'>

/** What the route reads, writes and asks; the IPC layer gives the real ones. */
export interface HelperRouteDeps {
  /** The open helper tab of the app session, or null. */
  tab(sessionId: string): HelperTabPaste | null
  /** The picture on this computer's clipboard, or null. */
  readPicture(): Promise<RoutePicture | null>
  /** A copied image file's picture (Windows and macOS), or why none. */
  readCopiedImage(): Promise<{ picture: RoutePicture } | { error: 'no-image' | 'too-large' }>
  /** Snap's picture onto this computer's clipboard (plan Q1). */
  write(picture: NativeImage): Promise<ClipboardWriteResult>
  /** The session input module's door. */
  door(sessionId: string, key: string, sentence: string | null): Promise<ClipboardPasteDoorResult>
  /** One line for the app's log (never a picture, a path or a name). */
  log?(line: string): void
}

/** The JPEG quality of a picture whose PNG is over file.put's 20 MiB. */
export const HELPER_JPEG_QUALITY = 90

/** The paste hint's lines this route adds (ADR-032 decision 6: reported, never typed). */
export const HELPER_TOO_LARGE_NOTE = `Image too large to send to the session's machine (max ${PASTE_PICTURE_MAX / (1024 * 1024)} MB).`
export const HELPER_NOT_CONNECTED_NOTE = 'This tab is not connected to its machine right now, so nothing was pasted. Try again once it is back.'
export const HELPER_NOT_SENT_NOTE = 'The picture could not be sent to the session\'s machine, so nothing was pasted.'

const noteOf = (reason: 'too-large' | 'not-written', note: string): PasteKeyResult => ({ outcome: 'not-pasted', reason, note })

/** The bytes file.put takes for `picture`: its PNG, or its JPEG when the PNG
 *  is over the cap; 'too-large' when both are; null when it makes neither. */
function encoded(picture: RoutePicture): { bytes: Buffer; kind: 'png' | 'jpg' } | 'too-large' | null {
  try {
    if (picture.isEmpty()) return null
    const png = picture.toPNG()
    if (!png || png.length === 0) return null
    if (png.length <= PASTE_PICTURE_MAX) return { bytes: png, kind: 'png' }
    const jpg = picture.toJPEG(HELPER_JPEG_QUALITY)
    if (jpg && jpg.length > 0 && jpg.length <= PASTE_PICTURE_MAX) return { bytes: jpg, kind: 'jpg' }
    return 'too-large'
  } catch {
    return null
  }
}

/** A refused file.put, by its protocol code, as the paste hint says it. */
function refused(err: unknown): { result: PasteKeyResult; code: string } {
  const code = err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'error'
  switch (code) {
    case 'not-connected': return { result: noteOf('not-written', HELPER_NOT_CONNECTED_NOTE), code }
    // A holder from before 2.1.3-beta.21, which offers no `paste`.
    case 'unknown-type': return { result: notPasted('not-available'), code }
    case 'too-large': return { result: noteOf('too-large', HELPER_TOO_LARGE_NOTE), code }
    case 'busy': return { result: notPasted('busy'), code }
    default: return { result: noteOf('not-written', HELPER_NOT_SENT_NOTE), code: /^[a-z-]{1,24}$/.test(code) ? code : 'error' }
  }
}

/** The helper tab's route (RemotePasteRoute). Never rejects. */
export function helperPasteRoute(deps: HelperRouteDeps): RemotePasteRoute {
  /** The picture to the tab's machine, then its key through the door. */
  const send = async (sessionId: string, tab: HelperTabPaste, picture: RoutePicture, sentence: string | null): Promise<PasteKeyResult> => {
    const key = tab.key
    if (!key) return notPasted('not-available')
    const bytes = encoded(picture)
    if (bytes === null) return noteOf('not-written', HELPER_NOT_SENT_NOTE)
    if (bytes === 'too-large') return noteOf('too-large', HELPER_TOO_LARGE_NOTE)
    try {
      await tab.put(bytes.bytes, bytes.kind)
    } catch (err) {
      const why = refused(err)
      deps.log?.(`[paste] ${sessionId}: the picture was not sent to the tab's machine (${why.code})`)
      return why.result
    }
    // The picture is in the session's paste/ folder: a key the app cannot
    // send leaves it for the CLI's own key there.
    if (key.bytes === null) return notPasted('no-key')
    try {
      return fromDoor(await deps.door(sessionId, key.bytes, sentence))
    } catch {
      return notPasted('session-gone')
    }
  }

  const press = async (sessionId: string, p: PasteKeyPress): Promise<PasteKeyResult> => {
    const tab = deps.tab(sessionId)
    if (!tab) return notPasted('session-gone')
    let picture: RoutePicture | null = null
    try { picture = await deps.readPicture() } catch { picture = null }
    if (!picture || picture.isEmpty()) {
      // Q2: the text chord pastes a picture only when the clipboard holds one.
      if (p.chord === 'text') return notPasted('no-picture')
      let copied: Awaited<ReturnType<HelperRouteDeps['readCopiedImage']>>
      try { copied = await deps.readCopiedImage() } catch { copied = { error: 'no-image' } }
      if ('error' in copied) return notPasted(copied.error === 'too-large' ? 'too-large' : 'no-picture')
      picture = copied.picture
    }
    if (!tab.standIn) return notPasted('not-available')
    return send(sessionId, tab, picture, p.focused ? null : PASTE_SENTENCE)
  }

  const snap = async (sessionId: string, picture: NativeImage, sentence: string): Promise<PasteKeyResult> => {
    // Q1: the picture stays on this computer's clipboard, whichever machine.
    try {
      const written = await deps.write(picture)
      if (written !== 'written') deps.log?.(`[paste] ${sessionId}: Snap's picture was not left on this computer's clipboard (${written})`)
    } catch { /* the tab still gets it */ }
    const tab = deps.tab(sessionId)
    if (!tab) return notPasted('session-gone')
    if (!tab.standIn) return notPasted('not-available')
    return send(sessionId, tab, picture, sentence)
  }

  return {
    paste: async (sessionId, request) => {
      try {
        return 'press' in request ? await press(sessionId, request.press) : await snap(sessionId, request.snap.picture, request.snap.sentence)
      } catch {
        return notPasted('session-gone')
      }
    },
  }
}
