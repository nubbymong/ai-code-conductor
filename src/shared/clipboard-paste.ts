/**
 * Clipboard image paste (ADR-032; plan 2.1.3-beta.21 phase 2): what the
 * renderer reports when the image paste key is pressed in a session, what
 * main answers, and the words the paste hint shows. Shared by main and the
 * renderer; pure.
 *
 * Every picture goes in through the CLI's own clipboard paste: main writes
 * the picture to this computer's clipboard only when the clipboard does not
 * already hold what the CLI reads, then sends the CLI's own paste key as one
 * write. No file path is typed or pasted into any session (ADR-032 decision
 * 1). The one exception is the path route behind the test switch
 * (pathRouteOn in src/main/paste), kept for this beta only so the proof can
 * run both routes in one job, and refused by a packaged app.
 */

/** The renderer's report of one press (paste:imageKey). It carries no
 *  clipboard content and no path: main reads the clipboard itself. */
export interface PasteKeyPress {
  sessionId: string
  /** `image`: the image paste shortcut (Alt+V by default). `text`: the text
   *  paste chord (Ctrl+V, Cmd+V) pressed while the clipboard held no text,
   *  so main pastes a picture only when the clipboard holds one (ADR-032
   *  decision 4; plan Q2). */
  chord: 'image' | 'text' | 'snap'
  /** Whether the session's terminal had the keyboard focus. A press in the
   *  terminal types nothing after the key (the user is writing); a press
   *  from outside it types the sentence and Enter once the CLI shows its
   *  placeholder (ADR-032 decision 3). Snap is always from outside. */
  focused: boolean
  /** Snap only (plan 2.1.5): the token Snap's capture answered for the
   *  picture main keeps (never a path), and which item took it. */
  snap?: { token: string; item: SnapItem }
}

/** Which of Snap's two items took a picture (its sentence). */
export type SnapItem = 'rectangle' | 'window'

/** Why a picture was not pasted. */
export type PasteNotPastedReason =
  /** No picture on the clipboard, nor a copied image file. */
  | 'no-picture'
  /** A copied image file over the cap. */
  | 'too-large'
  /** The CLI showed no placeholder within the wait. */
  | 'no-placeholder'
  /** The sentence after the placeholder was not sent (the picture is at the prompt). */
  | 'sentence-not-sent'
  /** The CLI was not at a composer that takes a paste within the wait. */
  | 'busy'
  /** The session's key cannot be sent (an account binding the app cannot express). */
  | 'no-key'
  /** This computer's clipboard could not be written. */
  | 'not-written'
  /** The route for this kind of session is not in this beta. */
  | 'not-available'
  /** The session has no terminal, or its run ended. */
  | 'session-gone'

/** Main's answer to one press, and to Snap's capture. */
export type PasteKeyResult =
  /** The key went and the CLI showed its placeholder; nothing more was typed
   *  (a press in the terminal). */
  | { outcome: 'pasted' }
  /** The key went, the placeholder showed, then the sentence and Enter. */
  | { outcome: 'sent' }
  /** Nothing was pasted, or the picture is at the prompt and was not sent:
   *  `note` is the paste hint's line. */
  | { outcome: 'not-pasted'; reason: PasteNotPastedReason; note: string }
  /** A tab on the old SSH path (ADR-032 decision 9): main saved the picture
   *  in the shared screenshots folder; the renderer types today's request
   *  naming that file for the host fetch tool (never its path). */
  | { outcome: 'fetch'; filename: string }
  /** The test switch's path route only (never in a packaged app): the
   *  renderer runs beta.20's path flow, by the session's own image line. */
  | { outcome: 'path-route'; line: 'enter' | 'composer' | null }

/** What Snap's capture answers once it has a picture (plan 2.1.5): a token
 *  for the picture main keeps, never its path. The renderer then reports the
 *  Snap on the one paste channel with that token (chord 'snap'), so the Snap
 *  button is usable again as soon as the capture ends, while the paste runs. */
export interface SnapPasteAnswer {
  snapToken: string
}

/** Snap's answer on the path route behind the test switch only (never in a
 *  packaged app): the saved file and the session's image line, for
 *  2.1.3-beta.20's path flow. */
export interface SnapPathRouteAnswer {
  pathRoute: { file: string; line: 'enter' | 'composer' | null }
}

/** Whether a capture answer is the path route's. */
export function isSnapPathRouteAnswer(answer: unknown): answer is SnapPathRouteAnswer {
  if (!answer || typeof answer !== 'object') return false
  const route = (answer as { pathRoute?: unknown }).pathRoute
  return !!route && typeof route === 'object' && typeof (route as { file?: unknown }).file === 'string'
}

/** Whether a capture answer is Snap's token for its picture. */
export function isSnapPasteAnswer(answer: unknown): answer is SnapPasteAnswer {
  if (!answer || typeof answer !== 'object') return false
  const token = (answer as { snapToken?: unknown }).snapToken
  return typeof token === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(token)
}

/** The sentence a press from outside the terminal sends after the picture. */
export const PASTE_SENTENCE = 'I just pasted an image, please view it.'
/** Snap's sentences, Rectangle's and Window's. */
export const SNAP_RECTANGLE_SENTENCE = 'I just snapped a region of my screen, please view it.'
export const SNAP_WINDOW_SENTENCE = 'I just captured a window from my screen, please view it.'

/** The paste hint's lines (ADR-032 decision 6: what a CLI does not take is
 *  reported, never typed; no path). */
export const PASTE_NOTES: Readonly<Record<PasteNotPastedReason, string>> = {
  'no-picture': 'No image in clipboard: copy an image or an image file, then press Alt+V.',
  'too-large': 'Image too large to paste (max 10 MB).',
  'no-placeholder': 'The picture is on the clipboard, but the session did not show it. Press Alt+V in the session to paste it.',
  'sentence-not-sent': 'The picture is at the prompt and was not sent. Press Enter in the session to send it.',
  busy: 'The session was busy, so nothing was pasted. The picture is on the clipboard: press Alt+V in the session.',
  'no-key': 'The picture is on the clipboard. Press Claude Code\'s image paste key in the session to paste it.',
  'not-written': 'The picture could not be put on the clipboard, so nothing was pasted.',
  'not-available': 'Image paste into this session is not available yet.',
  'session-gone': 'This session is not running, so nothing was pasted.',
}

/** A result that pasted nothing, with its hint line. */
export function notPasted(reason: PasteNotPastedReason): PasteKeyResult {
  return { outcome: 'not-pasted', reason, note: PASTE_NOTES[reason] }
}
