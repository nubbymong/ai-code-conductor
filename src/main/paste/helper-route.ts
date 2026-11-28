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
// ONE PICTURE AT A TIME PER TAB. The session keeps one current picture (the
// stand-in serves the last one file.put stored), so a tab's sends go one
// after another: the next picture is sent only once the last key's wait is
// over, by when the CLI has read its picture. Another tab is not held up.
//
// WHAT IT NEVER DOES. No path, no file name and no host text is typed into
// the session: file.put's reply carries a name and a hash only, and neither
// reaches the door. What the CLI does not take is reported in the paste hint;
// a hint after the picture was sent names the session's machine, not this
// computer's clipboard (after Alt+V of a copied file the picture is only
// there).
//
// NOT AVAILABLE YET. A tab whose CLI the stand-in does not serve (its launch
// did not ask, the host is not Linux, or the stand-in was not written there:
// the plan's s5 fallback until probe PR1 passes on a host) answers "not
// available yet", and so does a launch that gave no key; nothing is sent and
// nothing typed. That covers a helper tab of a CLI whose remote launch asks
// for no stand-in (plan Q7: the second CLI's remote sessions come in
// 2.1.3-beta.24, after probe PR2), and an attach to a session kept for the
// tab after the app restarts, whose start wrote no stand-in (the remote
// helper's remoteTabPaste). A tab on the old SSH path never reaches this
// route (plan Q9: the paste module keeps today's fetch request for it).
//
// THE WINDOWS APP ONLY, IN THIS BETA. The remote route from a macOS or Linux
// app comes in 2.1.3-beta.23 (plan s4, with the real-Mac paste check): there
// a press answers "not available yet", and Snap leaves its picture on this
// computer's clipboard (Q1) and answers the same; nothing is sent or typed.
//
// Pure of Electron (its picture is the few calls of a NativeImage it uses),
// so the remote-helper-e2e job runs it under plain Node against a real host
// (tests/live/remote-paste.live.ts).
import type { NativeImage } from 'electron'
import { notPasted, PASTE_SENTENCE, type PasteKeyPress, type PasteKeyResult, type PasteNotPastedReason } from '../../shared/clipboard-paste'
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
  /** The platform the app runs on: the route serves the Windows app only in
   *  this beta (plan s4: a macOS or Linux app's comes in 2.1.3-beta.23). */
  platform: NodeJS.Platform
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

/** The paste hint's lines this route adds (ADR-032 decision 6: reported, never
 *  typed). The paste module's own (PASTE_NOTES) say the picture is on this
 *  computer's clipboard, which after a helper tab's Alt+V of a copied image
 *  file it is not: these name the session's machine instead. */
export const HELPER_TOO_LARGE_NOTE = `Image too large to send to the session's machine (max ${PASTE_PICTURE_MAX / (1024 * 1024)} MB).`
export const HELPER_NOT_CONNECTED_NOTE = 'This tab is not connected to its machine right now, so nothing was pasted. Try again once it is back.'
export const HELPER_NOT_SENT_NOTE = 'The picture could not be sent to the session\'s machine, so nothing was pasted.'
export const HELPER_NO_PLACEHOLDER_NOTE = 'The picture was sent to the session\'s machine, but the session did not show it. Press Alt+V in the session to paste it.'
export const HELPER_NO_KEY_NOTE = 'The picture was sent to the session\'s machine. Press Claude Code\'s image paste key in the session to paste it.'
export const HELPER_BUSY_NOTE = 'The session was busy, so nothing was pasted. Press Alt+V in the session to try again.'

const noteOf = (reason: PasteNotPastedReason, note: string): PasteKeyResult => ({ outcome: 'not-pasted', reason, note })

/** The door's answer as the press's, with this route's own hint where the
 *  paste module's names this computer's clipboard. */
function fromHelperDoor(result: ClipboardPasteDoorResult): PasteKeyResult {
  const r = fromDoor(result)
  if (r.outcome !== 'not-pasted') return r
  switch (r.reason) {
    case 'no-placeholder': return noteOf('no-placeholder', HELPER_NO_PLACEHOLDER_NOTE)
    case 'no-key': return noteOf('no-key', HELPER_NO_KEY_NOTE)
    case 'busy': return noteOf('busy', HELPER_BUSY_NOTE)
    default: return r
  }
}

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
    case 'busy': return { result: noteOf('busy', HELPER_BUSY_NOTE), code }
    default: return { result: noteOf('not-written', HELPER_NOT_SENT_NOTE), code: /^[a-z-]{1,24}$/.test(code) ? code : 'error' }
  }
}

/** The helper tab's route (RemotePasteRoute). Never rejects. */
export function helperPasteRoute(deps: HelperRouteDeps): RemotePasteRoute {
  /** Each tab's last send, which its next one waits for. */
  const turns = new Map<string, Promise<void>>()
  /** `run` once the tab's earlier sends are over, whatever they answered. */
  const inTurn = (sessionId: string, run: () => Promise<PasteKeyResult>): Promise<PasteKeyResult> => {
    const mine = (turns.get(sessionId) ?? Promise.resolve()).then(run)
    const over = mine.then(() => undefined, () => undefined)
    turns.set(sessionId, over)
    void over.then(() => { if (turns.get(sessionId) === over) turns.delete(sessionId) })
    return mine
  }

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
    if (key.bytes === null) return noteOf('no-key', HELPER_NO_KEY_NOTE)
    try {
      return fromHelperDoor(await deps.door(sessionId, key.bytes, sentence))
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
    // Plan s4: the remote route from a macOS or Linux app comes in
    // 2.1.3-beta.23. After the tab and the clipboard reads, so a press with
    // nothing to paste, or into a tab that is gone, answers as it does on
    // Windows (phase 5 review 2, R2-1).
    if (deps.platform !== 'win32') return notPasted('not-available')
    if (!tab.standIn) return notPasted('not-available')
    const taken = picture
    return inTurn(sessionId, () => send(sessionId, tab, taken, p.focused ? null : PASTE_SENTENCE))
  }

  const snap = async (sessionId: string, picture: NativeImage, sentence: string): Promise<PasteKeyResult> => {
    // Q1: the picture stays on this computer's clipboard, whichever machine.
    try {
      const written = await deps.write(picture)
      if (written !== 'written') deps.log?.(`[paste] ${sessionId}: Snap's picture was not left on this computer's clipboard (${written})`)
    } catch { /* the tab still gets it */ }
    // Plan s4: the remote route from a macOS or Linux app comes in 2.1.3-beta.23.
    if (deps.platform !== 'win32') return notPasted('not-available')
    const tab = deps.tab(sessionId)
    if (!tab) return notPasted('session-gone')
    if (!tab.standIn) return notPasted('not-available')
    return inTurn(sessionId, () => send(sessionId, tab, picture, sentence))
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
