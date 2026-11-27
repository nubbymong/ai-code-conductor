// The Claude Code package's run screen (2.1.3-beta.18 section 4,
// aicc_planning#432; ADR-030 component rows 3 and 14): how each door of the
// session input module types into a Claude Code session, on this computer,
// held by the session helper, or over SSH. These were the module's own
// rules, typed for every session that was not Codex; they moved here as they
// were (every byte, its order and its timing as the module typed them), and
// the module now types them only for a session this package runs. (Since PR
// 763 fix round 9 the retry's Enter is its own write in every tab: see
// retryClaudeLine.)
//
// Main reads no Claude Code screen (S13): `has` is false; open, feed and
// resize do nothing, and close only forgets the session's last retry (the
// PTY manager opens a pane for a Codex run only);
// there is no `submit`, and no Ask member (Ask Conductor runs on Codex).
// Each member types only through the run its door hands it (RunScreenTyping,
// the module's write port), never through the PTY manager.
import type { RunScreenImageResult, RunScreenTyping, SessionRunScreen } from '../types'
import type { PromptButtonResult } from '../../../shared/types'
import { queueClaudeMarkerLine } from '../../canvas/claude-marker-typing'
import { PROMPT_ENTER_DELAY_MS, REPEAT_WINDOW_MS } from '../../session-input/enter-delay'

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

/** Each session's last retry, for the repeat window (REPEAT_WINDOW_MS, the
 *  window of the PTY manager's duplicate guard, which caught a repeated line
 *  and Enter while they went in one write; dropped at close). */
const lastRetry = new Map<string, { text: string; at: number }>()

/**
 * The Watchdog's retry, typed at once, as the Watchdog decides: the line,
 * then Enter as its own write `enterDelayMs` after the line's last slice
 * went, and only while the run is still the one the line went to, as a
 * prompt button's Send goes (below). On an SSH Persistent session both
 * writes start with the tmux leave key (#85: the wheel opens tmux's
 * scrollback view there, and copy-mode would swallow the retry; outside it
 * the key does nothing). It answers nothing.
 *
 * Why the Enter goes apart: Claude Code (2.1.332 measured through the session
 * helper, 2.1.330 on Windows) takes a control character as a key only in a
 * read shorter than 64 characters, so a line and its Enter in one write that
 * reached it as one read was typed and not sent. The 2.1.3-beta.18 fix round
 * split a tab through the session helper on its machine (`typing.wholeWrites`,
 * whose holder writes each write whole); PR 763 fix round 9 split every tab,
 * after a local Windows tab took an 85-character retry message as one read
 * (the 2.1.3-beta.19 release smoke re-read): three retries piled up unsent in
 * its input box. Until then every other tab got the line and Enter in one
 * write, the bytes the module's submitLine typed until 2.1.3-beta.18 section 4.
 *
 * The same text asked again within REPEAT_WINDOW_MS is dropped: the
 * line alone is not a submitted write, so the PTY manager's duplicate guard
 * no longer sees it, and two lines then one Enter would send them joined.
 * The line's write is made at once, so one that throws still throws to the
 * Watchdog; an Enter that cannot go is dropped, as the session is gone.
 */
function retryClaudeLine(sessionId: string, text: string, opts: { enterDelayMs: number }, typing: RunScreenTyping): void {
  const now = Date.now()
  const last = lastRetry.get(sessionId)
  if (last && last.text === text && now - last.at < REPEAT_WINDOW_MS) return
  lastRetry.set(sessionId, { text, at: now })
  const data = `${typing.leave}${text}`
  typing.write(data)
  void typing.settled(data, opts.enterDelayMs).then(() => {
    if (typing.live()) typing.write(`${typing.leave}\r`)
  }).catch(() => { /* the session is gone */ })
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
 * drops untyped, or whose Enter below is not typed, is told to its canvas by
 * the chain itself.
 *
 * The renderer types the line and its Enter in one write, but in a tab
 * through the session helper on its machine (`typing.wholeWrites`,
 * 2.1.3-beta.19 section 6.1), for the reason the retry's Enter goes apart
 * there (above): a marker line of 63 characters or more was typed and not
 * sent (an approval line is 59 to 61 characters today, 60 to 62 with its
 * Enter, for versions v1 to v999, so none has reached that yet). There the
 * renderer types the line alone, and this types Enter as its own write
 * PROMPT_ENTER_DELAY_MS after the line's last slice went (the gap the door
 * gives the retry's and a prompt button's Enter), and only while the run is
 * still the one the line went to.
 */
function holdClaudeMarker(sessionId: string, line: string, canvasId: string | undefined, typing: RunScreenTyping): void {
  const enter = typing.wholeWrites
    ? async (typedLine: string): Promise<boolean> => {
      await typing.settled(typedLine, PROMPT_ENTER_DELAY_MS)
      if (!typing.live()) return false
      typing.write(`${typing.leave}\r`)
      return true
    }
    : undefined
  queueClaudeMarkerLine(sessionId, line, () => typing.live(), canvasId, enter)
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
  close: (sessionId) => { lastRetry.delete(sessionId) },
  has: () => false,
  retry: (sessionId, text, opts, typing) => retryClaudeLine(sessionId, text, opts, typing),
  prompt: (_sessionId, text, opts, typing) => sendClaudePrompt(text, opts, typing),
  marker: (sessionId, line, opts, typing) => holdClaudeMarker(sessionId, line, opts.canvasId, typing),
  image: (_sessionId, imagePath, sentence, opts, typing) => pasteClaudeImage(imagePath, sentence, opts, typing),
  // A held terminal's lone Enter typed while it was detached goes this long
  // after the frame before it at the attach again (2.1.3-beta.18 fix round;
  // since 2.1.3-beta.19 section 6.2, aicc_planning#440, each provider's own
  // declaration): Claude Code (2.1.332, measured) takes a control character
  // as a key only in a read shorter than 64 characters, so an image request
  // and its Enter queued during a link drop were typed and not sent once the
  // link was back.
  heldEnterWaitMs: PROMPT_ENTER_DELAY_MS,
}
