// The Claude Code package's run screen (2.1.3-beta.18 section 4,
// aicc_planning#432; ADR-030 component rows 3 and 14): how each door of the
// session input module types into a Claude Code session, on this computer,
// held by the session helper, or over SSH. These were the module's own
// rules, typed for every session that was not Codex; they moved here as they
// were (every byte, its order and its timing as the module typed them), and
// the module now types them only for a session this package runs.
//
// Main reads no Claude Code screen (S13): `has` is false; open, feed, resize
// and close do nothing (the PTY manager opens a pane for a Codex run only);
// there is no `submit`, and no Ask member (Ask Conductor runs on Codex).
// Each member types only through the run its door hands it (RunScreenTyping,
// the module's write port), never through the PTY manager.
import type { RunScreenImageResult, RunScreenTyping, SessionRunScreen } from '../types'
import type { PromptButtonResult } from '../../../shared/types'
import { queueClaudeMarkerLine } from '../../canvas/claude-marker-typing'

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

/**
 * The Watchdog's retry: the line and Enter in one write, after the tmux
 * leave key on an SSH Persistent session (#85: the wheel opens tmux's
 * scrollback view there, and copy-mode would swallow the retry; outside it
 * the key does nothing), typed at once, as the Watchdog decides. It answers
 * nothing. These are the bytes the module's submitLine typed until
 * 2.1.3-beta.18 section 4, byte for byte.
 */
function retryClaudeLine(text: string, typing: RunScreenTyping): void {
  typing.write(`${typing.leave}${text}\r`)
}

/**
 * A command bar prompt button's Send (#333): the text, then Enter as its own
 * write `enterDelayMs` after the text's last slice went, and only while the
 * run is still the one the text went to; on an SSH Persistent session the
 * Enter's write starts with the leave key too. The Enter never rides in the
 * text's write: #333 reports a session on this computer where such a write
 * was typed and not sent.
 */
async function sendClaudePrompt(text: string, opts: { enterDelayMs: number }, typing: RunScreenTyping): Promise<PromptButtonResult> {
  const data = `${typing.leave}${text}`
  typing.write(data)
  await typing.settled(data, opts.enterDelayMs)
  if (!typing.live()) return { outcome: 'not-sent', reason: 'session-gone' }
  // Its own write, with the leave key again: the wheel may have opened
  // tmux's scrollback since the text went, and copy-mode would take a bare
  // Enter. Outside copy-mode the key does nothing.
  typing.write(`${typing.leave}\r`)
  return { outcome: 'sent' }
}

/**
 * An Agent Canvas marker: held, in the order handed in, and typed only when
 * the session's own screen reads Claude Code's ready, empty prompt, by the
 * same reading the status strip's controls type through
 * (canvas/claude-marker-typing.ts, which has the renderer type it), and only
 * into the run it was handed for. It answers nothing: a marker the chain
 * drops untyped is told to its canvas by the chain itself.
 */
function holdClaudeMarker(sessionId: string, line: string, canvasId: string | undefined, typing: RunScreenTyping): void {
  queueClaudeMarkerLine(sessionId, line, () => typing.live(), canvasId)
}

/**
 * A saved image (2.1.3-beta.16 X1.2, aicc_planning#405), as Claude Code's
 * own paste: probe P11 found Claude Code attaches a path it gets as a
 * bracketed paste, and reads a path typed as text only as words. So the path
 * goes in as a bracketed paste (ESC [200~ path ESC [201~), then, `settleMs`
 * after it went, a space and the sentence, then, `enterDelayMs` after that,
 * Enter, each its own write, and each only while the run is still the one
 * the door was asked for.
 */
async function pasteClaudeImage(imagePath: string, sentence: string, opts: { settleMs: number; enterDelayMs: number }, typing: RunScreenTyping): Promise<RunScreenImageResult> {
  const gone: RunScreenImageResult = { pasted: false, reason: 'session-gone', left: false }
  if (!typing.live()) return gone
  const paste = `${PASTE_START}${imagePath}${PASTE_END}`
  typing.write(paste)
  await typing.settled(paste, opts.settleMs)
  if (!typing.live()) return gone
  const words = ` ${sentence}`
  typing.write(words)
  await typing.settled(words, opts.enterDelayMs)
  if (!typing.live()) return gone
  typing.write('\r')
  return { pasted: true }
}

/** The Claude Code package's run screen (SessionProvider.runScreen). */
export const CLAUDE_RUN_SCREEN: SessionRunScreen = {
  open: () => {},
  feed: () => {},
  resize: () => {},
  close: () => {},
  has: () => false,
  retry: (_sessionId, text, _opts, typing) => retryClaudeLine(text, typing),
  prompt: (_sessionId, text, opts, typing) => sendClaudePrompt(text, opts, typing),
  marker: (sessionId, line, opts, typing) => holdClaudeMarker(sessionId, line, opts.canvasId, typing),
  image: (_sessionId, imagePath, sentence, opts, typing) => pasteClaudeImage(imagePath, sentence, opts, typing),
}
