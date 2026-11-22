/**
 * A per-session registry of terminal screen readers (P3.8 round 1).
 *
 * The status strip and the command bar type an agent CLI's command (/compact,
 * /model, /plan) only into that CLI's ready composer, and TerminalView, which
 * owns the xterm instance, is elsewhere in the tree: a module-level map keyed
 * by session id connects them, as repaintRegistry does for repaints. A reader
 * returns the live screen (the rows below the scrollback), each row as its
 * text and its text with the dim cells blanked, so a placeholder drawn dim is
 * told apart from what the user typed.
 */

// P3.10: the row shape and the xterm reader live in src/shared/codex-screen.ts
// (the Watchdog reads its headless pane the same way); re-exported here.
import type { ScreenLine } from '../../../shared/codex-screen'
import { currentSpawnToken } from '../../ptyTracker'
export type { ScreenLine, XtermLike } from '../../../shared/codex-screen'
export { readXtermScreen } from '../../../shared/codex-screen'

export type ScreenReader = () => ScreenLine[] | null
/** 2.1.3-beta.13 B2 (aicc_planning#370): a terminal's window title now, null
 *  when it has none (while a turn runs Codex puts a braille spinner at the
 *  start of it: codexTitleBusy). */
export type TitleReader = () => string | null

interface Registration { screen: ScreenReader; title?: TitleReader }
const readers = new Map<string, Registration>()

/** Register a terminal's reader, and (B2) its title reader. Returns the
 *  unregister function, which only removes THIS registration (a remount's
 *  newer reader is kept). */
export function registerScreenReader(sessionId: string, reader: ScreenReader, title?: TitleReader): () => void {
  const registration: Registration = { screen: reader, title }
  readers.set(sessionId, registration)
  return () => {
    if (readers.get(sessionId) === registration) readers.delete(sessionId)
  }
}

/** The session's live screen, or null when it has no terminal. Never throws. */
export function readSessionScreen(sessionId: string): ScreenLine[] | null {
  const reader = readers.get(sessionId)
  if (!reader) return null
  try { return reader.screen() } catch { return null }
}

/** B2: the session's window title, or null when it has no terminal, its
 *  terminal keeps no title, or it has none now. Never throws. */
export function readSessionTitle(sessionId: string): string | null {
  const title = readers.get(sessionId)?.title
  if (!title) return null
  try {
    const t = title()
    return typeof t === 'string' ? t : null
  } catch { return null }
}

/** B2: keep the last window title `term`'s output sets, for the session's
 *  run that set it: the reader answers it while that run (its spawn token) is
 *  still the session's current one, and null once another spawn has replaced
 *  it or the session has none, so a title never outlives its run. A terminal
 *  with no title events (a test's stand-in) keeps none. */
export function keepTerminalTitle(sessionId: string, term: { onTitleChange?: (listener: (title: string) => void) => unknown }): TitleReader {
  let last: { title: string; run: number | undefined } | null = null
  term.onTitleChange?.((title) => { last = { title, run: currentSpawnToken(sessionId) } })
  return () => {
    const run = currentSpawnToken(sessionId)
    return last !== null && run !== undefined && last.run === run ? last.title : null
  }
}
