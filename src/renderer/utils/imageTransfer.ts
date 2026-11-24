import { writeSessionInput } from '../components/terminal/tmuxWheelScroll'
import { quoteArgForShell } from '../../shared/shell-quote'
import { useSessionStore } from '../stores/sessionStore'
import { usePasteHintStore } from '../stores/pasteHintStore'
import { sendImagePathToCodex, NOT_AT_PROMPT } from '../lib/codexComposer'
/**
 * Image transfer helper: gets a host-saved image into a session. The prompts
 * below are a Claude session's; a plain terminal (and the partner shell) gets
 * only the image's path, quoted for its shell (composeShellImagePath, below);
 * a Codex session's goes through main's door too, with its own fallback
 * (sendImageToCodexSession, below). Which route a pasted image takes is
 * decided in hooks/useKeyboardShortcuts.ts.
 *
 * For a Claude session:
 *
 * Local sessions (2.1.3-beta.16 X1.2): main types the absolute path as a
 * bracketed paste, which Claude Code attaches as its own pasted image
 * ("[Image #1]"), then the sentence, then Enter (pty.submitImage; probe P11,
 * ADR-030: a path typed as text reaches the model only as words). A session
 * main does not type an image into (an SSH Persistent session) answers
 * `not-taken` and gets the line it always got: the sentence and the path
 * typed, then Enter.
 *
 * SSH sessions: write the bare filename and ask Claude to call
 * `mcp__conductor__fetch_host_screenshot`. The remote machine
 * has no access to the host filesystem, so the MCP fetch (running over
 * the auto-injected reverse tunnel) is the only way the image lands on
 * Claude's input. Vision MCP is started at app launch, so this path is
 * always available on SSH sessions even when no browser is configured.
 *
 * Both paths cap the image to 1920px / JPG q85 server-side
 * (screenshot-capture.ts) so neither saturates Claude's image-size
 * budget.
 */

/**
 * Extract the bare filename from a Windows or POSIX absolute path.
 */
function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.split('/').pop() || filePath
}

/**
 * Compose the prompt that asks Claude to fetch a host screenshot via MCP.
 * The prompt is a single line so it submits cleanly when followed by \r.
 *
 * Optional `userContext` is included so Claude knows what the user wants done
 * with the image (defaults to "Please view this image.").
 */
export function composeFetchHostScreenshotPrompt(
  filename: string,
  userContext?: string
): string {
  const ctx = userContext?.trim() || 'Please view this image.'
  // Single-line prompt — Claude needs the tool name and the filename arg clearly.
  return `${ctx} (use mcp__conductor__fetch_host_screenshot with filename="${filename}" to load the image from the Conductor host)`
}

/**
 * Compose a local-path prompt: the sentence, then the absolute path, typed as
 * text. Since X1.2 only the line for a session main does not paste an image
 * into (sendImageToSession).
 */
export function composeLocalPathPrompt(
  filePath: string,
  userContext?: string
): string {
  const ctx = userContext?.trim() || 'Please view this image.'
  return `${ctx} ${filePath}`
}

/** 2.1.3-beta.17 C6: a sentence as a Codex session gets it, in ASCII: Codex
 *  dropped the line's em dash when the app typed it (P3.15), and the rule that
 *  types into Codex sends a line only once it reads it on screen as sent. */
export function codexImageSentence(sentence: string): string {
  return sentence.replace(/\s*[–—]\s*/g, ' - ')
}

/** C6: what the user is told when main refused the image's path for Codex. */
export function imagePathRefusedNote(hostFilePath: string): string {
  return `The image's path could not be typed into Codex, so nothing was sent; the image was saved on this computer at ${hostFilePath}.`
}

/**
 * 2.1.3-beta.17 C6 (aicc_planning#415): a host-saved image into a Codex
 * session on this computer (Alt+V, Snap). Main is asked to paste the path as
 * Codex's own paste, then the sentence, then Enter (pty.submitImage; probe
 * P11: Codex attaches a path it gets as a bracketed paste, "[Image #1]", and
 * reads a typed path only as words). What main could not paste (`not-taken`:
 * Codex not ready in its wait, no placeholder, its warning count showing; or
 * an ask that failed) gets today's line, the sentence and the path, by the
 * rule that types into Codex (sendImagePathToCodex), which types only into a
 * ready, empty composer and otherwise tells `onNote` why it typed nothing. A
 * session that is gone, or a path main refuses, gets nothing typed, and
 * `onNote` is told. `sentence` is made ASCII first (codexImageSentence).
 */
export function sendImageToCodexSession(
  sessionId: string,
  hostFilePath: string,
  sentence: string,
  onNote: (note: string) => void,
): void {
  const words = codexImageSentence(sentence.trim() || 'Please view this image.')
  const typed = (): void => sendImagePathToCodex(sessionId, hostFilePath, onNote, undefined, words)
  void window.electronAPI.pty.submitImage({ sessionId, path: hostFilePath, sentence: words }).then(
    (result) => {
      if (result.outcome === 'not-taken') typed()
      else if (result.outcome === 'not-sent') onNote(result.reason === 'refused-text' ? imagePathRefusedNote(hostFilePath) : NOT_AT_PROMPT)
    },
    typed,
  )
}

/** Whether the session runs Codex (its record in the session store). */
function isCodexSession(sessionId: string): boolean {
  return useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.provider === 'codex'
}

/**
 * Send a host-saved image file to a Claude session (or, since 2.1.3-beta.17
 * C6, a Codex session on this computer: sendImageToCodexSession, its notes in
 * the session's paste hint).
 *
 * @param sessionId - target Claude PTY session id
 * @param hostFilePath - absolute local path of the image file
 * @param userContext - optional context message prepended to the prompt
 * @param sessionType - 'local': main pastes the path (pty.submitImage), or,
 *                     for a session it does not take, the path typed with the
 *                     sentence; 'ssh' uses MCP fetch. Defaults to MCP fetch
 *                     for back-compat with any caller that doesn't yet
 *                     thread the type through.
 */
export function sendImageToSession(
  sessionId: string,
  hostFilePath: string,
  userContext?: string,
  sessionType?: 'local' | 'ssh'
): void {
  if (sessionType === 'local' && isCodexSession(sessionId)) {
    sendImageToCodexSession(sessionId, hostFilePath, userContext ?? '', (note) => usePasteHintStore.getState().show(sessionId, note))
    return
  }
  if (sessionType === 'local') {
    // The line a session gets when main does not paste the image for it
    // (`not-taken`), or when the ask itself failed; a trailing \r submits it.
    const typed = (): void => writeSessionInput(sessionId, composeLocalPathPrompt(hostFilePath, userContext) + '\r')
    const sentence = userContext?.trim() || 'Please view this image.'
    void window.electronAPI.pty.submitImage({ sessionId, path: hostFilePath, sentence }).then(
      (result) => { if (result.outcome === 'not-taken') typed() },
      typed,
    )
    return
  }
  // Trailing \r submits the prompt to Claude
  writeSessionInput(sessionId, composeFetchHostScreenshotPrompt(basename(hostFilePath), userContext) + '\r')
}

/**
 * The text Alt+V puts into a PLAIN terminal (a shell with no assistant): the
 * image's path, quoted for the shell it runs (PowerShell on Windows, a POSIX
 * shell elsewhere: shared/shell-quote.ts), and nothing else. A shell reads no
 * images, so the sentence an assistant is told would be typed into it as a
 * command, and an Enter would run it; a shell user wants the path at the cursor
 * to use in a command of their own.
 */
export function composeShellImagePath(hostFilePath: string, isWin32: boolean): string {
  return quoteArgForShell(hostFilePath, isWin32)
}

/** Whether `text` holds a control character (C0, DEL or C1). */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true
  }
  return false
}

/** Type the quoted path of a host-saved image at a plain terminal's prompt:
 *  not submitted (no Enter). Returns whether it was typed.
 *  PR-level ADR-009 round 1 (A1): off Windows the path is typed only when
 *  main said the shell it spawns a plain terminal with is of the sh family
 *  (`posixShell` 'sh', from the saved image's answer), and only when the path
 *  holds no control character; otherwise nothing is typed and the caller says
 *  where the image was saved. Windows (PowerShell) is unchanged. */
export function typeImagePathIntoShell(sessionId: string, hostFilePath: string, isWin32: boolean, posixShell?: 'sh' | 'other'): boolean {
  if (!isWin32 && (posixShell !== 'sh' || hasControlChar(hostFilePath))) return false
  writeSessionInput(sessionId, composeShellImagePath(hostFilePath, isWin32))
  return true
}

/**
 * Send multiple frames (storyboard) by writing one fetch prompt that lists all
 * filenames. Claude will call the MCP tool for each in sequence.
 *
 * @param frames - list of host-saved image absolute paths in display order
 * @param userContext - optional context describing what to do with the frames
 */
export function sendStoryboardToSession(
  sessionId: string,
  frames: string[],
  userContext?: string
): void {
  if (frames.length === 0) return
  const filenames = frames.map(basename)
  const ctx = userContext?.trim() || 'Please review these storyboard frames in order.'
  const list = filenames.map((f, i) => `${i + 1}. ${f}`).join('\n')
  // Multi-line prompt: Claude reads context, then calls fetch_host_screenshot
  // for each filename via the Conductor MCP server.
  const prompt = [
    ctx,
    '',
    'Frames (use mcp__conductor__fetch_host_screenshot for each):',
    list,
  ].join('\n')
  // Send line by line so the PTY chunked writer doesn't fight with the heredoc-free protocol
  const lines = prompt.split('\n')
  let idx = 0
  const writeNext = () => {
    if (idx >= lines.length) {
      writeSessionInput(sessionId, '\r')
      return
    }
    writeSessionInput(sessionId, lines[idx] + '\n')
    idx++
    setTimeout(writeNext, 80)
  }
  writeNext()
}
