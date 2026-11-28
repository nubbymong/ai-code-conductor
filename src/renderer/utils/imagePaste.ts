/**
 * The renderer's half of the clipboard image paste (ADR-032 decision 4; plan
 * 2.1.3-beta.21 phase 2, 2.1.4). The renderer reports the press and applies
 * main's answer; it never sends clipboard content or a path. Main reads the
 * clipboard, writes a picture when it has to and sends the CLI's own paste
 * key (src/main/paste).
 *
 * WHICH KEYS ARE TAKEN.
 * - An agent session on this computer, or a tab through the
 *   session helper on its machine: Alt+V wherever the focus is, and Ctrl+V
 *   (Cmd+V on a Mac) when the clipboard holds no text, so main pastes a
 *   picture if it holds one (plan Q2). Text paste is unchanged (ADR-008).
 * - The partner view of a session (its partner shell on screen) and a plain
 *   terminal: Alt+V goes to the program there as a key, ESC v (plan Q3); a
 *   CLI started there by hand reads the clipboard itself. No path is typed.
 *   Ctrl+V with no text there says nothing to paste, as before.
 * - A tab on the old SSH path (plan Q9): a focused Alt+V stays xterm's, as
 *   today; only a press from outside the terminal is reported, and main
 *   answers today's fetch request; Ctrl+V with no text says nothing to paste.
 */
import { writeSessionInput } from '../components/terminal/tmuxWheelScroll'
import { usePasteHintStore } from '../stores/pasteHintStore'
import { useSessionStore } from '../stores/sessionStore'
import { hasSpawned } from '../ptyTracker'
import { PARTNER_PTY_SUFFIX } from '../../shared/multi-spawn-rule'
import { PASTE_SENTENCE, type PasteKeyResult } from '../../shared/clipboard-paste'
import { sendFetchRequestFor, pasteImageByPathRoute } from './imageTransfer'
import type { Session } from '../stores/sessionStore'

/** Alt+V as a terminal sends it: what a plain terminal or a partner shell gets. */
export const ALT_V_KEY = '\u001bv'

/** The hint for a terminal that is not running. */
export const NOT_RUNNING_NOTE = 'This terminal is not running, so nothing was typed.'

/** The facts about a session the rules read. */
export type PasteSession = Pick<Session, 'id' | 'shellOnly' | 'sessionType'> & Partial<Pick<Session, 'ptyExited' | 'neverStarted'>>

/** Where a press of Alt+V from outside the terminal goes: the program in a
 *  plain terminal or a partner shell, as a key; or main, for a Claude Code or
 *  agent session. */
export type OutsidePasteTarget = { kind: 'key'; ptyId: string; running: boolean } | { kind: 'main' }

export function outsidePasteTarget(session: PasteSession, showingPartner: boolean): OutsidePasteTarget {
  if (showingPartner) {
    const ptyId = session.id + PARTNER_PTY_SUFFIX
    return { kind: 'key', ptyId, running: hasSpawned(ptyId) }
  }
  if (session.shellOnly) return { kind: 'key', ptyId: session.id, running: !session.ptyExited && !session.neverStarted }
  return { kind: 'main' }
}

/** Whether a focused terminal's capture handler takes Alt+V, or Ctrl+V with
 *  no text, and reports it to main: an agent session on this
 *  computer, or a tab main says runs through the session helper
 *  (`throughHelper`); never a plain terminal, a partner pane, or a tab on
 *  the old SSH path. */
export function terminalTakesImagePaste(session: PasteSession | undefined, opts: { partnerPane: boolean; throughHelper: boolean }): boolean {
  if (!session || opts.partnerPane || session.shellOnly) return false
  if (session.sessionType === 'ssh') return opts.throughHelper
  return true
}

/**
 * Main's answer to a press (or to Snap's capture) applied: the hint line for
 * what was not pasted; today's fetch request for a tab on the old SSH path,
 * with `sentence`; the path route's flow on the test switch only. `textChord`:
 * the press was Ctrl+V with no text, whose "nothing to paste" the caller
 * shows itself. Returns whether the press found nothing to paste.
 */
export function applyPasteResult(sessionId: string, result: PasteKeyResult, how: { focused: boolean; textChord: boolean; sentence: string }): boolean {
  switch (result.outcome) {
    case 'pasted':
    case 'sent':
      return false
    case 'not-pasted':
      if (how.textChord && result.reason === 'no-picture') return true
      usePasteHintStore.getState().show(sessionId, result.note)
      return false
    case 'fetch':
      sendFetchRequestFor(sessionId, result.filename, how.sentence)
      return false
    case 'path-route':
      // beta.20: a focused Alt+V went to the CLI as xterm's ESC v, and
      // Ctrl+V with no text said nothing to paste.
      if (how.textChord) return true
      if (how.focused) { writeSessionInput(sessionId, ALT_V_KEY); return false }
      void pasteImageByPathRoute(sessionId, result.line)
      return false
  }
}

/** One press reported to main (paste:imageKey) and its answer applied.
 *  Resolves whether it found nothing to paste (Ctrl+V with no picture). */
export async function reportImagePaste(sessionId: string, chord: 'image' | 'text', focused: boolean): Promise<boolean> {
  const api = window.electronAPI?.paste
  if (typeof api?.imageKey !== 'function') return chord === 'text'
  let result: PasteKeyResult
  try {
    result = await api.imageKey({ sessionId, chord, focused })
  } catch {
    return chord === 'text'
  }
  return applyPasteResult(sessionId, result, { focused, textChord: chord === 'text', sentence: PASTE_SENTENCE })
}

/** Alt+V with the focus outside the terminal, for the active session. */
export function pasteImageFromOutside(sessionId: string, showingPartner: boolean): void {
  const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
  if (!session) return
  const target = outsidePasteTarget(session, showingPartner)
  if (target.kind === 'key') {
    if (!target.running) usePasteHintStore.getState().show(sessionId, NOT_RUNNING_NOTE)
    else writeSessionInput(target.ptyId, ALT_V_KEY)
    return
  }
  void reportImagePaste(sessionId, 'image', false)
}
