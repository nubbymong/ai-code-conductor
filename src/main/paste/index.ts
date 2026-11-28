// The paste module (ADR-032, ADR-030 component row 8; plan 2.1.3-beta.21
// phase 2, 2.1.1; aicc_planning#447): whether a press is an image paste,
// what must be written to this computer's clipboard, and which key the CLI
// gets. Every picture goes in through the CLI's own clipboard paste; no path
// is typed or pasted into any session.
//
// ONE OWNER PER JOB (ADR-032 decision 7). This module reads what the
// clipboard holds (a picture, a copied file, text) and decides from the
// session's provider table (row 14, SessionProvider.clipboardPaste) whether
// to write; the writer (./clipboard-writer.ts) writes only when needed; the
// session input module's door (row 3, pasteFromClipboard) sends the key.
// The renderer (row 2) only reports the press (paste:imageKey) and never
// sends clipboard content or a path; Snap's capture in main hands its
// picture here itself (pasteSnapPicture).
//
// WHEN IT WRITES (ADR-032 decision 2). A picture already on the clipboard:
// nothing. A copied image file: nothing when the CLI reads copied files
// itself (Codex on Windows and macOS), else its picture. Snap: always its
// picture, which stays on the clipboard afterwards (plan Q1) whichever
// machine the session runs on.
//
// BY KIND OF SESSION.
// - On this computer, a Claude Code or Codex session: the CLI's own paste
//   (above).
// - A tab on the old SSH path (ADR-032 decision 9, plan Q9): a press from
//   outside the terminal saves the picture in the shared screenshots folder
//   as 2.1.3-beta.20 did (CLIPBOARD_SAVE_IMAGE's body) and answers `fetch`,
//   so the renderer types today's request naming that file for the host
//   fetch tool, never its path. A press in the terminal is not reported
//   there (xterm's, as today).
// - A tab through the session helper on its machine: the remote route
//   (file.put, then the key) is plan phase 5's. It registers here through
//   setRemotePasteRoute. Until it does, a press from outside the terminal
//   and Snap get the old path's request, as in 2.1.3-beta.20, and a press in
//   the terminal says image paste there is not available yet.
// - A plain terminal or a partner shell: not reported (the renderer sends
//   Alt+V to the program there as a key, plan Q3).
//
// THE PATH ROUTE (plan Q5). The 2.1.3-beta.20 route stays for this beta
// only, behind a test switch that only an unpackaged run reads
// (pathRouteOn: app.isPackaged false and CCC_E2E_PATH_ROUTE=1), so the C2
// proof can run both routes in one job. The installed beta never takes it.
// It is deleted in 2.1.3-beta.22.
import { nativeImage, type NativeImage } from 'electron'
import { basename } from 'path'
import type { ProviderId } from '../../shared/types'
import type { ClipboardPasteRule } from '../providers/types'
import { tryGetProvider } from '../providers'
import { notPasted, PASTE_SENTENCE, type PasteKeyPress, type PasteKeyResult } from '../../shared/clipboard-paste'
import { pasteFromClipboard, providerOfSession, type ClipboardPasteDoorResult } from '../session-input'
import { readClipboardImageWithRetry } from '../clipboard-image'
import { readClipboardFilePaths, pickPasteableImage, type PasteableImage } from '../clipboard-file'
import { writeClipboardPicture, type ClipboardWriteResult } from './clipboard-writer'
import { logInfo } from '../debug-logger'
import { pathRouteOn } from './path-route'
import { statSync } from 'fs'

/** Where a session's CLI runs, as main's own records say. */
export type PasteSessionWhere = 'local' | 'helper' | 'ssh'

export { pathRouteOn }

/** The picture the old SSH path saves for its fetch request
 *  (CLIPBOARD_SAVE_IMAGE's body), or why there is none. */
export type SavedPicture = PasteableImage

/** Plan phase 5's remote route for a tab through the session helper: the
 *  picture to the session's holder by file.put, then the key. `picture` is
 *  Snap's, or null for a press (the route reads this computer's clipboard
 *  itself). */
export interface RemotePasteRoute {
  paste(sessionId: string, request: { press: PasteKeyPress } | { snap: { picture: NativeImage; sentence: string } }): Promise<PasteKeyResult>
}

/** What the module reads, writes and asks; the IPC layer registers the real
 *  ones (src/main/ipc/paste-handlers.ts), a test hands fakes. */
export interface PasteDeps {
  platform: NodeJS.Platform
  /** Where the session's CLI runs, or null: no such session. */
  where(sessionId: string): PasteSessionWhere | null
  /** The provider whose CLI the session runs, or null (a plain shell). */
  provider(sessionId: string): ProviderId | null
  /** That provider's clipboard paste table (row 14). */
  rule(id: ProviderId): ClipboardPasteRule | undefined
  /** The config folder the session's launch gave its CLI (its account's own;
   *  null on this computer's own sign-in), so the table reads that account's
   *  own keybindings. */
  accountDir(sessionId: string): string | null
  /** The picture on the clipboard (retried for Windows' delayed render), or null. */
  readPicture(): Promise<NativeImage | null>
  /** The files copied to the clipboard (Windows and macOS), or none. */
  readFiles(): Promise<string[]>
  /** A file's size, or null when it is gone or not a plain file. */
  fileSize(path: string): number | null
  /** A copied image file's picture, or null when it does not decode. */
  decodeFile(path: string): NativeImage | null
  /** Write a picture onto this computer's clipboard. */
  write(picture: NativeImage): Promise<ClipboardWriteResult>
  /** The old SSH path's saved picture (CLIPBOARD_SAVE_IMAGE's body). */
  savePicture(): Promise<SavedPicture>
  /** The session input module's door. */
  door(sessionId: string, key: string, sentence: string | null): Promise<ClipboardPasteDoorResult>
  /** The test switch. */
  pathRoute(): boolean
}

const realDeps = (): PasteDeps => ({
  platform: process.platform,
  where: () => null,
  provider: (sessionId) => providerOfSession(sessionId),
  rule: (id) => tryGetProvider(id)?.clipboardPaste,
  accountDir: () => null,
  readPicture: () => readClipboardImageWithRetry(),
  readFiles: () => readClipboardFilePaths(),
  fileSize: (path) => {
    try {
      const st = statSync(path)
      return st.isFile() ? st.size : null
    } catch { return null }
  },
  decodeFile: (path) => {
    try {
      const img = nativeImage.createFromPath(path)
      return img.isEmpty() ? null : img
    } catch { return null }
  },
  write: (picture) => writeClipboardPicture(picture),
  savePicture: async () => ({ error: 'no-image' }),
  door: (sessionId, key, sentence) => pasteFromClipboard(sessionId, key, sentence),
  pathRoute: () => pathRouteOn(),
})

let deps: PasteDeps = realDeps()
let remoteRoute: RemotePasteRoute | null = null

/** The IPC layer's registration: where a session runs (the PTY manager's and
 *  the remote helper's records) and the old SSH path's save. */
export function setPasteDeps(partial: Partial<PasteDeps>): void {
  deps = { ...deps, ...partial }
}

/** Test seam: back to the real reads and writes. */
export function _resetPasteForTest(): void {
  deps = realDeps()
  remoteRoute = null
}

/** Plan phase 5: the remote route for tabs through the session helper. */
export function setRemotePasteRoute(route: RemotePasteRoute | null): void {
  remoteRoute = route
}

/** What the clipboard holds, for a paste. */
type Holds =
  | { kind: 'picture' }
  | { kind: 'file'; path: string }
  | { kind: 'none'; reason: 'no-picture' | 'too-large' }

async function clipboardHolds(): Promise<Holds> {
  let picture: NativeImage | null = null
  try { picture = await deps.readPicture() } catch { picture = null }
  if (picture && !picture.isEmpty()) return { kind: 'picture' }
  let files: string[] = []
  try { files = await deps.readFiles() } catch { files = [] }
  const picked = pickPasteableImage(files, (p) => deps.fileSize(p))
  if ('path' in picked) return { kind: 'file', path: picked.path }
  return { kind: 'none', reason: picked.error === 'too-large' ? 'too-large' : 'no-picture' }
}

/** The door's answer as the press's. */
function fromDoor(result: ClipboardPasteDoorResult): PasteKeyResult {
  switch (result.outcome) {
    case 'sent': return { outcome: 'sent' }
    case 'placeholder': return { outcome: 'pasted' }
    case 'no-placeholder': return notPasted('no-placeholder')
    case 'busy': return notPasted('busy')
    case 'sentence-not-sent': return notPasted('sentence-not-sent')
    case 'session-gone': return notPasted('session-gone')
    case 'refused-key': return notPasted('no-key')
    default: return notPasted('not-available')
  }
}

/** The key for `sessionId`'s CLI by its table, then the door. */
async function sendKey(sessionId: string, rule: ClipboardPasteRule, sentence: string | null): Promise<PasteKeyResult> {
  let accountDir: string | null = null
  try { accountDir = deps.accountDir(sessionId) } catch { accountDir = null }
  const key = rule.key({ platform: deps.platform, accountDir })
  if (key.bytes === null) return notPasted('no-key')
  return fromDoor(await deps.door(sessionId, key.bytes, sentence))
}

function validPress(press: unknown): press is PasteKeyPress {
  if (!press || typeof press !== 'object') return false
  const p = press as Record<string, unknown>
  return typeof p.sessionId === 'string' && p.sessionId.length > 0 && p.sessionId.length <= 200
    && (p.chord === 'image' || p.chord === 'text') && typeof p.focused === 'boolean'
}

/** The old SSH path's request: the picture saved, its file named. */
async function fetchAnswer(): Promise<PasteKeyResult> {
  let saved: SavedPicture
  try { saved = await deps.savePicture() } catch { saved = { error: 'no-image' } }
  if ('path' in saved) return { outcome: 'fetch', filename: basename(saved.path) }
  return notPasted(saved.error === 'too-large' ? 'too-large' : 'no-picture')
}

function logged(sessionId: string, what: string, result: PasteKeyResult): PasteKeyResult {
  logInfo(`[paste] ${sessionId}: ${what}: ${result.outcome}${result.outcome === 'not-pasted' ? ` (${result.reason})` : ''}`)
  return result
}

/**
 * One press of the image paste key, or of the text paste chord with no text
 * on the clipboard (paste:imageKey). Never rejects; the log names no picture
 * and no path.
 */
export async function pasteImageKey(press: PasteKeyPress): Promise<PasteKeyResult> {
  if (!validPress(press)) return notPasted('session-gone')
  const { sessionId, chord, focused } = press
  const what = `${chord === 'image' ? 'the image paste key' : 'the text paste chord'} ${focused ? 'in the terminal' : 'from outside the terminal'}`
  try {
    const where = deps.where(sessionId)
    if (where === null) return logged(sessionId, what, notPasted('session-gone'))
    if (where === 'ssh') {
      // Q9: only a press from outside the terminal is the fetch request.
      if (focused || chord === 'text') return logged(sessionId, what, notPasted('no-picture'))
      return logged(sessionId, what, await fetchAnswer())
    }
    if (where === 'helper') {
      if (remoteRoute) return logged(sessionId, what, await remoteRoute.paste(sessionId, { press }))
      // Until phase 5's route: the text chord says nothing to paste, as
      // before; Alt+V in the terminal says image paste is not available yet.
      if (chord === 'text') return logged(sessionId, what, notPasted('no-picture'))
      if (focused) return logged(sessionId, what, notPasted('not-available'))
      return logged(sessionId, what, await fetchAnswer())
    }
    const provider = deps.provider(sessionId)
    const rule = provider ? deps.rule(provider) : undefined
    if (!provider || !rule) return logged(sessionId, what, notPasted('not-available'))
    if (deps.pathRoute()) return logged(sessionId, what, { outcome: 'path-route', line: rule.pathRouteLine })
    const holds = await clipboardHolds()
    if (holds.kind === 'none') return logged(sessionId, what, notPasted(holds.reason))
    // Q2: the text chord pastes a picture only when the clipboard holds one.
    if (chord === 'text' && holds.kind !== 'picture') return logged(sessionId, what, notPasted('no-picture'))
    if (holds.kind === 'file' && !rule.readsCopiedFile(deps.platform)) {
      const picture = deps.decodeFile(holds.path)
      if (!picture) return logged(sessionId, what, notPasted('no-picture'))
      const written = await deps.write(picture)
      if (written !== 'written') return logged(sessionId, what, notPasted(written === 'not-yet' ? 'not-available' : 'not-written'))
    }
    return logged(sessionId, what, await sendKey(sessionId, rule, focused ? null : PASTE_SENTENCE))
  } catch {
    return logged(sessionId, what, notPasted('session-gone'))
  }
}

/** The image line of the provider that runs `sessionId`, for Snap's path
 *  route behind the test switch (null: not a session on this computer). */
export function pathRouteLineOf(sessionId: string): 'enter' | 'composer' | null {
  try {
    if (deps.where(sessionId) !== 'local') return null
    const provider = deps.provider(sessionId)
    return (provider ? deps.rule(provider)?.pathRouteLine : undefined) ?? null
  } catch { return null }
}

/** Snap's answer on an app machine whose writer is not in this beta yet
 *  (plan s6: macOS and Linux until plan 3.1). */
export const SNAP_NOT_AVAILABLE_NOTE = 'Snap into a session is not available on this computer in this beta.'

/**
 * Snap's picture (plan 2.1.5): main's capture hands it here with its saved
 * file (kept in the shared screenshots folder for the C2 proof and the tool
 * route, declared exception 13 as ADR-032 amends it). The picture goes onto
 * this computer's clipboard (plan Q1, whichever machine the session runs
 * on), then: a session on this computer gets its CLI's key, then the
 * sentence and Enter; a tab on the old SSH path, and a helper tab until plan
 * phase 5's route lands, the request naming the saved file (`fetch`). The
 * renderer is sent no path. Never rejects.
 */
export async function pasteSnapPicture(sessionId: string, picture: NativeImage, file: string, sentence: string): Promise<PasteKeyResult> {
  const what = 'Snap'
  try {
    const where = deps.where(sessionId)
    if (where === null) return logged(sessionId, what, notPasted('session-gone'))
    if (where === 'helper' && remoteRoute) return logged(sessionId, what, await remoteRoute.paste(sessionId, { snap: { picture, sentence } }))
    const written = await deps.write(picture)
    if (where !== 'local') return logged(sessionId, what, { outcome: 'fetch', filename: basename(file) })
    if (written === 'not-yet') return logged(sessionId, what, { outcome: 'not-pasted', reason: 'not-available', note: SNAP_NOT_AVAILABLE_NOTE })
    if (written !== 'written') return logged(sessionId, what, notPasted('not-written'))
    const provider = deps.provider(sessionId)
    const rule = provider ? deps.rule(provider) : undefined
    if (!provider || !rule) return logged(sessionId, what, notPasted('not-available'))
    return logged(sessionId, what, await sendKey(sessionId, rule, sentence))
  } catch {
    return logged(sessionId, what, notPasted('session-gone'))
  }
}
